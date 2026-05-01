import {
  ElastiCacheClient,
  CreateCacheClusterCommand,
  DeleteCacheClusterCommand,
  DescribeCacheClustersCommand,
  DescribeCacheSubnetGroupsCommand,
  CreateCacheSubnetGroupCommand,
  DeleteCacheSubnetGroupCommand,
  ModifyCacheSubnetGroupCommand,
  ModifyCacheClusterCommand,
  ListTagsForResourceCommand,
  type AZMode,
  type LogDeliveryConfigurationRequest,
  type NetworkType,
  type IpDiscovery,
} from '@aws-sdk/client-elasticache';
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { getLogger } from '../../utils/logger.js';
import { ProvisioningError } from '../../utils/error-handler.js';
import { generateResourceName } from '../resource-name.js';
import { assertRegionMatch, type DeleteContext } from '../region-check.js';
import { matchesCdkPath, resolveExplicitPhysicalId } from '../import-helpers.js';
import type {
  ResourceProvider,
  ResourceCreateResult,
  ResourceUpdateResult,
  ResourceImportInput,
  ResourceImportResult,
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
  private stsClient?: STSClient;
  private cachedAccountId: string | undefined;
  private readonly providerRegion = process.env['AWS_REGION'];
  private logger = getLogger().child('ElastiCacheProvider');

  handledProperties = new Map<string, ReadonlySet<string>>([
    [
      'AWS::ElastiCache::SubnetGroup',
      new Set(['CacheSubnetGroupName', 'CacheSubnetGroupDescription', 'SubnetIds', 'Tags']),
    ],
    [
      'AWS::ElastiCache::CacheCluster',
      new Set([
        'ClusterName',
        'Engine',
        'CacheNodeType',
        'NumCacheNodes',
        'CacheSubnetGroupName',
        'VpcSecurityGroupIds',
        'Port',
        'EngineVersion',
        'CacheParameterGroupName',
        'PreferredMaintenanceWindow',
        'AZMode',
        'PreferredAvailabilityZone',
        'PreferredAvailabilityZones',
        'SnapshotRetentionLimit',
        'SnapshotWindow',
        'AutoMinorVersionUpgrade',
        'Tags',
        'NotificationTopicArn',
        'SnapshotName',
        'LogDeliveryConfigurations',
        'NetworkType',
        'IpDiscovery',
        'TransitEncryptionEnabled',
      ]),
    ],
  ]);

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
    _properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void> {
    switch (resourceType) {
      case 'AWS::ElastiCache::SubnetGroup':
        return this.deleteSubnetGroup(logicalId, physicalId, resourceType, context);
      case 'AWS::ElastiCache::CacheCluster':
        return this.deleteCacheCluster(logicalId, physicalId, resourceType, context);
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
    resourceType: string,
    context?: DeleteContext
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
        const clientRegion = await this.getClient().config.region();
        assertRegionMatch(
          clientRegion,
          context?.expectedRegion,
          resourceType,
          logicalId,
          physicalId
        );
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
          NotificationTopicArn: properties['NotificationTopicArn'] as string | undefined,
          SnapshotName: properties['SnapshotName'] as string | undefined,
          LogDeliveryConfigurations: properties['LogDeliveryConfigurations'] as
            | LogDeliveryConfigurationRequest[]
            | undefined,
          NetworkType: properties['NetworkType'] as NetworkType | undefined,
          IpDiscovery: properties['IpDiscovery'] as IpDiscovery | undefined,
          TransitEncryptionEnabled: properties['TransitEncryptionEnabled'] as boolean | undefined,
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
          NotificationTopicArn: properties['NotificationTopicArn'] as string | undefined,
          LogDeliveryConfigurations: properties['LogDeliveryConfigurations'] as
            | LogDeliveryConfigurationRequest[]
            | undefined,
          IpDiscovery: properties['IpDiscovery'] as IpDiscovery | undefined,
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
    resourceType: string,
    context?: DeleteContext
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
        const clientRegion = await this.getClient().config.region();
        assertRegionMatch(
          clientRegion,
          context?.expectedRegion,
          resourceType,
          logicalId,
          physicalId
        );
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

  /**
   * Adopt an existing ElastiCache resource into cdkd state.
   *
   * Supported types:
   *  - `AWS::ElastiCache::CacheCluster` — full tag-based lookup via
   *    `DescribeCacheClusters` + `ListTagsForResource(ResourceName=arn)`.
   *  - `AWS::ElastiCache::SubnetGroup` — full tag-based lookup via
   *    `DescribeCacheSubnetGroups` + `ListTagsForResource(ResourceName=arn)`.
   *
   * `ListTagsForResource` requires an ARN. Both `CacheCluster.ARN` and
   * `CacheSubnetGroup.ARN` are returned by the Describe APIs, so no
   * extra reconstruction is needed in normal flow; for the explicit
   * override path we build the ARN from `region` + STS account id +
   * the resource name.
   */
  async import(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    switch (input.resourceType) {
      case 'AWS::ElastiCache::CacheCluster':
        return this.importCacheCluster(input);
      case 'AWS::ElastiCache::SubnetGroup':
        return this.importSubnetGroup(input);
      default:
        return null;
    }
  }

  private async importCacheCluster(
    input: ResourceImportInput
  ): Promise<ResourceImportResult | null> {
    const explicit = resolveExplicitPhysicalId(input, 'ClusterName');
    if (explicit) {
      try {
        const resp = await this.getClient().send(
          new DescribeCacheClustersCommand({ CacheClusterId: explicit })
        );
        const c = resp.CacheClusters?.[0];
        return c?.CacheClusterId ? { physicalId: c.CacheClusterId, attributes: {} } : null;
      } catch (err) {
        if (this.isNotFoundError(err, 'CacheClusterNotFoundFault')) return null;
        throw err;
      }
    }

    if (!input.cdkPath) return null;

    let marker: string | undefined;
    do {
      const list = await this.getClient().send(
        new DescribeCacheClustersCommand({ ...(marker && { Marker: marker }) })
      );
      for (const c of list.CacheClusters ?? []) {
        if (!c.CacheClusterId) continue;
        const arn = c.ARN ?? (await this.buildClusterArn(c.CacheClusterId));
        const tagsResp = await this.getClient().send(
          new ListTagsForResourceCommand({ ResourceName: arn })
        );
        if (matchesCdkPath(tagsResp.TagList, input.cdkPath)) {
          return { physicalId: c.CacheClusterId, attributes: {} };
        }
      }
      marker = list.Marker;
    } while (marker);
    return null;
  }

  private async importSubnetGroup(
    input: ResourceImportInput
  ): Promise<ResourceImportResult | null> {
    const explicit = resolveExplicitPhysicalId(input, 'CacheSubnetGroupName');
    if (explicit) {
      try {
        const resp = await this.getClient().send(
          new DescribeCacheSubnetGroupsCommand({ CacheSubnetGroupName: explicit })
        );
        const g = resp.CacheSubnetGroups?.[0];
        return g?.CacheSubnetGroupName
          ? { physicalId: g.CacheSubnetGroupName, attributes: {} }
          : null;
      } catch (err) {
        if (this.isNotFoundError(err, 'CacheSubnetGroupNotFoundFault')) return null;
        throw err;
      }
    }

    if (!input.cdkPath) return null;

    let marker: string | undefined;
    do {
      const list = await this.getClient().send(
        new DescribeCacheSubnetGroupsCommand({ ...(marker && { Marker: marker }) })
      );
      for (const g of list.CacheSubnetGroups ?? []) {
        if (!g.CacheSubnetGroupName) continue;
        const arn = g.ARN ?? (await this.buildSubnetGroupArn(g.CacheSubnetGroupName));
        const tagsResp = await this.getClient().send(
          new ListTagsForResourceCommand({ ResourceName: arn })
        );
        if (matchesCdkPath(tagsResp.TagList, input.cdkPath)) {
          return { physicalId: g.CacheSubnetGroupName, attributes: {} };
        }
      }
      marker = list.Marker;
    } while (marker);
    return null;
  }

  private async buildClusterArn(clusterName: string): Promise<string> {
    const region = await this.getRegion();
    const account = await this.getAccountId();
    return `arn:aws:elasticache:${region}:${account}:cluster:${clusterName}`;
  }

  private async buildSubnetGroupArn(subnetGroupName: string): Promise<string> {
    const region = await this.getRegion();
    const account = await this.getAccountId();
    return `arn:aws:elasticache:${region}:${account}:subnetgroup:${subnetGroupName}`;
  }

  private async getRegion(): Promise<string> {
    const region = await this.getClient().config.region();
    return region || this.providerRegion || 'us-east-1';
  }

  private async getAccountId(): Promise<string> {
    if (this.cachedAccountId) return this.cachedAccountId;
    if (!this.stsClient) {
      this.stsClient = new STSClient(this.providerRegion ? { region: this.providerRegion } : {});
    }
    const identity = await this.stsClient.send(new GetCallerIdentityCommand({}));
    if (!identity.Account) {
      throw new Error('Failed to resolve AWS account id from STS');
    }
    this.cachedAccountId = identity.Account;
    return this.cachedAccountId;
  }
}
