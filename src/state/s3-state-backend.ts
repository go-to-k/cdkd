import { S3Client, ListObjectsV2Command } from '@aws-sdk/client-s3';
import type { StackState } from '../types/state.js';
import type { StateBackendConfig } from '../types/config.js';
import type {
  ImportedResourceMark,
  RollbackJournal,
  RollbackJournalSegment,
} from '../types/rollback-journal.js';
import type { CreateTokenLedgerDoc } from './create-token-ledger.js';
import { STACK_INSTANCE_SIBLING_FILE } from './stack-instance-id.js';
import type { FailedOperation } from '../deployment/rollback-executor.js';
import { getLogger } from '../utils/logger.js';
import { expectedOwnerParam } from '../utils/expected-bucket-owner.js';
import { LISTING_ENCODING_TYPE } from '../utils/s3-listing-keys.js';
import {
  CrossPrefixReadError,
  recordCanOwnResources,
  type RecordUnderPrefix,
} from './cross-prefix-stack-scan.js';
import {
  displayIdent,
  displaySafe,
  displayStackName,
  safeMsg,
  STACK_REF_MAX_CODE_POINTS,
} from '../utils/display-safe.js';
import { describeAwsFailure } from '../utils/aws-failure-text.js';
import { markRedactedCause } from '../deployment/retryable-errors/marks.js';
import { currentLogLineMasker } from '../utils/log-line-masker.js';
import { describeJsonParseFailure, utf8ByteLength } from '../utils/json-parse-failure.js';
import { UNRENDERABLE } from './lock-contention-message.js';
import type { EarlierStateRecord } from './earlier-state-versions.js';
import { StateError } from '../utils/error-handler.js';
import {
  purgeNoncurrentVersionsUnderPrefix,
  type NoncurrentVersionPurgeOptions,
  type PrefixPurgeResult,
} from './s3-noncurrent-version-purge.js';
import {
  errorDetail,
  type StackStateRef,
  type S3ClientOptions,
  type VerifyBucketExistsOptions,
  type LegacyStateProbe,
  ROLLBACK_JOURNAL_OBJECT_DESCRIPTION,
  type RetainedResource,
  REGISTRY_ROOT,
} from './s3-state-backend/shared.js';
import {
  clientForScan,
  warmConnections,
  ensureClientForBucket,
  headObject,
} from './s3-state-backend/client.js';
import {
  verifyBucketExists,
  stateExists,
  stateExistsOwnedBy,
  rawObjectExists,
  getState,
  saveState,
  deleteState,
  purgeDeletedStateHistory,
  otherRegionHistoryState,
  deleteLegacyState,
} from './s3-state-backend/state-record.js';
import {
  listStacks,
  listTopLevelPrefixes,
  putRawObject,
  earlierStateResources,
  lockUnderPrefix,
  getRawObject,
  listRawKeys,
  listRawObjects,
  deleteRawObjects,
  purgeNoncurrentVersions,
} from './s3-state-backend/listing.js';
import {
  loadRetainedResources,
  loadRetainedRecord,
  ensureRetainedTombstone,
  saveRetainedResources,
  getRefactorMarker,
  saveRefactorMarker,
  getRegistryMarker,
  claimRegistryMarker,
  releaseRegistryMarker,
} from './s3-state-backend/markers.js';
import {
  loadCreateTokenLedger,
  saveCreateTokenLedger,
  rotateCreateTokenNonce,
  deleteCreateTokenLedger,
  stackInstanceIdForFirstWrite,
  stackInstanceSiblingError,
  prefetchStackInstanceSibling,
  readSiblingId,
  readStackInstanceSibling,
  deleteStackInstanceSibling,
  dropStackInstanceSiblingAfterSave,
} from './s3-state-backend/sidecars.js';
import {
  loadRollbackJournal,
  appendRollbackJournalSegment,
  setRollbackJournalFailedOperations,
  dropRollbackJournalFailedOperations,
  rewriteRollbackJournalFailedOperations,
  reduceRollbackJournalToFailedOperations,
  popRollbackJournalSegment,
  markRollbackJournalSuperseded,
  markRollbackJournalImported,
  dropRollbackJournalSegments,
  deleteRollbackJournal,
} from './s3-state-backend/rollback-journal.js';
import {
  adoptKeyRegion,
  probeLegacyState,
  readLegacyRegion,
  legacyBelongsToRegion,
  tryGetLegacy,
  parseStateBody,
} from './s3-state-backend/legacy.js';
export {
  LEGACY_KEY_DEPTH,
  parseRetainedResources,
  REGISTRY_ROOT,
  registryMarkerPrefix,
} from './s3-state-backend/shared.js';
export type {
  StackStateRef,
  S3ClientOptions,
  VerifyBucketExistsOptions,
  RetainedResource,
} from './s3-state-backend/shared.js';

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
  /** @internal Not `private` only because `./s3-state-backend/*.ts` reads it (go-to-k/cdkd#5835). */
  logger = getLogger().child('S3StateBackend');
  /** @internal Not `private` only because `./s3-state-backend/*.ts` reads it (go-to-k/cdkd#5835). */
  s3Client: S3Client;
  /** @internal Not `private` only because `./s3-state-backend/*.ts` reads it (go-to-k/cdkd#5835). */
  config: StateBackendConfig;
  /** @internal Not `private` only because `./s3-state-backend/*.ts` reads it (go-to-k/cdkd#5835). */
  clientOpts: S3ClientOptions;
  /** @internal Not `private` only because `./s3-state-backend/*.ts` reads it (go-to-k/cdkd#5835). */
  clientResolved = false;
  /** @internal Not `private` only because `./s3-state-backend/*.ts` reads it (go-to-k/cdkd#5835). */
  scanClient: S3Client | undefined;
  /** @internal Not `private` only because `./s3-state-backend/*.ts` reads it (go-to-k/cdkd#5835). */
  resolveInFlight: Promise<void> | null = null;
  /** Journal keys `loadRollbackJournal` found absent, untouched since. */
  /** @internal Not `private` only because `./s3-state-backend/*.ts` reads it (go-to-k/cdkd#5835). */
  readonly journalsReadAbsent = new Set<string>();
  /** Per journal key, how many times a non-read access asked for it. */
  /** @internal Not `private` only because `./s3-state-backend/*.ts` reads it (go-to-k/cdkd#5835). */
  readonly journalTouches = new Map<string, number>();
  /**
   * go-to-k/cdkd#5064: by sibling key, the id a `stack-instance.json` this
   * process read or wrote holds, until a state save carrying it deletes it.
   *
   * @internal Not `private` only because `./s3-state-backend/*.ts` reads it (go-to-k/cdkd#5835).
   */
  readonly pendingStackInstanceSiblings = new Map<string, string>();
  /** {@link prefetchStackInstanceSibling}'s reads, by sibling key; each taken once. */
  /** @internal Not `private` only because `./s3-state-backend/*.ts` reads it (go-to-k/cdkd#5835). */
  readonly siblingPrefetches = new Map<string, Promise<string | null>>();
  /** The version each sibling this process wrote got, by sibling key (go-to-k/cdkd#5200). */
  /** @internal Not `private` only because `./s3-state-backend/*.ts` reads it (go-to-k/cdkd#5835). */
  readonly siblingVersionsWritten = new Map<string, string>();

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
    this.scanClient?.destroy();
  }

  /** @internal Body in `./s3-state-backend/`; formerly `private` (go-to-k/cdkd#5835). */
  clientForScan(): Promise<S3Client> {
    return clientForScan.call(this);
  }

  get prefix(): string {
    return this.config.prefix;
  }

  /**
   * Get the new (region-scoped) S3 key for a stack's state file.
   *
   * @internal Not `private` only because `./s3-state-backend/*.ts` reads it (go-to-k/cdkd#5835).
   */
  getStateKey(stackName: string, region: string): string {
    return `${this.config.prefix}/${stackName}/${region}/state.json`;
  }

  /**
   * Get the legacy (pre-region-prefix) S3 key for a stack's state file.
   * Used for backwards-compatible reads and for the migration delete.
   *
   * @internal Not `private` only because `./s3-state-backend/*.ts` reads it (go-to-k/cdkd#5835).
   */
  getLegacyStateKey(stackName: string): string {
    return `${this.config.prefix}/${stackName}/state.json`;
  }

  /**
   * Get the rollback-journal S3 key — a sibling of `state.json` (issue
   * #1183). Only the region-scoped layout is used: journals are new objects
   * only ever written by journal-aware binaries, and the deploy failure path
   * migrates legacy-layout state before the journal write, so a legacy-key
   * journal can never exist.
   *
   * @internal Not `private` only because `./s3-state-backend/*.ts` reads it (go-to-k/cdkd#5835).
   */
  getRollbackJournalKey(stackName: string, region: string): string {
    // Every journal access but `loadRollbackJournal` comes through here, so a
    // writer -- present or future -- voids the "read absent" fact by asking
    // for the key.
    const key = this.rollbackJournalKey(stackName, region);
    this.journalsReadAbsent.delete(key);
    this.journalTouches.set(key, (this.journalTouches.get(key) ?? 0) + 1);
    return key;
  }

  /** @internal Not `private` only because `./s3-state-backend/*.ts` reads it (go-to-k/cdkd#5835). */
  rollbackJournalKey(stackName: string, region: string): string {
    return `${this.config.prefix}/${stackName}/${region}/rollback-journal.json`;
  }

  /**
   * Whether this backend's last `loadRollbackJournal` of the stack found NO
   * journal and nothing has touched the key through this backend since. A
   * deploy reads the journal under the stack lock, so for the rest of that
   * deploy `true` means there is still none: its success settle has nothing
   * to act on or delete.
   */
  rollbackJournalReadAbsent(stackName: string, region: string): boolean {
    return this.journalsReadAbsent.has(this.rollbackJournalKey(stackName, region));
  }

  warmConnections(stackName: string, region: string, count: number): Promise<void> {
    return warmConnections.call(this, stackName, region, count);
  }

  /**
   * Purge the noncurrent versions of the stack's journal key -- the purge
   * {@link deleteRollbackJournal} runs, without its DeleteObject, for a
   * journal already absent (an earlier delete whose purge did not finish
   * leaves readable bodies behind). Never throws.
   */
  async purgeRollbackJournalVersions(stackName: string, region: string): Promise<void> {
    await this.purgeNoncurrentVersions([this.rollbackJournalKey(stackName, region)], {
      objectDescription: ROLLBACK_JOURNAL_OBJECT_DESCRIPTION,
    });
  }

  /**
   * Get the create-token ledger S3 key -- a sibling of `state.json`
   * (go-to-k/cdkd#4438, `src/state/create-token-ledger.ts`).
   *
   * @internal Not `private` only because `./s3-state-backend/*.ts` reads it (go-to-k/cdkd#5835).
   */
  getStackInstanceKey(stackName: string, region: string): string {
    return `${this.config.prefix}/${stackName}/${region}/${STACK_INSTANCE_SIBLING_FILE}`;
  }

  /** @internal Not `private` only because `./s3-state-backend/*.ts` reads it (go-to-k/cdkd#5835). */
  getCreateTokenLedgerKey(stackName: string, region: string): string {
    return `${this.config.prefix}/${stackName}/${region}/create-tokens.json`;
  }

  /** @internal Body in `./s3-state-backend/`; formerly `private` (go-to-k/cdkd#5835). */
  ensureClientForBucket(): Promise<void> {
    return ensureClientForBucket.call(this);
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
   *
   * @internal Not `private` only because `./s3-state-backend/*.ts` reads it (go-to-k/cdkd#5835).
   */
  async ownerParam(): Promise<{ ExpectedBucketOwner?: string }> {
    return expectedOwnerParam(this.s3Client);
  }

  verifyBucketExists(options: VerifyBucketExistsOptions = {}): Promise<void> {
    return verifyBucketExists.call(this, options);
  }

  stateExists(stackName: string, region: string): Promise<boolean> {
    return stateExists.call(this, stackName, region);
  }

  stateExistsOwnedBy(stackName: string, region: string, regionlessOwner: string): Promise<boolean> {
    return stateExistsOwnedBy.call(this, stackName, region, regionlessOwner);
  }

  rawObjectExists(key: string): Promise<boolean> {
    return rawObjectExists.call(this, key);
  }

  getState(
    stackName: string,
    region: string
  ): Promise<{
    state: StackState;
    etag: string;
    migrationPending?: boolean;
    /**
     * The `region` the BODY carried, present only when the region-scoped
     * record named one that is not the key's — i.e. exactly when
     * {@link adoptKeyRegion} replaced it. Never `undefined` when the key is
     * present, so `!== undefined` is the divergence test.
     *
     * Typed `unknown` because the body is unvalidated past its root: the
     * value reaching here has been a number and an object, not only a
     * region-shaped string. It is RAW — a consumer that renders it owes it
     * the same `displaySafe` every other body-derived value in this file
     * takes.
     */
    divergentBodyRegion?: unknown;
  } | null> {
    return getState.call(this, stackName, region);
  }

  saveState(
    stackName: string,
    region: string,
    state: StackState,
    options: {
      expectedEtag?: string;
      migrateLegacy?: boolean;
      deferCleanup?: (cleanup: Promise<void>) => void;
    } = {}
  ): Promise<string> {
    return saveState.call(this, stackName, region, state, options);
  }

  deleteState(stackName: string, region: string): Promise<void> {
    return deleteState.call(this, stackName, region);
  }

  purgeDeletedStateHistory(stackName: string, region: string): Promise<void> {
    return purgeDeletedStateHistory.call(this, stackName, region);
  }

  /** @internal Body in `./s3-state-backend/`; formerly `private` (go-to-k/cdkd#5835). */
  otherRegionHistoryState(
    stackName: string,
    region: string,
    mayHave: (key: string) => Promise<boolean>
  ): Promise<'none' | 'exists' | 'unknown'> {
    return otherRegionHistoryState.call(this, stackName, region, mayHave);
  }

  deleteLegacyState(stackName: string): Promise<void> {
    return deleteLegacyState.call(this, stackName);
  }

  listStacks(): Promise<StackStateRef[]> {
    return listStacks.call(this);
  }

  listTopLevelPrefixes(): Promise<string[]> {
    return listTopLevelPrefixes.call(this);
  }

  /**
   * What `prefix` (another prefix of this bucket) holds for the stack in
   * `region` (go-to-k/cdkd#4705). First ONE listing of `<prefix>/<stack>/`
   * (`MaxKeys: 1`): nothing there is `absent`, the common case, at one request.
   * Otherwise the region-scoped record, the legacy region-less record and the
   * rollback journal are read in parallel, STRICTLY, unlike {@link stateExists}:
   * a 404 is "not there", and every other answer (a 403, a 5xx, a body that
   * will not parse, a zero-byte object cdkd never writes) throws a
   * `CrossPrefixReadError` naming the key, so the scan can tell "nothing there"
   * from "could not look". A legacy record counts only for its own region, by the
   * read gate `getState` applies. What was found is then classified by
   * `recordCanOwnResources`.
   */
  async recordUnderPrefix(
    prefix: string,
    stackName: string,
    region: string
  ): Promise<RecordUnderPrefix> {
    const client = await this.clientForScan();
    const sibling = new S3StateBackend(client, { ...this.config, prefix }, this.clientOpts);
    sibling.clientResolved = true;
    const stackDir = `${prefix}/${stackName}/`;
    let listed: { KeyCount?: number | undefined; Contents?: unknown[] | undefined };
    try {
      listed = await client.send(
        new ListObjectsV2Command({
          Bucket: this.config.bucket,
          ...(await this.ownerParam()),
          Prefix: stackDir,
          MaxKeys: 1,
          EncodingType: LISTING_ENCODING_TYPE,
        })
      );
    } catch (error) {
      throw new CrossPrefixReadError(stackDir, error);
    }
    if ((listed.KeyCount ?? listed.Contents?.length ?? 0) === 0) return 'absent';
    const read = async (key: string): Promise<Record<string, unknown> | null> => {
      let body: string | null;
      try {
        body = await sibling.getRawObject(key);
      } catch (error) {
        throw new CrossPrefixReadError(key, error);
      }
      if (body === null) return null;
      // cdkd never writes an empty object: it proves nothing, so it is a
      // failure that names the key (and refuses), never an "empty" record.
      if (body.trim() === '') {
        throw new CrossPrefixReadError(
          key,
          Object.assign(new Error('empty object'), { name: 'EmptyObject' })
        );
      }
      let value: unknown;
      try {
        value = JSON.parse(body);
      } catch (error) {
        // A snippet-free STAND-IN, not the raw error (issue #5247): V8's
        // `SyntaxError` quotes a window of this body, which a chain walker
        // (scrub's `describeFailure` prints every link) would render. The
        // readers key only on the CLASS name and `$metadata`
        // (`errorName`, `isAccessDenied`, `isNotImplemented`), so the
        // stand-in keeps the name and carries no `$metadata`, as V8's did not.
        const standIn = new Error(describeJsonParseFailure(error, utf8ByteLength(body)));
        standIn.name = error instanceof Error && error.name ? error.name : 'SyntaxError';
        throw new CrossPrefixReadError(key, standIn);
      }
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new CrossPrefixReadError(key, new TypeError('not a JSON object'));
      }
      return value as Record<string, unknown>;
    };
    const [scoped, legacy, journal] = await Promise.all([
      read(sibling.getStateKey(stackName, region)),
      read(sibling.getLegacyStateKey(stackName)),
      read(sibling.getRollbackJournalKey(stackName, region)),
    ]);
    let record: Record<string, unknown> | undefined;
    if (scoped !== null) {
      record = scoped;
    } else if (legacy !== null) {
      // `tryGetLegacy`'s gate: a falsy region is readable from any region, a
      // string one only from its own.
      const bodyRegion = legacy['region'];
      if (!bodyRegion || bodyRegion === region) record = legacy;
    }
    if (record === undefined && journal === null) return 'absent';
    // The record as read: a missing, null or non-object `resources` proves
    // nothing and classifies as a holder. Only a journal with NO record stands
    // in for an empty one.
    return recordCanOwnResources(record ?? { resources: {} }, journal) ? 'holder' : 'empty';
  }

  putRawObject(key: string, body: string, contentType = 'application/json'): Promise<void> {
    return putRawObject.call(this, key, body, contentType);
  }

  earlierStateResources(
    stackName: string,
    region: string,
    max = 10
  ): Promise<EarlierStateRecord[]> {
    return earlierStateResources.call(this, stackName, region, max);
  }

  /** The key of a stack's retained-resource record (go-to-k/cdkd#4705). */
  /** @internal Not `private` only because `./s3-state-backend/*.ts` reads it (go-to-k/cdkd#5835). */
  getRetainedKey(stackName: string, region: string): string {
    return `${this.config.prefix}/${stackName}/${region}/retained.json`;
  }

  loadRetainedResources(stackName: string, region: string): Promise<RetainedResource[]> {
    return loadRetainedResources.call(this, stackName, region);
  }

  loadRetainedRecord(stackName: string, region: string): Promise<RetainedResource[] | null> {
    return loadRetainedRecord.call(this, stackName, region);
  }

  ensureRetainedTombstone(stackName: string, region: string): Promise<void> {
    return ensureRetainedTombstone.call(this, stackName, region);
  }

  saveRetainedResources(
    stackName: string,
    region: string,
    entries: readonly RetainedResource[]
  ): Promise<void> {
    return saveRetainedResources.call(this, stackName, region, entries);
  }

  /**
   * The bucket-root key of a stack's registry marker (go-to-k/cdkd#4705):
   * `_cdkd-registry/<region>/<stack>.json`, holding `{ "prefix": "<p>" }`, the
   * one state prefix of this bucket the stack and region belong to. Outside
   * every prefix, so no `--state-prefix` can address it.
   */
  /**
   * `{prefix}/_refactor/pending.json` (go-to-k/cdkd#5212): the moves a
   * `cdkd refactor` has started between stacks of this prefix and not yet
   * finished. Written BEFORE the first state write of a move and removed
   * after the last, so a run interrupted anywhere in between leaves it; every
   * `cdkd deploy` / `cdkd destroy` reads it once per run (beside its own state
   * read) and refuses a stack a listed move involves. Ids only. Not a
   * `state.json`, so state listings and gc skip it.
   */
  refactorMarkerKey(): string {
    return `${this.config.prefix}/_refactor/pending.json`;
  }

  getRefactorMarker(): Promise<{ body: unknown; etag: string } | null> {
    return getRefactorMarker.call(this);
  }

  saveRefactorMarker(
    body: { moves: unknown[] },
    etag: string | null
  ): Promise<'saved' | 'conflict'> {
    return saveRefactorMarker.call(this, body, etag);
  }

  registryMarkerKey(stackName: string, region: string): string {
    return `${REGISTRY_ROOT}/${region}/${stackName}.json`;
  }

  getRegistryMarker(
    stackName: string,
    region: string
  ): Promise<{ prefix: string; etag: string } | null> {
    return getRegistryMarker.call(this, stackName, region);
  }

  claimRegistryMarker(
    stackName: string,
    region: string,
    ifMatch?: string
  ): Promise<'claimed' | 'conflict'> {
    return claimRegistryMarker.call(this, stackName, region, ifMatch);
  }

  releaseRegistryMarker(
    stackName: string,
    region: string,
    known?: { prefix: string; etag: string } | null
  ): Promise<'released' | 'absent' | 'elsewhere'> {
    return releaseRegistryMarker.call(this, stackName, region, known);
  }

  lockUnderPrefix(prefix: string, stackName: string, region: string): Promise<boolean> {
    return lockUnderPrefix.call(this, prefix, stackName, region);
  }

  getRawObject(key: string): Promise<string | null> {
    return getRawObject.call(this, key);
  }

  listRawKeys(keyPrefix: string): Promise<string[]> {
    return listRawKeys.call(this, keyPrefix);
  }

  listRawObjects(
    keyPrefix: string
  ): Promise<Array<{ key: string; lastModified: Date; size: number }>> {
    return listRawObjects.call(this, keyPrefix);
  }

  deleteRawObjects(keys: string[]): Promise<void> {
    return deleteRawObjects.call(this, keys);
  }

  purgeNoncurrentVersions(
    keys: string[],
    options: Omit<NoncurrentVersionPurgeOptions, 'requestFields' | 'logger'> = {}
  ): Promise<void> {
    return purgeNoncurrentVersions.call(this, keys, options);
  }

  /**
   * Delete the noncurrent versions of EVERY key under `keyPrefix` in the state
   * bucket, keeping each key's current version (issue
   * [#2624](https://github.com/go-to-k/cdkd/issues/2624)).
   *
   * For a caller that empties a prefix it alone owns, where
   * {@link purgeNoncurrentVersions}' key list cannot name everything: a key
   * deleted earlier (by an older release, or by a delete whose purge failed)
   * sits behind a delete marker, is absent from {@link listRawKeys}, and keeps
   * every earlier version readable. Today's one caller is
   * `DeploymentEventsReader.pruneRuns({ all: true })` on a stack's
   * `deployments/` directory. Never point it at a SHARED prefix (the
   * custom-resource response prefix, `_index/`): the `IsLatest` filter keeps a
   * concurrent writer's current object, but every other owner's history would
   * go.
   *
   * `keyPrefix` must end in `/` (enforced by the helper, which then purges
   * nothing and warns), so a stack whose name is a prefix of another's is
   * never reached. NEVER THROWS, for the reason {@link purgeNoncurrentVersions}
   * gives. Returns how many noncurrent BODY versions it deleted (delete
   * markers are removed but not counted) and whether it
   * finished without a failure, so a caller can tell an empty prefix (a
   * mistyped region) from a purge.
   */
  async purgeNoncurrentVersionsUnderPrefix(
    keyPrefix: string,
    options: Pick<NoncurrentVersionPurgeOptions, 'objectDescription'> = {}
  ): Promise<PrefixPurgeResult> {
    try {
      await this.ensureClientForBucket();
      return await purgeNoncurrentVersionsUnderPrefix(
        this.s3Client,
        this.config.bucket,
        keyPrefix,
        {
          ...options,
          requestFields: await this.ownerParam(),
          logger: this.logger,
        }
      );
    } catch (error) {
      const prefixShown = displayIdent(keyPrefix, { maxCodePoints: STACK_REF_MAX_CODE_POINTS });
      // Built with `safeMsg` throughout. The prefix embeds a stack name, so it
      // takes the identifier guard and no hand-written quote around it
      // (go-to-k/cdkd#3950).
      const describing = options.objectDescription ? ` (${options.objectDescription})` : '';
      this.logger.warn(
        safeMsg`Could not purge noncurrent versions under the prefix ${prefixShown} in bucket ${this.config.bucket}: the purge could not be started. Their previous versions survive and remain readable via GetObject with a VersionId${describing}. Grant s3:ListBucketVersions and s3:DeleteObjectVersion on the state bucket, or purge the prefix by hand. Underlying error: ${errorDetail(error)}`
      );
      return { deletedBodies: 0, complete: false };
    }
  }

  loadCreateTokenLedger(stackName: string, region: string): Promise<CreateTokenLedgerDoc | null> {
    return loadCreateTokenLedger.call(this, stackName, region);
  }

  saveCreateTokenLedger(
    stackName: string,
    region: string,
    ledger: CreateTokenLedgerDoc
  ): Promise<void> {
    return saveCreateTokenLedger.call(this, stackName, region, ledger);
  }

  rotateCreateTokenNonce(
    stackName: string,
    region: string,
    logicalIds: readonly string[]
  ): Promise<void> {
    return rotateCreateTokenNonce.call(this, stackName, region, logicalIds);
  }

  deleteCreateTokenLedger(stackName: string, region: string): Promise<void> {
    return deleteCreateTokenLedger.call(this, stackName, region);
  }

  stackInstanceIdForFirstWrite(
    stackName: string,
    region: string,
    options: { writeAhead: boolean }
  ): Promise<string> {
    return stackInstanceIdForFirstWrite.call(this, stackName, region, options);
  }

  /** @internal Body in `./s3-state-backend/`; formerly `private` (go-to-k/cdkd#5835). */
  stackInstanceSiblingError(
    stackName: string,
    region: string,
    error: unknown,
    access: 'read' | 'write'
  ): StateError {
    return stackInstanceSiblingError.call(this, stackName, region, error, access);
  }

  prefetchStackInstanceSibling(stackName: string, region: string): void {
    return prefetchStackInstanceSibling.call(this, stackName, region);
  }

  /** @internal Body in `./s3-state-backend/`; formerly `private` (go-to-k/cdkd#5835). */
  readSiblingId(key: string, stackName: string, region: string): Promise<string | null> {
    return readSiblingId.call(this, key, stackName, region);
  }

  readStackInstanceSibling(stackName: string, region: string): Promise<string | undefined> {
    return readStackInstanceSibling.call(this, stackName, region);
  }

  deleteStackInstanceSibling(stackName: string, region: string): Promise<void> {
    return deleteStackInstanceSibling.call(this, stackName, region);
  }

  /** @internal Body in `./s3-state-backend/`; formerly `private` (go-to-k/cdkd#5835). */
  dropStackInstanceSiblingAfterSave(stackName: string, region: string): Promise<void> {
    return dropStackInstanceSiblingAfterSave.call(this, stackName, region);
  }

  loadRollbackJournal(stackName: string, region: string): Promise<RollbackJournal | null> {
    return loadRollbackJournal.call(this, stackName, region);
  }

  appendRollbackJournalSegment(
    stackName: string,
    region: string,
    segment: RollbackJournalSegment
  ): Promise<void> {
    return appendRollbackJournalSegment.call(this, stackName, region, segment);
  }

  setRollbackJournalFailedOperations(
    stackName: string,
    region: string,
    remaining: FailedOperation[]
  ): Promise<void> {
    return setRollbackJournalFailedOperations.call(this, stackName, region, remaining);
  }

  dropRollbackJournalFailedOperations(
    stackName: string,
    region: string,
    drop: (op: FailedOperation, segment: RollbackJournalSegment) => boolean
  ): Promise<number> {
    return dropRollbackJournalFailedOperations.call(this, stackName, region, drop);
  }

  rewriteRollbackJournalFailedOperations(
    stackName: string,
    region: string,
    rewrite: (op: FailedOperation, segment: RollbackJournalSegment) => FailedOperation | null
  ): Promise<number> {
    return rewriteRollbackJournalFailedOperations.call(this, stackName, region, rewrite);
  }

  reduceRollbackJournalToFailedOperations(
    stackName: string,
    region: string,
    keep: (op: FailedOperation, segment: RollbackJournalSegment) => boolean,
    supersededLogicalIds: readonly string[] = [],
    demote: (op: FailedOperation, segment: RollbackJournalSegment) => boolean = () => false
  ): Promise<number> {
    return reduceRollbackJournalToFailedOperations.call(
      this,
      stackName,
      region,
      keep,
      supersededLogicalIds,
      demote
    );
  }

  popRollbackJournalSegment(stackName: string, region: string): Promise<number> {
    return popRollbackJournalSegment.call(this, stackName, region);
  }

  markRollbackJournalSuperseded(
    stackName: string,
    region: string,
    logicalIds: readonly string[]
  ): Promise<void> {
    return markRollbackJournalSuperseded.call(this, stackName, region, logicalIds);
  }

  markRollbackJournalImported(
    stackName: string,
    region: string,
    marks: readonly ImportedResourceMark[]
  ): Promise<string[]> {
    return markRollbackJournalImported.call(this, stackName, region, marks);
  }

  dropRollbackJournalSegments(
    stackName: string,
    region: string,
    drop: (segment: RollbackJournalSegment) => boolean
  ): Promise<number> {
    return dropRollbackJournalSegments.call(this, stackName, region, drop);
  }

  deleteRollbackJournal(stackName: string, region: string): Promise<boolean> {
    return deleteRollbackJournal.call(this, stackName, region);
  }

  /** @internal Body in `./s3-state-backend/`; formerly `private` (go-to-k/cdkd#5835). */
  headObject(key: string): Promise<boolean> {
    return headObject.call(this, key);
  }

  /**
   * The `StateError` a failed S3 call throws, with the failure named by its
   * CLASS (go-to-k/cdkd#2319).
   *
   * A thrown state message is persisted: a `listStacks` failure inside the
   * `Fn::ImportValue` fallback scan, or a `saveState` failure, ends the deploy
   * and reaches `deployments/{runId}.jsonl` through
   * `extractDeploymentEventError`, which keeps a cdkd-authored message whole.
   * On an `AccessDenied` S3's text names the caller's assumed-role ARN and
   * account id. So an AWS-authored failure reaches `build` as
   * `<Class>. Re-run with --verbose for AWS's own message.`; AWS's own text
   * goes to `debug` (the ASCII allowlist, and the logger's bound-secret mask);
   * the wrap is stamped `markRedactedCause` so a retry classifier reads the
   * withheld text on the `cause` chain. The class is AWS-authored text too, so
   * it takes the same two guards: the allowlist, and the secret mask bound for
   * the current async context (a deploy binds one around each resource, whose
   * resolution is what calls `listStacks`). `build` must thread `error` as
   * `cause`, and runs twice, so it must stay a side-effect-free constructor.
   *
   * Anything else -- `normalizeAwsError`'s rewrite of S3's body-less
   * `Unknown`, a transport error -- is cdkd- or Node-authored, and keeps its
   * text exactly as before.
   *
   * @internal Not `private` only because `./s3-state-backend/*.ts` reads it (go-to-k/cdkd#5835).
   */
  wrapS3Failure(error: unknown, build: (text: string) => StateError): StateError {
    const failure = describeAwsFailure(error);
    if (!failure.redacted) return build(errorDetail(error));
    this.logger.debug(
      build(displaySafe(failure.detail, { asciiOnly: true }) || UNRENDERABLE).message
    );
    const mask = currentLogLineMasker();
    const summary = mask ? mask(failure.summary) : failure.summary;
    const wrapped = build(displaySafe(summary, { asciiOnly: true }) || UNRENDERABLE);
    return error instanceof Error ? markRedactedCause(wrapped) : wrapped;
  }

  /**
   * A stack name safe to put in a log line. Names reach this class from S3
   * key segments, which anyone able to write the bucket controls, so every
   * message that renders one goes through here (issue #2170's class).
   *
   * @internal Not `private` only because `./s3-state-backend/*.ts` reads it (go-to-k/cdkd#5835).
   */
  displayName(stackName: string): string {
    // Bare when plain, otherwise one JSON string: callers write NO quotes of
    // their own around it (go-to-k/cdkd#3617).
    return displayStackName(stackName);
  }

  /**
   * The `stack (region)` descriptor, both halves guarded. The write and delete
   * paths (`saveState`, `deleteState`, the rollback journal) take it as well as
   * the read paths: `cdkd state destroy` hands `deleteState` a pair
   * `listStacks` read out of S3 key segments, and nothing here can tell that
   * caller from one passing a name the user typed (issue #3027).
   *
   * @internal Not `private` only because `./s3-state-backend/*.ts` reads it (go-to-k/cdkd#5835).
   */
  stackRef(stackName: string, region: string): string {
    return `${this.displayName(stackName)} (${displayIdent(region)})`;
  }

  /** @internal Body in `./s3-state-backend/`; formerly `private` (go-to-k/cdkd#5835). */
  adoptKeyRegion(
    state: StackState,
    region: string,
    shownStackName: string,
    shownRegionName: string
  ): { state: StackState; divergentBodyRegion?: unknown } {
    return adoptKeyRegion.call(this, state, region, shownStackName, shownRegionName);
  }

  /** @internal Body in `./s3-state-backend/`; formerly `private` (go-to-k/cdkd#5835). */
  probeLegacyState(stackName: string): Promise<LegacyStateProbe> {
    return probeLegacyState.call(this, stackName);
  }

  /** @internal Body in `./s3-state-backend/`; formerly `private` (go-to-k/cdkd#5835). */
  readLegacyRegion(stackName: string): Promise<string | undefined> {
    return readLegacyRegion.call(this, stackName);
  }

  /** @internal Body in `./s3-state-backend/`; formerly `private` (go-to-k/cdkd#5835). */
  legacyBelongsToRegion(stackName: string, region: string): Promise<boolean> {
    return legacyBelongsToRegion.call(this, stackName, region);
  }

  /** @internal Body in `./s3-state-backend/`; formerly `private` (go-to-k/cdkd#5835). */
  tryGetLegacy(
    stackName: string,
    region: string
  ): Promise<{ state: StackState; etag: string } | null> {
    return tryGetLegacy.call(this, stackName, region);
  }

  /** @internal Body in `./s3-state-backend/`; formerly `private` (go-to-k/cdkd#5835). */
  parseStateBody(bodyString: string, stackName: string): StackState {
    return parseStateBody.call(this, bodyString, stackName);
  }
}
