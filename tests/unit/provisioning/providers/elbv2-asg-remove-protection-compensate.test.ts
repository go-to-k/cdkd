/**
 * `--remove-protection` compensation on `AWS::ElasticLoadBalancingV2::LoadBalancer`
 * and `AWS::AutoScaling::AutoScalingGroup` (issue #2204).
 *
 * Every site runs the SAME cases, so a site that loses its readback, its
 * `deleteAccepted` latch or its boundary goes red on its own row. The
 * mechanism's own cases (gates, outcome split, logger-throw) are fenced in
 * `dynamodb-remove-protection-compensate.test.ts` and
 * `rds-family-remove-protection-compensate.test.ts`; this file fences that
 * each of these two sites is WIRED to it, plus the Auto Scaling group's own
 * wrinkle: its guard has two "on" levels, and the restore must put back the
 * one the flip removed.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const elbv2Send = vi.fn();
const asgSend = vi.fn();

vi.mock('@aws-sdk/client-elastic-load-balancing-v2', async (importOriginal) => {
  const orig = (await importOriginal()) as Record<string, unknown>;
  return {
    ...orig,
    ElasticLoadBalancingV2Client: vi.fn().mockImplementation(() => ({
      send: elbv2Send,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
  };
});

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

const childLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: vi.fn().mockReturnThis(),
};
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
  ELBv2Provider,
  loadBalancerProtectionSite,
} from '../../../../src/provisioning/providers/elbv2-provider.js';
import {
  ASGProvider,
  autoScalingGroupProtectionSite,
} from '../../../../src/provisioning/providers/asg-provider.js';
import { WITHHELD_AWS_COMMAND } from '../../../../src/provisioning/replacement-protection-advice.js';

type Cmd = { constructor: { name: string }; input: Record<string, unknown> };

interface Site {
  readonly name: string;
  readonly resourceType: string;
  readonly physicalId: string;
  readonly send: ReturnType<typeof vi.fn>;
  readonly make: () => {
    delete: (
      logicalId: string,
      physicalId: string,
      resourceType: string,
      properties?: Record<string, unknown>,
      context?: Record<string, unknown>
    ) => Promise<unknown>;
  };
  readonly describe: string;
  /** The readback's answer for a guard that is ON / OFF; `gone` once the delete landed. */
  readonly describeReply: (on: boolean, gone: boolean) => unknown;
  readonly modify: string;
  /** Whether a `modify` call turns the guard OFF (else it is the re-enable). */
  readonly isDisable: (cmd: Cmd) => boolean;
  /** What the re-enable must carry: the target AND the value. */
  readonly reEnableInput: Record<string, unknown>;
  readonly del: string;
  /** Every command a terminally refused delete issues, in order, re-enable included. */
  readonly terminalSequence: readonly string[];
  /** The line the delete logs right after AWS accepted it. */
  readonly acceptedLine: string;
  readonly subject: string;
  readonly guardName: string;
  /** The restore command the ERROR line must render, `--region` included. */
  readonly restoreCommand: string;
  readonly checkCommand: string;
  /** The service's not-found answer, as its SDK spells it. */
  readonly sdkNotFound: () => Error;
  /** The phrase the not-found arm uses for what the service answered. */
  readonly notFoundPhrase: string;
}

const LB_ARN =
  'arn:aws:elasticloadbalancing:us-east-1:123456789012:loadbalancer/net/my-nlb/0123456789abcdef';
const ASG = 'my-asg';

const SITES: readonly Site[] = [
  {
    name: 'ELBv2 LoadBalancer',
    resourceType: 'AWS::ElasticLoadBalancingV2::LoadBalancer',
    physicalId: LB_ARN,
    send: elbv2Send,
    make: () => new ELBv2Provider(),
    describe: 'DescribeLoadBalancerAttributesCommand',
    // A decoy attribute carries the OPPOSITE 'true'/'false', so a readback
    // that matched any `Value: 'true'` rather than the guard's own key answers
    // wrong on one polarity.
    describeReply: (on) => ({
      Attributes: [
        { Key: 'access_logs.s3.enabled', Value: on ? 'false' : 'true' },
        { Key: 'deletion_protection.enabled', Value: on ? 'true' : 'false' },
      ],
    }),
    modify: 'ModifyLoadBalancerAttributesCommand',
    isDisable: (cmd) =>
      (cmd.input['Attributes'] as Array<{ Value?: string }> | undefined)?.[0]?.Value === 'false',
    reEnableInput: {
      LoadBalancerArn: LB_ARN,
      Attributes: [{ Key: 'deletion_protection.enabled', Value: 'true' }],
    },
    del: 'DeleteLoadBalancerCommand',
    terminalSequence: [
      'DescribeLoadBalancerAttributesCommand',
      'ModifyLoadBalancerAttributesCommand',
      'DeleteLoadBalancerCommand',
      'ModifyLoadBalancerAttributesCommand',
    ],
    acceptedLine: 'Successfully deleted LoadBalancer',
    subject: 'ELBv2 LoadBalancer',
    guardName: 'deletion_protection.enabled',
    restoreCommand: `aws elbv2 modify-load-balancer-attributes --load-balancer-arn ${LB_ARN} --region us-east-1 --attributes Key=deletion_protection.enabled,Value=true`,
    checkCommand: `aws elbv2 describe-load-balancer-attributes --load-balancer-arn ${LB_ARN} --region us-east-1`,
    sdkNotFound: () =>
      Object.assign(new Error('One or more load balancers not found'), {
        name: 'LoadBalancerNotFoundException',
      }),
    notFoundPhrase: 'ELBv2 answered LoadBalancerNotFound',
  },
  {
    name: 'AutoScalingGroup',
    resourceType: 'AWS::AutoScaling::AutoScalingGroup',
    physicalId: ASG,
    send: asgSend,
    make: () => new ASGProvider(),
    describe: 'DescribeAutoScalingGroupsCommand',
    describeReply: (on, gone) => ({
      AutoScalingGroups: gone
        ? []
        : [
            {
              AutoScalingGroupName: ASG,
              DeletionProtection: on ? 'prevent-all-deletion' : 'none',
              Instances: [],
            },
          ],
    }),
    modify: 'UpdateAutoScalingGroupCommand',
    isDisable: (cmd) => cmd.input['DeletionProtection'] === 'none',
    reEnableInput: { AutoScalingGroupName: ASG, DeletionProtection: 'prevent-all-deletion' },
    del: 'DeleteAutoScalingGroupCommand',
    // The second describe is the #796 instance enumeration.
    terminalSequence: [
      'DescribeAutoScalingGroupsCommand',
      'UpdateAutoScalingGroupCommand',
      'DescribeAutoScalingGroupsCommand',
      'DeleteAutoScalingGroupCommand',
      'UpdateAutoScalingGroupCommand',
    ],
    acceptedLine: 'Successfully initiated deletion of AutoScalingGroup',
    subject: 'AutoScalingGroup',
    guardName: 'DeletionProtection',
    restoreCommand: `aws autoscaling update-auto-scaling-group --auto-scaling-group-name ${ASG} --region us-east-1 --deletion-protection prevent-all-deletion`,
    checkCommand: `aws autoscaling describe-auto-scaling-groups --auto-scaling-group-names ${ASG} --region us-east-1`,
    sdkNotFound: () =>
      Object.assign(new Error('AutoScalingGroup name not found - my-asg'), {
        name: 'ValidationError',
      }),
    notFoundPhrase: 'Auto Scaling answered that the group was not found',
  },
];

/** A delete refusal matching no retryable pattern: TERMINAL. */
function terminalRefusal(): Error {
  const e = new Error(
    `Load balancer '${LB_ARN}' cannot be deleted because it is currently associated with another service`
  );
  e.name = 'ResourceInUseException';
  return e;
}
const REFUSAL = 'currently associated with another service';

function throttle(): Error {
  const e = new Error('Rate exceeded');
  e.name = 'ThrottlingException';
  return e;
}

interface Script {
  /** The pre-flip readback: the guard value, or an error to throw. */
  observe?: boolean | Error;
  /** The flip-off: resolves unless given an error. */
  disable?: Error;
  /** The delete: resolves unless given an error. */
  del?: Error;
  /** The compensating re-enable. */
  reEnable?: Error;
}

/** Route every command by name, so a case states only what it changes. */
function script(site: Site, s: Script): void {
  // The live resource as the fake service holds it: a landed flip-off turns
  // the guard off for every LATER read, a landed delete removes the resource.
  let flippedOff = false;
  let gone = false;
  site.send.mockImplementation(async (cmd: Cmd) => {
    const name = cmd.constructor.name;
    if (name === site.describe) {
      if (s.observe instanceof Error) throw s.observe;
      return site.describeReply(flippedOff ? false : (s.observe ?? false), gone);
    }
    if (name === site.modify) {
      if (site.isDisable(cmd)) {
        if (s.disable) throw s.disable;
        flippedOff = true;
        return {};
      }
      if (s.reEnable) throw s.reEnable;
      return {};
    }
    if (name === site.del) {
      if (s.del) throw s.del;
      gone = true;
      return {};
    }
    throw new Error(`unexpected command ${name}`);
  });
}

function calls(site: Site): Cmd[] {
  return site.send.mock.calls.map((c) => c[0] as Cmd);
}

function reEnableCalls(site: Site): Cmd[] {
  return calls(site).filter((c) => c.constructor.name === site.modify && !site.isDisable(c));
}

function disableCalls(site: Site): Cmd[] {
  return calls(site).filter((c) => c.constructor.name === site.modify && site.isDisable(c));
}

const CTX = { removeProtection: true, expectedRegion: 'us-east-1' };

beforeEach(() => {
  vi.clearAllMocks();
  elbv2Send.mockReset();
  asgSend.mockReset();
  childLogger.debug.mockReset();
});

describe.each(SITES)('$name: --remove-protection compensation (issue #2204)', (site) => {
  const del = (provider = site.make(), context: Record<string, unknown> = CTX) =>
    provider.delete('Res', site.physicalId, site.resourceType, undefined, context);

  it('restores a guard this run turned off when the delete fails terminally, re-throwing the ORIGINAL error', async () => {
    script(site, { observe: true, del: terminalRefusal() });

    const thrown = await del()
      .then(() => undefined)
      .catch((e: unknown) => e);

    expect(thrown).toBeInstanceOf(Error);
    // The delete failure stays the outcome, unannotated.
    expect((thrown as Error).message).toContain(REFUSAL);
    expect((thrown as Error).message).not.toMatch(/re-enable/i);
    // The flip went out BEFORE the delete, and the re-enable AFTER it.
    expect(calls(site).map((c) => c.constructor.name)).toEqual(site.terminalSequence);
    const reEnables = reEnableCalls(site);
    expect(reEnables).toHaveLength(1);
    // The TARGET, not only the shape: a re-enable addressing the wrong
    // identifier would restore nothing.
    expect(reEnables[0]).toMatchObject({ input: site.reEnableInput });
    expect(childLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining(`${site.subject} Res: the delete failed after --remove-protection`)
    );
    expect(childLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining(`re-enabled on ${site.physicalId}`)
    );
  });

  it('a delete that SUCCEEDS restores nothing and leaves no record behind', async () => {
    const provider = site.make();
    script(site, { observe: true });
    await expect(del(provider)).resolves.toBeUndefined();
    expect(disableCalls(site)).toHaveLength(1);
    expect(reEnableCalls(site)).toHaveLength(0);
    expect(childLogger.warn).not.toHaveBeenCalled();
    expect(childLogger.error).not.toHaveBeenCalled();
    // Released: a later terminal failure of the same key whose readback sees
    // the guard off inherits nothing to restore.
    site.send.mockReset();
    script(site, { observe: false, del: terminalRefusal() });
    await expect(del(provider)).rejects.toThrow(REFUSAL);
    expect(reEnableCalls(site)).toHaveLength(0);
  });

  it('NEGATIVE CONTROL: leaves a guard that was already OFF before the run alone', async () => {
    script(site, { observe: false, del: terminalRefusal() });
    await expect(del()).rejects.toThrow(REFUSAL);
    expect(disableCalls(site)).toHaveLength(1);
    expect(reEnableCalls(site)).toHaveLength(0);
  });

  it('never compensates when the pre-flip readback failed ("do not know")', async () => {
    script(site, { observe: new Error('boom'), del: terminalRefusal() });
    await expect(del()).rejects.toThrow(REFUSAL);
    // The flip still goes out: nothing else rides it.
    expect(disableCalls(site)).toHaveLength(1);
    expect(reEnableCalls(site)).toHaveLength(0);
  });

  it('does not compensate a flip AWS rejected', async () => {
    script(site, { observe: true, disable: new Error('flip refused'), del: terminalRefusal() });
    await expect(del()).rejects.toThrow(REFUSAL);
    expect(reEnableCalls(site)).toHaveLength(0);
  });

  it('does not compensate once AWS ACCEPTED the delete', async () => {
    // A throwing logger on the line right after the accepted delete stands in
    // for any later throw. Without the `deleteAccepted` latch this terminal
    // failure would re-enable the guard on a resource that is already going.
    script(site, { observe: true });
    childLogger.debug.mockImplementation((message: unknown) => {
      if (typeof message === 'string' && message.startsWith(site.acceptedLine)) {
        throw new Error('logger died after the delete');
      }
    });
    await expect(del()).rejects.toThrow('logger died after the delete');
    expect(calls(site).map((c) => c.constructor.name)).toContain(site.del);
    expect(reEnableCalls(site)).toHaveLength(0);
  });

  it('does not read, flip or compensate anything without --remove-protection', async () => {
    script(site, { observe: true, del: terminalRefusal() });
    await expect(del(site.make(), { expectedRegion: 'us-east-1' })).rejects.toThrow(REFUSAL);
    expect(calls(site).map((c) => c.constructor.name)).toEqual([site.del]);
  });

  it('holds the flip across a RETRYABLE failure, so the re-entered terminal failure still restores it', async () => {
    const provider = site.make();
    // Attempt 1: guard observed ON, flipped, throttled -> retryable, no compensation.
    script(site, { observe: true, del: throttle() });
    await expect(del(provider)).rejects.toThrow('Rate exceeded');
    expect(reEnableCalls(site)).toHaveLength(0);

    // Attempt 2 (the outer loop's re-entry): the readback now reports OFF --
    // attempt 1 is why -- and the delete fails terminally.
    site.send.mockReset();
    script(site, { observe: false, del: terminalRefusal() });
    await expect(del(provider)).rejects.toThrow(REFUSAL);
    const reEnables = reEnableCalls(site);
    expect(reEnables).toHaveLength(1);
    expect(reEnables[0]).toMatchObject({ input: site.reEnableInput });
  });

  it('a RESTORED guard releases the record, so a later delete of the same key does not inherit it', async () => {
    const provider = site.make();
    script(site, { observe: true, del: terminalRefusal() });
    await expect(del(provider)).rejects.toThrow(REFUSAL);
    expect(reEnableCalls(site)).toHaveLength(1);

    site.send.mockReset();
    script(site, { observe: false, del: terminalRefusal() });
    await expect(del(provider)).rejects.toThrow(REFUSAL);
    expect(reEnableCalls(site)).toHaveLength(0);
  });

  it('a FAILED re-enable keeps the record, so a later delete of the same key retries it', async () => {
    const provider = site.make();
    script(site, { observe: true, del: terminalRefusal(), reEnable: new Error('AccessDenied') });
    await expect(del(provider)).rejects.toThrow(REFUSAL);

    site.send.mockReset();
    script(site, { observe: false, del: terminalRefusal() });
    await expect(del(provider)).rejects.toThrow(REFUSAL);
    const reEnables = reEnableCalls(site);
    expect(reEnables).toHaveLength(1);
    expect(reEnables[0]).toMatchObject({ input: site.reEnableInput });
  });

  it('the flip record is keyed by region: a retained record is not inherited in another region', async () => {
    const provider = site.make();
    script(site, { observe: true, del: throttle() });
    await expect(del(provider)).rejects.toThrow('Rate exceeded');

    site.send.mockReset();
    script(site, { observe: false, del: terminalRefusal() });
    await expect(
      del(provider, { removeProtection: true, expectedRegion: 'eu-west-1' })
    ).rejects.toThrow(REFUSAL);
    expect(reEnableCalls(site)).toHaveLength(0);
  });

  it('a FAILED re-enable is an ERROR line naming the restore command, and the original error still wins', async () => {
    script(site, { observe: true, del: terminalRefusal(), reEnable: new Error('AccessDenied') });
    await expect(del()).rejects.toThrow(REFUSAL);
    expect(childLogger.error).toHaveBeenCalledWith(
      expect.stringContaining(
        `${site.subject} Res: could NOT re-enable ${site.guardName} on ${site.physicalId}`
      )
    );
    expect(childLogger.error).toHaveBeenCalledWith(
      expect.stringContaining(`Restore it with: ${site.restoreCommand}. (AccessDenied)`)
    );
  });

  it('a not-found re-enable is a WARN that names the check first, not an ERROR claiming it is live', async () => {
    script(site, { observe: true, del: terminalRefusal(), reEnable: site.sdkNotFound() });
    await expect(del()).rejects.toThrow(REFUSAL);
    expect(childLogger.error).not.toHaveBeenCalled();
    expect(childLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining(
        `could not re-enable ${site.guardName} on ${site.physicalId} after the delete failed`
      )
    );
    expect(childLogger.warn).toHaveBeenCalledWith(expect.stringContaining(site.notFoundPhrase));
    expect(childLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining(
        `Check with: ${site.checkCommand} and if it is there, restore it with: ${site.restoreCommand}.`
      )
    );
  });

  it('a missing resource still deletes idempotently under --remove-protection', async () => {
    // The readback, the flip and the delete all answer not-found: the delete's
    // own not-found arm (with its region check) ends it as already gone.
    script(site, {
      observe: site.sdkNotFound(),
      disable: site.sdkNotFound(),
      del: site.sdkNotFound(),
    });
    await expect(del()).resolves.toBeUndefined();
    expect(reEnableCalls(site)).toHaveLength(0);
  });
});

describe('AutoScalingGroup: the restore puts back the LEVEL the flip removed', () => {
  const site = SITES[1]!;

  /** The group as Auto Scaling reports it: `level` until a flip lands, `none` after. */
  function scriptLevel(level: string, s: { del?: Error; reEnable?: Error } = {}): void {
    let current = level;
    asgSend.mockImplementation(async (cmd: Cmd) => {
      const name = cmd.constructor.name;
      if (name === 'DescribeAutoScalingGroupsCommand') {
        return {
          AutoScalingGroups: [
            { AutoScalingGroupName: ASG, DeletionProtection: current, Instances: [] },
          ],
        };
      }
      if (name === 'UpdateAutoScalingGroupCommand') {
        if (cmd.input['DeletionProtection'] !== 'none' && s.reEnable) throw s.reEnable;
        current = cmd.input['DeletionProtection'] as string;
        return {};
      }
      if (name === 'DeleteAutoScalingGroupCommand') {
        if (s.del) throw s.del;
        return {};
      }
      throw new Error(`unexpected command ${name}`);
    });
  }

  it.each(['prevent-force-deletion', 'prevent-all-deletion'])(
    'a group observed at %s gets %s back',
    async (level) => {
      scriptLevel(level, { del: terminalRefusal() });
      await expect(
        new ASGProvider().delete('Res', ASG, site.resourceType, undefined, CTX)
      ).rejects.toThrow(REFUSAL);
      const reEnables = reEnableCalls(site);
      expect(reEnables).toHaveLength(1);
      expect(reEnables[0]).toMatchObject({
        input: { AutoScalingGroupName: ASG, DeletionProtection: level },
      });
    }
  );

  it('a re-entered attempt that observes none does not overwrite the level the first one removed', async () => {
    const provider = new ASGProvider();
    scriptLevel('prevent-force-deletion', { del: throttle() });
    await expect(provider.delete('Res', ASG, site.resourceType, undefined, CTX)).rejects.toThrow(
      'Rate exceeded'
    );

    asgSend.mockReset();
    scriptLevel('none', { del: terminalRefusal() });
    await expect(provider.delete('Res', ASG, site.resourceType, undefined, CTX)).rejects.toThrow(
      REFUSAL
    );
    const reEnables = reEnableCalls(site);
    expect(reEnables).toHaveLength(1);
    expect(reEnables[0]).toMatchObject({
      input: { AutoScalingGroupName: ASG, DeletionProtection: 'prevent-force-deletion' },
    });
  });

  it('the ERROR line renders the removed level in the restore command', async () => {
    scriptLevel('prevent-force-deletion', {
      del: terminalRefusal(),
      reEnable: new Error('AccessDenied'),
    });
    await expect(
      new ASGProvider().delete('Res', ASG, site.resourceType, undefined, CTX)
    ).rejects.toThrow(REFUSAL);
    expect(childLogger.error).toHaveBeenCalledWith(
      expect.stringContaining(
        `Restore it with: aws autoscaling update-auto-scaling-group --auto-scaling-group-name ${ASG} --region us-east-1 --deletion-protection prevent-force-deletion.`
      )
    );
  });

  it('a WAIT failing after the accepted delete is not answered with a re-enable', async () => {
    // The real post-acceptance throw on this type: `DeleteAutoScalingGroup`
    // is asynchronous and the wait for the group to go can fail terminally.
    let deleted = false;
    asgSend.mockImplementation(async (cmd: Cmd) => {
      const name = cmd.constructor.name;
      if (name === 'DescribeAutoScalingGroupsCommand') {
        if (deleted) throw Object.assign(new Error('Access denied'), { name: 'AccessDenied' });
        return {
          AutoScalingGroups: [
            {
              AutoScalingGroupName: ASG,
              DeletionProtection: 'prevent-all-deletion',
              Instances: [],
            },
          ],
        };
      }
      if (name === 'DeleteAutoScalingGroupCommand') {
        deleted = true;
        return {};
      }
      return {};
    });
    await expect(
      new ASGProvider().delete('Res', ASG, site.resourceType, undefined, CTX)
    ).rejects.toThrow('Access denied');
    expect(reEnableCalls(site)).toHaveLength(0);
  });
});

describe('loadBalancerProtectionSite / autoScalingGroupProtectionSite', () => {
  it('render the commands with --region when the state records one', () => {
    expect(loadBalancerProtectionSite(LB_ARN, 'eu-west-1').commands()).toEqual({
      check: `aws elbv2 describe-load-balancer-attributes --load-balancer-arn ${LB_ARN} --region eu-west-1`,
      restoreAfterNotFound: `aws elbv2 modify-load-balancer-attributes --load-balancer-arn ${LB_ARN} --region eu-west-1 --attributes Key=deletion_protection.enabled,Value=true`,
      restoreLive: `aws elbv2 modify-load-balancer-attributes --load-balancer-arn ${LB_ARN} --region eu-west-1 --attributes Key=deletion_protection.enabled,Value=true`,
    });
    expect(
      autoScalingGroupProtectionSite(ASG, 'eu-west-1', () => 'prevent-all-deletion').commands()
    ).toEqual({
      check: `aws autoscaling describe-auto-scaling-groups --auto-scaling-group-names ${ASG} --region eu-west-1`,
      restoreAfterNotFound: `aws autoscaling update-auto-scaling-group --auto-scaling-group-name ${ASG} --region eu-west-1 --deletion-protection prevent-all-deletion`,
      restoreLive: `aws autoscaling update-auto-scaling-group --auto-scaling-group-name ${ASG} --region eu-west-1 --deletion-protection prevent-all-deletion`,
    });
  });

  it('omit --region when the state carries none', () => {
    expect(loadBalancerProtectionSite(LB_ARN, undefined).commands().check).toBe(
      `aws elbv2 describe-load-balancer-attributes --load-balancer-arn ${LB_ARN}`
    );
    expect(
      autoScalingGroupProtectionSite(ASG, undefined, () => 'prevent-all-deletion').commands().check
    ).toBe(`aws autoscaling describe-auto-scaling-groups --auto-scaling-group-names ${ASG}`);
  });

  it('WITHHOLD the group restore command when the removed level is unknown, keeping the check', () => {
    expect(autoScalingGroupProtectionSite(ASG, 'us-east-1', () => undefined).commands()).toEqual({
      check: `aws autoscaling describe-auto-scaling-groups --auto-scaling-group-names ${ASG} --region us-east-1`,
      restoreAfterNotFound: WITHHELD_AWS_COMMAND,
      restoreLive: WITHHELD_AWS_COMMAND,
    });
  });

  it.each([
    ['load balancer', () => loadBalancerProtectionSite('arn\n1', 'us-east-1')],
    ['group', () => autoScalingGroupProtectionSite('asg\n1', 'us-east-1', () => 'none-such')],
  ])('WITHHOLD every %s command for an identifier that cannot be printed exactly', (_l, make) => {
    expect(make().commands()).toEqual({
      check: WITHHELD_AWS_COMMAND,
      restoreAfterNotFound: WITHHELD_AWS_COMMAND,
      restoreLive: WITHHELD_AWS_COMMAND,
    });
  });

  it('the group not-found predicate reads a ValidationError saying so, and nothing else', () => {
    const site = autoScalingGroupProtectionSite(ASG, undefined, () => undefined);
    expect(site.isNotFound(SITES[1]!.sdkNotFound())).toBe(true);
    expect(
      site.isNotFound(Object.assign(new Error('Invalid parameter'), { name: 'ValidationError' }))
    ).toBe(false);
    expect(site.isNotFound(Object.assign(new Error('not found'), { name: 'AccessDenied' }))).toBe(
      false
    );
    const lb = loadBalancerProtectionSite(LB_ARN, undefined);
    expect(lb.isNotFound(SITES[0]!.sdkNotFound())).toBe(true);
    expect(lb.isNotFound(new Error('not found'))).toBe(false);
  });
});
