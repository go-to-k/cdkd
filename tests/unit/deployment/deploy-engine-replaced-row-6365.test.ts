/**
 * go-to-k/cdkd#6365: a resource REPLACED through the in-place update path (the
 * update-failure fallback under `--replace`, or a provider's own `update()`
 * returning `wasReplaced: true`) rendered its row as `updated`, while a
 * diff-classified replacement renders `replaced`. Found in the #6363 live
 * repro: `Resource T was replaced: ...` then `[1/1] ✓ T (...) updated`.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { ResourceChange } from '../../../src/types/state.js';

vi.mock('../../../src/utils/aws-clients.js', async (importOriginal) =>
  (await import('./_inert-cloudformation-client.js')).withInertCloudFormationClient(importOriginal)
);

const logLines = vi.hoisted(() => [] as string[]);
vi.mock('../../../src/utils/logger.js', () => {
  const push =
    (level: string) =>
    (...args: unknown[]): void => {
      logLines.push(`${level} ${args.map(String).join(' ')}`);
    };
  const fake = {
    debug: push('debug'),
    info: push('info'),
    warn: push('warn'),
    error: push('error'),
    setLevel: (): void => {},
    child: (): unknown => fake,
  };
  return { getLogger: () => fake };
});

vi.mock('../../../src/deployment/intrinsic-function-resolver.js', () => ({
  IntrinsicFunctionResolver: vi.fn(() => ({
    getPhysicalIdFallbackCount: vi.fn().mockReturnValue(0),
    resetPhysicalIdFallbackCount: vi.fn(),
    resolve: vi.fn((value: unknown) => Promise.resolve(value)),
    resolveParameters: vi.fn().mockReturnValue({}),
    evaluateConditions: vi.fn().mockResolvedValue({}),
  })),
}));

vi.mock('p-limit', () => ({
  default: vi.fn(() => <T>(fn: () => T) => fn()),
}));

const stackName = 'ReplacedRowStack';
const TYPE = 'AWS::SQS::Queue';

describe('DeployEngine — the row of an in-place-path replacement (go-to-k/cdkd#6365)', () => {
  let provider: Record<string, ReturnType<typeof vi.fn>>;
  let stateBackend: Record<string, ReturnType<typeof vi.fn>>;
  let diffCalculator: Record<string, ReturnType<typeof vi.fn>>;
  let registry: Record<string, ReturnType<typeof vi.fn>>;

  beforeEach(() => {
    vi.clearAllMocks();
    logLines.length = 0;
    provider = {
      create: vi.fn().mockResolvedValue({ physicalId: 'phys' }),
      update: vi.fn(),
      delete: vi.fn().mockResolvedValue(undefined),
      getAttribute: vi.fn(),
      readCurrentState: vi.fn().mockResolvedValue(undefined),
    };
    diffCalculator = {
      calculateDiff: vi.fn(),
      hasChanges: vi.fn().mockReturnValue(true),
      filterByType: vi
        .fn()
        .mockImplementation((changes: Map<string, ResourceChange>, type: string) =>
          Array.from(changes.values()).filter((c) => c.changeType === type)
        ),
    };
    registry = {
      getProvider: vi.fn().mockReturnValue(provider),
      getProviderFor: vi.fn().mockReturnValue({ provider, provisionedBy: 'sdk' }),
      getRegisteredTypes: vi.fn().mockReturnValue([]),
      validateResourceTypes: vi.fn(),
      validateResourceProperties: vi.fn(),
    };
    stateBackend = {
      getState: vi.fn().mockResolvedValue({
        state: {
          version: 8,
          stackName,
          region: 'us-east-1',
          resources: {
            Q: {
              physicalId: 'old-queue',
              resourceType: TYPE,
              properties: { VisibilityTimeout: 30 },
            },
          },
          outputs: {},
          lastModified: 1,
        },
        etag: 'etag-old',
      }),
      saveState: vi.fn().mockResolvedValue('etag-new'),
      loadRollbackJournal: vi.fn().mockResolvedValue(null),
      purgeRollbackJournalVersions: vi.fn().mockResolvedValue(undefined),
      rollbackJournalReadAbsent: vi.fn().mockReturnValue(false),
      warmConnections: vi.fn().mockResolvedValue(undefined),
      appendRollbackJournalSegment: vi.fn().mockResolvedValue(undefined),
    };
    diffCalculator.calculateDiff!.mockResolvedValue(
      new Map<string, ResourceChange>([
        [
          'Q',
          {
            logicalId: 'Q',
            changeType: 'UPDATE',
            resourceType: TYPE,
            desiredProperties: { VisibilityTimeout: 60 },
            currentProperties: { VisibilityTimeout: 30 },
            propertyChanges: [
              { path: 'VisibilityTimeout', oldValue: 30, newValue: 60, requiresReplacement: false },
            ],
          },
        ],
      ])
    );
  });

  function makeEngine(): DeployEngine {
    return new DeployEngine(
      stateBackend as never,
      {
        acquireLockWithRetry: vi.fn().mockResolvedValue(true),
        releaseLock: vi.fn().mockResolvedValue(undefined),
      } as never,
      {
        buildGraph: vi.fn().mockReturnValue({}),
        getExecutionLevels: vi.fn().mockReturnValue([['Q']]),
        getDirectDependencies: vi.fn().mockReturnValue([]),
      } as never,
      diffCalculator as never,
      registry as never,
      { dryRun: false } as never,
      'us-east-1'
    );
  }

  const template: CloudFormationTemplate = {
    Resources: { Q: { Type: TYPE, Properties: { VisibilityTimeout: 60 } } },
  };
  // The per-resource result row: an info line carrying the status check.
  const rowOf = (): string[] =>
    logLines.filter((line) => line.startsWith('info ') && line.includes('✓') && line.includes(TYPE));

  it('renders `replaced` when the update returned wasReplaced: true', async () => {
    provider.update!.mockResolvedValue({ physicalId: 'new-queue', wasReplaced: true });

    await makeEngine().deploy(stackName, template);

    // Non-vacuity: the replacement itself was announced.
    expect(logLines.some((line) => line.includes('Resource Q was replaced'))).toBe(true);
    const rows = rowOf();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain('replaced');
    expect(rows[0]).not.toContain('updated');
  });

  it('renders `replaced` on the partial warning row too', async () => {
    // The create-then-delete replacement whose old-resource delete did not
    // land: the row is a WARN naming the reason, and must still say replaced.
    provider.update!.mockResolvedValue({
      physicalId: 'new-queue',
      wasReplaced: true,
      outcome: 'partial',
      reason: 'the old queue was not deleted',
    });

    await makeEngine().deploy(stackName, template).catch(() => undefined);

    const rows = logLines.filter(
      (line) => line.startsWith('warn ') && line.includes('✓') && line.includes(TYPE)
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain('replaced');
    expect(rows[0]).toContain('the old queue was not deleted');
    expect(rows[0]).not.toContain('updated');
  });

  it('still renders `updated` for a plain in-place update', async () => {
    provider.update!.mockResolvedValue({ physicalId: 'old-queue', wasReplaced: false });

    await makeEngine().deploy(stackName, template);

    const rows = rowOf();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain('updated');
    expect(rows[0]).not.toContain('replaced');
  });
});
