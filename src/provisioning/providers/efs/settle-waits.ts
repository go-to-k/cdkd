import {
  AccessPointNotFound,
  DescribeAccessPointsCommand,
  DescribeBackupPolicyCommand,
  type EFSClient,
} from '@aws-sdk/client-efs';
import { startInterruptWatch } from '../../interrupt-watch.js';
import {
  isThrottlingError,
  isTransientServerError,
  markNonRetryable,
} from '../../../deployment/retryable-errors.js';
import { enclosingDeadlineRemainingMs } from '../../../deployment/resource-deadline.js';
import type { MaskedLogSinks } from '../../masked-retry-logger.js';

/**
 * The waits after the two asynchronous EFS writes cdkd sends without one
 * (go-to-k/cdkd#7132): `CreateAccessPoint` answers `LifeCycleState: creating`
 * and `PutBackupPolicy` answers `ENABLING` / `DISABLING`. CloudFormation's
 * create and update complete only once the change has landed (measured
 * us-east-1: an access point's `CREATE_COMPLETE` after 4.7 s, reading
 * `available` right after, where cdkd's first read was `creating` 3/3; a
 * backup-policy update's `UPDATE_COMPLETE` after 5 s, reading the terminal
 * status, where cdkd's first read was the transitional one 2/2). Returning
 * earlier froze the drift baseline on the transitional value, and an access
 * point that ends `error` was never reported.
 *
 * Performance gave way to CloudFormation parity here, as for the batch-1
 * waits (maintainer decision on PR #7157): the default deploy spends the
 * 1-2 s CloudFormation spends. `--no-wait` (`CDKD_NO_WAIT=true`) skips both
 * waits and keeps the old early return.
 *
 * Each wait is bounded by its poll cap and by the enclosing per-resource
 * deadline (`--resource-timeout`), and is Ctrl-C-aware. Running out of
 * either throws: the change is not confirmed, never reported as applied. A
 * throttled or 5xx read counts as one more pending poll, since the change
 * itself was accepted; any other read failure ends the wait, unchanged. Every
 * failure the wait itself decides (a terminal status, the cap, the deadline)
 * is non-retryable: a retry would send the write again. Neither read carries
 * an AWS failure reason, so no AWS-authored text reaches a thrown message.
 */

export interface EfsSettleWaitOptions {
  /** Overrides for tests. */
  readonly pollMs?: number;
  readonly maxPolls?: number;
}

/** `DescribeAccessPoints` / `DescribeBackupPolicy` every second, for up to 5 minutes. */
export const EFS_SETTLE_POLL_MS = 1000;
export const EFS_SETTLE_POLLS = 300;
/**
 * Reads right after the call that may still show the state from before it
 * (a backup policy's old status, an access point not yet visible) before the
 * wait reads that state as the result.
 */
export const EFS_STALE_READ_GRACE_POLLS = 5;

async function pollUntilSettled<T>(
  what: string,
  log: MaskedLogSinks,
  opts: EfsSettleWaitOptions,
  read: (poll: number) => Promise<T>,
  /** `'settled'`, `'pending'`, or a failure message to throw. */
  judge: (value: T, poll: number) => 'settled' | 'pending' | Error,
  describeLast: (value: T | undefined) => string
): Promise<void> {
  const pollMs = opts.pollMs ?? EFS_SETTLE_POLL_MS;
  const maxPolls = opts.maxPolls ?? EFS_SETTLE_POLLS;
  if (process.env['CDKD_NO_WAIT'] === 'true') {
    log.debug(`Skipping the wait for ${what} (CDKD_NO_WAIT=true)`);
    return;
  }
  const watch = startInterruptWatch(log.mask(what));
  let last: T | undefined;
  try {
    for (let poll = 1; poll <= maxPolls; poll++) {
      if (watch.isInterrupted()) throw watch.onInterrupted();
      // The engine's deadline does not cancel this call chain, so a wait that
      // outlived it would keep polling with nobody waiting on it.
      if (enclosingDeadlineRemainingMs() <= 0) {
        throw markNonRetryable(
          new Error(
            log.mask(
              `The resource timeout expired while waiting for ${what} (last status: ` +
                `${describeLast(last)}); the change is not confirmed`
            )
          )
        );
      }
      let verdict: 'settled' | 'pending' | Error = 'pending';
      try {
        last = await read(poll);
        verdict = judge(last, poll);
      } catch (error) {
        if (!(isThrottlingError(error) || isTransientServerError(error))) throw error;
        log.debug(
          `A read while waiting for ${what} was throttled or failed server-side; reading again`
        );
      }
      if (verdict === 'settled') return;
      if (verdict instanceof Error) throw markNonRetryable(verdict);
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
        `Timed out waiting for ${what}: still ${describeLast(last)} after ` +
          `${(maxPolls * pollMs) / 1000} seconds; the change is not confirmed`
      )
    )
  );
}

/**
 * After `CreateAccessPoint`: wait until the access point reads `available`.
 * `creating` / `updating` are pending; `error`, `deleting`, `deleted` or any
 * state EFS adds later fail. An `AccessPointNotFound` is read as an access
 * point not yet visible for {@link EFS_STALE_READ_GRACE_POLLS} polls.
 */
export async function waitForAccessPointAvailable(
  client: EFSClient,
  logicalId: string,
  accessPointId: string,
  log: MaskedLogSinks,
  opts: EfsSettleWaitOptions = {}
): Promise<void> {
  await pollUntilSettled(
    `EFS AccessPoint ${logicalId} to read available`,
    log,
    opts,
    async (poll) => {
      try {
        const out = await client.send(
          new DescribeAccessPointsCommand({ AccessPointId: accessPointId })
        );
        return out.AccessPoints?.[0]?.LifeCycleState ?? 'absent';
      } catch (error) {
        const notFound =
          error instanceof AccessPointNotFound ||
          (error as { name?: string } | undefined)?.name === 'AccessPointNotFound';
        if (notFound && poll <= EFS_STALE_READ_GRACE_POLLS) return 'not yet visible';
        throw error;
      }
    },
    (state, poll) => {
      if (state === 'available') return 'settled';
      if (state === 'creating' || state === 'updating' || state === 'not yet visible') {
        return 'pending';
      }
      if (state === 'absent' && poll <= EFS_STALE_READ_GRACE_POLLS) return 'pending';
      return new Error(
        log.mask(
          `EFS AccessPoint ${logicalId} (${accessPointId}) settled as ${state}, expected available`
        )
      );
    },
    (state) => state ?? 'none read'
  );
}

/**
 * After `PutBackupPolicy`: wait until the policy reads the `requested`
 * status (`ENABLED` / `DISABLED`). `ENABLING` / `DISABLING` are pending. EFS
 * has no failure status for a backup policy, so only the opposite settled
 * status fails, and only after {@link EFS_STALE_READ_GRACE_POLLS} polls when
 * `PutBackupPolicy` answered a transitional status (before that it can be the
 * status from before the call); otherwise the wait times out.
 */
export async function waitForBackupPolicySettled(
  client: EFSClient,
  fileSystemId: string,
  requested: string,
  answeredStatus: string | undefined,
  log: MaskedLogSinks,
  opts: EfsSettleWaitOptions = {}
): Promise<void> {
  const transitional = (s: string | undefined): boolean => s === 'ENABLING' || s === 'DISABLING';
  // A settled read counts at once only when the call itself answered settled.
  let seenSettling = !transitional(answeredStatus);
  await pollUntilSettled(
    `the BackupPolicy on EFS FileSystem ${fileSystemId} to read ${requested}`,
    log,
    opts,
    async () =>
      (await client.send(new DescribeBackupPolicyCommand({ FileSystemId: fileSystemId })))
        .BackupPolicy?.Status,
    (status, poll) => {
      if (transitional(status)) {
        seenSettling = true;
        return 'pending';
      }
      if (status === requested && (seenSettling || poll > EFS_STALE_READ_GRACE_POLLS)) {
        return 'settled';
      }
      if (poll <= EFS_STALE_READ_GRACE_POLLS) return 'pending';
      return new Error(
        log.mask(
          `The BackupPolicy on EFS FileSystem ${fileSystemId} settled as ` +
            `${status ?? 'absent'}, expected ${requested}`
        )
      );
    },
    (status) => status ?? 'none read'
  );
}
