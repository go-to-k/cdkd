/**
 * The rollback journal (`rollback-journal.json`): load, segment edits and delete.
 *
 * Moved verbatim out of `src/state/s3-state-backend.ts` (go-to-k/cdkd#5835); the
 * `S3StateBackend` class keeps one `f.call(this, ...)` delegator per moved method.
 */
import type { S3StateBackend } from '../s3-state-backend.js';
import { DeleteObjectCommand } from '@aws-sdk/client-s3';
import {
  ROLLBACK_JOURNAL_VERSION,
  parseRollbackJournal,
  type ImportedResourceMark,
  type RollbackJournal,
  type RollbackJournalSegment,
} from '../../types/rollback-journal.js';
import type { FailedOperation } from '../../deployment/rollback-executor.js';
import {
  errorDetail,
  ROLLBACK_JOURNAL_OBJECT_DESCRIPTION,
  isNoSuchKey,
  carrySupersededIds,
  addSupersededIds,
} from './shared.js';

/**
 * Load the rollback journal for a stack (issue #1183). Returns `null` when
 * no journal exists (the common case — a journal only lives between a
 * failed/interrupted deploy and its `cdkd rollback`). Throws
 * {@link UnknownRollbackJournalVersionError} on a newer-version journal.
 */
export async function loadRollbackJournal(
  this: S3StateBackend,
  stackName: string,
  region: string
): Promise<RollbackJournal | null> {
  const key = this.rollbackJournalKey(stackName, region);
  const touches = this.journalTouches.get(key) ?? 0;
  this.journalsReadAbsent.delete(key);
  const body = await this.getRawObject(key);
  if (body === null) {
    // Only when no write went out while the read was in flight.
    if ((this.journalTouches.get(key) ?? 0) === touches) this.journalsReadAbsent.add(key);
    return null;
  }
  return parseRollbackJournal(body, stackName);
}

/**
 * Append one segment to the stack's rollback journal, creating it if
 * absent. Existing segments are preserved (never overwritten) so
 * consecutive failed deploys accumulate one segment each. Every writer
 * holds the stack lock, so no optimistic locking is needed.
 */
export async function appendRollbackJournalSegment(
  this: S3StateBackend,
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
export async function setRollbackJournalFailedOperations(
  this: S3StateBackend,
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
 * Remove every failed op for which `drop` answers `true`, from ANY segment
 * (go-to-k/cdkd#4584: `cdkd destroy` strips the journaled orphans it
 * settled, so a re-run after a later failure does not re-send their
 * deletes). A segment left with no failed op loses the field; segments
 * themselves are kept. Writes nothing when nothing matched. Returns the
 * number of ops removed.
 */
export async function dropRollbackJournalFailedOperations(
  this: S3StateBackend,
  stackName: string,
  region: string,
  drop: (op: FailedOperation, segment: RollbackJournalSegment) => boolean
): Promise<number> {
  const journal = await this.loadRollbackJournal(stackName, region);
  if (!journal) return 0;
  let removed = 0;
  for (const segment of journal.segments) {
    if (!segment.failedOperations) continue;
    const kept = segment.failedOperations.filter((op) => !drop(op, segment));
    removed += segment.failedOperations.length - kept.length;
    if (kept.length === 0) delete segment.failedOperations;
    else segment.failedOperations = kept;
  }
  if (removed === 0) return 0;
  await this.putRawObject(
    this.getRollbackJournalKey(stackName, region),
    JSON.stringify(journal, null, 2)
  );
  return removed;
}

/**
 * Replace failed ops in place, in ANY segment (go-to-k/cdkd#3252: a re-polled
 * abandoned Cloud Control CREATE becomes a proven orphan or loses its token).
 * `rewrite` returns the op unchanged (the same object) to keep it, a new op
 * to replace it, or `null` to remove it; a segment left with no failed op
 * loses the field. Writes nothing when nothing changed. Returns the number of
 * ops changed.
 */
export async function rewriteRollbackJournalFailedOperations(
  this: S3StateBackend,
  stackName: string,
  region: string,
  rewrite: (op: FailedOperation, segment: RollbackJournalSegment) => FailedOperation | null
): Promise<number> {
  const journal = await this.loadRollbackJournal(stackName, region);
  if (!journal) return 0;
  let changed = 0;
  for (const segment of journal.segments) {
    if (!segment.failedOperations) continue;
    const next: FailedOperation[] = [];
    for (const op of segment.failedOperations) {
      const out = rewrite(op, segment);
      if (out !== op) changed++;
      if (out !== null) next.push(out);
    }
    if (next.length === 0) delete segment.failedOperations;
    else segment.failedOperations = next;
  }
  if (changed === 0) return 0;
  await this.putRawObject(
    this.getRollbackJournalKey(stackName, region),
    JSON.stringify(journal, null, 2)
  );
  return changed;
}

/**
 * Reduce the journal to the failed ops `keep` answers `true` for
 * (go-to-k/cdkd#4600: a successful deploy whose journaled orphans could not
 * all be deleted keeps only those). The deploy moved the baseline, so every
 * completed op and every other failed op goes, a segment left with none is
 * dropped, and a kept one no longer describes a first deploy
 * (`initialDeploy: false`, no restored outputs). As a segment removal
 * carries them, each kept segment records as `supersededLogicalIds` the ids
 * of the completed ops removed from it and from every newer segment, plus
 * `supersededLogicalIds` (the deploy's own completed ids), except a kept
 * op's own id, which would demote it. Deletes the
 * journal when nothing is kept. Returns the number of failed ops kept.
 */
export async function reduceRollbackJournalToFailedOperations(
  this: S3StateBackend,
  stackName: string,
  region: string,
  keep: (op: FailedOperation, segment: RollbackJournalSegment) => boolean,
  supersededLogicalIds: readonly string[] = [],
  demote: (op: FailedOperation, segment: RollbackJournalSegment) => boolean = () => false
): Promise<number> {
  const journal = await this.loadRollbackJournal(stackName, region);
  if (!journal) return 0;
  const carried = new Set(supersededLogicalIds);
  const kept: RollbackJournalSegment[] = [];
  let count = 0;
  const keptBySegment = journal.segments.map((segment) =>
    (segment.failedOperations ?? [])
      .filter((op) => keep(op, segment))
      .map((op) =>
        op.physicalIdRecoveredFromError === true && demote(op, segment)
          ? { ...op, physicalIdRecoveredFromError: false }
          : op
      )
  );
  // A kept op's own id is never carried: `demoteSupersededOrphans` reads a
  // segment's `supersededLogicalIds` against its own ops too, so carrying it
  // would demote the very entry this keeps on the next read.
  const keptIds = new Set(keptBySegment.flat().map((op) => op.logicalId));
  for (let s = journal.segments.length - 1; s >= 0; s--) {
    const segment = journal.segments[s]!;
    for (const op of segment.operations) carried.add(op.logicalId);
    for (const id of segment.supersededLogicalIds ?? []) carried.add(id);
    const failed = keptBySegment[s]!;
    if (failed.length === 0) continue;
    const reduced: RollbackJournalSegment = {
      ...segment,
      initialDeploy: false,
      operations: [],
      failedOperations: failed,
    };
    delete reduced.previousOutputs;
    delete reduced.previousCrossStackReads;
    addSupersededIds(
      reduced,
      [...carried].filter((id) => !keptIds.has(id) || segment.supersededLogicalIds?.includes(id))
    );
    kept.unshift(reduced);
    count += failed.length;
  }
  if (kept.length === 0) {
    await this.deleteRollbackJournal(stackName, region);
    return 0;
  }
  journal.segments = kept;
  await this.putRawObject(
    this.getRollbackJournalKey(stackName, region),
    JSON.stringify(journal, null, 2)
  );
  return count;
}

/**
 * Pop the newest segment off the stack's rollback journal after it has
 * been fully replayed. When the last segment is removed, the journal
 * object is deleted entirely. Returns the number of segments remaining.
 */
export async function popRollbackJournalSegment(
  this: S3StateBackend,
  stackName: string,
  region: string
): Promise<number> {
  const journal = await this.loadRollbackJournal(stackName, region);
  if (!journal || journal.segments.length === 0) {
    await this.deleteRollbackJournal(stackName, region);
    return 0;
  }
  const popped = journal.segments.pop()!;
  carrySupersededIds(popped, journal.segments[journal.segments.length - 1]);
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
 * go-to-k/cdkd#4402: record `logicalIds` as superseded on the journal's
 * newest segment — for a removal that could not delete the journal (a
 * successful deploy whose delete failed): its completed ops supersede every
 * older failed attempt of their ids. No journal or no ids: nothing written.
 */
export async function markRollbackJournalSuperseded(
  this: S3StateBackend,
  stackName: string,
  region: string,
  logicalIds: readonly string[]
): Promise<void> {
  if (logicalIds.length === 0) return;
  const journal = await this.loadRollbackJournal(stackName, region);
  const newest = journal?.segments[journal.segments.length - 1];
  if (!journal || !newest) return;
  addSupersededIds(newest, logicalIds);
  await this.putRawObject(
    this.getRollbackJournalKey(stackName, region),
    JSON.stringify(journal, null, 2)
  );
}

/**
 * go-to-k/cdkd#4523: record that `cdkd import` adopted `marks` (logical id,
 * the physical id it wrote, and the type). Every segment holding a completed
 * or failed op of a marked logical id gets that mark in `importedResources`
 * (the replay then runs none of the segment's ops of the id: the matching
 * ones are adopted, the rest displaced — see `splitImportedOps`). The newest
 * segment also supersedes every marked id, since an import records the
 * resource just as a completed op does. Returns the logical ids marked; no
 * journal, or no segment naming one, writes nothing. Throws on a read or
 * write failure — the caller refuses the import rather than leave the
 * journal free to delete it.
 */
export async function markRollbackJournalImported(
  this: S3StateBackend,
  stackName: string,
  region: string,
  marks: readonly ImportedResourceMark[]
): Promise<string[]> {
  if (marks.length === 0) return [];
  const journal = await this.loadRollbackJournal(stackName, region);
  if (!journal) return [];
  const marked = new Set<string>();
  for (const segment of journal.segments) {
    const named = new Set(
      [...segment.operations, ...(segment.failedOperations ?? [])].map((op) => op.logicalId)
    );
    const hits = marks.filter((m) => named.has(m.logicalId));
    if (hits.length === 0) continue;
    // A re-import replaces the id's earlier mark: the record names the
    // NEW resource now.
    const kept = (segment.importedResources ?? []).filter(
      (k) => !hits.some((m) => m.logicalId === k.logicalId)
    );
    segment.importedResources = [...kept, ...hits.map((m) => ({ ...m }))];
    for (const m of hits) marked.add(m.logicalId);
  }
  if (marked.size === 0) return [];
  addSupersededIds(journal.segments[journal.segments.length - 1]!, [...marked]);
  await this.putRawObject(
    this.getRollbackJournalKey(stackName, region),
    JSON.stringify(journal, null, 2)
  );
  return [...marked];
}

/**
 * Remove every segment for which `drop` answers `true` (issue #3754: a
 * nested child's segments for one parent run, once that run's rollback no
 * longer needs them). Deletes the journal — with its noncurrent-version
 * purge — when nothing is left, and writes nothing when nothing matched.
 * Returns the number of segments removed.
 */
export async function dropRollbackJournalSegments(
  this: S3StateBackend,
  stackName: string,
  region: string,
  drop: (segment: RollbackJournalSegment) => boolean
): Promise<number> {
  const journal = await this.loadRollbackJournal(stackName, region);
  if (!journal) return 0;
  const kept: RollbackJournalSegment[] = [];
  for (const segment of journal.segments) {
    if (!drop(segment)) kept.push(segment);
    else carrySupersededIds(segment, kept[kept.length - 1]);
  }
  const removed = journal.segments.length - kept.length;
  if (removed === 0) return 0;
  if (kept.length === 0) {
    await this.deleteRollbackJournal(stackName, region);
    return removed;
  }
  journal.segments = kept;
  await this.putRawObject(
    this.getRollbackJournalKey(stackName, region),
    JSON.stringify(journal, null, 2)
  );
  return removed;
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
 * keeps them and only `cdkd state destroy` purges them — the journal is TRANSIENT by design: it
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
export async function deleteRollbackJournal(
  this: S3StateBackend,
  stackName: string,
  region: string
): Promise<boolean> {
  await this.ensureClientForBucket();
  const key = this.getRollbackJournalKey(stackName, region);
  // go-to-k/cdkd#4402: REPORTED, never thrown — `false` when the journal may
  // survive (a DeleteObject failure other than not-found), so a caller that
  // removes a segment by deleting the whole journal can keep its supersede.
  let gone = true;
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
      gone = false;
      this.logger.warn(
        `Failed to delete rollback journal for ${this.stackRef(stackName, region)}: ${errorDetail(error)}`
      );
    }
  }
  // Delegated to the SHARED purge rather than open-coded, for the reason
  // `s3-noncurrent-version-purge.ts` gives: a copy per call site is how one
  // of them keeps the defect after the other is fixed. It never throws, so
  // this method's best-effort contract holds by construction.
  await this.purgeNoncurrentVersions([key], {
    objectDescription: ROLLBACK_JOURNAL_OBJECT_DESCRIPTION,
  });
  return gone;
}
