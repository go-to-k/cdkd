/**
 * The ONE wall-clock allowance the DynamoDB DELETE path spends, for both
 * `AWS::DynamoDB::Table` and `AWS::DynamoDB::GlobalTable` (issue #1955).
 *
 * **What was wrong.** Every wait on that path is individually capped and
 * individually justified, and the caps do not know about each other:
 *
 * ```
 *   waitForReplicaGone      600 polls  ~12 min   per NON-LOCAL replica
 *   #1521 pre-delete gate   900 polls  ~18 min   (issue #1521)
 *   index-busy retry loop   ~10.4 min at 8 retries / ~18.4 at 14 (#1830/#1931/#1950)
 *   waitForTableGone        600 polls  ~12 min   (only on a late SUCCESS)
 * ```
 *
 * `destroy-runner.ts` runs the whole thing under ONE per-resource deadline
 * (`DEFAULT_RESOURCE_TIMEOUT_MS`, 30 min). A replicated GlobalTable whose index
 * is transitioning reached ~40 min and a single-region one reached ~40.4 min on
 * the late-success path, both over it. Three consequences, all of them the
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
import type { ElapsedBudget } from '../../utils/elapsed-budget.js';

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
 * index-busy sentence either way, ~2.4 min sooner now. Every other overshooting
 * shape — the late-success gone-wait, any replicated table, and both types'
 * throttle-compounded double pass — previously ended in the generic
 * `ResourceTimeoutError` with the loop still running, so a bounded stop is a
 * strict improvement there rather than a trade.
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
  return dynamoDbDeleteBudgetOverride.clock ?? Date.now;
}

/**
 * The poll cap a wait may actually use: its own constant, or what the shared
 * budget can still afford, whichever is smaller.
 *
 * `budget` is optional and an absent one means "unbounded by this mechanism" —
 * the CREATE / UPDATE callers of these same waits keep their original caps
 * verbatim, since the deadline arithmetic this fixes is the delete path's.
 */
export function pollsWithinDeleteBudget(cap: number, budget: ElapsedBudget | undefined): number {
  if (!budget) return cap;
  return budget.attemptsWithin(cap, DYNAMODB_DELETE_POLL_COST_MS);
}
