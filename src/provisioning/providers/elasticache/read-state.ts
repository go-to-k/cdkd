import type { ElastiCacheProvider } from '../elasticache-provider.js';
import {
  DescribeCacheClustersCommand,
  DescribeCacheSubnetGroupsCommand,
  ListTagsForResourceCommand,
  type LogDeliveryConfiguration,
} from '@aws-sdk/client-elasticache';
import { inDeclaredOrder } from '../../declared-order.js';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import { normalizeAwsTagsToCfn } from '../../import-helpers.js';
import type { ResourceNotFound } from '../../../types/resource.js';
import { RESOURCE_NOT_FOUND } from '../../../types/resource.js';

/**
 * Read the AWS-current ElastiCache resource configuration in CFn-property shape.
 *
 * Dispatch per resource type:
 *  - `CacheCluster` → `DescribeCacheClusters` filtered by `CacheClusterId`,
 *    surfacing `Engine`, `CacheNodeType`, `NumCacheNodes`,
 *    `CacheSubnetGroupName`, `Port`, `EngineVersion`,
 *    `CacheParameterGroupName`, `PreferredMaintenanceWindow`,
 *    `PreferredAvailabilityZone`, `SnapshotRetentionLimit`,
 *    `SnapshotWindow`, `AutoMinorVersionUpgrade`, `NotificationTopicArn`,
 *    `IpDiscovery`, `NetworkType`, `TransitEncryptionEnabled`, plus
 *    `VpcSecurityGroupIds` derived from the cluster's `SecurityGroups[]`,
 *    `LogDeliveryConfigurations`, and a declared `PreferredAvailabilityZones`
 *    from `CacheNodes[].CustomerAvailabilityZone` (go-to-k/cdkd#6757).
 *  - `SubnetGroup` → `DescribeCacheSubnetGroups` filtered by name,
 *    surfacing `CacheSubnetGroupName`, `CacheSubnetGroupDescription`,
 *    and `SubnetIds` derived from `Subnets[].SubnetIdentifier`.
 *
 * Tags are surfaced via a follow-up `ListTagsForResource(ResourceName=arn)`
 * for both types (ARN derived from `cluster.ARN` / `group.ARN`). CDK's
 * `aws:*` auto-tags are filtered out and the result key is omitted when
 * AWS reports no user tags. Returns `RESOURCE_NOT_FOUND` when the resource
 * is gone (`*NotFoundFault` or an empty describe list).
 */
export async function readCurrentState(
  this: ElastiCacheProvider,
  physicalId: string,
  _logicalId: string,
  resourceType: string,
  properties?: Record<string, unknown>
): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
  switch (resourceType) {
    case 'AWS::ElastiCache::CacheCluster':
      return this.readCacheCluster(physicalId, properties);
    case 'AWS::ElastiCache::SubnetGroup':
      return this.readSubnetGroup(physicalId);
    default:
      return undefined;
  }
}

export async function readCacheCluster(
  this: ElastiCacheProvider,
  physicalId: string,
  properties?: Record<string, unknown>
): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
  let cluster;
  try {
    const resp = await this.getClient().send(
      new DescribeCacheClustersCommand({
        CacheClusterId: physicalId,
        ShowCacheNodeInfo: true,
      })
    );
    cluster = resp.CacheClusters?.[0];
  } catch (err) {
    // go-to-k/cdkd#4283: only the fault NAME proves the resource is gone;
    // the looser message match keeps its old "cannot tell" answer.
    if ((err as { name?: unknown } | null)?.name === 'CacheClusterNotFoundFault')
      return RESOURCE_NOT_FOUND;
    if (this.isNotFoundError(err, 'CacheClusterNotFoundFault')) return undefined;
    throw err;
  }
  if (!cluster) return RESOURCE_NOT_FOUND;

  const result: Record<string, unknown> = {};
  if (cluster.CacheClusterId !== undefined) result['ClusterName'] = cluster.CacheClusterId;
  if (cluster.Engine !== undefined) result['Engine'] = cluster.Engine;
  if (cluster.CacheNodeType !== undefined) result['CacheNodeType'] = cluster.CacheNodeType;
  if (cluster.NumCacheNodes !== undefined) result['NumCacheNodes'] = cluster.NumCacheNodes;
  if (cluster.CacheSubnetGroupName !== undefined) {
    result['CacheSubnetGroupName'] = cluster.CacheSubnetGroupName;
  }
  if (cluster.EngineVersion !== undefined) result['EngineVersion'] = cluster.EngineVersion;
  if (cluster.CacheParameterGroup?.CacheParameterGroupName !== undefined) {
    result['CacheParameterGroupName'] = cluster.CacheParameterGroup.CacheParameterGroupName;
  }
  if (cluster.PreferredMaintenanceWindow !== undefined) {
    result['PreferredMaintenanceWindow'] = cluster.PreferredMaintenanceWindow;
  }
  if (cluster.PreferredAvailabilityZone !== undefined) {
    result['PreferredAvailabilityZone'] = cluster.PreferredAvailabilityZone;
  }
  if (cluster.SnapshotRetentionLimit !== undefined) {
    result['SnapshotRetentionLimit'] = cluster.SnapshotRetentionLimit;
  }
  if (cluster.SnapshotWindow !== undefined) result['SnapshotWindow'] = cluster.SnapshotWindow;
  if (cluster.AutoMinorVersionUpgrade !== undefined) {
    result['AutoMinorVersionUpgrade'] = cluster.AutoMinorVersionUpgrade;
  }
  // An `inactive` topic (set outside cdkd; cdkd no longer sends the
  // inactive status on removal, #5004) means "no notification topic
  // configured", so gate the emit on the status.
  if (
    cluster.NotificationConfiguration?.TopicArn !== undefined &&
    cluster.NotificationConfiguration.TopicStatus !== 'inactive'
  ) {
    result['NotificationTopicArn'] = cluster.NotificationConfiguration.TopicArn;
  }
  if (cluster.IpDiscovery !== undefined) result['IpDiscovery'] = cluster.IpDiscovery;
  if (cluster.NetworkType !== undefined) result['NetworkType'] = cluster.NetworkType;
  // Class 1 gate: `TransitEncryptionEnabled` is redis-only on
  // CreateCacheClusterCommand. AWS DescribeCacheClusters returns the
  // field for both engines (false for memcached), but emitting it on
  // a memcached cluster would, if any future `update()` change ships
  // it to ModifyCacheClusterCommand, get rejected with "TransitEncryption
  // is only valid for Redis". Gate the read-side emit on the engine
  // discriminator so the placeholder cannot leak through round-trip.
  if (cluster.Engine === 'redis' && cluster.TransitEncryptionEnabled !== undefined) {
    result['TransitEncryptionEnabled'] = cluster.TransitEncryptionEnabled;
  }
  if (cluster.CacheNodes?.[0]?.Endpoint?.Port !== undefined) {
    result['Port'] = cluster.CacheNodes[0].Endpoint.Port;
  }
  const sgIds = (cluster.SecurityGroups ?? [])
    .map((sg) => sg.SecurityGroupId)
    .filter((id): id is string => !!id);
  result['VpcSecurityGroupIds'] = sgIds;
  result['LogDeliveryConfigurations'] = readbackLogDelivery(
    cluster.LogDeliveryConfigurations ?? [],
    properties?.['LogDeliveryConfigurations']
  );
  // go-to-k/cdkd#6757: the zones the live nodes occupy, for a record that
  // declares the list, in the declared order (`inDeclaredOrder`), so a node
  // added, removed or placed in another zone out of band differs from it. A
  // node being deleted is no longer one of the cluster's.
  const declaredZones = properties?.['PreferredAvailabilityZones'];
  if (Array.isArray(declaredZones)) {
    result['PreferredAvailabilityZones'] = inDeclaredOrder(
      (cluster.CacheNodes ?? []).flatMap((node) =>
        node.CacheNodeStatus !== 'deleting' && node.CustomerAvailabilityZone !== undefined
          ? [node.CustomerAvailabilityZone]
          : []
      ),
      (zone) => zone,
      declaredZones
    );
  }

  if (cluster.ARN) await this.attachTags(result, cluster.ARN);
  return result;
}

/** A delivery AWS is turning off: what `update()` sends for a removed log type. */
const LEAVING_LOG_DELIVERY_STATUSES: ReadonlySet<string> = new Set(['disabling']);

/**
 * The cluster's `LogDeliveryConfigurations` in the CloudFormation shape
 * (go-to-k/cdkd#6757), in the declared `LogType` order. Always emitted, `[]`
 * when none is on: `update()` turns a removed log type off
 * (`buildLogDeliveryConfigurationsForUpdate`), so no delivery is what an unset
 * property leaves. A delivery being turned off is left out.
 */
function readbackLogDelivery(
  live: readonly LogDeliveryConfiguration[],
  declared: unknown
): Record<string, unknown>[] {
  const entries = live
    .filter((config) => !LEAVING_LOG_DELIVERY_STATUSES.has(config.Status ?? ''))
    .map((config) => {
      const entry: Record<string, unknown> = {};
      if (config.LogType !== undefined) entry['LogType'] = config.LogType;
      if (config.DestinationType !== undefined) entry['DestinationType'] = config.DestinationType;
      const details = config.DestinationDetails;
      if (details !== undefined) {
        const out: Record<string, unknown> = {};
        const logGroup = details.CloudWatchLogsDetails?.LogGroup;
        if (logGroup !== undefined) out['CloudWatchLogsDetails'] = { LogGroup: logGroup };
        const stream = details.KinesisFirehoseDetails?.DeliveryStream;
        if (stream !== undefined) out['KinesisFirehoseDetails'] = { DeliveryStream: stream };
        entry['DestinationDetails'] = out;
      }
      if (config.LogFormat !== undefined) entry['LogFormat'] = config.LogFormat;
      return entry;
    });
  return inDeclaredOrder(
    entries,
    (entry) => entry['LogType'] as string | undefined,
    Array.isArray(declared)
      ? declared.map((d) =>
          d !== null && typeof d === 'object' ? (d as Record<string, unknown>)['LogType'] : d
        )
      : undefined
  );
}

export async function readSubnetGroup(
  this: ElastiCacheProvider,
  physicalId: string
): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
  let group;
  try {
    const resp = await this.getClient().send(
      new DescribeCacheSubnetGroupsCommand({ CacheSubnetGroupName: physicalId })
    );
    group = resp.CacheSubnetGroups?.[0];
  } catch (err) {
    // go-to-k/cdkd#4283: only the fault NAME proves the resource is gone;
    // the looser message match keeps its old "cannot tell" answer.
    if ((err as { name?: unknown } | null)?.name === 'CacheSubnetGroupNotFoundFault')
      return RESOURCE_NOT_FOUND;
    if (this.isNotFoundError(err, 'CacheSubnetGroupNotFoundFault')) return undefined;
    throw err;
  }
  if (!group) return RESOURCE_NOT_FOUND;

  const result: Record<string, unknown> = {};
  if (group.CacheSubnetGroupName !== undefined) {
    result['CacheSubnetGroupName'] = group.CacheSubnetGroupName;
  }
  if (group.CacheSubnetGroupDescription !== undefined) {
    // CFn schema spells the description `Description`; AWS API uses
    // `CacheSubnetGroupDescription`. Emit BOTH so drift comparison
    // works for state files written by either name (#613 B-bucket fix).
    result['CacheSubnetGroupDescription'] = group.CacheSubnetGroupDescription;
    result['Description'] = group.CacheSubnetGroupDescription;
  }
  const subnetIds = (group.Subnets ?? [])
    .map((s) => s.SubnetIdentifier)
    .filter((id): id is string => !!id);
  result['SubnetIds'] = subnetIds;
  if (group.ARN) await this.attachTags(result, group.ARN);
  return result;
}

/** The not-found faults of the resources {@link attachTags} reads tags for. */
const TAGGED_RESOURCE_NOT_FOUND_FAULTS: ReadonlySet<string> = new Set([
  'CacheClusterNotFoundFault',
  'ReplicationGroupNotFoundFault',
]);

/**
 * Tag fetch. Only a resource gone between the calls (its not-found fault, by
 * NAME) omits the key; any other failure throws, so `cdkd drift` reports the
 * resource not compared instead of never comparing its Tags
 * (go-to-k/cdkd#6759).
 */
export async function attachTags(
  this: ElastiCacheProvider,
  result: Record<string, unknown>,
  arn: string
): Promise<void> {
  try {
    const tagsResp = await this.getClient().send(
      new ListTagsForResourceCommand({ ResourceName: arn })
    );
    const tags = normalizeAwsTagsToCfn(tagsResp.TagList);
    result['Tags'] = tags;
  } catch (err) {
    const name = (err as { name?: unknown } | null)?.name;
    if (typeof name !== 'string' || !TAGGED_RESOURCE_NOT_FOUND_FAULTS.has(name)) throw err;
    this.logger.debug(
      `ElastiCache ListTagsForResource(${arn}) failed: ${describeAwsFailure(err).detail}`
    );
  }
}
