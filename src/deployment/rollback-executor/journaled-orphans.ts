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
import type { ResourceState, StackState } from '../../types/state.js';
import { RESOURCE_NOT_FOUND, type ResourceIdentityVerdict } from '../../types/resource.js';
import { orphanDeleteNeedsIdentity, readResourceIdentity } from './orphan-identity.js';
import {
  hasReadableOrphans,
  unreadableOrphanRecords,
} from '../../state/malformed-resources-bag.js';
import type { Logger } from '../../types/config.js';
import { logicalIdShown, resourceTypeShown } from '../../provisioning/composite-id.js';
import { withSkipPrefix, withStackName } from '../../provisioning/resource-name.js';
import { displayIdent, displaySafe, safeMsg } from '../../utils/display-safe.js';
import { pasteableCommand, withheldTargetClause } from '../../utils/pasteable-command.js';
import { RollbackInlinePolicyWriters } from '../inline-policy-claims.js';
import { withPrintingSecrets } from '../resource-secrets-scope.js';
import { journaledOrphanPrintingBag, maskEventTextWithBoundBags } from '../secret-name-needles.js';
import { NESTED_PENDING_PARENT_REASON, displacedPhysicalIdShown } from '../nested-child-journal.js';
import {
  type CompletedOperation,
  type FailedOperation,
  type RollbackExecutorContext,
  demoteSupersededOrphans,
  isJournaledOrphan,
  isReplacedRecord,
  markProvenDistinctFromRecord,
  replacementNeverSwapped,
  replayFailedOperations,
} from '../rollback-executor.js';

/** One journal segment's proven orphans. */
interface SegmentOrphans {
  segment: RollbackJournalSegment;
  ops: FailedOperation[];
  /**
   * go-to-k/cdkd#4604: the segment's failed replacement UPDATEs whose orphan
   * is among `ops`. Replayed with them (each settles as a no-op or a warned
   * skip) and cleared with them, so none outlives its orphan for a later
   * `--revert-failed` to force-revert the resource it never wrote to. Not
   * counted or listed: they name no resource to act on.
   */
  companions?: FailedOperation[];
}

/** The journal's proven orphans, newest segment first. */
export interface JournaledOrphans {
  segments: SegmentOrphans[];
  /** Every op across {@link segments}. */
  count: number;
  /** The journal could not be read (already warned about). */
  unreadable?: boolean;
  /**
   * The logical ids a successful deploy completed an op under: its
   * `newerOperations` and this run's `nested-pending-parent` segments.
   */
  deployLogicalIds?: Set<string>;
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
  const deployLogicalIds = new Set(newer.map((op) => op.logicalId));
  for (const segment of segments) {
    if (
      options.deployRunId !== undefined &&
      segment.reason === NESTED_PENDING_PARENT_REASON &&
      segment.runId === options.deployRunId
    ) {
      for (const op of segment.operations) deployLogicalIds.add(op.logicalId);
    }
  }
  const out: SegmentOrphans[] = [];
  let count = 0;
  for (let s = segments.length - 1; s >= 0; s--) {
    const segment = segments[s]!;
    if (segment.reason === NESTED_PENDING_PARENT_REASON) continue;
    const replay = splitImportedOps(segment.failedOperations ?? [], segment).replay;
    const ops = replay.filter(isJournaledOrphan);
    if (ops.length === 0) continue;
    const companions = replay.filter(
      (op) => op.changeType === 'UPDATE' && replacementNeverSwapped(op, ops)
    );
    out.push({ segment, ops, ...(companions.length > 0 && { companions }) });
    count += ops.length;
  }
  return { segments: out, count, deployLogicalIds };
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
 * go-to-k/cdkd#4633: the way out for a journaled orphan whose delete keeps
 * failing — `cdkd rollback <stack> --drop-failed <logicalId>` drops that one
 * entry and keeps every other. `intro` is one line; `commands` holds one
 * pasteable command per logical id, each named only when it is a plain
 * identifier (a hole otherwise, which `intro` explains). Undefined for no ids.
 */
export function dropFailedCommands(
  stackName: string,
  region: string,
  logicalIds: readonly string[]
): { intro: string; commands: string[] } | undefined {
  const ids = [...new Set(logicalIds)];
  if (ids.length === 0) return undefined;
  const built = ids.map((id) =>
    pasteableCommand('cdkd rollback', [
      { value: stackName, hole: 'stack', opts: { plainIdent: true } },
      // The stack's own region, so a name with state in several regions
      // addresses this one (as destroy's own hints do).
      { flag: '--stack-region', value: region, hole: 'region', opts: { plainIdent: true } },
      { flag: '--drop-failed', value: id, hole: 'logical-id', opts: { plainIdent: true } },
    ])
  );
  const idWithheld = built.some((b) => b.withheld.some((w) => w.hole === 'logical-id'));
  const intro =
    `If cdkd can never delete ${ids.length === 1 ? 'it' : 'one of them'} (a cause you cannot fix), ` +
    'check the resource by hand, then drop just its rollback-journal entry; every other entry is kept.' +
    withheldTargetClause(built[0]!, 'stack', 'cdkd rollback', "This stack's name") +
    withheldTargetClause(built[0]!, 'region', 'cdkd rollback', "This stack's region") +
    // Not `withheldTargetClause`: its remedy reads state records, and this id
    // is a journal entry's.
    (idWithheld
      ? ' A logical id that is not a plain identifier is not named in the command below; read it ' +
        "from the stack's rollback-journal.json (next to its state.json)."
      : '');
  return { intro, commands: built.map((b) => b.command) };
}

/** {@link dropFailedCommands} as the tail of a thrown message; empty for no ids. */
export function dropFailedHint(
  stackName: string,
  region: string,
  logicalIds: readonly string[]
): string {
  const hint = dropFailedCommands(stackName, region, logicalIds);
  if (hint === undefined) return '';
  return `\n${hint.intro}` + hint.commands.map((c) => `\nDrop with: ${c}`).join('');
}

/**
 * {@link dropFailedCommands} as warnings, one call per line, so each line's
 * value is flattened by `safeMsg` and none can forge another.
 */
export function warnDropFailed(
  logger: Pick<Logger, 'warn'>,
  stackName: string,
  region: string,
  logicalIds: readonly string[]
): void {
  const hint = dropFailedCommands(stackName, region, logicalIds);
  if (hint === undefined) return;
  logger.warn(safeMsg`${hint.intro}`);
  for (const command of hint.commands) logger.warn(safeMsg`Drop with: ${command}`);
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
  options: {
    isInterrupted?: () => boolean;
    /**
     * go-to-k/cdkd#4633: warn, naming `--drop-failed`, about each orphan whose
     * delete failed. On by default (`cdkd destroy`); a caller printing its own
     * retry warning turns it off.
     */
    pointAtDrop?: boolean;
  } = {}
): Promise<{
  failures: number;
  warnings: number;
  interrupted: boolean;
  /** The ops this run settled (deleted, kept, or skipped with a warning). */
  handled: Array<{ segment: RollbackJournalSegment; op: FailedOperation }>;
  /**
   * Handled ops whose delete left part of what they wrote, warned
   * (go-to-k/cdkd#4612). Counted in `warnings` too.
   */
  leftInPlace: number;
  /**
   * go-to-k/cdkd#4633: the logical ids of the orphans whose delete was tried
   * and failed (never one an interrupt left unreached).
   */
  failedLogicalIds: string[];
}> {
  const total = {
    failures: 0,
    warnings: 0,
    interrupted: false,
    handled: [] as Array<{ segment: RollbackJournalSegment; op: FailedOperation }>,
    leftInPlace: 0,
    failedLogicalIds: [] as string[],
  };
  const inlinePolicyWriters = new RollbackInlinePolicyWriters();
  const failedIds = total.failedLogicalIds;
  // go-to-k/cdkd#3869: each event is masked by the batch's printing bag too,
  // as its log lines are. The op's own masker holds only the names the entry
  // spells, never one it read from a state record. Both callers (destroy, and
  // a successful deploy's settle) get it here.
  const record = ctx.recordEvent;
  // go-to-k/cdkd#3869: every delete of the batch runs under ONE printing bag of
  // each entry's own name spellings, so a provider's delete lines and the
  // final-snapshot lines mask a name derived from a secret. Nothing reads it
  // to decide: `getCurrentResourceSecrets` never returns it.
  const printing = journaledOrphanPrintingBag(
    orphans.segments.flatMap(({ ops, companions }) => [...(companions ?? []), ...ops]),
    stateResources
  );
  const maskedCtx: RollbackExecutorContext =
    record === undefined
      ? ctx
      : { ...ctx, recordEvent: (event) => record(maskEventTextWithBoundBags(event)) };
  for (const { segment, ops: orphanOps, companions } of orphans.segments) {
    if (options.isInterrupted?.()) {
      total.interrupted = true;
      break;
    }
    // Companions first: the replay runs newest-first, so the orphans go
    // before the UPDATE they were journaled beside, as `--revert-failed` runs.
    const ops = [...(companions ?? []), ...orphanOps];
    const replay = (): ReturnType<typeof replayFailedOperations> =>
      withPrintingSecrets(printing, () =>
        withStackName(stackName, () =>
          replayFailedOperations(ops, stateResources, stackName, maskedCtx, {
            // A destroy run, not a rollback: its own run events frame these
            // ops, so no ROLLBACK_STARTED / ROLLBACK_FINISHED envelope.
            emitEnvelope: false,
            inlinePolicyWriters,
            forDestroy: true,
            ...(options.isInterrupted && { isInterrupted: options.isInterrupted }),
          })
        )
      );
    const result =
      segment.skipPrefix === undefined
        ? await replay()
        : await withSkipPrefix(segment.skipPrefix, replay);
    total.failures += result.failures;
    total.warnings += result.warnings;
    total.leftInPlace += result.leftInPlace;
    const pending = new Set(result.remainingFailedOps);
    for (const op of ops) if (!pending.has(op)) total.handled.push({ segment, op });
    if (result.interrupted) {
      total.interrupted = true;
      break;
    }
    // Not interrupted, so every orphan still pending failed.
    for (const op of orphanOps) if (pending.has(op)) failedIds.push(op.logicalId);
  }
  if (options.pointAtDrop !== false && failedIds.length > 0) {
    ctx.logger.warn(
      safeMsg`${failedIds.length} resource(s) a failed deploy of stack ${displayIdent(stackName)} created ` +
        'could not be deleted (see above); the rollback journal, their only record, keeps them for a re-run.'
    );
    warnDropFailed(ctx.logger, stackName, ctx.region, failedIds);
  }
  return total;
}

/** What another stack's record says about a resource (`makeForeignHolderScan`). */
export type ForeignHolding =
  | { kind: 'held'; by: string }
  | { kind: 'unreadable'; what: string }
  | undefined;

/** The outcome of {@link settleJournaledOrphansOnSuccess}. */
export interface SuccessSettleOutcome {
  /** Entries left in AWS unacted on: kept, or skipped with a warning. */
  unaddressed: number;
  /** The journal still holds an entry: the caller must not delete it. */
  keepJournal: boolean;
  /**
   * Strip the entries this settle cleared (deleted, or demoted and warned
   * about) from the journal, for a caller whose journal delete FAILED: a
   * surviving entry would still read as proven, and a plain `cdkd rollback`
   * or `cdkd destroy` has no foreign-holder scan. Best-effort, never throws;
   * absent when nothing was cleared.
   */
  stripCleared?: () => Promise<void>;
}

/**
 * A SUCCESSFUL deploy is about to drop `stackName`'s rollback journal
 * (go-to-k/cdkd#4600): first act on its proven orphans, as the automatic
 * rollback, `cdkd rollback` and `cdkd destroy` do (go-to-k/cdkd#4584).
 *
 * The rule. An orphan is deleted, per its journaled `DeletionPolicy`, only
 * when after this deploy no state record sits under its logical id (other
 * than the record a replacement orphan's replacement was replacing,
 * go-to-k/cdkd#4604), this deploy completed no op under it, or — the
 * fix-forward, go-to-k/cdkd#4606 — the provider's live read
 * (`isSameResource`) proves the record under it holds ANOTHER resource,
 * no record of this stack holds its type and
 * physical id (the classifier's check), and no resource record of another
 * stack under the same state prefix does (`foreignHolder`). Anything else is
 * DEMOTED (`physicalIdRecoveredFromError: false`) and goes through the
 * replay's `skip-failed-superseded` arm: warned, physical id named (masked),
 * and cleared with the journal, as `cdkd rollback` and `cdkd destroy` settle
 * such a skip. It counts as unaddressed (the deploy exits 2), as does an
 * entry whose delete left part of what it wrote (`leftInPlace`,
 * go-to-k/cdkd#4612).
 *
 * An entry is KEPT only when acting on it did not complete: a delete
 * failure, an interrupt, or a record (this stack's, or one the scan read)
 * that cannot be read. The journal is then reduced to those entries (or, if
 * the rewrite fails, left whole with the deploy's ids marked superseded,
 * #4402) and the next successful deploy retries. Never throws.
 */
export async function settleJournaledOrphansOnSuccess(args: {
  stateBackend: Pick<
    S3StateBackend,
    | 'loadRollbackJournal'
    | 'reduceRollbackJournalToFailedOperations'
    | 'markRollbackJournalSuperseded'
    | 'dropRollbackJournalFailedOperations'
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
  /** Asked only for an orphan the other checks would delete. */
  foreignHolder: (resourceType: string, physicalId: string) => Promise<ForeignHolding>;
  ctx: RollbackExecutorContext;
  isInterrupted?: () => boolean;
  logger: Logger;
}): Promise<SuccessSettleOutcome> {
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
    return { unaddressed: 1, keepJournal: true };
  }
  if (orphans.count === 0) return { unaddressed: 0, keepJournal: false };
  const all = orphans.segments.flatMap(({ segment, ops }) => ops.map((op) => ({ segment, op })));
  let kept: typeof all = all;
  // go-to-k/cdkd#4633: only an orphan whose delete was tried and failed is
  // named for `--drop-failed`; one kept unread or unreached is retried.
  let failedDeletes: string[] = [];
  // go-to-k/cdkd#4612: deleted, but a part left in AWS with a warning.
  let leftInPlace = 0;
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
      const { unreadable, tracked } = await applySuccessRule(
        orphans,
        stateResources,
        orphans.deployLogicalIds ?? new Set(),
        args.foreignHolder,
        stack,
        logger,
        args.isInterrupted,
        ctx
      );
      const acting: JournaledOrphans = {
        segments: orphans.segments
          // Companions are not replayed here (each would only settle as a
          // no-op); they are cleared with their orphans below.
          .map(({ segment, ops }) => ({
            segment,
            ops: ops.filter((op) => !unreadable.has(op) && !tracked.has(op)),
          }))
          .filter(({ ops }) => ops.length > 0),
        count: orphans.count - unreadable.size - tracked.size,
      };
      // go-to-k/cdkd#4612: what this deploy just wrote, which a delete
      // comparing live content must not read back yet.
      const writtenThisRun = [...(orphans.deployLogicalIds ?? [])]
        .filter((id) => Object.prototype.hasOwnProperty.call(stateResources, id))
        .map((id) => stateResources[id])
        .filter((r): r is ResourceState => r !== undefined && r !== null && typeof r === 'object');
      const outcome = await deleteJournaledOrphans(
        acting,
        { ...stateResources },
        stackName,
        { ...ctx, writtenThisRun },
        // The warning below names `--drop-failed` itself.
        { pointAtDrop: false, ...(args.isInterrupted && { isInterrupted: args.isInterrupted }) }
      );
      leftInPlace = outcome.leftInPlace;
      failedDeletes = outcome.failedLogicalIds;
      kept = all.filter(
        ({ segment, op }) =>
          unreadable.has(op) || (!tracked.has(op) && !isHandledOrphan(outcome.handled, segment, op))
      );
    } catch (err) {
      logger.warn(
        safeMsg`Acting on the journaled resources of stack ${stack} failed: ${errorDetail(err)}`
      );
    }
  }
  // A demoted entry that was acted on was skipped with a warning: left in AWS.
  const keptOps = new Set(kept.map(({ op }) => op));
  const skipped = all.filter(
    ({ op }) => !keptOps.has(op) && op.physicalIdRecoveredFromError === false
  ).length;
  // go-to-k/cdkd#4604: a cleared orphan's companion UPDATE goes with it.
  const clearedOrphans = all.filter(({ op }) => !keptOps.has(op));
  const cleared = [
    ...clearedOrphans,
    ...orphans.segments.flatMap(({ segment, companions }) =>
      (companions ?? [])
        .filter((c) =>
          replacementNeverSwapped(
            c,
            clearedOrphans.filter((o) => o.segment === segment).map((o) => o.op)
          )
        )
        .map((op) => ({ segment, op }))
    ),
  ];
  const stripCleared =
    cleared.length === 0
      ? undefined
      : async (): Promise<void> => {
          try {
            await stateBackend.dropRollbackJournalFailedOperations(
              stackName,
              region,
              (op, segment) => isHandledOrphan(cleared, segment, op)
            );
          } catch (err) {
            logger.warn(
              safeMsg`Failed to remove the settled entries from the rollback journal of stack ${stack}: ` +
                safeMsg`${errorDetail(err)}. A cdkd rollback or cdkd destroy could act on them again; run a ` +
                'successful cdkd deploy of the stack first, which settles them again.'
            );
          }
        };
  if (kept.length === 0) {
    return {
      unaddressed: skipped + leftInPlace,
      keepJournal: false,
      ...(stripCleared && { stripCleared }),
    };
  }
  const keptIds = new Set(kept.map(({ op }) => op.logicalId));
  const supersededIds = newerIds.filter((id) => !keptIds.has(id));
  // A kept entry that was demoted keeps that verdict: the reduce drops the
  // newer evidence that produced it.
  const demoted = kept.filter(({ op }) => op.physicalIdRecoveredFromError === false);
  const reduce = (): Promise<number> =>
    stateBackend.reduceRollbackJournalToFailedOperations(
      stackName,
      region,
      (op, segment) => isHandledOrphan(kept, segment, op),
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
  if (!reduced) {
    await markSuperseded(stateBackend, stackName, region, supersededIds);
    // The whole journal still holds what this settle cleared.
    await stripCleared?.();
  }
  // No plain `cdkd rollback` pointer: a plain rollback has none of this
  // deploy's ownership evidence. `--drop-failed` acts on nothing in AWS.
  logger.warn(
    safeMsg`${kept.length} resource(s) a failed deploy of stack ${stack} created were not deleted ` +
      (reduced
        ? '(see above). The rollback journal, their only record, is kept with just them; the next '
        : '(see above). The rollback journal, their only record, is kept; the next ') +
      'successful deploy retries.'
  );
  warnDropFailed(logger, stackName, region, failedDeletes);
  return { unaddressed: kept.length + skipped + leftInPlace, keepJournal: true };
}

/**
 * The success-path rule (see {@link settleJournaledOrphansOnSuccess}): demote
 * every proven orphan this deploy's outcome may own, and return those whose
 * ownership could not be read (kept, not acted on) and those settled without
 * a delete: a record of this stack tracks them, or AWS reports them gone
 * (go-to-k/cdkd#4655).
 */
async function applySuccessRule(
  orphans: JournaledOrphans,
  stateResources: Record<string, ResourceState>,
  deployLogicalIds: ReadonlySet<string>,
  foreignHolder: (resourceType: string, physicalId: string) => Promise<ForeignHolding>,
  stack: string,
  logger: Logger,
  isInterrupted: (() => boolean) | undefined,
  identityCtx: Pick<RollbackExecutorContext, 'providerRegistry' | 'region'>
): Promise<{ unreadable: Set<FailedOperation>; tracked: Set<FailedOperation> }> {
  const unreadable = new Set<FailedOperation>();
  const tracked = new Set<FailedOperation>();
  let interrupted = false;
  for (const { ops } of orphans.segments) {
    for (const op of ops) {
      if (op.physicalIdRecoveredFromError !== true || !op.physicalId) continue;
      // An interrupt stops the scan; what it did not reach is kept untouched.
      if (interrupted || isInterrupted?.()) {
        interrupted = true;
        unreadable.add(op);
        continue;
      }
      // A record of this stack holding this very resource tracks it (an
      // idempotent create, an adoption): settled here, silently, without the
      // classifier, whose same-logical-id check would call a record holding
      // another resource under that id a mismatch.
      if (
        Object.values(stateResources).some(
          (r) => r?.resourceType === op.resourceType && r.physicalId === op.physicalId
        )
      ) {
        tracked.add(op);
        continue;
      }
      // go-to-k/cdkd#4604: a replacement's new resource shares its logical
      // id with the resource it was replacing; a record still naming THAT
      // resource is not one this deploy or a later one put there.
      const hasRecord = Object.prototype.hasOwnProperty.call(stateResources, op.logicalId);
      const record = hasRecord ? stateResources[op.logicalId] : undefined;
      const recordUnderId = hasRecord && !isReplacedRecord(op, record);
      if (recordUnderId || deployLogicalIds.has(op.logicalId)) {
        // go-to-k/cdkd#4606: the fix-forward. A record under the id may hold
        // a NEW resource; only the provider's live read can tell, and only
        // its `'different'` lets the orphan on to the delete below.
        const verdict = recordUnderId
          ? await recordIdentity(op, record, identityCtx, logger)
          : 'unknown';
        if (verdict === 'same') {
          tracked.add(op);
          continue;
        }
        if (verdict !== 'different') {
          op.physicalIdRecoveredFromError = false;
          continue;
        }
        markProvenDistinctFromRecord(op, record!);
      }
      const holding = await foreignHolder(op.resourceType, op.physicalId);
      if (holding === undefined) {
        // go-to-k/cdkd#4655: the last check before the delete. A name-keyed
        // id may now name a resource made after the orphan was removed.
        const created = await createdResourceStillThere(op, identityCtx);
        if (created === 'gone') {
          // Settled without a delete: one sent later, after the other
          // orphans' reads and deletes, could reach a resource created under
          // the name in between.
          logger.info(
            safeMsg`${logicalIdShown(op.logicalId)} (${resourceTypeShown(op.resourceType)}), which a failed deploy ` +
              safeMsg`of stack ${stack} created, is already gone: nothing to delete.`
          );
          tracked.add(op);
        } else if (created === 'mismatch') {
          logger.warn(
            safeMsg`${logicalIdShown(op.logicalId)} (${resourceTypeShown(op.resourceType)}), which a failed deploy ` +
              safeMsg`of stack ${stack} created, is not deleted: the resource now under its physical id is another ` +
              'one (its identity differs from the one that deploy recorded, so its name was reused).'
          );
          op.physicalIdRecoveredFromError = false;
        } else if (created === 'unproven') {
          logger.warn(
            safeMsg`${logicalIdShown(op.logicalId)} (${resourceTypeShown(op.resourceType)}), which a failed deploy ` +
              safeMsg`of stack ${stack} created, is not deleted: nothing proves the resource now under its physical ` +
              'id is the one that deploy created (it may have been deleted and its name reused).'
          );
          op.physicalIdRecoveredFromError = false;
        }
        continue;
      }
      if (holding.kind === 'held') {
        logger.warn(
          safeMsg`${logicalIdShown(op.logicalId)} (${resourceTypeShown(op.resourceType)}), which a failed deploy ` +
            safeMsg`of stack ${stack} created, is not deleted: ${holding.by} holds a resource of that type under ` +
            'the same physical id.'
        );
        op.physicalIdRecoveredFromError = false;
        continue;
      }
      logger.warn(
        safeMsg`${logicalIdShown(op.logicalId)} (${resourceTypeShown(op.resourceType)}), which a failed deploy ` +
          safeMsg`of stack ${stack} created, is not deleted: ${holding.what}, so whether another stack holds it is unknown.`
      );
      unreadable.add(op);
    }
  }
  return { unreadable, tracked };
}

/**
 * go-to-k/cdkd#4606: whether the proven orphan `op` is the resource `record`
 * (the record under its logical id) holds, by the provider's live read
 * (`ResourceProvider.isSameResource`), asked through the provider the orphan's
 * delete would take. `'unknown'` for a record of another type or without a
 * physical id, a provider without the method, and any error: the caller then
 * keeps today's warn-and-skip.
 */
async function recordIdentity(
  op: FailedOperation,
  record: ResourceState | undefined,
  ctx: Pick<RollbackExecutorContext, 'providerRegistry' | 'region'>,
  logger: Logger
): Promise<ResourceIdentityVerdict> {
  if (
    typeof record !== 'object' ||
    record === null ||
    record.resourceType !== op.resourceType ||
    typeof record.physicalId !== 'string' ||
    record.physicalId === '' ||
    !op.physicalId
  ) {
    return 'unknown';
  }
  try {
    const { provider } = ctx.providerRegistry.getProviderFor({
      resourceType: op.resourceType,
      provisionedBy: op.provisionedBy,
    });
    if (typeof provider.isSameResource !== 'function') return 'unknown';
    return await provider.isSameResource(
      op.physicalId,
      {
        physicalId: record.physicalId,
        ...(record.provisionedBy !== undefined && { provisionedBy: record.provisionedBy }),
      },
      op.resourceType,
      { expectedRegion: ctx.region }
    );
  } catch (err) {
    // The error CLASS only: AWS's text may quote the account and role, or a
    // resource name this line has no masker for (go-to-k/cdkd#3869). The
    // warn-and-skip that follows names the resource, masked.
    logger.debug(
      safeMsg`Could not compare ${logicalIdShown(op.logicalId)}'s journaled resource with its state record (${displaySafe(err instanceof Error ? err.name : typeof err)}).`
    );
    return 'unknown';
  }
}

/**
 * go-to-k/cdkd#4655: whether the resource under the proven orphan `op`'s
 * physical id is still the one its failed CREATE made. `'proven'` without a
 * read for a `Retain` orphan (nothing is deleted) and for a type that needs
 * no identity (`orphanDeleteNeedsIdentity`); otherwise `'proven'` only when
 * the provider's live `resourceIdentity` equals the journaled
 * `createdResourceIdentity`, `'mismatch'` when it reads another token, and
 * `'gone'` when it reports the id gone. A legacy entry with no identity, a
 * provider without the method, and any failed read are `'unproven'`. A match
 * is read before the delete runs, not with it: no delete this settle sends is
 * conditional on an identity.
 */
async function createdResourceStillThere(
  op: FailedOperation,
  ctx: Pick<RollbackExecutorContext, 'providerRegistry' | 'region'>
): Promise<'proven' | 'mismatch' | 'gone' | 'unproven'> {
  if (op.deletionPolicy === 'Retain') return 'proven';
  if (!orphanDeleteNeedsIdentity(op.resourceType)) return 'proven';
  // Unreachable from `applySuccessRule`, which skips an op without one; a
  // guard for any other caller.
  const physicalId = op.physicalId;
  if (!physicalId) return 'unproven';
  const live = await readResourceIdentity(
    ctx.providerRegistry,
    { resourceType: op.resourceType, physicalId, provisionedBy: op.provisionedBy },
    ctx.region
  );
  if (live === RESOURCE_NOT_FOUND) return 'gone';
  const journaled = op.createdResourceIdentity;
  if (typeof journaled !== 'string' || journaled === '' || typeof live !== 'string') {
    return 'unproven';
  }
  return live === journaled ? 'proven' : 'mismatch';
}

/**
 * go-to-k/cdkd#4600: the ownership check a successful deploy runs before
 * deleting a proven orphan, over every resource record of another stack under
 * the same state prefix. A user who removed the orphan by hand may
 * have let ANOTHER stack (a sibling, a nested child of the same tree, or the
 * same stack in another region for a global name) create a resource under the
 * same name, and that stack's record is the only evidence. One `listStacks`
 * and a read of every record, as the exports-index rebuild does, made lazily
 * on the first question and shared by every stack the settle asks about.
 *
 * Reads each record's `resources` and rollback-orphan records; a record that
 * cannot be read, listed or located (a legacy key with no region) makes every
 * answer `unreadable` (fail closed: the entry is kept).
 */
export function makeForeignHolderScan(
  stateBackend: Pick<S3StateBackend, 'listStacks' | 'getState'>
): (self: {
  stackName: string;
  region: string;
}) => (resourceType: string, physicalId: string) => Promise<ForeignHolding> {
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
        const named = (why: string): string =>
          safeMsg`the state record of stack ${displayIdent(ref.stackName)} (${why})`;
        // A legacy key whose body names no region: where its resources live
        // is unknown, so it cannot vouch for anything (fail closed).
        if (ref.region === undefined) {
          unreadable ??= named('its region cannot be read');
          return;
        }
        const region = ref.region;
        let state: StackState | undefined;
        try {
          state = (await stateBackend.getState(ref.stackName, region))?.state;
        } catch {
          unreadable ??= named('it could not be read');
          return;
        }
        if (state === undefined) return;
        const resources: unknown = state.resources;
        if (
          resources !== undefined &&
          (typeof resources !== 'object' || resources === null || Array.isArray(resources))
        ) {
          unreadable ??= named('its resources cannot be read');
          return;
        }
        // Its rollback-orphan records hold resources too (go-to-k/cdkd#3379's
        // container and row guards first).
        if (!hasReadableOrphans(state) || unreadableOrphanRecords(state).length > 0) {
          unreadable ??= named('its rollback-orphan records cannot be read');
          return;
        }
        const held: unknown[] = [
          ...Object.values((resources ?? {}) as Record<string, unknown>),
          ...(state.orphans ?? []).map((record) => record.state),
        ];
        for (const record of held) {
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
    if (other) {
      return {
        kind: 'held',
        by: safeMsg`the state record of stack ${displayIdent(other.stackName)} (${displaySafe(other.region)})`,
      };
    }
    return unreadable === undefined ? undefined : { kind: 'unreadable', what: unreadable };
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
