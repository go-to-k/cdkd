import { refusePendingMovesOut } from '../../../state/pending-moves.js';
import { refuseRefactorMarker } from '../../../state/refactor-marker.js';
import {
  refuseMalformedOrphanRecords,
  refuseMalformedOrphans,
  refuseMalformedOutputs,
  refuseMalformedResourceEntriesForDeploy,
  refuseMalformedResourceProperties,
  refuseMalformedResourcesForDeploy,
} from '../../../state/malformed-resources-bag.js';
import { isKnownTokenFreeState } from '../../../state/token-free-state.js';
import { provenanceBaselineOf } from '../provenance-capture.js';
import type { LoadedStateData } from './types.js';
import type { DeployEngine } from '../../deploy-engine.js';
import type { StackState } from '../../../types/state.js';
import type { readRefactorMarker } from '../../../state/refactor-marker.js';

/**
 * The refusals the loaded record must pass before anything reads it, and the
 * provenance baseline taken once they have (moved from `deploy-flow.ts`).
 */
export function refuseUnreadableLoadedState(
  engine: DeployEngine,
  {
    stackName,
    currentState,
    currentStateData,
    refactorMarker,
  }: {
    stackName: string;
    currentState: StackState;
    currentStateData: LoadedStateData;
    refactorMarker: Awaited<ReturnType<typeof readRefactorMarker>>;
  }
): void {
  // AT THE LOAD, and REFUSE rather than repair (issue #3207). `deploy` is
  // the most write-capable consumer of this bag there is: the no-change
  // merge path below carries `currentState.outputs ?? {}` into
  // `persistedOutputs` and SAVES it, five failure-path saves write
  // `outputs: currentState.outputs` verbatim, and the next success
  // republishes the result into `cdkd/_index/<region>/exports.json` — the
  // namespace every other stack's `Fn::ImportValue` binds against. So a
  // string bag is rebuilt into a well-formed map of one fabricated export
  // per CHARACTER and the only signal the record was damaged is gone
  // permanently: the laundering go-to-k/cdkd#3192 exists to stop.
  //
  // Here rather than at the twelve later reads because every one of them is
  // dominated by this point, which is the placement rule
  // `repairMalformedResourcesForReadOnly`'s own note records: a per-walk
  // `?? {}` is inert for this class, since each flow dereferences the
  // container a line earlier.
  refuseMalformedOutputs(
    currentState,
    stackName,
    engine.stackRegion,
    engine.options.refusalRecovery
  );
  // And the `resources` bag, a SEPARATE container with a separate absence
  // rule, refused separately so the message names the one that is broken
  // (issue go-to-k/cdkd#3161).
  //
  // The gap go-to-k/cdkd#3317 measured and left: it closed the per-ENTRY
  // `properties` map at `DiffCalculator.calculateDiff`, and that
  // predicate returns `[]` for a record whose ROOT bag is itself
  // unreadable — so `"resources": "abcdef"` still reached the diff and
  // enumerated two fabricated logical ids, while a `[]` or a `5`
  // enumerated none and planned every template resource as a CREATE,
  // re-provisioning a stack that already exists.
  //
  // HERE rather than at `calculateDiff`, although that is the chokepoint
  // both diff callers share: this load DOMINATES the call and the reads
  // between them, the first of which is the `Object.keys(...)` debug line
  // immediately below — where a `null` bag raised the bare `TypeError`
  // go-to-k/cdkd#3018 exists to remove. `cdkd diff` keeps its repair-and-warn
  // half at its own load, so the preview this refusal points at still works.
  refuseMalformedResourcesForDeploy(
    currentState,
    stackName,
    engine.stackRegion,
    engine.options.refusalRecovery
  );
  // And each ROW of that bag (go-to-k/cdkd#3314). A `null` or typeless row
  // reads as absent in the diff and is planned as a CREATE of a resource
  // this stack already manages. `calculateDiff` refuses it too, but two
  // walks run before the diff and each died on the row first, with a bare
  // `TypeError`: the CLI's prefix-migration gate (`onCurrentStateLoaded`
  // below) and the observed-state auto-refresh. The load dominates both.
  // It does not dominate the CLI's PRE-lock `--recreate-via-*` check, which
  // reads the named rows itself (go-to-k/cdkd#3202 owns that site).
  refuseMalformedResourceEntriesForDeploy(
    currentState,
    stackName,
    engine.stackRegion,
    engine.options.refusalRecovery
  );
  // And each row's `properties` MAP (go-to-k/cdkd#3211), BELOW the row guard,
  // which names a typeless row with a torn map more precisely. `calculateDiff`
  // refuses it too, but the observed-state auto-refresh below hands the map
  // to `provider.readCurrentState` first, and the walks between here and the
  // diff read it. The load dominates every one of them.
  refuseMalformedResourceProperties(
    currentState,
    stackName,
    engine.stackRegion,
    engine.options.refusalRecovery
  );
  // The `orphans` CONTAINER, beside it and for the same placement reason
  // (go-to-k/cdkd#3379): the adoption pass below reads it on a bare `?? []`
  // and ASSIGNS `currentState.orphans` from what it read, so an unreadable
  // container is rewritten by a writer. AFTER the lock, so the guarantee is
  // "before any resource operation" rather than "before any lock".
  refuseMalformedOrphans(
    currentState,
    stackName,
    engine.stackRegion,
    engine.options.refusalRecovery
  );
  // The ROWS of a readable list (go-to-k/cdkd#3500). Its own call because
  // the questions are independent: the adoption pass below dereferences
  // each row's `state`, and `orphansAfterRollback` keys its merge map on
  // each row's `logicalId`, so a list that IS a list can still abort the
  // run, or collapse the rows MISSING a `logicalId` into one saved survivor.
  refuseMalformedOrphanRecords(
    currentState,
    stackName,
    engine.stackRegion,
    engine.options.refusalRecovery
  );
  // An unfinished `cdkd refactor` moving resources out of this stack
  // (go-to-k/cdkd#5212): the destination may already hold them, and this
  // deploy would DELETE each one the template no longer declares. One field
  // test on the record already loaded; no extra call.
  refusePendingMovesOut(currentState, stackName, engine.stackRegion, 'cdkd deploy');
  // And a move whose DESTINATION is this stack: its record knows nothing of
  // the move, and this deploy would create the resource a second time.
  refuseRefactorMarker(refactorMarker, stackName, engine.stackRegion, 'cdkd deploy');
  // State schema v12: the loaded outputs bag and its provenance, for a save
  // that carries that bag forward. After the refusals, which own the first
  // read of the bag.
  engine.provenanceBaseline = provenanceBaselineOf(
    currentState,
    isKnownTokenFreeState(currentStateData?.state)
  );
}
