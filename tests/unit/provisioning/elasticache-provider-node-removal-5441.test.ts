// issue #5441: a memcached CacheCluster NumCacheNodes decrease. AWS refuses
// a lower NumCacheNodes without CacheNodeIdsToRemove; CloudFormation (CloudTrail
// on real change-set runs, us-east-1) keeps the HIGHEST node ids and removes
// the rest, first any node in a zone the desired PreferredAvailabilityZones no
// longer lists.
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

import {
  ElastiCacheProvider,
  nodesToRemove,
} from '../../../src/provisioning/providers/elasticache-provider.js';

const TYPE = 'AWS::ElastiCache::CacheCluster';

type Sent = { constructor: { name: string }; input: Record<string, unknown> };
const sent = (): Sent[] => mockSend.mock.calls.map((c) => c[0] as Sent);
const modifyInput = (): Record<string, unknown> => {
  const modify = sent().filter((c) => c.constructor.name === 'ModifyCacheClusterCommand');
  expect(modify).toHaveLength(1);
  return modify[0].input;
};

const node = (id: string, zone: string) => ({ id, zone });

describe('nodesToRemove (issue #5441, CloudFormation-measured)', () => {
  it('keeps the highest ids without a zone list (3 -> 1 removed 0001, 0002)', () => {
    expect(
      nodesToRemove([node('0001', 'c'), node('0002', 'c'), node('0003', 'c')], 1, undefined)
    ).toEqual(['0001', '0002']);
  });

  it('removes the node in a zone the list dropped ([a, b, c] -> [a, c] removed the b node)', () => {
    expect(
      nodesToRemove([node('0001', 'a'), node('0002', 'b'), node('0003', 'c')], 2, ['a', 'c'])
    ).toEqual(['0002']);
  });

  it('keeps the higher id of two nodes in a repeated zone ([a, a, c] -> [c, a] removed the lower a node)', () => {
    expect(
      nodesToRemove([node('0001', 'a'), node('0002', 'a'), node('0003', 'c')], 2, ['c', 'a'])
    ).toEqual(['0001']);
  });

  it('orders ids numerically-as-strings regardless of the describe order', () => {
    expect(
      nodesToRemove([node('0003', 'c'), node('0001', 'c'), node('0002', 'c')], 2, undefined)
    ).toEqual(['0001']);
  });

  it('returns undefined when the kept nodes cannot reach the count without a node in a new zone', () => {
    expect(nodesToRemove([node('0001', 'a'), node('0002', 'c')], 1, ['b'])).toBeUndefined();
  });
});

describe('ElastiCacheProvider CacheCluster NumCacheNodes decrease (issue #5441)', () => {
  let provider: ElastiCacheProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockReset();
    provider = new ElastiCacheProvider();
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

  /** Describes in order; the last one repeats. */
  const describes = (...nodeSets: string[][]) => {
    const queue = nodeSets.map((ids) => ({
      CacheClusterStatus: 'available',
      CacheNodeType: 'cache.t4g.micro',
      CacheNodes: ids.map((id) => ({ CacheNodeId: id, CustomerAvailabilityZone: 'us-east-1c' })),
    }));
    mockSend.mockImplementation((cmd: Sent) => {
      if (cmd.constructor.name === 'DescribeCacheClustersCommand') {
        const next = queue.length > 1 ? queue.shift() : queue[0];
        return Promise.resolve({ CacheClusters: [next] });
      }
      return Promise.resolve({});
    });
  };
  const base = { Engine: 'memcached', CacheNodeType: 'cache.t4g.micro' };

  it('sends CacheNodeIdsToRemove for the lowest ids and waits until they are gone', async () => {
    // Planning describe, then the waiter: still all three (status not yet
    // flipped), then only 0003.
    describes(['0001', '0002', '0003'], ['0001', '0002', '0003'], ['0003']);

    await provider.update(
      'Cache',
      'my-cluster',
      TYPE,
      { ...base, NumCacheNodes: 1 },
      { ...base, NumCacheNodes: 3 }
    );

    expect(modifyInput()).toMatchObject({
      NumCacheNodes: 1,
      CacheNodeIdsToRemove: ['0001', '0002'],
      ApplyImmediately: true,
    });
    // planning + two waiter describes + the final one
    expect(
      sent().filter((c) => c.constructor.name === 'DescribeCacheClustersCommand')
    ).toHaveLength(4);
  });

  it('sends no CacheNodeIdsToRemove when the count rises or stays', async () => {
    describes(['0001']);

    await provider.update(
      'Cache',
      'my-cluster',
      TYPE,
      { ...base, NumCacheNodes: 2 },
      { ...base, NumCacheNodes: 1 }
    );

    expect(modifyInput()).not.toHaveProperty('CacheNodeIdsToRemove');
  });

  it('makes no planning describe when NumCacheNodes is unchanged', async () => {
    describes(['0001', '0002']);

    await provider.update(
      'Cache',
      'my-cluster',
      TYPE,
      { ...base, NumCacheNodes: 2, SnapshotWindow: '01:00-02:00' },
      { ...base, NumCacheNodes: 2 }
    );

    expect(sent()[0].constructor.name).toBe('ModifyCacheClusterCommand');
    expect(modifyInput()).not.toHaveProperty('CacheNodeIdsToRemove');
  });

  it('refuses before any Modify when the decrease also needs a node in a new zone', async () => {
    mockSend.mockImplementation((cmd: Sent) =>
      Promise.resolve(
        cmd.constructor.name === 'DescribeCacheClustersCommand'
          ? {
              CacheClusters: [
                {
                  CacheClusterStatus: 'available',
                  CacheNodeType: 'cache.t4g.micro',
                  CacheNodes: [
                    { CacheNodeId: '0001', CustomerAvailabilityZone: 'us-east-1a' },
                    { CacheNodeId: '0002', CustomerAvailabilityZone: 'us-east-1c' },
                  ],
                },
              ],
            }
          : {}
      )
    );

    await expect(
      provider.update(
        'Cache',
        'my-cluster',
        TYPE,
        { ...base, NumCacheNodes: 1, PreferredAvailabilityZones: ['us-east-1b'] },
        { ...base, NumCacheNodes: 2, PreferredAvailabilityZones: ['us-east-1a', 'us-east-1c'] }
      )
    ).rejects.toThrow(/lowering NumCacheNodes to 1/);
    expect(sent().some((c) => c.constructor.name === 'ModifyCacheClusterCommand')).toBe(false);
  });
});
