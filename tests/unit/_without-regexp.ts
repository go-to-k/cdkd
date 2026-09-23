/**
 * Run `fn` with the global `RegExp` constructor refused, for the
 * stack-pattern matcher suites (go-to-k/cdkd#3508).
 *
 * The defect those suites fence is catastrophic backtracking in a RegExp
 * COMPILED FROM THE USER'S PATTERN, and a catastrophic regex blocks the event
 * loop synchronously, so no test timeout can fire against it: a clock-based
 * bound would hang the worker on a regression rather than fail it. A pattern
 * compiled at run time has to go through the constructor, so refusing the
 * constructor makes such a matcher throw at once — while the regex LITERALS
 * the rendering helpers use (`displayIdent`) keep working, which a refusal of
 * `exec` / `test` would break. Counting the calls also catches a caller that
 * swallows the throw (the old failed-Stage attribution caught everything its
 * RegExp raised).
 */
import { vi } from 'vite-plus/test';

export const REGEXP_REFUSED = 'a RegExp was compiled';

/** Old-expansion catastrophic-backtracking shape from the #3508 issue body. */
export const PATHOLOGICAL_PATTERN = '*a*a*a*a*a*a*a*a*b';

export function withoutRegExp<T>(fn: () => T): { value: T; regexCalls: number } {
  const constructor = vi.spyOn(globalThis, 'RegExp').mockImplementation(function refuse(): never {
    // A `function`, not an arrow: the refused call is a `new RegExp(...)`, and
    // an arrow is not constructible, so the spy would throw a TypeError of
    // its own instead of this refusal.
    throw new Error(REGEXP_REFUSED);
  });
  try {
    const value = fn();
    return { value, regexCalls: constructor.mock.calls.length };
  } finally {
    constructor.mockRestore();
  }
}
