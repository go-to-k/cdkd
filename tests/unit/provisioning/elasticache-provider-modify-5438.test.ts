// issue #5438: CacheCluster CacheNodeType / AZMode / PreferredAvailabilityZone(s)
// / TransitEncryptionEnabled on update. Real CloudFormation runs (us-east-1,
// redis and memcached): a CacheNodeType change is an in-place
// ModifyCacheCluster; a memcached scale-out sends NewAvailabilityZones (the
// desired zones the live nodes do not cover) with AZMode; the rest complete
// with the cluster unchanged.
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const { mockSend, warn } = vi.hoisted(() => ({ mockSend: vi.fn(), warn: vi.fn() }));

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
    warn,
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

const TYPE = 'AWS::ElastiCache::CacheCluster';

type Sent = { constructor: { name: string }; input: Record<string, unknown> };
const sent = (): Sent[] => mockSend.mock.calls.map((c) => c[0] as Sent);
const modifyInput = (): Record<string, unknown> => {
  const modify = sent().filter((c) => c.constructor.name === 'ModifyCacheClusterCommand');
  expect(modify).toHaveLength(1);
  return modify[0].input;
};

describe('ElastiCacheProvider CacheCluster in-place modify (issue #5438)', () => {
  let provider: ElastiCacheProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockReset();
    provider = new ElastiCacheProvider();
    vi.spyOn(provider as unknown as { sleep: (ms: number) => Promise<void> }, 'sleep').mockResolvedValue(
      undefined
    );
  });

  describe('CacheNodeType', () => {
    it('sends a changed CacheNodeType and waits until the cluster reports it', async () => {
      // Describes after the Modify: still the old type (status not yet
      // flipped), then modifying, then the new type available.
      const describes = [
        { CacheClusterStatus: 'available', CacheNodeType: 'cache.t4g.micro' },
        { CacheClusterStatus: 'modifying', CacheNodeType: 'cache.t4g.micro' },
        { CacheClusterStatus: 'available', CacheNodeType: 'cache.t4g.small' },
      ];
      mockSend.mockImplementation((cmd: Sent) => {
        if (cmd.constructor.name === 'DescribeCacheClustersCommand') {
          const next = describes.length > 1 ? describes.shift() : describes[0];
          return Promise.resolve({ CacheClusters: [next] });
        }
        return Promise.resolve({});
      });

      const result = await provider.update(
        'Cache',
        'my-cluster',
        TYPE,
        { Engine: 'redis', CacheNodeType: 'cache.t4g.small', NumCacheNodes: 1 },
        { Engine: 'redis', CacheNodeType: 'cache.t4g.micro', NumCacheNodes: 1 }
      );

      expect(modifyInput()).toMatchObject({
        CacheClusterId: 'my-cluster',
        CacheNodeType: 'cache.t4g.small',
        ApplyImmediately: true,
      });
      // Three waiter describes (old type twice, then the new one) and the
      // final attribute describe: the waiter did not stop at the first
      // `available`, which still carried the old type.
      const describeCount = sent().filter(
        (c) => c.constructor.name === 'DescribeCacheClustersCommand'
      ).length;
      expect(describeCount).toBe(4);
      expect(result.wasReplaced).toBe(false);
    });

    it('does not send an unchanged CacheNodeType, and waits on status alone', async () => {
      mockSend.mockImplementation((cmd: Sent) =>
        Promise.resolve(
          cmd.constructor.name === 'DescribeCacheClustersCommand'
            ? { CacheClusters: [{ CacheClusterStatus: 'available', CacheNodeType: 'cache.t4g.micro' }] }
            : {}
        )
      );

      await provider.update(
        'Cache',
        'my-cluster',
        TYPE,
        { Engine: 'redis', CacheNodeType: 'cache.t4g.small', NumCacheNodes: 1, SnapshotWindow: '01:00-02:00' },
        { Engine: 'redis', CacheNodeType: 'cache.t4g.small', NumCacheNodes: 1 }
      );

      expect(modifyInput()).not.toHaveProperty('CacheNodeType');
      // The live type differs from the template here (drift); a waiter keyed
      // on the template type would never settle. One waiter describe plus the
      // final one.
      expect(
        sent().filter((c) => c.constructor.name === 'DescribeCacheClustersCommand')
      ).toHaveLength(2);
    });
  });

  describe('new-node placement (AZMode / PreferredAvailabilityZones)', () => {
    const liveNodes = (zones: string[]) =>
      mockSend.mockImplementation((cmd: Sent) =>
        Promise.resolve(
          cmd.constructor.name === 'DescribeCacheClustersCommand'
            ? {
                CacheClusters: [
                  {
                    CacheClusterStatus: 'available',
                    CacheNodes: zones.map((az) => ({ CustomerAvailabilityZone: az })),
                  },
                ],
              }
            : {}
        )
      );

    it('sends NewAvailabilityZones for the zones the live nodes do not cover, with AZMode', async () => {
      liveNodes(['us-east-1c']);

      await provider.update(
        'Cache',
        'my-cluster',
        TYPE,
        {
          Engine: 'memcached',
          CacheNodeType: 'cache.t4g.small',
          NumCacheNodes: 2,
          AZMode: 'cross-az',
          PreferredAvailabilityZones: ['us-east-1c', 'us-east-1b'],
        },
        { Engine: 'memcached', CacheNodeType: 'cache.t4g.small', NumCacheNodes: 1 }
      );

      expect(modifyInput()).toMatchObject({
        NumCacheNodes: 2,
        AZMode: 'cross-az',
        NewAvailabilityZones: ['us-east-1b'],
      });
      expect(warn).not.toHaveBeenCalled();
    });

    it('counts a repeated zone once per live node (multiset difference)', async () => {
      liveNodes(['us-east-1a']);

      await provider.update(
        'Cache',
        'my-cluster',
        TYPE,
        {
          Engine: 'memcached',
          CacheNodeType: 'cache.t4g.small',
          NumCacheNodes: 3,
          PreferredAvailabilityZones: ['us-east-1a', 'us-east-1a', 'us-east-1b'],
        },
        {
          Engine: 'memcached',
          CacheNodeType: 'cache.t4g.small',
          NumCacheNodes: 1,
          PreferredAvailabilityZones: ['us-east-1a'],
        }
      );

      const input = modifyInput();
      expect(input['NewAvailabilityZones']).toEqual(['us-east-1a', 'us-east-1b']);
      expect(input).not.toHaveProperty('AZMode');
    });

    it('sends no placement when the live nodes already cover the desired zones', async () => {
      liveNodes(['us-east-1b', 'us-east-1c']);

      await provider.update(
        'Cache',
        'my-cluster',
        TYPE,
        {
          Engine: 'memcached',
          CacheNodeType: 'cache.t4g.small',
          NumCacheNodes: 2,
          AZMode: 'cross-az',
          PreferredAvailabilityZones: ['us-east-1c', 'us-east-1b'],
        },
        { Engine: 'memcached', CacheNodeType: 'cache.t4g.small', NumCacheNodes: 2 }
      );

      const input = modifyInput();
      expect(input).not.toHaveProperty('NewAvailabilityZones');
      expect(input).not.toHaveProperty('AZMode');
      // The AZMode change went nowhere, so it is reported.
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toContain('AZMode');
    });

    it('makes no describe before the Modify when neither the zones nor the node count changed', async () => {
      liveNodes(['us-east-1c']);
      const props = {
        Engine: 'memcached',
        CacheNodeType: 'cache.t4g.small',
        NumCacheNodes: 2,
        PreferredAvailabilityZones: ['us-east-1c', 'us-east-1b'],
      };

      await provider.update('Cache', 'my-cluster', TYPE, { ...props, SnapshotWindow: '01:00-02:00' }, props);

      expect(sent()[0].constructor.name).toBe('ModifyCacheClusterCommand');
      expect(modifyInput()).not.toHaveProperty('NewAvailabilityZones');
    });
  });

  describe('members ModifyCacheCluster cannot carry', () => {
    const available = () =>
      mockSend.mockImplementation((cmd: Sent) =>
        Promise.resolve(
          cmd.constructor.name === 'DescribeCacheClustersCommand'
            ? { CacheClusters: [{ CacheClusterStatus: 'available' }] }
            : {}
        )
      );

    it('warns on a TransitEncryptionEnabled / PreferredAvailabilityZone change and sends neither', async () => {
      available();

      await provider.update(
        'Cache',
        'my-cluster',
        TYPE,
        {
          Engine: 'redis',
          CacheNodeType: 'cache.t4g.micro',
          NumCacheNodes: 1,
          TransitEncryptionEnabled: true,
          PreferredAvailabilityZone: 'us-east-1b',
        },
        { Engine: 'redis', CacheNodeType: 'cache.t4g.micro', NumCacheNodes: 1 }
      );

      const input = modifyInput();
      expect(input).not.toHaveProperty('TransitEncryptionEnabled');
      expect(input).not.toHaveProperty('PreferredAvailabilityZone');
      expect(warn).toHaveBeenCalledTimes(1);
      const text = warn.mock.calls[0][0] as string;
      expect(text).toContain('Cache');
      expect(text).toContain('PreferredAvailabilityZone, TransitEncryptionEnabled');
      expect(text).toContain('replace the cluster');
    });

    it('does not warn when they are unchanged or removed', async () => {
      available();

      await provider.update(
        'Cache',
        'my-cluster',
        TYPE,
        {
          Engine: 'redis',
          CacheNodeType: 'cache.t4g.micro',
          NumCacheNodes: 1,
          TransitEncryptionEnabled: true,
        },
        {
          Engine: 'redis',
          CacheNodeType: 'cache.t4g.micro',
          NumCacheNodes: 1,
          TransitEncryptionEnabled: true,
          PreferredAvailabilityZone: 'us-east-1b',
          AZMode: 'single-az',
        }
      );

      expect(warn).not.toHaveBeenCalled();
    });
  });
});
