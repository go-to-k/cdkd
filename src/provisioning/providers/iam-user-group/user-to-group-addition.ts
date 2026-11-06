import type { IAMUserGroupProvider } from '../iam-user-group-provider.js';
import {
  AddUserToGroupCommand,
  RemoveUserFromGroupCommand,
  NoSuchEntityException,
} from '@aws-sdk/client-iam';
import { ProvisioningError } from '../../../utils/error-handler.js';
import type { DeleteContext } from '../../region-check.js';
import { stateOrphanRecordRemedy } from '../../state-orphan-remedy.js';
import { createMaskedLogSinks, type MaskedLogSinks } from '../../masked-retry-logger.js';
import { markDeleteStarted } from '../../delete-started.js';
import { readPrincipalLists } from '../../iam-policy-targets.js';
import {
  isResolvableSecretPrincipalList,
  holdsUnprovenSecretPrincipalToken,
  resolveSecretDerivedPrincipals,
} from '../../secret-principal-resolution.js';
import { safeMsg } from '../../../utils/display-safe.js';
import { injectiveKey } from '../../../state/record-keys.js';
import type {
  ResourceCreateResult,
  ResourceUpdateResult,
  ResourceDeleteResult,
} from '../../../types/resource.js';
import {
  redactedDeleteAddressFields,
  redactedDeleteAddressSkip,
} from '../../redacted-delete-address.js';
import {
  MEMBERSHIP_NO_PROPERTIES_SKIP_REASON,
  MEMBERSHIP_MISSING_FIELDS_SKIP_REASON,
  MEMBERSHIP_MALFORMED_USERS_SKIP_REASON,
  MEMBERSHIP_SECRET_USER_NOT_MEMBER_SKIP_REASON,
  MEMBERSHIP_SECRET_DERIVED_REPAIR,
  readPrincipalSides,
  DEPLOY_SKIP_CAVEAT,
} from './shared.js';

export async function createUserToGroupAddition(
  this: IAMUserGroupProvider,
  logicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  log: MaskedLogSinks
): Promise<ResourceCreateResult> {
  const { value: v } = log;
  log.debug(`Creating IAM UserToGroupAddition ${logicalId}`);

  const groupName = properties['GroupName'] as string;
  const read = readPrincipalLists({ Users: properties['Users'] });
  if ('malformed' in read) {
    // Before any call (go-to-k/cdkd#3888).
    throw new ProvisioningError(
      `Users of IAM UserToGroupAddition ${logicalId} is not a list of IAM user names — no ` +
        `user was added to the group`,
      resourceType,
      logicalId
    );
  }
  const users = read.lists.Users;

  if (!groupName) {
    throw new ProvisioningError(`GroupName is required for ${logicalId}`, resourceType, logicalId);
  }
  if (!users || users.length === 0) {
    throw new ProvisioningError(`Users is required for ${logicalId}`, resourceType, logicalId);
  }

  try {
    for (const userName of users) {
      await this.iamClient.send(
        new AddUserToGroupCommand({
          GroupName: groupName,
          UserName: userName,
        })
      );
      log.debug(`Added user ${v(userName)} to group ${v(groupName)}`);
    }

    log.debug(`Successfully created IAM UserToGroupAddition ${logicalId}`);

    // Physical ID is the logical ID (no AWS-generated ID for this resource)
    return {
      physicalId: logicalId,
    };
  } catch (error) {
    const cause = error instanceof Error ? error : undefined;
    throw this.wrapMaskedError(
      log.mask,
      error,
      (text) =>
        new ProvisioningError(
          `Failed to create IAM UserToGroupAddition ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          undefined,
          cause
        )
    );
  }
}

export async function updateUserToGroupAddition(
  this: IAMUserGroupProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>,
  log: MaskedLogSinks
): Promise<ResourceUpdateResult> {
  const { value: v } = log;
  log.debug(`Updating IAM UserToGroupAddition ${logicalId}`);

  const users = await readPrincipalSides({
    desired: { Users: properties['Users'] },
    recorded: { Users: previousProperties['Users'] },
    subject: 'IAM UserToGroupAddition',
    nothingDone: 'no user was added to or removed from a group',
    names: 'user names',
    secretDerivedRepair: MEMBERSHIP_SECRET_DERIVED_REPAIR,
    resourceType,
    logicalId,
    physicalId,
  });
  const groupName = properties['GroupName'] as string;
  const newUsers = new Set(users.next.Users ?? []);
  const oldGroupName = previousProperties['GroupName'] as string;
  const oldUsers = new Set(users.prev.Users ?? []);

  try {
    // If group changed, remove from old group and add to new group
    if (oldGroupName && oldGroupName !== groupName) {
      for (const userName of oldUsers) {
        try {
          await this.iamClient.send(
            new RemoveUserFromGroupCommand({
              GroupName: oldGroupName,
              UserName: userName,
            })
          );
        } catch (error) {
          if (!(error instanceof NoSuchEntityException)) {
            throw error;
          }
        }
      }
      for (const userName of newUsers) {
        await this.iamClient.send(
          new AddUserToGroupCommand({
            GroupName: groupName,
            UserName: userName,
          })
        );
      }
    } else {
      // Same group: add new users, remove old users
      for (const userName of newUsers) {
        if (!oldUsers.has(userName)) {
          await this.iamClient.send(
            new AddUserToGroupCommand({
              GroupName: groupName,
              UserName: userName,
            })
          );
          log.debug(`Added user ${v(userName)} to group ${v(groupName)}`);
        }
      }
      for (const userName of oldUsers) {
        if (!newUsers.has(userName)) {
          try {
            await this.iamClient.send(
              new RemoveUserFromGroupCommand({
                GroupName: groupName,
                UserName: userName,
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

    return {
      physicalId,
      wasReplaced: false,
    };
  } catch (error) {
    const cause = error instanceof Error ? error : undefined;
    throw this.wrapMaskedError(
      log.mask,
      error,
      (text) =>
        new ProvisioningError(
          `Failed to update IAM UserToGroupAddition ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          physicalId,
          cause
        )
    );
  }
}

export async function deleteUserToGroupAddition(
  this: IAMUserGroupProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  properties?: Record<string, unknown>,
  context?: DeleteContext
): Promise<void | ResourceDeleteResult> {
  // UserToGroupAddition is metadata-only (RemoveUserFromGroup); the
  // "skipping" returns below trigger when input properties are missing,
  // not when AWS reports the user/group missing, so the region check
  // does not apply here. The context is read only for the destroy's
  // secret-principal opt-in (go-to-k/cdkd#4150).
  //
  // Issue #1770 re-judged both arms and CONVERTED them to `'skipped'`. They
  // logged at DEBUG, which reads as "routine, nothing to do" — but it is not:
  // `GroupName` and `Users` are both REQUIRED by the CloudFormation schema
  // for AWS::IAM::UserToGroupAddition, and `createUserToGroupAddition` above
  // THROWS on either being absent, so a record missing one cannot have come
  // from a successful create — it is CORRUPT, not empty. The memberships its
  // AddUserToGroup calls made therefore survive the destroy, and the users
  // keep every permission the group grants. That is exactly "cdkd could not
  // address it", and it is why the level is now WARN — a skip preserves state
  // and exits non-zero, and the user needs to see why at normal verbosity.
  //
  // An empty `Users: []` is a genuinely different shape and stays a
  // `deleted`: an array is truthy, so it falls through to the loop below and
  // correctly does nothing. Its producer is UPDATE, not create —
  // `updateUserToGroupAddition` diffs against the new list, so an EMPTY desired
  // `Users: []` removes every old user and records `[]`.
  // (Create cannot produce it: it rejects `users.length === 0`.)
  this.logger.debug(`Deleting IAM UserToGroupAddition ${logicalId}`);

  // Neither arm has a second source to fall back on, unlike the
  // Lambda-permission / IAM-policy arms: `RemoveUserFromGroup` is addressed
  // by GroupName + UserName, and this resource's physicalId is just the
  // logicalId (see `createUserToGroupAddition`), so it names neither.
  if (!properties) {
    this.logger.warn(
      `No properties for UserToGroupAddition ${logicalId}, skipping deletion — GroupName and ` +
        `Users are both required to call RemoveUserFromGroup, so no AWS call is issued and ` +
        `the group memberships are LEFT IN PLACE, UNLESS the group or the users are ` +
        `themselves part of this stack (their own deletes remove exactly these memberships, ` +
        `and then only the cdkd record is stale — clear it with ` +
        // go-to-k/cdkd#4602: the whole-stack form only on a stack destroy.
        `${stateOrphanRecordRemedy(context, logicalId)}). ` +
        `Otherwise restore the record's properties in state.json and re-run, or remove the ` +
        `users from the group by hand. ${DEPLOY_SKIP_CAVEAT}`
    );
    return { outcome: 'skipped', reason: MEMBERSHIP_NO_PROPERTIES_SKIP_REASON };
  }

  const groupName = properties['GroupName'] as string;
  const recordedUsers = properties['Users'] as string[];

  if (!groupName || !recordedUsers) {
    this.logger.warn(
      `Missing GroupName or Users for ${logicalId}, skipping deletion — both are required to ` +
        `call RemoveUserFromGroup, so no AWS call is issued and the group memberships are ` +
        `LEFT IN PLACE, UNLESS the group or the users are themselves part of this stack ` +
        `(their own deletes remove exactly these memberships, and then only the cdkd record ` +
        `is stale — clear it with ${stateOrphanRecordRemedy(context, logicalId)}). ` +
        `Otherwise restore them in ` +
        `state.json and re-run, or remove the users from the group by hand. ` +
        `${DEPLOY_SKIP_CAVEAT}`
    );
    return { outcome: 'skipped', reason: MEMBERSHIP_MISSING_FIELDS_SKIP_REASON };
  }

  // go-to-k/cdkd#3952: Users is read below (a redacted entry is malformed
  // there); GroupName is the other half of the address.
  const redactedGroup = redactedDeleteAddressSkip(
    this.logger,
    logicalId,
    'UserToGroupAddition',
    redactedDeleteAddressFields({ GroupName: properties['GroupName'] }),
    context
  );
  if (redactedGroup) return redactedGroup;

  // A present `Users` that is not a list of IAM user names (go-to-k/cdkd#3888):
  // refused before any call rather than guessing which users it names.
  const read = readPrincipalLists({ Users: properties['Users'] });
  // go-to-k/cdkd#4150: a Users list that is malformed ONLY because it holds
  // secret references is resolved, on a caller that opts in (a destroy), to
  // the users the CURRENT secret value names; see
  // `DeleteContext.resolveSecretDerivedPrincipals` for why a deploy must not.
  let users: string[] | undefined = 'malformed' in read ? undefined : read.lists.Users;
  let mask: (text: string) => string = (text) => text;
  let maskError: <T>(error: T) => T = (error) => error;
  let resolvedNames: ReadonlySet<string> = new Set();
  const memo = context?.resolveSecretDerivedPrincipals?.retryMemo;
  const optIn = context?.resolveSecretDerivedPrincipals;
  // A mask never resolves, so a list holding one is not attempted (and its
  // skip does not say "fix that and re-run").
  const resolutionAttempted =
    'malformed' in read &&
    optIn !== undefined &&
    isResolvableSecretPrincipalList(properties['Users']);
  if (resolutionAttempted) {
    // A retry of this delete reuses the first attempt's resolution (and does
    // not repeat its warning).
    const reused = memo?.resolved;
    const resolved =
      reused ??
      (await resolveSecretDerivedPrincipals(
        { Users: properties['Users'] },
        context?.expectedRegion,
        {
          regions: optIn.importedProducerRegions,
          complete: optIn.producerRegionsIncomplete !== true,
        },
        optIn.recordedRegions
      ));
    if (resolved && memo) memo.resolved = resolved;
    if (resolved?.lists['Users'] !== undefined) {
      users = resolved.lists['Users'];
      mask = resolved.mask;
      maskError = resolved.maskError;
      resolvedNames = resolved.resolvedNames['Users'] ?? new Set();
      if (reused === undefined) {
        this.logger.warn(
          safeMsg`UserToGroupAddition ${logicalId}: the recorded Users holds a secret reference, resolved to the users the secret names NOW. If its value changed since they were added, a user only the OLD value named stays in the group (remove it by hand), and a user only the CURRENT value names is removed even if it joined from elsewhere.`
        );
      }
    }
  }
  if ('malformed' in read && users === undefined) {
    // The same parent clause the missing-fields arm carries: a group or users
    // deleted by this destroy remove exactly these memberships.
    const repair =
      read.secretDerived.length > 0
        ? 'The recorded Users is secret-derived (cdkd keeps the dynamic reference or its mask ' +
          'in state), so do not write the name into state.json' +
          (resolutionAttempted
            ? optIn?.producerRegionsIncomplete === true &&
              holdsUnprovenSecretPrincipalToken(properties['Users'], optIn.recordedRegions)
              ? '; this nested stack was destroyed without its parent, so a reference with ' +
                "no recorded region is not resolved (it may name the parent's region): " +
                'destroy it through its top-level stack, or'
              : '; cdkd could not resolve the reference (its region, access to it, or its value), ' +
                'so fix that and re-run, or'
            : ':') +
          ' cdkd will keep skipping this record. Remove the users from the group by hand, then ' +
          `drop this record with ${stateOrphanRecordRemedy(context, logicalId)}.`
        : 'Repair the recorded Users in state.json to a list of user names and re-run, or ' +
          'remove the users from the group by hand.';
    this.logger.warn(
      safeMsg`The state record for UserToGroupAddition ${logicalId} holds a Users that is not a list of IAM user names — skipping deletion rather than guessing which users it names. No AWS call is issued, so the group memberships are LEFT IN PLACE, UNLESS the group or the users are themselves part of this stack (their own deletes remove exactly these memberships, and then only the cdkd record is stale — clear it with ${stateOrphanRecordRemedy(context, logicalId)}). ${repair} ${DEPLOY_SKIP_CAVEAT}`
    );
    return { outcome: 'skipped', reason: MEMBERSHIP_MALFORMED_USERS_SKIP_REASON };
  }

  // go-to-k/cdkd#4150: a user the secret's CURRENT value names outside the
  // group means the value may have rotated since the membership was added,
  // so a user only the OLD value named may still be a member. Reporting
  // DELETED would drop the record, the last trace of that membership.
  // `RemoveUserFromGroup` does NOT say so: for an existing user outside the
  // group it SUCCEEDS (measured), so membership is read first, from
  // `ListGroupsForUser` (paginated; a user holds at most 10 groups), for
  // each user a secret supplied that this delete has not removed already.
  let secretUserNotMember = false;
  // go-to-k/cdkd#4946: each removal is part of the delete itself, so a
  // refusal after one leaves a partial membership, never a whole survivor.
  let removedAny = false;
  try {
    for (const userName of users ?? []) {
      if (
        resolvedNames.has(userName) &&
        memo?.detached.has(injectiveKey('Users', userName)) !== true
      ) {
        let isMember: boolean;
        try {
          // IAM names are case-insensitive: a recorded GroupName in another
          // case names the same group.
          const wanted = groupName.toLowerCase();
          isMember = (await this.readLiveGroups(userName)).some((g) => g.toLowerCase() === wanted);
        } catch (error) {
          if (!(error instanceof NoSuchEntityException)) throw error;
          isMember = false;
        }
        if (!isMember) {
          secretUserNotMember = true;
          continue;
        }
      }
      try {
        await this.iamClient.send(
          new RemoveUserFromGroupCommand({
            GroupName: groupName,
            UserName: userName,
          })
        );
        removedAny = true;
        if (resolvedNames.has(userName)) memo?.detached.add(injectiveKey('Users', userName));
        this.logger.debug(`Removed user ${mask(userName)} from group ${groupName}`);
      } catch (error) {
        if (!(error instanceof NoSuchEntityException)) {
          throw error;
        }
        // An earlier attempt of THIS delete (the runner's retry) removing it
        // is not a rotation; a user gone since the membership read above is.
        if (
          resolvedNames.has(userName) &&
          memo?.detached.has(injectiveKey('Users', userName)) !== true
        ) {
          secretUserNotMember = true;
        }
      }
    }

    if (secretUserNotMember) {
      this.logger.warn(
        safeMsg`UserToGroupAddition ${logicalId}: a user the secret's CURRENT value names is not in the group. The value may have rotated since the membership was added, so a user only the OLD value named may still be a member; or an earlier cdkd run already removed it, or that user was deleted first. The record is KEPT rather than read as deleted: remove any old user from the group by hand (the users the current value names are done), then drop this record with 'cdkd orphan <constructPath>', or, with no CDK app, ${stateOrphanRecordRemedy(context, logicalId)}.`
      );
      return { outcome: 'skipped', reason: MEMBERSHIP_SECRET_USER_NOT_MEMBER_SKIP_REASON };
    }
    this.logger.debug(`Successfully deleted IAM UserToGroupAddition ${logicalId}`);
  } catch (error) {
    // go-to-k/cdkd#4150: the whole chain is masked, cause included — an SDK
    // error body can quote a principal name resolved from a secret. The
    // clone keeps each link's prototype, `$metadata` and markers, so the
    // retry classifiers read it as before.
    const cause = error instanceof Error ? error : undefined;
    // The marks survive `maskError`'s clone of the chain. An AWS-authored
    // failure is named by its class (`wrapMaskedError`, issue #2319), its text
    // logged at debug through the operation's masker as well as `mask`.
    const opMask = createMaskedLogSinks(this.logger, context?.maskSecrets).mask;
    const failure = this.wrapMaskedError(
      (text) => mask(opMask(text)),
      error,
      (text) =>
        new ProvisioningError(
          `Failed to delete IAM UserToGroupAddition ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          physicalId,
          cause
        )
    );
    throw maskError(removedAny ? markDeleteStarted(failure) : failure);
  }
}
