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
import { type ElapsedBudget, monotonicNowMs } from '../../utils/elapsed-budget.js';

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
