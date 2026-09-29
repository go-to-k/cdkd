/**
 * `--remove-protection` compensation on `AWS::Logs::LogGroup` and
 * `AWS::Cognito::UserPool` (issue #2204).
 *
 * Every site runs the SAME cases, so a site that loses its readback, its
 * `deleteAccepted` latch or its boundary goes red on its own row. The
 * mechanism's own cases (gates, outcome split, logger-throw) are fenced in
 * `dynamodb-remove-protection-compensate.test.ts` and
 * `rds-family-remove-protection-compensate.test.ts`; this file fences that
 * each of these two sites is WIRED to it.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const logsSend = vi.fn();
const cognitoSend = vi.fn();

vi.mock('../../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    cloudWatchLogs: { send: logsSend, config: { region: () => Promise.resolve('us-east-1') } },
    sts: {
      send: vi.fn(() => Promise.resolve({ Account: '123456789012' })),
      config: { region: () => Promise.resolve('us-east-1') },
    },
  }),
}));

vi.mock('@aws-sdk/client-cognito-identity-provider', async (importOriginal) => {
  const orig = (await importOriginal()) as Record<string, unknown>;
  return {
    ...orig,
    CognitoIdentityProviderClient: vi.fn().mockImplementation(() => ({
      send: cognitoSend,
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

import { LogsLogGroupProvider } from '../../../../src/provisioning/providers/logs-loggroup-provider.js';
import { CognitoUserPoolProvider } from '../../../../src/provisioning/providers/cognito-provider.js';
import {
  logGroupProtectionSite,
  userPoolProtectionSite,
} from '../../../../src/provisioning/providers/deletion-protection-compensation.js';
import { WITHHELD_AWS_COMMAND } from '../../../../src/provisioning/replacement-protection-advice.js';
import { ResourceNotFoundException as LogsNotFound } from '@aws-sdk/client-cloudwatch-logs';
import { ResourceNotFoundException as CognitoNotFound } from '@aws-sdk/client-cognito-identity-provider';

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
  /** The readback's answer for a guard that is ON / OFF. */
  readonly describeReply: (on: boolean) => unknown;
  readonly modify: string;
  /** Whether a `modify` call turns the guard OFF (else it is the re-enable). */
  readonly isDisable: (cmd: Cmd) => boolean;
  /** What the re-enable must carry: the target AND the value. */
  readonly reEnableInput: Record<string, unknown>;
  readonly del: string;
  readonly subject: string;
  readonly guardName: string;
  /** The restore command the ERROR line must render, `--region` included. */
  readonly restoreCommand: string;
  readonly checkCommand: string;
  /** The service's own not-found class, which the delete's idempotent arm keys on. */
  readonly sdkNotFound: () => Error;
}

const LG = '/aws/lambda/lg-1';
const POOL = 'us-east-1_abc';

const SITES: readonly Site[] = [
  {
    name: 'Logs LogGroup',
    resourceType: 'AWS::Logs::LogGroup',
    physicalId: LG,
    send: logsSend,
    make: () => new LogsLogGroupProvider(),
    describe: 'DescribeLogGroupsCommand',
    // A PREFIX match: a longer sibling sorts after the exact name and carries
    // the opposite flag, so a readback that took the first entry blindly, or
    // matched loosely, answers wrong on one polarity.
    describeReply: (on) => ({
      logGroups: [
        { logGroupName: LG, deletionProtectionEnabled: on },
        { logGroupName: `${LG}-other`, deletionProtectionEnabled: !on },
      ],
    }),
    modify: 'PutLogGroupDeletionProtectionCommand',
    isDisable: (cmd) => cmd.input['deletionProtectionEnabled'] === false,
    reEnableInput: { logGroupIdentifier: LG, deletionProtectionEnabled: true },
    del: 'DeleteLogGroupCommand',
    subject: 'Log group',
    guardName: 'DeletionProtectionEnabled',
    restoreCommand: `aws logs put-log-group-deletion-protection --log-group-identifier ${LG} --region us-east-1 --deletion-protection-enabled`,
    checkCommand: `aws logs describe-log-groups --log-group-identifiers ${LG} --region us-east-1`,
    sdkNotFound: () => new LogsNotFound({ $metadata: {}, message: 'not found' }),
  },
  {
    name: 'Cognito UserPool',
    resourceType: 'AWS::Cognito::UserPool',
    physicalId: POOL,
    send: cognitoSend,
    make: () => new CognitoUserPoolProvider(),
    describe: 'DescribeUserPoolCommand',
    describeReply: (on) => ({ UserPool: { DeletionProtection: on ? 'ACTIVE' : 'INACTIVE' } }),
    modify: 'UpdateUserPoolCommand',
    isDisable: (cmd) => cmd.input['DeletionProtection'] === 'INACTIVE',
    reEnableInput: { UserPoolId: POOL, DeletionProtection: 'ACTIVE' },
    del: 'DeleteUserPoolCommand',
    subject: 'Cognito User Pool',
    guardName: 'DeletionProtection',
    restoreCommand: `aws cognito-idp update-user-pool --user-pool-id ${POOL} --region us-east-1 --deletion-protection ACTIVE`,
    checkCommand: `aws cognito-idp describe-user-pool --user-pool-id ${POOL} --region us-east-1`,
    sdkNotFound: () => new CognitoNotFound({ $metadata: {}, message: 'not found' }),
  },
];

/** A delete refusal matching no retryable pattern: TERMINAL. */
function terminalRefusal(): Error {
  const e = new Error(
    'User pool cannot be deleted. It has a domain configured that should be deleted first.'
  );
  e.name = 'InvalidParameterException';
  return e;
}

function throttle(): Error {
  const e = new Error('Rate exceeded');
  e.name = 'ThrottlingException';
  return e;
}

function notFound(): Error {
  const e = new Error('The specified resource does not exist.');
  e.name = 'ResourceNotFoundException';
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
  site.send.mockImplementation(async (cmd: Cmd) => {
    const name = cmd.constructor.name;
    if (name === site.describe) {
      if (s.observe instanceof Error) throw s.observe;
      return site.describeReply(s.observe ?? false);
    }
    if (name === site.modify) {
      if (site.isDisable(cmd)) {
        if (s.disable) throw s.disable;
        return {};
      }
      if (s.reEnable) throw s.reEnable;
      return {};
    }
    if (name === site.del) {
      if (s.del) throw s.del;
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
  logsSend.mockReset();
  cognitoSend.mockReset();
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
    expect((thrown as Error).message).toContain('domain configured');
    expect((thrown as Error).message).not.toMatch(/re-enable/i);
    // The flip went out BEFORE the delete, and the re-enable AFTER it.
    const names = calls(site).map((c) => c.constructor.name);
    expect(names).toEqual([site.describe, site.modify, site.del, site.modify]);
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

  it('NEGATIVE CONTROL: leaves a guard that was already OFF before the run alone', async () => {
    script(site, { observe: false, del: terminalRefusal() });
    await expect(del()).rejects.toThrow('domain configured');
    expect(reEnableCalls(site)).toHaveLength(0);
  });

  it('flips but does not compensate when the pre-flip readback failed ("do not know")', async () => {
    script(site, { observe: new Error('boom'), del: terminalRefusal() });
    await expect(del()).rejects.toThrow('domain configured');
    // The flip itself still went out: the readback is best-effort.
    expect(disableCalls(site)).toHaveLength(1);
    expect(reEnableCalls(site)).toHaveLength(0);
  });

  it('does not compensate a flip AWS rejected', async () => {
    script(site, { observe: true, disable: new Error('flip refused'), del: terminalRefusal() });
    await expect(del()).rejects.toThrow('domain configured');
    expect(reEnableCalls(site)).toHaveLength(0);
  });

  it('does not compensate once AWS ACCEPTED the delete', async () => {
    // Neither delete has a wait after it, so the only post-acceptance throw
    // reachable is the success log line; a throwing logger stands in for it.
    // Without the `deleteAccepted` latch this terminal failure would re-enable
    // the guard on a resource that is already gone.
    script(site, { observe: true });
    childLogger.debug.mockImplementation((message: unknown) => {
      if (typeof message === 'string' && message.startsWith('Successfully deleted')) {
        throw new Error('logger died after the delete');
      }
    });
    await expect(del()).rejects.toThrow('logger died after the delete');
    expect(calls(site).map((c) => c.constructor.name)).toContain(site.del);
    expect(reEnableCalls(site)).toHaveLength(0);
  });

  it('does not read, flip or compensate anything without --remove-protection', async () => {
    script(site, { observe: true, del: terminalRefusal() });
    await expect(del(site.make(), { expectedRegion: 'us-east-1' })).rejects.toThrow(
      'domain configured'
    );
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
    await expect(del(provider)).rejects.toThrow('domain configured');
    expect(reEnableCalls(site)).toHaveLength(1);
  });

  it('a RESTORED guard releases the record, so a later delete of the same key does not inherit it', async () => {
    const provider = site.make();
    script(site, { observe: true, del: terminalRefusal() });
    await expect(del(provider)).rejects.toThrow('domain configured');
    expect(reEnableCalls(site)).toHaveLength(1);

    site.send.mockReset();
    script(site, { observe: false, del: terminalRefusal() });
    await expect(del(provider)).rejects.toThrow('domain configured');
    expect(reEnableCalls(site)).toHaveLength(0);
  });

  it('a FAILED re-enable keeps the record, so a later delete of the same key retries it', async () => {
    const provider = site.make();
    script(site, { observe: true, del: terminalRefusal(), reEnable: new Error('AccessDenied') });
    await expect(del(provider)).rejects.toThrow('domain configured');

    site.send.mockReset();
    script(site, { observe: false, del: terminalRefusal() });
    await expect(del(provider)).rejects.toThrow('domain configured');
    expect(reEnableCalls(site)).toHaveLength(1);
  });

  it('the flip record is keyed by region: a retained record is not inherited in another region', async () => {
    const provider = site.make();
    script(site, { observe: true, del: throttle() });
    await expect(del(provider)).rejects.toThrow('Rate exceeded');

    site.send.mockReset();
    script(site, { observe: false, del: terminalRefusal() });
    await expect(
      del(provider, { removeProtection: true, expectedRegion: 'eu-west-1' })
    ).rejects.toThrow('domain configured');
    expect(reEnableCalls(site)).toHaveLength(0);
  });

  it('a FAILED re-enable is an ERROR line naming the restore command, and the original error still wins', async () => {
    script(site, { observe: true, del: terminalRefusal(), reEnable: new Error('AccessDenied') });
    await expect(del()).rejects.toThrow('domain configured');
    expect(childLogger.error).toHaveBeenCalledWith(
      expect.stringContaining(
        `${site.subject} Res: could NOT re-enable ${site.guardName} on ${site.physicalId}`
      )
    );
    expect(childLogger.error).toHaveBeenCalledWith(
      expect.stringContaining(`Restore it with: ${site.restoreCommand}.`)
    );
  });

  it('a not-found re-enable is a WARN that names the check first, not an ERROR claiming it is live', async () => {
    script(site, { observe: true, del: terminalRefusal(), reEnable: notFound() });
    await expect(del()).rejects.toThrow('domain configured');
    expect(childLogger.error).not.toHaveBeenCalled();
    expect(childLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining(
        `could not re-enable ${site.guardName} on ${site.physicalId} after the delete failed`
      )
    );
    expect(childLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining(`answered ResourceNotFoundException`)
    );
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

describe('Cognito: the recorded DeletionProtection is never trusted over the live one', () => {
  const site = SITES[1]!;

  it('a template saying ACTIVE over a live INACTIVE pool neither flips nor compensates', async () => {
    script(site, { observe: false, del: terminalRefusal() });
    await expect(
      new CognitoUserPoolProvider().delete(
        'Res',
        POOL,
        site.resourceType,
        { DeletionProtection: 'ACTIVE' },
        CTX
      )
    ).rejects.toThrow('domain configured');
    // No flip: `UpdateUserPool` resets some members it omits, so it is not
    // sent to a pool whose guard is already off.
    expect(disableCalls(site)).toHaveLength(0);
    expect(reEnableCalls(site)).toHaveLength(0);
  });
});

describe('Logs: the readback reads the EXACT name out of a prefix match', () => {
  const site = SITES[0]!;

  it('a protected SIBLING under the same prefix does not make an unprotected log group compensate', async () => {
    // describeReply(false) puts `lg-1` OFF and `lg-1-other` ON.
    script(site, { observe: false, del: terminalRefusal() });
    await expect(
      new LogsLogGroupProvider().delete('Res', LG, site.resourceType, undefined, CTX)
    ).rejects.toThrow('domain configured');
    expect(reEnableCalls(site)).toHaveLength(0);
  });

  it('a prefix match holding ONLY a protected sibling is not read as this log group', async () => {
    // AWS lists prefix matches in name order, so the exact name, when present,
    // comes first; a readback taking the first entry is only wrong when the
    // exact name is ABSENT, which is this case.
    logsSend.mockImplementation(async (cmd: Cmd) => {
      const name = cmd.constructor.name;
      if (name === 'DescribeLogGroupsCommand') {
        return { logGroups: [{ logGroupName: `${LG}-other`, deletionProtectionEnabled: true }] };
      }
      if (name === 'DeleteLogGroupCommand') throw terminalRefusal();
      return {};
    });
    await expect(
      new LogsLogGroupProvider().delete('Res', LG, site.resourceType, undefined, CTX)
    ).rejects.toThrow('domain configured');
    expect(reEnableCalls(site)).toHaveLength(0);
  });

  it('asks DescribeLogGroups for the name as a prefix', async () => {
    script(site, { observe: true });
    await new LogsLogGroupProvider().delete('Res', LG, site.resourceType, undefined, CTX);
    expect(calls(site)[0]).toMatchObject({ input: { logGroupNamePrefix: LG } });
  });
});

describe('logGroupProtectionSite / userPoolProtectionSite', () => {
  it('render the commands with --region when the state records one', () => {
    expect(logGroupProtectionSite(LG, 'eu-west-1').commands()).toEqual({
      check: `aws logs describe-log-groups --log-group-identifiers ${LG} --region eu-west-1`,
      restoreAfterNotFound: `aws logs put-log-group-deletion-protection --log-group-identifier ${LG} --region eu-west-1 --deletion-protection-enabled`,
      restoreLive: `aws logs put-log-group-deletion-protection --log-group-identifier ${LG} --region eu-west-1 --deletion-protection-enabled`,
    });
    expect(userPoolProtectionSite(POOL, 'eu-west-1').commands()).toEqual({
      check: `aws cognito-idp describe-user-pool --user-pool-id ${POOL} --region eu-west-1`,
      restoreAfterNotFound: `aws cognito-idp update-user-pool --user-pool-id ${POOL} --region eu-west-1 --deletion-protection ACTIVE`,
      restoreLive: `aws cognito-idp update-user-pool --user-pool-id ${POOL} --region eu-west-1 --deletion-protection ACTIVE`,
    });
  });

  it('omit --region when the state carries none', () => {
    expect(logGroupProtectionSite(LG, undefined).commands().check).toBe(
      `aws logs describe-log-groups --log-group-identifiers ${LG}`
    );
    expect(userPoolProtectionSite(POOL, undefined).commands().check).toBe(
      `aws cognito-idp describe-user-pool --user-pool-id ${POOL}`
    );
  });

  it('shell-quote a state-borne log group name carrying a space', () => {
    expect(logGroupProtectionSite('lg 1', undefined).commands().restoreLive).toBe(
      "aws logs put-log-group-deletion-protection --log-group-identifier 'lg 1' --deletion-protection-enabled"
    );
  });

  it.each([
    ['log group', () => logGroupProtectionSite('lg\n1', 'us-east-1')],
    ['user pool', () => userPoolProtectionSite('pool\n1', 'us-east-1')],
  ])('WITHHOLD every %s command for an identifier that cannot be printed exactly', (_l, make) => {
    expect(make().commands()).toEqual({
      check: WITHHELD_AWS_COMMAND,
      restoreAfterNotFound: WITHHELD_AWS_COMMAND,
      restoreLive: WITHHELD_AWS_COMMAND,
    });
  });

  it('the Cognito restore carries the UpdateUserPool reset caveat on BOTH failure arms; the log group carries none', async () => {
    const pool = SITES[1]!;
    script(pool, { observe: true, del: terminalRefusal(), reEnable: new Error('AccessDenied') });
    await expect(
      new CognitoUserPoolProvider().delete('Res', POOL, pool.resourceType, undefined, CTX)
    ).rejects.toThrow('domain configured');
    expect(childLogger.error).toHaveBeenCalledWith(
      expect.stringContaining(
        `${pool.restoreCommand}. Note UpdateUserPool resets some members a call omits (AutoVerifiedAttributes among them)`
      )
    );

    vi.clearAllMocks();
    cognitoSend.mockReset();
    script(pool, { observe: true, del: terminalRefusal(), reEnable: notFound() });
    await expect(
      new CognitoUserPoolProvider().delete('Res', POOL, pool.resourceType, undefined, CTX)
    ).rejects.toThrow('domain configured');
    expect(childLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining(
        `${pool.restoreCommand}. Note UpdateUserPool resets some members a call omits`
      )
    );

    const lg = SITES[0]!;
    vi.clearAllMocks();
    script(lg, { observe: true, del: terminalRefusal(), reEnable: new Error('AccessDenied') });
    await expect(
      new LogsLogGroupProvider().delete('Res', LG, lg.resourceType, undefined, CTX)
    ).rejects.toThrow('domain configured');
    expect(childLogger.error).toHaveBeenCalledWith(
      expect.stringContaining(`${lg.restoreCommand}. (AccessDenied)`)
    );
  });
});
