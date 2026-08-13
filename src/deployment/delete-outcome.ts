import type { ResourceDeleteResult } from '../types/resource.js';

/**
 * Deploy-side consumption of {@link ResourceDeleteResult} (issue
 * [#1762](https://github.com/go-to-k/cdkd/issues/1762)) — the twin of what
 * `src/cli/commands/destroy-runner.ts` does for `cdkd destroy`.
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
 * eleven call sites so the back-compat `void` reading lives in ONE place: the
 * signature is `Promise<void | ResourceDeleteResult>`, so a caller that awaits
 * it holds `void | ResourceDeleteResult`, which TypeScript will happily let
 * you compare against nothing useful.
 */
export function deleteSkipReason(result: void | ResourceDeleteResult): string | undefined {
  return result && result.outcome === 'skipped' ? result.reason : undefined;
}

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
