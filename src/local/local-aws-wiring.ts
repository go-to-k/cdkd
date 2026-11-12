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
 *   client cdkd and cdk-local build follows the endpoint.
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
  getActiveWorkloadAwsWiring,
  resolveAwsEmulatorOption,
  resolveHostDefaultCredentials,
  type WorkloadAwsWiring,
} from 'cdk-local/internal';
import { CdkdError } from '../utils/error-handler.js';
import { canonicalizeRegion } from '../utils/aws-partition.js';
import { applyRoleArnForLocal } from './local-role-arn.js';
import { CONTAINER_AWS_CREDENTIALS_PATH } from '../cli/commands/local-profile-credentials-file.js';

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
    });
  } catch (err) {
    throw new CdkdError(
      err instanceof Error ? err.message : String(err),
      'LOCAL_AWS_WIRING_FAILED',
      err instanceof Error ? err : undefined
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
 *   triple is REPLACED by the emulator's, and the `--profile` credentials-file
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
  const wiredEnv = applyWorkloadAwsWiringToEnv(env, wiring, defaults);
  const mounts = extraMounts.filter(
    (m) => wiring.mode !== 'emulator' || m.containerPath !== CONTAINER_AWS_CREDENTIALS_PATH
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
  return network === 'host' ? [] : effectiveLoopbackPorts(env, wiring);
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
    if (wiring.mode === 'emulator') {
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

/** True while `--aws-emulator` is active for this command run. */
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

export { getActiveWorkloadAwsWiring };
