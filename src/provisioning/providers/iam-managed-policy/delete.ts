import type { IAMManagedPolicyProvider } from '../iam-managed-policy-provider.js';
import { GetPolicyCommand, DeletePolicyCommand, NoSuchEntityException } from '@aws-sdk/client-iam';
import { ProvisioningError } from '../../../utils/error-handler.js';
import { type DeleteContext } from '../../region-check.js';
import { markNotGone } from '../../not-gone.js';
import { maskerOrIdentity } from '../../masked-retry-logger.js';
import type { ResourceDeleteResult } from '../../../types/resource.js';
import { markDeleteStarted, type DeleteProgress } from '../../delete-started.js';

export async function deleteImpl(
  this: IAMManagedPolicyProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  _properties?: Record<string, unknown>,
  context?: DeleteContext
): Promise<void | ResourceDeleteResult> {
  // The caller's masker (go-to-k/cdkd#2007); `update()`'s replacement arm
  // hands its operation masker, which pairs the recorded name and path with
  // the ARN (go-to-k/cdkd#4339).
  const mask = maskerOrIdentity(context?.maskSecrets);
  this.logger.debug(mask(`Deleting IAM managed policy ${logicalId}: ${physicalId}`));
  // go-to-k/cdkd#4946: set once a principal is detached, so a refused
  // `DeletePolicy` is never read as a whole survivor. Deleting non-default
  // versions is not a strip: the record describes only the default one.
  const progress: DeleteProgress = { stripped: false };

  try {
    try {
      await this.iamClient.send(new GetPolicyCommand({ PolicyArn: physicalId }));
    } catch (error) {
      if (error instanceof NoSuchEntityException) {
        await this.goneOnDelete(logicalId, physicalId, resourceType, context, mask);
        return;
      }
      throw error;
    }

    // 1. Detach from every group / role / user (AWS refuses to delete an
    //    attached managed policy). Use ListEntitiesForPolicy as the source
    //    of truth rather than state's Groups/Roles/Users so a console-side
    //    attach made after deploy is also cleaned up.
    await this.detachAllPrincipals(physicalId, progress);

    // 2. Delete every non-default policy version (AWS refuses to delete a
    //    policy with non-default versions).
    await this.deleteAllNonDefaultVersions(physicalId);

    // 3. Delete the policy itself.
    await this.iamClient.send(new DeletePolicyCommand({ PolicyArn: physicalId }));

    this.logger.debug(`Successfully deleted IAM managed policy ${logicalId}`);
  } catch (error) {
    // Read back above but gone by `DeletePolicy` (a concurrent delete): the
    // same not-found arm as the read's.
    if (error instanceof NoSuchEntityException) {
      await this.goneOnDelete(logicalId, physicalId, resourceType, context, mask);
      return;
    }
    const cause = error instanceof Error ? error : undefined;
    const failure = this.wrapMaskedError(
      mask,
      error,
      (text) =>
        new ProvisioningError(
          `Failed to delete IAM managed policy ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          physicalId,
          cause
        )
    );
    // The wrap names an AWS failure by its CLASS, which the delete classifiers
    // read as "already deleted" on a `NotFound` needle: only the typed
    // not-found above means this one is gone (go-to-k/cdkd#2319). IAM's own
    // `NoSuchEntity` is not such a class.
    const marked =
      error instanceof Error && error.name.includes('NotFound') ? markNotGone(failure) : failure;
    throw progress.stripped ? markDeleteStarted(marked) : marked;
  }
}
