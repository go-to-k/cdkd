import graphlib from 'graphlib';
import type { CloudFormationTemplate, TemplateResource } from '../types/resource.js';
import { TemplateParser } from './template-parser.js';
import { extractLambdaVpcDeleteDeps } from './lambda-vpc-deps.js';
import { defensiveDependsOnToSkip } from './cdk-defensive-deps.js';
import { getLogger } from '../utils/logger.js';
import { DependencyError } from '../utils/error-handler.js';

const { Graph, alg } = graphlib;
type GraphType = graphlib.Graph;

const IAM_ROLE_POLICY_TYPES: ReadonlySet<string> = new Set([
  'AWS::IAM::Policy',
  'AWS::IAM::RolePolicy',
  'AWS::IAM::ManagedPolicy',
]);

export interface DagBuilderOptions {
  /**
   * When true, drop the CDK-injected defensive DependsOn edges that block
   * VPC-Lambda deploys behind NAT route stabilization. Off by default — see
   * `cdk-defensive-deps.ts` for the rationale and the type-pair allowlist.
   */
  relaxCdkVpcDefensiveDeps?: boolean;
}

/**
 * Dependency graph builder for CloudFormation resources
 *
 * Builds a directed acyclic graph (DAG) of resource dependencies
 * based on Ref, Fn::GetAtt, and DependsOn
 */
export class DagBuilder {
  private logger = getLogger().child('DagBuilder');
  private parser = new TemplateParser();
  private options: DagBuilderOptions;

  constructor(options: DagBuilderOptions = {}) {
    this.options = options;
  }

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
    let relaxedEdgeCount = 0;
    for (const logicalId of resourceIds) {
      const resource = this.parser.getResource(template, logicalId);
      if (!resource) {
        continue;
      }

      const dependencies = this.parser.extractDependencies(resource);
      // When relaxation is enabled, compute the subset of DependsOn entries
      // (NOT Ref / GetAtt — those are real data dependencies) that the CDK
      // injected defensively for runtime egress reasons. Skip them at edge
      // insertion time. See `cdk-defensive-deps.ts` for the type-pair list.
      const skip = this.options.relaxCdkVpcDefensiveDeps
        ? defensiveDependsOnToSkip(resource, template)
        : null;

      for (const depId of dependencies) {
        if (skip?.has(depId)) {
          relaxedEdgeCount++;
          this.logger.debug(
            `Skipped CDK-defensive DependsOn edge: ${depId} -> ${logicalId} (default; opt out with --no-aggressive-vpc-parallel)`
          );
          continue;
        }
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
    if (relaxedEdgeCount > 0) {
      this.logger.info(
        `[DagBuilder] Relaxed ${relaxedEdgeCount} CDK-defensive DependsOn edge(s) (default; opt out with --no-aggressive-vpc-parallel)`
      );
    }

    this.logger.debug(`Dependency graph built: ${resourceIds.length} nodes, ${edgeCount} edges`);

    // Add implicit edges from IAM::Policy (and friends) attached to a Custom
    // Resource's ServiceToken Lambda's execution role.
    // WHY: CloudFormation templates only express deps via Ref/GetAtt/DependsOn.
    // A Custom Resource typically refs only the Lambda (via ServiceToken), not the
    // inline IAM::Policy that grants the Lambda its runtime permissions. Without this
    // edge the Custom Resource can run before the policy attachment API returns, so
    // the handler hits AccessDenied in the middle of deploy.
    edgeCount += this.addCustomResourcePolicyEdges(graph, template);

    // Defense-in-depth edges for AWS::Lambda::Function VpcConfig: even though
    // Refs in `Properties.VpcConfig.SubnetIds` / `SecurityGroupIds` are
    // already picked up by extractDependencies (and so will produce edges in
    // the loop above), an explicit pass guards against future regressions in
    // the recursive extractor and makes the Lambda-vs-VPC ordering visible
    // in the DAG even when those properties are wrapped in unusual shapes.
    edgeCount += this.addLambdaVpcEdges(graph, template);

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

    this.logger.debug(`Execution levels computed: ${levels.length} levels`);

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

  /**
   * Add implicit edges from IAM::Policy resources to Custom Resources whose
   * ServiceToken Lambda's execution role those policies attach to.
   *
   * Returns the number of edges added.
   */
  private addCustomResourcePolicyEdges(graph: GraphType, template: CloudFormationTemplate): number {
    const rolePolicies = this.buildRolePoliciesMap(template);
    if (rolePolicies.size === 0) {
      return 0;
    }

    let added = 0;
    for (const logicalId of this.parser.getResourceIds(template)) {
      const resource = this.parser.getResource(template, logicalId);
      if (!resource || !this.isCustomResourceType(resource.Type)) {
        continue;
      }

      const serviceToken = (resource.Properties ?? {})['ServiceToken'];
      const lambdaId = this.extractLogicalIdFromReference(serviceToken);
      if (!lambdaId) continue;

      const lambdaResource = this.parser.getResource(template, lambdaId);
      if (!lambdaResource || lambdaResource.Type !== 'AWS::Lambda::Function') {
        continue;
      }

      const roleId = this.extractLogicalIdFromReference((lambdaResource.Properties ?? {})['Role']);
      if (!roleId) continue;

      const policies = rolePolicies.get(roleId);
      if (!policies) continue;

      for (const policyId of policies) {
        if (policyId === logicalId) continue;
        if (!graph.hasNode(policyId)) continue;
        if (graph.hasEdge(policyId, logicalId)) continue;
        graph.setEdge(policyId, logicalId);
        added++;
        this.logger.debug(
          `Added implicit edge (custom resource policy): ${policyId} -> ${logicalId}`
        );
      }
    }

    if (added > 0) {
      this.logger.debug(`Added ${added} implicit edges for custom resource policies`);
    }
    return added;
  }

  /**
   * Add edges from Subnets / SecurityGroups referenced by an
   * AWS::Lambda::Function VpcConfig to the Lambda itself.
   *
   * Same direction as a normal `Ref`-derived edge (Subnet -> Lambda), so for
   * deploy this just duplicates what extractDependencies already produced.
   * The point is robustness: if a future template massages the VpcConfig
   * shape in a way the recursive extractor doesn't anticipate, this pass
   * still ties the Lambda to its networking resources so that the
   * deletion-time reverse traversal continues to delete Lambda before
   * Subnet / SecurityGroup.
   *
   * Returns the number of NEW edges added (existing edges are skipped).
   */
  private addLambdaVpcEdges(graph: GraphType, template: CloudFormationTemplate): number {
    const edges = extractLambdaVpcDeleteDeps(template.Resources);
    if (edges.length === 0) return 0;

    let added = 0;
    for (const edge of edges) {
      // edge: { before: lambdaId, after: vpcResourceId }
      // Edge convention: setEdge(depId, dependentId) means dependentId
      // depends on depId. The Lambda depends on the Subnet / SG, so
      // depId = vpcResourceId (after), dependentId = lambdaId (before).
      const depId = edge.after;
      const dependentId = edge.before;
      if (!graph.hasNode(depId) || !graph.hasNode(dependentId)) continue;
      if (graph.hasEdge(depId, dependentId)) continue;
      graph.setEdge(depId, dependentId);
      added++;
      this.logger.debug(`Added implicit edge (lambda vpc): ${depId} -> ${dependentId}`);
    }

    if (added > 0) {
      this.logger.debug(`Added ${added} implicit edges for Lambda VpcConfig`);
    }
    return added;
  }

  private isCustomResourceType(type: string): boolean {
    return type === 'AWS::CloudFormation::CustomResource' || type.startsWith('Custom::');
  }

  /**
   * Build a map of roleLogicalId -> Set<policyLogicalId> by scanning the
   * template for IAM::Policy / IAM::RolePolicy / IAM::ManagedPolicy resources
   * that attach to a role by Ref/GetAtt.
   */
  private buildRolePoliciesMap(template: CloudFormationTemplate): Map<string, Set<string>> {
    const map = new Map<string, Set<string>>();

    for (const [policyId, resource] of Object.entries(template.Resources)) {
      if (!IAM_ROLE_POLICY_TYPES.has(resource.Type)) continue;

      for (const roleId of this.extractAttachedRoleIds(resource)) {
        let set = map.get(roleId);
        if (!set) {
          set = new Set();
          map.set(roleId, set);
        }
        set.add(policyId);
      }
    }

    return map;
  }

  /**
   * Extract the logical IDs of IAM::Role resources that a policy resource
   * attaches to. Supports both `Roles: [Ref]` (IAM::Policy / IAM::ManagedPolicy)
   * and `RoleName: Ref` (IAM::RolePolicy) shapes.
   */
  private extractAttachedRoleIds(resource: TemplateResource): string[] {
    const ids: string[] = [];
    const props = resource.Properties ?? {};

    const roles = props['Roles'];
    if (Array.isArray(roles)) {
      for (const entry of roles) {
        const id = this.extractLogicalIdFromReference(entry);
        if (id) ids.push(id);
      }
    }

    const roleName = props['RoleName'];
    const roleNameId = this.extractLogicalIdFromReference(roleName);
    if (roleNameId) ids.push(roleNameId);

    return ids;
  }

  /**
   * Extract a resource logical ID from a direct Ref or Fn::GetAtt expression.
   * Returns undefined for literals or intrinsics we can't statically resolve
   * (Fn::Join, Fn::ImportValue, etc.) — callers should skip in that case.
   */
  private extractLogicalIdFromReference(value: unknown): string | undefined {
    if (typeof value !== 'object' || value === null) return undefined;
    const obj = value as Record<string, unknown>;

    if ('Ref' in obj && typeof obj['Ref'] === 'string') {
      const ref = obj['Ref'];
      return ref.startsWith('AWS::') ? undefined : ref;
    }

    if ('Fn::GetAtt' in obj) {
      const getAtt = obj['Fn::GetAtt'];
      if (Array.isArray(getAtt) && typeof getAtt[0] === 'string') {
        return getAtt[0];
      }
    }

    return undefined;
  }
}
