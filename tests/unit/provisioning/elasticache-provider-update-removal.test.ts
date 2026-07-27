// issue #1160: absent-field removal reset to CFn defaults (elasticache batch).
// ModifyCacheCluster / ModifyCacheSubnetGroup use merge semantics, so a field
// DROPPED from the template must be sent as its explicit CFn-default reset
// value (doc basis: ModifyCacheClusterMessage / ModifyCacheSubnetGroupMessage /
// LogDeliveryConfigurationRequest in @aws-sdk/client-elasticache), else the
// old live value silently persists.
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const mockSend = vi.fn();

vi.mock('@aws-sdk/client-elasticache', async () => {
  const actual = await vi.importActual('@aws-sdk/client-elasticache');
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

describe('ElastiCacheProvider removal reset to CFn defaults (issue #1160)', () => {
  let provider: ElastiCacheProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new ElastiCacheProvider();
  });

  describe('CacheCluster update (ModifyCacheCluster)', () => {
    const mockClusterUpdate = () => {
      // updateCacheCluster: ModifyCacheCluster, then describe calls
      // (waitForClusterAvailable + final describe). No ARN in the describe
      // result, so applyTagDiff is skipped.
      mockSend.mockResolvedValueOnce({});
      mockSend.mockResolvedValue({
        CacheClusters: [{ CacheClusterStatus: 'available' }],
      });
    };

    it('resets removed fields to their CFn defaults on update', async () => {
      mockClusterUpdate();

      await provider.update(
        'MyCluster',
        'my-cluster',
        'AWS::ElastiCache::CacheCluster',
        {
          Engine: 'redis',
          CacheNodeType: 'cache.t3.micro',
          NumCacheNodes: 1,
        },
        {
          Engine: 'redis',
          CacheNodeType: 'cache.t3.micro',
          NumCacheNodes: 1,
          SnapshotRetentionLimit: 5,
          AutoMinorVersionUpgrade: false,
          NotificationTopicArn: 'arn:aws:sns:us-east-1:123:topic',
          LogDeliveryConfigurations: [
            {
              LogType: 'slow-log',
              DestinationType: 'cloudwatch-logs',
              DestinationDetails: { CloudWatchLogsDetails: { LogGroup: '/ec/slow' } },
              LogFormat: 'json',
            },
          ],
          // Deliberately NOT reset on removal — must stay absent.
          EngineVersion: '7.1',
          CacheParameterGroupName: 'my-params',
          PreferredMaintenanceWindow: 'sun:23:00-mon:01:30',
          SnapshotWindow: '05:00-09:00',
          IpDiscovery: 'ipv4',
        }
      );

      const modifyCall = mockSend.mock.calls[0][0];
      expect(modifyCall.constructor.name).toBe('ModifyCacheClusterCommand');
      // CFn default: 0 = automatic backups off.
      expect(modifyCall.input.SnapshotRetentionLimit).toBe(0);
      // Service create-default: enabled.
      expect(modifyCall.input.AutoMinorVersionUpgrade).toBe(true);
      // Documented disable sentinel: status=inactive, ARN stays absent.
      expect(modifyCall.input.NotificationTopicArn).toBeUndefined();
      expect(modifyCall.input.NotificationTopicStatus).toBe('inactive');
      // Whole-property removal: every previously-configured log type gets
      // an explicit disable entry.
      expect(modifyCall.input.LogDeliveryConfigurations).toEqual([
        { LogType: 'slow-log', Enabled: false },
      ]);
      // Deliberate non-resets: removal of these must NOT synthesize any
      // value — each stays absent (no change). Pins the per-field rationale
      // comment in updateCacheCluster.
      expect(modifyCall.input.EngineVersion).toBeUndefined();
      expect(modifyCall.input.CacheParameterGroupName).toBeUndefined();
      expect(modifyCall.input.PreferredMaintenanceWindow).toBeUndefined();
      expect(modifyCall.input.SnapshotWindow).toBeUndefined();
      expect(modifyCall.input.IpDiscovery).toBeUndefined();
    });

    it('leaves a never-present field absent (no spurious reset value)', async () => {
      mockClusterUpdate();

      await provider.update(
        'MyCluster',
        'my-cluster',
        'AWS::ElastiCache::CacheCluster',
        { Engine: 'redis', CacheNodeType: 'cache.t3.micro' },
        { Engine: 'redis', CacheNodeType: 'cache.t3.micro' }
      );

      const modifyCall = mockSend.mock.calls[0][0];
      expect(modifyCall.input.SnapshotRetentionLimit).toBeUndefined();
      expect(modifyCall.input.AutoMinorVersionUpgrade).toBeUndefined();
      expect(modifyCall.input.NotificationTopicArn).toBeUndefined();
      expect(modifyCall.input.NotificationTopicStatus).toBeUndefined();
      expect(modifyCall.input.LogDeliveryConfigurations).toBeUndefined();
    });

    it('passes kept/changed fields through unchanged while removed ones reset', async () => {
      mockClusterUpdate();

      await provider.update(
        'MyCluster',
        'my-cluster',
        'AWS::ElastiCache::CacheCluster',
        {
          Engine: 'redis',
          CacheNodeType: 'cache.t3.micro',
          // CFn number props may arrive as strings — coercion preserved.
          SnapshotRetentionLimit: '7',
          NotificationTopicArn: 'arn:aws:sns:us-east-1:123:topic',
        },
        {
          Engine: 'redis',
          CacheNodeType: 'cache.t3.micro',
          SnapshotRetentionLimit: 5,
          NotificationTopicArn: 'arn:aws:sns:us-east-1:123:topic',
          AutoMinorVersionUpgrade: false,
        }
      );

      const modifyCall = mockSend.mock.calls[0][0];
      expect(modifyCall.input.SnapshotRetentionLimit).toBe(7);
      // Kept ARN: sent with an explicit active status so a topic re-added
      // after a prior removal (status=inactive) reactivates delivery.
      expect(modifyCall.input.NotificationTopicArn).toBe('arn:aws:sns:us-east-1:123:topic');
      expect(modifyCall.input.NotificationTopicStatus).toBe('active');
      expect(modifyCall.input.AutoMinorVersionUpgrade).toBe(true);
    });

    it('disables only the log types dropped from the template (per-entry removal)', async () => {
      mockClusterUpdate();

      const engineLog = {
        LogType: 'engine-log',
        DestinationType: 'cloudwatch-logs',
        DestinationDetails: { CloudWatchLogsDetails: { LogGroup: '/ec/engine' } },
        LogFormat: 'json',
      };
      await provider.update(
        'MyCluster',
        'my-cluster',
        'AWS::ElastiCache::CacheCluster',
        {
          Engine: 'redis',
          CacheNodeType: 'cache.t3.micro',
          LogDeliveryConfigurations: [engineLog],
        },
        {
          Engine: 'redis',
          CacheNodeType: 'cache.t3.micro',
          LogDeliveryConfigurations: [
            engineLog,
            {
              LogType: 'slow-log',
              DestinationType: 'cloudwatch-logs',
              DestinationDetails: { CloudWatchLogsDetails: { LogGroup: '/ec/slow' } },
              LogFormat: 'json',
            },
          ],
        }
      );

      const modifyCall = mockSend.mock.calls[0][0];
      expect(modifyCall.input.LogDeliveryConfigurations).toEqual([
        engineLog,
        { LogType: 'slow-log', Enabled: false },
      ]);
    });
  });

  describe('SubnetGroup update (ModifyCacheSubnetGroup)', () => {
    it('resets a removed description to the create-path default', async () => {
      mockSend.mockResolvedValueOnce({});

      await provider.update(
        'MySubnetGroup',
        'my-subnet-group',
        'AWS::ElastiCache::SubnetGroup',
        { SubnetIds: ['subnet-1'] },
        { SubnetIds: ['subnet-1'], Description: 'custom description' }
      );

      const modifyCall = mockSend.mock.calls[0][0];
      expect(modifyCall.constructor.name).toBe('ModifyCacheSubnetGroupCommand');
      expect(modifyCall.input.CacheSubnetGroupDescription).toBe('Subnet group for MySubnetGroup');
    });

    it('resets a removed API-spelled CacheSubnetGroupDescription too', async () => {
      mockSend.mockResolvedValueOnce({});

      await provider.update(
        'MySubnetGroup',
        'my-subnet-group',
        'AWS::ElastiCache::SubnetGroup',
        { SubnetIds: ['subnet-1'] },
        { SubnetIds: ['subnet-1'], CacheSubnetGroupDescription: 'custom description' }
      );

      const modifyCall = mockSend.mock.calls[0][0];
      expect(modifyCall.input.CacheSubnetGroupDescription).toBe('Subnet group for MySubnetGroup');
    });

    it('leaves a never-present description absent and passes a kept one through', async () => {
      mockSend.mockResolvedValueOnce({});
      await provider.update(
        'MySubnetGroup',
        'my-subnet-group',
        'AWS::ElastiCache::SubnetGroup',
        { SubnetIds: ['subnet-1'] },
        { SubnetIds: ['subnet-1'] }
      );
      expect(mockSend.mock.calls[0][0].input.CacheSubnetGroupDescription).toBeUndefined();

      mockSend.mockResolvedValueOnce({});
      await provider.update(
        'MySubnetGroup',
        'my-subnet-group',
        'AWS::ElastiCache::SubnetGroup',
        { SubnetIds: ['subnet-1'], Description: 'kept' },
        { SubnetIds: ['subnet-1'], Description: 'old' }
      );
      expect(mockSend.mock.calls[1][0].input.CacheSubnetGroupDescription).toBe('kept');
    });
  });

  describe('readCurrentState notification gate (post-removal round-trip)', () => {
    it('omits NotificationTopicArn when the topic status is inactive', async () => {
      mockSend.mockResolvedValueOnce({
        CacheClusters: [
          {
            CacheClusterId: 'my-cluster',
            Engine: 'redis',
            NotificationConfiguration: {
              TopicArn: 'arn:aws:sns:us-east-1:123:topic',
              TopicStatus: 'inactive',
            },
          },
        ],
      });

      const state = await provider.readCurrentState(
        'my-cluster',
        'MyCluster',
        'AWS::ElastiCache::CacheCluster'
      );
      expect(state).toBeDefined();
      expect(state!['NotificationTopicArn']).toBeUndefined();
    });

    it('emits NotificationTopicArn when the topic status is active', async () => {
      mockSend.mockResolvedValueOnce({
        CacheClusters: [
          {
            CacheClusterId: 'my-cluster',
            Engine: 'redis',
            NotificationConfiguration: {
              TopicArn: 'arn:aws:sns:us-east-1:123:topic',
              TopicStatus: 'active',
            },
          },
        ],
      });

      const state = await provider.readCurrentState(
        'my-cluster',
        'MyCluster',
        'AWS::ElastiCache::CacheCluster'
      );
      expect(state).toBeDefined();
      expect(state!['NotificationTopicArn']).toBe('arn:aws:sns:us-east-1:123:topic');
    });
  });
});
