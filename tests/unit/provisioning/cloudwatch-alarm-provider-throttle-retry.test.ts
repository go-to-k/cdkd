import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';

const mockSend = vi.hoisted(() => vi.fn());

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    cloudWatch: {
      send: mockSend,
      config: { region: () => Promise.resolve('us-east-1') },
    },
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
import {
  DeleteAlarmsCommand,
  DescribeAlarmsCommand,
  PutMetricAlarmCommand,
} from '@aws-sdk/client-cloudwatch';
import { ProvisioningError } from '../../../src/utils/error-handler.js';

const TYPE = 'AWS::CloudWatch::Alarm';
const ARN = 'arn:aws:cloudwatch:us-east-1:123456789012:alarm:alarm-1';
const PROPS = {
  AlarmName: 'alarm-1',
  ComparisonOperator: 'GreaterThanThreshold',
  EvaluationPeriods: 1,
  Threshold: 1,
  MetricName: 'M',
  Namespace: 'N',
  Period: 60,
  Statistic: 'Average',
};

/** CloudWatch's throttle as the SDK raises it: name `Throttling`, HTTP 400. */
function throttle(): Error {
  const error = new Error('Rate exceeded');
  error.name = 'Throttling';
  (error as { $metadata?: unknown }).$metadata = { httpStatusCode: 400 };
  return error;
}

function denied(): Error {
  const error = new Error('User is not authorized to perform this action');
  error.name = 'AccessDenied';
  return error;
}

type Outcome = Error | 'ok';

/**
 * Drives the client by command class: the alarm write (`PutMetricAlarm` or
 * `DeleteAlarms`) answers from `writes` in order, and `DescribeAlarms` (the
 * ARN read-back on create / update) answers with {@link ARN}.
 */
function scriptWrites(writes: Outcome[]): void {
  mockSend.mockImplementation((command: unknown) => {
    if (command instanceof DescribeAlarmsCommand) {
      return Promise.resolve({ MetricAlarms: [{ AlarmArn: ARN }] });
    }
    const next = writes.shift() ?? 'ok';
    return next === 'ok' ? Promise.resolve({}) : Promise.reject(next);
  });
}

function writeCalls(kind: typeof PutMetricAlarmCommand | typeof DeleteAlarmsCommand): unknown[] {
  return mockSend.mock.calls.map((call) => call[0]).filter((command) => command instanceof kind);
}

/** The three entry points sharing the throttle retry, each with its alarm write. */
const ENTRY_POINTS = [
  {
    name: 'create',
    write: PutMetricAlarmCommand,
    verb: 'create',
    run: (p: CloudWatchAlarmProvider) => p.create('Alarm1', TYPE, PROPS),
  },
  {
    name: 'update',
    write: PutMetricAlarmCommand,
    verb: 'update',
    run: (p: CloudWatchAlarmProvider) => p.update('Alarm1', 'alarm-1', TYPE, PROPS, PROPS),
  },
  {
    name: 'delete',
    write: DeleteAlarmsCommand,
    verb: 'delete',
    run: (p: CloudWatchAlarmProvider) => p.delete('Alarm1', 'alarm-1', TYPE),
  },
] as const;

describe('CloudWatchAlarmProvider throttle retry (go-to-k/cdkd#4774, #4781)', () => {
  let provider: CloudWatchAlarmProvider;
  let sleeps: number[];

  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockReset();
    provider = new CloudWatchAlarmProvider();
    sleeps = [];
    provider.throttleSleep = (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe.each(ENTRY_POINTS)('$name', ({ write, verb, run }) => {
    it('retries a throttled alarm write until it succeeds', async () => {
      provider.throttleJitter = () => 0;
      scriptWrites([throttle(), throttle(), 'ok']);

      await run(provider);

      expect(writeCalls(write)).toHaveLength(3);
      // Jitter 0 takes the floor of each window: half the ceiling.
      expect(sleeps).toEqual([500, 1_000]);
    });

    it('gives up after the budget and throws the throttle wrapped, cause kept', async () => {
      provider.throttleDelaysMs = [10, 20, 40];
      const last = throttle();
      scriptWrites([throttle(), throttle(), throttle(), last]);

      const failure = await run(provider).catch((e: unknown) => e);

      expect(writeCalls(write)).toHaveLength(4);
      expect(sleeps).toHaveLength(3);
      expect(failure).toBeInstanceOf(ProvisioningError);
      expect((failure as Error).message).toBe(
        `Failed to ${verb} CloudWatch alarm Alarm1: Rate exceeded`
      );
      expect((failure as Error).cause).toBe(last);
    });

    it('does not retry a failure that is not a throttle', async () => {
      const refusal = denied();
      scriptWrites([refusal]);

      const failure = await run(provider).catch((e: unknown) => e);

      expect(writeCalls(write)).toHaveLength(1);
      expect(sleeps).toEqual([]);
      expect(failure).toBeInstanceOf(ProvisioningError);
      expect((failure as Error).cause).toBe(refusal);
    });

    it('waits out the backoff before resending, with the default sleep', async () => {
      vi.useFakeTimers();
      provider = new CloudWatchAlarmProvider(); // the real setTimeout-based sleep
      provider.throttleJitter = () => 0; // first wait: exactly ceiling/2 = 500ms
      scriptWrites([throttle(), 'ok']);

      const done = run(provider);
      await vi.advanceTimersByTimeAsync(0);
      expect(writeCalls(write)).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(499);
      expect(writeCalls(write)).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(1);
      await done;
      expect(writeCalls(write)).toHaveLength(2);
    });
  });

  it('retries a throttle recognized only by its Rate exceeded text', async () => {
    scriptWrites([new Error('Rate exceeded'), 'ok']);

    await provider.delete('Alarm1', 'alarm-1', TYPE);

    expect(writeCalls(DeleteAlarmsCommand)).toHaveLength(2);
    expect(sleeps).toHaveLength(1);
  });

  it('draws each wait from [ceiling/2, ceiling) by the jitter', async () => {
    provider.throttleDelaysMs = [1_000, 4_000];
    const draws = [0.5, 0.999];
    provider.throttleJitter = () => draws.shift() ?? 0;
    scriptWrites([throttle(), throttle(), 'ok']);

    await provider.delete('Alarm1', 'alarm-1', TYPE);

    expect(sleeps).toEqual([750, 3_998]);
  });

  it('holds back longer than the destroy retry (35s) and at most ~91s with production ceilings', () => {
    const ceilings = provider.throttleDelaysMs;
    const floor = ceilings.reduce((sum, c) => sum + c / 2, 0);
    const cap = ceilings.reduce((sum, c) => sum + c, 0);
    expect(floor).toBeGreaterThan(35_000);
    expect(cap).toBeLessThanOrEqual(91_000);
  });

  it('sends the same alarm write on every retry', async () => {
    scriptWrites([throttle(), 'ok']);

    await provider.delete('Alarm1', 'alarm-1', TYPE);

    for (const command of writeCalls(DeleteAlarmsCommand)) {
      expect((command as DeleteAlarmsCommand).input).toEqual({ AlarmNames: ['alarm-1'] });
    }
  });

  it('delete: still treats ResourceNotFound as already deleted, after a throttle too', async () => {
    const missing = new Error('alarm not found');
    missing.name = 'ResourceNotFound';
    scriptWrites([throttle(), missing]);

    await expect(
      provider.delete('Alarm1', 'alarm-1', TYPE, undefined, { expectedRegion: 'us-east-1' })
    ).resolves.toBeUndefined();
    expect(writeCalls(DeleteAlarmsCommand)).toHaveLength(2);
    expect(sleeps).toHaveLength(1);
  });

  it('create: records the ARN read back after a throttled PutMetricAlarm', async () => {
    scriptWrites([throttle(), 'ok']);

    const result = await provider.create('Alarm1', TYPE, PROPS);

    expect(result).toEqual({ physicalId: 'alarm-1', attributes: { Arn: ARN } });
  });

  it('sends the write once when it succeeds first time', async () => {
    scriptWrites(['ok']);

    await provider.delete('Alarm1', 'alarm-1', TYPE);

    expect(writeCalls(DeleteAlarmsCommand)).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });
});
