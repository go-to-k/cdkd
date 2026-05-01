import { readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { getLogger } from '../utils/logger.js';

/**
 * CDK configuration loaded from cdk.json and environment variables
 */
export interface CdkConfig {
  app?: string;
  output?: string;
  context?: Record<string, unknown>;
}

/**
 * cdkd-specific configuration extracted from cdk.json context or environment
 */
export interface CdkdConfig {
  stateBucket?: string;
}

/**
 * Load a JSON config file and return as CdkConfig, or null if not found.
 */
function loadJsonConfig(filePath: string): CdkConfig | null {
  const logger = getLogger();

  if (!existsSync(filePath)) {
    return null;
  }

  try {
    const content = readFileSync(filePath, 'utf-8');
    const config = JSON.parse(content) as CdkConfig;
    logger.debug(`Loaded config from ${filePath}`);
    return config;
  } catch (error) {
    logger.warn(
      `Failed to parse ${filePath}: ${error instanceof Error ? error.message : String(error)}`
    );
    return null;
  }
}

/**
 * Load cdk.json from the current working directory
 */
export function loadCdkJson(cwd?: string): CdkConfig | null {
  const dir = cwd || process.cwd();
  return loadJsonConfig(resolve(dir, 'cdk.json'));
}

/**
 * Load user-level defaults from ~/.cdk.json
 *
 * CDK CLI reads this as user-level defaults (lowest priority).
 * Context values from ~/.cdk.json are merged below project cdk.json context.
 */
export function loadUserCdkJson(): CdkConfig | null {
  return loadJsonConfig(join(homedir(), '.cdk.json'));
}

/**
 * Resolve the --app option from CLI, cdk.json, or environment
 *
 * Priority: CLI option > CDKD_APP env > cdk.json app field
 */
export function resolveApp(cliApp?: string): string | undefined {
  if (cliApp) return cliApp;

  const envApp = process.env['CDKD_APP'];
  if (envApp) return envApp;

  const cdkJson = loadCdkJson();
  return cdkJson?.app ?? undefined;
}

/**
 * Source of a resolved state-bucket name.
 *
 * Reported by `cdkd state info` so users can see *why* a particular bucket was
 * chosen. The CLI flag wins over the env var, which wins over cdk.json, which
 * falls through to a default name derived from the STS account id.
 */
export type StateBucketSource = 'cli-flag' | 'env' | 'cdk.json' | 'default' | 'default-legacy';

/**
 * Result of resolving the state bucket, including the source that won.
 */
export interface ResolvedStateBucket {
  bucket: string;
  source: StateBucketSource;
}

/**
 * Resolve the --state-bucket option from CLI, cdk.json context, or environment
 *
 * Priority: CLI option > CDKD_STATE_BUCKET env > cdk.json context.cdkd.stateBucket
 */
export function resolveStateBucket(cliBucket?: string): string | undefined {
  return resolveStateBucketWithSource(cliBucket)?.bucket;
}

/**
 * Like {@link resolveStateBucket}, but also reports which source provided the
 * value. Returns `undefined` when no synchronous source is configured (caller
 * should fall back to the STS-derived default).
 */
export function resolveStateBucketWithSource(cliBucket?: string): ResolvedStateBucket | undefined {
  if (cliBucket) return { bucket: cliBucket, source: 'cli-flag' };

  const envBucket = process.env['CDKD_STATE_BUCKET'];
  if (envBucket) return { bucket: envBucket, source: 'env' };

  const cdkJson = loadCdkJson();
  const cdkdContext = cdkJson?.context?.['cdkd'] as Record<string, unknown> | undefined;
  const bucket = cdkdContext?.['stateBucket'];
  if (typeof bucket === 'string') return { bucket, source: 'cdk.json' };

  return undefined;
}

/**
 * Generate default state bucket name from account info.
 *
 * Format: `cdkd-state-{accountId}` (region intentionally omitted).
 *
 * S3 bucket names are globally unique, so embedding the profile region in the
 * default name made teammates with different profile regions look up
 * different buckets and silently fork their state. Dropping the region from
 * the default lets the whole team converge on a single bucket — its actual
 * region is auto-detected at runtime via `GetBucketLocation`
 * ({@link import('../utils/aws-region-resolver.js').resolveBucketRegion}).
 */
export function getDefaultStateBucketName(accountId: string): string {
  return `cdkd-state-${accountId}`;
}

/**
 * Generate the **legacy** default state bucket name.
 *
 * Format: `cdkd-state-{accountId}-{region}` — the pre-v0.8 default.
 *
 * Used only by the backwards-compatibility fallback in
 * {@link resolveStateBucketWithDefault}: if the new region-free bucket is not
 * found, cdkd checks the legacy region-suffixed name so users who already
 * bootstrapped under the old default keep working until they migrate.
 *
 * TODO(remove-bc-after-1.x): Remove this helper and all callers when the
 * backwards-compat read path is dropped (tracked in PR 99 of the
 * region/state refactor — see `docs/plans/04-state-bucket-naming.md`).
 */
export function getLegacyStateBucketName(accountId: string, region: string): string {
  return `cdkd-state-${accountId}-${region}`;
}

/**
 * Resolve state bucket with STS fallback.
 *
 * Priority:
 * 1. Explicit value from `--state-bucket` / `CDKD_STATE_BUCKET` /
 *    `cdk.json context.cdkd.stateBucket` — used as-is.
 * 2. Default name `cdkd-state-{accountId}` (new). Verified to exist via
 *    `HeadBucket` against a region-agnostic S3 client (the actual region is
 *    resolved separately by {@link
 *    import('../utils/aws-region-resolver.js').resolveBucketRegion}).
 * 3. Legacy name `cdkd-state-{accountId}-{region}` — only consulted if step 2
 *    returned `NoSuchBucket` / 404. Logs a deprecation warning.
 * 4. Neither found → throw a "run cdkd bootstrap" error pointing at the new
 *    name.
 *
 * `region` is the CLI's *profile* region; it is used only to construct the
 * legacy fallback name. The actual state-bucket region is resolved later by
 * `resolveBucketRegion`, so the caller does not need to pass the bucket's
 * real region here.
 *
 * Requires AWS credentials to be configured (STS GetCallerIdentity).
 *
 * The bucket name is logged at debug level only — it includes the AWS account
 * id, which would leak via screenshots / public CI logs if printed by default.
 * Use `cdkd state info` to inspect on demand, or pass `--verbose` to surface
 * it in routine commands.
 */
export async function resolveStateBucketWithDefault(
  cliBucket: string | undefined,
  region: string
): Promise<string> {
  return (await resolveStateBucketWithDefaultAndSource(cliBucket, region)).bucket;
}

/**
 * Like {@link resolveStateBucketWithDefault}, but also reports which source
 * provided the value (`'cli-flag'` / `'env'` / `'cdk.json'` / `'default'` /
 * `'default-legacy'`).
 */
export async function resolveStateBucketWithDefaultAndSource(
  cliBucket: string | undefined,
  region: string
): Promise<ResolvedStateBucket> {
  // Step 1: explicit value short-circuits the lookup chain.
  const syncResult = resolveStateBucketWithSource(cliBucket);
  if (syncResult) return syncResult;

  const logger = getLogger();
  logger.debug('No state bucket specified, resolving default from account...');

  const { GetCallerIdentityCommand } = await import('@aws-sdk/client-sts');
  const { S3Client } = await import('@aws-sdk/client-s3');
  const { getAwsClients } = await import('../utils/aws-clients.js');
  const awsClients = getAwsClients();
  const identity = await awsClients.sts.send(new GetCallerIdentityCommand({}));
  const accountId = identity.Account!;

  const newName = getDefaultStateBucketName(accountId);
  // TODO(remove-bc-after-1.x): legacy name kept for the backwards-compat read
  // path; remove together with the fallback branch below in PR 99.
  const legacyName = getLegacyStateBucketName(accountId, region);

  // Use a region-agnostic client (us-east-1) for the existence checks. S3
  // returns 301 / 404 globally for both names — we don't need the real bucket
  // region to ask whether the bucket exists. The state-bucket S3 client used
  // for actual reads/writes is rebuilt against the bucket's real region via
  // `resolveBucketRegion` later in the flow.
  const probe = new S3Client({ region: 'us-east-1' });
  try {
    // Step 2: try the new region-free name first.
    if (await bucketExists(probe, newName)) {
      // Logged at debug only — see resolveStateBucketWithDefault doc-comment.
      logger.debug(`State bucket: ${newName}`);
      return { bucket: newName, source: 'default' };
    }

    // TODO(remove-bc-after-1.x): drop the legacy fallback branch in PR 99.
    // Step 3: fall back to the legacy region-suffixed name.
    if (await bucketExists(probe, legacyName)) {
      logger.warn(
        `Using legacy state bucket name '${legacyName}'. ` +
          `The default has changed to '${newName}'. To migrate, run:\n\n` +
          `    cdkd state migrate-bucket --region ${region}\n\n` +
          `(add --remove-legacy to delete the legacy bucket after a successful copy; ` +
          `legacy support will be dropped in a future release.)`
      );
      return { bucket: legacyName, source: 'default-legacy' };
    }

    // Step 4: neither bucket exists.
    throw new Error(
      `No cdkd state bucket found for account ${accountId}. ` +
        `Looked for '${newName}' (current default) and '${legacyName}' (legacy default). ` +
        `Run 'cdkd bootstrap' to create '${newName}'.`
    );
  } finally {
    probe.destroy();
  }
}

/**
 * Probe whether an S3 bucket exists from this account's perspective.
 *
 * Returns:
 *  - `true` for any 2xx (`HeadBucket` succeeded) **or** 301 (the bucket
 *    exists, just in a different region — we can still use it because the
 *    real region is resolved later by `resolveBucketRegion`).
 *  - `true` for 403 (we lack permission to head it, but it exists; let the
 *    state-backend produce a more specific error later).
 *  - `false` for 404 / `NotFound` / `NoSuchBucket`.
 *  - Re-throws anything else so credential / network failures aren't silently
 *    swallowed by the lookup chain.
 */
async function bucketExists(
  client: import('@aws-sdk/client-s3').S3Client,
  bucketName: string
): Promise<boolean> {
  const { HeadBucketCommand } = await import('@aws-sdk/client-s3');
  try {
    await client.send(new HeadBucketCommand({ Bucket: bucketName }));
    return true;
  } catch (error) {
    const err = error as {
      name?: string;
      $metadata?: { httpStatusCode?: number };
      message?: string;
    };
    const status = err.$metadata?.httpStatusCode;
    if (err.name === 'NotFound' || err.name === 'NoSuchBucket' || status === 404) {
      return false;
    }
    // 301 = bucket exists in a different region (cross-region HEAD redirect).
    // 403 = bucket exists but we lack `s3:ListBucket` — treat as existing so
    // the downstream operation surfaces the real "access denied" error.
    if (status === 301 || status === 403) {
      return true;
    }
    // AWS SDK v3 synthetic Unknown error — covers the empty-body 301 redirect
    // case where the SDK fails to parse the status. We can't distinguish from
    // here, so re-throw and let the caller decide.
    throw error;
  }
}
