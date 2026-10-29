/**
 * go-to-k/cdkd#5498 — see the describe block.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const { mockSend, warnSpy } = vi.hoisted(() => ({ mockSend: vi.fn(), warnSpy: vi.fn() }));

vi.mock('@aws-sdk/client-kinesis', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-kinesis')>();
  return {
    ...actual,
    KinesisClient: vi.fn().mockImplementation(() => ({
      send: mockSend,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
  };
});
vi.mock('../../../../src/utils/logger.js', () => {
  const child = { debug: vi.fn(), info: vi.fn(), warn: warnSpy, error: vi.fn(), child: vi.fn() };
  child.child.mockReturnValue(child);
  return { getLogger: () => ({ ...child, child: () => child }) };
});

import { KinesisStreamProvider } from '../../../../src/provisioning/providers/kinesis-provider.js';
import { settleUnsettledPrevious } from '../../../../src/deployment/unsettled-convergence.js';

const TYPE = 'AWS::Kinesis::Stream';
const ARN = 'arn:aws:kinesis:us-east-1:123456789012:stream/s';

/** A stream whose live state is `live`; every call is recorded by name. */
function serve(live: {
  status?: string;
  shards?: number;
  /** Closed shards a reshard left, which DescribeStream lists beside the open ones. */
  closed?: number;
  retention?: number;
  encryption?: { EncryptionType: string; KeyId?: string };
  /** Live enhanced-monitoring metrics. */
  metrics?: string[];
  /** What EnableEnhancedMonitoring answers as CurrentShardLevelMetrics, or a throw. */
  enableCurrent?: string[] | 'throw';
  failTag?: boolean;
  liveTags?: string[];
}): void {
  mockSend.mockImplementation(async (cmd: { constructor: { name: string } }) => {
    const shards = [
      ...Array.from({ length: live.shards ?? 1 }, (_v, i) => ({
        ShardId: `shardId-${i}`,
        SequenceNumberRange: { StartingSequenceNumber: '1' },
      })),
      ...Array.from({ length: live.closed ?? 0 }, (_v, i) => ({
        ShardId: `shardId-closed-${i}`,
        SequenceNumberRange: { StartingSequenceNumber: '1', EndingSequenceNumber: '2' },
      })),
    ];
    switch (cmd.constructor.name) {
      case 'DescribeStreamCommand':
        return {
          StreamDescription: {
            StreamName: 's',
            StreamARN: ARN,
            StreamStatus: live.status ?? 'ACTIVE',
            StreamModeDetails: { StreamMode: 'PROVISIONED' },
            Shards: shards,
            RetentionPeriodHours: live.retention ?? 24,
            EncryptionType: live.encryption?.EncryptionType ?? 'NONE',
            ...(live.encryption?.KeyId !== undefined && { KeyId: live.encryption.KeyId }),
            EnhancedMonitoring: [{ ShardLevelMetrics: live.metrics ?? [] }],
          },
        };
      case 'DescribeStreamSummaryCommand':
        return {
          StreamDescriptionSummary: {
            StreamARN: ARN,
            StreamStatus: live.status ?? 'ACTIVE',
            OpenShardCount: live.shards ?? 1,
            EnhancedMonitoring: [{ ShardLevelMetrics: live.metrics ?? [] }],
          },
        };
      case 'ListShardsCommand':
        return { Shards: shards };
      case 'ListTagsForStreamCommand':
        return {
          Tags: (live.liveTags ?? []).map((k) => ({ Key: k, Value: 'v' })),
          HasMoreTags: false,
        };
      case 'EnableEnhancedMonitoringCommand':
        if (live.enableCurrent === 'throw') throw new Error('LimitExceeded');
        return { CurrentShardLevelMetrics: live.enableCurrent ?? [] };
      case 'AddTagsToStreamCommand':
        if (live.failTag === true) throw new Error('AccessDenied');
        return {};
      default:
        return {};
    }
  });
}

const sent = (name: string) =>
  mockSend.mock.calls.map((c) => c[0]).filter((c) => c.constructor.name === name);

/**
 * go-to-k/cdkd#5498: the metrics and tag keys a failed update's ACCEPTED calls
 * added are recorded (`UpdateContext.markAttempted`), and the next deploy's
 * convergence removes those the template no longer names — only those.
 */
describe('Kinesis stream attempted items (go-to-k/cdkd#5498)', () => {
  let provider: KinesisStreamProvider;
  beforeEach(() => {
    vi.clearAllMocks();
    provider = new KinesisStreamProvider();
  });
  const bag = (metrics: string[], tags: string[] = []): Record<string, unknown> => ({
    Name: 's',
    ShardCount: 1,
    DesiredShardLevelMetrics: metrics,
    ...(tags.length > 0 && { Tags: tags.map((k) => ({ Key: k, Value: 'v' })) }),
  });
  const sink = () => {
    const items: Array<[string, string[]]> = [];
    return { items, markAttempted: (p: string, n: readonly string[]) => items.push([p, [...n]]) };
  };

  it('records the enabled metrics the response did not report as already current', async () => {
    serve({ metrics: ['IncomingBytes'], enableCurrent: ['IncomingBytes', 'OutgoingBytes'] });
    const s = sink();
    await provider.update(
      'S',
      's',
      TYPE,
      bag(['IncomingBytes', 'IncomingRecords', 'OutgoingBytes']),
      bag(['IncomingBytes']),
      { markUnsettled: () => undefined, markAttempted: s.markAttempted }
    );
    expect(s.items).toEqual([['DesiredShardLevelMetrics', ['IncomingRecords']]]);
  });

  it('records no metric when EnableEnhancedMonitoring throws', async () => {
    serve({ enableCurrent: 'throw' });
    const s = sink();
    await expect(
      provider.update('S', 's', TYPE, bag(['IncomingBytes']), bag([]), {
        markUnsettled: () => undefined,
        markAttempted: s.markAttempted,
      })
    ).rejects.toThrow();
    expect(s.items).toEqual([]);
  });

  it('records the tag keys an accepted AddTagsToStream added that the record lacked, none on a throw', async () => {
    serve({});
    const s = sink();
    await provider.update('S', 's', TYPE, bag([], ['a', 'b']), bag([], ['a']), {
      markUnsettled: () => undefined,
      markAttempted: s.markAttempted,
    });
    expect(s.items).toEqual([['Tags', ['b']]]);
    vi.clearAllMocks();
    serve({ failTag: true });
    const f = sink();
    await expect(
      provider.update('S', 's', TYPE, bag([], ['a', 'b']), bag([], ['a']), {
        markUnsettled: () => undefined,
        markAttempted: f.markAttempted,
      })
    ).rejects.toThrow();
    expect(f.items).toEqual([]);
  });

  const NAMES = new Set(['DesiredShardLevelMetrics']);
  const converge = async (
    recorded: Record<string, unknown>,
    desired: Record<string, unknown>,
    items: ReadonlyMap<string, ReadonlySet<string>>
  ): Promise<void> => {
    const previous = await settleUnsettledPrevious({
      provider,
      logicalId: 'S',
      physicalId: 's',
      resourceType: TYPE,
      recordedProperties: recorded,
      desired,
      names: NAMES,
      previous: recorded,
      attemptedItems: items,
    });
    await provider.update('S', 's', TYPE, desired, previous, {
      unsettledProperties: NAMES,
      unsettledItems: items,
    });
  };
  const disabled = (): string[][] =>
    sent('DisableEnhancedMonitoringCommand').map((c) => c.input.ShardLevelMetrics as string[]);
  const attempted = (...m: string[]) => new Map([['DesiredShardLevelMetrics', new Set(m)]]);

  it('disables a live attempted metric the template dropped, never an out-of-band one', async () => {
    serve({ metrics: ['IncomingBytes', 'IncomingRecords', 'OutgoingBytes'] });
    await converge(bag(['IncomingBytes']), bag(['IncomingBytes']), attempted('IncomingRecords'));
    expect(disabled()).toEqual([['IncomingRecords']]);
  });

  it('without the attempted name the same metric stays enabled (the v14 behaviour)', async () => {
    serve({ metrics: ['IncomingBytes', 'IncomingRecords'] });
    await converge(bag(['IncomingBytes']), bag(['IncomingBytes']), new Map());
    expect(disabled()).toEqual([]);
  });

  it.each(['***', '{{resolve:ssm:p}}', 'incomingrecords', 'NotLive'])(
    'an unusable or non-matching attempted name %s disables nothing',
    async (name) => {
      serve({ metrics: ['IncomingBytes', 'IncomingRecords'] });
      await converge(bag(['IncomingBytes']), bag(['IncomingBytes']), attempted(name));
      expect(disabled()).toEqual([]);
    }
  );

  it('a redacted attempted name never matches, even a live entry spelled the same', async () => {
    serve({ metrics: ['IncomingBytes', '***', '{{resolve:ssm:p}}'] });
    await converge(
      bag(['IncomingBytes']),
      bag(['IncomingBytes']),
      attempted('***', '{{resolve:ssm:p}}')
    );
    expect(disabled()).toEqual([]);
  });

  it('an attempted ALL names nothing (the writer records expanded names only)', async () => {
    serve({ metrics: ['IncomingBytes', 'OutgoingBytes'] });
    await converge(bag([]), bag(['IncomingBytes']), attempted('ALL'));
    expect(disabled()).toEqual([]);
  });

  it('a live literal ALL in the response counts every metric as already on: nothing recorded', async () => {
    serve({ metrics: ['ALL'], enableCurrent: ['ALL'] });
    const s = sink();
    await provider.update('S', 's', TYPE, bag(['IncomingBytes', 'OutgoingBytes']), bag([]), {
      markUnsettled: () => undefined,
      markAttempted: s.markAttempted,
    });
    expect(s.items).toEqual([]);
  });

  it('records no tag key when the recorded tags are malformed', async () => {
    serve({});
    const s = sink();
    await provider.update(
      'S',
      's',
      TYPE,
      bag([], ['a', 'b']),
      { ...bag([]), Tags: 'not-a-list' },
      { markUnsettled: () => undefined, markAttempted: s.markAttempted }
    );
    expect(sent('AddTagsToStreamCommand').length).toBeGreaterThan(0);
    expect(s.items).toEqual([]);
  });

  it('removes a live attempted tag the template dropped, never a live-only one', async () => {
    const TAGS = new Set(['Tags']);
    serve({ liveTags: ['a', 'b', 'ext'] });
    const items = new Map([['Tags', new Set(['b'])]]);
    const previous = await settleUnsettledPrevious({
      provider,
      logicalId: 'S',
      physicalId: 's',
      resourceType: TYPE,
      recordedProperties: bag([], ['a']),
      desired: bag([], ['a']),
      names: TAGS,
      previous: bag([], ['a']),
      attemptedItems: items,
    });
    await provider.update('S', 's', TYPE, bag([], ['a']), previous, {
      unsettledProperties: TAGS,
      unsettledItems: items,
    });
    expect(sent('RemoveTagsFromStreamCommand').flatMap((c) => c.input.TagKeys as string[])).toEqual([
      'b',
    ]);
    // A redacted attempted key never matches a live tag spelled the same.
    vi.clearAllMocks();
    const DYN = 'x-{{resolve:ssm:p}}';
    serve({ liveTags: ['a', DYN, 'x-***'] });
    const redacted = new Map([['Tags', new Set([DYN, 'x-***'])]]);
    const prev2 = await settleUnsettledPrevious({
      provider,
      logicalId: 'S',
      physicalId: 's',
      resourceType: TYPE,
      recordedProperties: bag([], ['a']),
      desired: bag([], ['a']),
      names: TAGS,
      previous: bag([], ['a']),
      attemptedItems: redacted,
    });
    expect(prev2['Tags']).toEqual(bag([], ['a'])['Tags']);
  });
});
