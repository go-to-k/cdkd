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
import { displaySafe } from '../utils/display-safe.js';
import { describeAwsFailure } from '../utils/aws-failure-text.js';
import { UNRENDERABLE } from './lock-contention-message.js';
import { StateError, normalizeAwsError } from '../utils/error-handler.js';
import { rebuildClientForBucketRegion } from '../utils/bucket-region-client.js';
import {
  purgeNoncurrentKeyVersions,
  type NoncurrentVersionPurgeOptions,
} from './s3-noncurrent-version-purge.js';

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
/**
 * `{stack}/state.json` — one segment plus the file, i.e. the v1 region-less
 * layout. Exported because `state-file-keys.ts` classifies the same layouts
 * from the other side and the two must not drift (issue #2001).
 */
export const LEGACY_KEY_DEPTH = 2;
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
 * Options for {@link S3StateBackend.verifyBucketExists}.
 */
export interface VerifyBucketExistsOptions {
  /**
   * Set when the caller ALREADY proved the bucket exists moments earlier with
   * the same credentials — today only the default-state-bucket resolution in
   * `config-loader.ts`, which `HeadBucket`s both candidate names to choose
   * between them (see `stateBucketExistenceConfirmed`). Skips the duplicate
   * `HeadBucket` round trip on the deploy preflight's critical path (issue
   * [#1283](https://github.com/go-to-k/cdkd/issues/1283)).
   *
   * The region resolution / client rebuild is NOT skipped — only the HEAD.
   *
   * Never set it for an explicitly-specified bucket (`--state-bucket` /
   * `CDKD_STATE_BUCKET` / `cdk.json`): those are taken verbatim, were never
   * probed, and must keep failing fast here before asset uploads / Docker
   * builds run against a missing bucket.
   */
  existenceAlreadyProbed?: boolean;
}

/**
 * What the legacy `{prefix}/{stackName}/state.json` key holds, as four
 * distinct answers rather than the single `undefined` that collapsed them
 * (issue #2550).
 *
 * The collapse is what made the destroy bug hard to fix safely: `absent`,
 * `no-region` and `unreadable` all read as "no region", so a caller could not
 * tell "there is no record" from "there is a record that names no region"
 * from "I could not look". The delete sweep needs the middle one to mean YES
 * and `stateExists` needs the other two to mean NO.
 *
 * `absent` is the NoSuchKey answer specifically. Without `s3:ListBucket` S3
 * reports a missing object as AccessDenied instead, which lands in
 * `unreadable` — harmless, since both consumers answer the same way to both,
 * but it is why `absent` must not be read as "definitely nothing there".
 */
type LegacyStateProbe =
  | { kind: 'absent' }
  | { kind: 'no-region' }
  | { kind: 'region'; region: string }
  | { kind: 'unreadable'; reason: string };

/**
 * Does a legacy record classified by {@link LegacyStateProbe} belong to an
 * operation targeting `region`?
 *
 * Free function, and shared by both consumers on purpose: the delete sweep
 * needs the probe's KIND as well as this verdict (to warn when a record may
 * have been left behind), and duplicating the mapping at that call site is
 * how the two would drift apart again.
 */
function legacyProbeBelongsTo(probe: LegacyStateProbe, region: string): boolean {
  switch (probe.kind) {
    case 'region':
      return probe.region === region;
    case 'no-region':
      // `tryGetLegacy` hands this record to ANY region, so the sweep must
      // accept it from any region too — issue #2550.
      return true;
    case 'absent':
    case 'unreadable':
      // A read that failed says nothing about who owns the record, and must
      // never authorise a delete.
      return false;
  }
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
  /**
   * Release the S3 client this backend currently holds.
   *
   * The backend OWNS its client and may destroy and REPLACE it
   * (`ensureClientForBucket` rebuilds when the bucket turns out to live in
   * another region). So a caller that keeps its own reference and destroys
   * that instead destroys the dead original and leaks the live replacement —
   * which is exactly what a short-lived probe backend does in the cross-region
   * case. Callers that construct a throwaway backend use this instead.
   */
  destroyClient(): void {
    this.s3Client.destroy();
  }

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

  async verifyBucketExists(options: VerifyBucketExistsOptions = {}): Promise<void> {
    // ALWAYS run — this is the `GetBucketLocation` + region-correct client
    // rebuild that every later state operation depends on. Only the
    // `HeadBucket` below is skippable.
    await this.ensureClientForBucket();
    if (options.existenceAlreadyProbed) {
      this.logger.debug(
        `Skipping the redundant HeadBucket on '${this.config.bucket}' — the default-name ` +
          `resolution already confirmed it exists with these credentials (issue #1283).`
      );
      return;
    }
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

    return this.legacyBelongsToRegion(stackName, region);
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
      const legacyProbe = await this.probeLegacyState(stackName);
      if (legacyProbe.kind === 'unreadable') {
        // Refusing here is right — a read that failed must not authorise a
        // delete — but the outcome is issue #2550's symptom exactly: a record
        // surviving a destroy that reported success. Say it at WARN so it is
        // not a silent no-op the way the original bug was.
        // Deliberately just the fact. Earlier drafts named the S3 key, built
        // a pasteable `cdkd state orphan <name>` and prescribed a permission
        // grant; every one of those clauses was a defect. The key embeds the
        // raw stack name, so rendering it re-opened the injection the other
        // clauses had sanitized. `displaySafe` keeps `'`, so the quoted
        // command could be broken out of — and it maps non-ASCII to a space,
        // so the name in it may not be the stack's. The remedy needs
        // `s3:ListBucket`, which is the permission whose absence produces the
        // commonest instance of this warning. The operator knows the stack
        // they just destroyed; what they cannot see is that a record may have
        // survived it.
        const safeName = this.displayName(stackName);
        this.logger.warn(
          `Could not read the legacy state record for '${safeName}' while cleaning up ` +
            `(${legacyProbe.reason}). If one exists it was left in place. ` +
            `Re-run with --verbose for the details.`
        );
      }
      if (legacyProbeBelongsTo(legacyProbe, region)) {
        await this.s3Client.send(
          new DeleteObjectCommand({
            Bucket: this.config.bucket,
            ...(await this.ownerParam()),
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
    } finally {
      // Sweep the rollback journal (issue #1183) so `cdkd destroy` /
      // `cdkd state destroy` leave no dangling revert data behind.
      //
      // In a `finally`, NOT inside the try above, because of what the journal
      // holds (issue #2346 site 4). It was reached only after both state
      // deletes had succeeded, so a throttled or denied `DeleteObject` on
      // `state.json` threw first and the journal — whose
      // `failedOperations[].attemptedProperties` records the failed write's
      // properties verbatim, measured once as a literal `MasterUserPassword` —
      // survived with its CURRENT object and its whole history intact, no
      // purge and no warning, while this method's own docs promised the sweep
      // ran on every destroy path. That is the same exit-path class as the
      // partial-delete gap `cdkd gc` closes with its own `finally`.
      //
      // A `finally` rather than moving it AHEAD of the state deletes: ordering
      // it first would delete the revert data before the state it reverts,
      // so an interrupted `cdkd destroy` would leave a state file with no
      // journal — strictly worse than the reverse. `deleteRollbackJournal` is
      // best-effort and never throws, so it cannot replace the in-flight
      // StateError.
      await this.deleteRollbackJournal(stackName, region);
    }
  }

  /**
   * Delete a legacy state file that names no region (issue #2537).
   *
   * `deleteState` cannot serve this case: it takes a region, keys the primary
   * delete off it, and sweeps the legacy key only when that key's own `region`
   * field matches. A `version: 1` blob whose body carries no `region` at all
   * has nothing to match, so it falls through every branch there — which is
   * how `cdkd state orphan` came to report a removal it never performed.
   *
   * Unconditional, and deliberately so — but NOT because the caller's ref
   * proves the body names no region. `listStacks` derives that ref from
   * `readLegacyRegion`, which also returns undefined on a swallowed 403 / 503
   * / unparseable body, so a record that DOES name a region can surface
   * region-less. The delete is still right there: the caller
   * (`cdkd state orphan` with no `--stack-region`) means "every record for
   * this name", and this key is one of them. A caller that means something
   * narrower must not use this method.
   *
   * No rollback-journal sweep: journal keys exist only in the region-scoped
   * layout (see `getRollbackJournalKey`), so a region-less record can have
   * none.
   */
  async deleteLegacyState(stackName: string): Promise<void> {
    await this.ensureClientForBucket();
    const key = this.getLegacyStateKey(stackName);
    try {
      // Sanitized: `stackName` reaches here from an S3 key listing, and
      // `formatError` prints a message verbatim — there is no central
      // sanitization downstream (issue #2170's class).
      // `key` embeds `stackName` verbatim, so logging it raw would defeat
      // the sanitization on the line it sits in.
      const safeStack = displaySafe(stackName, { asciiOnly: true }) || UNRENDERABLE;
      this.logger.debug(
        `Deleting legacy state: ${safeStack} (${displaySafe(key, { asciiOnly: true }) || UNRENDERABLE})`
      );
      await this.s3Client.send(
        new DeleteObjectCommand({
          Bucket: this.config.bucket,
          ...(await this.ownerParam()),
          Key: key,
        })
      );
      this.logger.debug(`Legacy state deleted: ${safeStack}`);
    } catch (error) {
      const normalized = normalizeAwsError(error, {
        bucket: this.config.bucket,
        operation: 'DeleteObject',
      });
      throw new StateError(
        `Failed to delete legacy state for stack ` +
          `'${displaySafe(stackName, { asciiOnly: true }) || UNRENDERABLE}': ` +
          `${normalized.message}`,
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
  async listRawObjects(
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
          this.logger.debug(
            `listRawObjects: dropping an entry under '${keyPrefix}' ` +
              `(key: ${obj.Key ?? '<none>'}) — ListObjectsV2 returned no ${missing}`
          );
          continue;
        }
        objects.push({ key: obj.Key, lastModified: obj.LastModified, size: obj.Size });
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
   * Delete the NONCURRENT versions of raw sidecar keys in the state bucket
   * (issue [#2340](https://github.com/go-to-k/cdkd/issues/2340)).
   *
   * The versioned-bucket companion to {@link deleteRawObjects}, and
   * deliberately NOT folded into it. `deleteRawObjects` has SIX call sites,
   * ENUMERATED rather than given as a grep so that a comment quoting the
   * command cannot end up matching itself and reporting seven:
   * `deployment-events-store.ts` x4, `gc.ts`, `bootstrap-destroy.ts`. Four of
   * the six are in `deployment-events-store.ts`, whose objects
   * `tests/integration/s3-versions.sh` records as deliberately surviving as
   * CURRENT objects; a blanket purge there would
   * change that behaviour AND widen the IAM every caller needs
   * (`s3:ListBucketVersions`, `s3:DeleteObjectVersion`). So the purge is
   * opt-in, and today `cdkd gc`'s custom-resource response sweep is the one
   * caller that opts in.
   *
   * NEVER THROWS, and the try/catch below is what makes that true rather than
   * the helper alone. `ensureClientForBucket()` and `ownerParam()` sit OUTSIDE
   * the helper's guarantee and both reach AWS — `GetBucketLocation` can be
   * denied or throttled. Without the wrap, that rejection escaped at
   * `gc.ts`'s call site and skipped the `✓ Deleted ...` line after the delete
   * had already succeeded, which is precisely the outcome the comment there
   * says is impossible.
   */
  async purgeNoncurrentVersions(
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
          `key(s) by hand. Underlying error: ` +
          `${error instanceof Error ? error.message : String(error)}`
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
   *
   * TWO steps, and the second is not housekeeping (issue
   * [#2346](https://github.com/go-to-k/cdkd/issues/2346) site 4). `cdkd
   * bootstrap` turns VERSIONING ON for the state bucket, so the
   * `DeleteObject` above only writes a DELETE MARKER and leaves every prior
   * version of the journal readable through `GetObject` with a `VersionId`.
   * The journal's `failedOperations[].attemptedProperties` is the PROPERTIES
   * OF THE FAILED WRITE, verbatim — measured 2026-08-20 on
   * `CdkdDeletionPolicySnapshotHeavyExample` as four surviving versions each
   * carrying a literal `"MasterUserPassword": "Cdkdcf2f..."` after cdkd
   * reported the state deleted (recorded in the `s3_stack_prefix` comment of
   * `tests/integration/s3-versions.sh`, ~line 270). A
   * delete-only cleanup therefore reports success while the credential stays
   * retrievable by anyone holding `s3:GetObjectVersion`.
   *
   * Unlike `state.json` — whose noncurrent versions ARE the state-recovery
   * capability versioning is enabled FOR, which is why {@link deleteState}
   * deliberately does NOT purge — the journal is TRANSIENT by design: it
   * exists only between a failed / interrupted deploy and its `cdkd
   * rollback`. There is no recovery capability to weigh against the purge.
   *
   * The purge runs UNCONDITIONALLY, including on the arm where the delete
   * failed. `purgeNoncurrentKeyVersions` filters on `IsLatest`, so a key
   * whose delete failed keeps its current version intact and only its history
   * goes — the worst case is that the object survives while its old bodies do
   * not, which is the safe direction. Skipping the purge when the delete
   * threw would leave every readable version behind with no warning at all,
   * the same partial-failure gap `cdkd gc` closed with its `finally`.
   */
  async deleteRollbackJournal(stackName: string, region: string): Promise<void> {
    await this.ensureClientForBucket();
    const key = this.getRollbackJournalKey(stackName, region);
    try {
      await this.s3Client.send(
        new DeleteObjectCommand({
          Bucket: this.config.bucket,
          ...(await this.ownerParam()),
          Key: key,
        })
      );
    } catch (error) {
      // Best-effort: a missing journal is not an error; other failures warn.
      // Neither arm RETURNS — an early return here used to skip the purge
      // below, and a not-found CURRENT object says nothing about whether
      // noncurrent versions of the key survive (on a versioned bucket a prior
      // delete leaves a marker as current and every body still readable).
      if (!isNoSuchKey(error) && (error as { name?: string }).name !== 'NotFound') {
        this.logger.warn(
          `Failed to delete rollback journal for '${stackName}' (${region}): ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
    // Delegated to the SHARED purge rather than open-coded, for the reason
    // `s3-noncurrent-version-purge.ts` gives: a copy per call site is how one
    // of them keeps the defect after the other is fixed. It never throws, so
    // this method's best-effort contract holds by construction.
    await this.purgeNoncurrentVersions([key], {
      objectDescription:
        'the rollback journal, whose `failedOperations[].attemptedProperties` records the properties of the failed write verbatim',
    });
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
   * Read the legacy key and classify what is there — {@link LegacyStateProbe}
   * says what each answer means and which consumer acts on it.
   */
  /**
   * A stack name safe to put in a log line. Names reach this class from S3
   * key segments, which anyone able to write the bucket controls, so every
   * message that renders one goes through here (issue #2170's class).
   */
  private displayName(stackName: string): string {
    return displaySafe(stackName, { asciiOnly: true }) || UNRENDERABLE;
  }

  private async probeLegacyState(stackName: string): Promise<LegacyStateProbe> {
    try {
      const response = await this.s3Client.send(
        new GetObjectCommand({
          Bucket: this.config.bucket,
          ...(await this.ownerParam()),
          Key: this.getLegacyStateKey(stackName),
        })
      );
      if (!response.Body) {
        this.logger.debug(
          `Legacy state probe for '${this.displayName(stackName)}': response carried no body`
        );
        return { kind: 'unreadable', reason: 'the response carried no body' };
      }
      const bodyString = await response.Body.transformToString();
      const state = JSON.parse(bodyString) as Partial<StackState>;
      // Mirror `tryGetLegacy`'s gate — `if (state.region && state.region !==
      // region)` — clause for clause, because the delete side has to accept
      // exactly the records the read side hands out:
      //
      //   falsy (undefined / null / '')   gate passes  -> readable from ANY region
      //   truthy string                   gate compares
      //   truthy NON-string (123, [...])  gate refuses from EVERY region
      //
      // A `typeof === 'string'` test is not enough for the last one: it sorts
      // a mangled `"region": 123` in with the region-less bodies, so the sweep
      // would delete a record `getState` will not even read. That is issue
      // #2550's read/delete asymmetry again, pointing the other way. `''` is
      // the same trap mirrored: a string, but falsy, so the read accepts it
      // from anywhere while an equality test would refuse to sweep it.
      const raw = (state as { region?: unknown }).region;
      if (!raw) return { kind: 'no-region' };
      if (typeof raw !== 'string') {
        // `typeof` only — never the value, which is body content. It is a
        // bounded token (one of seven), so it is safe in `reason` too and
        // tells the operator whether the field is a number, an array or an
        // object without showing them any of it.
        this.logger.debug(
          `Legacy state probe for '${this.displayName(stackName)}': ` +
            `'region' is ${typeof raw}, not a string`
        );
        return { kind: 'unreadable', reason: `its 'region' field is ${typeof raw}, not a string` };
      }
      return { kind: 'region', region: raw };
    } catch (error) {
      if (isNoSuchKey(error)) return { kind: 'absent' };
      // Don't fail the whole list on a single bad legacy file — log & skip.
      // `reason` is a BOUNDED value — an error class name, never a message.
      //
      // `describeAwsFailure().summary` is not safe here: it withholds AWS's
      // own wording only for AWS-AUTHORED failures, and returns `error.message`
      // verbatim for anything else. The failure that matters is `JSON.parse`
      // on the body, whose V8 `SyntaxError` embeds ~30 characters OF THAT BODY
      // in its message — so a principal able to write the state bucket could
      // put terminal escapes, or a neighbouring plaintext property value, into
      // a default-verbosity warn. A class name cannot carry either.
      const { detail } = describeAwsFailure(error);
      // Sanitized, unlike the usual detail-at-debug site: the failure that
      // reaches here is `JSON.parse` on the legacy body, so `detail` is a
      // snippet OF THAT BODY rather than AWS's own wording. Debug is quieter
      // than warn, not a different terminal.
      this.logger.debug(
        `Could not read legacy state region for '${this.displayName(stackName)}': ` +
          `${displaySafe(detail, { asciiOnly: true }) || UNRENDERABLE}`
      );
      const cls = error instanceof Error && error.name ? error.name : 'an unknown error';
      return { kind: 'unreadable', reason: displaySafe(cls, { asciiOnly: true }) || UNRENDERABLE };
    }
  }

  /**
   * The region a legacy record should be listed under, or `undefined` when it
   * names none / could not be read. Preserves `listStacks`'s behaviour across
   * the {@link probeLegacyState} split.
   */
  private async readLegacyRegion(stackName: string): Promise<string | undefined> {
    const probe = await this.probeLegacyState(stackName);
    return probe.kind === 'region' ? probe.region : undefined;
  }

  /**
   * Whether an operation targeting `region` owns the legacy record — the
   * DELETE-side counterpart of `tryGetLegacy`'s read gate, and issue #2550.
   *
   * The two must agree. `tryGetLegacy` accepts a body that names NO region
   * from any region (`if (state.region && state.region !== region)` is false
   * when the field is absent), so `cdkd destroy` reads such a record, deletes
   * the AWS resources, and finishes. The old equality test here answered
   * `undefined === 'us-east-1'` — false — so the record survived a successful
   * destroy, kept appearing in `cdkd state list`, and the next deploy of that
   * name planned updates against resources that were gone.
   *
   * `unreadable` is deliberately NOT treated as `no-region`: a 403, a 503 or a
   * malformed body says nothing about who owns the record, and a read that
   * failed must never authorise a delete. It collapsed into the same
   * `undefined` as the other two before, which is why the one-line fix — make
   * `undefined` match — was wrong: it would also have made `stateExists`
   * report state for a stack that has none, since `absent` reads the same way.
   */
  private async legacyBelongsToRegion(stackName: string, region: string): Promise<boolean> {
    return legacyProbeBelongsTo(await this.probeLegacyState(stackName), region);
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
