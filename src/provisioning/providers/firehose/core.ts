import type { FirehoseProvider } from '../firehose-provider.js';
import {
  FirehoseClient,
  DescribeDeliveryStreamCommand,
  type DescribeDeliveryStreamCommandOutput,
} from '@aws-sdk/client-firehose';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import type { MaskerFn } from '../../masked-retry-logger.js';
import { ProvisioningError } from '../../../utils/error-handler.js';
import { ambientClientDefaults } from '../../../utils/ambient-client-defaults.js';
import { withoutServerErrorRetries } from '../ambiguous-create.js';
import {
  markNonRetryable,
  markRedactedCause,
  relayedNameCollision,
  wrapMaskedAwsError,
} from '../../../deployment/retryable-errors.js';
import { startInterruptWatch } from '../../interrupt-watch.js';
import { enclosingDeadlineRemainingMs } from '../../../deployment/resource-deadline.js';
import {
  ACTIVE_POLL_INTERVAL_MS,
  ACTIVE_POLL_MAX_ATTEMPTS,
  ACTIVE_DEADLINE_MARGIN_MS,
} from './shared.js';

/**
 * The failure wrap this provider's create, update and delete catches throw.
 *
 * An AWS-authored failure reaches `build` as its CLASS plus the `--verbose`
 * pointer (go-to-k/cdkd#2319): a thrown message is persisted to
 * `deployments/{runId}.jsonl`, and an `AccessDenied` names the caller's
 * assumed-role ARN. AWS's own text goes to `debug` through the operation's
 * masker, and the wrap is stamped `markRedactedCause`, so the retry
 * classifiers read the withheld text on the `cause` chain. An "already
 * exists" is restated ({@link relayedNameCollision}), so a create-first
 * replacement still recognises the collision. A cdkd-authored or transport
 * error keeps its text, masked, stamped only when the mask changed it
 * (`wrapMaskedAwsError`, issue #4244); a non-`Error` throw is withheld like
 * an AWS one, unstamped (it has no chain). A delete catch tests not-found
 * before it wraps.
 *
 * `build` must thread `error` as `cause`, and runs twice, so it must stay a
 * side-effect-free constructor call.
 */
export function wrapCaughtError(
  this: FirehoseProvider,
  mask: MaskerFn,
  error: unknown,
  build: (text: string) => ProvisioningError
): ProvisioningError {
  const failure = describeAwsFailure(error);
  if (!failure.redacted) return wrapMaskedAwsError(mask, error, build);
  this.logger.debug(mask(build(mask(failure.detail)).message));
  const wrapped = build(`${mask(failure.summary)}${relayedNameCollision(failure.detail)}`);
  return error instanceof Error ? markRedactedCause(wrapped) : wrapped;
}

export function getClient(this: FirehoseProvider): FirehoseClient {
  if (!this.client) {
    this.client = new FirehoseClient({
      ...ambientClientDefaults(),
      ...(this.providerRegion ? { region: this.providerRegion } : {}),
    });
    this.createClient = withoutServerErrorRetries(
      new FirehoseClient({
        ...ambientClientDefaults(),
        ...(this.providerRegion ? { region: this.providerRegion } : {}),
      })
    );
  }
  return this.client;
}

/**
 * The client `CreateDeliveryStream` goes through: SDK retries on, except a 5xx
 * (`withoutServerErrorRetries`, issue #4639). Separate so every other call
 * keeps the full SDK retry; built in {@link getClient}'s step, so both
 * capture the region and identity active at that ONE call.
 *
 * `CreateDeliveryStream` carries no idempotency token, and a delivery stream
 * name is unique per account and region, so the SDK's own replay of a 5xx whose request had
 * succeeded collides with what the first send made, and that "already
 * exists" surfaced from the engine's FIRST attempt as a name somebody else
 * holds. Refused here, the 5xx reaches the deploy engine's retry, which
 * marks the create as possibly replayed (`withRetry`, #3978). Nothing is
 * adopted on that collision: a name is not attribution
 * (`docs/provider-rules.md`, "Adopt only on EXACT attribution").
 */
export function getCreateClient(this: FirehoseProvider): FirehoseClient {
  this.getClient();
  return this.createClient as FirehoseClient;
}

/**
 * Return the key of the destination property present on a properties
 * record, or `undefined` if none is present. AWS allows exactly one
 * destination configuration per delivery stream, so the first match is
 * authoritative; the ordering walks the most-common types first.
 */
export function findDestinationKey(
  this: FirehoseProvider,
  properties: Record<string, unknown>
): string | undefined {
  const destinationKeys = [
    'ExtendedS3DestinationConfiguration',
    'S3DestinationConfiguration',
    'HttpEndpointDestinationConfiguration',
    'RedshiftDestinationConfiguration',
    'ElasticsearchDestinationConfiguration',
    'AmazonopensearchserviceDestinationConfiguration',
    'SplunkDestinationConfiguration',
    'AmazonOpenSearchServerlessDestinationConfiguration',
    // Every destination key supports in-place update via UpdateDestination
    // (#477, #549 follow-ups, #5439 for the legacy S3 shape).
    'IcebergDestinationConfiguration',
    'SnowflakeDestinationConfiguration',
  ];
  for (const key of destinationKeys) {
    if (properties[key] !== undefined) return key;
  }
  return undefined;
}

/**
 * Wait for a delivery stream to become ACTIVE (go-to-k/cdkd#5509).
 * CreateDeliveryStream returns while the stream is still CREATING, and a
 * stream left CREATING cannot be deleted or used by dependents
 * (`ResourceInUseException`), so a create that returned early would be
 * recorded as done while the next step fails. CloudFormation waits for
 * ACTIVE and fails the resource on CREATING_FAILED; so does this: a
 * `*_FAILED` report throws with AWS's failure description, masked, and the
 * wait ends with an error when the engine's per-resource deadline runs out,
 * on Ctrl-C, or at the poll cap. Each throw is non-retryable: the stream
 * exists, so a retried create would only collide with it. `create()` records
 * the stream through `markCreatedBeforeFailure`, so it is not orphaned.
 *
 * The wait aims to throw its deadline error while time is still left:
 * `withResourceDeadline` rejects with its own timeout error the moment it
 * fires and drops a later provider error, and the created-id mark rides
 * only on the provider's error, so a wait that ran into the deadline
 * would leave the stream recorded nowhere. It stops sleeping
 * {@link ACTIVE_DEADLINE_MARGIN_MS} before the deadline, and each read is
 * aborted at that same point, so a read held up by SDK retries or a slow
 * connection ends in the same error. The margin is what the throw has to
 * reach the wrapper; an event loop stalled for longer still loses the race
 * (the engine-level gap is go-to-k/cdkd#5511).
 */
export async function waitForActive(
  this: FirehoseProvider,
  streamName: string,
  logicalId: string,
  resourceType: string,
  mask: MaskerFn
): Promise<void> {
  const watch = startInterruptWatch(`Firehose ${logicalId} create`);
  try {
    let last: string | undefined;
    // The engine's deadline does not cancel this create, so the wait ends
    // itself before the deadline fires (see above).
    let deadlineNear = false;
    for (let attempt = 1; attempt <= ACTIVE_POLL_MAX_ATTEMPTS; attempt++) {
      if (watch.isInterrupted()) throw watch.onInterrupted();
      if (enclosingDeadlineRemainingMs() <= ACTIVE_DEADLINE_MARGIN_MS) {
        deadlineNear = true;
        break;
      }
      const resp = await this.describeBeforeDeadline(streamName);
      if (resp === 'deadline') {
        deadlineNear = true;
        break;
      }
      const description = resp.DeliveryStreamDescription;
      last = description?.DeliveryStreamStatus;
      if (last === 'ACTIVE') {
        this.logger.debug(`Firehose ${logicalId} is ACTIVE`);
        return;
      }
      if (last !== undefined && last.endsWith('_FAILED')) {
        const failure = description?.FailureDescription;
        throw markNonRetryable(
          new ProvisioningError(
            `Firehose delivery stream ${logicalId} did not become ACTIVE: AWS reports ${last}` +
              (failure ? ` (${mask(`${failure.Type ?? ''}: ${failure.Details ?? ''}`)})` : ''),
            resourceType,
            logicalId,
            streamName
          )
        );
      }
      this.logger.debug(
        `Firehose ${logicalId} status: ${last} (attempt ${attempt}/${ACTIVE_POLL_MAX_ATTEMPTS})`
      );
      if (watch.isInterrupted()) throw watch.onInterrupted();
      if (enclosingDeadlineRemainingMs() <= ACTIVE_POLL_INTERVAL_MS + ACTIVE_DEADLINE_MARGIN_MS) {
        deadlineNear = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, ACTIVE_POLL_INTERVAL_MS));
    }
    throw markNonRetryable(
      new ProvisioningError(
        (deadlineNear
          ? `The resource timeout would expire while waiting for Firehose delivery stream ${logicalId} to become ACTIVE `
          : `Timed out waiting for Firehose delivery stream ${logicalId} to become ACTIVE `) +
          `(last status: ${last ?? 'none reported'})`,
        resourceType,
        logicalId,
        streamName
      )
    );
  } finally {
    watch.dispose();
  }
}

/**
 * One `DescribeDeliveryStream` read for {@link waitForActive}, aborted
 * {@link ACTIVE_DEADLINE_MARGIN_MS} before the enclosing resource deadline
 * (`'deadline'` then). Outside any deadline the read is unbounded.
 */
export async function describeBeforeDeadline(
  this: FirehoseProvider,
  streamName: string
): Promise<DescribeDeliveryStreamCommandOutput | 'deadline'> {
  const command = new DescribeDeliveryStreamCommand({ DeliveryStreamName: streamName });
  const remaining = enclosingDeadlineRemainingMs();
  if (!Number.isFinite(remaining)) return this.getClient().send(command);
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), Math.max(0, remaining - ACTIVE_DEADLINE_MARGIN_MS));
  try {
    return await this.getClient().send(command, { abortSignal: abort.signal });
  } catch (error) {
    if (abort.signal.aborted) return 'deadline';
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
