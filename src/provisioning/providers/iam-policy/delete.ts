import type { IAMPolicyProvider } from '../iam-policy-provider.js';
import {
  DeleteRolePolicyCommand,
  DeleteGroupPolicyCommand,
  DeleteUserPolicyCommand,
  NoSuchEntityException,
} from '@aws-sdk/client-iam';
import { ProvisioningError } from '../../../utils/error-handler.js';
import { markDeleteStarted } from '../../delete-started.js';
import { assertRegionMatch, type DeleteContext } from '../../region-check.js';
import { createMaskedLogSinks } from '../../masked-retry-logger.js';
import {
  isResolvableSecretPrincipalList,
  holdsUnprovenSecretPrincipalToken,
  resolveSecretDerivedPrincipals,
} from '../../secret-principal-resolution.js';
import { safeMsg } from '../../../utils/display-safe.js';
import { injectiveKey } from '../../../state/record-keys.js';
import type { InlinePolicyPrincipalKind, ResourceDeleteResult } from '../../../types/resource.js';
import {
  isRedactedRecordedValue,
  redactedDeleteAddressSkip,
} from '../../redacted-delete-address.js';
import { stateOrphanRecordRemedy } from '../../state-orphan-remedy.js';
import {
  POLICY_NAME_SKIP_REASON,
  POLICY_NO_TARGET_SKIP_REASON,
  POLICY_MALFORMED_TARGET_SKIP_REASON,
  POLICY_SECRET_PRINCIPAL_LACKS_GRANT_SKIP_REASON,
  DEPLOY_SKIP_CAVEAT,
  readPolicyTargetLists,
} from './shared.js';

/**
 * Delete an IAM inline policy
 */
export async function deleteImpl(
  this: IAMPolicyProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  properties?: Record<string, unknown>,
  context?: DeleteContext
): Promise<void | ResourceDeleteResult> {
  this.logger.debug(`Deleting IAM policy ${logicalId}: ${physicalId}`);

  // Physical ID is the policy name (new format) or "policyName:roleName" (old format)
  const policyNameFromPhysicalId = physicalId.includes(':') ? physicalId.split(':')[0] : physicalId;

  // Issue #1770: every Delete*Policy call below is addressed by PolicyName,
  // and an empty one (physicalId `''` or a leading `:`) leaves nothing to
  // send. But the physicalId is not the only source — `PolicyName` is in
  // `handledProperties`, and `create()` uses `properties['PolicyName']`
  // verbatim as the real AWS name when the template sets it, so a record
  // whose physicalId lost the name may still carry it. The physicalId stays
  // FIRST (it is what was actually deployed, and it is the only source in the
  // generated-name case where the template set no PolicyName); properties are
  // the fallback. Skipping is expensive now — it preserves the record and
  // exits non-zero — so both sources are exhausted before reporting one.
  //
  // The `typeof` check is load-bearing and the emptiness check is NOT: a
  // non-string `PolicyName` (a number, an unresolved intrinsic object) would
  // otherwise be handed to `DeleteRolePolicy` as-is, while an empty string is
  // already falsy and falls through the `||` to the skip below.
  // go-to-k/cdkd#3952: a redacted PolicyName names nothing; the physicalId
  // stays the first source, and a redacted fallback is a named skip below.
  const recordedPolicyName = properties?.['PolicyName'];
  const policyNameRedacted = isRedactedRecordedValue(recordedPolicyName);
  const policyNameFromProperties =
    typeof recordedPolicyName === 'string' && !policyNameRedacted ? recordedPolicyName : undefined;
  const policyName = policyNameFromPhysicalId || policyNameFromProperties;

  // Target lists, hoisted out of the try below so the no-target guard can see
  // them. `legacyRoleFromPhysicalId` reproduces the legacy
  // "<policyName>:<roleName>" branch's own condition exactly, so the two
  // cannot drift.
  // Read through the reader `cdkd export`'s pre-delete shares, so the two
  // agree on which principals a record names (go-to-k/cdkd#3878). ABSENT
  // (`undefined` / `null`) stays `undefined` here, keeping the truthiness
  // tests below exactly as they were; a MALFORMED list is refused before any
  // AWS call, after the name check below.
  const targets = readPolicyTargetLists(properties);
  const malformedKinds = 'malformed' in targets ? targets.malformed : [];
  const secretDerivedKinds = 'malformed' in targets ? targets.secretDerived : [];
  let { roles, groups, users } =
    'malformed' in targets ? { roles: undefined, groups: undefined, users: undefined } : targets;
  // Masks every principal name a log line or error below prints. Identity
  // unless the names were resolved from a secret (go-to-k/cdkd#4150).
  let mask: (text: string) => string = (text) => text;
  let maskError: <T>(error: T) => T = (error) => error;
  // Whether a secret supplied this principal name (not a plain sibling).
  let fromSecret: (kind: string, name: string) => boolean = () => false;
  let resolvedFromSecret = false;
  let legacyRoleFromPhysicalId =
    !roles && !groups && !users && physicalId.includes(':') ? physicalId.split(':')[1] : undefined;

  if (!policyName && policyNameRedacted) {
    const skip = redactedDeleteAddressSkip(
      this.logger,
      logicalId,
      'IAM policy',
      ['PolicyName'],
      context
    );
    if (skip) return skip;
  }

  if (!policyName) {
    this.logger.warn(
      `Invalid physical ID format: ${physicalId}, and no PolicyName in the state record's ` +
        `properties — skipping deletion. No AWS call is issued, so the inline policy is LEFT ` +
        `ATTACHED to its roles / groups / users, UNLESS the role / group / user it is attached ` +
        `to is itself part of this stack (deleting that principal removes its inline policies, ` +
        `and then only the cdkd record is stale — clear it with ` +
        // go-to-k/cdkd#4602: the whole-stack form only on a stack destroy.
        `${stateOrphanRecordRemedy(context, logicalId)}). ` +
        `Otherwise repair the physicalId in state.json and re-run, or delete the inline policy ` +
        `by hand. ${DEPLOY_SKIP_CAVEAT}`
    );
    return { outcome: 'skipped', reason: POLICY_NAME_SKIP_REASON };
  }

  // go-to-k/cdkd#4150: a list that is malformed ONLY because it holds secret
  // references is resolved, on a caller that opts in (a destroy; see
  // `DeleteContext.resolveSecretDerivedPrincipals` for why a deploy must
  // not), to the names the CURRENT secret value holds. Anything the helper
  // cannot resolve keeps the skip below.
  // A mask never resolves, so a list holding one is not attempted (and its
  // skip does not say "fix that and re-run").
  const optIn = context?.resolveSecretDerivedPrincipals;
  const recordedLists: Record<string, unknown> = {
    Roles: properties?.['Roles'],
    Groups: properties?.['Groups'],
    Users: properties?.['Users'],
  };
  const resolutionAttempted =
    malformedKinds.length > 0 &&
    optIn !== undefined &&
    malformedKinds.every((k) => isResolvableSecretPrincipalList(recordedLists[k]));
  if (resolutionAttempted && 'malformed' in targets) {
    const values = Object.fromEntries(malformedKinds.map((k) => [k, recordedLists[k]]));
    // A retry of this delete reuses the first attempt's resolution (and does
    // not repeat its warning).
    const memo = optIn.retryMemo;
    const reused = memo?.resolved;
    const resolved =
      reused ??
      (await resolveSecretDerivedPrincipals(
        values,
        context?.expectedRegion,
        {
          regions: optIn.importedProducerRegions,
          complete: optIn.producerRegionsIncomplete !== true,
        },
        optIn.recordedRegions
      ));
    if (resolved && memo) memo.resolved = resolved;
    if (resolved) {
      roles = (resolved.lists['Roles'] as string[] | undefined) ?? targets.wellFormed.roles;
      groups = (resolved.lists['Groups'] as string[] | undefined) ?? targets.wellFormed.groups;
      users = (resolved.lists['Users'] as string[] | undefined) ?? targets.wellFormed.users;
      mask = resolved.mask;
      maskError = resolved.maskError;
      fromSecret = (kind, name) => resolved.resolvedNames[kind]?.has(name) === true;
      resolvedFromSecret = true;
      // The lists name the principals now; the legacy segment is only for
      // a record with none.
      legacyRoleFromPhysicalId = undefined;
      const kinds = malformedKinds.join(' / ');
      if (reused === undefined) {
        this.logger.warn(
          safeMsg`IAM policy ${logicalId}: the recorded ${kinds} holds a secret reference, resolved to the principals the secret names NOW. If its value changed since the policy was attached, a principal only the OLD value named keeps the inline policy (delete it from that principal by hand), and a principal only the CURRENT value names loses a same-named inline policy it held from elsewhere.`
        );
      }
    }
  }

  if (malformedKinds.length > 0 && !resolvedFromSecret) {
    // go-to-k/cdkd#3907: a secret-derived kind stays `{{resolve:...}}` (or
    // `***`) in state by design, so "repair state.json" would have the user
    // write the secret-derived name into it; it is named apart, with the way
    // out that holds for it.
    // With any kind secret-derived, a state.json repair of a PLAIN kind alone
    // would still skip, so that repair is not offered beside it.
    const plainKinds = malformedKinds.filter((k) => !secretDerivedKinds.includes(k));
    const repair =
      secretDerivedKinds.length === 0
        ? `Repair ${plainKinds.join(' / ')} in state.json to a list of role / group / user ` +
          `names and re-run, or delete the inline policy by hand.`
        : `The recorded ${secretDerivedKinds.join(' / ')} is secret-derived (cdkd keeps the ` +
          `dynamic reference or its mask in state), so do not write the name into ` +
          `state.json` +
          (resolutionAttempted
            ? optIn?.producerRegionsIncomplete === true &&
              secretDerivedKinds.some((k) =>
                holdsUnprovenSecretPrincipalToken(recordedLists[k], optIn.recordedRegions)
              )
              ? `; this nested stack was destroyed without its parent, so a reference with ` +
                `no recorded region is not resolved (it may name the parent's region): ` +
                `destroy it through its top-level stack, or`
              : `; cdkd could not resolve the reference (its region, access to it, or its ` +
                `value), so fix that and re-run, or`
            : `:`) +
          ` cdkd will keep skipping this record` +
          (plainKinds.length > 0
            ? `, whatever is repaired in the recorded ${plainKinds.join(' / ')}`
            : '') +
          `. Remove the inline policy from its principals by hand (a principal this stack ` +
          `also deletes takes its inline policies with it), then drop this record with ` +
          `${stateOrphanRecordRemedy(context, logicalId)}.`;
    this.logger.warn(
      `The state record for IAM policy ${logicalId} holds ${malformedKinds.join(' / ')} that ` +
        `is not a list of IAM names — skipping deletion rather than guessing which principals ` +
        `it names. No AWS call is issued, so the inline policy is LEFT ATTACHED wherever it ` +
        `is. ${repair} ${DEPLOY_SKIP_CAVEAT}`
    );
    return { outcome: 'skipped', reason: POLICY_MALFORMED_TARGET_SKIP_REASON };
  }

  // Issue #1770 review: an inline policy exists ONLY as an attachment, so a
  // record that names no principal cannot be deleted. Without any target list
  // and without the legacy role segment, every branch in the try below is
  // skipped, delete() falls out having issued ZERO AWS calls, and returns
  // `undefined` — i.e. DELETED — over a policy that may still be attached and
  // still granting. That hole predates the PolicyName fallback above
  // (`physicalId: 'MyPolicy'` with empty properties already reached it), but
  // the fallback newly ROUTES formerly-skipped records into it, so it is
  // closed here rather than left to be inherited.
  //
  // A PRESENT but empty list (`Roles: []`) is deliberately NOT a skip: an
  // empty attachment set means nothing is attached, so there is genuinely
  // nothing to remove — the same judgment as `Users: []` on
  // AWS::IAM::UserToGroupAddition. An array is truthy, so `!roles` already
  // distinguishes that from absence, and using the SAME truthiness test the
  // legacy branch and the loops below use is what keeps the three in step:
  // a `=== undefined` spelling would let a null-valued `Roles` (which a
  // hand-edited or pre-v7 state file can carry) fall through the guard into
  // the very zero-AWS-call path it exists to close.
  if (!roles && !groups && !users && !legacyRoleFromPhysicalId) {
    this.logger.warn(
      `No Roles, Groups or Users in the state record for IAM policy ${logicalId} ` +
        `(physicalId "${physicalId}"), skipping deletion — an inline policy exists only as an ` +
        `attachment, so with no principal named there is no delete to issue and the policy is ` +
        `LEFT ATTACHED wherever it is, UNLESS the role / group / user it is attached to is ` +
        `itself part of this stack (deleting that principal removes its inline policies, and ` +
        `then only the cdkd record is stale — clear it with ` +
        `${stateOrphanRecordRemedy(context, logicalId)}). ` +
        `Otherwise restore Roles / Groups / Users in state.json and re-run, or delete the ` +
        `inline policy by hand. ${DEPLOY_SKIP_CAVEAT}`
    );
    return { outcome: 'skipped', reason: POLICY_NO_TARGET_SKIP_REASON };
  }

  // Each per-target loop swallows NoSuchEntityException as idempotent
  // delete success. A region mismatch would otherwise let *every* such
  // exception slip through silently and orphan the underlying inline
  // policy attachments. Assert region once up front: IAM is global, but
  // the client region is still meaningful when the destroy run is
  // pointing at a different account/region than where the stack was
  // deployed.
  // go-to-k/cdkd#4150: a principal the secret's CURRENT value names that
  // lacks the policy means the value may have rotated since the attachment,
  // so the grant may still sit on a principal only the OLD value named.
  // Reporting DELETED would drop the record, the last trace of that grant.
  // An earlier attempt of THIS delete (the runner's retry) that detached it
  // is not that: `detached` remembers those.
  let secretPrincipalLacksGrant = false;
  const detached = context?.resolveSecretDerivedPrincipals?.retryMemo?.detached;
  // go-to-k/cdkd#4946: each removal is part of the delete itself, so a
  // refusal after one leaves the policy on only some principals, never a
  // whole survivor.
  let removedAny = false;
  const onDetached = (kind: string, name: string): void => {
    removedAny = true;
    if (fromSecret(kind, name)) detached?.add(injectiveKey(kind, name));
  };
  // go-to-k/cdkd#4156: a principal another resource of this deploy already
  // wrote this name onto keeps it (the deploy's DELETE phase runs after every
  // create and update).
  const claimed = (kind: InlinePolicyPrincipalKind, name: string): boolean => {
    if (context?.inlinePolicyClaimed?.(kind, name, policyName) !== true) {
      return false;
    }
    this.logger.debug(
      safeMsg`Kept inline policy ${policyName} on ${kind} ${mask(name)}: another resource of this deploy or rollback wrote it`
    );
    return true;
  };
  const onNotFound = async (
    target: string,
    principal?: { kind: string; name: string }
  ): Promise<void> => {
    const clientRegion = await this.iamClient.config.region();
    assertRegionMatch(
      clientRegion,
      context?.expectedRegion,
      resourceType,
      logicalId,
      `${physicalId} (${target})`
    );
    if (
      principal !== undefined &&
      fromSecret(principal.kind, principal.name) &&
      detached?.has(injectiveKey(principal.kind, principal.name)) !== true
    ) {
      secretPrincipalLacksGrant = true;
    }
  };

  try {
    // If no properties available, try legacy format (physicalId = "policyName:roleName").
    // The target lists and this role segment are computed above, so the
    // no-target guard sees exactly what this branch does.
    if (legacyRoleFromPhysicalId && !claimed('role', legacyRoleFromPhysicalId)) {
      const firstRole = legacyRoleFromPhysicalId;
      try {
        await this.iamClient.send(
          new DeleteRolePolicyCommand({
            RoleName: firstRole,
            PolicyName: policyName,
          })
        );
        this.logger.debug(`Deleted inline policy ${policyName} from role ${mask(firstRole)}`);
      } catch (error) {
        if (error instanceof NoSuchEntityException) {
          await onNotFound(`role ${mask(firstRole)}`);
        } else {
          throw error;
        }
      }
    }

    // Delete from all roles
    if (roles) {
      for (const roleName of roles) {
        if (claimed('role', roleName)) continue;
        try {
          await this.iamClient.send(
            new DeleteRolePolicyCommand({
              RoleName: roleName,
              PolicyName: policyName,
            })
          );
          onDetached('Roles', roleName);
          this.logger.debug(`Deleted inline policy ${policyName} from role ${mask(roleName)}`);
        } catch (error) {
          if (error instanceof NoSuchEntityException) {
            await onNotFound(`role ${mask(roleName)}`, { kind: 'Roles', name: roleName });
          } else {
            throw error;
          }
        }
      }
    }

    // Delete from all groups
    if (groups) {
      for (const groupName of groups) {
        if (claimed('group', groupName)) continue;
        try {
          await this.iamClient.send(
            new DeleteGroupPolicyCommand({
              GroupName: groupName,
              PolicyName: policyName,
            })
          );
          onDetached('Groups', groupName);
          this.logger.debug(`Deleted inline policy ${policyName} from group ${mask(groupName)}`);
        } catch (error) {
          if (error instanceof NoSuchEntityException) {
            await onNotFound(`group ${mask(groupName)}`, { kind: 'Groups', name: groupName });
          } else {
            throw error;
          }
        }
      }
    }

    // Delete from all users
    if (users) {
      for (const userName of users) {
        if (claimed('user', userName)) continue;
        try {
          await this.iamClient.send(
            new DeleteUserPolicyCommand({
              UserName: userName,
              PolicyName: policyName,
            })
          );
          onDetached('Users', userName);
          this.logger.debug(`Deleted inline policy ${policyName} from user ${mask(userName)}`);
        } catch (error) {
          if (error instanceof NoSuchEntityException) {
            await onNotFound(`user ${mask(userName)}`, { kind: 'Users', name: userName });
          } else {
            throw error;
          }
        }
      }
    }

    if (secretPrincipalLacksGrant) {
      this.logger.warn(
        safeMsg`IAM policy ${logicalId}: a principal the secret's CURRENT value names does not hold this inline policy. The value may have rotated since the policy was attached, so a principal only the OLD value named may still hold it; or an earlier cdkd run already removed it there, or that principal was deleted first. The record is KEPT rather than read as deleted: delete the inline policy from any old principal by hand (the principals the current value names are done), then drop this record with 'cdkd orphan <constructPath>', or, with no CDK app, ${stateOrphanRecordRemedy(context, logicalId)}.`
      );
      return { outcome: 'skipped', reason: POLICY_SECRET_PRINCIPAL_LACKS_GRANT_SKIP_REASON };
    }
    this.logger.debug(`Successfully deleted IAM policy ${logicalId}`);
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
          `Failed to delete IAM policy ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          physicalId,
          cause
        )
    );
    throw maskError(removedAny ? markDeleteStarted(failure) : failure);
  }
}
