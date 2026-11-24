import graphlib from 'graphlib';
import type { CloudFormationTemplate, TemplateResource } from '../types/resource.js';
import { TemplateParser } from './template-parser.js';
import { extractLambdaVpcDeleteDeps } from './lambda-vpc-deps.js';
import { defensiveDependsOnToSkip } from './cdk-defensive-deps.js';
import { displayIdent, safeMsg } from '../utils/display-safe.js';
import { getLogger } from '../utils/logger.js';
import { DependencyError } from '../utils/error-handler.js';
import { splitGetAttStringForm } from '../deployment/secret-redaction.js';

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
  /**
   * go-to-k/cdkd#6437: under `--update-policy`, an `AWS::Lambda::Alias` also
   * depends on what its `UpdatePolicy.CodeDeployLambdaAliasUpdate` refers to
   * (the CodeDeploy application, deployment group and hook functions), so its
   * deployment starts after they exist, as in CloudFormation. Off without the
   * flag, so a deploy's graph is unchanged.
   */
  updatePolicyReferences?: boolean;
}

/**
 * Dependency graph builder for CloudFormation resources
 *
 * Builds a directed acyclic graph (DAG) of resource dependencies
 * based on Ref, Fn::GetAtt, and DependsOn
 */
/**
 * A resource whose deploy runs user code that can reach the network: a custom
 * resource (its handler), or a nested stack (its child can hold one).
 */
function runsCodeDuringDeploy(type: string | undefined): boolean {
  return (
    type === 'AWS::CloudFormation::CustomResource' ||
    type === 'AWS::CloudFormation::Stack' ||
    (typeof type === 'string' && type.startsWith('Custom::'))
  );
}

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
      // `displayIdent` for the TYPE too, not `displaySafe`: a resource type is
      // the PLAIN_IDENT grammar that helper documents (`AWS::S3::Bucket`,
      // `Custom::my-thing_v2@x`), which is the argument this method already
      // makes for the logical id beside it. And the ABSENT case is SPELLED
      // rather than passed through: an absent type rendered as `''`, so a
      // resource without one printed `Added node: Foo ()`, which reads as an
      // empty type rather than a missing one.
      //
      // `== null`, covering `null` as well as `undefined`, because the same
      // argument this method makes about logical ids applies to the VALUE:
      // cdkd parses the template as JSON, so `"Type": null` is a shape a
      // hand-written or migrated file really carries, and it would otherwise
      // render as `<unrenderable>` rather than as the missing type it is
      // (go-to-k/cdkd#3426 review round 2).
      const typeText = resource?.Type == null ? '<no Type>' : displayIdent(resource.Type);
      this.logger.debug(`Added node: ${displayIdent(logicalId)} (${typeText})`);
    });

    this.logger.debug(`Total nodes: ${resourceIds.length}`);

    // Template Parameter names — a `Ref: <ParameterName>` is a reference to a
    // CFn Parameter, NOT to a resource, so it must not be treated as a missing
    // dependency. (Pseudo-parameters like AWS::Region are already filtered out
    // upstream by `extractDependencies`; this handles user-declared Parameters,
    // e.g. nested-stack children whose Parameters are fed by the parent.)
    const parameterNames = new Set(Object.keys(template.Parameters ?? {}));

    // Add edges for dependencies
    let edgeCount = 0;
    let relaxedEdgeCount = 0;
    let keptEdgeCount = 0;
    // go-to-k/cdkd#6940: the CDK-defensive DependsOn edges relaxation would
    // skip, decided once every other edge is in (below).
    const relaxable: Array<{ from: string; to: string }> = [];
    for (const logicalId of resourceIds) {
      const resource = this.parser.getResource(template, logicalId);
      if (!resource) {
        continue;
      }

      const dependencies = this.parser.extractDependencies(resource);
      if (this.options.updatePolicyReferences === true && resource.Type === 'AWS::Lambda::Alias') {
        const aliasPolicy = (resource.UpdatePolicy as Record<string, unknown> | undefined)?.[
          'CodeDeployLambdaAliasUpdate'
        ];
        if (aliasPolicy !== undefined) {
          for (const ref of this.parser.extractReferences(aliasPolicy)) dependencies.add(ref);
        }
      }
      // When relaxation is enabled, compute the subset of DependsOn entries
      // (NOT Ref / GetAtt — those are real data dependencies) that the CDK
      // injected defensively for runtime egress reasons. Skip them at edge
      // insertion time. See `cdk-defensive-deps.ts` for the type-pair list.
      const skip = this.options.relaxCdkVpcDefensiveDeps
        ? defensiveDependsOnToSkip(resource, template)
        : null;

      for (const depId of dependencies) {
        if (skip?.has(depId) && graph.hasNode(depId)) {
          relaxable.push({ from: depId, to: logicalId });
          continue;
        }
        // Only add edge if the dependency exists in the template
        if (graph.hasNode(depId)) {
          graph.setEdge(depId, logicalId); // depId -> logicalId (logicalId depends on depId)
          edgeCount++;
          this.logger.debug(`Added edge from ${displayIdent(depId)} to ${displayIdent(logicalId)}`);
        } else if (parameterNames.has(depId)) {
          // `Ref` to a template Parameter, not a resource — no graph edge and
          // no warning. (Common in nested-stack children whose Parameters are
          // supplied by the parent via Properties.Parameters.)
          this.logger.debug(
            `Skipped Parameter reference from ${displayIdent(logicalId)} to ${displayIdent(depId)}`
          );
        } else {
          // SANITIZED, and this line is why the whole file is
          // (go-to-k/cdkd#3426). A logical id reads like a value CloudFormation
          // validated, and it is not one: cdkd parses the template as JSON, so a
          // Resources KEY or a `DependsOn` entry is only as constrained as the
          // file — and a `DependsOn` naming something absent is exactly the case
          // that reaches a user. Measured on `node dist/cli.js`: an id carrying
          // `ESC[2K` + CR put a live terminal-rewriting sequence on this warn, at
          // DEFAULT verbosity, while the resolver's sibling message beside it was
          // already sanitized — the same "guard defeated by its own neighbour"
          // shape, one module over.
          //
          // `displayIdent` rather than `displayMasked`: this module holds no
          // secrets bag (it never sees a resolved value), and an id is an
          // IDENTIFIER, so the positive allowlist plus the quoted boundary is the
          // right rule. An ordinary id renders byte-identically.
          this.logger.warn(
            `Resource ${displayIdent(logicalId)} depends on ${displayIdent(depId)}, but ` +
              `${displayIdent(depId)} not found in template`
          );
        }
      }
    }
    // go-to-k/cdkd#6940: a relaxable edge whose dependent is upstream of code
    // that runs during the deploy — a custom resource's handler, or a nested
    // stack (whose child can hold one) — stays a real edge: that handler may
    // need the route (and the NAT gateway behind it) when it runs, and only a
    // real edge orders it without holding a --concurrency slot. Judged on the
    // graph with every candidate edge in, so an upstream reached only through
    // another candidate counts too. Every other one is relaxed as before.
    //
    // ORDER: this runs BEFORE the implicit edges added below
    // (addCustomResourcePolicyEdges, addLambdaVpcEdges, the WaitCondition
    // edges), so "upstream of a custom resource" sees only template edges.
    // That is correct only because a custom resource's handler is always a
    // Ref / Fn::GetAtt predecessor of it (its ServiceToken). Do not move this
    // block below those without re-judging what counts as upstream.
    if (relaxable.length > 0) {
      for (const { from, to } of relaxable) graph.setEdge(from, to);
      const upstreamOfCode = new Set<string>();
      for (const id of resourceIds) {
        if (!runsCodeDuringDeploy(this.parser.getResource(template, id)?.Type)) continue;
        for (const dep of this.getAllDependencies(graph, id)) upstreamOfCode.add(dep);
      }
      for (const { from, to } of relaxable) {
        if (upstreamOfCode.has(to)) {
          keptEdgeCount++;
          edgeCount++;
          this.logger.debug(
            safeMsg`Kept CDK-defensive DependsOn edge from ${from} to ${to}: ${to} is upstream of a custom resource or nested stack`
          );
          continue;
        }
        graph.removeEdge(from, to);
        relaxedEdgeCount++;
        this.logger.debug(
          `Skipped CDK-defensive DependsOn edge from ${displayIdent(from)} to ${displayIdent(to)} (default; opt out with --no-aggressive-vpc-parallel)`
        );
      }
    }
    if (relaxedEdgeCount > 0) {
      this.logger.info(
        `[DagBuilder] Relaxed ${relaxedEdgeCount} CDK-defensive DependsOn edge(s) (default; opt out with --no-aggressive-vpc-parallel)`
      );
    }
    if (keptEdgeCount > 0) {
      this.logger.debug(
        safeMsg`[DagBuilder] Kept ${keptEdgeCount} CDK-defensive DependsOn edge(s) upstream of a custom resource or nested stack`
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

    // A WaitCondition waits for the resources that signal its handle (#6704).
    edgeCount += this.addWaitConditionSignallerEdges(graph, template);

    // Validate graph is acyclic
    if (!alg.isAcyclic(graph)) {
      const cycles = this.findCycles(graph);
      throw new DependencyError(
        `Circular dependency detected in template. Cycles: ${cycles
          .map((c) => c.map((n) => displayIdent(n)).join(' then '))
          .join(', and ')}`
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
          `Circular dependency detected. Remaining nodes: ${remaining
            .map((n) => displayIdent(n))
            .join(', ')}`
        );
      }

      this.logger.debug(
        `Level ${levelNum}: ${readyNodes.length} resources - ${readyNodes
          .map((n) => displayIdent(n))
          .join(', ')}`
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
   * Add implicit edges to each `AWS::CloudFormation::WaitCondition` from every
   * other resource downstream of its `Handle` (go-to-k/cdkd#6704): the
   * instance whose user data signals the handle URL, or the Auto Scaling group
   * launching from a launch template that embeds it. This over-approximates
   * (an instance's EIP association also runs first), which only delays the
   * wait's start: a signal sent before the wait starts still counts.
   *
   * A waiting WaitCondition holds a `--concurrency` slot for up to its
   * `Timeout`. With no edge — CloudFormation needs none, having no concurrency
   * limit — a small `--concurrency` could run the wait first and starve the
   * resource that would signal it. Ordering the wait after its signallers
   * loses nothing: signals sent before the wait starts still count.
   *
   * An edge is skipped when the WaitCondition already reaches the resource
   * (that resource runs after the wait by the template's own edges), as
   * `addCustomResourcePolicyEdges` does. Templates without a WaitCondition pay
   * one type scan and nothing else.
   *
   * Returns the number of edges added.
   */
  private addWaitConditionSignallerEdges(
    graph: GraphType,
    template: CloudFormationTemplate
  ): number {
    const resourceIds = this.parser.getResourceIds(template);
    const waits: { id: string; handleId: string }[] = [];
    for (const id of resourceIds) {
      const resource = this.parser.getResource(template, id);
      if (resource?.Type !== 'AWS::CloudFormation::WaitCondition') continue;
      const handleId = this.extractLogicalIdFromReference((resource.Properties ?? {})['Handle']);
      if (handleId !== undefined) waits.push({ id, handleId });
    }
    if (waits.length === 0) return 0;

    let added = 0;
    for (const wait of waits) {
      if (!graph.hasNode(wait.handleId)) continue;
      // Every resource downstream of the handle, not only its direct readers:
      // an Auto Scaling group launching from a launch template that embeds the
      // handle is the signaller there, one hop away.
      const signallers = this.getAllDependents(graph, wait.handleId);
      const downstream = this.getAllDependents(graph, wait.id);
      for (const id of signallers) {
        if (id === wait.id) continue;
        if (graph.hasEdge(id, wait.id)) continue;
        if (downstream.has(id)) {
          this.logger.debug(
            safeMsg`Skipped implicit edge (wait condition signaller) from ${displayIdent(id)} to ${displayIdent(wait.id)}: it would close a cycle, the resource already runs after the wait`
          );
          continue;
        }
        graph.setEdge(id, wait.id);
        added++;
        this.logger.debug(
          safeMsg`Added implicit edge (wait condition signaller) from ${displayIdent(id)} to ${displayIdent(wait.id)}`
        );
      }
    }
    return added;
  }

  /**
   * Add implicit edges from IAM::Policy resources to Custom Resources whose
   * ServiceToken Lambda's execution role those policies attach to.
   *
   * An edge is skipped when the custom resource already reaches the policy in the
   * graph: the policy then runs after the resource by the template's own edges
   * (typically a `DependsOn` chain between several `AwsCustomResource`s that share
   * one handler and role, each with its own policy), and adding it would close a
   * cycle CloudFormation never sees. The resource still waits for every policy
   * that is not downstream of it, including its own.
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

      // Computed once per resource: an edge INTO the resource adds ancestors, never
      // changes what the resource reaches, so the set stays valid for the loop.
      const downstream = this.getAllDependents(graph, logicalId);

      for (const policyId of policies) {
        if (policyId === logicalId) continue;
        if (!graph.hasNode(policyId)) continue;
        if (graph.hasEdge(policyId, logicalId)) continue;
        if (downstream.has(policyId)) {
          this.logger.debug(
            safeMsg`Skipped implicit edge (custom resource policy) from ${displayIdent(policyId)} to ${displayIdent(logicalId)}: it would close a cycle, the policy already runs after the resource`
          );
          continue;
        }
        graph.setEdge(policyId, logicalId);
        added++;
        this.logger.debug(
          `Added implicit edge (custom resource policy) from ${displayIdent(policyId)} to ${displayIdent(logicalId)}`
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
      this.logger.debug(
        `Added implicit edge (lambda vpc) from ${displayIdent(depId)} to ${displayIdent(dependentId)}`
      );
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
      // The STRING spelling needs the same edge as the array one (issue #2270);
      // see `template-parser.ts`'s twin of this arm for why it was harmless
      // before that PR and a silent race after it. Same shared predicate, so
      // the graph accepts exactly the set `resolveGetAtt` resolves.
      if (typeof getAtt === 'string') {
        return splitGetAttStringForm(getAtt)?.logicalId;
      }
    }

    return undefined;
  }
}
