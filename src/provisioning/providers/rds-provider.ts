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
  ModifyDBSubnetGroupCommand,
} from '@aws-sdk/client-rds';
import { getLogger } from '../../utils/logger.js';
import { ProvisioningError } from '../../utils/error-handler.js';
import type {
  ResourceProvider,
  ResourceCreateResult,
  ResourceUpdateResult,
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
  private logger = getLogger().child('RDSProvider');

  private getClient(): RDSClient {
    if (!this.rdsClient) {
      this.rdsClient = new RDSClient({});
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
    _previousProperties: Record<string, unknown>
  ): Promise<ResourceUpdateResult> {
    switch (resourceType) {
      case 'AWS::RDS::DBSubnetGroup':
        return this.updateDBSubnetGroup(logicalId, physicalId, resourceType, properties);
      case 'AWS::RDS::DBCluster':
        return this.updateDBCluster(logicalId, physicalId, resourceType, properties);
      case 'AWS::RDS::DBInstance':
        return this.updateDBInstance(logicalId, physicalId, resourceType, properties);
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
    _properties?: Record<string, unknown>
  ): Promise<void> {
    switch (resourceType) {
      case 'AWS::RDS::DBSubnetGroup':
        return this.deleteDBSubnetGroup(logicalId, physicalId, resourceType);
      case 'AWS::RDS::DBCluster':
        return this.deleteDBCluster(logicalId, physicalId, resourceType);
      case 'AWS::RDS::DBInstance':
        return this.deleteDBInstance(logicalId, physicalId, resourceType);
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
      (properties['DBSubnetGroupName'] as string | undefined) || logicalId;

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
    properties: Record<string, unknown>
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
    resourceType: string
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
        this.logger.debug(
          `DBSubnetGroup ${physicalId} does not exist, skipping deletion`
        );
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
      (properties['DBClusterIdentifier'] as string | undefined) || logicalId.toLowerCase();

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

      this.logger.debug(
        `Successfully created DBCluster ${logicalId}: ${dbClusterIdentifier}`
      );

      // Wait for cluster to become available
      await this.waitForClusterAvailable(dbClusterIdentifier);

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
    properties: Record<string, unknown>
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
    resourceType: string
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
        this.logger.debug(
          `DBCluster ${physicalId} does not exist, skipping deletion`
        );
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
      (properties['DBInstanceIdentifier'] as string | undefined) || logicalId.toLowerCase();

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

      this.logger.debug(
        `Successfully created DBInstance ${logicalId}: ${dbInstanceIdentifier}`
      );

      // Wait for instance to become available
      await this.waitForInstanceAvailable(dbInstanceIdentifier);

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
    properties: Record<string, unknown>
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
    resourceType: string
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
        this.logger.debug(
          `DBInstance ${physicalId} does not exist, skipping deletion`
        );
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

  private buildTags(
    properties: Record<string, unknown>
  ): Array<{ Key: string; Value: string }> {
    if (!properties['Tags']) return [];
    return properties['Tags'] as Array<{ Key: string; Value: string }>;
  }

  private isNotFoundError(error: unknown, faultName: string): boolean {
    if (!(error instanceof Error)) return false;
    const name = (error as { name?: string }).name ?? '';
    const message = error.message.toLowerCase();
    return (
      name === faultName ||
      message.includes('not found') ||
      message.includes('does not exist')
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

    throw new Error(
      `Timed out waiting for DBCluster ${dbClusterIdentifier} to become available`
    );
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

    throw new Error(
      `Timed out waiting for DBCluster ${dbClusterIdentifier} to be deleted`
    );
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

    throw new Error(
      `Timed out waiting for DBInstance ${dbInstanceIdentifier} to become available`
    );
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

    throw new Error(
      `Timed out waiting for DBInstance ${dbInstanceIdentifier} to be deleted`
    );
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
