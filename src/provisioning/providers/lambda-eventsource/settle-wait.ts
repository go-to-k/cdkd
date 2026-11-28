import {
  GetEventSourceMappingCommand,
  ResourceNotFoundException,
  type LambdaClient,
} from '@aws-sdk/client-lambda';
import { describeAwsStatusReason, verboseAwareText } from '../../../utils/aws-failure-text.js';
import { startInterruptWatch } from '../../interrupt-watch.js';
import {
  isThrottlingError,
  isTransientServerError,
  markNonRetryable,
} from '../../../deployment/retryable-errors.js';
import { enclosingDeadlineRemainingMs } from '../../../deployment/resource-deadline.js';
import type { MaskedLogSinks } from '../../masked-retry-logger.js';

/** States a mapping passes through on its own after a create or an update. */
const SETTLING_STATES: ReadonlySet<string> = new Set([
  'Creating',
  'Updating',
  'Enabling',
  'Disabling',
]);

/**
 * `GetEventSourceMapping` every second, for up to 30 minutes. Only an SQS
 * mapping was measured (~17 s); a Kafka, MQ or DocumentDB mapping can stay
 * `Creating` for minutes (unmeasured), so the cap is the default resource
 * timeout's, and `--resource-timeout` bounds it below that.
 */
export const MAPPING_SETTLE_POLL_MS = 1000;
export const MAPPING_SETTLE_POLLS = 1800;
/**
 * Reads right after an update that may still show the state from before it
 * before the wait reads that state as the result.
 */
export const MAPPING_STALE_READ_GRACE_POLLS = 5;

export interface MappingSettleOptions {
  /**
   * Polls a settled state opposite to the expected one is read as stale; 0
   * after a create, which has no earlier state to read back.
   */
  readonly staleReadGracePolls?: number;
  /**
   * The state the create / update call answered (`Creating`, `Updating`).
   * While it is a settling state, a settled read before any settling read is
   * taken as the state from before the call for the grace polls.
   */
  readonly answeredState?: string;
  /**
   * Polls a `ResourceNotFoundException` is read as a mapping not yet visible
   * (after a create); 0 ends the wait on the first one.
   */
  readonly notFoundGracePolls?: number;
  /** Overrides for tests. */
  readonly pollMs?: number;
  readonly maxPolls?: number;
}

/**
 * After `CreateEventSourceMapping` / `UpdateEventSourceMapping`: wait until
 * the mapping leaves `Creating` / `Updating` / `Enabling` / `Disabling`
 * (go-to-k/cdkd#7132). CloudFormation's create and update complete only
 * once it has (measured us-east-1: an SQS mapping's `CREATE_COMPLETE` 1.2 s
 * after it read `Enabled`, 17 s after `Creating`; an update's
 * `UPDATE_COMPLETE` 2.2 s after it read `Enabled` again), and returning
 * earlier read the drift baseline off a transitional state (#5737).
 *
 * `expectedEnabled` is what the call asked for (`undefined` when an update
 * sent no `Enabled`, which accepts either settled state). A mapping that
 * settles opposite to it (Lambda settles an MQ / Kafka / DocumentDB mapping it
 * cannot poll `Disabled` with a `PROBLEM:` reason) WARNS and returns, as
 * before #7132: whether CloudFormation fails there is unmeasured, so no new
 * failure is introduced. One that reads `Deleting` or any state Lambda adds
 * later fails with Lambda's `StateTransitionReason`. After an update, the
 * opposite settled state is first read as a stale read for
 * {@link MAPPING_STALE_READ_GRACE_POLLS} polls.
 *
 * Performance gave way to CloudFormation parity here, by maintainer decision
 * on PR #7157 (AGENTS.md design principles): the default deploy spends the
 * ~15 s per mapping created or updated that CloudFormation spends, because
 * returning earlier left a refused mapping deployed with exit 0 and the
 * baseline read off `Creating`. `--no-wait` (`CDKD_NO_WAIT=true`) skips the
 * wait, as it skips the ECS and Auto Scaling stabilizations, and keeps the
 * old early return.
 *
 * Bounded by its poll cap and the enclosing per-resource deadline
 * (`--resource-timeout`), and Ctrl-C-aware. Running out of either throws a
 * non-retryable error: the change is not confirmed, never reported as
 * applied. AWS's reason can name the account, so it goes to debug only
 * (go-to-k/cdkd#2319).
 */
export async function waitForMappingSettled(
  client: LambdaClient,
  logicalId: string,
  uuid: string,
  expectedEnabled: boolean | undefined,
  log: MaskedLogSinks,
  opts: MappingSettleOptions = {}
): Promise<void> {
  const pollMs = opts.pollMs ?? MAPPING_SETTLE_POLL_MS;
  const maxPolls = opts.maxPolls ?? MAPPING_SETTLE_POLLS;
  const gracePolls = opts.staleReadGracePolls ?? MAPPING_STALE_READ_GRACE_POLLS;
  const notFoundGracePolls = opts.notFoundGracePolls ?? 0;
  // A settled read only counts once the mapping was seen settling, when the
  // call itself answered a settling state: before that it can be the state
  // from before the call (bounded by the grace).
  let seenSettling = opts.answeredState === undefined || !SETTLING_STATES.has(opts.answeredState);
  const expected =
    expectedEnabled === undefined ? undefined : expectedEnabled ? 'Enabled' : 'Disabled';
  const what = `event source mapping ${logicalId} to settle`;
  if (process.env['CDKD_NO_WAIT'] === 'true') {
    log.debug(`Skipping the wait for ${what} (CDKD_NO_WAIT=true)`);
    return;
  }
  const watch = startInterruptWatch(log.mask(what));
  let last: string | undefined;
  try {
    for (let poll = 1; poll <= maxPolls; poll++) {
      if (watch.isInterrupted()) throw watch.onInterrupted();
      // The engine's deadline does not cancel this call chain, so a wait that
      // outlived it would keep polling with nobody waiting on it.
      if (enclosingDeadlineRemainingMs() <= 0) {
        throw markNonRetryable(
          new Error(
            log.mask(
              `The resource timeout expired while waiting for ${what} (last state: ` +
                `${last ?? 'none read'}); the change is not confirmed`
            )
          )
        );
      }
      let mapping;
      try {
        mapping = await client.send(new GetEventSourceMappingCommand({ UUID: uuid }));
      } catch (error) {
        // The change was accepted: a throttled or 5xx read is one more
        // pending poll, and so is a mapping a create made that is not yet
        // visible, for the bounded grace. Any other read failure ends the wait.
        const notYetVisible =
          error instanceof ResourceNotFoundException && poll <= notFoundGracePolls;
        if (!(notYetVisible || isThrottlingError(error) || isTransientServerError(error))) {
          throw error;
        }
        log.debug(
          `A read while waiting for ${what} failed (${notYetVisible ? 'not yet visible' : 'throttled or server-side'}); reading again`
        );
      }
      const settled = (state: string): boolean => state === 'Enabled' || state === 'Disabled';
      if (mapping === undefined) {
        // still settling, as far as anyone can tell
      } else if (SETTLING_STATES.has((last = mapping.State ?? 'unknown'))) {
        seenSettling = true;
      } else if (settled(last) && !seenSettling && poll <= gracePolls) {
        // possibly the state from before the call
      } else if (settled(last) && (expected === undefined || last === expected)) {
        return;
      } else if (settled(last)) {
        if (poll <= gracePolls) {
          // possibly the state from before the call
        } else {
          const reason = describeAwsStatusReason({ message: mapping.StateTransitionReason }, '');
          if (reason.redacted) {
            log.debug(`Event source mapping ${logicalId} settled ${last}: ${reason.detail}`);
          }
          log.warn(
            `Event source mapping ${logicalId} settled ${last}, but the template asks for ` +
              `${expected}; ` +
              verboseAwareText(
                "re-run with --verbose for Lambda's reason",
                "Lambda's reason is in the debug output above"
              )
          );
          return;
        }
      } else {
        const head =
          `Event source mapping ${logicalId} settled as ${last}` +
          (expected !== undefined ? `, expected ${expected}` : '');
        const reason = describeAwsStatusReason({ message: mapping.StateTransitionReason }, '');
        if (reason.redacted) log.debug(`${head}: ${reason.detail}`);
        throw markNonRetryable(
          new Error(log.mask(reason.redacted ? `${head}. ${reason.summary}` : head))
        );
      }
      if (poll === maxPolls) break;
      await new Promise((resolve) =>
        setTimeout(resolve, Math.max(0, Math.min(pollMs, enclosingDeadlineRemainingMs())))
      );
    }
  } finally {
    watch.dispose();
  }
  throw markNonRetryable(
    new Error(
      log.mask(
        `Timed out waiting for ${what}: still ${last ?? 'none read'} after ` +
          `${(maxPolls * pollMs) / 1000} seconds; the change is not confirmed`
      )
    )
  );
}
