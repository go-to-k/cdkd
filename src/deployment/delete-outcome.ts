import type { IndeterminateGuard, ResourceDeleteResult } from '../types/resource.js';
import { ROLE_ARN_MAX_CODE_POINTS, displayIdent } from '../utils/display-safe.js';
import { physicalIdShownBesideCommand, plainOrDescribed } from '../utils/pasteable-command.js';

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
 * rollback-executor delete arms — discarded the value, so the same skip
 * printed as `deleted`, counted as `deleted`, and dropped the state record.
 *
 * **The module must stay a LEAF — no imports beyond the types and
 * `src/utils/` leaves, ever.** Same reason as
 * `src/provisioning/nested-stack-messages.ts`: both the deploy
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
 * The `leftInPlace` line of a delete that addressed its resource but left part
 * of it (go-to-k/cdkd#4612), or `undefined`.
 */
export function deleteLeftInPlace(result: void | ResourceDeleteResult): string | undefined {
  if (result === undefined || result.outcome !== 'deleted') return undefined;
  const left = result.leftInPlace;
  return typeof left === 'string' && left.length > 0 ? left : undefined;
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
 * 1. It says cdkd did NOT CONFIRM the delete and the resource MAY STILL
 *    EXIST — and nothing about WHY. The producers differ in whether an AWS
 *    call went out: most could not ADDRESS the resource and issued none
 *    (issue #1752), but a custom-resource Delete handler that ran and
 *    reported FAILED (issue #2054) or whose invoke did not complete, and
 *    `NestedStackProvider.delete`, did issue one (go-to-k/cdkd#2122). The
 *    cause is `reason`'s job; the sentence claims only what holds for every
 *    producer. The old resource is presumed alive either way — which is the
 *    whole reason a replacement site cannot proceed to create its
 *    replacement beside it.
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
  duringClause: string,
  /**
   * `commandFreeLine: true` for a caller whose line carries NO command or
   * flag, where the physical id may be the only trace of a leaked resource:
   * the id is then always shown, bounded by `displayIdent` (JSON-quoted when
   * not plain) instead of described. Outside the S1 rule, which concerns a
   * value beside a command (go-to-k/cdkd#4265).
   */
  opts?: { commandFreeLine?: boolean }
): string {
  // The three values are state- or provider-sourced, and callers log this
  // beside `formatResourceLine`'s folded status line, so none may start a line
  // of the destroy or deploy output (go-to-k/cdkd#3773). `duringClause` is a
  // caller literal, and several callers name a flag in it (`--replace`,
  // `--revert-failed`) or append a `cdkd` command after it. So each value is
  // SHOWN only when it is plain, and described otherwise — the same rule for
  // every caller, decided here (go-to-k/cdkd#4265, go-to-k/cdkd#3950's S1
  // rule). None of the descriptions holds a newline, so #3773 still holds.
  // No pointer for a described physical id: where the id can still be read
  // differs per caller (the state record, the rollback journal). The one
  // caller with neither puts no command on its line and passes
  // `commandFreeLine`, so its id is shown.
  return (
    `cdkd did not confirm ${plainOrDescribed(logicalId, 'logical id')} ` +
    `(${
      opts?.commandFreeLine === true
        ? displayIdent(physicalId, { maxCodePoints: ROLE_ARN_MAX_CODE_POINTS })
        : skipPhysicalIdShown(physicalId)
    }) was ` +
    `deleted ${duringClause}, so it may still exist: ${skipReasonShown(reason)}`
  );
}

/**
 * A physical id as {@link deleteSkippedMessage} shows it: itself when
 * `displayIdent` is the identity on it at the role-ARN cap (an ARN, a URL or a
 * bare name the operator needs to find the resource), it stays inert with its
 * quotes stripped (`isInertUnquoted`, the repo's one spelling of the shell
 * rule, which also refuses a `~` after `=` or `:`), and it does not start with
 * `-`; a description otherwise.
 */
function skipPhysicalIdShown(physicalId: string): string {
  // The repo's one rule, shared with the rollback refusals (no mask arm: the
  // callers mask the whole sentence afterwards).
  return physicalIdShownBesideCommand(physicalId) ?? 'a physical id that is not a plain identifier';
}

/**
 * The characters a skip reason may hold to be shown: letters, digits, a space
 * and the prose punctuation `. , : / _ - — –`, plus a plural `(s)` straight
 * after a letter (`2 resource(s)`) and a MEDIAL `~` (a nested stack's
 * `Parent~Child` name; only a leading `~` expands). None of them substitutes,
 * separates a command, redirects, quotes, globs or expands. An ALLOW-list, as
 * `isPasteableIdent` is, because the set of shell-active characters nobody
 * thought of is unbounded.
 *
 * What it does NOT promise: a selection can still START inside the reason, at
 * a `. `, `: ` or ` — ` it holds, and then the next word is the command that
 * runs. So the reason's WORDS must be cdkd's own: every producer passes a
 * state-sourced fragment through `plainOrDescribed` before putting it in a
 * `'skipped'` reason (the nested-stack provider's child name), never
 * `displaySafe` alone (security review of #4297). Only `'skipped'` outcomes
 * reach this sentence (`deleteSkipReason` selects them); a provider's
 * `'partial'` `orphanReason`, which can embed a physical id raw, is rendered
 * elsewhere and is not held to this rule.
 */
const PLAIN_SKIP_REASON =
  /^(?:[\p{L}\p{N} .,:/_\u2013\u2014-]|(?<=\p{L})\(s\)|(?<=[\p{L}\p{N}])~(?=[\p{L}\p{N}]))+$/u;

/**
 * A skip reason as {@link deleteSkippedMessage} shows it: itself when it is
 * plain prose ({@link PLAIN_SKIP_REASON}), a description otherwise. cdkd's own
 * reasons are all plain; one that embeds a state value carrying anything else
 * (a nested stack name, a physical id) is described.
 */
function skipReasonShown(reason: string): string {
  return PLAIN_SKIP_REASON.test(reason) ? reason : 'a reason that cannot be shown safely here';
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
 * not answer and a delete cdkd could not confirm are independent facts,
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
  // SPREAD, not a field-by-field rebuild. Naming `outcome` and `reason`
  // explicitly would silently drop any field a later revision adds to either
  // arm -- the same hazard the no-guard early return above avoids by returning
  // `result` itself by identity. The spread keeps the two paths consistent:
  // whatever the delegate reported survives, and only `indeterminateGuards` is
  // overwritten.
  if (result && result.outcome === 'skipped') {
    return { ...result, indeterminateGuards };
  }
  // `result` is `void` or the `'deleted'` arm here. Spreading it covers the
  // arm's future fields; the literal `outcome` after it is what turns the
  // back-compat `void` return into an explicit `'deleted'`, which is the whole
  // reason this branch exists.
  return { ...(result ?? {}), outcome: 'deleted', indeterminateGuards };
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
