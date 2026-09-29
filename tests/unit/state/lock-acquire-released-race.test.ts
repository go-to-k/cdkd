/**
 * Issue #4055: `acquireLockWithRetry` against a lock its holder releases
 * DURING an attempt.
 *
 * Pre-fix, a failed acquire followed by an empty read simply fell through: on
 * the final attempt the loop ended, a second read also found nothing, and the
 * command failed with "Lock exists but could not read lock info" -- telling the
 * user to force-unlock a lock that was gone, when one more acquire would have
 * succeeded.
 *
 * Driven through a scripted S3 client rather than stubbed `acquireLock` /
 * `getLockInfo`, because the race lives in the ORDER of the PUT and the two
 * GETs each attempt makes, and a stub would script the answer it is testing.
 */
import { describe, it, expect, beforeEach, vi } from 'vite-plus/test';
import { S3Client, S3ServiceException, NoSuchKey } from '@aws-sdk/client-s3';
import { LockManager, RELEASED_LOCK_REACQUIRE_LIMIT } from '../../../src/state/lock-manager.js';
import { LockError } from '../../../src/utils/error-handler.js';
import type { StateBackendConfig } from '../../../src/types/config.js';

const { logs, ownerParamMock } = vi.hoisted(() => ({
  logs: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  ownerParamMock: vi.fn(),
}));

vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({ child: () => logs, ...logs }),
}));

vi.mock('../../../src/utils/expected-bucket-owner.js', () => ({
  expectedOwnerParam: ownerParamMock,
}));

vi.mock('../../../src/utils/aws-region-resolver.js', async () => {
  const actual = await vi.importActual<typeof import('../../../src/utils/aws-region-resolver.js')>(
    '../../../src/utils/aws-region-resolver.js'
  );
  return { ...actual, resolveBucketRegion: vi.fn() };
});

type Reply = () => unknown;

/**
 * Past this many PUTs the double throws. An unbounded re-attempt loop awaits
 * only microtasks, so vitest's own timeout could never fire -- this is what
 * turns "loops forever" into a red case.
 */
const RUNAWAY_PUTS = 50;

/**
 * Per-command reply queues. An unqueued PUT succeeds (the acquire lands), an
 * unqueued GET finds no lock, and an unqueued listing is empty.
 */
function makeClient(): {
  client: S3Client;
  queue: (command: 'PutObjectCommand' | 'GetObjectCommand', ...replies: Reply[]) => void;
  calls: (command: string) => number;
} {
  const queues = new Map<string, Reply[]>();
  const counts = new Map<string, number>();
  const send = vi.fn(async (command: { constructor: { name: string } }) => {
    const name = command.constructor.name;
    counts.set(name, (counts.get(name) ?? 0) + 1);
    if (name === 'PutObjectCommand' && (counts.get(name) ?? 0) > RUNAWAY_PUTS) {
      throw new Error('runaway: acquireLockWithRetry never stopped re-attempting');
    }
    const next = queues.get(name)?.shift();
    if (next) return next();
    switch (name) {
      case 'PutObjectCommand':
        return { ETag: '"ours"' };
      case 'GetObjectCommand':
        throw new NoSuchKey({ message: 'gone', $metadata: { httpStatusCode: 404 } });
      case 'ListObjectVersionsCommand':
        return { IsTruncated: false };
      default:
        return {};
    }
  });
  return {
    client: {
      send,
      config: {
        region: () => Promise.resolve('us-east-1'),
        credentials: () => Promise.resolve({ accessKeyId: 'AKIAFAKE', secretAccessKey: 'x' }),
      },
    } as unknown as S3Client,
    queue: (command, ...replies) => {
      queues.set(command, [...(queues.get(command) ?? []), ...replies]);
    },
    calls: (command) => counts.get(command) ?? 0,
  };
}

const held: Reply = () => {
  throw new S3ServiceException({
    name: 'PreconditionFailed',
    message: 'At least one of the pre-conditions you specified did not hold',
    $fault: 'client',
    $metadata: { httpStatusCode: 412 },
  } as never);
};
const gone: Reply = () => {
  throw new NoSuchKey({ message: 'gone', $metadata: { httpStatusCode: 404 } });
};
const lockOf =
  (owner: string): Reply =>
  () => ({
    Body: {
      transformToString: () =>
        Promise.resolve(JSON.stringify({ owner, timestamp: Date.now(), expiresAt: Date.now() + 600_000, operation: 'deploy' })),
    },
    ETag: `"${owner}"`,
  });
/** A lock.json whose body parses to a non-object: `getLockInfo` reads it as absent, yet the PUT still fails. */
const unreadable: Reply = () => ({
  Body: { transformToString: () => Promise.resolve('42') },
  ETag: '"unreadable"',
});

const CONFIG: StateBackendConfig = { bucket: 'b', prefix: 'cdkd' };
const manager = (c: ReturnType<typeof makeClient>): LockManager =>
  new LockManager(c.client, CONFIG, { disableRenewal: true });

async function thrown(p: Promise<unknown>): Promise<LockError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(LockError);
    return e as LockError;
  }
  throw new Error('expected acquireLockWithRetry to throw');
}

const infoLines = (): string[] => logs.info.mock.calls.map((c) => String(c[0]));

beforeEach(async () => {
  vi.clearAllMocks();
  ownerParamMock.mockResolvedValue({});
  const { resolveBucketRegion } = await import('../../../src/utils/aws-region-resolver.js');
  vi.mocked(resolveBucketRegion).mockResolvedValue('us-east-1');
});

describe('acquireLockWithRetry: a lock released during an attempt (issue #4055)', () => {
  it('acquires when the holder releases during the FINAL attempt, after acquireLock read it', async () => {
    // Attempt 1: held. Attempt 2 (final): the PUT fails and acquireLock still
    // reads the holder, then the holder releases before the retry's own read.
    const c = makeClient();
    c.queue('PutObjectCommand', held, held);
    c.queue('GetObjectCommand', lockOf('alice'), lockOf('alice'), lockOf('alice'), gone);

    await expect(manager(c).acquireLockWithRetry('MyStack', 'us-east-1', 'me', 'deploy', 1, 0)).resolves.toBeUndefined();

    // Two failed PUTs, then the re-attempt that lands.
    expect(c.calls('PutObjectCommand')).toBe(3);
  });

  it('acquires when the release lands between the failed PUT and acquireLock own read', async () => {
    // The other interleaving: both reads of the final attempt find nothing.
    const c = makeClient();
    c.queue('PutObjectCommand', held, held);
    c.queue('GetObjectCommand', lockOf('alice'), lockOf('alice'), gone, gone);

    await expect(manager(c).acquireLockWithRetry('MyStack', 'us-east-1', 'me', 'deploy', 1, 0)).resolves.toBeUndefined();
    expect(c.calls('PutObjectCommand')).toBe(3);
  });

  it('re-attempts at once on an EARLIER attempt, without waiting out the retry delay', async () => {
    // A 10-minute delay: a re-attempt that slept would time the case out.
    const c = makeClient();
    c.queue('PutObjectCommand', held);
    c.queue('GetObjectCommand', gone, gone);

    await expect(manager(c).acquireLockWithRetry('MyStack', 'us-east-1', 'me', 'deploy', 3, 600_000)).resolves.toBeUndefined();
    expect(c.calls('PutObjectCommand')).toBe(2);
    // Nothing announced a wait that did not happen.
    expect(infoLines()).toEqual([]);
  });

  it('reports the THIRD owner when the lock is released and re-taken before the re-attempt', async () => {
    const c = makeClient();
    // Attempt 1 held by alice; attempt 2 fails, alice releases, the re-attempt
    // loses to carol, who then holds it.
    c.queue('PutObjectCommand', held, held, held);
    c.queue('GetObjectCommand', lockOf('alice'), lockOf('alice'), lockOf('alice'), gone, lockOf('carol'), lockOf('carol'));

    const error = await thrown(manager(c).acquireLockWithRetry('MyStack', 'us-east-1', 'me', 'deploy', 1, 0));

    expect(error.message).toContain('Locked by: carol, operation: deploy');
    expect(error.message).not.toContain('alice');
    expect(error.message).not.toContain('released');
    // Three acquires were made, and the count says so rather than maxRetries + 1.
    expect(error.message).toContain('after 3 attempts.');
    // The refusal renders the read taken after the last failed acquire; it
    // does not read again (an unqueued GET here would answer "no lock").
    expect(c.calls('GetObjectCommand')).toBe(6);
  });

  it('leaves the always-locked path unchanged: every retry waits, then names the holder', async () => {
    const c = makeClient();
    c.queue('PutObjectCommand', held, held, held, held);
    c.queue('GetObjectCommand', ...Array.from({ length: 8 }, () => lockOf('alice')));

    const error = await thrown(manager(c).acquireLockWithRetry('MyStack', 'us-east-1', 'me', 'deploy', 3, 0));

    expect(c.calls('PutObjectCommand')).toBe(4);
    expect(c.calls('GetObjectCommand')).toBe(8);
    expect(error.message).toContain('Failed to acquire lock for stack MyStack (us-east-1) after 4 attempts. Locked by: alice');
    const retries = infoLines();
    expect(retries).toHaveLength(3);
    expect(retries[2]).toContain('Stack MyStack (us-east-1) is locked by alice (operation: deploy).');
    expect(retries[2]).toContain('(attempt 3/3)');
  });

  it(`stops re-attempting after ${RELEASED_LOCK_REACQUIRE_LIMIT} empty reads: an unreadable lock.json cannot loop forever`, async () => {
    // A body of `42` reads as "no lock" every time, yet every PUT fails.
    const c = makeClient();
    c.queue('PutObjectCommand', ...Array.from({ length: RUNAWAY_PUTS }, () => held));
    c.queue('GetObjectCommand', ...Array.from({ length: 2 * RUNAWAY_PUTS }, () => unreadable));

    const error = await thrown(manager(c).acquireLockWithRetry('MyStack', 'us-east-1', 'me', 'deploy', 1, 0));

    // The two budgeted attempts plus the bounded re-attempts, and no more.
    expect(c.calls('PutObjectCommand')).toBe(2 + RELEASED_LOCK_REACQUIRE_LIMIT);
    expect(error.message).toContain(`after ${2 + RELEASED_LOCK_REACQUIRE_LIMIT} attempts.`);
    expect(error.message).toContain('No lock could be read after the last failed attempt');
  });

  it('waits the retry delay on an empty read once the re-attempts are spent, and says why', async () => {
    const c = makeClient();
    c.queue('PutObjectCommand', ...Array.from({ length: RUNAWAY_PUTS }, () => held));
    c.queue('GetObjectCommand', ...Array.from({ length: 2 * RUNAWAY_PUTS }, () => unreadable));

    await thrown(manager(c).acquireLockWithRetry('MyStack', 'us-east-1', 'me', 'deploy', 1, 0));

    // Pre-fix an empty read skipped the delay and logged nothing; a line that
    // rendered `lockInfo.owner` here would throw on the null.
    expect(infoLines()).toEqual([
      'Stack MyStack (us-east-1) could not be locked, and no readable lock was found. Retrying in 0s... (attempt 1/1)',
    ]);
  });
});

describe('acquireLockWithRetry: the refusal names what the last read found (issue #4055)', () => {
  const exhaustedWithNoLock = async (stackName: string): Promise<string> => {
    const c = makeClient();
    c.queue('PutObjectCommand', ...Array.from({ length: RUNAWAY_PUTS }, () => held));
    return (await thrown(manager(c).acquireLockWithRetry(stackName, 'us-east-1', 'me', 'deploy', 0, 0))).message;
  };

  it('does not claim a lock exists when the last read found none', async () => {
    const message = await exhaustedWithNoLock('MyStack');
    // The feared shape, spelled exactly as the regression emitted it.
    expect(message).not.toContain('Lock exists');
    expect(message).not.toContain('Locked by');
    expect(message).toContain('most likely released just now: re-run the command.');
    expect(message).toContain('If this repeats, lock.json may hold a body that is not a readable lock.');
  });

  it('still ends with the region-qualified force-unlock command, emitted last', async () => {
    const message = await exhaustedWithNoLock('MyStack');
    expect(message.endsWith('If you are certain no other process is active, run: cdkd force-unlock MyStack --stack-region us-east-1')).toBe(true);
    // An apostrophe before the command flips the quote parity of a pasted
    // sentence (lock-contention-message.md).
    expect(message).not.toContain("'");
  });

  it('keeps the suppression when the stack name cannot be reproduced safely', async () => {
    const message = await exhaustedWithNoLock('My\u0000Stack');
    expect(message).not.toContain('cdkd force-unlock');
    expect(message).toContain('If you are certain no other process is active, inspect the lock object directly');
    expect(message).toContain('most likely released just now');
  });

  it('the held arm names the holder and none of the released wording (negative control)', async () => {
    const c = makeClient();
    c.queue('PutObjectCommand', held);
    c.queue('GetObjectCommand', lockOf('alice'), lockOf('alice'));
    const message = (await thrown(manager(c).acquireLockWithRetry('MyStack', 'us-east-1', 'me', 'deploy', 0, 0))).message;
    expect(message).toContain('after 1 attempt. Locked by: alice, operation: deploy, expires in');
    expect(message).not.toContain('No lock could be read');
    expect(message).not.toContain('released');
  });
});
