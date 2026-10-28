/**
 * go-to-k/cdkd#5487: the Kinesis stream `update()` marks each key just before
 * the call that changes it (`UpdateContext.markUnsettled`), reads the live
 * values the engine's convergence step compares (`readUnsettled`: the OPEN
 * shard count), re-sends unsettled Tags without removing tags it never
 * recorded, and reports a key still changing while the stream reads UPDATING.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const mockSend = vi.hoisted(() => vi.fn());

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
  const child = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() };
  child.child.mockReturnValue(child);
  return { getLogger: () => ({ ...child, child: () => child }) };
});

import { KinesisStreamProvider } from '../../../../src/provisioning/providers/kinesis-provider.js';

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
            EnhancedMonitoring: [],
          },
        };
      case 'DescribeStreamSummaryCommand':
        return {
          StreamDescriptionSummary: {
            StreamARN: ARN,
            StreamStatus: live.status ?? 'ACTIVE',
            OpenShardCount: live.shards ?? 1,
          },
        };
      case 'ListShardsCommand':
        return { Shards: shards };
      case 'ListTagsForStreamCommand':
        return { Tags: [], HasMoreTags: false };
      default:
        return {};
    }
  });
}

const sent = (name: string) =>
  mockSend.mock.calls.map((c) => c[0]).filter((c) => c.constructor.name === name);

describe('Kinesis stream unsettled properties (go-to-k/cdkd#5487)', () => {
  let provider: KinesisStreamProvider;
  beforeEach(() => {
    vi.clearAllMocks();
    provider = new KinesisStreamProvider();
  });

  it('marks each key before the call that changes it', async () => {
    serve({});
    const marks: string[] = [];
    const sentAtMark: number[] = [];
    const writes = () =>
      mockSend.mock.calls.filter((c) => !/^(Describe|List)/.test(c[0].constructor.name)).length;
    await provider.update(
      'S',
      's',
      TYPE,
      { ShardCount: 2, RetentionPeriodHours: 48, StreamEncryption: { EncryptionType: 'KMS', KeyId: 'k' } },
      { ShardCount: 1 },
      {
        markUnsettled: (k: string) => {
          marks.push(k);
          sentAtMark.push(writes());
        },
      }
    );
    expect(marks).toEqual(['ShardCount', 'RetentionPeriodHours', 'StreamEncryption']);
    // Each mark precedes its own call: 0 writes before the first, 1 before the second...
    expect(sentAtMark).toEqual([0, 1, 2]);
  });

  it('marks nothing for an update that sends nothing', async () => {
    serve({});
    const marks: string[] = [];
    await provider.update('S', 's', TYPE, { ShardCount: 1 }, { ShardCount: 1 }, {
      markUnsettled: (k: string) => marks.push(k),
    });
    expect(marks).toEqual([]);
    expect(sent('UpdateShardCountCommand')).toHaveLength(0);
  });

  it('readUnsettled: readCurrentState with the OPEN shard count', async () => {
    serve({ shards: 1, closed: 2, retention: 48 });
    const live = (await provider.readUnsettled('s', 'S', TYPE, new Set(['ShardCount']))) as Record<
      string,
      unknown
    >;
    expect(live['ShardCount']).toBe(1);
    expect(live['RetentionPeriodHours']).toBe(48);
    const withoutShards = (await provider.readUnsettled('s', 'S', TYPE, new Set(['Tags']))) as Record<
      string,
      unknown
    >;
    // readCurrentState's own count (open + closed) when ShardCount is not asked for.
    expect(withoutShards['ShardCount']).toBe(3);
  });

  it('an unsettled mode switch compares the live open shard count, not the record', async () => {
    serve({ shards: 2 });
    await provider.update('S', 's', TYPE, { ShardCount: 1 }, { ShardCount: 1 }, {
      unsettledProperties: new Set(['StreamModeDetails']),
    });
    expect(sent('UpdateShardCountCommand').map((c) => c.input.TargetShardCount)).toEqual([1]);
    vi.clearAllMocks();
    serve({ shards: 2 });
    await provider.update('S', 's', TYPE, { ShardCount: 1 }, { ShardCount: 1 });
    expect(sent('UpdateShardCountCommand')).toHaveLength(0);
  });

  it('unsettled Tags re-send every template tag and remove only recorded tags the template dropped', async () => {
    serve({});
    const marks: string[] = [];
    await provider.update(
      'S',
      's',
      TYPE,
      { Tags: [{ Key: 'a', Value: '1' }] },
      { Tags: [{ Key: 'a', Value: '1' }, { Key: 'gone', Value: 'x' }] },
      { unsettledProperties: new Set(['Tags']), markUnsettled: (k: string) => marks.push(k) }
    );
    expect(sent('AddTagsToStreamCommand').map((c) => c.input.Tags)).toEqual([{ a: '1' }]);
    expect(sent('RemoveTagsFromStreamCommand').map((c) => c.input.TagKeys)).toEqual([['gone']]);
    expect(marks).toContain('Tags');
  });

  it('settled Tags equal in the bags send nothing and mark nothing (the mark follows the plan)', async () => {
    serve({});
    const marks: string[] = [];
    await provider.update(
      'S',
      's',
      TYPE,
      { Tags: [{ Key: 'a', Value: '1' }] },
      { Tags: [{ Value: '1', Key: 'a' }] },
      { markUnsettled: (k: string) => marks.push(k) }
    );
    expect(sent('AddTagsToStreamCommand')).toHaveLength(0);
    expect(marks).toEqual([]);
  });

  it('unsettledInTransition: every key but Tags while UPDATING, none once ACTIVE, all on a failed read', async () => {
    const names = new Set(['ShardCount', 'Tags']);
    serve({ status: 'UPDATING' });
    expect([...(await provider.unsettledInTransition('s', 'S', TYPE, names))]).toEqual(['ShardCount']);
    serve({ status: 'ACTIVE' });
    expect([...(await provider.unsettledInTransition('s', 'S', TYPE, names))]).toEqual([]);
    mockSend.mockRejectedValue(new Error('throttled'));
    expect([...(await provider.unsettledInTransition('s', 'S', TYPE, names))]).toEqual([
      'ShardCount',
      'Tags',
    ]);
  });
});
