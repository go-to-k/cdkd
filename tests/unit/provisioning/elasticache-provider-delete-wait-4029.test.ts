import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

/**
 * Issue #4029 (found by the `cc-final-snapshot-handlers` fixture): a Redis
 * cache-cluster delete can outlast ten minutes. `ElastiCacheProvider` now
 * waits the Cloud Control route's DELETE floor, and a delete already under
 * way (an earlier attempt whose wait ran out) is waited on instead of failing
 * on AWS's second-delete refusal.
 */

const send = vi.hoisted(() => vi.fn());

vi.mock('@aws-sdk/client-elasticache', async () => {
  const actual = await vi.importActual('@aws-sdk/client-elasticache');
  return {
    ...actual,
    ElastiCacheClient: vi.fn().mockImplementation(() => ({
      send,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
  };
});

vi.mock('../../../src/utils/logger.js', () => {
  const child = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  return { getLogger: () => ({ child: () => child }) };
});

import { ElastiCacheProvider } from '../../../src/provisioning/providers/elasticache-provider.js';
import { slowCcOperationTimeoutMs } from '../../../src/provisioning/slow-cc-operation-timeouts.js';

const TYPE = 'AWS::ElastiCache::CacheCluster';

function awsError(name: string, message = name): Error {
  return Object.assign(new Error(message), { name });
}

/** Describes answer `statuses` in order, then report the cluster gone. */
function script(deleteResult: Error | undefined, statuses: string[]): void {
  const queue = [...statuses];
  send.mockImplementation((cmd) => {
    const name = cmd.constructor.name as string;
    if (name === 'DeleteCacheClusterCommand') {
      return deleteResult ? Promise.reject(deleteResult) : Promise.resolve({});
    }
    if (name === 'DescribeCacheClustersCommand') {
      const status = queue.shift();
      return status === undefined
        ? Promise.reject(awsError('CacheClusterNotFoundFault', 'gone'))
        : Promise.resolve({ CacheClusters: [{ CacheClusterStatus: status }] });
    }
    return Promise.resolve({});
  });
}

describe('ElastiCacheProvider cache-cluster delete (issue #4029)', () => {
  let provider: ElastiCacheProvider;

  beforeEach(() => {
    send.mockReset();
    provider = new ElastiCacheProvider();
    vi.spyOn(
      provider as unknown as { sleep: (ms: number) => Promise<void> },
      'sleep'
    ).mockResolvedValue(undefined);
  });

  it('waits the Cloud Control DELETE floor, not ten minutes', async () => {
    script(undefined, []);
    const wait = vi.spyOn(
      provider as unknown as {
        waitForClusterDeleted: (logicalId: string, id: string, ms?: number) => Promise<void>;
      },
      'waitForClusterDeleted'
    );

    await provider.delete('Cache', 'c-1', TYPE);

    expect(wait).toHaveBeenCalledWith(
      'Cache',
      'c-1',
      Math.max(600_000, slowCcOperationTimeoutMs(TYPE, 'DELETE'))
    );
    expect(slowCcOperationTimeoutMs(TYPE, 'DELETE')).toBeGreaterThan(600_000);
  });

  it('a delete already under way is waited on, not failed', async () => {
    // The refusal's describe says deleting; the wait then sees it gone.
    script(awsError('InvalidCacheClusterStateFault', 'has state: deleting'), ['deleting']);

    await expect(provider.delete('Cache', 'c-1', TYPE)).resolves.toBeUndefined();
  });

  it('a Snapshot-policy delete never absorbs an in-flight delete: its snapshot was never taken', async () => {
    script(awsError('InvalidCacheClusterStateFault', 'has state: deleting'), ['deleting']);

    await expect(
      provider.delete('Cache', 'c-1', TYPE, undefined, { finalSnapshotIdentifier: 'snap-b' })
    ).rejects.toThrow('Failed to delete CacheCluster Cache');
    expect(
      send.mock.calls.filter((c) => c[0].constructor.name === 'DescribeCacheClustersCommand')
    ).toHaveLength(0);
  });

  it('the same refusal for any OTHER state fails the delete', async () => {
    script(awsError('InvalidCacheClusterStateFault', 'has state: modifying'), ['modifying']);

    await expect(provider.delete('Cache', 'c-1', TYPE)).rejects.toThrow(
      'Failed to delete CacheCluster Cache'
    );
  });

  it('a different error is not read as an in-flight delete', async () => {
    script(awsError('InvalidParameterValue', 'bad'), ['deleting']);

    await expect(provider.delete('Cache', 'c-1', TYPE)).rejects.toThrow(
      'Failed to delete CacheCluster Cache'
    );
    expect(
      send.mock.calls.filter((c) => c[0].constructor.name === 'DescribeCacheClustersCommand')
    ).toHaveLength(0);
  });
});
