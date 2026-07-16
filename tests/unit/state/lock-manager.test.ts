import { describe, it, expect, beforeEach, vi } from 'vite-plus/test';
import { S3Client, S3ServiceException, NoSuchKey } from '@aws-sdk/client-s3';
import { LockManager } from '../../../src/state/lock-manager.js';
import type { LockInfo } from '../../../src/types/state.js';
import type { StateBackendConfig } from '../../../src/types/config.js';
import { LockError } from '../../../src/utils/error-handler.js';

// Mock the S3Client
// The stores' standard-shaped client doubles (config.region/credentials
// functions) pass resolveExpectedBucketOwner's structural guard, so STS
// must be mocked or every test would issue a LIVE GetCallerIdentity
// (PR 1015 reviewer catch: 22ms -> 15s + offline flakiness).
vi.mock('@aws-sdk/client-sts', () => ({
  STSClient: vi.fn().mockImplementation(() => ({
    send: vi.fn().mockResolvedValue({ Account: '111111111111' }),
    destroy: vi.fn(),
  })),
  GetCallerIdentityCommand: vi.fn().mockImplementation((input) => ({ ...input })),
}));

vi.mock('@aws-sdk/client-s3', async () => {
  const actual = await vi.importActual<typeof import('@aws-sdk/client-s3')>('@aws-sdk/client-s3');
  return {
    ...actual,
    S3Client: vi.fn().mockImplementation(() => ({
      send: vi.fn(),
    })),
  };
});

// Mock the region resolver so tests don't issue real GetBucketLocation calls.
// Each test case overrides the implementation as needed.
vi.mock('../../../src/utils/aws-region-resolver.js', async () => {
  const actual = await vi.importActual<typeof import('../../../src/utils/aws-region-resolver.js')>(
    '../../../src/utils/aws-region-resolver.js'
  );
  return {
    ...actual,
    resolveBucketRegion: vi.fn(),
  };
});

// Mock logger to suppress output during tests
vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    child: () => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

/**
 * Build a fake S3Client whose `.config.region()` returns the given region.
 * Mirrors the shape LockManager reads in `ensureClientForBucket`.
 * `config.credentials()` resolves a static identity so the probe-credentials
 * read in `ensureClientForBucket` exercises the happy path.
 */
function makeFakeClient(region: string): {
  send: ReturnType<typeof vi.fn>;
  config: {
    region: () => Promise<string>;
    credentials: () => Promise<{ accessKeyId: string; secretAccessKey: string }>;
  };
} {
  return {
    send: vi.fn(),
    config: {
      region: () => Promise.resolve(region),
      credentials: () =>
        Promise.resolve({ accessKeyId: 'AKIAFAKE', secretAccessKey: 'fake-secret' }),
    },
  };
}

describe('LockManager', () => {
  let s3Client: ReturnType<typeof makeFakeClient>;
  let lockManager: LockManager;
  const config: StateBackendConfig = {
    bucket: 'test-bucket',
    prefix: 'stacks',
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    // Default: bucket is already in the same region as the client, so
    // ensureClientForBucket() does not rebuild the client.
    const { resolveBucketRegion } = await import('../../../src/utils/aws-region-resolver.js');
    vi.mocked(resolveBucketRegion).mockResolvedValue('us-east-1');
    s3Client = makeFakeClient('us-east-1');
    lockManager = new LockManager(s3Client as unknown as S3Client, config);
  });

  describe('constructor with TTL options', () => {
    it('should use default TTL of 30 minutes', async () => {
      const manager = new LockManager(s3Client as unknown as S3Client, config);

      // Acquire lock and verify expiresAt is ~30 minutes from now
      s3Client.send.mockResolvedValueOnce({});

      const now = Date.now();
      await manager.acquireLock('test-stack', 'us-east-1');

      const putCall = s3Client.send.mock.calls[0][0];
      // Squatting hardening (PR 1015): lock writes carry the caller account.
      expect(putCall.input.ExpectedBucketOwner).toBe('111111111111');
      const lockBody = JSON.parse(putCall.input.Body) as LockInfo;
      const expectedExpiry = now + 30 * 60 * 1000;

      // Allow 1 second tolerance
      expect(lockBody.expiresAt).toBeGreaterThanOrEqual(expectedExpiry - 1000);
      expect(lockBody.expiresAt).toBeLessThanOrEqual(expectedExpiry + 1000);
    });

    it('should use custom TTL when specified', async () => {
      const manager = new LockManager(s3Client as unknown as S3Client, config, {
        ttlMinutes: 10,
      });

      s3Client.send.mockResolvedValueOnce({});

      const now = Date.now();
      await manager.acquireLock('test-stack', 'us-east-1');

      const putCall = s3Client.send.mock.calls[0][0];
      const lockBody = JSON.parse(putCall.input.Body) as LockInfo;
      const expectedExpiry = now + 10 * 60 * 1000;

      expect(lockBody.expiresAt).toBeGreaterThanOrEqual(expectedExpiry - 1000);
      expect(lockBody.expiresAt).toBeLessThanOrEqual(expectedExpiry + 1000);
    });
  });

  describe('acquireLock', () => {
    it('should acquire lock successfully with expiresAt at the region-scoped key', async () => {
      s3Client.send.mockResolvedValueOnce({});

      const result = await lockManager.acquireLock(
        'test-stack',
        'us-west-2',
        'test-owner',
        'deploy'
      );

      expect(result).toBe(true);

      const putCall = s3Client.send.mock.calls[0][0];
      expect(putCall.input.Bucket).toBe('test-bucket');
      // Region is part of the lock key now (PR 1 — collection model extension).
      expect(putCall.input.Key).toBe('stacks/test-stack/us-west-2/lock.json');
      expect(putCall.input.IfNoneMatch).toBe('*');

      const lockBody = JSON.parse(putCall.input.Body) as LockInfo;
      expect(lockBody.owner).toBe('test-owner');
      expect(lockBody.operation).toBe('deploy');
      expect(lockBody.timestamp).toBeDefined();
      expect(lockBody.expiresAt).toBeDefined();
      expect(lockBody.expiresAt).toBeGreaterThan(lockBody.timestamp);
    });

    it('should return false when lock exists and is not expired', async () => {
      // First call: PutObject fails (lock exists)
      const preconditionError = new S3ServiceException({ name: 'PreconditionFailed', $fault: 'client', $metadata: {} });
      s3Client.send.mockRejectedValueOnce(preconditionError);

      // Second call: GetObject returns a valid non-expired lock
      const existingLock: LockInfo = {
        owner: 'other-user@host:123',
        timestamp: Date.now(),
        expiresAt: Date.now() + 30 * 60 * 1000, // 30 min from now
        operation: 'deploy',
      };
      s3Client.send.mockResolvedValueOnce({
        Body: { transformToString: () => Promise.resolve(JSON.stringify(existingLock)) },
      });

      const result = await lockManager.acquireLock('test-stack', 'us-east-1', 'my-user');

      expect(result).toBe(false);
    });

    it('should clean up expired lock and re-acquire', async () => {
      // First call: PutObject fails (lock exists)
      const preconditionError = new S3ServiceException({ name: 'PreconditionFailed', $fault: 'client', $metadata: {} });
      s3Client.send.mockRejectedValueOnce(preconditionError);

      // Second call: GetObject returns an expired lock
      const expiredLock: LockInfo = {
        owner: 'old-user@host:123',
        timestamp: Date.now() - 60 * 60 * 1000, // 1 hour ago
        expiresAt: Date.now() - 30 * 60 * 1000, // expired 30 min ago
        operation: 'deploy',
      };
      s3Client.send.mockResolvedValueOnce({
        Body: { transformToString: () => Promise.resolve(JSON.stringify(expiredLock)) },
      });

      // Third call: DeleteObject (clean up expired lock)
      s3Client.send.mockResolvedValueOnce({});

      // Fourth call: PutObject retry succeeds
      s3Client.send.mockResolvedValueOnce({});

      const result = await lockManager.acquireLock('test-stack', 'us-east-1', 'new-user');

      expect(result).toBe(true);
      // Verify 4 S3 calls: PutObject(fail), GetObject, DeleteObject, PutObject(success)
      expect(s3Client.send).toHaveBeenCalledTimes(4);
    });

    it('should return false if another process acquires lock during expired lock cleanup', async () => {
      // First call: PutObject fails
      const preconditionError1 = new S3ServiceException({ name: 'PreconditionFailed', $fault: 'client', $metadata: {} });
      s3Client.send.mockRejectedValueOnce(preconditionError1);

      // Second call: GetObject returns expired lock
      const expiredLock: LockInfo = {
        owner: 'old-user@host:123',
        timestamp: Date.now() - 60 * 60 * 1000,
        expiresAt: Date.now() - 30 * 60 * 1000,
      };
      s3Client.send.mockResolvedValueOnce({
        Body: { transformToString: () => Promise.resolve(JSON.stringify(expiredLock)) },
      });

      // Third call: DeleteObject succeeds
      s3Client.send.mockResolvedValueOnce({});

      // Fourth call: PutObject fails again (another process got the lock)
      const preconditionError2 = new S3ServiceException({ name: 'PreconditionFailed', $fault: 'client', $metadata: {} });
      s3Client.send.mockRejectedValueOnce(preconditionError2);

      const result = await lockManager.acquireLock('test-stack', 'us-east-1', 'my-user');

      expect(result).toBe(false);
    });

    it('should throw LockError on unexpected S3 error', async () => {
      const s3Error = new Error('Access Denied');
      s3Error.name = 'AccessDenied';
      s3Client.send.mockRejectedValueOnce(s3Error);

      await expect(lockManager.acquireLock('test-stack', 'us-east-1')).rejects.toThrow(LockError);
    });
  });

  describe('getLockInfo', () => {
    it('should return lock info when lock exists', async () => {
      const lockInfo: LockInfo = {
        owner: 'user@host:123',
        timestamp: Date.now(),
        expiresAt: Date.now() + 30 * 60 * 1000,
        operation: 'deploy',
      };

      s3Client.send.mockResolvedValueOnce({
        Body: { transformToString: () => Promise.resolve(JSON.stringify(lockInfo)) },
      });

      const result = await lockManager.getLockInfo('test-stack', 'us-east-1');

      expect(result).toEqual(lockInfo);
    });

    it('should return null when no lock exists', async () => {
      const noSuchKeyError = new NoSuchKey({ message: 'NoSuchKey', $metadata: {} });
      s3Client.send.mockRejectedValueOnce(noSuchKeyError);

      const result = await lockManager.getLockInfo('test-stack', 'us-east-1');

      expect(result).toBeNull();
    });
  });

  describe('isLocked', () => {
    it('returns true when a lock file exists', async () => {
      const lockInfo: LockInfo = {
        owner: 'user@host:1',
        timestamp: Date.now(),
        expiresAt: Date.now() + 30 * 60 * 1000,
        operation: 'deploy',
      };
      s3Client.send.mockResolvedValueOnce({
        Body: { transformToString: () => Promise.resolve(JSON.stringify(lockInfo)) },
      });

      await expect(lockManager.isLocked('test-stack', 'us-east-1')).resolves.toBe(true);
    });

    it('returns true even when the existing lock is expired', async () => {
      const expired: LockInfo = {
        owner: 'old@host:1',
        timestamp: Date.now() - 60 * 60 * 1000,
        expiresAt: Date.now() - 30 * 60 * 1000,
      };
      s3Client.send.mockResolvedValueOnce({
        Body: { transformToString: () => Promise.resolve(JSON.stringify(expired)) },
      });

      // isLocked is a presence check; expiry is irrelevant here.
      await expect(lockManager.isLocked('test-stack', 'us-east-1')).resolves.toBe(true);
    });

    it('returns false when no lock file exists', async () => {
      const noSuchKeyError = new NoSuchKey({ message: 'NoSuchKey', $metadata: {} });
      s3Client.send.mockRejectedValueOnce(noSuchKeyError);

      await expect(lockManager.isLocked('test-stack', 'us-east-1')).resolves.toBe(false);
    });

    it('falls back to the legacy lock key when region is undefined', async () => {
      // Legacy callers (state-list integrations that haven't been updated to
      // pass the per-record region) probe the legacy `{prefix}/{stackName}/lock.json`
      // key directly.
      const noSuchKeyError = new NoSuchKey({ message: 'NoSuchKey', $metadata: {} });
      s3Client.send.mockRejectedValueOnce(noSuchKeyError);

      await expect(lockManager.isLocked('test-stack', undefined)).resolves.toBe(false);

      const get = s3Client.send.mock.calls[0][0];
      expect(get.input.Key).toBe('stacks/test-stack/lock.json');
    });
  });

  describe('releaseLock', () => {
    it('should delete the region-scoped lock file', async () => {
      s3Client.send.mockResolvedValueOnce({});

      await lockManager.releaseLock('test-stack', 'us-west-2');

      const deleteCall = s3Client.send.mock.calls[0][0];
      expect(deleteCall.input.Bucket).toBe('test-bucket');
      expect(deleteCall.input.Key).toBe('stacks/test-stack/us-west-2/lock.json');
    });

    it('should throw LockError on failure', async () => {
      s3Client.send.mockRejectedValueOnce(new Error('Network error'));

      await expect(lockManager.releaseLock('test-stack', 'us-east-1')).rejects.toThrow(LockError);
    });
  });

  describe('forceReleaseLock', () => {
    it('should release lock regardless of expiry status', async () => {
      // Non-expired lock
      const freshLock: LockInfo = {
        owner: 'other-user@host:456',
        timestamp: Date.now(),
        expiresAt: Date.now() + 30 * 60 * 1000,
        operation: 'deploy',
      };

      // GetObject returns the lock
      s3Client.send.mockResolvedValueOnce({
        Body: { transformToString: () => Promise.resolve(JSON.stringify(freshLock)) },
      });

      // DeleteObject succeeds
      s3Client.send.mockResolvedValueOnce({});

      await lockManager.forceReleaseLock('test-stack', 'us-east-1');

      // Should have called GetObject + DeleteObject
      expect(s3Client.send).toHaveBeenCalledTimes(2);
    });

    it('should release expired lock', async () => {
      const expiredLock: LockInfo = {
        owner: 'old-user@host:789',
        timestamp: Date.now() - 60 * 60 * 1000,
        expiresAt: Date.now() - 30 * 60 * 1000,
        operation: 'destroy',
      };

      s3Client.send.mockResolvedValueOnce({
        Body: { transformToString: () => Promise.resolve(JSON.stringify(expiredLock)) },
      });
      s3Client.send.mockResolvedValueOnce({});

      await lockManager.forceReleaseLock('test-stack', 'us-east-1');

      expect(s3Client.send).toHaveBeenCalledTimes(2);
    });

    it('should do nothing when no lock exists', async () => {
      const noSuchKeyError = new NoSuchKey({ message: 'NoSuchKey', $metadata: {} });
      s3Client.send.mockRejectedValueOnce(noSuchKeyError);

      await lockManager.forceReleaseLock('test-stack', 'us-east-1');

      // Only GetObject was called, no DeleteObject
      expect(s3Client.send).toHaveBeenCalledTimes(1);
    });
  });

  describe('acquireLockWithRetry', () => {
    it('should acquire on first attempt', async () => {
      s3Client.send.mockResolvedValueOnce({});

      await lockManager.acquireLockWithRetry('test-stack', 'us-east-1', 'user', 'deploy');

      expect(s3Client.send).toHaveBeenCalledTimes(1);
    });

    it('should retry and succeed on second attempt', async () => {
      // First attempt: PutObject fails
      const preconditionError = new S3ServiceException({ name: 'PreconditionFailed', $fault: 'client', $metadata: {} });
      s3Client.send.mockRejectedValueOnce(preconditionError);

      // getLockInfo for first failed attempt: lock not expired
      const activeLock: LockInfo = {
        owner: 'other@host:100',
        timestamp: Date.now(),
        expiresAt: Date.now() + 30 * 60 * 1000,
        operation: 'deploy',
      };
      s3Client.send.mockResolvedValueOnce({
        Body: { transformToString: () => Promise.resolve(JSON.stringify(activeLock)) },
      });

      // getLockInfo called by acquireLock's check (after PreconditionFailed returns false)
      // then acquireLockWithRetry calls getLockInfo again for the message
      s3Client.send.mockResolvedValueOnce({
        Body: { transformToString: () => Promise.resolve(JSON.stringify(activeLock)) },
      });

      // Second attempt: PutObject succeeds
      s3Client.send.mockResolvedValueOnce({});

      await lockManager.acquireLockWithRetry('test-stack', 'us-east-1', 'user', 'deploy', 3, 10);
    });

    it('should clean up expired lock during retry and acquire', async () => {
      // First attempt: PutObject fails
      const preconditionError = new S3ServiceException({ name: 'PreconditionFailed', $fault: 'client', $metadata: {} });
      s3Client.send.mockRejectedValueOnce(preconditionError);

      // GetObject: expired lock
      const expiredLock: LockInfo = {
        owner: 'dead-process@host:999',
        timestamp: Date.now() - 60 * 60 * 1000,
        expiresAt: Date.now() - 30 * 60 * 1000,
      };
      s3Client.send.mockResolvedValueOnce({
        Body: { transformToString: () => Promise.resolve(JSON.stringify(expiredLock)) },
      });

      // DeleteObject (cleanup)
      s3Client.send.mockResolvedValueOnce({});

      // PutObject retry succeeds (inside acquireLock)
      s3Client.send.mockResolvedValueOnce({});

      await lockManager.acquireLockWithRetry('test-stack', 'us-east-1', 'user', 'deploy', 3, 10);
    });

    it('should throw LockError after all retries exhausted', async () => {
      // Setup: lock is always held by another process (not expired)
      const activeLock: LockInfo = {
        owner: 'busy-user@host:200',
        timestamp: Date.now(),
        expiresAt: Date.now() + 30 * 60 * 1000,
        operation: 'deploy',
      };

      // Each attempt: PutObject fails + GetObject returns non-expired lock
      // acquireLock checks for expired lock internally, so each acquireLock call = 2 S3 calls
      // Then acquireLockWithRetry calls getLockInfo again for the retry message = 1 more S3 call
      // Total per attempt: 3 S3 calls
      // Plus final getLockInfo for the error message
      for (let i = 0; i < 20; i++) {
        const err = new Error('PreconditionFailed');
        err.name = 'PreconditionFailed';
        s3Client.send.mockRejectedValueOnce(err);
        s3Client.send.mockResolvedValueOnce({
          Body: { transformToString: () => Promise.resolve(JSON.stringify(activeLock)) },
        });
        s3Client.send.mockResolvedValueOnce({
          Body: { transformToString: () => Promise.resolve(JSON.stringify(activeLock)) },
        });
      }

      await expect(
        lockManager.acquireLockWithRetry('test-stack', 'us-east-1', 'user', 'deploy', 3, 10)
      ).rejects.toThrow(LockError);
    });

    it('should throw LockError with helpful message after retries exhausted', async () => {
      // All attempts fail with PreconditionFailed (lock held)
      const err = new Error('PreconditionFailed');
      err.name = 'PreconditionFailed';
      s3Client.send.mockRejectedValue(err);

      try {
        await lockManager.acquireLockWithRetry('test-stack', 'us-east-1', 'user', 'deploy', 1, 10);
        expect.unreachable('Should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(LockError);
        const lockError = error as LockError;
        expect(lockError.message).toContain('test-stack');
      }
    });
  });

  describe('lock.json format', () => {
    it('should write lock with correct JSON structure', async () => {
      s3Client.send.mockResolvedValueOnce({});

      await lockManager.acquireLock('test-stack', 'us-east-1', 'user@host:123', 'deploy');

      const putCall = s3Client.send.mock.calls[0][0];
      const lockBody = JSON.parse(putCall.input.Body);

      // Verify the exact lock.json structure
      expect(lockBody).toHaveProperty('owner', 'user@host:123');
      expect(lockBody).toHaveProperty('operation', 'deploy');
      expect(lockBody).toHaveProperty('timestamp');
      expect(lockBody).toHaveProperty('expiresAt');
      expect(typeof lockBody.timestamp).toBe('number');
      expect(typeof lockBody.expiresAt).toBe('number');
      expect(lockBody.expiresAt).toBeGreaterThan(lockBody.timestamp);
    });

    it('should omit operation when not provided', async () => {
      s3Client.send.mockResolvedValueOnce({});

      await lockManager.acquireLock('test-stack', 'us-east-1', 'user@host:123');

      const putCall = s3Client.send.mock.calls[0][0];
      const lockBody = JSON.parse(putCall.input.Body);

      expect(lockBody).not.toHaveProperty('operation');
      expect(lockBody).toHaveProperty('owner');
      expect(lockBody).toHaveProperty('timestamp');
      expect(lockBody).toHaveProperty('expiresAt');
    });
  });
});

describe('LockManager.ensureClientForBucket — region rebuild (issue #803)', () => {
  const config: StateBackendConfig = {
    bucket: 'cross-region-bucket',
    prefix: 'cdkd',
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('acquires the lock through a region-corrected client when the bucket region differs (pre-fix: 301 PermanentRedirect)', async () => {
    const { resolveBucketRegion } = await import('../../../src/utils/aws-region-resolver.js');
    // Bucket lives in us-west-2, the supplied client was created for us-east-1.
    vi.mocked(resolveBucketRegion).mockResolvedValue('us-west-2');

    const initialClient = makeFakeClient('us-east-1');
    // Pre-fix behavior: a PutObject against the wrong regional endpoint fails
    // with S3's 301 PermanentRedirect. If the LockManager still used the
    // original client, acquireLock would throw a LockError.
    initialClient.send.mockRejectedValue(
      new S3ServiceException({
        name: 'PermanentRedirect',
        $fault: 'client',
        $metadata: { httpStatusCode: 301 },
        message:
          'The bucket you are attempting to access must be addressed using the specified endpoint.',
      })
    );

    // The rebuilt (us-west-2) client succeeds.
    const rebuiltSend = vi.fn().mockResolvedValue({});
    vi.mocked(S3Client).mockImplementation(() => ({ send: rebuiltSend }) as unknown as S3Client);

    const lockManager = new LockManager(initialClient as unknown as S3Client, config);
    const acquired = await lockManager.acquireLock('test-stack', 'ap-northeast-1');

    expect(acquired).toBe(true);
    // A replacement client was constructed for the bucket's actual region.
    expect(vi.mocked(S3Client)).toHaveBeenCalledWith(
      expect.objectContaining({ region: 'us-west-2' })
    );
    // The PutObject went through the rebuilt client, not the original one.
    expect(rebuiltSend).toHaveBeenCalledTimes(1);
    expect(initialClient.send).not.toHaveBeenCalled();
    const putCall = rebuiltSend.mock.calls[0][0];
    expect(putCall.input.Bucket).toBe('cross-region-bucket');
    expect(putCall.input.Key).toBe('cdkd/test-stack/ap-northeast-1/lock.json');
    expect(putCall.input.IfNoneMatch).toBe('*');
  });

  it('does not rebuild the client when the resolved region matches', async () => {
    const { resolveBucketRegion } = await import('../../../src/utils/aws-region-resolver.js');
    vi.mocked(resolveBucketRegion).mockResolvedValue('us-east-1');

    const initialClient = makeFakeClient('us-east-1');
    initialClient.send.mockResolvedValue({});

    // Reset the constructor call counter so we can assert on rebuilds only.
    vi.mocked(S3Client).mockClear();

    const lockManager = new LockManager(initialClient as unknown as S3Client, config);
    const acquired = await lockManager.acquireLock('test-stack', 'us-east-1');

    expect(acquired).toBe(true);
    // No replacement client was constructed; the original client was used.
    expect(vi.mocked(S3Client)).not.toHaveBeenCalled();
    expect(initialClient.send).toHaveBeenCalledTimes(1);
  });

  it('only resolves the bucket region once across multiple lock operations', async () => {
    const { resolveBucketRegion } = await import('../../../src/utils/aws-region-resolver.js');
    vi.mocked(resolveBucketRegion).mockResolvedValue('us-east-1');

    const initialClient = makeFakeClient('us-east-1');
    initialClient.send.mockResolvedValue({
      Body: {
        transformToString: () =>
          Promise.resolve(
            JSON.stringify({
              owner: 'a@b:1',
              timestamp: Date.now(),
              expiresAt: Date.now() + 60_000,
            })
          ),
      },
    });

    const lockManager = new LockManager(initialClient as unknown as S3Client, config);

    await lockManager.acquireLock('test-stack', 'us-east-1');
    await lockManager.getLockInfo('test-stack', 'us-east-1');
    await lockManager.releaseLock('test-stack', 'us-east-1');

    // resolveBucketRegion should have been called exactly once even though
    // three lock operations ran (no repeated GetBucketLocation).
    expect(vi.mocked(resolveBucketRegion)).toHaveBeenCalledTimes(1);
  });

  it('passes the original client credentials and region fallback to the resolver', async () => {
    const { resolveBucketRegion } = await import('../../../src/utils/aws-region-resolver.js');
    vi.mocked(resolveBucketRegion).mockResolvedValue('us-east-1');

    const initialClient = makeFakeClient('us-east-1');
    initialClient.send.mockResolvedValue({});

    const lockManager = new LockManager(initialClient as unknown as S3Client, config);
    await lockManager.acquireLock('test-stack', 'us-east-1');

    expect(vi.mocked(resolveBucketRegion)).toHaveBeenCalledWith(
      'cross-region-bucket',
      expect.objectContaining({
        fallbackRegion: 'us-east-1',
        credentials: expect.objectContaining({ accessKeyId: 'AKIAFAKE' }),
      })
    );
  });
});
