import { describe, it, expect } from 'vite-plus/test';
import {
  IAM_PROPAGATION_ERROR_MESSAGE_PATTERNS,
  RETRYABLE_ERROR_MESSAGE_PATTERNS,
  isIamPropagationError,
  isNameCollisionError,
  isNameCooldownError,
  isRecreateRetryableError,
  isRetryableTransientError,
} from '../../../src/deployment/retryable-errors.js';

describe('isRetryableTransientError', () => {
  describe('HTTP status code based retries', () => {
    it('retries on 429 (throttle) directly on the error', () => {
      const err = Object.assign(new Error('Throttled'), {
        $metadata: { httpStatusCode: 429 },
      });
      expect(isRetryableTransientError(err, 'Throttled')).toBe(true);
    });

    it('retries on 503 (service unavailable) directly on the error', () => {
      const err = Object.assign(new Error('Unavailable'), {
        $metadata: { httpStatusCode: 503 },
      });
      expect(isRetryableTransientError(err, 'Unavailable')).toBe(true);
    });

    it('retries on a wrapped cause carrying a 429', () => {
      const err = Object.assign(new Error('outer'), {
        cause: { $metadata: { httpStatusCode: 429 } },
      });
      expect(isRetryableTransientError(err, 'outer')).toBe(true);
    });

    it('does not retry on 400 (bad request) without a known message pattern', () => {
      const err = Object.assign(new Error('Bad input'), {
        $metadata: { httpStatusCode: 400 },
      });
      expect(isRetryableTransientError(err, 'Bad input')).toBe(false);
    });

    it('does not retry on 500 (internal error) without a known message pattern', () => {
      const err = Object.assign(new Error('Internal'), {
        $metadata: { httpStatusCode: 500 },
      });
      expect(isRetryableTransientError(err, 'Internal')).toBe(false);
    });
  });

  describe('message pattern based retries', () => {
    it.each([
      // IAM propagation
      ['cannot be assumed by Lambda', 'IAM propagation'],
      // Firehose-specific IAM propagation phrasing (surfaced by
      // log-pipeline integ on a fresh FirehoseDeliveryRole CREATE)
      [
        'Firehose is unable to assume role arn:aws:iam::111:role/FirehoseDeliveryRole. Please check the role provided.',
        'Firehose IAM propagation',
      ],
      // Glue Crawler / Job / Trigger same-stack role IAM-propagation race:
      // the Glue create is issued before the just-created role's trust policy
      // propagates to Glue's assume layer (surfaced by glue-update-hardening
      // integ on a fresh Crawler role CREATE). Note the capital-T "TrustPolicy"
      // is NOT matched by the lower-case 'trust policy' pattern.
      [
        'Service is unable to assume provided role. Please verify role\'s TrustPolicy.',
        'Glue assume-role IAM propagation',
      ],
      // Second AWS wording of the SAME Glue race, observed 2026-08-09 on the
      // same fixture: `the role <arn>` instead of `provided role`, which the
      // anchor above does not match.
      [
        "Failed to create Glue Crawler EventsCrawler: com.amazonaws.services.glue.model.AccessDeniedException: You need to enable AWS Security Token Service for this region. Service is unable to assume the role arn:aws:iam::111122223333:role/Stack-GlueRole to access null. Please verify the role's TrustPolicy.",
        'Glue assume-role IAM propagation (the-role wording)',
      ],
      // Third wording: Glue assumed the fresh role and the resulting session's
      // token is not valid yet. Anchored on the Java-SDK `(Service:` trailer so
      // only a SERVICE-wrapped error matches.
      [
        'Failed to create Glue Crawler EventsCrawler: The security token included in the request is invalid. (Service: AmazonDynamoDBv2; Status Code: 400; Error Code: UnrecognizedClientException; Request ID: abc; Proxy: null)',
        'Glue assumed-session token propagation',
      ],
      // Step Functions same-stack role IAM-propagation race: CreateStateMachine
      // is issued before the just-created role's trust policy propagates to
      // Step Functions' assume layer (surfaced by a bug-hunt sweep on an
      // Express state machine with LoggingConfiguration; pinned by the
      // stepfunctions-logging integ).
      [
        'Failed to create Step Functions state machine ExpressEE4D4F3B: Neither the global service principal states.amazonaws.com, nor the regional one is authorized to assume the provided role.',
        'Step Functions assume-role IAM propagation',
      ],
      ['The execution role you provided does not have permission', 'execution role'],
      ['Role validation failed', 'Role validation failed'],
      // CW Logs SubscriptionFilter (the bug we are fixing)
      [
        'AWS::Logs::SubscriptionFilter. Could not deliver test message to specified Kinesis stream. Check if the given Kinesis stream is in ACTIVE state.',
        'CW Logs SubscriptionFilter probe',
      ],
      // SQS same-name 60s recreation cooldown (rapid destroy/redeploy loops)
      [
        'You must wait 60 seconds after deleting a queue before you can create another with the same name.',
        'SQS 60s recreation cooldown',
      ],
      // DELETE race conditions
      ['DependencyViolation: resource has dependencies', 'DependencyViolation'],
      // KMS role propagation
      ['KMS key is invalid for CreateGrant', 'KMS CreateGrant'],
      // Eventual consistency
      ['Resource does not exist', 'eventual consistency'],
      // Lambda AddPermission concurrent update (multiple
      // Lambda::Permission for the same function dispatching in parallel)
      [
        'The function could not be updated due to a concurrent update operation. Please try again later.',
        'Lambda AddPermission concurrent update',
      ],
      // Lambda EventSourceMapping transient teardown lock (ResourceInUseException
      // on DeleteEventSourceMapping). Surfaced by the multi-resource real-AWS
      // sweep (2026-06-02); cleared on a manual destroy re-run.
      [
        'Failed to delete event source mapping abc-123: Cannot delete the event source mapping because it is in use.',
        'Lambda EventSourceMapping in-use teardown lock',
      ],
      // RDS Enhanced Monitoring same-stack role IAM-propagation race (#794):
      // CreateDBCluster/CreateDBInstance issued before the just-created
      // monitoring role propagates for the RDS monitoring service to assume.
      [
        'IAM role ARN value is invalid or does not include the required permissions for: ENHANCED_MONITORING',
        'RDS Enhanced Monitoring role IAM propagation',
      ],
      // ECS CapacityProvider same-stack infrastructure-role IAM-propagation
      // race (#805): Cloud Control CreateResource issued before the
      // just-created infrastructure role propagates for ECS to assume; the
      // handler surfaces it as a terminal InvalidRequest.
      [
        'Invalid request provided: CreateCapacityProvider error: Caught ServiceAccessDeniedException for ECSInfrastructureRole[arn:aws:iam::123456789012:role/RunnerStack-InfraRole] (Service: Ecs, Status Code: 400, Request ID: 00000000-0000-0000-0000-000000000000) (SDK Attempt Count: 1)',
        'ECS CapacityProvider infrastructure-role IAM propagation',
      ],
      // CodeDeploy DeploymentGroup same-stack service-role IAM-propagation
      // race: Cloud Control CreateResource issued before the just-created
      // service role's trust policy propagates for CodeDeploy to assume.
      // Exact wire message from a /hunt-bugs live deploy — note the word
      // order ("the permissions required") differs from the existing
      // 'does not have required permissions' pattern, which does NOT match.
      [
        'CREATE failed for DeploymentGroup6D277AF0: AWS CodeDeploy does not have the permissions required to assume the role arn:aws:iam::123456789012:role/MyStack-DeploymentGroupServiceRole. (Service: CodeDeploy, Status Code: 400, Request ID: 00000000-0000-0000-0000-000000000000) (SDK Attempt Count: 1)',
        'CodeDeploy DeploymentGroup service-role IAM propagation',
      ],
      // SNS TopicPolicy fresh-principal IAM-propagation race (#839):
      // SetTopicAttributes rejects a policy naming a just-created role as
      // Principal.AWS before IAM propagates it. Exact wire message wrapped in
      // SNSTopicPolicyProvider.create's thrown shape.
      [
        'Failed to create SNS topic policy StressTopicPolicy: Invalid parameter: Policy Error: PrincipalNotFound',
        'SNS TopicPolicy fresh-principal IAM propagation',
      ],
      // SQS QueuePolicy fresh-principal IAM-propagation race (#839): same
      // fresh-principal document as the SNS case, but SQS surfaces the race as
      // the less specific "Invalid value for the parameter Policy." Exact wire
      // message wrapped in SQSQueuePolicyProvider.create's thrown shape.
      [
        'Failed to create SQS queue policy StressQueuePolicy: Invalid value for the parameter Policy.',
        'SQS QueuePolicy fresh-principal IAM propagation',
      ],
      // KMS CreateKey fresh-principal IAM-propagation race (propagation-races-2):
      // the key policy names a just-created same-stack IAM role as a principal,
      // and KMS rejects CreateKey with MalformedPolicyDocumentException before
      // IAM propagates the role. A DIFFERENT consumer than the SNS/SQS policy
      // PUTs above (#839).
      [
        'MalformedPolicyDocumentException: Policy contains a statement with one or more invalid principals.',
        'KMS key-policy fresh-principal IAM propagation',
      ],
      // EC2 RunInstances / AssociateIamInstanceProfile fresh-instance-profile
      // propagation race (propagation-races-2): the instance references an
      // IAM instance profile created ~1s earlier in the same deploy, and EC2
      // rejects the launch/associate with "Invalid IAM Instance Profile name"
      // before the profile propagates to EC2's view.
      [
        "Invalid IAM Instance Profile name 'MyStack-InstanceProfile'",
        'EC2 fresh-instance-profile name propagation',
      ],
      [
        'Value (arn:aws:iam::123456789012:instance-profile/MyStack-InstanceProfile) for parameter Invalid IAM Instance Profile ARN is invalid',
        'EC2 fresh-instance-profile ARN propagation',
      ],
      // EMR RunJobFlow fresh-instance-profile propagation race (emr-cluster):
      // the cluster's JobFlowRole instance profile was created ~1s earlier in
      // the same deploy, and EMR rejects RunJobFlow with the ONE-WORD
      // "Invalid InstanceProfile: <name>." (no "IAM") before the profile
      // propagates to EMR's validation layer.
      [
        'Failed to create EMR Cluster Cluster: Invalid InstanceProfile: MyStack-EmrEc2InstanceProfile.',
        'EMR fresh-instance-profile propagation',
      ],
      // EMR AddInstanceGroups / RunJobFlow surfaces the SAME fresh-instance-
      // profile race with a different sentence when the profile exists but its
      // role membership has not propagated to EMR's authorization layer
      // (emr-instance-configs): "Failed to authorize instance profile <arn>."
      [
        'Failed to create EMR Cluster Cluster: Failed to authorize instance profile arn:aws:iam::123456789012:instance-profile/MyStack-EmrEc2InstanceProfile',
        'EMR fresh-instance-profile authorization propagation',
      ],
    ])('retries on %j (%s)', (message) => {
      expect(isRetryableTransientError(new Error(message), message)).toBe(true);
    });

    it('does not retry on a generic non-matching message', () => {
      const message = 'InvalidParameterValue: BucketName must be globally unique';
      expect(isRetryableTransientError(new Error(message), message)).toBe(false);
    });

    it('does not retry a plain CloudTrail authorization denial (#1160 anchor fence)', () => {
      // The CloudTrail IAM-propagation pattern is anchored on the full
      // "Verify in IAM that the role has adequate trust relationships"
      // sentence, NOT the bare "Access denied" prefix. This pins that
      // choice: broadening the anchor would make every CloudTrail
      // authorization failure burn the ~48s dense-retry budget before
      // surfacing, and no other test would notice.
      // Deliberately NOT the "not authorized to perform" phrasing — that
      // matches a pre-existing, broader propagation pattern, so it would
      // pass this fence for the wrong reason.
      const message = 'Access denied. Check the S3 bucket policy for the trail destination.';
      expect(isRetryableTransientError(new Error(message), message)).toBe(false);
      expect(isIamPropagationError(message)).toBe(false);
    });

    it('does not retry on cdkd OWN expired credentials (no service-wrapped trailer)', () => {
      // The load-bearing guard for the assumed-session-token pattern: the JS
      // SDK reports the developer's own expired SSO session with the SAME
      // sentence but NO Java-SDK `(Service: ...)` trailer. Retrying it would
      // burn ~48s before surfacing a condition that will never resolve.
      const message =
        'UnrecognizedClientException: The security token included in the request is invalid.';
      expect(isRetryableTransientError(new Error(message), message)).toBe(false);
    });

    it('does not retry on a non-transient EventSourceMapping not-found error', () => {
      // Guard against over-broadening: NotFound must NOT become retryable.
      const message = 'Failed to delete event source mapping abc-123: ResourceNotFoundException';
      expect(isRetryableTransientError(new Error(message), message)).toBe(false);
    });

    it('does not retry on a plain AccessDeniedException without the CC handler wording', () => {
      // Guard against over-broadening: a permanent permission error that lacks
      // the Cloud Control handler's "Caught ServiceAccessDeniedException"
      // anchor must NOT become retryable.
      const message =
        'AccessDeniedException: User: arn:aws:iam::123456789012:user/dev is missing permission ecs:CreateCapacityProvider';
      expect(isRetryableTransientError(new Error(message), message)).toBe(false);
    });

    it('does not retry on a syntactically wrong CloudFormation template error', () => {
      const message = 'Template format error: Unresolved resource dependencies';
      expect(isRetryableTransientError(new Error(message), message)).toBe(false);
    });

    it('does not retry on a permanently malformed resource policy without the #839 race anchor', () => {
      // Guard against over-broadening the #839 SNS/SQS patterns: a genuinely
      // malformed policy document (e.g. a JSON / structural validation error
      // that is NOT the fresh-principal propagation race) must NOT become
      // retryable just because it mentions a policy.
      const message =
        'Failed to create SNS topic policy MyTopicPolicy: Invalid parameter: Policy statement action out of service scope!';
      expect(isRetryableTransientError(new Error(message), message)).toBe(false);
    });

    it('retries a structurally-malformed SQS QueuePolicy carrying the #839 Policy-parameter phrase (accepted bounded-retry-then-surface tradeoff)', () => {
      // The #839 SQS pattern `Invalid value for the parameter Policy` is
      // intentionally BROAD: AWS emits that EXACT phrase for ANY malformed SQS
      // QueuePolicy, not just the fresh-principal IAM-propagation race. We
      // accept that a permanently-malformed QueuePolicy (e.g. a structurally
      // broken statement) is ALSO classified retryable here — it only burns the
      // bounded retries before surfacing the same error. This test PINS that
      // accepted tradeoff so a future narrowing of the pattern is a deliberate,
      // reviewed change rather than an accident. See issue #839.
      const message =
        'Failed to create SQS queue policy MyQueuePolicy: Invalid value for the parameter Policy.';
      expect(isRetryableTransientError(new Error(message), message)).toBe(true);
    });

    it('does not retry an SQS error that lacks the #839 Policy-parameter phrase', () => {
      // Guard the SQS boundary the other way: the broad `Invalid value for the
      // parameter Policy` substring must NOT over-broaden into other SQS
      // SetQueueAttributes validation errors. A generic attribute-validation
      // failure that does not contain the Policy-parameter phrase stays
      // non-retryable so a permanent misconfiguration fails fast.
      const message =
        'InvalidAttributeValue: Unknown attribute Foo for SetQueueAttributes';
      expect(isRetryableTransientError(new Error(message), message)).toBe(false);
    });

    it('does not retry an EC2 error that lacks the Invalid-IAM-Instance-Profile phrase', () => {
      // Guard the EC2 boundary: the fresh-instance-profile pattern is anchored
      // on "Invalid IAM Instance Profile", so an unrelated EC2 launch failure
      // (e.g. an insufficient-capacity error) stays non-retryable here and is
      // handled by the generic HTTP-status path instead of this message match.
      const capacity =
        'InsufficientInstanceCapacity: We currently do not have sufficient m5.large capacity in the AZ you requested';
      expect(isRetryableTransientError(new Error(capacity), capacity)).toBe(false);
    });

    it('does not retry a KMS error that lacks the invalid-principals propagation phrase', () => {
      // Guard the KMS boundary: the fresh-principal pattern is anchored on the
      // full "Policy contains a statement with one or more invalid principals"
      // phrase, so a clearly-different KMS error (a disabled key, a generic
      // validation failure) stays non-retryable and fails fast.
      const disabledKey = 'KMSInvalidStateException: KMS key is disabled';
      expect(isRetryableTransientError(new Error(disabledKey), disabledKey)).toBe(false);

      const genericValidation =
        'ValidationException: 1 validation error detected: value at keyUsage failed to satisfy constraint';
      expect(
        isRetryableTransientError(new Error(genericValidation), genericValidation)
      ).toBe(false);
    });

    it('does not retry a Glue error that lacks the assume-role propagation phrase', () => {
      // Guard the Glue boundary: the just-created-role propagation pattern is
      // anchored on "is unable to assume provided role", so an unrelated Glue
      // failure (a genuinely malformed job, a missing database) stays
      // non-retryable and fails fast rather than burning the bounded retries.
      const malformedJob =
        'InvalidInputException: Command name should be glueetl or pythonshell';
      expect(isRetryableTransientError(new Error(malformedJob), malformedJob)).toBe(false);

      const missingDb =
        'EntityNotFoundException: Database glueupdatehardeningstack-db not found';
      expect(isRetryableTransientError(new Error(missingDb), missingDb)).toBe(false);
    });

    it('does not retry an SFN error that lacks the assume-role propagation phrase', () => {
      // Guard the SFN boundary: the pattern is anchored on "authorized to
      // assume the provided role", so a different permanent SFN role problem
      // (e.g. the logging-destination access rejection, which says
      // "authorized to ACCESS", not "authorized to ASSUME") stays
      // non-retryable and fails fast rather than burning the bounded retries.
      const logAccess =
        'AccessDeniedException: The state machine IAM Role is not authorized to access the Log Destination';
      expect(isRetryableTransientError(new Error(logAccess), logAccess)).toBe(false);
    });
  });

  describe('throttling (name-based, HTTP 400 not 429)', () => {
    it('retries an SSM ThrottlingException (HTTP 400) by its error name', () => {
      // Real shape from SSM PutParameter under a wide burst: name is
      // ThrottlingException, status is 400 (not 429), message is "Rate exceeded".
      const err = Object.assign(new Error('Rate exceeded'), {
        name: 'ThrottlingException',
        $metadata: { httpStatusCode: 400 },
      });
      expect(isRetryableTransientError(err, err.message)).toBe(true);
    });

    it('retries when the throttling name is one cause-link deep (ProvisioningError wrap)', () => {
      // cdkd wraps the SDK error in a ProvisioningError; the throttling name
      // lives on the cause, and the wrapped message no longer says "Rate exceeded".
      const cause = Object.assign(new Error('Rate exceeded'), {
        name: 'ThrottlingException',
        $metadata: { httpStatusCode: 400 },
      });
      const wrapped = Object.assign(
        new Error('Failed to create SSM parameter WideParam54: something'),
        { name: 'ProvisioningError', cause }
      );
      expect(isRetryableTransientError(wrapped, wrapped.message)).toBe(true);
    });

    it('retries on the "Rate exceeded" message even when the name is lost', () => {
      // Defense-in-depth: the wrapped message preserves "Rate exceeded" so the
      // message-pattern backstop still fires if the name is not reachable.
      const msg =
        'Failed to create SSM parameter WideParam54: Rate exceeded. Ensure you have the high-throughput setting enabled for higher limits';
      expect(isRetryableTransientError(new Error(msg), msg)).toBe(true);
    });

    it('retries other canonical throttling names (TooManyRequestsException)', () => {
      const err = Object.assign(new Error('throttled'), {
        name: 'TooManyRequestsException',
        $metadata: { httpStatusCode: 400 },
      });
      expect(isRetryableTransientError(err, err.message)).toBe(true);
    });

    it('does not retry a non-throttling 400 whose name is not in the throttling set', () => {
      const err = Object.assign(new Error('parameter already exists'), {
        name: 'ParameterAlreadyExists',
        $metadata: { httpStatusCode: 400 },
      });
      expect(isRetryableTransientError(err, err.message)).toBe(false);
    });

    it('does not loop forever on a cyclic cause chain', () => {
      const a = Object.assign(new Error('a'), { name: 'NotThrottle' }) as Error & {
        cause?: unknown;
      };
      const b = Object.assign(new Error('b'), { name: 'AlsoNot', cause: a });
      a.cause = b; // cycle
      expect(isRetryableTransientError(a, 'unrelated')).toBe(false);
    });

    // Regression for the metadata-depth gap (PR #1093): the throttling NAME was
    // walked to depth 5 but the HTTP STATUS was only checked at depths 0 and 1,
    // so a 429 two cause-links deep fell through to the message table and was
    // treated as terminal. Folding the status check into the shared cause walk
    // fixed it; without this case, reverting that fold keeps the suite green.
    it('retries a 429 nested TWO cause-links deep (no throttling name anywhere)', () => {
      // Names are deliberately NOT in THROTTLING_ERROR_NAMES and the message
      // does not say "Rate exceeded", so the status is the ONLY retryable
      // signal — this fails unless the walk checks $metadata past depth 1.
      const inner = Object.assign(new Error('upstream rejected the request'), {
        name: 'SomeServiceException',
        $metadata: { httpStatusCode: 429 },
      });
      const middle = Object.assign(new Error('handler failed'), {
        name: 'HandlerError',
        cause: inner,
      });
      const outer = Object.assign(new Error('Failed to create resource Foo'), {
        name: 'ProvisioningError',
        cause: middle,
      });
      expect(isRetryableTransientError(outer, outer.message)).toBe(true);
    });

    it('retries a 503 nested two cause-links deep', () => {
      const inner = Object.assign(new Error('service unavailable'), {
        name: 'SomeServiceException',
        $metadata: { httpStatusCode: 503 },
      });
      const middle = Object.assign(new Error('wrap'), { name: 'Wrap', cause: inner });
      const outer = Object.assign(new Error('outer'), { name: 'ProvisioningError', cause: middle });
      expect(isRetryableTransientError(outer, outer.message)).toBe(true);
    });

    it('still does not retry a non-retryable status nested deep (500)', () => {
      const inner = Object.assign(new Error('internal error'), {
        name: 'SomeServiceException',
        $metadata: { httpStatusCode: 500 },
      });
      const middle = Object.assign(new Error('wrap'), { name: 'Wrap', cause: inner });
      const outer = Object.assign(new Error('outer'), { name: 'ProvisioningError', cause: middle });
      expect(isRetryableTransientError(outer, 'outer')).toBe(false);
    });
  });

  describe('name collision is NOT transient-retryable', () => {
    it('does not classify a bare "already exists" as transient (collision retries are site-scoped)', () => {
      // The collision matcher is deliberately kept OUT of the transient
      // pattern table: only the delete-then-re-create sites retry it.
      const message = 'Queue already exists: my-queue';
      expect(isRetryableTransientError(new Error(message), message)).toBe(false);
    });
  });

  describe('robustness', () => {
    it('handles non-Error inputs (string thrown) by falling back to message matching', () => {
      expect(
        isRetryableTransientError(
          'Could not deliver test message',
          'Could not deliver test message'
        )
      ).toBe(true);
    });

    it('handles plain objects without $metadata', () => {
      expect(isRetryableTransientError({}, 'unrelated')).toBe(false);
    });
  });
});

describe('isNameCollisionError', () => {
  it.each([
    // SQS CreateQueue against a name still held by another queue
    ['A queue already exists with the same name and a different value for attribute Foo', 'SQS'],
    // Case-insensitive match ("Already Exists" / "ALREADY EXISTS" variants)
    ['Resource Already Exists', 'case-insensitive phrase'],
    // Error-code style with no spaces (Lambda / S3 / SSM shapes)
    ['ResourceAlreadyExistsException: function my-fn', 'AlreadyExists error-code style'],
    ['ParameterAlreadyExists', 'SSM parameter'],
    // Provider-wrapped message (cdkd wraps the SDK error text)
    ['Failed to create S3 bucket MyBucket: BucketAlreadyExists', 'provider-wrapped'],
  ])('matches %j (%s)', (message) => {
    expect(isNameCollisionError(message)).toBe(true);
  });

  it.each([
    // A generic conflict that is NOT a name collision
    ['OperationAborted: A conflicting conditional operation is in progress', 'S3 conflict'],
    // "exists" alone must not match
    ['The specified bucket does not exist', 'not-found'],
    // Lowercase run-on ("alreadyexists") is not an AWS shape; stay strict
    ['resource alreadyexists', 'run-on lowercase'],
  ])('does not match %j (%s)', (message) => {
    expect(isNameCollisionError(message)).toBe(false);
  });
});

describe('isNameCooldownError', () => {
  it.each([
    // Error-code style (wrapped SDK error name)
    ['AWS.SimpleQueueService.QueueDeletedRecently: try again later', 'error-code style'],
    // Full wire message form
    [
      'You must wait 60 seconds after deleting a queue before you can create another with the same name.',
      'wire message',
    ],
    // Provider-wrapped message
    [
      'Failed to create SQS queue MyQueue: You must wait 60 seconds after deleting a queue before you can create another with the same name.',
      'provider-wrapped',
    ],
  ])('matches %j (%s)', (message) => {
    expect(isNameCooldownError(message)).toBe(true);
  });

  it.each([
    // A collision is NOT a cooldown (kept separate on purpose: deleting the
    // new resource cannot release a cooldown)
    ['Queue already exists', 'collision'],
    ['AccessDenied: not authorized', 'permanent failure'],
    // A different wait duration must not match the anchored phrase
    ['please wait a few seconds and retry', 'generic wait advice'],
  ])('does not match %j (%s)', (message) => {
    expect(isNameCooldownError(message)).toBe(false);
  });
});

describe('isRecreateRetryableError', () => {
  it('accepts both the collision and the cooldown signatures', () => {
    expect(isRecreateRetryableError('Queue already exists')).toBe(true);
    expect(isRecreateRetryableError('ResourceAlreadyExistsException')).toBe(true);
    expect(
      isRecreateRetryableError(
        'You must wait 60 seconds after deleting a queue before you can create another with the same name.'
      )
    ).toBe(true);
    expect(isRecreateRetryableError('QueueDeletedRecently')).toBe(true);
  });

  it('rejects unrelated failures', () => {
    expect(isRecreateRetryableError('AccessDenied: not authorized')).toBe(false);
    expect(isRecreateRetryableError('Rate exceeded')).toBe(false);
  });
});

describe('isIamPropagationError', () => {
  it.each([
    // EC2 RunInstances against a just-created instance profile (the measured
    // ~10s-of-backoff case).
    [
      'Value (BenchEc2-Instance1InstanceProfileC04770B7) for parameter iamInstanceProfile.name is invalid. Invalid IAM Instance Profile name',
      'EC2 fresh instance profile',
    ],
    ['The role defined for the function cannot be assumed by Lambda.', 'Lambda exec role'],
    ['Service is unable to assume provided role. Please verify role TrustPolicy', 'Glue'],
    ['Service is unable to assume the role arn:aws:iam::1:role/r to access null.', 'Glue the-role'],
    [
      'The security token included in the request is invalid. (Service: AmazonDynamoDBv2; Error Code: UnrecognizedClientException)',
      'Glue assumed-session token',
    ],
    ['User: arn:aws:iam::1:user/x is not authorized to perform: sts:AssumeRole', 'authz'],
    ['Invalid principal in policy', 'S3 bucket policy'],
    ['Invalid parameter: Policy Error: PrincipalNotFound', 'SNS topic policy'],
    ['Caught ServiceAccessDeniedException for ECSInfrastructureRole[arn:...]', 'ECS CC API'],
    ['Invalid InstanceProfile: EmrRole.', 'EMR'],
    ['Failed to authorize instance profile arn:aws:iam::1:instance-profile/p.', 'EMR authorize'],
    // IAM-to-IAM eventual consistency: CreateAccessKey right after the same
    // deploy's CreateUser (issue #1323 — User + AccessKey in one stack).
    [
      'NoSuchEntity: The user with name cdkd-iam-access-key-user cannot be found.',
      'IAM per-user write racing CreateUser',
    ],
    // SNS delivery-status feedback role created ~1s earlier in the same stack
    // (issue #1160 sns batch — sns-sqs-event fixture).
    [
      'Invalid parameter: LambdaSuccessFeedbackRoleArn: arn:aws:iam::1:role/r is not a valid role to allow SNS to write to Cloudwatch Logs',
      'SNS delivery-status feedback role',
    ],
    // CloudTrail CloudWatch Logs delivery role created ~1s earlier in the same
    // stack (issue #1160 cloudtrail batch — cloudtrail-trail fixture). The live
    // CFn A/B passed with this same trust policy because CFn is slower.
    [
      'Failed to create CloudTrail Trail Trail: Access denied. Verify in IAM that the role has adequate trust relationships.',
      'CloudTrail CW Logs delivery role',
    ],
  ])('classifies %j as IAM propagation (%s)', (message) => {
    expect(isIamPropagationError(message)).toBe(true);
    // Cadence selection must never widen retryability.
    expect(isRetryableTransientError(new Error(message), message)).toBe(true);
  });

  it.each([
    // Retryable, but NOT propagation — these want exponential backoff.
    ['Rate exceeded. Ensure you have the high-throughput setting enabled', 'throttle'],
    ['The function is currently in the following state: Pending', 'Lambda Pending'],
    ['The vpc has dependencies and cannot be deleted.', 'DependencyViolation'],
    [
      'You must wait 60 seconds after deleting a queue before you can create another with the same name.',
      'SQS cooldown',
    ],
    ['The function could not be updated due to a concurrent update operation', 'Lambda lock'],
  ])('does not classify %j as IAM propagation (%s)', (message) => {
    expect(isIamPropagationError(message)).toBe(false);
    expect(isRetryableTransientError(new Error(message), message)).toBe(true);
  });

  it('does not classify a permanent failure as IAM propagation', () => {
    expect(isIamPropagationError('ValidationError: image id is malformed')).toBe(false);
  });

  it('does not let the "The user with name" pattern catch the already-exists collision phrasing', () => {
    // IAM's EntityAlreadyExists reads "User with name X already exists." (no
    // leading "The") — it must stay non-retryable, not burn propagation
    // retries.
    const message = 'EntityAlreadyExists: User with name cdkd-user already exists.';
    expect(isIamPropagationError(message)).toBe(false);
    expect(isRetryableTransientError(new Error(message), message)).toBe(false);
  });
});

describe('RETRYABLE_ERROR_MESSAGE_PATTERNS composition', () => {
  it('is the union of the IAM-propagation subset and the rest, with no duplicates', () => {
    const all = RETRYABLE_ERROR_MESSAGE_PATTERNS;
    expect(new Set(all).size).toBe(all.length);
    for (const p of IAM_PROPAGATION_ERROR_MESSAGE_PATTERNS) {
      expect(all).toContain(p);
    }
    // The subset is a strict subset — the non-propagation half is non-empty.
    expect(IAM_PROPAGATION_ERROR_MESSAGE_PATTERNS.length).toBeLessThan(all.length);
  });

  it('every IAM-propagation pattern is retryable through the shared classifier', () => {
    for (const p of IAM_PROPAGATION_ERROR_MESSAGE_PATTERNS) {
      const message = `AWS says: ${p} (details)`;
      expect(isRetryableTransientError(new Error(message), message)).toBe(true);
      expect(isIamPropagationError(message)).toBe(true);
    }
  });
});

describe('Redshift post-snapshot busy state (#1353)', () => {
  it('classifies "There is an operation running on the Cluster" as retryable', () => {
    const msg =
      'DELETE failed for Warehouse: There is an operation running on the Cluster. Please try ' +
      'to delete it at a later time. (Service: Redshift, Status Code: 400)';
    expect(isRetryableTransientError(new Error(msg), msg)).toBe(true);
  });

  it('does not classify an unrelated Redshift 400 as retryable', () => {
    const msg =
      'CREATE failed for Warehouse: The parameter ClusterIdentifier is not a valid identifier.';
    expect(isRetryableTransientError(new Error(msg), msg)).toBe(false);
  });
});

describe('Route 53 AcceleratedRecovery mutation lock (#1467)', () => {
  it('classifies "is marked disabled for mutation" as retryable', () => {
    const msg =
      'Failed to delete record set CidrRecord: HostedZone Z08017982576KEDFB5RGZ is marked disabled for mutation';
    expect(isRetryableTransientError(new Error(msg), msg)).toBe(true);
  });

  it('keeps the pattern out of the dense IAM-propagation cadence', () => {
    expect(isIamPropagationError('HostedZone Z1 is marked disabled for mutation')).toBe(false);
  });
});

describe('API Gateway v2 per-API mutation contention (#1607)', () => {
  // Verbatim from two consecutive live runs (2026-08-11, us-east-1) of the
  // apigatewayv2-update-removal fixture: the failure moved between resources
  // across runs, which is the signature of contention rather than a bad
  // request. API Gateway v2 serializes mutations per API while cdkd deploys
  // siblings of one ApiId in parallel by design.
  const routeMsg =
    'Failed to create API Gateway V2 Route WsDefaultRoute: Unable to complete operation due to concurrent modification. Please try again later.';
  const stageMsg =
    'Failed to create API Gateway V2 Stage Stage: Unable to complete operation due to concurrent modification. Please try again later.';

  it.each([routeMsg, stageMsg])('classifies the concurrent-modification 400 as retryable', (m) => {
    expect(isRetryableTransientError(new Error(m), m)).toBe(true);
  });

  it('keeps the pattern out of the dense IAM-propagation cadence', () => {
    // This is load-shaped contention: the service is asking for backoff, so
    // the dense sub-second grid would make it worse.
    expect(isIamPropagationError(routeMsg)).toBe(false);
  });

  it('does not classify an unrelated API Gateway 400 as retryable', () => {
    const msg = 'Failed to create API Gateway V2 Route R: Invalid route key specified';
    expect(isRetryableTransientError(new Error(msg), msg)).toBe(false);
  });
});
