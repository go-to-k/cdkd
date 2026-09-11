import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
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
    getPhysicalIdFallbackCount: vi.fn().mockReturnValue(0),
    resetPhysicalIdFallbackCount: vi.fn(),
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
    getProviderFor: ReturnType<typeof vi.fn>;
    getRegisteredTypes: ReturnType<typeof vi.fn>;
    validateResourceTypes: ReturnType<typeof vi.fn>;
    validateResourceProperties: ReturnType<typeof vi.fn>;
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
      getProviderFor: vi.fn().mockReturnValue({ provider: mockProvider, provisionedBy: 'sdk' }),
      getRegisteredTypes: vi.fn().mockReturnValue([]),
      validateResourceTypes: vi.fn(),
      validateResourceProperties: vi.fn(),
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
    // Issue #323: auto-refresh on v2→v3 upgrade now passes the
    // cross-resource context as the 5th arg so IAM providers can filter
    // sibling-managed inline policies. The siblings map excludes the
    // resource being read.
    expect(mockProvider.readCurrentState).toHaveBeenCalledWith(
      'phys-bucket-a',
      'BucketA',
      'AWS::S3::Bucket',
      { BucketName: 'bucket-a' },
      {
        siblings: {
          QueueB: {
            resourceType: 'AWS::SQS::Queue',
            properties: { QueueName: 'queue-b' },
          },
        },
      }
    );
    expect(mockProvider.readCurrentState).toHaveBeenCalledWith(
      'phys-queue-b',
      'QueueB',
      'AWS::SQS::Queue',
      { QueueName: 'queue-b' },
      {
        siblings: {
          BucketA: {
            resourceType: 'AWS::S3::Bucket',
            properties: { BucketName: 'bucket-a' },
          },
        },
      }
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

  it('routes the refresh through the layer the RECORD names, not the type default (issue #2608 sibling)', async () => {
    // Found by the sibling-site sweep on issue #2608 (whose subject is the
    // post-UPDATE capture). This site used the legacy `getProvider` entry
    // point, which passes NO recorded layer — so a record stamped
    // `provisionedBy: 'cc-api'` (silent-drop auto-route, issue #614) had its
    // drift BASELINE read back through the SDK provider. The bag then
    // describes a layer state does not name, and since this bag IS the
    // baseline, the very next `cdkd drift` reports the shape difference as
    // drift (the phantom-drift class of issue #1591).
    const ccProvider = {
      ...mockProvider,
      readCurrentState: vi.fn().mockResolvedValue({ readBy: 'cc-api' }),
    };
    mockProviderRegistry.getProviderFor.mockImplementation(
      (input: { provisionedBy?: 'sdk' | 'cc-api' }) =>
        input.provisionedBy === 'cc-api'
          ? { provider: ccProvider, provisionedBy: 'cc-api' }
          : { provider: mockProvider, provisionedBy: 'sdk' }
    );
    mockProvider.readCurrentState.mockResolvedValue({ readBy: 'sdk' });

    mockStateBackend.getState.mockResolvedValue({
      state: {
        version: 7,
        region: 'us-east-1',
        stackName,
        resources: {
          // No `observedProperties`, so it is an auto-refresh candidate; the
          // record names the CC layer.
          RoutedResource: {
            physicalId: 'phys-routed',
            resourceType: 'AWS::SQS::Queue',
            properties: { QueueName: 'routed' },
            provisionedBy: 'cc-api',
          },
        },
        outputs: {},
        lastModified: 0,
      } as StackState,
      etag: 'etag-old',
    });
    mockDiffCalculator.calculateDiff.mockResolvedValue(
      new Map<string, ResourceChange>([
        [
          'RoutedResource',
          {
            logicalId: 'RoutedResource',
            changeType: 'NO_CHANGE',
            resourceType: 'AWS::SQS::Queue',
          } as unknown as ResourceChange,
        ],
      ])
    );
    mockDiffCalculator.hasChanges.mockReturnValue(false);

    await makeEngine().deploy(stackName, {
      Resources: { RoutedResource: { Type: 'AWS::SQS::Queue', Properties: {} } },
    });

    expect(ccProvider.readCurrentState).toHaveBeenCalledTimes(1);
    // The discriminator: pre-fix BOTH the record and this assertion's subject
    // were satisfied by the SDK provider running the read.
    expect(mockProvider.readCurrentState).not.toHaveBeenCalled();
    const savedState = mockStateBackend.saveState.mock.calls.at(-1)![2] as StackState;
    expect(savedState.resources['RoutedResource']!.observedProperties).toEqual({
      readBy: 'cc-api',
    });
  });

  // --- issue #2944: a REFUSED baseline must not be refilled by this site -----

  it('SKIPS a record whose baseline a `cdkd import` run refused, and refreshes its sibling', async () => {
    // `observedProperties === undefined` is OVERLOADED. For `Legacy` it means
    // "never captured" and refilling is this site's whole job; for `Refused` a
    // `cdkd import` run DECLINED to capture, because that record's `properties`
    // can no longer position the secret redaction. This site would position the
    // readback against those same `properties` (it passes them as the 4th
    // argument), and after a refusal they can hold the WRONG-BRANCH LITERAL --
    // here `dev-placeholder` -- which pairs with the live plaintext as an
    // ordinary drifted literal, so the walk refuses nothing and the decrypted
    // value is persisted. Schema v10 carries the refusal so this site can tell
    // the two apart.
    //
    // The SIBLING is what keeps the assertion from passing vacuously: without
    // it, "readCurrentState was not called for Refused" is equally satisfied by
    // an auto-refresh that never ran at all.
    const state: StackState = {
      version: STATE_SCHEMA_VERSION_CURRENT,
      region: 'us-east-1',
      stackName,
      resources: {
        Refused: {
          physicalId: 'phys-refused',
          resourceType: 'AWS::SQS::Queue',
          properties: { QueueName: 'q', Password: 'dev-placeholder' },
          observedBaselineRefused: true,
        },
        Legacy: {
          physicalId: 'phys-legacy',
          resourceType: 'AWS::S3::Bucket',
          properties: { BucketName: 'legacy' },
        },
      },
      outputs: {},
      lastModified: 0,
    };
    mockStateBackend.getState.mockResolvedValue({ state, etag: 'etag-old' });
    mockProvider.readCurrentState.mockImplementation(async (physicalId: string) =>
      physicalId === 'phys-refused'
        ? { Password: 'THE-REAL-DECRYPTED-SECRET' }
        : { readBack: physicalId }
    );
    mockDiffCalculator.calculateDiff.mockResolvedValue(
      new Map<string, ResourceChange>([
        [
          'Refused',
          { logicalId: 'Refused', changeType: 'NO_CHANGE', resourceType: 'AWS::SQS::Queue' },
        ],
        [
          'Legacy',
          { logicalId: 'Legacy', changeType: 'NO_CHANGE', resourceType: 'AWS::S3::Bucket' },
        ],
      ])
    );
    mockDiffCalculator.hasChanges.mockReturnValue(false);

    await makeEngine().deploy(stackName, {
      Resources: {
        Refused: { Type: 'AWS::SQS::Queue', Properties: {} },
        Legacy: { Type: 'AWS::S3::Bucket', Properties: {} },
      },
    });

    expect(mockProvider.readCurrentState).toHaveBeenCalledTimes(1);
    expect(mockProvider.readCurrentState).toHaveBeenCalledWith(
      'phys-legacy',
      'Legacy',
      'AWS::S3::Bucket',
      { BucketName: 'legacy' },
      expect.anything()
    );

    const saved = mockStateBackend.saveState.mock.calls.at(-1)![2] as StackState;
    expect(saved.resources['Refused']!.observedProperties).toBeUndefined();
    // The refusal is still standing -- this site does not discharge it.
    expect(saved.resources['Refused']!.observedBaselineRefused).toBe(true);
    // The sibling proves the auto-refresh ran at all.
    expect(saved.resources['Legacy']!.observedProperties).toEqual({ readBack: 'phys-legacy' });
    // The plaintext never entered the persisted record by any route.
    expect(JSON.stringify(saved)).not.toContain('THE-REAL-DECRYPTED-SECRET');
  });

  it('a real UPDATE CLEARS the refusal and lands a fresh baseline', async () => {
    // The marker is a refusal RECORD, not a permanent brand, and this is the
    // contract that keeps it one. A deploy that UPDATEs the resource resolved
    // it from the template -- the evidence the import lacked -- so the record
    // `provisionResource` REBUILDS from that resolution no longer carries the
    // refusal, and the capture it kicks off is a trustworthy baseline.
    //
    // The mechanism is the rebuild rather than an explicit clear, which is
    // exactly why this case is worth having: an edit that "simplified" the
    // rebuild into `{ ...currentResource, ... }` would silently preserve the
    // marker and cost this resource every later refresh, with no other signal.
    const state: StackState = {
      version: STATE_SCHEMA_VERSION_CURRENT,
      region: 'us-east-1',
      stackName,
      resources: {
        Refused: {
          physicalId: 'phys-refused',
          resourceType: 'AWS::SQS::Queue',
          properties: { QueueName: 'q', Password: 'dev-placeholder' },
          observedBaselineRefused: true,
        },
      },
      outputs: {},
      lastModified: 0,
    };
    mockStateBackend.getState.mockResolvedValue({ state, etag: 'etag-old' });
    mockProvider.readCurrentState.mockResolvedValue({ readBack: 'after-update' });
    mockProvider.update.mockResolvedValue({ physicalId: 'phys-refused', wasReplaced: false });
    mockDiffCalculator.calculateDiff.mockResolvedValue(
      new Map<string, ResourceChange>([
        [
          'Refused',
          {
            logicalId: 'Refused',
            changeType: 'UPDATE',
            resourceType: 'AWS::SQS::Queue',
            desiredProperties: { QueueName: 'q', Password: 'changed' },
            currentProperties: { QueueName: 'q', Password: 'dev-placeholder' },
          } as unknown as ResourceChange,
        ],
      ])
    );
    mockDiffCalculator.hasChanges.mockReturnValue(true);
    mockDagBuilder.getExecutionLevels.mockReturnValue([['Refused']]);

    await makeEngine().deploy(stackName, {
      Resources: {
        Refused: { Type: 'AWS::SQS::Queue', Properties: { QueueName: 'q', Password: 'changed' } },
      },
    });

    // The update really ran -- without this the two assertions below are both
    // satisfied by a deploy that skipped the resource entirely.
    expect(mockProvider.update).toHaveBeenCalledTimes(1);
    const saved = mockStateBackend.saveState.mock.calls.at(-1)![2] as StackState;
    expect(saved.resources['Refused']!.observedProperties).toEqual({ readBack: 'after-update' });
    // Presence, not value: a reader tests `=== true`, so a surviving `false`
    // would read as cleared while still serializing -- assert it is GONE.
    expect(Object.hasOwn(saved.resources['Refused']!, 'observedBaselineRefused')).toBe(false);
  });
});
