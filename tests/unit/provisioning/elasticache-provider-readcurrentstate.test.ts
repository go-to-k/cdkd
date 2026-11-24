import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
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
    ElastiCacheClient: vi.fn(() => ({
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
    child: vi.fn(function (this: unknown) { return this; }),
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
import { RESOURCE_NOT_FOUND } from '../../../src/types/resource.js';

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
        LogDeliveryConfigurations: [],
      });
    });

    it('returns RESOURCE_NOT_FOUND when cluster is gone', async () => {
      mockSend.mockRejectedValueOnce(
        Object.assign(new Error('cluster not found'), { name: 'CacheClusterNotFoundFault' })
      );
      const result = await provider.readCurrentState(
        'mycluster',
        'L',
        'AWS::ElastiCache::CacheCluster'
      );
      expect(result).toBe(RESOURCE_NOT_FOUND);
    });

    it('returns RESOURCE_NOT_FOUND when DescribeCacheClusters lists no cluster', async () => {
      mockSend.mockResolvedValueOnce({ CacheClusters: [] });
      const result = await provider.readCurrentState(
        'mycluster',
        'L',
        'AWS::ElastiCache::CacheCluster'
      );
      expect(result).toBe(RESOURCE_NOT_FOUND);
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
        // CFn-canonical alias (#613 B-bucket fix) — emitted alongside the
        // AWS-API-named `CacheSubnetGroupDescription` so drift comparison
        // works for both template shapes.
        Description: 'mygrp description',
        SubnetIds: ['subnet-a', 'subnet-b'],
      });
    });

    it('returns RESOURCE_NOT_FOUND when subnet group is gone', async () => {
      mockSend.mockRejectedValueOnce(
        Object.assign(new Error('not found'), { name: 'CacheSubnetGroupNotFoundFault' })
      );
      const result = await provider.readCurrentState(
        'mygrp',
        'L',
        'AWS::ElastiCache::SubnetGroup'
      );
      expect(result).toBe(RESOURCE_NOT_FOUND);
    });

    it('returns RESOURCE_NOT_FOUND when DescribeCacheSubnetGroups lists no group', async () => {
      mockSend.mockResolvedValueOnce({ CacheSubnetGroups: [] });
      const result = await provider.readCurrentState(
        'mygrp',
        'L',
        'AWS::ElastiCache::SubnetGroup'
      );
      expect(result).toBe(RESOURCE_NOT_FOUND);
    });
  });

  // go-to-k/cdkd#4283: only the exact fault NAME proves the resource is gone.
  describe('fault name vs message (go-to-k/cdkd#4283)', () => {
    const READ_TYPES = ['AWS::ElastiCache::CacheCluster', 'AWS::ElastiCache::SubnetGroup'];

    it.each(READ_TYPES)(
      'keeps undefined for %s on a message-only "not found" under another fault name',
      async (type) => {
        mockSend.mockRejectedValueOnce(
          Object.assign(new Error('CacheParameterGroup default.x not found'), {
            name: 'CacheParameterGroupNotFoundFault',
          })
        );
        const result = await provider.readCurrentState('x', 'L', type);
        expect(result).toBeUndefined();
      }
    );

    it.each(READ_TYPES)(
      'rethrows an AccessDenied describe error for %s rather than reporting it gone',
      async (type) => {
        mockSend.mockRejectedValueOnce(
          Object.assign(new Error('User is not authorized'), { name: 'AccessDenied' })
        );
        await expect(provider.readCurrentState('x', 'L', type)).rejects.toThrow(
          'User is not authorized'
        );
      }
    );
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
    expect((result as Record<string, unknown> | undefined)?.Tags).toEqual([{ Key: 'Foo', Value: 'Bar' }]);
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

    expect((result as Record<string, unknown> | undefined)?.Tags).toEqual([]);
  });
});

describe('ElastiCache CacheCluster readback gaps (go-to-k/cdkd#6757)', () => {
  let provider: ElastiCacheProvider;

  beforeEach(() => {
    mockSend.mockReset();
    provider = new ElastiCacheProvider();
  });

  const read = async (
    cluster: Record<string, unknown>,
    properties?: Record<string, unknown>
  ): Promise<Record<string, unknown>> => {
    mockSend.mockResolvedValueOnce({ CacheClusters: [{ CacheClusterId: 'c', ...cluster }] });
    return (await provider.readCurrentState(
      'c',
      'L',
      'AWS::ElastiCache::CacheCluster',
      properties
    )) as Record<string, unknown>;
  };

  it('reads LogDeliveryConfigurations in the CloudFormation shape, in declared LogType order', async () => {
    const result = await read(
      {
        LogDeliveryConfigurations: [
          {
            LogType: 'engine-log',
            DestinationType: 'kinesis-firehose',
            DestinationDetails: { KinesisFirehoseDetails: { DeliveryStream: 'ds' } },
            LogFormat: 'json',
            Status: 'active',
            Message: 'ok',
          },
          {
            LogType: 'slow-log',
            DestinationType: 'cloudwatch-logs',
            DestinationDetails: { CloudWatchLogsDetails: { LogGroup: 'lg' } },
            LogFormat: 'text',
            Status: 'active',
          },
        ],
      },
      { LogDeliveryConfigurations: [{ LogType: 'slow-log' }, { LogType: 'engine-log' }] }
    );
    expect(result['LogDeliveryConfigurations']).toEqual([
      {
        LogType: 'slow-log',
        DestinationType: 'cloudwatch-logs',
        DestinationDetails: { CloudWatchLogsDetails: { LogGroup: 'lg' } },
        LogFormat: 'text',
      },
      {
        LogType: 'engine-log',
        DestinationType: 'kinesis-firehose',
        DestinationDetails: { KinesisFirehoseDetails: { DeliveryStream: 'ds' } },
        LogFormat: 'json',
      },
    ]);
  });

  it('leaves out a delivery being turned off', async () => {
    const result = await read({
      LogDeliveryConfigurations: [
        { LogType: 'slow-log', DestinationType: 'cloudwatch-logs', Status: 'active' },
        { LogType: 'engine-log', DestinationType: 'cloudwatch-logs', Status: 'disabling' },
      ],
    });
    expect(result['LogDeliveryConfigurations']).toEqual([
      { LogType: 'slow-log', DestinationType: 'cloudwatch-logs' },
    ]);
  });

  it('reads no delivery as [], what a removed property leaves', async () => {
    expect((await read({}))['LogDeliveryConfigurations']).toEqual([]);
  });

  it('reads a declared PreferredAvailabilityZones from the live nodes, in declared order', async () => {
    const result = await read(
      {
        CacheNodes: [
          { CacheNodeId: '0001', CustomerAvailabilityZone: 'us-east-1b' },
          { CacheNodeId: '0002', CustomerAvailabilityZone: 'us-east-1a' },
          { CacheNodeId: '0003', CustomerAvailabilityZone: 'us-east-1a' },
          { CacheNodeId: '0004', CustomerAvailabilityZone: 'us-east-1c', CacheNodeStatus: 'deleting' },
        ],
      },
      { PreferredAvailabilityZones: ['us-east-1a', 'us-east-1b', 'us-east-1a'] }
    );
    expect(result['PreferredAvailabilityZones']).toEqual(['us-east-1a', 'us-east-1b', 'us-east-1a']);
  });

  it('reads a node moved to another zone as a different list', async () => {
    const result = await read(
      { CacheNodes: [{ CacheNodeId: '0001', CustomerAvailabilityZone: 'us-east-1c' }] },
      { PreferredAvailabilityZones: ['us-east-1a'] }
    );
    expect(result['PreferredAvailabilityZones']).toEqual(['us-east-1c']);
  });

  it('emits no PreferredAvailabilityZones for a record that does not declare it', async () => {
    const result = await read({
      CacheNodes: [{ CacheNodeId: '0001', CustomerAvailabilityZone: 'us-east-1a' }],
    });
    expect(result).not.toHaveProperty('PreferredAvailabilityZones');
  });

  it('declares AZMode unknown for drift: no describe member answers it', () => {
    expect(provider.getDriftUnknownPaths('AWS::ElastiCache::CacheCluster')).toContain('AZMode');
  });
});
