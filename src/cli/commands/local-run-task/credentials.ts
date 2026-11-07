import { resolveProfileCredentials } from '../local-start-api.js';
import {
  writeProfileCredentialsFile,
  type ProfileCredentialsFile,
} from '../local-profile-credentials-file.js';
import type { RunEcsTaskOptions } from '../../../local/ecs-task-runner.js';
import type { LocalRunTaskOptions } from './types.js';

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
 *   3. Neither set → `undefined`; the sidecar runs with its own
 *      default credential chain (typically empty inside a fresh
 *      container — user containers will get 4xx from the credentials
 *      endpoint, mimicking IAM-misconfigured prod).
 *
 * Extracted as an exported helper so a unit test can exercise every
 * branch without having to mock the full Synth + Docker + AWS pipeline
 * (the strategy PR #655 used for the Lambda container path).
 */
export async function resolveSidecarCredentials(
  options: { profile?: string },
  assumedCredentials:
    | { accessKeyId: string; secretAccessKey: string; sessionToken?: string }
    | undefined
): Promise<{ accessKeyId: string; secretAccessKey: string; sessionToken?: string } | undefined> {
  if (assumedCredentials) return assumedCredentials;
  if (options.profile) return resolveProfileCredentials(options.profile);
  return undefined;
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
  assumedCredentials:
    | { accessKeyId: string; secretAccessKey: string; sessionToken?: string }
    | undefined,
  /**
   * Forwarded to `writeProfileCredentialsFile` (go-to-k/cdkd#3435 review); its
   * own doc carries why the RETURN VALUE is the wrong moment for a caller that
   * has to survive a signal.
   */
  opts?: {
    onDirCreated?: (hostPath: string) => void;
    onDirRemoved?: (hostPath: string) => void;
  }
): Promise<{
  sidecarCredentials:
    | { accessKeyId: string; secretAccessKey: string; sessionToken?: string }
    | undefined;
  profileCredsFile: ProfileCredentialsFile | undefined;
}> {
  const sidecarCredentials = await resolveSidecarCredentials(options, assumedCredentials);
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
