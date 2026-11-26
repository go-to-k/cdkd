import { IMPLICIT_DELETE_DEPENDENCIES } from '../../../analyzer/implicit-delete-deps.js';
import {
  supersededDependentsFirst,
  supersededResourcesOf,
} from '../../../deployment/superseded-resources.js';
import { isCustomResourceType } from '../../../provisioning/custom-resource-secure-references.js';
import type { StackState, SupersededResourceRecord } from '../../../types/state.js';
import { hasOwnKey } from '../../../utils/own-keys.js';

/** The types that must be deleted before `type`, by an own key (a state-borne name). */
function mustDeleteBefore(type: string): readonly string[] {
  return hasOwnKey(IMPLICIT_DELETE_DEPENDENCIES, type) ? IMPLICIT_DELETE_DEPENDENCIES[type]! : [];
}

/**
 * go-to-k/cdkd#7073: when `cdkd destroy` deletes each superseded old copy,
 * relative to the stack's own resources. Slot `k` (0-based, in DELETION
 * order) runs before the `k`-th deletion level; slot `levels.length` runs
 * after every level, where every row went before #7073 (and where a row
 * naming no remaining resource still goes).
 *
 * A row goes BEFORE the first level holding a resource it must precede, the
 * way the stack's own levels order a dependent before its dependency: one its
 * record's `dependencies` name (an old security group before the VPC its
 * `VpcId` named), or one whose type must be deleted after the row's type
 * (`IMPLICIT_DELETE_DEPENDENCIES`). What those depend on sit on later levels,
 * so the transitive order holds. It never goes before a level holding a
 * resource that must precede it: its own logical id's current record (whose
 * dependents, which may still name the old id after a failed deploy, sit on
 * earlier levels) or a resource of a type that must be deleted before it. A
 * row whose bounds cross keeps the after-the-levels slot. Then a row moves no
 * later than a row it depends on (by logical id, as
 * `supersededDependentsFirst` reads it); within a slot the rows keep
 * `supersededDependentsFirst` order, so the dependent goes first.
 *
 * A custom resource's row is scheduled only when its early attempt (#6117)
 * asked for a retry (`retryLate`); the others were settled by that attempt.
 */
export function scheduleSupersededDeletes(
  state: Pick<StackState, 'resources' | 'supersededResources'>,
  executionLevels: readonly (readonly string[])[],
  retryLate: ReadonlySet<SupersededResourceRecord>
): SupersededResourceRecord[][] {
  const rows = supersededResourcesOf(state).filter(
    (row) => !isCustomResourceType(row.state.resourceType) || retryLate.has(row)
  );
  const { resources } = state;
  const last = executionLevels.length;
  // The deletion step of each stack resource: the walk runs the levels in reverse.
  const stepOf = new Map<string, number>();
  executionLevels.forEach((level, index) => {
    for (const logicalId of level) stepOf.set(logicalId, last - 1 - index);
  });
  const typeOf = (logicalId: string): string | undefined => resources[logicalId]?.resourceType;

  const slot = new Map<SupersededResourceRecord, number>();
  for (const row of rows) {
    const rowType = row.state.resourceType;
    let upper = last;
    let lower = 0;
    const deps: unknown = row.state.dependencies;
    if (Array.isArray(deps)) {
      for (const dep of deps) {
        if (typeof dep !== 'string' || dep === row.logicalId) continue;
        const step = stepOf.get(dep);
        if (step !== undefined) upper = Math.min(upper, step);
      }
    }
    const mustFollow = mustDeleteBefore(rowType);
    for (const [logicalId, step] of stepOf) {
      const type = typeOf(logicalId);
      if (type === undefined) continue;
      if (mustDeleteBefore(type).includes(rowType)) {
        upper = Math.min(upper, step);
      }
      if (mustFollow.includes(type)) lower = Math.max(lower, step + 1);
    }
    const own = stepOf.get(row.logicalId);
    if (own !== undefined) lower = Math.max(lower, own);
    slot.set(row, lower <= upper ? upper : last);
  }

  // A row is deleted no later than a row it depends on.
  for (let changed = true, rounds = 0; changed && rounds <= rows.length; rounds++) {
    changed = false;
    for (const row of rows) {
      const deps: unknown = row.state.dependencies;
      if (!Array.isArray(deps)) continue;
      for (const other of rows) {
        if (other.logicalId === row.logicalId || !deps.includes(other.logicalId)) continue;
        if (slot.get(other)! < slot.get(row)!) {
          slot.set(row, slot.get(other)!);
          changed = true;
        }
      }
    }
  }

  const slots: SupersededResourceRecord[][] = Array.from({ length: last + 1 }, () => []);
  for (const row of supersededDependentsFirst(rows)) slots[slot.get(row)!]!.push(row);
  return slots;
}
