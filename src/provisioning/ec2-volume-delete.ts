import { DeleteVolumeCommand, DescribeVolumesCommand, type EC2Client } from '@aws-sdk/client-ec2';
import { ProvisioningError } from '../utils/error-handler.js';
import { markWaitAbandoned } from './wait-abandoned.js';
import { describeAwsFailure } from '../utils/aws-failure-text.js';

/** Minimal logger surface used here (avoids coupling to the full Logger type). */
type DebugLogger = { debug(message: string): void };

/**
 * Delete a Cloud-Control-routed `AWS::EC2::Volume` with EC2 `DeleteVolume`
 * instead of Cloud Control `DeleteResource` (issue
 * [#3455](https://github.com/go-to-k/cdkd/issues/3455)).
 *
 * WHY THE CLOUD CONTROL DELETE IS BYPASSED. The registry delete handler for
 * this type holds `ec2:CreateSnapshot` (it implements CloudFormation's
 * `DeletionPolicy: Snapshot` itself), and it has been observed taking that
 * snapshot on a plain Cloud Control delete, which carries no deletion policy
 * at all: CloudTrail shows a `CreateSnapshot` from `cloudformation.amazonaws.com`
 * in the same second as cdkd's `DeleteResource`, then the handler's
 * `DeleteVolume` while that snapshot was still pending. Both times it
 * happened, the volume then sat in `deleting` for well over the 15-minute
 * wait, the delete failed, and the handler's snapshot was left behind
 * untracked. What makes the handler do it is not known, so the only fix that
 * does not depend on the trigger is not to invoke the handler. The EC2 call is
 * the same one the handler makes; cdkd's own final snapshot (when the policy
 * asks for one) is taken and waited to `completed` before this runs.
 *
 * CONTRACT, matching the Cloud Control delete it replaces:
 *  - Resolves only once the volume is GONE (`InvalidVolume.NotFound`, or state
 *    `deleted`) — returning means "deleted" to every caller.
 *  - `DeleteVolume`'s own errors propagate UNCHANGED, so the caller's
 *    existing already-deleted arm (region-checked) sees `InvalidVolume.NotFound`
 *    exactly as it saw Cloud Control's `NotFound`, and every other failure
 *    takes the caller's ordinary wrap.
 *  - `IncorrectState` from `DeleteVolume` on a volume that is already
 *    `deleting`, `deleted` or gone (a re-run after an interrupted destroy, or
 *    a race with one) is waited on rather than failed. If the describe that
 *    classifies it fails, the ORIGINAL `IncorrectState` is rethrown, carrying
 *    the describe failure as its `cause`.
 *  - A TRANSIENT describe failure during the wait (a throttle, a 5xx, a
 *    socket error — `isTransientFailure`, the Cloud Control poll's own
 *    classifier) is re-polled for up to `transientGraceMs` of unbroken
 *    failures, the same grace the Cloud Control wait gives its status poll.
 *  - Every way the wait can end without seeing the volume gone — the
 *    `maxWaitMs` deadline, the grace running out, a non-transient describe
 *    failure — throws an error marked as an abandoned wait
 *    (`wait-abandoned.ts`). Every already-deleted classifier refuses that
 *    marker structurally, and they must: they match SUBSTRINGS of a message
 *    that interpolates the user's logical id (`PageNotFound` would match). So
 *    the state record is KEPT, and the error stays retryable, like a Cloud
 *    Control DELETE abandonment, because a re-issued `DeleteVolume` is
 *    idempotent.
 */
export async function deleteEc2VolumeDirect(
  client: EC2Client,
  volumeId: string,
  logicalId: string,
  opts: {
    logger: DebugLogger;
    sleep: (ms: number) => Promise<void>;
    maxWaitMs: number;
    transientGraceMs: number;
    isTransientFailure: (error: unknown) => boolean;
    now?: () => number;
  }
): Promise<void> {
  const now = opts.now ?? Date.now;
  try {
    await client.send(new DeleteVolumeCommand({ VolumeId: volumeId }));
    opts.logger.debug(`DeleteVolume accepted for ${logicalId} (${volumeId})`);
  } catch (error) {
    if (errorName(error) !== 'IncorrectState') throw error;
    let state: string | undefined;
    try {
      state = await readVolumeState(client, volumeId);
    } catch (describeError) {
      throw withCause(error, describeError);
    }
    if (!(state === undefined || state === 'deleted' || state === 'deleting')) throw error;
    opts.logger.debug(
      `${logicalId} (${volumeId}) is already ${state ?? 'gone'}; waiting for it to go`
    );
  }

  const abandoned = (reason: string, cause?: unknown) =>
    markWaitAbandoned(
      new ProvisioningError(
        `DELETE of ${logicalId} (${volumeId}) was accepted by EC2, but ${reason}. ` +
          `The state record is kept; re-run the command once the volume is gone.`,
        'AWS::EC2::Volume',
        logicalId,
        volumeId,
        cause instanceof Error ? cause : undefined
      )
    );

  const deadline = now() + opts.maxWaitMs;
  let interval = 2_000;
  let outageStartedAt: number | undefined;
  for (;;) {
    let state: string | undefined;
    let polled = false;
    try {
      state = await readVolumeState(client, volumeId);
      polled = true;
      outageStartedAt = undefined;
    } catch (pollError) {
      if (!opts.isTransientFailure(pollError)) {
        throw abandoned(
          `cdkd could not read the volume's state: ${describeAwsFailure(pollError).summary}`,
          pollError
        );
      }
      outageStartedAt ??= now();
      const outageMs = now() - outageStartedAt;
      if (outageMs >= opts.transientGraceMs) {
        throw abandoned(
          `cdkd could not read the volume's state for ${Math.round(outageMs / 1000)}s: ` +
            describeAwsFailure(pollError).summary,
          pollError
        );
      }
      opts.logger.debug(
        `Could not read ${logicalId} (${volumeId}) while waiting for its delete; ` +
          `re-polling: ${describeAwsFailure(pollError).detail}`
      );
    }
    if (polled && (state === undefined || state === 'deleted')) return;
    if (now() >= deadline) {
      throw abandoned(
        polled
          ? `the volume was still '${state}' after ${Math.round(opts.maxWaitMs / 1000)}s`
          : `cdkd could not read the volume's state before the ${Math.round(opts.maxWaitMs / 1000)}s wait ran out`
      );
    }
    if (polled) {
      opts.logger.debug(`Waiting for ${logicalId} (${volumeId}) to be deleted (state: ${state})`);
    }
    await opts.sleep(interval);
    interval = Math.min(Math.ceil(interval * 1.5), 10_000);
  }
}

/**
 * Rethrow `original` carrying `cause`, without replacing it: the caller's
 * classification (the idempotent arm, the retry classifier) must see the
 * `DeleteVolume` failure, not the describe that tried to explain it. A
 * non-extensible error, or one that already has a cause, is returned as-is.
 */
function withCause(original: unknown, cause: unknown): unknown {
  if (
    typeof original === 'object' &&
    original !== null &&
    Object.isExtensible(original) &&
    (original as { cause?: unknown }).cause === undefined
  ) {
    Object.defineProperty(original, 'cause', {
      value: cause,
      configurable: true,
      writable: true,
      enumerable: false,
    });
  }
  return original;
}

/** The volume's state, or `undefined` when EC2 reports it does not exist. */
async function readVolumeState(client: EC2Client, volumeId: string): Promise<string | undefined> {
  try {
    const described = await client.send(new DescribeVolumesCommand({ VolumeIds: [volumeId] }));
    const volume = described.Volumes?.[0];
    return volume === undefined ? undefined : (volume.State ?? 'unknown');
  } catch (error) {
    if (errorName(error) === 'InvalidVolume.NotFound') return undefined;
    throw error;
  }
}

/** The error's `name`, or `''` — never throws, whatever was rejected. */
function errorName(error: unknown): string {
  if (typeof error !== 'object' || error === null) return '';
  const name = (error as { name?: unknown }).name;
  return typeof name === 'string' ? name : '';
}
