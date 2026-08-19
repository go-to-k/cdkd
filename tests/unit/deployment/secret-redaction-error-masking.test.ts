import { describe, it, expect } from 'vite-plus/test';
import {
  maskSecretsInError,
  SECRET_MASK,
  type RecordedSecretValues,
} from '../../../src/deployment/secret-redaction.js';
import { ProvisioningError, formatError } from '../../../src/utils/error-handler.js';
import {
  markNonRetryable,
  isMarkedNonRetryable,
  isThrottlingError,
  isTransientServerError,
} from '../../../src/deployment/retryable-errors.js';

// Issue #2038 review round 2. `maskSecretsInError` was written to close the
// sink NO log-site fix can reach: `formatError` renders a `CdkdError`'s CAUSE as
// `Caused by: <cause.message>` and `handleError` logs that at `error` level, so
// the sink reads the error OBJECT rather than any string cdkd formatted.
//
// The first cut masked only the TOP link and carried `cause` through verbatim,
// which is wrong in the direction that matters most: a provider wrapping an AWS
// failure in a generic sentence leaves the plaintext one link down, where the
// identity-return then reported "nothing to mask" and handed back an object
// still carrying it. These cases pin the CHAIN invariant.
//
// Where the assertion can be on the rendered output it is (`formatError`), per
// the lesson that the top-level assertion passed while the render leaked.
// `formatError` walks ONE level, so the deeper cases are pinned on the object
// graph — which is what `extractDeploymentEventError` and the retry classifiers
// walk anyway, and what a future renderer would walk.

const SECRET = 'hunter2-real-secret-value';
const EXPRESSION = '{{resolve:secretsmanager:my-secret:SecretString:password::}}';

function bag(): RecordedSecretValues {
  return new Map([[SECRET, EXPRESSION]]);
}

/** The shape `provisionResource` builds: a CdkdError whose cause is the raw error. */
function wrap(cause: Error): ProvisioningError {
  return new ProvisioningError(
    'Failed to create resource Pool',
    'AWS::Cognito::UserPool',
    'Pool',
    undefined,
    cause
  );
}

describe('maskSecretsInError - the whole cause chain is masked (issue #2038)', () => {
  it('masks a secret that lives ONLY in the cause message', () => {
    // The provider wrapped the AWS failure in a generic sentence, so the top
    // link is clean and a top-level-only mask returns the original by identity
    // with the plaintext still one link down.
    const inner = new Error(`Value '${SECRET}' at 'clientSecret' failed to satisfy constraint`);
    const outer = new Error('The provider call failed', { cause: inner });

    const masked = maskSecretsInError(outer, bag());

    expect(masked).not.toBe(outer);
    expect((masked.cause as Error).message).not.toContain(SECRET);
    expect((masked.cause as Error).message).toContain(SECRET_MASK);
    // And what the user actually sees, one wrap up.
    const rendered = formatError(wrap(masked));
    expect(rendered).toContain('Caused by:');
    expect(rendered).not.toContain(SECRET);
  });

  it('masks BOTH levels when the plaintext is in both', () => {
    const quote = `Value '${SECRET}' at 'clientSecret' failed to satisfy constraint`;
    const inner = new Error(quote);
    const outer = new Error(quote, { cause: inner });

    const masked = maskSecretsInError(outer, bag());

    expect(masked.message).not.toContain(SECRET);
    expect((masked.cause as Error).message).not.toContain(SECRET);
    expect(formatError(wrap(masked))).not.toContain(SECRET);
  });

  it('masks a secret TWO levels down', () => {
    const deepest = new Error(`Value '${SECRET}' at 'clientSecret' failed`);
    const middle = new Error('the inner call failed', { cause: deepest });
    const outer = new Error('the outer call failed', { cause: middle });

    const masked = maskSecretsInError(outer, bag());

    const deep = (masked.cause as Error).cause as Error;
    expect(deep.message).not.toContain(SECRET);
    expect(deep.message).toContain(SECRET_MASK);
    // The untouched middle link is still a real link, not flattened away.
    expect((masked.cause as Error).message).toBe('the inner call failed');
  });

  it('terminates on a CYCLIC cause chain instead of hanging or throwing', () => {
    const a: Error & { cause?: unknown } = new Error(`A ${SECRET}`);
    const b: Error & { cause?: unknown } = new Error(`B ${SECRET}`);
    a.cause = b;
    b.cause = a;

    const masked = maskSecretsInError(a, bag()) as Error & { cause?: Error };

    expect(masked.message).toBe(`A ${SECRET_MASK}`);
    expect(masked.cause!.message).toBe(`B ${SECRET_MASK}`);
    // The cycle is rebuilt among the CLONES, so walking it never re-enters the
    // unmasked originals.
    expect((masked.cause!.cause as Error)).toBe(masked);
    expect(masked).not.toBe(a);
  });

  it('leaves the chain untouched, by IDENTITY, when nothing anywhere matches', () => {
    const inner = new Error('Bad Request: something ordinary');
    const outer = new Error('The provider call failed', { cause: inner });

    const masked = maskSecretsInError(outer, bag());

    expect(masked).toBe(outer);
    expect(masked.cause).toBe(inner);
  });

  it('passes a non-Error and an empty bag straight through', () => {
    expect(maskSecretsInError('not an error', bag())).toBe('not an error');
    const err = new Error(SECRET);
    expect(maskSecretsInError(err, new Map())).toBe(err);
  });
});

describe('maskSecretsInError - the clone stays classifiable (issue #2038)', () => {
  it('every classifier that walks the chain answers identically to the original', () => {
    // One error per classifier, each carrying the secret so the clone is real.
    const quote = `Value '${SECRET}' at 'clientSecret' failed`;

    const throttled = new Error('outer', {
      cause: Object.assign(new Error(quote), {
        name: 'ThrottlingException',
        $metadata: { httpStatusCode: 429, requestId: 'req-throttle' },
      }),
    });
    const server = new Error('outer', {
      cause: Object.assign(new Error(quote), {
        name: 'InternalFailure',
        $metadata: { httpStatusCode: 500, requestId: 'req-500' },
      }),
    });
    const refused = new Error('outer', { cause: markNonRetryable(new Error(quote)) });

    // Non-vacuity: each classifier answers TRUE on the original, so an
    // assertion of "identical" is not comparing two falses.
    expect(isThrottlingError(throttled)).toBe(true);
    expect(isTransientServerError(server)).toBe(true);
    expect(isMarkedNonRetryable(refused)).toBe(true);

    const maskedThrottled = maskSecretsInError(throttled, bag());
    const maskedServer = maskSecretsInError(server, bag());
    const maskedRefused = maskSecretsInError(refused, bag());

    expect(isThrottlingError(maskedThrottled)).toBe(true);
    expect(isTransientServerError(maskedServer)).toBe(true);
    expect(isMarkedNonRetryable(maskedRefused)).toBe(true);

    // ... and the masking really happened on each of them.
    for (const m of [maskedThrottled, maskedServer, maskedRefused]) {
      expect((m.cause as Error).message).not.toContain(SECRET);
      expect((m.cause as Error).message).toContain(SECRET_MASK);
    }
  });

  it('preserves prototype, name, $metadata and the enumerability of cause', () => {
    class AwsShapedError extends Error {}
    const inner = Object.assign(new AwsShapedError(`Value '${SECRET}' at 'x' failed`), {
      name: 'ValidationException',
      Code: 'ValidationException',
      $metadata: { httpStatusCode: 400, requestId: 'req-abc' },
    });
    // `new Error(m, {cause})` makes `cause` NON-enumerable; `Object.assign`
    // makes it enumerable. Both spellings occur in the tree, so the flag has to
    // survive rather than be normalized.
    const nonEnumerableCause = new Error('outer', { cause: inner });
    const enumerableCause = Object.assign(new Error('outer'), { cause: inner });

    const maskedNonEnum = maskSecretsInError(nonEnumerableCause, bag());
    const maskedEnum = maskSecretsInError(enumerableCause, bag());

    const cause = maskedNonEnum.cause as AwsShapedError & {
      Code?: string;
      $metadata?: { httpStatusCode?: number; requestId?: string };
    };
    expect(cause).toBeInstanceOf(AwsShapedError);
    expect(cause.name).toBe('ValidationException');
    expect(cause.Code).toBe('ValidationException');
    expect(cause.$metadata?.httpStatusCode).toBe(400);
    expect(cause.$metadata?.requestId).toBe('req-abc');

    expect(Object.getOwnPropertyDescriptor(maskedNonEnum, 'cause')?.enumerable).toBe(false);
    expect(Object.getOwnPropertyDescriptor(maskedEnum, 'cause')?.enumerable).toBe(true);
  });

  // DOCUMENTED RESIDUAL, not a passing behavior: a non-Error cause is carried
  // through UNMASKED, secret or not. The previous version of this case used a
  // secret-FREE string, so it asserted the identity carry-through in the one
  // direction where nothing is at stake and read as coverage of the case that
  // matters. The reachability is speculative — no cdkd or AWS SDK site
  // constructs a non-Error cause — but `src/cli/index.ts`'s
  // `console.error('Fatal error:', error)` renders one through `util.inspect`,
  // so if such a site ever appears the plaintext reaches the terminal. This
  // asserts the residual as it IS so a future fix has to update the test.
  it('does NOT mask a non-Error cause — carried through verbatim (residual)', () => {
    const stringCause = `a string containing ${SECRET}`;
    const outer = new Error(`Value '${SECRET}' at 'x' failed`, { cause: stringCause });

    const masked = maskSecretsInError(outer, bag());

    // The Error links ARE masked ...
    expect(masked.message).toContain(SECRET_MASK);
    expect(masked.message).not.toContain(SECRET);
    // ... and the string cause is NOT. Asserted positively, both ways, so the
    // day this changes the assertion fails rather than silently staying green.
    expect(masked.cause).toBe(stringCause);
    expect(masked.cause).toContain(SECRET);
  });
});

describe('maskSecretsInError - the clone keeps a MASKED stack (issue #2038)', () => {
  it('carries a stack, masked, rather than losing it to the accessor copy', () => {
    // V8 defines `stack` as an own ACCESSOR reading an engine-attached slot, so
    // copying its descriptor onto an `Object.create` clone yields a getter with
    // nothing behind it. Non-vacuity first: the original really has a stack, and
    // that stack really carries the secret (its first line is the message).
    const inner = new Error(`Value '${SECRET}' at 'clientSecret' failed`);
    const outer = new Error('The provider call failed', { cause: inner });
    expect(typeof inner.stack).toBe('string');
    expect(inner.stack).toContain(SECRET);

    const masked = maskSecretsInError(outer, bag());
    const cause = masked.cause as Error;

    expect(typeof cause.stack).toBe('string');
    expect(cause.stack).not.toContain(SECRET);
    expect(cause.stack).toContain(SECRET_MASK);
    // The TRACE survives, not just the masked first line — the frame list is
    // what a top-level caller of this exported helper would otherwise lose.
    expect(cause.stack).toContain('\n    at ');
    // And the original is untouched, since this is a clone.
    expect(inner.stack).toContain(SECRET);
  });

  it('masks the TOP link stack too, which is what `console.error` renders', () => {
    const top = new Error(`Value '${SECRET}' at 'clientSecret' failed`);
    expect(top.stack).toContain(SECRET);

    const masked = maskSecretsInError(top, bag());

    expect(masked).not.toBe(top);
    expect(masked.stack).not.toContain(SECRET);
    expect(masked.stack).toContain(SECRET_MASK);
  });

  it('leaves an object with no engine stack without one, rather than faking an empty string', () => {
    // Not an engine-created error: `Object.create` gives it the prototype but no
    // own `stack` slot. The clone must not invent a `stack: ''`, which would
    // make `util.inspect` render `[Error: ...]` instead of the object shape.
    const stackless = Object.create(Error.prototype) as Error & { cause?: unknown };
    Object.defineProperty(stackless, 'message', {
      value: `Value '${SECRET}' at 'x' failed`,
      writable: true,
      configurable: true,
    });
    expect(stackless.stack).toBeUndefined();

    const masked = maskSecretsInError(stackless, bag());

    expect(masked.message).toContain(SECRET_MASK);
    expect(Object.getOwnPropertyDescriptor(masked, 'stack')).toBeUndefined();
  });
});
