import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  purgeNoncurrentKeyVersions,
  type NoncurrentVersionPurgeOptions,
} from '../../../src/state/s3-noncurrent-version-purge.js';

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

    expect(recorded).toHaveLength(2);
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
});
