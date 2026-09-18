import { rmSync } from 'node:fs';
import nodePath from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

/**
 * `cdkd local run-task --assume-task-role <arn> --profile <p>`: the PRECEDENCE
 * wiring, executed through the command body.
 *
 * The gap go-to-k/cdkd#3408's test review measured, and the sibling of
 * `local-run-task-command-body.test.ts` rather than a case inside it. The split
 * is forced: that file's whole claim is that it reads the BYTES the real AWS
 * SDK resolved out of a temp `AWS_SHARED_CREDENTIALS_FILE`, and proving THIS
 * requires `@aws-sdk/client-sts` to be mocked so `AssumeRole` returns a
 * distinguishable identity. A mocked STS in that file would fake the very
 * `fromIni` resolution its assertions rest on.
 *
 * ## What was unguarded
 *
 * `src/cli/commands/local-run-task.ts` passes BOTH channels' inputs in one
 * call:
 *
 * ```ts
 * channels = await resolveTaskCredentialChannels(options, assumedCredentials);
 * ```
 *
 * Mutating that second argument to `undefined` left **5160 tests across 206
 * files green**. The helper's own test
 * (`local-run-task-profile-creds.test.ts`) passes `assumedCredentials`
 * DIRECTLY, so it verifies the helper's decision and can say nothing about
 * whether the command body hands it the real value — "a probed callee says
 * nothing about its WIRING", one argument over from the residual
 * go-to-k/cdkd#3394 closed.
 *
 * ## Why it matters
 *
 * The documented precedence is assume-task-role > profile-file > sidecar
 * (issue #658). `resolveTaskCredentialChannels` implements it by gating the
 * credentials-file write on `!assumedCredentials`. Feed it `undefined` while
 * `--profile` is set and the gate opens: cdkd bind-mounts a credentials file
 * holding the CALLER's identity into a container that asked to run as the task
 * role, and the sidecar serves the caller too. That is a privilege
 * SUBSTITUTION the user cannot see — the container runs, and runs as the wrong
 * principal.
 */

const runEcsTaskMock = vi.fn();
const stsSendMock = vi.fn();

/** The identity `AssumeRole` returns. Must win. */
const ASSUMED_KEY = 'cdkd-unit-assumed-task-role-key-0001';
/** The identity the `--profile` chain would resolve. Must NOT reach the container. */
const PROFILE_KEY = 'cdkd-unit-profile-chain-key-0001';

// ONE mock serving both STS consumers in this path, because the command body
// reaches two: `assumeTaskRole` does `sts.send(AssumeRoleCommand)`, while
// `resolveProfileCredentials` reads and CALLS `sts.config.credentials`. Giving
// them different keys is the whole discriminator — with one shared value every
// assertion below would pass under the mutation.
vi.mock('@aws-sdk/client-sts', () => ({
  STSClient: vi.fn().mockImplementation(() => ({
    config: {
      credentials: vi
        .fn()
        .mockResolvedValue({ accessKeyId: PROFILE_KEY, secretAccessKey: 'profile-secret' }),
    },
    send: stsSendMock,
    destroy: vi.fn(),
  })),
  AssumeRoleCommand: vi.fn().mockImplementation((input: unknown) => ({ input })),
  GetCallerIdentityCommand: vi.fn().mockImplementation((input: unknown) => ({ input })),
}));

vi.mock('../../../src/local/docker-runner.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ensureDockerAvailable: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../src/local/docker-version.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveHostGatewayExtraHosts: vi.fn().mockResolvedValue([]),
}));
vi.mock('../../../src/utils/role-arn.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  applyRoleArnIfSet: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../src/cli/config-loader.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveApp: vi.fn().mockReturnValue('node app.js'),
}));
vi.mock('../../../src/synthesis/synthesizer.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  Synthesizer: vi.fn().mockImplementation(() => ({
    synthesize: vi.fn().mockResolvedValue({ stacks: [] }),
  })),
}));
vi.mock('../../../src/cli/commands/local-state-source.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  createLocalStateProvider: vi.fn().mockReturnValue(undefined),
}));
vi.mock('../../../src/local/ecs-task-resolver.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  parseEcsTarget: vi.fn().mockReturnValue({ stackPattern: undefined }),
  pickCandidateStack: vi.fn().mockReturnValue(undefined),
  resolveEcsTaskTarget: vi.fn().mockReturnValue({
    stack: { stackName: 'CdkdUnitStack', region: 'us-east-1' },
    taskDefinitionLogicalId: 'TaskDef',
    family: 'cdkd-unit-family',
    containers: [{ name: 'app' }],
    taskRoleArn: undefined,
  }),
  detectEcsImageResolutionNeeds: vi.fn().mockReturnValue({ needsCrossStackResolver: false }),
}));
vi.mock('../../../src/local/ecs-task-runner.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  createEcsRunState: vi.fn().mockReturnValue({ containers: [], entries: new Map() }),
  cleanupEcsRun: vi.fn().mockResolvedValue(undefined),
  runEcsTask: runEcsTaskMock,
}));

const { createLocalRunTaskCommand } = await import('../../../src/cli/commands/local-run-task.js');
const { resetAwsClientDefaults } = await import('../../../src/utils/aws-client-defaults.js');

const TASK_ROLE_ARN = 'arn:aws:iam::123456789012:role/CdkdUnitTaskRole';
const savedEnv: Record<string, string | undefined> = {};

/**
 * Every credentials tmpdir the subject created, swept in `afterEach` however a
 * case ended — the same hygiene the sibling command-body file gained, added
 * here for the same reason (go-to-k/cdkd#3408 round 2 pointed out this file had
 * reproduced the defect it was written alongside the fix for). The
 * profile-wins case legitimately creates one, and cleaning it inline as that
 * case's last statement strands a mode-0600 file on any earlier failure.
 */
const createdCredsDirs = new Set<string>();

function setEnv(key: string, value: string | undefined): void {
  if (!(key in savedEnv)) savedEnv[key] = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

interface CapturedRunOpts {
  profileCredentialsFile?: { hostPath: string; profileName: string };
  taskCredentials?: { accessKeyId: string };
  taskRoleArn?: string;
}

async function runTask(args: string[]): Promise<CapturedRunOpts> {
  const cmd = createLocalRunTaskCommand();
  cmd.exitOverride();
  await cmd.parseAsync(['CdkdUnitStack/TaskDef', ...args], { from: 'user' });
  expect(runEcsTaskMock, 'the command body never reached runEcsTask').toHaveBeenCalledTimes(1);
  const runOpts = runEcsTaskMock.mock.calls[0]?.[1] as CapturedRunOpts;
  const hostPath = runOpts.profileCredentialsFile?.hostPath;
  if (hostPath) createdCredsDirs.add(nodePath.dirname(hostPath));
  return runOpts;
}

beforeEach(() => {
  runEcsTaskMock.mockReset();
  createdCredsDirs.clear();
  runEcsTaskMock.mockResolvedValue({
    state: { network: { networkName: 'cdkd-unit-net' } },
    exitCode: 0,
    essentialContainerName: undefined,
  });
  stsSendMock.mockReset();
  stsSendMock.mockResolvedValue({
    Credentials: {
      AccessKeyId: ASSUMED_KEY,
      SecretAccessKey: 'assumed-secret',
      SessionToken: 'assumed-token',
    },
  });
  resetAwsClientDefaults();
  setEnv('AWS_PROFILE', undefined);
  setEnv('AWS_ACCESS_KEY_ID', undefined);
  setEnv('AWS_SECRET_ACCESS_KEY', undefined);
  setEnv('AWS_SESSION_TOKEN', undefined);
  setEnv('AWS_REGION', 'us-east-1');
  setEnv('CDKD_APP', 'node app.js');
});

afterEach(() => {
  try {
    for (const dir of createdCredsDirs) rmSync(dir, { recursive: true, force: true });
    createdCredsDirs.clear();
  } finally {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    for (const key of Object.keys(savedEnv)) delete savedEnv[key];
    resetAwsClientDefaults();
  }
});

describe('--assume-task-role wins over --profile, through the command body (issue #3394)', () => {
  it('serves the ASSUMED identity and writes NO credentials file', async () => {
    const runOpts = await runTask([
      '--assume-task-role',
      TASK_ROLE_ARN,
      '--profile',
      'cdkd-unit-should-not-win',
    ]);

    // The gate. `resolveTaskCredentialChannels` writes a file only when
    // `--assume-task-role` produced NOTHING, because the sidecar already serves
    // the assumed credentials at `/role/<arn>` and a mounted file's env vars
    // would override them.
    expect(
      runOpts.profileCredentialsFile,
      'a credentials file was mounted even though --assume-task-role won, so the ' +
        'container can resolve the CALLER instead of the task role'
    ).toBeUndefined();

    // The identity. This is the assertion the mutation actually flips: with
    // `undefined` threaded, `resolveSidecarCredentials` falls through to the
    // profile arm and the sidecar serves PROFILE_KEY.
    expect(runOpts.taskCredentials?.accessKeyId).toBe(ASSUMED_KEY);
    expect(runOpts.taskCredentials?.accessKeyId).not.toBe(PROFILE_KEY);

    // The role ARN still reaches the runner, so the sidecar serves the
    // credentials at the path the container asks for.
    expect(runOpts.taskRoleArn).toBe(TASK_ROLE_ARN);
    expect(stsSendMock).toHaveBeenCalledTimes(1);
  });

  it('falls back to the PROFILE identity when --assume-task-role is absent', async () => {
    // The control, and it is what makes the case above a statement about
    // PRECEDENCE rather than about `--profile` being broken. Same flags minus
    // `--assume-task-role`: now the profile chain legitimately wins and a file
    // IS written.
    const runOpts = await runTask(['--profile', 'cdkd-unit-should-win-here']);

    expect(runOpts.profileCredentialsFile).toBeDefined();
    expect(runOpts.profileCredentialsFile?.profileName).toBe('cdkd-unit-should-win-here');
    expect(runOpts.taskCredentials?.accessKeyId).toBe(PROFILE_KEY);
    expect(stsSendMock, 'no AssumeRole should have been issued').not.toHaveBeenCalled();

    // NOT cleaned up here: `afterEach` sweeps every tmpdir the subject created,
    // so this arm's legitimate file is removed on the failure path too.
  });
});
