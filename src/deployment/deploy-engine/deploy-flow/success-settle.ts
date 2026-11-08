import { redactOutputs } from '../masking.js';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import { settleJournalAfterSuccess } from '../rollback.js';
import { importableOutputs } from '../../../types/state.js';
import { safeMsg } from '../../../utils/display-safe.js';
import { forgetRecordedCreateTokens } from '../../../provisioning/providers/create-token-ledger.js';
import { buildDisplayOutputs } from '../outputs.js';
import type { DeployEngine } from '../../deploy-engine.js';
import type { StackState, ResourceChange } from '../../../types/state.js';
import type { CloudFormationTemplate } from '../../../types/resource.js';
import type { PhaseClock } from '../../../utils/phase-timings.js';
import type { DeployResult } from '../options.js';
import type { executeDeployment } from '../execute.js';

type ExecutedDeployment = Awaited<ReturnType<typeof executeDeployment>>;

/**
 * Step 7c of a deploy and its result: the writes that follow a successful
 * final save, under the lock (moved from `deploy-flow.ts`).
 */
export async function settleSuccessfulDeploy(
  engine: DeployEngine,
  {
    stackName,
    template,
    currentState,
    currentEtag,
    changes,
    newState,
    actualCounts,
    completedOperations,
    finalSaveCleanup,
    startTime,
    clock,
  }: {
    stackName: string;
    template: CloudFormationTemplate;
    currentState: StackState;
    currentEtag: string | undefined;
    changes: Map<string, ResourceChange>;
    newState: ExecutedDeployment['state'];
    actualCounts: ExecutedDeployment['actualCounts'];
    completedOperations: ExecutedDeployment['completedOperations'];
    finalSaveCleanup: Promise<void> | undefined;
    startTime: number;
    clock: PhaseClock;
  }
): Promise<DeployResult> {
  // go-to-k/cdkd#4438: the record now names every resource this deploy
  // created, so their create-token `sent` entries have done their job.
  // go-to-k/cdkd#4705: likewise a kept resource this deploy took back: its
  // record now names it, so `retained.json` lets it go. Best-effort. Both
  // run beside 7c's writes below (review P4): disjoint objects, read by
  // neither, so no serial round trip on a successful deploy.
  const ledgerAndKeptCleanup = (async (): Promise<void> => {
    await forgetRecordedCreateTokens(Object.keys(newState.resources));
    const readopted = (await engine.generatedNameGuard?.readoptedFromRetained()) ?? [];
    if (readopted.length > 0) {
      try {
        const kept = await engine.stateBackend.loadRetainedResources(stackName, engine.stackRegion);
        await engine.stateBackend.saveRetainedResources(
          stackName,
          engine.stackRegion,
          kept.filter((entry) => !readopted.includes(entry.logicalId))
        );
      } catch (error) {
        engine.logger.debug(
          safeMsg`Could not clear re-adopted resources from the kept-resource record: ${describeAwsFailure(error).summary}`
        );
      }
    }
  })();

  // 7c. Two independent post-save S3 writes, run CONCURRENTLY:
  //
  //   1. Delete the rollback journal. Deploy succeeded, so the stable
  //      baseline has moved and a journal from a prior failed attempt
  //      (fix-forward that now succeeded) must NOT be replayable past
  //      this point (issue #1183). Best-effort.
  //   2. Update the persistent exports index with this stack's outputs
  //      so subsequent `Fn::ImportValue` resolves hit O(1). Best-effort:
  //      failures are swallowed inside updateForStack and surfaced as
  //      warnings (state.json is canonical; a stale index self-heals on
  //      the next deploy/resolve fallback).
  //
  // They target DISJOINT S3 objects — `{prefix}/{stack}/{region}/
  // rollback-journal.json` vs the bucket-level exports index — and
  // neither reads what the other writes: `updateForStack` only ever
  // touches the exports index (plus, on a first-ever call, a rebuild
  // scan of `state.json` files, which the journal delete does not
  // affect), and the journal delete reads nothing at all. So the
  // previous sequential ordering carried no dependency; it was costing
  // a full extra S3 round trip on every successful deploy (measured
  // ~0.5s of the ~1.0s "State saved" -> "Lock released" window).
  //
  // BOTH stay strictly AFTER the state save above and strictly BEFORE
  // the lock release in the `finally` below, which is load-bearing:
  // deleting the journal before the new baseline is durable would lose
  // the ability to revert, and releasing the lock before these settle
  // would let a concurrent deploy of the same stack observe a journal
  // we are about to delete (spurious "a previous deploy failed" note)
  // or race the exports-index read-modify-write.
  // go-to-k/cdkd#4600: a journaled proven orphan the settle could not
  // delete is a resource left in AWS, counted with the skipped deletes.
  const [journaledOrphansLeft] = await Promise.all([
    settleJournalAfterSuccess(
      engine.rollbackDeps(),
      stackName,
      completedOperations,
      currentState,
      newState.resources,
      currentEtag === undefined
    ),
    engine.exportIndexStore
      ? engine.exportIndexStore.updateForStack(
          stackName,
          engine.stackRegion,
          // The EXPORTS only (issue #2193): the bag also holds every plain
          // Output name, and an index fed the whole bag served those to
          // `Fn::ImportValue` — a same-named plain Output in an unrelated
          // stack could shadow a real export.
          importableOutputs({
            ...newState,
            outputs: redactOutputs(engine.maskingDeps(), newState.outputs),
          })
        )
      : Promise.resolve(),
    ledgerAndKeptCleanup,
    finalSaveCleanup,
  ]);
  clock.lap('journal settle, exports index');

  const durationMs = Date.now() - startTime;
  const unchangedCount =
    engine.diffCalculator.filterByType(changes, 'NO_CHANGE').length + actualCounts.skipped;

  return {
    stackName,
    created: actualCounts.created,
    updated: actualCounts.updated,
    deleted: actualCounts.deleted,
    deleteSkipped: actualCounts.deleteSkipped + journaledOrphansLeft,
    updatePartial: actualCounts.updatePartial,
    nestedUpdatePartial: actualCounts.nestedUpdatePartial,
    ...((actualCounts.crossPrefixKept ?? 0) > 0 && {
      crossPrefixKept: actualCounts.crossPrefixKept,
    }),
    unchanged: unchangedCount,
    durationMs,
    outputs: buildDisplayOutputs(
      template,
      redactOutputs(engine.maskingDeps(), newState.outputs ?? {})
    ),
    attributeFallbackCount: engine.resolver.getPhysicalIdFallbackCount(),
  };
}
