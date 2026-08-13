import { describe, it, expect, vi, beforeEach, afterAll } from 'vite-plus/test';

const mockSend = vi.hoisted(() => vi.fn());

// Mutable so a test can drive the client's region, and reject outright to
// exercise the wildcard-region arm (issue #1815 partition derivation).
// Reset in `beforeEach`.
const clientRegion = vi.hoisted(() => ({
  value: 'us-east-1' as string | undefined,
  reject: false,
}));

vi.mock('../../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    cloudWatch: {
      send: mockSend,
      config: {
        region: () =>
          clientRegion.reject
            ? Promise.reject(new Error('no region configured'))
            : Promise.resolve(clientRegion.value),
      },
    },
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
    clientRegion.value = 'us-east-1';
    clientRegion.reject = false;
    delete process.env['AWS_REGION'];
    provider = new CloudWatchAlarmProvider();
  });

  function makeInput(
    overrides: Partial<{
      knownPhysicalId: string;
      properties: Record<string, unknown>;
    }> = {}
  ) {
    return {
      logicalId: 'MyAlarm',
      resourceType: 'AWS::CloudWatch::Alarm',
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

// Issue #1815: `getAlarmArn`'s construct-from-config fallback hardcoded
// `arn:aws:`. AWS's own `DescribeAlarms` answer is authoritative and always
// carries the right partition, so this only bites when that read fails —
// exactly when the fabricated ARN is recorded into state unchallenged.
describe('CloudWatchAlarmProvider ARN fallback partition (issue #1815)', () => {
  let provider: CloudWatchAlarmProvider;
  const originalAwsRegion = process.env['AWS_REGION'];

  afterAll(() => {
    if (originalAwsRegion === undefined) delete process.env['AWS_REGION'];
    else process.env['AWS_REGION'] = originalAwsRegion;
  });

  beforeEach(() => {
    vi.clearAllMocks();
    clientRegion.value = 'us-east-1';
    clientRegion.reject = false;
    delete process.env['AWS_REGION'];
    provider = new CloudWatchAlarmProvider();
  });

  /** Drives create() with PutMetricAlarm ok + DescribeAlarms failing. */
  async function createWithFailedDescribe(): Promise<unknown> {
    mockSend.mockResolvedValueOnce({}); // PutMetricAlarm
    mockSend.mockRejectedValueOnce(new Error('DescribeAlarms unavailable'));
    const result = await provider.create('MyAlarm', 'AWS::CloudWatch::Alarm', {
      AlarmName: 'my-alarm',
      ComparisonOperator: 'GreaterThanThreshold',
      EvaluationPeriods: 1,
    });
    return result.attributes?.['Arn'];
  }

  it('uses the aws-cn partition for a cn- region', async () => {
    clientRegion.value = 'cn-north-1';
    expect(await createWithFailedDescribe()).toBe('arn:aws-cn:cloudwatch:cn-north-1:*:alarm:my-alarm');
  });

  it('uses the aws-us-gov partition for a us-gov- region', async () => {
    clientRegion.value = 'us-gov-west-1';
    expect(await createWithFailedDescribe()).toBe(
      'arn:aws-us-gov:cloudwatch:us-gov-west-1:*:alarm:my-alarm'
    );
  });

  // The safety half of the pair: without a non-commercial account to test
  // against, "commercial output is unchanged byte for byte" is what makes the
  // change provably non-breaking.
  it('leaves a commercial region byte-identical to the pre-fix output', async () => {
    clientRegion.value = 'ap-northeast-1';
    expect(await createWithFailedDescribe()).toBe(
      'arn:aws:cloudwatch:ap-northeast-1:*:alarm:my-alarm'
    );
  });

  // The wildcard-region arm: `config.region()` itself threw, so there is no
  // region for the region SEGMENT (hence the pre-existing `*`). The partition
  // still takes AWS_REGION rather than guessing commercial.
  it('derives the wildcard-region ARN partition from AWS_REGION', async () => {
    clientRegion.reject = true;
    process.env['AWS_REGION'] = 'cn-northwest-1';
    expect(await createWithFailedDescribe()).toBe('arn:aws-cn:cloudwatch:*:*:alarm:my-alarm');
  });

  it('keeps the commercial wildcard-region ARN when AWS_REGION is unset', async () => {
    clientRegion.reject = true;
    expect(await createWithFailedDescribe()).toBe('arn:aws:cloudwatch:*:*:alarm:my-alarm');
  });
});
