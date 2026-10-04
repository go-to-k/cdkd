import type { ResourceState } from '../../types/state.js';
import type { Logger } from '../../types/config.js';
import { equalIdNamesDifferentResources } from '../type-change-guard.js';
import { effectiveDeletionPolicy } from '../../provisioning/final-snapshot.js';
import { CdkdError } from '../../utils/error-handler.js';
import { markNonRetryable } from '../retryable-errors.js';
import {
  type OldTypeSources,
  nonEmptyString,
  NESTED_STACK_RESOURCE_TYPE,
  type CompletedOperation,
  type RollbackExecutorContext,
  type RollbackActionKind,
  type FailedOperation,
  type FailedOpActionKind,
  type FailedOpPlanItem,
  type RollbackPlanItem,
} from './types.js';
import {
  refusalResourceType,
  orphanRemedy,
  ownRemedyError,
  refusalLogicalId,
  effectiveProvisionedBy,
  rollbackRetainsNewResource,
} from './messages.js';

/** The two places a journal can name the old resource's type, each `undefined` when unusable. */
function journaledOldTypes(op: OldTypeSources): {
  stamped: string | undefined;
  recorded: string | undefined;
} {
  return {
    stamped: nonEmptyString(op.previousResourceType) ? op.previousResourceType : undefined,
    recorded: nonEmptyString(op.previousState?.resourceType)
      ? op.previousState.resourceType
      : undefined,
  };
}

/**
 * Which type the OLD half of a replacement op routes on, or why that cannot be
 * decided (issue [#2668](https://github.com/go-to-k/cdkd/issues/2668)).
 *
 * Two sources name it: {@link CompletedOperation.previousResourceType} (written
 * by a binary that knows about Type changes) and `previousState.resourceType`
 * (journaled by every binary, inside the previous record). A legacy journal has
 * only the second, which is enough. The verdict is REFUSED rather than guessed
 * in three shapes, because a wrong answer dispatches a create and a delete at
 * the wrong service:
 *
 *   - neither source names a type (a hand-edited or torn op) — falling back to
 *     `op.resourceType` is exactly the single-type assumption this replaces;
 *   - the two sources disagree — one of them was edited, and nothing says which;
 *   - the types differ with `AWS::CloudFormation::Stack` on either side. The
 *     deploy refuses that pair at plan time (`type-change-guard.ts`), so only a
 *     journal from a binary older than that guard carries one, and what that
 *     deploy left behind is not knowable from the journal: its mis-routed
 *     delete may have destroyed the child it had just created.
 */
export function resolveReplacementOldType(
  op: OldTypeSources
): { ok: true; oldType: string } | { ok: false; reason: string } {
  const { stamped, recorded } = journaledOldTypes(op);
  if (stamped !== undefined && recorded !== undefined && stamped !== recorded) {
    return {
      ok: false,
      reason:
        `the journal names two different types for the old resource ` +
        // Described, not `safe()`: this reason is quoted on the unroutable
        // refusal's first line, which names `cdkd deploy` (go-to-k/cdkd#4214).
        `(previousResourceType ${refusalResourceType(stamped)}, ` +
        `previousState.resourceType ${refusalResourceType(recorded)})`,
    };
  }
  const oldType = stamped ?? recorded;
  if (oldType === undefined) {
    return { ok: false, reason: "the journal does not record the old resource's type" };
  }
  if (
    oldType !== op.resourceType &&
    (oldType === NESTED_STACK_RESOURCE_TYPE || op.resourceType === NESTED_STACK_RESOURCE_TYPE)
  ) {
    return {
      ok: false,
      reason:
        `it is a Type change between ${refusalResourceType(oldType)} and ` +
        `${refusalResourceType(op.resourceType)}, and cdkd does ` +
        `not replace a nested stack with, or by, a single resource`,
    };
  }
  return { ok: true, oldType };
}

/**
 * The one refusal both the `refuse-replacement-routing` arm and the
 * `reverse-replacement` arm's own guard raise. `markNonRetryable`: the verdict
 * is read off the journal alone, so no retry can change it.
 */
export function unroutableReplacementError(
  op: CompletedOperation,
  reason: string,
  remedyCtx: Pick<RollbackExecutorContext, 'nestedChildRevert' | 'nestedChildStack' | 'region'>
): Error {
  // The remedy is a labelled last line built by `orphanRemedy`, which owns
  // the gate on the id and the sentence for a withheld one.
  const remedy = orphanRemedy(op.logicalId, remedyCtx);
  return ownRemedyError(
    markNonRetryable(
      new CdkdError(
        `Cannot reverse the replacement of ${refusalLogicalId(op.logicalId)} ` +
          `(${refusalResourceType(op.resourceType)}): ` +
          `${reason}, so cdkd will not guess which provider re-creates the old resource. Nothing ` +
          `was changed. The journal is kept: fix forward with cdkd deploy` +
          (remedy.offered
            ? `, or leave this resource as it is and let the rest of the rollback proceed by ` +
              `re-running with the command below.`
            : '.') +
          `${remedy.clause}${remedy.line}`,
        'ROLLBACK_REPLACEMENT_UNROUTABLE'
      )
    )
  );
}

/**
 * True when the op changed the resource's `Type`. `false` when the old type is
 * not recorded at all: that shape is refused by {@link resolveReplacementOldType}
 * where it matters, and must not by itself turn an in-place op into a
 * replacement.
 */
export function isTypeChangeOp(op: OldTypeSources): boolean {
  const { stamped, recorded } = journaledOldTypes(op);
  return (
    (stamped !== undefined && stamped !== op.resourceType) ||
    (recorded !== undefined && recorded !== op.resourceType)
  );
}

/**
 * True when the op recorded a replacement: the old physical id differs from the
 * new one, OR the resource's `Type` changed (issue #2668). The second arm is
 * not redundant — two types' physical-id namespaces can overlap (a log group
 * and a Lambda function are both addressed by a bare name), so a Type change
 * can keep the id, and classified as an in-place `revert` it would hand the
 * NEW resource's id to an `update()` of either type. The old physical resource
 * is already gone / orphaned, so an in-place revert is best-effort — the plan
 * labels these explicitly.
 */
export function isReplacementOp(op: CompletedOperation): boolean {
  return (
    op.changeType === 'UPDATE' &&
    op.previousState?.physicalId !== undefined &&
    (op.previousState.physicalId !== op.physicalId ||
      isTypeChangeOp(op) ||
      // Issue #3892: an equal id can still be two resources (a Glue table
      // whose id is placed by DatabaseName), and an in-place revert of such
      // an op would aim the old properties at the NEW table.
      equalIdNamesDifferentResources({
        resourceType: op.resourceType,
        physicalId: op.physicalId,
        oldProperties: op.previousState.properties,
        newProperties: op.properties,
      }))
  );
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null) return a === b;
  if (typeof a !== typeof b) return false;
  if (typeof a !== 'object') return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const ak = Object.keys(ao);
  if (ak.length !== Object.keys(bo).length) return false;
  for (const k of ak) {
    if (!Object.prototype.hasOwnProperty.call(bo, k)) return false;
    if (!deepEqual(ao[k], bo[k])) return false;
  }
  return true;
}

/**
 * Classify what a single op WILL do against the current state, without
 * touching AWS. Pure — used both by the command's plan preview and by the
 * replayer (which re-derives the action to stay in lock-step with the
 * plan). `orphanLogicalIds` mirrors `cdk rollback --orphan`.
 */
export function classifyRollbackOp(
  op: CompletedOperation,
  stateResources: Record<string, ResourceState>,
  orphanLogicalIds: Set<string>
): RollbackActionKind {
  const replacement = isReplacementOp(op);

  if (op.changeType === 'DELETE') return 'unrecoverable-delete';

  if (orphanLogicalIds.has(op.logicalId)) return 'orphan-flag';

  if (op.changeType === 'CREATE') {
    const current = stateResources[op.logicalId];
    if (!current) return 'skip-already-done';
    if (op.physicalId !== undefined && current.physicalId !== op.physicalId) {
      return 'skip-mismatch';
    }
    // The CURRENT record's DeletionPolicy governs the rollback delete
    // (issue #1358): `Retain` keeps the resource (orphan), `Snapshot`
    // snapshots it first, everything else plain-deletes. Absent is
    // CloudFormation's default (issue #4030).
    const policy = effectiveDeletionPolicy(
      current.resourceType,
      current.deletionPolicy,
      current.properties
    );
    if (policy === 'Retain') return 'orphan-retain';
    if (policy === 'Snapshot') return 'delete-with-final-snapshot';
    return 'delete';
  }

  // UPDATE
  const current = stateResources[op.logicalId];
  if (!current) return 'skip-absent';
  if (replacement) {
    // Replacement op (#1199): the OLD physical resource was destroyed (or
    // orphaned under UpdateReplacePolicy: Retain) and the NEW one carries a
    // different physical id. An in-place revert is guaranteed to throw on
    // the immutable property, so reverse the replacement instead.
    // `&& sameTypeAsOld` (issue #2668): across a Type change an equal id is
    // not the same resource (overlapping namespaces), so "state already points
    // at the old id" additionally needs the record to BE the old type. An
    // unrecorded type on either side keeps the pre-#2668 id-only reading.
    const oldTypes = journaledOldTypes(op);
    const oldTypeForCompare = isTypeChangeOp(op)
      ? (oldTypes.stamped ?? oldTypes.recorded)
      : undefined;
    const sameTypeAsOld =
      oldTypeForCompare === undefined ||
      !nonEmptyString(current.resourceType) ||
      current.resourceType === oldTypeForCompare;
    if (
      current.physicalId === op.previousState!.physicalId &&
      sameTypeAsOld &&
      // Issue #3892: the equal id may be the NEW resource (a Glue table in
      // another database); it is the old one only when its record says so.
      !equalIdNamesDifferentResources({
        resourceType: op.resourceType,
        physicalId: current.physicalId,
        oldProperties: op.previousState!.properties,
        newProperties: current.properties,
      })
    ) {
      // State already points at the old physical id — a prior reverse-
      // replacement (or manual fix) already reverted this op.
      return 'skip-already-done';
    }
    if (op.physicalId !== undefined && current.physicalId !== op.physicalId) {
      // Neither the old nor the recorded new id. An AUTO-NAMED resource
      // re-created by a prior reverse-replacement lands here (its fresh
      // physical id matches neither) — recognize it by the properties
      // already matching the previous state. Anything else is a later
      // attempt's replacement; manual attention required.
      // `&& sameTypeAsOld` (issue #2668): two types can declare one identical
      // bag, so equal properties alone do not make the record the old one.
      if (sameTypeAsOld && deepEqual(current.properties, op.previousState!.properties)) {
        return 'skip-already-done';
      }
      return 'skip-mismatch';
    }
    // `Retain` orphaned the old resource instead of deleting it, so it still
    // exists and can be re-adopted without a re-create. THREE engine paths
    // produce that state: the property-driven create-then-destroy path skips
    // the delete, the `--replace` delete-first fallbacks refuse Retain
    // outright, and since issue #2518 the update-failure replacement fallback
    // is create-ONLY under Retain too. Before #2518 that third path DELETED
    // the old resource whatever the policy said, so this classification
    // re-adopted a physical id that no longer existed.
    //
    // Issue [#2603](https://github.com/go-to-k/cdkd/issues/2603): the two
    // sides used to ask the question of DIFFERENT sources — every engine path
    // decides from the TEMPLATE being applied, while this read the PREVIOUS
    // STATE record — so they disagreed on exactly the deploy that CHANGES
    // `UpdateReplacePolicy`, in both directions:
    //
    //   - ADDING `Retain`: the deploy orphans the old resource while
    //     `previousState.updateReplacePolicy` is still absent, so the stale
    //     read picked the plain `reverse-replacement` arm and RE-CREATED a
    //     resource that is still alive — a duplicate, or an `AlreadyExists`
    //     failure for a user-named type.
    //   - DROPPING `Retain`: the previous deploy persisted `Retain` into
    //     state, the current template omits it, so the engine correctly
    //     DELETES the old resource — and the stale read then classified
    //     `reverse-replacement-readopt` and pointed state at the deleted old
    //     physicalId with NO re-create. State ends up naming a resource that
    //     does not exist, which no later deploy detects as absent. Strictly
    //     worse than the ADD direction, where at least both resources are
    //     real.
    //
    // Both are closed by asking the ENGINE what it did rather than
    // re-deriving it: {@link CompletedOperation.oldResourceRetained} is
    // stamped at the moment the deploy skipped (or ran) the old resource's
    // delete. `??`, not `||` — an explicit `false` is the DROP direction's
    // whole point and must not fall through to the previous-state read.
    //
    // The fallback survives for ONE case: a journal written by a pre-#2603
    // binary, whose ops carry no verdict at all. There the previous-state
    // read is the only information that exists, so it stays — no worse than
    // that binary's own behaviour, and unreachable for anything a current
    // binary wrote.
    //
    // `Snapshot` is NOT retained on replacement (the engine plain-deletes) —
    // it re-creates like the default policy.
    //
    // Issue #2668, AFTER the idempotent skips above (an op that is already
    // reverted needs no routing) and BEFORE either reverse arm: both dispatch
    // on two types, and a replay that cannot name the old one must not guess.
    if (!resolveReplacementOldType(op).ok) return 'refuse-replacement-routing';
    const retained = op.oldResourceRetained ?? op.previousState!.updateReplacePolicy === 'Retain';
    return retained ? 'reverse-replacement-readopt' : 'reverse-replacement';
  }
  if (op.previousState && deepEqual(current.properties, op.previousState.properties)) {
    // Already reverted (idempotent re-run).
    return 'skip-already-done';
  }
  return 'revert';
}

/**
 * Classify what reverting a FAILED in-flight op (issue #1198) will do
 * against the current state, without touching AWS. Pure — used by both the
 * command's `--revert-failed` plan preview and {@link replayFailedOperations}.
 */
export function classifyFailedOp(
  op: FailedOperation,
  stateResources: Record<string, ResourceState>
): FailedOpActionKind {
  if (op.changeType === 'DELETE') {
    // The delete FAILED, so the resource is still in place and state still
    // records it — there is nothing to revert.
    return 'skip-failed-noop';
  }
  const current = stateResources[op.logicalId];
  if (op.changeType === 'CREATE') {
    // A failed CREATE normally records nothing (the provider threw before
    // returning a physical id) — the remote state is unknown. Falsy, not
    // `=== undefined`: an empty physical id identifies nothing, and letting
    // it through would reach a delete (and a final-snapshot identifier) built
    // from `''`. Matches `replaySingle`'s `!op.physicalId` guard on the
    // completed-CREATE path, which is what lets both share
    // `prepareCreateRollbackFinalSnapshot`.
    if (!op.physicalId) return 'skip-failed-unknown';
    if (!current) return 'skip-failed-noop'; // already cleaned up (re-run)
    if (current.physicalId !== op.physicalId) return 'skip-failed-noop';
    // The CURRENT record's DeletionPolicy governs this delete exactly as it
    // governs the COMPLETED-CREATE rollback above (issue #1362). Reaching
    // here means AWS did provision the resource (a physical id is recorded
    // AND state agrees), so it is a real resource the policy speaks about —
    // "the CREATE failed" is not a licence to ignore the user's Retain /
    // Snapshot. CloudFormation applies the policy to a failed create's
    // rollback delete too; `RetainExceptOnCreate` exists precisely to opt
    // OUT of that for `Retain`, and it keeps deleting here. Absent is
    // CloudFormation's default (issue #4030).
    const policy = effectiveDeletionPolicy(
      current.resourceType,
      current.deletionPolicy,
      current.properties
    );
    if (policy === 'Retain') return 'orphan-failed-create-retain';
    if (policy === 'Snapshot') return 'delete-failed-create-with-final-snapshot';
    return 'delete-failed-create';
  }
  // UPDATE
  if (!current || !op.previousState) return 'skip-failed-absent';
  // go-to-k/cdkd#4523: the force-revert below writes to `current.physicalId`,
  // so a record that now names ANOTHER resource (one `cdkd import` adopted
  // under this id) must not receive the failed op's pre-deploy bag — the same
  // guard the CREATE arm above applies.
  if (op.physicalId !== undefined && current.physicalId !== op.physicalId) return 'skip-failed-noop';
  // Issue #2668: a failed Type change was a REPLACEMENT in flight, and the
  // force-revert below is an in-place `update()` routed on `op.resourceType` —
  // the NEW type — against the OLD resource's physical id. There is no in-place
  // revert of a replacement; say so instead of aiming one type's update at
  // another type's resource.
  if (isTypeChangeOp(op)) return 'skip-failed-type-change';
  return 'revert-failed-update';
}

/** Build the plan items for a segment's failed ops (issue #1198). */
export function planFailedOps(
  failedOps: FailedOperation[],
  stateResources: Record<string, ResourceState>
): FailedOpPlanItem[] {
  return failedOps.map((op) => ({
    op,
    action: classifyFailedOp(op, stateResources),
    effectiveProvisionedBy: effectiveProvisionedBy(stateResources[op.logicalId], op.provisionedBy),
  }));
}

/**
 * Build the full ordered plan for a list of ops (one segment). Mirrors the
 * replay order: UPDATE/DELETE first (reverse completion order), then CREATE
 * deletions in dependency-aware order.
 */
export function planRollback(
  operations: CompletedOperation[],
  stateResources: Record<string, ResourceState>,
  orphanLogicalIds: Set<string> = new Set()
): RollbackPlanItem[] {
  const { createOps, otherOps } = partitionOps(operations);
  const ordered: CompletedOperation[] = [
    ...[...otherOps].reverse(),
    ...sortRollbackCreates(createOps, stateResources),
  ];
  return ordered.map((op) => {
    const action = classifyRollbackOp(op, stateResources, orphanLogicalIds);
    return {
      op,
      action,
      replacement: isReplacementOp(op),
      effectiveProvisionedBy: effectiveProvisionedBy(
        stateResources[op.logicalId],
        op.provisionedBy
      ),
      // Scoped to the two arms that would otherwise DELETE the new copy
      // (issue #2598) — the same record carries `updateReplacePolicy` for
      // ops this question does not apply to, and an unscoped read would
      // annotate a `revert` or a `skip-*` row with a retention that decides
      // nothing there.
      retainsNewResource:
        (action === 'reverse-replacement' || action === 'reverse-replacement-readopt') &&
        rollbackRetainsNewResource(stateResources[op.logicalId]),
    };
  });
}

export function partitionOps(operations: CompletedOperation[]): {
  createOps: CompletedOperation[];
  otherOps: CompletedOperation[];
} {
  const createOps: CompletedOperation[] = [];
  const otherOps: CompletedOperation[] = [];
  for (const op of operations) {
    if (op.changeType === 'CREATE') createOps.push(op);
    else otherOps.push(op);
  }
  return { createOps, otherOps };
}

/**
 * Sort CREATE rollback operations so that resources depending on others are
 * deleted first (reverse dependency order), using state dependencies. Same
 * algorithm as the pre-extraction `DeployEngine.sortRollbackCreates`.
 */
export function sortRollbackCreates(
  createOps: CompletedOperation[],
  stateResources: Record<string, ResourceState>,
  logger?: Logger
): CompletedOperation[] {
  const opMap = new Map<string, CompletedOperation>();
  const deleteIds = new Set<string>();
  for (const op of createOps) {
    opMap.set(op.logicalId, op);
    deleteIds.add(op.logicalId);
  }

  const dependedBy = new Map<string, Set<string>>();
  for (const id of deleteIds) {
    if (!dependedBy.has(id)) dependedBy.set(id, new Set());
  }

  for (const id of deleteIds) {
    const resource = stateResources[id];
    if (!resource?.dependencies) continue;
    for (const dep of resource.dependencies) {
      if (!deleteIds.has(dep)) continue;
      // id depends on dep → dep must be deleted AFTER id
      if (!dependedBy.has(dep)) dependedBy.set(dep, new Set());
      dependedBy.get(dep)!.add(id);
    }
  }

  const sorted: CompletedOperation[] = [];
  let remaining = new Set(deleteIds);

  while (remaining.size > 0) {
    const level: string[] = [];
    for (const id of remaining) {
      const dependents = dependedBy.get(id);
      const hasPendingDependents = dependents
        ? [...dependents].some((d) => remaining.has(d))
        : false;
      if (!hasPendingDependents) level.push(id);
    }

    if (level.length === 0) {
      logger?.warn(
        `Circular dependency detected in rollback order, processing remaining ${remaining.size} resources`
      );
      for (const id of remaining) {
        const op = opMap.get(id);
        if (op) sorted.push(op);
      }
      break;
    }

    for (const id of level) {
      const op = opMap.get(id);
      if (op) sorted.push(op);
    }
    remaining = new Set([...remaining].filter((id) => !level.includes(id)));
  }

  logger?.debug(`Rollback CREATE deletion order: ${sorted.map((op) => op.logicalId).join(' → ')}`);
  return sorted;
}
