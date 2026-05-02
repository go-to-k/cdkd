import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockEcSend = vi.hoisted(() => vi.fn());
const mockStsSend = vi.hoisted(() => vi.fn());

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

vi.mock('@aws-sdk/client-sts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-sts')>();
  return {
    ...actual,
    STSClient: vi.fn().mockImplementation(() => ({ send: mockStsSend })),
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
    mockStsSend.mockResolvedValue({ Account: '123456789012' });
    provider = new ElastiCacheProvider();
  });

  function makeClusterInput(overrides: Record<string, unknown> = {}) {
    return {
      logicalId: 'MyCluster',
      resourceType: 'AWS::ElastiCache::CacheCluster',
      cdkPath: 'MyStack/MyCluster',
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

  it('CacheCluster tag-based lookup: matches aws:cdk:path via ListTagsForResource on TagList', async () => {
    const otherArn = 'arn:aws:elasticache:us-east-1:123456789012:cluster:other';
    const targetArn = 'arn:aws:elasticache:us-east-1:123456789012:cluster:target';
    // DescribeCacheClusters
    mockEcSend.mockResolvedValueOnce({
      CacheClusters: [
        { CacheClusterId: 'other', ARN: otherArn },
        { CacheClusterId: 'target', ARN: targetArn },
      ],
    });
    // ListTagsForResource(other)
    mockEcSend.mockResolvedValueOnce({
      TagList: [{ Key: 'aws:cdk:path', Value: 'OtherStack/Other' }],
    });
    // ListTagsForResource(target)
    mockEcSend.mockResolvedValueOnce({
      TagList: [{ Key: 'aws:cdk:path', Value: 'MyStack/MyCluster' }],
    });

    const result = await provider.import(makeClusterInput());
    expect(result).toEqual({ physicalId: 'target', attributes: {} });
  });

  it('CacheCluster returns null when nothing matches', async () => {
    mockEcSend.mockResolvedValueOnce({
      CacheClusters: [
        {
          CacheClusterId: 'only',
          ARN: 'arn:aws:elasticache:us-east-1:123456789012:cluster:only',
        },
      ],
    });
    mockEcSend.mockResolvedValueOnce({
      TagList: [{ Key: 'aws:cdk:path', Value: 'OtherStack/Other' }],
    });

    const result = await provider.import(makeClusterInput());
    expect(result).toBeNull();
  });

  it('SubnetGroup tag-based lookup: matches via DescribeCacheSubnetGroups + ListTagsForResource', async () => {
    const arn = 'arn:aws:elasticache:us-east-1:123456789012:subnetgroup:my-sg';
    mockEcSend.mockResolvedValueOnce({
      CacheSubnetGroups: [{ CacheSubnetGroupName: 'my-sg', ARN: arn }],
    });
    mockEcSend.mockResolvedValueOnce({
      TagList: [{ Key: 'aws:cdk:path', Value: 'MyStack/MySG' }],
    });

    const result = await provider.import({
      logicalId: 'MySG',
      resourceType: 'AWS::ElastiCache::SubnetGroup',
      cdkPath: 'MyStack/MySG',
      stackName: 'MyStack',
      region: 'us-east-1',
      properties: {},
    });

    expect(result).toEqual({ physicalId: 'my-sg', attributes: {} });
  });
});
