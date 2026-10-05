/**
 * The proven failed-CREATE orphans a stack's rollback journal still holds,
 * for a command about to sweep that journal (go-to-k/cdkd#4584).
 *
 * A CREATE whose provider proved it made the resource before failing is
 * journaled with `physicalIdRecoveredFromError` (go-to-k/cdkd#1710), and no
 * state record ever holds it: the journal entry is its only record. `cdkd
 * destroy` deletes the journal with the state, so it first deletes each such
 * resource, honouring its journaled `DeletionPolicy`, through the same
 * classifier and replay as `cdkd rollback --revert-failed`.
 *
 * Not re-exported from the `rollback-executor.ts` barrel: it imports the
 * barrel's replay entry.
 */
import type { S3StateBackend } from '../../state/s3-state-backend.js';
import { type RollbackJournalSegment, splitImportedOps } from '../../types/rollback-journal.js';
import type { ResourceState } from '../../types/state.js';
import type { Logger } from '../../types/config.js';
import { logicalIdShown, resourceTypeShown } from '../../provisioning/composite-id.js';
import { withSkipPrefix, withStackName } from '../../provisioning/resource-name.js';
import { displaySafe, safeMsg } from '../../utils/display-safe.js';
import { RollbackInlinePolicyWriters } from '../inline-policy-claims.js';
import { NESTED_PENDING_PARENT_REASON, displacedPhysicalIdShown } from '../nested-child-journal.js';
import {
  type FailedOperation,
  type RollbackExecutorContext,
  demoteSupersededOrphans,
  isJournaledOrphan,
  replayFailedOperations,
} from '../rollback-executor.js';

/** One journal segment's proven orphans. */
interface SegmentOrphans {
  segment: RollbackJournalSegment;
  ops: FailedOperation[];
}

/** The journal's proven orphans, newest segment first. */
export interface JournaledOrphans {
  segments: SegmentOrphans[];
  /** Every op across {@link segments}. */
  count: number;
  /** The journal could not be read (already warned about). */
  unreadable?: boolean;
}

const NONE: JournaledOrphans = { segments: [], count: 0 };

/**
 * Read the stack's journal and collect its proven orphans, after the
 * supersede pass (`demoteSupersededOrphans`) against the journal itself and
 * the state's rollback-orphan records. An op demoted there is kept: its replay
 * warns about it instead of deleting it. Ops of a logical id `cdkd import`
 * adopted are left alone (`splitImportedOps`), as every replay does.
 *
 * A journal that cannot be read is warned about and yields none: destroy has
 * always swept such a journal, and refusing would make a corrupt journal
 * block every destroy of the stack.
 */
export async function loadJournaledOrphans(
  stateBackend: Pick<S3StateBackend, 'loadRollbackJournal'>,
  stackName: string,
  region: string,
  rollbackOrphans: unknown,
  logger: Pick<Logger, 'warn'>
): Promise<JournaledOrphans> {
  let segments: RollbackJournalSegment[];
  try {
    const journal = await stateBackend.loadRollbackJournal(stackName, region);
    if (!journal) return NONE;
    segments = journal.segments;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logger.warn(
      // No stack name of its own: the destroy's lines name it. The parse
      // error's detail may carry it, sanitized by the journal parser.
      safeMsg`Could not read the stack's rollback journal (${displaySafe(detail)}); ` +
        `no resource it records for a failed CREATE is deleted, and a destroy that proceeds removes the journal with the state.`
    );
    return { ...NONE, unreadable: true };
  }
  // Over EVERY segment, as `cdkd rollback` runs it: a newer nested
  // pending-parent segment's completed CREATE is supersede evidence too.
  demoteSupersededOrphans(segments, Array.isArray(rollbackOrphans) ? rollbackOrphans : []);
  const out: SegmentOrphans[] = [];
  let count = 0;
  for (let s = segments.length - 1; s >= 0; s--) {
    const segment = segments[s]!;
    if (segment.reason === NESTED_PENDING_PARENT_REASON) continue;
    const ops = splitImportedOps(segment.failedOperations ?? [], segment).replay.filter(
      isJournaledOrphan
    );
    if (ops.length === 0) continue;
    out.push({ segment, ops });
    count += ops.length;
  }
  return { segments: out, count };
}

/** One listing line per orphan, its physical id masked as a replay line masks it. */
export function journaledOrphanLines(orphans: JournaledOrphans, logger: Logger): string[] {
  return orphans.segments.flatMap(({ ops }) =>
    ops.map(
      (op) =>
        `  - ${logicalIdShown(op.logicalId)} (${resourceTypeShown(op.resourceType)})  ` +
        `${displacedPhysicalIdShown(op, logger) ?? 'a physical id'}`
    )
  );
}

/**
 * Replay every collected orphan, newest segment first, in the segment's own
 * prefix scope. Each op is classified as `--revert-failed` classifies it:
 * deleted, kept under `Retain`, snapshotted under `Snapshot`, or skipped with
 * a warning when state or later activity may own its resource. Never throws
 * for a per-op failure (counted in `failures`).
 */
export async function deleteJournaledOrphans(
  orphans: JournaledOrphans,
  stateResources: Record<string, ResourceState>,
  stackName: string,
  ctx: RollbackExecutorContext,
  options: { isInterrupted?: () => boolean } = {}
): Promise<{
  failures: number;
  warnings: number;
  interrupted: boolean;
  /** The ops this run settled (deleted, kept, or skipped with a warning). */
  handled: Array<{ segment: RollbackJournalSegment; op: FailedOperation }>;
}> {
  const total = {
    failures: 0,
    warnings: 0,
    interrupted: false,
    handled: [] as Array<{ segment: RollbackJournalSegment; op: FailedOperation }>,
  };
  const inlinePolicyWriters = new RollbackInlinePolicyWriters();
  for (const { segment, ops } of orphans.segments) {
    if (options.isInterrupted?.()) {
      total.interrupted = true;
      break;
    }
    const replay = (): ReturnType<typeof replayFailedOperations> =>
      withStackName(stackName, () =>
        replayFailedOperations(ops, stateResources, stackName, ctx, {
          // A destroy run, not a rollback: its own run events frame these
          // ops, so no ROLLBACK_STARTED / ROLLBACK_FINISHED envelope.
          emitEnvelope: false,
          inlinePolicyWriters,
          ...(options.isInterrupted && { isInterrupted: options.isInterrupted }),
        })
      );
    const result =
      segment.skipPrefix === undefined
        ? await replay()
        : await withSkipPrefix(segment.skipPrefix, replay);
    total.failures += result.failures;
    total.warnings += result.warnings;
    const pending = new Set(result.remainingFailedOps);
    for (const op of ops) if (!pending.has(op)) total.handled.push({ segment, op });
    if (result.interrupted) {
      total.interrupted = true;
      break;
    }
  }
  return total;
}

/**
 * Whether a journal op is one {@link deleteJournaledOrphans} reported handled:
 * the same segment (by `timestamp` and `runId`) and the same op identity. The
 * strip re-reads the journal, so the objects themselves never match.
 */
export function isHandledOrphan(
  handled: ReadonlyArray<{ segment: RollbackJournalSegment; op: FailedOperation }>,
  segment: RollbackJournalSegment,
  op: FailedOperation
): boolean {
  return handled.some(
    (h) =>
      h.segment.timestamp === segment.timestamp &&
      h.segment.runId === segment.runId &&
      h.op.logicalId === op.logicalId &&
      h.op.changeType === op.changeType &&
      h.op.resourceType === op.resourceType &&
      h.op.physicalId === op.physicalId
  );
}

/** One op's identity across two reads of the journal (see {@link isHandledOrphan}). */
function orphanKey(segment: RollbackJournalSegment, op: FailedOperation): string {
  return JSON.stringify([
    segment.timestamp,
    segment.runId ?? null,
    op.logicalId,
    op.changeType,
    op.resourceType,
    op.physicalId ?? null,
  ]);
}

/**
 * Whether two reads collected the SAME orphans — the same ops of the same
 * segments, not merely as many. The destroy re-reads under its lock and
 * refuses on any difference, so it never deletes a set it did not list.
 */
export function sameJournaledOrphans(a: JournaledOrphans, b: JournaledOrphans): boolean {
  const keys = (o: JournaledOrphans): string[] =>
    o.segments.flatMap(({ segment, ops }) => ops.map((op) => orphanKey(segment, op))).sort();
  const ka = keys(a);
  const kb = keys(b);
  return ka.length === kb.length && ka.every((k, i) => k === kb[i]);
}
