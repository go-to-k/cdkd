import type { ElastiCacheProvider } from '../elasticache-provider.js';
import {
  CreateCacheClusterCommand,
  DeleteCacheClusterCommand,
  DescribeCacheClustersCommand,
  type AZMode,
  type LogDeliveryConfigurationRequest,
  type NetworkType,
  type IpDiscovery,
} from '@aws-sdk/client-elasticache';
import type { MaskerFn } from '../../masked-retry-logger.js';
import { safeMsg } from '../../../utils/display-safe.js';
import { ProvisioningError } from '../../../utils/error-handler.js';
import { markCreatedBeforeFailure } from '../../auxiliary-failure.js';
import { reportCreatedResource } from '../../created-resource-sink.js';
import { generatedNameFor } from '../../resource-name.js';
import { assertRegionMatch, type DeleteContext } from '../../region-check.js';
import { refuseMalformedDesiredTags } from '../../tag-list.js';
import type { ResourceCreateResult } from '../../../types/resource.js';
import {
  CACHE_DELETE_WAIT_MS,
  MODIFY_DROPPED_AFTER_MS,
  TERMINAL_CLUSTER_STATUSES,
} from './shared.js';

export async function createCacheCluster(
  this: ElastiCacheProvider,
  logicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  mask?: MaskerFn
): Promise<ResourceCreateResult> {
  this.logger.debug(`Creating CacheCluster ${logicalId}`);
  // go-to-k/cdkd#3994: a malformed Tags is refused before any call.
  const tags = refuseMalformedDesiredTags(properties['Tags'], resourceType, logicalId);

  const cacheClusterId =
    (properties['ClusterName'] as string | undefined) ||
    generatedNameFor('AWS::ElastiCache::CacheCluster', logicalId);

  // go-to-k/cdkd#4583: set once CreateCacheCluster returned (no self-cleanup).
  let clusterCreated = false;
  try {
    await this.getCreateClient().send(
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
        PreferredMaintenanceWindow: properties['PreferredMaintenanceWindow'] as string | undefined,
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
        // go-to-k/cdkd#5635: create-only (a change replaces the cluster),
        // and DescribeCacheClusters has no member for it, so it is sent
        // here and nowhere else.
        SnapshotArns: properties['SnapshotArns'] as string[] | undefined,
        LogDeliveryConfigurations: properties['LogDeliveryConfigurations'] as
          | LogDeliveryConfigurationRequest[]
          | undefined,
        NetworkType: properties['NetworkType'] as NetworkType | undefined,
        IpDiscovery: properties['IpDiscovery'] as IpDiscovery | undefined,
        TransitEncryptionEnabled: properties['TransitEncryptionEnabled'] as boolean | undefined,
        ...(tags.length > 0 && { Tags: tags }),
      })
    );
    clusterCreated = true;
    reportCreatedResource(logicalId, resourceType, cacheClusterId); // go-to-k/cdkd#5511

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
      if (endpoint.Address !== undefined) attributes['RedisEndpoint.Address'] = endpoint.Address;
      if (endpoint.Port !== undefined) attributes['RedisEndpoint.Port'] = String(endpoint.Port);
    }

    // Configuration endpoint (for Memcached clusters)
    if (described?.ConfigurationEndpoint) {
      const configurationEndpoint = described.ConfigurationEndpoint;
      if (configurationEndpoint.Address !== undefined) {
        attributes['ConfigurationEndpoint.Address'] = configurationEndpoint.Address;
      }
      if (configurationEndpoint.Port !== undefined) {
        attributes['ConfigurationEndpoint.Port'] = String(configurationEndpoint.Port);
      }
    }

    return {
      physicalId: cacheClusterId,
      attributes,
    };
  } catch (error) {
    const thrown =
      error instanceof ProvisioningError
        ? error
        : this.wrapCaughtError(
            mask,
            error,
            (text) =>
              new ProvisioningError(
                `Failed to create CacheCluster ${logicalId}: ${text}`,
                resourceType,
                logicalId,
                cacheClusterId,
                error instanceof Error ? error : undefined
              )
          );
    // go-to-k/cdkd#4583: the cluster exists and no state record will hold
    // it; never before CreateCacheCluster returned (another owner's name).
    if (clusterCreated) {
      markCreatedBeforeFailure(thrown, logicalId, resourceType, cacheClusterId);
    }
    throw thrown;
  }
}

export async function deleteCacheCluster(
  this: ElastiCacheProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  context?: DeleteContext
): Promise<void> {
  this.logger.debug(`Deleting CacheCluster ${logicalId}`);

  try {
    // `DeletionPolicy: Snapshot` (issue #1352): pass the atomic
    // final-snapshot parameter when the destroy call site passed an id.
    // ElastiCache only supports snapshots on Redis-engine clusters; a
    // Memcached cluster under `Snapshot` gets AWS's InvalidParameter
    // rejection surfaced as-is — matching CloudFormation's DELETE_FAILED
    // for the same template.
    const finalSnapshotId = context?.finalSnapshotIdentifier;
    try {
      await this.getClient().send(
        new DeleteCacheClusterCommand({
          CacheClusterId: physicalId,
          ...(finalSnapshotId ? { FinalSnapshotIdentifier: finalSnapshotId } : {}),
        })
      );
    } catch (deleteError) {
      // A delete already under way (an earlier attempt whose wait ran out)
      // is waited on, not failed: AWS refuses a second DeleteCacheCluster
      // with InvalidCacheClusterState. Confirmed by the cluster's STATUS,
      // never by the message. NOT when this delete asked for a final
      // snapshot: the delete in flight never took THIS request, so waiting
      // on it would report a snapshot that may not exist (#1352).
      if (
        finalSnapshotId !== undefined ||
        (deleteError as { name?: string } | undefined)?.name !== 'InvalidCacheClusterStateFault' ||
        (await this.describeCacheCluster(physicalId))?.CacheClusterStatus !== 'deleting'
      ) {
        throw deleteError;
      }
      this.logger.debug(safeMsg`CacheCluster ${logicalId} is already deleting; waiting for it`);
    }
    // Not the identifier: it embeds the physical id, which may be secret-derived
    // (#4111). It is `<sanitized physical id>-final-<UTC timestamp>` (docs/cli-destroy.md).
    if (finalSnapshotId) {
      this.logger.info(
        `Deleting CacheCluster ${logicalId} with a final snapshot (DeletionPolicy: Snapshot)`
      );
    }

    this.logger.debug(`Successfully initiated deletion of CacheCluster ${logicalId}`);

    // Wait for cluster to be fully deleted
    await this.waitForClusterDeleted(logicalId, physicalId, CACHE_DELETE_WAIT_MS);
  } catch (error) {
    if (this.isNotFoundError(error, 'CacheClusterNotFoundFault')) {
      const clientRegion = await this.getClient().config.region();
      assertRegionMatch(clientRegion, context?.expectedRegion, resourceType, logicalId, physicalId);
      this.logger.debug(`CacheCluster ${logicalId} does not exist, skipping deletion`);
      return;
    }
    const cause = error instanceof Error ? error : undefined;
    throw this.wrapDeleteError(
      context?.maskSecrets,
      error,
      (text) =>
        new ProvisioningError(
          `Failed to delete CacheCluster ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          physicalId,
          cause
        )
    );
  }
}

export async function describeCacheCluster(this: ElastiCacheProvider, cacheClusterId: string) {
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
export async function waitForClusterAvailable(
  this: ElastiCacheProvider,
  cacheClusterId: string,
  maxWaitMs = 600_000,
  expectedNodeType?: string,
  removedNodeIds: readonly string[] = []
): Promise<void> {
  const startTime = Date.now();
  let delay = 10_000;

  while (Date.now() - startTime < maxWaitMs) {
    const cluster = await this.describeCacheCluster(cacheClusterId);
    const status = cluster?.CacheClusterStatus;

    this.logger.debug(`CacheCluster ${cacheClusterId} status: ${status}`);

    // go-to-k/cdkd#5635: statuses the cluster never leaves on its own (a
    // seed RDB from SnapshotArns ElastiCache could not load leaves it
    // `restore-failed`): fail now, not at the cap.
    if (status !== undefined && TERMINAL_CLUSTER_STATUSES.has(status)) {
      throw new Error(
        safeMsg`CacheCluster ${cacheClusterId} is ${status} and will not become available. Check the cluster's events (aws elasticache describe-events --source-type cache-cluster --source-identifier ${cacheClusterId}) for the reason.`
      );
    }

    const liveNodeType = cluster?.CacheNodeType;
    // A removal is done when the describe lists none of the removed nodes
    // (issue #5441): right after the Modify the cluster can still read
    // `available` with every node present.
    const removalDone =
      removedNodeIds.length === 0 ||
      (cluster?.CacheNodes !== undefined &&
        !cluster.CacheNodes.some(
          (n) => n.CacheNodeId !== undefined && removedNodeIds.includes(n.CacheNodeId)
        ));
    if (
      status === 'available' &&
      removalDone &&
      (expectedNodeType === undefined || liveNodeType === expectedNodeType)
    ) {
      return;
    }
    // A removal AWS accepted and then dropped leaves the nodes listed on an
    // `available` cluster with no removal pending: fail now, not at the cap.
    if (
      !removalDone &&
      status === 'available' &&
      (cluster?.PendingModifiedValues?.CacheNodeIdsToRemove ?? []).length === 0 &&
      Date.now() - startTime > MODIFY_DROPPED_AFTER_MS
    ) {
      throw new Error(
        safeMsg`CacheCluster ${cacheClusterId} is available and still lists cache nodes ${removedNodeIds.join(', ')} with no removal pending; the removal was not applied. Check the cluster's events (aws elasticache describe-events) for the reason, then deploy again.`
      );
    }
    // A scale AWS accepted and then dropped leaves the cluster `available`
    // on its old type with nothing pending: fail now, not at the cap.
    if (
      expectedNodeType !== undefined &&
      liveNodeType !== expectedNodeType &&
      status === 'available' &&
      cluster?.PendingModifiedValues?.CacheNodeType === undefined &&
      Date.now() - startTime > MODIFY_DROPPED_AFTER_MS
    ) {
      throw new Error(
        safeMsg`CacheCluster ${cacheClusterId} is available with node type ${liveNodeType} and no node-type change pending; the change to ${expectedNodeType} was not applied. Check the cluster's events (aws elasticache describe-events) for the reason, then deploy again.`
      );
    }

    await this.sleep(delay);
    delay = Math.min(delay * 2, 10_000);
  }

  throw new Error(
    expectedNodeType === undefined && removedNodeIds.length === 0
      ? `Timed out waiting for CacheCluster ${cacheClusterId} to become available`
      : safeMsg`Timed out waiting for CacheCluster ${cacheClusterId} to become available` +
          (expectedNodeType === undefined ? '' : safeMsg` with node type ${expectedNodeType}`) +
          (removedNodeIds.length === 0
            ? ''
            : safeMsg` without cache nodes ${removedNodeIds.join(', ')}`)
  );
}

/**
 * Wait for a CacheCluster to be deleted
 */
export async function waitForClusterDeleted(
  this: ElastiCacheProvider,
  logicalId: string,
  cacheClusterId: string,
  maxWaitMs = 600_000
): Promise<void> {
  const startTime = Date.now();
  let delay = 10_000;

  while (Date.now() - startTime < maxWaitMs) {
    try {
      const cluster = await this.describeCacheCluster(cacheClusterId);
      const status = cluster?.CacheClusterStatus;

      this.logger.debug(`CacheCluster ${logicalId} status: ${status}`);

      if (!cluster) return;
    } catch (error) {
      if (this.isNotFoundError(error, 'CacheClusterNotFoundFault')) {
        return;
      }
      throw error;
    }

    await this.sleep(delay);
    delay = Math.min(delay * 2, 10_000);
  }

  throw new Error(`Timed out waiting for CacheCluster ${logicalId} to be deleted`);
}
