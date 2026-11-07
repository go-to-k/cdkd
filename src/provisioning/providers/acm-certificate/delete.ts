import type { ACMCertificateProvider } from '../acm-certificate-provider.js';
import { DeleteCertificateCommand, ResourceNotFoundException } from '@aws-sdk/client-acm';
import { ProvisioningError } from '../../../utils/error-handler.js';
import { assertRegionMatch, type DeleteContext } from '../../region-check.js';
import { markNotGone } from '../../not-gone.js';
import type { ResourceDeleteResult } from '../../../types/resource.js';

export async function deleteImpl(
  this: ACMCertificateProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  _properties?: Record<string, unknown>,
  context?: DeleteContext
): Promise<void | ResourceDeleteResult> {
  this.logger.debug(`Deleting ACM certificate ${logicalId}: ${physicalId}`);

  try {
    try {
      await this.acmClient.send(new DeleteCertificateCommand({ CertificateArn: physicalId }));
    } catch (error) {
      if (error instanceof ResourceNotFoundException) {
        const clientRegion = await this.acmClient.config.region();
        assertRegionMatch(
          clientRegion,
          context?.expectedRegion,
          resourceType,
          logicalId,
          physicalId
        );
        this.logger.debug(`Certificate ${physicalId} does not exist, skipping deletion`);
        return;
      }
      throw error;
    }
    this.logger.debug(`Successfully deleted ACM certificate ${logicalId}`);
  } catch (error) {
    const cause = error instanceof Error ? error : undefined;
    const thrown = this.wrapCaughtError(
      context?.maskSecrets,
      error,
      (text) =>
        new ProvisioningError(
          `Failed to delete ACM certificate ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          physicalId,
          cause
        )
    );
    // The wrap names an AWS failure by its CLASS, which the delete classifiers
    // read as "already deleted" on a `NotFound` needle: only the typed
    // not-found above means this one is gone (go-to-k/cdkd#2319).
    throw error instanceof Error && error.name.includes('NotFound') ? markNotGone(thrown) : thrown;
  }
}
