import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

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

const RESOURCE_TYPE = 'AWS::S3Vectors::VectorBucket';
const PHYSICAL_ID = 'my-vec-bucket';

describe('S3VectorsProvider read-update round-trip', () => {
  let provider: S3VectorsProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new S3VectorsProvider();
  });

  it('round-trip on no-drift snapshot is a logical no-op (zero AWS calls)', async () => {
    // VectorBucket has no mutable properties — `update()` is a documented
    // no-op. The round-trip on observedProperties must therefore make
    // zero SDK calls regardless of which fields the snapshot contains.
    const observed = {
      VectorBucketName: PHYSICAL_ID,
      EncryptionConfiguration: {
        SSEType: 'aws:kms',
        KMSKeyArn: 'arn:aws:kms:us-east-1:123:key/abc',
      },
    };

    const result = await provider.update('L', PHYSICAL_ID, RESOURCE_TYPE, observed, observed);

    expect(result).toEqual({ physicalId: PHYSICAL_ID, wasReplaced: false });
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('round-trip on AES256 snapshot does not surface AWS-rejection-shape inputs', async () => {
    // Even if a future code path were to ship update() with real
    // SetEncryption-style mutations, an AES256 snapshot must not carry a
    // KMSKeyArn. This is the Class 1 guard mirrored on the round-trip
    // path: standard-encryption resources must not round-trip
    // KMS-only fields.
    const observed = {
      VectorBucketName: PHYSICAL_ID,
      EncryptionConfiguration: {
        SSEType: 'AES256',
      },
    };

    await provider.update('L', PHYSICAL_ID, RESOURCE_TYPE, observed, observed);

    expect(mockSend).not.toHaveBeenCalled();
    // Sanity check: the snapshot itself does not carry KMSKeyArn for AES256.
    const enc = observed.EncryptionConfiguration as Record<string, unknown>;
    expect(enc['KMSKeyArn']).toBeUndefined();
  });

  it('Class 1 — readCurrentState does not emit KMSKeyArn on an AES256 bucket', async () => {
    // Defensive Class 1 guard: even if AWS surfaces an account-default
    // KMS key ARN alongside sseType=AES256 (not the documented behavior
    // today, but an SDK surface change away), readCurrentState must NOT
    // emit KMSKeyArn — round-tripping it back via `cdkd drift --revert`
    // would push a KMS-only field on a standard-encryption bucket and
    // AWS rejects with "KMSKeyArn is only valid when SSEType is aws:kms".
    mockSend.mockResolvedValueOnce({
      vectorBucket: {
        vectorBucketName: PHYSICAL_ID,
        vectorBucketArn: `arn:aws:s3vectors:us-east-1:123:bucket/${PHYSICAL_ID}`,
        encryptionConfiguration: {
          sseType: 'AES256',
          // Hypothetical AWS-managed default that should NOT be surfaced.
          kmsKeyArn: 'arn:aws:kms:us-east-1:123:key/aws/s3vectors',
        },
      },
    });

    const result = await provider.readCurrentState(PHYSICAL_ID, 'L', RESOURCE_TYPE);

    expect(result).toEqual({
      VectorBucketName: PHYSICAL_ID,
      EncryptionConfiguration: { SSEType: 'AES256' },
    });
    const enc = (result?.['EncryptionConfiguration'] ?? {}) as Record<string, unknown>;
    expect(enc['KMSKeyArn']).toBeUndefined();
  });

  it('readCurrentState emits both SSEType and KMSKeyArn on aws:kms (legitimate KMS path)', async () => {
    // Complement of the AES256 case: aws:kms encryption legitimately
    // carries KMSKeyArn, and round-tripping it must preserve both.
    mockSend.mockResolvedValueOnce({
      vectorBucket: {
        vectorBucketName: PHYSICAL_ID,
        vectorBucketArn: `arn:aws:s3vectors:us-east-1:123:bucket/${PHYSICAL_ID}`,
        encryptionConfiguration: {
          sseType: 'aws:kms',
          kmsKeyArn: 'arn:aws:kms:us-east-1:123:key/abc',
        },
      },
    });

    const result = await provider.readCurrentState(PHYSICAL_ID, 'L', RESOURCE_TYPE);

    expect(result).toEqual({
      VectorBucketName: PHYSICAL_ID,
      EncryptionConfiguration: {
        SSEType: 'aws:kms',
        KMSKeyArn: 'arn:aws:kms:us-east-1:123:key/abc',
      },
    });
  });
});
