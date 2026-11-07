import {
  noChangeChildrenOfRecreatedParents,
  survivesParent,
} from '../../child-of-recreated-parent.js';
import { type ResourceChange } from '../../../types/state.js';
import { safeMsg } from '../../../utils/display-safe.js';
import { DagExecutor } from '../../dag-executor.js';
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
  for (const id of lostIds) {
    executor.add({
      id,
      dependencies: new Set(
        engine.dagBuilder.getDirectDependencies(dag, id).filter((d) => executor.has(d))
      ),
      state: 'pending',
      data: changes.get(id)!,
    });
  }
  for (const node of executor.values()) {
    if (node.state !== 'pending') continue;
    for (const dep of engine.dagBuilder.getDirectDependencies(dag, node.id)) {
      if (lostIds.includes(dep)) node.dependencies.add(dep);
    }
  }
}
