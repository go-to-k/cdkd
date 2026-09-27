import { describeAwsFailure } from '../utils/aws-failure-text.js';
import { isThrottlingError } from '../deployment/retryable-errors.js';
import { startInterruptWatch } from './interrupt-watch.js';
import { resolvedResourceTimeoutMs } from './resource-timeout-registry.js';

/** Minimal logger surface used here (avoids coupling to the full Logger type). */
type WaitLogger = { debug(message: string): void; warn(message: string): void };

/**
 * Wait, after an ACCEPTED asynchronous delete, until the resource is gone
 * (issue [#3872](https://github.com/go-to-k/cdkd/issues/3872)).
 *
 * WHY. Some services hold a resource's NAME while it sits in `DELETING` and
 * refuse a create of that name with the same text they return for a LIVE
 * resource (Kinesis `DeleteStream`, Firehose `DeleteDeliveryStream`), so no
 * message pattern can make the create retryable. Returning from `delete()`
 * the moment the call is accepted hands every consumer that window — a
 * `destroy` followed by a `deploy`, and the delete-then-create replacement.
 * CloudFormation reports a delete complete only once the resource is gone;
 * waiting here closes the window at its source.
 *
 * CONTRACT. Every exit RETURNS — none throws — because the delete has already
 * been ACCEPTED and completes on AWS's side whatever cdkd does next: throwing
 * would turn an accepted delete into a reported FAILURE with the state record
 * kept, and the re-run would find nothing to delete. The non-gone exits
 * (timeout, interrupt, an unreadable status) warn instead, and leave exactly
 * the pre-#3872 behaviour: the delete is reported done while the name may
 * still be held for a little longer.
 *  - `describe()` resolving `undefined` means GONE (the caller maps its
 *    service's not-found error to it); any string is the still-present status.
 *  - A THROTTLED describe keeps polling — a destroy deleting many streams at
 *    once must not forfeit the wait to its own concurrency.
 *  - Any other describe failure (e.g. a least-privilege caller without the
 *    describe permission) stops watching with a warning: the permission the
 *    DELETE needed is not the one the wait needs, and lacking the latter must
 *    not fail a delete that succeeded.
 *
 * BOUNDED BY THE PER-RESOURCE DEADLINE. `withResourceDeadline` wraps the whole
 * `delete()` and does not cancel what it wraps, so the wait must stop itself
 * first. `maxWaitMs` (the caller's own cap) sits well under the default 30-min
 * deadline; an EXPLICIT `--resource-timeout` for the type (or the global one)
 * lowers the cap to half of it, leaving the other half for the delete call and
 * the last poll.
 */
export async function waitForGoneAfterDelete(opts: {
  /** Human-readable subject for log lines, e.g. `Kinesis stream my-stream`. */
  what: string;
  resourceType: string;
  /** Resolves the still-present status, or `undefined` once the resource is gone. */
  describe: () => Promise<string | undefined>;
  logger: WaitLogger;
  pollIntervalMs: number;
  maxWaitMs: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}): Promise<void> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;
  const userTimeoutMs = resolvedResourceTimeoutMs(opts.resourceType);
  const maxWaitMs =
    userTimeoutMs === undefined ? opts.maxWaitMs : Math.min(opts.maxWaitMs, userTimeoutMs / 2);
  const startedAt = now();
  const stopped = `${opts.what}: the delete was ACCEPTED by AWS, but cdkd stopped waiting for it to disappear`;
  const consequence =
    'AWS finishes the delete on its side; until it does, a create of the same name is refused ' +
    'with "already exists".';

  // Per-WAIT, never on the provider: providers are singletons serving
  // concurrent resources (interrupt-watch.ts, property 1).
  const watch = startInterruptWatch(`${opts.what} deletion wait`);
  try {
    let lastStatus: string | undefined;
    for (;;) {
      if (watch.isInterrupted()) {
        opts.logger.warn(`${stopped} (interrupted). ${consequence}`);
        return;
      }
      try {
        const status = await opts.describe();
        if (status === undefined) {
          opts.logger.debug(`${opts.what} is gone`);
          return;
        }
        lastStatus = status;
        opts.logger.debug(`${opts.what} status: ${status}, waiting for it to disappear`);
      } catch (error) {
        if (!isThrottlingError(error)) {
          opts.logger.warn(
            `${stopped}: its status could not be read (${describeAwsFailure(error).summary}). ` +
              consequence
          );
          return;
        }
        opts.logger.debug(`${opts.what}: status read throttled, re-polling`);
      }
      const remainingMs = maxWaitMs - (now() - startedAt);
      if (remainingMs <= 0) {
        opts.logger.warn(
          `${stopped} after ${Math.round(maxWaitMs / 1000)}s` +
            `${lastStatus !== undefined ? ` (last status: ${lastStatus})` : ''}. ${consequence}`
        );
        return;
      }
      await sleep(Math.min(opts.pollIntervalMs, remainingMs));
    }
  } finally {
    watch.dispose();
  }
}
