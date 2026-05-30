import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  GetVectorBucketCommand,
  ListTagsForResourceCommand,
} from '@aws-sdk/client-s3vectors';

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
    mockSend.mockResolvedValueOnce({ tags: {} }); // ListTagsForResource (no user tags)

    const result = await provider.readCurrentState(
      'my-vec-bucket',
      'Logical',
      'AWS::S3Vectors::VectorBucket'
    );

    expect(mockSend.mock.calls[0]?.[0]).toBeInstanceOf(GetVectorBucketCommand);
    expect(mockSend.mock.calls[1]?.[0]).toBeInstanceOf(ListTagsForResourceCommand);
    expect(result).toEqual({
      VectorBucketName: 'my-vec-bucket',
      EncryptionConfiguration: {
        SSEType: 'aws:kms',
        KMSKeyArn: 'arn:aws:kms:us-east-1:123:key/abc',
      },
      Tags: [],
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
    mockSend.mockResolvedValueOnce({ tags: {} }); // ListTagsForResource (no tags)

    const result = await provider.readCurrentState(
      'my-vec-bucket',
      'Logical',
      'AWS::S3Vectors::VectorBucket'
    );
    expect(result).toEqual({ VectorBucketName: 'my-vec-bucket', Tags: [] });
  });

  it('surfaces Tags via ListTagsForResource and reshapes SDK map to CFn [{Key, Value}]', async () => {
    mockSend.mockResolvedValueOnce({
      vectorBucket: {
        vectorBucketName: 'tagged',
        vectorBucketArn: 'arn:aws:s3vectors:us-east-1:0:bucket/tagged',
      },
    });
    mockSend.mockResolvedValueOnce({
      tags: { env: 'prod', team: 'platform' },
    });

    const result = await provider.readCurrentState(
      'tagged',
      'Logical',
      'AWS::S3Vectors::VectorBucket'
    );

    // The SDK Record<string,string> shape is order-preserving via
    // Object.entries; the test asserts the set semantically rather than
    // exact order to stay tolerant of SDK key-ordering quirks.
    expect(result?.Tags).toEqual(
      expect.arrayContaining([
        { Key: 'env', Value: 'prod' },
        { Key: 'team', Value: 'platform' },
      ])
    );
    expect((result?.Tags as Array<unknown>).length).toBe(2);
  });

  it('emits Tags=[] when ListTagsForResource itself fails (best-effort, drift comparator stays happy)', async () => {
    mockSend.mockResolvedValueOnce({
      vectorBucket: {
        vectorBucketName: 'tags-error-bucket',
        vectorBucketArn: 'arn:aws:s3vectors:us-east-1:0:bucket/tags-error-bucket',
      },
    });
    mockSend.mockRejectedValueOnce(new Error('AccessDenied on ListTagsForResource'));

    const result = await provider.readCurrentState(
      'tags-error-bucket',
      'Logical',
      'AWS::S3Vectors::VectorBucket'
    );
    expect(result?.Tags).toEqual([]);
  });
});
