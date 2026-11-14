import { SECRET_MASK, type RecordedSecretValues } from '../pairs.js';
import {
  type PathSourceRules,
  isDynamicReferenceString,
  isPlainObject,
  isSingleDynamicReferenceToken,
} from '../rules.js';
import { hasPlainPrototype } from './json-equality.js';

/**
 * Is `bag` the TEMPLATE's own plain literal, byte for byte (go-to-k/cdkd#6303)?
 *
 * Such a leaf took nothing from a resolution: the resolver returns a literal
 * string as it is, so no secret was substituted into it. A recorded plaintext
 * found inside it is a COINCIDENCE — the generated username `postgres` inside
 * `Engine: aurora-postgresql` — and the value scan rewrote it into
 * `aurora-{{resolve:...}}ql`, which the next deploy read as a create-only
 * change and planned to REPLACE the cluster. Keeping it discloses nothing: the
 * text is in the synthesized template.
 *
 * Two refusals keep the scan where it still protects something:
 *
 * - **A STATE source** ({@link PathSourceRules.sourceIsTemplate} unset). Its
 *   plain leaf may be a plaintext an older cdkd persisted, which the scan
 *   repairs in the copy it writes (the derived-needle arm's pinned shapes).
 * - **A leaf EQUAL to a recorded plaintext.** The whole-value arm re-spells it
 *   as before, so a record a STATE walk keeps healing and this walk agree,
 *   rather than trading the two spellings run after run.
 *
 * `!isDynamicReferenceString(source)` cannot be reached false today: a source
 * holding `{{resolve:` takes `redactByPath`'s reference arms first. It stays as
 * the stated precondition, an equivalent mutant at the one call site. The
 * containment post-pass (`flattenEmbeddedNoEchoLeaves`) still runs over the
 * result, so a literal containing a fresh `NoEcho` value is masked whole.
 */
export function isSourcePlainLiteral(
  bag: unknown,
  source: unknown,
  secrets: RecordedSecretValues,
  rules: PathSourceRules
): bag is string {
  return (
    rules.sourceIsTemplate === true &&
    typeof bag === 'string' &&
    bag === source &&
    !isDynamicReferenceString(source) &&
    !secrets.has(bag)
  );
}

/**
 * `[expression, plaintext]` for every recorded secret whose expression is a
 * WHOLE `{{resolve:...}}` token: the pairs that turn a leaf the pre-#6303 value
 * scan rewrote back into the text it was written for. A mask-only entry has no
 * expression and is left out, so a leaf holding `***` is never "repaired" (the
 * `SECRET_MASK` test is implied by the token test; it states the reason).
 */
export function secretRerenderPairs(
  secrets: RecordedSecretValues
): Array<readonly [string, string]> {
  const pairs: Array<readonly [string, string]> = [];
  for (const [plaintext, expression] of secrets) {
    if (plaintext === '' || expression === SECRET_MASK) continue;
    if (!isSingleDynamicReferenceToken(expression)) continue;
    pairs.push([expression, plaintext]);
  }
  return pairs;
}

/**
 * The source's plain literal, when `bag` is what the pre-go-to-k/cdkd#6303
 * value scan persisted for it: `bag` embeds a reference the plain `source`
 * does not, and spelling each secret expression back as its plaintext gives
 * `source` exactly. `undefined` on anything else.
 *
 * Returning the source adds no plaintext: a TEMPLATE source's literal is public
 * text, and a STATE source's (scrub's observed walk) is text the same record
 * already holds at this position. The equality is the proof that the reference was the
 * whole difference, so a literal the template has since EDITED (`aurora-mysql`)
 * is left to the walk. It proves the spelling, not the deployed GENERATION: a
 * secret rotated since that deploy, with the template now hard-coding the NEW
 * value, also renders equal — and a pre-fix walk answered that case with no
 * send as well. A literal EQUAL to a recorded plaintext is refused, as
 * {@link isSourcePlainLiteral} refuses it.
 */
export function rerenderedSourceLiteral(
  bag: unknown,
  source: unknown,
  secrets: RecordedSecretValues
): string | undefined {
  if (typeof bag !== 'string' || typeof source !== 'string') return undefined;
  if (!isDynamicReferenceString(bag) || isDynamicReferenceString(source)) return undefined;
  if (secrets.has(source)) return undefined;
  let rendered = bag;
  for (const [expression, plaintext] of secretRerenderPairs(secrets)) {
    rendered = rendered.split(expression).join(plaintext);
  }
  return rendered === source ? source : undefined;
}

/**
 * `redacted` with every leaf put back where the RAW leaf is the template's own
 * plain literal (go-to-k/cdkd#6303), for a walk whose source is not the
 * template: `cdkd scrub`'s `observedProperties` walk, sourced from the record
 * it repositioned. The same refusals as {@link isSourcePlainLiteral}: a leaf
 * equal to a recorded plaintext, and one the walk masked whole (a containment
 * needle inside it), stay as redacted. The `{{resolve:` test is an equivalent
 * mutant (a template leaf holding one is answered by the reference arms) kept
 * as the stated precondition. Positions pair by key, and by index for an array of equal length;
 * a mismatch keeps the redacted leaf. Returns `redacted` by identity when
 * nothing is kept, and never writes into an input.
 */
export function keepTemplateLiteralLeaves(
  redacted: unknown,
  raw: unknown,
  template: unknown,
  secrets: RecordedSecretValues
): unknown {
  if (typeof raw === 'string') {
    return raw === template &&
      !isDynamicReferenceString(raw) &&
      !secrets.has(raw) &&
      redacted !== SECRET_MASK
      ? raw
      : redacted;
  }
  if (Array.isArray(raw)) {
    if (!Array.isArray(template) || !Array.isArray(redacted)) return redacted;
    if (redacted.length !== raw.length || template.length !== raw.length) return redacted;
    let out: unknown[] | undefined;
    for (let i = 0; i < redacted.length; i++) {
      const kept = keepTemplateLiteralLeaves(redacted[i], raw[i], template[i], secrets);
      if (kept !== redacted[i]) (out ??= [...redacted])[i] = kept;
    }
    return out ?? redacted;
  }
  if (!isPlainRecord(raw) || !isPlainRecord(template) || !isPlainRecord(redacted)) {
    return redacted;
  }
  let out: Record<string, unknown> | undefined;
  for (const key of Object.keys(redacted)) {
    if (!Object.hasOwn(raw, key) || !Object.hasOwn(template, key)) continue;
    const kept = keepTemplateLiteralLeaves(redacted[key], raw[key], template[key], secrets);
    if (kept === redacted[key]) continue;
    // A spread copies an own `__proto__` key as DATA.
    out ??= { ...redacted };
    out[key] = kept;
  }
  return out ?? redacted;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return isPlainObject(value) && hasPlainPrototype(value);
}
