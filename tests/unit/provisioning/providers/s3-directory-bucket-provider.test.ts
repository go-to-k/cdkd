import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  CreateBucketCommand,
  DeleteBucketCommand,
  HeadBucketCommand,
  ListDirectoryBucketsCommand,
  GetBucketTaggingCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
} from '@aws-sdk/client-s3';

// Mock AWS clients before importing the provider
const mockSend = vi.fn();
const mockEc2Send = vi.hoisted(() => vi.fn());

vi.mock('@aws-sdk/client-ec2', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-ec2')>();
  return {
    ...actual,
    EC2Client: vi.fn().mockImplementation(() => ({
      send: mockEc2Send,
    })),
  };
});

vi.mock('../../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    s3: {
      send: mockSend,
      config: {
        region: () => 'us-east-1',
      },
    },
    sts: { send: mockSend },
  }),
}));

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

import { S3DirectoryBucketProvider } from '../../../../src/provisioning/providers/s3-directory-bucket-provider.js';

describe('S3DirectoryBucketProvider', () => {
  let provider: S3DirectoryBucketProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    // Default EC2 mock: resolve AZ name to AZ ID
    mockEc2Send.mockResolvedValue({
      AvailabilityZones: [{ ZoneId: 'use1-az4', ZoneName: 'us-east-1c' }],
    });
    provider = new S3DirectoryBucketProvider();
  });

  describe('create', () => {
    it('should create a directory bucket and return physicalId and Arn', async () => {
      // CreateBucketCommand succeeds, then GetCallerIdentity for buildAttributes
      mockSend
        .mockResolvedValueOnce({}) // CreateBucketCommand
        .mockResolvedValueOnce({ Account: '123456789012' }); // GetCallerIdentityCommand

      const result = await provider.create(
        'DirectoryBucket',
        'AWS::S3Express::DirectoryBucket',
        {
          BucketName: 'my-bucket--use1-az4--x-s3',
          DataRedundancy: 'SingleAvailabilityZone',
          LocationName: 'us-east-1c--x-s3',
        }
      );

      expect(result.physicalId).toBe('my-bucket--use1-az4--x-s3');
      expect(result.attributes).toEqual({
        Arn: 'arn:aws:s3express:us-east-1:123456789012:bucket/my-bucket--use1-az4--x-s3',
      });

      expect(mockSend).toHaveBeenCalledTimes(2);
      expect(mockSend.mock.calls[0][0]).toBeInstanceOf(CreateBucketCommand);
      expect(mockSend.mock.calls[0][0].input).toEqual({
        Bucket: 'my-bucket--use1-az4--x-s3',
        CreateBucketConfiguration: {
          Bucket: {
            Type: 'Directory',
            DataRedundancy: 'SingleAvailabilityZone',
          },
          Location: {
            Name: 'use1-az4',
            Type: 'AvailabilityZone',
          },
        },
      });
    });

    it('should auto-generate bucket name when BucketName is not provided', async () => {
      mockSend
        .mockResolvedValueOnce({}) // CreateBucketCommand
        .mockResolvedValueOnce({ Account: '123456789012' }); // STS GetCallerIdentity

      const result = await provider.create('DirectoryBucket', 'AWS::S3Express::DirectoryBucket', {
        DataRedundancy: 'SingleAvailabilityZone',
        LocationName: 'us-east-1c--x-s3',
      });

      expect(result.physicalId).toContain('--use1-az4--x-s3');
    });
  });

  describe('delete', () => {
    it('should delete an empty directory bucket', async () => {
      // ListObjectsV2 returns no objects, then DeleteBucketCommand succeeds
      mockSend
        .mockResolvedValueOnce({ Contents: undefined, IsTruncated: false }) // ListObjectsV2
        .mockResolvedValueOnce({}); // DeleteBucketCommand

      await provider.delete(
        'DirectoryBucket',
        'my-bucket--use1-az4--x-s3',
        'AWS::S3Express::DirectoryBucket'
      );

      expect(mockSend).toHaveBeenCalledTimes(2);
      expect(mockSend.mock.calls[0][0]).toBeInstanceOf(ListObjectsV2Command);
      expect(mockSend.mock.calls[1][0]).toBeInstanceOf(DeleteBucketCommand);
      expect(mockSend.mock.calls[1][0].input).toEqual({
        Bucket: 'my-bucket--use1-az4--x-s3',
      });
    });

    it('should empty bucket with objects before deleting', async () => {
      // ListObjectsV2 returns objects, DeleteObjects, then DeleteBucket
      mockSend
        .mockResolvedValueOnce({
          Contents: [{ Key: 'file1.txt' }, { Key: 'file2.txt' }],
          IsTruncated: false,
        }) // ListObjectsV2
        .mockResolvedValueOnce({}) // DeleteObjectsCommand
        .mockResolvedValueOnce({}); // DeleteBucketCommand

      await provider.delete(
        'DirectoryBucket',
        'my-bucket--use1-az4--x-s3',
        'AWS::S3Express::DirectoryBucket'
      );

      expect(mockSend).toHaveBeenCalledTimes(3);
      expect(mockSend.mock.calls[0][0]).toBeInstanceOf(ListObjectsV2Command);
      expect(mockSend.mock.calls[1][0]).toBeInstanceOf(DeleteObjectsCommand);
      expect(mockSend.mock.calls[1][0].input).toEqual({
        Bucket: 'my-bucket--use1-az4--x-s3',
        Delete: {
          Objects: [{ Key: 'file1.txt' }, { Key: 'file2.txt' }],
          Quiet: true,
        },
      });
      expect(mockSend.mock.calls[2][0]).toBeInstanceOf(DeleteBucketCommand);
    });

    it('should handle bucket not found (idempotent)', async () => {
      const error = new Error('NoSuchBucket');
      error.name = 'NoSuchBucket';
      mockSend.mockRejectedValueOnce(error);

      await expect(
        provider.delete(
          'DirectoryBucket',
          'my-bucket--use1-az4--x-s3',
          'AWS::S3Express::DirectoryBucket'
        )
      ).resolves.not.toThrow();

      expect(mockSend).toHaveBeenCalledTimes(1);
    });
  });

  describe('update', () => {
    it('should be a no-op and return existing physicalId', async () => {
      const result = await provider.update(
        'DirectoryBucket',
        'my-bucket--use1-az4--x-s3',
        'AWS::S3Express::DirectoryBucket',
        { BucketName: 'my-bucket--use1-az4--x-s3' },
        { BucketName: 'my-bucket--use1-az4--x-s3' }
      );

      expect(result).toEqual({
        physicalId: 'my-bucket--use1-az4--x-s3',
        wasReplaced: false,
      });
      expect(mockSend).not.toHaveBeenCalled();
    });
  });

  describe('import', () => {
    function makeInput(overrides: Record<string, unknown> = {}) {
      return {
        logicalId: 'DirectoryBucket',
        resourceType: 'AWS::S3Express::DirectoryBucket',
        cdkPath: 'MyStack/DirectoryBucket',
        stackName: 'MyStack',
        region: 'us-east-1',
        properties: {} as Record<string, unknown>,
        ...overrides,
      };
    }

    it('verifies explicit BucketName property via HeadBucket', async () => {
      mockSend.mockResolvedValueOnce({}); // HeadBucket
      const result = await provider.import!(
        makeInput({ properties: { BucketName: 'my-bucket--use1-az4--x-s3' } })
      );
      expect(result).toEqual({ physicalId: 'my-bucket--use1-az4--x-s3', attributes: {} });
      expect(mockSend.mock.calls[0][0]).toBeInstanceOf(HeadBucketCommand);
    });

    it('returns null when explicit name does not exist', async () => {
      const err = new Error('NotFound') as Error & { name: string };
      err.name = 'NotFound';
      mockSend.mockRejectedValueOnce(err);
      const result = await provider.import!(makeInput({ knownPhysicalId: 'missing--az--x-s3' }));
      expect(result).toBeNull();
    });

    it('finds matching directory bucket by aws:cdk:path tag', async () => {
      mockSend
        .mockResolvedValueOnce({
          Buckets: [
            { Name: 'other--az--x-s3' },
            { Name: 'mine--az--x-s3' },
          ],
        }) // ListDirectoryBuckets
        .mockResolvedValueOnce({ TagSet: [{ Key: 'foo', Value: 'bar' }] }) // GetBucketTagging - other
        .mockResolvedValueOnce({
          TagSet: [{ Key: 'aws:cdk:path', Value: 'MyStack/DirectoryBucket' }],
        }); // GetBucketTagging - mine

      const result = await provider.import!(makeInput());
      expect(result).toEqual({ physicalId: 'mine--az--x-s3', attributes: {} });
      expect(mockSend.mock.calls[0][0]).toBeInstanceOf(ListDirectoryBucketsCommand);
      expect(mockSend.mock.calls[1][0]).toBeInstanceOf(GetBucketTaggingCommand);
    });

    it('returns null when no bucket matches', async () => {
      mockSend
        .mockResolvedValueOnce({ Buckets: [{ Name: 'other--az--x-s3' }] })
        .mockResolvedValueOnce({ TagSet: [{ Key: 'foo', Value: 'bar' }] });
      const result = await provider.import!(makeInput());
      expect(result).toBeNull();
    });
  });
});
