import type { CacheCluster } from '@aws-sdk/client-elasticache';
import { definedAttributes, stringifyIfAssigned } from '../../attribute-map.js';

/**
 * The `Fn::GetAtt` attributes an ElastiCache cache cluster records, from a
 * `DescribeCacheClusters` (`ShowCacheNodeInfo: true`) cluster: create, update
 * and `import()` all build it here, so the key sets cannot drift apart —
 * `attributes` REPLACES the record on update.
 *
 * The members are FLAT dot-keys with CloudFormation's string `Port`; the whole
 * `RedisEndpoint` / `ConfigurationEndpoint` object is assembled from them by
 * the resolver (`flatMemberObject`, go-to-k/cdkd#6242), so a member and its
 * object come from one recorded value. An endpoint the response does not
 * carry (a configuration endpoint on a Redis cluster, any endpoint while the
 * cluster is still `creating` under `--no-wait`) stays ABSENT, never `''`.
 */
export function cacheClusterAttributes(cluster: CacheCluster | undefined): Record<string, unknown> {
  const node = cluster?.CacheNodes?.[0]?.Endpoint;
  const configuration = cluster?.ConfigurationEndpoint;
  return definedAttributes({
    'RedisEndpoint.Address': node?.Address,
    'RedisEndpoint.Port': stringifyIfAssigned(node?.Port),
    'ConfigurationEndpoint.Address': configuration?.Address,
    'ConfigurationEndpoint.Port': stringifyIfAssigned(configuration?.Port),
  });
}
