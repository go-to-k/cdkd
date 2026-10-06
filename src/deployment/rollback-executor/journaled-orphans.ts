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
import { displayIdent, displaySafe, safeMsg } from '../../utils/display-safe.js';
import { pasteableCommand } from '../../utils/pasteable-command.js';
import { RollbackInlinePolicyWriters } from '../inline-policy-claims.js';
import { NESTED_PENDING_PARENT_REASON, displacedPhysicalIdShown } from '../nested-child-journal.js';
import {
  type CompletedOperation,
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
  logger: Pick<Logger, 'warn'>,
  options: {
    /**
     * A successful deploy's own completed ops (go-to-k/cdkd#4600), newer than
     * every segment. They count as PHYSICAL-ID evidence only: the "completed
     * CREATE of the type" rule is for a journal entry whose resource state no
     * longer records, while each of these CREATEs' resource is in the saved
     * record, which the classifier compares by physical id.
     */
    newerOperations?: readonly CompletedOperation[];
    /**
     * The deploy's run id: a `nested-pending-parent` segment of this run holds
     * a child's completions of this same deploy, read like `newerOperations`.
     */
    deployRunId?: string;
    /** What then happens to an unreadable journal; destroy's by default. */
    unreadableOutcome?: string;
  } = {}
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
        safeMsg`no resource it records for a failed CREATE is deleted, and ${
          options.unreadableOutcome ?? 'a destroy that proceeds removes the journal with the state'
        }.`
    );
    return { ...NONE, unreadable: true };
  }
  // Over EVERY segment, as `cdkd rollback` runs it: a newer nested
  // pending-parent segment's completed CREATE is supersede evidence too.
  const physicalIdOnly = (ops: readonly CompletedOperation[]): CompletedOperation[] =>
    ops.filter((op) => op.changeType !== 'CREATE');
  // Spread copies keep each segment's `failedOperations` array, which the pass
  // mutates in place.
  const evidence: Parameters<typeof demoteSupersededOrphans>[0][number][] = segments.map(
    (segment) =>
      options.deployRunId !== undefined &&
      segment.reason === NESTED_PENDING_PARENT_REASON &&
      segment.runId === options.deployRunId
        ? { ...segment, operations: physicalIdOnly(segment.operations) }
        : segment
  );
  const newer = options.newerOperations ?? [];
  if (newer.length > 0) evidence.push({ operations: physicalIdOnly(newer) });
  demoteSupersededOrphans(evidence, Array.isArray(rollbackOrphans) ? rollbackOrphans : []);
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
 * A SUCCESSFUL deploy is about to drop `stackName`'s rollback journal
 * (go-to-k/cdkd#4600): first act on its proven orphans, as the automatic
 * rollback, `cdkd rollback` and `cdkd destroy` do (go-to-k/cdkd#4584) —
 * deleted per the journaled `DeletionPolicy`, through the supersede pass and
 * the classifier's ownership checks.
 *
 * Ownership is by PHYSICAL ID against the saved record: the deploy finished,
 * so a record now under the orphan's logical id with another physical id is
 * the deploy's own resource (a fix-forward), not the orphan's. A resource
 * another state record in the bucket holds (`foreignHolder`) is never
 * deleted: the entry is kept.
 *
 * Returns how many entries it left. When that is non-zero the journal was
 * reduced to just those (or, if the rewrite failed, left whole with the
 * deploy's ids marked superseded) and the caller must NOT delete it: it is
 * their only record. `stateResources` undefined deletes nothing. An
 * unreadable journal is warned about and yields 0, so the caller deletes it as
 * it always has. Never throws.
 */
export async function settleJournaledOrphansOnSuccess(args: {
  stateBackend: Pick<
    S3StateBackend,
    | 'loadRollbackJournal'
    | 'reduceRollbackJournalToFailedOperations'
    | 'markRollbackJournalSuperseded'
  >;
  stackName: string;
  region: string;
  /**
   * The stack's resources after the deploy; undefined when its record cannot
   * be read.
   */
  stateResources: Record<string, ResourceState> | undefined;
  /** The record's rollback-orphan records (the caller guarded the container). */
  rollbackOrphans: unknown;
  /** This deploy's completed ops, newer than every segment. */
  newerOperations: readonly CompletedOperation[];
  /** This deploy's run id (see `loadJournaledOrphans`). */
  deployRunId?: string | undefined;
  /**
   * Another state record in the bucket holding a resource of this type and
   * physical id, named for the warning; undefined when none does. Asked only
   * when there is an orphan to delete.
   */
  foreignHolder: (resourceType: string, physicalId: string) => Promise<string | undefined>;
  ctx: RollbackExecutorContext;
  isInterrupted?: () => boolean;
  logger: Logger;
}): Promise<number> {
  const { stateBackend, stackName, region, stateResources, newerOperations, ctx, logger } = args;
  const stack = displayIdent(stackName);
  const newerIds = newerOperations.map((op) => op.logicalId);
  let orphans: JournaledOrphans;
  try {
    orphans = await loadJournaledOrphans(
      stateBackend,
      stackName,
      region,
      args.rollbackOrphans,
      logger,
      {
        newerOperations,
        ...(args.deployRunId !== undefined && { deployRunId: args.deployRunId }),
        unreadableOutcome: 'the successful deploy removes the journal',
      }
    );
  } catch (err) {
    // `loadJournaledOrphans` catches its own read, so this is unexpected: keep
    // the journal (fail closed), count it as one entry left, and record the
    // deploy's ids as superseded as a failed delete would (go-to-k/cdkd#4402).
    logger.warn(
      safeMsg`Could not act on the rollback journal of stack ${stack}: ${errorDetail(err)}. It is kept.`
    );
    await markSuperseded(stateBackend, stackName, region, newerIds);
    return 1;
  }
  if (orphans.count === 0) return 0;
  const all = orphans.segments.flatMap(({ segment, ops }) => ops.map((op) => ({ segment, op })));
  let pending = all;
  if (stateResources === undefined) {
    logger.warn(
      safeMsg`The rollback journal of stack ${stack} records ${all.length} resource(s) a failed deploy ` +
        `created, but the stack's state cannot be read, so whether a record now owns them is unknown: none is deleted.`
    );
  } else {
    logger.info(
      safeMsg`The rollback journal of stack ${stack} records ${all.length} resource(s) a failed deploy ` +
        `created that no state record holds; acting on them per their DeletionPolicy before the journal is removed:`
    );
    // One call per line: each is masked and bounded by `journaledOrphanLines`.
    for (const line of journaledOrphanLines(orphans, logger)) logger.info(line);
    try {
      const refused = await refuseForeignHeld(orphans, args.foreignHolder, stack, logger);
      const acting: JournaledOrphans = {
        segments: orphans.segments
          .map(({ segment, ops }) => ({ segment, ops: ops.filter((op) => !refused.has(op)) }))
          .filter(({ ops }) => ops.length > 0),
        count: orphans.count - refused.size,
      };
      const outcome = await deleteJournaledOrphans(
        acting,
        ownershipView(stateResources, all),
        stackName,
        ctx,
        args.isInterrupted ? { isInterrupted: args.isInterrupted } : {}
      );
      pending = all.filter(
        ({ segment, op }) => refused.has(op) || !isHandledOrphan(outcome.handled, segment, op)
      );
    } catch (err) {
      logger.warn(
        safeMsg`Acting on the journaled resources of stack ${stack} failed: ${errorDetail(err)}`
      );
    }
  }
  if (pending.length === 0) return 0;
  // go-to-k/cdkd#4402 / #4600: the deploy's ids supersede older attempts, but
  // never a kept entry's own id, which would demote it on the next read.
  const pendingIds = new Set(pending.map(({ op }) => op.logicalId));
  const supersededIds = newerIds.filter((id) => !pendingIds.has(id));
  // An entry the supersede pass demoted keeps that verdict: the reduce drops
  // the newer evidence that produced it.
  const demoted = pending.filter(({ op }) => op.physicalIdRecoveredFromError === false);
  const reduce = (): Promise<number> =>
    stateBackend.reduceRollbackJournalToFailedOperations(
      stackName,
      region,
      (op, segment) => isHandledOrphan(pending, segment, op),
      supersededIds,
      (op, segment) => isHandledOrphan(demoted, segment, op)
    );
  let reduced = false;
  for (let attempt = 0; attempt < 2 && !reduced; attempt++) {
    try {
      await reduce();
      reduced = true;
    } catch (err) {
      if (attempt === 1) {
        logger.warn(
          safeMsg`Failed to reduce the rollback journal of stack ${stack} to its undeleted resources: ` +
            safeMsg`${errorDetail(err)}. The whole journal is kept.`
        );
      }
    }
  }
  if (!reduced) await markSuperseded(stateBackend, stackName, region, supersededIds);
  if (reduced) {
    logger.warn(
      safeMsg`${pending.length} resource(s) a failed deploy of stack ${stack} created were not deleted ` +
        '(see above). The rollback journal, their only record, is kept with just them; the next ' +
        safeMsg`successful deploy retries, as does:\n  ${
          pasteableCommand('cdkd rollback', [{ value: stackName, hole: 'stack' }]).command
        }`
    );
  } else {
    // No `cdkd rollback` here: the whole journal still holds the completed
    // operations this deploy superseded, and a rollback would replay them over
    // it.
    logger.warn(
      safeMsg`${pending.length} resource(s) a failed deploy of stack ${stack} created were not deleted ` +
        '(see above). The rollback journal, their only record, is kept; the next successful deploy ' +
        'retries. Do not run a plain cdkd rollback on it: the journal still holds operations this deploy superseded.'
    );
  }
  return pending.length;
}

/**
 * The classifier's view of the saved record on the success path: a record
 * under an orphan's logical id holding ANOTHER resource is the deploy's own
 * (a fix-forward), so it is moved off that key — `classifyFailedOp` then
 * judges the orphan by physical id alone, which every record still answers.
 */
function ownershipView(
  stateResources: Record<string, ResourceState>,
  entries: ReadonlyArray<{ op: FailedOperation }>
): Record<string, ResourceState> {
  const view: Record<string, ResourceState> = { ...stateResources };
  for (const { op } of entries) {
    const current = view[op.logicalId];
    if (current === undefined) continue;
    if (current.resourceType === op.resourceType && current.physicalId === op.physicalId) continue;
    delete view[op.logicalId];
    let key = op.logicalId + '#deployed';
    while (key in view) key += '#';
    view[key] = current;
  }
  return view;
}

/** The proven orphans another state record holds; each warned about. */
async function refuseForeignHeld(
  orphans: JournaledOrphans,
  foreignHolder: (resourceType: string, physicalId: string) => Promise<string | undefined>,
  stack: string,
  logger: Logger
): Promise<Set<FailedOperation>> {
  const refused = new Set<FailedOperation>();
  for (const { ops } of orphans.segments) {
    for (const op of ops) {
      if (op.physicalIdRecoveredFromError !== true || !op.physicalId) continue;
      const holder = await foreignHolder(op.resourceType, op.physicalId);
      if (holder === undefined) continue;
      refused.add(op);
      logger.warn(
        safeMsg`Not deleting ${logicalIdShown(op.logicalId)} (${resourceTypeShown(op.resourceType)}), which a failed ` +
          safeMsg`deploy of stack ${stack} created: ${holder} holds a resource of that type under the same ` +
          `physical id. The rollback journal keeps the entry; if the resource is not that record's, delete it manually.`
      );
    }
  }
  return refused;
}

/**
 * go-to-k/cdkd#4600: the bucket-wide ownership check a successful deploy runs
 * before deleting a proven orphan. A user who removed the orphan by hand may
 * have let ANOTHER stack (a sibling, a nested child of the same tree, or the
 * same stack in another region for a global name) create a resource under the
 * same name, and that stack's record is the only evidence. One `listStacks`
 * and a read of every record, as the exports-index rebuild does, made lazily
 * on the first question and shared by every stack the settle asks about.
 *
 * Reads each record's `resources`; a record that cannot be read or listed
 * makes every answer name it (fail closed: nothing is deleted).
 */
export function makeForeignHolderScan(
  stateBackend: Pick<S3StateBackend, 'listStacks' | 'getState'>,
  defaultRegion: string
): (self: {
  stackName: string;
  region: string;
}) => (resourceType: string, physicalId: string) => Promise<string | undefined> {
  type Scan = {
    holders: Map<string, Array<{ stackName: string; region: string }>>;
    unreadable?: string;
  };
  let scan: Promise<Scan> | undefined;
  const key = (type: string, id: string): string => JSON.stringify([type, id]);
  const run = async (): Promise<Scan> => {
    const holders: Scan['holders'] = new Map();
    let refs: Awaited<ReturnType<S3StateBackend['listStacks']>>;
    try {
      refs = await stateBackend.listStacks();
    } catch {
      return { holders, unreadable: 'the state bucket listing (it could not be read)' };
    }
    let unreadable: string | undefined;
    await Promise.all(
      refs.map(async (ref) => {
        const region = ref.region ?? defaultRegion;
        let resources: unknown;
        try {
          resources = (await stateBackend.getState(ref.stackName, region))?.state?.resources;
        } catch {
          unreadable ??= safeMsg`the state record of stack ${displayIdent(ref.stackName)} (it could not be read)`;
          return;
        }
        if (resources === undefined) return;
        if (typeof resources !== 'object' || resources === null || Array.isArray(resources)) {
          unreadable ??= safeMsg`the state record of stack ${displayIdent(ref.stackName)} (its resources cannot be read)`;
          return;
        }
        for (const record of Object.values(resources as Record<string, unknown>)) {
          const r = record as { resourceType?: unknown; physicalId?: unknown } | null;
          if (typeof r?.resourceType !== 'string' || typeof r.physicalId !== 'string') continue;
          const k = key(r.resourceType, r.physicalId);
          const list = holders.get(k) ?? [];
          list.push({ stackName: ref.stackName, region });
          holders.set(k, list);
        }
      })
    );
    return { holders, ...(unreadable !== undefined && { unreadable }) };
  };
  return (self) => async (resourceType, physicalId) => {
    scan ??= run();
    const { holders, unreadable } = await scan;
    const other = (holders.get(key(resourceType, physicalId)) ?? []).find(
      (h) => !(h.stackName === self.stackName && h.region === self.region)
    );
    if (other)
      return safeMsg`the state record of stack ${displayIdent(other.stackName)} (${displaySafe(other.region)})`;
    return unreadable;
  };
}

async function markSuperseded(
  stateBackend: Pick<S3StateBackend, 'markRollbackJournalSuperseded'>,
  stackName: string,
  region: string,
  ids: readonly string[]
): Promise<void> {
  try {
    await stateBackend.markRollbackJournalSuperseded(stackName, region, ids);
  } catch {
    // The kept journal then still counts these ids' older attempts as
    // evidence: the pre-#4402 shape, which a re-run settles.
  }
}

function errorDetail(err: unknown): string {
  return displaySafe(err instanceof Error ? err.message : String(err));
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
