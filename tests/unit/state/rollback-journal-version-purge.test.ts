import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { clearReplicationProbeCache } from '../../../src/state/s3-replication-purge-gap.js';

/**
 * Issue [#2346](https://github.com/go-to-k/cdkd/issues/2346) site 4 —
 * `S3StateBackend.deleteRollbackJournal` must PURGE the journal key's
 * noncurrent versions, not merely write a delete marker over them.
 *
 * ## Why this is the highest-severity site of the seven
 *
 * `cdkd bootstrap` turns VERSIONING ON for the state bucket, so a bare
 * `DeleteObject` leaves every prior body readable through `GetObject` with a
 * `VersionId`. The journal's `failedOperations[].attemptedProperties` holds
 * the properties of the FAILED WRITE verbatim. Measured 2026-08-20 on
 * `CdkdDeletionPolicySnapshotHeavyExample` (recorded in the header of
 * `tests/integration/s3-versions.sh`): four surviving versions each carrying a
 * literal `"MasterUserPassword": "Cdkdcf2f..."` after cdkd reported the state
 * deleted.
 *
 * Unlike `state.json` (sites 1-3 of that issue), the journal is TRANSIENT by
 * design — it lives only between a failed / interrupted deploy and its `cdkd
 * rollback` — so there is no state-recovery capability weighing against the
 * purge, which is why this site is a straight application of the shared
 * remedy while those three are not.
 *
 * ## What each test READS, and why the broken code cannot produce it
 *
 * The discriminator throughout is the SECOND wire call. Before the fix the
 * method issued exactly ONE command, a `DeleteObjectCommand`; asserting "the
 * delete happened" therefore passes on the broken code and proves nothing.
 * These tests assert on the presence, the ORDER, and the ARGUMENTS of the
 * `ListObjectVersionsCommand` / `DeleteObjectsCommand` pair that only the
 * purge emits.
 */

// The state bucket may live in another region, so every state-bucket call
// goes through `ensureClientForBucket()`. `null` keeps the client under test.
vi.mock('../../../src/utils/bucket-region-client.js', () => ({
  rebuildClientForBucketRegion: vi.fn().mockResolvedValue(null),
}));

// Stubbed rather than driven through STS: this suite asserts that the header
// REACHES the purge calls, which is a property of the backend's wiring and not
// of account resolution.
vi.mock('../../../src/utils/expected-bucket-owner.js', () => ({
  expectedOwnerParam: vi.fn().mockResolvedValue({ ExpectedBucketOwner: '999999999999' }),
}));

const warnSpy = vi.hoisted(() => vi.fn());
vi.mock('../../../src/utils/logger.js', () => {
  const child = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: warnSpy,
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  return {
    getLogger: () => ({
      child: () => child,
      setLevel: vi.fn(),
      debug: vi.fn(),
      info: vi.fn(),
      warn: warnSpy,
      error: vi.fn(),
    }),
  };
});

import { NoSuchKey, type S3Client } from '@aws-sdk/client-s3';
import { S3StateBackend } from '../../../src/state/s3-state-backend.js';

const OWNER = '999999999999';
const BUCKET = 'cdkd-state-999999999999';
const STACK = 'CdkdDeletionPolicySnapshotHeavyExample';
const REGION = 'us-east-1';
const JOURNAL_KEY = `cdkd/${STACK}/${REGION}/rollback-journal.json`;

/**
 * The four versions the real measurement found, each carrying the master
 * password. `IsLatest: false` on all of them plus the delete marker the bare
 * delete just wrote is exactly the post-delete shape of the bug.
 */
const SURVIVING_VERSIONS = [
  { Key: JOURNAL_KEY, VersionId: 'v-1', IsLatest: false },
  { Key: JOURNAL_KEY, VersionId: 'v-2', IsLatest: false },
  { Key: JOURNAL_KEY, VersionId: 'v-3', IsLatest: false },
  { Key: JOURNAL_KEY, VersionId: 'v-4', IsLatest: false },
];

interface Sent {
  name: string;
  input: {
    Bucket?: string;
    Key?: string;
    Prefix?: string;
    ExpectedBucketOwner?: string;
    Delete?: { Objects?: { Key?: string; VersionId?: string }[] };
  };
}

describe('deleteRollbackJournal purges noncurrent versions (issue #2346 site 4)', () => {
  let sent: Sent[];
  let deleteBehaviour: () => Promise<unknown>;

  const client = (): S3Client =>
    ({
      send: (cmd: unknown): Promise<unknown> => {
        const c = cmd as { constructor: { name: string }; input: Sent['input'] };
        sent.push({ name: c.constructor.name, input: c.input });
        if (c.constructor.name === 'DeleteObjectCommand') return deleteBehaviour();
        if (c.constructor.name === 'ListObjectVersionsCommand') {
          return Promise.resolve({
            Versions: SURVIVING_VERSIONS,
            // The delete marker the bare `DeleteObject` just wrote. It is the
            // CURRENT version, so the purge must leave it alone — dropping it
            // would resurrect the journal as a live object.
            DeleteMarkers: [{ Key: JOURNAL_KEY, VersionId: 'dm-latest', IsLatest: true }],
            IsTruncated: false,
          });
        }
        return Promise.resolve({});
      },
      destroy: vi.fn(),
    }) as unknown as S3Client;

  const backend = (): S3StateBackend =>
    new S3StateBackend(client(), { bucket: BUCKET, prefix: 'cdkd' });

  const names = (): string[] => sent.map((s) => s.name);

  beforeEach(() => {
    // Issue #2447: every purge ends with a replication probe cached per
    // BUCKET for the process lifetime. Cleared here so this file's command
    // streams do not depend on which test ran first.
    clearReplicationProbeCache();
    sent = [];
    warnSpy.mockReset();
    deleteBehaviour = (): Promise<unknown> => Promise.resolve({});
  });

  it('emits the version listing + version delete the bare DeleteObject never did', async () => {
    await backend().deleteRollbackJournal(STACK, REGION);

    // The whole discriminator: pre-fix this array was exactly
    // ['DeleteObjectCommand'].
    expect(names()).toEqual([
      'DeleteObjectCommand',
      'ListObjectVersionsCommand',
      'DeleteObjectsCommand',
      // Issue #2447: the purge closes by asking whether a replica kept what
      // it just removed.
      'GetBucketReplicationCommand',
    ]);
  });

  it('removes every noncurrent body and LEAVES the current delete marker', async () => {
    await backend().deleteRollbackJournal(STACK, REGION);

    const purge = sent.find((s) => s.name === 'DeleteObjectsCommand');
    // Reading the version ids, not the count: a purge that took `dm-latest`
    // too would still delete "some versions" while undoing the delete itself.
    expect(purge?.input.Delete?.Objects).toEqual([
      { Key: JOURNAL_KEY, VersionId: 'v-1' },
      { Key: JOURNAL_KEY, VersionId: 'v-2' },
      { Key: JOURNAL_KEY, VersionId: 'v-3' },
      { Key: JOURNAL_KEY, VersionId: 'v-4' },
    ]);
  });

  it('scopes the purge to the journal key, never to the stack prefix', async () => {
    // A prefix-scoped sweep would take `state.json`'s versions with it — the
    // recovery capability sites 1-3 of the same issue exist to protect.
    await backend().deleteRollbackJournal(STACK, REGION);

    const list = sent.find((s) => s.name === 'ListObjectVersionsCommand');
    expect(list?.input.Prefix).toBe(JOURNAL_KEY);
    expect(list?.input.Bucket).toBe(BUCKET);
  });

  it('carries ExpectedBucketOwner on the purge calls, like every state-bucket call', async () => {
    await backend().deleteRollbackJournal(STACK, REGION);

    // The length pin is not decoration: a `for` over the recorded calls passes
    // VACUOUSLY on the pre-fix code, where the only call is the delete that
    // already carried the header. FOUR since issue #2447: the replication
    // probe is a state-bucket read too and carries the header like the rest.
    expect(sent).toHaveLength(4);
    for (const call of sent) {
      expect(call.input.ExpectedBucketOwner).toBe(OWNER);
    }
  });

  it('still purges when the delete reports NoSuchKey', async () => {
    // A not-found CURRENT object says NOTHING about the key's history: on a
    // versioned bucket an earlier delete leaves a marker as current with every
    // body still readable. The pre-fix code `return`ed from this arm, which is
    // the shape this pins.
    deleteBehaviour = (): Promise<unknown> =>
      Promise.reject(new NoSuchKey({ message: 'nope', $metadata: {} }));

    await expect(backend().deleteRollbackJournal(STACK, REGION)).resolves.toBeUndefined();

    expect(names()).toContain('ListObjectVersionsCommand');
    expect(names()).toContain('DeleteObjectsCommand');
    // The tolerated arm must stay silent.
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('still purges when the delete FAILS outright, and keeps warning about the delete', async () => {
    // Partial-failure gap: skipping the purge whenever the delete threw left
    // every readable version behind with no version warning at all. The
    // purge's `IsLatest` filter makes this safe — the live object survives, its
    // history does not.
    deleteBehaviour = (): Promise<unknown> =>
      Promise.reject(Object.assign(new Error('denied'), { name: 'AccessDenied' }));

    await expect(backend().deleteRollbackJournal(STACK, REGION)).resolves.toBeUndefined();

    expect(names()).toEqual([
      'DeleteObjectCommand',
      'ListObjectVersionsCommand',
      'DeleteObjectsCommand',
      'GetBucketReplicationCommand',
    ]);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Failed to delete rollback journal'));
  });

  it('deleteState purges the journal even when the STATE delete throws', async () => {
    // `deleteRollbackJournal` used to sit INSIDE `deleteState`'s try, after two
    // `DeleteObjectCommand`s, so a throttled or denied `state.json` delete threw
    // first and the journal survived with its CURRENT object and its whole
    // history intact — no purge, no warning — while this class's own docs
    // promised the sweep ran on every destroy path. It is now in a `finally`.
    //
    // Discriminator: the command stream AFTER the throw. Pre-fix it stopped at
    // the single failing `DeleteObjectCommand`; asserting only that
    // `deleteState` rejects passes either way.
    const failing = (cmd: unknown): Promise<unknown> => {
      const c = cmd as { constructor: { name: string }; input: Sent['input'] };
      sent.push({ name: c.constructor.name, input: c.input });
      if (c.constructor.name === 'DeleteObjectCommand' && c.input.Key?.endsWith('state.json')) {
        return Promise.reject(Object.assign(new Error('SlowDown'), { name: 'SlowDown' }));
      }
      if (c.constructor.name === 'ListObjectVersionsCommand') {
        return Promise.resolve({ Versions: SURVIVING_VERSIONS, IsTruncated: false });
      }
      return Promise.resolve({});
    };
    const failingBackend = new S3StateBackend(
      { send: failing, destroy: vi.fn() } as unknown as S3Client,
      { bucket: BUCKET, prefix: 'cdkd' }
    );

    await expect(failingBackend.deleteState(STACK, REGION)).rejects.toThrow(/SlowDown/);

    expect(names()).toContain('ListObjectVersionsCommand');
    expect(names()).toContain('DeleteObjectsCommand');
    const purge = sent.find((x) => x.name === 'DeleteObjectsCommand');
    expect(purge?.input.Delete?.Objects?.map((o) => o.VersionId)).toEqual([
      'v-1',
      'v-2',
      'v-3',
      'v-4',
    ]);
  });

  it('purges AFTER the delete, so the live body is noncurrent by then', async () => {
    // Order is the point, not just co-occurrence: the purge filters on
    // `IsLatest`, so running it BEFORE the delete would skip the live journal —
    // the one body actually holding the failed write's properties.
    await backend().deleteRollbackJournal(STACK, REGION);

    expect(names().indexOf('DeleteObjectCommand')).toBeLessThan(
      names().indexOf('ListObjectVersionsCommand')
    );
  });
});
