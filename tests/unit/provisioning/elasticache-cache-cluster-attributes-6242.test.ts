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
  ElastiCacheClient: vi.fn(() => ({
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
  Engine: 'memcached',
  CacheClusterStatus: 'available',
  CacheNodes: [{ Endpoint: { Address: 'mc.x.0001.use1.cache.amazonaws.com', Port: 11211 } }],
  ConfigurationEndpoint: { Address: 'mc.x.cfg.use1.cache.amazonaws.com', Port: 11211 },
};

describe('cacheClusterAttributes (#6242)', () => {
  it('records a Memcached cluster configuration endpoint, and NOT its node endpoint as RedisEndpoint', () => {
    // Maintainer decision: CloudFormation answers an empty RedisEndpoint on
    // Memcached (measured); cdkd records none and the resolver refuses it.
    expect(cacheClusterAttributes(MEMCACHED)).toStrictEqual({
      'ConfigurationEndpoint.Address': 'mc.x.cfg.use1.cache.amazonaws.com',
      'ConfigurationEndpoint.Port': '11211',
    });
  });

  it('matches the Memcached engine case-insensitively', () => {
    expect(cacheClusterAttributes({ ...MEMCACHED, Engine: 'Memcached' })).toStrictEqual({
      'ConfigurationEndpoint.Address': 'mc.x.cfg.use1.cache.amazonaws.com',
      'ConfigurationEndpoint.Port': '11211',
    });
  });

  it.each(['redis', 'valkey'])('records a %s cluster node endpoint as RedisEndpoint, string port', (engine) => {
    expect(
      cacheClusterAttributes({
        Engine: engine,
        CacheNodes: [{ Endpoint: { Address: 'r.x.0001.use1.cache.amazonaws.com', Port: 6379 } }],
      })
    ).toStrictEqual({
      'RedisEndpoint.Address': 'r.x.0001.use1.cache.amazonaws.com',
      'RedisEndpoint.Port': '6379',
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
