/**
 * Retry helper for resource provisioning operations that hit transient
 * AWS eventual-consistency errors (IAM propagation, Lambda Pending state,
 * dependency violations, etc.).
 *
 * Extracted from DeployEngine so the backoff schedule can be unit-tested
 * in isolation. The retryable-error classifier itself lives in
 * `./retryable-errors.ts`.
 */

import { isRetryableTransientError } from './retryable-errors.js';

export interface RetryLogger {
  debug(message: string): void;
}

export interface WithRetryOptions {
  /** Max number of retries after the first attempt. Defaults to 8. */
  maxRetries?: number;
  /**
   * Initial backoff in milliseconds. Subsequent retries double it
   * (1s -> 2s -> 4s -> ... at the default of 1_000ms).
   *
   * The default of 1_000ms is tuned for the typical AWS eventual-consistency
   * window of 2-5s (IAM trust-policy propagation, freshly-created Lambda
   * leaving Pending state). A longer initial delay (e.g. 10s) adds idle time
   * on the deploy critical path even when the underlying window is much
   * shorter.
   */
  initialDelayMs?: number;
  /**
   * Cap for the per-retry delay in milliseconds. Once the doubling schedule
   * reaches this value it stays flat instead of growing further. Defaults to
   * 8_000ms.
   *
   * Why cap: IAM propagation has a long-ish tail (occasional 20-30s waits
   * past the typical 2-5s window). Pure exponential backoff turns a single
   * stalled propagation into 16s, 32s, 64s waits — far more than the
   * underlying window. Capping at 8s lets us still poll roughly every 8s
   * once we're past the early ramp-up, recovering as soon as AWS stabilises.
   */
  maxDelayMs?: number;
  /** Optional debug logger; receives one line per retry attempt. */
  logger?: RetryLogger;
  /**
   * Optional interrupt check — invoked once per second while sleeping.
   * Throws an interrupt error (e.g. on SIGINT) to abort the retry loop early.
   */
  isInterrupted?: () => boolean;
  /** Thrown when `isInterrupted()` returns true mid-sleep. */
  onInterrupted?: () => Error;
  /** Override the sleep implementation (used by tests to skip real waits). */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run `operation`, retrying transient failures with exponential backoff
 * capped at `maxDelayMs`.
 *
 * Backoff at the defaults (initialDelayMs=1_000, maxDelayMs=8_000, maxRetries=8):
 *   1s -> 2s -> 4s -> 8s -> 8s -> 8s -> 8s -> 8s   (cumulative 47s)
 *
 * Non-retryable errors are rethrown immediately. The transient-error
 * classifier is `isRetryableTransientError` from ./retryable-errors.ts.
 */
export async function withRetry<T>(
  operation: () => Promise<T>,
  logicalId: string,
  opts: WithRetryOptions = {}
): Promise<T> {
  const maxRetries = opts.maxRetries ?? 8;
  const initialDelayMs = opts.initialDelayMs ?? 1_000;
  const maxDelayMs = opts.maxDelayMs ?? 8_000;
  const sleep = opts.sleep ?? defaultSleep;

  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);

      const retryable = isRetryableTransientError(error, message);
      if (!retryable || attempt >= maxRetries) {
        throw error;
      }

      const delay = Math.min(initialDelayMs * Math.pow(2, attempt), maxDelayMs);
      opts.logger?.debug(
        `  ⏳ Retrying ${logicalId} in ${delay / 1000}s (attempt ${attempt + 1}/${maxRetries}) - ${message}`
      );

      // Interruptible sleep: check for SIGINT every second during delay.
      for (let waited = 0; waited < delay; waited += 1000) {
        if (opts.isInterrupted?.()) {
          throw opts.onInterrupted ? opts.onInterrupted() : new Error('Interrupted');
        }
        await sleep(Math.min(1000, delay - waited));
      }
    }
  }

  throw lastError;
}
