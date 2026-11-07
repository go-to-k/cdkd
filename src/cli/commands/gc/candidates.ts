import readline from 'node:readline/promises';
import { S3Client, ListObjectsV2Command, DeleteObjectsCommand } from '@aws-sdk/client-s3';
import { ECRClient, DescribeImagesCommand, BatchDeleteImageCommand } from '@aws-sdk/client-ecr';
import { getLogger } from '../../../utils/logger.js';
import type { Logger } from '../../../types/config.js';
import { CdkdError, normalizeAwsError } from '../../../utils/error-handler.js';
import type { S3StateBackend } from '../../../state/s3-state-backend.js';
import { STATE_KEY_MAX_CODE_POINTS, CUSTOM_RESOURCE_RESPONSE_PREFIX } from '../state-file-keys.js';
import { displayIdent } from '../../../utils/display-safe.js';
import { LISTING_ENCODING_TYPE, decodeListingKey } from '../../../utils/s3-listing-keys.js';
import type { AssetReferences } from './asset-references.js';

/** S3 `DeleteObjects` accepts at most 1,000 keys per call. */
const S3_DELETE_BATCH_SIZE = 1000;

/** ECR `BatchDeleteImage` accepts at most 100 image ids per call. */
const ECR_DELETE_BATCH_SIZE = 100;

/** An S3 object eligible for deletion. */
export interface S3Candidate {
  key: string;
  size: number;
  lastModified: Date;
}

/** An ECR image eligible for deletion. */
export interface EcrCandidate {
  digest: string;
  tags: string[];
  size: number;
  pushedAt: Date;
}

/**
 * List the asset bucket (paginated, `ExpectedBucketOwner`) and pick the
 * deletion candidates: keys NOT referenced AND strictly older than the
 * cutoff. Objects with no `LastModified` are kept (treated as new).
 *
 * A missing bucket is an idempotent skip (nothing to gc there); a 403 is
 * a foreign-bucket refusal, mirroring the create / teardown sides.
 */
export async function listS3Candidates(
  s3Client: Pick<S3Client, 'send'>,
  bucket: string,
  accountId: string,
  refs: AssetReferences,
  cutoffMs: number,
  logger: Logger
): Promise<S3Candidate[]> {
  const candidates: S3Candidate[] = [];
  let continuationToken: string | undefined;
  try {
    do {
      const response = await s3Client.send(
        new ListObjectsV2Command({
          // go-to-k/cdkd#3313: a CR in a key becomes an LF without this.
          EncodingType: LISTING_ENCODING_TYPE,
          Bucket: bucket,
          ExpectedBucketOwner: accountId,
          ...(continuationToken && { ContinuationToken: continuationToken }),
        })
      );
      for (const obj of response.Contents ?? []) {
        // go-to-k/cdkd#3313: decoded before the reference test AND before the
        // delete candidate is built — both address the key returned here.
        const objKey = decodeListingKey(obj.Key);
        if (!objKey) continue;
        if (refs.s3Keys.has(objKey)) continue;
        if (!obj.LastModified || obj.LastModified.getTime() >= cutoffMs) continue;
        candidates.push({ key: objKey, size: obj.Size ?? 0, lastModified: obj.LastModified });
      }
      continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
    } while (continuationToken);
  } catch (error) {
    const err = error as { name?: string; $metadata?: { httpStatusCode?: number } };
    if (err.name === 'NoSuchBucket' || err.name === 'NotFound') {
      logger.info(`Asset bucket ${bucket} does not exist — skipping`);
      return [];
    }
    if (err.$metadata?.httpStatusCode === 403) {
      throw new CdkdError(
        `Asset bucket '${bucket}' exists but is not owned by account ${accountId} ` +
          `(or access is denied). Refusing to touch it.`,
        'ASSET_STORAGE_FOREIGN_BUCKET',
        error as Error
      );
    }
    throw normalizeAwsError(error, { bucket, operation: 'ListObjectsV2' });
  }
  return candidates;
}

/**
 * One abandoned custom-resource response placeholder in the STATE bucket.
 *
 * Distinct from an asset candidate: it lives in a different bucket, it is
 * matched by PREFIX rather than by reachability from a state file, and its only
 * guard is age.
 */
export interface ResponsePlaceholderCandidate {
  key: string;
  size: number;
  lastModified: Date;
}

/**
 * The only key shape `CustomResourceProvider` can mint under the prefix.
 *
 * `getResponseKey` builds `{prefix}/{requestId}.json` from
 * `cdkd-${Date.now()}-${Math.random().toString(36).substring(7)}`.
 *
 * The trailing group is `*`, NOT `+`, and that is a measurement rather than
 * caution: `substring(7)` returns the EMPTY string whenever the base-36
 * rendering is shorter than eight characters (`(0.5).toString(36)` is `'0.i'`),
 * so `cdkd-1756180000000-.json` is a real key this provider writes. A `+` here
 * would skip exactly those and the sweep would silently under-collect — a
 * shape filter defeating the sweep it is meant to protect.
 *
 * HOW OFTEN, counted rather than guessed, because sampling cannot answer it (0
 * hits in 5,000,000 `Math.random()` calls). V8 returns `k * 2^-52` for integer
 * `k` in `[0, 2^52)`, and `toString(36)` emits the shortest string that
 * round-trips, so the output is at most 7 characters exactly when some 5-digit
 * base-36 fraction `d / 36^5` has that double as its nearest neighbour.
 * Enumerating all `36^5` values of `d` and keeping those that land on a value
 * `Math.random()` can emit gives 14,921,970 of them: a rate of ~3.3e-9, about 1
 * in 3.0e8 invocations (e.g. `k = 4503599552889192` renders `0.zzzzz`). Rare per
 * invocation, inevitable across a fleet, and — the part that decides the
 * quantifier — SILENT when missed.
 *
 * Why filter at all: `--state-prefix` is free-form and unvalidated, so a stack
 * deployed with `--state-prefix custom-resource-responses` puts its
 * `state.json`, `lock.json`, `rollback-journal.json` and `deployments/*` INSIDE
 * this prefix. gc builds its own backend on `DEFAULT_STATE_PREFIX` and cannot
 * see that collision, so an age-only sweep would delete live state and orphan
 * every resource in the stack. Matching the producer's own shape is what keeps
 * this command's "bias every ambiguity toward NOT deleting" posture true on the
 * one path that deletes from the STATE bucket.
 */
const RESPONSE_PLACEHOLDER_KEY = /^cdkd-\d+-[0-9a-z]*\.json$/;

/**
 * List abandoned custom-resource response placeholders (issue #2052).
 *
 * `CustomResourceProvider` PUTs an empty object at
 * `custom-resource-responses/{requestId}.json` before each invocation so the
 * handler has a pre-signed URL to write to. The happy paths clean up after
 * themselves — the issue #2033 replay path via `cleanupResponseObject`, and the
 * FAILED-response arm via `getCustomResourceResponse` / `pollS3Response` — but
 * three shapes leave the key behind and NOTHING collected them:
 *
 *  - an interrupted deploy (Ctrl-C / SIGTERM / a cancelled CI job) between the
 *    PUT and any cleanup;
 *  - any throw on a path that does not reach a cleanup call;
 *  - a LATE handler PUT, landing after cdkd stopped polling. This is the only
 *    one with CONTENT: an empty body is a storage leak, but a real
 *    CloudFormation `Data` payload sitting at a key nothing collects is also a
 *    data-retention question.
 *
 * ## Why age alone is a sufficient staleness rule here
 *
 * The requirement is that a key belonging to an IN-FLIGHT concurrent run is
 * never collected, and two independent things already guarantee it:
 *
 *  1. gc refuses outright while ANY stack holds a lock (the lock guard in
 *     `gcCommand`), and every deploy that can write one of these keys holds
 *     one for its whole duration. A concurrent run does not get this far.
 *  2. `--older-than` (default 30d) is applied to each object's own
 *     `LastModified`, which for a placeholder is the moment of the PUT that
 *     opened the invocation.
 *
 * So this deliberately adds no clock of its own. The two are not ranked, and an
 * earlier version of this note wrongly said (1) was the one that mattered: for
 * a deploy that STARTS between the lock scan and this listing, (1) has already
 * run and only (2) covers it. They close different windows.
 *
 * ## What this widens, stated rather than implied
 *
 * This is gc's first DESTRUCTIVE call against the state bucket — until now it
 * only ever read from it. And unlike every other arm of this command it is
 * ACCOUNT-scoped, not region-scoped: placeholder keys carry no region, so
 * `cdkd gc --region us-east-1` collects ones written by deploys into any
 * region. Both are deliberate (the objects are cdkd's own transient scratch,
 * and a region-scoped sweep could never reach most of them), and both are why
 * the key-shape filter below is not optional.
 *
 * ## Scope
 *
 * Only the DEFAULT prefix. `ProviderRegistry` can be configured with another
 * `responsePrefix`, and nothing persists which one a past deploy used, so gc
 * cannot discover a non-default layout — under-collecting, which is the safe
 * direction, and the reason the constant is shared with the producer rather
 * than re-spelled here.
 */
export async function listResponsePlaceholderCandidates(
  stateBackend: Pick<S3StateBackend, 'listRawObjects'>,
  cutoffMs: number,
  logger: { debug: (message: string) => void }
): Promise<ResponsePlaceholderCandidate[]> {
  const objects = await stateBackend.listRawObjects(`${CUSTOM_RESOURCE_RESPONSE_PREFIX}/`);
  const candidates: ResponsePlaceholderCandidate[] = [];
  for (const obj of objects) {
    const leaf = obj.key.slice(`${CUSTOM_RESOURCE_RESPONSE_PREFIX}/`.length);
    if (!RESPONSE_PLACEHOLDER_KEY.test(leaf)) {
      logger.debug(
        `gc: keeping ${displayIdent(obj.key, { maxCodePoints: STATE_KEY_MAX_CODE_POINTS })} — not a cdkd response placeholder`
      );
      continue;
    }
    if (obj.lastModified.getTime() >= cutoffMs) {
      logger.debug(
        `gc: keeping ${displayIdent(obj.key, { maxCodePoints: STATE_KEY_MAX_CODE_POINTS })} — newer than the --older-than cutoff`
      );
      continue;
    }
    candidates.push(obj);
  }
  return candidates;
}

/**
 * Describe the container repo's images (paginated) and pick the deletion
 * candidates: an image is REFERENCED when any of its tags OR its digest is
 * in the referenced set; candidates are unreferenced AND strictly older
 * than the cutoff. Images with no `imagePushedAt` are kept (treated as
 * new). A missing repo is an idempotent skip.
 */
export async function listEcrCandidates(
  ecrClient: Pick<ECRClient, 'send'>,
  repositoryName: string,
  refs: AssetReferences,
  cutoffMs: number,
  logger: Logger
): Promise<EcrCandidate[]> {
  const candidates: EcrCandidate[] = [];
  let nextToken: string | undefined;
  try {
    do {
      const response = await ecrClient.send(
        new DescribeImagesCommand({
          repositoryName,
          ...(nextToken && { nextToken }),
        })
      );
      for (const image of response.imageDetails ?? []) {
        if (!image.imageDigest) continue;
        const tags = image.imageTags ?? [];
        const referenced =
          refs.imageDigests.has(image.imageDigest) || tags.some((t) => refs.imageTags.has(t));
        if (referenced) continue;
        if (!image.imagePushedAt || image.imagePushedAt.getTime() >= cutoffMs) continue;
        candidates.push({
          digest: image.imageDigest,
          tags,
          size: image.imageSizeInBytes ?? 0,
          pushedAt: image.imagePushedAt,
        });
      }
      nextToken = response.nextToken;
    } while (nextToken);
  } catch (error) {
    const err = error as { name?: string };
    if (err.name === 'RepositoryNotFoundException') {
      logger.info(`Container-asset repository ${repositoryName} does not exist — skipping`);
      return [];
    }
    throw normalizeAwsError(error, { operation: 'DescribeImages' });
  }
  return candidates;
}

/** `12345678` → `11.8 MiB` — human-readable byte count for the plan. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes;
  let unit = 'B';
  for (const u of units) {
    if (value < 1024) break;
    value /= 1024;
    unit = u;
  }
  return `${value.toFixed(1)} ${unit}`;
}

/** Age of a timestamp relative to now, in whole days (or hours under 1d). */
export function formatAge(date: Date): string {
  const ageMs = Date.now() - date.getTime();
  const days = Math.floor(ageMs / (24 * 60 * 60 * 1000));
  if (days >= 1) return `${days}d old`;
  return `${Math.max(0, Math.floor(ageMs / (60 * 60 * 1000)))}h old`;
}

/**
 * Interactive confirmation for the deletion. Follows the repo's
 * destructive-prompt convention (same pattern family as
 * `promptBootstrapDestroyConfirm`): print the plan as a WARN block,
 * `--yes` skips, a non-TTY stdin without `--yes` is a hard error (never
 * hang / never silently decline in CI), and the prompt defaults to NO.
 */
export async function promptGcConfirm(input: {
  planLines: string[];
  yes: boolean;
  region: string;
}): Promise<boolean> {
  const logger = getLogger();
  logger.warn('');
  // Name the REGION above the plan (issue #2029). Since that value can now come
  // from `~/.aws/config` - a source the user never typed on this command line -
  // the plan must say which region it is about. It was inferrable only by
  // accident before: the DEFAULT storage name embeds the region
  // (`cdkd-assets-<acct>-<region>`), but a bootstrap run with
  // `--asset-bucket` / `--container-repo` prints custom names with no region
  // anywhere, so `-y` deleted in an unnamed region.
  // NOT "unreferenced assets in <region>": since issue #2052 the plan can also
  // carry state-bucket custom-resource response placeholders, which are neither
  // assets nor region-scoped. This is the CONSENT surface for that widened blast
  // radius, so it must not describe less than it is about to delete.
  logger.warn(`cdkd gc will delete the following (region: ${input.region}):`);
  for (const line of input.planLines) {
    logger.warn(`  - ${line}`);
  }

  if (input.yes) return true;

  if (process.stdin.isTTY !== true) {
    throw new CdkdError(
      'The gc confirmation prompt cannot run in a non-interactive environment. ' +
        'Pass --yes / -y to confirm the deletion, or run the command from a real terminal.',
      'NON_INTERACTIVE_CONFIRM'
    );
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question('\nContinue? (y/N): ');
    const trimmed = answer.trim().toLowerCase();
    return trimmed === 'y' || trimmed === 'yes';
  } finally {
    rl.close();
  }
}

/**
 * Delete the S3 candidates via chunked `DeleteObjects` (1,000 keys per
 * call, `ExpectedBucketOwner`). Per-key `Errors` are surfaced as a hard
 * error so gc never reports success while objects remain.
 */
export async function deleteS3Candidates(
  s3Client: Pick<S3Client, 'send'>,
  bucket: string,
  accountId: string,
  candidates: S3Candidate[]
): Promise<void> {
  const failures: string[] = [];
  for (let i = 0; i < candidates.length; i += S3_DELETE_BATCH_SIZE) {
    const chunk = candidates.slice(i, i + S3_DELETE_BATCH_SIZE);
    const response = await s3Client.send(
      new DeleteObjectsCommand({
        Bucket: bucket,
        ExpectedBucketOwner: accountId,
        Delete: { Objects: chunk.map((c) => ({ Key: c.key })), Quiet: true },
      })
    );
    for (const err of response.Errors ?? []) {
      failures.push(`${err.Key ?? '<unknown>'} (${err.Code ?? 'Error'}: ${err.Message ?? ''})`);
    }
  }
  if (failures.length > 0) {
    throw new CdkdError(
      `Failed to delete ${failures.length} object(s) from asset bucket '${bucket}': ` +
        failures.join('; '),
      'GC_DELETE_FAILED'
    );
  }
}

/**
 * Delete the ECR candidates via chunked `BatchDeleteImage` (100 image ids
 * per call), addressed by digest so every tag of the image goes with it.
 * Per-image `failures` are surfaced as a hard error.
 */
export async function deleteEcrCandidates(
  ecrClient: Pick<ECRClient, 'send'>,
  repositoryName: string,
  candidates: EcrCandidate[]
): Promise<void> {
  const failures: string[] = [];
  for (let i = 0; i < candidates.length; i += ECR_DELETE_BATCH_SIZE) {
    const chunk = candidates.slice(i, i + ECR_DELETE_BATCH_SIZE);
    const response = await ecrClient.send(
      new BatchDeleteImageCommand({
        repositoryName,
        imageIds: chunk.map((c) => ({ imageDigest: c.digest })),
      })
    );
    for (const failure of response.failures ?? []) {
      failures.push(
        `${failure.imageId?.imageDigest ?? '<unknown>'} ` +
          `(${failure.failureCode ?? 'Error'}: ${failure.failureReason ?? ''})`
      );
    }
  }
  if (failures.length > 0) {
    throw new CdkdError(
      `Failed to delete ${failures.length} image(s) from repository '${repositoryName}': ` +
        failures.join('; '),
      'GC_DELETE_FAILED'
    );
  }
}
