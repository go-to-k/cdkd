import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  CreateBucketCommand,
  DeleteBucketCommand,
  HeadBucketCommand,
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

// Mutable so a test can drive the client's region (issue #1815 partition
// derivation). Reset to `us-east-1` in `beforeEach`.
const clientRegion = vi.hoisted(() => ({ value: 'us-east-1' as string | undefined }));

vi.mock('../../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    s3: {
      send: mockSend,
      config: {
        region: () => clientRegion.value,
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
    clientRegion.value = 'us-east-1';
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
    it('should delete an empty directory bucket without listing objects (no opt-in)', async () => {
      // Data guard (issue #1344): without an opt-in the proactive empty is
      // skipped entirely — DeleteBucket is the only call.
      mockSend.mockResolvedValueOnce({}); // DeleteBucketCommand

      await provider.delete(
        'DirectoryBucket',
        'my-bucket--use1-az4--x-s3',
        'AWS::S3Express::DirectoryBucket'
      );

      expect(mockSend).toHaveBeenCalledTimes(1);
      expect(mockSend.mock.calls[0][0]).toBeInstanceOf(DeleteBucketCommand);
      expect(mockSend.mock.calls[0][0].input).toEqual({
        Bucket: 'my-bucket--use1-az4--x-s3',
      });
    });

    it('refuses to delete a non-empty bucket without an opt-in (CFn parity, issue #1344)', async () => {
      const notEmpty = new Error('The bucket you tried to delete is not empty');
      notEmpty.name = 'BucketNotEmpty';
      mockSend.mockRejectedValue(notEmpty); // the single DeleteBucketCommand attempt fails

      await expect(
        provider.delete(
          'DirectoryBucket',
          'my-bucket--use1-az4--x-s3',
          'AWS::S3Express::DirectoryBucket'
        )
      ).rejects.toThrow(/not empty.*aws s3 rm/s);

      // The guard must fire WITHOUT touching the data.
      const names = mockSend.mock.calls.map((c) => c[0].constructor.name);
      expect(names).not.toContain('ListObjectsV2Command');
      expect(names).not.toContain('DeleteObjectsCommand');
    });

    it('empties bucket with objects before deleting when forceDataDelete is set', async () => {
      // The ported empty-retry loop (#609): the first DeleteBucket attempt
      // surfaces not-empty, then the opt-in empties and retries.
      const notEmpty = new Error('The bucket you tried to delete is not empty');
      notEmpty.name = 'BucketNotEmpty';
      mockSend
        .mockRejectedValueOnce(notEmpty) // DeleteBucketCommand (attempt 1)
        .mockResolvedValueOnce({
          Contents: [{ Key: 'file1.txt' }, { Key: 'file2.txt' }],
          IsTruncated: false,
        }) // ListObjectsV2
        .mockResolvedValueOnce({}) // DeleteObjectsCommand
        .mockResolvedValueOnce({}); // DeleteBucketCommand (attempt 2)

      await provider.delete(
        'DirectoryBucket',
        'my-bucket--use1-az4--x-s3',
        'AWS::S3Express::DirectoryBucket',
        undefined,
        { forceDataDelete: true }
      );

      expect(mockSend).toHaveBeenCalledTimes(4);
      expect(mockSend.mock.calls[0][0]).toBeInstanceOf(DeleteBucketCommand);
      expect(mockSend.mock.calls[1][0]).toBeInstanceOf(ListObjectsV2Command);
      expect(mockSend.mock.calls[2][0]).toBeInstanceOf(DeleteObjectsCommand);
      expect(mockSend.mock.calls[2][0].input).toEqual({
        Bucket: 'my-bucket--use1-az4--x-s3',
        Delete: {
          Objects: [{ Key: 'file1.txt' }, { Key: 'file2.txt' }],
          Quiet: true,
        },
      });
      expect(mockSend.mock.calls[3][0]).toBeInstanceOf(DeleteBucketCommand);
    });

    it('re-empties and retries when a write races the opted-in auto-empty (bounded)', async () => {
      // An object written between the empty pass and the delete makes AWS
      // reject the retry as not-empty again; the loop re-empties (attempt 2)
      // and the third delete succeeds — the standard-bucket race loop, ported
      // per issue #609.
      const notEmpty = new Error('The bucket you tried to delete is not empty');
      notEmpty.name = 'BucketNotEmpty';
      mockSend
        .mockRejectedValueOnce(notEmpty) // DeleteBucket (attempt 1)
        .mockResolvedValueOnce({ Contents: [{ Key: 'a.txt' }], IsTruncated: false }) // List
        .mockResolvedValueOnce({}) // DeleteObjects
        .mockRejectedValueOnce(notEmpty) // DeleteBucket (attempt 2) — lost the race
        .mockResolvedValueOnce({ Contents: [{ Key: 'raced.txt' }], IsTruncated: false }) // List
        .mockResolvedValueOnce({}) // DeleteObjects
        .mockResolvedValueOnce({}); // DeleteBucket (attempt 3)

      await provider.delete(
        'DirectoryBucket',
        'my-bucket--use1-az4--x-s3',
        'AWS::S3Express::DirectoryBucket',
        undefined,
        { forceDataDelete: true }
      );

      const names = mockSend.mock.calls.map((c) => c[0].constructor.name);
      expect(names).toEqual([
        'DeleteBucketCommand',
        'ListObjectsV2Command',
        'DeleteObjectsCommand',
        'DeleteBucketCommand',
        'ListObjectsV2Command',
        'DeleteObjectsCommand',
        'DeleteBucketCommand',
      ]);
    });

    it('ignores an auto-delete tag whose value is not truthy', async () => {
      const notEmpty = new Error('The bucket you tried to delete is not empty');
      notEmpty.name = 'BucketNotEmpty';
      mockSend.mockRejectedValue(notEmpty);

      await expect(
        provider.delete(
          'DirectoryBucket',
          'my-bucket--use1-az4--x-s3',
          'AWS::S3Express::DirectoryBucket',
          { Tags: [{ Key: 'aws-cdk:auto-delete-objects', Value: 'false' }] },
          undefined
        )
      ).rejects.toThrow(/not empty/);

      const names = mockSend.mock.calls.map((c) => c[0].constructor.name);
      expect(names).not.toContain('ListObjectsV2Command');
      expect(names).not.toContain('DeleteObjectsCommand');
    });

    it('empties bucket before deleting when the aws-cdk:auto-delete-objects tag is present', async () => {
      const notEmpty = new Error('The bucket you tried to delete is not empty');
      notEmpty.name = 'BucketNotEmpty';
      mockSend
        .mockRejectedValueOnce(notEmpty) // DeleteBucketCommand (attempt 1)
        .mockResolvedValueOnce({ Contents: [{ Key: 'f.txt' }], IsTruncated: false }) // ListObjectsV2
        .mockResolvedValueOnce({}) // DeleteObjectsCommand
        .mockResolvedValueOnce({}); // DeleteBucketCommand (attempt 2)

      await provider.delete(
        'DirectoryBucket',
        'my-bucket--use1-az4--x-s3',
        'AWS::S3Express::DirectoryBucket',
        { Tags: [{ Key: 'aws-cdk:auto-delete-objects', Value: 'true' }] },
        undefined
      );

      expect(mockSend.mock.calls[0][0]).toBeInstanceOf(DeleteBucketCommand);
      expect(mockSend.mock.calls[1][0]).toBeInstanceOf(ListObjectsV2Command);
      expect(mockSend.mock.calls[2][0]).toBeInstanceOf(DeleteObjectsCommand);
      expect(mockSend.mock.calls[3][0]).toBeInstanceOf(DeleteBucketCommand);
    });

    it('takes the post-loop final delete after exhausting the in-loop attempts', async () => {
      // 3 in-loop delete attempts each lose the race and re-empty; the
      // post-loop final DeleteBucket succeeds (10 calls total).
      const notEmpty = new Error('The bucket you tried to delete is not empty');
      notEmpty.name = 'BucketNotEmpty';
      const emptyCycle = [
        { Contents: [{ Key: 'raced.txt' }], IsTruncated: false }, // ListObjectsV2
        {}, // DeleteObjects
      ];
      mockSend
        .mockRejectedValueOnce(notEmpty) // DeleteBucket (attempt 1)
        .mockResolvedValueOnce(emptyCycle[0])
        .mockResolvedValueOnce(emptyCycle[1])
        .mockRejectedValueOnce(notEmpty) // DeleteBucket (attempt 2)
        .mockResolvedValueOnce(emptyCycle[0])
        .mockResolvedValueOnce(emptyCycle[1])
        .mockRejectedValueOnce(notEmpty) // DeleteBucket (attempt 3)
        .mockResolvedValueOnce(emptyCycle[0])
        .mockResolvedValueOnce(emptyCycle[1])
        .mockResolvedValueOnce({}); // DeleteBucket (post-loop final attempt)

      await provider.delete(
        'DirectoryBucket',
        'my-bucket--use1-az4--x-s3',
        'AWS::S3Express::DirectoryBucket',
        undefined,
        { forceDataDelete: true }
      );

      const names = mockSend.mock.calls.map((c) => c[0].constructor.name);
      expect(names.filter((n) => n === 'DeleteBucketCommand')).toHaveLength(4);
      expect(names[names.length - 1]).toBe('DeleteBucketCommand');
    });

    it('surfaces the raw not-empty error (no guard remediation text) when even the final attempt fails', async () => {
      const notEmpty = new Error('The bucket you tried to delete is not empty');
      notEmpty.name = 'BucketNotEmpty';
      mockSend.mockImplementation((cmd) => {
        if (cmd.constructor.name === 'DeleteBucketCommand') return Promise.reject(notEmpty);
        if (cmd.constructor.name === 'ListObjectsV2Command') {
          return Promise.resolve({ Contents: [{ Key: 'r.txt' }], IsTruncated: false });
        }
        return Promise.resolve({});
      });

      const p = provider.delete(
        'DirectoryBucket',
        'my-bucket--use1-az4--x-s3',
        'AWS::S3Express::DirectoryBucket',
        undefined,
        { forceDataDelete: true }
      );
      await expect(p).rejects.toThrow(/not empty/);
      // The opted-in exhaustion is NOT the CFn-parity guard: no manual-empty
      // remediation text.
      await expect(p).rejects.not.toThrow(/Matching CloudFormation/);
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

    // Issue #1134: the aws:cdk:path tag walk is removed. AWS rejects
    // aws:-prefixed tag writes, so that tag never exists on a real resource and
    // the walk could not match. Without an explicit id/name, import() returns
    // null with no AWS call.
    it('returns null without any AWS call when no explicit id is given', async () => {
      const result = await provider.import!(makeInput());
      expect(result).toBeNull();
      expect(mockSend).not.toHaveBeenCalled();
    });
  });
  // Issue #1815: `buildBucketArn` hardcoded `arn:aws:`. That value is both
  // recorded into state as the bucket's `Arn` attribute AND handed to S3
  // Control as the `ResourceArn` of a tag mutation, so outside the commercial
  // partition it names no bucket at all.
  describe('ARN partition derivation (issue #1815)', () => {
    async function createInRegion(region: string, azId: string): Promise<unknown> {
      clientRegion.value = region;
      mockEc2Send.mockResolvedValue({
        AvailabilityZones: [{ ZoneId: azId, ZoneName: `${region}c` }],
      });
      mockSend
        .mockResolvedValueOnce({}) // CreateBucketCommand
        .mockResolvedValueOnce({ Account: '123456789012' }); // GetCallerIdentityCommand

      const result = await provider.create('DirectoryBucket', 'AWS::S3Express::DirectoryBucket', {
        BucketName: `my-bucket--${azId}--x-s3`,
        DataRedundancy: 'SingleAvailabilityZone',
        LocationName: `${region}c--x-s3`,
      });
      return (result.attributes as Record<string, unknown>)['Arn'];
    }

    it('uses the aws-cn partition for a cn- region', async () => {
      expect(await createInRegion('cn-north-1', 'cnn1-az1')).toBe(
        'arn:aws-cn:s3express:cn-north-1:123456789012:bucket/my-bucket--cnn1-az1--x-s3'
      );
    });

    it('uses the aws-us-gov partition for a us-gov- region', async () => {
      expect(await createInRegion('us-gov-west-1', 'usgw1-az1')).toBe(
        'arn:aws-us-gov:s3express:us-gov-west-1:123456789012:bucket/my-bucket--usgw1-az1--x-s3'
      );
    });

    // The safety half of the pair: without a non-commercial account to test
    // against, "commercial output is unchanged byte for byte" is what makes
    // the change provably non-breaking.
    it('leaves a commercial region byte-identical to the pre-fix output', async () => {
      expect(await createInRegion('ap-northeast-1', 'apne1-az1')).toBe(
        'arn:aws:s3express:ap-northeast-1:123456789012:bucket/my-bucket--apne1-az1--x-s3'
      );
    });
  });
});
