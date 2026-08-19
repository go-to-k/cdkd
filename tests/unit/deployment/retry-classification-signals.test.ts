import { describe, it, expect, vi } from 'vite-plus/test';
import { withRetry } from '../../../src/deployment/retry.js';
import {
  describeRetryClassificationSignals,
  formatRetryClassificationSignals,
} from '../../../src/deployment/retryable-errors.js';
import { ProvisioningError } from '../../../src/utils/error-handler.js';

/**
 * Issue #2026: a healthy IAM-propagation sequence was terminated at ~12% of its
 * budget by one attempt whose message was `UnknownError`, and the give-up line
 * added for issue #2018 could not say why -- it reports the MESSAGE, and the
 * message was exactly the field that had degenerated.
 *
 * `UnknownError` is not an AWS error code. It is the literal placeholder
 * `@smithy/smithy-client`'s `decorateServiceException` substitutes when a
 * service response carries no message text (`exception.message ||
 * exception.Message || "UnknownError"`), so its presence means the two fields
 * the classifier actually decides on -- the error `name` and
 * `$metadata.httpStatusCode` -- were the only surviving evidence. Neither
 * reached any log at any verbosity, which is why the issue's own triage could
 * not choose between its candidate fixes without a second real-AWS run.
 *
 * These tests pin those two fields into the line.
 */

/**
 * The exact production shape: `sqs-queue-policy-provider.ts` catches the AWS
 * error and rethrows a `ProvisioningError` whose MESSAGE interpolates
 * `error.message` -- so a degenerate message reaches the log as the literal
 * `UnknownError` -- while threading the original as `cause`. The wrapper is
 * what makes the cause walk load-bearing: the outer error's own `name` is
 * `ProvisioningError` and carries no `$metadata` at all.
 */
const wrappedAwsError = (
  awsName: string,
  awsMessage: string,
  metadata?: { httpStatusCode?: number; requestId?: string }
): ProvisioningError => {
  const aws = new Error(awsMessage);
  aws.name = awsName;
  if (metadata !== undefined) {
    (aws as unknown as { $metadata: unknown }).$metadata = metadata;
  }
  return new ProvisioningError(
    `Failed to create SQS queue policy StressQueuePolicy: ${awsMessage}`,
    'AWS::SQS::QueuePolicy',
    'StressQueuePolicy',
    'https://sqs.us-east-1.amazonaws.com/1/StressQueue',
    aws
  );
};

const makeLogger = () => ({
  debug: vi.fn<(message: string) => void>(),
  warn: vi.fn<(message: string) => void>(),
});

const warnText = (logger: ReturnType<typeof makeLogger>): string =>
  logger.warn.mock.calls.map((c) => String(c[0])).join('\n');

describe('describeRetryClassificationSignals (issue #2026)', () => {
  it('reads the AWS error name and status through the provider wrapper, not the wrapper own name', () => {
    const signals = describeRetryClassificationSignals(
      wrappedAwsError('InvalidAttributeValue', 'UnknownError', {
        httpStatusCode: 400,
        requestId: 'req-abc',
      })
    );

    // `name` is the discriminator here, not merely "something was returned":
    // the OUTER error is a `ProvisioningError` whose own `name` is
    // `'ProvisioningError'`, so a walk that stopped at depth 0 -- or that
    // reported the first name it saw rather than the one on the link carrying
    // `$metadata` -- would return that instead and tell a reader nothing about
    // the service response.
    expect(signals).toEqual({
      name: 'InvalidAttributeValue',
      httpStatusCode: 400,
      requestId: 'req-abc',
      noMetadata: false,
    });
  });

  it('reports noMetadata with the deepest name when nothing in the chain carries $metadata', () => {
    // A failure that never reached error deserialization (a network / parse
    // error wrapped by a provider). Distinguishing this from "a status was
    // present but unlisted" is the whole reason the flag is explicit: a smithy
    // ServiceException always carries `$metadata` via `deserializeMetadata`,
    // so its ABSENCE is itself the finding.
    const signals = describeRetryClassificationSignals(
      wrappedAwsError('TimeoutError', 'socket hang up')
    );

    expect(signals).toEqual({ name: 'TimeoutError', noMetadata: true });
  });

  it('stops at the same depth 5 the classifier walks, rather than following an unbounded chain', () => {
    // Built 7 links deep with the metadata parked at the bottom, so a walk
    // that ran past the bound would find it. The assertion is that it does
    // NOT: the reported signals must describe what `isThrottlingError` could
    // actually see, or the line becomes a second opinion that contradicts the
    // decision it is printed to explain.
    const deep = new Error('deepest');
    deep.name = 'DeepestError';
    (deep as unknown as { $metadata: unknown }).$metadata = { httpStatusCode: 503 };
    let current: Error = deep;
    for (let i = 0; i < 6; i++) {
      const outer = new Error(`link ${i}`);
      outer.name = `Link${i}`;
      (outer as unknown as { cause: unknown }).cause = current;
      current = outer;
    }

    const signals = describeRetryClassificationSignals(current);
    expect(signals.noMetadata).toBe(true);
    expect(signals.httpStatusCode).toBeUndefined();
  });

  it('reports nothing for a provider wrapper carrying no cause, rather than naming the wrapper', () => {
    // The shape `retry-propagation-legibility.test.ts` builds for issue #2018:
    // a `ProvisioningError` with no `cause` argument. An earlier revision of
    // this helper credited the OUTERMOST name and appended
    // ` [name=ProvisioningError no-$metadata]` here -- a suffix asserting the
    // SDK never parsed a response, about an error that never came from the
    // SDK, on the single most common give-up line in the tree. The empty
    // string is the accurate answer: there is no AWS-side evidence to report.
    const bare = new ProvisioningError(
      'Failed to create Lambda function MyFn: The role defined for the function cannot be assumed by Lambda.',
      'AWS::Lambda::Function',
      'MyFn',
      'my-fn'
    );

    expect(describeRetryClassificationSignals(bare)).toEqual({ noMetadata: true });
    expect(formatRetryClassificationSignals(bare)).toBe('');
  });

  it('renders the no-$metadata token, not just records the flag', () => {
    // The flag's only user-visible rendering. Its `describe()` side is asserted
    // above, but deleting the `parts.push('no-$metadata')` line left the whole
    // suite green -- a surviving mutant on a field the JSDoc calls
    // load-bearing.
    expect(formatRetryClassificationSignals(wrappedAwsError('TimeoutError', 'socket hang up'))).toBe(
      ' [name=TimeoutError no-$metadata]'
    );
  });

  it('keeps walking past a $metadata that carries no status, and reports the status below it', () => {
    // A shape the AWS SDK really produces: a network failure whose `$metadata`
    // has `attempts` / `totalRetryDelay` but NO `httpStatusCode`, wrapping the
    // service error underneath. Returning on the first `$metadata` object
    // reported no `http=` at all -- while `isTransientServerError`, which walks
    // past it, HAD found the 500 and retried on it. A line whose whole purpose
    // is "what the classifier saw" must not contradict the classifier.
    const inner = new Error('UnknownError');
    inner.name = 'InternalFailure';
    (inner as unknown as { $metadata: unknown }).$metadata = {
      httpStatusCode: 500,
      requestId: 'deep-req',
    };
    const outer = new Error('socket hang up');
    outer.name = 'NetworkError';
    (outer as unknown as { $metadata: unknown }).$metadata = { attempts: 3, totalRetryDelay: 120 };
    (outer as unknown as { cause: unknown }).cause = inner;

    expect(describeRetryClassificationSignals(outer)).toEqual({
      name: 'InternalFailure',
      httpStatusCode: 500,
      requestId: 'deep-req',
      noMetadata: false,
    });
  });

  it('reports noMetadata FALSE when a $metadata was seen but carried no status', () => {
    // Absent status and absent metadata are different findings: this response
    // DID reach the SDK's error deserialization, so the flag's "never got that
    // far" reading would be a lie. The request id is still worth reporting --
    // it is the one field that lets AWS support find the call.
    const e = new Error('socket hang up');
    e.name = 'NetworkError';
    (e as unknown as { $metadata: unknown }).$metadata = { requestId: 'only-id' };
    const wrapped = new ProvisioningError(
      'Failed to create SQS queue policy P: socket hang up',
      'AWS::SQS::QueuePolicy',
      'P',
      'url',
      e
    );

    expect(describeRetryClassificationSignals(wrapped)).toEqual({
      name: 'NetworkError',
      requestId: 'only-id',
      noMetadata: false,
    });
    expect(formatRetryClassificationSignals(wrapped)).toBe(' [name=NetworkError requestId=only-id]');
  });

  it('ignores an array $metadata rather than treating it as a metadata object', () => {
    const e = new Error('weird');
    e.name = 'WeirdError';
    (e as unknown as { $metadata: unknown }).$metadata = [];
    expect(describeRetryClassificationSignals(e).noMetadata).toBe(true);
  });

  it('keeps the FIRST metadata link request id when a deeper link carries the status', () => {
    // Retention is first-link-wins, and the JSDoc calls that load-bearing.
    // Making it last-wins reported the wrong id for a chain with two
    // status-less metadata links, and dropping the fallback entirely lost the
    // id altogether when the status lived deeper than it did.
    const inner = new Error('UnknownError');
    inner.name = 'InternalFailure';
    (inner as unknown as { $metadata: unknown }).$metadata = { httpStatusCode: 500 };
    const mid = new Error('retry wrapper');
    mid.name = 'MidError';
    (mid as unknown as { $metadata: unknown }).$metadata = { requestId: 'outer-req' };
    (mid as unknown as { cause: unknown }).cause = inner;

    expect(describeRetryClassificationSignals(mid)).toEqual({
      name: 'InternalFailure',
      httpStatusCode: 500,
      requestId: 'outer-req',
      noMetadata: false,
    });
  });

  it('names an UNWRAPPED AWS error, whose metadata sits at depth 0', () => {
    // The depth-0 name is excluded from the no-$metadata FALLBACK, but a link
    // carrying `$metadata` is the SDK's error by construction whatever its
    // depth -- so it must still be named. Dropping the `linkName` half of the
    // `linkName ?? deepestName` expression rendered a bare ` [http=500]`.
    const bare = new Error('UnknownError');
    bare.name = 'InternalFailure';
    (bare as unknown as { $metadata: unknown }).$metadata = { httpStatusCode: 500 };

    expect(formatRetryClassificationSignals(bare)).toBe(' [name=InternalFailure http=500]');
  });

  it('prefers the metadata link name over a deeper one when no status is found', () => {
    const inner = new Error('deep');
    inner.name = 'DeepError';
    const mid = new Error('mid');
    mid.name = 'MetadataError';
    (mid as unknown as { $metadata: unknown }).$metadata = { requestId: 'r1' };
    (mid as unknown as { cause: unknown }).cause = inner;

    expect(describeRetryClassificationSignals(mid).name).toBe('MetadataError');
  });

  it('renders a lone request id, which is the one field AWS support needs', () => {
    // The `requestId === undefined` arm of the bail condition. Dropping it made
    // this render '' -- the exact case the comment says DOES count as
    // identifying.
    // A nameless carrier, so the assertion isolates the requestId arm: a bare
    // `new Error()` would supply `name: 'Error'` and render regardless, which
    // would leave the mutant alive.
    expect(formatRetryClassificationSignals({ $metadata: { requestId: 'only-id' } })).toBe(
      ' [requestId=only-id]'
    );
    // ...and the named form still carries both.
    const named = new Error('boom');
    named.name = 'SomeError';
    (named as unknown as { $metadata: unknown }).$metadata = { requestId: 'id2' };
    expect(formatRetryClassificationSignals(named)).toBe(' [name=SomeError requestId=id2]');
  });

  it('renders an empty suffix when there is nothing to report, so callers can append unconditionally', () => {
    // A bare object literal: no name, no $metadata, no cause. Without this
    // arm the give-up line would grow a content-free ` [no-$metadata]` bracket
    // on every non-AWS failure.
    expect(formatRetryClassificationSignals({})).toBe('');
  });
});

describe('withRetry give-up line carries the classification signals (issue #2026)', () => {
  it('names the status and error code when the message has degenerated to UnknownError', async () => {
    const logger = makeLogger();
    let attempt = 0;
    const op = vi.fn().mockImplementation(async () => {
      attempt++;
      // Attempts 1-5 classify cleanly as propagation, then attempt 6 arrives
      // with no message text -- the shape measured on real AWS.
      if (attempt <= 5) {
        throw wrappedAwsError('InvalidAttributeValue', 'Invalid value for the parameter Policy.', {
          httpStatusCode: 400,
        });
      }
      // A 400 rather than the measured 500 on purpose: a degenerate message is
      // only HALF of what ended that sequence, and after the issue #2026 fix a
      // 500 is retried, so it can no longer produce a give-up to inspect. This
      // arm isolates the OTHER half -- a response with nothing readable in it
      // and a status outside the transient set -- which is exactly the case
      // where the message tells a reader nothing and the suffix is the only
      // diagnosis available.
      throw wrappedAwsError('SomeClientError', 'UnknownError', {
        httpStatusCode: 400,
        requestId: 'req-xyz',
      });
    });

    await expect(
      withRetry(op, 'StressQueuePolicy', { logger, sleep: () => Promise.resolve() })
    ).rejects.toThrow('UnknownError');

    const text = warnText(logger);
    // The fields the issue could not obtain from its own run's log. Asserted as
    // exact tokens rather than "the line mentions 400": the give-up line
    // already interpolates a message and an elapsed figure, so a loose
    // substring check can be satisfied by text that was there before this fix.
    expect(text).toContain('[name=SomeClientError http=400 requestId=req-xyz]');
    // ...and the line still says it gave up EARLY, which is the other half of
    // the diagnosis: a status suffix on a line reporting a full budget would
    // describe a different failure entirely.
    expect(text).toContain('gave up after 5 IAM-propagation retries');
    expect(text).not.toContain('the full propagation budget');
  });

  it('a 500 no longer produces a give-up at all (issue #2026)', async () => {
    // The companion to the case above, and the reason it had to change: the
    // measured sequence ended on an HTTP 500, and the fix means that sequence
    // now RUNS ON. Pinning it here keeps the two halves of the issue -- the
    // instrumentation and the classification -- visible in one place.
    const logger = makeLogger();
    let attempt = 0;
    const op = vi.fn().mockImplementation(async () => {
      attempt++;
      if (attempt <= 5) {
        throw wrappedAwsError('InvalidAttributeValue', 'Invalid value for the parameter Policy.', {
          httpStatusCode: 400,
        });
      }
      if (attempt === 6) {
        throw wrappedAwsError('InternalFailure', 'UnknownError', { httpStatusCode: 500 });
      }
      return 'created';
    });

    await expect(
      withRetry(op, 'StressQueuePolicy', { logger, sleep: () => Promise.resolve() })
    ).resolves.toBe('created');
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
