/**
 * Patterns that mark an AWS error as a transient/retryable failure.
 * Each entry is a substring match against the error message; all of these
 * are situations where the same call typically succeeds after a short delay
 * because of eventual consistency or just-created-dependency propagation.
 */
export const RETRYABLE_ERROR_MESSAGE_PATTERNS: readonly string[] = [
  // IAM propagation
  'cannot be assumed',
  'role defined for the function',
  'not authorized to perform',
  'execution role',
  'trust policy',
  'Role validation failed',
  'does not have required permissions',
  'Trusted Entity',
  'currently in the following state: Pending',
  // DELETE dependency ordering (parallel deletion race conditions)
  'has dependencies and cannot be deleted',
  "can't be deleted since it has",
  'DependencyViolation',
  // AWS eventual consistency (dependency just created but not yet visible)
  // e.g., RDS DBCluster referencing a just-created DBSubnetGroup
  'does not exist',
  // AppSync schema is being created asynchronously
  'Schema is currently being altered',
  // IAM principal not yet propagated to S3 bucket policy
  'Invalid principal in policy',
  // S3 bucket creation/deletion still in progress
  'conflicting conditional operation',
  // Secrets Manager: ForceDeleteWithoutRecovery may take a moment to propagate
  'scheduled for deletion',
  // DynamoDB Streams / Kinesis: IAM role not yet propagated
  'Cannot access stream',
  'Please ensure the role can perform',
  // KMS: IAM role not yet propagated for CreateGrant
  'KMS key is invalid for CreateGrant',
  // CloudWatch Logs SubscriptionFilter: Kinesis stream eventual consistency
  // or SubscriptionFilter role propagation. CW Logs probes the destination
  // by delivering a test message; if the stream is freshly ACTIVE or the
  // assumed role hasn't propagated, the probe fails with "Invalid request".
  'Could not deliver test message',
  // SQS: same-name queue can't be re-created until 60s after a delete.
  // Hits when a stack is destroyed and re-deployed in quick succession
  // (a common dev / iteration loop). Retry recovers within ~60s instead
  // of failing the whole deploy.
  'wait 60 seconds',
];

/**
 * HTTP status codes that always indicate a transient failure worth retrying.
 * 429 = Too Many Requests (throttle), 503 = Service Unavailable.
 */
export const RETRYABLE_HTTP_STATUS_CODES: ReadonlySet<number> = new Set([429, 503]);

/**
 * Determine whether an AWS error should be retried.
 *
 * Checks (in order):
 *   1. HTTP status code on the error itself (`$metadata.httpStatusCode`)
 *   2. HTTP status code on a wrapped cause (`cause.$metadata.httpStatusCode`)
 *   3. Substring match against {@link RETRYABLE_ERROR_MESSAGE_PATTERNS}
 */
export function isRetryableTransientError(error: unknown, message: string): boolean {
  const metadata = (error as { $metadata?: { httpStatusCode?: number } }).$metadata;
  const statusCode = metadata?.httpStatusCode;
  if (statusCode !== undefined && RETRYABLE_HTTP_STATUS_CODES.has(statusCode)) return true;

  const cause = (error as { cause?: { $metadata?: { httpStatusCode?: number } } }).cause;
  const causeStatus = cause?.$metadata?.httpStatusCode;
  if (causeStatus !== undefined && RETRYABLE_HTTP_STATUS_CODES.has(causeStatus)) return true;

  return RETRYABLE_ERROR_MESSAGE_PATTERNS.some((p) => message.includes(p));
}
