import type { DagBuilder } from '../../../analyzer/dag-builder.js';
import { DagExecutor } from '../../../deployment/dag-executor.js';
import type { SupersededResourceRecord } from '../../../types/state.js';

/**
 * go-to-k/cdkd#7208: the floor of the destroy's delete concurrency, deploy's
 * `--concurrency` default (measured in go-to-k/cdkd#5242). The bound is the
 * larger of this and the widest deletion level, so no destroy starts fewer
 * deletes at once than the level walk it replaced sent in one `Promise.all`.
 */
export const DESTROY_DELETE_CONCURRENCY_FLOOR = 20;

/** The destroy's delete concurrency for a stack with these deletion levels. */
export function destroyDeleteConcurrency(executionLevels: readonly (readonly string[])[]): number {
  let widest = 0;
  for (const level of executionLevels) widest = Math.max(widest, level.length);
  return Math.max(DESTROY_DELETE_CONCURRENCY_FLOOR, widest);
}

type DeleteNode =
  | { kind: 'resource'; logicalId: string }
  | { kind: 'superseded'; entry: SupersededResourceRecord };

/**
 * Run a destroy's deletes event-driven (go-to-k/cdkd#7208): a resource is
 * deleted as soon as every resource that must go before it has settled, not
 * when its whole deletion level has. The order is `graph`'s, every edge
 * source included (recorded dependencies, type pairs, per-resource edges).
 *
 * A superseded slot `k` of `scheduleSupersededDeletes` keeps its place
 * exactly: its rows run one after another, after every resource of a
 * deletion step before `k`, and before every resource of step `k` (and so,
 * through their edges, before every later step). The rows of the last slot
 * are left to the caller, which runs them after this resolves.
 *
 * A delete that fails or is skipped reports through its own counters and
 * resolves, so what depends on it still runs (go-to-k/cdkd#5670 keeps what it
 * must). One that THROWS ends the destroy as the level walk's `Promise.all`
 * did, after the deletes in flight settle. Once `interrupted()` answers true
 * no new delete starts; the ones in flight finish and this resolves.
 */
export async function runDeletesInDependencyOrder(args: {
  dagBuilder: DagBuilder;
  graph: ReturnType<DagBuilder['buildGraph']>;
  executionLevels: readonly (readonly string[])[];
  supersededSlots: readonly (readonly SupersededResourceRecord[])[];
  deleteResource: (logicalId: string) => Promise<void>;
  deleteSupersededRow: (entry: SupersededResourceRecord) => Promise<void>;
  interrupted: () => boolean;
}): Promise<void> {
  const { dagBuilder, graph, executionLevels, supersededSlots } = args;
  const last = executionLevels.length;
  const executor = new DagExecutor<DeleteNode>();

  const resourcesByStep: string[][] = [];
  executionLevels.forEach((level, index) => {
    resourcesByStep[last - 1 - index] = [...level];
  });
  const deps = new Map<string, Set<string>>();
  for (const level of executionLevels) {
    for (const logicalId of level) {
      // What depends on a resource is deleted before it.
      deps.set(logicalId, new Set(dagBuilder.getDirectDependents(graph, logicalId)));
    }
  }

  // A superseded row's node id must never equal a logical id.
  let rowCount = 0;
  const rowId = (): string => {
    let id: string;
    do id = `\u0000superseded#${rowCount++}`;
    while (deps.has(id));
    return id;
  };
  const earlier: string[] = [];
  for (let step = 0; step < last; step++) {
    let previous: string | undefined;
    for (const entry of supersededSlots[step] ?? []) {
      const id = rowId();
      executor.add({
        id,
        dependencies: new Set(previous !== undefined ? [previous] : earlier),
        state: 'pending',
        data: { kind: 'superseded', entry },
      });
      previous = id;
    }
    const level = resourcesByStep[step] ?? [];
    if (previous !== undefined) {
      for (const logicalId of level) deps.get(logicalId)!.add(previous);
    }
    earlier.push(...level);
  }
  for (const [logicalId, dependencies] of deps) {
    executor.add({
      id: logicalId,
      dependencies,
      state: 'pending',
      data: { kind: 'resource', logicalId },
    });
  }

  await executor.execute(
    destroyDeleteConcurrency(executionLevels),
    (node) =>
      node.data.kind === 'resource'
        ? args.deleteResource(node.data.logicalId)
        : args.deleteSupersededRow(node.data.entry),
    args.interrupted
  );
}
