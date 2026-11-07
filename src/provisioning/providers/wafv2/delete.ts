import type { WAFv2WebACLProvider } from '../wafv2-provider.js';
import {
  DeleteWebACLCommand,
  GetWebACLCommand,
  WAFNonexistentItemException,
} from '@aws-sdk/client-wafv2';
import { markNotGone } from '../../not-gone.js';
import { maskerOrIdentity } from '../../masked-retry-logger.js';
import { ProvisioningError } from '../../../utils/error-handler.js';
import { assertRegionMatch, type DeleteContext } from '../../region-check.js';
import { parseWebACLArn } from '../wafv2-arn.js';

/**
 * Delete a WAFv2 WebACL
 *
 * DeleteWebACL requires LockToken obtained from GetWebACL.
 * WAFNonexistentItemException is treated as success (idempotent delete).
 */
export async function deleteImpl(
  this: WAFv2WebACLProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  _properties?: Record<string, unknown>,
  context?: DeleteContext
): Promise<void> {
  this.logger.debug(`Deleting WAFv2 WebACL ${logicalId}: ${physicalId}`);
  // go-to-k/cdkd#2613: the delete addresses the web ACL by the name, id and
  // scope inside the recorded ARN, so a client in another region than the
  // state record would send `GetWebACL` and `DeleteWebACL` there. Refuse
  // before any call, not only on NotFound; the client's region is resolved
  // only when there is one to compare with.
  assertRegionMatch(
    context?.expectedRegion ? await this.getClient().config.region() : undefined,
    context?.expectedRegion,
    resourceType,
    logicalId,
    physicalId,
    'pre-delete'
  );

  try {
    const { id, name, scope } = parseWebACLArn(physicalId);

    // Get LockToken
    const getResponse = await this.getClient().send(
      new GetWebACLCommand({
        Name: name,
        Scope: scope,
        Id: id,
      })
    );

    const lockToken = getResponse.LockToken;
    if (!lockToken) {
      throw new Error('GetWebACL did not return LockToken');
    }

    await this.getClient().send(
      new DeleteWebACLCommand({
        Name: name,
        Scope: scope,
        Id: id,
        LockToken: lockToken,
      })
    );

    this.logger.debug(`Successfully deleted WAFv2 WebACL ${logicalId}`);
  } catch (error) {
    if (error instanceof WAFNonexistentItemException) {
      const clientRegion = await this.getClient().config.region();
      assertRegionMatch(clientRegion, context?.expectedRegion, resourceType, logicalId, physicalId);
      this.logger.debug(`WAFv2 WebACL ${physicalId} does not exist, skipping deletion`);
      return;
    }

    const cause = error instanceof Error ? error : undefined;
    const thrown = this.wrapCaughtError(
      maskerOrIdentity(context?.maskSecrets),
      error,
      (text) =>
        new ProvisioningError(
          `Failed to delete WAFv2 WebACL ${logicalId}: ${text}`,
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
}
