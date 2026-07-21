import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const mockEcSend = vi.hoisted(() => vi.fn());

vi.mock('@aws-sdk/client-elasticache', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-elasticache')>();
  return {
    ...actual,
    ElastiCacheClient: vi.fn().mockImplementation(() => ({
      send: mockEcSend,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
  };
});

vi.mock('../../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  return {
    getLogger: () => ({
      child: () => childLogger,
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  };
});

import { ElastiCacheProvider } from '../../../../src/provisioning/providers/elasticache-provider.js';

describe('ElastiCacheProvider import', () => {
  let provider: ElastiCacheProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new ElastiCacheProvider();
  });

  function makeClusterInput(overrides: Record<string, unknown> = {}) {
    return {
      logicalId: 'MyCluster',
      resourceType: 'AWS::ElastiCache::CacheCluster',
      stackName: 'MyStack',
      region: 'us-east-1',
      properties: {},
      ...overrides,
    };
  }

  it('CacheCluster explicit override: DescribeCacheClusters verifies', async () => {
    mockEcSend.mockResolvedValueOnce({
      CacheClusters: [{ CacheClusterId: 'adopted-cluster' }],
    });

    const result = await provider.import(
      makeClusterInput({ knownPhysicalId: 'adopted-cluster' })
    );

    expect(result).toEqual({ physicalId: 'adopted-cluster', attributes: {} });
    const call = mockEcSend.mock.calls[0][0];
    expect(call.constructor.name).toBe('DescribeCacheClustersCommand');
    expect(call.input).toEqual({ CacheClusterId: 'adopted-cluster' });
  });

  // The `aws:cdk:path` tag walk was removed in issue #1134: AWS rejects
  // `aws:`-prefixed tag writes, so that tag never exists on a real resource
  // and the walk could not match. Without an explicit override or a template
  // physical name, import must report not-found without any AWS call.
  it('CacheCluster returns null with no override and issues no AWS call', async () => {
    const result = await provider.import(makeClusterInput());
    expect(result).toBeNull();
    expect(mockEcSend).not.toHaveBeenCalled();
  });

  it('SubnetGroup explicit override: DescribeCacheSubnetGroups verifies', async () => {
    mockEcSend.mockResolvedValueOnce({
      CacheSubnetGroups: [{ CacheSubnetGroupName: 'my-sg' }],
    });

    const result = await provider.import({
      logicalId: 'MySG',
      resourceType: 'AWS::ElastiCache::SubnetGroup',
      stackName: 'MyStack',
      region: 'us-east-1',
      properties: { CacheSubnetGroupName: 'my-sg' },
    });

    expect(result).toEqual({ physicalId: 'my-sg', attributes: {} });
    const call = mockEcSend.mock.calls[0][0];
    expect(call.constructor.name).toBe('DescribeCacheSubnetGroupsCommand');
  });

  it('SubnetGroup returns null with no override and issues no AWS call', async () => {
    const result = await provider.import({
      logicalId: 'MySG',
      resourceType: 'AWS::ElastiCache::SubnetGroup',
      stackName: 'MyStack',
      region: 'us-east-1',
      properties: {},
    });

    expect(result).toBeNull();
    expect(mockEcSend).not.toHaveBeenCalled();
  });
});
