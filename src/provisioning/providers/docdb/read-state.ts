import type { DocDBProvider } from '../docdb-provider.js';
import { isUsableAttemptedName } from '../../../state/unsettled-properties.js';
import type { ResourceNotFound } from '../../../types/resource.js';
import { RESOURCE_NOT_FOUND } from '../../../types/resource.js';
import {
  attachDocDBTags,
  docdbServerlessScaling,
  docdbStringList,
  holdsDocDBPendingValue,
  isDocDBNotFoundError,
} from '../docdb-shared.js';
import { isProceedDbStatus } from '../deletion-protection-compensation.js';
import { DOCDB_DEFAULT_STORAGE_TYPE } from './shared.js';

/**
 * What no read answers for drift. `GlobalClusterIdentifier` is not on the
 * DescribeDBClusters answer (go-to-k/cdkd#5628). `RotateMasterUserPassword` and
 * `CertificateRotationRestart` are per-call requests. `AvailabilityZones` is
 * create-only, and DescribeDBClusters reports the zones AWS placed the cluster
 * in. `MasterUserSecretKmsKeyId` may be declared as an alias or key id, where
 * the read answers one spelling. The restore keys are write-only: nothing
 * reports what a cluster was made from (go-to-k/cdkd#5628).
 */
export function getDriftUnknownPaths(this: DocDBProvider, resourceType: string): string[] {
  if (resourceType === 'AWS::DocDB::DBCluster') {
    return [
      'AvailabilityZones',
      'GlobalClusterIdentifier',
      'MasterUserSecretKmsKeyId',
      'RestoreToTime',
      'RestoreType',
      'RotateMasterUserPassword',
      'SnapshotIdentifier',
      'SourceDBClusterIdentifier',
      'UseLatestRestorableTime',
    ];
  }
  if (resourceType === 'AWS::DocDB::DBInstance') return ['CertificateRotationRestart'];
  return [];
}

/** A set to AWS, answered in its own order; `unsettledAfterUpdate` compares by it too. */
export function getDriftUnorderedPaths(this: DocDBProvider, resourceType: string): string[] {
  return resourceType === 'AWS::DocDB::DBCluster' ? ['EnableCloudwatchLogsExports'] : [];
}

/**
 * What the comparator cannot see: a repeated log type reads as the same list,
 * and a CFn capacity may be a numeric string. A malformed side is left alone.
 */
export function canonicalizeDriftProperties(
  this: DocDBProvider,
  resourceType: string,
  properties: Record<string, unknown>
): Record<string, unknown> {
  if (resourceType !== 'AWS::DocDB::DBCluster') return properties;
  const out = { ...properties };
  const logs = out['EnableCloudwatchLogsExports'];
  if (Array.isArray(logs) && docdbStringList(logs) !== undefined) {
    out['EnableCloudwatchLogsExports'] = [...new Set(logs as string[])];
  }
  const scaling = docdbServerlessScaling(out['ServerlessV2ScalingConfiguration']);
  if (scaling != null) out['ServerlessV2ScalingConfiguration'] = scaling;
  return out;
}

/** The post-update proof compares through the same normalization. */
export function canonicalizeUnsettledProperties(
  this: DocDBProvider,
  resourceType: string,
  properties: Record<string, unknown>
): Record<string, unknown> {
  return this.canonicalizeDriftProperties(resourceType, properties);
}

/**
 * go-to-k/cdkd#5487: the live values of a record's unsettled names. The log
 * list keeps only the types the record, the template or an earlier attempt
 * (#5498) names: the convergence puts this on the previous side, so a type an
 * out-of-band change enabled would otherwise read as dropped, and be disabled.
 */
export async function readUnsettled(
  this: DocDBProvider,
  physicalId: string,
  logicalId: string,
  resourceType: string,
  names: ReadonlySet<string>,
  recordedProperties?: Record<string, unknown>,
  desiredProperties?: Record<string, unknown>,
  attemptedItems?: ReadonlyMap<string, ReadonlySet<string>>
): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
  const live = await this.readCurrentState(physicalId, logicalId, resourceType);
  if (resourceType !== 'AWS::DocDB::DBCluster') return live;
  if (live === undefined || live === RESOURCE_NOT_FOUND) return live;
  if (!names.has('EnableCloudwatchLogsExports')) return live;
  const key = 'EnableCloudwatchLogsExports';
  const named = new Set([
    ...(docdbStringList(recordedProperties?.[key]) ?? []),
    ...(docdbStringList(desiredProperties?.[key]) ?? []),
    ...[...(attemptedItems?.get(key) ?? [])].filter(isUsableAttemptedName),
  ]);
  return { ...live, [key]: ((live[key] ?? []) as string[]).filter((type) => named.has(type)) };
}

/**
 * go-to-k/cdkd#5380: every name while AWS is still changing the resource. A
 * backup moves nothing, so it does not hold a deploy back. After a successful
 * update (`desiredProperties` present) nothing is reported: the caller's
 * comparison of each value with the template is the proof. A failed read
 * keeps every name.
 */
export async function unsettledInTransition(
  this: DocDBProvider,
  physicalId: string,
  _logicalId: string,
  resourceType: string,
  names: ReadonlySet<string>,
  _recordedProperties?: Record<string, unknown>,
  desiredProperties?: Record<string, unknown>
): Promise<ReadonlySet<string>> {
  if (desiredProperties !== undefined) return new Set();
  const unmoving = (status: string | undefined): boolean =>
    isProceedDbStatus(status) || status === 'backing-up';
  try {
    if (resourceType === 'AWS::DocDB::DBCluster') {
      const cluster = await this.describeDBCluster(physicalId);
      return unmoving(cluster?.Status) ? new Set() : names;
    }
    if (resourceType === 'AWS::DocDB::DBInstance') {
      const instance = await this.describeDBInstance(physicalId);
      const settled =
        unmoving(instance?.DBInstanceStatus) &&
        !holdsDocDBPendingValue(instance?.PendingModifiedValues);
      return settled ? new Set() : names;
    }
    return new Set();
  } catch {
    return names;
  }
}

/**
 * Read the AWS-current DocDB resource configuration in CFn-property shape.
 *
 * Each branch surfaces only the keys cdkd's `create()` accepts. Sensitive
 * fields like `MasterUserPassword` are NEVER surfaced (DocDB does not
 * return them in the Describe responses), and of `MasterUserSecret` only
 * whether one exists: its ARN is not a property. `Tags` are surfaced via a
 * follow-up `ListTagsForResource(ResourceName=arn)` call.
 *
 * Returns `RESOURCE_NOT_FOUND` when the resource is gone (`*NotFoundFault`
 * or an empty describe list), `undefined` for a type with no read path.
 */
export async function readCurrentState(
  this: DocDBProvider,
  physicalId: string,
  _logicalId: string,
  resourceType: string
): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
  switch (resourceType) {
    case 'AWS::DocDB::DBInstance':
      return this.readCurrentStateDBInstance(physicalId);
    case 'AWS::DocDB::DBCluster':
      return this.readCurrentStateDBCluster(physicalId);
    default:
      return undefined;
  }
}

export async function readCurrentStateDBInstance(
  this: DocDBProvider,
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
    if (isDocDBNotFoundError(err, 'DBInstanceNotFoundFault')) return undefined;
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
  if (inst.AvailabilityZone !== undefined) result['AvailabilityZone'] = inst.AvailabilityZone;
  if (inst.PreferredMaintenanceWindow !== undefined) {
    result['PreferredMaintenanceWindow'] = inst.PreferredMaintenanceWindow;
  }
  if (inst.AutoMinorVersionUpgrade !== undefined) {
    result['AutoMinorVersionUpgrade'] = inst.AutoMinorVersionUpgrade;
  }
  if (inst.CACertificateIdentifier !== undefined) {
    result['CACertificateIdentifier'] = inst.CACertificateIdentifier;
  }
  result['EnablePerformanceInsights'] = inst.PerformanceInsightsEnabled ?? false;
  if (inst.DBInstanceArn)
    await attachDocDBTags(this.getClient(), this.logger, result, inst.DBInstanceArn);
  return result;
}

export async function readCurrentStateDBCluster(
  this: DocDBProvider,
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
    if (isDocDBNotFoundError(err, 'DBClusterNotFoundFault')) return undefined;
    throw err;
  }
  if (!cluster) return RESOURCE_NOT_FOUND;

  const result: Record<string, unknown> = {};
  if (cluster.DBClusterIdentifier !== undefined) {
    result['DBClusterIdentifier'] = cluster.DBClusterIdentifier;
  }
  if (cluster.EngineVersion !== undefined) result['EngineVersion'] = cluster.EngineVersion;
  if (cluster.MasterUsername !== undefined) result['MasterUsername'] = cluster.MasterUsername;
  if (cluster.Port !== undefined) result['Port'] = cluster.Port;
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
  if (cluster.DeletionProtection !== undefined) {
    result['DeletionProtection'] = cluster.DeletionProtection;
  }
  // The drift walk compares recorded keys only, so these read nothing for an
  // older record. Absent on the wire means the default for the three below.
  result['CopyTagsToSnapshot'] = cluster.CopyTagsToSnapshot ?? false;
  result['ManageMasterUserPassword'] = cluster.MasterUserSecret !== undefined;
  result['StorageType'] = cluster.StorageType ?? DOCDB_DEFAULT_STORAGE_TYPE;
  result['EnableCloudwatchLogsExports'] = cluster.EnabledCloudwatchLogsExports ?? [];
  if (cluster.NetworkType !== undefined) result['NetworkType'] = cluster.NetworkType;
  const { MinCapacity: min, MaxCapacity: max } = cluster.ServerlessV2ScalingConfiguration ?? {};
  if (min !== undefined && max !== undefined) {
    result['ServerlessV2ScalingConfiguration'] = { MinCapacity: min, MaxCapacity: max };
  }
  if (cluster.DBClusterArn)
    await attachDocDBTags(this.getClient(), this.logger, result, cluster.DBClusterArn);
  return result;
}
