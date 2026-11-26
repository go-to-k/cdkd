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
 * change and planned to REPLACE the cluster. So is one EQUAL to it
 * (go-to-k/cdkd#7037): `Engine: postgres` beside that username was persisted
 * as the username's reference. Keeping it discloses nothing: the text is in
 * the synthesized template, while the reference told a state reader that the
 * username IS that text.
 *
 * One refusal keeps the scan where it still protects something: **a STATE
 * source** ({@link PathSourceRules.sourceIsTemplate} unset). Its plain leaf may
 * be a plaintext an older cdkd persisted, which the scan repairs in the copy it
 * writes (the derived-needle arm's pinned shapes). A STATE walk therefore still
 * spells such a literal as the reference; the next template walk, and the
 * deploy's comparison (`compare-record.ts`), render it back.
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
  rules: PathSourceRules
): bag is string {
  return (
    rules.sourceIsTemplate === true &&
    typeof bag === 'string' &&
    bag === source &&
    !isDynamicReferenceString(source)
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
 * send as well. A literal EQUAL to a recorded plaintext is what the
 * pre-go-to-k/cdkd#7037 walk spelled as one whole token, and takes it too, but
 * only from a TEMPLATE source: a STATE source's plain leaf equal to a recorded
 * plaintext may be a secret an older cdkd persisted in plaintext, and copying
 * it onto this leaf would spread it into a second field.
 *
 * Accepted: whether a record's token becomes the literal says whether the
 * secret equals that template text (one bit, and only for a token the template
 * now spells as that literal). The next deploy persists the literal whatever
 * the secret holds, so the bit lasts until then; a pre-#7037 record's token
 * already said the same thing, since the old walk wrote it only on equality.
 */
export function rerenderedSourceLiteral(
  bag: unknown,
  source: unknown,
  secrets: RecordedSecretValues,
  rules: PathSourceRules
): string | undefined {
  if (typeof bag !== 'string' || typeof source !== 'string') return undefined;
  if (!isDynamicReferenceString(bag) || isDynamicReferenceString(source)) return undefined;
  if (rules.sourceIsTemplate !== true && secrets.has(source)) return undefined;
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
 * it repositioned. `template` is the template, so a leaf EQUAL to a recorded
 * plaintext is put back too, and so is a raw leaf that
 * {@link rerenderedSourceLiteral} renders to the template literal
 * (go-to-k/cdkd#7037); the result is always the template's own text. One the
 * walk masked whole (a containment needle inside it) stays as redacted. The `{{resolve:` test is an equivalent
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
    if (redacted === SECRET_MASK) return redacted;
    if (raw === template && !isDynamicReferenceString(raw)) return raw;
    // The leaf a pre-fix walk wrote for that literal, rendering back to it
    // exactly (go-to-k/cdkd#7037: the whole-token `{{resolve:...}}` an
    // `Engine: postgres` beside the username `postgres` was persisted as).
    return rerenderedSourceLiteral(raw, template, secrets, TEMPLATE_SOURCE) ?? redacted;
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

/** What {@link keepTemplateLiteralLeaves} tells {@link rerenderedSourceLiteral}: its source is the template. */
const TEMPLATE_SOURCE: PathSourceRules = {
  descendArrays: false,
  trustAnyExpression: false,
  sourceIsSameGeneration: false,
  sourceIsTemplate: true,
};

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return isPlainObject(value) && hasPlainPrototype(value);
}
