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

import { FSxFileSystemProvider } from '../../../../src/provisioning/providers/fsx-filesystem-provider.js';
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

  it('rejects non-Lustre FileSystemType with a clear error before any SDK call', async () => {
    await expect(
      newProvider().create('MyFs', RESOURCE_TYPE, { ...LUSTRE_PROPS, FileSystemType: 'WINDOWS' })
    ).rejects.toThrow(/only the LUSTRE variant/);
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

  it('declares SecurityGroupIds and BackupId as drift-unknown', () => {
    expect(newProvider().getDriftUnknownPaths(RESOURCE_TYPE)).toEqual([
      'SecurityGroupIds',
      'BackupId',
    ]);
    expect(newProvider().getDriftUnknownPaths('AWS::S3::Bucket')).toEqual([]);
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
