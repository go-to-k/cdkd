import { describe, expect, it, beforeEach, afterEach, vi } from 'vite-plus/test';

/**
 * The STS hop `--assume-role` takes, stubbed to FAIL — the only shape in
 * `applyLambdaCredentialEnv` where the forwarded triple is what the container
 * keeps (see the case that uses it). The client is built inside the command
 * module, so the SDK PACKAGE is the mock, not `src/utils/aws-clients.js`.
 */
const stsConstructions = vi.hoisted(() => ({ count: 0 }));

vi.mock('@aws-sdk/client-sts', () => ({
  STSClient: vi.fn(function STSClient(this: unknown) {
    stsConstructions.count++;
    return {
      // Rejecting from `send` is how production fails: `assumeLambdaExecutionRole`
      // awaits `sts.send(new AssumeRoleCommand(...))` inside a `try` whose
      // `catch` is the fall-through under test. A mock that returned an empty
      // response would take a DIFFERENT arm (the `no usable credentials` throw
      // one frame in), so this is the call site's shape, not the type's.
      send: () =>
        Promise.reject(
          new Error('AccessDenied: User is not authorized to perform sts:AssumeRole')
        ),
      destroy: () => {},
    };
  }),
  AssumeRoleCommand: vi.fn(function AssumeRoleCommand(this: unknown) {}),
  GetCallerIdentityCommand: vi.fn(function GetCallerIdentityCommand(this: unknown) {}),
}));

import {
  resetAwsClientDefaults,
  setAssumedRoleCredentials,
  setPreAssumeEnvCredentials,
} from '../../../src/utils/aws-client-defaults.js';
import { applyCallerIdentityCredentials } from '../../../src/utils/caller-credentials.js';
import {
  forwardAwsEnv as forwardAwsEnvInvoke,
  applyLambdaCredentialEnv,
  applyProfileCredentialsOverlay,
} from '../../../src/cli/commands/local-invoke.js';
import { forwardAwsEnv as forwardAwsEnvStartApi } from '../../../src/cli/commands/local-start-api.js';
import { forwardAwsEnv as forwardAwsEnvAgentCore } from '../../../src/cli/commands/local-invoke-agentcore.js';

/**
 * Issue [#3130](https://github.com/go-to-k/cdkd/issues/3130): a `--role-arn`
 * assumed role must never reach an emulated container through the process
 * environment.
 *
 * `applyRoleArnIfSet` overwrites `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` /
 * `AWS_SESSION_TOKEN` with the role's credentials; every `cdkd local *` command
 * copies that triple into the container. These cases drive the copy directly
 * with the module-global role state set the way the assume leaves it, which is
 * the whole mechanism minus the STS hop.
 *
 * Every negative case asserts on the KEY THE REGRESSION WOULD DELIVER — the
 * role's literal access key id — rather than on a field merely being present,
 * so a change that swaps one wrong identity for another still reds.
 */

/** What `sts:AssumeRole` handed `--role-arn`, and what the container must never see. */
const ROLE_AKID = 'ASIA-DEPLOY-ROLE-AKID';
const ROLE_SECRET = 'DEPLOY-ROLE-SECRET';
const ROLE_SESSION = 'DEPLOY-ROLE-SESSION-TOKEN';

/** What the developer's shell held before the assume. */
const CALLER_AKID = 'AKIA-CALLER-AKID';
const CALLER_SECRET = 'CALLER-SECRET';

const CREDENTIAL_KEYS = ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN'];
/**
 * Every variable a case here reads or writes, cleared before each case and put
 * back after. The REGION pair is included even though the fix does not touch
 * it: `forwardAwsEnv` copies it, so a developer's ambient `AWS_REGION` would
 * otherwise decide whether the last case's assertion means anything.
 */
const MANAGED_KEYS = [
  'AWS_PROFILE',
  'AWS_REGION',
  'AWS_DEFAULT_REGION',
  ...CREDENTIAL_KEYS,
];

/**
 * Put the process into the state `applyRoleArnIfSet` leaves it in: the role
 * published to `awsClientDefaults`, the role's triple in `process.env`, and the
 * caller's own triple (or its absence) snapshotted.
 */
function simulateAssumedRole(caller: { accessKeyId: string; secretAccessKey: string } | undefined) {
  setPreAssumeEnvCredentials(caller);
  setAssumedRoleCredentials({
    accessKeyId: ROLE_AKID,
    secretAccessKey: ROLE_SECRET,
    sessionToken: ROLE_SESSION,
  });
  process.env['AWS_ACCESS_KEY_ID'] = ROLE_AKID;
  process.env['AWS_SECRET_ACCESS_KEY'] = ROLE_SECRET;
  process.env['AWS_SESSION_TOKEN'] = ROLE_SESSION;
}

describe('a --role-arn assumed role never reaches an emulated container (issue #3130)', () => {
  const saved = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const key of MANAGED_KEYS) saved.set(key, process.env[key]);
    for (const key of MANAGED_KEYS) delete process.env[key];
    resetAwsClientDefaults();
  });

  afterEach(() => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    saved.clear();
    resetAwsClientDefaults();
  });

  // --- The three profile-selection shapes, all three forwarding sites --------

  const forwarders: [string, (env: Record<string, string>) => void][] = [
    ['cdkd local invoke', forwardAwsEnvInvoke],
    ['cdkd local start-api', forwardAwsEnvStartApi],
    ['cdkd local invoke-agentcore', forwardAwsEnvAgentCore],
  ];

  for (const [command, forwardAwsEnv] of forwarders) {
    describe(command, () => {
      it('forwards the caller identity, not the role, with NO profile selected', () => {
        // The shape the reviewers found: no `--profile`, no `AWS_PROFILE`, so
        // `applyProfileCredentialsOverlay` is a no-op and the copied triple was
        // the only thing the container ever saw.
        simulateAssumedRole({ accessKeyId: CALLER_AKID, secretAccessKey: CALLER_SECRET });
        const env: Record<string, string> = {};

        forwardAwsEnv(env);

        expect(env['AWS_ACCESS_KEY_ID']).toBe(CALLER_AKID);
        expect(env['AWS_ACCESS_KEY_ID']).not.toBe(ROLE_AKID);
        expect(env['AWS_SECRET_ACCESS_KEY']).toBe(CALLER_SECRET);
        // The caller's key pair is long-lived, so the role's session token must
        // not survive beside it — a mismatched pair fails inside the container.
        expect(env['AWS_SESSION_TOKEN']).toBeUndefined();
      });

      it('does not gate the restore on AWS_PROFILE, and does not forward it either', () => {
        // HONEST LABEL (issue go-to-k/cdkd#3250 item 3). This was written as a
        // third "profile-selection polarity", and measured it is not one:
        // `forwardAwsEnv` never reads `AWS_PROFILE`, so deleting the export
        // below leaves the case byte-identical to the one above it and it could
        // not red on the go-to-k/cdkd#3130 regression.
        //
        // It is kept, and re-pointed at what it CAN discriminate. Two plausible
        // "fixes" would red here and nowhere else: skipping the restore when a
        // profile looks selected (the shape that made the class look mitigated
        // — the flag mitigates it, the exported variable does not), and adding
        // `AWS_PROFILE` to the pass-through list, which would send the
        // container's SDK looking for a profile no file inside it defines.
        //
        // The flag-vs-variable distinction itself lives one layer up, in each
        // handler's `options.profile ? await resolveProfileCredentials(...) :
        // undefined`, and that expression sits inline in a command body with no
        // unit seam — stated here rather than asserted somewhere it is not.
        process.env['AWS_PROFILE'] = 'dev';
        simulateAssumedRole({ accessKeyId: CALLER_AKID, secretAccessKey: CALLER_SECRET });
        const env: Record<string, string> = {};

        forwardAwsEnv(env);

        expect(env['AWS_ACCESS_KEY_ID']).toBe(CALLER_AKID);
        expect(env['AWS_ACCESS_KEY_ID']).not.toBe(ROLE_AKID);
        expect(env['AWS_SECRET_ACCESS_KEY']).not.toBe(ROLE_SECRET);
        expect(env['AWS_SESSION_TOKEN']).toBeUndefined();
        expect(env['AWS_PROFILE'], 'AWS_PROFILE must not be forwarded').toBeUndefined();
      });

      it('STRIPS the triple when the caller had no static credentials (SSO / IMDS)', () => {
        // Nothing to restore: the caller resolves through SSO / IMDS / a
        // container role, so the triple was ABSENT before the assume. Leaving
        // the role's in place is the defect; fabricating one is not available.
        // The container falls back to its own resolution instead.
        simulateAssumedRole(undefined);
        const env: Record<string, string> = {};

        forwardAwsEnv(env);

        for (const key of CREDENTIAL_KEYS) {
          expect(env[key], `${key} must not be forwarded`).toBeUndefined();
        }
        expect(Object.values(env)).not.toContain(ROLE_AKID);
      });

      it('leaves a run with NO role assumed byte-identical', () => {
        // The overwhelmingly common path. No role was published, so the copied
        // triple IS the caller's and nothing may disturb it.
        process.env['AWS_ACCESS_KEY_ID'] = CALLER_AKID;
        process.env['AWS_SECRET_ACCESS_KEY'] = CALLER_SECRET;
        process.env['AWS_SESSION_TOKEN'] = 'CALLER-SESSION';
        const env: Record<string, string> = {};

        forwardAwsEnv(env);

        expect(env['AWS_ACCESS_KEY_ID']).toBe(CALLER_AKID);
        expect(env['AWS_SECRET_ACCESS_KEY']).toBe(CALLER_SECRET);
        // Including a session token the caller genuinely holds: an SSO caller
        // with no `--role-arn` must keep working exactly as before.
        expect(env['AWS_SESSION_TOKEN']).toBe('CALLER-SESSION');
      });
    });
  }

  // --- The `--profile` FLAG shape, through the real precedence chain --------

  it('lets the --profile overlay OUTRANK the restored caller identity', async () => {
    // HONEST LABEL (issue go-to-k/cdkd#3250 item 3). This was written as the
    // third profile-selection polarity, and measured it cannot red on the
    // go-to-k/cdkd#3130 regression: `applyProfileCredentialsOverlay`
    // unconditionally overwrites all three keys, so the role is gone whether or
    // not `forwardAwsEnv` restored anything.
    //
    // What it DOES discriminate is PRECEDENCE, which is a real decision this
    // work made: both the restore and the overlay produce a caller identity,
    // the flag is the more specific of the two, and it is applied last on
    // purpose. Reversing that order, or dropping the overlay, reds here.
    simulateAssumedRole({ accessKeyId: CALLER_AKID, secretAccessKey: CALLER_SECRET });
    const dockerEnv: Record<string, string> = {};

    await applyLambdaCredentialEnv(dockerEnv, {
      profileCredentials: {
        accessKeyId: 'AKIA-PROFILE',
        secretAccessKey: 'PROFILE-SECRET',
        sessionToken: 'PROFILE-SESSION',
      },
    });

    expect(dockerEnv['AWS_ACCESS_KEY_ID']).toBe('AKIA-PROFILE');
    expect(dockerEnv['AWS_SECRET_ACCESS_KEY']).toBe('PROFILE-SECRET');
    expect(dockerEnv['AWS_SESSION_TOKEN']).toBe('PROFILE-SESSION');
    expect(Object.values(dockerEnv)).not.toContain(ROLE_AKID);
    expect(Object.values(dockerEnv)).not.toContain(ROLE_SESSION);
  });

  it('leaves a legitimate --profile-only run (no role published) unchanged', async () => {
    // The regression guard for the fix itself: with no `--role-arn`, the
    // profile overlay must still be the only thing that decides the container's
    // credentials, exactly as it did before this change.
    process.env['AWS_ACCESS_KEY_ID'] = 'AKIA-SHELL';
    process.env['AWS_SECRET_ACCESS_KEY'] = 'SHELL-SECRET';
    const dockerEnv: Record<string, string> = {};

    await applyLambdaCredentialEnv(dockerEnv, {
      profileCredentials: { accessKeyId: 'AKIA-PROFILE', secretAccessKey: 'PROFILE-SECRET' },
      profileCredsFile: { containerPath: '/cdkd-aws/credentials', profileName: 'dev' },
    });

    expect(dockerEnv['AWS_ACCESS_KEY_ID']).toBe('AKIA-PROFILE');
    expect(dockerEnv['AWS_SECRET_ACCESS_KEY']).toBe('PROFILE-SECRET');
    expect(dockerEnv['AWS_SHARED_CREDENTIALS_FILE']).toBe('/cdkd-aws/credentials');
    expect(dockerEnv['AWS_PROFILE']).toBe('dev');
  });

  it('falls back to the CALLER, not the role, when --assume-role\'s STS hop fails', async () => {
    // Issue go-to-k/cdkd#3250 item 3: the arm where the distinction genuinely
    // lives. `applyLambdaCredentialEnv` degrades rather than hard-errors when
    // `sts:AssumeRole` is refused — a config gap, not a cdkd bug — and with no
    // `--profile` to overlay, the forwarded triple is the LAST word on what the
    // container runs as. Before go-to-k/cdkd#3130 that triple was cdkd's deploy
    // role, so the documented "falls back to the developer's shell credentials"
    // handed the emulated function MORE permission than the failed assume asked
    // for.
    //
    // This is a WIRING assertion the `forwardAwsEnv` cases above cannot make:
    // they prove the copy restores, not that this fall-through goes through the
    // copy. A rewrite reading `process.env` directly here passes every one of
    // them and reds this.
    simulateAssumedRole({ accessKeyId: CALLER_AKID, secretAccessKey: CALLER_SECRET });
    const dockerEnv: Record<string, string> = {};
    const before = stsConstructions.count;

    await applyLambdaCredentialEnv(dockerEnv, {
      assumeRoleArn: 'arn:aws:iam::111122223333:role/FunctionExecutionRole',
      region: 'us-east-1',
    });

    // BOUND THE ARM before asserting on its outcome. If production silently
    // stopped honouring `assumeRoleArn`, this case would take the ordinary
    // no-assume path — which produces the identical env bag — and stay green
    // while asserting nothing about the fall-through it is named for.
    expect(
      stsConstructions.count - before,
      'the STS hop must have been attempted, or this is not the fall-through case'
    ).toBe(1);
    expect(dockerEnv['AWS_ACCESS_KEY_ID']).toBe(CALLER_AKID);
    expect(dockerEnv['AWS_ACCESS_KEY_ID']).not.toBe(ROLE_AKID);
    expect(dockerEnv['AWS_SECRET_ACCESS_KEY']).toBe(CALLER_SECRET);
    expect(Object.values(dockerEnv)).not.toContain(ROLE_SESSION);
  });

  it('STRIPS rather than falling back to the role when the STS hop fails and the caller had none', async () => {
    // The same fall-through over an SSO / IMDS caller: there is nothing to put
    // back, so the container gets no triple at all and resolves its own. The
    // negative control for the case above — without it, "the caller's key is
    // present" is satisfiable by a code path that simply never strips.
    simulateAssumedRole(undefined);
    const dockerEnv: Record<string, string> = {};
    const before = stsConstructions.count;

    await applyLambdaCredentialEnv(dockerEnv, {
      assumeRoleArn: 'arn:aws:iam::111122223333:role/FunctionExecutionRole',
      region: 'us-east-1',
    });

    expect(
      stsConstructions.count - before,
      'the STS hop must have been attempted, or this is not the fall-through case'
    ).toBe(1);
    for (const key of CREDENTIAL_KEYS) {
      expect(dockerEnv[key], `${key} must not be forwarded`).toBeUndefined();
    }
    expect(Object.values(dockerEnv)).not.toContain(ROLE_AKID);
  });

  // --- The helper's own contract -------------------------------------------

  it('is a no-op on an env bag when no role was assumed', () => {
    // Proves the restore cannot damage the default path by, say, stripping a
    // token an overlay put there. Nothing was published, so nothing changes.
    const env: Record<string, string> = {
      AWS_ACCESS_KEY_ID: 'AKIA-UNTOUCHED',
      AWS_SECRET_ACCESS_KEY: 'UNTOUCHED-SECRET',
      AWS_SESSION_TOKEN: 'UNTOUCHED-SESSION',
      AWS_REGION: 'us-east-1',
    };

    applyCallerIdentityCredentials(env);

    expect(env).toEqual({
      AWS_ACCESS_KEY_ID: 'AKIA-UNTOUCHED',
      AWS_SECRET_ACCESS_KEY: 'UNTOUCHED-SECRET',
      AWS_SESSION_TOKEN: 'UNTOUCHED-SESSION',
      AWS_REGION: 'us-east-1',
    });
  });

  it('restores a caller session token when the caller genuinely had one', () => {
    // An SSO caller who ALSO exported a triple: the snapshot carries a session
    // token, and it must come back rather than being stripped as a mismatch.
    setPreAssumeEnvCredentials({
      accessKeyId: CALLER_AKID,
      secretAccessKey: CALLER_SECRET,
      sessionToken: 'CALLER-SESSION',
    });
    setAssumedRoleCredentials({
      accessKeyId: ROLE_AKID,
      secretAccessKey: ROLE_SECRET,
      sessionToken: ROLE_SESSION,
    });
    const env: Record<string, string> = {
      AWS_ACCESS_KEY_ID: ROLE_AKID,
      AWS_SECRET_ACCESS_KEY: ROLE_SECRET,
      AWS_SESSION_TOKEN: ROLE_SESSION,
    };

    applyCallerIdentityCredentials(env);

    expect(env['AWS_ACCESS_KEY_ID']).toBe(CALLER_AKID);
    expect(env['AWS_SESSION_TOKEN']).toBe('CALLER-SESSION');
    expect(env['AWS_SESSION_TOKEN']).not.toBe(ROLE_SESSION);
  });

  it('keeps the region the forward copied', () => {
    // The restore is credential-only; the same invariant
    // `applyProfileCredentialsOverlay` documents. A stripped region would send
    // every SDK client in the container to the wrong endpoint.
    process.env['AWS_REGION'] = 'ap-northeast-1';
    simulateAssumedRole(undefined);
    const env: Record<string, string> = {};

    forwardAwsEnvInvoke(env);

    expect(env['AWS_REGION']).toBe('ap-northeast-1');
    expect(env['AWS_ACCESS_KEY_ID']).toBeUndefined();
    // And the profile overlay still layers on top of a stripped bag.
    applyProfileCredentialsOverlay(
      env,
      { accessKeyId: 'AKIA-PROFILE', secretAccessKey: 'PROFILE-SECRET' },
      false
    );
    expect(env['AWS_ACCESS_KEY_ID']).toBe('AKIA-PROFILE');
    expect(env['AWS_REGION']).toBe('ap-northeast-1');
  });
});
