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

const TYPE = 'AWS::ElastiCache::CacheCluster';
const RDB_ARN = 'arn:aws:s3:::seed-bucket/seed/dump.rdb';

/** Every SDK command the provider sends, by class name, with its input. */
function recordCalls(): Array<{ name: string; input: Record<string, unknown> }> {
  const calls: Array<{ name: string; input: Record<string, unknown> }> = [];
  mockSend.mockImplementation(
    async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
      calls.push({ name: command.constructor.name, input: command.input });
      if (command.constructor.name === 'DescribeCacheClustersCommand') {
        return {
          CacheClusters: [
            {
              CacheClusterId: 'seeded',
              CacheClusterStatus: 'available',
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

  it('is handled, so it no longer routes the resource to Cloud Control', () => {
    const provider = new ElastiCacheProvider();
    expect(provider.handledProperties.get(TYPE)?.has('SnapshotArns')).toBe(true);
    const coverage = PROPERTY_COVERAGE_BY_TYPE.get(TYPE);
    expect(coverage?.handled.has('SnapshotArns')).toBe(true);
    expect(coverage?.silentDrop.has('SnapshotArns')).toBe(false);
    expect(coverage?.createOnlyDrops.has('SnapshotArns')).toBe(false);
  });
});
