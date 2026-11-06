import { NeptuneClient, type DBCluster } from '@aws-sdk/client-neptune';
import { EC2Client } from '@aws-sdk/client-ec2';
import { getLogger, type ConsoleLogger } from '../../utils/logger.js';
import { ProvisioningError } from '../../utils/error-handler.js';
import type { DeleteContext } from '../region-check.js';
import type {
  ResourceProvider,
  CreateContext,
  ResourceCreateResult,
  ResourceUpdateResult,
  UpdateContext,
  ResourceImportInput,
  ResourceImportResult,
  ResourceIdentityVerdict,
  ResourceNotFound,
} from '../../types/resource.js';
import { ambientRegion } from '../../utils/stack-aws-scope.js';
import {
  ProtectionFlipRegistry,
  type ProtectionFlipRecord,
} from './deletion-protection-compensation.js';
import type { AssociatedRole } from './db-associated-roles.js';
import {
  getClient,
  getEc2Client,
  getCreateClient,
  create,
  update,
  deleteImpl,
  wrapCaughtError,
  wrapDeleteError,
  applyTagDiff,
  isNotFoundError,
  isSameResource,
  resourceIdentity,
  readDbResourceIdIfExists,
} from './neptune/core.js';
import {
  createDBSubnetGroup,
  updateDBSubnetGroup,
  deleteDBSubnetGroup,
} from './neptune/subnet-group.js';
import {
  createDBCluster,
  sendRestoreFollowUp,
  warnIgnoredRestoreProperties,
} from './neptune/cluster-create.js';
import {
  updateDBCluster,
  readClusterBlocks,
  applyClusterRoles,
  waitForClusterRolesSettled,
  warnKeptRemovals,
  readPublicAccess,
  warnPublicAccessKept,
  dbClusterSecurityGroupsToSend,
} from './neptune/cluster-update.js';
import {
  deleteDBCluster,
  deleteDBClusterOnce,
  deleteAfterProtectionFlip,
} from './neptune/cluster-delete.js';
import {
  createDBInstance,
  updateDBInstance,
  deleteDBInstance,
  deleteDBInstanceOnce,
} from './neptune/instance.js';
import {
  waitForApplied,
  pollUntilSettled,
  describeDBCluster,
  describeDBInstance,
  waitForMemberAfterSecurityGroupChange,
  requireClusterWhileWaiting,
  waitForSecurityGroupsApplied,
  waitForClusterAvailable,
  waitForClusterDeleted,
  waitForInstanceAvailable,
  waitForInstanceDeleted,
  sleep,
} from './neptune/waits.js';
import {
  getDriftUnknownPaths,
  getDriftUnorderedPaths,
  canonicalizeDriftProperties,
  canonicalizeUnsettledProperties,
  readUnsettled,
  unsettledInTransition,
  readCurrentState,
  readCurrentStateDBInstance,
  readCurrentStateDBCluster,
  readCurrentStateDBSubnetGroup,
  attachTags,
} from './neptune/read-state.js';
import {
  importImpl,
  importDBInstance,
  importDBCluster,
  importDBSubnetGroup,
} from './neptune/import.js';
import {
  CLUSTER_AVAILABLE_MAX_WAIT_MS,
  CLUSTER_KEPT_ON_REMOVAL,
  CLUSTER_UNMEASURED_ON_REMOVAL,
  type ClusterRestore,
  INSTANCE_KEPT_ON_REMOVAL,
  type RestoreFollowUp,
} from './neptune/shared.js';

/**
 * AWS Neptune Provider
 *
 * Implements resource provisioning for Neptune resources:
 * - AWS::Neptune::DBSubnetGroup
 * - AWS::Neptune::DBCluster
 * - AWS::Neptune::DBInstance
 *
 * WHY a dedicated SDK provider (instead of CC API fallback):
 *   1. Owns the `--remove-protection` flip-off for both
 *      `AWS::Neptune::DBCluster` and `AWS::Neptune::DBInstance` —
 *      Neptune's API exposes `DeletionProtection: boolean` on both
 *      shapes (unlike DocDB, where only the cluster has it). The
 *      bypass logic lives in per-type SDK providers, not in
 *      `cloud-control-provider.ts`.
 *   2. Direct SDK calls avoid CC API polling overhead. Cluster /
 *      instance creation still takes time, so we poll
 *      `DescribeDBClusters` / `DescribeDBInstances` until status flips
 *      to `available`.
 *
 * Neptune's API shapes mirror the RDS API exactly (the AWS team copied
 * them across); see `rds-provider.ts` and its `rds/` directory for the
 * structural template.
 */
export class NeptuneProvider implements ResourceProvider {
  neptuneClient?: NeptuneClient;
  createClient?: NeptuneClient;
  ec2Client?: EC2Client;
  readonly providerRegion: string | undefined;
  logger: ConsoleLogger = getLogger().child('NeptuneProvider');
  /**
   * What a `--remove-protection` flip did, per resource, across the outer
   * retry loop's re-entries (issue #2204; the mechanism is
   * `./deletion-protection-compensation.ts`).
   */
  readonly protectionFlips = new ProtectionFlipRegistry();

  /**
   * `removalDefaults` is deliberately empty (issue #5004). A real
   * CloudFormation A/B showed that removing `DeletionProtection`,
   * `IamAuthEnabled` or `BackupRetentionPeriod` (DBCluster) or
   * `AutoMinorVersionUpgrade` (DBInstance) from the template KEEPS the live
   * value, so cdkd leaves them untouched too (Modify*: an absent field means
   * "no change"). Not measurable: `DBInstance.DeletionProtection` is not a
   * CloudFormation property (its pass-through below is kept as is), and
   * `DBSubnetGroupDescription` is required there, so it cannot be removed.
   */

  handledProperties = new Map<string, ReadonlySet<string>>([
    [
      'AWS::Neptune::DBSubnetGroup',
      new Set(['DBSubnetGroupName', 'DBSubnetGroupDescription', 'SubnetIds', 'Tags']),
    ],
    [
      'AWS::Neptune::DBCluster',
      new Set([
        'DBClusterIdentifier',
        'EngineVersion',
        'DBPort',
        'Port',
        'VpcSecurityGroupIds',
        'DBSubnetGroupName',
        'StorageEncrypted',
        'KmsKeyId',
        'BackupRetentionPeriod',
        'PreferredBackupWindow',
        'PreferredMaintenanceWindow',
        'DBClusterParameterGroupName',
        'IamAuthEnabled',
        'DeletionProtection',
        'Tags',
        'AssociatedRoles',
        'AvailabilityZones',
        'CopyTagsToSnapshot',
        'DBInstanceParameterGroupName',
        'EnableCloudwatchLogsExports',
        'NetworkType',
        'ServerlessScalingConfiguration',
        'RestoreToTime',
        'RestoreType',
        'SnapshotIdentifier',
        'SourceDBClusterIdentifier',
        'UseLatestRestorableTime',
      ]),
    ],
    [
      'AWS::Neptune::DBInstance',
      new Set([
        'DBInstanceIdentifier',
        'DBInstanceClass',
        'DBClusterIdentifier',
        'DBSubnetGroupName',
        'DBParameterGroupName',
        'AvailabilityZone',
        'PreferredMaintenanceWindow',
        'AutoMinorVersionUpgrade',
        'DeletionProtection',
        'Tags',
        'AllowMajorVersionUpgrade',
        'PubliclyAccessible',
      ]),
    ],
  ]);

  /**
   * Properties still routed to Cloud Control, each with its reason.
   */
  unhandledByDesign = new Map<string, ReadonlyMap<string, string>>([
    [
      'AWS::Neptune::DBCluster',
      new Map([
        [
          'GlobalClusterIdentifier',
          'Cloud Control owns a global-cluster member: NeptuneProvider has no detach, and a member cannot be deleted while attached (deletesThroughSdkProvider keeps its delete there too)',
        ],
      ]),
    ],
    [
      'AWS::Neptune::DBInstance',
      new Map([
        [
          'DBSnapshotIdentifier',
          'The CloudFormation schema documents it as not supported, and CreateDBInstance has no such member: a Neptune instance is not restored from a snapshot, its cluster is',
        ],
      ]),
    ],
  ]);

  /**
   * Issue #1160 (`ResourceProvider.removalHandledInUpdate`): the handled
   * DBCluster / DBInstance properties whose removal `update()` handles, so
   * the shared caller warns about none of them. Create-only ones replace;
   * `VpcSecurityGroupIds` is reset (`dbClusterSecurityGroupsToSend`); `Tags`,
   * `AssociatedRoles` and `EnableCloudwatchLogsExports` are diffed;
   * `DBInstanceClass` is required; `DBInstanceParameterGroupName` and
   * `AllowMajorVersionUpgrade` are per-call flags with no live value. Every
   * property of the KEPT lists is LEFT in place, as CloudFormation leaves it
   * (measured, see {@link CLUSTER_KEPT_ON_REMOVAL}), and named in `update()`'s
   * own warning. The instance's `DeletionProtection` is not a CloudFormation
   * property, so no CloudFormation template removes it. The UNMEASURED list is
   * left in place and warned about too, without the parity claim.
   * `PubliclyAccessible` is left too (#2762 A/B: KEPT), under a warning of its
   * own ({@link warnPublicAccessKept}).
   */
  removalHandledInUpdate = new Map<string, ReadonlySet<string>>([
    [
      'AWS::Neptune::DBCluster',
      new Set([
        'DBClusterIdentifier',
        'DBSubnetGroupName',
        'StorageEncrypted',
        'KmsKeyId',
        'AvailabilityZones',
        'VpcSecurityGroupIds',
        'Tags',
        'AssociatedRoles',
        'EnableCloudwatchLogsExports',
        'DBInstanceParameterGroupName',
        'RestoreToTime',
        'RestoreType',
        'SnapshotIdentifier',
        'SourceDBClusterIdentifier',
        'UseLatestRestorableTime',
        ...CLUSTER_KEPT_ON_REMOVAL,
        ...CLUSTER_UNMEASURED_ON_REMOVAL,
      ]),
    ],
    [
      'AWS::Neptune::DBInstance',
      new Set([
        'DBInstanceIdentifier',
        'DBClusterIdentifier',
        'DBSubnetGroupName',
        'AvailabilityZone',
        'DBInstanceClass',
        'DeletionProtection',
        'Tags',
        'AllowMajorVersionUpgrade',
        'PubliclyAccessible',
        ...INSTANCE_KEPT_ON_REMOVAL,
      ]),
    ],
  ]);

  /**
   * `region` pins the client instead of the ambient region: the Cloud Control
   * delete delegation (issue #4029) passes its OWN client's region, which is
   * the one its recorded-region pre-flight vetted.
   */
  constructor(options?: { region?: string }) {
    this.providerRegion = options?.region ?? ambientRegion();
  }

  getClient(): NeptuneClient {
    return getClient.call(this);
  }

  getEc2Client(): EC2Client {
    return getEc2Client.call(this);
  }

  getCreateClient(): NeptuneClient {
    return getCreateClient.call(this);
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
    _properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void> {
    return deleteImpl.call(this, logicalId, physicalId, resourceType, _properties, context);
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
    replayingState: boolean
  ): Promise<ResourceCreateResult> {
    return createDBCluster.call(this, logicalId, resourceType, properties, mask, replayingState);
  }

  sendRestoreFollowUp(
    logicalId: string,
    resourceType: string,
    physicalId: string,
    followUp: RestoreFollowUp,
    mask: ((text: string) => string) | undefined
  ): Promise<void> {
    return sendRestoreFollowUp.call(this, logicalId, resourceType, physicalId, followUp, mask);
  }

  warnIgnoredRestoreProperties(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    restore: ClusterRestore | undefined
  ): void {
    return warnIgnoredRestoreProperties.call(this, logicalId, resourceType, properties, restore);
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
    context?: DeleteContext
  ): Promise<void> {
    return deleteDBCluster.call(this, logicalId, physicalId, resourceType, context);
  }

  deleteDBClusterOnce(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    context: DeleteContext | undefined,
    flip: ProtectionFlipRecord
  ): Promise<void> {
    return deleteDBClusterOnce.call(this, logicalId, physicalId, resourceType, context, flip);
  }

  createDBInstance(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    mask: ((text: string) => string) | undefined,
    replayingState: boolean
  ): Promise<ResourceCreateResult> {
    return createDBInstance.call(this, logicalId, resourceType, properties, mask, replayingState);
  }

  updateDBInstance(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>,
    context: UpdateContext | undefined
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
    context?: DeleteContext
  ): Promise<void> {
    return deleteDBInstance.call(this, logicalId, physicalId, resourceType, context);
  }

  deleteDBInstanceOnce(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    context: DeleteContext | undefined,
    flip: ProtectionFlipRecord
  ): Promise<void> {
    return deleteDBInstanceOnce.call(this, logicalId, physicalId, resourceType, context, flip);
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

  applyTagDiff(
    arn: string,
    resourceType: string,
    logicalId: string,
    oldTagsRaw: unknown,
    newTagsRaw: unknown
  ): Promise<void> {
    return applyTagDiff.call(this, arn, resourceType, logicalId, oldTagsRaw, newTagsRaw);
  }

  isNotFoundError(error: unknown, faultName: string): boolean {
    return isNotFoundError.call(this, error, faultName);
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
    resourceType: 'AWS::Neptune::DBCluster' | 'AWS::Neptune::DBInstance',
    identifier: string
  ): Promise<string | undefined> {
    return readDbResourceIdIfExists.call(this, resourceType, identifier);
  }

  readClusterBlocks(
    properties: Record<string, unknown>,
    resourceType: string,
    logicalId: string,
    origin: { creating: boolean; stateBorne: boolean; physicalId?: string }
  ): {
    roles: AssociatedRole[];
    logTypes: string[];
    scaling: { MinCapacity: number; MaxCapacity: number } | null | undefined;
  } {
    return readClusterBlocks.call(this, properties, resourceType, logicalId, origin);
  }

  applyClusterRoles(
    logicalId: string,
    physicalId: string,
    desired: readonly AssociatedRole[],
    previous: readonly AssociatedRole[],
    mask: ((text: string) => string) | undefined,
    marks: Pick<UpdateContext, 'markUnsettled' | 'markAttempted'> | undefined
  ): Promise<void> {
    return applyClusterRoles.call(this, logicalId, physicalId, desired, previous, mask, marks);
  }

  waitForClusterRolesSettled(
    logicalId: string,
    physicalId: string,
    attached: ReadonlySet<string>,
    detached: ReadonlySet<string>,
    mask: ((text: string) => string) | undefined
  ): Promise<void> {
    return waitForClusterRolesSettled.call(this, logicalId, physicalId, attached, detached, mask);
  }

  waitForApplied(logicalId: string, what: string, applied: () => Promise<boolean>): Promise<void> {
    return waitForApplied.call(this, logicalId, what, applied);
  }

  pollUntilSettled(settled: () => Promise<boolean>): Promise<boolean> {
    return pollUntilSettled.call(this, settled);
  }

  describeDBCluster(dbClusterIdentifier: string) {
    return describeDBCluster.call(this, dbClusterIdentifier);
  }

  warnKeptRemovals(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>,
    kept: readonly string[],
    context: UpdateContext | undefined,
    measured = true
  ): void {
    return warnKeptRemovals.call(
      this,
      logicalId,
      resourceType,
      properties,
      previousProperties,
      kept,
      context,
      measured
    );
  }

  readPublicAccess(
    properties: Record<string, unknown>,
    resourceType: string,
    logicalId: string,
    physicalId: string | undefined,
    stateBorne: boolean
  ): boolean | undefined {
    return readPublicAccess.call(this, properties, resourceType, logicalId, physicalId, stateBorne);
  }

  warnPublicAccessKept(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>,
    context: UpdateContext | undefined
  ): void {
    return warnPublicAccessKept.call(
      this,
      logicalId,
      resourceType,
      properties,
      previousProperties,
      context
    );
  }

  dbClusterSecurityGroupsToSend(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>,
    context: UpdateContext | undefined
  ): Promise<string[] | undefined> {
    return dbClusterSecurityGroupsToSend.call(
      this,
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

  waitForMemberAfterSecurityGroupChange(
    dbInstanceIdentifier: string,
    clusterLogicalId: string,
    maxWaitMs = 1_800_000
  ): Promise<void> {
    return waitForMemberAfterSecurityGroupChange.call(
      this,
      dbInstanceIdentifier,
      clusterLogicalId,
      maxWaitMs
    );
  }

  requireClusterWhileWaiting(cluster: DBCluster | undefined, logicalId: string): DBCluster {
    return requireClusterWhileWaiting.call(this, cluster, logicalId);
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

  deleteAfterProtectionFlip(
    logicalId: string,
    physicalId: string,
    send: () => Promise<unknown>
  ): Promise<void> {
    return deleteAfterProtectionFlip.call(this, logicalId, physicalId, send);
  }

  waitForClusterAvailable(
    logicalId: string,
    dbClusterIdentifier: string,
    during = 'being created',
    maxWaitMs = CLUSTER_AVAILABLE_MAX_WAIT_MS
  ): Promise<void> {
    return waitForClusterAvailable.call(this, logicalId, dbClusterIdentifier, during, maxWaitMs);
  }

  waitForClusterDeleted(
    logicalId: string,
    dbClusterIdentifier: string,
    maxWaitMs = 1_800_000
  ): Promise<void> {
    return waitForClusterDeleted.call(this, logicalId, dbClusterIdentifier, maxWaitMs);
  }

  waitForInstanceAvailable(
    logicalId: string,
    dbInstanceIdentifier: string,
    maxWaitMs = 1_800_000
  ): Promise<void> {
    return waitForInstanceAvailable.call(this, logicalId, dbInstanceIdentifier, maxWaitMs);
  }

  waitForInstanceDeleted(dbInstanceIdentifier: string, maxWaitMs = 1_800_000): Promise<void> {
    return waitForInstanceDeleted.call(this, dbInstanceIdentifier, maxWaitMs);
  }

  sleep(ms: number): Promise<void> {
    return sleep.call(this, ms);
  }

  getDriftUnknownPaths(resourceType: string): string[] {
    return getDriftUnknownPaths.call(this, resourceType);
  }

  getDriftUnorderedPaths(resourceType: string): string[] {
    return getDriftUnorderedPaths.call(this, resourceType);
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

  unsettledInTransition(
    physicalId: string,
    _logicalId: string,
    resourceType: string,
    names: ReadonlySet<string>,
    _recordedProperties?: Record<string, unknown>,
    desiredProperties?: Record<string, unknown>
  ): Promise<ReadonlySet<string>> {
    return unsettledInTransition.call(
      this,
      physicalId,
      _logicalId,
      resourceType,
      names,
      _recordedProperties,
      desiredProperties
    );
  }

  import(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    return importImpl.call(this, input);
  }

  readCurrentState(
    physicalId: string,
    _logicalId: string,
    resourceType: string
  ): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
    return readCurrentState.call(this, physicalId, _logicalId, resourceType);
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
