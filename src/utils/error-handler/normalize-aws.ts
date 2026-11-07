import { isPasteableIdent } from '../display-safe.js';
import { safeStringify } from '../aws-failure-text.js';

/**
 * Context passed to {@link normalizeAwsError} so the rewritten message can
 * name the bucket/operation that produced the synthetic SDK error.
 */
export interface NormalizeAwsErrorContext {
  bucket?: string;
  operation?: string;
}

/**
 * The three spellings of {@link normalizeAwsError}'s bucket: `'name'` when it
 * is a plain identifier, a description otherwise (see that function's JSDoc).
 * An absent name keeps the `'<unknown bucket>'` literal cdkd writes itself.
 */
function bucketNames(bucket: string | undefined): {
  subject: string;
  object: string;
  quoted: string;
} {
  if (bucket === undefined) {
    return {
      subject: "Bucket '<unknown bucket>'",
      object: "bucket '<unknown bucket>'",
      quoted: "'<unknown bucket>'",
    };
  }
  if (isPasteableIdent(bucket)) {
    return { subject: `Bucket '${bucket}'`, object: `bucket '${bucket}'`, quoted: `'${bucket}'` };
  }
  const described = 'a bucket whose name is not a plain identifier';
  return {
    subject: 'A bucket whose name is not a plain identifier',
    object: described,
    quoted: described,
  };
}

/**
 * Convert AWS SDK v3's synthetic `Unknown` / `UnknownError` exception into
 * an actionable `Error` keyed off `$metadata.httpStatusCode`.
 *
 * Background — why this helper exists:
 *   AWS SDK v3 produces a synthetic `name: 'Unknown'`, `message:
 *   'UnknownError'` exception when the protocol parser hits a HEAD response
 *   with an empty body. The most common trigger is `HeadBucket` against a
 *   bucket in a different region than the client (S3 returns 301
 *   PermanentRedirect with `x-amz-bucket-region` set, but the redirect
 *   middleware doesn't recover from the empty body). Surfacing the literal
 *   string `UnknownError` to users is uninformative.
 *
 * Behavior:
 *   - Non-AWS-SDK errors (anything where `name` is not `Unknown` and
 *     `message` is not `UnknownError`) pass through unchanged.
 *   - AWS SDK Unknown errors are mapped by HTTP status:
 *     - 301 → `Bucket '<name>' is in a different region…` (auto-resolved
 *       elsewhere; if this surfaces, it's a bug worth reporting).
 *     - 403 → `Access denied to bucket '<name>'.`
 *     - 404 → `Bucket '<name>' does not exist.`
 *     - other / unknown → `S3 error during <operation> on '<bucket>' (HTTP
 *       <status>).`
 *
 * The bucket name comes from a CLI flag, the state bucket's config, or a
 * bootstrap marker's body, which anyone who can `s3:PutObject` on the state
 * bucket chooses. So it goes inside cdkd's own `'...'` only when it is a plain
 * identifier, and is described otherwise (go-to-k/cdkd#3950): a `'` in it
 * closed the quote, and the rest of a pasted sentence ran as shell. S3's
 * naming rules (letters, digits, `.`, `-`, `_` for a legacy name, starting
 * with a letter or digit) fit `isPasteableIdent`, so a real name reads as
 * before.
 *
 * Every REWRITTEN arm chains the original SDK error as the new error's
 * `cause` (go-to-k/cdkd#2075). The rewrite replaces only the MESSAGE; the
 * classifiers (`isTransientServerError` / `isThrottlingError` /
 * `isMarkedNonRetryable`) and `extractDeploymentEventError` read the
 * `$metadata` / marker / request id off the original, by walking `.cause`.
 * Without the chain an `Unknown` HTTP 503 read as non-retryable and lost its
 * request id. `scripts/check-provider-error-cause.ts` accepts this function as
 * a CAUSE COMPOSER on that basis, and
 * `tests/unit/scripts/cause-composers-classify.test.ts` is what proves it.
 */
export function normalizeAwsError(err: unknown, context: NormalizeAwsErrorContext = {}): Error {
  if (!(err instanceof Error)) {
    // Chained too: the error-cause critic counts `normalizeAwsError(err)` as
    // threading `err`, so no arm may drop it (go-to-k/cdkd#2075).
    return new Error(safeStringify(err), { cause: err });
  }

  // Detect the AWS SDK v3 "Unknown" synthetic exception. Other errors pass
  // through unchanged so we don't accidentally rewrite a legitimate AWS
  // error message.
  const isUnknown = err.name === 'Unknown' || err.message === 'UnknownError';
  if (!isUnknown) return err;

  const meta = (err as { $metadata?: { httpStatusCode?: number } }).$metadata;
  const status = meta?.httpStatusCode;
  const bucket = bucketNames(context.bucket);
  const operation = context.operation ?? 'operation';

  switch (status) {
    case 301: {
      // Try to surface the bucket's actual region from the response header
      // when the SDK exposes it. Header keys are lowercased by the SDK.
      const responseHeaders = (err as { $response?: { headers?: Record<string, string> } })
        .$response?.headers;
      const region =
        responseHeaders?.['x-amz-bucket-region'] ?? responseHeaders?.['X-Amz-Bucket-Region'];
      const where = region ? ` (in ${region})` : '';
      return new Error(
        `${bucket.subject}${where} is in a different region than the client. ` +
          `cdkd resolves this automatically; if you see this message, please report it.`,
        { cause: err }
      );
    }
    case 403:
      return new Error(`Access denied to ${bucket.object}. Verify credentials and bucket policy.`, {
        cause: err,
      });
    case 404:
      return new Error(`${bucket.subject} does not exist.`, { cause: err });
    default: {
      const statusStr = status !== undefined ? `HTTP ${status}` : 'unknown HTTP status';
      return new Error(
        `S3 error during ${operation} on ${bucket.quoted} (${statusStr}). ` +
          `See CloudTrail for details.`,
        { cause: err }
      );
    }
  }
}
