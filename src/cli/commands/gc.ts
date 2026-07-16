import readline from 'node:readline/promises';
import { Command, Option } from 'commander';
import { S3Client, ListObjectsV2Command, DeleteObjectsCommand } from '@aws-sdk/client-s3';
import { ECRClient, DescribeImagesCommand, BatchDeleteImageCommand } from '@aws-sdk/client-ecr';
import { GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { commonOptions } from '../options.js';
import { getLogger } from '../../utils/logger.js';
import type { Logger } from '../../types/config.js';
import { withErrorHandling, CdkdError, normalizeAwsError } from '../../utils/error-handler.js';
import { setAwsClients, AwsClients } from '../../utils/aws-clients.js';
import { applyRoleArnIfSet } from '../../utils/role-arn.js';
import { getDefaultStateBucketName } from '../config-loader.js';
import {
  getBootstrapMarkerKey,
  parseBootstrapMarker,
  type BootstrapMarker,
} from '../../assets/asset-storage.js';
import { S3StateBackend } from '../../state/s3-state-backend.js';
import {
  listAllStateKeys,
  listAllLockKeys,
  describeStateKey,
  LOCK_FILE_SUFFIX,
} from './state-file-keys.js';

/**
 * `cdkd gc` — garbage-collect unreferenced objects / images from the
 * cdkd-owned asset storage of ONE region (issue #1012).
 *
 * cdkd-owned asset storage (issue #1002) is content-addressed and never
 * deleted on `cdkd destroy` (another stack or a future rollback may
 * reference the same hash), so the asset bucket / container-asset ECR repo
 * grow without bound — and `cdk gc` cannot reach them by design. cdkd can
 * gc them PRECISELY because its state files record exactly which assets
 * are in use.
 *
 * Safety posture (this command DELETES user data — every ambiguity is
 * biased toward NOT deleting):
 *
 * - Names come from the region's bootstrap marker, never recomputed from
 *   the naming convention (custom-name compatibility, issue #1011). No
 *   marker → the region is not opted in; friendly no-op. CDK bootstrap
 *   storage (`cdk-hnb659fds-*`) is never touched — that stays `cdk gc`'s
 *   job.
 * - The reference scan lists EVERY state file in the WHOLE state bucket
 *   (any `--state-prefix`), and a state file that fails to JSON-parse
 *   aborts the whole run — deleting on partial knowledge is how a live
 *   asset gets deleted.
 * - Any stack lock in the bucket aborts the run: a deploy in flight may
 *   have published assets whose state write has not landed yet.
 * - `--older-than` (default 30d) age-guards every deletion: an object /
 *   image newer than the cutoff is kept even when unreferenced (protects
 *   in-flight publishes and recent rollback targets). Missing timestamps
 *   are treated as "new" (kept).
 * - Every S3 call pins `ExpectedBucketOwner`; a 403 on the asset bucket is
 *   a foreign-bucket refusal like the create / teardown sides.
 */

/** Default `--older-than` when the flag is not passed. */
const DEFAULT_OLDER_THAN_MS = 30 * 24 * 60 * 60 * 1000; // 30d

/** S3 `DeleteObjects` accepts at most 1,000 keys per call. */
const S3_DELETE_BATCH_SIZE = 1000;

/** ECR `BatchDeleteImage` accepts at most 100 image ids per call. */
const ECR_DELETE_BATCH_SIZE = 100;

/**
 * Parse the `--older-than` age guard: `<n>d` (days) or `<n>h` (hours),
 * decimals allowed (`1.5d`). Zero, negative, missing-unit, and
 * unknown-unit values are rejected at parse time — a zero / negative age
 * guard would disable the in-flight-publish protection entirely.
 *
 * Kept local (rather than extending `parseDuration` in `options.ts`):
 * the deploy-side duration grammar is seconds/minutes/hours for
 * per-resource deadlines, while gc ages are naturally days — mixing `30s`
 * into an age guard invites typos that all but disable it.
 */
export function parseOlderThan(value: string): number {
  const match = /^(\d+(?:\.\d+)?)([dh])$/.exec(value.trim());
  if (!match) {
    throw new Error(
      `Invalid --older-than "${value}": expected <number>d or <number>h (e.g. 30d, 12h)`
    );
  }
  const num = Number(match[1]);
  if (!Number.isFinite(num) || num <= 0) {
    throw new Error(`Invalid --older-than "${value}": must be greater than zero`);
  }
  const multiplier = match[2] === 'd' ? 24 * 60 * 60 * 1000 : 60 * 60 * 1000;
  return Math.round(num * multiplier);
}

/**
 * References to one region's asset storage collected from cdkd state files.
 */
export interface AssetReferences {
  /** S3 keys in the asset bucket that some state file references. */
  s3Keys: Set<string>;
  /** ECR image tags in the container repo that some state file references. */
  imageTags: Set<string>;
  /** ECR image digests (`sha256:<hex>`) that some state file references. */
  imageDigests: Set<string>;
}

/** Escape a literal string for embedding in a RegExp. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Characters that terminate an S3 key extracted from a URL-shaped string.
 * Whitespace / quotes never appear in cdkd's content-addressed asset keys
 * (`<sha256>.zip` etc.); `?` strips query strings (pre-signed URLs).
 */
const KEY_TERMINATORS = '[^\\s"\'?]';

/**
 * Per-(bucket, repo) reference extractors. Built once per run.
 *
 * Matched shapes (all carry the bucket / repo name verbatim):
 * - `{ S3Bucket: <assetBucket>, S3Key: <key> }` objects (Lambda `Code`,
 *   nested-stack `TemplateURL` pairs, ...) — handled in the walk itself.
 * - `s3://<assetBucket>/<key>` URIs.
 * - `https://<assetBucket>.s3[.<region>].amazonaws.com/<key>`
 *   (virtual-hosted style, region / dualstack variants included).
 * - `https://s3[.<region>].amazonaws.com/<assetBucket>/<key>` (path style).
 * - `<acct>.dkr.ecr.<region>.amazonaws.com/<containerRepo>:<tag>` and/or
 *   `...@sha256:<digest>` image URIs. Account / region are matched
 *   loosely on purpose: collecting a reference from another account's or
 *   region's URI can only over-protect (keep more), never delete more.
 */
function buildReferenceExtractors(marker: BootstrapMarker): {
  extractFromString: (value: string, refs: AssetReferences) => void;
} {
  const bucket = escapeRegExp(marker.assetBucket);
  const repo = escapeRegExp(marker.containerRepo);
  const s3UriRe = new RegExp(`s3://${bucket}/(${KEY_TERMINATORS}+)`, 'g');
  const virtualHostedRe = new RegExp(
    `https://${bucket}\\.s3[^/\\s]*\\.amazonaws\\.com/(${KEY_TERMINATORS}+)`,
    'g'
  );
  const pathStyleRe = new RegExp(
    `https://s3[^/\\s]*\\.amazonaws\\.com/${bucket}/(${KEY_TERMINATORS}+)`,
    'g'
  );
  const ecrRe = new RegExp(
    `\\d{12}\\.dkr\\.ecr\\.[a-z0-9-]+\\.amazonaws\\.com/${repo}` +
      `(?::([A-Za-z0-9_][A-Za-z0-9._-]{0,127}))?(?:@(sha256:[0-9a-f]{64}))?`,
    'g'
  );

  return {
    extractFromString(value: string, refs: AssetReferences): void {
      for (const re of [s3UriRe, virtualHostedRe, pathStyleRe]) {
        for (const match of value.matchAll(re)) {
          if (match[1]) refs.s3Keys.add(match[1]);
        }
      }
      for (const match of value.matchAll(ecrRe)) {
        if (match[1]) refs.imageTags.add(match[1]);
        if (match[2]) refs.imageDigests.add(match[2]);
      }
    },
  };
}

/**
 * Deep-walk a parsed state file and collect every reference to the target
 * region's asset bucket / container repo into `refs`.
 *
 * The walk covers the ENTIRE state document — a superset of the spec'd
 * `properties` / `observedProperties` / `attributes` / `outputs` fields —
 * because over-collection can only KEEP more (safe direction) and a future
 * state field carrying an asset reference is then protected automatically.
 * Unexpected value types are walked defensively (arrays / objects
 * recursed, non-strings ignored).
 */
export function collectAssetReferences(
  stateDocument: unknown,
  marker: BootstrapMarker,
  refs: AssetReferences
): void {
  const { extractFromString } = buildReferenceExtractors(marker);

  const walk = (value: unknown): void => {
    if (typeof value === 'string') {
      extractFromString(value, refs);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    if (value !== null && typeof value === 'object') {
      const record = value as Record<string, unknown>;
      // `{ S3Bucket: <assetBucket>, S3Key: <key> }` pair (Lambda Code etc.).
      if (record['S3Bucket'] === marker.assetBucket && typeof record['S3Key'] === 'string') {
        refs.s3Keys.add(record['S3Key']);
      }
      for (const item of Object.values(record)) walk(item);
    }
  };

  walk(stateDocument);
}

/**
 * Scan every state file in the state bucket and collect the referenced
 * asset keys / image tags / digests for the marker's bucket + repo.
 *
 * Fail safe: a state file that fails to JSON-parse aborts the whole run —
 * a reference we could not read is a reference we would otherwise delete.
 * A state key that disappeared between the listing and the read (destroy
 * completed concurrently) is skipped: its references are legitimately gone.
 */
async function scanReferencedAssets(
  stateBackend: Pick<S3StateBackend, 'listRawKeys' | 'getRawObject'>,
  marker: BootstrapMarker,
  logger: Logger
): Promise<AssetReferences> {
  const refs: AssetReferences = {
    s3Keys: new Set(),
    imageTags: new Set(),
    imageDigests: new Set(),
  };
  const stateKeys = await listAllStateKeys(stateBackend);
  logger.info(`Scanning ${stateKeys.length} state file(s) for asset references...`);
  for (const key of stateKeys) {
    const body = await stateBackend.getRawObject(key);
    if (body === null) {
      logger.debug(`State file ${key} disappeared during the scan — skipping`);
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch (error) {
      throw new CdkdError(
        `State file '${key}' is not valid JSON — aborting: gc must know every ` +
          `referenced asset before deleting anything, and this file's references ` +
          `are unreadable. Repair or remove the corrupt state file ` +
          `('cdkd state show ${describeStateKey(key).split(' ')[0]}' to inspect), then re-run.`,
        'GC_STATE_UNREADABLE',
        error as Error
      );
    }
    collectAssetReferences(parsed, marker, refs);
  }
  logger.debug(
    `Referenced: ${refs.s3Keys.size} S3 key(s), ${refs.imageTags.size} image tag(s), ` +
      `${refs.imageDigests.size} image digest(s)`
  );
  return refs;
}

/** An S3 object eligible for deletion. */
interface S3Candidate {
  key: string;
  size: number;
  lastModified: Date;
}

/** An ECR image eligible for deletion. */
interface EcrCandidate {
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
async function listS3Candidates(
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
          Bucket: bucket,
          ExpectedBucketOwner: accountId,
          ...(continuationToken && { ContinuationToken: continuationToken }),
        })
      );
      for (const obj of response.Contents ?? []) {
        if (!obj.Key) continue;
        if (refs.s3Keys.has(obj.Key)) continue;
        if (!obj.LastModified || obj.LastModified.getTime() >= cutoffMs) continue;
        candidates.push({ key: obj.Key, size: obj.Size ?? 0, lastModified: obj.LastModified });
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
 * Describe the container repo's images (paginated) and pick the deletion
 * candidates: an image is REFERENCED when any of its tags OR its digest is
 * in the referenced set; candidates are unreferenced AND strictly older
 * than the cutoff. Images with no `imagePushedAt` are kept (treated as
 * new). A missing repo is an idempotent skip.
 */
async function listEcrCandidates(
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
function formatBytes(bytes: number): string {
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
function formatAge(date: Date): string {
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
}): Promise<boolean> {
  const logger = getLogger();
  logger.warn('');
  logger.warn('cdkd gc will delete the following unreferenced assets:');
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
async function deleteS3Candidates(
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
async function deleteEcrCandidates(
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

export interface GcOptions {
  stateBucket?: string;
  region?: string;
  profile?: string;
  roleArn?: string;
  /** Age guard in milliseconds (parsed from `--older-than`, default 30d). */
  olderThan: number;
  /** Print the reclaim plan and exit without prompting or deleting. */
  dryRun: boolean;
  /** `-y` / `--yes` — skip the interactive confirmation. */
  yes: boolean;
  verbose: boolean;
}

/**
 * `cdkd gc` implementation. See the module JSDoc for the safety posture.
 */
export async function gcCommand(options: GcOptions): Promise<void> {
  const logger = getLogger();

  if (options.verbose) {
    logger.setLevel('debug');
  }

  logger.info('Starting cdkd gc...');
  logger.debug('Options:', options);

  // Resolve --role-arn / CDKD_ROLE_ARN before any AWS call.
  await applyRoleArnIfSet({ roleArn: options.roleArn, region: options.region });

  const region = options.region || process.env['AWS_REGION'] || 'us-east-1';

  const awsClients = new AwsClients({
    region,
    ...(options.profile && { profile: options.profile }),
  });
  setAwsClients(awsClients);

  // Account id is needed for the default bucket name AND for the
  // ExpectedBucketOwner pin on every S3 call, so always resolve it.
  const identity = await awsClients.sts.send(new GetCallerIdentityCommand({}));
  const accountId = identity.Account!;
  const bucketName = options.stateBucket ?? getDefaultStateBucketName(accountId);

  // State-bucket reads (marker, state scan, lock scan) go through the
  // state backend, which resolves the bucket's ACTUAL region itself — the
  // state bucket is account-scoped and may live in a different region
  // than --region. The asset bucket / ECR repo clients keep using --region.
  const markerS3Client = new S3Client({
    region,
    ...(options.profile && { profile: options.profile }),
  });
  const stateBackend = new S3StateBackend(
    markerS3Client,
    { bucket: bucketName, prefix: 'cdkd' },
    { region, ...(options.profile && { profile: options.profile }) }
  );
  const ecrClient = new ECRClient({
    region,
    ...(options.profile && { profile: options.profile }),
  });

  try {
    // 1. Read the region's bootstrap marker — the source of truth for the
    //    asset bucket / repo names (never recompute the naming convention;
    //    custom-name compatibility, issue #1011). No marker → the region
    //    is not opted in to cdkd asset storage; nothing to gc. CDK
    //    bootstrap storage is deliberately out of scope — `cdk gc` owns it.
    const markerKey = getBootstrapMarkerKey(region);
    let markerBody: string | null;
    try {
      markerBody = await stateBackend.getRawObject(markerKey);
    } catch (error) {
      if ((error as { name?: string }).name === 'NoSuchBucket') {
        logger.info(
          `State bucket '${bucketName}' does not exist — this account was never ` +
            `bootstrapped; nothing to garbage-collect.`
        );
        return;
      }
      throw error;
    }
    if (markerBody === null) {
      logger.info(
        `No bootstrap marker for region '${region}' (${markerKey}) — the region is not ` +
          `opted in to cdkd asset storage; nothing to garbage-collect. ` +
          `(CDK bootstrap storage is 'cdk gc' territory.)`
      );
      return;
    }
    const marker = parseBootstrapMarker(markerBody, markerKey);

    // 2. Lock guard: ANY stack lock in the bucket aborts — a deploy in
    //    flight may have published assets whose state write has not landed
    //    yet, and gc would see them as unreferenced. Simple and safe for v1.
    const lockKeys = await listAllLockKeys(stateBackend);
    if (lockKeys.length > 0) {
      const listing = lockKeys
        .map((k) => `  - ${describeStateKey(k, LOCK_FILE_SUFFIX)}  [${k}]`)
        .join('\n');
      throw new CdkdError(
        `Refusing to gc while ${lockKeys.length} stack(s) hold an active lock ` +
          `(a deploy in flight may have published assets whose state write has not ` +
          `landed yet):\n${listing}\n` +
          `Wait for the operation(s) to finish — or clear a stale lock with ` +
          `'cdkd force-unlock <stack>' — then re-run 'cdkd gc'.`,
        'GC_LOCKED'
      );
    }

    // 3. Reference collection: scan EVERY state file in the WHOLE bucket.
    const refs = await scanReferencedAssets(stateBackend, marker, logger);

    // 4. Deletion candidates, age-guarded by --older-than.
    const cutoffMs = Date.now() - options.olderThan;
    const s3Candidates = await listS3Candidates(
      awsClients.s3,
      marker.assetBucket,
      accountId,
      refs,
      cutoffMs,
      logger
    );
    const ecrCandidates = await listEcrCandidates(
      ecrClient,
      marker.containerRepo,
      refs,
      cutoffMs,
      logger
    );

    // 5. Nothing to do → info + exit 0, no prompt.
    if (s3Candidates.length === 0 && ecrCandidates.length === 0) {
      logger.info(
        `Nothing to garbage-collect in region '${region}': every object in ` +
          `${marker.assetBucket} / image in ${marker.containerRepo} is either ` +
          `referenced by a deployed stack or newer than the --older-than cutoff.`
      );
      return;
    }

    // 6. Reclaim plan + totals.
    const s3Bytes = s3Candidates.reduce((sum, c) => sum + c.size, 0);
    const ecrBytes = ecrCandidates.reduce((sum, c) => sum + c.size, 0);
    const planLines: string[] = [
      ...s3Candidates.map(
        (c) =>
          `s3://${marker.assetBucket}/${c.key} (${formatBytes(c.size)}, ${formatAge(c.lastModified)})`
      ),
      ...ecrCandidates.map(
        (c) =>
          `${marker.containerRepo}${c.tags.length > 0 ? `:${c.tags.join(',')}` : ''}` +
          `@${c.digest} (${formatBytes(c.size)}, ${formatAge(c.pushedAt)})`
      ),
    ];
    const totals =
      `Total: ${s3Candidates.length} S3 object(s) (${formatBytes(s3Bytes)}) + ` +
      `${ecrCandidates.length} ECR image(s) (${formatBytes(ecrBytes)}) = ` +
      `${formatBytes(s3Bytes + ecrBytes)} reclaimable`;

    if (options.dryRun) {
      logger.info('');
      logger.info('Dry run — the following unreferenced assets would be deleted:');
      for (const line of planLines) {
        logger.info(`  - ${line}`);
      }
      logger.info(totals);
      logger.info('Dry run: nothing deleted. Re-run without --dry-run to delete.');
      return;
    }

    // 7. Confirmation (default: interactive y/N; `--yes` skips; non-TTY
    //    without `--yes` hard-errors inside the prompt helper).
    const confirmed = await promptGcConfirm({
      planLines: [...planLines, totals],
      yes: options.yes,
    });
    if (!confirmed) {
      logger.info('gc cancelled — nothing deleted.');
      return;
    }

    // 8. Delete.
    if (s3Candidates.length > 0) {
      await deleteS3Candidates(awsClients.s3, marker.assetBucket, accountId, s3Candidates);
      logger.info(
        `✓ Deleted ${s3Candidates.length} object(s) (${formatBytes(s3Bytes)}) from ` +
          `${marker.assetBucket}`
      );
    }
    if (ecrCandidates.length > 0) {
      await deleteEcrCandidates(ecrClient, marker.containerRepo, ecrCandidates);
      logger.info(
        `✓ Deleted ${ecrCandidates.length} image(s) (${formatBytes(ecrBytes)}) from ` +
          `${marker.containerRepo}`
      );
    }
    logger.info(`\n✓ gc completed: ${formatBytes(s3Bytes + ecrBytes)} reclaimed`);
  } finally {
    ecrClient.destroy();
    // If the backend rebuilt its client for the state bucket's region it
    // already destroyed this one; a second destroy is a safe no-op.
    markerS3Client.destroy();
    awsClients.destroy();
  }
}

/**
 * Create the `cdkd gc` command (upstream `cdk gc` parity naming).
 */
export function createGcCommand(): Command {
  const cmd = new Command('gc')
    .description(
      "Garbage-collect unreferenced objects / images from ONE region's cdkd-owned asset " +
        'storage (asset bucket + container-asset ECR repo). References are collected from ' +
        'every cdkd state file; CDK bootstrap storage is never touched (use cdk gc for that).'
    )
    .option(
      '--state-bucket <bucket>',
      'S3 bucket holding cdkd state (default: cdkd-state-{accountId})'
    )
    .addOption(
      new Option(
        '--older-than <duration>',
        'Never delete an object / image newer than this age, even when unreferenced ' +
          '(protects in-flight publishes and recent rollback targets). Accepts <n>d / <n>h.'
      )
        .default(DEFAULT_OLDER_THAN_MS, '30d')
        .argParser(parseOlderThan)
    )
    .option('--dry-run', 'Print the reclaim plan (per-item list + totals) without deleting', false)
    .addOption(
      // Same region semantics as `cdkd bootstrap`: picks WHICH region's
      // asset storage to gc (flag → AWS_REGION → us-east-1).
      new Option(
        '--region <region>',
        'Region whose cdkd asset storage to garbage-collect (defaults to AWS_REGION env or us-east-1)'
      )
    )
    .action(
      withErrorHandling(async (options: GcOptions): Promise<void> => {
        await gcCommand(options);
      })
    );

  // Add common options (--profile, --role-arn, --verbose, --yes)
  commonOptions.forEach((opt) => cmd.addOption(opt));

  return cmd;
}
