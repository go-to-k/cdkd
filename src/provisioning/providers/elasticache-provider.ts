import {
  ElastiCacheClient,
  CreateCacheClusterCommand,
  DeleteCacheClusterCommand,
  DescribeCacheClustersCommand,
  CreateCacheSubnetGroupCommand,
  DeleteCacheSubnetGroupCommand,
  ModifyCacheSubnetGroupCommand,
  ModifyCacheClusterCommand,
  type AZMode,
} from '@aws-sdk/client-elasticache';
import { getLogger } from '../../utils/logger.js';
import { ProvisioningError } from '../../utils/error-handler.js';
import { generateResourceName } from '../resource-name.js';
import type {
  ResourceProvider,
  ResourceCreateResult,
  ResourceUpdateResult,
} from '../../types/resource.js';

/**
 * AWS ElastiCache Provider
 *
 * Implements resource provisioning for ElastiCache resources:
 * - AWS::ElastiCache::SubnetGroup
 * - AWS::ElastiCache::CacheCluster
 *
 * WHY: ElastiCache SDK calls are direct and avoid CC API polling overhead.
 * CacheCluster creation requires polling until available.
 */
export class ElastiCacheProvider implements ResourceProvider {
  private client?: ElastiCacheClient;
  private readonly providerRegion = process.env['AWS_REGION'];
  private logger = getLogger().child('ElastiCacheProvider');

  private getClient(): ElastiCacheClient {
    if (!this.client) {
      this.client = new ElastiCacheClient(
        this.providerRegion ? { region: this.providerRegion } : {}
      );
    }
    return this.client;
  }

  // ─── Dispatch ─────────────────────────────────────────────────────

  async create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
  ): Promise<ResourceCreateResult> {
    switch (resourceType) {
      case 'AWS::ElastiCache::SubnetGroup':
        return this.createSubnetGroup(logicalId, resourceType, properties);
      case 'AWS::ElastiCache::CacheCluster':
        return this.createCacheCluster(logicalId, resourceType, properties);
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
      case 'AWS::ElastiCache::SubnetGroup':
        return this.updateSubnetGroup(logicalId, physicalId, resourceType, properties);
      case 'AWS::ElastiCache::CacheCluster':
        return this.updateCacheCluster(logicalId, physicalId, resourceType, properties);
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
      case 'AWS::ElastiCache::SubnetGroup':
        return this.deleteSubnetGroup(logicalId, physicalId, resourceType);
      case 'AWS::ElastiCache::CacheCluster':
        return this.deleteCacheCluster(logicalId, physicalId, resourceType);
      default:
        throw new ProvisioningError(
          `Unsupported resource type: ${resourceType}`,
          resourceType,
          logicalId,
          physicalId
        );
    }
  }

  // ─── SubnetGroup ──────────────────────────────────────────────────

  private async createSubnetGroup(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
  ): Promise<ResourceCreateResult> {
    this.logger.debug(`Creating CacheSubnetGroup ${logicalId}`);

    const cacheSubnetGroupName =
      (properties['CacheSubnetGroupName'] as string | undefined) ||
      generateResourceName(logicalId, { maxLength: 255, lowercase: true });

    try {
      await this.getClient().send(
        new CreateCacheSubnetGroupCommand({
          CacheSubnetGroupName: cacheSubnetGroupName,
          CacheSubnetGroupDescription:
            (properties['CacheSubnetGroupDescription'] as string) ||
            `Subnet group for ${logicalId}`,
          SubnetIds: properties['SubnetIds'] as string[],
        })
      );

      this.logger.debug(
        `Successfully created CacheSubnetGroup ${logicalId}: ${cacheSubnetGroupName}`
      );

      return {
        physicalId: cacheSubnetGroupName,
        attributes: {
          CacheSubnetGroupName: cacheSubnetGroupName,
        },
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to create CacheSubnetGroup ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        cacheSubnetGroupName,
        cause
      );
    }
  }

  private async updateSubnetGroup(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
  ): Promise<ResourceUpdateResult> {
    this.logger.debug(`Updating CacheSubnetGroup ${logicalId}: ${physicalId}`);

    try {
      await this.getClient().send(
        new ModifyCacheSubnetGroupCommand({
          CacheSubnetGroupName: physicalId,
          CacheSubnetGroupDescription: properties['CacheSubnetGroupDescription'] as
            | string
            | undefined,
          SubnetIds: properties['SubnetIds'] as string[],
        })
      );

      this.logger.debug(`Successfully updated CacheSubnetGroup ${logicalId}`);

      return {
        physicalId,
        wasReplaced: false,
        attributes: {
          CacheSubnetGroupName: physicalId,
        },
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to update CacheSubnetGroup ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  private async deleteSubnetGroup(
    logicalId: string,
    physicalId: string,
    resourceType: string
  ): Promise<void> {
    this.logger.debug(`Deleting CacheSubnetGroup ${logicalId}: ${physicalId}`);

    try {
      await this.getClient().send(
        new DeleteCacheSubnetGroupCommand({
          CacheSubnetGroupName: physicalId,
        })
      );
      this.logger.debug(`Successfully deleted CacheSubnetGroup ${logicalId}`);
    } catch (error) {
      if (this.isNotFoundError(error, 'CacheSubnetGroupNotFoundFault')) {
        this.logger.debug(`CacheSubnetGroup ${physicalId} does not exist, skipping deletion`);
        return;
      }
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to delete CacheSubnetGroup ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  // ─── CacheCluster ────────────────────────────────────────────────

  private async createCacheCluster(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
  ): Promise<ResourceCreateResult> {
    this.logger.debug(`Creating CacheCluster ${logicalId}`);

    const cacheClusterId =
      (properties['ClusterName'] as string | undefined) ||
      generateResourceName(logicalId, { maxLength: 40, lowercase: true });

    try {
      const tags = this.buildTags(properties);

      await this.getClient().send(
        new CreateCacheClusterCommand({
          CacheClusterId: cacheClusterId,
          Engine: properties['Engine'] as string,
          CacheNodeType: properties['CacheNodeType'] as string,
          NumCacheNodes:
            properties['NumCacheNodes'] != null ? Number(properties['NumCacheNodes']) : undefined,
          CacheSubnetGroupName: properties['CacheSubnetGroupName'] as string | undefined,
          SecurityGroupIds: properties['VpcSecurityGroupIds'] as string[] | undefined,
          Port: properties['Port'] != null ? Number(properties['Port']) : undefined,
          EngineVersion: properties['EngineVersion'] as string | undefined,
          CacheParameterGroupName: properties['CacheParameterGroupName'] as string | undefined,
          PreferredMaintenanceWindow: properties['PreferredMaintenanceWindow'] as
            | string
            | undefined,
          AZMode: properties['AZMode'] as AZMode | undefined,
          PreferredAvailabilityZone: properties['PreferredAvailabilityZone'] as string | undefined,
          PreferredAvailabilityZones: properties['PreferredAvailabilityZones'] as
            | string[]
            | undefined,
          SnapshotRetentionLimit:
            properties['SnapshotRetentionLimit'] != null
              ? Number(properties['SnapshotRetentionLimit'])
              : undefined,
          SnapshotWindow: properties['SnapshotWindow'] as string | undefined,
          AutoMinorVersionUpgrade: properties['AutoMinorVersionUpgrade'] as boolean | undefined,
          ...(tags.length > 0 && { Tags: tags }),
        })
      );

      this.logger.debug(`Successfully created CacheCluster ${logicalId}: ${cacheClusterId}`);

      // Wait for cluster to become available (skip with --no-wait)
      if (process.env['CDKD_NO_WAIT'] !== 'true') {
        await this.waitForClusterAvailable(cacheClusterId);
      }

      // Describe to get final attributes
      const described = await this.describeCacheCluster(cacheClusterId);

      const attributes: Record<string, unknown> = {};

      // Redis endpoint attributes
      if (described?.CacheNodes?.[0]?.Endpoint) {
        const endpoint = described.CacheNodes[0].Endpoint;
        attributes['RedisEndpoint.Address'] = endpoint.Address ?? '';
        attributes['RedisEndpoint.Port'] = String(endpoint.Port ?? '');
      }

      // Configuration endpoint (for Memcached clusters)
      if (described?.ConfigurationEndpoint) {
        attributes['ConfigurationEndpoint.Address'] = described.ConfigurationEndpoint.Address ?? '';
        attributes['ConfigurationEndpoint.Port'] = String(
          described.ConfigurationEndpoint.Port ?? ''
        );
      }

      return {
        physicalId: cacheClusterId,
        attributes,
      };
    } catch (error) {
      if (error instanceof ProvisioningError) throw error;
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to create CacheCluster ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        cacheClusterId,
        cause
      );
    }
  }

  private async updateCacheCluster(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
  ): Promise<ResourceUpdateResult> {
    this.logger.debug(`Updating CacheCluster ${logicalId}: ${physicalId}`);

    try {
      await this.getClient().send(
        new ModifyCacheClusterCommand({
          CacheClusterId: physicalId,
          NumCacheNodes:
            properties['NumCacheNodes'] != null ? Number(properties['NumCacheNodes']) : undefined,
          SecurityGroupIds: properties['VpcSecurityGroupIds'] as string[] | undefined,
          CacheParameterGroupName: properties['CacheParameterGroupName'] as string | undefined,
          EngineVersion: properties['EngineVersion'] as string | undefined,
          PreferredMaintenanceWindow: properties['PreferredMaintenanceWindow'] as
            | string
            | undefined,
          SnapshotRetentionLimit:
            properties['SnapshotRetentionLimit'] != null
              ? Number(properties['SnapshotRetentionLimit'])
              : undefined,
          SnapshotWindow: properties['SnapshotWindow'] as string | undefined,
          AutoMinorVersionUpgrade: properties['AutoMinorVersionUpgrade'] as boolean | undefined,
          ApplyImmediately: true,
        })
      );

      this.logger.debug(`Successfully updated CacheCluster ${logicalId}`);

      // Wait for cluster to become available after modification
      await this.waitForClusterAvailable(physicalId);

      // Describe to get updated attributes
      const described = await this.describeCacheCluster(physicalId);

      const attributes: Record<string, unknown> = {};

      if (described?.CacheNodes?.[0]?.Endpoint) {
        const endpoint = described.CacheNodes[0].Endpoint;
        attributes['RedisEndpoint.Address'] = endpoint.Address ?? '';
        attributes['RedisEndpoint.Port'] = String(endpoint.Port ?? '');
      }

      if (described?.ConfigurationEndpoint) {
        attributes['ConfigurationEndpoint.Address'] = described.ConfigurationEndpoint.Address ?? '';
        attributes['ConfigurationEndpoint.Port'] = String(
          described.ConfigurationEndpoint.Port ?? ''
        );
      }

      return {
        physicalId,
        wasReplaced: false,
        attributes,
      };
    } catch (error) {
      if (error instanceof ProvisioningError) throw error;
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to update CacheCluster ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  private async deleteCacheCluster(
    logicalId: string,
    physicalId: string,
    resourceType: string
  ): Promise<void> {
    this.logger.debug(`Deleting CacheCluster ${logicalId}: ${physicalId}`);

    try {
      await this.getClient().send(
        new DeleteCacheClusterCommand({
          CacheClusterId: physicalId,
        })
      );

      this.logger.debug(`Successfully initiated deletion of CacheCluster ${logicalId}`);

      // Wait for cluster to be fully deleted
      await this.waitForClusterDeleted(physicalId);
    } catch (error) {
      if (this.isNotFoundError(error, 'CacheClusterNotFoundFault')) {
        this.logger.debug(`CacheCluster ${physicalId} does not exist, skipping deletion`);
        return;
      }
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to delete CacheCluster ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
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

  private isNotFoundError(error: unknown, faultName: string): boolean {
    if (!(error instanceof Error)) return false;
    const name = (error as { name?: string }).name ?? '';
    const message = error.message.toLowerCase();
    return (
      name === faultName || message.includes('not found') || message.includes('does not exist')
    );
  }

  private async describeCacheCluster(cacheClusterId: string) {
    const response = await this.getClient().send(
      new DescribeCacheClustersCommand({
        CacheClusterId: cacheClusterId,
        ShowCacheNodeInfo: true,
      })
    );
    return response.CacheClusters?.[0];
  }

  /**
   * Wait for a CacheCluster to become available
   */
  private async waitForClusterAvailable(
    cacheClusterId: string,
    maxWaitMs = 600_000
  ): Promise<void> {
    const startTime = Date.now();
    let delay = 10_000;

    while (Date.now() - startTime < maxWaitMs) {
      const cluster = await this.describeCacheCluster(cacheClusterId);
      const status = cluster?.CacheClusterStatus;

      this.logger.debug(`CacheCluster ${cacheClusterId} status: ${status}`);

      if (status === 'available') return;

      await this.sleep(delay);
      delay = Math.min(delay * 2, 30_000);
    }

    throw new Error(`Timed out waiting for CacheCluster ${cacheClusterId} to become available`);
  }

  /**
   * Wait for a CacheCluster to be deleted
   */
  private async waitForClusterDeleted(cacheClusterId: string, maxWaitMs = 600_000): Promise<void> {
    const startTime = Date.now();
    let delay = 10_000;

    while (Date.now() - startTime < maxWaitMs) {
      try {
        const cluster = await this.describeCacheCluster(cacheClusterId);
        const status = cluster?.CacheClusterStatus;

        this.logger.debug(`CacheCluster ${cacheClusterId} status: ${status}`);

        if (!cluster) return;
      } catch (error) {
        if (this.isNotFoundError(error, 'CacheClusterNotFoundFault')) {
          return;
        }
        throw error;
      }

      await this.sleep(delay);
      delay = Math.min(delay * 2, 30_000);
    }

    throw new Error(`Timed out waiting for CacheCluster ${cacheClusterId} to be deleted`);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
