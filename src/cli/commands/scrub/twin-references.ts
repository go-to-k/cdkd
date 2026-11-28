import {
  resolvedPlaintextOf,
  type RecordedSecretValues,
} from '../../../deployment/secret-redaction/pairs.js';
import { dynamicReferenceSpans } from '../../../deployment/secret-redaction/redact-path/reference-tokens.js';
import type { ResourceState } from '../../../types/state.js';

/**
 * The same pairing for the drift baseline (go-to-k/cdkd#7154): a `walked`
 * record's `observedProperties` against `properties` as the scrub positioned
 * them, each observed leaf proven against the STORED readback. A readback
 * that reordered a list, or added a key, never corroborates and keeps the
 * walk's leaf. `positionedProperties` is `undefined` when no template
 * positioned the record, and the record is returned as walked.
 */
export function withObservedTwinsPositioned(
  walked: ResourceState,
  stored: ResourceState,
  positionedProperties: unknown,
  secrets: RecordedSecretValues
): ResourceState {
  if (positionedProperties === undefined) return walked;
  if (stored.observedProperties === undefined || walked.observedProperties === undefined)
    return walked;
  const observed = positionTwinReferences(
    stored.observedProperties,
    walked.observedProperties,
    positionedProperties,
    secrets
  ) as Record<string, unknown>;
  return observed === walked.observedProperties
    ? walked
    : { ...walked, observedProperties: observed };
}

/**
 * Re-position the leaves of a scrubbed `properties` bag whose template
 * expression lost the secrets map's slot to a twin (go-to-k/cdkd#7154).
 *
 * `cdkd scrub` positions a stored `properties` bag against today's template
 * under the `template-sourced` rules, which never descend a list by index
 * (the stored list and the template list may come from different
 * generations). A list leaf therefore falls to the value scan, and the scan's
 * map is keyed by PLAINTEXT: where two different references resolve to the
 * same plaintext, the scan writes ONE of them everywhere, so the list leaf can
 * hold its twin's expression. The next deploy then diffs that leaf against
 * the template and plans an update.
 *
 * This walk pairs the three bags by TEMPLATE POSITION: an array only when the
 * stored bag, the positioned bag and the template all hold an array of the
 * same length there, and an element only when the template element
 * CORROBORATES the stored one (the same keys and lengths, every literal leaf
 * equal: a reordered list, keyed by `Name` or not, never pairs a value with
 * another element's reference); an object by the keys all three hold. At a
 * string leaf it
 * writes the template's own text, and only when that is PROVEN to be what the
 * stored leaf is:
 * - every `{{resolve:...}}` token of the template text is one THIS pass
 *   resolved (its own pair table, so a twin that lost the collapsed map's slot
 *   still answers), to a plaintext the map records;
 * - substituting each token by its plaintext gives the STORED leaf exactly, so
 *   the stored value is this pass's resolution of that very text (a leaf that
 *   already holds an expression, a rotated value or an edited template never
 *   matches, as the `template-sourced` rules require, issue #1917);
 * - the text outside the tokens holds no recorded plaintext, so the leaf
 *   written is never less masked than the scan's.
 *
 * Anything else, a list whose lengths differ included, keeps the positioned
 * leaf as it is: masked, with the one spurious update the issue names. A
 * leaf whose pairing is ambiguous is never guessed.
 */
export function positionTwinReferences(
  stored: unknown,
  positioned: unknown,
  template: unknown,
  secrets: RecordedSecretValues
): unknown {
  if (secrets.size === 0) return positioned;
  const plaintexts = [...secrets.keys()].filter((p) => p !== '');
  const walk = (s: unknown, p: unknown, t: unknown): unknown => {
    if (typeof t === 'string') {
      if (typeof s !== 'string' || typeof p !== 'string' || p === t) return p;
      return provenTemplateText(s, t, secrets, plaintexts) ? t : p;
    }
    if (Array.isArray(t)) {
      if (!Array.isArray(s) || !Array.isArray(p) || s.length !== t.length || p.length !== t.length)
        return p;
      let changed = false;
      const out = p.map((item, i) => {
        if (!corroborates(s[i], t[i])) return item;
        const next = walk(s[i], item, t[i]);
        if (next !== item) changed = true;
        return next;
      });
      return changed ? out : p;
    }
    if (!isPlainRecord(t) || !isPlainRecord(s) || !isPlainRecord(p)) return p;
    let out: Record<string, unknown> | undefined;
    for (const key of Object.keys(t)) {
      if (!Object.hasOwn(s, key) || !Object.hasOwn(p, key)) continue;
      const next = walk(s[key], p[key], t[key]);
      if (next !== p[key]) {
        // The bag's own prototype (a null one included, go-to-k/cdkd#1943),
        // and a defined property, so a `__proto__` key stays a key.
        out ??= Object.defineProperties(
          Object.create(Object.getPrototypeOf(p) as object | null) as Record<string, unknown>,
          Object.getOwnPropertyDescriptors(p)
        );
        Object.defineProperty(out, key, {
          value: next,
          writable: true,
          enumerable: true,
          configurable: true,
        });
      }
    }
    return out ?? p;
  };
  return walk(stored, positioned, template);
}

/**
 * Does template element `t` describe stored element `s`: the same shape, every
 * string leaf without a token equal, every other leaf equal? A string leaf
 * holding a token stands for any stored string, which the leaf proof checks.
 */
function corroborates(s: unknown, t: unknown): boolean {
  if (typeof t === 'string') {
    return typeof s === 'string' && (dynamicReferenceSpans(t).length > 0 || s === t);
  }
  if (Array.isArray(t)) {
    return (
      Array.isArray(s) && s.length === t.length && t.every((item, i) => corroborates(s[i], item))
    );
  }
  if (isPlainRecord(t)) {
    if (!isPlainRecord(s)) return false;
    const keys = Object.keys(t);
    return (
      keys.length === Object.keys(s).length &&
      keys.every((key) => Object.hasOwn(s, key) && corroborates(s[key], t[key]))
    );
  }
  return Object.is(s, t);
}

/** Is `text` (a template leaf) proven to be the expression of the stored `value`? */
function provenTemplateText(
  value: string,
  text: string,
  secrets: RecordedSecretValues,
  plaintexts: readonly string[]
): boolean {
  // A text with no token is never written: it equals the stored value only
  // when it spells that value's plaintext, which the literal check refuses.
  const spans = dynamicReferenceSpans(text);
  let resolved = '';
  let cursor = 0;
  for (const { start, end } of spans) {
    const literal = text.slice(cursor, start);
    if (plaintexts.some((p) => literal.includes(p))) return false;
    const plaintext = resolvedPlaintextOf(secrets, text.slice(start, end));
    if (plaintext === undefined || !secrets.has(plaintext)) return false;
    resolved += literal + plaintext;
    cursor = end;
  }
  const tail = text.slice(cursor);
  if (plaintexts.some((p) => tail.includes(p))) return false;
  return resolved + tail === value;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
