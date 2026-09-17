import { describe, expect, it, beforeEach, afterEach } from 'vite-plus/test';

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

      it('forwards the caller identity, not the role, with AWS_PROFILE EXPORTED', () => {
        // `AWS_PROFILE` in the environment rather than `--profile` on the
        // command line: `options.profile` is unset, so no profile credentials
        // are resolved and no overlay runs. Before the fix this shape got the
        // role even though the user had named an identity.
        process.env['AWS_PROFILE'] = 'dev';
        simulateAssumedRole({ accessKeyId: CALLER_AKID, secretAccessKey: CALLER_SECRET });
        const env: Record<string, string> = {};

        forwardAwsEnv(env);

        expect(env['AWS_ACCESS_KEY_ID']).toBe(CALLER_AKID);
        expect(env['AWS_ACCESS_KEY_ID']).not.toBe(ROLE_AKID);
        expect(env['AWS_SECRET_ACCESS_KEY']).not.toBe(ROLE_SECRET);
        expect(env['AWS_SESSION_TOKEN']).toBeUndefined();
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

  it('gives the container the --profile identity, never the role, when --profile is passed', async () => {
    // The third profile-selection shape. `--profile` resolves its own
    // credentials (through `ignoreAssumedRole: true`) and the overlay applies
    // them after the forward — so the assertion is that the role does not
    // survive either step, in either field.
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
