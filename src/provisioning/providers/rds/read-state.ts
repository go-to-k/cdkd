import { DescribeDBClustersCommand, DescribeDBInstancesCommand } from '@aws-sdk/client-rds';
import { resolveExplicitPhysicalId } from '../../import-helpers.js';
import type {
  ResourceImportInput,
  ResourceImportResult,
  ResourceIdentityVerdict,
  ResourceNotFound,
} from '../../../types/resource.js';
import { RESOURCE_NOT_FOUND } from '../../../types/resource.js';
import { definedAttributes, stringifyIfAssigned } from '../../attribute-map.js';
import { associatedRolesNamed, associatedRolesReadback } from '../db-associated-roles.js';
import type { RDSProvider } from '../rds-provider.js';
import { replicatedBackupRetention } from './calls.js';
import { liveLogExports, liveProcessorFeatures } from './instance-members.js';
import { isDbIdentifier } from './shared.js';

/**
 * go-to-k/cdkd#5487: the live values of a record's unsettled names. Only
 * `AssociatedRoles` is ever marked (`applyAssociatedRoles`), and it keeps
 * only the associations the record, the template or an earlier attempt
 * (#5498) names: the convergence puts this on the previous side, so a role
 * an out-of-band change attached would otherwise read as dropped by the
 * template, and be detached.
 */
export async function readUnsettled(
  this: RDSProvider,
  physicalId: string,
  logicalId: string,
  resourceType: string,
  names: ReadonlySet<string>,
  recordedProperties?: Record<string, unknown>,
  desiredProperties?: Record<string, unknown>,
  attemptedItems?: ReadonlyMap<string, ReadonlySet<string>>
): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
  const live = await this.readCurrentState(physicalId, logicalId, resourceType);
  if (live === undefined || live === RESOURCE_NOT_FOUND) return live;
  if (!names.has('AssociatedRoles')) return live;
  return {
    ...live,
    AssociatedRoles: associatedRolesNamed(
      live['AssociatedRoles'],
      recordedProperties?.['AssociatedRoles'],
      desiredProperties?.['AssociatedRoles'],
      attemptedItems?.get('AssociatedRoles')
    ),
  };
}

/**
 * Read the AWS-current RDS resource configuration in CFn-property shape.
 *
 * Dispatches by resource type:
 *   - `AWS::RDS::DBInstance` → `DescribeDBInstances`
 *   - `AWS::RDS::DBCluster` → `DescribeDBClusters`
 *   - `AWS::RDS::DBSubnetGroup` → `DescribeDBSubnetGroups`
 *
 * Each branch surfaces only the keys cdkd's `create()` accepts. Sensitive
 * fields like `MasterUserPassword` are NEVER surfaced (RDS does not return
 * them in the Describe responses). `Tags` are surfaced via a follow-up
 * `ListTagsForResource(ResourceName=arn)` call (RDS uses `[{Key, Value}]`
 * shape). CDK's `aws:*` auto-tags are filtered out; the result key is
 * omitted entirely when AWS reports no user tags.
 *
 * Returns `RESOURCE_NOT_FOUND` when the resource is gone (`*NotFoundFault`
 * or an empty describe list), `undefined` for a type with no read path.
 */
export async function readCurrentState(
  this: RDSProvider,
  physicalId: string,
  _logicalId: string,
  resourceType: string
): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
  switch (resourceType) {
    case 'AWS::RDS::DBInstance':
      return this.readCurrentStateDBInstance(physicalId);
    case 'AWS::RDS::DBCluster':
      return this.readCurrentStateDBCluster(physicalId);
    case 'AWS::RDS::DBSubnetGroup':
      return this.readCurrentStateDBSubnetGroup(physicalId);
    default:
      return undefined;
  }
}

/**
 * go-to-k/cdkd#4606: whether the DB cluster or DB instance a failed CREATE
 * journaled is the one the record under the same logical id holds (a
 * fix-forward that created a new one there under another identifier).
 *
 * Reached on the SDK route only (Cloud Control's provider has no
 * `isSameResource`, so a Cloud Control-routed orphan is `'unknown'`). Both
 * ids must be DB identifiers; an ARN or anything else is `'unknown'`, as
 * is a DBSubnetGroup. An identifier names at most
 * one cluster (or instance) per account and region at a time, and RDS
 * compares identifiers case-insensitively (it stores them lower-cased), so
 * two spellings equal modulo case are `'same'` without a read: whatever
 * holds that identifier now is the record's resource. After the region
 * check the record's resource must read back (else `'unknown'`); the
 * journaled one is `'same'` when it reads back under the record's
 * `DbClusterResourceId` / `DbiResourceId` (immutable, unique, unchanged by
 * a rename), `'different'` under another, and `'different'` when AWS
 * reports its identifier gone: the record's resource answers to its own,
 * other, identifier, so the gone one cannot name it, and its delete
 * settles as already gone.
 */
export async function isSameResource(
  this: RDSProvider,
  journaledPhysicalId: string,
  record: { physicalId: string },
  resourceType: string,
  context: { expectedRegion: string }
): Promise<ResourceIdentityVerdict> {
  if (resourceType !== 'AWS::RDS::DBCluster' && resourceType !== 'AWS::RDS::DBInstance') {
    return 'unknown';
  }
  if (!isDbIdentifier(journaledPhysicalId) || !isDbIdentifier(record.physicalId)) {
    return 'unknown';
  }
  if (journaledPhysicalId.toLowerCase() === record.physicalId.toLowerCase()) return 'same';
  const clientRegion = await this.getClient().config.region();
  if (clientRegion !== context.expectedRegion) return 'unknown';
  const recordResourceId = await this.readDbResourceIdIfExists(resourceType, record.physicalId);
  if (recordResourceId === undefined) return 'unknown';
  const journaledResourceId = await this.readDbResourceIdIfExists(
    resourceType,
    journaledPhysicalId
  );
  if (journaledResourceId === undefined) return 'different';
  return journaledResourceId === recordResourceId ? 'same' : 'different';
}

/**
 * go-to-k/cdkd#4655: the cluster's `DbClusterResourceId` or the instance's
 * `DbiResourceId`, which AWS generates, never changes (a rename keeps it)
 * and never gives a later resource. A cluster or instance re-created under
 * the identifier, in any case spelling, answers with another id, so the
 * settle keeps it rather than deleting it as the failed CREATE's orphan.
 * A failed CREATE's own token comes from its create response, on the
 * failure's mark (`markCreatedBeforeFailure`); this is the live read.
 *
 * `undefined` for another type, an id that is not a DB identifier, or a
 * client in another region than `expectedRegion`. `RESOURCE_NOT_FOUND`
 * only on the describe's not-found fault NAME (or an empty list); any
 * other failure throws.
 */
export async function resourceIdentity(
  this: RDSProvider,
  physicalId: string,
  resourceType: string,
  context: { expectedRegion: string }
): Promise<string | ResourceNotFound | undefined> {
  if (resourceType !== 'AWS::RDS::DBCluster' && resourceType !== 'AWS::RDS::DBInstance') {
    return undefined;
  }
  if (!isDbIdentifier(physicalId)) return undefined;
  const clientRegion = await this.getClient().config.region();
  if (clientRegion !== context.expectedRegion) return undefined;
  const live = await this.readDbResourceIdIfExists(resourceType, physicalId);
  return live === undefined ? RESOURCE_NOT_FOUND : live;
}

/**
 * The cluster's `DbClusterResourceId` (or the instance's `DbiResourceId`),
 * or `undefined` when AWS reports the identifier gone (its not-found fault
 * NAME, or an empty describe list). Any other failure, a response naming
 * another identifier and one naming no resource id throw: "could not read"
 * never reads as "gone".
 */
export async function readDbResourceIdIfExists(
  this: RDSProvider,
  resourceType: 'AWS::RDS::DBCluster' | 'AWS::RDS::DBInstance',
  identifier: string
): Promise<string | undefined> {
  const isCluster = resourceType === 'AWS::RDS::DBCluster';
  let found: { identifier: string | undefined; resourceId: string | undefined } | undefined;
  try {
    if (isCluster) {
      const cluster = await this.describeDBCluster(identifier);
      found = cluster && {
        identifier: cluster.DBClusterIdentifier,
        resourceId: cluster.DbClusterResourceId,
      };
    } else {
      const instance = await this.describeDBInstance(identifier);
      found = instance && {
        identifier: instance.DBInstanceIdentifier,
        resourceId: instance.DbiResourceId,
      };
    }
  } catch (error) {
    const notFound = isCluster ? 'DBClusterNotFoundFault' : 'DBInstanceNotFoundFault';
    if ((error as { name?: unknown } | null)?.name === notFound) return undefined;
    throw error;
  }
  if (found === undefined) return undefined;
  const api = isCluster ? 'DescribeDBClusters' : 'DescribeDBInstances';
  if (found.identifier?.toLowerCase() !== identifier.toLowerCase()) {
    throw new Error(`${api} answered for another identifier`);
  }
  if (typeof found.resourceId !== 'string' || found.resourceId === '') {
    throw new Error(`${api} returned no resource id`);
  }
  return found.resourceId;
}

export async function readCurrentStateDBInstance(
  this: RDSProvider,
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
  if (inst.Engine !== undefined) result['Engine'] = inst.Engine;
  if (inst.DBClusterIdentifier !== undefined) {
    result['DBClusterIdentifier'] = inst.DBClusterIdentifier;
  }
  if (inst.DBSubnetGroup?.DBSubnetGroupName !== undefined) {
    result['DBSubnetGroupName'] = inst.DBSubnetGroup.DBSubnetGroupName;
  }
  if (inst.PubliclyAccessible !== undefined) {
    result['PubliclyAccessible'] = inst.PubliclyAccessible;
  }
  // #609 backfill — AllocatedStorage + MasterUsername readbacks
  // (AWS-required sibling props, paired with the 5 below). MasterUsername
  // IS surfaced (unlike MasterUserPassword which AWS never returns).
  if (inst.AllocatedStorage !== undefined) {
    result['AllocatedStorage'] = inst.AllocatedStorage;
  }
  if (inst.MasterUsername !== undefined) result['MasterUsername'] = inst.MasterUsername;
  // #609 backfill — 5 readable sibling props matching DBCluster.
  // `MasterUserPassword` is intentionally NOT surfaced here: RDS never
  // returns the password in the Describe response (security), so any
  // value would be a phantom drift on every read.
  if (inst.DeletionProtection !== undefined) {
    result['DeletionProtection'] = inst.DeletionProtection;
  }
  if (inst.EngineVersion !== undefined) result['EngineVersion'] = inst.EngineVersion;
  // CFn `Port` → AWS Describe surface is `Endpoint.Port` (the active
  // listener port). The DBInstance shape has no top-level `Port` field
  // and no `DBPortNumber` either; the Modify-side `DBPortNumber` is a
  // request-shape oddity. Emit only when the endpoint is present
  // (briefly absent during create/modify transitions).
  if (inst.Endpoint?.Port !== undefined) result['Port'] = inst.Endpoint.Port;
  if (inst.StorageEncrypted !== undefined) {
    result['StorageEncrypted'] = inst.StorageEncrypted;
  }
  // CFn `VPCSecurityGroups` (string[]) ↔ AWS `VpcSecurityGroups[].VpcSecurityGroupId`.
  // Emit only when AWS returned a non-empty list — matches DBInstance's
  // overall "emit-when-present" pattern (vs DBCluster's "emit-always"
  // shape, which is a minor inconsistency in the cluster readback). The
  // drift calculator only descends into keys present in state, so an
  // omit-when-empty here still surfaces "state has SGs → AWS has none"
  // drift correctly via the state-side branch.
  const sgIds = (inst.VpcSecurityGroups ?? [])
    .map((sg) => sg.VpcSecurityGroupId)
    .filter((id): id is string => !!id);
  if (sgIds.length > 0) result['VPCSecurityGroups'] = sgIds;
  // #609 security-cluster backfill readbacks.
  if (inst.KmsKeyId !== undefined) result['KmsKeyId'] = inst.KmsKeyId;
  if (inst.MonitoringRoleArn !== undefined) {
    result['MonitoringRoleArn'] = inst.MonitoringRoleArn;
  }
  if (inst.MonitoringInterval !== undefined) {
    result['MonitoringInterval'] = inst.MonitoringInterval;
  }
  // AWS Describe surfaces this as `IAMDatabaseAuthenticationEnabled`; CFn /
  // cdkd state names it `EnableIAMDatabaseAuthentication`.
  if (inst.IAMDatabaseAuthenticationEnabled !== undefined) {
    result['EnableIAMDatabaseAuthentication'] = inst.IAMDatabaseAuthenticationEnabled;
  }
  // `MasterUserSecret` round-trips as `{ KmsKeyId }` (the only create-shape
  // member). Emit only when AWS reports a KmsKeyId so a non-managed-secret
  // instance (state has no such key) does not get a false-positive drift.
  // `ManageMasterUserPassword` itself is NOT a Describe field — its
  // create-time value is reflected only by the presence of MasterUserSecret,
  // so it is intentionally not read back (would be a phantom drift on every
  // read, like MasterUserPassword).
  if (inst.MasterUserSecret?.KmsKeyId !== undefined) {
    result['MasterUserSecret'] = { KmsKeyId: inst.MasterUserSecret.KmsKeyId };
  }
  // go-to-k/cdkd#2762: same names on the Describe shape, except
  // `PerformanceInsightsEnabled` and the option group membership.
  const sameName = [
    'BackupRetentionPeriod',
    'PreferredBackupWindow',
    'PreferredMaintenanceWindow',
    'StorageType',
    'MultiAZ',
    'MaxAllocatedStorage',
    'AutoMinorVersionUpgrade',
    'CopyTagsToSnapshot',
    'PerformanceInsightsKMSKeyId',
    'PerformanceInsightsRetentionPeriod',
    'Iops',
    'StorageThroughput',
    'CACertificateIdentifier',
    'NetworkType',
    'LicenseModel',
    'PromotionTier',
    'DatabaseInsightsMode',
    'DedicatedLogVolume',
  ] as const;
  for (const key of sameName) {
    if (inst[key] !== undefined) result[key] = inst[key];
  }
  if (inst.PerformanceInsightsEnabled !== undefined) {
    result['EnablePerformanceInsights'] = inst.PerformanceInsightsEnabled;
  }
  // During an option group change the old membership is listed beside the
  // new one; the new one is `pending-apply`, then `in-sync`.
  const memberships = inst.OptionGroupMemberships ?? [];
  const optionGroupName = (
    memberships.find((m) => m.Status === 'in-sync' || m.Status === 'pending-apply') ??
    memberships[0]
  )?.OptionGroupName;
  if (optionGroupName !== undefined) result['OptionGroupName'] = optionGroupName;
  // go-to-k/cdkd#2762: the first listed group, as CloudFormation's read
  // handler reports it. RDS stores the name lower-cased; no fold, as for the
  // DB cluster's group: drift compares against the `observedProperties`
  // baseline every record this route writes carries.
  const parameterGroupName = inst.DBParameterGroups?.[0]?.DBParameterGroupName;
  if (parameterGroupName !== undefined) result['DBParameterGroupName'] = parameterGroupName;
  // go-to-k/cdkd#5640: emitted only when non-empty, as an instance exporting
  // nothing reads; compared order-insensitively (`getDriftUnorderedPaths`).
  // Not for a cluster member: DescribeDBInstances reports the CLUSTER's list
  // there (read on DocDB and Neptune members, the same API), which the
  // cluster owns, so a member's baseline would go stale on a cluster change.
  if (inst.DBClusterIdentifier === undefined) {
    const instanceLogs = liveLogExports(
      inst.EnabledCloudwatchLogsExports,
      inst.PendingModifiedValues?.PendingCloudwatchLogsExports
    );
    if (instanceLogs.length > 0) result['EnableCloudwatchLogsExports'] = instanceLogs;
  }
  // go-to-k/cdkd#5640: the features the instance runs with once a pending
  // change applies, emitted only when listed. `UseDefaultProcessorFeatures`
  // is write-only in the registry schema and not on the Describe shape.
  const processorFeatures = liveProcessorFeatures(inst);
  if (processorFeatures !== undefined && processorFeatures.length > 0) {
    result['ProcessorFeatures'] = processorFeatures.map((feature) => ({
      Name: feature.Name,
      Value: feature.Value,
    }));
  }
  // go-to-k/cdkd#5640: the replication's destination region, off its
  // automated backup's ARN, and that backup's retention, read there, as
  // CloudFormation's read handler reads both (one more call, only for an
  // instance that replicates). The KMS key is write-only in the registry
  // schema, so it is not read back.
  const replicationArn =
    inst.DBInstanceAutomatedBackupsReplications?.[0]?.DBInstanceAutomatedBackupsArn;
  const replicationRegion = replicationArn?.split(':')[3];
  if (replicationArn !== undefined && replicationRegion !== undefined && replicationRegion !== '') {
    result['AutomaticBackupReplicationRegion'] = replicationRegion;
    const retention = await replicatedBackupRetention.call(this, replicationArn);
    if (retention !== undefined) {
      result['AutomaticBackupReplicationRetentionPeriod'] = retention;
    }
  }
  // go-to-k/cdkd#5640: same names on the Describe shape. The zone only for a
  // single-AZ instance: a Multi-AZ one moves to its standby's zone on every
  // failover, which no template controls.
  if (inst.DBName !== undefined) result['DBName'] = inst.DBName;
  if (inst.AvailabilityZone !== undefined && inst.MultiAZ !== true) {
    result['AvailabilityZone'] = inst.AvailabilityZone;
  }
  // go-to-k/cdkd#5640: same name on the Describe shape. Not for a cluster
  // member, whose lifecycle the CLUSTER owns (the member reports the
  // cluster's). `MasterUserAuthenticationType` is write-only in the registry
  // schema and absent from DescribeDBInstances, so it is not read back.
  if (inst.EngineLifecycleSupport !== undefined && inst.DBClusterIdentifier === undefined) {
    result['EngineLifecycleSupport'] = inst.EngineLifecycleSupport;
  }
  // go-to-k/cdkd#5640: the source of a read replica, always as an ARN, as a
  // CDK template names it. RDS reports a same-region source by its bare
  // identifier, which names an instance in the replica's own region and
  // account, so it takes the replica's own ARN prefix (`DBInstanceArn`); a
  // cross-region source already reads as its ARN. Drift then compares region,
  // account and name (`canonicalizeDriftPair`). Absent once promoted, so a
  // promotion outside cdkd reads as a removal.
  const liveSource = inst.ReadReplicaSourceDBInstanceIdentifier;
  if (liveSource !== undefined && liveSource !== '') {
    const ownArn = inst.DBInstanceArn;
    result['SourceDBInstanceIdentifier'] =
      liveSource.startsWith('arn:') || ownArn === undefined || !ownArn.startsWith('arn:')
        ? liveSource
        : `${ownArn.slice(0, ownArn.lastIndexOf(':') + 1)}${liveSource}`;
  }
  // go-to-k/cdkd#5640: always a list, so a role lost out of band reads as a
  // change against the recorded list (`Status` is not a template member).
  result['AssociatedRoles'] = associatedRolesReadback(inst.AssociatedRoles);
  if (inst.DBInstanceArn) await this.attachTags(result, inst.DBInstanceArn);
  return result;
}

export async function readCurrentStateDBCluster(
  this: RDSProvider,
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
  if (cluster.Engine !== undefined) result['Engine'] = cluster.Engine;
  if (cluster.EngineVersion !== undefined) result['EngineVersion'] = cluster.EngineVersion;
  if (cluster.MasterUsername !== undefined) result['MasterUsername'] = cluster.MasterUsername;
  if (cluster.DatabaseName !== undefined) result['DatabaseName'] = cluster.DatabaseName;
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
  if (cluster.DeletionProtection !== undefined) {
    result['DeletionProtection'] = cluster.DeletionProtection;
  }
  // #609 security-cluster backfill readbacks.
  if (cluster.MonitoringRoleArn !== undefined) {
    result['MonitoringRoleArn'] = cluster.MonitoringRoleArn;
  }
  if (cluster.MonitoringInterval !== undefined) {
    result['MonitoringInterval'] = cluster.MonitoringInterval;
  }
  // AWS Describe surfaces this as `IAMDatabaseAuthenticationEnabled`; CFn /
  // cdkd state names it `EnableIAMDatabaseAuthentication`.
  if (cluster.IAMDatabaseAuthenticationEnabled !== undefined) {
    result['EnableIAMDatabaseAuthentication'] = cluster.IAMDatabaseAuthenticationEnabled;
  }
  if (cluster.PubliclyAccessible !== undefined) {
    result['PubliclyAccessible'] = cluster.PubliclyAccessible;
  }
  // `MasterUserSecret` round-trips as `{ KmsKeyId }`. Emit only when AWS
  // reports a KmsKeyId. `ManageMasterUserPassword` is not a Describe field
  // (its create-time value is reflected only by MasterUserSecret presence),
  // so it is intentionally not read back — like MasterUserPassword.
  if (cluster.MasterUserSecret?.KmsKeyId !== undefined) {
    result['MasterUserSecret'] = { KmsKeyId: cluster.MasterUserSecret.KmsKeyId };
  }
  // Class 1 — ServerlessV2ScalingConfiguration is only valid for Aurora
  // Serverless v2 clusters. Emit only when AWS actually returns one or
  // more of the discriminator fields (MinCapacity / MaxCapacity); on a
  // provisioned-mode cluster AWS leaves the entire field undefined and
  // emitting `{}` here would (a) round-trip through update() into
  // `ModifyDBCluster` with `ServerlessV2ScalingConfiguration: { Min: u, Max: u }`
  // which AWS rejects with "ServerlessV2ScalingConfiguration is only
  // supported on Aurora Serverless v2 clusters", and (b) fire a
  // false-positive drift on every non-serverless cluster (state has no
  // such key). See docs/provider-rules.md#readcurrentstate-for-drift-detection.
  if (
    cluster.ServerlessV2ScalingConfiguration?.MinCapacity !== undefined ||
    cluster.ServerlessV2ScalingConfiguration?.MaxCapacity !== undefined
  ) {
    const sc: Record<string, unknown> = {};
    if (cluster.ServerlessV2ScalingConfiguration?.MinCapacity !== undefined) {
      sc['MinCapacity'] = cluster.ServerlessV2ScalingConfiguration.MinCapacity;
    }
    if (cluster.ServerlessV2ScalingConfiguration?.MaxCapacity !== undefined) {
      sc['MaxCapacity'] = cluster.ServerlessV2ScalingConfiguration.MaxCapacity;
    }
    // Issue #5466: drift sees the auto-pause delay too.
    if (cluster.ServerlessV2ScalingConfiguration?.SecondsUntilAutoPause !== undefined) {
      sc['SecondsUntilAutoPause'] = cluster.ServerlessV2ScalingConfiguration.SecondsUntilAutoPause;
    }
    result['ServerlessV2ScalingConfiguration'] = sc;
  }
  // go-to-k/cdkd#2762: same names on the Describe shape, except the
  // parameter group's. DescribeDBClusters omits `StorageType` on an Aurora
  // Standard cluster (read us-east-1, 2026-11-01); CloudFormation's read
  // handler reports `aurora` there, and so does this, on Aurora engines only.
  if (cluster.DBClusterParameterGroup !== undefined) {
    result['DBClusterParameterGroupName'] = cluster.DBClusterParameterGroup;
  }
  if (cluster.PreferredBackupWindow !== undefined) {
    result['PreferredBackupWindow'] = cluster.PreferredBackupWindow;
  }
  if (cluster.PreferredMaintenanceWindow !== undefined) {
    result['PreferredMaintenanceWindow'] = cluster.PreferredMaintenanceWindow;
  }
  if (cluster.CopyTagsToSnapshot !== undefined) {
    result['CopyTagsToSnapshot'] = cluster.CopyTagsToSnapshot;
  }
  // A storage type change can sit in `PendingModifiedValues` after
  // ModifyDBCluster returns (CloudFormation's handler waits for it to clear),
  // so the pending one is what the cluster is moving to: read it first, or
  // the capture right after the update records the old type.
  const storageType =
    cluster.PendingModifiedValues?.StorageType ??
    cluster.StorageType ??
    (cluster.Engine?.toLowerCase().startsWith('aurora') ? 'aurora' : undefined);
  if (storageType !== undefined) result['StorageType'] = storageType;
  // go-to-k/cdkd#5639: a Multi-AZ DB cluster's instance class and storage,
  // the pending size and IOPS first, as for the storage type. Not on an Aurora
  // engine, where they are not template members and any size RDS reports is
  // not one the template set.
  if (!cluster.Engine?.toLowerCase().startsWith('aurora')) {
    if (cluster.DBClusterInstanceClass !== undefined) {
      result['DBClusterInstanceClass'] = cluster.DBClusterInstanceClass;
    }
    const allocatedStorage =
      cluster.PendingModifiedValues?.AllocatedStorage ?? cluster.AllocatedStorage;
    if (allocatedStorage !== undefined) result['AllocatedStorage'] = allocatedStorage;
    const iops = cluster.PendingModifiedValues?.Iops ?? cluster.Iops;
    if (iops !== undefined) result['Iops'] = iops;
  }
  // go-to-k/cdkd#5639: as for a DB instance.
  const clusterLogs = liveLogExports(
    cluster.EnabledCloudwatchLogsExports,
    cluster.PendingModifiedValues?.PendingCloudwatchLogsExports
  );
  if (clusterLogs.length > 0) result['EnableCloudwatchLogsExports'] = clusterLogs;
  // go-to-k/cdkd#5639: the Describe names, read back under the CFn ones,
  // as CloudFormation's read handler maps them.
  if (cluster.AutoMinorVersionUpgrade !== undefined) {
    result['AutoMinorVersionUpgrade'] = cluster.AutoMinorVersionUpgrade;
  }
  if (cluster.NetworkType !== undefined) result['NetworkType'] = cluster.NetworkType;
  if (cluster.PerformanceInsightsEnabled !== undefined) {
    result['PerformanceInsightsEnabled'] = cluster.PerformanceInsightsEnabled;
  }
  if (cluster.PerformanceInsightsKMSKeyId !== undefined) {
    result['PerformanceInsightsKmsKeyId'] = cluster.PerformanceInsightsKMSKeyId;
  }
  if (cluster.PerformanceInsightsRetentionPeriod !== undefined) {
    result['PerformanceInsightsRetentionPeriod'] = cluster.PerformanceInsightsRetentionPeriod;
  }
  if (cluster.HttpEndpointEnabled !== undefined) {
    result['EnableHttpEndpoint'] = cluster.HttpEndpointEnabled;
  }
  // go-to-k/cdkd#5639: same names on the Describe shape.
  // `MasterUserAuthenticationType` is write-only in the registry schema and
  // absent from DescribeDBClusters, so it is not read back.
  if (cluster.DatabaseInsightsMode !== undefined) {
    result['DatabaseInsightsMode'] = cluster.DatabaseInsightsMode;
  }
  if (cluster.EngineLifecycleSupport !== undefined) {
    result['EngineLifecycleSupport'] = cluster.EngineLifecycleSupport;
  }
  // go-to-k/cdkd#5639. `ClusterScalabilityType` is not read back: the
  // registry schema lists it write-only, and a recorded create-only value
  // the template never declared would read as a removal.
  if (cluster.BacktrackWindow !== undefined) {
    result['BacktrackWindow'] = cluster.BacktrackWindow;
  }
  // `requested` and `enabled` read as on, as CloudFormation's read handler
  // projects the status (`Translator.translateLocalWriteForwardingStatus`).
  if (cluster.LocalWriteForwardingStatus !== undefined) {
    result['EnableLocalWriteForwarding'] =
      cluster.LocalWriteForwardingStatus === 'requested' ||
      cluster.LocalWriteForwardingStatus === 'enabled';
  }
  // go-to-k/cdkd#5639: as for a DB instance.
  result['AssociatedRoles'] = associatedRolesReadback(cluster.AssociatedRoles);
  if (cluster.DBClusterArn) await this.attachTags(result, cluster.DBClusterArn);
  return result;
}

export async function importDBInstance(
  this: RDSProvider,
  input: ResourceImportInput
): Promise<ResourceImportResult | null> {
  const explicit = resolveExplicitPhysicalId(input, 'DBInstanceIdentifier');
  if (explicit) {
    try {
      const resp = await this.getClient().send(
        new DescribeDBInstancesCommand({ DBInstanceIdentifier: explicit })
      );
      // The map `create()` records, from the describe this verification
      // already issues (issue #1852). It is what heals a record written
      // under `--no-wait` while the instance was still `creating`
      // (go-to-k/cdkd#3077): the deploy engine re-reads through `import()`
      // when a `Fn::GetAtt` misses. `definedAttributes` keeps an unassigned
      // endpoint ABSENT, so a still-`creating` instance heals nothing.
      const described = resp.DBInstances?.[0];
      return {
        physicalId: explicit,
        attributes: definedAttributes({
          'Endpoint.Address': described?.Endpoint?.Address,
          'Endpoint.Port': stringifyIfAssigned(described?.Endpoint?.Port),
          Arn: described?.DBInstanceArn,
        }),
      };
    } catch (err) {
      if ((err as { name?: string }).name === 'DBInstanceNotFoundFault') return null;
      throw err;
    }
  }
  // No `aws:cdk:path` tag walk: AWS rejects `aws:`-prefixed tag writes, so
  // that tag never exists on a real resource and the walk could not match
  // (issue #1134). Auto-mode import resolves ids from CloudFormation's
  // `DescribeStackResources` or the template's physical-name property; a
  // DB instance reaching here needs an explicit `--resource` override.
  return null;
}

export async function importDBCluster(
  this: RDSProvider,
  input: ResourceImportInput
): Promise<ResourceImportResult | null> {
  const explicit = resolveExplicitPhysicalId(input, 'DBClusterIdentifier');
  if (explicit) {
    try {
      const resp = await this.getClient().send(
        new DescribeDBClustersCommand({ DBClusterIdentifier: explicit })
      );
      const described = resp.DBClusters?.[0];
      // Issue #3627: the map `create()` records; the resolver's arm builds
      // only the ARN, so the endpoints resolved to the cluster identifier.
      return {
        physicalId: explicit,
        attributes: definedAttributes({
          'Endpoint.Address': described?.Endpoint,
          'Endpoint.Port': stringifyIfAssigned(described?.Port),
          'ReadEndpoint.Address': described?.ReaderEndpoint,
          Arn: described?.DBClusterArn,
          DBClusterResourceId: described?.DbClusterResourceId,
        }),
      };
    } catch (err) {
      if ((err as { name?: string }).name === 'DBClusterNotFoundFault') return null;
      throw err;
    }
  }
  // No `aws:cdk:path` tag walk: AWS rejects `aws:`-prefixed tag writes, so
  // that tag never exists on a real resource and the walk could not match
  // (issue #1134). Auto-mode import resolves ids from CloudFormation's
  // `DescribeStackResources` or the template's physical-name property; a
  // DB cluster reaching here needs an explicit `--resource` override.
  return null;
}
