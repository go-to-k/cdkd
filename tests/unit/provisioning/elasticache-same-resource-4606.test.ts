import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const mockSend = vi.hoisted(() => vi.fn());
const clientRegion = vi.hoisted(() => ({ value: 'us-east-1' }));
const providerLogger = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: vi.fn(),
}));

vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({ ...providerLogger, child: () => providerLogger }),
}));

vi.mock('@aws-sdk/client-elasticache', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-elasticache')>();
  return {
    ...actual,
    ElastiCacheClient: vi.fn().mockImplementation(() => ({
      send: mockSend,
      config: { region: () => Promise.resolve(clientRegion.value) },
    })),
  };
});

import {
  CreateCacheClusterCommand,
  DeleteCacheClusterCommand,
  DescribeCacheClustersCommand,
} from '@aws-sdk/client-elasticache';
import { ElastiCacheProvider } from '../../../src/provisioning/providers/elasticache-provider.js';
import {
  createdBeforeFailure,
  createdResourceIdentityBeforeFailure,
} from '../../../src/provisioning/auxiliary-failure.js';
import { RESOURCE_NOT_FOUND } from '../../../src/types/resource.js';
import { settleJournaledOrphansOnSuccess } from '../../../src/deployment/rollback-executor/journaled-orphans.js';
import type { RollbackExecutorContext } from '../../../src/deployment/rollback-executor.js';

// go-to-k/cdkd#4606 / #4655: the live reads a successful deploy asks before
// deleting a fix-forward's earlier ElastiCache cache cluster. `isSameResource`
// must answer `'different'`, and the cluster's identity token
// (`<ARN>@<creation ms>`, ElastiCache having no immutable id) must equal the
// one the failed CREATE journaled.

const TYPE = 'AWS::ElastiCache::CacheCluster';
const CTX = { expectedRegion: 'us-east-1' };
const ARN = (id: string): string => `arn:aws:elasticache:us-east-1:123456789012:cluster:${id}`;
const T1 = new Date('2026-10-01T00:00:00.000Z');
const T2 = new Date('2026-10-02T00:00:00.000Z');

/**
 * A live cluster: its creation time (or `'creating'`, answered without one),
 * gone (the not-found fault), an empty list, an error, an item naming another
 * id, or an item with no ARN.
 */
type Entry =
  | Date
  | 'creating'
  | 'gone'
  | 'empty'
  | Error
  | { answeredAs: string | undefined }
  | 'no-arn';

/**
 * DescribeCacheClusters answers per id, looked up lower-cased (ElastiCache
 * matches ids in any case and answers lower-cased). Any other command fails
 * the test.
 */
function live(entries: Record<string, Entry>): void {
  mockSend.mockImplementation(async (cmd: unknown) => {
    if (!(cmd instanceof DescribeCacheClustersCommand)) throw new Error('unexpected command');
    const asked = cmd.input.CacheClusterId!;
    const id = asked.toLowerCase();
    const entry = entries[id];
    if (entry === undefined || entry === 'gone') {
      throw Object.assign(new Error(`CacheCluster ${asked} not found.`), {
        name: 'CacheClusterNotFoundFault',
      });
    }
    if (entry === 'empty') return { CacheClusters: [] };
    if (entry instanceof Error) throw entry;
    if (entry === 'no-arn') return { CacheClusters: [{ CacheClusterId: id }] };
    if (entry === 'creating') {
      return { CacheClusters: [{ CacheClusterId: id, ARN: ARN(id) }] };
    }
    if (entry instanceof Date) {
      return { CacheClusters: [{ CacheClusterId: id, ARN: ARN(id), CacheClusterCreateTime: entry }] };
    }
    return {
      CacheClusters: [{ CacheClusterId: entry.answeredAs, ARN: ARN(entry.answeredAs ?? 'x') }],
    };
  });
}

const askedIds = (): Array<string | undefined> =>
  mockSend.mock.calls.map(([cmd]) =>
    cmd instanceof DescribeCacheClustersCommand ? cmd.input.CacheClusterId : undefined
  );

describe('ElastiCacheProvider.isSameResource for a CacheCluster (go-to-k/cdkd#4606)', () => {
  let provider: ElastiCacheProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockReset();
    clientRegion.value = 'us-east-1';
    provider = new ElastiCacheProvider();
  });

  it('another live cluster under another id is different', async () => {
    live({ a: T1, b: T2 });
    expect(await provider.isSameResource('a', { physicalId: 'b' }, TYPE, CTX)).toBe('different');
    // Both were read: the record's first, then the journaled one.
    expect(askedIds()).toEqual(['b', 'a']);
  });

  it('two ids reading back under one ARN are the same cluster', async () => {
    // The answer names the asked id; only the ARN is shared.
    mockSend.mockImplementation(async (cmd: DescribeCacheClustersCommand) => ({
      CacheClusters: [
        { CacheClusterId: cmd.input.CacheClusterId, ARN: ARN('shared'), CacheClusterCreateTime: T1 },
      ],
    }));
    expect(await provider.isSameResource('a', { physicalId: 'b' }, TYPE, CTX)).toBe('same');
  });

  it('a cluster still being created (no creation time) is still compared by ARN', async () => {
    live({ a: 'creating', b: T2 });
    expect(await provider.isSameResource('a', { physicalId: 'b' }, TYPE, CTX)).toBe('different');
  });

  it('a journaled cluster AWS reports gone is different once the record reads back', async () => {
    live({ a: 'gone', b: T2 });
    expect(await provider.isSameResource('a', { physicalId: 'b' }, TYPE, CTX)).toBe('different');
  });

  it('an empty describe list for the journaled id reads as gone', async () => {
    live({ a: 'empty', b: T2 });
    expect(await provider.isSameResource('a', { physicalId: 'b' }, TYPE, CTX)).toBe('different');
  });

  it('the record cluster gone is unknown, not different, whatever the journaled one reads', async () => {
    live({ a: T1, b: 'gone' });
    expect(await provider.isSameResource('a', { physicalId: 'b' }, TYPE, CTX)).toBe('unknown');
    live({ a: 'gone', b: 'empty' });
    expect(await provider.isSameResource('a', { physicalId: 'b' }, TYPE, CTX)).toBe('unknown');
  });

  it('ids equal modulo case are the same without a read (ElastiCache ids are case-insensitive)', async () => {
    live({});
    expect(await provider.isSameResource('a', { physicalId: 'a' }, TYPE, CTX)).toBe('same');
    expect(await provider.isSameResource('MyCache', { physicalId: 'mycache' }, TYPE, CTX)).toBe(
      'same'
    );
    expect(await provider.isSameResource('mycache', { physicalId: 'MYCACHE' }, TYPE, CTX)).toBe(
      'same'
    );
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('a template-cased id is read as written and still compared by ARN', async () => {
    live({ 'orphan-a': T1, 'orphan-b': T2 });
    expect(await provider.isSameResource('Orphan-A', { physicalId: 'Orphan-B' }, TYPE, CTX)).toBe(
      'different'
    );
    expect(askedIds()).toEqual(['Orphan-B', 'Orphan-A']);
  });

  it('a read that fails other than with the not-found fault throws (the caller reads it as unknown)', async () => {
    const denied = Object.assign(new Error('denied'), { name: 'AccessDenied' });
    live({ a: denied, b: T2 });
    await expect(provider.isSameResource('a', { physicalId: 'b' }, TYPE, CTX)).rejects.toThrow(
      'denied'
    );
    // The record's read too: a failure there is never "the record is gone".
    live({ a: T1, b: denied });
    await expect(provider.isSameResource('a', { physicalId: 'b' }, TYPE, CTX)).rejects.toThrow(
      'denied'
    );
  });

  it('"not found" in the message alone never reads as gone', async () => {
    const looksGone = Object.assign(new Error('a not found'), { name: 'InternalFailure' });
    live({ a: looksGone, b: T2 });
    await expect(provider.isSameResource('a', { physicalId: 'b' }, TYPE, CTX)).rejects.toThrow(
      'a not found'
    );
  });

  it('a response naming another id, or none, throws rather than comparing it', async () => {
    live({ a: { answeredAs: 'someone-else' }, b: T2 });
    await expect(provider.isSameResource('a', { physicalId: 'b' }, TYPE, CTX)).rejects.toThrow(
      'answered for another cluster id'
    );
    live({ a: T1, b: { answeredAs: 'someone-else' } });
    await expect(provider.isSameResource('a', { physicalId: 'b' }, TYPE, CTX)).rejects.toThrow(
      'answered for another cluster id'
    );
    live({ a: { answeredAs: undefined }, b: T2 });
    await expect(provider.isSameResource('a', { physicalId: 'b' }, TYPE, CTX)).rejects.toThrow(
      'answered for another cluster id'
    );
  });

  it('a response naming no ARN throws rather than reading as gone', async () => {
    live({ a: 'no-arn', b: T2 });
    await expect(provider.isSameResource('a', { physicalId: 'b' }, TYPE, CTX)).rejects.toThrow(
      'returned no ARN'
    );
    live({ a: T1, b: 'no-arn' });
    await expect(provider.isSameResource('a', { physicalId: 'b' }, TYPE, CTX)).rejects.toThrow(
      'returned no ARN'
    );
  });

  it('a client in another region is unknown, with no read', async () => {
    clientRegion.value = 'eu-west-1';
    live({ a: 'gone', b: T2 });
    expect(await provider.isSameResource('a', { physicalId: 'b' }, TYPE, CTX)).toBe('unknown');
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('an id that is not a cache cluster id is unknown, with no read', async () => {
    live({ a: 'gone', b: T2 });
    for (const bad of [ARN('a'), '', '1abc', 'abc-', 'ab--c', 'a_b', 'a'.repeat(51)]) {
      expect(await provider.isSameResource(bad, { physicalId: 'b' }, TYPE, CTX)).toBe('unknown');
      expect(await provider.isSameResource('a', { physicalId: bad }, TYPE, CTX)).toBe('unknown');
    }
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('the longest legal id, and ids carrying digits, are read, not refused', async () => {
    const longest = `a${'-b'.repeat(24)}c`;
    expect(longest).toHaveLength(50);
    live({ [longest]: T1, 'db1-b2': T2, 'stack-orphan-1a2b3c4d': T1 });
    expect(await provider.isSameResource(longest, { physicalId: 'db1-b2' }, TYPE, CTX)).toBe(
      'different'
    );
    expect(
      await provider.isSameResource('stack-orphan-1a2b3c4d', { physicalId: 'db1-b2' }, TYPE, CTX)
    ).toBe('different');
  });

  it('a SubnetGroup is unknown, with no read', async () => {
    live({ a: 'gone', b: T2 });
    expect(
      await provider.isSameResource('a', { physicalId: 'b' }, 'AWS::ElastiCache::SubnetGroup', CTX)
    ).toBe('unknown');
    expect(mockSend).not.toHaveBeenCalled();
  });
});

describe('ElastiCacheProvider.resourceIdentity for a CacheCluster (go-to-k/cdkd#4655)', () => {
  let provider: ElastiCacheProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockReset();
    clientRegion.value = 'us-east-1';
    provider = new ElastiCacheProvider();
  });

  it('is the live ARN and creation time, read under the id as written', async () => {
    live({ 'my-cache': T1 });
    expect(await provider.resourceIdentity('My-Cache', TYPE, CTX)).toBe(
      `${ARN('my-cache')}@${T1.getTime()}`
    );
    expect(askedIds()).toEqual(['My-Cache']);
  });

  it('a cluster re-created under the id reads another token', async () => {
    live({ 'my-cache': T2 });
    expect(await provider.resourceIdentity('my-cache', TYPE, CTX)).not.toBe(
      `${ARN('my-cache')}@${T1.getTime()}`
    );
  });

  it('is RESOURCE_NOT_FOUND on the not-found fault name or an empty list', async () => {
    live({ a: 'gone' });
    expect(await provider.resourceIdentity('a', TYPE, CTX)).toBe(RESOURCE_NOT_FOUND);
    live({ a: 'empty' });
    expect(await provider.resourceIdentity('a', TYPE, CTX)).toBe(RESOURCE_NOT_FOUND);
  });

  it('throws on any other failure, "not found" in the message included (never gone)', async () => {
    live({ a: Object.assign(new Error('a not found'), { name: 'InternalFailure' }) });
    await expect(provider.resourceIdentity('a', TYPE, CTX)).rejects.toThrow('a not found');
  });

  it('throws on a response naming no ARN or another id', async () => {
    live({ a: 'no-arn' });
    await expect(provider.resourceIdentity('a', TYPE, CTX)).rejects.toThrow('returned no ARN');
    live({ a: { answeredAs: 'b' } });
    await expect(provider.resourceIdentity('a', TYPE, CTX)).rejects.toThrow(
      'answered for another cluster id'
    );
  });

  it('is undefined for a cluster answering without a creation time (still being created)', async () => {
    live({ a: 'creating' });
    expect(await provider.resourceIdentity('a', TYPE, CTX)).toBeUndefined();
  });

  it('is undefined, with no read, for a client in another region', async () => {
    clientRegion.value = 'eu-west-1';
    live({ a: T1 });
    expect(await provider.resourceIdentity('a', TYPE, CTX)).toBeUndefined();
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('is undefined, with no read, for an id that is not a cache cluster id or a SubnetGroup', async () => {
    live({ a: T1 });
    expect(await provider.resourceIdentity(ARN('a'), TYPE, CTX)).toBeUndefined();
    expect(await provider.resourceIdentity('a_b', TYPE, CTX)).toBeUndefined();
    expect(
      await provider.resourceIdentity('a', 'AWS::ElastiCache::SubnetGroup', CTX)
    ).toBeUndefined();
    expect(mockSend).not.toHaveBeenCalled();
  });
});

// The failed CREATE's own failure is often a describe that cannot run, which
// would fail a live identity read too: a token the create response names
// rides on the failure's mark, and the deploy engine journals it unread.
describe('the created-before-failure mark of a CacheCluster (go-to-k/cdkd#4655)', () => {
  const PROPS = { ClusterName: 'Orphan-Cache', Engine: 'redis', CacheNodeType: 'cache.t4g.micro' };

  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockReset();
    clientRegion.value = 'us-east-1';
  });

  /** CreateCacheCluster answers with `cluster`; every describe is denied. */
  function aws(cluster: Record<string, unknown>): void {
    mockSend.mockImplementation(async (cmd: unknown) => {
      if (cmd instanceof CreateCacheClusterCommand) return { CacheCluster: cluster };
      if (cmd instanceof DescribeCacheClustersCommand) {
        throw Object.assign(new Error('not authorized to perform: DescribeCacheClusters'), {
          name: 'AccessDenied',
        });
      }
      throw new Error('unexpected command');
    });
  }

  const failureOf = async (p: Promise<unknown>): Promise<unknown> =>
    p.then(
      () => {
        throw new Error('the create succeeded');
      },
      (e: unknown) => e
    );

  it('a create answering with ARN and creation time marks the id and that token', async () => {
    aws({ CacheClusterId: 'orphan-cache', ARN: ARN('orphan-cache'), CacheClusterCreateTime: T1 });
    const error = await failureOf(new ElastiCacheProvider().create('Orphan', TYPE, PROPS));
    expect(createdBeforeFailure(error, 'Orphan', TYPE)).toBe('Orphan-Cache');
    expect(createdResourceIdentityBeforeFailure(error, 'Orphan', TYPE)).toBe(
      `${ARN('orphan-cache')}@${T1.getTime()}`
    );
  });

  it.each([
    ['no creation time (the documented "creating" answer)', { ARN: ARN('orphan-cache') }],
    ['no ARN', { CacheClusterCreateTime: T1 }],
    ['an invalid creation time', { ARN: ARN('orphan-cache'), CacheClusterCreateTime: new Date('x') }],
    ['nothing', {}],
  ])('a create answering with %s marks the id alone', async (_label, cluster) => {
    aws({ CacheClusterId: 'orphan-cache', CacheClusterStatus: 'creating', ...cluster });
    const error = await failureOf(new ElastiCacheProvider().create('Orphan', TYPE, PROPS));
    expect(createdBeforeFailure(error, 'Orphan', TYPE)).toBe('Orphan-Cache');
    expect(createdResourceIdentityBeforeFailure(error, 'Orphan', TYPE)).toBeUndefined();
  });

  it('a create refused before AWS made the cluster is not marked', async () => {
    mockSend.mockImplementation(async () => {
      throw Object.assign(new Error('already exists'), { name: 'CacheClusterAlreadyExistsFault' });
    });
    const error = await failureOf(new ElastiCacheProvider().create('Orphan', TYPE, PROPS));
    expect(createdBeforeFailure(error, 'Orphan', TYPE)).toBeUndefined();
  });
});

describe('ElastiCacheProvider.delete of a journaled CacheCluster already gone (go-to-k/cdkd#4606)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockReset();
    clientRegion.value = 'us-east-1';
  });

  it('names it once at info, since the settle then exits 0 with nothing deleted', async () => {
    mockSend.mockImplementation(async (cmd: unknown) => {
      if (cmd instanceof DeleteCacheClusterCommand) {
        throw Object.assign(new Error('not found'), { name: 'CacheClusterNotFoundFault' });
      }
      throw new Error('unexpected command');
    });
    const provider = new ElastiCacheProvider();
    await provider.delete('Orphan', 'orphan-cache', TYPE, {}, {
      expectedRegion: 'us-east-1',
      failedCreateOrphan: true,
    });
    const infos = providerLogger.info.mock.calls.map(([m]) => String(m));
    expect(infos).toHaveLength(1);
    expect(infos[0]).toContain('ElastiCache cache cluster');
    expect(infos[0]).toContain('orphan-cache');
    expect(infos[0]).toContain('already gone');

    // A record's own delete keeps the quiet debug line.
    providerLogger.info.mockClear();
    providerLogger.debug.mockClear();
    await provider.delete('Orphan', 'orphan-cache', TYPE, {}, { expectedRegion: 'us-east-1' });
    expect(providerLogger.info).not.toHaveBeenCalled();
    expect(
      providerLogger.debug.mock.calls.some(([m]) =>
        String(m).includes('does not exist, skipping deletion')
      )
    ).toBe(true);
  });
});

// A cluster another owner creates under the orphan's id (in any case
// spelling) repeats its ARN; only the creation time differs, and the settle
// keeps it.
describe('the success settle with ElastiCacheProvider: a reused cluster id is not deleted (go-to-k/cdkd#4655)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockReset();
    clientRegion.value = 'us-east-1';
  });

  async function settle(liveEntry: Entry) {
    const provider = new ElastiCacheProvider();
    const del = vi.spyOn(provider, 'delete').mockResolvedValue(undefined);
    live({ 'my-cache': liveEntry });
    const journal = {
      journalVersion: 1,
      stackName: 'S',
      region: 'us-east-1',
      segments: [
        {
          timestamp: 1,
          reason: 'no-rollback-failure',
          initialDeploy: false,
          operations: [],
          failedOperations: [
            {
              logicalId: 'Orphan',
              changeType: 'CREATE',
              resourceType: TYPE,
              physicalId: 'My-Cache',
              provisionedBy: 'sdk',
              physicalIdRecoveredFromError: true,
              deletionPolicy: 'Delete',
              createdResourceIdentity: `${ARN('my-cache')}@${T1.getTime()}`,
              attemptedProperties: {},
            },
          ],
        },
      ],
    };
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const ctx = {
      providerRegistry: {
        getProviderFor: vi.fn(() => ({ provider, provisionedBy: 'sdk' })),
        getProvider: vi.fn(() => provider),
      },
      region: 'us-east-1',
      logger,
    } as unknown as RollbackExecutorContext;
    const out = await settleJournaledOrphansOnSuccess({
      stateBackend: {
        loadRollbackJournal: vi.fn(async () => structuredClone(journal)),
        reduceRollbackJournalToFailedOperations: vi.fn().mockResolvedValue(1),
        markRollbackJournalSuperseded: vi.fn().mockResolvedValue(undefined),
        dropRollbackJournalFailedOperations: vi.fn().mockResolvedValue(1),
      } as never,
      stackName: 'S',
      region: 'us-east-1',
      stateResources: {} as never,
      rollbackOrphans: undefined,
      newerOperations: [],
      foreignHolder: vi.fn(async () => undefined),
      ctx,
      logger: logger as never,
    });
    return { out, del, warned: logger.warn.mock.calls.map((m) => String(m[0])).join('\n') };
  }

  it('keeps `My-Cache` when `my-cache` now reads back with another creation time', async () => {
    const r = await settle(T2);
    expect(r.del).not.toHaveBeenCalled();
    expect(r.warned).toContain('the resource now under its physical id is another one');
    expect(r.out.unaddressed).toBe(1);
  });

  it('keeps it when the live read names no creation time (unproven)', async () => {
    const r = await settle('creating');
    expect(r.del).not.toHaveBeenCalled();
    expect(r.out.unaddressed).toBe(1);
  });

  it('deletes it when the id still reads back with the journaled creation time (control)', async () => {
    const r = await settle(T1);
    expect(r.del).toHaveBeenCalledTimes(1);
    expect(r.out.unaddressed).toBe(0);
  });
});
