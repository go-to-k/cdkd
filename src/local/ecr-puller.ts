import { ECRClient, GetAuthorizationTokenCommand } from '@aws-sdk/client-ecr';
import { AssumeRoleCommand, GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';
import {
  formatDockerLoginError,
  runDockerForeground,
  runDockerStreaming,
} from '../utils/docker-cmd.js';
import { derivePartitionAndUrlSuffix } from '../utils/aws-partition.js';
import { parseEcrRegistryHost } from '../utils/ecr-uri.js';

/** The URL suffix an ECR registry host uses in `region`'s partition (issue #1758). */
function ecrUrlSuffix(region: string): string {
  return derivePartitionAndUrlSuffix(region).urlSuffix;
}

export { parseEcrRegistryHost };
import { LocalInvokeBuildError } from '../utils/error-handler.js';
import { getLogger } from '../utils/logger.js';

/**
 * ECR pull fallback for `cdkd local invoke` / `cdkd local start-api` /
 * `cdkd local run-task`. When the image URI resolves to an ECR repo but
 * doesn't match any cdk.out asset (typical when invoking a stack
 * deployed elsewhere or sharing a centralized registry), cdkd
 * authenticates against the target registry and runs `docker pull`.
 *
 * **Cross-account / cross-region** (#455):
 *   - Same-account, same-region: fast path. No STS hop. The default
 *     credential chain is used directly for `ecr:GetAuthorizationToken`.
 *   - `ecrRoleArn` is provided: `sts:AssumeRole` is issued via the
 *     default credential chain to obtain temporary credentials for the
 *     target account. The resulting credentials authenticate the ECR
 *     client (regardless of region — the ECR client is built for the
 *     URI's region, which can differ from the caller's profile region).
 *   - Cross-account, NO `ecrRoleArn`: cdkd falls through to the
 *     default credential chain. This works when the caller has been
 *     granted cross-account `ecr:GetAuthorizationToken` +
 *     `ecr:BatchGetImage` permissions on the target repository via an
 *     IAM policy; otherwise AWS rejects the call with `AccessDenied`
 *     and the user is pointed at `--ecr-role-arn`.
 *
 * The `--no-pull` semantics (C3 in the design doc):
 *   - When NOT set: `ecrLogin` + `docker pull <uri>`.
 *   - When set: skip `docker pull`. If the image isn't in the local
 *     cache, the subsequent `docker run` will fail; we surface a clearer
 *     "image not in local cache" error here so the user knows to drop
 *     `--no-pull` or pre-pull manually.
 */

export interface ParsedEcrUri {
  accountId: string;
  region: string;
  repository: string;
  tag: string;
  /**
   * The input URI with its HOST lower-cased and its repository path + tag
   * untouched — the ONE spelling every docker-facing consumer must use
   * (issue [#1801](https://github.com/go-to-k/cdkd/issues/1801)). See
   * {@link canonicalizeImageUriHost} for why only the host may be folded.
   */
  canonicalUri: string;
}

/**
 * Lower-case the HOST portion of an image reference — everything up to the
 * first `/` — and leave the repository path and tag byte-identical.
 *
 * A registry host is a DNS name and therefore case-INSENSITIVE, but docker's
 * credential store is keyed on the hostname VERBATIM: measured against a real
 * daemon with a `DOCKER_CONFIG` holding auth for
 * `<acct>.dkr.ecr.us-east-1.amazonaws.com`, a pull of
 * `<acct>.dkr.ecr.US-EAST-1.amazonaws.com/...` sent NO credentials at all
 * (`no basic auth credentials`) while the lower-cased spelling authenticated
 * and failed with a token error instead. So cdkd logging in to one spelling
 * and pulling from another authenticates against neither.
 *
 * The repository path and tag are deliberately NOT folded: only the domain is
 * case-insensitive, docker already requires the path to be lower case, and
 * rewriting it would change WHICH image is pulled.
 */
export function canonicalizeImageUriHost(imageUri: string): string {
  const slash = imageUri.indexOf('/');
  if (slash < 0) return imageUri;
  return imageUri.slice(0, slash).toLowerCase() + imageUri.slice(slash);
}

/**
 * Parse an ECR image URI. Returns `undefined` for non-ECR URIs (typically:
 * Docker Hub, public.ecr.aws, gcr.io, ...) — those are user-managed
 * images we don't try to authenticate against.
 *
 * The host is canonicalized BEFORE the registry-host match, so a mixed-case
 * genuine ECR host classifies as ECR (and its `region` comes back in the
 * spelling the ECR endpoint and the `docker login` both use) rather than
 * falling through to the anonymous-pull path.
 */
export function parseEcrUri(imageUri: string): ParsedEcrUri | undefined {
  const canonicalUri = canonicalizeImageUriHost(imageUri);
  const host = parseEcrRegistryHost(canonicalUri);
  if (!host) return undefined;
  // The host carries no `/`, so the first one is the repository separator.
  const m = /^([^:]+):(.+)$/.exec(canonicalUri.slice(canonicalUri.indexOf('/') + 1));
  if (!m) return undefined;
  return {
    accountId: host.accountId,
    // Belt-and-braces: `canonicalUri` already lower-cased the host the region
    // was captured from, so this is a no-op today. It stays because the region
    // seeds the ECR client AND the `docker login` endpoint, and a raw-cased one
    // there is the exact login/pull mismatch this module was fixed for.
    region: host.region.toLowerCase(),
    repository: m[1]!,
    tag: m[2]!,
    canonicalUri,
  };
}

export interface EcrPullOptions {
  /** When true, skip `docker pull` and require the image be in the local cache. */
  skipPull: boolean;
  /**
   * Caller's region (typically the CLI's resolved `--region`). Used only
   * to seed the STS client when `ecrRoleArn` is set — the ECR client is
   * always built for the URI's region (since cross-region pull is now
   * supported). When unset, env-var fallback applies via the SDK default
   * chain.
   */
  region?: string;
  /**
   * Optional role ARN to assume before authenticating against ECR
   * (#455). When set, `sts:AssumeRole` is issued via the default
   * credential chain and the resulting temporary credentials are used
   * for the ECR client. Required for cross-account pull when the
   * caller's identity does not already have `ecr:GetAuthorizationToken`
   * / `ecr:BatchGetImage` on the target repository.
   */
  ecrRoleArn?: string;
}

/** STS-issued temporary credentials shape used to authenticate the ECR client. */
interface TempCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  /**
   * Expiration timestamp recorded by STS. Used by the module-level cache below
   * to evict stale credentials before AWS itself rejects them. Optional because
   * the AWS SDK declares `Credentials.Expiration` as optional, but in practice
   * `AssumeRole` always returns it.
   */
  expiration?: Date;
}

/**
 * Module-level cache for STS-issued AssumeRole credentials, keyed by
 * `(ecrRoleArn, callerRegion)`. Closes the reviewer's MAJOR finding: ECS
 * run-task with N containers under one `--ecr-role-arn` would otherwise issue
 * N× `AssumeRole` and N× `GetCallerIdentity` for identical credentials valid
 * for 3600s. The cache keeps a 5-minute safety margin against the recorded
 * `Expiration` so STS-side / local-clock skew never lets a stale entry through.
 *
 * Cache key is intentionally `(roleArn, region)` rather than full caller
 * identity — STS issues per-region session creds, and a switch of `--region`
 * between two `local invoke` calls in the same process must re-issue.
 *
 * NOT cleared on process exit — Node's module scope evaporates with the
 * process, and no inter-process sharing is desired (each `cdkd local invoke`
 * is its own isolated runtime).
 */
const ASSUMED_ROLE_CACHE = new Map<string, TempCredentials>();

/**
 * Module-level cache for `STS:GetCallerIdentity`. The result is identity-only
 * (`Account`) and invariant for the lifetime of the process under one set of
 * default credentials. Keyed by `callerRegion` to avoid a cross-region leak
 * when the caller flips `AWS_REGION` mid-process (STS is global but the SDK
 * uses regional endpoints; the result is invariant in practice, but we key
 * on region for safety).
 */
const CALLER_IDENTITY_CACHE = new Map<string, string>();

/** 5-minute safety margin against the recorded STS expiration timestamp. */
const STS_CREDENTIAL_SAFETY_MARGIN_MS = 5 * 60 * 1000;

/**
 * Reset the STS credential caches. Exported for unit tests only — production
 * callers should never need this (the caches live for the process lifetime
 * and the per-`(roleArn, region)` keying already isolates concurrent runs).
 *
 * @internal
 */
export function __resetStsCachesForTesting(): void {
  ASSUMED_ROLE_CACHE.clear();
  CALLER_IDENTITY_CACHE.clear();
}

function isCredentialFresh(creds: TempCredentials): boolean {
  if (!creds.expiration) {
    // STS didn't return an Expiration — surface as stale rather than cache
    // forever. In practice AssumeRole always returns one.
    return false;
  }
  return creds.expiration.getTime() - Date.now() > STS_CREDENTIAL_SAFETY_MARGIN_MS;
}

/**
 * Pull (or verify locally cached) a container image from ECR.
 *
 * Auto-detects cross-account from `STS:GetCallerIdentity` and assumes
 * the supplied role when set. Returns the image URI the caller should
 * pass to `docker run`: the input with its HOST lower-cased and its
 * repository path + tag untouched (issue #1801). That is the SAME
 * spelling `docker pull` / `docker image inspect` were handed here and
 * the same one `docker login` authenticated, so the caller's `docker
 * run` cannot land on a third host.
 */
export async function pullEcrImage(imageUri: string, options: EcrPullOptions): Promise<string> {
  const logger = getLogger().child('ecr-puller');

  const parsed = parseEcrUri(imageUri);
  if (!parsed) {
    throw new LocalInvokeBuildError(
      `Image URI '${imageUri}' is not an ECR URI. ` +
        'cdkd local invoke v1 only authenticates against ECR for the deployed-image fallback path.'
    );
  }

  // Every docker-facing use below goes through the canonical spelling, never
  // the raw input — see `canonicalizeImageUriHost` (issue #1801).
  const canonicalUri = parsed.canonicalUri;

  const callerRegion =
    options.region ?? process.env['AWS_REGION'] ?? process.env['AWS_DEFAULT_REGION'];

  // `--no-pull` short-circuits before any AWS calls — verifying the local
  // cache needs no STS / ECR authentication. Hoisting this above the
  // `GetCallerIdentity` block avoids a wasted STS round-trip on every
  // container in an ECS run-task that pre-pulled the image manually.
  if (options.skipPull) {
    logger.info(`Skipping ECR pull (--no-pull). Verifying ${canonicalUri} is in local cache...`);
    await verifyImageInLocalCache(canonicalUri);
    return canonicalUri;
  }

  // Look up the caller's identity (cached per region — invariant for the
  // process's default credentials). Used both to log cross-account info AND
  // as the STS-AssumeRole source region. Failures here are fatal — without
  // an identity we cannot even tell whether this is a cross-account pull,
  // let alone authenticate.
  const callerIdentityKey = callerRegion ?? '_unset';
  let callerAccount = CALLER_IDENTITY_CACHE.get(callerIdentityKey);
  if (callerAccount === undefined) {
    const sts = new STSClient({ ...(callerRegion && { region: callerRegion }) });
    try {
      const identity = await sts.send(new GetCallerIdentityCommand({}));
      if (!identity.Account) {
        throw new LocalInvokeBuildError(
          'STS GetCallerIdentity returned no Account. Verify your AWS credentials.'
        );
      }
      callerAccount = identity.Account;
      CALLER_IDENTITY_CACHE.set(callerIdentityKey, callerAccount);
    } finally {
      sts.destroy();
    }
  }

  const crossAccount = callerAccount !== parsed.accountId;
  // Compare CANONICAL forms on both sides (issue #1801): `parsed.region` is
  // lower-cased, so `--region US-EAST-1` against a lower-case host otherwise
  // logged a spurious `Cross-region ECR pull` line. Log-only, but the line
  // reads as a real misconfiguration.
  const crossRegion =
    callerRegion !== undefined && callerRegion.toLowerCase() !== parsed.region.toLowerCase();

  // Optionally assume a role to gain credentials for the target account.
  // When `ecrRoleArn` is not set but the pull is cross-account, we
  // proceed with the caller's credentials anyway — IAM resource policies
  // on the ECR repository can grant cross-account access without
  // requiring AssumeRole. AWS surfaces a clear `AccessDenied` if the
  // grant is missing, and the caller can re-run with `--ecr-role-arn`.
  //
  // AssumeRole result cached per `(roleArn, region)` so an ECS run-task
  // with N containers under one `--ecr-role-arn` issues only 1× AssumeRole
  // for all N (sessions are valid 3600s, far longer than any practical
  // image-pull loop).
  let assumed: TempCredentials | undefined;
  if (options.ecrRoleArn) {
    const cacheKey = `${options.ecrRoleArn}|${callerRegion ?? '_unset'}`;
    const cached = ASSUMED_ROLE_CACHE.get(cacheKey);
    if (cached && isCredentialFresh(cached)) {
      assumed = cached;
      logger.debug(`Reusing cached AssumeRole credentials for ${options.ecrRoleArn}`);
    } else {
      assumed = await assumeRoleForEcr(options.ecrRoleArn, callerRegion, logger);
      ASSUMED_ROLE_CACHE.set(cacheKey, assumed);
      logger.info(
        `Assumed role ${options.ecrRoleArn} for ECR pull (account=${parsed.accountId}, region=${parsed.region})`
      );
    }
  } else if (crossAccount) {
    logger.info(
      `Cross-account ECR pull: image account ${parsed.accountId} != caller ${callerAccount}. ` +
        "Using the caller's credentials; pass --ecr-role-arn <arn> if AWS rejects with AccessDenied."
    );
  }

  if (crossRegion) {
    logger.info(
      `Cross-region ECR pull: image region ${parsed.region} != caller ${callerRegion ?? '(unset)'}. ` +
        'Authenticating against the image region directly.'
    );
  }

  // Authenticate against the URI's region (NOT the caller region).
  // When `assumed` is set, the ECR client uses those temporary
  // credentials; otherwise the default credential chain.
  const ecr = new ECRClient({
    region: parsed.region,
    ...(assumed && { credentials: assumed }),
  });
  try {
    await ecrLogin(ecr, parsed.accountId, parsed.region);
  } finally {
    ecr.destroy();
  }

  logger.info(`Pulling ${canonicalUri}...`);
  try {
    await runDockerForeground(['pull', canonicalUri]);
  } catch (err) {
    const e = err as Error;
    throw new LocalInvokeBuildError(`docker pull ${canonicalUri} failed: ${e.message}`);
  }

  return canonicalUri;
}

/**
 * Assume the supplied role via the SDK default credential chain and
 * return the resulting temporary credentials. The STS client is built
 * with the caller's profile region (or unset) — STS is a global
 * service so the region is informational, but threading it through
 * mirrors the convention used by `src/utils/role-arn.ts`.
 */
async function assumeRoleForEcr(
  roleArn: string,
  callerRegion: string | undefined,
  logger: ReturnType<ReturnType<typeof getLogger>['child']>
): Promise<TempCredentials> {
  logger.debug(`Assuming role ${roleArn} for ECR pull...`);
  const sts = new STSClient({ ...(callerRegion && { region: callerRegion }) });
  try {
    const response = await sts.send(
      new AssumeRoleCommand({
        RoleArn: roleArn,
        RoleSessionName: `cdkd-local-ecr-${Date.now()}`,
        DurationSeconds: 3600,
      })
    );
    const creds = response.Credentials;
    if (!creds || !creds.AccessKeyId || !creds.SecretAccessKey || !creds.SessionToken) {
      throw new LocalInvokeBuildError(
        `AssumeRole(${roleArn}) returned no usable credentials. Verify the role's trust policy allows your identity to assume it.`
      );
    }
    return {
      accessKeyId: creds.AccessKeyId,
      secretAccessKey: creds.SecretAccessKey,
      sessionToken: creds.SessionToken,
      ...(creds.Expiration && { expiration: creds.Expiration }),
    };
  } catch (err) {
    if (err instanceof LocalInvokeBuildError) throw err;
    const reason = err instanceof Error ? err.message : String(err);
    throw new LocalInvokeBuildError(
      `Failed to assume role ${roleArn} for ECR pull: ${reason}. ` +
        "Verify the role exists and its trust policy permits the caller's identity to assume it."
    );
  } finally {
    sts.destroy();
  }
}

/**
 * Authenticate the local docker daemon against the target ECR registry.
 * Mirrors `DockerAssetPublisher.ecrLogin` but stays in this module so the
 * local-invoke path doesn't depend on the publisher's larger surface area.
 */
async function ecrLogin(client: ECRClient, accountId: string, region: string): Promise<void> {
  const logger = getLogger().child('ecr-puller');
  logger.debug(`ECR login (account=${accountId}, region=${region})`);

  const response = await client.send(new GetAuthorizationTokenCommand({}));
  const authData = response.authorizationData?.[0];
  if (!authData?.authorizationToken) {
    throw new LocalInvokeBuildError('Failed to get ECR authorization token');
  }

  const token = Buffer.from(authData.authorizationToken, 'base64').toString();
  const [username, password] = token.split(':');
  if (!username || password === undefined) {
    throw new LocalInvokeBuildError(
      'ECR authorization token has unexpected shape (missing username/password)'
    );
  }
  // The suffix is DERIVED from the region (issue #1758). Hardcoding
  // `amazonaws.com` here handed `docker login` a hostname that does not
  // resolve outside the commercial partition whenever AWS reported no
  // `proxyEndpoint`. Commercial output is byte-identical.
  const endpoint =
    authData.proxyEndpoint || `https://${accountId}.dkr.ecr.${region}.${ecrUrlSuffix(region)}`;

  try {
    await runDockerStreaming(['login', '--username', username, '--password-stdin', endpoint], {
      input: password,
    });
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    throw new LocalInvokeBuildError(
      `ECR login failed: ${formatDockerLoginError(e.stderr || e.message || String(err), endpoint)}`
    );
  }
}

/**
 * `docker image inspect <uri>` returns non-zero when the image is not in
 * the local cache. Surface a clearer error than docker's raw output so
 * the user knows the `--no-pull` path requires a pre-cached image.
 */
async function verifyImageInLocalCache(imageUri: string): Promise<void> {
  try {
    await runDockerStreaming(['image', 'inspect', imageUri]);
  } catch {
    throw new LocalInvokeBuildError(
      `Image '${imageUri}' is not in the local docker cache and --no-pull was set. ` +
        'Either remove --no-pull (cdkd will pull from ECR) or pre-pull the image manually with `docker pull`.'
    );
  }
}

/**
 * Check whether a docker image is in the local registry. Pure boolean —
 * the caller decides what message to surface on miss. Reused by the
 * `docker-image-builder` `--no-build` path so both the ECR-pull verifier
 * (above) and the local-build verifier route through one `docker image
 * inspect` shape.
 */
export async function isImageInLocalCache(imageRef: string): Promise<boolean> {
  try {
    await runDockerStreaming(['image', 'inspect', imageRef]);
    return true;
  } catch {
    return false;
  }
}
