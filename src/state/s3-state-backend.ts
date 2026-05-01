import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  NoSuchKey,
} from '@aws-sdk/client-s3';
import {
  STATE_SCHEMA_VERSION_CURRENT,
  STATE_SCHEMA_VERSION_LEGACY,
  type StackState,
} from '../types/state.js';
import type { StateBackendConfig } from '../types/config.js';
import { getLogger } from '../utils/logger.js';
import { StateError, normalizeAwsError } from '../utils/error-handler.js';
import { resolveBucketRegion } from '../utils/aws-region-resolver.js';

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
  private clientResolved = false;
  private resolveInFlight: Promise<void> | null = null;

  constructor(
    private s3Client: S3Client,
    private config: StateBackendConfig,
    private clientOpts: S3ClientOptions = {}
  ) {}

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
        const currentRegion = await this.s3Client.config.region();
        const fallbackRegion = typeof currentRegion === 'string' ? currentRegion : undefined;
        const bucketRegion = await resolveBucketRegion(this.config.bucket, {
          ...(this.clientOpts.profile && { profile: this.clientOpts.profile }),
          ...(this.clientOpts.credentials && { credentials: this.clientOpts.credentials }),
          ...(fallbackRegion && { fallbackRegion }),
        });

        if (bucketRegion !== currentRegion) {
          this.logger.debug(
            `State bucket '${this.config.bucket}' is in '${bucketRegion}' (client was '${currentRegion}'); rebuilding S3 client.`
          );
          const oldClient = this.s3Client;
          this.s3Client = new S3Client({
            region: bucketRegion,
            ...(this.clientOpts.profile && { profile: this.clientOpts.profile }),
            ...(this.clientOpts.credentials && { credentials: this.clientOpts.credentials }),
            // Suppress "Are you using a Stream of unknown length" warning,
            // matching the suppression in AwsClients.
            logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
          });
          oldClient.destroy();
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
  async verifyBucketExists(): Promise<void> {
    await this.ensureClientForBucket();
    try {
      await this.s3Client.send(new HeadBucketCommand({ Bucket: this.config.bucket }));
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
   * `cdkd state rm <stack> --region X` and `cdkd destroy <stack>` see legacy
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
          Key: this.getStateKey(stackName, region),
        })
      );

      // Sweep the legacy key only if it belongs to the same region.
      if (await this.legacyMatchesRegion(stackName, region)) {
        await this.s3Client.send(
          new DeleteObjectCommand({
            Bucket: this.config.bucket,
            Key: this.getLegacyStateKey(stackName),
          })
        );
        this.logger.debug(`Deleted legacy state for stack: ${stackName}`);
      }

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
   * HeadObject probe — returns true on 200, false on NotFound. Other errors
   * propagate so we don't accidentally swallow IAM denials.
   */
  private async headObject(key: string): Promise<boolean> {
    try {
      await this.s3Client.send(
        new HeadObjectCommand({
          Bucket: this.config.bucket,
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
    if (
      v !== STATE_SCHEMA_VERSION_LEGACY &&
      v !== STATE_SCHEMA_VERSION_CURRENT &&
      v !== undefined
    ) {
      throw new StateError(
        `Unsupported state schema version ${String(v)} for stack '${stackName}'. ` +
          `This cdkd binary supports versions ${String(STATE_SCHEMA_VERSION_LEGACY)} and ${String(STATE_SCHEMA_VERSION_CURRENT)}. ` +
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
