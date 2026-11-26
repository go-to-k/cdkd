import { typesDeletedBefore } from '../../analyzer/implicit-delete-deps.js';
import type { ResourceState, SupersededResourceRecord } from '../../types/state.js';
import { safeMsg } from '../../utils/display-safe.js';
import { supersededResourcesOf } from '../superseded-resources.js';
import type { DeployRun } from './execute/run.js';
import { retryCarriedSupersededResources } from './superseded-retry.js';

/**
 * go-to-k/cdkd#7076: the old copies an EARLIER deploy kept
 * (`supersededResources`) that use a resource this deploy removes from the
 * template, and the kept old copies using those. CloudFormation's cleanup
 * deletes old copies and removed resources in one dependency order; cdkd
 * retried the kept ones only after the removal deletes, so removing a VPC
 * while an old security group of it was kept failed the VPC's delete.
 *
 * "Uses" is what the stack's own delete order reads: the row record's
 * `dependencies` naming a removed resource, or a removed resource of a type
 * that must be deleted after the row's type (`IMPLICIT_DELETE_DEPENDENCIES`).
 *
 * Nothing is taken when a removed resource's record names a taken row's
 * logical id that no current record holds: that removed resource may still
 * use the old copy, and no order deletes both correctly in two passes
 * (`deleteDeferredUsersOfRemovals`' rule, go-to-k/cdkd#6977). A row held for
 * consumers (go-to-k/cdkd#7017) is left to the cleanup, which checks them.
 */
export function carriedUsersOfRemovals(
  carried: readonly SupersededResourceRecord[],
  resources: Record<string, ResourceState>,
  removedIds: ReadonlySet<string>
): SupersededResourceRecord[] {
  if (carried.length === 0 || removedIds.size === 0) return [];
  const depsOf = (row: SupersededResourceRecord): string[] => {
    const deps: unknown = row.state.dependencies;
    return Array.isArray(deps)
      ? deps.filter((dep): dep is string => typeof dep === 'string' && dep !== row.logicalId)
      : [];
  };
  const removedTypes = new Set<string>();
  for (const id of removedIds) {
    const record = resources[id];
    if (typeof record === 'object' && record !== null) removedTypes.add(record.resourceType);
  }
  const candidates = carried.filter((row) => row.heldForConsumers !== true);
  const taken = new Set<SupersededResourceRecord>();
  for (const row of candidates) {
    const rowType = row.state.resourceType;
    const byType = [...removedTypes].some((type) => typesDeletedBefore(type).includes(rowType));
    if (byType || depsOf(row).some((dep) => removedIds.has(dep))) taken.add(row);
  }
  if (taken.size === 0) return [];
  // The kept old copies using a taken one go with it, dependents first.
  for (let grew = true; grew;) {
    grew = false;
    const takenIds = new Set([...taken].map((row) => row.logicalId));
    for (const row of candidates) {
      if (taken.has(row) || !depsOf(row).some((dep) => takenIds.has(dep))) continue;
      taken.add(row);
      grew = true;
    }
  }
  const orphanIds = new Set(
    [...taken].map((row) => row.logicalId).filter((id) => resources[id] === undefined)
  );
  for (const id of removedIds) {
    const deps: unknown = resources[id]?.dependencies;
    if (Array.isArray(deps) && deps.some((dep) => dep !== id && orphanIds.has(dep))) return [];
  }
  return carried.filter((row) => taken.has(row));
}

/**
 * Deletes {@link carriedUsersOfRemovals} before the deploy's removal deletes
 * (its creates and updates are done, so nothing left in it still needs them),
 * one attempt each, and answers the carried rows still left for the cleanup:
 * one that failed is kept, with its warning, and sent again there. A deploy
 * whose kept rows use no removed resource makes no call.
 */
export async function deleteCarriedUsersOfRemovalsFirst(
  run: Pick<DeployRun, 'engine' | 'currentState' | 'deleteChanges' | 'newResources'>,
  carried: SupersededResourceRecord[]
): Promise<SupersededResourceRecord[]> {
  const { engine, currentState, deleteChanges, newResources } = run;
  const taken = carriedUsersOfRemovals(carried, currentState.resources, deleteChanges);
  if (taken.length === 0) return carried;
  engine.logger.info(
    safeMsg`Deleting ${taken.length} old resource(s) an earlier deploy kept first: they use a resource removed from the template`
  );
  await retryCarriedSupersededResources(engine, currentState, taken, newResources);
  const left = new Set(supersededResourcesOf(currentState));
  return carried.filter((row) => left.has(row));
}
