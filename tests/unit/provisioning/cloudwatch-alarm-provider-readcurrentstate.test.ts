import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  DescribeAlarmsCommand,
  ListTagsForResourceCommand,
} from '@aws-sdk/client-cloudwatch';

const mockSend = vi.fn();

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    cloudWatch: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
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

import { CloudWatchAlarmProvider } from '../../../src/provisioning/providers/cloudwatch-alarm-provider.js';

describe('CloudWatchAlarmProvider.readCurrentState', () => {
  let provider: CloudWatchAlarmProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new CloudWatchAlarmProvider();
  });

  it('returns CFn-shaped properties from DescribeAlarms (happy path)', async () => {
    mockSend.mockResolvedValueOnce({
      MetricAlarms: [
        {
          AlarmName: 'myalarm',
          AlarmDescription: 'mine',
          MetricName: 'CPUUtilization',
          Namespace: 'AWS/EC2',
          Statistic: 'Average',
          ComparisonOperator: 'GreaterThanThreshold',
          Threshold: 80,
          EvaluationPeriods: 2,
          Period: 60,
          DatapointsToAlarm: 1,
          ActionsEnabled: true,
          AlarmActions: ['arn:aws:sns:us-east-1:1:topic'],
          TreatMissingData: 'notBreaching',
          Dimensions: [{ Name: 'InstanceId', Value: 'i-abc' }],
        },
      ],
    });

    const result = await provider.readCurrentState(
      'myalarm',
      'L',
      'AWS::CloudWatch::Alarm'
    );

    expect(mockSend.mock.calls[0]?.[0]).toBeInstanceOf(DescribeAlarmsCommand);
    expect(result).toEqual({
      AlarmName: 'myalarm',
      AlarmDescription: 'mine',
      MetricName: 'CPUUtilization',
      Namespace: 'AWS/EC2',
      Statistic: 'Average',
      ComparisonOperator: 'GreaterThanThreshold',
      Threshold: 80,
      EvaluationPeriods: 2,
      Period: 60,
      DatapointsToAlarm: 1,
      ActionsEnabled: true,
      AlarmActions: ['arn:aws:sns:us-east-1:1:topic'],
      OKActions: [],
      InsufficientDataActions: [],
      TreatMissingData: 'notBreaching',
      Unit: '',
      Dimensions: [{ Name: 'InstanceId', Value: 'i-abc' }],
      Metrics: [],
    });
  });

  it('returns undefined when alarm is gone (empty MetricAlarms)', async () => {
    mockSend.mockResolvedValueOnce({ MetricAlarms: [] });
    const result = await provider.readCurrentState('myalarm', 'L', 'AWS::CloudWatch::Alarm');
    expect(result).toBeUndefined();
  });

  it('surfaces Tags from ListTagsForResource with aws:* filtered out', async () => {
    mockSend
      .mockResolvedValueOnce({
        MetricAlarms: [
          {
            AlarmName: 'myalarm',
            AlarmArn: 'arn:aws:cloudwatch:us-east-1:1:alarm:myalarm',
          },
        ],
      })
      .mockResolvedValueOnce({
        Tags: [
          { Key: 'Foo', Value: 'Bar' },
          { Key: 'aws:cdk:path', Value: 'MyStack/MyAlarm/Resource' },
        ],
      });

    const result = await provider.readCurrentState('myalarm', 'L', 'AWS::CloudWatch::Alarm');
    expect(mockSend.mock.calls[1]?.[0]).toBeInstanceOf(ListTagsForResourceCommand);
    expect(result?.Tags).toEqual([{ Key: 'Foo', Value: 'Bar' }]);
  });

  it('omits Tags when ListTagsForResource returns no user tags', async () => {
    mockSend
      .mockResolvedValueOnce({
        MetricAlarms: [
          {
            AlarmName: 'myalarm',
            AlarmArn: 'arn:aws:cloudwatch:us-east-1:1:alarm:myalarm',
          },
        ],
      })
      .mockResolvedValueOnce({
        Tags: [{ Key: 'aws:cdk:path', Value: 'MyStack/MyAlarm/Resource' }],
      });

    const result = await provider.readCurrentState('myalarm', 'L', 'AWS::CloudWatch::Alarm');
    expect(result?.Tags).toEqual([]);
  });

  // Structural regression test for the always-emit-placeholder convention
  // (docs/provider-development.md § 3b). Ensures every user-controllable
  // top-level CFn key is present in the result even when AWS returns
  // the resource with all optional fields undefined / empty. A future
  // refactor that drops a placeholder for any of these keys must update
  // this test consciously — silent regression is structurally prevented.
  //
  // ComparisonOperator / Threshold / EvaluationPeriods / Period /
  // DatapointsToAlarm are NOT placeholders — the provider emits them
  // only when present (alarm-shape-discriminator fields whose absence
  // already implies "metric-math form"), so they're correctly absent
  // from the minimum response.
  it('emits placeholders for every user-controllable top-level key on AWS minimum response', async () => {
    mockSend
      .mockResolvedValueOnce({
        MetricAlarms: [
          {
            AlarmName: 'a',
            AlarmArn: 'arn:aws:cloudwatch:us-east-1:1:alarm:a',
            // Every other field deliberately undefined.
          },
        ],
      })
      .mockResolvedValueOnce({ Tags: [] });

    const result = await provider.readCurrentState('a', 'L', 'AWS::CloudWatch::Alarm');

    expect(Object.keys(result ?? {}).sort()).toEqual(
      [
        'ActionsEnabled',
        'AlarmActions',
        'AlarmDescription',
        'AlarmName',
        'Dimensions',
        'InsufficientDataActions',
        'MetricName',
        'Metrics',
        'Namespace',
        'OKActions',
        'Statistic',
        'Tags',
        'TreatMissingData',
        'Unit',
      ].sort()
    );
    expect(result?.ActionsEnabled).toBe(true);
    expect(result?.AlarmDescription).toBe('');
    expect(result?.MetricName).toBe('');
    expect(result?.Namespace).toBe('');
    expect(result?.Statistic).toBe('');
    expect(result?.TreatMissingData).toBe('');
    expect(result?.Unit).toBe('');
    expect(result?.AlarmActions).toEqual([]);
    expect(result?.OKActions).toEqual([]);
    expect(result?.InsufficientDataActions).toEqual([]);
    expect(result?.Dimensions).toEqual([]);
    expect(result?.Metrics).toEqual([]);
    expect(result?.Tags).toEqual([]);
  });
});
