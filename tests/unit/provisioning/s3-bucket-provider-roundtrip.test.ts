import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  GetBucketTaggingCommand,
  PutBucketEncryptionCommand,
  PutBucketCorsCommand,
  DeleteBucketCorsCommand,
  PutBucketLifecycleConfigurationCommand,
  DeleteBucketLifecycleCommand,
  DeleteBucketEncryptionCommand,
  PutBucketOwnershipControlsCommand,
  DeleteBucketOwnershipControlsCommand,
  PutPublicAccessBlockCommand,
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
import { getLogger } from '../../../src/utils/logger.js';

/** The single mocked child logger every provider instance resolves to. */
const childLogger = (getLogger() as unknown as { child: () => { warn: ReturnType<typeof vi.fn> } }).child();

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
    // GetBucketOwnershipControls — absent
    mockSend.mockRejectedValueOnce(notConfigured('OwnershipControlsNotFoundError'));
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
    // GetBucketOwnershipControls — absent
    mockSend.mockRejectedValueOnce(notConfigured('OwnershipControlsNotFoundError'));
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
  // for the tag path (the diff-aware applyTagDiff). Since issue #1466
  // Versioning / OwnershipControls / BucketEncryption are diff-managed too, so
  // they issue no call either when unchanged; PublicAccessBlockConfiguration
  // is the one remaining always-PUT path and DOES re-PUT, but only with the
  // same observed shape, which AWS accepts as a no-op.
  // -------------------------------------------------------------------

  it('round-trip on no-drift snapshot does not issue PutBucketTagging or DeleteBucketTagging', async () => {
    const observed = {
      BucketName: BUCKET_NAME,
      VersioningConfiguration: { Status: 'Suspended' },
      BucketEncryption: { ServerSideEncryptionConfiguration: [] },
      // readCurrentState always-emits this too (issue #1466); keep the
      // observed snapshot faithful so the no-drift claim stays real.
      OwnershipControls: { Rules: [] },
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
      // readCurrentState always-emits this too (issue #1466); keep the
      // observed snapshot faithful so the no-drift claim stays real.
      OwnershipControls: { Rules: [] },
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

  it('versioning placeholder round-trips as a NO-OP when it did not change', async () => {
    // Since issue #1466 VersioningConfiguration is on the diff path, so an
    // unchanged Suspended placeholder issues no call at all (it used to
    // always-PUT). Pinning the negative direction alone would be vacuous —
    // the positive direction is pinned by the test below.
    const observed = {
      BucketName: BUCKET_NAME,
      VersioningConfiguration: { Status: 'Suspended' },
      Tags: [] as Array<{ Key: string; Value: string }>,
    };

    mockSend.mockResolvedValue({});

    await provider.update('L', BUCKET_NAME, 'AWS::S3::Bucket', observed, observed);

    expect(
      mockSend.mock.calls.filter((c) => c[0] instanceof PutBucketVersioningCommand)
    ).toHaveLength(0);
  });

  it('versioning revert (drifted Enabled -> desired Suspended) fires a shape-valid Put', async () => {
    // The `cdkd drift --revert` direction: desired side is cdkd state, previous
    // side is the AWS-observed value. The Put must still carry the AWS-accepted
    // `Status: 'Suspended'` shape, not an AWS-rejection shape.
    mockSend.mockResolvedValue({});

    await provider.update(
      'L',
      BUCKET_NAME,
      'AWS::S3::Bucket',
      { BucketName: BUCKET_NAME, VersioningConfiguration: { Status: 'Suspended' } },
      { BucketName: BUCKET_NAME, VersioningConfiguration: { Status: 'Enabled' } }
    );

    const versioningCalls = mockSend.mock.calls.filter(
      (c) => c[0] instanceof PutBucketVersioningCommand
    );
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
    mockSend.mockRejectedValueOnce(notConfigured('OwnershipControlsNotFoundError'));
    mockSend.mockRejectedValueOnce(notConfigured('NoSuchPublicAccessBlockConfiguration'));
    // GetBucketTagging — real user tag present
    mockSend.mockResolvedValueOnce({
      TagSet: [{ Key: 'Owner', Value: 'platform' }],
    });

    const result = await provider.readCurrentState(BUCKET_NAME, 'L', 'AWS::S3::Bucket');

    // Index 5, not 4: readOwnershipControls was inserted ahead of the PAB /
    // Tags reads by issue #1466.
    expect(mockSend.mock.calls[5]?.[0]).toBeInstanceOf(GetBucketTaggingCommand);
    expect(result?.Tags).toEqual([{ Key: 'Owner', Value: 'platform' }]);
  });
});

// =====================================================================
// PR #215 sub-config update / delete round-trips
// =====================================================================
//
// applySubConfigDiffs() walks each of the 15 sub-configs (the original 12 plus
// VersioningConfiguration / OwnershipControls / BucketEncryption, moved onto
// the diff path by issue #1466) and issues:
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
  function callsOf(cmdClass: new (...args: never[]) => unknown): { input: unknown }[] {
    return mockSend.mock.calls
      .filter((c) => c[0] instanceof cmdClass)
      .map((c) => c[0] as { input: unknown });
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
  beforeEach(() => {
    vi.clearAllMocks();
    // Drop once-queued responses leaked by earlier tests - clearAllMocks()
    // clears calls but NOT unconsumed mockResolvedValueOnce entries.
    mockSend.mockReset();
  });

  const importInput = () => ({
    logicalId: 'MyBucket',
    resourceType: 'AWS::S3::Bucket',
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

// =====================================================================
// Issue #1466 — removing VersioningConfiguration / OwnershipControls /
// BucketEncryption must reset the bucket the way CloudFormation does,
// instead of silently leaving the old value on the real bucket.
//
// The verdicts below are NOT inferred from the source; each was pinned by a
// live CloudFormation A/B on the same template pair (see the issue):
//   VersioningConfiguration  -> CFn suspends           => Put(Suspended)
//   OwnershipControls        -> CFn deletes            => DeleteBucketOwnershipControls
//   BucketEncryption         -> CFn resets to AES256   => DeleteBucketEncryption
//   PublicAccessBlockConfiguration -> CFn KEEPS it     => no call (parity)
// The PublicAccessBlock case is covered by a NEGATIVE test on purpose: it
// looks identical to the other three in the source, so without a test pinning
// "issues no call", a later consistency-minded refactor would turn cdkd's
// correct behavior into a divergence.
// =====================================================================

describe('S3BucketProvider removal semantics (issue #1466)', () => {
  let provider: S3BucketProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new S3BucketProvider();
    mockSend.mockResolvedValue({});
  });

  function callsOf(cmdClass: new (...args: never[]) => unknown): { input: unknown }[] {
    return mockSend.mock.calls
      .filter((c) => c[0] instanceof cmdClass)
      .map((c) => c[0] as { input: unknown });
  }

  /** Every warning this provider instance emitted, joined for substring asserts. */
  function warnings(): string {
    return childLogger.warn.mock.calls.map((c) => String(c[0])).join('\n');
  }

  const base = { BucketName: BUCKET_NAME };
  const update = (next: Record<string, unknown>, prev: Record<string, unknown>) =>
    provider.update('L', BUCKET_NAME, 'AWS::S3::Bucket', next, prev);

  // ---------------- VersioningConfiguration ----------------

  it('VersioningConfiguration: present -> absent suspends versioning', async () => {
    await update(base, { ...base, VersioningConfiguration: { Status: 'Enabled' } });
    const calls = callsOf(PutBucketVersioningCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.input).toMatchObject({
      Bucket: BUCKET_NAME,
      VersioningConfiguration: { Status: 'Suspended' },
    });
  });

  it('VersioningConfiguration: absent -> absent issues no call', async () => {
    await update(base, base);
    expect(callsOf(PutBucketVersioningCommand)).toHaveLength(0);
  });

  it('VersioningConfiguration: unchanged issues no call (no double-PUT)', async () => {
    const cfg = { Status: 'Enabled' };
    await update(
      { ...base, VersioningConfiguration: cfg },
      { ...base, VersioningConfiguration: cfg }
    );
    expect(callsOf(PutBucketVersioningCommand)).toHaveLength(0);
  });

  it('VersioningConfiguration: absent -> present enables exactly once', async () => {
    await update({ ...base, VersioningConfiguration: { Status: 'Enabled' } }, base);
    const calls = callsOf(PutBucketVersioningCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.input).toMatchObject({
      VersioningConfiguration: { Status: 'Enabled' },
    });
  });

  // ---------------- OwnershipControls ----------------

  it('OwnershipControls: present -> absent fires DeleteBucketOwnershipControls', async () => {
    await update(base, {
      ...base,
      OwnershipControls: { Rules: [{ ObjectOwnership: 'BucketOwnerPreferred' }] },
    });
    expect(callsOf(DeleteBucketOwnershipControlsCommand)).toHaveLength(1);
    expect(callsOf(PutBucketOwnershipControlsCommand)).toHaveLength(0);
  });

  it('OwnershipControls: absent -> present fires Put exactly once', async () => {
    await update(
      { ...base, OwnershipControls: { Rules: [{ ObjectOwnership: 'BucketOwnerEnforced' }] } },
      base
    );
    const calls = callsOf(PutBucketOwnershipControlsCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.input).toMatchObject({
      OwnershipControls: { Rules: [{ ObjectOwnership: 'BucketOwnerEnforced' }] },
    });
    expect(callsOf(DeleteBucketOwnershipControlsCommand)).toHaveLength(0);
  });

  it('OwnershipControls: unchanged issues no call (no double-PUT)', async () => {
    const cfg = { Rules: [{ ObjectOwnership: 'BucketOwnerEnforced' }] };
    await update({ ...base, OwnershipControls: cfg }, { ...base, OwnershipControls: cfg });
    expect(callsOf(PutBucketOwnershipControlsCommand)).toHaveLength(0);
    expect(callsOf(DeleteBucketOwnershipControlsCommand)).toHaveLength(0);
  });

  it('OwnershipControls: empty-Rules placeholder on either side is treated as absent', async () => {
    // readCurrentState emits `{ Rules: [] }` for an un-configured bucket; on a
    // `cdkd drift --revert` round-trip that must not look like a change.
    await update({ ...base, OwnershipControls: { Rules: [] } }, base);
    expect(callsOf(PutBucketOwnershipControlsCommand)).toHaveLength(0);
    expect(callsOf(DeleteBucketOwnershipControlsCommand)).toHaveLength(0);

    vi.clearAllMocks();
    mockSend.mockResolvedValue({});
    await update(base, { ...base, OwnershipControls: { Rules: [] } });
    expect(callsOf(DeleteBucketOwnershipControlsCommand)).toHaveLength(0);
  });

  // ---------------- BucketEncryption ----------------

  const sseKms = {
    ServerSideEncryptionConfiguration: [
      {
        ServerSideEncryptionByDefault: { SSEAlgorithm: 'aws:kms', KMSMasterKeyID: 'alias/aws/s3' },
        BucketKeyEnabled: true,
      },
    ],
  };

  it('BucketEncryption: present -> absent fires DeleteBucketEncryption', async () => {
    await update(base, { ...base, BucketEncryption: sseKms });
    expect(callsOf(DeleteBucketEncryptionCommand)).toHaveLength(1);
    expect(callsOf(PutBucketEncryptionCommand)).toHaveLength(0);
  });

  it('BucketEncryption: absent -> present fires Put exactly once', async () => {
    await update({ ...base, BucketEncryption: sseKms }, base);
    expect(callsOf(PutBucketEncryptionCommand)).toHaveLength(1);
    expect(callsOf(DeleteBucketEncryptionCommand)).toHaveLength(0);
  });

  it('BucketEncryption: unchanged issues no call (no double-PUT)', async () => {
    await update({ ...base, BucketEncryption: sseKms }, { ...base, BucketEncryption: sseKms });
    expect(callsOf(PutBucketEncryptionCommand)).toHaveLength(0);
    expect(callsOf(DeleteBucketEncryptionCommand)).toHaveLength(0);
  });

  it('BucketEncryption: empty-rules placeholder on either side is treated as absent', async () => {
    const placeholder = { ServerSideEncryptionConfiguration: [] };
    await update({ ...base, BucketEncryption: placeholder }, base);
    expect(callsOf(PutBucketEncryptionCommand)).toHaveLength(0);
    expect(callsOf(DeleteBucketEncryptionCommand)).toHaveLength(0);

    vi.clearAllMocks();
    mockSend.mockResolvedValue({});
    await update(base, { ...base, BucketEncryption: placeholder });
    expect(callsOf(DeleteBucketEncryptionCommand)).toHaveLength(0);
  });

  // ---------------- PublicAccessBlockConfiguration (VERIFIED PARITY) ----------------

  it('PublicAccessBlockConfiguration: present -> absent issues NO call at all (CFn parity)', async () => {
    // Live CFn A/B (issue #1466): CloudFormation leaves the public access
    // block in place when the property is removed. cdkd matches. Adding an
    // onRemove here would be a REGRESSION, not a fix.
    //
    // Asserted by COMMAND-NAME MATCH, not `callsOf(PutPublicAccessBlockCommand)`:
    // the refactor this test exists to block would add an onRemove issuing
    // `DeletePublicAccessBlockCommand`, which a Put-only assertion passes
    // unchanged -- i.e. it would be vacuous against its own stated threat.
    await update(base, {
      ...base,
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
    });
    const pabCommands = mockSend.mock.calls
      .map((c) => (c[0] as { constructor: { name: string } }).constructor.name)
      .filter((n) => /PublicAccessBlock/.test(n));
    expect(pabCommands).toEqual([]);
    // Nothing else should fire either for a pure PAB removal -- except the
    // read-only `GetBucketLocation` that confirms the recorded physical id
    // denotes a bucket in this region before any write (issue #2245). Asserted
    // as the WHOLE command list rather than by subtracting that one name, so
    // the "no call at all" claim keeps its force: any write the refactor this
    // test blocks would add still shows up here.
    expect(
      mockSend.mock.calls.map((c) => (c[0] as { constructor: { name: string } }).constructor.name)
    ).toEqual(['GetBucketLocationCommand']);
  });

  it('PublicAccessBlockConfiguration: still applied when present', async () => {
    await update({ ...base, PublicAccessBlockConfiguration: { BlockPublicAcls: true } }, base);
    expect(callsOf(PutPublicAccessBlockCommand)).toHaveLength(1);
  });

  // ---------------- CREATE still applies all three ----------------

  it('create() still applies all three diff-managed sub-configs exactly once', async () => {
    // `skipDiffManaged` defaults to false so CREATE keeps applying these on the
    // always-PUT path (there is no previous side to diff against). If that
    // default ever flipped -- or if create() started passing the flag -- a
    // bucket would be created with NO encryption and NO ownership controls,
    // silently. Nothing else in the suite covers the create() side of the flag.
    await provider.create('L', 'AWS::S3::Bucket', {
      BucketName: BUCKET_NAME,
      VersioningConfiguration: { Status: 'Enabled' },
      OwnershipControls: { Rules: [{ ObjectOwnership: 'BucketOwnerEnforced' }] },
      BucketEncryption: sseKms,
      PublicAccessBlockConfiguration: { BlockPublicAcls: true },
    });

    expect(callsOf(PutBucketVersioningCommand)).toHaveLength(1);
    expect(callsOf(PutBucketOwnershipControlsCommand)).toHaveLength(1);
    expect(callsOf(PutBucketEncryptionCommand)).toHaveLength(1);
    expect(callsOf(PutPublicAccessBlockCommand)).toHaveLength(1);
    // and no removal call leaks into the create path
    expect(callsOf(DeleteBucketOwnershipControlsCommand)).toHaveLength(0);
    expect(callsOf(DeleteBucketEncryptionCommand)).toHaveLength(0);
  });

  // ---------------- changed-value direction ----------------

  it('OwnershipControls: present -> present (different) fires a single Put', async () => {
    await update(
      { ...base, OwnershipControls: { Rules: [{ ObjectOwnership: 'BucketOwnerEnforced' }] } },
      { ...base, OwnershipControls: { Rules: [{ ObjectOwnership: 'BucketOwnerPreferred' }] } }
    );
    const calls = callsOf(PutBucketOwnershipControlsCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.input).toMatchObject({
      OwnershipControls: { Rules: [{ ObjectOwnership: 'BucketOwnerEnforced' }] },
    });
    expect(callsOf(DeleteBucketOwnershipControlsCommand)).toHaveLength(0);
  });

  it('BucketEncryption: present -> present (different) fires a single Put', async () => {
    const sseS3 = {
      ServerSideEncryptionConfiguration: [
        { ServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } },
      ],
    };
    await update({ ...base, BucketEncryption: sseS3 }, { ...base, BucketEncryption: sseKms });
    expect(callsOf(PutBucketEncryptionCommand)).toHaveLength(1);
    expect(callsOf(DeleteBucketEncryptionCommand)).toHaveLength(0);
  });

  // ---------------- empty placeholder as the DESIRED side, real previous ----

  it('empty placeholder desired + real previous SKIPS (issue #1713 reverses #1466)', async () => {
    // **This row asserted the OPPOSITE until issue #1713**, and the reversal is
    // deliberate rather than a relaxation, so the old reasoning is kept here:
    // "the normalizer maps an empty container to `undefined` on BOTH sides, so
    // this is a genuine `declared -> not declared` transition and must remove,
    // matching CloudFormation."
    //
    // The premise was the CFn-parity claim, and it was asserted rather than
    // measured. Measured (us-east-1, 2026-08-12): updating a deployed bucket to
    // `ServerSideEncryptionConfiguration: []` / `Rules: []` drives the stack to
    // UPDATE_ROLLBACK_COMPLETE with "The XML you provided was not well-formed
    // or did not validate against our published schema", and BOTH live
    // configurations survive the rollback unchanged. So CFn treats the empty
    // collection as an INVALID TEMPLATE, not as a removal — the same answer the
    // #1671 A/B produced for lifecycle / CORS on the same date and account,
    // which is what made the two arms' disagreement a defect rather than a
    // design.
    //
    // A removal is still expressible and still works: DROP the property, which
    // the `control: REMOVING the property entirely` row below pins.
    await update(
      { ...base, OwnershipControls: { Rules: [] } },
      { ...base, OwnershipControls: { Rules: [{ ObjectOwnership: 'BucketOwnerPreferred' }] } }
    );
    expect(callsOf(DeleteBucketOwnershipControlsCommand)).toHaveLength(0);
    expect(callsOf(PutBucketOwnershipControlsCommand)).toHaveLength(0);

    vi.clearAllMocks();
    mockSend.mockResolvedValue({});
    await update(
      { ...base, BucketEncryption: { ServerSideEncryptionConfiguration: [] } },
      { ...base, BucketEncryption: sseKms }
    );
    expect(callsOf(DeleteBucketEncryptionCommand)).toHaveLength(0);
    expect(callsOf(PutBucketEncryptionCommand)).toHaveLength(0);
  });

  it('ABSENT desired + real previous still REMOVES (the transition #1466 meant)', async () => {
    // The half of #1466 that survives, and the discrimination #1713 rests on:
    // before the fix, declared-but-empty and ABSENT were literally the same
    // `undefined` after the fold, so this row and the one above could not
    // disagree. Now they do.
    await update({ ...base }, {
      ...base,
      OwnershipControls: { Rules: [{ ObjectOwnership: 'BucketOwnerPreferred' }] },
    });
    expect(callsOf(DeleteBucketOwnershipControlsCommand)).toHaveLength(1);

    vi.clearAllMocks();
    mockSend.mockResolvedValue({});
    await update({ ...base }, { ...base, BucketEncryption: sseKms });
    expect(callsOf(DeleteBucketEncryptionCommand)).toHaveLength(1);
  });
  // ---------------- review-found regressions (must stay closed) ----------

  it('MALFORMED (non-array) encryption config is NOT treated as a removal', async () => {
    // `emptyListConfigToUndefined` must fold only absent / genuinely-empty
    // lists. An unresolved intrinsic or a wrong-shaped L1 value is MALFORMED:
    // folding it to `undefined` would fire DeleteBucketEncryption and silently
    // downgrade a live bucket from KMS to AES256 while the template still
    // DECLARES encryption. It must pass through and FAIL LOUDLY instead --
    // in practice a local TypeError from the `.map` in applyBucketEncryption,
    // before any send(); the point is loud-not-silent, not where it throws.
    await expect(
      update(
        {
          ...base,
          BucketEncryption: {
            ServerSideEncryptionConfiguration: { 'Fn::If': ['C', 'a', 'b'] } as never,
          },
        },
        { ...base, BucketEncryption: sseKms }
      )
    ).rejects.toThrow();
    // The load-bearing assertion: it took the Put path and FAILED LOUDLY
    // rather than quietly deleting the bucket's encryption.
    expect(callsOf(DeleteBucketEncryptionCommand)).toHaveLength(0);
  });

  it('versioning SUSPEND runs after the replication removal, not before', async () => {
    // S3 rejects PutBucketVersioning(Suspended) while a replication config is
    // still active, so a template dropping BOTH in one update must delete the
    // replication first. Ordering is asserted on the real call sequence.
    await update(base, {
      ...base,
      VersioningConfiguration: { Status: 'Enabled' },
      ReplicationConfiguration: {
        Role: 'arn:aws:iam::123456789012:role/r',
        Rules: [{ Destination: { Bucket: 'arn:aws:s3:::dest' }, Status: 'Enabled' }],
      },
    });
    const names = mockSend.mock.calls.map(
      (c) => (c[0] as { constructor: { name: string } }).constructor.name
    );
    const replIdx = names.indexOf('DeleteBucketReplicationCommand');
    const verIdx = names.indexOf('PutBucketVersioningCommand');
    expect(replIdx).toBeGreaterThanOrEqual(0);
    expect(verIdx).toBeGreaterThanOrEqual(0);
    expect(replIdx).toBeLessThan(verIdx);
  });

  it('versioning SUSPEND is skipped WITH A WARNING on an Object-Lock bucket', async () => {
    // S3 refuses to suspend versioning on an Object-Lock bucket
    // (InvalidBucketState). Before the deferral this would have newly FAILED a
    // deploy that used to be a silent no-op.
    //
    // The warn is asserted, not just the absence of the Put: skipping SILENTLY
    // would satisfy a call-count-only check while leaving the user with no
    // signal that a property they removed was not applied.
    await update(
      { ...base, ObjectLockEnabled: true },
      { ...base, ObjectLockEnabled: true, VersioningConfiguration: { Status: 'Enabled' } }
    );
    expect(callsOf(PutBucketVersioningCommand)).toHaveLength(0);
    expect(childLogger.warn).toHaveBeenCalledWith(expect.stringContaining('Object Lock'));
  });

  it('create() with an empty OwnershipControls.Rules issues no Put', async () => {
    await provider.create('L', 'AWS::S3::Bucket', {
      BucketName: BUCKET_NAME,
      OwnershipControls: { Rules: [] },
    });
    expect(callsOf(PutBucketOwnershipControlsCommand)).toHaveLength(0);
  });
  it('EXPLICIT Suspended also defers past the replication removal (G1)', async () => {
    // The deferral is keyed on the RESULTING STATUS, not on "was the property
    // removed". An explicit `{Status:'Suspended'}` must take the late path too,
    // or dropping replication in the same update hits the very S3 rejection the
    // split exists to avoid. `drift --revert` reaches this form routinely,
    // because readCurrentState always emits Suspended for un-versioned buckets.
    await update(
      { ...base, VersioningConfiguration: { Status: 'Suspended' } },
      {
        ...base,
        VersioningConfiguration: { Status: 'Enabled' },
        ReplicationConfiguration: {
          Role: 'arn:aws:iam::123456789012:role/r',
          Rules: [{ Destination: { Bucket: 'arn:aws:s3:::dest' }, Status: 'Enabled' }],
        },
      }
    );
    const names = mockSend.mock.calls.map(
      (c) => (c[0] as { constructor: { name: string } }).constructor.name
    );
    const replIdx = names.indexOf('DeleteBucketReplicationCommand');
    const verIdx = names.indexOf('PutBucketVersioningCommand');
    expect(replIdx).toBeGreaterThanOrEqual(0);
    expect(verIdx).toBeGreaterThanOrEqual(0);
    expect(replIdx).toBeLessThan(verIdx);
  });

  it('ENABLE stays BEFORE an added replication config (G3)', async () => {
    // The mirror constraint: S3 requires versioning ON before a replication
    // config can be added, so the enable half must NOT drift to the tail.
    await update(
      {
        ...base,
        VersioningConfiguration: { Status: 'Enabled' },
        ReplicationConfiguration: {
          Role: 'arn:aws:iam::123456789012:role/r',
          Rules: [{ Destination: { Bucket: 'arn:aws:s3:::dest' }, Status: 'Enabled' }],
        },
      },
      base
    );
    const names = mockSend.mock.calls.map(
      (c) => (c[0] as { constructor: { name: string } }).constructor.name
    );
    const verIdx = names.indexOf('PutBucketVersioningCommand');
    const replIdx = names.indexOf('PutBucketReplicationCommand');
    expect(verIdx).toBeGreaterThanOrEqual(0);
    expect(replIdx).toBeGreaterThanOrEqual(0);
    expect(verIdx).toBeLessThan(replIdx);
  });

  it('null desired VersioningConfiguration is a removal, not a no-op', async () => {
    // `diffSubConfig` treats null as absent; the deferred suspend must use the
    // same nullish semantics or the removal is silently dropped.
    await update(
      { ...base, VersioningConfiguration: null as never },
      { ...base, VersioningConfiguration: { Status: 'Enabled' } }
    );
    const calls = callsOf(PutBucketVersioningCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.input).toMatchObject({ VersioningConfiguration: { Status: 'Suspended' } });
  });

  it('Object-Lock guard consults the PREVIOUS side too', async () => {
    // ObjectLockEnabled is not replacement-forcing for AWS::S3::Bucket, so
    // dropping it together with VersioningConfiguration takes the in-place
    // UPDATE path. Reading only the desired side would issue a suspend the
    // live bucket still refuses.
    await update(base, {
      ...base,
      ObjectLockEnabled: true,
      VersioningConfiguration: { Status: 'Enabled' },
    });
    expect(callsOf(PutBucketVersioningCommand)).toHaveLength(0);
  });

  it("Object-Lock guard accepts the 'true' STRING form of ObjectLockEnabled", async () => {
    // The configuration-block form is covered by 'a REAL ObjectLockConfiguration
    // (Enabled) still suppresses the suspend'; only the string form is new here.
    await update(
      { ...base, ObjectLockEnabled: 'true' },
      { ...base, ObjectLockEnabled: 'true', VersioningConfiguration: { Status: 'Enabled' } }
    );
    expect(callsOf(PutBucketVersioningCommand)).toHaveLength(0);
  });

  it('malformed shapes never become a removal (G4: {}, wrong nesting, non-array Rules)', async () => {
    // Every shape below previously normalized to `undefined` -> Delete.
    // `{}` alone IS "not declared" and legitimately removes; the others are
    // malformed and must not.
    // Each case scopes previous+desired to the ONE property under test, so the
    // assertion measures only that property's delete (a sibling property
    // absent from `desired` would be a legitimate removal and pollute a
    // summed counter).
    const realOwnership = { Rules: [{ ObjectOwnership: 'BucketOwnerPreferred' }] };
    const cases: Array<{
      label: string;
      key: 'BucketEncryption' | 'OwnershipControls';
      malformed: unknown;
      real: unknown;
    }> = [
      {
        label: 'encryption: list key absent but other keys present',
        key: 'BucketEncryption',
        malformed: { Bogus: 1 },
        real: sseKms,
      },
      {
        label: 'encryption: wrong nesting (array where object belongs)',
        key: 'BucketEncryption',
        malformed: [],
        real: sseKms,
      },
      {
        label: 'ownership: non-array Rules (unresolved intrinsic)',
        key: 'OwnershipControls',
        malformed: { Rules: { 'Fn::If': [] } },
        real: realOwnership,
      },
      {
        label: 'ownership: null Rules with other keys present',
        key: 'OwnershipControls',
        malformed: { Rules: null, X: 1 },
        real: realOwnership,
      },
    ];
    for (const { label, key, malformed, real } of cases) {
      vi.clearAllMocks();
      mockSend.mockResolvedValue({});
      // Assert the LOUD path explicitly rather than swallowing. "No delete"
      // alone is too weak: silently SKIPPING a malformed value -- the sibling
      // failure mode that existed on the CREATE path until this PR -- also
      // produces zero deletes and zero throws, and would pass a
      // swallow-and-count-deletes check.
      await expect(
        update({ ...base, [key]: malformed as never }, { ...base, [key]: real as never }),
        `${label} must fail loudly`
      ).rejects.toThrow();
      const deletes =
        key === 'BucketEncryption'
          ? callsOf(DeleteBucketEncryptionCommand)
          : callsOf(DeleteBucketOwnershipControlsCommand);
      expect(deletes, `${label} must not delete`).toHaveLength(0);
    }
  });

  it('a bare empty block IS a removal ({} == not declared)', async () => {
    // The counterpart to the case above: `{}` carries nothing, so it is
    // genuinely "not declared" and must still remove, matching CloudFormation.
    await update({ ...base, BucketEncryption: {} as never }, { ...base, BucketEncryption: sseKms });
    expect(callsOf(DeleteBucketEncryptionCommand)).toHaveLength(1);
  });
  it('CREATE rejects a malformed encryption block instead of silently skipping it', async () => {
    // Round-2 routed CREATE through the same normalizer as UPDATE. That is a
    // deliberate BEHAVIOR CHANGE: the old inline guard skipped a malformed
    // value, leaving a bucket unencrypted-by-declaration with no error and
    // nothing for drift to see. It now fails loudly (and the provider's
    // partial-create cleanup drops the just-created bucket).
    await expect(
      provider.create('L', 'AWS::S3::Bucket', {
        BucketName: BUCKET_NAME,
        BucketEncryption: { Bogus: 1 } as never,
      })
    ).rejects.toThrow();
    expect(callsOf(PutBucketEncryptionCommand)).toHaveLength(0);
  });

  it('CREATE skips the empty-list encryption placeholder without a Put', async () => {
    await provider.create('L', 'AWS::S3::Bucket', {
      BucketName: BUCKET_NAME,
      BucketEncryption: { ServerSideEncryptionConfiguration: [] },
    });
    expect(callsOf(PutBucketEncryptionCommand)).toHaveLength(0);
  });

  it('a scalar config value is malformed, not a removal', async () => {
    await expect(
      update({ ...base, BucketEncryption: 'unresolved' as never }, {
        ...base,
        BucketEncryption: sseKms,
      })
    ).rejects.toThrow();
    expect(callsOf(DeleteBucketEncryptionCommand)).toHaveLength(0);
  });

  it('{Rules: null} as the SOLE key is malformed; {} is a removal', async () => {
    // Deliberate asymmetry: `{}` carries nothing and is "not declared", but a
    // block that names the list key with a null value is a partially-pruned /
    // malformed shape and must not be read as a removal.
    await expect(
      update({ ...base, OwnershipControls: { Rules: null } as never }, {
        ...base,
        OwnershipControls: { Rules: [{ ObjectOwnership: 'BucketOwnerPreferred' }] },
      })
    ).rejects.toThrow();
    expect(callsOf(DeleteBucketOwnershipControlsCommand)).toHaveLength(0);

    vi.clearAllMocks();
    mockSend.mockResolvedValue({});
    await update({ ...base, OwnershipControls: {} as never }, {
      ...base,
      OwnershipControls: { Rules: [{ ObjectOwnership: 'BucketOwnerPreferred' }] },
    });
    expect(callsOf(DeleteBucketOwnershipControlsCommand)).toHaveLength(1);
  });

  it('Object-Lock guard: previous-side string and configuration-block forms', async () => {
    // The previous-side coverage that matters -- these are the shapes reachable
    // when the template DROPS object lock and versioning in the same update.
    await update(base, {
      ...base,
      ObjectLockEnabled: 'true',
      VersioningConfiguration: { Status: 'Enabled' },
    });
    expect(callsOf(PutBucketVersioningCommand)).toHaveLength(0);

    vi.clearAllMocks();
    mockSend.mockResolvedValue({});
    await update(base, {
      ...base,
      ObjectLockConfiguration: { ObjectLockEnabled: 'Enabled' },
      VersioningConfiguration: { Status: 'Enabled' },
    });
    expect(callsOf(PutBucketVersioningCommand)).toHaveLength(0);
  });

  it('re-ENABLE alongside an ADDED replication config stays EARLY', async () => {
    // The drift-revert re-enable shape: previously Suspended, now Enabled, with
    // replication added in the same update. Versioning must precede the
    // replication Put or S3 rejects the replication config.
    await update(
      {
        ...base,
        VersioningConfiguration: { Status: 'Enabled' },
        ReplicationConfiguration: {
          Role: 'arn:aws:iam::123456789012:role/r',
          Rules: [{ Destination: { Bucket: 'arn:aws:s3:::dest' }, Status: 'Enabled' }],
        },
      },
      { ...base, VersioningConfiguration: { Status: 'Suspended' } }
    );
    const names = mockSend.mock.calls.map(
      (c) => (c[0] as { constructor: { name: string } }).constructor.name
    );
    const verIdx = names.indexOf('PutBucketVersioningCommand');
    const replIdx = names.indexOf('PutBucketReplicationCommand');
    expect(verIdx).toBeGreaterThanOrEqual(0);
    expect(replIdx).toBeGreaterThanOrEqual(0);
    expect(verIdx).toBeLessThan(replIdx);
  });

  it('an empty VersioningConfiguration block means Suspended', async () => {
    await update(
      { ...base, VersioningConfiguration: {} },
      { ...base, VersioningConfiguration: { Status: 'Enabled' } }
    );
    const calls = callsOf(PutBucketVersioningCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.input).toMatchObject({ VersioningConfiguration: { Status: 'Suspended' } });
  });
  it('BLOCKER regression: an EMPTY ObjectLockConfiguration must not suppress the suspend', async () => {
    // `readObjectLock` always-emits `ObjectLockConfiguration` and returns `{}`
    // for a bucket with NO object lock, and `cdkd drift --revert` feeds that
    // snapshot in as both sides. A presence-only guard (`!== undefined`) is
    // therefore true for EVERY bucket on the revert path and would suppress
    // every legitimate suspend, leaving the drift permanently unfixable while
    // warning about object lock the bucket does not have.
    await update(
      { ...base, ObjectLockConfiguration: {} },
      {
        ...base,
        ObjectLockConfiguration: {},
        VersioningConfiguration: { Status: 'Enabled' },
      }
    );
    const calls = callsOf(PutBucketVersioningCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.input).toMatchObject({ VersioningConfiguration: { Status: 'Suspended' } });
  });

  it('a REAL ObjectLockConfiguration (Enabled) still suppresses the suspend', async () => {
    await update(
      { ...base, ObjectLockConfiguration: { ObjectLockEnabled: 'Enabled' } },
      {
        ...base,
        ObjectLockConfiguration: { ObjectLockEnabled: 'Enabled' },
        VersioningConfiguration: { Status: 'Enabled' },
      }
    );
    expect(callsOf(PutBucketVersioningCommand)).toHaveLength(0);
  });

  it('a malformed DESIRED VersioningConfiguration is never silently suspended (issues #1471 / #1605)', async () => {
    // The headline case. `VersioningConfiguration: 'Enabled'` used to index to
    // `undefined`, default to 'Suspended', and turn versioning OFF on a live
    // bucket with no error anywhere.
    //
    // #1471 closed that by THROWING here. #1605 downgraded the UPDATE path to
    // warn-and-skip, because this path is replay-reachable
    // (`rollback-executor.ts`'s revert arm and `cdkd drift --revert` both call
    // `update(..., previousState.properties, ...)`), so a throw fires on a
    // cdkd STATE record the user cannot edit. The LOAD-BEARING half is
    // unchanged and is what both issues are actually about: no suspend is
    // issued either way. See the create-path test below — that side still
    // throws, and the two deliberately DISAGREE now.
    await update({ ...base, VersioningConfiguration: 'Enabled' as never }, {
      ...base,
      VersioningConfiguration: { Status: 'Enabled' },
    });
    expect(callsOf(PutBucketVersioningCommand)).toHaveLength(0);
    expect(warnings()).toMatch(/VersioningConfiguration must be an object \(got a string\)/);
    expect(warnings()).toMatch(/Leaving the bucket's LIVE versioning state unchanged/);
  });

  it('a malformed PREVIOUS VersioningConfiguration stays permissive (issue #1471)', async () => {
    // The previous side comes from cdkd STATE, not the template. Refusing it
    // would make a stack whose state already holds a malformed value
    // permanently undeployable — editing the template would not help, because
    // the previous side stays malformed until a deploy succeeds. So this must
    // deploy cleanly and apply the (well-formed) desired value.
    await update({ ...base, VersioningConfiguration: { Status: 'Enabled' } }, {
      ...base,
      VersioningConfiguration: 'Enabled' as never,
    });
    const calls = callsOf(PutBucketVersioningCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.input).toMatchObject({ VersioningConfiguration: { Status: 'Enabled' } });
  });

  it('a present-but-blank desired Status is refused, but {} still means Suspended (issue #1471)', async () => {
    // Validating the CONTAINER alone is not enough: `{ Status: '' }` and
    // `{ Status: null }` both pass a typeof-object check and still fall
    // through to the 'Suspended' default.
    // Warn-and-skip on the UPDATE path since #1605 (see the headline test
    // above); the load-bearing half is still that no Put goes out.
    await update({ ...base, VersioningConfiguration: { Status: '' } }, {
      ...base,
      VersioningConfiguration: { Status: 'Enabled' },
    });
    expect(callsOf(PutBucketVersioningCommand)).toHaveLength(0);
    expect(warnings()).toMatch(/VersioningConfiguration\.Status must be a non-empty string/);

    // ... while an EMPTY block legitimately means Suspended and must keep
    // working — the rule is "absent key defaults", not "any object defaults".
    mockSend.mockClear();
    await update({ ...base, VersioningConfiguration: {} }, {
      ...base,
      VersioningConfiguration: { Status: 'Enabled' },
    });
    const calls = callsOf(PutBucketVersioningCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.input).toMatchObject({ VersioningConfiguration: { Status: 'Suspended' } });
  });

  it('malformed list configs fail by NAME, not with a bare TypeError', async () => {
    await expect(
      update({ ...base, OwnershipControls: { Rules: 'nope' } as never }, {
        ...base,
        OwnershipControls: { Rules: [{ ObjectOwnership: 'BucketOwnerPreferred' }] },
      })
    ).rejects.toThrow(/OwnershipControls\.Rules must be an array/);
  });
  it('an ObjectLockConfiguration WITHOUT ObjectLockEnabled must not suppress the suspend', async () => {
    // Strengthens the blocker test above: a shape heuristic ("the block has
    // keys, so it must be object lock") would pass that test while still being
    // wrong. Only reading the MEANINGFUL field distinguishes this from real
    // object lock, and this shape must still suspend.
    await update(
      { ...base, ObjectLockConfiguration: { Rule: { DefaultRetention: { Days: 1 } } } },
      {
        ...base,
        ObjectLockConfiguration: { Rule: { DefaultRetention: { Days: 1 } } },
        VersioningConfiguration: { Status: 'Enabled' },
      }
    );
    expect(callsOf(PutBucketVersioningCommand)).toHaveLength(1);
  });

  it('CREATE and UPDATE agree on a FALSY non-object config value', async () => {
    // The `!== undefined` (not truthiness) check on the create path. With a
    // truthy check, create SILENTLY SKIPS `BucketEncryption: ''` while update
    // throws — the asymmetry this PR set out to remove. Both must fail.
    await expect(
      provider.create('L', 'AWS::S3::Bucket', {
        BucketName: BUCKET_NAME,
        BucketEncryption: '' as never,
      })
    ).rejects.toThrow(/ServerSideEncryptionConfiguration must be an array/);

    vi.clearAllMocks();
    mockSend.mockResolvedValue({});
    await expect(
      update({ ...base, BucketEncryption: '' as never }, { ...base, BucketEncryption: sseKms })
    ).rejects.toThrow(/ServerSideEncryptionConfiguration must be an array/);
  });

  it('CREATE still REFUSES a malformed VersioningConfiguration (issues #1471 / #1605)', async () => {
    // The create path had the SAME asymmetry the encryption test above
    // describes, one property over: a truthy-but-malformed
    // `VersioningConfiguration: 'Enabled'` passed the truthiness gate, indexed
    // to `undefined`, and PUT Suspended — so a brand-new bucket came up
    // unversioned while the template declared Enabled, and the malformed value
    // was then recorded in state.
    //
    // This test used to assert that CREATE and UPDATE AGREE. Since #1605 they
    // deliberately DISAGREE, and the asymmetry is the point rather than an
    // oversight: on create the value is template-borne, so the user can act on
    // the error; on update it can be a cdkd STATE record with no template-side
    // remedy. What must not regress is this side — a template-path create is
    // still a hard refusal, and it is only the REPLAY create that downgrades
    // (pinned in the #1605 suite).
    await expect(
      provider.create('L', 'AWS::S3::Bucket', {
        BucketName: BUCKET_NAME,
        VersioningConfiguration: 'Enabled' as never,
      })
    ).rejects.toThrow(/VersioningConfiguration must be an object \(got a string\)/);
    expect(callsOf(PutBucketVersioningCommand)).toHaveLength(0);
  });

  it('refuses a malformed LoggingConfiguration instead of CLEARING logging (issue #1471)', async () => {
    // The clearing branch reads `loggingConfig['DestinationBucketName']`, so a
    // malformed container indexed to `undefined`, took the clear path, and
    // turned logging OFF on a bucket whose template declares it — the same
    // declaring-the-feature-disables-it shape as the versioning case, and NOT
    // reachable by guarding the LogFilePrefix read (control never gets there).
    await expect(
      provider.create('L', 'AWS::S3::Bucket', {
        BucketName: BUCKET_NAME,
        LoggingConfiguration: 'my-log-bucket' as never,
      })
    ).rejects.toThrow(/LoggingConfiguration must be an object \(got a string\)/);
  });

  it('keeps an EMPTY LogFilePrefix, which legitimately means "no prefix" (issue #1471)', async () => {
    // The blank-fallback relaxation, proven at the provider rather than only
    // in the helper: '' is a meaningful value here, not a malformed one.
    await provider.create('L', 'AWS::S3::Bucket', {
      BucketName: BUCKET_NAME,
      LoggingConfiguration: { DestinationBucketName: 'logs-bucket', LogFilePrefix: '' },
    });
    const calls = callsOf(PutBucketLoggingCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.input).toMatchObject({
      BucketLoggingStatus: {
        LoggingEnabled: { TargetBucket: 'logs-bucket', TargetPrefix: '' },
      },
    });
  });

  it('still CLEARS logging when the config is absent (the legitimate removal path)', async () => {
    // The guard must not turn the removal path into a refusal.
    await update({ ...base }, { ...base, LoggingConfiguration: { DestinationBucketName: 'b' } });
    const calls = callsOf(PutBucketLoggingCommand);
    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect(calls[calls.length - 1]!.input).toMatchObject({ BucketLoggingStatus: {} });
  });

  it('CREATE still applies a well-formed VersioningConfiguration', async () => {
    // The guard must not turn into a blanket refusal — the normal path has to
    // keep working, including the `{}`-means-Suspended shape.
    await provider.create('L', 'AWS::S3::Bucket', {
      BucketName: BUCKET_NAME,
      VersioningConfiguration: { Status: 'Enabled' },
    });
    const calls = callsOf(PutBucketVersioningCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.input).toMatchObject({ VersioningConfiguration: { Status: 'Enabled' } });
  });
});
