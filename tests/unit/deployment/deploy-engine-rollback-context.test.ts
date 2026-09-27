/**
 * DeployEngine -> rollback-executor context threading (issue #1363).
 *
 * `DeployEngine.rollbackExecutorContext()` hands the executor two fields the
 * `DeletionPolicy: Snapshot` rollback path (issue #1358) depends on:
 *
 *   finalSnapshotClients: this.options.finalSnapshotClients,
 *   skipFinalSnapshot: this.options.skipFinalSnapshot,
 *
 * Nothing pinned that wiring: deleting BOTH lines left the whole unit suite
 * green, and the real-AWS integ cannot catch it either — dropping
 * `finalSnapshotClients` falls back to `getAwsClients()`, which is correct in
 * any single-region run, and dropping `skipFinalSnapshot` only means
 * `--skip-final-snapshot` silently stops applying to the automatic rollback's
 * delete (an extra snapshot, no fixture asserts its absence).
 *
 * These cases drive the engine's own `performRollback` through the REAL
 * `replayRollback`, so each field is observed where it actually lands: the
 * clients in the pre-delete snapshot call, the flag in the provider's
 * DeleteContext. Both polarities of the flag are pinned — asserting only the
 * `true` case would also pass with the line deleted if the default happened
 * to match.
 */

import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import type { CompletedOperation } from '../../../src/deployment/rollback-executor.js';
import type { ResourceProvider } from '../../../src/types/resource.js';
import type { ResourceState, StackState } from '../../../src/types/state.js';

vi.mock('../../../src/utils/logger.js', () => {
  const fns = {
    setLevel: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => fns,
  };
  return { getLogger: () => fns };
});

const mockCreatePreDeleteFinalSnapshot = vi.hoisted(() => vi.fn());

// Only the AWS-touching dispatcher is stubbed; the type sets / identifier
// builder stay REAL so these cases pin the actual routing matrix.
vi.mock('../../../src/provisioning/final-snapshot.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../src/provisioning/final-snapshot.js')>();
  return { ...actual, createPreDeleteFinalSnapshot: mockCreatePreDeleteFinalSnapshot };
});

// The process-global fallback the engine's `finalSnapshotClients` exists to
// AVOID. Distinct object identity is what makes the assertion below fail if
// the engine stops threading its own region-pinned clients.
const processGlobalClients = { ec2: { send: vi.fn() }, tag: 'process-global' };
vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => processGlobalClients,
  setAwsClients: vi.fn(),
  AwsClients: vi.fn(),
}));

/** The region-pinned set a stack's deploy builds and threads down. */
const pinnedClients = { ec2: { send: vi.fn() }, tag: 'stack-region-pinned' };

describe('DeployEngine rollback context threading (#1363)', () => {
  let deleteProvider: ResourceProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    mockCreatePreDeleteFinalSnapshot.mockResolvedValue('snap-unit');
    deleteProvider = {
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn().mockResolvedValue(undefined),
      getAttribute: vi.fn(),
    };
  });

  function makeEngine(options: Record<string, unknown> = {}): InstanceType<typeof DeployEngine> {
    const mockProviderRegistry = {
      getProvider: vi.fn().mockReturnValue(deleteProvider),
      getProviderFor: vi.fn().mockReturnValue({ provider: deleteProvider, provisionedBy: 'sdk' }),
      getRegisteredTypes: vi.fn().mockReturnValue([]),
      validateResourceTypes: vi.fn(),
      validateResourceProperties: vi.fn(),
    };
    return new DeployEngine(
      { getState: vi.fn(), saveState: vi.fn() } as unknown as never,
      { acquireLockWithRetry: vi.fn(), releaseLock: vi.fn() } as unknown as never,
      { buildGraph: vi.fn(), getExecutionLevels: vi.fn(), getDirectDependencies: vi.fn() } as never,
      { calculateDiff: vi.fn(), hasChanges: vi.fn(), filterByType: vi.fn() } as never,
      mockProviderRegistry as unknown as never,
      options,
      'us-east-1'
    );
  }

  /**
   * Roll back one completed CREATE of `resourceType` carrying
   * `DeletionPolicy: Snapshot`, through the engine's own private
   * `performRollback` (the caller of `rollbackExecutorContext()`).
   */
  async function rollbackSnapshotCreate(
    engine: InstanceType<typeof DeployEngine>,
    resourceType: string
  ): Promise<Record<string, ResourceState>> {
    const op: CompletedOperation = {
      logicalId: 'Target',
      changeType: 'CREATE',
      resourceType,
      physicalId: 'phys-target',
    };
    const stateResources: Record<string, ResourceState> = {
      Target: {
        physicalId: 'phys-target',
        resourceType,
        properties: {},
        attributes: {},
        dependencies: [],
        deletionPolicy: 'Snapshot',
      },
    };
    type PerformRollbackFn = (
      completedOperations: CompletedOperation[],
      stateResources: Record<string, ResourceState>,
      stackName: string,
      // Issue #2057: the PRE-deploy record, threaded so the executor context
      // can derive `importedProducerRegions`. This fixture has no cross-stack
      // read, so the derived list is empty and nothing here changes.
      previousState: StackState
    ) => Promise<{ failures: number; warnings: number }>;
    const performRollback = (
      engine as unknown as { performRollback: PerformRollbackFn }
    ).performRollback.bind(engine);
    const result = await performRollback([op], stateResources, 'MyStack', {
      version: 8,
      stackName: 'MyStack',
      region: 'us-east-1',
      resources: {},
      outputs: {},
      lastModified: 1,
    });
    expect(result.failures).toBe(0);
    return stateResources;
  }

  function deleteContextArg(): Record<string, unknown> {
    const deleteMock = deleteProvider.delete as ReturnType<typeof vi.fn>;
    expect(deleteMock).toHaveBeenCalledTimes(1);
    return deleteMock.mock.calls[0][4] as Record<string, unknown>;
  }

  it('threads finalSnapshotClients into the pre-delete snapshot call', async () => {
    const state = await rollbackSnapshotCreate(
      makeEngine({ finalSnapshotClients: pinnedClients }),
      'AWS::EC2::Volume'
    );
    // The 4th argument is the clients object. It must be the engine's
    // region-pinned set, NOT the `getAwsClients()` process-global a
    // concurrent stack's deploy can repoint at another region.
    expect(mockCreatePreDeleteFinalSnapshot).toHaveBeenCalledOnce();
    expect(mockCreatePreDeleteFinalSnapshot.mock.calls[0][3]).toBe(pinnedClients);
    expect(mockCreatePreDeleteFinalSnapshot.mock.calls[0][3]).not.toBe(processGlobalClients);
    expect(state['Target']).toBeUndefined();
  });

  it('threads skipFinalSnapshot: true — the rollback delete takes no snapshot', async () => {
    await rollbackSnapshotCreate(
      makeEngine({ finalSnapshotClients: pinnedClients, skipFinalSnapshot: true }),
      'AWS::RDS::DBInstance'
    );
    expect(deleteContextArg()['finalSnapshotIdentifier']).toBeUndefined();
    expect(mockCreatePreDeleteFinalSnapshot).not.toHaveBeenCalled();
  });

  it('threads skipFinalSnapshot: false — the rollback delete DOES snapshot (opposite polarity)', async () => {
    await rollbackSnapshotCreate(
      makeEngine({ finalSnapshotClients: pinnedClients, skipFinalSnapshot: false }),
      'AWS::RDS::DBInstance'
    );
    expect(deleteContextArg()['finalSnapshotIdentifier']).toMatch(
      /^phys-target-final-\d{8}-\d{6}$/
    );
  });

  it('skipFinalSnapshot: true also reaches the pre-delete snapshot types', async () => {
    // Same flag, the other mechanism arm: without the threading this would
    // still take (and wait for) a real EBS snapshot the user opted out of.
    await rollbackSnapshotCreate(
      makeEngine({ finalSnapshotClients: pinnedClients, skipFinalSnapshot: true }),
      'AWS::EC2::Volume'
    );
    expect(mockCreatePreDeleteFinalSnapshot).not.toHaveBeenCalled();
    expect(deleteContextArg()['finalSnapshotIdentifier']).toBeUndefined();
  });
});
