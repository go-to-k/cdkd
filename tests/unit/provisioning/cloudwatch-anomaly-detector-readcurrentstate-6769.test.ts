import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  DescribeAnomalyDetectorsCommand,
  type AnomalyDetector,
} from '@aws-sdk/client-cloudwatch';

/**
 * go-to-k/cdkd#6769: `AWS::CloudWatch::AnomalyDetector` reads back through
 * `DescribeAnomalyDetectors`, filtered by the recorded descriptor (its physical
 * id is a cdkd descriptor Cloud Control cannot address, #4668).
 */

const mockSend = vi.fn();
const mockStsSend = vi.fn();
const warn = vi.fn();

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    cloudWatch: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
    sts: { send: mockStsSend },
  }),
}));

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: (...args: unknown[]) => warn(...args),
    error: vi.fn(),
    child: vi.fn(function (this: unknown) { return this; }),
  };
  return { getLogger: () => ({ child: () => childLogger }) };
});

import { CloudWatchAnomalyDetectorProvider } from '../../../src/provisioning/providers/cloudwatch-anomaly-detector-provider.js';
import { RESOURCE_NOT_FOUND } from '../../../src/types/resource.js';

const TYPE = 'AWS::CloudWatch::AnomalyDetector';
const DIMS = [{ Name: 'QueueName', Value: 'q' }];

/** What CDK's `CfnAnomalyDetector` emits for the plain top-level tuple. */
const TUPLE = { Namespace: 'AWS/SQS', MetricName: 'NumberOfMessagesSent', Stat: 'Sum', Dimensions: DIMS };

/** A single-metric detector as DescribeAnomalyDetectors answers it. */
function liveSingle(over: Partial<AnomalyDetector> = {}, dims = DIMS): AnomalyDetector {
  return {
    Namespace: 'AWS/SQS',
    MetricName: 'NumberOfMessagesSent',
    Dimensions: dims,
    Stat: 'Sum',
    StateValue: 'TRAINED',
    SingleMetricAnomalyDetector: {
      Namespace: 'AWS/SQS',
      MetricName: 'NumberOfMessagesSent',
      Dimensions: dims,
      Stat: 'Sum',
    },
    Configuration: { ExcludedTimeRanges: [] },
    ...over,
  };
}

function answer(...pages: AnomalyDetector[][]): void {
  mockSend.mockReset();
  mockSend.mockImplementation((cmd: unknown) => {
    if (!(cmd instanceof DescribeAnomalyDetectorsCommand)) {
      return Promise.reject(new Error('unexpected command'));
    }
    const i = cmd.input.NextToken === undefined ? 0 : Number(cmd.input.NextToken);
    return Promise.resolve({
      AnomalyDetectors: pages[i] ?? [],
      ...(i + 1 < pages.length && { NextToken: String(i + 1) }),
    });
  });
}

describe('CloudWatchAnomalyDetectorProvider.readCurrentState (go-to-k/cdkd#6769)', () => {
  let provider: CloudWatchAnomalyDetectorProvider;
  beforeEach(() => {
    vi.clearAllMocks();
    provider = new CloudWatchAnomalyDetectorProvider();
    provider.ownWriteRereadDelaysMs = [0, 0];
  });
  const read = (properties: Record<string, unknown> | undefined, context?: unknown) =>
    provider.readCurrentState('AWS/SQS:NumberOfMessagesSent:Sum:QueueName=q', 'Detector', TYPE, properties, context as never);

  it('reads a clean top-level-tuple detector back as the record', async () => {
    answer([liveSingle()]);
    expect(await read(TUPLE)).toEqual({ ...TUPLE, Configuration: {} });
    const input = (mockSend.mock.calls[0]![0] as DescribeAnomalyDetectorsCommand).input;
    expect(input).toEqual({
      AnomalyDetectorTypes: ['SINGLE_METRIC'],
      Namespace: 'AWS/SQS',
      MetricName: 'NumberOfMessagesSent',
    });
  });

  it('keeps the record spelling of an ExcludedTimeRanges time that is the same instant', async () => {
    const configuration = {
      MetricTimeZone: 'UTC',
      ExcludedTimeRanges: [
        { StartTime: '2026-01-01T00:00:00', EndTime: '2026-01-02T00:00:00' },
        { StartTime: '2026-03-01T09:00:00+09:00', EndTime: '2026-03-02T00:00:00Z' },
      ],
    };
    answer([
      liveSingle({
        Configuration: {
          MetricTimezone: 'UTC',
          ExcludedTimeRanges: [
            { StartTime: new Date('2026-01-01T00:00:00Z'), EndTime: new Date('2026-01-02T00:00:00Z') },
            { StartTime: new Date('2026-03-01T00:00:00Z'), EndTime: new Date('2026-03-02T00:00:00Z') },
          ],
        },
      }),
    ]);
    expect(await read({ ...TUPLE, Configuration: configuration })).toEqual({
      ...TUPLE,
      Configuration: configuration,
    });
  });

  it('reports an out-of-band Configuration change', async () => {
    answer([
      liveSingle({
        Configuration: {
          MetricTimezone: 'Asia/Tokyo',
          ExcludedTimeRanges: [
            { StartTime: new Date('2026-05-01T00:00:00Z'), EndTime: new Date('2026-05-02T00:00:00Z') },
          ],
        },
      }),
    ]);
    expect((await read(TUPLE)) as Record<string, unknown>).toMatchObject({
      Configuration: {
        MetricTimeZone: 'Asia/Tokyo',
        ExcludedTimeRanges: [{ StartTime: '2026-05-01T00:00:00', EndTime: '2026-05-02T00:00:00' }],
      },
    });
  });

  it('matches the dimension set, not another detector on the same metric', async () => {
    const other = [{ Name: 'QueueName', Value: 'other' }];
    const two = [
      { Name: 'B', Value: '2' },
      { Name: 'A', Value: '1' },
    ];
    answer([liveSingle({}, other), liveSingle({ Configuration: { MetricTimezone: 'UTC' } }, two)]);
    const recorded = { ...TUPLE, Dimensions: [{ Name: 'A', Value: '1' }, { Name: 'B', Value: '2' }] };
    expect(await read(recorded)).toEqual({
      ...recorded,
      Configuration: { MetricTimeZone: 'UTC' },
    });
  });

  it('follows NextToken', async () => {
    answer([liveSingle({}, [{ Name: 'QueueName', Value: 'x' }])], [liveSingle()]);
    expect(await read(TUPLE)).toEqual({ ...TUPLE, Configuration: {} });
    expect(mockSend).toHaveBeenCalledTimes(2);
  });

  it('reads a SingleMetricAnomalyDetector record in that form', async () => {
    const single = { Namespace: 'AWS/SQS', MetricName: 'NumberOfMessagesSent', Stat: 'Sum', Dimensions: DIMS };
    answer([liveSingle({ MetricCharacteristics: { PeriodicSpikes: true } })]);
    expect(await read({ SingleMetricAnomalyDetector: single })).toEqual({
      SingleMetricAnomalyDetector: single,
      Configuration: {},
      MetricCharacteristics: { PeriodicSpikes: true },
    });
  });

  it('matches a metric-math detector on its queries, scalars compared as strings', async () => {
    const queries = [
      {
        Id: 'm1',
        ReturnData: false,
        MetricStat: {
          Metric: { Namespace: 'AWS/SQS', MetricName: 'NumberOfMessagesSent', Dimensions: DIMS },
          Period: 300,
          Stat: 'Sum',
        },
      },
      { Id: 'e1', Expression: 'm1 * 2', ReturnData: true },
    ];
    const live = (expression: string): AnomalyDetector => ({
      MetricMathAnomalyDetector: {
        MetricDataQueries: [
          { ...queries[0]!, MetricStat: { ...queries[0]!.MetricStat!, Unit: undefined } },
          { Id: 'e1', Expression: expression, ReturnData: true },
        ],
      },
      Configuration: { ExcludedTimeRanges: [] },
    });
    answer([live('m1 * 3'), live('m1 * 2')]);
    const recorded = {
      MetricMathAnomalyDetector: {
        MetricDataQueries: [{ ...queries[0]!, MetricStat: { ...queries[0]!.MetricStat, Period: '300' } }, queries[1]],
      },
    };
    const result = (await read(recorded)) as Record<string, unknown>;
    expect(result['MetricMathAnomalyDetector']).toEqual({ MetricDataQueries: queries });
    expect((mockSend.mock.calls[0]![0] as DescribeAnomalyDetectorsCommand).input).toEqual({
      AnomalyDetectorTypes: ['METRIC_MATH'],
    });
  });

  it('matches the recorded AccountId, and falls back to a detector AWS answers with none', async () => {
    const single = { ...TUPLE, AccountId: '111111111111' };
    const other = liveSingle();
    other.SingleMetricAnomalyDetector = { ...other.SingleMetricAnomalyDetector!, AccountId: '222222222222' };
    const mine = liveSingle({ Configuration: { MetricTimezone: 'UTC' } });
    mine.SingleMetricAnomalyDetector = { ...mine.SingleMetricAnomalyDetector!, AccountId: '111111111111' };
    answer([other, mine]);
    expect(((await read({ SingleMetricAnomalyDetector: single })) as Record<string, unknown>)['Configuration']).toEqual({
      MetricTimeZone: 'UTC',
    });
    expect(mockStsSend).not.toHaveBeenCalled();
    // No live AccountId at all, and the record names the caller's account.
    mockStsSend.mockResolvedValue({ Account: '111111111111' });
    answer([liveSingle({ Configuration: { MetricTimezone: 'Z' } })]);
    expect(await read({ SingleMetricAnomalyDetector: single })).toEqual({
      SingleMetricAnomalyDetector: TUPLE,
      Configuration: { MetricTimeZone: 'Z' },
    });
  });

  it('does not take an own-account detector for a deleted cross-account one', async () => {
    mockStsSend.mockResolvedValue({ Account: '999999999999' });
    answer([liveSingle()]);
    expect(await read({ SingleMetricAnomalyDetector: { ...TUPLE, AccountId: '111111111111' } })).toBe(
      RESOURCE_NOT_FOUND
    );
  });

  it('reads the deprecated top-level fields when AWS answers only those', async () => {
    answer([{ ...liveSingle(), SingleMetricAnomalyDetector: undefined }]);
    expect(await read(TUPLE)).toEqual({ ...TUPLE, Configuration: {} });
  });

  it('reads every declared exclusion removed out of band as ExcludedTimeRanges: []', async () => {
    answer([liveSingle()]);
    const configuration = {
      ExcludedTimeRanges: [{ StartTime: '2026-01-01T00:00:00', EndTime: '2026-01-02T00:00:00' }],
    };
    expect(((await read({ ...TUPLE, Configuration: configuration })) as Record<string, unknown>)['Configuration']).toEqual({
      ExcludedTimeRanges: [],
    });
  });

  it('matches a metric-math query whose ReturnData AWS leaves out', async () => {
    const query = { Id: 'e1', Expression: 'm1 * 2', ReturnData: true };
    answer([{ MetricMathAnomalyDetector: { MetricDataQueries: [{ Id: 'e1', Expression: 'm1 * 2' }] } }]);
    expect(((await read({ MetricMathAnomalyDetector: { MetricDataQueries: [query] } })) as Record<string, unknown>)['MetricMathAnomalyDetector']).toEqual({
      MetricDataQueries: [{ Id: 'e1', Expression: 'm1 * 2' }],
    });
  });

  it('warns, value-free, when the capture after its own write never shows the declared Configuration', async () => {
    answer([liveSingle()]);
    await read({ ...TUPLE, Configuration: { MetricTimeZone: 'UTC' } }, { afterOwnWrite: true });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain('Configuration');
    expect(String(warn.mock.calls[0]![0])).not.toContain('UTC');
  });

  it('is RESOURCE_NOT_FOUND when no detector has the recorded descriptor', async () => {
    answer([liveSingle({ Stat: 'Average', SingleMetricAnomalyDetector: { ...liveSingle().SingleMetricAnomalyDetector, Stat: 'Average' } })]);
    expect(await read(TUPLE)).toBe(RESOURCE_NOT_FOUND);
  });

  it('throws a Describe failure', async () => {
    const denied = Object.assign(new Error('denied'), { name: 'AccessDenied' });
    mockSend.mockReset();
    mockSend.mockRejectedValue(denied);
    await expect(read(TUPLE)).rejects.toBe(denied);
  });

  it.each([
    ['a redacted dimension value', { ...TUPLE, Dimensions: [{ Name: 'QueueName', Value: '***' }] }],
    ['no descriptor', { Configuration: {} }],
    ['no properties', undefined],
  ])('is drift unknown, with no call, for %s', async (_label, properties) => {
    answer([liveSingle()]);
    expect(await read(properties)).toBeUndefined();
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('re-reads on the capture after its own write until the declared Configuration shows', async () => {
    let calls = 0;
    mockSend.mockReset();
    mockSend.mockImplementation(() => {
      calls++;
      return Promise.resolve({
        AnomalyDetectors: [
          calls === 1 ? liveSingle() : liveSingle({ Configuration: { MetricTimezone: 'UTC' } }),
        ],
      });
    });
    const result = await read({ ...TUPLE, Configuration: { MetricTimeZone: 'UTC' } }, { afterOwnWrite: true });
    expect((result as Record<string, unknown>)['Configuration']).toEqual({ MetricTimeZone: 'UTC' });
    expect(calls).toBe(2);
    expect(warn).not.toHaveBeenCalled();
  });

  it('re-reads a detector not listed yet on the capture after its own write', async () => {
    let calls = 0;
    mockSend.mockReset();
    mockSend.mockImplementation(() => {
      calls++;
      return Promise.resolve({ AnomalyDetectors: calls === 1 ? [] : [liveSingle()] });
    });
    expect(await read(TUPLE, { afterOwnWrite: true })).toEqual({ ...TUPLE, Configuration: {} });
  });
});
