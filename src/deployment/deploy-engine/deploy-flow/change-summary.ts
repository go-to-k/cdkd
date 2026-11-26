import {
  shouldRetainResource,
  type ResourceChange,
  type ResourceState,
} from '../../../types/state.js';
import type { CloudFormationTemplate } from '../../../types/resource.js';
import { green, red, yellow } from '../../../utils/colors.js';

/** The deploy plan's counts (moved from `deploy-flow.ts`). */
export interface PlannedChangeCounts {
  create: number;
  update: number;
  /** The removals the deploy deletes. */
  delete: number;
  /** The removals the deploy keeps in AWS by their `DeletionPolicy`. */
  orphan: number;
}

/**
 * Count the planned changes. go-to-k/cdkd#7005: a removal whose
 * `DeletionPolicy` keeps it (`Retain` / `RetainExceptOnCreate`) is orphaned,
 * not deleted, by the same verdict `provisionDelete` (`delete.ts`) acts on:
 * the recorded policy, else the template's.
 */
export function plannedChangeCounts(
  changes: Iterable<ResourceChange>,
  records: Readonly<Record<string, ResourceState>>,
  template: CloudFormationTemplate | undefined
): PlannedChangeCounts {
  const counts: PlannedChangeCounts = { create: 0, update: 0, delete: 0, orphan: 0 };
  for (const change of changes) {
    if (change.changeType === 'CREATE') counts.create++;
    else if (change.changeType === 'UPDATE') counts.update++;
    else if (change.changeType === 'DELETE') {
      const record = Object.hasOwn(records, change.logicalId)
        ? records[change.logicalId]
        : undefined;
      const policy =
        record?.deletionPolicy ?? template?.Resources?.[change.logicalId]?.DeletionPolicy;
      if (shouldRetainResource(policy)) counts.orphan++;
      else counts.delete++;
    }
  }
  return counts;
}

/** The `Changes:` line the deploy logs before it starts. */
export function plannedChangesLine(counts: PlannedChangeCounts): string {
  return (
    `Changes: ${green(counts.create)} to create, ${yellow(counts.update)} to update, ` +
    `${red(counts.delete)} to delete` +
    (counts.orphan > 0 ? `, ${yellow(counts.orphan)} to orphan` : '')
  );
}
