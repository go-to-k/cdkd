import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const mockSend = vi.hoisted(() => vi.fn());

vi.mock('@aws-sdk/client-fsx', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-fsx')>();
  return {
    ...actual,
    FSxClient: vi.fn().mockImplementation(() => ({
      send: mockSend,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
  };
});

vi.mock('../../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  return {
    getLogger: () => ({
      child: () => childLogger,
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  };
});

import {
  FSxFileSystemProvider,
  VARIANT_MUTABLE_SUBPROPS,
} from '../../../../src/provisioning/providers/fsx-filesystem-provider.js';
import {
  CreateFileSystemCommand,
  CreateFileSystemFromBackupCommand,
  UpdateFileSystemCommand,
  DeleteFileSystemCommand,
  DescribeFileSystemsCommand,
  TagResourceCommand,
  UntagResourceCommand,
  FileSystemNotFound,
} from '@aws-sdk/client-fsx';
import {
  ProvisioningError,
  ResourceUpdateNotSupportedError,
} from '../../../../src/utils/error-handler.js';

const RESOURCE_TYPE = 'AWS::FSx::FileSystem';
const FS_ID = 'fs-0123456789abcdef0';
const FS_ARN = `arn:aws:fsx:us-east-1:123456789012:file-system/${FS_ID}`;
const DNS_NAME = `${FS_ID}.fsx.us-east-1.amazonaws.com`;
const MOUNT_NAME = 'abcdef';

const LUSTRE_PROPS = {
  FileSystemType: 'LUSTRE',
  StorageCapacity: 1200,
  SubnetIds: ['subnet-111'],
  SecurityGroupIds: ['sg-222'],
  LustreConfiguration: {
    DeploymentType: 'SCRATCH_2',
  },
  Tags: [{ Key: 'env', Value: 'test' }],
};

const WINDOWS_PROPS = {
  FileSystemType: 'WINDOWS',
  StorageCapacity: 32,
  SubnetIds: ['subnet-111'],
  SecurityGroupIds: ['sg-222'],
  WindowsConfiguration: {
    ActiveDirectoryId: 'd-1234567890',
    DeploymentType: 'MULTI_AZ_1',
    PreferredSubnetId: 'subnet-111',
    ThroughputCapacity: 32,
    WeeklyMaintenanceStartTime: '1:05:00',
  },
  Tags: [{ Key: 'env', Value: 'test' }],
};

const ONTAP_PROPS = {
  FileSystemType: 'ONTAP',
  StorageCapacity: 1024,
  SubnetIds: ['subnet-111', 'subnet-222'],
  SecurityGroupIds: ['sg-222'],
  OntapConfiguration: {
    DeploymentType: 'MULTI_AZ_1',
    ThroughputCapacity: 128,
    PreferredSubnetId: 'subnet-111',
    RouteTableIds: ['rtb-aaa', 'rtb-bbb'],
    DiskIopsConfiguration: { Mode: 'AUTOMATIC' },
  },
  Tags: [{ Key: 'env', Value: 'test' }],
};

const OPENZFS_PROPS = {
  FileSystemType: 'OPENZFS',
  StorageCapacity: 64,
  SubnetIds: ['subnet-111'],
  SecurityGroupIds: ['sg-222'],
  OpenZFSConfiguration: {
    DeploymentType: 'SINGLE_AZ_1',
    ThroughputCapacity: 64,
    RootVolumeConfiguration: {
      RecordSizeKiB: 128,
      DataCompressionType: 'LZ4',
      NfsExports: [
        { ClientConfigurations: [{ Clients: '*', Options: ['rw', 'crossmnt'] }] },
      ],
      UserAndGroupQuotas: [{ Type: 'USER', Id: 0, StorageCapacityQuotaGiB: 10 }],
    },
  },
  Tags: [{ Key: 'env', Value: 'test' }],
};

const availableFs = (overrides: Record<string, unknown> = {}) => ({
  FileSystemId: FS_ID,
  Lifecycle: 'AVAILABLE',
  ResourceARN: FS_ARN,
  DNSName: DNS_NAME,
  LustreConfiguration: { MountName: MOUNT_NAME, DeploymentType: 'SCRATCH_2' },
  ...overrides,
});

function notFound(): FileSystemNotFound {
  return new FileSystemNotFound({ message: 'File system does not exist.', $metadata: {} });
}

function callsOf(commandClass: abstract new (...args: never[]) => object): Array<{
  input: Record<string, unknown>;
}> {
  return mockSend.mock.calls
    .map((c) => c[0] as object)
    .filter((c) => c instanceof commandClass) as Array<{ input: Record<string, unknown> }>;
}

/**
 * Route mockSend by command class name. `DescribeFileSystemsCommand`
 * responses can be a QUEUE (array) — each poll consumes the next entry,
 * the last entry repeats.
 */
function routeSend(routes: Record<string, unknown>): void {
  const queues = new Map<string, unknown[]>();
  mockSend.mockImplementation((command: object) => {
    const name = command.constructor.name;
    if (!(name in routes)) {
      return Promise.reject(new Error(`Unexpected command: ${name}`));
    }
    let value = routes[name];
    if (Array.isArray(value)) {
      if (!queues.has(name)) queues.set(name, [...(value as unknown[])]);
      const queue = queues.get(name)!;
      value = queue.length > 1 ? queue.shift() : queue[0];
    }
    if (value instanceof Error) return Promise.reject(value);
    return Promise.resolve(value);
  });
}

function newProvider(overrides: { maxWaitMs?: number } = {}): FSxFileSystemProvider {
  return new FSxFileSystemProvider({ pollIntervalMs: 0, maxWaitMs: overrides.maxWaitMs ?? 5000 });
}

describe('FSxFileSystemProvider create', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sends CreateFileSystem, polls through CREATING to AVAILABLE, and returns attributes', async () => {
    routeSend({
      CreateFileSystemCommand: {
        FileSystem: { FileSystemId: FS_ID, Lifecycle: 'CREATING' },
      },
      DescribeFileSystemsCommand: [
        { FileSystems: [{ FileSystemId: FS_ID, Lifecycle: 'CREATING' }] },
        { FileSystems: [availableFs()] },
      ],
    });

    const result = await newProvider().create('MyFs', RESOURCE_TYPE, { ...LUSTRE_PROPS });

    expect(result.physicalId).toBe(FS_ID);
    expect(result.attributes).toEqual({
      ResourceARN: FS_ARN,
      DNSName: DNS_NAME,
      LustreMountName: MOUNT_NAME,
      FileSystemId: FS_ID,
    });

    const [create] = callsOf(CreateFileSystemCommand);
    expect(create.input['FileSystemType']).toBe('LUSTRE');
    expect(create.input['StorageCapacity']).toBe(1200);
    expect(create.input['SubnetIds']).toEqual(['subnet-111']);
    expect(create.input['SecurityGroupIds']).toEqual(['sg-222']);
    expect(create.input['LustreConfiguration']).toMatchObject({ DeploymentType: 'SCRATCH_2' });
    expect(create.input['Tags']).toEqual([{ Key: 'env', Value: 'test' }]);
    expect(create.input['ClientRequestToken']).toMatch(/^cdkd-MyFs-[0-9a-f]{12}$/);
    // Should have polled at least twice.
    expect(callsOf(DescribeFileSystemsCommand).length).toBeGreaterThanOrEqual(2);
  });

  it('coerces string-typed numeric properties to numbers', async () => {
    routeSend({
      CreateFileSystemCommand: { FileSystem: { FileSystemId: FS_ID } },
      DescribeFileSystemsCommand: { FileSystems: [availableFs()] },
    });

    await newProvider().create('MyFs', RESOURCE_TYPE, {
      ...LUSTRE_PROPS,
      StorageCapacity: '2400',
      LustreConfiguration: {
        DeploymentType: 'PERSISTENT_2',
        PerUnitStorageThroughput: '125',
        AutomaticBackupRetentionDays: '0',
        CopyTagsToBackups: 'false',
      },
    });

    const [create] = callsOf(CreateFileSystemCommand);
    expect(create.input['StorageCapacity']).toBe(2400);
    expect(create.input['LustreConfiguration']).toMatchObject({
      PerUnitStorageThroughput: 125,
      AutomaticBackupRetentionDays: 0,
      CopyTagsToBackups: false,
    });
  });

  it('derives a STABLE ClientRequestToken across retries but a DIFFERENT one when an immutable input changes', async () => {
    routeSend({
      CreateFileSystemCommand: { FileSystem: { FileSystemId: FS_ID } },
      DescribeFileSystemsCommand: { FileSystems: [availableFs()] },
    });

    const provider = newProvider();
    await provider.create('MyFs', RESOURCE_TYPE, { ...LUSTRE_PROPS });
    await provider.create('MyFs', RESOURCE_TYPE, { ...LUSTRE_PROPS });
    await provider.create('MyFs', RESOURCE_TYPE, {
      ...LUSTRE_PROPS,
      SubnetIds: ['subnet-999'],
    });

    const creates = callsOf(CreateFileSystemCommand);
    expect(creates[0].input['ClientRequestToken']).toBe(creates[1].input['ClientRequestToken']);
    expect(creates[0].input['ClientRequestToken']).not.toBe(
      creates[2].input['ClientRequestToken']
    );
  });

  it('routes BackupId creates through CreateFileSystemFromBackup without FileSystemType', async () => {
    routeSend({
      CreateFileSystemFromBackupCommand: { FileSystem: { FileSystemId: FS_ID } },
      DescribeFileSystemsCommand: { FileSystems: [availableFs()] },
    });

    await newProvider().create('MyFs', RESOURCE_TYPE, {
      BackupId: 'backup-0abc',
      SubnetIds: ['subnet-111'],
    });

    const [create] = callsOf(CreateFileSystemFromBackupCommand);
    expect(create.input['BackupId']).toBe('backup-0abc');
    expect(create.input['FileSystemType']).toBeUndefined();
    expect(callsOf(CreateFileSystemCommand)).toHaveLength(0);
  });

  it('rejects an unknown FileSystemType with a clear error before any SDK call', async () => {
    await expect(
      newProvider().create('MyFs', RESOURCE_TYPE, { ...LUSTRE_PROPS, FileSystemType: 'BOGUS' })
    ).rejects.toThrow(/is not supported by cdkd — expected one of LUSTRE \/ WINDOWS \/ ONTAP \/ OPENZFS/);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('throws and best-effort deletes the file system when creation goes FAILED', async () => {
    routeSend({
      CreateFileSystemCommand: { FileSystem: { FileSystemId: FS_ID } },
      DescribeFileSystemsCommand: {
        FileSystems: [
          { FileSystemId: FS_ID, Lifecycle: 'FAILED', FailureDetails: { Message: 'boom' } },
        ],
      },
      DeleteFileSystemCommand: {},
    });

    await expect(newProvider().create('MyFs', RESOURCE_TYPE, { ...LUSTRE_PROPS })).rejects.toThrow(
      /FAILED: boom/
    );
    expect(callsOf(DeleteFileSystemCommand)).toHaveLength(1);
  });

  it('throws ProvisioningError when the AVAILABLE wait times out (and rolls back)', async () => {
    routeSend({
      CreateFileSystemCommand: { FileSystem: { FileSystemId: FS_ID } },
      DescribeFileSystemsCommand: {
        FileSystems: [{ FileSystemId: FS_ID, Lifecycle: 'CREATING' }],
      },
      DeleteFileSystemCommand: {},
    });

    await expect(
      newProvider({ maxWaitMs: 25 }).create('MyFs', RESOURCE_TYPE, { ...LUSTRE_PROPS })
    ).rejects.toThrow(/Timed out waiting/);
    expect(callsOf(DeleteFileSystemCommand)).toHaveLength(1);
  });
});

describe('FSxFileSystemProvider create transient poll tolerance', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('absorbs a transient throttle mid-poll instead of failing the create', async () => {
    const throttle = Object.assign(new Error('Rate exceeded'), { name: 'ThrottlingException' });
    routeSend({
      CreateFileSystemCommand: { FileSystem: { FileSystemId: FS_ID } },
      DescribeFileSystemsCommand: [
        { FileSystems: [{ FileSystemId: FS_ID, Lifecycle: 'CREATING' }] },
        throttle,
        { FileSystems: [availableFs()] },
      ],
    });

    const result = await newProvider().create('MyFs', RESOURCE_TYPE, { ...LUSTRE_PROPS });
    expect(result.physicalId).toBe(FS_ID);
    // No rollback delete was issued.
    expect(callsOf(DeleteFileSystemCommand)).toHaveLength(0);
  });

  it('propagates a non-transient poll error (after rollback)', async () => {
    const denied = Object.assign(new Error('not authorized'), { name: 'AccessDeniedException' });
    routeSend({
      CreateFileSystemCommand: { FileSystem: { FileSystemId: FS_ID } },
      DescribeFileSystemsCommand: denied,
      DeleteFileSystemCommand: {},
    });

    await expect(newProvider().create('MyFs', RESOURCE_TYPE, { ...LUSTRE_PROPS })).rejects.toThrow(
      /not authorized/
    );
    expect(callsOf(DeleteFileSystemCommand)).toHaveLength(1);
  });
});

describe('FSxFileSystemProvider update', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sends UpdateFileSystem with only the mutable Lustre diff and waits for AVAILABLE', async () => {
    routeSend({
      UpdateFileSystemCommand: {},
      DescribeFileSystemsCommand: { FileSystems: [availableFs()] },
    });

    const result = await newProvider().update(
      'MyFs',
      FS_ID,
      RESOURCE_TYPE,
      {
        ...LUSTRE_PROPS,
        LustreConfiguration: {
          DeploymentType: 'SCRATCH_2',
          WeeklyMaintenanceStartTime: '1:05:00',
        },
      },
      { ...LUSTRE_PROPS }
    );

    expect(result).toMatchObject({ physicalId: FS_ID, wasReplaced: false });
    // The update result re-derives the attribute set so the engine's state
    // write keeps GetAtt-served attributes fresh across updates.
    expect(result.attributes).toEqual({
      ResourceARN: FS_ARN,
      DNSName: DNS_NAME,
      LustreMountName: MOUNT_NAME,
      FileSystemId: FS_ID,
    });
    const [update] = callsOf(UpdateFileSystemCommand);
    expect(update.input).toEqual({
      FileSystemId: FS_ID,
      LustreConfiguration: { WeeklyMaintenanceStartTime: '1:05:00' },
    });
  });

  it('waits for the FILE_SYSTEM_UPDATE administrative action to complete before returning', async () => {
    routeSend({
      UpdateFileSystemCommand: {},
      DescribeFileSystemsCommand: [
        {
          FileSystems: [
            availableFs({
              AdministrativeActions: [
                { AdministrativeActionType: 'FILE_SYSTEM_UPDATE', Status: 'IN_PROGRESS' },
                // Ignored: storage optimization runs for hours post-grow.
                { AdministrativeActionType: 'STORAGE_OPTIMIZATION', Status: 'IN_PROGRESS' },
              ],
            }),
          ],
        },
        {
          FileSystems: [
            availableFs({
              AdministrativeActions: [
                { AdministrativeActionType: 'FILE_SYSTEM_UPDATE', Status: 'COMPLETED' },
                { AdministrativeActionType: 'STORAGE_OPTIMIZATION', Status: 'IN_PROGRESS' },
              ],
            }),
          ],
        },
      ],
    });

    await newProvider().update(
      'MyFs',
      FS_ID,
      RESOURCE_TYPE,
      {
        ...LUSTRE_PROPS,
        LustreConfiguration: { DeploymentType: 'SCRATCH_2', DataCompressionType: 'LZ4' },
      },
      { ...LUSTRE_PROPS, LustreConfiguration: { DeploymentType: 'SCRATCH_2' } }
    );

    // First Describe saw IN_PROGRESS -> must poll again before returning.
    expect(callsOf(DescribeFileSystemsCommand).length).toBeGreaterThanOrEqual(2);
  });

  it('ignores HISTORICAL failed update actions — only actions from this update are tracked', async () => {
    const now = new Date();
    const oldFailure = {
      AdministrativeActionType: 'FILE_SYSTEM_UPDATE',
      Status: 'FAILED',
      RequestTime: new Date('2020-01-01T00:00:00Z'),
      FailureDetails: { Message: 'a PREVIOUS update failed' },
    };
    routeSend({
      // The UpdateFileSystem response carries the newly-created action —
      // its RequestTime seeds the tracking threshold.
      UpdateFileSystemCommand: {
        FileSystem: {
          FileSystemId: FS_ID,
          AdministrativeActions: [
            oldFailure,
            { AdministrativeActionType: 'FILE_SYSTEM_UPDATE', Status: 'PENDING', RequestTime: now },
          ],
        },
      },
      DescribeFileSystemsCommand: {
        FileSystems: [
          availableFs({
            AdministrativeActions: [
              oldFailure,
              {
                AdministrativeActionType: 'FILE_SYSTEM_UPDATE',
                Status: 'COMPLETED',
                RequestTime: now,
              },
            ],
          }),
        ],
      },
    });

    // Must NOT throw on the stale 2020 FAILED action — the retry succeeds.
    await expect(
      newProvider().update(
        'MyFs',
        FS_ID,
        RESOURCE_TYPE,
        {
          ...LUSTRE_PROPS,
          LustreConfiguration: { DeploymentType: 'SCRATCH_2', DataCompressionType: 'LZ4' },
        },
        { ...LUSTRE_PROPS, LustreConfiguration: { DeploymentType: 'SCRATCH_2' } }
      )
    ).resolves.toMatchObject({ physicalId: FS_ID, wasReplaced: false });
  });

  it('does not return before the confirmed new action becomes visible in Describe (lagging replica)', async () => {
    const now = new Date();
    routeSend({
      // The response CONFIRMS a new action was created...
      UpdateFileSystemCommand: {
        FileSystem: {
          FileSystemId: FS_ID,
          AdministrativeActions: [
            { AdministrativeActionType: 'FILE_SYSTEM_UPDATE', Status: 'PENDING', RequestTime: now },
          ],
        },
      },
      DescribeFileSystemsCommand: [
        // ...but a lagging Describe replica shows NO actions while already
        // AVAILABLE — the wait must NOT return here...
        { FileSystems: [availableFs({ AdministrativeActions: [] })] },
        // ...and only returns once the action is observed terminal.
        {
          FileSystems: [
            availableFs({
              AdministrativeActions: [
                {
                  AdministrativeActionType: 'FILE_SYSTEM_UPDATE',
                  Status: 'COMPLETED',
                  RequestTime: now,
                },
              ],
            }),
          ],
        },
      ],
    });

    await newProvider().update(
      'MyFs',
      FS_ID,
      RESOURCE_TYPE,
      {
        ...LUSTRE_PROPS,
        LustreConfiguration: { DeploymentType: 'SCRATCH_2', DataCompressionType: 'LZ4' },
      },
      { ...LUSTRE_PROPS, LustreConfiguration: { DeploymentType: 'SCRATCH_2' } }
    );

    // The lagging empty round must have forced a second Describe.
    expect(callsOf(DescribeFileSystemsCommand).length).toBeGreaterThanOrEqual(2);
  });

  it('hard-fails when the FILE_SYSTEM_UPDATE administrative action reports FAILED', async () => {
    routeSend({
      UpdateFileSystemCommand: {},
      DescribeFileSystemsCommand: {
        FileSystems: [
          availableFs({
            AdministrativeActions: [
              {
                AdministrativeActionType: 'FILE_SYSTEM_UPDATE',
                Status: 'FAILED',
                FailureDetails: { Message: 'update rejected' },
              },
            ],
          }),
        ],
      },
    });

    await expect(
      newProvider().update(
        'MyFs',
        FS_ID,
        RESOURCE_TYPE,
        {
          ...LUSTRE_PROPS,
          LustreConfiguration: { DeploymentType: 'SCRATCH_2', DataCompressionType: 'LZ4' },
        },
        { ...LUSTRE_PROPS, LustreConfiguration: { DeploymentType: 'SCRATCH_2' } }
      )
    ).rejects.toThrow(/FILE_SYSTEM_UPDATE administrative action.*update rejected/);
  });

  it('applies StorageType / FileSystemTypeVersion / NetworkType / MetadataConfiguration changes in one UpdateFileSystem', async () => {
    routeSend({
      UpdateFileSystemCommand: {},
      DescribeFileSystemsCommand: { FileSystems: [availableFs()] },
    });

    await newProvider().update(
      'MyFs',
      FS_ID,
      RESOURCE_TYPE,
      {
        ...LUSTRE_PROPS,
        StorageType: 'INTELLIGENT_TIERING',
        FileSystemTypeVersion: '2.15',
        NetworkType: 'DUAL_STACK',
        LustreConfiguration: {
          DeploymentType: 'SCRATCH_2',
          MetadataConfiguration: { Mode: 'USER_PROVISIONED', Iops: '6000' },
        },
      },
      { ...LUSTRE_PROPS }
    );

    const [update] = callsOf(UpdateFileSystemCommand);
    expect(update.input).toEqual({
      FileSystemId: FS_ID,
      StorageType: 'INTELLIGENT_TIERING',
      FileSystemTypeVersion: '2.15',
      NetworkType: 'DUAL_STACK',
      LustreConfiguration: {
        MetadataConfiguration: { Mode: 'USER_PROVISIONED', Iops: 6000 },
      },
    });
  });

  it('sends StorageCapacity growth as a number', async () => {
    routeSend({
      UpdateFileSystemCommand: {},
      DescribeFileSystemsCommand: { FileSystems: [availableFs()] },
    });

    const result = await newProvider().update(
      'MyFs',
      FS_ID,
      RESOURCE_TYPE,
      { ...LUSTRE_PROPS, StorageCapacity: '2400' },
      { ...LUSTRE_PROPS }
    );

    expect(result).toMatchObject({ physicalId: FS_ID, wasReplaced: false });
    const [update] = callsOf(UpdateFileSystemCommand);
    expect(update.input).toEqual({ FileSystemId: FS_ID, StorageCapacity: 2400 });
  });

  it('rejects a changed createOnly top-level property (SubnetIds) without calling AWS', async () => {
    await expect(
      newProvider().update(
        'MyFs',
        FS_ID,
        RESOURCE_TYPE,
        { ...LUSTRE_PROPS, SubnetIds: ['subnet-999'] },
        { ...LUSTRE_PROPS }
      )
    ).rejects.toThrow(ResourceUpdateNotSupportedError);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('rejects an ADDED createOnly property (undefined -> defined KmsKeyId) without calling AWS', async () => {
    await expect(
      newProvider().update(
        'MyFs',
        FS_ID,
        RESOURCE_TYPE,
        { ...LUSTRE_PROPS, KmsKeyId: 'arn:aws:kms:us-east-1:123456789012:key/abc' },
        { ...LUSTRE_PROPS }
      )
    ).rejects.toThrow(ResourceUpdateNotSupportedError);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('rejects a changed immutable Lustre sub-property (DeploymentType) without calling AWS', async () => {
    await expect(
      newProvider().update(
        'MyFs',
        FS_ID,
        RESOURCE_TYPE,
        { ...LUSTRE_PROPS, LustreConfiguration: { DeploymentType: 'PERSISTENT_2' } },
        { ...LUSTRE_PROPS }
      )
    ).rejects.toThrow(/LustreConfiguration\.DeploymentType is immutable/);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('applies a Tags-only diff via TagResource/UntagResource without UpdateFileSystem', async () => {
    routeSend({
      DescribeFileSystemsCommand: { FileSystems: [availableFs()] },
      TagResourceCommand: {},
      UntagResourceCommand: {},
    });

    await newProvider().update(
      'MyFs',
      FS_ID,
      RESOURCE_TYPE,
      { ...LUSTRE_PROPS, Tags: [{ Key: 'team', Value: 'infra' }] },
      { ...LUSTRE_PROPS }
    );

    expect(callsOf(UpdateFileSystemCommand)).toHaveLength(0);
    const [tag] = callsOf(TagResourceCommand);
    expect(tag.input).toEqual({
      ResourceARN: FS_ARN,
      Tags: [{ Key: 'team', Value: 'infra' }],
    });
    const [untag] = callsOf(UntagResourceCommand);
    expect(untag.input).toEqual({ ResourceARN: FS_ARN, TagKeys: ['env'] });
  });

  it('is a silent no-op when there is no mutable diff', async () => {
    const result = await newProvider().update(
      'MyFs',
      FS_ID,
      RESOURCE_TYPE,
      { ...LUSTRE_PROPS },
      { ...LUSTRE_PROPS }
    );
    expect(result).toEqual({ physicalId: FS_ID, wasReplaced: false });
    expect(mockSend).not.toHaveBeenCalled();
  });
});

describe('FSxFileSystemProvider delete', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sends DeleteFileSystem and polls until the file system is gone', async () => {
    routeSend({
      DeleteFileSystemCommand: { FileSystemId: FS_ID, Lifecycle: 'DELETING' },
      DescribeFileSystemsCommand: [
        { FileSystems: [{ FileSystemId: FS_ID, Lifecycle: 'DELETING' }] },
        notFound(),
      ],
    });

    await newProvider().delete('MyFs', FS_ID, RESOURCE_TYPE);

    expect(callsOf(DeleteFileSystemCommand)).toHaveLength(1);
    expect(callsOf(DescribeFileSystemsCommand).length).toBeGreaterThanOrEqual(2);
  });

  it('treats an empty Describe response as deleted', async () => {
    routeSend({
      DeleteFileSystemCommand: {},
      DescribeFileSystemsCommand: { FileSystems: [] },
    });

    await expect(newProvider().delete('MyFs', FS_ID, RESOURCE_TYPE)).resolves.toBeUndefined();
  });

  it('is idempotent when the file system is already gone (region matches)', async () => {
    routeSend({ DeleteFileSystemCommand: notFound() });

    await expect(
      newProvider().delete('MyFs', FS_ID, RESOURCE_TYPE, undefined, {
        expectedRegion: 'us-east-1',
      })
    ).resolves.toBeUndefined();
  });

  it('refuses NotFound-as-success when the client region does not match the state region', async () => {
    routeSend({ DeleteFileSystemCommand: notFound() });

    await expect(
      newProvider().delete('MyFs', FS_ID, RESOURCE_TYPE, undefined, {
        expectedRegion: 'us-west-2',
      })
    ).rejects.toThrow(ProvisioningError);
  });

  it('hard-fails when the deletion wait times out', async () => {
    routeSend({
      DeleteFileSystemCommand: {},
      DescribeFileSystemsCommand: {
        FileSystems: [{ FileSystemId: FS_ID, Lifecycle: 'DELETING' }],
      },
    });

    await expect(
      newProvider({ maxWaitMs: 25 }).delete('MyFs', FS_ID, RESOURCE_TYPE)
    ).rejects.toThrow(/Timed out waiting for FSx FileSystem .* deletion/);
  });

  it('hard-fails when deletion transitions to FAILED', async () => {
    routeSend({
      DeleteFileSystemCommand: {},
      DescribeFileSystemsCommand: {
        FileSystems: [
          { FileSystemId: FS_ID, Lifecycle: 'FAILED', FailureDetails: { Message: 'stuck' } },
        ],
      },
    });

    await expect(newProvider().delete('MyFs', FS_ID, RESOURCE_TYPE)).rejects.toThrow(
      /FAILED during deletion: stuck/
    );
  });
});

describe('FSxFileSystemProvider getAttribute', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the physicalId for Id/FileSystemId without an SDK call', async () => {
    const provider = newProvider();
    await expect(provider.getAttribute(FS_ID, RESOURCE_TYPE, 'Id')).resolves.toBe(FS_ID);
    await expect(provider.getAttribute(FS_ID, RESOURCE_TYPE, 'FileSystemId')).resolves.toBe(FS_ID);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('resolves DNSName / LustreMountName / ResourceARN via DescribeFileSystems', async () => {
    routeSend({ DescribeFileSystemsCommand: { FileSystems: [availableFs()] } });

    const provider = newProvider();
    await expect(provider.getAttribute(FS_ID, RESOURCE_TYPE, 'DNSName')).resolves.toBe(DNS_NAME);
    await expect(provider.getAttribute(FS_ID, RESOURCE_TYPE, 'LustreMountName')).resolves.toBe(
      MOUNT_NAME
    );
    await expect(provider.getAttribute(FS_ID, RESOURCE_TYPE, 'ResourceARN')).resolves.toBe(FS_ARN);
  });

  it('returns undefined for unknown attributes', async () => {
    routeSend({ DescribeFileSystemsCommand: { FileSystems: [availableFs()] } });
    await expect(
      newProvider().getAttribute(FS_ID, RESOURCE_TYPE, 'NoSuchAttr')
    ).resolves.toBeUndefined();
  });
});

describe('FSxFileSystemProvider readCurrentState', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('maps the Describe response back to CFn shape incl. DataRepositoryConfiguration flattening', async () => {
    routeSend({
      DescribeFileSystemsCommand: {
        FileSystems: [
          availableFs({
            FileSystemType: 'LUSTRE',
            StorageCapacity: 1200,
            SubnetIds: ['subnet-111'],
            Tags: [
              { Key: 'env', Value: 'test' },
              { Key: 'aws:cdk:path', Value: 'Stack/Fs/Resource' },
            ],
            LustreConfiguration: {
              MountName: MOUNT_NAME,
              DeploymentType: 'SCRATCH_2',
              DataCompressionType: 'NONE',
              DataRepositoryConfiguration: {
                ImportPath: 's3://bucket/prefix',
                AutoImportPolicy: 'NEW',
                ImportedFileChunkSize: 1024,
              },
            },
          }),
        ],
      },
    });

    const state = await newProvider().readCurrentState(FS_ID, 'MyFs', RESOURCE_TYPE);

    expect(state).toMatchObject({
      FileSystemType: 'LUSTRE',
      StorageCapacity: 1200,
      SubnetIds: ['subnet-111'],
      LustreConfiguration: {
        DeploymentType: 'SCRATCH_2',
        DataCompressionType: 'NONE',
        ImportPath: 's3://bucket/prefix',
        AutoImportPolicy: 'NEW',
        ImportedFileChunkSize: 1024,
      },
      Tags: [{ Key: 'env', Value: 'test' }],
    });
    // MountName is a read-only attribute, not a CFn input property.
    expect((state?.['LustreConfiguration'] as Record<string, unknown>)['MountName']).toBeUndefined();
  });

  it('returns undefined when the file system is gone', async () => {
    routeSend({ DescribeFileSystemsCommand: notFound() });
    await expect(
      newProvider().readCurrentState(FS_ID, 'MyFs', RESOURCE_TYPE)
    ).resolves.toBeUndefined();
  });

  it('declares only the individually-unreadable leaves as drift-unknown (not whole variant blocks)', () => {
    expect(newProvider().getDriftUnknownPaths(RESOURCE_TYPE)).toEqual([
      'SecurityGroupIds',
      'BackupId',
      'WindowsConfiguration.SelfManagedActiveDirectoryConfiguration.Password',
      'OntapConfiguration.FsxAdminPassword',
      'OpenZFSConfiguration.RootVolumeConfiguration',
    ]);
    expect(newProvider().getDriftUnknownPaths('AWS::S3::Bucket')).toEqual([]);
  });
});

describe('FSxFileSystemProvider readCurrentState variant blocks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reverse-maps WindowsConfiguration, flattening Aliases to a name list', async () => {
    routeSend({
      DescribeFileSystemsCommand: {
        FileSystems: [
          {
            FileSystemId: FS_ID,
            Lifecycle: 'AVAILABLE',
            FileSystemType: 'WINDOWS',
            StorageCapacity: 32,
            SubnetIds: ['subnet-111'],
            WindowsConfiguration: {
              ActiveDirectoryId: 'd-1234567890',
              DeploymentType: 'MULTI_AZ_1',
              PreferredSubnetId: 'subnet-111',
              ThroughputCapacity: 32,
              WeeklyMaintenanceStartTime: '1:05:00',
              CopyTagsToBackups: true,
              Aliases: [
                { Name: 'files.example.com', Lifecycle: 'AVAILABLE' },
                { Name: 'share.example.com', Lifecycle: 'CREATING' },
              ],
              AuditLogConfiguration: {
                FileAccessAuditLogLevel: 'SUCCESS_ONLY',
                FileShareAccessAuditLogLevel: 'FAILURE_ONLY',
                AuditLogDestination: 'arn:aws:logs:us-east-1:123456789012:log-group:/aws/fsx/x',
              },
              DiskIopsConfiguration: { Mode: 'USER_PROVISIONED', Iops: 3000 },
              FsrmConfiguration: { FsrmServiceEnabled: true },
              SelfManagedActiveDirectoryConfiguration: {
                DomainName: 'corp.example.com',
                UserName: 'Admin',
                DnsIps: ['10.0.0.1'],
              },
              // Read-only fields that are not CFn inputs.
              RemoteAdministrationEndpoint: 'amznfsx.corp.example.com',
              PreferredFileServerIp: '10.0.0.9',
              MaintenanceOperationsInProgress: ['PATCHING'],
            },
          },
        ],
      },
    });

    const state = await newProvider().readCurrentState(FS_ID, 'MyFs', RESOURCE_TYPE);
    const windows = state?.['WindowsConfiguration'] as Record<string, unknown>;

    expect(windows).toMatchObject({
      ActiveDirectoryId: 'd-1234567890',
      DeploymentType: 'MULTI_AZ_1',
      ThroughputCapacity: 32,
      CopyTagsToBackups: true,
      Aliases: ['files.example.com', 'share.example.com'],
      AuditLogConfiguration: {
        FileAccessAuditLogLevel: 'SUCCESS_ONLY',
        FileShareAccessAuditLogLevel: 'FAILURE_ONLY',
      },
      DiskIopsConfiguration: { Mode: 'USER_PROVISIONED', Iops: 3000 },
      FsrmConfiguration: { FsrmServiceEnabled: true },
      SelfManagedActiveDirectoryConfiguration: { DomainName: 'corp.example.com', UserName: 'Admin' },
    });
    // Read-only API fields must not leak in as phantom CFn properties.
    expect(windows['RemoteAdministrationEndpoint']).toBeUndefined();
    expect(windows['PreferredFileServerIp']).toBeUndefined();
    expect(windows['MaintenanceOperationsInProgress']).toBeUndefined();
    // Write-only credential is never returned by AWS.
    expect(
      (windows['SelfManagedActiveDirectoryConfiguration'] as Record<string, unknown>)['Password']
    ).toBeUndefined();
    // Sibling variant blocks stay absent.
    expect(state?.['OntapConfiguration']).toBeUndefined();
    expect(state?.['OpenZFSConfiguration']).toBeUndefined();
  });

  it('reverse-maps OntapConfiguration without the read-only Endpoints block', async () => {
    routeSend({
      DescribeFileSystemsCommand: {
        FileSystems: [
          {
            FileSystemId: FS_ID,
            Lifecycle: 'AVAILABLE',
            FileSystemType: 'ONTAP',
            StorageCapacity: 1024,
            SubnetIds: ['subnet-111', 'subnet-222'],
            OntapConfiguration: {
              DeploymentType: 'MULTI_AZ_1',
              ThroughputCapacity: 128,
              ThroughputCapacityPerHAPair: 128,
              HAPairs: 1,
              PreferredSubnetId: 'subnet-111',
              RouteTableIds: ['rtb-aaa', 'rtb-bbb'],
              EndpointIpAddressRange: '198.19.0.0/24',
              // Modeled AND returned by DescribeFileSystems — must be
              // reverse-mapped, not declared drift-unknown.
              EndpointIpv6AddressRange: 'fd00:ec2::/64',
              DiskIopsConfiguration: { Mode: 'AUTOMATIC', Iops: 3072 },
              Endpoints: { Management: { DNSName: 'management.example.com' } },
            },
          },
        ],
      },
    });

    const state = await newProvider().readCurrentState(FS_ID, 'MyFs', RESOURCE_TYPE);
    const ontap = state?.['OntapConfiguration'] as Record<string, unknown>;

    expect(ontap).toEqual({
      DeploymentType: 'MULTI_AZ_1',
      ThroughputCapacity: 128,
      ThroughputCapacityPerHAPair: 128,
      HAPairs: 1,
      PreferredSubnetId: 'subnet-111',
      RouteTableIds: ['rtb-aaa', 'rtb-bbb'],
      EndpointIpAddressRange: '198.19.0.0/24',
      EndpointIpv6AddressRange: 'fd00:ec2::/64',
      DiskIopsConfiguration: { Mode: 'AUTOMATIC', Iops: 3072 },
    });
  });

  it('reverse-maps OpenZFSConfiguration without RootVolumeId / EndpointIpAddress', async () => {
    routeSend({
      DescribeFileSystemsCommand: {
        FileSystems: [
          {
            FileSystemId: FS_ID,
            Lifecycle: 'AVAILABLE',
            FileSystemType: 'OPENZFS',
            StorageCapacity: 64,
            SubnetIds: ['subnet-111'],
            OpenZFSConfiguration: {
              DeploymentType: 'SINGLE_AZ_1',
              ThroughputCapacity: 64,
              CopyTagsToBackups: false,
              CopyTagsToVolumes: true,
              DiskIopsConfiguration: { Mode: 'AUTOMATIC' },
              ReadCacheConfiguration: { SizingMode: 'USER_PROVISIONED', SizeGiB: 128 },
              EndpointIpv6AddressRange: 'fd00:ec2::/64',
              RootVolumeId: 'fsvol-0123456789abcdef0',
              EndpointIpAddress: '10.0.0.5',
            },
          },
        ],
      },
    });

    const state = await newProvider().readCurrentState(FS_ID, 'MyFs', RESOURCE_TYPE);
    const openzfs = state?.['OpenZFSConfiguration'] as Record<string, unknown>;

    expect(openzfs).toEqual({
      DeploymentType: 'SINGLE_AZ_1',
      ThroughputCapacity: 64,
      CopyTagsToBackups: false,
      CopyTagsToVolumes: true,
      DiskIopsConfiguration: { Mode: 'AUTOMATIC' },
      ReadCacheConfiguration: { SizingMode: 'USER_PROVISIONED', SizeGiB: 128 },
      EndpointIpv6AddressRange: 'fd00:ec2::/64',
    });
    // RootVolumeConfiguration lives on the volume — never synthesized here.
    expect(openzfs['RootVolumeConfiguration']).toBeUndefined();
  });

  // Mandatory round-trip guard (docs/provider-development.md §3b): `cdkd drift
  // --revert` feeds a readCurrentState snapshot back through update(). Only the
  // variant block matching FileSystemType is ever emitted, so the Class 1
  // type-discriminator hazard cannot fire; this pins that contract.
  it('round-trip: an unchanged variant snapshot replays through update() with no AWS call', async () => {
    const observedFs = {
      FileSystemId: FS_ID,
      Lifecycle: 'AVAILABLE',
      FileSystemType: 'OPENZFS',
      StorageCapacity: 64,
      SubnetIds: ['subnet-111'],
      OpenZFSConfiguration: {
        DeploymentType: 'SINGLE_AZ_1',
        ThroughputCapacity: 64,
        DiskIopsConfiguration: { Mode: 'AUTOMATIC' },
        RootVolumeId: 'fsvol-0123456789abcdef0',
      },
    };
    routeSend({ DescribeFileSystemsCommand: { FileSystems: [observedFs] } });

    const observed = await newProvider().readCurrentState(FS_ID, 'MyFs', RESOURCE_TYPE);
    expect(observed).toBeDefined();

    vi.clearAllMocks();
    routeSend({
      UpdateFileSystemCommand: {},
      DescribeFileSystemsCommand: { FileSystems: [availableFs()] },
    });

    // Replaying the snapshot against itself is a no-op: no immutable-property
    // rejection, and no empty UpdateFileSystem call.
    const result = await newProvider().update(
      'MyFs',
      FS_ID,
      RESOURCE_TYPE,
      { ...observed },
      { ...observed }
    );
    expect(result).toEqual({ physicalId: FS_ID, wasReplaced: false });
    expect(callsOf(UpdateFileSystemCommand)).toHaveLength(0);
  });

  it('round-trip: a mutable-only variant drift replays as a real UpdateFileSystem', async () => {
    const state = {
      FileSystemType: 'OPENZFS',
      StorageCapacity: 64,
      SubnetIds: ['subnet-111'],
      OpenZFSConfiguration: { DeploymentType: 'SINGLE_AZ_1', ThroughputCapacity: 64 },
    };
    routeSend({
      DescribeFileSystemsCommand: {
        FileSystems: [
          {
            FileSystemId: FS_ID,
            Lifecycle: 'AVAILABLE',
            FileSystemType: 'OPENZFS',
            StorageCapacity: 64,
            SubnetIds: ['subnet-111'],
            // Console-side change to a MUTABLE sub-property.
            OpenZFSConfiguration: { DeploymentType: 'SINGLE_AZ_1', ThroughputCapacity: 128 },
          },
        ],
      },
    });

    const observed = await newProvider().readCurrentState(FS_ID, 'MyFs', RESOURCE_TYPE);

    vi.clearAllMocks();
    routeSend({
      UpdateFileSystemCommand: {},
      DescribeFileSystemsCommand: { FileSystems: [availableFs()] },
    });

    // Reverting pushes the state value back over the observed one.
    await newProvider().update('MyFs', FS_ID, RESOURCE_TYPE, state, { ...observed });

    const [update] = callsOf(UpdateFileSystemCommand);
    expect(update.input).toEqual({
      FileSystemId: FS_ID,
      OpenZFSConfiguration: { ThroughputCapacity: 64 },
    });
  });

  // Windows exercises a different arm than OpenZFS: its snapshot carries
  // nested AD / Audit / Fsrm blocks and immutable scalars (ActiveDirectoryId,
  // DeploymentType, PreferredSubnetId) that update() immutability-checks.
  it('round-trip: an unchanged WINDOWS snapshot replays through update() with no AWS call', async () => {
    routeSend({
      DescribeFileSystemsCommand: {
        FileSystems: [
          {
            FileSystemId: FS_ID,
            Lifecycle: 'AVAILABLE',
            FileSystemType: 'WINDOWS',
            StorageCapacity: 32,
            SubnetIds: ['subnet-111'],
            WindowsConfiguration: {
              ActiveDirectoryId: 'd-1234567890',
              DeploymentType: 'MULTI_AZ_1',
              PreferredSubnetId: 'subnet-111',
              ThroughputCapacity: 32,
              WeeklyMaintenanceStartTime: '1:05:00',
              Aliases: [{ Name: 'files.example.com', Lifecycle: 'AVAILABLE' }],
              AuditLogConfiguration: {
                FileAccessAuditLogLevel: 'SUCCESS_ONLY',
                FileShareAccessAuditLogLevel: 'FAILURE_ONLY',
              },
              DiskIopsConfiguration: { Mode: 'AUTOMATIC' },
              FsrmConfiguration: { FsrmServiceEnabled: true },
            },
          },
        ],
      },
    });

    const observed = await newProvider().readCurrentState(FS_ID, 'MyFs', RESOURCE_TYPE);
    expect(observed?.['WindowsConfiguration']).toBeDefined();

    vi.clearAllMocks();
    routeSend({
      UpdateFileSystemCommand: {},
      DescribeFileSystemsCommand: { FileSystems: [availableFs()] },
    });

    const result = await newProvider().update(
      'MyFs',
      FS_ID,
      RESOURCE_TYPE,
      { ...observed },
      { ...observed }
    );
    expect(result).toEqual({ physicalId: FS_ID, wasReplaced: false });
    expect(callsOf(UpdateFileSystemCommand)).toHaveLength(0);
  });

  // docs/provider-development.md §3b Class 2: a nested sub-block AWS returns
  // only partially populated (AUTOMATIC mode omits Iops) must still be a legal
  // UpdateFileSystem input when --revert pushes the state values back.
  it('round-trip: a partially-populated nested DiskIopsConfiguration reverts without an invalid input', async () => {
    routeSend({
      DescribeFileSystemsCommand: {
        FileSystems: [
          {
            FileSystemId: FS_ID,
            Lifecycle: 'AVAILABLE',
            FileSystemType: 'OPENZFS',
            SubnetIds: ['subnet-111'],
            OpenZFSConfiguration: {
              DeploymentType: 'SINGLE_AZ_1',
              ThroughputCapacity: 64,
              // AWS switched the volume to AUTOMATIC and omits Iops entirely.
              DiskIopsConfiguration: { Mode: 'AUTOMATIC' },
            },
          },
        ],
      },
    });

    const observed = await newProvider().readCurrentState(FS_ID, 'MyFs', RESOURCE_TYPE);
    expect(observed?.['OpenZFSConfiguration']).toMatchObject({
      DiskIopsConfiguration: { Mode: 'AUTOMATIC' },
    });
    // The partial block must not carry an explicit Iops: undefined key.
    expect(
      Object.keys(
        (observed?.['OpenZFSConfiguration'] as Record<string, Record<string, unknown>>)[
          'DiskIopsConfiguration'
        ]
      )
    ).toEqual(['Mode']);

    vi.clearAllMocks();
    routeSend({
      UpdateFileSystemCommand: {},
      DescribeFileSystemsCommand: { FileSystems: [availableFs()] },
    });

    // Revert: push the state's USER_PROVISIONED/4000 back over AWS's AUTOMATIC.
    const state = {
      FileSystemType: 'OPENZFS',
      SubnetIds: ['subnet-111'],
      OpenZFSConfiguration: {
        DeploymentType: 'SINGLE_AZ_1',
        ThroughputCapacity: 64,
        DiskIopsConfiguration: { Mode: 'USER_PROVISIONED', Iops: 4000 },
      },
    };
    await newProvider().update('MyFs', FS_ID, RESOURCE_TYPE, state, { ...observed });

    const [update] = callsOf(UpdateFileSystemCommand);
    expect(update.input).toEqual({
      FileSystemId: FS_ID,
      OpenZFSConfiguration: {
        DiskIopsConfiguration: { Mode: 'USER_PROVISIONED', Iops: 4000 },
      },
    });
  });

  it('omits a variant block entirely when AWS returns it empty', async () => {
    routeSend({
      DescribeFileSystemsCommand: {
        FileSystems: [
          { FileSystemId: FS_ID, Lifecycle: 'AVAILABLE', FileSystemType: 'ONTAP', OntapConfiguration: {} },
        ],
      },
    });

    const state = await newProvider().readCurrentState(FS_ID, 'MyFs', RESOURCE_TYPE);
    expect(state).not.toHaveProperty('OntapConfiguration');
  });
});

/**
 * A plausible changed value per mutable sub-property, used to drive every
 * declared-mutable key through its variant's `apply*UpdateField` switch.
 */
const SUBPROP_SAMPLE_VALUE: Record<string, unknown> = {
  WeeklyMaintenanceStartTime: '1:05:00',
  DailyAutomaticBackupStartTime: '02:00',
  AutomaticBackupRetentionDays: 7,
  AutoImportPolicy: 'NEW',
  DataCompressionType: 'LZ4',
  PerUnitStorageThroughput: 125,
  MetadataConfiguration: { Mode: 'USER_PROVISIONED', Iops: 6000 },
  DataReadCacheConfiguration: { SizingMode: 'USER_PROVISIONED', SizeGiB: 128 },
  ThroughputCapacity: 256,
  ThroughputCapacityPerHAPair: 256,
  HAPairs: 2,
  SelfManagedActiveDirectoryConfiguration: { UserName: 'Admin', Password: 'S3cret!' },
  AuditLogConfiguration: { FileAccessAuditLogLevel: 'SUCCESS_ONLY' },
  DiskIopsConfiguration: { Mode: 'USER_PROVISIONED', Iops: 4000 },
  FsrmConfiguration: { FsrmServiceEnabled: true },
  FsxAdminPassword: 'S3cret!',
  RouteTableIds: ['rtb-zzz'],
  EndpointIpv6AddressRange: 'fd00::/64',
  CopyTagsToBackups: true,
  CopyTagsToVolumes: true,
  ReadCacheConfiguration: { SizingMode: 'USER_PROVISIONED', SizeGiB: 128 },
};

const VARIANT_FILE_SYSTEM_TYPE: Record<string, string> = {
  LustreConfiguration: 'LUSTRE',
  WindowsConfiguration: 'WINDOWS',
  OntapConfiguration: 'ONTAP',
  OpenZFSConfiguration: 'OPENZFS',
};

describe('FSxFileSystemProvider apply*UpdateField default guard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // Guards the silent-no-op bug class: a sub-property added to a
  // *_MUTABLE_SUBPROPS set without a matching switch case would pass the
  // mutability check, map to nothing, and issue an empty UpdateFileSystem.
  for (const [configKey, subprops] of Object.entries(VARIANT_MUTABLE_SUBPROPS)) {
    for (const key of subprops) {
      it(`maps ${configKey}.${key} to an UpdateFileSystem field`, async () => {
        routeSend({
          UpdateFileSystemCommand: {},
          DescribeFileSystemsCommand: { FileSystems: [availableFs()] },
        });

        expect(SUBPROP_SAMPLE_VALUE).toHaveProperty(key);
        const base = { FileSystemType: VARIANT_FILE_SYSTEM_TYPE[configKey], [configKey]: {} };

        await newProvider().update(
          'MyFs',
          FS_ID,
          RESOURCE_TYPE,
          { ...base, [configKey]: { [key]: SUBPROP_SAMPLE_VALUE[key] } },
          base
        );

        const [update] = callsOf(UpdateFileSystemCommand);
        expect(update).toBeDefined();
        // The mapped diff must be non-empty — an empty variant block is the
        // exact silent no-op the default guard exists to prevent.
        expect(Object.keys(update.input[configKey] as Record<string, unknown>)).not.toHaveLength(0);
      });
    }
  }

  it('throws a reportable error when a mutable sub-property has no mapping', async () => {
    const fakeKey = 'NotMappedSubprop';
    const windows = VARIANT_MUTABLE_SUBPROPS['WindowsConfiguration'] as Set<string>;
    windows.add(fakeKey);
    try {
      routeSend({
        UpdateFileSystemCommand: {},
        DescribeFileSystemsCommand: { FileSystems: [availableFs()] },
      });

      const base = { FileSystemType: 'WINDOWS', WindowsConfiguration: {} };
      await expect(
        newProvider().update(
          'MyFs',
          FS_ID,
          RESOURCE_TYPE,
          { ...base, WindowsConfiguration: { [fakeKey]: 'x' } },
          base
        )
      ).rejects.toThrow(
        /WindowsConfiguration\.NotMappedSubprop is declared mutable but has no UpdateFileSystem mapping/
      );
      expect(callsOf(UpdateFileSystemCommand)).toHaveLength(0);
    } finally {
      windows.delete(fakeKey);
    }
  });
});

describe('FSxFileSystemProvider nested sub-block update arms', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reconciles a Windows AuditLogConfiguration change into the create-shaped block', async () => {
    routeSend({
      UpdateFileSystemCommand: {},
      DescribeFileSystemsCommand: { FileSystems: [availableFs()] },
    });

    const prev = {
      ...WINDOWS_PROPS,
      WindowsConfiguration: {
        ...WINDOWS_PROPS.WindowsConfiguration,
        AuditLogConfiguration: {
          FileAccessAuditLogLevel: 'DISABLED',
          FileShareAccessAuditLogLevel: 'DISABLED',
        },
      },
    };

    await newProvider().update('MyFs', FS_ID, RESOURCE_TYPE, {
      ...prev,
      WindowsConfiguration: {
        ...prev.WindowsConfiguration,
        AuditLogConfiguration: {
          FileAccessAuditLogLevel: 'SUCCESS_ONLY',
          FileShareAccessAuditLogLevel: 'FAILURE_ONLY',
          AuditLogDestination: 'arn:aws:logs:us-east-1:123456789012:log-group:/aws/fsx/audit',
        },
      },
    }, prev);

    const [update] = callsOf(UpdateFileSystemCommand);
    expect(update.input).toEqual({
      FileSystemId: FS_ID,
      WindowsConfiguration: {
        AuditLogConfiguration: {
          FileAccessAuditLogLevel: 'SUCCESS_ONLY',
          FileShareAccessAuditLogLevel: 'FAILURE_ONLY',
          AuditLogDestination: 'arn:aws:logs:us-east-1:123456789012:log-group:/aws/fsx/audit',
        },
      },
    });
  });

  it('coerces a stringified Iops in a Windows DiskIopsConfiguration change', async () => {
    routeSend({
      UpdateFileSystemCommand: {},
      DescribeFileSystemsCommand: { FileSystems: [availableFs()] },
    });

    const prev = {
      ...WINDOWS_PROPS,
      WindowsConfiguration: {
        ...WINDOWS_PROPS.WindowsConfiguration,
        DiskIopsConfiguration: { Mode: 'AUTOMATIC' },
      },
    };

    await newProvider().update('MyFs', FS_ID, RESOURCE_TYPE, {
      ...prev,
      WindowsConfiguration: {
        ...prev.WindowsConfiguration,
        DiskIopsConfiguration: { Mode: 'USER_PROVISIONED', Iops: '4000' },
      },
    }, prev);

    const [update] = callsOf(UpdateFileSystemCommand);
    expect(update.input).toEqual({
      FileSystemId: FS_ID,
      WindowsConfiguration: {
        DiskIopsConfiguration: { Mode: 'USER_PROVISIONED', Iops: 4000 },
      },
    });
  });

  it('reconciles an ONTAP DiskIopsConfiguration change independently of RouteTableIds', async () => {
    routeSend({
      UpdateFileSystemCommand: {},
      DescribeFileSystemsCommand: { FileSystems: [availableFs()] },
    });

    await newProvider().update('MyFs', FS_ID, RESOURCE_TYPE, {
      ...ONTAP_PROPS,
      OntapConfiguration: {
        ...ONTAP_PROPS.OntapConfiguration,
        DiskIopsConfiguration: { Mode: 'USER_PROVISIONED', Iops: 5000 },
      },
    }, { ...ONTAP_PROPS });

    const [update] = callsOf(UpdateFileSystemCommand);
    expect(update.input).toEqual({
      FileSystemId: FS_ID,
      OntapConfiguration: {
        DiskIopsConfiguration: { Mode: 'USER_PROVISIONED', Iops: 5000 },
      },
    });
    // RouteTableIds unchanged — no Add/Remove keys emitted.
    expect(update.input['OntapConfiguration']).not.toHaveProperty('AddRouteTableIds');
    expect(update.input['OntapConfiguration']).not.toHaveProperty('RemoveRouteTableIds');
  });

  it('drops a nested sub-block to undefined when it is removed from the template', async () => {
    routeSend({
      UpdateFileSystemCommand: {},
      DescribeFileSystemsCommand: { FileSystems: [availableFs()] },
    });

    const prev = {
      ...WINDOWS_PROPS,
      WindowsConfiguration: {
        ...WINDOWS_PROPS.WindowsConfiguration,
        FsrmConfiguration: { FsrmServiceEnabled: true },
      },
    };

    await newProvider().update(
      'MyFs',
      FS_ID,
      RESOURCE_TYPE,
      { ...prev, WindowsConfiguration: { ...WINDOWS_PROPS.WindowsConfiguration } },
      prev
    );

    const [update] = callsOf(UpdateFileSystemCommand);
    expect(update.input).toEqual({
      FileSystemId: FS_ID,
      WindowsConfiguration: { FsrmConfiguration: undefined },
    });
  });
});

describe('FSxFileSystemProvider import', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('verifies a knownPhysicalId via DescribeFileSystems', async () => {
    routeSend({ DescribeFileSystemsCommand: { FileSystems: [availableFs()] } });

    const result = await newProvider().import({
      logicalId: 'MyFs',
      resourceType: RESOURCE_TYPE,
      cdkPath: 'Stack/Fs/Resource',
      stackName: 'Stack',
      region: 'us-east-1',
      properties: {},
      knownPhysicalId: FS_ID,
    });

    expect(result?.physicalId).toBe(FS_ID);
    expect(result?.attributes).toMatchObject({ ResourceARN: FS_ARN });
  });

  it('returns null for a knownPhysicalId that does not exist', async () => {
    routeSend({ DescribeFileSystemsCommand: notFound() });

    await expect(
      newProvider().import({
        logicalId: 'MyFs',
        resourceType: RESOURCE_TYPE,
        cdkPath: 'Stack/Fs/Resource',
        stackName: 'Stack',
        region: 'us-east-1',
        properties: {},
        knownPhysicalId: FS_ID,
      })
    ).resolves.toBeNull();
  });

  it('finds a file system by aws:cdk:path tag across pagination', async () => {
    routeSend({
      DescribeFileSystemsCommand: [
        {
          FileSystems: [{ FileSystemId: 'fs-other', Tags: [] }],
          NextToken: 'page2',
        },
        {
          FileSystems: [
            availableFs({ Tags: [{ Key: 'aws:cdk:path', Value: 'Stack/Fs/Resource' }] }),
          ],
        },
      ],
    });

    const result = await newProvider().import({
      logicalId: 'MyFs',
      resourceType: RESOURCE_TYPE,
      cdkPath: 'Stack/Fs/Resource',
      stackName: 'Stack',
      region: 'us-east-1',
      properties: {},
    });

    expect(result?.physicalId).toBe(FS_ID);
    // The second page request must forward the first page's NextToken —
    // without this assertion a broken pagination loop would still pass
    // (page 2 is served regardless of input by the mock queue).
    const describes = callsOf(DescribeFileSystemsCommand);
    expect(describes).toHaveLength(2);
    expect(describes[1].input['NextToken']).toBe('page2');
  });

  it('returns null when neither an id nor a matching tag is found', async () => {
    routeSend({ DescribeFileSystemsCommand: { FileSystems: [] } });

    await expect(
      newProvider().import({
        logicalId: 'MyFs',
        resourceType: RESOURCE_TYPE,
        cdkPath: 'Stack/Fs/Resource',
        stackName: 'Stack',
        region: 'us-east-1',
        properties: {},
      })
    ).resolves.toBeNull();
  });
});

describe('FSxFileSystemProvider timeout self-report', () => {
  it('reports the polling ceiling via getMinResourceTimeoutMs (default 1h)', () => {
    expect(new FSxFileSystemProvider().getMinResourceTimeoutMs()).toBe(60 * 60 * 1000);
    expect(newProvider({ maxWaitMs: 123 }).getMinResourceTimeoutMs()).toBe(123);
  });
});

// ─── Windows / ONTAP / OpenZFS variants (issue #1068) ─────────────────

describe('FSxFileSystemProvider WINDOWS variant', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sends CreateFileSystem with FileSystemType WINDOWS and the mapped WindowsConfiguration', async () => {
    routeSend({
      CreateFileSystemCommand: { FileSystem: { FileSystemId: FS_ID } },
      DescribeFileSystemsCommand: { FileSystems: [availableFs()] },
    });

    await newProvider().create('MyFs', RESOURCE_TYPE, {
      ...WINDOWS_PROPS,
      WindowsConfiguration: {
        ...WINDOWS_PROPS.WindowsConfiguration,
        ThroughputCapacity: '32',
        AutomaticBackupRetentionDays: '7',
        CopyTagsToBackups: 'true',
        SelfManagedActiveDirectoryConfiguration: {
          DomainName: 'corp.example.com',
          DnsIps: ['10.0.0.1', '10.0.0.2'],
          UserName: 'Admin',
          Password: 'secret',
        },
        AuditLogConfiguration: {
          FileAccessAuditLogLevel: 'SUCCESS_AND_FAILURE',
          FileShareAccessAuditLogLevel: 'FAILURE_ONLY',
        },
      },
    });

    const [create] = callsOf(CreateFileSystemCommand);
    expect(create.input['FileSystemType']).toBe('WINDOWS');
    expect(create.input['WindowsConfiguration']).toMatchObject({
      ActiveDirectoryId: 'd-1234567890',
      DeploymentType: 'MULTI_AZ_1',
      ThroughputCapacity: 32,
      AutomaticBackupRetentionDays: 7,
      CopyTagsToBackups: true,
      SelfManagedActiveDirectoryConfiguration: {
        DomainName: 'corp.example.com',
        DnsIps: ['10.0.0.1', '10.0.0.2'],
      },
      AuditLogConfiguration: {
        FileAccessAuditLogLevel: 'SUCCESS_AND_FAILURE',
        FileShareAccessAuditLogLevel: 'FAILURE_ONLY',
      },
    });
    // No sibling variant blocks leak onto the create call.
    expect(create.input['OntapConfiguration']).toBeUndefined();
    expect(create.input['OpenZFSConfiguration']).toBeUndefined();
  });

  it('maps FsrmConfiguration on create (incl. FsrmServiceEnabled boolean coercion)', async () => {
    routeSend({
      CreateFileSystemCommand: { FileSystem: { FileSystemId: FS_ID } },
      DescribeFileSystemsCommand: { FileSystems: [availableFs()] },
    });

    await newProvider().create('MyFs', RESOURCE_TYPE, {
      ...WINDOWS_PROPS,
      WindowsConfiguration: {
        ...WINDOWS_PROPS.WindowsConfiguration,
        FsrmConfiguration: {
          FsrmServiceEnabled: 'true',
          EventLogDestination: 'application',
        },
      },
    });

    const [create] = callsOf(CreateFileSystemCommand);
    expect(create.input['WindowsConfiguration']).toMatchObject({
      FsrmConfiguration: { FsrmServiceEnabled: true, EventLogDestination: 'application' },
    });
  });

  it('applies an FsrmConfiguration change via UpdateFileSystem (mutable Windows sub-property)', async () => {
    routeSend({
      UpdateFileSystemCommand: {},
      DescribeFileSystemsCommand: { FileSystems: [availableFs()] },
    });

    await newProvider().update(
      'MyFs',
      FS_ID,
      RESOURCE_TYPE,
      {
        ...WINDOWS_PROPS,
        WindowsConfiguration: {
          ...WINDOWS_PROPS.WindowsConfiguration,
          FsrmConfiguration: { FsrmServiceEnabled: true },
        },
      },
      { ...WINDOWS_PROPS }
    );

    const [update] = callsOf(UpdateFileSystemCommand);
    expect(update.input).toEqual({
      FileSystemId: FS_ID,
      WindowsConfiguration: {
        FsrmConfiguration: { FsrmServiceEnabled: true, EventLogDestination: undefined },
      },
    });
  });

  it('applies a mutable ThroughputCapacity change plus a SelfManagedAD update via UpdateFileSystem', async () => {
    routeSend({
      UpdateFileSystemCommand: {},
      DescribeFileSystemsCommand: { FileSystems: [availableFs()] },
    });

    await newProvider().update(
      'MyFs',
      FS_ID,
      RESOURCE_TYPE,
      {
        ...WINDOWS_PROPS,
        WindowsConfiguration: {
          ...WINDOWS_PROPS.WindowsConfiguration,
          ThroughputCapacity: 64,
          SelfManagedActiveDirectoryConfiguration: { UserName: 'NewAdmin', Password: 'p2' },
        },
      },
      { ...WINDOWS_PROPS }
    );

    const [update] = callsOf(UpdateFileSystemCommand);
    expect(update.input).toEqual({
      FileSystemId: FS_ID,
      WindowsConfiguration: {
        ThroughputCapacity: 64,
        SelfManagedActiveDirectoryConfiguration: { UserName: 'NewAdmin', Password: 'p2' },
      },
    });
  });

  it('rejects a changed immutable Windows sub-property (DeploymentType) with a --replace pointer', async () => {
    await expect(
      newProvider().update(
        'MyFs',
        FS_ID,
        RESOURCE_TYPE,
        {
          ...WINDOWS_PROPS,
          WindowsConfiguration: { ...WINDOWS_PROPS.WindowsConfiguration, DeploymentType: 'SINGLE_AZ_1' },
        },
        { ...WINDOWS_PROPS }
      )
    ).rejects.toThrow(/WindowsConfiguration\.DeploymentType is immutable/);
    expect(mockSend).not.toHaveBeenCalled();
  });
});

describe('FSxFileSystemProvider ONTAP variant', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sends CreateFileSystem with FileSystemType ONTAP and the mapped OntapConfiguration', async () => {
    routeSend({
      CreateFileSystemCommand: { FileSystem: { FileSystemId: FS_ID } },
      DescribeFileSystemsCommand: { FileSystems: [availableFs()] },
    });

    await newProvider().create('MyFs', RESOURCE_TYPE, {
      ...ONTAP_PROPS,
      OntapConfiguration: {
        ...ONTAP_PROPS.OntapConfiguration,
        ThroughputCapacity: '128',
        HAPairs: '1',
        DiskIopsConfiguration: { Mode: 'USER_PROVISIONED', Iops: '3000' },
      },
    });

    const [create] = callsOf(CreateFileSystemCommand);
    expect(create.input['FileSystemType']).toBe('ONTAP');
    expect(create.input['OntapConfiguration']).toMatchObject({
      DeploymentType: 'MULTI_AZ_1',
      ThroughputCapacity: 128,
      HAPairs: 1,
      RouteTableIds: ['rtb-aaa', 'rtb-bbb'],
      DiskIopsConfiguration: { Mode: 'USER_PROVISIONED', Iops: 3000 },
    });
    // No sibling variant blocks leak onto the create call.
    expect(create.input['WindowsConfiguration']).toBeUndefined();
    expect(create.input['OpenZFSConfiguration']).toBeUndefined();
  });

  it('translates a RouteTableIds change into Add/Remove deltas on UpdateFileSystem', async () => {
    routeSend({
      UpdateFileSystemCommand: {},
      DescribeFileSystemsCommand: { FileSystems: [availableFs()] },
    });

    await newProvider().update(
      'MyFs',
      FS_ID,
      RESOURCE_TYPE,
      {
        ...ONTAP_PROPS,
        OntapConfiguration: { ...ONTAP_PROPS.OntapConfiguration, RouteTableIds: ['rtb-aaa', 'rtb-ccc'] },
      },
      { ...ONTAP_PROPS }
    );

    const [update] = callsOf(UpdateFileSystemCommand);
    expect(update.input).toEqual({
      FileSystemId: FS_ID,
      OntapConfiguration: {
        AddRouteTableIds: ['rtb-ccc'],
        RemoveRouteTableIds: ['rtb-bbb'],
      },
    });
  });

  it('is a no-op when RouteTableIds are only reordered (no Add/Remove delta)', async () => {
    routeSend({
      DescribeFileSystemsCommand: { FileSystems: [availableFs()] },
    });

    const result = await newProvider().update(
      'MyFs',
      FS_ID,
      RESOURCE_TYPE,
      {
        ...ONTAP_PROPS,
        OntapConfiguration: { ...ONTAP_PROPS.OntapConfiguration, RouteTableIds: ['rtb-bbb', 'rtb-aaa'] },
      },
      { ...ONTAP_PROPS }
    );

    expect(result).toEqual({ physicalId: FS_ID, wasReplaced: false });
    expect(callsOf(UpdateFileSystemCommand)).toHaveLength(0);
  });

  it('rejects a changed immutable ONTAP sub-property (DeploymentType) with a --replace pointer', async () => {
    await expect(
      newProvider().update(
        'MyFs',
        FS_ID,
        RESOURCE_TYPE,
        {
          ...ONTAP_PROPS,
          OntapConfiguration: { ...ONTAP_PROPS.OntapConfiguration, DeploymentType: 'SINGLE_AZ_1' },
        },
        { ...ONTAP_PROPS }
      )
    ).rejects.toThrow(/OntapConfiguration\.DeploymentType is immutable/);
    expect(mockSend).not.toHaveBeenCalled();
  });
});

describe('FSxFileSystemProvider OPENZFS variant', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sends CreateFileSystem with FileSystemType OPENZFS and the mapped OpenZFSConfiguration (incl. root volume)', async () => {
    routeSend({
      CreateFileSystemCommand: { FileSystem: { FileSystemId: FS_ID } },
      DescribeFileSystemsCommand: {
        FileSystems: [availableFs({ OpenZFSConfiguration: { RootVolumeId: 'fsvol-abc' } })],
      },
    });

    const result = await newProvider().create('MyFs', RESOURCE_TYPE, {
      ...OPENZFS_PROPS,
      OpenZFSConfiguration: {
        ...OPENZFS_PROPS.OpenZFSConfiguration,
        ThroughputCapacity: '64',
        CopyTagsToVolumes: 'true',
        RootVolumeConfiguration: {
          ...OPENZFS_PROPS.OpenZFSConfiguration.RootVolumeConfiguration,
          RecordSizeKiB: '128',
          ReadOnly: 'false',
        },
      },
    });

    // OpenZFS exposes the RootVolumeId GetAtt-served attribute.
    expect(result.attributes).toMatchObject({ RootVolumeId: 'fsvol-abc' });

    const [create] = callsOf(CreateFileSystemCommand);
    expect(create.input['FileSystemType']).toBe('OPENZFS');
    expect(create.input['OpenZFSConfiguration']).toMatchObject({
      DeploymentType: 'SINGLE_AZ_1',
      ThroughputCapacity: 64,
      CopyTagsToVolumes: true,
      RootVolumeConfiguration: {
        RecordSizeKiB: 128,
        DataCompressionType: 'LZ4',
        ReadOnly: false,
        NfsExports: [{ ClientConfigurations: [{ Clients: '*', Options: ['rw', 'crossmnt'] }] }],
        UserAndGroupQuotas: [{ Type: 'USER', Id: 0, StorageCapacityQuotaGiB: 10 }],
      },
    });
    // No sibling variant blocks leak onto the create call.
    expect(create.input['WindowsConfiguration']).toBeUndefined();
    expect(create.input['OntapConfiguration']).toBeUndefined();
  });

  it('applies a mutable ThroughputCapacity + ReadCacheConfiguration change via UpdateFileSystem', async () => {
    routeSend({
      UpdateFileSystemCommand: {},
      DescribeFileSystemsCommand: { FileSystems: [availableFs()] },
    });

    await newProvider().update(
      'MyFs',
      FS_ID,
      RESOURCE_TYPE,
      {
        ...OPENZFS_PROPS,
        OpenZFSConfiguration: {
          ...OPENZFS_PROPS.OpenZFSConfiguration,
          ThroughputCapacity: 128,
          ReadCacheConfiguration: { SizingMode: 'USER_PROVISIONED', SizeGiB: 50 },
        },
      },
      { ...OPENZFS_PROPS }
    );

    const [update] = callsOf(UpdateFileSystemCommand);
    expect(update.input).toEqual({
      FileSystemId: FS_ID,
      OpenZFSConfiguration: {
        ThroughputCapacity: 128,
        ReadCacheConfiguration: { SizingMode: 'USER_PROVISIONED', SizeGiB: 50 },
      },
    });
  });

  it('translates an OpenZFS RouteTableIds change into Add/Remove deltas on UpdateFileSystem', async () => {
    routeSend({
      UpdateFileSystemCommand: {},
      DescribeFileSystemsCommand: { FileSystems: [availableFs()] },
    });

    await newProvider().update(
      'MyFs',
      FS_ID,
      RESOURCE_TYPE,
      {
        ...OPENZFS_PROPS,
        OpenZFSConfiguration: {
          ...OPENZFS_PROPS.OpenZFSConfiguration,
          RouteTableIds: ['rtb-aaa', 'rtb-ccc'],
        },
      },
      {
        ...OPENZFS_PROPS,
        OpenZFSConfiguration: {
          ...OPENZFS_PROPS.OpenZFSConfiguration,
          RouteTableIds: ['rtb-aaa', 'rtb-bbb'],
        },
      }
    );

    const [update] = callsOf(UpdateFileSystemCommand);
    expect(update.input).toEqual({
      FileSystemId: FS_ID,
      OpenZFSConfiguration: {
        AddRouteTableIds: ['rtb-ccc'],
        RemoveRouteTableIds: ['rtb-bbb'],
      },
    });
  });

  it('is a no-op when OpenZFS RouteTableIds are only reordered (no Add/Remove delta)', async () => {
    routeSend({
      DescribeFileSystemsCommand: { FileSystems: [availableFs()] },
    });

    const result = await newProvider().update(
      'MyFs',
      FS_ID,
      RESOURCE_TYPE,
      {
        ...OPENZFS_PROPS,
        OpenZFSConfiguration: {
          ...OPENZFS_PROPS.OpenZFSConfiguration,
          RouteTableIds: ['rtb-bbb', 'rtb-aaa'],
        },
      },
      {
        ...OPENZFS_PROPS,
        OpenZFSConfiguration: {
          ...OPENZFS_PROPS.OpenZFSConfiguration,
          RouteTableIds: ['rtb-aaa', 'rtb-bbb'],
        },
      }
    );

    expect(result).toEqual({ physicalId: FS_ID, wasReplaced: false });
    expect(callsOf(UpdateFileSystemCommand)).toHaveLength(0);
  });

  it('rejects a changed RootVolumeConfiguration (immutable via UpdateFileSystem) with a --replace pointer', async () => {
    await expect(
      newProvider().update(
        'MyFs',
        FS_ID,
        RESOURCE_TYPE,
        {
          ...OPENZFS_PROPS,
          OpenZFSConfiguration: {
            ...OPENZFS_PROPS.OpenZFSConfiguration,
            RootVolumeConfiguration: {
              ...OPENZFS_PROPS.OpenZFSConfiguration.RootVolumeConfiguration,
              RecordSizeKiB: 256,
            },
          },
        },
        { ...OPENZFS_PROPS }
      )
    ).rejects.toThrow(/OpenZFSConfiguration\.RootVolumeConfiguration is immutable/);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('resolves the RootVolumeId attribute via getAttribute (OpenZFS-only)', async () => {
    routeSend({
      DescribeFileSystemsCommand: {
        FileSystems: [availableFs({ OpenZFSConfiguration: { RootVolumeId: 'fsvol-xyz' } })],
      },
    });

    const value = await newProvider().getAttribute(FS_ID, RESOURCE_TYPE, 'RootVolumeId');
    expect(value).toBe('fsvol-xyz');
  });
});
