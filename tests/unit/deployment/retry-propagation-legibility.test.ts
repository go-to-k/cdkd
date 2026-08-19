import { describe, it, expect, vi } from 'vite-plus/test';
import { withRetry, IAM_PROPAGATION_MAX_RETRIES } from '../../../src/deployment/retry.js';
import { ProvisioningError } from '../../../src/utils/error-handler.js';

/**
 * Issue #2018: a deploy failed with the canonical IAM-propagation error and
 * the run gave the user no way to tell whether cdkd had retried at all.
 *
 * The three candidate explanations the issue lists (the budget was too short /
 * the budget was exhausted / the error never reached the classifier) are
 * distinguishable ONLY by the attempt count and the elapsed budget, and until
 * this fix neither appeared anywhere in a default-verbosity run: the exhausted
 * loop rethrew the raw AWS error, byte-identical to what a build carrying no
 * retry at all would print.
 *
 * These tests pin the two numbers into the output so a field report carries
 * its own diagnosis.
 */

/** The exact production shape — `lambda-function-provider.ts` wraps the AWS error. */
const propagationError = (): ProvisioningError =>
  new ProvisioningError(
    'Failed to create Lambda function MyFn: The role defined for the function cannot be assumed by Lambda.',
    'AWS::Lambda::Function',
    'MyFn',
    'my-fn'
  );

// The call signature is stated explicitly rather than inferred from a bare
// `vi.fn()`: an untyped mock widens to `Mock<Constructable | Procedure>`, which
// is NOT assignable to `RetryLogger` — and `vp check` would not catch it, since
// it type-checks `tsconfig.json` (src only). Only `vp run typecheck:test` does.
const makeLogger = () => ({
  debug: vi.fn<(message: string) => void>(),
  warn: vi.fn<(message: string) => void>(),
  info: vi.fn<(message: string) => void>(),
  error: vi.fn<(message: string) => void>(),
});

type CapturedLogger = ReturnType<typeof makeLogger>;

const warnText = (logger: CapturedLogger): string =>
  logger.warn.mock.calls.map((c) => String(c[0])).join('\n');

describe('withRetry — IAM-propagation legibility (issue #2018)', () => {
  it('reports the attempt count and the spent budget when the propagation retry is exhausted', async () => {
    const logger = makeLogger();
    const op = vi.fn().mockImplementation(async () => {
      throw propagationError();
    });

    await expect(
      withRetry(op, 'MyFn', { logger, sleep: () => Promise.resolve() })
    ).rejects.toThrow('cannot be assumed');

    // Anchored end-to-end rather than as separate `toContain`s: a bare
    // `toContain('MyFn')` was satisfied by the appended AWS message (which
    // also names the function), so it pinned nothing about the line's own
    // `<logicalId>: ` prefix.
    expect(warnText(logger)).toMatch(
      new RegExp(
        `^MyFn: gave up after ${IAM_PROPAGATION_MAX_RETRIES} IAM-propagation retries ` +
          `over 47\\.75s of propagation backoff \\(the full propagation budget\\)` +
          // The AWS message must still be appended: the summary REPLACES nothing,
          // it explains the error that is about to be rethrown, so dropping the
          // tail would leave the reader with a count and no cause.
          ` - Failed to create Lambda function MyFn: ` +
          `The role defined for the function cannot be assumed by Lambda\\.$`
      )
    );
  });

  it('still calls the budget exhausted when an interleaved throttle broke the propagation run', async () => {
    // The regression this pins: the exhaustion note used to key on
    // `propagationRetries >= IAM_PROPAGATION_MAX_RETRIES`, but a throttle
    // mid-sequence classifies NON-propagation, so it consumes an attempt
    // without advancing the counter. The run below exhausts all 26 attempts
    // with only 25 propagation retries — under the old gate the summary
    // reported a genuine exhaustion as "something else ended it", which is the
    // opposite of the branch a reader uses to decide whether to widen the
    // budget.
    const logger = makeLogger();
    let calls = 0;
    const op = vi.fn().mockImplementation(async () => {
      calls++;
      // One throttle on the 4th attempt; propagation before and after.
      if (calls === 4) throw new Error('Rate exceeded');
      throw propagationError();
    });

    await expect(
      withRetry(op, 'MyFn', { logger, sleep: () => Promise.resolve() })
    ).rejects.toThrow('cannot be assumed');

    const summary = warnText(logger);
    expect(summary).toContain(`${IAM_PROPAGATION_MAX_RETRIES - 1} IAM-propagation retries`);
    expect(summary).toContain('the full propagation budget');
  });

  it('counts only propagation backoff, not a throttle wait that shared the sequence', async () => {
    // Pins the counters' IDENTITY. Every other case has
    // `attempt === propagationRetries`, so swapping one for the other — or
    // dropping the `if (propagation)` guard entirely — left the suite green
    // while a pure throttle sequence would report "N IAM-propagation retries".
    const logger = makeLogger();
    let calls = 0;
    const op = vi.fn().mockImplementation(async () => {
      calls++;
      if (calls === 2) throw new Error('Rate exceeded');
      if (calls >= 4) throw new Error('AccessDeniedException: explicit deny');
      throw propagationError();
    });

    await expect(
      withRetry(op, 'MyFn', { logger, sleep: () => Promise.resolve() })
    ).rejects.toThrow('explicit deny');

    // 3 attempts were retried but only 2 were propagation (0.25s + 1s); the
    // throttle's own 2s generic step is deliberately excluded, so the figure
    // stays comparable against the 47.75s propagation budget.
    expect(warnText(logger)).toContain('2 IAM-propagation retries over 1.25s of propagation backoff');
  });

  it('emits the give-up summary at warn level, so it survives a run without --verbose', async () => {
    const logger = makeLogger();
    const op = vi.fn().mockImplementation(async () => {
      throw propagationError();
    });

    await expect(
      withRetry(op, 'MyFn', { logger, sleep: () => Promise.resolve() })
    ).rejects.toThrow();

    // The regression this pins: the ONLY record of the retry used to be the
    // per-attempt debug lines, invisible at the default level. If the summary
    // ever moves back to debug, the failure becomes undiagnosable again.
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.debug.mock.calls.length).toBeGreaterThan(0);
  });

  it('says nothing when a propagation retry eventually succeeds', async () => {
    const logger = makeLogger();
    let calls = 0;
    const op = vi.fn().mockImplementation(async () => {
      calls++;
      if (calls < 4) throw propagationError();
      return 'ok';
    });

    await expect(withRetry(op, 'MyFn', { logger, sleep: () => Promise.resolve() })).resolves.toBe(
      'ok'
    );
    // A recovered race is not a user-facing event — warning about it would
    // train the reader to ignore the line that matters.
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('says nothing for a non-retryable error that never entered the propagation class', async () => {
    const logger = makeLogger();
    const op = vi.fn().mockRejectedValue(new Error('InvalidParameterValue: bad runtime'));

    await expect(
      withRetry(op, 'MyFn', { logger, sleep: () => Promise.resolve() })
    ).rejects.toThrow('bad runtime');

    expect(op).toHaveBeenCalledTimes(1);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('still reports the budget already spent when a propagation sequence ends on a different, non-retryable error', async () => {
    const logger = makeLogger();
    let calls = 0;
    const op = vi.fn().mockImplementation(async () => {
      calls++;
      if (calls < 3) throw propagationError();
      throw new Error('AccessDeniedException: explicit deny on iam:PassRole');
    });

    await expect(
      withRetry(op, 'MyFn', { logger, sleep: () => Promise.resolve() })
    ).rejects.toThrow('explicit deny');

    const summary = warnText(logger);
    // Two retries were spent before the terminal error — without this the user
    // cannot tell a fast deny from one that surfaced after a propagation wait.
    // The SECONDS are asserted too: pinned only where they equal the 47.75s
    // cap, a hard-coded budget string passed every case.
    expect(summary).toContain('2 IAM-propagation retries over 0.75s of propagation backoff');
    // Not the cap, so the budget note must NOT claim otherwise.
    expect(summary).not.toContain('the full propagation budget');
  });

  it('pluralises a single retry', async () => {
    const logger = makeLogger();
    let calls = 0;
    const op = vi.fn().mockImplementation(async () => {
      calls++;
      if (calls === 1) throw propagationError();
      throw new Error('AccessDeniedException: explicit deny');
    });

    await expect(withRetry(op, 'MyFn', { logger, sleep: () => Promise.resolve() })).rejects.toThrow(
      'explicit deny'
    );
    expect(warnText(logger)).toContain('1 IAM-propagation retry over 0.25s of propagation backoff');
  });

  it('carries the cumulative slept budget on each per-attempt debug line', async () => {
    const logger = makeLogger();
    const op = vi.fn().mockImplementation(async () => {
      throw propagationError();
    });

    await expect(
      withRetry(op, 'MyFn', { logger, sleep: () => Promise.resolve() })
    ).rejects.toThrow();

    const lines = logger.debug.mock.calls.map((c) => String(c[0]));
    // The dense schedule is 0.25 / 0.5 / 1 / 2 / 2 ..., and each line reports
    // the total THROUGH the wait it is announcing (the line prints before the
    // sleep), so the first four read 0.25, 0.75, 1.75, 3.75.
    expect(lines[0]).toContain('0.25s backoff through this attempt');
    expect(lines[1]).toContain('0.75s backoff through this attempt');
    expect(lines[2]).toContain('1.75s backoff through this attempt');
    expect(lines[3]).toContain('3.75s backoff through this attempt');
    // ...and the last line lands on the documented cap.
    expect(lines[lines.length - 1]).toContain('47.75s backoff through this attempt');
  });

  it('does not annotate a generic transient retry with a propagation budget', async () => {
    const logger = makeLogger();
    let calls = 0;
    const op = vi.fn().mockImplementation(async () => {
      calls++;
      if (calls < 3) throw new Error('Rate exceeded');
      return 'ok';
    });

    await expect(withRetry(op, 'MyFn', { logger, sleep: () => Promise.resolve() })).resolves.toBe(
      'ok'
    );
    const lines = logger.debug.mock.calls.map((c) => String(c[0])).join('\n');
    expect(lines).not.toContain('backoff through this attempt');
  });
});
