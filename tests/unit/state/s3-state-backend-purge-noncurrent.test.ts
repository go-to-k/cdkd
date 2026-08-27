import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

/**
 * Issue [#2340](https://github.com/go-to-k/cdkd/issues/2340) —
 * `S3StateBackend.purgeNoncurrentVersions`, tested DIRECTLY.
 *
 * This method had no coverage at all when review found it: the `cdkd gc` suite
 * stubs the whole backend away, and the helper suite calls the free function.
 * Nothing executed the body, so deleting BOTH `await this.ensureClientForBucket()`
 * and `requestFields: await this.ownerParam()` left the full suite green — the
 * `gc` purge silently losing region correction for a cross-region state bucket,
 * and losing the `ExpectedBucketOwner` name-squatting defence every other
 * state-bucket call carries, were both invisible.
 *
 * The sharing fence's `toContain('purgeNoncurrentKeyVersions')` is a substring
 * check that BOTH those mutations survive, so it is not a substitute for this.
 */

const mockRebuild = vi.hoisted(() => vi.fn());
const mockExpectedOwner = vi.hoisted(() => vi.fn());
const warnSpy = vi.hoisted(() => vi.fn());

vi.mock('../../../src/utils/bucket-region-client.js', () => ({
  rebuildClientForBucketRegion: mockRebuild,
}));

vi.mock('../../../src/utils/expected-bucket-owner.js', () => ({
  expectedOwnerParam: mockExpectedOwner,
}));

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
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  };
});

import { S3StateBackend } from '../../../src/state/s3-state-backend.js';
import type { S3Client } from '@aws-sdk/client-s3';

const BUCKET = 'cdkd-state-123456789012';
const KEY = 'custom-resource-responses/cdkd-1756000000000-a1b2c3.json';
const OWNER = '123456789012';

interface Recorded {
  client: 'original' | 'corrected';
  name: string;
  owner: string | undefined;
  prefix: string | undefined;
  objects: { Key?: string; VersionId?: string }[] | undefined;
}

describe('S3StateBackend.purgeNoncurrentVersions (issue #2340)', () => {
  let recorded: Recorded[];

  const makeSend =
    (label: 'original' | 'corrected') =>
    (cmd: unknown): Promise<unknown> => {
      const c = cmd as {
        constructor: { name: string };
        input: {
          ExpectedBucketOwner?: string;
          Prefix?: string;
          Delete?: { Objects?: { Key?: string; VersionId?: string }[] };
        };
      };
      recorded.push({
        client: label,
        name: c.constructor.name,
        owner: c.input.ExpectedBucketOwner,
        prefix: c.input.Prefix,
        objects: c.input.Delete?.Objects,
      });
      if (c.constructor.name === 'ListObjectVersionsCommand') {
        return Promise.resolve({
          Versions: [{ Key: KEY, VersionId: 'v-body', IsLatest: false }],
          IsTruncated: false,
        });
      }
      return Promise.resolve({});
    };

  const originalClient = (): S3Client =>
    ({ send: makeSend('original'), destroy: vi.fn() }) as unknown as S3Client;
  const correctedClient = (): S3Client =>
    ({ send: makeSend('corrected'), destroy: vi.fn() }) as unknown as S3Client;

  beforeEach(() => {
    recorded = [];
    mockRebuild.mockReset();
    mockExpectedOwner.mockReset();
    warnSpy.mockReset();
    mockExpectedOwner.mockResolvedValue({ ExpectedBucketOwner: OWNER });
  });

  const backend = (): S3StateBackend =>
    new S3StateBackend(originalClient(), { bucket: BUCKET, prefix: 'cdkd' });

  it('routes the purge through the REGION-CORRECTED client', async () => {
    // The state bucket can live in a different region than the CLI's. Every
    // other state-bucket call goes through `ensureClientForBucket()`; dropping
    // it here would send the purge to the wrong endpoint.
    mockRebuild.mockResolvedValue(correctedClient());

    await backend().purgeNoncurrentVersions([KEY]);

    expect(mockRebuild).toHaveBeenCalledTimes(1);
    expect(mockRebuild).toHaveBeenCalledWith(
      expect.anything(),
      BUCKET,
      expect.objectContaining({ destroyOldClient: true })
    );
    expect(recorded.length).toBeGreaterThan(0);
    expect(recorded.every((r) => r.client === 'corrected')).toBe(true);
    expect(recorded.map((r) => r.name)).toEqual([
      'ListObjectVersionsCommand',
      'DeleteObjectsCommand',
    ]);
  });

  it('keeps the original client when no rebuild is needed', async () => {
    mockRebuild.mockResolvedValue(null);

    await backend().purgeNoncurrentVersions([KEY]);

    expect(recorded.every((r) => r.client === 'original')).toBe(true);
    expect(recorded.map((r) => r.name)).toEqual([
      'ListObjectVersionsCommand',
      'DeleteObjectsCommand',
    ]);
  });

  it('threads ExpectedBucketOwner onto EVERY command', async () => {
    // The name-squatting defence: a foreign bucket at cdkd's predictable name
    // that ALLOWS this account would otherwise silently receive the calls.
    mockRebuild.mockResolvedValue(null);

    await backend().purgeNoncurrentVersions([KEY]);

    expect(recorded).toHaveLength(2);
    expect(recorded.every((r) => r.owner === OWNER)).toBe(true);
  });

  it('forwards listPrefix and purges the requested key', async () => {
    mockRebuild.mockResolvedValue(null);

    await backend().purgeNoncurrentVersions([KEY], {
      listPrefix: 'custom-resource-responses/',
    });

    const list = recorded.find((r) => r.name === 'ListObjectVersionsCommand');
    expect(list?.prefix).toBe('custom-resource-responses/');
    const del = recorded.find((r) => r.name === 'DeleteObjectsCommand');
    expect(del?.objects).toEqual([{ Key: KEY, VersionId: 'v-body' }]);
  });

  it('sends nothing for an empty key list', async () => {
    mockRebuild.mockResolvedValue(null);
    await backend().purgeNoncurrentVersions([]);
    expect(recorded).toEqual([]);
    expect(mockRebuild).not.toHaveBeenCalled();
  });

  it('NEVER THROWS when the client rebuild itself fails, and warns instead', async () => {
    // `ensureClientForBucket()` reaches AWS (`GetBucketLocation`) and sits
    // OUTSIDE the shared helper's never-throw guarantee. Before the wrap, this
    // rejection escaped at gc's call site and skipped its `✓ Deleted ...` line
    // after the delete had already succeeded.
    mockRebuild.mockRejectedValue(new Error('AccessDenied: s3:GetBucketLocation'));

    await expect(backend().purgeNoncurrentVersions([KEY])).resolves.toBeUndefined();

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const message = String(warnSpy.mock.calls[0]![0]);
    expect(message).toContain(BUCKET);
    expect(message).toContain('s3:ListBucketVersions');
    expect(message).toContain('s3:DeleteObjectVersion');
    expect(message).toContain('AccessDenied: s3:GetBucketLocation');
  });

  it('the warn counts the KEYS it was given', async () => {
    // The SECOND emitter of the property round 1 raised as a blocker
    // ("counts prefixes, not keys") was itself unfenced: hardcoding this
    // count to 1 left all seven cases green.
    mockRebuild.mockRejectedValue(new Error('AccessDenied: s3:GetBucketLocation'));

    await backend().purgeNoncurrentVersions([KEY, `${KEY}.2`, `${KEY}.3`]);

    expect(String(warnSpy.mock.calls[0]![0])).toContain('3 key(s)');
  });

  it('NEVER THROWS when the owner-param lookup fails', async () => {
    mockRebuild.mockResolvedValue(null);
    mockExpectedOwner.mockRejectedValue(new Error('no credentials'));

    await expect(backend().purgeNoncurrentVersions([KEY])).resolves.toBeUndefined();

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0]![0])).toContain('no credentials');
  });
});
