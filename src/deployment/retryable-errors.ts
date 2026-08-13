/**
 * The **IAM-propagation** subset of {@link RETRYABLE_ERROR_MESSAGE_PATTERNS}:
 * an AWS service rejecting a call because a just-created IAM entity (role,
 * trust policy, inline policy, instance profile, principal) has not propagated
 * to that service's authorization layer yet.
 *
 * Kept as its own array — and composed back into the full transient table
 * below — so there is exactly ONE list per pattern (no parallel classifier to
 * drift). It exists because this class has a materially different RECOVERY
 * SHAPE from the other transient errors: it resolves in single-digit seconds,
 * so `withRetry` polls it on a dense sub-second schedule instead of the
 * generic 1s/2s/4s/8s exponential backoff (which is right for throttling and
 * for long resource-state transitions, and wrong here — see
 * {@link file://../deployment/retry.ts}).
 *
 * When adding a new pattern: put it here if the fix is "wait a moment and ask
 * IAM again", and in `OTHER_TRANSIENT_ERROR_MESSAGE_PATTERNS` otherwise. A
 * misfiled entry only changes the retry CADENCE, never whether the error is
 * retryable at all.
 */
export const IAM_PROPAGATION_ERROR_MESSAGE_PATTERNS: readonly string[] = [
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
  // SECOND wording of the SAME Glue propagation error, seen 2026-08-09 on the
  // same fixture once the crawler role gained an extra inline policy:
  // "Service is unable to assume the role arn:aws:iam::...:role/... to access
  // null. Please verify the role's TrustPolicy." The `provided role` anchor
  // above does not match it (`the role <arn>`), so the deploy failed outright
  // instead of retrying. Same class, same bounded retries. NOTE this entry
  // deliberately drops the service-name anchor the Firehose comment argues for
  // — AWS emits it with no service prefix — so a permanently mis-configured
  // role burns the bounded retries (~48s) before surfacing. Accepted: the
  // phrasing is specific enough that a non-propagation match is unlikely, and
  // the alternative is failing a legitimate deploy outright.
  'is unable to assume the role',
  // THIRD wording of the same race, and the one that survives once the crawler
  // is correctly ordered after the role + its policy: Glue assumes the fresh
  // role and the resulting session's token is not valid yet, surfacing as
  // "The security token included in the request is invalid. (Service:
  // AmazonDynamoDBv2; ... Error Code: UnrecognizedClientException)".
  //
  // The `(Service:` suffix is the load-bearing part of this anchor, not
  // decoration. That trailer is the Java SDK's wrapped-error format, so it
  // appears ONLY when the message was produced by an AWS SERVICE acting on our
  // behalf. cdkd's OWN expired-credential failure comes from the JS SDK and
  // carries the bare sentence with no trailer — so an expired SSO session still
  // fails fast instead of burning the retry budget, which a bare
  // 'security token included in the request is invalid' pattern would break.
  'security token included in the request is invalid. (Service:',
  'role defined for the function',
  'not authorized to perform',
  'execution role',
  'trust policy',
  'Role validation failed',
  'does not have required permissions',
  'Trusted Entity',
  // IAM principal not yet propagated to S3 bucket policy
  'Invalid principal in policy',
  // CloudTrail CreateTrail validates that the CloudTrail service can assume
  // the CloudWatch Logs delivery role at create time. cdkd's fast SDK path
  // issues the create ~1s after the role's own CREATE, before IAM propagates
  // the trust policy to CloudTrail's assume layer, and AWS rejects it with
  // "Access denied. Verify in IAM that the role has adequate trust
  // relationships." CloudFormation never hits this — its deployment latency
  // lets IAM settle, which is exactly why the live CFn A/B for issue #1160
  // passed with this same trust policy while the cdkd fixture failed on the
  // first try. Anchored on the CloudTrail-specific "Verify in IAM that the
  // role has adequate trust relationships" sentence rather than the bare
  // "Access denied" prefix, so an actually-misconfigured role only burns the
  // bounded retries (~48s) before surfacing and no unrelated authorization
  // failure false-positives into the retry loop. Surfaced by
  // tests/integration/cloudtrail-trail.
  'Verify in IAM that the role has adequate trust relationships',
  // IAM-to-IAM eventual consistency: CreateAccessKey (and sibling per-user
  // writes) issued ~1s after the same deploy's CreateUser can race IAM's own
  // propagation and reject with "NoSuchEntity: The user with name X cannot be
  // found." — a phrasing no existing pattern matches ('does not exist' does
  // not cover "cannot be found"). CloudFormation absorbs this via its
  // deployment latency; cdkd retries. Anchored on the full IAM user phrasing
  // so a genuinely typo'd user name only burns the bounded retries before
  // surfacing, and unrelated "cannot be found" errors from other services do
  // not false-positive. Delete paths are unaffected (their
  // NoSuchEntityException short-circuits to idempotent success before any
  // retry classification). Surfaced by review of the AWS::IAM::AccessKey
  // provider (issue #1323), whose canonical fixture creates User + AccessKey
  // in one stack.
  'The user with name',
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
  // CodeDeploy DeploymentGroup: the Cloud Control CreateResource references a
  // same-stack service IAM role, but cdkd's fast path issues the create before
  // IAM finishes propagating the just-created role's trust policy, so AWS
  // rejects it with "AWS CodeDeploy does not have the permissions required to
  // assume the role arn:..." (Status Code: 400, SDK Attempt Count: 1 — the CC
  // handler treats it as terminal instead of retrying internally). The
  // existing 'does not have required permissions' pattern does NOT match this
  // phrasing (different word order: "the permissions required"). Anchored on
  // "permissions required to assume the role" so a genuine, permanent trust-
  // policy misconfiguration only burns the bounded retries before surfacing.
  // CloudFormation tolerates this via deployment latency; cdkd retries.
  // Surfaced by a bug-hunt sweep deploying a canonical LambdaDeploymentGroup
  // (Lambda + Alias + CodeDeploy canary); pinned by
  // tests/integration/codedeploy-lambda-deployment-group.
  'permissions required to assume the role',
  // Step Functions CreateStateMachine / UpdateStateMachine validates that the
  // states.amazonaws.com service principal can assume the same-stack IAM role
  // at create time. cdkd's fast SDK path issues the create only ~1s after the
  // role's CREATE, before IAM finishes propagating the trust policy to Step
  // Functions' assume layer, so AWS rejects it with "Neither the global
  // service principal states.amazonaws.com, nor the regional one is
  // authorized to assume the provided role." None of the existing patterns
  // match this phrasing ('not authorized to perform' is a different sentence;
  // 'is unable to assume provided role' is Glue's wording). Anchored on the
  // SFN-specific "authorized to assume the provided role" tail so a genuine,
  // permanent trust-policy misconfiguration only burns the bounded retries
  // before surfacing. CloudFormation tolerates this via deployment latency;
  // cdkd retries. Surfaced by a bug-hunt sweep deploying a canonical Express
  // state machine with LoggingConfiguration (StateMachine + fresh Role +
  // DefaultPolicy); pinned by tests/integration/stepfunctions-logging.
  'authorized to assume the provided role',
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
  // EMR RunJobFlow: cdkd's fast SDK path creates the
  // AWS::IAM::InstanceProfile (the cluster's JobFlowRole) only ~1s before
  // RunJobFlow references it, but the instance profile takes a few seconds to
  // propagate to EMR's validation layer, so EMR rejects the create with
  // `Invalid InstanceProfile: <name>.` (note the ONE-WORD "InstanceProfile"
  // and no "IAM" — the EC2 pattern above does NOT match this phrasing).
  // Anchored on "Invalid InstanceProfile" so a genuinely typo'd / deleted
  // profile only burns the bounded retries before surfacing. CloudFormation
  // tolerates this via deployment latency; cdkd retries. Surfaced by
  // tests/integration/emr-cluster (fresh EMR default-role instance profile).
  'Invalid InstanceProfile',
  // EMR RunJobFlow / AddInstanceGroups / AddInstanceFleet: the SAME
  // just-created-instance-profile propagation race as `Invalid InstanceProfile`
  // above, but EMR surfaces it with a DIFFERENT sentence when the profile
  // exists yet its role membership has not propagated to EMR's authorization
  // layer: `Failed to authorize instance profile <arn>.` (seen on the
  // emr-instance-configs integ's fresh cluster create — the EC2 role +
  // instance profile were created ~1s before RunJobFlow). Anchored on the
  // full "Failed to authorize instance profile" phrasing so a genuinely
  // mis-scoped profile only burns the bounded retries before surfacing.
  'Failed to authorize instance profile',
  // SNS CreateTopic / SetTopicAttributes with a per-protocol
  // DeliveryStatusLogging feedback role: cdkd's fast SDK path creates the
  // AWS::IAM::Role only ~1s before the topic references it as
  // `<Protocol>SuccessFeedbackRoleArn` / `<Protocol>FailureFeedbackRoleArn`,
  // and SNS rejects the not-yet-propagated role with `Invalid parameter:
  // LambdaSuccessFeedbackRoleArn: <arn> is not a valid role to allow SNS to
  // write to Cloudwatch Logs`. The wording is about permissions, but the
  // check passes for the SAME policy-less role a few seconds later
  // (live-probed 2026-08-10: a fresh sns.amazonaws.com-trusted role with NO
  // permission policy is accepted ~8s after creation), so this is the
  // propagation class, not a genuine permission error. Anchored on the SNS
  // sentence so a genuinely wrong ARN only burns the bounded retries before
  // surfacing. Surfaced by tests/integration/sns-sqs-event (fresh feedback
  // role + delivery-status topic in one stack, issue #1160 sns batch).
  'is not a valid role to allow SNS',
];

/**
 * The NON-IAM-propagation half of {@link RETRYABLE_ERROR_MESSAGE_PATTERNS}:
 * transient failures whose recovery window is either long (SQS's 60s same-name
 * cooldown, a resource still leaving a Pending/Creating state) or genuinely
 * load-related (throttling), where hammering AWS with dense retries is harmful
 * and exponential backoff is the correct shape.
 */
const OTHER_TRANSIENT_ERROR_MESSAGE_PATTERNS: readonly string[] = [
  // Freshly-created resource still leaving its Pending/Creating state
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
  // S3 bucket creation/deletion still in progress
  'conflicting conditional operation',
  // Secrets Manager: ForceDeleteWithoutRecovery may take a moment to propagate
  'scheduled for deletion',
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

  // Route 53: while a hosted zone's Accelerated Recovery (Application
  // Recovery Controller) feature is transitioning (ENABLING / DISABLING /
  // *_HOSTED_ZONE_LOCKED), Route 53 rejects EVERY mutation on the zone —
  // ChangeResourceRecordSets and DeleteHostedZone both fail with
  // "HostedZone <id> is marked disabled for mutation". The transition is an
  // async AWS-side state change that settles on its own (typically minutes),
  // so a retry recovers; a re-run also recovers. The Route53 provider's
  // delete path additionally waits for the transition to settle before
  // retrying (issue #1467) — this pattern is the generic net for the
  // create/update paths and for windows shorter than the retry budget.
  'is marked disabled for mutation',

  // Redshift keeps a cluster busy for a tail AFTER an operation on it
  // reports done — notably the final snapshot cdkd takes for
  // `DeletionPolicy: Snapshot` (issue #1353): the snapshot reaches
  // `available` and `DescribeClusters` already reports `ClusterStatus:
  // available`, yet the immediately-following delete 400s with this
  // message. There is no status field that exposes the in-flight
  // operation, so a retry is the only way to ride it out (observed live
  // 2026-08-03 on the deletion-policy-snapshot-heavy fixture, where the
  // snapshot succeeded and only the delete failed).
  'There is an operation running on the Cluster',
  // API Gateway v2 serializes mutations per API, and cdkd deploys a DAG with
  // `--concurrency` > 1 by design — so sibling Routes / Integrations / Stages
  // of ONE ApiId are created in parallel and collide on the service side. The
  // message asks for exactly this treatment ("Please try again later") and the
  // contention is load-shaped, so it belongs on the exponential half rather
  // than the dense IAM-propagation one. Observed live twice in a row
  // (2026-08-11, us-east-1) on the `apigatewayv2-update-removal` fixture once
  // it grew to three integrations across two APIs — the failure moved between
  // resources on each run, which is the signature of contention rather than of
  // a bad request. Issue #1607.
  'Unable to complete operation due to concurrent modification',
];

/**
 * Patterns that mark an AWS error as a transient/retryable failure.
 * Each entry is a substring match against the error message; all of these
 * are situations where the same call typically succeeds after a short delay
 * because of eventual consistency or just-created-dependency propagation.
 *
 * Composed from the two halves above so retryability has ONE source of truth
 * while `withRetry` can still pick a per-class backoff cadence.
 */
export const RETRYABLE_ERROR_MESSAGE_PATTERNS: readonly string[] = [
  ...IAM_PROPAGATION_ERROR_MESSAGE_PATTERNS,
  ...OTHER_TRANSIENT_ERROR_MESSAGE_PATTERNS,
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
 * Marker for an error cdkd raised as a DELIBERATE refusal rather than as a
 * relayed AWS failure (issue [#1778](https://github.com/go-to-k/cdkd/issues/1778)).
 *
 * Every classifier below is SUBSTRING-based, which is the right shape for
 * relaying a vendor's message and the wrong one for cdkd's own prose: a
 * refusal message is assembled from values cdkd does not control — a provider
 * `reason`, a state-borne physicalId, a template logical id — and any of them
 * can happen to contain a retryable pattern. Measured: a resource named
 * `MyDependencyViolationSub` puts `DependencyViolation` in the message, so a
 * deterministic refusal was classified transient and burned the whole backoff
 * schedule before failing exactly as it would have immediately. Keeping the
 * offending values OUT of the message narrows that surface but cannot close
 * it, because a message with no identifiers at all is not diagnosable.
 *
 * A marker inverts the burden: the raiser STATES that the error is terminal,
 * so no wording can make it retryable. Deliberately a `Symbol.for` key —
 * global-registry symbols survive a duplicated module instance (dual
 * bundling), where a module-local symbol would silently stop matching — and
 * non-enumerable, so it cannot leak into a serialized error payload.
 */
const NON_RETRYABLE_MARKER = Symbol.for('cdkd.nonRetryable');

/**
 * Mark a cdkd-authored refusal as terminal and return it, for
 * `throw markNonRetryable(new ProvisioningError(...))`.
 *
 * Reach for it when the error means "this cannot succeed on a retry" as a
 * matter of cdkd's own logic — NOT for a relayed AWS failure, whose
 * retryability is the classifiers' business.
 *
 * The known live instance this JSDoc used to flag as uncovered —
 * `ResourceUpdateNotSupportedError` (`src/utils/error-handler.ts`), which
 * interpolates the logical id and is thrown by ~20 providers from inside the
 * retried `update()` in `deploy-engine.ts` — IS covered as of issue
 * [#1838](https://github.com/go-to-k/cdkd/issues/1838): it marks itself in its
 * CONSTRUCTOR, so every construction is terminal and no provider throw site
 * has to remember. That is the shape to prefer for a whole error CLASS that is
 * always a refusal; mark at the `throw` (as the SNS abort below does) only
 * when the class is retryable in general and this one raising of it is not.
 */
export function markNonRetryable<E extends Error>(error: E): E {
  // `E extends Error`, not `object`: a class or a shared prototype is an
  // object too, and the reader below is a PROTOTYPE-CHAIN lookup, so marking
  // one would silently mark every instance of it as terminal.
  //
  // A non-extensible (frozen / sealed) error is returned UNMARKED rather than
  // allowed to throw. Callers use this inline — `throw markNonRetryable(...)`
  // — so a `TypeError` raised here would REPLACE the refusal the caller meant
  // to raise, turning a precise message into an unrelated crash. Losing the
  // marker degrades to the pre-marker behavior (the message heuristics still
  // apply); losing the refusal loses the diagnosis.
  if (!Object.isExtensible(error)) return error;
  Object.defineProperty(error, NON_RETRYABLE_MARKER, {
    value: true,
    enumerable: false,
    configurable: true,
    writable: false,
  });
  return error;
}

/**
 * True when the error, or anything in its bounded `.cause` chain, was marked
 * by {@link markNonRetryable}.
 *
 * The chain walk mirrors {@link isThrottlingError}'s: cdkd wraps errors, so a
 * marked refusal can end up one or more links deep, and a marker that stopped
 * counting after a single wrap would be a fence that quietly falls open.
 *
 * That reach is DIRECTIONAL, and the upward direction is a hazard worth
 * stating. Downward — a marked refusal wrapped by an outer error — is the
 * intended case and stays terminal. UPWARD is the inverse: wrapping a marked
 * refusal as the `cause` of a genuinely RETRYABLE outer error
 * (`new Error(msg, { cause: markedRefusal })`) makes the outer error terminal
 * too, because this walk finds the marker on the cause. That shape IS
 * constructed today, on purpose: `deploy-engine.ts`'s `--strict-getatt`
 * output re-wrap threads `{ cause: error }` precisely so a marked resolver
 * refusal survives the wrap (issue #1874) — the wrapper inlines the refusal's
 * text, including template-controlled identifiers, so without the cause the
 * marker is dropped and the classifier can read the copied text as transient.
 * The hazard is therefore not "can this be built" but "is the OUTER error
 * genuinely retryable": wrapping a marked refusal as the cause of a
 * transient error would stop retrying something that should retry. Thread the
 * cause when the wrapper is as terminal as its cause (the case above); strip
 * or re-raise it when the wrapper is retryable in its own right. This applies
 * to every `markNonRetryable` call site: five in
 * `intrinsic-function-resolver.ts`, one in `sns-subscription-provider.ts`, and
 * `ResourceUpdateNotSupportedError`'s constructor in
 * `src/utils/error-handler.ts`. Do not restate that as a bare TOTAL — the
 * first version of this sentence said "six", which was the count of
 * `IntrinsicResolutionRefusalError` THROW sites (five of them marked)
 * transplanted from the other file's enumeration, and a stale count reads as
 * complete exactly the way {@link file://../utils/error-handler.ts}'s own
 * enumeration warning describes.
 */
export function isMarkedNonRetryable(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current != null; depth++) {
    if (typeof current === 'object' || typeof current === 'function') {
      if ((current as Record<symbol, unknown>)[NON_RETRYABLE_MARKER] === true) return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * Walk the error + its `.cause` chain (bounded) looking for a rate-limit
 * signal — either an AWS SDK v3 throttling error `name`
 * ({@link THROTTLING_ERROR_NAMES}) or a retryable HTTP status
 * ({@link RETRYABLE_HTTP_STATUS_CODES}) on `$metadata`.
 *
 * cdkd wraps the original AWS error in a `ProvisioningError`, so the signal is
 * typically one cause-link deep; the bounded walk also tolerates SDK errors
 * that nest a `$response`/cause without exploding on a cyclic chain.
 *
 * BOTH signals are checked at EVERY depth. An earlier version checked the name
 * to depth 5 but the HTTP status only at depths 0 and 1, so a 429 nested two
 * links deep was missed.
 */
export function isThrottlingError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current != null; depth++) {
    const name = (current as { name?: unknown }).name;
    if (typeof name === 'string' && THROTTLING_ERROR_NAMES.has(name)) return true;

    const status = (current as { $metadata?: { httpStatusCode?: number } }).$metadata
      ?.httpStatusCode;
    if (status !== undefined && RETRYABLE_HTTP_STATUS_CODES.has(status)) return true;

    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * Determine whether an AWS error should be retried.
 *
 * Checks (in order):
 *   0. {@link isMarkedNonRetryable} — a cdkd-authored refusal is terminal by
 *      declaration, ahead of every message / name heuristic below. FIRST on
 *      purpose: the marker states the error cannot succeed on a retry, so
 *      nothing a later check reads out of the message can overturn it.
 *   1. Rate-limit signal on the error or any wrapped cause — throttling error
 *      `name` or retryable HTTP status (most AWS throttles are HTTP 400, not
 *      429, so the name check carries most of the weight). See
 *      {@link isThrottlingError}.
 *   2. Substring match against {@link RETRYABLE_ERROR_MESSAGE_PATTERNS}
 */
export function isRetryableTransientError(error: unknown, message: string): boolean {
  if (isMarkedNonRetryable(error)) return false;
  if (isThrottlingError(error)) return true;

  return RETRYABLE_ERROR_MESSAGE_PATTERNS.some((p) => message.includes(p));
}

/**
 * True when the message is a just-created-IAM-entity propagation rejection
 * ({@link IAM_PROPAGATION_ERROR_MESSAGE_PATTERNS}).
 *
 * This does NOT decide retryability — every pattern it matches is already in
 * {@link RETRYABLE_ERROR_MESSAGE_PATTERNS}. It only selects the retry CADENCE:
 * `withRetry` polls this class densely (sub-second initial delay, low cap)
 * because IAM propagation resolves in single-digit seconds, whereas the
 * generic exponential schedule is tuned for throttling and long resource-state
 * transitions.
 *
 * Deliberately message-only (no error-object inspection): the propagation
 * signal is always carried in the vendor's message text, and cdkd wraps the
 * original error in a `ProvisioningError` that preserves it.
 */
export function isIamPropagationError(message: string): boolean {
  return IAM_PROPAGATION_ERROR_MESSAGE_PATTERNS.some((p) => message.includes(p));
}

/**
 * Match the "already exists" name-collision signature raised when a create
 * targets a physical name still held by another resource (or by the same
 * name's not-yet-released tombstone after an async delete).
 *
 * Deliberately NOT part of {@link RETRYABLE_ERROR_MESSAGE_PATTERNS}: a name
 * collision is only worth retrying at the specific re-create sites that just
 * deleted the old holder (the deploy engine's --replace delete-first fallback
 * and the rollback executor's reverse-replacement) — everywhere else it is a
 * genuine conflict that must fail fast. Shared by those sites' collision
 * detection + retry filters so a signature extension lands in one place.
 *
 * The optional `s` is load-bearing, not defensive spelling (issue #1625):
 * Lambda's `CreateFunction` raises `ResourceConflictException: Function
 * already exist: <name>` — SINGULAR — so the `already exists` form missed it
 * entirely and NO Lambda function could take the collision path. The
 * consequence was not a cosmetic message: a property-driven replacement of a
 * Lambda (dropping `DurableConfig`, changing `TenancyConfig`) create-firsts
 * into its own still-live name, the raw `ResourceConflictException` escaped
 * instead of the actionable `NAMED_REPLACEMENT_COLLISION` error, and
 * `cdkd deploy --replace`'s delete-first fallback never fired — so the
 * replacement was unperformable by any flag. Verified against real AWS
 * (us-east-1, 2026-08-12) by creating one function name twice.
 *
 * Two fences keep the widened arm from crediting a NON-collision, which
 * matters because the sites that consult it react DESTRUCTIVELY (the
 * `--replace` delete-first fallback deletes the old resource):
 *  - `\b` after `exists?` rejects a participle ("already existed as a draft");
 *  - the lookbehind rejects a NEGATED or MODAL phrase — "the bucket does NOT
 *    already exist", "the destination bucket MUST already exist" — which the
 *    bare pattern matched. The modal form is the one that bites: a create
 *    rejected for a missing PREREQUISITE would be reported to the user as a
 *    name collision pointing at `--replace`, and following that advice
 *    deletes the live old resource before the re-create fails again for the
 *    same reason, leaving it absent from AWS with state still recording it.
 * The error-CODE arm stays exact (`AlreadyExists`): the singular
 * `AlreadyExist` is not an AWS code spelling, and loosening it would match
 * inside unrelated identifiers.
 *
 * Classification stays MESSAGE-based rather than moving to the exception
 * NAME, and that is load-bearing here rather than inherited: Lambda raises
 * `ResourceConflictException` for a function in a PENDING state too (see
 * `lambda-function-provider.ts`), so keying on the name would classify a
 * transient state conflict as a collision and delete a live function under
 * `--replace`.
 */
export function isNameCollisionError(message: string): boolean {
  return (
    /(?<!\b(?:must|not|should|may|cannot)\s)already exists?\b/i.test(message) ||
    message.includes('AlreadyExists')
  );
}

/**
 * Match the SQS same-name re-creation cooldown: after `DeleteQueue`, creating
 * a queue with the SAME name inside ~60s fails with
 * `AWS.SimpleQueueService.QueueDeletedRecently` ("You must wait 60 seconds
 * after deleting a queue before you can create another with the same name").
 *
 * The generic transient table above already carries 'wait 60 seconds' for
 * plain CREATEs (rapid destroy → redeploy loops), but the delete-then-re-create
 * sites (the deploy engine's --replace delete-first fallback and the rollback
 * executor's reverse-replacement) override the retry filter with
 * {@link isNameCollisionError}, which this signature does NOT match — so a
 * replacement revert used to fail fast mid-flight with the resource absent
 * from both AWS and state (issue #1206). Those sites now OR this matcher into
 * their retry filter, with a schedule long enough to cover the 60s window.
 *
 * Kept separate from {@link isNameCollisionError} on purpose: a cooldown at a
 * create-first site must NOT be treated as a collision (deleting the new
 * resource would not release the cooldown on the old name).
 */
export function isNameCooldownError(message: string): boolean {
  return message.includes('QueueDeletedRecently') || message.includes('wait 60 seconds');
}

/**
 * Retry filter for the delete-then-re-create sites: the old name holder was
 * just deleted, so both the late name release ("already exists" from an async
 * delete) and the SQS 60s name cooldown are worth waiting out. Pair with a
 * schedule that covers the full cooldown window (maxRetries 8, delays
 * 2s/4s/8s then capped at 10s ≈ 64s total sleep).
 */
export function isRecreateRetryableError(message: string): boolean {
  return isNameCollisionError(message) || isNameCooldownError(message);
}
