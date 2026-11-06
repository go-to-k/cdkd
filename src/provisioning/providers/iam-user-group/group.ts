import type { IAMUserGroupProvider } from '../iam-user-group-provider.js';
import {
  CreateGroupCommand,
  DeleteGroupCommand,
  GetGroupCommand,
  AttachGroupPolicyCommand,
  DetachGroupPolicyCommand,
  ListAttachedGroupPoliciesCommand,
  PutGroupPolicyCommand,
  DeleteGroupPolicyCommand,
  ListGroupPoliciesCommand,
  RemoveUserFromGroupCommand,
  NoSuchEntityException,
  UpdateGroupCommand,
  type Group,
} from '@aws-sdk/client-iam';
import { ProvisioningError } from '../../../utils/error-handler.js';
import { assertRegionMatch, type DeleteContext } from '../../region-check.js';
import { generateResourceNameWithFallback } from '../../resource-name.js';
import { createMaskedLogSinks, type MaskedLogSinks } from '../../masked-retry-logger.js';
import { pasteableAwsCommand } from '../../replacement-protection-advice.js';
import { markAuxiliaryFailure, markCreatedBeforeFailure } from '../../auxiliary-failure.js';
import { reportCreatedResource, retractCreatedResource } from '../../created-resource-sink.js';
import { iamEntityLeftByThisCreate } from '../iam-replay-adopt.js';
import { markDeleteStarted, type DeleteProgress } from '../../delete-started.js';
import { safeMsg } from '../../../utils/display-safe.js';
import type {
  InlinePolicyClaimed,
  ResourceCreateResult,
  ResourceUpdateResult,
} from '../../../types/resource.js';
import { userOrGroupIdentityToken, GROUP_NAME_MAX_LENGTH, iamPathOf } from './shared.js';

export async function createGroup(
  this: IAMUserGroupProvider,
  logicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  log: MaskedLogSinks
): Promise<ResourceCreateResult> {
  const { value: v } = log;
  log.debug(`Creating IAM group ${logicalId}`);

  const groupName = generateResourceNameWithFallback(
    properties['GroupName'] as string | undefined,
    logicalId,
    { maxLength: GROUP_NAME_MAX_LENGTH }
  );

  // go-to-k/cdkd#4583: set once CreateGroup returns, or a replay adopts its own
  // group (#5660); cleared when the partial-create cleanup deleted the group, so
  // only a left-behind one is marked.
  let leftBehind = false;
  // go-to-k/cdkd#4606: the GroupId CreateGroup answered with, as on the user.
  let createdGroupIdentity: string | undefined;
  try {
    const createParams: {
      GroupName: string;
      Path?: string;
    } = {
      GroupName: groupName,
    };

    if (properties['Path']) {
      createParams.Path = properties['Path'] as string;
    }

    const createClient = await this.createClient.get();
    let group: Group | undefined;
    let adopted = false;
    try {
      group = (await createClient.send(new CreateGroupCommand(createParams))).Group;
    } catch (createError) {
      // go-to-k/cdkd#5660, as on the user. Repeating `AttachGroupPolicy` and
      // `PutGroupPolicy` each succeeded when measured on real IAM (2026-11-03).
      group = await iamEntityLeftByThisCreate({
        logicalId,
        resourceType,
        noun: 'group',
        displayName: groupName,
        createError,
        namesThisEntity: (reported) => reported === groupName,
        read: async () =>
          (await this.iamClient.send(new GetGroupCommand({ GroupName: groupName, MaxItems: 1 })))
            .Group,
        identityOf: (live) => userOrGroupIdentityToken(live?.GroupId),
        log,
      });
      if (group === undefined) throw createError;
      adopted = true;
    }
    leftBehind = true;
    createdGroupIdentity = userOrGroupIdentityToken(group?.GroupId);
    if (!adopted) {
      reportCreatedResource(logicalId, resourceType, groupName, createdGroupIdentity); // go-to-k/cdkd#5511
    }

    // CreateGroupCommand has succeeded — AWS has now committed the
    // Group. Every subsequent call wires sub-resources onto it
    // (managed-policy attachments / inline policies); if any fail, the
    // group exists on AWS but cdkd state will NOT (the throw aborts
    // before the success-return). The next redeploy would then re-try
    // CREATE and AWS would reject with `EntityAlreadyExists: Group
    // with name <X> already exists`. Wrap the wiring in an inner
    // try/catch that detaches managed policies + deletes inline
    // policies + DeleteGroupCommand before re-throwing the original
    // error. The cleanup mirrors the order in `deleteGroup()` (but
    // skips `removeAllUsersFromGroup` — a freshly-created group has
    // no users); an adopted group skips this cleanup (see the catch).
    try {
      // Attach managed policies if specified
      const managedPolicyArns = properties['ManagedPolicyArns'] as string[] | undefined;
      if (managedPolicyArns && Array.isArray(managedPolicyArns)) {
        for (const policyArn of managedPolicyArns) {
          await this.iamClient.send(
            new AttachGroupPolicyCommand({
              GroupName: groupName,
              PolicyArn: policyArn,
            })
          );
          log.debug(`Attached managed policy ${v(policyArn)} to group ${v(groupName)}`);
        }
      }

      // Add inline policies if specified
      const policies = properties['Policies'] as
        | Array<{ PolicyName: string; PolicyDocument: unknown }>
        | undefined;
      if (policies && Array.isArray(policies)) {
        for (const policy of policies) {
          const policyDoc =
            typeof policy.PolicyDocument === 'string'
              ? policy.PolicyDocument
              : JSON.stringify(policy.PolicyDocument);
          await this.iamClient.send(
            new PutGroupPolicyCommand({
              GroupName: groupName,
              PolicyName: policy.PolicyName,
              PolicyDocument: policyDoc,
            })
          );
          log.debug(`Added inline policy ${v(policy.PolicyName)} to group ${v(groupName)}`);
        }
      }
    } catch (innerError) {
      // go-to-k/cdkd#5660: an adopted group is not stripped or deleted, see
      // `iamEntityLeftByThisCreate`.
      if (!adopted) {
        try {
          await this.detachAllGroupPolicies(groupName, log);
          await this.deleteAllGroupInlinePolicies(groupName, log);
          await this.iamClient.send(new DeleteGroupCommand({ GroupName: groupName }));
          retractCreatedResource(logicalId, resourceType, groupName);
          leftBehind = false;
          log.debug(
            `Cleaned up partially-created IAM group ${logicalId} (${v(groupName)}) after wiring failure`
          );
        } catch (cleanupError) {
          // The name is `generateResourceNameWithFallback`'s output, whose
          // default `allowedPattern` rewrites everything outside `[A-Za-z0-9-]`
          // (issue #3136), so it renders BARE -- but it can still BE a resolved
          // secret, so every command goes through `pasteableAwsCommand` with the
          // masker (issue #2177): a masked name is WITHHELD rather than printed
          // as `***`, which would act on a different principal. Pinned by this
          // type's partial-create cleanup test.
          const aws = pasteableAwsCommand(log.mask);
          const cleanupHead = `Failed to clean up partially-created IAM group ${logicalId} (${v(groupName)}): `;
          log.warn(
            `${cleanupHead}${this.cleanupFailureText(cleanupHead, cleanupError, log)} Manual deletion may be required before the next deploy: detach managed policies + delete inline policies, then ${aws`aws iam delete-group --group-name ${groupName}`.render()}`
          );
        }
      }
      // The resource itself was created: an "already exists" from its wiring
      // is an auxiliary object's, not this resource's name collision (#3826).
      throw markAuxiliaryFailure(innerError, logicalId);
    }

    log.debug(`Successfully created IAM group ${logicalId}: ${v(groupName)}`);

    return {
      physicalId: groupName,
      attributes: {
        Arn: group?.Arn,
      },
    };
  } catch (error) {
    const cause = error instanceof Error ? error : undefined;
    const thrown = this.wrapMaskedError(
      log.mask,
      error,
      (text) =>
        new ProvisioningError(
          `Failed to create IAM group ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          groupName,
          cause
        )
    );
    // With its GroupId (go-to-k/cdkd#4606), as on the user.
    if (leftBehind) {
      markCreatedBeforeFailure(thrown, logicalId, resourceType, groupName, createdGroupIdentity);
    }
    throw thrown;
  }
}

export async function updateGroup(
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
  log.debug(`Updating IAM group ${logicalId}: ${v(physicalId)}`);

  try {
    // `Path` in place, as for a user (#3723).
    const newPath = iamPathOf(properties['Path']);
    if (newPath !== iamPathOf(previousProperties['Path'])) {
      await this.iamClient.send(
        new UpdateGroupCommand({ GroupName: physicalId, NewPath: newPath })
      );
      log.debug(`Moved group ${v(physicalId)} to path ${v(newPath)}`);
    }

    // Update managed policies
    await this.updateGroupManagedPolicies(
      physicalId,
      properties['ManagedPolicyArns'] as string[] | undefined,
      previousProperties['ManagedPolicyArns'] as string[] | undefined,
      log
    );

    // Update inline policies
    await this.updateGroupInlinePolicies(
      physicalId,
      properties['Policies'] as Array<{ PolicyName: string; PolicyDocument: unknown }> | undefined,
      previousProperties['Policies'] as
        | Array<{ PolicyName: string; PolicyDocument: unknown }>
        | undefined,
      log,
      claimed
    );

    // Get updated group info
    const getGroupResponse = await this.iamClient.send(
      new GetGroupCommand({ GroupName: physicalId })
    );

    log.debug(`Successfully updated IAM group ${logicalId}`);

    return {
      physicalId,
      wasReplaced: false,
      attributes: {
        Arn: getGroupResponse.Group?.Arn,
      },
    };
  } catch (error) {
    const cause = error instanceof Error ? error : undefined;
    throw this.wrapMaskedError(
      log.mask,
      error,
      (text) =>
        new ProvisioningError(
          `Failed to update IAM group ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          physicalId,
          cause
        )
    );
  }
}

export async function deleteGroup(
  this: IAMUserGroupProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  context?: DeleteContext
): Promise<void> {
  // go-to-k/cdkd#2007: as on the user delete.
  const log = createMaskedLogSinks(this.logger, context?.maskSecrets);
  const { value: v } = log;
  log.debug(`Deleting IAM group ${logicalId}: ${v(physicalId)}`);
  // go-to-k/cdkd#4946: as on the user.
  const progress: DeleteProgress = { stripped: false };

  try {
    // Step 1: Detach all managed policies
    await this.detachAllGroupPolicies(physicalId, log, progress);

    // Step 2: Delete all inline policies
    await this.deleteAllGroupInlinePolicies(physicalId, log, progress);

    // Step 3: Remove all users from group
    await this.removeAllUsersFromGroup(physicalId, log, progress);

    // Step 4: Delete the group
    await this.iamClient.send(new DeleteGroupCommand({ GroupName: physicalId }));

    log.debug(`Successfully deleted IAM group ${logicalId}`);
  } catch (error) {
    if (error instanceof NoSuchEntityException) {
      const clientRegion = await this.iamClient.config.region();
      assertRegionMatch(clientRegion, context?.expectedRegion, resourceType, logicalId, physicalId);
      if (context?.failedCreateOrphan === true) {
        // As on the user (go-to-k/cdkd#4606).
        this.logger.info(
          safeMsg`  IAM group ${physicalId} (${logicalId}), which a failed deploy created, is already gone; nothing to delete`
        );
      } else {
        log.debug(`Group ${v(physicalId)} does not exist, skipping deletion`);
      }
      return;
    }
    const cause = error instanceof Error ? error : undefined;
    // Named by its class when AWS-authored (`wrapMaskedError`, issue #2319).
    const failure = this.wrapMaskedError(
      log.mask,
      error,
      (text) =>
        new ProvisioningError(
          log.mask(`Failed to delete IAM group ${logicalId}: ${text}`),
          resourceType,
          logicalId,
          physicalId,
          cause
        )
    );
    throw progress.stripped ? markDeleteStarted(failure) : failure;
  }
}

export async function detachAllGroupPolicies(
  this: IAMUserGroupProvider,
  groupName: string,
  // REQUIRED, so a create-path caller cannot silently fall back to an
  // unmasked sink; the delete path passes its own (issue #2007).
  log: MaskedLogSinks,
  progress?: DeleteProgress
): Promise<void> {
  const { value: v } = log;
  try {
    const response = await this.iamClient.send(
      new ListAttachedGroupPoliciesCommand({ GroupName: groupName })
    );

    const policies = response.AttachedPolicies || [];
    for (const policy of policies) {
      if (policy.PolicyArn) {
        try {
          await this.iamClient.send(
            new DetachGroupPolicyCommand({
              GroupName: groupName,
              PolicyArn: policy.PolicyArn,
            })
          );
          if (progress) progress.stripped = true;
          log.debug(`Detached managed policy ${v(policy.PolicyArn)} from group ${v(groupName)}`);
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

export async function removeAllUsersFromGroup(
  this: IAMUserGroupProvider,
  groupName: string,
  log: MaskedLogSinks,
  progress?: DeleteProgress
): Promise<void> {
  const { value: v } = log;
  try {
    const response = await this.iamClient.send(new GetGroupCommand({ GroupName: groupName }));

    const users = response.Users || [];
    for (const user of users) {
      if (user.UserName) {
        try {
          await this.iamClient.send(
            new RemoveUserFromGroupCommand({
              GroupName: groupName,
              UserName: user.UserName,
            })
          );
          if (progress) progress.stripped = true;
          log.debug(`Removed user ${v(user.UserName)} from group ${v(groupName)}`);
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

export async function updateGroupManagedPolicies(
  this: IAMUserGroupProvider,
  groupName: string,
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
        new AttachGroupPolicyCommand({
          GroupName: groupName,
          PolicyArn: policyArn,
        })
      );
      log.debug(`Attached managed policy ${v(policyArn)} to group ${v(groupName)}`);
    }
  }

  // Detach removed policies
  for (const policyArn of oldSet) {
    if (!newSet.has(policyArn)) {
      await this.iamClient.send(
        new DetachGroupPolicyCommand({
          GroupName: groupName,
          PolicyArn: policyArn,
        })
      );
      log.debug(`Detached managed policy ${v(policyArn)} from group ${v(groupName)}`);
    }
  }
}

export async function deleteAllGroupInlinePolicies(
  this: IAMUserGroupProvider,
  groupName: string,
  // REQUIRED, so a create-path caller cannot silently fall back to an
  // unmasked sink; the delete path passes its own (issue #2007).
  log: MaskedLogSinks,
  progress?: DeleteProgress
): Promise<void> {
  const { value: v } = log;
  try {
    const response = await this.iamClient.send(
      new ListGroupPoliciesCommand({ GroupName: groupName })
    );

    const policyNames = response.PolicyNames || [];
    for (const policyName of policyNames) {
      try {
        await this.iamClient.send(
          new DeleteGroupPolicyCommand({
            GroupName: groupName,
            PolicyName: policyName,
          })
        );
        if (progress) progress.stripped = true;
        log.debug(`Deleted inline policy ${v(policyName)} from group ${v(groupName)}`);
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

export async function updateGroupInlinePolicies(
  this: IAMUserGroupProvider,
  groupName: string,
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
      new PutGroupPolicyCommand({
        GroupName: groupName,
        PolicyName: policyName,
        PolicyDocument: policyDocument,
      })
    );
    log.debug(`Updated inline policy ${v(policyName)} on group ${v(groupName)}`);
  }

  // Delete removed policies
  // go-to-k/cdkd#4225: a name another resource has ALREADY written onto
  // this group in the same run is not removed. Set by a rollback revert,
  // where the policy that took this name over may have been put back
  // before this principal's own revert drops it.
  for (const policyName of oldMap.keys()) {
    if (!newMap.has(policyName)) {
      if (claimed?.('group', groupName, policyName) === true) {
        log.debug(
          `Kept inline policy ${v(policyName)} on group ${v(groupName)}: another resource of this deploy or rollback wrote it`
        );
        continue;
      }
      try {
        await this.iamClient.send(
          new DeleteGroupPolicyCommand({
            GroupName: groupName,
            PolicyName: policyName,
          })
        );
        log.debug(`Deleted inline policy ${v(policyName)} from group ${v(groupName)}`);
      } catch (error) {
        if (!(error instanceof NoSuchEntityException)) {
          throw error;
        }
      }
    }
  }
}
