import type { FreshNoEchoLeaf } from './secret-redaction.js';
import type { PropertyChange } from '../types/state.js';

/**
 * Whether a property change's `requiresReplacement` is only a CEILING the diff
 * set before the value could be known — a synthetic change from in-place
 * attribute propagation or replacement propagation (go-to-k/cdkd#3662). The
 * UPDATE arm lowers such a ceiling when the resolved value equals the record.
 */
export function isReplacementCeiling(pc: PropertyChange): boolean {
  return (
    pc.requiresReplacement && (pc.inPlacePropagated === true || pc.replacementPropagated === true)
  );
}

/**
 * `JSON.stringify` with every object's keys in sorted order, arrays kept
 * positional: the equality the replacement-ceiling lowering and the
 * post-readback skip compare with (go-to-k/cdkd#3803 review). The diff raised
 * the ceiling through `DiffCalculator.valuesEqual`, which ignores key order,
 * and a template and a `JSON.parse`d record can spell the same create-only
 * object in different orders; an order-sensitive compare there read an equal
 * value as moved and replaced the resource.
 */
export function keyOrderFreeJson(value: unknown): string {
  return JSON.stringify(value, (_key, node: unknown) => {
    if (node === null || typeof node !== 'object' || Array.isArray(node)) return node;
    // Null prototype, so a `__proto__` key stays an own key.
    const sorted = Object.create(null) as Record<string, unknown>;
    for (const key of Object.keys(node).sort()) {
      sorted[key] = (node as Record<string, unknown>)[key];
    }
    return sorted;
  });
}

/**
 * Why a create-only path carrying a fresh `NoEcho` value kept its replacement
 * ceiling (go-to-k/cdkd#3729), or `held` when AWS confirmed it may be lowered.
 * The class is all a log line says: never a value, never an error's text.
 *
 *  - `not-readable` — no provider readback for the record's route, the
 *    readback returned nothing, or it did not report the property at all;
 *  - `read-failed` — the readback threw, or outlived its cap;
 *  - `differs` — the property was read, and some fresh position does not hold
 *    exactly this value (a different string, a non-string, an array that does
 *    not reach that index).
 */
export type FreshNoEchoCeilingVerdict = 'held' | 'not-readable' | 'read-failed' | 'differs';

/** The result of reading a reader back once for its fresh-`NoEcho` ceilings. */
export type FreshNoEchoReadback =
  | { live: Record<string, unknown> }
  | { failure: 'not-readable' | 'read-failed' };

/**
 * Does `live` hold every fresh leaf's plaintext at that leaf's position, with
 * strict string equality (go-to-k/cdkd#3729)? `live` is the readback's value for
 * one top-level property; each leaf's path is relative to it. ALL must hold.
 * Anything this walk cannot follow counts as a difference: a missing key, an
 * index past the end of an array, a container where a string should be. That
 * is the direction that keeps the replacement, which is today's behaviour.
 */
export function liveHoldsFreshLeaves(live: unknown, leaves: readonly FreshNoEchoLeaf[]): boolean {
  for (const leaf of leaves) {
    let node: unknown = live;
    for (const segment of leaf.path) {
      if (typeof segment === 'number') {
        if (!Array.isArray(node) || segment >= node.length) return false;
        node = node[segment];
        continue;
      }
      if (node === null || typeof node !== 'object' || Array.isArray(node)) return false;
      if (!Object.prototype.hasOwnProperty.call(node, segment)) return false;
      node = (node as Record<string, unknown>)[segment];
    }
    // A value-arm leaf is a string and compares strictly; a POSITIONAL leaf
    // (a `Number`, a list, a short value; go-to-k/cdkd#4043) compares by
    // key-order-free JSON, so `1` never equals `"1"`.
    if (typeof leaf.plaintext === 'string') {
      if (typeof node !== 'string' || node !== leaf.plaintext) return false;
    } else if (node === undefined || keyOrderFreeJson(node) !== keyOrderFreeJson(leaf.plaintext)) {
      return false;
    }
  }
  return true;
}

/**
 * Structural equality for resolved Outputs maps (issue #875).
 *
 * Output values are intrinsic-resolved primitives or nested objects/arrays
 * and key order is irrelevant. Used by the no-change deploy path to decide
 * whether an Outputs-only change (a new Export added because a downstream
 * stack now references this one, with no resource diff) must be persisted.
 */
export function outputMapsEqual(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  return deepEqualValue(a, b);
}

function deepEqualValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null) return a === b;
  if (typeof a !== typeof b) return false;
  if (typeof a !== 'object') return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => deepEqualValue(v, b[i]));
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const ak = Object.keys(ao);
  if (ak.length !== Object.keys(bo).length) return false;
  for (const k of ak) {
    if (!Object.prototype.hasOwnProperty.call(bo, k)) return false;
    if (!deepEqualValue(ao[k], bo[k])) return false;
  }
  return true;
}
