import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockSend = vi.hoisted(() => vi.fn());

vi.mock('../../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    cloudWatch: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
  }),
}));

vi.mock('../../../../src/utils/logger.js', () => {
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

import { CloudWatchAlarmProvider } from '../../../../src/provisioning/providers/cloudwatch-alarm-provider.js';
import {
  DescribeAlarmsCommand,
  ListTagsForResourceCommand,
} from '@aws-sdk/client-cloudwatch';

describe('CloudWatchAlarmProvider import', () => {
  let provider: CloudWatchAlarmProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new CloudWatchAlarmProvider();
  });

  function makeInput(
    overrides: Partial<{
      knownPhysicalId: string;
      cdkPath: string;
      properties: Record<string, unknown>;
    }> = {}
  ) {
    return {
      logicalId: 'MyAlarm',
      resourceType: 'AWS::CloudWatch::Alarm',
      cdkPath: 'MyStack/MyAlarm/Resource',
      stackName: 'MyStack',
      region: 'us-east-1',
      properties: {},
      ...overrides,
    };
  }

  it('explicit override: verifies via DescribeAlarms and returns the physicalId', async () => {
    mockSend.mockResolvedValueOnce({
      MetricAlarms: [
        {
          AlarmName: 'my-alarm',
          AlarmArn: 'arn:aws:cloudwatch:us-east-1:123456789012:alarm:my-alarm',
        },
      ],
      CompositeAlarms: [],
    });

    const result = await provider.import(makeInput({ knownPhysicalId: 'my-alarm' }));

    expect(result).toEqual({ physicalId: 'my-alarm', attributes: {} });
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSend.mock.calls[0][0]).toBeInstanceOf(DescribeAlarmsCommand);
    expect(mockSend.mock.calls[0][0].input).toEqual({ AlarmNames: ['my-alarm'] });
  });

  it('tag-based lookup: DescribeAlarms + ListTagsForResource matches aws:cdk:path', async () => {
    mockSend
      // DescribeAlarms (paginated)
      .mockResolvedValueOnce({
        MetricAlarms: [
          {
            AlarmName: 'other-alarm',
            AlarmArn: 'arn:aws:cloudwatch:us-east-1:123456789012:alarm:other-alarm',
          },
          {
            AlarmName: 'my-alarm',
            AlarmArn: 'arn:aws:cloudwatch:us-east-1:123456789012:alarm:my-alarm',
          },
        ],
        CompositeAlarms: [],
      })
      // ListTagsForResource(other-alarm)
      .mockResolvedValueOnce({
        Tags: [{ Key: 'aws:cdk:path', Value: 'OtherStack/Alarm/Resource' }],
      })
      // ListTagsForResource(my-alarm)
      .mockResolvedValueOnce({
        Tags: [{ Key: 'aws:cdk:path', Value: 'MyStack/MyAlarm/Resource' }],
      });

    const result = await provider.import(makeInput());

    expect(result).toEqual({ physicalId: 'my-alarm', attributes: {} });
    expect(mockSend.mock.calls[0][0]).toBeInstanceOf(DescribeAlarmsCommand);
    expect(mockSend.mock.calls[1][0]).toBeInstanceOf(ListTagsForResourceCommand);
    expect(mockSend.mock.calls[2][0]).toBeInstanceOf(ListTagsForResourceCommand);
  });

  it('returns null when no alarm matches the cdkPath', async () => {
    mockSend
      .mockResolvedValueOnce({
        MetricAlarms: [
          {
            AlarmName: 'unrelated',
            AlarmArn: 'arn:aws:cloudwatch:us-east-1:123456789012:alarm:unrelated',
          },
        ],
        CompositeAlarms: [],
      })
      .mockResolvedValueOnce({
        Tags: [{ Key: 'aws:cdk:path', Value: 'OtherStack/Alarm/Resource' }],
      });

    const result = await provider.import(makeInput());

    expect(result).toBeNull();
  });
});
