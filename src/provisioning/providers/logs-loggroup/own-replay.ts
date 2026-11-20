/**
 * go-to-k/cdkd#6655: a log group create's retry that meets the group its own
 * earlier attempt made, after that attempt's answer was lost.
 */
import { CloudWatchLogsClient } from '@aws-sdk/client-cloudwatch-logs';
import type { LogsLogGroupProvider } from '../logs-loggroup-provider.js';
import { ambientClientDefaults } from '../../../utils/ambient-client-defaults.js';
import {
  AmbiguousCreateLatch,
  CREATION_DATE_SKEW_MARGIN_MS,
  isInsideWindow,
  type AmbiguousCreateWindow,
  withoutServerErrorRetries,
} from '../ambiguous-create.js';
import { hasReplayMayCollide } from '../../../deployment/retryable-errors.js';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import { safeMsg } from '../../../utils/display-safe.js';

/**
 * go-to-k/cdkd#6655: an earlier attempt of THIS create whose outcome was
 * ambiguous (a 5xx, a reset or a timeout the engine retried), so the group
 * holding the name may be the one it made.
 */
export const createLogGroupLatch = new AmbiguousCreateLatch('CreateLogGroup');

/** TEST-ONLY. */
export function resetCreateLogGroupLatchForTests(): void {
  createLogGroupLatch.resetForTests();
}

const createClients = new WeakMap<object, Promise<CloudWatchLogsClient>>();

/**
 * The client `CreateLogGroup` goes through: SDK retries on, except a 5xx
 * (`withoutServerErrorRetries`), so a 5xx whose request completed reaches the
 * engine's retry and {@link createLogGroupLatch} instead of being replayed
 * inside one `send`, and what the SDK does replay after an ambiguous attempt
 * carries the replay-may-collide stamp -- the ONLY in-send signal
 * {@link ownReplayedGroup} trusts (`$metadata.attempts > 1` also follows a
 * throttle, where the service did nothing). Built in the shared client's
 * region with the ambient identity, as `lambda-create-client.ts`; a shared
 * client that is not a `CloudWatchLogsClient` -- a unit-test double -- is
 * used as is.
 */
export function logGroupCreateClient(shared: CloudWatchLogsClient): Promise<CloudWatchLogsClient> {
  if (!(shared instanceof CloudWatchLogsClient)) return Promise.resolve(shared);
  let client = createClients.get(shared);
  if (client === undefined) {
    client = shared.config.region().then(
      (region) =>
        withoutServerErrorRetries(new CloudWatchLogsClient({ ...ambientClientDefaults(), region })),
      (error: unknown) => {
        createClients.delete(shared);
        throw error;
      }
    );
    createClients.set(shared, client);
  }
  return client;
}

/**
 * Is the log group answering `ResourceAlreadyExistsException` this create's
 * own, made by an earlier attempt whose answer was lost? Only when an attempt
 * was ambiguous -- an earlier engine attempt (`carried`, the latch) or the
 * SDK's replay inside this `send` after an ambiguous attempt (the
 * replay-may-collide stamp of {@link logGroupCreateClient}) -- and the
 * group's `creationTime` falls inside that window (from the earliest such
 * attempt's send, minus the skew margin, to that attempt's end plus it: now
 * for an in-send replay, the latch's ceiling otherwise). Otherwise, or when the read fails, it is not proven ours
 * and the create refuses: a group of another owner predates the window. The
 * `DescribeLogGroups` read runs on this rare path only.
 */
export async function ownReplayedGroup(
  this: LogsLogGroupProvider,
  logGroupName: string,
  createError: unknown,
  carried: AmbiguousCreateWindow | undefined,
  attemptStartMs: number,
  shownName: string
): Promise<boolean> {
  const replayedInSend = hasReplayMayCollide(createError);
  if (carried === undefined && !replayedInSend) return false;
  const window: AmbiguousCreateWindow = {
    floorMs: Math.min(
      carried?.floorMs ?? Number.POSITIVE_INFINITY,
      replayedInSend ? attemptStartMs - CREATION_DATE_SKEW_MARGIN_MS : Number.POSITIVE_INFINITY
    ),
    ceilingMs:
      replayedInSend || carried === undefined
        ? Date.now() + CREATION_DATE_SKEW_MARGIN_MS
        : carried.ceilingMs,
  };
  let createdAt: number | undefined;
  try {
    createdAt = await this.holderCreatedAt('AWS::Logs::LogGroup', logGroupName);
  } catch (readError) {
    this.logger.debug(
      safeMsg`Could not read when log group ${shownName} was created (${describeAwsFailure(readError).summary}); refusing it`
    );
    return false;
  }
  return isInsideWindow(createdAt === undefined ? undefined : new Date(createdAt), window);
}
