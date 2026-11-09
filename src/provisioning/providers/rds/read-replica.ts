import {
  DescribeDBInstancesCommand,
  RDSClient,
  type CreateDBInstanceReadReplicaCommandInput,
  type DBInstance,
  type ModifyDBInstanceCommandInput,
  type Tag,
} from '@aws-sdk/client-rds';
import { markNonRetryable } from '../../../deployment/retryable-errors.js';
import { ambientClientDefaults } from '../../../utils/ambient-client-defaults.js';
import { isKnownAwsRegionId } from '../../../utils/ecr-uri.js';
import { ProvisioningError } from '../../../utils/error-handler.js';
import type { RDSProvider } from '../rds-provider.js';

/**
 * go-to-k/cdkd#5640: `SourceDBInstanceIdentifier` on `AWS::RDS::DBInstance`,
 * the read replica, following CloudFormation's RDS handler
 * (`aws-cloudformation-resource-providers-rds`, `aws-rds-dbinstance`):
 *
 * - CREATE: a declared source makes the instance a replica, created with
 *   `CreateDBInstanceReadReplica` (`Translator.createDbInstanceReadReplicaRequest`)
 *   instead of `CreateDBInstance`. The members that call has no room for go
 *   out in one `ModifyDBInstance` once the replica is `available`
 *   (`ResourceModelHelper.shouldUpdateAfterCreate`,
 *   `Translator.modifyDbInstanceAfterCreateRequest`); what neither carries
 *   (`Engine`, `MasterUsername`, `DBName`, `StorageEncrypted`, ...) the
 *   replica inherits from its source, as under CloudFormation.
 * - UPDATE: a removed source promotes the replica (`PromoteReadReplica`); an
 *   added or changed one fails as CloudFormation fails it, "Resource is
 *   immutable" (`ImmutabilityHelper.isSourceDBInstanceIdentifierMutable`).
 * - DELETE: a replica is deleted without a final snapshot whatever its
 *   `DeletionPolicy`, as the delete handler skips it for a replica (RDS
 *   refuses `FinalDBSnapshotIdentifier` on one). A replica on the Cloud
 *   Control route is let through the same way (go-to-k/cdkd#6047,
 *   `ccRoutedInstanceTakesNoSnapshot` in `final-snapshot.ts`, which also
 *   lets through a live cluster member).
 *
 * - `SourceRegion` (go-to-k/cdkd#5640): the handler refuses a region the SDK
 *   does not know ("Unknown source region", `Validations.validateSourceRegion`)
 *   and otherwise only hands it to the Java SDK, which presigns the
 *   cross-region `PreSignedUrl` for that region and keeps `SourceRegion` off
 *   the wire. The JS SDK's RDS middleware presigns the same URL by itself,
 *   from the source ARN's region whenever it differs from the client's, so
 *   nothing is sent for it here: {@link refuseUnknownSourceRegion} is the
 *   whole of its handling. A same-region or bare-identifier source takes no
 *   URL either way (RDS ignores one outside GovCloud and China).
 *
 * `ReplicaMode`, `SourceDBClusterIdentifier` and the point-in-time properties
 * stay SDK-unwired, so a template declaring one keeps its Cloud Control route.
 */

/** The declared source: `undefined` when absent or empty, as the handler's `hasValue`. */
export function replicaSourceOf(
  properties: Record<string, unknown> | undefined
): string | undefined {
  const value = properties?.['SourceDBInstanceIdentifier'];
  if (value == null || value === '') return undefined;
  return typeof value === 'string' ? value : undefined;
}

/**
 * Refuses a declared source that is not a string (an unresolved intrinsic,
 * a list) before any call: it is neither a replica nor a standalone instance.
 */
export function refuseMalformedReplicaSource(
  properties: Record<string, unknown>,
  resourceType: string,
  logicalId: string,
  physicalId?: string
): void {
  const value = properties['SourceDBInstanceIdentifier'];
  if (value == null || value === '' || typeof value === 'string') return;
  throw markNonRetryable(
    new ProvisioningError(
      `${resourceType} ${logicalId}: SourceDBInstanceIdentifier must be a string (the source DB instance's identifier or ARN)`,
      resourceType,
      logicalId,
      physicalId
    )
  );
}

/**
 * The partition-global pseudo regions the Java SDK's `Region.regions()` also
 * lists (one per partition in its partitions data), which no DB instance is in.
 */
const SDK_GLOBAL_PSEUDO_REGIONS: ReadonlySet<string> = new Set([
  'aws-global',
  'aws-cn-global',
  'aws-us-gov-global',
  'aws-iso-global',
  'aws-iso-b-global',
  'aws-iso-e-global',
  'aws-iso-f-global',
]);

/**
 * `SourceRegion`, as the handler validates every request before any call
 * (`BaseHandlerStd.validateRequest`): absent or blank passes; a value that is
 * neither a region id some partition knows nor one of the SDK's global pseudo
 * regions, compared lower-cased as the handler compares it, fails "Unknown
 * source region". A non-string (an unresolved
 * intrinsic) is refused the same way. A state-borne replay (`replaying`) only
 * warns: the value is never sent, so it cannot fail the create there.
 */
export function refuseUnknownSourceRegion(
  properties: Record<string, unknown>,
  resourceType: string,
  logicalId: string,
  replaying: boolean,
  warn: (message: string) => void
): void {
  const value = properties['SourceRegion'];
  // The handler's `StringUtils.isNotBlank`: a blank value skips the check.
  if (value == null || (typeof value === 'string' && value.trim() === '')) return;
  if (typeof value === 'string') {
    const region = value.toLowerCase();
    if (isKnownAwsRegionId(region) || SDK_GLOBAL_PSEUDO_REGIONS.has(region)) return;
  }
  const message =
    typeof value === 'string'
      ? `${resourceType} ${logicalId}: Unknown source region (SourceRegion must name an AWS region, as CloudFormation requires)`
      : `${resourceType} ${logicalId}: SourceRegion must be a string (the source DB instance's region)`;
  if (replaying) {
    warn(`${message}; replaying a recorded state, so it is ignored (it is never sent to RDS)`);
    return;
  }
  throw markNonRetryable(new ProvisioningError(message, resourceType, logicalId));
}

/** The region of an RDS ARN, `undefined` for a bare identifier. */
export function replicaSourceRegion(source: string): string | undefined {
  if (!source.startsWith('arn:')) return undefined;
  const region = source.split(':')[3];
  return region === undefined || region === '' ? undefined : region;
}

/** The source's DB identifier: an ARN's last segment, or the value itself. */
export function replicaSourceName(source: string): string {
  return source.startsWith('arn:') ? (source.split(':').pop() ?? source) : source;
}

/** The region and account an RDS ARN names; both `undefined` for a bare identifier. */
function replicaSourceScope(source: string): { region?: string; account?: string } {
  if (!source.startsWith('arn:')) return {};
  const [, , , region, account] = source.split(':');
  return {
    ...(region !== undefined && region !== '' && { region }),
    ...(account !== undefined && account !== '' && { account }),
  };
}

/** The region and account an instance's own ARN names (`DBInstanceArn`). */
export function ownScopeOf(instanceArn: string | undefined): { region?: string; account?: string } {
  return instanceArn === undefined ? {} : replicaSourceScope(instanceArn);
}

/**
 * Whether two spellings name the same source DB instance. A bare identifier
 * names an instance in the replica's OWN region and account (`own`), as RDS
 * reads it; an ARN names its own. The identifiers compare case-insensitively
 * (RDS stores them lower-cased), the region always, the account where both
 * sides know it. A region neither side can name fails closed (not the same),
 * so the caller refuses or reports drift. A same-named instance in another
 * region or account is ANOTHER source, which CloudFormation refuses as an
 * immutable change.
 */
export function sameReplicaSource(
  a: string,
  b: string,
  own: { region?: string; account?: string }
): boolean {
  if (replicaSourceName(a).toLowerCase() !== replicaSourceName(b).toLowerCase()) return false;
  const sa = replicaSourceScope(a);
  const sb = replicaSourceScope(b);
  if (sa.region === undefined && sb.region === undefined) return true;
  const ra = sa.region ?? own.region;
  const rb = sb.region ?? own.region;
  if (ra === undefined || rb === undefined || ra !== rb) return false;
  const aa = sa.account ?? own.account;
  const ab = sb.account ?? own.account;
  return aa === undefined || ab === undefined || aa === ab;
}

/** The handler's `isSqlServer`: an unknown engine counts as SQL Server. */
function isSqlServer(engine: string | undefined): boolean {
  return engine === undefined || engine.includes('sqlserver');
}

function isOracleCdbEngine(engine: string | undefined): boolean {
  return engine === 'oracle-ee-cdb' || engine === 'oracle-se2-cdb';
}

const isTrue = (value: unknown): boolean => String(value) === 'true';
const positive = (value: unknown): boolean => value != null && Number(value) > 0;
const declared = (value: unknown): boolean => value != null && value !== '';

/** The handler's `isStorageParametersModified`. */
function storageDeclared(properties: Record<string, unknown>): boolean {
  return (
    declared(properties['AllocatedStorage']) ||
    positive(properties['Iops']) ||
    positive(properties['MaxAllocatedStorage']) ||
    positive(properties['StorageThroughput']) ||
    declared(properties['StorageType'])
  );
}

/**
 * The source instance, read by the value as declared from its own region: an
 * ARN keeps its account, so a same-named instance of the caller's account is
 * never read in its place (RDS answers another account's ARN as not found or
 * denied). `undefined` when DescribeDBInstances lists none.
 */
export async function describeReplicaSource(
  this: RDSProvider,
  source: string
): Promise<DBInstance | undefined> {
  const sourceRegion = replicaSourceRegion(source);
  const ownRegion = await this.getClient().config.region();
  if (sourceRegion === undefined || sourceRegion === ownRegion) {
    return this.describeDBInstance(source);
  }
  return describeDBInstanceInRegion(source, sourceRegion);
}

/**
 * One `DescribeDBInstances` from a client built for `region` and destroyed
 * after the call. `undefined` when it lists none; an AWS failure (a
 * `DBInstanceNotFoundFault` among them) propagates.
 */
export async function describeDBInstanceInRegion(
  identifier: string,
  region: string
): Promise<DBInstance | undefined> {
  const client = new RDSClient({ ...ambientClientDefaults(), region });
  try {
    const response = await client.send(
      new DescribeDBInstancesCommand({ DBInstanceIdentifier: identifier })
    );
    return response.DBInstances?.[0];
  } finally {
    client.destroy();
  }
}

/**
 * The replica's engine: the declared one, else the source's, which the
 * handler reads before the create (`CreateHandler.fetchEngine`) from the
 * source's own region. It decides which storage members the create carries.
 */
export async function replicaEngine(
  this: RDSProvider,
  properties: Record<string, unknown>,
  source: string
): Promise<string | undefined> {
  const declaredEngine = properties['Engine'];
  if (typeof declaredEngine === 'string' && declaredEngine !== '') return declaredEngine;
  const instance = await describeReplicaSource.call(this, source);
  // As the handler's `fetchEngine` fails the create before it starts.
  if (instance === undefined) {
    throw new Error(
      `DescribeDBInstances reported no source DB instance ${source} for the read replica`
    );
  }
  return instance.Engine;
}

/** What {@link replicaCreateInput} needs beyond the declared bag. */
export interface ReplicaCreateParts {
  readonly identifier: string;
  readonly source: string;
  readonly engine: string | undefined;
  readonly currentRegion: string | undefined;
  readonly tags: Tag[];
  readonly logExports: string[] | undefined;
}

/**
 * `CreateDBInstanceReadReplica`, as `Translator.createDbInstanceReadReplicaRequest`
 * builds it from the declared members (an undeclared one is left out). The
 * storage members go out unless the engine is SQL Server (they then ride the
 * after-create ModifyDBInstance), and `DBParameterGroupName` only for a
 * cross-region MySQL replica.
 */
export function replicaCreateInput(
  properties: Record<string, unknown>,
  parts: ReplicaCreateParts
): CreateDBInstanceReadReplicaCommandInput {
  const p = properties;
  const sourceRegion = replicaSourceRegion(parts.source);
  const crossRegion = sourceRegion !== undefined && sourceRegion !== parts.currentRegion;
  const vpcSecurityGroups = p['VPCSecurityGroups'];
  return {
    DBInstanceIdentifier: parts.identifier,
    SourceDBInstanceIdentifier: parts.source,
    ...(p['AutoMinorVersionUpgrade'] != null && {
      AutoMinorVersionUpgrade: p['AutoMinorVersionUpgrade'] as boolean,
    }),
    ...(p['AvailabilityZone'] != null && { AvailabilityZone: p['AvailabilityZone'] as string }),
    ...(p['CopyTagsToSnapshot'] != null && {
      CopyTagsToSnapshot: p['CopyTagsToSnapshot'] as boolean,
    }),
    ...(p['DatabaseInsightsMode'] != null && {
      DatabaseInsightsMode: p[
        'DatabaseInsightsMode'
      ] as CreateDBInstanceReadReplicaCommandInput['DatabaseInsightsMode'],
    }),
    ...(p['DBInstanceClass'] != null && { DBInstanceClass: p['DBInstanceClass'] as string }),
    ...(p['DBSubnetGroupName'] != null && {
      DBSubnetGroupName: p['DBSubnetGroupName'] as string,
    }),
    ...(p['DeletionProtection'] != null && {
      DeletionProtection: p['DeletionProtection'] as boolean,
    }),
    ...(p['DedicatedLogVolume'] != null && {
      DedicatedLogVolume: p['DedicatedLogVolume'] as boolean,
    }),
    ...(parts.logExports !== undefined &&
      parts.logExports.length > 0 && { EnableCloudwatchLogsExports: parts.logExports }),
    ...(p['EnableIAMDatabaseAuthentication'] != null && {
      EnableIAMDatabaseAuthentication: p['EnableIAMDatabaseAuthentication'] as boolean,
    }),
    ...(p['EnablePerformanceInsights'] != null && {
      EnablePerformanceInsights: p['EnablePerformanceInsights'] as boolean,
    }),
    ...(p['KmsKeyId'] != null && { KmsKeyId: p['KmsKeyId'] as string }),
    ...(p['MonitoringInterval'] != null && {
      MonitoringInterval: Number(p['MonitoringInterval']),
    }),
    ...(p['MonitoringRoleArn'] != null && { MonitoringRoleArn: p['MonitoringRoleArn'] as string }),
    ...(p['MultiAZ'] != null && { MultiAZ: p['MultiAZ'] as boolean }),
    ...(p['NetworkType'] != null && { NetworkType: p['NetworkType'] as string }),
    ...(p['OptionGroupName'] != null && { OptionGroupName: p['OptionGroupName'] as string }),
    ...(p['PerformanceInsightsKMSKeyId'] != null && {
      PerformanceInsightsKMSKeyId: p['PerformanceInsightsKMSKeyId'] as string,
    }),
    ...(p['PerformanceInsightsRetentionPeriod'] != null && {
      PerformanceInsightsRetentionPeriod: Number(p['PerformanceInsightsRetentionPeriod']),
    }),
    ...(p['Port'] != null && { Port: Number(p['Port']) }),
    ...(p['PubliclyAccessible'] != null && {
      PubliclyAccessible: p['PubliclyAccessible'] as boolean,
    }),
    ...(Array.isArray(vpcSecurityGroups) &&
      vpcSecurityGroups.length > 0 && { VpcSecurityGroupIds: vpcSecurityGroups as string[] }),
    ...(!isSqlServer(parts.engine) && {
      ...(p['AllocatedStorage'] != null && { AllocatedStorage: Number(p['AllocatedStorage']) }),
      ...(p['Iops'] != null && { Iops: Number(p['Iops']) }),
      ...(p['StorageThroughput'] != null && { StorageThroughput: Number(p['StorageThroughput']) }),
      ...(p['StorageType'] != null && { StorageType: p['StorageType'] as string }),
    }),
    ...(crossRegion &&
      parts.engine?.toLowerCase().startsWith('mysql') === true &&
      p['DBParameterGroupName'] != null && {
        DBParameterGroupName: p['DBParameterGroupName'] as string,
      }),
    ...(parts.tags.length > 0 && { Tags: parts.tags }),
  };
}

/**
 * The handler's `shouldUpdateAfterCreate` for a replica: whether a member the
 * create could not carry is declared. `liveEngine` is the created replica's,
 * against which a declared Oracle CDB engine is a conversion.
 */
export function replicaNeedsModifyAfterCreate(
  properties: Record<string, unknown>,
  engine: string | undefined,
  liveEngine: string | undefined
): boolean {
  const p = properties;
  return (
    declared(p['CACertificateIdentifier']) ||
    declared(p['DBParameterGroupName']) ||
    declared(p['EngineVersion']) ||
    declared(p['MasterUserPassword']) ||
    declared(p['PreferredBackupWindow']) ||
    declared(p['PreferredMaintenanceWindow']) ||
    declared(p['MonitoringRoleArn']) ||
    positive(p['BackupRetentionPeriod']) ||
    positive(p['MonitoringInterval']) ||
    (isSqlServer(engine) && storageDeclared(p)) ||
    isTrue(p['ManageMasterUserPassword']) ||
    isTrue(p['DeletionProtection']) ||
    isTrue(p['EnablePerformanceInsights']) ||
    isOracleCdbConversion(liveEngine, p['Engine'])
  );
}

/** `ImmutabilityHelper.isOracleConvertToCDB`. */
function isOracleCdbConversion(liveEngine: string | undefined, desired: unknown): boolean {
  if (liveEngine === undefined || typeof desired !== 'string') return false;
  const live = liveEngine.toLowerCase();
  const next = desired.toLowerCase();
  return (
    (live === 'oracle-ee' && next === 'oracle-ee-cdb') ||
    (live === 'oracle-se2' && next === 'oracle-se2-cdb')
  );
}

/**
 * The after-create `ModifyDBInstance`, as `Translator.modifyDbInstanceAfterCreateRequest`
 * builds it: every declared member below, applied at once. The storage
 * members ride it on SQL Server only (the create carried them otherwise).
 */
export function replicaModifyAfterCreateInput(
  properties: Record<string, unknown>,
  identifier: string,
  engine: string | undefined
): ModifyDBInstanceCommandInput {
  const p = properties;
  const masterUserSecret = p['MasterUserSecret'] as { KmsKeyId?: string } | undefined;
  return {
    DBInstanceIdentifier: identifier,
    ApplyImmediately: true,
    ...(p['AllowMajorVersionUpgrade'] != null && {
      AllowMajorVersionUpgrade: p['AllowMajorVersionUpgrade'] as boolean,
    }),
    ...(p['BackupRetentionPeriod'] != null && {
      BackupRetentionPeriod: Number(p['BackupRetentionPeriod']),
    }),
    ...(p['CACertificateIdentifier'] != null && {
      CACertificateIdentifier: p['CACertificateIdentifier'] as string,
    }),
    ...(p['DatabaseInsightsMode'] != null && {
      DatabaseInsightsMode: p[
        'DatabaseInsightsMode'
      ] as ModifyDBInstanceCommandInput['DatabaseInsightsMode'],
    }),
    ...(p['DBParameterGroupName'] != null && {
      DBParameterGroupName: p['DBParameterGroupName'] as string,
    }),
    ...(p['DeletionProtection'] != null && {
      DeletionProtection: p['DeletionProtection'] as boolean,
    }),
    ...(p['EnablePerformanceInsights'] != null && {
      EnablePerformanceInsights: p['EnablePerformanceInsights'] as boolean,
    }),
    ...(p['EngineVersion'] != null && {
      EngineVersion: String(p['EngineVersion'] as string | number),
    }),
    ...(p['ManageMasterUserPassword'] != null && {
      ManageMasterUserPassword: p['ManageMasterUserPassword'] as boolean,
    }),
    ...(p['MasterUserPassword'] != null && {
      MasterUserPassword: p['MasterUserPassword'] as string,
    }),
    ...(masterUserSecret?.KmsKeyId != null && {
      MasterUserSecretKmsKeyId: masterUserSecret.KmsKeyId,
    }),
    ...(p['MaxAllocatedStorage'] != null && {
      MaxAllocatedStorage: Number(p['MaxAllocatedStorage']),
    }),
    ...(p['MonitoringInterval'] != null && {
      MonitoringInterval: Number(p['MonitoringInterval']),
    }),
    ...(p['MonitoringRoleArn'] != null && { MonitoringRoleArn: p['MonitoringRoleArn'] as string }),
    ...(p['PerformanceInsightsRetentionPeriod'] != null && {
      PerformanceInsightsRetentionPeriod: Number(p['PerformanceInsightsRetentionPeriod']),
    }),
    ...(p['PerformanceInsightsKMSKeyId'] != null && {
      PerformanceInsightsKMSKeyId: p['PerformanceInsightsKMSKeyId'] as string,
    }),
    ...(p['PreferredBackupWindow'] != null && {
      PreferredBackupWindow: p['PreferredBackupWindow'] as string,
    }),
    ...(p['PreferredMaintenanceWindow'] != null && {
      PreferredMaintenanceWindow: p['PreferredMaintenanceWindow'] as string,
    }),
    ...(isSqlServer(engine) &&
      storageDeclared(p) && {
        ...(p['AllocatedStorage'] != null && { AllocatedStorage: Number(p['AllocatedStorage']) }),
        ...(p['Iops'] != null && { Iops: Number(p['Iops']) }),
        ...(p['StorageThroughput'] != null && {
          StorageThroughput: Number(p['StorageThroughput']),
        }),
        ...(p['StorageType'] != null && { StorageType: p['StorageType'] as string }),
      }),
    // The handler's model engine, the declared one or the source's.
    ...(engine !== undefined && isOracleCdbEngine(engine) && { Engine: engine }),
  };
}

/**
 * What an update does with the source:
 *
 * - `'unchanged'`: the two sides spell the same source, or neither names one.
 * - `'promote'`: the template removed it; the handler promotes the replica
 *   (`ResourceModelHelper.isDBInstanceReadReplicaPromotion`).
 * - `'immutable'`: added or changed as written, which the handler fails as
 *   "Resource is immutable". `updateDBInstance` still reads the live instance:
 *   one already replicating the declared source ({@link sameReplicaSource}) is
 *   no change (a record lacking it, the same source re-spelled, a
 *   `drift --revert` readback).
 */
export function replicaSourceChange(
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>
): 'unchanged' | 'promote' | 'immutable' {
  const desired = replicaSourceOf(properties);
  const previous = replicaSourceOf(previousProperties);
  if (desired === previous) return 'unchanged';
  return desired === undefined ? 'promote' : 'immutable';
}

/**
 * The desired bag with the source the instance KEPT: the previous side's, or
 * no key when that side declared none. A copy.
 */
export function withPreviousReplicaSource(
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>
): Record<string, unknown> {
  const { SourceDBInstanceIdentifier: _desired, ...rest } = properties;
  const previous = previousProperties['SourceDBInstanceIdentifier'];
  return previous === undefined ? rest : { ...rest, SourceDBInstanceIdentifier: previous };
}

/** Whether a described instance is a read replica (of an instance or a cluster). */
export function isLiveReadReplica(instance: DBInstance | undefined): boolean {
  return (
    (instance?.ReadReplicaSourceDBInstanceIdentifier ?? '') !== '' ||
    (instance?.ReadReplicaSourceDBClusterIdentifier ?? '') !== ''
  );
}
