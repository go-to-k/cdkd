import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test';

import { resolveHostCredentialsForSigV4 } from '../../../src/cli/commands/local-invoke-agentcore.js';
import {
  resetAwsClientDefaults,
  setAssumedRoleCredentials,
  setPreAssumeEnvCredentials,
} from '../../../src/utils/aws-client-defaults.js';
import { CdkdError } from '../../../src/utils/error-handler.js';

/**
 * Who signs `/invocations` on a `--sigv4` run.
 *
 * The env-channel fence (`tests/unit/local/local-surface-env-identity.test.ts`)
 * records this as its only `reads-caller` site, but a source-shape fence sees
 * the SITE, not the behaviour: it cannot tell `callerEnvCredentials()` from a
 * `process.env` read that happens to compile. The value decided here is what
 * the emulated agent sees as its INVOKER, so the regression it guards --
 * issue [#3130](https://github.com/go-to-k/cdkd/issues/3130), signing as cdkd's
 * `--role-arn` deploy role instead of the caller -- is invisible to every other
 * test in the suite.
 *
 * The discriminator is that the CALLER's key and the ROLE's key are different
 * strings, and `applyRoleArnIfSet` leaves the role's in `process.env`: a
 * regression that reads the environment returns `ROLE_KEY` while a correct
 * read returns `CALLER_KEY`, and only asserting on the literal tells them
 * apart.
 *
 * TWO OF THE FOUR PRECEDENCE ARMS ARE NOT COVERED HERE, and the reason is the
 * same for both: `--assume-role` drives an `sts:AssumeRole` and `--profile`
 * drives `resolveProfileCredentials`, so either one transacts with AWS and the
 * suite's network fence refuses it (measured -- a `--profile` case failed with
 * exactly that refusal). Mocking the far side would make the case agree with
 * whatever this file assumes about precedence, which is the thing under test.
 * They belong in an integ fixture that passes `--role-arn`, and none exists
 * yet -- go-to-k/cdkd#3250 carries that gap. What IS covered is the arm the
 * regression lived in: the shell-credential read, its refusal, and the token
 * handling, all reached with neither flag set.
 */

const CALLER_KEY = 'AKIACALLEROWNCREDS000';
const CALLER_SECRET = 'caller-secret';
const CALLER_TOKEN = 'caller-token';
const ROLE_KEY = 'ASIAASSUMEDROLECREDS0';
const ROLE_SECRET = 'role-secret';
const ROLE_TOKEN = 'role-token';

const OWNED_ENV = [
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_PROFILE',
] as const;

/** Minimal shapes: this function reads only `profile` off the options bag, and
 * reaches `resolveAssumeRoleArn` with the other two. A runtime carrying no role
 * and no state record is the no-`--assume-role` case. */
const NO_ASSUME_ROLE = {
  runtimeArn: 'arn:aws:bedrock-agentcore:us-east-1:111122223333:runtime/Agent',
  runtimeName: 'Agent',
} as never;

describe('resolveHostCredentialsForSigV4: the agent is signed for by its CALLER, never the --role-arn role', () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of OWNED_ENV) saved[k] = process.env[k];
    resetAwsClientDefaults();
  });

  afterEach(() => {
    for (const k of OWNED_ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    resetAwsClientDefaults();
  });

  /** What `applyRoleArnIfSet` leaves behind: the snapshot holds the caller, the
   * environment holds the role. */
  function simulateAssumedRole(): void {
    setPreAssumeEnvCredentials({
      accessKeyId: CALLER_KEY,
      secretAccessKey: CALLER_SECRET,
      sessionToken: CALLER_TOKEN,
    });
    setAssumedRoleCredentials({
      accessKeyId: ROLE_KEY,
      secretAccessKey: ROLE_SECRET,
      sessionToken: ROLE_TOKEN,
    });
    process.env['AWS_ACCESS_KEY_ID'] = ROLE_KEY;
    process.env['AWS_SECRET_ACCESS_KEY'] = ROLE_SECRET;
    process.env['AWS_SESSION_TOKEN'] = ROLE_TOKEN;
  }

  it('signs as the CALLER after --role-arn overwrote the environment with the role', async () => {
    simulateAssumedRole();
    delete process.env['AWS_PROFILE'];

    const creds = await resolveHostCredentialsForSigV4(
      {} as never,
      NO_ASSUME_ROLE,
      undefined,
      'us-east-1'
    );

    // The literal, not "is defined": reading `process.env` directly -- the
    // pre-fix behaviour -- also yields a well-formed bag, carrying ROLE_KEY.
    expect(creds.accessKeyId).toBe(CALLER_KEY);
    expect(creds.secretAccessKey).toBe(CALLER_SECRET);
    expect(creds.sessionToken).toBe(CALLER_TOKEN);
    expect(creds.accessKeyId).not.toBe(ROLE_KEY);
  });

  it('carries the caller session token only when the caller actually had one', async () => {
    setPreAssumeEnvCredentials({ accessKeyId: CALLER_KEY, secretAccessKey: CALLER_SECRET });
    setAssumedRoleCredentials({
      accessKeyId: ROLE_KEY,
      secretAccessKey: ROLE_SECRET,
      sessionToken: ROLE_TOKEN,
    });
    process.env['AWS_ACCESS_KEY_ID'] = ROLE_KEY;
    process.env['AWS_SECRET_ACCESS_KEY'] = ROLE_SECRET;
    process.env['AWS_SESSION_TOKEN'] = ROLE_TOKEN;
    delete process.env['AWS_PROFILE'];

    const creds = await resolveHostCredentialsForSigV4(
      {} as never,
      NO_ASSUME_ROLE,
      undefined,
      'us-east-1'
    );

    expect(creds.accessKeyId).toBe(CALLER_KEY);
    // A long-lived caller key beside the ROLE's session token would make the
    // signature fail; the role's token must not be inherited.
    expect(creds.sessionToken).toBeUndefined();
  });

  it('REFUSES rather than falling back to the role when the caller had no static credentials', async () => {
    // The SSO / instance-role / container-role shape: nothing to snapshot, and
    // the environment holds only what the assume wrote.
    setAssumedRoleCredentials({
      accessKeyId: ROLE_KEY,
      secretAccessKey: ROLE_SECRET,
      sessionToken: ROLE_TOKEN,
    });
    process.env['AWS_ACCESS_KEY_ID'] = ROLE_KEY;
    process.env['AWS_SECRET_ACCESS_KEY'] = ROLE_SECRET;
    process.env['AWS_SESSION_TOKEN'] = ROLE_TOKEN;
    delete process.env['AWS_PROFILE'];

    const err = await resolveHostCredentialsForSigV4(
      {} as never,
      NO_ASSUME_ROLE,
      undefined,
      'us-east-1'
    ).then(
      (creds) => creds,
      (e: unknown) => e
    );

    // Bound the arm before asserting on it: a bag here means the refusal did
    // not fire, and the message alone cannot say which value it would have
    // signed with.
    expect(err, 'expected a refusal, not credentials').toBeInstanceOf(CdkdError);
    expect((err as CdkdError).code).toBe('LOCAL_INVOKE_AGENTCORE_SIGV4_NO_CREDENTIALS');
    expect((err as CdkdError).message).not.toContain(ROLE_KEY);
  });

  it('is a no-op path when no role was assumed: the caller IS the environment', async () => {
    // The control. With no role published, the snapshot is absent and the
    // environment is the caller's own -- the overwhelmingly common run.
    process.env['AWS_ACCESS_KEY_ID'] = CALLER_KEY;
    process.env['AWS_SECRET_ACCESS_KEY'] = CALLER_SECRET;
    delete process.env['AWS_SESSION_TOKEN'];
    delete process.env['AWS_PROFILE'];

    const creds = await resolveHostCredentialsForSigV4(
      {} as never,
      NO_ASSUME_ROLE,
      undefined,
      'us-east-1'
    );

    expect(creds.accessKeyId).toBe(CALLER_KEY);
    expect(creds.secretAccessKey).toBe(CALLER_SECRET);
  });
});
