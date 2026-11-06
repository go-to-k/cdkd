import {
  DeleteEventSourceMappingCommand,
  GetEventSourceMappingCommand,
  ResourceNotFoundException,
} from '@aws-sdk/client-lambda';
import type { LambdaEventSourceMappingProvider } from '../lambda-eventsource-provider.js';
import { ProvisioningError } from '../../../utils/error-handler.js';
import { assertRegionMatch, type DeleteContext } from '../../region-check.js';

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

    await this.lambdaClient.send(new DeleteEventSourceMappingCommand({ UUID: physicalId }));
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
