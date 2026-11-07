import type { RecordedSecretValues } from '../pairs.js';
import { MIN_NEEDLE_LENGTH } from '../rules.js';
import { substringNeedlesOf } from '../fresh-noecho.js';

/**
 * Does any string leaf of `value` contain a child-bag KEY the parent-bag scan
 * would not redact the way the child scan does? Two halves, mirroring the
 * child scan's whole-value arm (every key) and its substring arm (needles):
 *
 * - a key the parent does not HOLD at all -- needle or mask-only alike, since
 *   a parent needle overlapping it cuts it apart where the child scan took it
 *   whole;
 * - a child NEEDLE the parent holds only as mask-only, which is no parent
 *   needle, so the parent scan can cut it apart the same way.
 *
 * - a parent NEEDLE (at or above `MIN_NEEDLE_LENGTH`) the child bag does not
 *   hold, which the parent scan could take first and so cut a child plaintext
 *   overlapping it.
 *
 * A key both bags hold as needles, with different expressions, passes: that is
 * the #2349 row itself. Containment at ANY length; declining keeps the
 * pre-#2349 child-bag redaction.
 */
export function carriesChildOnlyPlaintext(
  value: unknown,
  childSecrets: RecordedSecretValues,
  parentSecrets: RecordedSecretValues
): boolean {
  const parentNeedles = new Set(substringNeedlesOf(parentSecrets));
  const childNeedles = new Set(substringNeedlesOf(childSecrets));
  const childOnly = [...childSecrets.keys()].filter(
    (plaintext) =>
      plaintext !== '' &&
      (!parentSecrets.has(plaintext) ||
        (childNeedles.has(plaintext) && !parentNeedles.has(plaintext)))
  );
  // Third half: a PARENT needle the child bag does not hold. Today
  // `inheritedSecretsCarriedBy` puts every parent needle the value carries
  // into the child bag; asked here so the guarantee does not rest on that.
  // Floored at `MIN_NEEDLE_LENGTH`: the parent scan never takes a shorter key
  // as a substring, so it cannot cut anything (the first two halves stay
  // unfloored, as they guard the child's whole-value arm).
  for (const needle of parentNeedles) {
    if (needle.length >= MIN_NEEDLE_LENGTH && !childSecrets.has(needle)) childOnly.push(needle);
  }
  if (childOnly.length === 0) return false;
  const visit = (node: unknown): boolean => {
    if (typeof node === 'string') return childOnly.some((plaintext) => node.includes(plaintext));
    if (Array.isArray(node)) return node.some(visit);
    if (node !== null && typeof node === 'object') return Object.values(node).some(visit);
    return false;
  };
  return visit(value);
}
