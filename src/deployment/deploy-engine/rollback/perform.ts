/**
 * The automatic rollback of a failed deploy (`performRollback`).
 * Split out of `deploy-engine/rollback.ts` (go-to-k/cdkd#5835), which
 * re-exports what it exported.
 */
import type { RolledBackCreate } from '../../../state/name-generation.js';
import type {
  ResourceState,
  StackOrphanRecord,
  StackState,
  SupersededResourceRecord,
} from '../../../types/state.js';
import { pasteableCommand } from '../../../utils/pasteable-command.js';
import { recoveryCommandFlags } from '../../../state/lock-contention-message.js';
import { type SettledNestedRows, withNestedRevertRun } from '../../nested-child-journal.js';
import {
  type CompletedOperation,
  type FailedOperation,
  demoteSupersededOrphans,
  isJournaledOrphan,
  replacementNeverSwapped,
  replayFailedOperations,
  replayRollback,
} from '../../rollback-executor.js';
import { RollbackInlinePolicyWriters } from '../../inline-policy-claims.js';
import { addSuperseded, removeSuperseded } from '../../superseded-resources.js';
import { withPrintingSecrets } from '../../resource-secrets-scope.js';
import { completedReplayEntries } from '../../secret-name-needles.js';
import type { ForeignHolding } from '../../rollback-executor/journaled-orphans.js';
import type { RollbackDeps } from './deps.js';
import { replayPrintingBag } from './printing-bag.js';
import type { UnsettledRevertHooks } from './unsettled-revert.js';
import { revertUnsettledFailedUpdates } from './unsettled-revert.js';
import { rollbackExecutorContext } from './context.js';

/**
 * Perform best-effort rollback of completed operations (issue #1183:
 * extracted into `rollback-executor.ts` so the standalone `cdkd rollback`
 * command drives identical semantics). Thin wrapper that builds the
 * executor context from the engine's collaborators and delegates.
 */
export async function performRollback(
  deps: RollbackDeps,
  completedOperations: CompletedOperation[],
  stateResources: Record<string, ResourceState>,
  stackName: string,
  /**
   * The PRE-deploy state record, threaded in for issue #2057's
   * `importedProducerRegions`. Taken as a parameter rather than read off a
   * field because `currentState` is a local of `executeDeployment`, whose
   * automatic-rollback arm is this function's only caller.
   */
  previousState: StackState,
  /**
   * The attempt's failed operations. Only its journaled proven
   * failed-CREATE orphans are replayed (go-to-k/cdkd#4584): the rest stay
   * opt-in through `cdkd rollback --revert-failed`.
   */
  failedOperations: readonly FailedOperation[] = [],
  /**
   * The pre-deploy rollback-orphan records, read by the caller below the
   * deploy flow's orphans guard: one holding an orphan's id may own it.
   */
  priorOrphans: readonly StackOrphanRecord[] = [],
  /** go-to-k/cdkd#5505: the engine's side of {@link revertUnsettledFailedUpdates}. */
  unsettledRevert?: UnsettledRevertHooks
): Promise<{
  failures: number;
  warnings: number;
  /**
   * go-to-k/cdkd#3338: the ops THIS replay declined and left unreverted. The
   * caller keeps the journal segment when non-zero. A nested child's skips
   * are not counted here: they already keep the child's own segments (its
   * row is not settled).
   */
  skipped: number;
  /**
   * The user's Ctrl-C stopped the replay part-way: the caller keeps the
   * journal segment, which `cdkd rollback` resumes.
   */
  interrupted: boolean;
  orphaned: StackOrphanRecord[];
  /** go-to-k/cdkd#5064: the CREATEs it took back, whose generations retire. */
  rolledBackCreates: RolledBackCreate[];
  /**
   * go-to-k/cdkd#5064: the new copies a renamed reversal left in AWS (a
   * deferred delete that failed, or one kept for a dependent that did not
   * revert), which the caller's post-rollback save records as superseded.
   */
  superseded: SupersededResourceRecord[];
  /**
   * Issue #3754: the nested-stack rows whose child replay COMPLETED (no
   * failure, no skip), with the grandchildren each completed. A row the
   * replay skipped never reached the provider, so it is not among them.
   */
  settledNested: SettledNestedRows;
  /**
   * The failed operations a later `cdkd rollback --revert-failed` still
   * needs: every one but the proven orphans this rollback handled
   * (go-to-k/cdkd#4584). The clean-rollback settle records these.
   */
  remainingFailedOps: FailedOperation[];
}> {
  // go-to-k/cdkd#4584: CloudFormation parity — a CREATE whose provider proved
  // it made the resource before failing is deleted by the rollback, per its
  // journaled DeletionPolicy, exactly as `--revert-failed` would. Replayed on
  // COPIES: the supersede pass below rewrites the flag, and the originals are
  // what the journal records. Only this attempt's segment can supersede its
  // own orphans (no newer one exists), so the pass reads the pre-deploy
  // rollback-orphan records alone (`priorOrphans`).
  const orphanIndexes: number[] = [];
  const orphanOps: FailedOperation[] = [];
  // go-to-k/cdkd#4604: with them, the failed UPDATE of a replacement whose
  // orphan is among them. It settles as a no-op (the old resource was never
  // written to), and it must not outlive its orphan's entry in the journal:
  // without it, a later `--revert-failed` would force-revert the old resource.
  failedOperations.forEach((op, i) => {
    if (
      !isJournaledOrphan(op) &&
      !(op.changeType === 'UPDATE' && replacementNeverSwapped(op, failedOperations))
    ) {
      return;
    }
    orphanIndexes.push(i);
    orphanOps.push({ ...op });
  });
  demoteSupersededOrphans(
    [{ operations: completedOperations, failedOperations: orphanOps }],
    priorOrphans
  );
  // go-to-k/cdkd#4705: a create may have been handed a resource that existed
  // under its generated name, which only the SAME stack name deployed under
  // another state prefix shares. So each delete asks the cross-prefix holder
  // alone (memoized, run only when something is to be deleted). Not the
  // same-prefix scan the settle runs: another stack there has other generated
  // names, and that scan fails closed on any unreadable record, which would
  // turn every rollback in the prefix into keep-everything.
  const crossPrefixHolder = deps.options.crossPrefixHolder;
  let crossPrefixAnswer: Promise<ForeignHolding> | undefined;
  const ctx = {
    ...rollbackExecutorContext(deps, previousState, stackName),
    // A `cdkd rollback` replays the journal the keep leaves, from the
    // top-level stack (a nested child's journal included).
    createdResourceRetryCommand: pasteableCommand(
      'cdkd rollback',
      [
        {
          value: (deps.options.parentStackInfo?.parentStack ?? stackName).split('~')[0]!,
          hole: 'stack',
        },
      ],
      recoveryCommandFlags(deps.options.refusalRecovery).flags
    ).command,
    createdResourceHolder:
      crossPrefixHolder === undefined
        ? undefined
        : (): Promise<ForeignHolding> => (crossPrefixAnswer ??= crossPrefixHolder(stackName)),
  };
  // go-to-k/cdkd#4225: one record of completed writes across both replays.
  const inlinePolicyWriters = new RollbackInlinePolicyWriters();
  // go-to-k/cdkd#5064: a renamed reversal's new copy still to delete; the one
  // save on this path is the caller's, which records what is left here.
  const supersededHost: Pick<StackState, 'supersededResources'> = {};
  // Issue #3754: a nested-stack row reverted here replays its child's
  // journal segments for THIS run, which `NestedStackProvider` reads from
  // the scope, and reports back into it.
  const runId = deps.options.eventRecorder?.runId;
  const { result, failed, unsettled, run } = await withNestedRevertRun(runId, async (scope) => {
    // The failed op is the newest work of the failed deploy, so it goes first
    // — as in `cdkd rollback`: it may depend on what the completed CREATEs
    // made, never the reverse.
    const failedResult =
      orphanOps.length > 0
        ? // go-to-k/cdkd#3869: the orphans' deletes run under a PRINTING bag,
          // so a provider's delete lines mask a name derived from a secret,
          // and the context's events mask a name an orphan READ from a record.
          await withPrintingSecrets(
            replayPrintingBag(
              deps,
              orphanOps.map((op) => ({ ...op, properties: op.attemptedProperties })),
              stateResources
            ),
            () =>
              replayFailedOperations(orphanOps, stateResources, stackName, ctx, {
                // `replayRollback` emits no envelope over zero ops (a failed-only
                // attempt), so this replay owns it then.
                emitEnvelope: completedOperations.length === 0,
                inlinePolicyWriters,
              })
          )
        : undefined;
    // go-to-k/cdkd#5505: CloudFormation rolls the failed update back too. A
    // failed UPDATE that left keys unsettled is reverted here, after its keys
    // stop moving, through the `--revert-failed` arm. Before the completed ops,
    // as above: the failed resource may still use what a completed CREATE made.
    const unsettled = await revertUnsettledFailedUpdates(
      deps,
      ctx,
      stackName,
      stateResources,
      failedOperations,
      new Set(orphanIndexes),
      {
        emitEnvelope: completedOperations.length === 0 && orphanOps.length === 0,
        inlinePolicyWriters,
        hooks: unsettledRevert,
      }
    );
    return {
      failed: failedResult,
      unsettled,
      // go-to-k/cdkd#3869: the completed ops revert under the same kind of
      // bag, judged from each op's record and the one it replaced, so a
      // provider's delete of a CREATE this deploy made masks its name.
      result: await withPrintingSecrets(
        replayPrintingBag(deps, completedReplayEntries(completedOperations), stateResources),
        () =>
          replayRollback(completedOperations, stateResources, stackName, ctx, {
            inlinePolicyWriters,
            failedOperations,
            // Only the user's Ctrl-C (go-to-k/cdkd#5118): the sibling failure
            // that started this rollback holds the engine's other flag. It
            // also ends a name-release wait or a re-create retry here.
            isInterrupted: () => deps.userInterrupted(),
            onSuperseded: (entry) => addSuperseded(supersededHost, entry),
            onSupersededSettled: (entry) => removeSuperseded(supersededHost, entry),
          })
      ),
      run: scope,
    };
  });
  const pendingOrphans = new Set(failed?.remainingFailedOps ?? []);
  const handled = new Set(orphanIndexes.filter((_, k) => !pendingOrphans.has(orphanOps[k]!)));
  for (const index of unsettled.handled) handled.add(index);

  // `orphaned` is relayed rather than persisted here: this function holds no
  // state save. Its caller merges it into the post-rollback record (issue
  // #2934), which is the ONLY save on this path — dropping it there makes a
  // live, billing AWS resource untrackable and re-opens the deploy loop the
  // record closes.
  return {
    failures: result.failures + (failed?.failures ?? 0),
    // A child replay's skips surface on its row as a `partial` outcome,
    // which the executor does not count; the scope does.
    warnings: result.warnings + run.warnings + (failed?.warnings ?? 0) + unsettled.warnings,
    skipped: result.skipped + (failed?.skipped ?? 0),
    interrupted: result.interrupted || unsettled.interrupted,
    orphaned: [...(failed?.orphaned ?? []), ...result.orphaned],
    rolledBackCreates: [...(failed?.rolledBackCreates ?? []), ...result.rolledBackCreates],
    superseded: supersededHost.supersededResources ?? [],
    settledNested: run.settled,
    remainingFailedOps: failedOperations.filter((_, i) => !handled.has(i)),
  };
}
