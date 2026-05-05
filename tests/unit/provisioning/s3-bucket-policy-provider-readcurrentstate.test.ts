import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GetBucketPolicyCommand, NoSuchBucket } from '@aws-sdk/client-s3';

const mockSend = vi.fn();

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    s3: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
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

import { S3BucketPolicyProvider } from '../../../src/provisioning/providers/s3-bucket-policy-provider.js';

describe('S3BucketPolicyProvider.readCurrentState', () => {
  let provider: S3BucketPolicyProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new S3BucketPolicyProvider();
  });

  it('returns Bucket + JSON-parsed PolicyDocument (happy path)', async () => {
    const policy = {
      Version: '2012-10-17',
      Statement: [
        { Effect: 'Allow', Principal: '*', Action: 's3:GetObject', Resource: 'arn:...' },
      ],
    };
    mockSend.mockResolvedValueOnce({ Policy: JSON.stringify(policy) });

    const result = await provider.readCurrentState(
      'my-bucket',
      'Logical',
      'AWS::S3::BucketPolicy'
    );

    expect(mockSend.mock.calls[0]?.[0]).toBeInstanceOf(GetBucketPolicyCommand);
    expect(result).toEqual({
      Bucket: 'my-bucket',
      PolicyDocument: policy,
    });
  });

  it('returns undefined when bucket gone', async () => {
    mockSend.mockRejectedValueOnce(new NoSuchBucket({ message: 'gone', $metadata: {} }));

    const result = await provider.readCurrentState(
      'my-bucket',
      'Logical',
      'AWS::S3::BucketPolicy'
    );
    expect(result).toBeUndefined();
  });

  it('returns undefined when bucket has no attached policy', async () => {
    const err = new Error('No policy');
    (err as { name?: string }).name = 'NoSuchBucketPolicy';
    mockSend.mockRejectedValueOnce(err);

    const result = await provider.readCurrentState(
      'my-bucket',
      'Logical',
      'AWS::S3::BucketPolicy'
    );
    expect(result).toBeUndefined();
  });
});
