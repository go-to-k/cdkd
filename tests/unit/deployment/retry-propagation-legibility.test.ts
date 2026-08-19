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

    const summary = warnText(logger);
    // The two numbers the issue asked to be measurable rather than inferred.
    expect(summary).toContain(`${IAM_PROPAGATION_MAX_RETRIES} IAM-propagation retries`);
    expect(summary).toContain('47.75s');
    expect(summary).toContain('MyFn');
    // Reaching the cap is the branch that says "widen the budget", so it is
    // called out rather than left to be re-derived from the count.
    expect(summary).toContain('the full propagation budget');
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
    expect(summary).toContain('2 IAM-propagation retries');
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
    expect(warnText(logger)).toContain('1 IAM-propagation retry');
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
    // The dense schedule is 0.25 / 0.5 / 1 / 2 / 2 ... so the running total
    // after the first four sleeps is 0.25, 0.75, 1.75, 3.75.
    expect(lines[0]).toContain('0.25s slept so far');
    expect(lines[1]).toContain('0.75s slept so far');
    expect(lines[2]).toContain('1.75s slept so far');
    expect(lines[3]).toContain('3.75s slept so far');
    // ...and the last line lands on the documented cap.
    expect(lines[lines.length - 1]).toContain('47.75s slept so far');
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
    expect(lines).not.toContain('slept so far');
  });
});
