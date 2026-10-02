/**
 * `--remove-protection` compensation on the EC2 instances an
 * `AWS::AutoScaling::AutoScalingGroup` launched (issue #2204).
 *
 * The group's delete turns each launched instance's `DisableApiTermination`
 * off before `DeleteAutoScalingGroup(ForceDelete)` (issue #796). When that
 * delete then fails TERMINALLY, the instances are still live, so each one this
 * run turned off must be turned back on — from its own record, with the same
 * gates as every other adopter: observed ON before the flip, flip accepted,
 * delete not accepted, failure terminal. The group's own `DeletionProtection`
 * restore is fenced in `elbv2-asg-remove-protection-compensate.test.ts`; the
 * mechanism's own cases in `dynamodb-remove-protection-compensate.test.ts`.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const asgSend = vi.hoisted(() => vi.fn());
const ec2Send = vi.hoisted(() => vi.fn());

vi.mock('@aws-sdk/client-auto-scaling', async (importOriginal) => {
  const orig = (await importOriginal()) as Record<string, unknown>;
  return {
    ...orig,
    AutoScalingClient: vi.fn().mockImplementation(() => ({
      send: asgSend,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
  };
});

vi.mock('@aws-sdk/client-ec2', async (importOriginal) => {
  const orig = (await importOriginal()) as Record<string, unknown>;
  return {
    ...orig,
    EC2Client: vi.fn().mockImplementation(() => ({
      send: ec2Send,
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

import {
  ASGProvider,
  autoScalingGroupInstanceProtectionSite,
} from '../../../../src/provisioning/providers/asg-provider.js';

type Cmd = { constructor: { name: string }; input: Record<string, unknown> };

const RESOURCE_TYPE = 'AWS::AutoScaling::AutoScalingGroup';
const ASG = 'my-asg';
const I1 = 'i-0aaaaaaaaaaaaaaa1';
const I2 = 'i-0bbbbbbbbbbbbbbb2';
const CTX = { removeProtection: true, expectedRegion: 'us-east-1' };
const SUBJECT = 'EC2 Instance launched by AutoScalingGroup Asg';

/** A group delete refusal matching no retryable pattern: TERMINAL. */
function terminalRefusal(): Error {
  const e = new Error(
    `Cannot delete Auto Scaling group ${ASG} because its deletion protection is enabled`
  );
  e.name = 'ValidationError';
  return e;
}
const REFUSAL = 'because its deletion protection is enabled';

function throttle(): Error {
  const e = new Error('Rate exceeded');
  e.name = 'Throttling';
  return e;
}

interface Script {
  /** Each instance's `DisableApiTermination` before the run (true = ON). */
  guards: Record<string, boolean>;
  /** The instance ids each successive group describe lists; the last one repeats. */
  listed?: string[][];
  /** The group's own `DeletionProtection` before the run. */
  groupGuard?: string;
  /** One entry per `DeleteAutoScalingGroup` call: an error to throw, or undefined to accept. */
  deletes?: (Error | undefined)[];
  /** The instance attribute read throws this. */
  observe?: Error;
  /** The instance flip-off throws this. */
  disable?: Error;
  /** The instance re-enable throws this; a map scopes it to the instances it names. */
  reEnable?: Error | Record<string, Error>;
  /** The GROUP's `DeletionProtection` re-enable throws this. */
  groupReEnable?: Error;
  /** Each instance's `State.Name` as `DescribeInstances` reports it (default `running`). */
  instanceStates?: Record<string, string>;
  /** `DescribeInstances` throws this. */
  describeInstances?: Error;
}

/** Route every command by name; the fake services hold state across calls. */
function script(s: Script): void {
  const guards = { ...s.guards };
  // The group's guard as the fake service holds it: a landed update changes
  // what every LATER describe reads.
  let groupGuard = s.groupGuard ?? 'none';
  let describes = 0;
  let deleteCalls = 0;
  let gone = false;
  const listed = s.listed ?? [Object.keys(s.guards)];
  asgSend.mockImplementation(async (cmd: Cmd) => {
    switch (cmd.constructor.name) {
      case 'DescribeAutoScalingGroupsCommand': {
        if (gone) return { AutoScalingGroups: [] };
        const ids = listed[Math.min(describes, listed.length - 1)] ?? [];
        describes += 1;
        return {
          AutoScalingGroups: [
            {
              AutoScalingGroupName: ASG,
              DeletionProtection: groupGuard,
              Instances: ids.map((InstanceId) => ({ InstanceId })),
            },
          ],
        };
      }
      case 'UpdateAutoScalingGroupCommand': {
        const level = cmd.input['DeletionProtection'];
        if (level !== undefined && level !== 'none' && s.groupReEnable) throw s.groupReEnable;
        if (typeof level === 'string') groupGuard = level;
        return {};
      }
      case 'DeleteAutoScalingGroupCommand': {
        const outcome = s.deletes?.[deleteCalls];
        deleteCalls += 1;
        if (outcome) throw outcome;
        gone = true;
        return {};
      }
      default:
        throw new Error(`unexpected ASG command ${cmd.constructor.name}`);
    }
  });
  ec2Send.mockImplementation(async (cmd: Cmd) => {
    const id = cmd.input['InstanceId'] as string;
    switch (cmd.constructor.name) {
      case 'DescribeInstancesCommand': {
        if (s.describeInstances) throw s.describeInstances;
        const ids = cmd.input['InstanceIds'] as string[];
        return {
          Reservations: [
            {
              Instances: ids.map((InstanceId) => ({
                InstanceId,
                State: { Name: s.instanceStates?.[InstanceId] ?? 'running' },
              })),
            },
          ],
        };
      }
      case 'DescribeInstanceAttributeCommand':
        if (s.observe) throw s.observe;
        return { DisableApiTermination: { Value: guards[id] ?? false } };
      case 'ModifyInstanceAttributeCommand': {
        const value = (cmd.input['DisableApiTermination'] as { Value: boolean }).Value;
        if (!value && s.disable) throw s.disable;
        if (value && s.reEnable) {
          if (s.reEnable instanceof Error) throw s.reEnable;
          const scoped = s.reEnable[id];
          if (scoped) throw scoped;
        }
        guards[id] = value;
        return {};
      }
      default:
        throw new Error(`unexpected EC2 command ${cmd.constructor.name}`);
    }
  });
}

function ec2Calls(): Cmd[] {
  return ec2Send.mock.calls.map((c) => c[0] as Cmd);
}

/** The instance re-enables, as the ids they targeted. */
function reEnabled(): string[] {
  return ec2Calls()
    .filter(
      (c) =>
        c.constructor.name === 'ModifyInstanceAttributeCommand' &&
        (c.input['DisableApiTermination'] as { Value: boolean }).Value === true
    )
    .map((c) => c.input['InstanceId'] as string);
}

function disabled(): string[] {
  return ec2Calls()
    .filter(
      (c) =>
        c.constructor.name === 'ModifyInstanceAttributeCommand' &&
        (c.input['DisableApiTermination'] as { Value: boolean }).Value === false
    )
    .map((c) => c.input['InstanceId'] as string);
}

function instanceRegistrySize(provider: ASGProvider): number {
  return (provider as unknown as { instanceProtectionFlips: { size: number } })
    .instanceProtectionFlips.size;
}

function warnLines(): string[] {
  return childLogger.warn.mock.calls.map((c) => String(c[0]));
}

function errorLines(): string[] {
  return childLogger.error.mock.calls.map((c) => String(c[0]));
}

const del = (provider: ASGProvider, context: Record<string, unknown> = CTX) =>
  provider
    .delete('Asg', ASG, RESOURCE_TYPE, undefined, context as never)
    .then(() => undefined)
    .catch((e: unknown) => e);

beforeEach(() => {
  vi.clearAllMocks();
  asgSend.mockReset();
  ec2Send.mockReset();
});

describe('AutoScalingGroup instances: --remove-protection compensation (issue #2204)', () => {
  it('restores DisableApiTermination on an instance this run turned off when the group delete fails terminally, re-throwing the ORIGINAL error', async () => {
    script({ guards: { [I1]: true }, deletes: [terminalRefusal()] });
    const provider = new ASGProvider();

    const thrown = await del(provider);

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain(REFUSAL);
    // The thrown message is never annotated with the compensation's text.
    expect((thrown as Error).message).not.toContain('re-enabled');
    expect(disabled()).toEqual([I1]);
    expect(reEnabled()).toEqual([I1]);
    expect(warnLines()).toContainEqual(
      `${SUBJECT}: the delete failed after --remove-protection had turned DisableApiTermination off, so it was re-enabled on ${I1}. The delete failure below is the outcome.`
    );
    // Restored, so the record is released.
    expect(instanceRegistrySize(provider)).toBe(0);
  });

  it('restores only the instances whose guard was ON before the run (NEGATIVE CONTROL in the same group)', async () => {
    script({ guards: { [I1]: true, [I2]: false }, deletes: [terminalRefusal()] });
    const provider = new ASGProvider();

    await del(provider);

    // Both are flipped (idempotent), but only the one observed ON is put back.
    expect(disabled()).toEqual([I1, I2]);
    expect(reEnabled()).toEqual([I1]);
    expect(instanceRegistrySize(provider)).toBe(0);
  });

  it('a group delete that SUCCEEDS restores nothing and leaves no record behind', async () => {
    script({ guards: { [I1]: true, [I2]: true } });
    const provider = new ASGProvider();

    expect(await del(provider)).toBeUndefined();

    expect(disabled()).toEqual([I1, I2]);
    expect(reEnabled()).toEqual([]);
    expect(instanceRegistrySize(provider)).toBe(0);
  });

  it('never compensates when the instance readback failed ("do not know")', async () => {
    const denied = new Error('not authorized to perform: ec2:DescribeInstanceAttribute');
    denied.name = 'UnauthorizedOperation';
    script({ guards: { [I1]: true }, observe: denied, deletes: [terminalRefusal()] });

    const thrown = await del(new ASGProvider());

    expect((thrown as Error).message).toContain(REFUSAL);
    expect(disabled()).toEqual([I1]);
    expect(reEnabled()).toEqual([]);
  });

  it('does not compensate a flip EC2 rejected', async () => {
    const refused = new Error('The instance is not in a valid state');
    refused.name = 'IncorrectInstanceState';
    script({ guards: { [I1]: true }, disable: refused, deletes: [terminalRefusal()] });

    const thrown = await del(new ASGProvider());

    // The group delete still ran and refused: the flip failure did not end it early.
    expect((thrown as Error).message).toContain(REFUSAL);
    expect(disabled()).toEqual([I1]);
    expect(reEnabled()).toEqual([]);
  });

  it('does not compensate once AWS ACCEPTED the group delete (the instances are being terminated with it)', async () => {
    script({ guards: { [I1]: true } });
    const provider = new ASGProvider();
    vi.spyOn(
      provider as unknown as { waitForGroupDeleted: () => Promise<void> },
      'waitForGroupDeleted'
    ).mockRejectedValue(new Error(`Timed out waiting for AutoScalingGroup ${ASG} to be deleted`));

    const thrown = await del(provider);

    expect((thrown as Error).message).toContain('Timed out waiting');
    expect(reEnabled()).toEqual([]);
    expect(warnLines().filter((l) => l.startsWith(SUBJECT))).toEqual([]);
    // Settled for good (the delete was accepted): no record is left owing a re-enable.
    expect(instanceRegistrySize(provider)).toBe(0);
  });

  it('reads, flips and compensates nothing on the instances without --remove-protection', async () => {
    script({ guards: { [I1]: true }, deletes: [terminalRefusal()] });

    const thrown = await del(new ASGProvider(), { expectedRegion: 'us-east-1' });

    // The delete was reached and refused (not an early throw), as a plain delete.
    expect((thrown as Error).message).toContain(REFUSAL);
    const deletes = asgSend.mock.calls
      .map((c) => c[0] as Cmd)
      .filter((c) => c.constructor.name === 'DeleteAutoScalingGroupCommand');
    expect(deletes.map((c) => c.input['ForceDelete'])).toEqual([false]);
    expect(ec2Calls()).toEqual([]);
  });

  it('holds the flip across a RETRYABLE failure, so the re-entered terminal failure still restores it', async () => {
    script({ guards: { [I1]: true }, deletes: [throttle(), terminalRefusal()] });
    const provider = new ASGProvider();

    const first = await del(provider);
    expect((first as Error).message).toContain('Rate exceeded');
    // Retryable: a re-entry is coming, so nothing is put back yet.
    expect(reEnabled()).toEqual([]);
    expect(instanceRegistrySize(provider)).toBe(1);

    // Attempt 2 reads the guard OFF -- attempt 1 is why -- and must not erase
    // what attempt 1 recorded.
    const second = await del(provider);
    expect((second as Error).message).toContain(REFUSAL);
    expect(reEnabled()).toEqual([I1]);
    expect(instanceRegistrySize(provider)).toBe(0);
  });

  it('restores an instance an EARLIER attempt flipped even when the re-entered attempt no longer lists it', async () => {
    // Each attempt describes twice (the group guard's readback, then the
    // instance enumeration): attempt 1 lists I1, attempt 2 lists only a
    // replacement I2 -- so an attempt-2 record set that REPLACED attempt 1's
    // would lose I1.
    script({
      guards: { [I1]: true, [I2]: false },
      listed: [[I1], [I1], [I2]],
      deletes: [throttle(), terminalRefusal()],
    });
    const provider = new ASGProvider();

    await del(provider);
    await del(provider);

    expect(disabled()).toEqual([I1, I2]);
    expect(reEnabled()).toEqual([I1]);
  });

  it('a FAILED re-enable is an ERROR line naming the restore command, keeps the record, and the original error still wins', async () => {
    const boom = new Error('Internal error');
    boom.name = 'InternalError';
    script({ guards: { [I1]: true }, reEnable: boom, deletes: [terminalRefusal()] });
    const provider = new ASGProvider();

    const thrown = await del(provider);

    expect((thrown as Error).message).toContain(REFUSAL);
    expect(errorLines()).toHaveLength(1);
    expect(errorLines()[0]).toContain(
      `${SUBJECT}: could NOT re-enable DisableApiTermination on ${I1} after the delete failed`
    );
    expect(errorLines()[0]).toContain(
      `aws ec2 modify-instance-attribute --instance-id ${I1} --region us-east-1 --disable-api-termination`
    );
    // cdkd still owes this instance a re-enable: the record is kept.
    expect(instanceRegistrySize(provider)).toBe(1);
  });

  it('a not-found re-enable is a WARN naming the check command, not an ERROR, and keeps the record', async () => {
    const gone = new Error(`The instance ID '${I1}' does not exist`);
    gone.name = 'InvalidInstanceID.NotFound';
    script({ guards: { [I1]: true }, reEnable: gone, deletes: [terminalRefusal()] });
    const provider = new ASGProvider();

    const thrown = await del(provider);

    expect((thrown as Error).message).toContain(REFUSAL);
    expect(errorLines()).toEqual([]);
    const line = warnLines().find((l) =>
      l.startsWith(`${SUBJECT}: could not re-enable DisableApiTermination on ${I1}`)
    );
    expect(line).toBeDefined();
    expect(line).toContain(
      `Check with: aws ec2 describe-instance-attribute --instance-id ${I1} --region us-east-1 --attribute disableApiTermination`
    );
    expect(instanceRegistrySize(provider)).toBe(1);
  });

  it('one instance whose re-enable fails does not stop the others from being restored', async () => {
    const boom = new Error('Internal error');
    boom.name = 'InternalError';
    script({
      guards: { [I1]: true, [I2]: true },
      reEnable: { [I1]: boom },
      deletes: [terminalRefusal()],
    });
    const provider = new ASGProvider();

    await del(provider);

    expect(reEnabled()).toEqual([I1, I2]);
    expect(errorLines()).toHaveLength(1);
    expect(errorLines()[0]).toContain(`could NOT re-enable DisableApiTermination on ${I1}`);
    expect(warnLines()).toContainEqual(
      `${SUBJECT}: the delete failed after --remove-protection had turned DisableApiTermination off, so it was re-enabled on ${I2}. The delete failure below is the outcome.`
    );
    // Only the failed one is still owed.
    expect(instanceRegistrySize(provider)).toBe(1);
  });

  it('an instance already restored is not restored again by a later delete that reuses a KEPT group record', async () => {
    // The group's own re-enable fails, so its record is kept; the instance's
    // succeeds, so its record is settled for good. A later delete reusing the
    // group record, whose describe no longer lists the instance, must not
    // write the instance guard a second time.
    const boom = new Error('Internal error');
    boom.name = 'InternalError';
    script({
      guards: { [I1]: true },
      groupGuard: 'prevent-force-deletion',
      groupReEnable: boom,
      listed: [[I1], [I1], []],
      deletes: [terminalRefusal(), terminalRefusal()],
    });
    const provider = new ASGProvider();

    await del(provider);
    expect(reEnabled()).toEqual([I1]);
    await del(provider);

    expect(reEnabled()).toEqual([I1]);
  });

  it('restores the group guard AND the instance guard when both were turned off', async () => {
    script({
      guards: { [I1]: true },
      groupGuard: 'prevent-force-deletion',
      deletes: [terminalRefusal()],
    });

    await del(new ASGProvider());

    expect(reEnabled()).toEqual([I1]);
    const groupRestores = asgSend.mock.calls
      .map((c) => c[0] as Cmd)
      .filter(
        (c) =>
          c.constructor.name === 'UpdateAutoScalingGroupCommand' &&
          c.input['DeletionProtection'] === 'prevent-force-deletion'
      );
    expect(groupRestores).toHaveLength(1);
  });

  it('the instance flip record is keyed by region: a retained record is not inherited in another region', async () => {
    script({ guards: { [I1]: true }, deletes: [throttle(), terminalRefusal()] });
    const provider = new ASGProvider();

    expect(((await del(provider)) as Error).message).toContain('Rate exceeded');
    // Same instance id, another region: attempt 2 reads the guard OFF and has
    // no record of its own saying it was on, so nothing is restored there.
    const thrown = await del(provider, { removeProtection: true, expectedRegion: 'eu-west-1' });

    expect((thrown as Error).message).toContain(REFUSAL);
    expect(reEnabled()).toEqual([]);
  });

  it('releases the instance records when the group is already gone (NotFound), restoring nothing', async () => {
    const missing = new Error(`AutoScalingGroup name not found - ${ASG}`);
    missing.name = 'ValidationError';
    script({ guards: { [I1]: true }, deletes: [missing] });
    const provider = new ASGProvider();

    expect(await del(provider)).toBeUndefined();

    expect(disabled()).toEqual([I1]);
    expect(reEnabled()).toEqual([]);
    expect(instanceRegistrySize(provider)).toBe(0);
  });

  it.each(['shutting-down', 'terminated'])('an instance the group took to %s before the re-enable is the WARN "gone" arm, never the ERROR claiming it is LIVE', async (state) => {
    // The write to a terminated-but-describable instance fails with something
    // other than InvalidInstanceID.NotFound; the readback of its state decides.
    const refused = new Error('The instance is not in a valid state for this operation');
    refused.name = 'IncorrectInstanceState';
    script({
      guards: { [I1]: true },
      reEnable: refused,
      instanceStates: { [I1]: state },
      deletes: [terminalRefusal()],
    });
    const provider = new ASGProvider();

    const thrown = await del(provider);

    expect((thrown as Error).message).toContain(REFUSAL);
    expect(errorLines()).toEqual([]);
    const line = warnLines().find((l) =>
      l.startsWith(`${SUBJECT}: could not re-enable DisableApiTermination on ${I1}`)
    );
    expect(line).toContain('reports it shutting-down or terminated');
    expect(line).toContain(`instance ${I1} is ${state}`);
    expect(instanceRegistrySize(provider)).toBe(1);
  });

  it.each([
    ['the instance still reads running', { instanceStates: { [I1]: 'running' } }],
    [
      'the state readback itself fails',
      {
        describeInstances: Object.assign(new Error('Request limit exceeded.'), {
          name: 'RequestLimitExceeded',
        }),
      },
    ],
  ])('a failed re-enable stays the ERROR line when %s', async (_label, extra) => {
    const refused = new Error('The instance is not in a valid state for this operation');
    refused.name = 'IncorrectInstanceState';
    script({ guards: { [I1]: true }, reEnable: refused, deletes: [terminalRefusal()], ...extra });

    await del(new ASGProvider());

    expect(errorLines()).toHaveLength(1);
    expect(errorLines()[0]).toContain(
      `${SUBJECT}: could NOT re-enable DisableApiTermination on ${I1} after the delete failed`
    );
    // The write's OWN error, not a synthesized "gone" one.
    expect(errorLines()[0]).toContain('(The instance is not in a valid state for this operation)');
  });
});

describe('autoScalingGroupInstanceProtectionSite', () => {
  it('names the group-launched instance and renders the EC2 commands with --region', () => {
    const site = autoScalingGroupInstanceProtectionSite(I1, 'us-east-1');
    expect(site.subject).toBe('EC2 Instance launched by AutoScalingGroup');
    expect(site.guardName).toBe('DisableApiTermination');
    expect(site.commands()).toEqual({
      check: `aws ec2 describe-instance-attribute --instance-id ${I1} --region us-east-1 --attribute disableApiTermination`,
      restoreAfterNotFound: `aws ec2 modify-instance-attribute --instance-id ${I1} --region us-east-1 --disable-api-termination`,
      restoreLive: `aws ec2 modify-instance-attribute --instance-id ${I1} --region us-east-1 --disable-api-termination`,
    });
  });
});
