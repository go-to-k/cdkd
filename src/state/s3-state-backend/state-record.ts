/**
 * The state record itself: the bucket check, existence probes, `getState`, `saveState`, `deleteState` and the deleted-state history purge.
 *
 * Moved verbatim out of `src/state/s3-state-backend.ts` (go-to-k/cdkd#5835); the
 * `S3StateBackend` class keeps one `f.call(this, ...)` delegator per moved method.
 */
import type { S3StateBackend } from '../s3-state-backend.js';
import { timePhase, timePhaseSync } from '../../utils/phase-timings.js';
import {
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  HeadBucketCommand,
} from '@aws-sdk/client-s3';
import {
  STATE_SCHEMA_VERSION_CURRENT,
  stackInstanceIdCarriedFrom,
  type StackState,
} from '../../types/state.js';
import { notifyStateSaved } from '../create-token-ledger.js';
import {
  displayIdent,
  displaySafe,
  displayStackName,
  safeMsg,
  STACK_REF_MAX_CODE_POINTS,
} from '../../utils/display-safe.js';
import { describeAwsFailure, verboseAwareText } from '../../utils/aws-failure-text.js';
import { UNRENDERABLE } from '../lock-contention-message.js';
import { keyMayHaveVersions, listVersionedSubdirectories } from '../earlier-state-versions.js';
import { StateError, normalizeAwsError } from '../../utils/error-handler.js';
import { bodyMayCarryReferences, markTokenFreeState } from '../token-free-state.js';
import {
  errorDetail,
  type VerifyBucketExistsOptions,
  legacyProbeBelongsTo,
  STACK_INSTANCE_OBJECT_DESCRIPTION,
  STATE_RECORD_OBJECT_DESCRIPTION,
  isNoSuchKey,
} from './shared.js';

export async function verifyBucketExists(
  this: S3StateBackend,
  options: VerifyBucketExistsOptions = {}
): Promise<void> {
  // ALWAYS run — this is the `GetBucketLocation` + region-correct client
  // rebuild that every later state operation depends on. Only the
  // `HeadBucket` below is skippable.
  await this.ensureClientForBucket();
  if (options.existenceAlreadyProbed) {
    this.logger.debug(
      `Skipping the redundant HeadBucket on '${this.config.bucket}' — the default-name ` +
        `resolution already confirmed it exists with these credentials.`
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
          `--state-bucket, CDKD_STATE_BUCKET, or cdk.json context.cdkd.stateBucket.`,
        error instanceof Error ? error : undefined
      );
    }
    const normalized = normalizeAwsError(error, {
      bucket: this.config.bucket,
      operation: 'HeadBucket',
    });
    throw this.wrapS3Failure(
      normalized,
      (text) =>
        new StateError(`Failed to verify state bucket '${this.config.bucket}': ${text}`, normalized)
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
export async function stateExists(
  this: S3StateBackend,
  stackName: string,
  region: string
): Promise<boolean> {
  await this.ensureClientForBucket();
  const newKey = this.getStateKey(stackName, region);

  if (await this.headObject(newKey)) {
    return true;
  }

  return this.legacyBelongsToRegion(stackName, region);
}

/**
 * {@link stateExists} for the CLI's region reconciliation
 * (go-to-k/cdkd#2100), which must not read a region-less legacy record as
 * "state in EVERY region".
 *
 * `stateExists` hands such a record to any region on purpose (it mirrors
 * `tryGetLegacy`, issue #2550). The reconciliation asks a narrower question —
 * WHICH region owns this stack — and for a region-less record the answer is
 * the region the commands used for it before the question was asked:
 * `regionlessOwner`. Without this, an inferred profile region would claim
 * the record on its first probe and move a stack whose resources live in
 * us-east-1.
 */
export async function stateExistsOwnedBy(
  this: S3StateBackend,
  stackName: string,
  region: string,
  regionlessOwner: string
): Promise<boolean> {
  await this.ensureClientForBucket();
  if (await this.headObject(this.getStateKey(stackName, region))) return true;
  const probe = await this.probeLegacyState(stackName);
  if (probe.kind === 'no-region') return region === regionlessOwner;
  // Fail CLOSED: "cannot read who owns it" must not become "nobody owns it",
  // which would send the stack to the profile's region and re-create it.
  if (probe.kind === 'unreadable') {
    throw new Error(
      `The legacy state record for ${this.displayName(stackName)} cannot be read ` +
        `(${probe.reason}), so cdkd cannot tell which region it belongs to. ` +
        `Name the region with AWS_REGION to proceed.`
    );
  }
  return legacyProbeBelongsTo(probe, region);
}

/**
 * Whether an object exists under `key` in the state bucket, by HeadObject:
 * the body is never downloaded. `false` on NotFound; other errors propagate.
 */
export async function rawObjectExists(this: S3StateBackend, key: string): Promise<boolean> {
  await this.ensureClientForBucket();
  return this.headObject(key);
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
 *
 * On the region-scoped path the returned `state.region` is ALWAYS the
 * region of the key it was read from, whatever the body said — see
 * `adoptKeyRegion`, which also reports a body that disagreed via
 * `divergentBodyRegion`.
 */
export async function getState(
  this: S3StateBackend,
  stackName: string,
  region: string
): Promise<{
  state: StackState;
  etag: string;
  migrationPending?: boolean;
  /**
   * The `region` the BODY carried, present only when the region-scoped
   * record named one that is not the key's — i.e. exactly when
   * `adoptKeyRegion` replaced it. Never `undefined` when the key is
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
  await this.ensureClientForBucket();
  const newKey = this.getStateKey(stackName, region);

  // Every log line and refusal in this method takes the guard, as every
  // other stack-name render in the file does since issue #3027. Hoisted above
  // the `try` because the catch and the legacy-fallback branch below need
  // them too.
  const shownStackName = this.displayName(stackName);
  const shownRegionName = displayIdent(region);

  // 1. Try new region-scoped key first.
  try {
    this.logger.debug(`Getting state for stack: ${shownStackName} (${shownRegionName})`);

    const response = await this.s3Client.send(
      new GetObjectCommand({
        Bucket: this.config.bucket,
        ...(await this.ownerParam()),
        Key: newKey,
      })
    );

    // `region` is a raw `listStacks` key segment on the `state show` path and
    // `stackName` reaches here the same way, so these three refusals take the
    // same guard as the two in `parseStateBody` (issue #3003). The third one
    // is the reachable one: a planted object whose storage class makes
    // `GetObject` fail with something other than `NoSuchKey` lands the raw
    // segment in the message.
    if (!response.Body) {
      throw new StateError(
        `State file for stack ${shownStackName} (${shownRegionName}) has no body`
      );
    }
    if (!response.ETag) {
      throw new StateError(
        `State file for stack ${shownStackName} (${shownRegionName}) has no ETag`
      );
    }

    const bodyString = await response.Body.transformToString();
    const parsed = this.parseStateBody(bodyString, stackName);
    const { state, divergentBodyRegion } = this.adoptKeyRegion(
      parsed,
      region,
      shownStackName,
      shownRegionName
    );
    // State schema v12's token-free fast path: one substring test over the
    // body already in hand, read by every pass that would otherwise walk the
    // records for a `{{resolve:` token (`token-free-state.ts`). Marked on the
    // object returned, which `adoptKeyRegion` may have copied.
    if (!bodyMayCarryReferences(bodyString)) markTokenFreeState(state);
    this.logger.debug(
      `Retrieved state: ${shownStackName} (${shownRegionName}), ETag: ${response.ETag}`
    );
    return {
      state,
      etag: response.ETag,
      ...(divergentBodyRegion !== undefined && { divergentBodyRegion }),
    };
  } catch (error) {
    if (!isNoSuchKey(error)) {
      if (error instanceof StateError) throw error;
      // The ASCII allowlist. `parseStateBody`'s own `StateError` is
      // rethrown above, so what reaches here is an AWS / stream failure.
      throw this.wrapS3Failure(
        error,
        (text) =>
          new StateError(
            `Failed to get state for stack ${shownStackName} (${shownRegionName}): ${text}`,
            error instanceof Error ? error : undefined
          )
      );
    }
    this.logger.debug(`No state at new key for stack: ${shownStackName} (${shownRegionName})`);
  }

  // 2. Fall back to legacy key when it exists AND its region matches.
  const legacy = await this.tryGetLegacy(stackName, region);
  if (legacy) {
    // A WARN, so it prints at default verbosity on the same `state show` /
    // `state resources` path the refusals around it were guarded for -- and
    // it names the stack twice, once inside a printed S3 key (issue #3003).
    // The KEY is built from the real name and sanitized AFTER. Building it
    // from the sanitized name substitutes a DIFFERENT name into the middle of
    // the key, which is a wrong key rather than a redacted one.
    const shownKey = displayIdent(this.getLegacyStateKey(stackName), {
      maxCodePoints: STACK_REF_MAX_CODE_POINTS,
    });
    this.logger.warn(
      `Loaded legacy state for stack ${shownStackName} from ${shownKey}. ` +
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
 * @param options Optimistic-lock ETag + legacy-migration flag.
 *   `deferCleanup`: the write-ahead stack instance id's sibling, which a
 *   save carrying that id makes obsolete, is deleted in the background and
 *   its promise handed here instead of awaited (go-to-k/cdkd#5200). The
 *   caller awaits it before it releases the stack lock. It never rejects.
 * @returns New ETag (with quotes, e.g., `"abc123"`)
 */
export async function saveState(
  this: S3StateBackend,
  stackName: string,
  region: string,
  state: StackState,
  options: {
    expectedEtag?: string;
    migrateLegacy?: boolean;
    deferCleanup?: (cleanup: Promise<void>) => void;
  } = {}
): Promise<string> {
  await this.ensureClientForBucket();
  const newKey = this.getStateKey(stackName, region);
  const { expectedEtag, migrateLegacy } = options;

  // Normalize the body: schema version + region are load-bearing on disk.
  const body: StackState = {
    ...state,
    ...stackInstanceIdCarriedFrom(state),
    version: STATE_SCHEMA_VERSION_CURRENT,
    stackName,
    region,
  };

  try {
    this.logger.debug(
      `Saving state: ${this.stackRef(stackName, region)}${expectedEtag ? `, expected ETag: ${expectedEtag}` : ''}`
    );

    // go-to-k/cdkd#5200: inert unless CDKD_PHASE_TIMINGS=1.
    const bodyString = timePhaseSync('state saves (every stack)', 'serialize', () =>
      JSON.stringify(body, null, 2)
    );
    const response = await timePhase('state saves (every stack)', 'put state.json', async () =>
      this.s3Client.send(
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
      )
    );

    if (!response.ETag) {
      throw new StateError(
        `No ETag returned after saving state for stack ${this.stackRef(stackName, region)}`
      );
    }
    this.logger.debug(
      `State saved: ${this.stackRef(stackName, region)}, new ETag: ${response.ETag}`
    );

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
          `Migrated state for stack ${this.displayName(stackName)} to region-scoped layout (${displayIdent(region)})`
        );
      } catch (deleteError) {
        this.logger.warn(
          `Migrated stack ${this.displayName(stackName)} to new key, but failed to delete legacy key: ` +
            `${errorDetail(deleteError)}`
        );
      }
    }

    // go-to-k/cdkd#5064: the record now carries the write-ahead id, so its
    // sibling has done its job. Only when the saved body carries THAT id:
    // a save without it leaves the sibling for the re-run to read. Started
    // before the ledger mark below, which writes a different object.
    // Never rejects.
    const siblingKey = this.getStackInstanceKey(stackName, region);
    const pendingId = this.pendingStackInstanceSiblings.get(siblingKey);
    let siblingCleanup: Promise<void> | undefined;
    if (pendingId !== undefined && body.stackInstanceId === pendingId) {
      this.pendingStackInstanceSiblings.delete(siblingKey);
      siblingCleanup = timePhase(
        'state saves (every stack)',
        'after save: drop instance-id sibling',
        () => this.dropStackInstanceSiblingAfterSave(stackName, region)
      );
      if (options.deferCleanup !== undefined) options.deferCleanup(siblingCleanup);
    }
    // The create-token ledger records that this lineage has a state record
    // (go-to-k/cdkd#4438). Never throws.
    await timePhase('state saves (every stack)', 'after save: ledger mark', () =>
      notifyStateSaved(stackName, region)
    );
    if (options.deferCleanup === undefined) await siblingCleanup;
    return response.ETag;
  } catch (error) {
    if ((error as { name: string }).name === 'PreconditionFailed') {
      throw new StateError(
        `State has been modified by another process. Expected ETag: ${expectedEtag}, but state has changed.`,
        error instanceof Error ? error : undefined
      );
    }

    const normalized = normalizeAwsError(error, {
      bucket: this.config.bucket,
      operation: 'PutObject',
    });
    throw this.wrapS3Failure(
      normalized,
      (text) =>
        new StateError(
          `Failed to save state for stack ${this.stackRef(stackName, region)}: ${text}`,
          normalized
        )
    );
  }
}

/**
 * Delete state for a stack in the given region.
 *
 * Removes both the new key and the legacy key (if present). Legacy removal
 * is region-conditional: a legacy state file with a different `region`
 * field is left alone.
 *
 * It leaves the record's EARLIER versions in place, as every caller but
 * `cdkd state destroy` needs (go-to-k/cdkd#2346: the maintainer's decision
 * is that `cdkd destroy`, `cdkd state orphan`, rollback, export and the
 * v1 -> v2 migration tail keep versioning's recovery points). That command
 * purges them afterwards with {@link purgeDeletedStateHistory}, once the
 * destroy runner has written the stack's kept-resource record.
 */
export async function deleteState(
  this: S3StateBackend,
  stackName: string,
  region: string
): Promise<void> {
  await this.ensureClientForBucket();
  // go-to-k/cdkd#4438: the resources this record names are let go of
  // (destroyed, or kept by RETAIN, or orphaned with the record), so the
  // stack's next create must not send the tokens they hold. FIRST, and
  // fail-closed: a ledger that outlived its record would hand a kept file
  // system back to the next deploy, while a record that outlives its ledger
  // only makes an interrupted create's re-run refuse.
  await this.deleteCreateTokenLedger(stackName, region);
  // go-to-k/cdkd#5064: the stack's lifetime ends with its record, so a
  // write-ahead id that outlived it must not be read back by the stack's
  // next first deploy. Fail-closed, like the ledger above: a surviving id
  // would make the recreated stack ask for the names its predecessor held.
  await this.deleteStackInstanceSibling(stackName, region);
  try {
    this.logger.debug(`Deleting state: ${this.stackRef(stackName, region)}`);

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
        `Could not read the legacy state record for ${safeName} while cleaning up ` +
          `(${legacyProbe.reason}). If one exists it was left in place.` +
          safeMsg`${verboseAwareText(' Re-run with --verbose for the details.', ' The details are in the debug output.')}`
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
      this.logger.debug(`Deleted legacy state for stack: ${this.displayName(stackName)}`);
    }

    this.logger.debug(`State deleted: ${this.stackRef(stackName, region)}`);
  } catch (error) {
    const normalized = normalizeAwsError(error, {
      bucket: this.config.bucket,
      operation: 'DeleteObject',
    });
    throw this.wrapS3Failure(
      normalized,
      (text) =>
        new StateError(
          `Failed to delete state for stack ${this.stackRef(stackName, region)}: ${text}`,
          normalized
        )
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
    // The sibling's earlier versions go beside it (go-to-k/cdkd#5064);
    // `purgeNoncurrentVersions` never throws either.
    await Promise.all([
      this.deleteRollbackJournal(stackName, region),
      this.purgeNoncurrentVersions([this.getStackInstanceKey(stackName, region)], {
        objectDescription: STACK_INSTANCE_OBJECT_DESCRIPTION,
      }),
    ]);
  }
}

/**
 * Purge the earlier versions of a state record {@link deleteState} has
 * deleted (go-to-k/cdkd#2346 sites 1-3). `cdkd state destroy` only, through
 * the destroy runner, AFTER the stack's kept-resource record is written: the
 * generated-name guard reads earlier `state.json` versions only while that
 * record is missing (`kept-in-history.ts`). A kept-record write that failed
 * still purges; the next deploy then refuses to take a kept resource back by
 * name and names `cdkd import`, the safe direction.
 *
 * The region-scoped key, unless it has a current body again (a concurrent
 * deploy re-created the record, or the delete never happened): its history
 * is then a live record's, and nothing is purged. The `IsLatest` filter
 * alone would keep that body but take its recovery points.
 *
 * The legacy key only when its history can be this region's alone. Its
 * versions carry no region in the key: a v1 record is migrated to whichever
 * region next saves it, so another region of the stack may have written
 * them. It is purged when it has versions at all, its current state is
 * absent (this delete removed it, or a migration left a delete marker), and
 * no OTHER region's `state.json` has any version, current or earlier: a
 * region whose record `cdkd destroy` or `cdkd state orphan` removed keeps
 * its history for recovery, and the legacy history may be part of it. When
 * one does, or that cannot be determined, or the legacy body names another
 * region (whose history may still hold this region's v1 bodies), the
 * history is kept with a warning. An unreadable probe purges nothing and
 * warns too: it is a second read, which can fail where the delete's did not.
 *
 * One accepted edge: a concurrent deploy migrating the legacy record into
 * another region between the region scan and the purge can lose the
 * pre-migration bodies (the legacy body's own delete had the same race
 * before this purge existed).
 *
 * Never throws: the record is already gone, and a purge failure must not
 * turn a finished destroy into a failed one. The shared helper warns with
 * the IAM grants on a denial.
 */
export async function purgeDeletedStateHistory(
  this: S3StateBackend,
  stackName: string,
  region: string
): Promise<void> {
  try {
    await this.ensureClientForBucket();
    const stateKey = this.getStateKey(stackName, region);
    // `safeMsg`: the stack name reached here from an S3 listing.
    const shown = displayStackName(stackName);
    let recordBack: boolean;
    try {
      recordBack = await this.headObject(stateKey);
    } catch {
      recordBack = true;
    }
    if (recordBack) {
      this.logger.warn(
        safeMsg`Kept the earlier versions of the state record for ${shown}: the record exists again, or its absence could not be confirmed, so they may belong to a live record.`
      );
      return;
    }
    const keys = [stateKey];
    const legacyKey = this.getLegacyStateKey(stackName);
    const mayHave = (key: string): Promise<boolean> =>
      keyMayHaveVersions(this.s3Client, this.config.bucket, () => this.ownerParam(), key);
    // The cheap question first: no legacy history, no region scan.
    if (await mayHave(legacyKey)) {
      const legacyProbe = await this.probeLegacyState(stackName);
      const keptBecause =
        legacyProbe.kind === 'unreadable'
          ? // Warned HERE too: this is a second GetObject, so a transient
            // failure on it is not the one `deleteState` already reported.
            `the legacy record could not be read (${legacyProbe.reason})`
          : legacyProbe.kind !== 'absent'
            ? 'its current body belongs to another record of the stack'
            : await this.otherRegionHistoryState(stackName, region, mayHave);
      if (keptBecause === 'none') {
        keys.push(legacyKey);
      } else {
        const why =
          keptBecause === 'exists'
            ? "another region of the stack still has state record versions, current or earlier, and the legacy versions may be that region's"
            : keptBecause === 'unknown'
              ? "could not list the stack's other regions to confirm none of them still owns that history"
              : keptBecause;
        this.logger.warn(
          safeMsg`Kept the earlier versions of the legacy state record for ${shown}: ${why}. cdkd state destroy purges them only once no other region of the stack has state record versions and the legacy record can be read; otherwise delete them by hand.`
        );
      }
    }
    await this.purgeNoncurrentVersions(keys, {
      objectDescription: STATE_RECORD_OBJECT_DESCRIPTION,
    });
  } catch (error) {
    this.logger.warn(
      safeMsg`Could not purge the earlier versions of the state record for ${displayStackName(stackName)}: ${describeAwsFailure(error).summary}. They remain readable via GetObject with a VersionId.`
    );
  }
}

/**
 * Does any region of `stackName` other than `region` have a `state.json`
 * with any version or delete marker under this prefix? Regions are found by
 * a version listing, so one with no current object is still seen.
 * `'unknown'` when the listing failed (logged at debug); `mayHave` itself
 * answers "yes" on a failure, so both err toward keeping the legacy history.
 */
export async function otherRegionHistoryState(
  this: S3StateBackend,
  stackName: string,
  region: string,
  mayHave: (key: string) => Promise<boolean>
): Promise<'none' | 'exists' | 'unknown'> {
  const stackPrefix = `${this.config.prefix}/${stackName}/`;
  try {
    // A VERSION listing: a region whose keys are all behind delete markers
    // (a removed record whose history is kept) has no current object, so an
    // ordinary listing would never name it (go-to-k/cdkd#2346 review M3).
    const regions = (
      await listVersionedSubdirectories(
        this.s3Client,
        this.config.bucket,
        () => this.ownerParam(),
        stackPrefix
      )
    ).filter((segment) => segment !== region);
    for (const other of regions) {
      if (await mayHave(this.getStateKey(stackName, other))) return 'exists';
    }
    return 'none';
  } catch (error) {
    this.logger.debug(
      safeMsg`Could not list the other regions of ${displayStackName(stackName)}: ${displaySafe(describeAwsFailure(error).detail, { asciiOnly: true }) || UNRENDERABLE}`
    );
    return 'unknown';
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
export async function deleteLegacyState(this: S3StateBackend, stackName: string): Promise<void> {
  await this.ensureClientForBucket();
  const key = this.getLegacyStateKey(stackName);
  try {
    // Sanitized: `stackName` reaches here from an S3 key listing, and
    // `formatError` prints a message verbatim — there is no central
    // sanitization downstream (issue #2170's class).
    // `key` embeds `stackName` verbatim, so logging it raw would defeat
    // the sanitization on the line it sits in.
    const safeStack = displayStackName(stackName);
    this.logger.debug(
      `Deleting legacy state: ${safeStack} (${displayIdent(key, { maxCodePoints: STACK_REF_MAX_CODE_POINTS })})`
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
    throw this.wrapS3Failure(
      normalized,
      (text) =>
        new StateError(
          `Failed to delete legacy state for stack ${displayStackName(stackName)}: ${text}`,
          normalized
        )
    );
  }
}
