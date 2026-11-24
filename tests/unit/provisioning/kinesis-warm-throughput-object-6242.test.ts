/**
 * go-to-k/cdkd#6242: `Fn::GetAtt [Stream, WarmThroughputObject]` was refused.
 * CloudFormation answers `{"TargetMiBps": 0, "CurrentMiBps": 0}` (NUMBERS) for a
 * PROVISIONED and an ON_DEMAND stream alike, while `DescribeStreamSummary`
 * reports no `WarmThroughput` for either (both measured us-east-1,
 * 2026-11-14). Create, update and `import()` record it through
 * `streamAttributes`, from a summary of the settled stream.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  CreateStreamCommand,
  DescribeStreamCommand,
  DescribeStreamSummaryCommand,
} from '@aws-sdk/client-kinesis';

const mockSend = vi.hoisted(() => vi.fn());
vi.mock('@aws-sdk/client-kinesis', async () => ({
  ...(await vi.importActual('@aws-sdk/client-kinesis')),
  KinesisClient: vi.fn(() => ({
    send: mockSend,
    config: { region: () => Promise.resolve('us-east-1') },
  })),
}));
vi.mock('../../../src/utils/logger.js', () => {
  const fns = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { getLogger: () => ({ ...fns, child: () => fns }) };
});

import { KinesisStreamProvider } from '../../../src/provisioning/providers/kinesis-provider.js';
import { streamAttributes } from '../../../src/provisioning/providers/kinesis/attributes.js';

const ARN = 'arn:aws:kinesis:us-east-1:123456789012:stream/s';

function mockStream(warm?: { TargetMiBps?: number; CurrentMiBps?: number }) {
  mockSend.mockImplementation((cmd: unknown) => {
    if (cmd instanceof DescribeStreamSummaryCommand) {
      return Promise.resolve({
        StreamDescriptionSummary: {
          StreamName: 's',
          StreamARN: ARN,
          StreamStatus: 'ACTIVE',
          ...(warm ? { WarmThroughput: warm } : {}),
        },
      });
    }
    if (cmd instanceof DescribeStreamCommand) {
      return Promise.resolve({
        StreamDescription: { StreamName: 's', StreamARN: ARN, StreamStatus: 'ACTIVE' },
      });
    }
    return Promise.resolve({});
  });
}

describe('streamAttributes (#6242)', () => {
  it('records the zeros CloudFormation answers when AWS reports no warm throughput', () => {
    expect(streamAttributes({ StreamARN: ARN } as never)).toStrictEqual({
      Arn: ARN,
      WarmThroughputObject: { TargetMiBps: 0, CurrentMiBps: 0 },
    });
  });

  it('records the reported numbers verbatim', () => {
    expect(
      streamAttributes({ StreamARN: ARN, WarmThroughput: { TargetMiBps: 200, CurrentMiBps: 100 } } as never)
    ).toStrictEqual({ Arn: ARN, WarmThroughputObject: { TargetMiBps: 200, CurrentMiBps: 100 } });
  });

  it('records nothing for a stream that did not answer', () => {
    expect(streamAttributes(undefined)).toStrictEqual({});
  });
});

describe('KinesisStreamProvider records WarmThroughputObject on every write (#6242)', () => {
  beforeEach(() => mockSend.mockReset());

  it('create: from a summary read after the stream is ACTIVE', async () => {
    mockStream();
    const result = await new KinesisStreamProvider().create('S', 'AWS::Kinesis::Stream', {
      Name: 's',
      ShardCount: 1,
    });
    expect(result.attributes).toStrictEqual({
      Arn: ARN,
      WarmThroughputObject: { TargetMiBps: 0, CurrentMiBps: 0 },
    });
    // No extra read: the attributes come from the ACTIVE answer of the wait
    // itself, the one summary after CreateStream, and nothing follows it.
    const names = mockSend.mock.calls.map((c) => (c[0] as object).constructor.name);
    const createAt = names.indexOf('CreateStreamCommand');
    expect(createAt).toBeGreaterThanOrEqual(0);
    expect(names.slice(createAt + 1)).toEqual(['DescribeStreamSummaryCommand']);
    expect(mockSend.mock.calls.some((c) => c[0] instanceof CreateStreamCommand)).toBe(true);
  });

  it.each([
    ['a retention change', { RetentionPeriodHours: 48 }, 2],
    ['stream encryption', { StreamEncryption: { EncryptionType: 'KMS', KeyId: 'alias/aws/kinesis' } }, 2],
    ['shard-level metrics', { DesiredShardLevelMetrics: ['IncomingBytes'] }, 2],
    [
      'all three follow-ups',
      {
        RetentionPeriodHours: 48,
        StreamEncryption: { EncryptionType: 'KMS', KeyId: 'alias/aws/kinesis' },
        DesiredShardLevelMetrics: ['IncomingBytes'],
      },
      4,
    ],
  ])(
    'create: after %s, the attributes come from the LAST ACTIVE answer',
    async (_label, extra, waits) => {
      // Each follow-up waits for ACTIVE again; the last answer is recorded.
      let summaries = 0;
      mockSend.mockImplementation((cmd: unknown) => {
        if (cmd instanceof DescribeStreamSummaryCommand) {
          summaries += 1;
          return Promise.resolve({
            StreamDescriptionSummary: {
              StreamName: 's',
              StreamARN: ARN,
              StreamStatus: 'ACTIVE',
              WarmThroughput: { TargetMiBps: summaries, CurrentMiBps: summaries },
            },
          });
        }
        return Promise.resolve({});
      });
      const result = await new KinesisStreamProvider().create('S', 'AWS::Kinesis::Stream', {
        Name: 's',
        ShardCount: 1,
        ...extra,
      });
      expect(summaries).toBe(waits);
      expect(result.attributes?.['WarmThroughputObject']).toStrictEqual({
        TargetMiBps: waits,
        CurrentMiBps: waits,
      });
    }
  );

  it('update: the map replaces the record, so it carries Arn and the object', async () => {
    mockStream({ TargetMiBps: 200, CurrentMiBps: 100 });
    const props = { Name: 's', ShardCount: 1 };
    const result = await new KinesisStreamProvider().update(
      'S',
      's',
      'AWS::Kinesis::Stream',
      props,
      props
    );
    expect(result.attributes).toStrictEqual({
      Arn: ARN,
      WarmThroughputObject: { TargetMiBps: 200, CurrentMiBps: 100 },
    });
  });

  it('import: the same map create and update record', async () => {
    mockStream();
    const result = await new KinesisStreamProvider().import({
      logicalId: 'S',
      resourceType: 'AWS::Kinesis::Stream',
      stackName: 'St',
      region: 'us-east-1',
      properties: {},
      knownPhysicalId: 's',
    });
    expect(result?.attributes).toStrictEqual({
      Arn: ARN,
      WarmThroughputObject: { TargetMiBps: 0, CurrentMiBps: 0 },
    });
  });
});
