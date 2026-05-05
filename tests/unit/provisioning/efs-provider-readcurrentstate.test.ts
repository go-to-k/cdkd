import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  DescribeFileSystemsCommand,
  DescribeAccessPointsCommand,
  DescribeMountTargetsCommand,
  DescribeLifecycleConfigurationCommand,
  DescribeBackupPolicyCommand,
  FileSystemNotFound,
  AccessPointNotFound,
  MountTargetNotFound,
} from '@aws-sdk/client-efs';

const mockSend = vi.fn();

vi.mock('@aws-sdk/client-efs', async () => {
  const actual = await vi.importActual<typeof import('@aws-sdk/client-efs')>(
    '@aws-sdk/client-efs'
  );
  return {
    ...actual,
    EFSClient: vi.fn().mockImplementation(() => ({
      send: mockSend,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
  };
});

vi.mock('../../../src/utils/logger.js', () => {
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

import { EFSProvider } from '../../../src/provisioning/providers/efs-provider.js';

describe('EFSProvider.readCurrentState', () => {
  let provider: EFSProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new EFSProvider();
  });

  describe('AWS::EFS::FileSystem', () => {
    it('returns CFn-shaped properties + lifecycle + backup (happy path)', async () => {
      mockSend
        .mockResolvedValueOnce({
          FileSystems: [
            {
              FileSystemId: 'fs-1',
              PerformanceMode: 'generalPurpose',
              ThroughputMode: 'bursting',
              Encrypted: true,
              KmsKeyId: 'arn:aws:kms:us-east-1:1:key/abc',
            },
          ],
        })
        .mockResolvedValueOnce({
          LifecyclePolicies: [{ TransitionToIA: 'AFTER_30_DAYS' }],
        })
        .mockResolvedValueOnce({
          BackupPolicy: { Status: 'ENABLED' },
        });

      const result = await provider.readCurrentState('fs-1', 'L', 'AWS::EFS::FileSystem');

      expect(mockSend.mock.calls[0]?.[0]).toBeInstanceOf(DescribeFileSystemsCommand);
      expect(mockSend.mock.calls[1]?.[0]).toBeInstanceOf(DescribeLifecycleConfigurationCommand);
      expect(mockSend.mock.calls[2]?.[0]).toBeInstanceOf(DescribeBackupPolicyCommand);
      expect(result).toEqual({
        PerformanceMode: 'generalPurpose',
        ThroughputMode: 'bursting',
        Encrypted: true,
        KmsKeyId: 'arn:aws:kms:us-east-1:1:key/abc',
        LifecyclePolicies: [{ TransitionToIA: 'AFTER_30_DAYS' }],
        BackupPolicy: { Status: 'ENABLED' },
      });
    });

    it('omits LifecyclePolicies / BackupPolicy when not configured', async () => {
      mockSend
        .mockResolvedValueOnce({
          FileSystems: [
            { FileSystemId: 'fs-1', PerformanceMode: 'generalPurpose', Encrypted: false },
          ],
        })
        .mockRejectedValueOnce(Object.assign(new Error('PolicyNotFound'), { name: 'PolicyNotFound' }))
        .mockRejectedValueOnce(Object.assign(new Error('PolicyNotFound'), { name: 'PolicyNotFound' }));

      const result = await provider.readCurrentState('fs-1', 'L', 'AWS::EFS::FileSystem');

      expect(result).toEqual({
        PerformanceMode: 'generalPurpose',
        Encrypted: false,
      });
    });

    it('returns undefined when filesystem is gone', async () => {
      mockSend.mockRejectedValueOnce(
        new FileSystemNotFound({ message: 'gone', $metadata: {}, ErrorCode: 'FileSystemNotFound' })
      );
      const result = await provider.readCurrentState('fs-1', 'L', 'AWS::EFS::FileSystem');
      expect(result).toBeUndefined();
    });
  });

  describe('AWS::EFS::AccessPoint', () => {
    it('returns CFn-shaped AccessPoint properties (happy path)', async () => {
      mockSend.mockResolvedValueOnce({
        AccessPoints: [
          {
            AccessPointId: 'fsap-1',
            FileSystemId: 'fs-1',
            PosixUser: { Uid: 1000, Gid: 1000 },
            RootDirectory: {
              Path: '/data',
              CreationInfo: { OwnerUid: 1000, OwnerGid: 1000, Permissions: '755' },
            },
          },
        ],
      });

      const result = await provider.readCurrentState('fsap-1', 'L', 'AWS::EFS::AccessPoint');

      expect(mockSend.mock.calls[0]?.[0]).toBeInstanceOf(DescribeAccessPointsCommand);
      expect(result).toEqual({
        FileSystemId: 'fs-1',
        PosixUser: { Uid: 1000, Gid: 1000 },
        RootDirectory: {
          Path: '/data',
          CreationInfo: { OwnerUid: 1000, OwnerGid: 1000, Permissions: '755' },
        },
      });
    });

    it('returns undefined when AP is gone', async () => {
      mockSend.mockRejectedValueOnce(
        new AccessPointNotFound({
          message: 'gone',
          $metadata: {},
          ErrorCode: 'AccessPointNotFound',
        })
      );
      const result = await provider.readCurrentState('fsap-1', 'L', 'AWS::EFS::AccessPoint');
      expect(result).toBeUndefined();
    });
  });

  describe('AWS::EFS::MountTarget', () => {
    it('returns FileSystemId + SubnetId from DescribeMountTargets', async () => {
      mockSend.mockResolvedValueOnce({
        MountTargets: [
          { MountTargetId: 'fsmt-1', FileSystemId: 'fs-1', SubnetId: 'subnet-1' },
        ],
      });

      const result = await provider.readCurrentState('fsmt-1', 'L', 'AWS::EFS::MountTarget');

      expect(mockSend.mock.calls[0]?.[0]).toBeInstanceOf(DescribeMountTargetsCommand);
      expect(result).toEqual({ FileSystemId: 'fs-1', SubnetId: 'subnet-1' });
    });

    it('returns undefined when MT is gone', async () => {
      mockSend.mockRejectedValueOnce(
        new MountTargetNotFound({
          message: 'gone',
          $metadata: {},
          ErrorCode: 'MountTargetNotFound',
        })
      );
      const result = await provider.readCurrentState('fsmt-1', 'L', 'AWS::EFS::MountTarget');
      expect(result).toBeUndefined();
    });
  });
});
