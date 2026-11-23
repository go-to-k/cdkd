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
import { markNonRetryable } from '../../../deployment/retryable-errors.js';
import { planTagDiff, tagPlanWarning, refuseMalformedDesiredTags } from '../../tag-list.js';
import type { MaskedLogSinks } from '../../masked-retry-logger.js';
import { diffPrincipalNames, SECRET_DERIVED_READ_LIVE } from '../../iam-policy-targets.js';
import type { InlinePolicyClaimed, ResourceUpdateResult } from '../../../types/resource.js';
import { readPrincipalSides, iamPathOf, userOrGroupIdentityToken } from './shared.js';
import { definedAttributes } from '../../attribute-map.js';
import { clearOwnWriteRemovals, recordOwnWriteRemoval } from '../../own-write-removals.js';
import { RecordedIdentityError } from '../../recorded-identity.js';
import {
  compareMembershipWrites,
  verifyOwnIdentityBeforeUpdate,
} from '../iam-policy/principal-identity.js';
import { planInlinePolicyNames, sameInlinePolicyName } from '../iam-role/update.js';
import { cdkdRemedy, proseQuoted } from '../../../utils/pasteable-command.js';

/**
 * go-to-k/cdkd#6609: each removal below is noted once its call succeeds (a
 * tolerated "not found" included), so the capture right after waits for it
 * (`own-write-removals.ts`).
 */
const USER_TYPE = 'AWS::IAM::User';

export async function updateUser(
  this: IAMUserGroupProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>,
  log: MaskedLogSinks,
  claimed: InlinePolicyClaimed | undefined,
  recordedAttributes?: Record<string, unknown>
): Promise<ResourceUpdateResult> {
  const { value: v } = log;
  log.debug(`Updating IAM user ${logicalId}: ${v(physicalId)}`);
  // go-to-k/cdkd#3994: a malformed desired Tags is refused before any call.
  refuseMalformedDesiredTags(properties['Tags'], resourceType, logicalId, physicalId);
  refuseLoginProfileWithoutPassword(
    properties,
    previousProperties,
    resourceType,
    logicalId,
    physicalId
  );
  // go-to-k/cdkd#6609: a note an earlier update that threw left behind.
  clearOwnWriteRemovals(USER_TYPE, physicalId);
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
    // go-to-k/cdkd#6722: every write below is by name, so a recorded UserId
    // is compared first, on the read this update makes for its attributes
    // (moved before the writes).
    const ownRead = await verifyOwnIdentityBeforeUpdate({
      label: 'IAM user',
      resourceType,
      permission: 'iam:GetUser',
      logicalId,
      physicalId,
      recordedAttributes,
      read: () => this.iamClient.send(new GetUserCommand({ UserName: physicalId })),
      idOf: (response) => response.User?.UserId,
    });
    // go-to-k/cdkd#6722: each in-stack group the user joins or leaves is
    // compared before any write. A group it leaves held by another id is
    // warned about and sent no removal; one it joins refuses the update.
    // go-to-k/cdkd#6774: a group respelled only in case is neither joined nor
    // left, here and in `updateUserGroups`.
    const groupDiff = diffPrincipalNames(groups.next.Groups, groups.prev.Groups);
    const skipRemoval = await compareMembershipWrites({
      client: this.iamClient,
      owner: { label: 'IAM user', resourceType, membership: true },
      logicalId,
      physicalId,
      adds: groupDiff.added.map((g) => [['group', g] as const]),
      removes: groupDiff.removed.map((g) => [['group', g] as const]),
      operation: 'update',
      warn: (message) => log.warn(message),
    });

    // `Path` is mutable in place, as CloudFormation applies it (#3723); an
    // absent one is IAM's default `/`, so a removed Path moves the user back.
    const newPath = iamPathOf(properties['Path']);
    const pathMoved = newPath !== iamPathOf(previousProperties['Path']);
    if (pathMoved) {
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
        recordOwnWriteRemoval(USER_TYPE, physicalId, 'PermissionsBoundary', oldPermBoundary);
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
      (loginPasswordChanged(newLoginProfile, oldLoginProfile) ||
        (newLoginProfile.PasswordResetRequired ?? false) !==
          (oldLoginProfile.PasswordResetRequired ?? false))
    ) {
      // go-to-k/cdkd#6755: a side without a password is a drift readback,
      // which never holds one (write-only). The live password is unknown
      // there, so the update sends none and leaves it as it is.
      await this.iamClient.send(
        new UpdateLoginProfileCommand({
          UserName: physicalId,
          ...(loginPasswordChanged(newLoginProfile, oldLoginProfile) && {
            Password: newLoginProfile.Password,
          }),
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
      // go-to-k/cdkd#6755: the capture right after records no profile rather
      // than a read that still shows this one.
      recordOwnWriteRemoval(USER_TYPE, physicalId, 'LoginProfile', 'LoginProfile');
    }

    // Update managed policies
    await this.updateUserManagedPolicies(
      physicalId,
      properties['ManagedPolicyArns'] as string[] | undefined,
      previousProperties['ManagedPolicyArns'] as string[] | undefined,
      log
    );

    // Update groups
    const skippedGroups = new Set(
      groupDiff.removed.filter((g) => skipRemoval([['group', g]])).map((g) => g.toLowerCase())
    );
    await this.updateUserGroups(
      physicalId,
      groups.next.Groups,
      // A skipped removal drops every spelling of that name, so the diff
      // `updateUserGroups` takes again cannot pick another (go-to-k/cdkd#6774).
      groups.prev.Groups?.filter((g) => !skippedGroups.has(g.toLowerCase())),
      log
    );

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

    // Get updated user info: a moved Path changes the Arn, so it is read again.
    const getUserResponse =
      (pathMoved ? undefined : ownRead) ??
      (await this.iamClient.send(new GetUserCommand({ UserName: physicalId })));

    return {
      physicalId,
      wasReplaced: false,
      // go-to-k/cdkd#6655: the UserId too, which a record without one
      // acquires (a recorded one is kept by the engine).
      attributes: {
        Arn: getUserResponse.User?.Arn,
        ...definedAttributes({ UserId: userOrGroupIdentityToken(getUserResponse.User?.UserId) }),
      },
    };
  } catch (error) {
    // The identity refusals: already worded (no AWS text) and marked.
    if (error instanceof RecordedIdentityError) throw error;
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
      recordOwnWriteRemoval(USER_TYPE, userName, 'ManagedPolicyArns', policyArn);
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
  // go-to-k/cdkd#6774: IAM group names ignore case, so a group respelled only
  // in case is the one the user is in: neither joined nor left.
  const { added, removed } = diffPrincipalNames(newGroups, oldGroups);

  // Add to new groups
  for (const groupName of added) {
    await this.iamClient.send(
      new AddUserToGroupCommand({
        UserName: userName,
        GroupName: groupName,
      })
    );
    log.debug(`Added user ${v(userName)} to group ${v(groupName)}`);
  }

  // Remove from old groups
  for (const groupName of removed) {
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
    recordOwnWriteRemoval(USER_TYPE, userName, 'Groups', groupName);
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
  const plan = planInlinePolicyNames(newMap.keys(), oldMap.keys());

  // Add or update policies. go-to-k/cdkd#6874: a name respelled only in
  // case is the same policy, so its old spelling is deleted right before the
  // put of the new one, as CloudFormation does, and the new spelling is
  // listed. A put that then fails puts the old spelling back with its
  // recorded document (best effort) before the error propagates, so the
  // principal is not left without the policy.
  for (const [policyName, policyDoc] of newMap) {
    const policyDocument = typeof policyDoc === 'string' ? policyDoc : JSON.stringify(policyDoc);
    const respelled = plan.respelled.filter((old) => sameInlinePolicyName(old, policyName));
    for (const old of respelled) {
      try {
        await this.iamClient.send(
          new DeleteUserPolicyCommand({ UserName: userName, PolicyName: old })
        );
      } catch (error) {
        if (!(error instanceof NoSuchEntityException)) throw error;
      }
      log.debug(`Deleted inline policy ${v(old)} before putting it as ${v(policyName)}`);
    }
    try {
      await this.iamClient.send(
        new PutUserPolicyCommand({
          UserName: userName,
          PolicyName: policyName,
          PolicyDocument: policyDocument,
        })
      );
    } catch (error) {
      for (const old of respelled) {
        const oldDoc = oldMap.get(old);
        try {
          await this.iamClient.send(
            new PutUserPolicyCommand({
              UserName: userName,
              PolicyName: old,
              PolicyDocument: typeof oldDoc === 'string' ? oldDoc : JSON.stringify(oldDoc),
            })
          );
        } catch {
          log.warn(
            `Could not put inline policy ${v(old)} back after its re-put as ${v(policyName)} failed; it is absent until the next deploy or ${proseQuoted(cdkdRemedy('cdkd drift', '--revert'))}`
          );
        }
      }
      throw error;
    }
    log.debug(`Updated inline policy ${v(policyName)} on user ${v(userName)}`);
  }

  // Delete removed policies
  // go-to-k/cdkd#4225: a name another resource has ALREADY written onto
  // this user in the same run is not removed. Set by a rollback revert,
  // where the policy that took this name over may have been put back
  // before this principal's own revert drops it.
  for (const policyName of plan.removed) {
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
    recordOwnWriteRemoval(USER_TYPE, userName, 'Policies', policyName);
  }
}

type LoginProfileBag = { Password?: string; PasswordResetRequired?: boolean };

/**
 * Whether the login profile's password changed: only when BOTH sides hold one
 * (go-to-k/cdkd#6755). A drift readback never holds the write-only password,
 * so a side without one says nothing about it.
 */
function loginPasswordChanged(next: LoginProfileBag, previous: LoginProfileBag): boolean {
  return (
    next.Password !== undefined &&
    previous.Password !== undefined &&
    next.Password !== previous.Password
  );
}

/**
 * Refuse, before any call, a login profile to CREATE with no password
 * (go-to-k/cdkd#6755). A template always declares one; a `drift --revert` of
 * a profile deleted out of band does not, since the readback never holds the
 * write-only password, and IAM refuses `CreateLoginProfile` without it after
 * the update's other writes had landed.
 */
function refuseLoginProfileWithoutPassword(
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>,
  resourceType: string,
  logicalId: string,
  physicalId: string
): void {
  const next = properties['LoginProfile'] as LoginProfileBag | undefined;
  if (!next || previousProperties['LoginProfile'] || next.Password != null) return;
  throw markNonRetryable(
    new ProvisioningError(
      `Cannot create the login profile of IAM user ${logicalId}: there is no password to send ` +
        '(it is write-only, so a drift readback carries none). An unchanged deploy does not ' +
        'create it either, since the state record still holds the login profile: create it ' +
        'outside cdkd with IAM CreateLoginProfile, or remove LoginProfile from the template, ' +
        'deploy, then add it back and deploy again. If the template declares no LoginProfile ' +
        '(the profile was recorded by drift --accept), record its removal with ' +
        'drift --accept instead.',
      resourceType,
      logicalId,
      physicalId
    )
  );
}
