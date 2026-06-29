import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  HeadBucketCommand,
  GetBucketVersioningCommand,
  GetBucketEncryptionCommand,
  GetPublicAccessBlockCommand,
  GetBucketTaggingCommand,
  GetBucketReplicationCommand,
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
    mockSend.mockResolvedValue({});
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

    expect(result).toMatchObject({
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

    expect(result).toMatchObject({
      BucketName: 'my-bucket',
      VersioningConfiguration: { Status: 'Suspended' },
      BucketEncryption: { ServerSideEncryptionConfiguration: [] },
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: false,
        BlockPublicPolicy: false,
        IgnorePublicAcls: false,
        RestrictPublicBuckets: false,
      },
      Tags: [],
    });
  });

  // Structural regression test for the always-emit-placeholder convention
  // (docs/provider-development.md § 3b). Ensures every user-controllable
  // top-level CFn key is present in the result even when AWS returns
  // the resource with all optional fields undefined / empty. A future
  // refactor that drops a placeholder for any of these keys must update
  // this test consciously — silent regression is structurally prevented.
  //
  // The `Tags` key MUST be in the minimum-response shape: a bucket with
  // no user tags must still expose `Tags: []` so a console-side tag ADD
  // on a previously untagged bucket is detectable as drift (the
  // comparator's top-level walk is state-keys-only — observed without a
  // `Tags` key would silently miss the change).
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
        'AccelerateConfiguration',
        'AnalyticsConfigurations',
        'BucketEncryption',
        'BucketName',
        'CorsConfiguration',
        'IntelligentTieringConfigurations',
        'InventoryConfigurations',
        'LifecycleConfiguration',
        'LoggingConfiguration',
        'MetricsConfigurations',
        'NotificationConfiguration',
        'ObjectLockConfiguration',
        'PublicAccessBlockConfiguration',
        'ReplicationConfiguration',
        'Tags',
        'VersioningConfiguration',
        'WebsiteConfiguration',
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
    expect(result?.Tags).toEqual([]);
  });

  it('reads an And replication filter back into the CFn-canonical And shape', async () => {
    // Regression (bug-hunt 2026-06-29): the readback for a combined AWS replication
    // filter (`And { Prefix, Tags[] }`) previously collapsed to a top-level
    // `{ Prefix, TagFilter }` (not a valid CFn shape) and dropped every tag past
    // the first — which would surface as phantom drift against the template's
    // `Filter.And.TagFilters` and silently lose tags on round-trip. It must
    // round-trip to `{ And: { Prefix, TagFilters[] } }` (SDK `And.Tags` -> CFn
    // `And.TagFilters`), preserving all tags.
    mockSend.mockImplementation((cmd: unknown) => {
      if (cmd instanceof GetBucketReplicationCommand) {
        return Promise.resolve({
          ReplicationConfiguration: {
            Role: 'arn:aws:iam::1:role/repl',
            Rules: [
              {
                ID: 'r1',
                Status: 'Enabled',
                Priority: 1,
                Filter: {
                  And: {
                    Prefix: 'logs/',
                    Tags: [
                      { Key: 'replicate', Value: 'yes' },
                      { Key: 'tier', Value: 'gold' },
                    ],
                  },
                },
                DeleteMarkerReplication: { Status: 'Disabled' },
                Destination: { Bucket: 'arn:aws:s3:::dest-bucket' },
              },
            ],
          },
        });
      }
      // Every other GetBucket* / HeadBucket call: minimal "configured but empty".
      return Promise.resolve({});
    });

    const result = await provider.readCurrentState('my-bucket', 'Logical', 'AWS::S3::Bucket');
    const repl = result?.ReplicationConfiguration as { Rules: any[] };
    expect(repl.Rules[0].Filter).toEqual({
      And: {
        Prefix: 'logs/',
        TagFilters: [
          { Key: 'replicate', Value: 'yes' },
          { Key: 'tier', Value: 'gold' },
        ],
      },
    });
  });

  it('reads standalone replication Prefix and Tag filters back into their CFn shapes', async () => {
    // The non-And readback arms: SDK `Tag` -> CFn `TagFilter`, and a standalone
    // `Prefix` passes through unchanged. Round-trips the write path's
    // `{ Prefix }` / `{ Tag }` outputs symmetrically.
    let call = 0;
    mockSend.mockImplementation((cmd: unknown) => {
      if (cmd instanceof GetBucketReplicationCommand) {
        call++;
        const filter =
          call === 1 ? { Prefix: 'logs/' } : { Tag: { Key: 'replicate', Value: 'yes' } };
        return Promise.resolve({
          ReplicationConfiguration: {
            Role: 'arn:aws:iam::1:role/repl',
            Rules: [
              {
                ID: 'r1',
                Status: 'Enabled',
                Priority: 1,
                Filter: filter,
                DeleteMarkerReplication: { Status: 'Disabled' },
                Destination: { Bucket: 'arn:aws:s3:::dest-bucket' },
              },
            ],
          },
        });
      }
      return Promise.resolve({});
    });

    const prefixResult = await provider.readCurrentState('b', 'L', 'AWS::S3::Bucket');
    expect(
      (prefixResult?.ReplicationConfiguration as { Rules: any[] }).Rules[0].Filter
    ).toEqual({ Prefix: 'logs/' });

    const tagResult = await provider.readCurrentState('b', 'L', 'AWS::S3::Bucket');
    expect((tagResult?.ReplicationConfiguration as { Rules: any[] }).Rules[0].Filter).toEqual({
      TagFilter: { Key: 'replicate', Value: 'yes' },
    });
  });
});
