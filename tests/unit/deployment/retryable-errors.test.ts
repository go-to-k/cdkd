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
