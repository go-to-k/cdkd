import { getLogger } from '../utils/logger.js';
import { phaseTimingsEnabled, recordPhase } from '../utils/phase-timings.js';

export type DagNodeState = 'pending' | 'running' | 'completed' | 'failed' | 'skipped';

export interface DagNode<T = unknown> {
  id: string;
  dependencies: Set<string>;
  state: DagNodeState;
  data: T;
}

/**
 * Event-driven DAG executor with bounded concurrency.
 *
 * Dispatches a node as soon as ALL of its dependencies are completed —
 * unlike level-synchronized execution, downstream work does not wait for
 * unrelated siblings in the same "level" to finish.
 *
 * Failure handling:
 * - A failed node marks its transitive downstream as 'skipped' (not started)
 * - In-flight nodes drain naturally; no new dispatch after first failure
 *   (cancelled() can be set to halt dispatch — used for SIGINT)
 * - On drain, rejects with the FIRST failure (matches prior behavior)
 *
 * Cancellation:
 * - When cancelled() returns true, no new nodes are started.
 *   In-flight nodes complete normally. After drain, resolves cleanly
 *   if no errors — caller is responsible for translating cancellation
 *   into a thrown error (e.g., InterruptedError on SIGINT).
 *
 * Dependencies pointing to nodes outside the registered set are treated
 * as already-completed (e.g., NO_CHANGE resources excluded from the DAG).
 */
export class DagExecutor<T = unknown> {
  private nodes = new Map<string, DagNode<T>>();
  private logger = getLogger().child('DagExecutor');

  /**
   * Per-node scheduling priority = number of transitive dependents (how many
   * other registered nodes ultimately wait on this one). Computed once, lazily,
   * on the first dispatch and cached for the run.
   *
   * The ready set is ordered by this priority (descending) so bottleneck-feeding
   * resources on the critical path start as early as their deps allow, instead
   * of in template logical-id (node insertion) order.
   *
   * Motivation: a zero-dependency `AWS::EC2::EIP` was starting 28th of 43 in a
   * VPC deploy because it sorts late by logical id, which pushed its dependent
   * NAT Gateway (a ~2 min AWS-side create) to the tail of the run. Front-loading
   * by transitive-dependent count starts the EIP -> NAT chain immediately so the
   * long NAT wait overlaps the rest of the stack — the effect CloudFormation's
   * parallel walk already achieves. Ties keep insertion order (stable sort).
   */
  private priorityById: Map<string, number> | null = null;

  /**
   * go-to-k/cdkd#5209: the `CDKD_PHASE_TIMINGS` scope a run's slot waits are
   * reported under — how long each node sat READY (every dependency done)
   * before a `concurrency` slot freed. Unset, nothing is recorded.
   */
  private readonly timingScope: string | undefined;

  constructor(timingScope?: string) {
    this.timingScope = timingScope;
  }

  add(node: DagNode<T>): void {
    this.nodes.set(node.id, node);
  }

  /**
   * Compute the transitive-dependent count for every node, once. A node's
   * dependents are the registered nodes that list it in their `dependencies`;
   * the transitive count is the size of the union of its direct dependents and
   * all of theirs. Memoized per node; a cycle guard keeps a malformed graph
   * from recursing forever (the executor itself rejects on deadlock later).
   */
  private computePriorities(): Map<string, number> {
    if (this.priorityById) return this.priorityById;

    // Reverse adjacency: dependentsOf[dep] = nodes that depend on `dep`.
    const dependentsOf = new Map<string, Set<string>>();
    for (const node of this.nodes.values()) {
      for (const depId of node.dependencies) {
        if (!this.nodes.has(depId)) continue; // external-to-DAG dep
        let set = dependentsOf.get(depId);
        if (!set) {
          set = new Set<string>();
          dependentsOf.set(depId, set);
        }
        set.add(node.id);
      }
    }

    const memo = new Map<string, Set<string>>();
    const visiting = new Set<string>();
    const collect = (id: string): Set<string> => {
      const cached = memo.get(id);
      if (cached) return cached;
      const acc = new Set<string>();
      if (visiting.has(id)) return acc; // cycle guard
      visiting.add(id);
      for (const dependent of dependentsOf.get(id) ?? []) {
        acc.add(dependent);
        for (const t of collect(dependent)) acc.add(t);
      }
      visiting.delete(id);
      memo.set(id, acc);
      return acc;
    };

    const priorities = new Map<string, number>();
    for (const id of this.nodes.keys()) priorities.set(id, collect(id).size);
    this.priorityById = priorities;
    return priorities;
  }

  has(id: string): boolean {
    return this.nodes.has(id);
  }

  size(): number {
    return this.nodes.size;
  }

  values(): IterableIterator<DagNode<T>> {
    return this.nodes.values();
  }

  async execute(
    concurrency: number,
    fn: (node: DagNode<T>) => Promise<void>,
    cancelled: () => boolean = () => false
  ): Promise<void> {
    let active = 0;
    const errors: Array<{ id: string; error: unknown }> = [];
    const priority = this.computePriorities();
    const timingScope = phaseTimingsEnabled() ? this.timingScope : undefined;
    // When each pending node was first seen ready (timing only).
    const readySince = new Map<string, number>();

    return new Promise<void>((resolve, reject) => {
      const dispatch = (): void => {
        // Mark nodes whose dependencies failed/skipped as skipped — to a
        // fixed point, so transitive dependents propagate within a single
        // dispatch (e.g., A→B→C where A failed must mark BOTH B and C as
        // skipped, regardless of node insertion order).
        let changed = true;
        while (changed) {
          changed = false;
          for (const node of this.nodes.values()) {
            if (node.state !== 'pending') continue;
            const hasFailedDep = [...node.dependencies].some((depId) => {
              const dep = this.nodes.get(depId);
              return dep && (dep.state === 'failed' || dep.state === 'skipped');
            });
            if (hasFailedDep) {
              node.state = 'skipped';
              changed = true;
              this.logger.debug(`Skipped ${node.id}: dependency failed or was skipped`);
            }
          }
        }

        // Find ready nodes (deps completed or external-to-DAG).
        const ready: DagNode<T>[] = [];
        for (const node of this.nodes.values()) {
          if (node.state !== 'pending') continue;
          const depsReady = [...node.dependencies].every((depId) => {
            const dep = this.nodes.get(depId);
            return !dep || dep.state === 'completed';
          });
          if (depsReady) ready.push(node);
        }

        // Order the ready set longest-pole-first: a node blocking more
        // transitive dependents starts before a leaf. Array.sort is stable, so
        // nodes of equal priority keep their insertion (template) order.
        ready.sort((a, b) => (priority.get(b.id) ?? 0) - (priority.get(a.id) ?? 0));
        if (timingScope !== undefined) {
          const now = performance.now();
          for (const node of ready) if (!readySince.has(node.id)) readySince.set(node.id, now);
        }

        // Dispatch up to concurrency limit, unless cancellation requested.
        if (!cancelled()) {
          for (const node of ready) {
            if (active >= concurrency) break;
            node.state = 'running';
            active++;
            if (timingScope !== undefined) {
              recordPhase(
                timingScope,
                'ready, waiting for a --concurrency slot',
                performance.now() - (readySince.get(node.id) ?? performance.now()),
                node.id
              );
            }

            fn(node)
              .then(() => {
                node.state = 'completed';
              })
              .catch((error) => {
                node.state = 'failed';
                errors.push({ id: node.id, error });
              })
              .finally(() => {
                active--;
                dispatch();
              });
          }
        }

        if (active === 0) {
          // Drain-before-reject guarantee: we only reach this point after every
          // in-flight node has settled (success OR failure), because each fn()
          // promise's .finally() decrements `active` and re-runs dispatch. So
          // when a node fails early, sibling nodes already running are allowed
          // to complete normally — their successful completion is visible to
          // the caller (e.g., for state-save and rollback bookkeeping) BEFORE
          // execute() rejects. Don't change to "reject as soon as errors[] is
          // non-empty" without revisiting the deploy-engine catch path.
          if (errors.length > 0) {
            reject(errors[0]!.error);
            return;
          }
          const stillPending = [...this.nodes.values()].some((n) => n.state === 'pending');
          if (stillPending && !cancelled()) {
            const pending = [...this.nodes.values()]
              .filter((n) => n.state === 'pending')
              .map((n) => n.id);
            reject(
              new Error(
                `Deadlock detected: ${pending.length} node(s) stuck with unresolvable dependencies (${pending.join(', ')})`
              )
            );
            return;
          }
          resolve();
        }
      };

      dispatch();
    });
  }
}
