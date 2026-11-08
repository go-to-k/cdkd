/**
 * Listings and raw-object access: stack and prefix listings, the cross-prefix record and lock probes, raw object reads/writes/deletes and the noncurrent-version purges.
 *
 * Moved verbatim out of `src/state/s3-state-backend.ts` (go-to-k/cdkd#5835); the
 * `S3StateBackend` class keeps one `f.call(this, ...)` delegator per moved method.
 */
import type { S3StateBackend } from '../s3-state-backend.js';
import {
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import { LISTING_ENCODING_TYPE, decodeListingKey } from '../../utils/s3-listing-keys.js';
import { CrossPrefixReadError } from '../cross-prefix-stack-scan.js';
import {
  displayIdent,
  displaySafe,
  safeMsg,
  STACK_REF_MAX_CODE_POINTS,
} from '../../utils/display-safe.js';
import { VERBOSE_POINTER } from '../../utils/aws-failure-text.js';
import { currentLogLineMasker } from '../../utils/log-line-masker.js';
import { UNRENDERABLE } from '../lock-contention-message.js';
// The LEAF directly, not the re-export: this module needs one pure function,
// and routing it through `malformed-resources-bag.ts` would add an edge to a
// module that reaches `error-handler` / `retryable-errors` /
// `lock-contention-message` for nothing.
import { producerRecordKey } from '../record-keys.js';
import { readEarlierStateResources, type EarlierStateRecord } from '../earlier-state-versions.js';
import { StateError, normalizeAwsError } from '../../utils/error-handler.js';
import {
  purgeNoncurrentKeyVersions,
  type NoncurrentVersionPurgeOptions,
} from '../s3-noncurrent-version-purge.js';
import {
  errorDetail,
  type StackStateRef,
  LEGACY_KEY_DEPTH,
  NEW_KEY_DEPTH,
  REGISTRY_ROOT,
  isNoSuchKey,
} from './shared.js';

/**
 * List all stacks with state in the bucket.
 *
 * Returns one `{stackName, region}` pair per state file. Both layouts
 * are enumerated:
 *
 * - `{prefix}/{stackName}/{region}/state.json` (new) — `region` is the
 *   path segment.
 * - `{prefix}/{stackName}/state.json` (legacy) — `region` is read from the
 *   state body when present, otherwise `undefined`.
 *
 * Pairs are deduplicated by `(stackName, region)` so a stack mid-migration
 * shows up exactly once.
 */
export async function listStacks(this: S3StateBackend): Promise<StackStateRef[]> {
  await this.ensureClientForBucket();
  try {
    this.logger.debug('Listing all stacks');

    const prefix = `${this.config.prefix}/`;
    const refs: StackStateRef[] = [];
    const seen = new Set<string>();
    let continuationToken: string | undefined;

    do {
      const response = await this.s3Client.send(
        new ListObjectsV2Command({
          Bucket: this.config.bucket,
          ...(await this.ownerParam()),
          Prefix: prefix,
          // go-to-k/cdkd#3313: a CR in a key becomes an LF without this.
          EncodingType: LISTING_ENCODING_TYPE,
          ...(continuationToken && { ContinuationToken: continuationToken }),
        })
      );

      for (const obj of response.Contents ?? []) {
        const key = decodeListingKey(obj.Key); // go-to-k/cdkd#3313
        if (!key) continue;
        if (!key.endsWith('/state.json')) continue;

        const rest = key.slice(prefix.length);
        const segments = rest.split('/');

        // New key: {stackName}/{region}/state.json
        if (segments.length === NEW_KEY_DEPTH) {
          const [stackName, region] = segments;
          if (!stackName || !region) continue;
          // {@link producerRecordKey}, not a separator. Both halves here are
          // S3 key segments, and the probe on go-to-k/cdkd#3323 measured that
          // S3 refuses to store a NUL-bearing key at all — so a NUL-separated
          // key WAS injective, by an invariant about what S3 accepts rather
          // than by anything this code states, tests, or would notice losing.
          const dedupeKey = producerRecordKey(stackName, region);
          if (!seen.has(dedupeKey)) {
            seen.add(dedupeKey);
            refs.push({ stackName, region });
          }
          continue;
        }

        // Legacy key: {stackName}/state.json
        if (segments.length === LEGACY_KEY_DEPTH) {
          const [stackName] = segments;
          if (!stackName) continue;
          const region = await this.readLegacyRegion(stackName);
          // Same helper, and this arm is the one where the old invariant was
          // already half gone: the region comes from the record BODY, which
          // is JSON and may carry a NUL. Injectivity survived only because
          // the LEFT half is still a key segment.
          const dedupeKey = producerRecordKey(stackName, region ?? '');
          if (!seen.has(dedupeKey)) {
            seen.add(dedupeKey);
            refs.push({ stackName, ...(region ? { region } : {}) });
          }
        }
      }

      continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
    } while (continuationToken);

    this.logger.debug(`Found ${refs.length} stack(s) across regions`);
    return refs;
  } catch (error) {
    const normalized = normalizeAwsError(error, {
      bucket: this.config.bucket,
      operation: 'ListObjectsV2',
    });
    throw this.wrapS3Failure(
      normalized,
      (text) => new StateError(`Failed to list stacks: ${text}`, normalized)
    );
  }
}

/**
 * The bucket's top-level key prefixes, decoded and without their trailing
 * `/` (`ListObjectsV2` with `Delimiter: '/'`, every page). An empty
 * `--state-prefix` keys records under `/`, which lists here as `''`. One
 * that will not decode is skipped. Errors propagate (go-to-k/cdkd#4705).
 */
export async function listTopLevelPrefixes(this: S3StateBackend): Promise<string[]> {
  const client = await this.clientForScan();
  const out: string[] = [];
  let continuationToken: string | undefined;
  do {
    const response = await client.send(
      new ListObjectsV2Command({
        Bucket: this.config.bucket,
        ...(await this.ownerParam()),
        Delimiter: '/',
        EncodingType: LISTING_ENCODING_TYPE,
        ...(continuationToken && { ContinuationToken: continuationToken }),
      })
    );
    for (const cp of response.CommonPrefixes ?? []) {
      // A prefix S3 returned in a form that will not decode cannot be
      // addressed, so it is skipped rather than failing the whole scan.
      let decoded: string | undefined;
      try {
        decoded = decodeListingKey(cp.Prefix);
      } catch {
        this.logger.debug(
          safeMsg`Skipping a top-level prefix of bucket ${this.config.bucket} that is not valid URL encoding: ${cp.Prefix ?? ''}`
        );
        continue;
      }
      if (decoded === undefined || !decoded.endsWith('/')) continue;
      // The registry's own root is no state prefix (go-to-k/cdkd#4705).
      if (decoded === `${REGISTRY_ROOT}/`) continue;
      out.push(decoded.slice(0, -1));
    }
    continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
  } while (continuationToken);
  return out;
}

/**
 * Raw sidecar-object write under the state bucket. Used for non-state
 * auxiliary files that share the bucket + region-resolution plumbing
 * (e.g. deployment-event JSONL streams + their `index.json`, issue
 * #808) without going through the state-schema validation that
 * `saveState` applies. No optimistic locking — callers own their key
 * uniqueness / last-writer-wins semantics.
 */
export async function putRawObject(
  this: S3StateBackend,
  key: string,
  body: string,
  contentType = 'application/json'
): Promise<void> {
  await this.ensureClientForBucket();
  await this.s3Client.send(
    new PutObjectCommand({
      Bucket: this.config.bucket,
      ...(await this.ownerParam()),
      Key: key,
      Body: body,
      ContentLength: Buffer.byteLength(body),
      ContentType: contentType,
    })
  );
}

/**
 * go-to-k/cdkd#4705: the `resources` maps of this stack's EARLIER records
 * under this prefix -- the newest `max` noncurrent versions of its
 * `state.json` on a versioned bucket (a destroy leaves a delete marker over
 * the last one) -- newest first. Read only to prove that a resource holding
 * a generated name is one this stack kept before `retained.json` existed.
 * A version whose body will not parse is skipped; any request error throws.
 */
export async function earlierStateResources(
  this: S3StateBackend,
  stackName: string,
  region: string,
  max = 10
): Promise<EarlierStateRecord[]> {
  await this.ensureClientForBucket();
  return readEarlierStateResources(
    this.s3Client,
    this.config.bucket,
    await this.ownerParam(),
    this.getStateKey(stackName, region),
    max
  );
}

/**
 * Does `prefix` (another prefix of this bucket) hold the stack's lock, in
 * either layout? A 404 is no; any other error throws a
 * `CrossPrefixReadError` naming the key.
 */
export async function lockUnderPrefix(
  this: S3StateBackend,
  prefix: string,
  stackName: string,
  region: string
): Promise<boolean> {
  await this.ensureClientForBucket();
  const keys = [`${prefix}/${stackName}/${region}/lock.json`, `${prefix}/${stackName}/lock.json`];
  const held = await Promise.all(
    keys.map(async (key) => {
      try {
        return await this.headObject(key);
      } catch (error) {
        throw new CrossPrefixReadError(key, error);
      }
    })
  );
  return held.some(Boolean);
}

/**
 * Raw sidecar-object read under the state bucket. Returns `null` when
 * the key does not exist; other errors propagate.
 */
export async function getRawObject(this: S3StateBackend, key: string): Promise<string | null> {
  await this.ensureClientForBucket();
  try {
    const response = await this.s3Client.send(
      new GetObjectCommand({
        Bucket: this.config.bucket,
        ...(await this.ownerParam()),
        Key: key,
      })
    );
    return (await response.Body?.transformToString()) ?? null;
  } catch (error) {
    if (isNoSuchKey(error) || (error as { name?: string }).name === 'NotFound') {
      return null;
    }
    throw error;
  }
}

/**
 * Raw key listing under an arbitrary key prefix in the state bucket
 * (paginated). Used by `cdkd events` to discover regions / runs under
 * `{prefix}/{stackName}/.../deployments/`.
 */
export async function listRawKeys(this: S3StateBackend, keyPrefix: string): Promise<string[]> {
  await this.ensureClientForBucket();
  const keys: string[] = [];
  let continuationToken: string | undefined;
  do {
    const response = await this.s3Client.send(
      new ListObjectsV2Command({
        Bucket: this.config.bucket,
        ...(await this.ownerParam()),
        Prefix: keyPrefix,
        // go-to-k/cdkd#3313: a CR in a key becomes an LF without this.
        EncodingType: LISTING_ENCODING_TYPE,
        ...(continuationToken && { ContinuationToken: continuationToken }),
      })
    );
    for (const obj of response.Contents ?? []) {
      const decoded = decodeListingKey(obj.Key); // go-to-k/cdkd#3313
      if (decoded) keys.push(decoded);
    }
    continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
  } while (continuationToken);
  return keys;
}

/**
 * Raw sidecar-object listing WITH metadata under the state bucket.
 *
 * {@link listRawKeys}'s twin, and it exists because an age-guarded sweep
 * needs `LastModified` and the reclaim plan needs `Size` — neither of which a
 * key list carries. Used by `cdkd gc`'s custom-resource-response sweep
 * (issue #2052), where the age is the only thing separating an abandoned
 * placeholder from one a concurrent run is about to write to.
 *
 * `LastModified` / `Size` are omitted from the response only for a key S3
 * did not return metadata for, which does not happen for `ListObjectsV2`
 * `Contents` entries; an entry missing either is DROPPED rather than
 * defaulted, because defaulting the date would either exempt an object from
 * the age guard forever or expose it immediately, and both are wrong in a
 * direction the caller cannot see.
 */
export async function listRawObjects(
  this: S3StateBackend,
  keyPrefix: string
): Promise<Array<{ key: string; lastModified: Date; size: number }>> {
  await this.ensureClientForBucket();
  const objects: Array<{ key: string; lastModified: Date; size: number }> = [];
  let continuationToken: string | undefined;
  do {
    const response = await this.s3Client.send(
      new ListObjectsV2Command({
        Bucket: this.config.bucket,
        ...(await this.ownerParam()),
        Prefix: keyPrefix,
        // go-to-k/cdkd#3313: a CR in a key becomes an LF without this.
        EncodingType: LISTING_ENCODING_TYPE,
        ...(continuationToken && { ContinuationToken: continuationToken }),
      })
    );
    for (const obj of response.Contents ?? []) {
      if (obj.Key === undefined || obj.LastModified === undefined || obj.Size === undefined) {
        // Logged, not silently skipped. The caller gets a SHORTER list with
        // no other signal, and its consumer is an age-guarded SWEEP, whose
        // under-collection is indistinguishable from a clean bucket. This
        // line is the only place the drop is ever observable.
        const missing = [
          obj.Key === undefined ? 'Key' : undefined,
          obj.LastModified === undefined ? 'LastModified' : undefined,
          obj.Size === undefined ? 'Size' : undefined,
        ]
          .filter((f) => f !== undefined)
          .join(', ');
        // Both keys embed a stack name (`{prefix}/{stack}/...`), so both
        // take the identifier guard (issue #3027).
        this.logger.debug(
          `listRawObjects: dropping an entry under ${displayIdent(keyPrefix, { maxCodePoints: STACK_REF_MAX_CODE_POINTS })} ` +
            `(key: ${obj.Key === undefined ? '<none>' : displayIdent(decodeListingKey(obj.Key) ?? obj.Key, { maxCodePoints: STACK_REF_MAX_CODE_POINTS })}) — ListObjectsV2 returned no ${missing}`
        );
        continue;
      }
      // go-to-k/cdkd#3313: the listing above asks for URL encoding, so the key
      // is decoded before it leaves this method — its consumer is an
      // age-guarded SWEEP that deletes by the value returned here.
      objects.push({
        key: decodeListingKey(obj.Key) ?? obj.Key,
        lastModified: obj.LastModified,
        size: obj.Size,
      });
    }
    continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
  } while (continuationToken);
  return objects;
}

/**
 * Raw sidecar-object batch delete under the state bucket. Used by the
 * deployment-events pruner (issue #885) to drop superseded `{runId}.jsonl`
 * streams + their index. Chunked to the 1,000-key `DeleteObjects` ceiling.
 * S3 `DeleteObjects` is idempotent — deleting a key that does not exist is
 * not an error — so callers do not need to pre-filter for existence.
 *
 * `DeleteObjects` reports per-key failures (e.g. partial `AccessDenied`,
 * `SlowDown`) in `response.Errors` rather than throwing — with `Quiet:
 * true` only those error entries come back. We aggregate them across
 * chunks and throw, so the explicit `cdkd events prune` purge does NOT
 * report success while leaving orphaned streams behind (the writer's
 * best-effort auto-prune swallows the throw via its write-chain catch).
 */
export async function deleteRawObjects(this: S3StateBackend, keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  await this.ensureClientForBucket();
  const failures: string[] = [];
  for (let i = 0; i < keys.length; i += 1000) {
    const chunk = keys.slice(i, i + 1000);
    const response = await this.s3Client.send(
      new DeleteObjectsCommand({
        Bucket: this.config.bucket,
        ...(await this.ownerParam()),
        Delete: { Objects: chunk.map((Key) => ({ Key })), Quiet: true },
      })
    );
    for (const err of response.Errors ?? []) {
      // The key embeds a stack name and S3 supplies the code and message, so
      // all three are guarded before they reach a line (issue #3027). The
      // thrown message names each key's failure by its CODE only: S3's
      // per-key `Message` is AWS's own text, and goes to `debug`
      // (go-to-k/cdkd#2319).
      const shownKey =
        err.Key === undefined
          ? '<unknown>'
          : displayIdent(err.Key, { maxCodePoints: STACK_REF_MAX_CODE_POINTS });
      const code = err.Code ?? 'Error';
      const mask = currentLogLineMasker();
      const shownCode = displaySafe(mask ? mask(code) : code, { asciiOnly: true }) || UNRENDERABLE;
      failures.push(`${shownKey} (${shownCode})`);
      this.logger.debug(
        safeMsg`DeleteObjects failed for ${shownKey} (${shownCode}): ${displaySafe(err.Message ?? '', { asciiOnly: true })}`
      );
    }
  }
  if (failures.length > 0) {
    throw new StateError(
      `Failed to delete ${failures.length} object(s) from bucket '${this.config.bucket}': ` +
        `${failures.join('; ')}. ${VERBOSE_POINTER}`
    );
  }
}

/**
 * Delete the NONCURRENT versions of raw sidecar keys in the state bucket
 * (issue [#2340](https://github.com/go-to-k/cdkd/issues/2340)).
 *
 * The versioned-bucket companion to {@link deleteRawObjects}, and
 * deliberately NOT folded into it: a purge needs IAM a plain delete does not
 * (`s3:ListBucketVersions`, `s3:DeleteObjectVersion`), and it removes the
 * recovery points versioning exists for, so each delete site opts in
 * explicitly. Every `deleteRawObjects` caller does opt in today (`cdkd gc`'s
 * custom-resource response sweep, `cdkd bootstrap destroy`'s marker, and the
 * deployment-event store's prunes, issue
 * [#2624](https://github.com/go-to-k/cdkd/issues/2624)), as does
 * `deleteRollbackJournal`, which deletes through its own path. So does
 * `cdkd scrub` after a PUT rather than a delete: the `state.json` it rewrites
 * (and, under `--purge-history`, every record it examines and does not
 * refuse) and the exports index of each region it wrote. The only other
 * `state.json` purge is `purgeDeletedStateHistory`, which `cdkd state
 * destroy` alone runs (go-to-k/cdkd#2346).
 *
 * It reaches only the keys it is given. A key already behind a delete marker
 * is absent from an ordinary listing, so a caller that empties a whole
 * prefix it owns uses `purgeNoncurrentVersionsUnderPrefix` instead.
 *
 * NEVER THROWS, and the try/catch below is what makes that true rather than
 * the helper alone. `ensureClientForBucket()` and `ownerParam()` sit OUTSIDE
 * the helper's guarantee and both reach AWS — `GetBucketLocation` can be
 * denied or throttled. Without the wrap, that rejection escaped at
 * `gc/command.ts`'s call site and skipped the `✓ Deleted ...` line after the delete
 * had already succeeded, which is precisely the outcome the comment there
 * says is impossible.
 */
export async function purgeNoncurrentVersions(
  this: S3StateBackend,
  keys: string[],
  options: Omit<NoncurrentVersionPurgeOptions, 'requestFields' | 'logger'> = {}
): Promise<void> {
  if (keys.length === 0) return;
  try {
    await this.ensureClientForBucket();
    await purgeNoncurrentKeyVersions(this.s3Client, this.config.bucket, keys, {
      ...options,
      requestFields: await this.ownerParam(),
      logger: this.logger,
    });
  } catch (error) {
    // Carries the caller's `objectDescription` for the same reason the helper
    // does (issue #2346): this arm fires when the purge could not even START,
    // and a reader has exactly the same "which object?" question then. Falls
    // back to naming nothing rather than to the helper's default, because
    // repeating a generic phrase here would read as a description the caller
    // supplied.
    const describing = options.objectDescription ? ` (${options.objectDescription})` : '';
    this.logger.warn(
      `Could not purge noncurrent versions of ${keys.length} key(s) in bucket ` +
        `'${this.config.bucket}': the purge could not be started. Their previous versions ` +
        `survive and remain readable via GetObject with a VersionId${describing}. Grant ` +
        `s3:ListBucketVersions and s3:DeleteObjectVersion on the state bucket, or purge the ` +
        `key(s) by hand. Underlying error: ${errorDetail(error)}`
    );
  }
}
