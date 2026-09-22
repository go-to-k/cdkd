/**
 * Own-key helpers for the bags that reach cdkd through `JSON.parse` — a
 * `state.json` record, a Cloud Control `Properties` document, a template — and
 * for the raw SDK readbacks compared against them.
 *
 * `JSON.parse` yields a key literally named `__proto__` as an ORDINARY own
 * data property, and every comparator / rebuild walk over such a bag has to
 * keep treating it as one. Two idioms silently do not:
 *
 * - **Rebuilding onto a `{}` literal.** `out[k] = v` with `k === '__proto__'`
 *   runs `Object.prototype`'s accessor, SETS the node's prototype and DROPS
 *   the key — on BOTH comparison sides when the walk is a canonicalizer, so a
 *   drift at that key is invisible (issue
 *   [#3121](https://github.com/go-to-k/cdkd/issues/3121)), and on the WRITE
 *   path the member vanishes from the payload (issue
 *   [#2899](https://github.com/go-to-k/cdkd/issues/2899)). Rebuild onto
 *   {@link nullPrototypeRecord} (no accessor there, so plain assignment
 *   defines an own key) or, onto an existing plain object, define the key
 *   with {@link defineOwnKey}.
 * - **`key in bag` membership.** `in` reads the prototype chain, so a key
 *   named `constructor` / `toString` answers `true` for every plain object
 *   and the recursion then walks `Object`'s function. {@link hasOwnKey} asks
 *   the bag alone; {@link ownValue} is the matching read.
 *
 * And ONE shape test every such walk needs FIRST: {@link hasPlainPrototype}.
 * A non-plain object (`Date`, `Uint8Array`, `Map`, a class instance) has no
 * own enumerable keys, so a key-walk over one FABRICATES `{}` (or an index
 * map) and any two of them compare equal. Such a value is returned by
 * IDENTITY and compared as itself.
 *
 * Extracted from `src/cli/commands/drift.ts` (issue #2899, swept by PR #3124)
 * so the analyzer-side canonicalizers (#3121) share ONE spelling rather than a
 * fourth copy. A LEAF module, deliberately, and it must stay one: a value
 * import from a module other suites `vi.mock` wholesale reds those suites
 * with a missing-export failure (which is why `secret-redaction.ts` keeps its
 * own `hasPlainPrototype` — several drift suites mock that module).
 */

/** Own-key membership: `in` reads the prototype chain, which a `JSON.parse`d bag never means. */
export function hasOwnKey(target: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(target, key);
}

/** An own-key read: `undefined` for an inherited name (`__proto__`, `constructor`, ...). */
export function ownValue(target: Record<string, unknown>, key: string): unknown {
  return hasOwnKey(target, key) ? target[key] : undefined;
}

/** An ordinary (writable, enumerable, configurable) own data property — never the prototype. */
export function defineOwnKey(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}

/**
 * Does this value carry an ORDINARY object prototype?
 *
 * `typeof v === 'object'` admits `Date` / `Map` / `Set` / `Uint8Array` / class
 * instances, whose own enumerable keys are `[]` — so a key-walk over one
 * reports "no contradiction" between two values that actually differ, and a
 * rebuild over one fabricates `{}`. A NULL prototype counts as plain: it is
 * what {@link nullPrototypeRecord} yields, and a walk must be able to re-walk
 * its own output.
 */
export function hasPlainPrototype(value: object): boolean {
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

/**
 * A fresh rebuild target with NO prototype, so `out['__proto__'] = v` defines
 * an own key instead of setting the prototype. `JSON.stringify`,
 * `Object.keys` / `entries` and `structuredClone` all read it like a plain
 * object; only `instanceof Object` and a direct `.hasOwnProperty()` method call
 * do not, and no consumer on the drift path uses either.
 *
 * The type parameter spares a caller with a narrower value type an `as` cast at
 * every call — `nullPrototypeRecord<string>()` for a logical-id-to-path index.
 * It defaults to `unknown`, so a zero-argument call is unchanged.
 */
export function nullPrototypeRecord<T = unknown>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}
