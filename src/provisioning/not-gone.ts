/**
 * Declare that a delete failure is NOT proof the resource is gone
 * (go-to-k/cdkd#5228).
 *
 * The deploy and destroy "already deleted" classifiers
 * (`deploy-engine/delete.ts`, `deploy-engine/update-in-place.ts`,
 * `destroy-runner.ts`) read gone-ness from the error MESSAGE by substring
 * (`not found`, `NotFound`, `does not exist`, ...), and a true read DROPS the
 * state record (or, on the replacement arm, creates the replacement beside
 * the old resource). A provider that has already decided by a TYPED signal
 * that the failure is not its resource's not-found (another object's
 * `*NotFound` class, a needle the logical id spells) marks the error with
 * this, and every classifier refuses the gone-read on it.
 *
 * Retryability is a SEPARATE fact: this mark leaves it to the retry
 * classifiers, so a throttle or a propagation race that carries a needle
 * keeps its retries and, once they run out, is still not read as gone. Use
 * `markNonRetryable` only when the failure is ALSO a cdkd-authored terminal
 * refusal.
 *
 * Stamped non-enumerable and read-only like `markDeleteStarted`, so it never
 * serializes and survives `maskSecretsInError`'s descriptor-copying clone. A
 * primitive or non-extensible throw is returned unmarked. Returns `error`.
 *
 * A LEAF: no imports, so any provider can use it without an edge into
 * `src/deployment/**`.
 */

const NOT_GONE = Symbol.for('cdkd.notGone');

/** Bounded, as `delete-started.ts`'s walk is. */
const MAX_DEPTH = 10;

/** Mark `error` as a delete failure that does not show the resource gone. */
export function markNotGone<E>(error: E): E {
  try {
    if (typeof error !== 'object' || error === null || !Object.isExtensible(error)) return error;
    Object.defineProperty(error, NOT_GONE, {
      value: true,
      enumerable: false,
      writable: false,
      configurable: true,
    });
  } catch {
    // Unmarkable: left as it is.
  }
  return error;
}

/** Whether any link of `error`'s bounded cause chain carries the mark. Never throws. */
export function isMarkedNotGone(error: unknown): boolean {
  try {
    let current: unknown = error;
    for (
      let depth = 0;
      depth < MAX_DEPTH && typeof current === 'object' && current !== null;
      depth++
    ) {
      if (Object.prototype.hasOwnProperty.call(current, NOT_GONE)) return true;
      current = (current as { cause?: unknown }).cause;
    }
  } catch {
    // Unreadable chain: no mark.
  }
  return false;
}
