import type { PipesPipeProvider } from '../pipes-provider.js';
import { DeletePipeCommand, NotFoundException } from '@aws-sdk/client-pipes';
import { ProvisioningError } from '../../../utils/error-handler.js';
import { safeMsg } from '../../../utils/display-safe.js';
import { assertRegionMatch, type DeleteContext } from '../../region-check.js';
import { waitForGoneAfterDelete } from '../../delete-gone-wait.js';
import type { ResourceDeleteResult } from '../../../types/resource.js';
import {
  PIPE_DELETE_MAX_WAIT_MS,
  PIPE_POLL_INTERVAL_MS,
  deleteFailureClassifier,
} from './shared.js';

export async function deleteImpl(
  this: PipesPipeProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  _properties?: Record<string, unknown>,
  context?: DeleteContext
): Promise<void | ResourceDeleteResult> {
  const clientRegion = await this.getClient().config.region();
  assertRegionMatch(
    clientRegion,
    context?.expectedRegion,
    resourceType,
    logicalId,
    physicalId,
    'pre-delete'
  );
  this.logger.debug(safeMsg`Deleting Pipe ${logicalId}: ${physicalId}`);
  try {
    await this.getClient().send(new DeletePipeCommand({ Name: physicalId }));
  } catch (error) {
    if (error instanceof NotFoundException) {
      assertRegionMatch(clientRegion, context?.expectedRegion, resourceType, logicalId, physicalId);
      this.logGoneOnDelete(logicalId, physicalId, context);
      return;
    }
    const cause = error instanceof Error ? error : undefined;
    throw this.wrapCaughtError(
      context?.maskSecrets,
      error,
      (text) =>
        new ProvisioningError(
          `Failed to delete Pipe ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          physicalId,
          cause
        )
    );
  }
  // A DELETING pipe still holds its name, so a same-name create (a
  // delete-first replacement, a destroy then a deploy) would be refused.
  await waitForGoneAfterDelete({
    what: `Pipe ${physicalId}`,
    resourceType,
    describe: () => this.readStateForDelete(physicalId),
    failedStatus: deleteFailureClassifier(resourceType, logicalId, physicalId),
    logger: this.logger,
    pollIntervalMs: PIPE_POLL_INTERVAL_MS,
    maxWaitMs: PIPE_DELETE_MAX_WAIT_MS,
    sleep: this.sleep,
    now: this.now,
  });
}
