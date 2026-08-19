/**
 * ONE wall-clock allowance shared by a sequence of independently capped waits.
 *
 * **The problem it exists for.** A provider operation is run under a
 * per-resource deadline (`withResourceDeadline`, applied by
 * `src/cli/commands/destroy-runner.ts` and the deploy engine). Inside that
 * deadline a single `delete()` can stack several polling waits, each with its
 * own justified cap. Every cap is defensible on its own and the SUM is not:
 * three ~12-18 minute waits inside one 30-minute deadline overshoot it, and
 * `withResourceDeadline` does NOT cancel what it wraps — it rejects with a
 * generic timeout while the polling loop keeps running behind the run that has
 * already reported failure (issue #1955).
 *
 * A shared budget converts "each wait is capped" into "the PATH is capped": a
 * wait asks how many polls still fit rather than how many its own constant
 * allows, so the path spends the allowance ONCE and stops itself while the
 * deadline still has margin. Stopping ourselves is what preserves the
 * operation's own actionable error (AWS's "Cannot delete table while indexes
 * are being ..." rather than `ResourceTimeoutError`) and what stops work from
 * outliving the run.
 *
 * Deliberately NOT an `AbortController`: nothing here interrupts an in-flight
 * SDK call. It bounds how many MORE polls a loop will start, which is the whole
 * of the cost for a wait built out of `describe`-then-sleep — and it needs no
 * plumbing through every provider call.
 *
 * The clock is injectable so a test can drive elapsed time without faking
 * timers globally (the polling loops under test are real `async` loops; a
 * global fake clock would freeze them too).
 */

/**
 * The default clock: MONOTONIC, not `Date.now()`.
 *
 * `Date.now()` follows wall clock, so an NTP correction moves it in either
 * direction mid-operation — and the two directions fail differently. Backwards
 * would hand the path MORE than its total (guarded below by clamping elapsed at
 * zero); FORWARDS instantly drains the allowance, which cuts every remaining
 * wait to its one-poll floor and makes the whole path report "cdkd's allowance
 * ran out" for something that never happened. A 30-minute delete is long enough
 * to sit across a correction.
 *
 * `performance.now()` is monotonic and millisecond-denominated (a float, which
 * only matters to a consumer dividing by a poll cost — flooring already handles
 * it). Guarded rather than assumed present, so a runtime without it degrades to
 * the old behaviour instead of throwing.
 */
export const monotonicNowMs: () => number =
  typeof globalThis.performance?.now === 'function'
    ? () => globalThis.performance.now()
    : () => Date.now();

/** A monotonic wall-clock allowance, started when the object is created. */
export class ElapsedBudget {
  /** Total wall clock this budget may spend, in milliseconds. */
  readonly totalMs: number;
  private readonly clock: () => number;
  private readonly startedAt: number;

  constructor(totalMs: number, clock: () => number = monotonicNowMs) {
    if (!Number.isFinite(totalMs) || totalMs <= 0) {
      throw new RangeError(
        `ElapsedBudget: totalMs must be a positive finite number (got ${totalMs})`
      );
    }
    this.totalMs = totalMs;
    this.clock = clock;
    this.startedAt = clock();
  }

  /** Wall clock spent since the budget started. */
  elapsedMs(): number {
    // Clamped at zero: a clock that steps backwards must never hand back MORE
    // budget than the total. The default clock is monotonic so this should be
    // unreachable, but the clock is INJECTABLE — the guard belongs to the type,
    // not to the default.
    return Math.max(0, this.clock() - this.startedAt);
  }

  /** Wall clock still available, never negative. */
  remainingMs(): number {
    return Math.max(0, this.totalMs - this.elapsedMs());
  }

  isExhausted(): boolean {
    return this.remainingMs() <= 0;
  }

  /**
   * How many polls of `perAttemptMs` still fit, clamped into
   * `[minAttempts, cap]`.
   *
   * `minAttempts` defaults to 1 rather than 0 on purpose: every caller here is
   * a `describe`-then-decide loop, and a loop granted ZERO attempts reports
   * "did not settle" without ever having looked — a verdict it did not earn,
   * and one that reads as a bug in the wait rather than as a spent budget. One
   * poll costs ~1s and is the difference between a guess and an observation.
   * The overshoot it can add is therefore bounded by one poll per wait, which
   * the caller's margin against its deadline absorbs.
   */
  attemptsWithin(cap: number, perAttemptMs: number, minAttempts = 1): number {
    if (!Number.isFinite(cap) || cap <= 0) return 0;
    // An unusable per-attempt cost fails CLOSED — the floor, not the cap.
    // Returning `cap` reads as the safe direction and is the opposite of it:
    // `Infinity` means an infinitely expensive poll, `NaN` means the cost is
    // unknown, and both would grant the caller its full unclamped budget, i.e.
    // exactly the pre-fix behaviour this type exists to remove. Unreachable
    // today (every consumer passes a compile-time positive constant), which is
    // why the direction has to be argued rather than observed.
    if (!Number.isFinite(perAttemptMs) || perAttemptMs <= 0) {
      return Math.min(minAttempts, cap);
    }
    const affordable = Math.floor(this.remainingMs() / perAttemptMs);
    return Math.max(Math.min(minAttempts, cap), Math.min(cap, affordable));
  }
}

/**
 * Budgets keyed by the thing they bound, so an operation that is RE-ENTERED
 * inside one deadline keeps spending the same allowance.
 *
 * That re-entry is the case a per-call budget silently misses. `destroy-runner`
 * wraps its whole outer retry loop — up to four `delete()` calls — in ONE
 * deadline, so a `delete()` that fails on something the outer loop classes as
 * retryable (a throttle) starts again from the top. A budget created per call
 * would reset there and the same path could be paid twice inside one deadline;
 * a budget looked up by key does not.
 *
 * Entries are RETAINED on failure (that is the point) and released by the
 * caller on a terminal outcome, so the map holds at most one entry per
 * in-flight resource.
 *
 * **The key must identify the resource, not just name it.** A registry holding
 * bare names collides whenever two distinct resources share one — for AWS that
 * is any name-scoped-by-region identifier — and the collision is silent: the
 * second resource inherits the first's spent allowance. Callers are expected to
 * qualify the key themselves (see `providers/dynamodb-delete-budget.ts`'s
 * `deleteBudgetKey`), because only the caller knows what the name is scoped by.
 */
export class ElapsedBudgetRegistry {
  private readonly budgets = new Map<string, ElapsedBudget>();

  /**
   * The budget for `key`, creating it on first use and REUSING it on re-entry.
   * `totalMs` and `clock` are only read when the entry is CREATED — a re-entry
   * must not be able to grant itself a fresh allowance, nor a fresh clock.
   */
  acquire(key: string, totalMs: number, clock: () => number = monotonicNowMs): ElapsedBudget {
    const existing = this.budgets.get(key);
    if (existing) return existing;
    const created = new ElapsedBudget(totalMs, clock);
    this.budgets.set(key, created);
    return created;
  }

  /** Drop `key`'s budget — call on a TERMINAL outcome, never between retries. */
  release(key: string): void {
    this.budgets.delete(key);
  }

  /** Live entries; exists so a test can prove release actually released. */
  get size(): number {
    return this.budgets.size;
  }

  clear(): void {
    this.budgets.clear();
  }
}
