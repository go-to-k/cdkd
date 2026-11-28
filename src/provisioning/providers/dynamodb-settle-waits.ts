import {
  DescribeContributorInsightsCommand,
  DescribeKinesisStreamingDestinationCommand,
  type DynamoDBClient,
  type KinesisDataStreamDestination,
} from '@aws-sdk/client-dynamodb';
import { describeAwsStatusReason } from '../../utils/aws-failure-text.js';
import { startInterruptWatch } from '../interrupt-watch.js';
import {
  isThrottlingError,
  isTransientServerError,
  markNonRetryable,
} from '../../deployment/retryable-errors.js';
import { enclosingDeadlineRemainingMs } from '../../deployment/resource-deadline.js';
import type { SecretMasker } from '../../types/resource.js';

/**
 * The waits after the two asynchronous DynamoDB toggles that
 * `AWS::DynamoDB::Table` and `AWS::DynamoDB::GlobalTable` both send
 * (go-to-k/cdkd#7132): `UpdateContributorInsights` answers `ENABLING` /
 * `DISABLING`, and `EnableKinesisStreamingDestination` answers `ENABLING`.
 * The GlobalTable path's `UpdateKinesisStreamingDestination` waits here too
 * ({@link waitForKinesisPrecisionSettled}).
 * CloudFormation's create and update complete only once the change has
 * landed (measured us-east-1: a table's `UPDATE_COMPLETE` 9 s after
 * Contributor Insights read `ENABLED`, its `CREATE_COMPLETE` 5 s after the
 * Kinesis destination read `ACTIVE`), so the default deploy waits too: a
 * terminal failure here is the resource's own failure, and returning earlier
 * froze the drift baseline on the transitional state (#6778).
 *
 * Performance gave way to CloudFormation parity here, by maintainer decision
 * on PR #7157 (AGENTS.md design principles): the default deploy spends the
 * 15-20 s per Kinesis destination and 1-2 s per toggle CloudFormation spends,
 * because the early return deployed a refused change with exit 0.
 * `--no-wait` (`CDKD_NO_WAIT=true`) skips both waits, as it skips the ECS
 * and Auto Scaling stabilizations, and keeps the old early return.
 *
 * Each wait is bounded by its poll cap and by the enclosing per-resource
 * deadline (`--resource-timeout`), and is Ctrl-C-aware. Running out of
 * either throws: the change is not confirmed, never reported as applied.
 * A throttled or 5xx read counts as one more pending poll, since the change
 * itself was accepted; any other read failure ends the wait, unchanged. Every failure the wait
 * itself decides (a terminal status, the cap, the deadline) is non-retryable:
 * a retry would send the toggle again.
 * AWS's failure text can name the account, so it goes to debug only and the
 * thrown message carries the `--verbose` pointer (go-to-k/cdkd#2319).
 */

export interface DynamoDBSettleWaitOptions {
  readonly maskSecrets: SecretMasker;
  /** Where AWS's unredacted failure text goes. */
  readonly debug: (message: string) => void;
  /** Overrides for tests. */
  readonly pollMs?: number;
  readonly maxPolls?: number;
}

/** Options of {@link waitForContributorInsightsSettled}. */
export interface ContributorInsightsSettleOptions extends DynamoDBSettleWaitOptions {
  /**
   * The status `UpdateContributorInsights` answered. While it is `ENABLING` /
   * `DISABLING`, the expected status read before any settling read can be
   * the status from before the call (a `Mode` change on an enabled table),
   * so it counts only after the grace polls.
   */
  readonly answeredStatus?: string;
}

/** `DescribeContributorInsights` is re-read every second, for up to 5 minutes. */
export const CONTRIBUTOR_INSIGHTS_SETTLE_POLL_MS = 1000;
export const CONTRIBUTOR_INSIGHTS_SETTLE_POLLS = 300;
/** `DescribeKinesisStreamingDestination` every 2 s, for up to 10 minutes. */
export const KINESIS_ENABLE_SETTLE_POLL_MS = 2000;
export const KINESIS_ENABLE_SETTLE_POLLS = 300;
/**
 * Reads right after the call that may still show the state from before it
 * (the old setting, or a lingering history entry) before the wait reads that
 * state as the result.
 */
export const SETTLE_STALE_READ_GRACE_POLLS = 5;

async function pollUntilSettled<T>(
  what: string,
  opts: DynamoDBSettleWaitOptions,
  defaults: {
    pollMs: number;
    maxPolls: number;
    runsUnderNoWait?: boolean;
    /**
     * A wait BEFORE the change is sent: its cap and deadline say the change
     * was NOT sent, and the cap stays retryable, since a retry sends nothing
     * twice.
     */
    beforeSend?: boolean;
  },
  read: () => Promise<T>,
  /** `'settled'`, `'pending'`, or a failure message to throw. */
  judge: (value: T, poll: number) => 'settled' | 'pending' | Error,
  describeLast: (value: T | undefined) => string
): Promise<void> {
  const { maskSecrets } = opts;
  const pollMs = opts.pollMs ?? defaults.pollMs;
  const maxPolls = opts.maxPolls ?? defaults.maxPolls;
  if (process.env['CDKD_NO_WAIT'] === 'true' && defaults.runsUnderNoWait !== true) {
    opts.debug(maskSecrets(`Skipping the wait for ${what} (CDKD_NO_WAIT=true)`));
    return;
  }
  const outcome =
    defaults.beforeSend === true ? 'the change was NOT sent' : 'the change is not confirmed';
  const watch = startInterruptWatch(maskSecrets(what));
  let last: T | undefined;
  try {
    for (let poll = 1; poll <= maxPolls; poll++) {
      if (watch.isInterrupted()) throw watch.onInterrupted();
      // The engine's deadline does not cancel this call chain, so a wait that
      // outlived it would keep polling with nobody waiting on it.
      if (enclosingDeadlineRemainingMs() <= 0) {
        throw markNonRetryable(
          new Error(
            maskSecrets(
              `The resource timeout expired while waiting for ${what} (last status: ` +
                `${describeLast(last)}); ${outcome}`
            )
          )
        );
      }
      let verdict: 'settled' | 'pending' | Error = 'pending';
      try {
        last = await read();
        verdict = judge(last, poll);
      } catch (error) {
        if (!(isThrottlingError(error) || isTransientServerError(error))) throw error;
        opts.debug(
          maskSecrets(
            `A read while waiting for ${what} was throttled or failed server-side; reading again`
          )
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
  const timedOut = new Error(
    maskSecrets(
      `Timed out waiting for ${what}: still ${describeLast(last)} after ` +
        `${(maxPolls * pollMs) / 1000} seconds; ${outcome}`
    )
  );
  throw defaults.beforeSend === true ? timedOut : markNonRetryable(timedOut);
}

/** A failure whose AWS reason goes to debug, with the `--verbose` pointer thrown. */
function settledFailure(
  head: string,
  reason: { code?: string | undefined; message?: string | undefined },
  opts: DynamoDBSettleWaitOptions
): Error {
  const text = describeAwsStatusReason(reason, '');
  if (text.redacted) opts.debug(opts.maskSecrets(`${head}: ${text.detail}`));
  return new Error(opts.maskSecrets(text.redacted ? `${head}. ${text.summary}` : head));
}

/**
 * After `UpdateContributorInsights`: wait until the table's (or, with
 * `indexName`, the index's) status reads `ENABLED` for an `ENABLE` and
 * `DISABLED` for a `DISABLE`. `FAILED` fails with AWS's `FailureException`.
 * `FAILED` (an earlier attempt's) and the opposite settled status are read as
 * stale reads for {@link SETTLE_STALE_READ_GRACE_POLLS} polls first.
 */
export async function waitForContributorInsightsSettled(
  client: DynamoDBClient,
  tableName: string,
  indexName: string | undefined,
  action: string,
  target: string,
  opts: ContributorInsightsSettleOptions
): Promise<void> {
  const expected = action === 'DISABLE' ? 'DISABLED' : 'ENABLED';
  const transitional = (s: string | undefined): boolean => s === 'ENABLING' || s === 'DISABLING';
  let seenSettling = !transitional(opts.answeredStatus);
  await pollUntilSettled(
    `Contributor Insights on ${target} to read ${expected}`,
    opts,
    { pollMs: CONTRIBUTOR_INSIGHTS_SETTLE_POLL_MS, maxPolls: CONTRIBUTOR_INSIGHTS_SETTLE_POLLS },
    () =>
      client.send(
        new DescribeContributorInsightsCommand({
          TableName: tableName,
          ...(indexName !== undefined ? { IndexName: indexName } : {}),
        })
      ),
    (out, poll) => {
      const status = out.ContributorInsightsStatus;
      if (transitional(status)) {
        seenSettling = true;
        return 'pending';
      }
      if (status === expected && (seenSettling || poll > SETTLE_STALE_READ_GRACE_POLLS)) {
        return 'settled';
      }
      if (poll <= SETTLE_STALE_READ_GRACE_POLLS) return 'pending';
      if (status === 'FAILED') {
        return settledFailure(
          `Contributor Insights on ${target} failed (status FAILED, expected ${expected})`,
          {
            code: out.FailureException?.ExceptionName,
            message: out.FailureException?.ExceptionDescription,
          },
          opts
        );
      }
      return new Error(
        opts.maskSecrets(
          `Contributor Insights on ${target} settled as ${status ?? 'unknown'}, expected ${expected}`
        )
      );
    },
    (out) => out?.ContributorInsightsStatus ?? 'none read'
  );
}

/** The destination for `streamArn` the wait judges: a live entry over a history one. */
function currentDestination(
  destinations: readonly KinesisDataStreamDestination[],
  streamArn: string
): KinesisDataStreamDestination | undefined {
  const matching = destinations.filter((d) => d.StreamArn === streamArn);
  return (
    matching.find((d) => ['ACTIVE', 'ENABLING', 'UPDATING'].includes(d.DestinationStatus ?? '')) ??
    matching.find((d) => d.DestinationStatus === 'ENABLE_FAILED') ??
    matching[0]
  );
}

/**
 * After `EnableKinesisStreamingDestination`: wait until the destination for
 * `streamArn` reads `ACTIVE`. `ENABLE_FAILED` fails with AWS's
 * `DestinationStatusDescription`; it, an absent destination or a `DISABLED`
 * one is read as a stale read (a history entry lingers beside a re-enabled
 * one) for {@link SETTLE_STALE_READ_GRACE_POLLS} polls first.
 */
export async function waitForKinesisEnableActive(
  client: DynamoDBClient,
  tableName: string,
  streamArn: string,
  target: string,
  opts: DynamoDBSettleWaitOptions
): Promise<void> {
  await pollUntilSettled(
    `Kinesis streaming destination ${streamArn} on ${target} to read ACTIVE`,
    opts,
    { pollMs: KINESIS_ENABLE_SETTLE_POLL_MS, maxPolls: KINESIS_ENABLE_SETTLE_POLLS },
    async () =>
      currentDestination(
        (
          await client.send(
            new DescribeKinesisStreamingDestinationCommand({ TableName: tableName })
          )
        ).KinesisDataStreamDestinations ?? [],
        streamArn
      ),
    (dest, poll) => {
      const status = dest?.DestinationStatus;
      if (status === 'ACTIVE') return 'settled';
      if (status === 'ENABLING' || status === 'UPDATING') return 'pending';
      if (poll <= SETTLE_STALE_READ_GRACE_POLLS) return 'pending';
      return settledFailure(
        `Kinesis streaming destination ${streamArn} on ${target} settled as ` +
          `${status ?? 'absent'}, expected ACTIVE`,
        { message: dest?.DestinationStatusDescription },
        opts
      );
    },
    (dest) => dest?.DestinationStatus ?? 'absent'
  );
}

/**
 * After `UpdateKinesisStreamingDestination` (an
 * `ApproximateCreationDateTimePrecision` change): wait until the destination
 * for `streamArn` reads `ACTIVE` at `precision`. AWS holds it `UPDATING` for
 * minutes and refuses another update meanwhile ("Updates are only allowed in
 * ACTIVE state"); CloudFormation's update completes only once it is `ACTIVE`
 * at the new precision (measured us-east-1: ~3 min `UPDATING`,
 * `UPDATE_COMPLETE` after 137 s). `AWS::DynamoDB::Table` waits the same way
 * in `waitForKinesisDestinationSettled`. An `ACTIVE` read at another
 * precision is read as the state from before the call, and any other status
 * (`ENABLE_FAILED`, `DISABLED`, absent) as a stale read, for
 * {@link SETTLE_STALE_READ_GRACE_POLLS} polls first; then either fails, with
 * AWS's `DestinationStatusDescription`.
 */
export async function waitForKinesisPrecisionSettled(
  client: DynamoDBClient,
  tableName: string,
  streamArn: string,
  precision: string,
  target: string,
  opts: DynamoDBSettleWaitOptions
): Promise<void> {
  await pollUntilSettled(
    `Kinesis streaming destination ${streamArn} on ${target} to read ACTIVE at ` +
      `ApproximateCreationDateTimePrecision ${precision}`,
    opts,
    { pollMs: KINESIS_ENABLE_SETTLE_POLL_MS, maxPolls: KINESIS_ENABLE_SETTLE_POLLS },
    async () =>
      currentDestination(
        (
          await client.send(
            new DescribeKinesisStreamingDestinationCommand({ TableName: tableName })
          )
        ).KinesisDataStreamDestinations ?? [],
        streamArn
      ),
    (dest, poll) => {
      const status = dest?.DestinationStatus;
      if (status === 'ACTIVE' && dest?.ApproximateCreationDateTimePrecision === precision) {
        return 'settled';
      }
      if (status === 'ENABLING' || status === 'UPDATING') return 'pending';
      if (poll <= SETTLE_STALE_READ_GRACE_POLLS) return 'pending';
      return settledFailure(
        `Kinesis streaming destination ${streamArn} on ${target} settled as ` +
          `${status ?? 'absent'} with ApproximateCreationDateTimePrecision ` +
          `${dest?.ApproximateCreationDateTimePrecision ?? 'unset'}, expected ACTIVE / ${precision}`,
        { message: dest?.DestinationStatusDescription },
        opts
      );
    },
    (dest) =>
      dest === undefined
        ? 'absent'
        : `${dest.DestinationStatus ?? 'unknown'} / ${dest.ApproximateCreationDateTimePrecision ?? 'unset'}`
  );
}

/** The pre-update wait re-reads every 2 s, for up to 5 minutes, as the Table side does. */
export const KINESIS_PRE_UPDATE_POLLS = 150;

/**
 * Before `UpdateKinesisStreamingDestination` on the GlobalTable path: wait
 * while the destination for `streamArn` reads `UPDATING` / `ENABLING`. AWS
 * refuses the update until it is `ACTIVE` ("Updates are only allowed in
 * ACTIVE state"), and a `--no-wait` deploy can leave it `UPDATING`, so this
 * wait runs under `--no-wait` too, as the Table side's pre-update wait in
 * `waitForKinesisDestinationSettled` does. Any other status ends the wait:
 * the update itself decides. The update is not sent yet, so the cap says so
 * (`the change was NOT sent`, the destination still `UPDATING`) and stays
 * retryable: a retry re-reads before it sends.
 */
export async function waitForKinesisUpdatable(
  client: DynamoDBClient,
  tableName: string,
  streamArn: string,
  target: string,
  opts: DynamoDBSettleWaitOptions
): Promise<void> {
  await pollUntilSettled(
    `Kinesis streaming destination ${streamArn} on ${target} to accept an update`,
    opts,
    {
      pollMs: KINESIS_ENABLE_SETTLE_POLL_MS,
      maxPolls: KINESIS_PRE_UPDATE_POLLS,
      runsUnderNoWait: true,
      beforeSend: true,
    },
    async () =>
      currentDestination(
        (
          await client.send(
            new DescribeKinesisStreamingDestinationCommand({ TableName: tableName })
          )
        ).KinesisDataStreamDestinations ?? [],
        streamArn
      ),
    (dest) =>
      dest?.DestinationStatus === 'UPDATING' || dest?.DestinationStatus === 'ENABLING'
        ? 'pending'
        : 'settled',
    (dest) => dest?.DestinationStatus ?? 'absent'
  );
}
