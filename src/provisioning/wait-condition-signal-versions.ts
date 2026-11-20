/**
 * The READ half of the wait-condition signal store (go-to-k/cdkd#6694): the
 * body-bearing versions of one signal key, oldest first. Kept apart from the
 * store, which also DELETES, so the version listing a deleter would otherwise
 * name stays the shared purge's alone (#2340).
 */

import { ListObjectVersionsCommand, type S3Client } from '@aws-sdk/client-s3';
import { LISTING_ENCODING_TYPE, decodeListingKey } from '../utils/s3-listing-keys.js';

export interface SignalVersion {
  versionId: string;
  size: number;
}

export async function listSignalVersions(
  client: S3Client,
  bucket: string,
  key: string,
  owner: { ExpectedBucketOwner?: string }
): Promise<SignalVersion[]> {
  const versions: SignalVersion[] = [];
  let keyMarker: string | undefined;
  let versionIdMarker: string | undefined;
  do {
    const page = await client.send(
      new ListObjectVersionsCommand({
        Bucket: bucket,
        Prefix: key,
        ...owner,
        EncodingType: LISTING_ENCODING_TYPE,
        ...(keyMarker !== undefined && { KeyMarker: keyMarker }),
        ...(versionIdMarker !== undefined && { VersionIdMarker: versionIdMarker }),
      })
    );
    for (const v of page.Versions ?? []) {
      if (typeof v.VersionId !== 'string') continue;
      let listed: string | undefined;
      try {
        listed = decodeListingKey(v.Key);
      } catch {
        continue;
      }
      if (listed === key) versions.push({ versionId: v.VersionId, size: v.Size ?? 0 });
    }
    keyMarker = page.IsTruncated ? decodeListingKey(page.NextKeyMarker) : undefined;
    versionIdMarker = page.IsTruncated ? page.NextVersionIdMarker : undefined;
  } while (keyMarker !== undefined);
  // S3 lists a key's versions newest first.
  return versions.reverse();
}
