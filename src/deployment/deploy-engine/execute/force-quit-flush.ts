/**
 * `executeDeployment`'s force-quit flusher (go-to-k/cdkd#6894): the journal
 * segment a force-quit or a closed terminal would otherwise leave unwritten.
 * Registered while the run's operations are in flight; see
 * `deployment/force-quit-journal.ts`.
 */
import type { DagExecutor } from '../../dag-executor.js';
import type { ResourceChange } from '../../../types/state.js';
import type { FailedOperation } from '../../rollback-executor.js';
import { FORCE_QUIT_STATE_WAIT_MS, type ForceQuitFlush } from '../../force-quit-journal.js';
import { writeRollbackJournalSegment } from '../rollback/journal-write.js';
import type { DeployRun } from './run.js';
import { type ReportedCreateToSettle, settleReportedCreates } from './helpers.js';

/**
 * The operations a force-quit catches mid-call: every DAG node still running
 * that has not already recorded an outcome. Their outcome is unknown, so they
 * are journaled as FAILED operations, which only `cdkd rollback
 * --revert-failed` acts on. An UPDATE or DELETE carries the pre-deploy record
 * it would be reverted to (and an UPDATE whose replacement already deleted the
 * old resource says so, as a failed one does); a CREATE carries no physical id
 * here — {@link settleInFlightCreates} adds one its provider already reported.
 */
export function inFlightOperationsAsFailed(
  run: Pick<
    DeployRun,
    'engine' | 'currentState' | 'newResources' | 'completedOperations' | 'failedOperations'
  >,
  executors: readonly (DagExecutor<ResourceChange> | undefined)[]
): FailedOperation[] {
  const settled = new Set([
    ...run.completedOperations.map((op) => op.logicalId),
    ...run.failedOperations.map((op) => op.logicalId),
  ]);
  const inFlight: FailedOperation[] = [];
  for (const executor of executors) {
    if (executor === undefined) continue;
    for (const node of executor.values()) {
      if (node.state !== 'running' || settled.has(node.id)) continue;
      const change = node.data;
      const logicalId = node.id;
      if (
        change.changeType !== 'CREATE' &&
        change.changeType !== 'UPDATE' &&
        change.changeType !== 'DELETE'
      ) {
        continue;
      }
      const recorded = run.currentState.resources[logicalId];
      const previousState =
        change.changeType !== 'CREATE' && recorded !== undefined ? { ...recorded } : undefined;
      const attemptedProperties =
        change.changeType === 'DELETE'
          ? undefined
          : run.engine.attemptedResolvedProps.get(logicalId);
      inFlight.push({
        logicalId,
        changeType: change.changeType,
        resourceType: change.resourceType,
        provisionedBy: previousState?.provisionedBy,
        ...(previousState && { previousState, physicalId: previousState.physicalId }),
        ...(attemptedProperties !== undefined && { attemptedProperties }),
        ...(change.changeType === 'UPDATE' &&
          run.engine.replacementRun.oldDeletedBeforeCreate.has(logicalId) && {
            oldDeletedBeforeCreate: true,
          }),
      });
    }
  }
  return inFlight;
}

/**
 * Build the run's flusher. It stops this engine dispatching anything new (a
 * closed terminal arrives with no first Ctrl-C), waits a bounded time for the
 * state saves already queued, then writes ONE `interrupted` segment through
 * `writeRollbackJournalSegment`, whose redaction every journal write shares.
 */
export function forceQuitFlusher(
  run: DeployRun,
  live: {
    executors: () => readonly (DagExecutor<ResourceChange> | undefined)[];
    saveChain: () => Promise<void>;
  },
  initialDeploy: boolean
): ForceQuitFlush {
  return async () => {
    const { engine, stackName } = run;
    engine.interrupted = true;
    engine.interruptCause ??= 'user';
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      live.saveChain().catch(() => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, FORCE_QUIT_STATE_WAIT_MS);
        timer.unref?.();
      }),
    ]);
    if (timer !== undefined) clearTimeout(timer);
    const inFlight = inFlightOperationsAsFailed(run, live.executors());
    await settleInFlightCreates(run, inFlight);
    const wrote = await writeRollbackJournalSegment(
      engine.rollbackDeps(),
      stackName,
      [...run.completedOperations],
      [...run.failedOperations, ...inFlight],
      'interrupted',
      initialDeploy
    );
    // A nested child is reverted through its top-level stack, whose own
    // flusher answers that stack's name.
    return wrote && engine.options.parentStackInfo === undefined ? stackName : undefined;
  };
}

/**
 * A resource an in-flight operation's provider already reported creating
 * (go-to-k/cdkd#5511's sink) is in no state record yet, so the journal entry
 * is its only record: complete each in-flight op from its sink the way a
 * deadline-failed one is (the CREATE names the resource; a replacement
 * journals the new one beside the UPDATE as its orphan, pushed onto `inFlight`).
 */
export async function settleInFlightCreates(
  run: Pick<DeployRun, 'engine' | 'template' | 'newResources' | 'inFlightCreatedSinks'>,
  inFlight: FailedOperation[]
): Promise<void> {
  const pending: ReportedCreateToSettle[] = [];
  for (const op of inFlight) {
    if (op.changeType === 'DELETE') continue;
    const sink = run.inFlightCreatedSinks.get(op.logicalId);
    if (sink?.report === undefined) continue;
    const held = run.newResources[op.logicalId] ?? op.previousState;
    const replaced =
      op.changeType === 'UPDATE' && held?.physicalId !== undefined && held.physicalId !== ''
        ? held
        : undefined;
    if (op.changeType === 'UPDATE' && replaced === undefined) continue;
    pending.push({ sink, failedOp: op, ...(replaced && { replaced }), refused: false });
  }
  if (pending.length === 0) return;
  await settleReportedCreates(run.engine, run.template, inFlight, pending);
}
