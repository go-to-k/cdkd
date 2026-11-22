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

/**
 * Delete an IAM role
 *
 * Before deleting, performs full cleanup:
 * 1. Detach all managed policies
 * 2. Delete all inline policies
 * 3. Remove role from all instance profiles, only on a same-name re-create's
 *    delete-first (`stackHoldersStillAttached`); every other delete refuses a
 *    role a profile still holds instead (go-to-k/cdkd#6750, #6770)
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

    // Step 1: Detach all managed policies
    await this.detachAllManagedPolicies(physicalId, log, progress);

    // Step 2: Delete all inline policies
    await this.deleteAllInlinePolicies(physicalId, log, progress);

    // Step 3: Remove role from all instance profiles — only where the
    // stack's own profile may still hold it and is pointed at its
    // replacement afterwards (`stackHoldersStillAttached`: a same-name
    // re-create's delete-first, go-to-k/cdkd#4461). Every other delete — a
    // destroy (go-to-k/cdkd#6750), a template removal, a nested child's
    // teardown, a replaced copy's cleanup (go-to-k/cdkd#6770) — leaves the
    // profiles alone: CloudFormation's delete handler holds no
    // `iam:RemoveRoleFromInstanceProfile`, so `DeleteRole` fails with
    // `DeleteConflict` while a profile still holds the role, and the run
    // deletes or updates the stack's own profiles before this delete, so a
    // profile left here is not this run's to change.
    const stripHolders = context?.stackHoldersStillAttached === true;
    if (stripHolders) await this.removeFromAllInstanceProfiles(physicalId, log, progress);

    // Step 4: Delete the role. Two attempts at most where step 3 left the
    // profiles alone: the second only after the settle below saw no profile
    // still holding it, i.e. what refused the first was the stack's own
    // profile being deleted.
    for (let attempt = 1; ; attempt++) {
      try {
        await this.iamClient.send(new DeleteRoleCommand({ RoleName: physicalId }));
        break;
      } catch (error) {
        if (stripHolders || attempt > 1 || !(error instanceof DeleteConflictException)) {
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
            error
          )
        );
        PROFILE_REFUSALS.add(refusal);
        throw refusal;
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

async function listInstanceProfileNames(
  this: IAMRoleProvider,
  roleName: string
): Promise<{ names: string[]; truncated: boolean }> {
  // One page (IAM's default of 100), every name on it: the cap applies after
  // `GetInstanceProfile` has confirmed which ones still hold the role.
  const page = await this.iamClient.send(
    new ListInstanceProfilesForRoleCommand({ RoleName: roleName })
  );
  const names = (page.InstanceProfiles ?? [])
    .map((profile) => profile.InstanceProfileName)
    .filter((name): name is string => !!name);
  return { names, truncated: page.IsTruncated === true };
}

/**
 * The instance profiles still holding the role once the list has settled (see
 * {@link HELD_POLL_MS}) and `GetInstanceProfile` confirms each, or `'empty'`
 * when a listing shows none or none is confirmed.
 */
async function settledInstanceProfiles(
  this: IAMRoleProvider,
  roleName: string
): Promise<{ names: string[]; truncated: boolean } | 'empty'> {
  const key = (held: { names: string[]; truncated: boolean }) =>
    JSON.stringify([held.names, held.truncated]);
  let held = await listInstanceProfileNames.call(this, roleName);
  if (held.names.length === 0) return 'empty';
  let unchanged = 0;
  for (let poll = 0; poll < HELD_MAX_POLLS && unchanged < HELD_STABLE_POLLS; poll++) {
    await new Promise((resolve) => setTimeout(resolve, HELD_POLL_MS));
    const next = await listInstanceProfileNames.call(this, roleName);
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
