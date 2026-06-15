/**
 * Patterns that mark an AWS error as a transient/retryable failure.
 * Each entry is a substring match against the error message; all of these
 * are situations where the same call typically succeeds after a short delay
 * because of eventual consistency or just-created-dependency propagation.
 */
export const RETRYABLE_ERROR_MESSAGE_PATTERNS: readonly string[] = [
  // IAM propagation
  'cannot be assumed',
  // Firehose-specific phrasing for the same eventual-consistency case:
  // role exists but Firehose's auth layer hasn't propagated the trust
  // policy yet. Surfaced by tests/integration/log-pipeline against a
  // fresh deploy where FirehoseDeliveryRole was just CREATE'd. The
  // pattern is anchored on the service name (`Firehose is unable to
  // assume`) so a non-transient "user X is unable to assume role Y
  // because of explicit deny" from a different service won't false-
  // positive into the retry loop.
  'Firehose is unable to assume role',
  // Glue Crawler / Job / Trigger create validates that the Glue service can
  // assume the same-stack IAM role at create time. cdkd's fast SDK path issues
  // the Crawler create only ~1s after the role's CREATE, before IAM finishes
  // propagating the role's trust policy to Glue's assume layer, so AWS rejects
  // it with "Service is unable to assume provided role. Please verify role's
  // TrustPolicy". CloudFormation never hits this (its deployment latency lets
  // IAM settle) but cdkd does. Anchored on the Glue-specific "is unable to
  // assume provided role" wording (the existing 'trust policy' pattern is
  // lower-case + spaced and does NOT match Glue's "TrustPolicy"; 'cannot be
  // assumed' is a different service's phrasing) so a genuinely mis-configured /
  // deleted role only burns the bounded retries before surfacing. Surfaced by
  // tests/integration/glue-update-hardening.
  'is unable to assume provided role',
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
  // SNS TopicPolicy: SetTopicAttributes validates every principal ARN in the
  // policy document. When the document names a same-stack, just-created IAM
  // role as `Principal.AWS`, cdkd's fast SDK path issues the policy PUT before
  // IAM finishes propagating the new role, and SNS rejects it with
  // "Invalid parameter: Policy Error: PrincipalNotFound". Anchored on the
  // SNS-specific "Policy Error: PrincipalNotFound" wording so a genuinely
  // malformed/non-existent principal (a typo'd ARN, a deleted role) only burns
  // the bounded retries before surfacing — it won't false-positive other
  // errors. CloudFormation tolerates this via deployment latency; cdkd retries.
  // See issue #839.
  'Policy Error: PrincipalNotFound',
  // SQS QueuePolicy: SetQueueAttributes validates the same fresh-principal
  // document as the SNS case above, but SQS surfaces the propagation race with
  // the less specific "Invalid value for the parameter Policy." (the SQS
  // QueuePolicy in the iam-propagation-stress fixture is byte-for-byte the same
  // shape as the SNS TopicPolicy that fails with PrincipalNotFound, so the SQS
  // rejection is the SAME just-created-role propagation race, not a malformed
  // document). Anchored on the full SQS phrase so an unrelated SQS parameter
  // validation error does not get caught — a permanently malformed policy still
  // fails after the bounded retries. See issue #839.
  'Invalid value for the parameter Policy',
  // RDS Enhanced Monitoring: CreateDBInstance / CreateDBCluster references a
  // same-stack monitoring IAM role, but cdkd's fast SDK path issues the create
  // before IAM finishes propagating the just-created role for the RDS
  // monitoring service to assume. AWS rejects with "IAM role ARN value is
  // invalid or does not include the required permissions for:
  // ENHANCED_MONITORING". Anchored on ENHANCED_MONITORING so a genuine,
  // permanent monitoring-role misconfiguration only burns the bounded retries
  // before surfacing — it won't false-positive other features' permission
  // errors. CloudFormation tolerates this via deployment latency; cdkd retries.
  // See issue #794.
  'required permissions for: ENHANCED_MONITORING',
  // ECS CapacityProvider (Managed Instances): the Cloud Control CreateResource
  // references a same-stack infrastructure IAM role, but cdkd's fast SDK path
  // issues the create before IAM finishes propagating the just-created role
  // for ECS to assume. The CC API handler classifies it as a terminal
  // InvalidRequest ("Caught ServiceAccessDeniedException for
  // ECSInfrastructureRole[arn:...]", SDK Attempt Count: 1) instead of
  // retrying internally. Anchored on the handler's "Caught
  // ServiceAccessDeniedException" wording so a genuine, permanent role
  // misconfiguration only burns the bounded retries before surfacing.
  // Any CC-provisioned type that validates a same-stack role at create time
  // can hit this. CloudFormation tolerates it via deployment latency; cdkd
  // retries. See issue #805.
  'Caught ServiceAccessDeniedException',
  // S3 bucket creation/deletion still in progress
  'conflicting conditional operation',
  // Secrets Manager: ForceDeleteWithoutRecovery may take a moment to propagate
  'scheduled for deletion',
  // DynamoDB Streams / Kinesis: IAM role not yet propagated
  'Cannot access stream',
  'Please ensure the role can perform',
  // KMS: IAM role not yet propagated for CreateGrant
  'KMS key is invalid for CreateGrant',
  // KMS CreateKey / PutKeyPolicy: the key policy document names a same-stack,
  // just-created IAM role as a principal, but cdkd's fast SDK path issues the
  // CreateKey before IAM finishes propagating the new role, so KMS rejects it
  // with MalformedPolicyDocumentException "Policy contains a statement with one
  // or more invalid principals". This is a DIFFERENT consumer than the SNS/SQS
  // resource-policy PUTs covered above (#839) — KMS validates every principal
  // in the key policy at create time. Anchored on the full KMS/IAM policy-
  // document phrase so a genuinely malformed key policy (a typo'd / deleted
  // principal) only burns the bounded retries before surfacing — it won't
  // false-positive other KMS errors. CloudFormation tolerates this via
  // deployment latency; cdkd retries. Surfaced by tests/integration/
  // propagation-races-2 (the KMS key-policy fresh-principal race edge).
  'Policy contains a statement with one or more invalid principals',
  // EC2 RunInstances / AssociateIamInstanceProfile: cdkd's fast SDK path
  // creates the AWS::IAM::InstanceProfile only ~1s before launching the
  // instance that references it, but the instance profile + its role
  // membership takes a few seconds to propagate to EC2's view. When EC2 does
  // raise (rather than silently launching without the profile — which
  // EC2Provider.createInstance handles by post-launch association), it surfaces
  // as `Invalid IAM Instance Profile name '<name>'` /
  // `Invalid IAM Instance Profile ARN`. Anchored on the "Invalid IAM Instance
  // Profile" wording so a genuinely typo'd / deleted profile only burns the
  // bounded retries before surfacing. CloudFormation tolerates this via
  // deployment latency; cdkd retries. Surfaced by tests/integration/
  // propagation-races-2 (the fresh-instance-profile EC2 launch race edge).
  'Invalid IAM Instance Profile',
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
  // Lambda: AddPermission serializes resource-policy updates server-side.
  // When multiple Lambda::Permission resources for the same function
  // dispatch in parallel, AWS rejects the losers with
  // `The function could not be updated due to a concurrent update
  // operation`. The conflicting writer typically finishes within
  // milliseconds, so a retry recovers.
  'concurrent update operation',
  // Lambda EventSourceMapping: on destroy, DeleteEventSourceMapping can
  // throw `ResourceInUseException` ("Cannot delete the event source
  // mapping because it is in use") while the ESM is briefly locked by its
  // own state transition (it is mid-UPDATE/DELETE, or its target function
  // is being torn down in the same destroy run). This is a transient
  // state-lifecycle lock that clears on its own within seconds-to-a-minute
  // — a manual `cdkd destroy` re-run deletes it cleanly. Match the message
  // substring so the retry fires on both destroy paths (deploy-engine's
  // delete loop and destroy-runner's). Confirmed by the multi-resource
  // real-AWS regression sweep (2026-06-02). Matched by message (not the
  // bare `ResourceInUseException` name) to stay specific to the "in use"
  // teardown lock and avoid retrying unrelated create-already-exists
  // conflicts that share the same exception name.
  'because it is in use',
  // Throttling backstop: many AWS services surface a rate-limit rejection
  // with the canonical "Rate exceeded" message (SSM PutParameter, STS,
  // CloudWatch, API Gateway, etc.) and an HTTP 400 (NOT 429), so the status-
  // code check below misses them. When cdkd dispatches a wide DAG at a high
  // `--concurrency`, the create burst can exceed a per-service rate limit and
  // AWS rejects the losers with `Rate exceeded. Ensure you have the high-
  // throughput setting enabled ...`. The AWS SDK's own retry layer (3 fast
  // attempts) is not enough to drain a large burst; cdkd's outer withRetry —
  // with its longer 1s/2s/4s/8s backoff — spreads the remaining creates out
  // until the rate window clears. "Rate exceeded" only ever means throttling,
  // so a permanent failure cannot false-positive into the retry loop. This is
  // a message-level backstop for the name-based throttle detection in
  // isThrottlingError() (the ProvisioningError wrap preserves the SDK error's
  // message string even when the original `.name` is one cause-link deeper).
  // Surfaced by tests/integration/throttle-wide-dag (80 SSM parameters at
  // --concurrency 40).
  'Rate exceeded',
];

/**
 * HTTP status codes that always indicate a transient failure worth retrying.
 * 429 = Too Many Requests (throttle), 503 = Service Unavailable.
 */
export const RETRYABLE_HTTP_STATUS_CODES: ReadonlySet<number> = new Set([429, 503]);

/**
 * AWS SDK v3 canonical throttling error names. Mirrors
 * `@aws-sdk/service-error-classification`'s `THROTTLING_ERROR_CODES` — any
 * error (or wrapped cause) whose `name` is one of these is a transient rate-
 * limit rejection worth retrying with backoff. Detecting by NAME is more
 * robust than by HTTP status because most AWS throttles surface as HTTP 400
 * (not 429) with the throttling signal carried only in the error code / name
 * (e.g. SSM `ThrottlingException` for the `Rate exceeded` message).
 */
export const THROTTLING_ERROR_NAMES: ReadonlySet<string> = new Set([
  'BandwidthLimitExceeded',
  'EC2ThrottledException',
  'LimitExceededException',
  'PriorRequestNotComplete',
  'ProvisionedThroughputExceededException',
  'RequestLimitExceeded',
  'RequestThrottled',
  'RequestThrottledException',
  'SlowDown',
  'ThrottledException',
  'Throttling',
  'ThrottlingException',
  'TooManyRequestsException',
  'TransactionInProgressException',
]);

/**
 * Walk the error + its `.cause` chain (bounded) looking for an AWS SDK v3
 * throttling error `name`. cdkd wraps the original AWS error in a
 * `ProvisioningError`, so the throttling signal is typically one cause-link
 * deep; the bounded walk also tolerates SDK errors that nest a `$response`/
 * cause without exploding on a cyclic chain.
 */
function isThrottlingError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current != null; depth++) {
    const name = (current as { name?: unknown }).name;
    if (typeof name === 'string' && THROTTLING_ERROR_NAMES.has(name)) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * Determine whether an AWS error should be retried.
 *
 * Checks (in order):
 *   1. HTTP status code on the error itself (`$metadata.httpStatusCode`)
 *   2. HTTP status code on a wrapped cause (`cause.$metadata.httpStatusCode`)
 *   3. Throttling error `name` on the error or any wrapped cause (most AWS
 *      throttles are HTTP 400, not 429 — see {@link THROTTLING_ERROR_NAMES})
 *   4. Substring match against {@link RETRYABLE_ERROR_MESSAGE_PATTERNS}
 */
export function isRetryableTransientError(error: unknown, message: string): boolean {
  const metadata = (error as { $metadata?: { httpStatusCode?: number } }).$metadata;
  const statusCode = metadata?.httpStatusCode;
  if (statusCode !== undefined && RETRYABLE_HTTP_STATUS_CODES.has(statusCode)) return true;

  const cause = (error as { cause?: { $metadata?: { httpStatusCode?: number } } }).cause;
  const causeStatus = cause?.$metadata?.httpStatusCode;
  if (causeStatus !== undefined && RETRYABLE_HTTP_STATUS_CODES.has(causeStatus)) return true;

  if (isThrottlingError(error)) return true;

  return RETRYABLE_ERROR_MESSAGE_PATTERNS.some((p) => message.includes(p));
}
