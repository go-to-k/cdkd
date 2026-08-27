/**
 * The ONE wall-clock allowance the DynamoDB DELETE path spends, for both
 * `AWS::DynamoDB::Table` and `AWS::DynamoDB::GlobalTable` (issue #1955).
 *
 * **What was wrong.** Every wait on that path is individually capped and
 * individually justified, and the caps do not know about each other:
 *
 * ```
 *   --remove-protection     600 polls  ~12 min   GlobalTable, ACTIVE wait, FIRST
 *   ACTIVE wait              60 polls   ~72s     Table, ACTIVE wait, FIRST
 *   auto-scaling teardown   see below            GlobalTable, table + per GSI,
 *                                                per replica, BEFORE the first poll
 *   waitForReplicaGone      600 polls  ~12 min   per NON-LOCAL replica
 *   #1521 pre-delete gate   900 polls  ~18 min   (issue #1521)
 *   index-busy retry loop   ~10.4 min at 8 retries / ~18.4 at 14 (#1830/#1931/#1950)
 *   waitForTableGone        600 polls  ~12 min   (only on a late SUCCESS)
 * ```
 *
 * Every poll figure is `polls x ~1.2s`, the MEASURED cost of a sleep plus a
 * `DescribeTable` round trip — so a 600-poll wait is ~12 min, not the ~10 min
 * its `1 poll = 1s` era comments used to say.
 *
 * The `--remove-protection` term is the sharpest of the ones a first pass at
 * this fix missed: it runs FIRST, its predicate is `ACTIVE` *and* no
 * transitional index — the very condition the rest of the path is about — so on
 * a `cdkd destroy --remove-protection` against a table with a building GSI it
 * spends its full ~12 min at t=0 and leaves the gate and the loop the
 * remainder.
 *
 * The auto-scaling teardown is not poll-shaped at all, and its story changed in
 * review. It was believed to inherit `withRetry`'s default schedule; it did
 * not — the two `withRetry` sites in that method are both in the REGISTER
 * branch, and every delete-path caller passes `newSettings: undefined`, which
 * takes the bare-`send` teardown branch. So the term was single-attempt and
 * fast, and a budget clamp on it was inert. What the correction exposed is a
 * half-applied twin: the register branch retries throttles because an
 * un-retried `ThrottlingException` leaves a target silently UNregistered, and
 * the teardown has the exact symmetric hazard — a silently RETAINED target that
 * a future table of the same name inherits (PR #403) — with no retry at all.
 * The teardown is now wrapped in the same throttle-only retry, bounded by
 * {@link autoScalingRetriesWithinDeleteBudget}, so the term is real, bounded,
 * and no longer asymmetric.
 *
 * `destroy-runner.ts` runs the whole thing under ONE per-resource deadline
 * (`DEFAULT_RESOURCE_TIMEOUT_MS`, 30 min). A replicated GlobalTable whose index
 * is transitioning reached ~40 min, a single-region one reached ~40.4 min on
 * the late-success path, and a single-region `--remove-protection` destroy
 * reached 12 + 18 + 10.4 ~= ~40.4 min on the EXHAUSTED-budget path — all over
 * it. Three consequences, all of them the
 * issue's:
 *
 *  1. **Stacked waits.** The deadline was spent three or four times over,
 *     because each cap was sized as though it were the only one.
 *  2. **A non-cancelling overshoot.** `withResourceDeadline` rejects but does
 *     not cancel, so the run reported a generic `ResourceTimeoutError` that
 *     never mentions indexes — replacing AWS's own actionable sentence, which
 *     the bounded re-arm exists to surface — WHILE the polling loop kept
 *     running behind the failed run.
 *  3. **Throttle compounding.** `deleteTableWithIndexBusyRetry`'s inner
 *     `isRetryable` is index-busy-only by design, so a THROTTLED `DeleteTable`
 *     escapes to `destroy-runner.ts`'s outer loop, which DOES class throttles
 *     as retryable and re-enters `delete()` from the top — paying the whole
 *     settle-and-retry sequence again inside the SAME deadline (2 x ~19.6 min
 *     ~= ~39 min on the `Table` path after issue #1950).
 *
 * **What replaces it.** A budget acquired once per physical table and shared by
 * every wait on the path. Each wait asks how many polls still fit rather than
 * how many its own constant allows, so the path spends the allowance ONCE
 * ((1)), stops itself while the deadline still has minutes of margin — leaving
 * AWS's own error as the failure and nothing polling behind it ((2)) — and,
 * because the budget is keyed by physical id in a registry rather than created
 * per call, a re-entry from the outer retry loop CONTINUES the same allowance
 * instead of restarting it ((3)).
 *
 * The per-type retry budgets (`TABLE_DELETE_INDEX_BUSY_MAX_RETRIES` /
 * `GLOBAL_TABLE_DELETE_INDEX_BUSY_MAX_RETRIES`) are unchanged and still
 * meaningful: they shape HOW the allowance is spent — how many fresh
 * `DeleteTable` probes it buys — while this bounds how much there is. What
 * changes is that neither of them, nor any wait cap, is load-bearing for
 * staying under the deadline any more.
 */

import { INDEX_SETTLE_POLL_INTERVAL_MS } from '../dynamodb-index-busy-delete.js';
import { ElapsedBudget, monotonicNowMs } from '../../utils/elapsed-budget.js';
import { isInterruptedWaitError } from '../interrupt-watch.js';
import {
  isMarkedNonRetryable,
  isRetryableTransientError,
} from '../../deployment/retryable-errors.js';
import type { Logger } from '../../types/config.js';

/**
 * The `DescribeTable` round trip each poll pays ON TOP of its sleep.
 *
 * MEASURED, not assumed: the live issue-#1950 run's 60-poll re-arm took ~72s
 * and its per-attempt gaps were 73 / 74 / 77 / 80 / 80 / 80s once `withRetry`'s
 * backoff is subtracted, i.e. ~1.2s per poll against a 1s sleep. Pricing a poll
 * at the bare sleep interval is what once let a ~10.4 min loop be quoted as
 * ~8.8 min.
 */
export const DYNAMODB_DELETE_POLL_RTT_MS = 200;

/**
 * What ONE poll of a delete-path wait costs in wall clock. Every budget->polls
 * conversion below goes through this, and it READS
 * {@link INDEX_SETTLE_POLL_INTERVAL_MS} rather than restating 1000 so the two
 * cannot drift while this arithmetic claims they agree.
 */
export const DYNAMODB_DELETE_POLL_COST_MS =
  INDEX_SETTLE_POLL_INTERVAL_MS + DYNAMODB_DELETE_POLL_RTT_MS;

/**
 * The allowance the WHOLE delete path gets, however many waits it contains.
 *
 * **Why 26 minutes.** It has to sit under the per-resource deadline with enough
 * margin that the deadline never fires first — because the whole point is to
 * fail with the operation's own error rather than with a generic timeout — and
 * it has to be large enough that no shape which completes TODAY starts failing:
 *
 * ```
 *   Table, single pass          ACTIVE wait ~72s + loop(14) ~18.4 min = ~19.6 min   fits
 *   GlobalTable, single-region  #1521 gate ~18 min + loop(8) ~10.4 min = ~28.4 min  clamped by ~2.4 min
 * ```
 *
 * The one shape it shortens is the GlobalTable single-region EXHAUSTED-budget
 * case, and shortening it costs nothing: that path ends by throwing AWS's own
 * index-busy sentence either way, ~2.4 min sooner now.
 *
 * **Every OTHER shape was already past the 30-minute deadline before this
 * change**, which is why counting the two newly-added terms does not move the
 * number. `--remove-protection` on a single-region GlobalTable is
 * 12 + 18 + 10.4 ~= ~40.4 min; on a one-replica table 12 + 12 + 18 + 10.4 ~=
 * ~52.4 min; the late-success gone-wait adds ~12 min to whichever of those it
 * follows; the auto-scaling teardown is unbounded. All of them previously ended
 * in the generic `ResourceTimeoutError` with work still running, so a bounded
 * stop is a strict improvement there rather than a trade — there is no shape
 * between 26 and 30 minutes that this budget takes away except the ~2.4 min
 * above, because 30 minutes was already the ceiling and everything past it
 * failed.
 *
 * It is deliberately ONE number for both types rather than a per-type pair. The
 * two per-type RETRY budgets exist because the two types arrive at the loop
 * having spent different amounts; this is the ceiling on the total, and a total
 * does not need to know which terms produced it.
 */
export const DYNAMODB_DELETE_BUDGET_MS = 26 * 60_000;

/**
 * What is left of the deadline after the budget is spent.
 *
 * It absorbs everything the poll arithmetic does not price: the `DeleteTable` /
 * `UpdateTable` calls themselves, `destroy-runner.ts`'s outer-loop backoff
 * (5 + 10 + 20s across its three retries, which elapses between `delete()`
 * calls and therefore inside the budget's own clock but not inside any wait),
 * the one-poll floor {@link ElapsedBudget.attemptsWithin} grants each wait, and
 * the last `withRetry` backoff step before the loop notices the budget is gone.
 */
export const DYNAMODB_DELETE_DEADLINE_MARGIN_MS = 4 * 60_000;

/**
 * What both DynamoDB providers self-report through `getMinResourceTimeoutMs()`.
 *
 * The engine resolves the per-resource deadline as
 * `perTypeCliOverride ?? max(getMinResourceTimeoutMs(), slowTypeFloor,
 * globalCliDefault)`, so declaring this makes "the budget fits inside the
 * deadline" a GUARANTEE rather than an assumption about the CLI default: a user
 * who lowers `--resource-timeout` globally can no longer re-create the crossing
 * this module exists to remove. It equals today's `DEFAULT_RESOURCE_TIMEOUT_MS`
 * (30 min), so at default settings nothing moves — `max(30m, 30m)` is 30m.
 *
 * A per-type override (`--resource-timeout AWS::DynamoDB::Table=5m`) still
 * wins; that is the documented escape hatch, and it is the only way to make
 * this type abort sooner than its self-report.
 */
export const DYNAMODB_DELETE_MIN_RESOURCE_TIMEOUT_MS =
  DYNAMODB_DELETE_BUDGET_MS + DYNAMODB_DELETE_DEADLINE_MARGIN_MS;

/**
 * Test seam for the budget, mirroring the providers' `deleteTableRetryDelays`
 * sleep seams. Production leaves BOTH fields unset, so
 * {@link DYNAMODB_DELETE_BUDGET_MS} and the real wall clock apply.
 *
 * `clock` is here rather than only `totalMs` because the behaviour worth
 * testing is what happens as the budget DRAINS, and a test cannot drain a
 * 26-minute allowance by waiting. Shrinking `totalMs` alone reaches the
 * clamped-poll-count arm but never the EXHAUSTED one, which is the arm that
 * stops the retry loop and preserves AWS's own message — the whole point of
 * issue #1955. A controllable clock reaches both, deterministically, without
 * `vi.useFakeTimers()` freezing the provider's own polling loops.
 */
export const dynamoDbDeleteBudgetOverride: { totalMs?: number; clock?: () => number } = {};

export function resolveDynamoDbDeleteBudgetMs(): number {
  const override = dynamoDbDeleteBudgetOverride.totalMs;
  return override !== undefined && override > 0 ? override : DYNAMODB_DELETE_BUDGET_MS;
}

export function resolveDynamoDbDeleteBudgetClock(): () => number {
  return dynamoDbDeleteBudgetOverride.clock ?? monotonicNowMs;
}

/**
 * The registry key for one table's delete allowance.
 *
 * A DynamoDB table NAME is unique per region, not globally, so a bare
 * `physicalId` collides across regions and the second table silently inherits
 * the first's spent allowance. In practice `destroy-runner.ts` builds a fresh
 * provider (and therefore a fresh registry) per region, so the collision is not
 * reachable today — but that is an invariant of the CALLER, enforced nowhere,
 * and the fix costs one string concat. `\0` cannot appear in either component.
 *
 * `region` is the STATE's region (`DeleteContext.expectedRegion`), which is
 * available synchronously at the top of `delete()` — unlike the client's own
 * region, which needs an await and would push the acquire past the
 * `--remove-protection` flip. Pre-region state records leave it undefined,
 * which degrades to the old bare-name key rather than failing.
 */
export function deleteBudgetKey(physicalId: string, region: string | undefined): string {
  return `${region ?? ''}\u0000${physicalId}`;
}

/**
 * What a wait is ALLOWED to spend, and whether the shared allowance — rather
 * than the wait's own constant — is what decided it.
 *
 * The flag is not bookkeeping: it is the difference between two conclusions a
 * user has to act on differently. "AWS did not settle within the wait we gave
 * it" says wait longer or look at the resource; "cdkd's own allowance ran out
 * first, so AWS was never given the full wait" says re-run the destroy. A
 * clamped wait that reports only its clamped COUNT states the first while
 * meaning the second — and at the one-poll floor it reads as
 * `did not disappear within 1s` after cdkd actually waited 26 minutes.
 */
export interface DeleteBudgetPolls {
  /** Polls the wait may actually run. */
  readonly attempts: number;
  /** The wait's OWN cap, before the allowance clamped it. */
  readonly cap: number;
  /** True when `attempts < cap` because the shared allowance is short. */
  readonly clampedByBudget: boolean;
}

/**
 * The poll cap a wait may actually use: its own constant, or what the shared
 * budget can still afford, whichever is smaller.
 *
 * `budget` is optional and an absent one means "unbounded by this mechanism" —
 * the CREATE / UPDATE callers of these same waits keep their original caps
 * verbatim, since the deadline arithmetic this fixes is the delete path's.
 */
export function pollsWithinDeleteBudget(
  cap: number,
  budget: ElapsedBudget | undefined
): DeleteBudgetPolls {
  if (!budget) return { attempts: cap, cap, clampedByBudget: false };
  const attempts = budget.attemptsWithin(cap, DYNAMODB_DELETE_POLL_COST_MS);
  return { attempts, cap, clampedByBudget: attempts < cap };
}

/**
 * Polls below which a wait is not EVIDENCE about AWS, only evidence that cdkd
 * stopped asking.
 *
 * The warn-versus-throw split on `waitForTableGone`, and the strong wording of
 * the exhaustion note, both hang off this, and before it existed both hung off
 * `attempts < cap` — which is arithmetic, not evidence. With ~14 min of the
 * allowance already spent a 600-poll wait is still granted ~500 polls, i.e.
 * ten real minutes of `DescribeTable`; calling that "cdkd's allowance ran out,
 * AWS was not given a real wait" is false, and downgrading its failure to a
 * warning is a decision made by two minutes of wall clock rather than by
 * anything the user can act on.
 *
 * 60 polls (~72s) because the provider's own gone-wait note records that a
 * typical small-table delete completes in 5-30s: past roughly twice the top of
 * that range, cdkd HAS given AWS a real wait and a table still present is a
 * signal about AWS. Below it, cdkd barely looked, and the honest report is
 * about cdkd rather than about the table.
 */
export const DELETE_SHORT_WAIT_POLLS = 60;

/**
 * A wait's use of the shared allowance: how many polls it was granted at entry,
 * how many it actually ran, and whether the allowance — rather than its own cap
 * — is what ended it.
 *
 * **Why this is an object and not just a poll count.** Granting a count at
 * entry PREDICTS the cost of a poll (~1.2s) and then treats the prediction as a
 * bound. It is not one: under sustained `DescribeTable` throttling the SDK's
 * own internal retries can push a poll to ~3s, so a wait entered with 12.1 min
 * of allowance left is granted its full 600 polls and then runs for ~30 min —
 * past the allowance AND past the margin, with `withResourceDeadline` firing
 * behind it. That is the non-cancelling overshoot this whole module exists to
 * remove, re-entering through the mechanism meant to remove it. So the
 * allowance is consulted on EVERY iteration, not only at entry.
 */
export interface DeleteWait {
  /** The wait's own constant. */
  readonly cap: number;
  /** Polls granted at entry: `min(cap, affordable)`, never below one. */
  readonly grantedPolls: number;
  /** Polls actually performed. */
  readonly pollsRun: number;
  /** The allowance, not the cap, ended this wait (at entry or mid-loop). */
  readonly endedByBudget: boolean;
  /** ...and it ended before the wait became evidence about AWS. */
  readonly cutShort: boolean;
  /**
   * Call at the TOP of each iteration; `false` means stop.
   *
   * The FIRST poll is always granted even on a spent allowance — that is the
   * one-poll floor, and a loop that broke before probing would report "did not
   * settle" without ever having looked.
   */
  nextPoll(): boolean;
  /** The clause to append to this wait's own message; `''` when the allowance played no part. */
  note(): string;
}

class DeleteWaitImpl implements DeleteWait {
  readonly cap: number;
  readonly grantedPolls: number;
  private ran = 0;
  private brokeEarly = false;
  private readonly entryClamped: boolean;
  private readonly budget: ElapsedBudget | undefined;

  constructor(cap: number, budget: ElapsedBudget | undefined) {
    const polls = pollsWithinDeleteBudget(cap, budget);
    this.cap = polls.cap;
    this.grantedPolls = polls.attempts;
    this.entryClamped = polls.clampedByBudget;
    this.budget = budget;
  }

  nextPoll(): boolean {
    if (this.ran >= this.grantedPolls) return false;
    // Checked AFTER at least one probe, so the one-poll floor survives.
    if (this.ran >= 1 && this.budget?.isExhausted() === true) {
      this.brokeEarly = true;
      return false;
    }
    this.ran += 1;
    return true;
  }

  get pollsRun(): number {
    return this.ran;
  }

  get endedByBudget(): boolean {
    return this.brokeEarly || this.entryClamped;
  }

  get cutShort(): boolean {
    return this.endedByBudget && this.ran < DELETE_SHORT_WAIT_POLLS;
  }

  note(): string {
    if (!this.endedByBudget) return '';
    // The ACTUAL allowance, not the shipped constant: under the test seam (and
    // under any future per-type sizing) quoting the constant claims 26 minutes
    // for a 60-second budget.
    const minutes = Math.max(1, Math.round((this.budget?.totalMs ?? 0) / 60_000));
    if (this.cutShort) {
      return (
        ` — cdkd's shared ~${minutes}-minute delete allowance was already spent, so this wait ` +
        `made only ${this.ran} of its ${this.cap} polls and AWS was not given a real wait. ` +
        `Nothing is necessarily wrong with the table; re-run the destroy.`
      );
    }
    // Long, but still ended by the allowance. Factual, and deliberately WITHOUT
    // the "re-run" advice: cdkd did give AWS a real wait here, so the table
    // still being present is a signal about AWS rather than about cdkd.
    return (
      ` (cdkd's shared ~${minutes}-minute delete allowance capped this wait at ${this.ran} of ` +
      `its ${this.cap} polls.)`
    );
  }
}

/** Begin a delete-path wait that draws on the shared allowance. */
export function beginDeleteWait(cap: number, budget: ElapsedBudget | undefined): DeleteWait {
  return new DeleteWaitImpl(cap, budget);
}

/**
 * `withRetry` retries the delete-path auto-scaling teardown may still fund.
 *
 * The teardown runs BEFORE the first budgeted poll — table-level plus one call
 * per GSI, per non-local replica, then again locally — and until this change it
 * had NO retry at all: the two `withRetry` sites in `applyAutoScalingDiff` are
 * both in the REGISTER branch, and every delete-path caller passes
 * `newSettings: undefined`, which takes the bare-`send` teardown branch. (An
 * earlier revision of this file claimed the teardown inherited `withRetry`'s
 * default schedule and would therefore spend ~47s per call under account-wide
 * throttling; that was false, and the clamp built on it was inert. The claim is
 * recorded here because it is the kind of arithmetic a later reader would
 * otherwise trust.)
 *
 * The teardown is now wrapped in the same throttle-only retry the register
 * branch uses, for the symmetric reason: that branch retries because an
 * un-retried `ThrottlingException` leaves a target silently UNregistered, and
 * an un-retried throttle here leaves one silently REGISTERED — the PR #403 leak
 * a future table of the same name inherits. Retrying is what makes a bound
 * necessary, and the bound is what makes retrying safe on a path that shares
 * one deadline with everything after it.
 *
 * Retries are bounded rather than the CALL being skipped, deliberately. The
 * teardown exists because a surviving scalable target is silently inherited by
 * a future table of the same name (PR #403), and skipping re-introduces that
 * leak. So a drained allowance still issues every call once —
 * `withRetry` with `maxRetries: 0` runs the operation exactly once — and still
 * warns actionably on each failure; it just stops paying to retry them.
 */
export function autoScalingRetriesWithinDeleteBudget(
  budget: ElapsedBudget | undefined,
  defaultMaxRetries: number
): number {
  if (!budget) return defaultMaxRetries;
  // Funded from the SURPLUS above the reserve, not from the whole allowance.
  // Bounding the teardown by the full remaining budget would bound it (the
  // aggregate can never exceed the allowance, since each call re-reads it) but
  // would let a throttled burst spend the entire thing before `DeleteTable` is
  // even issued — converting a silent target leak into a destroy that fails on
  // the first index-busy refusal because the retry loop has no allowance left.
  // The teardown is defense-in-depth against a leak; the delete is the job. So
  // it gets the surplus and nothing more.
  const surplusMs = budget.remainingMs() - AUTO_SCALING_TEARDOWN_RESERVE_MS;
  if (surplusMs <= 0) return 0;
  // `withRetry`'s schedule caps at 8s per step, so the LAST retry is the most
  // expensive one and pricing every retry at the cap is the conservative read.
  return Math.max(
    0,
    Math.min(defaultMaxRetries, Math.floor(surplusMs / AUTO_SCALING_RETRY_STEP_MS))
  );
}

/**
 * The part of the allowance the auto-scaling teardown may NOT spend on retries.
 *
 * Sized so the terms that actually delete the table — the #1521 gate, the
 * index-busy loop and the gone-wait — keep the bulk of the allowance no matter
 * how throttled the teardown is. 20 of the 26 minutes, leaving the teardown up
 * to ~6 min of retry backoff, which at ~8s a retry is ~45 retries spread across
 * however many calls the table's index and replica count produce.
 */
const AUTO_SCALING_TEARDOWN_RESERVE_MS = 20 * 60_000;

/** `withRetry`'s capped backoff step (`maxDelayMs`), the cost of one retry. */
const AUTO_SCALING_RETRY_STEP_MS = 8_000;

/** `withRetry`'s default `maxRetries`, which the teardown takes today. */
export const AUTO_SCALING_TEARDOWN_MAX_RETRIES = 8;

/* ------------------------------------------------------------------------- *
 * `--remove-protection` compensation (issue #1978)
 *
 * Lives in this module for the same reason the budget above does: it is a
 * property of the DynamoDB DELETE PATH, which `AWS::DynamoDB::Table` and
 * `AWS::DynamoDB::GlobalTable` walk with two separate `delete()` bodies. The
 * issue asks specifically that the two halves not diverge — the #1955 review
 * had already found one half-applied twin in this pair — and one shared
 * spelling is a stronger answer to that than two symmetric ones, which is the
 * same call `../dynamodb-index-busy-delete.ts` makes for the index-busy retry.
 * ------------------------------------------------------------------------- */

/**
 * What THIS delete run did to `DeletionProtectionEnabled`, threaded from the
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
   * accepted across the outer loop's re-entry.
   */
  deleteAccepted: boolean;
}

/**
 * {@link ProtectionFlipRecord}s keyed by the resource they describe, so a
 * `delete()` that is RE-ENTERED remembers what an earlier attempt did.
 *
 * Shaped after `ElapsedBudgetRegistry` in `../../utils/elapsed-budget.ts` and
 * keyed with the same {@link deleteBudgetKey}, because it is the same re-entry:
 * `destroy-runner.ts` wraps its outer retry loop — up to four `delete()` calls
 * — in ONE deadline, and re-invokes `delete()` for anything it classes as
 * retryable. A record created per call cannot see that. Attempt 1 observes the
 * guard ON, flips it off and fails on a throttle; attempt 2's pre-flip
 * `DescribeTable` now reports the guard OFF (attempt 1 is why), so a per-call
 * record starts and stays `false` and a TERMINAL failure on attempt 2
 * compensates nothing. That is precisely the issue's retry-then-fail case
 * (#1978).
 *
 * A provider INSTANCE FIELD would be wrong for the same reason the budget is
 * not one: providers are singletons serving concurrent resources, so one field
 * would carry another table's flip. The key qualifies the physical id by
 * region, exactly as the budget's does.
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
   * passed the same `DELETE_BUDGET_REUSE_WINDOW_MS` the allowance uses, and it
   * is still needed for the reason it was introduced: entries are RETAINED on a
   * throw, so without any bound a retained record would let a much LATER
   * destroy of the same table re-enable a guard it never touched — the inverse
   * hazard of the one this record exists for.
   *
   * Measuring from FIRST acquisition instead is what issue #2211 reported, and
   * it re-creates issue #1978's residue through this very mechanism. The retry
   * sequence is unbounded while the window is a wall clock, so a
   * `--resource-timeout` overshoot past `DELETE_BUDGET_REUSE_WINDOW_MS` lets a
   * LIVE sequence age out MID-flight: `acquire` drops the entry and hands the
   * next attempt a fresh `{ flippedOffByThisRun: false }`, whose pre-flip
   * `DescribeTable` then observes the guard already OFF — because attempt 1
   * turned it off — so the latch stays `false` and a terminal failure
   * compensates nothing.
   *
   * KNOWN BOUND, stated because the obvious reading overclaims it. `acquire` is
   * called ONCE per `delete()`, at the top, and nothing touches the entry's
   * idle STOPWATCH again (the record's fields are mutated throughout, and
   * `release` drops it) — so the interval this measures is not a gap BETWEEN
   * operations, it is the previous ATTEMPT's own duration plus the outer loop's
   * backoff.
   *
   * That is normally comfortable, and the arithmetic is worth having right.
   * `DELETE_BUDGET_REUSE_WINDOW_MS` is `DYNAMODB_DELETE_BUDGET_MS` (26 min)
   * plus `DYNAMODB_DELETE_DEADLINE_MARGIN_MS` (4 min). The 26 minutes is the
   * allowance for the WHOLE retry sequence, not for one attempt —
   * `ElapsedBudgetRegistry.acquire` hands back the SAME budget on re-entry — so
   * a budget-conforming attempt plus one backoff is at most ~26m20s against a
   * 30-minute window, and the margin exists precisely to price that backoff.
   *
   * What can still age out a successor is therefore an attempt that OVERRUNS
   * the allowance rather than one that merely spends it: `attemptsWithin` keeps
   * a `minAttempts` floor poll even at zero remaining, and the auto-scaling
   * teardown is unpriced (see `src/utils/elapsed-budget.ts`). The slide removes
   * the ACCUMULATION case — many attempts summing past the window, the common
   * shape and the one issue #2211 reported — not the overrun one.
   *
   * Closing the remainder means sliding at attempt END too (a `touch(key)` in
   * `delete()`'s catch, making the measured gap the loop backoff rather than
   * the attempt), or sizing this window independently of the delete budget.
   * Both are behaviour changes to the delete path and belong in their own
   * change rather than riding this one.
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
 * Whether `error` ends the delete for good, i.e. whether `destroy-runner.ts`'s
 * outer loop will NOT re-enter `delete()` for it.
 *
 * This is the gate on the compensation, and it is the issue's own point:
 * re-enabling the guard after a RETRYABLE failure would flip the flag back and
 * forth across a retry sequence, since the next `delete()` immediately turns it
 * off again. Compensation belongs on the terminal failure only.
 *
 * The predicate MIRRORS `destroy-runner.ts`'s re-entry condition
 * (`!isMarkedNonRetryable && (isRetryableTransientError || 'Too Many
 * Requests')`) rather than inventing a second classification, and it is applied
 * to the error the provider is about to THROW — the same wrapped
 * `ProvisioningError` message the outer loop will classify — so the two cannot
 * disagree about who gets re-entered.
 *
 * A user abort is terminal here even though nothing classifies it: the run is
 * being torn down, so no re-entry is coming and the guard would otherwise stay
 * down. That is the Ctrl-C route recorded on the issue.
 *
 * KNOWN NARROWINGS, all deliberate. Each leaves the guard off in a case this
 * mechanism does not reach; none of them is silent about it here.
 *
 *  1. **Attempt-cap exhaustion.** A genuinely retryable failure that exhausts
 *     the outer loop's attempt cap ends the run with the guard still off,
 *     because the provider cannot see which attempt is the last one.
 *     Compensating on every attempt instead would trade that residue for an
 *     `UpdateTable` pair per retry against a table AWS is already throttling.
 *  2. **The per-resource DEADLINE route.** `src/deployment/resource-deadline.ts`
 *     rejects the OUTER promise on its timer and does NOT cancel what it
 *     wraps — the provider's own `await` never settles as a rejection, so no
 *     `ResourceTimeoutError` ever enters `delete()`'s `catch` and nothing here
 *     runs for it. The provider keeps polling behind a run that has already
 *     reported failure (the same non-cancelling shape issue #1955 documents),
 *     and if that poll eventually succeeds the table is gone anyway. Closing
 *     this would mean making the deadline cancel — a change to a mechanism
 *     every provider shares — so it is recorded, not fixed here.
 *  3. **The compensation itself is unbounded.** `reEnable` is one `UpdateTable`
 *     with no timeout of its own, so on Ctrl-C it adds one SDK call per flipped
 *     table to a teardown the user has already asked to end. Left unbounded on
 *     purpose: an `UpdateTable` is a single control-plane round trip (no
 *     polling, no wait for ACTIVE), the SDK's own retry/timeout config already
 *     applies to it, and it is the ONLY thing standing between a Ctrl-C and a
 *     live table with its guard stripped — a timeout short enough to be felt
 *     during teardown would mostly convert successful restores into the "could
 *     NOT re-enable" line. Revisit if the compensation ever grows a WAIT.
 */
export function isTerminalDeleteFailure(error: unknown): boolean {
  if (isInterruptedWaitError(error)) return true;
  if (isMarkedNonRetryable(error)) return true;
  // Deliberately reads the TOP-LEVEL message, unlike `destroy-runner.ts`'s and
  // `retry.ts`'s twins of this same two-arm shape, which issue #2302 moved onto
  // `retryClassificationText`. The difference is the population, not the
  // pattern: those two classify errors from ANY provider, so a provider that
  // redacts its thrown message (only `S3BucketProvider` does today) empties
  // what they match on. This one runs solely on the DynamoDB delete path and
  // classifies only `DynamoDBTableProvider`'s own throws, which carry their
  // cause's text verbatim -- so the chain read would be a no-op here, and
  // `retryClassificationText` is opt-in anyway (nothing on this path stamps
  // itself with `markRedactedCause`). Move it onto the chain text the moment a
  // DynamoDB throw starts redacting; the shape is otherwise identical.
  const message = error instanceof Error ? error.message : String(error);
  return !(isRetryableTransientError(error, message) || message.includes('Too Many Requests'));
}

/**
 * What {@link compensateRemovedDeletionProtection} actually did, which the
 * caller needs because it decides whether the flip record may be DROPPED.
 *
 *  - `not-applicable` — there was nothing to put back: this run never flipped
 *    the guard, AWS had already accepted the `DeleteTable`, or the failure is
 *    retryable and a re-entry is coming.
 *  - `restored` — the compensating `UpdateTable(DeletionProtectionEnabled:
 *    true)` succeeded, so the guard is back on.
 *  - `failed` — the compensating `UpdateTable` was attempted and did NOT
 *    succeed (either arm: the ResourceNotFound one that cannot tell "gone"
 *    from "not ACTIVE", or any other error). The guard is, as far as cdkd
 *    knows, still OFF and cdkd is the one that turned it off.
 *
 * The three-way split exists for that last case alone. A caller that releases
 * the flip record on it throws away the only in-process memory that cdkd owes
 * this table a re-enable, and the record is what a LATER delete of the same
 * key reads: released, that delete observes the guard already off, records
 * `flippedOffByThisRun: false`, and compensates NOTHING — so a table cdkd
 * stripped stays stripped. Retaining it does not re-open the hazard the
 * release closes, because the unwanted-`UpdateTable(true)` hazard is about a
 * guard cdkd has already PUT BACK; here it demonstrably has not.
 *
 * ONE residual this does NOT cover, named because every other one here is:
 * the table really is gone, a table of the SAME name is recreated in the same
 * region inside the sliding window, and THAT delete fails terminally. The
 * inherited record then has cdkd issue `UpdateTable(DeletionProtectionEnabled:
 * true)` on a table it never flipped. The trade is still the right one -- the
 * alternative leaves a table cdkd stripped still stripped, which is the worse
 * direction -- but the argument above does not reach this case, so it is stated
 * rather than implied away.
 */
export type ProtectionCompensationOutcome = 'not-applicable' | 'restored' | 'failed';

/** Inputs to {@link compensateRemovedDeletionProtection}. */
export interface ProtectionCompensationOptions {
  readonly flip: ProtectionFlipRecord;
  /** The failure that is about to be re-thrown. Never replaced, never annotated. */
  readonly error: unknown;
  readonly logicalId: string;
  readonly physicalId: string;
  /** `table` / `GlobalTable`, for the narration only. */
  readonly typeLabel: string;
  readonly logger: Logger;
  /**
   * The region the delete was aimed at, when the caller knows it. Rendered into
   * the remediation commands, which are otherwise unrunnable in the one case
   * that most needs them: the race this compensation is reached through is a
   * REGION MISMATCH, so an operator whose default profile region differs gets
   * the same ResourceNotFound from the suggested `describe-table` and concludes
   * the table is gone -- confirming the exact half cdkd deliberately stopped
   * asserting.
   */
  readonly region?: string | undefined;
  /** Issues the `UpdateTable(DeletionProtectionEnabled: true)`. */
  readonly reEnable: () => Promise<void>;
}

/**
 * Put `DeletionProtectionEnabled` back after a `--remove-protection` flip whose
 * delete then failed terminally (issue #1978).
 *
 * BEST-EFFORT, and it says so. Three properties, each of which the issue names:
 *
 *  - **It never masks the original error.** This function does not throw —
 *    including when the re-enable itself fails — because it runs inside the
 *    `catch` that is about to re-throw the delete failure, and a secondary
 *    write that throws would REPLACE the reported outcome with its own. The
 *    delete failure stays the outcome; this is a secondary line.
 *  - **It never edits the primary message either.** Splicing the re-enable's
 *    text into the thrown error would change what `isRetryableTransientError`
 *    substring-matches on, so a compensation failure carrying a throttle phrase
 *    could flip a terminal delete failure into a retryable one and re-run the
 *    whole path. The narration goes to the logger, not into the throw.
 *  - **It names the table when it fails.** A silent failure here leaves a LIVE
 *    table with its guard down, which is the exact residue this mechanism
 *    exists to remove, so the message carries the physical id and the one
 *    command that fixes it.
 *
 * It REPORTS what it did rather than only doing it (see
 * {@link ProtectionCompensationOutcome}), because the caller's decision to drop
 * the flip record is not the same decision as whether to compensate: dropping
 * it after a re-enable that FAILED discards the only record that cdkd still
 * owes this table its guard back.
 */
export async function compensateRemovedDeletionProtection(
  opts: ProtectionCompensationOptions
): Promise<ProtectionCompensationOutcome> {
  if (!opts.flip.flippedOffByThisRun) return 'not-applicable';
  // AWS took the delete, so whatever threw afterwards was a WAIT, not the
  // delete: the table is `DELETING` and there is no guard to restore on it.
  // Gated on the RECORD rather than on the shape of the error, because the
  // error that gets here in that case (`... did not disappear within ...`)
  // reads exactly like a terminal refusal and would otherwise be answered with
  // an `UpdateTable(true)` against a dying table plus a log line claiming it is
  // "LIVE with its deletion protection still off" — both false.
  if (opts.flip.deleteAccepted) return 'not-applicable';
  if (!isTerminalDeleteFailure(opts.error)) return 'not-applicable';

  try {
    await opts.reEnable();
    opts.logger.warn(
      `DynamoDB ${opts.typeLabel} ${opts.logicalId}: the delete failed after ` +
        `--remove-protection had turned DeletionProtectionEnabled off, so it was ` +
        `re-enabled on ${opts.physicalId}. The delete failure below is the outcome.`
    );
    return 'restored';
  } catch (reEnableError) {
    const detail = reEnableError instanceof Error ? reEnableError.message : String(reEnableError);
    if (isResourceNotFoundError(reEnableError)) {
      // Issue #2224: the ERROR line below asserts "that table is LIVE with its
      // deletion protection still off", and on this arm cdkd does not know
      // that. So the ASSERTION is dropped — but the line is NOT silenced, and
      // the difference is load-bearing.
      //
      // `ResourceNotFoundException` from `UpdateTable` does not mean "the table
      // is gone". The SDK's own model says it covers a table whose "status
      // might not be ACTIVE" (`@aws-sdk/client-dynamodb` errors.d.ts), and that
      // case is reachable and not exotic: on `AWS::DynamoDB::GlobalTable`,
      // `waitForReplicaGone` can time out with the table still UPDATING and
      // `deleteAccepted` still false (it is set only after `DeleteTable`), so
      // the compensation fires against a LIVE, unprotected table and is told
      // ResourceNotFound. Downgrading that to `debug` would hide, at default
      // verbosity, exactly the case this line exists to report.
      //
      // `warn` is therefore the level: visible by default, but not claiming a
      // fact cdkd cannot establish. The message states the ambiguity and gives
      // the operator both the check and the remedy.
      //
      // The race issue #2224 actually named: `delete()` observes the guard on,
      // flips it, issues `DeleteTable`, AWS answers ResourceNotFound — a
      // success for the provider — but `assertRegionMatch` throws inside that
      // branch BEFORE it reaches `protectionFlips.release`, so the record
      // arrives here still latched. Deliberately NOT fixed by skipping the
      // compensation on an RNF-shaped DELETE error (the flip may have landed on
      // a table that still exists, and the RNF can come from another call in
      // that branch) nor by releasing the record there (the retained-on-throw
      // contract is what the re-entered-delete latch depends on).
      // `--region` is rendered whenever the caller knows it. Without it the
      // suggested `describe-table` runs against the operator's default profile
      // region, which on the region-mismatch race that reaches this arm answers
      // the SAME ResourceNotFound — leading them to conclude "gone", i.e. the
      // one thing this message deliberately stops asserting.
      const regionArg = opts.region ? ` --region ${opts.region}` : '';
      opts.logger.warn(
        `DynamoDB ${opts.typeLabel} ${opts.logicalId}: could not re-enable ` +
          `DeletionProtectionEnabled on ${opts.physicalId} after the delete failed — ` +
          `DynamoDB answered ResourceNotFound. That most commonly means the table is ` +
          `gone or its status is not ACTIVE, and it can also mean the table is not in ` +
          `this region or account. If it still exists, its deletion protection is OFF. ` +
          `Check with: aws dynamodb describe-table --table-name ${opts.physicalId}` +
          `${regionArg} and if it is there, restore it with: aws dynamodb update-table ` +
          `--table-name ${opts.physicalId}${regionArg} --deletion-protection-enabled. ` +
          `(${detail})`
      );
      // `failed`, not `not-applicable`: the re-enable was ATTEMPTED and did not
      // land. Whether the table is gone or merely not ACTIVE is exactly what
      // this arm says cdkd cannot tell, so the record is kept and a later
      // delete of the same key may try again — the safe direction for the one
      // case that is not "gone".
      return 'failed';
    }
    opts.logger.error(
      `DynamoDB ${opts.typeLabel} ${opts.logicalId}: could NOT re-enable ` +
        `DeletionProtectionEnabled on ${opts.physicalId} after the delete failed — ` +
        `that table is LIVE with its deletion protection still off. Restore it with: ` +
        `aws dynamodb update-table --table-name ${opts.physicalId} ` +
        `--deletion-protection-enabled. (${detail})`
    );
    return 'failed';
  }
}

/**
 * Whether `error` is DynamoDB's `ResourceNotFoundException`.
 *
 * Keyed on the SDK's `name` rather than on `instanceof`, so this module keeps
 * its (deliberate) freedom from an `@aws-sdk/client-dynamodb` import and so a
 * second client instance of the class still matches.
 *
 * Deliberately NOT a `cause`-chain walk: every `reEnable` callback handed to
 * {@link compensateRemovedDeletionProtection} is a bare `UpdateTable` send, so
 * the SDK error arrives unwrapped. If one ever wraps its call, this answers
 * `false` and the compensation keeps the LOUD error line — the safe direction.
 */
// One latent widening is worth naming beyond the wrapping direction argued
// above, because it is the one that would make the caller's downgrade unsafe:
// if either `reEnable` ever moves onto a PER-REPLICA client (the GlobalTable
// provider already builds those), a ResourceNotFound would mean "wrong region"
// rather than "table gone", and the caller's `warn` arm would be describing a
// live, unprotected table in another region. The caller's message now says a
// third meaning is possible and renders `--region`, but a move to regional
// clients should revisit this predicate rather than inherit it.
function isResourceNotFoundError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { name?: unknown }).name === 'ResourceNotFoundException'
  );
}
