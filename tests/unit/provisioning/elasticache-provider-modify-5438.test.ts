// issue #5438: CacheCluster CacheNodeType / AZMode / PreferredAvailabilityZone(s)
// / TransitEncryptionEnabled on update. Real CloudFormation runs (us-east-1,
// redis and memcached): a CacheNodeType change is an in-place
// ModifyCacheCluster; a memcached scale-out sends NewAvailabilityZones (the
// desired zones the live nodes do not cover) with AZMode; the rest complete
// with the cluster unchanged.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';

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
    // Instant sleeps on a fake clock each sleep advances, bounded: a waiter
    // that never settles fails the test instead of spinning until its cap.
    let clock = Date.parse('2026-10-28T00:00:00Z');
    vi.spyOn(Date, 'now').mockImplementation(() => clock);
    let sleeps = 0;
    vi.spyOn(
      provider as unknown as { sleep: (ms: number) => Promise<void> },
      'sleep'
    ).mockImplementation((ms: number) => {
      clock += ms;
      return ++sleeps > 50 ? Promise.reject(new Error('waiter did not settle')) : Promise.resolve();
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
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

    it('re-sends an unchanged CacheNodeType, as CloudFormation does, scaling a drifted cluster back', async () => {
      // The live type drifted to micro; the template still says small.
      const describes = [
        { CacheClusterStatus: 'available', CacheNodeType: 'cache.t4g.micro' },
        { CacheClusterStatus: 'available', CacheNodeType: 'cache.t4g.small' },
      ];
      mockSend.mockImplementation((cmd: Sent) => {
        if (cmd.constructor.name === 'DescribeCacheClustersCommand') {
          const next = describes.length > 1 ? describes.shift() : describes[0];
          return Promise.resolve({ CacheClusters: [next] });
        }
        return Promise.resolve({});
      });

      await provider.update(
        'Cache',
        'my-cluster',
        TYPE,
        { Engine: 'redis', CacheNodeType: 'cache.t4g.small', NumCacheNodes: 1, SnapshotWindow: '01:00-02:00' },
        { Engine: 'redis', CacheNodeType: 'cache.t4g.small', NumCacheNodes: 1 }
      );

      expect(modifyInput()).toMatchObject({ CacheNodeType: 'cache.t4g.small' });
      // Two waiter describes (drifted type, then the template type) and the
      // final one.
      expect(
        sent().filter((c) => c.constructor.name === 'DescribeCacheClustersCommand')
      ).toHaveLength(3);
    });

    it('fails fast when the cluster settles on its old type with no node-type change pending', async () => {
      mockSend.mockImplementation((cmd: Sent) =>
        Promise.resolve(
          cmd.constructor.name === 'DescribeCacheClustersCommand'
            ? { CacheClusters: [{ CacheClusterStatus: 'available', CacheNodeType: 'cache.t4g.micro' }] }
            : {}
        )
      );

      await expect(
        provider.update(
          'Cache',
          'my-cluster',
          TYPE,
          { Engine: 'redis', CacheNodeType: 'cache.t4g.small', NumCacheNodes: 1 },
          { Engine: 'redis', CacheNodeType: 'cache.t4g.micro', NumCacheNodes: 1 }
        )
      ).rejects.toThrow(/change to cache\.t4g\.small was not applied/);
    });

    it('keeps waiting while the node-type change is still pending', async () => {
      mockSend.mockImplementation((cmd: Sent) =>
        Promise.resolve(
          cmd.constructor.name === 'DescribeCacheClustersCommand'
            ? {
                CacheClusters: [
                  {
                    CacheClusterStatus: 'available',
                    CacheNodeType: 'cache.t4g.micro',
                    PendingModifiedValues: { CacheNodeType: 'cache.t4g.small' },
                  },
                ],
              }
            : {}
        )
      );

      // Never settles: the bounded sleep stub ends it, not the fail-fast.
      await expect(
        provider.update(
          'Cache',
          'my-cluster',
          TYPE,
          { Engine: 'redis', CacheNodeType: 'cache.t4g.small', NumCacheNodes: 1 },
          { Engine: 'redis', CacheNodeType: 'cache.t4g.micro', NumCacheNodes: 1 }
        )
      ).rejects.toThrow(/waiter did not settle/);
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
                    CacheNodeType: 'cache.t4g.small',
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
            ? {
                CacheClusters: [
                  {
                    CacheClusterStatus: 'available',
                    CacheNodeType: 'cache.t4g.micro',
                    TransitEncryptionEnabled: false,
                  },
                ],
              }
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
      expect(warn).toHaveBeenCalledTimes(2);
      const azText = warn.mock.calls[0][0] as string;
      expect(azText).toContain('Cache');
      expect(azText).toContain('the PreferredAvailabilityZone change is not applied');
      expect(azText).toContain('replace the cluster');
      // The encryption warning states the LIVE value the post-update
      // describe reports, against the template's.
      const text = warn.mock.calls[1][0] as string;
      expect(text).toContain('Cache');
      expect(text).toContain('still has encryption in transit DISABLED');
      expect(text).toContain('TransitEncryptionEnabled: true');
      expect(text).toContain('replace the cluster');
    });

    it('does not warn when TransitEncryptionEnabled: false is added (the create default)', async () => {
      // The describe reports no encryption setting, so only the previous
      // template value (absent = the create default, false) can stand in.
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
        {
          Engine: 'redis',
          CacheNodeType: 'cache.t4g.micro',
          NumCacheNodes: 1,
          TransitEncryptionEnabled: false,
        },
        { Engine: 'redis', CacheNodeType: 'cache.t4g.micro', NumCacheNodes: 1 }
      );

      expect(warn).not.toHaveBeenCalled();
    });

    it('does not warn when the live cluster already has the template value', async () => {
      mockSend.mockImplementation((cmd: Sent) =>
        Promise.resolve(
          cmd.constructor.name === 'DescribeCacheClustersCommand'
            ? {
                CacheClusters: [
                  {
                    CacheClusterStatus: 'available',
                    CacheNodeType: 'cache.t4g.micro',
                    TransitEncryptionEnabled: true,
                  },
                ],
              }
            : {}
        )
      );

      await provider.update(
        'Cache',
        'my-cluster',
        TYPE,
        { Engine: 'redis', CacheNodeType: 'cache.t4g.micro', NumCacheNodes: 1, TransitEncryptionEnabled: true },
        { Engine: 'redis', CacheNodeType: 'cache.t4g.micro', NumCacheNodes: 1 }
      );

      expect(warn).not.toHaveBeenCalled();
    });

    it('does not report them as not applied when they are unchanged or removed', async () => {
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

      // No not-applied line. The removals are named only by the #5545 lines:
      // CloudFormation keeps the node's zone, and replaces the cluster for an
      // AZMode removal (go-to-k/cdkd#5558).
      const lines = warn.mock.calls.map((c) => String(c[0]));
      expect(lines.filter((l) => l.includes('is not applied'))).toEqual([]);
      expect(lines).toEqual([
        expect.stringContaining(
          'property PreferredAvailabilityZone was removed from the template and keeps its current AWS value'
        ),
        expect.stringContaining(
          'property AZMode was removed from the template; cdkd leaves the cluster unchanged'
        ),
      ]);
    });
  });
});
