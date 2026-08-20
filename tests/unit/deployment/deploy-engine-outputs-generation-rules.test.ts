import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import {
  redactSecretsForState,
  TEMPLATE_DERIVED_RULES,
  TEMPLATE_SOURCED_RULES,
  type RecordedSecretValues,
} from '../../../src/deployment/secret-redaction.js';
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

// Two DIFFERENT secrets with DIFFERENT resolved values, so nothing here depends
// on the #1910 collapse: each plaintext maps to exactly one expression.
const EXPR_A = '{{resolve:secretsmanager:db:SecretString:password:AWSCURRENT}}';
const EXPR_B = '{{resolve:secretsmanager:db:SecretString:password:AWSPREVIOUS}}';
const PLAINTEXT_A = 'resolved-secret-value-a';
const PLAINTEXT_B = 'resolved-secret-value-b';

// A value the PREVIOUS deploy persisted at index 0 of a list-valued output. Not
// a secret, not a needle — the only thing that can put an expression here is
// POSITIONAL descent from today's template, which is the bug.
const CARRIED_LITERAL = 'a-literal-from-the-previous-generation';

const SECRET_BY_EXPRESSION: Record<string, string> = {
  [EXPR_A]: PLAINTEXT_A,
  [EXPR_B]: PLAINTEXT_B,
};

function resolveWithSecrets(
  value: unknown,
  ctx: { recordedSecretValues?: Map<string, string> }
): unknown {
  if (typeof value === 'string') {
    const plaintext = SECRET_BY_EXPRESSION[value];
    if (plaintext === undefined) return value;
    ctx.recordedSecretValues?.set(plaintext, value);
    return plaintext;
  }
  if (Array.isArray(value)) return value.map((v) => resolveWithSecrets(v, ctx));
  if (value && typeof value === 'object') {
    // The failing output: `resolveOutputs` catches this per-output, warns, and
    // stores `undefined` — which is what makes `resolutionFailed` true and the
    // engine keep the PREVIOUS generation's bag. That is the shape this file
    // needs, and it is the engine's own documented behavior, not a contrivance.
    if (Object.hasOwn(value as Record<string, unknown>, 'Fn::GetAtt')) {
      throw new Error('cannot resolve Fn::GetAtt for a resource not in state');
    }
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

/**
 * Issue [#1943](https://github.com/go-to-k/cdkd/issues/1943) item 1 — the
 * outputs walk at the persist choke point may not claim its bag was PRODUCED by
 * resolving today's template.
 *
 * `redactOutputs` is one method behind three call sites, and two of them hand it
 * a bag that is not this generation's: `redactStateForPersist` redacts whatever
 * `state.outputs` holds, and the no-change path persists `persistedOutputs` —
 * the PREVIOUS deploy's bag — whenever a resolution failure keeps today's from
 * landing. `descendArrays` is the one flag `TEMPLATE_DERIVED_RULES` and
 * `TEMPLATE_SOURCED_RULES` differ on, and it is exactly that claim.
 */
describe('secret-redaction - the two outputs rules constants on a cross-generation bag', () => {
  // The MECHANISM, at module level, so the engine test below is asserting a
  // wiring decision rather than re-deriving the behavior. A list-valued output
  // is reachable because `TemplateOutput.Value` is `unknown` and cdkd does not
  // enforce CloudFormation's "Value must be a String".
  const secrets: RecordedSecretValues = new Map([
    [PLAINTEXT_A, EXPR_A],
    [PLAINTEXT_B, EXPR_B],
  ]);
  const previousGenerationBag = { List: [CARRIED_LITERAL, PLAINTEXT_B] };
  const todaysTemplateSource = { List: [EXPR_A, EXPR_B] };

  it('TEMPLATE_DERIVED fabricates today expression onto a carried literal', () => {
    const out = redactSecretsForState(
      previousGenerationBag,
      secrets,
      todaysTemplateSource,
      TEMPLATE_DERIVED_RULES
    ) as Record<string, unknown[]>;

    // NOT an assertion of desired behavior — this is what positional descent
    // DOES to a previous generation, recorded so the swap below has a measured
    // difference behind it rather than an argument.
    expect(out['List']![0]).toBe(EXPR_A);
  });

  it('TEMPLATE_SOURCED keeps the carried literal and still redacts by value', () => {
    const out = redactSecretsForState(
      previousGenerationBag,
      secrets,
      todaysTemplateSource,
      TEMPLATE_SOURCED_RULES
    ) as Record<string, unknown[]>;

    expect(out['List']![0]).toBe(CARRIED_LITERAL);
    // The value scan is what redacts under this constant, so the secret is
    // still not persisted in plaintext — the refusal costs no redaction.
    expect(out['List']![1]).toBe(EXPR_B);
  });
});

describe('DeployEngine - redactOutputs takes the TEMPLATE_SOURCED rules (issue #1943)', () => {
  const stackName = 'outputs-generation-stack';

  let mockProvider: Record<string, ReturnType<typeof vi.fn>>;
  let mockStateBackend: Record<string, ReturnType<typeof vi.fn>>;
  let mockLockManager: Record<string, ReturnType<typeof vi.fn>>;
  let mockDagBuilder: Record<string, ReturnType<typeof vi.fn>>;
  let mockDiffCalculator: Record<string, ReturnType<typeof vi.fn>>;
  let mockProviderRegistry: Record<string, ReturnType<typeof vi.fn>>;

  // A record with NO `observedProperties`, which is what makes the no-change
  // path kick off an auto-refresh and therefore SAVE — the save is the only
  // reason the previous generation's outputs bag reaches the redaction.
  const currentState: StackState = {
    version: 8,
    stackName,
    region: 'us-east-1',
    resources: {
      Fn: {
        physicalId: 'phys',
        resourceType: 'AWS::Lambda::Function',
        properties: { Handler: 'index.handler' },
      },
    },
    outputs: { List: [CARRIED_LITERAL, PLAINTEXT_B] },
    lastModified: 1,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockProvider = {
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      getAttribute: vi.fn(),
      readCurrentState: vi.fn().mockResolvedValue({ Handler: 'index.handler' }),
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
      calculateDiff: vi.fn().mockResolvedValue(new Map<string, ResourceChange>()),
      hasChanges: vi.fn().mockReturnValue(false),
      filterByType: vi.fn().mockReturnValue([]),
    };
    mockProviderRegistry = {
      getProvider: vi.fn().mockReturnValue(mockProvider),
      getProviderFor: vi.fn().mockReturnValue({ provider: mockProvider, provisionedBy: 'sdk' }),
      getRegisteredTypes: vi.fn().mockReturnValue([]),
      validateResourceTypes: vi.fn(),
      validateResourceProperties: vi.fn(),
    };
    mockStateBackend = {
      getState: vi.fn().mockResolvedValue({ state: currentState, etag: 'etag-1' }),
      saveState: vi.fn().mockResolvedValue('etag-new'),
      loadRollbackJournal: vi.fn().mockResolvedValue(null),
      appendRollbackJournalSegment: vi.fn().mockResolvedValue(undefined),
      popRollbackJournalSegment: vi.fn().mockResolvedValue(undefined),
      deleteRollbackJournal: vi.fn().mockResolvedValue(undefined),
    };
  });

  function makeEngine() {
    return new DeployEngine(
      mockStateBackend as never,
      mockLockManager as never,
      mockDagBuilder as never,
      mockDiffCalculator as never,
      mockProviderRegistry as never,
      { dryRun: false },
      'us-east-1'
    );
  }

  it('does NOT descend positionally into a PREVIOUS generation outputs list', async () => {
    const template: CloudFormationTemplate = {
      Resources: {
        Fn: { Type: 'AWS::Lambda::Function', Properties: { Handler: 'index.handler' } },
      },
      Outputs: {
        // Today's template for the same output name, positionally DIFFERENT
        // from what state carries: index 0 is a secret expression here and an
        // ordinary literal there.
        List: { Value: [EXPR_A, EXPR_B] },
        // Fails to resolve, so `resolutionFailed` keeps `persistedOutputs` —
        // the previous generation's bag — as the one that gets saved.
        Broken: { Value: { 'Fn::GetAtt': ['Missing', 'Arn'] } },
      },
    };

    await makeEngine().deploy(stackName, template);

    const saved = mockStateBackend.saveState!.mock.calls.at(-1)![2] as StackState;
    const list = saved.outputs['List'] as unknown[];

    // THE DISCRIMINATOR. Under the default template-DERIVED rules this is
    // `EXPR_A` — an expression the stored value never came from, written into
    // `state.outputs`, which the exports index re-applies to consumer stacks.
    expect(list[0]).toBe(CARRIED_LITERAL);
    // ...and the value scan still redacts what it can identify, so refusing
    // positional descent gives up no redaction here.
    expect(list[1]).toBe(EXPR_B);
    expect(JSON.stringify(saved)).not.toContain(PLAINTEXT_B);
  });
});
