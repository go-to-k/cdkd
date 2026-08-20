/**
 * Issue #2040 — a provider's wrapped AWS failure must classify the SAME way
 * whichever provider raised it.
 *
 * cdkd's three transient-error classifiers all read the AWS error through the
 * `.cause` chain, so a provider `catch` site that builds a `ProvisioningError`
 * without threading the caught value makes all three INERT: the identical AWS
 * failure is retryable in one provider and terminal in another.
 *
 * The error here is built the way PRODUCTION builds it — a real AWS SDK
 * `ServiceException` subclass carrying `$metadata.httpStatusCode`, which is the
 * only field `isTransientServerError` reads. A hand-rolled `{ $metadata }`
 * stub would satisfy the classifier while proving nothing about the shape the
 * SDK actually throws.
 *
 * The DISCRIMINATOR asserted throughout is the CLASSIFIER'S VERDICT, not that
 * an error was thrown — the pre-fix code throws too.
 */
import { IAMServiceException } from '@aws-sdk/client-iam';
import { SQSServiceException } from '@aws-sdk/client-sqs';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';

const mockSend = vi.fn();

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    sqs: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
    iam: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
  }),
}));

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  return {
    getLogger: () => ({
      child: () => childLogger,
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  };
});

import {
  isMarkedNonRetryable,
  isRetryableTransientError,
  isThrottlingError,
  isTransientServerError,
  markNonRetryable,
} from '../../../src/deployment/retryable-errors.js';
import { IAMRoleProvider } from '../../../src/provisioning/providers/iam-role-provider.js';
import { SQSQueuePolicyProvider } from '../../../src/provisioning/providers/sqs-queue-policy-provider.js';
import { ProvisioningError } from '../../../src/utils/error-handler.js';

/**
 * The measured shape of the failure that motivated issue #2026: SQS answered a
 * mid-propagation call with HTTP 500 and an EMPTY body, so the SDK substituted
 * its `UnknownError` placeholder and every message pattern had nothing to
 * match. `$metadata.httpStatusCode` is the ONLY surviving signal — and it lives
 * on the AWS error, reachable only through `.cause`.
 */
function awsServerError(): SQSServiceException {
  return new SQSServiceException({
    name: 'UnknownError',
    $fault: 'server',
    $metadata: { httpStatusCode: 500, requestId: 'req-2040' },
    message: 'UnknownError',
  });
}

function awsThrottleError(): IAMServiceException {
  return new IAMServiceException({
    name: 'ThrottlingException',
    $fault: 'client',
    $metadata: { httpStatusCode: 400, requestId: 'req-2040-throttle' },
    message: 'Rate exceeded',
  });
}

/** Every classifier's verdict for one error — the unit compared throughout. */
function classify(error: unknown): Record<string, boolean> {
  const message = error instanceof Error ? error.message : String(error);
  return {
    transientServer: isTransientServerError(error),
    throttling: isThrottlingError(error),
    markedNonRetryable: isMarkedNonRetryable(error),
    retryable: isRetryableTransientError(error, message),
  };
}

async function captureThrown(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error('expected the provider to throw');
}

describe('#2040 — two real providers classify the same AWS error identically', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /**
   * `SQSQueuePolicyProvider` is the issue's named reference site (it binds
   * `const cause = error instanceof Error ? error : undefined` before the
   * throw); `IAMRoleProvider` is an independent file and an independent
   * service. If either dropped its cause, the two verdicts would diverge.
   */
  async function sqsPolicyFailure(awsError: Error): Promise<unknown> {
    mockSend.mockRejectedValue(awsError);
    return captureThrown(() =>
      new SQSQueuePolicyProvider().create('Policy', 'AWS::SQS::QueuePolicy', {
        Queues: ['https://sqs.us-east-1.amazonaws.com/123456789012/q'],
        PolicyDocument: { Version: '2012-10-17', Statement: [] },
      })
    );
  }

  async function iamRoleFailure(awsError: Error): Promise<unknown> {
    mockSend.mockRejectedValue(awsError);
    return captureThrown(() =>
      new IAMRoleProvider().create('Role', 'AWS::IAM::Role', {
        AssumeRolePolicyDocument: { Version: '2012-10-17', Statement: [] },
      })
    );
  }

  it('both wrap the AWS error in a ProvisioningError that still carries it as `cause`', async () => {
    const sqs = await sqsPolicyFailure(awsServerError());
    const iam = await iamRoleFailure(awsServerError());

    for (const thrown of [sqs, iam]) {
      expect(thrown).toBeInstanceOf(ProvisioningError);
      expect((thrown as ProvisioningError).cause).toBeInstanceOf(SQSServiceException);
    }
  });

  it('classifies an HTTP 500 identically — and as RETRYABLE, through the wrapper', async () => {
    const sqs = classify(await sqsPolicyFailure(awsServerError()));
    const iam = classify(await iamRoleFailure(awsServerError()));

    expect(sqs).toEqual(iam);
    // The verdict itself, not merely agreement: an empty-bodied 500 has no
    // message for any pattern to match, so `$metadata` down the cause chain is
    // the whole signal.
    expect(sqs).toEqual({
      transientServer: true,
      throttling: false,
      markedNonRetryable: false,
      retryable: true,
    });
  });

  it('classifies a throttle identically through both providers', async () => {
    const sqs = classify(await sqsPolicyFailure(awsThrottleError()));
    const iam = classify(await iamRoleFailure(awsThrottleError()));

    expect(sqs).toEqual(iam);
    expect(sqs.throttling).toBe(true);
    expect(sqs.retryable).toBe(true);
  });

  it('propagates a cdkd non-retryable marker identically through both providers', async () => {
    const marked = () => markNonRetryable(awsServerError());

    const sqs = classify(await sqsPolicyFailure(marked()));
    const iam = classify(await iamRoleFailure(marked()));

    expect(sqs).toEqual(iam);
    // `isMarkedNonRetryable` is consulted BEFORE any status or message
    // heuristic, so the marker must beat the 500 that is also present.
    expect(sqs.markedNonRetryable).toBe(true);
    expect(sqs.retryable).toBe(false);
  });
});

describe('#2040 — the discriminator: dropping the cause FLIPS every verdict', () => {
  /**
   * The negative control. Without it these tests would pass over a provider
   * that dropped its cause too, because both shapes throw a
   * `ProvisioningError` with the same message — the pre-fix defect is silent
   * at the throw and visible only at the classifier.
   */
  const message = 'Failed to create SQS queue policy Policy: UnknownError';

  it('a wrapper that THREADS the cause is retryable', () => {
    const aws = awsServerError();
    const threaded = new ProvisioningError(message, 'AWS::SQS::QueuePolicy', 'Policy', 'q', aws);

    expect(classify(threaded)).toEqual({
      transientServer: true,
      throttling: false,
      markedNonRetryable: false,
      retryable: true,
    });
  });

  it('the SAME wrapper with the cause DROPPED is terminal', () => {
    const dropped = new ProvisioningError(message, 'AWS::SQS::QueuePolicy', 'Policy', 'q');

    expect(classify(dropped)).toEqual({
      transientServer: false,
      throttling: false,
      markedNonRetryable: false,
      retryable: false,
    });
  });

  it('a dropped cause also hides a throttle and a non-retryable marker', () => {
    const throttle = awsThrottleError();
    expect(isThrottlingError(new ProvisioningError('x', 't', 'l', 'p', throttle))).toBe(true);
    expect(isThrottlingError(new ProvisioningError('x', 't', 'l', 'p'))).toBe(false);

    const marked = markNonRetryable(awsServerError());
    expect(isMarkedNonRetryable(new ProvisioningError('x', 't', 'l', 'p', marked))).toBe(true);
    expect(isMarkedNonRetryable(new ProvisioningError('x', 't', 'l', 'p'))).toBe(false);
  });
});

describe('#2040 — every cause-threading SPELLING in the tree classifies identically', () => {
  /**
   * The providers tree carries three spellings of the same thread. They must
   * not be three different behaviours, or "which provider raised it" would
   * still decide retryability.
   */
  it('const-binding, inline conditional and bare identifier agree', () => {
    const aws: unknown = awsServerError();

    // 1. `const cause = error instanceof Error ? error : undefined;` (the
    //    reference site, and ~382 of the tree's sites).
    const cause = aws instanceof Error ? aws : undefined;
    const viaConst = new ProvisioningError('x', 't', 'l', 'p', cause);

    // 2. The same expression inline at the argument (13 sites).
    const viaInline = new ProvisioningError(
      'x',
      't',
      'l',
      'p',
      aws instanceof Error ? aws : undefined
    );

    // 3. The bare identifier, inside an `instanceof` narrowed branch
    //    (ecr-provider's RepositoryNotEmptyException arm).
    const viaBare = aws instanceof Error ? new ProvisioningError('x', 't', 'l', 'p', aws) : undefined;

    const verdicts = [viaConst, viaInline, viaBare].map(classify);
    expect(verdicts[0]).toEqual(verdicts[1]);
    expect(verdicts[0]).toEqual(verdicts[2]);
    expect(verdicts[0]?.retryable).toBe(true);
  });
});
