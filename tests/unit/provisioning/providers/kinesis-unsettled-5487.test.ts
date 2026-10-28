/**
 * go-to-k/cdkd#5487: the Kinesis stream `update()` marks each key just before
 * the call that changes it (`UpdateContext.markUnsettled`), converges a key an
 * earlier failed update left unsettled against what the stream holds now
 * (Kinesis refuses same-value calls, so only what AWS lacks is sent), and
 * reports a key still changing while the stream reads UPDATING.
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

  it('an unsettled ShardCount equal in the bags is sent when the stream holds another count', async () => {
    serve({ shards: 2 });
    await provider.update('S', 's', TYPE, { ShardCount: 1 }, { ShardCount: 1 }, {
      unsettledProperties: new Set(['ShardCount']),
    });
    expect(sent('UpdateShardCountCommand').map((c) => c.input.TargetShardCount)).toEqual([1]);
  });

  it('an unsettled ShardCount the stream already holds sends nothing (a same-count call is refused)', async () => {
    // Two closed shards beside the open one: the OPEN count is what is compared.
    serve({ shards: 1, closed: 2 });
    await provider.update('S', 's', TYPE, { ShardCount: 1 }, { ShardCount: 1 }, {
      unsettledProperties: new Set(['ShardCount']),
    });
    expect(sent('UpdateShardCountCommand')).toHaveLength(0);
  });

  it('without unsettled keys the recorded bag decides and no live read is taken', async () => {
    serve({ shards: 2 });
    await provider.update('S', 's', TYPE, { ShardCount: 1 }, { ShardCount: 1 });
    expect(sent('UpdateShardCountCommand')).toHaveLength(0);
    expect(sent('DescribeStreamCommand')).toHaveLength(1); // the result envelope only
  });

  it('an unsettled encryption removal the stream still holds is stopped', async () => {
    serve({ encryption: { EncryptionType: 'KMS', KeyId: 'k' } });
    await provider.update('S', 's', TYPE, {}, {}, {
      unsettledProperties: new Set(['StreamEncryption']),
    });
    expect(sent('StopStreamEncryptionCommand')).toHaveLength(1);
    expect(sent('StartStreamEncryptionCommand')).toHaveLength(0);
  });

  it('an unsettled retention is compared with the live period', async () => {
    serve({ retention: 48 });
    await provider.update('S', 's', TYPE, {}, {}, {
      unsettledProperties: new Set(['RetentionPeriodHours']),
    });
    expect(sent('DecreaseStreamRetentionPeriodCommand').map((c) => c.input.RetentionPeriodHours)).toEqual([24]);
  });

  it('refuses before any write when the stream cannot be read to converge', async () => {
    mockSend.mockImplementation(async (cmd: { constructor: { name: string } }) => {
      if (cmd.constructor.name === 'DescribeStreamCommand') throw new Error('throttled');
      return {};
    });
    await expect(
      provider.update('S', 's', TYPE, { ShardCount: 1 }, { ShardCount: 1 }, {
        unsettledProperties: new Set(['ShardCount']),
      })
    ).rejects.toThrow();
    expect(sent('UpdateShardCountCommand')).toHaveLength(0);
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
