/**
 * A plain delete of an `AWS::AutoScaling::AutoScalingGroup` that still has
 * instances (issue #6466). AWS refuses a non-force `DeleteAutoScalingGroup` of
 * a non-empty group, so without `--remove-protection` cdkd scales the group to
 * 0, waits for its instances to terminate, then deletes it — CloudFormation's
 * delete of the same group. A group whose `DeletionProtection` is on, or whose
 * instances a scale to 0 cannot terminate, is left untouched.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';

const asgSend = vi.hoisted(() => vi.fn());

vi.mock('@aws-sdk/client-auto-scaling', async (importOriginal) => {
  const orig = (await importOriginal()) as Record<string, unknown>;
  return {
    ...orig,
    AutoScalingClient: vi.fn(() => ({
      send: asgSend,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
  };
});

const childLogger = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: vi.fn(),
}));
vi.mock('../../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    child: () => childLogger,
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

const deadline = vi.hoisted(() => ({ expired: false, remainingMs: Number.POSITIVE_INFINITY }));
vi.mock('../../../../src/deployment/resource-deadline.js', async (importOriginal) => {
  const orig = (await importOriginal()) as Record<string, unknown>;
  return {
    ...orig,
    enclosingDeadlineExpired: () => deadline.expired,
    enclosingDeadlineRemainingMs: () => deadline.remainingMs,
  };
});

import { ASGProvider } from '../../../../src/provisioning/providers/asg-provider.js';
import {
  ScaleInRefusal,
  SCALE_IN_WAIT_MS,
  instancesScaleInCannotTerminate,
  isGroupNotEmptyRefusal,
} from '../../../../src/provisioning/providers/asg/delete.js';
import { isMarkedNonRetryable } from '../../../../src/deployment/retryable-errors.js';
import {
  deleteSupersededEntry,
  supersededInUseRetry,
} from '../../../../src/deployment/superseded-resources.js';

type Cmd = { constructor: { name: string }; input: Record<string, unknown> };
type Inst = { InstanceId: string; LifecycleState: string; ProtectedFromScaleIn: boolean };

const RESOURCE_TYPE = 'AWS::AutoScaling::AutoScalingGroup';
const ASG = 'my-asg';
const I1 = 'i-0aaaaaaaaaaaaaaa1';
const I2 = 'i-0bbbbbbbbbbbbbbb2';

function awsError(name: string, message: string): Error {
  const e = new Error(message);
  e.name = name;
  return e;
}
const notEmpty = (): Error =>
  awsError(
    'ResourceInUseFault',
    'You cannot delete an AutoScalingGroup while there are instances or pending Spot instance request(s) still in the group.'
  );
const activity = (): Error =>
  awsError(
    'ScalingActivityInProgressFault',
    'You cannot delete an AutoScalingGroup while there are scaling activities in progress for that group.'
  );

const inService = (id: string, isProtected = false): Inst => ({
  InstanceId: id,
  LifecycleState: 'InService',
  ProtectedFromScaleIn: isProtected,
});

interface Group {
  DeletionProtection?: string;
  MinSize: number;
  MaxSize: number;
  DesiredCapacity: number;
  Instances: Inst[];
  WarmPoolConfiguration?: { Status?: string };
}

/**
 * A scripted group. `drain` is the instance lists each describe AFTER the
 * scale to 0 returns, in order (the last repeats); `deleteErrors` are the
 * delete outcomes in order (undefined = accepted, then the group is gone).
 */
function script(opts: {
  group: Group;
  drain?: Inst[][];
  deleteErrors?: (Error | undefined)[];
}): void {
  const group = { ...opts.group };
  let scaled = false;
  let drainIdx = 0;
  let deleteIdx = 0;
  let gone = false;
  const deleteErrors = opts.deleteErrors ?? [notEmpty(), undefined];
  asgSend.mockImplementation((command: Cmd) => {
    switch (command.constructor.name) {
      case 'DeleteAutoScalingGroupCommand': {
        const err = deleteErrors[Math.min(deleteIdx++, deleteErrors.length - 1)];
        if (err) return Promise.reject(err);
        gone = true;
        return Promise.resolve({});
      }
      case 'DescribeAutoScalingGroupsCommand': {
        if (gone) return Promise.resolve({ AutoScalingGroups: [] });
        let instances = group.Instances;
        if (scaled && opts.drain) {
          instances = opts.drain[Math.min(drainIdx++, opts.drain.length - 1)]!;
        }
        return Promise.resolve({ AutoScalingGroups: [{ ...group, Instances: instances }] });
      }
      case 'UpdateAutoScalingGroupCommand':
        scaled = true;
        Object.assign(group, command.input);
        return Promise.resolve({});
      default:
        return Promise.resolve({});
    }
  });
}

const calls = (): Cmd[] => asgSend.mock.calls.map((c) => c[0] as Cmd);
const names = (): string[] => calls().map((c) => c.constructor.name.replace(/Command$/, ''));

let sleep: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  asgSend.mockReset();
  childLogger.info.mockReset();
  deadline.expired = false;
  deadline.remainingMs = Number.POSITIVE_INFINITY;
  sleep =vi.spyOn(ASGProvider.prototype, 'sleep').mockResolvedValue(undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
});

const RUNNING: Group = {
  DeletionProtection: 'none',
  MinSize: 1,
  MaxSize: 2,
  DesiredCapacity: 2,
  Instances: [inService(I1), inService(I2)],
};

describe('ASG delete of a group with running instances (#6466)', () => {
  it('an already-empty group is deleted with exactly the calls it made before (no extra describe or update)', async () => {
    script({
      group: { ...RUNNING, MinSize: 0, MaxSize: 0, DesiredCapacity: 0, Instances: [] },
      deleteErrors: [undefined],
    });
    await new ASGProvider().delete('Asg', ASG, RESOURCE_TYPE);
    // The delete, then the existing wait-until-gone describe.
    expect(names()).toEqual(['DeleteAutoScalingGroup', 'DescribeAutoScalingGroups']);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('scales the group to 0, waits for its instances to terminate, then deletes it without ForceDelete', async () => {
    script({
      group: RUNNING,
      drain: [
        [{ ...inService(I1), LifecycleState: 'Terminating' }, inService(I2)],
        [{ ...inService(I2), LifecycleState: 'Terminating:Proceed' }],
        [],
      ],
    });
    await new ASGProvider().delete('Asg', ASG, RESOURCE_TYPE);
    expect(names()).toEqual([
      'DeleteAutoScalingGroup',
      'DescribeAutoScalingGroups',
      'UpdateAutoScalingGroup',
      'DescribeAutoScalingGroups',
      'DescribeAutoScalingGroups',
      'DescribeAutoScalingGroups',
      'DeleteAutoScalingGroup',
      'DescribeAutoScalingGroups',
    ]);
    const update = calls()[2]!.input;
    expect(update).toEqual({
      AutoScalingGroupName: ASG,
      MinSize: 0,
      MaxSize: 0,
      DesiredCapacity: 0,
    });
    for (const del of calls().filter((c) => c.constructor.name === 'DeleteAutoScalingGroupCommand')) {
      expect(del.input.ForceDelete).toBe(false);
    }
    expect(childLogger.info).toHaveBeenCalledWith(
      'Scaling AutoScalingGroup Asg to 0 and waiting for its 2 instance(s) to terminate before deleting it'
    );
  });

  it('also scales in on a ScalingActivityInProgress refusal, and retries the delete while AWS still refuses it', async () => {
    script({
      group: RUNNING,
      drain: [[]],
      deleteErrors: [activity(), activity(), notEmpty(), undefined],
    });
    await new ASGProvider().delete('Asg', ASG, RESOURCE_TYPE);
    expect(names().filter((n) => n === 'DeleteAutoScalingGroup')).toHaveLength(4);
    expect(names().filter((n) => n === 'UpdateAutoScalingGroup')).toHaveLength(1);
  });

  it('issues no UpdateAutoScalingGroup when the group is already at 0/0/0', async () => {
    script({
      group: {
        ...RUNNING,
        MinSize: 0,
        MaxSize: 0,
        DesiredCapacity: 0,
        Instances: [{ ...inService(I1), LifecycleState: 'Terminating' }],
      },
      drain: [[]],
      deleteErrors: [notEmpty(), undefined],
    });
    // The drain script keys on the update; without one the group reports its
    // initial instances, so script the drain through describe order instead.
    let describes = 0;
    const base = asgSend.getMockImplementation()!;
    asgSend.mockImplementation((command: Cmd) => {
      if (command.constructor.name === 'DescribeAutoScalingGroupsCommand' && ++describes === 2) {
        return Promise.resolve({
          AutoScalingGroups: [{ ...RUNNING, MinSize: 0, MaxSize: 0, DesiredCapacity: 0, Instances: [] }],
        });
      }
      return base(command);
    });
    await new ASGProvider().delete('Asg', ASG, RESOURCE_TYPE);
    expect(names()).not.toContain('UpdateAutoScalingGroup');
    expect(childLogger.info).not.toHaveBeenCalled();
  });

  it.each(['prevent-force-deletion', 'prevent-all-deletion'])(
    'DeletionProtection %s: AWS refusal re-thrown as before, nothing scaled',
    async (level) => {
      script({ group: { ...RUNNING, DeletionProtection: level } });
      const error = await new ASGProvider().delete('Asg', ASG, RESOURCE_TYPE).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(ScaleInRefusal);
      expect((error as Error).message).toContain('Failed to delete AutoScalingGroup Asg');
      expect((error as Error).message).toContain('still in the group');
      expect(names()).toEqual(['DeleteAutoScalingGroup', 'DescribeAutoScalingGroups']);
    }
  );

  it('refuses, naming the instance, when one is protected from scale in; nothing is scaled', async () => {
    script({ group: { ...RUNNING, Instances: [inService(I1), inService(I2, true)] } });
    const error = await new ASGProvider()
      .delete('Asg', ASG, RESOURCE_TYPE, undefined, { stackDestroy: true })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ScaleInRefusal);
    const message = (error as Error).message;
    expect(message).toContain('Cannot delete AutoScalingGroup Asg');
    expect(message).toContain(`${I2} (InService)`);
    expect(message).not.toContain(I1);
    expect(message).toContain('--remove-protection');
    expect(isMarkedNonRetryable(error)).toBe(true);
    expect(names()).toEqual(['DeleteAutoScalingGroup', 'DescribeAutoScalingGroups']);
  });

  it('offers --remove-protection only on a destroy (a deploy replacement or rollback has no such flag)', async () => {
    script({ group: { ...RUNNING, Instances: [inService(I1, true)] } });
    const error = await new ASGProvider().delete('Asg', ASG, RESOURCE_TYPE).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ScaleInRefusal);
    expect((error as Error).message).not.toContain('--remove-protection');
  });

  it('refuses a group with an instance in Standby', async () => {
    script({
      group: { ...RUNNING, Instances: [{ ...inService(I1), LifecycleState: 'Standby' }] },
    });
    const error = await new ASGProvider().delete('Asg', ASG, RESOURCE_TYPE).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ScaleInRefusal);
    expect((error as Error).message).toContain(`${I1} (Standby)`);
    expect(names()).not.toContain('UpdateAutoScalingGroup');
  });

  it('refuses a group with a live warm pool, but waits out one already being deleted', async () => {
    script({ group: { ...RUNNING, WarmPoolConfiguration: { Status: undefined } } });
    const error = await new ASGProvider().delete('Asg', ASG, RESOURCE_TYPE).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ScaleInRefusal);
    expect((error as Error).message).toContain('warm pool');
    expect(names()).not.toContain('UpdateAutoScalingGroup');

    asgSend.mockReset();
    script({
      group: { ...RUNNING, WarmPoolConfiguration: { Status: 'PendingDelete' } },
      drain: [[]],
    });
    await new ASGProvider().delete('Asg', ASG, RESOURCE_TYPE);
    expect(names()).toContain('UpdateAutoScalingGroup');
  });

  it('refuses once every remaining instance became protected from scale in while draining', async () => {
    script({ group: RUNNING, drain: [[inService(I2, true)]] });
    const error = await new ASGProvider().delete('Asg', ASG, RESOURCE_TYPE).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ScaleInRefusal);
    expect((error as Error).message).toContain('after scaling it to 0');
    expect(names().filter((n) => n === 'DeleteAutoScalingGroup')).toHaveLength(1);
  });

  it('gives up after its budget, naming the instances a lifecycle hook still holds; terminal', async () => {
    let now = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    sleep.mockImplementation(async (ms: number) => {
      now += ms;
    });
    script({
      group: RUNNING,
      drain: [[{ ...inService(I1), LifecycleState: 'Terminating:Wait' }]],
    });
    const error = await new ASGProvider().delete('Asg', ASG, RESOURCE_TYPE).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ScaleInRefusal);
    const message = (error as Error).message;
    expect(message).toContain(`within ${SCALE_IN_WAIT_MS / 60_000} minutes`);
    expect(message).toContain(`${I1} (Terminating:Wait)`);
    expect(message).toContain('lifecycle hook');
    expect(isMarkedNonRetryable(error)).toBe(true);
    // Never deleted while instances remain.
    expect(names().filter((n) => n === 'DeleteAutoScalingGroup')).toHaveLength(1);
  });

  it('refuses, scaling nothing, when the live group is not the one the record created (ARN differs)', async () => {
    const ARN = (uuid: string): string =>
      `arn:aws:autoscaling:us-east-1:123456789012:autoScalingGroup:${uuid}:autoScalingGroupName/${ASG}`;
    script({ group: { ...RUNNING, AutoScalingGroupARN: ARN('other') } as Group, drain: [[]] });
    const error = await new ASGProvider()
      .delete('Asg', ASG, RESOURCE_TYPE, undefined, {
        stackDestroy: true,
        recordedAttributes: { Arn: ARN('mine') },
      })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ScaleInRefusal);
    const message = (error as Error).message;
    expect(message).toContain('not the one cdkd created');
    // Neither ARN (it embeds the name), and no ForceDelete remedy.
    expect(message).not.toContain('arn:aws');
    expect(message).not.toContain('--remove-protection');
    expect(isMarkedNonRetryable(error)).toBe(true);
    // go-to-k/cdkd#6468: read before the delete, refused before any write.
    expect(names()).toEqual(['DescribeAutoScalingGroups']);

    // The recorded ARN matching (or no recorded ARN at all) scales in as usual.
    for (const recordedAttributes of [{ Arn: ARN('mine') }, { AutoScalingGroupARN: ARN('mine') }, {}]) {
      asgSend.mockReset();
      script({ group: { ...RUNNING, AutoScalingGroupARN: ARN('mine') } as Group, drain: [[]] });
      await new ASGProvider().delete('Asg', ASG, RESOURCE_TYPE, undefined, { recordedAttributes });
      expect(names()).toContain('UpdateAutoScalingGroup');
    }
  });

  it('refuses a group with a retained instance (Terminating:Retained never finishes on its own)', async () => {
    script({
      group: { ...RUNNING, Instances: [{ ...inService(I1), LifecycleState: 'Terminating:Retained' }] },
    });
    const error = await new ASGProvider().delete('Asg', ASG, RESOURCE_TYPE).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ScaleInRefusal);
    expect((error as Error).message).toContain(`${I1} (Terminating:Retained)`);
    expect((error as Error).message).toContain('TerminateInstanceInAutoScalingGroup');
    expect(names()).not.toContain('UpdateAutoScalingGroup');
  });

  it('retries the scale-to-0 update while AWS answers ScalingActivityInProgress', async () => {
    script({ group: RUNNING, drain: [[]] });
    let updates = 0;
    const base = asgSend.getMockImplementation()!;
    asgSend.mockImplementation((command: Cmd) => {
      if (command.constructor.name === 'UpdateAutoScalingGroupCommand' && ++updates <= 2) {
        return Promise.reject(activity());
      }
      return base(command);
    });
    await new ASGProvider().delete('Asg', ASG, RESOURCE_TYPE);
    expect(updates).toBe(3);
    expect(names().filter((n) => n === 'DeleteAutoScalingGroup')).toHaveLength(2);
  });

  it('sends no update once the per-resource deadline has expired', async () => {
    deadline.expired = true;
    deadline.remainingMs = 0;
    script({ group: RUNNING });
    const error = await new ASGProvider().delete('Asg', ASG, RESOURCE_TYPE).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ScaleInRefusal);
    expect((error as Error).message).toContain('--resource-timeout');
    expect((error as Error).message).toContain('nothing was changed');
    expect(names()).not.toContain('UpdateAutoScalingGroup');
  });

  it('a deadline expiring while the update is retried ends in the worded refusal, not the AWS error', async () => {
    script({ group: RUNNING });
    const base = asgSend.getMockImplementation()!;
    asgSend.mockImplementation((command: Cmd) => {
      if (command.constructor.name === 'UpdateAutoScalingGroupCommand') {
        deadline.expired = true;
        return Promise.reject(activity());
      }
      return base(command);
    });
    const error = await new ASGProvider().delete('Asg', ASG, RESOURCE_TYPE).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ScaleInRefusal);
    expect((error as Error).message).toContain('nothing was changed');
    expect(names().filter((n) => n === 'UpdateAutoScalingGroup')).toHaveLength(1);
  });

  it('sends no retried delete when the deadline expires while the group drains', async () => {
    script({ group: RUNNING, drain: [[]] });
    sleep.mockImplementation(async () => {
      deadline.expired = true;
    });
    const error = await new ASGProvider().delete('Asg', ASG, RESOURCE_TYPE).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ScaleInRefusal);
    expect((error as Error).message).toContain('cdkd sent no delete');
    expect(names().filter((n) => n === 'DeleteAutoScalingGroup')).toHaveLength(1);
  });

  it('bounds the wait by what the per-resource deadline leaves', async () => {
    let now = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    sleep.mockImplementation(async (ms: number) => {
      now += ms;
    });
    deadline.remainingMs = 120_000;
    script({ group: RUNNING, drain: [[{ ...inService(I1), LifecycleState: 'Terminating:Wait' }]] });
    const error = await new ASGProvider().delete('Asg', ASG, RESOURCE_TYPE).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ScaleInRefusal);
    expect((error as Error).message).toContain('within 2 minutes');
    expect(now - 1_000_000).toBeLessThan(120_000 + 15_000);
  });

  it('a recorded ARN on an empty group: one describe before the delete, and a mismatch deletes nothing (#6468)', async () => {
    const ARN = (uuid: string): string =>
      `arn:aws:autoscaling:us-east-1:123456789012:autoScalingGroup:${uuid}:autoScalingGroupName/${ASG}`;
    const empty = { ...RUNNING, MinSize: 0, MaxSize: 0, DesiredCapacity: 0, Instances: [] };
    script({ group: { ...empty, AutoScalingGroupARN: ARN('mine') } as Group, deleteErrors: [undefined] });
    await new ASGProvider().delete('Asg', ASG, RESOURCE_TYPE, undefined, {
      recordedAttributes: { Arn: ARN('mine') },
    });
    expect(names()).toEqual([
      'DescribeAutoScalingGroups',
      'DeleteAutoScalingGroup',
      'DescribeAutoScalingGroups',
    ]);

    asgSend.mockReset();
    script({ group: { ...empty, AutoScalingGroupARN: ARN('other') } as Group, deleteErrors: [undefined] });
    const error = await new ASGProvider()
      .delete('Asg', ASG, RESOURCE_TYPE, undefined, { recordedAttributes: { Arn: ARN('mine') } })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ScaleInRefusal);
    expect(names()).toEqual(['DescribeAutoScalingGroups']);
  });

  it('--remove-protection: a recorded-ARN mismatch refuses before the protection flip, the instance flips and the force delete (#6468)', async () => {
    const ARN = (uuid: string): string =>
      `arn:aws:autoscaling:us-east-1:123456789012:autoScalingGroup:${uuid}:autoScalingGroupName/${ASG}`;
    script({
      group: { ...RUNNING, DeletionProtection: 'prevent-all-deletion', AutoScalingGroupARN: ARN('other') } as Group,
      deleteErrors: [undefined],
    });
    const error = await new ASGProvider()
      .delete('Asg', ASG, RESOURCE_TYPE, undefined, {
        removeProtection: true,
        stackDestroy: true,
        recordedAttributes: { Arn: ARN('mine') },
      })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ScaleInRefusal);
    expect((error as Error).message).toContain('not the one cdkd created');
    expect((error as Error).message).not.toContain('--remove-protection');
    expect(names()).toEqual(['DescribeAutoScalingGroups']);
  });

  it('a refusal after the scale-in names the capacity it scaled down from; one before it does not', async () => {
    let now = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    sleep.mockImplementation(async (ms: number) => {
      now += ms;
    });
    script({ group: RUNNING, drain: [[{ ...inService(I1), LifecycleState: 'Terminating:Wait' }]] });
    const after = await new ASGProvider().delete('Asg', ASG, RESOURCE_TYPE).catch((e: unknown) => e);
    expect((after as Error).message).toContain(
      'The group stays at capacity 0; before cdkd scaled it in it had MinSize 1 / MaxSize 2 / DesiredCapacity 2.'
    );

    asgSend.mockReset();
    script({ group: { ...RUNNING, Instances: [inService(I1, true)] } });
    const before = await new ASGProvider().delete('Asg', ASG, RESOURCE_TYPE).catch((e: unknown) => e);
    expect((before as Error).message).not.toContain('stays at capacity 0');
  });

  it('refuses, without waiting out the budget, when the capacity is raised again while it drains', async () => {
    // A clock, so a missing check ends in the timeout instead of spinning.
    let now = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    sleep.mockImplementation(async (ms: number) => {
      now += ms;
    });
    script({ group: RUNNING, drain: [[inService(I1)]] });
    let describes = 0;
    const base = asgSend.getMockImplementation()!;
    asgSend.mockImplementation((command: Cmd) => {
      if (command.constructor.name === 'DescribeAutoScalingGroupsCommand' && ++describes >= 2) {
        return Promise.resolve({
          AutoScalingGroups: [{ ...RUNNING, MinSize: 1, MaxSize: 1, DesiredCapacity: 1, Instances: [inService(I1)] }],
        });
      }
      return base(command);
    });
    const error = await new ASGProvider().delete('Asg', ASG, RESOURCE_TYPE).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ScaleInRefusal);
    expect((error as Error).message).toContain(
      'its capacity was raised again to MinSize 1 / MaxSize 1 / DesiredCapacity 1'
    );
    // Two polls in a row, not the whole budget.
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('one poll that still shows the old capacity (a lagging read) does not refuse', async () => {
    script({ group: RUNNING, drain: [[inService(I1)], []] });
    let describes = 0;
    const base = asgSend.getMockImplementation()!;
    asgSend.mockImplementation((command: Cmd) => {
      if (command.constructor.name === 'DescribeAutoScalingGroupsCommand' && ++describes === 2) {
        return Promise.resolve({ AutoScalingGroups: [{ ...RUNNING, Instances: [inService(I1)] }] });
      }
      return base(command);
    });
    await new ASGProvider().delete('Asg', ASG, RESOURCE_TYPE);
    expect(names().filter((n) => n === 'DeleteAutoScalingGroup')).toHaveLength(2);
  });

  it('--remove-protection with a recorded ARN: a failed group read sends no write at all (#6468)', async () => {
    const ARN = `arn:aws:autoscaling:us-east-1:123456789012:autoScalingGroup:mine:autoScalingGroupName/${ASG}`;
    script({ group: { ...RUNNING, AutoScalingGroupARN: ARN } as Group, deleteErrors: [undefined] });
    const base = asgSend.getMockImplementation()!;
    let describes = 0;
    asgSend.mockImplementation((command: Cmd) => {
      if (command.constructor.name === 'DescribeAutoScalingGroupsCommand' && ++describes === 1) {
        return Promise.reject(awsError('Throttling', 'Rate exceeded'));
      }
      return base(command);
    });
    const error = await new ASGProvider()
      .delete('Asg', ASG, RESOURCE_TYPE, undefined, {
        removeProtection: true,
        recordedAttributes: { Arn: ARN },
      })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(names()).toEqual(['DescribeAutoScalingGroups']);
  });

  it('a failed --remove-protection delete puts no guard back onto a group of the same name that is no longer the stack\'s (#6468)', async () => {
    const ARN = (uuid: string): string =>
      `arn:aws:autoscaling:us-east-1:123456789012:autoScalingGroup:${uuid}:autoScalingGroupName/${ASG}`;
    const mine = { ...RUNNING, DeletionProtection: 'prevent-all-deletion', Instances: [], AutoScalingGroupARN: ARN('mine') };
    let describes = 0;
    asgSend.mockImplementation((command: Cmd) => {
      switch (command.constructor.name) {
        case 'DescribeAutoScalingGroupsCommand':
          // The pre-read and the instance listing see the stack's group; the
          // compensation's re-check sees a replacement.
          return Promise.resolve({
            AutoScalingGroups: [++describes <= 2 ? mine : { ...mine, AutoScalingGroupARN: ARN('other') }],
          });
        case 'DeleteAutoScalingGroupCommand':
          return Promise.reject(awsError('AccessDenied', 'not authorized'));
        default:
          return Promise.resolve({});
      }
    });
    await new ASGProvider()
      .delete('Asg', ASG, RESOURCE_TYPE, undefined, {
        removeProtection: true,
        recordedAttributes: { Arn: ARN('mine') },
      })
      .catch(() => undefined);
    const restores = calls().filter(
      (c) =>
        c.constructor.name === 'UpdateAutoScalingGroupCommand' &&
        c.input.DeletionProtection === 'prevent-all-deletion'
    );
    expect(restores).toHaveLength(0);
    // Control: the flip itself was sent (the pre-read matched).
    expect(
      calls().some((c) => c.constructor.name === 'UpdateAutoScalingGroupCommand' && c.input.DeletionProtection === 'none')
    ).toBe(true);
  });

  it("a superseded row's in-use retry sends the delete ONCE for a stuck group (the refusal is terminal)", async () => {
    const defaults = { ...supersededInUseRetry };
    supersededInUseRetry.delayMs = 0;
    try {
      // `ResourceInUse` is a name the in-use classifier matches through the
      // refusal's cause chain.
      const inUse = awsError('ResourceInUse', 'You cannot delete an AutoScalingGroup while there are instances');
      script({ group: { ...RUNNING, Instances: [inService(I1, true)] }, deleteErrors: [inUse] });
      const outcome = await deleteSupersededEntry(
        {
          logicalId: 'Asg',
          supersededAt: 1,
          state: { physicalId: ASG, resourceType: RESOURCE_TYPE, properties: {}, attributes: {}, dependencies: [] },
        },
        { provider: new ASGProvider(), region: 'us-east-1', maskSecrets: (t) => t, stop: () => false }
      );
      expect(outcome.kind).toBe('failed');
      expect(supersededInUseRetry.attempts).toBeGreaterThan(1);
      expect(names().filter((n) => n === 'DeleteAutoScalingGroup')).toHaveLength(1);
    } finally {
      Object.assign(supersededInUseRetry, defaults);
    }
  });

  it('refuses, deleting nothing, when the group is replaced by another of the same name while it drains (#6468)', async () => {
    const ARN = (uuid: string): string =>
      `arn:aws:autoscaling:us-east-1:123456789012:autoScalingGroup:${uuid}:autoScalingGroupName/${ASG}`;
    // A clock, so a missing check ends in a wait timeout instead of spinning.
    let now = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    sleep.mockImplementation(async (ms: number) => {
      now += ms;
    });
    script({ group: { ...RUNNING, AutoScalingGroupARN: ARN('mine') } as Group, drain: [[]] });
    let describes = 0;
    const base = asgSend.getMockImplementation()!;
    asgSend.mockImplementation((command: Cmd) => {
      // 1: the plain delete's pre-read, 2: the scale-in's read, 3: the first poll.
      if (command.constructor.name === 'DescribeAutoScalingGroupsCommand' && ++describes >= 3) {
        return Promise.resolve({
          AutoScalingGroups: [
            { ...RUNNING, MinSize: 0, MaxSize: 0, DesiredCapacity: 0, Instances: [], AutoScalingGroupARN: ARN('other') },
          ],
        });
      }
      return base(command);
    });
    const error = await new ASGProvider()
      .delete('Asg', ASG, RESOURCE_TYPE, undefined, { recordedAttributes: { Arn: ARN('mine') } })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ScaleInRefusal);
    expect((error as Error).message).toContain('not the one cdkd created');
    // Only the first, refused, delete: none after the swap.
    expect(names().filter((n) => n === 'DeleteAutoScalingGroup')).toHaveLength(1);
  });

  it('returns when the group goes while it drains', async () => {
    script({ group: RUNNING });
    let describes = 0;
    const base = asgSend.getMockImplementation()!;
    asgSend.mockImplementation((command: Cmd) => {
      if (command.constructor.name === 'DescribeAutoScalingGroupsCommand' && ++describes >= 2) {
        return Promise.resolve({ AutoScalingGroups: [] });
      }
      return base(command);
    });
    await expect(new ASGProvider().delete('Asg', ASG, RESOURCE_TYPE)).resolves.toBeUndefined();
  });

  it('--remove-protection keeps the ForceDelete path: a refusal there is not scaled in', async () => {
    script({ group: RUNNING, deleteErrors: [notEmpty()] });
    await new ASGProvider()
      .delete('Asg', ASG, RESOURCE_TYPE, undefined, { removeProtection: true })
      .catch(() => undefined);
    const updates = calls().filter((c) => c.constructor.name === 'UpdateAutoScalingGroupCommand');
    expect(updates.every((u) => !('DesiredCapacity' in u.input))).toBe(true);
  });

  it('any other delete failure is wrapped as before, with no scale-in', async () => {
    script({ group: RUNNING, deleteErrors: [awsError('AccessDenied', 'not authorized')] });
    const error = await new ASGProvider().delete('Asg', ASG, RESOURCE_TYPE).catch((e: unknown) => e);
    expect(error).not.toBeInstanceOf(ScaleInRefusal);
    expect(names()).toEqual(['DeleteAutoScalingGroup']);
  });

  it('passes the info line and refusals through the delete context masker', async () => {
    const maskSecrets = (t: string): string => t.split(I1).join('***');
    script({ group: { ...RUNNING, Instances: [inService(I1, true)] } });
    const error = await new ASGProvider()
      .delete('Asg', ASG, RESOURCE_TYPE, undefined, { maskSecrets })
      .catch((e: unknown) => e);
    expect((error as Error).message).toContain('*** (InService)');
    expect((error as Error).message).not.toContain(I1);

    asgSend.mockReset();
    script({ group: RUNNING, drain: [[]] });
    await new ASGProvider().delete('Asg', ASG, RESOURCE_TYPE, undefined, {
      maskSecrets: (t: string) => t.split('Asg').join('***'),
    });
    expect(childLogger.info).toHaveBeenCalledWith(
      'Scaling AutoScalingGroup *** to 0 and waiting for its 2 instance(s) to terminate before deleting it'
    );
  });
});

describe('scale-in helpers', () => {
  it('matches both spellings of the not-empty refusals only', () => {
    for (const name of [
      'ResourceInUse',
      'ResourceInUseFault',
      'ScalingActivityInProgress',
      'ScalingActivityInProgressFault',
    ]) {
      expect(isGroupNotEmptyRefusal(awsError(name, 'x'))).toBe(true);
    }
    expect(isGroupNotEmptyRefusal(awsError('ValidationError', 'x'))).toBe(false);
    expect(isGroupNotEmptyRefusal('ResourceInUse')).toBe(false);
  });

  it('a terminating instance never blocks, whatever its protection', () => {
    expect(
      instancesScaleInCannotTerminate([
        { InstanceId: 'a', LifecycleState: 'Terminating:Wait', ProtectedFromScaleIn: true },
        { InstanceId: 'b', LifecycleState: 'Pending', ProtectedFromScaleIn: false },
        { InstanceId: 'c', LifecycleState: 'EnteringStandby', ProtectedFromScaleIn: false },
        { InstanceId: 'd', LifecycleState: 'Pending', ProtectedFromScaleIn: true },
        { InstanceId: 'e', LifecycleState: 'Detaching', ProtectedFromScaleIn: true },
        { InstanceId: 'f', LifecycleState: 'Terminating:Retained', ProtectedFromScaleIn: false },
      ]).map((i) => i.InstanceId)
    ).toEqual(['c', 'd', 'f']);
  });
});
