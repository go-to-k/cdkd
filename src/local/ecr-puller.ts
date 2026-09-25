import { ECRClient, GetAuthorizationTokenCommand } from '@aws-sdk/client-ecr';
import { AssumeRoleCommand, GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';
import {
  describeDockerFailure,
  formatDockerLoginError,
  runDockerForeground,
  runDockerStreaming,
} from '../utils/docker-cmd.js';
import { canonicalizeRegion } from '../utils/aws-partition.js';
import { parseEcrRegistryHost } from '../utils/ecr-uri.js';

export { parseEcrRegistryHost };
import { LocalInvokeBuildError } from '../utils/error-handler.js';
import { getLogger } from '../utils/logger.js';
import { displayIdent, displaySafe, ROLE_ARN_MAX_CODE_POINTS } from '../utils/display-safe.js';
import {
  ambientCredentialConfig,
  clientDefaultsFor,
  credentialFingerprint,
  type CredentialConfig,
} from '../utils/ambient-client-defaults.js';
import { injectiveKey } from '../state/record-keys.js';

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
 * Lower-case the REGISTRY HOST of an image reference and leave the repository
 * path and tag byte-identical.
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
 *
 * "Everything before the first `/`" is NOT the same thing as "the host", which
 * is why the first component is tested rather than assumed. Docker treats it
 * as a registry only when it contains a `.` or a `:` or is exactly
 * `localhost`; otherwise it is the first segment of a Docker Hub repository
 * PATH (`MyOrg/MyRepo:tag` is `docker.io/MyOrg/MyRepo:tag`). Folding that
 * would name a DIFFERENT image. Today every caller is behind the strict ECR
 * host check so the distinction is inert, but this is exported under a generic
 * name and the contract has to be the real one.
 */
export function canonicalizeImageUriHost(imageUri: string): string {
  const slash = imageUri.indexOf('/');
  if (slash < 0) return imageUri;
  const host = imageUri.slice(0, slash);
  if (!isRegistryHostComponent(host)) return imageUri;
  return foldAsciiUpperCase(host) + imageUri.slice(slash);
}

/**
 * Lower-case ONLY the ASCII letters `A`-`Z`, leaving every other code point
 * as written.
 *
 * `String.prototype.toLowerCase` performs full Unicode case folding, so the
 * Kelvin sign U+212A folds to a plain ASCII `k`. Folding with it here, BEFORE
 * `parseEcrRegistryHost`, handed that parser an already-ASCII host and defeated
 * the raw-capture charset guard it applies to the region and suffix (see
 * `CANONICAL_REGION_SEGMENT` in `src/utils/ecr-uri.ts`):
 * `<acct>.dkr.ecr-fips.us-<U+212A>east-1.amazonaws.com/...` parsed as the
 * region `us-keast-1`, a region the host does not name, and a Kelvin sign in
 * the LABELS resolved to the plain form. An ASCII-only fold keeps the case
 * fold the #1801 login / pull agreement needs (DNS case-insensitivity is
 * ASCII-only) while leaving any other code point for that guard to refuse.
 */
function foldAsciiUpperCase(value: string): string {
  return value.replace(/[A-Z]+/g, (run) => run.toLowerCase());
}

/** Docker's rule for "component 1 is a registry, not a repository segment". */
function isRegistryHostComponent(component: string): boolean {
  return component.includes('.') || component.includes(':') || component === 'localhost';
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
    region: canonicalizeRegion(host.region),
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
 * Module-level cache for STS-issued AssumeRole credentials, per SOURCE credential
 * identity and then per `(ecrRoleArn, callerRegion)`. Closes the reviewer's MAJOR finding: ECS
 * run-task with N containers under one `--ecr-role-arn` would otherwise issue
 * N× `AssumeRole` and N× `GetCallerIdentity` for identical credentials valid
 * for 3600s. The cache keeps a 5-minute safety margin against the recorded
 * `Expiration` so STS-side / local-clock skew never lets a stale entry through.
 *
 * The inner key is `(roleArn, region)`: STS issues per-region session creds,
 * so a switch of `--region` between two `local invoke` calls in the same
 * process must re-issue. The OUTER key is the source identity (issue
 * [#3588](https://github.com/go-to-k/cdkd/issues/3588), as in `role-arn.ts`),
 * so a library caller that installs `AwsClients` with other explicit
 * credentials is never handed credentials the first identity obtained. It is
 * {@link credentialFingerprint} — profile plus access key id, never a secret —
 * and neither key is ever rendered.
 *
 * NOT cleared on process exit — Node's module scope evaporates with the
 * process, and no inter-process sharing is desired (each `cdkd local invoke`
 * is its own isolated runtime).
 */
const ASSUMED_ROLE_CACHE = new Map<string, Map<string, TempCredentials>>();

/**
 * Module-level cache for `STS:GetCallerIdentity`, keyed by
 * `(credential identity, callerRegion)`. The account is a function of the
 * identity that asked, so the identity is part of the key (issue
 * [#3588](https://github.com/go-to-k/cdkd/issues/3588)): a library caller that
 * installs `AwsClients` with other explicit credentials must not be told the
 * first identity's account. The region half avoids a cross-region leak when the
 * caller flips `AWS_REGION` mid-process (STS is global but the SDK uses
 * regional endpoints; the result is invariant in practice, but we key on region
 * for safety). Never rendered.
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
 *
 * @test-only-export exists so unit tests can drop the module-level STS caches between
 * cases; no shipped code path calls it, and the rest of this module is live.
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
 * pass to `docker run`: the input with its registry HOST lower-cased and
 * its repository path + tag untouched (issue #1801). That is the SAME
 * spelling `docker pull` / `docker image inspect` were handed here, and
 * the same one the `docker login` endpoint names, on every host form
 * (issues #1855 / #3670).
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

  // Canonicalized (issue #1795) for THREE reasons, and every one of them bit:
  // the STS / AssumeRole clients below resolve their endpoint case-sensitively;
  // both module-level caches are KEYED on this value, so `US-EAST-1` and
  // `us-east-1` were separate entries paying a duplicate `GetCallerIdentity` /
  // `AssumeRole` — exactly the cost the caches exist to avoid; and the
  // cross-region comparison reads it. Folded HERE rather than trusting the
  // caller because `pullEcrImage` is also reached from `ecs-task-runner`.
  const callerRegion = canonicalizeRegion(
    options.region ?? process.env['AWS_REGION'] ?? process.env['AWS_DEFAULT_REGION']
  );

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
  //
  // ONE reading of the active credential configuration for this pull: every
  // client below builds from it and both caches key on it, so a value is always
  // filed under the identity that obtained it (issue #3588).
  const credentialConfig = ambientCredentialConfig();
  const identity = credentialFingerprint(credentialConfig);
  const callerIdentityKey = injectiveKey(identity, callerRegion ?? '_unset');
  let callerAccount = CALLER_IDENTITY_CACHE.get(callerIdentityKey);
  if (callerAccount === undefined) {
    const sts = new STSClient({
      // cdkd-local-role-identity: pulling the image is cdkd's OWN call, not the
      // emulated workload's, so a `--role-arn` correctly answers it. Nothing
      // resolved here reaches the container as an identity; the ECR login token
      // it leaves in the host docker config is the role's.
      ...clientDefaultsFor(credentialConfig),
      ...(callerRegion && { region: callerRegion }),
    });
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
  // Both sides are already canonical — `callerRegion` above, `parsed.region`
  // off the folded host — so this compares like with like (issue #1801).
  // Previously `--region US-EAST-1` against a lower-case host logged a
  // spurious `Cross-region ECR pull` line: log-only, but it reads as a real
  // misconfiguration.
  const crossRegion = callerRegion !== undefined && callerRegion !== parsed.region;

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
    // cdkd-arn-display: a Map KEY, never rendered. It is built from the ARN
    // so two different roles cannot share a credential cache entry, and from
    // the source identity's own map (keyed by its fingerprint) so two source
    // identities cannot either; nothing logs or displays it, and a sanitizing
    // pass here would make two distinct ARNs collide on one entry -- the
    // opposite of what the key is for.
    const cacheKey = `${options.ecrRoleArn}|${callerRegion ?? '_unset'}`;
    let roleCache = ASSUMED_ROLE_CACHE.get(identity);
    if (roleCache === undefined) {
      roleCache = new Map<string, TempCredentials>();
      ASSUMED_ROLE_CACHE.set(identity, roleCache);
    }
    const cached = roleCache.get(cacheKey);
    if (cached && isCredentialFresh(cached)) {
      assumed = cached;
      logger.debug(
        `Reusing cached AssumeRole credentials for ${displayIdent(options.ecrRoleArn, { maxCodePoints: ROLE_ARN_MAX_CODE_POINTS })}`
      );
    } else {
      assumed = await assumeRoleForEcr(options.ecrRoleArn, callerRegion, credentialConfig, logger);
      roleCache.set(cacheKey, assumed);
      logger.info(
        // cdkd-raw-beside-safe: `parsed.accountId` / `parsed.region` come out
        // of `parseEcrUri`, which delegates to `parseEcrRegistryHost` and refuses a region segment that is
        // not `[A-Za-z0-9-]` and an account that is not 12 digits BEFORE
        // folding case (`ecr-uri.ts`, issues go-to-k/cdkd#1786 /
        // go-to-k/cdkd#1792). A control character cannot survive that, so
        // these two are constrained rather than merely trusted.
        `Assumed role ${displayIdent(options.ecrRoleArn, { maxCodePoints: ROLE_ARN_MAX_CODE_POINTS })} for ECR pull (account=${parsed.accountId}, region=${parsed.region})`
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
  // credentials; otherwise the caller's active credential configuration.
  const ecr = new ECRClient({
    // cdkd-local-role-identity: pulling the image is cdkd's OWN call, not the
    // emulated workload's, so a `--role-arn` correctly answers it. Nothing
    // resolved here reaches the container as an identity; the ECR login token
    // it leaves in the host docker config is the role's.
    ...clientDefaultsFor(credentialConfig),
    region: parsed.region,
    // LAST, so an assumed `--ecr-role-arn` role outranks the caller's own
    // explicit credentials: the login must be the role's.
    ...(assumed && { credentials: assumed }),
  });
  try {
    await ecrLogin(ecr, {
      accountId: parsed.accountId,
      region: parsed.region,
      // The host `docker pull` below targets, taken off the SAME string it
      // pulls (issue #1855). `canonicalUri` passed `parseEcrRegistryHost`, so
      // its first component is a registry host whose every segment is
      // charset-constrained and whose suffix is an AWS-owned one.
      registryHost: canonicalUri.slice(0, canonicalUri.indexOf('/')),
    });
  } finally {
    ecr.destroy();
  }

  logger.info(`Pulling ${canonicalUri}...`);
  const pullArgs = ['pull', canonicalUri];
  try {
    await runDockerForeground(pullArgs);
  } catch (err) {
    throw new LocalInvokeBuildError(
      `docker pull ${canonicalUri} failed: ${describeDockerFailure(err, pullArgs)}`
    );
  }

  return canonicalUri;
}

/**
 * Assume the supplied role as the caller's active credential configuration
 * (`credentialConfig`, the same reading `pullEcrImage` keys its caches on) and
 * return the resulting temporary credentials. The STS client is built
 * with the caller's profile region (or unset) — STS is a global
 * service so the region is informational, but threading it through
 * mirrors the convention used by `src/utils/role-arn.ts`.
 */
async function assumeRoleForEcr(
  roleArn: string,
  callerRegion: string | undefined,
  credentialConfig: CredentialConfig,
  logger: ReturnType<ReturnType<typeof getLogger>['child']>
): Promise<TempCredentials> {
  logger.debug(
    `Assuming role ${displayIdent(roleArn, { maxCodePoints: ROLE_ARN_MAX_CODE_POINTS })} for ECR pull...`
  );
  const sts = new STSClient({
    // cdkd-local-role-identity: pulling the image is cdkd's OWN call, not the
    // emulated workload's, so a `--role-arn` correctly answers it. Nothing
    // resolved here reaches the container as an identity; the ECR login token
    // it leaves in the host docker config is the role's.
    ...clientDefaultsFor(credentialConfig),
    ...(callerRegion && { region: callerRegion }),
  });
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
        `AssumeRole(${displayIdent(roleArn, { maxCodePoints: ROLE_ARN_MAX_CODE_POINTS })}) returned no usable credentials. Verify the role's trust policy allows your identity to assume it.`
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
      `Failed to assume role ${displayIdent(roleArn, { maxCodePoints: ROLE_ARN_MAX_CODE_POINTS })} for ECR pull: ${displaySafe(reason)}. ` +
        "Verify the role exists and its trust policy permits the caller's identity to assume it."
    );
  } finally {
    sts.destroy();
  }
}

/**
 * Authenticate the local docker daemon against the target ECR registry.
 * Kept apart from `DockerAssetPublisher.ecrLogin`, which follows the same rule
 * (it logs in to the push host, #3681) but builds its host from an account and
 * region, while a pull here can name any account and any host form parsed from
 * the image URI.
 *
 * The login endpoint is ALWAYS the host the PULL targets (issues #1855 /
 * #3670): docker's credential store is keyed on the hostname verbatim, so a
 * login to any other host leaves the pull with no credentials (`no basic auth
 * credentials`). `GetAuthorizationToken`'s `proxyEndpoint` is therefore NOT
 * used. The request carries no `registryIds`, so it names the CALLER's default
 * registry on the plain host: the wrong host for a FIPS or dual-stack pull, and
 * the wrong ACCOUNT for a cross-account plain pull made on the caller's own
 * credentials (a repository-policy grant, no `--ecr-role-arn`). The token is
 * principal-scoped, not host-scoped: measured against real ECR, one token
 * authenticated `/v2/` on all four host forms `ECR_REGISTRY_HOST_FORMS` lists.
 */
async function ecrLogin(
  client: ECRClient,
  target: { accountId: string; region: string; registryHost: string }
): Promise<void> {
  const { accountId, region, registryHost } = target;
  const logger = getLogger().child('ecr-puller');
  logger.debug(`ECR login (account=${accountId}, region=${region}, host=${registryHost})`);

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
  // `registryHost` passed `parseEcrRegistryHost`: every segment is
  // charset-constrained and its suffix is the AWS-owned one its form carries
  // for the region, so this never names a host AWS does not own. It is also
  // what keeps the #1758 partition suffix: the parse paired it with the region.
  const endpoint = `https://${registryHost}`;

  const loginArgs = ['login', '--username', username, '--password-stdin', endpoint];
  try {
    await runDockerStreaming(loginArgs, { input: password });
  } catch (err) {
    throw new LocalInvokeBuildError(
      `ECR login failed: ${formatDockerLoginError(describeDockerFailure(err, loginArgs), endpoint)}`
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
 * the caller decides what message to surface on miss.
 *
 * @no-live-caller nothing in `src/` calls this. The rest of this module is live; this one
 * helper is not, and the `docker-image-builder` reuse its doc used to claim never existed --
 * that file wraps cdk-local's `buildContainerImage` to re-brand the thrown error and never
 * probes the local image cache (issue #2228).
 */
export async function isImageInLocalCache(imageRef: string): Promise<boolean> {
  try {
    await runDockerStreaming(['image', 'inspect', imageRef]);
    return true;
  } catch {
    return false;
  }
}
