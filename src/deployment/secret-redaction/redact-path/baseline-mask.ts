import { SECRET_MASK } from '../pairs.js';
import { isDynamicReferenceString } from '../rules.js';
import { carriesSecretMask } from '../mask-only.js';
import { subtreeHasDynamicReference, pathCrossesDottedKey } from './subtree.js';
import { RENDERED_DEFINITION_KEYS, definitionSourceCarriesSecret } from './definition.js';

/**
 * Could a {@link SECRET_MASK} in an `observedProperties` baseline at the dotted
 * `path` be an UNCERTIFIED-POSITION mask (issue
 * [#2852](https://github.com/go-to-k/cdkd/issues/2852)'s fail-closed refusal)
 * rather than a `NoEcho` custom-resource mask (issue
 * [#2274](https://github.com/go-to-k/cdkd/issues/2274))? Issue
 * [#3595](https://github.com/go-to-k/cdkd/issues/3595).
 *
 * Answered from the record's own `properties` — the SOURCE the refusal was
 * positioned against — because nothing in the record names the mask's class.
 * The two classes differ in where they land: a fail-closed mask is written
 * into `observedProperties` only, at a position whose source spells a dynamic
 * reference; a `NoEcho` mask is persisted into `properties` too, since there is
 * no expression to store in its place. So:
 *
 * - the node `properties` holds at `path` must carry a `{{resolve:` string (a
 *   raw `Fn::Join` object embedding one counts) and NO mask leaf; or
 * - where `properties` has no node at `path` — the readback reshaped a scalar
 *   the template spells as a reference into a container, and the comparator
 *   reported a key below it — the deepest node it DOES have on the path must be
 *   a STRING carrying a `{{resolve:`.
 *
 * An ancestor OBJECT whose sibling carries a reference is deliberately NOT
 * enough: a `NoEcho` plaintext echoed into a readback-only key beside a
 * templated reference would then read as the fail-closed class.
 *
 * `path` is the drift comparator's coordinate: object keys joined by `.`, never
 * an array index (it compares arrays whole). Own keys only, for the reason
 * `drift.ts`'s `getAtPath` gives. Homed here, beside the redaction that
 * writes the mask, so any later writer-side check asks the SAME question.
 */
export function isUncertifiedBaselineMaskPosition(
  properties: Record<string, unknown>,
  path: string
): boolean {
  // A KEY containing a dot is one segment to the comparator but several here,
  // so the path is AMBIGUOUS wherever such a key could spell the rest of it —
  // and the walk could stop at a sibling string without seeing a mask the real
  // node carries. Fail closed: an ambiguous position keeps the `NoEcho`
  // disposition.
  if (pathCrossesDottedKey(properties, path)) return false;
  // A RENDERED Step Functions definition (issue #5315): the readback's
  // `Definition` is the body with `DefinitionSubstitutions` applied, which
  // `properties` holds under OTHER keys (a `DefinitionString` record has no
  // `Definition` node at all, and an object one holds `${name}` there, no
  // reference), so the walk below can never find the reference the mask stands
  // for. The class is answered from the keys the definition is built from,
  // with the same predicate the writer's arm fires on, so the two cannot
  // disagree about which records it covers. A `***` there is a `NoEcho` VALUE
  // the record substitutes, not a `NoEcho` mask at this position: the mask in
  // the baseline is the writer's fail-closed one either way.
  const [head] = path.split('.');
  if (head !== undefined && RENDERED_DEFINITION_KEYS.has(head)) {
    return definitionSourceCarriesSecret(properties);
  }
  let cursor: unknown = properties;
  for (const segment of path.split('.')) {
    if (typeof cursor === 'string') break;
    if (
      cursor === null ||
      typeof cursor !== 'object' ||
      Array.isArray(cursor) ||
      !Object.hasOwn(cursor, segment)
    ) {
      return false;
    }
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  if (typeof cursor === 'string') {
    return isDynamicReferenceString(cursor) && cursor !== SECRET_MASK;
  }
  return subtreeHasDynamicReference(cursor) && !carriesSecretMask(cursor);
}
