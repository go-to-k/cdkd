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
      nodesToRemove([node('0003', 'c'), node('0002', 'c'), node('0001', 'c')], 1, undefined)
    ).toEqual(['0001', '0002']);
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
    // An increase with no zone list needs no node ids: no planning describe.
    expect(sent()[0].constructor.name).toBe('ModifyCacheClusterCommand');
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
    ).rejects.toThrow(/lowering NumCacheNodes to 1[\s\S]*needs a node removed and a node added/);
    expect(sent().some((c) => c.constructor.name === 'ModifyCacheClusterCommand')).toBe(false);
  });
});

describe('ElastiCacheProvider CacheCluster node removal guards (issue #5441 review)', () => {
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

  const liveAbc = (after: [string, string][] = [['0001', 'us-east-1a'], ['0002', 'us-east-1b'], ['0003', 'us-east-1c']]) => {
    const queue = [
      [['0001', 'us-east-1a'], ['0002', 'us-east-1b'], ['0003', 'us-east-1c']],
      after,
    ].map((nodes) => ({
      CacheClusterStatus: 'available',
      CacheNodeType: 'cache.t4g.micro',
      CacheNodes: nodes.map(([id, az]) => ({ CacheNodeId: id, CustomerAvailabilityZone: az })),
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

  it('never trims live nodes when the template count did not go down', async () => {
    // Three live nodes, the template says 2 before and after (a zone change):
    // the extra live node is AWS's to refuse, not cdkd's to delete.
    liveAbc();

    await provider.update(
      'Cache',
      'my-cluster',
      TYPE,
      { ...base, NumCacheNodes: 2, PreferredAvailabilityZones: ['us-east-1a', 'us-east-1c'] },
      { ...base, NumCacheNodes: 2, PreferredAvailabilityZones: ['us-east-1a', 'us-east-1b'] }
    );

    expect(modifyInput()).not.toHaveProperty('CacheNodeIdsToRemove');
  });

  it('sends no NewAvailabilityZones beside a removal', async () => {
    // [a, b, c] kept as the zone list while the count drops to 2: the two
    // highest ids stay, and the uncovered zone a is not re-added in the same
    // Modify (AWS refuses a removal and an addition together).
    liveAbc([['0002', 'us-east-1b'], ['0003', 'us-east-1c']]);
    const zones = ['us-east-1a', 'us-east-1b', 'us-east-1c'];

    await provider.update(
      'Cache',
      'my-cluster',
      TYPE,
      { ...base, NumCacheNodes: 2, PreferredAvailabilityZones: zones },
      { ...base, NumCacheNodes: 3, PreferredAvailabilityZones: zones }
    );

    const input = modifyInput();
    expect(input['CacheNodeIdsToRemove']).toEqual(['0001']);
    expect(input).not.toHaveProperty('NewAvailabilityZones');
  });
});

describe('ElastiCacheProvider CacheCluster node removal refusals and drops (issue #5441 parent review)', () => {
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

  const base = { Engine: 'memcached', CacheNodeType: 'cache.t4g.micro' };
  const cluster = (nodes: [string, string][], pending?: string[]) => ({
    CacheClusterStatus: 'available',
    CacheNodeType: 'cache.t4g.micro',
    CacheNodes: nodes.map(([id, az]) => ({ CacheNodeId: id, CustomerAvailabilityZone: az })),
    ...(pending && { PendingModifiedValues: { CacheNodeIdsToRemove: pending } }),
  });
  const always = (c: ReturnType<typeof cluster>) =>
    mockSend.mockImplementation((cmd: Sent) =>
      Promise.resolve(
        cmd.constructor.name === 'DescribeCacheClustersCommand' ? { CacheClusters: [c] } : {}
      )
    );
  const modifySent = () => sent().some((c) => c.constructor.name === 'ModifyCacheClusterCommand');

  it('refuses a decrease when the live node count is not the previous template count', async () => {
    // Recorded 3, template 2, but 5 live (scaled outside the template): live
    // minus desired would delete 3 nodes for a 1-node template change.
    always(
      cluster([
        ['0001', 'c'],
        ['0002', 'c'],
        ['0003', 'c'],
        ['0004', 'c'],
        ['0005', 'c'],
      ])
    );

    await expect(
      provider.update('Cache', 'my-cluster', TYPE, { ...base, NumCacheNodes: 2 }, { ...base, NumCacheNodes: 3 })
    ).rejects.toThrow(/lowers NumCacheNodes from 3 to 2, but the cluster has 5 nodes/);
    expect(modifySent()).toBe(false);
  });

  it('refuses a zone list that overlaps the live zones but leaves the kept nodes short', async () => {
    always(
      cluster([
        ['0001', 'us-east-1a'],
        ['0002', 'us-east-1b'],
        ['0003', 'us-east-1c'],
      ])
    );

    const failure = provider.update(
      'Cache',
      'my-cluster',
      TYPE,
      { ...base, NumCacheNodes: 2, PreferredAvailabilityZones: ['us-east-1a', 'us-east-1d'] },
      { ...base, NumCacheNodes: 3 }
    );
    await expect(failure).rejects.toThrow(/needs a node removed and a node added/);
    expect(modifySent()).toBe(false);
  });

  it('fails early when the removal is dropped (nodes still listed, nothing pending)', async () => {
    always(
      cluster([
        ['0001', 'c'],
        ['0002', 'c'],
      ])
    );

    await expect(
      provider.update('Cache', 'my-cluster', TYPE, { ...base, NumCacheNodes: 1 }, { ...base, NumCacheNodes: 2 })
    ).rejects.toThrow(/still lists cache nodes 0001 with no removal pending/);
  });

  it('keeps waiting while the removal is still pending', async () => {
    always(
      cluster(
        [
          ['0001', 'c'],
          ['0002', 'c'],
        ],
        ['0001']
      )
    );

    await expect(
      provider.update('Cache', 'my-cluster', TYPE, { ...base, NumCacheNodes: 1 }, { ...base, NumCacheNodes: 2 })
    ).rejects.toThrow(/waiter did not settle/);
  });
});
