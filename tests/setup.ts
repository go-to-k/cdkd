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

const originalExit = process.exit;

// Suppress noisy test-only behavior of process.exit. Throw-on-call so any
// caller that depended on stopping execution still stops (the surrounding
// try/catch in withErrorHandling will catch it and the action's async
// wrapper's Promise rejects). Tests that genuinely want exit semantics
// install their own spy on top.
(process as unknown as { exit: (code?: number) => never }).exit = ((code?: number): never => {
  throw new Error(`__test_process_exit__:${String(code ?? 0)}`);
}) as never;

// Swallow stray unhandled rejections from Commander.parse() async actions
// that vitest doesn't await. We ONLY filter the cdkd-specific signature
// (the synthetic __test_process_exit__ marker) so genuine bugs still surface.
process.on('unhandledRejection', (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  if (msg.startsWith('__test_process_exit__:')) return;
  // Re-throw anything else so tests see real bugs.
  throw reason;
});

// Keep a reference to the real exit in case anything downstream wants it.
(globalThis as Record<string, unknown>).__cdkd_test_original_exit__ = originalExit;
