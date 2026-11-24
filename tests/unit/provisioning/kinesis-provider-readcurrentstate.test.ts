import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  DescribeStreamCommand,
  DescribeStreamSummaryCommand,
  ListTagsForStreamCommand,
  ResourceNotFoundException,
} from '@aws-sdk/client-kinesis';

const mockSend = vi.fn();

vi.mock('@aws-sdk/client-kinesis', async () => {
  const actual = await vi.importActual<typeof import('@aws-sdk/client-kinesis')>(
    '@aws-sdk/client-kinesis'
  );
  return {
    ...actual,
    KinesisClient: vi.fn(() => ({
      send: mockSend,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
  };
});

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(function (this: unknown) { return this; }),
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

import { KinesisStreamProvider } from '../../../src/provisioning/providers/kinesis-provider.js';
import { RESOURCE_NOT_FOUND } from '../../../src/types/resource.js';

describe('KinesisStreamProvider.readCurrentState', () => {
  let provider: KinesisStreamProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new KinesisStreamProvider();
  });

  it('returns CFn-shaped properties from DescribeStream (happy path)', async () => {
    mockSend
      .mockResolvedValueOnce({
        StreamDescription: {
          StreamName: 'mystream',
          StreamModeDetails: { StreamMode: 'PROVISIONED' },
          Shards: [{ ShardId: 's-1' }, { ShardId: 's-2' }],
          RetentionPeriodHours: 48,
          EncryptionType: 'KMS',
          KeyId: 'arn:aws:kms:us-east-1:1:key/abc',
        },
      })
      .mockResolvedValueOnce({ StreamDescriptionSummary: {} })
      .mockResolvedValueOnce({ Tags: [] });

    const result = await provider.readCurrentState('mystream', 'L', 'AWS::Kinesis::Stream');

    expect(mockSend.mock.calls[0]?.[0]).toBeInstanceOf(DescribeStreamCommand);
    expect(mockSend.mock.calls[1]?.[0]).toBeInstanceOf(DescribeStreamSummaryCommand);
    expect(mockSend.mock.calls[2]?.[0]).toBeInstanceOf(ListTagsForStreamCommand);
    expect(mockSend).toHaveBeenCalledTimes(3);
    expect(result).toEqual({
      Name: 'mystream',
      StreamModeDetails: { StreamMode: 'PROVISIONED' },
      ShardCount: 2,
      RetentionPeriodHours: 48,
      StreamEncryption: { EncryptionType: 'KMS', KeyId: 'arn:aws:kms:us-east-1:1:key/abc' },
      DesiredShardLevelMetrics: [],
      Tags: [],
    });
  });

  // go-to-k/cdkd#6933: after a reshard, `Shards` also lists the CLOSED
  // parents (an ending sequence number) for the retention period. Counting
  // them made drift report 1 -> 4 on a 1-shard stream, and recorded a baseline
  // `drift --revert` then sent to UpdateShardCount.
  it('reports the OPEN shard count, not the closed parents a reshard leaves', async () => {
    mockSend
      .mockResolvedValueOnce({
        StreamDescription: {
          StreamName: 'mystream',
          StreamModeDetails: { StreamMode: 'PROVISIONED' },
          Shards: [
            { ShardId: 's-0', SequenceNumberRange: { StartingSequenceNumber: '1', EndingSequenceNumber: '2' } },
            { ShardId: 's-1', SequenceNumberRange: { StartingSequenceNumber: '3', EndingSequenceNumber: '4' } },
            { ShardId: 's-2', SequenceNumberRange: { StartingSequenceNumber: '3', EndingSequenceNumber: '5' } },
            { ShardId: 's-3', SequenceNumberRange: { StartingSequenceNumber: '6' } },
          ],
          RetentionPeriodHours: 48,
          EncryptionType: 'NONE',
        },
      })
      .mockResolvedValueOnce({ StreamDescriptionSummary: { OpenShardCount: 1 } })
      .mockResolvedValueOnce({ Tags: [] });

    const result = (await provider.readCurrentState('mystream', 'L', 'AWS::Kinesis::Stream')) as Record<
      string,
      unknown
    >;

    expect(mockSend).toHaveBeenCalledTimes(3);
    expect(result['ShardCount']).toBe(1);
  });

  it('prefers the summary OpenShardCount over the first DescribeStream page', async () => {
    // A stream past 100 shards: the first page is capped, the summary is not.
    mockSend
      .mockResolvedValueOnce({
        StreamDescription: {
          StreamName: 'mystream',
          StreamModeDetails: { StreamMode: 'PROVISIONED' },
          Shards: Array.from({ length: 100 }, (_, i) => ({ ShardId: `s-${i}` })),
          HasMoreShards: true,
          RetentionPeriodHours: 24,
          EncryptionType: 'NONE',
        },
      })
      .mockResolvedValueOnce({ StreamDescriptionSummary: { OpenShardCount: 150 } })
      .mockResolvedValueOnce({ Tags: [] });

    const result = (await provider.readCurrentState('mystream', 'L', 'AWS::Kinesis::Stream')) as Record<
      string,
      unknown
    >;

    expect(result['ShardCount']).toBe(150);
  });

  it('without a summary count, counts only the page shards that are still open', async () => {
    mockSend
      .mockResolvedValueOnce({
        StreamDescription: {
          StreamName: 'mystream',
          StreamModeDetails: { StreamMode: 'PROVISIONED' },
          Shards: [
            { ShardId: 's-0', SequenceNumberRange: { StartingSequenceNumber: '1', EndingSequenceNumber: '2' } },
            { ShardId: 's-1', SequenceNumberRange: { StartingSequenceNumber: '3' } },
            { ShardId: 's-2', SequenceNumberRange: { StartingSequenceNumber: '3' } },
          ],
          RetentionPeriodHours: 24,
          EncryptionType: 'NONE',
        },
      })
      .mockResolvedValueOnce({ StreamDescriptionSummary: {} })
      .mockResolvedValueOnce({ Tags: [] });

    const result = (await provider.readCurrentState('mystream', 'L', 'AWS::Kinesis::Stream')) as Record<
      string,
      unknown
    >;

    expect(result['ShardCount']).toBe(2);
  });

  it('without a summary count, omits ShardCount when the page is not the whole list', async () => {
    mockSend
      .mockResolvedValueOnce({
        StreamDescription: {
          StreamName: 'mystream',
          StreamModeDetails: { StreamMode: 'PROVISIONED' },
          Shards: Array.from({ length: 100 }, (_, i) => ({ ShardId: `s-${i}` })),
          HasMoreShards: true,
          RetentionPeriodHours: 24,
          EncryptionType: 'NONE',
        },
      })
      .mockResolvedValueOnce({ StreamDescriptionSummary: {} })
      .mockResolvedValueOnce({ Tags: [] });

    const result = (await provider.readCurrentState('mystream', 'L', 'AWS::Kinesis::Stream')) as Record<
      string,
      unknown
    >;

    expect('ShardCount' in result).toBe(false);
  });

  it('omits ShardCount for an ON_DEMAND stream even though AWS reports an OpenShardCount', async () => {
    // AWS rejects UpdateShardCount on ON_DEMAND, so a ShardCount here would
    // become a failing `drift --revert`.
    mockSend
      .mockResolvedValueOnce({
        StreamDescription: {
          StreamName: 'mystream',
          StreamModeDetails: { StreamMode: 'ON_DEMAND' },
          Shards: [{ ShardId: 's-0' }, { ShardId: 's-1' }, { ShardId: 's-2' }, { ShardId: 's-3' }],
          RetentionPeriodHours: 24,
          EncryptionType: 'NONE',
        },
      })
      .mockResolvedValueOnce({ StreamDescriptionSummary: { OpenShardCount: 4 } })
      .mockResolvedValueOnce({ Tags: [] });

    const result = (await provider.readCurrentState('mystream', 'L', 'AWS::Kinesis::Stream')) as Record<
      string,
      unknown
    >;

    expect('ShardCount' in result).toBe(false);
  });

  it('emits StreamEncryption with EncryptionType=NONE placeholder when stream is unencrypted', async () => {
    mockSend
      .mockResolvedValueOnce({
        StreamDescription: {
          StreamName: 'mystream',
          StreamModeDetails: { StreamMode: 'ON_DEMAND' },
          Shards: [],
          RetentionPeriodHours: 24,
          EncryptionType: 'NONE',
        },
      })
      .mockResolvedValueOnce({ StreamDescriptionSummary: {} })
      .mockResolvedValueOnce({ Tags: [] });

    const result = await provider.readCurrentState('mystream', 'L', 'AWS::Kinesis::Stream');

    expect(result).toEqual({
      Name: 'mystream',
      StreamModeDetails: { StreamMode: 'ON_DEMAND' },
      RetentionPeriodHours: 24,
      StreamEncryption: { EncryptionType: 'NONE' },
      DesiredShardLevelMetrics: [],
      Tags: [],
    });
  });

  it('returns RESOURCE_NOT_FOUND when stream is gone', async () => {
    mockSend.mockRejectedValueOnce(
      new ResourceNotFoundException({ message: 'gone', $metadata: {} })
    );
    const result = await provider.readCurrentState('mystream', 'L', 'AWS::Kinesis::Stream');
    expect(result).toBe(RESOURCE_NOT_FOUND);
  });

  it('returns RESOURCE_NOT_FOUND when ListTagsForStream reports the stream gone', async () => {
    mockSend
      .mockResolvedValueOnce({ StreamDescription: { StreamName: 'mystream' } })
      .mockResolvedValueOnce({ StreamDescriptionSummary: {} })
      .mockRejectedValueOnce(new ResourceNotFoundException({ message: 'gone', $metadata: {} }));
    const result = await provider.readCurrentState('mystream', 'L', 'AWS::Kinesis::Stream');
    expect(result).toBe(RESOURCE_NOT_FOUND);
  });

  it('keeps returning undefined (no read path) for a type other than AWS::Kinesis::Stream', async () => {
    const result = await provider.readCurrentState('x', 'L', 'AWS::Kinesis::StreamConsumer');
    expect(result).toBeUndefined();
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('surfaces Tags from ListTagsForStream with aws:* filtered out', async () => {
    mockSend
      .mockResolvedValueOnce({ StreamDescription: { StreamName: 'mystream' } })
      .mockResolvedValueOnce({ StreamDescriptionSummary: {} })
      .mockResolvedValueOnce({
        Tags: [
          { Key: 'Foo', Value: 'Bar' },
          { Key: 'aws:cdk:path', Value: 'MyStack/MyStream/Resource' },
        ],
      });

    const result = (await provider.readCurrentState('mystream', 'L', 'AWS::Kinesis::Stream')) as Record<string, unknown> | undefined;
    expect(result?.Tags).toEqual([{ Key: 'Foo', Value: 'Bar' }]);
  });

  it('omits Tags when ListTagsForStream returns no user tags', async () => {
    mockSend
      .mockResolvedValueOnce({ StreamDescription: { StreamName: 'mystream' } })
      .mockResolvedValueOnce({ StreamDescriptionSummary: {} })
      .mockResolvedValueOnce({
        Tags: [{ Key: 'aws:cdk:path', Value: 'MyStack/MyStream/Resource' }],
      });

    const result = (await provider.readCurrentState('mystream', 'L', 'AWS::Kinesis::Stream')) as Record<string, unknown> | undefined;
    expect(result?.Tags).toEqual([]);
  });

  // Issue #609 backfill: DesiredShardLevelMetrics + MaxRecordSizeInKiB.
  it('flattens EnhancedMonitoring groups into the flat DesiredShardLevelMetrics list', async () => {
    mockSend
      .mockResolvedValueOnce({
        StreamDescription: {
          StreamName: 'mystream',
          EnhancedMonitoring: [
            { ShardLevelMetrics: ['IncomingBytes', 'OutgoingBytes'] },
            { ShardLevelMetrics: ['IteratorAgeMilliseconds'] },
          ],
        },
      })
      .mockResolvedValueOnce({ StreamDescriptionSummary: {} })
      .mockResolvedValueOnce({ Tags: [] });

    const result = (await provider.readCurrentState('mystream', 'L', 'AWS::Kinesis::Stream')) as Record<string, unknown> | undefined;

    expect(result?.['DesiredShardLevelMetrics']).toEqual([
      'IncomingBytes',
      'OutgoingBytes',
      'IteratorAgeMilliseconds',
    ]);
  });

  it('reads MaxRecordSizeInKiB from DescribeStreamSummary (absent from StreamDescription)', async () => {
    mockSend
      .mockResolvedValueOnce({ StreamDescription: { StreamName: 'mystream' } })
      .mockResolvedValueOnce({ StreamDescriptionSummary: { MaxRecordSizeInKiB: 2048 } })
      .mockResolvedValueOnce({ Tags: [] });

    const result = (await provider.readCurrentState('mystream', 'L', 'AWS::Kinesis::Stream')) as Record<string, unknown> | undefined;

    expect(mockSend.mock.calls[1]?.[0]).toBeInstanceOf(DescribeStreamSummaryCommand);
    expect(result?.['MaxRecordSizeInKiB']).toBe(2048);
  });

  it('omits MaxRecordSizeInKiB when the summary genuinely reports none', async () => {
    mockSend
      .mockResolvedValueOnce({ StreamDescription: { StreamName: 'mystream' } })
      .mockResolvedValueOnce({ StreamDescriptionSummary: {} })
      .mockResolvedValueOnce({ Tags: [] });

    const result = (await provider.readCurrentState('mystream', 'L', 'AWS::Kinesis::Stream')) as Record<string, unknown> | undefined;

    expect(result).toBeDefined();
    expect(result).not.toHaveProperty('MaxRecordSizeInKiB');
    expect(result?.Tags).toEqual([]);
  });

  it('RETHROWS a non-not-found summary failure rather than reporting a key-less snapshot', async () => {
    // A DEFAULT (not a `*Once` primer) for any call past the rejection. A
    // regression that SWALLOWS the throttle would fall through to the tags
    // call; unprimed, `mockSend` returns `undefined`, reading `.Tags` off it
    // throws a TypeError, and the tags catch turns that into a rejection — so
    // the assertion below would pass for entirely the wrong reason and could
    // not see the swallow at all (found by mutation probe). A default keeps the
    // fallthrough VALID so the swallow resolves and the test fails, and unlike
    // a third `*Once` it cannot leak into the next test when unconsumed.
    mockSend.mockResolvedValue({ Tags: [] });
    mockSend
      .mockResolvedValueOnce({ StreamDescription: { StreamName: 'mystream' } })
      .mockRejectedValueOnce(new Error('Rate exceeded'));

    // Swallowing a throttle would return a snapshot MISSING MaxRecordSizeInKiB
    // while state declares it, so `cdkd drift` reports `2048 -> undefined` and
    // `--accept` erases it from the baseline — a transient error turned into
    // data loss. This read is the third Kinesis call per stream, so throttling
    // is a realistic trigger.
    await expect(
      provider.readCurrentState('mystream', 'L', 'AWS::Kinesis::Stream')
    ).rejects.toThrow('Rate exceeded');

    // The rethrow must happen BEFORE the tags call, so the primer above stays
    // unconsumed; asserting the call count is what pins that (and keeps the
    // primer from leaking into the next test).
    expect(mockSend).toHaveBeenCalledTimes(2);
  });

  it('returns RESOURCE_NOT_FOUND when the summary call reports the stream gone', async () => {
    mockSend
      .mockResolvedValueOnce({ StreamDescription: { StreamName: 'mystream' } })
      .mockRejectedValueOnce(new ResourceNotFoundException({ message: 'gone', $metadata: {} }));

    const result = await provider.readCurrentState('mystream', 'L', 'AWS::Kinesis::Stream');
    expect(result).toBe(RESOURCE_NOT_FOUND);
  });
});
