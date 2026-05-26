import {
  NeptuneClient,
  CreateDBClusterCommand,
  DeleteDBClusterCommand,
  ModifyDBClusterCommand,
  DescribeDBClustersCommand,
  CreateDBInstanceCommand,
  DeleteDBInstanceCommand,
  ModifyDBInstanceCommand,
  DescribeDBInstancesCommand,
  CreateDBSubnetGroupCommand,
  DeleteDBSubnetGroupCommand,
  DescribeDBSubnetGroupsCommand,
  ModifyDBSubnetGroupCommand,
  ListTagsForResourceCommand,
  AddTagsToResourceCommand,
  RemoveTagsFromResourceCommand,
} from '@aws-sdk/client-neptune';
import { getLogger } from '../../utils/logger.js';
import { ProvisioningError } from '../../utils/error-handler.js';
import { assertRegionMatch, type DeleteContext } from '../region-check.js';
import { generateResourceName } from '../resource-name.js';
import {
  matchesCdkPath,
  normalizeAwsTagsToCfn,
  resolveExplicitPhysicalId,
} from '../import-helpers.js';
import type {
  ResourceProvider,
  ResourceCreateResult,
  ResourceUpdateResult,
  ResourceImportInput,
  ResourceImportResult,
} from '../../types/resource.js';

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
 * them across); see `rds-provider.ts` for the structural template.
 */
export class NeptuneProvider implements ResourceProvider {
  private neptuneClient?: NeptuneClient;
  private readonly providerRegion = process.env['AWS_REGION'];
  private logger = getLogger().child('NeptuneProvider');

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
      ]),
    ],
  ]);

  private getClient(): NeptuneClient {
    if (!this.neptuneClient) {
      this.neptuneClient = new NeptuneClient(
        this.providerRegion ? { region: this.providerRegion } : {}
      );
    }
    return this.neptuneClient;
  }

  // ─── Dispatch ─────────────────────────────────────────────────────

  async create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
  ): Promise<ResourceCreateResult> {
    switch (resourceType) {
      case 'AWS::Neptune::DBSubnetGroup':
        return this.createDBSubnetGroup(logicalId, resourceType, properties);
      case 'AWS::Neptune::DBCluster':
        return this.createDBCluster(logicalId, resourceType, properties);
      case 'AWS::Neptune::DBInstance':
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
      case 'AWS::Neptune::DBSubnetGroup':
        return this.updateDBSubnetGroup(
          logicalId,
          physicalId,
          resourceType,
          properties,
          previousProperties
        );
      case 'AWS::Neptune::DBCluster':
        return this.updateDBCluster(
          logicalId,
          physicalId,
          resourceType,
          properties,
          previousProperties
        );
      case 'AWS::Neptune::DBInstance':
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
      case 'AWS::Neptune::DBSubnetGroup':
        return this.deleteDBSubnetGroup(logicalId, physicalId, resourceType, context);
      case 'AWS::Neptune::DBCluster':
        return this.deleteDBCluster(logicalId, physicalId, resourceType, context);
      case 'AWS::Neptune::DBInstance':
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

  // ─── DBSubnetGroup ────────────────────────────────────────────────

  private async createDBSubnetGroup(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
  ): Promise<ResourceCreateResult> {
    this.logger.debug(`Creating Neptune DBSubnetGroup ${logicalId}`);

    const dbSubnetGroupName =
      (properties['DBSubnetGroupName'] as string | undefined) ||
      generateResourceName(logicalId, { maxLength: 255, lowercase: true });

    try {
      const tags = this.buildTags(properties);

      await this.getClient().send(
        new CreateDBSubnetGroupCommand({
          DBSubnetGroupName: dbSubnetGroupName,
          DBSubnetGroupDescription:
            (properties['DBSubnetGroupDescription'] as string) || `Subnet group for ${logicalId}`,
          SubnetIds: properties['SubnetIds'] as string[],
          ...(tags.length > 0 && { Tags: tags }),
        })
      );

      this.logger.debug(
        `Successfully created Neptune DBSubnetGroup ${logicalId}: ${dbSubnetGroupName}`
      );

      return {
        physicalId: dbSubnetGroupName,
        attributes: {
          DBSubnetGroupName: dbSubnetGroupName,
        },
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to create Neptune DBSubnetGroup ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        dbSubnetGroupName,
        cause
      );
    }
  }

  private async updateDBSubnetGroup(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>
  ): Promise<ResourceUpdateResult> {
    this.logger.debug(`Updating Neptune DBSubnetGroup ${logicalId}: ${physicalId}`);

    try {
      // Class 2 — `SubnetIds: []` would be rejected by AWS as a
      // structurally invalid input (DBSubnetGroup requires ≥ 2 subnets in
      // distinct AZs). Skip the field when empty so description-only
      // updates work.
      const subnetIds = properties['SubnetIds'] as string[] | undefined;
      const sendSubnetIds = subnetIds !== undefined && subnetIds.length > 0;
      const modifyInput = {
        DBSubnetGroupName: physicalId,
        DBSubnetGroupDescription: properties['DBSubnetGroupDescription'] as string | undefined,
        ...(sendSubnetIds && { SubnetIds: subnetIds }),
      } as ConstructorParameters<typeof ModifyDBSubnetGroupCommand>[0];
      await this.getClient().send(new ModifyDBSubnetGroupCommand(modifyInput));

      const desc = await this.getClient().send(
        new DescribeDBSubnetGroupsCommand({ DBSubnetGroupName: physicalId })
      );
      const arn = desc.DBSubnetGroups?.[0]?.DBSubnetGroupArn;
      if (arn) {
        await this.applyTagDiff(
          arn,
          previousProperties['Tags'] as Array<{ Key?: string; Value?: string }> | undefined,
          properties['Tags'] as Array<{ Key?: string; Value?: string }> | undefined
        );
      }

      this.logger.debug(`Successfully updated Neptune DBSubnetGroup ${logicalId}`);

      return {
        physicalId,
        wasReplaced: false,
        attributes: {
          DBSubnetGroupName: physicalId,
        },
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to update Neptune DBSubnetGroup ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  private async deleteDBSubnetGroup(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    context?: DeleteContext
  ): Promise<void> {
    this.logger.debug(`Deleting Neptune DBSubnetGroup ${logicalId}: ${physicalId}`);

    try {
      await this.getClient().send(
        new DeleteDBSubnetGroupCommand({
          DBSubnetGroupName: physicalId,
        })
      );
      this.logger.debug(`Successfully deleted Neptune DBSubnetGroup ${logicalId}`);
    } catch (error) {
      if (this.isNotFoundError(error, 'DBSubnetGroupNotFoundFault')) {
        const clientRegion = await this.getClient().config.region();
        assertRegionMatch(
          clientRegion,
          context?.expectedRegion,
          resourceType,
          logicalId,
          physicalId
        );
        this.logger.debug(`Neptune DBSubnetGroup ${physicalId} does not exist, skipping deletion`);
        return;
      }
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to delete Neptune DBSubnetGroup ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  // ─── DBCluster ────────────────────────────────────────────────────

  private async createDBCluster(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
  ): Promise<ResourceCreateResult> {
    this.logger.debug(`Creating Neptune DBCluster ${logicalId}`);

    const dbClusterIdentifier =
      (properties['DBClusterIdentifier'] as string | undefined) ||
      generateResourceName(logicalId, { maxLength: 63, lowercase: true });

    try {
      const tags = this.buildTags(properties);

      const response = await this.getClient().send(
        new CreateDBClusterCommand({
          DBClusterIdentifier: dbClusterIdentifier,
          // Neptune engine value is fixed: only `neptune` is accepted.
          Engine: 'neptune',
          EngineVersion: properties['EngineVersion'] as string | undefined,
          // CFn schema's writable port field is `DBPort`; `Port` is readOnly
          // in the schema but older CDK versions emit it. Prefer DBPort, fall
          // back to Port for backward compat.
          Port:
            properties['DBPort'] != null
              ? Number(properties['DBPort'])
              : properties['Port'] != null
                ? Number(properties['Port'])
                : undefined,
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
          EnableIAMDatabaseAuthentication: properties['IamAuthEnabled'] as boolean | undefined,
          DeletionProtection: properties['DeletionProtection'] as boolean | undefined,
          ...(tags.length > 0 && { Tags: tags }),
        })
      );

      const cluster = response.DBCluster;
      if (!cluster) {
        throw new Error('CreateDBCluster did not return DBCluster');
      }

      this.logger.debug(
        `Successfully created Neptune DBCluster ${logicalId}: ${dbClusterIdentifier}`
      );

      // Wait for cluster to become available (skip with --no-wait)
      if (process.env['CDKD_NO_WAIT'] !== 'true') {
        await this.waitForClusterAvailable(dbClusterIdentifier);
      }

      const described = await this.describeDBCluster(dbClusterIdentifier);

      return {
        physicalId: dbClusterIdentifier,
        attributes: {
          'Endpoint.Address': described?.Endpoint ?? '',
          'Endpoint.Port': String(described?.Port ?? ''),
          'ReadEndpoint.Address': described?.ReaderEndpoint ?? '',
          ClusterResourceId: described?.DbClusterResourceId ?? '',
        },
      };
    } catch (error) {
      if (error instanceof ProvisioningError) throw error;
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to create Neptune DBCluster ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
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
    this.logger.debug(`Updating Neptune DBCluster ${logicalId}: ${physicalId}`);

    try {
      // Class 2 — `VpcSecurityGroupIds: []` would CLEAR all SGs on the
      // cluster. readCurrentState always-emits `[]` for clusters that
      // legitimately have no VPC SGs; the round-trip must NOT translate
      // that placeholder into a destructive SDK call.
      const vpcSgIds = properties['VpcSecurityGroupIds'] as string[] | undefined;
      const sendVpcSgIds = vpcSgIds !== undefined && vpcSgIds.length > 0;

      await this.getClient().send(
        new ModifyDBClusterCommand({
          DBClusterIdentifier: physicalId,
          EngineVersion: properties['EngineVersion'] as string | undefined,
          DeletionProtection: properties['DeletionProtection'] as boolean | undefined,
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
          EnableIAMDatabaseAuthentication: properties['IamAuthEnabled'] as boolean | undefined,
          ...(sendVpcSgIds && { VpcSecurityGroupIds: vpcSgIds }),
          Port:
            properties['DBPort'] != null
              ? Number(properties['DBPort'])
              : properties['Port'] != null
                ? Number(properties['Port'])
                : undefined,
          ApplyImmediately: true,
        })
      );

      this.logger.debug(`Successfully updated Neptune DBCluster ${logicalId}`);

      const described = await this.describeDBCluster(physicalId);

      if (described?.DBClusterArn) {
        await this.applyTagDiff(
          described.DBClusterArn,
          previousProperties['Tags'] as Array<{ Key?: string; Value?: string }> | undefined,
          properties['Tags'] as Array<{ Key?: string; Value?: string }> | undefined
        );
      }

      return {
        physicalId,
        wasReplaced: false,
        attributes: {
          'Endpoint.Address': described?.Endpoint ?? '',
          'Endpoint.Port': String(described?.Port ?? ''),
          'ReadEndpoint.Address': described?.ReaderEndpoint ?? '',
          ClusterResourceId: described?.DbClusterResourceId ?? '',
        },
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to update Neptune DBCluster ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
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
    this.logger.debug(`Deleting Neptune DBCluster ${logicalId}: ${physicalId}`);

    try {
      // `--remove-protection`: flip DeletionProtection off in-place
      // before delete. Idempotent — Neptune accepts the call when
      // protection is already disabled. Non-fatal: log at debug if the
      // flip-off errors (e.g. NotFound) so the actual delete still
      // proceeds.
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
            `Disabled DeletionProtection on Neptune DBCluster ${logicalId} before delete`
          );
        } catch (disableError) {
          if (!this.isNotFoundError(disableError, 'DBClusterNotFoundFault')) {
            this.logger.debug(
              `Could not disable deletion protection for ${physicalId}: ${disableError instanceof Error ? disableError.message : String(disableError)}`
            );
          }
        }
      }

      await this.getClient().send(
        new DeleteDBClusterCommand({
          DBClusterIdentifier: physicalId,
          SkipFinalSnapshot: true,
        })
      );

      this.logger.debug(`Successfully initiated deletion of Neptune DBCluster ${logicalId}`);

      // Wait for cluster to be fully deleted
      await this.waitForClusterDeleted(physicalId);
    } catch (error) {
      if (this.isNotFoundError(error, 'DBClusterNotFoundFault')) {
        const clientRegion = await this.getClient().config.region();
        assertRegionMatch(
          clientRegion,
          context?.expectedRegion,
          resourceType,
          logicalId,
          physicalId
        );
        this.logger.debug(`Neptune DBCluster ${physicalId} does not exist, skipping deletion`);
        return;
      }
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to delete Neptune DBCluster ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
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
    this.logger.debug(`Creating Neptune DBInstance ${logicalId}`);

    const dbInstanceIdentifier =
      (properties['DBInstanceIdentifier'] as string | undefined) ||
      generateResourceName(logicalId, { maxLength: 63, lowercase: true });

    try {
      const tags = this.buildTags(properties);

      const response = await this.getClient().send(
        new CreateDBInstanceCommand({
          DBInstanceIdentifier: dbInstanceIdentifier,
          DBInstanceClass: properties['DBInstanceClass'] as string,
          // Neptune engine value is fixed: only `neptune` is accepted.
          Engine: 'neptune',
          DBClusterIdentifier: properties['DBClusterIdentifier'] as string,
          DBSubnetGroupName: properties['DBSubnetGroupName'] as string | undefined,
          DBParameterGroupName: properties['DBParameterGroupName'] as string | undefined,
          AvailabilityZone: properties['AvailabilityZone'] as string | undefined,
          PreferredMaintenanceWindow: properties['PreferredMaintenanceWindow'] as
            | string
            | undefined,
          AutoMinorVersionUpgrade: properties['AutoMinorVersionUpgrade'] as boolean | undefined,
          DeletionProtection: properties['DeletionProtection'] as boolean | undefined,
          ...(tags.length > 0 && { Tags: tags }),
        })
      );

      const instance = response.DBInstance;
      if (!instance) {
        throw new Error('CreateDBInstance did not return DBInstance');
      }

      this.logger.debug(
        `Successfully created Neptune DBInstance ${logicalId}: ${dbInstanceIdentifier}`
      );

      // Wait for instance to become available (skip with --no-wait)
      if (process.env['CDKD_NO_WAIT'] !== 'true') {
        await this.waitForInstanceAvailable(dbInstanceIdentifier);
      }

      const described = await this.describeDBInstance(dbInstanceIdentifier);

      return {
        physicalId: dbInstanceIdentifier,
        attributes: {
          'Endpoint.Address': described?.Endpoint?.Address ?? '',
          'Endpoint.Port': String(described?.Endpoint?.Port ?? ''),
        },
      };
    } catch (error) {
      if (error instanceof ProvisioningError) throw error;
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to create Neptune DBInstance ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
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
    this.logger.debug(`Updating Neptune DBInstance ${logicalId}: ${physicalId}`);

    try {
      await this.getClient().send(
        new ModifyDBInstanceCommand({
          DBInstanceIdentifier: physicalId,
          DBInstanceClass: properties['DBInstanceClass'] as string | undefined,
          DBParameterGroupName: properties['DBParameterGroupName'] as string | undefined,
          PreferredMaintenanceWindow: properties['PreferredMaintenanceWindow'] as
            | string
            | undefined,
          AutoMinorVersionUpgrade: properties['AutoMinorVersionUpgrade'] as boolean | undefined,
          DeletionProtection: properties['DeletionProtection'] as boolean | undefined,
          ApplyImmediately: true,
        })
      );

      this.logger.debug(`Successfully updated Neptune DBInstance ${logicalId}`);

      const described = await this.describeDBInstance(physicalId);

      if (described?.DBInstanceArn) {
        await this.applyTagDiff(
          described.DBInstanceArn,
          previousProperties['Tags'] as Array<{ Key?: string; Value?: string }> | undefined,
          properties['Tags'] as Array<{ Key?: string; Value?: string }> | undefined
        );
      }

      return {
        physicalId,
        wasReplaced: false,
        attributes: {
          'Endpoint.Address': described?.Endpoint?.Address ?? '',
          'Endpoint.Port': String(described?.Endpoint?.Port ?? ''),
        },
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to update Neptune DBInstance ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
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
    this.logger.debug(`Deleting Neptune DBInstance ${logicalId}: ${physicalId}`);

    try {
      // `--remove-protection`: flip DeletionProtection off in-place
      // before delete. Neptune (unlike DocDB) supports per-instance
      // DeletionProtection. Idempotent — accepts the call when already
      // disabled.
      if (context?.removeProtection === true) {
        try {
          await this.getClient().send(
            new ModifyDBInstanceCommand({
              DBInstanceIdentifier: physicalId,
              DeletionProtection: false,
              ApplyImmediately: true,
            })
          );
          this.logger.debug(
            `Disabled DeletionProtection on Neptune DBInstance ${logicalId} before delete`
          );
        } catch (disableError) {
          if (!this.isNotFoundError(disableError, 'DBInstanceNotFoundFault')) {
            this.logger.debug(
              `Could not disable deletion protection for ${physicalId}: ${disableError instanceof Error ? disableError.message : String(disableError)}`
            );
          }
        }
      }

      await this.getClient().send(
        new DeleteDBInstanceCommand({
          DBInstanceIdentifier: physicalId,
          SkipFinalSnapshot: true,
        })
      );

      this.logger.debug(`Successfully initiated deletion of Neptune DBInstance ${logicalId}`);

      // Wait for instance to be fully deleted
      await this.waitForInstanceDeleted(physicalId);
    } catch (error) {
      if (this.isNotFoundError(error, 'DBInstanceNotFoundFault')) {
        const clientRegion = await this.getClient().config.region();
        assertRegionMatch(
          clientRegion,
          context?.expectedRegion,
          resourceType,
          logicalId,
          physicalId
        );
        this.logger.debug(`Neptune DBInstance ${physicalId} does not exist, skipping deletion`);
        return;
      }
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to delete Neptune DBInstance ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  // ─── Helpers ──────────────────────────────────────────────────────

  /**
   * Apply a diff between old and new CFn-shape Tags arrays via Neptune's
   * `AddTagsToResource` / `RemoveTagsFromResource` APIs (keyed by
   * `ResourceName=arn`).
   */
  private async applyTagDiff(
    arn: string,
    oldTagsRaw: Array<{ Key?: string; Value?: string }> | undefined,
    newTagsRaw: Array<{ Key?: string; Value?: string }> | undefined
  ): Promise<void> {
    const toMap = (
      tags: Array<{ Key?: string; Value?: string }> | undefined
    ): Map<string, string> => {
      const m = new Map<string, string>();
      for (const t of tags ?? []) {
        if (t.Key !== undefined && t.Value !== undefined) m.set(t.Key, t.Value);
      }
      return m;
    };

    const oldMap = toMap(oldTagsRaw);
    const newMap = toMap(newTagsRaw);

    const tagsToAdd: Array<{ Key: string; Value: string }> = [];
    for (const [k, v] of newMap) {
      if (oldMap.get(k) !== v) tagsToAdd.push({ Key: k, Value: v });
    }
    const tagsToRemove: string[] = [];
    for (const k of oldMap.keys()) {
      if (!newMap.has(k)) tagsToRemove.push(k);
    }

    if (tagsToRemove.length > 0) {
      await this.getClient().send(
        new RemoveTagsFromResourceCommand({ ResourceName: arn, TagKeys: tagsToRemove })
      );
      this.logger.debug(`Removed ${tagsToRemove.length} tag(s) from Neptune resource ${arn}`);
    }
    if (tagsToAdd.length > 0) {
      await this.getClient().send(
        new AddTagsToResourceCommand({ ResourceName: arn, Tags: tagsToAdd })
      );
      this.logger.debug(`Added/updated ${tagsToAdd.length} tag(s) on Neptune resource ${arn}`);
    }
  }

  private buildTags(properties: Record<string, unknown>): Array<{ Key: string; Value: string }> {
    if (!properties['Tags']) return [];
    return properties['Tags'] as Array<{ Key: string; Value: string }>;
  }

  private isNotFoundError(error: unknown, faultName: string): boolean {
    if (!(error instanceof Error)) return false;
    const name = (error as { name?: string }).name ?? '';
    const message = error.message.toLowerCase();
    return (
      name === faultName || message.includes('not found') || message.includes('does not exist')
    );
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
   * Wait for a DBCluster to become available (no SDK waiter — manual poll).
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

      this.logger.debug(`Neptune DBCluster ${dbClusterIdentifier} status: ${status}`);

      if (status === 'available') return;

      await this.sleep(delay);
      delay = Math.min(delay * 2, 30_000);
    }

    throw new Error(
      `Timed out waiting for Neptune DBCluster ${dbClusterIdentifier} to become available`
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

        this.logger.debug(`Neptune DBCluster ${dbClusterIdentifier} status: ${status}`);

        if (!cluster) return;
      } catch (error) {
        if (this.isNotFoundError(error, 'DBClusterNotFoundFault')) {
          return;
        }
        throw error;
      }

      await this.sleep(delay);
      delay = Math.min(delay * 2, 30_000);
    }

    throw new Error(`Timed out waiting for Neptune DBCluster ${dbClusterIdentifier} to be deleted`);
  }

  /**
   * Wait for a DBInstance to become available (manual poll).
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

      this.logger.debug(`Neptune DBInstance ${dbInstanceIdentifier} status: ${status}`);

      if (status === 'available') return;

      await this.sleep(delay);
      delay = Math.min(delay * 2, 30_000);
    }

    throw new Error(
      `Timed out waiting for Neptune DBInstance ${dbInstanceIdentifier} to become available`
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

        this.logger.debug(`Neptune DBInstance ${dbInstanceIdentifier} status: ${status}`);

        if (!instance) return;
      } catch (error) {
        if (this.isNotFoundError(error, 'DBInstanceNotFoundFault')) {
          return;
        }
        throw error;
      }

      await this.sleep(delay);
      delay = Math.min(delay * 2, 30_000);
    }

    throw new Error(
      `Timed out waiting for Neptune DBInstance ${dbInstanceIdentifier} to be deleted`
    );
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Adopt an existing Neptune resource into cdkd state.
   */
  async import(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    switch (input.resourceType) {
      case 'AWS::Neptune::DBInstance':
        return this.importDBInstance(input);
      case 'AWS::Neptune::DBCluster':
        return this.importDBCluster(input);
      case 'AWS::Neptune::DBSubnetGroup':
        return this.importDBSubnetGroup(input);
      default:
        return null;
    }
  }

  /**
   * Read the AWS-current Neptune resource configuration in CFn-property
   * shape. Each branch surfaces only the keys cdkd's `create()` accepts.
   * Sensitive fields are NEVER surfaced. `Tags` are surfaced via a
   * follow-up `ListTagsForResource(ResourceName=arn)` call.
   */
  async readCurrentState(
    physicalId: string,
    _logicalId: string,
    resourceType: string
  ): Promise<Record<string, unknown> | undefined> {
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

  private async readCurrentStateDBInstance(
    physicalId: string
  ): Promise<Record<string, unknown> | undefined> {
    let inst;
    try {
      inst = await this.describeDBInstance(physicalId);
    } catch (err) {
      if (this.isNotFoundError(err, 'DBInstanceNotFoundFault')) return undefined;
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
    // DBParameterGroupName: Neptune's DescribeDBInstances returns
    // DBParameterGroups[] — surface the first entry's name when present.
    const pg = inst.DBParameterGroups?.[0]?.DBParameterGroupName;
    if (pg !== undefined) result['DBParameterGroupName'] = pg;

    if (inst.DBInstanceArn) await this.attachTags(result, inst.DBInstanceArn);
    return result;
  }

  private async readCurrentStateDBCluster(
    physicalId: string
  ): Promise<Record<string, unknown> | undefined> {
    let cluster;
    try {
      cluster = await this.describeDBCluster(physicalId);
    } catch (err) {
      if (this.isNotFoundError(err, 'DBClusterNotFoundFault')) return undefined;
      throw err;
    }
    if (!cluster) return undefined;

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
    if (cluster.DBClusterArn) await this.attachTags(result, cluster.DBClusterArn);
    return result;
  }

  private async readCurrentStateDBSubnetGroup(
    physicalId: string
  ): Promise<Record<string, unknown> | undefined> {
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
      if (this.isNotFoundError(err, 'DBSubnetGroupNotFoundFault')) return undefined;
      throw err;
    }
    const sg = resp.DBSubnetGroups?.[0];
    if (!sg) return undefined;

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
  private async attachTags(result: Record<string, unknown>, arn: string): Promise<void> {
    try {
      const tagsResp = await this.getClient().send(
        new ListTagsForResourceCommand({ ResourceName: arn })
      );
      const tags = normalizeAwsTagsToCfn(tagsResp.TagList);
      result['Tags'] = tags;
    } catch (err) {
      this.logger.debug(
        `Neptune ListTagsForResource(${arn}) failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  private async importDBInstance(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    const explicit = resolveExplicitPhysicalId(input, 'DBInstanceIdentifier');
    if (explicit) {
      try {
        await this.getClient().send(
          new DescribeDBInstancesCommand({ DBInstanceIdentifier: explicit })
        );
        return { physicalId: explicit, attributes: {} };
      } catch (err) {
        if ((err as { name?: string }).name === 'DBInstanceNotFoundFault') return null;
        throw err;
      }
    }
    if (!input.cdkPath) return null;

    let marker: string | undefined;
    do {
      const list = await this.getClient().send(
        new DescribeDBInstancesCommand({ ...(marker && { Marker: marker }) })
      );
      for (const inst of list.DBInstances ?? []) {
        if (!inst.DBInstanceIdentifier || !inst.DBInstanceArn) continue;
        const tagsResp = await this.getClient().send(
          new ListTagsForResourceCommand({ ResourceName: inst.DBInstanceArn })
        );
        if (matchesCdkPath(tagsResp.TagList, input.cdkPath)) {
          return { physicalId: inst.DBInstanceIdentifier, attributes: {} };
        }
      }
      marker = list.Marker;
    } while (marker);
    return null;
  }

  private async importDBCluster(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    const explicit = resolveExplicitPhysicalId(input, 'DBClusterIdentifier');
    if (explicit) {
      try {
        await this.getClient().send(
          new DescribeDBClustersCommand({ DBClusterIdentifier: explicit })
        );
        return { physicalId: explicit, attributes: {} };
      } catch (err) {
        if ((err as { name?: string }).name === 'DBClusterNotFoundFault') return null;
        throw err;
      }
    }
    if (!input.cdkPath) return null;

    let marker: string | undefined;
    do {
      const list = await this.getClient().send(
        new DescribeDBClustersCommand({ ...(marker && { Marker: marker }) })
      );
      for (const c of list.DBClusters ?? []) {
        if (!c.DBClusterIdentifier || !c.DBClusterArn) continue;
        const tagsResp = await this.getClient().send(
          new ListTagsForResourceCommand({ ResourceName: c.DBClusterArn })
        );
        if (matchesCdkPath(tagsResp.TagList, input.cdkPath)) {
          return { physicalId: c.DBClusterIdentifier, attributes: {} };
        }
      }
      marker = list.Marker;
    } while (marker);
    return null;
  }

  private async importDBSubnetGroup(
    input: ResourceImportInput
  ): Promise<ResourceImportResult | null> {
    const explicit = resolveExplicitPhysicalId(input, 'DBSubnetGroupName');
    if (explicit) {
      try {
        await this.getClient().send(
          new DescribeDBSubnetGroupsCommand({ DBSubnetGroupName: explicit })
        );
        return { physicalId: explicit, attributes: {} };
      } catch (err) {
        if ((err as { name?: string }).name === 'DBSubnetGroupNotFoundFault') return null;
        throw err;
      }
    }
    if (!input.cdkPath) return null;

    let marker: string | undefined;
    do {
      const list = await this.getClient().send(
        new DescribeDBSubnetGroupsCommand({ ...(marker && { Marker: marker }) })
      );
      for (const sg of list.DBSubnetGroups ?? []) {
        if (!sg.DBSubnetGroupName || !sg.DBSubnetGroupArn) continue;
        const tagsResp = await this.getClient().send(
          new ListTagsForResourceCommand({ ResourceName: sg.DBSubnetGroupArn })
        );
        if (matchesCdkPath(tagsResp.TagList, input.cdkPath)) {
          return { physicalId: sg.DBSubnetGroupName, attributes: {} };
        }
      }
      marker = list.Marker;
    } while (marker);
    return null;
  }
}
