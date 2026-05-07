import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  DescribeCacheClustersCommand,
  DescribeCacheSubnetGroupsCommand,
  ListTagsForResourceCommand,
} from '@aws-sdk/client-elasticache';

const mockSend = vi.fn();

vi.mock('@aws-sdk/client-elasticache', async () => {
  const actual = await vi.importActual<typeof import('@aws-sdk/client-elasticache')>(
    '@aws-sdk/client-elasticache'
  );
  return {
    ...actual,
    ElastiCacheClient: vi.fn().mockImplementation(() => ({
      send: mockSend,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
  };
});

vi.mock('../../../src/utils/logger.js', () => {
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

import { ElastiCacheProvider } from '../../../src/provisioning/providers/elasticache-provider.js';

describe('ElastiCacheProvider.readCurrentState', () => {
  let provider: ElastiCacheProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new ElastiCacheProvider();
  });

  describe('AWS::ElastiCache::CacheCluster', () => {
    it('returns CFn-shaped properties from DescribeCacheClusters (happy path)', async () => {
      mockSend.mockResolvedValueOnce({
        CacheClusters: [
          {
            CacheClusterId: 'mycluster',
            Engine: 'redis',
            CacheNodeType: 'cache.t3.micro',
            NumCacheNodes: 1,
            CacheSubnetGroupName: 'default',
            EngineVersion: '7.0',
            CacheParameterGroup: { CacheParameterGroupName: 'default.redis7' },
            PreferredMaintenanceWindow: 'sun:05:00-sun:06:00',
            AutoMinorVersionUpgrade: true,
            CacheNodes: [{ Endpoint: { Address: 'host', Port: 6379 } }],
            SecurityGroups: [{ SecurityGroupId: 'sg-1' }, { SecurityGroupId: 'sg-2' }],
            TransitEncryptionEnabled: false,
          },
        ],
      });

      const result = await provider.readCurrentState(
        'mycluster',
        'L',
        'AWS::ElastiCache::CacheCluster'
      );

      expect(mockSend.mock.calls[0]?.[0]).toBeInstanceOf(DescribeCacheClustersCommand);
      expect(result).toEqual({
        ClusterName: 'mycluster',
        Engine: 'redis',
        CacheNodeType: 'cache.t3.micro',
        NumCacheNodes: 1,
        CacheSubnetGroupName: 'default',
        EngineVersion: '7.0',
        CacheParameterGroupName: 'default.redis7',
        PreferredMaintenanceWindow: 'sun:05:00-sun:06:00',
        AutoMinorVersionUpgrade: true,
        TransitEncryptionEnabled: false,
        Port: 6379,
        VpcSecurityGroupIds: ['sg-1', 'sg-2'],
      });
    });

    it('returns undefined when cluster is gone', async () => {
      mockSend.mockRejectedValueOnce(
        Object.assign(new Error('cluster not found'), { name: 'CacheClusterNotFoundFault' })
      );
      const result = await provider.readCurrentState(
        'mycluster',
        'L',
        'AWS::ElastiCache::CacheCluster'
      );
      expect(result).toBeUndefined();
    });
  });

  describe('AWS::ElastiCache::SubnetGroup', () => {
    it('returns CFn-shaped SubnetGroup properties (happy path)', async () => {
      mockSend.mockResolvedValueOnce({
        CacheSubnetGroups: [
          {
            CacheSubnetGroupName: 'mygrp',
            CacheSubnetGroupDescription: 'mygrp description',
            Subnets: [
              { SubnetIdentifier: 'subnet-a' },
              { SubnetIdentifier: 'subnet-b' },
            ],
          },
        ],
      });

      const result = await provider.readCurrentState(
        'mygrp',
        'L',
        'AWS::ElastiCache::SubnetGroup'
      );

      expect(mockSend.mock.calls[0]?.[0]).toBeInstanceOf(DescribeCacheSubnetGroupsCommand);
      expect(result).toEqual({
        CacheSubnetGroupName: 'mygrp',
        CacheSubnetGroupDescription: 'mygrp description',
        SubnetIds: ['subnet-a', 'subnet-b'],
      });
    });

    it('returns undefined when subnet group is gone', async () => {
      mockSend.mockRejectedValueOnce(
        Object.assign(new Error('not found'), { name: 'CacheSubnetGroupNotFoundFault' })
      );
      const result = await provider.readCurrentState(
        'mygrp',
        'L',
        'AWS::ElastiCache::SubnetGroup'
      );
      expect(result).toBeUndefined();
    });
  });

  it('surfaces CacheCluster Tags from ListTagsForResource with aws:* filtered out', async () => {
    mockSend
      .mockResolvedValueOnce({
        CacheClusters: [
          {
            CacheClusterId: 'mycluster',
            ARN: 'arn:aws:elasticache:us-east-1:1:cluster:mycluster',
          },
        ],
      })
      .mockResolvedValueOnce({
        TagList: [
          { Key: 'Foo', Value: 'Bar' },
          { Key: 'aws:cdk:path', Value: 'MyStack/MyCluster/Resource' },
        ],
      });

    const result = await provider.readCurrentState(
      'mycluster',
      'L',
      'AWS::ElastiCache::CacheCluster'
    );

    expect(mockSend.mock.calls[1]?.[0]).toBeInstanceOf(ListTagsForResourceCommand);
    expect(result?.Tags).toEqual([{ Key: 'Foo', Value: 'Bar' }]);
  });

  it('omits Tags when ListTagsForResource returns no user tags', async () => {
    mockSend
      .mockResolvedValueOnce({
        CacheClusters: [
          {
            CacheClusterId: 'mycluster',
            ARN: 'arn:aws:elasticache:us-east-1:1:cluster:mycluster',
          },
        ],
      })
      .mockResolvedValueOnce({
        TagList: [{ Key: 'aws:cdk:path', Value: 'MyStack/MyCluster/Resource' }],
      });

    const result = await provider.readCurrentState(
      'mycluster',
      'L',
      'AWS::ElastiCache::CacheCluster'
    );

    expect(result?.Tags).toEqual([]);
  });
});
