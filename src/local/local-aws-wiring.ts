/**
 * AWS endpoint / trust / credential wiring for the containers the `cdkd local`
 * commands cdkd implements itself start (`invoke`, `start-api`, `run-task`,
 * `invoke-agentcore`): go-to-k/cdkd#6129, #6130, #6131, #6132.
 *
 * The decisions live in cdk-local (`workload-aws-wiring.ts`, exported through
 * `cdk-local/internal`), so a cdkd command and the cdk-local engine commands
 * cdkd embeds (`start-service`, `start-alb`, ...) wire their containers the
 * same way:
 *
 * - the host's endpoint override (`AWS_ENDPOINT_URL*`, the profile's
 *   `endpoint_url`) is forwarded by default, a loopback one through a
 *   forwarder that shares the workload's network namespace, so the URL (and
 *   with it TLS verification and S3 path-style) stays `https://127.0.0.1:<port>`;
 * - a CA bundle (`--ca-bundle`, the host `AWS_CA_BUNDLE`, the profile's
 *   `ca_bundle`) is mounted read-only with every runtime's trust variable;
 * - with no credential flag, the host's default chain fills a container env
 *   that holds no `AWS_ACCESS_KEY_ID` (so `--assume-role` > `--profile` >
 *   chain holds by construction);
 * - under `--aws-emulator`, containers get the emulator's credentials ONLY
 *   (the host's are scrubbed), its CA and the hygiene variables, and every AWS
 *   client cdkd and cdk-local build follows the endpoint;
 * - AWS Emulator mixed mode (`--aws-emulator` plus a `"real-aws"` exception
 *   on an `AWS_ENDPOINT_URL_<SERVICE>` in `--env-vars`, go-to-k/cdkd#6150):
 *   everything still goes to the emulator — through a re-signing sidecar in
 *   the workload's namespace — except the excepted services, which go to real
 *   AWS; a container keeping an exception holds the real identity, every
 *   other one the emulator's keys only. cdkd's own clients default to the
 *   emulator too, and an excepted call opts out (`realAwsException`).
 *
 * This module is the cdkd side: it activates the wiring for a command, and
 * applies it at cdkd's own docker-run layer (`runDetached` in
 * `docker-runner.ts`, and the ECS task runner).
 */

import {
  activateWorkloadAwsWiring,
  applyWorkloadAwsWiringToEnv,
  attachLoopbackForwarder,
  awsEmulatorEnvName,
  effectiveLoopbackPorts,
  ensureForwarderImage,
  firstUsableRegion,
  getActiveWorkloadAwsWiring,
  getAwsEndpointOverride,
  isAwsServiceRoutedToEmulator,
  isRealAwsSentinel,
  takeAwsEmulatorStateSourceHint,
  resolveAwsEmulatorOption,
  resolveHostDefaultCredentials,
  type AwsEmulatorWorkload,
  type AwsEndpointOverride,
  type WorkloadAwsWiring,
} from 'cdk-local/internal';
import { CdkdError } from '../utils/error-handler.js';
import { getLogger } from '../utils/logger.js';
import { canonicalizeRegion } from '../utils/aws-partition.js';
import { applyRoleArnForLocal } from './local-role-arn.js';
import { CONTAINER_AWS_CREDENTIALS_PATH } from '../cli/commands/local-profile-credentials-file.js';
import { resolveSdkDefaultRegion } from '../cli/region-options.js';

/** The options a cdkd-owned `cdkd local` command passes to {@link activateLocalAwsWiring}. */
export interface LocalAwsWiringOptions {
  /** `--aws-emulator [url]` as commander parses it: `true` for the bare flag. */
  awsEmulator?: string | boolean | undefined;
  /** `--ca-bundle <file>`. */
  caBundle?: string | undefined;
  /** `--profile`. */
  profile?: string | undefined;
  /** `--no-pull` as commander parses it (`false`): the forwarder image is not pulled either. */
  pull?: boolean | undefined;
  /**
   * `--env-vars <file>`: under `--aws-emulator`, a `"real-aws"` exception in
   * it selects mixed mode; without the flag the value is a no-op. The old
   * `"aws-emulator"` value, a bare `AWS_ENDPOINT_URL` exception and a
   * misspelled variable stop the command.
   */
  envVars?: string | undefined;
  /**
   * The command runs ONE workload (`invoke`, `invoke-agentcore`): the
   * mixed-mode startup line is left to `logMixedModeForWorkload`, called once
   * the target is resolved, so it names that workload's exceptions only
   * (go-to-k/cdkd#6257).
   */
  singleWorkload?: boolean | undefined;
}

/**
 * Resolve and install the wiring for this command run (`CDKD_AWS_EMULATOR`
 * turns `--aws-emulator` on when the flag is absent). Call it once, BEFORE
 * `--role-arn` is applied and before any AWS client is built, so the
 * `--role-arn` STS hop, `--from-state`, `{{resolve:...}}` and the
 * `--from-cfn-stack` CloudFormation client all follow the emulator.
 *
 * A failure (an unreachable emulator, a malformed URL, an unreadable
 * `--ca-bundle`) becomes a {@link CdkdError}; its text carries the flag value
 * and a file path, never a credential.
 */
export async function activateLocalAwsWiring(options: LocalAwsWiringOptions): Promise<void> {
  assertAwsEmulatorValue(options.awsEmulator);
  try {
    await activateWorkloadAwsWiring({
      awsEmulator: options.awsEmulator,
      caBundle: options.caBundle,
      profile: options.profile,
      pull: options.pull,
      // cdk-local reads it through `readEnvVarsFileText`, so a pipe-backed
      // path is read once and the command's own `--env-vars` read gets the
      // same text; the parsed file drives per-workload routing.
      envVars: options.envVars,
      singleWorkload: options.singleWorkload,
    });
  } catch (err) {
    // The error's own CAUSE, not the error: chaining the error itself only
    // printed its text a second time as the `Caused by:` line.
    const cause = err instanceof Error && err.cause instanceof Error ? err.cause : undefined;
    throw new CdkdError(
      err instanceof Error ? err.message : String(err),
      'LOCAL_AWS_WIRING_FAILED',
      cause
    );
  }
}

/**
 * The start of every cdkd-owned `cdkd local` command: the wiring FIRST, then
 * `--role-arn`, so the role's STS hop and every client after it follow
 * `--aws-emulator` (go-to-k/cdkd#6132).
 */
export async function activateLocalAwsAndRoleArn(
  options: LocalAwsWiringOptions & { roleArn?: string | undefined; region?: string | undefined }
): Promise<void> {
  await activateLocalAwsWiring(options);
  await applyRoleArnForLocal({ roleArn: options.roleArn, region: options.region });
}

/**
 * Refuse an `--aws-emulator` / `CDKD_AWS_EMULATOR` value that is not a bare
 * `http(s)://host[:port]` URL, WITHOUT echoing it: a `user:secret@`,
 * `?query` or `#fragment` part may carry a credential, and cdk-local's own
 * refusal prints the value. Also catches the commonest slip — the flag's value
 * is OPTIONAL, so `--aws-emulator MyStack/Fn` takes the target as its URL.
 * Run from the `cdkd local` `preAction` hook (every subcommand, the cdk-local
 * engine ones included) and again at activation. No-op when the flag is off.
 */
export function assertAwsEmulatorValue(flag: string | boolean | undefined): void {
  const value = resolveAwsEmulatorOption(flag);
  if (typeof value !== 'string') return;
  const where = `--aws-emulator (or ${awsEmulatorEnvName()})`;
  let u: URL | undefined;
  try {
    u = new URL(value);
  } catch {
    u = undefined;
  }
  if (
    u === undefined
      ? /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*@/i.test(value) || /[?#]/.test(value)
      : u.username !== '' || u.password !== '' || u.search !== '' || u.hash !== ''
  ) {
    throw new CdkdError(
      `${where} must be a bare scheme://host:port URL; the value carries a user name, password, ` +
        'query or fragment, which is not shown here. Remove it.',
      'LOCAL_AWS_WIRING_FAILED'
    );
  }
  if (u === undefined || (u.protocol !== 'https:' && u.protocol !== 'http:')) {
    throw new CdkdError(
      `${where} takes an http(s) URL such as https://127.0.0.1:9297, and the value given is not ` +
        'one. The URL is OPTIONAL, so a value right after the flag is taken as the URL: put ' +
        '--aws-emulator after the target, or write --aws-emulator=<url>.',
      'LOCAL_AWS_WIRING_FAILED'
    );
  }
}

/** A mount in the shape cdkd's `DockerRunOptions` carries. */
export interface WiredMount {
  hostPath: string;
  containerPath: string;
  readOnly?: boolean;
}

/**
 * One container's env and extra mounts with the active wiring applied.
 *
 * - `forward`: wiring entries fill only keys the env does not set; when the
 *   env holds no `AWS_ACCESS_KEY_ID`, the host's default chain fills the
 *   credential triple (go-to-k/cdkd#6129).
 * - `emulator`: the scrubbed keys go, the wiring entries are forced, the
 *   triple is REPLACED by the emulator's (or by a role's credentials the
 *   emulator issued, {@link keepEmulatorIssuedCredentials}), and the `--profile` credentials-file
 *   mount is dropped, so no real credential reaches the container.
 *
 * `takenContainerPaths` are the container paths the caller already mounts:
 * the CA mount never shadows one of them.
 */
export async function applyLocalAwsWiring(
  wiring: WorkloadAwsWiring,
  env: Readonly<Record<string, string>>,
  extraMounts: readonly WiredMount[],
  takenContainerPaths: readonly string[]
): Promise<{ env: Record<string, string>; extraMounts: WiredMount[] }> {
  // cdkd-local-env-identity: the host's default credential chain, read by
  // cdk-local's `resolveHostDefaultCredentials` WITHOUT its env link once a
  // `--role-arn` assume is recorded (`applyRoleArnForLocal`), so it is the
  // caller's own identity, never cdkd's deploy role; it only fills an env the
  // command's own credential flags left empty.
  const needsDefaults = wiring.mode === 'forward' && !env['AWS_ACCESS_KEY_ID'];
  // cdk-local's provider memoizes a hit (and refreshes expiring keys) and
  // remembers a miss for 60 s, so a long-running server neither re-walks the
  // chain per container start nor misses a later `aws sso login` for good.
  const defaults = needsDefaults ? await resolveHostDefaultCredentials() : undefined;
  // cdkd-local-env-identity: `--assume-role` under `--aws-emulator`
  // (go-to-k/cdkd#6252): the execution role's credentials the EMULATOR's STS
  // issued take the emulator keys' place, as `--assume-task-role`'s do
  // (#6147). Only a triple cdkd itself recorded from the emulator qualifies,
  // so no other credential survives the replacement.
  const roleCreds = wiring.mode === 'emulator' ? emulatorIssuedCredentialsIn(env) : undefined;
  const wiredEnv = applyWorkloadAwsWiringToEnv(
    env,
    roleCreds ? { ...wiring, emulatorCredentials: roleCreds } : wiring,
    defaults
  );
  // Emulator keys only (`--aws-emulator` alone, or a mixed-mode container
  // keeping no exception): no host credentials file either.
  const emulatorOnly = workloadGetsEmulatorKeysOnly(env, wiring);
  const mounts = extraMounts.filter(
    (m) => !emulatorOnly || m.containerPath !== CONTAINER_AWS_CREDENTIALS_PATH
  );
  const taken = new Set([...takenContainerPaths, ...mounts.map((m) => m.containerPath)]);
  for (const m of wiring.mounts) {
    if (!taken.has(m.containerPath)) mounts.push({ ...m, readOnly: true });
  }
  return { env: wiredEnv, extraMounts: mounts };
}

/**
 * The loopback ports a container's FINAL env still points at, for the
 * forwarder (empty on the host network, where `127.0.0.1` is the host).
 */
export function loopbackPortsFor(
  wiring: WorkloadAwsWiring,
  env: Readonly<Record<string, string>>,
  network: string | undefined
): number[] {
  if (network !== 'host') return effectiveLoopbackPorts(env, wiring);
  const mixed = wiring.mixed;
  if (mixed && effectiveLoopbackPorts(env, wiring).includes(mixed.resignPort)) {
    // The re-signing sidecar listens on the workload's own loopback; on the
    // host network that is the host's, shared by every workload of the run.
    throw new CdkdError(
      'A run with "real-aws" exceptions (AWS Emulator mixed mode) cannot use the host network: its ' +
        're-signing sidecar listens on the workload\'s own loopback. Drop the "real-aws" exceptions or the ' +
        'host network.',
      'LOCAL_AWS_EMULATOR_FORWARDER_FAILED'
    );
  }
  return [];
}

/**
 * Pull the forwarder image ahead of a workload start, so the forwarder is up
 * within moments of the workload. Fatal under `--aws-emulator`; otherwise the
 * failure is left for {@link attachLocalLoopbackForwarder} to warn about.
 */
export async function prepareLocalLoopbackForwarder(wiring: WorkloadAwsWiring): Promise<void> {
  try {
    await ensureForwarderImage(wiring.skipPull === true);
  } catch (err) {
    // Mixed mode too: a workload routed to the emulator has no other way there.
    if (wiring.mode === 'emulator' || wiring.mixed) {
      throw new CdkdError(
        `--aws-emulator: the loopback forwarder image could not be pulled: ${(err as Error).message}`,
        'LOCAL_AWS_EMULATOR_FORWARDER_PULL_FAILED'
      );
    }
  }
}

/**
 * Start the loopback forwarder for a just-started (or just-restarted)
 * container. `ports` omitted re-attaches the set the container's forwarder
 * served before (a `docker restart` ended it: it shares the container's pid
 * namespace). Under `--aws-emulator` a failure removes the container and
 * throws; otherwise it is a once-per-port warning.
 */
export async function attachLocalLoopbackForwarder(
  containerId: string,
  ports?: readonly number[]
): Promise<void> {
  const wiring = getActiveWorkloadAwsWiring();
  if (!wiring) return;
  try {
    await (ports === undefined
      ? attachLoopbackForwarder(containerId, wiring)
      : attachLoopbackForwarder(containerId, wiring, ports));
  } catch (err) {
    throw new CdkdError(
      err instanceof Error ? err.message : String(err),
      'LOCAL_AWS_EMULATOR_FORWARDER_FAILED',
      err instanceof Error ? err : undefined
    );
  }
}

/**
 * The `--profile` credentials a workload container gets, or `undefined`.
 * Under `--aws-emulator` the real profile is never resolved (no SSO / STS hop,
 * no credentials file on the host): the container gets the emulator's keys.
 * Mixed mode resolves it: the container keeps the real identity there.
 * Call it AFTER {@link activateLocalAwsWiring}.
 */
export async function profileCredentialsForWorkload<T>(
  profile: string | undefined,
  resolve: (profile: string) => Promise<T>
): Promise<T | undefined> {
  if (!profile || localAwsEmulatorActive()) return undefined;
  return resolve(profile);
}

/**
 * Set a workload container's region: BOTH `AWS_REGION` and
 * `AWS_DEFAULT_REGION`, folded. Writing only the first left a forwarded host
 * `AWS_DEFAULT_REGION` naming another region beside it, and boto3 reads the
 * second. A no-op for an absent region.
 */
export function setContainerRegion(env: Record<string, string>, region: string | undefined): void {
  if (!region) return;
  const folded = canonicalizeRegion(region);
  env['AWS_REGION'] = folded;
  env['AWS_DEFAULT_REGION'] = folded;
}

/**
 * The region a workload container runs in, which is also the region its
 * `--assume-role` STS hop uses. A deployed Lambda / AgentCore runtime always
 * has `AWS_REGION`, so the container gets the region cdkd itself resolved:
 *
 *   1. `--region`, then the host `AWS_REGION`, then `AWS_DEFAULT_REGION`;
 *   2. the stack's own region (`env.region` on a CDK stack);
 *   3. the loaded state record's region (`--from-state` / `--from-cfn-stack`),
 *      i.e. where the stack was actually deployed;
 *   4. the selected profile's `region =` line — the same SDK sample
 *      `resolveEffectiveRegion` gives `deploy` (go-to-k/cdkd#2029).
 *
 * Without the last two, an environment-agnostic stack whose region lived only
 * in `~/.aws/config` ran with no region at all, and the handler's first SDK
 * call failed with `Region is missing` (go-to-k/cdkd#6200). The profile is
 * sampled only when nothing above answers, so the common path builds no client.
 * There is deliberately no `us-east-1` literal at the end: with nothing
 * configured anywhere the container is left region-less rather than pointed at
 * a region nobody named. `unknown-region` and blank values are skipped
 * (`firstUsableRegion`); the answer is folded (`canonicalizeRegion`).
 */
export async function resolveContainerRegion(sources: {
  region?: string | undefined;
  stackRegion?: string | undefined;
  stateRegion?: string | undefined;
  profile?: string | undefined;
}): Promise<string | undefined> {
  const named = firstUsableRegion(
    sources.region,
    process.env['AWS_REGION'],
    process.env['AWS_DEFAULT_REGION'],
    sources.stackRegion,
    sources.stateRegion
  );
  if (named) return canonicalizeRegion(named);
  const fromProfile = firstUsableRegion(await resolveSdkDefaultRegion(sources.profile));
  return fromProfile ? canonicalizeRegion(fromProfile) : undefined;
}

/**
 * True while `--aws-emulator` is active for this command run in full-emulator
 * mode (no "real-aws" exception): the emulator's keys are then the only identity. False
 * in mixed mode, where workloads keep the real identity.
 */
export function localAwsEmulatorActive(): boolean {
  return getActiveWorkloadAwsWiring()?.mode === 'emulator';
}

/**
 * The emulator's keys while `--aws-emulator` is active (the only identity a
 * request to it, or a workload, may carry), else `undefined`.
 */
export function localAwsEmulatorCredentials():
  | { accessKeyId: string; secretAccessKey: string; sessionToken?: string }
  | undefined {
  const wiring = getActiveWorkloadAwsWiring();
  return wiring?.mode === 'emulator' ? wiring.emulatorCredentials : undefined;
}

interface EmulatorIssuedCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
}

/** Credentials the emulator's STS issued for a role flag, by access key id. */
const emulatorIssued = new Map<string, EmulatorIssuedCredentials>();

/**
 * Record `creds` as issued by AWS Emulator's STS for a role flag
 * (`--assume-role`), so {@link applyLocalAwsWiring} lets them replace the
 * emulator's own keys in the container (go-to-k/cdkd#6252). A no-op outside
 * full emulator mode: in mixed mode the role is assumed in real AWS, and
 * without `--aws-emulator` nothing replaces the credentials. Returns `creds`.
 */
export function keepEmulatorIssuedCredentials<T extends EmulatorIssuedCredentials>(creds: T): T {
  if (localAwsEmulatorActive()) {
    emulatorIssued.set(creds.accessKeyId, {
      accessKeyId: creds.accessKeyId,
      secretAccessKey: creds.secretAccessKey,
      sessionToken: creds.sessionToken,
    });
  }
  return creds;
}

/** The recorded emulator-issued triple `env` carries verbatim, if any. */
function emulatorIssuedCredentialsIn(
  env: Readonly<Record<string, string | undefined>>
): EmulatorIssuedCredentials | undefined {
  // cdkd-local-env-identity: only COMPARED with a triple the emulator's STS
  // issued for a role flag (`--assume-role`); nothing is copied out of `env`.
  const id = env['AWS_ACCESS_KEY_ID'];
  const secret = env['AWS_SECRET_ACCESS_KEY'];
  const token = env['AWS_SESSION_TOKEN'];
  const creds = id === undefined ? undefined : emulatorIssued.get(id);
  return creds && creds.secretAccessKey === secret && creds.sessionToken === token
    ? creds
    : undefined;
}

/**
 * Whether the state record's IAM roles are the WRONG side for a role flag that
 * assumes in real AWS (go-to-k/cdkd#6189, #6252): in AWS Emulator mixed mode a
 * role is assumed in real AWS, while the record's IAM resources are the
 * emulator's unless `Parameters` marks IAM as a `"real-aws"` exception. The
 * record would then name an emulator role (account 000000000000) to real STS.
 */
export function stateRoleRecordIsEmulatorSide(): boolean {
  return mixedModeActive() && !realAwsException('IAM');
}

/**
 * Whether a container whose env (before `applyWorkloadAwsWiringToEnv`) is
 * `env` gets the emulator's keys only, so no host credential file or real
 * identity may reach it: always under `--aws-emulator` alone, and in mixed
 * mode (go-to-k/cdkd#6150) when the env keeps no `"real-aws"` exception on an
 * `AWS_ENDPOINT_URL_<SERVICE>` — cdk-local's rule, which its env wiring
 * applies to the same env.
 */
export function workloadGetsEmulatorKeysOnly(
  env: Readonly<Record<string, string | undefined>>,
  wiring: WorkloadAwsWiring | undefined
): boolean {
  if (!wiring) return false;
  if (wiring.mode === 'emulator') return true;
  if (!wiring.mixed) return false;
  return !Object.entries(env).some(([k, v]) => k !== 'AWS_ENDPOINT_URL' && isRealAwsSentinel(k, v));
}

/**
 * Which STS assumes the task role for a container whose env (before
 * `applyWorkloadAwsWiringToEnv`) is `env` (go-to-k/cdkd#6147): real AWS
 * without `--aws-emulator`; AWS Emulator under it, unless mixed mode is active
 * and the container marks STS as an exception
 * (`AWS_ENDPOINT_URL_STS="real-aws"`). The task role is assumed where the
 * container's own STS calls go.
 */
export function taskRoleAssumedInRealAws(
  env: Readonly<Record<string, string | undefined>>,
  wiring: WorkloadAwsWiring | undefined
): boolean {
  if (wiring?.mode === 'emulator') return false;
  if (!wiring?.mixed) return true;
  return isRealAwsSentinel('AWS_ENDPOINT_URL_STS', env['AWS_ENDPOINT_URL_STS']);
}

/** True while AWS Emulator mixed mode is active: `--aws-emulator` plus a `"real-aws"` exception. */
export function mixedModeActive(): boolean {
  return getActiveWorkloadAwsWiring()?.mixed !== undefined;
}

/**
 * Whether a cdkd call to `service` (an endpoint service id: `SECRETS_MANAGER`,
 * `SSM`, `STS`) goes to REAL AWS in AWS Emulator mixed mode
 * (go-to-k/cdkd#6150): a `"real-aws"` exception names it — for `workload`, by
 * that workload's own exceptions (`Parameters` plus its own sections); with
 * none, by `Parameters` alone. False outside mixed mode, where the flag
 * decides alone. Pass it as `realAws` to `awsClientDefaults`: every other cdkd
 * call stays on the emulator, which in mixed mode is the process-wide default
 * ({@link mixedModeEmulatorOverride}).
 *
 * cdk-local decides (`isAwsServiceRoutedToEmulator`, installed by
 * `activateWorkloadAwsWiring`), so cdkd's calls and cdk-local's cannot drift.
 */
export function realAwsException(service: string, workload?: AwsEmulatorWorkload): boolean {
  return mixedModeActive() && !isAwsServiceRoutedToEmulator(service, workload);
}

/**
 * The process-wide endpoint override for cdkd's own clients: the flag's
 * (full emulator mode), else in mixed mode the emulator's — every cdkd call
 * fails closed onto the emulator unless it opts out with `realAws`.
 */
export function mixedModeEmulatorOverride(): AwsEndpointOverride | undefined {
  return getAwsEndpointOverride() ?? getActiveWorkloadAwsWiring()?.mixed?.emulatorClientOverride;
}

/**
 * Under `--aws-emulator` with no `--from-state` / `--from-cfn-stack`: after
 * the per-variable warnings for template env values dropped because they
 * reference a resource, ONE hint naming the way to read those values. The
 * text and the once-per-process gate are cdk-local's
 * (`takeAwsEmulatorStateSourceHint`), shared with its engine commands, so it
 * never prints twice. A no-op with a state source or when nothing was dropped.
 */
export function warnAwsEmulatorStateSourceHint(dropped: number, stateSourceGiven: boolean): void {
  if (dropped === 0 || stateSourceGiven) return;
  const hint = takeAwsEmulatorStateSourceHint();
  if (hint !== undefined) getLogger().warn(hint);
}

export { getActiveWorkloadAwsWiring };
