import type { KinesisStreamProvider } from '../kinesis-provider.js';
import {
  KinesisClient,
  DescribeStreamCommand,
  DescribeStreamSummaryCommand,
  ResourceNotFoundException,
} from '@aws-sdk/client-kinesis';
import { ambientClientDefaults } from '../../../utils/ambient-client-defaults.js';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import { ProvisioningError } from '../../../utils/error-handler.js';
import {
  markRedactedCause,
  relayedNameCollision,
  wrapMaskedAwsError,
} from '../../../deployment/retryable-errors.js';
import { isAuxiliaryFailure } from '../../auxiliary-failure.js';
import type { MaskerFn } from '../../masked-retry-logger.js';
import { withoutServerErrorRetries } from '../ambiguous-create.js';

export function getClient(this: KinesisStreamProvider): KinesisClient {
  if (!this.client) {
    this.client = new KinesisClient({
      ...ambientClientDefaults(),
      ...(this.providerRegion ? { region: this.providerRegion } : {}),
    });
  }
  return this.client;
}

/**
 * The client `CreateStream` goes through: SDK retries on, except a 5xx
 * (`withoutServerErrorRetries`, issues #2080 / #3978). Separate so every
 * other call keeps the full SDK retry.
 *
 * `CreateStream` carries no idempotency token, but it cannot DUPLICATE: a
 * stream name is unique per account and region. What the SDK's own replay
 * of a 5xx whose request had succeeded does instead is collide with the
 * stream the first send made, and that `ResourceInUseException` surfaces
 * from the engine's FIRST attempt, so nothing can tell it from a stream
 * somebody else holds. Refused here, the 5xx reaches the deploy engine's
 * retry, which marks the create as possibly replayed: the replay's
 * collision is then never credited to another holder (`withRetry`, #3978).
 * The stream is not adopted on that collision: a name is not attribution
 * (`docs/provider-rules.md`, "Adopt only on EXACT attribution").
 */
export function getCreateClient(this: KinesisStreamProvider): KinesisClient {
  if (!this.createClient) {
    this.createClient = withoutServerErrorRetries(
      new KinesisClient({
        ...ambientClientDefaults(),
        ...(this.providerRegion ? { region: this.providerRegion } : {}),
      })
    );
  }
  return this.createClient;
}

/**
 * The failure wrap the create, update and delete catches throw.
 *
 * An AWS-authored failure reaches `build` as its CLASS plus the `--verbose`
 * pointer (go-to-k/cdkd#2319): a thrown message is persisted to
 * `deployments/{runId}.jsonl`, and an `AccessDenied` names the caller's
 * assumed-role ARN. AWS's own text goes to `debug` through the operation's
 * masker, and the wrap is stamped `markRedactedCause`, so the retry
 * classifiers read the withheld text on the `cause` chain. An "already
 * exists" (`ResourceInUseException` on `CreateStream`) is restated
 * ({@link relayedNameCollision}), so a create-first replacement still
 * recognises the collision, except from a post-create wiring step's failure
 * ({@link markAuxiliaryFailure}), where "it" would read as this stream
 * (#3826). A cdkd-authored or transport error keeps its
 * text, masked, stamped only when the mask changed it (`wrapMaskedAwsError`,
 * issue #4244); a non-`Error` throw is withheld like an AWS one, unstamped
 * (it has no chain). The delete catch tests not-found before it wraps.
 *
 * `build` must thread `error` as `cause`, and runs twice, so it must stay a
 * side-effect-free constructor call.
 */
export function wrapCaughtError(
  this: KinesisStreamProvider,
  mask: MaskerFn,
  error: unknown,
  build: (text: string) => ProvisioningError
): ProvisioningError {
  const failure = describeAwsFailure(error);
  if (!failure.redacted) return wrapMaskedAwsError(mask, error, build);
  this.logger.debug(mask(build(mask(failure.detail)).message));
  const relay = isAuxiliaryFailure(error) ? '' : relayedNameCollision(failure.detail);
  const wrapped = build(`${mask(failure.summary)}${relay}`);
  return error instanceof Error ? markRedactedCause(wrapped) : wrapped;
}

/**
 * The stream's ARN, or `undefined` when `DescribeStreamSummary` reports it
 * gone. Any other failure (and a response naming no ARN) throws: "could
 * not read" never reads as "gone".
 */
export async function readStreamArnIfExists(
  this: KinesisStreamProvider,
  streamName: string
): Promise<string | undefined> {
  let response;
  try {
    response = await this.getClient().send(
      new DescribeStreamSummaryCommand({ StreamName: streamName })
    );
  } catch (error) {
    if (error instanceof ResourceNotFoundException) return undefined;
    throw error;
  }
  const arn = response.StreamDescriptionSummary?.StreamARN;
  if (typeof arn !== 'string' || arn === '') {
    throw new Error('DescribeStreamSummary returned no StreamARN');
  }
  return arn;
}

/** The stream's status, or `undefined` once `DescribeStreamSummary` reports it gone. */
export async function readStreamStatusForDelete(
  this: KinesisStreamProvider,
  streamName: string
): Promise<string | undefined> {
  try {
    const response = await this.getClient().send(
      new DescribeStreamSummaryCommand({ StreamName: streamName })
    );
    return response.StreamDescriptionSummary?.StreamStatus ?? 'UNKNOWN';
  } catch (error) {
    if (error instanceof ResourceNotFoundException) return undefined;
    throw error;
  }
}

/**
 * Poll DescribeStream until the stream reaches ACTIVE status
 *
 * Uses 2s polling intervals instead of CC API's exponential backoff
 * (1s->2s->4s->8s->10s), reducing total wait time.
 */
export async function waitForStreamActive(
  this: KinesisStreamProvider,
  streamName: string,
  maxAttempts = 30
): Promise<{ streamArn: string | undefined }> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const response = await this.getClient().send(
      new DescribeStreamCommand({ StreamName: streamName })
    );

    const status = response.StreamDescription?.StreamStatus;
    this.logger.debug(`Stream ${streamName} status: ${status} (attempt ${attempt}/${maxAttempts})`);

    if (status === 'ACTIVE') {
      return {
        streamArn: response.StreamDescription?.StreamARN,
      };
    }

    if (status !== 'CREATING' && status !== 'UPDATING') {
      throw new Error(`Unexpected stream status: ${status}`);
    }

    // Wait 2 seconds between polls
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }

  throw new Error(
    `Stream ${streamName} did not reach ACTIVE status within ${maxAttempts * 2} seconds`
  );
}

/**
 * Resolve a stream's ARN from its name. UpdateStreamMode is one of the few
 * Kinesis APIs that takes a StreamARN rather than a StreamName, so an
 * update that switches StreamModeDetails needs the ARN.
 */
export async function resolveStreamArn(
  this: KinesisStreamProvider,
  streamName: string
): Promise<string> {
  const response = await this.getClient().send(
    new DescribeStreamSummaryCommand({ StreamName: streamName })
  );
  const arn = response.StreamDescriptionSummary?.StreamARN;
  if (!arn) {
    throw new Error(`Unable to resolve StreamARN for stream ${streamName}`);
  }
  return arn;
}

/**
 * Read the stream's current open shard count. Used after an
 * ON_DEMAND -> PROVISIONED mode switch, where previousProperties carries no
 * ShardCount and AWS has assigned its own count, so reconciling against the
 * live count (not the absent state value) is the only correct base.
 */
export async function getOpenShardCount(
  this: KinesisStreamProvider,
  streamName: string
): Promise<number> {
  const response = await this.getClient().send(
    new DescribeStreamSummaryCommand({ StreamName: streamName })
  );
  return Number(response.StreamDescriptionSummary?.OpenShardCount ?? 1);
}
