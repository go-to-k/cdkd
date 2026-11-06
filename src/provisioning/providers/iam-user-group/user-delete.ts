import type { IAMUserGroupProvider } from '../iam-user-group-provider.js';
import {
  DeleteUserCommand,
  GetUserCommand,
  DetachUserPolicyCommand,
  ListAttachedUserPoliciesCommand,
  DeleteUserPolicyCommand,
  ListUserPoliciesCommand,
  RemoveUserFromGroupCommand,
  ListGroupsForUserCommand,
  DeleteLoginProfileCommand,
  ListAccessKeysCommand,
  DeleteAccessKeyCommand,
  NoSuchEntityException,
  DeleteUserPermissionsBoundaryCommand,
} from '@aws-sdk/client-iam';
import { ProvisioningError } from '../../../utils/error-handler.js';
import { assertRegionMatch, type DeleteContext } from '../../region-check.js';
import { createMaskedLogSinks, type MaskedLogSinks } from '../../masked-retry-logger.js';
import { markDeleteStarted, type DeleteProgress } from '../../delete-started.js';
import { safeMsg } from '../../../utils/display-safe.js';

export async function deleteUser(
  this: IAMUserGroupProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  context?: DeleteContext
): Promise<void> {
  // go-to-k/cdkd#2007: the user name can be secret-derived. One sink set for
  // the whole delete, the cleanup helpers it shares with `update()` included.
  const log = createMaskedLogSinks(this.logger, context?.maskSecrets);
  const { value: v } = log;
  log.debug(`Deleting IAM user ${logicalId}: ${v(physicalId)}`);
  // go-to-k/cdkd#4946: set once a step below changes the user, so a refused
  // `DeleteUser` is never read as a whole survivor.
  const progress: DeleteProgress = { stripped: false };
  // Whether the read below saw a boundary: the delete of one is sent either way.
  let hadBoundary = false;

  try {
    // Check if user exists
    try {
      hadBoundary =
        (await this.iamClient.send(new GetUserCommand({ UserName: physicalId }))).User
          ?.PermissionsBoundary !== undefined;
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
            safeMsg`  IAM user ${physicalId} (${logicalId}), which a failed deploy created, is already gone; nothing to delete`
          );
        } else {
          log.debug(`User ${v(physicalId)} does not exist, skipping deletion`);
        }
        return;
      }
      throw error;
    }

    // Step 1: Remove from all groups
    await this.removeUserFromAllGroups(physicalId, log, progress);

    // Step 2: Detach all managed policies
    await this.detachAllUserPolicies(physicalId, log, progress);

    // Step 3: Delete all inline policies
    await this.deleteAllUserInlinePolicies(physicalId, log, progress);

    // Step 4: Delete login profile if exists
    try {
      await this.iamClient.send(new DeleteLoginProfileCommand({ UserName: physicalId }));
      progress.stripped = true;
      log.debug(`Deleted login profile for user ${v(physicalId)}`);
    } catch (error) {
      if (!(error instanceof NoSuchEntityException)) {
        throw error;
      }
    }

    // Step 5: Delete all access keys
    await this.deleteAllAccessKeys(physicalId, log, progress);

    // Step 6: Delete permissions boundary if exists
    try {
      await this.iamClient.send(new DeleteUserPermissionsBoundaryCommand({ UserName: physicalId }));
      if (hadBoundary) progress.stripped = true;
    } catch (error) {
      if (!(error instanceof NoSuchEntityException)) {
        throw error;
      }
    }

    // Step 7: Delete the user
    await this.iamClient.send(new DeleteUserCommand({ UserName: physicalId }));

    log.debug(`Successfully deleted IAM user ${logicalId}`);
  } catch (error) {
    const cause = error instanceof Error ? error : undefined;
    // Named by its class when AWS-authored (`wrapMaskedError`, issue #2319).
    const failure = this.wrapMaskedError(
      log.mask,
      error,
      (text) =>
        new ProvisioningError(
          log.mask(`Failed to delete IAM user ${logicalId}: ${text}`),
          resourceType,
          logicalId,
          physicalId,
          cause
        )
    );
    throw progress.stripped ? markDeleteStarted(failure) : failure;
  }
}

/** Every group the user belongs to, read from IAM (paginated). */
export async function readLiveGroups(
  this: IAMUserGroupProvider,
  userName: string
): Promise<string[]> {
  const groups: string[] = [];
  let marker: string | undefined;
  do {
    const resp = await this.iamClient.send(
      new ListGroupsForUserCommand({ UserName: userName, ...(marker && { Marker: marker }) })
    );
    for (const g of resp.Groups ?? []) if (g.GroupName) groups.push(g.GroupName);
    marker = resp.IsTruncated ? resp.Marker : undefined;
  } while (marker);
  return groups;
}

export async function removeUserFromAllGroups(
  this: IAMUserGroupProvider,
  userName: string,
  // REQUIRED, so a create-path caller cannot silently fall back to an
  // unmasked sink; the delete path passes its own (issue #2007).
  log: MaskedLogSinks,
  progress?: DeleteProgress
): Promise<void> {
  const { value: v } = log;
  try {
    const response = await this.iamClient.send(
      new ListGroupsForUserCommand({ UserName: userName })
    );

    const groups = response.Groups || [];
    for (const group of groups) {
      if (group.GroupName) {
        try {
          await this.iamClient.send(
            new RemoveUserFromGroupCommand({
              UserName: userName,
              GroupName: group.GroupName,
            })
          );
          if (progress) progress.stripped = true;
          log.debug(`Removed user ${v(userName)} from group ${v(group.GroupName)}`);
        } catch (error) {
          if (!(error instanceof NoSuchEntityException)) {
            throw error;
          }
        }
      }
    }
  } catch (error) {
    if (error instanceof NoSuchEntityException) {
      return;
    }
    throw error;
  }
}

export async function deleteAllAccessKeys(
  this: IAMUserGroupProvider,
  userName: string,
  log: MaskedLogSinks,
  progress?: DeleteProgress
): Promise<void> {
  const { value: v } = log;
  try {
    const response = await this.iamClient.send(new ListAccessKeysCommand({ UserName: userName }));

    const keys = response.AccessKeyMetadata || [];
    for (const key of keys) {
      if (key.AccessKeyId) {
        await this.iamClient.send(
          new DeleteAccessKeyCommand({
            UserName: userName,
            AccessKeyId: key.AccessKeyId,
          })
        );
        if (progress) progress.stripped = true;
        log.debug(`Deleted access key ${key.AccessKeyId} for user ${v(userName)}`);
      }
    }
  } catch (error) {
    if (error instanceof NoSuchEntityException) {
      return;
    }
    throw error;
  }
}

export async function detachAllUserPolicies(
  this: IAMUserGroupProvider,
  userName: string,
  // REQUIRED, so a create-path caller cannot silently fall back to an
  // unmasked sink; the delete path passes its own (issue #2007).
  log: MaskedLogSinks,
  progress?: DeleteProgress
): Promise<void> {
  const { value: v } = log;
  try {
    const response = await this.iamClient.send(
      new ListAttachedUserPoliciesCommand({ UserName: userName })
    );

    const policies = response.AttachedPolicies || [];
    for (const policy of policies) {
      if (policy.PolicyArn) {
        try {
          await this.iamClient.send(
            new DetachUserPolicyCommand({
              UserName: userName,
              PolicyArn: policy.PolicyArn,
            })
          );
          if (progress) progress.stripped = true;
          log.debug(`Detached managed policy ${v(policy.PolicyArn)} from user ${v(userName)}`);
        } catch (error) {
          if (!(error instanceof NoSuchEntityException)) {
            throw error;
          }
        }
      }
    }
  } catch (error) {
    if (error instanceof NoSuchEntityException) {
      return;
    }
    throw error;
  }
}

export async function deleteAllUserInlinePolicies(
  this: IAMUserGroupProvider,
  userName: string,
  // REQUIRED, so a create-path caller cannot silently fall back to an
  // unmasked sink; the delete path passes its own (issue #2007).
  log: MaskedLogSinks,
  progress?: DeleteProgress
): Promise<void> {
  const { value: v } = log;
  try {
    const response = await this.iamClient.send(new ListUserPoliciesCommand({ UserName: userName }));

    const policyNames = response.PolicyNames || [];
    for (const policyName of policyNames) {
      try {
        await this.iamClient.send(
          new DeleteUserPolicyCommand({
            UserName: userName,
            PolicyName: policyName,
          })
        );
        if (progress) progress.stripped = true;
        log.debug(`Deleted inline policy ${v(policyName)} from user ${v(userName)}`);
      } catch (error) {
        if (!(error instanceof NoSuchEntityException)) {
          throw error;
        }
      }
    }
  } catch (error) {
    if (error instanceof NoSuchEntityException) {
      return;
    }
    throw error;
  }
}
