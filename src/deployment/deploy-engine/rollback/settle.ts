/**
 * The rollback journal's settles after a deploy's outcome.
 * Split out of `deploy-engine/rollback.ts` (go-to-k/cdkd#5835), which
 * re-exports what it exported.
 */
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import { withoutPendingRequest } from '../../cc-pending-requests.js';
import { stackInstanceIdOf } from '../../../state/stack-instance-id.js';
import type { ResourceState, StackState } from '../../../types/state.js';
import {
  asIsMessage,
  displaySafe,
  displayStackName,
  safeMsg,
} from '../../../utils/display-safe.js';
import { pasteableCommand } from '../../../utils/pasteable-command.js';
import {
  NESTED_PENDING_PARENT_REASON,
  type SettledNestedRows,
  dropNestedChildJournals,
  dropSettledNestedJournals,
  nestedPendingSnapshot,
} from '../../nested-child-journal.js';
import type { CompletedOperation, FailedOperation } from '../../rollback-executor.js';
import {
  type ForeignHolding,
  makeForeignHolderScan,
  settleJournaledOrphansOnSuccess,
} from '../../rollback-executor/journaled-orphans.js';
import { hasReadableOrphans } from '../../../state/malformed-resources-bag.js';
import type { RollbackDeps } from './deps.js';
import { rollbackExecutorContext } from './context.js';
import { writeRollbackJournalSegment } from './journal-write.js';
import {
  deletedOutsideCdkdMessage,
  partitionDeletedOutsideCdkd,
} from '../../deleted-outside-cdkd.js';
import { deletedOutsideReadDeps } from './deleted-outside-read.js';

/**
 * Who else holds a resource, for the success settle: one same-prefix scan of the bucket's other stacks
 * (`makeForeignHolderScan`, made lazily on the first question), then, only
 * when it found no holder, the bucket's OTHER state prefixes
 * (`options.crossPrefixHolder`, go-to-k/cdkd#4705), asked once per stack.
 */
function foreignHolderResolver(
  deps: RollbackDeps
): (self: {
  stackName: string;
  region: string;
}) => (resourceType: string, physicalId: string) => Promise<ForeignHolding> {
  const sameBucketHolderFor = makeForeignHolderScan(deps.stateBackend);
  const crossPrefixHolder = deps.options.crossPrefixHolder;
  const crossPrefixAnswers = new Map<string, Promise<ForeignHolding>>();
  return (self) => async (resourceType, physicalId) => {
    const held = await sameBucketHolderFor(self)(resourceType, physicalId);
    if (held !== undefined || crossPrefixHolder === undefined) return held;
    let answer = crossPrefixAnswers.get(self.stackName);
    if (answer === undefined) {
      answer = crossPrefixHolder(self.stackName);
      crossPrefixAnswers.set(self.stackName, answer);
    }
    return answer;
  };
}

/**
 * The journal on a SUCCESSFUL deploy (issue #3754 split the one answer in
 * two).
 *
 * - A NESTED engine keeps its journal and appends a `nested-pending-parent`
 *   segment: its parent's deploy is still running, and if it fails, the
 *   revert of this child's row replays exactly these ops. The previous
 *   outputs ride along because the ops do not restore them. Older segments
 *   are kept too, since an older parent segment may still name them.
 * - The ROOT engine deletes its own journal (issue #1183: the baseline
 *   moved) and every descendant's, which is the same statement made for the
 *   whole tree — and it sweeps anything a crashed run left behind.
 *
 * go-to-k/cdkd#4600: a journal's proven failed-CREATE orphans are its only
 * record of a live resource, so the root first acts on each journal's
 * (`settleJournaledOrphansOnSuccess`: deleted, or skipped with a warning when
 * this deploy's outcome may own it) and keeps one whose entry could not be
 * acted on. Returns how many it left in AWS, which the caller counts as
 * unaddressed (the deploy exits 2).
 */
export async function settleJournalAfterSuccess(
  deps: RollbackDeps,
  stackName: string,
  completedOperations: CompletedOperation[],
  previousState: StackState,
  finalResources: Record<string, ResourceState>,
  initialDeploy: boolean
): Promise<number> {
  if (deps.options.parentStackInfo) {
    await writeRollbackJournalSegment(
      deps,
      stackName,
      completedOperations,
      [],
      NESTED_PENDING_PARENT_REASON,
      initialDeploy,
      // go-to-k/cdkd#4043 Phase C: an alias the previous record exported is
      // snapshotted only while this deploy's export-name verdict still
      // publishes it; with no verdict (no outputs pass ran), none is.
      nestedPendingSnapshot(previousState, (name) => {
        const verdict = deps.outputsRun().carriedExportAliasRefusal;
        const dropped = verdict === undefined || verdict(name, name) !== undefined;
        // Said once per dropped name: the revert of this child will not
        // restore it. The name is never printed: the verdict refuses it
        // because it spells a NoEcho value, and the deploy's own export
        // warning (a publish-time sentence) does not fit a revert snapshot.
        if (dropped) {
          deps.logger.warn(
            verdict === undefined
              ? 'An export alias the previous record published was not kept for a revert of ' +
                  'this nested stack: no export-name verdict is available.'
              : 'An export alias the previous record published was not kept for a revert of ' +
                  'this nested stack: its name contains a NoEcho value.'
          );
        }
        return dropped;
      })
    );
    return 0;
  }
  let nestedLeft = 0;
  const foreignHolderFor = foreignHolderResolver(deps);
  const deployRunId = deps.options.eventRecorder?.runId;
  const stripOnFailure = new Map<string, () => Promise<void>>();
  const [ownLeft] = await Promise.all([
    (async (): Promise<number> => {
      await orphanUntakenResumes(deps, stackName, finalResources);
      // The deploy read no journal under this lock, and nothing wrote one
      // since: no orphan to act on and nothing to delete. The key's leftover
      // versions were purged from the start of the deploy (step 1b).
      if (
        deps.absentJournalVersionPurge() !== undefined &&
        deps.stateBackend.rollbackJournalReadAbsent(stackName, deps.stackRegion)
      ) {
        await deps.absentJournalVersionPurge();
        return 0;
      }
      // `previousState.orphans` is the surviving set `adoptRollbackOrphans`
      // left: what the saved record holds. The deploy flow guarded it before
      // either of this function's call sites.
      const own = await settleJournaledOrphansOnSuccess({
        stateBackend: deps.stateBackend,
        stackName,
        stackInstanceId: stackInstanceIdOf(previousState, displayStackName(stackName)),
        region: deps.stackRegion,
        stateResources: finalResources,
        rollbackOrphans: previousState.orphans,
        retiredNameGenerations: previousState.retiredNameGenerations,
        newerOperations: completedOperations,
        ...(deployRunId !== undefined && { deployRunId }),
        foreignHolder: foreignHolderFor({ stackName, region: deps.stackRegion }),
        ctx: rollbackExecutorContext(deps, previousState, stackName),
        isInterrupted: () => deps.interrupted(),
        logger: deps.logger,
      });
      if (own.keepJournal) return own.unaddressed;
      // go-to-k/cdkd#4402: this run's completed ops supersede every older
      // failed attempt of their ids; if the delete fails they are carried
      // onto the journal instead, so no older attempt counts as evidence
      // again.
      const deleted = await deleteRollbackJournalBestEffort(
        deps,
        stackName,
        completedOperations.map((op) => op.logicalId)
      );
      // A surviving journal must not keep what this settle cleared as proven.
      if (!deleted) await own.stripCleared?.();
      return own.unaddressed;
    })(),
    dropNestedChildJournals({
      stateBackend: deps.stateBackend,
      lockManager: deps.lockManager,
      parentStackName: stackName,
      region: deps.stackRegion,
      resources: finalResources,
      logger: deps.logger,
      beforeDelete: async (child, childRecord) => {
        // An unreadable orphans container is an unreadable record: a rollback-
        // orphan record in it may own the resource, so nothing is deleted.
        const childState =
          childRecord !== undefined && hasReadableOrphans(childRecord) ? childRecord : undefined;
        const settled = await settleJournaledOrphansOnSuccess({
          stateBackend: deps.stateBackend,
          stackName: child,
          // go-to-k/cdkd#5064: the child's own lifetime.
          stackInstanceId: stackInstanceIdOf(childState, displayStackName(child)),
          region: deps.stackRegion,
          stateResources: childState?.resources,
          rollbackOrphans: childState?.orphans,
          retiredNameGenerations: childState?.retiredNameGenerations,
          // The child's own success appended its completed ops as a
          // `nested-pending-parent` segment of this run (`deployRunId`).
          newerOperations: [],
          ...(deployRunId !== undefined && { deployRunId }),
          foreignHolder: foreignHolderFor({ stackName: child, region: deps.stackRegion }),
          isInterrupted: () => deps.interrupted(),
          ctx: {
            ...rollbackExecutorContext(deps, childState ?? previousState, child),
            // Its parent's reads are not in the child's record (as destroy).
            producerRegionsIncomplete: true,
            nestedChildStack: child,
          },
          logger: deps.logger,
        });
        nestedLeft += settled.unaddressed;
        if (settled.stripCleared) stripOnFailure.set(child, settled.stripCleared);
        return !settled.keepJournal;
      },
      onDeleteFailed: async (child) => {
        await stripOnFailure.get(child)?.();
      },
    }),
  ]);
  return ownLeft + nestedLeft;
}

/**
 * Best-effort rollback-journal deletion (issue #1183) used on the deploy
 * success path and after a clean automatic rollback. Never throws — a
 * failed delete only warns (the journal is advisory; the worst case is a
 * spurious "previous deploy failed" note on the next deploy).
 *
 * `supersededLogicalIds` (go-to-k/cdkd#4402): the ids this run's completed
 * ops recorded. The delete is a segment removal like any other, so when it
 * fails they are written onto the surviving journal's newest segment
 * (`markRollbackJournalSuperseded`) — or an older failed attempt of one of
 * them would count as adoption evidence again.
 *
 * Returns whether the journal is gone (go-to-k/cdkd#4600: a caller that
 * settled entries in it strips them when it is not).
 */
export async function deleteRollbackJournalBestEffort(
  deps: RollbackDeps,
  stackName: string,
  supersededLogicalIds: readonly string[] = []
): Promise<boolean> {
  let deleted: boolean | void;
  try {
    // The backend REPORTS a DeleteObject failure (`false`) rather than
    // throwing; a throw here comes from before the delete (client setup).
    deleted = await deps.stateBackend.deleteRollbackJournal(stackName, deps.stackRegion);
  } catch (err) {
    deps.logger.debug(
      safeMsg`Failed to delete rollback journal for ${displayStackName(stackName)}: ${describeAwsFailure(err).detail}`
    );
    deleted = false;
  }
  // Only an explicit `false` (or a throw) is a journal that may survive.
  if (deleted !== false) return true;
  if (supersededLogicalIds.length === 0) return false;
  try {
    await deps.stateBackend.markRollbackJournalSuperseded(
      stackName,
      deps.stackRegion,
      supersededLogicalIds
    );
  } catch (markErr) {
    deps.logger.debug(
      safeMsg`Failed to record superseded logical ids on the rollback journal for ${displayStackName(stackName)}: ${describeAwsFailure(markErr).detail}`
    );
  }
  return false;
}

/**
 * Settle the rollback journal after a CLEAN automatic rollback (issue
 * #1208). The completed ops are reverted, but the op that FAILED mid-deploy
 * may have left its resource half-applied — and its journaled record is the
 * ONLY input `cdkd rollback --revert-failed` has. So instead of deleting the
 * journal outright (which made --revert-failed unusable in the DEFAULT
 * deploy flow), pop this attempt's segment and re-record a failed-only one
 * (`operations: []` + the failed ops). Older segments from prior
 * un-reverted attempts are preserved by the pop. The next successful deploy
 * still deletes the whole journal, bounding the lingering window. With no
 * failed ops there is nothing left to revert from THIS attempt — but only
 * this attempt's segment is popped, NOT the whole journal (issue #1215):
 * the clean rollback reverted only this attempt's ops, so older segments'
 * completed ops are still live in AWS/state and must keep their revert
 * records; pop deletes the object itself when the last segment goes, so
 * the common single-segment case still ends with no journal.
 *
 * Best-effort like every journal write: a pop failure warns and leaves the
 * full segment in place (the pre-#1208 partial-rollback shape — replay is
 * idempotent, so a later `cdkd rollback` is still safe).
 *
 * Returns whether this attempt's segment was popped, i.e. whether a later
 * `cdkd rollback` can still re-run it (issue #3754 gates dropping the
 * reverted children's segments on this).
 */
export async function settleJournalAfterCleanRollback(
  deps: RollbackDeps,
  stackName: string,
  failedOperations: FailedOperation[],
  initialDeploy: boolean
): Promise<boolean> {
  if (failedOperations.length === 0) {
    try {
      await deps.stateBackend.popRollbackJournalSegment(stackName, deps.stackRegion);
    } catch (err) {
      deps.logger.debug(
        safeMsg`Failed to pop the rollback journal segment after the clean rollback: ${asIsMessage(describeAwsFailure(err).detail)}`
      );
      return false;
    }
    return true;
  }
  // go-to-k/cdkd#6106: a failed UPDATE of a resource AWS reports gone is no
  // `--revert-failed` target (the revert's update fails the same way), so it
  // is named as deleted outside cdkd and not re-recorded.
  const { gone, kept: revertable } = await partitionDeletedOutsideCdkd(
    deletedOutsideReadDeps(deps),
    failedOperations
  );
  try {
    await deps.stateBackend.popRollbackJournalSegment(stackName, deps.stackRegion);
  } catch (err) {
    deps.logger.warn(
      safeMsg`Failed to settle the rollback journal after the clean rollback: ${describeAwsFailure(err).detail}. ` +
        // No command named: a nested child's stack-less `cdkd rollback` would
        // resolve to the top-level stack (go-to-k/cdkd#3864).
        `The journal keeps the full segment; a later rollback replay is idempotent.`
    );
    return false;
  }
  for (const op of gone) deps.logger.warn(deletedOutsideCdkdMessage(op, true));
  if (revertable.length === 0) return true;
  const kept = await writeRollbackJournalSegment(
    deps,
    stackName,
    [],
    revertable,
    'auto-rollback-clean',
    initialDeploy
  );
  // The write warns on its own failure; claiming a kept record would contradict it.
  if (!kept) return true;
  deps.logger.info(
    `The automatic rollback restored the pre-deploy state. The failed resource's pre-failure ` +
      `record was kept — if it was left partially applied, revert it.` +
      safeMsg`\nRevert it with: ${
        pasteableCommand('cdkd rollback', [
          { value: stackName, hole: 'stack' },
          { literal: '--revert-failed' },
        ]).command
      }`
  );
  return true;
}

/**
 * Issue #3754: once a clean automatic rollback is SETTLED — its state saved
 * and its segment popped — the nested children it reverted no longer need
 * their pending segments for this run. Gated on `settled` because a rollback
 * whose save or pop failed is re-run by `cdkd rollback`, which replays the
 * same rows and must find them.
 */
export async function settleNestedChildrenAfterCleanRollback(
  deps: RollbackDeps,
  stackName: string,
  settledNested: SettledNestedRows,
  settled: boolean
): Promise<void> {
  if (!settled) return;
  await dropSettledNestedJournals({
    stateBackend: deps.stateBackend,
    lockManager: deps.lockManager,
    parentStackName: stackName,
    region: deps.stackRegion,
    settled: settledNested,
    runId: deps.options.eventRecorder?.runId,
    logger: deps.logger,
  });
}

/**
 * go-to-k/cdkd#3252: settle, after the state record is saved, every completed
 * abandoned Cloud Control CREATE this deploy offered to resume. One its
 * CREATE took over, which the saved record now holds, loses its token. One
 * not taken (a condition pruned it, the template changed what it sends, or
 * its identifier is a name) is what the failed deploy left behind: a proven
 * orphan, which the settle that follows acts on. Best-effort: a failed
 * rewrite leaves the request pending, which keeps the journal for the next
 * run to settle.
 */
async function orphanUntakenResumes(
  deps: RollbackDeps,
  stackName: string,
  finalResources: Record<string, ResourceState>
): Promise<void> {
  if (deps.resumedCreates().size === 0) return;
  const untaken = new Map([...deps.resumedCreates().values()].map((r) => [r.requestToken, r]));
  deps.resetResumedCreates();
  try {
    await deps.stateBackend.rewriteRollbackJournalFailedOperations(
      stackName,
      deps.stackRegion,
      (op) => {
        const resumed =
          op.pendingCloudControlRequest === undefined
            ? undefined
            : untaken.get(op.pendingCloudControlRequest.requestToken);
        if (resumed === undefined) return op;
        if (resumed.gone || finalResources[op.logicalId]?.physicalId === resumed.identifier) {
          return withoutPendingRequest(op);
        }
        // Offered only when its identifier was proven unique (cc-pending-requests.ts).
        return {
          ...withoutPendingRequest(op),
          provisionedBy: 'cc-api',
          physicalId: resumed.identifier,
          physicalIdRecoveredFromError: true,
          createdIdentifierUnique: true,
        };
      }
    );
  } catch (error) {
    deps.logger.warn(
      safeMsg`Could not settle the resumed Cloud Control requests in the rollback journal of ` +
        safeMsg`${displayStackName(stackName)} (${displaySafe(describeAwsFailure(error).summary)}); ` +
        'the next run settles them.'
    );
  }
}
