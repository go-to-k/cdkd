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
import { withSkipPrefix, withStackScope } from '../../provisioning/resource-name.js';
import { nameScopeOf } from '../../state/name-generation.js';
import { displayIdent, displaySafe, safeMsg } from '../../utils/display-safe.js';
import { describeAwsFailure } from '../../utils/aws-failure-text.js';
import { pasteableCommand, withheldTargetClause } from '../../utils/pasteable-command.js';
import { RollbackInlinePolicyWriters } from '../inline-policy-claims.js';
import { withPrintingSecrets } from '../resource-secrets-scope.js';
import type { RecordedSecretValues } from '../secret-redaction.js';
import { journaledOrphanPrintingBag, maskEventTextWithBoundBags } from '../secret-name-needles.js';
import { NESTED_PENDING_PARENT_REASON, displacedPhysicalIdShown } from '../nested-child-journal.js';
import {
  type CompletedOperation,
  type FailedOperation,
  type RollbackExecutorContext,
  demoteSupersededOrphans,
  isJournaledOrphan,
  replacementNeverSwapped,
  replayFailedOperations,
} from '../rollback-executor.js';
import type { ForeignHolding } from './journaled-orphans/foreign-holder-scan.js';
import { applySuccessRule } from './journaled-orphans/success-rule.js';

export type { ForeignHolding } from './journaled-orphans/foreign-holder-scan.js';
export { makeForeignHolderScan } from './journaled-orphans/foreign-holder-scan.js';

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
  /**
   * go-to-k/cdkd#3252: failed CREATEs still carrying an unsettled abandoned
   * Cloud Control request. They are no orphan, but the journal is their only
   * record, so a settle that finds one keeps the journal.
   */
  pendingRequests?: number;
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
    const detail = describeAwsFailure(err).detail;
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
  const pendingRequests = segments
    .flatMap((segment) => segment.failedOperations ?? [])
    .filter((op) => op.pendingCloudControlRequest !== undefined).length;
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
  return {
    segments: out,
    count,
    deployLogicalIds,
    ...(pendingRequests > 0 && { pendingRequests }),
  };
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
  /** The stack's instance id (go-to-k/cdkd#5064): its record's, `undefined` for a legacy one. */
  stackInstanceId: string | undefined,
  ctx: RollbackExecutorContext,
  options: {
    isInterrupted?: () => boolean;
    /**
     * go-to-k/cdkd#4633: warn, naming `--drop-failed`, about each orphan whose
     * delete failed. On by default (`cdkd destroy`); a caller printing its own
     * retry warning turns it off.
     */
    pointAtDrop?: boolean;
    /**
     * go-to-k/cdkd#3869: the stack's `NoEcho` values, judged into the printing
     * bag (`journaledOrphanPrintingBag`): an entry or record written before
     * schema v11 holds such a value in plaintext. `cdkd destroy` re-binds them.
     */
    noEchoValues?: RecordedSecretValues | undefined;
    /**
     * go-to-k/cdkd#5064 phase 2: the stack's retired name generations, so a
     * re-added logical id's name derives as its record's create did.
     */
    retiredNameGenerations?: Record<string, number> | undefined;
  } = {}
): Promise<{
  failures: number;
  warnings: number;
  interrupted: boolean;
  /** The ops this run settled (deleted, kept, or skipped with a warning). */
  handled: Array<{ segment: RollbackJournalSegment; op: FailedOperation }>;
  /**
   * go-to-k/cdkd#4658: the orphans (not their companions) skipped with a
   * warning, left in AWS: `cdkd destroy` counts them as unaddressed.
   */
  skipped: number;
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
    skipped: 0,
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
    stateResources,
    options.noEchoValues
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
        withStackScope(
          nameScopeOf(stackName, stackInstanceId, {
            resources: stateResources,
            ...(options.retiredNameGenerations !== undefined && {
              retiredNameGenerations: options.retiredNameGenerations,
            }),
          }),
          () =>
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
    total.skipped += (result.skippedOps ?? []).filter((op) => orphanOps.includes(op)).length;
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

/** The outcome of {@link settleJournaledOrphansOnSuccess}. */
export interface SuccessSettleOutcome {
  /** Entries left in AWS unacted on: kept, or skipped with a warning. */
  unaddressed: number;
  /** The journal still holds an entry: the caller must not delete it. */
  keepJournal: boolean;
  /**
   * Strip the entries this settle cleared (deleted, or demoted and warned
   * about) from the journal, for a caller whose journal delete FAILED: a
   * surviving entry would still read as proven, and a later `cdkd rollback`
   * or `cdkd destroy` would act on it again (its own scan and identity read
   * would decide afresh, on evidence this deploy no longer carries).
   * Best-effort, never throws; absent when nothing was cleared.
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
  /** The stack's instance id (go-to-k/cdkd#5064): its record's, `undefined` for a legacy one. */
  stackInstanceId: string | undefined;
  region: string;
  /**
   * The stack's resources after the deploy; undefined when its record cannot
   * be read.
   */
  stateResources: Record<string, ResourceState> | undefined;
  /** The record's rollback-orphan records (the caller guarded the container). */
  rollbackOrphans: unknown;
  /** go-to-k/cdkd#5064 phase 2: the record's retired name generations. */
  retiredNameGenerations?: Record<string, number> | undefined;
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
  // go-to-k/cdkd#3252: an unsettled abandoned Cloud Control request keeps the
  // journal, its only record (a deploy whose start could not read it).
  const pendingKept = (orphans.pendingRequests ?? 0) > 0;
  // Reduced to those requests like any kept journal: the deploy moved the
  // baseline, so every completed op goes. Returns false when the reduce
  // failed (the deploy's ids are then marked superseded instead).
  const keepPendingOnly = async (): Promise<boolean> => {
    try {
      await stateBackend.reduceRollbackJournalToFailedOperations(
        stackName,
        region,
        (op) => op.pendingCloudControlRequest !== undefined,
        newerIds,
        () => false
      );
      return true;
    } catch (err) {
      logger.warn(
        safeMsg`Failed to reduce the rollback journal of stack ${stack} to its unsettled Cloud ` +
          safeMsg`Control requests: ${errorDetail(err)}. The whole journal is kept.`
      );
      await markSuperseded(stateBackend, stackName, region, newerIds);
      return false;
    }
  };
  if (orphans.count === 0) {
    if (pendingKept) await keepPendingOnly();
    return { unaddressed: 0, keepJournal: pendingKept };
  }
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
      const { unreadable, tracked, proven } = await applySuccessRule(
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
        args.stackInstanceId,
        // go-to-k/cdkd#4658 / #4696: the replay's delete asks the holder scan
        // and the identity of a journaled orphan; the ones this settle just
        // proved are not asked again (no second identity read).
        { ...ctx, writtenThisRun, foreignHolder: args.foreignHolder, orphanDeleteProven: proven },
        // The warning below names `--drop-failed` itself.
        {
          pointAtDrop: false,
          ...(args.isInterrupted && { isInterrupted: args.isInterrupted }),
          retiredNameGenerations: args.retiredNameGenerations,
        }
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
    // The kept journal must not still read the cleared entries as proven.
    if (pendingKept && !(await keepPendingOnly())) await stripCleared?.();
    return {
      unaddressed: skipped + leftInPlace,
      keepJournal: pendingKept,
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
      (op, segment) =>
        isHandledOrphan(kept, segment, op) || op.pendingCloudControlRequest !== undefined,
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
  return displaySafe(describeAwsFailure(err).detail);
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
