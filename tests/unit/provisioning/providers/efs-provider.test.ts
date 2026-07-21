import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  CreateFileSystemCommand,
  DeleteFileSystemCommand,
  UpdateFileSystemCommand,
  CreateMountTargetCommand,
  DeleteMountTargetCommand,
  DescribeMountTargetsCommand,
  DescribeFileSystemsCommand,
  DescribeLifecycleConfigurationCommand,
  DescribeBackupPolicyCommand,
  DescribeFileSystemPolicyCommand,
  CreateAccessPointCommand,
  DeleteAccessPointCommand,
  PutLifecycleConfigurationCommand,
  PutBackupPolicyCommand,
  PutFileSystemPolicyCommand,
  UpdateFileSystemProtectionCommand,
  FileSystemNotFound,
  MountTargetNotFound,
  AccessPointNotFound,
} from '@aws-sdk/client-efs';

const mockSend = vi.hoisted(() => vi.fn());

vi.mock('@aws-sdk/client-efs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-efs')>();
  return {
    ...actual,
    EFSClient: vi.fn().mockImplementation(() => ({
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

import { EFSProvider } from '../../../../src/provisioning/providers/efs-provider.js';
import { ResourceUpdateNotSupportedError } from '../../../../src/utils/error-handler.js';

describe('EFSProvider', () => {
  let provider: EFSProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new EFSProvider();
  });

  // ─── AWS::EFS::FileSystem ──────────────────────────────────────────

  describe('AWS::EFS::FileSystem', () => {
    describe('create', () => {
      it('should create file system with CreationToken', async () => {
        mockSend
          .mockResolvedValueOnce({
            FileSystemId: 'fs-12345678',
            FileSystemArn: 'arn:aws:elasticfilesystem:us-east-1:123456789012:file-system/fs-12345678',
          })
          .mockResolvedValueOnce({
            FileSystems: [{ LifeCycleState: 'available' }],
          });

        const result = await provider.create('MyFileSystem', 'AWS::EFS::FileSystem', {});

        expect(result.physicalId).toBe('fs-12345678');
        expect(result.attributes).toEqual({
          Arn: 'arn:aws:elasticfilesystem:us-east-1:123456789012:file-system/fs-12345678',
          FileSystemId: 'fs-12345678',
        });
        expect(mockSend).toHaveBeenCalledTimes(2);

        const cmd = mockSend.mock.calls[0][0];
        expect(cmd).toBeInstanceOf(CreateFileSystemCommand);
        // CreationToken = `cdkd-<logicalId>-<12-hex content hash>`. The content
        // hash makes a property-driven REPLACEMENT's new FS use a different
        // token than the still-existing old FS (which would otherwise collide),
        // while a retry of the SAME create hashes identically (idempotent).
        expect(cmd.input.CreationToken).toMatch(/^cdkd-MyFileSystem-[0-9a-f]{12}$/);
      });

      it('derives a STABLE CreationToken for identical inputs but a DIFFERENT one when an immutable property changes', async () => {
        const tokenFor = async (props: Record<string, unknown>) => {
          mockSend.mockReset();
          mockSend
            .mockResolvedValueOnce({
              FileSystemId: 'fs-1',
              FileSystemArn: 'arn:aws:elasticfilesystem:us-east-1:1:file-system/fs-1',
            })
            .mockResolvedValueOnce({ FileSystems: [{ LifeCycleState: 'available' }] });
          await provider.create('MyFileSystem', 'AWS::EFS::FileSystem', props);
          return (mockSend.mock.calls[0][0] as { input: { CreationToken: string } }).input
            .CreationToken;
        };
        const a = await tokenFor({ PerformanceMode: 'maxIO' });
        const aAgain = await tokenFor({ PerformanceMode: 'maxIO' });
        const b = await tokenFor({ PerformanceMode: 'generalPurpose' }); // immutable change
        expect(a).toBe(aAgain); // stable across identical creates (retry-idempotent)
        expect(a).not.toBe(b); // a replacement's new FS gets a fresh token
        // A MUTABLE-only difference (ThroughputMode / Tags) does NOT change the
        // token — only the immutable (createOnly) subset is hashed, so mutable
        // churn or key reordering cannot accidentally fork the idempotency key.
        const aWithMutable = await tokenFor({
          PerformanceMode: 'maxIO',
          ThroughputMode: 'elastic',
          FileSystemTags: [{ Key: 'x', Value: 'y' }],
        });
        expect(aWithMutable).toBe(a);
        // Robustness: two DISTINCT nested-object immutable values (defensive —
        // intrinsics are resolved to scalars by create() time, but a future leak
        // must not collapse two different values to one token, as a recursive
        // key-allowlist serialization would). Per-value JSON.stringify keeps them
        // distinct.
        const obj1 = await tokenFor({ KmsKeyId: { Ref: 'KeyOne' } });
        const obj2 = await tokenFor({ KmsKeyId: { Ref: 'KeyTwo' } });
        expect(obj1).not.toBe(obj2);
      });

      it('should create file system with tags and encryption', async () => {
        mockSend
          .mockResolvedValueOnce({
            FileSystemId: 'fs-encrypted',
            FileSystemArn: 'arn:aws:elasticfilesystem:us-east-1:123456789012:file-system/fs-encrypted',
          })
          .mockResolvedValueOnce({
            FileSystems: [{ LifeCycleState: 'available' }],
          });

        const result = await provider.create('EncryptedFS', 'AWS::EFS::FileSystem', {
          Encrypted: true,
          KmsKeyId: 'arn:aws:kms:us-east-1:123456789012:key/my-key',
          PerformanceMode: 'generalPurpose',
          ThroughputMode: 'bursting',
          FileSystemTags: [
            { Key: 'Name', Value: 'my-fs' },
            { Key: 'Env', Value: 'test' },
          ],
        });

        expect(result.physicalId).toBe('fs-encrypted');
        expect(mockSend).toHaveBeenCalledTimes(2);

        const cmd = mockSend.mock.calls[0][0];
        expect(cmd).toBeInstanceOf(CreateFileSystemCommand);
        expect(cmd.input.Encrypted).toBe(true);
        expect(cmd.input.KmsKeyId).toBe('arn:aws:kms:us-east-1:123456789012:key/my-key');
        expect(cmd.input.PerformanceMode).toBe('generalPurpose');
        expect(cmd.input.ThroughputMode).toBe('bursting');
        expect(cmd.input.Tags).toEqual([
          { Key: 'Name', Value: 'my-fs' },
          { Key: 'Env', Value: 'test' },
        ]);
      });
    });

    // ─── #609 backfill: post-create control-plane properties ───────────
    describe('backfilled properties (#609)', () => {
      // Helper: mock CreateFileSystem (call 0) + the wait DescribeFileSystems
      // (call 1) so any subsequent Put*/Update* call lands at call index 2+.
      const mockCreateAndWait = (fsId: string): void => {
        mockSend.mockImplementation((cmd: unknown) => {
          if (cmd instanceof CreateFileSystemCommand) {
            return Promise.resolve({
              FileSystemId: fsId,
              FileSystemArn: `arn:aws:elasticfilesystem:us-east-1:123456789012:file-system/${fsId}`,
            });
          }
          if (cmd instanceof DescribeFileSystemsCommand) {
            return Promise.resolve({ FileSystems: [{ LifeCycleState: 'available' }] });
          }
          return Promise.resolve({});
        });
      };

      it('should ride AvailabilityZoneName on CreateFileSystem (One Zone)', async () => {
        mockCreateAndWait('fs-onezone');

        await provider.create('OneZoneFS', 'AWS::EFS::FileSystem', {
          AvailabilityZoneName: 'us-east-1a',
        });

        const createCmd = mockSend.mock.calls[0][0];
        expect(createCmd).toBeInstanceOf(CreateFileSystemCommand);
        expect(createCmd.input.AvailabilityZoneName).toBe('us-east-1a');
      });

      it('should apply LifecyclePolicies via PutLifecycleConfiguration after ACTIVE', async () => {
        mockCreateAndWait('fs-lifecycle');

        await provider.create('LifecycleFS', 'AWS::EFS::FileSystem', {
          LifecyclePolicies: [{ TransitionToIA: 'AFTER_30_DAYS' }],
        });

        const putCmd = mockSend.mock.calls.find(
          (c) => c[0] instanceof PutLifecycleConfigurationCommand
        )?.[0];
        expect(putCmd).toBeDefined();
        expect(putCmd.input.FileSystemId).toBe('fs-lifecycle');
        expect(putCmd.input.LifecyclePolicies).toEqual([{ TransitionToIA: 'AFTER_30_DAYS' }]);
      });

      it('should apply BackupPolicy via PutBackupPolicy after ACTIVE', async () => {
        mockCreateAndWait('fs-backup');

        await provider.create('BackupFS', 'AWS::EFS::FileSystem', {
          BackupPolicy: { Status: 'ENABLED' },
        });

        const putCmd = mockSend.mock.calls.find((c) => c[0] instanceof PutBackupPolicyCommand)?.[0];
        expect(putCmd).toBeDefined();
        expect(putCmd.input.FileSystemId).toBe('fs-backup');
        expect(putCmd.input.BackupPolicy).toEqual({ Status: 'ENABLED' });
      });

      it('should JSON.stringify FileSystemPolicy object and pass BypassPolicyLockoutSafetyCheck', async () => {
        mockCreateAndWait('fs-policy');

        const policyDoc = {
          Version: '2012-10-17',
          Statement: [
            {
              Effect: 'Allow',
              Principal: { AWS: '*' },
              Action: 'elasticfilesystem:ClientMount',
              Resource: '*',
            },
          ],
        };
        await provider.create('PolicyFS', 'AWS::EFS::FileSystem', {
          FileSystemPolicy: policyDoc,
          BypassPolicyLockoutSafetyCheck: true,
        });

        const putCmd = mockSend.mock.calls.find(
          (c) => c[0] instanceof PutFileSystemPolicyCommand
        )?.[0];
        expect(putCmd).toBeDefined();
        expect(putCmd.input.FileSystemId).toBe('fs-policy');
        // SDK Policy field is a JSON string, not the object.
        expect(typeof putCmd.input.Policy).toBe('string');
        expect(JSON.parse(putCmd.input.Policy)).toEqual(policyDoc);
        expect(putCmd.input.BypassPolicyLockoutSafetyCheck).toBe(true);
      });

      it('should apply FileSystemProtection via UpdateFileSystemProtection after ACTIVE', async () => {
        mockCreateAndWait('fs-protect');

        await provider.create('ProtectFS', 'AWS::EFS::FileSystem', {
          FileSystemProtection: { ReplicationOverwriteProtection: 'ENABLED' },
        });

        const updCmd = mockSend.mock.calls.find(
          (c) => c[0] instanceof UpdateFileSystemProtectionCommand
        )?.[0];
        expect(updCmd).toBeDefined();
        expect(updCmd.input.FileSystemId).toBe('fs-protect');
        expect(updCmd.input.ReplicationOverwriteProtection).toBe('ENABLED');
      });

      it('should retry a transient control-plane error on PutBackupPolicy', async () => {
        let backupAttempts = 0;
        mockSend.mockImplementation((cmd: unknown) => {
          if (cmd instanceof CreateFileSystemCommand) {
            return Promise.resolve({
              FileSystemId: 'fs-retry',
              FileSystemArn: 'arn:aws:elasticfilesystem:us-east-1:123456789012:file-system/fs-retry',
            });
          }
          if (cmd instanceof DescribeFileSystemsCommand) {
            return Promise.resolve({ FileSystems: [{ LifeCycleState: 'available' }] });
          }
          if (cmd instanceof PutBackupPolicyCommand) {
            backupAttempts += 1;
            if (backupAttempts === 1) {
              const err = new Error('The backup policy update is in progress. Please retry later.');
              return Promise.reject(err);
            }
            return Promise.resolve({});
          }
          return Promise.resolve({});
        });

        await provider.create('RetryFS', 'AWS::EFS::FileSystem', {
          BackupPolicy: { Status: 'ENABLED' },
        });

        // First attempt failed transiently; the helper retried (delay is real,
        // ~2s — keep the test fast by NOT relying on fake timers; one retry is
        // bounded and the suite tolerates the short wait).
        expect(backupAttempts).toBe(2);
      }, 15000);

      it('should best-effort delete the file system when a post-ACTIVE step fails (atomicity)', async () => {
        mockSend.mockImplementation((cmd: unknown) => {
          if (cmd instanceof CreateFileSystemCommand) {
            return Promise.resolve({
              FileSystemId: 'fs-rollback',
              FileSystemArn:
                'arn:aws:elasticfilesystem:us-east-1:123456789012:file-system/fs-rollback',
            });
          }
          if (cmd instanceof DescribeFileSystemsCommand) {
            return Promise.resolve({ FileSystems: [{ LifeCycleState: 'available' }] });
          }
          if (cmd instanceof PutLifecycleConfigurationCommand) {
            // Non-transient hard failure → no retry, propagate.
            return Promise.reject(new Error('AccessDenied: not authorized'));
          }
          return Promise.resolve({});
        });

        await expect(
          provider.create('RollbackFS', 'AWS::EFS::FileSystem', {
            LifecyclePolicies: [{ TransitionToIA: 'AFTER_7_DAYS' }],
          })
        ).rejects.toThrow();

        const deleteCmd = mockSend.mock.calls.find(
          (c) => c[0] instanceof DeleteFileSystemCommand
        )?.[0];
        expect(deleteCmd).toBeDefined();
        expect(deleteCmd.input.FileSystemId).toBe('fs-rollback');
      });
    });

    describe('update', () => {
      it('should apply BackupPolicy diff via PutBackupPolicy', async () => {
        mockSend.mockImplementation((cmd: unknown) => {
          if (cmd instanceof DescribeFileSystemsCommand) {
            return Promise.resolve({ FileSystems: [{ LifeCycleState: 'available' }] });
          }
          return Promise.resolve({});
        });

        await provider.update(
          'BackupFS',
          'fs-upd-backup',
          'AWS::EFS::FileSystem',
          { BackupPolicy: { Status: 'ENABLED' } },
          { BackupPolicy: { Status: 'DISABLED' } }
        );

        const putCmd = mockSend.mock.calls.find((c) => c[0] instanceof PutBackupPolicyCommand)?.[0];
        expect(putCmd).toBeDefined();
        expect(putCmd.input.BackupPolicy).toEqual({ Status: 'ENABLED' });
        // No UpdateFileSystem (throughput) call should be issued.
        expect(
          mockSend.mock.calls.some((c) => c[0] instanceof UpdateFileSystemCommand)
        ).toBe(false);
      });

      it('should clear LifecyclePolicies on removal (empty array put)', async () => {
        mockSend.mockImplementation((cmd: unknown) => {
          if (cmd instanceof DescribeFileSystemsCommand) {
            return Promise.resolve({ FileSystems: [{ LifeCycleState: 'available' }] });
          }
          return Promise.resolve({});
        });

        await provider.update(
          'LifecycleFS',
          'fs-upd-lifecycle',
          'AWS::EFS::FileSystem',
          {},
          { LifecyclePolicies: [{ TransitionToIA: 'AFTER_30_DAYS' }] }
        );

        const putCmd = mockSend.mock.calls.find(
          (c) => c[0] instanceof PutLifecycleConfigurationCommand
        )?.[0];
        expect(putCmd).toBeDefined();
        expect(putCmd.input.LifecyclePolicies).toEqual([]);
      });

      it('should no-op when no mutable diff', async () => {
        mockSend.mockImplementation(() => Promise.resolve({}));

        const result = await provider.update(
          'NoChangeFS',
          'fs-nochange',
          'AWS::EFS::FileSystem',
          { BackupPolicy: { Status: 'ENABLED' } },
          { BackupPolicy: { Status: 'ENABLED' } }
        );

        expect(result).toEqual({ physicalId: 'fs-nochange', wasReplaced: false });
        expect(mockSend).not.toHaveBeenCalled();
      });
    });

    describe('readCurrentState', () => {
      it('should surface AvailabilityZoneName, FileSystemProtection, and FileSystemPolicy', async () => {
        mockSend.mockImplementation((cmd: unknown) => {
          if (cmd instanceof DescribeFileSystemsCommand) {
            return Promise.resolve({
              FileSystems: [
                {
                  PerformanceMode: 'generalPurpose',
                  AvailabilityZoneName: 'us-east-1a',
                  FileSystemProtection: { ReplicationOverwriteProtection: 'ENABLED' },
                  Tags: [],
                },
              ],
            });
          }
          if (cmd instanceof DescribeLifecycleConfigurationCommand) {
            return Promise.resolve({ LifecyclePolicies: [{ TransitionToIA: 'AFTER_30_DAYS' }] });
          }
          if (cmd instanceof DescribeBackupPolicyCommand) {
            return Promise.resolve({ BackupPolicy: { Status: 'ENABLED' } });
          }
          if (cmd instanceof DescribeFileSystemPolicyCommand) {
            return Promise.resolve({
              Policy: JSON.stringify({ Version: '2012-10-17', Statement: [] }),
            });
          }
          return Promise.resolve({});
        });

        const state = await provider.readCurrentState('fs-read', 'ReadFS', 'AWS::EFS::FileSystem');

        expect(state).toBeDefined();
        expect(state!['AvailabilityZoneName']).toBe('us-east-1a');
        expect(state!['FileSystemProtection']).toEqual({
          ReplicationOverwriteProtection: 'ENABLED',
        });
        expect(state!['LifecyclePolicies']).toEqual([{ TransitionToIA: 'AFTER_30_DAYS' }]);
        expect(state!['BackupPolicy']).toEqual({ Status: 'ENABLED' });
        // FileSystemPolicy parsed back from JSON string to object.
        expect(state!['FileSystemPolicy']).toEqual({ Version: '2012-10-17', Statement: [] });
      });

      it('should omit FileSystemPolicy when no policy is attached (PolicyNotFound)', async () => {
        mockSend.mockImplementation((cmd: unknown) => {
          if (cmd instanceof DescribeFileSystemsCommand) {
            return Promise.resolve({ FileSystems: [{ PerformanceMode: 'generalPurpose', Tags: [] }] });
          }
          if (cmd instanceof DescribeFileSystemPolicyCommand) {
            const err = new Error('Policy not found');
            (err as { name: string }).name = 'PolicyNotFound';
            return Promise.reject(err);
          }
          return Promise.resolve({});
        });

        const state = await provider.readCurrentState('fs-nopol', 'NoPolFS', 'AWS::EFS::FileSystem');

        expect(state).toBeDefined();
        expect(state!['FileSystemPolicy']).toBeUndefined();
      });
    });

    describe('delete', () => {
      it('should delete file system', async () => {
        mockSend.mockResolvedValueOnce({});

        await provider.delete('MyFileSystem', 'fs-12345678', 'AWS::EFS::FileSystem');

        expect(mockSend).toHaveBeenCalledTimes(1);
        const cmd = mockSend.mock.calls[0][0];
        expect(cmd).toBeInstanceOf(DeleteFileSystemCommand);
        expect(cmd.input.FileSystemId).toBe('fs-12345678');
      });

      it('should not throw when file system not found', async () => {
        mockSend.mockRejectedValueOnce(
          new FileSystemNotFound({ message: 'not found', ErrorCode: 'FileSystemNotFound', $metadata: {} })
        );

        await expect(
          provider.delete('MyFileSystem', 'fs-12345678', 'AWS::EFS::FileSystem')
        ).resolves.toBeUndefined();
      });
    });
  });

  // ─── AWS::EFS::MountTarget ─────────────────────────────────────────

  describe('AWS::EFS::MountTarget', () => {
    describe('create', () => {
      it('should create mount target and wait for available', async () => {
        mockSend.mockImplementation((cmd: unknown) => {
          if (cmd instanceof CreateMountTargetCommand) {
            return Promise.resolve({ MountTargetId: 'fsmt-123' });
          }
          if (cmd instanceof DescribeMountTargetsCommand) {
            return Promise.resolve({
              MountTargets: [{ LifeCycleState: 'available' }],
            });
          }
          return Promise.resolve({});
        });

        const result = await provider.create('MyMountTarget', 'AWS::EFS::MountTarget', {
          FileSystemId: 'fs-12345678',
          SubnetId: 'subnet-abc',
          SecurityGroups: ['sg-123'],
        });

        expect(result.physicalId).toBe('fsmt-123');
        expect(result.attributes).toEqual({});

        const createCmd = mockSend.mock.calls[0][0];
        expect(createCmd).toBeInstanceOf(CreateMountTargetCommand);
        expect(createCmd.input.FileSystemId).toBe('fs-12345678');
        expect(createCmd.input.SubnetId).toBe('subnet-abc');
        expect(createCmd.input.SecurityGroups).toEqual(['sg-123']);
      });
    });

    describe('delete', () => {
      it('should delete mount target and wait for deletion', async () => {
        mockSend.mockImplementation((cmd: unknown) => {
          if (cmd instanceof DeleteMountTargetCommand) {
            return Promise.resolve({});
          }
          if (cmd instanceof DescribeMountTargetsCommand) {
            return Promise.reject(
              new MountTargetNotFound({ message: 'not found', ErrorCode: 'MountTargetNotFound', $metadata: {} })
            );
          }
          return Promise.resolve({});
        });

        await provider.delete('MyMountTarget', 'fsmt-123', 'AWS::EFS::MountTarget');

        const deleteCmd = mockSend.mock.calls[0][0];
        expect(deleteCmd).toBeInstanceOf(DeleteMountTargetCommand);
        expect(deleteCmd.input.MountTargetId).toBe('fsmt-123');
      });

      it('should not throw when mount target not found', async () => {
        mockSend.mockRejectedValueOnce(
          new MountTargetNotFound({ message: 'not found', ErrorCode: 'MountTargetNotFound', $metadata: {} })
        );

        await expect(
          provider.delete('MyMountTarget', 'fsmt-123', 'AWS::EFS::MountTarget')
        ).resolves.toBeUndefined();
      });
    });
  });

  // ─── AWS::EFS::AccessPoint ─────────────────────────────────────────

  describe('AWS::EFS::AccessPoint', () => {
    describe('create', () => {
      it('should create access point with PosixUser and RootDirectory', async () => {
        mockSend.mockResolvedValueOnce({
          AccessPointId: 'fsap-abc123',
          AccessPointArn: 'arn:aws:elasticfilesystem:us-east-1:123456789012:access-point/fsap-abc123',
        });

        const result = await provider.create('MyAccessPoint', 'AWS::EFS::AccessPoint', {
          FileSystemId: 'fs-12345678',
          PosixUser: { Uid: 1000, Gid: 1000 },
          RootDirectory: {
            Path: '/export/data',
            CreationInfo: {
              OwnerUid: 1000,
              OwnerGid: 1000,
              Permissions: '755',
            },
          },
        });

        expect(result.physicalId).toBe('fsap-abc123');
        expect(result.attributes).toEqual({
          Arn: 'arn:aws:elasticfilesystem:us-east-1:123456789012:access-point/fsap-abc123',
          AccessPointId: 'fsap-abc123',
        });

        const cmd = mockSend.mock.calls[0][0];
        expect(cmd).toBeInstanceOf(CreateAccessPointCommand);
        expect(cmd.input.FileSystemId).toBe('fs-12345678');
        expect(cmd.input.PosixUser).toEqual({ Uid: 1000, Gid: 1000 });
        expect(cmd.input.RootDirectory).toEqual({
          Path: '/export/data',
          CreationInfo: {
            OwnerUid: 1000,
            OwnerGid: 1000,
            Permissions: '755',
          },
        });
      });
    });

    describe('delete', () => {
      it('should delete access point', async () => {
        mockSend.mockResolvedValueOnce({});

        await provider.delete('MyAccessPoint', 'fsap-abc123', 'AWS::EFS::AccessPoint');

        expect(mockSend).toHaveBeenCalledTimes(1);
        const cmd = mockSend.mock.calls[0][0];
        expect(cmd).toBeInstanceOf(DeleteAccessPointCommand);
        expect(cmd.input.AccessPointId).toBe('fsap-abc123');
      });

      it('should not throw when access point not found', async () => {
        mockSend.mockRejectedValueOnce(
          new AccessPointNotFound({ message: 'not found', ErrorCode: 'AccessPointNotFound', $metadata: {} })
        );

        await expect(
          provider.delete('MyAccessPoint', 'fsap-abc123', 'AWS::EFS::AccessPoint')
        ).resolves.toBeUndefined();
      });
    });
  });

  // ─── update ─────────────────────────────────────────────────────────

  describe('update', () => {
    it('FileSystem with no mutable diff is a silent no-op', async () => {
      const observed = { ThroughputMode: 'bursting', Encrypted: false };
      const result = await provider.update(
        'MyFS',
        'fs-123',
        'AWS::EFS::FileSystem',
        observed,
        observed
      );
      expect(result).toEqual({ physicalId: 'fs-123', wasReplaced: false });
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('MountTarget with no SecurityGroups in properties is a silent no-op', async () => {
      const result = await provider.update(
        'MyMT',
        'fsmt-123',
        'AWS::EFS::MountTarget',
        { FileSystemId: 'fs-1' },
        { FileSystemId: 'fs-1' }
      );
      expect(result).toEqual({ physicalId: 'fsmt-123', wasReplaced: false });
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('AccessPoint always rejects with ResourceUpdateNotSupportedError (no mutable surface)', async () => {
      await expect(
        provider.update('MyAP', 'fsap-123', 'AWS::EFS::AccessPoint', {}, {})
      ).rejects.toThrow(ResourceUpdateNotSupportedError);
      expect(mockSend).not.toHaveBeenCalled();
    });
  });

  describe('import', () => {
    function makeInput(overrides: Record<string, unknown> = {}) {
      return {
        logicalId: 'MyFS',
        resourceType: 'AWS::EFS::FileSystem',
        stackName: 'MyStack',
        region: 'us-east-1',
        properties: {},
        ...overrides,
      };
    }

    it('FileSystem explicit override: DescribeFileSystems verifies and returns fsId', async () => {
      mockSend.mockResolvedValueOnce({ FileSystems: [{ FileSystemId: 'fs-abc' }] });

      const result = await provider.import(makeInput({ knownPhysicalId: 'fs-abc' }));

      expect(result).toEqual({ physicalId: 'fs-abc', attributes: {} });
      const call = mockSend.mock.calls[0][0];
      expect(call.constructor.name).toBe('DescribeFileSystemsCommand');
      expect(call.input).toEqual({ FileSystemId: 'fs-abc' });
    });

    // The `aws:cdk:path` tag walk is gone (issue #1134): AWS rejects
    // `aws:`-prefixed tag writes, so that tag never exists on a real resource
    // and the walk could not match. Without an explicit override, import
    // returns null WITHOUT any list call.
    it('FileSystem returns null without any list call when no override is given', async () => {
      const result = await provider.import(makeInput());
      expect(result).toBeNull();
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('AccessPoint returns null without any list call when no override is given', async () => {
      const result = await provider.import(
        makeInput({ logicalId: 'MyAP', resourceType: 'AWS::EFS::AccessPoint' })
      );
      expect(result).toBeNull();
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('MountTarget: explicit override returned as-is, no AWS calls', async () => {
      const result = await provider.import(
        makeInput({
          logicalId: 'MT',
          resourceType: 'AWS::EFS::MountTarget',
          knownPhysicalId: 'fsmt-123',
        })
      );
      expect(result).toEqual({ physicalId: 'fsmt-123', attributes: {} });
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('MountTarget: returns null without explicit override', async () => {
      const result = await provider.import(
        makeInput({ logicalId: 'MT', resourceType: 'AWS::EFS::MountTarget' })
      );
      expect(result).toBeNull();
      expect(mockSend).not.toHaveBeenCalled();
    });
  });
});
