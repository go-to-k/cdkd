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
 * earlier levels), a record whose `dependencies` name that logical id, or a
 * resource of a type that must be deleted before it. A row whose bounds cross
 * keeps the after-the-levels slot. Then a row moves no later than a row it
 * depends on (by logical id, as `supersededDependentsFirst` reads it), never
 * past its own lower bound; within a slot the rows keep
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
  // No row, no work: an ordinary destroy pays nothing for this.
  if (rows.length === 0) return [];
  const { resources } = state;
  const last = executionLevels.length;
  // The deletion step of each stack resource: the walk runs the levels in reverse.
  const stepOf = new Map<string, number>();
  executionLevels.forEach((level, index) => {
    for (const logicalId of level) stepOf.set(logicalId, last - 1 - index);
  });

  const slot = new Map<SupersededResourceRecord, number>();
  const lowerOf = new Map<SupersededResourceRecord, number>();
  // Rows held after the walk (bounds crossed): they never move earlier.
  const atEnd = new Set<SupersededResourceRecord>();
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
      const record = resources[logicalId];
      if (record === undefined) continue;
      if (mustDeleteBefore(record.resourceType).includes(rowType)) {
        upper = Math.min(upper, step);
      }
      if (mustFollow.includes(record.resourceType)) lower = Math.max(lower, step + 1);
      // A record naming the row's logical id may still use the old copy.
      const its: unknown = record.dependencies;
      if (Array.isArray(its) && its.includes(row.logicalId)) lower = Math.max(lower, step + 1);
    }
    const own = stepOf.get(row.logicalId);
    if (own !== undefined) lower = Math.max(lower, own);
    lowerOf.set(row, lower);
    slot.set(row, lower <= upper ? upper : last);
    if (lower > upper) atEnd.add(row);
  }

  // A row is deleted no later than a row it depends on. Moving it earlier
  // never passes its own lower bound: where it would, both rows go after the
  // walk, as crossed bounds do, and so does every row a held row depends on.
  // Terminates: `atEnd` only grows, and any other slot only decreases.
  let changed = true;
  const holdAtEnd = (row: SupersededResourceRecord): void => {
    if (atEnd.has(row)) return;
    atEnd.add(row);
    slot.set(row, last);
    changed = true;
  };
  while (changed) {
    changed = false;
    for (const row of rows) {
      const deps: unknown = row.state.dependencies;
      if (!Array.isArray(deps)) continue;
      for (const other of rows) {
        if (other.logicalId === row.logicalId || !deps.includes(other.logicalId)) continue;
        if (atEnd.has(row)) {
          holdAtEnd(other);
          continue;
        }
        const target = slot.get(other)!;
        if (target >= slot.get(row)!) continue;
        if (target >= lowerOf.get(row)!) {
          slot.set(row, target);
          changed = true;
        } else {
          holdAtEnd(row);
          holdAtEnd(other);
        }
      }
    }
  }

  const slots: SupersededResourceRecord[][] = Array.from({ length: last + 1 }, () => []);
  for (const row of supersededDependentsFirst(rows)) slots[slot.get(row)!]!.push(row);
  return slots;
}
