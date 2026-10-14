import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { clearReplicationProbeCache } from '../../../src/state/s3-replication-purge-gap.js';

/**
 * go-to-k/cdkd#2346 sites 1-3: `S3StateBackend.purgeDeletedStateHistory`,
 * which `cdkd state destroy` alone runs (through the destroy runner) after
 * `deleteState`, deletes the record's EARLIER versions.
 *
 * The discriminator throughout is which version ids reach a `DeleteObjects`
 * batch: `deleteState` alone purges only the rollback journal, so a state
 * key's id there is the purge's work. Listings are NOT a discriminator: the
 * legacy key is listed to decide whether to warn, purged or not.
 */

vi.mock('../../../src/utils/bucket-region-client.js', () => ({
  rebuildClientForBucketRegion: vi.fn().mockResolvedValue(null),
}));

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

const BUCKET = 'cdkd-state-999999999999';
const STACK = 'CdkdStateDestroyPurge';
const REGION = 'us-east-1';
const OTHER_REGION = 'eu-west-1';
const STATE_KEY = `cdkd/${STACK}/${REGION}/state.json`;
const OTHER_STATE_KEY = `cdkd/${STACK}/${OTHER_REGION}/state.json`;
const LEGACY_KEY = `cdkd/${STACK}/state.json`;
const JOURNAL_KEY = `cdkd/${STACK}/${REGION}/rollback-journal.json`;

interface Sent {
  name: string;
  input: {
    Key?: string;
    Prefix?: string;
    Delimiter?: string;
    Delete?: { Objects?: { Key?: string; VersionId?: string }[] };
  };
}

/** Per-key version listing: two noncurrent bodies plus the current marker. */
const versionsOf = (key: string): unknown => ({
  Versions: [
    { Key: key, VersionId: `${key}#v1`, IsLatest: false },
    { Key: key, VersionId: `${key}#v2`, IsLatest: false },
  ],
  DeleteMarkers: [{ Key: key, VersionId: `${key}#dm`, IsLatest: true }],
  IsTruncated: false,
});

const accessDenied = (): Error =>
  Object.assign(new Error('Access Denied'), {
    name: 'AccessDenied',
    $metadata: { httpStatusCode: 403 },
  });

const notFound = (): Error =>
  Object.assign(new Error('NotFound'), { name: 'NotFound', $metadata: { httpStatusCode: 404 } });

const EMPTY_LISTING = { Versions: [], DeleteMarkers: [], IsTruncated: false };

type LegacyState = 'absent' | 'denied' | { region?: string };

describe('purgeDeletedStateHistory (go-to-k/cdkd#2346 sites 1-3)', () => {
  let sent: Sent[];
  // Knobs a test flips.
  let legacy: LegacyState;
  let regionPrefixes: (continuationToken?: string) => Promise<unknown>;
  let stateHead: () => Promise<unknown>;
  let listVersions: (prefix: string) => Promise<unknown>;

  const client = (): S3Client =>
    ({
      send: (cmd: unknown): Promise<unknown> => {
        const c = cmd as { constructor: { name: string }; input: Sent['input'] };
        sent.push({ name: c.constructor.name, input: c.input });
        switch (c.constructor.name) {
          case 'DeleteObjectCommand':
            // Stateful: a removed legacy body reads as absent afterwards.
            if (c.input.Key === LEGACY_KEY) legacy = 'absent';
            return Promise.resolve({});
          case 'GetObjectCommand': {
            if (c.input.Key !== LEGACY_KEY) return Promise.resolve({});
            const l = legacy;
            if (l === 'absent') return Promise.reject(new NoSuchKey({ message: 'nope', $metadata: {} }));
            if (l === 'denied') return Promise.reject(accessDenied());
            return Promise.resolve({
              Body: { transformToString: () => Promise.resolve(JSON.stringify(l)) },
            });
          }
          case 'HeadObjectCommand':
            return c.input.Key === STATE_KEY ? stateHead() : Promise.reject(notFound());
          case 'ListObjectVersionsCommand':
            // The region scan is the delimited VERSION listing of the stack
            // prefix; every other version listing is per key.
            if (c.input.Delimiter === '/') {
              return regionPrefixes((c.input as { KeyMarker?: string }).KeyMarker);
            }
            return listVersions(c.input.Prefix ?? '');
          default:
            return Promise.resolve({});
        }
      },
      destroy: vi.fn(),
    }) as unknown as S3Client;

  /** What `cdkd state destroy` does: the delete, then (after the kept write) the purge. */
  const destroyAndPurge = async (): Promise<void> => {
    const backend = new S3StateBackend(client(), { bucket: BUCKET, prefix: 'cdkd' });
    await backend.deleteState(STACK, REGION);
    await backend.purgeDeletedStateHistory(STACK, REGION);
  };

  const purgedIds = (): string[] =>
    sent
      .filter((s) => s.name === 'DeleteObjectsCommand')
      .flatMap((s) => s.input.Delete?.Objects ?? [])
      .map((o) => o.VersionId ?? '');
  const purgedKey = (key: string): boolean => purgedIds().some((id) => id.startsWith(`${key}#`));
  const regionScanned = (): boolean =>
    sent.some((s) => s.name === 'ListObjectVersionsCommand' && s.input.Delimiter === '/');
  const warned = (): string => warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
  const otherRegionListing = (...prefixes: string[]): (() => Promise<unknown>) => () =>
    Promise.resolve({
      CommonPrefixes: prefixes.map((r) => ({ Prefix: `cdkd/${STACK}/${r}/` })),
      IsTruncated: false,
    });

  beforeEach(() => {
    clearReplicationProbeCache();
    sent = [];
    warnSpy.mockReset();
    legacy = 'absent';
    regionPrefixes = otherRegionListing(REGION);
    stateHead = (): Promise<unknown> => Promise.reject(notFound());
    // Every key has history, except another region's record, which has none.
    listVersions = (prefix: string): Promise<unknown> =>
      Promise.resolve(prefix === OTHER_STATE_KEY ? EMPTY_LISTING : versionsOf(prefix));
  });

  it('deleteState alone touches no state.json history (only the journal is purged)', async () => {
    const backend = new S3StateBackend(client(), { bucket: BUCKET, prefix: 'cdkd' });
    await backend.deleteState(STACK, REGION);

    expect(purgedKey(STATE_KEY) || purgedKey(LEGACY_KEY)).toBe(false);
    expect(purgedKey(JOURNAL_KEY)).toBe(true);
    expect(regionScanned()).toBe(false);
  });

  it('purges the region key and the absent legacy key, keeping each current marker', async () => {
    await destroyAndPurge();

    expect(purgedIds()).toEqual(
      expect.arrayContaining([
        `${STATE_KEY}#v1`,
        `${STATE_KEY}#v2`,
        `${LEGACY_KEY}#v1`,
        `${LEGACY_KEY}#v2`,
      ])
    );
    // The current delete marker IS the delete; dropping it would resurrect
    // the newest body as a live record.
    expect(purgedIds().some((id) => id.endsWith('#dm'))).toBe(false);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('skips the region scan when the legacy key has no versions at all', async () => {
    listVersions = (prefix: string): Promise<unknown> =>
      Promise.resolve(prefix === LEGACY_KEY || prefix === OTHER_STATE_KEY ? EMPTY_LISTING : versionsOf(prefix));

    await destroyAndPurge();

    expect(regionScanned()).toBe(false);
    expect(purgedKey(STATE_KEY)).toBe(true);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it.each([
    ['names this region', { region: REGION }],
    ['names no region', {}],
  ])('purges a legacy record this delete removed (its body %s)', async (_what, body) => {
    legacy = body;

    await destroyAndPurge();

    expect(
      sent.some((s) => s.name === 'DeleteObjectCommand' && s.input.Key === LEGACY_KEY)
    ).toBe(true);
    expect(purgedKey(LEGACY_KEY)).toBe(true);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("keeps, and warns about, a legacy key whose body names another region", async () => {
    legacy = { region: OTHER_REGION };

    await destroyAndPurge();

    expect(
      sent.some((s) => s.name === 'DeleteObjectCommand' && s.input.Key === LEGACY_KEY)
    ).toBe(false);
    expect(purgedKey(LEGACY_KEY)).toBe(false);
    expect(purgedKey(STATE_KEY)).toBe(true);
    expect(warned()).toContain('Kept the earlier versions of the legacy state record');
    expect(warned()).toContain('belongs to another record');
  });

  it('keeps the legacy history when the legacy record cannot be read', async () => {
    legacy = 'denied';

    await destroyAndPurge();

    expect(purgedKey(LEGACY_KEY)).toBe(false);
    expect(purgedKey(STATE_KEY)).toBe(true);
  });

  // Review n4: the purge's legacy probe is a SECOND GetObject; a transient
  // failure on it must warn on its own, not rely on the delete's probe.
  it('warns, and purges nothing of the legacy key, when only the second legacy probe fails', async () => {
    legacy = { region: REGION };
    let reads = 0;
    const throttled = (): Error =>
      Object.assign(new Error('Slow Down'), { name: 'SlowDown', $metadata: { httpStatusCode: 503 } });
    const backend = new S3StateBackend(
      {
        send: (cmd: unknown): Promise<unknown> => {
          const c = cmd as { constructor: { name: string }; input: Sent['input'] };
          if (c.constructor.name === 'GetObjectCommand' && c.input.Key === LEGACY_KEY) {
            reads += 1;
            if (reads > 1) {
              sent.push({ name: c.constructor.name, input: c.input });
              return Promise.reject(throttled());
            }
          }
          return client().send(cmd as never);
        },
        destroy: vi.fn(),
      } as unknown as S3Client,
      { bucket: BUCKET, prefix: 'cdkd' }
    );
    await backend.deleteState(STACK, REGION);
    // The first probe read the body (this region's), so the delete was silent.
    expect(warnSpy).not.toHaveBeenCalled();
    // The delete made the body absent; restore a readable one so only the
    // throttle decides the second probe's answer.
    legacy = { region: REGION };
    await backend.purgeDeletedStateHistory(STACK, REGION);

    expect(reads).toBe(2);
    expect(purgedKey(LEGACY_KEY)).toBe(false);
    expect(purgedKey(STATE_KEY)).toBe(true);
    expect(warned()).toContain('Kept the earlier versions of the legacy state record');
    expect(warned()).toContain('could not be read');
  });

  it('keeps the legacy history while another region has a current record', async () => {
    regionPrefixes = otherRegionListing(REGION, OTHER_REGION);
    listVersions = (prefix: string): Promise<unknown> => Promise.resolve(versionsOf(prefix));

    await destroyAndPurge();

    expect(purgedKey(LEGACY_KEY)).toBe(false);
    expect(purgedKey(STATE_KEY)).toBe(true);
    expect(warned()).toContain('another region of the stack still has state record versions');
  });

  // The coordinator's m1 sequence: region B removed by `cdkd destroy`, which
  // KEEPS its history; then `cdkd state destroy` for region A.
  it('keeps the legacy history while another region keeps only an EARLIER record (cdkd destroy kept it)', async () => {
    regionPrefixes = otherRegionListing(REGION, OTHER_REGION);
    // B's key: no current body (a delete marker is current), history intact.
    listVersions = (prefix: string): Promise<unknown> => Promise.resolve(versionsOf(prefix));
    // HEAD on B's key would answer 404 -- the old CURRENT-only rule purged here.

    await destroyAndPurge();

    expect(purgedKey(LEGACY_KEY)).toBe(false);
    expect(purgedKey(OTHER_STATE_KEY)).toBe(false);
    expect(warned()).toContain('another region of the stack still has state record versions');
  });

  // Review M3: a region whose every key sits behind a delete marker has no
  // CURRENT object, so only a version listing names it; its state.json
  // history is exactly what must hold the legacy purge back.
  it('a region whose keys are all behind delete markers still holds the legacy history back', async () => {
    regionPrefixes = otherRegionListing(REGION, OTHER_REGION);
    listVersions = (prefix: string): Promise<unknown> =>
      Promise.resolve(
        prefix === OTHER_STATE_KEY
          ? {
              Versions: [{ Key: prefix, VersionId: 'b-v1', IsLatest: false }],
              DeleteMarkers: [{ Key: prefix, VersionId: 'b-dm', IsLatest: true }],
              IsTruncated: false,
            }
          : versionsOf(prefix)
      );

    await destroyAndPurge();

    // The scan is the version listing; an ordinary listing would miss B.
    expect(sent.some((s) => s.name === 'ListObjectsV2Command')).toBe(false);
    expect(regionScanned()).toBe(true);
    expect(purgedKey(LEGACY_KEY)).toBe(false);
    expect(purgedIds()).not.toContain('b-v1');
    expect(warned()).toContain('another region of the stack still has state record versions');
  });

  it('a region prefix whose state.json has no versions does not hold the legacy history back', async () => {
    regionPrefixes = otherRegionListing(REGION, OTHER_REGION);

    await destroyAndPurge();

    expect(purgedKey(LEGACY_KEY)).toBe(true);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('reads every page of the region listing before deciding no other region has history', async () => {
    regionPrefixes = (token?: string): Promise<unknown> =>
      Promise.resolve(
        token === undefined
          ? {
              CommonPrefixes: [{ Prefix: `cdkd/${STACK}/${REGION}/` }],
              IsTruncated: true,
              NextKeyMarker: `cdkd/${STACK}/${REGION}/state.json`,
              NextVersionIdMarker: 'v-last',
            }
          : { CommonPrefixes: [{ Prefix: `cdkd/${STACK}/${OTHER_REGION}/` }], IsTruncated: false }
      );
    listVersions = (prefix: string): Promise<unknown> => Promise.resolve(versionsOf(prefix));

    await destroyAndPurge();

    expect(purgedKey(LEGACY_KEY)).toBe(false);
    expect(warned()).toContain('another region');
  });

  it('fails closed on the legacy history when the region listing fails', async () => {
    regionPrefixes = (): Promise<unknown> => Promise.reject(accessDenied());

    await destroyAndPurge();

    expect(purgedKey(LEGACY_KEY)).toBe(false);
    expect(purgedKey(STATE_KEY)).toBe(true);
    expect(warned()).toContain('could not list the stack');
  });

  it('a denied version probe of another region keeps the legacy history', async () => {
    regionPrefixes = otherRegionListing(REGION, OTHER_REGION);
    listVersions = (prefix: string): Promise<unknown> =>
      prefix === OTHER_STATE_KEY ? Promise.reject(accessDenied()) : Promise.resolve(versionsOf(prefix));

    await destroyAndPurge();

    expect(purgedKey(LEGACY_KEY)).toBe(false);
    expect(warned()).toContain('another region');
  });

  it.each([
    ['a denied listing', (): Promise<unknown> => Promise.reject(accessDenied())],
    [
      'a truncated listing with no rows',
      (): Promise<unknown> => Promise.resolve({ ...EMPTY_LISTING, IsTruncated: true }),
    ],
  ])('%s of the legacy key counts as history (it is kept and warned about)', async (_w, legacyListing) => {
    regionPrefixes = otherRegionListing(REGION, OTHER_REGION);
    listVersions = (prefix: string): Promise<unknown> =>
      prefix === LEGACY_KEY ? legacyListing() : Promise.resolve(versionsOf(prefix));

    await destroyAndPurge();

    expect(regionScanned()).toBe(true);
    expect(warned()).toContain('Kept the earlier versions of the legacy state record');
  });

  it.each([
    ['the record exists again', (): Promise<unknown> => Promise.resolve({})],
    ['its absence cannot be confirmed', (): Promise<unknown> => Promise.reject(accessDenied())],
  ])('purges nothing when %s', async (_w, head) => {
    stateHead = head;

    await destroyAndPurge();

    expect(purgedKey(STATE_KEY) || purgedKey(LEGACY_KEY)).toBe(false);
    expect(warned()).toContain('Kept the earlier versions of the state record');
  });

  it('a denied purge warns with the grants and never throws', async () => {
    listVersions = (prefix: string): Promise<unknown> =>
      prefix === STATE_KEY ? Promise.reject(accessDenied()) : Promise.resolve(versionsOf(prefix));

    await expect(destroyAndPurge()).resolves.toBeUndefined();

    expect(warned()).toContain('s3:ListBucketVersions');
    expect(warned()).toContain('s3:DeleteObjectVersion');
    expect(warned()).toContain("the stack's state record");
  });
});
