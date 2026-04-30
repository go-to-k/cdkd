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
