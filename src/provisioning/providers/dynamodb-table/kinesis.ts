import {
  DescribeKinesisStreamingDestinationCommand,
  DisableKinesisStreamingDestinationCommand,
  EnableKinesisStreamingDestinationCommand,
  UpdateKinesisStreamingDestinationCommand,
  type ApproximateCreationDateTimePrecision,
  type KinesisDataStreamDestination,
} from '@aws-sdk/client-dynamodb';
import { describeAwsFailure, describeAwsStatusReason } from '../../../utils/aws-failure-text.js';
import { startInterruptWatch } from '../../interrupt-watch.js';
import { markNonRetryable } from '../../../deployment/retryable-errors.js';
import { enclosingDeadlineRemainingMs } from '../../../deployment/resource-deadline.js';
import type { SecretMasker } from '../../../types/resource.js';
import type { DynamoDBTableProvider } from '../dynamodb-table-provider.js';
import {
  KINESIS_DESTINATION_PRE_UPDATE_POLLS,
  KINESIS_DESTINATION_SETTLE_POLLS,
  KINESIS_DESTINATION_SETTLE_POLL_MS,
  KINESIS_DISABLE_PENDING_STATUSES,
  KINESIS_DISABLE_SETTLE_POLLS,
  KINESIS_DISABLE_SETTLE_POLL_MS,
  KINESIS_PRECISION_STALE_READ_GRACE_POLLS,
} from './table-helpers.js';

/**
 * Apply the table's `KinesisStreamSpecification` via the separate
 * Enable/Disable/Update `KinesisStreamingDestination` APIs (NOT a field on
 * CreateTable). CFn shape is
 * `{ StreamArn: string, ApproximateCreationDateTimePrecision?: 'MICROSECOND' | 'MILLISECOND' }`.
 *
 * Called from both `create()` (after the table is ACTIVE) and `update()`
 * (only when the value changed). On `update()`-side removal — template drops
 * the block but it was present before — streaming is disabled to the PREVIOUS
 * stream ARN. A same-ARN change of only the precision goes through
 * `UpdateKinesisStreamingDestination` (go-to-k/cdkd#5385), as CloudFormation
 * does; a REMOVED precision leaves the live one as it is, which is what
 * CloudFormation does too (measured us-east-1, 2026-10-27: a stack update
 * dropping `MILLISECOND` from the template completed with AWS still reading
 * `MILLISECOND`, while one setting `MICROSECOND` changed it in place).
 */
export async function applyKinesisStreamingDestination(
  this: DynamoDBTableProvider,
  tableName: string,
  spec: unknown,
  // REQUIRED rather than optional for the same mechanical reason as
  // `applyPointInTimeRecovery`'s (issue #3364): a required parameter cannot
  // follow an optional one. Both call sites already pass it explicitly.
  previousSpec: unknown,
  // The caller's secret masker (issue #1997). The warning below names
  // `tableName`, which on the create path IS `properties['TableName']`.
  //
  // REQUIRED, with no identity default (issue #3364) — see
  // `applyPointInTimeRecovery` for why the typechecker is the fence.
  maskSecrets: SecretMasker
): Promise<void> {
  const newArn = this.extractKinesisStreamArn(spec);
  const prevArn = this.extractKinesisStreamArn(previousSpec);

  // Same target stream ARN: enable is not idempotent against an
  // already-enabled destination, so only a precision change has anything to
  // send, and it goes through UpdateKinesisStreamingDestination.
  if (newArn === prevArn) {
    if (!newArn) return;
    const precision = this.extractKinesisPrecision(spec);
    const prevPrecision = this.extractKinesisPrecision(previousSpec);
    if (precision === prevPrecision) return;
    if (precision === undefined) {
      // Removed from the template: CloudFormation leaves the live precision
      // as it is (see the method doc), and so does cdkd.
      this.logger.debug(
        maskSecrets(
          `Kinesis streaming ApproximateCreationDateTimePrecision removed from ${tableName}; the live value is left as it is, as CloudFormation does`
        )
      );
      return;
    }
    await this.updateKinesisStreamingPrecision(tableName, newArn, precision, maskSecrets);
    return;
  }

  // Disable streaming to the previous stream when it changed or was removed.
  if (prevArn) {
    await this.retryOnTransientControlPlane(
      () =>
        this.dynamoDBClient.send(
          new DisableKinesisStreamingDestinationCommand({
            TableName: tableName,
            StreamArn: prevArn,
          })
        ),
      `disable Kinesis streaming on ${tableName}`,
      undefined,
      { maskSecrets }
    );
    this.logger.debug(
      maskSecrets(
        `Disabled Kinesis streaming destination ${prevArn} on DynamoDB table ${tableName}`
      )
    );
    await this.waitForKinesisDisableSettled(tableName, prevArn, maskSecrets);
  }

  // Enable streaming to the new stream when present.
  if (newArn) {
    const s = spec as Record<string, unknown>;
    const precision = s['ApproximateCreationDateTimePrecision'] as string | undefined;
    await this.retryOnTransientControlPlane(
      () =>
        this.dynamoDBClient.send(
          new EnableKinesisStreamingDestinationCommand({
            TableName: tableName,
            StreamArn: newArn,
            ...(precision
              ? {
                  EnableKinesisStreamingConfiguration: {
                    ApproximateCreationDateTimePrecision: precision as
                      | 'MICROSECOND'
                      | 'MILLISECOND',
                  },
                }
              : {}),
          })
        ),
      `enable Kinesis streaming on ${tableName}`,
      undefined,
      { maskSecrets }
    );
    this.logger.debug(
      maskSecrets(`Enabled Kinesis streaming destination ${newArn} on DynamoDB table ${tableName}`)
    );
  }
}

/**
 * After `DisableKinesisStreamingDestination`: poll until no destination for
 * `streamArn` reads as {@link KINESIS_DISABLE_PENDING_STATUSES}
 * (go-to-k/cdkd#5423).
 * The read-back reports an `ACTIVE` / `ENABLING` / `UPDATING` destination as
 * present, and `DescribeKinesisStreamingDestination` went on reading `ACTIVE`
 * for about a second after the disable answered `DISABLING`, so the
 * drift baseline captured right after this update recorded a destination
 * AWS was removing, and every later `cdkd drift` reported it. `DISABLING`
 * still counts as settling. It also runs before an ARN change's enable,
 * whose read-back would otherwise find the old destination first.
 *
 * Best-effort, since AWS accepted the disable: a destination still
 * reported after {@link KINESIS_DISABLE_SETTLE_POLLS} reads, a failed read,
 * or the enclosing per-resource deadline expiring ends the wait with a
 * warning rather than failing the deploy. Interruptible.
 */
export async function waitForKinesisDisableSettled(
  this: DynamoDBTableProvider,
  tableName: string,
  streamArn: string,
  maskSecrets: SecretMasker
): Promise<void> {
  const watch = startInterruptWatch(
    maskSecrets(`Kinesis streaming destination on ${tableName} disabling`)
  );
  const warnUnsettled = (state: string): void =>
    this.logger.warn(
      maskSecrets(
        `The Kinesis streaming destination ${streamArn} disabled on DynamoDB table ` +
          `${tableName} ${state}; \`cdkd drift\` may report it until AWS finishes disabling it`
      )
    );
  let last: string | undefined;
  try {
    for (let poll = 1; poll <= KINESIS_DISABLE_SETTLE_POLLS; poll++) {
      if (watch.isInterrupted()) throw watch.onInterrupted();
      if (enclosingDeadlineRemainingMs() <= 0) {
        warnUnsettled(`still read as ${last ?? 'unread'} when the resource timeout expired`);
        return;
      }
      let destinations: KinesisDataStreamDestination[];
      try {
        const response = await this.retryOnTransientControlPlane(
          () =>
            this.dynamoDBClient.send(
              new DescribeKinesisStreamingDestinationCommand({ TableName: tableName })
            ),
          `describe Kinesis streaming on ${tableName}`,
          undefined,
          { maskSecrets }
        );
        destinations = response?.KinesisDataStreamDestinations ?? [];
      } catch (error) {
        this.logger.debug(
          maskSecrets(
            `Could not read Kinesis streaming on ${tableName} after the disable: ` +
              describeAwsFailure(error).detail
          )
        );
        warnUnsettled('could not be read back');
        return;
      }
      // Settled once no entry for the stream is one the read-back reports
      // (ACTIVE / ENABLING / UPDATING) or DISABLING: DISABLED and
      // ENABLE_FAILED history entries linger beside a live one.
      const pending = destinations.find(
        (d) =>
          d.StreamArn === streamArn &&
          d.DestinationStatus !== undefined &&
          KINESIS_DISABLE_PENDING_STATUSES.has(d.DestinationStatus)
      );
      if (!pending) return;
      last = pending.DestinationStatus ?? 'unknown';
      if (poll === KINESIS_DISABLE_SETTLE_POLLS) break;
      await new Promise((resolve) =>
        setTimeout(
          resolve,
          Math.max(0, Math.min(KINESIS_DISABLE_SETTLE_POLL_MS, enclosingDeadlineRemainingMs()))
        )
      );
    }
  } finally {
    watch.dispose();
  }
  warnUnsettled(
    `still read as ${last ?? 'unread'} after ` +
      `${(KINESIS_DISABLE_SETTLE_POLLS * KINESIS_DISABLE_SETTLE_POLL_MS) / 1000} seconds`
  );
}

/**
 * Change the `ApproximateCreationDateTimePrecision` of an enabled Kinesis
 * streaming destination in place (go-to-k/cdkd#5385).
 *
 * AWS accepts `UpdateKinesisStreamingDestination` only while the
 * destination is `ACTIVE` — otherwise `ValidationException` "Kinesis
 * streaming is not in ACTIVE state", which no retry here classifies as
 * transient — so a destination the previous deploy left `ENABLING` is
 * waited out first. The update then holds it in `UPDATING` for minutes, and
 * the read-back only reports an `ACTIVE` / `ENABLING` destination, so the
 * deploy waits for the new precision to read back `ACTIVE`, as
 * CloudFormation does. A precision AWS already holds (changed out of band,
 * or the default `MICROSECOND` named after it was omitted) is refused with
 * "Precision is already set to the desired value", which is success here.
 * "Not in ACTIVE state" after the ACTIVE wait means a retried call whose
 * first attempt landed (the destination is now `UPDATING`), so it falls
 * through to the settle wait, which still fails unless the destination ends
 * `ACTIVE` at the new precision.
 */
export async function updateKinesisStreamingPrecision(
  this: DynamoDBTableProvider,
  tableName: string,
  streamArn: string,
  precision: ApproximateCreationDateTimePrecision,
  maskSecrets: SecretMasker
): Promise<void> {
  await this.waitForKinesisDestinationSettled(
    tableName,
    streamArn,
    undefined,
    maskSecrets,
    KINESIS_DESTINATION_PRE_UPDATE_POLLS
  );
  try {
    await this.retryOnTransientControlPlane(
      () =>
        this.dynamoDBClient.send(
          new UpdateKinesisStreamingDestinationCommand({
            TableName: tableName,
            StreamArn: streamArn,
            UpdateKinesisStreamingConfiguration: {
              ApproximateCreationDateTimePrecision: precision,
            },
          })
        ),
      `update Kinesis streaming precision on ${tableName}`,
      undefined,
      { maskSecrets }
    );
  } catch (error) {
    if (!(error instanceof Error && error.name === 'ValidationException')) throw error;
    const detail = describeAwsFailure(error).detail;
    if (/already set to the desired value/i.test(detail)) {
      this.logger.debug(
        maskSecrets(
          `Kinesis streaming ApproximateCreationDateTimePrecision on ${tableName} is already ${precision}`
        )
      );
    } else if (/not in ACTIVE state/i.test(detail)) {
      this.logger.debug(
        maskSecrets(
          `Kinesis streaming destination on ${tableName} left ACTIVE during the precision update; verifying the result`
        )
      );
    } else {
      throw error;
    }
  }
  await this.waitForKinesisDestinationSettled(
    tableName,
    streamArn,
    precision,
    maskSecrets,
    KINESIS_DESTINATION_SETTLE_POLLS
  );
  this.logger.debug(
    maskSecrets(
      `Updated Kinesis streaming ApproximateCreationDateTimePrecision on ${tableName} to ${precision}`
    )
  );
}

/**
 * Poll `DescribeKinesisStreamingDestination` until the destination for
 * `streamArn` leaves `ENABLING` / `UPDATING`. With `expectedPrecision`, the
 * settled destination must also be `ACTIVE` at that precision, and any
 * other settled state fails the deploy. Bounded by `maxPolls` and by the
 * enclosing per-resource deadline (whose expiry it reports as its own,
 * non-retryable error rather than the engine's generic timeout), and
 * interruptible.
 */
export async function waitForKinesisDestinationSettled(
  this: DynamoDBTableProvider,
  tableName: string,
  streamArn: string,
  expectedPrecision: ApproximateCreationDateTimePrecision | undefined,
  maskSecrets: SecretMasker,
  maxPolls: number
): Promise<void> {
  const watch = startInterruptWatch(
    maskSecrets(`Kinesis streaming destination on ${tableName} settling`)
  );
  let last: KinesisDataStreamDestination | undefined;
  const sleep = (): Promise<void> =>
    new Promise((resolve) =>
      setTimeout(
        resolve,
        Math.max(0, Math.min(KINESIS_DESTINATION_SETTLE_POLL_MS, enclosingDeadlineRemainingMs()))
      )
    );
  try {
    for (let poll = 1; poll <= maxPolls; poll++) {
      if (watch.isInterrupted()) throw watch.onInterrupted();
      // The engine's deadline does not cancel this update, so a wait that
      // outlived it would keep polling with nobody waiting on it.
      if (enclosingDeadlineRemainingMs() <= 0) {
        throw markNonRetryable(
          new Error(
            maskSecrets(
              `The resource timeout expired while waiting for Kinesis streaming destination ` +
                `${streamArn} on ${tableName} to settle (last status: ` +
                `${last?.DestinationStatus ?? 'none read'})`
            )
          )
        );
      }
      const response = await this.retryOnTransientControlPlane(
        () =>
          this.dynamoDBClient.send(
            new DescribeKinesisStreamingDestinationCommand({ TableName: tableName })
          ),
        `describe Kinesis streaming on ${tableName}`,
        undefined,
        { maskSecrets }
      );
      // DISABLED entries linger beside a re-enabled one for the same stream.
      const matching = (response.KinesisDataStreamDestinations ?? []).filter(
        (d) => d.StreamArn === streamArn
      );
      last = matching.find((d) => d.DestinationStatus !== 'DISABLED') ?? matching[0];
      const status = last?.DestinationStatus;
      if (status !== 'ENABLING' && status !== 'UPDATING') {
        if (expectedPrecision === undefined) return;
        if (status === 'ACTIVE') {
          if (last?.ApproximateCreationDateTimePrecision === expectedPrecision) return;
          if (poll <= KINESIS_PRECISION_STALE_READ_GRACE_POLLS) {
            await sleep();
            continue;
          }
        }
        const head =
          `Kinesis streaming destination ${streamArn} on ${tableName} settled as ` +
          `${status ?? 'absent'} with ApproximateCreationDateTimePrecision ` +
          `${last?.ApproximateCreationDateTimePrecision ?? 'unset'}, expected ACTIVE / ` +
          `${expectedPrecision}`;
        // AWS's DestinationStatusDescription can name the account (an
        // access-denied reason quotes the caller's role ARN), so it goes to
        // debug only and the thrown message carries the --verbose pointer
        // (go-to-k/cdkd#2319's convention for a status reason).
        const reason = describeAwsStatusReason({ message: last?.DestinationStatusDescription }, '');
        if (reason.redacted) this.logger.debug(maskSecrets(`${head}: ${reason.detail}`));
        throw new Error(maskSecrets(reason.redacted ? `${head}. ${reason.summary}` : head));
      }
      await sleep();
    }
  } finally {
    watch.dispose();
  }
  throw new Error(
    maskSecrets(
      `Kinesis streaming destination ${streamArn} on ${tableName} was still ` +
        `${last?.DestinationStatus ?? 'absent'} after ` +
        `${(maxPolls * KINESIS_DESTINATION_SETTLE_POLL_MS) / 1000} seconds`
    )
  );
}
