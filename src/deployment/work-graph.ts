import { getLogger } from '../utils/logger.js';

/**
 * Node types in the work graph
 */
export type WorkNodeType = 'asset-build' | 'asset-publish' | 'stack';

/**
 * Node states
 */
export type NodeState = 'pending' | 'queued' | 'running' | 'completed' | 'failed' | 'skipped';

/**
 * A node in the work graph
 */
export interface WorkNode {
  id: string;
  type: WorkNodeType;
  dependencies: Set<string>;
  state: NodeState;
  /** Custom data attached to this node */
  data: unknown;
}

/**
 * Concurrency limits per node type
 */
export interface WorkGraphConcurrency {
  'asset-build': number;
  'asset-publish': number;
  stack: number;
}

/**
 * Work graph for orchestrating asset building, publishing and stack deployments.
 *
 * Manages a DAG of nodes with dependencies, executing them in parallel
 * with per-type concurrency limits. Nodes become ready when all their
 * dependencies are completed.
 *
 * Node types:
 * - asset-build: Docker image build (CPU/memory bound)
 * - asset-publish: S3 upload or ECR push (I/O bound)
 * - stack: Stack deployment (depends on its asset nodes)
 *
 * Dependencies:
 * - File assets: asset-publish → stack
 * - Docker assets: asset-build → asset-publish → stack
 * - Inter-stack: stack → stack (CDK dependency order)
 */
export class WorkGraph {
  private nodes = new Map<string, WorkNode>();
  private logger = getLogger().child('WorkGraph');

  addNode(node: WorkNode): void {
    this.nodes.set(node.id, node);
  }

  /**
   * Execute all nodes in the graph with bounded concurrency per type.
   */
  async execute(
    concurrency: WorkGraphConcurrency,
    fn: (node: WorkNode) => Promise<void>
  ): Promise<void> {
    const active: Record<WorkNodeType, number> = { 'asset-build': 0, 'asset-publish': 0, stack: 0 };
    const errors: Array<{ nodeId: string; error: unknown }> = [];

    return new Promise<void>((resolve, reject) => {
      const dispatch = (): void => {
        // Find ready nodes: pending with all dependencies completed
        const ready: WorkNode[] = [];
        for (const node of this.nodes.values()) {
          if (node.state !== 'pending') continue;
          const depsReady = [...node.dependencies].every((depId) => {
            const dep = this.nodes.get(depId);
            return dep && dep.state === 'completed';
          });
          if (depsReady) {
            ready.push(node);
          }
        }

        // Skip nodes with failed dependencies
        for (const node of this.nodes.values()) {
          if (node.state !== 'pending') continue;
          const hasFailedDep = [...node.dependencies].some((depId) => {
            const dep = this.nodes.get(depId);
            return dep && (dep.state === 'failed' || dep.state === 'skipped');
          });
          if (hasFailedDep) {
            node.state = 'skipped';
            this.logger.debug(`Skipped ${node.id}: dependency failed`);
          }
        }

        // Start eligible nodes
        for (const node of ready) {
          if (active[node.type] >= concurrency[node.type]) continue;

          node.state = 'running';
          active[node.type]++;

          fn(node)
            .then(() => {
              node.state = 'completed';
            })
            .catch((error) => {
              node.state = 'failed';
              errors.push({ nodeId: node.id, error });
              this.logger.error(
                `Failed: ${node.id}: ${error instanceof Error ? error.message : String(error)}`
              );
            })
            .finally(() => {
              active[node.type]--;
              dispatch(); // Re-evaluate after each completion
            });
        }

        // Check termination
        const totalActive = active['asset-build'] + active['asset-publish'] + active['stack'];
        if (totalActive === 0) {
          const pending = [...this.nodes.values()].filter(
            (n) => n.state === 'pending' || n.state === 'queued'
          );

          if (pending.length > 0) {
            reject(
              new Error(
                `Deadlock detected: ${pending.length} node(s) stuck with unresolvable dependencies`
              )
            );
            return;
          }

          if (errors.length > 0) {
            const skippedCount = [...this.nodes.values()].filter(
              (n) => n.state === 'skipped'
            ).length;
            const msg = errors
              .map(
                (e) =>
                  `  - ${e.nodeId}: ${e.error instanceof Error ? e.error.message : String(e.error)}`
              )
              .join('\n');
            reject(
              new Error(
                `${errors.length} node(s) failed${skippedCount > 0 ? `, ${skippedCount} skipped` : ''}:\n${msg}`
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

  /**
   * Get summary of node counts by type
   */
  summary(): Record<WorkNodeType, number> {
    const counts: Record<WorkNodeType, number> = { 'asset-build': 0, 'asset-publish': 0, stack: 0 };
    for (const node of this.nodes.values()) {
      counts[node.type]++;
    }
    return counts;
  }
}
