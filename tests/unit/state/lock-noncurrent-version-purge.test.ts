import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { clearReplicationProbeCache } from '../../../src/state/s3-replication-purge-gap.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
// `typescript-v6` is an npm alias of typescript@6 — TS7 ships the stable
// compiler API only under `typescript/unstable/*`. Same import every other
// AST-based critic in this repo uses.
import ts from 'typescript-v6';

/**
 * Issue [#2346](https://github.com/go-to-k/cdkd/issues/2346) site 5 —
 * `LockManager` must PURGE the lock key's noncurrent versions wherever
 * `deleteLock` lands a delete marker, not merely write the marker over them.
 *
 * ## Why the lock key is its own site
 *
 * The four sites already purging (rollback journal, bootstrap marker,
 * transient template, custom-resource response) are DISCLOSURE cases — the
 * surviving bodies can hold a secret. `lock.json` holds `owner` / `timestamp`
 * / `expiresAt` / `operation` and nothing else, so this one is bucket cost:
 * renewal writes a version every two minutes at the default TTL, `deleteState`
 * never sweeps the lock key, and nothing purged it, so the chain was monotonic
 * in stacks EVER deployed (452 versions measured on one key).
 *
 * That difference is not cosmetic — it is what decides the LOG LEVEL, and the
 * level is the one thing this site does differently from the other four. See
 * the two level cases below.
 *
 * ## What each case READS, and why the broken code cannot produce it
 *
 * The discriminator is the SECOND and THIRD wire calls. Pre-fix, a release
 * issued exactly one `DeleteObjectCommand`, so "the delete happened" passes on
 * the broken code and proves nothing. Every case here asserts on the presence,
 * the ORDER, the ARGUMENTS or the LEVEL of the `ListObjectVersions` /
 * `DeleteObjects` pair that only the purge emits — plus one case that asserts
 * the purge is ABSENT, on a refusal arm that lands no delete marker.
 */

// Named + hoisted so one case can make the FIRST resolutions fail and a later
// one succeed — the only shape in which `purgeLockVersions`'s own
// `ensureClientForBucket()` call is load-bearing rather than defence in depth.
const rebuildMock = vi.hoisted(() => vi.fn(() => Promise.resolve(null as unknown)));
vi.mock('../../../src/utils/bucket-region-client.js', () => ({
  rebuildClientForBucketRegion: rebuildMock,
}));

// Stubbed rather than driven through STS: what these cases assert is that the
// header REACHES the purge calls, which is a property of the wiring. Held as a
// named mock so one case can make it REJECT — `ownerParam()` sits OUTSIDE the
// shared helper's never-throw guarantee, and it is the only reachable way to
// make the purge fail before it reaches the wire.
const ownerParamMock = vi.hoisted(() =>
  vi.fn(() => Promise.resolve({ ExpectedBucketOwner: '999999999999' }))
);
vi.mock('../../../src/utils/expected-bucket-owner.js', () => ({
  expectedOwnerParam: ownerParamMock,
}));

const warnSpy = vi.hoisted(() => vi.fn());
const debugSpy = vi.hoisted(() => vi.fn());
vi.mock('../../../src/utils/logger.js', () => {
  const child = {
    debug: debugSpy,
    info: vi.fn(),
    warn: warnSpy,
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  return {
    getLogger: () => ({
      child: () => child,
      setLevel: vi.fn(),
      debug: debugSpy,
      info: vi.fn(),
      warn: warnSpy,
      error: vi.fn(),
    }),
  };
});

import { S3ServiceException, type S3Client } from '@aws-sdk/client-s3';
import { LockManager } from '../../../src/state/lock-manager.js';
import type { LockInfo } from '../../../src/types/state.js';

const OWNER = '999999999999';
const BUCKET = 'cdkd-state-999999999999';
const STACK = 'CdkdBasicExample';
const REGION = 'us-east-1';
const LOCK_KEY = `cdkd/${STACK}/${REGION}/lock.json`;
const STATE_KEY = `cdkd/${STACK}/${REGION}/state.json`;

/**
 * The renewal chain a completed run leaves behind, plus the delete marker the
 * release's own `DeleteObject` just wrote.
 *
 * `dm-latest` carries `IsLatest: true` on purpose: it is the CURRENT version,
 * and deleting it would RESURRECT the previous body as a live lock. Reading
 * the version ids the purge asks for — rather than counting them — is what
 * makes that observable.
 *
 * `SIBLING_KEY` is the row that makes the scoping assertion real. S3's
 * `Prefix` is a PREFIX, not an exact match, so asking for `<lock key>` also
 * returns `<lock key>.bak` -- the helper's own comment says so, and the
 * `wanted` set is the ONLY thing that keeps such a row out of the delete. A
 * fixture without it cannot tell a correct `wanted` filter from a missing one.
 * (`STATE_KEY` is deliberately NOT in this listing: it does not share the lock
 * key's prefix, so real S3 would never return it here, and asserting on a row
 * the code could not have seen proves nothing.)
 */
const SIBLING_KEY = `${LOCK_KEY}.bak`;

const LOCK_VERSIONS = [
  { Key: LOCK_KEY, VersionId: 'renew-1', IsLatest: false },
  { Key: LOCK_KEY, VersionId: 'renew-2', IsLatest: false },
  { Key: LOCK_KEY, VersionId: 'acquire-0', IsLatest: false },
  { Key: SIBLING_KEY, VersionId: 'sibling-1', IsLatest: false },
];

interface Sent {
  name: string;
  input: {
    Bucket?: string;
    Key?: string;
    Prefix?: string;
    IfMatch?: string;
    ExpectedBucketOwner?: string;
    Delete?: { Objects?: { Key?: string; VersionId?: string }[] };
  };
}

/** Per-command overrides a case installs before driving the manager. */
interface Behaviour {
  put?: () => Promise<unknown>;
  get?: () => Promise<unknown>;
  deleteObject?: () => Promise<unknown>;
  list?: () => Promise<unknown>;
  deleteObjects?: () => Promise<unknown>;
}

describe('LockManager purges the lock key noncurrent versions (issue #2346 site 5)', () => {
  let sent: Sent[];
  let behaviour: Behaviour;

  beforeEach(() => {
    // Issue #2447: every purge ends with a replication probe cached per
    // BUCKET for the process lifetime. Cleared here so this file's command
    // streams do not depend on which test ran first.
    clearReplicationProbeCache();
    sent = [];
    behaviour = {};
    warnSpy.mockReset();
    debugSpy.mockReset();
    // `mockReset` clears the implementation too, but say it explicitly: one
    // case installs a THROWING sink and a leaked one would red every later case.
    debugSpy.mockImplementation(() => undefined);
    ownerParamMock.mockReset();
    ownerParamMock.mockImplementation(() => Promise.resolve({ ExpectedBucketOwner: OWNER }));
    rebuildMock.mockReset();
    rebuildMock.mockImplementation(() => Promise.resolve(null as unknown));
  });

  /** Build a recording client that appends into `into`. */
  const recordingClient = (into: Sent[]): S3Client =>
    ({
      send: (cmd: unknown): Promise<unknown> => {
        const c = cmd as { constructor: { name: string }; input: Sent['input'] };
        into.push({ name: c.constructor.name, input: c.input });
        switch (c.constructor.name) {
          case 'PutObjectCommand':
            return behaviour.put?.() ?? Promise.resolve({ ETag: '"held-etag"' });
          case 'GetObjectCommand':
            return behaviour.get?.() ?? Promise.resolve({});
          case 'DeleteObjectCommand':
            return behaviour.deleteObject?.() ?? Promise.resolve({});
          case 'ListObjectVersionsCommand':
            return (
              behaviour.list?.() ??
              Promise.resolve({
                Versions: LOCK_VERSIONS,
                DeleteMarkers: [{ Key: LOCK_KEY, VersionId: 'dm-latest', IsLatest: true }],
                IsTruncated: false,
              })
            );
          case 'DeleteObjectsCommand':
            return behaviour.deleteObjects?.() ?? Promise.resolve({});
          default:
            return Promise.resolve({});
        }
      },
      destroy: vi.fn(),
    }) as unknown as S3Client;

  const client = (): S3Client => recordingClient(sent);

  /**
   * A manager with renewal DISABLED. The heartbeat is irrelevant to every
   * question here and a live `setInterval` would leak between cases.
   */
  const manager = (): LockManager =>
    new LockManager(client(), { bucket: BUCKET, prefix: 'cdkd' }, { disableRenewal: true });

  const names = (): string[] => sent.map((s) => s.name);
  const purgeDelete = (): Sent | undefined => sent.find((s) => s.name === 'DeleteObjectsCommand');
  const listing = (): Sent | undefined => sent.find((s) => s.name === 'ListObjectVersionsCommand');
  /** Only the purge's own warnings — a lock refusal warning is not one. */
  const purgeMessages = (spy: typeof warnSpy): string[] =>
    spy.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('noncurrent versions'));

  /** Acquire, then release: the ordinary tail of every mutating command. */
  const acquireThenRelease = async (lm: LockManager): Promise<void> => {
    expect(await lm.acquireLock(STACK, REGION, 'me@host:1', 'deploy')).toBe(true);
    sent.length = 0;
    await lm.releaseLock(STACK, REGION);
  };

  describe('release path', () => {
    it('emits the version listing + version delete the bare DeleteObject never did', async () => {
      await acquireThenRelease(manager());

      // The whole discriminator: pre-fix this array was exactly
      // ['DeleteObjectCommand'].
      expect(names()).toEqual([
        'DeleteObjectCommand',
        'ListObjectVersionsCommand',
        'DeleteObjectsCommand',
        // Issue #2447: the purge closes by asking whether a replica kept
        // what it just removed.
        'GetBucketReplicationCommand',
      ]);
    });

    it('removes every noncurrent version and LEAVES the current delete marker', async () => {
      await acquireThenRelease(manager());

      // Reading the ids, not the count: taking `dm-latest` too would undo the
      // release itself by making the last renewal current again.
      expect(purgeDelete()?.input.Delete?.Objects).toEqual([
        { Key: LOCK_KEY, VersionId: 'renew-1' },
        { Key: LOCK_KEY, VersionId: 'renew-2' },
        { Key: LOCK_KEY, VersionId: 'acquire-0' },
      ]);
    });

    it('scopes the purge to the lock key, never to the stack prefix', async () => {
      // A prefix-scoped sweep would take `state.json`'s history with it — the
      // recovery capability sites 1-3 of the same issue exist to protect.
      await acquireThenRelease(manager());

      expect(listing()?.input.Prefix).toBe(LOCK_KEY);
      expect(listing()?.input.Prefix).not.toBe(`cdkd/${STACK}/${REGION}/`);
      expect(listing()?.input.Bucket).toBe(BUCKET);
      // The listing RETURNS `<lock key>.bak` (S3's Prefix is a prefix), so this
      // assertion fails if the helper's `wanted` membership filter is dropped —
      // unlike an assertion about `state.json`, which the code would never see.
      //
      // Pin the FIXTURE premise too. Measured: dropping `wanted` reds three
      // cases WITH the sibling row and NONE without it, while deleting the row
      // alone reds nothing — so one silent deletion would un-fence the filter
      // and leave this comment describing something the fixture no longer does.
      expect(
        LOCK_VERSIONS.filter((v) => v.Key !== LOCK_KEY),
        'the listing must contain a prefix-sibling row, or the wanted-filter assertion below is inert'
      ).toHaveLength(1);
      const purged = purgeDelete()?.input.Delete?.Objects ?? [];
      expect(purged.map((o) => o.Key)).not.toContain(SIBLING_KEY);
      expect(purged.map((o) => o.Key)).toEqual([LOCK_KEY, LOCK_KEY, LOCK_KEY]);
    });

    it('carries ExpectedBucketOwner on the purge calls, like every state-bucket call', async () => {
      await acquireThenRelease(manager());

      // The length pin is not decoration: a `for` over the recorded calls
      // passes VACUOUSLY on the pre-fix code, where the only call is the
      // delete that already carried the header. FOUR since issue #2447: the
      // replication probe is a state-bucket read too, so it carries the header
      // like everything else.
      expect(sent).toHaveLength(4);
      for (const call of sent) expect(call.input.ExpectedBucketOwner).toBe(OWNER);
    });

    it('still purges when the DELETE is refused as foreign', async () => {
      // The `finally` shape sites 4 and 6 use. Skipping the purge whenever the
      // delete did not land would leave the whole chain behind; the helper's
      // `IsLatest` filter makes it safe here, because the version that is
      // current — ours or the new owner's — is exactly what it excludes.
      behaviour.deleteObject = (): Promise<unknown> =>
        Promise.reject(
          new S3ServiceException({ name: 'PreconditionFailed', $fault: 'client', $metadata: {} })
        );

      await acquireThenRelease(manager());

      expect(names()).toEqual([
        'DeleteObjectCommand',
        'ListObjectVersionsCommand',
        'DeleteObjectsCommand',
        'GetBucketReplicationCommand',
      ]);
    });

    it('does NOT purge on a pre-delete refusal, which lands no delete marker', async () => {
      // `doReleaseLock` has two arms that return BEFORE the delete. This
      // release therefore added nothing to the chain, so two extra round trips
      // would buy nothing on a path taken at the tail of a mutating command —
      // and whatever history is there is collected by whoever next reaps or
      // releases the key, since the purge is key-scoped rather than scoped to
      // versions this process minted.
      //
      // The arm driven here is the no-ETag one: a PUT that returned no ETag
      // makes the delete unconditional, so ownership is re-read by BODY first,
      // and the body present names somebody else.
      //
      // The discriminator is the absence of the LISTING. Asserting only "no
      // DeleteObjects" would also pass on a build that lists and finds
      // nothing, and asserting "no delete marker" is what the refusal already
      // guarantees. It reddens if the purge is moved out of the `finally` to
      // the top of the method, which is the natural way to get this wrong.
      const other: LockInfo = {
        owner: 'someone-else@host:9',
        timestamp: Date.now(),
        expiresAt: Date.now() + 60_000,
      };
      behaviour.put = (): Promise<unknown> => Promise.resolve({});
      behaviour.get = (): Promise<unknown> =>
        Promise.resolve({
          ETag: '"theirs"',
          Body: { transformToString: () => Promise.resolve(JSON.stringify(other)) },
        });

      const lm = manager();
      expect(await lm.acquireLock(STACK, REGION, 'me@host:1', 'deploy')).toBe(true);
      sent.length = 0;
      await lm.releaseLock(STACK, REGION);

      expect(names()).not.toContain('DeleteObjectCommand');
      expect(names()).not.toContain('ListObjectVersionsCommand');
      expect(names()).not.toContain('DeleteObjectsCommand');
      // ...and the refusal itself still happened, so the case is not passing
      // because the release silently did nothing at all.
      expect(warnSpy.mock.calls.map((c) => String(c[0])).join('\n')).toContain(
        'never learned which version of the lock it wrote'
      );
    });

    it('leaves a CURRENT body alone — the shape the foreign-lock arm really has', async () => {
      // Every other case's current row is a DELETE MARKER. On the arm where our
      // conditional delete is refused, the current version is another process's
      // live lock BODY, and the `IsLatest` filter is the only thing standing
      // between the purge and deleting a lock somebody else is holding. Without
      // a `Versions` entry carrying `IsLatest: true`, nothing here ever observed
      // that shape.
      behaviour.deleteObject = (): Promise<unknown> =>
        Promise.reject(
          new S3ServiceException({ name: 'PreconditionFailed', $fault: 'client', $metadata: {} })
        );
      behaviour.list = (): Promise<unknown> =>
        Promise.resolve({
          Versions: [
            { Key: LOCK_KEY, VersionId: 'theirs-live', IsLatest: true },
            { Key: LOCK_KEY, VersionId: 'ours-1', IsLatest: false },
          ],
          IsTruncated: false,
        });

      await acquireThenRelease(manager());

      expect(purgeDelete()?.input.Delete?.Objects).toEqual([
        { Key: LOCK_KEY, VersionId: 'ours-1' },
      ]);
    });

    it('reports a purge failure at DEBUG, never at WARN', async () => {
      // THE amendment. Users on the pre-#2340 four-action IAM policy get a
      // silent clean deploy today; inheriting the other sites' WARN would give
      // them a warning at the tail of EVERY mutating command, about an object
      // this issue grades as cost rather than disclosure.
      //
      // A per-key `Errors` entry is how `DeleteObjects` reports a partial
      // failure — it does NOT throw — and it is the only thing that makes the
      // helper emit anything at all.
      behaviour.deleteObjects = (): Promise<unknown> =>
        Promise.resolve({
          Errors: [
            { Key: LOCK_KEY, VersionId: 'renew-1', Code: 'AccessDenied', Message: 'Access Denied' },
          ],
        });

      await acquireThenRelease(manager());

      expect(purgeMessages(warnSpy)).toEqual([]);
      const debugged = purgeMessages(debugSpy);
      expect(debugged).toHaveLength(1);
      // Assert the CONTENT too, so routing an empty string to debug would not
      // satisfy the case.
      expect(debugged[0]).toContain('AccessDenied');
      expect(debugged[0]).toContain('s3:DeleteObjectVersion');
      // ...and that the caller named ITS OWN object. The helper's
      // `objectDescription` is per-caller precisely so the reader is told what
      // to go and inspect; leaving it unset falls back to a generic sentence
      // that would still satisfy every other assertion here.
      expect(debugged[0]).toContain('a stack lock heartbeat');
      expect(debugged[0]).not.toContain('an object cdkd has just reported as removed');
    });

    it('never throws out of the purge, even when the client itself is broken', async () => {
      // Every call site is a `finally`, so a throw here would REPLACE the
      // `LockError` a failing release is raising.
      behaviour.list = (): Promise<unknown> => Promise.reject(new Error('boom'));

      await expect(acquireThenRelease(manager())).resolves.toBeUndefined();
      expect(purgeMessages(warnSpy)).toEqual([]);
      expect(purgeMessages(debugSpy)).toHaveLength(1);
    });

    it('a THROWING log sink does not escape the finally', async () => {
      // `report` is handed to the shared helper as its `warn` SINK, and the
      // helper calls that sink OUTSIDE any try — so a sink that throws makes
      // the never-throwing helper throw, out of a `finally`. `logger.debug`
      // reaches `console.debug` on stdout, which this repo has measured
      // throwing EPIPE synchronously under `--verbose | head`.
      //
      // Scoped to the purge's own message rather than to every debug line: a
      // sink that throws on ALL of them would abort the release before the
      // delete, and the case would then pass or fail for a different reason.
      behaviour.deleteObjects = (): Promise<unknown> =>
        Promise.resolve({
          Errors: [{ Key: LOCK_KEY, VersionId: 'renew-1', Code: 'AccessDenied' }],
        });
      debugSpy.mockImplementation((m: unknown) => {
        if (String(m).includes('noncurrent versions')) throw new Error('EPIPE: broken pipe');
      });

      await expect(acquireThenRelease(manager())).resolves.toBeUndefined();
    });

    it('a THROWING log sink does not REPLACE the LockError the release is raising', async () => {
      // The consequential half. A throw from a `finally` replaces the pending
      // exception, so without a total `report` a diagnosable lock failure
      // reaches the caller as a broken pipe.
      behaviour.deleteObject = (): Promise<unknown> =>
        Promise.reject(Object.assign(new Error('throttled'), { name: 'SlowDown' }));
      behaviour.deleteObjects = (): Promise<unknown> =>
        Promise.resolve({
          Errors: [{ Key: LOCK_KEY, VersionId: 'renew-1', Code: 'AccessDenied' }],
        });
      debugSpy.mockImplementation((m: unknown) => {
        if (String(m).includes('noncurrent versions')) throw new Error('EPIPE: broken pipe');
      });

      const lm = manager();
      expect(await lm.acquireLock(STACK, REGION, 'me@host:1', 'deploy')).toBe(true);
      sent.length = 0;
      await expect(lm.releaseLock(STACK, REGION)).rejects.toThrow(/Failed to release lock/);
    });

    it('never throws when the purge cannot even START', async () => {
      // The case above exercises the SHARED HELPER's never-throw guarantee.
      // This one exercises the wrapper's, which is a separate arm and the only
      // one that can break the `finally` contract: `ensureClientForBucket()`
      // and `ownerParam()` both reach AWS and sit OUTSIDE the helper. Without
      // its own `catch` a rejection here escapes the `finally` and REPLACES
      // whatever the release was raising.
      //
      // Driven through `ownerParam` because it is the reachable half: the
      // client is already resolved by the time the purge runs (the delete
      // resolved it), so `ensureClientForBucket()` returns immediately.
      const lm = manager();
      expect(await lm.acquireLock(STACK, REGION, 'me@host:1', 'deploy')).toBe(true);
      sent.length = 0;
      let seen = 0;
      ownerParamMock.mockImplementation(() => {
        seen += 1;
        // Call 1 is the DELETE, which must still succeed -- otherwise the
        // release fails for an unrelated reason and this case stops being
        // about the purge at all. Call 2 is the purge's.
        if (seen === 1) return Promise.resolve({ ExpectedBucketOwner: OWNER });
        return Promise.reject(new Error('sts denied'));
      });

      await expect(lm.releaseLock(STACK, REGION)).resolves.toBeUndefined();

      // The purge never reached the wire, which is what makes this the
      // could-not-START arm rather than the helper's own failure path.
      expect(names()).toEqual(['DeleteObjectCommand']);
      const debugged = purgeMessages(debugSpy);
      expect(debugged).toHaveLength(1);
      expect(debugged[0]).toContain('the purge could not be started');
      expect(debugged[0]).toContain('sts denied');
      expect(debugged[0]).toContain(LOCK_KEY);
    });

    it('SANITIZES the key it prints, which embeds attacker-influenced text', async () => {
      // The key is built from the stack name and, on the reap paths, a region
      // this process read out of an object BODY — so it is untrusted text on
      // its way to a terminal. Without a control character in the fixture the
      // sanitization is unobservable: removing `displaySafe` left every other
      // case green.
      const NASTY = `Cdkd\u001b[31mEvil\u0007`;
      const lm = new LockManager(client(), { bucket: BUCKET, prefix: 'cdkd' }, { disableRenewal: true });
      expect(await lm.acquireLock(NASTY, REGION, 'me@host:1', 'deploy')).toBe(true);
      sent.length = 0;
      let seen = 0;
      ownerParamMock.mockImplementation(() => {
        seen += 1;
        if (seen === 1) return Promise.resolve({ ExpectedBucketOwner: OWNER });
        return Promise.reject(new Error('sts denied'));
      });

      await expect(lm.releaseLock(NASTY, REGION)).resolves.toBeUndefined();

      const [message] = purgeMessages(debugSpy);
      expect(message).toBeDefined();
      // The escape sequence must not reach the terminal, while the readable
      // part of the name still does — a message that dropped the key entirely
      // would also satisfy a bare "no escape char" assertion.
      expect(message).not.toContain('\u001b');
      expect(message).not.toContain('\u0007');
      expect(message).toContain('Cdkd');
    });
  });

  describe('reap paths', () => {
    /** An expired lock body for the takeover branch to find. */
    const expired = (): LockInfo => ({
      owner: 'crashed@host:7',
      timestamp: Date.now() - 60 * 60 * 1000,
      expiresAt: Date.now() - 30 * 60 * 1000,
      operation: 'deploy',
    });

    const primeTakeover = (): void => {
      let firstPut = true;
      behaviour.put = (): Promise<unknown> => {
        if (firstPut) {
          firstPut = false;
          return Promise.reject(
            new S3ServiceException({ name: 'PreconditionFailed', $fault: 'client', $metadata: {} })
          );
        }
        return Promise.resolve({ ETag: '"taken-over"' });
      };
      behaviour.get = (): Promise<unknown> =>
        Promise.resolve({
          ETag: '"expired-etag"',
          Body: { transformToString: () => Promise.resolve(JSON.stringify(expired())) },
        });
    };

    it('the expired-lock takeover purges AFTER the re-acquisition PUT', async () => {
      // ORDER is the assertion. Purging between the delete and the retry would
      // put two round trips inside the delete-then-reacquire window that
      // `acquireLock`'s own comments call out, widening the race in which
      // another reaper acquires. After the PUT it widens nothing — and by then
      // the takeover's own delete marker is noncurrent, so it is collected too.
      primeTakeover();

      expect(await manager().acquireLock(STACK, REGION, 'me@host:1', 'deploy')).toBe(true);

      expect(names()).toEqual([
        'PutObjectCommand',
        'GetObjectCommand',
        'DeleteObjectCommand',
        'PutObjectCommand',
        'ListObjectVersionsCommand',
        'DeleteObjectsCommand',
        'GetBucketReplicationCommand',
      ]);
    });

    it('the takeover purge reports at WARN, unlike the release path', async () => {
      // A takeover is rare and already prints a warning of its own, so the
      // cost profile is the one `docs/state-management.md` means by "only the
      // cleanup paths that need them".
      primeTakeover();
      behaviour.deleteObjects = (): Promise<unknown> =>
        Promise.resolve({
          Errors: [{ Key: LOCK_KEY, VersionId: 'renew-1', Code: 'AccessDenied' }],
        });

      expect(await manager().acquireLock(STACK, REGION, 'me@host:1', 'deploy')).toBe(true);

      expect(purgeMessages(debugSpy)).toEqual([]);
      expect(purgeMessages(warnSpy)).toHaveLength(1);
      expect(purgeMessages(warnSpy)[0]).toContain('AccessDenied');
      expect(purgeMessages(warnSpy)[0]).toContain('a stack lock heartbeat');
    });

    it('re-resolves the bucket region when the DELETE could not', async () => {
      // The one shape in which `purgeLockVersions`'s own
      // `ensureClientForBucket()` is load-bearing rather than defence in depth:
      // the region resolution FAILS for `getLockInfo` and for `deleteLock`, the
      // delete throws, and the `finally` still runs — so without its own
      // resolution the purge would go out on the ORIGINAL, wrong-region client.
      // The discriminator is WHICH recorder the purge's calls land in.
      const replacementSent: Sent[] = [];
      const replacement = recordingClient(replacementSent);
      let attempt = 0;
      rebuildMock.mockImplementation(() => {
        attempt += 1;
        // 1: getLockInfo. 2: deleteLock. 3: the purge.
        if (attempt < 3) return Promise.reject(new Error('GetBucketLocation denied'));
        return Promise.resolve(replacement as unknown);
      });

      await expect(manager().forceReleaseLock(STACK, REGION)).rejects.toThrow(
        'GetBucketLocation denied'
      );

      expect(replacementSent.map((r) => r.name)).toEqual([
        'ListObjectVersionsCommand',
        'DeleteObjectsCommand',
        'GetBucketReplicationCommand',
      ]);
      // ...and nothing purge-shaped went out on the unresolved client.
      expect(sent.map((r) => r.name)).not.toContain('ListObjectVersionsCommand');
    });

    it('never lets a PERSISTENTLY unresolvable region throw out of the purge', async () => {
      // The sibling above resolves on the purge's own attempt, so it proves the
      // resolution HAPPENS but never that its failure is contained. Without
      // this, hoisting `await this.ensureClientForBucket()` above
      // `purgeLockVersions`'s `try` -- a natural "client setup belongs first"
      // refactor -- survives the whole suite, and then a persistent
      // GetBucketLocation denial throws out of a `finally` and REPLACES the
      // caller's error. The never-throw contract names this call and
      // `ownerParam()` as the pair it covers; only the second half was fenced.
      rebuildMock.mockImplementation(() =>
        Promise.reject(new Error('GetBucketLocation denied'))
      );

      // Both errors carry the SAME message, so this rejection alone cannot say
      // which one surfaced. What fences the hoist mutation is the warn COUNT
      // below: hoisted, the purge's failure escapes instead of being reported,
      // and there is no warn at all.
      await expect(manager().forceReleaseLock(STACK, REGION)).rejects.toThrow(
        'GetBucketLocation denied'
      );

      // Reported, not thrown, and on the reap path that means `warn`.
      expect(purgeMessages(warnSpy)).toHaveLength(1);
      expect(purgeMessages(warnSpy)[0]).toContain('could not be started');
    });

    it('forceReleaseLock purges after its unconditional delete', async () => {
      behaviour.get = (): Promise<unknown> =>
        Promise.resolve({
          Body: { transformToString: () => Promise.resolve(JSON.stringify(expired())) },
        });

      await manager().forceReleaseLock(STACK, REGION);

      expect(names()).toEqual([
        'GetObjectCommand',
        'DeleteObjectCommand',
        'ListObjectVersionsCommand',
        'DeleteObjectsCommand',
        'GetBucketReplicationCommand',
      ]);
      expect(purgeDelete()?.input.Delete?.Objects).toEqual([
        { Key: LOCK_KEY, VersionId: 'renew-1' },
        { Key: LOCK_KEY, VersionId: 'renew-2' },
        { Key: LOCK_KEY, VersionId: 'acquire-0' },
      ]);
    });

    it('forceReleaseLock reports a purge failure at WARN', async () => {
      behaviour.get = (): Promise<unknown> =>
        Promise.resolve({
          Body: { transformToString: () => Promise.resolve(JSON.stringify(expired())) },
        });
      behaviour.deleteObjects = (): Promise<unknown> =>
        Promise.resolve({
          Errors: [{ Key: LOCK_KEY, VersionId: 'renew-1', Code: 'AccessDenied' }],
        });

      await manager().forceReleaseLock(STACK, REGION);

      expect(purgeMessages(debugSpy)).toEqual([]);
      expect(purgeMessages(warnSpy)).toHaveLength(1);
    });

    it('reports a could-not-START failure at WARN on a reap path', async () => {
      // The release-path twin of this exists above. Without BOTH, the wrapper's
      // `catch` arm has no level coverage at all: replacing its `report(` with a
      // direct `this.logger.debug(` left the whole suite green, because every
      // case that reached that arm was a release.
      behaviour.get = (): Promise<unknown> =>
        Promise.resolve({
          Body: { transformToString: () => Promise.resolve(JSON.stringify(expired())) },
        });
      let seen = 0;
      ownerParamMock.mockImplementation(() => {
        seen += 1;
        // 1 = getLockInfo, 2 = the DELETE (both must succeed), 3 = the purge.
        if (seen < 3) return Promise.resolve({ ExpectedBucketOwner: OWNER });
        return Promise.reject(new Error('sts denied'));
      });

      await manager().forceReleaseLock(STACK, REGION);

      expect(purgeMessages(debugSpy)).toEqual([]);
      const warned = purgeMessages(warnSpy);
      expect(warned).toHaveLength(1);
      expect(warned[0]).toContain('the purge could not be started');
      expect(warned[0]).toContain('sts denied');
    });

    it('forceReleaseLock still purges when the delete itself fails', async () => {
      behaviour.get = (): Promise<unknown> =>
        Promise.resolve({
          Body: { transformToString: () => Promise.resolve(JSON.stringify(expired())) },
        });
      behaviour.deleteObject = (): Promise<unknown> => Promise.reject(new Error('throttled'));

      await expect(manager().forceReleaseLock(STACK, REGION)).rejects.toThrow('throttled');

      // The `finally` runs on the throwing path, and — because the purge never
      // throws — does not replace the error the caller sees. Both halves are
      // asserted: the rejection above, the purge below.
      expect(names()).toContain('ListObjectVersionsCommand');
      expect(names()).toContain('DeleteObjectsCommand');
    });

    it('the legacy region-less lock key is purged at its own key', async () => {
      // `cdkd state orphan` (`state.ts`) and `cdkd force-unlock` are the two
      // callers of `forceReleaseLock`, and both can pass `region: undefined` —
      // the pre-v2 `{prefix}/{stack}/lock.json` layout. A purge pointed at the
      // region-scoped key would list a key that does not exist and silently
      // clean nothing.
      const legacyKey = `cdkd/${STACK}/lock.json`;
      behaviour.get = (): Promise<unknown> =>
        Promise.resolve({
          Body: { transformToString: () => Promise.resolve(JSON.stringify(expired())) },
        });
      behaviour.list = (): Promise<unknown> =>
        Promise.resolve({
          Versions: [{ Key: legacyKey, VersionId: 'legacy-1', IsLatest: false }],
          IsTruncated: false,
        });

      await manager().forceReleaseLock(STACK, undefined);

      expect(listing()?.input.Prefix).toBe(legacyKey);
      expect(purgeDelete()?.input.Delete?.Objects).toEqual([
        { Key: legacyKey, VersionId: 'legacy-1' },
      ]);
    });
  });

  /**
   * The fence. `deleteLock` is private with four call sites today, and a fifth
   * that forgot the purge would reintroduce this issue silently — the delete
   * still succeeds, and only a version listing months later shows the growth.
   *
   * The population is derived from the DELETE (the precondition), never from
   * the purge (the remedy): a query for the remedy can only ever return the
   * sites that already have it, so the sites that lack it are invisible by
   * construction. It parses rather than greps, for the reason
   * `custom-resource-response-version-purge-sharing.test.ts` gives at length:
   * a comment naming either method must not be able to satisfy or to widen it.
   */
  describe('every deleteLock caller is paired with a purge (fence)', () => {
    const SRC = join(process.cwd(), 'src/state/lock-manager.ts');

    /**
     * Members of `LockManager` that call `this.<name>(...)`, by member name.
     *
     * A `finally` block is part of its enclosing member, which is what makes
     * per-MEMBER pairing the right unit: `doReleaseLock` deletes twice and
     * purges once, because one key-scoped purge covers both attempts.
     *
     * `text` is a parameter so the guard-the-guard below can drive THIS
     * function with a broken source instead of re-implementing the parse beside
     * it. An earlier revision asserted on a locally-parsed string and never
     * called this function at all, so deleting the throw below left the whole
     * suite green.
     *
     * Attribution covers every shape a class member can take, not just
     * `MethodDeclaration`: a property-assigned arrow (`probe = async () => {}`)
     * and a constructor are ordinary ways to write a fifth caller, and keying
     * on methods alone made both INVISIBLE — the fence failed OPEN on exactly
     * the change it exists to catch.
     *
     * ## WHAT THIS WALK CANNOT SEE, measured rather than assumed
     *
     * This list is the artifact. Two review rounds each found a shape the
     * previous round's query missed, so the useful thing is not a wider query
     * but an accurate account of the edges:
     *
     * - **An ALIASED `this`** (`const self = this; self.deleteLock(...)`) is
     *   invisible — the walk matches on a `this.` receiver. That is a
     *   fail-OPEN, so it is REFUSED rather than modelled: `assertNoThisAlias`
     *   below fails if `lock-manager.ts` ever introduces one. Refusing an
     *   unmodelled construct is stricter than adding a fifth pattern for it.
     * - **A nested class or object literal** attributes to ITS OWN member name
     *   (`innerM`, `om`), not to the enclosing one. Not a fail-open: such a
     *   name is not on `LockManager`, so the pinned population below reddens.
     * - **A plain `function () {}` expression** inherits the enclosing member's
     *   name. Harmless by construction: `this` inside one is not the instance,
     *   so a `this.deleteLock()` there could never be a real call site.
     * - **A computed member name** returns the sentinel (fail-closed). Measured:
     *   at class top level that is indistinguishable from returning `undefined`,
     *   because the fallback is the sentinel either way; the two differ only for
     *   a computed member NESTED inside another member. Kept as belt-and-braces
     *   and stated rather than fenced, because no test can tell them apart in
     *   any shape this file could plausibly take.
     * - **CO-LOCATION IS NOT PAIRING**, and this is the widest edge. The walk
     *   proves a `deleteLock` and a `purgeLockVersions` appear in the SAME
     *   member; it cannot prove the purge is REACHABLE from the delete. A purge
     *   moved into a branch the delete can never reach — a sibling `if`, an
     *   arm that returns first — keeps this green. That gap is covered
     *   behaviourally instead, by the per-site command-sequence cases above:
     *   they assert the actual order of commands on the wire, which no
     *   syntactic walk can. Read the two together, not either alone.
     *
     * Real-file inventory, measured: zero `this` aliases, zero nested classes,
     * zero object-literal methods, zero function expressions.
     *
     * A call that cannot be attributed to any member is recorded under a
     * PER-SITE sentinel, so it fails CLOSED. Per-site is load-bearing: with one
     * shared sentinel, two unattributable sites — one deleting, one purging —
     * landed in the same bucket and PAIRED WITH EACH OTHER, so the pairing
     * assertion stayed green on exactly the input the sentinel exists to catch.
     */
    /** Marker for a member whose NAME is not statically resolvable. */
    const COMPUTED = '<computed member name>';
    const UNATTRIBUTED_PREFIX = '<unattributed call at line ';
    const unattributed = (source: ts.SourceFile, node: ts.Node): string =>
      `${UNATTRIBUTED_PREFIX}${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}>`;

    const methodsCalling = (name: string, text?: string): Set<string> => {
      const body = text ?? readFileSync(SRC, 'utf8');
      const source = ts.createSourceFile(SRC, body, ts.ScriptTarget.Latest, true);
      const diagnostics =
        (source as unknown as { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics ??
        [];
      // A parse failure must be LOUD: a silent zero reads exactly like a file
      // with no violations.
      if (diagnostics.length > 0) {
        throw new Error(
          `${SRC} failed to parse (${diagnostics.length} errors): ` +
            ts.flattenDiagnosticMessageText(diagnostics[0]!.messageText, ' ')
        );
      }
      const memberName = (node: ts.Node): string | undefined => {
        if (ts.isConstructorDeclaration(node)) return 'constructor';
        if (
          ts.isMethodDeclaration(node) ||
          ts.isPropertyDeclaration(node) ||
          ts.isGetAccessorDeclaration(node) ||
          ts.isSetAccessorDeclaration(node)
        ) {
          const n = node.name;
          if (ts.isIdentifier(n) || ts.isStringLiteral(n) || ts.isPrivateIdentifier(n)) {
            return n.text;
          }
          // A computed member name is not statically resolvable; see the
          // "cannot see" list above for why this is belt-and-braces.
          return COMPUTED;
        }
        return undefined;
      };
      const found = new Set<string>();
      const walk = (node: ts.Node, member: string | undefined): void => {
        const here = memberName(node) ?? member;
        if (
          ts.isCallExpression(node) &&
          ts.isPropertyAccessExpression(node.expression) &&
          node.expression.expression.kind === ts.SyntaxKind.ThisKeyword &&
          node.expression.name.text === name
        ) {
          found.add(here === undefined || here === COMPUTED ? unattributed(source, node) : here);
        }
        node.forEachChild((child) => walk(child, here));
      };
      walk(source, undefined);
      return found;
    };

    /**
     * Refuse the one construct the walk cannot follow.
     *
     * `const self = this; self.deleteLock(...)` is a real call site that the
     * `this.` receiver match does not see — a fail-OPEN. Modelling alias flow
     * would be a fifth pattern over the same text; refusing the construct is
     * the stricter option and the one this repo prefers, because an unmodelled
     * shape then STOPS the fence instead of passing through it.
     */
    const thisAliases = (text: string): number => {
      const source = ts.createSourceFile(SRC, text, ts.ScriptTarget.Latest, true);
      let n = 0;
      const walk = (node: ts.Node): void => {
        if (ts.isVariableDeclaration(node) && node.initializer?.kind === ts.SyntaxKind.ThisKeyword) {
          n += 1;
        }
        if (
          ts.isBinaryExpression(node) &&
          node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
          node.right.kind === ts.SyntaxKind.ThisKeyword
        ) {
          n += 1;
        }
        node.forEachChild(walk);
      };
      walk(source);
      return n;
    };

    it('refuses a `this` alias, which the walk cannot follow', () => {
      // Fail CLOSED on the fence's own blind spot rather than pretend it does
      // not exist. If this ever reddens, the fix is to remove the alias from
      // `lock-manager.ts` or to teach the walk to follow it — not to delete
      // this case.
      expect(thisAliases(readFileSync(SRC, 'utf8'))).toBe(0);
      // ...and the detector is not vacuous.
      expect(thisAliases('class A { m(): void { const self = this; self.deleteLock(); } }')).toBe(1);
      expect(thisAliases('class A { m(): void { let s; s = this; s.deleteLock(); } }')).toBe(1);
    });

    it('derives a population the fence can actually see', () => {
      // A floor written as a LITERAL, not recomputed from the same walk: a
      // query that silently stopped matching would otherwise satisfy itself.
      // The three methods are `acquireLock` (expired-lock takeover),
      // `doReleaseLock` (conditional delete + unconditional escape hatch) and
      // `forceReleaseLock` (`cdkd force-unlock`, `cdkd state orphan`).
      expect([...methodsCalling('deleteLock')].sort()).toEqual([
        'acquireLock',
        'doReleaseLock',
        'forceReleaseLock',
      ]);
    });

    it('every method that deletes the lock also purges its versions', () => {
      const deleters = methodsCalling('deleteLock');
      const purgers = methodsCalling('purgeLockVersions');
      const unpaired = [...deleters].filter((m) => !purgers.has(m)).sort();
      expect(
        unpaired,
        'a deleteLock call site with no purgeLockVersions reintroduces issue #2346 site 5 silently'
      ).toEqual([]);
    });

    it('the purge is not called from anywhere that does not delete', () => {
      // The other direction. A purge on a path that lands no delete marker is
      // two round trips buying nothing, and — on the hot path — the cost this
      // site was argued about in the first place.
      const deleters = methodsCalling('deleteLock');
      const stray = [...methodsCalling('purgeLockVersions')].filter((m) => !deleters.has(m)).sort();
      expect(stray).toEqual([]);
    });

    describe('guard-the-guard: the fence itself', () => {
      // Every case here drives `methodsCalling` — the function the assertions
      // above use. Asserting on a locally-parsed copy instead is how the
      // previous revision of this block stayed green while the real fence's
      // parse-failure throw was deleted.
      it('FAILS loudly when the scanned source no longer parses', () => {
        // Without the throw, an unparseable file yields an EMPTY set and every
        // pairing assertion above passes vacuously.
        expect(() => methodsCalling('deleteLock', 'class A { m( {')).toThrow(/failed to parse/);
      });

      it('sees a caller written as a class-property ARROW, not only as a method', () => {
        // The commonest way a fifth caller would actually be written. Keying on
        // `MethodDeclaration` alone made this invisible, i.e. the fence failed
        // OPEN on the change it exists to catch.
        expect([
          ...methodsCalling(
            'deleteLock',
            'class A { probe = async (): Promise<void> => { await this.deleteLock(1, 2); }; }'
          ),
        ]).toEqual(['probe']);
      });

      it('sees a caller written in a CONSTRUCTOR', () => {
        expect([
          ...methodsCalling('deleteLock', 'class A { constructor() { void this.deleteLock(1, 2); } }'),
        ]).toEqual(['constructor']);
      });

      it('sees a caller written in an ACCESSOR', () => {
        expect([
          ...methodsCalling('deleteLock', 'class A { get x(): number { void this.deleteLock(1, 2); return 1; } }'),
        ]).toEqual(['x']);
      });

      it('records an unattributable call rather than dropping it, so it fails CLOSED', () => {
        // Dropping it would mean a `this.deleteLock` the walk cannot place
        // silently leaves the deleter set — the fence's own version of the
        // population-derived-from-the-defect trap.
        const stray = methodsCalling(
          'deleteLock',
          'async function f(): Promise<void> { await this.deleteLock(1, 2); }'
        );
        expect([...stray]).toHaveLength(1);
        expect([...stray][0]).toContain(UNATTRIBUTED_PREFIX);
      });

      it('gives each unattributable site its OWN sentinel, so two cannot pair', () => {
        // THE reason the sentinel is per-site. With one shared sentinel, an
        // unattributable DELETE and an unattributable PURGE landed in the same
        // bucket and paired with each other, leaving the pairing assertion
        // green on precisely the input the sentinel exists to catch. The
        // previous version of this case asserted against `class A {}`, which
        // has no calls at all and so held for any implementation.
        const src =
          'async function a(): Promise<void> { await this.deleteLock(1, 2); }\n' +
          'async function b(): Promise<void> { await this.purgeLockVersions(1, 2); }';
        const deleters = methodsCalling('deleteLock', src);
        const purgers = methodsCalling('purgeLockVersions', src);
        expect([...deleters]).toHaveLength(1);
        expect([...purgers]).toHaveLength(1);
        // Different LINES, therefore different sentinels, therefore unpaired —
        // which is what makes the pairing assertion red on this input.
        expect([...deleters][0]).not.toEqual([...purgers][0]);
        expect([...deleters].filter((m) => !purgers.has(m))).toHaveLength(1);
      });

      it('attributes a #private member to its own name', () => {
        expect([
          ...methodsCalling('deleteLock', 'class A { #reap(): void { void this.deleteLock(1, 2); } }'),
        ]).toEqual(['#reap']);
      });

      it('does not match a call on something other than `this`', () => {
        expect([
          ...methodsCalling('deleteLock', 'class A { m(): void { void other.deleteLock(1, 2); } }'),
        ]).toEqual([]);
      });

      it('does not match the NAME appearing only in a comment', () => {
        expect([
          ...methodsCalling('deleteLock', 'class A { m(): void { /* this.deleteLock(1, 2) */ } }'),
        ]).toEqual([]);
      });
    });
  });
});
