/**
 * Rollback executor (issue #1183).
 *
 * The reusable engine that reverts a list of {@link CompletedOperation}s —
 * extracted from `DeployEngine` so BOTH callers drive identical semantics:
 *
 * - `DeployEngine` runs it in-process after a failed deploy (automatic
 *   rollback, unchanged behavior except the two fixes below).
 * - The standalone `cdkd rollback` command runs it against a persisted
 *   rollback journal (issue #1183 §journal), so a `--no-rollback` /
 *   interrupted / partially-failed-auto-rollback deploy can be reverted
 *   later.
 *
 * The executor deliberately depends only on `ProviderRegistry`, the stack
 * region, a logger, and an optional event recorder + per-op state-save
 * hook. It does NOT touch `DagBuilder` / `DiffCalculator` / the synthesizer
 * / `ExportIndexStore`, so the command can construct it without any of the
 * engine's synth-side collaborators (rollback never publishes
 * outputs/exports).
 *
 * Two deliberate behavior fixes vs. the pre-extraction in-process path
 * (both are pre-existing gaps; fixing them once benefits both callers):
 *
 * 1. **DeletionPolicy on CREATE rollback** — rolling a CREATE back IS a
 *    delete as far as the policy is concerned (CloudFormation semantics), so
 *    the CURRENT state record's `DeletionPolicy` decides what happens:
 *    - `Retain` → ORPHANED (removed from state, left in AWS). The policy
 *      says KEEP the resource, so cdkd does.
 *    - `Snapshot` → final snapshot, THEN delete (issue #1358), through the
 *      same mechanism matrix as `deploy-engine/replacement.ts`'s
 *      `prepareFinalSnapshotForDelete`: atomic delete parameter for the
 *      SDK-routed `ATOMIC_FINAL_SNAPSHOT_TYPES`, an explicit pre-delete
 *      snapshot for `PRE_DELETE_SNAPSHOT_TYPES`, refusal for every other
 *      Snapshot shape (cc-api routing included) unless
 *      `--skip-final-snapshot` opts into the data loss. This arm ORPHANED
 *      alongside `Retain` until #1358: when this file was written cdkd could
 *      not create a final snapshot at all, so leaving the resource behind
 *      was the only non-destructive option — but it silently handed the user
 *      an untracked, billing resource that state no longer knew about.
 *      `src/provisioning/final-snapshot.ts` (#1352 / #1353) removed the
 *      constraint, so the policy is now honored literally.
 *    - `RetainExceptOnCreate` (which exists precisely to allow cleanup of
 *      failed creates) and absent / `Delete` → DELETE.
 * 2. **Idempotent replay skip rules** — so a partially-failed rollback can
 *    be re-run safely (also harmless for the in-process caller, which
 *    replays each op exactly once).
 */

import { replayProducerRegionEvidence } from './rollback-executor/replay-secrets.js';
import { replayRollbackUnbound } from './rollback-executor/replay-completed.js';
import { replayFailedOperationsUnbound } from './rollback-executor/replay-failed.js';
import {
  newMovedIdCleanupQueue,
  runMovedIdCleanups,
} from './rollback-executor/replay-moved-id-cleanup.js';
import { withProducerRegions } from './producer-regions-scope.js';
import { replayStackRecordsView, withStackRecords } from './stack-records-scope.js';

export type { OwnUnsettled } from './rollback-executor/replay-failed-checks.js';

export {
  rollbackFinalSnapshotId,
  rollbackRetainsNewResource,
  retainedSurvivorMessages,
} from './rollback-executor/messages.js';

export {
  type CompletedOperation,
  type FailedOperation,
  type RollbackExecutorContext,
  type RollbackActionKind,
  type FailedOpActionKind,
  type FailedOpPlanItem,
  type RollbackPlanItem,
  type FailedOpReplayResult,
  type RollbackReplayResult,
} from './rollback-executor/types.js';
export {
  resolveReplacementOldType,
  isTypeChangeOp,
  isReplacementOp,
  classifyRollbackOp,
  withPreviousPolicies,
  classifyFailedOp,
  demoteSupersededOrphans,
  isJournaledOrphan,
  isReplacedRecord,
  isReplacementOrphan,
  markProvenDistinctFromRecord,
  replacementNeverSwapped,
  planFailedOps,
  recheckFailedPlan,
  recordUnderIdIsNotOwn,
  planRollback,
  sortRollbackCreates,
} from './rollback-executor/plan.js';

export { refuseUnprovenReplaySecret } from './rollback-executor/replay-secrets.js';

/**
 * The region classifier and its helpers moved to
 * `./secret-region-classification.js` for issue
 * [#2134](https://github.com/go-to-k/cdkd/issues/2134): the resolver needs the
 * same answer, and THIS module imports the resolver, so the dependency had to
 * run the other way.
 *
 * Re-exported here rather than repointing the importers, because
 * `classifyReplaySecretRegion` and `producerRegionsFromState` are named in the
 * `cdkd drift` / `cdkd scrub` docs and in several issue threads as living on
 * the replay -- and the point of the shared classifier is that there is ONE
 * answer, not that it has one address.
 */
export {
  classifyReplaySecretRegion,
  producerRegionsFromState,
  regionLessSecretName,
  type ReplaySecretRegionVerdict,
} from './secret-region-classification.js';

/**
 * {@link replayRollbackUnbound}, with this replay's producer-region evidence bound
 * for a nested-stack row it reverts (go-to-k/cdkd#4174).
 */
export async function replayRollback(
  ...args: Parameters<typeof replayRollbackUnbound>
): ReturnType<typeof replayRollbackUnbound> {
  return await withProducerRegions(
    () => replayProducerRegionEvidence(args[3]),
    // go-to-k/cdkd#4492: the replay's records, so deleting one holder of a
    // resource another record still holds leaves it in place.
    () =>
      withStackRecords(replayStackRecordsView(args[1], args[4]?.orphanLogicalIds), () =>
        replayRollbackUnbound(...args)
      )
  );
}

/**
 * {@link replayFailedOperationsUnbound}, with this replay's producer-region evidence bound
 * for a nested-stack row it reverts (go-to-k/cdkd#4174).
 */
export async function replayFailedOperations(
  ...args: Parameters<typeof replayFailedOperationsUnbound>
): ReturnType<typeof replayFailedOperationsUnbound> {
  return await withProducerRegions(
    () => replayProducerRegionEvidence(args[3]),
    // go-to-k/cdkd#4492: the replay's records, so deleting one holder of a
    // resource another record still holds leaves it in place.
    () =>
      withStackRecords(replayStackRecordsView(args[1]), async () => {
        // go-to-k/cdkd#6120: the ids a `--revert-failed` update moved off are
        // deleted after the last op: by the caller's own replay when it hands
        // a queue in (`cdkd rollback` runs it after the segment's completed
        // ops), else here, inside this replay's event envelope.
        const [ops, stateResources, stackName, ctx, options = {}] = args;
        if (options.movedIdCleanups !== undefined) {
          const result = await replayFailedOperationsUnbound(...args);
          // Interrupted, the caller's next replay never runs: nothing is sent.
          if (result.interrupted) {
            await runMovedIdCleanups(options.movedIdCleanups, {
              stateResources,
              stackName,
              ctx,
              result,
              afterOp: options.afterOp,
              interrupted: true,
            });
          }
          return result;
        }
        const movedIdCleanups = newMovedIdCleanupQueue(options);
        const envelope = options.emitEnvelope === true && ops.length > 0;
        if (envelope) ctx.recordEvent?.({ eventType: 'ROLLBACK_STARTED', stackName });
        const result = await replayFailedOperationsUnbound(ops, stateResources, stackName, ctx, {
          ...options,
          emitEnvelope: false,
          movedIdCleanups,
        });
        await runMovedIdCleanups(movedIdCleanups, {
          stateResources,
          stackName,
          ctx,
          result,
          afterOp: options.afterOp,
          interrupted: result.interrupted || options.isInterrupted?.() === true,
        });
        if (envelope) ctx.recordEvent?.({ eventType: 'ROLLBACK_FINISHED', stackName });
        return result;
      })
  );
}
