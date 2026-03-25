import graphlib from 'graphlib';
import type { CloudFormationTemplate } from '../types/resource.js';
import { TemplateParser } from './template-parser.js';
import { getLogger } from '../utils/logger.js';
import { DependencyError } from '../utils/error-handler.js';

const { Graph, alg } = graphlib;
type GraphType = graphlib.Graph;

/**
 * Dependency graph builder for CloudFormation resources
 *
 * Builds a directed acyclic graph (DAG) of resource dependencies
 * based on Ref, Fn::GetAtt, and DependsOn
 */
export class DagBuilder {
  private logger = getLogger().child('DagBuilder');
  private parser = new TemplateParser();

  /**
   * Build dependency graph from CloudFormation template
   *
   * Creates a directed graph where:
   * - Nodes = resource logical IDs
   * - Edges = dependencies (A -> B means B depends on A)
   */
  buildGraph(template: CloudFormationTemplate): GraphType {
    const graph = new Graph({ directed: true });

    this.logger.debug('Building dependency graph...');

    // Add all resources as nodes
    const resourceIds = this.parser.getResourceIds(template);
    resourceIds.forEach((logicalId) => {
      const resource = this.parser.getResource(template, logicalId);
      graph.setNode(logicalId, resource);
      this.logger.debug(`Added node: ${logicalId} (${resource?.Type})`);
    });

    this.logger.debug(`Total nodes: ${resourceIds.length}`);

    // Add edges for dependencies
    let edgeCount = 0;
    for (const logicalId of resourceIds) {
      const resource = this.parser.getResource(template, logicalId);
      if (!resource) {
        continue;
      }

      const dependencies = this.parser.extractDependencies(resource);

      for (const depId of dependencies) {
        // Only add edge if the dependency exists in the template
        if (graph.hasNode(depId)) {
          graph.setEdge(depId, logicalId); // depId -> logicalId (logicalId depends on depId)
          edgeCount++;
          this.logger.debug(`Added edge: ${depId} -> ${logicalId}`);
        } else {
          this.logger.warn(
            `Resource ${logicalId} depends on ${depId}, but ${depId} not found in template`
          );
        }
      }
    }

    this.logger.info(`Dependency graph built: ${resourceIds.length} nodes, ${edgeCount} edges`);

    // Validate graph is acyclic
    if (!alg.isAcyclic(graph)) {
      const cycles = this.findCycles(graph);
      throw new DependencyError(
        `Circular dependency detected in template. Cycles: ${cycles.map((c) => c.join(' -> ')).join('; ')}`
      );
    }

    return graph;
  }

  /**
   * Get execution levels via topological sort
   *
   * Returns resources grouped by execution level:
   * - Level 0: Resources with no dependencies
   * - Level 1: Resources that depend only on Level 0
   * - Level N: Resources that depend on Level 0..N-1
   *
   * Resources in the same level can be executed in parallel.
   */
  getExecutionLevels(graph: GraphType): string[][] {
    const levels: string[][] = [];
    const graphCopy = new Graph({ directed: true });

    // Copy the graph
    graph.nodes().forEach((node: string) => {
      graphCopy.setNode(node, graph.node(node));
    });
    graph.edges().forEach((edge: graphlib.Edge) => {
      graphCopy.setEdge(edge.v, edge.w);
    });

    this.logger.debug('Computing execution levels...');

    let levelNum = 0;
    while (graphCopy.nodeCount() > 0) {
      // Find nodes with no incoming edges (no dependencies)
      const readyNodes = graphCopy.nodes().filter((node) => {
        const predecessors = graphCopy.predecessors(node);
        return !predecessors || predecessors.length === 0;
      });

      if (readyNodes.length === 0) {
        // This should not happen if graph is acyclic, but check anyway
        const remaining = graphCopy.nodes();
        throw new DependencyError(
          `Circular dependency detected. Remaining nodes: ${remaining.join(', ')}`
        );
      }

      this.logger.debug(
        `Level ${levelNum}: ${readyNodes.length} resources - ${readyNodes.join(', ')}`
      );
      levels.push(readyNodes);

      // Remove these nodes from the graph
      readyNodes.forEach((node) => {
        graphCopy.removeNode(node);
      });

      levelNum++;
    }

    this.logger.info(`Execution levels computed: ${levels.length} levels`);

    return levels;
  }

  /**
   * Find all cycles in the graph
   */
  private findCycles(graph: GraphType): string[][] {
    const cycles: string[][] = [];
    const visited = new Set<string>();
    const recursionStack = new Set<string>();
    const path: string[] = [];

    const dfs = (node: string): boolean => {
      visited.add(node);
      recursionStack.add(node);
      path.push(node);

      const successors = graph.successors(node) || [];

      for (const successor of successors) {
        if (!visited.has(successor)) {
          if (dfs(successor)) {
            return true;
          }
        } else if (recursionStack.has(successor)) {
          // Found a cycle
          const cycleStart = path.indexOf(successor);
          const cycle = path.slice(cycleStart);
          cycle.push(successor);
          cycles.push(cycle);
          return true;
        }
      }

      path.pop();
      recursionStack.delete(node);
      return false;
    };

    for (const node of graph.nodes()) {
      if (!visited.has(node)) {
        dfs(node);
      }
    }

    return cycles;
  }

  /**
   * Get all dependencies for a resource (transitive)
   */
  getAllDependencies(graph: GraphType, logicalId: string): Set<string> {
    const dependencies = new Set<string>();

    const visit = (node: string) => {
      const predecessors = graph.predecessors(node) || [];
      predecessors.forEach((pred: string) => {
        if (!dependencies.has(pred)) {
          dependencies.add(pred);
          visit(pred); // Recursively visit dependencies
        }
      });
    };

    visit(logicalId);
    return dependencies;
  }

  /**
   * Get all dependents for a resource (transitive)
   */
  getAllDependents(graph: GraphType, logicalId: string): Set<string> {
    const dependents = new Set<string>();

    const visit = (node: string) => {
      const successors = graph.successors(node) || [];
      successors.forEach((succ: string) => {
        if (!dependents.has(succ)) {
          dependents.add(succ);
          visit(succ); // Recursively visit dependents
        }
      });
    };

    visit(logicalId);
    return dependents;
  }

  /**
   * Get direct dependencies for a resource
   */
  getDirectDependencies(graph: GraphType, logicalId: string): string[] {
    return graph.predecessors(logicalId) || [];
  }

  /**
   * Get direct dependents for a resource
   */
  getDirectDependents(graph: GraphType, logicalId: string): string[] {
    return graph.successors(logicalId) || [];
  }

  /**
   * Check if resource A depends on resource B
   */
  dependsOn(graph: GraphType, resourceA: string, resourceB: string): boolean {
    const deps = this.getAllDependencies(graph, resourceA);
    return deps.has(resourceB);
  }
}
