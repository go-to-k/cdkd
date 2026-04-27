import { getLogger } from '../utils/logger.js';

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

  add(node: DagNode<T>): void {
    this.nodes.set(node.id, node);
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

        // Dispatch up to concurrency limit, unless cancellation requested.
        if (!cancelled()) {
          for (const node of ready) {
            if (active >= concurrency) break;
            node.state = 'running';
            active++;

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
