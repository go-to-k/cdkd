import type { CloudTrailProvider } from '../cloudtrail-provider.js';
import {
  DeleteTrailCommand,
  StopLoggingCommand,
  TrailNotFoundException,
} from '@aws-sdk/client-cloudtrail';
import { ProvisioningError } from '../../../utils/error-handler.js';
import { isRefusedByName, markDeleteStarted } from '../../delete-started.js';
import { assertRegionMatch, type DeleteContext } from '../../region-check.js';
import { markNotGone } from '../../not-gone.js';

export async function deleteImpl(
  this: CloudTrailProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  properties?: Record<string, unknown>,
  context?: DeleteContext
): Promise<void> {
  this.logger.debug(`Deleting CloudTrail Trail ${logicalId}: ${physicalId}`);
  // go-to-k/cdkd#4946: set once a StopLogging may have landed, so a refused
  // `DeleteTrail` is never read as a whole survivor. A trail its record says
  // is not logging is what the record describes even once stopped.
  const recordedIsLogging = properties?.['IsLogging'];
  const recordedStopped = recordedIsLogging === false || recordedIsLogging === 'false';
  let stripped = false;

  try {
    // Stop logging before deletion (ignore errors)
    try {
      stripped = !recordedStopped;
      await this.getClient().send(new StopLoggingCommand({ Name: physicalId }));
    } catch (stopError) {
      // Ignore errors when stopping logging. A swallowed failure may still
      // have landed, unless AWS refused it by name.
      if (isRefusedByName(stopError)) stripped = false;
    }

    await this.getClient().send(new DeleteTrailCommand({ Name: physicalId }));
    this.logger.debug(`Successfully deleted CloudTrail Trail ${logicalId}`);
  } catch (error) {
    if (error instanceof TrailNotFoundException) {
      const clientRegion = await this.getClient().config.region();
      assertRegionMatch(clientRegion, context?.expectedRegion, resourceType, logicalId, physicalId);
      this.logger.debug(`CloudTrail Trail ${physicalId} does not exist, skipping deletion`);
      return;
    }
    const cause = error instanceof Error ? error : undefined;
    const failure = this.wrapCaughtError(
      context?.maskSecrets,
      error,
      (text) =>
        new ProvisioningError(
          `Failed to delete CloudTrail Trail ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          physicalId,
          cause
        )
    );
    // The wrap names an AWS failure by its CLASS, and the delete classifiers
    // read `NotFound` in a message as "already deleted": only the typed
    // `TrailNotFoundException` above means this trail is gone (go-to-k/cdkd#2319).
    const notGone =
      error instanceof Error && error.name.includes('NotFound') ? markNotGone(failure) : failure;
    throw stripped ? markDeleteStarted(notGone) : notGone;
  }
}
