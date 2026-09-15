import { describe, expect, it } from 'vite-plus/test';
import { redactedDockerCause } from '../../../src/utils/docker-cmd.js';
import {
  isMarkedNonRetryable,
  isThrottlingError,
  isTransientServerError,
  markNonRetryable,
} from '../../../src/deployment/retryable-errors.js';
import { AssetError } from '../../../src/utils/error-handler.js';

/**
 * go-to-k/cdkd#2075 threads a `cause` onto the four `AssetError`s the docker
 * asset publisher raises, so the retry classifiers see an error object rather
 * than an interpolated message. Attaching the RAW error would reopen the
 * channel go-to-k/cdkd#2440 closed: `formatError` prints `cause.message`, and
 * the CLI's top-level handler walks the whole chain.
 *
 * THE FIXTURE IS THE `SpawnError` PRODUCTION ACTUALLY THROWS, and the first cut
 * of this file was not. It modelled an `execFile` rejection — `cmd`, `code`,
 * `errno`, `$metadata` — none of which these four sites can produce: all of
 * them reject through `runDockerStreaming` → `spawnStreaming`, whose error
 * carries `stderr`, `stdout` and `exitCode` and nothing else. The consequence
 * was not cosmetic: "preserves the fields the classifiers read" PASSED against
 * fields production never sets, while `exitCode` — the only classification the
 * real error has — was missing from `CLASSIFICATION_FIELDS` entirely, so on
 * the dominant failure the cause carried a name and a message and nothing
 * else. A mock that cannot fail the way production fails certifies whatever it
 * was built to assert.
 *
 * The argv below carries `-e` pairs cdkd does not build TODAY — the four real
 * argv lists are secret-free. That is the point:
 * `.claude/rules/docker-argv-redaction.md` is explicit that a site whose argv
 * carries no user data must still redact, because the edit that adds a `-e`
 * later touches the spawn and not the error site.
 */
const SECRET = 'hunter2-SUPER-SECRET-VALUE';
const ARGS = ['run', '-e', `DB_PASSWORD=${SECRET}`, '--rm', 'my-image'];

interface SpawnErrorShape extends Error {
  stderr?: string;
  stdout?: string;
  exitCode?: number | null;
}

/**
 * What `spawnStreaming` rejects with on a non-zero exit: the message is the
 * captured stderr (or stdout, or a synthesized line), plus the three fields.
 * The stderr here CARRIES THE SECRET, which is what makes the allowlist fence
 * below two-sided — adding `stderr` to `CLASSIFICATION_FIELDS`, which the
 * JSDoc forbids, has to redden something.
 */
function spawnFailure(stderrText: string): SpawnErrorShape {
  const err = new Error(stderrText) as SpawnErrorShape;
  err.stderr = stderrText;
  err.stdout = '';
  err.exitCode = 125;
  return err;
}

/** The realistic shape: docker echoes the failing command line into stderr. */
function spawnFailureEchoingArgv(): SpawnErrorShape {
  return spawnFailure(
    `docker: invalid reference format\nwhile running: docker ${ARGS.join(' ')}\nunauthorized`
  );
}

describe('redactedDockerCause', () => {
  it('keeps the secret argv value out of the cause message', () => {
    const cause = redactedDockerCause(spawnFailureEchoingArgv(), ARGS);
    expect(cause).toBeInstanceOf(Error);
    expect(cause?.message).not.toContain(SECRET);
    // The KEY survives — it is the diagnostic, and only the value is secret.
    expect(cause?.message).toContain('DB_PASSWORD');
  });

  it('keeps the secret out of EVERY field a printer or a chain-walker reads', () => {
    const cause = redactedDockerCause(spawnFailureEchoingArgv(), ARGS) as Error &
      Record<string, unknown>;
    // `cli/index.ts` prints the chain through util.inspect, which renders own
    // ENUMERABLE props — so the spread is the right model of what a viewer sees.
    expect(JSON.stringify({ ...cause, message: cause.message, stack: cause.stack })).not.toContain(
      SECRET
    );
    expect(cause.stack ?? '').not.toContain(SECRET);
    // Nothing further is chained — a `cause` on the cause would re-expose the
    // original verbatim one link down.
    expect(cause.cause).toBeUndefined();
    // And specifically: the stream fields are NOT carried. The composer has
    // already redacted them into the message; copying the raw ones back would
    // hand over exactly what it removed.
    expect(
      cause.stderr,
      'the cause carries raw `stderr`, which holds the un-redacted argv the message just masked'
    ).toBeUndefined();
    expect(
      cause.stdout,
      'the cause carries raw `stdout`, which holds the un-redacted argv the message just masked'
    ).toBeUndefined();
  });

  it('preserves `exitCode`, which is the only classification the real error has', () => {
    const cause = redactedDockerCause(spawnFailure('denied'), ARGS) as Error &
      Record<string, unknown>;
    // This is what threading a cause BUYS (go-to-k/cdkd#2075). Without it the
    // cause is a name and a message, i.e. no better than the interpolated
    // string it replaced.
    expect(
      cause.exitCode,
      "the cause dropped docker's exit status; `CLASSIFICATION_FIELDS` no longer carries " +
        "`exitCode`, which is the ONLY classification-bearing field spawnStreaming's SpawnError " +
        'sets.'
    ).toBe(125);
    expect(cause.name).toBe('Error');
  });

  it('still carries an SDK-shaped error’s fields, for a caller that has one', () => {
    const err = new Error('throttled') as Error & Record<string, unknown>;
    err.name = 'ThrottlingException';
    err.$metadata = { httpStatusCode: 429 };
    const cause = redactedDockerCause(err, ARGS) as Error & Record<string, unknown>;
    expect(cause.name).toBe('ThrottlingException');
    expect(cause.$metadata).toEqual({ httpStatusCode: 429 });
  });

  it('returns undefined for a non-Error throw rather than fabricating one', () => {
    expect(redactedDockerCause('a string', ARGS)).toBeUndefined();
    expect(redactedDockerCause(undefined, ARGS)).toBeUndefined();
  });

  it('prefers the stderr diagnostic, which is what the user needs', () => {
    const cause = redactedDockerCause(
      spawnFailure('denied: requested access to the resource is denied'),
      ARGS
    );
    expect(cause?.message).toContain('requested access to the resource is denied');
  });

  it('survives a throwing getter — it runs only inside a catch', () => {
    const hostile = new Error('boom');
    Object.defineProperty(hostile, 'exitCode', {
      enumerable: true,
      get() {
        throw new Error('getter exploded');
      },
    });
    expect(() => redactedDockerCause(hostile, ARGS)).not.toThrow();
    const cause = redactedDockerCause(hostile, ARGS) as Error & Record<string, unknown>;
    expect(cause.message).toContain('boom');
    expect(cause.exitCode).toBeUndefined();
  });

  /**
   * go-to-k/cdkd#2075's acceptance is explicit that "the discriminator is the
   * CLASSIFIER VERDICT", not the presence of a field. Every case above asserts
   * a field; these assert what the wrapper is actually for -- and each carries
   * its own dropped-cause negative control, so a verdict that would hold with
   * NO cause proves nothing.
   */
  describe('the classifier verdict, which is what the cause is for', () => {
    function wrapped(inner: Error, withCause: boolean): AssetError {
      return new AssetError(
        'ECR login failed: <redacted>',
        withCause ? redactedDockerCause(inner, ARGS) : undefined
      );
    }

    it('a throttled SDK failure classifies as throttling THROUGH the wrapper', () => {
      const inner = new Error('Rate exceeded') as Error & Record<string, unknown>;
      inner.name = 'ThrottlingException';
      inner.$metadata = { httpStatusCode: 429 };

      expect(isThrottlingError(wrapped(inner, true))).toBe(true);
      // Negative control: without the cause the same wrapper is opaque.
      expect(isThrottlingError(wrapped(inner, false))).toBe(false);
    });

    it('a 5xx SDK failure classifies as transient THROUGH the wrapper', () => {
      const inner = new Error('Internal failure') as Error & Record<string, unknown>;
      inner.name = 'InternalServerError';
      inner.$metadata = { httpStatusCode: 500 };

      expect(isTransientServerError(wrapped(inner, true))).toBe(true);
      expect(isTransientServerError(wrapped(inner, false))).toBe(false);
    });

    it('a non-retryable MARK survives, though no string allowlist could carry it', () => {
      // The marker is a symbol property, so the field copy cannot reach it --
      // dropping it would let something deliberately marked non-retryable be
      // retried. Nothing on the docker path marks one today; this pins that
      // adding one later does not need anyone to remember the redactor exists.
      const inner = markNonRetryable(new Error('bad argument')) as Error;

      expect(isMarkedNonRetryable(wrapped(inner, true))).toBe(true);
      expect(isMarkedNonRetryable(wrapped(inner, false))).toBe(false);
    });

    it('an ordinary docker exit is NOT classified as retryable by any of them', () => {
      // The other direction: carrying `exitCode` must not make a plain
      // non-zero exit look like a throttle or a 5xx.
      const w = wrapped(spawnFailure('denied: requested access is denied'), true);
      expect(isThrottlingError(w)).toBe(false);
      expect(isTransientServerError(w)).toBe(false);
      expect(isMarkedNonRetryable(w)).toBe(false);
    });
  });
});
