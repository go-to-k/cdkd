import { describe, it, expect } from 'vite-plus/test';
import {
  ElapsedBudget,
  ElapsedBudgetRegistry,
  monotonicNowMs,
} from '../../../src/utils/elapsed-budget.js';

/**
 * The shared wall-clock allowance behind issue #1955.
 *
 * Pinned in its own file, named for the module, because the primitive is
 * generic: the DynamoDB delete path is its first consumer, not its definition.
 * The consumer-side behaviour (which wait draws from it, when the retry loop
 * stops) lives in `tests/unit/provisioning/dynamodb-delete-budget.test.ts`.
 *
 * Every test drives an INJECTED clock rather than real time — the whole point
 * of the type is what it answers as time passes, and a suite that cannot move
 * time can only ever exercise the fresh-budget case.
 */

/** A clock the test moves by hand. */
function fakeClock(): { now: () => number; advance: (ms: number) => void } {
  let t = 1_000_000;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe('ElapsedBudget', () => {
  it('reports the whole total as remaining before any time passes', () => {
    const clock = fakeClock();
    const budget = new ElapsedBudget(60_000, clock.now);

    expect(budget.totalMs).toBe(60_000);
    expect(budget.elapsedMs()).toBe(0);
    expect(budget.remainingMs()).toBe(60_000);
    expect(budget.isExhausted()).toBe(false);
  });

  it('drains as the clock moves and never reports negative remaining', () => {
    const clock = fakeClock();
    const budget = new ElapsedBudget(60_000, clock.now);

    clock.advance(45_000);
    expect(budget.remainingMs()).toBe(15_000);
    expect(budget.isExhausted()).toBe(false);

    // Past the total. `remainingMs` is CLAMPED — a negative would turn into a
    // negative poll count at every consumer, and `attemptsWithin`'s floor is
    // the only thing that should ever decide the minimum.
    clock.advance(60_000);
    expect(budget.remainingMs()).toBe(0);
    expect(budget.isExhausted()).toBe(true);
  });

  it('treats a clock that steps BACKWARDS as zero elapsed, never as extra budget', () => {
    // Not hypothetical on a long-running destroy: `Date.now()` follows wall
    // clock, so an NTP correction can move it back. Reading a negative elapsed
    // would hand the path MORE than its total, which is the one direction the
    // whole mechanism must not fail in.
    let t = 1_000_000;
    const budget = new ElapsedBudget(60_000, () => t);
    t -= 5_000;

    expect(budget.elapsedMs()).toBe(0);
    expect(budget.remainingMs()).toBe(60_000);
  });

  it('refuses a non-positive or non-finite total', () => {
    expect(() => new ElapsedBudget(0)).toThrow(RangeError);
    expect(() => new ElapsedBudget(-1)).toThrow(RangeError);
    expect(() => new ElapsedBudget(Number.NaN)).toThrow(RangeError);
    expect(() => new ElapsedBudget(Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });

  describe('attemptsWithin', () => {
    it('returns the caller`s own cap while the budget can afford it', () => {
      const clock = fakeClock();
      const budget = new ElapsedBudget(60_000, clock.now);

      // 60s can afford 50 polls at 1.2s; the caller only wants 10.
      expect(budget.attemptsWithin(10, 1_200)).toBe(10);
    });

    it('clamps to what the REMAINING budget affords', () => {
      const clock = fakeClock();
      const budget = new ElapsedBudget(60_000, clock.now);
      clock.advance(48_000); // 12s left -> exactly 10 polls at 1.2s

      expect(budget.attemptsWithin(900, 1_200)).toBe(10);
    });

    it('still grants ONE poll when the budget is spent', () => {
      // Deliberate: every consumer is a describe-then-decide loop, and a loop
      // granted zero attempts reports "did not settle" without ever having
      // looked. The overshoot is bounded at one poll per wait, which the
      // caller's deadline margin absorbs.
      const clock = fakeClock();
      const budget = new ElapsedBudget(60_000, clock.now);
      clock.advance(120_000);

      expect(budget.isExhausted()).toBe(true);
      expect(budget.attemptsWithin(900, 1_200)).toBe(1);
    });

    it('never exceeds the cap, even for a cap below the one-poll floor', () => {
      const clock = fakeClock();
      const budget = new ElapsedBudget(60_000, clock.now);
      clock.advance(120_000);

      // The floor is clamped BY the cap: a caller asking for 0 polls must not
      // be handed 1 just because the budget is spent.
      expect(budget.attemptsWithin(0, 1_200)).toBe(0);
    });

    it('fails CLOSED on an unusable per-attempt cost — the floor, not the cap', () => {
      // The direction has to be argued rather than observed, because no
      // consumer can reach it today. Returning `cap` reads as the safe answer
      // and is the opposite of it: `Infinity` means an infinitely expensive
      // poll and `NaN` means the cost is unknown, and both would hand the
      // caller its full UNCLAMPED budget — i.e. exactly the pre-fix behaviour
      // this type exists to remove, restored silently by a guard that looks
      // defensive.
      const budget = new ElapsedBudget(60_000, fakeClock().now);
      expect(budget.attemptsWithin(900, 0)).toBe(1);
      expect(budget.attemptsWithin(900, Number.NaN)).toBe(1);
      expect(budget.attemptsWithin(900, Number.POSITIVE_INFINITY)).toBe(1);
      expect(budget.attemptsWithin(900, -5)).toBe(1);
      // ...and the floor is still clamped BY the cap.
      expect(budget.attemptsWithin(0, Number.NaN)).toBe(0);
    });

    it('defaults to a MONOTONIC clock rather than the wall clock', () => {
      // `Date.now()` follows wall clock, so a forward NTP correction mid-delete
      // drains the allowance instantly and every wait after it reports an
      // exhausted budget for something that never happened. The backwards clamp
      // above covers the other direction; this covers the one that fires.
      expect(monotonicNowMs).not.toBe(Date.now);
      const before = monotonicNowMs();
      expect(Number.isFinite(before)).toBe(true);
      expect(monotonicNowMs()).toBeGreaterThanOrEqual(before);
    });
  });
});

describe('ElapsedBudgetRegistry', () => {
  it('REUSES the entry on re-acquire, so a re-entry cannot restart the clock', () => {
    // This IS the throttle-compounding fix (issue #1955 term 3): the destroy
    // runner re-enters `delete()` from the top inside ONE deadline, and a
    // per-call budget would hand that second pass a fresh allowance.
    const clock = fakeClock();
    const registry = new ElapsedBudgetRegistry();

    const first = registry.acquire('orders-table', 60_000, clock.now);
    clock.advance(50_000);

    // A second acquire asks for a FULL fresh allowance and must not get one.
    const second = registry.acquire('orders-table', 60_000, clock.now);
    expect(second).toBe(first);
    expect(second.remainingMs()).toBe(10_000);
  });

  it('keys by resource, so a concurrent sibling gets its OWN allowance', () => {
    // `destroy-runner.ts` deletes a level's resources CONCURRENTLY through one
    // provider instance, so a per-instance budget would make two tables share
    // one clock and starve the second.
    const clock = fakeClock();
    const registry = new ElapsedBudgetRegistry();

    const orders = registry.acquire('orders-table', 60_000, clock.now);
    clock.advance(50_000);
    const events = registry.acquire('events-table', 60_000, clock.now);

    expect(events).not.toBe(orders);
    expect(orders.remainingMs()).toBe(10_000);
    expect(events.remainingMs()).toBe(60_000);
  });

  it('release drops the entry so the NEXT operation starts fresh', () => {
    const clock = fakeClock();
    const registry = new ElapsedBudgetRegistry();

    const first = registry.acquire('orders-table', 60_000, clock.now);
    clock.advance(50_000);
    registry.release('orders-table');
    expect(registry.size).toBe(0);

    const second = registry.acquire('orders-table', 60_000, clock.now);
    expect(second).not.toBe(first);
    expect(second.remainingMs()).toBe(60_000);
  });

  it('releasing an unknown key is a no-op', () => {
    const registry = new ElapsedBudgetRegistry();
    expect(() => registry.release('never-acquired')).not.toThrow();
    expect(registry.size).toBe(0);
  });

  /**
   * `acquire`'s fourth parameter, pinned in the PRIMITIVE's own suite (issue
   * #2244 item 2).
   *
   * Why here, when a consumer already exercises it: the DynamoDB delete-budget
   * suite covers the parameter through its own caller
   * (`tests/unit/provisioning/dynamodb-delete-budget.test.ts`, "a RETAINED
   * allowance goes stale once its deadline has certainly fired"), so the
   * behaviour is not unfenced -- issue #2244's "no test anywhere passes
   * `reuseWithinMs`" is FALSE against this tree, and the correction belongs
   * next to the fix. What was genuinely missing is a fence in the file someone
   * EDITING `src/utils/elapsed-budget.ts` opens: a contract whose only test
   * lives in one consumer's suite is one a refactor of the primitive can break
   * without ever reading it.
   *
   * The load-bearing case is the last one. `ProtectionFlipRegistry` -- the
   * sibling registry in `src/provisioning/providers/dynamodb-delete-budget.ts`,
   * with the same shape, the same key and the SAME window constant -- went
   * SLIDING for issue #2211 while this one deliberately did not. Two look-alike
   * types differing in one invisible respect is exactly what gets "helpfully"
   * unified, so the difference is asserted rather than left to the JSDoc.
   */
  describe('reuseWithinMs', () => {
    it('reuses FOREVER when the bound is omitted, so the caller opts INTO staleness', () => {
      // The default, and the reason the DynamoDB caller passes the parameter at
      // all: entries are retained on a throw, so without a bound a much later
      // operation reaching the same key inherits a spent allowance and gets no
      // time at all for a delete of its own.
      const clock = fakeClock();
      const registry = new ElapsedBudgetRegistry();

      const first = registry.acquire('orders-table', 60_000, clock.now);
      clock.advance(10 * 365 * 24 * 60 * 60_000);

      expect(registry.acquire('orders-table', 60_000, clock.now)).toBe(first);
      expect(first.remainingMs()).toBe(0);
    });

    it('drops the entry once the bound has elapsed, and the replacement gets a FULL allowance', () => {
      const clock = fakeClock();
      const registry = new ElapsedBudgetRegistry();
      const WINDOW_MS = 30_000;

      const first = registry.acquire('orders-table', 26_000, clock.now, WINDOW_MS);
      clock.advance(20_000);

      // Inside the bound: the SAME allowance, still draining. Asserted here as
      // well as in the case above, because it is what makes the next assertion
      // a bound rather than "acquire always replaces".
      expect(registry.acquire('orders-table', 26_000, clock.now, WINDOW_MS)).toBe(first);
      expect(first.remainingMs()).toBe(6_000);

      clock.advance(WINDOW_MS);
      const replacement = registry.acquire('orders-table', 26_000, clock.now, WINDOW_MS);

      expect(replacement).not.toBe(first);
      // `totalMs` and `clock` are read only when the entry is CREATED, so the
      // replacement is where a caller's own numbers finally take effect.
      expect(replacement.remainingMs()).toBe(26_000);
      expect(registry.size).toBe(1);
    });

    it('still reuses at EXACTLY the bound — the comparison is strictly greater', () => {
      // The boundary is a decision, not an accident: the bound is the deadline
      // the allowance is SIZED against, and a caller arriving exactly on it has
      // not yet outlived it. Pinned because the sibling registry spells the
      // same boundary from the other side (`<= reuseWithinMs` to REUSE), so
      // "make the two read alike" is a one-character change either way.
      const clock = fakeClock();
      const registry = new ElapsedBudgetRegistry();
      const WINDOW_MS = 30_000;

      const first = registry.acquire('orders-table', 26_000, clock.now, WINDOW_MS);
      clock.advance(WINDOW_MS);
      expect(registry.acquire('orders-table', 26_000, clock.now, WINDOW_MS)).toBe(first);

      clock.advance(1);
      expect(registry.acquire('orders-table', 26_000, clock.now, WINDOW_MS)).not.toBe(first);
    });

    it('measures the bound from CREATION, not from the last reuse — this window does NOT slide', () => {
      // THE divergence from `ProtectionFlipRegistry`, which slid for issue
      // #2211. Both are correct, for opposite reasons:
      //
      //  - the FLIP RECORD carries a fact ("an earlier attempt turned the guard
      //    off") that a long retry sequence must not lose mid-flight, so its
      //    clock has to restart on every re-entry;
      //  - an ALLOWANCE is the thing being SPENT. Restarting its staleness
      //    clock on reuse would keep alive, indefinitely, the one entry that is
      //    re-acquired most often — i.e. exactly the exhausted allowance a new
      //    operation must not inherit. The type makes that hard by
      //    construction: one `ElapsedBudget` is both the allowance and the
      //    stopwatch, so there is no idle clock to restart without discarding
      //    the spend, which is what the sibling needs a SECOND stopwatch for.
      //
      // Three acquires, each arriving one second inside the window but summing
      // well past it. A sliding window reuses on the third; a fixed one does
      // not, and the discriminator is entry IDENTITY.
      const clock = fakeClock();
      const registry = new ElapsedBudgetRegistry();
      const WINDOW_MS = 30_000;

      const first = registry.acquire('orders-table', 26_000, clock.now, WINDOW_MS);

      clock.advance(WINDOW_MS - 1_000);
      expect(registry.acquire('orders-table', 26_000, clock.now, WINDOW_MS)).toBe(first);

      clock.advance(WINDOW_MS - 1_000);
      const third = registry.acquire('orders-table', 26_000, clock.now, WINDOW_MS);
      expect(third).not.toBe(first);
      expect(registry.size).toBe(1);
    });
  });
});
