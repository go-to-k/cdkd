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
 * The NON-IAM-propagation, NON-name-cooldown third of
 * {@link RETRYABLE_ERROR_MESSAGE_PATTERNS}: transient failures whose recovery
 * window is either long (a resource still leaving a Pending/Creating state) or
 * genuinely load-related (throttling), where hammering AWS with dense retries
 * is harmful and exponential backoff is the correct shape.
 *
 * The name-cooldown spellings used to live here too (`wait 60 seconds`, S3's
 * `conflicting conditional operation`); they moved to
 * {@link NAME_COOLDOWN_ERROR_MESSAGE_PATTERNS} so the ordinary-create path and
 * the delete-then-re-create sites read ONE list instead of two that drifted
 * apart (issue [#2116](https://github.com/go-to-k/cdkd/issues/2116)).
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
  // Secrets Manager: ForceDeleteWithoutRecovery may take a moment to propagate
  'scheduled for deletion',
  // CloudWatch Logs SubscriptionFilter: Kinesis stream eventual consistency
  // or SubscriptionFilter role propagation. CW Logs probes the destination
  // by delivering a test message; if the stream is freshly ACTIVE or the
  // assumed role hasn't propagated, the probe fails with "Invalid request".
  'Could not deliver test message',
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
 * The **name-cooldown** third of {@link RETRYABLE_ERROR_MESSAGE_PATTERNS}:
 * an AWS service that holds a resource's NAME (or other unique identifier)
 * while an ASYNCHRONOUS delete of the previous holder is still in flight, so a
 * create of the same name inside that window is refused with a
 * service-specific message. The window always clears on its own — the delete
 * that opened it is already running — which is what makes every entry here
 * retryable rather than terminal, whichever call site hits it.
 *
 * Read by BOTH consumers, which is the whole point of the list existing
 * (issue [#2116](https://github.com/go-to-k/cdkd/issues/2116)):
 *
 *  - {@link isNameCooldownError}, and through it
 *    {@link isRecreateRetryableError}, the retry filter at the
 *    delete-then-re-create sites (the deploy engine's `--replace` delete-first
 *    fallback, the recreate-via-* path, the rollback executor's
 *    delete-new-first) — the sites where cdkd itself just deleted the name
 *    holder;
 *  - {@link RETRYABLE_ERROR_MESSAGE_PATTERNS}, i.e. the ORDINARY create path,
 *    where a fresh `cdkd deploy` process has no idea a prior `cdkd destroy`
 *    deleted anything.
 *
 * The second consumer is the reachable one and was the measured failure in
 * #2116: destroy-then-redeploy is a routine dev loop, CloudFormation absorbs
 * the window and converges, and cdkd claims template compatibility with
 * CloudFormation — so failing the whole deploy (26 resources created and
 * rolled back, on the run that filed the issue) over a condition that clears
 * in seconds is a parity defect. Before this list, the two consumers held
 * DIFFERENT spellings of the same SQS error: the wire message
 * (`wait 60 seconds`) was in the generic table so an ordinary create retried
 * it, while the error CODE (`QueueDeletedRecently`) was not — so whether the
 * identical AWS condition was survivable depended on which spelling the SDK
 * happened to surface.
 *
 * Bounded, not unbounded: since #2116 the ordinary-create path rides
 * `withRetry`'s NAME-COOLDOWN grid (8 retries, 2s/4s/8s then capped at 10s ≈
 * 64s of sleep — `NAME_COOLDOWN_INITIAL_DELAY_MS` in `./retry.ts`), which is
 * the same budget the re-create sites already carried. It is deliberately NOT
 * the generic 47s schedule this path used to inherit: SQS's own sentence names
 * a 60-second window, so 47s would not converge, it would merely fail 47s
 * later. A name that is NOT in fact being
 * released — a genuine, permanent collision — is a different signature
 * ({@link isNameCollisionError}) and is deliberately NOT here, so it still
 * fails fast into the actionable `--replace` refusal instead of burning a
 * budget it cannot survive.
 *
 * **What must NOT go in this list.** Every entry below is specific to a delete
 * that is ALREADY in flight and clears within a budget. Three candidates the
 * sibling sweep turned up are recorded here as deliberate EXCLUSIONS rather
 * than left unmentioned, because "absent" and "considered and rejected" are
 * indistinguishable to the next person doing this sweep:
 *
 *  - **ELBv2 `DuplicateLoadBalancerName`** and **DynamoDB's create-side
 *    `Table already exists: <name>`** — AWS raises both for a resource that
 *    merely EXISTS, just as readily as for a deleting one, so neither is
 *    distinguishable from a terminal collision. Promoting either would convert
 *    a fast, actionable `--replace` refusal into a full retry budget ending in
 *    the same failure. (DynamoDB's `Table is being deleted` IS distinguishable,
 *    but promoting THAT one re-multiplies the destroy-runner budget arithmetic
 *    `src/provisioning/dynamodb-index-busy-delete.ts` derives against the
 *    per-resource deadline — a different reason, so it is stated separately
 *    rather than folded in with the two above.)
 *  - **Secrets Manager `scheduled for deletion`** — the same one-sided shape as
 *    S3's entry (generic table only, invisible to
 *    {@link isRecreateRetryableError}), and the provider does delete with
 *    `ForceDeleteWithoutRecovery: true`, so it LOOKS like it belongs. It is
 *    excluded because that single message covers TWO conditions with wildly
 *    different windows: a force-deleted secret's name releasing in
 *    seconds-to-minutes, and a secret scheduled for deletion with a
 *    `RecoveryWindowInDays` of 7-30 DAYS, which no bounded budget can ride out
 *    and which a user reaches by deleting a secret outside cdkd. A budget that
 *    cannot converge on half its population is worse than failing fast, so the
 *    entry stays where it already was — in the generic table, retryable on an
 *    ordinary create and terminal at the re-create sites, unchanged by #2116.
 */
export const NAME_COOLDOWN_ERROR_MESSAGE_PATTERNS: readonly string[] = [
  // SQS, error-CODE spelling: `AWS.SimpleQueueService.QueueDeletedRecently`.
  'QueueDeletedRecently',
  // SQS, wire-message spelling of the SAME condition: "You must wait 60
  // seconds after deleting a queue before you can create another with the
  // same name." Hits when a stack is destroyed and re-deployed in quick
  // succession (a common dev / iteration loop).
  'wait 60 seconds',
  // Step Functions, error-CODE spelling: `StateMachineDeleting`.
  // `DeleteStateMachine` returns immediately and the machine keeps answering
  // `status: DELETING` afterwards (measured ~23s on an idle machine —
  // tests/integration/custom-resource-provider), holding its name throughout.
  'StateMachineDeleting',
  // Step Functions, wire-message spelling of the same condition:
  // "State Machine is being deleted: 'arn:aws:states:...'". This is the
  // message that filed #2116, raised by `CreateStateMachine` during the
  // window above. Any CDK app using `custom_resources.Provider` with an
  // `isCompleteHandler` carries a waiter state machine whether or not the
  // author knows it, so the reachable path is an ordinary re-deploy.
  'State Machine is being deleted',
  // S3, wire-message spelling of `OperationAborted`: "A conflicting
  // conditional operation is currently in progress against this resource."
  // A bucket name is globally unique and `DeleteBucket` releases it
  // asynchronously, so a re-create inside that window is refused. This entry
  // predates the list — it was in the generic table, i.e. retried on an
  // ordinary create but NOT at the delete-then-re-create sites, which is the
  // same one-sided coverage #2116 removes for the SQS pair.
  'conflicting conditional operation',
];

/**
 * Patterns that mark an AWS error as a transient/retryable failure.
 * Each entry is a substring match against the error message; all of these
 * are situations where the same call typically succeeds after a short delay
 * because of eventual consistency or just-created-dependency propagation.
 *
 * Composed from the three halves above so retryability has ONE source of truth
 * while `withRetry` can still pick a per-class backoff cadence.
 */
export const RETRYABLE_ERROR_MESSAGE_PATTERNS: readonly string[] = [
  ...IAM_PROPAGATION_ERROR_MESSAGE_PATTERNS,
  ...OTHER_TRANSIENT_ERROR_MESSAGE_PATTERNS,
  ...NAME_COOLDOWN_ERROR_MESSAGE_PATTERNS,
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
 * How far every `.cause` walk in this module reads.
 *
 * ONE constant rather than five literals, because the walks are only sound
 * together: {@link isMarkedNonRetryable} is what stops a deliberate refusal
 * being read as transient, so any walk that reads text FURTHER than the marker
 * walk creates a band where a refusal is legible but its marker is not.
 * {@link retryClassificationText} shipped at 10 against the marker's 5 for
 * exactly that reason, and the chain shape that makes the band reachable is
 * the one the code already cites -- a nested-stack failure grows one
 * `ProvisioningError` per level.
 */
const MAX_CAUSE_CHAIN_DEPTH = 5;

/**
 * Stamped on an error whose own message deliberately WITHHOLDS text its
 * `cause` carries (issue [#2302](https://github.com/go-to-k/cdkd/issues/2302)).
 *
 * Distinct from {@link NON_RETRYABLE_MARKER} and orthogonal to it: this one
 * says nothing about whether the error should be retried, only that the
 * message a classifier would normally read is INCOMPLETE.
 */
const REDACTED_CAUSE_MARKER = Symbol.for('cdkd.redactedCause');

/**
 * Declare that this error's message withholds text its `cause` carries, so the
 * message-based retry classifiers must read the CHAIN instead
 * (issue [#2302](https://github.com/go-to-k/cdkd/issues/2302)).
 *
 * cdkd's retry classifiers match by SUBSTRING over a message. That is sound
 * only while a wrapper copies its cause's text, which every wrapper did until
 * #2302 started reducing an AWS failure to its error CLASS -- S3 words its
 * `AccessDenied` as `User: arn:aws:sts::<account>:assumed-role/<role>/<session>
 * is not authorized to perform: ...`, and a THROWN message is captured into the
 * persisted `deployments/{runId}.jsonl` store. Redacting it also removed the
 * substrings the pattern table matches on: measured on `S3BucketProvider`,
 * `not authorized to perform` (retryable, on the DENSE IAM-propagation cadence)
 * and S3's `conflicting conditional operation` both went NON-retryable.
 *
 * Call it at every site that redacts, and only there. It is deliberately an
 * opt-in stamp rather than an unconditional chain read -- see
 * {@link retryClassificationText} for the measurement that forced that choice.
 *
 * Same non-extensible tolerance as {@link markNonRetryable}, for the same
 * reason: callers use it inline around the error they are about to throw, so a
 * `TypeError` here would replace the refusal with an unrelated crash. Losing
 * the stamp degrades to reading the top-level message, i.e. the pre-#2302
 * classification of a message that is now shorter -- worse, but not a crash.
 */
export function markRedactedCause<E extends Error>(error: E): E {
  if (!Object.isExtensible(error)) return error;
  Object.defineProperty(error, REDACTED_CAUSE_MARKER, {
    value: true,
    enumerable: false,
    configurable: true,
    writable: false,
  });
  return error;
}

/**
 * True when the error, or anything in its bounded `.cause` chain, was stamped
 * by {@link markRedactedCause}.
 *
 * Walked rather than read off the top link, because the redacting error is
 * itself wrapped further out: `deploy-engine.ts` re-wraps every provider
 * failure, so by the time a classifier sees it the stamp is one or more links
 * deep. Same {@link MAX_CAUSE_CHAIN_DEPTH} as the marker walk, which is what
 * lets {@link retryClassificationText} claim the two agree.
 */
export function hasRedactedCause(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_CHAIN_DEPTH && current != null; depth++) {
    if (typeof current === 'object' || typeof current === 'function') {
      if ((current as Record<symbol, unknown>)[REDACTED_CAUSE_MARKER] === true) return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

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
 * or re-raise it when the wrapper is retryable in its own right. That applies
 * to every `markNonRetryable` call site — `grep -rn 'markNonRetryable(' src/`
 * is the authority, deliberately in place of a list here.
 *
 * **Do not restate the sites as a count or an enumeration.** Both have already
 * gone stale in this one comment: it first said "six", which was the count of
 * `IntrinsicResolutionRefusalError` THROW sites transplanted from the other
 * file, and the per-file list that replaced it was stale within a day, when a
 * parallel lane added two sites in `nested-stack-provider.ts`. Marking is a
 * per-site judgement any lane can make, so any tally written here is a
 * snapshot of one moment that then reads as complete — which is the defect
 * {@link file://../utils/error-handler.ts}'s own enumeration warning
 * describes. What is stable, and all a reader needs, is the RULE above.
 */
export function isMarkedNonRetryable(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_CHAIN_DEPTH && current != null; depth++) {
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
  for (let depth = 0; depth < MAX_CAUSE_CHAIN_DEPTH && current != null; depth++) {
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
 * HTTP status codes that indicate a TRANSIENT SERVER-side failure worth
 * retrying (issue #2026).
 *
 * Mirrors `@smithy/service-error-classification`'s own
 * `TRANSIENT_ERROR_STATUS_CODES` (`[500, 502, 503, 504]`), which is what the
 * AWS SDK's default retry strategy treats as transient. Deliberately a
 * SEPARATE set from {@link RETRYABLE_HTTP_STATUS_CODES} rather than an
 * extension of it, because that one is consumed by {@link isThrottlingError},
 * which SEVEN call sites across four files pass as a deliberately NARROW
 * `isRetryable`: `describe-type.ts:67` (which states the intent outright --
 * "retry ONLY throttle-shaped failures"), `dynamodb-globaltable-provider.ts`
 * (x4), `export.ts:1744`, and `intrinsic-function-resolver.ts:5216`. Widening
 * the shared set would have silently converted every one of them from "retry
 * throttles" into "retry throttles and server errors", which none of them
 * asked for.
 *
 * Three FURTHER sites call it as a bare classification rather than as a retry
 * filter -- `drift.ts:518`, `export.ts:1755`, `dynamodb-index-busy-delete.ts:381`
 * -- and they make the case stronger, not weaker: `drift.ts` would have started
 * returning `undefined` (reporting "cannot compare") for a resource whose read
 * merely 500'd, and the index poll would have waited a server error out as
 * though it were a throttle.
 *
 * Measured, not inferred. `tests/integration/iam-propagation-stress` against
 * real AWS (us-east-1, 2026-08-19 08:57:30Z, round 11 of 11) produced:
 *
 *   StressQueuePolicyDC3E35C3: gave up after 5 IAM-propagation retries over
 *   5.75s of propagation backoff - Failed to create SQS queue policy
 *   StressQueuePolicyDC3E35C3: UnknownError
 *   [name=InternalFailure http=500 requestId=ebf581cc-6072-5ffc-943a-e33312488615]
 *
 * SQS answered a `SetQueueAttributes` mid-propagation with HTTP 500
 * `InternalFailure` and an empty message body -- hence the `UnknownError`
 * placeholder, which matches no message pattern. With 500 absent from every
 * status set, `withRetry` classified it non-retryable and threw at 5.75s of a
 * 47.75s budget the sequence needed roughly 10s of.
 *
 * Why 502 and 504 come along rather than only the measured 500: they are the
 * same class (a gateway or timeout between AWS's edge and the service), the
 * SDK groups all four, and adding only the one status seen would leave the
 * identical defect behind for its siblings.
 *
 * Note the SDK has ALREADY retried these before cdkd sees them (default
 * `maxAttempts` is 3), so a 5xx reaching this classifier is one that persisted
 * across the SDK's own attempts. That is an argument FOR retrying it here, not
 * against: the eventual-consistency window this schedule exists to cover is
 * measured in seconds, while the SDK's three attempts span well under one.
 *
 * ACCEPTED RISK, stated rather than discovered later: this makes a
 * NON-IDEMPOTENT create retryable on a 500 that may have succeeded
 * server-side, so a replay can leave a resource that is absent from state and
 * therefore from destroy. The class is PRE-EXISTING -- the SDK's own three
 * attempts already reach it, and 503 was already retryable here -- but this
 * widens the window from ~1s to the full schedule. Judged worth it because the
 * alternative is the measured failure (a deploy that dies outright on a
 * transient 500), and because the durable remedy is per-provider idempotency
 * tokens rather than a blanket refusal to retry server errors.
 *
 * STATUS (issue #2039, and read this before citing the paragraph above). The
 * two worked examples this note used to carry -- `RunInstances` sent with no
 * `ClientToken`, and `IAMAccessKeyProvider` minting an unnamed key -- are both
 * FIXED, so quoting them as live hazards would now mislead. `RunInstances`,
 * `CreateNatGateway`, `CreateRouteTable`, `CreateNetworkAcl` and
 * `CreateHostedZone` carry a retry-stable token from
 * `src/provisioning/providers/idempotency-token.ts`, and `CreateAccessKey`
 * (which has no token member) reconciles the orphan its own failed attempt
 * left. The claim that "only four providers use one at all" was also wrong when
 * written: six did, and two of those regenerated the token per attempt, which
 * is worse than none. What REMAINS accepted here is the residue -- roughly 25
 * creates across 16 providers audited in issue #2039 and enumerated in issue
 * #2080 -- so this set stays as-is and the remedy stays per-provider.
 */
export const TRANSIENT_SERVER_ERROR_STATUS_CODES: ReadonlySet<number> = new Set([
  500, 502, 503, 504,
]);

/**
 * Walk the error + its `.cause` chain (bounded, same depth 5 as
 * {@link isThrottlingError}) looking for a transient SERVER-side HTTP status
 * ({@link TRANSIENT_SERVER_ERROR_STATUS_CODES}) on `$metadata`.
 *
 * The walk is what makes it work in practice: providers wrap the AWS error in
 * a `ProvisioningError`, so the `$metadata` carrying the status sits one link
 * down, and the wrapper's interpolated message is all a message-based
 * classifier can see. In the measured failure that message was the literal
 * `UnknownError`, so the status was the ONLY usable evidence in the whole
 * error.
 */
export function isTransientServerError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_CHAIN_DEPTH && current != null; depth++) {
    const status = (current as { $metadata?: { httpStatusCode?: number } }).$metadata
      ?.httpStatusCode;
    if (status !== undefined && TRANSIENT_SERVER_ERROR_STATUS_CODES.has(status)) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * The signals `isRetryableTransientError` had available when it classified an
 * error, rendered for a log line (issue #2026).
 *
 * NOT a classification input — nothing in this file or in `withRetry` reads it
 * back. It exists because the give-up summary added for issue #2018 reports the
 * error's MESSAGE, and the message is precisely the field that had gone missing
 * in the failure that motivated this: a sequence terminated on
 * `UnknownError`, which is what the AWS SDK v3 `decorateServiceException`
 * substitutes when a service response carries no message text at all
 * (`@smithy/smithy-client`: `exception.message || exception.Message ||
 * "UnknownError"`). With the message degenerate, the two fields that actually
 * decide {@link isThrottlingError} — the error `name` and
 * `$metadata.httpStatusCode` — were the only remaining evidence, and neither
 * reached any log at any verbosity. Diagnosing the give-up therefore required
 * a second real-AWS reproduction rather than a line from the first.
 */
export interface RetryClassificationSignals {
  /** The name of the AWS-side error, or the deepest name when none carries `$metadata`. */
  name?: string | undefined;
  /**
   * `$metadata.httpStatusCode` — the value both status sets are tested
   * against: {@link RETRYABLE_HTTP_STATUS_CODES} via {@link isThrottlingError},
   * and {@link TRANSIENT_SERVER_ERROR_STATUS_CODES} via
   * {@link isTransientServerError}.
   */
  httpStatusCode?: number | undefined;
  /** AWS request id, so a give-up can be taken to AWS support without a re-run. */
  requestId?: string | undefined;
  /**
   * True when NO link in the cause chain carried a `$metadata` object.
   *
   * Load-bearing rather than cosmetic, and the reason absence is reported
   * explicitly instead of as a missing field: a smithy `ServiceException` is
   * built by `deserializeMetadata(output)`, which always populates
   * `httpStatusCode` from the HTTP response, so its ABSENCE means the failure
   * never reached error deserialization at all (a network / parse failure
   * wrapped by a provider) — a different defect with a different fix from a
   * status that is present but unlisted. A blank field cannot tell those apart
   * from a truncated cause chain.
   */
  noMetadata: boolean;
}

/**
 * Collect {@link RetryClassificationSignals} from an error and its bounded
 * `.cause` chain — the SAME walk, to the same depth 5, that
 * {@link isThrottlingError} performs, so the line reports what the classifier
 * genuinely saw rather than a second opinion gathered differently.
 *
 * The signals are taken from the first link carrying a `$metadata` object,
 * because that link IS the AWS SDK error by construction: `$metadata` is
 * attached by the SDK's own `deserializeMetadata`, so nothing else can carry
 * it. When no link has one, the fallback is the deepest name found BELOW depth
 * 0 -- which keeps the field useful for the wrapped-network-error case, where
 * the name is all that survives.
 *
 * Excluding depth 0 from that fallback is deliberate and is what stops the
 * suffix from being noise. The error `withRetry` is handed is the provider's
 * own wrapper by construction (every provider catches the AWS error and
 * rethrows a `ProvisioningError`), so its `name` is a cdkd class name and says
 * nothing about the service. Reporting it produced the actively misleading
 * ` [name=ProvisioningError no-$metadata]` on a wrapper carrying no cause at
 * all -- a suffix asserting the SDK never parsed a response, about an error
 * that never came from the SDK.
 *
 * Nothing is lost in the case this helper exists for. A degenerate
 * `UnknownError` message can only be produced by `decorateServiceException`,
 * i.e. by a smithy `ServiceException`, and those always carry `$metadata` --
 * so that case is answered by the FIRST branch and never reaches this
 * fallback.
 *
 * Known narrowness: the first link with a NUMERIC status wins, so an outer
 * link carrying a 400 that wraps a cause carrying a 500 reports the 400 while
 * `isTransientServerError` retried on the 500. Left as-is because cdkd's own
 * wrappers carry no `$metadata` at all, so producing that shape takes two
 * stacked SDK errors -- but it is the same "must not contradict the
 * classifier" case one link further out, and is the thing to revisit if such a
 * chain is ever observed. A cdkd module deliberately importing no other module, this one
 * cannot ask `error instanceof CdkdError` directly: `error-handler.ts` imports
 * `markNonRetryable` from here, so the dependency only runs one way.
 */
export function describeRetryClassificationSignals(error: unknown): RetryClassificationSignals {
  let current: unknown = error;
  let deepestName: string | undefined;
  // Retained from the FIRST link carrying a `$metadata` object, so a chain
  // whose metadata has a request id but no status still reports the id.
  let sawMetadata = false;
  let metadataName: string | undefined;
  let metadataRequestId: string | undefined;

  for (let depth = 0; depth < MAX_CAUSE_CHAIN_DEPTH && current != null; depth++) {
    const name = (current as { name?: unknown }).name;
    // Depth 0 is the provider's wrapper -- see the note above on why its name
    // is excluded from the no-$metadata fallback. It is still eligible via the
    // `$metadata` branch below, where the metadata itself proves the link came
    // from the SDK rather than from cdkd.
    if (depth > 0 && typeof name === 'string' && name !== '') {
      deepestName = name;
    }

    const metadata = (current as { $metadata?: unknown }).$metadata;
    if (metadata != null && typeof metadata === 'object' && !Array.isArray(metadata)) {
      const { httpStatusCode, requestId } = metadata as {
        httpStatusCode?: unknown;
        requestId?: unknown;
      };
      const linkName = typeof name === 'string' && name !== '' ? name : undefined;
      if (!sawMetadata) {
        sawMetadata = true;
        metadataName = linkName;
        metadataRequestId =
          typeof requestId === 'string' && requestId !== '' ? requestId : undefined;
      }
      // Return only on a link that actually carries a STATUS. Returning on any
      // `$metadata` object was wrong in a shape the AWS SDK really produces: a
      // network failure carries `$metadata: { attempts, totalRetryDelay }` with
      // no `httpStatusCode`, and wrapping a 500 below it. The walk stopped at
      // the outer link and reported no `http=` at all -- while
      // `isTransientServerError`, which walks past it, HAD found the 500 and
      // retried on it. A line whose whole purpose is "what the classifier saw"
      // must not contradict the classifier.
      if (typeof httpStatusCode === 'number') {
        return {
          name: linkName ?? deepestName,
          httpStatusCode,
          // Falls back to an id retained from a SHALLOWER `$metadata` that had
          // no status: a chain can carry the request id on the outer link and
          // the status on the inner one, and dropping the id there loses the
          // single field AWS support needs.
          requestId:
            (typeof requestId === 'string' && requestId !== '' ? requestId : undefined) ??
            metadataRequestId,
          noMetadata: false,
        };
      }
    }
    current = (current as { cause?: unknown }).cause;
  }

  return {
    name: metadataName ?? deepestName,
    requestId: metadataRequestId,
    // FALSE when a `$metadata` was seen without a usable status: the response
    // DID reach the SDK's error deserialization, so the "never got that far"
    // reading the flag exists for would be a lie. Absent status and absent
    // metadata are genuinely different findings.
    noMetadata: !sawMetadata,
  };
}

/**
 * Render {@link describeRetryClassificationSignals} as a compact log suffix.
 *
 * Returns `''` when there is nothing to say (no name and no metadata), so a
 * caller can append unconditionally without emitting an empty bracket pair.
 */
export function formatRetryClassificationSignals(error: unknown): string {
  const signals = describeRetryClassificationSignals(error);
  // Nothing identifiable in the chain -- no name, no status, no request id.
  // Bail BEFORE the `no-$metadata` token below: on its own that token is not a
  // finding but noise, because "the failure never reached error
  // deserialization" is only informative about an error we can NAME. Emitting
  // it unconditionally appended a content-free ` [no-$metadata]` to the
  // give-up line for every non-AWS throw. A lone request id DOES count as
  // identifying, since it is the one field that lets AWS support find the call.
  if (
    signals.name === undefined &&
    signals.httpStatusCode === undefined &&
    signals.requestId === undefined
  ) {
    return '';
  }
  const parts: string[] = [];
  if (signals.name !== undefined) parts.push(`name=${signals.name}`);
  if (signals.httpStatusCode !== undefined) parts.push(`http=${signals.httpStatusCode}`);
  if (signals.requestId !== undefined) parts.push(`requestId=${signals.requestId}`);
  // Reported as a POSITIVE token rather than by omission: "no $metadata" is a
  // finding (the failure never reached error deserialization), and a reader
  // scanning for a missing `http=` cannot distinguish it from a status the
  // chain simply did not carry.
  if (signals.noMetadata) parts.push('no-$metadata');
  return ` [${parts.join(' ')}]`;
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
 *   2. Transient SERVER-side HTTP status (500 / 502 / 503 / 504) on the error
 *      or any wrapped cause — see {@link isTransientServerError}. Ahead of the
 *      message patterns because it is the only check that still works when the
 *      response carried NO message (issue #2026).
 *   3. Substring match against {@link RETRYABLE_ERROR_MESSAGE_PATTERNS}
 */
export function isRetryableTransientError(error: unknown, message: string): boolean {
  if (isMarkedNonRetryable(error)) return false;
  if (isThrottlingError(error)) return true;
  // Issue #2026: a transient SERVER error (HTTP 500 / 502 / 503 / 504). Placed
  // after the throttle check and before the message patterns because it is the
  // check that survives an EMPTY message -- the measured failure carried the
  // SDK's `UnknownError` placeholder, so every pattern below had nothing to
  // match against and the sequence died at 12% of its budget.
  if (isTransientServerError(error)) return true;

  return RETRYABLE_ERROR_MESSAGE_PATTERNS.some((p) => message.includes(p));
}

/**
 * The text every MESSAGE-based retry classifier should read: this error's own
 * message plus every message down its `cause` chain.
 *
 * Every classifier in this module that reads a message reads the TOP-LEVEL one,
 * and that was sound only while cdkd's wrappers copied their cause's text
 * verbatim -- which they did, everywhere, until issue
 * [#2302](https://github.com/go-to-k/cdkd/issues/2302). A wrapper on a THROWN
 * path may now deliberately WITHHOLD AWS's wording, because a thrown message is
 * captured into the persisted `deployments/{runId}.jsonl` store and S3's
 * `AccessDenied` names the caller's account, role and session. Measured on
 * `S3BucketProvider.create` before this function existed: the wrap turned
 * `not authorized to perform` (retryable, and on the DENSE IAM-propagation
 * cadence) and `conflicting conditional operation` (retryable) into
 * NON-retryable, i.e. the redaction silently removed a retry the deploy
 * depended on.
 *
 * This is the missing THIRD walk rather than a new idea: {@link
 * isMarkedNonRetryable} and {@link isThrottlingError} already walk the same
 * chain, for the same stated reason (cdkd wraps SDK errors routinely).
 *
 * It cannot resurrect a cdkd refusal: every consumer checks
 * {@link isMarkedNonRetryable} FIRST, that marker is itself chain-walked, and
 * both walks are bounded by the SAME {@link MAX_CAUSE_CHAIN_DEPTH}.
 *
 * It is a NO-OP for every error that has not opted in via
 * {@link markRedactedCause} -- which is every wrapper on `main` outside
 * #2302's redacting sites. An earlier revision justified itself with a wider
 * claim, that every wrapper on `main` COPIES its cause's message; that claim is
 * false (`custom-resource-provider.ts`'s `describeWaiterFailure` already
 * withholds the raw waiter payload, and it is not the only wrapper that does),
 * and it does not need to be true. The opt-in stamp makes the no-op a property
 * of the mechanism rather than of a survey.
 *
 * NEVER use the result as a LOG line or a thrown message: it is the union of
 * exactly the text the redaction exists to withhold. `retry.ts` keeps the
 * top-level message for its `warn` / `debug` output and uses this only to
 * classify.
 */
export function retryClassificationText(error: unknown): string {
  const top = error instanceof Error ? error.message : String(error);
  // OPT-IN, and that is the whole safety argument. Reading the chain
  // unconditionally would re-classify every wrapper whose message does not
  // already carry its cause's text, and that population is neither empty nor
  // uniformly deliberate. The decisive member is `deploy-engine.ts`'s outer
  // per-resource wrap, whose whole message is `Failed to <op> resource <id>`:
  // it is UNMARKED and sits on every resource failure in the tree, so an
  // unconditional join flips it from terminal to retryable whenever the cause
  // happens to carry a retryable substring -- measured on that wrap, a
  // `DependencyViolation` cause and a `does not exist` cause both flip
  // `false -> true`. That is a large behavior change with nothing to do with
  // #2302's redaction.
  //
  // The audited list of non-carrying sites lives in the PR body rather than
  // here, deliberately: a count in a comment goes stale silently, and two
  // independently written counting rules agreed on the SITES while disagreeing
  // on how many constructions to divide them by.
  //
  // So the join fires only for a chain that says it withheld something.
  // `markNonRetryable` is checked FIRST by every consumer and is walked to
  // the SAME depth as this, so a marked refusal still cannot be resurrected
  // by the widened text -- the two walks agree by construction rather than
  // by assertion (an earlier revision walked 10 here against the marker's 5,
  // which left a refusal marked at depth 6-10 readable but unmarkable).
  if (!hasRedactedCause(error)) return top;

  const parts: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  // A `visited` set as well as the depth bound, because a nested-stack chain
  // grows one `ProvisioningError` per level and a self-referencing `cause` is
  // cheap to construct.
  for (
    let depth = 0;
    depth < MAX_CAUSE_CHAIN_DEPTH && current != null && !seen.has(current);
    depth++
  ) {
    seen.add(current);
    if (current instanceof Error) {
      if (current.message) parts.push(current.message);
    } else {
      // A non-`Error` link, at ANY depth. `new Error(m, { cause: 'a string' })`
      // is legal and a provider can rethrow a non-`Error` value, so a link
      // gated on `depth === 0` both dropped the text AND dead-ended the walk
      // one link early. Stringify it and keep going: `cause` is readable off a
      // non-object too (it is simply `undefined`), so the loop terminates.
      //
      // `String()` can THROW, and where this runs makes that fatal rather than
      // untidy: `Object.create(null)` has no `Symbol.toPrimitive`, no
      // `toString` and no `valueOf`, so stringifying it raises
      // `TypeError: Cannot convert object to primitive value`. Both callers
      // invoke this INSIDE a catch block (`destroy-runner.ts`'s delete loop and
      // `retry.ts`'s attempt loop), so an exception here would REPLACE the real
      // failure with an unrelated `TypeError` and lose the error the caller was
      // about to classify and rethrow. Same reasoning as `markNonRetryable`'s
      // `isExtensible` guard: a helper on a failure path must not out-throw the
      // failure it is describing. The `depth === 0` gate bounded this by
      // accident; widening the walk removed that bound, so the guard is now
      // explicit. A link that cannot be stringified contributes NO text and the
      // walk continues, which is the same outcome as an `Error` with an empty
      // message.
      try {
        parts.push(String(current));
      } catch {
        // Deliberately silent: there is no text to add, and this function has
        // no logger by design (its whole output is classification-only text
        // that must never be logged).
      }
    }
    current = (current as { cause?: unknown } | undefined)?.cause;
  }
  return parts.join('\n');
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
 * Match a same-name re-creation cooldown — an AWS service still holding a
 * resource's name while its asynchronous delete finishes. Every recognised
 * spelling lives in {@link NAME_COOLDOWN_ERROR_MESSAGE_PATTERNS}; add new ones
 * THERE rather than here, so the ordinary-create path
 * ({@link RETRYABLE_ERROR_MESSAGE_PATTERNS}, which composes that list) cannot
 * drift out of step with the delete-then-re-create sites again. That drift is
 * exactly what issue [#2116](https://github.com/go-to-k/cdkd/issues/2116)
 * found: SQS's wire message was retryable on an ordinary create while its
 * error code was not, and the Step Functions spelling was recognised by
 * neither.
 *
 * The delete-then-re-create sites (the deploy engine's `--replace`
 * delete-first fallback and the rollback executor's reverse-replacement)
 * override the retry filter with {@link isNameCollisionError}, which these
 * signatures do NOT match — so a replacement revert used to fail fast
 * mid-flight with the resource absent from both AWS and state (issue #1206).
 * Those sites OR this matcher into their retry filter, with a schedule long
 * enough to cover the 60s SQS window.
 *
 * Kept separate from {@link isNameCollisionError} on purpose: a cooldown at a
 * create-first site must NOT be treated as a collision (deleting the new
 * resource would not release the cooldown on the old name).
 */
export function isNameCooldownError(message: string): boolean {
  return NAME_COOLDOWN_ERROR_MESSAGE_PATTERNS.some((p) => message.includes(p));
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
