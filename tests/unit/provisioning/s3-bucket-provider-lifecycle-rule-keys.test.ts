import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { PutBucketLifecycleConfigurationCommand } from '@aws-sdk/client-s3';

/**
 * Issue #1388 regression coverage for `applyLifecycleConfiguration`.
 *
 * The CFn `AWS::S3::Bucket` lifecycle `Rule` has NO `Filter` member — every
 * scope component (`Prefix`, `TagFilters`, `ObjectSizeGreaterThan`,
 * `ObjectSizeLessThan`) and several actions live at the RULE level, and the
 * schema still accepts legacy singular action forms next to the modern plural
 * ones. The provider read a subset of those, so the rest vanished silently.
 *
 * The `TAG_SCOPED_RULES` / `LEGACY_SINGULAR_RULES` bags below are NOT
 * hand-invented: the tag / noncurrent / delete-marker shapes are copied
 * verbatim from a real `cdk synth` of `s3.Bucket({ lifecycleRules: [...] })`
 * (aws-cdk-lib 2.244.0), which is what proved these are CURRENT-CDK paths and
 * not just legacy-template trivia.
 */

const { mockSend, warnSpy } = vi.hoisted(() => ({ mockSend: vi.fn(), warnSpy: vi.fn() }));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    s3: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
  }),
}));

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: warnSpy,
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  return {
    getLogger: () => ({
      child: () => childLogger,
      debug: vi.fn(),
      info: vi.fn(),
      warn: warnSpy,
      error: vi.fn(),
    }),
  };
});

import { S3BucketProvider } from '../../../src/provisioning/providers/s3-bucket-provider.js';

const BUCKET_NAME = 'my-bucket';
const RESOURCE_TYPE = 'AWS::S3::Bucket';

/**
 * Verbatim `cdk synth` output for:
 *
 * ```ts
 * new s3.Bucket(stack, 'B', { versioned: true, lifecycleRules: [
 *   { id: 'tagScoped', tagFilters: { env: 'prod', team: 'core' }, expiration: Duration.days(30) },
 *   { id: 'oneTag', tagFilters: { env: 'dev' }, expiration: Duration.days(10) },
 *   { id: 'deleteMarker', expiredObjectDeleteMarker: true },
 * ]});
 * ```
 *
 * Note what is NOT here: no `Filter` wrapper anywhere. `TagFilters` and
 * `ExpiredObjectDeleteMarker` sit directly on the rule. That is the bug.
 */
const TAG_SCOPED_RULES: Array<Record<string, unknown>> = [
  {
    ExpirationInDays: 30,
    Id: 'tagScoped',
    Status: 'Enabled',
    TagFilters: [
      { Key: 'env', Value: 'prod' },
      { Key: 'team', Value: 'core' },
    ],
  },
  {
    ExpirationInDays: 10,
    Id: 'oneTag',
    Status: 'Enabled',
    TagFilters: [{ Key: 'env', Value: 'dev' }],
  },
  { ExpiredObjectDeleteMarker: true, Id: 'deleteMarker', Status: 'Enabled' },
];

/** The legacy singular action forms the CFn schema still accepts. */
const LEGACY_SINGULAR_RULES: Array<Record<string, unknown>> = [
  {
    Id: 'legacyTransition',
    Status: 'Enabled',
    Prefix: 'logs/',
    Transition: { StorageClass: 'GLACIER', TransitionInDays: 90 },
  },
  {
    Id: 'legacyNoncurrent',
    Status: 'Enabled',
    Prefix: 'archive/',
    // CFn spells the day count `TransitionInDays` here, NOT `NoncurrentDays`
    // (that is the SDK's name). Getting this wrong in a fixture would hide the
    // very translation the provider has to do.
    NoncurrentVersionTransition: { StorageClass: 'GLACIER', TransitionInDays: 30 },
    NoncurrentVersionExpirationInDays: 365,
  },
];

describe('S3 lifecycle rule-level + legacy singular keys (issue #1388)', () => {
  let provider: S3BucketProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new S3BucketProvider();
    mockSend.mockResolvedValue({});
  });

  const putRules = async (rules: Array<Record<string, unknown>>): Promise<any[]> => {
    await provider.update(
      'L',
      BUCKET_NAME,
      RESOURCE_TYPE,
      { BucketName: BUCKET_NAME, LifecycleConfiguration: { Rules: rules } },
      { BucketName: BUCKET_NAME }
    );
    const call = mockSend.mock.calls
      .map((c) => c[0])
      .find((c) => c instanceof PutBucketLifecycleConfigurationCommand);
    expect(call).toBeDefined();
    return (call as PutBucketLifecycleConfigurationCommand).input.LifecycleConfiguration!.Rules!;
  };

  describe('rule-level TagFilters (data-loss class)', () => {
    it('scopes a multi-tag rule with And.Tags instead of expiring the whole bucket', async () => {
      // Pre-fix the scope gatherer (`lifecycleRuleScope`, in-method `gatherScope`
      // at the time) read ONLY `Filter.TagFilters`, so this rule had
      // no scope at all and fell through to `Filter: { Prefix: '' }` — a
      // 30-day expiration applied to EVERY object in the bucket.
      const rules = await putRules(TAG_SCOPED_RULES);
      const tagScoped = rules.find((r) => r.ID === 'tagScoped');

      expect(tagScoped.Filter).toEqual({
        And: {
          Tags: [
            { Key: 'env', Value: 'prod' },
            { Key: 'team', Value: 'core' },
          ],
        },
      });
      // The catch-all shape must NOT be what we send.
      expect(tagScoped.Filter).not.toEqual({ Prefix: '' });
    });

    it('keeps EVERY tag — the SDK Tag member holds only one', async () => {
      // Fixing the gather alone would have traded one silent drop for
      // another: the single-component branch was `Tag: tagFilters[0]`.
      const rules = await putRules(TAG_SCOPED_RULES);
      const tagScoped = rules.find((r) => r.ID === 'tagScoped');
      expect(tagScoped.Filter.And.Tags).toHaveLength(2);
      expect(tagScoped.Filter.Tag).toBeUndefined();
    });

    it('uses the single-tag Tag form when exactly one tag is present', async () => {
      const rules = await putRules(TAG_SCOPED_RULES);
      const oneTag = rules.find((r) => r.ID === 'oneTag');
      expect(oneTag.Filter).toEqual({ Tag: { Key: 'env', Value: 'dev' } });
    });

    it('still combines tags with a prefix under And', async () => {
      const rules = await putRules([
        {
          Id: 'both',
          Status: 'Enabled',
          Prefix: 'data/',
          TagFilters: [{ Key: 'env', Value: 'prod' }],
        },
      ]);
      expect(rules[0]!.Filter).toEqual({
        And: {
          Prefix: 'data/',
          Tags: [{ Key: 'env', Value: 'prod' }],
          ObjectSizeGreaterThan: undefined,
          ObjectSizeLessThan: undefined,
        },
      });
    });
  });

  describe('rule-level ExpiredObjectDeleteMarker', () => {
    it('produces an Expiration so the rule is not action-less', async () => {
      // With no Expiration at all, S3 rejects the rule outright.
      const rules = await putRules(TAG_SCOPED_RULES);
      const marker = rules.find((r) => r.ID === 'deleteMarker');
      expect(marker.Expiration).toEqual({ ExpiredObjectDeleteMarker: true });
    });

    it('does not override an explicit Days expiration (S3 forbids combining them)', async () => {
      const rules = await putRules([
        {
          Id: 'both',
          Status: 'Enabled',
          Prefix: 'x/',
          ExpirationInDays: 30,
          ExpiredObjectDeleteMarker: true,
        },
      ]);
      expect(rules[0]!.Expiration).toEqual({ Days: 30 });
    });
  });

  describe('NoncurrentVersionTransitions day field (CFn TransitionInDays)', () => {
    it('reads TransitionInDays, the spelling a real cdk synth emits', async () => {
      // CFn spells the day count `TransitionInDays` here (verified in
      // aws-cdk-lib's NoncurrentVersionTransitionProperty AND in a real synth);
      // the SDK member is `NoncurrentDays`. The provider read only the SDK
      // spelling, so the value was `undefined` for EVERY real template and the
      // noncurrent-version transition lost its schedule. This is the plural
      // path, which predates the legacy-singular work below.
      const rules = await putRules([
        {
          Id: 'nvt',
          Status: 'Enabled',
          Prefix: 'x/',
          NoncurrentVersionTransitions: [{ StorageClass: 'GLACIER', TransitionInDays: 3 }],
        },
      ]);
      expect(rules[0]!.NoncurrentVersionTransitions).toEqual([
        { NoncurrentDays: 3, StorageClass: 'GLACIER', NewerNoncurrentVersions: undefined },
      ]);
    });

    it('still accepts the SDK spelling for imported / SDK-shaped input', async () => {
      const rules = await putRules([
        {
          Id: 'nvt',
          Status: 'Enabled',
          Prefix: 'x/',
          NoncurrentVersionTransitions: [{ StorageClass: 'GLACIER', NoncurrentDays: 9 }],
        },
      ]);
      expect(rules[0]!.NoncurrentVersionTransitions[0].NoncurrentDays).toBe(9);
    });
  });

  describe('legacy singular action forms', () => {
    it('maps the singular Transition into Transitions', async () => {
      const rules = await putRules(LEGACY_SINGULAR_RULES);
      const t = rules.find((r) => r.ID === 'legacyTransition');
      expect(t.Transitions).toEqual([
        { Days: 90, Date: undefined, StorageClass: 'GLACIER' },
      ]);
    });

    it('maps the singular NoncurrentVersionTransition and NoncurrentVersionExpirationInDays', async () => {
      const rules = await putRules(LEGACY_SINGULAR_RULES);
      const n = rules.find((r) => r.ID === 'legacyNoncurrent');
      expect(n.NoncurrentVersionTransitions).toEqual([
        { NoncurrentDays: 30, StorageClass: 'GLACIER', NewerNoncurrentVersions: undefined },
      ]);
      expect(n.NoncurrentVersionExpiration).toEqual({ NoncurrentDays: 365 });
    });

    it('uses the singular form only when the plural array is absent', async () => {
      // The both-present case is covered in the fix-back block below: the
      // plural wins, because concatenating can emit two transitions with the
      // same StorageClass and S3 rejects the whole configuration.
      const rules = await putRules([
        {
          Id: 'singular-only',
          Status: 'Enabled',
          Prefix: 'm/',
          Transition: { StorageClass: 'GLACIER', TransitionInDays: 90 },
        },
      ]);
      expect(rules[0]!.Transitions).toEqual([
        { Days: 90, Date: undefined, StorageClass: 'GLACIER' },
      ]);
    });

    it('lets the modern NoncurrentVersionExpiration object win over the legacy scalar', async () => {
      const rules = await putRules([
        {
          Id: 'winner',
          Status: 'Enabled',
          Prefix: 'w/',
          NoncurrentVersionExpiration: { NoncurrentDays: 10, NewerNoncurrentVersions: 2 },
          NoncurrentVersionExpirationInDays: 999,
        },
      ]);
      expect(rules[0]!.NoncurrentVersionExpiration).toEqual({
        NoncurrentDays: 10,
        NewerNoncurrentVersions: 2,
      });
    });
  });

  describe('review fix-backs (PR #1426)', () => {
    it('lets the plural win — and warns — when the singular COLLIDES on StorageClass', async () => {
      // S3 rejects two transitions with the same StorageClass and fails the
      // WHOLE PutBucketLifecycleConfiguration, so they cannot both be sent.
      // Dropping the loser silently would be the very thing this PR argues
      // against, so it warns.
      const rules = await putRules([
        {
          Id: 'collide',
          Status: 'Enabled',
          Prefix: 'm/',
          Transitions: [{ StorageClass: 'GLACIER', TransitionInDays: 30 }],
          Transition: { StorageClass: 'GLACIER', TransitionInDays: 90 },
        },
      ]);
      expect(rules[0]!.Transitions).toEqual([
        { Days: 30, Date: undefined, StorageClass: 'GLACIER' },
      ]);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('storage class GLACIER'));
    });

    it('KEEPS both when the singular is a DIFFERENT StorageClass', async () => {
      // S3 accepts them; dropping the singular here would lose a legitimate
      // template for no reason.
      const rules = await putRules([
        {
          Id: 'distinct',
          Status: 'Enabled',
          Prefix: 'm/',
          Transitions: [{ StorageClass: 'GLACIER', TransitionInDays: 30 }],
          Transition: { StorageClass: 'DEEP_ARCHIVE', TransitionInDays: 90 },
        },
      ]);
      expect(rules[0]!.Transitions.map((t: { StorageClass: string }) => t.StorageClass)).toEqual([
        'GLACIER',
        'DEEP_ARCHIVE',
      ]);
      expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining('storage class'));
    });

    it('merges the noncurrent pair the same way', async () => {
      const rules = await putRules([
        {
          Id: 'both-nvt',
          Status: 'Enabled',
          Prefix: 'm/',
          NoncurrentVersionTransitions: [{ StorageClass: 'GLACIER', TransitionInDays: 10 }],
          NoncurrentVersionTransition: { StorageClass: 'DEEP_ARCHIVE', TransitionInDays: 20 },
        },
      ]);
      expect(rules[0]!.NoncurrentVersionTransitions).toHaveLength(2);
      expect(rules[0]!.NoncurrentVersionTransitions[1].NoncurrentDays).toBe(20);
    });

    it('ignores ExpiredObjectDeleteMarker: false instead of warning or emitting it', async () => {
      // `false` is a legal synth (CDK's validation is truthy-gated). Treating
      // it as a request warned about a cleanup nobody asked for, and on a
      // marker-only rule emitted an action-less Expiration.
      const rules = await putRules([
        { Id: 'off', Status: 'Enabled', Prefix: 'o/', ExpiredObjectDeleteMarker: false },
        {
          Id: 'off-with-days',
          Status: 'Enabled',
          Prefix: 'od/',
          ExpirationInDays: 30,
          ExpiredObjectDeleteMarker: false,
        },
      ]);
      expect(rules[0]!.Expiration).toBeUndefined();
      expect(rules[1]!.Expiration).toEqual({ Days: 30 });
      expect(warnSpy).not.toHaveBeenCalledWith(
        expect.stringContaining('ExpiredObjectDeleteMarker')
      );
    });

    it('rejects a non-scalar CFn numeric instead of coercing it to 0', async () => {
      // `Number([])` is 0 and `Number([5])` is 5, so an unresolved-intrinsic
      // array would become a plausible-looking day count.
      const rules = await putRules([
        {
          Id: 'bad-num',
          Status: 'Enabled',
          Prefix: 'n/',
          NoncurrentVersionExpirationInDays: [],
          ExpirationInDays: 5,
        },
      ]);
      expect(rules[0]!.NoncurrentVersionExpiration).toBeUndefined();
    });

    it('ignores a non-object singular Transition (array / unresolved intrinsic)', async () => {
      // `typeof [] === 'object'`, so an unguarded check pushed it through as a
      // transition with no StorageClass and S3 answered MalformedXML for the
      // whole config.
      const rules = await putRules([
        { Id: 'bad', Status: 'Enabled', Prefix: 'b/', Transition: [], ExpirationInDays: 5 },
      ]);
      expect(rules[0]!.Transitions).toBeUndefined();
    });

    it('still applies the delete marker when Expiration is present but empty', async () => {
      // The nested branch emits an all-undefined object for an empty
      // `Expiration`, so gating on mere existence dropped the marker AND left
      // the rule action-less — the very failure the block exists to prevent.
      const rules = await putRules([
        {
          Id: 'degenerate',
          Status: 'Enabled',
          Prefix: 'd/',
          Expiration: {},
          ExpiredObjectDeleteMarker: true,
        },
      ]);
      expect(rules[0]!.Expiration).toEqual({ ExpiredObjectDeleteMarker: true });
    });

    it('warns instead of silently dropping a delete marker that conflicts with Days', async () => {
      await putRules([
        {
          Id: 'conflict',
          Status: 'Enabled',
          Prefix: 'c/',
          ExpirationInDays: 30,
          ExpiredObjectDeleteMarker: true,
        },
      ]);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('ExpiredObjectDeleteMarker'));
    });

    it('coerces stringly-typed CFn scalars from hand-written templates', async () => {
      // CFn is stringly typed and these legacy branches exist precisely for
      // hand-written / imported templates, where `"365"` / `"true"` show up.
      const rules = await putRules([
        {
          Id: 'stringly',
          Status: 'Enabled',
          Prefix: 's/',
          NoncurrentVersionExpirationInDays: '365',
        },
        {
          Id: 'stringly-marker',
          Status: 'Enabled',
          Prefix: 'sm/',
          ExpiredObjectDeleteMarker: 'true',
        },
      ]);
      expect(rules[0]!.NoncurrentVersionExpiration).toEqual({ NoncurrentDays: 365 });
      expect(rules[1]!.Expiration).toEqual({ ExpiredObjectDeleteMarker: true });
    });

    it('combines rule-level tags with a size constraint under And', async () => {
      // A real synth emits tags AND ObjectSizeGreaterThan at the rule level on
      // one rule; that hits the multi-component `And` branch.
      const rules = await putRules([
        {
          Id: 'tags-and-size',
          Status: 'Enabled',
          TagFilters: [{ Key: 'env', Value: 'prod' }],
          ObjectSizeGreaterThan: 1024,
          ExpirationInDays: 30,
        },
      ]);
      expect(rules[0]!.Filter.And).toMatchObject({
        Tags: [{ Key: 'env', Value: 'prod' }],
        ObjectSizeGreaterThan: 1024,
      });
    });

    it('applies the delete marker alongside an ExpirationDate-free rule', async () => {
      const rules = await putRules([
        {
          Id: 'date-marker',
          Status: 'Enabled',
          Prefix: 'dm/',
          ExpirationDate: '2030-01-01T00:00:00Z',
          ExpiredObjectDeleteMarker: true,
        },
      ]);
      // Date is set, so the marker must NOT be smuggled in beside it.
      expect(rules[0]!.Expiration.Date).toBeInstanceOf(Date);
      expect(rules[0]!.Expiration.ExpiredObjectDeleteMarker).toBeUndefined();
    });
  });

  describe('no regression on the shapes that already worked', () => {
    it('keeps a prefix-only config in V1 form (bare top-level Prefix, no Filter)', async () => {
      const rules = await putRules([
        { Id: 'p', Status: 'Enabled', Prefix: 'logs/', ExpirationInDays: 7 },
      ]);
      expect(rules[0]!.Prefix).toBe('logs/');
      expect(rules[0]!.Filter).toBeUndefined();
    });

    it('still reads TagFilters from an explicit Filter (SDK-shaped / imported input)', async () => {
      const rules = await putRules([
        {
          Id: 'f',
          Status: 'Enabled',
          Filter: { TagFilters: [{ Key: 'a', Value: 'b' }] },
          ExpirationInDays: 5,
        },
      ]);
      expect(rules[0]!.Filter).toEqual({ Tag: { Key: 'a', Value: 'b' } });
    });
  });
});
