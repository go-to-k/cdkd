import type { ResourceState } from '../../types/state.js';
import type { Logger } from '../../types/config.js';
import { type CompletedOperation, type RollbackPlanItem } from './types.js';
import { effectiveProvisionedBy, rollbackRetainsNewResource } from './messages.js';
import { samePhysicalId } from '../replacement-name-holder/name-keys.js';
import { classifyRollbackOp, isReplacementOp } from './plan/classify.js';
import { isStandaloneInlinePolicyType } from '../inline-policy-claims.js';
import { nearestMemberDependencies, recordedDependencies } from '../deploy-engine/dependencies.js';
import { orderAfterRegeneratedSecrets } from './regenerated-secrets.js';

export {
  resolveReplacementOldType,
  unroutableReplacementError,
  isTypeChangeOp,
  isReplacementOp,
  movedIdLeftForCleanup,
  sameIdRecreated,
  sameIdReversalUndecidable,
  deepEqual,
  classifyRollbackOp,
  withPreviousPolicies,
} from './plan/classify.js';
export {
  classifyFailedOp,
  isReplacementOrphan,
  isReplacedRecord,
  failedOpOwnRecord,
  markProvenDistinctFromRecord,
  isProvenDistinctRecord,
  recordUnderIdIsNotOwn,
  replacementNeverSwapped,
  recreatesDeletedOld,
  demoteSupersededOrphans,
  isJournaledOrphan,
  planFailedOps,
  recheckMismatchedFailedCreate,
  recheckFailedPlan,
} from './plan/failed-ops.js';
export {
  markDeleteFirstBlocked,
  seedsDeleteFirstGuard,
  deleteFirstBlocker,
} from './plan/delete-first.js';

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
    ...orderAfterRegeneratedSecrets(
      orderDeleteFirstAfterDependencies([...otherOps].reverse(), stateResources, orphanLogicalIds),
      stateResources
    ),
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

/**
 * go-to-k/cdkd#5064: a reverse-replacement whose old resource comes back under
 * a DIFFERENT physical id than the new one holds (a generated name at the next
 * generation, or any other renamed replacement), re-created first and its new
 * copy deleted afterwards. The replay runs its re-create AHEAD of the ops that
 * revert to the old id, which reverse completion order puts first: reverted
 * before the old resource exists, they name one AWS does not have. A same-id
 * re-create (go-to-k/cdkd#5096), a delete-first reversal and one whose old
 * resource may survive keep their slot.
 */
export function renamedReverseReplacement(
  op: CompletedOperation,
  stateResources: Record<string, ResourceState>,
  orphanLogicalIds: Set<string>,
  /** The new copies of reversals run ahead whose deferred delete is pending: holders too. */
  pendingNewIds: ReadonlySet<string> = new Set()
): boolean {
  if (op.changeType !== 'UPDATE') return false;
  if (op.oldDeletedBeforeCreate === true || op.oldResourceMaySurvive !== undefined) return false;
  const current = Object.hasOwn(stateResources, op.logicalId)
    ? stateResources[op.logicalId]
    : undefined;
  const oldId = op.previousState?.physicalId;
  if (typeof oldId !== 'string' || typeof current?.physicalId !== 'string') return false;
  if (current.physicalId === oldId) return false;
  if (pendingNewIds.has(oldId)) return false;
  // Another record holds the old id (a name handed down a chain of renames,
  // whose holder reverts later): re-created early, it would collide with, or
  // a name-idempotent create would return, that live resource.
  const oldType = op.previousState?.resourceType ?? op.resourceType;
  for (const [logicalId, other] of Object.entries(stateResources)) {
    if (logicalId === op.logicalId || typeof other?.physicalId !== 'string') continue;
    if (
      other.physicalId === oldId ||
      (other.resourceType === oldType && samePhysicalId(oldType, other.physicalId, oldId))
    ) {
      return false;
    }
  }
  return classifyRollbackOp(op, stateResources, orphanLogicalIds) === 'reverse-replacement';
}

/**
 * go-to-k/cdkd#5064: the logical ids a step-1 op's revert may name: what its
 * old record and its current one list as dependencies. A record listing none
 * names none: the op keeps its slot, as before, rather than pull every
 * renamed reversal ahead of an order another rule chose (#4821).
 */
export function revertReferences(
  op: CompletedOperation,
  stateResources: Record<string, ResourceState>
): ReadonlySet<string> {
  const current = Object.hasOwn(stateResources, op.logicalId)
    ? stateResources[op.logicalId]
    : undefined;
  const refs = new Set<string>();
  for (const record of [op.previousState, current]) {
    if (!Array.isArray(record?.dependencies)) continue;
    for (const id of record.dependencies) if (typeof id === 'string') refs.add(id);
  }
  return refs;
}

/**
 * go-to-k/cdkd#6423: step 1 in reverse completion order, except that a
 * delete-first reversal (`oldDeletedBeforeCreate`: the forward deleted the old
 * resource and created the new one under its id) runs after the reverts of
 * the ops its old record depends on. Its re-create reads its dependencies as
 * AWS holds them then, and a dependency this deploy updated earlier (a
 * schedule's role, whose trust names the schedule's group) reverts later in
 * reverse completion order: re-created first, AWS refuses it against the
 * dependency's NEW configuration. The dependency order the forward needed is
 * the one the re-create needs.
 *
 * Each move goes to just after the last such dependency, with three limits:
 *  - a dependency the replay re-creates AHEAD of its slot anyway
 *    (`renamedReverseReplacement`, #5064) does not count: moving past its
 *    slot would run the slot that deletes its new copy while the moved op's
 *    new copy still uses it;
 *  - never past an op that depends on the moved one, nor past a standalone
 *    inline policy (#4821's writer-before-policy order): the op keeps its
 *    slot instead;
 *  - processed latest-first and repeated until nothing moves, so a chain of
 *    delete-first reversals settles (C, then B, then A); a cycle stops at the
 *    bound.
 */
export function orderDeleteFirstAfterDependencies(
  ops: readonly CompletedOperation[],
  stateResources: Record<string, ResourceState>,
  orphanLogicalIds: Set<string> = new Set()
): CompletedOperation[] {
  const out = [...ops];
  const renamed = new Set(
    ops
      .filter((op) => renamedReverseReplacement(op, stateResources, orphanLogicalIds))
      .map((op) => op.logicalId)
  );
  for (let pass = 0; pass < out.length; pass++) {
    let moved = false;
    for (const op of [...out].reverse()) {
      if (op.changeType !== 'UPDATE' || op.oldDeletedBeforeCreate !== true) continue;
      const deps = new Set(
        (Array.isArray(op.previousState?.dependencies) ? op.previousState.dependencies : []).filter(
          (id): id is string => typeof id === 'string' && id !== op.logicalId && !renamed.has(id)
        )
      );
      if (deps.size === 0) continue;
      const from = out.indexOf(op);
      let last = -1;
      out.forEach((other, at) => {
        if (other !== op && deps.has(other.logicalId)) last = at;
      });
      if (last <= from) continue;
      const between = out.slice(from + 1, last + 1);
      if (
        between.some(
          (other) =>
            isStandaloneInlinePolicyType(other.resourceType) ||
            revertReferences(other, stateResources).has(op.logicalId)
        )
      ) {
        continue;
      }
      out.splice(from, 1);
      // `last` shifted down by one with the removal: inserting there places the
      // op right after that dependency.
      out.splice(last, 0, op);
      moved = true;
    }
    if (!moved) break;
  }
  return out;
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

  // id depends on dep → dep must be deleted AFTER id. A record that is not
  // being deleted is walked through to the created ones behind it (#6244).
  const nearest = nearestMemberDependencies(deleteIds, recordedDependencies(stateResources), (d) =>
    deleteIds.has(d)
  );
  for (const [id, deps] of nearest) {
    for (const dep of deps) {
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
