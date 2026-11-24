/**
 * Constructable-implementation helpers for the `vi.fn` patch in
 * `tests/setup.ts`.
 *
 * The reason they exist at all: `Reflect.construct(arrowFn, ...)` throws
 * `TypeError: ... is not a constructor`, so any wrapper that forwards
 * construction has to special-case a non-constructable implementation and call
 * it as an ordinary function instead.
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
