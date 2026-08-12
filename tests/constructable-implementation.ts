/**
 * Constructable-implementation helpers shared by the two `vi.fn` patches in
 * `tests/setup.ts` and `tests/once-leak-detector.ts`.
 *
 * These live in their own module because BOTH patches need them and the
 * detector cannot import from `setup.ts` (setup.ts imports the detector, so the
 * dependency would be circular).
 *
 * The reason they exist at all: `Reflect.construct(arrowFn, ...)` throws
 * `TypeError: ... is not a constructor`, so any wrapper that forwards
 * construction has to special-case a non-constructable implementation and call
 * it as an ordinary function instead. Missing that is not a theoretical
 * concern — the `*Once`-leak detector shipped it as a blocker in review: its
 * own wrapper IS a `function` declaration (hence constructable), so setup.ts's
 * guard saw a constructable value, passed it through unwrapped, and the raw
 * arrow underneath reached `Reflect.construct`. That made
 * `vp run test:once-leak` diverge behaviourally from `vp run test`.
 */

export type MockableImplementation =
  | ((this: unknown, ...args: any[]) => any)
  | (new (...args: any[]) => any);

/** Whether `fn` can legally appear as the `newTarget` of `Reflect.construct`. */
export const isConstructable = (
  fn: MockableImplementation
): fn is new (...args: any[]) => any => {
  try {
    Reflect.construct(function () {}, [], fn);
    return true;
  } catch {
    return false;
  }
};

/**
 * Return `implementation` unchanged when it is constructable, otherwise wrap it
 * in a plain `function` so `new` against it works and `this` still reaches the
 * original.
 */
export const wrapConstructableImplementation = (
  implementation: MockableImplementation
): MockableImplementation => {
  if (isConstructable(implementation)) {
    return implementation;
  }

  return function (this: unknown, ...args: unknown[]) {
    return implementation.apply(this, args);
  };
};

/**
 * Invoke `implementation` as a constructor on behalf of a wrapper that was
 * itself reached via `new`.
 *
 * `self` is the wrapper's own `this` — already a fresh object carrying the
 * right prototype, because the caller reached the wrapper through
 * `Reflect.construct`. A non-constructable implementation is applied to that
 * object rather than constructed, which is exactly what
 * `wrapConstructableImplementation` would have produced had it been allowed to
 * wrap the implementation directly.
 */
export const constructImplementation = (
  implementation: MockableImplementation,
  self: unknown,
  args: unknown[],
  // `new.target` inside a `function` declaration widens to the function's own
  // type rather than `NewableFunction`, so this stays `unknown` and is narrowed
  // at the call below.
  newTarget: unknown
): unknown => {
  if (isConstructable(implementation)) {
    return Reflect.construct(implementation, args, newTarget as NewableFunction);
  }

  return (implementation as (this: unknown, ...a: unknown[]) => unknown).apply(self, args);
};
