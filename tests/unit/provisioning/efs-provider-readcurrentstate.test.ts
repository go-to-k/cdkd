import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
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
import { RESOURCE_NOT_FOUND, type ResourceNotFound } from '../../../src/types/resource.js';

function bagOf(r: Record<string, unknown> | ResourceNotFound | undefined): Record<string, unknown> {
  if (r === undefined || r === RESOURCE_NOT_FOUND) throw new Error('expected a property bag');
  return r;
}

const fsItem = { FileSystemId: 'fs-1', PerformanceMode: 'generalPurpose', Encrypted: false };

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
        FileSystemTags: [],
      });
    });

    it('omits LifecyclePolicies / BackupPolicy when not configured (still emits FileSystemTags placeholder)', async () => {
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
        FileSystemTags: [],
      });
    });

    it('returns RESOURCE_NOT_FOUND when filesystem is gone', async () => {
      mockSend.mockRejectedValueOnce(
        new FileSystemNotFound({ message: 'gone', $metadata: {}, ErrorCode: 'FileSystemNotFound' })
      );
      const result = await provider.readCurrentState('fs-1', 'L', 'AWS::EFS::FileSystem');
      expect(result).toBe(RESOURCE_NOT_FOUND);
    });

    it('returns RESOURCE_NOT_FOUND on an empty FileSystems list for the id', async () => {
      mockSend.mockResolvedValueOnce({ FileSystems: [] });
      const result = await provider.readCurrentState('fs-1', 'L', 'AWS::EFS::FileSystem');
      expect(result).toBe(RESOURCE_NOT_FOUND);
    });

    it('keeps undefined when DescribeFileSystems answers with an empty body', async () => {
      mockSend.mockResolvedValueOnce({});
      const result = await provider.readCurrentState('fs-1', 'L', 'AWS::EFS::FileSystem');
      expect(result).toBeUndefined();
    });

    it.each([
      ['DescribeLifecycleConfiguration', 1],
      ['DescribeBackupPolicy', 2],
      ['DescribeFileSystemPolicy', 3],
    ])(
      'returns RESOURCE_NOT_FOUND when the FS vanishes before %s',
      async (_call, failingIndex) => {
        mockSend.mockResolvedValueOnce({ FileSystems: [fsItem] });
        for (let i = 1; i < failingIndex; i++) mockSend.mockResolvedValueOnce({});
        mockSend.mockRejectedValueOnce(
          new FileSystemNotFound({ message: 'gone', $metadata: {}, ErrorCode: 'FileSystemNotFound' })
        );
        const result = await provider.readCurrentState('fs-1', 'L', 'AWS::EFS::FileSystem');
        expect(result).toBe(RESOURCE_NOT_FOUND);
      }
    );

    it('rethrows a message-only "not found" under a different name (no sentinel)', async () => {
      mockSend.mockRejectedValueOnce(
        Object.assign(new Error('FileSystemNotFound: fs-1 not found'), { name: 'BadRequest' })
      );
      await expect(
        provider.readCurrentState('fs-1', 'L', 'AWS::EFS::FileSystem')
      ).rejects.toThrow('not found');
    });

    it('rethrows AccessDenied on DescribeFileSystems (no sentinel)', async () => {
      mockSend.mockRejectedValueOnce(
        Object.assign(new Error('denied'), { name: 'AccessDeniedException' })
      );
      await expect(
        provider.readCurrentState('fs-1', 'L', 'AWS::EFS::FileSystem')
      ).rejects.toThrow('denied');
    });

    it('omits the key (no sentinel) on a message-only "not found" or AccessDenied from a sub-call', async () => {
      mockSend
        .mockResolvedValueOnce({ FileSystems: [fsItem] })
        .mockRejectedValueOnce(
          Object.assign(new Error('FileSystemNotFound: not found'), { name: 'BadRequest' })
        )
        .mockRejectedValueOnce(
          Object.assign(new Error('denied'), { name: 'AccessDeniedException' })
        )
        .mockRejectedValueOnce(Object.assign(new Error('not found'), { name: 'PolicyNotFound' }));
      const result = await provider.readCurrentState('fs-1', 'L', 'AWS::EFS::FileSystem');
      expect(result).toEqual({
        PerformanceMode: 'generalPurpose',
        Encrypted: false,
        FileSystemTags: [],
      });
    });

    it('surfaces FileSystemTags from DescribeFileSystems with aws:* filtered out', async () => {
      mockSend
        .mockResolvedValueOnce({
          FileSystems: [
            {
              FileSystemId: 'fs-1',
              PerformanceMode: 'generalPurpose',
              Tags: [
                { Key: 'Foo', Value: 'Bar' },
                { Key: 'aws:cdk:path', Value: 'MyStack/MyFs/Resource' },
              ],
            },
          ],
        })
        .mockRejectedValueOnce(Object.assign(new Error('PolicyNotFound'), { name: 'PolicyNotFound' }))
        .mockRejectedValueOnce(Object.assign(new Error('PolicyNotFound'), { name: 'PolicyNotFound' }));

      const result = await provider.readCurrentState('fs-1', 'L', 'AWS::EFS::FileSystem');
      expect(bagOf(result).FileSystemTags).toEqual([{ Key: 'Foo', Value: 'Bar' }]);
    });

    it('emits empty FileSystemTags placeholder when DescribeFileSystems returns no user tags', async () => {
      mockSend
        .mockResolvedValueOnce({
          FileSystems: [
            {
              FileSystemId: 'fs-1',
              PerformanceMode: 'generalPurpose',
              Tags: [{ Key: 'aws:cdk:path', Value: 'MyStack/MyFs/Resource' }],
            },
          ],
        })
        .mockRejectedValueOnce(Object.assign(new Error('PolicyNotFound'), { name: 'PolicyNotFound' }))
        .mockRejectedValueOnce(Object.assign(new Error('PolicyNotFound'), { name: 'PolicyNotFound' }));

      const result = await provider.readCurrentState('fs-1', 'L', 'AWS::EFS::FileSystem');
      expect(bagOf(result).FileSystemTags).toEqual([]);
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

    it('returns RESOURCE_NOT_FOUND when AP is gone', async () => {
      mockSend.mockRejectedValueOnce(
        new AccessPointNotFound({
          message: 'gone',
          $metadata: {},
          ErrorCode: 'AccessPointNotFound',
        })
      );
      const result = await provider.readCurrentState('fsap-1', 'L', 'AWS::EFS::AccessPoint');
      expect(result).toBe(RESOURCE_NOT_FOUND);
    });

    it('returns RESOURCE_NOT_FOUND on an empty AccessPoints list for the id', async () => {
      mockSend.mockResolvedValueOnce({ AccessPoints: [] });
      const result = await provider.readCurrentState('fsap-1', 'L', 'AWS::EFS::AccessPoint');
      expect(result).toBe(RESOURCE_NOT_FOUND);
    });

    it('keeps undefined when DescribeAccessPoints answers with no list at all (empty body)', async () => {
      mockSend.mockResolvedValueOnce({});
      const result = await provider.readCurrentState('fsap-1', 'L', 'AWS::EFS::AccessPoint');
      expect(result).toBeUndefined();
    });

    it('rethrows AccessDenied on DescribeAccessPoints (no sentinel)', async () => {
      mockSend.mockRejectedValueOnce(
        Object.assign(new Error('denied'), { name: 'AccessDeniedException' })
      );
      await expect(
        provider.readCurrentState('fsap-1', 'L', 'AWS::EFS::AccessPoint')
      ).rejects.toThrow('denied');
    });
  });

  describe('AWS::EFS::MountTarget', () => {
    it('returns FileSystemId + SubnetId + SecurityGroups from DescribeMountTargets + DescribeMountTargetSecurityGroups', async () => {
      mockSend
        .mockResolvedValueOnce({
          MountTargets: [
            { MountTargetId: 'fsmt-1', FileSystemId: 'fs-1', SubnetId: 'subnet-1' },
          ],
        })
        .mockResolvedValueOnce({ SecurityGroups: ['sg-1', 'sg-2'] });

      const result = await provider.readCurrentState('fsmt-1', 'L', 'AWS::EFS::MountTarget');

      expect(mockSend.mock.calls[0]?.[0]).toBeInstanceOf(DescribeMountTargetsCommand);
      expect(result).toEqual({
        FileSystemId: 'fs-1',
        SubnetId: 'subnet-1',
        SecurityGroups: ['sg-1', 'sg-2'],
      });
    });

    it('emits empty SecurityGroups placeholder when AWS reports none', async () => {
      mockSend
        .mockResolvedValueOnce({
          MountTargets: [
            { MountTargetId: 'fsmt-1', FileSystemId: 'fs-1', SubnetId: 'subnet-1' },
          ],
        })
        .mockResolvedValueOnce({ SecurityGroups: [] });

      const result = await provider.readCurrentState('fsmt-1', 'L', 'AWS::EFS::MountTarget');
      expect(bagOf(result).SecurityGroups).toEqual([]);
    });

    it('returns RESOURCE_NOT_FOUND when MT is gone', async () => {
      mockSend.mockRejectedValueOnce(
        new MountTargetNotFound({
          message: 'gone',
          $metadata: {},
          ErrorCode: 'MountTargetNotFound',
        })
      );
      const result = await provider.readCurrentState('fsmt-1', 'L', 'AWS::EFS::MountTarget');
      expect(result).toBe(RESOURCE_NOT_FOUND);
    });

    it('returns RESOURCE_NOT_FOUND on an empty MountTargets list for the id', async () => {
      mockSend.mockResolvedValueOnce({ MountTargets: [] });
      const result = await provider.readCurrentState('fsmt-1', 'L', 'AWS::EFS::MountTarget');
      expect(result).toBe(RESOURCE_NOT_FOUND);
    });

    it('keeps undefined when DescribeMountTargets answers with no list at all (empty body)', async () => {
      mockSend.mockResolvedValueOnce({});
      const result = await provider.readCurrentState('fsmt-1', 'L', 'AWS::EFS::MountTarget');
      expect(result).toBeUndefined();
    });

    it('rethrows a message-only "not found" under a different name (no sentinel)', async () => {
      mockSend.mockRejectedValueOnce(
        Object.assign(new Error('MountTargetNotFound: not found'), { name: 'BadRequest' })
      );
      await expect(
        provider.readCurrentState('fsmt-1', 'L', 'AWS::EFS::MountTarget')
      ).rejects.toThrow('not found');
    });
  });
});
