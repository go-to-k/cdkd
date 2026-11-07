/**
 * The recovery hint and the `RollbackExecutorContext` the engine hands the rollback executor.
 * Split out of `deploy-engine/rollback.ts` (go-to-k/cdkd#5835), which
 * re-exports what it exported.
 */
import { crossStackReadsForPartialSave } from '../../deploy-engine.js';
import type { StackState } from '../../../types/state.js';
import { quotedOrDescribed } from '../../../utils/pasteable-command.js';
import {
  type ProducerRegionEvidence,
  inheritProducerRegions,
} from '../../producer-regions-scope.js';
import { type RollbackExecutorContext, producerRegionsFromState } from '../../rollback-executor.js';
import { maskEventTextWithBoundBags } from '../../secret-name-needles.js';
import type { RollbackDeps } from './deps.js';

/**
 * The recovery sentence a `--no-rollback` failure ends on. A NESTED child
 * engine does not name a command: a stack-less `cdkd rollback` resolves to
 * the top-level stack, and the child's failure fails the parent's row, whose
 * engine (sharing `noRollback` through the option spread) prints its own
 * `--no-rollback` message right after (go-to-k/cdkd#3864). NOT used on the
 * interrupted path: a child's poll `InterruptedError` reaches the parent
 * wrapped and is not recognised as an interrupt there (go-to-k/cdkd#3875),
 * so no message of the parent's can be promised to follow.
 */
export function recoveryHint(deps: RollbackDeps, topLevel: string): string {
  const parent = deps.options.parentStackInfo;
  if (parent === undefined) return topLevel;
  return (
    `This is a nested stack: recover it through its top-level stack ` +
    `${quotedOrDescribed(parent.parentStack.split('~')[0]!, 'stack name')}, whose own message follows.`
  );
}

/** Build the {@link RollbackExecutorContext} from the engine's fields. */
export function rollbackExecutorContext(
  deps: RollbackDeps,
  previousState: StackState,
  stackName: string
): RollbackExecutorContext {
  const producerRegions = producerRegionEvidence(deps, previousState);
  return {
    providerRegistry: deps.providerRegistry,
    region: deps.stackRegion,
    logger: deps.logger,
    // go-to-k/cdkd#3869: masked by the printing bags bound where the event
    // is recorded too (a journaled orphan batch's), as its log lines are.
    recordEvent: (event) => deps.recordEvent(maskEventTextWithBoundBags(event)),
    // `DeletionPolicy: Snapshot` on a rolled-back CREATE (issue #1358) —
    // the executor needs the same region-pinned clients + data-loss
    // opt-out the engine's own delete sites use.
    finalSnapshotClients: deps.options.finalSnapshotClients,
    skipFinalSnapshot: deps.options.skipFinalSnapshot,
    // A nested child's own rollback: its segment is replayed only by a
    // rollback of the CHILD, so the refusals' `--orphan` command names it
    // (go-to-k/cdkd#3859).
    ...(deps.options.parentStackInfo && { nestedChildStack: stackName }),
    // go-to-k/cdkd#1998: the LOG-ONLY needles (a `NoEcho` parameter's
    // value) this deploy recorded per resource, which the replay's own
    // re-resolution of the journal cannot re-derive.
    logOnlyNeedlesFor: (logicalId) => deps.secretsRun().perResourceSecrets.get(logicalId),
    // See `producerRegionEvidence`.
    importedProducerRegions: producerRegions.regions,
    producerRegionsIncomplete: !producerRegions.complete,
  };
}

/**
 * The producer regions this stack reads across (issue #2057), so a replay
 * refuses a region-LESS `{{resolve:...}}` expression rather than
 * re-resolving it here and writing a same-named foreign secret to a live
 * resource. The UNION is what makes this reachable at all — a rollback runs
 * only after a FAILED deploy, and the read this deploy INTRODUCED is in
 * `recordedImports` / `recordedOutputReads`, never yet in the persisted
 * snapshot. Strictly more evidence than `cdkd rollback` can derive on its
 * own, which sees only what a save persisted.
 *
 * A nested child adds its parent's (go-to-k/cdkd#4174), and is complete
 * only when those are.
 */
export function producerRegionEvidence(
  deps: RollbackDeps,
  previousState: StackState
): ProducerRegionEvidence {
  const own = producerRegionsFromState(
    crossStackReadsForPartialSave(
      previousState,
      deps.recordedImports(),
      deps.recordedOutputReads(),
      deps.crossStackReadKeyNormalizer()
    )
  );
  if (!deps.options.parentStackInfo) return { regions: own, complete: true };
  return inheritProducerRegions(own, deps.options.inheritedProducerRegions?.());
}
