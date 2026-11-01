import type { Logger } from '../../types/config.js';
import { safeMsg } from '../../utils/display-safe.js';
import {
  isFinalSnapshotNotAvailableRefusal,
  isProceedDbStatus,
  isTerminalDbWaitStatus,
} from './deletion-protection-compensation.js';

/**
 * Issue #5194: the longest an RDS-family instance update waits, across every
 * retry, for an instance AWS refused as not `available` to return to it.
 * The same bound the providers' own instance waits use.
 */
export const INSTANCE_MODIFY_RETRY_WAIT_MS = 30 * 60_000;

/** Budget kept back from the enclosing resource deadline for the last call. */
const DEADLINE_MARGIN_MS = 30_000;

/**
 * Whether `error` is AWS refusing a `ModifyDBInstance` because the instance,
 * or the cluster it belongs to, is not `available` ("Database instance is not
 * in available state."). Read off the RAW SDK error: the class alone is not
 * enough, since the same fault carries refusals no wait ends. The wording is
 * the one {@link isFinalSnapshotNotAvailableRefusal} matches, so both stay one
 * match.
 */
export function isModifyNotAvailableRefusal(error: unknown): boolean {
  return (
    isFinalSnapshotNotAvailableRefusal(error, 'InvalidDBInstanceStateFault') ||
    isFinalSnapshotNotAvailableRefusal(error, 'InvalidDBClusterStateFault')
  );
}

/** What {@link modifyDbInstanceWhenAvailable} needs from an RDS-family provider. */
export interface InstanceModifyRetryOptions {
  /** Sends the `ModifyDBInstance` once; throws AWS's error as-is. */
  readonly send: () => Promise<unknown>;
  /** The instance's current `DBInstanceStatus`; `undefined` when the describe is empty. */
  readonly readStatus: () => Promise<string | undefined>;
  readonly sleep: (ms: number) => Promise<void>;
  readonly logger: Logger;
  /** The debug-line label, e.g. `Neptune DBInstance`. */
  readonly label: string;
  /** What a failure calls the resource: `instance` unless the caller is a cluster call. */
  readonly subject?: 'instance' | 'cluster';
  /**
   * Which refusal is waited out: {@link isModifyNotAvailableRefusal} unless a
   * call words its own. Such a refusal need not mean the status is anything but
   * `available`, so running out of budget then reports the last status read.
   */
  readonly isRefusal?: (error: unknown) => boolean;
  readonly logicalId: string;
  /** What the engine's per-resource deadline leaves (`enclosingDeadlineRemainingMs()`). */
  readonly remainingMs: number;
  readonly maxWaitMs?: number;
}

/**
 * Issue #5194: send an instance's `ModifyDBInstance`, and when AWS refuses it
 * because the instance is not `available`, wait for it to read `available`
 * again and resend. A cluster update in the same deploy (a changed
 * `VpcSecurityGroupIds`, ...) moves each member instance to `modifying` a
 * moment after the cluster's own update returns, so the member's update can
 * be refused; CloudFormation lets the cluster's change settle first. The
 * cluster update's member wait cannot close this alone: a member still reading
 * `available` before its modification shows up looks settled.
 *
 * Only that refusal ({@link isModifyNotAvailableRefusal}) is retried, so a
 * modify AWS answered with success is never resent, and an ordinary update
 * makes no call beyond the one `ModifyDBInstance`. A request the SDK's own
 * retry replayed after a lost response (a 5xx or socket timeout on an accepted
 * attempt) can be refused that way and is then resent once with the same
 * values, reaching the same end state. Between retries every transitional
 * status is waited out (`isProceedDbStatus` ends the wait); a TERMINAL one
 * (`isTerminalDbWaitStatus`) fails at once, since no wait ends it. Each retry first
 * sleeps, as the readback can lag the state AWS refused on. The wait and every
 * retry share one budget: {@link INSTANCE_MODIFY_RETRY_WAIT_MS}, or what the
 * resource deadline leaves minus a margin, whichever is less. A describe
 * failure (a gone instance's `DBInstanceNotFoundFault`) propagates as-is.
 *
 * A refusal naming the CLUSTER (`InvalidDBClusterStateFault`) is waited out on
 * the instance's status too: while the instance reads `available` the modify is
 * resent about every 10 seconds until the cluster settles, within the same
 * budget. The cluster's own update has normally waited for it already.
 */
export async function modifyDbInstanceWhenAvailable(
  opts: InstanceModifyRetryOptions
): Promise<void> {
  const noun = opts.subject ?? 'instance';
  const capMs = opts.maxWaitMs ?? INSTANCE_MODIFY_RETRY_WAIT_MS;
  const deadlineBound = opts.remainingMs - DEADLINE_MARGIN_MS < capMs;
  const budgetMs = deadlineBound ? opts.remainingMs - DEADLINE_MARGIN_MS : capMs;
  const startTime = Date.now();
  let delay = 5_000;
  let refusals = 0;
  let lastStatus: string | undefined;
  for (;;) {
    try {
      await opts.send();
      return;
    } catch (error) {
      if (!(opts.isRefusal ?? isModifyNotAvailableRefusal)(error)) throw error;
      const subject =
        noun === 'cluster'
          ? 'the cluster is'
          : (error as Error).name === 'InvalidDBClusterStateFault'
            ? 'the instance or its cluster is'
            : 'the instance is';
      refusals += 1;
      opts.logger.debug(
        safeMsg`${opts.label} ${opts.logicalId}: update refused as not 'available' (refusal ${String(refusals)}); waiting for it to return to 'available' before retrying`
      );
      for (;;) {
        if (Date.now() - startTime + delay >= budgetMs) {
          if (opts.isRefusal !== undefined) {
            throw new Error(
              `AWS kept refusing the update as the ${noun} being busy, and cdkd stopped retrying after ${String(refusals)} ${refusals === 1 ? 'refusal' : 'refusals'}; it last read status '${lastStatus ?? 'unknown'}'. Re-run the deploy once the ${noun} has settled${deadlineBound ? ', or with a longer --resource-timeout' : ''}`,
              { cause: error }
            );
          }
          throw new Error(
            deadlineBound
              ? `AWS refused the update because ${subject} not in the 'available' state, and the resource timeout leaves no more time to wait for it; re-run the deploy once the ${noun} is 'available', or with a longer --resource-timeout`
              : `AWS refused the update because ${subject} not in the 'available' state, and it did not return to 'available' within ${String(Math.max(1, Math.round(capMs / 60_000)))} minutes; re-run the deploy once the ${noun} is 'available'`,
            { cause: error }
          );
        }
        await opts.sleep(delay);
        delay = Math.min(delay * 2, 10_000);
        const status = await opts.readStatus();
        lastStatus = status;
        if (status === undefined || isProceedDbStatus(status)) break;
        if (isTerminalDbWaitStatus(status)) {
          throw new Error(
            `AWS refused the update because ${subject} not in the 'available' state, and it reads status '${status}', which does not end on its own; re-run the deploy once the ${noun} is 'available'`,
            { cause: error }
          );
        }
      }
    }
  }
}
