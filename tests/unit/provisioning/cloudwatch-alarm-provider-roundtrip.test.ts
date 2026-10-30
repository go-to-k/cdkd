import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  PutMetricAlarmCommand,
  TagResourceCommand,
  UntagResourceCommand,
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

const ALARM_NAME = 'myalarm';
const ALARM_ARN = 'arn:aws:cloudwatch:us-east-1:1:alarm:myalarm';
const RESOURCE_TYPE = 'AWS::CloudWatch::Alarm';

/**
 * Mechanical guard for Class 1 (type-discriminator) and Class 2
 * (structurally-incomplete-when-empty) placeholder regressions on the
 * `cdkd drift --revert` round-trip. See docs/provider-rules.md#readcurrentstate-for-drift-detection
 *  "Read-update round-trip test" and the canonical
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

describe('CloudWatchAlarmProvider backfilled props (Tags / ExtendedStatistic / EvaluateLowSampleCountPercentile / ThresholdMetricId)', () => {
  let provider: CloudWatchAlarmProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new CloudWatchAlarmProvider();
  });

  it('create() wires ExtendedStatistic / EvaluateLowSampleCountPercentile / ThresholdMetricId + Tags via the PutMetricAlarm Tags param', async () => {
    // PutMetricAlarm then getAlarmArn's DescribeAlarms both go through send.
    mockSend.mockResolvedValue({ MetricAlarms: [{ AlarmArn: ALARM_ARN }] });

    await provider.create('L', RESOURCE_TYPE, {
      AlarmName: ALARM_NAME,
      ComparisonOperator: 'GreaterThanThreshold',
      EvaluationPeriods: 2,
      Threshold: 80,
      MetricName: 'CPUUtilization',
      Namespace: 'AWS/EC2',
      Period: 300,
      ExtendedStatistic: 'p99',
      EvaluateLowSampleCountPercentile: 'ignore',
      ThresholdMetricId: 'ad1',
      Tags: [{ Key: 'Team', Value: 'Platform' }],
    });

    const putCall = mockSend.mock.calls.find((c) => c[0] instanceof PutMetricAlarmCommand);
    expect(putCall).toBeDefined();
    const input = putCall![0].input as Record<string, unknown>;
    expect(input['ExtendedStatistic']).toBe('p99');
    expect(input['EvaluateLowSampleCountPercentile']).toBe('ignore');
    expect(input['ThresholdMetricId']).toBe('ad1');
    // Tags ride the PutMetricAlarm Tags param on create.
    expect(input['Tags']).toEqual([{ Key: 'Team', Value: 'Platform' }]);
  });

  it('create() omits Tags / extended fields when not templated', async () => {
    mockSend.mockResolvedValue({ MetricAlarms: [{ AlarmArn: ALARM_ARN }] });

    await provider.create('L', RESOURCE_TYPE, {
      AlarmName: ALARM_NAME,
      ComparisonOperator: 'GreaterThanThreshold',
      EvaluationPeriods: 2,
      Threshold: 80,
      MetricName: 'CPUUtilization',
      Namespace: 'AWS/EC2',
      Period: 300,
      Statistic: 'Average',
    });

    const putCall = mockSend.mock.calls.find((c) => c[0] instanceof PutMetricAlarmCommand);
    const input = putCall![0].input as Record<string, unknown>;
    expect(input['Tags']).toBeUndefined();
    expect(input['ExtendedStatistic']).toBeUndefined();
    expect(input['EvaluateLowSampleCountPercentile']).toBeUndefined();
    expect(input['ThresholdMetricId']).toBeUndefined();
  });

  it('update() sends the 3 scalar fields through PutMetricAlarm (NOT the Tags param) and applies a tag diff via TagResource/UntagResource', async () => {
    mockSend.mockResolvedValue({ MetricAlarms: [{ AlarmArn: ALARM_ARN }] });

    const next = {
      AlarmName: ALARM_NAME,
      ComparisonOperator: 'LessThanThreshold',
      EvaluationPeriods: 3,
      Threshold: 5,
      MetricName: 'Errors',
      Namespace: 'My/Ns',
      Period: 60,
      ExtendedStatistic: 'p90',
      EvaluateLowSampleCountPercentile: 'evaluate',
      ThresholdMetricId: 'ad2',
      Tags: [
        { Key: 'Keep', Value: 'v2' },
        { Key: 'Added', Value: 'new' },
      ],
    };
    const prev = {
      ...next,
      ExtendedStatistic: 'p99',
      Tags: [
        { Key: 'Keep', Value: 'v1' },
        { Key: 'Gone', Value: 'old' },
      ],
    };

    await provider.update('L', ALARM_NAME, RESOURCE_TYPE, next, prev);

    const putCall = mockSend.mock.calls.find((c) => c[0] instanceof PutMetricAlarmCommand);
    const input = putCall![0].input as Record<string, unknown>;
    expect(input['ExtendedStatistic']).toBe('p90');
    expect(input['EvaluateLowSampleCountPercentile']).toBe('evaluate');
    expect(input['ThresholdMetricId']).toBe('ad2');
    // On update, tags are managed by the tag-diff APIs, NOT the PutMetricAlarm Tags param.
    expect(input['Tags']).toBeUndefined();

    // Untag the removed key, tag the added/changed keys.
    const untag = mockSend.mock.calls.find((c) => c[0] instanceof UntagResourceCommand);
    expect(untag![0].input).toEqual({ ResourceARN: ALARM_ARN, TagKeys: ['Gone'] });
    const tag = mockSend.mock.calls.find((c) => c[0] instanceof TagResourceCommand);
    expect(tag![0].input).toEqual({
      ResourceARN: ALARM_ARN,
      Tags: [
        { Key: 'Keep', Value: 'v2' },
        { Key: 'Added', Value: 'new' },
      ],
    });
  });
});

describe('CloudWatchAlarmProvider ActionConfiguration / WarmUpConfiguration (go-to-k/cdkd#2762)', () => {
  let provider: CloudWatchAlarmProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new CloudWatchAlarmProvider();
  });

  const BASE = {
    AlarmName: ALARM_NAME,
    ComparisonOperator: 'GreaterThanThreshold',
    EvaluationPeriods: 1,
    Threshold: 1,
    MetricName: 'Errors',
    Namespace: 'My/Ns',
    Period: 60,
    Statistic: 'Sum',
  };
  const WARM_UP = { WarmUpPeriodDurationInMinutes: 15, OnlyStartEvaluatingAfterWarmUpPeriodEnds: true };
  const ACTION_CONFIG = {
    AlarmTagsPropagation: { Enabled: true, IncludedTagKeys: ['Team'] },
  };

  const putInput = (): Record<string, unknown> => {
    const putCall = mockSend.mock.calls.find((c) => c[0] instanceof PutMetricAlarmCommand);
    expect(putCall).toBeDefined();
    return putCall![0].input as Record<string, unknown>;
  };

  it('create() sends both through PutMetricAlarm as declared', async () => {
    mockSend.mockResolvedValue({ MetricAlarms: [{ AlarmArn: ALARM_ARN }] });

    await provider.create('L', RESOURCE_TYPE, {
      ...BASE,
      WarmUpConfiguration: WARM_UP,
      ActionConfiguration: ACTION_CONFIG,
    });

    const input = putInput();
    expect(input['WarmUpConfiguration']).toEqual(WARM_UP);
    expect(input['ActionConfiguration']).toEqual(ACTION_CONFIG);
  });

  it('create() omits both when the template declares neither', async () => {
    mockSend.mockResolvedValue({ MetricAlarms: [{ AlarmArn: ALARM_ARN }] });

    await provider.create('L', RESOURCE_TYPE, BASE);

    const input = putInput();
    expect(input['WarmUpConfiguration']).toBeUndefined();
    expect(input['ActionConfiguration']).toBeUndefined();
  });

  it('update() sends a changed value, and a removal as an absent member (PutMetricAlarm replaces the whole configuration)', async () => {
    mockSend.mockResolvedValue({ MetricAlarms: [{ AlarmArn: ALARM_ARN }] });
    const changedWarmUp = { WarmUpPeriodDurationInMinutes: 30 };

    await provider.update(
      'L',
      ALARM_NAME,
      RESOURCE_TYPE,
      { ...BASE, WarmUpConfiguration: changedWarmUp },
      { ...BASE, WarmUpConfiguration: WARM_UP, ActionConfiguration: ACTION_CONFIG }
    );

    const input = putInput();
    expect(input['WarmUpConfiguration']).toEqual(changedWarmUp);
    expect(input['ActionConfiguration']).toBeUndefined();
  });

  it('a readCurrentState snapshot round-trips through update() unchanged', async () => {
    mockSend.mockResolvedValueOnce({
      MetricAlarms: [
        {
          ...BASE,
          AlarmArn: ALARM_ARN,
          WarmUpConfiguration: WARM_UP,
          ActionConfiguration: ACTION_CONFIG,
        },
      ],
    });
    mockSend.mockResolvedValueOnce({ Tags: [] });
    const observed = (await provider.readCurrentState(ALARM_NAME, 'L', RESOURCE_TYPE)) as Record<
      string,
      unknown
    >;

    mockSend.mockReset();
    mockSend.mockResolvedValue({ MetricAlarms: [{ AlarmArn: ALARM_ARN }] });
    await provider.update('L', ALARM_NAME, RESOURCE_TYPE, observed, observed);

    const input = putInput();
    expect(input['WarmUpConfiguration']).toEqual(WARM_UP);
    expect(input['ActionConfiguration']).toEqual(ACTION_CONFIG);
  });
});

describe('CloudWatchAlarmProvider EvaluationWindow / EvaluationCriteria / EvaluationInterval (go-to-k/cdkd#5524)', () => {
  let provider: CloudWatchAlarmProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new CloudWatchAlarmProvider();
  });

  const METRIC = {
    AlarmName: ALARM_NAME,
    ComparisonOperator: 'GreaterThanThreshold',
    EvaluationPeriods: 1,
    Threshold: 1,
    MetricName: 'Errors',
    Namespace: 'My/Ns',
    Period: 300,
    Statistic: 'Sum',
  };
  const WALL_CLOCK = { WallClockWindow: { Timezone: 'UTC' } };
  const CRITERIA = {
    PromQLCriteria: { Query: 'avg(up) < 1', PendingPeriod: 60, RecoveryPeriod: 120 },
  };
  const PROMQL = { AlarmName: ALARM_NAME, EvaluationCriteria: CRITERIA, EvaluationInterval: 60 };
  /** Every PutMetricAlarm member AWS refuses beside EvaluationCriteria. */
  const METRIC_MEMBERS = [
    'Namespace',
    'MetricName',
    'Dimensions',
    'Period',
    'Unit',
    'Statistic',
    'ExtendedStatistic',
    'Metrics',
    'Threshold',
    'ComparisonOperator',
    'ThresholdMetricId',
    'EvaluationPeriods',
    'DatapointsToAlarm',
    'EvaluationWindow',
  ];

  const putInput = (): Record<string, unknown> => {
    const putCall = mockSend.mock.calls.find((c) => c[0] instanceof PutMetricAlarmCommand);
    expect(putCall).toBeDefined();
    return putCall![0].input as Record<string, unknown>;
  };

  it('PREMISE: the three are handled, so a template declaring them stays on the SDK route', () => {
    const handled = provider.handledProperties.get(RESOURCE_TYPE)!;
    expect(handled.has('EvaluationWindow')).toBe(true);
    expect(handled.has('EvaluationCriteria')).toBe(true);
    expect(handled.has('EvaluationInterval')).toBe(true);
  });

  it('create() sends EvaluationWindow as declared, both union members', async () => {
    mockSend.mockResolvedValue({ MetricAlarms: [{ AlarmArn: ALARM_ARN }] });
    await provider.create('L', RESOURCE_TYPE, { ...METRIC, EvaluationWindow: WALL_CLOCK });
    expect(putInput()['EvaluationWindow']).toEqual(WALL_CLOCK);

    mockSend.mockClear();
    await provider.create('L', RESOURCE_TYPE, { ...METRIC, EvaluationWindow: { SlidingWindow: {} } });
    expect(putInput()['EvaluationWindow']).toEqual({ SlidingWindow: {} });
  });

  it('create() sends a PromQL alarm with EvaluationCriteria + EvaluationInterval and no metric member', async () => {
    mockSend.mockResolvedValue({ MetricAlarms: [{ AlarmArn: ALARM_ARN }] });
    await provider.create('L', RESOURCE_TYPE, PROMQL);
    const input = putInput();
    expect(input['EvaluationCriteria']).toEqual(CRITERIA);
    expect(input['EvaluationInterval']).toBe(60);
    for (const member of METRIC_MEMBERS) expect(input[member]).toBeUndefined();
  });

  it('update() sends a change as declared, and a removal as an absent member (PutMetricAlarm replaces the whole configuration)', async () => {
    // The removal half alone would pass with no wiring at all; the change
    // half beside it is what makes the pair fail when the member is unwired.
    mockSend.mockResolvedValue({ MetricAlarms: [{ AlarmArn: ALARM_ARN }] });
    await provider.update('L', ALARM_NAME, RESOURCE_TYPE, { ...METRIC, EvaluationWindow: WALL_CLOCK }, METRIC);
    expect(putInput()['EvaluationWindow']).toEqual(WALL_CLOCK);

    mockSend.mockClear();
    await provider.update('L', ALARM_NAME, RESOURCE_TYPE, METRIC, {
      ...METRIC,
      EvaluationWindow: WALL_CLOCK,
    });
    expect(putInput()['EvaluationWindow']).toBeUndefined();
  });

  it('drops an EMPTY Dimensions beside EvaluationCriteria, which AWS refuses', async () => {
    mockSend.mockResolvedValue({ MetricAlarms: [{ AlarmArn: ALARM_ARN }] });
    await provider.update('L', ALARM_NAME, RESOURCE_TYPE, { ...PROMQL, Dimensions: [] }, PROMQL);
    expect(putInput()).not.toHaveProperty('Dimensions');
  });

  it('NEGATIVE CONTROL: keeps an empty Dimensions on a metric alarm, and a non-empty one beside EvaluationCriteria', async () => {
    mockSend.mockResolvedValue({ MetricAlarms: [{ AlarmArn: ALARM_ARN }] });
    await provider.update('L', ALARM_NAME, RESOURCE_TYPE, { ...METRIC, Dimensions: [] }, METRIC);
    expect(putInput()['Dimensions']).toEqual([]);

    // A declared dimension beside PromQL is a template error: it reaches AWS
    // to be refused as CloudFormation would, rather than being dropped.
    mockSend.mockClear();
    const dims = [{ Name: 'n', Value: 'v' }];
    await provider.update('L', ALARM_NAME, RESOURCE_TYPE, { ...PROMQL, Dimensions: dims }, PROMQL);
    expect(putInput()['Dimensions']).toEqual(dims);
  });

  it('a PromQL readCurrentState snapshot round-trips through update() with no metric member', async () => {
    // AWS's answer for a PromQL alarm, including members it might report at a
    // default: none of them may reach PutMetricAlarm beside the criteria.
    mockSend.mockResolvedValueOnce({
      MetricAlarms: [
        {
          AlarmName: ALARM_NAME,
          AlarmArn: ALARM_ARN,
          EvaluationCriteria: CRITERIA,
          EvaluationInterval: 60,
          EvaluationPeriods: 1,
          Period: 60,
          Dimensions: [],
          // Not the default: the PromQL guard, not the default-window rule,
          // must be what keeps it out.
          EvaluationWindow: WALL_CLOCK,
          ExtendedStatistic: 'p99',
          ThresholdMetricId: 'm1',
        },
      ],
    });
    mockSend.mockResolvedValueOnce({ Tags: [] });
    const observed = (await provider.readCurrentState(ALARM_NAME, 'L', RESOURCE_TYPE)) as Record<
      string,
      unknown
    >;
    for (const member of METRIC_MEMBERS) expect(observed).not.toHaveProperty(member);
    expect(observed['EvaluationCriteria']).toEqual(CRITERIA);
    expect(observed['EvaluationInterval']).toBe(60);

    mockSend.mockReset();
    mockSend.mockResolvedValue({ MetricAlarms: [{ AlarmArn: ALARM_ARN }] });
    await provider.update('L', ALARM_NAME, RESOURCE_TYPE, observed, observed);

    const input = putInput();
    for (const member of METRIC_MEMBERS) expect(input[member]).toBeUndefined();
    expect(input['EvaluationCriteria']).toEqual(CRITERIA);
    expect(input['EvaluationInterval']).toBe(60);
  });

  it('a metric-alarm readCurrentState snapshot round-trips its EvaluationWindow unchanged', async () => {
    mockSend.mockResolvedValueOnce({
      // EvaluationInterval: a value AWS might report on a metric alarm, which
      // PutMetricAlarm refuses beside MetricName.
      MetricAlarms: [
        { ...METRIC, AlarmArn: ALARM_ARN, EvaluationWindow: WALL_CLOCK, EvaluationInterval: 300 },
      ],
    });
    mockSend.mockResolvedValueOnce({ Tags: [] });
    const observed = (await provider.readCurrentState(ALARM_NAME, 'L', RESOURCE_TYPE)) as Record<
      string,
      unknown
    >;
    expect(observed['EvaluationWindow']).toEqual(WALL_CLOCK);
    expect(observed).not.toHaveProperty('EvaluationInterval');

    mockSend.mockReset();
    mockSend.mockResolvedValue({ MetricAlarms: [{ AlarmArn: ALARM_ARN }] });
    await provider.update('L', ALARM_NAME, RESOURCE_TYPE, observed, observed);
    expect(putInput()['EvaluationWindow']).toEqual(WALL_CLOCK);
    expect(putInput()['EvaluationInterval']).toBeUndefined();
  });

  describe('the default window does not read as drift', () => {
    const readWindow = async (window: unknown): Promise<Record<string, unknown>> => {
      mockSend.mockResolvedValueOnce({
        MetricAlarms: [{ ...METRIC, AlarmArn: ALARM_ARN, EvaluationWindow: window }],
      });
      mockSend.mockResolvedValueOnce({ Tags: [] });
      return (await provider.readCurrentState(ALARM_NAME, 'L', RESOURCE_TYPE)) as Record<
        string,
        unknown
      >;
    };

    it('omits the default `SlidingWindow: {}` from the readback, and only that', async () => {
      expect(await readWindow({ SlidingWindow: {} })).not.toHaveProperty('EvaluationWindow');
      for (const window of [
        WALL_CLOCK,
        { SlidingWindow: { X: 1 } },
        { SlidingWindow: {}, WallClockWindow: {} },
        { SlidingWindow: [] },
      ]) {
        expect((await readWindow(window))['EvaluationWindow']).toEqual(window);
      }
    });

    const PROMQL_PAIR = ['EvaluationCriteria', 'EvaluationInterval'];

    it('keeps EvaluationWindow and the PromQL pair compared on a metric alarm on the default', () => {
      expect(provider.getDriftAbsentMeansDefaultKeys(RESOURCE_TYPE, METRIC)).toEqual([
        ...PROMQL_PAIR,
        'EvaluationWindow',
      ]);
      expect(
        provider.getDriftAbsentMeansDefaultKeys(RESOURCE_TYPE, {
          ...METRIC,
          EvaluationWindow: { SlidingWindow: {} },
        })
      ).toEqual([...PROMQL_PAIR, 'EvaluationWindow']);
    });

    it('names every metric member and the window for a PromQL template, so a console switch to the metric form is reverted', () => {
      expect([...provider.getDriftAbsentMeansDefaultKeys(RESOURCE_TYPE, PROMQL)].sort()).toEqual(
        [...METRIC_MEMBERS].sort()
      );
      // A member the template declares beside the criteria is not on its
      // default, so it is not named.
      expect(
        provider.getDriftAbsentMeansDefaultKeys(RESOURCE_TYPE, { ...PROMQL, Period: 60 })
      ).not.toContain('Period');
    });

    it('drops a baseline default window the readback omits, and nothing else', async () => {
      const declared = { ...METRIC, EvaluationWindow: { SlidingWindow: {} } };
      const aws = { ...METRIC };
      const paired = await provider.canonicalizeDriftPair(RESOURCE_TYPE, declared, aws);
      expect(paired.baseline).toEqual(METRIC);
      expect(paired.aws).toBe(aws);
      expect(declared.EvaluationWindow).toEqual({ SlidingWindow: {} });

      for (const [b, a] of [
        [{ ...METRIC, EvaluationWindow: WALL_CLOCK }, aws],
        [declared, { ...METRIC, EvaluationWindow: WALL_CLOCK }],
        [METRIC, aws],
      ] as const) {
        const out = await provider.canonicalizeDriftPair(RESOURCE_TYPE, b, a);
        expect(out.baseline).toBe(b);
        expect(out.aws).toBe(a);
      }
      const other = await provider.canonicalizeDriftPair('AWS::Other::Type', declared, aws);
      expect(other.baseline).toBe(declared);
    });

    it('names only the PromQL pair for a declared wall-clock window, nothing for another type', () => {
      expect(
        provider.getDriftAbsentMeansDefaultKeys(RESOURCE_TYPE, {
          ...METRIC,
          EvaluationWindow: WALL_CLOCK,
        })
      ).toEqual(PROMQL_PAIR);
      expect(provider.getDriftAbsentMeansDefaultKeys('AWS::Other::Type', PROMQL)).toEqual([]);
      expect(provider.getDriftAbsentMeansDefaultKeys('AWS::Other::Type', METRIC)).toEqual([]);
    });
  });
});
