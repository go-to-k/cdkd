import { describe, it, expect, beforeEach, afterEach, vi } from 'vite-plus/test';
import { S3Client, S3ServiceException, NoSuchKey } from '@aws-sdk/client-s3';
import { LockManager } from '../../../src/state/lock-manager.js';
import type { LockManagerOptions } from '../../../src/state/lock-manager.js';
import type { LockInfo } from '../../../src/types/state.js';
import type { StateBackendConfig } from '../../../src/types/config.js';
import { LockError } from '../../../src/utils/error-handler.js';

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
    S3Client: vi.fn().mockImplementation(() => ({ send: vi.fn() })),
  };
});

vi.mock('../../../src/utils/aws-region-resolver.js', async () => {
  const actual = await vi.importActual<typeof import('../../../src/utils/aws-region-resolver.js')>(
    '../../../src/utils/aws-region-resolver.js'
  );
  return { ...actual, resolveBucketRegion: vi.fn() };
});

// A STABLE logger double, unlike the per-call factory in lock-manager.test.ts:
// these assertions are about which warning the user is shown, so the spy has
// to survive the `child()` call the LockManager makes at construction.
const logs = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};
vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({ child: () => logs, ...logs }),
}));

function makeFakeClient(): {
  send: ReturnType<typeof vi.fn>;
  config: {
    region: () => Promise<string>;
    credentials: () => Promise<{ accessKeyId: string; secretAccessKey: string }>;
  };
} {
  return {
    send: vi.fn(),
    config: {
      region: () => Promise.resolve('us-east-1'),
      credentials: () =>
        Promise.resolve({ accessKeyId: 'AKIAFAKE', secretAccessKey: 'fake-secret' }),
    },
  };
}

const PRECONDITION_FAILED = (): S3ServiceException =>
  new S3ServiceException({
    name: 'PreconditionFailed',
    $fault: 'client',
    $metadata: { httpStatusCode: 412 },
  } as never);

const ACCESS_DENIED = (): S3ServiceException =>
  new S3ServiceException({
    name: 'AccessDenied',
    $fault: 'client',
    $metadata: { httpStatusCode: 403 },
  } as never);

const CONFLICT = (): S3ServiceException =>
  new S3ServiceException({
    name: 'ConditionalRequestConflict',
    $fault: 'client',
    $metadata: { httpStatusCode: 409 },
  } as never);

const SLOW_DOWN = (): S3ServiceException =>
  new S3ServiceException({
    name: 'SlowDown',
    $fault: 'server',
    $metadata: { httpStatusCode: 503 },
  } as never);

/**
 * An `S3ServiceException` with an arbitrary name/status pair.
 *
 * Needed because every predicate under test is a DISJUNCTION over names and
 * statuses, and a fixture that satisfies several clauses at once fences none
 * of them -- the exact failure round 1 caught in `adoptOwnWrite` and round 2
 * caught again in `isConditionUnsupportedError`. Each clause therefore gets a
 * fixture that trips only it.
 */
const s3err = (name: string, status: number, fault: 'client' | 'server' = 'client') =>
  new S3ServiceException({ name, $fault: fault, $metadata: { httpStatusCode: status } } as never);

const NO_SUCH_BUCKET = (): S3ServiceException =>
  new S3ServiceException({
    name: 'NoSuchBucket',
    $fault: 'client',
    $metadata: { httpStatusCode: 404 },
  } as never);

const NOT_FOUND = (): S3ServiceException =>
  new S3ServiceException({
    name: 'NotFound',
    $fault: 'client',
    $metadata: { httpStatusCode: 404 },
  } as never);

const NO_SUCH_KEY = (): NoSuchKey =>
  new NoSuchKey({ message: 'gone', $metadata: { httpStatusCode: 404 } });

describe('LockManager lock renewal and conditional release (issue #2168)', () => {
  let s3Client: ReturnType<typeof makeFakeClient>;
  const config: StateBackendConfig = { bucket: 'test-bucket', prefix: 'stacks' };

  beforeEach(async () => {
    vi.clearAllMocks();
    logs.debug.mockClear();
    logs.info.mockClear();
    logs.warn.mockClear();
    logs.error.mockClear();
    const { resolveBucketRegion } = await import('../../../src/utils/aws-region-resolver.js');
    vi.mocked(resolveBucketRegion).mockResolvedValue('us-east-1');
    s3Client = makeFakeClient();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Every command handed to `send`, in order. */
  const commands = (): { name: string; input: Record<string, unknown> }[] =>
    s3Client.send.mock.calls.map((c) => ({
      name: (c[0] as { constructor: { name: string } }).constructor.name,
      input: (c[0] as { input: Record<string, unknown> }).input,
    }));

  const puts = (): Record<string, unknown>[] =>
    commands()
      .filter((c) => c.name === 'PutObjectCommand')
      .map((c) => c.input);

  const deletes = (): Record<string, unknown>[] =>
    commands()
      .filter((c) => c.name === 'DeleteObjectCommand')
      .map((c) => c.input);

  /** Acquire a lock whose PUT returns `etag`, with renewal live. */
  async function acquireWith(
    etag: string | undefined,
    options?: LockManagerOptions
  ): Promise<LockManager> {
    const manager = new LockManager(s3Client as unknown as S3Client, config, options);
    s3Client.send.mockResolvedValueOnce({ ETag: etag });
    const ok = await manager.acquireLock('test-stack', 'us-east-1', 'owner-a', 'deploy');
    expect(ok).toBe(true);
    return manager;
  }

  describe('renewal', () => {
    it('re-PUTs the lock conditionally on the acquisition ETag, moving expiresAt forward', async () => {
      vi.useFakeTimers();
      const manager = await acquireWith('"etag-1"');

      const acquired = JSON.parse(puts()[0]['Body'] as string) as LockInfo;
      expect(puts()[0]['IfNoneMatch']).toBe('*');

      s3Client.send.mockResolvedValueOnce({ ETag: '"etag-2"' });
      await vi.advanceTimersByTimeAsync(2 * 60 * 1000);

      const renewal = puts()[1];
      expect(renewal['IfMatch']).toBe('"etag-1"');
      expect(renewal['IfNoneMatch']).toBeUndefined();
      const renewed = JSON.parse(renewal['Body'] as string) as LockInfo;
      expect(renewed.expiresAt).toBeGreaterThan(acquired.expiresAt);
      expect(renewed.owner).toBe('owner-a');
      expect(renewed.operation).toBe('deploy');
      expect(renewed.timestamp).toBe(acquired.timestamp);

      // Drain: stop the interval so nothing leaks into the next test.
      s3Client.send.mockResolvedValueOnce({});
      await manager.releaseLock('test-stack', 'us-east-1');
    });

    it('chains ETags so the second renewal is conditional on the first renewal', async () => {
      vi.useFakeTimers();
      const manager = await acquireWith('"etag-1"');

      s3Client.send.mockResolvedValueOnce({ ETag: '"etag-2"' });
      await vi.advanceTimersByTimeAsync(2 * 60 * 1000);
      s3Client.send.mockResolvedValueOnce({ ETag: '"etag-3"' });
      await vi.advanceTimersByTimeAsync(2 * 60 * 1000);

      expect(puts()[1]['IfMatch']).toBe('"etag-1"');
      expect(puts()[2]['IfMatch']).toBe('"etag-2"');

      s3Client.send.mockResolvedValueOnce({});
      await manager.releaseLock('test-stack', 'us-east-1');
      expect(deletes()[0]['IfMatch']).toBe('"etag-3"');
    });

    it('caps the interval at 2 minutes even though the default TTL is 30', async () => {
      vi.useFakeTimers();
      const manager = await acquireWith('"etag-1"');

      // A pure TTL/4 schedule would be 7.5 min and nothing would have fired.
      s3Client.send.mockResolvedValueOnce({ ETag: '"etag-2"' });
      await vi.advanceTimersByTimeAsync(2 * 60 * 1000);
      expect(puts()).toHaveLength(2);

      s3Client.send.mockResolvedValueOnce({});
      await manager.releaseLock('test-stack', 'us-east-1');
    });

    it('shortens the interval to a quarter of a TTL below the cap', async () => {
      vi.useFakeTimers();
      const manager = await acquireWith('"etag-1"', { ttlMinutes: 1 });

      await vi.advanceTimersByTimeAsync(14 * 1000);
      expect(puts()).toHaveLength(1);

      s3Client.send.mockResolvedValueOnce({ ETag: '"etag-2"' });
      await vi.advanceTimersByTimeAsync(1 * 1000);
      expect(puts()).toHaveLength(2);

      s3Client.send.mockResolvedValueOnce({});
      await manager.releaseLock('test-stack', 'us-east-1');
    });

    it('stops renewing and warns when S3 answers 412 (someone else took the lock)', async () => {
      vi.useFakeTimers();
      const manager = await acquireWith('"etag-1"');

      s3Client.send.mockRejectedValueOnce(PRECONDITION_FAILED());
      await vi.advanceTimersByTimeAsync(2 * 60 * 1000);
      expect(puts()).toHaveLength(2);

      // Further ticks must issue nothing at all.
      await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
      expect(puts()).toHaveLength(2);

      expect(logs.warn.mock.calls.map((c) => String(c[0])).join('\n')).toContain(
        "Lost the lock for stack 'test-stack'"
      );

      // And the release must not delete the new owner's lock.
      await manager.releaseLock('test-stack', 'us-east-1');
      expect(deletes()).toHaveLength(0);
    });

    it('adopts its own renewal when a 412 was caused by a lost response, not a takeover', async () => {
      // A conditional PUT S3 APPLIED but whose response never arrived (or an
      // SDK-internal retry of it) leaves the cached ETag one version behind,
      // so the retry's `IfMatch` 412s even though the lock is still ours.
      vi.useFakeTimers();
      const manager = await acquireWith('"etag-1"');
      const acquiredBody = JSON.parse(puts()[0]['Body'] as string) as LockInfo;

      let renewalBody: LockInfo | undefined;
      s3Client.send.mockImplementationOnce((cmd: { input: { Body: string } }) => {
        renewalBody = JSON.parse(cmd.input.Body) as LockInfo;
        return Promise.reject(PRECONDITION_FAILED());
      });
      // The disambiguating read: the object holds exactly what we just wrote.
      s3Client.send.mockImplementationOnce(() =>
        Promise.resolve({
          ETag: '"etag-2"',
          Body: { transformToString: () => Promise.resolve(JSON.stringify(renewalBody)) },
        })
      );
      await vi.advanceTimersByTimeAsync(2 * 60 * 1000);

      expect(logs.warn).not.toHaveBeenCalled();

      // It keeps renewing, now chained on the ETag the read reported.
      s3Client.send.mockResolvedValueOnce({ ETag: '"etag-3"' });
      await vi.advanceTimersByTimeAsync(2 * 60 * 1000);
      expect(puts()[2]['IfMatch']).toBe('"etag-2"');

      // And it still releases its OWN lock, which is what the pessimistic
      // reading would have refused to do.
      s3Client.send.mockResolvedValueOnce({});
      await manager.releaseLock('test-stack', 'us-east-1');
      expect(deletes()).toHaveLength(1);
      expect(deletes()[0]['IfMatch']).toBe('"etag-3"');
      expect(acquiredBody.timestamp).toBe(renewalBody?.timestamp);
    });

    // `adoptOwnWrite` is a CONJUNCTION -- owner, expiresAt, timestamp and a
    // present ETag must all match. A single "somebody else" fixture differs in
    // every clause at once, so it fences NONE of them: delete any one check
    // and it still fails for the others' sake. Each clause therefore gets a
    // body that differs in exactly that one field.
    const adoptionRejectedBy = (
      mutate: (body: LockInfo) => Record<string, unknown>,
      etag: string | undefined
    ): void => {
      let renewalBody: LockInfo | undefined;
      s3Client.send.mockImplementationOnce((cmd: { input: { Body: string } }) => {
        renewalBody = JSON.parse(cmd.input.Body) as LockInfo;
        return Promise.reject(PRECONDITION_FAILED());
      });
      s3Client.send.mockImplementationOnce(() =>
        Promise.resolve({
          ...(etag !== undefined && { ETag: etag }),
          Body: {
            transformToString: () =>
              Promise.resolve(JSON.stringify(mutate(renewalBody as LockInfo))),
          },
        })
      );
    };

    const expectLost = async (manager: LockManager): Promise<void> => {
      expect(logs.warn.mock.calls.map((c) => String(c[0])).join('\n')).toContain(
        "Lost the lock for stack 'test-stack'"
      );
      await manager.releaseLock('test-stack', 'us-east-1');
      expect(deletes()).toHaveLength(0);
    };

    it('adopts through displaySafe, so a stripped codepoint in $USER is not a disowning', async () => {
      // `record.info.owner` has been through `displaySafe` (strip + trim);
      // `renewed.owner` has not. A raw comparison therefore NEVER matches for
      // a $USER or hostname carrying such a codepoint, and the process then
      // declares its own lock lost and refuses to release it for a full TTL.
      vi.useFakeTimers();
      const manager = new LockManager(s3Client as unknown as S3Client, config);
      s3Client.send.mockResolvedValueOnce({ ETag: '"etag-1"' });
      // A BEL inside the owner: displaySafe strips it, the raw value keeps it.
      const rawOwner = `owner-\u0007a`;
      expect(await manager.acquireLock('test-stack', 'us-east-1', rawOwner, 'renew')).toBe(true);

      let renewalBody: LockInfo | undefined;
      s3Client.send.mockImplementationOnce((cmd: { input: { Body: string } }) => {
        renewalBody = JSON.parse(cmd.input.Body) as LockInfo;
        return Promise.reject(PRECONDITION_FAILED());
      });
      s3Client.send.mockImplementationOnce(() =>
        Promise.resolve({
          ETag: '"etag-2"',
          Body: { transformToString: () => Promise.resolve(JSON.stringify(renewalBody)) },
        })
      );
      await vi.advanceTimersByTimeAsync(2 * 60 * 1000);

      expect(renewalBody?.owner).toBe(rawOwner);
      expect(logs.warn).not.toHaveBeenCalled();

      s3Client.send.mockResolvedValueOnce({});
      await manager.releaseLock('test-stack', 'us-east-1');
      expect(deletes()[0]['IfMatch']).toBe('"etag-2"');
    });

    it('does not adopt a 412 body whose OWNER differs', async () => {
      vi.useFakeTimers();
      const manager = await acquireWith('"etag-1"');
      adoptionRejectedBy((b) => ({ ...b, owner: 'someone-else' }), '"etag-other"');
      await vi.advanceTimersByTimeAsync(2 * 60 * 1000);
      await expectLost(manager);
    });

    it('does not adopt a 412 body whose EXPIRESAT differs', async () => {
      // The likeliest real shape: another process renewing its own lock -- the
      // owner could even collide after a pid reuse, but the millisecond it
      // stamped will not.
      vi.useFakeTimers();
      const manager = await acquireWith('"etag-1"');
      adoptionRejectedBy((b) => ({ ...b, expiresAt: b.expiresAt + 1 }), '"etag-other"');
      await vi.advanceTimersByTimeAsync(2 * 60 * 1000);
      await expectLost(manager);
    });

    it('does not adopt a 412 body whose TIMESTAMP differs', async () => {
      // Same owner string, same expiry, different acquisition: a distinct lock.
      vi.useFakeTimers();
      const manager = await acquireWith('"etag-1"');
      adoptionRejectedBy((b) => ({ ...b, timestamp: b.timestamp - 1 }), '"etag-other"');
      await vi.advanceTimersByTimeAsync(2 * 60 * 1000);
      await expectLost(manager);
    });

    it('does not adopt a matching body that came back with NO ETag', async () => {
      // Adopting `undefined` would leave nothing to chain the next conditional
      // write onto, and would make the eventual release unconditional.
      vi.useFakeTimers();
      const manager = await acquireWith('"etag-1"');
      adoptionRejectedBy((b) => ({ ...b }), undefined);
      await vi.advanceTimersByTimeAsync(2 * 60 * 1000);
      await expectLost(manager);
    });

    it('declares the lock lost when the disambiguating read itself fails', async () => {
      // An unreadable lock is not evidence of ownership.
      vi.useFakeTimers();
      const manager = await acquireWith('"etag-1"');

      s3Client.send.mockRejectedValueOnce(PRECONDITION_FAILED());
      s3Client.send.mockRejectedValueOnce(new Error('AccessDenied'));
      await vi.advanceTimersByTimeAsync(2 * 60 * 1000);

      expect(logs.warn.mock.calls.map((c) => String(c[0])).join('\n')).toContain(
        "Lost the lock for stack 'test-stack'"
      );
      await manager.releaseLock('test-stack', 'us-east-1');
      expect(deletes()).toHaveLength(0);
    });

    it('stops renewing when the lock object was deleted outright (404)', async () => {
      vi.useFakeTimers();
      const manager = await acquireWith('"etag-1"');

      s3Client.send.mockRejectedValueOnce(NOT_FOUND());
      await vi.advanceTimersByTimeAsync(2 * 60 * 1000);
      await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
      expect(puts()).toHaveLength(2);

      await manager.releaseLock('test-stack', 'us-east-1');
      expect(deletes()).toHaveLength(0);
    });

    it('keeps renewing after a transient failure', async () => {
      vi.useFakeTimers();
      const manager = await acquireWith('"etag-1"');

      s3Client.send.mockRejectedValueOnce(new Error('ThrottlingException'));
      await vi.advanceTimersByTimeAsync(2 * 60 * 1000);
      expect(puts()).toHaveLength(2);

      // The next tick retries with the SAME ETag, since nothing was written.
      s3Client.send.mockResolvedValueOnce({ ETag: '"etag-2"' });
      await vi.advanceTimersByTimeAsync(2 * 60 * 1000);
      expect(puts()).toHaveLength(3);
      expect(puts()[2]['IfMatch']).toBe('"etag-1"');
      expect(logs.warn).not.toHaveBeenCalled();

      s3Client.send.mockResolvedValueOnce({});
      await manager.releaseLock('test-stack', 'us-east-1');
    });

    it('skips a tick while a renewal is still in flight, rather than racing itself', async () => {
      // Two concurrent renewals share one ETag; the loser 412s, and without
      // this guard that reads as a takeover -- so the process would declare
      // its OWN lock lost and then refuse to release it.
      vi.useFakeTimers();
      const manager = await acquireWith('"etag-1"');

      let settle: (v: { ETag: string }) => void = () => {};
      s3Client.send.mockReturnValueOnce(
        new Promise<{ ETag: string }>((resolve) => {
          settle = resolve;
        })
      );
      await vi.advanceTimersByTimeAsync(2 * 60 * 1000);
      expect(puts()).toHaveLength(2);

      // A second tick fires while the first is still outstanding.
      await vi.advanceTimersByTimeAsync(2 * 60 * 1000);
      expect(puts()).toHaveLength(2);

      settle({ ETag: '"etag-2"' });
      await vi.advanceTimersByTimeAsync(0);
      s3Client.send.mockResolvedValueOnce({});
      await manager.releaseLock('test-stack', 'us-east-1');
      expect(logs.warn).not.toHaveBeenCalled();
    });

    it('respects the 1s floor so a tiny TTL cannot spin the loop', async () => {
      vi.useFakeTimers();
      // 3s TTL: a quarter is 750ms, which the floor lifts to 1000ms.
      const manager = await acquireWith('"etag-1"', { ttlMinutes: 0.05 });

      await vi.advanceTimersByTimeAsync(999);
      expect(puts()).toHaveLength(1);
      s3Client.send.mockResolvedValueOnce({ ETag: '"etag-2"' });
      await vi.advanceTimersByTimeAsync(1);
      expect(puts()).toHaveLength(2);

      s3Client.send.mockResolvedValueOnce({});
      await manager.releaseLock('test-stack', 'us-east-1');
    });

    it('re-arms the past-expiry warning after a renewal succeeds again', async () => {
      vi.useFakeTimers();
      const manager = await acquireWith('"etag-1"', { ttlMinutes: 4 });
      const failFor = async (n: number): Promise<void> => {
        for (let i = 0; i < n; i += 1) {
          s3Client.send.mockRejectedValueOnce(new Error('ThrottlingException'));
          await vi.advanceTimersByTimeAsync(60 * 1000);
        }
      };
      const pastExpiryWarnings = (): number =>
        logs.warn.mock.calls.filter((c) => String(c[0]).includes('has been failing long enough')).length;

      await failFor(6);
      expect(pastExpiryWarnings()).toBe(1);

      s3Client.send.mockResolvedValueOnce({ ETag: '"etag-2"' });
      await vi.advanceTimersByTimeAsync(60 * 1000);

      await failFor(6);
      expect(pastExpiryWarnings()).toBe(2);

      s3Client.send.mockResolvedValueOnce({});
      await manager.releaseLock('test-stack', 'us-east-1');
    });

    it('re-arms the past-expiry warning after an ADOPTED renewal too', async () => {
      // An adopted renewal is a successful one. Only the full-success path
      // used to reset the flag, so a second expiry episode after an adopt was
      // silent.
      vi.useFakeTimers();
      const manager = await acquireWith('"etag-1"', { ttlMinutes: 4 });
      const pastExpiryWarnings = (): number =>
        logs.warn.mock.calls.filter((c) => String(c[0]).includes('has been failing long enough')).length;
      const failFor = async (n: number): Promise<void> => {
        for (let i = 0; i < n; i += 1) {
          s3Client.send.mockRejectedValueOnce(new Error('ThrottlingException'));
          await vi.advanceTimersByTimeAsync(60 * 1000);
        }
      };

      await failFor(6);
      expect(pastExpiryWarnings()).toBe(1);

      // A renewal that 412s but turns out to be this process's own write.
      let renewalBody: LockInfo | undefined;
      s3Client.send.mockImplementationOnce((cmd: { input: { Body: string } }) => {
        renewalBody = JSON.parse(cmd.input.Body) as LockInfo;
        return Promise.reject(PRECONDITION_FAILED());
      });
      s3Client.send.mockImplementationOnce(() =>
        Promise.resolve({
          ETag: '"etag-2"',
          Body: { transformToString: () => Promise.resolve(JSON.stringify(renewalBody)) },
        })
      );
      await vi.advanceTimersByTimeAsync(60 * 1000);

      await failFor(6);
      expect(pastExpiryWarnings()).toBe(2);

      s3Client.send.mockResolvedValueOnce({});
      await manager.releaseLock('test-stack', 'us-east-1');
    });

    it('warns once, not never, when renewals fail long enough to pass the deadline', async () => {
      // Fourteen consecutive failures at the default TTL are ~28 minutes of
      // output byte-identical to a healthy run, while the process keeps
      // deleting AWS resources past its own expiry.
      vi.useFakeTimers();
      const manager = await acquireWith('"etag-1"', { ttlMinutes: 4 });

      for (let i = 0; i < 6; i += 1) {
        s3Client.send.mockRejectedValueOnce(new Error('ThrottlingException'));
        await vi.advanceTimersByTimeAsync(60 * 1000);
      }

      const warned = logs.warn.mock.calls.map((c) => String(c[0]));
      expect(warned.filter((w) => w.includes('has been failing long enough'))).toHaveLength(1);

      s3Client.send.mockResolvedValueOnce({});
      await manager.releaseLock('test-stack', 'us-east-1');
    });

    it('stops renewing but KEEPS its ETag when a renewal returns none and cannot be re-read', async () => {
      vi.useFakeTimers();
      const manager = await acquireWith('"etag-1"');

      s3Client.send.mockResolvedValueOnce({}); // renewal: applied, no ETag
      s3Client.send.mockRejectedValueOnce(new Error('AccessDenied')); // re-read fails
      await vi.advanceTimersByTimeAsync(2 * 60 * 1000);

      // The heartbeat is gone -- asserted on the TIMER, since `renewLock`
      // also short-circuits and no S3 assertion can tell the two apart.
      expect(vi.getTimerCount()).toBe(0);

      // And the release stays CONDITIONAL. Clearing the ETag here would make
      // it unconditional, which is the owner-blind delete this change removes.
      s3Client.send.mockRejectedValueOnce(PRECONDITION_FAILED());
      await manager.releaseLock('test-stack', 'us-east-1');
      expect(deletes()[0]['IfMatch']).toBe('"etag-1"');
    });

    it('recovers the ETag by reading when a renewal returns none', async () => {
      vi.useFakeTimers();
      const manager = await acquireWith('"etag-1"');

      let renewalBody: LockInfo | undefined;
      s3Client.send.mockImplementationOnce((cmd: { input: { Body: string } }) => {
        renewalBody = JSON.parse(cmd.input.Body) as LockInfo;
        return Promise.resolve({});
      });
      s3Client.send.mockImplementationOnce(() =>
        Promise.resolve({
          ETag: '"etag-2"',
          Body: { transformToString: () => Promise.resolve(JSON.stringify(renewalBody)) },
        })
      );
      await vi.advanceTimersByTimeAsync(2 * 60 * 1000);

      // Renewal continues on the recovered handle.
      s3Client.send.mockResolvedValueOnce({ ETag: '"etag-3"' });
      await vi.advanceTimersByTimeAsync(2 * 60 * 1000);
      expect(puts()[2]['IfMatch']).toBe('"etag-2"');

      s3Client.send.mockResolvedValueOnce({});
      await manager.releaseLock('test-stack', 'us-east-1');
      expect(deletes()[0]['IfMatch']).toBe('"etag-3"');
    });

    it('replaces a previous heartbeat when the same key is acquired twice', async () => {
      vi.useFakeTimers();
      const manager = await acquireWith('"etag-1"');
      expect(vi.getTimerCount()).toBe(1);

      s3Client.send.mockResolvedValueOnce({ ETag: '"etag-2"' });
      await manager.acquireLock('test-stack', 'us-east-1');
      expect(vi.getTimerCount()).toBe(1);

      s3Client.send.mockResolvedValueOnce({});
      await manager.releaseLock('test-stack', 'us-east-1');
      expect(vi.getTimerCount()).toBe(0);
    });

    it('does not renew when S3 returned no ETag, rather than overwriting unconditionally', async () => {
      vi.useFakeTimers();
      const manager = await acquireWith(undefined);

      await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
      expect(puts()).toHaveLength(1);

      // Releasing then confirms ownership by BODY, because an absent ETag
      // would otherwise make the delete unconditional -- the owner-blind
      // delete this change removes, arriving by omission rather than decision.
      s3Client.send.mockResolvedValueOnce({
        ETag: '"whatever"',
        Body: { transformToString: () => Promise.resolve(puts()[0]['Body'] as string) },
      });
      s3Client.send.mockResolvedValueOnce({});
      await manager.releaseLock('test-stack', 'us-east-1');
      expect(deletes()).toHaveLength(1);
      expect(deletes()[0]['IfMatch']).toBeUndefined();
    });

    it('refuses to release without an ETag when the body is somebody else', async () => {
      vi.useFakeTimers();
      const manager = await acquireWith(undefined);

      s3Client.send.mockResolvedValueOnce({
        ETag: '"theirs"',
        Body: {
          transformToString: () =>
            Promise.resolve(
              JSON.stringify({ owner: 'someone-else', timestamp: 7, expiresAt: Date.now() + 60_000 })
            ),
        },
      });
      await manager.releaseLock('test-stack', 'us-east-1');

      expect(deletes()).toHaveLength(0);
      expect(logs.warn.mock.calls.map((c) => String(c[0])).join('\n')).toContain(
        'never learned which version of the lock it wrote'
      );
    });

    it('does not renew when the caller disabled renewal', async () => {
      vi.useFakeTimers();
      const manager = await acquireWith('"etag-1"', { disableRenewal: true });

      await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
      expect(puts()).toHaveLength(1);

      s3Client.send.mockResolvedValueOnce({});
      await manager.releaseLock('test-stack', 'us-east-1');
      // Still conditional: only the heartbeat is off, not the ownership check.
      expect(deletes()[0]['IfMatch']).toBe('"etag-1"');
    });

    it('unrefs the heartbeat so it cannot hold the process open', async () => {
      const unref = vi.fn();
      const spy = vi.spyOn(globalThis, 'setInterval').mockImplementation((() => ({
        unref,
      })) as unknown as typeof globalThis.setInterval);
      try {
        const manager = await acquireWith('"etag-1"');
        expect(unref).toHaveBeenCalledTimes(1);
        spy.mockRestore();
        s3Client.send.mockResolvedValueOnce({});
        await manager.releaseLock('test-stack', 'us-east-1');
      } finally {
        spy.mockRestore();
      }
    });

    it('schedules no heartbeat at all when there is no ETag to renew against', async () => {
      // What this pins is the guard in `trackHeldLock`. Asserting only "no PUT
      // was issued" leaves it unfenced: `renewLock` independently refuses an
      // undefined ETag, so the interval could fire forever as a no-op and
      // every S3 assertion would still pass.
      vi.useFakeTimers();
      const manager = await acquireWith(undefined);
      expect(vi.getTimerCount()).toBe(0);

      s3Client.send.mockResolvedValueOnce({});
      await manager.releaseLock('test-stack', 'us-east-1');
    });

    it('clears the heartbeat when the lock is lost, rather than leaving it spinning', async () => {
      // Same shape, and the same reason a timer assertion is required:
      // `renewLock` short-circuits on `lost`, so the `clearInterval` is
      // invisible to S3 while the interval keeps firing for the life of the
      // process.
      vi.useFakeTimers();
      const manager = await acquireWith('"etag-1"');
      expect(vi.getTimerCount()).toBe(1);

      s3Client.send.mockRejectedValueOnce(PRECONDITION_FAILED());
      await vi.advanceTimersByTimeAsync(2 * 60 * 1000);

      expect(vi.getTimerCount()).toBe(0);

      await manager.releaseLock('test-stack', 'us-east-1');
    });
  });

  describe('conditional release', () => {
    it('deletes conditionally on the ETag this process last wrote', async () => {
      const manager = await acquireWith('"etag-1"');
      s3Client.send.mockResolvedValueOnce({});
      await manager.releaseLock('test-stack', 'us-east-1');

      expect(deletes()).toHaveLength(1);
      expect(deletes()[0]['IfMatch']).toBe('"etag-1"');
      expect(deletes()[0]['Key']).toBe('stacks/test-stack/us-east-1/lock.json');
    });

    it('awaits an in-flight renewal so it releases with the RENEWED ETag', async () => {
      vi.useFakeTimers();
      const manager = await acquireWith('"etag-1"');

      // A renewal that is still in flight when release is called.
      let settleRenewal: (v: { ETag: string }) => void = () => {};
      s3Client.send.mockReturnValueOnce(
        new Promise<{ ETag: string }>((resolve) => {
          settleRenewal = resolve;
        })
      );
      await vi.advanceTimersByTimeAsync(2 * 60 * 1000);
      expect(puts()).toHaveLength(2);

      s3Client.send.mockResolvedValueOnce({});
      const releasing = manager.releaseLock('test-stack', 'us-east-1');
      // Nothing deleted yet: release is parked on the renewal.
      expect(deletes()).toHaveLength(0);

      settleRenewal({ ETag: '"etag-2"' });
      await releasing;

      // Without the await this would carry the stale "etag-1", S3 would
      // answer 412, and this process would refuse to release its OWN lock.
      expect(deletes()).toHaveLength(1);
      expect(deletes()[0]['IfMatch']).toBe('"etag-2"');
    });

    it('leaves a replaced lock alone on 412 instead of raising', async () => {
      const manager = await acquireWith('"etag-1"');
      s3Client.send.mockRejectedValueOnce(PRECONDITION_FAILED());

      await expect(manager.releaseLock('test-stack', 'us-east-1')).resolves.toBeUndefined();

      // The whole point: exactly ONE delete attempt, and no unconditional retry.
      expect(deletes()).toHaveLength(1);
      expect(logs.warn.mock.calls.map((c) => String(c[0])).join('\n')).toContain(
        'it has been replaced since this process acquired it'
      );
    });

    it('treats an already-absent lock as released', async () => {
      const manager = await acquireWith('"etag-1"');
      s3Client.send.mockRejectedValueOnce(NO_SUCH_KEY());

      await expect(manager.releaseLock('test-stack', 'us-east-1')).resolves.toBeUndefined();
      expect(deletes()).toHaveLength(1);
    });

    it('falls back to an unconditional delete only when the condition cannot be EVALUATED', async () => {
      await fallsBack(ACCESS_DENIED());
    });

    it('falls back on a 501 from an endpoint that does not implement the header', async () => {
      await fallsBack(s3err('NotImplemented', 501, 'server'));
    });

    it('does NOT drop the condition on a 409, which means a concurrent operation on the key', async () => {
      // S3 answers a conflicting concurrent operation with 409. That is the
      // CONTENDED case, so retrying without the condition would delete
      // whichever lock exists by then -- the hole this change closes.
      const manager = await acquireWith('"etag-1"');
      s3Client.send.mockRejectedValueOnce(CONFLICT());

      await expect(manager.releaseLock('test-stack', 'us-east-1')).rejects.toThrow(LockError);
      expect(deletes()).toHaveLength(1);
      expect(deletes()[0]['IfMatch']).toBe('"etag-1"');
    });

    it('does NOT drop the condition on a 503, where the delete may already have landed', async () => {
      const manager = await acquireWith('"etag-1"');
      s3Client.send.mockRejectedValueOnce(SLOW_DOWN());

      await expect(manager.releaseLock('test-stack', 'us-east-1')).rejects.toThrow(LockError);
      expect(deletes()).toHaveLength(1);
    });

    // --- isConditionUnsupportedError: one fixture per clause ---------------
    // A 403 named `AccessDenied` trips two clauses at once, so on its own it
    // fences neither. These five each trip exactly one.
    /** The lock body this process wrote, as the ownership re-read would see it. */
    const ownBodyRead = (): void => {
      const acquired = puts()[0]['Body'] as string;
      s3Client.send.mockResolvedValueOnce({
        ETag: '"etag-1"',
        Body: { transformToString: () => Promise.resolve(acquired) },
      });
    };

    const fallsBack = async (err: S3ServiceException): Promise<void> => {
      const manager = await acquireWith('"etag-1"');
      s3Client.send.mockRejectedValueOnce(err);
      // The condition could not be evaluated, so ownership is re-established
      // by hand before the condition is dropped.
      ownBodyRead();
      s3Client.send.mockResolvedValueOnce({});
      await expect(manager.releaseLock('test-stack', 'us-east-1')).resolves.toBeUndefined();
      expect(deletes()).toHaveLength(2);
      expect(deletes()[1]['IfMatch']).toBeUndefined();
    };

    it('drops the condition on a 403 whose name is not one of the three', async () => {
      await fallsBack(s3err('SignatureDoesNotMatch', 403));
    });

    it('drops the condition on a 501 whose name is not NotImplemented', async () => {
      await fallsBack(s3err('S3ServiceException', 501, 'server'));
    });

    it('drops the condition on an AccessDenied that does not carry 403', async () => {
      await fallsBack(s3err('AccessDenied', 400));
    });

    it('drops the condition on a Forbidden that does not carry 403', async () => {
      await fallsBack(s3err('Forbidden', 400));
    });

    it('drops the condition on a NotImplemented that does not carry 501', async () => {
      await fallsBack(s3err('NotImplemented', 400));
    });

    it('refuses the fallback when the lock present belongs to someone else', async () => {
      // S3 authorizes BEFORE evaluating a precondition, so a policy that scopes
      // s3:GetObject away from lock.json turns a genuine 412 into a 403 -- and
      // an unconditional retry then deletes whoever took over.
      const manager = await acquireWith('"etag-1"');
      s3Client.send.mockRejectedValueOnce(ACCESS_DENIED());
      s3Client.send.mockResolvedValueOnce({
        ETag: '"theirs"',
        Body: {
          transformToString: () =>
            Promise.resolve(
              JSON.stringify({ owner: 'someone-else', timestamp: 1, expiresAt: Date.now() + 60_000 })
            ),
        },
      });

      await expect(manager.releaseLock('test-stack', 'us-east-1')).resolves.toBeUndefined();
      expect(deletes()).toHaveLength(1);
      expect(logs.warn.mock.calls.map((c) => String(c[0])).join('\n')).toContain(
        'could not confirm the lock is still its own'
      );
    });

    it('refuses the fallback when the ownership read itself fails', async () => {
      // This is the guard's PRIMARY case, not an edge: the documented trigger
      // for the 403 is a policy granting s3:DeleteObject without the
      // s3:GetObject a conditional delete needs -- under which this read fails
      // too. Answering "proceed" here, as an earlier cut did, left the guard
      // inert in exactly the situation it was added for.
      const manager = await acquireWith('"etag-1"');
      s3Client.send.mockRejectedValueOnce(ACCESS_DENIED());
      s3Client.send.mockRejectedValueOnce(ACCESS_DENIED());

      await expect(manager.releaseLock('test-stack', 'us-east-1')).resolves.toBeUndefined();
      expect(deletes()).toHaveLength(1);
      expect(logs.warn.mock.calls.map((c) => String(c[0])).join('\n')).toContain(
        'grant s3:GetObject on the lock key'
      );
    });

    it('refuses when the ownership read reports no lock, because that is not "nothing is there"', async () => {
      // `getLockRecord` answers null for a body that parses to 42 / [] / null
      // too. Such an object EXISTS -- it still fails every IfNoneMatch acquire
      // -- and is not ours, so an unconditional delete would remove a foreign
      // lock. For a genuine absence there is nothing to release either way.
      const manager = await acquireWith('"etag-1"');
      s3Client.send.mockRejectedValueOnce(ACCESS_DENIED());
      s3Client.send.mockRejectedValueOnce(NO_SUCH_KEY());

      await expect(manager.releaseLock('test-stack', 'us-east-1')).resolves.toBeUndefined();
      expect(deletes()).toHaveLength(1);
    });

    it('refuses when the ownership read returns an unparseable lock body', async () => {
      const manager = await acquireWith('"etag-1"');
      s3Client.send.mockRejectedValueOnce(ACCESS_DENIED());
      s3Client.send.mockResolvedValueOnce({
        ETag: '"junk"',
        Body: { transformToString: () => Promise.resolve('42') },
      });

      await expect(manager.releaseLock('test-stack', 'us-east-1')).resolves.toBeUndefined();
      expect(deletes()).toHaveLength(1);
    });

    it('re-reads even while its own deadline is still ahead, because force-unlock ignores expiry', async () => {
      // An earlier cut skipped the read here, reasoning that nobody could have
      // taken over yet. `cdkd force-unlock` deletes regardless of expiry, so a
      // user running it mid-operation is a LEGITIMATE takeover the shortcut
      // could not see -- and cross-machine clock skew reaches the same state
      // with nobody running anything.
      const manager = await acquireWith('"etag-1"');
      s3Client.send.mockRejectedValueOnce(ACCESS_DENIED());
      s3Client.send.mockResolvedValueOnce({
        ETag: '"theirs"',
        Body: {
          transformToString: () =>
            Promise.resolve(
              JSON.stringify({ owner: 'force-unlocked-then-taken', timestamp: 2, expiresAt: Date.now() + 60_000 })
            ),
        },
      });

      await expect(manager.releaseLock('test-stack', 'us-east-1')).resolves.toBeUndefined();
      expect(commands().filter((c) => c.name === 'GetObjectCommand')).toHaveLength(1);
      expect(deletes()).toHaveLength(1);
    });

    it('does not blame another process for a conflict with its own write', async () => {
      // The keep-stale-ETag path: the 412 is against an object THIS process
      // wrote, so the old wording accused a writer that does not exist.
      vi.useFakeTimers();
      const manager = await acquireWith('"etag-1"');
      s3Client.send.mockResolvedValueOnce({});
      s3Client.send.mockRejectedValueOnce(new Error('AccessDenied'));
      await vi.advanceTimersByTimeAsync(2 * 60 * 1000);

      const renewalDeadline = JSON.parse(puts()[1]['Body'] as string) as LockInfo;

      s3Client.send.mockRejectedValueOnce(PRECONDITION_FAILED());
      await manager.releaseLock('test-stack', 'us-east-1');

      const warned = logs.warn.mock.calls.map((c) => String(c[0])).join('\n');
      expect(warned).toContain('could not confirm which version of the lock it last wrote');
      expect(warned).not.toContain('another cdkd process now holds it');
      // The PUT LANDED, so the stored deadline is the renewal's. Naming the
      // pre-renewal one told the user to wait out a time already past, and
      // they came back to a lock still there.
      expect(warned).toContain(new Date(renewalDeadline.expiresAt).toISOString());
    });

    it('reads a 412 that carries no 412 status as a foreign lock', async () => {
      const manager = await acquireWith('"etag-1"');
      s3Client.send.mockRejectedValueOnce(s3err('PreconditionFailed', 400));

      await expect(manager.releaseLock('test-stack', 'us-east-1')).resolves.toBeUndefined();
      expect(deletes()).toHaveLength(1);
    });

    it('reads a NoSuchKey CLASS carrying a non-404 status as gone', async () => {
      const manager = await acquireWith('"etag-1"');
      s3Client.send.mockRejectedValueOnce(
        new NoSuchKey({ message: 'gone', $metadata: { httpStatusCode: 400 } })
      );

      await expect(manager.releaseLock('test-stack', 'us-east-1')).resolves.toBeUndefined();
      expect(deletes()).toHaveLength(1);
    });

    it('reads a NoSuchKey NAME carrying a non-404 status as gone', async () => {
      const manager = await acquireWith('"etag-1"');
      s3Client.send.mockRejectedValueOnce(s3err('NoSuchKey', 400));

      await expect(manager.releaseLock('test-stack', 'us-east-1')).resolves.toBeUndefined();
      expect(deletes()).toHaveLength(1);
    });

    it('raises rather than falling back when this process never acquired the lock', async () => {
      const manager = new LockManager(s3Client as unknown as S3Client, config);
      s3Client.send.mockRejectedValueOnce(ACCESS_DENIED());

      await expect(manager.releaseLock('other-stack', 'us-east-1')).rejects.toThrow(LockError);
      expect(deletes()).toHaveLength(1);
    });

    it('releases again after a re-acquire, rather than staying tombstoned', async () => {
      const manager = await acquireWith('"etag-1"');
      s3Client.send.mockResolvedValueOnce({});
      await manager.releaseLock('test-stack', 'us-east-1');

      s3Client.send.mockResolvedValueOnce({ ETag: '"etag-2"' });
      expect(await manager.acquireLock('test-stack', 'us-east-1')).toBe(true);
      s3Client.send.mockResolvedValueOnce({});
      await manager.releaseLock('test-stack', 'us-east-1');

      expect(deletes()).toHaveLength(2);
      expect(deletes()[1]['IfMatch']).toBe('"etag-2"');
    });

    it('reports the first release\'s failure to a concurrent second caller', async () => {
      // Both the force-quit path and the main `finally` can be in here at
      // once. A boolean tombstone set before the delete would tell the second
      // caller the lock was released when nothing was deleted.
      const manager = await acquireWith('"etag-1"');
      s3Client.send.mockRejectedValueOnce(SLOW_DOWN());

      const a = manager.releaseLock('test-stack', 'us-east-1');
      const b = manager.releaseLock('test-stack', 'us-east-1');
      await expect(a).rejects.toThrow(LockError);
      await expect(b).rejects.toThrow(LockError);
      expect(deletes()).toHaveLength(1);
    });

    it('raises a LockError when the unconditional fallback also fails', async () => {
      const manager = await acquireWith('"etag-1"');
      s3Client.send.mockRejectedValueOnce(ACCESS_DENIED());
      ownBodyRead();
      s3Client.send.mockRejectedValueOnce(new Error('still denied'));

      await expect(manager.releaseLock('test-stack', 'us-east-1')).rejects.toThrow(LockError);
      expect(deletes()).toHaveLength(2);
    });

    it('treats a bare 412 with no PreconditionFailed name as a foreign lock', async () => {
      const manager = await acquireWith('"etag-1"');
      s3Client.send.mockRejectedValueOnce(
        new S3ServiceException({
          name: 'S3ServiceException',
          $fault: 'client',
          $metadata: { httpStatusCode: 412 },
        } as never)
      );

      await expect(manager.releaseLock('test-stack', 'us-east-1')).resolves.toBeUndefined();
      expect(deletes()).toHaveLength(1);
    });

    it('treats a 404 carrying no NoSuchKey name as already gone', async () => {
      const manager = await acquireWith('"etag-1"');
      s3Client.send.mockRejectedValueOnce(NOT_FOUND());

      await expect(manager.releaseLock('test-stack', 'us-east-1')).resolves.toBeUndefined();
      expect(deletes()).toHaveLength(1);
    });

    it('does NOT read NoSuchBucket as a missing lock', async () => {
      // It is a 404 that says nothing about the lock. Read as "gone" it would
      // resolve where this used to raise.
      const manager = await acquireWith('"etag-1"');
      s3Client.send.mockRejectedValueOnce(NO_SUCH_BUCKET());

      await expect(manager.releaseLock('test-stack', 'us-east-1')).rejects.toThrow(LockError);
    });

    it('rejects rather than throwing SYNCHRONOUSLY when its own logging blows up', async () => {
      // `releaseLock` claims the in-flight promise before any `await`, so it
      // is tempting to drop `async`. That would let a throw out on the
      // CALLER'S stack -- and ten call sites attach only a `.catch()`, two of
      // them `void releaseLock(...).catch(...)` inside a SIGINT force-quit
      // handler, where a synchronous throw is an uncaughtException that kills
      // the handler before its recovery banner prints. stdout is a measured
      // synchronous EPIPE source in this repo under `--verbose | head`.
      const manager = await acquireWith('"etag-1"');
      s3Client.send.mockResolvedValueOnce({});
      await manager.releaseLock('test-stack', 'us-east-1');

      logs.debug.mockImplementationOnce(() => {
        throw new Error('EPIPE: broken pipe');
      });

      let sync: unknown;
      let promise: Promise<void> | undefined;
      try {
        promise = manager.releaseLock('test-stack', 'us-east-1');
      } catch (err) {
        sync = err;
      }
      expect(sync).toBeUndefined();
      await expect(promise).rejects.toThrow(/EPIPE/);
    });

    it('ignores a second release instead of deleting whatever lock is there now', async () => {
      // Reachable: destroy-runner's force-quit paths fire an un-awaited
      // `void releaseLock(...)` while the main `finally` may be mid-release.
      const manager = await acquireWith('"etag-1"');
      s3Client.send.mockResolvedValueOnce({});
      await manager.releaseLock('test-stack', 'us-east-1');
      await manager.releaseLock('test-stack', 'us-east-1');

      expect(deletes()).toHaveLength(1);
    });

    it('issues no delete at all once the lock is known lost', async () => {
      vi.useFakeTimers();
      const manager = await acquireWith('"etag-1"');
      s3Client.send.mockRejectedValueOnce(PRECONDITION_FAILED());
      await vi.advanceTimersByTimeAsync(2 * 60 * 1000);

      await manager.releaseLock('test-stack', 'us-east-1');

      expect(deletes()).toHaveLength(0);
      expect(logs.warn.mock.calls.map((c) => String(c[0])).join('\n')).toContain(
        'this process lost it while the operation was still running'
      );
    });

    it('deletes unconditionally when this process never acquired the lock', async () => {
      const manager = new LockManager(s3Client as unknown as S3Client, config);
      s3Client.send.mockResolvedValueOnce({});

      await manager.releaseLock('other-stack', 'us-east-1');

      expect(deletes()).toHaveLength(1);
      expect(deletes()[0]['IfMatch']).toBeUndefined();
    });

    it('stops the heartbeat, so a released lock is never re-created', async () => {
      vi.useFakeTimers();
      const manager = await acquireWith('"etag-1"');

      s3Client.send.mockResolvedValueOnce({});
      await manager.releaseLock('test-stack', 'us-east-1');

      await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
      expect(puts()).toHaveLength(1);
    });
  });

  describe('expired-lock takeover', () => {
    const expiredBody = (): string =>
      JSON.stringify({
        owner: 'owner-b',
        timestamp: Date.now() - 60 * 60 * 1000,
        expiresAt: Date.now() - 30 * 60 * 1000,
        operation: 'deploy',
      });

    /** Prime the acquire -> 412 -> read-expired sequence. */
    function primeExpiredRead(etag: string | undefined): void {
      s3Client.send.mockRejectedValueOnce(PRECONDITION_FAILED());
      s3Client.send.mockResolvedValueOnce({
        ETag: etag,
        Body: { transformToString: () => Promise.resolve(expiredBody()) },
      });
    }

    it('removes the expired lock conditionally on the bytes it judged expired', async () => {
      const manager = new LockManager(s3Client as unknown as S3Client, config);
      primeExpiredRead('"stale-etag"');
      s3Client.send.mockResolvedValueOnce({}); // conditional delete
      s3Client.send.mockResolvedValueOnce({ ETag: '"mine"' }); // retry PUT

      const ok = await manager.acquireLock('test-stack', 'us-east-1');

      expect(ok).toBe(true);
      expect(deletes()).toHaveLength(1);
      // An unconditional delete here would discard a lock the owner renewed
      // between our read and our delete.
      expect(deletes()[0]['IfMatch']).toBe('"stale-etag"');

      s3Client.send.mockResolvedValueOnce({});
      await manager.releaseLock('test-stack', 'us-east-1');
    });

    it('reports contention when the expired lock changed before the takeover delete', async () => {
      const manager = new LockManager(s3Client as unknown as S3Client, config);
      primeExpiredRead('"stale-etag"');
      s3Client.send.mockRejectedValueOnce(PRECONDITION_FAILED());

      const ok = await manager.acquireLock('test-stack', 'us-east-1');

      expect(ok).toBe(false);
      // Crucially it does NOT go on to re-PUT: only the original attempt ran.
      expect(puts()).toHaveLength(1);
    });

    it('renews and releases CONDITIONALLY after taking over an expired lock', async () => {
      // The takeover path has its own acquire, so it has its own chance to
      // forget to track the lock -- and a lock that is not tracked is neither
      // renewed nor conditionally released, i.e. the pre-fix cascade,
      // reintroduced on the path this change adds.
      vi.useFakeTimers();
      const manager = new LockManager(s3Client as unknown as S3Client, config);
      primeExpiredRead('"stale-etag"');
      s3Client.send.mockResolvedValueOnce({});
      s3Client.send.mockResolvedValueOnce({ ETag: '"mine"' });
      expect(await manager.acquireLock('test-stack', 'us-east-1')).toBe(true);

      s3Client.send.mockResolvedValueOnce({ ETag: '"mine-2"' });
      await vi.advanceTimersByTimeAsync(2 * 60 * 1000);
      const renewal = puts()[puts().length - 1];
      expect(renewal['IfMatch']).toBe('"mine"');

      s3Client.send.mockResolvedValueOnce({});
      await manager.releaseLock('test-stack', 'us-east-1');
      expect(deletes()[deletes().length - 1]['IfMatch']).toBe('"mine-2"');
    });

    it('reads a bare 412 on the ACQUIRE put as contention, not as a hard failure', async () => {
      // The acquire path tested `error.name === 'PreconditionFailed'` raw
      // until the status backstop was applied here too; a 412 arriving as a
      // bare S3ServiceException made acquire THROW instead of reporting a
      // held lock.
      const manager = new LockManager(s3Client as unknown as S3Client, config);
      s3Client.send.mockRejectedValueOnce(s3err('S3ServiceException', 412));
      s3Client.send.mockResolvedValueOnce({
        ETag: '"live"',
        Body: {
          transformToString: () =>
            Promise.resolve(
              JSON.stringify({ owner: 'someone', timestamp: 1, expiresAt: Date.now() + 600_000 })
            ),
        },
      });

      expect(await manager.acquireLock('test-stack', 'us-east-1')).toBe(false);
    });

    it('reads a bare 412 on the RETRY put as contention, not as a hard failure', async () => {
      const manager = new LockManager(s3Client as unknown as S3Client, config);
      primeExpiredRead('"stale-etag"');
      s3Client.send.mockResolvedValueOnce({}); // takeover delete
      s3Client.send.mockRejectedValueOnce(s3err('S3ServiceException', 412)); // retry PUT

      expect(await manager.acquireLock('test-stack', 'us-east-1')).toBe(false);
    });

    it('treats a 404 on the takeover delete as contention rather than raising', async () => {
      const manager = new LockManager(s3Client as unknown as S3Client, config);
      primeExpiredRead('"stale-etag"');
      s3Client.send.mockRejectedValueOnce(NOT_FOUND());

      expect(await manager.acquireLock('test-stack', 'us-east-1')).toBe(false);
      expect(puts()).toHaveLength(1);
    });

    it('refuses the takeover when the expired lock has no identifiable version', async () => {
      // Without an ETag the delete would be UNCONDITIONAL -- silently, and
      // with none of the reasoning the sibling refusal applies.
      const manager = new LockManager(s3Client as unknown as S3Client, config);
      primeExpiredRead(undefined);

      expect(await manager.acquireLock('test-stack', 'us-east-1')).toBe(false);
      expect(deletes()).toHaveLength(0);
      expect(puts()).toHaveLength(1);
    });

    it('announces the takeover only AFTER it succeeded, not before a refusal', async () => {
      const manager = new LockManager(s3Client as unknown as S3Client, config);
      primeExpiredRead('"stale-etag"');
      s3Client.send.mockRejectedValueOnce(ACCESS_DENIED());

      expect(await manager.acquireLock('test-stack', 'us-east-1')).toBe(false);
      const warned = logs.warn.mock.calls.map((c) => String(c[0])).join('\n');
      expect(warned).not.toContain('Took over an EXPIRED lock');
      expect(warned).toContain('Cannot take over');
    });

    it('refuses the takeover rather than deleting unconditionally when the condition cannot be evaluated', async () => {
      // `releaseLock` has an escape hatch for this error class; the takeover
      // deliberately does NOT. The IfMatch is what makes concurrent reaping
      // safe -- first wins, second gets 412 and reports contention. Drop it
      // and BOTH reapers delete-then-acquire, leaving two holders.
      const manager = new LockManager(s3Client as unknown as S3Client, config);
      primeExpiredRead('"stale-etag"');
      s3Client.send.mockRejectedValueOnce(ACCESS_DENIED());

      expect(await manager.acquireLock('test-stack', 'us-east-1')).toBe(false);
      // One conditional delete attempt, and no second unconditional one.
      expect(deletes()).toHaveLength(1);
      expect(deletes()[0]['IfMatch']).toBe('"stale-etag"');
      // And critically no re-acquire: a PUT here would be the second holder.
      expect(puts()).toHaveLength(1);
      expect(logs.warn.mock.calls.map((c) => String(c[0])).join('\n')).toContain(
        'could delete a lock another process has since taken'
      );
    });

    it('propagates a takeover delete that failed for an unrelated reason', async () => {
      const manager = new LockManager(s3Client as unknown as S3Client, config);
      primeExpiredRead('"stale-etag"');
      s3Client.send.mockRejectedValueOnce(new Error('ThrottlingException'));

      await expect(manager.acquireLock('test-stack', 'us-east-1')).rejects.toThrow();
    });

    it('warns rather than merely informs, now that a live holder renews', async () => {
      const manager = new LockManager(s3Client as unknown as S3Client, config);
      primeExpiredRead('"stale-etag"');
      s3Client.send.mockResolvedValueOnce({});
      s3Client.send.mockResolvedValueOnce({ ETag: '"mine"' });

      await manager.acquireLock('test-stack', 'us-east-1');

      const warned = logs.warn.mock.calls.map((c) => String(c[0])).join('\n');
      expect(warned).toContain('Took over an EXPIRED lock');
      expect(warned).toContain('owner-b');

      s3Client.send.mockResolvedValueOnce({});
      await manager.releaseLock('test-stack', 'us-east-1');
    });
  });

  describe('input validation', () => {
    it('refuses a non-positive TTL instead of spinning at the interval floor', () => {
      expect(() => new LockManager(s3Client as unknown as S3Client, config, { ttlMinutes: 0 })).toThrow(
        LockError
      );
      expect(() => new LockManager(s3Client as unknown as S3Client, config, { ttlMinutes: -5 })).toThrow(
        LockError
      );
      expect(
        () => new LockManager(s3Client as unknown as S3Client, config, { ttlMinutes: Number.NaN })
      ).toThrow(LockError);
      // `> 0` accepts Infinity, so this one needs the finiteness clause.
      expect(
        () =>
          new LockManager(s3Client as unknown as S3Client, config, {
            ttlMinutes: Number.POSITIVE_INFINITY,
          })
      ).toThrow(LockError);
    });

    it('treats a non-finite expiresAt as EXPIRED so a hostile lock cannot pin the stack', async () => {
      // `expiresAt` reaches the code through an unvalidated cast, so anyone
      // who can write the state bucket picks it. `Infinity` would make
      // `Date.now() >= x` false forever: no acquire ever succeeds again.
      const manager = new LockManager(s3Client as unknown as S3Client, config);
      s3Client.send.mockRejectedValueOnce(PRECONDITION_FAILED());
      s3Client.send.mockResolvedValueOnce({
        ETag: '"hostile"',
        Body: {
          transformToString: () =>
            Promise.resolve(
              JSON.stringify({ owner: 'squatter', timestamp: 0, expiresAt: 'never' })
            ),
        },
      });
      s3Client.send.mockResolvedValueOnce({});
      s3Client.send.mockResolvedValueOnce({ ETag: '"mine"' });

      expect(await manager.acquireLock('test-stack', 'us-east-1')).toBe(true);

      s3Client.send.mockResolvedValueOnce({});
      await manager.releaseLock('test-stack', 'us-east-1');
    });
  });

  describe('forceReleaseLock', () => {
    it('stays unconditional, because it exists to remove someone else lock', async () => {
      const manager = new LockManager(s3Client as unknown as S3Client, config);
      s3Client.send.mockResolvedValueOnce({
        ETag: '"theirs"',
        Body: { transformToString: () => Promise.resolve(expiredForeign()) },
      });
      s3Client.send.mockResolvedValueOnce({});

      await manager.forceReleaseLock('test-stack', 'us-east-1');

      expect(deletes()).toHaveLength(1);
      expect(deletes()[0]['IfMatch']).toBeUndefined();
    });

    it('stops this process heartbeat, so the lock is not re-created after the force-unlock', async () => {
      vi.useFakeTimers();
      const manager = await acquireWith('"etag-1"');

      s3Client.send.mockResolvedValueOnce({
        ETag: '"etag-1"',
        Body: { transformToString: () => Promise.resolve(expiredForeign()) },
      });
      s3Client.send.mockResolvedValueOnce({});
      await manager.forceReleaseLock('test-stack', 'us-east-1');
      // A later ordinary release must not delete whatever lock has appeared
      // since the user force-unlocked.
      await manager.releaseLock('test-stack', 'us-east-1');

      // Unconditional EVEN THOUGH this process holds the lock and knows its
      // ETag: `force-unlock` exists to remove a lock regardless of owner, so
      // conditioning it here would make a lock unremovable in exactly the
      // situation the command is for.
      expect(deletes()).toHaveLength(1);
      expect(deletes()[0]['IfMatch']).toBeUndefined();

      await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
      expect(puts()).toHaveLength(1);
    });

    function expiredForeign(): string {
      return JSON.stringify({
        owner: 'owner-b',
        timestamp: Date.now() - 60 * 60 * 1000,
        expiresAt: Date.now() - 30 * 60 * 1000,
      });
    }
  });
});
