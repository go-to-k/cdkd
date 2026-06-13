import { S3Client } from '@aws-sdk/client-s3';
import { resolveBucketRegion } from './aws-region-resolver.js';

/**
 * Shared "rebuild a region-corrected S3 client for the state bucket" helper.
 *
 * Extracted from the three near-identical `ensureClientForBucket()` copies that
 * lived in `S3StateBackend` (PR #60), `LockManager` (#803), and
 * `ExportIndexStore` (#819) — issue #827. The state bucket can live in a
 * different AWS region from the CLI's base region; before any state / lock /
 * exports-index S3 operation each store resolves the bucket's actual region via
 * the cached `GetBucketLocation` probe and, if it differs from the supplied
 * client's region, swaps in an S3 client pointed at the bucket's region.
 *
 * This module is kept SEPARATE from `aws-region-resolver.ts` (where
 * `resolveBucketRegion` lives) on purpose: the per-store unit tests mock
 * `resolveBucketRegion` via `vi.mock('aws-region-resolver.js', ...)`. A helper
 * co-located in that module would call its sibling through an in-module binding
 * that vitest cannot intercept (you can't mock a module from within itself); a
 * helper in a separate module imports the mocked binding cross-module, so the
 * mock takes effect.
 */

/**
 * Static credentials passed through to a rebuilt S3 client / the
 * `GetBucketLocation` probe. Mirrors the AWS SDK credentials shape.
 */
export interface RebuildClientCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

/**
 * Options for {@link rebuildClientForBucketRegion}.
 *
 * The three cdkd state-bucket consumers (`S3StateBackend`, `LockManager`,
 * `ExportIndexStore`) each have load-bearing differences in HOW they thread
 * credentials and WHETHER they own the supplied client — these knobs preserve
 * every one of them while sharing the probe + same-region-short-circuit +
 * rebuild logic.
 */
export interface RebuildClientForBucketRegionOptions {
  /**
   * Explicit profile to thread into BOTH the `GetBucketLocation` probe and
   * the rebuilt client. Used by `S3StateBackend`, which carries static
   * `--profile` / credentials options into its constructor. The credential
   * helpers (`LockManager` / `ExportIndexStore`) leave this unset and reuse
   * the supplied client's resolved provider instead.
   */
  profile?: string;
  /**
   * Static credentials to thread into BOTH the probe and the rebuilt client.
   * Used by `S3StateBackend` (its constructor `clientOpts.credentials`). When
   * unset, the helper authenticates the probe with whatever
   * {@link RebuildClientForBucketRegionOptions.reuseClientCredentials} resolves
   * (best-effort) and reuses the original client's `config.credentials`
   * provider for the rebuilt client.
   */
  credentials?: RebuildClientCredentials;
  /**
   * When `true`, the helper authenticates the `GetBucketLocation` probe by
   * calling `client.config.credentials()` (best-effort — a failure downgrades
   * the probe to the default chain) AND, when it rebuilds, reuses the original
   * client's `config.credentials` provider reference rather than static
   * credentials. This is the `LockManager` / `ExportIndexStore` mode: those
   * call sites do NOT thread `--profile` / static credentials, so credentials
   * carry over from the shared `AwsClients.s3` client transparently.
   *
   * Ignored when {@link RebuildClientForBucketRegionOptions.credentials} is
   * supplied (static credentials win — the `S3StateBackend` mode).
   */
  reuseClientCredentials?: boolean;
  /**
   * When `true`, the helper calls `oldClient.destroy()` after building the
   * replacement. `S3StateBackend` OWNS its client and destroys it; `LockManager`
   * / `ExportIndexStore` share `AwsClients.s3` with other components and must
   * NOT destroy it. Defaults to `false`.
   */
  destroyOldClient?: boolean;
  /**
   * When `true`, a non-standard client (a test double / hand-rolled object
   * whose `config.region` is not a function) short-circuits to `null` ("no
   * rebuild — keep the original") instead of throwing. This is the
   * `ExportIndexStore` graceful-degradation behavior. Defaults to `false`
   * (the `S3StateBackend` / `LockManager` mode, which always reads
   * `config.region()` directly).
   */
  tolerateNonStandardClient?: boolean;
  /**
   * Optional callback fired exactly once when the helper rebuilds (region
   * mismatch). Callers thread their own child logger so the debug line uses the
   * store's log namespace + wording.
   */
  onRebuild?: (info: { bucket: string; bucketRegion: string; currentRegion: unknown }) => void;
}

/**
 * Resolve a state bucket's actual region and, if it differs from the supplied
 * client's configured region, return a fresh `S3Client` pointed at the bucket's
 * region (reusing the caller's credentials). Returns `null` when no rebuild is
 * needed — the bucket is already in the client's region — so the caller keeps
 * using the original client.
 *
 * This is the shared core of the (previously triplicated) `ensureClientForBucket`
 * pattern in `S3StateBackend` (PR #60), `LockManager` (#803), and
 * `ExportIndexStore` (#819). Each store keeps its own per-instance memoization
 * (`clientResolved` flag / single-flight `resolveInFlight` promise) and just
 * delegates the probe + short-circuit + rebuild here.
 *
 * The probe goes through the cached `resolveBucketRegion`, so when several
 * stores resolve the same bucket only the FIRST issues a `GetBucketLocation`.
 * `resolveBucketRegion` never throws — on any error it returns the supplied
 * `fallbackRegion` (the client's current region), so a missing / forbidden
 * bucket degrades to "no rebuild" rather than blocking the caller.
 *
 * Credential / ownership / test-double behavior is controlled by
 * {@link RebuildClientForBucketRegionOptions} — see each field for the per-store
 * rationale.
 *
 * @returns A region-corrected `S3Client` to swap in, or `null` to signal
 *   "no rebuild needed; keep the original client".
 */
export async function rebuildClientForBucketRegion(
  client: S3Client,
  bucket: string,
  opts: RebuildClientForBucketRegionOptions = {}
): Promise<S3Client | null> {
  const config = (
    client as {
      config?: { region?: unknown; credentials?: unknown };
    }
  ).config;

  if (!config || typeof config.region !== 'function') {
    if (opts.tolerateNonStandardClient) {
      // Test double / non-standard client — nothing to resolve.
      return null;
    }
    // The S3StateBackend / LockManager mode always assumes a standard client;
    // reading config.region() below would throw, matching their pre-refactor
    // behavior (those stores never guarded against a non-standard client).
  }

  const currentRegion = await (config!.region as () => Promise<unknown>)();
  const fallbackRegion = typeof currentRegion === 'string' ? currentRegion : undefined;

  // Authenticate the GetBucketLocation probe the same way the relevant store
  // did before the extraction.
  let probeCredentials: RebuildClientCredentials | undefined;
  if (opts.credentials) {
    probeCredentials = opts.credentials;
  } else if (opts.reuseClientCredentials && typeof config!.credentials === 'function') {
    // Best-effort: a failure here just downgrades the probe to the default
    // chain, and resolveBucketRegion itself never throws.
    try {
      probeCredentials = (await (
        config!.credentials as () => Promise<unknown>
      )()) as RebuildClientCredentials;
    } catch {
      probeCredentials = undefined;
    }
  }

  const bucketRegion = await resolveBucketRegion(bucket, {
    ...(opts.profile && { profile: opts.profile }),
    ...(probeCredentials && { credentials: probeCredentials }),
    ...(fallbackRegion && { fallbackRegion }),
  });

  if (bucketRegion === currentRegion) {
    // Same region — no rebuild needed, keep using the original client.
    return null;
  }

  opts.onRebuild?.({ bucket, bucketRegion, currentRegion });

  // Build the replacement client. S3StateBackend threads static credentials;
  // the credential-reusing stores pass the original client's `config.credentials`
  // provider reference through unchanged.
  const rebuiltCredentials = opts.credentials
    ? opts.credentials
    : opts.reuseClientCredentials
      ? ((client as { config: { credentials: unknown } }).config.credentials as never)
      : undefined;

  const replacement = new S3Client({
    region: bucketRegion,
    ...(opts.profile && { profile: opts.profile }),
    ...(rebuiltCredentials !== undefined && { credentials: rebuiltCredentials }),
    // Suppress "Are you using a Stream of unknown length" warning,
    // matching the suppression in AwsClients.
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
  });

  if (opts.destroyOldClient) {
    client.destroy();
  }

  return replacement;
}
