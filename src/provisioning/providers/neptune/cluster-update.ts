import type { NeptuneProvider } from '../neptune-provider.js';
import {
  ModifyDBClusterCommand,
  DescribeDBSubnetGroupsCommand,
  AddRoleToDBClusterCommand,
  RemoveRoleFromDBClusterCommand,
} from '@aws-sdk/client-neptune';
import { DescribeSecurityGroupsCommand } from '@aws-sdk/client-ec2';
import { enclosingDeadlineRemainingMs } from '../../../deployment/resource-deadline.js';
import { markNonRetryable, markRedactedCause } from '../../../deployment/retryable-errors.js';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import { ProvisioningError } from '../../../utils/error-handler.js';
import { removedTemplateKeys } from '../../update-removal.js';
import { refuseMalformedDesiredTags } from '../../tag-list.js';
import type { ResourceUpdateResult, UpdateContext } from '../../../types/resource.js';
import { safeMsg } from '../../../utils/display-safe.js';
import {
  isModifyNotAvailableRefusal,
  modifyDbInstanceWhenAvailable,
} from '../db-instance-modify-retry.js';
import { maskerOrIdentity } from '../../masked-retry-logger.js';
import { coerceCfnBoolean, configBooleanRefusal } from '../../config-shape.js';
import {
  associatedRoleArns,
  associatedRoleKey,
  associatedRoleList,
  isRoleCallNotAvailableRefusal,
  planAssociatedRoleChanges,
  type AssociatedRole,
} from '../db-associated-roles.js';
import {
  CLUSTER_KEPT_ON_REMOVAL,
  CLUSTER_MODIFY_KEYS,
  CLUSTER_UNMEASURED_ON_REMOVAL,
  DEADLINE_MARGIN_MS,
  ROLE_AVAILABLE_MAX_WAIT_MS,
  clusterAttributes,
  isMajorEngineChange,
  logExportChange,
  markChangedUnsettled,
  securityGroupListChanged,
  sentOnUpdate,
  serverlessScalingToSend,
  stringList,
} from './shared.js';

export async function updateDBCluster(
  this: NeptuneProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>,
  context?: UpdateContext
): Promise<ResourceUpdateResult> {
  this.logger.debug(`Updating Neptune DBCluster ${logicalId}: ${physicalId}`);
  // go-to-k/cdkd#3994: a malformed desired Tags is refused before any call.
  refuseMalformedDesiredTags(properties['Tags'], resourceType, logicalId, physicalId);
  const { roles, logTypes, scaling } = this.readClusterBlocks(properties, resourceType, logicalId, {
    creating: false,
    stateBorne: context?.replayingState === true || context?.desiredFromAwsReadback === true,
    physicalId,
  });
  const logExportConfig = logExportChange(
    logTypes,
    // A malformed record only misses disables; every enable is idempotent.
    stringList(previousProperties['EnableCloudwatchLogsExports']) ?? []
  );

  try {
    // AWS refuses a major EngineVersion without AllowMajorVersionUpgrade, and
    // the cluster schema has no such flag: as the RDS provider, the raised
    // version is the request. DBInstanceParameterGroupName is valid only
    // beside the flag. A version newly declared compares with the live one.
    // NetworkType compares the same way: the live value is what it changes.
    const unrecorded = (key: string): boolean =>
      properties[key] != null && previousProperties[key] == null;
    const live =
      unrecorded('EngineVersion') ||
      unrecorded('NetworkType') ||
      logExportConfig?.EnableLogTypes !== undefined
        ? await this.describeDBCluster(physicalId)
        : undefined;
    const majorUpgrade = isMajorEngineChange(
      previousProperties['EngineVersion'] ?? live?.EngineVersion,
      properties['EngineVersion']
    );
    const networkType = properties['NetworkType'] as string | undefined;
    const networkChange =
      networkType != null &&
      networkType !== (previousProperties['NetworkType'] ?? live?.NetworkType);
    markChangedUnsettled(CLUSTER_MODIFY_KEYS, properties, previousProperties, context);
    const send = sentOnUpdate(properties, previousProperties);
    // Its own ProvisioningError names the cause; the catch passes it through.
    const vpcSgIds = await this.dbClusterSecurityGroupsToSend(
      logicalId,
      physicalId,
      resourceType,
      properties,
      previousProperties,
      context
    );
    // #1160 reset-on-removal — ModifyDBCluster has merge semantics (an
    // absent input field means "no change"), so a property REMOVED from
    // the template is sent as an explicit reset only where CloudFormation
    // resets it. Every property in CLUSTER_KEPT_ON_REMOVAL was measured as
    // KEPT (#5004, #1160, #5544), so a removed one is passed through as
    // absent and named in the warning below. DocDB differs on the port:
    // there CloudFormation resets it to 27017. A removed
    // VpcSecurityGroupIds IS reset, to the VPC's default security group
    // (`dbClusterSecurityGroupsToSend`).
    await this.getClient().send(
      new ModifyDBClusterCommand({
        DBClusterIdentifier: physicalId,
        EngineVersion: send('EngineVersion') as string | undefined,
        // #5004: CloudFormation KEEPS the live value of a removed
        // DeletionProtection / BackupRetentionPeriod, so an absent value
        // is passed through as absent (no reset).
        DeletionProtection: properties['DeletionProtection'] as boolean | undefined,
        BackupRetentionPeriod:
          properties['BackupRetentionPeriod'] != null
            ? Number(properties['BackupRetentionPeriod'])
            : undefined,
        PreferredBackupWindow: send('PreferredBackupWindow') as string | undefined,
        PreferredMaintenanceWindow: send('PreferredMaintenanceWindow') as string | undefined,
        DBClusterParameterGroupName: properties['DBClusterParameterGroupName'] as
          | string
          | undefined,
        // #5004: a removed IamAuthEnabled is KEPT by CloudFormation (no reset).
        // CFn property `IamAuthEnabled` maps to `EnableIAMDatabaseAuthentication`.
        EnableIAMDatabaseAuthentication: properties['IamAuthEnabled'] as boolean | undefined,
        ...(vpcSgIds !== undefined && { VpcSecurityGroupIds: vpcSgIds }),
        Port:
          properties['DBPort'] != null
            ? Number(properties['DBPort'])
            : properties['Port'] != null
              ? Number(properties['Port'])
              : undefined,
        CopyTagsToSnapshot: properties['CopyTagsToSnapshot'] as boolean | undefined,
        // Sent only on a change: re-sending one asks AWS for a network
        // change on every update.
        ...(networkChange && { NetworkType: networkType }),
        ...(scaling != null && { ServerlessV2ScalingConfiguration: scaling }),
        ...(logExportConfig !== undefined && {
          CloudwatchLogsExportConfiguration: logExportConfig,
        }),
        ...(majorUpgrade && { AllowMajorVersionUpgrade: true }),
        ...(majorUpgrade &&
          properties['DBInstanceParameterGroupName'] != null && {
            DBInstanceParameterGroupName: properties['DBInstanceParameterGroupName'] as string,
          }),
        ApplyImmediately: true,
      })
    );

    // go-to-k/cdkd#5498: what this call added, so a convergence after a
    // later failure disables it, and nothing an out-of-band change enabled.
    const addedLogTypes = (logExportConfig?.EnableLogTypes ?? []).filter(
      (type) => !live?.EnabledCloudwatchLogsExports?.includes(type)
    );
    if (addedLogTypes.length > 0) {
      context?.markAttempted?.('EnableCloudwatchLogsExports', addedLogTypes);
    }

    this.logger.debug(`Successfully updated Neptune DBCluster ${logicalId}`);
    const described = await this.describeDBCluster(physicalId);

    if (logExportConfig !== undefined && process.env['CDKD_NO_WAIT'] !== 'true') {
      // The delta, not the whole list: a type enabled out of band is not ours.
      const { EnableLogTypes: enabled = [], DisableLogTypes: disabled = [] } = logExportConfig;
      await this.waitForApplied(logicalId, 'EnableCloudwatchLogsExports', async () => {
        const live = (await this.describeDBCluster(physicalId))?.EnabledCloudwatchLogsExports;
        return (
          enabled.every((type) => live?.includes(type)) &&
          !disabled.some((type) => live?.includes(type))
        );
      });
    }

    if (networkChange && process.env['CDKD_NO_WAIT'] !== 'true') {
      await this.waitForApplied(
        logicalId,
        'NetworkType',
        async () => (await this.describeDBCluster(physicalId))?.NetworkType === networkType
      );
    }

    await this.applyClusterRoles(
      logicalId,
      physicalId,
      roles,
      // A malformed record only misses detaches: `applyClusterRoles` reads
      // what is live, so an attached role is not attached twice.
      associatedRoleList(previousProperties['AssociatedRoles']) ?? [],
      context?.maskSecrets,
      context
    );

    // A changed VpcSecurityGroupIds also moves every member instance to
    // `modifying` within about a second, and a member's own Modify* in the
    // same deploy is then refused ("Database instance is not in available
    // state"). CloudFormation reports the update only once it has settled, so
    // wait here, but ONLY when the sent list differs from the previous one:
    // an unchanged list (re-sent on every update) adds no time. `--no-wait`
    // skips it, exactly as create() skips waitForClusterAvailable.
    if (
      process.env['CDKD_NO_WAIT'] !== 'true' &&
      securityGroupListChanged(vpcSgIds, previousProperties['VpcSecurityGroupIds'])
    ) {
      await this.waitForSecurityGroupsApplied(physicalId, logicalId, vpcSgIds ?? []);
      for (const member of described?.DBClusterMembers ?? []) {
        if (member.DBInstanceIdentifier) {
          await this.waitForMemberAfterSecurityGroupChange(member.DBInstanceIdentifier, logicalId);
        }
      }
    }

    if (described?.DBClusterArn) {
      markChangedUnsettled(['Tags'], properties, previousProperties, context);
      await this.applyTagDiff(
        described.DBClusterArn,
        resourceType,
        logicalId,
        previousProperties['Tags'],
        properties['Tags']
      );
    }

    this.warnKeptRemovals(
      logicalId,
      resourceType,
      properties,
      previousProperties,
      CLUSTER_KEPT_ON_REMOVAL,
      context
    );
    this.warnKeptRemovals(
      logicalId,
      resourceType,
      properties,
      previousProperties,
      CLUSTER_UNMEASURED_ON_REMOVAL,
      context,
      false
    );

    return {
      physicalId,
      wasReplaced: false,
      attributes: clusterAttributes(described),
    };
  } catch (error) {
    if (error instanceof ProvisioningError) throw error;
    const cause = error instanceof Error ? error : undefined;
    throw this.wrapCaughtError(
      context?.maskSecrets,
      error,
      (text) =>
        new ProvisioningError(
          `Failed to update Neptune DBCluster ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          physicalId,
          cause
        )
    );
  }
}

/**
 * The `AssociatedRoles`, `EnableCloudwatchLogsExports` and
 * `ServerlessScalingConfiguration` a create or update sends, malformed ones
 * refused before any call. A state-borne bag downgrades a refusal to a
 * warning and leaves the block out, with one exception stated at it: a
 * malformed list on an UPDATE stays refused, since both lists are read as a
 * diff, and reading one as empty would detach every role or disable every
 * log (`.claude/rules/provider-aws-response-reads.md`, the list rule).
 */
export function readClusterBlocks(
  this: NeptuneProvider,
  properties: Record<string, unknown>,
  resourceType: string,
  logicalId: string,
  origin: { creating: boolean; stateBorne: boolean; physicalId?: string }
): {
  roles: AssociatedRole[];
  logTypes: string[];
  scaling: { MinCapacity: number; MaxCapacity: number } | null | undefined;
} {
  const refuse = (key: string, expected: string): never => {
    throw markNonRetryable(
      new ProvisioningError(
        safeMsg`Neptune DBCluster ${logicalId}: ${key} must be ${expected}; nothing was changed.`,
        resourceType,
        logicalId,
        origin.physicalId
      )
    );
  };
  const leaveOut = (key: string): void => {
    this.logger.warn(
      safeMsg`${logicalId} (${resourceType}): the recorded ${key} is unusable, so it is not sent.`
    );
  };
  const unusableList = (key: string, expected: string): string[] & AssociatedRole[] => {
    if (!(origin.creating && origin.stateBorne)) return refuse(key, expected);
    leaveOut(key);
    return [];
  };
  const roles =
    associatedRoleList(properties['AssociatedRoles']) ??
    unusableList('AssociatedRoles', 'a list of objects with a RoleArn');
  const logTypes =
    stringList(properties['EnableCloudwatchLogsExports']) ??
    unusableList('EnableCloudwatchLogsExports', 'a list of strings');
  const scaling = serverlessScalingToSend(properties['ServerlessScalingConfiguration']);
  if (scaling === null) {
    if (!origin.stateBorne) {
      return refuse(
        'ServerlessScalingConfiguration',
        'an object with both a numeric MinCapacity and a numeric MaxCapacity'
      );
    }
    leaveOut('ServerlessScalingConfiguration');
  }
  return { roles, logTypes, scaling };
}

/**
 * Attach the `desired` roles `previous` lacks and detach the `previous`
 * ones `desired` dropped, as CloudFormation plans them, minus what the live
 * list (read once `available`) already shows done, so a retry after a
 * partial run neither re-attaches nor re-detaches (neither call is
 * idempotent; `planAssociatedRoleChanges`). Both calls need
 * the cluster `available`, whatever `--no-wait` says. A ModifyDBCluster just
 * before can start only after the wait read `available`, so each call also
 * waits out and resends that refusal (#5194's rule).
 */
export async function applyClusterRoles(
  this: NeptuneProvider,
  logicalId: string,
  physicalId: string,
  desired: readonly AssociatedRole[],
  previous: readonly AssociatedRole[],
  mask: ((text: string) => string) | undefined,
  marks: Pick<UpdateContext, 'markUnsettled' | 'markAttempted'> | undefined
): Promise<void> {
  const candidates = planAssociatedRoleChanges(desired, previous);
  if (candidates.toAdd.length === 0 && candidates.toRemove.length === 0) return;

  // Bounded by the resource deadline, which does not cancel this operation:
  // a wait that outlives it would attach after the engine gave up.
  const waitBudgetMs = Math.min(
    ROLE_AVAILABLE_MAX_WAIT_MS,
    enclosingDeadlineRemainingMs() - DEADLINE_MARGIN_MS
  );
  if (waitBudgetMs <= 0) {
    throw new Error(
      'the resource timeout leaves no more time to change the roles of the cluster; re-run the deploy, or with a longer --resource-timeout'
    );
  }
  await this.waitForClusterAvailable(logicalId, physicalId, 'changing its roles', waitBudgetMs);
  const cluster = await this.describeDBCluster(physicalId);
  if (cluster === undefined) {
    throw new Error(
      'DescribeDBClusters returned no cluster while planning its role changes; no role was attached or detached'
    );
  }
  const { toAdd, toRemove } = planAssociatedRoleChanges(
    desired,
    previous,
    cluster.AssociatedRoles ?? []
  );
  if (toAdd.length === 0 && toRemove.length === 0) return;
  marks?.markUnsettled?.('AssociatedRoles');
  const whenAvailable = (send: () => Promise<unknown>): Promise<void> =>
    modifyDbInstanceWhenAvailable({
      send,
      readStatus: async () => (await this.describeDBCluster(physicalId))?.Status,
      sleep: (ms) => this.sleep(ms),
      logger: this.logger,
      label: 'Neptune DBCluster',
      subject: 'cluster',
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
      this.getClient().send(
        new RemoveRoleFromDBClusterCommand({ DBClusterIdentifier: physicalId, ...role })
      )
    );
  }
  for (const role of toAdd) {
    await whenAvailable(() =>
      this.getClient().send(
        new AddRoleToDBClusterCommand({ DBClusterIdentifier: physicalId, ...role })
      )
    );
    marks?.markAttempted?.('AssociatedRoles', [associatedRoleKey(role)]);
  }
  if (process.env['CDKD_NO_WAIT'] !== 'true') {
    await this.waitForClusterRolesSettled(
      logicalId,
      physicalId,
      new Set(toAdd.map(associatedRoleKey)),
      new Set(toRemove.map(associatedRoleKey)),
      mask
    );
  }
}

/**
 * Poll until every attached role has left `PENDING` and every detached one
 * has gone. AWS accepted both calls, so a role still settling at the cap, or
 * one AWS reports `INVALID`, is a warning: the cluster itself is fine, and a
 * throw from create() would strand it.
 */
export async function waitForClusterRolesSettled(
  this: NeptuneProvider,
  logicalId: string,
  physicalId: string,
  attached: ReadonlySet<string>,
  detached: ReadonlySet<string>,
  mask: ((text: string) => string) | undefined
): Promise<void> {
  const shown = (keys: readonly string[]): string =>
    maskerOrIdentity(mask)(associatedRoleArns(keys));
  let unsettled: string[] = [];
  const settled = await this.pollUntilSettled(async () => {
    const roles = (await this.describeDBCluster(physicalId))?.AssociatedRoles ?? [];
    const byKey = new Map(roles.map((role) => [associatedRoleKey(role), role]));
    unsettled = [
      ...[...attached].filter((key) => (byKey.get(key)?.Status ?? 'PENDING') === 'PENDING'),
      ...[...detached].filter((key) => byKey.has(key)),
    ];
    if (unsettled.length > 0) return false;
    const invalid = [...attached].filter((key) => byKey.get(key)?.Status === 'INVALID');
    if (invalid.length > 0) {
      this.logger.warn(
        safeMsg`${logicalId}: Neptune reports ${shown(invalid)} as INVALID: the role is attached, but the cluster cannot assume it. Check the role's trust policy.`
      );
    }
    return true;
  });
  if (!settled) {
    this.logger.warn(
      safeMsg`${logicalId}: the IAM roles of the Neptune cluster had not settled when cdkd stopped waiting (${shown(unsettled)}).`
    );
  }
}

/**
 * Issue #5544: ONE warning naming each `kept` property this update dropped,
 * which `update()` leaves at its live value because CloudFormation does too
 * (the type is in `removalHandledInUpdate`, so the caller names none of
 * them). The removed set is the caller's `removedProperties` when set, else
 * the two bags compared (a direct call). A `drift --revert` baseline is a
 * readback, not a template, so nothing there was removed. `DBPort` and
 * `Port` are one setting: dropping one while the other stays is no removal.
 * `measured` is whether the parity with CloudFormation is measured, and so
 * whether the warning may claim it.
 */
export function warnKeptRemovals(
  this: NeptuneProvider,
  logicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>,
  kept: readonly string[],
  context: UpdateContext | undefined,
  measured = true
): void {
  if (context?.desiredFromAwsReadback === true) return;
  const removed =
    context?.removedProperties ?? new Set(removedTemplateKeys(previousProperties, properties));
  const portStays = properties['DBPort'] != null || properties['Port'] != null;
  const names = kept.filter(
    (key) => removed.has(key) && !((key === 'DBPort' || key === 'Port') && portStays)
  );
  if (names.length === 0) return;
  const one = names.length === 1;
  const modify =
    resourceType === 'AWS::Neptune::DBInstance' ? 'ModifyDBInstance' : 'ModifyDBCluster';
  this.logger.warn(
    context?.replayingState === true
      ? safeMsg`${logicalId} (${resourceType}): ${one ? 'property' : 'properties'} ${names.join(', ')} ${one ? 'is' : 'are'} absent from the state being restored; ${modify} keeps a setting it is not sent, so the rollback leaves any value the failed deploy applied in place.`
      : safeMsg`${logicalId} (${resourceType}): ${one ? 'property' : 'properties'} ${names.join(', ')} ${one ? 'was' : 'were'} removed from the template; cdkd leaves the current AWS ${one ? 'value' : 'values'} in place${measured ? ', as CloudFormation does' : ''}. Declare ${one ? 'it' : 'them'} to change ${one ? 'it' : 'them'}.`
  );
}

/**
 * `PubliclyAccessible` as the boolean it means. Coercion alone would drop
 * `'no'` silently and leave the instance as it is, so a value that is no
 * boolean is refused before any call, except from a state-borne bag, which
 * the template cannot fix: left out, with a warning.
 */
export function readPublicAccess(
  this: NeptuneProvider,
  properties: Record<string, unknown>,
  resourceType: string,
  logicalId: string,
  physicalId: string | undefined,
  stateBorne: boolean
): boolean | undefined {
  const refusal = configBooleanRefusal(properties, 'PubliclyAccessible', logicalId);
  if (refusal === undefined) return coerceCfnBoolean(properties['PubliclyAccessible']);
  if (!stateBorne) {
    throw markNonRetryable(
      new ProvisioningError(
        safeMsg`Neptune DBInstance ${refusal}; nothing was changed.`,
        resourceType,
        logicalId,
        physicalId
      )
    );
  }
  this.logger.warn(
    safeMsg`${logicalId} (${resourceType}): the recorded PubliclyAccessible is unusable, so it is not sent.`
  );
  return undefined;
}

/**
 * go-to-k/cdkd#2762: a removed `PubliclyAccessible: true` KEEPS the instance
 * public, so the warning says so outright. Real CloudFormation A/Bs measured
 * both arms: a template removal (IamAuthEnabled on), and a rollback, where
 * the record lacks the key because the failed update added it, and the
 * rollback's keyless template left it true. A `drift --revert` baseline is a
 * readback, so nothing there was removed.
 */
export function warnPublicAccessKept(
  this: NeptuneProvider,
  logicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>,
  context: UpdateContext | undefined
): void {
  if (context?.desiredFromAwsReadback === true) return;
  const removed =
    context?.removedProperties ?? new Set(removedTemplateKeys(previousProperties, properties));
  if (!removed.has('PubliclyAccessible')) return;
  if (coerceCfnBoolean(previousProperties['PubliclyAccessible']) !== true) return;
  this.logger.warn(
    context?.replayingState === true
      ? safeMsg`${logicalId} (${resourceType}): PubliclyAccessible is absent from the state being restored, and ModifyDBInstance keeps a setting it is not sent, so the instance stays publicly accessible after this rollback, as CloudFormation leaves it. Set PubliclyAccessible: false to close it.`
      : safeMsg`${logicalId} (${resourceType}): PubliclyAccessible was removed from the template; the instance stays publicly accessible, as CloudFormation leaves it. Set PubliclyAccessible: false to close it.`
  );
}

/**
 * The `VpcSecurityGroupIds` a DBCluster update sends, or `undefined` to omit
 * it (ModifyDBCluster keeps the live groups then):
 *
 * - A non-empty declared list is sent as declared.
 * - An EMPTY list is omitted: `[]` would detach every group, and
 *   `readCurrentState` emits `[]` for a cluster with none, which
 *   `drift --revert` hands back as the desired bag.
 * - A list the previous template declared and the desired one omits is a
 *   removal (issue #1160). A real CloudFormation A/B showed CloudFormation
 *   then attaches the VPC's `default` security group in place of the
 *   declared ones, so cdkd looks that group up and sends it. A previous
 *   EMPTY list attached nothing, and a `drift --revert` baseline is a
 *   readback rather than a template, so neither counts as a removal.
 */
export async function dbClusterSecurityGroupsToSend(
  this: NeptuneProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>,
  context: UpdateContext | undefined
): Promise<string[] | undefined> {
  const desired = properties['VpcSecurityGroupIds'] as string[] | undefined;
  if (desired !== undefined) return desired.length > 0 ? desired : undefined;
  const previous = previousProperties['VpcSecurityGroupIds'];
  if (context?.desiredFromAwsReadback === true) return undefined;
  if (!Array.isArray(previous) || previous.length === 0) return undefined;

  // `missing` names what the lookup did not find (terminal); `awsError` is a
  // failed call (left retryable).
  let groupId: string | undefined;
  let missing: string | undefined;
  let awsError: unknown;
  try {
    const subnetGroupName = (await this.describeDBCluster(physicalId))?.DBSubnetGroup;
    const vpcId = subnetGroupName
      ? (
          await this.getClient().send(
            new DescribeDBSubnetGroupsCommand({ DBSubnetGroupName: subnetGroupName })
          )
        ).DBSubnetGroups?.[0]?.VpcId
      : undefined;
    if (!subnetGroupName) missing = 'the cluster reports no DB subnet group';
    else if (!vpcId) missing = `DB subnet group ${subnetGroupName} reports no VPC`;
    else {
      const groups = await this.getEc2Client().send(
        new DescribeSecurityGroupsCommand({
          Filters: [
            { Name: 'vpc-id', Values: [vpcId] },
            { Name: 'group-name', Values: ['default'] },
          ],
        })
      );
      groupId = groups.SecurityGroups?.[0]?.GroupId;
      if (!groupId) missing = `VPC ${vpcId} has no security group named default`;
    }
  } catch (error) {
    awsError = error;
  }
  if (groupId === undefined) {
    // go-to-k/cdkd#2319: the thrown message is persisted, so an AWS failure
    // contributes only its summary (an EC2 UnauthorizedOperation names the
    // caller's ARN). The full text goes to debug, masked, and the retry
    // classifier reads it on `cause`.
    const mask = context?.maskSecrets ?? ((text: string) => text);
    const failure = missing === undefined ? describeAwsFailure(awsError) : undefined;
    if (failure?.redacted === true) {
      this.logger.debug(
        safeMsg`${logicalId}: the VPC default security group lookup failed: ${mask(failure.detail)}`
      );
    }
    const shown = mask(failure?.summary ?? '');
    const refusal = new ProvisioningError(
      `Failed to update Neptune DBCluster ${logicalId}: VpcSecurityGroupIds was removed from the template, so the cluster moves to its VPC's default security group (as CloudFormation does), but cdkd could not find that group: ${missing ?? shown}. Declare VpcSecurityGroupIds in the template to choose the cluster's security groups.`,
      resourceType,
      logicalId,
      physicalId,
      awsError instanceof Error ? awsError : undefined
    );
    if (missing !== undefined) throw markNonRetryable(refusal);
    // Stamped whenever the message lost text the cause still holds: the
    // AWS-authored summary, or a masker edit (the classifier must not miss
    // retry wording a secret overlapped).
    const withheld =
      awsError instanceof Error &&
      (failure?.redacted === true || shown !== (failure?.summary ?? ''));
    throw withheld ? markRedactedCause(refusal) : refusal;
  }
  // A warning, not info: the default group may grant wider access.
  this.logger.warn(
    safeMsg`${logicalId}: VpcSecurityGroupIds was removed from the template; attaching the VPC's default security group ${groupId}, as CloudFormation does.`
  );
  return [groupId];
}
