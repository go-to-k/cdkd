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
    NoncurrentVersionTransition: { StorageClass: 'GLACIER', NoncurrentDays: 30 },
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
      // Pre-fix `gatherScope` read ONLY `Filter.TagFilters`, so this rule had
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

    it('concatenates the plural and singular forms when a rule carries both', async () => {
      const rules = await putRules([
        {
          Id: 'mixed',
          Status: 'Enabled',
          Prefix: 'm/',
          Transitions: [{ StorageClass: 'STANDARD_IA', TransitionInDays: 30 }],
          Transition: { StorageClass: 'GLACIER', TransitionInDays: 90 },
        },
      ]);
      expect(rules[0]!.Transitions).toHaveLength(2);
      expect(rules[0]!.Transitions.map((t: { StorageClass: string }) => t.StorageClass)).toEqual([
        'STANDARD_IA',
        'GLACIER',
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
