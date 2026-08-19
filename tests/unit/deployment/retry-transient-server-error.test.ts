import { describe, it, expect, vi } from 'vite-plus/test';
import { withRetry } from '../../../src/deployment/retry.js';
import {
  isRetryableTransientError,
  markNonRetryable,
  isThrottlingError,
  isTransientServerError,
  TRANSIENT_SERVER_ERROR_STATUS_CODES,
} from '../../../src/deployment/retryable-errors.js';
import { ProvisioningError } from '../../../src/utils/error-handler.js';

/**
 * Issue #2026: a healthy IAM-propagation sequence was terminated at ~12% of its
 * budget by ONE transient server error.
 *
 * MEASURED against real AWS, not constructed from a hypothesis
 * (`tests/integration/iam-propagation-stress`, us-east-1, 2026-08-19 08:57:30Z):
 *
 *   StressQueuePolicyDC3E35C3: gave up after 5 IAM-propagation retries over
 *   5.75s of propagation backoff - Failed to create SQS queue policy
 *   StressQueuePolicyDC3E35C3: UnknownError
 *   [name=InternalFailure http=500 requestId=ebf581cc-6072-5ffc-943a-e33312488615]
 *
 * Attempts 1-5 carried `Invalid value for the parameter Policy.` and classified
 * cleanly. Attempt 6 was an HTTP 500 `InternalFailure` whose body had no message
 * text, so the SDK substituted its `UnknownError` placeholder -- which matches
 * no message pattern, and 500 was in no status set. `withRetry` therefore took
 * its `!retryable` arm and threw, discarding 42s of budget the sequence needed
 * roughly 10s of.
 *
 * The fixtures below reproduce that exact error shape.
 */

/** The shape SQS actually returned, per the capture above. */
const awsInternalFailure = (): Error => {
  const e = new Error('UnknownError');
  e.name = 'InternalFailure';
  (e as unknown as { $metadata: unknown }).$metadata = {
    httpStatusCode: 500,
    requestId: 'ebf581cc-6072-5ffc-943a-e33312488615',
  };
  return e;
};

/** ...as `sqs-queue-policy-provider.ts` rethrows it. */
const wrapped = (aws: Error): ProvisioningError =>
  new ProvisioningError(
    `Failed to create SQS queue policy StressQueuePolicyDC3E35C3: ${aws.message}`,
    'AWS::SQS::QueuePolicy',
    'StressQueuePolicyDC3E35C3',
    'https://sqs.us-east-1.amazonaws.com/1/StressQueue',
    aws
  );

const propagationError = (): ProvisioningError => {
  const e = new Error('Invalid value for the parameter Policy.');
  e.name = 'InvalidAttributeValue';
  (e as unknown as { $metadata: unknown }).$metadata = { httpStatusCode: 400 };
  return wrapped(e);
};

const makeLogger = () => ({
  debug: vi.fn<(message: string) => void>(),
  warn: vi.fn<(message: string) => void>(),
});

describe('isTransientServerError (issue #2026)', () => {
  it('finds the status through the provider wrapper, where the message is useless', () => {
    const err = wrapped(awsInternalFailure());
    // The message the classifier would otherwise see carries no signal at all.
    expect(err.message).toContain('UnknownError');
    expect(isTransientServerError(err)).toBe(true);
    expect(isRetryableTransientError(err, err.message)).toBe(true);
  });

  it('covers the whole SDK transient set and nothing outside it', () => {
    // Mirrors @smithy/service-error-classification's TRANSIENT_ERROR_STATUS_CODES.
    expect([...TRANSIENT_SERVER_ERROR_STATUS_CODES].sort((a, b) => a - b)).toEqual([
      500, 502, 503, 504,
    ]);
    for (const status of [500, 502, 503, 504]) {
      const e = new Error('UnknownError');
      (e as unknown as { $metadata: unknown }).$metadata = { httpStatusCode: status };
      expect(isTransientServerError(wrapped(e))).toBe(true);
    }
    // 501 Not Implemented is excluded by the SDK too: it is a permanent
    // "this service cannot do that", and retrying it burns the budget on a
    // request that can never succeed.
    for (const status of [400, 403, 404, 409, 501]) {
      const e = new Error('nope');
      (e as unknown as { $metadata: unknown }).$metadata = { httpStatusCode: status };
      expect(isTransientServerError(wrapped(e))).toBe(false);
    }
  });

  it('leaves isThrottlingError narrow, so the seven throttle-only call sites are unchanged', () => {
    // Seven `isRetryable` call sites across four files pass `isThrottlingError`
    // as a deliberately narrow classifier: `describe-type.ts:67`,
    // `dynamodb-globaltable-provider.ts` (x4), `export.ts:1744` and
    // `intrinsic-function-resolver.ts:5216`. Three FURTHER sites call it as a
    // bare classification -- `drift.ts:518`, `export.ts:1755`,
    // `dynamodb-index-busy-delete.ts:381` -- and they make the case stronger:
    // `drift.ts` would start reporting "cannot compare" for a resource whose
    // read merely 500'd. Had the fix widened RETRYABLE_HTTP_STATUS_CODES
    // instead of adding a separate set, all ten would have changed behavior.
    // This is the assertion that fails if someone later "simplifies" the two
    // sets into one.
    const err = wrapped(awsInternalFailure());
    expect(isThrottlingError(err)).toBe(false);

    // ...while the statuses that genuinely ARE throttle signals still are.
    const throttled = new Error('Rate exceeded');
    (throttled as unknown as { $metadata: unknown }).$metadata = { httpStatusCode: 429 };
    expect(isThrottlingError(wrapped(throttled))).toBe(true);
  });
});

describe('isTransientServerError interaction with the non-retryable marker (issue #2026)', () => {
  it('a marked refusal stays terminal even when it carries a transient status', () => {
    // Ordering invariant inside `isRetryableTransientError`: the marker is
    // checked FIRST, ahead of every heuristic, because it states the error
    // cannot succeed on a retry. Hoisting the new status check above it left
    // the whole suite green, so the invariant had no test of its own.
    const e = new Error('deliberate cdkd refusal');
    (e as unknown as { $metadata: unknown }).$metadata = { httpStatusCode: 500 };
    markNonRetryable(e);
    expect(isTransientServerError(e)).toBe(true);
    expect(isRetryableTransientError(e, e.message)).toBe(false);
  });
});

describe('withRetry survives the measured 500 mid-propagation (issue #2026)', () => {
  it('completes the sequence instead of giving up at 12% of the budget', async () => {
    const logger = makeLogger();
    let attempt = 0;
    const op = vi.fn().mockImplementation(async () => {
      attempt++;
      if (attempt <= 5) throw propagationError();
      if (attempt === 6) throw wrapped(awsInternalFailure()); // the measured attempt 6
      return 'created';
    });

    // The RESOLVED VALUE is the discriminator: a test asserting only the call
    // count would also pass against a loop that made the calls and then threw.
    await expect(
      withRetry(op, 'StressQueuePolicyDC3E35C3', { logger, sleep: () => Promise.resolve() })
    ).resolves.toBe('created');
    expect(op).toHaveBeenCalledTimes(7);
    // ...and nothing gave up, so no summary line was emitted at all.
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('still reports the status when a sequence does exhaust its budget', async () => {
    // The instrumentation half of the fix: the give-up line is what turned this
    // issue from "a sequence ended early for unknown reasons" into a captured
    // name + status + request id on the FIRST occurrence. Without it the branch
    // could not have been chosen, so it is pinned alongside the behavior.
    const logger = makeLogger();
    const op = vi.fn().mockImplementation(async () => {
      throw propagationError();
    });

    await expect(
      withRetry(op, 'StressQueuePolicyDC3E35C3', { logger, sleep: () => Promise.resolve() })
    ).rejects.toThrow('Invalid value for the parameter Policy.');

    const warnText = logger.warn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(warnText).toContain('(the full propagation budget)');
    expect(warnText).toContain('[name=InvalidAttributeValue http=400]');
  });
});

describe('the 5xx retry class is reachable and legible beyond the propagation path (issue #2026)', () => {
  it.each([502, 504])('retries a %i end-to-end through withRetry, not just in the predicate', async (status) => {
    // The predicate is looped over all four statuses above; this is the arm
    // that proves the whole path (classifier -> withRetry -> resolve) works for
    // the siblings of the one status that was actually measured.
    const logger = makeLogger();
    let attempt = 0;
    const op = vi.fn().mockImplementation(async () => {
      attempt++;
      if (attempt === 1) {
        const e = new Error('UnknownError');
        e.name = 'InternalFailure';
        (e as unknown as { $metadata: unknown }).$metadata = { httpStatusCode: status };
        throw wrapped(e);
      }
      return 'created';
    });

    await expect(
      withRetry(op, 'Res', { logger, sleep: () => Promise.resolve() })
    ).resolves.toBe('created');
    expect(op).toHaveBeenCalledTimes(2);
  });

  it('retries a 500 on the DELETE-shaped explicit schedule too', async () => {
    // `deploy-engine.ts` passes `maxRetries` / `initialDelayMs` for deletes,
    // which opts OUT of the dense propagation schedule but NOT out of the
    // default classifier -- so this change alters delete behavior as well as
    // create. Pinning it here because that is deletion-path behavior, and
    // nothing else in the suite covers it.
    const logger = makeLogger();
    let attempt = 0;
    const op = vi.fn().mockImplementation(async () => {
      attempt++;
      if (attempt === 1) {
        const e = new Error('UnknownError');
        e.name = 'InternalFailure';
        (e as unknown as { $metadata: unknown }).$metadata = { httpStatusCode: 500 };
        throw wrapped(e);
      }
      return 'deleted';
    });

    await expect(
      withRetry(op, 'Res', {
        logger,
        maxRetries: 3,
        initialDelayMs: 5_000,
        sleep: () => Promise.resolve(),
      })
    ).resolves.toBe('deleted');
    expect(op).toHaveBeenCalledTimes(2);
  });

  it('reports a give-up that spent only 5xx retries, instead of failing silently', async () => {
    // Without this the new class is INVISIBLE at default verbosity: a sequence
    // that burns its whole budget on 5xx rethrows the raw AWS error with
    // nothing printed -- the exact silence issue #2018 removed for the
    // propagation class, reintroduced by making a second class retryable.
    const logger = makeLogger();
    const op = vi.fn().mockImplementation(async () => {
      const e = new Error('UnknownError');
      e.name = 'InternalFailure';
      (e as unknown as { $metadata: unknown }).$metadata = { httpStatusCode: 503 };
      throw wrapped(e);
    });

    await expect(
      withRetry(op, 'Res', { logger, sleep: () => Promise.resolve() })
    ).rejects.toThrow('UnknownError');

    const warnText = logger.warn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(warnText).toContain('gave up after 8 transient server-error retries (HTTP 5xx)');
    expect(warnText).toContain('[name=InternalFailure http=503]');
    // ...and it must NOT claim propagation work it never did.
    expect(warnText).not.toContain('IAM-propagation');
  });
});

describe('the give-up line accounts for BOTH retry kinds (issue #2026)', () => {
  const propagationWith5xx = (): ProvisioningError => {
    // Both at once: a propagation MESSAGE and a transient status. The two
    // counters must stay mutually exclusive, or a single error advances both.
    const e = new Error('Invalid value for the parameter Policy.');
    e.name = 'InternalFailure';
    (e as unknown as { $metadata: unknown }).$metadata = { httpStatusCode: 503 };
    return wrapped(e);
  };

  it('counts an error that is BOTH propagation and 5xx once, as propagation', async () => {
    const logger = makeLogger();
    const op = vi.fn().mockImplementation(async () => {
      throw propagationWith5xx();
    });

    await expect(
      withRetry(op, 'Res', { logger, sleep: () => Promise.resolve() })
    ).rejects.toThrow('Invalid value');

    const warnText = logger.warn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(warnText).toContain('gave up after 26 IAM-propagation retries');
    // Dropping the `else` would add a second, contradictory clause here.
    expect(warnText).not.toContain('transient server-error');
  });

  it('reports both kinds, joined, when a sequence spent both', async () => {
    // Nothing else exercises `spent.join(' and ')`: truncating the array to its
    // first element passed the whole suite.
    const logger = makeLogger();
    let attempt = 0;
    const op = vi.fn().mockImplementation(async () => {
      attempt++;
      // Two propagation attempts, then 5xx for the rest of the budget.
      if (attempt <= 2) throw propagationError();
      const e = new Error('UnknownError');
      e.name = 'InternalFailure';
      (e as unknown as { $metadata: unknown }).$metadata = { httpStatusCode: 500 };
      throw wrapped(e);
    });

    await expect(
      withRetry(op, 'Res', { logger, sleep: () => Promise.resolve() })
    ).rejects.toThrow('UnknownError');

    const warnText = logger.warn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(warnText).toContain(
      '2 IAM-propagation retries over 0.75s of propagation backoff (the full propagation budget) and 24 transient server-error retries (HTTP 5xx)'
    );
  });

  it('uses the singular for exactly one 5xx retry', async () => {
    const logger = makeLogger();
    let attempt = 0;
    const op = vi.fn().mockImplementation(async () => {
      attempt++;
      if (attempt === 1) {
        const e = new Error('UnknownError');
        e.name = 'InternalFailure';
        (e as unknown as { $metadata: unknown }).$metadata = { httpStatusCode: 500 };
        throw wrapped(e);
      }
      throw new ProvisioningError('terminal', 'AWS::SQS::QueuePolicy', 'Res', 'url');
    });

    await expect(withRetry(op, 'Res', { logger, sleep: () => Promise.resolve() })).rejects.toThrow(
      'terminal'
    );
    const warnText = logger.warn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(warnText).toContain('gave up after 1 transient server-error retry (HTTP 5xx)');
  });

  it('does NOT report a 5xx retry spent under a caller-supplied classifier', async () => {
    // `RETRYABLE_HTTP_STATUS_CODES` already contains 503, so the throttle-only
    // call sites retry one today. Counting it here printed a default-level
    // `warn` on graceful-degradation paths that previously printed nothing,
    // and mislabelled the sequence -- so the counter is gated on the caller
    // NOT having supplied its own classifier.
    const logger = makeLogger();
    const op = vi.fn().mockImplementation(async () => {
      const e = new Error('Rate exceeded');
      e.name = 'ThrottlingException';
      (e as unknown as { $metadata: unknown }).$metadata = { httpStatusCode: 503 };
      throw wrapped(e);
    });

    await expect(
      withRetry(op, 'Res', {
        logger,
        maxRetries: 2,
        sleep: () => Promise.resolve(),
        isRetryable: (_m, error) => isThrottlingError(error),
      })
    ).rejects.toThrow('Rate exceeded');

    expect(logger.warn).not.toHaveBeenCalled();
  });
});

describe('isTransientServerError depth bound (issue #2026)', () => {
  it('stops at the same depth 5 the sibling classifiers walk', () => {
    // Nothing fenced this bound: widening it to 10 made cdkd retry a 5xx that
    // `isThrottlingError` and `describeRetryClassificationSignals` cannot see,
    // so the classifier and the line explaining it would disagree.
    const deep = new Error('deep');
    (deep as unknown as { $metadata: unknown }).$metadata = { httpStatusCode: 500 };
    let current: Error = deep;
    for (let i = 0; i < 6; i++) {
      const outer = new Error(`link ${i}`);
      (outer as unknown as { cause: unknown }).cause = current;
      current = outer;
    }
    expect(isTransientServerError(current)).toBe(false);
  });
});
