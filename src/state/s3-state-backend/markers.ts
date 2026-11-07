/**
 * The bucket-level markers: `retained.json`, the refactor marker and the stack registry markers.
 *
 * Moved verbatim out of `src/state/s3-state-backend.ts` (go-to-k/cdkd#5835); the
 * `S3StateBackend` class keeps one `f.call(this, ...)` delegator per moved method.
 */
import type { S3StateBackend } from '../s3-state-backend.js';
import {
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
} from '@aws-sdk/client-s3';
import { CrossPrefixReadError, isNotImplemented } from '../cross-prefix-stack-scan.js';
import { RetainedTimeUnconfirmedError } from '../retained-time.js';
import {
  KEPT_AT_CLOCK_TOLERANCE_MS,
  type RetainedResource,
  parseRetainedResources,
  registryMarkerPrefix,
  isConditionalConflict,
  isConditionFailure,
  isNoSuchKey,
} from './shared.js';

/**
 * The resources a destroy of this stack under THIS prefix kept
 * (`DeletionPolicy: Retain`) that a later create of the same stack here may
 * take back by name (go-to-k/cdkd#4705). A sibling of `state.json` that a
 * destroy does not delete. `[]` when there is none. A body that will not read
 * as such a record throws, naming the key.
 */
export async function loadRetainedResources(
  this: S3StateBackend,
  stackName: string,
  region: string
): Promise<RetainedResource[]> {
  return (await this.loadRetainedRecord(stackName, region)) ?? [];
}

/**
 * As {@link loadRetainedResources}, but `null` when there is NO record at
 * all -- a stack this cdkd never destroyed or orphaned here, the only case
 * in which an older cdkd's history may still license a kept resource. An
 * empty record (`[]`) is the tombstone `state orphan` and a destroy that
 * kept nothing write (go-to-k/cdkd#4705 review D-1).
 */
export async function loadRetainedRecord(
  this: S3StateBackend,
  stackName: string,
  region: string
): Promise<RetainedResource[] | null> {
  const key = this.getRetainedKey(stackName, region);
  let body: string | null;
  try {
    body = await this.getRawObject(key);
  } catch (error) {
    throw new CrossPrefixReadError(key, error);
  }
  if (body === null) return null;
  const entries = parseRetainedResources(body);
  if (entries === undefined) {
    throw new CrossPrefixReadError(
      key,
      Object.assign(new Error('not a retained-resource record'), { name: 'MalformedRecord' })
    );
  }
  return entries;
}

/**
 * go-to-k/cdkd#4705 review P3: write the empty retained-resource record
 * (the tombstone) only when there is none, in ONE conditional write
 * (`If-None-Match: *`); an existing record is left as it is. An endpoint
 * without conditional writes falls back to a read, then the write. Errors
 * throw.
 */
export async function ensureRetainedTombstone(
  this: S3StateBackend,
  stackName: string,
  region: string
): Promise<void> {
  await this.ensureClientForBucket();
  const key = this.getRetainedKey(stackName, region);
  const put = async (): Promise<unknown> =>
    this.s3Client.send(
      new PutObjectCommand({
        Bucket: this.config.bucket,
        ...(await this.ownerParam()),
        Key: key,
        Body: JSON.stringify({ retainedVersion: 1, resources: [] }),
        ContentType: 'application/json',
        IfNoneMatch: '*',
      })
    );
  try {
    try {
      await put();
    } catch (error) {
      // Review S-4: 409 ConditionalRequestConflict is a concurrent write
      // in flight, not "a record exists": asked once more, it answers.
      if (!isConditionalConflict(error)) throw error;
      await put();
    }
  } catch (error) {
    if (isConditionFailure(error) && !isConditionalConflict(error)) return;
    if (!isNotImplemented(error)) throw error;
    if ((await this.loadRetainedRecord(stackName, region)) === null) {
      await this.saveRetainedResources(stackName, region, []);
    }
  }
}

/**
 * Replace the stack's retained-resource record with `entries`. An empty list
 * is written, not deleted: it is the tombstone that ends the history license
 * (go-to-k/cdkd#4705 review D-1). Errors throw.
 */
export async function saveRetainedResources(
  this: S3StateBackend,
  stackName: string,
  region: string,
  entries: readonly RetainedResource[]
): Promise<void> {
  await this.ensureClientForBucket();
  const key = this.getRetainedKey(stackName, region);
  const put = (resources: readonly RetainedResource[]) =>
    this.ownerParam().then((owner) =>
      this.s3Client.send(
        new PutObjectCommand({
          Bucket: this.config.bucket,
          ...owner,
          Key: key,
          Body: JSON.stringify({ retainedVersion: 1, resources }),
          ContentType: 'application/json',
        })
      )
    );
  const fresh = new Set(entries.filter((e) => e.keptAt === undefined));
  // A new entry is written with this machine's clock (review F-1): a crash
  // or a failure before the S3 stamp below then leaves a skewed bound,
  // never no bound at all.
  const provisional = Date.now();
  await put(entries.map((e) => (fresh.has(e) ? { ...e, keptAt: provisional } : e)));
  if (fresh.size === 0) return;
  // Then S3's own clock (review E-8): the time of the write that recorded
  // it, read back from the object. A holder created later is not the
  // resource kept. Re-written only when this machine's clock is off by more
  // than S3's one-second resolution allows (review H-1): usually one write
  // and one HEAD.
  try {
    const head = await this.s3Client.send(
      new HeadObjectCommand({
        Bucket: this.config.bucket,
        ...(await this.ownerParam()),
        Key: key,
      })
    );
    const keptAt = head.LastModified instanceof Date ? head.LastModified.getTime() : undefined;
    if (keptAt === undefined) throw new Error('S3 reported no LastModified');
    if (Math.abs(keptAt - provisional) <= KEPT_AT_CLOCK_TOLERANCE_MS) return;
    await put(entries.map((e) => (fresh.has(e) ? { ...e, keptAt } : e)));
  } catch (error) {
    throw new RetainedTimeUnconfirmedError(error);
  }
}

/** The refactor marker with its ETag, or null when there is none. */
export async function getRefactorMarker(
  this: S3StateBackend
): Promise<{ body: unknown; etag: string } | null> {
  await this.ensureClientForBucket();
  try {
    const response = await this.s3Client.send(
      new GetObjectCommand({
        Bucket: this.config.bucket,
        ...(await this.ownerParam()),
        Key: this.refactorMarkerKey(),
      })
    );
    const text = (await response.Body?.transformToString()) ?? '';
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      body = undefined;
    }
    return { body, etag: response.ETag ?? '' };
  } catch (error) {
    if (isNoSuchKey(error) || (error as { name?: string }).name === 'NotFound') return null;
    throw error;
  }
}

/**
 * Write the refactor marker conditionally: create it when `etag` is null
 * (`If-None-Match: *`), replace the version read otherwise (`If-Match`), and
 * delete it (conditionally) when `body` lists nothing. `'conflict'` when
 * another run changed it in between.
 */
export async function saveRefactorMarker(
  this: S3StateBackend,
  body: { moves: unknown[] },
  etag: string | null
): Promise<'saved' | 'conflict'> {
  await this.ensureClientForBucket();
  const key = this.refactorMarkerKey();
  try {
    if (body.moves.length === 0) {
      if (etag === null) return 'saved';
      await this.s3Client.send(
        new DeleteObjectCommand({
          Bucket: this.config.bucket,
          ...(await this.ownerParam()),
          Key: key,
          IfMatch: etag,
        })
      );
      return 'saved';
    }
    await this.s3Client.send(
      new PutObjectCommand({
        Bucket: this.config.bucket,
        ...(await this.ownerParam()),
        Key: key,
        Body: JSON.stringify(body, null, 2),
        ContentType: 'application/json',
        ...(etag === null ? { IfNoneMatch: '*' } : { IfMatch: etag }),
      })
    );
    return 'saved';
  } catch (error) {
    if (isConditionFailure(error)) return 'conflict';
    throw error;
  }
}

/**
 * The stack's registry marker, or `null` when there is none. A marker that
 * does not read as `{ prefix: <a state prefix> }` throws a
 * `CrossPrefixReadError` naming the key, as does any error but a 404 (a 403
 * included: the caller tells "denied" from "failed").
 */
export async function getRegistryMarker(
  this: S3StateBackend,
  stackName: string,
  region: string
): Promise<{ prefix: string; etag: string } | null> {
  await this.ensureClientForBucket();
  const key = this.registryMarkerKey(stackName, region);
  let body: string | undefined;
  let etag: string | undefined;
  try {
    const response = await this.s3Client.send(
      new GetObjectCommand({ Bucket: this.config.bucket, ...(await this.ownerParam()), Key: key })
    );
    body = await response.Body?.transformToString();
    etag = response.ETag;
  } catch (error) {
    if (isNoSuchKey(error) || (error as { name?: string }).name === 'NotFound') return null;
    throw new CrossPrefixReadError(key, error);
  }
  const prefix = registryMarkerPrefix(body);
  if (prefix === undefined || etag === undefined) {
    throw new CrossPrefixReadError(
      key,
      Object.assign(new Error('not a registry marker'), { name: 'MalformedMarker' })
    );
  }
  return { prefix, etag };
}

/**
 * Point the stack's marker at THIS prefix: create it (`If-None-Match: *`),
 * or, with `ifMatch`, replace exactly that version. `'conflict'` when the
 * condition failed (another writer got there first). Other errors throw.
 */
export async function claimRegistryMarker(
  this: S3StateBackend,
  stackName: string,
  region: string,
  ifMatch?: string
): Promise<'claimed' | 'conflict'> {
  await this.ensureClientForBucket();
  const key = this.registryMarkerKey(stackName, region);
  try {
    await this.s3Client.send(
      new PutObjectCommand({
        Bucket: this.config.bucket,
        ...(await this.ownerParam()),
        Key: key,
        Body: JSON.stringify({ prefix: this.config.prefix }),
        ContentType: 'application/json',
        ...(ifMatch === undefined ? { IfNoneMatch: '*' } : { IfMatch: ifMatch }),
      })
    );
    return 'claimed';
  } catch (error) {
    if (isConditionFailure(error)) return 'conflict';
    throw new CrossPrefixReadError(key, error);
  }
}

/**
 * Delete the stack's marker when it points at THIS prefix, conditionally on
 * the version read (`If-Match`), so another prefix's re-claim between the
 * read and the delete is left alone (`'elsewhere'`). An endpoint that does
 * not implement the condition gets a re-read of the same version right
 * before an unconditional delete: the window then shrinks to one request,
 * and a lost re-claim is re-made by that prefix's next guarded command (no
 * marker is a scan, then a claim). Errors throw.
 */
export async function releaseRegistryMarker(
  this: S3StateBackend,
  stackName: string,
  region: string,
  known?: { prefix: string; etag: string } | null
): Promise<'released' | 'absent' | 'elsewhere'> {
  // The version this run already read (review P3): no second GET. Without
  // its ETag (a marker this run claimed), read it.
  const marker =
    known !== undefined && (known === null || known.etag !== '')
      ? known
      : await this.getRegistryMarker(stackName, region);
  if (marker === null) return 'absent';
  if (marker.prefix !== this.config.prefix) return 'elsewhere';
  const key = this.registryMarkerKey(stackName, region);
  try {
    await this.s3Client.send(
      new DeleteObjectCommand({
        Bucket: this.config.bucket,
        ...(await this.ownerParam()),
        Key: key,
        IfMatch: marker.etag,
      })
    );
    return 'released';
  } catch (error) {
    if (isConditionFailure(error)) return 'elsewhere';
    if (!isNotImplemented(error)) throw error;
  }
  const again = await this.getRegistryMarker(stackName, region);
  if (again === null) return 'absent';
  if (again.prefix !== this.config.prefix || again.etag !== marker.etag) return 'elsewhere';
  await this.s3Client.send(
    new DeleteObjectCommand({
      Bucket: this.config.bucket,
      ...(await this.ownerParam()),
      Key: key,
    })
  );
  return 'released';
}
