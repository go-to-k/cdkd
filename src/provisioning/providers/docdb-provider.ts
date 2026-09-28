import {
  DocDBClient,
  CreateDBClusterCommand,
  DeleteDBClusterCommand,
  ModifyDBClusterCommand,
  DescribeDBClustersCommand,
  CreateDBInstanceCommand,
  DeleteDBInstanceCommand,
  ModifyDBInstanceCommand,
  DescribeDBInstancesCommand,
} from '@aws-sdk/client-docdb';
import { getLogger } from '../../utils/logger.js';
import { describeAwsFailure } from '../../utils/aws-failure-text.js';
import { ProvisioningError } from '../../utils/error-handler.js';
import { assertRegionMatch, type DeleteContext } from '../region-check.js';
import { generateResourceName } from '../resource-name.js';
import { clearOnUpdateRemoval } from '../update-removal.js';
import { resolveExplicitPhysicalId } from '../import-helpers.js';
import type {
  ResourceProvider,
  ResourceCreateResult,
  ResourceUpdateResult,
  ResourceImportInput,
  ResourceImportResult,
} from '../../types/resource.js';
import { ambientClientDefaults } from '../../utils/ambient-client-defaults.js';
import { definedAttributes, stringifyIfAssigned } from '../attribute-map.js';
import { ambientRegion } from '../../utils/stack-aws-scope.js';
import { applyDocDBTagDiff, attachDocDBTags, isDocDBNotFoundError } from './docdb-shared.js';

/**
 * The attribute map a DocumentDB DB cluster records (issue #3650), under
 * CloudFormation's `Fn::GetAtt` names (`Endpoint`, `Port`, `ReadEndpoint`,
 * `ClusterResourceId`). The RDS-style dotted keys (`Endpoint.Address`, ...)
 * are kept for records and readers that already use them; no
 * `Fn::GetAtt` names them for this service, so on their own they left
 * `Fn::GetAtt [Cluster, Endpoint]` resolving to the cluster identifier.
 */
function clusterAttributes(
  cluster:
    | {
        Endpoint?: string | undefined;
        Port?: number | undefined;
        ReaderEndpoint?: string | undefined;
        DBClusterArn?: string | undefined;
        DbClusterResourceId?: string | undefined;
      }
    | undefined
): Record<string, unknown> {
  return definedAttributes({
    Endpoint: cluster?.Endpoint,
    Port: stringifyIfAssigned(cluster?.Port),
    ReadEndpoint: cluster?.ReaderEndpoint,
    'Endpoint.Address': cluster?.Endpoint,
    'Endpoint.Port': stringifyIfAssigned(cluster?.Port),
    'ReadEndpoint.Address': cluster?.ReaderEndpoint,
    Arn: cluster?.DBClusterArn,
    ClusterResourceId: cluster?.DbClusterResourceId,
  });
}

/**
 * The attribute map a DocumentDB DB instance records (issue #3650): `Endpoint` /
 * `Port` are CloudFormation's `Fn::GetAtt` names, the dotted keys are kept.
 */
function instanceAttributes(
  instance:
    | {
        Endpoint?: { Address?: string | undefined; Port?: number | undefined } | undefined;
        DBInstanceArn?: string | undefined;
      }
    | undefined
): Record<string, unknown> {
  return definedAttributes({
    Endpoint: instance?.Endpoint?.Address,
    Port: stringifyIfAssigned(instance?.Endpoint?.Port),
    'Endpoint.Address': instance?.Endpoint?.Address,
    'Endpoint.Port': stringifyIfAssigned(instance?.Endpoint?.Port),
    Arn: instance?.DBInstanceArn,
  });
}

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
 * across); see `rds-provider.ts` for the structural template.
 */
export class DocDBProvider implements ResourceProvider {
  private docdbClient?: DocDBClient;
  private readonly providerRegion = ambientRegion();
  private logger = getLogger().child('DocDBProvider');

  /**
   * `AWS::DocDB::DBCluster` and `AWS::DocDB::DBInstance` are
   * `ProvisioningType: NON_PROVISIONABLE` — Cloud Control has no handlers for
   * them — so the #614 silent-drop auto-route must not send a template using
   * an unhandled property (`EnableCloudwatchLogsExports`, `StorageType`,
   * `CACertificateIdentifier`, ...) to CC, where it fails mid-deploy with an
   * opaque UnsupportedActionException. With this opt-out the registry refuses
   * such a template pre-flight (issue #3866).
   *
   * The flag is per PROVIDER, which is why `AWS::DocDB::DBSubnetGroup` — a
   * type Cloud Control CAN manage — lives in `DocDBSubnetGroupProvider`, keeping
   * its Cloud Control route. Do not register it on this class again.
   */
  readonly disableCcApiFallback = true;

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
      ]),
    ],
  ]);

  private getClient(): DocDBClient {
    if (!this.docdbClient) {
      this.docdbClient = new DocDBClient({
        ...ambientClientDefaults(),
        ...(this.providerRegion ? { region: this.providerRegion } : {}),
      });
    }
    return this.docdbClient;
  }

  // ─── Dispatch ─────────────────────────────────────────────────────

  async create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
  ): Promise<ResourceCreateResult> {
    switch (resourceType) {
      case 'AWS::DocDB::DBCluster':
        return this.createDBCluster(logicalId, resourceType, properties);
      case 'AWS::DocDB::DBInstance':
        return this.createDBInstance(logicalId, resourceType, properties);
      default:
        throw new ProvisioningError(
          `Unsupported resource type: ${resourceType}`,
          resourceType,
          logicalId
        );
    }
  }

  async update(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>
  ): Promise<ResourceUpdateResult> {
    switch (resourceType) {
      case 'AWS::DocDB::DBCluster':
        return this.updateDBCluster(
          logicalId,
          physicalId,
          resourceType,
          properties,
          previousProperties
        );
      case 'AWS::DocDB::DBInstance':
        return this.updateDBInstance(
          logicalId,
          physicalId,
          resourceType,
          properties,
          previousProperties
        );
      default:
        throw new ProvisioningError(
          `Unsupported resource type: ${resourceType}`,
          resourceType,
          logicalId,
          physicalId
        );
    }
  }

  async delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    _properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void> {
    switch (resourceType) {
      case 'AWS::DocDB::DBCluster':
        return this.deleteDBCluster(logicalId, physicalId, resourceType, context);
      case 'AWS::DocDB::DBInstance':
        return this.deleteDBInstance(logicalId, physicalId, resourceType, context);
      default:
        throw new ProvisioningError(
          `Unsupported resource type: ${resourceType}`,
          resourceType,
          logicalId,
          physicalId
        );
    }
  }

  // ─── DBCluster ────────────────────────────────────────────────────

  private async createDBCluster(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
  ): Promise<ResourceCreateResult> {
    this.logger.debug(`Creating DocDB DBCluster ${logicalId}`);

    const dbClusterIdentifier =
      (properties['DBClusterIdentifier'] as string | undefined) ||
      generateResourceName(logicalId, { maxLength: 63, lowercase: true });

    try {
      const tags = this.buildTags(properties);

      const response = await this.getClient().send(
        new CreateDBClusterCommand({
          DBClusterIdentifier: dbClusterIdentifier,
          // DocDB engine value is fixed: only `docdb` is accepted.
          Engine: 'docdb',
          EngineVersion: properties['EngineVersion'] as string | undefined,
          MasterUsername: properties['MasterUsername'] as string | undefined,
          MasterUserPassword: properties['MasterUserPassword'] as string | undefined,
          Port: properties['Port'] != null ? Number(properties['Port']) : undefined,
          VpcSecurityGroupIds: properties['VpcSecurityGroupIds'] as string[] | undefined,
          DBSubnetGroupName: properties['DBSubnetGroupName'] as string | undefined,
          StorageEncrypted: properties['StorageEncrypted'] as boolean | undefined,
          KmsKeyId: properties['KmsKeyId'] as string | undefined,
          BackupRetentionPeriod:
            properties['BackupRetentionPeriod'] != null
              ? Number(properties['BackupRetentionPeriod'])
              : undefined,
          PreferredBackupWindow: properties['PreferredBackupWindow'] as string | undefined,
          PreferredMaintenanceWindow: properties['PreferredMaintenanceWindow'] as
            | string
            | undefined,
          DBClusterParameterGroupName: properties['DBClusterParameterGroupName'] as
            | string
            | undefined,
          DeletionProtection: properties['DeletionProtection'] as boolean | undefined,
          ...(tags.length > 0 && { Tags: tags }),
        })
      );

      const cluster = response.DBCluster;
      if (!cluster) {
        throw new Error('CreateDBCluster did not return DBCluster');
      }

      this.logger.debug(
        `Successfully created DocDB DBCluster ${logicalId}: ${dbClusterIdentifier}`
      );

      // Wait for cluster to become available (skip with --no-wait)
      if (process.env['CDKD_NO_WAIT'] !== 'true') {
        await this.waitForClusterAvailable(dbClusterIdentifier);
      }

      // Describe to get final attributes
      const described = await this.describeDBCluster(dbClusterIdentifier);

      return {
        physicalId: dbClusterIdentifier,
        attributes: clusterAttributes(described),
      };
    } catch (error) {
      if (error instanceof ProvisioningError) throw error;
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to create DocDB DBCluster ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        dbClusterIdentifier,
        cause
      );
    }
  }

  private async updateDBCluster(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>
  ): Promise<ResourceUpdateResult> {
    this.logger.debug(`Updating DocDB DBCluster ${logicalId}: ${physicalId}`);

    try {
      // Class 2 — `VpcSecurityGroupIds: []` would CLEAR all SGs on the
      // cluster. readCurrentState always-emits `[]` for clusters that
      // legitimately have no VPC SGs; the round-trip must NOT translate
      // that placeholder into a destructive SDK call.
      const vpcSgIds = properties['VpcSecurityGroupIds'] as string[] | undefined;
      const sendVpcSgIds = vpcSgIds !== undefined && vpcSgIds.length > 0;

      // #1160 reset-on-removal — ModifyDBCluster has merge semantics (an
      // absent input field means "no change"), so a property REMOVED from
      // the template must be sent as its explicit CFn-default reset value
      // via `clearOnUpdateRemoval` (see the helper's JSDoc). Deliberately
      // NOT reset here:
      //   * EngineVersion — removal would imply moving to the engine's
      //     default version, a risky (possibly major) version change cdkd
      //     must not synthesize; leave unchanged.
      //   * DBClusterParameterGroupName — the default is the
      //     engine-version-dependent `default.docdb5.0`-style family name;
      //     synthesizing it from a removal risks a wrong-family apply.
      //   * PreferredBackupWindow / PreferredMaintenanceWindow — AWS assigns
      //     a RANDOM window at create; there is no documented "reset to
      //     random" sentinel.
      //   * MasterUserPassword — a secret; removal cannot synthesize a
      //     reset value.
      //   * VpcSecurityGroupIds — deliberate empty-guard above
      //     (readCurrentState placeholder defense); classified UNCERTAIN in
      //     the #1160 audit, out of this batch's scope.
      //   * Port — DocDB documents a fixed default (27017), but resetting
      //     the port is connection-breaking for every client; leave unchanged.
      await this.getClient().send(
        new ModifyDBClusterCommand({
          DBClusterIdentifier: physicalId,
          EngineVersion: properties['EngineVersion'] as string | undefined,
          // CFn default: deletion protection isn't enabled by default
          // (live-verified 2026-07-27: a cluster created without the field
          // reads DeletionProtection=false).
          DeletionProtection: clearOnUpdateRemoval(
            properties['DeletionProtection'] as boolean | undefined,
            previousProperties['DeletionProtection'] as boolean | undefined,
            false
          ),
          // CFn/API default: 1 day (ModifyDBClusterMessage doc).
          BackupRetentionPeriod: clearOnUpdateRemoval(
            properties['BackupRetentionPeriod'] != null
              ? Number(properties['BackupRetentionPeriod'])
              : undefined,
            previousProperties['BackupRetentionPeriod'] != null
              ? Number(previousProperties['BackupRetentionPeriod'])
              : undefined,
            1
          ),
          PreferredBackupWindow: properties['PreferredBackupWindow'] as string | undefined,
          PreferredMaintenanceWindow: properties['PreferredMaintenanceWindow'] as
            | string
            | undefined,
          DBClusterParameterGroupName: properties['DBClusterParameterGroupName'] as
            | string
            | undefined,
          ...(sendVpcSgIds && { VpcSecurityGroupIds: vpcSgIds }),
          MasterUserPassword: properties['MasterUserPassword'] as string | undefined,
          Port: properties['Port'] != null ? Number(properties['Port']) : undefined,
          ApplyImmediately: true,
        })
      );

      this.logger.debug(`Successfully updated DocDB DBCluster ${logicalId}`);

      const described = await this.describeDBCluster(physicalId);

      if (described?.DBClusterArn) {
        await applyDocDBTagDiff(
          this.getClient(),
          this.logger,
          described.DBClusterArn,
          previousProperties['Tags'] as Array<{ Key?: string; Value?: string }> | undefined,
          properties['Tags'] as Array<{ Key?: string; Value?: string }> | undefined
        );
      }

      return {
        physicalId,
        wasReplaced: false,
        attributes: clusterAttributes(described),
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to update DocDB DBCluster ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  private async deleteDBCluster(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    context?: DeleteContext
  ): Promise<void> {
    this.logger.debug(`Deleting DocDB DBCluster ${logicalId}: ${physicalId}`);

    try {
      // `--remove-protection`: flip DeletionProtection off in-place
      // before delete. Idempotent — DocDB accepts the call when protection
      // is already disabled. Non-fatal: log at debug if the flip-off
      // errors (e.g. NotFound) so the actual delete still proceeds.
      if (context?.removeProtection === true) {
        try {
          await this.getClient().send(
            new ModifyDBClusterCommand({
              DBClusterIdentifier: physicalId,
              DeletionProtection: false,
              ApplyImmediately: true,
            })
          );
          this.logger.debug(
            `Disabled DeletionProtection on DocDB DBCluster ${logicalId} before delete`
          );
        } catch (disableError) {
          if (!isDocDBNotFoundError(disableError, 'DBClusterNotFoundFault')) {
            this.logger.debug(
              `Could not disable deletion protection for ${physicalId}: ${describeAwsFailure(disableError).detail}`
            );
          }
        }
      }

      // `DeletionPolicy: Snapshot` (issue #1352): flip to the atomic
      // final-snapshot delete when the destroy call site passed an id.
      const finalSnapshotId = context?.finalSnapshotIdentifier;
      await this.getClient().send(
        new DeleteDBClusterCommand({
          DBClusterIdentifier: physicalId,
          ...(finalSnapshotId
            ? { SkipFinalSnapshot: false, FinalDBSnapshotIdentifier: finalSnapshotId }
            : { SkipFinalSnapshot: true }),
        })
      );
      if (finalSnapshotId) {
        this.logger.info(
          `Deleting DocDB DBCluster ${logicalId} with final snapshot ${finalSnapshotId} (DeletionPolicy: Snapshot)`
        );
      }

      this.logger.debug(`Successfully initiated deletion of DocDB DBCluster ${logicalId}`);

      // Wait for cluster to be fully deleted
      await this.waitForClusterDeleted(physicalId);
    } catch (error) {
      if (isDocDBNotFoundError(error, 'DBClusterNotFoundFault')) {
        const clientRegion = await this.getClient().config.region();
        assertRegionMatch(
          clientRegion,
          context?.expectedRegion,
          resourceType,
          logicalId,
          physicalId
        );
        this.logger.debug(`DocDB DBCluster ${physicalId} does not exist, skipping deletion`);
        return;
      }
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to delete DocDB DBCluster ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  // ─── DBInstance ───────────────────────────────────────────────────

  private async createDBInstance(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
  ): Promise<ResourceCreateResult> {
    this.logger.debug(`Creating DocDB DBInstance ${logicalId}`);

    const dbInstanceIdentifier =
      (properties['DBInstanceIdentifier'] as string | undefined) ||
      generateResourceName(logicalId, { maxLength: 63, lowercase: true });

    try {
      const tags = this.buildTags(properties);

      const response = await this.getClient().send(
        new CreateDBInstanceCommand({
          DBInstanceIdentifier: dbInstanceIdentifier,
          DBInstanceClass: properties['DBInstanceClass'] as string,
          // DocDB engine value is fixed: only `docdb` is accepted.
          Engine: 'docdb',
          DBClusterIdentifier: properties['DBClusterIdentifier'] as string,
          AvailabilityZone: properties['AvailabilityZone'] as string | undefined,
          PreferredMaintenanceWindow: properties['PreferredMaintenanceWindow'] as
            | string
            | undefined,
          AutoMinorVersionUpgrade: properties['AutoMinorVersionUpgrade'] as boolean | undefined,
          ...(tags.length > 0 && { Tags: tags }),
        })
      );

      const instance = response.DBInstance;
      if (!instance) {
        throw new Error('CreateDBInstance did not return DBInstance');
      }

      this.logger.debug(
        `Successfully created DocDB DBInstance ${logicalId}: ${dbInstanceIdentifier}`
      );

      // Wait for instance to become available (skip with --no-wait)
      if (process.env['CDKD_NO_WAIT'] !== 'true') {
        await this.waitForInstanceAvailable(dbInstanceIdentifier);
      }

      const described = await this.describeDBInstance(dbInstanceIdentifier);

      return {
        physicalId: dbInstanceIdentifier,
        attributes: instanceAttributes(described),
      };
    } catch (error) {
      if (error instanceof ProvisioningError) throw error;
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to create DocDB DBInstance ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        dbInstanceIdentifier,
        cause
      );
    }
  }

  private async updateDBInstance(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>
  ): Promise<ResourceUpdateResult> {
    this.logger.debug(`Updating DocDB DBInstance ${logicalId}: ${physicalId}`);

    try {
      // #1160 reset-on-removal — ModifyDBInstance has merge semantics, but
      // every optional DocDB instance field is deliberately NOT reset:
      //   * AutoMinorVersionUpgrade — inert on DocDB (ModifyDBInstanceMessage
      //     doc: "This parameter does not apply to Amazon DocumentDB.
      //     Amazon DocumentDB does not perform minor version upgrades
      //     regardless of the value set"); synthesizing a reset would close
      //     no behavioral divergence.
      //   * PreferredMaintenanceWindow — AWS assigns a RANDOM window at
      //     create; no documented "reset to random" sentinel.
      await this.getClient().send(
        new ModifyDBInstanceCommand({
          DBInstanceIdentifier: physicalId,
          DBInstanceClass: properties['DBInstanceClass'] as string | undefined,
          PreferredMaintenanceWindow: properties['PreferredMaintenanceWindow'] as
            | string
            | undefined,
          AutoMinorVersionUpgrade: properties['AutoMinorVersionUpgrade'] as boolean | undefined,
          ApplyImmediately: true,
        })
      );

      this.logger.debug(`Successfully updated DocDB DBInstance ${logicalId}`);

      const described = await this.describeDBInstance(physicalId);

      if (described?.DBInstanceArn) {
        await applyDocDBTagDiff(
          this.getClient(),
          this.logger,
          described.DBInstanceArn,
          previousProperties['Tags'] as Array<{ Key?: string; Value?: string }> | undefined,
          properties['Tags'] as Array<{ Key?: string; Value?: string }> | undefined
        );
      }

      return {
        physicalId,
        wasReplaced: false,
        attributes: instanceAttributes(described),
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to update DocDB DBInstance ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  private async deleteDBInstance(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    context?: DeleteContext
  ): Promise<void> {
    this.logger.debug(`Deleting DocDB DBInstance ${logicalId}: ${physicalId}`);

    // DocDB DBInstance does NOT have its own DeletionProtection field
    // (only the cluster does). `--remove-protection` is therefore a no-op
    // here — the existing delete logic runs unchanged. The cluster-level
    // bypass on DBCluster handles the "protect against accidental delete"
    // intent for instances inside a protected cluster.

    try {
      await this.getClient().send(
        new DeleteDBInstanceCommand({
          DBInstanceIdentifier: physicalId,
        })
      );

      this.logger.debug(`Successfully initiated deletion of DocDB DBInstance ${logicalId}`);

      // Wait for instance to be fully deleted
      await this.waitForInstanceDeleted(physicalId);
    } catch (error) {
      if (isDocDBNotFoundError(error, 'DBInstanceNotFoundFault')) {
        const clientRegion = await this.getClient().config.region();
        assertRegionMatch(
          clientRegion,
          context?.expectedRegion,
          resourceType,
          logicalId,
          physicalId
        );
        this.logger.debug(`DocDB DBInstance ${physicalId} does not exist, skipping deletion`);
        return;
      }
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to delete DocDB DBInstance ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  // ─── Helpers ──────────────────────────────────────────────────────

  private buildTags(properties: Record<string, unknown>): Array<{ Key: string; Value: string }> {
    if (!properties['Tags']) return [];
    return properties['Tags'] as Array<{ Key: string; Value: string }>;
  }

  private async describeDBCluster(dbClusterIdentifier: string) {
    const response = await this.getClient().send(
      new DescribeDBClustersCommand({
        DBClusterIdentifier: dbClusterIdentifier,
      })
    );
    return response.DBClusters?.[0];
  }

  private async describeDBInstance(dbInstanceIdentifier: string) {
    const response = await this.getClient().send(
      new DescribeDBInstancesCommand({
        DBInstanceIdentifier: dbInstanceIdentifier,
      })
    );
    return response.DBInstances?.[0];
  }

  /**
   * Wait for a DBCluster to become available. DocDB's SDK does not ship a
   * `waitUntilDBClusterAvailable` waiter (only DBInstance has waiters),
   * so we poll Status manually with exponential backoff.
   */
  private async waitForClusterAvailable(
    dbClusterIdentifier: string,
    maxWaitMs = 1_800_000
  ): Promise<void> {
    const startTime = Date.now();
    let delay = 5_000;

    while (Date.now() - startTime < maxWaitMs) {
      const cluster = await this.describeDBCluster(dbClusterIdentifier);
      const status = cluster?.Status;

      this.logger.debug(`DocDB DBCluster ${dbClusterIdentifier} status: ${status}`);

      if (status === 'available') return;

      await this.sleep(delay);
      delay = Math.min(delay * 2, 10_000);
    }

    throw new Error(
      `Timed out waiting for DocDB DBCluster ${dbClusterIdentifier} to become available`
    );
  }

  /**
   * Wait for a DBCluster to be deleted (no SDK waiter — manual poll).
   */
  private async waitForClusterDeleted(
    dbClusterIdentifier: string,
    maxWaitMs = 1_800_000
  ): Promise<void> {
    const startTime = Date.now();
    let delay = 5_000;

    while (Date.now() - startTime < maxWaitMs) {
      try {
        const cluster = await this.describeDBCluster(dbClusterIdentifier);
        const status = cluster?.Status;

        this.logger.debug(`DocDB DBCluster ${dbClusterIdentifier} status: ${status}`);

        if (!cluster) return;
      } catch (error) {
        if (isDocDBNotFoundError(error, 'DBClusterNotFoundFault')) {
          return;
        }
        throw error;
      }

      await this.sleep(delay);
      delay = Math.min(delay * 2, 10_000);
    }

    throw new Error(`Timed out waiting for DocDB DBCluster ${dbClusterIdentifier} to be deleted`);
  }

  /**
   * Wait for a DBInstance to become available (manual poll — matches RDS).
   */
  private async waitForInstanceAvailable(
    dbInstanceIdentifier: string,
    maxWaitMs = 1_800_000
  ): Promise<void> {
    const startTime = Date.now();
    let delay = 10_000;

    while (Date.now() - startTime < maxWaitMs) {
      const instance = await this.describeDBInstance(dbInstanceIdentifier);
      const status = instance?.DBInstanceStatus;

      this.logger.debug(`DocDB DBInstance ${dbInstanceIdentifier} status: ${status}`);

      if (status === 'available') return;

      await this.sleep(delay);
      delay = Math.min(delay * 2, 10_000);
    }

    throw new Error(
      `Timed out waiting for DocDB DBInstance ${dbInstanceIdentifier} to become available`
    );
  }

  private async waitForInstanceDeleted(
    dbInstanceIdentifier: string,
    maxWaitMs = 1_800_000
  ): Promise<void> {
    const startTime = Date.now();
    let delay = 10_000;

    while (Date.now() - startTime < maxWaitMs) {
      try {
        const instance = await this.describeDBInstance(dbInstanceIdentifier);
        const status = instance?.DBInstanceStatus;

        this.logger.debug(`DocDB DBInstance ${dbInstanceIdentifier} status: ${status}`);

        if (!instance) return;
      } catch (error) {
        if (isDocDBNotFoundError(error, 'DBInstanceNotFoundFault')) {
          return;
        }
        throw error;
      }

      await this.sleep(delay);
      delay = Math.min(delay * 2, 10_000);
    }

    throw new Error(`Timed out waiting for DocDB DBInstance ${dbInstanceIdentifier} to be deleted`);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Adopt an existing DocDB resource into cdkd state.
   *
   * Supported types: `AWS::DocDB::DBInstance`, `AWS::DocDB::DBCluster`.
   * Identifier name properties (`DBInstanceIdentifier` /
   * `DBClusterIdentifier`) are usually
   * present in CDK templates and are resolved via the corresponding
   * `Describe*` existence check. There is no `aws:cdk:path` tag fallback:
   * AWS rejects `aws:`-prefixed tag writes, so that tag never exists on a
   * real resource and the walk could not match (issue #1134).
   */
  async import(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    switch (input.resourceType) {
      case 'AWS::DocDB::DBInstance':
        return this.importDBInstance(input);
      case 'AWS::DocDB::DBCluster':
        return this.importDBCluster(input);
      default:
        return null;
    }
  }

  /**
   * Read the AWS-current DocDB resource configuration in CFn-property shape.
   *
   * Each branch surfaces only the keys cdkd's `create()` accepts. Sensitive
   * fields like `MasterUserPassword` are NEVER surfaced (DocDB does not
   * return them in the Describe responses). `Tags` are surfaced via a
   * follow-up `ListTagsForResource(ResourceName=arn)` call.
   *
   * Returns `undefined` when the resource is gone (`*NotFoundFault`).
   */
  async readCurrentState(
    physicalId: string,
    _logicalId: string,
    resourceType: string
  ): Promise<Record<string, unknown> | undefined> {
    switch (resourceType) {
      case 'AWS::DocDB::DBInstance':
        return this.readCurrentStateDBInstance(physicalId);
      case 'AWS::DocDB::DBCluster':
        return this.readCurrentStateDBCluster(physicalId);
      default:
        return undefined;
    }
  }

  private async readCurrentStateDBInstance(
    physicalId: string
  ): Promise<Record<string, unknown> | undefined> {
    let inst;
    try {
      inst = await this.describeDBInstance(physicalId);
    } catch (err) {
      if (isDocDBNotFoundError(err, 'DBInstanceNotFoundFault')) return undefined;
      throw err;
    }
    if (!inst) return undefined;

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
    if (inst.DBInstanceArn)
      await attachDocDBTags(this.getClient(), this.logger, result, inst.DBInstanceArn);
    return result;
  }

  private async readCurrentStateDBCluster(
    physicalId: string
  ): Promise<Record<string, unknown> | undefined> {
    let cluster;
    try {
      cluster = await this.describeDBCluster(physicalId);
    } catch (err) {
      if (isDocDBNotFoundError(err, 'DBClusterNotFoundFault')) return undefined;
      throw err;
    }
    if (!cluster) return undefined;

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
    if (cluster.DBClusterArn)
      await attachDocDBTags(this.getClient(), this.logger, result, cluster.DBClusterArn);
    return result;
  }

  private async importDBInstance(input: ResourceImportInput): Promise<ResourceImportResult | null> {
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
          attributes: instanceAttributes(described),
        };
      } catch (err) {
        if ((err as { name?: string }).name === 'DBInstanceNotFoundFault') return null;
        throw err;
      }
    }
    // No `aws:cdk:path` tag walk: the tag never exists on a real resource
    // (issue #1134). A DBInstance reaching here needs an explicit `--resource`
    // override or a `DBInstanceIdentifier` in the template.
    return null;
  }

  private async importDBCluster(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    const explicit = resolveExplicitPhysicalId(input, 'DBClusterIdentifier');
    if (explicit) {
      try {
        const resp = await this.getClient().send(
          new DescribeDBClustersCommand({ DBClusterIdentifier: explicit })
        );
        // Issue #3627: the same map `create()` records.
        return { physicalId: explicit, attributes: clusterAttributes(resp.DBClusters?.[0]) };
      } catch (err) {
        if ((err as { name?: string }).name === 'DBClusterNotFoundFault') return null;
        throw err;
      }
    }
    // No `aws:cdk:path` tag walk: the tag never exists on a real resource
    // (issue #1134). A DBCluster reaching here needs an explicit `--resource`
    // override or a `DBClusterIdentifier` in the template.
    return null;
  }
}
