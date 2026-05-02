/**
 * Per-resource wall-clock deadline + warn timer for provider operations.
 *
 * Wraps a single provider call (CREATE / UPDATE / DELETE) so the deploy
 * engine can enforce `--resource-timeout` and `--resource-warn-after`
 * without each provider needing to plumb timeouts through itself.
 *
 * Mechanism:
 *   - A `setTimeout` fires `onWarn(elapsedMs)` once at `warnAfterMs`.
 *   - A `setTimeout` fires `onTimeout(elapsedMs)` once at `timeoutMs` and
 *     causes the wrapper's outer promise to reject with the error returned
 *     by `onTimeout`.
 *   - When the wrapped operation settles first, both timers are cleared
 *     and neither callback fires.
 *
 * Caveat: this is a `Promise.race`-style abort, not a true cancellation.
 * The underlying provider call keeps running for some additional time
 * after the timer fires — that is documented and accepted; threading
 * `AbortController` through every provider is out of scope for v1.
 */
export interface ResourceDeadlineOptions {
  /** Milliseconds after which to fire `onWarn` once. */
  warnAfterMs: number;
  /** Milliseconds after which to abort with `onTimeout`. */
  timeoutMs: number;
  /**
   * Called once when the operation has been running longer than
   * `warnAfterMs`. Receives the elapsed milliseconds (≈ `warnAfterMs`).
   * No-op default; callers typically mutate the live renderer's task
   * label and emit a `logger.warn` line.
   */
  onWarn?: (elapsedMs: number) => void;
  /**
   * Called when the operation exceeds `timeoutMs`. Must return the
   * `Error` to reject the outer promise with. Receives elapsed
   * milliseconds (≈ `timeoutMs`).
   */
  onTimeout: (elapsedMs: number) => Error;
}

/**
 * Validation error thrown synchronously when option values are nonsensical
 * (`timeoutMs <= warnAfterMs`, non-positive, NaN). Keeps the helper safe
 * to use even in tests that pass raw numbers.
 */
export class InvalidResourceDeadlineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidResourceDeadlineError';
  }
}

function validateOptions(opts: ResourceDeadlineOptions): void {
  const { warnAfterMs, timeoutMs } = opts;
  if (
    !Number.isFinite(warnAfterMs) ||
    !Number.isFinite(timeoutMs) ||
    warnAfterMs <= 0 ||
    timeoutMs <= 0
  ) {
    throw new InvalidResourceDeadlineError(
      `withResourceDeadline: warnAfterMs and timeoutMs must be positive finite numbers ` +
        `(got warnAfterMs=${warnAfterMs}, timeoutMs=${timeoutMs})`
    );
  }
  if (warnAfterMs >= timeoutMs) {
    throw new InvalidResourceDeadlineError(
      `withResourceDeadline: warnAfterMs (${warnAfterMs}ms) must be less than timeoutMs (${timeoutMs}ms)`
    );
  }
}

/**
 * Run `operation` under a wall-clock deadline.
 *
 * Resolves with the operation's result if it settles within `timeoutMs`.
 * Rejects with the result of `opts.onTimeout(elapsedMs)` otherwise. If
 * the operation throws after the timeout has already fired, the timeout
 * error wins (we never overwrite the rejection with a late provider
 * error).
 */
export async function withResourceDeadline<T>(
  operation: () => Promise<T>,
  opts: ResourceDeadlineOptions
): Promise<T> {
  validateOptions(opts);

  const startedAt = Date.now();

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let warnTimer: NodeJS.Timeout | undefined;
    let timeoutTimer: NodeJS.Timeout | undefined;

    const cleanup = (): void => {
      if (warnTimer !== undefined) clearTimeout(warnTimer);
      if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
      warnTimer = undefined;
      timeoutTimer = undefined;
    };

    if (opts.onWarn) {
      warnTimer = setTimeout(() => {
        if (settled) return;
        try {
          opts.onWarn!(Date.now() - startedAt);
        } catch {
          // onWarn is best-effort UX — never let it sink the operation.
        }
      }, opts.warnAfterMs);
      if (typeof warnTimer.unref === 'function') warnTimer.unref();
    }

    timeoutTimer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      const elapsed = Date.now() - startedAt;
      reject(opts.onTimeout(elapsed));
    }, opts.timeoutMs);
    if (typeof timeoutTimer.unref === 'function') timeoutTimer.unref();

    // Run the operation eagerly. If the timeout has already fired by the
    // time the operation settles, swallow the result silently — we have
    // already rejected the outer promise with the timeout error.
    Promise.resolve()
      .then(() => operation())
      .then(
        (value) => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve(value);
        },
        (err) => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(err);
        }
      );
  });
}
