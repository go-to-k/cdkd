import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';

const { mockSend } = vi.hoisted(() => ({ mockSend: vi.fn() }));

vi.mock('@aws-sdk/client-elasticache', async (importOriginal) => {
  const orig = (await importOriginal()) as Record<string, unknown>;
  return {
    ...orig,
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
import { PROPERTY_COVERAGE_BY_TYPE } from '../../../src/provisioning/property-coverage.generated.js';
import { calculateResourceDrift } from '../../../src/analyzer/drift-calculator.js';

const TYPE = 'AWS::ElastiCache::CacheCluster';
const RDB_ARN = 'arn:aws:s3:::seed-bucket/seed/dump.rdb';

/** Every SDK command the provider sends, by class name, with its input. */
function recordCalls(status = 'available'): Array<{ name: string; input: Record<string, unknown> }> {
  const calls: Array<{ name: string; input: Record<string, unknown> }> = [];
  mockSend.mockImplementation(
    async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
      calls.push({ name: command.constructor.name, input: command.input });
      if (command.constructor.name === 'DescribeCacheClustersCommand') {
        return {
          CacheClusters: [
            {
              CacheClusterId: 'seeded',
              CacheClusterStatus: status,
              CacheNodeType: 'cache.t4g.micro',
              PendingModifiedValues: {},
              Engine: 'redis',
              CacheNodes: [{ CacheNodeId: '0001', Endpoint: { Address: 'a', Port: 6379 } }],
            },
          ],
        };
      }
      return {};
    }
  );
  return calls;
}

const createInput = (
  calls: Array<{ name: string; input: Record<string, unknown> }>
): Record<string, unknown> => {
  const create = calls.filter((c) => c.name === 'CreateCacheClusterCommand');
  expect(create).toHaveLength(1);
  return create[0]!.input;
};

// go-to-k/cdkd#5635: SnapshotArns (a redis cluster seeded from an RDB file in
// S3) was not wired, so a template carrying it left the SDK route for Cloud
// Control. It is create-only, so CreateCacheCluster is its only wire.
describe('ElastiCacheProvider CacheCluster SnapshotArns (#5635)', () => {
  let savedNoWait: string | undefined;
  beforeEach(() => {
    mockSend.mockReset();
    savedNoWait = process.env['CDKD_NO_WAIT'];
    process.env['CDKD_NO_WAIT'] = 'true';
  });
  afterEach(() => {
    if (savedNoWait === undefined) delete process.env['CDKD_NO_WAIT'];
    else process.env['CDKD_NO_WAIT'] = savedNoWait;
  });

  it('sends SnapshotArns on CreateCacheCluster as the template lists it', async () => {
    const calls = recordCalls();
    await new ElastiCacheProvider().create('Cache', TYPE, {
      ClusterName: 'seeded',
      Engine: 'redis',
      CacheNodeType: 'cache.t4g.micro',
      NumCacheNodes: 1,
      SnapshotArns: [RDB_ARN],
    });
    expect(createInput(calls)['SnapshotArns']).toEqual([RDB_ARN]);
  });

  it('sends no SnapshotArns member when the template has none', async () => {
    const calls = recordCalls();
    await new ElastiCacheProvider().create('Cache', TYPE, {
      ClusterName: 'plain',
      Engine: 'redis',
      CacheNodeType: 'cache.t4g.micro',
      NumCacheNodes: 1,
    });
    const input = createInput(calls);
    expect(input['SnapshotArns']).toBeUndefined();
  });

  it('never sends SnapshotArns on ModifyCacheCluster (create-only)', async () => {
    const calls = recordCalls();
    const seeded = {
      ClusterName: 'seeded',
      Engine: 'redis',
      CacheNodeType: 'cache.t4g.micro',
      NumCacheNodes: 1,
      SnapshotArns: [RDB_ARN],
      SnapshotRetentionLimit: 1,
    };
    const provider = new ElastiCacheProvider();
    vi.spyOn(provider as unknown as { sleep: (ms: number) => Promise<void> }, 'sleep').mockResolvedValue(
      undefined
    );
    await provider.update('Cache', 'seeded', TYPE, { ...seeded, SnapshotRetentionLimit: 2 }, seeded);
    const modify = calls.filter((c) => c.name === 'ModifyCacheClusterCommand');
    expect(modify).toHaveLength(1);
    expect(modify[0]!.input['SnapshotRetentionLimit']).toBe(2);
    expect(Object.keys(modify[0]!.input)).not.toContain('SnapshotArns');
  });

  it('declares SnapshotArns and SnapshotName unreadable, so a template-baseline drift run does not report them', () => {
    // No observed capture: the baseline is the template bag, and the readback
    // has no member for either seed.
    const baseline = { Engine: 'redis', SnapshotArns: [RDB_ARN], SnapshotName: 'snap' };
    const readback = { Engine: 'redis' };
    expect(calculateResourceDrift(baseline, readback).map((d) => d.path).sort()).toEqual([
      'SnapshotArns',
      'SnapshotName',
    ]);
    const ignorePaths = new ElastiCacheProvider().getDriftUnknownPaths(TYPE);
    expect(calculateResourceDrift(baseline, readback, { ignorePaths })).toEqual([]);
    // Only the seeds: a real change elsewhere is still reported.
    expect(
      calculateResourceDrift({ ...baseline, Engine: 'valkey' }, readback, { ignorePaths }).map(
        (d) => d.path
      )
    ).toEqual(['Engine']);
  });

  it.each(['restore-failed', 'incompatible-network'])(
    'fails the create at once when the cluster reads %s, naming the status and describe-events',
    async (status) => {
      delete process.env['CDKD_NO_WAIT'];
      const calls = recordCalls(status);
      const provider = new ElastiCacheProvider();
      const sleep = vi.spyOn(provider as unknown as { sleep: (ms: number) => Promise<void> }, 'sleep');
      // A wait that polls again instead of failing ends here rather than
      // spinning to the cap.
      sleep.mockRejectedValue(new Error('the wait slept: the status was not treated as terminal'));
      const err = await provider
        .create('Cache', TYPE, {
          ClusterName: 'seeded',
          Engine: 'redis',
          CacheNodeType: 'cache.t4g.micro',
          NumCacheNodes: 1,
          SnapshotArns: [RDB_ARN],
        })
        .then(
          () => undefined,
          (e: unknown) => e
        );
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toContain(`is ${status} and will not become available`);
      expect((err as Error).message).toContain('describe-events');
      // On the first poll, not after the wait's cap.
      expect(sleep).not.toHaveBeenCalled();
      expect(calls.filter((c) => c.name === 'DescribeCacheClustersCommand')).toHaveLength(1);
    }
  );

  it('is handled, so it no longer routes the resource to Cloud Control', () => {
    const provider = new ElastiCacheProvider();
    expect(provider.handledProperties.get(TYPE)?.has('SnapshotArns')).toBe(true);
    const coverage = PROPERTY_COVERAGE_BY_TYPE.get(TYPE);
    expect(coverage?.handled.has('SnapshotArns')).toBe(true);
    expect(coverage?.silentDrop.has('SnapshotArns')).toBe(false);
    expect(coverage?.createOnlyDrops.has('SnapshotArns')).toBe(false);
  });
});
