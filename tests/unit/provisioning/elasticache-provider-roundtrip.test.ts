import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ModifyCacheClusterCommand } from '@aws-sdk/client-elasticache';

const mockSend = vi.fn();

vi.mock('@aws-sdk/client-elasticache', async () => {
  const actual = await vi.importActual<typeof import('@aws-sdk/client-elasticache')>(
    '@aws-sdk/client-elasticache'
  );
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

const CLUSTER_ID = 'mycluster';

describe('ElastiCacheProvider read-update round-trip', () => {
  let provider: ElastiCacheProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new ElastiCacheProvider();
  });

  it('Class 1 — memcached cluster does not surface redis-only TransitEncryptionEnabled', async () => {
    // Mechanical guard for Class 1 placeholder regression on
    // type-discriminator-dependent fields. See
    // docs/provider-development.md § 3b.
    //
    // ElastiCache `TransitEncryptionEnabled` is redis-only on
    // CreateCacheClusterCommand. AWS DescribeCacheClusters returns the
    // field for both engines, but readCurrentState must NOT emit it on
    // a memcached cluster. Otherwise drift --revert ships the
    // placeholder to AWS and (if `update()` ever forwards it) the
    // request is rejected.
    mockSend.mockResolvedValueOnce({
      CacheClusters: [
        {
          CacheClusterId: CLUSTER_ID,
          Engine: 'memcached',
          CacheNodeType: 'cache.t3.micro',
          NumCacheNodes: 2,
          // AWS routinely returns this field even on memcached.
          TransitEncryptionEnabled: false,
        },
      ],
    });

    const observed = await provider.readCurrentState(
      CLUSTER_ID,
      'L',
      'AWS::ElastiCache::CacheCluster'
    );

    expect(observed).toBeDefined();
    expect(observed?.['Engine']).toBe('memcached');
    // Class 1 gate: redis-only field absent on memcached snapshot.
    expect(observed).not.toHaveProperty('TransitEncryptionEnabled');
  });

  it('Class 1 — redis cluster legitimately surfaces TransitEncryptionEnabled', async () => {
    // The complement of the memcached test: a redis cluster legitimately
    // has TransitEncryptionEnabled, so readCurrentState must emit it.
    mockSend.mockResolvedValueOnce({
      CacheClusters: [
        {
          CacheClusterId: CLUSTER_ID,
          Engine: 'redis',
          CacheNodeType: 'cache.t3.micro',
          NumCacheNodes: 1,
          TransitEncryptionEnabled: true,
        },
      ],
    });

    const observed = await provider.readCurrentState(
      CLUSTER_ID,
      'L',
      'AWS::ElastiCache::CacheCluster'
    );

    expect(observed?.['Engine']).toBe('redis');
    expect(observed?.['TransitEncryptionEnabled']).toBe(true);
  });

  it('Class 2 — round-trip sanitizes empty VpcSecurityGroupIds before ModifyCacheCluster', async () => {
    // Class 2 round-trip guard: readCurrentState always-emits
    // `VpcSecurityGroupIds: []` (the empty placeholder is needed for
    // drift detection of console-side SG attach). Round-tripping that
    // placeholder back through `update()` would, without sanitization,
    // ship `SecurityGroupIds: []` to ModifyCacheClusterCommand — AWS
    // rejects with "must specify at least one security group".
    //
    // Build observed snapshot directly. update() polls describe twice
    // (waitForClusterAvailable + final attribute fetch); mock
    // accordingly.
    const observed: Record<string, unknown> = {
      ClusterName: CLUSTER_ID,
      Engine: 'redis',
      CacheNodeType: 'cache.t3.micro',
      NumCacheNodes: 1,
      VpcSecurityGroupIds: [],
    };

    // ModifyCacheClusterCommand response.
    mockSend.mockResolvedValueOnce({});
    // waitForClusterAvailable: returns available immediately.
    mockSend.mockResolvedValueOnce({
      CacheClusters: [{ CacheClusterId: CLUSTER_ID, CacheClusterStatus: 'available' }],
    });
    // Final describe for attributes.
    mockSend.mockResolvedValueOnce({
      CacheClusters: [{ CacheClusterId: CLUSTER_ID, CacheClusterStatus: 'available' }],
    });

    await provider.update('L', CLUSTER_ID, 'AWS::ElastiCache::CacheCluster', observed, observed);

    const modifyCall = mockSend.mock.calls.find((c) => c[0] instanceof ModifyCacheClusterCommand);
    expect(modifyCall).toBeDefined();
    const input = modifyCall![0].input as { SecurityGroupIds?: string[] };
    // Empty array sanitized to undefined — AWS treats absent as "no change".
    expect(input.SecurityGroupIds).toBeUndefined();
  });

  it('Class 2 — non-empty VpcSecurityGroupIds reaches AWS unchanged', async () => {
    // Sibling case: the sanitization must not regress the non-empty
    // path. State `['sg-1', 'sg-2']` should reach AWS as-is.
    const observed: Record<string, unknown> = {
      ClusterName: CLUSTER_ID,
      Engine: 'redis',
      VpcSecurityGroupIds: ['sg-1', 'sg-2'],
    };

    mockSend.mockResolvedValueOnce({});
    mockSend.mockResolvedValueOnce({
      CacheClusters: [{ CacheClusterId: CLUSTER_ID, CacheClusterStatus: 'available' }],
    });
    mockSend.mockResolvedValueOnce({
      CacheClusters: [{ CacheClusterId: CLUSTER_ID, CacheClusterStatus: 'available' }],
    });

    await provider.update('L', CLUSTER_ID, 'AWS::ElastiCache::CacheCluster', observed, observed);

    const modifyCall = mockSend.mock.calls.find((c) => c[0] instanceof ModifyCacheClusterCommand);
    const input = modifyCall![0].input as { SecurityGroupIds?: string[] };
    expect(input.SecurityGroupIds).toEqual(['sg-1', 'sg-2']);
  });

  it('truthy-gate — SnapshotRetentionLimit=0 reaches AWS (not silently dropped)', async () => {
    // SnapshotRetentionLimit=0 means "disable automatic snapshots" per
    // the AWS API. A truthy gate (`if (props['SnapshotRetentionLimit'])`)
    // would silently drop the 0 and leave AWS-side retention untouched —
    // surfacing as a drift --revert that reports `✓ reverted` but the
    // very next drift run re-detects the same drift. Guard via `!= null`.
    const observed: Record<string, unknown> = {
      ClusterName: CLUSTER_ID,
      Engine: 'redis',
      SnapshotRetentionLimit: 0,
    };

    mockSend.mockResolvedValueOnce({});
    mockSend.mockResolvedValueOnce({
      CacheClusters: [{ CacheClusterId: CLUSTER_ID, CacheClusterStatus: 'available' }],
    });
    mockSend.mockResolvedValueOnce({
      CacheClusters: [{ CacheClusterId: CLUSTER_ID, CacheClusterStatus: 'available' }],
    });

    await provider.update('L', CLUSTER_ID, 'AWS::ElastiCache::CacheCluster', observed, observed);

    const modifyCall = mockSend.mock.calls.find((c) => c[0] instanceof ModifyCacheClusterCommand);
    const input = modifyCall![0].input as { SnapshotRetentionLimit?: number };
    expect(input.SnapshotRetentionLimit).toBe(0);
  });

  it('round-trip — full redis snapshot does not produce AWS-rejection-shaped inputs', async () => {
    // End-to-end round-trip on a realistic redis snapshot. The
    // round-trip must not produce any structurally-invalid AWS input
    // (empty SG array, redis-only field on memcached, etc.).
    const observed: Record<string, unknown> = {
      ClusterName: CLUSTER_ID,
      Engine: 'redis',
      CacheNodeType: 'cache.t3.micro',
      NumCacheNodes: 1,
      CacheSubnetGroupName: 'default',
      EngineVersion: '7.0',
      CacheParameterGroupName: 'default.redis7',
      PreferredMaintenanceWindow: 'sun:05:00-sun:06:00',
      SnapshotRetentionLimit: 5,
      AutoMinorVersionUpgrade: true,
      Port: 6379,
      VpcSecurityGroupIds: ['sg-abc'],
      TransitEncryptionEnabled: true,
      Tags: [{ Key: 'env', Value: 'prod' }],
    };

    mockSend.mockResolvedValueOnce({});
    mockSend.mockResolvedValueOnce({
      CacheClusters: [{ CacheClusterId: CLUSTER_ID, CacheClusterStatus: 'available' }],
    });
    mockSend.mockResolvedValueOnce({
      CacheClusters: [{ CacheClusterId: CLUSTER_ID, CacheClusterStatus: 'available' }],
    });

    await provider.update('L', CLUSTER_ID, 'AWS::ElastiCache::CacheCluster', observed, observed);

    const modifyCall = mockSend.mock.calls.find((c) => c[0] instanceof ModifyCacheClusterCommand);
    expect(modifyCall).toBeDefined();
    const input = modifyCall![0].input as {
      SecurityGroupIds?: string[];
      SnapshotRetentionLimit?: number;
      EngineVersion?: string;
      AutoMinorVersionUpgrade?: boolean;
    };
    // Non-empty SG array preserved.
    expect(input.SecurityGroupIds).toEqual(['sg-abc']);
    expect(input.SnapshotRetentionLimit).toBe(5);
    expect(input.EngineVersion).toBe('7.0');
    expect(input.AutoMinorVersionUpgrade).toBe(true);
  });
});
