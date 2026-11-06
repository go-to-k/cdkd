import {
  AddRoleToDBClusterCommand,
  RemoveRoleFromDBClusterCommand,
  AddRoleToDBInstanceCommand,
  RemoveRoleFromDBInstanceCommand,
} from '@aws-sdk/client-rds';
import { enclosingDeadlineRemainingMs } from '../../../deployment/resource-deadline.js';
import { markNonRetryable } from '../../../deployment/retryable-errors.js';
import { safeMsg } from '../../../utils/display-safe.js';
import { maskerOrIdentity } from '../../masked-retry-logger.js';
import { ProvisioningError } from '../../../utils/error-handler.js';
import type { UpdateContext } from '../../../types/resource.js';
import {
  isModifyNotAvailableRefusal,
  modifyDbInstanceWhenAvailable,
} from '../db-instance-modify-retry.js';
import {
  associatedRoleArns,
  associatedRoleKey,
  associatedRoleList,
  isRoleCallNotAvailableRefusal,
  planAssociatedRoleChanges,
  type AssociatedRole,
  type LiveAssociatedRole,
} from '../db-associated-roles.js';
import type { RDSProvider } from '../rds-provider.js';

/**
 * go-to-k/cdkd#5639 / #5640: the template's `AssociatedRoles`, refused
 * before any call when malformed. Its gap to the record is what gets
 * DETACHED, so a malformed list never reads as empty, on an update replayed
 * from state too (`.claude/rules/provider-aws-response-reads.md`, the list
 * rule). A DB instance's entry needs a `FeatureName`: its schema requires
 * one, and AddRoleToDBInstance cannot be sent without it. Only a rollback's
 * re-create, which detaches nothing, warns and attaches none instead
 * (`'skipped'`).
 */
export function desiredAssociatedRoles(
  this: RDSProvider,
  properties: Record<string, unknown>,
  resourceType: string,
  logicalId: string,
  physicalId: string | undefined,
  replayingCreate: boolean
): AssociatedRole[] | 'skipped' {
  const instance = resourceType === 'AWS::RDS::DBInstance';
  const roles = associatedRoleList(properties['AssociatedRoles'], {
    featureNameRequired: instance,
  });
  if (roles !== undefined) return roles;
  const expected = instance
    ? 'a list of objects with a RoleArn and a FeatureName'
    : 'a list of objects with a RoleArn';
  if (!replayingCreate) {
    throw markNonRetryable(
      new ProvisioningError(
        `${resourceType} ${logicalId}: AssociatedRoles must be ${expected}; nothing was changed`,
        resourceType,
        logicalId,
        physicalId
      )
    );
  }
  this.logger.warn(
    safeMsg`${logicalId} (${resourceType}): the replayed AssociatedRoles is not ${expected}, so no role is attached`
  );
  return 'skipped';
}

/**
 * go-to-k/cdkd#5639 / #5640: attach the `desired` roles `previous` lacks and
 * detach the `previous` ones `desired` dropped, removals first, as
 * CloudFormation's handlers do (`updateAssociatedRoles`). RDS takes neither
 * call while the cluster or instance is busy, so they wait for `available`
 * first, under `--no-wait` too, and a call refused as busy waits it out and
 * is resent (#5194's rule). The live list is read once `available`, and the
 * plan drops what AWS already holds or no longer holds
 * (`planAssociatedRoleChanges`); a Describe answering no resource changes
 * nothing. CloudFormation's handlers stabilize each call once the Describe
 * lists the attached association, whatever its `Status` (`PENDING`
 * included: `isAssociatedRoleAttached` /
 * `isDBInstanceRoleAdditionStabilized` match the role and feature only), or
 * no longer lists the detached one; so does the wait here, which
 * `--no-wait` skips. CloudFormation's instance removal predicate
 * (`isDBInstanceRoleRemovalStabilized`) matches the RoleArn alone; cdkd
 * matches the role and the feature, so the same role kept for another
 * feature does not hold the wait open. A detach is marked attempted too, for
 * `associatedRolesNamed`.
 */
export async function applyAssociatedRoles(
  this: RDSProvider,
  target: 'cluster' | 'instance',
  logicalId: string,
  physicalId: string,
  desired: readonly AssociatedRole[],
  previous: readonly AssociatedRole[],
  mask: ((text: string) => string) | undefined,
  marks: Pick<UpdateContext, 'markUnsettled' | 'markAttempted'> | undefined
): Promise<void> {
  const candidates = planAssociatedRoleChanges(desired, previous);
  if (candidates.toAdd.length === 0 && candidates.toRemove.length === 0) return;
  const label = target === 'cluster' ? 'RDS DBCluster' : 'RDS DBInstance';
  // Bounded by the resource deadline, which does not cancel this operation:
  // a wait that outlives it would attach after the engine gave up.
  const waitBudgetMs = Math.min(1_800_000, enclosingDeadlineRemainingMs() - 30_000);
  if (waitBudgetMs <= 0) {
    throw new Error(
      `the resource timeout leaves no more time to change the roles of the ${target}; re-run the deploy, or with a longer --resource-timeout`
    );
  }
  if (target === 'cluster') {
    await this.waitForClusterAvailable(logicalId, physicalId, waitBudgetMs, 'changing its roles');
  } else {
    await this.waitForInstanceAvailable(logicalId, physicalId, waitBudgetMs, 'changing its roles');
  }
  const resource =
    target === 'cluster'
      ? await this.describeDBCluster(physicalId)
      : await this.describeDBInstance(physicalId);
  if (resource === undefined) {
    throw new Error(
      `Describe returned no ${target} while planning its role changes; no role was attached or detached`
    );
  }
  const { toAdd, toRemove } = planAssociatedRoleChanges(
    desired,
    previous,
    resource.AssociatedRoles ?? []
  );
  if (toAdd.length === 0 && toRemove.length === 0) return;
  marks?.markUnsettled?.('AssociatedRoles');
  const readStatus =
    target === 'cluster'
      ? async () => (await this.describeDBCluster(physicalId))?.Status
      : async () => (await this.describeDBInstance(physicalId))?.DBInstanceStatus;
  const whenAvailable = (send: () => Promise<unknown>): Promise<void> =>
    modifyDbInstanceWhenAvailable({
      send,
      readStatus,
      sleep: (ms) => this.sleep(ms),
      logger: this.logger,
      label,
      subject: target,
      isRefusal: (error) =>
        isRoleCallNotAvailableRefusal(error) || isModifyNotAvailableRefusal(error),
      logicalId,
      remainingMs: enclosingDeadlineRemainingMs(),
    });
  for (const role of toRemove) {
    // A detach is an attempt too, so `associatedRolesNamed` never reads a
    // role this run detached as detached outside cdkd. Marked BEFORE the
    // call, unlike an attach (#5498): a detach AWS applied can still throw
    // (a lost response, a replay's not-found), and the mark only matters
    // for a role AWS no longer lists, so a detach that did nothing is inert.
    marks?.markAttempted?.('AssociatedRoles', [associatedRoleKey(role)]);
    await whenAvailable(() =>
      target === 'cluster'
        ? this.getClient().send(
            new RemoveRoleFromDBClusterCommand({ DBClusterIdentifier: physicalId, ...role })
          )
        : this.getClient().send(
            new RemoveRoleFromDBInstanceCommand({
              DBInstanceIdentifier: physicalId,
              RoleArn: role.RoleArn,
              FeatureName: role.FeatureName,
            })
          )
    );
  }
  for (const role of toAdd) {
    await whenAvailable(() =>
      target === 'cluster'
        ? this.getClient().send(
            new AddRoleToDBClusterCommand({ DBClusterIdentifier: physicalId, ...role })
          )
        : this.getClient().send(
            new AddRoleToDBInstanceCommand({
              DBInstanceIdentifier: physicalId,
              RoleArn: role.RoleArn,
              FeatureName: role.FeatureName,
            })
          )
    );
    marks?.markAttempted?.('AssociatedRoles', [associatedRoleKey(role)]);
  }
  if (process.env['CDKD_NO_WAIT'] === 'true') return;
  const attached = toAdd.map(associatedRoleKey);
  const detached = toRemove.map(associatedRoleKey);
  const settled = (roles: readonly LiveAssociatedRole[] | undefined): boolean => {
    const held = new Set((roles ?? []).map(associatedRoleKey));
    return attached.every((key) => held.has(key)) && detached.every((key) => !held.has(key));
  };
  const change = `IAM role associations (${maskerOrIdentity(mask)(associatedRoleArns([...attached, ...detached]))})`;
  if (target === 'cluster') {
    await this.waitForClusterState(
      logicalId,
      physicalId,
      (cluster) => settled(cluster.AssociatedRoles),
      change
    );
  } else {
    await this.waitForInstanceState(
      logicalId,
      physicalId,
      (instance) => settled(instance.AssociatedRoles),
      change
    );
  }
}
