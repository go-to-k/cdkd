import type { PipesPipeProvider } from '../pipes-provider.js';
import { NotFoundException, type DescribePipeCommandOutput } from '@aws-sdk/client-pipes';
import { ProvisioningError } from '../../../utils/error-handler.js';
import { safeMsg } from '../../../utils/display-safe.js';
import { describeAwsFailure, describeAwsStatusReason } from '../../../utils/aws-failure-text.js';
import {
  isThrottlingError,
  isTransientServerError,
  markNonRetryable,
  markRedactedCause,
} from '../../../deployment/retryable-errors.js';
import type { MaskerFn } from '../../masked-retry-logger.js';
import { startInterruptWatch } from '../../interrupt-watch.js';
import { resolvedResourceTimeoutMs } from '../../resource-timeout-registry.js';
import { PIPE_POLL_INTERVAL_MS, PIPE_SETTLE_MAX_WAIT_MS, SETTLED_STATES } from './shared.js';

/**
 * Poll `DescribePipe` until the pipe rests in `RUNNING` / `STOPPED`.
 * Throws on a `*_FAILED` state (AWS's `StateReason` is where a bad role or
 * target is reported), on the cap, and on Ctrl-C. A throttled or transient
 * read, and a not-found straight after `CreatePipe` (read-after-create lag),
 * keep polling. `modifiedAt` (the `UpdatePipe` answer's `LastModifiedTime`)
 * keeps a read that still shows the state from BEFORE the update — a pipe
 * that has not yet left `RUNNING` — from counting as settled. When an update
 * has no such time to compare, a settled read counts only after a
 * non-settled read or one poll interval.
 */
export async function waitForSettled(
  this: PipesPipeProvider,
  name: string,
  logicalId: string,
  resourceType: string,
  phase: 'create' | 'update',
  mask: MaskerFn,
  modifiedAt?: Date
): Promise<DescribePipeCommandOutput> {
  const userTimeoutMs = resolvedResourceTimeoutMs(resourceType);
  const maxWaitMs =
    userTimeoutMs === undefined
      ? PIPE_SETTLE_MAX_WAIT_MS
      : Math.min(PIPE_SETTLE_MAX_WAIT_MS, userTimeoutMs / 2);
  const startedAt = this.now();
  const watch = startInterruptWatch(`Pipe ${logicalId} ${phase}`);
  const needsEvidence = phase === 'update' && modifiedAt === undefined;
  let sawUnsettled = false;
  try {
    let lastState: string | undefined;
    for (;;) {
      if (watch.isInterrupted()) throw watch.onInterrupted();
      try {
        const response = await this.describe(name);
        const state = response.CurrentState;
        lastState = state;
        const stale =
          modifiedAt !== undefined &&
          response.LastModifiedTime !== undefined &&
          response.LastModifiedTime.getTime() < modifiedAt.getTime();
        const settled = state !== undefined && SETTLED_STATES.has(state) && !stale;
        if (
          settled &&
          (!needsEvidence || sawUnsettled || this.now() - startedAt >= PIPE_POLL_INTERVAL_MS)
        ) {
          return response;
        }
        if (!settled) sawUnsettled = true;
        // A stale read shows the state from BEFORE the update, a failure
        // included, which the update may be about to clear: poll again.
        if (state !== undefined && state.endsWith('_FAILED') && !stale) {
          // AWS's `StateReason` is persisted with the thrown message, and a
          // bad role names the account (go-to-k/cdkd#2319): the message
          // carries the `--verbose` pointer, the reason goes to `debug`
          // through the masker and onto the `cause`.
          const reason = describeAwsStatusReason({ message: response.StateReason }, '');
          const build = (text: string, cause?: Error): ProvisioningError =>
            new ProvisioningError(
              `Pipe ${logicalId} ${phase} failed: AWS reports ${state}${text}`,
              resourceType,
              logicalId,
              name,
              cause
            );
          if (!reason.redacted) throw markNonRetryable(build(''));
          this.logger.debug(mask(build(`: ${mask(reason.detail)}`).message));
          throw markNonRetryable(
            markRedactedCause(build(`. ${reason.summary}`, new Error(reason.detail)))
          );
        }
        this.logger.debug(mask(`Pipe ${name} state: ${state ?? 'unknown'}, waiting to settle`));
      } catch (error) {
        if (error instanceof ProvisioningError) throw error;
        const lag = error instanceof NotFoundException && phase === 'create';
        if (!lag && !isThrottlingError(error) && !isTransientServerError(error)) throw error;
        this.logger.debug(
          safeMsg`Pipe ${logicalId}: state read failed transiently (${describeAwsFailure(error).summary}), re-polling`
        );
      }
      const remainingMs = maxWaitMs - (this.now() - startedAt);
      if (remainingMs <= 0) {
        throw markNonRetryable(
          new ProvisioningError(
            `Pipe ${logicalId} did not settle within ${Math.round(maxWaitMs / 1000)}s of its ` +
              `${phase} (last state: ${lastState ?? 'unknown'})`,
            resourceType,
            logicalId,
            name
          )
        );
      }
      await this.sleep(Math.min(PIPE_POLL_INTERVAL_MS, remainingMs));
    }
  } finally {
    watch.dispose();
  }
}
