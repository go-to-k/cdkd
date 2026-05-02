import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  CreateFileSystemCommand,
  DeleteFileSystemCommand,
  CreateMountTargetCommand,
  DeleteMountTargetCommand,
  DescribeMountTargetsCommand,
  CreateAccessPointCommand,
  DeleteAccessPointCommand,
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
        expect(cmd.input.CreationToken).toBe('cdkd-MyFileSystem');
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
          new FileSystemNotFound({ message: 'not found', $metadata: {} })
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
              new MountTargetNotFound({ message: 'not found', $metadata: {} })
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
          new MountTargetNotFound({ message: 'not found', $metadata: {} })
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
          new AccessPointNotFound({ message: 'not found', $metadata: {} })
        );

        await expect(
          provider.delete('MyAccessPoint', 'fsap-abc123', 'AWS::EFS::AccessPoint')
        ).resolves.toBeUndefined();
      });
    });
  });

  // ─── update ─────────────────────────────────────────────────────────

  describe('update', () => {
    it('should return no-op for FileSystem', async () => {
      const result = await provider.update(
        'MyFS', 'fs-123', 'AWS::EFS::FileSystem', {}, {}
      );
      expect(result).toEqual({ physicalId: 'fs-123', wasReplaced: false });
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('should return no-op for MountTarget', async () => {
      const result = await provider.update(
        'MyMT', 'fsmt-123', 'AWS::EFS::MountTarget', {}, {}
      );
      expect(result).toEqual({ physicalId: 'fsmt-123', wasReplaced: false });
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('should return no-op for AccessPoint', async () => {
      const result = await provider.update(
        'MyAP', 'fsap-123', 'AWS::EFS::AccessPoint', {}, {}
      );
      expect(result).toEqual({ physicalId: 'fsap-123', wasReplaced: false });
      expect(mockSend).not.toHaveBeenCalled();
    });
  });

  describe('import', () => {
    function makeInput(overrides: Record<string, unknown> = {}) {
      return {
        logicalId: 'MyFS',
        resourceType: 'AWS::EFS::FileSystem',
        cdkPath: 'MyStack/MyFS',
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

    it('FileSystem tag-based lookup: matches aws:cdk:path on inline Tags', async () => {
      mockSend.mockResolvedValueOnce({
        FileSystems: [
          {
            FileSystemId: 'fs-other',
            Tags: [{ Key: 'aws:cdk:path', Value: 'OtherStack/Other' }],
          },
          {
            FileSystemId: 'fs-target',
            Tags: [{ Key: 'aws:cdk:path', Value: 'MyStack/MyFS' }],
          },
        ],
      });

      const result = await provider.import(makeInput());
      expect(result).toEqual({ physicalId: 'fs-target', attributes: {} });
    });

    it('FileSystem returns null when no fs matches', async () => {
      mockSend.mockResolvedValueOnce({
        FileSystems: [
          {
            FileSystemId: 'fs-only',
            Tags: [{ Key: 'aws:cdk:path', Value: 'OtherStack/Other' }],
          },
        ],
      });

      const result = await provider.import(makeInput());
      expect(result).toBeNull();
    });

    it('AccessPoint tag-based lookup: matches via DescribeAccessPoints inline Tags', async () => {
      mockSend.mockResolvedValueOnce({
        AccessPoints: [
          {
            AccessPointId: 'fsap-target',
            Tags: [{ Key: 'aws:cdk:path', Value: 'MyStack/MyAP' }],
          },
        ],
      });

      const result = await provider.import(
        makeInput({
          logicalId: 'MyAP',
          resourceType: 'AWS::EFS::AccessPoint',
          cdkPath: 'MyStack/MyAP',
        })
      );
      expect(result).toEqual({ physicalId: 'fsap-target', attributes: {} });
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
