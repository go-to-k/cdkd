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
  DeleteConflictException,
  ListGroupsForUserCommand,
  UpdateGroupCommand,
  type Group,
  type User,
  type GetGroupCommandOutput,
} from '@aws-sdk/client-iam';
import { ProvisioningError } from '../../../utils/error-handler.js';
import { markNonRetryable } from '../../../deployment/retryable-errors.js';
import {
  assertRegionMatch,
  holderRefusalMask,
  holderRefusalRun,
  type DeleteContext,
} from '../../region-check.js';
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
import { definedAttributes } from '../../attribute-map.js';
import { assertRecordedIdentity, RecordedIdentityError } from '../../recorded-identity.js';
import { stateOrphanRecordRemedy } from '../../state-orphan-remedy.js';
import { heldText, isStackOwnHolder, stackOwnHolders } from '../../stack-own-holders.js';
import { clearOwnWriteRemovals, recordOwnWriteRemoval } from '../../own-write-removals.js';
import { verifyOwnIdentityBeforeUpdate } from '../iam-policy/principal-identity.js';
import { planInlinePolicyNames } from '../iam-role/update.js';

/**
 * go-to-k/cdkd#6609: each removal an update makes is noted once its call
 * succeeds (a tolerated "not found" included), so the capture right after
 * waits for it (`own-write-removals.ts`).
 */
const GROUP_TYPE = 'AWS::IAM::Group';

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
      // go-to-k/cdkd#6655: the GroupId CreateGroup answered with (an adopted
      // group's, read from it), which a later delete compares.
      attributes: {
        Arn: group?.Arn,
        ...definedAttributes({ GroupId: createdGroupIdentity }),
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
  claimed: InlinePolicyClaimed | undefined,
  recordedAttributes?: Record<string, unknown>
): Promise<ResourceUpdateResult> {
  const { value: v } = log;
  log.debug(`Updating IAM group ${logicalId}: ${v(physicalId)}`);
  // go-to-k/cdkd#6609: a note an earlier update that threw left behind.
  clearOwnWriteRemovals(GROUP_TYPE, physicalId);

  try {
    // go-to-k/cdkd#6722: every write below is by name, so a recorded GroupId
    // is compared first, on the read this update makes for its attributes
    // (moved before the writes).
    const ownRead = await verifyOwnIdentityBeforeUpdate({
      label: 'IAM group',
      resourceType,
      permission: 'iam:GetGroup',
      logicalId,
      physicalId,
      recordedAttributes,
      read: () => this.iamClient.send(new GetGroupCommand({ GroupName: physicalId, MaxItems: 1 })),
      idOf: (response) => response.Group?.GroupId,
    });
    // `Path` in place, as for a user (#3723).
    const newPath = iamPathOf(properties['Path']);
    const pathMoved = newPath !== iamPathOf(previousProperties['Path']);
    if (pathMoved) {
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

    // Get updated group info: a moved Path changes the Arn, so it is read again.
    const getGroupResponse =
      (pathMoved ? undefined : ownRead) ??
      (await this.iamClient.send(new GetGroupCommand({ GroupName: physicalId })));

    log.debug(`Successfully updated IAM group ${logicalId}`);

    return {
      physicalId,
      wasReplaced: false,
      // go-to-k/cdkd#6655: the GroupId too, which a record without one
      // acquires (a recorded one is kept by the engine).
      attributes: {
        Arn: getGroupResponse.Group?.Arn,
        ...definedAttributes({
          GroupId: userOrGroupIdentityToken(getGroupResponse.Group?.GroupId),
        }),
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
    // Step 0: the `GetGroup` step 3 reads its members from, made first
    // (go-to-k/cdkd#6655): a record holding a `GroupId` refuses a holder of
    // the name with another one before anything is detached. No `GroupId`
    // recorded: the by-name delete as before. A group already gone answers
    // `NoSuchEntity` here, which the catch below reads as deleted. A user
    // added between this read and step 3 is not removed, so `DeleteGroup`
    // refuses (`DeleteConflict`) and the retry reads again.
    let members: User[] = [];
    let membersTruncated = false;
    // The `GroupId` step 0's last read answered: every later read by name
    // where step 3 leaves the members alone is held to it
    // (go-to-k/cdkd#6750).
    let stepZeroGroupId: string | undefined;
    const readGroup = async () => {
      const response = await this.iamClient.send(new GetGroupCommand({ GroupName: physicalId }));
      // The last read's: after a re-read, the group it answered for.
      members = response.Users ?? [];
      stepZeroGroupId = response.Group?.GroupId;
      membersTruncated = response.IsTruncated === true;
      // A response naming another group carries no id of this one: with an
      // id recorded, that refuses rather than compares. Compared ignoring
      // case: IAM group names are unique regardless of case and `GetGroup`
      // answers the stored spelling, so a record holding another case (an
      // import) names this very group.
      return response.Group?.GroupName?.toLowerCase() === physicalId.toLowerCase()
        ? response.Group.GroupId
        : undefined;
    };
    await assertRecordedIdentity({
      label: 'IAM group',
      resourceType,
      logicalId,
      physicalId,
      liveId: await readGroup(),
      reread: readGroup,
      context,
    });

    // A settle read answering another `GroupId` than step 0's: the name now
    // holds another group, which the by-name `DeleteGroup` must not reach.
    const sameGroup = (read: GetGroupCommandOutput): void => {
      if (stepZeroGroupId !== undefined && read.Group?.GroupId !== stepZeroGroupId) {
        // Worded for this path, not the pre-delete mismatch's: a DeleteGroup
        // was sent (and refused) and policies may have been detached, and
        // the id compared is step 0's live one, recorded or not.
        const refusal = markNonRetryable(
          new RecordedIdentityError(
            log.mask(
              `Failed to delete IAM group ${logicalId}: DeleteGroup on ${physicalId} was refused ` +
                `(DeleteConflict), and the group now holding that name is not the one this ` +
                `delete read before it (its GroupId differs). cdkd sends it no delete and keeps ` +
                `the record. Leave that group alone; if the group cdkd created is gone, drop ` +
                `the record with ${stateOrphanRecordRemedy(context, logicalId)}.`
            ),
            resourceType,
            logicalId,
            physicalId
          )
        );
        // Policies detached before the first DeleteGroup: as the member refusal.
        throw progress.stripped ? markDeleteStarted(refusal) : refusal;
      }
    };

    // The refusal of a group `held` names members of, whose membership this
    // run did not remove (go-to-k/cdkd#6750): worded, masked, non-retryable.
    const refuseHeld = (held: { names: string[]; truncated: boolean }, cause?: Error): never => {
      const run = holderRefusalRun(context);
      const refusal = markNonRetryable(
        new ProvisioningError(
          // go-to-k/cdkd#6772: a user the stack retained can be named from a secret.
          holderRefusalMask(
            context,
            log.mask
          )(
            `Failed to delete IAM group ${logicalId}: group ${physicalId} still has ` +
              `user(s) ${heldText(held)}, whose ` +
              `membership this ${run.noun} did not remove (a user added outside the stack, one ` +
              `retained by a DeletionPolicy, or a stack user whose own delete has not finished ` +
              `yet). Matching CloudFormation (DeleteConflict), cdkd ` +
              `does not remove them from the group. If a named user is one of this stack's ` +
              `users, ${run.rerun} once its delete finishes. Otherwise, if they no ` +
              `longer need the group, remove them (aws iam remove-user-from-group ` +
              `--group-name <group> --user-name <user>), then ${run.again}.`
          ),
          resourceType,
          logicalId,
          physicalId,
          cause
        )
      );
      MEMBER_REFUSALS.add(refusal);
      throw refusal;
    };

    // go-to-k/cdkd#6808: a delete that may strip its holders
    // (`stackHoldersStillAttached`: a same-name re-create's delete-first,
    // go-to-k/cdkd#4461) removes only the stack's OWN members, those the
    // records bound around this delete name, matched by `UserId` where one is
    // recorded. Any other member is refused HERE, before anything is changed:
    // a refused delete-first leaves the group with its policies and the
    // stack's memberships as their records say. A member that drains during
    // the settle (a user the run deleted, IAM still listing it) is no
    // refusal. A member list longer than one page is refused too: the users
    // past it are unread.
    let ownMembers: User[] = [];
    if (context?.stackHoldersStillAttached === true) {
      const own = stackOwnHolders(resourceType, physicalId);
      const isOwn = (user: User) =>
        user.UserName !== undefined && isStackOwnHolder(own, user.UserName, user.UserId);
      let read = { users: members, truncated: membersTruncated };
      const foreign = await settledMembers.call(
        this,
        physicalId,
        members,
        membersTruncated,
        sameGroup,
        (user) => !isOwn(user),
        (page) => (read = page)
      );
      if (foreign !== 'empty') refuseHeld(foreign);
      // Past one page the members are unread: refused, nothing changed.
      if (read.truncated) refuseHeld({ names: [], truncated: true });
      ownMembers = read.users.filter(isOwn);
    }

    // Step 1: Detach all managed policies
    await this.detachAllGroupPolicies(physicalId, log, progress);

    // Step 2: Delete all inline policies
    await this.deleteAllGroupInlinePolicies(physicalId, log, progress);

    // Step 3: Remove the stack's own members listed above. Every other
    // delete — a destroy (go-to-k/cdkd#6750), a template removal, a nested
    // child's teardown, a replaced group's cleanup, whose in-stack members
    // already moved to the new group (go-to-k/cdkd#6770) — leaves the members
    // alone: CloudFormation's delete handler holds no
    // `iam:RemoveUserFromGroup`, so `DeleteGroup` fails with `DeleteConflict`
    // while a user is still in the group, and the run removes or moves the
    // stack's own memberships (a user's `Groups`, an
    // `AWS::IAM::UserToGroupAddition`) before this delete, so a member left
    // here is not this run's to change.
    if (ownMembers.length > 0) {
      await this.removeAllUsersFromGroup(physicalId, log, progress, ownMembers);
    }

    // Step 4: Delete the group. Two attempts at most: the second only after
    // the settle below saw no user still in the group, i.e. what refused the
    // first was the stack's own membership being removed, or one step 3
    // removed that IAM still listed.
    for (let attempt = 1; ; attempt++) {
      try {
        await this.iamClient.send(new DeleteGroupCommand({ GroupName: physicalId }));
        break;
      } catch (error) {
        if (!(error instanceof DeleteConflictException)) throw error;
        // Step 0's read is the first listing; the rest runs only after the
        // refusal, so a delete that succeeds costs no extra call. The second
        // attempt's refusal reads the members once more (no settle) to name
        // them. A group gone meanwhile is deleted (the catch below), another
        // group under the name is refused; any other failed read leaves
        // AWS's error.
        const held = await (
          attempt === 1
            ? settledMembers.call(this, physicalId, members, membersTruncated, sameGroup)
            : currentMembers.call(this, physicalId, sameGroup)
        ).catch((readError) => {
          if (
            readError instanceof NoSuchEntityException ||
            readError instanceof RecordedIdentityError
          ) {
            throw readError;
          }
          log.debug(
            `Could not read the members of group ${v(physicalId)} after DeleteGroup was refused: ${readError instanceof Error ? readError.name : typeof readError}`
          );
          return undefined;
        });
        if (held === 'empty' && attempt === 1) continue;
        if (held === undefined || held === 'empty') throw error;
        refuseHeld(held, error);
      }
    }

    log.debug(`Successfully deleted IAM group ${logicalId}`);
  } catch (error) {
    // The member refusal: worded, masked and marked above.
    if (error instanceof Error && MEMBER_REFUSALS.has(error)) {
      throw progress.stripped ? markDeleteStarted(error) : error;
    }
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
    // The identity refusals: already worded (no AWS text) and marked.
    if (error instanceof RecordedIdentityError) throw error;
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

/**
 * The refusals of a group a user is still in (go-to-k/cdkd#6750),
 * passed through the delete's wrap unchanged. A set, not a subclass:
 * `ProvisioningError` resets its prototype, so `instanceof` on a subclass of
 * it never holds.
 */
const MEMBER_REFUSALS = new WeakSet<Error>();

/** At most this many users are named by the refusal. */
const HELD_NAME_LIMIT = 5;

/**
 * The refusal's settle (go-to-k/cdkd#6750): the group's members are read every
 * {@link HELD_POLL_MS} until they have stayed the same for
 * {@link HELD_STABLE_POLLS} reads in a row, or {@link HELD_MAX_POLLS} have run.
 * The stack's own memberships (a user's `Groups`, a `UserToGroupAddition`) are
 * removed before the group, but IAM can show a member for a while after; a
 * member list that changes is still draining, and one that empties lets
 * `DeleteGroup` be tried again. Only users that stay put for the whole window
 * (10 s), and that `ListGroupsForUser` then shows still in the group, are
 * refused; the cap (60 s) bounds a list that keeps changing.
 */
const HELD_POLL_MS = 2000;
const HELD_STABLE_POLLS = 5;
const HELD_MAX_POLLS = 30;

/**
 * The users still in the group once its member list has settled (see
 * {@link HELD_POLL_MS}), starting from step 0's read, each confirmed by
 * `ListGroupsForUser`; or `'empty'` when a read shows none or none is
 * confirmed.
 */
async function settledMembers(
  this: IAMUserGroupProvider,
  groupName: string,
  firstRead: User[],
  firstTruncated: boolean,
  sameGroup: (read: GetGroupCommandOutput) => void,
  /**
   * Narrows every read to the members that matter (go-to-k/cdkd#6808: those
   * not the stack's own); a read with none of them returns `'empty'` at once.
   */
  counts: (user: User) => boolean = () => true,
  /** Told each later read's members, unnarrowed. */
  onRead?: (page: { users: User[]; truncated: boolean }) => void
): Promise<{ names: string[]; truncated: boolean } | 'empty'> {
  let held = { names: memberNames(firstRead.filter(counts)), truncated: firstTruncated };
  if (held.names.length === 0) return 'empty';
  const key = (h: { names: string[]; truncated: boolean }) =>
    JSON.stringify([h.names, h.truncated]);
  let unchanged = 0;
  for (let poll = 0; poll < HELD_MAX_POLLS && unchanged < HELD_STABLE_POLLS; poll++) {
    await new Promise((resolve) => setTimeout(resolve, HELD_POLL_MS));
    const read = await this.iamClient.send(new GetGroupCommand({ GroupName: groupName }));
    sameGroup(read);
    onRead?.({ users: read.Users ?? [], truncated: read.IsTruncated === true });
    const next = {
      names: memberNames((read.Users ?? []).filter(counts)),
      truncated: read.IsTruncated === true,
    };
    if (next.names.length === 0) return 'empty';
    unchanged = key(next) === key(held) ? unchanged + 1 : 0;
    held = next;
  }
  return confirmedMembers.call(this, groupName, held);
}

/** One `GetGroup` read's members, confirmed (the second attempt's refusal). */
async function currentMembers(
  this: IAMUserGroupProvider,
  groupName: string,
  sameGroup: (read: GetGroupCommandOutput) => void
): Promise<{ names: string[]; truncated: boolean } | 'empty'> {
  const read = await this.iamClient.send(new GetGroupCommand({ GroupName: groupName }));
  sameGroup(read);
  const held = { names: memberNames(read.Users), truncated: read.IsTruncated === true };
  if (held.names.length === 0) return 'empty';
  return confirmedMembers.call(this, groupName, held);
}

function memberNames(users: User[] | undefined): string[] {
  return (users ?? []).map((user) => user.UserName).filter((n): n is string => !!n);
}

/**
 * The users of `held` that `ListGroupsForUser` shows still in the group, capped
 * at {@link HELD_NAME_LIMIT}, or `'empty'` when none is.
 */
async function confirmedMembers(
  this: IAMUserGroupProvider,
  groupName: string,
  held: { names: string[]; truncated: boolean }
): Promise<{ names: string[]; truncated: boolean } | 'empty'> {
  const names: string[] = [];
  for (const name of held.names) {
    // A user gone, or no longer in the group, is the read lagging. Any other
    // failure keeps the name, as the read shows it.
    try {
      const groups = await this.iamClient.send(new ListGroupsForUserCommand({ UserName: name }));
      if (
        (groups.Groups ?? []).some(
          (group) => group.GroupName?.toLowerCase() === groupName.toLowerCase()
        ) ||
        groups.IsTruncated === true
      ) {
        names.push(name);
      }
    } catch (error) {
      if (!(error instanceof NoSuchEntityException)) names.push(name);
    }
  }
  if (names.length === 0) return 'empty';
  return {
    names: names.slice(0, HELD_NAME_LIMIT),
    truncated: names.length > HELD_NAME_LIMIT || held.truncated,
  };
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
  progress: DeleteProgress | undefined,
  /** The members the delete's own `GetGroup` answered (go-to-k/cdkd#6655). */
  users: User[]
): Promise<void> {
  const { value: v } = log;
  try {
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
      recordOwnWriteRemoval(GROUP_TYPE, groupName, 'ManagedPolicyArns', policyArn);
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
  const plan = planInlinePolicyNames(newMap.keys(), oldMap.keys());

  // go-to-k/cdkd#6874: a name respelled only in case is the same policy;
  // its old spelling goes first, as CloudFormation does, so the put below
  // lists the new one.
  for (const policyName of plan.respelled) {
    try {
      await this.iamClient.send(
        new DeleteGroupPolicyCommand({ GroupName: groupName, PolicyName: policyName })
      );
    } catch (error) {
      if (!(error instanceof NoSuchEntityException)) throw error;
    }
    log.debug(`Deleted inline policy ${v(policyName)} before re-putting it in another case`);
  }

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
  for (const policyName of plan.removed) {
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
    recordOwnWriteRemoval(GROUP_TYPE, groupName, 'Policies', policyName);
  }
}
