import type { ResourceUpdateResult } from '../types/resource.js';

/**
 * Consumption of {@link ResourceUpdateResult}'s `'partial'` arm (issue
 * [#1819](https://github.com/go-to-k/cdkd/issues/1819)) — the twin of
 * {@link ./delete-outcome.ts} for the UPDATE verb.
 *
 * `ResourceProvider.update` gained an outcome channel whose `'partial'` arm
 * means **the resource was updated, and something the update was responsible
 * for retiring survives and is no longer tracked by cdkd**. The four providers
 * that implement a REPLACEMENT inside `update()` by pairing create and delete
 * are the producers; before the channel existed they emitted a `logger.warn`
 * and the deploy exited 0 with the old resource alive and out of state.
 *
 * **The module must stay a LEAF — no imports beyond the type, ever.** Same
 * reason as `delete-outcome.ts`: the deploy engine, the drift-revert command
 * and the rollback executor all consume it, and those already sit on a dense
 * import ring. A helper that pulled anything else in would close it.
 */

/**
 * The `reason` of a `'partial'` update outcome, or `undefined` when the
 * provider reported a clean update (`{ outcome: 'updated' }` or the
 * back-compat omission ~80 providers still use).
 *
 * A function rather than an inline `result.outcome === 'partial'` test at
 * three call sites, so the back-compat reading lives in ONE place — the same
 * call {@link ./delete-outcome.ts} made, and for the same reason: the arm is
 * optional, so a caller comparing by hand can silently test nothing.
 */
export function updatePartialReason(result: ResourceUpdateResult | undefined): string | undefined {
  if (!result || result.outcome !== 'partial') return undefined;
  // Branch on `outcome`, then DEFAULT the reason — never return `undefined`
  // for a value that said `'partial'`. `reason` is required by the
  // discriminated union, so a missing one can only come from an untyped
  // producer (a hand-built test double, a future arm that forgets it). The
  // caller's contract is "a reason string whenever the update was partial",
  // and handing back `undefined` there would silently restore the pre-#1819
  // behavior at exactly the site that exists to end it.
  // `typeof`, not `?.trim()`: the producers this default exists for are
  // untyped, and a non-STRING reason (`42`, an object) makes `.trim` itself
  // `undefined` -- a TypeError thrown out of the update path, i.e. a crash
  // introduced by the very guard meant to harden it. Trimmed on return too, so
  // a padded reason cannot break the status line or land verbatim in the
  // durable event store. Same three rules as `deleteSkipReason`.
  if (typeof result.reason !== 'string') return UNSPECIFIED_PARTIAL_REASON;
  const trimmed = result.reason.trim();
  return trimmed === '' ? UNSPECIFIED_PARTIAL_REASON : trimmed;
}

/**
 * The one-line status suffix for a partial update, matching the destroy path's
 * `skipped (<reason>)` shape so the two verbs read the same way.
 *
 * Deliberately NOT the word `skipped`: the row's own resource WAS updated, and
 * `RESOURCE_SKIPPED`'s documented invariant is "the resource this row names was
 * not destroyed". Calling the row skipped would be false and would put the
 * event store at odds with its own contract.
 */
/**
 * Stand-in for a `'partial'` outcome whose producer supplied no usable reason.
 *
 * Says the cause is unknown rather than inventing one: the row still has to
 * announce that something survived, and a confident-sounding wrong cause is
 * worse than an admitted gap.
 */
export const UNSPECIFIED_PARTIAL_REASON = 'provider reported a partial update without a reason';

export function updatePartialMessage(reason: string): string {
  return `partial (${reason})`;
}
