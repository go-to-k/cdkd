import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

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

  // Issue #1091 batch 2: the tag walk is an N+1 ListTagsForResource burst
  // routed through the shared importTagWalk helper — a throttled per-candidate
  // tag read is retried with backoff instead of aborting the whole import,
  // while a non-throttling error still surfaces immediately.
  it('retries a throttled ListTagsForResource mid-walk and still finds the match', async () => {
    mockSend.mockReset(); // drop once-queued leftovers from earlier tests
    const throttled = new Error('Rate exceeded') as Error & {
      $metadata: { httpStatusCode: number };
    };
    throttled.name = 'ThrottlingException';
    throttled.$metadata = { httpStatusCode: 400 };

    mockSend
      .mockResolvedValueOnce({
        MetricAlarms: [
          {
            AlarmName: 'my-alarm',
            AlarmArn: 'arn:aws:cloudwatch:us-east-1:123456789012:alarm:my-alarm',
          },
        ],
      })
      .mockRejectedValueOnce(throttled)
      .mockResolvedValueOnce({
        Tags: [{ Key: 'aws:cdk:path', Value: 'MyStack/MyAlarm/Resource' }],
      });

    const result = await provider.import(makeInput());

    expect(result).toEqual({ physicalId: 'my-alarm', attributes: {} });
    expect(mockSend).toHaveBeenCalledTimes(3);
  });

  it('does not retry a non-throttling ListTagsForResource error during the walk', async () => {
    mockSend.mockReset(); // drop once-queued leftovers from earlier tests
    const denied = new Error('User is not authorized to perform cloudwatch:ListTagsForResource');
    denied.name = 'AccessDeniedException';

    mockSend
      .mockResolvedValueOnce({
        MetricAlarms: [
          {
            AlarmName: 'my-alarm',
            AlarmArn: 'arn:aws:cloudwatch:us-east-1:123456789012:alarm:my-alarm',
          },
        ],
      })
      .mockRejectedValueOnce(denied);

    await expect(provider.import(makeInput())).rejects.toThrow(/not authorized/);
    expect(mockSend).toHaveBeenCalledTimes(2);
  });
});
