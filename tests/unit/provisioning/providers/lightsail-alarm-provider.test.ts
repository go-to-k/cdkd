import { describe, expect, it, vi, beforeEach } from 'vite-plus/test';
import {
  PutAlarmCommand,
  GetAlarmsCommand,
  DeleteAlarmCommand,
  NotFoundException,
  type LightsailClient,
} from '@aws-sdk/client-lightsail';
import {
  LightsailAlarmProvider,
  LightsailTokenBucket,
} from '../../../../src/provisioning/providers/lightsail-alarm-provider.js';
import { RESOURCE_NOT_FOUND } from '../../../../src/types/resource.js';
import { isMarkedNonRetryable } from '../../../../src/deployment/retryable-errors.js';

/** go-to-k/cdkd#6830: the Lightsail alarm SDK provider. */

const ALARM = {
  name: 'my-alarm',
  arn: 'arn:aws:lightsail:us-east-1:123456789012:Alarm/0b1c',
  state: 'OK',
  monitoredResourceInfo: { name: 'my-instance' },
  metricName: 'CPUUtilization',
  comparisonOperator: 'GreaterThanOrEqualToThreshold',
  evaluationPeriods: 1,
  threshold: 90,
  datapointsToAlarm: 1,
  treatMissingData: 'missing',
  contactProtocols: [],
  notificationTriggers: ['ALARM'],
  notificationEnabled: true,
};

const PROPS = {
  AlarmName: 'my-alarm',
  MonitoredResourceName: 'my-instance',
  MetricName: 'CPUUtilization',
  ComparisonOperator: 'GreaterThanOrEqualToThreshold',
  EvaluationPeriods: 1,
  Threshold: 90,
};

function throttle(): Error {
  return Object.assign(new Error('The maximum API request rate has been exceeded'), {
    name: 'ThrottlingException',
    $metadata: { httpStatusCode: 403 },
  });
}

function notFound(): NotFoundException {
  return new NotFoundException({ message: 'missing', $metadata: {} });
}

function setup() {
  const send = vi.fn();
  const client = { send, config: { region: async () => 'us-east-1' } } as unknown as LightsailClient;
  const provider = new LightsailAlarmProvider();
  vi.spyOn(provider, 'getClient').mockReturnValue(client);
  const takeToken = vi.fn(async () => {});
  provider.takeToken = takeToken;
  provider.throttleSleep = async () => {};
  return { provider, send, takeToken };
}

describe('LightsailAlarmProvider', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('creates with PutAlarm and records the alarm ARN and state', async () => {
    const { provider, send, takeToken } = setup();
    send.mockResolvedValueOnce({}).mockResolvedValueOnce({ alarms: [ALARM] });

    const result = await provider.create('Alarm', 'AWS::Lightsail::Alarm', {
      ...PROPS,
      DatapointsToAlarm: 1,
      NotificationEnabled: 'false',
      NotificationTriggers: ['ALARM', 'OK'],
    });

    expect(result).toEqual({
      physicalId: 'my-alarm',
      attributes: { AlarmArn: ALARM.arn, State: 'OK' },
    });
    const put = send.mock.calls[0]![0] as PutAlarmCommand;
    expect(put).toBeInstanceOf(PutAlarmCommand);
    expect(put.input).toEqual({
      alarmName: 'my-alarm',
      monitoredResourceName: 'my-instance',
      metricName: 'CPUUtilization',
      comparisonOperator: 'GreaterThanOrEqualToThreshold',
      evaluationPeriods: 1,
      threshold: 90,
      datapointsToAlarm: 1,
      notificationEnabled: false,
      notificationTriggers: ['ALARM', 'OK'],
    });
    expect(send.mock.calls[1]![0]).toBeInstanceOf(GetAlarmsCommand);
    expect(takeToken.mock.calls).toEqual([
      ['us-east-1', 'PutAlarm'],
      ['us-east-1', 'GetAlarms'],
    ]);
  });

  it('retries a throttled PutAlarm, taking a token for every attempt', async () => {
    const { provider, send, takeToken } = setup();
    send
      .mockRejectedValueOnce(throttle())
      .mockRejectedValueOnce(throttle())
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ alarms: [ALARM] });

    await provider.create('Alarm', 'AWS::Lightsail::Alarm', PROPS);

    expect(send).toHaveBeenCalledTimes(4);
    expect(takeToken.mock.calls.filter((call) => (call as unknown[])[1] === 'PutAlarm')).toHaveLength(3);
  });

  it('fails the create once the throttle budget is spent', async () => {
    const { provider, send } = setup();
    provider.throttleDelaysMs = [1, 1];
    send.mockRejectedValue(throttle());

    await expect(provider.create('Alarm', 'AWS::Lightsail::Alarm', PROPS)).rejects.toThrow(
      /Failed to create Lightsail alarm Alarm/
    );
    expect(send).toHaveBeenCalledTimes(3);
  });

  it('does not fail a create whose read-back fails: the alarm exists', async () => {
    const { provider, send } = setup();
    provider.throttleDelaysMs = [];
    send.mockResolvedValueOnce({}).mockRejectedValueOnce(throttle());

    await expect(provider.create('Alarm', 'AWS::Lightsail::Alarm', PROPS)).resolves.toEqual({
      physicalId: 'my-alarm',
      attributes: {},
    });
  });

  it('refuses an unreadable NotificationEnabled before any call', async () => {
    const { provider, send } = setup();
    const error = await provider
      .create('Alarm', 'AWS::Lightsail::Alarm', { ...PROPS, NotificationEnabled: 'yes' })
      .catch((e: unknown) => e);
    expect(String(error)).toMatch(/NotificationEnabled must be true or false/);
    expect(isMarkedNonRetryable(error)).toBe(true);
    expect(send).not.toHaveBeenCalled();
  });

  it('updates with PutAlarm on the recorded name', async () => {
    const { provider, send } = setup();
    send.mockResolvedValueOnce({}).mockResolvedValueOnce({ alarms: [ALARM] });

    const result = await provider.update(
      'Alarm',
      'my-alarm',
      'AWS::Lightsail::Alarm',
      { ...PROPS, Threshold: 95 },
      PROPS
    );

    expect(result).toMatchObject({ physicalId: 'my-alarm', wasReplaced: false });
    expect((send.mock.calls[0]![0] as PutAlarmCommand).input).toMatchObject({
      alarmName: 'my-alarm',
      threshold: 95,
    });
  });

  it('deletes with DeleteAlarm, retrying a throttle', async () => {
    const { provider, send } = setup();
    send.mockRejectedValueOnce(throttle()).mockResolvedValueOnce({});

    await provider.delete('Alarm', 'my-alarm', 'AWS::Lightsail::Alarm');

    expect(send).toHaveBeenCalledTimes(2);
    const del = send.mock.calls[1]![0] as DeleteAlarmCommand;
    expect(del).toBeInstanceOf(DeleteAlarmCommand);
    expect(del.input).toEqual({ alarmName: 'my-alarm' });
  });

  it('treats a not-found delete as done', async () => {
    const { provider, send } = setup();
    send.mockRejectedValueOnce(notFound());
    await expect(provider.delete('Alarm', 'my-alarm', 'AWS::Lightsail::Alarm')).resolves.toBeUndefined();
  });

  it('refuses a not-found delete from another region than the record', async () => {
    const { provider, send } = setup();
    send.mockRejectedValueOnce(notFound());
    await expect(
      provider.delete('Alarm', 'my-alarm', 'AWS::Lightsail::Alarm', undefined, {
        expectedRegion: 'eu-west-1',
      })
    ).rejects.toThrow();
  });

  it('import verifies the explicit name, and answers null when it is free', async () => {
    const { provider, send } = setup();
    send.mockResolvedValueOnce({ alarms: [ALARM] }).mockRejectedValueOnce(notFound());
    const input = {
      logicalId: 'Alarm',
      resourceType: 'AWS::Lightsail::Alarm',
      stackName: 'S',
      region: 'us-east-1',
      properties: PROPS,
    };

    await expect(provider.import(input)).resolves.toEqual({
      physicalId: 'my-alarm',
      attributes: { AlarmArn: ALARM.arn, State: 'OK' },
    });
    await expect(provider.import(input)).resolves.toBeNull();
    expect((send.mock.calls[0]![0] as GetAlarmsCommand).input).toEqual({ alarmName: 'my-alarm' });
  });

  it('readCurrentState maps the alarm back to CloudFormation keys', async () => {
    const { provider, send } = setup();
    send.mockResolvedValueOnce({ alarms: [ALARM] }).mockRejectedValueOnce(notFound());

    await expect(
      provider.readCurrentState('my-alarm', 'Alarm', 'AWS::Lightsail::Alarm')
    ).resolves.toEqual({
      AlarmName: 'my-alarm',
      MonitoredResourceName: 'my-instance',
      MetricName: 'CPUUtilization',
      ComparisonOperator: 'GreaterThanOrEqualToThreshold',
      EvaluationPeriods: 1,
      Threshold: 90,
      DatapointsToAlarm: 1,
      TreatMissingData: 'missing',
      ContactProtocols: [],
      NotificationTriggers: ['ALARM'],
      NotificationEnabled: true,
    });
    await expect(
      provider.readCurrentState('my-alarm', 'Alarm', 'AWS::Lightsail::Alarm')
    ).resolves.toBe(RESOURCE_NOT_FOUND);
  });
});

describe('LightsailTokenBucket', () => {
  it('lets a burst of `size` through, then one per refill interval', async () => {
    let now = 0;
    const slept: number[] = [];
    const bucket = new LightsailTokenBucket(
      2,
      1,
      () => now,
      async (ms) => {
        slept.push(ms);
        now += ms;
      }
    );

    for (let i = 0; i < 5; i++) await bucket.take();

    // Two from the full bucket, then three that each wait one refill.
    expect(slept).toEqual([1000, 1000, 1000]);
    expect(now).toBe(3000);
  });
});
