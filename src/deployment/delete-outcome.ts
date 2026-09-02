import type { IndeterminateGuard, ResourceDeleteResult } from '../types/resource.js';

/**
 * Shared helpers over {@link ResourceDeleteResult} — originally the deploy-side
 * consumption of it (issue
 * [#1762](https://github.com/go-to-k/cdkd/issues/1762)), the twin of what
 * `src/cli/commands/destroy-runner.ts` does for `cdkd destroy`, and since issue
 * [#2301](https://github.com/go-to-k/cdkd/issues/2301) also the PRODUCER-side
 * `indeterminateGuards` constructor. Write and read live in one file on
 * purpose: the field's whole job is to survive a hop from a provider to a
 * recorder, and a sanitizer that does not sit beside its constructor is how
 * the two drift.
 *
 * Issue [#1752](https://github.com/go-to-k/cdkd/issues/1752) gave
 * `ResourceProvider.delete` an optional return value whose `'skipped'` arm
 * means **the resource this result names was NOT destroyed and may still be
 * ALIVE**, and taught the destroy runner to report it. Every OTHER
 * `provider.delete(...)` call site — the deploy engine's template-DELETE
 * branch, its four replacement / recreate delete sites, and the five
 * `rollback-executor.ts` delete arms — discarded the value, so the same skip
 * printed as `deleted`, counted as `deleted`, and dropped the state record.
 *
 * **The module must stay a LEAF — no imports beyond the type, ever.** Same
 * reason as `src/provisioning/nested-stack-messages.ts`: both the deploy
 * engine and the rollback executor consume it, and those two already sit on a
 * dense import ring (engine -> executor -> provider registry -> every
 * provider). A helper that pulled anything else in would close it.
 */

/**
 * The `reason` of a `'skipped'` delete outcome, or `undefined` when the
 * provider reported a delete (`{ outcome: 'deleted' }` or the back-compat
 * `void` return ~80 providers still use).
 *
 * A function rather than an inline `result?.outcome === 'skipped'` test at
 * ten call sites so the back-compat `void` reading lives in ONE place: the
 * signature is `Promise<void | ResourceDeleteResult>`, so a caller that awaits
 * it holds `void | ResourceDeleteResult`, which TypeScript will happily let
 * you compare against nothing useful.
 */
export function deleteSkipReason(result: void | ResourceDeleteResult): string | undefined {
  if (!result || result.outcome !== 'skipped') return undefined;
  // Branch on `outcome`, then DEFAULT the reason — never return `undefined`
  // for a value that said `'skipped'`. `reason` is required by the
  // discriminated union, so a missing one can only come from an untyped
  // producer (a JS provider, a hand-built test double, a future arm that
  // forgets it) — and returning `undefined` there would send every caller
  // down the DELETED path, which for the template-DELETE branch means
  // dropping the state record of a resource that is still alive. That is
  // precisely the data loss this module exists to stop, so the one shape it
  // must never mistake is a skip that under-describes itself.
  // `typeof`, not `?.trim()`: the producers this default exists for are
  // untyped, and a non-STRING reason (`42`, an object) makes `.trim` itself
  // `undefined` — a TypeError thrown out of the delete path, i.e. a crash
  // introduced by the very guard meant to harden it. Trimmed on return too,
  // so a padded reason cannot break the status line or land verbatim in the
  // durable event store.
  if (typeof result.reason !== 'string') return UNSPECIFIED_SKIP_REASON;
  const trimmed = result.reason.trim();
  return trimmed === '' ? UNSPECIFIED_SKIP_REASON : trimmed;
}

/**
 * Stand-in for a `'skipped'` outcome whose producer supplied no `reason`.
 *
 * Deliberately says the cause is unknown rather than inventing one: the line
 * it renders on is the user's only signal that the resource survived, and a
 * fabricated cause would send them looking in the wrong place.
 */
export const UNSPECIFIED_SKIP_REASON = 'no reason reported by the provider';

/**
 * The sentence every deploy-side skip renders, in the log line AND in the
 * `Error` the sites that must FAIL the resource throw.
 *
 * Wording rules, both load-bearing:
 *
 * 1. It says the resource was NOT deleted and MAY STILL EXIST. A skip issued
 *    no AWS call at every producer but `NestedStackProvider.delete`, so the
 *    old resource is presumed alive — which is the whole reason a replacement
 *    site cannot proceed to create its replacement beside it.
 * 2. It must NOT contain any phrase the callers' already-deleted classifiers
 *    substring-match (`does not exist` / `was not found` / `not found` /
 *    `No policy found` / `NoSuchEntity` / `NotFoundException` /
 *    `ResourceNotFoundException`). Reading a skip as "already gone" is exactly
 *    the mis-accounting this change exists to remove, and the deploy engine's
 *    DELETE branch and its update-not-supported fallback each carry such a
 *    classifier. The call sites additionally handle the skip OUTSIDE their
 *    `catch`, so a future `reason` carrying one of those phrases still cannot
 *    reach a classifier — belt and braces, because `reason` is provider text.
 */
export function deleteSkippedMessage(
  logicalId: string,
  physicalId: string,
  reason: string,
  duringClause: string
): string {
  return (
    `cdkd could not address ${logicalId} (${physicalId}) ${duringClause}, so it was NOT ` +
    `deleted and may still exist: ${reason}`
  );
}

/**
 * Attach an {@link IndeterminateGuard} to whatever a delete arm was about to
 * return (issue [#2301](https://github.com/go-to-k/cdkd/issues/2301)).
 *
 * `undefined` in, `undefined` out when there is no guard to carry — so a
 * provider whose guard reached a verdict keeps returning the back-compat
 * `void` the ~80 providers that return it use, and nothing about the
 * existing shape changes on the hot path.
 *
 * A `'skipped'` result keeps its outcome and its `reason`: a guard that could
 * not answer and a delete that could not be addressed are independent facts,
 * and collapsing either into the other loses one of them.
 */
export function withIndeterminateGuard(
  result: void | ResourceDeleteResult,
  guard: IndeterminateGuard | undefined
): void | ResourceDeleteResult {
  if (!guard) return result;
  // `Array.isArray`, not `?? []`: the spread on the next line THROWS on a
  // non-iterable, so an untyped producer that set `indeterminateGuards` to a
  // number would crash the delete path from inside the hardening. The reader
  // below is defensive about exactly this population; the writer has to be
  // too, and a non-array here is not recoverable data — it is dropped.
  const existing = Array.isArray(result?.indeterminateGuards) ? result.indeterminateGuards : [];
  const indeterminateGuards = [...existing, guard];
  if (result && result.outcome === 'skipped') {
    return { outcome: 'skipped', reason: result.reason, indeterminateGuards };
  }
  return { outcome: 'deleted', indeterminateGuards };
}

/**
 * The guards a delete result reports as INDETERMINATE — those that ran, could
 * not reach a verdict, and were therefore not enforced while cdkd proceeded
 * (issue [#2301](https://github.com/go-to-k/cdkd/issues/2301)). Empty for the
 * overwhelmingly common case, including the back-compat `void` return.
 *
 * Defensive in the same shape and for the same reason as
 * {@link deleteSkipReason}: the value crosses into a DURABLE record
 * (`deployments/*.jsonl`), providers are the least type-checked layer in the
 * repo (a hand-built test double, a future arm, a JS provider), and a
 * malformed entry must degrade to "not reported" rather than crash the delete
 * path or persist `guard: undefined`. `typeof` rather than `?.trim()` for the
 * same reason `deleteSkipReason` uses it — a non-string makes `.trim` itself
 * `undefined`, i.e. a TypeError thrown out of the very path this hardens.
 *
 * Entries whose `guard` or `reason` is missing / non-string / blank are
 * DROPPED rather than defaulted, which is the opposite of `deleteSkipReason`'s
 * choice and deliberately so: there a default is the user's only signal that a
 * live resource survived, so inventing `UNSPECIFIED_SKIP_REASON` beats
 * silence. Here a guard row with no guard id and no cause says only "something
 * somewhere was not checked", which cannot be acted on — and it would count
 * toward the destroy summary's tally, turning an unactionable row into a
 * number the operator has to chase.
 */
export function deleteIndeterminateGuards(
  result: void | ResourceDeleteResult
): readonly IndeterminateGuard[] {
  const raw = result?.indeterminateGuards;
  if (!Array.isArray(raw)) return [];
  const out: IndeterminateGuard[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const { guard, reason } = entry as { guard?: unknown; reason?: unknown };
    if (typeof guard !== 'string' || typeof reason !== 'string') continue;
    const trimmedGuard = guard.trim();
    const trimmedReason = reason.trim();
    if (trimmedGuard === '' || trimmedReason === '') continue;
    out.push({ guard: trimmedGuard, reason: trimmedReason });
  }
  return out;
}
