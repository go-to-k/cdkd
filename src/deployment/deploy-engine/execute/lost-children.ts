import {
  noChangeChildrenOfRecreatedParents,
  survivesParent,
} from '../../child-of-recreated-parent.js';
import { type ResourceChange } from '../../../types/state.js';
import { safeMsg } from '../../../utils/display-safe.js';
import { DagExecutor } from '../../dag-executor.js';
import { nearestMemberDependencies } from '../dependencies.js';
import type { DeployRun } from './run.js';

// go-to-k/cdkd#4444: a resource re-created under the same id by the
// update-failure fallback (`ResourceUpdateNotSupportedError` -> delete,
// create) took what AWS stored inside it along, but the diff never
// promoted its readers -- the parent was an in-place UPDATE row -- so
// such a child is a `NO_CHANGE` row no executor holds. Each is turned
// into an UPDATE the engine re-creates (or re-puts) through the same
// lost-child arm, and added to the RUNNING executor as soon as its
// parent completes, so it is restored in DAG order right after the
// parent, as the replacement arm's children are, rather than after
// every other node (a later sibling's failure would then have left it
// missing). A pending node that reads it now waits for it; one already
// dispatched resolved its old id (harmless while the re-created child
// keeps its id: the name-addressed children the fallback reaches today,
// a log group's streams and filters).
export function enqueueLostChildren(run: DeployRun, executor: DagExecutor<ResourceChange>): void {
  const { engine, changes, deleteChanges, template, newResources, conditions, progress, dag } = run;
  const lostIds = noChangeChildrenOfRecreatedParents({
    changes,
    skip: deleteChanges,
    templateResources: template.Resources ?? {},
    recreatedUnderSameId: engine.replacementRun.recreatedUnderSameId,
    recordedTypeOf: (id) =>
      Object.hasOwn(newResources, id) ? newResources[id]?.resourceType : undefined,
    conditions,
  });
  for (const id of lostIds) {
    const change = changes.get(id)!;
    change.changeType = 'UPDATE';
    change.propertyChanges = [];
    engine.logger.info(
      survivesParent(change.resourceType)
        ? safeMsg`  ${id} was attached to a resource the update-failure fallback re-created under the same name: attaching it again`
        : safeMsg`  ${id} went with a resource the update-failure fallback re-created under the same id: re-creating it`
    );
  }
  if (progress) progress.total += lostIds.length;
  // A NO_CHANGE dep is walked through to the executor's nodes behind it
  // (#6244), for a lost child's own deps and for a pending reader of one.
  const lost = new Set(lostIds);
  const isMember = (id: string): boolean => executor.has(id) || lost.has(id);
  const dependenciesOf = (id: string): string[] => engine.dagBuilder.getDirectDependencies(dag, id);
  const lostDeps = nearestMemberDependencies(lostIds, dependenciesOf, isMember);
  for (const id of lostIds) {
    executor.add({
      id,
      dependencies: lostDeps.get(id)!,
      state: 'pending',
      data: changes.get(id)!,
    });
  }
  const pending = [...executor.values()].filter(
    (node) => node.state === 'pending' && !lost.has(node.id)
  );
  const pendingDeps = nearestMemberDependencies(
    pending.map((node) => node.id),
    dependenciesOf,
    isMember
  );
  for (const node of pending) {
    for (const dep of pendingDeps.get(node.id)!) {
      if (lost.has(dep)) node.dependencies.add(dep);
    }
  }
}
