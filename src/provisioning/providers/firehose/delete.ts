import type { FirehoseProvider } from '../firehose-provider.js';
import {
  DeleteDeliveryStreamCommand,
  DescribeDeliveryStreamCommand,
  ResourceNotFoundException,
} from '@aws-sdk/client-firehose';
import { maskerOrIdentity } from '../../masked-retry-logger.js';
import { markNotGone } from '../../not-gone.js';
import { ProvisioningError } from '../../../utils/error-handler.js';
import { assertRegionMatch, type DeleteContext } from '../../region-check.js';
import { waitForGoneAfterDelete } from '../../delete-gone-wait.js';
import { FIREHOSE_DELETE_POLL_INTERVAL_MS, FIREHOSE_DELETE_MAX_WAIT_MS } from './shared.js';

/**
 * Delete a Firehose delivery stream
 */
export async function deleteImpl(
  this: FirehoseProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  _properties?: Record<string, unknown>,
  context?: DeleteContext
): Promise<void> {
  this.logger.debug(`Deleting Firehose delivery stream ${logicalId}: ${physicalId}`);

  try {
    await this.getClient().send(
      new DeleteDeliveryStreamCommand({
        DeliveryStreamName: physicalId,
      })
    );
  } catch (error) {
    if (error instanceof ResourceNotFoundException) {
      const clientRegion = await this.getClient().config.region();
      assertRegionMatch(clientRegion, context?.expectedRegion, resourceType, logicalId, physicalId);
      this.logger.debug(`Firehose delivery stream ${physicalId} does not exist, skipping deletion`);
      return;
    }
    const cause = error instanceof Error ? error : undefined;
    const thrown = this.wrapCaughtError(
      maskerOrIdentity(context?.maskSecrets),
      error,
      (text) =>
        new ProvisioningError(
          `Failed to delete Firehose delivery stream ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          physicalId,
          cause
        )
    );
    // The wrap names an AWS failure by its CLASS, and the delete classifiers
    // read `NotFoundException` in a message as "already deleted": only the
    // typed not-found above means this resource is gone (go-to-k/cdkd#2319).
    throw error instanceof Error && error.name.includes('NotFound') ? markNotGone(thrown) : thrown;
  }

  // Issue #3872: the delivery stream keeps its NAME while it is DELETING
  // (~100s measured), and a CreateDeliveryStream of that name is refused with
  // the same `already exists` text a live stream gets, so the delete is
  // complete only once the stream is gone. Outside the try: the wait's only
  // throw is the DELETING_FAILED error below, which must not be re-wrapped.
  await waitForGoneAfterDelete({
    what: `Firehose delivery stream ${physicalId}`,
    resourceType,
    describe: () => this.readDeliveryStreamStatusForDelete(physicalId),
    // DELETING_FAILED is terminal: Firehose could not finish the delete
    // (typically a customer-managed KMS key it can no longer use) and keeps
    // the stream until a forced delete. Returning would drop the state
    // record of a live stream, so this one exit throws and keeps it.
    failedStatus: (status) =>
      status === 'DELETING_FAILED'
        ? new ProvisioningError(
            `Firehose delivery stream ${logicalId} entered DELETING_FAILED after the delete ` +
              `was accepted, so AWS will not finish it on its own (commonly a customer-managed ` +
              `KMS key the stream can no longer use). Fix the key and re-run, or delete the ` +
              `stream outside cdkd with AllowForceDelete (cdkd never sends it); the state ` +
              `record is kept.`,
            resourceType,
            logicalId,
            physicalId
          )
        : undefined,
    logger: this.logger,
    pollIntervalMs: FIREHOSE_DELETE_POLL_INTERVAL_MS,
    maxWaitMs: FIREHOSE_DELETE_MAX_WAIT_MS,
  });
  this.logger.debug(`Successfully deleted Firehose delivery stream ${logicalId}`);
}

/** The delivery stream's status, or `undefined` once `DescribeDeliveryStream` reports it gone. */
export async function readDeliveryStreamStatusForDelete(
  this: FirehoseProvider,
  streamName: string
): Promise<string | undefined> {
  try {
    const response = await this.getClient().send(
      new DescribeDeliveryStreamCommand({ DeliveryStreamName: streamName })
    );
    return response.DeliveryStreamDescription?.DeliveryStreamStatus ?? 'UNKNOWN';
  } catch (error) {
    if (error instanceof ResourceNotFoundException) return undefined;
    throw error;
  }
}
