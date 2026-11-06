import type { IAMUserGroupProvider } from '../iam-user-group-provider.js';
import {
  GetUserCommand,
  AttachUserPolicyCommand,
  DetachUserPolicyCommand,
  PutUserPolicyCommand,
  DeleteUserPolicyCommand,
  CreateLoginProfileCommand,
  UpdateLoginProfileCommand,
  AddUserToGroupCommand,
  RemoveUserFromGroupCommand,
  DeleteLoginProfileCommand,
  NoSuchEntityException,
  TagUserCommand,
  UntagUserCommand,
  PutUserPermissionsBoundaryCommand,
  DeleteUserPermissionsBoundaryCommand,
  UpdateUserCommand,
} from '@aws-sdk/client-iam';
import { ProvisioningError } from '../../../utils/error-handler.js';
import { planTagDiff, tagPlanWarning, refuseMalformedDesiredTags } from '../../tag-list.js';
import type { MaskedLogSinks } from '../../masked-retry-logger.js';
import { SECRET_DERIVED_READ_LIVE } from '../../iam-policy-targets.js';
import type { InlinePolicyClaimed, ResourceUpdateResult } from '../../../types/resource.js';
import { readPrincipalSides, iamPathOf } from './shared.js';

export async function updateUser(
  this: IAMUserGroupProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>,
  log: MaskedLogSinks,
  claimed: InlinePolicyClaimed | undefined
): Promise<ResourceUpdateResult> {
  const { value: v } = log;
  log.debug(`Updating IAM user ${logicalId}: ${v(physicalId)}`);
  // go-to-k/cdkd#3994: a malformed desired Tags is refused before any call.
  refuseMalformedDesiredTags(properties['Tags'], resourceType, logicalId, physicalId);
  // `Groups` on BOTH sides before any call (go-to-k/cdkd#3888): a string was
  // walked by character, removing the user from one-letter groups.
  const groups = await readPrincipalSides({
    desired: { Groups: properties['Groups'] },
    recorded: { Groups: previousProperties['Groups'] },
    subject: 'IAM user',
    nothingDone: 'no group membership, tag, policy or login profile was changed',
    names: 'group names',
    secretDerivedRepair: SECRET_DERIVED_READ_LIVE,
    // `deleteUser` reads the same list (`removeUserFromAllGroups`).
    readLive: async () => {
      try {
        return { Groups: await this.readLiveGroups(physicalId) };
      } catch (error) {
        throw new ProvisioningError(
          `ListGroupsForUser failed for IAM user ${logicalId}`,
          resourceType,
          logicalId,
          physicalId,
          error instanceof Error ? error : undefined
        );
      }
    },
    resourceType,
    logicalId,
    physicalId,
  });
  if (groups.unmatchedKinds.length > 0) {
    log.warn(
      `The recorded Groups of IAM user ${logicalId} is secret-derived, and IAM lists ` +
        `memberships the template does not name: cdkd removes the user from none of them, ` +
        `since IAM's list includes memberships made elsewhere. Remove the user by hand from ` +
        `any that this list used to name.`
    );
  }

  try {
    // `Path` is mutable in place, as CloudFormation applies it (#3723); an
    // absent one is IAM's default `/`, so a removed Path moves the user back.
    const newPath = iamPathOf(properties['Path']);
    if (newPath !== iamPathOf(previousProperties['Path'])) {
      await this.iamClient.send(new UpdateUserCommand({ UserName: physicalId, NewPath: newPath }));
      log.debug(`Moved user ${v(physicalId)} to path ${v(newPath)}`);
    }

    // Apply tag diff. IAM User uses TagUser/UntagUser keyed by UserName.
    await this.applyUserTagDiff(
      physicalId,
      resourceType,
      logicalId,
      previousProperties['Tags'],
      properties['Tags'],
      log
    );

    // Update permissions boundary
    const newPermBoundary = properties['PermissionsBoundary'] as string | undefined;
    const oldPermBoundary = previousProperties['PermissionsBoundary'] as string | undefined;
    if (newPermBoundary !== oldPermBoundary) {
      if (newPermBoundary) {
        await this.iamClient.send(
          new PutUserPermissionsBoundaryCommand({
            UserName: physicalId,
            PermissionsBoundary: newPermBoundary,
          })
        );
        log.debug(`Updated permissions boundary on user ${v(physicalId)}`);
      } else if (oldPermBoundary) {
        await this.iamClient.send(
          new DeleteUserPermissionsBoundaryCommand({ UserName: physicalId })
        );
        log.debug(`Removed permissions boundary from user ${v(physicalId)}`);
      }
    }

    // Update login profile
    const newLoginProfile = properties['LoginProfile'] as
      | { Password: string; PasswordResetRequired?: boolean }
      | undefined;
    const oldLoginProfile = previousProperties['LoginProfile'] as
      | { Password: string; PasswordResetRequired?: boolean }
      | undefined;
    if (newLoginProfile && !oldLoginProfile) {
      await this.iamClient.send(
        new CreateLoginProfileCommand({
          UserName: physicalId,
          Password: newLoginProfile.Password,
          PasswordResetRequired: newLoginProfile.PasswordResetRequired ?? false,
        })
      );
      log.debug(`Created login profile for user ${v(physicalId)}`);
    } else if (
      newLoginProfile &&
      oldLoginProfile &&
      // Only on a CHANGE, as CloudFormation does (go-to-k/cdkd#4461): an
      // update reached for another reason -- a tag, or re-adding the user to
      // a group the deploy re-created -- must not reset the password and
      // re-force a reset at the next sign-in. A secret-derived password is
      // recorded as its reference, so it still compares unequal and is sent.
      (newLoginProfile.Password !== oldLoginProfile.Password ||
        (newLoginProfile.PasswordResetRequired ?? false) !==
          (oldLoginProfile.PasswordResetRequired ?? false))
    ) {
      await this.iamClient.send(
        new UpdateLoginProfileCommand({
          UserName: physicalId,
          Password: newLoginProfile.Password,
          PasswordResetRequired: newLoginProfile.PasswordResetRequired ?? false,
        })
      );
      log.debug(`Updated login profile for user ${v(physicalId)}`);
    } else if (!newLoginProfile && oldLoginProfile) {
      try {
        await this.iamClient.send(new DeleteLoginProfileCommand({ UserName: physicalId }));
        log.debug(`Deleted login profile for user ${v(physicalId)}`);
      } catch (error) {
        if (!(error instanceof NoSuchEntityException)) {
          throw error;
        }
      }
    }

    // Update managed policies
    await this.updateUserManagedPolicies(
      physicalId,
      properties['ManagedPolicyArns'] as string[] | undefined,
      previousProperties['ManagedPolicyArns'] as string[] | undefined,
      log
    );

    // Update groups
    await this.updateUserGroups(physicalId, groups.next.Groups, groups.prev.Groups, log);

    // Update inline policies
    await this.updateUserInlinePolicies(
      physicalId,
      properties['Policies'] as Array<{ PolicyName: string; PolicyDocument: unknown }> | undefined,
      previousProperties['Policies'] as
        | Array<{ PolicyName: string; PolicyDocument: unknown }>
        | undefined,
      log,
      claimed
    );

    // Get updated user info
    const getUserResponse = await this.iamClient.send(new GetUserCommand({ UserName: physicalId }));

    return {
      physicalId,
      wasReplaced: false,
      attributes: {
        Arn: getUserResponse.User?.Arn,
      },
    };
  } catch (error) {
    const cause = error instanceof Error ? error : undefined;
    throw this.wrapMaskedError(
      log.mask,
      error,
      (text) =>
        new ProvisioningError(
          `Failed to update IAM user ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          physicalId,
          cause
        )
    );
  }
}

/**
 * Apply a diff between old and new CFn-shape Tags arrays via IAM's
 * `TagUser` / `UntagUser` APIs. Both sides are read through `planTagDiff`
 * (go-to-k/cdkd#3994): an unreadable record untags nothing.
 */
export async function applyUserTagDiff(
  this: IAMUserGroupProvider,
  userName: string,
  resourceType: string,
  logicalId: string,
  oldTagsRaw: unknown,
  newTagsRaw: unknown,
  log: MaskedLogSinks
): Promise<void> {
  const { value: v } = log;
  const plan = planTagDiff(oldTagsRaw, newTagsRaw);
  const tagWarning = tagPlanWarning(plan, resourceType, logicalId);
  if (tagWarning !== undefined) {
    log.warn(tagWarning);
  }
  const tagsToAdd = [...plan.set].map(([Key, Value]) => ({ Key, Value }));
  const tagsToRemove = plan.remove;

  if (tagsToRemove.length > 0) {
    await this.iamClient.send(new UntagUserCommand({ UserName: userName, TagKeys: tagsToRemove }));
    log.debug(`Removed ${tagsToRemove.length} tag(s) from IAM user ${v(userName)}`);
  }
  if (tagsToAdd.length > 0) {
    await this.iamClient.send(new TagUserCommand({ UserName: userName, Tags: tagsToAdd }));
    log.debug(`Added/updated ${tagsToAdd.length} tag(s) on IAM user ${v(userName)}`);
  }
}

export async function updateUserManagedPolicies(
  this: IAMUserGroupProvider,
  userName: string,
  newPolicies: string[] | undefined,
  oldPolicies: string[] | undefined,
  log: MaskedLogSinks
): Promise<void> {
  const { value: v } = log;
  const newSet = new Set(newPolicies || []);
  const oldSet = new Set(oldPolicies || []);

  // Attach new policies
  for (const policyArn of newSet) {
    if (!oldSet.has(policyArn)) {
      await this.iamClient.send(
        new AttachUserPolicyCommand({
          UserName: userName,
          PolicyArn: policyArn,
        })
      );
      log.debug(`Attached managed policy ${v(policyArn)} to user ${v(userName)}`);
    }
  }

  // Detach removed policies
  for (const policyArn of oldSet) {
    if (!newSet.has(policyArn)) {
      try {
        await this.iamClient.send(
          new DetachUserPolicyCommand({
            UserName: userName,
            PolicyArn: policyArn,
          })
        );
        log.debug(`Detached managed policy ${v(policyArn)} from user ${v(userName)}`);
      } catch (error) {
        if (!(error instanceof NoSuchEntityException)) {
          throw error;
        }
      }
    }
  }
}

export async function updateUserGroups(
  this: IAMUserGroupProvider,
  userName: string,
  newGroups: string[] | undefined,
  oldGroups: string[] | undefined,
  log: MaskedLogSinks
): Promise<void> {
  const { value: v } = log;
  const newSet = new Set(newGroups || []);
  const oldSet = new Set(oldGroups || []);

  // Add to new groups
  for (const groupName of newSet) {
    if (!oldSet.has(groupName)) {
      await this.iamClient.send(
        new AddUserToGroupCommand({
          UserName: userName,
          GroupName: groupName,
        })
      );
      log.debug(`Added user ${v(userName)} to group ${v(groupName)}`);
    }
  }

  // Remove from old groups
  for (const groupName of oldSet) {
    if (!newSet.has(groupName)) {
      try {
        await this.iamClient.send(
          new RemoveUserFromGroupCommand({
            UserName: userName,
            GroupName: groupName,
          })
        );
        log.debug(`Removed user ${v(userName)} from group ${v(groupName)}`);
      } catch (error) {
        if (!(error instanceof NoSuchEntityException)) {
          throw error;
        }
      }
    }
  }
}

export async function updateUserInlinePolicies(
  this: IAMUserGroupProvider,
  userName: string,
  newPolicies: Array<{ PolicyName: string; PolicyDocument: unknown }> | undefined,
  oldPolicies: Array<{ PolicyName: string; PolicyDocument: unknown }> | undefined,
  log: MaskedLogSinks,
  claimed: InlinePolicyClaimed | undefined
): Promise<void> {
  const { value: v } = log;
  const newMap = new Map((newPolicies || []).map((p) => [p.PolicyName, p.PolicyDocument]));
  const oldMap = new Map((oldPolicies || []).map((p) => [p.PolicyName, p.PolicyDocument]));

  // Add or update policies
  for (const [policyName, policyDoc] of newMap) {
    const policyDocument = typeof policyDoc === 'string' ? policyDoc : JSON.stringify(policyDoc);
    await this.iamClient.send(
      new PutUserPolicyCommand({
        UserName: userName,
        PolicyName: policyName,
        PolicyDocument: policyDocument,
      })
    );
    log.debug(`Updated inline policy ${v(policyName)} on user ${v(userName)}`);
  }

  // Delete removed policies
  // go-to-k/cdkd#4225: a name another resource has ALREADY written onto
  // this user in the same run is not removed. Set by a rollback revert,
  // where the policy that took this name over may have been put back
  // before this principal's own revert drops it.
  for (const policyName of oldMap.keys()) {
    if (!newMap.has(policyName)) {
      if (claimed?.('user', userName, policyName) === true) {
        log.debug(
          `Kept inline policy ${v(policyName)} on user ${v(userName)}: another resource of this deploy or rollback wrote it`
        );
        continue;
      }
      try {
        await this.iamClient.send(
          new DeleteUserPolicyCommand({
            UserName: userName,
            PolicyName: policyName,
          })
        );
        log.debug(`Deleted inline policy ${v(policyName)} from user ${v(userName)}`);
      } catch (error) {
        if (!(error instanceof NoSuchEntityException)) {
          throw error;
        }
      }
    }
  }
}
