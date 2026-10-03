import { isPlainObject } from './rules.js';
import { type RecordedSecretValues } from './pairs.js';
import { associationForSource, certifiedListForLeaf } from './certified-positions.js';

/**
 * Keys tried, in order, when pairing two arrays whose ORDER cannot be trusted
 * (issue #1915).
 *
 * Both are the identity field of an unordered CloudFormation list that really
 * does carry secrets: `Name` is the ECS `ContainerDefinitions[]` /
 * `Environment[]` / `Secrets[]` and CodeBuild `EnvironmentVariables[]` shape,
 * `Key` is the `Tags[]` shape the drift normalizer already keys on
 * (`canonicalizeTagListsDeep` in `src/analyzer/drift-normalize.ts`). The list
 * is deliberately SHORT: an entry is only useful when it is a genuine identity,
 * and a wrong entry costs a refused pairing rather than a wrong one (see
 * {@link identityKeyFor}), so widening it buys little and has to be justified
 * per shape.
 *
 * Worth naming rather than leaving to be rediscovered: `drift-normalize.ts`
 * deliberately moved its GENERAL case OFF heuristics like this one, onto
 * provider-DECLARED paths (`getDriftUnorderedPaths` + `matchesPathPrefix`),
 * after issue #1783 showed a heuristic claiming order-independence for a list
 * that was order-SIGNIFICANT (`KeySchema`). Only its `Tags[]` pass is still a
 * heuristic. This module diverges on purpose, because the two failure modes are
 * not comparable: there, a wrong claim SUPPRESSES real drift; here, the worst a
 * wrong pairing key can do is fail the uniqueness test and refuse, leaving the
 * leaf exactly where the value scan already had it. If that ever stops being
 * true — if a pairing gains the power to DELETE or REORDER rather than only to
 * rewrite a matched leaf — this list has to move to a declared seam too.
 */
const ARRAY_IDENTITY_KEYS = ['Name', 'Key'] as const;

/**
 * Is every element of `items` a plain object carrying a NON-EMPTY OWN string at
 * `key`, with no two elements sharing a value?
 *
 * `Object.hasOwn` for the same reason the object walk below uses it: without
 * it the prototype chain answers for a key like `constructor`, and while state
 * that came from `JSON.parse` cannot carry one, this module is called with
 * caller-constructed bags too and the two walks disagreeing is the kind of gap
 * that only shows up once something else changes.
 *
 * The empty string is excluded because it is not a distinguishing identity —
 * the same reason the value scan refuses it as a needle. Two elements both
 * carrying `Name: ''` would otherwise pair on "equality" that means nothing.
 */
function isUniquelyKeyedBy(items: readonly unknown[], key: string): boolean {
  if (items.length === 0) return false;
  const seen = new Set<string>();
  for (const item of items) {
    if (!isPlainObject(item) || !Object.hasOwn(item, key)) return false;
    const id = item[key];
    if (typeof id !== 'string' || id === '') return false;
    if (seen.has(id)) return false;
    seen.add(id);
  }
  return true;
}

/**
 * Pick a key that identifies the elements of BOTH arrays, or `undefined` when
 * none does (issue #1915).
 *
 * This is what lets a leaf nested in an ARRAY be positioned on a path where
 * positional descent is refused. `descendArrays: false` is not a claim that the
 * bag and source elements are unrelated — it is a claim that their ORDER does
 * not correspond, because AWS does not preserve list order (the reason
 * `src/analyzer/drift-normalize.ts` exists). Matching by an identity FIELD
 * answers the order objection directly instead of working around it, so the
 * relaxation is sound on every rules constant and is deliberately NOT gated on
 * one.
 *
 * Requiring uniqueness WITHIN each array is what makes a pairing impossible to
 * get wrong: pairing is by string EQUALITY, so a bag element can only ever meet
 * the source element carrying the same identity, and uniqueness means there is
 * at most one of those. A key that is not really an identity (a repeated enum
 * value) fails the uniqueness test and refuses the whole pairing rather than
 * producing a plausible-looking wrong one. An element with no partner is not
 * guessed at either — it falls to the value scan, exactly as the whole array
 * did before.
 *
 * Keys are tried in {@link ARRAY_IDENTITY_KEYS} order and the FIRST one that
 * qualifies on both sides wins; a key that fails does not veto the next one.
 *
 * Two shapes this deliberately does NOT reach, stated so they are bounds rather
 * than surprises — both fail closed, leaving the leaf to the value scan:
 *
 * - **The identity field itself holds a secret.** The source element carries
 *   `{Name: '{{resolve:...}}'}` and the bag element the resolved plaintext, so
 *   the two never pair and the element's other leaves are not reached either.
 *   Closing it would mean pairing on a field whose two sides are KNOWN to
 *   differ, i.e. exactly the guessing the uniqueness rule exists to forbid. On
 *   the unchanged-resource path the value scan is also a no-op, so such a leaf
 *   keeps its plaintext — narrow (an identity field is a name, not a
 *   credential) but real.
 * - **Arrays of arrays.** `M: [[{Name, Value}]]` pairs nothing HERE, because the
 *   OUTER elements are arrays rather than plain objects and have no identity
 *   field to key on. Blind positional descent into the outer list would
 *   reintroduce the order assumption this function exists to avoid. On the
 *   READBACK paths it is no longer a dead end:
 *   {@link refuseUncertifiedReadbackPositions} (issue #2012) walks the outer
 *   list positionally when {@link unkeyedArrayPairsByAnchors} says the inner
 *   elements' own anchors vouch for the alignment, which meets the order
 *   objection instead of ignoring it. The gate decides; it does not walk. Everywhere else — and whenever
 *   those anchors do not match — the shape still falls to the value scan.
 */
export function identityKeyFor(
  bag: readonly unknown[],
  source: readonly unknown[]
): string | undefined {
  for (const key of ARRAY_IDENTITY_KEYS) {
    if (isUniquelyKeyedBy(bag, key) && isUniquelyKeyedBy(source, key)) return key;
  }
  return undefined;
}

/**
 * Position the ELEMENTS of an array leaf whose SOURCE is an intrinsic OBJECT,
 * by the same leaf-identity lookup {@link positionByCrossStackSource} performs
 * for a string leaf (issue
 * [#2327](https://github.com/go-to-k/cdkd/issues/2327)).
 *
 * A child parameter declared `CommaDelimitedList` is coerced by
 * `coerceParameterTypedValue` into an ARRAY before any of this runs, so a
 * leaf the child template spells `{Ref: <Param>}` arrives beside an intrinsic
 * OBJECT as an array — a shape NO arm matched, which dropped it to the
 * plaintext-keyed value scan and handed BOTH members of a coinciding pair the
 * survivor's expression. `docs/cli-reference.md` names `CommaDelimitedList` as
 * an ALLOWED spelling for a secret-bearing nested-stack parameter, so it is
 * reachable rather than theoretical.
 *
 * The element rule, what it refuses and why nothing is fabricated all live on
 * {@link certifiedListForLeaf}, which the DIFF side calls too. TWO further
 * refusals belong to THIS site rather than to the shared rule:
 *
 * 1. REFUSAL — a source leaf {@link crossStackSourceKey} cannot key, or one
 *    this pass recorded no association for. Both fall to the value scan, i.e.
 *    to today's behaviour.
 * 2. REFUSAL — {@link positionByIntrinsicSkeleton} is deliberately NOT tried
 *    element-wise, and the asymmetry with the string arm is structural rather
 *    than caution. {@link intrinsicSkeletonPattern} accepts exactly `Fn::Join`
 *    and `Fn::Sub`, both of which produce a STRING; an array bag beside one of
 *    them is a SHAPE DIVERGENCE, not a position. Matching a per-element pattern
 *    built from text that describes the whole joined string would be a guess of
 *    precisely the kind condition 2 of that function exists to refuse.
 *
 * NOT GATED ON `rules`, for the reason the string arm next door is not: the
 * certification rests on the element being a plaintext THIS pass recorded,
 * which a previous generation's persisted expression can never be, and it never
 * depends on the two sides being positionally aligned. In practice only the
 * TEMPLATE-sourced walks can reach it at all — every STATE-sourced source leaf
 * is a persisted value, not an intrinsic object — but the safety does not rest
 * on that.
 */
export function positionListByCrossStackSource(
  bag: readonly unknown[],
  source: Record<string, unknown>,
  secrets: RecordedSecretValues
): unknown[] | undefined {
  const association = associationForSource(source, secrets);
  if (association === undefined) return undefined;
  return certifiedListForLeaf(secrets, association, bag);
}
