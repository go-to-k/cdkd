import { readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { getLogger } from '../utils/logger.js';
import { awsClientDefaults } from '../utils/aws-client-defaults.js';

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
 * Outcome of the `HeadBucket` probe {@link resolveStateBucketWithDefaultAndSource}
 * runs against a default-name candidate.
 *
 *  - `'ok'` — 2xx, or a 301 that only means "the bucket lives in another
 *    region" (the state client is region-corrected before it is used).
 *  - `'access-denied'` — 403. The bucket EXISTS (so name resolution still
 *    picks it), but this identity could not head it: either an IAM gap or a
 *    foreign-owned bucket rejected by the `ExpectedBucketOwner` header.
 *  - `'missing'` — 404 / `NoSuchBucket`.
 */
type BucketProbeOutcome = 'ok' | 'access-denied' | 'missing';

/**
 * Result of resolving the state bucket, including the source that won.
 */
export interface ResolvedStateBucket {
  bucket: string;
  source: StateBucketSource;
  /**
   * The probe outcome for the CHOSEN bucket — set only on the default-name
   * paths, which are the only ones that probe. `undefined` for an
   * explicitly-specified bucket (taken verbatim, never probed).
   */
  probe?: BucketProbeOutcome;
}

/**
 * Did this resolution already prove the bucket is there AND usable by these
 * credentials — making the state backend's own `HeadBucket` pure duplication?
 *
 * Both conditions matter:
 *
 *  - The source must be a default-name path.
 *    {@link resolveStateBucketWithDefaultAndSource} picks between
 *    `cdkd-state-{accountId}` and the legacy `cdkd-state-{accountId}-{region}`
 *    by `HeadBucket`-ing both, with the same credentials the state client
 *    will use. An explicitly-specified bucket (`--state-bucket` /
 *    `CDKD_STATE_BUCKET` / `cdk.json`) is taken verbatim and never probed.
 *  - The probe must have come back `'ok'`. A 403 counts as "exists" for
 *    NAME resolution but says nothing good about usability, and it is
 *    precisely the case where a second `HeadBucket` still earns its round
 *    trip — it turns a confusing mid-deploy state-read failure into an
 *    up-front "Access denied" before any asset is published.
 *
 * Consumed by `cdkd deploy` to skip the duplicate `HeadBucket` in
 * `S3StateBackend.verifyBucketExists` (issue
 * [#1283](https://github.com/go-to-k/cdkd/issues/1283)) — one fewer sequential
 * round trip on the deploy preflight's critical path.
 */
export function stateBucketExistenceConfirmed(resolved: ResolvedStateBucket): boolean {
  if (resolved.source !== 'default' && resolved.source !== 'default-legacy') return false;
  return resolved.probe === 'ok';
}

/**
 * SDK bits the default-name bucket probes need, resolved ONCE by
 * {@link resolveStateBucketWithDefaultAndSource} and handed down.
 *
 * The probes used to `await import()` these themselves on every call, which
 * both repeated work and meant the (now concurrent — issue #1283) probes each
 * paid their own module resolution.
 */
interface BucketProbeDeps {
  HeadBucketCommand: typeof import('@aws-sdk/client-s3').HeadBucketCommand;
  ListObjectsV2Command: typeof import('@aws-sdk/client-s3').ListObjectsV2Command;
  expectedOwnerParam: (
    client: import('@aws-sdk/client-s3').S3Client
  ) => Promise<{ ExpectedBucketOwner?: string }>;
}

/**
 * Resolve the `--capture-observed-state` / `--no-capture-observed-state`
 * option's effective value, falling through to `cdk.json
 * context.cdkd.captureObservedState` when the CLI flag was not passed.
 *
 * Commander reports `--no-X` flags by emitting `x: false` (which the deploy
 * command's TS type carries as `captureObservedState: boolean`). We can't
 * tell from that whether the user explicitly opted out vs. accepted the
 * default `true`, so the cdk.json fallback only fires when the CLI value
 * is the implicit default (`true`). Pass `--no-capture-observed-state`
 * to overrule a `cdk.json: { captureObservedState: true }` explicitly.
 */
export function resolveCaptureObservedState(cliValue: boolean): boolean {
  if (cliValue === false) return false;
  const cdkJson = loadCdkJson();
  const cdkdContext = cdkJson?.context?.['cdkd'] as Record<string, unknown> | undefined;
  const v = cdkdContext?.['captureObservedState'];
  if (typeof v === 'boolean') return v;
  return true;
}

/**
 * Resolve the effective `--use-cdk-bootstrap-assets` value (issue #1002
 * PR 2, design §4.2): pin legacy asset destinations for one app even when
 * the region's bootstrap marker exists — for apps deployed via both
 * CloudFormation and cdkd during a migration window.
 *
 * Priority: CLI flag (`true` wins) > `cdk.json context.cdkd.useCdkBootstrapAssets`
 * (boolean) > default `false`. The CLI flag has no `--no-` negation form, so
 * a cdk.json `true` can only be overruled by removing the context entry —
 * matching the "per-app pin" semantics (the app is CFn-co-deployed or it
 * isn't; per-invocation flip-flop would churn stack properties).
 */
export function resolveUseCdkBootstrapAssets(cliValue?: boolean): boolean {
  if (cliValue === true) return true;
  const cdkJson = loadCdkJson();
  const cdkdContext = cdkJson?.context?.['cdkd'] as Record<string, unknown> | undefined;
  const v = cdkdContext?.['useCdkBootstrapAssets'];
  return v === true;
}

/**
 * Resolve the effective "auto-create cdkd asset storage on first deploy into
 * an un-opted-in region" value (issue #1007).
 *
 * Mirrors {@link resolveCaptureObservedState}'s `--no-X` shape: Commander
 * reports `--no-auto-asset-storage` as `autoAssetStorage: false`, and the
 * implicit default is `true` — so the cdk.json fallback
 * (`context.cdkd.autoAssetStorage`, boolean) only fires when the CLI value
 * is the implicit default. Priority: CLI `false` wins > cdk.json boolean >
 * default `true`.
 */
export function resolveAutoAssetStorage(cliValue?: boolean): boolean {
  if (cliValue === false) return false;
  const cdkJson = loadCdkJson();
  const cdkdContext = cdkJson?.context?.['cdkd'] as Record<string, unknown> | undefined;
  const v = cdkdContext?.['autoAssetStorage'];
  if (typeof v === 'boolean') return v;
  return true;
}

/**
 * Resolve the effective value for "should cdkd skip the stack-name
 * prefix on user-supplied physical names?" on `cdkd deploy`.
 *
 * Returns `true` when cdkd should SKIP prepending the stack name to
 * user-declared physical names (e.g. an `iam.Role` whose `roleName:
 * 'my-role'` was set explicitly by the user). Returns `false` when
 * cdkd should KEEP the legacy behavior of prepending the stack name
 * (the pre-v0.94.0 default; now an explicit opt-in).
 *
 * **Default flipped in v0.94.0** ([#299](https://github.com/go-to-k/cdkd/issues/299)).
 * Prior to v0.94.0 the default was `false` (= legacy prefixing) and
 * `--no-prefix-user-supplied-names` was the opt-in. Now the default
 * is `true` (= unprefixed) and `--prefix-user-supplied-names` is the
 * opt-in to restore legacy prefixing. Deploying a CDK app with
 * `roleName: 'my-role'` produces an AWS resource named `my-role` by
 * default; consistent across every resource type out of the box.
 *
 * Auto-generated names (where the user did NOT supply a physical
 * name) are unaffected — every provider's `generateResourceName`
 * call sets `userSupplied: false` on the logical-id fallback path,
 * so the prefix stays for those resources regardless of this flag.
 *
 * Resolution chain (highest wins):
 *
 *   1. `--prefix-user-supplied-names` CLI flag → Commander emits
 *      `prefixUserSuppliedNames: true` when the flag is passed.
 *      That explicit opt-in to legacy prefixing short-circuits the
 *      lookup and returns `false` regardless of env / cdk.json.
 *   2. `CDKD_PREFIX_USER_SUPPLIED_NAMES=true` env var → also returns
 *      `false` (= keep legacy prefixing).
 *   3. `cdk.json` `context.cdkd.prefixUserSuppliedNames: true` →
 *      same effect.
 *   4. Deprecated `--no-prefix-user-supplied-names` CLI flag (Commander
 *      emits `noPrefixUserSuppliedNames: false`) → no-op vs the new
 *      default; emits a deprecation warning. Pre-v0.94.0 this was
 *      the way to opt in to skipping the prefix; now it matches the
 *      default and is kept only for backward-compat / scripts that
 *      already set it.
 *   5. Deprecated `CDKD_NO_PREFIX_USER_SUPPLIED_NAMES=true` env var
 *      and `cdk.json context.cdkd.noPrefixUserSuppliedNames: true` →
 *      same deprecation-warning + no-op semantics.
 *   6. Default `true` (skip prefix — new default in v0.94.0).
 *
 * Mirrors {@link resolveCaptureObservedState}'s pattern. The cliValue
 * argument carries the Commander-emitted boolean for
 * `--prefix-user-supplied-names`. The deprecated
 * `--no-prefix-user-supplied-names` flag is detected via the pre-parse
 * argv walk in {@link warnDeprecatedNoPrefixCliFlag} — NOT here, because
 * declaring both flag forms as separate Commander Options collapses
 * them onto a single key (`noPrefixUserSuppliedNames` would be
 * permanently `undefined` at runtime). Commander's automatic `--no-X`
 * negation still parses the deprecated form without error; it just
 * negates `prefixUserSuppliedNames` to its default `false` (= skip
 * prefix), which matches the new v0.94.0 default semantically.
 */
export interface ResolveSkipPrefixOptions {
  /**
   * Commander-emitted value of `--prefix-user-supplied-names` (the new
   * opt-in to legacy prefixing). `true` when the user passed the flag;
   * `false` (= default) when they did not. When `true`, cdkd KEEPS
   * legacy prefixing and {@link resolveSkipPrefix} returns `false`.
   */
  prefixUserSuppliedNames?: boolean;
}

/**
 * Pre-parse argv walk that surfaces the deprecation warning when the
 * user explicitly passes the legacy `--no-prefix-user-supplied-names`
 * flag. Commander's auto-negation of `--prefix-user-supplied-names`
 * accepts the flag without surfacing it as a distinct option key, so
 * this walk is the only way to catch it for the warning. Call once at
 * the top of every deploy invocation, before {@link resolveSkipPrefix}.
 *
 * Matches the literal `--no-prefix-user-supplied-names` token (and its
 * `--no-prefix-user-supplied-names=<value>` form) so scripts that pass
 * the flag with an explicit value still see the warning.
 */
export function warnDeprecatedNoPrefixCliFlag(argv: readonly string[] = process.argv): void {
  const seen = argv.some(
    (a) =>
      a === '--no-prefix-user-supplied-names' || a.startsWith('--no-prefix-user-supplied-names=')
  );
  if (seen) {
    getLogger().warn(
      '--no-prefix-user-supplied-names is deprecated since v0.94.0 — ' +
        'skipping the prefix is now the default. Remove the flag.'
    );
  }
}

export function resolveSkipPrefix(opts: ResolveSkipPrefixOptions = {}): boolean {
  const logger = getLogger();

  // Tier 1: --prefix-user-supplied-names CLI flag → keep legacy
  // prefixing. Wins over every other source.
  if (opts.prefixUserSuppliedNames === true) {
    return false;
  }

  // Tier 2: CDKD_PREFIX_USER_SUPPLIED_NAMES=true env var → also keep
  // legacy prefixing.
  const envPrefix = process.env['CDKD_PREFIX_USER_SUPPLIED_NAMES'];
  if (envPrefix === 'true') {
    return false;
  }

  // Tier 3: cdk.json context.cdkd.prefixUserSuppliedNames: true →
  // same effect.
  const cdkJson = loadCdkJson();
  const cdkdContext = cdkJson?.context?.['cdkd'] as Record<string, unknown> | undefined;
  const v = cdkdContext?.['prefixUserSuppliedNames'];
  if (typeof v === 'boolean' && v === true) {
    return false;
  }

  // Deprecated CDKD_NO_PREFIX_USER_SUPPLIED_NAMES env var +
  // cdk.json context.cdkd.noPrefixUserSuppliedNames: emit a
  // deprecation warning when set; they now match the default and are
  // no-ops in effect. (The CLI-flag equivalent is detected via
  // warnDeprecatedNoPrefixCliFlag — see the docstring above.)
  const deprecatedEnv = process.env['CDKD_NO_PREFIX_USER_SUPPLIED_NAMES'];
  if (deprecatedEnv === 'true') {
    logger.warn(
      'CDKD_NO_PREFIX_USER_SUPPLIED_NAMES is deprecated since v0.94.0 — ' +
        'skipping the prefix is now the default. Unset the env var.'
    );
  }
  const deprecatedCdkJson = cdkdContext?.['noPrefixUserSuppliedNames'];
  if (typeof deprecatedCdkJson === 'boolean' && deprecatedCdkJson === true) {
    logger.warn(
      'cdk.json context.cdkd.noPrefixUserSuppliedNames is deprecated since v0.94.0 — ' +
        'skipping the prefix is now the default. Remove the entry.'
    );
  }

  // Tier 6: default → skip prefix (the v0.94.0 flip).
  return true;
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
  const { S3Client, HeadBucketCommand, ListObjectsV2Command } = await import('@aws-sdk/client-s3');
  const { getAwsClients } = await import('../utils/aws-clients.js');
  const { expectedOwnerParam, recordResolvedAccountId } =
    await import('../utils/expected-bucket-owner.js');
  // Resolved ONCE here and handed to the probes below. They used to re-issue
  // these dynamic imports per call; hoisting drops four redundant awaits and
  // keeps the concurrent probes (issue #1283) importing nothing in parallel.
  const probeDeps: BucketProbeDeps = {
    HeadBucketCommand,
    ListObjectsV2Command,
    expectedOwnerParam,
  };
  const awsClients = getAwsClients();
  const stsClient = awsClients.sts;
  const identity = await stsClient.send(new GetCallerIdentityCommand({}));
  const accountId = identity.Account!;

  // Memoize the account id we just resolved against the credentials that
  // resolved it, so the `ExpectedBucketOwner` header on the probes below —
  // and on every later state-bucket call made with the same credentials —
  // reuses this round trip instead of issuing its own `GetCallerIdentity`
  // (issue #1283; the per-client cache could not collapse them because the
  // probe and the region-corrected state client are different objects).
  await recordResolvedAccountId(stsClient, accountId);

  const newName = getDefaultStateBucketName(accountId);
  // TODO(remove-bc-after-1.x): legacy name kept for the backwards-compat read
  // path; remove together with the fallback branch below in PR 99.
  const legacyName = getLegacyStateBucketName(accountId, region);

  // Use a region-agnostic client (us-east-1) for the existence checks. S3
  // returns 301 / 404 globally for both names — we don't need the real bucket
  // region to ask whether the bucket exists. The state-bucket S3 client used
  // for actual reads/writes is rebuilt against the bucket's real region via
  // `resolveBucketRegion` later in the flow.
  //
  // The probe reuses the STS client's OWN credential provider on purpose: the
  // bucket name it is about to probe was derived from THAT identity's account,
  // so probing as anyone else answers the wrong question. (Before issue #1283
  // the probe fell through to the default chain even under `--profile`, so a
  // profile pointing at a different account than the ambient credentials made
  // every probe come back 403 = "exists" by accident.) Sharing the identity is
  // also what makes the deploy preflight's `verifyBucketExists` HeadBucket
  // genuinely redundant — see `stateBucketExistenceConfirmed`.
  const stsCredentials = (stsClient as { config?: { credentials?: unknown } }).config?.credentials;
  // No `profile` argument: the probe's identity comes from `stsCredentials`
  // below, which was resolved by a client that already carries the proxy
  // handler AND the profile. When that reuse does not apply, the defaults'
  // chain is the SDK default chain with the handler threaded through, which is
  // exactly the profile-less chain this site fell back to before.
  const probe = new S3Client({
    ...awsClientDefaults(),
    region: 'us-east-1',
    ...(typeof stsCredentials === 'function' && { credentials: stsCredentials as never }),
  });
  try {
    // Independent probes — run them concurrently. Sequentially they were two
    // back-to-back S3 round trips on the deploy's critical path (issue #1283).
    // `Promise.all` handles both rejections, so a double failure cannot leak
    // an unhandled rejection; the first error still propagates unchanged.
    const [newProbe, legacyProbe] = await Promise.all([
      probeBucket(probe, newName, probeDeps),
      probeBucket(probe, legacyName, probeDeps),
    ]);
    // A 403 still counts as "the bucket is there" for NAME resolution — we
    // just could not head it. The distinction is carried through on the
    // returned `probe` field so the deploy preflight knows whether its own
    // HeadBucket would be pure duplication (see stateBucketExistenceConfirmed).
    const newExists = newProbe !== 'missing';
    const legacyExists = legacyProbe !== 'missing';

    // Step 2 / 3: pick the bucket that actually has state.
    //
    // Three sub-cases when one or both default buckets exist:
    //
    //   a. Only new exists  → use new (no legacy to consider).
    //   b. Only legacy exists → use legacy + deprecation warning, point
    //      the user at `cdkd state migrate`.
    //   c. Both exist → previously we always picked new. That hid the
    //      common upgrade path: legacy bucket from an earlier cdkd
    //      version + an empty new bucket left behind by a partial
    //      migration / probe / bootstrap. Picking new in that case
    //      makes the next deploy think the stack is brand-new and
    //      collide with the existing AWS resources. Now we look at
    //      whether new actually has state under `cdkd/`. If new is
    //      empty AND legacy has state, fall back to legacy with a
    //      strong warning telling the user to run migrate.
    if (newExists && legacyExists) {
      const newHasState = await bucketHasAnyState(probe, newName, probeDeps);
      if (!newHasState) {
        const legacyHasState = await bucketHasAnyState(probe, legacyName, probeDeps);
        if (legacyHasState) {
          logger.warn(
            `Both '${newName}' (new default) and '${legacyName}' (legacy default) exist, ` +
              `but the new bucket is empty and the legacy one has state. Reading from legacy. ` +
              `Run \`cdkd state migrate --region ${region}\` to copy the state into the new ` +
              `bucket and stop seeing this warning.`
          );
          return { bucket: legacyName, source: 'default-legacy', probe: legacyProbe };
        }
      }
      logger.debug(`State bucket: ${newName}`);
      return { bucket: newName, source: 'default', probe: newProbe };
    }

    if (newExists) {
      // Logged at debug only — see resolveStateBucketWithDefault doc-comment.
      logger.debug(`State bucket: ${newName}`);
      return { bucket: newName, source: 'default', probe: newProbe };
    }

    // TODO(remove-bc-after-1.x): drop the legacy fallback branch in PR 99.
    if (legacyExists) {
      logger.warn(
        `Using legacy state bucket name '${legacyName}'. ` +
          `The default has changed to '${newName}'. To migrate, run:\n\n` +
          `    cdkd state migrate --region ${region}\n\n` +
          `(add --remove-legacy to delete the legacy bucket after a successful copy; ` +
          `legacy support will be dropped in a future release.)`
      );
      return { bucket: legacyName, source: 'default-legacy', probe: legacyProbe };
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
 * Return `true` if the bucket has at least one object under the cdkd state
 * prefix (`cdkd/`). Used to disambiguate "this bucket holds state" from
 * "this bucket exists but is empty" — the latter happens when a previous
 * `cdkd state migrate` probe / bootstrap left a fresh bucket behind that
 * was never written to.
 *
 * Errors (network, access denied) are treated as "don't know" and return
 * `true` — biases toward NOT silently picking the legacy bucket when the
 * new one's state is uncertain. False positives here are harmless (the
 * downstream getState call will surface the real read error); a false
 * negative would silently route to legacy and be confusing.
 */
async function bucketHasAnyState(
  client: import('@aws-sdk/client-s3').S3Client,
  bucketName: string,
  deps: BucketProbeDeps
): Promise<boolean> {
  const { ListObjectsV2Command, expectedOwnerParam } = deps;
  try {
    const resp = await client.send(
      new ListObjectsV2Command({
        Bucket: bucketName,
        Prefix: 'cdkd/',
        MaxKeys: 1,
        ...(await expectedOwnerParam(client)),
      })
    );
    return (resp.KeyCount ?? 0) > 0;
  } catch {
    // Conservative: if we can't tell, assume the bucket has state so we
    // don't silently fall through to the legacy bucket.
    return true;
  }
}

/**
 * Probe whether an S3 bucket exists from this account's perspective.
 *
 * Returns a {@link BucketProbeOutcome}:
 *  - `'ok'` for any 2xx (`HeadBucket` succeeded) **or** 301 (the bucket
 *    exists, just in a different region — we can still use it because the
 *    real region is resolved later by `resolveBucketRegion`).
 *  - `'access-denied'` for 403 (we lack permission to head it, but it
 *    exists; name resolution still picks it and the state backend produces
 *    a more specific error later).
 *  - `'missing'` for 404 / `NotFound` / `NoSuchBucket`.
 *  - Re-throws anything else so credential / network failures aren't silently
 *    swallowed by the lookup chain.
 *
 * Name resolution only cares about `'missing'` vs. not; the `'ok'` /
 * `'access-denied'` split exists so `stateBucketExistenceConfirmed` can tell
 * "already verified" from "merely known to exist" (issue #1283).
 */
async function probeBucket(
  client: import('@aws-sdk/client-s3').S3Client,
  bucketName: string,
  deps: BucketProbeDeps
): Promise<BucketProbeOutcome> {
  const { HeadBucketCommand, expectedOwnerParam } = deps;
  try {
    // With ExpectedBucketOwner a foreign-owned bucket comes back 403, which
    // this probe already treats as "exists" — the decision is unchanged, but
    // the hardened state backend then refuses to use it (fail closed).
    await client.send(
      new HeadBucketCommand({ Bucket: bucketName, ...(await expectedOwnerParam(client)) })
    );
    return 'ok';
  } catch (error) {
    const err = error as {
      name?: string;
      $metadata?: { httpStatusCode?: number };
      message?: string;
    };
    const status = err.$metadata?.httpStatusCode;
    if (err.name === 'NotFound' || err.name === 'NoSuchBucket' || status === 404) {
      return 'missing';
    }
    // 301 = bucket exists in a different region (cross-region HEAD redirect).
    // Nothing is wrong: the state client is rebuilt for the bucket's real
    // region before it is used, so this counts as a clean probe.
    if (status === 301) {
      return 'ok';
    }
    // 403 = bucket exists but we lack `s3:ListBucket`, or it is owned by
    // another account and ExpectedBucketOwner rejected it. Treat as existing
    // so the downstream operation surfaces the real "access denied" error —
    // and mark it so the deploy preflight keeps its own HeadBucket rather
    // than deferring that error to the first state read.
    if (status === 403) {
      return 'access-denied';
    }
    // AWS SDK v3 synthetic Unknown error — covers the empty-body 301 redirect
    // case where the SDK fails to parse the status. We can't distinguish from
    // here, so re-throw and let the caller decide.
    throw error;
  }
}
