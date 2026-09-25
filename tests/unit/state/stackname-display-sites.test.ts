/**
 * Every lock / state message that renders a stack name, a region or S3's
 * error text renders it FLATTENED (issue #3027).
 *
 * The values reach `LockManager` and `S3StateBackend` from S3 key segments
 * (`listStacks` -> `cdkd state destroy` / `cdkd state orphan`), from a nested
 * child's minted name and from the CLI, and neither class can tell which. A
 * value carrying a newline could otherwise FORGE a line of cdkd's own output --
 * the logger strips terminal control, but it cannot tell cdkd's newline from a
 * value's. Each case drives one path and asserts the message it names:
 *
 * - is EMITTED at all, so a reworded or unreached site fails rather than
 *   passing vacuously;
 * - carries no line break or control character anywhere; and
 * - shows each hostile value inside its `displayIdent` boundary -- the literal
 *   below, not a helper call, so a regression in the helper is caught too.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vite-plus/test';
import { S3Client, S3ServiceException, NoSuchKey } from '@aws-sdk/client-s3';
import { LockManager } from '../../../src/state/lock-manager.js';
import type { LockManagerOptions } from '../../../src/state/lock-manager.js';
import { S3StateBackend } from '../../../src/state/s3-state-backend.js';
import type { StateBackendConfig } from '../../../src/types/config.js';
import type { StackState } from '../../../src/types/state.js';

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

// A newline to forge a line, an ESC to drive the terminal.
const STACK = 'Evil\n[ok] FORGED-STACK\u001b[2J';
const REGION = 'us-east-1\n[ok] FORGED-REGION';
// Plus a zero-width space: only the ASCII allowlist removes it, so it tells
// that rule apart from the control-character denylist.
const ERROR_TEXT = 'denied:\u200b stacks/Evil\n[ok] FORGED-ERROR\u001b[2J';
const OWNER = 'me@host\n[ok] FORGED-OWNER';

// What `displayIdent` makes of them: every non-printable byte a space, then
// quoted because sanitization altered the value.
const SHOWN_STACK = '"Evil [ok] FORGED-STACK [2J"';
const SHOWN_REGION = '"us-east-1 [ok] FORGED-REGION"';
// The error text takes the ASCII allowlist without a boundary.
const SHOWN_ERROR = 'denied:  stacks/Evil [ok] FORGED-ERROR [2J';

// The invisibles are here because the hostile values carry one and only the
// allowlist strips it; no cdkd message spells one itself.
// eslint-disable-next-line no-control-regex
const LINE_BREAK_OR_CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u200b\ufeff]/;

function logged(): string[] {
  return [logs.debug, logs.info, logs.warn, logs.error].flatMap((m) =>
    m.mock.calls.map((c) => String(c[0]))
  );
}

/** Assert the message(s) containing `needle` exist and render flattened. */
function expectFlattened(texts: string[], needle: string, ...shown: string[]): void {
  const hits = texts.filter((t) => t.includes(needle));
  expect(hits, `no message contains ${JSON.stringify(needle)}`).not.toHaveLength(0);
  for (const hit of hits) {
    expect(hit, hit).not.toMatch(LINE_BREAK_OR_CONTROL);
    for (const s of shown) expect(hit).toContain(s);
  }
}

async function thrownMessage(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  throw new Error('expected a rejection');
}

const s3err = (name: string, status: number, message = ERROR_TEXT): S3ServiceException =>
  new S3ServiceException({
    name,
    message,
    $fault: status >= 500 ? 'server' : 'client',
    $metadata: { httpStatusCode: status },
  } as never);

type Reply = (input: Record<string, unknown>) => unknown;

/**
 * A client double driven by per-command queues. An unqueued PUT stores its
 * body and answers an ETag, an unqueued GET returns the stored body, and an
 * unqueued listing is empty -- so a case scripts only the call it is about.
 */
function makeClient(): {
  client: S3Client;
  queue: (command: string, ...replies: Reply[]) => void;
  store: { body: string | undefined };
} {
  const queues = new Map<string, Reply[]>();
  const store: { body: string | undefined } = { body: undefined };
  const send = vi.fn(async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
    const name = command.constructor.name;
    const next = queues.get(name)?.shift();
    if (next) return next(command.input);
    switch (name) {
      case 'PutObjectCommand':
        store.body = command.input['Body'] as string;
        return { ETag: '"e1"' };
      case 'GetObjectCommand':
        if (store.body === undefined) {
          throw new NoSuchKey({ message: 'gone', $metadata: { httpStatusCode: 404 } });
        }
        return {
          Body: { transformToString: () => Promise.resolve(store.body) },
          ETag: '"e1"',
        };
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
    store,
  };
}

const fail = (error: unknown): Reply => () => {
  throw error;
};
/** `etag: null` answers with no ETag at all. */
const lockBody = (info: Record<string, unknown>, etag: string | null = '"e0"'): Reply => () => ({
  Body: { transformToString: () => Promise.resolve(JSON.stringify(info)) },
  ETag: etag ?? undefined,
});
const EXPIRED = { owner: 'someone-else', timestamp: 1, expiresAt: 2 };
const LIVE = { owner: 'someone-else', timestamp: 1, expiresAt: Date.now() + 3_600_000 };

const config: StateBackendConfig = { bucket: 'b', prefix: 'stacks' };

beforeEach(async () => {
  vi.clearAllMocks();
  ownerParamMock.mockResolvedValue({});
  const { resolveBucketRegion } = await import('../../../src/utils/aws-region-resolver.js');
  vi.mocked(resolveBucketRegion).mockResolvedValue('us-east-1');
});

afterEach(() => {
  vi.useRealTimers();
});

describe('LockManager renders a hostile stack name, region and error flattened (issue #3027)', () => {
  const manager = (
    c: ReturnType<typeof makeClient>,
    options: LockManagerOptions = { disableRenewal: true }
  ): LockManager => new LockManager(c.client, config, options);

  it('acquire, release and a second release in flight', async () => {
    const c = makeClient();
    const lm = manager(c);
    expect(await lm.acquireLock(STACK, REGION, OWNER)).toBe(true);
    const first = lm.releaseLock(STACK, REGION);
    const second = lm.releaseLock(STACK, REGION);
    await Promise.all([first, second]);
    const texts = logged();
    expectFlattened(texts, 'Attempting to acquire lock', SHOWN_STACK, SHOWN_REGION);
    expectFlattened(texts, 'Lock acquired for stack', SHOWN_STACK, SHOWN_REGION, 'me@host [ok] FORGED-OWNER');
    expectFlattened(texts, 'Lock renewal is disabled', SHOWN_STACK, SHOWN_REGION);
    expectFlattened(texts, 'Release already in flight', SHOWN_STACK, SHOWN_REGION);
    expectFlattened(texts, 'Releasing lock for stack', SHOWN_STACK, SHOWN_REGION);
    expectFlattened(texts, 'Lock released for stack', SHOWN_STACK, SHOWN_REGION);
  });

  it('a live lock held by someone else', async () => {
    const c = makeClient();
    c.queue('PutObjectCommand', fail(s3err('PreconditionFailed', 412)));
    c.queue('GetObjectCommand', lockBody(LIVE));
    expect(await manager(c).acquireLock(STACK, REGION)).toBe(false);
    expectFlattened(logged(), 'Lock already exists for stack', SHOWN_STACK, SHOWN_REGION);
  });

  it('an expired lock with no ETag', async () => {
    const c = makeClient();
    c.queue('PutObjectCommand', fail(s3err('PreconditionFailed', 412)));
    c.queue('GetObjectCommand', lockBody(EXPIRED, null));
    expect(await manager(c).acquireLock(STACK, REGION)).toBe(false);
    expectFlattened(logged(), 'its current version could not be identified', SHOWN_STACK, SHOWN_REGION);
  });

  it('an expired lock whose conditional delete cannot be evaluated', async () => {
    const c = makeClient();
    c.queue('PutObjectCommand', fail(s3err('PreconditionFailed', 412)));
    c.queue('GetObjectCommand', lockBody(EXPIRED));
    c.queue('DeleteObjectCommand', fail(s3err('AccessDenied', 403)));
    expect(await manager(c).acquireLock(STACK, REGION)).toBe(false);
    expectFlattened(logged(), 'will not evaluate a conditional delete', SHOWN_STACK, SHOWN_REGION);
  });

  it('an expired lock that changed before takeover', async () => {
    const c = makeClient();
    c.queue('PutObjectCommand', fail(s3err('PreconditionFailed', 412)));
    c.queue('GetObjectCommand', lockBody(EXPIRED));
    c.queue('DeleteObjectCommand', fail(s3err('PreconditionFailed', 412)));
    expect(await manager(c).acquireLock(STACK, REGION)).toBe(false);
    expectFlattened(logged(), 'changed before takeover', SHOWN_STACK, SHOWN_REGION);
  });

  it('an expired lock taken over', async () => {
    const c = makeClient();
    c.queue('PutObjectCommand', fail(s3err('PreconditionFailed', 412)));
    c.queue('GetObjectCommand', lockBody(EXPIRED));
    expect(await manager(c).acquireLock(STACK, REGION, OWNER)).toBe(true);
    const texts = logged();
    expectFlattened(texts, 'Took over an EXPIRED lock', SHOWN_STACK, SHOWN_REGION);
    expectFlattened(texts, 'after expired lock cleanup', SHOWN_STACK, SHOWN_REGION, 'me@host [ok] FORGED-OWNER');
  });

  it('an expired lock taken by another process between delete and retry', async () => {
    const c = makeClient();
    c.queue(
      'PutObjectCommand',
      fail(s3err('PreconditionFailed', 412)),
      fail(s3err('PreconditionFailed', 412))
    );
    c.queue('GetObjectCommand', lockBody(EXPIRED));
    expect(await manager(c).acquireLock(STACK, REGION)).toBe(false);
    expectFlattened(logged(), 'acquired by another process during expired lock cleanup', SHOWN_STACK, SHOWN_REGION);
  });

  it('release: replaced since acquisition, and already gone', async () => {
    const c = makeClient();
    const lm = manager(c);
    await lm.acquireLock(STACK, REGION);
    c.queue('DeleteObjectCommand', fail(s3err('PreconditionFailed', 412)));
    await lm.releaseLock(STACK, REGION);
    expectFlattened(logged(), 'it has been replaced since', SHOWN_STACK, SHOWN_REGION);

    const c2 = makeClient();
    const lm2 = manager(c2);
    await lm2.acquireLock(STACK, REGION);
    c2.queue('DeleteObjectCommand', fail(new NoSuchKey({ message: 'x', $metadata: {} })));
    await lm2.releaseLock(STACK, REGION);
    expectFlattened(logged(), 'was already gone', SHOWN_STACK, SHOWN_REGION);
  });

  it('release: a conditional delete that cannot be evaluated, on a lock no longer ours', async () => {
    const c = makeClient();
    const lm = manager(c);
    await lm.acquireLock(STACK, REGION);
    c.queue('DeleteObjectCommand', fail(s3err('AccessDenied', 403)));
    c.queue('GetObjectCommand', lockBody(LIVE));
    await lm.releaseLock(STACK, REGION);
    expectFlattened(logged(), 'the conditional delete could not be evaluated', SHOWN_STACK, SHOWN_REGION);
  });

  it('release: the unconditional fallback, and its failure', async () => {
    const c = makeClient();
    const lm = manager(c);
    await lm.acquireLock(STACK, REGION);
    c.queue(
      'DeleteObjectCommand',
      fail(s3err('AccessDenied', 403)),
      fail(s3err('InternalError', 500))
    );
    const message = await thrownMessage(lm.releaseLock(STACK, REGION));
    expectFlattened([message], 'Failed to release lock for stack', SHOWN_STACK, SHOWN_REGION, SHOWN_ERROR);
    expectFlattened(logged(), 'is not supported here', SHOWN_STACK, SHOWN_REGION, SHOWN_ERROR);
  });

  it('release: the unconditional fallback, succeeding', async () => {
    const c = makeClient();
    const lm = manager(c);
    await lm.acquireLock(STACK, REGION);
    c.queue('DeleteObjectCommand', fail(s3err('AccessDenied', 403)));
    await lm.releaseLock(STACK, REGION);
    // Only the fallback arm logs this after the "not supported" line.
    const texts = logged();
    const after = texts.slice(texts.findIndex((t) => t.includes('is not supported here')) + 1);
    expectFlattened(after, 'Lock released for stack', SHOWN_STACK, SHOWN_REGION);
  });

  it('acquire and lock-info reads that fail', async () => {
    const c = makeClient();
    c.queue('PutObjectCommand', fail(s3err('InternalError', 500)));
    c.queue('GetObjectCommand', fail(s3err('InternalError', 500)));
    const lm = manager(c);
    const acquire = await thrownMessage(lm.acquireLock(STACK, REGION));
    expectFlattened([acquire], 'Failed to acquire lock for stack', SHOWN_STACK, SHOWN_REGION, SHOWN_ERROR);
    const info = await thrownMessage(lm.getLockInfo(STACK, REGION));
    expectFlattened([info], 'Failed to get lock info for stack', SHOWN_STACK, SHOWN_ERROR);
  });

  it('release: any other failure', async () => {
    const c = makeClient();
    const lm = manager(c);
    await lm.acquireLock(STACK, REGION);
    c.queue('DeleteObjectCommand', fail(s3err('InternalError', 500)));
    const message = await thrownMessage(lm.releaseLock(STACK, REGION));
    expectFlattened([message], 'Failed to release lock for stack', SHOWN_STACK, SHOWN_REGION, SHOWN_ERROR);
  });

  it('release: the lock-key purge could not start', async () => {
    const c = makeClient();
    const lm = manager(c);
    await lm.acquireLock(STACK, REGION);
    // Call 1 is the release's DELETE; call 2 is the purge's, which fails.
    ownerParamMock.mockReset();
    ownerParamMock
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error(ERROR_TEXT))
      .mockResolvedValue({});
    await lm.releaseLock(STACK, REGION);
    expectFlattened(logged(), 'the purge could not be started', SHOWN_ERROR);
  });

  it('acquire with no ETag, then a release that cannot confirm ownership', async () => {
    const c = makeClient();
    const lm = manager(c, {});
    c.queue('PutObjectCommand', () => ({ ETag: undefined }));
    await lm.acquireLock(STACK, REGION);
    c.queue('GetObjectCommand', lockBody(LIVE));
    await lm.releaseLock(STACK, REGION);
    const texts = logged();
    expectFlattened(texts, 'No ETag returned when acquiring the lock', SHOWN_STACK, SHOWN_REGION);
    expectFlattened(texts, 'never learned which version', SHOWN_STACK, SHOWN_REGION);
  });

  it('forceReleaseLock with and without a readable lock', async () => {
    const c = makeClient();
    c.queue('GetObjectCommand', lockBody(LIVE));
    await manager(c).forceReleaseLock(STACK, REGION);
    await manager(makeClient()).forceReleaseLock(STACK, REGION);
    const hits = logged().filter((t) => t.includes('Force releasing lock for stack'));
    expect(hits).toHaveLength(2);
    expectFlattened(hits, 'Force releasing lock for stack', SHOWN_STACK, SHOWN_REGION);

    // A legacy region-less lock (`cdkd state orphan` with no region).
    logs.warn.mockClear();
    await manager(makeClient()).forceReleaseLock(STACK, undefined);
    expectFlattened(logged(), 'Force releasing lock for stack', SHOWN_STACK);
    // ...and names no region, where there is none to name.
    const regionless = logged().filter((t) => t.includes('Force releasing lock for stack'));
    expect(regionless).toHaveLength(1);
    expect(regionless[0]).toContain(`${SHOWN_STACK} (no lock body read`);

    // An EMPTY region is not absent: the key is `stacks/<stack>//lock.json`,
    // so the banner says the region is unrenderable rather than omitting it.
    logs.warn.mockClear();
    await manager(makeClient()).forceReleaseLock(STACK, '');
    expectFlattened(logged(), 'Force releasing lock for stack', `${SHOWN_STACK} (<unrenderable>)`);
  });

  it('acquireLockWithRetry: the retry line and the final refusal', async () => {
    const c = makeClient();
    c.queue('PutObjectCommand', fail(s3err('PreconditionFailed', 412)), fail(s3err('PreconditionFailed', 412)));
    c.queue('GetObjectCommand', lockBody(LIVE), lockBody(LIVE), lockBody(LIVE), lockBody(LIVE), lockBody(LIVE));
    const message = await thrownMessage(manager(c).acquireLockWithRetry(STACK, REGION, undefined, undefined, 1, 0));
    expectFlattened(logged(), 'is locked by', SHOWN_STACK, SHOWN_REGION);
    expectFlattened([message], 'Failed to acquire lock for stack', SHOWN_STACK, SHOWN_REGION);
  });

  describe('renewal', () => {
    it('renewed, then lost, then the release that refuses', async () => {
      vi.useFakeTimers();
      const c = makeClient();
      const lm = manager(c, {});
      await lm.acquireLock(STACK, REGION);
      await vi.advanceTimersByTimeAsync(2 * 60 * 1000);
      expectFlattened(logged(), 'Renewed lock for stack', SHOWN_STACK, SHOWN_REGION);

      c.queue('PutObjectCommand', fail(s3err('PreconditionFailed', 412)));
      c.queue('GetObjectCommand', fail(s3err('InternalError', 500)));
      await vi.advanceTimersByTimeAsync(2 * 60 * 1000);
      await lm.releaseLock(STACK, REGION);
      const texts = logged();
      expectFlattened(texts, 'Lost the lock for stack', SHOWN_STACK, SHOWN_REGION);
      expectFlattened(texts, 'this process lost it', SHOWN_STACK, SHOWN_REGION);
    });

    it('adopts its own write after a 412', async () => {
      vi.useFakeTimers();
      const c = makeClient();
      const lm = manager(c, {});
      await lm.acquireLock(STACK, REGION);
      // The renewal PUT lands (the default reply stores its body) and then
      // answers 412, so the read-back finds this process's own renewal.
      c.queue('PutObjectCommand', (input) => {
        c.store.body = input['Body'] as string;
        throw s3err('PreconditionFailed', 412);
      });
      await vi.advanceTimersByTimeAsync(2 * 60 * 1000);
      expectFlattened(logged(), 'reported a conflict', SHOWN_STACK, SHOWN_REGION);
      await lm.releaseLock(STACK, REGION);
    });

    it('a renewal with no ETag, then a release it cannot confirm', async () => {
      vi.useFakeTimers();
      const c = makeClient();
      const lm = manager(c, {});
      await lm.acquireLock(STACK, REGION);
      c.queue('PutObjectCommand', () => ({ ETag: undefined }));
      c.queue('GetObjectCommand', fail(s3err('InternalError', 500)));
      await vi.advanceTimersByTimeAsync(2 * 60 * 1000);
      c.queue('DeleteObjectCommand', fail(s3err('PreconditionFailed', 412)));
      await lm.releaseLock(STACK, REGION);
      const texts = logged();
      expectFlattened(texts, 'returned no ETag and the object could', SHOWN_STACK, SHOWN_REGION);
      expectFlattened(texts, 'could not confirm which version', SHOWN_STACK, SHOWN_REGION);
    });

    it('transient failures, past the lock expiry', async () => {
      vi.useFakeTimers();
      const c = makeClient();
      // A 1-minute TTL renews every 15 s, so five failures pass the deadline.
      const lm = manager(c, { ttlMinutes: 1 });
      await lm.acquireLock(STACK, REGION);
      for (let i = 0; i < 5; i++) c.queue('PutObjectCommand', fail(s3err('SlowDown', 503)));
      await vi.advanceTimersByTimeAsync(75 * 1000);
      const texts = logged();
      expectFlattened(texts, 'failed, will retry', SHOWN_STACK, SHOWN_REGION, SHOWN_ERROR);
      expectFlattened(texts, 'has been failing long enough', SHOWN_STACK, SHOWN_REGION);
      await lm.releaseLock(STACK, REGION);
    });
  });
});

describe('S3StateBackend renders a hostile stack name, region and error flattened (issue #3027)', () => {
  const state = { version: 1, stackName: STACK, resources: {}, outputs: {}, lastModified: 0 } as unknown as StackState;
  const backend = (c: ReturnType<typeof makeClient>): S3StateBackend =>
    new S3StateBackend(c.client, config);

  it('saveState, with a legacy migration whose delete fails', async () => {
    const c = makeClient();
    c.queue('DeleteObjectCommand', fail(s3err('InternalError', 500)));
    await backend(c).saveState(STACK, REGION, state, { migrateLegacy: true });
    const texts = logged();
    expectFlattened(texts, 'Saving state:', SHOWN_STACK, SHOWN_REGION);
    expectFlattened(texts, 'State saved:', SHOWN_STACK, SHOWN_REGION);
    expectFlattened(texts, 'failed to delete legacy key', SHOWN_STACK, SHOWN_ERROR);

    const c2 = makeClient();
    await backend(c2).saveState(STACK, REGION, state, { migrateLegacy: true });
    expectFlattened(logged(), 'Migrated state for stack', SHOWN_STACK, SHOWN_REGION);
  });

  it('saveState refusals', async () => {
    const c = makeClient();
    c.queue('PutObjectCommand', () => ({ ETag: undefined }), fail(s3err('InternalError', 500)));
    const b = backend(c);
    // The no-ETag refusal is rethrown through the generic arm, which wraps it
    // once more -- both layers must stay flat.
    const noEtagError = await b.saveState(STACK, REGION, state).then(
      () => undefined,
      (e: unknown) => e as Error
    );
    expect(noEtagError).toBeInstanceOf(Error);
    expectFlattened([noEtagError!.message], 'No ETag returned after saving state', SHOWN_STACK, SHOWN_REGION);
    // The inner refusal survives as the CAUSE, which an uncaught error prints
    // unwrapped -- so it must be flat on its own, not only inside the wrapper.
    const cause = (noEtagError as Error & { cause?: unknown }).cause as Error;
    expectFlattened([cause.message], 'No ETag returned after saving state', SHOWN_STACK, SHOWN_REGION);
    const failed = await thrownMessage(b.saveState(STACK, REGION, state));
    expectFlattened([failed], 'Failed to save state for stack', SHOWN_STACK, SHOWN_REGION, SHOWN_ERROR);
  });

  it('deleteState, sweeping a legacy record, and a journal delete that fails', async () => {
    const c = makeClient();
    // The legacy probe reads the region-less legacy key: a body naming no
    // region belongs to every region, so the sweep runs.
    c.queue('GetObjectCommand', lockBody({ version: 1, stackName: STACK, resources: {} }));
    // Deletes: state.json, the legacy key, then the rollback journal.
    c.queue('DeleteObjectCommand', () => ({}), () => ({}), fail(s3err('InternalError', 500)));
    await backend(c).deleteState(STACK, REGION);
    const texts = logged();
    expectFlattened(texts, 'Deleting state:', SHOWN_STACK, SHOWN_REGION);
    expectFlattened(texts, 'Deleted legacy state for stack', SHOWN_STACK);
    expectFlattened(texts, 'State deleted:', SHOWN_STACK, SHOWN_REGION);
    expectFlattened(texts, 'Failed to delete rollback journal', SHOWN_STACK, SHOWN_REGION, SHOWN_ERROR);
  });

  it('deleteState and deleteLegacyState refusals', async () => {
    const c = makeClient();
    c.queue('DeleteObjectCommand', fail(s3err('InternalError', 500)), () => ({}), fail(s3err('InternalError', 500)));
    const b = backend(c);
    const failed = await thrownMessage(b.deleteState(STACK, REGION));
    expectFlattened([failed], 'Failed to delete state for stack', SHOWN_STACK, SHOWN_REGION, SHOWN_ERROR);
    const legacy = await thrownMessage(b.deleteLegacyState(STACK));
    expectFlattened([legacy], 'Failed to delete legacy state for stack', SHOWN_STACK, SHOWN_ERROR);
  });

  it('deleteLegacyState logs the name and the key it deletes', async () => {
    const c = makeClient();
    await backend(c).deleteLegacyState(STACK);
    const texts = logged();
    expectFlattened(texts, 'Deleting legacy state:', SHOWN_STACK, '"stacks/Evil [ok] FORGED-STACK [2J/state.json"');
    expectFlattened(texts, 'Legacy state deleted:', SHOWN_STACK);
  });

  it('deleteState over a legacy record it cannot read', async () => {
    const hostileClass = Object.assign(new Error(ERROR_TEXT), { name: 'Bad\u200b\n[ok] FORGED-CLASS' });
    const c = makeClient();
    c.queue('GetObjectCommand', fail(hostileClass));
    await backend(c).deleteState(STACK, REGION);
    let texts = logged();
    expectFlattened(texts, 'Could not read legacy state region for', SHOWN_STACK, SHOWN_ERROR);
    expectFlattened(texts, 'Could not read the legacy state record for', SHOWN_STACK, '(Bad  [ok] FORGED-CLASS)');

    logs.debug.mockClear();
    const c2 = makeClient();
    c2.queue('GetObjectCommand', () => ({ ETag: '"e"' }), lockBody({ region: 7 }));
    await backend(c2).deleteState(STACK, REGION);
    await backend(c2).deleteState(STACK, REGION);
    texts = logged();
    expectFlattened(texts, 'response carried no body', SHOWN_STACK);
    expectFlattened(texts, "'region' is number", SHOWN_STACK);
  });

  it('getState read failures, on the region-scoped and the legacy key', async () => {
    const c = makeClient();
    c.queue(
      'GetObjectCommand',
      fail(s3err('InternalError', 500)),
      fail(new NoSuchKey({ message: 'x', $metadata: {} })),
      fail(s3err('InternalError', 500))
    );
    const b = backend(c);
    const scoped = await thrownMessage(b.getState(STACK, REGION));
    expectFlattened([scoped], 'Failed to get state for stack', SHOWN_STACK, SHOWN_REGION, SHOWN_ERROR);
    const legacy = await thrownMessage(b.getState(STACK, REGION));
    expectFlattened([legacy], 'Failed to get legacy state for stack', SHOWN_STACK, SHOWN_ERROR);
  });

  it('getState over a legacy record naming no usable region', async () => {
    const c = makeClient();
    c.queue(
      'GetObjectCommand',
      fail(new NoSuchKey({ message: 'x', $metadata: {} })),
      lockBody({ version: 1, stackName: 'x', region: '', resources: {}, outputs: {}, lastModified: 0 })
    );
    expect(await backend(c).getState(STACK, REGION)).not.toBeNull();
    expectFlattened(logged(), 'names no usable region', SHOWN_STACK);
  });

  it('a purge that could not start', async () => {
    const c = makeClient();
    ownerParamMock.mockReset();
    ownerParamMock.mockRejectedValueOnce(new Error(ERROR_TEXT)).mockResolvedValue({});
    await backend(c).purgeNoncurrentVersions(['stacks/x/y/rollback-journal.json']);
    expectFlattened(logged(), 'the purge could not be started', SHOWN_ERROR);
  });

  it('listRawObjects drops an entry under a hostile key', async () => {
    const c = makeClient();
    // The listing is URL-encoded, so the key arrives encoded as S3 sends it.
    c.queue('ListObjectsV2Command', () => ({
      Contents: [{ Key: encodeURIComponent(`stacks/${STACK}/r/deployments/a.jsonl`), Size: 1 }],
      IsTruncated: false,
    }));
    await backend(c).listRawObjects(`stacks/${STACK}/`);
    expectFlattened(
      logged(),
      'dropping an entry under',
      '"stacks/Evil [ok] FORGED-STACK [2J/"',
      '"stacks/Evil [ok] FORGED-STACK [2J/r/deployments/a.jsonl"'
    );
  });

  it('deleteRawObjects reports hostile per-key failures', async () => {
    const c = makeClient();
    c.queue('DeleteObjectsCommand', () => ({
      Errors: [
        { Key: `stacks/${STACK}/r/deployments/a.jsonl`, Code: 'Denied\n[ok]', Message: ERROR_TEXT },
        // A code with nothing renderable left takes the stand-in.
        { Key: 'stacks/b.jsonl', Code: '\u0007\u200b', Message: 'x' },
      ],
    }));
    const message = await thrownMessage(backend(c).deleteRawObjects([`stacks/${STACK}/r/deployments/a.jsonl`, 'stacks/b.jsonl']));
    expectFlattened(
      [message],
      'Failed to delete 2 object(s)',
      '"stacks/Evil [ok] FORGED-STACK [2J/r/deployments/a.jsonl"',
      `(Denied [ok]: ${SHOWN_ERROR})`,
      '(<unrenderable>: x)'
    );
  });
});
