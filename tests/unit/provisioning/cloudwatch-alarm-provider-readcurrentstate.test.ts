import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DescribeAlarmsCommand } from '@aws-sdk/client-cloudwatch';

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
      TreatMissingData: 'notBreaching',
      Dimensions: [{ Name: 'InstanceId', Value: 'i-abc' }],
    });
  });

  it('returns undefined when alarm is gone (empty MetricAlarms)', async () => {
    mockSend.mockResolvedValueOnce({ MetricAlarms: [] });
    const result = await provider.readCurrentState('myalarm', 'L', 'AWS::CloudWatch::Alarm');
    expect(result).toBeUndefined();
  });
});
