import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  PutBucketAnalyticsConfigurationCommand,
  PutBucketIntelligentTieringConfigurationCommand,
  PutBucketMetricsConfigurationCommand,
} from '@aws-sdk/client-s3';

/**
 * Issue #1573: the analytics / intelligent-tiering / metrics filter builders
 * chose their wire shape from the COUNT OF PREDICATE KINDS (or, for metrics,
 * from a Prefix-first else-if chain), not from the number of predicates:
 *
 *  - analytics / intelligent-tiering: `TagFilters: [A, B]` with no `Prefix`
 *    counted as ONE kind, fell into the single-`Tag` arm, and sent
 *    `Filter = { Tag: A }` — every tag after the first SILENTLY DROPPED;
 *  - metrics: `Prefix` was tested first, so `Prefix` + `TagFilters` (or
 *    `Prefix` + `AccessPointArn`) sent `Filter = { Prefix }` alone — the
 *    other predicate(s) silently dropped.
 *
 * All three now count PREDICATES: >1 routes through the `And` operator. The
 * newly-reachable shapes were live-probed on 2026-08-11 and are ACCEPTED with
 * faithful readback: And{Tags[2]} on analytics + intelligent-tiering,
 * And{Prefix,Tags[2]} and And{Prefix,AccessPointArn} on metrics.
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
const BUCKET = 'filter-predicate-bucket';
const TAG_A = { Key: 'team', Value: 'alpha' };
const TAG_B = { Key: 'env', Value: 'dev' };
const AP_ARN = 'arn:aws:s3:us-east-1:123456789012:accesspoint/probe';

let provider: S3BucketProvider;

beforeEach(() => {
  vi.clearAllMocks();
  childLogger.child.mockReturnValue(childLogger);
  provider = new S3BucketProvider();
  mockSend.mockResolvedValue({});
});

function sentCommand<T>(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  commandType: new (...args: any[]) => T
): T | undefined {
  return mockSend.mock.calls.map((c) => c[0]).find((c) => c instanceof commandType) as T | undefined;
}

async function createWith(extra: Record<string, unknown>): Promise<void> {
  await provider.create('B', RESOURCE_TYPE, { BucketName: BUCKET, ...extra });
}

function analyticsFilter(): Record<string, unknown> | undefined {
  return sentCommand(PutBucketAnalyticsConfigurationCommand)?.input.AnalyticsConfiguration
    ?.Filter as Record<string, unknown> | undefined;
}

function itFilter(): Record<string, unknown> | undefined {
  return sentCommand(PutBucketIntelligentTieringConfigurationCommand)?.input
    .IntelligentTieringConfiguration?.Filter as Record<string, unknown> | undefined;
}

function metricsFilter(): Record<string, unknown> | undefined {
  return sentCommand(PutBucketMetricsConfigurationCommand)?.input.MetricsConfiguration?.Filter as
    | Record<string, unknown>
    | undefined;
}

const analyticsProps = (config: Record<string, unknown>) => ({
  AnalyticsConfigurations: [{ Id: 'probe', StorageClassAnalysis: {}, ...config }],
});
const itProps = (config: Record<string, unknown>) => ({
  IntelligentTieringConfigurations: [
    { Id: 'probe', Status: 'Enabled', Tierings: [{ AccessTier: 'ARCHIVE_ACCESS', Days: 90 }], ...config },
  ],
});
const metricsProps = (config: Record<string, unknown>) => ({
  MetricsConfigurations: [{ Id: 'probe', ...config }],
});

describe('analytics: multi-tag filters go through And (the #1573 drop)', () => {
  it('2 tags with no Prefix send And.Tags carrying BOTH — not the single-Tag shape', async () => {
    await createWith(analyticsProps({ TagFilters: [TAG_A, TAG_B] }));
    const filter = analyticsFilter();
    // The regression's exact shape: `{ Tag: TAG_A }`, TAG_B gone.
    expect(filter?.['Tag']).toBeUndefined();
    expect((filter?.['And'] as Record<string, unknown>)?.['Tags']).toEqual([TAG_A, TAG_B]);
  });

  it('1 tag with no Prefix keeps the single-Tag shape', async () => {
    await createWith(analyticsProps({ TagFilters: [TAG_A] }));
    expect(analyticsFilter()).toEqual({ Tag: TAG_A });
  });

  it('Prefix + 1 tag keeps the And shape it already had', async () => {
    await createWith(analyticsProps({ Prefix: 'logs/', TagFilters: [TAG_A] }));
    expect(analyticsFilter()).toEqual({ And: { Prefix: 'logs/', Tags: [TAG_A] } });
  });

  it('Prefix alone keeps the single-Prefix shape', async () => {
    await createWith(analyticsProps({ Prefix: 'logs/' }));
    expect(analyticsFilter()).toEqual({ Prefix: 'logs/' });
  });
});

describe('intelligent-tiering: same predicate-count rule', () => {
  it('2 tags with no Prefix send And.Tags carrying BOTH — not the single-Tag shape', async () => {
    await createWith(itProps({ TagFilters: [TAG_A, TAG_B] }));
    const filter = itFilter();
    expect(filter?.['Tag']).toBeUndefined();
    expect((filter?.['And'] as Record<string, unknown>)?.['Tags']).toEqual([TAG_A, TAG_B]);
  });

  it('1 tag with no Prefix keeps the single-Tag shape', async () => {
    await createWith(itProps({ TagFilters: [TAG_A] }));
    expect(itFilter()).toEqual({ Tag: TAG_A });
  });
});

describe('metrics: Prefix no longer shadows the other predicates (the #1573 metrics arm)', () => {
  it('Prefix + 2 tags send And carrying BOTH — not the bare-Prefix shape', async () => {
    await createWith(metricsProps({ Prefix: 'logs/', TagFilters: [TAG_A, TAG_B] }));
    const filter = metricsFilter();
    // The regression's exact shape: `{ Prefix }` alone, every tag gone.
    expect(filter?.['Tag']).toBeUndefined();
    expect(filter?.['And']).toBeDefined();
    const and = filter?.['And'] as Record<string, unknown>;
    expect(and['Prefix']).toBe('logs/');
    expect(and['Tags']).toEqual([TAG_A, TAG_B]);
  });

  it('Prefix + AccessPointArn send And carrying both — not the bare-Prefix shape', async () => {
    await createWith(metricsProps({ Prefix: 'logs/', AccessPointArn: AP_ARN }));
    const and = metricsFilter()?.['And'] as Record<string, unknown> | undefined;
    expect(and?.['Prefix']).toBe('logs/');
    expect(and?.['AccessPointArn']).toBe(AP_ARN);
    // Tags carries no key at all rather than an empty array.
    expect(and?.['Tags']).toBeUndefined();
  });

  it('2 tags alone still go through And (the pre-existing correct path)', async () => {
    await createWith(metricsProps({ TagFilters: [TAG_A, TAG_B] }));
    expect((metricsFilter()?.['And'] as Record<string, unknown>)?.['Tags']).toEqual([TAG_A, TAG_B]);
  });

  it('each single predicate keeps its dedicated shape', async () => {
    await createWith(metricsProps({ Prefix: 'logs/' }));
    expect(metricsFilter()).toEqual({ Prefix: 'logs/' });

    vi.clearAllMocks();
    mockSend.mockResolvedValue({});
    await createWith(metricsProps({ TagFilters: [TAG_A] }));
    expect(metricsFilter()).toEqual({ Tag: TAG_A });

    vi.clearAllMocks();
    mockSend.mockResolvedValue({});
    await createWith(metricsProps({ AccessPointArn: AP_ARN }));
    expect(metricsFilter()).toEqual({ AccessPointArn: AP_ARN });
  });

  it('an EMPTY TagFilters array is absent, not an empty And', async () => {
    // The old chain sent `And: { Tags: [] }` for a bare `TagFilters: []`;
    // an empty array is no predicate at all.
    await createWith(metricsProps({ TagFilters: [] }));
    expect(metricsFilter()).toBeUndefined();
  });
});
