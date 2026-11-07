/**
 * The flip record and its registry, the final-attempt scope, and the terminal
 * delete-failure verdict, split out of `deletion-protection-compensation.ts`
 * (#5835), which re-exports every symbol here.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { ElapsedBudget, monotonicNowMs } from '../../../utils/elapsed-budget.js';
import { isInterruptedWaitError } from '../../interrupt-watch.js';
import {
  isMarkedNonRetryable,
  isRetryableTransientError,
  retryClassificationText,
} from '../../../deployment/retryable-errors.js';
import { injectiveKey } from '../../../state/record-keys.js';

/**
 * What THIS delete run did to the deletion guard, threaded from the
 * `--remove-protection` flip down to the error path that may have to undo it.
 *
 * Mutable-by-reference on purpose: the flip happens deep inside `delete()`
 * while the compensation runs in the `catch` that wraps it, and a returned
 * value cannot cross a `throw`.
 */
export interface ProtectionFlipRecord {
  /**
   * True only when BOTH halves held: the pre-flip `DescribeTable` OBSERVED the
   * guard on, and the `UpdateTable` that turned it off was accepted.
   *
   * The observation is what keeps the compensation from becoming a state change
   * the user never asked for. A table whose protection was ALREADY off before
   * the run must never be "re-enabled" — cdkd would then be turning a failed
   * destroy into a configuration change, which is strictly worse than the
   * residue this whole mechanism exists to clean up. `undefined`-shaped
   * uncertainty resolves the same way: if the observing describe failed, we do
   * not know what the user had, so we leave it alone.
   *
   * LATCHING, and that is the whole reason this record is keyed rather than
   * per-call (see {@link ProtectionFlipRegistry}). A re-entered `delete()`
   * observes the guard already OFF — *because the previous attempt turned it
   * off* — so a writer that ASSIGNED its own observation here would erase what
   * the first attempt recorded, and the terminal failure on the second attempt
   * would compensate nothing. Writers set it to `true` or leave it; only a
   * `release()` clears it.
   */
  flippedOffByThisRun: boolean;

  /**
   * Whether AWS ACCEPTED a `DeleteTable` for this resource in this run.
   *
   * Once it has, the table is on its way out and the guard must NOT be put
   * back: a later throw on this path is a WAIT failing, not the delete. The
   * concrete case is `waitForTableGone`'s `Table X did not disappear within
   * Ns`, which is raised after `DeleteTable` already succeeded and matches no
   * retryable pattern, so it is terminal by this module's own predicate. Left
   * ungated, the compensation would issue `UpdateTable(true)` against a
   * `DELETING` table and then narrate that the table is "LIVE with its deletion
   * protection still off" — false, and pointing the user at a table that is
   * already gone.
   *
   * Latching for the same reason as the field above: an accepted delete stays
   * accepted across the outer loop's re-entry. The Cloud Control adopter is the
   * exception and decides it per attempt, since each attempt issues a fresh
   * `DeleteResource` whose handler can refuse
   * (`CloudControlProvider.deleteThroughCloudControl`).
   */
  deleteAccepted: boolean;
}

/**
 * {@link ProtectionFlipRecord}s keyed by the resource they describe, so a
 * `delete()` that is RE-ENTERED remembers what an earlier attempt did.
 *
 * Shaped after `ElapsedBudgetRegistry` in `../../utils/elapsed-budget.ts`,
 * because it is the same re-entry: `destroy-runner.ts` wraps its outer retry
 * loop — up to four `delete()` calls — in ONE deadline, and re-invokes
 * `delete()` for anything it classes as retryable. A record created per call
 * cannot see that. Attempt 1 observes the guard ON, flips it off and fails on
 * a throttle; attempt 2's pre-flip `DescribeTable` now reports the guard OFF
 * (attempt 1 is why), so a per-call record starts and stays `false` and a
 * TERMINAL failure on attempt 2 compensates nothing. That is precisely the
 * retry-then-fail case of issue #1978.
 *
 * A provider INSTANCE FIELD would be wrong for the same reason the budget is
 * not one: providers are singletons serving concurrent resources, so one field
 * would carry another resource's flip. The key qualifies the physical id by
 * region (and, for a provider serving several types, by type — see
 * {@link protectionFlipKey}).
 *
 * Entries are RETAINED on a throw — that is the point — and released by the
 * caller on a terminal outcome (a completed delete, or a NotFound), so the map
 * holds at most one entry per in-flight resource.
 */
export class ProtectionFlipRegistry {
  private readonly records = new Map<
    string,
    { readonly record: ProtectionFlipRecord; idle: ElapsedBudget }
  >();

  /**
   * The record for `key`, creating it on first use and REUSING it on re-entry.
   *
   * `reuseWithinMs` bounds how long an entry may sit UNUSED, and the window
   * SLIDES: every reuse restarts the stopwatch, so what is bounded is the idle
   * time since the last `acquire` rather than the entry's total lifetime. It is
   * still needed for the reason it was introduced: entries are RETAINED on a
   * throw, so without any bound a retained record would let a much LATER
   * destroy of the same resource re-enable a guard it never touched — the
   * inverse hazard of the one this record exists for.
   *
   * Measuring from FIRST acquisition instead is what issue #2211 reported, and
   * it re-creates issue #1978's residue through this very mechanism. The retry
   * sequence is unbounded while the window is a wall clock, so a
   * `--resource-timeout` overshoot past the window lets a LIVE sequence age
   * out MID-flight: `acquire` drops the entry and hands the next attempt a
   * fresh `{ flippedOffByThisRun: false }`, whose pre-flip readback then
   * observes the guard already OFF — because attempt 1 turned it off — so the
   * latch stays `false` and a terminal failure compensates nothing.
   *
   * KNOWN BOUND, stated because the obvious reading overclaims it. `acquire` is
   * called ONCE per `delete()`, at the top, and nothing touches the entry's
   * idle STOPWATCH again (the record's fields are mutated throughout, and
   * `release` drops it) — so the interval this measures is not a gap BETWEEN
   * operations, it is the previous ATTEMPT's own duration plus the outer loop's
   * backoff. What can still age out a successor is therefore an attempt that
   * OVERRUNS the window rather than one that merely spends it. The slide
   * removes the ACCUMULATION case — many attempts summing past the window, the
   * common shape and the one issue #2211 reported — not the overrun one.
   * Closing the remainder means sliding at attempt END too (a `touch(key)` in
   * `delete()`'s catch), which is a behaviour change to the delete path and
   * belongs in its own change.
   */
  acquire(
    key: string,
    reuseWithinMs: number,
    clock: () => number = monotonicNowMs
  ): ProtectionFlipRecord {
    const existing = this.records.get(key);
    if (existing) {
      if (existing.idle.elapsedMs() <= reuseWithinMs) {
        // The SLIDE. Restarting the stopwatch on every reuse is what keeps a
        // long retry sequence from aging out its own record mid-flight.
        //
        // Note this rebases on the CALLER's clock, where the sibling
        // `ElapsedBudgetRegistry.acquire` documents that a re-entry must not
        // grant itself a fresh one. Inert in production -- both resolve to
        // `monotonicNowMs`, and the divergence is only reachable from a test
        // that injects different clocks to the same key -- but the two
        // registries genuinely differ here, so do not read one's contract onto
        // the other.
        existing.idle = new ElapsedBudget(reuseWithinMs, clock);
        return existing.record;
      }
      this.records.delete(key);
    }
    const created = {
      record: { flippedOffByThisRun: false, deleteAccepted: false },
      // Only a monotonic stopwatch is wanted here; the total is never read.
      idle: new ElapsedBudget(reuseWithinMs, clock),
    };
    this.records.set(key, created);
    return created.record;
  }

  /** Drop `key`'s record — call on a TERMINAL outcome, never between retries. */
  release(key: string): void {
    this.records.delete(key);
  }

  /** Live entries; exists so a test can prove release actually released. */
  get size(): number {
    return this.records.size;
  }

  clear(): void {
    this.records.clear();
  }
}

/**
 * The {@link ProtectionFlipRegistry} key for a provider that serves SEVERAL
 * resource types from one instance (RDS / DocDB / Neptune: a cluster and an
 * instance).
 *
 * The type is part of the key because a cluster and an instance live in
 * separate identifier namespaces, so `db1` can name one of each in the same
 * region; a key without the type would hand the instance's delete the
 * cluster's flip record. Region-qualified for the same reason the DynamoDB
 * key is, and ENCODED rather than separated, since every component comes from
 * a state record (go-to-k/cdkd#3496).
 */
export function protectionFlipKey(
  resourceType: string,
  physicalId: string,
  region: string | undefined
): string {
  return injectiveKey(resourceType, region ?? '', physicalId);
}

/**
 * How long a flip record of any {@link deleteWithProtectionCompensation}
 * caller may sit idle between two `delete()`
 * attempts of one retry sequence before a later delete no longer inherits it.
 *
 * The 30-minute default per-resource deadline, which is what bounds a retry
 * sequence at default settings. Spelled here rather than imported from
 * `deploy-engine.ts`, which a provider helper must not depend on. It is
 * generous on purpose: on these types an attempt that can still be
 * compensated is SHORT — a readback, a `Modify*`, and a `Delete*` that AWS
 * refused — because once AWS accepts the `Delete*` the record's
 * `deleteAccepted` latch ends compensation for good, whatever the wait after
 * it costs. The Cloud Control path is the exception: its handler refuses a
 * delete only by reporting FAILED at the end of a wait, so an attempt there
 * spans that wait, which a slow type's poll budget can stretch past this window.
 */
export const PROTECTION_FLIP_REUSE_WINDOW_MS = 30 * 60_000;

/**
 * Whether the `delete()` running in this async chain is the outer retry loop's
 * LAST attempt; `undefined` outside {@link runDeleteAttempt}.
 */
const finalDeleteAttempt = new AsyncLocalStorage<boolean>();

/**
 * Run one attempt of an outer delete-retry loop, telling
 * {@link isTerminalDeleteFailure} whether the loop will re-enter `delete()`
 * after it (issue #4318).
 *
 * The loop owns that answer, not the provider: on its LAST attempt a failure
 * the classifier calls retryable is still the end of the delete, and without
 * this scope the compensation would read it as "a re-entry is coming" and
 * leave the guard off with no message. An `AsyncLocalStorage` scope rather than
 * a `DeleteContext` field, so every adopter -- and every delegation between
 * providers -- sees it without threading.
 *
 * The caller passes `isFinal` on EVERY attempt, `false` included: a nested
 * stack's child destroy runs inside its parent's attempt, and an explicit
 * scope per attempt is what keeps the child's early attempts from inheriting
 * the parent's "final".
 */
export function runDeleteAttempt<T>(isFinal: boolean, attempt: () => Promise<T>): Promise<T> {
  return finalDeleteAttempt.run(isFinal, attempt);
}

/**
 * Whether `error` ends the delete for good, i.e. whether `destroy-runner.ts`'s
 * outer loop will NOT re-enter `delete()` for it.
 *
 * This is the gate on the compensation, and it is issue #1978's own point:
 * re-enabling the guard after a RETRYABLE failure would flip the flag back and
 * forth across a retry sequence, since the next `delete()` immediately turns it
 * off again. Compensation belongs on the terminal failure only.
 *
 * The predicate MIRRORS `destroy-runner.ts`'s re-entry condition
 * (`!isMarkedNonRetryable && (isRetryableTransientError || 'Too Many
 * Requests')`, both arms on `retryClassificationText`) rather than inventing a
 * second classification, and it is applied to the error the provider is about
 * to THROW, so the two cannot disagree about who gets re-entered. The loop's
 * other exit, its attempt cap, reaches here through {@link runDeleteAttempt}:
 * any failure of the last attempt is terminal (issue #4318).
 *
 * A user abort is terminal here even though nothing classifies it: the run is
 * being torn down, so no re-entry is coming and the guard would otherwise stay
 * down. That is the Ctrl-C route recorded on issue #1978.
 *
 * KNOWN NARROWINGS, all deliberate. Each leaves the guard off in a case this
 * mechanism does not reach; none of them is silent about it here.
 *
 *  1. **A caller with no attempt scope.** Outside {@link runDeleteAttempt} the
 *     predicate cannot see an attempt cap, so a retryable failure reads as "a
 *     re-entry is coming". Only `cdkd destroy` and `cdkd rollback` set
 *     `removeProtection`, and each scopes its delete attempts.
 *  2. **The per-resource DEADLINE route.** `src/deployment/resource-deadline.ts`
 *     rejects the OUTER promise on its timer and does NOT cancel what it
 *     wraps — the provider's own `await` never settles as a rejection, so no
 *     `ResourceTimeoutError` ever enters `delete()`'s `catch` and nothing here
 *     runs for it. The provider keeps polling behind a run that has already
 *     reported failure (the same non-cancelling shape issue #1955 documents),
 *     and if that poll eventually succeeds the resource is gone anyway. Closing
 *     this would mean making the deadline cancel — a change to a mechanism
 *     every provider shares — so it is recorded, not fixed here. A provider
 *     that WAITS with the guard down must therefore finish inside the deadline:
 *     the RDS / DocDB / Neptune final-snapshot settle waits (issue #5155) bound
 *     themselves by `enclosingDeadlineRemainingMs()` minus a margin, so their
 *     own timeout throws, and is compensated, before the deadline fires.
 *  3. **The compensation itself is unbounded.** `reEnable` is one control-plane
 *     write with no timeout of its own, so on Ctrl-C it adds one SDK call per
 *     flipped resource to a teardown the user has already asked to end. Left
 *     unbounded on purpose: it is a single round trip, the SDK's own
 *     retry/timeout config already applies to it, and it is the ONLY thing
 *     standing between a Ctrl-C and a live resource with its guard stripped — a
 *     timeout short enough to be felt during teardown would mostly convert
 *     successful restores into the "could NOT re-enable" line. Two adopters
 *     wait. The Cloud Control registry path's `UpdateResource` is
 *     asynchronous: its wait is not interruptible, gives up on a transport
 *     outage after the flip's own short transient grace, and otherwise waits
 *     out an update that stays in progress for the type's full Cloud Control
 *     poll budget (15 minutes, longer for a known-slow type). The RDS
 *     DBCluster / DBInstance re-enable resends a busy / not-available refusal
 *     for up to `PROTECTION_FLIP_RETRY_WAIT_MS` (10 minutes), bounded by
 *     `enclosingDeadlineRemainingMs()` minus a margin, Ctrl-C teardown
 *     included.
 */
export function isTerminalDeleteFailure(error: unknown): boolean {
  if (isInterruptedWaitError(error)) return true;
  if (finalDeleteAttempt.getStore() === true) return true;
  if (isMarkedNonRetryable(error)) return true;
  // The CHAIN text, as the loop reads it (issue #2302). An adopter delete throw
  // stamped with `markRedactedCause` -- the Cloud Control abandoned wait, and
  // any provider delete wrap that names an AWS failure by its class
  // (go-to-k/cdkd#2319) -- reads terminal on its top-level message while the
  // loop retries it: read there, the record was released and the retry's
  // refusal went uncompensated (issue #4318).
  const classify = retryClassificationText(error);
  return !(isRetryableTransientError(error, classify) || classify.includes('Too Many Requests'));
}
