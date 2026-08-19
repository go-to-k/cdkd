/**
 * Retry helper for resource provisioning operations that hit transient
 * AWS eventual-consistency errors (IAM propagation, Lambda Pending state,
 * dependency violations, etc.).
 *
 * Extracted from DeployEngine so the backoff schedule can be unit-tested
 * in isolation. The retryable-error classifier itself lives in
 * `./retryable-errors.ts`.
 */

import {
  isIamPropagationError,
  isMarkedNonRetryable,
  isRetryableTransientError,
} from './retryable-errors.js';

export interface RetryLogger {
  debug(message: string): void;
  /**
   * Issue #2018: the one line that survives a run without `--verbose`.
   *
   * Optional so the many callers passing a bare `{ debug }` keep compiling; every
   * PRODUCTION caller threads a real `Logger`, which has it. A logger without it
   * loses only the give-up summary -- the retry behavior is unchanged.
   */
  warn?(message: string): void;
}

/**
 * Initial backoff for the IAM-propagation error class (issue: EC2 instance
 * launches burning ~10s of backoff waiting on a fresh instance profile).
 *
 * cdkd creates an `AWS::IAM::InstanceProfile` and issues `RunInstances` ~2.8s
 * later; CloudFormation and Terraform are slow enough between resources that
 * IAM has propagated by the time they call, cdkd outruns it. The measured
 * failure recovers in single-digit seconds, so the first re-probe should be
 * sub-second rather than the generic 1s.
 */
export const IAM_PROPAGATION_INITIAL_DELAY_MS = 250;

/**
 * Cap for the IAM-propagation backoff. Once the ramp reaches this value the
 * schedule stays FLAT — the whole point is a tight, predictable probe grid
 * across the window in which propagation completes, so the worst-case
 * overshoot is ~2s instead of the generic schedule's up-to-8s.
 *
 * Not lower than 2s on purpose: the retried call is usually a mutating,
 * tightly-rate-limited API (`RunInstances` refills ~2 req/s per account), and
 * the retry runs per-resource in parallel — three instances polling at 1s
 * would sit at 3 req/s and trade an IAM stall for a throttle stall. (If a
 * throttle DOES happen, its error classifies as non-propagation and the
 * generic exponential schedule takes over for that attempt, which is exactly
 * the desired self-correction.)
 */
export const IAM_PROPAGATION_MAX_DELAY_MS = 2_000;

/**
 * Retry budget for the IAM-propagation class.
 *
 * A denser schedule must NOT shrink the window in which propagation can still
 * be caught — that would trade latency for flakiness. The generic default
 * (1s/2s/4s/8s then capped, 8 retries) sleeps 47s in total, so the dense
 * schedule is given enough retries to cover at least as long:
 *
 *   0.25 + 0.5 + 1 + 2 x 23 = 47.75s over 26 retries
 *
 * Probe grid (seconds after the first failure): 0.25, 0.75, 1.75, 3.75, then
 * every 2s out to 47.75 — versus the generic 1, 3, 7, 15, 23, 31, 39, 47.
 * From 3.75s onwards the dense grid is strictly ahead, and it never lags the
 * generic one by more than 0.75s in the early band.
 */
export const IAM_PROPAGATION_MAX_RETRIES = 26;

export interface WithRetryOptions {
  /**
   * Max number of retries after the first attempt. Defaults to 8.
   *
   * Setting this (or any other schedule knob) opts the call OUT of the dense
   * IAM-propagation schedule — see {@link withRetry}.
   */
  maxRetries?: number;
  /**
   * Initial backoff in milliseconds. Subsequent retries double it
   * (1s -> 2s -> 4s -> ... at the default of 1_000ms).
   *
   * The default of 1_000ms is tuned for the typical AWS eventual-consistency
   * window of 2-5s (a freshly-created Lambda leaving Pending state, an async
   * delete releasing a dependency). A longer initial delay (e.g. 10s) adds
   * idle time on the deploy critical path even when the underlying window is
   * much shorter. IAM-propagation errors are denser still and have their own
   * schedule ({@link IAM_PROPAGATION_INITIAL_DELAY_MS}), which this option
   * disables when set.
   */
  initialDelayMs?: number;
  /**
   * Cap for the per-retry delay in milliseconds. Once the doubling schedule
   * reaches this value it stays flat instead of growing further. Defaults to
   * 8_000ms.
   *
   * Why cap: an eventual-consistency window has a long-ish tail (occasional
   * 20-30s waits past the typical 2-5s window). Pure exponential backoff turns
   * a single stall into 16s, 32s, 64s waits — far more than the underlying
   * window. Capping at 8s lets us still poll roughly every 8s once we're past
   * the early ramp-up, recovering as soon as AWS stabilises.
   */
  maxDelayMs?: number;
  /** Optional debug logger; receives one line per retry attempt. */
  logger?: RetryLogger;
  /**
   * Optional interrupt check — invoked once per second while sleeping.
   * Throws an interrupt error (e.g. on SIGINT) to abort the retry loop early.
   */
  isInterrupted?: () => boolean;
  /** Thrown when `isInterrupted()` returns true mid-sleep. */
  onInterrupted?: () => Error;
  /** Override the sleep implementation (used by tests to skip real waits). */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Override the retryable-error classifier. When set, this replaces
   * {@link isRetryableTransientError} for THIS call — used by callers that
   * need to retry an error shape the shared transient table deliberately
   * excludes (e.g. the --replace delete-first fallback retrying
   * "already exists" while an async delete releases the name).
   */
  isRetryable?: (message: string, error: unknown) => boolean;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run `operation`, retrying transient failures with exponential backoff
 * capped at `maxDelayMs`.
 *
 * Backoff at the defaults (initialDelayMs=1_000, maxDelayMs=8_000, maxRetries=8):
 *   1s -> 2s -> 4s -> 8s -> 8s -> 8s -> 8s -> 8s   (cumulative 47s)
 *
 * IAM-propagation failures (see `isIamPropagationError`) instead use the dense
 * schedule 0.25s -> 0.5s -> 1s -> 2s -> 2s ... over
 * {@link IAM_PROPAGATION_MAX_RETRIES} retries (cumulative 47.75s), because that
 * class resolves in single-digit seconds and the generic schedule's coarse
 * 4s/8s steps overshoot it. The dense schedule applies ONLY when the caller
 * left the schedule at its defaults — a caller that passed its own
 * `maxRetries` / `initialDelayMs` / `maxDelayMs` / `isRetryable` picked that
 * schedule deliberately (e.g. the DELETE path's 3 x 5s, or the delete-then-
 * re-create sites' ~64s budget covering SQS's 60s name cooldown) and gets it
 * verbatim.
 *
 * The class is re-evaluated per attempt, so a propagation retry that runs into
 * a throttle backs OFF exponentially for that attempt instead of hammering.
 *
 * Non-retryable errors are rethrown immediately. The transient-error
 * classifier is `isRetryableTransientError` from ./retryable-errors.ts, or
 * `opts.isRetryable` when the caller supplies one — EXCEPT for an error marked
 * by `markNonRetryable`, which is rethrown ahead of either, so a deliberate
 * cdkd refusal cannot be turned back into a retry by a custom classifier
 * (issue #1778).
 *
 * REPORTING (issue #2018). A propagation sequence that gives up emits ONE
 * `warn` line naming how many retries it spent and how much of the budget it
 * slept, and the per-attempt `debug` lines carry the running total. Before
 * this, an exhausted retry rethrew the raw AWS error and nothing in a
 * default-verbosity run distinguished "cdkd retried for 47.75s" from "cdkd
 * has no retry for this at all" — which is why a field report of exactly this
 * failure could only be diagnosed by reading the source and diffing two
 * releases. Neither counter feeds a control decision; they are reporting only.
 */
export async function withRetry<T>(
  operation: () => Promise<T>,
  logicalId: string,
  opts: WithRetryOptions = {}
): Promise<T> {
  const maxRetries = opts.maxRetries ?? 8;
  const initialDelayMs = opts.initialDelayMs ?? 1_000;
  const maxDelayMs = opts.maxDelayMs ?? 8_000;
  const sleep = opts.sleep ?? defaultSleep;

  // Only the default schedule gets the propagation fast path; any explicit
  // knob means the caller owns the cadence.
  const defaultSchedule =
    opts.maxRetries === undefined &&
    opts.initialDelayMs === undefined &&
    opts.maxDelayMs === undefined &&
    opts.isRetryable === undefined;
  const attemptCeiling = defaultSchedule
    ? Math.max(maxRetries, IAM_PROPAGATION_MAX_RETRIES)
    : maxRetries;

  let lastError: unknown;
  // Latches on the first propagation error and never clears. The DELAY is
  // re-derived per attempt (a throttle mid-propagation still backs off
  // exponentially), but the BUDGET must not be, or an interleaved throttle
  // collapses the window the dense schedule exists to cover: the generic
  // limit is 8, so a throttle on attempt 9 of a propagation sequence would
  // abort at ~9.5s of the intended 47.75s -- shorter than the generic
  // schedule it is supposed to be a superset of. A sequence that never sees
  // a propagation error keeps the generic 8.
  let sawPropagation = false;
  // Issue #2018: the retry's own work has to be READABLE from a normal run.
  // Both counters are for reporting only -- neither feeds a control decision,
  // so a mis-count can never change how long the loop runs.
  //
  // `propagationSleptMs` accumulates the INTENDED delay rather than measured
  // wall-clock: it is the budget the schedule spent, which is the number the
  // 47.75s cap is expressed in and therefore the one a reader compares against
  // it. Measured elapsed would additionally carry each attempt's API latency
  // and make "did we reach the cap?" unanswerable from the line.
  let propagationRetries = 0;
  let propagationSleptMs = 0;

  for (let attempt = 0; attempt <= attemptCeiling; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);

      // Issue #1778: a cdkd-authored refusal is terminal by DECLARATION, and
      // that has to be decided HERE rather than inside the default classifier.
      // `isRetryableTransientError` consults the marker, but a caller passing
      // its own `isRetryable` REPLACES that function entirely — and the four
      // custom classifiers in the tree (`isRecreateRetryableError` /
      // `isNameCooldownError`, wired by the deploy engine's --replace
      // delete-first fallback and the rollback executor's reverse-replacement)
      // are MESSAGE-only, so they cannot see the marker even in principle.
      // Hoisting the check above the branch fences every caller at once,
      // without widening a single classifier signature.
      if (isMarkedNonRetryable(error)) {
        throw error;
      }

      const retryable = opts.isRetryable
        ? opts.isRetryable(message, error)
        : isRetryableTransientError(error, message);
      const propagation = defaultSchedule && isIamPropagationError(message);
      if (propagation) {
        sawPropagation = true;
      }
      const attemptLimit = sawPropagation ? IAM_PROPAGATION_MAX_RETRIES : maxRetries;
      if (!retryable || attempt >= attemptLimit) {
        // Issue #2018: a propagation sequence that gives up must SAY so, at
        // the default log level. Until this line the exhaustion was entirely
        // silent -- the user saw only the raw AWS sentence ("The role defined
        // for the function cannot be assumed by Lambda."), identical to what a
        // build with no retry at all would print. That is what made the
        // reported failure undiagnosable from the outside: establishing that
        // cdkd had retried at all took reading the source and diffing two
        // releases, and the three candidate explanations (budget too short /
        // budget exhausted / the retry never engaged) are indistinguishable
        // without these two numbers.
        //
        // `warn`, not `debug`: the whole point is that it survives a run with
        // no `--verbose`. The per-attempt lines below stay at debug -- 27 of
        // them is a log flood, while this summary is one line.
        //
        // Gated on having actually retried, so the overwhelmingly common case
        // (a non-propagation error failing fast on attempt 0) prints nothing.
        if (propagationRetries > 0) {
          opts.logger?.warn?.(
            `${logicalId}: gave up after ${propagationRetries} IAM-propagation ${
              propagationRetries === 1 ? 'retry' : 'retries'
            } over ${(propagationSleptMs / 1000).toFixed(2)}s${
              propagationRetries >= IAM_PROPAGATION_MAX_RETRIES
                ? ' (the full propagation budget)'
                : ''
            } - ${message}`
          );
        }
        throw error;
      }

      const delay = propagation
        ? Math.min(
            IAM_PROPAGATION_INITIAL_DELAY_MS * Math.pow(2, attempt),
            IAM_PROPAGATION_MAX_DELAY_MS
          )
        : Math.min(initialDelayMs * Math.pow(2, attempt), maxDelayMs);
      if (propagation) {
        propagationRetries++;
        propagationSleptMs += delay;
      }
      // Issue #2018: the cumulative figure is what makes a single line
      // answerable on its own ("how far into the 47.75s budget was this?").
      // Reading it off the attempt number instead requires the reader to know
      // and re-sum the schedule, which is the inference this issue asked to
      // replace with a measurement.
      opts.logger?.debug(
        `  ⏳ Retrying ${logicalId} in ${delay / 1000}s (attempt ${attempt + 1}/${attemptLimit}${
          propagation ? `, ${(propagationSleptMs / 1000).toFixed(2)}s slept so far` : ''
        }) - ${message}`
      );

      // Interruptible sleep: check for SIGINT every second during delay.
      for (let waited = 0; waited < delay; waited += 1000) {
        if (opts.isInterrupted?.()) {
          throw opts.onInterrupted ? opts.onInterrupted() : new Error('Interrupted');
        }
        await sleep(Math.min(1000, delay - waited));
      }
    }
  }

  throw lastError;
}
