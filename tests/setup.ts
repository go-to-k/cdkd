/// <reference types="node" />

import { vi } from 'vite-plus/test';

/**
 * Global vitest setup — defenses against Node 24 + vitest 1.6.1 surfacing
 * stray unhandled rejections from `withErrorHandling`-wrapped CLI actions.
 *
 * Background:
 *
 *   Many cdkd test files construct a Commander `Command` via a `create*Command()`
 *   factory and call `cmd.parse([...])` to exercise option parsing. Commander
 *   invokes the registered action as part of `parse()`. The action body is
 *   wrapped in `withErrorHandling`, which catches thrown errors and calls
 *   `process.exit`. Because the action is async, the rejection propagates as
 *   an unhandled rejection on the `parse()` Promise — which vitest does not
 *   await. On Node 20 / 22 the runtime swallows it silently; Node 24 surfaces
 *   it to the test runner as an "Unhandled error" annotation, failing CI.
 *
 *   Individual test files have papered over this by either stubbing the
 *   action with `cmd.action(() => {})` or spying on `process.exit`. But the
 *   unhandled rejection from one test file can bubble up while a different
 *   test file is "currently running" in the same worker, defeating per-file
 *   workarounds (vitest attributes the error to the active file, not the
 *   source).
 *
 *   Two-layer global defense:
 *
 *     1. Replace `process.exit` with a no-op throw. `withErrorHandling`'s
 *        `handleError(...)` calls `process.exit(N)`; a throwing replacement
 *        turns it into a regular synchronous throw that the surrounding
 *        async wrapper catches and turns into a Promise rejection — same
 *        outcome as a real exit from the test's perspective, but without
 *        the vitest reporter complaining about "process.exit unexpectedly
 *        called".
 *     2. `process.on('unhandledRejection', ...)` swallows the leftover
 *        rejections from Commander's `parse()` calls. Tests that genuinely
 *        want to observe rejections still `await` them locally; this
 *        handler only covers the strays.
 *
 *   Tests that explicitly assert on `process.exit` install their own
 *   `vi.spyOn(process, 'exit')` inside the test scope; `vi.spyOn` replaces
 *   the implementation atomically and `mockRestore` returns to whatever
 *   value was current — i.e. our wrapper — so the per-test spies still
 *   work as before.
 */

const originalViFn = vi.fn.bind(vi);
type MockableImplementation =
  | ((this: unknown, ...args: any[]) => any)
  | (new (...args: any[]) => any);

const isConstructable = (
  fn: MockableImplementation
): fn is new (...args: any[]) => any => {
  try {
    Reflect.construct(function () {}, [], fn);
    return true;
  } catch {
    return false;
  }
};

const wrapConstructableImplementation = (
  implementation: MockableImplementation
): MockableImplementation => {
  if (isConstructable(implementation)) {
    return implementation;
  }

  return function (this: unknown, ...args: unknown[]) {
    return implementation.apply(this, args);
  };
};

const wrapMockImplementationSetters = <T extends ReturnType<typeof originalViFn>>(mock: T): T => {
  const mockImplementation = mock.mockImplementation.bind(mock);
  type MockImplementationArg = Parameters<typeof mockImplementation>[0];
  mock.mockImplementation = ((implementation: MockImplementationArg) =>
    mockImplementation(
      wrapConstructableImplementation(implementation) as MockImplementationArg
    )) as T['mockImplementation'];

  const mockImplementationOnce = mock.mockImplementationOnce.bind(mock);
  type MockImplementationOnceArg = Parameters<typeof mockImplementationOnce>[0];
  mock.mockImplementationOnce = ((implementation: MockImplementationOnceArg) =>
    mockImplementationOnce(
      wrapConstructableImplementation(implementation) as MockImplementationOnceArg
    )) as T['mockImplementationOnce'];

  return mock;
};

vi.fn = ((implementation?: MockableImplementation) => {
  if (typeof implementation === 'function' && !isConstructable(implementation)) {
    return wrapMockImplementationSetters(
      originalViFn(wrapConstructableImplementation(implementation) as never)
    );
  }

  return wrapMockImplementationSetters(originalViFn(implementation as never));
}) as typeof vi.fn;

const originalExit = process.exit;

// Replace `process.exit` with a NO-OP. The action's async wrapper that
// calls `handleError(...)` then resumes after the supposed-fatal call,
// the wrapper's Promise resolves cleanly, and no unhandled rejection
// leaks into vitest's reporter.
//
// Why no-op instead of throw: throwing turns the exit into a rejected
// Promise (because withErrorHandling's action body is async), which
// becomes an `unhandledRejection`. We cannot reliably suppress that —
// `process.on('unhandledRejection', ...)` only ADDS a listener;
// vitest's own listener still surfaces the rejection alongside ours.
// A no-op produces no rejection at all.
//
// Tests that genuinely want exit semantics install their own per-test
// `vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error(...) })`,
// which atomically replaces this wrapper for the scope of that test.
// On `mockRestore`, vi reverts to whatever was current — i.e. this
// wrapper — so cleanup is clean.
(process as unknown as { exit: (code?: number) => never }).exit = ((_code?: number): never => {
  // no-op; original is on globalThis if anything truly needs it
  return undefined as never;
}) as never;

// Keep a reference to the real exit in case anything downstream wants it.
(globalThis as Record<string, unknown>).__cdkd_test_original_exit__ = originalExit;
