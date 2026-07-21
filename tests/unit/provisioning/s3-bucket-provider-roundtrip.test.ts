import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  GetBucketTaggingCommand,
  PutBucketEncryptionCommand,
  PutBucketCorsCommand,
  DeleteBucketCorsCommand,
  PutBucketLifecycleConfigurationCommand,
  DeleteBucketLifecycleCommand,
  PutBucketVersioningCommand,
  PutBucketTaggingCommand,
  DeleteBucketTaggingCommand,
  PutBucketWebsiteCommand,
  DeleteBucketWebsiteCommand,
  PutBucketLoggingCommand,
  PutBucketNotificationConfigurationCommand,
  PutBucketReplicationCommand,
  DeleteBucketReplicationCommand,
  PutObjectLockConfigurationCommand,
  PutBucketAccelerateConfigurationCommand,
  PutBucketMetricsConfigurationCommand,
  DeleteBucketMetricsConfigurationCommand,
  PutBucketAnalyticsConfigurationCommand,
  DeleteBucketAnalyticsConfigurationCommand,
  PutBucketIntelligentTieringConfigurationCommand,
  DeleteBucketIntelligentTieringConfigurationCommand,
  PutBucketInventoryConfigurationCommand,
  DeleteBucketInventoryConfigurationCommand,
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
    mockSend.mockResolvedValue({});
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

// =====================================================================
// PR #215 sub-config update / delete round-trips
// =====================================================================
//
// applySubConfigDiffs() walks each of the 12 sub-configs and issues:
//   - undefined -> defined: Put*Command
//   - defined -> undefined: Delete*Command (or Put-with-cleared-body for
//     APIs that have no Delete counterpart — Logging / Notification /
//     ObjectLock / Accelerate)
//   - defined -> defined (different): Put*Command
//   - unchanged: no SDK call
//
// The 4 array-shaped configs (Metrics / Analytics / IntelligentTiering /
// Inventory) diff per `Id` so add / remove / change are fired
// independently for each id.
// =====================================================================

describe('S3BucketProvider sub-config diff (PR #215)', () => {
  let provider: S3BucketProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new S3BucketProvider();
    mockSend.mockResolvedValue({});
  });

  /**
   * Filter the SDK mock calls to a single command class — used as the
   * primary assertion point so unrelated commands (PutBucketVersioning
   * etc. fired by applyConfiguration) don't pollute the assertion.
   */
  function callsOf(cmdClass: new (...args: never[]) => unknown): unknown[] {
    return mockSend.mock.calls.filter((c) => c[0] instanceof cmdClass).map((c) => c[0]);
  }

  // -------------------------------------------------------------------
  // LifecycleConfiguration (Put + Delete)
  // -------------------------------------------------------------------

  it('LifecycleConfiguration: absent -> present fires PutBucketLifecycleConfiguration', async () => {
    await provider.update(
      'L',
      BUCKET_NAME,
      'AWS::S3::Bucket',
      {
        BucketName: BUCKET_NAME,
        LifecycleConfiguration: {
          Rules: [{ Id: 'r1', Status: 'Enabled', ExpirationInDays: 30 }],
        },
      },
      { BucketName: BUCKET_NAME }
    );
    expect(callsOf(PutBucketLifecycleConfigurationCommand)).toHaveLength(1);
    expect(callsOf(DeleteBucketLifecycleCommand)).toHaveLength(0);
  });

  it('LifecycleConfiguration: present -> absent fires DeleteBucketLifecycle', async () => {
    await provider.update(
      'L',
      BUCKET_NAME,
      'AWS::S3::Bucket',
      { BucketName: BUCKET_NAME },
      {
        BucketName: BUCKET_NAME,
        LifecycleConfiguration: {
          Rules: [{ Id: 'r1', Status: 'Enabled', ExpirationInDays: 30 }],
        },
      }
    );
    expect(callsOf(DeleteBucketLifecycleCommand)).toHaveLength(1);
    expect(callsOf(PutBucketLifecycleConfigurationCommand)).toHaveLength(0);
  });

  it('LifecycleConfiguration: unchanged fires neither Put nor Delete', async () => {
    const cfg = { Rules: [{ Id: 'r1', Status: 'Enabled', ExpirationInDays: 30 }] };
    await provider.update(
      'L',
      BUCKET_NAME,
      'AWS::S3::Bucket',
      { BucketName: BUCKET_NAME, LifecycleConfiguration: cfg },
      { BucketName: BUCKET_NAME, LifecycleConfiguration: cfg }
    );
    expect(callsOf(PutBucketLifecycleConfigurationCommand)).toHaveLength(0);
    expect(callsOf(DeleteBucketLifecycleCommand)).toHaveLength(0);
  });

  it('LifecycleConfiguration: present -> present (different) fires Put', async () => {
    await provider.update(
      'L',
      BUCKET_NAME,
      'AWS::S3::Bucket',
      {
        BucketName: BUCKET_NAME,
        LifecycleConfiguration: {
          Rules: [{ Id: 'r1', Status: 'Enabled', ExpirationInDays: 60 }],
        },
      },
      {
        BucketName: BUCKET_NAME,
        LifecycleConfiguration: {
          Rules: [{ Id: 'r1', Status: 'Enabled', ExpirationInDays: 30 }],
        },
      }
    );
    expect(callsOf(PutBucketLifecycleConfigurationCommand)).toHaveLength(1);
    expect(callsOf(DeleteBucketLifecycleCommand)).toHaveLength(0);
  });

  // -------------------------------------------------------------------
  // LifecycleConfiguration V1/V2 normalization (regression: bug-hunt 2026-06-29)
  // S3 rejects a config mixing a rule with a top-level `Prefix` (V1) and a rule
  // with a `Filter` (V2): "Filter element can only be used in Lifecycle V2."
  // -------------------------------------------------------------------

  it('LifecycleConfiguration: prefix-rule + no-scope rule -> all rules use Filter (no V1/V2 mix)', async () => {
    await provider.update(
      'L',
      BUCKET_NAME,
      'AWS::S3::Bucket',
      {
        BucketName: BUCKET_NAME,
        LifecycleConfiguration: {
          Rules: [
            { Id: 'archive', Status: 'Enabled', Prefix: 'logs/', ExpirationInDays: 365 },
            {
              Id: 'abort-mpu',
              Status: 'Enabled',
              AbortIncompleteMultipartUpload: { DaysAfterInitiation: 7 },
            },
          ],
        },
      },
      { BucketName: BUCKET_NAME }
    );
    const puts = callsOf(PutBucketLifecycleConfigurationCommand);
    expect(puts).toHaveLength(1);
    const rules = (puts[0].input as { LifecycleConfiguration: { Rules: any[] } })
      .LifecycleConfiguration.Rules;
    // Every rule must be V2 (Filter present, no top-level Prefix) so S3 does not
    // see a mixed config.
    for (const r of rules) {
      expect(r.Prefix).toBeUndefined();
      expect(r.Filter).toBeDefined();
    }
    // The prefix-scoped rule carries its prefix under Filter; the scope-less rule
    // gets the empty-prefix Filter.
    expect(rules.find((r) => r.ID === 'archive').Filter).toEqual({ Prefix: 'logs/' });
    expect(rules.find((r) => r.ID === 'abort-mpu').Filter).toEqual({ Prefix: '' });
  });

  it('LifecycleConfiguration: all rules prefix-scoped -> stays V1 (top-level Prefix, no Filter)', async () => {
    await provider.update(
      'L',
      BUCKET_NAME,
      'AWS::S3::Bucket',
      {
        BucketName: BUCKET_NAME,
        LifecycleConfiguration: {
          Rules: [
            { Id: 'a', Status: 'Enabled', Prefix: 'logs/', ExpirationInDays: 365 },
            { Id: 'b', Status: 'Enabled', Prefix: 'tmp/', ExpirationInDays: 7 },
          ],
        },
      },
      { BucketName: BUCKET_NAME }
    );
    const rules = (
      callsOf(PutBucketLifecycleConfigurationCommand)[0].input as {
        LifecycleConfiguration: { Rules: any[] };
      }
    ).LifecycleConfiguration.Rules;
    for (const r of rules) {
      expect(r.Prefix).toBeDefined();
      expect(r.Filter).toBeUndefined();
    }
  });

  it('LifecycleConfiguration: explicit Filter rule + prefix rule -> prefix rule converted to Filter', async () => {
    await provider.update(
      'L',
      BUCKET_NAME,
      'AWS::S3::Bucket',
      {
        BucketName: BUCKET_NAME,
        LifecycleConfiguration: {
          Rules: [
            { Id: 'prefix-rule', Status: 'Enabled', Prefix: 'logs/', ExpirationInDays: 365 },
            {
              Id: 'filter-rule',
              Status: 'Enabled',
              Filter: { ObjectSizeGreaterThan: 1024 },
              ExpirationInDays: 30,
            },
          ],
        },
      },
      { BucketName: BUCKET_NAME }
    );
    const rules = (
      callsOf(PutBucketLifecycleConfigurationCommand)[0].input as {
        LifecycleConfiguration: { Rules: any[] };
      }
    ).LifecycleConfiguration.Rules;
    for (const r of rules) {
      expect(r.Prefix).toBeUndefined();
      expect(r.Filter).toBeDefined();
    }
    expect(rules.find((r) => r.ID === 'prefix-rule').Filter).toEqual({ Prefix: 'logs/' });
    expect(rules.find((r) => r.ID === 'filter-rule').Filter).toEqual({ ObjectSizeGreaterThan: 1024 });
  });

  it('LifecycleConfiguration: prefix rule + tag-only rule -> prefix converted, tag rule emits {Tag}', async () => {
    await provider.update(
      'L',
      BUCKET_NAME,
      'AWS::S3::Bucket',
      {
        BucketName: BUCKET_NAME,
        LifecycleConfiguration: {
          Rules: [
            { Id: 'prefix-rule', Status: 'Enabled', Prefix: 'logs/', ExpirationInDays: 365 },
            {
              Id: 'tag-rule',
              Status: 'Enabled',
              Filter: { TagFilters: [{ Key: 'archive', Value: 'true' }] },
              ExpirationInDays: 30,
            },
          ],
        },
      },
      { BucketName: BUCKET_NAME }
    );
    const rules = (
      callsOf(PutBucketLifecycleConfigurationCommand)[0].input as {
        LifecycleConfiguration: { Rules: any[] };
      }
    ).LifecycleConfiguration.Rules;
    for (const r of rules) {
      expect(r.Prefix).toBeUndefined();
    }
    expect(rules.find((r) => r.ID === 'prefix-rule').Filter).toEqual({ Prefix: 'logs/' });
    expect(rules.find((r) => r.ID === 'tag-rule').Filter).toEqual({
      Tag: { Key: 'archive', Value: 'true' },
    });
  });

  it('LifecycleConfiguration: top-level ObjectSizeGreaterThan (CDK shape) folds into Filter', async () => {
    // Regression (bug-hunt 2026-06-29): CDK's LifecycleRule.objectSizeGreaterThan
    // synthesizes a TOP-LEVEL `ObjectSizeGreaterThan` on the rule (NOT nested under
    // Filter). Reading only `Filter.ObjectSizeGreaterThan` silently dropped it.
    await provider.update(
      'L',
      BUCKET_NAME,
      'AWS::S3::Bucket',
      {
        BucketName: BUCKET_NAME,
        LifecycleConfiguration: {
          Rules: [
            {
              Id: 'big',
              Status: 'Enabled',
              ObjectSizeGreaterThan: 1048576,
              ExpirationInDays: 180,
            },
          ],
        },
      },
      { BucketName: BUCKET_NAME }
    );
    const rules = (
      callsOf(PutBucketLifecycleConfigurationCommand)[0].input as {
        LifecycleConfiguration: { Rules: any[] };
      }
    ).LifecycleConfiguration.Rules;
    expect(rules[0].Filter).toEqual({ ObjectSizeGreaterThan: 1048576 });
    expect(rules[0].Prefix).toBeUndefined();
  });

  it('LifecycleConfiguration: top-level Prefix + top-level ObjectSizeGreaterThan -> Filter.And', async () => {
    await provider.update(
      'L',
      BUCKET_NAME,
      'AWS::S3::Bucket',
      {
        BucketName: BUCKET_NAME,
        LifecycleConfiguration: {
          Rules: [
            {
              Id: 'both',
              Status: 'Enabled',
              Prefix: 'data/',
              ObjectSizeGreaterThan: 500,
              ObjectSizeLessThan: 5000,
              ExpirationInDays: 90,
            },
          ],
        },
      },
      { BucketName: BUCKET_NAME }
    );
    const rule = (
      callsOf(PutBucketLifecycleConfigurationCommand)[0].input as {
        LifecycleConfiguration: { Rules: any[] };
      }
    ).LifecycleConfiguration.Rules[0];
    expect(rule.Prefix).toBeUndefined();
    expect(rule.Filter).toEqual({
      And: { Prefix: 'data/', Tags: undefined, ObjectSizeGreaterThan: 500, ObjectSizeLessThan: 5000 },
    });
  });

  // -------------------------------------------------------------------
  // CorsConfiguration (Put + Delete)
  // -------------------------------------------------------------------

  it('CorsConfiguration: absent -> present fires PutBucketCors', async () => {
    await provider.update(
      'L',
      BUCKET_NAME,
      'AWS::S3::Bucket',
      {
        BucketName: BUCKET_NAME,
        CorsConfiguration: {
          CorsRules: [{ AllowedOrigins: ['*'], AllowedMethods: ['GET'] }],
        },
      },
      { BucketName: BUCKET_NAME }
    );
    expect(callsOf(PutBucketCorsCommand)).toHaveLength(1);
    expect(callsOf(DeleteBucketCorsCommand)).toHaveLength(0);
  });

  it('CorsConfiguration: present -> absent fires DeleteBucketCors', async () => {
    await provider.update(
      'L',
      BUCKET_NAME,
      'AWS::S3::Bucket',
      { BucketName: BUCKET_NAME },
      {
        BucketName: BUCKET_NAME,
        CorsConfiguration: {
          CorsRules: [{ AllowedOrigins: ['*'], AllowedMethods: ['GET'] }],
        },
      }
    );
    expect(callsOf(DeleteBucketCorsCommand)).toHaveLength(1);
    expect(callsOf(PutBucketCorsCommand)).toHaveLength(0);
  });

  it('CorsConfiguration: unchanged fires neither Put nor Delete', async () => {
    const cfg = { CorsRules: [{ AllowedOrigins: ['*'], AllowedMethods: ['GET'] }] };
    await provider.update(
      'L',
      BUCKET_NAME,
      'AWS::S3::Bucket',
      { BucketName: BUCKET_NAME, CorsConfiguration: cfg },
      { BucketName: BUCKET_NAME, CorsConfiguration: cfg }
    );
    expect(callsOf(PutBucketCorsCommand)).toHaveLength(0);
    expect(callsOf(DeleteBucketCorsCommand)).toHaveLength(0);
  });

  it('CorsConfiguration: present -> present (different) fires Put', async () => {
    await provider.update(
      'L',
      BUCKET_NAME,
      'AWS::S3::Bucket',
      {
        BucketName: BUCKET_NAME,
        CorsConfiguration: {
          CorsRules: [{ AllowedOrigins: ['https://example.com'], AllowedMethods: ['GET'] }],
        },
      },
      {
        BucketName: BUCKET_NAME,
        CorsConfiguration: {
          CorsRules: [{ AllowedOrigins: ['*'], AllowedMethods: ['GET'] }],
        },
      }
    );
    expect(callsOf(PutBucketCorsCommand)).toHaveLength(1);
  });

  // -------------------------------------------------------------------
  // WebsiteConfiguration (Put + Delete)
  // -------------------------------------------------------------------

  it('WebsiteConfiguration: absent -> present fires PutBucketWebsite', async () => {
    await provider.update(
      'L',
      BUCKET_NAME,
      'AWS::S3::Bucket',
      {
        BucketName: BUCKET_NAME,
        WebsiteConfiguration: { IndexDocument: 'index.html' },
      },
      { BucketName: BUCKET_NAME }
    );
    expect(callsOf(PutBucketWebsiteCommand)).toHaveLength(1);
    expect(callsOf(DeleteBucketWebsiteCommand)).toHaveLength(0);
  });

  it('WebsiteConfiguration: present -> absent fires DeleteBucketWebsite', async () => {
    await provider.update(
      'L',
      BUCKET_NAME,
      'AWS::S3::Bucket',
      { BucketName: BUCKET_NAME },
      {
        BucketName: BUCKET_NAME,
        WebsiteConfiguration: { IndexDocument: 'index.html' },
      }
    );
    expect(callsOf(DeleteBucketWebsiteCommand)).toHaveLength(1);
    expect(callsOf(PutBucketWebsiteCommand)).toHaveLength(0);
  });

  it('WebsiteConfiguration: unchanged fires no SDK call', async () => {
    const cfg = { IndexDocument: 'index.html' };
    await provider.update(
      'L',
      BUCKET_NAME,
      'AWS::S3::Bucket',
      { BucketName: BUCKET_NAME, WebsiteConfiguration: cfg },
      { BucketName: BUCKET_NAME, WebsiteConfiguration: cfg }
    );
    expect(callsOf(PutBucketWebsiteCommand)).toHaveLength(0);
    expect(callsOf(DeleteBucketWebsiteCommand)).toHaveLength(0);
  });

  it('WebsiteConfiguration: present -> present (different) fires Put', async () => {
    await provider.update(
      'L',
      BUCKET_NAME,
      'AWS::S3::Bucket',
      {
        BucketName: BUCKET_NAME,
        WebsiteConfiguration: { IndexDocument: 'main.html' },
      },
      {
        BucketName: BUCKET_NAME,
        WebsiteConfiguration: { IndexDocument: 'index.html' },
      }
    );
    expect(callsOf(PutBucketWebsiteCommand)).toHaveLength(1);
  });

  // -------------------------------------------------------------------
  // LoggingConfiguration (Put-only — no Delete API; clear via empty Put)
  // -------------------------------------------------------------------

  it('LoggingConfiguration: absent -> present fires PutBucketLogging', async () => {
    await provider.update(
      'L',
      BUCKET_NAME,
      'AWS::S3::Bucket',
      {
        BucketName: BUCKET_NAME,
        LoggingConfiguration: { DestinationBucketName: 'log-bucket', LogFilePrefix: 'logs/' },
      },
      { BucketName: BUCKET_NAME }
    );
    const calls = callsOf(PutBucketLoggingCommand);
    expect(calls).toHaveLength(1);
    expect((calls[0] as { input: { BucketLoggingStatus: { LoggingEnabled: object } } }).input)
      .toMatchObject({
        Bucket: BUCKET_NAME,
        BucketLoggingStatus: {
          LoggingEnabled: { TargetBucket: 'log-bucket', TargetPrefix: 'logs/' },
        },
      });
  });

  it('LoggingConfiguration: present -> absent fires PutBucketLogging with empty BucketLoggingStatus', async () => {
    await provider.update(
      'L',
      BUCKET_NAME,
      'AWS::S3::Bucket',
      { BucketName: BUCKET_NAME },
      {
        BucketName: BUCKET_NAME,
        LoggingConfiguration: { DestinationBucketName: 'log-bucket' },
      }
    );
    const calls = callsOf(PutBucketLoggingCommand);
    expect(calls).toHaveLength(1);
    expect((calls[0] as { input: { BucketLoggingStatus: object } }).input.BucketLoggingStatus)
      .toEqual({});
  });

  it('LoggingConfiguration: unchanged fires no SDK call', async () => {
    const cfg = { DestinationBucketName: 'log-bucket', LogFilePrefix: 'logs/' };
    await provider.update(
      'L',
      BUCKET_NAME,
      'AWS::S3::Bucket',
      { BucketName: BUCKET_NAME, LoggingConfiguration: cfg },
      { BucketName: BUCKET_NAME, LoggingConfiguration: cfg }
    );
    expect(callsOf(PutBucketLoggingCommand)).toHaveLength(0);
  });

  it('LoggingConfiguration: present -> present (different prefix) fires Put', async () => {
    await provider.update(
      'L',
      BUCKET_NAME,
      'AWS::S3::Bucket',
      {
        BucketName: BUCKET_NAME,
        LoggingConfiguration: { DestinationBucketName: 'log-bucket', LogFilePrefix: 'new/' },
      },
      {
        BucketName: BUCKET_NAME,
        LoggingConfiguration: { DestinationBucketName: 'log-bucket', LogFilePrefix: 'old/' },
      }
    );
    expect(callsOf(PutBucketLoggingCommand)).toHaveLength(1);
  });

  // -------------------------------------------------------------------
  // NotificationConfiguration (Put-only — empty NotificationConfiguration clears)
  // -------------------------------------------------------------------

  it('NotificationConfiguration: absent -> present fires PutBucketNotificationConfiguration', async () => {
    await provider.update(
      'L',
      BUCKET_NAME,
      'AWS::S3::Bucket',
      {
        BucketName: BUCKET_NAME,
        NotificationConfiguration: {
          TopicConfigurations: [
            { Topic: 'arn:aws:sns:us-east-1:1:my-topic', Event: 's3:ObjectCreated:*' },
          ],
        },
      },
      { BucketName: BUCKET_NAME }
    );
    expect(callsOf(PutBucketNotificationConfigurationCommand)).toHaveLength(1);
  });

  it('NotificationConfiguration: present -> absent fires Put with empty NotificationConfiguration', async () => {
    await provider.update(
      'L',
      BUCKET_NAME,
      'AWS::S3::Bucket',
      { BucketName: BUCKET_NAME },
      {
        BucketName: BUCKET_NAME,
        NotificationConfiguration: {
          TopicConfigurations: [
            { Topic: 'arn:aws:sns:us-east-1:1:my-topic', Event: 's3:ObjectCreated:*' },
          ],
        },
      }
    );
    const calls = callsOf(PutBucketNotificationConfigurationCommand);
    expect(calls).toHaveLength(1);
    expect((calls[0] as { input: { NotificationConfiguration: object } }).input
      .NotificationConfiguration).toEqual({});
  });

  it('NotificationConfiguration: unchanged fires no SDK call', async () => {
    const cfg = {
      TopicConfigurations: [
        { Topic: 'arn:aws:sns:us-east-1:1:my-topic', Event: 's3:ObjectCreated:*' },
      ],
    };
    await provider.update(
      'L',
      BUCKET_NAME,
      'AWS::S3::Bucket',
      { BucketName: BUCKET_NAME, NotificationConfiguration: cfg },
      { BucketName: BUCKET_NAME, NotificationConfiguration: cfg }
    );
    expect(callsOf(PutBucketNotificationConfigurationCommand)).toHaveLength(0);
  });

  it('NotificationConfiguration: present -> present (different) fires Put', async () => {
    await provider.update(
      'L',
      BUCKET_NAME,
      'AWS::S3::Bucket',
      {
        BucketName: BUCKET_NAME,
        NotificationConfiguration: {
          TopicConfigurations: [
            { Topic: 'arn:aws:sns:us-east-1:1:other', Event: 's3:ObjectCreated:*' },
          ],
        },
      },
      {
        BucketName: BUCKET_NAME,
        NotificationConfiguration: {
          TopicConfigurations: [
            { Topic: 'arn:aws:sns:us-east-1:1:my-topic', Event: 's3:ObjectCreated:*' },
          ],
        },
      }
    );
    expect(callsOf(PutBucketNotificationConfigurationCommand)).toHaveLength(1);
  });

  // -------------------------------------------------------------------
  // ReplicationConfiguration (Put + Delete)
  // -------------------------------------------------------------------

  it('ReplicationConfiguration: absent -> present fires PutBucketReplication', async () => {
    await provider.update(
      'L',
      BUCKET_NAME,
      'AWS::S3::Bucket',
      {
        BucketName: BUCKET_NAME,
        ReplicationConfiguration: {
          Role: 'arn:aws:iam::1:role/repl',
          Rules: [
            {
              Id: 'r1',
              Status: 'Enabled',
              Destination: { Bucket: 'arn:aws:s3:::dest-bucket' },
            },
          ],
        },
      },
      { BucketName: BUCKET_NAME }
    );
    expect(callsOf(PutBucketReplicationCommand)).toHaveLength(1);
    expect(callsOf(DeleteBucketReplicationCommand)).toHaveLength(0);
  });

  it('ReplicationConfiguration: empty Filter {} is preserved (V2 replicate-all, not dropped)', async () => {
    // Regression (bug-hunt 2026-06-29): an empty `Filter: {}` is the valid CFn
    // "replicate every object" V2 form; element-wise transform must not drop it,
    // else PutBucketReplication gets a rule with neither Filter nor Prefix.
    await provider.update(
      'L',
      BUCKET_NAME,
      'AWS::S3::Bucket',
      {
        BucketName: BUCKET_NAME,
        ReplicationConfiguration: {
          Role: 'arn:aws:iam::1:role/repl',
          Rules: [
            {
              Id: 'r1',
              Status: 'Enabled',
              Priority: 1,
              Filter: {},
              DeleteMarkerReplication: { Status: 'Disabled' },
              Destination: { Bucket: 'arn:aws:s3:::dest-bucket' },
            },
          ],
        },
      },
      { BucketName: BUCKET_NAME }
    );
    const rule = (
      callsOf(PutBucketReplicationCommand)[0].input as {
        ReplicationConfiguration: { Rules: any[] };
      }
    ).ReplicationConfiguration.Rules[0];
    expect(rule.Filter).toEqual({});
    expect(rule.Prefix).toBeUndefined();
  });

  it('ReplicationConfiguration: combined And filter (prefix + tags) reaches AWS, not replicate-all', async () => {
    // Regression (bug-hunt 2026-06-29): CFn/CDK express a combined prefix+tag
    // replication filter ONLY via `Filter.And { Prefix, TagFilters[] }`. The
    // provider previously read only top-level `Filter.Prefix` / `Filter.TagFilter`
    // and never `Filter.And`, so a combined filter silently collapsed to an
    // empty `Filter: {}` (replicate EVERY object) — a scope-broadening divergence.
    await provider.update(
      'L',
      BUCKET_NAME,
      'AWS::S3::Bucket',
      {
        BucketName: BUCKET_NAME,
        ReplicationConfiguration: {
          Role: 'arn:aws:iam::1:role/repl',
          Rules: [
            {
              Id: 'r1',
              Status: 'Enabled',
              Priority: 1,
              Filter: {
                And: {
                  Prefix: 'logs/',
                  TagFilters: [
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
      },
      { BucketName: BUCKET_NAME }
    );
    const rule = (
      callsOf(PutBucketReplicationCommand)[0].input as {
        ReplicationConfiguration: { Rules: any[] };
      }
    ).ReplicationConfiguration.Rules[0];
    // SDK shape: And.TagFilters -> And.Tags, every tag preserved.
    expect(rule.Filter).toEqual({
      And: {
        Prefix: 'logs/',
        Tags: [
          { Key: 'replicate', Value: 'yes' },
          { Key: 'tier', Value: 'gold' },
        ],
      },
    });
  });

  it('ReplicationConfiguration: And filter with tags only (no prefix) maps to And.Tags', async () => {
    await provider.update(
      'L',
      BUCKET_NAME,
      'AWS::S3::Bucket',
      {
        BucketName: BUCKET_NAME,
        ReplicationConfiguration: {
          Role: 'arn:aws:iam::1:role/repl',
          Rules: [
            {
              Id: 'r1',
              Status: 'Enabled',
              Priority: 1,
              Filter: { And: { TagFilters: [{ Key: 'replicate', Value: 'yes' }] } },
              DeleteMarkerReplication: { Status: 'Disabled' },
              Destination: { Bucket: 'arn:aws:s3:::dest-bucket' },
            },
          ],
        },
      },
      { BucketName: BUCKET_NAME }
    );
    const rule = (
      callsOf(PutBucketReplicationCommand)[0].input as {
        ReplicationConfiguration: { Rules: any[] };
      }
    ).ReplicationConfiguration.Rules[0];
    expect(rule.Filter).toEqual({ And: { Tags: [{ Key: 'replicate', Value: 'yes' }] } });
  });

  it('ReplicationConfiguration: single TagFilter maps to SDK Tag (no And wrapper)', async () => {
    await provider.update(
      'L',
      BUCKET_NAME,
      'AWS::S3::Bucket',
      {
        BucketName: BUCKET_NAME,
        ReplicationConfiguration: {
          Role: 'arn:aws:iam::1:role/repl',
          Rules: [
            {
              Id: 'r1',
              Status: 'Enabled',
              Priority: 1,
              Filter: { TagFilter: { Key: 'replicate', Value: 'yes' } },
              DeleteMarkerReplication: { Status: 'Disabled' },
              Destination: { Bucket: 'arn:aws:s3:::dest-bucket' },
            },
          ],
        },
      },
      { BucketName: BUCKET_NAME }
    );
    const rule = (
      callsOf(PutBucketReplicationCommand)[0].input as {
        ReplicationConfiguration: { Rules: any[] };
      }
    ).ReplicationConfiguration.Rules[0];
    expect(rule.Filter).toEqual({ Tag: { Key: 'replicate', Value: 'yes' } });
  });

  it('ReplicationConfiguration: standalone Filter.Prefix maps to SDK Prefix', async () => {
    await provider.update(
      'L',
      BUCKET_NAME,
      'AWS::S3::Bucket',
      {
        BucketName: BUCKET_NAME,
        ReplicationConfiguration: {
          Role: 'arn:aws:iam::1:role/repl',
          Rules: [
            {
              Id: 'r1',
              Status: 'Enabled',
              Priority: 1,
              Filter: { Prefix: 'logs/' },
              DeleteMarkerReplication: { Status: 'Disabled' },
              Destination: { Bucket: 'arn:aws:s3:::dest-bucket' },
            },
          ],
        },
      },
      { BucketName: BUCKET_NAME }
    );
    const rule = (
      callsOf(PutBucketReplicationCommand)[0].input as {
        ReplicationConfiguration: { Rules: any[] };
      }
    ).ReplicationConfiguration.Rules[0];
    expect(rule.Filter).toEqual({ Prefix: 'logs/' });
  });

  it('ReplicationConfiguration: empty-string Filter.Prefix is preserved, not dropped to {}', async () => {
    // The top-level prefix branch uses `prefix !== undefined` (not truthy), so an
    // empty-string prefix (replicate-all-under-root, a valid V2 form) round-trips
    // as `{ Prefix: '' }` instead of silently collapsing to `{}`. A truthy check
    // would drop it and break drift symmetry against the template.
    await provider.update(
      'L',
      BUCKET_NAME,
      'AWS::S3::Bucket',
      {
        BucketName: BUCKET_NAME,
        ReplicationConfiguration: {
          Role: 'arn:aws:iam::1:role/repl',
          Rules: [
            {
              Id: 'r1',
              Status: 'Enabled',
              Priority: 1,
              Filter: { Prefix: '' },
              DeleteMarkerReplication: { Status: 'Disabled' },
              Destination: { Bucket: 'arn:aws:s3:::dest-bucket' },
            },
          ],
        },
      },
      { BucketName: BUCKET_NAME }
    );
    const rule = (
      callsOf(PutBucketReplicationCommand)[0].input as {
        ReplicationConfiguration: { Rules: any[] };
      }
    ).ReplicationConfiguration.Rules[0];
    expect(rule.Filter).toEqual({ Prefix: '' });
  });

  it('ReplicationConfiguration: present -> absent fires DeleteBucketReplication', async () => {
    await provider.update(
      'L',
      BUCKET_NAME,
      'AWS::S3::Bucket',
      { BucketName: BUCKET_NAME },
      {
        BucketName: BUCKET_NAME,
        ReplicationConfiguration: {
          Role: 'arn:aws:iam::1:role/repl',
          Rules: [
            {
              Id: 'r1',
              Status: 'Enabled',
              Destination: { Bucket: 'arn:aws:s3:::dest-bucket' },
            },
          ],
        },
      }
    );
    expect(callsOf(DeleteBucketReplicationCommand)).toHaveLength(1);
    expect(callsOf(PutBucketReplicationCommand)).toHaveLength(0);
  });

  it('ReplicationConfiguration: unchanged fires no SDK call', async () => {
    const cfg = {
      Role: 'arn:aws:iam::1:role/repl',
      Rules: [
        {
          Id: 'r1',
          Status: 'Enabled',
          Destination: { Bucket: 'arn:aws:s3:::dest-bucket' },
        },
      ],
    };
    await provider.update(
      'L',
      BUCKET_NAME,
      'AWS::S3::Bucket',
      { BucketName: BUCKET_NAME, ReplicationConfiguration: cfg },
      { BucketName: BUCKET_NAME, ReplicationConfiguration: cfg }
    );
    expect(callsOf(PutBucketReplicationCommand)).toHaveLength(0);
    expect(callsOf(DeleteBucketReplicationCommand)).toHaveLength(0);
  });

  it('ReplicationConfiguration: present -> present (different role) fires Put', async () => {
    await provider.update(
      'L',
      BUCKET_NAME,
      'AWS::S3::Bucket',
      {
        BucketName: BUCKET_NAME,
        ReplicationConfiguration: {
          Role: 'arn:aws:iam::1:role/repl-v2',
          Rules: [
            {
              Id: 'r1',
              Status: 'Enabled',
              Destination: { Bucket: 'arn:aws:s3:::dest-bucket' },
            },
          ],
        },
      },
      {
        BucketName: BUCKET_NAME,
        ReplicationConfiguration: {
          Role: 'arn:aws:iam::1:role/repl',
          Rules: [
            {
              Id: 'r1',
              Status: 'Enabled',
              Destination: { Bucket: 'arn:aws:s3:::dest-bucket' },
            },
          ],
        },
      }
    );
    expect(callsOf(PutBucketReplicationCommand)).toHaveLength(1);
  });

  // -------------------------------------------------------------------
  // ObjectLockConfiguration (Put-only — clearing fires Put with empty Rule)
  // -------------------------------------------------------------------

  it('ObjectLockConfiguration: absent -> present fires PutObjectLockConfiguration', async () => {
    await provider.update(
      'L',
      BUCKET_NAME,
      'AWS::S3::Bucket',
      {
        BucketName: BUCKET_NAME,
        ObjectLockConfiguration: {
          ObjectLockEnabled: 'Enabled',
          Rule: { DefaultRetention: { Mode: 'GOVERNANCE', Days: 30 } },
        },
      },
      { BucketName: BUCKET_NAME }
    );
    expect(callsOf(PutObjectLockConfigurationCommand)).toHaveLength(1);
  });

  it('ObjectLockConfiguration: present -> absent fires Put with bucket-level enable only (clears Rule)', async () => {
    await provider.update(
      'L',
      BUCKET_NAME,
      'AWS::S3::Bucket',
      { BucketName: BUCKET_NAME },
      {
        BucketName: BUCKET_NAME,
        ObjectLockConfiguration: {
          ObjectLockEnabled: 'Enabled',
          Rule: { DefaultRetention: { Mode: 'GOVERNANCE', Days: 30 } },
        },
      }
    );
    const calls = callsOf(PutObjectLockConfigurationCommand);
    expect(calls).toHaveLength(1);
    expect((calls[0] as { input: { ObjectLockConfiguration: object } }).input
      .ObjectLockConfiguration).toEqual({ ObjectLockEnabled: 'Enabled' });
  });

  it('ObjectLockConfiguration: unchanged fires no SDK call', async () => {
    const cfg = {
      ObjectLockEnabled: 'Enabled',
      Rule: { DefaultRetention: { Mode: 'GOVERNANCE', Days: 30 } },
    };
    await provider.update(
      'L',
      BUCKET_NAME,
      'AWS::S3::Bucket',
      { BucketName: BUCKET_NAME, ObjectLockConfiguration: cfg },
      { BucketName: BUCKET_NAME, ObjectLockConfiguration: cfg }
    );
    expect(callsOf(PutObjectLockConfigurationCommand)).toHaveLength(0);
  });

  it('ObjectLockConfiguration: present -> present (different days) fires Put', async () => {
    await provider.update(
      'L',
      BUCKET_NAME,
      'AWS::S3::Bucket',
      {
        BucketName: BUCKET_NAME,
        ObjectLockConfiguration: {
          ObjectLockEnabled: 'Enabled',
          Rule: { DefaultRetention: { Mode: 'GOVERNANCE', Days: 60 } },
        },
      },
      {
        BucketName: BUCKET_NAME,
        ObjectLockConfiguration: {
          ObjectLockEnabled: 'Enabled',
          Rule: { DefaultRetention: { Mode: 'GOVERNANCE', Days: 30 } },
        },
      }
    );
    expect(callsOf(PutObjectLockConfigurationCommand)).toHaveLength(1);
  });

  // -------------------------------------------------------------------
  // AccelerateConfiguration (Put-only — Suspended clears)
  // -------------------------------------------------------------------

  it('AccelerateConfiguration: absent -> Enabled fires PutBucketAccelerateConfiguration', async () => {
    await provider.update(
      'L',
      BUCKET_NAME,
      'AWS::S3::Bucket',
      {
        BucketName: BUCKET_NAME,
        AccelerateConfiguration: { AccelerationStatus: 'Enabled' },
      },
      { BucketName: BUCKET_NAME }
    );
    expect(callsOf(PutBucketAccelerateConfigurationCommand)).toHaveLength(1);
  });

  it('AccelerateConfiguration: present -> absent fires Put with Status=Suspended', async () => {
    await provider.update(
      'L',
      BUCKET_NAME,
      'AWS::S3::Bucket',
      { BucketName: BUCKET_NAME },
      {
        BucketName: BUCKET_NAME,
        AccelerateConfiguration: { AccelerationStatus: 'Enabled' },
      }
    );
    const calls = callsOf(PutBucketAccelerateConfigurationCommand);
    expect(calls).toHaveLength(1);
    expect(
      (calls[0] as { input: { AccelerateConfiguration: { Status: string } } }).input
        .AccelerateConfiguration.Status
    ).toBe('Suspended');
  });

  it('AccelerateConfiguration: unchanged fires no SDK call', async () => {
    const cfg = { AccelerationStatus: 'Enabled' };
    await provider.update(
      'L',
      BUCKET_NAME,
      'AWS::S3::Bucket',
      { BucketName: BUCKET_NAME, AccelerateConfiguration: cfg },
      { BucketName: BUCKET_NAME, AccelerateConfiguration: cfg }
    );
    expect(callsOf(PutBucketAccelerateConfigurationCommand)).toHaveLength(0);
  });

  it('AccelerateConfiguration: Enabled -> Suspended fires Put', async () => {
    await provider.update(
      'L',
      BUCKET_NAME,
      'AWS::S3::Bucket',
      {
        BucketName: BUCKET_NAME,
        AccelerateConfiguration: { AccelerationStatus: 'Suspended' },
      },
      {
        BucketName: BUCKET_NAME,
        AccelerateConfiguration: { AccelerationStatus: 'Enabled' },
      }
    );
    expect(callsOf(PutBucketAccelerateConfigurationCommand)).toHaveLength(1);
  });

  // -------------------------------------------------------------------
  // MetricsConfigurations[] — per-id diff
  // -------------------------------------------------------------------

  it('MetricsConfigurations: new id fires Put for that id', async () => {
    await provider.update(
      'L',
      BUCKET_NAME,
      'AWS::S3::Bucket',
      {
        BucketName: BUCKET_NAME,
        MetricsConfigurations: [{ Id: 'm1' }],
      },
      { BucketName: BUCKET_NAME }
    );
    const calls = callsOf(PutBucketMetricsConfigurationCommand);
    expect(calls).toHaveLength(1);
    expect((calls[0] as { input: { Id: string } }).input.Id).toBe('m1');
    expect(callsOf(DeleteBucketMetricsConfigurationCommand)).toHaveLength(0);
  });

  it('MetricsConfigurations: removed id fires Delete for that id', async () => {
    await provider.update(
      'L',
      BUCKET_NAME,
      'AWS::S3::Bucket',
      { BucketName: BUCKET_NAME },
      {
        BucketName: BUCKET_NAME,
        MetricsConfigurations: [{ Id: 'm1' }],
      }
    );
    const calls = callsOf(DeleteBucketMetricsConfigurationCommand);
    expect(calls).toHaveLength(1);
    expect((calls[0] as { input: { Id: string } }).input.Id).toBe('m1');
    expect(callsOf(PutBucketMetricsConfigurationCommand)).toHaveLength(0);
  });

  it('MetricsConfigurations: changed body for same id fires Put (overwrites)', async () => {
    await provider.update(
      'L',
      BUCKET_NAME,
      'AWS::S3::Bucket',
      {
        BucketName: BUCKET_NAME,
        MetricsConfigurations: [{ Id: 'm1', Prefix: 'docs/' }],
      },
      {
        BucketName: BUCKET_NAME,
        MetricsConfigurations: [{ Id: 'm1', Prefix: 'images/' }],
      }
    );
    expect(callsOf(PutBucketMetricsConfigurationCommand)).toHaveLength(1);
    expect(callsOf(DeleteBucketMetricsConfigurationCommand)).toHaveLength(0);
  });

  it('MetricsConfigurations: mixed add/remove/unchanged fires expected calls', async () => {
    await provider.update(
      'L',
      BUCKET_NAME,
      'AWS::S3::Bucket',
      {
        BucketName: BUCKET_NAME,
        MetricsConfigurations: [
          { Id: 'kept', Prefix: 'a/' },
          { Id: 'added', Prefix: 'b/' },
        ],
      },
      {
        BucketName: BUCKET_NAME,
        MetricsConfigurations: [
          { Id: 'kept', Prefix: 'a/' },
          { Id: 'removed', Prefix: 'c/' },
        ],
      }
    );

    const puts = callsOf(PutBucketMetricsConfigurationCommand);
    const deletes = callsOf(DeleteBucketMetricsConfigurationCommand);
    expect(puts).toHaveLength(1);
    expect(deletes).toHaveLength(1);
    expect((puts[0] as { input: { Id: string } }).input.Id).toBe('added');
    expect((deletes[0] as { input: { Id: string } }).input.Id).toBe('removed');
  });

  // -------------------------------------------------------------------
  // AnalyticsConfigurations[] — per-id diff
  // -------------------------------------------------------------------

  it('AnalyticsConfigurations: new id fires Put for that id', async () => {
    await provider.update(
      'L',
      BUCKET_NAME,
      'AWS::S3::Bucket',
      {
        BucketName: BUCKET_NAME,
        AnalyticsConfigurations: [{ Id: 'a1' }],
      },
      { BucketName: BUCKET_NAME }
    );
    expect(callsOf(PutBucketAnalyticsConfigurationCommand)).toHaveLength(1);
    expect(callsOf(DeleteBucketAnalyticsConfigurationCommand)).toHaveLength(0);
  });

  it('AnalyticsConfigurations: removed id fires Delete', async () => {
    await provider.update(
      'L',
      BUCKET_NAME,
      'AWS::S3::Bucket',
      { BucketName: BUCKET_NAME },
      {
        BucketName: BUCKET_NAME,
        AnalyticsConfigurations: [{ Id: 'a1' }],
      }
    );
    expect(callsOf(DeleteBucketAnalyticsConfigurationCommand)).toHaveLength(1);
  });

  it('AnalyticsConfigurations: changed body for same id fires Put', async () => {
    await provider.update(
      'L',
      BUCKET_NAME,
      'AWS::S3::Bucket',
      {
        BucketName: BUCKET_NAME,
        AnalyticsConfigurations: [{ Id: 'a1', Prefix: 'after/' }],
      },
      {
        BucketName: BUCKET_NAME,
        AnalyticsConfigurations: [{ Id: 'a1', Prefix: 'before/' }],
      }
    );
    expect(callsOf(PutBucketAnalyticsConfigurationCommand)).toHaveLength(1);
  });

  it('AnalyticsConfigurations: mixed add/remove/unchanged fires expected calls', async () => {
    await provider.update(
      'L',
      BUCKET_NAME,
      'AWS::S3::Bucket',
      {
        BucketName: BUCKET_NAME,
        AnalyticsConfigurations: [
          { Id: 'kept' },
          { Id: 'added' },
        ],
      },
      {
        BucketName: BUCKET_NAME,
        AnalyticsConfigurations: [
          { Id: 'kept' },
          { Id: 'removed' },
        ],
      }
    );
    expect(callsOf(PutBucketAnalyticsConfigurationCommand)).toHaveLength(1);
    expect(callsOf(DeleteBucketAnalyticsConfigurationCommand)).toHaveLength(1);
  });

  // -------------------------------------------------------------------
  // IntelligentTieringConfigurations[] — per-id diff
  // -------------------------------------------------------------------

  it('IntelligentTieringConfigurations: new id fires Put', async () => {
    await provider.update(
      'L',
      BUCKET_NAME,
      'AWS::S3::Bucket',
      {
        BucketName: BUCKET_NAME,
        IntelligentTieringConfigurations: [
          { Id: 'it1', Tierings: [{ AccessTier: 'ARCHIVE_ACCESS', Days: 90 }] },
        ],
      },
      { BucketName: BUCKET_NAME }
    );
    expect(callsOf(PutBucketIntelligentTieringConfigurationCommand)).toHaveLength(1);
  });

  it('IntelligentTieringConfigurations: removed id fires Delete', async () => {
    await provider.update(
      'L',
      BUCKET_NAME,
      'AWS::S3::Bucket',
      { BucketName: BUCKET_NAME },
      {
        BucketName: BUCKET_NAME,
        IntelligentTieringConfigurations: [
          { Id: 'it1', Tierings: [{ AccessTier: 'ARCHIVE_ACCESS', Days: 90 }] },
        ],
      }
    );
    expect(callsOf(DeleteBucketIntelligentTieringConfigurationCommand)).toHaveLength(1);
  });

  it('IntelligentTieringConfigurations: changed Tierings.Days for same id fires Put', async () => {
    await provider.update(
      'L',
      BUCKET_NAME,
      'AWS::S3::Bucket',
      {
        BucketName: BUCKET_NAME,
        IntelligentTieringConfigurations: [
          { Id: 'it1', Tierings: [{ AccessTier: 'ARCHIVE_ACCESS', Days: 180 }] },
        ],
      },
      {
        BucketName: BUCKET_NAME,
        IntelligentTieringConfigurations: [
          { Id: 'it1', Tierings: [{ AccessTier: 'ARCHIVE_ACCESS', Days: 90 }] },
        ],
      }
    );
    expect(callsOf(PutBucketIntelligentTieringConfigurationCommand)).toHaveLength(1);
  });

  it('IntelligentTieringConfigurations: mixed add/remove/unchanged fires expected calls', async () => {
    await provider.update(
      'L',
      BUCKET_NAME,
      'AWS::S3::Bucket',
      {
        BucketName: BUCKET_NAME,
        IntelligentTieringConfigurations: [
          { Id: 'kept', Tierings: [{ AccessTier: 'ARCHIVE_ACCESS', Days: 90 }] },
          { Id: 'added', Tierings: [{ AccessTier: 'DEEP_ARCHIVE_ACCESS', Days: 180 }] },
        ],
      },
      {
        BucketName: BUCKET_NAME,
        IntelligentTieringConfigurations: [
          { Id: 'kept', Tierings: [{ AccessTier: 'ARCHIVE_ACCESS', Days: 90 }] },
          { Id: 'removed', Tierings: [{ AccessTier: 'ARCHIVE_ACCESS', Days: 90 }] },
        ],
      }
    );
    expect(callsOf(PutBucketIntelligentTieringConfigurationCommand)).toHaveLength(1);
    expect(callsOf(DeleteBucketIntelligentTieringConfigurationCommand)).toHaveLength(1);
  });

  // -------------------------------------------------------------------
  // InventoryConfigurations[] — per-id diff
  // -------------------------------------------------------------------

  it('InventoryConfigurations: new id fires Put', async () => {
    await provider.update(
      'L',
      BUCKET_NAME,
      'AWS::S3::Bucket',
      {
        BucketName: BUCKET_NAME,
        InventoryConfigurations: [
          {
            Id: 'inv1',
            Destination: { BucketArn: 'arn:aws:s3:::inv-bucket', Format: 'CSV' },
            ScheduleFrequency: 'Weekly',
          },
        ],
      },
      { BucketName: BUCKET_NAME }
    );
    expect(callsOf(PutBucketInventoryConfigurationCommand)).toHaveLength(1);
  });

  it('InventoryConfigurations: removed id fires Delete', async () => {
    await provider.update(
      'L',
      BUCKET_NAME,
      'AWS::S3::Bucket',
      { BucketName: BUCKET_NAME },
      {
        BucketName: BUCKET_NAME,
        InventoryConfigurations: [
          {
            Id: 'inv1',
            Destination: { BucketArn: 'arn:aws:s3:::inv-bucket', Format: 'CSV' },
            ScheduleFrequency: 'Weekly',
          },
        ],
      }
    );
    expect(callsOf(DeleteBucketInventoryConfigurationCommand)).toHaveLength(1);
  });

  it('InventoryConfigurations: changed body for same id fires Put', async () => {
    await provider.update(
      'L',
      BUCKET_NAME,
      'AWS::S3::Bucket',
      {
        BucketName: BUCKET_NAME,
        InventoryConfigurations: [
          {
            Id: 'inv1',
            Destination: { BucketArn: 'arn:aws:s3:::inv-bucket', Format: 'CSV' },
            ScheduleFrequency: 'Daily',
          },
        ],
      },
      {
        BucketName: BUCKET_NAME,
        InventoryConfigurations: [
          {
            Id: 'inv1',
            Destination: { BucketArn: 'arn:aws:s3:::inv-bucket', Format: 'CSV' },
            ScheduleFrequency: 'Weekly',
          },
        ],
      }
    );
    expect(callsOf(PutBucketInventoryConfigurationCommand)).toHaveLength(1);
  });

  it('InventoryConfigurations: mixed add/remove/unchanged fires expected calls', async () => {
    await provider.update(
      'L',
      BUCKET_NAME,
      'AWS::S3::Bucket',
      {
        BucketName: BUCKET_NAME,
        InventoryConfigurations: [
          {
            Id: 'kept',
            Destination: { BucketArn: 'arn:aws:s3:::inv-bucket', Format: 'CSV' },
            ScheduleFrequency: 'Weekly',
          },
          {
            Id: 'added',
            Destination: { BucketArn: 'arn:aws:s3:::inv-bucket', Format: 'Parquet' },
            ScheduleFrequency: 'Daily',
          },
        ],
      },
      {
        BucketName: BUCKET_NAME,
        InventoryConfigurations: [
          {
            Id: 'kept',
            Destination: { BucketArn: 'arn:aws:s3:::inv-bucket', Format: 'CSV' },
            ScheduleFrequency: 'Weekly',
          },
          {
            Id: 'removed',
            Destination: { BucketArn: 'arn:aws:s3:::inv-bucket', Format: 'CSV' },
            ScheduleFrequency: 'Weekly',
          },
        ],
      }
    );
    expect(callsOf(PutBucketInventoryConfigurationCommand)).toHaveLength(1);
    expect(callsOf(DeleteBucketInventoryConfigurationCommand)).toHaveLength(1);
  });
});

// Issue #1134: the `aws:cdk:path` tag walk is removed. AWS rejects
// `aws:`-prefixed tag writes, so that tag never exists on a real resource and
// the walk could not match. import() now resolves only from an explicit
// `--resource` / `Properties.BucketName`; anything else returns null without a
// lookup.
describe('S3BucketProvider import', () => {
  const CDK_PATH = 'MyStack/MyBucket/Resource';

  beforeEach(() => {
    vi.clearAllMocks();
    // Drop once-queued responses leaked by earlier tests - clearAllMocks()
    // clears calls but NOT unconsumed mockResolvedValueOnce entries.
    mockSend.mockReset();
  });

  const importInput = () => ({
    logicalId: 'MyBucket',
    resourceType: 'AWS::S3::Bucket',
    cdkPath: CDK_PATH,
    stackName: 'MyStack',
    region: 'us-east-1',
    properties: {},
  });

  it('returns null without any AWS call when no explicit id is given', async () => {
    const provider = new S3BucketProvider();
    const result = await provider.import(importInput());

    expect(result).toBeNull();
    expect(mockSend).not.toHaveBeenCalled();
  });
});
