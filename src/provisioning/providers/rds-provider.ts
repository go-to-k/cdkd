import {
  RDSClient,
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
} from '@aws-sdk/client-rds';
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
  private readonly providerRegion = process.env['AWS_REGION'];
  private logger = getLogger().child('RDSProvider');

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
      ]),
    ],
  ]);

  private getClient(): RDSClient {
    if (!this.rdsClient) {
      this.rdsClient = new RDSClient(this.providerRegion ? { region: this.providerRegion } : {});
    }
    return this.rdsClient;
  }

  // ─── Dispatch ─────────────────────────────────────────────────────

  async create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
  ): Promise<ResourceCreateResult> {
    switch (resourceType) {
      case 'AWS::RDS::DBSubnetGroup':
        return this.createDBSubnetGroup(logicalId, resourceType, properties);
      case 'AWS::RDS::DBCluster':
        return this.createDBCluster(logicalId, resourceType, properties);
      case 'AWS::RDS::DBInstance':
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
      case 'AWS::RDS::DBSubnetGroup':
        return this.updateDBSubnetGroup(
          logicalId,
          physicalId,
          resourceType,
          properties,
          previousProperties
        );
      case 'AWS::RDS::DBCluster':
        return this.updateDBCluster(
          logicalId,
          physicalId,
          resourceType,
          properties,
          previousProperties
        );
      case 'AWS::RDS::DBInstance':
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
      case 'AWS::RDS::DBSubnetGroup':
        return this.deleteDBSubnetGroup(logicalId, physicalId, resourceType, context);
      case 'AWS::RDS::DBCluster':
        return this.deleteDBCluster(logicalId, physicalId, resourceType, context);
      case 'AWS::RDS::DBInstance':
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
    this.logger.debug(`Creating DBSubnetGroup ${logicalId}`);

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

      this.logger.debug(`Successfully created DBSubnetGroup ${logicalId}: ${dbSubnetGroupName}`);

      return {
        physicalId: dbSubnetGroupName,
        attributes: {
          DBSubnetGroupName: dbSubnetGroupName,
        },
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to create DBSubnetGroup ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
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
    this.logger.debug(`Updating DBSubnetGroup ${logicalId}: ${physicalId}`);

    try {
      await this.getClient().send(
        new ModifyDBSubnetGroupCommand({
          DBSubnetGroupName: physicalId,
          DBSubnetGroupDescription: properties['DBSubnetGroupDescription'] as string | undefined,
          SubnetIds: properties['SubnetIds'] as string[],
        })
      );

      // Apply tag diff. RDS uses ARN-keyed AddTagsToResource /
      // RemoveTagsFromResource. DescribeDBSubnetGroups returns the ARN.
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

      this.logger.debug(`Successfully updated DBSubnetGroup ${logicalId}`);

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
        `Failed to update DBSubnetGroup ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
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
    this.logger.debug(`Deleting DBSubnetGroup ${logicalId}: ${physicalId}`);

    try {
      await this.getClient().send(
        new DeleteDBSubnetGroupCommand({
          DBSubnetGroupName: physicalId,
        })
      );
      this.logger.debug(`Successfully deleted DBSubnetGroup ${logicalId}`);
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
        this.logger.debug(`DBSubnetGroup ${physicalId} does not exist, skipping deletion`);
        return;
      }
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to delete DBSubnetGroup ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
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
    this.logger.debug(`Creating DBCluster ${logicalId}`);

    const dbClusterIdentifier =
      (properties['DBClusterIdentifier'] as string | undefined) ||
      generateResourceName(logicalId, { maxLength: 63, lowercase: true });

    try {
      const tags = this.buildTags(properties);

      const serverlessV2Config = properties['ServerlessV2ScalingConfiguration'] as
        | { MinCapacity?: number; MaxCapacity?: number }
        | undefined;

      const response = await this.getClient().send(
        new CreateDBClusterCommand({
          DBClusterIdentifier: dbClusterIdentifier,
          Engine: properties['Engine'] as string,
          EngineVersion: properties['EngineVersion'] as string | undefined,
          MasterUsername: properties['MasterUsername'] as string | undefined,
          MasterUserPassword: properties['MasterUserPassword'] as string | undefined,
          DatabaseName: properties['DatabaseName'] as string | undefined,
          Port: properties['Port'] != null ? Number(properties['Port']) : undefined,
          VpcSecurityGroupIds: properties['VpcSecurityGroupIds'] as string[] | undefined,
          DBSubnetGroupName: properties['DBSubnetGroupName'] as string | undefined,
          StorageEncrypted: properties['StorageEncrypted'] as boolean | undefined,
          KmsKeyId: properties['KmsKeyId'] as string | undefined,
          BackupRetentionPeriod:
            properties['BackupRetentionPeriod'] != null
              ? Number(properties['BackupRetentionPeriod'])
              : undefined,
          DeletionProtection: properties['DeletionProtection'] as boolean | undefined,
          ...(serverlessV2Config && {
            ServerlessV2ScalingConfiguration: {
              MinCapacity: serverlessV2Config.MinCapacity,
              MaxCapacity: serverlessV2Config.MaxCapacity,
            },
          }),
          ...(tags.length > 0 && { Tags: tags }),
        })
      );

      const cluster = response.DBCluster;
      if (!cluster) {
        throw new Error('CreateDBCluster did not return DBCluster');
      }

      this.logger.debug(`Successfully created DBCluster ${logicalId}: ${dbClusterIdentifier}`);

      // Wait for cluster to become available (skip with --no-wait)
      if (process.env['CDKD_NO_WAIT'] !== 'true') {
        await this.waitForClusterAvailable(dbClusterIdentifier);
      }

      // Describe to get final attributes
      const described = await this.describeDBCluster(dbClusterIdentifier);

      return {
        physicalId: dbClusterIdentifier,
        attributes: {
          'Endpoint.Address': described?.Endpoint ?? '',
          'Endpoint.Port': String(described?.Port ?? ''),
          'ReadEndpoint.Address': described?.ReaderEndpoint ?? '',
          Arn: described?.DBClusterArn ?? '',
          DBClusterResourceId: described?.DbClusterResourceId ?? '',
        },
      };
    } catch (error) {
      if (error instanceof ProvisioningError) throw error;
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to create DBCluster ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
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
    this.logger.debug(`Updating DBCluster ${logicalId}: ${physicalId}`);

    try {
      const serverlessV2Config = properties['ServerlessV2ScalingConfiguration'] as
        | { MinCapacity?: number; MaxCapacity?: number }
        | undefined;

      await this.getClient().send(
        new ModifyDBClusterCommand({
          DBClusterIdentifier: physicalId,
          EngineVersion: properties['EngineVersion'] as string | undefined,
          DeletionProtection: properties['DeletionProtection'] as boolean | undefined,
          BackupRetentionPeriod:
            properties['BackupRetentionPeriod'] != null
              ? Number(properties['BackupRetentionPeriod'])
              : undefined,
          VpcSecurityGroupIds: properties['VpcSecurityGroupIds'] as string[] | undefined,
          MasterUserPassword: properties['MasterUserPassword'] as string | undefined,
          Port: properties['Port'] != null ? Number(properties['Port']) : undefined,
          ...(serverlessV2Config && {
            ServerlessV2ScalingConfiguration: {
              MinCapacity: serverlessV2Config.MinCapacity,
              MaxCapacity: serverlessV2Config.MaxCapacity,
            },
          }),
          ApplyImmediately: true,
        })
      );

      this.logger.debug(`Successfully updated DBCluster ${logicalId}`);

      // Describe to get updated attributes
      const described = await this.describeDBCluster(physicalId);

      // Apply tag diff using the cluster ARN.
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
          Arn: described?.DBClusterArn ?? '',
          DBClusterResourceId: described?.DbClusterResourceId ?? '',
        },
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to update DBCluster ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
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
    this.logger.debug(`Deleting DBCluster ${logicalId}: ${physicalId}`);

    try {
      // Disable deletion protection before deleting if needed
      try {
        await this.getClient().send(
          new ModifyDBClusterCommand({
            DBClusterIdentifier: physicalId,
            DeletionProtection: false,
          })
        );
      } catch (disableError) {
        // Ignore errors from disabling deletion protection (cluster may already be deleted)
        if (!this.isNotFoundError(disableError, 'DBClusterNotFoundFault')) {
          this.logger.debug(
            `Could not disable deletion protection for ${physicalId}: ${disableError instanceof Error ? disableError.message : String(disableError)}`
          );
        }
      }

      await this.getClient().send(
        new DeleteDBClusterCommand({
          DBClusterIdentifier: physicalId,
          SkipFinalSnapshot: true,
        })
      );

      this.logger.debug(`Successfully initiated deletion of DBCluster ${logicalId}`);

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
        this.logger.debug(`DBCluster ${physicalId} does not exist, skipping deletion`);
        return;
      }
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to delete DBCluster ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
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
    this.logger.debug(`Creating DBInstance ${logicalId}`);

    const dbInstanceIdentifier =
      (properties['DBInstanceIdentifier'] as string | undefined) ||
      generateResourceName(logicalId, { maxLength: 63, lowercase: true });

    try {
      const tags = this.buildTags(properties);

      const response = await this.getClient().send(
        new CreateDBInstanceCommand({
          DBInstanceIdentifier: dbInstanceIdentifier,
          DBInstanceClass: properties['DBInstanceClass'] as string,
          Engine: properties['Engine'] as string,
          DBClusterIdentifier: properties['DBClusterIdentifier'] as string | undefined,
          DBSubnetGroupName: properties['DBSubnetGroupName'] as string | undefined,
          PubliclyAccessible: properties['PubliclyAccessible'] as boolean | undefined,
          ...(tags.length > 0 && { Tags: tags }),
        })
      );

      const instance = response.DBInstance;
      if (!instance) {
        throw new Error('CreateDBInstance did not return DBInstance');
      }

      this.logger.debug(`Successfully created DBInstance ${logicalId}: ${dbInstanceIdentifier}`);

      // Wait for instance to become available (skip with --no-wait)
      if (process.env['CDKD_NO_WAIT'] !== 'true') {
        await this.waitForInstanceAvailable(dbInstanceIdentifier);
      }

      // Describe to get final attributes
      const described = await this.describeDBInstance(dbInstanceIdentifier);

      return {
        physicalId: dbInstanceIdentifier,
        attributes: {
          'Endpoint.Address': described?.Endpoint?.Address ?? '',
          'Endpoint.Port': String(described?.Endpoint?.Port ?? ''),
          Arn: described?.DBInstanceArn ?? '',
        },
      };
    } catch (error) {
      if (error instanceof ProvisioningError) throw error;
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to create DBInstance ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
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
    this.logger.debug(`Updating DBInstance ${logicalId}: ${physicalId}`);

    try {
      await this.getClient().send(
        new ModifyDBInstanceCommand({
          DBInstanceIdentifier: physicalId,
          DBInstanceClass: properties['DBInstanceClass'] as string | undefined,
          PubliclyAccessible: properties['PubliclyAccessible'] as boolean | undefined,
          ApplyImmediately: true,
        })
      );

      this.logger.debug(`Successfully updated DBInstance ${logicalId}`);

      // Describe to get updated attributes
      const described = await this.describeDBInstance(physicalId);

      // Apply tag diff using the instance ARN.
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
          Arn: described?.DBInstanceArn ?? '',
        },
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to update DBInstance ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
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
    this.logger.debug(`Deleting DBInstance ${logicalId}: ${physicalId}`);

    try {
      // Disable deletion protection before deleting if needed
      try {
        await this.getClient().send(
          new ModifyDBInstanceCommand({
            DBInstanceIdentifier: physicalId,
            DeletionProtection: false,
            ApplyImmediately: true,
          })
        );
      } catch (disableError) {
        if (!this.isNotFoundError(disableError, 'DBInstanceNotFoundFault')) {
          this.logger.debug(
            `Could not disable deletion protection for ${physicalId}: ${disableError instanceof Error ? disableError.message : String(disableError)}`
          );
        }
      }

      await this.getClient().send(
        new DeleteDBInstanceCommand({
          DBInstanceIdentifier: physicalId,
          SkipFinalSnapshot: true,
        })
      );

      this.logger.debug(`Successfully initiated deletion of DBInstance ${logicalId}`);

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
        this.logger.debug(`DBInstance ${physicalId} does not exist, skipping deletion`);
        return;
      }
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to delete DBInstance ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  // ─── Helpers ──────────────────────────────────────────────────────

  /**
   * Apply a diff between old and new CFn-shape Tags arrays via RDS's
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
      this.logger.debug(`Removed ${tagsToRemove.length} tag(s) from RDS resource ${arn}`);
    }
    if (tagsToAdd.length > 0) {
      await this.getClient().send(
        new AddTagsToResourceCommand({ ResourceName: arn, Tags: tagsToAdd })
      );
      this.logger.debug(`Added/updated ${tagsToAdd.length} tag(s) on RDS resource ${arn}`);
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
   * Wait for a DBCluster to become available
   */
  private async waitForClusterAvailable(
    dbClusterIdentifier: string,
    maxWaitMs = 600_000
  ): Promise<void> {
    const startTime = Date.now();
    let delay = 5_000;

    while (Date.now() - startTime < maxWaitMs) {
      const cluster = await this.describeDBCluster(dbClusterIdentifier);
      const status = cluster?.Status;

      this.logger.debug(`DBCluster ${dbClusterIdentifier} status: ${status}`);

      if (status === 'available') return;

      await this.sleep(delay);
      delay = Math.min(delay * 2, 30_000);
    }

    throw new Error(`Timed out waiting for DBCluster ${dbClusterIdentifier} to become available`);
  }

  /**
   * Wait for a DBCluster to be deleted
   */
  private async waitForClusterDeleted(
    dbClusterIdentifier: string,
    maxWaitMs = 600_000
  ): Promise<void> {
    const startTime = Date.now();
    let delay = 5_000;

    while (Date.now() - startTime < maxWaitMs) {
      try {
        const cluster = await this.describeDBCluster(dbClusterIdentifier);
        const status = cluster?.Status;

        this.logger.debug(`DBCluster ${dbClusterIdentifier} status: ${status}`);

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

    throw new Error(`Timed out waiting for DBCluster ${dbClusterIdentifier} to be deleted`);
  }

  /**
   * Wait for a DBInstance to become available
   */
  private async waitForInstanceAvailable(
    dbInstanceIdentifier: string,
    maxWaitMs = 600_000
  ): Promise<void> {
    const startTime = Date.now();
    let delay = 10_000;

    while (Date.now() - startTime < maxWaitMs) {
      const instance = await this.describeDBInstance(dbInstanceIdentifier);
      const status = instance?.DBInstanceStatus;

      this.logger.debug(`DBInstance ${dbInstanceIdentifier} status: ${status}`);

      if (status === 'available') return;

      await this.sleep(delay);
      delay = Math.min(delay * 2, 30_000);
    }

    throw new Error(`Timed out waiting for DBInstance ${dbInstanceIdentifier} to become available`);
  }

  /**
   * Wait for a DBInstance to be deleted
   */
  private async waitForInstanceDeleted(
    dbInstanceIdentifier: string,
    maxWaitMs = 600_000
  ): Promise<void> {
    const startTime = Date.now();
    let delay = 10_000;

    while (Date.now() - startTime < maxWaitMs) {
      try {
        const instance = await this.describeDBInstance(dbInstanceIdentifier);
        const status = instance?.DBInstanceStatus;

        this.logger.debug(`DBInstance ${dbInstanceIdentifier} status: ${status}`);

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

    throw new Error(`Timed out waiting for DBInstance ${dbInstanceIdentifier} to be deleted`);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Adopt an existing RDS resource into cdkd state.
   *
   * Supported types: `AWS::RDS::DBInstance`, `AWS::RDS::DBCluster`,
   * `AWS::RDS::DBSubnetGroup`. Identifier name properties (`DBInstance
   * Identifier` / `DBClusterIdentifier` / `DBSubnetGroupName`) are
   * usually present in CDK templates; fall back to `aws:cdk:path` tag
   * lookup via the corresponding `Describe*` + `ListTagsForResource`
   * pair otherwise.
   */
  async import(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    switch (input.resourceType) {
      case 'AWS::RDS::DBInstance':
        return this.importDBInstance(input);
      case 'AWS::RDS::DBCluster':
        return this.importDBCluster(input);
      case 'AWS::RDS::DBSubnetGroup':
        return this.importDBSubnetGroup(input);
      default:
        return null;
    }
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
   * Returns `undefined` when the resource is gone (`*NotFoundFault`).
   */
  async readCurrentState(
    physicalId: string,
    _logicalId: string,
    resourceType: string
  ): Promise<Record<string, unknown> | undefined> {
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
    {
      const sc: Record<string, unknown> = {};
      if (cluster.ServerlessV2ScalingConfiguration?.MinCapacity !== undefined) {
        sc['MinCapacity'] = cluster.ServerlessV2ScalingConfiguration.MinCapacity;
      }
      if (cluster.ServerlessV2ScalingConfiguration?.MaxCapacity !== undefined) {
        sc['MaxCapacity'] = cluster.ServerlessV2ScalingConfiguration.MaxCapacity;
      }
      result['ServerlessV2ScalingConfiguration'] = sc;
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
   * Fetch tags via `ListTagsForResource(ResourceName=arn)` and merge them
   * into the result under `Tags` (CFn shape, `aws:*` filtered out, omitted
   * when empty). Best-effort: tag-fetch failures are logged at debug and
   * the key is simply left out — drift detection on configuration is more
   * important than fail-closing on a missing tag permission.
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
        `RDS ListTagsForResource(${arn}) failed: ${err instanceof Error ? err.message : String(err)}`
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
