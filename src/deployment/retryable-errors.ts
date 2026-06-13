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
