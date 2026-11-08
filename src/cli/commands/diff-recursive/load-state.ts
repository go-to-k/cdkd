import { hasPendingMovesOut, pendingMovesRefusalMessage } from '../../../state/pending-moves.js';
import {
  readRefactorMarkerOnce,
  refactorMarkerRefusalMessage,
} from '../../../state/refactor-marker.js';
import type { StackState } from '../../../types/state.js';
import {
  STATE_SCHEMA_VERSION_CURRENT,
  hasReadableExportSet,
  isReadableBag,
} from '../../../types/state.js';
import type { S3StateBackend } from '../../../state/s3-state-backend.js';
import {
  malformedExportNamesWarning,
  malformedOutputsWarning,
  malformedResourceEntriesWarning,
  malformedResourcePropertiesWarning,
  malformedResourcesWarning,
  malformedOrphansWarning,
  repairMalformedOrphansForReadOnly,
  repairMalformedOutputsForReadOnly,
  repairMalformedResourceEntriesForReadOnly,
  repairMalformedResourcePropertiesForReadOnly,
  repairMalformedResourcesForReadOnly,
} from '../../../state/malformed-resources-bag.js';
import type { LockRecoveryContext } from '../../../state/lock-contention-message.js';
import { logger } from './logger.js';
import type { UnreadableContainer } from './types.js';
import {
  deployRefusesPropertiesReason,
  DEPLOY_REFUSES_OUTPUTS_REASON,
  DEPLOY_REFUSES_RESOURCES_BAG_REASON,
  deployRefusesResourceEntriesReason,
  DEPLOY_REFUSES_ORPHANS_CONTAINER_REASON,
} from './refusals.js';

/** Load a stack's cdkd state, or synthesize an empty record (→ all CREATE) when none exists. */
export async function loadStateOrEmpty(
  stackName: string,
  region: string,
  stateBackend: S3StateBackend,
  // go-to-k/cdkd#4159: the run's account flags, carried on each warning's
  // `cdkd state show` pointer.
  refusalRecovery: LockRecoveryContext | undefined
): Promise<{
  state: StackState;
  unreadable: string[];
  unreadableContainers: UnreadableContainer[];
  deployRefusals: string[];
  /** Whether a record was read (false: the stack has no cdkd state yet). */
  found: boolean;
}> {
  const refactorMarker = readRefactorMarkerOnce(stateBackend);
  const result = await stateBackend.getState(stackName, region);
  // The refactor marker (go-to-k/cdkd#5212) refuses a deploy of a stack an
  // unfinished move involves, record or not, so the preview says so too.
  const markerRefusal = refactorMarkerRefusalMessage(
    await refactorMarker,
    stackName,
    region,
    'cdkd deploy'
  );
  if (result) {
    // What the repairs below take OUT of the record, returned beside it so the
    // node can report it (see `DiffTreeNode.unreadable`): the dropped entries'
    // logical ids, and apart from them the containers read as empty.
    const unreadable: string[] = [];
    const unreadableContainers: UnreadableContainer[] = [];
    // REPAIRED containers whose damage `cdkd deploy` REFUSES (go-to-k/cdkd#3335).
    // Separate from `unreadable` / `unreadableContainers`, which mean "dropped
    // from the diff": the reader's question is different — not "did the diff
    // read everything" but "will the deploy this previews start at all" — so a
    // DROPPED entry or container lands in its own list AND in this one
    // (go-to-k/cdkd#3512), and a repaired one previewed in place in this one
    // alone. They reach the node's `blocking`, so
    // `countBlocking` raises the exit-3 `DeployRefusalPreviewError` that
    // `cdkd diff` already spends on a refused adoption, ahead of `--fail`.
    //
    // Without this a record whose template declares nothing in the damaged
    // container has no delta, so `--fail` exited 0 and a CI step gating on it
    // passed over a record the next deploy stops on.
    const deployRefusals: string[] = [];
    if (repairMalformedResourcesForReadOnly(result.state)) {
      logger.warn(malformedResourcesWarning(stackName, region, refusalRecovery));
      // BOTH lists (go-to-k/cdkd#3512): the container entry says the diff dropped the bag,
      // which `--fail` counts, and the reason says the deploy refuses the
      // record (`refuseMalformedResourcesForDeploy`), which exit 3 reports —
      // including when the template declares nothing, where the empty bag
      // yields no change row at all.
      unreadableContainers.push('resources');
      deployRefusals.push(DEPLOY_REFUSES_RESOURCES_BAG_REASON);
    }
    // go-to-k/cdkd#3018. The bag repair above is not the whole rule, and the
    // gap was invisible to the sweep that produced it: a file IMPORTING this
    // module reads as remedied, while `hasReadableResources` tests the BAG and
    // says nothing about an ENTRY. `{"resources": {"R": null}}` therefore
    // survived the repair and threw on `resource.resourceType` in the two
    // nested-child walks below (`buildDiffTree`, `buildDeletedSubtree`) — the
    // raw `TypeError` go-to-k/cdkd#3159 removed from this command's bag half.
    //
    // REPAIR and not refuse: `cdkd diff` never writes, which the refuse-vs-repair
    // fence in `tests/unit/state/malformed-resources-bag.test.ts` asserts of
    // both this file and `diff.ts` rather than leaving to argument.
    const dropped = repairMalformedResourceEntriesForReadOnly(result.state);
    if (dropped.length > 0) {
      logger.warn(malformedResourceEntriesWarning(stackName, region, dropped, refusalRecovery));
      // One at a time, never spread: `push(...ids)` passes each id as an
      // ARGUMENT and throws a bare `RangeError` past the engine's argument
      // limit — the orphan-row twin below records the measurement.
      for (const id of dropped) unreadable.push(id);
      // The same pair as the bag above (go-to-k/cdkd#3512): every entry this
      // drops is one `refuseMalformedResourceEntriesForDeploy` refuses the
      // record over — a `null` row and a typeless object alike, with or
      // without a torn `properties` map.
      deployRefusals.push(deployRefusesResourceEntriesReason(dropped));
    }
    // The same treatment one level DOWN, on each entry's `properties` bag
    // (go-to-k/cdkd#3191). A separate call rather than a widening of
    // `repairMalformedResourcesForReadOnly`, for the reason this file's
    // `outputs` note already gives: the containers are independent and a
    // record can be malformed in any one alone, so the warning must name the
    // one that is actually broken.
    //
    // Ordered AFTER the bag repair deliberately —
    // `repairMalformedResourcePropertiesForReadOnly` walks entries, and an
    // unreadable BAG has none to walk. And AFTER the entry drop above, which
    // is not order-free: an OBJECT entry with no `resourceType` and a torn
    // `properties` map satisfies BOTH predicates, so running this first would
    // warn that its properties preview as additions and then drop the row
    // that warning describes. Fenced in
    // `tests/unit/cli/diff-recursive-malformed-properties.test.ts`.
    //
    // This call is what keeps `cdkd diff` on the read-only side of the split:
    // the same defect REFUSES inside `DiffCalculator.calculateDiff`, which
    // both `cdkd deploy` paths reach. `cdkd diff` persists nothing, so it
    // previews the record and says how the preview is wrong instead.
    const unreadableProps = repairMalformedResourcePropertiesForReadOnly(result.state);
    if (unreadableProps.length > 0) {
      logger.warn(
        malformedResourcePropertiesWarning(stackName, region, unreadableProps, refusalRecovery)
      );
      deployRefusals.push(deployRefusesPropertiesReason(unreadableProps));
    }
    // The SAME treatment for the `outputs` BAG (go-to-k/cdkd#3189). Every
    // consumer of that bag below this line takes it from
    // `currentState.outputs` — the resolver's stored-key lookups,
    // `mergeNoChangeOutputs`'s `persisted`, and `computeOutputsDiff`'s two
    // walks — so one call here dominates the bag, which is the placement rule
    // `src/state/malformed-resources-bag.ts`'s header records.
    //
    // Scoped to the BAG, deliberately, and still is: the Outputs flow also
    // reads `state.exportNames`, which this call does not touch. That half is
    // now guarded where it is READ rather than here —
    // `importableOutputKeys` (`src/types/state/helpers.ts`) used to call
    // `state.exportNames.filter(...)` unconditionally and threw a raw
    // `TypeError` from the `mergeNoChangeOutputs` call below on a hand-edited
    // non-array; it reads a non-array as an EMPTY export set now
    // (go-to-k/cdkd#3192). A guard here could not have covered it in any case:
    // that helper is reached from the exports index, the deploy-time resolver
    // and the local-command loader, none of which passes through this load.
    //
    // Separate warnings rather than one: they name different containers with
    // different consequences, and a record can be malformed in any one alone.
    if (repairMalformedOutputsForReadOnly(result.state)) {
      logger.warn(malformedOutputsWarning(stackName, region, refusalRecovery));
      deployRefusals.push(DEPLOY_REFUSES_OUTPUTS_REASON);
    }
    // The `orphans` CONTAINER, decided the same way and reported separately
    // (go-to-k/cdkd#3379). AT THE LOAD rather than at the adoption preview: the
    // preview is gated on `currentState.orphans?.length`, and for a STRING that
    // gate PASSES — `'abc'.length` is 3 — so the walk below it would render one
    // adoption row per character.
    if (repairMalformedOrphansForReadOnly(result.state)) {
      logger.warn(malformedOrphansWarning(stackName, region, refusalRecovery));
      unreadableContainers.push('orphans');
      // `refuseMalformedOrphans` refuses the deploy over it (go-to-k/cdkd#3512).
      deployRefusals.push(DEPLOY_REFUSES_ORPHANS_CONTAINER_REASON);
    }
    // An unfinished `cdkd refactor` move out of this stack (go-to-k/cdkd#5212):
    // `refusePendingMovesOut` refuses the deploy, so the preview says so.
    if (hasPendingMovesOut(result.state)) {
      deployRefusals.push(
        pendingMovesRefusalMessage(result.state, stackName, region, 'cdkd deploy')
      );
    }
    if (markerRefusal !== undefined) deployRefusals.push(markerRefusal);
    // The `exportNames` FIELD, said out loud (go-to-k/cdkd#3192 review). The
    // predicate fails closed wherever it is read, which is right — it serves
    // five commands and holds no stack identity — but a LOUD wrong answer
    // (the raw `TypeError` this replaced) becoming a QUIET one is its own
    // regression, and this load is the one place that can name the record.
    //
    // AFTER the bag repair, deliberately: `hasReadableExportSet` also requires
    // a readable `outputs`, so asking it first would blame `exportNames` for a
    // damaged BAG. By here the bag is `{}` — readable — so a false verdict
    // isolates the field, and a record damaged in both containers gets one
    // accurate line about each rather than two about the same thing.
    // The `isReadableBag` conjunct is what keeps this about `exportNames`.
    // `hasReadableExportSet` requires a readable BAG too, and the repair above
    // exempts an ABSENT one — a record cdkd itself writes — so without this a
    // perfectly ordinary no-outputs record drew a line blaming its
    // `exportNames`. The guard is watched from BOTH directions: dropping this
    // conjunct reds the absent-bag floor one describe up, and disabling the
    // whole line reds the four damaged-shape cases that assert the warning
    // FIRES. Until review round 10 only the first direction was covered, so
    // `if (false)` here was a zero-red mutation.
    if (isReadableBag(result.state.outputs) && !hasReadableExportSet(result.state)) {
      logger.warn(malformedExportNamesWarning(stackName, region, refusalRecovery));
    }
    return {
      state: result.state,
      unreadable,
      unreadableContainers,
      deployRefusals,
      found: true,
    };
  }
  return {
    found: false,
    state: {
      stackName,
      region,
      resources: {},
      outputs: {},
      version: STATE_SCHEMA_VERSION_CURRENT,
      lastModified: Date.now(),
    },
    unreadable: [],
    unreadableContainers: [],
    deployRefusals: markerRefusal === undefined ? [] : [markerRefusal],
  };
}
