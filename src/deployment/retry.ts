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
  formatRetryClassificationSignals,
  isIamPropagationError,
  isNameCooldownError,
  isTransientServerError,
  isMarkedNonRetryable,
  isRetryableTransientError,
} from './retryable-errors.js';

export interface RetryLogger {
  debug(message: string): void;
  /**
   * Issue #2018: the one line that survives a run without `--verbose`.
   *
   * OPTIONAL because a caller may need to TRANSFORM the message rather than
   * forward it -- `drift.ts`'s revert threads a masking `debug` so a resolved
   * secret quoted back by an AWS error cannot reach the log (issue #1914), and
   * a required `warn` would have been silently satisfied by an unmasked
   * `logger.warn`. A caller that omits it loses only the give-up summary; the
   * retry behavior is identical either way.
   *
   * Do NOT describe every production caller as threading a real `Logger` -- an
   * earlier revision of this comment did, and it was false for exactly the
   * masking caller above.
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

/**
 * Backoff for the NAME-COOLDOWN class on the DEFAULT schedule — an AWS service
 * still holding a resource's name while an asynchronous delete of the previous
 * holder finishes (`NAME_COOLDOWN_ERROR_MESSAGE_PATTERNS` in
 * ./retryable-errors.ts). Issue
 * [#2116](https://github.com/go-to-k/cdkd/issues/2116).
 *
 * **Why this class does not inherit the generic schedule.** The generic one
 * sleeps 1+2+4+8+8+8+8+8 = 47s, and the longest window in this class NAMES its
 * own duration: SQS's own sentence is "You must wait 60 seconds after deleting
 * a queue before you can create another with the same name." A 47s budget
 * against a 60s window does not converge — it just fails 47s later, which is
 * strictly worse than failing at once. That mismatch was live for as long as
 * `wait 60 seconds` has been in the generic table.
 *
 * **Where the numbers come from — precedent, not a fresh guess.** They are the
 * delete-then-re-create sites' existing budget, chosen for this exact window
 * (`deploy-engine.ts`'s `--replace` fallback and `rollback-executor.ts`'s
 * reverse-replacement both pass `maxRetries: 8, initialDelayMs: 2_000,
 * maxDelayMs: 10_000`). Adopting it here makes the ordinary create path and
 * the re-create sites ride the SAME window with the SAME budget, which is the
 * property #2116 is about: whether a cooldown is survivable must not depend on
 * which call site met it.
 *
 *   2 + 4 + 8 + 10 x 5 = 64s over 8 retries
 *
 * Probe grid (seconds after the first failure): 2, 6, 14, 24, 34, 44, 54, 64 —
 * covering SQS's 60s and, with room to spare, the ~23s of `status: DELETING`
 * measured on an idle Step Functions state machine
 * (`tests/integration/custom-resource-provider`).
 *
 * **What it does NOT claim.** A window LONGER than 64s still fails, with the
 * same AWS message as before. This class converts "always fails" into "fails
 * only past a budget derived from the longest window AWS itself documents" —
 * and, unlike the generic schedule, a run that exhausts it now says so (see
 * the give-up summary in {@link withRetry}), so a too-short budget is
 * reportable rather than indistinguishable from having no retry at all.
 *
 * The retry COUNT is deliberately the generic 8 rather than a new ceiling: the
 * whole change is the delay grid, so nothing about the loop's exit condition
 * moves. Same reason the dense IAM grid needed its own count and this does not.
 */
export const NAME_COOLDOWN_INITIAL_DELAY_MS = 2_000;

/** Cap for the name-cooldown backoff. See {@link NAME_COOLDOWN_INITIAL_DELAY_MS}. */
export const NAME_COOLDOWN_MAX_DELAY_MS = 10_000;

/**
 * Total sleep the name-cooldown grid spends across the generic 8 retries, in
 * milliseconds — 64s. Exported so a test can assert the budget covers the 60s
 * SQS window by ARITHMETIC rather than by re-summing the schedule by hand, and
 * so the JSDoc above cannot drift from what the loop does.
 */
export const NAME_COOLDOWN_TOTAL_BUDGET_MS = 64_000;

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
 * A THIRD class rides its own grid on the default schedule since issue
 * [#2116](https://github.com/go-to-k/cdkd/issues/2116): a NAME COOLDOWN (a
 * service still holding a name while an async delete finishes) gets
 * 2s/4s/8s then 10s to a 64s total, because the longest window in that class
 * NAMES its duration -- SQS says "wait 60 seconds" -- and the generic 47s
 * cannot ride out a 60s wait. See {@link NAME_COOLDOWN_INITIAL_DELAY_MS}.
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
  // Issue #2116: retries this sequence spent riding out a NAME COOLDOWN, and
  // the backoff they slept. Counted separately from the propagation pair for
  // the same reason that pair is separate from `serverErrorRetries` -- the
  // seconds figure exists to be compared against THIS class's 64s budget, and
  // folding in another class's waits makes that comparison meaningless.
  // Reporting only; neither figure feeds a control decision.
  let nameCooldownRetries = 0;
  let nameCooldownSleptMs = 0;
  // Issue #2026: retries this sequence spent on a transient SERVER error
  // (HTTP 500/502/503/504). Counted separately from the propagation figures so
  // the give-up line can REPORT the class this issue made retryable -- without
  // it, a sequence retried purely on 5xx burns its whole budget and rethrows
  // the raw AWS error with nothing printed, which is exactly the silence issue
  // #2018 existed to remove for the propagation class. Reporting only.
  let serverErrorRetries = 0;

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
      // Issue #2116. Same gate as the propagation class -- a caller that
      // supplied ANY schedule knob picked its cadence deliberately and gets it
      // verbatim, which is what keeps the delete-then-re-create sites' own
      // ~64s budget authoritative at those sites. `propagation` wins the
      // ternary below on the (currently impossible) overlap: the two pattern
      // lists share no substring, and if one is ever added the denser grid is
      // the safer of the two to apply.
      const nameCooldown = defaultSchedule && !propagation && isNameCooldownError(message);
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
        if (propagationRetries > 0 || serverErrorRetries > 0 || nameCooldownRetries > 0) {
          // Whether the BUDGET ran out is a property of the loop's own exit
          // condition, NOT of the retry count. Keying it on
          // `propagationRetries >= IAM_PROPAGATION_MAX_RETRIES` was wrong in
          // exactly the case the `sawPropagation` latch above exists for: one
          // interleaved throttle classifies non-propagation, so the counter
          // reaches 25 while the sequence still exhausts all 26 attempts, and
          // the summary would report a genuine exhaustion as "something else
          // ended it" -- inverting the branch the reader uses to decide
          // whether the budget needs widening. False positives were never
          // possible; this false NEGATIVE was.
          const budgetExhausted = sawPropagation && attempt >= attemptLimit;
          // The seconds figure counts PROPAGATION backoff only, so a mixed
          // sequence's throttle waits are deliberately excluded -- the number
          // exists to be compared against the 47.75s propagation budget, and
          // folding in an 8s throttle step would make that comparison
          // meaningless. Saying "of propagation backoff" rather than a bare
          // "over Ns" is what keeps it from reading as total elapsed time.
          //
          // Issue #2026: the two fields the classifier actually decides on.
          // The message alone is not always enough to say WHY a sequence
          // ended, because the message is the field that can degenerate: the
          // failure this came from ended on `UnknownError`, the placeholder
          // the AWS SDK substitutes for a response carrying no message text,
          // and at that point the `name` and `$metadata.httpStatusCode` were
          // the only evidence left -- neither of which reached any log. This
          // suffix is reporting only; nothing reads it back.
          //
          // A THUNK, not a string: `formatRetryClassificationSignals` reads
          // `$metadata.requestId`, and nothing on this path has read that field
          // before, so a hostile or exotic getter throws HERE -- outside the
          // try/catch below, replacing the very error the summary exists to
          // explain. Deferring the whole computation into the guarded call is
          // what makes the guard cover it.
          // Built from parts so a sequence that spent BOTH kinds of retry
          // reports both. With only propagation retries the rendering is
          // byte-identical to what issue #2018 shipped.
          const spent: string[] = [];
          if (propagationRetries > 0) {
            spent.push(
              `${propagationRetries} IAM-propagation ` +
                `${propagationRetries === 1 ? 'retry' : 'retries'} over ` +
                `${(propagationSleptMs / 1000).toFixed(2)}s of propagation backoff` +
                `${budgetExhausted ? ' (the full propagation budget)' : ''}`
            );
          }
          if (nameCooldownRetries > 0) {
            // Issue #2116: without this the class is exactly the silence issue
            // #2018 removed for propagation -- an exhausted 64s wait rethrows
            // the raw AWS sentence, indistinguishable from having no retry for
            // it at all, which is the one question a reader of this failure
            // needs answered (is the budget too short, or did it never
            // engage?).
            spent.push(
              `${nameCooldownRetries} name-cooldown ` +
                `${nameCooldownRetries === 1 ? 'retry' : 'retries'} over ` +
                `${(nameCooldownSleptMs / 1000).toFixed(2)}s waiting for the name to be released` +
                `${attempt >= attemptLimit ? ' (the full name-cooldown budget)' : ''}`
            );
          }
          if (serverErrorRetries > 0) {
            spent.push(
              `${serverErrorRetries} transient server-error ` +
                `${serverErrorRetries === 1 ? 'retry' : 'retries'} (HTTP 5xx)`
            );
          }
          const summary = (): string =>
            `${logicalId}: gave up after ${spent.join(' and ')} - ${message}` +
            formatRetryClassificationSignals(error);
          // Best-effort: this is a diagnostic about an error we are ABOUT to
          // rethrow, so a throwing logger must not replace it. Losing the
          // summary degrades to the pre-fix behavior; losing the error loses
          // the diagnosis entirely. Mirrors the try/catch `deploy-engine.ts`
          // puts around its own best-effort side effects.
          try {
            opts.logger?.warn?.(summary());
          } catch {
            // ignore -- the original error below is what matters
          }
        }
        throw error;
      }

      const delay = propagation
        ? Math.min(
            IAM_PROPAGATION_INITIAL_DELAY_MS * Math.pow(2, attempt),
            IAM_PROPAGATION_MAX_DELAY_MS
          )
        : nameCooldown
          ? Math.min(
              NAME_COOLDOWN_INITIAL_DELAY_MS * Math.pow(2, attempt),
              NAME_COOLDOWN_MAX_DELAY_MS
            )
          : Math.min(initialDelayMs * Math.pow(2, attempt), maxDelayMs);
      // Issue #2018: the cumulative figure is what makes a single line
      // answerable on its own ("how far into the 47.75s budget was this?").
      // Reading it off the attempt number instead requires the reader to know
      // and re-sum the schedule, which is the inference this issue asked to
      // replace with a measurement.
      //
      // The line is printed BEFORE the wait it announces, so any figure on it
      // is either behind by one delay or includes the pending one. It includes
      // it -- "through this attempt" says so -- because a reader comparing
      // against the 47.75s cap wants the total this attempt reaches, and a
      // trailing "slept so far" would have claimed 0.25s slept while nothing
      // had been slept yet.
      const backoffThroughThisAttemptMs = propagation
        ? propagationSleptMs + delay
        : propagationSleptMs;
      opts.logger?.debug(
        `  ⏳ Retrying ${logicalId} in ${delay / 1000}s (attempt ${attempt + 1}/${attemptLimit}${
          propagation
            ? `, ${(backoffThroughThisAttemptMs / 1000).toFixed(2)}s backoff through this attempt`
            : ''
        }) - ${message}`
      );

      // Interruptible sleep: check for SIGINT every second during delay.
      for (let waited = 0; waited < delay; waited += 1000) {
        if (opts.isInterrupted?.()) {
          throw opts.onInterrupted ? opts.onInterrupted() : new Error('Interrupted');
        }
        await sleep(Math.min(1000, delay - waited));
      }

      // Advanced only after the wait COMPLETED, so an interrupt mid-sleep
      // cannot inflate the summary with a wait that never happened.
      if (propagation) {
        propagationRetries++;
        propagationSleptMs = backoffThroughThisAttemptMs;
      } else if (nameCooldown) {
        nameCooldownRetries++;
        nameCooldownSleptMs += delay;
      } else if (opts.isRetryable === undefined && isTransientServerError(error)) {
        // `opts.isRetryable === undefined` is load-bearing, not symmetry with
        // `defaultSchedule`. A caller with its OWN classifier is not using the
        // arm this issue added, and counting there had two consequences:
        //
        //  - It printed a give-up summary where nothing was printed before.
        //    `RETRYABLE_HTTP_STATUS_CODES` already contains 503, so the seven
        //    throttle-only sites retry a 503 today; those are graceful-
        //    degradation paths that swallow the failure and fall back
        //    (`create-only-properties.ts`, `write-only-properties.ts`,
        //    `export.ts`), so a new default-level `warn` there is pure noise --
        //    and it would have mislabelled an 8-retry cooldown sequence that
        //    saw one 503 as "gave up after 1 transient server-error retry".
        //  - It read `$metadata` on a path where nothing had read it yet. The
        //    message-only classifiers (`isNameCooldownError` /
        //    `isRecreateRetryableError`) never touch the field, so a throwing
        //    getter escaped here mid-loop and replaced the original error --
        //    exactly the hazard the thunk below exists to prevent.
        //
        // The DELETE-shaped callers still count: they pass `maxRetries` /
        // `initialDelayMs` but no classifier, so the default one ran and this
        // arm is the class it just classified.
        serverErrorRetries++;
      }
    }
  }

  throw lastError;
}
