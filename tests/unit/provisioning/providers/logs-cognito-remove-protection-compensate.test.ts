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
  runDeleteAttempt,
  userPoolProtectionSite,
} from '../../../../src/provisioning/providers/deletion-protection-compensation.js';
import { WITHHELD_AWS_COMMAND } from '../../../../src/provisioning/replacement-protection-advice.js';
import { isAwsAuthoredFailure, VERBOSE_POINTER } from '../../../../src/utils/aws-failure-text.js';
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
  /** Whether the re-enable reads the pool afresh first (Cognito's read-modify-write, #4066). */
  readonly reEnableReadsFirst: boolean;
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
    reEnableReadsFirst: false,
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
    reEnableReadsFirst: true,
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

function iamDeny(): Error {
  return Object.assign(
    new Error(
      'User: arn:aws:iam::123456789012:user/ci is not authorized to perform: the delete because no identity-based policy allows the delete action'
    ),
    { name: 'AccessDeniedException', $metadata: { httpStatusCode: 400 } }
  );
}

/**
 * The site's delete failure names `text`. Both wraps withhold an AWS-authored
 * failure's text into their `cause` and name it by its class at the top
 * (go-to-k/cdkd#2319), so the site must be the wrap, never the raw error, and
 * AWS's text must NOT be in the thrown (persisted) message.
 */
const DELETE_WRAP: Record<string, RegExp> = {
  'Cognito UserPool': /^Failed to delete Cognito User Pool \S+: /,
  'Logs LogGroup': /^Failed to delete log group \S+: /,
};
const says =
  (site: Site, text: string) =>
  (error: unknown): boolean => {
    if (!(error instanceof Error)) return false;
    const cause = error.cause;
    if (!(cause instanceof Error) || !cause.message.includes(text)) return false;
    const authored = isAwsAuthoredFailure(cause);
    if (authored && error.message.includes(text)) return false;
    const tail = authored ? `${cause.name}. ${VERBOSE_POINTER}` : cause.message;
    return DELETE_WRAP[site.name]!.test(error.message) && error.message.endsWith(`: ${tail}`);
  };

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
  // The live guard as the fake service holds it: a landed flip-off turns it
  // off for every LATER read (the Cognito re-enable reads the pool afresh).
  let flippedOff = false;
  site.send.mockImplementation(async (cmd: Cmd) => {
    const name = cmd.constructor.name;
    if (name === site.describe) {
      if (s.observe instanceof Error) throw s.observe;
      return site.describeReply(flippedOff ? false : (s.observe ?? false));
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
    expect(names).toEqual(
      site.reEnableReadsFirst
        ? [site.describe, site.modify, site.del, site.describe, site.modify]
        : [site.describe, site.modify, site.del, site.modify]
    );
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

  it('never compensates when the pre-flip readback failed ("do not know")', async () => {
    script(site, { observe: new Error('boom'), del: terminalRefusal() });
    await expect(del()).rejects.toThrow('domain configured');
    // The log group still flips blind (its flip resets nothing else); the user
    // pool does not, since its only unread write resets self sign-up and the
    // Lambda triggers (#4066).
    expect(disableCalls(site)).toHaveLength(site.reEnableReadsFirst ? 0 : 1);
    expect(reEnableCalls(site)).toHaveLength(0);
  });

  it("masks the failed readback's debug line with the delete's maskSecrets (#5180)", async () => {
    script(site, {
      observe: new Error(`read failed on ${site.physicalId}`),
      del: terminalRefusal(),
    });
    await expect(
      del(site.make(), {
        ...CTX,
        maskSecrets: (text: string) => text.split(site.physicalId).join('***'),
      })
    ).rejects.toThrow('domain configured');
    const line = childLogger.debug.mock.calls
      .map((c) => String(c[0]))
      .find((l) => l.startsWith(`Could not read ${site.guardName}`));
    expect(line).toBe(
      `Could not read ${site.guardName} on *** before disabling it: read failed on ***`
    );
  });

  it('does not compensate a flip AWS rejected', async () => {
    // An AWS-authored refusal (`$metadata` set): only that PROVES the flip did
    // not land. A client-side failure may have, and is compensated (#4066).
    const refused = Object.assign(new Error('flip refused'), {
      name: 'InvalidParameterException',
      $metadata: { httpStatusCode: 400 },
    });
    script(site, { observe: true, disable: refused, del: terminalRefusal() });
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

  it("a refusal that stays RETRYABLE is restored on the destroy loop's LAST attempt (issue #4318)", async () => {
    // An IAM deny reads `not authorized to perform`, which the classifier calls
    // retryable (IAM propagation), so every attempt is retryable and only the
    // loop's attempt cap ends the sequence.
    const provider = site.make();
    script(site, { observe: true, del: iamDeny() });
    for (let i = 0; i < 3; i += 1) {
      await expect(runDeleteAttempt(false, () => del(provider))).rejects.toSatisfy(
        says(site, 'not authorized to perform')
      );
      expect(reEnableCalls(site)).toHaveLength(0);
    }
    await expect(runDeleteAttempt(true, () => del(provider))).rejects.toSatisfy(
      says(site, 'not authorized to perform')
    );
    const reEnables = reEnableCalls(site);
    expect(reEnables).toHaveLength(1);
    expect(reEnables[0]).toMatchObject({ input: site.reEnableInput });
    expect(childLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining(`re-enabled on ${site.physicalId}`)
    );
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

  // go-to-k/cdkd#2319: the class is AWS-authored text, so the delete's masker
  // must reach the re-enable report. The Logs delete is another lane's file.
  it.skipIf(site.name !== 'Cognito UserPool')('masks a secret spelled in the failed re-enable class', async () => {
    script(site, { observe: true, del: terminalRefusal(), reEnable: Object.assign(new Error('denied'), { name: 'Denieds3cr3tException', $fault: 'client', $metadata: { httpStatusCode: 400 } }) });
    await expect(del(undefined, { ...CTX, maskSecrets: (t: string) => t.split('s3cr3t').join('***') })).rejects.toThrow('domain configured');
    const reported = [...childLogger.error.mock.calls, ...childLogger.warn.mock.calls]
      .map((c) => String(c[0]))
      .filter((l) => l.includes('re-enable'));
    expect(reported).toHaveLength(1);
    expect(reported[0]).toContain('(Denied***Exception. Re-run with --verbose');
    expect(reported[0]).not.toContain('s3cr3t');
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

  // A shell-active character withholds them (go-to-k/cdkd#3950).
  it('WITHHOLD every log group command for a state-borne name carrying a space', () => {
    expect(logGroupProtectionSite('lg 1', undefined).commands()).toEqual({
      check: WITHHELD_AWS_COMMAND,
      restoreAfterNotFound: WITHHELD_AWS_COMMAND,
      restoreLive: WITHHELD_AWS_COMMAND,
    });
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
        `${pool.restoreCommand}. Note UpdateUserPool resets some members a call omits (self sign-up, Lambda triggers, advanced security, AutoVerifiedAttributes and a customer-managed KeyConfiguration among them)`
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

// Cognito's user pool id is AWS-assigned, so only the log group's flip line
// names a template value.
describe.each(SITES.filter((s) => s.resourceType === 'AWS::Logs::LogGroup'))(
  '$name: the rejected flip-off line is masked (#5180)',
  (site) => {
    it("routes the id and AWS's text through the delete's maskSecrets", async () => {
      script(site, {
        observe: true,
        disable: new Error(`cannot modify ${site.physicalId}`),
        del: terminalRefusal(),
      });
      await site
        .make()
        .delete('Res', site.physicalId, site.resourceType, undefined, {
          ...CTX,
          maskSecrets: (text: string) => text.split(site.physicalId).join('***'),
        })
        .catch(() => undefined);
      const line = childLogger.debug.mock.calls
        .map((c) => String(c[0]))
        .find((l) => l.startsWith(`Could not disable ${site.guardName}`));
      expect(line).toBe(`Could not disable ${site.guardName} on ***: cannot modify ***`);
    });
  }
);

// AWS's validation text can quote an echoed, template-authored member
// (USER_POOL_ECHO_MEMBERS), so the user pool's flip debug lines are masked too
// even though the pool id itself is AWS-assigned (#5180).
describe('Cognito UserPool: the flip-off debug lines are masked (#5180)', () => {
  const site = SITES.find((s) => s.resourceType === 'AWS::Cognito::UserPool')!;
  const secret = 'Your code is {####} s3cr3t-template';
  const ctx = { ...CTX, maskSecrets: (text: string) => text.split(secret).join('***') };

  /** Debug lines after a delete whose N-th disable write throws `errors[N]`. */
  async function debugAfter(
    errors: ReadonlyArray<Error | undefined>,
    mask: (text: string) => string = ctx.maskSecrets
  ): Promise<string[]> {
    let disables = 0;
    cognitoSend.mockImplementation(async (cmd: Cmd) => {
      const name = cmd.constructor.name;
      if (name === site.describe) return site.describeReply(disables === 0);
      if (name === site.modify && site.isDisable(cmd)) {
        const e = errors[disables++];
        if (e) throw e;
        return {};
      }
      if (name === site.del) throw terminalRefusal();
      return {};
    });
    await site
      .make()
      .delete('Res', site.physicalId, site.resourceType, undefined, { ...ctx, maskSecrets: mask })
      .catch(() => undefined);
    return childLogger.debug.mock.calls.map((c) => String(c[0]));
  }

  it('masks the refused-flip line and the flip catch line', async () => {
    const refused = Object.assign(new Error(`Invalid message template: ${secret}`), {
      name: 'NotAuthorizedException',
      $metadata: { httpStatusCode: 400 },
    });
    const lines = await debugAfter([refused, refused]);
    const left = lines.find((l) => l.startsWith('UpdateUserPool did not turn DeletionProtection off'));
    const caught = lines.find((l) => l.startsWith('Could not disable DeletionProtection for'));
    expect(left).toBe(
      `UpdateUserPool did not turn DeletionProtection off on ${site.physicalId}: Invalid message template: ***`
    );
    expect(caught).toBe(
      `Could not disable DeletionProtection for ${site.physicalId}: Invalid message template: ***`
    );
  });

  it('masks the refused-echo line before the bare flip', async () => {
    const refusedEcho = Object.assign(new Error(`Invalid message template: ${secret}`), {
      name: 'InvalidParameterException',
      $metadata: { httpStatusCode: 400 },
    });
    const lines = await debugAfter([refusedEcho]);
    expect(lines.find((l) => l.startsWith('UpdateUserPool refused the echoed configuration'))).toBe(
      `UpdateUserPool refused the echoed configuration of ${site.physicalId}: Invalid message template: ***`
    );
  });
  // A secret spanning a line break survives only the per-value pass (`safeMsg`
  // flattens it), and a needle spanning the template's seam only the
  // finished-line pass: each pass of the two safeMsg lines is pinned alone.
  it.each([
    ['did not turn DeletionProtection off', 'NotAuthorizedException', 2],
    ['refused the echoed configuration', 'InvalidParameterException', 1],
  ] as const)('masks the "%s" line per value AND as a whole', async (needle, name, writes) => {
    const broken = 'line\nbreak';
    const err = Object.assign(new Error(`bad ${broken}`), { name, $metadata: { httpStatusCode: 400 } });
    const perValue = await debugAfter(
      Array.from({ length: writes }, () => err),
      (t) => t.split(broken).join('***')
    );
    expect(perValue.find((l) => l.includes(needle))).toMatch(/: bad \*\*\*$/);
    childLogger.debug.mockClear();
    const plain = Object.assign(new Error('bad'), { name, $metadata: { httpStatusCode: 400 } });
    const seam = `${site.physicalId}: bad`;
    const whole = await debugAfter(
      Array.from({ length: writes }, () => plain),
      (t) => t.split(seam).join('***')
    );
    expect(whole.find((l) => l.includes(needle))).toMatch(/ \*\*\*$/);
  });

  // The compensating write-back echoes the pool too, so its refusal can quote
  // the same members. Reached when the re-read guard already reads ON.
  it.each([
    ['per value', 'line\nbreak', (t: string) => t.split('line\nbreak').join('***')],
    ['as a whole', 'bad', (t: string) => t.split(`${site.physicalId} failed: bad`).join('***')],
  ] as const)('masks the failed write-back line %s', async (_l, text, mask) => {
    cognitoSend.mockImplementation(async (cmd: Cmd) => {
      const name = cmd.constructor.name;
      if (name === site.describe) return site.describeReply(true);
      if (name === site.modify && !site.isDisable(cmd)) {
        throw Object.assign(new Error(text), { name: 'AccessDeniedException' });
      }
      if (name === site.del) throw terminalRefusal();
      return {};
    });
    await site
      .make()
      .delete('Res', site.physicalId, site.resourceType, undefined, { ...CTX, maskSecrets: mask })
      .catch(() => undefined);
    const line = childLogger.debug.mock.calls
      .map((c) => String(c[0]))
      .find((l) => l.startsWith('Writing DeletionProtection back on'));
    expect(line).toMatch(/\*\*\*$/);
  });
});
