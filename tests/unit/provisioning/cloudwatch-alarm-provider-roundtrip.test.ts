import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PutMetricAlarmCommand } from '@aws-sdk/client-cloudwatch';

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

const ALARM_NAME = 'myalarm';
const ALARM_ARN = 'arn:aws:cloudwatch:us-east-1:1:alarm:myalarm';
const RESOURCE_TYPE = 'AWS::CloudWatch::Alarm';

/**
 * Mechanical guard for Class 1 (type-discriminator) and Class 2
 * (structurally-incomplete-when-empty) placeholder regressions on the
 * `cdkd drift --revert` round-trip. See docs/provider-development.md
 * § 3b "Read-update round-trip test" and the canonical
 * `sns-topic-provider-roundtrip.test.ts` / `sqs-queue-provider-update.test.ts`.
 *
 * `readCurrentState` always-emits placeholders (`MetricName: ''`,
 * `Statistic: ''`, `Metrics: []`, ...) so the drift comparator can detect
 * a console-side ADD on a key the alarm wasn't templated with. That same
 * snapshot is round-tripped through `update()` by `--revert`. The tests
 * below assert that none of those placeholders reach `PutMetricAlarm` in
 * an AWS-rejection shape.
 */
describe('CloudWatchAlarmProvider read-update round-trip', () => {
  let provider: CloudWatchAlarmProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new CloudWatchAlarmProvider();
  });

  it('Class 1 — metric-style alarm with placeholder Metrics:[] does not route to metric-math branch', async () => {
    // Empty array is TRUTHY in JS. A naive `if (properties['Metrics'])`
    // would have shipped `Metrics: []` to PutMetricAlarm on a metric-style
    // alarm whose observed snapshot carries the always-emit placeholder,
    // mixing the two mutually-exclusive forms and getting rejected by AWS.
    //
    // Mock DescribeAlarms (used by getAlarmArn after PutMetricAlarm):
    mockSend.mockResolvedValue({ MetricAlarms: [{ AlarmArn: ALARM_ARN }] });

    const observed = {
      AlarmName: ALARM_NAME,
      AlarmDescription: 'desc',
      MetricName: 'CPUUtilization',
      Namespace: 'AWS/EC2',
      Statistic: 'Average',
      ComparisonOperator: 'GreaterThanThreshold',
      Threshold: 80,
      EvaluationPeriods: 2,
      Period: 60,
      DatapointsToAlarm: 1,
      ActionsEnabled: true,
      AlarmActions: [],
      OKActions: [],
      InsufficientDataActions: [],
      TreatMissingData: 'notBreaching',
      Unit: '',
      Dimensions: [{ Name: 'InstanceId', Value: 'i-abc' }],
      Metrics: [], // <-- the load-bearing always-emit placeholder
      Tags: [],
    };

    await provider.update('L', ALARM_NAME, RESOURCE_TYPE, observed, observed);

    const putCall = mockSend.mock.calls.find(
      (c) => c[0] instanceof PutMetricAlarmCommand
    );
    expect(putCall).toBeDefined();
    const input = putCall![0].input as Record<string, unknown>;
    // Truthy-gate fix: Metrics:[] must NOT route to the metric-math
    // branch. The simple-metric fields must be present instead.
    expect(input['Metrics']).toBeUndefined();
    expect(input['MetricName']).toBe('CPUUtilization');
    expect(input['Namespace']).toBe('AWS/EC2');
    expect(input['Statistic']).toBe('Average');
  });

  it('Class 2 — empty-string placeholders for MetricName/Namespace/Statistic/Unit/TreatMissingData/AlarmDescription do not reach AWS', async () => {
    // `readCurrentState` emits `'' ` placeholders for several optional
    // string fields. Shipping those verbatim to PutMetricAlarm would be
    // rejected ("MetricName must be at least 1 character", invalid
    // Statistic / Unit enum) or — worse, in the AlarmDescription case —
    // would silently CLEAR an existing description on a no-drift
    // round-trip (silent fail mode). The wire layer must coerce '' →
    // undefined.
    mockSend.mockResolvedValue({ MetricAlarms: [{ AlarmArn: ALARM_ARN }] });

    const observed = {
      AlarmName: ALARM_NAME,
      AlarmDescription: '',
      MetricName: '',
      Namespace: '',
      Statistic: '',
      Unit: '',
      TreatMissingData: '',
      ActionsEnabled: true,
      AlarmActions: [],
      OKActions: [],
      InsufficientDataActions: [],
      Dimensions: [],
      Metrics: [],
      Tags: [],
    };

    await provider.update('L', ALARM_NAME, RESOURCE_TYPE, observed, observed);

    const putCall = mockSend.mock.calls.find(
      (c) => c[0] instanceof PutMetricAlarmCommand
    );
    expect(putCall).toBeDefined();
    const input = putCall![0].input as Record<string, unknown>;
    // Each empty-string placeholder must be omitted (undefined), not
    // shipped as ''.
    expect(input['AlarmDescription']).toBeUndefined();
    expect(input['MetricName']).toBeUndefined();
    expect(input['Namespace']).toBeUndefined();
    expect(input['Statistic']).toBeUndefined();
    expect(input['Unit']).toBeUndefined();
    expect(input['TreatMissingData']).toBeUndefined();
  });

  it('metric-math alarm with non-empty Metrics routes to metric-math branch (truthy-gate fix preserves the original behavior)', async () => {
    // Complement of the Class 1 test: a real metric-math alarm must
    // continue to route into the Metrics branch, and the empty-string
    // placeholders for MetricName / Namespace / Statistic must NOT leak
    // through. The metric-math branch already does NOT set those fields,
    // but we assert it explicitly to lock the behavior.
    mockSend.mockResolvedValue({ MetricAlarms: [{ AlarmArn: ALARM_ARN }] });

    const observed = {
      AlarmName: ALARM_NAME,
      AlarmDescription: '',
      MetricName: '', // placeholder — must NOT reach AWS
      Namespace: '',
      Statistic: '',
      Unit: '',
      TreatMissingData: '',
      ComparisonOperator: 'GreaterThanThreshold',
      Threshold: 1,
      EvaluationPeriods: 1,
      ActionsEnabled: true,
      AlarmActions: [],
      OKActions: [],
      InsufficientDataActions: [],
      Dimensions: [],
      Metrics: [
        {
          Id: 'm1',
          Expression: 'm0 / 60',
          Label: 'rate',
          ReturnData: true,
        },
      ],
      Tags: [],
    };

    await provider.update('L', ALARM_NAME, RESOURCE_TYPE, observed, observed);

    const putCall = mockSend.mock.calls.find(
      (c) => c[0] instanceof PutMetricAlarmCommand
    );
    expect(putCall).toBeDefined();
    const input = putCall![0].input as Record<string, unknown>;
    expect(Array.isArray(input['Metrics'])).toBe(true);
    expect((input['Metrics'] as unknown[]).length).toBe(1);
    // Metric-math branch must not set the simple-metric discriminator
    // fields (mixing the two forms is a PutMetricAlarm validation error).
    expect(input['MetricName']).toBeUndefined();
    expect(input['Namespace']).toBeUndefined();
    expect(input['Statistic']).toBeUndefined();
  });
});
