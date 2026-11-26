import {
  DeleteEventSourceMappingCommand,
  GetEventSourceMappingCommand,
  ResourceNotFoundException,
} from '@aws-sdk/client-lambda';
import type { LambdaEventSourceMappingProvider } from '../lambda-eventsource-provider.js';
import { ProvisioningError } from '../../../utils/error-handler.js';
import { assertRegionMatch, type DeleteContext } from '../../region-check.js';

/**
 * States a mapping passes through on its own; Lambda refuses a delete with
 * `ResourceInUseException` while the mapping is in one of them.
 */
const TRANSITIONAL_STATES: ReadonlySet<string> = new Set([
  'Creating',
  'Updating',
  'Enabling',
  'Disabling',
  'Deleting',
]);

/** How long a refused delete waits for the mapping to settle, and how often it reads. */
export const IN_USE_SETTLE_BUDGET_MS = 5 * 60_000;
export const IN_USE_POLL_INTERVAL_MS = 3_000;

function isInUse(error: unknown): boolean {
  return (error as { name?: unknown } | null)?.name === 'ResourceInUseException';
}

/**
 * `DeleteEventSourceMapping`, waiting out a mapping that is still settling
 * (go-to-k/cdkd#7011). `create()` returns while the mapping is `Creating`, so a
 * rollback reversing a replacement seconds later is refused with
 * `ResourceInUseException`, and the rollback's readopt arm calls `delete()`
 * with no retry around it. The wait runs only after that refusal and only
 * while AWS reports the mapping in a transitional state, so an ordinary delete
 * makes the same single call as before, and a refusal for another reason (its
 * function being torn down) reaches the caller's own retry unchanged.
 */
async function deleteWhenSettled(
  this: LambdaEventSourceMappingProvider,
  logicalId: string,
  physicalId: string
): Promise<void> {
  const deadline = Date.now() + IN_USE_SETTLE_BUDGET_MS;
  for (;;) {
    try {
      await this.lambdaClient.send(new DeleteEventSourceMappingCommand({ UUID: physicalId }));
      return;
    } catch (error) {
      if (!isInUse(error)) throw error;
      // A vanished mapping is deleted: ResourceNotFoundException reaches the
      // caller's catch.
      const read = await this.lambdaClient.send(
        new GetEventSourceMappingCommand({ UUID: physicalId })
      );
      if (!TRANSITIONAL_STATES.has(read.State ?? '') || Date.now() >= deadline) throw error;
    }
    this.logger.debug(
      `Event source mapping ${logicalId} is still settling; waiting before retrying the delete`
    );
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, IN_USE_POLL_INTERVAL_MS));
      const current = await this.lambdaClient.send(
        new GetEventSourceMappingCommand({ UUID: physicalId })
      );
      if (!TRANSITIONAL_STATES.has(current.State ?? '') || Date.now() >= deadline) break;
    }
  }
}

/**
 * Delete a Lambda Event Source Mapping
 */
export async function deleteImpl(
  this: LambdaEventSourceMappingProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  properties?: Record<string, unknown>,
  context?: DeleteContext
): Promise<void> {
  this.logger.debug(`Deleting event source mapping ${logicalId}: ${physicalId}`);

  try {
    // Check if mapping still exists
    try {
      await this.lambdaClient.send(new GetEventSourceMappingCommand({ UUID: physicalId }));
    } catch (error) {
      if (error instanceof ResourceNotFoundException) {
        const clientRegion = await this.lambdaClient.config.region();
        assertRegionMatch(
          clientRegion,
          context?.expectedRegion,
          resourceType,
          logicalId,
          physicalId
        );
        this.logger.debug(`Event source mapping ${physicalId} does not exist, skipping deletion`);
        return;
      }
      throw error;
    }

    await deleteWhenSettled.call(this, logicalId, physicalId);
    this.logger.debug(`Successfully deleted event source mapping ${logicalId}`);
  } catch (error) {
    if (error instanceof ResourceNotFoundException) {
      const clientRegion = await this.lambdaClient.config.region();
      assertRegionMatch(clientRegion, context?.expectedRegion, resourceType, logicalId, physicalId);
      this.logger.debug(`Event source mapping ${physicalId} does not exist, skipping deletion`);
      return;
    }
    const cause = error instanceof Error ? error : undefined;
    throw this.wrapMaskedError(
      this.operationSinks(context?.maskSecrets, properties ?? {}),
      error,
      (text) =>
        new ProvisioningError(
          `Failed to delete event source mapping ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          physicalId,
          cause
        )
    );
  }
}
