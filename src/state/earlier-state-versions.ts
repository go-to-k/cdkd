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
