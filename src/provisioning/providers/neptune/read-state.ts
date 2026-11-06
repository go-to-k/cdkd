import type { NeptuneProvider } from '../neptune-provider.js';
import { DescribeDBSubnetGroupsCommand, ListTagsForResourceCommand } from '@aws-sdk/client-neptune';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import { normalizeAwsTagsToCfn } from '../../import-helpers.js';
import type { ResourceNotFound } from '../../../types/resource.js';
import { RESOURCE_NOT_FOUND } from '../../../types/resource.js';
import { isUsableAttemptedName } from '../../../state/unsettled-properties.js';
import {
  associatedRolesNamed,
  associatedRolesReadback,
  canonicalAssociatedRoles,
} from '../db-associated-roles.js';
import { holdsPendingValue, isUnmovingDbStatus, stringList } from './shared.js';

/**
 * What no read answers for drift. `DBInstanceParameterGroupName` and
 * `AllowMajorVersionUpgrade` are write-only per-call flags.
 * `AvailabilityZones` is create-only, and DescribeDBClusters reports the
 * zones AWS placed the cluster in, which need not be the declared list. The
 * restore keys are write-only: nothing reports what a cluster was made from.
 */
export function getDriftUnknownPaths(this: NeptuneProvider, resourceType: string): string[] {
  if (resourceType === 'AWS::Neptune::DBCluster') {
    return [
      'AvailabilityZones',
      'DBInstanceParameterGroupName',
      'RestoreToTime',
      'RestoreType',
      'SnapshotIdentifier',
      'SourceDBClusterIdentifier',
      'UseLatestRestorableTime',
    ];
  }
  if (resourceType === 'AWS::Neptune::DBInstance') return ['AllowMajorVersionUpgrade'];
  return [];
}

/**
 * Sets to AWS, answered in its own order. Also what `unsettledAfterUpdate`
 * compares by, so a template ordering them differently still settles.
 */
export function getDriftUnorderedPaths(this: NeptuneProvider, resourceType: string): string[] {
  return resourceType === 'AWS::Neptune::DBCluster'
    ? ['AssociatedRoles', 'EnableCloudwatchLogsExports', 'VpcSecurityGroupIds']
    : [];
}

/**
 * What `unorderedPaths` cannot see: AWS holds one association per role and
 * feature and no empty `FeatureName`, so a record with a repeated entry or
 * `FeatureName: ''` reads as the same list. A malformed side is left alone.
 */
export function canonicalizeDriftProperties(
  this: NeptuneProvider,
  resourceType: string,
  properties: Record<string, unknown>
): Record<string, unknown> {
  if (resourceType !== 'AWS::Neptune::DBCluster') return properties;
  const out = { ...properties };
  if (Array.isArray(out['AssociatedRoles'])) {
    out['AssociatedRoles'] = canonicalAssociatedRoles(out['AssociatedRoles']);
  }
  const logs = out['EnableCloudwatchLogsExports'];
  if (Array.isArray(logs) && stringList(logs) !== undefined) {
    out['EnableCloudwatchLogsExports'] = [...new Set(logs as string[])];
  }
  return out;
}

/** The post-update proof compares through the same normalization. */
export function canonicalizeUnsettledProperties(
  this: NeptuneProvider,
  resourceType: string,
  properties: Record<string, unknown>
): Record<string, unknown> {
  return this.canonicalizeDriftProperties(resourceType, properties);
}

/**
 * go-to-k/cdkd#5487: the live values of a record's unsettled names. The two
 * diffed lists keep only the entries the record, the template or an earlier
 * attempt (#5498) names: the convergence puts this on the previous side, so
 * a role or log type an out-of-band change added would otherwise read as
 * dropped by the template, and be detached.
 */
export async function readUnsettled(
  this: NeptuneProvider,
  physicalId: string,
  logicalId: string,
  resourceType: string,
  names: ReadonlySet<string>,
  recordedProperties?: Record<string, unknown>,
  desiredProperties?: Record<string, unknown>,
  attemptedItems?: ReadonlyMap<string, ReadonlySet<string>>
): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
  const live = await this.readCurrentState(physicalId, logicalId, resourceType);
  if (resourceType !== 'AWS::Neptune::DBCluster') return live;
  if (live === undefined || live === RESOURCE_NOT_FOUND) return live;
  const attempted = (key: string): string[] =>
    [...(attemptedItems?.get(key) ?? [])].filter(isUsableAttemptedName);
  const out = { ...live };
  if (names.has('AssociatedRoles')) {
    out['AssociatedRoles'] = associatedRolesNamed(
      live['AssociatedRoles'],
      recordedProperties?.['AssociatedRoles'],
      desiredProperties?.['AssociatedRoles'],
      attemptedItems?.get('AssociatedRoles')
    );
  }
  if (names.has('EnableCloudwatchLogsExports')) {
    const named = new Set([
      ...(stringList(recordedProperties?.['EnableCloudwatchLogsExports']) ?? []),
      ...(stringList(desiredProperties?.['EnableCloudwatchLogsExports']) ?? []),
      ...attempted('EnableCloudwatchLogsExports'),
    ]);
    out['EnableCloudwatchLogsExports'] = (
      (live['EnableCloudwatchLogsExports'] ?? []) as string[]
    ).filter((type) => named.has(type));
  }
  return out;
}

/**
 * go-to-k/cdkd#5380: every name while AWS is still changing the resource: a
 * status a Modify is refused in (`upgrading`), or a pending modification (a
 * change waiting for its window, or a log export on its way). A backup moves
 * nothing, so it does not hold a deploy back. After a successful update
 * (`desiredProperties` present) nothing is reported: a convergent Modify
 * leaves the cluster `modifying`, and the caller's comparison of each value
 * with the template is the proof, so a value not there yet stays unsettled
 * and one that is does not. A failed read keeps every name.
 */
export async function unsettledInTransition(
  this: NeptuneProvider,
  physicalId: string,
  _logicalId: string,
  resourceType: string,
  names: ReadonlySet<string>,
  _recordedProperties?: Record<string, unknown>,
  desiredProperties?: Record<string, unknown>
): Promise<ReadonlySet<string>> {
  if (desiredProperties !== undefined) return new Set();
  try {
    if (resourceType === 'AWS::Neptune::DBCluster') {
      const cluster = await this.describeDBCluster(physicalId);
      const settled =
        isUnmovingDbStatus(cluster?.Status) && !holdsPendingValue(cluster?.PendingModifiedValues);
      return settled ? new Set() : names;
    }
    if (resourceType === 'AWS::Neptune::DBInstance') {
      const instance = await this.describeDBInstance(physicalId);
      const settled =
        isUnmovingDbStatus(instance?.DBInstanceStatus) &&
        !holdsPendingValue(instance?.PendingModifiedValues);
      return settled ? new Set() : names;
    }
    return new Set();
  } catch {
    return names;
  }
}

/**
 * Read the AWS-current Neptune resource configuration in CFn-property
 * shape. Each branch surfaces only the keys cdkd's `create()` accepts.
 * Sensitive fields are NEVER surfaced. `Tags` are surfaced via a
 * follow-up `ListTagsForResource(ResourceName=arn)` call.
 */
export async function readCurrentState(
  this: NeptuneProvider,
  physicalId: string,
  _logicalId: string,
  resourceType: string
): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
  switch (resourceType) {
    case 'AWS::Neptune::DBInstance':
      return this.readCurrentStateDBInstance(physicalId);
    case 'AWS::Neptune::DBCluster':
      return this.readCurrentStateDBCluster(physicalId);
    case 'AWS::Neptune::DBSubnetGroup':
      return this.readCurrentStateDBSubnetGroup(physicalId);
    default:
      return undefined;
  }
}

export async function readCurrentStateDBInstance(
  this: NeptuneProvider,
  physicalId: string
): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
  let inst;
  try {
    inst = await this.describeDBInstance(physicalId);
  } catch (err) {
    // go-to-k/cdkd#4283: only the fault NAME proves the resource is gone;
    // the looser message match keeps its old "cannot tell" answer.
    if ((err as { name?: unknown } | null)?.name === 'DBInstanceNotFoundFault')
      return RESOURCE_NOT_FOUND;
    if (this.isNotFoundError(err, 'DBInstanceNotFoundFault')) return undefined;
    throw err;
  }
  if (!inst) return RESOURCE_NOT_FOUND;

  const result: Record<string, unknown> = {};
  if (inst.DBInstanceIdentifier !== undefined) {
    result['DBInstanceIdentifier'] = inst.DBInstanceIdentifier;
  }
  if (inst.DBInstanceClass !== undefined) result['DBInstanceClass'] = inst.DBInstanceClass;
  if (inst.DBClusterIdentifier !== undefined) {
    result['DBClusterIdentifier'] = inst.DBClusterIdentifier;
  }
  if (inst.DBSubnetGroup?.DBSubnetGroupName !== undefined) {
    result['DBSubnetGroupName'] = inst.DBSubnetGroup.DBSubnetGroupName;
  }
  if (inst.AvailabilityZone !== undefined) result['AvailabilityZone'] = inst.AvailabilityZone;
  if (inst.PreferredMaintenanceWindow !== undefined) {
    result['PreferredMaintenanceWindow'] = inst.PreferredMaintenanceWindow;
  }
  if (inst.AutoMinorVersionUpgrade !== undefined) {
    result['AutoMinorVersionUpgrade'] = inst.AutoMinorVersionUpgrade;
  }
  if (inst.DeletionProtection !== undefined) {
    result['DeletionProtection'] = inst.DeletionProtection;
  }
  if (inst.PubliclyAccessible !== undefined) {
    result['PubliclyAccessible'] = inst.PubliclyAccessible;
  }
  // DBParameterGroupName: Neptune's DescribeDBInstances returns
  // DBParameterGroups[] — surface the first entry's name when present.
  const pg = inst.DBParameterGroups?.[0]?.DBParameterGroupName;
  if (pg !== undefined) result['DBParameterGroupName'] = pg;

  if (inst.DBInstanceArn) await this.attachTags(result, inst.DBInstanceArn);
  return result;
}

export async function readCurrentStateDBCluster(
  this: NeptuneProvider,
  physicalId: string
): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
  let cluster;
  try {
    cluster = await this.describeDBCluster(physicalId);
  } catch (err) {
    // go-to-k/cdkd#4283: only the fault NAME proves the resource is gone;
    // the looser message match keeps its old "cannot tell" answer.
    if ((err as { name?: unknown } | null)?.name === 'DBClusterNotFoundFault')
      return RESOURCE_NOT_FOUND;
    if (this.isNotFoundError(err, 'DBClusterNotFoundFault')) return undefined;
    throw err;
  }
  if (!cluster) return RESOURCE_NOT_FOUND;

  const result: Record<string, unknown> = {};
  if (cluster.DBClusterIdentifier !== undefined) {
    result['DBClusterIdentifier'] = cluster.DBClusterIdentifier;
  }
  if (cluster.EngineVersion !== undefined) result['EngineVersion'] = cluster.EngineVersion;
  // CFn schema spells the writable port field `DBPort`; `Port` is the
  // (readOnly) output field. Emit BOTH so drift works for state files
  // written by either the new `DBPort` (post-#613 fix) or the legacy
  // `Port` template shape.
  if (cluster.Port !== undefined) {
    result['Port'] = cluster.Port;
    result['DBPort'] = cluster.Port;
  }
  result['VpcSecurityGroupIds'] = (cluster.VpcSecurityGroups ?? [])
    .map((sg) => sg.VpcSecurityGroupId)
    .filter((id): id is string => !!id);
  if (cluster.DBSubnetGroup !== undefined) result['DBSubnetGroupName'] = cluster.DBSubnetGroup;
  if (cluster.StorageEncrypted !== undefined) {
    result['StorageEncrypted'] = cluster.StorageEncrypted;
  }
  if (cluster.KmsKeyId !== undefined) result['KmsKeyId'] = cluster.KmsKeyId;
  if (cluster.BackupRetentionPeriod !== undefined) {
    result['BackupRetentionPeriod'] = cluster.BackupRetentionPeriod;
  }
  if (cluster.PreferredBackupWindow !== undefined) {
    result['PreferredBackupWindow'] = cluster.PreferredBackupWindow;
  }
  if (cluster.PreferredMaintenanceWindow !== undefined) {
    result['PreferredMaintenanceWindow'] = cluster.PreferredMaintenanceWindow;
  }
  if (cluster.DBClusterParameterGroup !== undefined) {
    result['DBClusterParameterGroupName'] = cluster.DBClusterParameterGroup;
  }
  if (cluster.IAMDatabaseAuthenticationEnabled !== undefined) {
    result['IamAuthEnabled'] = cluster.IAMDatabaseAuthenticationEnabled;
  }
  if (cluster.DeletionProtection !== undefined) {
    result['DeletionProtection'] = cluster.DeletionProtection;
  }
  if (cluster.CopyTagsToSnapshot !== undefined) {
    result['CopyTagsToSnapshot'] = cluster.CopyTagsToSnapshot;
  }
  if (cluster.NetworkType !== undefined) result['NetworkType'] = cluster.NetworkType;
  const { MinCapacity: min, MaxCapacity: max } = cluster.ServerlessV2ScalingConfiguration ?? {};
  if (min !== undefined || max !== undefined) {
    result['ServerlessScalingConfiguration'] = {
      ...(min !== undefined && { MinCapacity: min }),
      ...(max !== undefined && { MaxCapacity: max }),
    };
  }
  // Always a list, as VpcSecurityGroupIds: a role or log type lost out of
  // band must read as a change against the recorded list.
  result['EnableCloudwatchLogsExports'] = cluster.EnabledCloudwatchLogsExports ?? [];
  result['AssociatedRoles'] = associatedRolesReadback(cluster.AssociatedRoles);
  if (cluster.DBClusterArn) await this.attachTags(result, cluster.DBClusterArn);
  return result;
}

export async function readCurrentStateDBSubnetGroup(
  this: NeptuneProvider,
  physicalId: string
): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
  let resp: {
    DBSubnetGroups?: Array<{
      DBSubnetGroupName?: string;
      DBSubnetGroupArn?: string;
      DBSubnetGroupDescription?: string;
      Subnets?: Array<{ SubnetIdentifier?: string }>;
    }>;
  };
  try {
    resp = (await this.getClient().send(
      new DescribeDBSubnetGroupsCommand({ DBSubnetGroupName: physicalId })
    )) as unknown as typeof resp;
  } catch (err) {
    // go-to-k/cdkd#4283: only the fault NAME proves the resource is gone;
    // the looser message match keeps its old "cannot tell" answer.
    if ((err as { name?: unknown } | null)?.name === 'DBSubnetGroupNotFoundFault')
      return RESOURCE_NOT_FOUND;
    if (this.isNotFoundError(err, 'DBSubnetGroupNotFoundFault')) return undefined;
    throw err;
  }
  const sg = resp.DBSubnetGroups?.[0];
  if (!sg) return RESOURCE_NOT_FOUND;

  const result: Record<string, unknown> = {};
  if (sg.DBSubnetGroupName !== undefined) result['DBSubnetGroupName'] = sg.DBSubnetGroupName;
  if (sg.DBSubnetGroupDescription !== undefined) {
    result['DBSubnetGroupDescription'] = sg.DBSubnetGroupDescription;
  }
  result['SubnetIds'] = (sg.Subnets ?? [])
    .map((s) => s.SubnetIdentifier)
    .filter((id): id is string => !!id);
  if (sg.DBSubnetGroupArn) await this.attachTags(result, sg.DBSubnetGroupArn);
  return result;
}

/**
 * Fetch tags via `ListTagsForResource` and merge them into the result
 * under `Tags` (CFn shape). Best-effort.
 */
export async function attachTags(
  this: NeptuneProvider,
  result: Record<string, unknown>,
  arn: string
): Promise<void> {
  try {
    const tagsResp = await this.getClient().send(
      new ListTagsForResourceCommand({ ResourceName: arn })
    );
    const tags = normalizeAwsTagsToCfn(tagsResp.TagList);
    result['Tags'] = tags;
  } catch (err) {
    this.logger.debug(
      `Neptune ListTagsForResource(${arn}) failed: ${describeAwsFailure(err).detail}`
    );
  }
}
