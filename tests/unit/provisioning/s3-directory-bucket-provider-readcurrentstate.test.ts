import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HeadBucketCommand } from '@aws-sdk/client-s3';

const mockS3Send = vi.fn();
const mockStsSend = vi.fn();

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    s3: { send: mockS3Send, config: { region: () => Promise.resolve('us-east-1') } },
    sts: { send: mockStsSend, config: { region: () => Promise.resolve('us-east-1') } },
  }),
}));

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

import { S3DirectoryBucketProvider } from '../../../src/provisioning/providers/s3-directory-bucket-provider.js';

describe('S3DirectoryBucketProvider.readCurrentState', () => {
  let provider: S3DirectoryBucketProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new S3DirectoryBucketProvider();
  });

  it('returns BucketName + DataRedundancy (happy path)', async () => {
    mockS3Send.mockResolvedValueOnce({});

    const result = await provider.readCurrentState(
      'my-bucket--use1-az1--x-s3',
      'Logical',
      'AWS::S3Express::DirectoryBucket'
    );

    expect(mockS3Send.mock.calls[0]?.[0]).toBeInstanceOf(HeadBucketCommand);
    expect(result).toEqual({
      BucketName: 'my-bucket--use1-az1--x-s3',
      DataRedundancy: 'SingleAvailabilityZone',
    });
  });

  it('returns undefined when bucket gone (NotFound)', async () => {
    const err = new Error('not found');
    (err as { name?: string }).name = 'NotFound';
    mockS3Send.mockRejectedValueOnce(err);

    const result = await provider.readCurrentState(
      'my-bucket--use1-az1--x-s3',
      'Logical',
      'AWS::S3Express::DirectoryBucket'
    );
    expect(result).toBeUndefined();
  });
});
