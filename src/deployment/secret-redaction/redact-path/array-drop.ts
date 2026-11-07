import { type RecordedSecretValues, resolvedPlaintextOf } from '../pairs.js';
import { isSingleDynamicReferenceToken, isPlainObject } from '../rules.js';
import { droppedArrayElementsOf } from '../resolver-outcomes.js';

/**
 * Whether resolving a source ARRAY element can drop it from the resolved
 * array (`resolveValue` filters `AWS::NoValue`; issue
 * [#4919](https://github.com/go-to-k/cdkd/issues/4919)): `always` (a `Ref` to
 * `AWS::NoValue`; `Ref` is dispatched first), `never` (a literal, an array, any
 * other `Ref`, a single-key `Fn::Join` / `Fn::Sub` / `Fn::Select` /
 * `Fn::Split` / `Fn::GetAtt`, an `Fn::If` neither of whose branches can drop),
 * `maybe` (a single-key `Fn::If` with a branch that can), or `unknown` (any
 * other intrinsic, a malformed `Fn::If`): nothing here says it cannot.
 */
type ArrayElementDrop = 'always' | 'never' | 'maybe' | 'unknown';

const NEVER_DROPPING_INTRINSICS: ReadonlySet<string> = new Set([
  'Fn::Join',
  'Fn::Sub',
  'Fn::Select',
  'Fn::Split',
  'Fn::GetAtt',
]);

function arrayElementDrop(element: unknown, depth = 0): ArrayElementDrop {
  if (depth > 16) return 'unknown';
  if (!isPlainObject(element)) return 'never';
  if (Object.hasOwn(element, 'Ref')) return element['Ref'] === 'AWS::NoValue' ? 'always' : 'never';
  const keys = Object.keys(element);
  const intrinsics = keys.filter((key) => key.startsWith('Fn::') || key === 'Condition');
  if (intrinsics.length === 0) return 'never';
  if (keys.length !== 1) return 'unknown';
  if (NEVER_DROPPING_INTRINSICS.has(keys[0]!)) return 'never';
  if (keys[0] !== 'Fn::If') return 'unknown';
  const args = element['Fn::If'];
  if (!Array.isArray(args) || args.length !== 3) return 'unknown';
  const branches = [arrayElementDrop(args[1], depth + 1), arrayElementDrop(args[2], depth + 1)];
  if (branches.includes('unknown')) return 'unknown';
  if (branches.every((branch) => branch === 'never')) return 'never';
  if (branches.every((branch) => branch === 'always')) return 'always';
  return 'maybe';
}

/**
 * The elements of a source array that stay in a resolved bag of `bagLength`
 * elements, in order. Where the pass owning `secrets` RECORDED which elements
 * it dropped (`droppedArrayElementsOf`, issue
 * [#4954](https://github.com/go-to-k/cdkd/issues/4954)), every other element,
 * and `undefined` when that count is not `bagLength` (the bag is not that
 * resolution). With no record, where the count says which dropped (issue
 * [#4919](https://github.com/go-to-k/cdkd/issues/4919)): every `always`
 * element, and either none or all of the `maybe` ones; `undefined` for an
 * `unknown` element or any other count -- some but not all `maybe` elements,
 * which no count can tell apart.
 */
export function sourceElementsKeptFor(
  source: readonly unknown[],
  bagLength: number,
  secrets?: RecordedSecretValues
): unknown[] | undefined {
  const recorded = secrets && droppedArrayElementsOf(secrets, source);
  if (recorded !== undefined) {
    if (source.length - recorded.length !== bagLength) return undefined;
    return source.filter((_, i) => !recorded.includes(i));
  }
  const drops = source.map((element) => arrayElementDrop(element));
  if (drops.includes('unknown')) return undefined;
  const always = drops.filter((drop) => drop === 'always').length;
  const maybe = drops.filter((drop) => drop === 'maybe').length;
  const dropped = source.length - bagLength;
  let dropMaybe: boolean;
  if (dropped === always) dropMaybe = false;
  else if (dropped === always + maybe) dropMaybe = true;
  else return undefined;
  return source.filter((_, i) => drops[i] === 'never' || (drops[i] === 'maybe' && !dropMaybe));
}

/**
 * Does every kept source element agree with the bag element it pairs with
 * (issue [#4919](https://github.com/go-to-k/cdkd/issues/4919))? See
 * {@link keptElementCorroborates}.
 */
export function keptLiteralsCorroborate(
  kept: readonly unknown[],
  bag: readonly unknown[],
  secrets: RecordedSecretValues
): boolean {
  return kept.every((element, i) => keptElementCorroborates(element, bag[i], secrets));
}

/** A single-key `Ref` / `Fn::*` object: the arm the pairing hands it to checks its value. */
function isIntrinsicNode(value: unknown): boolean {
  if (!isPlainObject(value)) return false;
  const keys = Object.keys(value);
  return keys.length === 1 && (keys[0] === 'Ref' || keys[0]!.startsWith('Fn::'));
}

/**
 * Does a kept source element agree with its bag element, leaf by leaf? A
 * plain literal must equal it; a string holding a `{{resolve:...}}` token must
 * be ONE token this pass resolved to exactly that leaf (`resolvedPlaintextOf`);
 * an intrinsic is accepted, as the arm it reaches checks the value; a plain
 * object or array is walked, each bag key matched by a source key and a source
 * key the bag lacks one that can resolve to `AWS::NoValue`. Anything else, an
 * array of another length included, refuses the whole pairing.
 */
function keptElementCorroborates(
  source: unknown,
  bag: unknown,
  secrets: RecordedSecretValues,
  depth = 0
): boolean {
  if (depth > 16) return false;
  if (typeof source === 'string') {
    if (!source.includes('{{resolve:')) return source === bag;
    return isSingleDynamicReferenceToken(source) && resolvedPlaintextOf(secrets, source) === bag;
  }
  if (source === null || typeof source !== 'object') return source === bag;
  if (isIntrinsicNode(source)) return true;
  if (Array.isArray(source)) {
    return (
      Array.isArray(bag) &&
      bag.length === source.length &&
      source.every((element, i) => keptElementCorroborates(element, bag[i], secrets, depth + 1))
    );
  }
  if (!isPlainObject(source) || !isPlainObject(bag)) return false;
  if (Object.keys(bag).some((key) => !Object.hasOwn(source, key))) return false;
  return Object.entries(source).every(([key, value]) =>
    Object.hasOwn(bag, key)
      ? keptElementCorroborates(value, bag[key], secrets, depth + 1)
      : arrayElementDrop(value) === 'always' || arrayElementDrop(value) === 'maybe'
  );
}

/**
 * Can {@link keptElementCorroborates} accept this kept element whatever the
 * pass resolved, from the template alone? Not where it holds a
 * `{{resolve:...}}` string (a public reference has no pair, an embedding
 * literal is no single token) or a nested array an element can drop out of.
 */
function corroboratesWhateverResolves(source: unknown, depth = 0): boolean {
  if (depth > 16) return false;
  if (typeof source === 'string') return !source.includes('{{resolve:');
  if (source === null || typeof source !== 'object') return true;
  if (isIntrinsicNode(source)) return true;
  if (Array.isArray(source)) {
    return source.every(
      (element) =>
        arrayElementDrop(element) === 'never' && corroboratesWhateverResolves(element, depth + 1)
    );
  }
  if (!isPlainObject(source)) return false;
  // A `Ref` / `Fn::*` key beside others is dispatched as that intrinsic by
  // `resolveValue`, not walked as an object; and a property only the persist
  // walk's drop classifier can excuse when it is missing must be one it
  // classifies (an `Fn::FindInMap` `DefaultValue`, even under an `Fn::If`,
  // can drop it unclassified).
  if (Object.keys(source).some((key) => key === 'Ref' || key.startsWith('Fn::'))) return false;
  return Object.values(source).every(
    (value) =>
      arrayElementDrop(value) !== 'unknown' && corroboratesWhateverResolves(value, depth + 1)
  );
}

/**
 * Does the shrunken-array pairing ({@link sourceElementsKeptFor} and
 * {@link keptLiteralsCorroborate}) pair a resolved bag of this source array
 * whatever its elements resolve to? The resolver records which elements a
 * pass dropped (issue [#4954](https://github.com/go-to-k/cdkd/issues/4954)),
 * so how many can drop, and whether anything here classifies them, no longer
 * matters: every element must be one the corroboration accepts from the
 * template alone. The collision walk (`poisonRenderedSpellingsCollidingIn`)
 * runs before conditions are evaluated and reads such an array as walked by
 * position. An array holding no element that can resolve to `AWS::NoValue`
 * -- an `Fn::If`, a `Ref` to it, an `Fn::FindInMap` with a `DefaultValue`
 * (`resolveFindInMap` can return it) -- is walked by position anyway.
 */
export function arrayPairsWhateverDrops(source: readonly unknown[]): boolean {
  const mayDrop = source.some(
    (element) =>
      isPlainObject(element) &&
      (Object.hasOwn(element, 'Fn::If') ||
        element['Ref'] === 'AWS::NoValue' ||
        (Array.isArray(element['Fn::FindInMap']) && element['Fn::FindInMap'].length > 3))
  );
  if (!mayDrop) return true;
  return source.every((element) => corroboratesWhateverResolves(element));
}
