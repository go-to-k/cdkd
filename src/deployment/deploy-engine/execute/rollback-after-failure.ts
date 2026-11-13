import {
  performRollback,
  recoveryHint,
  settleJournalAfterCleanRollback,
  settleNestedChildrenAfterCleanRollback,
  writeRollbackJournalSegment,
} from '../rollback.js';
import { secretNameBagFor } from '../masking.js';
import { withPrintingSecrets } from '../../resource-secrets-scope.js';
import { unionOfSecretBags } from '../../secret-redaction.js';
import { orphanRecordsPrintingBag } from '../../secret-name-needles.js';
import { supersededAfterRollback } from '../../superseded-resources.js';
import { InterruptedError, crossStackReadsForPartialSave } from '../../deploy-engine.js';
import { isInterruptedWaitError } from '../../../provisioning/interrupt-watch.js';
import {
  STATE_SCHEMA_VERSION_CURRENT,
  type StackOrphanRecord,
  type StackState,
  type SupersededResourceRecord,
  exportNamesCarriedFrom,
  stackInstanceIdCarriedFrom,
  orphansAfterRollback,
  skippedOutputsCarriedFrom,
} from '../../../types/state.js';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import { asIsMessage, safeMsg } from '../../../utils/display-safe.js';
import { pasteableCommand } from '../../../utils/pasteable-command.js';
import type { SettledNestedRows } from '../../nested-child-journal.js';
import type { FailedOperation } from '../../rollback-executor.js';
import { retiredAfterRollback, type RolledBackCreate } from '../../../state/name-generation.js';
import { dropUnsettledMarks, recordUnsettledMarks } from './helpers.js';
import {
  deletedOutsideCdkdMessage,
  partitionDeletedOutsideCdkd,
} from '../../deleted-outside-cdkd.js';
import {
  revertFailedHasNothingToDo,
  revertSkipsFailedCreate,
  unaddressableFailedCreateMessage,
} from '../rollback/applied-nothing.js';
import { deletedOutsideReadDeps } from '../rollback/deleted-outside-read.js';
import type { DeployRun } from './run.js';

/**
 * The ways on from a partially-applied deploy, one pasteable command per line
 * with the run's flags, so under `--aws-emulator` a pasted one does not run
 * against real AWS (go-to-k/cdkd#6245).
 */
function partialStateRemedy(stackName: string): string {
  const stack = { value: stackName, hole: 'stack' } as const;
  const matched = { ...stack, opts: { patternMatched: true } } as const;
  return (
    'Resume, revert, or clean up with one of:\n' +
    `  ${pasteableCommand('cdkd deploy', [matched]).command}\n` +
    `  ${pasteableCommand('cdkd rollback', [stack]).command}\n` +
    `  ${pasteableCommand('cdkd destroy', [matched]).command}`
  );
}

/**
 * The failed deploy's journal segment, automatic rollback and post-rollback
 * save (go-to-k/cdkd#5835: moved out of `executeDeployment`'s catch, which
 * rethrows `error` after it). `currentEtag` is the ETag the pre-rollback
 * save left.
 */
export async function rollbackFailedDeploy(
  run: DeployRun,
  error: unknown,
  initialDeploy: boolean,
  currentEtag: string | undefined
): Promise<void> {
  const { engine, stackName, currentState, newResources, completedOperations, failedOperations } =
    run;
  // Set true when an automatic rollback replayed with zero per-op
  // failures and zero skips — gates the post-save journal deletion below.
  let autoRollbackClean = false;
  // Whether this attempt's `auto-rollback-started` segment was written: the
  // settle below pops the NEWEST segment, which without one is an OLDER
  // attempt's revert record (go-to-k/cdkd#4356 review). The nested settle is
  // skipped with it, so after a FAILED write a reverted child's pending
  // segments for this run stay until the next top-level success sweeps them.
  let autoRollbackJournaled = false;
  // Resources this deploy's rollback left in AWS under `DeletionPolicy: Retain`
  // (issue #2934). Stays empty when no rollback ran, so the saves below
  // spread nothing and a stack that never orphaned keeps a byte-identical
  // record.
  let rollbackOrphans: StackOrphanRecord[] = [];
  // go-to-k/cdkd#5064: the CREATEs that rollback took back; each logical
  // id's generation retires, so the next create asks for a new name.
  let rollbackCreates: RolledBackCreate[] = [];
  // go-to-k/cdkd#5064: the new copies the rollback left in AWS to delete.
  let rollbackSuperseded: SupersededResourceRecord[] = [];
  // The nested rows the automatic rollback actually reverted (issue
  // #3754): only their children's pending segments are settled with it.
  let rollbackSettledNested: SettledNestedRows = new Map();
  // The failed ops the clean-rollback settle keeps for `--revert-failed`:
  // all but the proven failed-CREATE orphans the rollback handled
  // (go-to-k/cdkd#4584).
  let rollbackRemainingFailedOps: FailedOperation[] = failedOperations;

  // On SIGINT, skip rollback — just save partial state, record a rollback
  // journal segment so the interrupted deploy is REVERTIBLE (not just
  // resumable), and let the caller exit.
  //
  // A user interrupt reaches this catch in three shapes, and all three must
  // take this branch — the other one rolls the stack back on a Ctrl-C:
  //
  //  - the engine's own `InterruptedError`, raised by its between-ops poll;
  //  - an `InterruptedWaitError` from a provider's wait, WRAPPED by the
  //    provider's `ProvisioningError` (issue #2040), which
  //    `isInterruptedWaitError` finds on the cause chain;
  //  - an `InterruptedError` WRAPPED by `provisionResource`'s own
  //    `ProvisioningError`: one raised by this engine's retry backoff
  //    (`onInterrupted`), or by a NESTED child engine's poll, which reaches
  //    the parent through `NestedStackProvider` (go-to-k/cdkd#3875).
  //
  // The last shape is keyed on this engine's own `interruptCause`, not on
  // the class: `InterruptedError` does not carry its cause, and a child's
  // `'sibling-failure'` one must still roll back. The SIGINT handler sets
  // `'user'` before any poll or backoff can observe the signal, and a row
  // failure's `??= 'sibling-failure'` never overwrites it.
  if (
    error instanceof InterruptedError ||
    isInterruptedWaitError(error) ||
    engine.interruptCause === 'user'
  ) {
    await writeRollbackJournalSegment(
      engine.rollbackDeps(),
      stackName,
      completedOperations,
      failedOperations,
      'interrupted',
      initialDeploy
    );
    engine.logger.info(
      // asIsMessage: the remedy's line breaks are cdkd's own, and its stack
      // name is gated by `pasteableCommand`.
      safeMsg`Partial state saved (${Object.keys(newResources).length} resources). ${asIsMessage(
        recoveryHint(engine.rollbackDeps(), partialStateRemedy(stackName))
      )}`
    );
    throw error;
  }

  // Deployment failed — attempt rollback unless --no-rollback is set
  if (engine.options.noRollback) {
    // Record a journal segment so `cdkd rollback` can revert the failed
    // deploy later instead of only fixing forward / destroying.
    await writeRollbackJournalSegment(
      engine.rollbackDeps(),
      stackName,
      completedOperations,
      failedOperations,
      'no-rollback-failure',
      initialDeploy
    );
    engine.logger.warn('Deployment failed. --no-rollback is set, skipping rollback.');
    engine.logger.warn(
      safeMsg`Partial state has been saved. ${asIsMessage(
        recoveryHint(engine.rollbackDeps(), partialStateRemedy(stackName))
      )}`
    );
  } else {
    // Automatic in-process rollback. Write a journal segment FIRST so a
    // rollback that dies partway (crash / network / per-op failure)
    // leaves the segment behind and becomes resumable via `cdkd
    // rollback`; the segment is deleted after a clean replay + save.
    autoRollbackJournaled = await writeRollbackJournalSegment(
      engine.rollbackDeps(),
      stackName,
      completedOperations,
      failedOperations,
      'auto-rollback-started',
      initialDeploy
    );
    const rollbackResult = await performRollback(
      engine.rollbackDeps(),
      completedOperations,
      newResources,
      stackName,
      currentState,
      failedOperations,
      currentState.orphans ?? [],
      // go-to-k/cdkd#5505: the revert acts on THIS run's marks only (never a
      // name an earlier deploy left), waits for an abandoned call of the
      // failed update and records its late marks first. Once a revert is
      // handled, the record says what stays unsettled (its proof decides), so
      // the post-rollback save below must not re-add the engine's copy of
      // those names; a mark that arrives later still records.
      {
        runMarks: (logicalId) => ({
          names: engine.unsettledMarks.get(logicalId) ?? new Set(),
          items: engine.unsettledItemMarks.get(logicalId) ?? new Map(),
        }),
        stillRunning: (logicalId) => engine.inFlightBodies.get(logicalId),
        recordMarks: (logicalId) => recordUnsettledMarks(engine, newResources, logicalId),
        onReverted: (logicalId, settled) => dropUnsettledMarks(engine, logicalId, settled),
      }
    );
    // go-to-k/cdkd#3338: a SKIPPED op was never reverted, so the segment
    // recording it is kept, as for a failure: settling it would delete the
    // only record of a resource the rollback left as the failed deploy did.
    // A survivor warning (a retained new copy) is not a skip: its op WAS
    // reverted, and its event names the survivor.
    autoRollbackClean =
      autoRollbackJournaled &&
      rollbackResult.failures === 0 &&
      rollbackResult.skipped === 0 &&
      // A Ctrl-C left ops unreverted: the segment stays for `cdkd rollback`.
      !rollbackResult.interrupted;
    if (
      rollbackResult.interrupted &&
      rollbackResult.failures === 0 &&
      rollbackResult.skipped === 0
    ) {
      // go-to-k/cdkd#5118: the user's Ctrl-C stopped the replay part-way.
      // A nested child is recovered through its top-level stack. A failed
      // journal write already warned that nothing was kept.
      const remedy = autoRollbackJournaled
        ? recoveryHint(
            engine.rollbackDeps(),
            'The rollback journal keeps them; finish the rollback with: ' +
              pasteableCommand('cdkd rollback', [{ value: stackName, hole: 'stack' }]).command
          )
        : '';
      engine.logger.warn(
        safeMsg`The automatic rollback was interrupted before it reverted every operation. ${remedy}`
      );
    }
    if (rollbackResult.failures === 0 && rollbackResult.skipped > 0) {
      // The kept segment also keeps the failed op's record, which the next
      // deploy's generic note (a plain `cdkd rollback`, which discards it)
      // no longer points at, so name `--revert-failed` here. Not for a
      // nested child: its stack-less `cdkd rollback` would resolve to the
      // top-level stack (go-to-k/cdkd#3864).
      engine.logger.warn(
        safeMsg`The automatic rollback could not revert ${rollbackResult.skipped} operation(s) ` +
          `(see the warnings above; each is recorded as a ROLLBACK_RESOURCE_SKIPPED event).` +
          // A failed journal write already warned that nothing was kept.
          (autoRollbackJournaled ? ` The rollback journal keeps them.` : '')
      );
      // Only over a segment THIS attempt wrote: otherwise nothing was kept,
      // and `--revert-failed` would act on an OLDER attempt's record.
      if (
        autoRollbackJournaled &&
        engine.options.parentStackInfo === undefined &&
        // What the replay left, not every failed op: one it settled (a
        // replacement's UPDATE warned about with its orphan) is gone, and a
        // `--revert-failed` would only repeat its warning.
        rollbackResult.remainingFailedOps.some((op) => op.changeType !== 'DELETE')
      ) {
        // go-to-k/cdkd#6106: an op whose resource AWS reports gone is named
        // as deleted outside cdkd; `--revert-failed` has nothing to revert
        // for it (and drops its record when it meets it).
        const { gone, kept } = await partitionDeletedOutsideCdkd(
          deletedOutsideReadDeps(engine.rollbackDeps()),
          rollbackResult.remainingFailedOps
        );
        for (const op of gone) engine.logger.warn(deletedOutsideCdkdMessage(op, false));
        // go-to-k/cdkd#6204: a failed CREATE with no physical id is only
        // skipped by the revert; its manual check is named instead.
        const actionable = kept.some((op) => !revertFailedHasNothingToDo(op));
        if (!actionable) {
          for (const op of kept.filter(revertSkipsFailedCreate)) {
            engine.logger.warn(unaddressableFailedCreateMessage(op));
          }
        }
        if (actionable) {
          engine.logger.warn(
            safeMsg`The record of the operation that failed is kept too. Revert it with: ${
              pasteableCommand('cdkd rollback', [
                { value: stackName, hole: 'stack' },
                { literal: '--revert-failed' },
              ]).command
            }`
          );
        }
      }
    }
    // Hoisted out of this block because both saves below sit outside it
    // (issue #2934) — the post-rollback save and its ETag-mismatch retry —
    // and neither can see `rollbackResult`.
    rollbackOrphans = rollbackResult.orphaned;
    rollbackCreates = rollbackResult.rolledBackCreates;
    rollbackSuperseded = rollbackResult.superseded;
    rollbackSettledNested = rollbackResult.settledNested;
    rollbackRemainingFailedOps = rollbackResult.remainingFailedOps;
  }

  // Save state after rollback (reflects rolled-back resource state).
  // This is critical: if rollback deleted resources, the state must reflect
  // that. Otherwise, next deploy will think deleted resources still exist.
  // go-to-k/cdkd#5380: a mark a provider made while the rollback ran.
  recordUnsettledMarks(engine, newResources);
  try {
    const postRollbackState: StackState = {
      version: STATE_SCHEMA_VERSION_CURRENT,
      region: engine.stackRegion,
      stackName: currentState.stackName,
      resources: newResources,
      outputs: currentState.outputs,
      ...exportNamesCarriedFrom(currentState),
      ...skippedOutputsCarriedFrom(currentState),
      ...orphansAfterRollback(currentState, rollbackOrphans),
      ...stackInstanceIdCarriedFrom(currentState),
      // go-to-k/cdkd#5064: a renamed reversal's new copy left to delete.
      ...supersededAfterRollback(currentState, { supersededResources: rollbackSuperseded }),
      // go-to-k/cdkd#5064: what the rollback left in AWS is not taken back,
      // and a CREATE it took back is named anew by the next create.
      ...retiredAfterRollback(currentState, rollbackOrphans, rollbackCreates),
      // Issue #2057: the UNION of the pre-deploy snapshot and what THIS
      // session resolved. See `crossStackReadsForPartialSave` — writing the
      // snapshot alone left a failed deploy's persisted record denying a
      // cross-stack read its own resources were built from.
      ...crossStackReadsForPartialSave(
        currentState,
        engine.recordedImports,
        engine.recordedOutputReads,
        engine.crossStackReadKeyNormalizer()
      ),
      lastModified: Date.now(),
    };
    await engine.stateBackend.saveState(
      stackName,
      engine.stackRegion,
      engine.withParentInfo(postRollbackState),
      {
        ...(currentEtag !== undefined && { expectedEtag: currentEtag }),
      }
    );
    engine.logger.debug('State saved after deployment failure');
    // Auto-rollback replayed cleanly AND the post-rollback state save
    // succeeded — the pre-deploy baseline is restored, so settle the
    // journal (issue #1183): drop it entirely, or — when the segment
    // carries failed in-flight op(s) — keep a failed-only segment so
    // `cdkd rollback --revert-failed` still works (issue #1208). A
    // partial / failed rollback keeps the full segment so `cdkd
    // rollback` can resume.
    if (autoRollbackClean) {
      await settleNestedChildrenAfterCleanRollback(
        engine.rollbackDeps(),
        stackName,
        rollbackSettledNested,
        await settleJournalAfterCleanRollback(
          engine.rollbackDeps(),
          stackName,
          rollbackRemainingFailedOps,
          initialDeploy
        )
      );
    }
  } catch (saveError) {
    // ETag mismatch from per-resource saves — force overwrite with fresh ETag
    engine.logger.debug(
      safeMsg`Retrying state save after rollback (ETag mismatch): ${asIsMessage(describeAwsFailure(saveError).detail)}`
    );
    try {
      const freshState = await engine.stateBackend.getState(stackName, engine.stackRegion);
      const freshEtag = freshState?.etag;
      recordUnsettledMarks(engine, newResources);
      const postRollbackState: StackState = {
        version: STATE_SCHEMA_VERSION_CURRENT,
        region: engine.stackRegion,
        stackName: currentState.stackName,
        resources: newResources,
        outputs: currentState.outputs,
        ...exportNamesCarriedFrom(currentState),
        ...skippedOutputsCarriedFrom(currentState),
        ...orphansAfterRollback(currentState, rollbackOrphans),
        ...stackInstanceIdCarriedFrom(currentState),
        ...supersededAfterRollback(currentState, { supersededResources: rollbackSuperseded }),
        ...retiredAfterRollback(currentState, rollbackOrphans, rollbackCreates),
        // Issue #2057: the UNION of the pre-deploy snapshot and what THIS
        // session resolved. See `crossStackReadsForPartialSave` — writing the
        // snapshot alone left a failed deploy's persisted record denying a
        // cross-stack read its own resources were built from.
        ...crossStackReadsForPartialSave(
          currentState,
          engine.recordedImports,
          engine.recordedOutputReads,
          engine.crossStackReadKeyNormalizer()
        ),
        lastModified: Date.now(),
      };
      await engine.stateBackend.saveState(
        stackName,
        engine.stackRegion,
        engine.withParentInfo(postRollbackState),
        {
          ...(freshEtag !== undefined && { expectedEtag: freshEtag }),
        }
      );
      engine.logger.debug('State saved after deployment failure (retry succeeded)');
      if (autoRollbackClean) {
        await settleNestedChildrenAfterCleanRollback(
          engine.rollbackDeps(),
          stackName,
          rollbackSettledNested,
          await settleJournalAfterCleanRollback(
            engine.rollbackDeps(),
            stackName,
            rollbackRemainingFailedOps,
            initialDeploy
          )
        );
      }
    } catch (retryError) {
      engine.logger.warn(
        safeMsg`Failed to save state after rollback: ${asIsMessage(describeAwsFailure(retryError).detail)}`
      );
      // go-to-k/cdkd#5064: the rollback said these stay in state; that save
      // is the one that failed, so name them. An id can spell a
      // secret-derived name (#3869): printed under each entry's bags.
      for (const entry of rollbackSuperseded) {
        withPrintingSecrets(
          unionOfSecretBags([
            secretNameBagFor(engine.secretsRun, entry.logicalId),
            orphanRecordsPrintingBag([entry]),
          ]),
          () =>
            engine.logger.warn(
              safeMsg`  ${entry.logicalId}'s new ${entry.state.resourceType} ` +
                safeMsg`(${entry.state.physicalId}) the rollback left to delete is NOT recorded: ` +
                'delete it manually.'
            )
        );
      }
    }
  }
}
