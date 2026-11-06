import type { KinesisStreamProvider } from '../kinesis-provider.js';
import { DeleteStreamCommand, ResourceNotFoundException } from '@aws-sdk/client-kinesis';
import { safeMsg } from '../../../utils/display-safe.js';
import { ProvisioningError } from '../../../utils/error-handler.js';
import { markNotGone } from '../../not-gone.js';
import { assertRegionMatch, type DeleteContext } from '../../region-check.js';
import { maskerOrIdentity } from '../../masked-retry-logger.js';
import { waitForGoneAfterDelete } from '../../delete-gone-wait.js';
import { KINESIS_DELETE_POLL_INTERVAL_MS, KINESIS_DELETE_MAX_WAIT_MS } from './shared.js';

/**
 * Delete a Kinesis stream
 */
export async function deleteImpl(
  this: KinesisStreamProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  _properties?: Record<string, unknown>,
  context?: DeleteContext
): Promise<void> {
  this.logger.debug(`Deleting Kinesis stream ${logicalId}: ${physicalId}`);

  try {
    await this.getClient().send(
      new DeleteStreamCommand({
        StreamName: physicalId,
        EnforceConsumerDeletion: true,
      })
    );
  } catch (error) {
    if (error instanceof ResourceNotFoundException) {
      const clientRegion = await this.getClient().config.region();
      assertRegionMatch(clientRegion, context?.expectedRegion, resourceType, logicalId, physicalId);
      if (context?.failedCreateOrphan === true) {
        // go-to-k/cdkd#4606: a journaled orphan already gone settles with
        // exit 0, so say so once. Masked by the caller's printing bag.
        this.logger.info(
          safeMsg`  Kinesis stream ${physicalId} (${logicalId}), which a failed deploy created, is already gone; nothing to delete`
        );
      } else {
        this.logger.debug(`Kinesis stream ${physicalId} does not exist, skipping deletion`);
      }
      return;
    }
    const cause = error instanceof Error ? error : undefined;
    const thrown = this.wrapCaughtError(
      maskerOrIdentity(context?.maskSecrets),
      error,
      (text) =>
        new ProvisioningError(
          `Failed to delete Kinesis stream ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          physicalId,
          cause
        )
    );
    // The wrap names an AWS failure by its CLASS, and the delete classifiers
    // read `NotFoundException` in a message as "already deleted": only the
    // typed not-found above means this stream is gone (go-to-k/cdkd#2319).
    throw error instanceof Error && error.name.includes('NotFound') ? markNotGone(thrown) : thrown;
  }

  // Issue #3872: the stream keeps its NAME while it is DELETING, and a
  // CreateStream of that name is refused with the same `already exists`
  // text a live stream gets, so the delete is complete only once the stream
  // is gone. Outside the try: with no `failedStatus` passed, the wait never
  // throws.
  await waitForGoneAfterDelete({
    what: `Kinesis stream ${physicalId}`,
    resourceType,
    describe: () => this.readStreamStatusForDelete(physicalId),
    logger: this.logger,
    pollIntervalMs: KINESIS_DELETE_POLL_INTERVAL_MS,
    maxWaitMs: KINESIS_DELETE_MAX_WAIT_MS,
  });
  this.logger.debug(`Successfully deleted Kinesis stream ${logicalId}`);
}
