import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { ResourceChange, StackState } from '../../../src/types/state.js';

vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  }),
}));

// Two DIFFERENT secretsmanager expressions that resolve to the SAME value — the
// two version STAGES of one secret, which is the shape the issue calls out as
// the consequential one: once the stages diverge they are different secrets,
// and a journal replay that re-resolves the wrong one ships the wrong version
// to the live resource.
const SHARED = 'one-and-the-same-secret';
const EXPR_CURRENT = '{{resolve:secretsmanager:db:SecretString:password:AWSCURRENT}}';
const EXPR_PREVIOUS = '{{resolve:secretsmanager:db:SecretString:password:AWSPREVIOUS}}';

// A secret-aware mock resolver keyed on the EXPRESSION STRING, not on a
// sentinel object. That distinction is the whole point of this file: the fix
// under test walks the persisted bag alongside the UNRESOLVED one and copies
// the source leaf, so the source leaf has to be a real `{{resolve:...}}` string
// exactly as a synthesized template carries it. A sentinel object would leave
// the path pass with nothing to copy and silently exercise only the value scan.
const SECRET_BY_EXPRESSION: Record<string, string> = {
  [EXPR_CURRENT]: SHARED,
  [EXPR_PREVIOUS]: SHARED,
};

function resolveWithSecrets(
  value: unknown,
  ctx: { recordedSecretValues?: Map<string, string> }
): unknown {
  if (typeof value === 'string') {
    const plaintext = SECRET_BY_EXPRESSION[value];
    if (plaintext === undefined) return value;
    // Mirrors the real resolver: (plaintext -> expression), last write winning,
    // which is exactly the collapse the position source has to survive.
    ctx.recordedSecretValues?.set(plaintext, value);
    return plaintext;
  }
  if (Array.isArray(value)) return value.map((v) => resolveWithSecrets(v, ctx));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = resolveWithSecrets(v, ctx);
    }
    return out;
  }
  return value;
}

vi.mock('../../../src/deployment/intrinsic-function-resolver.js', () => ({
  IntrinsicFunctionResolver: vi.fn().mockImplementation(() => ({
    getPhysicalIdFallbackCount: vi.fn().mockReturnValue(0),
    resetPhysicalIdFallbackCount: vi.fn(),
    resolve: vi
      .fn()
      .mockImplementation((props: unknown, ctx: { recordedSecretValues?: Map<string, string> }) =>
        Promise.resolve(resolveWithSecrets(props, ctx ?? {}))
      ),
    resolveParameters: vi.fn().mockReturnValue({}),
    evaluateConditions: vi.fn().mockResolvedValue({}),
  })),
}));

vi.mock('p-limit', () => ({
  default: vi.fn(() => <T>(fn: () => T) => fn()),
}));

describe('DeployEngine - sibling redaction writers position by source (issue #1910)', () => {
  const stackName = 'sibling-redaction-stack';

  // A properties bag whose TWO leaves resolve to the same value through the two
  // different stage expressions. The value map collapses them; only the
  // template bag can tell the leaves apart.
  // The diff hands the engine the UNRESOLVED template bag as
  // `desiredProperties`, and the engine captures exactly that as the position
  // source — so one bag serves as both here, as it does in production.
  const collidingProps = {
    Environment: { Variables: { CURRENT: EXPR_CURRENT, PREVIOUS: EXPR_PREVIOUS } },
  };

  let mockProvider: Record<string, ReturnType<typeof vi.fn>>;
  let mockStateBackend: Record<string, ReturnType<typeof vi.fn>>;
  let mockLockManager: Record<string, ReturnType<typeof vi.fn>>;
  let mockDagBuilder: Record<string, ReturnType<typeof vi.fn>>;
  let mockDiffCalculator: Record<string, ReturnType<typeof vi.fn>>;
  let mockProviderRegistry: Record<string, ReturnType<typeof vi.fn>>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockProvider = {
      create: vi.fn().mockResolvedValue({ physicalId: 'phys' }),
      update: vi.fn(),
      delete: vi.fn().mockResolvedValue(undefined),
      getAttribute: vi.fn(),
      readCurrentState: vi.fn().mockResolvedValue(undefined),
    };
    mockLockManager = {
      acquireLockWithRetry: vi.fn().mockResolvedValue(true),
      releaseLock: vi.fn().mockResolvedValue(undefined),
    };
    mockDagBuilder = {
      buildGraph: vi.fn().mockReturnValue({}),
      getExecutionLevels: vi.fn().mockReturnValue([['Fn']]),
      getDirectDependencies: vi.fn().mockReturnValue([]),
    };
    mockDiffCalculator = {
      calculateDiff: vi.fn(),
      hasChanges: vi.fn().mockReturnValue(true),
      filterByType: vi
        .fn()
        .mockImplementation((changes: Map<string, ResourceChange>, type: string) =>
          Array.from(changes.values()).filter((c) => c.changeType === type)
        ),
    };
    mockProviderRegistry = {
      getProvider: vi.fn().mockReturnValue(mockProvider),
      getProviderFor: vi.fn().mockReturnValue({ provider: mockProvider, provisionedBy: 'sdk' }),
      getRegisteredTypes: vi.fn().mockReturnValue([]),
      validateResourceTypes: vi.fn(),
      validateResourceProperties: vi.fn(),
    };
    mockStateBackend = {
      getState: vi.fn().mockResolvedValue({ state: null, etag: undefined }),
      saveState: vi.fn().mockResolvedValue('etag-new'),
      loadRollbackJournal: vi.fn().mockResolvedValue(null),
      appendRollbackJournalSegment: vi.fn().mockResolvedValue(undefined),
      popRollbackJournalSegment: vi.fn().mockResolvedValue(undefined),
      deleteRollbackJournal: vi.fn().mockResolvedValue(undefined),
    };
  });

  function makeEngine(options: Record<string, unknown> = {}) {
    return new DeployEngine(
      mockStateBackend as never,
      mockLockManager as never,
      mockDagBuilder as never,
      mockDiffCalculator as never,
      mockProviderRegistry as never,
      { dryRun: false, ...options },
      'us-east-1'
    );
  }

  it('OUTPUTS: two outputs resolving one secret each keep their OWN expression', async () => {
    mockDiffCalculator.calculateDiff.mockResolvedValue(
      new Map<string, ResourceChange>([
        [
          'Fn',
          {
            logicalId: 'Fn',
            changeType: 'CREATE',
            resourceType: 'AWS::Lambda::Function',
            desiredProperties: { Handler: 'index.handler' },
          },
        ],
      ])
    );

    const template: CloudFormationTemplate = {
      Resources: { Fn: { Type: 'AWS::Lambda::Function', Properties: { Handler: 'index.handler' } } },
      Outputs: {
        // Each carries an Export.Name, so `resolveOutputs` writes a SECOND
        // alias key holding the same value. Found by review: the alias had no
        // position source, so it fell to the value scan and collapsed — and
        // that bag is what feeds the exports index, so a downstream
        // `Fn::ImportValue` consumer got the SIBLING's expression.
        Current: { Value: EXPR_CURRENT, Export: { Name: 'CurrentExport' } },
        Previous: { Value: EXPR_PREVIOUS, Export: { Name: 'PreviousExport' } },
        Public: { Value: 'not-a-secret' },
      },
    };

    await makeEngine().deploy(stackName, template);

    const savedState = mockStateBackend.saveState!.mock.calls.at(-1)![2] as StackState;
    expect(savedState.outputs['CurrentExport']).toBe(EXPR_CURRENT);
    expect(savedState.outputs['PreviousExport']).toBe(EXPR_PREVIOUS);
    // Before #1910 BOTH were rewritten to whichever expression resolved last,
    // so the next deploy compared a collapsed state against a template that
    // still declares two — a permanent spurious change on the outputs.
    expect(savedState.outputs['Current']).toBe(EXPR_CURRENT);
    expect(savedState.outputs['Previous']).toBe(EXPR_PREVIOUS);
    expect(savedState.outputs['Public']).toBe('not-a-secret');
    expect(JSON.stringify(savedState)).not.toContain(SHARED);
  });

  // Test review, HIGH: the UPDATE no-op re-check is a SIXTH consumer of the
  // redaction, and the only one whose output is a COMPARISON rather than a
  // persisted bag. State holds each leaf's own expression since #1904, so a
  // value-only redaction here can never compare equal — every deploy of such a
  // resource issues a redundant `provider.update` forever.
  it('UPDATE no-op re-check: a colliding pair still compares equal to stored state', async () => {
    const stored: StackState = {
      version: 8,
      stackName,
      region: 'us-east-1',
      resources: {
        Fn: {
          physicalId: 'fn-phys',
          resourceType: 'AWS::Lambda::Function',
          // State already holds each leaf's OWN expression.
          properties: collidingProps,
        },
      },
      outputs: {},
      lastModified: 0,
    };
    mockStateBackend.getState!.mockResolvedValue({ state: stored, etag: 'e0' });
    mockDiffCalculator.calculateDiff!.mockResolvedValue(
      new Map<string, ResourceChange>([
        [
          'Fn',
          {
            logicalId: 'Fn',
            changeType: 'UPDATE',
            resourceType: 'AWS::Lambda::Function',
            desiredProperties: collidingProps,
            // The re-check compares against `currentProperties` — the bag read
            // back from state, which holds each leaf's own expression.
            currentProperties: collidingProps,
          },
        ],
      ])
    );

    const template: CloudFormationTemplate = {
      Resources: { Fn: { Type: 'AWS::Lambda::Function', Properties: collidingProps } },
    };

    await makeEngine().deploy(stackName, template);

    // The re-check resolved both leaves to one plaintext, redacted them back by
    // POSITION, and got exactly what state holds — so there is nothing to do.
    expect(mockProvider.update!).not.toHaveBeenCalled();
  });

  it('JOURNAL: a completed op keeps each property leaf on its OWN expression', async () => {
    // `Fn` succeeds and `Boom` fails, so the deploy journals `Fn` as a completed
    // operation. `--no-rollback` keeps the segment instead of replaying it.
    mockDagBuilder.getExecutionLevels.mockReturnValue([['Fn', 'Boom']]);
    mockProvider.create!.mockImplementation((logicalId: string) => {
      if (logicalId === 'Boom') return Promise.reject(new Error('deliberate failure'));
      return Promise.resolve({ physicalId: `${logicalId}-phys` });
    });

    mockDiffCalculator.calculateDiff.mockResolvedValue(
      new Map<string, ResourceChange>([
        [
          'Fn',
          {
            logicalId: 'Fn',
            changeType: 'CREATE',
            resourceType: 'AWS::Lambda::Function',
            desiredProperties: collidingProps,
          },
        ],
        [
          'Boom',
          {
            logicalId: 'Boom',
            changeType: 'CREATE',
            resourceType: 'AWS::SQS::Queue',
            desiredProperties: { QueueName: 'q' },
          },
        ],
      ])
    );

    const template: CloudFormationTemplate = {
      Resources: {
        Fn: { Type: 'AWS::Lambda::Function', Properties: collidingProps },
        Boom: { Type: 'AWS::SQS::Queue', Properties: { QueueName: 'q' } },
      },
    };

    await expect(
      makeEngine({ noRollback: true }).deploy(stackName, template)
    ).rejects.toBeInstanceOf(Error);

    expect(mockStateBackend.appendRollbackJournalSegment!).toHaveBeenCalled();
    const segment = mockStateBackend.appendRollbackJournalSegment!.mock.calls[0]![2] as {
      operations: Array<{ logicalId: string; properties?: Record<string, unknown> }>;
    };
    const fnOp = segment.operations.find((op) => op.logicalId === 'Fn');
    expect(fnOp).toBeDefined();

    const vars = (fnOp!.properties!['Environment'] as Record<string, unknown>)[
      'Variables'
    ] as Record<string, string>;
    // THE consequential assertion of #1910: `resolveReplayProps` re-resolves
    // these on a `cdkd rollback`, so a collapsed pair would ship the AWSCURRENT
    // value to the leaf the template pins to AWSPREVIOUS.
    expect(vars['CURRENT']).toBe(EXPR_CURRENT);
    expect(vars['PREVIOUS']).toBe(EXPR_PREVIOUS);
    expect(JSON.stringify(segment)).not.toContain(SHARED);
  });
});
