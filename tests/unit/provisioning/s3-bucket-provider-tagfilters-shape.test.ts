import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  PutBucketAnalyticsConfigurationCommand,
  PutBucketIntelligentTieringConfigurationCommand,
  PutBucketLifecycleConfigurationCommand,
  PutBucketMetricsConfigurationCommand,
} from '@aws-sdk/client-s3';

/**
 * Issue #1579: a present-but-non-array `TagFilters` used to fall through each
 * filter builder's blind cast, read as ZERO predicates via `?.length`, and the
 * `Filter` block was silently omitted — the configuration deployed with a
 * WIDER scope (all objects) than the template declared. On the lifecycle path
 * the same shape read as "no tags" and an expiration rule applied to the
 * WHOLE bucket (the #1388 hazard, from a malformed container this time).
 *
 * The guard follows the #1556 split: REFUSE on a template-path create, WARN
 * and skip on the state-replay paths (`replayingState` create, the keyed
 * update sync) where the desired bag can be a historical cdkd state record
 * with no template-side remedy. Skipping means "leave the live configuration
 * alone" — applying the item without its tag predicate would be the very
 * widened-scope misbehavior being refused.
 */

const { mockSend, childLogger } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  childLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
  },
}));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    s3: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
  }),
}));

vi.mock('../../../src/utils/logger.js', () => {
  childLogger.child.mockReturnValue(childLogger);
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

const RESOURCE_TYPE = 'AWS::S3::Bucket';
const BUCKET = 'tagfilters-shape-bucket';
const TAG_A = { Key: 'team', Value: 'alpha' };
// The headline malformed shape: a single tag OBJECT where the array belongs.
// Truthy, non-array, `.length` is `undefined` — reads as zero predicates.
const MALFORMED_OBJECT = { Key: 'team', Value: 'alpha' };

const METRICS_PATH = 'AWS::S3::Bucket MetricsConfigurations[].TagFilters';
const ANALYTICS_PATH = 'AWS::S3::Bucket AnalyticsConfigurations[].TagFilters';
const IT_PATH = 'AWS::S3::Bucket IntelligentTieringConfigurations[].TagFilters';
const LIFECYCLE_PATH = 'AWS::S3::Bucket LifecycleConfiguration.Rules[].TagFilters';

let provider: S3BucketProvider;

beforeEach(() => {
  vi.clearAllMocks();
  childLogger.child.mockReturnValue(childLogger);
  provider = new S3BucketProvider();
  mockSend.mockResolvedValue({});
});

function sentCommands<T>(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  commandType: new (...args: any[]) => T
): T[] {
  return mockSend.mock.calls.map((c) => c[0]).filter((c) => c instanceof commandType) as T[];
}

const metricsProps = (config: Record<string, unknown>) => ({
  BucketName: BUCKET,
  MetricsConfigurations: [{ Id: 'probe', ...config }],
});
const analyticsProps = (config: Record<string, unknown>) => ({
  BucketName: BUCKET,
  AnalyticsConfigurations: [{ Id: 'probe', StorageClassAnalysis: {}, ...config }],
});
const itProps = (config: Record<string, unknown>) => ({
  BucketName: BUCKET,
  IntelligentTieringConfigurations: [
    {
      Id: 'probe',
      Status: 'Enabled',
      Tierings: [{ AccessTier: 'ARCHIVE_ACCESS', Days: 90 }],
      ...config,
    },
  ],
});
const lifecycleProps = (rule: Record<string, unknown>) => ({
  BucketName: BUCKET,
  LifecycleConfiguration: { Rules: [{ Id: 'probe', Status: 'Enabled', ...rule }] },
});

describe('create path: a non-array TagFilters is REFUSED, not silently omitted', () => {
  // Each value is truthy-or-falsy non-array; the object is the shape that
  // used to read as zero predicates, the string is worse (its `.length` is
  // the character count and could flow into the Tag/And arms as garbage).
  const malformed: Array<[string, unknown]> = [
    ['a single tag object', MALFORMED_OBJECT],
    ['a string (an unresolved intrinsic collapsed to text)', 'team=alpha'],
    ['a number', 42],
  ];

  for (const [label, value] of malformed) {
    it(`metrics: refuses ${label}`, async () => {
      await expect(
        provider.create('B', RESOURCE_TYPE, metricsProps({ TagFilters: value }))
      ).rejects.toThrow(`${METRICS_PATH} must be an array`);
      expect(sentCommands(PutBucketMetricsConfigurationCommand)).toHaveLength(0);
    });

    it(`analytics: refuses ${label}`, async () => {
      await expect(
        provider.create('B', RESOURCE_TYPE, analyticsProps({ TagFilters: value }))
      ).rejects.toThrow(`${ANALYTICS_PATH} must be an array`);
      expect(sentCommands(PutBucketAnalyticsConfigurationCommand)).toHaveLength(0);
    });

    it(`intelligent-tiering: refuses ${label}`, async () => {
      await expect(
        provider.create('B', RESOURCE_TYPE, itProps({ TagFilters: value }))
      ).rejects.toThrow(`${IT_PATH} must be an array`);
      expect(sentCommands(PutBucketIntelligentTieringConfigurationCommand)).toHaveLength(0);
    });
  }

  it('lifecycle: refuses a malformed rule-level TagFilters and sends NO lifecycle Put', async () => {
    await expect(
      provider.create(
        'B',
        RESOURCE_TYPE,
        lifecycleProps({ ExpirationInDays: 30, TagFilters: MALFORMED_OBJECT })
      )
    ).rejects.toThrow(`${LIFECYCLE_PATH} must be an array`);
    expect(sentCommands(PutBucketLifecycleConfigurationCommand)).toHaveLength(0);
  });

  it('lifecycle: refuses a malformed Filter.TagFilters too (both read locations)', async () => {
    await expect(
      provider.create(
        'B',
        RESOURCE_TYPE,
        lifecycleProps({ ExpirationInDays: 30, Filter: { TagFilters: 'team=alpha' } })
      )
    ).rejects.toThrow(`${LIFECYCLE_PATH} must be an array`);
    expect(sentCommands(PutBucketLifecycleConfigurationCommand)).toHaveLength(0);
  });

  it('an ABSENT TagFilters still applies the configuration (no false refusal)', async () => {
    await provider.create('B', RESOURCE_TYPE, metricsProps({ Prefix: 'logs/' }));
    const sent = sentCommands(PutBucketMetricsConfigurationCommand);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.input.MetricsConfiguration?.Filter).toEqual({ Prefix: 'logs/' });
  });

  it('an explicit NULL TagFilters means "no entries" per the list-block contract', async () => {
    await provider.create('B', RESOURCE_TYPE, metricsProps({ Prefix: 'logs/', TagFilters: null }));
    const sent = sentCommands(PutBucketMetricsConfigurationCommand);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.input.MetricsConfiguration?.Filter).toEqual({ Prefix: 'logs/' });
  });

  it('lifecycle: Prefix + an explicit NULL TagFilters applies without crashing (PR #1580 review)', async () => {
    // Before the review fix the strict `=== undefined` compares sent `null`
    // into `.length` — a raw TypeError instead of either a refusal or a Put.
    await provider.create(
      'B',
      RESOURCE_TYPE,
      lifecycleProps({ ExpirationInDays: 30, Prefix: 'logs/', TagFilters: null })
    );
    const sent = sentCommands(PutBucketLifecycleConfigurationCommand);
    expect(sent).toHaveLength(1);
    const rule = (sent[0]!.input.LifecycleConfiguration?.Rules ?? [])[0] as unknown as Record<
      string,
      unknown
    >;
    // Single-Prefix rule with no tag scope: the V1 top-level Prefix form.
    expect(rule['Prefix']).toBe('logs/');
    expect(rule['Filter']).toBeUndefined();
  });
});

describe('replay create (`replayingState`): warn and skip instead of stranding the rollback', () => {
  it('metrics: warns, skips the malformed item, still applies the valid sibling', async () => {
    await provider.create(
      'B',
      RESOURCE_TYPE,
      {
        BucketName: BUCKET,
        MetricsConfigurations: [
          { Id: 'bad', TagFilters: MALFORMED_OBJECT },
          { Id: 'good', TagFilters: [TAG_A] },
        ],
      },
      { replayingState: true }
    );
    expect(childLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining(`${METRICS_PATH} must be an array`)
    );
    const sent = sentCommands(PutBucketMetricsConfigurationCommand);
    expect(sent.map((c) => c.input.Id)).toEqual(['good']);
    expect(sent[0]!.input.MetricsConfiguration?.Filter).toEqual({ Tag: TAG_A });
  });

  it('lifecycle: warns and leaves the WHOLE live configuration alone (the Put replaces every rule)', async () => {
    await provider.create(
      'B',
      RESOURCE_TYPE,
      lifecycleProps({ ExpirationInDays: 30, TagFilters: MALFORMED_OBJECT }),
      { replayingState: true }
    );
    expect(childLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining(`${LIFECYCLE_PATH} must be an array`)
    );
    expect(sentCommands(PutBucketLifecycleConfigurationCommand)).toHaveLength(0);
  });
});

describe('update path: warn and skip (the desired bag can be a historical state record)', () => {
  async function update(properties: Record<string, unknown>): Promise<void> {
    await provider.update('B', BUCKET, RESOURCE_TYPE, properties, { BucketName: BUCKET });
  }

  it('metrics: warns and does NOT send the Put', async () => {
    await update(metricsProps({ TagFilters: MALFORMED_OBJECT }));
    expect(childLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining(`${METRICS_PATH} must be an array`)
    );
    expect(sentCommands(PutBucketMetricsConfigurationCommand)).toHaveLength(0);
  });

  it('analytics: warns and does NOT send the Put', async () => {
    await update(analyticsProps({ TagFilters: MALFORMED_OBJECT }));
    expect(childLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining(`${ANALYTICS_PATH} must be an array`)
    );
    expect(sentCommands(PutBucketAnalyticsConfigurationCommand)).toHaveLength(0);
  });

  it('intelligent-tiering: warns and does NOT send the Put', async () => {
    await update(itProps({ TagFilters: MALFORMED_OBJECT }));
    expect(childLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining(`${IT_PATH} must be an array`)
    );
    expect(sentCommands(PutBucketIntelligentTieringConfigurationCommand)).toHaveLength(0);
  });

  it('lifecycle: warns and does NOT send the Put', async () => {
    await update(lifecycleProps({ ExpirationInDays: 30, TagFilters: MALFORMED_OBJECT }));
    expect(childLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining(`${LIFECYCLE_PATH} must be an array`)
    );
    expect(sentCommands(PutBucketLifecycleConfigurationCommand)).toHaveLength(0);
  });

  it('a VALID TagFilters array still applies on the update path (guard is shape-only)', async () => {
    await update(metricsProps({ TagFilters: [TAG_A] }));
    const sent = sentCommands(PutBucketMetricsConfigurationCommand);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.input.MetricsConfiguration?.Filter).toEqual({ Tag: TAG_A });
    expect(childLogger.warn).not.toHaveBeenCalled();
  });
});
