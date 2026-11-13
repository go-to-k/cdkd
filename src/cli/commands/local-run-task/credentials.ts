import { getActiveWorkloadAwsWiring, resolveHostDefaultCredentials } from 'cdk-local/internal';
import { resolveProfileCredentials } from '../local-start-api.js';
import {
  writeProfileCredentialsFile,
  type ProfileCredentialsFile,
} from '../local-profile-credentials-file.js';
import type { RunEcsTaskOptions } from '../../../local/ecs-task-runner.js';
import { previewContainerEnv } from '../../../local/ecs-task-runner/docker-run-args.js';
import type { ResolvedEcsContainer } from '../../../local/ecs-task-resolver.js';
import {
  taskRoleAssumedInRealAws,
  workloadGetsEmulatorKeysOnly,
} from '../../../local/local-aws-wiring.js';
import type { LocalRunTaskOptions } from './types.js';

type TaskCredentials = { accessKeyId: string; secretAccessKey: string; sessionToken?: string };

/**
 * Issue #658: pick the credentials forwarded to the AWS-published
 * `amazon-ecs-local-container-endpoints` sidecar. Precedence:
 *   1. `--assume-task-role <arn>` (or bare `--assume-task-role` against
 *      a resolvable `TaskRoleArn`) → STS-assumed temp creds. Highest
 *      priority — when the user opted in to IAM emulation, those creds
 *      drive the sidecar regardless of `--profile`.
 *   2. `--profile <p>` → resolved via {@link resolveProfileCredentials}
 *      (the SDK's default credential provider chain — SSO / IAM
 *      Identity Center / fromIni / role-assumption). NEW in this PR.
 *   3. Neither set → the host's default credential chain (`AWS_PROFILE`,
 *      the shared files, SSO; go-to-k/cdkd#6129), read without its env
 *      link once a `--role-arn` assume is recorded, so it is the caller's;
 *      `undefined` when it finds nothing, and the user containers then get
 *      4xx from the credentials endpoint.
 *
 * Under `--aws-emulator` (mixed mode included) no real credential is served
 * to the task (go-to-k/cdkd#6132): the sidecar serves the task role assumed
 * in the emulator (`emulatorTaskCredentials`, go-to-k/cdkd#6147), else the
 * emulator's keys.
 *
 * Extracted as an exported helper so a unit test can exercise every
 * branch without having to mock the full Synth + Docker + AWS pipeline
 * (the strategy PR #655 used for the Lambda container path).
 */
export async function resolveSidecarCredentials(
  options: { profile?: string },
  assumedCredentials: TaskCredentials | undefined,
  emulatorTaskCredentials?: TaskCredentials
): Promise<TaskCredentials | undefined> {
  const wiring = getActiveWorkloadAwsWiring();
  if (wiring?.mode === 'emulator' || wiring?.mixed) {
    // The role's credentials carry a session token, which the sidecar serves
    // as they are; it would trade long-lived keys for a session on REAL STS
    // (it takes no endpoint), which refuses the emulator's keys — the 500 on
    // `/creds` of go-to-k/cdkd#6147. Without an emulator-side task role no
    // container is pointed at `/creds` (in mixed mode none at all), so the
    // keys are never asked for.
    if (emulatorTaskCredentials) return emulatorTaskCredentials;
    return wiring.mode === 'emulator'
      ? wiring.emulatorCredentials
      : wiring.mixed?.emulatorCredentials;
  }
  if (assumedCredentials) return assumedCredentials;
  if (options.profile) return resolveProfileCredentials(options.profile);
  // cdkd-local-env-identity: the host's default chain, which cdk-local reads
  // without its env link once `applyRoleArnForLocal` recorded a `--role-arn`
  // assume, so it answers as the caller, never as the deploy role.
  return resolveHostDefaultCredentials();
}

/**
 * Where `--assume-task-role` assumes the task role (go-to-k/cdkd#6147), judged
 * per container on the env it will get ({@link previewContainerEnv}):
 *
 * - No `--aws-emulator`: real AWS.
 * - `--aws-emulator`: AWS Emulator, never real STS. The role's credentials
 *   replace the emulator's keys in every container and on the metadata sidecar.
 * - Mixed mode: real AWS, for the containers that mark STS as an exception
 *   (`AWS_ENDPOINT_URL_STS="real-aws"`); they get the role as their real
 *   identity. A container's emulator calls go through the re-signing sidecar,
 *   which signs them with the emulator's keys whatever the container holds, so
 *   no emulator-side role is assumed for the others; `ignoredInMixedMode`
 *   reports that no container takes the role at all.
 *
 * `callerIdentityNeeded` is whether a mixed-mode container keeping an
 * exception still takes the caller's real identity: none when the task role
 * covers every such container.
 */
export function planTaskRoleCredentials(
  containers: ReadonlyArray<Pick<ResolvedEcsContainer, 'name' | 'environment'>>,
  envOverrides: RunEcsTaskOptions['envOverrides'],
  roleRequested: boolean
): {
  assumeInRealAws: boolean;
  assumeInEmulator: boolean;
  ignoredInMixedMode: boolean;
  callerIdentityNeeded: boolean;
} {
  const wiring = getActiveWorkloadAwsWiring();
  const envs = containers.map((c) => previewContainerEnv(c, envOverrides));
  const realSts = envs.map((env) => taskRoleAssumedInRealAws(env, wiring));
  const assumeInRealAws = roleRequested && realSts.some((r) => r);
  const assumeInEmulator = roleRequested && wiring?.mode === 'emulator';
  const ignoredInMixedMode = roleRequested && wiring?.mixed !== undefined && !assumeInRealAws;
  const callerIdentityNeeded = envs.some(
    (env, i) => !workloadGetsEmulatorKeysOnly(env, wiring) && !(assumeInRealAws && realSts[i])
  );
  return { assumeInRealAws, assumeInEmulator, ignoredInMixedMode, callerIdentityNeeded };
}

/**
 * Resolve BOTH credential channels a locally-run ECS task receives, and decide
 * whether the second one exists at all.
 *
 * 1. `sidecarCredentials` — what the AWS-published
 *    `amazon-ecs-local-container-endpoints` sidecar serves at
 *    `169.254.170.2/creds`; {@link resolveSidecarCredentials} owns the
 *    precedence (issue #658).
 * 2. `profileCredsFile` — the ECS analogue of PR #670 (Lambda-container
 *    fix-back finding #1). When `--profile <p>` is set AND `--assume-task-role`
 *    did NOT produce credentials for this task, a host-side AWS shared
 *    credentials file is written under `[<options.profile>]` and bind-mounted
 *    read-only into every user container, so handler code calling
 *    `fromIni({ profile: '<options.profile>' })` resolves to the same creds the
 *    sidecar serves. Without it the SDK looks for `[<options.profile>]` in
 *    `~/.aws/credentials` INSIDE the container and fails.
 *
 *    Gating on `!assumedCredentials` preserves the documented precedence
 *    (assume-task-role > profile-file > sidecar): when `--assume-task-role`
 *    won, the sidecar's `/creds` endpoint already serves the assumed creds
 *    and the file's env vars must NOT override them.
 *
 * ONE helper rather than two, and that is the substance of issue
 * go-to-k/cdkd#3378 rather than a tidying choice. Both of these lived inline in
 * `localRunTaskCommand`'s body, which meant the gate's annotation below was
 * fenced only for EXISTING (`local-surface-env-identity.test.ts` checks that an
 * annotation is there and carries a reason — it cannot check that the reason is
 * TRUE). And the reason is not a property of the `if` at all: it is a property
 * of the COMPOSITION, that `sidecarCredentials` on the `!assumedCredentials`
 * path can only have come from {@link resolveSidecarCredentials}'s `--profile`
 * arm. Extracting the three-line gate ALONE would have re-tested the same three
 * booleans and proved nothing; a test over this helper writes a real file and
 * can read the bytes back. `resolveSidecarCredentials`'s own doc already set
 * the precedent for the seam over a command-level harness — that harness would
 * have to mock the whole Synth + Docker + AWS pipeline, and a mock is exactly
 * what cannot answer "which identity's bytes landed in the file".
 *
 * cdkd-local-env-identity: the `!assumedCredentials` gate means
 * `resolveSidecarCredentials` reached its `--profile` arm, so this is
 * `resolveProfileCredentials` through
 * `awsClientDefaults({ ignoreAssumedRole: true })` — the caller's own chain,
 * never the `--role-arn` role — and never an `--assume-task-role` STS result,
 * which wins earlier and is served by the metadata sidecar instead.
 */
export async function resolveTaskCredentialChannels(
  options: { profile?: string },
  /** The task role assumed in REAL AWS (`--assume-task-role`), or `undefined`. */
  assumedCredentials: TaskCredentials | undefined,
  opts?: {
    /**
     * Forwarded to `writeProfileCredentialsFile` (go-to-k/cdkd#3435 review); its
     * own doc carries why the RETURN VALUE is the wrong moment for a caller that
     * has to survive a signal.
     */
    onDirCreated?: (hostPath: string) => void;
    onDirRemoved?: (hostPath: string) => void;
    /** The task role assumed in AWS Emulator (go-to-k/cdkd#6147). */
    emulatorTaskCredentials?: TaskCredentials | undefined;
    /**
     * Mixed mode: whether a container takes the caller's real identity — one
     * that keeps an exception and gets no real task role. `false` skips the
     * lookup; omitted, it runs.
     */
    callerIdentityNeeded?: boolean;
  }
): Promise<{
  sidecarCredentials: TaskCredentials | undefined;
  profileCredsFile: ProfileCredentialsFile | undefined;
  /** AWS Emulator mixed mode: the caller's real identity for the excepting containers (`RunEcsTaskOptions`). */
  mixedModeRealCredentials?: TaskCredentials | undefined;
  /** Mixed mode: the task role assumed in real AWS, for an excepting container that excepts STS. */
  mixedModeRealTaskCredentials?: TaskCredentials | undefined;
  /** `--aws-emulator`: the task role assumed in the emulator, in place of its keys. */
  emulatorTaskCredentials?: TaskCredentials | undefined;
}> {
  const emulatorTaskCredentials = opts?.emulatorTaskCredentials;
  const sidecarCredentials = await resolveSidecarCredentials(
    options,
    assumedCredentials,
    emulatorTaskCredentials
  );
  const emulatorTask = emulatorTaskCredentials && { emulatorTaskCredentials };
  // AWS Emulator mixed mode (go-to-k/cdkd#6150): the sidecar serves
  // emulator-issued credentials (above), and a REAL identity reaches only a
  // container that keeps a `"real-aws"` exception, as env keys: the task role
  // assumed in real AWS when the container excepts STS (go-to-k/cdkd#6147),
  // else `--profile`, else the host's default chain. No credentials file is
  // written: an excepting container gets the keys, and the others must get none.
  if (getActiveWorkloadAwsWiring()?.mixed) {
    // cdkd-local-env-identity: the caller's own identity, never the `--role-arn` role.
    const caller =
      opts?.callerIdentityNeeded === false
        ? undefined
        : options.profile
          ? await resolveProfileCredentials(options.profile)
          : await resolveHostDefaultCredentials();
    return {
      sidecarCredentials,
      profileCredsFile: undefined,
      ...(caller && { mixedModeRealCredentials: caller }),
      ...(assumedCredentials && { mixedModeRealTaskCredentials: assumedCredentials }),
      ...emulatorTask,
    };
  }
  // Under `--aws-emulator` the sidecar serves emulator-issued credentials and
  // no host credentials file reaches a container, so none is written.
  if (getActiveWorkloadAwsWiring()?.mode === 'emulator')
    return { sidecarCredentials, profileCredsFile: undefined, ...emulatorTask };
  if (options.profile && sidecarCredentials && !assumedCredentials) {
    return {
      sidecarCredentials,
      // cdkd-local-env-identity: the `!assumedCredentials` gate above means
      // `resolveSidecarCredentials` reached its `--profile` arm, so these bytes
      // are `resolveProfileCredentials` through
      // `awsClientDefaults({ ignoreAssumedRole: true })` — the caller's own
      // chain, never the `--role-arn` role — and never an `--assume-task-role`
      // STS result, which wins earlier and is served by the metadata sidecar
      // instead. The doc comment above carries why that reasoning needed a
      // SEAM to become checkable (go-to-k/cdkd#3378).
      profileCredsFile: await writeProfileCredentialsFile(
        options.profile,
        sidecarCredentials,
        opts
      ),
    };
  }
  return { sidecarCredentials, profileCredsFile: undefined };
}

/**
 * Build the `RunEcsTaskOptions` bag from the options and the resolved credential
 * channels.
 *
 * Extracted for the WIRING, which is the half
 * {@link resolveTaskCredentialChannels} could not cover (go-to-k/cdkd#3390 round
 * 2, on go-to-k/cdkd#3394). That helper decides WHETHER a credentials file
 * exists and whose bytes are in it; this one decides whether the answer reaches
 * the runner at all. Between them sat a single assignment, and mutating it to
 * `undefined` left 114 tests green across five files: no file is bind-mounted,
 * so every handler calling `fromIni({ profile })` inside the task container
 * fails -- the exact defect PR go-to-k/cdkd#670 shipped this path to fix. "A
 * probed callee says nothing about its WIRING" is the rule, and this is the
 * seam that lets a unit test say something about it.
 *
 * PURE, and it takes the whole `channels` object rather than a pre-destructured
 * file so the test subject is the same value the resolver returns -- a helper
 * taking `profileCredsFile` alone would move the untested assignment rather
 * than remove it.
 *
 * The file is COPIED field by field rather than passed through: `dispose` stays
 * with the command, which owns the lifetime, and `RunEcsTaskOptions` deliberately
 * declares only the three fields the runner mounts with.
 */
export function buildRunEcsTaskOptions(
  options: Pick<
    LocalRunTaskOptions,
    | 'cluster'
    | 'containerHost'
    | 'pull'
    | 'keepRunning'
    | 'detach'
    | 'platform'
    | 'region'
    | 'stackRegion'
    | 'profile'
    | 'ecrRoleArn'
  >,
  // Derived from the producer rather than re-spelled: the two must agree, and a
  // structural copy is how they would come to disagree silently
  // (go-to-k/cdkd#3390 round 3).
  channels: Awaited<ReturnType<typeof resolveTaskCredentialChannels>>,
  extra: {
    envOverrides?: RunEcsTaskOptions['envOverrides'];
    resolvedRoleArn?: string;
    stateRecordRegion?: string;
  } = {}
): RunEcsTaskOptions {
  const runOpts: RunEcsTaskOptions = {
    cluster: options.cluster,
    containerHost: options.containerHost,
    skipPull: options.pull === false,
    keepRunning: options.keepRunning,
    detach: options.detach,
  };
  if (extra.envOverrides) runOpts.envOverrides = extra.envOverrides;
  if (channels.sidecarCredentials) runOpts.taskCredentials = channels.sidecarCredentials;
  if (channels.mixedModeRealCredentials) {
    runOpts.mixedModeRealCredentials = channels.mixedModeRealCredentials;
  }
  if (channels.mixedModeRealTaskCredentials) {
    runOpts.mixedModeRealTaskCredentials = channels.mixedModeRealTaskCredentials;
  }
  if (channels.emulatorTaskCredentials) {
    runOpts.emulatorTaskCredentials = channels.emulatorTaskCredentials;
  }
  if (extra.resolvedRoleArn) runOpts.taskRoleArn = extra.resolvedRoleArn;
  if (options.platform) runOpts.platformOverride = options.platform;
  if (options.region) runOpts.region = options.region;
  if (options.stackRegion) runOpts.stackRegion = options.stackRegion;
  if (options.profile) runOpts.profile = options.profile;
  if (extra.stateRecordRegion) runOpts.stateRecordRegion = extra.stateRecordRegion;
  if (options.ecrRoleArn !== undefined) runOpts.ecrRoleArn = options.ecrRoleArn;
  if (channels.profileCredsFile) {
    runOpts.profileCredentialsFile = {
      hostPath: channels.profileCredsFile.hostPath,
      containerPath: channels.profileCredsFile.containerPath,
      profileName: channels.profileCredsFile.profileName,
    };
  }
  return runOpts;
}
