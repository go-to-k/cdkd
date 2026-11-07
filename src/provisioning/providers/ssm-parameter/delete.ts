import { DeleteParameterCommand, ParameterNotFound } from '@aws-sdk/client-ssm';
import { displaySafe } from '../../../utils/display-safe.js';
import { ProvisioningError } from '../../../utils/error-handler.js';
import { assertRegionMatch, type DeleteContext } from '../../region-check.js';
import { maskerOrIdentity } from '../../masked-retry-logger.js';
import { markNotGone } from '../../not-gone.js';
import type { SSMParameterProvider } from '../ssm-parameter-provider.js';

/**
 * Delete an SSM parameter
 */
export async function deleteImpl(
  this: SSMParameterProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  _properties?: Record<string, unknown>,
  context?: DeleteContext
): Promise<void> {
  this.logger.debug(`Deleting SSM parameter ${displaySafe(logicalId)}: ${displaySafe(physicalId)}`);

  try {
    await this.ssmClient.send(
      new DeleteParameterCommand({
        Name: physicalId,
      })
    );

    this.logger.debug(`Successfully deleted SSM parameter ${displaySafe(logicalId)}`);
  } catch (error) {
    if (error instanceof ParameterNotFound) {
      const clientRegion = await this.ssmClient.config.region();
      assertRegionMatch(clientRegion, context?.expectedRegion, resourceType, logicalId, physicalId);
      this.logger.debug(`Parameter ${displaySafe(physicalId)} does not exist, skipping deletion`);
      return;
    }

    const cause = error instanceof Error ? error : undefined;
    const thrown = this.wrapCaughtError(
      maskerOrIdentity(context?.maskSecrets),
      error,
      (text) =>
        new ProvisioningError(
          `Failed to delete SSM parameter ${displaySafe(logicalId)}: ${text}`,
          resourceType,
          logicalId,
          physicalId,
          cause
        )
    );
    // The wrap names an AWS failure by its CLASS, and the delete classifiers
    // read `NotFound` in a message as "already deleted": only the typed
    // `ParameterNotFound` above means this parameter is gone (go-to-k/cdkd#2319).
    throw error instanceof Error && error.name.includes('NotFound') ? markNotGone(thrown) : thrown;
  }
}
