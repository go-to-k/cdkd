import type { RecordedSecretValues } from './pairs.js';

/**
 * What the resolver DID with a template object, per pass bag (issue
 * [#4954](https://github.com/go-to-k/cdkd/issues/4954)): the branch each
 * `Fn::If` object took, and which elements of a source array dropped out as
 * `AWS::NoValue`. The persist walk reads them where the resolved value alone
 * cannot say -- an `Fn::If` whose branches resolve to one plaintext spelled
 * two ways, an array of which only some droppable elements dropped -- so it
 * positions the leaf as the diff side computes it, which evaluates the same
 * conditions.
 *
 * Keyed like the leaf-resolution records (`pairs.ts`, issue #3156): by the
 * pass's bag and the template OBJECT resolved, both weakly. A second
 * resolution of one object into one bag with another outcome POISONS it for
 * that bag -- except a resolution dropping NOTHING from an array, which
 * records nothing. Both rest on one INVARIANT: every resolution sharing a bag
 * evaluates one conditions table, so its outcomes never differ (a caller
 * resolving into a bag under another table breaks it, and must use its own
 * bag). A poisoned or absent record reads as none, and every reader then
 * keeps its record-free answer.
 */
const CONFLICTING: unique symbol = Symbol('cdkd.resolver-outcome.conflicting');

const takenBranches = new WeakMap<
  RecordedSecretValues,
  WeakMap<object, boolean | typeof CONFLICTING>
>();

/** Record that the pass owning `secrets` took `source`'s TRUE branch, or its false one. */
export function recordTakenIfBranch(
  secrets: RecordedSecretValues,
  source: object,
  tookTrueBranch: boolean
): void {
  let taken = takenBranches.get(secrets);
  if (taken === undefined) {
    taken = new WeakMap();
    takenBranches.set(secrets, taken);
  }
  const previous = taken.get(source);
  if (previous === undefined) taken.set(source, tookTrueBranch);
  else if (previous !== tookTrueBranch) taken.set(source, CONFLICTING);
}

/**
 * Did the pass owning `secrets` take the `Fn::If` object `source`'s true
 * branch? `undefined` when it recorded none, or two different ones.
 */
export function takenIfBranchOf(
  secrets: RecordedSecretValues,
  source: object
): boolean | undefined {
  const taken = takenBranches.get(secrets)?.get(source);
  return taken === CONFLICTING ? undefined : taken;
}

const droppedElements = new WeakMap<
  RecordedSecretValues,
  WeakMap<object, readonly number[] | typeof CONFLICTING>
>();

/**
 * Record the indices, ascending, of the elements of the source array `source`
 * the pass owning `secrets` dropped. ONLY a resolution that dropped something
 * records (an ordinary array costs a length comparison), so an absent record
 * means "nothing dropped, or never resolved into this bag": a reader holding a
 * shorter bag and no record keeps its record-free answer.
 */
export function recordDroppedArrayElements(
  secrets: RecordedSecretValues,
  source: readonly unknown[],
  dropped: readonly number[]
): void {
  let arrays = droppedElements.get(secrets);
  if (arrays === undefined) {
    arrays = new WeakMap();
    droppedElements.set(secrets, arrays);
  }
  const previous = arrays.get(source);
  if (previous === undefined) arrays.set(source, [...dropped]);
  else if (
    previous !== CONFLICTING &&
    (previous.length !== dropped.length || previous.some((index, i) => index !== dropped[i]))
  ) {
    arrays.set(source, CONFLICTING);
  }
}

/** The source elements the pass owning `secrets` dropped from `source`; see {@link recordDroppedArrayElements}. */
export function droppedArrayElementsOf(
  secrets: RecordedSecretValues,
  source: readonly unknown[]
): readonly number[] | undefined {
  const dropped = droppedElements.get(secrets)?.get(source);
  return dropped === CONFLICTING ? undefined : dropped;
}
