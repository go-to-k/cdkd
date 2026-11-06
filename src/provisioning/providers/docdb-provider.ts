import { DocDBClient, type DBCluster } from '@aws-sdk/client-docdb';
import { getLogger, type ConsoleLogger } from '../../utils/logger.js';
import { type DeleteProgress } from '../delete-started.js';
import { ProvisioningError } from '../../utils/error-handler.js';
import { type DeleteContext } from '../region-check.js';
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
import {
  getClient,
  getCreateClient,
  create,
  update,
  deleteImpl,
  wrapCaughtError,
  wrapDeleteError,
  isSameResource,
  resourceIdentity,
  readDbResourceIdIfExists,
  markChangedUnsettled,
  refuseBlock,
  readBooleanProperty,
  passwordBesideManaged,
  sleep,
} from './docdb/core.js';
import {
  createDBCluster,
  refuseUnencryptedRestoreSource,
  sendRestoreFollowUp,
  warnRestoredDifferences,
} from './docdb/cluster-create.js';
import {
  updateDBCluster,
  planGlobalClusterUpdate,
  liveGlobalClusterMatches,
  readClusterBlocks,
  planMasterCredentials,
} from './docdb/cluster-update.js';
import {
  deleteDBCluster,
  deleteDBClusterOnce,
  wrapGlobalClusterDetachError,
  detachFromGlobalCluster,
} from './docdb/cluster-delete.js';
import { createDBInstance, updateDBInstance, deleteDBInstance } from './docdb/instance.js';
import {
  waitForApplied,
  describeDBCluster,
  describeDBInstance,
  waitForMemberAfterClusterChange,
  requireClusterWhileWaiting,
  waitForClusterPortApplied,
  waitForSecurityGroupsApplied,
  deleteAfterProtectionFlip,
  waitForClusterAvailable,
  waitForClusterDeleted,
  waitForInstanceAvailable,
  waitForInstanceDeleted,
} from './docdb/wait.js';
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
} from './docdb/read-state.js';
import { importImpl, importDBInstance, importDBCluster } from './docdb/import.js';
import {
  DOCDB_CLUSTER_KEPT_ON_REMOVAL,
  DOCDB_CLUSTER_UNMEASURED_ON_REMOVAL,
  DOCDB_INSTANCE_KEPT_ON_REMOVAL,
  type GlobalClusterUpdate,
  GlobalClusterDetachError,
  type DocDBClusterRestore,
  type DocDBRestoreFollowUp,
} from './docdb/shared.js';
export { DOCDB_CLUSTER_KEPT_ON_REMOVAL } from './docdb/shared.js';

/**
 * AWS DocumentDB Provider
 *
 * Implements resource provisioning for DocumentDB resources:
 * - AWS::DocDB::DBCluster
 * - AWS::DocDB::DBInstance
 *
 * `AWS::DocDB::DBSubnetGroup` has its own provider,
 * `DocDBSubnetGroupProvider`: see {@link DocDBProvider.disableCcApiFallback}.
 *
 * WHY a dedicated SDK provider (instead of CC API fallback):
 *   1. Owns the `--remove-protection` flip-off for `AWS::DocDB::DBCluster`.
 *      DocDB inherits the RDS-shaped `DeletionProtection` boolean on the
 *      cluster (NOT on the instance — DocDB DBInstance has no
 *      DeletionProtection field per the AWS SDK), and the bypass logic
 *      lives in per-type SDK providers, not in `cloud-control-provider.ts`.
 *   2. Direct SDK calls avoid CC API polling overhead. DocDB cluster /
 *      instance creation still takes time (1–5 min), so we poll
 *      `DescribeDBClusters` / `DescribeDBInstances` until status flips to
 *      `available`.
 *
 * DocDB's API shapes mirror the RDS API exactly (the AWS team copied them
 * across); see `rds-provider.ts` and its `rds/` directory for the structural
 * template.
 */
export class DocDBProvider implements ResourceProvider {
  docdbClient?: DocDBClient;
  createClient?: DocDBClient;
  readonly providerRegion = ambientRegion();
  logger: ConsoleLogger = getLogger().child('DocDBProvider');
  /**
   * What a `--remove-protection` flip did, per resource, across the outer
   * retry loop's re-entries (issue #2204; the mechanism is
   * `./deletion-protection-compensation.ts`).
   */
  readonly protectionFlips = new ProtectionFlipRegistry();

  /**
   * `AWS::DocDB::DBCluster` and `AWS::DocDB::DBInstance` are
   * `ProvisioningType: NON_PROVISIONABLE` — Cloud Control has no handlers for
   * them — so the #614 SDK-unwired auto-route must not send a template using
   * an unhandled property to CC, where it fails mid-deploy with an
   * opaque UnsupportedActionException. With this opt-out the registry refuses
   * such a template pre-flight (issue #3866).
   *
   * The flag is per PROVIDER, which is why `AWS::DocDB::DBSubnetGroup` — a
   * type Cloud Control CAN manage — lives in `DocDBSubnetGroupProvider`, keeping
   * its Cloud Control route. Do not register it on this class again.
   */
  readonly disableCcApiFallback = true;

  /**
   * Issue #1160 (`ResourceProvider.removalHandledInUpdate`): every handled
   * property of both types, each removal handled by `update()`, so the shared
   * caller warns about none of them.
   *
   * No `removalDefaults` (issue #5004): ModifyDBCluster / ModifyDBInstance
   * merge (an absent field means "no change"), and a real CloudFormation A/B
   * showed CloudFormation KEEPS the live value of every removal listed under
   * `*_KEPT_ON_REMOVAL`, which `update()` names in its own warning. The one
   * DocDB reset CloudFormation was measured to make, a removed cluster `Port`,
   * is computed locally (`clusterPortToSend`), and a removed
   * `GlobalClusterIdentifier` detaches the cluster in place, as a real
   * CloudFormation A/B measured (go-to-k/cdkd#5628, `planGlobalClusterUpdate`).
   * Four entries are listed without an A/B, because no reset value exists: a
   * removed `MasterUserPassword` (a secret with no default), the per-call
   * `RotateMasterUserPassword` and `CertificateRotationRestart`, and the
   * instance `AutoMinorVersionUpgrade` (inert on DocDB, see
   * `updateDBInstance`). The UNMEASURED cluster list is named in a warning that
   * claims no parity.
   */
  removalHandledInUpdate = new Map<string, ReadonlySet<string>>([
    [
      'AWS::DocDB::DBCluster',
      new Set([
        // Create-only: a removal replaces.
        'AvailabilityZones',
        'DBClusterIdentifier',
        'DBSubnetGroupName',
        'KmsKeyId',
        'MasterUsername',
        'StorageEncrypted',
        // Reset to 27017 (`clusterPortToSend`), as CloudFormation resets it.
        'Port',
        // Diffed (AddTagsToResource / RemoveTagsFromResource).
        'Tags',
        // Not measured: a secret with no default to reset to, so a removal
        // sends nothing and the cluster keeps its password.
        'MasterUserPassword',
        // A request, not a setting: nothing to reset.
        'RotateMasterUserPassword',
        // go-to-k/cdkd#5628: a removal detaches in place (CFn A/B).
        'GlobalClusterIdentifier',
        // go-to-k/cdkd#5628: what the cluster was made from. The identifiers
        // are create-only (a removal replaces); the point-in-time keys are read
        // by the create alone, and CloudFormation's update of one sends nothing
        // for it (measured), so there is nothing to reset.
        'SnapshotIdentifier',
        'SourceDBClusterIdentifier',
        'RestoreToTime',
        'RestoreType',
        'UseLatestRestorableTime',
        // Left in place, as CloudFormation leaves them (CFn A/B), and named in
        // update()'s own warning.
        ...DOCDB_CLUSTER_KEPT_ON_REMOVAL,
        // Left in place and named in the warning claiming no parity.
        ...DOCDB_CLUSTER_UNMEASURED_ON_REMOVAL,
      ]),
    ],
    [
      'AWS::DocDB::DBInstance',
      new Set([
        // Create-only (a removal replaces) or required (DBInstanceClass).
        'DBInstanceIdentifier',
        'DBClusterIdentifier',
        'AvailabilityZone',
        'DBInstanceClass',
        // Diffed (AddTagsToResource / RemoveTagsFromResource).
        'Tags',
        // Not measured: inert on DocDB (see updateDBInstance), no value to reset.
        'AutoMinorVersionUpgrade',
        // Rides a CACertificateIdentifier change only: nothing to reset.
        'CertificateRotationRestart',
        // Left in place, as CloudFormation leaves it (CFn A/B 2026-10-30,
        // #5543), and named in update()'s own warning.
        ...DOCDB_INSTANCE_KEPT_ON_REMOVAL,
      ]),
    ],
  ]);

  handledProperties = new Map<string, ReadonlySet<string>>([
    [
      'AWS::DocDB::DBCluster',
      new Set([
        'DBClusterIdentifier',
        'EngineVersion',
        'MasterUsername',
        'MasterUserPassword',
        'Port',
        'VpcSecurityGroupIds',
        'DBSubnetGroupName',
        'StorageEncrypted',
        'KmsKeyId',
        'BackupRetentionPeriod',
        'PreferredBackupWindow',
        'PreferredMaintenanceWindow',
        'DBClusterParameterGroupName',
        'DeletionProtection',
        'Tags',
        'AvailabilityZones',
        'CopyTagsToSnapshot',
        'EnableCloudwatchLogsExports',
        'GlobalClusterIdentifier',
        'ManageMasterUserPassword',
        'MasterUserSecretKmsKeyId',
        'NetworkType',
        'RotateMasterUserPassword',
        'ServerlessV2ScalingConfiguration',
        'StorageType',
        // go-to-k/cdkd#5628: a restore (`readDocDBClusterRestore`).
        'RestoreToTime',
        'RestoreType',
        'SnapshotIdentifier',
        'SourceDBClusterIdentifier',
        'UseLatestRestorableTime',
      ]),
    ],
    [
      'AWS::DocDB::DBInstance',
      // DocDB DBInstance does NOT support DeletionProtection (verified
      // against the @aws-sdk/client-docdb CreateDBInstanceMessage type —
      // the field is absent). Cluster-level DeletionProtection covers the
      // common case anyway; instance deletes are gated by the cluster's
      // protection flag in normal use.
      new Set([
        'DBInstanceIdentifier',
        'DBInstanceClass',
        'DBClusterIdentifier',
        'AvailabilityZone',
        'PreferredMaintenanceWindow',
        'AutoMinorVersionUpgrade',
        'Tags',
        'CACertificateIdentifier',
        'CertificateRotationRestart',
        'EnablePerformanceInsights',
      ]),
    ],
  ]);

  getClient(): DocDBClient {
    return getClient.call(this);
  }

  getCreateClient(): DocDBClient {
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
    properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void> {
    return deleteImpl.call(this, logicalId, physicalId, resourceType, properties, context);
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

  createDBCluster(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    mask: ((text: string) => string) | undefined,
    replayingState: boolean
  ): Promise<ResourceCreateResult> {
    return createDBCluster.call(this, logicalId, resourceType, properties, mask, replayingState);
  }

  refuseUnencryptedRestoreSource(
    properties: Record<string, unknown>,
    restore: DocDBClusterRestore,
    resourceType: string,
    logicalId: string,
    mask: ((text: string) => string) | undefined
  ): Promise<void> {
    return refuseUnencryptedRestoreSource.call(
      this,
      properties,
      restore,
      resourceType,
      logicalId,
      mask
    );
  }

  sendRestoreFollowUp(
    logicalId: string,
    resourceType: string,
    physicalId: string,
    followUp: DocDBRestoreFollowUp,
    mask: ((text: string) => string) | undefined
  ): Promise<void> {
    return sendRestoreFollowUp.call(this, logicalId, resourceType, physicalId, followUp, mask);
  }

  warnRestoredDifferences(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    restore: DocDBClusterRestore,
    cluster: DBCluster
  ): void {
    return warnRestoredDifferences.call(
      this,
      logicalId,
      resourceType,
      properties,
      restore,
      cluster
    );
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
    options: { beforeDelete: boolean; removeProtection: boolean },
    progress: DeleteProgress,
    mask: (text: string) => string
  ): Promise<boolean> {
    return detachFromGlobalCluster.call(
      this,
      logicalId,
      physicalId,
      globalClusterId,
      options,
      progress,
      mask
    );
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

  markChangedUnsettled(
    keys: readonly string[],
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>,
    context: UpdateContext | undefined
  ): void {
    return markChangedUnsettled.call(this, keys, properties, previousProperties, context);
  }

  refuseBlock(
    logicalId: string,
    resourceType: string,
    physicalId: string | undefined,
    text: string
  ): never {
    return refuseBlock.call(this, logicalId, resourceType, physicalId, text);
  }

  planGlobalClusterUpdate(
    physicalId: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>,
    resourceType: string,
    logicalId: string,
    origin: { stateBorne: boolean; physicalId?: string },
    fromReadback: boolean
  ): Promise<GlobalClusterUpdate> {
    return planGlobalClusterUpdate.call(
      this,
      physicalId,
      properties,
      previousProperties,
      resourceType,
      logicalId,
      origin,
      fromReadback
    );
  }

  liveGlobalClusterMatches(
    physicalId: string,
    desiredId: string | undefined
  ): Promise<boolean | undefined> {
    return liveGlobalClusterMatches.call(this, physicalId, desiredId);
  }

  readClusterBlocks(
    properties: Record<string, unknown>,
    resourceType: string,
    logicalId: string,
    origin: { stateBorne: boolean; physicalId?: string },
    creating: boolean
  ): {
    logTypes: string[] | undefined;
    scaling: { MinCapacity: number; MaxCapacity: number } | null | undefined;
  } {
    return readClusterBlocks.call(this, properties, resourceType, logicalId, origin, creating);
  }

  planMasterCredentials(
    physicalId: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>,
    resourceType: string,
    logicalId: string,
    context: UpdateContext | undefined,
    origin: { stateBorne: boolean; physicalId?: string }
  ): Promise<{
    managed: boolean | undefined;
    secretKmsKey: string | undefined;
    password: string | undefined;
    heldWarning: string | undefined;
    effectiveProperties?: Record<string, unknown>;
  }> {
    return planMasterCredentials.call(
      this,
      physicalId,
      properties,
      previousProperties,
      resourceType,
      logicalId,
      context,
      origin
    );
  }

  readBooleanProperty(
    key: 'ManageMasterUserPassword' | 'EnablePerformanceInsights',
    properties: Record<string, unknown>,
    resourceType: string,
    logicalId: string,
    origin: { stateBorne: boolean; physicalId?: string }
  ): boolean | undefined {
    return readBooleanProperty.call(this, key, properties, resourceType, logicalId, origin);
  }

  passwordBesideManaged(
    managed: boolean | undefined,
    removedFromManaged: boolean,
    password: string | undefined,
    resourceType: string,
    logicalId: string,
    origin: { stateBorne: boolean; physicalId?: string }
  ): string | undefined {
    return passwordBesideManaged.call(
      this,
      managed,
      removedFromManaged,
      password,
      resourceType,
      logicalId,
      origin
    );
  }

  waitForApplied<T>(
    logicalId: string,
    applied: ReadonlyMap<string, (live: T | undefined) => boolean>,
    read: () => Promise<T | undefined>,
    maxWaitMs?: number
  ): Promise<void> {
    return (waitForApplied<T>).call(this, logicalId, applied, read, maxWaitMs);
  }

  describeDBCluster(dbClusterIdentifier: string) {
    return describeDBCluster.call(this, dbClusterIdentifier);
  }

  describeDBInstance(dbInstanceIdentifier: string) {
    return describeDBInstance.call(this, dbInstanceIdentifier);
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
    resourceType: 'AWS::DocDB::DBCluster' | 'AWS::DocDB::DBInstance',
    identifier: string
  ): Promise<string | undefined> {
    return readDbResourceIdIfExists.call(this, resourceType, identifier);
  }

  waitForMemberAfterClusterChange(
    dbInstanceIdentifier: string,
    clusterLogicalId: string,
    transitional: ReadonlySet<string>,
    change: string,
    maxWaitMs?: number
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
    maxWaitMs?: number
  ): Promise<void> {
    return waitForClusterPortApplied.call(this, dbClusterIdentifier, logicalId, port, maxWaitMs);
  }

  waitForSecurityGroupsApplied(
    dbClusterIdentifier: string,
    logicalId: string,
    expected: readonly string[],
    maxWaitMs?: number
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
    maxWaitMs?: number
  ): Promise<void> {
    return waitForClusterAvailable.call(this, logicalId, dbClusterIdentifier, maxWaitMs);
  }

  waitForClusterDeleted(
    logicalId: string,
    dbClusterIdentifier: string,
    maxWaitMs?: number
  ): Promise<void> {
    return waitForClusterDeleted.call(this, logicalId, dbClusterIdentifier, maxWaitMs);
  }

  waitForInstanceAvailable(
    logicalId: string,
    dbInstanceIdentifier: string,
    maxWaitMs?: number
  ): Promise<void> {
    return waitForInstanceAvailable.call(this, logicalId, dbInstanceIdentifier, maxWaitMs);
  }

  waitForInstanceDeleted(dbInstanceIdentifier: string, maxWaitMs?: number): Promise<void> {
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

  importDBInstance(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    return importDBInstance.call(this, input);
  }

  importDBCluster(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    return importDBCluster.call(this, input);
  }
}
