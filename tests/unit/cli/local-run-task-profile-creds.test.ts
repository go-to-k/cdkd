import { readFileSync } from 'node:fs';

import { describe, expect, it, vi, beforeEach, afterEach } from 'vite-plus/test';
import {
  buildRunEcsTaskOptions,
  resolveSidecarCredentials,
  resolveTaskCredentialChannels,
} from '../../../src/cli/commands/local-run-task.js';
import {
  resetAwsClientDefaults,
  setAssumedRoleCredentials,
  setPreAssumeEnvCredentials,
} from '../../../src/utils/aws-client-defaults.js';

// Issue #658: `cdkd local run-task --profile <p>` (without
// `--assume-task-role`) used to resolve the profile for cdkd's OWN AWS
// calls but the AWS-published `amazon-ecs-local-container-endpoints`
// sidecar started with empty `AWS_*` env, so every user container that
// hit `169.254.170.2/role/<role>` got a credential-provider failure.
// This test exercises the small `resolveSidecarCredentials` helper that
// drives the new precedence: assumed-creds win when set; otherwise the
// profile chain is resolved; otherwise undefined (the pre-existing
// "sidecar uses its own default chain" path).
//
// Same gap class as #654/#655 (which shipped for `cdkd local start-api`'s
// Lambda container env overlay); the helper-extraction pattern mirrors
// PR #655's `resolveProfileCredentials` test surface.

const credsProviderMock = vi.fn();
const stsDestroyMock = vi.fn();
const stsCtorMock = vi.fn();

vi.mock('@aws-sdk/client-sts', () => ({
  STSClient: vi.fn().mockImplementation((config: unknown) => {
    stsCtorMock(config);
    return {
      config: { credentials: credsProviderMock },
      destroy: stsDestroyMock,
    };
  }),
}));

describe('resolveSidecarCredentials (issue #658)', () => {
  beforeEach(() => {
    credsProviderMock.mockReset();
    stsDestroyMock.mockReset();
    stsCtorMock.mockReset();
  });

  it('returns the assumed credentials verbatim when --assume-task-role is effective (assume wins over --profile)', async () => {
    const assumed = {
      accessKeyId: 'AKIA-ASSUMED',
      secretAccessKey: 'SECRET-ASSUMED',
      sessionToken: 'SESSION-ASSUMED',
    };
    // Both `--profile` AND `--assume-task-role` set; assume must win.
    const result = await resolveSidecarCredentials({ profile: 'my-sso' }, assumed);
    expect(result).toBe(assumed);
    // The SDK STS client must NOT be touched on this path — the assumed
    // creds came from an earlier STS hop, the sidecar resolver is a no-op.
    expect(stsCtorMock).not.toHaveBeenCalled();
    expect(credsProviderMock).not.toHaveBeenCalled();
  });

  it('resolves --profile via the SDK default chain when --assume-task-role is NOT effective', async () => {
    credsProviderMock.mockResolvedValue({
      accessKeyId: 'AKIA-PROFILE',
      secretAccessKey: 'SECRET-PROFILE',
      sessionToken: 'SESSION-PROFILE',
    });
    const result = await resolveSidecarCredentials({ profile: 'my-sso' }, undefined);
    expect(result).toEqual({
      accessKeyId: 'AKIA-PROFILE',
      secretAccessKey: 'SECRET-PROFILE',
      sessionToken: 'SESSION-PROFILE',
    });
    // STSClient instantiated with the profile so SSO / fromIni resolve.
    expect(stsCtorMock).toHaveBeenCalledWith({ profile: 'my-sso' });
    expect(stsDestroyMock).toHaveBeenCalledOnce();
  });

  it('returns undefined when neither --profile nor --assume-task-role is set (sidecar falls back to its own default chain)', async () => {
    const result = await resolveSidecarCredentials({}, undefined);
    expect(result).toBeUndefined();
    // No AWS calls at all — pre-existing "lowest precedence" path.
    expect(stsCtorMock).not.toHaveBeenCalled();
    expect(credsProviderMock).not.toHaveBeenCalled();
  });

  it('propagates resolveProfileCredentials errors (expired SSO etc.) — no silent fallback', async () => {
    credsProviderMock.mockRejectedValue(
      new Error('The SSO session associated with this profile has expired')
    );
    await expect(
      resolveSidecarCredentials({ profile: 'expired-sso' }, undefined)
    ).rejects.toThrow(/SSO session.*expired/);
  });
});

/**
 * Issue [#3378](https://github.com/go-to-k/cdkd/issues/3378): the INI
 * credentials-file gate's ANNOTATION, made falsifiable.
 *
 * PR go-to-k/cdkd#3376 gave every `writeProfileCredentialsFile(...)` call site a
 * `cdkd-local-env-identity:` verdict, and
 * `tests/unit/local/local-surface-env-identity.test.ts` fences that each one
 * EXISTS and carries a reason. A source-shape fence cannot check that a reason
 * is TRUE, and this was the one of the four whose reason nothing else backed:
 * the sibling `local-run-task-profile-creds` cases above cover
 * `resolveSidecarCredentials`'s PRECEDENCE, not the gate, and their
 * `toHaveBeenCalledWith({ profile })` cannot discriminate `ignoreAssumedRole`
 * because no `--role-arn` role is ever published in them.
 *
 * The claim under test: `!assumedCredentials` proves `resolveSidecarCredentials`
 * reached its `--profile` arm, so the bytes bind-mounted into every user
 * container are the caller's own chain -- never cdkd's `--role-arn` deploy role,
 * and never an `--assume-task-role` STS result.
 *
 * Three identities, three DIFFERENT access key ids, because "the file was
 * written" is a confluence point that every wrong answer also reaches. The
 * discriminator is WHOSE bytes are in it, so the assertions read the real file
 * off disk rather than a mock's arguments -- a mock records what the caller
 * passed, which is the half already fenced.
 */
const PROFILE_KEY = 'AKIAPROFILEOWNCHAIN00';
const TASK_ROLE_KEY = 'ASIAASSUMETASKROLE000';
const DEPLOY_ROLE_KEY = 'ASIACDKDDEPLOYROLE000';

describe('resolveTaskCredentialChannels: which identity reaches the mounted INI file (issue #3378)', () => {
  beforeEach(() => {
    credsProviderMock.mockReset();
    stsDestroyMock.mockReset();
    stsCtorMock.mockReset();
    resetAwsClientDefaults();
    // cdkd's own `--role-arn` deploy role, published exactly as
    // `applyRoleArnIfSet` publishes it. This is the identity that must never
    // reach the file, and without it the `ignoreAssumedRole` assertion below
    // is vacuous -- there is nothing for the opt-out to opt OUT of.
    setPreAssumeEnvCredentials({
      accessKeyId: 'AKIACALLERSTATICPAIR0',
      secretAccessKey: 'caller-secret',
    });
    setAssumedRoleCredentials({
      accessKeyId: DEPLOY_ROLE_KEY,
      secretAccessKey: 'deploy-role-secret',
      sessionToken: 'deploy-role-token',
    });
  });

  afterEach(() => {
    resetAwsClientDefaults();
  });

  it('writes NO file at all when --assume-task-role won, even though --profile is also set', async () => {
    const assumed = {
      accessKeyId: TASK_ROLE_KEY,
      secretAccessKey: 'task-role-secret',
      sessionToken: 'task-role-token',
    };
    const channels = await resolveTaskCredentialChannels({ profile: 'my-sso' }, assumed);

    // The gate's whole job. Dropping `!assumedCredentials` from it writes a
    // file here carrying the assumed task role -- a credential the documented
    // precedence says the metadata sidecar serves and the container's
    // `AWS_SHARED_CREDENTIALS_FILE` must not override.
    expect(channels.profileCredsFile).toBeUndefined();
    // And the sidecar still gets the assumed creds, so "no file" is not being
    // bought by the profile arm having silently won.
    expect(channels.sidecarCredentials).toBe(assumed);
    // No STS hop at all on this path.
    expect(stsCtorMock).not.toHaveBeenCalled();
  });

  it("writes the CALLER's own chain, and neither role's key, when the profile arm is the one that ran", async () => {
    credsProviderMock.mockResolvedValue({
      accessKeyId: PROFILE_KEY,
      secretAccessKey: 'profile-secret',
      sessionToken: 'profile-token',
    });

    const channels = await resolveTaskCredentialChannels({ profile: 'my-sso' }, undefined);
    const file = channels.profileCredsFile;
    expect(file, 'the profile arm must produce a file to mount').toBeDefined();
    try {
      const bytes = readFileSync(file!.hostPath, 'utf8');
      // The section header is the profile the user named, so handler code
      // calling `fromIni({ profile: 'my-sso' })` finds it.
      expect(bytes).toContain('[my-sso]');
      expect(bytes).toContain(`aws_access_key_id = ${PROFILE_KEY}`);
      expect(bytes).toContain('aws_session_token = profile-token');
      // The two identities that must NOT be in there. Asserted on the BYTES
      // rather than on what the writer was called with: the call arguments are
      // what the existing source-shape fence already sees.
      expect(bytes, 'cdkd --role-arn deploy role leaked into the container').not.toContain(
        DEPLOY_ROLE_KEY
      );
      expect(bytes, '--assume-task-role STS result leaked into the container').not.toContain(
        TASK_ROLE_KEY
      );
      // And the mechanism that keeps the deploy role out: the STS client is
      // built with NO `credentials` key, so the published role cannot outrank
      // `profile`. Without `ignoreAssumedRole` the bag lands there and the
      // file above would carry `DEPLOY_ROLE_KEY` instead.
      const config = stsCtorMock.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(config).not.toHaveProperty('credentials');
      expect(config).toMatchObject({ profile: 'my-sso' });
    } finally {
      await file?.dispose();
    }
  });

  it('writes no file when no profile was named, whatever else is published', async () => {
    const channels = await resolveTaskCredentialChannels({}, undefined);
    expect(channels.profileCredsFile).toBeUndefined();
    expect(channels.sidecarCredentials).toBeUndefined();
  });
});

/**
 * The WIRING below `resolveTaskCredentialChannels` — go-to-k/cdkd#3394, closed
 * here rather than deferred.
 *
 * The round-2 test review measured the gap precisely: mutating the command
 * body's `profileCredsFile = channels.profileCredsFile` to `undefined` left
 * **114 tests green across five files**, and no `local-run-task` integ passes
 * `--profile`, so `integ-local` would not have caught it either. The effect of
 * that mutation is that nothing is bind-mounted, so every handler calling
 * `fromIni({ profile })` inside the task container fails — the exact defect PR
 * go-to-k/cdkd#670 shipped this path to fix.
 *
 * The issue was filed claiming a real-AWS fixture was the only instrument. That
 * was wrong, and the review said so: the same extraction go-to-k/cdkd#3378
 * itself performed one layer up works here, with no AWS at all. "A probed
 * callee says nothing about its WIRING" is the rule; this is the caller half of
 * the probe pair the helper's own cases are the callee half of.
 */
describe('buildRunEcsTaskOptions: the credentials file reaches the runner (issue go-to-k/cdkd#3394)', () => {
  const BASE = {
    cluster: 'cdkd-local',
    containerHost: '127.0.0.1',
    pull: true,
    keepRunning: false,
    detach: false,
  };
  const FILE = {
    hostPath: '/tmp/cdkd-profile-creds-abc/credentials',
    containerPath: '/cdkd-aws/credentials',
    profileName: 'my-sso',
    dispose: async () => {},
  };

  it('mounts the file the channels produced, with the three fields the runner needs', () => {
    const runOpts = buildRunEcsTaskOptions(BASE, {
      sidecarCredentials: { accessKeyId: 'AKIA-SIDECAR', secretAccessKey: 'S' },
      profileCredsFile: FILE,
    });
    // The discriminator. `runOpts.profileCredentialsFile` is the ONLY route by
    // which the docker `-v` and `-e AWS_SHARED_CREDENTIALS_FILE` flags get
    // built, so its absence is silent everywhere except inside the container.
    expect(runOpts.profileCredentialsFile).toEqual({
      hostPath: FILE.hostPath,
      containerPath: FILE.containerPath,
      profileName: FILE.profileName,
    });
    // COPIED, not passed through: `dispose` stays with the command, which owns
    // the lifetime. A pass-through would hand the runner a way to unlink a file
    // its own containers have mounted.
    expect(runOpts.profileCredentialsFile).not.toHaveProperty('dispose');
    // And the sidecar's credentials travel by their own separate field, so one
    // channel going missing cannot be masked by the other being present.
    expect(runOpts.taskCredentials).toEqual({
      accessKeyId: 'AKIA-SIDECAR',
      secretAccessKey: 'S',
    });
  });

  it('omits the mount entirely when the channels produced no file', () => {
    // The other direction. `--assume-task-role` winning means the sidecar
    // serves the creds and the file must NOT exist, so an empty-object or
    // partially-populated `profileCredentialsFile` would be a different bug
    // from the one above -- the runner branches on its presence.
    const runOpts = buildRunEcsTaskOptions(BASE, {
      sidecarCredentials: { accessKeyId: 'AKIA-ASSUMED', secretAccessKey: 'S' },
      profileCredsFile: undefined,
    });
    expect(runOpts.profileCredentialsFile).toBeUndefined();
    expect(runOpts).not.toHaveProperty('profileCredentialsFile');
    expect(runOpts.taskCredentials).toEqual({
      accessKeyId: 'AKIA-ASSUMED',
      secretAccessKey: 'S',
    });
  });

  it('threads the rest of the bag, so the wiring case is not the only thing pinned', () => {
    // Each optional field is fed and read once. Without this a refactor could
    // drop any of them and only the two cases above would notice, which is the
    // same wiring blindness one field over.
    const runOpts = buildRunEcsTaskOptions(
      {
        ...BASE,
        pull: false,
        keepRunning: true,
        detach: true,
        platform: 'linux/arm64',
        region: 'eu-west-1',
        ecrRoleArn: 'arn:aws:iam::111122223333:role/Pull',
      },
      { sidecarCredentials: undefined, profileCredsFile: undefined },
      { envOverrides: { Web: { KEY: 'VALUE' } }, resolvedRoleArn: 'arn:aws:iam::111122223333:role/Task' }
    );
    expect(runOpts).toMatchObject({
      cluster: 'cdkd-local',
      containerHost: '127.0.0.1',
      skipPull: true,
      keepRunning: true,
      detach: true,
      platformOverride: 'linux/arm64',
      region: 'eu-west-1',
      ecrRoleArn: 'arn:aws:iam::111122223333:role/Pull',
      taskRoleArn: 'arn:aws:iam::111122223333:role/Task',
      envOverrides: { Web: { KEY: 'VALUE' } },
    });
    // `skipPull` is the INVERSE of `pull`, which is the one field here a
    // copy-paste can get backwards without changing a name.
    expect(buildRunEcsTaskOptions({ ...BASE, pull: true }, {
      sidecarCredentials: undefined,
      profileCredsFile: undefined,
    }).skipPull).toBe(false);
    // Absent optionals stay ABSENT rather than becoming `undefined` keys.
    expect(runOpts).not.toHaveProperty('taskCredentials');
  });
});
