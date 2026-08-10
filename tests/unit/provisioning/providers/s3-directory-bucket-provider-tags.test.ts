import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { CreateBucketCommand } from '@aws-sdk/client-s3';
import { TagResourceCommand, UntagResourceCommand } from '@aws-sdk/client-s3-control';

// Mock AWS clients before importing the provider
const mockS3Send = vi.fn();
const mockStsSend = vi.fn();
const mockEc2Send = vi.hoisted(() => vi.fn());
const mockControlSend = vi.hoisted(() => vi.fn());

vi.mock('@aws-sdk/client-ec2', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-ec2')>();
  return {
    ...actual,
    EC2Client: vi.fn().mockImplementation(() => ({
      send: mockEc2Send,
    })),
  };
});

vi.mock('@aws-sdk/client-s3-control', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-s3-control')>();
  return {
    ...actual,
    S3ControlClient: vi.fn().mockImplementation(() => ({
      send: mockControlSend,
    })),
  };
});

vi.mock('../../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    s3: {
      send: mockS3Send,
      config: {
        region: () => Promise.resolve('us-east-1'),
      },
    },
    sts: { send: mockStsSend },
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
import { ProvisioningError } from '../../../../src/utils/error-handler.js';

const PHYSICAL_ID = 'my-bucket--use1-az4--x-s3';
const RESOURCE_TYPE = 'AWS::S3Express::DirectoryBucket';
const ARN = `arn:aws:s3express:us-east-1:123456789012:bucket/${PHYSICAL_ID}`;

describe('S3DirectoryBucketProvider Tags (issue #609)', () => {
  let provider: S3DirectoryBucketProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    mockEc2Send.mockResolvedValue({
      AvailabilityZones: [{ ZoneId: 'use1-az4', ZoneName: 'us-east-1c' }],
    });
    mockStsSend.mockResolvedValue({ Account: '123456789012' });
    provider = new S3DirectoryBucketProvider();
  });

  describe('create', () => {
    it('forwards a malformed non-array Tags verbatim (AWS rejects loudly)', async () => {
      mockS3Send.mockResolvedValue({});
      const malformed = { team: 'not-a-tag-array' };

      await provider.create('DirectoryBucket', RESOURCE_TYPE, {
        BucketName: PHYSICAL_ID,
        DataRedundancy: 'SingleAvailabilityZone',
        LocationName: 'us-east-1c--x-s3',
        Tags: malformed,
      });

      expect(mockS3Send.mock.calls[0][0].input.CreateBucketConfiguration.Tags).toBe(malformed);
    });

    it('forwards Tags on CreateBucketConfiguration', async () => {
      mockS3Send.mockResolvedValueOnce({}); // CreateBucketCommand

      await provider.create('DirectoryBucket', RESOURCE_TYPE, {
        BucketName: PHYSICAL_ID,
        DataRedundancy: 'SingleAvailabilityZone',
        LocationName: 'us-east-1c--x-s3',
        Tags: [
          { Key: 'team', Value: 'platform' },
          { Key: 'aws-cdk:auto-delete-objects', Value: 'true' },
        ],
      });

      expect(mockS3Send.mock.calls[0][0]).toBeInstanceOf(CreateBucketCommand);
      expect(mockS3Send.mock.calls[0][0].input.CreateBucketConfiguration.Tags).toEqual([
        { Key: 'team', Value: 'platform' },
        { Key: 'aws-cdk:auto-delete-objects', Value: 'true' },
      ]);
    });

    it('omits the Tags member for an absent or empty Tags property', async () => {
      mockS3Send.mockResolvedValue({});

      await provider.create('DirectoryBucket', RESOURCE_TYPE, {
        BucketName: PHYSICAL_ID,
        DataRedundancy: 'SingleAvailabilityZone',
        LocationName: 'us-east-1c--x-s3',
        Tags: [],
      });

      expect(mockS3Send.mock.calls[0][0].input.CreateBucketConfiguration).not.toHaveProperty(
        'Tags'
      );
    });
  });

  describe('update', () => {
    it('applies added and changed tags via S3 Control TagResource', async () => {
      mockControlSend.mockResolvedValue({});

      const result = await provider.update(
        'DirectoryBucket',
        PHYSICAL_ID,
        RESOURCE_TYPE,
        {
          Tags: [
            { Key: 'team', Value: 'platform-renamed' },
            { Key: 'added', Value: 'yes' },
          ],
        },
        { Tags: [{ Key: 'team', Value: 'platform' }] }
      );

      expect(result).toEqual({ physicalId: PHYSICAL_ID, wasReplaced: false });
      expect(mockControlSend).toHaveBeenCalledTimes(1);
      const cmd = mockControlSend.mock.calls[0][0];
      expect(cmd).toBeInstanceOf(TagResourceCommand);
      expect(cmd.input).toEqual({
        AccountId: '123456789012',
        ResourceArn: ARN,
        Tags: [
          { Key: 'team', Value: 'platform-renamed' },
          { Key: 'added', Value: 'yes' },
        ],
      });
    });

    it('untags removed keys, then re-applies the surviving set', async () => {
      mockControlSend.mockResolvedValue({});

      await provider.update(
        'DirectoryBucket',
        PHYSICAL_ID,
        RESOURCE_TYPE,
        { Tags: [{ Key: 'keep', Value: 'v' }] },
        {
          Tags: [
            { Key: 'keep', Value: 'v' },
            { Key: 'dropped', Value: 'v' },
          ],
        }
      );

      expect(mockControlSend).toHaveBeenCalledTimes(2);
      const untag = mockControlSend.mock.calls[0][0];
      expect(untag).toBeInstanceOf(UntagResourceCommand);
      expect(untag.input).toEqual({
        AccountId: '123456789012',
        ResourceArn: ARN,
        TagKeys: ['dropped'],
      });
      expect(mockControlSend.mock.calls[1][0]).toBeInstanceOf(TagResourceCommand);
    });

    it('removing the whole Tags property untags every previous key (no TagResource)', async () => {
      // TagResource is additive-only: without the explicit UntagResource the
      // dropped property would silently keep its live tags (the #1160 class).
      mockControlSend.mockResolvedValue({});

      await provider.update('DirectoryBucket', PHYSICAL_ID, RESOURCE_TYPE, {}, {
        Tags: [
          { Key: 'a', Value: '1' },
          { Key: 'b', Value: '2' },
        ],
      });

      expect(mockControlSend).toHaveBeenCalledTimes(1);
      const untag = mockControlSend.mock.calls[0][0];
      expect(untag).toBeInstanceOf(UntagResourceCommand);
      expect(untag.input.TagKeys).toEqual(['a', 'b']);
    });

    it('is a no-op when tags are unchanged', async () => {
      const tags = [{ Key: 'same', Value: 'v' }];
      await provider.update(
        'DirectoryBucket',
        PHYSICAL_ID,
        RESOURCE_TYPE,
        { Tags: tags },
        { Tags: [{ Key: 'same', Value: 'v' }] }
      );

      expect(mockControlSend).not.toHaveBeenCalled();
      expect(mockStsSend).not.toHaveBeenCalled();
    });

    it('forwards a malformed non-array Tags verbatim and never untags from garbage', async () => {
      // Same policy as create: AWS rejects the malformed value loudly.
      // Computing "removed keys" against garbage would silently strip every
      // live tag (reviewer catch on PR #1528).
      mockControlSend.mockResolvedValue({});
      const malformed = { team: 'not-a-tag-array' };

      await provider.update(
        'DirectoryBucket',
        PHYSICAL_ID,
        RESOURCE_TYPE,
        { Tags: malformed },
        { Tags: [{ Key: 'keep-me', Value: 'v' }] }
      );

      expect(mockControlSend).toHaveBeenCalledTimes(1);
      const cmd = mockControlSend.mock.calls[0][0];
      expect(cmd).toBeInstanceOf(TagResourceCommand);
      expect(cmd.input.Tags).toBe(malformed);
    });

    it('wraps S3 Control failures in ProvisioningError', async () => {
      mockControlSend.mockRejectedValue(new Error('AccessDenied'));

      await expect(
        provider.update(
          'DirectoryBucket',
          PHYSICAL_ID,
          RESOURCE_TYPE,
          { Tags: [{ Key: 'a', Value: '1' }] },
          {}
        )
      ).rejects.toThrow(ProvisioningError);
    });
  });

  describe('readCurrentState', () => {
    it('fails loudly when the tag read errors (no silent placeholder)', async () => {
      // A silent `Tags: []` placeholder on a permission error would read as
      // "all tags removed" phantom drift; propagating is the honest failure.
      mockS3Send.mockResolvedValueOnce({}); // HeadBucket
      mockControlSend.mockRejectedValueOnce(new Error('AccessDenied'));

      await expect(
        provider.readCurrentState(PHYSICAL_ID, 'Logical', RESOURCE_TYPE)
      ).rejects.toThrow('AccessDenied');
    });

    it('surfaces Tags from S3 Control ListTagsForResource', async () => {
      mockS3Send.mockResolvedValueOnce({}); // HeadBucket
      mockControlSend.mockResolvedValueOnce({
        Tags: [{ Key: 'team', Value: 'platform' }],
      });

      const result = await provider.readCurrentState(PHYSICAL_ID, 'Logical', RESOURCE_TYPE);

      expect(result?.['Tags']).toEqual([{ Key: 'team', Value: 'platform' }]);
      const listCmd = mockControlSend.mock.calls[0][0];
      expect(listCmd.input).toEqual({ AccountId: '123456789012', ResourceArn: ARN });
    });
  });
});
