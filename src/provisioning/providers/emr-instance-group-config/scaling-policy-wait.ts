import type { EMRInstanceGroupConfigProvider } from '../emr-instance-group-config-provider.js';
import { describeAwsStatusReason } from '../../../utils/aws-failure-text.js';
import { ProvisioningError } from '../../../utils/error-handler.js';
import { startInterruptWatch } from '../../interrupt-watch.js';
import { markNonRetryable, markRedactedCause } from '../../../deployment/retryable-errors.js';
import { enclosingDeadlineRemainingMs } from '../../../deployment/resource-deadline.js';
import { maskerOrIdentity, type MaskerFn } from '../../masked-retry-logger.js';

/** States an automatic scaling policy passes through on its own after a Put. */
const ATTACHING_STATES: ReadonlySet<string> = new Set(['PENDING', 'ATTACHING']);

/** `ListInstanceGroups` every 2 s, for up to 10 minutes. */
export const SCALING_POLICY_SETTLE_POLL_MS = 2000;
export const SCALING_POLICY_SETTLE_POLLS = 300;

/**
 * The poll cap that keeps the wait inside the provider's own `maxWaitMs`, the
 * budget an `AWS::EMR::Cluster` update hands its delegate (#7132).
 */
export function scalingPolicyWaitBudget(maxWaitMs: number): { maxPolls: number } {
  return {
    maxPolls: Math.max(
      1,
      Math.min(SCALING_POLICY_SETTLE_POLLS, Math.ceil(maxWaitMs / SCALING_POLICY_SETTLE_POLL_MS))
    ),
  };
}
/**
 * Reads right after the call that may still show the state from before it
 * (the previous policy `ATTACHED`, or no policy yet) before the wait reads
 * that state as the result.
 */
export const SCALING_POLICY_STALE_READ_GRACE_POLLS = 5;

export interface ScalingPolicySettleOptions {
  /**
   * The state `PutAutoScalingPolicy` answered (`PENDING`). While it is
   * `PENDING` / `ATTACHING`, an `ATTACHED` read before any attaching read can
   * be the previous policy's, so it counts only after the grace polls.
   * Omitted after `AddInstanceGroups`, which has no earlier policy to read.
   */
  readonly answeredState?: string;
  /** Overrides for tests. */
  readonly pollMs?: number;
  readonly maxPolls?: number;
}

/**
 * After `PutAutoScalingPolicy`, or an `AddInstanceGroups` that carried an
 * `AutoScalingPolicy`: wait until the group's policy reads `ATTACHED`
 * (go-to-k/cdkd#7132). Both answer `PENDING`, then `ATTACHING`, and
 * `ATTACHED` some 10-15 s later; CloudFormation's update completes only once
 * it has (measured us-east-1: `UPDATE_COMPLETE` after 32 s, the new
 * `MaxCapacity` read back `ATTACHED` right after), and returning earlier froze
 * the drift baseline on `PENDING`. `FAILED` fails with EMR's
 * `StateChangeReason`; `DETACHING` / `DETACHED`, an absent policy or an absent
 * group is read as a stale read for {@link SCALING_POLICY_STALE_READ_GRACE_POLLS}
 * polls first, then fails. `RemoveAutoScalingPolicy` is not waited on
 * (`DETACHING` → `DETACHED` was not measured).
 *
 * Performance gave way to CloudFormation parity here, by maintainer decision
 * on PR #7157 (AGENTS.md design principles). `--no-wait` (`CDKD_NO_WAIT=true`)
 * skips the wait and keeps the old early return.
 *
 * Bounded by its poll cap and the enclosing per-resource deadline
 * (`--resource-timeout`), and Ctrl-C-aware. A throttled or 5xx read
 * (`findGroupForPoll` absorbs those) counts as one more pending poll; any
 * other read failure ends the wait, unchanged. Every failure the wait itself
 * decides (`FAILED`, the cap, the deadline) is non-retryable: a retry would
 * send the policy again. EMR's reason can name the account, so it goes to
 * debug only and the thrown message carries the `--verbose` pointer
 * (go-to-k/cdkd#2319).
 */
export async function waitForAutoScalingPolicySettled(
  this: EMRInstanceGroupConfigProvider,
  clusterId: string,
  groupId: string,
  logicalId: string,
  resourceType: string,
  mask: MaskerFn | undefined,
  opts: ScalingPolicySettleOptions = {}
): Promise<void> {
  const m = maskerOrIdentity(mask);
  const pollMs = opts.pollMs ?? SCALING_POLICY_SETTLE_POLL_MS;
  const maxPolls = opts.maxPolls ?? SCALING_POLICY_SETTLE_POLLS;
  const what = `the automatic scaling policy of EMR instance group ${logicalId} to read ATTACHED`;
  if (process.env['CDKD_NO_WAIT'] === 'true') {
    this.logger.debug(m(`Skipping the wait for ${what} (CDKD_NO_WAIT=true)`));
    return;
  }
  const scalingPolicyFailure = (message: string, cause?: Error): ProvisioningError =>
    markNonRetryable(new ProvisioningError(m(message), resourceType, logicalId, groupId, cause));
  // An ATTACHED read only counts once the policy was seen attaching, when the
  // call itself answered an attaching state: before that it can be the
  // previous policy's (bounded by the grace).
  let seenAttaching = opts.answeredState === undefined || !ATTACHING_STATES.has(opts.answeredState);
  const transientState = { count: 0 };
  const watch = startInterruptWatch(m(what));
  let last = 'none read';
  try {
    for (let poll = 1; poll <= maxPolls; poll++) {
      if (watch.isInterrupted()) throw watch.onInterrupted();
      // The engine's deadline does not cancel this call chain, so a wait that
      // outlived it would keep polling with nobody waiting on it.
      if (enclosingDeadlineRemainingMs() <= 0) {
        throw scalingPolicyFailure(
          `The resource timeout expired while waiting for ${what} (last state: ${last}); ` +
            'the change is not confirmed'
        );
      }
      // A throttled / 5xx read comes back undefined with the count raised;
      // the cap, not findGroupForPoll's streak limit, bounds those.
      const group = await this.findGroupForPoll(clusterId, groupId, transientState, maxPolls);
      if (transientState.count === 0) {
        const status = group?.AutoScalingPolicy?.Status;
        last = group === undefined ? 'group absent' : (status?.State ?? 'no policy');
        if (status?.State !== undefined && ATTACHING_STATES.has(status.State)) {
          seenAttaching = true;
        } else if (
          status?.State === 'ATTACHED' &&
          (seenAttaching || poll > SCALING_POLICY_STALE_READ_GRACE_POLLS)
        ) {
          return;
        } else if (poll > SCALING_POLICY_STALE_READ_GRACE_POLLS) {
          const head = `The automatic scaling policy of EMR instance group ${logicalId} settled as ${last}, expected ATTACHED`;
          if (status?.State !== 'FAILED') throw scalingPolicyFailure(head);
          const reason = describeAwsStatusReason(
            { code: status.StateChangeReason?.Code, message: status.StateChangeReason?.Message },
            ''
          );
          if (!reason.redacted) throw scalingPolicyFailure(head);
          this.logger.debug(m(`${head}: ${reason.detail}`));
          const cause = new Error(reason.detail);
          throw markRedactedCause(scalingPolicyFailure(`${head}. ${reason.summary}`, cause));
        }
      }
      this.logger.debug(m(`Waiting for ${what} (state: ${last})`));
      if (poll === maxPolls) break;
      await new Promise((resolve) =>
        setTimeout(resolve, Math.max(0, Math.min(pollMs, enclosingDeadlineRemainingMs())))
      );
    }
  } finally {
    watch.dispose();
  }
  throw scalingPolicyFailure(
    `Timed out waiting for ${what}: still ${last} after ${(maxPolls * pollMs) / 1000} seconds; ` +
      'the change is not confirmed'
  );
}
