/**
 * DeployEngine DELETE-branch `DeletionPolicy: Snapshot` gating (issue #1352).
 *
 * The engine's DELETE branch fires for `cdkd deploy` template removals (a
 * resource dropped from the synth template). Under `DeletionPolicy: Snapshot`
 * it must — before any provider.delete:
 *   - Tier A (atomic-final-snapshot types, e.g. RDS DBInstance): thread a
 *     generated `finalSnapshotIdentifier` into the DeleteContext.
 *   - `AWS::EC2::Volume`: run the pre-delete EBS `CreateSnapshot`+wait.
 *   - Anything else Snapshot-tagged: refuse (`FINAL_SNAPSHOT_UNSUPPORTED`).
 * `skipFinalSnapshot: true` (the `--skip-final-snapshot` opt-out) restores
 * plain deletes for all three shapes — both polarities pinned below.
 */

import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import type { CloudFormationTemplate, ResourceProvider } from '../../../src/types/resource.js';
import type { ResourceChange } from '../../../src/types/state.js';

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

vi.mock('p-limit', () => ({
  default: vi.fn(() => <T>(fn: () => T) => fn()),
}));

vi.mock('../../../src/deployment/resource-deadline.js', () => ({
  withResourceDeadline: vi.fn(async (operation: () => Promise<unknown>) => operation()),
}));

const mockCreateEbsFinalSnapshot = vi.hoisted(() => vi.fn());

vi.mock('../../../src/provisioning/final-snapshot.js', async () => {
  const actual = await vi.importActual('../../../src/provisioning/final-snapshot.js');
  return { ...actual, createEbsFinalSnapshot: mockCreateEbsFinalSnapshot };
});

const mockEc2Client = { send: vi.fn() };
vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({ ec2: mockEc2Client }),
  setAwsClients: vi.fn(),
  AwsClients: vi.fn(),
}));

describe('DeployEngine DELETE branch — DeletionPolicy: Snapshot (#1352)', () => {
  let deleteProvider: ResourceProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateEbsFinalSnapshot.mockResolvedValue('snap-unit');
    deleteProvider = {
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn().mockResolvedValue(undefined),
      getAttribute: vi.fn(),
    };
  });

  function makeEngine(options: Record<string, unknown> = {}): InstanceType<typeof DeployEngine> {
    const mockStateBackend = {
      getState: vi.fn(),
      saveState: vi.fn().mockResolvedValue('etag'),
    };
    const mockLockManager = {
      acquireLockWithRetry: vi.fn().mockResolvedValue(true),
      releaseLock: vi.fn().mockResolvedValue(undefined),
    };
    const mockDagBuilder = {
      buildGraph: vi.fn().mockReturnValue({}),
      getExecutionLevels: vi.fn().mockReturnValue([]),
      getDirectDependencies: vi.fn().mockReturnValue([]),
    };
    const mockDiffCalculator = {
      calculateDiff: vi.fn().mockResolvedValue(new Map()),
      hasChanges: vi.fn().mockReturnValue(false),
      filterByType: vi.fn().mockReturnValue([]),
    };
    const mockProviderRegistry = {
      getProvider: vi.fn().mockReturnValue(deleteProvider),
      getProviderFor: vi.fn().mockReturnValue({ provider: deleteProvider, provisionedBy: 'sdk' }),
      getRegisteredTypes: vi.fn().mockReturnValue([]),
      validateResourceTypes: vi.fn(),
      validateResourceProperties: vi.fn(),
    };
    return new DeployEngine(
      mockStateBackend as unknown as never,
      mockLockManager as unknown as never,
      mockDagBuilder as unknown as never,
      mockDiffCalculator as unknown as never,
      mockProviderRegistry as unknown as never,
      options,
      'us-east-1'
    );
  }

  async function invokeDelete(
    engine: InstanceType<typeof DeployEngine>,
    resourceType: string,
    stateExtra: Record<string, unknown> = {},
    template: CloudFormationTemplate = { Resources: {} }
  ): Promise<Record<string, unknown>> {
    const change: ResourceChange = {
      logicalId: 'Target',
      changeType: 'DELETE',
      resourceType,
      currentProperties: {},
    };
    const stateResources: Record<string, unknown> = {
      Target: {
        physicalId: 'phys-target',
        resourceType,
        properties: {},
        attributes: {},
        dependencies: [],
        ...stateExtra,
      },
    };
    type ProvisionResourceFn = (
      logicalId: string,
      change: ResourceChange,
      stateResources: Record<string, unknown>,
      stackName: string,
      template: CloudFormationTemplate
    ) => Promise<void>;
    const provisionResource = (
      engine as unknown as { provisionResource: ProvisionResourceFn }
    ).provisionResource.bind(engine);
    await provisionResource('Target', change, stateResources, 'MyStack', template);
    return stateResources;
  }

  function deleteContextArg(): Record<string, unknown> {
    const deleteMock = deleteProvider.delete as ReturnType<typeof vi.fn>;
    expect(deleteMock).toHaveBeenCalledTimes(1);
    return deleteMock.mock.calls[0][4] as Record<string, unknown>;
  }

  it('Tier A type (RDS DBInstance): threads a generated finalSnapshotIdentifier into DeleteContext', async () => {
    await invokeDelete(makeEngine(), 'AWS::RDS::DBInstance', { deletionPolicy: 'Snapshot' });
    const ctx = deleteContextArg();
    expect(ctx['finalSnapshotIdentifier']).toMatch(/^phys-target-final-\d{8}-\d{6}$/);
  });

  it('Tier A type with skipFinalSnapshot: true — plain delete, no identifier (opt-out polarity)', async () => {
    await invokeDelete(makeEngine({ skipFinalSnapshot: true }), 'AWS::RDS::DBInstance', {
      deletionPolicy: 'Snapshot',
    });
    expect(deleteContextArg()['finalSnapshotIdentifier']).toBeUndefined();
  });

  it('policy Delete / absent — no identifier (default polarity unchanged)', async () => {
    await invokeDelete(makeEngine(), 'AWS::RDS::DBInstance', { deletionPolicy: 'Delete' });
    expect(deleteContextArg()['finalSnapshotIdentifier']).toBeUndefined();
    expect(mockCreateEbsFinalSnapshot).not.toHaveBeenCalled();
  });

  it('AWS::EC2::Volume: runs the pre-delete EBS snapshot, then a plain delete', async () => {
    await invokeDelete(makeEngine(), 'AWS::EC2::Volume', { deletionPolicy: 'Snapshot' });
    expect(mockCreateEbsFinalSnapshot).toHaveBeenCalledWith(
      mockEc2Client,
      'phys-target',
      'Target',
      expect.anything()
    );
    expect(deleteContextArg()['finalSnapshotIdentifier']).toBeUndefined();
  });

  it('AWS::EC2::Volume with skipFinalSnapshot: true — no pre-delete snapshot', async () => {
    await invokeDelete(makeEngine({ skipFinalSnapshot: true }), 'AWS::EC2::Volume', {
      deletionPolicy: 'Snapshot',
    });
    expect(mockCreateEbsFinalSnapshot).not.toHaveBeenCalled();
    expect(deleteContextArg()['finalSnapshotIdentifier']).toBeUndefined();
  });

  it('unsupported Snapshot-tagged type (Redshift): refuses BEFORE any delete', async () => {
    // provisionResource wraps every failure as ProvisioningError; the
    // refusal (and its --skip-final-snapshot guidance) survives as the
    // cause, which formatError renders to the user via `Caused by:`.
    await expect(
      invokeDelete(makeEngine(), 'AWS::Redshift::Cluster', { deletionPolicy: 'Snapshot' })
    ).rejects.toMatchObject({
      code: 'PROVISIONING_ERROR',
      cause: expect.objectContaining({
        code: 'FINAL_SNAPSHOT_UNSUPPORTED',
        message: expect.stringContaining('--skip-final-snapshot'),
      }),
    });
    expect(deleteProvider.delete).not.toHaveBeenCalled();
  });

  it('unsupported type with skipFinalSnapshot: true — deletes plainly (explicit opt-out)', async () => {
    await invokeDelete(makeEngine({ skipFinalSnapshot: true }), 'AWS::Redshift::Cluster', {
      deletionPolicy: 'Snapshot',
    });
    expect(deleteContextArg()['finalSnapshotIdentifier']).toBeUndefined();
  });

  it('cc-api-routed atomic type: refuses BEFORE any delete (Cloud Control cannot snapshot)', async () => {
    await expect(
      invokeDelete(makeEngine(), 'AWS::RDS::DBInstance', {
        deletionPolicy: 'Snapshot',
        provisionedBy: 'cc-api',
      })
    ).rejects.toMatchObject({
      code: 'PROVISIONING_ERROR',
      cause: expect.objectContaining({
        code: 'FINAL_SNAPSHOT_UNSUPPORTED',
        message: expect.stringContaining('cc-api'),
      }),
    });
    expect(deleteProvider.delete).not.toHaveBeenCalled();
  });

  it('cc-api-routed atomic type with skipFinalSnapshot: true — deletes plainly (explicit opt-out)', async () => {
    await invokeDelete(makeEngine({ skipFinalSnapshot: true }), 'AWS::RDS::DBInstance', {
      deletionPolicy: 'Snapshot',
      provisionedBy: 'cc-api',
    });
    expect(deleteContextArg()['finalSnapshotIdentifier']).toBeUndefined();
  });

  it('prefers the region-pinned finalSnapshotEc2 client over the global for the EBS snapshot', async () => {
    const pinned = { send: vi.fn() };
    await invokeDelete(makeEngine({ finalSnapshotEc2: pinned }), 'AWS::EC2::Volume', {
      deletionPolicy: 'Snapshot',
    });
    expect(mockCreateEbsFinalSnapshot).toHaveBeenCalledWith(
      pinned,
      'phys-target',
      'Target',
      expect.anything()
    );
  });

  it('falls back to the template DeletionPolicy for pre-v5 state with no recorded policy', async () => {
    await invokeDelete(
      makeEngine(),
      'AWS::RDS::DBInstance',
      {},
      {
        Resources: {
          Target: { Type: 'AWS::RDS::DBInstance', Properties: {}, DeletionPolicy: 'Snapshot' },
        },
      } as unknown as CloudFormationTemplate
    );
    expect(deleteContextArg()['finalSnapshotIdentifier']).toMatch(/^phys-target-final-/);
  });
});
