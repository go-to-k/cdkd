import { GetBucketLocationCommand, S3Client } from '@aws-sdk/client-s3';

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
 * Why a region-agnostic client (us-east-1):
 *   `GetBucketLocation` works against the global S3 endpoint regardless of
 *   the bucket's actual region, so we don't need to know the answer to ask
 *   the question.
 *
 * The result is cached per bucket name for the process lifetime — bucket
 * regions never move, so the cache never needs invalidation.
 *
 * @returns The bucket's region (e.g. `us-west-2`). An empty `LocationConstraint`
 *   in the response means `us-east-1` (S3 quirk). On any error, returns
 *   `opts.fallbackRegion` if provided, else `us-east-1`.
 */
export async function resolveBucketRegion(
  bucketName: string,
  opts: ResolveBucketRegionOptions = {}
): Promise<string> {
  const cached = cache.get(bucketName);
  if (cached) return cached;

  const promise = (async (): Promise<string> => {
    const client = new S3Client({
      region: 'us-east-1',
      ...(opts.profile && { profile: opts.profile }),
      ...(opts.credentials && { credentials: opts.credentials }),
    });
    try {
      const response = await client.send(new GetBucketLocationCommand({ Bucket: bucketName }));
      // Empty / null `LocationConstraint` is S3's way of saying us-east-1.
      return response.LocationConstraint || 'us-east-1';
    } catch {
      // The resolver never throws: cdkd would rather surface the actionable
      // downstream error (HeadBucket → `normalizeAwsError`) than mask it
      // behind a noisy GetBucketLocation failure.
      return opts.fallbackRegion ?? 'us-east-1';
    } finally {
      client.destroy();
    }
  })();

  cache.set(bucketName, promise);
  return promise;
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
