/**
 * The **IAM-propagation** subset of {@link RETRYABLE_ERROR_MESSAGE_PATTERNS}:
 * an AWS service rejecting a call because a just-created IAM entity (role,
 * trust policy, inline policy, instance profile, principal) has not propagated
 * to that service's authorization layer yet.
 *
 * Kept as its own array — and composed back into the full transient table
 * below — so there is exactly ONE list per pattern (no parallel classifier to
 * drift). It exists because this class has a materially different RECOVERY
 * SHAPE from the other transient errors: it usually resolves within seconds,
 * so `withRetry` polls it on a dense sub-second schedule instead of the
 * generic 1s/2s/4s/8s exponential backoff (which is right for throttling and
 * for long resource-state transitions, and wrong here — see
 * {@link file://../retry.ts}).
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
  // FOURTH wording, Lambda's (issue #3853): CreateEventSourceMapping on a
  // DynamoDB stream (the only source observed) reads the stream with the
  // function's just-created role, and relays the not-yet-valid session as
  // "Received Exception while reading from provided stream. The security token
  // included in the request is invalid." — no `(Service:` trailer, so the anchor above misses it. The
  // Lambda prefix is what keeps cdkd's OWN expired credentials (the bare
  // sentence) failing fast.
  'Received Exception while reading from provided stream. The security token included in the request is invalid',
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
  // Lambda CapacityProvider (Lambda Managed Instances): the Cloud Control
  // CreateResource references a same-stack operator IAM role, which CDK's
  // `lambda.CapacityProvider` creates in the SAME stack, and cdkd issues the
  // create seconds after the role's CREATE. The handler rejects a role that has
  // not propagated with "The operator role is invalid or doesn't have
  // sufficient permissions. Verify the role and permissions and try again."
  // (InvalidRequest, HTTP 400, SDK Attempt Count: 1), so it was SINGLE-SHOT:
  // no pattern here matched it ('does not have required permissions' is a
  // different sentence). Issue #3174: the first deploy of its fixture failed
  // this way, and a probe against a fresh role got this message 8s after the
  // role's policy was attached and a SUCCESS at 23s (one sample, 2026-09-15),
  // inside the dense grid's ~47.75s of backoff. Anchored on the handler's
  // sentence up to "sufficient permissions" and NO further: the trailing
  // "Verify the role and permissions and try again." is advisory text this
  // pattern deliberately leaves out, so a reword of that tail cannot blunt the
  // match -- which does make the `.includes` test broader than the quoted
  // sentence, matching any message carrying this clause. The retained span is
  // still the part naming the propagation failure, so a genuinely missing
  // permission only burns the bounded retries before surfacing and no other
  // service's authorization failure false-positives into the retry loop.
  // CloudFormation tolerates it via deployment latency; cdkd retries.
  "The operator role is invalid or doesn't have sufficient permissions",
  // Lambda CapacityProvider, the SAME create two stages later (issue #3227).
  // The entry above covers the first window of a fresh operator role; probing
  // `cloudcontrol create-resource` against a seconds-old role showed the
  // rejection MOVE rather than clear -- two roles, same order, success 13s and
  // 14s after the role was created: `The operator role is invalid ...` twice,
  // then this wording, then SUCCESS. `not authorized to perform` does not
  // match it, because the handler says "doesn't have permission to perform".
  // Kept narrow to the ONE action observed: `doesn't have permission to
  // perform ec2:` would cover every other EC2 action on the same phrasing,
  // and none of them was measured. Confirmed inside cdkd too, not only by the
  // probe: a `lambda-capacity-provider-default-name` run (ap-northeast-1,
  // 2026-09-16) got this wording on attempt 2 of a create, after the entry
  // above matched attempt 1, and retried it to success -- the attempt at which
  // a build without this entry gives up.
  //
  // The cost, stated here beside the entry as its sibling below states its own:
  // an operator role that GENUINELY lacks `ec2:DescribeSecurityGroups` -- a
  // missing statement, or a deny from an SCP or a permissions boundary, none
  // of which waiting fixes -- spends the full dense budget (~47.75s) before the
  // create surfaces its real error.
  "doesn't have permission to perform ec2:DescribeSecurityGroups",
  // Lambda CapacityProvider, third wording of the same race (issue #3227), and
  // the one that actually broke deploys: `One or more security group IDs are
  // invalid. Check that the IDs are correct and try again.` (InvalidRequest,
  // HTTP 400) on a create issued 0.19s and 1.84s after the same stack's
  // security group. Three fresh deploys from empty state failed on it; a
  // re-deploy minutes later succeeded with the same `VpcConfig`.
  //
  // **The CAUSE is not established, and the entry does not claim one.** Two
  // explanations fit -- the operator role's permissions still propagating, or
  // the just-created security group not yet visible to Lambda -- and the
  // wording did not reproduce outside cdkd in six probe shapes, so neither was
  // ruled out. What IS measured is that the condition clears on its own, which
  // is what the retry needs -- and, once, how fast: a
  // `lambda-capacity-provider-default-name` run (ap-northeast-1, 2026-09-16)
  // failed a create's FIRST attempt on this wording, retried it, and created
  // about 4s after the rejection. One sample, so it shows the dense grid CAN
  // cover the window, not that it always does. Anchored on the full first
  // sentence and not on the advisory tail, for the reason the operator-role
  // entry above states.
  //
  // Unlike its siblings this one names no role, so a genuinely wrong security
  // group id in a template spends the bounded retries before surfacing. That
  // is the trade this file already makes for `Invalid IAM Instance Profile`.
  //
  // An entry here reaches FIVE call sites, not only the create-side retry this
  // comment is about. For both issue #3227 entries: `withRetry` twice -- its
  // retryability test (`isRetryableTransientError`) and, separately, its
  // cadence choice (`isIamPropagationError` picks the dense grid); the Custom
  // Resource provider's `isTransientAuthzThrow`, which REPLAYS a delivery (why
  // these are ledgered in `custom-resource-provider-thrown-retry.test.ts`);
  // `destroy-runner.ts`'s DELETE loop, where a match costs up to 3 retries on
  // its own 5s/10s/20s grid, ~35s per resource; and `isTerminalDeleteFailure`
  // in `deletion-protection-compensation.ts`, which reads the verdict INVERTED
  // -- a match makes a delete failure non-terminal and defers the
  // `--remove-protection` compensation to the loop's last attempt. That
  // inverted reader is the one a future entry is likeliest to get wrong. The
  // `destroy-runner.ts` loop is
  // type-generic, so the claim there is narrower: no delete OBSERVED here
  // carries these wordings. A Cloud Control DELETE of a capacity provider that
  // re-validates its operator role could carry one, and would then spend up to
  // ~35s of retry backoff if the rejection persisted through every attempt.
  'One or more security group IDs are invalid',
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
  // Cognito CreateUserPool / SetUserPoolMfaConfig validates that the
  // cognito-idp.amazonaws.com service principal can assume the pool's
  // `SmsConfiguration.SnsCallerArn` role at call time. CDK's `UserPool` L2
  // auto-creates that SNS-publish role (`...UserPoolsmsRole...`) in the SAME
  // stack whenever SMS MFA / SMS verification is configured, and cdkd's fast
  // SDK path issues the pool create before IAM has propagated the trust policy
  // to Cognito's assume layer. AWS rejects it with
  // `InvalidSmsRoleTrustRelationshipException` / "Role does not have a trust
  // relationship allowing Cognito to assume the role" (issue #2901).
  //
  // What the report's payload SUPPORTS is that the create failed in 336ms —
  // that figure is the event's `durationMs`, the failing operation's own
  // elapsed time, not the gap since the role's CREATE, which the payload does
  // not carry. Read correctly it is still the decisive number: 336ms is far
  // too short for any retry to have happened, which is the single-shot
  // behaviour below. (The issue's prose reads it as the gap; that inference is
  // not supported by the JSON beside it, and an earlier revision of this
  // comment repeated it as MEASURED.) The gap IS measured, on cdkd's own
  // fixture: `tests/integration/propagation-races-2` reports it per run and
  // has recorded 0ms twice.
  //
  // NONE of the patterns above matched it — verified exhaustively against all
  // three arrays rather than by eye, since several look like near misses:
  // 'trust policy' is lower-case AND a different noun ("trust relationship"),
  // 'Trusted Entity' is CodeBuild's wording, 'does not have required
  // permissions' has the other word order, and every 'assume' entry above
  // anchors on a phrasing AWS does not use here. So `isRetryableTransientError`
  // returned false and the create was SINGLE-SHOT: not a mis-shaped budget, no
  // retry at all. Neither escape applied either — the exception name is not in
  // `THROTTLING_ERROR_NAMES`, and the failure is HTTP 400 (MEASURED against
  // real AWS, 2026-09-10: the give-up line's classifier bracket reported
  // `[name=InvalidSmsRoleTrustRelationshipException http=400 requestId=...]`.
  // The issue's own payload could not have supplied it — a `cdkd events`
  // record carries no status code).
  //
  // Anchored on the message TAIL rather than on the error CODE, which is not
  // reachable from here: classification is deliberately message-only
  // (`isIamPropagationError` below says so in its own doc comment) and
  // `CognitoUserPoolProvider` interpolates `error.message` alone, never
  // `error.name` — so a code-anchored entry would never fire.
  //
  // The service-name slot is left OUT of the anchor, and this is NOT the same
  // trade 'is unable to assume the role' above makes: THERE the anchor is
  // absent because AWS emits no service prefix at all, so there is no slot to
  // keep. Here a prefix EXISTS and is dropped anyway, which is the trade the
  // Firehose entry above argues AGAINST. It is taken deliberately: AWS renders
  // this sentence as "allowing <Service> to assume the role", so dropping the
  // slot covers a sibling service without a fourth wording having to be
  // discovered in production, and the Firehose worry does not reach it — that
  // entry guards against a PERMANENT explicit-deny sharing its phrasing,
  // whereas the only condition that can produce THIS sentence is a missing
  // trust relationship, i.e. either this propagation window or its permanent
  // twin, and the twin only burns the bounded ~47.75s budget before surfacing.
  //
  // ONE entry covers EVERY call that validates the role, and the reason is
  // worth knowing before adding a second. `SetUserPoolMfaConfig` — reached
  // from `create()` AND from `update()` — re-sends the SAME `SmsConfiguration`
  // (see `buildMfaConfigRequest`), so it races the same role. But it runs
  // inside `CognitoUserPoolProvider.retryOnTransientControlPlane`, whose
  // private classifier accepts only the exception NAME
  // `ConcurrentModificationException` or a message matching
  // /concurrent modification|please retry|try again|in progress/i. This message
  // is neither, so that loop rethrows IMMEDIATELY; the surrounding catch
  // re-throws a `ProvisioningError` embedding the AWS text (and, on the create
  // path, deletes the partially-created pool first), and the engine's outer
  // `withRetry` — which this provider does not disable — takes the dense grid.
  // Do NOT also widen the inner loop: 3 attempts means TWO sleeps, 1s + 2s =
  // 3s, spent on the wrong grid before the outer one starts. (Its own doc
  // comment says "1s -> 2s -> 4s, default 3 attempts"; the 4s step is
  // unreachable at that attempt count.)
  //
  // Live A/B against real AWS, 2026-09-10, one variable — a stack whose SMS
  // role's trust policy deliberately omits Cognito, so AWS returns this
  // rejection PERMANENTLY and the retry runs to exhaustion:
  //
  //   with this entry    -> 70s, "gave up after 26 IAM-propagation retries
  //                         over 47.75s of propagation backoff"
  //   with it removed    -> 13s, no retry line at all
  //
  // Same template, same AWS message. That is what establishes the DENSE grid
  // is selected rather than merely that the create is retried at all.
  //
  // Fenced by `tests/unit/deployment/retryable-errors.test.ts` (this message is
  // matched by EXACTLY this entry, plus the near misses named above asserted to
  // keep missing it) and `tests/unit/provisioning/cognito-provider.test.ts`
  // (the inner-loop rethrow, on both the create and update paths, with a
  // control proving that loop still retries its own class). Live edge 5 of
  // tests/integration/propagation-races-2, which also reports the measured
  // producer→consumer gap so a green run cannot be mistaken for a raced one.
  'does not have a trust relationship allowing',
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
  // DefaultPolicy); pinned by tests/integration/stepfunctions-logging Phase 4,
  // which redeploys the whole stack from nothing after the destroy so the role
  // is fresh again. That phase exists because the fixture's Phase 0 settles the
  // trust policy on purpose to reach the log-destination window below, and the
  // two windows are mutually exclusive — one deploy can only pin one of them.
  'authorized to assume the provided role',
  // Step Functions CreateStateMachine / UpdateStateMachine, SECOND rejection of
  // the same deploy — the one that surfaces once the trust policy HAS settled.
  // `LoggingConfiguration` makes the call validate that the role can reach the
  // log destination, and cdkd issues it ~1s after the role's DefaultPolicy
  // CREATE, before IAM has propagated the `logs:CreateLogDelivery` /
  // `PutResourcePolicy` / ... grants, so AWS rejects it with "The state machine
  // IAM Role is not authorized to access the Log Destination".
  //
  // This phrase was DELIBERATELY classified permanent when the assume-role
  // pattern above landed (2026-07-02), on the reasoning that "authorized to
  // ACCESS" is a different, genuine role misconfiguration from "authorized to
  // ASSUME". Issue #2783 reported it as propagation-timed instead, and a live
  // A/B settles it — us-east-1, 2026-09-08, two runs differing in ONE variable:
  //
  //   - grants ABSENT, trust policy settled 20s  -> the same message, permanent.
  //   - grants PUT 1s before the create          -> the same message on 5
  //     consecutive attempts, then the IDENTICAL call SUCCEEDS at t+7.8s.
  //
  // So the wording is ambiguous between a permanent misconfiguration and the
  // propagation window, and the permanent reading alone is wrong. The A/B also
  // shows why the window was easy to miss: against a brand-new role the
  // assume-role check fires FIRST and masks this one entirely (6 consecutive
  // 'Neither the global service principal ...' rejections over ~10s), so the
  // log-destination race is only reachable once that earlier pattern has
  // already been retried through.
  //
  // Anchored on the full "not authorized to access the Log Destination"
  // sentence so the permanent causes AWS reports it for only burn the bounded
  // ~47.75s propagation budget before surfacing, rather than failing a
  // legitimate deploy outright: a role that genuinely lacks the grants
  // (MEASURED — the A/B's first arm is exactly this), and a CloudWatch Logs
  // resource policy at one of its quotas (READ from AWS's docs, not exercised
  // here — no fixture reaches either). Both are documented for users in
  // docs/troubleshooting.md, which is the copy to keep correct.
  //
  // Several entries here make the same trade, one of them more loosely than
  // this: 'is unable to assume the role' above deliberately drops its service
  // anchor. Note it is a trade about ADMISSION to the table, which the header
  // rule does not speak to — that rule governs WHICH of the two lists an
  // already-retryable pattern belongs in, i.e. the cadence.
  //
  // The budget is ONE shared `attemptLimit` per `withRetry` sequence, not one
  // per window, and the assume-role window above draws on it first — so size it
  // against what the two consume TOGETHER, not against this window alone.
  // Count ATTEMPTS, not seconds: the delay comes from the GLOBAL attempt index,
  // so this window's attempts cost more when they follow the other one, and two
  // separately-measured wall-clock figures do not add up to the composed cost.
  // Observed per window (tests/integration/stepfunctions-logging isolates each,
  // so the COMPOSED case is derived rather than measured): 6 attempts for the
  // assume-role window, up to 10 for this one. 16 of the 26 attempts is 27.75s
  // of the 47.75s grid, leaving 10 attempts / 20s spare.
  'not authorized to access the Log Destination',
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
 * that is ALREADY in flight and clears within a budget. The candidates the
 * sibling sweeps turned up are recorded here as deliberate EXCLUSIONS rather
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
 *  - **Kinesis `CreateStream` and Firehose `CreateDeliveryStream`** — both
 *    deletes are asynchronous and hold the name, but MEASURED live (#2226) the
 *    create refused during `DELETING` is byte-for-byte the refusal for a LIVE
 *    stream: `ResourceInUseException: Stream <name> under account <acct>
 *    already exists.` and `ResourceInUseException: Firehose <name> under
 *    accountId <acct> already exists`. No substring separates the two, so this
 *    is the ELBv2 case again. The window is closed at its source instead — the
 *    provider's `delete()` waiting for the name to be released (#3872).
 *  - **ELBv2 `DuplicateTargetGroupName`** — no cooldown exists to match:
 *    MEASURED live (#2226), `DeleteTargetGroup` is synchronous and an immediate
 *    same-name create succeeds. The code only ever means a LIVE target group
 *    with different settings (`A target group with the same name '<name>'
 *    exists, but with different settings`), which is a terminal collision and
 *    already classified as one by exception NAME
 *    (`DuplicateTargetGroupNameException` in
 *    {@link NAME_COLLISION_ERROR_NAMES}, read by
 *    {@link isNameCollisionErrorFrom}) — not by message, so the message-only
 *    {@link isRecreateRetryableError} does not retry it.
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
