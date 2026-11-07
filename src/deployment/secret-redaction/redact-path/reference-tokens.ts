import { type RecordedSecretValues } from '../pairs.js';
import { DYNAMIC_REFERENCE_INNER } from '../rules.js';
import { isRecordedSecretExpression, provenPublicValue } from '../mask-only.js';

/**
 * Every complete `{{resolve:...}}` token inside a string.
 *
 * This was a FOURTH spelling of the token pattern (`[^{}]*`, global) and is
 * built from {@link DYNAMIC_REFERENCE_INNER} since issue #1936, so it agrees
 * with the resolver like every other predicate here.
 *
 * EXPORTED, and `drift.ts`'s `survivingDynamicReferences` calls it rather than
 * re-spelling the scan (issue #2088 review). The character CLASS was shared
 * from #1936, but the assembled PATTERN was still byte-duplicated in the two
 * files — which is how a later flag or anchor change re-forks exactly the way
 * the four spellings did.
 *
 * The pattern is a module-level constant. An earlier revision built a fresh
 * `RegExp` per call, justified as "a shared global instance carries
 * `lastIndex` between callers" — that is FALSE for this use and was measured:
 * `String.prototype.match` with a `/g` pattern sets `lastIndex` to 0 on entry
 * and leaves it 0, so no state crosses callers. The per-call construction was
 * compiling a pattern per string leaf at the persist choke point, which walks
 * every record. Do NOT call `.exec` / `.test` on this constant — those DO
 * advance `lastIndex`, which is exactly why the shared instance is safe only
 * for `.match`. (ONE site does, `resolvableReferenceSpans`, and it resets
 * `lastIndex` to 0 in the statement after the `exec`.)
 *
 * Widening it changes one answer, in the SAFE direction for BOTH readers.
 *
 * `drift.ts`'s `survivingDynamicReferences` is the reader that is easy to
 * forget, because it lives in another file — it feeds the survivor REPORT
 * (`onUnresolved`, and through it the `unresolvedToken` cause), so seeing MORE
 * tokens can only report more, never less. Do not shorten this to "the only
 * reader": that sentence is what a later editor uses to bound the blast
 * radius of touching the class, and getting it wrong points them away from
 * the report / `--json` / `--accept` path where an unreported survivor would
 * surface.
 *
 * The other reader is the DECLARED direction for issue #1901:
 * {@link mixedLeafMayCarryPublicReference}, which asks whether a MIXED leaf
 * embeds a `{{resolve:ssm:` token the verdict store does not know. A token
 * carrying a `{` inside it used to be INVISIBLE here, so such a leaf was
 * always treated as secret-bearing and the source expression was substituted
 * over the resolved value. Now it is seen and classified by the same rule as
 * every other token — which, on a POPULATED map, means a genuinely public ssm
 * parameter keeps the resolved value it is supposed to keep.
 */
export const DYNAMIC_REFERENCE_TOKEN_SCAN = new RegExp(
  `\\{\\{resolve:${DYNAMIC_REFERENCE_INNER}\\}\\}`,
  'g'
);

export function dynamicReferenceTokens(value: string): string[] {
  return value.match(DYNAMIC_REFERENCE_TOKEN_SCAN) ?? [];
}

/**
 * Where each complete `{{resolve:...}}` token sits in the string, as
 * `[start, end)` offsets. The OFFSETS are what {@link dynamicReferenceTokens}
 * cannot give, and the value scan needs them to decide whether a needle match
 * lies inside a reference or merely beside one.
 *
 * `lastIndex` is reset before `matchAll`, and that is load-bearing rather than
 * defensive. `String.prototype.matchAll` does not MUTATE the pattern's
 * `lastIndex` — it clones — but it SEEDS the clone from it, so a caller that
 * left the shared constant dirty (the constant's own doc forbids `.exec` /
 * `.test` on it for exactly this reason) would make this function skip every
 * span before that offset, silently restoring the splice this offsets are used
 * to prevent. Measured, not assumed.
 */
export function dynamicReferenceSpans(value: string): Array<{ start: number; end: number }> {
  DYNAMIC_REFERENCE_TOKEN_SCAN.lastIndex = 0;
  const spans: Array<{ start: number; end: number }> = [];
  for (const match of value.matchAll(DYNAMIC_REFERENCE_TOKEN_SCAN)) {
    spans.push({ start: match.index, end: match.index + match[0].length });
  }
  return spans;
}

/**
 * Does this MIXED leaf embed a reference that may be PUBLIC config?
 *
 * A plain `{{resolve:ssm:...}}` is classified by the parameter's TYPE, not by
 * its spelling (issue #1901): a `String` / `StringList` parameter is public and
 * is legitimately persisted RESOLVED. Substituting the expression over it gives
 * the drift baseline a value AWS does not hold, which is phantom drift on
 * ordinary config — and `--revert` then pushes the literal expression.
 *
 * `trustAnyExpression` is what would otherwise wave this through, and its
 * premise ("a persisted STATE bag holds no public expression") is documented as
 * FALSE in one place: `cdkd import`'s warn path can leave one there. The
 * whole-token arm accepts that risk knowingly and `cdkd drift --accept`
 * re-checks its write; the MIXED arm added later has no such re-check, so it
 * declines instead.
 *
 * A reference the resolver RECORDED as secret is kept: that is the ssm
 * `SecureString` case, where the verdict came off the same `GetParameter`
 * response that carried the value. `{{resolve:ssm-secure:` does not match this
 * prefix at all (the next character is `-`), so it is never refused here.
 *
 * The verdict store only carries signal where something RESOLVED, so this
 * splits on whether a secrets map exists at all.
 *
 * WITH a map, a pass resolved this bag: the engine's change detection walks
 * every template property with `skipDynamicReferences`, which only flips
 * `decrypt` on the ssm branch — the `GetParameter` still runs, a definitive
 * `SecureString` is recorded, and a parameter that comes back public has its
 * memo RETRACTED. Absence from the store is then real evidence of a public
 * parameter, and the resolved value is kept.
 *
 * WITHOUT one, absence means only that the question was never asked HERE, so
 * the leaf is treated as secret-bearing and refused unless the BAG carries a
 * POSITIVE proof for every token in it (issue
 * [#2036](https://github.com/go-to-k/cdkd/issues/2036), see
 * {@link mixedLeafProvenPublic}). Refusal is the default because of the SAME
 * premise the whole-token arm one level up acts on: a PUBLIC `String` /
 * `StringList` reference is persisted RESOLVED (issue #1901), so a
 * `{{resolve:ssm:` token that SURVIVES in a persisted state bag is a
 * SecureString by construction unless something proves otherwise. An earlier
 * revision applied a stricter rule to a MIXED leaf than to a whole token on the
 * identical source, and that inconsistency is what persisted a decrypted
 * secret.
 *
 * The proof is per BAG, never per bare expression. PR #2415 drafted a
 * process-wide store of PROVEN-public verdicts and WITHDREW it: on a `cdkd
 * deploy --all` spanning regions a verdict recorded where the parameter is a
 * plain `String` un-redacted a SecureString of the same name in another region.
 * A bag's proofs are written only by lookups made for that bag's own record —
 * `cdkd drift`'s resolver pass over the record (region-routed by
 * `classifyReplaySecretRegion`), or `PublicSsmProver.proofBagFor` on `cdkd
 * state refresh-observed`, which asks `GetParameter` without decryption in the
 * record's own region. Both serve LEGACY records only: a current `cdkd import`
 * refuses (`observedBaselineRefused`, #2944) the baseline of the warn-path
 * record that carries a public expression, and every one of these commands
 * skips a refused record. A proof admits a leaf only when the
 * readback equals the source with each token replaced by the PROVEN value, so a
 * type read today cannot vouch for a value resolved at an earlier deploy or in
 * another region. The deploy path's UNCHANGED-resource
 * persist hands this call a fresh map with no proofs, so it still refuses
 * there; a properties-borne public expression makes that resource read as
 * CHANGED anyway (issue #2425), which is why that site was left alone.
 *
 * Refusing is still the right way to be wrong wherever no proof exists:
 * under-redaction persists a decrypted secret, a disclosure and the thing this
 * lane exists to prevent, while over-redaction is visible, recoverable and
 * discloses nothing.
 *
 * `tests/integration/secrets-dynamic-ref` is the end-to-end proof, and it is
 * the only place the empty-map defect surfaced — every unit assertion passed.
 * A public mixed leaf reaches this predicate only when the position source
 * CARRIES its expression, which a deploy never leaves behind (issue #1901), so
 * its phases STAMP that LEGACY shape (a pre-#2944 import warn-path record):
 * Phase 1f3 on `cdkd state refresh-observed`, where the public leaf keeps its
 * resolved value and the SecureString mixed leaf beside it is still refused,
 * and Phase 1f4 on `cdkd drift --accept`, which records a public leaf whose
 * value matches its proof and refuses one AWS holds a different value for.
 */
export function mixedLeafMayCarryPublicReference(
  source: string,
  secrets: RecordedSecretValues,
  readback: string
): boolean {
  // NO MAP: ABSENCE IS NOT EVIDENCE, so only a POSITIVE proof answers here.
  // `isRecordedSecretExpression` only ever says "yes" about a token some pass
  // RESOLVED, and the empty-map paths resolve nothing by construction (issue
  // #1926's own design decision). Reading absence as "public" there turned
  // every `{{resolve:ssm:` mixed leaf into a public one and persisted the
  // DECRYPTED SecureString — measured by the `secrets-dynamic-ref` integ, which
  // is the only place it showed: every unit assertion passed.
  if (secrets.size === 0) return mixedLeafProvenPublic(source, secrets, readback);
  return dynamicReferenceTokens(source).some(
    (token) => token.startsWith('{{resolve:ssm:') && !isRecordedSecretExpression(token)
  );
}

/**
 * The EMPTY-map answer (issue
 * [#2036](https://github.com/go-to-k/cdkd/issues/2036)): keep the readback
 * only when EVERY reference in the leaf is a plain `ssm` token this bag holds a
 * PROOF for ({@link provenPublicValue}), AND the readback is EXACTLY the source
 * with each token replaced by its proven public value.
 *
 * EVERY, not the populated arm's SOME: with no map the value scan has no needle
 * for a secret sitting beside the public token, so one unproven,
 * `secretsmanager`, `ssm-secure` or unknown-service token keeps the whole leaf
 * refused.
 *
 * EQUALITY, not the type alone: the type is read NOW and the readback holds what
 * the last deploy resolved, so a parameter retyped since (or a public namesake
 * in the wrong region) would otherwise vouch for a secret's plaintext. Equality
 * means every character of the leaf is either text the record's own source
 * spells or a value a public parameter holds today. A changed readback (a
 * console edit, a rotated value) therefore keeps the expression: over-redaction,
 * the direction this module may be wrong in.
 */
function mixedLeafProvenPublic(
  source: string,
  secrets: RecordedSecretValues,
  readback: string
): boolean {
  const tokens = dynamicReferenceTokens(source);
  if (tokens.length === 0) return false;
  const values = new Map<string, string>();
  for (const token of tokens) {
    if (!token.startsWith('{{resolve:ssm:')) return false;
    const value = provenPublicValue(secrets, token);
    if (value === undefined) return false;
    values.set(token, value);
  }
  DYNAMIC_REFERENCE_TOKEN_SCAN.lastIndex = 0;
  const expected = source.replace(DYNAMIC_REFERENCE_TOKEN_SCAN, (token) => values.get(token)!);
  return expected === readback;
}
