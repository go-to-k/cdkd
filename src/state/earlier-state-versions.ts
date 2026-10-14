/**
 * go-to-k/cdkd#4705: read a stack record's EARLIER versions (noncurrent
 * versions of its `state.json` on a versioned state bucket). Read-only: it
 * never deletes, so it is not a version purge (`s3-noncurrent-version-purge.ts`
 * owns those).
 */
import { GetObjectCommand, ListObjectVersionsCommand, type S3Client } from '@aws-sdk/client-s3';
import { LISTING_ENCODING_TYPE, decodeListingKey } from '../utils/s3-listing-keys.js';

/** One earlier version of a stack record: its `resources` map, and when it was written. */
export interface EarlierStateRecord {
  resources: Record<string, unknown>;
  /** The version's `LastModified` (epoch ms). */
  writtenAt?: number;
}

/**
 * The `resources` maps of `key`'s newest `max` versions, newest first, read in
 * parallel. A version whose body will not parse as a record is skipped; any
 * request error throws.
 */
export async function readEarlierStateResources(
  s3: S3Client,
  bucket: string,
  owner: { ExpectedBucketOwner?: string },
  key: string,
  max: number
): Promise<EarlierStateRecord[]> {
  const listed = await s3.send(
    new ListObjectVersionsCommand({
      Bucket: bucket,
      ...owner,
      Prefix: key,
      EncodingType: LISTING_ENCODING_TYPE,
      MaxKeys: max + 1,
    })
  );
  const versions = (listed.Versions ?? [])
    .filter((v) => decodeListingKey(v.Key) === key && typeof v.VersionId === 'string')
    .sort((a, b) => (b.LastModified?.getTime() ?? 0) - (a.LastModified?.getTime() ?? 0))
    .slice(0, max);
  const read = await Promise.all(
    versions.map(async (v): Promise<EarlierStateRecord | undefined> => {
      const got = await s3.send(
        new GetObjectCommand({ Bucket: bucket, ...owner, Key: key, VersionId: v.VersionId })
      );
      const body = await got.Body?.transformToString();
      if (body === undefined) return undefined;
      try {
        const parsed = JSON.parse(body) as { resources?: unknown } | null;
        if (parsed === null || typeof parsed.resources !== 'object' || parsed.resources === null) {
          return undefined;
        }
        return {
          resources: parsed.resources as Record<string, unknown>,
          ...(v.LastModified instanceof Date && { writtenAt: v.LastModified.getTime() }),
        };
      } catch {
        // Not a record: proves nothing.
        return undefined;
      }
    })
  );
  return read.filter((r): r is EarlierStateRecord => r !== undefined);
}

/**
 * go-to-k/cdkd#2346: might `key` have any version or delete marker at all?
 * `false` only on a listing that shows none; a failed listing answers `true`,
 * so a warning about kept versions is never suppressed by a denial. Read-only,
 * like the rest of this module: `cdkd state destroy` asks it before warning
 * that it kept a legacy record's history.
 */
export async function keyMayHaveVersions(
  s3: S3Client,
  bucket: string,
  owner: () => Promise<{ ExpectedBucketOwner?: string }>,
  key: string
): Promise<boolean> {
  // `owner` is resolved INSIDE the try: the caller runs after a finished
  // delete and must not see a rejection from here.
  try {
    const listed = await s3.send(
      new ListObjectVersionsCommand({
        Bucket: bucket,
        ...(await owner()),
        Prefix: key,
        EncodingType: LISTING_ENCODING_TYPE,
        MaxKeys: 1,
      })
    );
    // Any row at all: an exact-key row is history, and a row for a longer key
    // sharing the prefix proves nothing either way, so it counts.
    const rows = (listed.Versions ?? []).length + (listed.DeleteMarkers ?? []).length;
    return rows > 0 || listed.IsTruncated === true;
  } catch {
    return true;
  }
}

/**
 * go-to-k/cdkd#2346: the next-level directory names under `prefix` (which
 * must end in `/`) that hold ANY version or delete marker, every page. A
 * version listing rather than `ListObjectsV2`, which lists current objects
 * only and so misses a directory whose keys all sit behind delete markers --
 * exactly a removed region whose `state.json` history is still kept. Errors
 * propagate; the caller treats a failed scan as "unknown".
 */
export async function listVersionedSubdirectories(
  s3: S3Client,
  bucket: string,
  owner: () => Promise<{ ExpectedBucketOwner?: string }>,
  prefix: string
): Promise<string[]> {
  const out: string[] = [];
  let keyMarker: string | undefined;
  let versionIdMarker: string | undefined;
  for (;;) {
    const listed = await s3.send(
      new ListObjectVersionsCommand({
        Bucket: bucket,
        ...(await owner()),
        Prefix: prefix,
        Delimiter: '/',
        EncodingType: LISTING_ENCODING_TYPE,
        ...(keyMarker !== undefined && { KeyMarker: keyMarker }),
        ...(versionIdMarker !== undefined && { VersionIdMarker: versionIdMarker }),
      })
    );
    for (const cp of listed.CommonPrefixes ?? []) {
      const decoded = decodeListingKey(cp.Prefix);
      if (decoded === undefined || !decoded.startsWith(prefix)) continue;
      const segment = decoded.slice(prefix.length).replace(/\/$/, '');
      if (segment !== '') out.push(segment);
    }
    if (listed.IsTruncated !== true) return out;
    // A truncated page without a marker would loop forever on the same page.
    if (listed.NextKeyMarker === undefined) {
      throw new Error('a truncated version listing returned no NextKeyMarker');
    }
    keyMarker = decodeListingKey(listed.NextKeyMarker);
    versionIdMarker = listed.NextVersionIdMarker;
  }
}
