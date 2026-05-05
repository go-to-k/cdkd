import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GetVectorBucketCommand } from '@aws-sdk/client-s3vectors';

const mockSend = vi.fn();

vi.mock('@aws-sdk/client-s3vectors', async () => {
  const actual = await vi.importActual<typeof import('@aws-sdk/client-s3vectors')>(
    '@aws-sdk/client-s3vectors'
  );
  class MockS3VectorsClient {
    config = { region: () => Promise.resolve('us-east-1') };
    send = mockSend;
  }
  return { ...actual, S3VectorsClient: MockS3VectorsClient };
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

import { S3VectorsProvider } from '../../../src/provisioning/providers/s3-vectors-provider.js';

describe('S3VectorsProvider.readCurrentState', () => {
  let provider: S3VectorsProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new S3VectorsProvider();
  });

  it('returns CFn-shaped properties (happy path, sseType + kmsKeyArn re-shaped)', async () => {
    mockSend.mockResolvedValueOnce({
      vectorBucket: {
        vectorBucketName: 'my-vec-bucket',
        vectorBucketArn: 'arn:aws:s3vectors:us-east-1:123:bucket/my-vec-bucket',
        encryptionConfiguration: {
          sseType: 'aws:kms',
          kmsKeyArn: 'arn:aws:kms:us-east-1:123:key/abc',
        },
        creationTime: new Date(0),
      },
    });

    const result = await provider.readCurrentState(
      'my-vec-bucket',
      'Logical',
      'AWS::S3Vectors::VectorBucket'
    );

    expect(mockSend.mock.calls[0]?.[0]).toBeInstanceOf(GetVectorBucketCommand);
    expect(result).toEqual({
      VectorBucketName: 'my-vec-bucket',
      EncryptionConfiguration: {
        SSEType: 'aws:kms',
        KMSKeyArn: 'arn:aws:kms:us-east-1:123:key/abc',
      },
    });
  });

  it('returns undefined when bucket gone', async () => {
    const err = new Error('not found');
    (err as { name?: string }).name = 'NotFoundException';
    mockSend.mockRejectedValueOnce(err);

    const result = await provider.readCurrentState(
      'my-vec-bucket',
      'Logical',
      'AWS::S3Vectors::VectorBucket'
    );
    expect(result).toBeUndefined();
  });

  it('omits EncryptionConfiguration when AWS returns no encryption', async () => {
    mockSend.mockResolvedValueOnce({
      vectorBucket: {
        vectorBucketName: 'my-vec-bucket',
        vectorBucketArn: 'arn:aws:s3vectors:us-east-1:123:bucket/my-vec-bucket',
      },
    });

    const result = await provider.readCurrentState(
      'my-vec-bucket',
      'Logical',
      'AWS::S3Vectors::VectorBucket'
    );
    expect(result).toEqual({ VectorBucketName: 'my-vec-bucket' });
  });
});
