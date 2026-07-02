import { describe, it, expect } from 'vite-plus/test';
import { isRetryableTransientError } from '../../../src/deployment/retryable-errors.js';

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
    ])('retries on %j (%s)', (message) => {
      expect(isRetryableTransientError(new Error(message), message)).toBe(true);
    });

    it('does not retry on a generic non-matching message', () => {
      const message = 'InvalidParameterValue: BucketName must be globally unique';
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
