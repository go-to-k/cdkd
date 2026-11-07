import { DeleteProjectCommand, ResourceNotFoundException } from '@aws-sdk/client-codebuild';
import { ProvisioningError } from '../../../utils/error-handler.js';
import { assertRegionMatch, type DeleteContext } from '../../region-check.js';
import { markNotGone } from '../../not-gone.js';
import { maskerOrIdentity } from '../../masked-retry-logger.js';
import type { CodeBuildProvider } from '../codebuild-provider.js';

export async function deleteImpl(
  this: CodeBuildProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  _properties?: Record<string, unknown>,
  context?: DeleteContext
): Promise<void> {
  this.logger.debug(`Deleting CodeBuild Project ${logicalId}: ${physicalId}`);

  try {
    await this.getClient().send(new DeleteProjectCommand({ name: physicalId }));
    this.logger.debug(`Successfully deleted CodeBuild Project ${logicalId}`);
  } catch (error) {
    if (error instanceof ResourceNotFoundException) {
      const clientRegion = await this.getClient().config.region();
      assertRegionMatch(clientRegion, context?.expectedRegion, resourceType, logicalId, physicalId);
      this.logger.debug(`CodeBuild Project ${physicalId} does not exist, skipping deletion`);
      return;
    }
    const cause = error instanceof Error ? error : undefined;
    const thrown = this.wrapCaughtError(
      maskerOrIdentity(context?.maskSecrets),
      error,
      (text) =>
        new ProvisioningError(
          `Failed to delete CodeBuild Project ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          physicalId,
          cause
        ),
      false
    );
    // The wrap names an AWS failure by its CLASS, and the delete classifiers
    // read `NotFoundException` in a message as "already deleted": only the
    // typed not-found above means this resource is gone (go-to-k/cdkd#2319).
    throw error instanceof Error && error.name.includes('NotFound') ? markNotGone(thrown) : thrown;
  }
}
