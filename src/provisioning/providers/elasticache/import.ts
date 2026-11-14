import type { ElastiCacheProvider } from '../elasticache-provider.js';
import {
  DescribeCacheClustersCommand,
  DescribeCacheSubnetGroupsCommand,
} from '@aws-sdk/client-elasticache';
import { resolveExplicitPhysicalId } from '../../import-helpers.js';
import { cacheClusterAttributes } from './cache-cluster-attributes.js';
import type { ResourceImportInput, ResourceImportResult } from '../../../types/resource.js';

/**
 * Adopt an existing ElastiCache resource into cdkd state.
 *
 * Supported types (both resolve from an explicit `--resource` override
 * or the template's physical-name property, verified via the matching
 * `Describe*` call):
 *  - `AWS::ElastiCache::CacheCluster` — `Properties.ClusterName`.
 *  - `AWS::ElastiCache::SubnetGroup` — `Properties.CacheSubnetGroupName`.
 */
export async function importImpl(
  this: ElastiCacheProvider,
  input: ResourceImportInput
): Promise<ResourceImportResult | null> {
  switch (input.resourceType) {
    case 'AWS::ElastiCache::CacheCluster':
      return this.importCacheCluster(input);
    case 'AWS::ElastiCache::SubnetGroup':
      return this.importSubnetGroup(input);
    default:
      return null;
  }
}

export async function importCacheCluster(
  this: ElastiCacheProvider,
  input: ResourceImportInput
): Promise<ResourceImportResult | null> {
  const explicit = resolveExplicitPhysicalId(input, 'ClusterName');
  if (explicit) {
    try {
      const resp = await this.getClient().send(
        new DescribeCacheClustersCommand({ CacheClusterId: explicit, ShowCacheNodeInfo: true })
      );
      const c = resp.CacheClusters?.[0];
      // The same attribute set create / update record (go-to-k/cdkd#6242).
      return c?.CacheClusterId
        ? { physicalId: c.CacheClusterId, attributes: cacheClusterAttributes(c) }
        : null;
    } catch (err) {
      if (this.isNotFoundError(err, 'CacheClusterNotFoundFault')) return null;
      throw err;
    }
  }

  // No `aws:cdk:path` tag walk: AWS rejects `aws:`-prefixed tag writes, so
  // that tag never exists on a real resource and the walk could not match
  // (issue #1134). Auto-mode import resolves ids from CloudFormation's
  // `DescribeStackResources` or the template's physical-name property; a
  // cache cluster reaching here needs an explicit `--resource` override.
  return null;
}

export async function importSubnetGroup(
  this: ElastiCacheProvider,
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

  // No `aws:cdk:path` tag walk: AWS rejects `aws:`-prefixed tag writes, so
  // that tag never exists on a real resource and the walk could not match
  // (issue #1134). Auto-mode import resolves ids from CloudFormation's
  // `DescribeStackResources` or the template's physical-name property; a
  // subnet group reaching here needs an explicit `--resource` override.
  return null;
}
