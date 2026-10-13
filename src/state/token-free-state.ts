/**
 * The TOKEN-FREE fast path of state schema v12 (go-to-k/cdkd#4847 /
 * go-to-k/cdkd#4852).
 *
 * A stack is token-free when its state body holds no `{{resolve:` token and no
 * provenance field. Every v12 pass that walks records for a token (the one-time
 * migration capture, and later the readers) asks {@link isKnownTokenFreeState}
 * first, so an ordinary stack pays one substring test over the body the
 * backend already holds, with no extra parse and no walk.
 *
 * The answer is attached to the parsed {@link StackState} object by identity.
 * An UNMARKED state (built in memory, a legacy-key read, a test double) reads
 * as "may carry tokens", so a missed mark costs work, never a skipped record.
 */
const tokenFreeStates = new WeakSet<object>();

/** Does `body` (a raw `state.json`) possibly carry a token or a provenance field? O(bytes). */
export function bodyMayCarryReferences(body: string): boolean {
  return (
    body.includes('{{resolve:') ||
    body.includes('"referenceProvenance"') ||
    body.includes('"outputReferenceProvenance"')
  );
}

/** Mark `state` as parsed from a body {@link bodyMayCarryReferences} rejected. */
export function markTokenFreeState(state: object): void {
  tokenFreeStates.add(state);
}

/** Was `state` parsed from a body holding no token and no provenance field? */
export function isKnownTokenFreeState(state: object | undefined): boolean {
  return state !== undefined && tokenFreeStates.has(state);
}
