import { AsyncLocalStorage } from 'node:async_hooks';

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
 * The timers are REF'd: while the operation is pending, the timeout is what
 * guarantees the wrapper settles, so it must keep the process alive.
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

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let timedOut = false;
    let warned = false;
    let warnTimer: NodeJS.Timeout | undefined;
    let timeoutTimer: NodeJS.Timeout | undefined;
    // The clock: time run before the current pause, plus the current run.
    let elapsedBeforePause = 0;
    let runningSince = Date.now();
    let pauses = 0;
    const elapsed = (): number => elapsedBeforePause + (pauses > 0 ? 0 : Date.now() - runningSince);

    const cleanup = (): void => {
      if (warnTimer !== undefined) clearTimeout(warnTimer);
      if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
      warnTimer = undefined;
      timeoutTimer = undefined;
    };

    // Arms both timers for what is LEFT of each budget, so a pause (an
    // operator answering a prompt inside the operation) does not count.
    const arm = (): void => {
      if (opts.onWarn && !warned) {
        warnTimer = setTimeout(
          () => {
            if (settled) return;
            warned = true;
            try {
              opts.onWarn!(elapsed());
            } catch {
              // onWarn is best-effort UX — never let it sink the operation.
            }
          },
          Math.max(0, opts.warnAfterMs - elapsed())
        );
      }
      timeoutTimer = setTimeout(
        () => {
          if (settled) return;
          settled = true;
          timedOut = true;
          cleanup();
          reject(opts.onTimeout(elapsed()));
        },
        Math.max(0, opts.timeoutMs - elapsed())
      );
    };
    arm();
    // Both timers stay REF'd (issue #3939): the caller is awaiting this
    // promise, and the timeout is its one guaranteed way to settle. Unref'd,
    // an operation stuck with nothing else holding the event loop let the
    // loop drain instead of timing out, so the process exited 0 mid-command
    // with the stack lock still held. Both are cleared the moment the
    // operation settles, so they never outlive it.

    const outer = deadlineScope.getStore();
    const control: DeadlineControl = {
      pause: () => {
        pauses += 1;
        if (pauses === 1) {
          elapsedBeforePause += Date.now() - runningSince;
          cleanup();
        }
        outer?.pause();
      },
      resume: () => {
        if (pauses === 0) return;
        pauses -= 1;
        if (pauses === 0) {
          runningSince = Date.now();
          if (!settled) arm();
        }
        outer?.resume();
      },
      expired: () => timedOut || (outer?.expired() ?? false),
    };

    // Run the operation eagerly. If the timeout has already fired by the
    // time the operation settles, swallow the result silently — we have
    // already rejected the outer promise with the timeout error.
    Promise.resolve()
      .then(() => deadlineScope.run(control, operation))
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

/** The deadline an operation runs under, as seen from inside it. */
interface DeadlineControl {
  pause(): void;
  resume(): void;
  /** Whether this deadline, or one enclosing it, has already timed out. */
  expired(): boolean;
}

const deadlineScope = new AsyncLocalStorage<DeadlineControl>();

/**
 * Stop the clock of every deadline enclosing the caller while `fn` runs — an
 * operator answering a prompt inside a provider operation (a nested stack's
 * `--require-approval` question, asked inside the parent's row). Each enclosing
 * deadline resumes with the budget it had left. Outside any deadline it just
 * runs `fn`.
 */
export async function whileEnclosingDeadlinesPaused<T>(fn: () => Promise<T>): Promise<T> {
  const control = deadlineScope.getStore();
  if (control === undefined) return fn();
  control.pause();
  try {
    return await fn();
  } finally {
    control.resume();
  }
}

/**
 * Whether a deadline enclosing the caller has already timed out. The operation
 * keeps running after its deadline fires (see the module doc), so code about to
 * start an irreversible step on its behalf asks this first.
 */
export function enclosingDeadlineExpired(): boolean {
  return deadlineScope.getStore()?.expired() ?? false;
}
