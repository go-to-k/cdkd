import {
  IAMClient,
  PutRolePolicyCommand,
  DeleteRolePolicyCommand,
  PutGroupPolicyCommand,
  DeleteGroupPolicyCommand,
  PutUserPolicyCommand,
  DeleteUserPolicyCommand,
  GetRolePolicyCommand,
  GetGroupPolicyCommand,
  GetUserPolicyCommand,
  NoSuchEntityException,
} from '@aws-sdk/client-iam';
import { getLogger } from '../../utils/logger.js';
import { getAwsClients } from '../../utils/aws-clients.js';
import { ProvisioningError } from '../../utils/error-handler.js';
import { assertRegionMatch, type DeleteContext } from '../region-check.js';
import { generateResourceName } from '../resource-name.js';
import { createMaskedLogSinks, withDerivedNameMasks } from '../masked-retry-logger.js';
import { readRecordedPrincipals, type RecordedPrincipals } from '../iam-policy-targets.js';
import type {
  CreateContext,
  UpdateContext,
  ResourceProvider,
  ResourceCreateResult,
  ResourceUpdateResult,
  ResourceDeleteResult,
  ResourceImportInput,
  ResourceImportResult,
} from '../../types/resource.js';

/**
 * The short `ResourceDeleteResult.reason` the no-policy-name DELETE arm
 * reports (issue [#1770](https://github.com/go-to-k/cdkd/issues/1770)).
 *
 * Rendered inline on the destroy status line, so it is the SHORT form; the full
 * remediation sentence goes out as the `logger.warn` beside it. It says "in
 * state" rather than "in physicalId" because the arm is only reached once BOTH
 * sources have been exhausted — the physicalId and `properties['PolicyName']`.
 */
export const POLICY_NAME_SKIP_REASON = 'no policy name in state — no delete issued';

/**
 * The short `ResourceDeleteResult.reason` for a record that names no principal
 * to detach the inline policy from (issue
 * [#1770](https://github.com/go-to-k/cdkd/issues/1770) review).
 *
 * Distinct from {@link POLICY_NAME_SKIP_REASON}: the policy may be perfectly
 * well named and it is the ATTACHMENT that is unknown, so pointing the user at
 * the physicalId would send them to the wrong half of the record.
 */
export const POLICY_NO_TARGET_SKIP_REASON = 'no Roles/Groups/Users in state — no delete issued';

/**
 * The short `ResourceDeleteResult.reason` for a record whose `Roles` /
 * `Groups` / `Users` is present but not a list of IAM names (go-to-k/cdkd#3878).
 * Such a value used to be cast and iterated: a string was walked character by
 * character, removing a same-named inline policy from one-letter principals
 * the record never named. It is refused before ANY call, not per kind, so a
 * record cannot be half-detached.
 */
export const POLICY_MALFORMED_TARGET_SKIP_REASON =
  'malformed Roles/Groups/Users in state — no delete issued';

/**
 * The deploy-side caveat the skip warning in this file carries (issue
 * [#1762](https://github.com/go-to-k/cdkd/issues/1762)).
 *
 * "Repair state.json and re-run" is only true on DESTROY, where the skip KEEPS
 * the record. The same arm is ALSO reached from `deploy-engine.ts` and
 * `rollback-executor.ts`, which discard the delete result and DROP the record —
 * there the id is gone, so re-running cannot help and the resource has to be
 * removed by hand. Mirrors the caveat `compositeIdFormatMessage` already
 * carries for the composite-id family.
 */
const DEPLOY_SKIP_CAVEAT =
  `NOTE this arm is ALSO reached from cdkd deploy. Since issue 1762 the DELETE of a resource ` +
  `removed from the template behaves like destroy — the record is KEPT and the next deploy ` +
  `re-attempts it — but a REPLACEMENT / rollback delete FAILS the resource instead ` +
  `(https://github.com/go-to-k/cdkd/issues/1762), leaving the old one untracked; there, remove the resource by hand.`;

/** The three principal lists of one `AWS::IAM::Policy` bag, each ABSENT as `undefined`. */
interface PolicyTargetLists {
  roles: string[] | undefined;
  groups: string[] | undefined;
  users: string[] | undefined;
}

/**
 * Read a bag's `Roles` / `Groups` / `Users` through the shared reader
 * (go-to-k/cdkd#3878), or return the kinds that are present but not a list of
 * IAM names. Every method here that sends a `Put*Policy`, `Delete*Policy` or
 * `Get*Policy` per name reads through this, because each used to cast and
 * iterate the value: a string was walked character by character, addressing
 * one-letter principals the bag never named — a GRANT on the create / update
 * put paths (a rollback replays `update()` with a recorded bag as the desired
 * side), a detach on delete and update, and a read of another principal's
 * policy on drift.
 */
function readPolicyTargetLists(
  bag: Record<string, unknown> | undefined
): PolicyTargetLists | { malformed: string[] } {
  const recorded = {
    Roles: readRecordedPrincipals(bag?.['Roles']),
    Groups: readRecordedPrincipals(bag?.['Groups']),
    Users: readRecordedPrincipals(bag?.['Users']),
  };
  const malformed = (Object.keys(recorded) as Array<keyof typeof recorded>).filter(
    (k) => recorded[k].kind === 'malformed'
  );
  if (malformed.length > 0) return { malformed };
  const namesOf = (r: RecordedPrincipals): string[] | undefined =>
    r.kind === 'names' ? r.names : undefined;
  return {
    roles: namesOf(recorded.Roles),
    groups: namesOf(recorded.Groups),
    users: namesOf(recorded.Users),
  };
}

/**
 * AWS IAM Policy Provider
 *
 * Implements resource provisioning for AWS::IAM::Policy using the IAM SDK.
 * This is required because IAM Policy is not supported by Cloud Control API.
 *
 * Note: AWS::IAM::Policy in CloudFormation is an inline policy attached to roles/users/groups,
 * not a managed policy (AWS::IAM::ManagedPolicy).
 */
export class IAMPolicyProvider implements ResourceProvider {
  private iamClient: IAMClient;
  private logger = getLogger().child('IAMPolicyProvider');
  handledProperties = new Map<string, ReadonlySet<string>>([
    ['AWS::IAM::Policy', new Set(['PolicyName', 'PolicyDocument', 'Roles', 'Groups', 'Users'])],
  ]);

  constructor() {
    // Use global AWS clients manager for better resource management
    const awsClients = getAwsClients();
    this.iamClient = awsClients.iam;
  }

  /**
   * Create an IAM inline policy
   */
  async create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    context?: CreateContext
  ): Promise<ResourceCreateResult> {
    // Issue #2177: ONE masked sink per operation (the `ssm-parameter-provider.ts`
    // shape), and every bag-derived value masked RAW as well. Absent context
    // means identity.
    const log = createMaskedLogSinks(this.logger, context?.maskSecrets);
    const { value: v } = log;
    log.debug(`Creating IAM policy ${logicalId}`);

    const policyName =
      (properties['PolicyName'] as string | undefined) ||
      generateResourceName(logicalId, { maxLength: 64 });
    const policyDocument = properties['PolicyDocument'];
    const targets = readPolicyTargetLists(properties);
    if ('malformed' in targets) {
      // CloudFormation rejects a non-list here too; refused before any call.
      throw new ProvisioningError(
        `${targets.malformed.join(' / ')} of IAM policy ${logicalId} is not a list of IAM ` +
          `names — no inline policy was attached`,
        resourceType,
        logicalId
      );
    }
    const { roles, groups, users } = targets;

    if (!policyDocument) {
      throw new ProvisioningError(
        `PolicyDocument is required for IAM policy ${logicalId}`,
        resourceType,
        logicalId
      );
    }

    // At least one of Roles, Groups, or Users must be specified
    const hasTargets =
      (roles && roles.length > 0) || (groups && groups.length > 0) || (users && users.length > 0);
    if (!hasTargets) {
      throw new ProvisioningError(
        `At least one of Roles, Groups, or Users is required for IAM policy ${logicalId}`,
        resourceType,
        logicalId
      );
    }

    try {
      // Serialize policy document
      const policyDoc =
        typeof policyDocument === 'string' ? policyDocument : JSON.stringify(policyDocument);

      // Attach policy to all roles
      // Note: AWS::IAM::Policy in CloudFormation is actually an inline policy
      if (roles) {
        for (const roleName of roles) {
          await this.iamClient.send(
            new PutRolePolicyCommand({
              RoleName: roleName,
              PolicyName: policyName,
              PolicyDocument: policyDoc,
            })
          );
          log.debug(`Attached inline policy ${v(policyName)} to role ${v(roleName)}`);
        }
      }

      // Attach policy to all groups
      if (groups) {
        for (const groupName of groups) {
          await this.iamClient.send(
            new PutGroupPolicyCommand({
              GroupName: groupName,
              PolicyName: policyName,
              PolicyDocument: policyDoc,
            })
          );
          log.debug(`Attached inline policy ${v(policyName)} to group ${v(groupName)}`);
        }
      }

      // Attach policy to all users
      if (users) {
        for (const userName of users) {
          await this.iamClient.send(
            new PutUserPolicyCommand({
              UserName: userName,
              PolicyName: policyName,
              PolicyDocument: policyDoc,
            })
          );
          log.debug(`Attached inline policy ${v(policyName)} to user ${v(userName)}`);
        }
      }

      log.debug(`Successfully created IAM policy ${logicalId}: ${v(policyName)}`);

      // For inline policies, physical ID is the policy name
      const physicalId = policyName;

      return {
        physicalId,
        attributes: {
          PolicyName: policyName,
        },
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to create IAM policy ${logicalId}: ${v(error instanceof Error ? error.message : String(error))}`,
        resourceType,
        logicalId,
        policyName,
        cause
      );
    }
  }

  /**
   * Update an IAM inline policy
   */
  async update(
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

    const newPolicyName =
      (properties['PolicyName'] as string | undefined) ||
      generateResourceName(logicalId, { maxLength: 64 });
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
      // so the message says where to repair it.
      throw new ProvisioningError(
        `${which.join(' / ')} of IAM policy ${logicalId} is not a list of IAM names — no ` +
          `inline policy was attached or detached` +
          ('malformed' in oldTargets
            ? `. Repair the recorded ${oldTargets.malformed.join(' / ')} in state.json to a ` +
              `list of role / group / user names and re-run`
            : ''),
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

    try {
      // Serialize policy document
      const policyDoc =
        typeof policyDocument === 'string' ? policyDocument : JSON.stringify(policyDocument);

      // ── Roles ──
      const newRoleSet = new Set(newRoles || []);
      const oldRoleSet = new Set(oldRoles || []);

      // Attach/update policy on current roles
      for (const roleName of newRoleSet) {
        await this.iamClient.send(
          new PutRolePolicyCommand({
            RoleName: roleName,
            PolicyName: newPolicyName,
            PolicyDocument: policyDoc,
          })
        );
        log.debug(`Attached inline policy ${v(newPolicyName)} to role ${v(roleName)}`);
      }

      // Remove policy from old roles no longer in the list
      for (const roleName of oldRoleSet) {
        if (!newRoleSet.has(roleName)) {
          try {
            await this.iamClient.send(
              new DeleteRolePolicyCommand({
                RoleName: roleName,
                PolicyName: oldPolicyName,
              })
            );
            log.debug(`Removed inline policy ${v(oldPolicyName)} from role ${v(roleName)}`);
          } catch (error) {
            if (!(error instanceof NoSuchEntityException)) {
              throw error;
            }
          }
        }
      }

      // ── Groups ──
      const newGroupSet = new Set(newGroups || []);
      const oldGroupSet = new Set(oldGroups || []);

      // Attach/update policy on current groups
      for (const groupName of newGroupSet) {
        await this.iamClient.send(
          new PutGroupPolicyCommand({
            GroupName: groupName,
            PolicyName: newPolicyName,
            PolicyDocument: policyDoc,
          })
        );
        log.debug(`Attached inline policy ${v(newPolicyName)} to group ${v(groupName)}`);
      }

      // Remove policy from old groups no longer in the list
      for (const groupName of oldGroupSet) {
        if (!newGroupSet.has(groupName)) {
          try {
            await this.iamClient.send(
              new DeleteGroupPolicyCommand({
                GroupName: groupName,
                PolicyName: oldPolicyName,
              })
            );
            log.debug(`Removed inline policy ${v(oldPolicyName)} from group ${v(groupName)}`);
          } catch (error) {
            if (!(error instanceof NoSuchEntityException)) {
              throw error;
            }
          }
        }
      }

      // ── Users ──
      const newUserSet = new Set(newUsers || []);
      const oldUserSet = new Set(oldUsers || []);

      // Attach/update policy on current users
      for (const userName of newUserSet) {
        await this.iamClient.send(
          new PutUserPolicyCommand({
            UserName: userName,
            PolicyName: newPolicyName,
            PolicyDocument: policyDoc,
          })
        );
        log.debug(`Attached inline policy ${v(newPolicyName)} to user ${v(userName)}`);
      }

      // Remove policy from old users no longer in the list
      for (const userName of oldUserSet) {
        if (!newUserSet.has(userName)) {
          try {
            await this.iamClient.send(
              new DeleteUserPolicyCommand({
                UserName: userName,
                PolicyName: oldPolicyName,
              })
            );
            log.debug(`Removed inline policy ${v(oldPolicyName)} from user ${v(userName)}`);
          } catch (error) {
            if (!(error instanceof NoSuchEntityException)) {
              throw error;
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
      throw new ProvisioningError(
        `Failed to update IAM policy ${logicalId}: ${v(error instanceof Error ? error.message : String(error))}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  /**
   * Delete an IAM inline policy
   */
  async delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void | ResourceDeleteResult> {
    this.logger.debug(`Deleting IAM policy ${logicalId}: ${physicalId}`);

    // Physical ID is the policy name (new format) or "policyName:roleName" (old format)
    const policyNameFromPhysicalId = physicalId.includes(':')
      ? physicalId.split(':')[0]
      : physicalId;

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
    const policyNameFromProperties =
      typeof properties?.['PolicyName'] === 'string' ? properties['PolicyName'] : undefined;
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
    const { roles, groups, users } =
      'malformed' in targets ? { roles: undefined, groups: undefined, users: undefined } : targets;
    const legacyRoleFromPhysicalId =
      !roles && !groups && !users && physicalId.includes(':')
        ? physicalId.split(':')[1]
        : undefined;

    if (!policyName) {
      this.logger.warn(
        `Invalid physical ID format: ${physicalId}, and no PolicyName in the state record's ` +
          `properties — skipping deletion. No AWS call is issued, so the inline policy is LEFT ` +
          `ATTACHED to its roles / groups / users, UNLESS the role / group / user it is attached ` +
          `to is itself part of this stack (deleting that principal removes its inline policies, ` +
          `and then only the cdkd record is stale — clear it with 'cdkd state orphan <stack> --stack-region <region>'). ` +
          `Otherwise repair the physicalId in state.json and re-run, or delete the inline policy ` +
          `by hand. ${DEPLOY_SKIP_CAVEAT}`
      );
      return { outcome: 'skipped', reason: POLICY_NAME_SKIP_REASON };
    }

    if (malformedKinds.length > 0) {
      this.logger.warn(
        `The state record for IAM policy ${logicalId} holds ${malformedKinds.join(' / ')} that ` +
          `is not a list of IAM names — skipping deletion rather than guessing which principals ` +
          `it names. No AWS call is issued, so the inline policy is LEFT ATTACHED wherever it ` +
          `is. Repair ${malformedKinds.join(' / ')} in state.json to a list of role / group / ` +
          `user names and re-run, or delete the inline policy by hand. ${DEPLOY_SKIP_CAVEAT}`
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
          `then only the cdkd record is stale — clear it with 'cdkd state orphan <stack> --stack-region <region>'). ` +
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
    const onNotFound = async (target: string): Promise<void> => {
      const clientRegion = await this.iamClient.config.region();
      assertRegionMatch(
        clientRegion,
        context?.expectedRegion,
        resourceType,
        logicalId,
        `${physicalId} (${target})`
      );
    };

    try {
      // If no properties available, try legacy format (physicalId = "policyName:roleName").
      // The target lists and this role segment are computed above, so the
      // no-target guard sees exactly what this branch does.
      if (legacyRoleFromPhysicalId) {
        const firstRole = legacyRoleFromPhysicalId;
        try {
          await this.iamClient.send(
            new DeleteRolePolicyCommand({
              RoleName: firstRole,
              PolicyName: policyName,
            })
          );
          this.logger.debug(`Deleted inline policy ${policyName} from role ${firstRole}`);
        } catch (error) {
          if (error instanceof NoSuchEntityException) {
            await onNotFound(`role ${firstRole}`);
          } else {
            throw error;
          }
        }
      }

      // Delete from all roles
      if (roles) {
        for (const roleName of roles) {
          try {
            await this.iamClient.send(
              new DeleteRolePolicyCommand({
                RoleName: roleName,
                PolicyName: policyName,
              })
            );
            this.logger.debug(`Deleted inline policy ${policyName} from role ${roleName}`);
          } catch (error) {
            if (error instanceof NoSuchEntityException) {
              await onNotFound(`role ${roleName}`);
            } else {
              throw error;
            }
          }
        }
      }

      // Delete from all groups
      if (groups) {
        for (const groupName of groups) {
          try {
            await this.iamClient.send(
              new DeleteGroupPolicyCommand({
                GroupName: groupName,
                PolicyName: policyName,
              })
            );
            this.logger.debug(`Deleted inline policy ${policyName} from group ${groupName}`);
          } catch (error) {
            if (error instanceof NoSuchEntityException) {
              await onNotFound(`group ${groupName}`);
            } else {
              throw error;
            }
          }
        }
      }

      // Delete from all users
      if (users) {
        for (const userName of users) {
          try {
            await this.iamClient.send(
              new DeleteUserPolicyCommand({
                UserName: userName,
                PolicyName: policyName,
              })
            );
            this.logger.debug(`Deleted inline policy ${policyName} from user ${userName}`);
          } catch (error) {
            if (error instanceof NoSuchEntityException) {
              await onNotFound(`user ${userName}`);
            } else {
              throw error;
            }
          }
        }
      }

      this.logger.debug(`Successfully deleted IAM policy ${logicalId}`);
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to delete IAM policy ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  /**
   * Read the AWS-current IAM inline policy in CFn-property shape.
   *
   * `AWS::IAM::Policy` is an inline policy attached to one or more roles /
   * groups / users via `PutRolePolicy` / `PutGroupPolicy` / `PutUserPolicy`.
   * Each attachment is a separate API call, but the same `PolicyDocument`
   * is replicated across every target.
   *
   * Strategy: pick the FIRST target from `properties.Roles` / `Groups` /
   * `Users` (in that order), call `Get*Policy(target, policyName)`, and
   * surface the URL-decoded + JSON-parsed `PolicyDocument`. Roles / Groups /
   * Users are echoed back from state since AWS doesn't return them. This is
   * defensible because:
   *   - Drift on `PolicyDocument`: caught — the document is the same on
   *     every target, so reading any one of them surfaces the divergence.
   *   - Drift on the target list (a role removed / added out-of-band): NOT
   *     caught. There's no API to enumerate every role / group / user that
   *     has an inline policy of a given name; cdkd would need to walk the
   *     entire account. Out of scope for v1.
   *
   * Returns `undefined` when the resolved target has no inline policy of
   * that name (`NoSuchEntityException`) — signals "drift unknown" rather
   * than firing a false positive.
   */
  async readCurrentState(
    physicalId: string,
    _logicalId: string,
    _resourceType: string,
    properties?: Record<string, unknown>
  ): Promise<Record<string, unknown> | undefined> {
    if (!properties) return undefined;

    const policyDocument = properties['PolicyDocument'];
    if (!policyDocument) return undefined;

    // physicalId may be in legacy "policyName:roleName" format
    const policyName = physicalId.includes(':') ? physicalId.split(':')[0]! : physicalId;

    // A malformed recorded list is drift UNKNOWN: reading its first "name"
    // would read ANOTHER principal's same-named policy (go-to-k/cdkd#3878).
    const targets = readPolicyTargetLists(properties);
    if ('malformed' in targets) return undefined;
    const { roles, groups, users } = targets;

    let liveDocument: unknown;

    try {
      if (roles && roles.length > 0) {
        const resp = await this.iamClient.send(
          new GetRolePolicyCommand({ RoleName: roles[0]!, PolicyName: policyName })
        );
        liveDocument = this.decodePolicyDocument(resp.PolicyDocument);
      } else if (groups && groups.length > 0) {
        const resp = await this.iamClient.send(
          new GetGroupPolicyCommand({ GroupName: groups[0]!, PolicyName: policyName })
        );
        liveDocument = this.decodePolicyDocument(resp.PolicyDocument);
      } else if (users && users.length > 0) {
        const resp = await this.iamClient.send(
          new GetUserPolicyCommand({ UserName: users[0]!, PolicyName: policyName })
        );
        liveDocument = this.decodePolicyDocument(resp.PolicyDocument);
      } else {
        // No targets in state — cannot resolve; skip.
        return undefined;
      }
    } catch (err) {
      if (err instanceof NoSuchEntityException) return undefined;
      throw err;
    }

    if (liveDocument === undefined) return undefined;

    const result: Record<string, unknown> = {
      PolicyName: policyName,
      PolicyDocument: liveDocument,
    };
    // Echo the recorded targets back so the comparator's intersection of
    // state-side keys against AWS-side keys does not surface false drift on
    // Roles / Groups / Users. AWS has no API to enumerate the full target
    // set for a named inline policy — see method docstring.
    if (roles) result['Roles'] = roles;
    if (groups) result['Groups'] = groups;
    if (users) result['Users'] = users;
    return result;
  }

  /**
   * IAM Get*Policy returns the policy document as a URL-encoded JSON string
   * (per RFC 3986). Decode and parse it back into the object shape cdkd
   * state holds, so the drift comparator sees apples-to-apples.
   */
  private decodePolicyDocument(raw: string | undefined): unknown {
    if (!raw) return undefined;
    try {
      return JSON.parse(decodeURIComponent(raw));
    } catch {
      // Defensive: if decoding fails, surface the raw string and let the
      // comparator show the divergence rather than swallowing the error.
      return raw;
    }
  }

  /**
   * Adopt an existing IAM inline policy into cdkd state.
   *
   * **Explicit override only.** `AWS::IAM::Policy` in CloudFormation is an
   * inline policy attached to roles / groups / users — not a standalone
   * resource. Inline policies are not taggable and have no global identity,
   * so tag-based auto-lookup via `aws:cdk:path` is not feasible. Users
   * adopting inline policies must pass `--resource <logicalId>=<policyName>`
   * (the physical id is the policy name itself).
   *
   * For standalone managed policies (`AWS::IAM::ManagedPolicy`), the
   * Cloud Control API fallback handles import via the same explicit
   * override mode.
   */
  // eslint-disable-next-line @typescript-eslint/require-await -- explicit-override-only intentionally has no AWS calls
  async import(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    if (input.knownPhysicalId) {
      return { physicalId: input.knownPhysicalId, attributes: {} };
    }
    return null;
  }
}
