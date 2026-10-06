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
import { createdBeforeFailure } from '../../../src/provisioning/auxiliary-failure.js';
import { ProvisioningError } from '../../../src/utils/error-handler.js';

/**
 * Makes every `Date.now()` read a full day later than the last, so the REAL
 * available-waiter exits on its first deadline check and throws its own
 * timeout -- the realistic post-create failure, reached here with
 * `CDKD_NO_WAIT` unset. The waiter throws a plain `Error`, so it reaches the
 * mark through the wrap arm.
 */
function expireEveryDeadline(): void {
  let now = 1_700_000_000_000;
  vi.spyOn(Date, 'now').mockImplementation(() => (now += 86_400_000));
}

/** Route each SDK command by its class name to a handler. */
function route(handlers: Record<string, () => unknown>): void {
  mockSend.mockImplementation(async (command: { constructor: { name: string } }) => {
    const handler = handlers[command.constructor.name];
    if (!handler) throw new Error(`unexpected ${command.constructor.name}`);
    return handler();
  });
}

async function caught(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected a rejection');
}

const fail = (message: string) => () => {
  throw new Error(message);
};

// go-to-k/cdkd#4583: a failure after the create call returned names the
// resource still in AWS for `cdkd rollback --revert-failed`.
describe('ElastiCacheProvider create marks the resource it made before failing (#4583)', () => {
  let saved: string | undefined;

  beforeEach(() => {
    mockSend.mockReset();
    saved = process.env['CDKD_NO_WAIT'];
    process.env['CDKD_NO_WAIT'] = 'true';
  });

  afterEach(() => {
    if (saved === undefined) delete process.env['CDKD_NO_WAIT'];
    else process.env['CDKD_NO_WAIT'] = saved;
  });


  describe('AWS::ElastiCache::CacheCluster', () => {
    const TYPE = 'AWS::ElastiCache::CacheCluster';
    const props = {
      ClusterName: 'my-cache',
      Engine: 'redis',
      CacheNodeType: 'cache.t3.micro',
      NumCacheNodes: 1,
    };

    it('marks the cluster id when DescribeCacheClusters fails after CreateCacheCluster returned', async () => {
      route({
        CreateCacheClusterCommand: () => ({ CacheCluster: { CacheClusterId: 'my-cache' } }),
        DescribeCacheClustersCommand: fail('describe throttled'),
      });
      const error = await caught(new ElastiCacheProvider().create('Cache', TYPE, props));
      expect(createdBeforeFailure(error, 'Cache', TYPE)).toBe('my-cache');
    });

    it('marks the id a successful create returns when the real available-wait times out', async () => {
      delete process.env['CDKD_NO_WAIT'];
      route({
        CreateCacheClusterCommand: () => ({ CacheCluster: { CacheClusterId: 'my-cache' } }),
        DescribeCacheClustersCommand: () => ({
          CacheClusters: [{ CacheClusterId: 'my-cache', CacheClusterStatus: 'available' }],
        }),
      });
      const { physicalId } = await new ElastiCacheProvider().create('Cache', TYPE, props);

      mockSend.mockReset();
      route({
        CreateCacheClusterCommand: () => ({ CacheCluster: { CacheClusterId: 'my-cache' } }),
      });
      expireEveryDeadline();
      try {
        const error = await caught(new ElastiCacheProvider().create('Cache', TYPE, props));
        expect(error).toBeInstanceOf(ProvisioningError);
        expect((error as Error).message).toContain(
          'Timed out waiting for CacheCluster my-cache to become available'
        );
        expect(createdBeforeFailure(error, 'Cache', TYPE)).toBe(physicalId);
      } finally {
        vi.restoreAllMocks();
      }
    });

    it('does not mark when CreateCacheCluster itself fails', async () => {
      route({ CreateCacheClusterCommand: fail('CacheClusterAlreadyExists') });
      const error = await caught(new ElastiCacheProvider().create('Cache', TYPE, props));
      expect(createdBeforeFailure(error, 'Cache', TYPE)).toBeUndefined();
    });

    it('does not mark a malformed-Tags pre-flight refusal', async () => {
      const error = await caught(
        new ElastiCacheProvider().create('Cache', TYPE, { ...props, Tags: 'not-a-list' })
      );
      expect(mockSend).not.toHaveBeenCalled();
      expect(createdBeforeFailure(error, 'Cache', TYPE)).toBeUndefined();
    });
  });
});
