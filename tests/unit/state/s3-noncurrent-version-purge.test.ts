import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { displaySafe } from '../../../src/utils/display-safe.js';
import {
  purgeNoncurrentKeyVersions,
  type NoncurrentVersionPurgeOptions,
} from '../../../src/state/s3-noncurrent-version-purge.js';
import {
  clearReplicationProbeCache,
  DEFAULT_PURGED_OBJECT_DESCRIPTION,
} from '../../../src/state/s3-replication-purge-gap.js';

/**
 * Issue [#2340](https://github.com/go-to-k/cdkd/issues/2340) — the SHARED
 * noncurrent-version purge, pinned against its S3 COMMAND STREAM.
 *
 * This is the implementation both `CustomResourceProvider.cleanupResponseObject`
 * and `cdkd gc`'s abandoned-placeholder sweep run, so the properties asserted
 * here hold for both arms by construction. The provider arm's WIRING is pinned
 * in `tests/unit/provisioning/custom-resource-response-version-purge.test.ts`
 * and the gc arm's in `tests/unit/cli/gc-custom-resource-responses.test.ts`;
 * the behaviour is pinned once, here.
 *
 * Every assertion is on which command was sent, with which `Bucket` / `Prefix`
 * / `Delete.Objects` — never on "it did not throw", which a no-op satisfies
 * just as well (and which this function does unconditionally by design).
 */

interface VersionEntry {
  Key?: string;
  VersionId?: string;
  IsLatest?: boolean;
}

interface ListPage {
  Versions?: VersionEntry[];
  DeleteMarkers?: VersionEntry[];
  IsTruncated?: boolean;
  NextKeyMarker?: string;
  NextVersionIdMarker?: string;
}

interface RecordedCommand {
  name: string;
  bucket: string | undefined;
  prefix: string | undefined;
  keyMarker: string | undefined;
  versionIdMarker: string | undefined;
  owner: string | undefined;
  objects: { Key?: string; VersionId?: string }[] | undefined;
}

const BUCKET = 'cdkd-state-123456789012';
const KEY_A = 'custom-resource-responses/cdkd-1756000000000-a1b2c3.json';
const KEY_B = 'custom-resource-responses/cdkd-1756000000001-d4e5f6.json';

describe('purgeNoncurrentKeyVersions (issue #2340)', () => {
  let recorded: RecordedCommand[];
  let warn: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    // Every purge ends with the issue #2447 replication probe, which is cached
    // per BUCKET for the process lifetime. Without this, the first test's
    // answer would be reused by every later one and the wiring tests at the
    // bottom of this file would assert against a stale verdict.
    clearReplicationProbeCache();
    recorded = [];
    warn = vi.fn();
  });

  const logger = (): NonNullable<NoncurrentVersionPurgeOptions['logger']> => ({
    warn: warn as unknown as (m: string) => void,
  });

  /**
   * Record every command and answer `ListObjectVersions` from `pages`, keyed by
   * the `Prefix` actually asked for so a per-key sweep and a single covering
   * listing can be stubbed by the same helper.
   */
  const stub = (
    pages: Record<string, ListPage[]>,
    onList?: (prefix: string) => void,
    onDelete?: (objects: { Key?: string; VersionId?: string }[]) => unknown
  ): { send: (cmd: unknown) => Promise<unknown> } => {
    const seen: Record<string, number> = {};
    return {
      send: (cmd: unknown) => {
        const c = cmd as {
          constructor: { name: string };
          input: {
            Bucket?: string;
            Prefix?: string;
            KeyMarker?: string;
            VersionIdMarker?: string;
            ExpectedBucketOwner?: string;
            Delete?: { Objects?: { Key?: string; VersionId?: string }[] };
          };
        };
        recorded.push({
          name: c.constructor.name,
          bucket: c.input.Bucket,
          prefix: c.input.Prefix,
          keyMarker: c.input.KeyMarker,
          versionIdMarker: c.input.VersionIdMarker,
          owner: c.input.ExpectedBucketOwner,
          objects: c.input.Delete?.Objects,
        });
        if (c.constructor.name === 'ListObjectVersionsCommand') {
          const prefix = c.input.Prefix ?? '';
          onList?.(prefix);
          const i = seen[prefix] ?? 0;
          seen[prefix] = i + 1;
          return Promise.resolve((pages[prefix] ?? [])[i] ?? {});
        }
        if (c.constructor.name === 'DeleteObjectsCommand' && onDelete) {
          // May THROW (whole-batch failure) or RETURN `{ Errors: [...] }`
          // (per-key failure the call reports as overall success).
          return Promise.resolve(onDelete(c.input.Delete?.Objects ?? []));
        }
        return Promise.resolve({});
      },
    };
  };

  const deletes = (): { Key?: string; VersionId?: string }[][] =>
    recorded.filter((c) => c.name === 'DeleteObjectsCommand').map((c) => c.objects ?? []);

  const lists = (): RecordedCommand[] =>
    recorded.filter((c) => c.name === 'ListObjectVersionsCommand');

  it('deletes only NONCURRENT versions of keys in the requested set', async () => {
    const s3 = stub({
      [KEY_A]: [
        {
          Versions: [
            { Key: KEY_A, VersionId: 'v-body', IsLatest: false },
            { Key: KEY_A, VersionId: 'v-placeholder', IsLatest: false },
            // Same PREFIX, different key: `Prefix` is a prefix, not a match.
            { Key: `${KEY_A}.bak`, VersionId: 'v-other-key', IsLatest: false },
            // A key belonging to a concurrent lane, returned because the
            // listing is prefix-scoped. Not in the set -> untouched.
            { Key: KEY_B, VersionId: 'v-someone-else', IsLatest: false },
          ],
          // Our own delete marker, now CURRENT. Must survive.
          DeleteMarkers: [{ Key: KEY_A, VersionId: 'v-marker', IsLatest: true }],
          IsTruncated: false,
        },
      ],
    });

    await purgeNoncurrentKeyVersions(s3, BUCKET, [KEY_A], { logger: logger() });

    expect(lists()).toHaveLength(1);
    expect(lists()[0]!.bucket).toBe(BUCKET);
    expect(lists()[0]!.prefix).toBe(KEY_A);
    expect(deletes()).toEqual([
      [
        { Key: KEY_A, VersionId: 'v-body' },
        { Key: KEY_A, VersionId: 'v-placeholder' },
      ],
    ]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('purges a noncurrent `null` version (versioning SUSPENDED)', async () => {
    // A suspended-versioning bucket can hold a real noncurrent version whose id
    // is the literal string `null`. Filtering on the id rather than on
    // `IsLatest` would leave exactly that one behind.
    const s3 = stub({
      [KEY_A]: [{ Versions: [{ Key: KEY_A, VersionId: 'null', IsLatest: false }] }],
    });

    await purgeNoncurrentKeyVersions(s3, BUCKET, [KEY_A], { logger: logger() });

    expect(deletes()).toEqual([[{ Key: KEY_A, VersionId: 'null' }]]);
  });

  it('an entry with IsLatest ABSENT is left alone AND reported, never dropped silently', async () => {
    // Keying on `!== false` is what makes an omitted `IsLatest` fail CLOSED —
    // deleting it could take a current version. But an entry in `wanted` that
    // is skipped is still a body cdkd was asked to remove and did not, and
    // "nothing purged, nothing warned" is the one outcome this module exists to
    // forbid. Unreachable against real S3, which always populates the field.
    //
    // Both halves are asserted, and they are the two that actually exist:
    // dropping the `recordFailure` leaves the delete assertion green, and
    // weakening the `IsLatest !== false` guard to `=== true` leaves the warning
    // green while deleting a possibly-current version. (The report arm has no
    // `continue` of its own -- the guard below does the skipping -- so there is
    // no third half to probe.)
    const s3 = stub({
      [KEY_A]: [{ Versions: [{ Key: KEY_A, VersionId: 'v-nofield' }] }],
    });

    await purgeNoncurrentKeyVersions(s3, BUCKET, [KEY_A], { logger: logger() });

    expect(deletes()).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0]![0]);
    expect(message).toContain('1 key(s)');
    expect(message).toContain(KEY_A);
    expect(message).toContain('listing omitted IsLatest');
  });

  it('deletes nothing on an UNVERSIONED bucket', async () => {
    // S3 answers an unversioned bucket with the live object carrying
    // `VersionId: 'null'` and `IsLatest: true`. Nothing is noncurrent.
    const s3 = stub({
      [KEY_A]: [{ Versions: [{ Key: KEY_A, VersionId: 'null', IsLatest: true }] }],
    });

    await purgeNoncurrentKeyVersions(s3, BUCKET, [KEY_A], { logger: logger() });

    expect(lists()).toHaveLength(1);
    expect(deletes()).toEqual([]);
  });

  it('follows the version-listing pagination markers', async () => {
    const s3 = stub({
      [KEY_A]: [
        {
          Versions: [{ Key: KEY_A, VersionId: 'v-page1', IsLatest: false }],
          IsTruncated: true,
          NextKeyMarker: KEY_A,
          NextVersionIdMarker: 'v-page1',
        },
        {
          Versions: [{ Key: KEY_A, VersionId: 'v-page2', IsLatest: false }],
          IsTruncated: false,
        },
      ],
    });

    await purgeNoncurrentKeyVersions(s3, BUCKET, [KEY_A], { logger: logger() });

    expect(lists()).toHaveLength(2);
    expect(lists()[0]!.keyMarker).toBeUndefined();
    expect(lists()[1]!.keyMarker).toBe(KEY_A);
    expect(lists()[1]!.versionIdMarker).toBe('v-page1');
    expect(deletes()).toEqual([
      [{ Key: KEY_A, VersionId: 'v-page1' }],
      [{ Key: KEY_A, VersionId: 'v-page2' }],
    ]);
  });

  it('batches per PAGE, which is the only shape real S3 produces', async () => {
    // An earlier fixture put 1001 entries in ONE page to reach the batch loop.
    // Real S3 cannot answer that: `MaxKeys` caps `Versions` + `DeleteMarkers`
    // at 1000 COMBINED, so >1000 versions of a key arrive as multiple PAGES
    // and each page's deletes fit one call. This models the real shape: two
    // full pages plus a short one, one DeleteObjects per page.
    //
    // A consequence worth stating rather than hiding: because `stale` is built
    // from ONE page, `stale.length` can never exceed 1000, so the chunking
    // loop is defence-in-depth and UNREACHABLE in production. No mutation of
    // `DELETE_BATCH_SIZE` is discriminated by any realistic fixture, and this
    // test makes no such claim — raising the ceiling leaves it green, which is
    // correct.
    const page = (n: number, base: number): VersionEntry[] =>
      Array.from({ length: n }, (_, i) => ({
        Key: KEY_A,
        VersionId: `v${base + i}`,
        IsLatest: false,
      }));
    const s3 = stub({
      [KEY_A]: [
        { Versions: page(1000, 0), IsTruncated: true, NextKeyMarker: KEY_A },
        { Versions: page(1000, 1000), IsTruncated: true, NextKeyMarker: KEY_A },
        { Versions: page(7, 2000), IsTruncated: false },
      ],
    });

    await purgeNoncurrentKeyVersions(s3, BUCKET, [KEY_A], { logger: logger() });

    const batches = deletes();
    expect(batches.map((b) => b.length)).toEqual([1000, 1000, 7]);
    expect(batches.every((b) => b.length <= 1000)).toBe(true);
    expect(batches[2]![6]).toEqual({ Key: KEY_A, VersionId: 'v2006' });
  });

  it('with listPrefix: ONE listing for many keys, still bounded by the key set', async () => {
    // The `cdkd gc` shape. The prefix is shared with every concurrent deploy in
    // the region, so the listing returns a stranger's object; set membership,
    // not the prefix, is what bounds the delete.
    const PREFIX = 'custom-resource-responses/';
    const STRANGER = 'custom-resource-responses/cdkd-1756000000009-zzzzzz.json';
    const s3 = stub({
      [PREFIX]: [
        {
          Versions: [
            { Key: KEY_A, VersionId: 'a1', IsLatest: false },
            { Key: KEY_B, VersionId: 'b1', IsLatest: false },
            { Key: STRANGER, VersionId: 's1', IsLatest: false },
          ],
          DeleteMarkers: [{ Key: KEY_A, VersionId: 'a-marker', IsLatest: true }],
        },
      ],
    });

    await purgeNoncurrentKeyVersions(s3, BUCKET, [KEY_A, KEY_B], {
      listPrefix: PREFIX,
      logger: logger(),
    });

    expect(lists()).toHaveLength(1);
    expect(lists()[0]!.prefix).toBe(PREFIX);
    expect(deletes()).toEqual([
      [
        { Key: KEY_A, VersionId: 'a1' },
        { Key: KEY_B, VersionId: 'b1' },
      ],
    ]);
  });

  it('without listPrefix: one listing PER KEY', async () => {
    const s3 = stub({
      [KEY_A]: [{ Versions: [{ Key: KEY_A, VersionId: 'a1', IsLatest: false }] }],
      [KEY_B]: [{ Versions: [{ Key: KEY_B, VersionId: 'b1', IsLatest: false }] }],
    });

    await purgeNoncurrentKeyVersions(s3, BUCKET, [KEY_A, KEY_B], { logger: logger() });

    expect(lists().map((l) => l.prefix)).toEqual([KEY_A, KEY_B]);
    expect(deletes()).toEqual([
      [{ Key: KEY_A, VersionId: 'a1' }],
      [{ Key: KEY_B, VersionId: 'b1' }],
    ]);
  });

  it('threads ExpectedBucketOwner onto every call', async () => {
    const s3 = stub({
      [KEY_A]: [{ Versions: [{ Key: KEY_A, VersionId: 'a1', IsLatest: false }] }],
    });

    await purgeNoncurrentKeyVersions(s3, BUCKET, [KEY_A], {
      requestFields: { ExpectedBucketOwner: '123456789012' },
      logger: logger(),
    });

    // THREE: the listing, the delete, and the issue #2447 replication probe —
    // which needs the owner assertion as much as the other two, since it is a
    // read of bucket-level configuration.
    expect(recorded).toHaveLength(3);
    expect(recorded.map((c) => c.name)).toEqual([
      'ListObjectVersionsCommand',
      'DeleteObjectsCommand',
      'GetBucketReplicationCommand',
    ]);
    expect(recorded.every((c) => c.owner === '123456789012')).toBe(true);
  });

  it('sends nothing at all for an empty key list', async () => {
    const s3 = stub({});
    await purgeNoncurrentKeyVersions(s3, BUCKET, [], { logger: logger() });
    expect(recorded).toEqual([]);
  });

  it('WARNS and does not throw when the listing is refused', async () => {
    // Both callers run this on a path that must not abort — the provider's
    // `finally` / timeout arms, and gc after a collection that already
    // succeeded. Never-throwing is a property of the MECHANISM so neither can
    // forget it; the warning is what stops "swallowed" reading as "succeeded".
    const s3 = stub({}, () => {
      throw new Error('AccessDenied: s3:ListBucketVersions');
    });

    await expect(
      purgeNoncurrentKeyVersions(s3, BUCKET, [KEY_A], { logger: logger() })
    ).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0]![0]);
    expect(message).toContain(BUCKET);
    expect(message).toContain(KEY_A);
    expect(message).toContain('noncurrent');
    expect(message).toContain('s3:ListBucketVersions');
    expect(message).toContain('s3:DeleteObjectVersion');
    expect(message).toContain('AccessDenied: s3:ListBucketVersions');
  });

  it('one key failing does not stop the others', async () => {
    const s3 = stub(
      { [KEY_B]: [{ Versions: [{ Key: KEY_B, VersionId: 'b1', IsLatest: false }] }] },
      (prefix) => {
        if (prefix === KEY_A) throw new Error('SlowDown');
      }
    );

    await purgeNoncurrentKeyVersions(s3, BUCKET, [KEY_A, KEY_B], { logger: logger() });

    expect(deletes()).toEqual([[{ Key: KEY_B, VersionId: 'b1' }]]);
    expect(String(warn.mock.calls[0]![0])).toContain('1 key(s)');
  });

  // ---------------------------------------------------------------------
  // `DeleteObjects` failures. Every earlier failure case threw from
  // `ListObjectVersions` only, and every `DeleteObjectsCommand` stub returned
  // `{}` — so the SECOND of the two grants the warning names,
  // `s3:DeleteObjectVersion`, had no coverage at all.
  // ---------------------------------------------------------------------

  it('reads per-key Errors[] — a partial AccessDenied is NOT success', async () => {
    // The blocker review found by execution: `Quiet: true` means `Errors` is
    // the ONLY signal, and discarding the response reproduced this issue's own
    // defect with the warning suppressed. A principal holding
    // `s3:ListBucketVersions` but NOT `s3:DeleteObjectVersion` lands here.
    const s3 = stub(
      {
        [KEY_A]: [
          {
            Versions: [
              { Key: KEY_A, VersionId: 'v1', IsLatest: false },
              { Key: KEY_A, VersionId: 'v2', IsLatest: false },
            ],
          },
        ],
      },
      undefined,
      () => ({
        Errors: [
          { Key: KEY_A, VersionId: 'v1', Code: 'AccessDenied', Message: 'Access Denied' },
        ],
      })
    );

    await purgeNoncurrentKeyVersions(s3, BUCKET, [KEY_A], { logger: logger() });

    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0]![0]);
    expect(message).toContain('1 key(s)');
    expect(message).toContain(KEY_A);
    expect(message).toContain('AccessDenied');
    expect(message).toContain('v1');
    expect(message).toContain('s3:DeleteObjectVersion');
  });

  it('treats a per-key NoSuchVersion as SUCCESS, not as a failure (issue #2346)', async () => {
    // The version named is already gone, which is the outcome this function
    // exists to produce -- reporting it would tell a blameless user to grant
    // IAM they already hold. Reachable since issue #2346 site 5 put a purge on
    // the LOCK key: a reaper taking over an expired lock and the original
    // owner waking up to release it legitimately purge the same key at once,
    // and the loser of that race sees this for rows the winner removed.
    const s3 = stub(
      {
        [KEY_A]: [
          {
            Versions: [
              { Key: KEY_A, VersionId: 'v1', IsLatest: false },
              { Key: KEY_A, VersionId: 'v2', IsLatest: false },
            ],
          },
        ],
      },
      undefined,
      () => ({
        Errors: [
          { Key: KEY_A, VersionId: 'v1', Code: 'NoSuchVersion', Message: 'The specified version does not exist.' },
          { Key: KEY_A, VersionId: 'v2', Code: 'NoSuchVersion', Message: 'The specified version does not exist.' },
        ],
      })
    );

    await purgeNoncurrentKeyVersions(s3, BUCKET, [KEY_A], { logger: logger() });

    // The discriminator is SILENCE. Before the carve-out this warned about
    // `1 key(s)` naming `NoSuchVersion`, which is the message the amendment
    // removes -- so asserting merely that the delete was attempted would pass
    // either way.
    expect(warn).not.toHaveBeenCalled();
  });

  it('a NoSuchVersion alongside a REAL failure still warns about the real one', async () => {
    // The carve-out must not swallow the batch. `failed` is keyed by KEY, so a
    // per-entry `continue` that also dropped the sibling entry would leave the
    // whole key unreported -- the silence this module exists to remove.
    const s3 = stub(
      {
        [KEY_A]: [
          {
            Versions: [
              { Key: KEY_A, VersionId: 'v1', IsLatest: false },
              { Key: KEY_A, VersionId: 'v2', IsLatest: false },
            ],
          },
        ],
      },
      undefined,
      () => ({
        Errors: [
          { Key: KEY_A, VersionId: 'v1', Code: 'NoSuchVersion' },
          { Key: KEY_A, VersionId: 'v2', Code: 'AccessDenied', Message: 'Access Denied' },
        ],
      })
    );

    await purgeNoncurrentKeyVersions(s3, BUCKET, [KEY_A], { logger: logger() });

    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0]![0]);
    expect(message).toContain('AccessDenied');
    expect(message).toContain('v2');
    // ...and says nothing about the tolerated one, which would send the reader
    // hunting a version that is already in the state they wanted.
    expect(message).not.toContain('NoSuchVersion');
    expect(message).not.toContain('v1');
  });

  it('tolerates NoSuchVersion per KEY, not per batch, under a covering listPrefix', async () => {
    // The carve-out is a `continue` inside a loop over a batch that can span
    // SEVERAL keys, and `failed` is keyed by KEY. A skip that dropped the rest
    // of the batch — or that bucketed by batch rather than by entry — would
    // silence a real failure on a DIFFERENT key. Only the covering-prefix mode
    // puts two keys in one `DeleteObjects` call, so this is the shape that can
    // see it.
    const PREFIX = 'custom-resource-responses/';
    const s3 = stub(
      {
        [PREFIX]: [
          {
            Versions: [
              { Key: KEY_A, VersionId: 'a1', IsLatest: false },
              { Key: KEY_B, VersionId: 'b1', IsLatest: false },
            ],
          },
        ],
      },
      undefined,
      () => ({
        Errors: [
          { Key: KEY_A, VersionId: 'a1', Code: 'NoSuchVersion' },
          { Key: KEY_B, VersionId: 'b1', Code: 'AccessDenied', Message: 'Access Denied' },
        ],
      })
    );

    await purgeNoncurrentKeyVersions(s3, BUCKET, [KEY_A, KEY_B], {
      listPrefix: PREFIX,
      logger: logger(),
    });

    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0]![0]);
    // ONE key, and it is B — not two, and not zero.
    expect(message).toContain('1 key(s)');
    expect(message).toContain(KEY_B);
    expect(message).not.toContain(KEY_A);
  });

  it('a NoSuchKey is NOT tolerated — only NoSuchVersion is (issue #2346)', async () => {
    // Deliberately not widened to every 404-shaped code. `NoSuchKey` says the
    // listing and the delete disagree about the KEY itself, which is a
    // different claim and worth a warning.
    const s3 = stub(
      { [KEY_A]: [{ Versions: [{ Key: KEY_A, VersionId: 'v1', IsLatest: false }] }] },
      undefined,
      () => ({ Errors: [{ Key: KEY_A, VersionId: 'v1', Code: 'NoSuchKey' }] })
    );

    await purgeNoncurrentKeyVersions(s3, BUCKET, [KEY_A], { logger: logger() });

    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain('NoSuchKey');
  });

  it('a PARTIAL failure across keys warns for the failures only', async () => {
    const PREFIX = 'custom-resource-responses/';
    const s3 = stub(
      {
        [PREFIX]: [
          {
            Versions: [
              { Key: KEY_A, VersionId: 'a1', IsLatest: false },
              { Key: KEY_B, VersionId: 'b1', IsLatest: false },
            ],
          },
        ],
      },
      undefined,
      () => ({ Errors: [{ Key: KEY_B, VersionId: 'b1', Code: 'SlowDown' }] })
    );

    await purgeNoncurrentKeyVersions(s3, BUCKET, [KEY_A, KEY_B], {
      listPrefix: PREFIX,
      logger: logger(),
    });

    // Both were ATTEMPTED in one batch...
    expect(deletes()).toEqual([
      [
        { Key: KEY_A, VersionId: 'a1' },
        { Key: KEY_B, VersionId: 'b1' },
      ],
    ]);
    // ...and only the one that failed is reported.
    const message = String(warn.mock.calls[0]![0]);
    expect(message).toContain('1 key(s)');
    expect(message).toContain(KEY_B);
    expect(message).not.toContain(KEY_A);
  });

  it('a THROWN DeleteObjects marks every key in the batch', async () => {
    const PREFIX = 'custom-resource-responses/';
    const s3 = stub(
      {
        [PREFIX]: [
          {
            Versions: [
              { Key: KEY_A, VersionId: 'a1', IsLatest: false },
              { Key: KEY_B, VersionId: 'b1', IsLatest: false },
            ],
          },
        ],
      },
      undefined,
      () => {
        throw new Error('AccessDenied: s3:DeleteObjectVersion');
      }
    );

    await expect(
      purgeNoncurrentKeyVersions(s3, BUCKET, [KEY_A, KEY_B], {
        listPrefix: PREFIX,
        logger: logger(),
      })
    ).resolves.toBeUndefined();

    const message = String(warn.mock.calls[0]![0]);
    expect(message).toContain('2 key(s)');
    expect(message).toContain(KEY_A);
    expect(message).toContain(KEY_B);
  });

  it('a thrown batch does not abandon the REST of the walk', async () => {
    // The outer catch alone cannot discriminate this: it records the same keys
    // either way. What the INNER catch buys is that the walk CONTINUES — page
    // two is still listed and still purged after page one's delete threw.
    let call = 0;
    const s3 = stub(
      {
        [KEY_A]: [
          {
            Versions: [{ Key: KEY_A, VersionId: 'v-page1', IsLatest: false }],
            IsTruncated: true,
            NextKeyMarker: KEY_A,
          },
          {
            Versions: [{ Key: KEY_A, VersionId: 'v-page2', IsLatest: false }],
            IsTruncated: false,
          },
        ],
      },
      undefined,
      () => {
        call += 1;
        if (call === 1) throw new Error('SlowDown');
        return {};
      }
    );

    await purgeNoncurrentKeyVersions(s3, BUCKET, [KEY_A], { logger: logger() });

    expect(lists()).toHaveLength(2);
    expect(deletes()).toEqual([
      [{ Key: KEY_A, VersionId: 'v-page1' }],
      [{ Key: KEY_A, VersionId: 'v-page2' }],
    ]);
    expect(String(warn.mock.calls[0]![0])).toContain('SlowDown');
  });

  it('counts KEYS, not listing prefixes', async () => {
    // Proved by review: 3000 unpurged gc keys reported `1 key(s)` and named
    // the PREFIX, because the failure unit was the listing. `docs/` quoted
    // that sample as if it were per-key.
    const PREFIX = 'custom-resource-responses/';
    const many = Array.from(
      { length: 12 },
      (_, i) => `custom-resource-responses/cdkd-17560000000${String(i).padStart(2, '0')}-x.json`
    );
    const s3 = stub({}, () => {
      throw new Error('AccessDenied: s3:ListBucketVersions');
    });

    await purgeNoncurrentKeyVersions(s3, BUCKET, many, {
      listPrefix: PREFIX,
      logger: logger(),
    });

    const message = String(warn.mock.calls[0]![0]);
    expect(message).toContain('12 key(s)');
    expect(message).not.toContain(`${PREFIX} (`);
    // Names a bounded sample and says how many it elided, rather than
    // pasting 12 keys into one warning.
    expect(message).toContain(many[0]!);
    expect(message).toContain('and 7 more');
  });

  it('purges a NONCURRENT delete marker (the DeleteMarkers arm)', async () => {
    // Every earlier `DeleteMarkers` fixture carried `IsLatest: true`, so the
    // filter dropped them all and removing the `DeleteMarkers` spread entirely
    // left the suites green. A re-PUT after a delete produces exactly this:
    // the old delete marker becomes NONCURRENT and must go with the bodies.
    const s3 = stub({
      [KEY_A]: [
        {
          Versions: [
            { Key: KEY_A, VersionId: 'v-body', IsLatest: false },
            { Key: KEY_A, VersionId: 'v-repost', IsLatest: true },
          ],
          DeleteMarkers: [{ Key: KEY_A, VersionId: 'dm-old', IsLatest: false }],
        },
      ],
    });

    await purgeNoncurrentKeyVersions(s3, BUCKET, [KEY_A], { logger: logger() });

    expect(deletes()).toEqual([
      [
        { Key: KEY_A, VersionId: 'v-body' },
        { Key: KEY_A, VersionId: 'dm-old' },
      ],
    ]);
  });

  it('leaves an entry whose IsLatest is ABSENT alone (fails CLOSED)', async () => {
    // `=== true` would treat a missing field as "not latest" and delete the
    // CURRENT version. The filter is `!== false` so an absent field is
    // conservative.
    const s3 = stub({
      [KEY_A]: [
        {
          Versions: [
            { Key: KEY_A, VersionId: 'v-unknown' },
            { Key: KEY_A, VersionId: 'v-noncurrent', IsLatest: false },
          ],
        },
      ],
    });

    await purgeNoncurrentKeyVersions(s3, BUCKET, [KEY_A], { logger: logger() });

    expect(deletes()).toEqual([[{ Key: KEY_A, VersionId: 'v-noncurrent' }]]);
  });

  it('terminates when IsTruncated is true but no NextKeyMarker comes back', async () => {
    // Keyed on "either marker present", this spun forever: the next request
    // omits the key marker, S3 ignores a lone VersionIdMarker, the same page
    // returns. An unkillable hang on a path documented as never aborting.
    const s3 = stub({
      [KEY_A]: [
        {
          Versions: [{ Key: KEY_A, VersionId: 'v1', IsLatest: false }],
          IsTruncated: true,
          NextVersionIdMarker: 'v1',
        },
      ],
    });

    await purgeNoncurrentKeyVersions(s3, BUCKET, [KEY_A], { logger: logger() });

    expect(lists()).toHaveLength(1);
  });

  // ---------------------------------------------------------------------
  // Properties that were UNFENCED after the previous round — each of these
  // mutations left the suite green before this block existed.
  // ---------------------------------------------------------------------

  it('COUNTS each Key-less Errors entry, rather than collapsing them', async () => {
    // Collapsing N keyless entries into one map slot reported `1 key(s)` for N
    // failures — the same prefixes-not-keys under-count this change was raised
    // to fix, arriving through the branch that fixed it. "Honest about naming"
    // is not "honest about counting".
    const s3 = stub(
      {
        [KEY_A]: [
          {
            Versions: [
              { Key: KEY_A, VersionId: 'v1', IsLatest: false },
              { Key: KEY_A, VersionId: 'v2', IsLatest: false },
              { Key: KEY_A, VersionId: 'v3', IsLatest: false },
            ],
          },
        ],
      },
      undefined,
      () => ({
        Errors: [
          { VersionId: 'v1', Code: 'InternalError' },
          { VersionId: 'v2', Code: 'InternalError' },
          { VersionId: 'v3', Code: 'InternalError' },
        ],
      })
    );

    await purgeNoncurrentKeyVersions(s3, BUCKET, [KEY_A], { logger: logger() });

    const message = String(warn.mock.calls[0]![0]);
    expect(message).toContain('3 key(s)');
    expect(message).toContain('<unknown key #1>');
    expect(message).toContain('<unknown key #3>');
  });

  it('COUNTS keyless entries across SEPARATE per-key walks', async () => {
    // The counter lived inside `purgeUnderPrefix`, which runs once per prefix,
    // so in per-key mode every walk restarted at 0: two keyless entries on two
    // different keys both wrote `<unknown key #1>`, `recordFailure` appended
    // to the same array, and `failed.size` stayed 1 — reinstating the very
    // `1 key(s)` under-count the slot scheme was added to remove. Unreachable
    // by today's callers (the provider passes one key, gc passes listPrefix),
    // but this is a shared leaf module whose per-key mode is documented and
    // exercised here.
    const s3 = stub(
      {
        [KEY_A]: [{ Versions: [{ Key: KEY_A, VersionId: 'a1', IsLatest: false }] }],
        [KEY_B]: [{ Versions: [{ Key: KEY_B, VersionId: 'b1', IsLatest: false }] }],
      },
      undefined,
      () => ({ Errors: [{ VersionId: 'x', Code: 'InternalError' }] })
    );

    await purgeNoncurrentKeyVersions(s3, BUCKET, [KEY_A, KEY_B], { logger: logger() });

    const message = String(warn.mock.calls[0]![0]);
    expect(message).toContain('2 key(s)');
    expect(message).toContain('<unknown key #1>');
    expect(message).toContain('<unknown key #2>');
  });

  it('blames a truncated listing only on keys UNDER THAT PREFIX', async () => {
    // `wanted` is the FULL requested set, so warning about all of it named
    // keys whose own walks completed — over-warning, and a comment describing
    // something the code did not do.
    const OTHER = 'custom-resource-responses/other/cdkd-9-z.json';
    const s3 = stub({
      [KEY_A]: [
        {
          Versions: [{ Key: KEY_A, VersionId: 'v1', IsLatest: false }],
          IsTruncated: true,
          NextVersionIdMarker: 'v1',
        },
      ],
      [OTHER]: [{ Versions: [], IsTruncated: false }],
    });

    // Per-key mode: two separate walks, only the FIRST one truncates.
    await purgeNoncurrentKeyVersions(s3, BUCKET, [KEY_A, OTHER], { logger: logger() });

    const message = String(warn.mock.calls[0]![0]);
    expect(message).toContain('1 key(s)');
    expect(message).toContain(KEY_A);
    expect(message).not.toContain(OTHER);
  });

  it('a Key-less Errors entry still WARNS instead of vanishing', async () => {
    // Skipping it made `failed.size` 0 when every entry was keyless, so a
    // `DeleteObjects` failure came back as a clean run with no warning at all
    // — this round's own blocker reintroduced inside the branch that fixed it.
    const s3 = stub(
      { [KEY_A]: [{ Versions: [{ Key: KEY_A, VersionId: 'v1', IsLatest: false }] }] },
      undefined,
      () => ({ Errors: [{ VersionId: 'v1', Code: 'InternalError' }] })
    );

    await purgeNoncurrentKeyVersions(s3, BUCKET, [KEY_A], { logger: logger() });

    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0]![0]);
    expect(message).toContain('1 key(s)');
    expect(message).toContain('<unknown key #1>');
    expect(message).toContain('InternalError');
  });

  it('WARNS when a page claims IsTruncated with no NextKeyMarker', async () => {
    // Terminating is right; terminating SILENTLY traded a hang for an
    // unreported partial purge, in the file whose premise is that a quiet
    // failure is the bug.
    const s3 = stub({
      [KEY_A]: [
        {
          Versions: [{ Key: KEY_A, VersionId: 'v1', IsLatest: false }],
          IsTruncated: true,
          NextVersionIdMarker: 'v1',
        },
      ],
    });

    await purgeNoncurrentKeyVersions(s3, BUCKET, [KEY_A], { logger: logger() });

    expect(lists()).toHaveLength(1);
    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0]![0]);
    expect(message).toContain(KEY_A);
    expect(message).toContain('IsTruncated');
    expect(message).toContain('stopped early');
  });

  it('names at most five keys and elides the rest — with the tail only when there IS a rest', async () => {
    // `elided = failed.size - named.length`, so the tail appears from SIX
    // keys, not from two. An unconditional ternary printed `(and 0 more)` on
    // every warning and nothing caught it.
    const keysFor = (n: number): string[] =>
      Array.from({ length: n }, (_, i) => `custom-resource-responses/k${i}.json`);
    const failAll = (): { send: (cmd: unknown) => Promise<unknown> } =>
      stub({}, () => {
        throw new Error('AccessDenied: s3:ListBucketVersions');
      });

    await purgeNoncurrentKeyVersions(failAll(), BUCKET, keysFor(5), {
      listPrefix: 'custom-resource-responses/',
      logger: logger(),
    });
    const atFive = String(warn.mock.calls[0]![0]);
    expect(atFive).toContain('5 key(s)');
    expect(atFive).not.toContain('more)');

    warn.mockClear();
    recorded = [];
    await purgeNoncurrentKeyVersions(failAll(), BUCKET, keysFor(7), {
      listPrefix: 'custom-resource-responses/',
      logger: logger(),
    });
    const atSeven = String(warn.mock.calls[0]![0]);
    expect(atSeven).toContain('7 key(s)');
    expect(atSeven).toContain('(and 2 more)');
  });

  it('SANITIZES the key it names, which is attacker-influenceable text', async () => {
    // The key embeds a stack name and a region that reached cdkd from an S3
    // listing or a lock body, and this warning is the helper's only output. It
    // was the one raw path: `lock-manager.ts` sanitizes the same value at its
    // own call site, so the wrapper's message was safe while the helper's was
    // not -- and issue #2346 site 5 made this one newly reachable at `warn` on
    // the force-unlock and takeover arms.
    const nasty = 'cdkd/ev\u0000il\u001b[31m/us-east-1/lock.json';
    const s3 = stub(
      { [nasty]: [{ Versions: [{ Key: nasty, VersionId: 'v1', IsLatest: false }] }] },
      undefined,
      () => ({
        Errors: [
          { Key: nasty, VersionId: 'v1', Code: 'AccessDenied\u001b[0m', Message: 'de\u0000nied' },
        ],
      })
    );

    await purgeNoncurrentKeyVersions(s3, BUCKET, [nasty], { logger: logger() });

    const message = String(warn.mock.calls[0]![0]);
    // The EXACT sanitized rendering, not two negative literals: `not.toContain`
    // pairs also pass when the sanitizer returns '' or strips one escape and
    // leaves another, so they fence far less than they appear to.
    // The REASON is AWS-supplied text too, so it must be sanitized alongside the
    // key. Asserting only a clean reason cannot tell whole-entry sanitization
    // from key-only -- the two render identically when the reason has nothing
    // to escape, and the weaker form passed until this fixture made the reason
    // dirty as well.
    expect(message).toContain(displaySafe(`${nasty} (version v1: AccessDenied\u001b[0m - de\u0000nied)`));
    // ...and the raw forms really are gone.
    expect(message).not.toContain('\u001b[31m');
    expect(message).not.toContain('\u0000');
  });

  it('sanitizes the BUCKET in the failure warning, like the keys beside it', async () => {
    // The line already renders attacker-influenced KEY names through
    // `displaySafe`. One raw interpolation in a string whose other half is
    // sanitized is the mixed-rendering shape that lets an escape fire from the
    // unsanitized occurrence -- the same defect the replication warning one
    // module over was corrected for.
    const nastyBucket = 'cdkd-state\u001b[31m-000000000000';
    const s3 = stub(
      { [KEY_A]: [{ Versions: [{ Key: KEY_A, VersionId: 'v1', IsLatest: false }] }] },
      undefined,
      () => ({ Errors: [{ Key: KEY_A, VersionId: 'v1', Code: 'AccessDenied' }] })
    );

    await purgeNoncurrentKeyVersions(s3, nastyBucket, [KEY_A], { logger: logger() });

    const message = String(warn.mock.calls[0]![0]);
    expect(message).toContain(`s3://${displaySafe(nastyBucket, { asciiOnly: true })}`);
    expect(message).not.toContain(nastyBucket);
  });

  it('accumulates MULTIPLE reasons for one key', async () => {
    // Nothing gave a key two reasons, so `existing.push` and the `join('; ')`
    // were both dead code.
    const s3 = stub(
      {
        [KEY_A]: [
          {
            Versions: [
              { Key: KEY_A, VersionId: 'v1', IsLatest: false },
              { Key: KEY_A, VersionId: 'v2', IsLatest: false },
            ],
          },
        ],
      },
      undefined,
      () => ({
        Errors: [
          { Key: KEY_A, VersionId: 'v1', Code: 'AccessDenied' },
          { Key: KEY_A, VersionId: 'v2', Code: 'SlowDown' },
        ],
      })
    );

    await purgeNoncurrentKeyVersions(s3, BUCKET, [KEY_A], { logger: logger() });

    const message = String(warn.mock.calls[0]![0]);
    // ONE key, TWO reasons, joined.
    expect(message).toContain('1 key(s)');
    expect(message).toContain('AccessDenied');
    expect(message).toContain('SlowDown');
    expect(message).toMatch(/v1[^,]*AccessDenied.*;.*v2[^,]*SlowDown/);
  });
  /**
   * Issue [#2447](https://github.com/go-to-k/cdkd/issues/2447) — the purge
   * ends by asking whether the bucket is REPLICATED, because a clean purge on
   * a replicated bucket leaves every body readable in the destination and is
   * the case the user is actively misled by.
   *
   * The detector's own behaviour is pinned in
   * `tests/unit/state/s3-replication-purge-gap.test.ts`; what is pinned HERE
   * is that the purge asks at all, on the SUCCESS path, and warns through the
   * CALLER's sink (which is what lets `lock-manager.ts` demote it).
   */
  describe('S3 replication caveat (issue #2447)', () => {
    const replicated = (
      pages: Record<string, ListPage[]>,
      config: unknown,
      onDelete?: (objects: { Key?: string; VersionId?: string }[]) => unknown
    ): { send: (cmd: unknown) => Promise<unknown> } => {
      const inner = stub(pages, undefined, onDelete);
      return {
        send: (cmd: unknown) => {
          if ((cmd as { constructor: { name: string } }).constructor.name ===
            'GetBucketReplicationCommand') {
            // Recorded by the shared stub before we answer, so the command
            // stream assertions below still see it.
            void inner.send(cmd);
            return Promise.resolve(config);
          }
          return inner.send(cmd);
        },
      };
    };

    const onePage: Record<string, ListPage[]> = {
      [KEY_A]: [{ Versions: [{ Key: KEY_A, VersionId: 'a1', IsLatest: false }] }],
    };

    it('WARNS through the CALLER\'s sink after a fully successful purge', async () => {
      const s3 = replicated(onePage, {
        ReplicationConfiguration: {
          Rules: [
            {
              Status: 'Enabled',
              Filter: { Prefix: 'custom-resource-responses/' },
              Destination: { Bucket: 'arn:aws:s3:::cdkd-state-replica' },
            },
          ],
        },
      });

      await purgeNoncurrentKeyVersions(s3, BUCKET, [KEY_A], {
        logger: logger(),
        objectDescription: 'a custom-resource response object',
      });

      // The purge itself SUCCEEDED — nothing failed, so the only warning is
      // the replication caveat. That is the point: it is the caveat on the
      // clean run, not another failure report.
      expect(deletes()).toEqual([[{ Key: KEY_A, VersionId: 'a1' }]]);
      expect(warn).toHaveBeenCalledTimes(1);
      const message = String(warn.mock.calls[0]![0]);
      expect(message).toContain('cdkd-state-replica');
      expect(message).toContain('a custom-resource response object');
      expect(message).toContain('NEVER replicates a version-id delete');
    });

    it('passes the SHARED default description through to the replication warning', async () => {
      // `DEFAULT_PURGED_OBJECT_DESCRIPTION` lives in the gap module and is read
      // by BOTH warnings; its own JSDoc says one definition is what stops the
      // two drifting, and until now only the gap side was fenced.
      const s3 = replicated(
        { [KEY_A]: [{ Versions: [{ Key: KEY_A, VersionId: 'a1', IsLatest: false }] }] },
        {
          ReplicationConfiguration: {
            Rules: [
              { Status: 'Enabled', Destination: { Bucket: 'arn:aws:s3:::cdkd-state-replica' } },
            ],
          },
        },
        () => ({ Errors: [{ Key: KEY_A, VersionId: 'a1', Code: 'SlowDown' }] })
      );

      // No `objectDescription` -- the fallback is what is under test, and it
      // must be the SHARED constant on BOTH messages: the purge's own failure
      // warning and the replication caveat.
      await purgeNoncurrentKeyVersions(s3, BUCKET, [KEY_A], { logger: logger() });

      expect(warn).toHaveBeenCalledTimes(2);
      expect(String(warn.mock.calls[0]![0])).toContain('Could not purge noncurrent versions');
      expect(String(warn.mock.calls[0]![0])).toContain(DEFAULT_PURGED_OBJECT_DESCRIPTION);
      expect(String(warn.mock.calls[1]![0])).toContain(DEFAULT_PURGED_OBJECT_DESCRIPTION);
    });

    it('does NOT probe at all when the walk found nothing to purge', async () => {
      // The scoping that matters most. `deleteRollbackJournal` fires on EVERY
      // successful deploy, journal or not: probing unconditionally made a
      // routine green deploy of a stack that has never failed announce that
      // the journal's copies "survive and remain readable" in the replica,
      // about an object that had never existed in either bucket. A warning
      // that is sometimes about nothing is how the one that matters stops
      // being read — and the API call is saved on the common path too.
      const s3 = replicated(
        { [KEY_A]: [{ DeleteMarkers: [{ Key: KEY_A, VersionId: 'dm', IsLatest: true }] }] },
        {
          ReplicationConfiguration: {
            Rules: [
              { Status: 'Enabled', Destination: { Bucket: 'arn:aws:s3:::cdkd-state-replica' } },
            ],
          },
        }
      );

      await purgeNoncurrentKeyVersions(s3, BUCKET, [KEY_A], { logger: logger() });

      expect(deletes()).toEqual([]);
      expect(recorded.map((c) => c.name)).toEqual(['ListObjectVersionsCommand']);
      expect(warn).not.toHaveBeenCalled();
    });

    it('does NOT probe when the only thing purged was a DELETE MARKER', async () => {
      // The steady state of `deleteRollbackJournal`, which writes a marker on
      // every successful deploy even when no journal exists: deploy 2 finds
      // deploy 1's marker NONCURRENT and removes it. A marker has no body, so
      // counting it as "purged" reinstated the very warning the scoping fix
      // removed -- announcing a surviving rollback journal for a stack that
      // has never had one -- from the second deploy onward.
      const s3 = replicated(
        {
          [KEY_A]: [
            {
              DeleteMarkers: [
                { Key: KEY_A, VersionId: 'dm-2', IsLatest: true },
                { Key: KEY_A, VersionId: 'dm-1', IsLatest: false },
              ],
            },
          ],
        },
        {
          ReplicationConfiguration: {
            Rules: [
              { Status: 'Enabled', Destination: { Bucket: 'arn:aws:s3:::cdkd-state-replica' } },
            ],
          },
        }
      );

      await purgeNoncurrentKeyVersions(s3, BUCKET, [KEY_A], { logger: logger() });

      // The marker IS removed -- that behaviour is unchanged...
      expect(deletes()).toEqual([[{ Key: KEY_A, VersionId: 'dm-1' }]]);
      // ...and no probe follows it, because no BODY was removed.
      expect(recorded.map((c) => c.name)).toEqual([
        'ListObjectVersionsCommand',
        'DeleteObjectsCommand',
      ]);
      expect(warn).not.toHaveBeenCalled();
    });

    it('DOES probe when the walk stopped early on a TRUNCATED page', async () => {
      // The one unknown-provenance arm REACHABLE against real S3: a page that
      // reports `IsTruncated` with no `NextKeyMarker`. The walk cannot make
      // progress, so what remains under the key is unknown and the replica
      // question stands. Without this the arm is deletable green -- a truncated
      // walk would skip the probe entirely, which is the silently-dead-detector
      // direction.
      const s3 = replicated(
        { [KEY_A]: [{ Versions: [], IsTruncated: true }] },
        {
          ReplicationConfiguration: {
            Rules: [
              { Status: 'Enabled', Destination: { Bucket: 'arn:aws:s3:::cdkd-state-replica' } },
            ],
          },
        }
      );

      await purgeNoncurrentKeyVersions(s3, BUCKET, [KEY_A], { logger: logger() });

      expect(warn).toHaveBeenCalledTimes(2);
      expect(String(warn.mock.calls[0]![0])).toContain('IsTruncated');
      expect(String(warn.mock.calls[1]![0])).toContain('S3 replication is enabled');
    });

    it('DOES probe for a BODY the listing returned without IsLatest', async () => {
      // The entry may be a body we were asked to remove and did not, so the
      // replica question applies to it. Its `hasBody` gate has its own control
      // in the sibling below.
      const s3 = replicated(
        { [KEY_A]: [{ Versions: [{ Key: KEY_A, VersionId: 'v1' }] }] },
        {
          ReplicationConfiguration: {
            Rules: [
              { Status: 'Enabled', Destination: { Bucket: 'arn:aws:s3:::cdkd-state-replica' } },
            ],
          },
        }
      );

      await purgeNoncurrentKeyVersions(s3, BUCKET, [KEY_A], { logger: logger() });

      expect(warn).toHaveBeenCalledTimes(2);
      expect(String(warn.mock.calls[0]![0])).toContain('listing omitted IsLatest');
      expect(String(warn.mock.calls[1]![0])).toContain('S3 replication is enabled');
    });

    it('does NOT probe for a MARKER the listing returned without IsLatest', async () => {
      // The control for the case above, and the delete-marker twin of the
      // no-VersionId pair below: same unreadable listing, but a marker carries
      // no body, so there is nothing for the replica to be holding.
      const s3 = replicated(
        { [KEY_A]: [{ DeleteMarkers: [{ Key: KEY_A, VersionId: 'dm1' }] }] },
        {
          ReplicationConfiguration: {
            Rules: [
              { Status: 'Enabled', Destination: { Bucket: 'arn:aws:s3:::cdkd-state-replica' } },
            ],
          },
        }
      );

      await purgeNoncurrentKeyVersions(s3, BUCKET, [KEY_A], { logger: logger() });

      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]![0])).toContain('listing omitted IsLatest');
      expect(recorded.map((c) => c.name)).not.toContain('GetBucketReplicationCommand');
    });

    it('does NOT probe for a MARKER returned with no VersionId', async () => {
      // The delete-marker twin of "REPORTS a noncurrent BODY ... with no
      // VersionId". Both are reported; only the body reaches the replica
      // question, which is the whole distinction this PR turns on.
      const s3 = replicated(
        { [KEY_A]: [{ DeleteMarkers: [{ Key: KEY_A, IsLatest: false }] }] },
        {
          ReplicationConfiguration: {
            Rules: [
              { Status: 'Enabled', Destination: { Bucket: 'arn:aws:s3:::cdkd-state-replica' } },
            ],
          },
        }
      );

      await purgeNoncurrentKeyVersions(s3, BUCKET, [KEY_A], { logger: logger() });

      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]![0])).toContain('no VersionId');
      expect(recorded.map((c) => c.name)).not.toContain('GetBucketReplicationCommand');
    });

    it('DOES probe when a BODY-bearing key fails to delete', async () => {
      // The positive twin of the marker case below, and the fence for the
      // invariant the delete loop's NOTE states: provenance is decided at
      // LISTING time, so a body-bearing key is in `purged` before any delete
      // runs and a failing delete cannot remove it from the replication check.
      // Without this, moving `purged.add` into the delete SUCCESS path is a
      // fully green mutation -- the body would survive in the replica and cdkd
      // would say nothing about it.
      const s3 = replicated(
        { [KEY_A]: [{ Versions: [{ Key: KEY_A, VersionId: 'a1', IsLatest: false }] }] },
        {
          ReplicationConfiguration: {
            Rules: [
              { Status: 'Enabled', Destination: { Bucket: 'arn:aws:s3:::cdkd-state-replica' } },
            ],
          },
        },
        () => ({ Errors: [{ Key: KEY_A, VersionId: 'a1', Code: 'SlowDown' }] })
      );

      await purgeNoncurrentKeyVersions(s3, BUCKET, [KEY_A], { logger: logger() });

      expect(warn).toHaveBeenCalledTimes(2);
      expect(String(warn.mock.calls[0]![0])).toContain('Could not purge noncurrent versions');
      expect(String(warn.mock.calls[1]![0])).toContain('S3 replication is enabled');
    });

    it('does NOT probe when a marker-only key FAILS to delete', async () => {
      // A throttle deleting yesterday's rollback-journal delete marker must
      // not put the key in front of the replication check. What makes that
      // true is the `hasBody` gate at LISTING time -- a marker never enters
      // `purged`, and a failing delete cannot add it -- not anything in the
      // delete arms, which an earlier revision gated redundantly and which
      // this case was briefly mis-credited to.
      const s3 = replicated(
        {
          [KEY_A]: [
            {
              DeleteMarkers: [
                { Key: KEY_A, VersionId: 'dm-2', IsLatest: true },
                { Key: KEY_A, VersionId: 'dm-1', IsLatest: false },
              ],
            },
          ],
        },
        {
          ReplicationConfiguration: {
            Rules: [
              { Status: 'Enabled', Destination: { Bucket: 'arn:aws:s3:::cdkd-state-replica' } },
            ],
          },
        },
        () => ({ Errors: [{ Key: KEY_A, VersionId: 'dm-1', Code: 'SlowDown' }] })
      );

      await purgeNoncurrentKeyVersions(s3, BUCKET, [KEY_A], { logger: logger() });

      // The failure IS reported...
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]![0])).toContain('Could not purge noncurrent versions');
      // ...and no replication probe follows, because no BODY was at stake.
      expect(recorded.map((c) => c.name)).not.toContain('GetBucketReplicationCommand');
    });

    it('does NOT probe when the whole batch THROWS on a marker-only key', async () => {
      // The other failure shape: `DeleteObjects` rejecting takes out the
      // batch. Same reason as the sibling above -- provenance was decided at
      // listing time, so the marker-only key is absent from `purged` whatever
      // the delete does.
      const s3 = replicated(
        {
          [KEY_A]: [
            {
              DeleteMarkers: [
                { Key: KEY_A, VersionId: 'dm-2', IsLatest: true },
                { Key: KEY_A, VersionId: 'dm-1', IsLatest: false },
              ],
            },
          ],
        },
        {
          ReplicationConfiguration: {
            Rules: [
              { Status: 'Enabled', Destination: { Bucket: 'arn:aws:s3:::cdkd-state-replica' } },
            ],
          },
        },
        () => {
          throw new Error('AccessDenied: s3:DeleteObjectVersion');
        }
      );

      await purgeNoncurrentKeyVersions(s3, BUCKET, [KEY_A], { logger: logger() });

      expect(warn).toHaveBeenCalledTimes(1);
      expect(recorded.map((c) => c.name)).not.toContain('GetBucketReplicationCommand');
    });

    it('REPORTS a noncurrent BODY the listing returned with no VersionId, and probes for it', async () => {
      // Unreachable against real S3, which always populates the field -- and
      // that is exactly why it must record rather than be assumed away. Before
      // this it was a bare `continue`: a body cdkd was asked to remove, did not
      // remove, and said nothing about, while the run reported success.
      const s3 = replicated(
        { [KEY_A]: [{ Versions: [{ Key: KEY_A, IsLatest: false }] }] },
        {
          ReplicationConfiguration: {
            Rules: [
              { Status: 'Enabled', Destination: { Bucket: 'arn:aws:s3:::cdkd-state-replica' } },
            ],
          },
        }
      );

      await purgeNoncurrentKeyVersions(s3, BUCKET, [KEY_A], { logger: logger() });

      // Nothing could be deleted -- there was no id to name.
      expect(deletes()).toEqual([]);
      expect(warn).toHaveBeenCalledTimes(2);
      expect(String(warn.mock.calls[0]![0])).toContain('no VersionId');
      // ...and it is a BODY, so the replica question applies to it.
      expect(String(warn.mock.calls[1]![0])).toContain('S3 replication is enabled');
    });

    it('DOES probe for a key the LISTING could not settle', async () => {
      // A key whose LISTING failed is one whose provenance we genuinely do not
      // know -- the walk never returned, so we cannot say whether it had a body
      // -- and over-warning is the safe direction there. Without this case the
      // `unsettledBodies` union is deletable green, since the only other
      // failing-purge case fails at DeleteObjects, i.e. AFTER the key was
      // already marked purged. (The synthetic `<unknown key #N>` slots cannot
      // reach the check at all: `unsettledBodies` is built from real keys, so
      // that is a property of the construction rather than of a filter a test
      // would have to fence.)
      const inner = stub({}, () => {
        throw new Error('AccessDenied: s3:ListBucketVersions');
      });
      const s3 = {
        send: (cmd: unknown) => {
          if (
            (cmd as { constructor: { name: string } }).constructor.name ===
            'GetBucketReplicationCommand'
          ) {
              const input = (cmd as { input: { Bucket?: string; ExpectedBucketOwner?: string } })
              .input;
            // Read off the COMMAND, not hard-coded: a probe sent for the wrong
            // bucket would otherwise be invisible here.
            recorded.push({
              name: 'GetBucketReplicationCommand',
              bucket: input.Bucket,
              prefix: undefined,
              keyMarker: undefined,
              versionIdMarker: undefined,
              owner: input.ExpectedBucketOwner,
              objects: undefined,
            });
            return Promise.resolve({
              ReplicationConfiguration: {
                Rules: [
                  { Status: 'Enabled', Destination: { Bucket: 'arn:aws:s3:::cdkd-state-replica' } },
                ],
              },
            });
          }
          return inner.send(cmd);
        },
      };

      await purgeNoncurrentKeyVersions(s3, BUCKET, [KEY_A], { logger: logger() });

      const probe = recorded.find((c) => c.name === 'GetBucketReplicationCommand');
      expect(probe).toBeDefined();
      expect(probe!.bucket).toBe(BUCKET);
      expect(warn).toHaveBeenCalledTimes(2);
      expect(String(warn.mock.calls[0]![0])).toContain('Could not purge noncurrent versions');
      expect(String(warn.mock.calls[1]![0])).toContain('S3 replication is enabled');
    });

    it('stays SILENT when the bucket has no replication configuration', async () => {
      // The inverted polarity. S3 answers "not configured" with an ERROR, so
      // this arm is also the one that proves the detector does not read its
      // own ordinary answer as a reason to warn.
      const notFound = new Error('ReplicationConfigurationNotFoundError: none');
      notFound.name = 'ReplicationConfigurationNotFoundError';
      const s3 = replicated(onePage, undefined);
      const wrapped = {
        send: (cmd: unknown) => {
          if ((cmd as { constructor: { name: string } }).constructor.name ===
            'GetBucketReplicationCommand') {
            return Promise.reject(notFound);
          }
          return s3.send(cmd);
        },
      };

      await purgeNoncurrentKeyVersions(wrapped, BUCKET, [KEY_A], { logger: logger() });

      expect(deletes()).toEqual([[{ Key: KEY_A, VersionId: 'a1' }]]);
      expect(warn).not.toHaveBeenCalled();
    });

    it('still asks even when the purge FAILED, and keeps both warnings', async () => {
      // A failed purge does not make the replica question moot — the replica
      // holds the bodies either way, and the two warnings answer different
      // questions ("what could cdkd not do" vs "what can cdkd never do").
      const s3 = replicated(onePage, {
        ReplicationConfiguration: {
          Rules: [
            {
              Status: 'Enabled',
              Destination: { Bucket: 'arn:aws:s3:::cdkd-state-replica' },
            },
          ],
        },
      });
      const failing = {
        send: (cmd: unknown) => {
          if ((cmd as { constructor: { name: string } }).constructor.name ===
            'DeleteObjectsCommand') {
            void s3.send(cmd);
            return Promise.reject(new Error('AccessDenied: s3:DeleteObjectVersion'));
          }
          return s3.send(cmd);
        },
      };

      await purgeNoncurrentKeyVersions(failing, BUCKET, [KEY_A], { logger: logger() });

      expect(warn).toHaveBeenCalledTimes(2);
      // Failure report FIRST, caveat second.
      expect(String(warn.mock.calls[0]![0])).toContain('Could not purge noncurrent versions');
      expect(String(warn.mock.calls[1]![0])).toContain('S3 replication is enabled');
    });
  });
});
