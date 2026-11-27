import { SECRET_MASK, resolvedPlaintextOf, type RecordedSecretValues } from '../pairs.js';
import { type PathSourceRules, isPlainObject } from '../rules.js';
import { referencesConsumedBy } from '../consumed-references.js';
import { physicalNameCopiesOf } from '../physical-name-copies.js';
import { hasPlainPrototype } from './json-equality.js';
import {
  TAINTED_WITHOUT_SPAN,
  exposedAt,
  positionBySubstitutionSpans,
} from './substitution-spans.js';

/**
 * The plaintext of every secret the resolution of a node of `source` consumed
 * (go-to-k/cdkd#7050), searched through `source`'s arrays and objects: the
 * resolver stamps the intrinsic objects it dispatched, never the list
 * holding them.
 */
function consumedPlaintextsUnder(source: unknown, secrets: RecordedSecretValues): string[] {
  const out = new Set<string>();
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (!isPlainObject(node)) return;
    for (const token of referencesConsumedBy(secrets, node)) {
      const plaintext = resolvedPlaintextOf(secrets, token);
      if (plaintext !== undefined && plaintext !== '') out.add(plaintext);
    }
    Object.values(node).forEach(visit);
  };
  visit(source);
  return [...out];
}

/**
 * How to persist an element of a list no position paired with an element of
 * the list `source` (an AWS readback, which may be reordered, so it is never
 * descended by index) (go-to-k/cdkd#7050), or `undefined` when no node of
 * `source` consumed a secret and the value scan answers as before.
 *
 * The value scan cannot see a 1-3 character secret, so an unpaired element
 * holding the text of a secret `source` consumed was kept in plaintext in
 * `observedProperties` while `properties` held the same leaf positioned or
 * masked. A string element that one element of `source` RESOLVED TO exactly is
 * placed by that element's recorded substitution spans, as `properties` is
 * (several candidates must agree); every other string leaf still holding such
 * a secret's text outside a reference is masked whole. Fail closed: a refusal
 * masks the leaf.
 */
export function placeUnpairedListElements(
  source: unknown[],
  secrets: RecordedSecretValues,
  rules: PathSourceRules,
  scan: (value: unknown) => unknown
): ((item: unknown) => unknown) | undefined {
  const plaintexts = consumedPlaintextsUnder(source, secrets);
  if (plaintexts.length === 0) return undefined;
  const copies = [...(physicalNameCopiesOf.get(secrets) ?? [])].filter((c) => c !== '');
  const exposes = (text: string): boolean =>
    plaintexts.some((plaintext) => exposedAt(text, plaintext, copies).length > 0);
  const placeString = (item: string): string => {
    let answer: string | undefined;
    for (const candidate of source) {
      let placed: ReturnType<typeof positionBySubstitutionSpans>;
      try {
        placed = positionBySubstitutionSpans(item, candidate, secrets, rules, scan);
      } catch {
        return SECRET_MASK;
      }
      if (placed === undefined) continue;
      if (placed === TAINTED_WITHOUT_SPAN) continue;
      if (answer !== undefined && answer !== placed) return SECRET_MASK;
      answer = placed;
    }
    return answer ?? SECRET_MASK;
  };
  const maskExposed = (value: unknown): unknown => {
    if (typeof value === 'string') return exposes(value) ? SECRET_MASK : value;
    if (Array.isArray(value)) return value.map(maskExposed);
    // A `Date` (or any non-plain object) the scan returned is kept as is,
    // never rebuilt into `{}` (go-to-k/cdkd#2869).
    if (isPlainObject(value) && hasPlainPrototype(value)) {
      const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      for (const [k, v] of Object.entries(value)) out[k] = maskExposed(v);
      return out;
    }
    return value;
  };
  return (item: unknown): unknown =>
    typeof item === 'string' && exposes(item) ? placeString(item) : maskExposed(scan(item));
}
