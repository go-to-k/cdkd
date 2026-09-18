import { mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

/**
 * `cdkd local run-task --profile <p>`: the COMMAND BODY, executed.
 *
 * Issue [#3394](https://github.com/go-to-k/cdkd/issues/3394), and the reason it
 * needed a third round is worth stating before the mechanics.
 * go-to-k/cdkd#3378 covered `resolveTaskCredentialChannels` (whose bytes go in
 * the file) and go-to-k/cdkd#3390 covered `buildRunEcsTaskOptions` (whether the
 * answer reaches the runner). Both are helpers. Between and around them sits
 * `localRunTaskCommand`'s body, which nothing executed: the only file naming
 * that command, `local-run-task.test.ts`, stubs the action to a no-op and reads
 * `cmd.opts()`, so it tests Commander's parser. The measured consequence
 * (go-to-k/cdkd#3390 round 4) was that a sabotage line INSIDE the body —
 * `channels = { ...channels, profileCredsFile: undefined };` right after the
 * resolve — left 161 tests green across nine files.
 *
 * ## Why this is a unit test and not an integ fixture arm
 *
 * The issue body prescribed an integ arm and rejected a unit alternative, but
 * the alternative it considered was "assert the assignment exists", a
 * source-shape check. That is not what this is. This file RUNS the body, with a
 * disposable AWS profile in a temp `AWS_SHARED_CREDENTIALS_FILE`, and reads the
 * bytes of the file the body actually wrote. Four things make it the stronger
 * instrument rather than the cheaper one:
 *
 * 1. **It asserts whose bytes landed**, which is the claim. An integ arm can
 *    assert that a container resolved *a* profile; only reading the host file
 *    can say it holds the credentials of the profile that was asked for.
 * 2. **It covers the DISPOSE path**, which no integ arm can. The residual
 *    go-to-k/cdkd#3390 left open was a mode-0600 tmpdir of live AWS credentials
 *    surviving the run. An integ asserts on AWS resources; a stranded host
 *    tmpdir is invisible to it, and the fixture's own teardown would hide it.
 * 3. **No real AWS, so it runs on every push** rather than behind `integ-local`'s
 *    14-day TTL. The regression it guards is a one-line edit, which is exactly
 *    the kind a gate measured in weeks does not catch.
 * 4. **The maintainer's real profiles are never touched.** The issue's whole
 *    deferral was that verification "needs a NAMED AWS PROFILE provisioned on
 *    the integ host". A synthesized `[cdkd-unit-<pid>]` section in a temp file
 *    is that profile, it costs nothing, and it is unreachable from the real
 *    `~/.aws/credentials`.
 *
 * The one thing an integ arm would add over this — that the container's own
 * `fromIni({ profile })` accepts the mounted file — is a property of docker's
 * bind mount and the AWS SDK, not of cdkd's code, and the three fields the
 * runner mounts with are asserted below.
 *
 * ## What is real and what is mocked
 *
 * REAL, deliberately: `resolveTaskCredentialChannels`,
 * `resolveSidecarCredentials`, `resolveProfileCredentials` (which resolves the
 * temp INI through the AWS SDK's own `fromIni` chain — purely local, no
 * network, and `tests/setup.ts`'s network fence would fail the test if that
 * ever changed), `writeProfileCredentialsFile`, `buildRunEcsTaskOptions`, the
 * `channels` binding, the `cleanup` closure and the `finally` that calls it.
 * That is the whole path under test.
 *
 * MOCKED: everything the body needs to REACH that path — docker, synth, the
 * ECS target resolver, the state provider and the runner. `runEcsTask` is the
 * capture point: the `RunEcsTaskOptions` it receives is what a real docker run
 * would have been given.
 */

const runEcsTaskMock = vi.fn();
const cleanupEcsRunMock = vi.fn();

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
  // `undefined` short-circuits `buildEcsImageResolutionContext` at its first
  // line, which is what keeps the state / pseudo-parameter machinery out of a
  // test about credentials.
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
  cleanupEcsRun: cleanupEcsRunMock,
  runEcsTask: runEcsTaskMock,
}));

const { createLocalRunTaskCommand } = await import(
  '../../../src/cli/commands/local-run-task.js'
);
const { resetAwsClientDefaults } = await import('../../../src/utils/aws-client-defaults.js');

/**
 * The disposable profile, and the two properties that make it a control.
 *
 * The NAME is per-process (`cdkd-unit-<pid>`) so it can collide with nothing in
 * a real `~/.aws/credentials`, and the access key id is a literal this repo
 * uses nowhere else — so an assertion matching it cannot be satisfied by an
 * ambient credential the SDK found somewhere else. That is the "fixture pins
 * the value under test" trap read the other way round: here the danger is a
 * DEFAULT that coincides, and `cdkd-unit-probe-access-key-0001` cannot be one.
 *
 * Deliberately NOT `AKIA`-shaped. A realistic-looking literal is the shape
 * `git-secrets` refuses at commit time (measured: it blocked the first draft's
 * 20-character `AKIA...` decoy), and an allow-list entry for it would be the
 * wrong repair -- the fixture's job is to be a value nothing else in the world
 * produces, and a non-key shape is strictly better at that than a fake key.
 * Neither `fromIni` nor `resolveProfileCredentials` validates the format.
 */
const PROFILE_NAME = `cdkd-unit-${process.pid}`;
const PROBE_ACCESS_KEY_ID = 'cdkd-unit-probe-access-key-0001';
const PROBE_SECRET = 'cdkd-unit-secret-do-not-use-0001';

/** A SECOND profile in the same file, never selected. See its assertion. */
const DECOY_PROFILE_NAME = `cdkd-decoy-${process.pid}`;
const DECOY_ACCESS_KEY_ID = 'cdkd-decoy-probe-access-key-0001';

let credsDir: string;
let sharedCredentialsFile: string;
const savedEnv: Record<string, string | undefined> = {};

function setEnv(key: string, value: string | undefined): void {
  if (!(key in savedEnv)) savedEnv[key] = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

/** The options bag `localRunTaskCommand` receives, with this test's overrides. */
async function runTask(extra: string[] = []): Promise<void> {
  const cmd = createLocalRunTaskCommand();
  cmd.exitOverride();
  await cmd.parseAsync(['CdkdUnitStack/TaskDef', '--profile', PROFILE_NAME, ...extra], {
    from: 'user',
  });
}

/**
 * The file's bytes AS THE RUNNER WOULD HAVE SEEN THEM.
 *
 * Read inside the `runEcsTask` mock rather than after `parseAsync` resolves,
 * and that is a correction the first draft of this file needed: the command's
 * `finally` disposes the tmpdir, so by the time the promise settles the path is
 * gone and a post-hoc read is `ENOENT` on a perfectly working body. Capturing
 * at the mount point is also the more faithful instrument — it is the exact
 * instant docker would bind-mount the file.
 */
let mountedBytes: string | undefined;

/**
 * Every credentials tmpdir the subject created during a case, swept in
 * `afterEach` REGARDLESS of how the case ended.
 *
 * Added by go-to-k/cdkd#3408's test review, which measured EIGHT stranded
 * `cdkd-profile-creds-` credentials tmpdirs under `$TMPDIR` from earlier runs
 * of this file. (Spelled without a trailing glob on purpose: a `*` followed by
 * a slash ends this comment block, which is how the first draft of this note
 * turned the whole file into a parse error — and vitest reports that as
 * `Tests  no tests`, a line with no digits in it, not as a failure.)
 * The `--detach` case deliberately leaves one (that is the behaviour
 * under test) and cleaned up inline, so any case failing BEFORE its last
 * statement stranded a mode-0600 file. The contents are this fixture's probe
 * credentials rather than anything real, which is why this is hygiene and not a
 * disclosure — but a test file about not leaking a credentials file should not
 * leak one.
 */
const createdCredsDirs = new Set<string>();

beforeEach(() => {
  runEcsTaskMock.mockReset();
  cleanupEcsRunMock.mockReset();
  cleanupEcsRunMock.mockResolvedValue(undefined);
  mountedBytes = undefined;
  createdCredsDirs.clear();
  runEcsTaskMock.mockImplementation(
    (_task: unknown, runOpts: { profileCredentialsFile?: { hostPath: string } }) => {
      if (runOpts.profileCredentialsFile) {
        const hostPath = runOpts.profileCredentialsFile.hostPath;
        createdCredsDirs.add(path.dirname(hostPath));
        mountedBytes = readFileSync(hostPath, 'utf8');
      }
      return Promise.resolve({
        state: { network: { networkName: 'cdkd-unit-net' } },
        exitCode: 0,
        essentialContainerName: undefined,
      });
    }
  );

  resetAwsClientDefaults();

  credsDir = mkdtempSync(path.join(tmpdir(), 'cdkd-unit-shared-creds-'));
  sharedCredentialsFile = path.join(credsDir, 'credentials');
  writeFileSync(
    sharedCredentialsFile,
    [
      `[${DECOY_PROFILE_NAME}]`,
      `aws_access_key_id = ${DECOY_ACCESS_KEY_ID}`,
      `aws_secret_access_key = cdkd-decoy-secret-0001`,
      '',
      `[${PROFILE_NAME}]`,
      `aws_access_key_id = ${PROBE_ACCESS_KEY_ID}`,
      `aws_secret_access_key = ${PROBE_SECRET}`,
      '',
    ].join('\n'),
    { mode: 0o600 }
  );

  // Point the SDK's own resolution at the temp file and nothing else. Every
  // ambient credential source is cleared, so a green assertion below cannot be
  // the host's real identity arriving by another route.
  setEnv('AWS_SHARED_CREDENTIALS_FILE', sharedCredentialsFile);
  setEnv('AWS_CONFIG_FILE', path.join(credsDir, 'config-absent'));
  setEnv('AWS_PROFILE', undefined);
  setEnv('AWS_ACCESS_KEY_ID', undefined);
  setEnv('AWS_SECRET_ACCESS_KEY', undefined);
  setEnv('AWS_SESSION_TOKEN', undefined);
  setEnv('AWS_REGION', 'us-east-1');
  setEnv('CDKD_APP', 'node app.js');
});

afterEach(() => {
  // The sweep runs FIRST so a throw in the env restore cannot strand a file,
  // and inside a `try` so the converse cannot happen either -- a throw in
  // `rmSync` would otherwise skip the restore and leak this file's env
  // mutations into every later test in the run (round 2).
  try {
    for (const dir of createdCredsDirs) rmSync(dir, { recursive: true, force: true });
    createdCredsDirs.clear();
  } finally {
    restoreEnv();
  }
});

function restoreEnv(): void {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const key of Object.keys(savedEnv)) delete savedEnv[key];
  resetAwsClientDefaults();
  rmSync(credsDir, { recursive: true, force: true });
}

describe('localRunTaskCommand body: --profile credentials file (issue #3394)', () => {
  it('mounts a credentials file holding THE SELECTED PROFILE\'s bytes', async () => {
    await runTask();

    expect(runEcsTaskMock).toHaveBeenCalledTimes(1);
    const runOpts = runEcsTaskMock.mock.calls[0]?.[1] as {
      profileCredentialsFile?: { hostPath: string; containerPath: string; profileName: string };
      taskCredentials?: { accessKeyId: string };
    };

    // THE WIRING. This is the assertion the round-4 sabotage
    // (`channels = { ...channels, profileCredsFile: undefined }`) makes fail —
    // the one that 161 tests across nine files could not see.
    expect(
      runOpts.profileCredentialsFile,
      'the runner received no credentials file, so nothing is bind-mounted and every ' +
        'handler calling fromIni({ profile }) inside the task container fails'
    ).toBeDefined();
    const mounted = runOpts.profileCredentialsFile!;

    // THE IDENTITY. Reading the file the body wrote is the only thing that can
    // tell "a file was mounted" from "the RIGHT file was mounted" — a mock
    // records what a caller passed, never what the far side wrote.
    expect(mountedBytes, 'the runner never saw a readable credentials file').toBeDefined();
    expect(mountedBytes).toContain(`[${PROFILE_NAME}]`);
    expect(mountedBytes).toContain(PROBE_ACCESS_KEY_ID);
    expect(mountedBytes).toContain(PROBE_SECRET);

    // ...and NOT the decoy sitting in the same source file. Without this, a
    // regression resolving the WRONG section (or the file's first section, a
    // plausible off-by-one in any INI reader) still passes everything above.
    expect(mountedBytes).not.toContain(DECOY_ACCESS_KEY_ID);
    expect(mountedBytes).not.toContain(`[${DECOY_PROFILE_NAME}]`);

    // The three fields the runner mounts with, each pinned: a truncated
    // `containerPath` or a mismatched `profileName` produces a file the
    // container has but `fromIni({ profile })` cannot find.
    expect(mounted.profileName).toBe(PROFILE_NAME);
    expect(mounted.containerPath).toMatch(/credentials$/);
    expect(mounted.hostPath).not.toBe(mounted.containerPath);

    // The SIDECAR channel carries the same identity — it is the other half of
    // `resolveTaskCredentialChannels`, and a change that fixed one while
    // dropping the other would leave the container's two credential sources
    // disagreeing (the precedence bug #658 shipped this path to fix).
    expect(runOpts.taskCredentials?.accessKeyId).toBe(PROBE_ACCESS_KEY_ID);
  });

  it('DISPOSES the credentials tmpdir on the normal exit path', async () => {
    await runTask();

    const mounted = (
      runEcsTaskMock.mock.calls[0]?.[1] as {
        profileCredentialsFile?: { hostPath: string };
      }
    ).profileCredentialsFile!;

    // The residual go-to-k/cdkd#3390 explicitly left open, and the reason this
    // is a unit test: the file is mode-0600 and holds LIVE AWS credentials, so
    // a `finally` that stopped calling `cleanup()` would strand one per run in
    // the host's tmpdir with nothing to notice. No integ arm observes a host
    // tmpdir; its own teardown would remove the evidence.
    expect(
      existsSync(mounted.hostPath),
      `credentials file survived the run at ${mounted.hostPath}`
    ).toBe(false);
    expect(existsSync(path.dirname(mounted.hostPath))).toBe(false);
  });

  it('KEEPS the file under --detach, and names its path', async () => {
    // The inverse direction, and the one an over-eager "always dispose" fix
    // would break: under `--detach` the containers outlive this process with
    // the file still mounted, so unlinking it breaks them. A fence that only
    // watched the dispose side would reward exactly that regression.
    await runTask(['--detach']);

    const mounted = (
      runEcsTaskMock.mock.calls[0]?.[1] as {
        profileCredentialsFile?: { hostPath: string };
      }
    ).profileCredentialsFile!;

    expect(existsSync(mounted.hostPath)).toBe(true);
    // NOT cleaned up here: `afterEach` sweeps every tmpdir the subject created,
    // so this case's deliberate survivor is removed on the failure path too.
  });

  it('writes and mounts NOTHING when --profile is absent', async () => {
    // The gate's other arm. Without it every assertion above is satisfied by a
    // body that writes a credentials file unconditionally — which would mount
    // the caller's ambient identity into a container that asked for none.
    const cmd = createLocalRunTaskCommand();
    cmd.exitOverride();
    await cmd.parseAsync(['CdkdUnitStack/TaskDef'], { from: 'user' });

    // BOUND THE ARM before asserting its outcome. Without this the case is
    // satisfied by a body that threw before reaching `runEcsTask` at all --
    // `mock.calls[0]` is then `undefined` and the optional chain yields
    // `undefined`, which is exactly what the assertion wants. "No file was
    // mounted" and "nothing ran" are different verdicts.
    expect(runEcsTaskMock, 'the command body never reached runEcsTask').toHaveBeenCalledTimes(1);
    const runOpts = runEcsTaskMock.mock.calls[0]?.[1] as {
      profileCredentialsFile?: unknown;
    };
    expect(runOpts.profileCredentialsFile).toBeUndefined();
  });
});
