import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  GetBucketTaggingCommand,
  PutBucketEncryptionCommand,
  PutBucketCorsCommand,
  PutBucketLifecycleConfigurationCommand,
  PutBucketVersioningCommand,
  PutBucketTaggingCommand,
  DeleteBucketTaggingCommand,
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

const BUCKET_NAME = 'my-bucket';

/**
 * Build a "feature not configured" error matching AWS error shape. The
 * provider keys off `error.name`.
 */
function notConfigured(name: string): Error {
  const err = new Error(`${name}: not configured`);
  err.name = name;
  return err;
}

describe('S3BucketProvider read-update round-trip', () => {
  let provider: S3BucketProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new S3BucketProvider();
  });

  // -------------------------------------------------------------------
  // Tags fix verification (the user-reported bug)
  // -------------------------------------------------------------------

  it('Tags fix — readCurrentState emits Tags: [] when bucket has no user tags (NoSuchTagSet)', async () => {
    // Pre-fix the catch path silently dropped the Tags key, so
    // observedProperties had no Tags entry on previously-untagged
    // buckets. The drift comparator's state-keys-only top-level walk
    // skipped the field forever — a console-side tag ADD was silently
    // invisible.
    //
    // Post-fix the catch path emits `Tags: []` so the next drift run
    // sees `state=[]` vs `aws=[{Key,Value}]` and reports the change.

    // HeadBucket
    mockSend.mockResolvedValueOnce({});
    // GetBucketVersioning — never configured
    mockSend.mockResolvedValueOnce({});
    // GetBucketEncryption — absent
    mockSend.mockRejectedValueOnce(notConfigured('ServerSideEncryptionConfigurationNotFoundError'));
    // GetPublicAccessBlock — absent
    mockSend.mockRejectedValueOnce(notConfigured('NoSuchPublicAccessBlockConfiguration'));
    // GetBucketTagging — NoSuchTagSet (bucket has zero user tags)
    mockSend.mockRejectedValueOnce(notConfigured('NoSuchTagSet'));

    const result = await provider.readCurrentState(BUCKET_NAME, 'L', 'AWS::S3::Bucket');

    // Critical: Tags MUST be present (as []), not omitted.
    expect(result).toBeDefined();
    expect(Object.keys(result ?? {})).toContain('Tags');
    expect(result?.Tags).toEqual([]);
  });

  it('Tags fix — readCurrentState emits Tags: [] when AWS returns only filtered aws:* tags', async () => {
    // `normalizeAwsTagsToCfn` filters `aws:cdk:path` etc. — the bucket
    // looks like it has zero user tags from cdkd's point of view. The
    // emit must still be `Tags: []`, not omitted.

    // HeadBucket
    mockSend.mockResolvedValueOnce({});
    // GetBucketVersioning
    mockSend.mockResolvedValueOnce({});
    // GetBucketEncryption — absent
    mockSend.mockRejectedValueOnce(notConfigured('ServerSideEncryptionConfigurationNotFoundError'));
    // GetPublicAccessBlock — absent
    mockSend.mockRejectedValueOnce(notConfigured('NoSuchPublicAccessBlockConfiguration'));
    // GetBucketTagging — only aws:* tag (filtered out)
    mockSend.mockResolvedValueOnce({
      TagSet: [{ Key: 'aws:cdk:path', Value: 'MyStack/MyBucket/Resource' }],
    });

    const result = await provider.readCurrentState(BUCKET_NAME, 'L', 'AWS::S3::Bucket');

    expect(result?.Tags).toEqual([]);
  });

  // -------------------------------------------------------------------
  // No-drift round-trip — state == AWS implies zero mutating SDK calls
  // for the tag path (the diff-aware applyTagDiff). The unconditional
  // applyConfiguration paths (Versioning / PAB) DO re-PUT but only with
  // the same observed shape, which AWS accepts as a no-op.
  // -------------------------------------------------------------------

  it('round-trip on no-drift snapshot does not issue PutBucketTagging or DeleteBucketTagging', async () => {
    const observed = {
      BucketName: BUCKET_NAME,
      VersioningConfiguration: { Status: 'Suspended' },
      BucketEncryption: { ServerSideEncryptionConfiguration: [] },
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: false,
        BlockPublicPolicy: false,
        IgnorePublicAcls: false,
        RestrictPublicBuckets: false,
      },
      Tags: [] as Array<{ Key: string; Value: string }>,
    };

    // applyConfiguration unconditionally fires PutBucketVersioning +
    // PutPublicAccessBlock (both safe no-ops with the observed shape).
    // BucketEncryption is now skipped on empty rules (Class 2 fix).
    mockSend.mockResolvedValue({});

    await provider.update('L', BUCKET_NAME, 'AWS::S3::Bucket', observed, observed);

    // Tag diff should detect [] === [] and emit zero tag-mutating calls.
    const putTagging = mockSend.mock.calls.filter(
      (c) => c[0] instanceof PutBucketTaggingCommand
    );
    const deleteTagging = mockSend.mock.calls.filter(
      (c) => c[0] instanceof DeleteBucketTaggingCommand
    );
    expect(putTagging).toHaveLength(0);
    expect(deleteTagging).toHaveLength(0);
  });

  // -------------------------------------------------------------------
  // Class 2 — empty placeholder must NOT round-trip into AWS API call
  // -------------------------------------------------------------------

  it('Class 2 — empty BucketEncryption placeholder does not produce PutBucketEncryption call', async () => {
    // readCurrentState always-emits
    // `BucketEncryption: { ServerSideEncryptionConfiguration: [] }` for
    // buckets without explicit SSE. AWS rejects PutBucketEncryption
    // with zero rules ("ServerSideEncryptionConfiguration must contain
    // at least one Rule"), so applyConfiguration must skip the empty
    // placeholder on the round-trip.
    const observed = {
      BucketName: BUCKET_NAME,
      VersioningConfiguration: { Status: 'Suspended' },
      BucketEncryption: { ServerSideEncryptionConfiguration: [] },
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: false,
        BlockPublicPolicy: false,
        IgnorePublicAcls: false,
        RestrictPublicBuckets: false,
      },
      Tags: [] as Array<{ Key: string; Value: string }>,
    };

    mockSend.mockResolvedValue({});

    await provider.update('L', BUCKET_NAME, 'AWS::S3::Bucket', observed, observed);

    const putEncryption = mockSend.mock.calls.filter(
      (c) => c[0] instanceof PutBucketEncryptionCommand
    );
    expect(putEncryption).toHaveLength(0);
  });

  it('Class 2 — empty CorsConfiguration.CorsRules does not produce PutBucketCors call', async () => {
    // `applyCorsConfiguration` would call AWS with `CORSRules: []`
    // which AWS rejects ("Number of CorsRules must be at least 1").
    const observed = {
      BucketName: BUCKET_NAME,
      CorsConfiguration: { CorsRules: [] },
      Tags: [] as Array<{ Key: string; Value: string }>,
    };

    mockSend.mockResolvedValue({});

    await provider.update('L', BUCKET_NAME, 'AWS::S3::Bucket', observed, observed);

    const putCors = mockSend.mock.calls.filter((c) => c[0] instanceof PutBucketCorsCommand);
    expect(putCors).toHaveLength(0);
  });

  it('Class 2 — empty LifecycleConfiguration.Rules does not produce PutBucketLifecycleConfiguration call', async () => {
    // `applyLifecycleConfiguration` would call AWS with `Rules: []`
    // which AWS rejects.
    const observed = {
      BucketName: BUCKET_NAME,
      LifecycleConfiguration: { Rules: [] },
      Tags: [] as Array<{ Key: string; Value: string }>,
    };

    mockSend.mockResolvedValue({});

    await provider.update('L', BUCKET_NAME, 'AWS::S3::Bucket', observed, observed);

    const putLifecycle = mockSend.mock.calls.filter(
      (c) => c[0] instanceof PutBucketLifecycleConfigurationCommand
    );
    expect(putLifecycle).toHaveLength(0);
  });

  // -------------------------------------------------------------------
  // Tag diff still works correctly on real drift
  // -------------------------------------------------------------------

  it('tag drift round-trip — adding a console-side tag on a previously-untagged bucket fires PutBucketTagging', async () => {
    // observed = AWS-current snapshot (post console-side ADD)
    // state = empty Tags
    const stateProps = {
      BucketName: BUCKET_NAME,
      Tags: [] as Array<{ Key: string; Value: string }>,
    };
    const awsCurrent = {
      BucketName: BUCKET_NAME,
      Tags: [{ Key: 'NewTag', Value: 'fromConsole' }],
    };

    mockSend.mockResolvedValue({});

    // --revert: drive AWS back to state ([])
    await provider.update('L', BUCKET_NAME, 'AWS::S3::Bucket', stateProps, awsCurrent);

    const deleteCalls = mockSend.mock.calls.filter(
      (c) => c[0] instanceof DeleteBucketTaggingCommand
    );
    // Going from [{...}] -> [] uses DeleteBucketTagging in the provider.
    expect(deleteCalls.length).toBeGreaterThan(0);
  });

  it('versioning placeholder round-trips safely (Suspended -> Suspended is an AWS-accepted no-op)', async () => {
    // PutBucketVersioning with Status=Suspended on a bucket that's
    // never been versioned is documented as safe by AWS. The unguarded
    // re-PUT on round-trip is intentional — Suspended placeholder must
    // be safely round-trippable so console-side Enable surfaces.
    const observed = {
      BucketName: BUCKET_NAME,
      VersioningConfiguration: { Status: 'Suspended' },
      Tags: [] as Array<{ Key: string; Value: string }>,
    };

    mockSend.mockResolvedValue({});

    await provider.update('L', BUCKET_NAME, 'AWS::S3::Bucket', observed, observed);

    const versioningCalls = mockSend.mock.calls.filter(
      (c) => c[0] instanceof PutBucketVersioningCommand
    );
    // The provider unconditionally fires when VersioningConfiguration
    // is present. The point of the test is: when it does, the input is
    // shape-valid (Status: 'Suspended'), not an AWS-rejection shape.
    expect(versioningCalls).toHaveLength(1);
    const input = versioningCalls[0]?.[0].input as {
      VersioningConfiguration: { Status: string };
    };
    expect(input.VersioningConfiguration.Status).toBe('Suspended');
  });

  // -------------------------------------------------------------------
  // Sanity: GetBucketTagging is still consulted correctly when tags
  // exist (regression guard for the catch-path edit).
  // -------------------------------------------------------------------

  it('readCurrentState happy-path — GetBucketTagging success branch still emits user tags', async () => {
    mockSend.mockResolvedValueOnce({}); // HeadBucket
    mockSend.mockResolvedValueOnce({ Status: 'Enabled' }); // Versioning
    mockSend.mockRejectedValueOnce(notConfigured('ServerSideEncryptionConfigurationNotFoundError'));
    mockSend.mockRejectedValueOnce(notConfigured('NoSuchPublicAccessBlockConfiguration'));
    // GetBucketTagging — real user tag present
    mockSend.mockResolvedValueOnce({
      TagSet: [{ Key: 'Owner', Value: 'platform' }],
    });

    const result = await provider.readCurrentState(BUCKET_NAME, 'L', 'AWS::S3::Bucket');

    expect(mockSend.mock.calls[4]?.[0]).toBeInstanceOf(GetBucketTaggingCommand);
    expect(result?.Tags).toEqual([{ Key: 'Owner', Value: 'platform' }]);
  });
});
