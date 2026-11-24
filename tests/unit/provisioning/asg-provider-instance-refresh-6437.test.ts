import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';

const mockSend = vi.fn();
const mockEc2Send = vi.fn();
const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: vi.fn(),
};

vi.mock('@aws-sdk/client-ec2', async () => {
  const actual = await vi.importActual<typeof import('@aws-sdk/client-ec2')>('@aws-sdk/client-ec2');
  return {
    ...actual,
    EC2Client: vi.fn(() => ({
      send: mockEc2Send,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
  };
});

vi.mock('@aws-sdk/client-auto-scaling', async () => {
  const actual =
    await vi.importActual<typeof import('@aws-sdk/client-auto-scaling')>(
      '@aws-sdk/client-auto-scaling'
    );
  return {
    ...actual,
    AutoScalingClient: vi.fn(() => ({
      send: mockSend,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
  };
});

vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({ ...logger, child: () => logger }),
}));

import {
  CreateAutoScalingGroupCommand,
  DeleteAutoScalingGroupCommand,
  CancelInstanceRefreshCommand,
  DescribeAutoScalingGroupsCommand,
  DescribeInstanceRefreshesCommand,
  StartInstanceRefreshCommand,
  UpdateAutoScalingGroupCommand,
} from '@aws-sdk/client-auto-scaling';
import { ASGProvider } from '../../../src/provisioning/providers/asg-provider.js';
import {
  declaredRefresh,
  pauseTimeSeconds,
  refreshWaitCapMs,
  rollingRefreshPreferences,
  selectInstanceRefresh,
} from '../../../src/provisioning/providers/asg/instance-refresh.js';
import { isMarkedNonRetryable } from '../../../src/deployment/retryable-errors.js';
import { isRefusedBeforeApplying } from '../../../src/deployment/prior-attempt-scope.js';
import {
  clearResolvedResourceTimeouts,
  setResolvedResourceTimeouts,
} from '../../../src/provisioning/resource-timeout-registry.js';
import {
  disarmInterruptWatchForTests,
  interruptWatchTestSeam,
  isInterruptedWaitError,
} from '../../../src/provisioning/interrupt-watch.js';

const TYPE = 'AWS::AutoScaling::AutoScalingGroup';
const NAME = 'my-asg';
const LT = (version: unknown) => ({ LaunchTemplateId: 'lt-0abc', Version: version });
const previous = { MinSize: '1', MaxSize: '3', DesiredCapacity: '2', LaunchTemplate: LT('1') };
const changed = { ...previous, LaunchTemplate: LT('2') };
const rolling = (members: Record<string, unknown> = {}) => ({
  AutoScalingRollingUpdate: { MaxBatchSize: 1, MinInstancesInService: 1, ...members },
});

type Handler = (command: unknown) => unknown;

/** The refresh statuses DescribeInstanceRefreshes answers, in order; the last repeats. */
function arm(
  opts: {
    statuses?: string[];
    desired?: number;
    instances?: number;
    start?: Handler;
    reason?: string;
    /** Per DescribeAutoScalingGroups call, how many instances are InService and Healthy. */
    inService?: number[];
    /**
     * What the group-wide reads (`MaxRecords: 1`, the "which refresh runs"
     * question) answer, in order, as the latest refresh's status (`undefined`:
     * none). Absent: none before a refresh starts, then the started refresh's
     * current status.
     */
    active?: Array<string | undefined>;
  } = {}
): void {
  const statuses = [...(opts.statuses ?? ['InProgress', 'Successful'])];
  const active = opts.active === undefined ? undefined : [...opts.active];
  const inService = opts.inService === undefined ? undefined : [...opts.inService];
  let startedId: string | undefined;
  let gone = false;
  mockSend.mockImplementation(async (command: unknown) => {
    if (command instanceof UpdateAutoScalingGroupCommand) return Promise.resolve({});
    if (command instanceof DeleteAutoScalingGroupCommand) {
      gone = true;
      return {};
    }
    if (command instanceof DescribeAutoScalingGroupsCommand && gone) {
      return { AutoScalingGroups: [] };
    }
    if (command instanceof DescribeAutoScalingGroupsCommand) {
      return Promise.resolve({
        AutoScalingGroups: [
          {
            AutoScalingGroupName: NAME,
            AutoScalingGroupARN: `arn:aws:autoscaling:us-east-1:123456789012:autoScalingGroup:abc:autoScalingGroupName/${NAME}`,
            DesiredCapacity: opts.desired ?? 2,
            Instances: (() => {
              const ready = inService === undefined ? 0 : inService.length > 1 ? inService.shift()! : inService[0]!;
              return Array.from({ length: opts.instances ?? opts.desired ?? 2 }, (_, i) => ({
                InstanceId: `i-${i}`,
                ...(i < ready && { LifecycleState: 'InService', HealthStatus: 'Healthy' }),
              }));
            })(),
          },
        ],
      });
    }
    if (command instanceof StartInstanceRefreshCommand) {
      const response = (await (opts.start
        ? opts.start(command)
        : Promise.resolve({ InstanceRefreshId: 'r-1' }))) as { InstanceRefreshId?: string };
      startedId = response.InstanceRefreshId ?? startedId;
      return response;
    }
    if (command instanceof DescribeInstanceRefreshesCommand && command.input.MaxRecords === 1) {
      const status =
        active !== undefined
          ? active.length > 1
            ? active.shift()
            : active[0]
          : startedId === undefined
            ? undefined
            : statuses[0];
      return {
        InstanceRefreshes:
          status === undefined ? [] : [{ InstanceRefreshId: 'r-1', Status: status }],
      };
    }
    if (command instanceof DescribeInstanceRefreshesCommand) {
      const status = statuses.length > 1 ? statuses.shift() : statuses[0];
      return Promise.resolve({
        InstanceRefreshes: [
          { InstanceRefreshId: 'r-1', Status: status, StatusReason: opts.reason },
        ],
      });
    }
    if (command instanceof CancelInstanceRefreshCommand) return Promise.resolve({});
    return Promise.resolve({});
  });
}

function sent<T>(ctor: new (...args: never[]) => T): T[] {
  return mockSend.mock.calls.map((c: unknown[]) => c[0]).filter((c): c is T => c instanceof ctor);
}

/** The refresh polls (by id), not the group-wide "which refresh runs" reads. */
function polls(): DescribeInstanceRefreshesCommand[] {
  return sent(DescribeInstanceRefreshesCommand).filter((c) => c.input.InstanceRefreshIds !== undefined);
}

function names(): string[] {
  return mockSend.mock.calls.map((c: unknown[]) => (c[0] as object).constructor.name);
}

function provider(): ASGProvider {
  const p = new ASGProvider();
  p.sleep = () => Promise.resolve();
  return p;
}

const run = (
  desired: Record<string, unknown>,
  context?: Record<string, unknown>,
  p: ASGProvider = provider()
) => p.update('MyAsg', NAME, TYPE, desired, previous, context);

beforeEach(() => {
  mockSend.mockReset();
  mockEc2Send.mockReset();
  mockEc2Send.mockResolvedValue({});
  for (const fn of [logger.debug, logger.info, logger.warn, logger.error]) fn.mockReset();
  delete process.env['CDKD_NO_WAIT'];
  clearResolvedResourceTimeouts();
  arm();
});

afterEach(() => {
  delete process.env['CDKD_NO_WAIT'];
  clearResolvedResourceTimeouts();
});

describe('selectInstanceRefresh (go-to-k/cdkd#6437)', () => {
  it('asks for nothing without a handed-over policy (flag off)', () => {
    expect(selectInstanceRefresh(undefined, changed, previous)).toEqual({ kind: 'none' });
  });

  it('runs a rolling update when the launch template version changed', () => {
    expect(selectInstanceRefresh(rolling(), changed, previous)).toMatchObject({
      kind: 'rolling',
      triggers: ['LaunchTemplate'],
    });
  });

  it.each([
    ['a size change only', { ...previous, MaxSize: '5' }],
    ['the same version as a number', { ...previous, LaunchTemplate: LT(1) }],
    ['the same launch template with its keys reordered', { ...previous, LaunchTemplate: { Version: '1', LaunchTemplateId: 'lt-0abc' } }],
    [
      'reordered subnets',
      { ...previous, VPCZoneIdentifier: ['subnet-b', 'subnet-a'] },
      { ...previous, VPCZoneIdentifier: 'subnet-a,subnet-b' },
    ],
  ])('runs nothing for %s', (_label, desired, prev: Record<string, unknown> = previous) => {
    expect(selectInstanceRefresh(rolling(), desired, prev)).toEqual({ kind: 'none' });
  });

  it.each(['LaunchConfigurationName', 'VPCZoneIdentifier', 'PlacementGroup'])(
    'treats a %s change as a rolling trigger',
    (key) => {
      expect(selectInstanceRefresh(rolling(), { ...previous, [key]: 'x' }, previous)).toMatchObject(
        { kind: 'rolling', triggers: [key] }
      );
    }
  );

  it('does not treat MixedInstancesPolicy as a rolling trigger, but does for an instance refresh', () => {
    const desired = { ...previous, MixedInstancesPolicy: { a: 1 } };
    expect(selectInstanceRefresh(rolling(), desired, previous)).toEqual({ kind: 'none' });
    expect(
      selectInstanceRefresh({ AutoScalingInstanceRefresh: { Strategy: 'Rolling' } }, desired, previous)
    ).toMatchObject({ kind: 'instance-refresh', triggers: ['MixedInstancesPolicy'] });
  });

  it.each([true, 'true'])('lets WillReplace: %s take precedence', (flag) => {
    const policy = { ...rolling(), AutoScalingReplacingUpdate: { WillReplace: flag } };
    expect(selectInstanceRefresh(policy, changed, previous)).toEqual({ kind: 'none' });
    expect(
      selectInstanceRefresh(
        { AutoScalingInstanceRefresh: {}, AutoScalingReplacingUpdate: { WillReplace: flag } },
        changed,
        previous
      )
    ).toEqual({ kind: 'none' });
  });

  it('keeps the rolling update under WillReplace: false', () => {
    const policy = { ...rolling(), AutoScalingReplacingUpdate: { WillReplace: false } };
    expect(selectInstanceRefresh(policy, changed, previous).kind).toBe('rolling');
  });

  it('reports a conflict for AutoScalingInstanceRefresh beside AutoScalingRollingUpdate', () => {
    const policy = { ...rolling(), AutoScalingInstanceRefresh: { Strategy: 'Rolling' } };
    expect(selectInstanceRefresh(policy, previous, previous)).toEqual({ kind: 'conflict' });
  });
});

describe('rollingRefreshPreferences', () => {
  const prefs = (members: Record<string, unknown>, desired: number) => {
    const ignored: string[] = [];
    return { prefs: rollingRefreshPreferences(members, desired, (m) => ignored.push(m)), ignored };
  };

  it.each([
    // [MaxBatchSize, MinInstancesInService, desired, min%, max%]
    [1, 0, 2, 50, 100],
    [1, 0, 3, 66, 100],
    [2, 1, 4, 50, 100],
    [5, 0, 2, 0, 100],
    [1, 1, 1, 100, 200],
    [1, 2, 3, 66, 100],
    [1, 3, 3, 100, 134],
    [10, 3, 3, 100, 200],
  ])('MaxBatchSize %i, MinInstancesInService %i, desired %i -> %i / %i', (b, m, d, min, max) => {
    const { prefs: p } = prefs({ MaxBatchSize: b, MinInstancesInService: m }, d);
    expect(p.MinHealthyPercentage).toBe(min);
    expect(p.MaxHealthyPercentage).toBe(max);
    expect(p.SkipMatching).toBe(false);
  });

  it('defaults to MaxBatchSize 1 and MinInstancesInService 0, reading quoted numbers', () => {
    expect(prefs({}, 4).prefs.MinHealthyPercentage).toBe(75);
    expect(prefs({ MaxBatchSize: '2', MinInstancesInService: '0' }, 4).prefs.MinHealthyPercentage).toBe(50);
  });

  it('maps PauseTime onto InstanceWarmup, 0 when unset and 300 under WaitOnResourceSignals', () => {
    expect(prefs({ PauseTime: 'PT2M30S' }, 2).prefs.InstanceWarmup).toBe(150);
    expect(prefs({}, 2).prefs.InstanceWarmup).toBe(0);
    expect(prefs({ WaitOnResourceSignals: true }, 2).prefs.InstanceWarmup).toBe(300);
  });

  it('reports the members it cannot express, and an unreadable value', () => {
    const { ignored, prefs: p } = prefs(
      {
        MaxBatchSize: { Ref: 'P' },
        PauseTime: '5 minutes',
        MinActiveInstancesPercent: 50,
        MinSuccessfulInstancesPercent: 50,
        SuspendProcesses: ['HealthCheck'],
      },
      2
    );
    expect(ignored).toEqual([
      'MaxBatchSize',
      'PauseTime',
      'MinActiveInstancesPercent',
      'MinSuccessfulInstancesPercent',
      'SuspendProcesses',
    ]);
    expect(p.MinHealthyPercentage).toBe(50);
    expect(p.InstanceWarmup).toBe(0);
  });
});

describe('pauseTimeSeconds', () => {
  it.each([
    ['PT5M', 300],
    ['PT1H', 3600],
    ['PT1H1M1S', 3661],
    ['PT0S', 0],
    ['PT', undefined],
    ['5M', undefined],
    [300, undefined],
  ])('%s -> %s', (input, expected) => {
    expect(pauseTimeSeconds(input)).toBe(expected);
  });
});

describe('declaredRefresh', () => {
  const read = (block: Record<string, unknown>, maintenance?: unknown) => {
    const ignored: string[] = [];
    return { ...declaredRefresh(block, maintenance, (m) => ignored.push(m)), ignored };
  };

  it("applies CloudFormation's defaults for Rolling and ReplaceRootVolume", () => {
    expect(read({ Strategy: 'Rolling' }).preferences).toEqual({
      MinHealthyPercentage: 100,
      MaxHealthyPercentage: 110,
      SkipMatching: true,
    });
    const root = read({ Strategy: 'ReplaceRootVolume' });
    expect(root.strategy).toBe('ReplaceRootVolume');
    expect(root.preferences).toMatchObject({ MinHealthyPercentage: 90, MaxHealthyPercentage: 100 });
  });

  it("takes a missing percentage from the group's InstanceMaintenancePolicy", () => {
    expect(
      read({ Strategy: 'Rolling', Preferences: { MaxHealthyPercentage: 150 } }, {
        MinHealthyPercentage: 80,
        MaxHealthyPercentage: 120,
      }).preferences
    ).toMatchObject({ MinHealthyPercentage: 80, MaxHealthyPercentage: 150 });
  });

  it('passes the declared preferences through, and drops an unreadable member', () => {
    const out = read({
      Strategy: 'Rolling',
      Preferences: {
        MinHealthyPercentage: '50',
        InstanceWarmup: 30,
        BakeTime: 60,
        CheckpointDelay: 10,
        CheckpointPercentages: [50, 100],
        SkipMatching: false,
        ScaleInProtectedInstances: 'Ignore',
        StandbyInstances: 'Terminate',
        AlarmSpecification: { Alarms: ['a1'] },
      },
    });
    expect(out.preferences).toEqual({
      MinHealthyPercentage: 50,
      MaxHealthyPercentage: 110,
      SkipMatching: false,
      InstanceWarmup: 30,
      BakeTime: 60,
      CheckpointDelay: 10,
      CheckpointPercentages: [50, 100],
      ScaleInProtectedInstances: 'Ignore',
      StandbyInstances: 'Terminate',
      AlarmSpecification: { Alarms: ['a1'] },
    });
    const bad = read({
      Strategy: 'Sideways',
      Preferences: { InstanceWarmup: 'soon', StandbyInstances: 'Maybe', CheckpointPercentages: [1, 'x'] },
    });
    expect(bad.strategy).toBe('Rolling');
    expect(bad.preferences).not.toHaveProperty('InstanceWarmup');
    expect(bad.preferences).not.toHaveProperty('StandbyInstances');
    expect(bad.ignored).toEqual([
      'Strategy',
      'Preferences.InstanceWarmup',
      'Preferences.CheckpointPercentages',
      'Preferences.StandbyInstances',
    ]);
  });
});

describe('ASGProvider.update instance refresh (go-to-k/cdkd#6437)', () => {
  it('sends no refresh call without an updatePolicy (the default and --no-update-policy)', async () => {
    await run(changed);
    expect(names()).toEqual(['UpdateAutoScalingGroupCommand', 'DescribeAutoScalingGroupsCommand']);
  });

  it('sends no refresh call when no trigger property changed', async () => {
    await run({ ...previous, MaxSize: '5' }, { updatePolicy: rolling() });
    expect(sent(StartInstanceRefreshCommand)).toHaveLength(0);
  });

  it('updates the group, then starts the refresh and waits for Successful', async () => {
    arm({ statuses: ['Pending', 'InProgress', 'Successful'] });
    const result = await run(changed, { updatePolicy: rolling({ PauseTime: 'PT1M' }) });
    expect(result.physicalId).toBe(NAME);
    const order = names();
    expect(order.indexOf('UpdateAutoScalingGroupCommand')).toBeLessThan(
      order.indexOf('StartInstanceRefreshCommand')
    );
    expect(sent(StartInstanceRefreshCommand)[0]!.input).toEqual({
      AutoScalingGroupName: NAME,
      Strategy: 'Rolling',
      Preferences: {
        MinHealthyPercentage: 50,
        MaxHealthyPercentage: 100,
        InstanceWarmup: 60,
        SkipMatching: false,
      },
    });
    expect(polls()).toHaveLength(3);
    expect(polls()[0]!.input).toEqual({
      AutoScalingGroupName: NAME,
      InstanceRefreshIds: ['r-1'],
    });
    expect(sent(CancelInstanceRefreshCommand)).toHaveLength(0);
  });

  it('starts the declared AutoScalingInstanceRefresh', async () => {
    await run(
      { ...changed, InstanceMaintenancePolicy: { MinHealthyPercentage: 90, MaxHealthyPercentage: 120 } },
      { updatePolicy: { AutoScalingInstanceRefresh: { Strategy: 'Rolling', Preferences: { InstanceWarmup: 5 } } } }
    );
    expect(sent(StartInstanceRefreshCommand)[0]!.input).toEqual({
      AutoScalingGroupName: NAME,
      Strategy: 'Rolling',
      Preferences: {
        MinHealthyPercentage: 90,
        MaxHealthyPercentage: 120,
        SkipMatching: true,
        InstanceWarmup: 5,
      },
    });
  });

  it('skips the refresh for a group with no instances', async () => {
    arm({ desired: 0, instances: 0 });
    await run(changed, { updatePolicy: rolling() });
    expect(sent(StartInstanceRefreshCommand)).toHaveLength(0);
  });

  it.each(['Failed', 'Cancelled', 'RollbackSuccessful', 'RollbackFailed'])(
    'fails the update, non-retryable, when the refresh ends %s',
    async (status) => {
      arm({ statuses: ['InProgress', status], reason: 'health checks failed' });
      const error = await run(changed, { updatePolicy: rolling() }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain(`instance refresh r-1 ended ${status}`);
      expect((error as Error).message).toContain('health checks failed');
      expect(isMarkedNonRetryable(error)).toBe(true);
    }
  );

  it('cancels and fails a refresh still running near the resource timeout', async () => {
    setResolvedResourceTimeouts({ perTypeMs: { [TYPE]: 60_000 } });
    arm({ statuses: ['InProgress'] });
    const error = await run(changed, { updatePolicy: rolling() }).catch((e: unknown) => e);
    expect((error as Error).message).toContain('did not finish within 54 seconds and was cancelled');
    expect(isMarkedNonRetryable(error)).toBe(true);
    // 4 polls of the 54-second cap, then the cancel's check that r-1 still runs.
    expect(polls()).toHaveLength(4);
    expect(sent(CancelInstanceRefreshCommand)[0]!.input).toEqual({ AutoScalingGroupName: NAME });
  });

  it('caps the wait two minutes inside the default 30-minute resource timeout', () => {
    expect(refreshWaitCapMs(TYPE)).toBe(28 * 60_000);
    expect(refreshWaitCapMs(TYPE, 5 * 60_000)).toBe(23 * 60_000);
    setResolvedResourceTimeouts({ globalMs: 60 * 60_000 });
    expect(refreshWaitCapMs(TYPE)).toBe(58 * 60_000);
    // A short timeout keeps a tenth of itself as the margin.
    setResolvedResourceTimeouts({ perTypeMs: { [TYPE]: 60_000 } });
    expect(refreshWaitCapMs(TYPE)).toBe(54_000);
    expect(refreshWaitCapMs(TYPE, 120_000)).toBe(0);
  });

  it("counts the limit from update()'s start", async () => {
    setResolvedResourceTimeouts({ perTypeMs: { [TYPE]: 60_000 } });
    arm({ statuses: ['InProgress'] });
    // The update itself took the whole 54-second limit: one poll is left.
    let calls = 0;
    const now = vi.spyOn(Date, 'now').mockImplementation(() => (calls++ === 0 ? 0 : 54_000));
    try {
      await run(changed, { updatePolicy: rolling() }).catch(() => undefined);
    } finally {
      now.mockRestore();
    }
    // One poll, then the cancel.
    expect(polls()).toHaveLength(1);
  });

  it('does not cancel at the cap when its refresh is no longer the running one', async () => {
    setResolvedResourceTimeouts({ perTypeMs: { [TYPE]: 60_000 } });
    arm({ statuses: ['InProgress', 'InProgress', 'InProgress', 'InProgress', 'Successful'] });
    const error = await run(changed, { updatePolicy: rolling() }).catch((e: unknown) => e);
    expect((error as Error).message).toContain('did not finish within 54 seconds and is no longer running');
    expect(sent(CancelInstanceRefreshCommand)).toHaveLength(0);
  });

  it('says the cancel is unconfirmed, and sends none, when the running refresh cannot be read', async () => {
    setResolvedResourceTimeouts({ perTypeMs: { [TYPE]: 60_000 } });
    arm({ statuses: ['InProgress'] });
    const base = mockSend.getMockImplementation()!;
    mockSend.mockImplementation((command: unknown) =>
      command instanceof DescribeInstanceRefreshesCommand && command.input.MaxRecords === 1
        ? Promise.reject(Object.assign(new Error('Rate exceeded'), { name: 'Throttling' }))
        : base(command)
    );
    const error = await run(changed, { updatePolicy: rolling() }).catch((e: unknown) => e);
    expect((error as Error).message).toContain('could not be confirmed cancelled');
    expect(sent(CancelInstanceRefreshCommand)).toHaveLength(0);
  });

  it('warns, and still throws the timeout, when the cancel fails', async () => {
    setResolvedResourceTimeouts({ perTypeMs: { [TYPE]: 60_000 } });
    arm({ statuses: ['InProgress'] });
    const base = mockSend.getMockImplementation()!;
    mockSend.mockImplementation((command: unknown) =>
      command instanceof CancelInstanceRefreshCommand
        ? Promise.reject(Object.assign(new Error('denied'), { name: 'AccessDenied' }))
        : base(command)
    );
    const error = await run(changed, { updatePolicy: rolling() }).catch((e: unknown) => e);
    expect((error as Error).message).toContain('could not be confirmed cancelled');
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('could not cancel instance refresh r-1'));
  });

  it('keeps waiting through an unreadable describe', async () => {
    const statuses = ['throw', 'Successful'];
    arm();
    const base = mockSend.getMockImplementation()!;
    mockSend.mockImplementation((command: unknown) => {
      if (command instanceof DescribeInstanceRefreshesCommand && statuses[0] === 'throw') {
        statuses.shift();
        return Promise.reject(Object.assign(new Error('Rate exceeded'), { name: 'Throttling' }));
      }
      return base(command);
    });
    await run(changed, { updatePolicy: rolling() });
    expect(sent(DescribeInstanceRefreshesCommand).length).toBeGreaterThanOrEqual(2);
  });

  it('returns after the start under --no-wait', async () => {
    process.env['CDKD_NO_WAIT'] = 'true';
    await run(changed, { updatePolicy: rolling() });
    expect(sent(StartInstanceRefreshCommand)).toHaveLength(1);
    expect(polls()).toHaveLength(0);
  });

  it('refuses a forward update while another refresh runs', async () => {
    arm({
      start: () =>
        Promise.reject(
          Object.assign(new Error('An Instance Refresh is already in progress'), {
            name: 'InstanceRefreshInProgressFault',
          })
        ),
    });
    const error = await run(changed, { updatePolicy: rolling() }).catch((e: unknown) => e);
    expect((error as Error).message).toContain('already running on the group');
    expect(isMarkedNonRetryable(error)).toBe(true);
    expect(sent(CancelInstanceRefreshCommand)).toHaveLength(0);
  });

  const busyOnce = () => {
    let starts = 0;
    return {
      count: () => starts,
      start: () =>
        ++starts === 1
          ? Promise.reject(
              Object.assign(new Error('busy'), { name: 'InstanceRefreshInProgressFault' })
            )
          : Promise.resolve({ InstanceRefreshId: 'r-2' }),
    };
  };

  it("cancels this process's refresh still running on a rollback revert, then starts its own", async () => {
    const busy = busyOnce();
    // ownership check and the cancel's check (r-1 running), then settle (stopped).
    arm({ start: busy.start, active: ['InProgress', 'InProgress', 'Cancelled'], statuses: ['Successful'] });
    const p = provider();
    p.startedRefreshes.set(NAME, 'r-1');
    await run(changed, { updatePolicy: rolling(), replayingState: true }, p);
    expect(busy.count()).toBe(2);
    expect(sent(CancelInstanceRefreshCommand)).toHaveLength(1);
    expect(p.startedRefreshes.get(NAME)).toBe('r-2');
  });

  it('refuses, and cancels nothing, when the running refresh is not one this process started', async () => {
    const busy = busyOnce();
    arm({ start: busy.start, statuses: ['InProgress'] });
    const error = await run(changed, { updatePolicy: rolling(), replayingState: true }).catch(
      (e: unknown) => e
    );
    expect((error as Error).message).toContain('then run the rollback again');
    expect(busy.count()).toBe(1);
    expect(sent(CancelInstanceRefreshCommand)).toHaveLength(0);
  });

  it('replaces only mismatched instances on a rollback revert (SkipMatching: true)', async () => {
    await run(changed, { updatePolicy: rolling(), replayingState: true });
    expect(sent(StartInstanceRefreshCommand)[0]!.input.Preferences?.SkipMatching).toBe(true);
  });

  it('keeps SkipMatching false on the revert of a launch-configuration group', async () => {
    const lcPrev = { MinSize: '1', MaxSize: '3', LaunchConfigurationName: 'lc-1' };
    await provider().update(
      'MyAsg',
      NAME,
      TYPE,
      { ...lcPrev, LaunchConfigurationName: 'lc-2' },
      lcPrev,
      { updatePolicy: rolling(), replayingState: true }
    );
    expect(sent(StartInstanceRefreshCommand)[0]!.input.Preferences?.SkipMatching).toBe(false);
  });

  it('marks the trigger properties unsettled before the refresh starts', async () => {
    const marked: string[] = [];
    let markedBeforeStart: string[] | undefined;
    arm({
      start: () => {
        markedBeforeStart = [...marked];
        return Promise.resolve({ InstanceRefreshId: 'r-1' });
      },
    });
    await run(changed, { updatePolicy: rolling(), markUnsettled: (k: string) => marked.push(k) });
    expect(markedBeforeStart).toEqual(['LaunchTemplate']);
  });

  it('marks nothing without a refresh', async () => {
    const markUnsettled = vi.fn();
    await run({ ...previous, MaxSize: '5' }, { updatePolicy: rolling(), markUnsettled });
    expect(markUnsettled).not.toHaveBeenCalled();
  });

  it('refreshes for a trigger an earlier failed refresh left unsettled, even with no change', async () => {
    await run(previous, {
      updatePolicy: rolling(),
      unsettledProperties: new Set(['LaunchTemplate']),
    });
    expect(sent(StartInstanceRefreshCommand)).toHaveLength(1);
  });

  it('fails the update when StartInstanceRefresh returns no id', async () => {
    arm({ start: () => Promise.resolve({}) });
    const error = await run(changed, { updatePolicy: rolling() }).catch((e: unknown) => e);
    expect((error as Error).message).toContain('returned no InstanceRefreshId');
    expect(polls()).toHaveLength(0);
  });

  it('retries a throttled start, and gives up after three attempts', async () => {
    const throttle = () =>
      Promise.reject(Object.assign(new Error('Rate exceeded'), { name: 'Throttling' }));
    let starts = 0;
    arm({ start: () => (++starts < 3 ? throttle() : Promise.resolve({ InstanceRefreshId: 'r-1' })) });
    await run(changed, { updatePolicy: rolling() });
    expect(starts).toBe(3);
    starts = 0;
    mockSend.mockClear();
    arm({ start: () => (++starts, throttle()) });
    const error = await run(changed, { updatePolicy: rolling() }).catch((e: unknown) => e);
    expect(starts).toBe(3);
    expect(isMarkedNonRetryable(error)).toBe(true);
  });

  it('keeps waiting through Baking and the other non-terminal statuses', async () => {
    arm({ statuses: ['Pending', 'Baking', 'RollbackInProgress', 'Cancelling', 'Successful'] });
    await run(changed, { updatePolicy: rolling() });
    expect(polls()).toHaveLength(5);
  });

  it('sizes the batches from the live DesiredCapacity over the template', async () => {
    arm({ desired: 4 });
    await run(changed, { updatePolicy: { AutoScalingRollingUpdate: {} } });
    expect(sent(StartInstanceRefreshCommand)[0]!.input.Preferences?.MinHealthyPercentage).toBe(75);
  });

  it('still refreshes a group launching its instances (none yet, desired above 0)', async () => {
    arm({ desired: 2, instances: 0 });
    await run(changed, { updatePolicy: rolling() });
    expect(sent(StartInstanceRefreshCommand)).toHaveLength(1);
  });


  it('refuses AutoScalingInstanceRefresh beside AutoScalingRollingUpdate before any call', async () => {
    const updatePolicy = { ...rolling(), AutoScalingInstanceRefresh: { Strategy: 'Rolling' } };
    const error = await run(changed, { updatePolicy }).catch((e: unknown) => e);
    expect((error as Error).message).toContain('both AutoScalingInstanceRefresh and AutoScalingRollingUpdate');
    expect(isMarkedNonRetryable(error)).toBe(true);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('only warns on that pair during a rollback revert, and starts no refresh', async () => {
    const updatePolicy = { ...rolling(), AutoScalingInstanceRefresh: { Strategy: 'Rolling' } };
    await run(changed, { updatePolicy, replayingState: true });
    expect(sent(UpdateAutoScalingGroupCommand)).toHaveLength(1);
    expect(sent(StartInstanceRefreshCommand)).toHaveLength(0);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('No instance refresh is started'));
  });

  it('warns that WaitOnResourceSignals is not honored', async () => {
    await run(changed, { updatePolicy: rolling({ WaitOnResourceSignals: true }) });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('WaitOnResourceSignals is not honored')
    );
  });

  describe('WaitOnResourceSignals through the signal receiver (go-to-k/cdkd#6706)', () => {
    const watch = (
      failures: (string | undefined)[],
      awaitAll = vi.fn(async () => undefined),
      armed = true
    ) => {
      const failure = vi.fn(async () => failures.shift());
      const arm = vi.fn(async (_count: number) => armed);
      return { arm, failure, awaitAll };
    };

    it('waits for every replaced instance signal after the refresh, within PauseTime, and does not warn', async () => {
      arm({ statuses: ['InProgress', 'Successful'], inService: [2] });
      const rollingSignals = watch([]);
      await run(changed, {
        updatePolicy: rolling({ WaitOnResourceSignals: true, PauseTime: 'PT2M' }),
        rollingSignals,
      });
      expect(rollingSignals.arm).toHaveBeenCalledWith(2);
      expect(rollingSignals.awaitAll).toHaveBeenCalledWith(120_000);
      expect(logger.warn).not.toHaveBeenCalledWith(
        expect.stringContaining('WaitOnResourceSignals is not honored')
      );
    });

    it('cancels the refresh and fails on a FAILURE signal while it runs', async () => {
      arm({ statuses: ['InProgress', 'InProgress', 'Successful'], inService: [2] });
      const rollingSignals = watch(['Received FAILURE signal with UniqueId i-9']);
      const error = await run(changed, {
        updatePolicy: rolling({ WaitOnResourceSignals: true }),
        rollingSignals,
      }).catch((e: unknown) => e);
      expect((error as Error).message).toContain('Received FAILURE signal with UniqueId i-9');
      expect(sent(CancelInstanceRefreshCommand)).toHaveLength(1);
      expect(rollingSignals.awaitAll).not.toHaveBeenCalled();
    });

    it('arms one signal per in-service instance, at most the desired capacity', async () => {
      arm({ statuses: ['Successful'], desired: 1, instances: 3, inService: [3] });
      const rollingSignals = watch([]);
      await run(changed, { updatePolicy: rolling({ WaitOnResourceSignals: true }), rollingSignals });
      expect(rollingSignals.arm).toHaveBeenCalledWith(1);
    });

    it('waits for no signal, and warns, when the receiver cannot arm', async () => {
      arm({ statuses: ['Successful'], inService: [2] });
      const rollingSignals = watch([], vi.fn(async () => undefined), false);
      await run(changed, { updatePolicy: rolling({ WaitOnResourceSignals: true }), rollingSignals });
      expect(rollingSignals.awaitAll).not.toHaveBeenCalled();
      expect(rollingSignals.failure).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('WaitOnResourceSignals is not honored'));
    });

    it('a rollback revert neither arms nor warns', async () => {
      arm({ statuses: ['Successful'], inService: [2] });
      const rollingSignals = watch([]);
      await run(changed, {
        updatePolicy: rolling({ WaitOnResourceSignals: true }),
        rollingSignals,
        replayingState: true,
      });
      expect(rollingSignals.arm).not.toHaveBeenCalled();
      expect(logger.warn).not.toHaveBeenCalledWith(expect.stringContaining('WaitOnResourceSignals is not honored'));
    });

    it('fails when the signals do not all arrive after the refresh', async () => {
      arm({ statuses: ['Successful'], inService: [2] });
      const rollingSignals = watch(
        [],
        vi.fn(async () => {
          throw new Error('MyAsg did not receive 2 CreationPolicy signal(s) within 300s');
        })
      );
      const error = await run(changed, {
        updatePolicy: rolling({ WaitOnResourceSignals: true }),
        rollingSignals,
      }).catch((e: unknown) => e);
      expect((error as Error).message).toContain('did not receive 2 CreationPolicy signal(s)');
    });
  });

  it('routes every refresh line through the masker', async () => {
    const maskSecrets = (text: string) => text.split('MyAsg').join('***');
    await run(changed, { updatePolicy: rolling({ SuspendProcesses: ['x'] }), maskSecrets });
    const lines = logger.info.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(lines.some((l) => l.includes('instance refresh r-1 started'))).toBe(true);
    expect(lines.some((l) => l.includes('SuspendProcesses not applied'))).toBe(true);
    expect(lines.filter((l) => l.includes('MyAsg'))).toEqual([]);
  });

  it('refuses, before any write, while another refresh is already running', async () => {
    arm({ active: ['InProgress'] });
    const error = await run(changed, { updatePolicy: rolling() }).catch((e: unknown) => e);
    expect((error as Error).message).toContain('instance refresh r-1 is already running');
    expect(isRefusedBeforeApplying(error, 'MyAsg')).toBe(true);
    expect(isMarkedNonRetryable(error)).toBe(true);
    expect(sent(UpdateAutoScalingGroupCommand)).toHaveLength(0);
    expect(sent(StartInstanceRefreshCommand)).toHaveLength(0);
  });

  it('does not run that check without a refresh, or on a rollback revert', async () => {
    arm({ active: ['InProgress'] });
    await run({ ...previous, MaxSize: '5' }, { updatePolicy: rolling() });
    expect(sent(DescribeInstanceRefreshesCommand)).toHaveLength(0);
    mockSend.mockClear();
    const p = provider();
    p.startedRefreshes.set(NAME, 'r-1');
    arm({ active: [undefined], statuses: ['Successful'] });
    await run(changed, { updatePolicy: rolling(), replayingState: true }, p);
    expect(sent(UpdateAutoScalingGroupCommand)).toHaveLength(1);
  });

  it('marks the policy-pair refusal refused-before-applying', async () => {
    const updatePolicy = { ...rolling(), AutoScalingInstanceRefresh: { Strategy: 'Rolling' } };
    const error = await run(changed, { updatePolicy }).catch((e: unknown) => e);
    expect(isRefusedBeforeApplying(error, 'MyAsg')).toBe(true);
  });

  it.each([
    ['a subnet change', { ...changed, VPCZoneIdentifier: ['subnet-b'] }],
    ['a placement group change', { ...changed, PlacementGroup: 'pg-2' }],
  ])('rolls every instance on the revert of %s (SkipMatching: false)', async (_label, desired) => {
    await run(desired, { updatePolicy: rolling(), replayingState: true });
    expect(sent(StartInstanceRefreshCommand)[0]!.input.Preferences?.SkipMatching).toBe(false);
  });

  it("drops the forward's alarms and checkpoints from a revert's declared refresh", async () => {
    const updatePolicy = {
      AutoScalingInstanceRefresh: {
        Strategy: 'Rolling',
        Preferences: {
          AlarmSpecification: { Alarms: ['a1'] },
          CheckpointPercentages: [50, 100],
          CheckpointDelay: 60,
          InstanceWarmup: 5,
        },
      },
    };
    await run(changed, { updatePolicy, replayingState: true });
    const prefs = sent(StartInstanceRefreshCommand)[0]!.input.Preferences!;
    expect(prefs).not.toHaveProperty('AlarmSpecification');
    expect(prefs).not.toHaveProperty('CheckpointPercentages');
    expect(prefs).not.toHaveProperty('CheckpointDelay');
    expect(prefs.InstanceWarmup).toBe(5);
    mockSend.mockClear();
    await run(changed, { updatePolicy });
    expect(sent(StartInstanceRefreshCommand)[0]!.input.Preferences).toHaveProperty(
      'AlarmSpecification',
      { Alarms: ['a1'] }
    );
  });

  it('reads a cancel answered ActiveInstanceRefreshNotFound as no longer running', async () => {
    setResolvedResourceTimeouts({ perTypeMs: { [TYPE]: 60_000 } });
    arm({ statuses: ['InProgress'] });
    const base = mockSend.getMockImplementation()!;
    mockSend.mockImplementation((command: unknown) =>
      command instanceof CancelInstanceRefreshCommand
        ? Promise.reject(Object.assign(new Error('none'), { name: 'ActiveInstanceRefreshNotFoundFault' }))
        : base(command)
    );
    const error = await run(changed, { updatePolicy: rolling() }).catch((e: unknown) => e);
    expect((error as Error).message).toContain('and is no longer running');
    expect(logger.warn).not.toHaveBeenCalledWith(expect.stringContaining('could not cancel'));
  });

  describe('create awaitInService (an AutoScalingReplacingUpdate)', () => {
    const createProps = { MinSize: '2', MaxSize: '3', LaunchTemplate: LT('2') };
    const create = (context: Record<string, unknown> = { awaitInService: true }, p = provider()) =>
      p.create('MyAsg', TYPE, createProps, context);

    it('waits until the desired capacity is in service', async () => {
      arm({ desired: 2, inService: [0, 1, 2] });
      const p = provider();
      const naps = vi.fn(() => Promise.resolve());
      p.sleep = naps;
      const result = await create({ awaitInService: true }, p);
      expect(result.physicalId).toBeDefined();
      expect(sent(CreateAutoScalingGroupCommand)).toHaveLength(1);
      expect(naps).toHaveBeenCalled();
      expect(sent(DeleteAutoScalingGroupCommand)).toHaveLength(0);
    });

    it('does not wait without the flag', async () => {
      arm({ desired: 2, inService: [0] });
      const p = provider();
      const naps = vi.fn(() => Promise.resolve());
      p.sleep = naps;
      await create({}, p);
      expect(naps).not.toHaveBeenCalled();
    });

    it('retires the new group and fails when its instances are not in service in time', async () => {
      setResolvedResourceTimeouts({ perTypeMs: { [TYPE]: 60_000 } });
      arm({ desired: 2, inService: [1] });
      const error = await create().catch((e: unknown) => e);
      expect((error as Error).message).toContain('were not in service in time (1 of 2)');
      expect(isMarkedNonRetryable(error)).toBe(true);
      expect(sent(DeleteAutoScalingGroupCommand)).toHaveLength(1);
      // The retire does not wait for the group to go: that would outlive the
      // resource timeout, and the rollback would delete it a second time.
      const calls = mockSend.mock.calls.map((c: unknown[]) => c[0]);
      const deleteAt = calls.findIndex((c) => c instanceof DeleteAutoScalingGroupCommand);
      expect(calls.slice(deleteAt + 1).filter((c) => c instanceof DescribeAutoScalingGroupsCommand)).toEqual([]);
    });
  });

  describe('with the command owning interrupts', () => {
    beforeEach(() => {
      disarmInterruptWatchForTests();
      interruptWatchTestSeam.commandOwnsInterrupts = () => true;
    });
    afterEach(() => {
      disarmInterruptWatchForTests();
      delete interruptWatchTestSeam.commandOwnsInterrupts;
    });

    it("stops waiting for the failed deploy's refresh to stop on Ctrl-C", async () => {
      let starts = 0;
      arm({
        start: () => {
          starts++;
          return Promise.reject(
            Object.assign(new Error('busy'), { name: 'InstanceRefreshInProgressFault' })
          );
        },
        active: ['InProgress'],
      });
      const p = provider();
      p.startedRefreshes.set(NAME, 'r-1');
      p.sleep = () => {
        process.emit('SIGINT');
        return Promise.resolve();
      };
      const error = await run(changed, { updatePolicy: rolling(), replayingState: true }, p).catch(
        (e: unknown) => e
      );
      expect(isInterruptedWaitError(error)).toBe(true);
      expect(starts).toBe(1);
    });

    it('cancels the refresh on Ctrl-C and throws the interrupt', async () => {
      arm({ statuses: ['InProgress'] });
      const p = provider();
      p.sleep = () => {
        process.emit('SIGINT');
        return Promise.resolve();
      };
      const error = await run(changed, { updatePolicy: rolling() }, p).catch((e: unknown) => e);
      expect(isInterruptedWaitError(error)).toBe(true);
      expect(sent(CancelInstanceRefreshCommand)).toHaveLength(1);
    });
  });
});
