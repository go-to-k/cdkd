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
  DeleteConflictException,
  GetInstanceProfileCommand,
} from '@aws-sdk/client-iam';
import { ProvisioningError } from '../../../utils/error-handler.js';
import { markNonRetryable } from '../../../deployment/retryable-errors.js';
import { assertRegionMatch, holderRefusalRun, type DeleteContext } from '../../region-check.js';
import { markNotGone } from '../../not-gone.js';
import { stateOrphanRecordRemedy } from '../../state-orphan-remedy.js';
import { createMaskedLogSinks, type MaskedLogSinks } from '../../masked-retry-logger.js';
import { markDeleteStarted, type DeleteProgress } from '../../delete-started.js';
import type { ResourceDeleteResult } from '../../../types/resource.js';
import { safeMsg } from '../../../utils/display-safe.js';
import { assertRecordedIdentity, RecordedIdentityError } from '../../recorded-identity.js';
import { isStackOwnHolder, stackOwnHolders } from '../../stack-own-holders.js';

/**
 * Delete an IAM role
 *
 * Before deleting, performs full cleanup:
 * 1. Detach all managed policies
 * 2. Delete all inline policies
 * 3. Remove role from the stack's own instance profiles, only on a same-name
 *    re-create's delete-first (`stackHoldersStillAttached`); any other
 *    profile, and every profile on every other delete, is refused instead
 *    (go-to-k/cdkd#6750, #6770, #6808)
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

  // The `RoleId` step 0's last read answered: the second `DeleteRole` after a
  // settle is held to it (go-to-k/cdkd#6770), as the group's is to its
  // `GroupId`.
  let stepZeroRoleId: string | undefined;
  try {
    // Check if role exists, and (go-to-k/cdkd#6655) that it is the role cdkd
    // created: a record holding a `RoleId` refuses a holder of the name with
    // another one before anything is detached. No `RoleId` recorded: the
    // by-name delete as before.
    try {
      const readRoleId = async () => {
        const id = (await this.iamClient.send(new GetRoleCommand({ RoleName: physicalId }))).Role
          ?.RoleId;
        // The last read's: after a re-read, the role it answered for.
        stepZeroRoleId = id;
        return id;
      };
      await assertRecordedIdentity({
        label: 'IAM role',
        resourceType,
        logicalId,
        physicalId,
        liveId: await readRoleId(),
        reread: readRoleId,
        context,
      });
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

    // The refusal of a role `held` names profiles of, which this run did not
    // delete (go-to-k/cdkd#6750): worded, masked and non-retryable.
    const refuseHeld = (held: { names: string[]; truncated: boolean }, cause?: Error): never => {
      const run = holderRefusalRun(context);
      const refusal = markNonRetryable(
        new ProvisioningError(
          log.mask(
            `Failed to delete IAM role ${logicalId}: role ${physicalId} is still in ` +
              `instance profile(s) ${held.names.join(', ')}${held.truncated ? ', and more' : ''}, ` +
              `which this ${run.noun} did not delete (a profile created outside the stack, or ` +
              `retained by a DeletionPolicy). Matching CloudFormation (DeleteConflict), cdkd ` +
              `does not remove the role from them. If nothing still needs the role there, ` +
              `remove it (aws iam remove-role-from-instance-profile --instance-profile-name ` +
              `<profile> --role-name <role>) or delete the profile, then ${run.again}.`
          ),
          resourceType,
          logicalId,
          physicalId,
          cause
        )
      );
      PROFILE_REFUSALS.add(refusal);
      throw refusal;
    };

    // Step 1: Detach all managed policies
    await this.detachAllManagedPolicies(physicalId, log, progress);

    // Step 2: Delete all inline policies
    await this.deleteAllInlinePolicies(physicalId, log, progress);

    // Step 3: Remove role from the stack's OWN instance profiles — only where
    // they may still hold it and are pointed at its replacement afterwards
    // (`stackHoldersStillAttached`: a same-name re-create's delete-first,
    // go-to-k/cdkd#4461), and only those the records bound around this delete
    // name (go-to-k/cdkd#6808). Any other profile still holding it is refused
    // FIRST, before the stack's own is touched, so a refused delete-first
    // leaves that profile holding the role its record says; one that drains
    // during the settle (a profile the run deleted, IAM still listing it) is
    // no refusal. Every other delete — a destroy (go-to-k/cdkd#6750), a
    // template removal, a nested child's teardown, a replaced copy's cleanup
    // (go-to-k/cdkd#6770) — leaves the profiles alone: CloudFormation's
    // delete handler holds no `iam:RemoveRoleFromInstanceProfile`, so
    // `DeleteRole` fails with `DeleteConflict` while a profile still holds
    // the role, and the run deletes or updates the stack's own profiles before
    // this delete, so a profile left here is not this run's to change.
    if (context?.stackHoldersStillAttached === true) {
      const own = stackOwnHolders(resourceType, physicalId);
      const isOwn = (entry: ProfileEntry) => isStackOwnHolder(own, entry.name, entry.id);
      let listed: ProfileEntry[] = [];
      const foreign = await settledInstanceProfiles
        .call(
          this,
          physicalId,
          (entry) => !isOwn(entry),
          (entries) => (listed = entries)
        )
        .catch((listError: unknown) => {
          // The role gone since step 0: `DeleteRole` below says so.
          if (listError instanceof NoSuchEntityException) return 'empty' as const;
          throw listError;
        });
      if (foreign !== 'empty') refuseHeld(foreign);
      const ownNames = listed.filter(isOwn).map((entry) => entry.name);
      if (ownNames.length > 0) {
        await this.removeFromStackOwnInstanceProfiles(physicalId, log, progress, ownNames);
      }
    }

    // Step 4: Delete the role. Two attempts at most: the second only after
    // the settle below saw no profile still holding it, i.e. what refused the
    // first was the stack's own profile being deleted, or one step 3 removed
    // the role from that IAM still listed.
    for (let attempt = 1; ; attempt++) {
      try {
        await this.iamClient.send(new DeleteRoleCommand({ RoleName: physicalId }));
        break;
      } catch (error) {
        if (attempt > 1 || !(error instanceof DeleteConflictException)) {
          throw error;
        }
        // Read only after the refusal, so a delete that succeeds costs no
        // extra call; a listing that fails leaves AWS's error.
        const held = await settledInstanceProfiles.call(this, physicalId).catch((listError) => {
          log.debug(
            `Could not list the instance profiles of role ${v(physicalId)} after DeleteRole was refused: ${listError instanceof Error ? listError.name : typeof listError}`
          );
          return undefined;
        });
        if (held === 'empty') {
          // The retry deletes by name: hold it to the role step 0 read. A
          // role gone meanwhile is deleted; another role under the name is
          // refused, with nothing sent to it.
          let liveId: string | undefined;
          try {
            liveId = (await this.iamClient.send(new GetRoleCommand({ RoleName: physicalId }))).Role
              ?.RoleId;
          } catch (readError) {
            if (readError instanceof NoSuchEntityException) break;
            throw readError;
          }
          if (stepZeroRoleId !== undefined && liveId !== stepZeroRoleId) {
            const refusal = markNonRetryable(
              new RecordedIdentityError(
                log.mask(
                  `Failed to delete IAM role ${logicalId}: DeleteRole on ${physicalId} was refused ` +
                    `(DeleteConflict), and the role now holding that name is not the one this ` +
                    `delete read before it (its RoleId differs). cdkd sends it no delete and keeps ` +
                    `the record. Leave that role alone; if the role cdkd created is gone, drop ` +
                    `the record with ${stateOrphanRecordRemedy(context, logicalId)}.`
                ),
                resourceType,
                logicalId,
                physicalId
              )
            );
            throw progress.stripped ? markDeleteStarted(refusal) : refusal;
          }
          continue;
        }
        if (held === undefined) throw error;
        refuseHeld(held, error);
      }
    }

    log.debug(`Successfully deleted IAM role ${logicalId}`);
  } catch (error) {
    // The identity refusals: already worded (no AWS text) and marked.
    if (error instanceof RecordedIdentityError) throw error;
    // The instance-profile refusal: worded, masked and marked above.
    if (error instanceof Error && PROFILE_REFUSALS.has(error)) {
      throw progress.stripped ? markDeleteStarted(error) : error;
    }
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
 * The refusals of a role an instance profile still holds
 * (go-to-k/cdkd#6750), passed through the delete's wrap unchanged. A set, not a
 * subclass: `ProvisioningError` resets its prototype, so `instanceof` on a
 * subclass of it never holds.
 */
const PROFILE_REFUSALS = new WeakSet<Error>();

/** At most this many instance profiles are named by the refusal. */
const HELD_NAME_LIMIT = 5;

/**
 * The refusal's settle (go-to-k/cdkd#6750): the role's instance profiles are
 * listed every {@link HELD_POLL_MS} until the list has stayed the same for
 * {@link HELD_STABLE_POLLS} listings in a row, or {@link HELD_MAX_POLLS} have
 * run. An in-stack profile can be deleted at the same moment as its role (one
 * naming the role by a literal string has no edge to it), and IAM lists a
 * profile for a while after `DeleteInstanceProfile`; a list that changes is
 * still draining, and one that empties lets `DeleteRole` be tried again. Only
 * profiles that stay put for the whole window (10 s), and that
 * `GetInstanceProfile` then shows still holding the role, are refused; the cap
 * (60 s) bounds a list that keeps changing.
 */
const HELD_POLL_MS = 2000;
const HELD_STABLE_POLLS = 5;
const HELD_MAX_POLLS = 30;

/** One profile `ListInstanceProfilesForRole` lists: its name and `InstanceProfileId`. */
interface ProfileEntry {
  name: string;
  id: string | undefined;
}

async function listInstanceProfiles(
  this: IAMRoleProvider,
  roleName: string
): Promise<{ entries: ProfileEntry[]; truncated: boolean }> {
  // One page (IAM's default of 100), every profile on it: the cap applies
  // after `GetInstanceProfile` has confirmed which ones still hold the role.
  const page = await this.iamClient.send(
    new ListInstanceProfilesForRoleCommand({ RoleName: roleName })
  );
  const entries = (page.InstanceProfiles ?? []).flatMap((profile) =>
    profile.InstanceProfileName
      ? [{ name: profile.InstanceProfileName, id: profile.InstanceProfileId }]
      : []
  );
  return { entries, truncated: page.IsTruncated === true };
}

/**
 * The instance profiles still holding the role once the list has settled (see
 * {@link HELD_POLL_MS}) and `GetInstanceProfile` confirms each, or `'empty'`
 * when a listing shows none or none is confirmed. `counts` narrows every
 * listing to the profiles that matter (go-to-k/cdkd#6808: those not the
 * stack's own); a listing with none of them returns `'empty'` at once, so a
 * delete-first whose profiles are all the stack's lists once, as before.
 */
async function settledInstanceProfiles(
  this: IAMRoleProvider,
  roleName: string,
  counts: (entry: ProfileEntry) => boolean = () => true,
  /** Told each listing, unnarrowed; the last one told is the settled one. */
  onListing?: (entries: ProfileEntry[]) => void
): Promise<{ names: string[]; truncated: boolean } | 'empty'> {
  const key = (held: { names: string[]; truncated: boolean }) =>
    JSON.stringify([held.names, held.truncated]);
  const listed = async () => {
    const { entries, truncated } = await listInstanceProfiles.call(this, roleName);
    onListing?.(entries);
    return { names: entries.filter(counts).map((entry) => entry.name), truncated };
  };
  let held = await listed();
  if (held.names.length === 0) return 'empty';
  let unchanged = 0;
  for (let poll = 0; poll < HELD_MAX_POLLS && unchanged < HELD_STABLE_POLLS; poll++) {
    await new Promise((resolve) => setTimeout(resolve, HELD_POLL_MS));
    const next = await listed();
    if (next.names.length === 0) return 'empty';
    unchanged = key(next) === key(held) ? unchanged + 1 : 0;
    held = next;
  }
  const names: string[] = [];
  for (const name of held.names) {
    // Read the profile itself too: a profile gone, or no longer holding the
    // role, is the listing lagging. Any other read failure keeps the name, as
    // the settled listing shows it.
    try {
      const profile = await this.iamClient.send(
        new GetInstanceProfileCommand({ InstanceProfileName: name })
      );
      if ((profile.InstanceProfile?.Roles ?? []).some((role) => role.RoleName === roleName)) {
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
 * Remove the role from `profileNames`, the stack's own instance profiles
 * listed as holding it (go-to-k/cdkd#6808). Any other profile keeps the role,
 * so `DeleteRole` refuses (`DeleteConflict`) and the delete names it, as
 * CloudFormation's delete handler (which holds no
 * `iam:RemoveRoleFromInstanceProfile`) fails.
 */
export async function removeFromStackOwnInstanceProfiles(
  this: IAMRoleProvider,
  roleName: string,
  log: MaskedLogSinks,
  progress: DeleteProgress | undefined,
  profileNames: readonly string[]
): Promise<void> {
  const { value: v } = log;
  for (const profileName of profileNames) {
    try {
      await this.iamClient.send(
        new RemoveRoleFromInstanceProfileCommand({
          RoleName: roleName,
          InstanceProfileName: profileName,
        })
      );
      if (progress) progress.stripped = true;
      log.debug(`Removed role ${v(roleName)} from instance profile ${v(profileName)}`);
    } catch (error) {
      // The profile gone, the role no longer in it, or the role gone.
      if (!(error instanceof NoSuchEntityException)) throw error;
      log.debug(`Role ${v(roleName)} already removed from instance profile ${v(profileName)}`);
    }
  }
}
