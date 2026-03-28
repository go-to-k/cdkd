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
        mockSend.mockResolvedValueOnce({
          FileSystemId: 'fs-12345678',
          FileSystemArn: 'arn:aws:elasticfilesystem:us-east-1:123456789012:file-system/fs-12345678',
        });

        const result = await provider.create('MyFileSystem', 'AWS::EFS::FileSystem', {});

        expect(result.physicalId).toBe('fs-12345678');
        expect(result.attributes).toEqual({
          Arn: 'arn:aws:elasticfilesystem:us-east-1:123456789012:file-system/fs-12345678',
          FileSystemId: 'fs-12345678',
        });
        expect(mockSend).toHaveBeenCalledTimes(1);

        const cmd = mockSend.mock.calls[0][0];
        expect(cmd).toBeInstanceOf(CreateFileSystemCommand);
        expect(cmd.input.CreationToken).toBe('cdkd-MyFileSystem');
      });

      it('should create file system with tags and encryption', async () => {
        mockSend.mockResolvedValueOnce({
          FileSystemId: 'fs-encrypted',
          FileSystemArn: 'arn:aws:elasticfilesystem:us-east-1:123456789012:file-system/fs-encrypted',
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
        expect(mockSend).toHaveBeenCalledTimes(1);

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
});
