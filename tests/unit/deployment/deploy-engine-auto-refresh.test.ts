import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { ResourceChange, StackState } from '../../../src/types/state.js';
import { STATE_SCHEMA_VERSION_CURRENT } from '../../../src/types/state.js';

// Logger is silenced — the auto-refresh helper emits one logger.warn
// when N>0 and we don't want it polluting test output.
vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  }),
}));

vi.mock('../../../src/deployment/intrinsic-function-resolver.js', () => ({
  IntrinsicFunctionResolver: vi.fn().mockImplementation(() => ({
    resolve: vi.fn().mockImplementation((props: unknown) => Promise.resolve(props)),
    resolveParameters: vi.fn().mockReturnValue({}),
    evaluateConditions: vi.fn().mockResolvedValue({}),
  })),
}));

// p-limit no-op so concurrency does not gate this test.
vi.mock('p-limit', () => ({
  default: vi.fn(() => <T>(fn: () => T) => fn()),
}));

/**
 * Auto-refresh observed-properties on `cdkd deploy` for resources in
 * loaded state that lack `observedProperties` (e.g. v2 schema, or v3
 * records where a NO_CHANGE-skipped resource never landed a baseline).
 *
 * Coverage:
 * - Two NO_CHANGE resources in v2 state → both refreshed, final state v3
 *   with observedProperties populated.
 * - `captureObservedState: false` → readCurrentState NOT called.
 * - One CREATE + one v2 NO_CHANGE in same deploy → CREATE wins (latest
 *   `Map.set` for create overrides any conflict on the same logicalId);
 *   NO_CHANGE entry is auto-refreshed without double-write.
 */
describe('DeployEngine - auto-refresh observed-properties on v2 state load', () => {
  const stackName = 'auto-refresh-stack';

  let mockProvider: {
    create: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
    getAttribute: ReturnType<typeof vi.fn>;
    readCurrentState: ReturnType<typeof vi.fn>;
  };

  let mockStateBackend: {
    getState: ReturnType<typeof vi.fn>;
    saveState: ReturnType<typeof vi.fn>;
  };

  let mockLockManager: {
    acquireLockWithRetry: ReturnType<typeof vi.fn>;
    releaseLock: ReturnType<typeof vi.fn>;
  };

  let mockDagBuilder: {
    buildGraph: ReturnType<typeof vi.fn>;
    getExecutionLevels: ReturnType<typeof vi.fn>;
    getDirectDependencies: ReturnType<typeof vi.fn>;
  };

  let mockDiffCalculator: {
    calculateDiff: ReturnType<typeof vi.fn>;
    hasChanges: ReturnType<typeof vi.fn>;
    filterByType: ReturnType<typeof vi.fn>;
  };

  let mockProviderRegistry: {
    getProvider: ReturnType<typeof vi.fn>;
    validateResourceTypes: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.clearAllMocks();

    mockProvider = {
      create: vi.fn().mockResolvedValue({
        physicalId: 'phys-create',
        attributes: {},
      }),
      update: vi.fn().mockResolvedValue({ physicalId: 'phys-update', wasReplaced: false }),
      delete: vi.fn().mockResolvedValue(undefined),
      getAttribute: vi.fn(),
      readCurrentState: vi.fn(),
    };

    mockLockManager = {
      acquireLockWithRetry: vi.fn().mockResolvedValue(true),
      releaseLock: vi.fn().mockResolvedValue(undefined),
    };

    mockDagBuilder = {
      buildGraph: vi.fn().mockReturnValue({}),
      getExecutionLevels: vi.fn().mockReturnValue([]),
      getDirectDependencies: vi.fn().mockReturnValue([]),
    };

    mockDiffCalculator = {
      calculateDiff: vi.fn(),
      hasChanges: vi.fn().mockReturnValue(true),
      filterByType: vi
        .fn()
        .mockImplementation((changes: Map<string, ResourceChange>, type: string) => {
          return Array.from(changes.values()).filter((c) => c.changeType === type);
        }),
    };

    mockProviderRegistry = {
      getProvider: vi.fn().mockReturnValue(mockProvider),
      validateResourceTypes: vi.fn(),
    };

    mockStateBackend = {
      getState: vi.fn(),
      saveState: vi.fn().mockResolvedValue('etag-new'),
    };
  });

  function makeEngine(opts: { captureObservedState?: boolean } = {}) {
    const engineOpts: { dryRun: boolean; captureObservedState?: boolean } = { dryRun: false };
    if (opts.captureObservedState !== undefined) {
      engineOpts.captureObservedState = opts.captureObservedState;
    }
    return new DeployEngine(
      mockStateBackend as never,
      mockLockManager as never,
      mockDagBuilder as never,
      mockDiffCalculator as never,
      mockProviderRegistry as never,
      engineOpts,
      'us-east-1'
    );
  }

  it('refreshes observed-properties for v2 NO_CHANGE resources and persists them as v3', async () => {
    const v2State: StackState = {
      version: 2,
      region: 'us-east-1',
      stackName,
      resources: {
        BucketA: {
          physicalId: 'phys-bucket-a',
          resourceType: 'AWS::S3::Bucket',
          properties: { BucketName: 'bucket-a' },
          // observedProperties intentionally absent — pre-v3 record
        },
        QueueB: {
          physicalId: 'phys-queue-b',
          resourceType: 'AWS::SQS::Queue',
          properties: { QueueName: 'queue-b' },
        },
      },
      outputs: {},
      lastModified: 0,
    };

    mockStateBackend.getState.mockResolvedValue({
      state: v2State,
      etag: 'etag-old',
    });

    // readCurrentState resolves to a snapshot per resource.
    mockProvider.readCurrentState.mockImplementation(async (physicalId: string) => {
      return { snapshotPhysicalId: physicalId, refreshed: true };
    });

    // Both resources are NO_CHANGE — diff returns NO_CHANGE entries
    // and hasChanges is false (no CREATE/UPDATE/DELETE), exercising
    // the no-change drain-and-persist branch.
    mockDiffCalculator.calculateDiff.mockResolvedValue(
      new Map<string, ResourceChange>([
        [
          'BucketA',
          {
            logicalId: 'BucketA',
            changeType: 'NO_CHANGE',
            resourceType: 'AWS::S3::Bucket',
          },
        ],
        [
          'QueueB',
          {
            logicalId: 'QueueB',
            changeType: 'NO_CHANGE',
            resourceType: 'AWS::SQS::Queue',
          },
        ],
      ])
    );
    mockDiffCalculator.hasChanges.mockReturnValue(false);

    const template: CloudFormationTemplate = {
      Resources: {
        BucketA: { Type: 'AWS::S3::Bucket', Properties: { BucketName: 'bucket-a' } },
        QueueB: { Type: 'AWS::SQS::Queue', Properties: { QueueName: 'queue-b' } },
      },
    };

    const engine = makeEngine();
    const result = await engine.deploy(stackName, template);

    expect(result.unchanged).toBe(2);
    expect(result.created).toBe(0);
    expect(result.updated).toBe(0);

    // readCurrentState fired for both resources.
    expect(mockProvider.readCurrentState).toHaveBeenCalledTimes(2);
    expect(mockProvider.readCurrentState).toHaveBeenCalledWith(
      'phys-bucket-a',
      'BucketA',
      'AWS::S3::Bucket',
      { BucketName: 'bucket-a' }
    );
    expect(mockProvider.readCurrentState).toHaveBeenCalledWith(
      'phys-queue-b',
      'QueueB',
      'AWS::SQS::Queue',
      { QueueName: 'queue-b' }
    );

    // No-change branch persisted state with refreshed baselines.
    expect(mockStateBackend.saveState).toHaveBeenCalledTimes(1);
    const savedState = mockStateBackend.saveState.mock.calls[0]![2] as StackState;
    expect(savedState.version).toBe(STATE_SCHEMA_VERSION_CURRENT);
    expect(savedState.resources['BucketA']!.observedProperties).toEqual({
      snapshotPhysicalId: 'phys-bucket-a',
      refreshed: true,
    });
    expect(savedState.resources['QueueB']!.observedProperties).toEqual({
      snapshotPhysicalId: 'phys-queue-b',
      refreshed: true,
    });
  });

  it('does NOT call readCurrentState when captureObservedState is false', async () => {
    const v2State: StackState = {
      version: 2,
      region: 'us-east-1',
      stackName,
      resources: {
        BucketA: {
          physicalId: 'phys-bucket-a',
          resourceType: 'AWS::S3::Bucket',
          properties: { BucketName: 'bucket-a' },
        },
      },
      outputs: {},
      lastModified: 0,
    };

    mockStateBackend.getState.mockResolvedValue({
      state: v2State,
      etag: 'etag-old',
    });

    mockProvider.readCurrentState.mockResolvedValue({ unused: true });

    mockDiffCalculator.calculateDiff.mockResolvedValue(
      new Map<string, ResourceChange>([
        [
          'BucketA',
          {
            logicalId: 'BucketA',
            changeType: 'NO_CHANGE',
            resourceType: 'AWS::S3::Bucket',
          },
        ],
      ])
    );
    mockDiffCalculator.hasChanges.mockReturnValue(false);

    const template: CloudFormationTemplate = {
      Resources: {
        BucketA: { Type: 'AWS::S3::Bucket', Properties: { BucketName: 'bucket-a' } },
      },
    };

    const engine = makeEngine({ captureObservedState: false });
    await engine.deploy(stackName, template);

    expect(mockProvider.readCurrentState).not.toHaveBeenCalled();
    // No state save: hasChanges=false AND no auto-refresh fired.
    expect(mockStateBackend.saveState).not.toHaveBeenCalled();
  });

  it('a CREATE on the same logicalId wins over auto-refresh (latest-wins on Map.set)', async () => {
    // Edge case: state already has BucketA without observedProperties.
    // The diff lists it as CREATE (e.g. user wiped state and is
    // re-creating, or the resource is a hybrid case). Auto-refresh
    // would fire for the old physicalId, then CREATE replaces the
    // ResourceState entirely with a new physicalId. The drain must
    // pick the CREATE-side observedProperties, not the auto-refresh
    // one.
    //
    // In practice CREATEs only run for resources not in state, so
    // this is a pathological case — we just need to verify state
    // does not end up corrupted.
    const v2State: StackState = {
      version: 2,
      region: 'us-east-1',
      stackName,
      resources: {
        BucketA: {
          physicalId: 'phys-bucket-old',
          resourceType: 'AWS::S3::Bucket',
          properties: { BucketName: 'bucket-old' },
        },
      },
      outputs: {},
      lastModified: 0,
    };

    mockStateBackend.getState.mockResolvedValue({
      state: v2State,
      etag: 'etag-old',
    });

    // Distinguishable readCurrentState responses keyed by physicalId.
    mockProvider.readCurrentState.mockImplementation(async (physicalId: string) => {
      if (physicalId === 'phys-bucket-old') return { source: 'auto-refresh-old-phys' };
      if (physicalId === 'phys-create') return { source: 'create-new-phys' };
      return undefined;
    });

    mockProvider.create.mockResolvedValue({
      physicalId: 'phys-create',
      attributes: {},
    });

    mockDiffCalculator.calculateDiff.mockResolvedValue(
      new Map<string, ResourceChange>([
        [
          'BucketA',
          {
            logicalId: 'BucketA',
            changeType: 'CREATE',
            resourceType: 'AWS::S3::Bucket',
            desiredProperties: { BucketName: 'bucket-new' },
          },
        ],
      ])
    );
    mockDiffCalculator.hasChanges.mockReturnValue(true);
    mockDagBuilder.getExecutionLevels.mockReturnValue([['BucketA']]);

    const template: CloudFormationTemplate = {
      Resources: {
        BucketA: { Type: 'AWS::S3::Bucket', Properties: { BucketName: 'bucket-new' } },
      },
    };

    const engine = makeEngine();
    const result = await engine.deploy(stackName, template);

    expect(result.created).toBe(1);

    // Final saved state has CREATE-side observedProperties (not the
    // auto-refresh one) — Map.set(logicalId, ...) latest-wins.
    const lastSaveCall = mockStateBackend.saveState.mock.calls.at(-1);
    expect(lastSaveCall).toBeDefined();
    const savedState = lastSaveCall![2] as StackState;
    expect(savedState.resources['BucketA']!.physicalId).toBe('phys-create');
    expect(savedState.resources['BucketA']!.observedProperties).toEqual({
      source: 'create-new-phys',
    });
  });
});
