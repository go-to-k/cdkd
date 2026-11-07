import type { IAMPolicyProvider } from '../iam-policy-provider.js';
import {
  PutRolePolicyCommand,
  DeleteRolePolicyCommand,
  PutGroupPolicyCommand,
  DeleteGroupPolicyCommand,
  PutUserPolicyCommand,
  DeleteUserPolicyCommand,
  NoSuchEntityException,
} from '@aws-sdk/client-iam';
import { ProvisioningError } from '../../../utils/error-handler.js';
import { generatedNameFor, recordedGeneratedNameKept } from '../../resource-name.js';
import { createMaskedLogSinks, withDerivedNameMasks } from '../../masked-retry-logger.js';
import type { UpdateContext, ResourceUpdateResult } from '../../../types/resource.js';
import { IAM_POLICY_NAME, readPolicyTargetLists, refusalRepair } from './shared.js';

/**
 * Update an IAM inline policy
 */
export async function update(
  this: IAMPolicyProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>,
  context?: UpdateContext
): Promise<ResourceUpdateResult> {
  // Derive old policy name from physical ID (may contain ':roleName' suffix from old format)
  const oldPolicyName = physicalId.includes(':') ? physicalId.split(':')[0] : physicalId;
  // Issue #2177 -- see `create()`. The recorded name is ALSO a needle when the
  // PREVIOUS value it came from is secret-derived: after a rotated or
  // re-pointed secret, that previous value is the `{{resolve:` reference state
  // holds and the OLD plaintext is in no masker bag of this deploy.
  const log = withDerivedNameMasks(
    this.logger,
    createMaskedLogSinks(this.logger, context?.maskSecrets),
    [[previousProperties['PolicyName'], oldPolicyName]]
  );
  const { value: v } = log;
  log.debug(`Updating IAM policy ${logicalId}: ${v(physicalId)}`);

  const derivedPolicyName =
    (properties['PolicyName'] as string | undefined) ||
    generatedNameFor('AWS::IAM::Policy', logicalId);
  // go-to-k/cdkd#5064: an un-named policy whose recorded name differs from
  // the derivation only by the naming scheme keeps it, never a rename.
  const newPolicyName =
    oldPolicyName !== undefined &&
    recordedGeneratedNameKept({
      recorded: oldPolicyName,
      derived: derivedPolicyName,
      declaredName: properties['PolicyName'],
      previousDeclaredName: previousProperties['PolicyName'],
      logicalId,
      options: { maxLength: 64 },
    })
      ? oldPolicyName
      : derivedPolicyName;
  // Every name the recorded principals may hold the policy under
  // (go-to-k/cdkd#4152): the physical id's, and the recorded PolicyName when
  // it is a usable name that differs. They differ on a rollback revert, which
  // replays this method with the ATTEMPTED bag as the previous side while the
  // physical id is still the old one: an interrupted rename left the NEW name
  // on some principals, and only the recorded side names it. A value that is
  // not an IAM policy name (a secret reference, the mask) is never sent.
  const recordedPolicyName = previousProperties['PolicyName'];
  const oldPolicyNames = [
    ...new Set(
      [oldPolicyName, recordedPolicyName].filter(
        (name): name is string => typeof name === 'string' && IAM_POLICY_NAME.test(name)
      )
    ),
  ];
  // BOTH sides before any call: the previous side is the state record, and a
  // rollback replays this method with a recorded bag as the DESIRED side.
  const newTargets = readPolicyTargetLists(properties);
  const oldTargets = readPolicyTargetLists(previousProperties);
  if ('malformed' in newTargets || 'malformed' in oldTargets) {
    const which = [
      ...('malformed' in newTargets ? newTargets.malformed.map((k) => `desired ${k}`) : []),
      ...('malformed' in oldTargets ? oldTargets.malformed.map((k) => `recorded ${k}`) : []),
    ];
    // A RECORDED value is in cdkd state, which no template change reaches,
    // so the message says how to repair it — and a secret-derived one is
    // never repaired by writing the name into state (go-to-k/cdkd#3907).
    // The DESIRED side is not always the template: a rollback revert and
    // `drift --revert` replay this method with a recorded bag there, so the
    // message says so rather than naming one source. (`drift --revert` does
    // not reach this refusal today: `readCurrentState` reads a malformed
    // recorded list as drift unknown, so the resource is never reverted.)
    throw new ProvisioningError(
      `${which.join(' / ')} of IAM policy ${logicalId} is not a list of IAM names — no ` +
        `inline policy was attached or detached` +
        ('malformed' in newTargets
          ? ` (the desired side is the template's value on a deploy, and the recorded value ` +
            `being restored on a rollback revert or 'cdkd drift --revert')`
          : '') +
        refusalRepair(newTargets, oldTargets, newPolicyName !== oldPolicyName),
      resourceType,
      logicalId,
      physicalId
    );
  }
  const { roles: newRoles, groups: newGroups, users: newUsers } = newTargets;
  const { roles: oldRoles, groups: oldGroups, users: oldUsers } = oldTargets;
  const policyDocument = properties['PolicyDocument'];

  if (!policyDocument) {
    throw new ProvisioningError(
      `PolicyDocument is required for IAM policy ${logicalId}`,
      resourceType,
      logicalId,
      physicalId
    );
  }

  // At least one of Roles, Groups, or Users must be specified
  const hasTargets =
    (newRoles && newRoles.length > 0) ||
    (newGroups && newGroups.length > 0) ||
    (newUsers && newUsers.length > 0);
  if (!hasTargets) {
    throw new ProvisioningError(
      `At least one of Roles, Groups, or Users is required for IAM policy ${logicalId}`,
      resourceType,
      logicalId,
      physicalId
    );
  }

  // A principal leaving the list must lose the policy, and nothing names it:
  // refuse before any call rather than report a detach that never happened.
  if (oldPolicyNames.length === 0) {
    const leaving = (
      [
        [oldRoles, newRoles],
        [oldGroups, newGroups],
        [oldUsers, newUsers],
      ] as const
    ).some(([recorded, desired]) => {
      const kept = new Set((desired ?? []).map((p) => p.toLowerCase()));
      return (recorded ?? []).some((p) => !kept.has(p.toLowerCase()));
    });
    if (leaving) {
      throw new ProvisioningError(
        `IAM policy ${logicalId} has no usable recorded policy name (neither the physical id ` +
          `nor the recorded PolicyName is one), so the principals leaving its Roles / Groups / ` +
          `Users cannot be detached — no inline policy was attached or detached. Detach it by ` +
          `hand, or repair the physical id in state.json, and re-run.`,
        resourceType,
        logicalId,
        physicalId
      );
    }
  }

  try {
    // Serialize policy document
    const policyDoc =
      typeof policyDocument === 'string' ? policyDocument : JSON.stringify(policyDocument);

    const kinds = [
      {
        kind: 'role',
        desired: new Set(newRoles || []),
        recorded: new Set(oldRoles || []),
        put: (name: string, policyName: string) =>
          this.iamClient.send(
            new PutRolePolicyCommand({
              RoleName: name,
              PolicyName: policyName,
              PolicyDocument: policyDoc,
            })
          ),
        remove: (name: string, policyName: string) =>
          this.iamClient.send(
            new DeleteRolePolicyCommand({ RoleName: name, PolicyName: policyName })
          ),
      },
      {
        kind: 'group',
        desired: new Set(newGroups || []),
        recorded: new Set(oldGroups || []),
        put: (name: string, policyName: string) =>
          this.iamClient.send(
            new PutGroupPolicyCommand({
              GroupName: name,
              PolicyName: policyName,
              PolicyDocument: policyDoc,
            })
          ),
        remove: (name: string, policyName: string) =>
          this.iamClient.send(
            new DeleteGroupPolicyCommand({ GroupName: name, PolicyName: policyName })
          ),
      },
      {
        kind: 'user',
        desired: new Set(newUsers || []),
        recorded: new Set(oldUsers || []),
        put: (name: string, policyName: string) =>
          this.iamClient.send(
            new PutUserPolicyCommand({
              UserName: name,
              PolicyName: policyName,
              PolicyDocument: policyDoc,
            })
          ),
        remove: (name: string, policyName: string) =>
          this.iamClient.send(
            new DeleteUserPolicyCommand({ UserName: name, PolicyName: policyName })
          ),
      },
    ] as const;

    // go-to-k/cdkd#4152: a principal that stays listed across a RENAME holds
    // the OLD-named policy too, and used to keep it, untracked and still
    // granting. A principal that leaves the list loses every name it may
    // hold; one that stays loses every name except the new one.
    //
    // A case-only rename is NOT a rename here: IAM inline policy names are
    // case-insensitive on one principal (measured: put `MyPolicy`, then put
    // `mypolicy`, and the role lists ONE policy, still spelled `MyPolicy`,
    // which `get-role-policy mypolicy` reads), so the removal would delete
    // the policy the put just wrote and strip the live grant.
    //
    // go-to-k/cdkd#4156: a name another resource of this deploy has ALREADY
    // written onto the principal (a swap of two policies' names, a hand-off
    // to a new policy or to the principal's own `Policies`) is not removed
    // from it; `context.inlinePolicyClaimed` answers that live, from what
    // the other resource recorded. One that has not written yet loses
    // nothing to the removal: its later put restores the name. A rollback
    // revert asks the same of the reverts that completed before it
    // (go-to-k/cdkd#4225).
    //
    // Known limits (go-to-k/cdkd#4152, #4156):
    //  - Two writers of one name with no dependency between them run
    //    concurrently; a removal racing the other's put can still strip the
    //    name (fail-closed: less privilege, restored by the next change or
    //    `cdkd drift --revert`; go-to-k/cdkd#4227).
    //  - A revert of a failed update removes the ATTEMPTED name from every
    //    recorded principal, retained or leaving, so a hand-made inline
    //    policy of that name on one of them goes too.
    //  - With --no-rollback, a failed rename leaves the NEW name on the
    //    principals it reached while the record keeps the old one; a later
    //    deploy of the new template converges, but reverting the template to
    //    the old name is not a rename to the record and leaves the new-named
    //    policy there.
    const renamedAway = oldPolicyNames.filter(
      (name) => name.toLowerCase() !== newPolicyName.toLowerCase()
    );
    // Per kind, puts before removals: a principal belongs to one kind, so a
    // failing put never strips a still-listed principal of the policy, and
    // an earlier kind's leaving principals are already revoked when a later
    // kind fails. A re-run converges: every put is idempotent, and a
    // removal of a name already gone is NoSuchEntity.
    for (const { kind, desired, recorded, put, remove } of kinds) {
      for (const name of desired) {
        await put(name, newPolicyName);
        log.debug(`Attached inline policy ${v(newPolicyName)} to ${kind} ${v(name)}`);
      }
      // Principal names are case-insensitive in IAM too: a recorded `MyRole`
      // the template now spells `myrole` is the SAME role the put just
      // wrote, so it stays, and must not lose the policy as a leaver.
      const stays = new Set([...desired].map((name) => name.toLowerCase()));
      for (const name of recorded) {
        for (const policyName of stays.has(name.toLowerCase()) ? renamedAway : oldPolicyNames) {
          if (context?.inlinePolicyClaimed?.(kind, name, policyName) === true) {
            log.debug(
              `Kept inline policy ${v(policyName)} on ${kind} ${v(name)}: another resource of this deploy or rollback wrote it`
            );
            continue;
          }
          try {
            await remove(name, policyName);
            log.debug(`Removed inline policy ${v(policyName)} from ${kind} ${v(name)}`);
          } catch (error) {
            if (!(error instanceof NoSuchEntityException)) {
              throw error;
            }
          }
        }
      }
    }

    log.debug(`Successfully updated IAM policy ${logicalId}`);

    const newPhysicalId = newPolicyName;

    return {
      physicalId: newPhysicalId,
      wasReplaced: false,
      attributes: {
        PolicyName: newPolicyName,
      },
    };
  } catch (error) {
    const cause = error instanceof Error ? error : undefined;
    throw this.wrapMaskedError(
      log.mask,
      error,
      (text) =>
        new ProvisioningError(
          `Failed to update IAM policy ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          physicalId,
          cause
        )
    );
  }
}
