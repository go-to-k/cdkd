import { typesDeletedBefore } from '../../analyzer/implicit-delete-deps.js';
import type { ResourceState, SupersededResourceRecord } from '../../types/state.js';
import { safeMsg } from '../../utils/display-safe.js';
import { hasOwnKey } from '../../utils/own-keys.js';
import { supersededResourcesOf } from '../superseded-resources.js';
import type { DeployRun } from './execute/run.js';
import { retryCarriedSupersededResources } from './superseded-retry.js';
import { consumersNaming } from './consumer-held-superseded.js';

/**
 * go-to-k/cdkd#7076: the old copies an EARLIER deploy kept
 * (`supersededResources`) that use a resource this deploy removes from the
 * template, and the kept old copies using those. CloudFormation's cleanup
 * deletes old copies and removed resources in one dependency order; cdkd
 * retried the kept ones only after the removal deletes, so removing a VPC
 * while an old security group of it was kept failed the VPC's delete.
 *
 * "Uses" is what the stack's own delete order reads: the row record's
 * `dependencies` naming a removed resource, or, for a row that records no
 * dependencies, a removed resource of a type that must be deleted after the
 * row's type (`IMPLICIT_DELETE_DEPENDENCIES`).
 *
 * Left to the cleanup, as before: a row that a removed resource must precede
 * (one of a type that must be deleted before the row's type, an old group's
 * Lambda), and every taken row it uses, since deleting those first would
 * leave a user behind; a row held for consumers (go-to-k/cdkd#7017), which
 * the cleanup checks. Nothing is taken when a removed resource's record names
 * a taken row's logical id that no current record holds: that removed
 * resource may still use the old copy, and no order deletes both correctly in
 * two passes (`deleteDeferredUsersOfRemovals`' rule, go-to-k/cdkd#6977).
 * Records are read by own key: a logical id comes from a state file.
 */
export function carriedUsersOfRemovals(
  carried: readonly SupersededResourceRecord[],
  resources: Record<string, ResourceState>,
  removedIds: ReadonlySet<string>,
  /** Rows held for consumers that none names any more (go-to-k/cdkd#7204). */
  released: ReadonlySet<SupersededResourceRecord> = new Set()
): SupersededResourceRecord[] {
  if (carried.length === 0 || removedIds.size === 0) return [];
  const recordOf = (id: string): ResourceState | undefined => {
    const record: unknown = hasOwnKey(resources, id) ? resources[id] : undefined;
    return typeof record === 'object' && record !== null ? (record as ResourceState) : undefined;
  };
  const depsOf = (row: SupersededResourceRecord): string[] => {
    const deps: unknown = row.state.dependencies;
    return Array.isArray(deps)
      ? deps.filter((dep): dep is string => typeof dep === 'string' && dep !== row.logicalId)
      : [];
  };
  const removedTypes = new Set<string>();
  for (const id of removedIds) {
    const record = recordOf(id);
    if (record !== undefined) removedTypes.add(record.resourceType);
  }
  const candidates = carried.filter((row) => row.heldForConsumers !== true || released.has(row));
  const taken = new Set<SupersededResourceRecord>();
  for (const row of candidates) {
    const rowType = row.state.resourceType;
    const deps = depsOf(row);
    const byType =
      deps.length === 0 &&
      [...removedTypes].some((type) => typesDeletedBefore(type).includes(rowType));
    if (byType || deps.some((dep) => removedIds.has(dep))) taken.add(row);
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
  // A row a removed resource must precede stays for the cleanup, with every
  // taken row it uses (transitively).
  const held: SupersededResourceRecord[] = [...taken].filter((row) =>
    typesDeletedBefore(row.state.resourceType).some((type) => removedTypes.has(type))
  );
  while (held.length > 0) {
    const row = held.pop()!;
    if (!taken.delete(row)) continue;
    const uses = new Set(depsOf(row));
    for (const other of taken) if (uses.has(other.logicalId)) held.push(other);
  }
  if (taken.size === 0) return [];
  const orphanIds = new Set(
    [...taken].map((row) => row.logicalId).filter((id) => recordOf(id) === undefined)
  );
  for (const id of removedIds) {
    const deps: unknown = recordOf(id)?.dependencies;
    if (Array.isArray(deps) && deps.some((dep) => dep !== id && orphanIds.has(dep))) return [];
  }
  return carried.filter((row) => taken.has(row));
}

/**
 * Deletes {@link carriedUsersOfRemovals} before the deploy's removal deletes
 * (its creates and updates are done, so nothing left in it still needs them),
 * one attempt each, and answers the carried rows still left for the cleanup:
 * one that failed is kept, its entry as the attempt left it (a snapshot taken
 * is no longer owed, go-to-k/cdkd#6463), and sent again there. A deploy whose
 * kept rows use no removed resource makes no call.
 *
 * Not on a run whose cleanup waits (a nested child for its root,
 * go-to-k/cdkd#6398; a producer for the stacks of the run that import it,
 * go-to-k/cdkd#7012): what still uses an old copy there is outside this
 * stack, so its kept rows keep their place in that cleanup.
 *
 * go-to-k/cdkd#7204: a kept row a consumer still names stays past the
 * removal deletes, so each removed resource it uses is added to `held` (to
 * the row's logical id) and kept without its delete being sent: AWS would
 * refuse it, or the row a rolled-back consumer returns to would lose it.
 * Asked only for rows that use a removed resource: under a consumer hold, of
 * the run's consumers (for a row held for consumers, of every stack, as its
 * cleanup check reads); otherwise only for rows held for consumers, and one
 * no consumer names any more is deleted first like the others, its mark kept.
 */
export async function deleteCarriedUsersOfRemovalsFirst(
  run: Pick<DeployRun, 'engine' | 'currentState' | 'deleteChanges' | 'newResources'>,
  carried: SupersededResourceRecord[],
  held: Map<string, string> = new Map()
): Promise<SupersededResourceRecord[]> {
  const { engine, currentState, deleteChanges, newResources } = run;
  const waits = engine.options.consumerCleanupQueue !== undefined;
  if (engine.options.parentStackInfo !== undefined && !waits) return carried;
  const released = await holdRemovalsOfNamedRows(
    engine,
    currentState,
    carried,
    deleteChanges,
    newResources,
    held
  );
  if (waits) return carried;
  const taken = carriedUsersOfRemovals(carried, currentState.resources, deleteChanges, released);
  if (taken.length === 0) return carried;
  engine.logger.info(
    safeMsg`Deleting ${taken.length} old resource(s) an earlier deploy kept first: they use a resource removed from the template`
  );
  await retryCarriedSupersededResources(engine, currentState, taken, newResources, {
    keptRemedy: 'cdkd sends it again after the removed resources are deleted',
  });
  // By identity of the resource: a failed attempt may have swapped the entry.
  const key = (row: SupersededResourceRecord): string =>
    JSON.stringify([row.logicalId, row.state.resourceType, row.state.physicalId]);
  const owed = new Set(carried.map(key));
  return supersededResourcesOf(currentState).filter((row) => owed.has(key(row)));
}

/**
 * The removed ids `row` uses, as `carriedUsersOfRemovals` reads it: its
 * record's `dependencies`, or, for a record naming none, each removed resource
 * of a type that must be deleted after the row's type.
 */
function removedDepsOf(
  row: SupersededResourceRecord,
  removedIds: ReadonlySet<string>,
  resources: Record<string, ResourceState>
): string[] {
  const deps: unknown = row.state.dependencies;
  const named = Array.isArray(deps)
    ? deps.filter((dep): dep is string => typeof dep === 'string' && dep !== row.logicalId)
    : [];
  if (named.length > 0) return named.filter((dep) => removedIds.has(dep));
  return [...removedIds].filter((id) => {
    const record: unknown = hasOwnKey(resources, id) ? resources[id] : undefined;
    const type =
      typeof record === 'object' && record !== null
        ? (record as ResourceState).resourceType
        : undefined;
    return type !== undefined && typesDeletedBefore(type).includes(row.state.resourceType);
  });
}

/**
 * go-to-k/cdkd#7204: adds to `held` each removed resource a carried row a
 * consumer still names uses. Without a consumer hold, answers the rows held
 * for consumers that none names any more, so they are deleted first; the
 * mark stays, so a row whose delete fails is asked about again.
 */
async function holdRemovalsOfNamedRows(
  engine: DeployRun['engine'],
  currentState: DeployRun['currentState'],
  carried: readonly SupersededResourceRecord[],
  removedIds: ReadonlySet<string>,
  live: Record<string, ResourceState>,
  held: Map<string, string>
): Promise<Set<SupersededResourceRecord>> {
  const released = new Set<SupersededResourceRecord>();
  const waits = engine.options.consumerCleanupQueue !== undefined;
  const users = carried.filter(
    (row) =>
      (waits || row.heldForConsumers === true) &&
      removedDepsOf(row, removedIds, currentState.resources).length > 0
  );
  if (users.length === 0) return released;
  // A child deploys as `<parent>~<logicalId>`; its values reach a consumer
  // through the top-level stack's outputs.
  const producer =
    engine.options.parentStackInfo === undefined
      ? currentState.stackName
      : currentState.stackName.split('~')[0]!;
  const marked = users.filter((row) => row.heldForConsumers === true);
  const unmarked = users.filter((row) => row.heldForConsumers !== true);
  const named = new Set<SupersededResourceRecord>();
  const ask = async (
    rows: SupersededResourceRecord[],
    only: ReadonlyArray<{ stackName: string; region: string }> | undefined
  ): Promise<void> => {
    if (rows.length === 0) return;
    const holders = await consumersNaming(engine, producer, rows, live, only);
    for (const row of rows) if ((holders.get(row)?.length ?? 0) > 0) named.add(row);
  };
  await ask(marked, undefined);
  await ask(unmarked, engine.options.consumerStacks);
  for (const row of users) {
    if (named.has(row)) {
      for (const dep of removedDepsOf(row, removedIds, currentState.resources))
        if (!held.has(dep)) held.set(dep, row.logicalId);
    } else if (!waits && row.heldForConsumers === true) {
      released.add(row);
    }
  }
  // A released row another row still held for consumers uses (transitively)
  // stays for the cleanup, which deletes dependents first.
  const stays = carried.filter((row) => row.heldForConsumers === true && !released.has(row));
  while (stays.length > 0) {
    const deps: unknown = stays.pop()!.state.dependencies;
    if (!Array.isArray(deps)) continue;
    for (const row of [...released]) {
      if (!deps.includes(row.logicalId)) continue;
      released.delete(row);
      stays.push(row);
    }
  }
  return released;
}
