import { RDSClient, type DBCluster, type DBInstance } from '@aws-sdk/client-rds';
import { EC2Client } from '@aws-sdk/client-ec2';
import { type ConsoleLogger, getLogger } from '../../utils/logger.js';
import { ProvisioningError } from '../../utils/error-handler.js';
import { type DeleteProgress } from '../delete-started.js';
import { type DeleteContext } from '../region-check.js';
import type {
  ResourceProvider,
  CreateContext,
  ResourceCreateResult,
  ResourceUpdateResult,
  ResourceImportInput,
  ResourceImportResult,
  ResourceIdentityVerdict,
  ResourceNotFound,
  UpdateContext,
} from '../../types/resource.js';
import { ambientClientDefaults } from '../../utils/ambient-client-defaults.js';
import { ambientRegion } from '../../utils/stack-aws-scope.js';
import {
  ProtectionFlipRegistry,
  type ProtectionFlipRecord,
} from './deletion-protection-compensation.js';
import { withoutServerErrorRetries } from './ambiguous-create.js';
import { type AssociatedRole } from './db-associated-roles.js';
import { GlobalClusterDetachError } from './rds/shared.js';
import { create, update, deleteImpl, importImpl } from './rds/dispatch.js';
import {
  createDBSubnetGroup,
  updateDBSubnetGroup,
  deleteDBSubnetGroup,
  readCurrentStateDBSubnetGroup,
  importDBSubnetGroup,
} from './rds/subnet-group.js';
import { createDBCluster } from './rds/cluster-create.js';
import { updateDBCluster } from './rds/cluster-update.js';
import {
  deleteDBCluster,
  deleteDBClusterOnce,
  partialClusterRetiring,
  wrapGlobalClusterDetachError,
  detachFromGlobalCluster,
  deleteAfterProtectionFlip,
} from './rds/cluster-delete.js';
import { createDBInstance } from './rds/instance-create.js';
import { updateDBInstance } from './rds/instance-update.js';
import {
  deleteDBInstance,
  deleteDBInstanceOnce,
  deleteInstanceAfterProtectionFlip,
} from './rds/instance-delete.js';
import {
  applyTagDiff,
  isNotFoundError,
  wrapCaughtError,
  wrapDeleteError,
  engineLifecycleSupportToSend,
  describeDBCluster,
  securityGroupsToSend,
  describeDBInstance,
  sendHttpEndpointChange,
  attachTags,
} from './rds/calls.js';
import {
  waitForMemberAfterClusterChange,
  requireClusterWhileWaiting,
  waitForClusterPortApplied,
  waitForSecurityGroupsApplied,
  waitForClusterState,
  waitForClusterAvailable,
  waitForClusterDeleted,
  rebootForPendingParameterGroup,
  waitForInstanceState,
  waitForInstanceAvailable,
  waitForInstanceDeleted,
} from './rds/waits.js';
import { desiredAssociatedRoles, applyAssociatedRoles } from './rds/associated-roles.js';
import {
  getDriftUnorderedPaths,
  getDriftUnknownPaths,
  canonicalizeDriftProperties,
  canonicalizeUnsettledProperties,
} from './rds/drift.js';
import {
  readUnsettled,
  readCurrentState,
  isSameResource,
  resourceIdentity,
  readDbResourceIdIfExists,
  readCurrentStateDBInstance,
  readCurrentStateDBCluster,
  importDBInstance,
  importDBCluster,
} from './rds/read-state.js';

/**
 * AWS RDS Provider
 *
 * Implements resource provisioning for RDS resources:
 * - AWS::RDS::DBSubnetGroup
 * - AWS::RDS::DBCluster
 * - AWS::RDS::DBInstance
 *
 * WHY: RDS SDK calls are direct and avoid CC API polling overhead.
 * However, DBCluster and DBInstance creation can take time, so we
 * poll with DescribeDB* until available.
 */
export class RDSProvider implements ResourceProvider {
  private rdsClient?: RDSClient;

  private createClient?: RDSClient;

  private ec2Client?: EC2Client;

  private readonly providerRegion: string | undefined;

  logger: ConsoleLogger = getLogger().child('RDSProvider');

  /**
   * What a `--remove-protection` flip did, per resource, across the outer
   * retry loop's re-entries (issue #2204; the mechanism is
   * `./deletion-protection-compensation.ts`).
   */
  readonly protectionFlips = new ProtectionFlipRegistry();

  /**
   * Issue #1160: the CFn default a property REMOVED from the template is
   * reset to — the Modify/Update API keeps an absent field's live value.
   *
   * Empty for RDS: real CloudFormation A/Bs (issue #5004, #1160 comment
   * 6401151077) showed CFn KEEPS most removed DBCluster / DBInstance values,
   * so cdkd sends nothing for them (omission is "unchanged" on
   * ModifyDBCluster / ModifyDBInstance). The resets it does make are coerced,
   * engine-dependent or conditional, so they stay in `updateDBCluster` /
   * `updateDBInstance`.
   */
  removalDefaults = new Map<string, ReadonlyMap<string, unknown>>();

  handledProperties = new Map<string, ReadonlySet<string>>([
    [
      'AWS::RDS::DBSubnetGroup',
      new Set(['DBSubnetGroupName', 'DBSubnetGroupDescription', 'SubnetIds', 'Tags']),
    ],
    [
      'AWS::RDS::DBCluster',
      new Set([
        'DBClusterIdentifier',
        'Engine',
        'EngineVersion',
        'MasterUsername',
        'MasterUserPassword',
        'DatabaseName',
        'Port',
        'VpcSecurityGroupIds',
        'DBSubnetGroupName',
        'StorageEncrypted',
        'KmsKeyId',
        'BackupRetentionPeriod',
        'DeletionProtection',
        'ServerlessV2ScalingConfiguration',
        'Tags',
        // #609 security-cluster backfill (managed master-password secret +
        // Enhanced Monitoring + IAM database auth + publicly-accessible).
        // 5 of the 6 ride CreateDBCluster AND ModifyDBCluster (mutable). Wire-
        // format flips: CFn `MasterUserSecret` (an object whose only create-
        // relevant member is `{ KmsKeyId }`) → SDK scalar
        // `MasterUserSecretKmsKeyId` (the create/modify shapes take the key id
        // directly — the SDK `MasterUserSecret` *type* is the read-side Describe
        // shape). `MonitoringInterval` arrives as a numeric STRING ("60"); coerce
        // via Number() at the wire boundary. `ManageMasterUserPassword` is
        // mutually exclusive with `MasterUserPassword` (AWS validates).
        // `PubliclyAccessible` IS a valid CreateDBClusterMessage field (Multi-AZ
        // DB clusters) but is ABSENT from ModifyDBClusterMessage — wired create-
        // only here (a template change replaces the cluster), distinct from
        // DBInstance's same-named mutable prop.
        'ManageMasterUserPassword',
        'MasterUserSecret',
        'MonitoringRoleArn',
        'MonitoringInterval',
        'EnableIAMDatabaseAuthentication',
        'PubliclyAccessible',
        // go-to-k/cdkd#2762: the parameter group, backup and maintenance
        // windows, snapshot tag copying and storage type. Each rides
        // CreateDBCluster and, when changed, ModifyDBCluster under the same
        // name (`clusterModifyBackfillMembers`).
        'DBClusterParameterGroupName',
        'PreferredBackupWindow',
        'PreferredMaintenanceWindow',
        'CopyTagsToSnapshot',
        'StorageType',
        // go-to-k/cdkd#5639: the list on CreateDBCluster, the
        // `CloudwatchLogsExportConfiguration` delta on ModifyDBCluster
        // (`logExportsDelta`).
        'EnableCloudwatchLogsExports',
        // go-to-k/cdkd#5639: ride CreateDBCluster and, when changed,
        // ModifyDBCluster (`clusterModifyScalarMembers`; the Performance
        // Insights trio is renamed on the wire). `EnableHttpEndpoint` rides
        // CreateDBCluster, and an update turns the Data API on or off with
        // EnableHttpEndpoint / DisableHttpEndpoint (`clusterHttpEndpointAction`).
        'AutoMinorVersionUpgrade',
        'NetworkType',
        'PerformanceInsightsEnabled',
        'PerformanceInsightsKmsKeyId',
        'PerformanceInsightsRetentionPeriod',
        'EnableHttpEndpoint',
        // go-to-k/cdkd#5639: ride CreateDBCluster and, when changed,
        // ModifyDBCluster under the same names (`clusterModifyScalarMembers`).
        'DatabaseInsightsMode',
        'EngineLifecycleSupport',
        'MasterUserAuthenticationType',
        // go-to-k/cdkd#5639: `BacktrackWindow` and `EnableLocalWriteForwarding`
        // ride CreateDBCluster and, when changed, ModifyDBCluster
        // (`clusterModifyScalarMembers`; a removed `EnableLocalWriteForwarding:
        // true` turns forwarding off). `ClusterScalabilityType` is create-only
        // and rides CreateDBCluster alone.
        'BacktrackWindow',
        'EnableLocalWriteForwarding',
        'ClusterScalabilityType',
        // go-to-k/cdkd#5639: AddRoleToDBCluster / RemoveRoleFromDBCluster once
        // the cluster is `available`, planned against the live list
        // (`applyAssociatedRoles`).
        'AssociatedRoles',
        // go-to-k/cdkd#5639: CreateDBCluster alone. `EngineMode` is create-only
        // (a change replaces the cluster). `AvailabilityZones` is schema-mutable,
        // but ModifyDBCluster has no member for it and CloudFormation's update
        // handler sends none (`Translator.modifyDbClusterRequest`), so a change
        // or removal completes in place keeping the live zones. Neither is read
        // back: no API changes them after the create, and RDS reports an
        // `EngineMode` on every cluster, which a record that never declared one
        // would read as a create-only removal.
        'EngineMode',
        'AvailabilityZones',
      ]),
    ],
    [
      'AWS::RDS::DBInstance',
      new Set([
        'DBInstanceIdentifier',
        'DBInstanceClass',
        'Engine',
        'DBClusterIdentifier',
        'DBSubnetGroupName',
        'PubliclyAccessible',
        'Tags',
        // #609 backfill — 8 sibling props already handled on DBCluster.
        // 6 mutable (DeletionProtection / EngineVersion / Port / MasterUserPassword /
        // VPCSecurityGroups / AllocatedStorage ride both CreateDBInstance + ModifyDBInstance) +
        // 2 create-only (StorageEncrypted is set at instance creation and immutable
        // post-create per AWS RDS docs — absent from ModifyDBInstanceMessage;
        // MasterUsername is also immutable post-create — AWS rejects changes via
        // ModifyDBInstance). Two wire-format name flips: CFn `Port` → SDK `DBPortNumber`
        // (different field name entirely on the DB instance), CFn `VPCSecurityGroups`
        // → SDK `VpcSecurityGroupIds` (casing + suffix). `MasterUsername` +
        // `AllocatedStorage` are AWS-required for standalone (non-cluster) DBInstance
        // create — wired here so a standalone instance can SDK-route end-to-end.
        'AllocatedStorage',
        'DeletionProtection',
        'EngineVersion',
        'MasterUsername',
        'MasterUserPassword',
        'Port',
        'StorageEncrypted',
        'VPCSecurityGroups',
        // #609 security-cluster backfill (sibling of the DBCluster set).
        // `KmsKeyId` is the storage-encryption key (pairs with the already-
        // handled StorageEncrypted) — create-only + immutable, so it is NOT
        // forwarded on update. The other 5 mirror DBCluster: `MasterUserSecret`
        // → SDK `MasterUserSecretKmsKeyId`, `ManageMasterUserPassword` (bool),
        // `MonitoringRoleArn` / `MonitoringInterval` (Number-coerced),
        // `EnableIAMDatabaseAuthentication` (bool) — all ride CreateDBInstance
        // AND ModifyDBInstance (mutable).
        'KmsKeyId',
        'MasterUserSecret',
        'ManageMasterUserPassword',
        'MonitoringRoleArn',
        'MonitoringInterval',
        'EnableIAMDatabaseAuthentication',
        // go-to-k/cdkd#2762: storage, backup, maintenance, option group,
        // certificate and Performance Insights settings. Each rides
        // CreateDBInstance and, when changed, ModifyDBInstance under the same
        // name (`instanceModifyBackfillMembers`).
        'BackupRetentionPeriod',
        'PreferredBackupWindow',
        'PreferredMaintenanceWindow',
        'StorageType',
        'MultiAZ',
        'MaxAllocatedStorage',
        'AutoMinorVersionUpgrade',
        'CopyTagsToSnapshot',
        'EnablePerformanceInsights',
        'PerformanceInsightsKMSKeyId',
        'PerformanceInsightsRetentionPeriod',
        'Iops',
        'StorageThroughput',
        'OptionGroupName',
        'CACertificateIdentifier',
        // go-to-k/cdkd#2762: network type, license model, promotion tier,
        // Database Insights mode and dedicated log volume ride
        // CreateDBInstance and, when changed, ModifyDBInstance under the same
        // name. `AllowMajorVersionUpgrade` and `CertificateRotationRestart`
        // are ModifyDBInstance-only flags RDS never reads back
        // (`instanceModifyBackfillMembers`).
        'NetworkType',
        'LicenseModel',
        'PromotionTier',
        'DatabaseInsightsMode',
        'DedicatedLogVolume',
        'AllowMajorVersionUpgrade',
        'CertificateRotationRestart',
        // go-to-k/cdkd#2762: rides CreateDBInstance and, when changed,
        // ModifyDBInstance; an update leaving it `pending-reboot` reboots the
        // instance, as CloudFormation does (`rebootForPendingParameterGroup`).
        'DBParameterGroupName',
        // go-to-k/cdkd#5640: the list on CreateDBInstance, the
        // `CloudwatchLogsExportConfiguration` delta on ModifyDBInstance
        // (`logExportsDelta`).
        'EnableCloudwatchLogsExports',
        // go-to-k/cdkd#5640: both ride CreateDBInstance only. `DBName` is
        // create-only (a change replaces). `AvailabilityZone` is not, but
        // ModifyDBInstance cannot move an instance, so a changed zone is
        // refused as CloudFormation refuses it (`instanceAvailabilityZoneKept`).
        'DBName',
        'AvailabilityZone',
        // go-to-k/cdkd#5640: ride CreateDBInstance and, when changed,
        // ModifyDBInstance under the same names (`instanceModifyBackfillMembers`).
        'EngineLifecycleSupport',
        'MasterUserAuthenticationType',
        // go-to-k/cdkd#5640: AddRoleToDBInstance / RemoveRoleFromDBInstance
        // once the instance is `available` (`applyAssociatedRoles`).
        'AssociatedRoles',
      ]),
    ],
  ]);

  unhandledByDesign = new Map<string, ReadonlyMap<string, string>>([
    [
      'AWS::RDS::DBCluster',
      new Map<string, string>([
        [
          'DeleteAutomatedBackups',
          'delete-time flag, sent on the delete when the record carries it; kept unhandled so a template declaring it keeps its Cloud Control route. Final snapshots are governed by DeletionPolicy: Snapshot, which this flag does not control',
        ],
        [
          'ScalingConfiguration',
          'Aurora Serverless v1 only (EngineMode serverless), retired by AWS: no aurora-mysql or aurora-postgresql engine version supports the serverless engine mode (DescribeDBEngineVersions, us-east-1, 2026-11-06). Aurora Serverless v2 uses ServerlessV2ScalingConfiguration',
        ],
      ]),
    ],
    [
      'AWS::RDS::DBInstance',
      new Map<string, string>([
        [
          'DBSecurityGroups',
          'EC2-Classic-only feature retired by AWS (2022-08-15); new accounts cannot use this — use VPCSecurityGroups instead',
        ],
        [
          'ApplyImmediately',
          'cdkd always applies modifications immediately (rds:ModifyDBInstance.ApplyImmediately=true is hardcoded); users wanting maintenance-window deferral should run aws rds modify-db-instance directly',
        ],
        [
          'DeleteAutomatedBackups',
          'delete-time flag, sent on the delete when the record carries it; kept unhandled so a template declaring it keeps its Cloud Control route. Final snapshots are governed by DeletionPolicy: Snapshot, which this flag does not control',
        ],
      ]),
    ],
  ]);

  /**
   * `region` pins the client instead of the ambient region: the Cloud Control
   * delete delegation (issue #3993) passes its OWN client's region, which is
   * the one its recorded-region pre-flight vetted.
   */
  constructor(options?: { region?: string }) {
    this.providerRegion = options?.region ?? ambientRegion();
  }

  getClient(): RDSClient {
    if (!this.rdsClient) {
      // Built together with the create client, so both capture the identity
      // active at this ONE call (issue #4639).
      this.rdsClient = new RDSClient({
        ...ambientClientDefaults(),
        ...(this.providerRegion ? { region: this.providerRegion } : {}),
      });
      this.createClient = withoutServerErrorRetries(
        new RDSClient({
          ...ambientClientDefaults(),
          ...(this.providerRegion ? { region: this.providerRegion } : {}),
        })
      );
    }
    return this.rdsClient;
  }

  /** Only a removed DBCluster `VpcSecurityGroupIds` reaches EC2 (issue #1160). */
  getEc2Client(): EC2Client {
    if (!this.ec2Client) {
      this.ec2Client = new EC2Client({
        ...ambientClientDefaults(),
        ...(this.providerRegion ? { region: this.providerRegion } : {}),
      });
    }
    return this.ec2Client;
  }

  /**
   * The client `CreateDBSubnetGroup` / `CreateDBCluster` / `CreateDBInstance`
   * go through: SDK retries on, except a 5xx (`withoutServerErrorRetries`,
   * issue #4639). Separate so every other call keeps the full SDK retry.
   *
   * None of the three carries an idempotency token, and each name is unique
   * per account and region, so the SDK's own replay of a 5xx whose request
   * had succeeded collides with what the first send made, and that "already
   * exists" surfaced from the engine's FIRST attempt as a name somebody else
   * holds. Refused here, the 5xx reaches the deploy engine's retry, which
   * marks the create as possibly replayed (`withRetry`, #3978). Nothing is
   * adopted on that collision: a name is not attribution
   * (`docs/provider-rules.md`, "Adopt only on EXACT attribution").
   */
  getCreateClient(): RDSClient {
    this.getClient();
    return this.createClient as RDSClient;
  }

  create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    context?: CreateContext
  ): Promise<ResourceCreateResult> {
    return create.call(this, logicalId, resourceType, properties, context);
  }
  update(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>,
    context?: UpdateContext
  ): Promise<ResourceUpdateResult> {
    return update.call(
      this,
      logicalId,
      physicalId,
      resourceType,
      properties,
      previousProperties,
      context
    );
  }
  delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void> {
    return deleteImpl.call(this, logicalId, physicalId, resourceType, properties, context);
  }
  createDBSubnetGroup(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    mask: ((text: string) => string) | undefined
  ): Promise<ResourceCreateResult> {
    return createDBSubnetGroup.call(this, logicalId, resourceType, properties, mask);
  }
  updateDBSubnetGroup(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>,
    mask: ((text: string) => string) | undefined
  ): Promise<ResourceUpdateResult> {
    return updateDBSubnetGroup.call(
      this,
      logicalId,
      physicalId,
      resourceType,
      properties,
      previousProperties,
      mask
    );
  }
  deleteDBSubnetGroup(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    context?: DeleteContext
  ): Promise<void> {
    return deleteDBSubnetGroup.call(this, logicalId, physicalId, resourceType, context);
  }
  createDBCluster(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    mask: ((text: string) => string) | undefined,
    replaying = false
  ): Promise<ResourceCreateResult> {
    return createDBCluster.call(this, logicalId, resourceType, properties, mask, replaying);
  }
  updateDBCluster(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>,
    context?: UpdateContext
  ): Promise<ResourceUpdateResult> {
    return updateDBCluster.call(
      this,
      logicalId,
      physicalId,
      resourceType,
      properties,
      previousProperties,
      context
    );
  }
  deleteDBCluster(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown> | undefined,
    context?: DeleteContext
  ): Promise<void> {
    return deleteDBCluster.call(this, logicalId, physicalId, resourceType, properties, context);
  }
  deleteDBClusterOnce(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown> | undefined,
    context: DeleteContext | undefined,
    flip: ProtectionFlipRecord
  ): Promise<void> {
    return deleteDBClusterOnce.call(
      this,
      logicalId,
      physicalId,
      resourceType,
      properties,
      context,
      flip
    );
  }
  createDBInstance(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    mask: ((text: string) => string) | undefined,
    replaying = false
  ): Promise<ResourceCreateResult> {
    return createDBInstance.call(this, logicalId, resourceType, properties, mask, replaying);
  }
  updateDBInstance(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>,
    context?: UpdateContext
  ): Promise<ResourceUpdateResult> {
    return updateDBInstance.call(
      this,
      logicalId,
      physicalId,
      resourceType,
      properties,
      previousProperties,
      context
    );
  }
  deleteDBInstance(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void> {
    return deleteDBInstance.call(this, logicalId, physicalId, resourceType, properties, context);
  }
  deleteDBInstanceOnce(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown> | undefined,
    context: DeleteContext | undefined,
    flip: ProtectionFlipRecord
  ): Promise<void> {
    return deleteDBInstanceOnce.call(
      this,
      logicalId,
      physicalId,
      resourceType,
      properties,
      context,
      flip
    );
  }
  applyTagDiff(
    arn: string,
    resourceType: string,
    logicalId: string,
    oldTagsRaw: unknown,
    newTagsRaw: unknown
  ): Promise<void> {
    return applyTagDiff.call(this, arn, resourceType, logicalId, oldTagsRaw, newTagsRaw);
  }
  partialClusterRetiring(dbClusterIdentifier: string): Promise<'gone' | 'deleting' | undefined> {
    return partialClusterRetiring.call(this, dbClusterIdentifier);
  }
  isNotFoundError(error: unknown, faultName: string): boolean {
    return isNotFoundError.call(this, error, faultName);
  }
  wrapCaughtError(
    mask: ((text: string) => string) | undefined,
    error: unknown,
    build: (text: string) => ProvisioningError
  ): ProvisioningError {
    return wrapCaughtError.call(this, mask, error, build);
  }
  wrapDeleteError(
    mask: ((text: string) => string) | undefined,
    error: unknown,
    build: (text: string) => ProvisioningError
  ): ProvisioningError {
    return wrapDeleteError.call(this, mask, error, build);
  }
  wrapGlobalClusterDetachError(
    error: unknown,
    mask: (text: string) => string,
    build: (text: string) => string
  ): GlobalClusterDetachError {
    return wrapGlobalClusterDetachError.call(this, error, mask, build);
  }
  detachFromGlobalCluster(
    logicalId: string,
    physicalId: string,
    globalClusterId: string,
    removeProtection: boolean,
    progress: DeleteProgress,
    mask: (text: string) => string
  ): Promise<boolean> {
    return detachFromGlobalCluster.call(
      this,
      logicalId,
      physicalId,
      globalClusterId,
      removeProtection,
      progress,
      mask
    );
  }
  engineLifecycleSupportToSend(
    kind: 'DB cluster' | 'DB instance',
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>,
    context: UpdateContext | undefined
  ): Promise<string | undefined> {
    return engineLifecycleSupportToSend.call(
      this,
      kind,
      logicalId,
      physicalId,
      resourceType,
      properties,
      previousProperties,
      context
    );
  }
  describeDBCluster(dbClusterIdentifier: string) {
    return describeDBCluster.call(this, dbClusterIdentifier);
  }
  securityGroupsToSend(
    target: 'DBCluster' | 'DBInstance',
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>,
    context: UpdateContext | undefined
  ): Promise<string[] | undefined> {
    return securityGroupsToSend.call(
      this,
      target,
      logicalId,
      physicalId,
      resourceType,
      properties,
      previousProperties,
      context
    );
  }
  describeDBInstance(dbInstanceIdentifier: string) {
    return describeDBInstance.call(this, dbInstanceIdentifier);
  }
  waitForMemberAfterClusterChange(
    dbInstanceIdentifier: string,
    clusterLogicalId: string,
    transitional: ReadonlySet<string>,
    change: string,
    maxWaitMs = 1_800_000
  ): Promise<void> {
    return waitForMemberAfterClusterChange.call(
      this,
      dbInstanceIdentifier,
      clusterLogicalId,
      transitional,
      change,
      maxWaitMs
    );
  }
  requireClusterWhileWaiting(
    cluster: DBCluster | undefined,
    logicalId: string,
    change: string
  ): DBCluster {
    return requireClusterWhileWaiting.call(this, cluster, logicalId, change);
  }
  waitForClusterPortApplied(
    dbClusterIdentifier: string,
    logicalId: string,
    port: number,
    maxWaitMs = 1_800_000
  ): Promise<void> {
    return waitForClusterPortApplied.call(this, dbClusterIdentifier, logicalId, port, maxWaitMs);
  }
  waitForSecurityGroupsApplied(
    dbClusterIdentifier: string,
    logicalId: string,
    expected: readonly string[],
    maxWaitMs = 1_800_000
  ): Promise<void> {
    return waitForSecurityGroupsApplied.call(
      this,
      dbClusterIdentifier,
      logicalId,
      expected,
      maxWaitMs
    );
  }
  waitForClusterState(
    logicalId: string,
    dbClusterIdentifier: string,
    done: (cluster: DBCluster) => boolean,
    change: string
  ): Promise<void> {
    return waitForClusterState.call(this, logicalId, dbClusterIdentifier, done, change);
  }
  sendHttpEndpointChange(
    logicalId: string,
    physicalId: string,
    arn: string,
    enable: boolean
  ): Promise<void> {
    return sendHttpEndpointChange.call(this, logicalId, physicalId, arn, enable);
  }
  deleteAfterProtectionFlip(
    logicalId: string,
    physicalId: string,
    send: () => Promise<unknown>
  ): Promise<void> {
    return deleteAfterProtectionFlip.call(this, logicalId, physicalId, send);
  }
  deleteInstanceAfterProtectionFlip(
    logicalId: string,
    physicalId: string,
    send: () => Promise<unknown>
  ): Promise<void> {
    return deleteInstanceAfterProtectionFlip.call(this, logicalId, physicalId, send);
  }
  desiredAssociatedRoles(
    properties: Record<string, unknown>,
    resourceType: string,
    logicalId: string,
    physicalId: string | undefined,
    replayingCreate: false
  ): AssociatedRole[];
  desiredAssociatedRoles(
    properties: Record<string, unknown>,
    resourceType: string,
    logicalId: string,
    physicalId: string | undefined,
    replayingCreate: boolean
  ): AssociatedRole[] | 'skipped';
  desiredAssociatedRoles(
    properties: Record<string, unknown>,
    resourceType: string,
    logicalId: string,
    physicalId: string | undefined,
    replayingCreate: boolean
  ): AssociatedRole[] | 'skipped' {
    return desiredAssociatedRoles.call(
      this,
      properties,
      resourceType,
      logicalId,
      physicalId,
      replayingCreate
    );
  }
  applyAssociatedRoles(
    target: 'cluster' | 'instance',
    logicalId: string,
    physicalId: string,
    desired: readonly AssociatedRole[],
    previous: readonly AssociatedRole[],
    mask: ((text: string) => string) | undefined,
    marks: Pick<UpdateContext, 'markUnsettled' | 'markAttempted'> | undefined
  ): Promise<void> {
    return applyAssociatedRoles.call(
      this,
      target,
      logicalId,
      physicalId,
      desired,
      previous,
      mask,
      marks
    );
  }
  waitForClusterAvailable(
    logicalId: string,
    dbClusterIdentifier: string,
    maxWaitMs = 1_800_000,
    doing = 'being created'
  ): Promise<void> {
    return waitForClusterAvailable.call(this, logicalId, dbClusterIdentifier, maxWaitMs, doing);
  }
  waitForClusterDeleted(
    logicalId: string,
    dbClusterIdentifier: string,
    maxWaitMs = 1_800_000
  ): Promise<void> {
    return waitForClusterDeleted.call(this, logicalId, dbClusterIdentifier, maxWaitMs);
  }
  rebootForPendingParameterGroup(
    logicalId: string,
    physicalId: string,
    sentGroup: string | undefined,
    caRotationRestarts: boolean
  ): Promise<DBInstance> {
    return rebootForPendingParameterGroup.call(
      this,
      logicalId,
      physicalId,
      sentGroup,
      caRotationRestarts
    );
  }
  waitForInstanceState(
    logicalId: string,
    dbInstanceIdentifier: string,
    done: (instance: DBInstance) => boolean,
    change: string
  ): Promise<DBInstance> {
    return waitForInstanceState.call(this, logicalId, dbInstanceIdentifier, done, change);
  }
  waitForInstanceAvailable(
    logicalId: string,
    dbInstanceIdentifier: string,
    maxWaitMs = 1_800_000,
    doing = 'being created'
  ): Promise<void> {
    return waitForInstanceAvailable.call(this, logicalId, dbInstanceIdentifier, maxWaitMs, doing);
  }
  waitForInstanceDeleted(
    logicalId: string,
    dbInstanceIdentifier: string,
    maxWaitMs = 1_800_000
  ): Promise<void> {
    return waitForInstanceDeleted.call(this, logicalId, dbInstanceIdentifier, maxWaitMs);
  }

  sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  import(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    return importImpl.call(this, input);
  }
  getDriftUnorderedPaths(resourceType: string): string[] {
    return getDriftUnorderedPaths.call(this, resourceType);
  }
  getDriftUnknownPaths(resourceType: string, properties?: Record<string, unknown>): string[] {
    return getDriftUnknownPaths.call(this, resourceType, properties);
  }
  canonicalizeDriftProperties(
    resourceType: string,
    properties: Record<string, unknown>
  ): Record<string, unknown> {
    return canonicalizeDriftProperties.call(this, resourceType, properties);
  }
  canonicalizeUnsettledProperties(
    resourceType: string,
    properties: Record<string, unknown>
  ): Record<string, unknown> {
    return canonicalizeUnsettledProperties.call(this, resourceType, properties);
  }
  readUnsettled(
    physicalId: string,
    logicalId: string,
    resourceType: string,
    names: ReadonlySet<string>,
    recordedProperties?: Record<string, unknown>,
    desiredProperties?: Record<string, unknown>,
    attemptedItems?: ReadonlyMap<string, ReadonlySet<string>>
  ): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
    return readUnsettled.call(
      this,
      physicalId,
      logicalId,
      resourceType,
      names,
      recordedProperties,
      desiredProperties,
      attemptedItems
    );
  }
  readCurrentState(
    physicalId: string,
    _logicalId: string,
    resourceType: string
  ): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
    return readCurrentState.call(this, physicalId, _logicalId, resourceType);
  }
  isSameResource(
    journaledPhysicalId: string,
    record: { physicalId: string },
    resourceType: string,
    context: { expectedRegion: string }
  ): Promise<ResourceIdentityVerdict> {
    return isSameResource.call(this, journaledPhysicalId, record, resourceType, context);
  }
  resourceIdentity(
    physicalId: string,
    resourceType: string,
    context: { expectedRegion: string }
  ): Promise<string | ResourceNotFound | undefined> {
    return resourceIdentity.call(this, physicalId, resourceType, context);
  }
  readDbResourceIdIfExists(
    resourceType: 'AWS::RDS::DBCluster' | 'AWS::RDS::DBInstance',
    identifier: string
  ): Promise<string | undefined> {
    return readDbResourceIdIfExists.call(this, resourceType, identifier);
  }
  readCurrentStateDBInstance(
    physicalId: string
  ): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
    return readCurrentStateDBInstance.call(this, physicalId);
  }
  readCurrentStateDBCluster(
    physicalId: string
  ): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
    return readCurrentStateDBCluster.call(this, physicalId);
  }
  readCurrentStateDBSubnetGroup(
    physicalId: string
  ): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
    return readCurrentStateDBSubnetGroup.call(this, physicalId);
  }
  attachTags(result: Record<string, unknown>, arn: string): Promise<void> {
    return attachTags.call(this, result, arn);
  }
  importDBInstance(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    return importDBInstance.call(this, input);
  }
  importDBCluster(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    return importDBCluster.call(this, input);
  }
  importDBSubnetGroup(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    return importDBSubnetGroup.call(this, input);
  }
}
