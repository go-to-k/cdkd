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
import { DescribeAlarmsCommand } from '@aws-sdk/client-cloudwatch';

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

  it('returns null without any AWS call when no override is supplied (no aws:cdk:path tag walk)', async () => {
    // The aws:cdk:path tag walk is gone (issue #1134): AWS rejects
    // aws:-prefixed tag writes, so the tag never exists on a real resource.
    // With no explicit override the provider resolves nothing and returns
    // null immediately — the import flow relies on --resource / CFn lookup.
    const result = await provider.import(makeInput());
    expect(result).toBeNull();
    expect(mockSend).not.toHaveBeenCalled();
  });
});
