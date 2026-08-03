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

const mockCreatePreDeleteFinalSnapshot = vi.hoisted(() => vi.fn());

vi.mock('../../../src/provisioning/final-snapshot.js', async () => {
  const actual = await vi.importActual('../../../src/provisioning/final-snapshot.js');
  return { ...actual, createPreDeleteFinalSnapshot: mockCreatePreDeleteFinalSnapshot };
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
    mockCreatePreDeleteFinalSnapshot.mockResolvedValue('snap-unit');
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
    expect(mockCreatePreDeleteFinalSnapshot).not.toHaveBeenCalled();
  });

  it('AWS::EC2::Volume: runs the pre-delete snapshot dispatcher, then a plain delete', async () => {
    await invokeDelete(makeEngine(), 'AWS::EC2::Volume', { deletionPolicy: 'Snapshot' });
    expect(mockCreatePreDeleteFinalSnapshot).toHaveBeenCalledWith(
      'AWS::EC2::Volume',
      'phys-target',
      'Target',
      expect.anything(),
      expect.anything()
    );
    expect(deleteContextArg()['finalSnapshotIdentifier']).toBeUndefined();
  });

  it('AWS::Redshift::Cluster: routed through the pre-delete snapshot dispatcher (#1353)', async () => {
    await invokeDelete(makeEngine(), 'AWS::Redshift::Cluster', { deletionPolicy: 'Snapshot' });
    expect(mockCreatePreDeleteFinalSnapshot).toHaveBeenCalledWith(
      'AWS::Redshift::Cluster',
      'phys-target',
      'Target',
      expect.anything(),
      expect.anything()
    );
    expect(deleteContextArg()['finalSnapshotIdentifier']).toBeUndefined();
  });

  it('AWS::EC2::Volume with skipFinalSnapshot: true — no pre-delete snapshot', async () => {
    await invokeDelete(makeEngine({ skipFinalSnapshot: true }), 'AWS::EC2::Volume', {
      deletionPolicy: 'Snapshot',
    });
    expect(mockCreatePreDeleteFinalSnapshot).not.toHaveBeenCalled();
    expect(deleteContextArg()['finalSnapshotIdentifier']).toBeUndefined();
  });

  it('Snapshot-tagged type CFn itself would refuse (S3): refuses BEFORE any delete', async () => {
    // provisionResource wraps every failure as ProvisioningError; the
    // refusal (and its --skip-final-snapshot guidance) survives as the
    // cause, which formatError renders to the user via `Caused by:`.
    await expect(
      invokeDelete(makeEngine(), 'AWS::S3::Bucket', { deletionPolicy: 'Snapshot' })
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
    await invokeDelete(makeEngine({ skipFinalSnapshot: true }), 'AWS::S3::Bucket', {
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

  it('prefers the region-pinned finalSnapshotClients over the global for the pre-delete snapshot', async () => {
    const pinned = { ec2: { send: vi.fn() }, redshift: {}, elastiCache: {} };
    await invokeDelete(makeEngine({ finalSnapshotClients: pinned }), 'AWS::EC2::Volume', {
      deletionPolicy: 'Snapshot',
    });
    expect(mockCreatePreDeleteFinalSnapshot).toHaveBeenCalledWith(
      'AWS::EC2::Volume',
      'phys-target',
      'Target',
      pinned,
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

describe('UpdateReplacePolicy: Snapshot on the create-first cleanup delete (#1354)', () => {
  // The DEFAULT replacement path (no --replace needed): create-first, then
  // delete the old resource. The snapshot gate runs BEFORE that delete and
  // its two failure classes are handled differently (refusal propagates,
  // transient failure skips the delete rather than deleting un-snapshotted).
  async function invokeReplacement(
    resourceType: string,
    updateReplacePolicy: string | undefined,
    engineOptions: Record<string, unknown> = {}
  ): Promise<void> {
    const engine = makeEngine(engineOptions);
    (deleteProvider.create as ReturnType<typeof vi.fn>).mockResolvedValue({
      physicalId: 'phys-new',
      attributes: {},
    });
    const change: ResourceChange = {
      logicalId: 'Target',
      changeType: 'UPDATE',
      resourceType,
      currentProperties: { Immutable: 'a' },
      desiredProperties: { Immutable: 'b' },
      propertyChanges: [
        { path: 'Immutable', oldValue: 'a', newValue: 'b', requiresReplacement: true },
      ],
    };
    const stateResources: Record<string, unknown> = {
      Target: {
        physicalId: 'phys-target',
        resourceType,
        properties: { Immutable: 'a' },
        attributes: {},
        dependencies: [],
      },
    };
    const template = {
      Resources: {
        Target: {
          Type: resourceType,
          Properties: { Immutable: 'b' },
          ...(updateReplacePolicy !== undefined && { UpdateReplacePolicy: updateReplacePolicy }),
        },
      },
    } as unknown as CloudFormationTemplate;
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
  }

  it('threads a generated identifier into the cleanup delete', async () => {
    await invokeReplacement('AWS::RDS::DBInstance', 'Snapshot', {
      forceStatefulRecreation: true,
    });
    expect(deleteContextArg()['finalSnapshotIdentifier']).toMatch(
      /^phys-target-final-\d{8}-\d{6}$/
    );
  });

  it('policy absent — plain cleanup delete (default polarity unchanged)', async () => {
    await invokeReplacement('AWS::RDS::DBInstance', undefined, {
      forceStatefulRecreation: true,
    });
    expect(deleteContextArg()['finalSnapshotIdentifier']).toBeUndefined();
  });

  it('a TRANSIENT snapshot failure SKIPS the delete — the old resource is never deleted un-snapshotted', async () => {
    const { CdkdError } = await import('../../../src/utils/error-handler.js');
    mockCreatePreDeleteFinalSnapshot.mockRejectedValueOnce(
      new CdkdError('snapshot timed out', 'FINAL_SNAPSHOT_TIMEOUT')
    );
    // EC2 Volume takes the pre-delete path, so the mocked creator is the
    // gate. The deploy continues (warn-and-continue) but must NOT delete.
    await invokeReplacement('AWS::EC2::Volume', 'Snapshot');
    expect(deleteProvider.delete).not.toHaveBeenCalled();
  });

  it('a REFUSAL propagates and fails the resource (CFn parity: the update fails)', async () => {
    // SNS Topic: not snapshot-capable AND not in STATEFUL_TYPES, so the
    // snapshot refusal (not the stateful-recreation guard) is what surfaces.
    await expect(invokeReplacement('AWS::SNS::Topic', 'Snapshot')).rejects.toMatchObject({
      code: 'PROVISIONING_ERROR',
      cause: expect.objectContaining({ code: 'FINAL_SNAPSHOT_UNSUPPORTED' }),
    });
    expect(deleteProvider.delete).not.toHaveBeenCalled();
  });
});

describe('UpdateReplacePolicy: Snapshot on the update-not-supported replacement fallback (#1354)', () => {
  async function invokeUpdateFallback(
    engineOptions: Record<string, unknown>,
    stateExtra: Record<string, unknown>
  ): Promise<void> {
    const engine = makeEngine({
      replace: true,
      forceStatefulRecreation: true,
      ...engineOptions,
    });
    const { ResourceUpdateNotSupportedError } = await import(
      '../../../src/utils/error-handler.js'
    );
    (deleteProvider.update as ReturnType<typeof vi.fn>).mockRejectedValue(
      new ResourceUpdateNotSupportedError('AWS::RDS::DBInstance', 'Target', 'immutable property changed')
    );
    (deleteProvider.create as ReturnType<typeof vi.fn>).mockResolvedValue({
      physicalId: 'phys-new',
      attributes: {},
    });
    const change: ResourceChange = {
      logicalId: 'Target',
      changeType: 'UPDATE',
      resourceType: 'AWS::RDS::DBInstance',
      currentProperties: { AllocatedStorage: '10' },
      desiredProperties: { AllocatedStorage: '20' },
      propertyChanges: [
        {
          path: 'AllocatedStorage',
          oldValue: '10',
          newValue: '20',
          requiresReplacement: false,
        },
      ],
    };
    const stateResources: Record<string, unknown> = {
      Target: {
        physicalId: 'phys-target',
        resourceType: 'AWS::RDS::DBInstance',
        properties: { AllocatedStorage: '10' },
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
    await provisionResource('Target', change, stateResources, 'MyStack', {
      Resources: {
        Target: { Type: 'AWS::RDS::DBInstance', Properties: { AllocatedStorage: '20' } },
      },
    } as unknown as CloudFormationTemplate);
  }

  it('threads a generated identifier into the fallback replacement delete', async () => {
    await invokeUpdateFallback({}, { updateReplacePolicy: 'Snapshot' });
    const ctx = deleteContextArg();
    expect(ctx['finalSnapshotIdentifier']).toMatch(/^phys-target-final-\d{8}-\d{6}$/);
  });

  it('skipFinalSnapshot: true — plain replacement delete (opt-out polarity)', async () => {
    await invokeUpdateFallback({ skipFinalSnapshot: true }, { updateReplacePolicy: 'Snapshot' });
    expect(deleteContextArg()['finalSnapshotIdentifier']).toBeUndefined();
  });

  it('policy absent — plain replacement delete (default polarity unchanged)', async () => {
    await invokeUpdateFallback({}, {});
    expect(deleteContextArg()['finalSnapshotIdentifier']).toBeUndefined();
  });
});
});
