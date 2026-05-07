import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  HeadBucketCommand,
  GetBucketVersioningCommand,
  GetBucketEncryptionCommand,
  GetPublicAccessBlockCommand,
  GetBucketTaggingCommand,
  NoSuchBucket,
} from '@aws-sdk/client-s3';

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

import { S3BucketProvider } from '../../../src/provisioning/providers/s3-bucket-provider.js';

/**
 * Convenience: build a "feature not configured" error matching the AWS error
 * shape that the SDK throws for the various GetBucket* calls. The provider
 * keys off `error.name`, so name-only objects are sufficient.
 */
function notConfigured(name: string): Error {
  const err = new Error(`${name}: not configured`);
  err.name = name;
  return err;
}

describe('S3BucketProvider.readCurrentState', () => {
  let provider: S3BucketProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new S3BucketProvider();
  });

  it('returns CFn-shaped configuration when every feature is configured', async () => {
    // HeadBucket
    mockSend.mockResolvedValueOnce({});
    // GetBucketVersioning
    mockSend.mockResolvedValueOnce({ Status: 'Enabled' });
    // GetBucketEncryption
    mockSend.mockResolvedValueOnce({
      ServerSideEncryptionConfiguration: {
        Rules: [
          {
            ApplyServerSideEncryptionByDefault: {
              SSEAlgorithm: 'aws:kms',
              KMSMasterKeyID: 'arn:aws:kms:us-east-1:123:key/abc',
            },
            BucketKeyEnabled: true,
          },
        ],
      },
    });
    // GetPublicAccessBlock
    mockSend.mockResolvedValueOnce({
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
    });
    // GetBucketTagging
    mockSend.mockResolvedValueOnce({
      TagSet: [
        { Key: 'Project', Value: 'demo' },
        { Key: 'aws:cdk:path', Value: 'MyStack/MyBucket/Resource' },
      ],
    });

    const result = await provider.readCurrentState('my-bucket', 'Logical', 'AWS::S3::Bucket');

    expect(mockSend.mock.calls[0]?.[0]).toBeInstanceOf(HeadBucketCommand);
    expect(mockSend.mock.calls[1]?.[0]).toBeInstanceOf(GetBucketVersioningCommand);
    expect(mockSend.mock.calls[2]?.[0]).toBeInstanceOf(GetBucketEncryptionCommand);
    expect(mockSend.mock.calls[3]?.[0]).toBeInstanceOf(GetPublicAccessBlockCommand);
    expect(mockSend.mock.calls[4]?.[0]).toBeInstanceOf(GetBucketTaggingCommand);

    expect(result).toEqual({
      BucketName: 'my-bucket',
      VersioningConfiguration: { Status: 'Enabled' },
      BucketEncryption: {
        ServerSideEncryptionConfiguration: [
          {
            ServerSideEncryptionByDefault: {
              SSEAlgorithm: 'aws:kms',
              KMSMasterKeyID: 'arn:aws:kms:us-east-1:123:key/abc',
            },
            BucketKeyEnabled: true,
          },
        ],
      },
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
      Tags: [{ Key: 'Project', Value: 'demo' }],
    });
  });

  it('returns undefined when bucket does not exist', async () => {
    mockSend.mockRejectedValueOnce(new NoSuchBucket({ message: 'gone', $metadata: {} }));

    const result = await provider.readCurrentState('missing', 'Logical', 'AWS::S3::Bucket');

    expect(result).toBeUndefined();
  });

  it('emits placeholder per-feature keys when individual GetBucket* calls report "not configured"', async () => {
    // HeadBucket
    mockSend.mockResolvedValueOnce({});
    // GetBucketVersioning — bucket has never had versioning configured
    mockSend.mockResolvedValueOnce({});
    // GetBucketEncryption — feature absent
    mockSend.mockRejectedValueOnce(notConfigured('ServerSideEncryptionConfigurationNotFoundError'));
    // GetPublicAccessBlock — feature absent
    mockSend.mockRejectedValueOnce(notConfigured('NoSuchPublicAccessBlockConfiguration'));
    // GetBucketTagging — no tags
    mockSend.mockRejectedValueOnce(notConfigured('NoSuchTagSet'));

    const result = await provider.readCurrentState('my-bucket', 'Logical', 'AWS::S3::Bucket');

    expect(result).toEqual({
      BucketName: 'my-bucket',
      VersioningConfiguration: { Status: 'Suspended' },
      BucketEncryption: { ServerSideEncryptionConfiguration: [] },
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: false,
        BlockPublicPolicy: false,
        IgnorePublicAcls: false,
        RestrictPublicBuckets: false,
      },
    });
  });

  // Structural regression test for the always-emit-placeholder convention
  // (docs/provider-development.md § 3b). Ensures every user-controllable
  // top-level CFn key is present in the result even when AWS returns
  // the resource with all optional fields undefined / empty. A future
  // refactor that drops a placeholder for any of these keys must update
  // this test consciously — silent regression is structurally prevented.
  //
  // Note: the S3 provider's `Tags` key is set inside a try-block that
  // catches `NoSuchTagSet` without writing the key — so the
  // minimum-response shape deliberately does NOT include `Tags`. This
  // mirrors the existing not-configured test above.
  it('emits placeholders for every user-controllable top-level key on AWS minimum response', async () => {
    // HeadBucket
    mockSend.mockResolvedValueOnce({});
    // GetBucketVersioning — never configured
    mockSend.mockResolvedValueOnce({});
    // GetBucketEncryption — feature absent
    mockSend.mockRejectedValueOnce(notConfigured('ServerSideEncryptionConfigurationNotFoundError'));
    // GetPublicAccessBlock — feature absent
    mockSend.mockRejectedValueOnce(notConfigured('NoSuchPublicAccessBlockConfiguration'));
    // GetBucketTagging — no tag set
    mockSend.mockRejectedValueOnce(notConfigured('NoSuchTagSet'));

    const result = await provider.readCurrentState('my-bucket', 'Logical', 'AWS::S3::Bucket');

    expect(Object.keys(result ?? {}).sort()).toEqual(
      [
        'BucketEncryption',
        'BucketName',
        'PublicAccessBlockConfiguration',
        'VersioningConfiguration',
      ].sort()
    );
    expect(result?.VersioningConfiguration).toEqual({ Status: 'Suspended' });
    expect(result?.BucketEncryption).toEqual({ ServerSideEncryptionConfiguration: [] });
    expect(result?.PublicAccessBlockConfiguration).toEqual({
      BlockPublicAcls: false,
      BlockPublicPolicy: false,
      IgnorePublicAcls: false,
      RestrictPublicBuckets: false,
    });
  });
});
