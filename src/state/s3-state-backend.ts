import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  NoSuchKey,
} from '@aws-sdk/client-s3';
import {
  STATE_SCHEMA_VERSION_CURRENT,
  STATE_SCHEMA_VERSIONS_READABLE,
  type StackState,
} from '../types/state.js';
import type { StateBackendConfig } from '../types/config.js';
import {
  ROLLBACK_JOURNAL_VERSION,
  parseRollbackJournal,
  type RollbackJournal,
  type RollbackJournalSegment,
} from '../types/rollback-journal.js';
import type { FailedOperation } from '../deployment/rollback-executor.js';
import { getLogger } from '../utils/logger.js';
import { expectedOwnerParam } from '../utils/expected-bucket-owner.js';
import { StateError, normalizeAwsError } from '../utils/error-handler.js';
import { rebuildClientForBucketRegion } from '../utils/bucket-region-client.js';

/**
 * Identifier of a state record. The legacy layout (`version: 1`) didn't have
 * region in the S3 key, so reads from the legacy key carry `region:
 * undefined`.
 */
export interface StackStateRef {
  stackName: string;
  /** Region of the state. `undefined` ONLY for legacy `version: 1` records. */
  region?: string;
}

/**
 * The `version: 1` legacy state key under the `cdkd/` prefix. Two layers
 * deep — split off into a constant so call sites can clearly distinguish
 * "two-segment legacy key" from "three-segment new key".
 */
const LEGACY_KEY_DEPTH = 2;
/** The `version: 2` region-prefixed key. */
const NEW_KEY_DEPTH = 3;

/**
 * Options used to reconstruct the S3Client if the bucket lives in a region
 * different from the one the initial client was built for.
 *
 * Mirrors {@link AwsClientConfig} from `aws-clients.ts` but kept local so
 * the state backend doesn't depend on the CLI-side AwsClients wrapper.
 */
export interface S3ClientOptions {
  region?: string;
  profile?: string;
  credentials?: {
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken?: string;
  };
}

/**
 * S3-based state backend using conditional writes for optimistic locking.
 *
 * State keys are region-scoped (`{prefix}/{stackName}/{region}/state.json`)
 * to prevent two regions of the same stackName from overwriting each other's
 * state. Legacy `{prefix}/{stackName}/state.json` keys (schema `version: 1`)
 * are still readable; the next `saveState` for that stack auto-migrates by
 * writing the new key and deleting the legacy one.
 *
 * The state bucket can live in a different AWS region from the rest of the
 * cdkd CLI's resource provisioning. Before the first state operation, this
 * backend resolves the bucket's actual region via `GetBucketLocation` and,
 * if it differs from the client's configured region, rebuilds the S3Client
 * for that region. Provisioning clients are unaffected — only the
 * state-bucket S3 client is region-corrected.
 */
export class S3StateBackend {
  private logger = getLogger().child('S3StateBackend');
  private s3Client: S3Client;
  private config: StateBackendConfig;
  private clientOpts: S3ClientOptions;
  private clientResolved = false;
  private resolveInFlight: Promise<void> | null = null;

  constructor(s3Client: S3Client, config: StateBackendConfig, clientOpts: S3ClientOptions = {}) {
    this.s3Client = s3Client;
    this.config = config;
    this.clientOpts = clientOpts;
  }

  /**
   * Read-only accessor for the S3 key prefix this backend writes under
   * (defaults to `cdkd`). Used by the cross-account `Fn::GetStackOutput`
   * resolver when it constructs an ephemeral state backend pointed at
   * the producer account's bucket — the producer's prefix should match
   * the consumer's prefix (both sides almost always default to `cdkd`,
   * but `--state-prefix` overrides at the consumer side propagate
   * cleanly).
   */
  get prefix(): string {
    return this.config.prefix;
  }

  /**
   * Get the new (region-scoped) S3 key for a stack's state file.
   */
  private getStateKey(stackName: string, region: string): string {
    return `${this.config.prefix}/${stackName}/${region}/state.json`;
  }

  /**
   * Get the legacy (pre-region-prefix) S3 key for a stack's state file.
   * Used for backwards-compatible reads and for the migration delete.
   */
  private getLegacyStateKey(stackName: string): string {
    return `${this.config.prefix}/${stackName}/state.json`;
  }

  /**
   * Get the rollback-journal S3 key — a sibling of `state.json` (issue
   * #1183). Only the region-scoped layout is used: journals are new objects
   * only ever written by journal-aware binaries, and the deploy failure path
   * migrates legacy-layout state before the journal write, so a legacy-key
   * journal can never exist.
   */
  private getRollbackJournalKey(stackName: string, region: string): string {
    return `${this.config.prefix}/${stackName}/${region}/rollback-journal.json`;
  }

  /**
   * Resolve the state bucket's actual region and, if it differs from the
   * client's currently-configured region, replace the S3Client with one
   * pointed at the bucket's region.
   *
   * This is idempotent: subsequent calls return immediately. Concurrent
   * callers (e.g. when several public methods race during a parallel deploy)
   * share a single in-flight resolution promise so we never issue more than
   * one `GetBucketLocation` per backend.
   *
   * Errors from `GetBucketLocation` are deliberately swallowed by
   * `resolveBucketRegion` — the resolver returns `fallbackRegion` so the
   * caller can surface the more actionable downstream error (e.g. the
   * `HeadBucket` 404 routed via `normalizeAwsError`).
   */
  private async ensureClientForBucket(): Promise<void> {
    if (this.clientResolved) return;
    if (this.resolveInFlight) return this.resolveInFlight;

    this.resolveInFlight = (async (): Promise<void> => {
      try {
        // S3StateBackend OWNS its client and threads static `--profile` /
        // credentials from its constructor `clientOpts` into both the probe
        // and the rebuild; the replaced client is destroyed.
        const replacement = await rebuildClientForBucketRegion(this.s3Client, this.config.bucket, {
          ...(this.clientOpts.profile && { profile: this.clientOpts.profile }),
          ...(this.clientOpts.credentials && { credentials: this.clientOpts.credentials }),
          destroyOldClient: true,
          onRebuild: ({ bucketRegion, currentRegion }) => {
            this.logger.debug(
              `State bucket '${this.config.bucket}' is in '${bucketRegion}' (client was '${String(currentRegion)}'); rebuilding S3 client.`
            );
          },
        });
        if (replacement) {
          this.s3Client = replacement;
        }
        this.clientResolved = true;
      } finally {
        this.resolveInFlight = null;
      }
    })();

    return this.resolveInFlight;
  }

  /**
   * Verify that the configured state bucket exists.
   *
   * Called early in deploy/destroy to fail fast before expensive work
   * (asset publishing, Docker builds) runs against a missing bucket.
   *
   * Errors are routed through {@link normalizeAwsError} so the AWS SDK v3
   * synthetic `UnknownError` (e.g. cross-region HEAD) becomes a concrete
   * "Bucket does not exist" / "Access denied" / "different region" message.
   */
  /**
   * `ExpectedBucketOwner` spread for every state-bucket S3 call — S3 itself
   * rejects the call (403) when the bucket is owned by another account,
   * closing the predictable-name squatting hole (a foreign bucket that
   * ALLOWS this account would otherwise silently receive state
   * reads/writes). Best-effort: resolves to an empty object for
   * non-standard clients (test doubles) — see expected-bucket-owner.ts.
   */
  private async ownerParam(): Promise<{ ExpectedBucketOwner?: string }> {
    return expectedOwnerParam(this.s3Client);
  }

  async verifyBucketExists(): Promise<void> {
    await this.ensureClientForBucket();
    try {
      await this.s3Client.send(
        new HeadBucketCommand({
          Bucket: this.config.bucket,
          ...(await this.ownerParam()),
        })
      );
    } catch (error) {
      const name = (error as { name?: string }).name;
      if (name === 'NotFound' || name === 'NoSuchBucket') {
        throw new StateError(
          `State bucket '${this.config.bucket}' does not exist. ` +
            `Run 'cdkd bootstrap' to create it, or specify an existing bucket via ` +
            `--state-bucket, CDKD_STATE_BUCKET, or cdk.json context.cdkd.stateBucket.`
        );
      }
      const normalized = normalizeAwsError(error, {
        bucket: this.config.bucket,
        operation: 'HeadBucket',
      });
      throw new StateError(
        `Failed to verify state bucket '${this.config.bucket}': ${normalized.message}`,
        normalized
      );
    }
  }

  /**
   * Check if state exists for a stack in the given region.
   *
   * Returns true for either layout: the new region-scoped key, or the legacy
   * key when its embedded `region` matches the requested region. This lets
   * `cdkd state orphan <stack> --region X` and `cdkd destroy <stack>` see legacy
   * state without forcing a write-through migration first.
   */
  async stateExists(stackName: string, region: string): Promise<boolean> {
    await this.ensureClientForBucket();
    const newKey = this.getStateKey(stackName, region);

    if (await this.headObject(newKey)) {
      return true;
    }

    return this.legacyMatchesRegion(stackName, region);
  }

  /**
   * Get state for a stack, transparently falling back to the legacy key.
   *
   * Lookup order:
   * 1. `{prefix}/{stackName}/{region}/state.json` (current `version: 2` key).
   * 2. `{prefix}/{stackName}/state.json` (legacy `version: 1` key) — only
   *    accepted if its embedded `region` matches the requested region.
   *
   * When a legacy hit is returned, `migrationPending` is `true`. Callers that
   * subsequently `saveState` automatically migrate by writing the new key and
   * deleting the legacy one (see `saveState`'s `legacyMigration` argument).
   *
   * Note: S3 returns ETag with surrounding quotes (e.g., `"abc123"`). We
   * preserve the quotes — they are required for `IfMatch` conditions.
   */
  async getState(
    stackName: string,
    region: string
  ): Promise<{ state: StackState; etag: string; migrationPending?: boolean } | null> {
    await this.ensureClientForBucket();
    const newKey = this.getStateKey(stackName, region);

    // 1. Try new region-scoped key first.
    try {
      this.logger.debug(`Getting state for stack: ${stackName} (${region})`);

      const response = await this.s3Client.send(
        new GetObjectCommand({
          Bucket: this.config.bucket,
          ...(await this.ownerParam()),
          Key: newKey,
        })
      );

      if (!response.Body) {
        throw new StateError(`State file for stack '${stackName}' (${region}) has no body`);
      }
      if (!response.ETag) {
        throw new StateError(`State file for stack '${stackName}' (${region}) has no ETag`);
      }

      const bodyString = await response.Body.transformToString();
      const state = this.parseStateBody(bodyString, stackName);
      this.logger.debug(`Retrieved state: ${stackName} (${region}), ETag: ${response.ETag}`);
      return { state, etag: response.ETag };
    } catch (error) {
      if (!isNoSuchKey(error)) {
        if (error instanceof StateError) throw error;
        throw new StateError(
          `Failed to get state for stack '${stackName}' (${region}): ${error instanceof Error ? error.message : String(error)}`,
          error instanceof Error ? error : undefined
        );
      }
      this.logger.debug(`No state at new key for stack: ${stackName} (${region})`);
    }

    // 2. Fall back to legacy key when it exists AND its region matches.
    const legacy = await this.tryGetLegacy(stackName, region);
    if (legacy) {
      this.logger.warn(
        `Loaded legacy state for stack '${stackName}' from '${this.getLegacyStateKey(stackName)}'. ` +
          `It will be migrated to the region-scoped layout on next save.`
      );
      return { ...legacy, migrationPending: true };
    }

    return null;
  }

  /**
   * Save state for a stack with optimistic locking.
   *
   * Always writes to the new region-scoped key. The state body is rewritten
   * with `version: 2` and the supplied region.
   *
   * If the caller observed `migrationPending: true` from `getState`, it
   * should pass the legacy ETag back via `expectedEtag` AND set
   * `migrateLegacy: true`. After the new key is written successfully, the
   * legacy key is deleted to complete migration. The legacy delete is a
   * best-effort follow-up — a failure is logged but does not unwind the new
   * write.
   *
   * @param stackName Stack name
   * @param region Target region (load-bearing — part of the S3 key)
   * @param state State to save
   * @param options Optimistic-lock ETag + legacy-migration flag
   * @returns New ETag (with quotes, e.g., `"abc123"`)
   */
  async saveState(
    stackName: string,
    region: string,
    state: StackState,
    options: { expectedEtag?: string; migrateLegacy?: boolean } = {}
  ): Promise<string> {
    await this.ensureClientForBucket();
    const newKey = this.getStateKey(stackName, region);
    const { expectedEtag, migrateLegacy } = options;

    // Normalize the body: schema version + region are load-bearing on disk.
    const body: StackState = {
      ...state,
      version: STATE_SCHEMA_VERSION_CURRENT,
      stackName,
      region,
    };

    try {
      this.logger.debug(
        `Saving state: ${stackName} (${region})${expectedEtag ? `, expected ETag: ${expectedEtag}` : ''}`
      );

      const bodyString = JSON.stringify(body, null, 2);
      const response = await this.s3Client.send(
        new PutObjectCommand({
          Bucket: this.config.bucket,
          ...(await this.ownerParam()),
          Key: newKey,
          Body: bodyString,
          ContentLength: Buffer.byteLength(bodyString),
          ContentType: 'application/json',
          // The legacy ETag is for a different key; only forward it when we're
          // updating in-place at the new key.
          ...(!migrateLegacy && expectedEtag && { IfMatch: expectedEtag }),
        })
      );

      if (!response.ETag) {
        throw new StateError(
          `No ETag returned after saving state for stack '${stackName}' (${region})`
        );
      }
      this.logger.debug(`State saved: ${stackName} (${region}), new ETag: ${response.ETag}`);

      // Migration tail: best-effort delete of the legacy key. We don't fail
      // the save if this errors — the new key is the source of truth and a
      // residual legacy key is recoverable (next call will migrate again).
      if (migrateLegacy) {
        try {
          await this.s3Client.send(
            new DeleteObjectCommand({
              Bucket: this.config.bucket,
              ...(await this.ownerParam()),
              Key: this.getLegacyStateKey(stackName),
            })
          );
          this.logger.info(
            `Migrated state for stack '${stackName}' to region-scoped layout (${region})`
          );
        } catch (deleteError) {
          this.logger.warn(
            `Migrated stack '${stackName}' to new key, but failed to delete legacy key: ` +
              `${deleteError instanceof Error ? deleteError.message : String(deleteError)}`
          );
        }
      }

      return response.ETag;
    } catch (error) {
      if ((error as { name: string }).name === 'PreconditionFailed') {
        throw new StateError(
          `State has been modified by another process. Expected ETag: ${expectedEtag}, but state has changed.`
        );
      }

      const normalized = normalizeAwsError(error, {
        bucket: this.config.bucket,
        operation: 'PutObject',
      });
      throw new StateError(
        `Failed to save state for stack '${stackName}' (${region}): ${normalized.message}`,
        normalized
      );
    }
  }

  /**
   * Delete state for a stack in the given region.
   *
   * Removes both the new key and the legacy key (if present). Legacy removal
   * is region-conditional: a legacy state file with a different `region`
   * field is left alone.
   */
  async deleteState(stackName: string, region: string): Promise<void> {
    await this.ensureClientForBucket();
    try {
      this.logger.debug(`Deleting state: ${stackName} (${region})`);

      await this.s3Client.send(
        new DeleteObjectCommand({
          Bucket: this.config.bucket,
          ...(await this.ownerParam()),
          Key: this.getStateKey(stackName, region),
        })
      );

      // Sweep the legacy key only if it belongs to the same region.
      if (await this.legacyMatchesRegion(stackName, region)) {
        await this.s3Client.send(
          new DeleteObjectCommand({
            Bucket: this.config.bucket,
            ...(await this.ownerParam()),
            Key: this.getLegacyStateKey(stackName),
          })
        );
        this.logger.debug(`Deleted legacy state for stack: ${stackName}`);
      }

      // Sweep the rollback journal (issue #1183) so `cdkd destroy` /
      // `cdkd state destroy` leave no dangling revert data behind.
      await this.deleteRollbackJournal(stackName, region);

      this.logger.debug(`State deleted: ${stackName} (${region})`);
    } catch (error) {
      const normalized = normalizeAwsError(error, {
        bucket: this.config.bucket,
        operation: 'DeleteObject',
      });
      throw new StateError(
        `Failed to delete state for stack '${stackName}' (${region}): ${normalized.message}`,
        normalized
      );
    }
  }

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
  async listStacks(): Promise<StackStateRef[]> {
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
            ...(continuationToken && { ContinuationToken: continuationToken }),
          })
        );

        for (const obj of response.Contents ?? []) {
          const key = obj.Key;
          if (!key) continue;
          if (!key.endsWith('/state.json')) continue;

          const rest = key.slice(prefix.length);
          const segments = rest.split('/');

          // New key: {stackName}/{region}/state.json
          if (segments.length === NEW_KEY_DEPTH) {
            const [stackName, region] = segments;
            if (!stackName || !region) continue;
            const dedupeKey = `${stackName}\0${region}`;
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
            const dedupeKey = `${stackName}\0${region ?? ''}`;
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
      throw new StateError(`Failed to list stacks: ${normalized.message}`, normalized);
    }
  }

  /**
   * Raw sidecar-object write under the state bucket. Used for non-state
   * auxiliary files that share the bucket + region-resolution plumbing
   * (e.g. deployment-event JSONL streams + their `index.json`, issue
   * #808) without going through the state-schema validation that
   * `saveState` applies. No optimistic locking — callers own their key
   * uniqueness / last-writer-wins semantics.
   */
  async putRawObject(key: string, body: string, contentType = 'application/json'): Promise<void> {
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
   * Raw sidecar-object read under the state bucket. Returns `null` when
   * the key does not exist; other errors propagate.
   */
  async getRawObject(key: string): Promise<string | null> {
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
  async listRawKeys(keyPrefix: string): Promise<string[]> {
    await this.ensureClientForBucket();
    const keys: string[] = [];
    let continuationToken: string | undefined;
    do {
      const response = await this.s3Client.send(
        new ListObjectsV2Command({
          Bucket: this.config.bucket,
          ...(await this.ownerParam()),
          Prefix: keyPrefix,
          ...(continuationToken && { ContinuationToken: continuationToken }),
        })
      );
      for (const obj of response.Contents ?? []) {
        if (obj.Key) keys.push(obj.Key);
      }
      continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
    } while (continuationToken);
    return keys;
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
  async deleteRawObjects(keys: string[]): Promise<void> {
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
        failures.push(`${err.Key ?? '<unknown>'} (${err.Code ?? 'Error'}: ${err.Message ?? ''})`);
      }
    }
    if (failures.length > 0) {
      throw new StateError(
        `Failed to delete ${failures.length} object(s) from bucket '${this.config.bucket}': ${failures.join('; ')}`
      );
    }
  }

  /**
   * Load the rollback journal for a stack (issue #1183). Returns `null` when
   * no journal exists (the common case — a journal only lives between a
   * failed/interrupted deploy and its `cdkd rollback`). Throws
   * {@link UnknownRollbackJournalVersionError} on a newer-version journal.
   */
  async loadRollbackJournal(stackName: string, region: string): Promise<RollbackJournal | null> {
    const body = await this.getRawObject(this.getRollbackJournalKey(stackName, region));
    if (body === null) return null;
    return parseRollbackJournal(body, stackName);
  }

  /**
   * Append one segment to the stack's rollback journal, creating it if
   * absent. Existing segments are preserved (never overwritten) so
   * consecutive failed deploys accumulate one segment each. Every writer
   * holds the stack lock, so no optimistic locking is needed.
   */
  async appendRollbackJournalSegment(
    stackName: string,
    region: string,
    segment: RollbackJournalSegment
  ): Promise<void> {
    const existing = await this.loadRollbackJournal(stackName, region);
    const journal: RollbackJournal = existing ?? {
      journalVersion: ROLLBACK_JOURNAL_VERSION,
      stackName,
      region,
      segments: [],
    };
    journal.segments.push(segment);
    await this.putRawObject(
      this.getRollbackJournalKey(stackName, region),
      JSON.stringify(journal, null, 2)
    );
  }

  /**
   * Replace the `failedOperations` list on the NEWEST journal segment
   * (issue #1198) with the ops STILL pending after a `--revert-failed`
   * replay — an empty list removes the field. Called right after the
   * failed-op replay, BEFORE the segment's completed ops replay, so a later
   * completed-op failure that keeps the segment for a re-run does not
   * re-issue the already-applied failed-op reverts (the journal's
   * `attemptedProperties` would generate a patch undoing changes that are no
   * longer present, which can fail on patch-based providers). Per-op — a
   * partially-successful replay strips only the handled ops. No-op when the
   * journal / segment / field is absent.
   */
  async setRollbackJournalFailedOperations(
    stackName: string,
    region: string,
    remaining: FailedOperation[]
  ): Promise<void> {
    const journal = await this.loadRollbackJournal(stackName, region);
    const newest = journal?.segments[journal.segments.length - 1];
    if (!journal || !newest || !newest.failedOperations) return;
    if (remaining.length === 0) delete newest.failedOperations;
    else newest.failedOperations = remaining;
    await this.putRawObject(
      this.getRollbackJournalKey(stackName, region),
      JSON.stringify(journal, null, 2)
    );
  }

  /**
   * Pop the newest segment off the stack's rollback journal after it has
   * been fully replayed. When the last segment is removed, the journal
   * object is deleted entirely. Returns the number of segments remaining.
   */
  async popRollbackJournalSegment(stackName: string, region: string): Promise<number> {
    const journal = await this.loadRollbackJournal(stackName, region);
    if (!journal || journal.segments.length === 0) {
      await this.deleteRollbackJournal(stackName, region);
      return 0;
    }
    journal.segments.pop();
    if (journal.segments.length === 0) {
      await this.deleteRollbackJournal(stackName, region);
      return 0;
    }
    await this.putRawObject(
      this.getRollbackJournalKey(stackName, region),
      JSON.stringify(journal, null, 2)
    );
    return journal.segments.length;
  }

  /**
   * Delete the stack's rollback journal object (idempotent). Called on the
   * deploy success path, after a clean rollback, and via {@link deleteState}
   * so `cdkd destroy` / `cdkd state destroy` sweep it too.
   */
  async deleteRollbackJournal(stackName: string, region: string): Promise<void> {
    await this.ensureClientForBucket();
    try {
      await this.s3Client.send(
        new DeleteObjectCommand({
          Bucket: this.config.bucket,
          ...(await this.ownerParam()),
          Key: this.getRollbackJournalKey(stackName, region),
        })
      );
    } catch (error) {
      // Best-effort: a missing journal is not an error; other failures warn.
      if (isNoSuchKey(error) || (error as { name?: string }).name === 'NotFound') return;
      this.logger.warn(
        `Failed to delete rollback journal for '${stackName}' (${region}): ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * HeadObject probe — returns true on 200, false on NotFound. Other errors
   * propagate so we don't accidentally swallow IAM denials.
   */
  private async headObject(key: string): Promise<boolean> {
    try {
      await this.s3Client.send(
        new HeadObjectCommand({
          Bucket: this.config.bucket,
          ...(await this.ownerParam()),
          Key: key,
        })
      );
      return true;
    } catch (error) {
      if (isNoSuchKey(error) || (error as { name?: string }).name === 'NotFound') {
        return false;
      }
      throw error;
    }
  }

  /**
   * Read the legacy state's `region` field. Used for region matching during
   * `stateExists` / `deleteState` and for assigning a region to legacy
   * entries during `listStacks`.
   */
  private async readLegacyRegion(stackName: string): Promise<string | undefined> {
    try {
      const response = await this.s3Client.send(
        new GetObjectCommand({
          Bucket: this.config.bucket,
          ...(await this.ownerParam()),
          Key: this.getLegacyStateKey(stackName),
        })
      );
      if (!response.Body) return undefined;
      const bodyString = await response.Body.transformToString();
      const state = JSON.parse(bodyString) as Partial<StackState>;
      return typeof state.region === 'string' ? state.region : undefined;
    } catch (error) {
      if (isNoSuchKey(error)) return undefined;
      // Don't fail the whole list on a single bad legacy file — log & skip.
      this.logger.debug(
        `Could not read legacy state region for '${stackName}': ${error instanceof Error ? error.message : String(error)}`
      );
      return undefined;
    }
  }

  private async legacyMatchesRegion(stackName: string, region: string): Promise<boolean> {
    const legacyRegion = await this.readLegacyRegion(stackName);
    return legacyRegion === region;
  }

  /**
   * Try to read the legacy `version: 1` state. Returns null when the legacy
   * key is missing or its embedded region does not match the caller's region.
   */
  private async tryGetLegacy(
    stackName: string,
    region: string
  ): Promise<{ state: StackState; etag: string } | null> {
    try {
      const response = await this.s3Client.send(
        new GetObjectCommand({
          Bucket: this.config.bucket,
          ...(await this.ownerParam()),
          Key: this.getLegacyStateKey(stackName),
        })
      );

      if (!response.Body || !response.ETag) {
        return null;
      }

      const bodyString = await response.Body.transformToString();
      const state = this.parseStateBody(bodyString, stackName);

      // Region gate: the same `stackName` may have lived in a different region
      // before the user changed `env.region`. We do NOT want to silently load
      // that record for a different target region — that's the silent-failure
      // bug PR 1 fixes.
      if (state.region && state.region !== region) {
        this.logger.debug(
          `Legacy state for stack '${stackName}' has region '${state.region}', ` +
            `not '${region}' — skipping legacy fallback.`
        );
        return null;
      }

      return { state, etag: response.ETag };
    } catch (error) {
      if (isNoSuchKey(error)) return null;
      throw new StateError(
        `Failed to get legacy state for stack '${stackName}': ${error instanceof Error ? error.message : String(error)}`,
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Parse a state body and validate the schema version. Future-proofs against
   * a binary that predates schema version `N` reading a `version: N+1` blob:
   * the old binary would otherwise treat unknown fields as defaults and
   * silently lose data on the next save.
   */
  private parseStateBody(bodyString: string, stackName: string): StackState {
    let parsed: StackState;
    try {
      parsed = JSON.parse(bodyString) as StackState;
    } catch (error) {
      throw new StateError(
        `State file for stack '${stackName}' is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
        error instanceof Error ? error : undefined
      );
    }

    const v = parsed.version;
    if (v !== undefined && !STATE_SCHEMA_VERSIONS_READABLE.includes(v)) {
      throw new StateError(
        `Unsupported state schema version ${String(v)} for stack '${stackName}'. ` +
          `This cdkd binary supports versions ${STATE_SCHEMA_VERSIONS_READABLE.join(', ')}. ` +
          `Upgrade cdkd to a version that supports schema ${String(v)}.`
      );
    }

    return parsed;
  }
}

/**
 * Treat S3 NoSuchKey-equivalents uniformly. The SDK throws `NoSuchKey` from
 * `GetObject` and `{name: 'NoSuchKey'}` from low-level callsites; HeadObject
 * raises `{name: 'NotFound'}` instead.
 */
function isNoSuchKey(error: unknown): boolean {
  if (error instanceof NoSuchKey) return true;
  const name = (error as { name?: string } | null)?.name;
  return name === 'NoSuchKey';
}
