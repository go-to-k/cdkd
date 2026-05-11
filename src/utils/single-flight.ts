/**
 * Memoize an async cleanup function so concurrent / repeated callers
 * await the SAME underlying invocation instead of issuing parallel runs.
 *
 * Motivating use case: long-running CLI commands (`cdkd local invoke`,
 * `cdkd local start-api`, `cdkd local run-task`) wire the same cleanup
 * helper to BOTH a `process.on('SIGINT', ...)` handler AND an outer
 * `try`/`finally`. A ^C that lands during normal unwind would otherwise
 * race two cleanup runs against shared mutable state (container IDs,
 * tmpdir paths, log-stopper handles), risking double `docker rm -f` and
 * iterator-mid-mutation bugs.
 *
 * Contract:
 *
 *   - The returned function is async and resolves after the wrapped
 *     `fn` resolves (success OR throw).
 *   - The wrapped `fn` is invoked exactly once across all calls to the
 *     returned function. Every concurrent / later caller awaits that
 *     same promise.
 *   - Caller-internal per-step idempotency (e.g. `if (containerId)`
 *     guards inside `fn`) is preserved — this helper only ensures the
 *     iteration over those mutable cells doesn't race, it does NOT
 *     replace the per-step guards.
 *   - Throws inside `fn` are caught and logged via the optional
 *     `onError` callback so cleanup never masks a real handler error.
 *     The returned promise still resolves (the cleanup completed in the
 *     observable sense — we want callers to await it and exit).
 */
export function singleFlight(
  fn: () => Promise<void>,
  onError?: (err: unknown) => void
): () => Promise<void> {
  let promise: Promise<void> | undefined;
  return async (): Promise<void> => {
    if (!promise) {
      promise = (async () => {
        try {
          await fn();
        } catch (err) {
          if (onError) onError(err);
        }
      })();
    }
    await promise;
  };
}
