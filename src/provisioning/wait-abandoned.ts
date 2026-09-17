/**
 * The "cdkd stopped watching an operation that may still be running" marker
 * (issue [#3236](https://github.com/go-to-k/cdkd/issues/3236), widened by
 * [#3253](https://github.com/go-to-k/cdkd/issues/3253)).
 *
 * `CloudControlWaitAbandonedError` is raised in `cloud-control-provider.ts`,
 * but FIVE call sites have to refuse it, and three of them live in other
 * files. Four are GOVERNED by
 * `tests/unit/provisioning/wait-abandoned-guard-population.test.ts`:
 *
 *  - `cloud-control-provider.ts`'s own `delete()` catch,
 *  - `deploy-engine.ts`'s replacement delete-then-CREATE arm,
 *  - `deploy-engine.ts`'s template-removal delete arm,
 *  - `destroy-runner.ts`'s per-resource delete loop.
 *
 * The FIFTH is `cleanupFailedCreateRemnant`, and it is outside that population
 * by construction rather than by oversight: its partner classifier is the
 * REGEX helper `isNotFoundMessage`, which carries no literal needles, so no
 * needle-driven scan can find it. It has a behavioural case instead, and it
 * needs the guard for a sharper reason than the other four — that regex is
 * case-INSENSITIVE, so `getaddrinfo ENOTFOUND ...` matches `/not\s*found/i`.
 *
 * Each decides "the resource is already gone" by SUBSTRING-matching the error
 * message, and each then DROPS the state row. An abandoned wait says the
 * opposite — the delete may still be running — and its message interpolates
 * the LOGICAL ID and the last-seen IDENTIFIER, both user- or template-chosen,
 * so a resource named `PageNotFound` satisfies those needles. Round 1 of
 * go-to-k/cdkd#3249 guarded the first site with a local `instanceof` and left
 * the other three, which is what this module exists to fix: ONE predicate the
 * three foreign sites can import without importing the provider.
 *
 * **A marker rather than an exported class + `instanceof`**, for the reason
 * `markNonRetryable` is one: `deploy-engine.ts` reaches the provider only
 * through `ProviderRegistry`, so importing the class there would add an edge
 * into an already dense ring, and a marker survives a wrapper that copies a
 * message without preserving a prototype.
 *
 * **NOT `markNonRetryable`**, though the mechanism is identical: a DELETE or
 * UPDATE abandonment is deliberately left RETRYABLE so the destroy runner can
 * re-issue an idempotent delete, and only CREATE is marked. Reusing that
 * marker would either make the guards miss DELETE — the case that drops a
 * state row — or make a DELETE non-retryable and lose the recovery.
 *
 * A LEAF: no imports, ever. All four consumers sit on the deploy engine ->
 * rollback executor -> registry -> provider ring, and a new edge into it from
 * any of them would close a cycle.
 */

const WAIT_ABANDONED_MARKER = Symbol.for('cdkd.waitAbandoned');

/**
 * The `.cause` walk depth, the same bound `retryable-errors.ts` uses. cdkd
 * wraps errors, so the marked error is routinely one or two hops down.
 */
const MAX_CAUSE_CHAIN_DEPTH = 5;

/**
 * Stamp an error as an abandoned wait.
 *
 * `E extends Error`, not `object`: the reader below is a PROTOTYPE-CHAIN
 * lookup, so marking a class or a shared prototype would silently mark every
 * instance of it. A non-extensible (frozen / sealed) error is returned
 * UNMARKED rather than allowed to throw — callers use this inline, so a
 * `TypeError` raised here would REPLACE the error the caller meant to raise.
 * Both rules are `markNonRetryable`'s, for its reasons.
 */
export function markWaitAbandoned<E extends Error>(error: E): E {
  if (!Object.isExtensible(error)) return error;
  Object.defineProperty(error, WAIT_ABANDONED_MARKER, {
    value: true,
    enumerable: false,
    configurable: true,
    writable: false,
  });
  return error;
}

/**
 * True when the error, or anything in its bounded `.cause` chain, was marked
 * by {@link markWaitAbandoned}.
 *
 * Every already-deleted classifier must test this BEFORE its substring match,
 * and must treat a true answer as "not already deleted" — i.e. re-throw. The
 * ordering is the whole point: a message-first guard has already decided by
 * the time it would consult the marker.
 */
export function isWaitAbandonedError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_CHAIN_DEPTH && current != null; depth++) {
    if ((current as Record<symbol, unknown>)[WAIT_ABANDONED_MARKER] === true) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}
