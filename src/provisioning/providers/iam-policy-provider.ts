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
import { readPrincipalLists, recordedPrincipalsRepair } from '../iam-policy-targets.js';
import {
  isResolvableSecretPrincipalList,
  resolveSecretDerivedPrincipals,
} from '../secret-principal-resolution.js';
import { safeMsg } from '../../utils/display-safe.js';
import { injectiveKey } from '../../state/record-keys.js';
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
import { isRedactedRecordedValue, redactedDeleteAddressSkip } from '../redacted-delete-address.js';

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
 * The short `ResourceDeleteResult.reason` for a destroy that resolved a
 * secret-derived principal list and found a principal the CURRENT value names
 * without this inline policy (go-to-k/cdkd#4150). The value may have rotated,
 * so the grant may still sit on a principal only the OLD value named: the
 * record is kept rather than read as deleted, which would drop the last trace
 * of it.
 */
export const POLICY_SECRET_PRINCIPAL_LACKS_GRANT_SKIP_REASON =
  "the secret's current value names a principal that lacks this grant; the value may have rotated";

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

/** An inline policy name: IAM's own character set, at most 128 characters. */
const IAM_POLICY_NAME = /^[\w+=,.@-]{1,128}$/;

/** The three principal lists of one `AWS::IAM::Policy` bag, each ABSENT as `undefined`. */
interface PolicyTargetLists {
  roles: string[] | undefined;
  groups: string[] | undefined;
  users: string[] | undefined;
}

type PolicyTargetKind = 'Roles' | 'Groups' | 'Users';

/** The kinds of one bag that are present but not a list of IAM names. */
interface MalformedPolicyTargets {
  malformed: PolicyTargetKind[];
  /** The malformed kinds holding a dynamic reference or its mask (go-to-k/cdkd#3907). */
  secretDerived: PolicyTargetKind[];
  /** The well-formed kinds, as `PolicyTargetLists` would hold them. */
  wellFormed: PolicyTargetLists;
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
): PolicyTargetLists | MalformedPolicyTargets {
  const read = readPrincipalLists({
    Roles: bag?.['Roles'],
    Groups: bag?.['Groups'],
    Users: bag?.['Users'],
  });
  const lists = { roles: read.lists.Roles, groups: read.lists.Groups, users: read.lists.Users };
  if ('malformed' in read) {
    return { malformed: read.malformed, secretDerived: read.secretDerived, wellFormed: lists };
  }
  return lists;
}

/** The note a secret-derived kind carries: it is never repaired in state.json. */
const SECRET_DERIVED_NOTE =
  'is secret-derived (cdkd keeps the dynamic reference or its mask in state), so do not ' +
  'write the name into state.json';

/**
 * The way out of an update refused over a secret-derived RECORDED principal
 * list (go-to-k/cdkd#3907). Writing the name into state is not it, and unlike
 * `AWS::IAM::ManagedPolicy` there is no live source to read the old side from:
 * IAM has no call listing the principals that hold one INLINE policy by name.
 * `cdkd orphan` drops just this record, and the next deploy re-attaches the
 * policy from the template (`Put*Policy` is idempotent) under the DESIRED
 * name only, so a rename (`renamed`) also leaves the old-named policy behind.
 * A record whose reference the template still spells the same way never
 * reaches this: the engine drops it from the previous side
 * (go-to-k/cdkd#4064, `withUnchangedSecretPrincipalLists`).
 */
function policySecretDerivedRepair(renamed: boolean): string {
  return (
    'IAM has no call that lists the principals holding an inline policy, so cdkd cannot ' +
    'diff it: detach the inline policy by hand from every principal it should no longer be ' +
    'on' +
    (renamed
      ? ', and since this change renames the policy, also remove the OLD-named inline policy ' +
        'from every principal that holds it (the re-created record names only the new one)'
      : '') +
    ", then drop this record with 'cdkd orphan <constructPath>' so the next deploy " +
    're-attaches it from the template (an attachment left in place across the orphan is no ' +
    'longer tracked by cdkd). A later update proceeds only while the template spells the ' +
    'same reference and PolicyName, so a changed reference, a rename or a mask is refused ' +
    'this way again'
  );
}

/**
 * The repair clause for a malformed RECORDED side. When any kind is
 * secret-derived, the orphan route is the ONLY repair: it drops the whole
 * record, and a state.json repair of a plain kind alone would still be refused
 * over the secret-derived one. (The shared `recordedPrincipalsRepair` joins
 * both repairs, which is right for its other callers, whose secret-derived
 * route is a live read that NEEDS every other kind well-formed.)
 */
function recordedSideRepair(targets: MalformedPolicyTargets, renamed: boolean): string {
  const { malformed, secretDerived } = targets;
  if (secretDerived.length === 0) {
    return recordedPrincipalsRepair(malformed, [], 'role / group / user names', '');
  }
  const plain = malformed.filter((k) => !secretDerived.includes(k));
  return (
    `the recorded ${secretDerived.join(' / ')} ${SECRET_DERIVED_NOTE}` +
    (plain.length > 0
      ? `, and the recorded ${plain.join(' / ')} need not be repaired there either: the ` +
        `route below drops the whole record`
      : '') +
    `; ${policySecretDerivedRepair(renamed)}`
  );
}

/**
 * The repair clauses of an `update()` refused over a malformed side, in the
 * order they must be done (go-to-k/cdkd#3907). The desired side comes FIRST:
 * both the state.json repair and the orphan route re-apply it.
 *
 * A desired side reaches this holding a dynamic reference or cdkd's mask only
 * when the TEMPLATE itself holds it: a deploy refuses a masked attribute read
 * (a `NoEcho` custom resource's `Data`) in `refuseRedactedAttributeReads`
 * before any provider call, a rollback replay re-resolves every reference and
 * refuses a masked bag in `refuseMaskedReplayBaseline`, and `drift --revert`
 * never gets here.
 */
function refusalRepair(
  desired: PolicyTargetLists | MalformedPolicyTargets,
  recorded: PolicyTargetLists | MalformedPolicyTargets,
  renamed: boolean
): string {
  const clauses: string[] = [];
  const recordedMalformed = 'malformed' in recorded;
  if ('malformed' in desired) {
    if (desired.secretDerived.length > 0) {
      clauses.push(
        `the desired ${desired.secretDerived.join(' / ')} holds a dynamic reference or cdkd's ` +
          `mask that resolved to no names; fix that value in the template` +
          (recordedMalformed ? ' first, since the repair below re-applies it' : '')
      );
    } else if (recordedMalformed) {
      clauses.push('fix the desired side first, since the repair below re-applies it');
    }
  }
  if (recordedMalformed) {
    const repair = recordedSideRepair(recorded, renamed);
    clauses.push('malformed' in desired ? `then ${repair}` : repair);
  }
  return clauses.length > 0 ? `: ${clauses.join('; ')}` : '';
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
      // Known limits (go-to-k/cdkd#4152, #4156):
      //  - Two AWS::IAM::Policy resources swapping or handing off a name on one
      //    principal in the same deploy can remove each other's grant (the
      //    update has no view of sibling policies; fail-closed, and
      //    CloudFormation's rename has the same hazard).
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
    // go-to-k/cdkd#3952: a redacted PolicyName names nothing; the physicalId
    // stays the first source, and a redacted fallback is a named skip below.
    const recordedPolicyName = properties?.['PolicyName'];
    const policyNameRedacted = isRedactedRecordedValue(recordedPolicyName);
    const policyNameFromProperties =
      typeof recordedPolicyName === 'string' && !policyNameRedacted
        ? recordedPolicyName
        : undefined;
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
      !roles && !groups && !users && physicalId.includes(':')
        ? physicalId.split(':')[1]
        : undefined;

    if (!policyName && policyNameRedacted) {
      const skip = redactedDeleteAddressSkip(this.logger, logicalId, 'IAM policy', ['PolicyName']);
      if (skip) return skip;
    }

    if (!policyName) {
      this.logger.warn(
        `Invalid physical ID format: ${physicalId}, and no PolicyName in the state record's ` +
          `properties — skipping deletion. No AWS call is issued, so the inline policy is LEFT ` +
          `ATTACHED to its roles / groups / users, UNLESS the role / group / user it is attached ` +
          `to is itself part of this stack (deleting that principal removes its inline policies, ` +
          `and then only the cdkd record is stale — clear it with 'cdkd state orphan <stack> --stack-region <region>', which drops every record the stack has in that region). ` +
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
          optIn.importedProducerRegions
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
              ? `; cdkd could not resolve the reference (its region, access to it, or its ` +
                `value), so fix that and re-run, or`
              : `:`) +
            ` cdkd will keep skipping this record` +
            (plainKinds.length > 0
              ? `, whatever is repaired in the recorded ${plainKinds.join(' / ')}`
              : '') +
            `. Remove the inline policy from its principals by hand (a principal this stack ` +
            `also deletes takes its inline policies with it); on cdkd destroy every other ` +
            `resource is still deleted, so once this is the stack's last record 'cdkd state ` +
            `orphan <stack> --stack-region <region>' clears it.`;
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
          `then only the cdkd record is stale — clear it with 'cdkd state orphan <stack> --stack-region <region>', which drops every record the stack has in that region). ` +
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
    const onDetached = (kind: string, name: string): void => {
      if (fromSecret(kind, name)) detached?.add(injectiveKey(kind, name));
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
      if (legacyRoleFromPhysicalId) {
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
          safeMsg`IAM policy ${logicalId}: a principal the secret's CURRENT value names does not hold this inline policy. The value may have rotated since the policy was attached, so a principal only the OLD value named may still hold it; or an earlier cdkd run already removed it there, or that principal was deleted first. The record is KEPT rather than read as deleted: delete the inline policy from any old principal by hand (the principals the current value names are done), then drop this record with 'cdkd orphan <constructPath>', or, with no CDK app, 'cdkd state orphan <stack> --stack-region <region>' once it is the stack's last record.`
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
      throw maskError(
        new ProvisioningError(
          `Failed to delete IAM policy ${logicalId}: ${mask(error instanceof Error ? error.message : String(error))}`,
          resourceType,
          logicalId,
          physicalId,
          cause
        )
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
