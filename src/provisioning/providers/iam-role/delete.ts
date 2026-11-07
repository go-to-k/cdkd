import type { IAMRoleProvider } from '../iam-role-provider.js';
import {
  DeleteRoleCommand,
  GetRoleCommand,
  DeleteRolePolicyCommand,
  ListRolePoliciesCommand,
  DetachRolePolicyCommand,
  ListAttachedRolePoliciesCommand,
  ListInstanceProfilesForRoleCommand,
  RemoveRoleFromInstanceProfileCommand,
  NoSuchEntityException,
} from '@aws-sdk/client-iam';
import { ProvisioningError } from '../../../utils/error-handler.js';
import { assertRegionMatch, type DeleteContext } from '../../region-check.js';
import { markNotGone } from '../../not-gone.js';
import { createMaskedLogSinks, type MaskedLogSinks } from '../../masked-retry-logger.js';
import { markDeleteStarted, type DeleteProgress } from '../../delete-started.js';
import type { ResourceDeleteResult } from '../../../types/resource.js';
import { safeMsg } from '../../../utils/display-safe.js';

/**
 * Delete an IAM role
 *
 * Before deleting, performs full cleanup:
 * 1. Detach all managed policies
 * 2. Delete all inline policies
 * 3. Remove role from all instance profiles
 * 4. Delete the role itself
 */
export async function deleteImpl(
  this: IAMRoleProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  _properties?: Record<string, unknown>,
  context?: DeleteContext
): Promise<void | ResourceDeleteResult> {
  // go-to-k/cdkd#2007: the role name can be secret-derived. One sink set for
  // the whole delete, the cleanup helpers it shares with `update()` included.
  const log = createMaskedLogSinks(this.logger, context?.maskSecrets);
  const { value: v } = log;
  log.debug(`Deleting IAM role ${logicalId}: ${v(physicalId)}`);
  // go-to-k/cdkd#4946: set once a step below changes the role, so a refused
  // `DeleteRole` is never read as a whole survivor.
  const progress: DeleteProgress = { stripped: false };

  try {
    // Check if role exists
    try {
      await this.iamClient.send(new GetRoleCommand({ RoleName: physicalId }));
    } catch (error) {
      if (error instanceof NoSuchEntityException) {
        const clientRegion = await this.iamClient.config.region();
        assertRegionMatch(
          clientRegion,
          context?.expectedRegion,
          resourceType,
          logicalId,
          physicalId
        );
        if (context?.failedCreateOrphan === true) {
          // A journaled failed-CREATE orphan already gone settles with exit
          // 0 (go-to-k/cdkd#4606), so it is said once at info. The name is
          // interpolated verbatim for the caller's printing bag to mask.
          this.logger.info(
            safeMsg`  IAM role ${physicalId} (${logicalId}), which a failed deploy created, is already gone; nothing to delete`
          );
        } else {
          log.debug(`Role ${v(physicalId)} does not exist, skipping deletion`);
        }
        return;
      }
      throw error;
    }

    // Step 1: Detach all managed policies
    await this.detachAllManagedPolicies(physicalId, log, progress);

    // Step 2: Delete all inline policies
    await this.deleteAllInlinePolicies(physicalId, log, progress);

    // Step 3: Remove role from all instance profiles
    await this.removeFromAllInstanceProfiles(physicalId, log, progress);

    // Step 4: Delete the role
    await this.iamClient.send(new DeleteRoleCommand({ RoleName: physicalId }));

    log.debug(`Successfully deleted IAM role ${logicalId}`);
  } catch (error) {
    const cause = error instanceof Error ? error : undefined;
    const failure = this.wrapMaskedError(
      log.mask,
      error,
      (text) =>
        new ProvisioningError(
          log.mask(`Failed to delete IAM role ${logicalId}: ${text}`),
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

/**
 * Detach all managed policies from the role
 */
export async function detachAllManagedPolicies(
  this: IAMRoleProvider,
  roleName: string,
  // REQUIRED, so a create-path caller cannot silently fall back to an
  // unmasked sink; the delete path passes its own (issue #2007).
  log: MaskedLogSinks,
  progress?: DeleteProgress
): Promise<void> {
  const { value: v } = log;
  log.debug(`Detaching all managed policies from role ${v(roleName)}`);

  try {
    const attachedPolicies = await this.iamClient.send(
      new ListAttachedRolePoliciesCommand({ RoleName: roleName })
    );

    const policies = attachedPolicies.AttachedPolicies || [];
    if (policies.length === 0) {
      log.debug(`No managed policies attached to role ${v(roleName)}`);
      return;
    }

    for (const policy of policies) {
      if (policy.PolicyArn) {
        try {
          await this.iamClient.send(
            new DetachRolePolicyCommand({
              RoleName: roleName,
              PolicyArn: policy.PolicyArn,
            })
          );
          if (progress) progress.stripped = true;
          log.debug(`Detached managed policy ${v(policy.PolicyArn)} from role ${v(roleName)}`);
        } catch (error) {
          if (error instanceof NoSuchEntityException) {
            log.debug(
              `Managed policy ${v(policy.PolicyArn)} already detached from role ${v(roleName)}`
            );
          } else {
            throw error;
          }
        }
      }
    }

    log.debug(`Detached ${policies.length} managed policies from role ${v(roleName)}`);
  } catch (error) {
    if (error instanceof NoSuchEntityException) {
      log.debug(`Role ${v(roleName)} not found when detaching managed policies`);
      return;
    }
    throw error;
  }
}

/**
 * Delete all inline policies from the role
 */
export async function deleteAllInlinePolicies(
  this: IAMRoleProvider,
  roleName: string,
  // REQUIRED, so a create-path caller cannot silently fall back to an
  // unmasked sink; the delete path passes its own (issue #2007).
  log: MaskedLogSinks,
  progress?: DeleteProgress
): Promise<void> {
  const { value: v } = log;
  log.debug(`Deleting all inline policies from role ${v(roleName)}`);

  try {
    const inlinePolicies = await this.iamClient.send(
      new ListRolePoliciesCommand({ RoleName: roleName })
    );

    const policyNames = inlinePolicies.PolicyNames || [];
    if (policyNames.length === 0) {
      log.debug(`No inline policies on role ${v(roleName)}`);
      return;
    }

    for (const policyName of policyNames) {
      try {
        await this.iamClient.send(
          new DeleteRolePolicyCommand({
            RoleName: roleName,
            PolicyName: policyName,
          })
        );
        if (progress) progress.stripped = true;
        log.debug(`Deleted inline policy ${v(policyName)} from role ${v(roleName)}`);
      } catch (error) {
        if (error instanceof NoSuchEntityException) {
          log.debug(`Inline policy ${v(policyName)} already deleted from role ${v(roleName)}`);
        } else {
          throw error;
        }
      }
    }

    log.debug(`Deleted ${policyNames.length} inline policies from role ${v(roleName)}`);
  } catch (error) {
    if (error instanceof NoSuchEntityException) {
      log.debug(`Role ${v(roleName)} not found when deleting inline policies`);
      return;
    }
    throw error;
  }
}

/**
 * Remove the role from all instance profiles
 */
export async function removeFromAllInstanceProfiles(
  this: IAMRoleProvider,
  roleName: string,
  log: MaskedLogSinks,
  progress?: DeleteProgress
): Promise<void> {
  const { value: v } = log;
  log.debug(`Removing role ${v(roleName)} from all instance profiles`);

  try {
    const instanceProfiles = await this.iamClient.send(
      new ListInstanceProfilesForRoleCommand({ RoleName: roleName })
    );

    const profiles = instanceProfiles.InstanceProfiles || [];
    if (profiles.length === 0) {
      log.debug(`No instance profiles associated with role ${v(roleName)}`);
      return;
    }

    for (const profile of profiles) {
      if (profile.InstanceProfileName) {
        try {
          await this.iamClient.send(
            new RemoveRoleFromInstanceProfileCommand({
              RoleName: roleName,
              InstanceProfileName: profile.InstanceProfileName,
            })
          );
          if (progress) progress.stripped = true;
          log.debug(
            `Removed role ${v(roleName)} from instance profile ${v(profile.InstanceProfileName)}`
          );
        } catch (error) {
          if (error instanceof NoSuchEntityException) {
            log.debug(
              `Role ${v(roleName)} already removed from instance profile ${v(profile.InstanceProfileName)}`
            );
          } else {
            throw error;
          }
        }
      }
    }

    log.debug(`Removed role ${v(roleName)} from ${profiles.length} instance profiles`);
  } catch (error) {
    if (error instanceof NoSuchEntityException) {
      log.debug(`Role ${v(roleName)} not found when removing from instance profiles`);
      return;
    }
    throw error;
  }
}
