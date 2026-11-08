import { logicalIdShown, resourceTypeShown } from '../../../provisioning/composite-id.js';
import { plainOrDescribed } from '../../../utils/pasteable-command.js';
import { ProviderRegistry } from '../../../provisioning/provider-registry.js';
import { refusesFinalSnapshot } from '../../../provisioning/final-snapshot.js';
import {
  nestedChildStackName,
  revertedNestedRowIds,
} from '../../../deployment/nested-child-journal.js';
import {
  planRollback,
  planFailedOps,
  recheckFailedPlan,
  recordUnderIdIsNotOwn,
  type RollbackPlanItem,
  type FailedOpPlanItem,
} from '../../../deployment/rollback-executor.js';
import { type ResourceState } from '../../../types/state.js';
import { splitImportedOps } from '../../../types/rollback-journal.js';
import type { S3StateBackend } from '../../../state/s3-state-backend.js';
import { isPasteableIdent } from '../../../utils/display-safe.js';
import type { StateSetup } from '../state.js';
import type { ConsoleLogger } from '../../../utils/logger.js';
import type { RollbackJournal } from '../../../types/rollback-journal.js';
import {
  backendErrorText,
  NESTED_NAME_DESCRIBED_NOTE,
  safe,
  actionLabel,
  importedOpLabel,
  displacedOpLabel,
  failedOpsToReplay,
  failedActionLabel,
} from './render.js';
import type { RollbackOptions } from './options.js';

/**
 * What {@link printRollbackPlanSegments} reads from the enclosing
 * `runRollbackReplay` call.
 */
export interface RollbackPlanPreviewContext {
  journal: RollbackJournal;
  logger: ConsoleLogger;
  options: RollbackOptions;
  inSegmentScope: <T>(segment: { skipPrefix?: boolean }, fn: () => Promise<T>) => Promise<T>;
  planStateView: Record<string, ResourceState>;
  providerRegistry: ProviderRegistry;
  region: string;
  setup: StateSetup;
  stackName: string;
  orphanLogicalIds: Set<string>;
}

/**
 * Step 5 of `cdkd rollback`: print the plan, newest segment first, walking
 * `planStateView` (a COPY of state) so each older segment is planned against
 * the already-unwound view. Read-only against AWS and state.
 */
export async function printRollbackPlanSegments(ctx: RollbackPlanPreviewContext): Promise<void> {
  const {
    journal,
    logger,
    options,
    inSegmentScope,
    planStateView,
    providerRegistry,
    region,
    setup,
    stackName,
    orphanLogicalIds,
  } = ctx;
  for (let s = journal.segments.length - 1; s >= 0; s--) {
    const segment = journal.segments[s]!;
    logger.info(
      `\n  Segment ${s + 1}/${journal.segments.length} (${safe(segment.reason)}${segment.runId ? `, run ${safe(segment.runId)}` : ''}):`
    );
    // go-to-k/cdkd#4523: ops of a logical id `cdkd import` adopted after
    // this segment was recorded are left alone, failed ones included.
    const failedOps = splitImportedOps(segment.failedOperations ?? [], segment);
    // An id named by `--orphan` is never set aside: the flag is honoured.
    const completedOps = splitImportedOps(segment.operations, segment, orphanLogicalIds);
    for (const op of [...failedOps.imported, ...completedOps.imported]) {
      logger.info(importedOpLabel(op));
    }
    for (const op of [...failedOps.displaced, ...completedOps.displaced]) {
      logger.info(displacedOpLabel(op, segment));
    }
    // #1198: the segment's FAILED in-flight op(s) come first (they are
    // the newest work of the failed deploy).
    // go-to-k/cdkd#4584: without `--revert-failed` only the proven
    // failed-CREATE orphans are acted on — the journal is their only
    // record — and every other failed op is left as-is.
    const failedToReplay = failedOpsToReplay(failedOps.replay, options.revertFailed === true);
    if (failedOps.replay.length > 0) {
      if (failedToReplay.length > 0) {
        // go-to-k/cdkd#4754: the replay re-checks a kept fix-forward
        // orphan before skipping it, so the plan the user confirms does
        // too, in the scope its replay runs in; the replay then keeps
        // whatever this preview could not prove.
        const failedPlan = await inSegmentScope(segment, () =>
          recheckFailedPlan(planFailedOps(failedToReplay, planStateView), planStateView, {
            providerRegistry,
            region,
            logger,
          })
        );
        for (const item of failedPlan) {
          logger.info(failedActionLabel(item, options.skipFinalSnapshot === true));
          // A failed nested row's revert replays its child's journal too.
          if (revertedNestedRowIds([item.op]).length > 0) {
            for (const line of await previewNestedChildRevert(
              setup.stateBackend,
              nestedChildStackName(stackName, item.op.logicalId),
              region,
              segment.runId,
              options.skipFinalSnapshot === true
            )) {
              logger.info(line);
            }
          }
        }
        applyFailedPlanToPreview(failedPlan, planStateView, options.skipFinalSnapshot === true);
      }
      for (const fop of failedOps.replay.filter((op) => !failedToReplay.includes(op))) {
        // Each journal value is named only when plain, described
        // otherwise: the line names `--revert-failed` (go-to-k/cdkd#4214).
        logger.info(
          `  - (left as-is) ${logicalIdShown(fop.logicalId)} (${resourceTypeShown(fop.resourceType)}) ` +
            `— its ${plainOrDescribed(fop.changeType, 'change type')} ` +
            `FAILED mid-deploy; pass --revert-failed to attempt reverting it`
        );
      }
    }
    const plan = planRollback(completedOps.replay, planStateView, orphanLogicalIds);
    for (const item of plan) {
      logger.info(actionLabel(item, options.skipFinalSnapshot === true));
      // Issue #3754: a nested row's revert replays its CHILD's journal, so
      // what that replay deletes or re-creates is part of what the user
      // confirms below.
      if (revertedNestedRowIds([item.op]).length > 0) {
        for (const line of await previewNestedChildRevert(
          setup.stateBackend,
          nestedChildStackName(stackName, item.op.logicalId),
          region,
          segment.runId,
          options.skipFinalSnapshot === true
        )) {
          logger.info(line);
        }
      }
    }
    // Apply the segment's effect to the preview so an earlier segment's
    // plan reflects the later segment's already-unwound state.
    applyPlanToPreview(plan, planStateView, options.skipFinalSnapshot === true);
  }
}

/**
 * The plan lines for a nested row's revert (issue #3754): the child's journal
 * segments for `runId`, planned against the child's state, indented under the
 * row. Read-only and best-effort — a preview that cannot be built says so
 * rather than failing the command; the revert itself refuses what it cannot
 * do.
 */
export async function previewNestedChildRevert(
  backend: Pick<S3StateBackend, 'getState' | 'loadRollbackJournal'>,
  childStackName: string,
  region: string,
  runId: string | undefined,
  skipFinalSnapshot: boolean
): Promise<string[]> {
  // Named only when plain, described otherwise, for the reason
  // `stackRegionShown` gives: this line is part of the run that can end in a
  // `Re-run with:` row (go-to-k/cdkd#3760). A described child carries the
  // same `cdkd state list --long` pointer the header does, since the parent's
  // name can be plain while the child's journal-sourced logical id is not.
  const plain = isPasteableIdent(childStackName);
  const shown = plain
    ? `nested stack ${childStackName}`
    : 'a nested stack whose name is not a plain identifier';
  const withPointer = (lines: string[]): string[] =>
    plain ? lines : [...lines, `        ${NESTED_NAME_DESCRIBED_NOTE}`];
  if (runId === undefined) {
    return withPointer([
      `      (${shown}: this segment carries no deploy run id — its revert will FAIL ` +
        `and the segment is kept)`,
    ]);
  }
  try {
    const [childState, journal] = await Promise.all([
      backend.getState(childStackName, region),
      backend.loadRollbackJournal(childStackName, region),
    ]);
    const segments = (journal?.segments ?? []).filter((s) => s.runId === runId);
    if (!childState || segments.length === 0) {
      return withPointer([
        `      (${shown}: no journal record for this run — its revert will FAIL ` +
          `and the segment is kept)`,
      ]);
    }
    const view: Record<string, ResourceState> = { ...childState.state.resources };
    const lines = [`      ${shown} replays its own journal:`];
    for (let s = segments.length - 1; s >= 0; s--) {
      // go-to-k/cdkd#4523: the child replay leaves an imported id's ops alone.
      const childOps = splitImportedOps(segments[s]!.operations, segments[s]!);
      for (const op of childOps.imported) lines.push(`    ${importedOpLabel(op)}`);
      for (const op of childOps.displaced) lines.push(`    ${displacedOpLabel(op, segments[s]!)}`);
      const childPlan = planRollback(childOps.replay, view, new Set<string>());
      for (const item of childPlan) lines.push(`    ${actionLabel(item, skipFinalSnapshot)}`);
      applyPlanToPreview(childPlan, view, skipFinalSnapshot);
    }
    if (lines.length === 1) lines.push('        (nothing to undo)');
    return withPointer(lines);
  } catch (error) {
    // `backendErrorText`, not `safe()`: the backend's message re-spells the
    // child's name, padding included, so a padded name is withheld whole
    // (go-to-k/cdkd#3760).
    return withPointer([
      `      (${shown}: could not preview its revert: ` +
        `${backendErrorText(error, childStackName, region)})`,
    ]);
  }
}

/**
 * Will the replay REFUSE this planned Snapshot delete instead of performing
 * it (issue #1368)? The preview must not unwind a record for an op that
 * never runs — the same question `snapshotNote` answers for the label,
 * asked with the same predicate and the same route, so the label and the
 * previewed state cannot disagree.
 */
export function planItemWillBeRefused(
  resourceType: string,
  effectiveProvisionedBy: 'sdk' | 'cc-api' | undefined,
  skipFinalSnapshot: boolean
): boolean {
  // Under the opt-out nothing is refused — every shape plain-deletes.
  if (skipFinalSnapshot) return false;
  return refusesFinalSnapshot(resourceType, effectiveProvisionedBy);
}

/**
 * Apply a planned segment's effect to the plan-preview state so the NEXT
 * (older) segment's plan is classified against already-unwound state.
 * Mirrors what `replayRollback` mutates, without touching AWS.
 */
export function applyPlanToPreview(
  plan: RollbackPlanItem[],
  previewState: Record<string, ResourceState>,
  skipFinalSnapshot: boolean
): void {
  for (const item of plan) {
    const { op, action } = item;
    switch (action) {
      case 'delete-with-final-snapshot':
        // A refused Snapshot delete leaves the resource AND its record in
        // place (issue #1368). Keeping the record is not cosmetic: an older
        // segment's item for the same logical id is classified against it,
        // and its route is stamped from it — drop it and that item silently
        // falls back to the journaled route, the #1366 defect one layer up.
        if (
          planItemWillBeRefused(op.resourceType, item.effectiveProvisionedBy, skipFinalSnapshot)
        ) {
          break;
        }
        if (op.changeType === 'CREATE') delete previewState[op.logicalId];
        break;
      case 'delete':
      case 'orphan-retain':
      case 'orphan-flag':
        if (op.changeType === 'CREATE') delete previewState[op.logicalId];
        break;
      case 'revert':
      case 'reverse-replacement':
      case 'reverse-replacement-readopt':
        if (op.previousState) previewState[op.logicalId] = op.previousState;
        break;
      default:
        break;
    }
  }
}

/**
 * Apply a planned FAILED-op revert's effect to the plan-preview state
 * (issue #1198). Mirrors `replayFailedOperations` without touching AWS.
 */
export function applyFailedPlanToPreview(
  plan: FailedOpPlanItem[],
  previewState: Record<string, ResourceState>,
  skipFinalSnapshot: boolean
): void {
  for (const item of plan) {
    const { op, action } = item;
    switch (action) {
      case 'delete-failed-create-with-final-snapshot':
        // Same refusal carve-out as the completed-op path (issue #1368).
        if (
          planItemWillBeRefused(op.resourceType, item.effectiveProvisionedBy, skipFinalSnapshot)
        ) {
          break;
        }
        // go-to-k/cdkd#4754: nor one proven another resource than the op's.
        if (!recordUnderIdIsNotOwn(op, previewState)) delete previewState[op.logicalId];
        break;
      case 'delete-failed-create':
      // Retain-orphan drops the record too (issue #1362) — the resource
      // stops being cdkd-managed either way. Not a replacement orphan's
      // (go-to-k/cdkd#4604): the record under its id is the replaced resource.
      case 'orphan-failed-create-retain':
        if (!recordUnderIdIsNotOwn(op, previewState)) delete previewState[op.logicalId];
        break;
      case 'revert-failed-update':
        if (op.previousState) previewState[op.logicalId] = op.previousState;
        break;
      default:
        break;
    }
  }
}
