import { vi } from 'vite-plus/test';

// go-to-k/cdkd#4639: the ElastiCache creates carry no idempotency token, so
// the AWS SDK's own retry of a 5xx whose request had succeeded replayed them
// inside ONE `send` and collided with what the first send made. That "already
// exists" surfaced from the engine's first attempt and read as a name somebody
// else holds.

vi.mock('@aws-sdk/client-elasticache', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-elasticache')>();
  const { sdkClientStandIn } = await import('./create-retry-4639-harness.js');
  return { ...actual, ElastiCacheClient: vi
      .fn()
      .mockImplementation((cfg?: { region?: string; profile?: string }) =>
        sdkClientStandIn(cfg?.region ?? 'unset', cfg?.profile)
      ),
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

import {
  CacheClusterAlreadyExistsFault,
  CacheSubnetGroupAlreadyExistsFault,
} from '@aws-sdk/client-elasticache';
import { ElastiCacheProvider } from '../../../src/provisioning/providers/elasticache-provider.js';
import type { NamedCreate } from './create-retry-4639-harness.js';
import { describeCreateRetrySafety, type CreateSite } from './create-retry-4639-suite.js';

const meta = { $metadata: { httpStatusCode: 400 } };

const CREATES: Record<string, NamedCreate> = {
  CreateCacheSubnetGroupCommand: {
    nameKey: 'CacheSubnetGroupName',
    collision: (n) =>
      new CacheSubnetGroupAlreadyExistsFault({
        message: `Cache subnet group ${n} already exists.`,
        ...meta,
      }),
  },
  CreateCacheClusterCommand: {
    nameKey: 'CacheClusterId',
    collision: (n) =>
      new CacheClusterAlreadyExistsFault({ message: `Cache cluster ${n} already exists.`, ...meta }),
  },
};

const SITES: CreateSite[] = [
  {
    type: 'AWS::ElastiCache::SubnetGroup',
    command: 'CreateCacheSubnetGroupCommand',
    name: 'orders-csg',
    props: { CacheSubnetGroupName: 'orders-csg', Description: 'd', SubnetIds: ['s-1'] },
    provider: () => new ElastiCacheProvider(),
    prose: true,
  },
  {
    type: 'AWS::ElastiCache::CacheCluster',
    command: 'CreateCacheClusterCommand',
    name: 'orders-cache',
    props: {
      ClusterName: 'orders-cache',
      CacheNodeType: 'cache.t3.micro',
      Engine: 'redis',
      NumCacheNodes: 1,
    },
    provider: () => new ElastiCacheProvider(),
    prose: true,
  },
];

describeCreateRetrySafety(SITES, CREATES);
