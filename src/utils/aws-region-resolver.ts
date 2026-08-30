import { GetBucketLocationCommand, S3Client } from '@aws-sdk/client-s3';
import { awsClientDefaults } from './aws-client-defaults.js';

/**
 * Per-bucket region cache.
 *
 * Storing the in-flight `Promise` (rather than the resolved value) collapses
 * concurrent calls for the same bucket into a single `GetBucketLocation`
 * request — the second caller awaits the same promise instead of issuing a
 * duplicate API call.
 */
const cache = new Map<string, Promise<string>>();

/**
 * Options accepted by {@link resolveBucketRegion}.
 *
 * `profile` and `credentials` mirror the AWS SDK shape so callers can pass
 * the same auth configuration the rest of cdkd uses.
 *
 * `fallbackRegion` is returned if `GetBucketLocation` fails for any reason —
 * the resolver never throws so a missing/forbidden bucket does not block the
 * caller from surfacing a more useful downstream error (e.g. the actionable
 * `normalizeAwsError` message).
 */
export interface ResolveBucketRegionOptions {
  profile?: string;
  credentials?: {
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken?: string;
  };
  fallbackRegion?: string;
  /**
   * The CALLER's own AWS region, used to place the `GetBucketLocation` probe
   * endpoint in the caller's PARTITION (issue
   * [#1763](https://github.com/go-to-k/cdkd/issues/1763)).
   *
   * Distinct from {@link ResolveBucketRegionOptions.fallbackRegion} only in
   * intent — a caller that already passes `fallbackRegion` (every
   * `rebuildClientForBucketRegion` consumer does, sourcing it from the
   * client's own `config.region()`) needs no change, since the probe falls
   * through to it. Supply this when the caller has a region in hand but no
   * opinion about what a failed probe should return.
   */
  region?: string;
}

/**
 * Read an S3 client's resolved region without issuing a network call.
 *
 * Used to discover what the AWS SDK's own region chain (env vars, shared
 * config profile) picked for a client that was constructed WITHOUT an
 * explicit region. Never throws — an unresolvable chain (and a hand-rolled
 * test double with no `config`) both degrade to `undefined` so the caller
 * falls through to its own default.
 */
async function readClientRegion(client: S3Client): Promise<string | undefined> {
  try {
    const config = (client as { config?: { region?: unknown } }).config;
    if (!config || typeof config.region !== 'function') return undefined;
    const region = await (config.region as () => Promise<unknown>)();
    return typeof region === 'string' && region.length > 0 ? region : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolve the AWS region of an S3 bucket via `GetBucketLocation`.
 *
 * Why `GetBucketLocation` rather than `HeadBucket`:
 *   AWS SDK v3's region-redirect middleware does not handle the empty-body
 *   HEAD response on a 301 cross-region redirect cleanly — the protocol
 *   parser falls through to `getErrorSchemaOrThrowBaseException` and
 *   produces a synthetic `name: 'Unknown', message: 'UnknownError'`.
 *   `GetBucketLocation` is a GET with an XML body and is not subject to the
 *   same SDK glitch.
 *
 * Why the probe is NOT pinned to us-east-1 (issue
 * [#1763](https://github.com/go-to-k/cdkd/issues/1763)):
 *   `GetBucketLocation` is answered by ANY regional S3 endpoint for any
 *   bucket in the SAME PARTITION — measured 2026-08-13 against a real
 *   eu-west-1 bucket, which resolved identically from us-east-1 / us-west-2 /
 *   ap-northeast-1 / eu-west-1 clients — so the probe never needs to know the
 *   answer to ask the question. But it DOES have to reach the right
 *   partition: a hardcoded `us-east-1` endpoint is unreachable from `aws-cn`
 *   / `us-iso*`, so outside the commercial partition the probe could not run
 *   at all, every call fell through to the commercial default, and every
 *   consumer (the state backend, the lock manager, the exports index, the
 *   custom-resource response path, `upload-cfn-template`) proceeded against
 *   the wrong region. The probe endpoint is therefore taken from, in order:
 *   `opts.region`, `opts.fallbackRegion`, the AWS SDK's own region chain
 *   (env / shared config profile — the chain every other cdkd client
 *   consults), and only then `us-east-1`. Commercial behavior is unchanged:
 *   the resolved value is identical from any commercial endpoint, and a
 *   caller with no region configured anywhere still probes `us-east-1`.
 *
 * A SUCCESSFUL result is cached per bucket name for the process lifetime —
 * bucket regions never move, so the cache never needs invalidation. A FAILED
 * probe is deliberately NOT cached (mirroring `write-only-properties.ts`):
 * the failure answer is a guess, and caching it let one transient error pin
 * every later caller in the process to the wrong region with no way to heal.
 *
 * @returns The bucket's region (e.g. `us-west-2`). An empty `LocationConstraint`
 *   in the response means `us-east-1` (S3 quirk — non-commercial partitions
 *   always report their region explicitly). On any error, returns
 *   `opts.fallbackRegion` if provided, else the region the probe was aimed at.
 */
export async function resolveBucketRegion(
  bucketName: string,
  opts: ResolveBucketRegionOptions = {}
): Promise<string> {
  const cached = cache.get(bucketName);
  if (cached) return cached;

  // Set by the probe when it degrades to a guess, so the entry can be evicted
  // and a later call retry instead of inheriting one transient failure.
  let probeFailed = false;

  const promise = (async (): Promise<string> => {
    // `auth` deliberately does NOT carry `awsClientDefaults()`. Up to two
    // clients are built below, and folding the defaults in here would give
    // them one `requestHandler` -- one routing agent and one credential chain
    // between them, which is the per-client rule broken through the back door.
    // The helper is called inside each literal instead, FIRST, so an explicit
    // `credentials` from `auth` still wins over the injected chain.
    const auth = {
      ...(opts.profile && { profile: opts.profile }),
      ...(opts.credentials && { credentials: opts.credentials }),
    };
    const explicitRegion = opts.region ?? opts.fallbackRegion;
    // `auth` carries no `region`, so nothing below is shadowed.
    let client = new S3Client({
      ...awsClientDefaults({ profile: opts.profile }),
      ...auth,
      ...(explicitRegion && { region: explicitRegion }),
    });
    // With no caller-supplied region the client resolves its own; when that
    // chain yields nothing the client cannot send at all, so pin the historic
    // us-east-1 endpoint rather than turning a working probe into a guess.
    let probeRegion = explicitRegion ?? (await readClientRegion(client));
    if (!probeRegion) {
      client.destroy();
      probeRegion = 'us-east-1';
      client = new S3Client({
        ...awsClientDefaults({ profile: opts.profile }),
        ...auth,
        region: probeRegion,
      });
    }
    try {
      // ExpectedBucketOwner: a foreign-owned bucket 403s here and falls into
      // the fallback below — it must not even leak its region (the data
      // calls behind this probe are all owner-guarded too).
      const { expectedOwnerParam } = await import('./expected-bucket-owner.js');
      const response = await client.send(
        new GetBucketLocationCommand({
          Bucket: bucketName,
          ...(await expectedOwnerParam(client)),
        })
      );
      // Empty / null `LocationConstraint` is S3's way of saying us-east-1.
      return response.LocationConstraint || 'us-east-1';
    } catch {
      // The resolver never throws: cdkd would rather surface the actionable
      // downstream error (HeadBucket → `normalizeAwsError`) than mask it
      // behind a noisy GetBucketLocation failure.
      probeFailed = true;
      return opts.fallbackRegion ?? probeRegion;
    } finally {
      client.destroy();
    }
  })();

  cache.set(bucketName, promise);
  const region = await promise;
  // Evict only OUR entry — a concurrent caller may already have installed a
  // fresh probe for the same bucket.
  if (probeFailed && cache.get(bucketName) === promise) cache.delete(bucketName);
  return region;
}

/**
 * Clear the per-bucket region cache. Used by tests to reset state between
 * cases — production code never needs to call this.
 */
export function clearBucketRegionCache(): void {
  cache.clear();
}

/**
 * Resolve the cdkd state bucket name + region for a sibling AWS account.
 *
 * Used by cross-account `Fn::GetStackOutput`: once the consumer's resolver
 * has assumed the producer's role, it needs to know which bucket the
 * producer's `cdkd deploy` wrote state to. cdkd's canonical bucket name
 * (since v0.7.0) is `cdkd-state-{accountId}` — region-free because S3
 * names are globally unique. The bucket's actual region is then looked
 * up via `GetBucketLocation` using the supplied (assumed) credentials.
 *
 * Why not reuse the consumer-side bucket-name resolution path: that path
 * supports legacy region-suffixed names (`cdkd-state-{accountId}-{region}`)
 * and an "empty-new-bucket" fallback, both of which require listing the
 * bucket contents to disambiguate. For cross-account reads we accept the
 * narrower scope — the producer must be on the canonical region-free
 * bucket layout (PR #60+, v0.10.0+) — because supporting the legacy
 * layout cross-account would require account-wide `s3:ListAllMyBuckets`
 * permission in the assumed role for no real-world benefit (legacy
 * accounts are nearing 5 years old; cross-account features land
 * post-legacy).
 *
 * @param accountId  12-digit AWS account ID of the producer (extracted
 *                   from the role ARN via `parseIamRoleArn`).
 * @param credentials Assumed credentials produced by
 *                   `assumeRoleForCrossAccountStateRead`. Threaded into the
 *                   `GetBucketLocation` call so the producer's bucket
 *                   policy can authorize the read against the assumed
 *                   principal (not the consumer's default credentials).
 *
 * @returns `{ bucket, region }` — the producer's canonical state bucket
 *          name and its actual region.
 */
export async function resolveCrossAccountStateBucket(
  accountId: string,
  credentials: {
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken?: string;
  }
): Promise<{ bucket: string; region: string }> {
  const bucket = `cdkd-state-${accountId}`;
  const region = await resolveBucketRegion(bucket, { credentials });
  return { bucket, region };
}
