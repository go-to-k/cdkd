import { CdkdError } from './error-handler.js';

/**
 * Run `fn`, a short critical section of state writes, with SIGINT and SIGTERM
 * HELD until it finishes (go-to-k/cdkd#5212).
 *
 * Without a listener Node exits on the first SIGINT at once, skipping every
 * `finally`: a `cdkd refactor` killed between two state writes leaves a move
 * half written and its stack locks stranded. Here a signal is recorded and
 * `onDeferred` tells the operator why the process did not stop; once `fn`
 * settles the listeners are removed, and a held signal turns into an
 * `INTERRUPTED` error, so the command still stops -- after its writes, with
 * its locks released by the caller's `finally`. A second signal while held is
 * not escalated: the section is a few S3 writes, and a forced exit there is
 * exactly what this exists to prevent (SIGKILL still ends the process).
 *
 * `fn`'s own error wins over a held signal.
 */
export async function withDeferredInterrupts<T>(
  fn: () => Promise<T>,
  onDeferred: (signal: NodeJS.Signals) => void
): Promise<T> {
  let held: NodeJS.Signals | undefined;
  const hold = (signal: NodeJS.Signals): void => {
    if (held === undefined) {
      held = signal;
      onDeferred(signal);
    }
  };
  process.on('SIGINT', hold);
  process.on('SIGTERM', hold);
  let result: T;
  try {
    result = await fn();
  } finally {
    process.removeListener('SIGINT', hold);
    process.removeListener('SIGTERM', hold);
  }
  if (held !== undefined) {
    throw new CdkdError(
      `Interrupted (${held}) after the state writes finished; they are complete.`,
      'INTERRUPTED'
    );
  }
  return result;
}
