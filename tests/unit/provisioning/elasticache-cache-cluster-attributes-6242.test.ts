/**
 * go-to-k/cdkd#6242: the whole `RedisEndpoint` / `ConfigurationEndpoint`
 * objects are assembled by the resolver from the flat keys
 * `cacheClusterAttributes` records; create and update already recorded them,
 * and `import()` (the stale-attribute heal's read) recorded nothing. All three
 * now build the map through the one helper.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { DescribeCacheClustersCommand } from '@aws-sdk/client-elasticache';

const mockSend = vi.hoisted(() => vi.fn());
vi.mock('@aws-sdk/client-elasticache', async () => ({
  ...(await vi.importActual('@aws-sdk/client-elasticache')),
  ElastiCacheClient: vi.fn().mockImplementation(() => ({
    send: mockSend,
    config: { region: () => Promise.resolve('us-east-1') },
  })),
}));
vi.mock('../../../src/utils/logger.js', () => {
  const fns = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { getLogger: () => ({ ...fns, child: () => fns }) };
});

import { ElastiCacheProvider } from '../../../src/provisioning/providers/elasticache-provider.js';
import { cacheClusterAttributes } from '../../../src/provisioning/providers/elasticache/cache-cluster-attributes.js';

const MEMCACHED = {
  CacheClusterId: 'mc',
  CacheClusterStatus: 'available',
  CacheNodes: [{ Endpoint: { Address: 'mc.x.0001.use1.cache.amazonaws.com', Port: 11211 } }],
  ConfigurationEndpoint: { Address: 'mc.x.cfg.use1.cache.amazonaws.com', Port: 11211 },
};

describe('cacheClusterAttributes (#6242)', () => {
  it('records both endpoints as flat keys with string ports', () => {
    expect(cacheClusterAttributes(MEMCACHED)).toStrictEqual({
      'RedisEndpoint.Address': 'mc.x.0001.use1.cache.amazonaws.com',
      'RedisEndpoint.Port': '11211',
      'ConfigurationEndpoint.Address': 'mc.x.cfg.use1.cache.amazonaws.com',
      'ConfigurationEndpoint.Port': '11211',
    });
  });

  it('leaves an endpoint the cluster does not report ABSENT', () => {
    expect(cacheClusterAttributes({ CacheClusterStatus: 'creating' })).toStrictEqual({});
    expect(cacheClusterAttributes(undefined)).toStrictEqual({});
  });
});

describe('ElastiCacheProvider import() records the cluster attributes (#6242)', () => {
  beforeEach(() => mockSend.mockReset());

  it('asks for node info and records the same map create and update record', async () => {
    mockSend.mockResolvedValueOnce({ CacheClusters: [MEMCACHED] });
    const result = await new ElastiCacheProvider().import({
      logicalId: 'Mc',
      resourceType: 'AWS::ElastiCache::CacheCluster',
      stackName: 'S',
      region: 'us-east-1',
      properties: {},
      knownPhysicalId: 'mc',
    });
    expect(result?.attributes).toStrictEqual(cacheClusterAttributes(MEMCACHED));
    const cmd = mockSend.mock.calls[0]![0] as DescribeCacheClustersCommand;
    expect(cmd).toBeInstanceOf(DescribeCacheClustersCommand);
    expect(cmd.input).toStrictEqual({ CacheClusterId: 'mc', ShowCacheNodeInfo: true });
  });
});
