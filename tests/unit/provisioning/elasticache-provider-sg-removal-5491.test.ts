// issue #5491: VpcSecurityGroupIds removed from (or emptied in) a CacheCluster
// template. Real CloudFormation A/B (us-east-1, a redis cluster in a VPC with
// one template security group): removal sent ModifyCacheCluster with no
// securityGroupIds, `[]` sent securityGroupIds: [], and in both the cluster
// kept its group. cdkd sends no SecurityGroupIds for either, which keeps it.
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

describe('ElastiCacheProvider CacheCluster VpcSecurityGroupIds on update (issue #5491)', () => {
  let provider: ElastiCacheProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockReset();
    provider = new ElastiCacheProvider();
    vi.spyOn(
      provider as unknown as { sleep: (ms: number) => Promise<void> },
      'sleep'
    ).mockResolvedValue(undefined);
    mockSend.mockImplementation((cmd: Sent) =>
      Promise.resolve(
        cmd.constructor.name === 'DescribeCacheClustersCommand'
          ? { CacheClusters: [{ CacheClusterStatus: 'available', CacheNodeType: 'cache.t4g.micro' }] }
          : {}
      )
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const base = { Engine: 'redis', CacheNodeType: 'cache.t4g.micro', NumCacheNodes: 1 };
  const update = (next: Record<string, unknown>, prev: Record<string, unknown>) =>
    provider.update('Cache', 'my-cluster', TYPE, { ...base, ...next }, { ...base, ...prev });

  it('sends no SecurityGroupIds when the property is removed (CloudFormation keeps the groups)', async () => {
    await update({}, { VpcSecurityGroupIds: ['sg-a'] });
    // An undefined member is not serialized: the wire request has none.
    expect(modifyInput()['SecurityGroupIds']).toBeUndefined();
  });

  it('sends no SecurityGroupIds for an empty list (CloudFormation keeps the groups)', async () => {
    await update({ VpcSecurityGroupIds: [] }, { VpcSecurityGroupIds: ['sg-a'] });
    // An undefined member is not serialized: the wire request has none.
    expect(modifyInput()['SecurityGroupIds']).toBeUndefined();
  });

  it('sends a changed or unchanged non-empty list whole', async () => {
    await update({ VpcSecurityGroupIds: ['sg-b'] }, { VpcSecurityGroupIds: ['sg-a'] });
    expect(modifyInput()['SecurityGroupIds']).toEqual(['sg-b']);
    mockSend.mockClear();
    await update({ VpcSecurityGroupIds: ['sg-a'] }, { VpcSecurityGroupIds: ['sg-a'] });
    expect(modifyInput()['SecurityGroupIds']).toEqual(['sg-a']);
  });
});
