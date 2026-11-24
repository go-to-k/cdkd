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
import { isDriftRevert, revertReplacementRefusal } from '../../revert-no-replace.js';
import { RecordedIdentityError } from '../../recorded-identity.js';
import { injectiveKey } from '../../../state/record-keys.js';
import {
  assertInlinePolicyAttachTargets,
  verifyInlinePolicyPrincipals,
} from './principal-identity.js';
import { cdkdRemedy, proseQuoted } from '../../../utils/pasteable-command.js';
import { holdsSecretDerivedEntry } from '../../iam-policy-targets.js';
import { deferIamPropagationSettle } from '../../iam-propagation-settle.js';

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
  // go-to-k/cdkd#6638: a rename puts the policy under the new name and removes
  // the old one, a replacement of the policy; a revert refuses it before any
  // call (a `{{resolve:...}}` PolicyName re-resolving to another value, or a
  // case-only difference).
  if (isDriftRevert(context) && newPolicyName !== oldPolicyName) {
    throw revertReplacementRefusal(
      resourceType,
      logicalId,
      'its PolicyName differs from the name the policy is recorded under'
    );
  }
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
        put: (name: string, policyName: string, document?: string) =>
          this.iamClient.send(
            new PutRolePolicyCommand({
              RoleName: name,
              PolicyName: policyName,
              PolicyDocument: document ?? policyDoc,
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
        put: (name: string, policyName: string, document?: string) =>
          this.iamClient.send(
            new PutGroupPolicyCommand({
              GroupName: name,
              PolicyName: policyName,
              PolicyDocument: document ?? policyDoc,
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
        put: (name: string, policyName: string, document?: string) =>
          this.iamClient.send(
            new PutUserPolicyCommand({
              UserName: name,
              PolicyName: policyName,
              PolicyDocument: document ?? policyDoc,
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
    // which `get-role-policy mypolicy` reads), so a removal AFTER the put
    // would delete the policy the put just wrote and strip the live grant.
    // Its old spelling is deleted BEFORE the put instead (go-to-k/cdkd#6874,
    // below).
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
    // go-to-k/cdkd#6655: a principal LEAVING the lists loses the policy by
    // name, so one that is a record of this stack with a recorded identity id
    // is read first, before any write (one read each, at most five at a time;
    // none for a principal outside the stack or without a usable id). A holder
    // with another id is sent nothing and WARNED about, not refused: the one
    // cdkd created is gone, its inline policy with it, so the update has
    // nothing left to remove there. The record then holds the desired lists,
    // which is what the policy is attached to, so the next deploy has nothing
    // to repeat and no `effectiveProperties` narrowing is needed. A read that
    // fails throws before any write; a principal already gone is skipped.
    // The claim predicate is asked once per (principal, name), up front: a
    // leaver another resource of this deploy claimed for every name it holds
    // loses nothing, so it is neither read nor written.
    const claimAnswers = new Map<string, boolean>();
    const isClaimed = (kind: (typeof kinds)[number]['kind'], name: string, policyName: string) => {
      const key = injectiveKey(kind, name, policyName);
      let answer = claimAnswers.get(key);
      if (answer === undefined) {
        answer = context?.inlinePolicyClaimed?.(kind, name, policyName) === true;
        claimAnswers.set(key, answer);
      }
      return answer;
    };
    const leaving = kinds.flatMap(({ kind, desired, recorded }) => {
      const stays = new Set([...desired].map((name) => name.toLowerCase()));
      return [...recorded]
        .filter((name) => !stays.has(name.toLowerCase()))
        .filter((name) => oldPolicyNames.some((policyName) => !isClaimed(kind, name, policyName)))
        .map((name) => [kind, name] as const);
    });
    const verdicts = await verifyInlinePolicyPrincipals({
      client: this.iamClient,
      principals: leaving,
      policyLogicalId: logicalId,
      physicalId,
      operation: 'update',
    });
    // go-to-k/cdkd#6722: every principal the policy is put on is compared too
    // (one read each for an in-stack principal with a recorded id that this
    // deploy did not create or replace), and another holder of a name refuses
    // the update before any write: a put to it would grant the policy to a
    // stranger. A rollback replaying this method backwards (the recorded bag
    // as the desired side) re-adds a principal the forward update left as a
    // mismatch; its replay view keeps no pre-run records, so it is read and
    // refused the same way.
    await assertInlinePolicyAttachTargets({
      client: this.iamClient,
      principals: kinds.flatMap(({ kind, desired }) =>
        [...desired].map((name) => [kind, name] as const)
      ),
      policyLogicalId: logicalId,
      physicalId,
    });
    const warned = new Set<string>();
    /** `true` when nothing may be sent to this leaving principal. */
    const settledByVerdict = (kind: (typeof kinds)[number]['kind'], name: string): boolean => {
      const key = injectiveKey(kind, name);
      const verdict = verdicts.get(key);
      if (verdict?.kind === 'mismatch') {
        if (!warned.has(key)) {
          warned.add(key);
          log.warn(
            `IAM policy ${logicalId}: the ${verdict.label} ${verdict.principalLogicalId} leaving ` +
              `its principals is not the one cdkd created (its ${verdict.attribute} differs from ` +
              `the recorded one), so cdkd sent it no removal: the one cdkd created is gone, and ` +
              `its inline policy with it. Leave that ${verdict.label} alone.`
          );
        }
        return true;
      }
      return verdict?.kind === 'gone';
    };
    // Per kind, puts before removals: a principal belongs to one kind, so a
    // failing put never strips a still-listed principal of the policy, and
    // an earlier kind's leaving principals are already revoked when a later
    // kind fails. A re-run converges: every put is idempotent, and a
    // removal of a name already gone is NoSuchEntity.
    // go-to-k/cdkd#6874: CloudFormation renames a policy only in case by
    // deleting the old spelling and then putting the new one on each
    // principal (CloudTrail of a CFn A/B, us-east-1 2026-11-23: in place,
    // `DeleteRolePolicy CasePol`, then `PutRolePolicy casepol`; back the same
    // way), so the new spelling is listed. A put alone keeps IAM's first
    // spelling. Each principal that held the old spelling (a recorded one)
    // gets that delete right before its put; a put that then fails puts the
    // old spelling back with the recorded document (best effort) before the
    // error propagates.
    const respelled = oldPolicyNames.filter(
      (name) => name !== newPolicyName && name.toLowerCase() === newPolicyName.toLowerCase()
    );
    const recordedDocument = previousProperties['PolicyDocument'];
    const previousDoc =
      typeof recordedDocument === 'string'
        ? recordedDocument
        : recordedDocument !== undefined && recordedDocument !== null
          ? JSON.stringify(recordedDocument)
          : undefined;
    for (const { kind, desired, recorded, put, remove } of kinds) {
      const held = new Set([...recorded].map((name) => name.toLowerCase()));
      for (const name of desired) {
        const respell = held.has(name.toLowerCase()) ? respelled : [];
        for (const policyName of respell) {
          try {
            await remove(name, policyName);
          } catch (error) {
            if (!(error instanceof NoSuchEntityException)) throw error;
          }
          log.debug(
            `Deleted inline policy ${v(policyName)} from ${kind} ${v(name)} before putting it as ${v(newPolicyName)}`
          );
        }
        try {
          await put(name, newPolicyName);
        } catch (error) {
          // One spelling is put back (IAM holds one policy for all of them),
          // and only a recorded document that is what AWS held: a
          // `{{resolve:` reference or a mask kept in state is not.
          const restoreName = respell[0];
          if (restoreName !== undefined) {
            let restored = false;
            if (previousDoc !== undefined && !holdsSecretDerivedEntry(recordedDocument)) {
              try {
                await put(name, restoreName, previousDoc);
                restored = true;
              } catch {
                // warned below
              }
            }
            if (!restored) {
              log.warn(
                `Could not put inline policy ${v(restoreName)} back on ${kind} ${v(name)} after its re-put as ${v(newPolicyName)} failed; it is absent until the next deploy or ${proseQuoted(cdkdRemedy('cdkd drift', '--revert'))}`
              );
            }
          }
          throw error;
        }
        log.debug(`Attached inline policy ${v(newPolicyName)} to ${kind} ${v(name)}`);
      }
      // Principal names are case-insensitive in IAM too: a recorded `MyRole`
      // the template now spells `myrole` is the SAME role the put just
      // wrote, so it stays, and must not lose the policy as a leaver.
      const stays = new Set([...desired].map((name) => name.toLowerCase()));
      for (const name of recorded) {
        for (const policyName of stays.has(name.toLowerCase()) ? renamedAway : oldPolicyNames) {
          if (isClaimed(kind, name, policyName)) {
            log.debug(
              `Kept inline policy ${v(policyName)} on ${kind} ${v(name)}: another resource of this deploy or rollback wrote it`
            );
            continue;
          }
          if (!stays.has(name.toLowerCase()) && settledByVerdict(kind, name)) continue;
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

    // go-to-k/cdkd#6638: a drift revert (which refused a rename above) keeps
    // the recorded id, so a legacy `policyName:roleName` record is not read
    // as a replacement by the revert's backstop. A deploy still moves it to
    // the bare name.
    const newPhysicalId = isDriftRevert(context) ? physicalId : newPolicyName;

    // A custom resource downstream waits for IAM to propagate this write.
    deferIamPropagationSettle(logicalId, resourceType, newPhysicalId);
    return {
      physicalId: newPhysicalId,
      wasReplaced: false,
      attributes: {
        PolicyName: newPolicyName,
      },
    };
  } catch (error) {
    // go-to-k/cdkd#6655: a principal read answering without its id, worded by
    // cdkd (logical ids only) and marked.
    if (error instanceof RecordedIdentityError) throw error;
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
