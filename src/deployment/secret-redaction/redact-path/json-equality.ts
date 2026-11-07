import { isPlainObject } from '../rules.js';

/**
 * Does this value carry an ORDINARY object prototype?
 *
 * `isPlainObject` answers `typeof === 'object' && !Array.isArray`, which admits
 * CLASS INSTANCES, and that is a hole under {@link deepEqualJsonValue}: an AWS
 * SDK v3 readback reaching `drainObservedCaptures` is PRE-JSON and really does
 * carry `Date` values (`LastModified`, `CreationDate`). `Object.keys(new
 * Date())` is `[]`, so without this check a `Date` compared equal to `{}` and
 * to every other `Date` -- an anchor that corroborates a pairing while proving
 * nothing. Widening `isPlainObject` itself was rejected: it is read by three
 * other walks whose behaviour would change with it, and the defect is in what
 * EQUALITY means here, not in what counts as a container.
 *
 * A `Date` anchor now corroborates NOTHING, so an element carrying one refuses
 * rather than pairs. That is the conservative direction this module always
 * takes -- the residual stays a refusal -- and it is stated because the
 * opposite reading (that a `Date` on both sides is evidence) is the one a
 * future edit will be tempted by.
 */
export function hasPlainPrototype(value: object): boolean {
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

/**
 * Is this a `Date` the value scan may return BY IDENTITY (issue
 * [#2427](https://github.com/go-to-k/cdkd/issues/2427))?
 *
 * The scan redacts what PERSISTS, and `JSON.stringify` persists an unmodified
 * `Date` as `Date.prototype.toJSON`'s ISO timestamp (or `null`) — never its own
 * entries. So the only thing to scan is that timestamp — the walk runs it
 * through the string arms and keeps the `Date` only when they leave it alone —
 * and rebuilding it just threw the timestamp away. "Unmodified" is three
 * conjuncts, each closing a shape whose persisted form is NOT that timestamp:
 * the EXACT prototype, a real `[[DateValue]]` (the `getTime` brand check, which
 * a `Proxy` or an `Object.create(Date.prototype)` fails), and NO own keys — an
 * own `toJSON` (enumerable or not) is what `JSON.stringify` would call instead.
 * No SDK readback or `JSON.parse` produces any of those; they are refused
 * because the identity return must mean exactly "persists as a timestamp".
 *
 * Deliberately NOT "any non-plain object". `JSON.stringify` persists an
 * arbitrary class instance's OWN ENUMERABLE fields, which is exactly what the
 * rebuild scans, so returning one by identity would persist a plaintext held in
 * such a field — a disclosure, traded for fidelity. A `Uint8Array` persists as
 * the same `{"0":...}` either way. The EXACT prototype (not `instanceof`) keeps
 * a `Date` subclass on the rebuild: its prototype can override `toJSON`, which
 * the rebuild drops and identity would honour. A cross-realm `Date` fails the
 * test too, which is the old flattening rather than a leak.
 */
export function isOrdinaryDate(value: object): value is Date {
  if (Object.getPrototypeOf(value) !== Date.prototype) return false;
  try {
    Date.prototype.getTime.call(value);
  } catch {
    return false;
  }
  return Reflect.ownKeys(value).length === 0;
}

/**
 * Structural equality over the JSON shapes this module walks (issue #2012).
 *
 * Own ENUMERABLE keys only, and a key count on both sides, so an inherited
 * field is not equality and neither is a bag that merely CONTAINS the source's
 * keys. That agrees with the two walks beside it -- `isUniquelyKeyedBy` and the
 * object arm of {@link refuseUncertifiedReadbackPositions} both use
 * `Object.hasOwn` -- and it matters here rather than being hygiene: this
 * predicate is the evidence an anchor pairing rests on, so a comparison that
 * reads the prototype chain would let a constructed bag corroborate a pairing
 * it does not actually match.
 *
 * `JSON.stringify` was the obvious alternative and is wrong twice over: it is
 * key-ORDER sensitive (an AWS readback routinely reorders object keys, which
 * says nothing about the values) and it silently drops `undefined`, so
 * `{A: undefined}` and `{}` would compare equal while their key counts differ.
 */
export function deepEqualJsonValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, i) => deepEqualJsonValue(item, b[i]));
  }
  if (isPlainObject(a)) {
    if (!isPlainObject(b)) return false;
    // See {@link hasPlainPrototype}: a `Date` has no own keys, so without this
    // the key-count arm below reports it equal to `{}` and to any other `Date`.
    if (!hasPlainPrototype(a) || !hasPlainPrototype(b)) return false;
    const keys = Object.keys(a);
    if (keys.length !== Object.keys(b).length) return false;
    return keys.every((k) => Object.hasOwn(b, k) && deepEqualJsonValue(a[k], b[k]));
  }
  return false;
}
