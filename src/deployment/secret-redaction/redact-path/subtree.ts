import { type PathSourceRules, isDynamicReferenceString, isPlainObject } from '../rules.js';

/**
 * Is this rules constant one whose BAG is an AWS readback and whose SOURCE is a
 * persisted STATE bag?
 *
 * Today that is {@link STATE_SOURCED_READBACK_RULES} and its fail-closed twin
 * {@link STATE_SOURCED_BASELINE_RULES}, which differ on nothing this predicate
 * reads (issue #2852 added a DESTINATION flag, not a shape one): the path where
 * the
 * secrets map can be EMPTY by construction (nothing was resolved), so the value
 * scan has no needles and POSITION is the only mechanism left. Derived from the
 * flags rather than compared against the constant so a future one with the same
 * shape is covered automatically. `trustAnyExpression` says the source is a
 * persisted record (holding no PUBLIC reference, so any `{{resolve:...}}` in it
 * is by construction a secret); `!descendArrays` says the bag came back from
 * AWS and may be reordered.
 *
 * `sourceIsSameGeneration` is the third conjunct and it is the one that took a
 * measurement to get right. Without it this also selected
 * {@link STATE_SOURCED_CROSS_GENERATION_RULES} — `cdkd scrub`'s observed walk,
 * whose `properties` have ALREADY been repositioned onto TODAY's template — and
 * taking a source subtree there rewrote a baseline holding the DEPLOYED
 * `:AWSPREVIOUS` reference onto the template's edited `:AWSCURRENT` one. That
 * is precisely the issue #1917 hazard, and `cdkd drift --revert` pushes the
 * baseline to AWS, so it would have applied a reference the stack never
 * deployed. A refusal may only take a source that is the same generation as the
 * bag beside it.
 *
 * A TEMPLATE-sourced caller is deliberately excluded: its source can carry a
 * public `ssm:` reference whose resolved value must STAY resolved (issue
 * #1901), and it always has a populated map, so the value scan already covers
 * the shapes below. So is the rollback replay
 * ({@link STATE_DERIVED_RULES}) — full map, and its bag descends positionally
 * because it was produced by resolving the source.
 */
export function isReadbackProjectedFromState(rules: PathSourceRules): boolean {
  return rules.trustAnyExpression && !rules.descendArrays && rules.sourceIsSameGeneration;
}

/**
 * Does this subtree carry a dynamic reference anywhere?
 *
 * A BOOLEAN, not the occurrence COUNTS an earlier revision collected. The
 * counts existed to decide whether a bag "covered" every reference its source
 * carried, which was the vouching rule for taking a source array wholesale —
 * and that rule is gone (see the array arm), so counting would be a
 * measurement nothing reads.
 */
export function subtreeHasDynamicReference(value: unknown): boolean {
  if (isDynamicReferenceString(value)) return true;
  if (Array.isArray(value)) return value.some(subtreeHasDynamicReference);
  if (isPlainObject(value)) return Object.values(value).some(subtreeHasDynamicReference);
  return false;
}

/**
 * Could the comparator's dotted `path` also be spelled, in `bag`, through an
 * own key that itself contains a dot? Walks own keys as far as `bag` goes; at
 * each level a dotted key equal to, or a dotted prefix of, the rest of the
 * path makes the coordinate ambiguous. Exported so the drift report can ask it
 * of the OBSERVED baseline too, where a readback-only dotted key can sit.
 */
export function pathCrossesDottedKey(bag: unknown, path: string): boolean {
  const segments = path.split('.');
  let cursor: unknown = bag;
  for (let i = 0; i < segments.length; i++) {
    if (cursor === null || typeof cursor !== 'object' || Array.isArray(cursor)) return false;
    const rest = segments.slice(i).join('.');
    for (const key of Object.keys(cursor)) {
      if (key.includes('.') && (rest === key || rest.startsWith(`${key}.`))) return true;
    }
    if (!Object.hasOwn(cursor, segments[i]!)) return false;
    cursor = (cursor as Record<string, unknown>)[segments[i]!];
  }
  return false;
}
