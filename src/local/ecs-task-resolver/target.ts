import { EcsTaskResolutionError } from 'cdk-local/internal';
import { buildCdkPathIndex, resolveCdkPathToLogicalIds } from '../../cli/cdk-path.js';
import {
  describeStack,
  renderAmbiguousTargetStack,
  selectTargetStack,
} from '../../cli/stack-matcher.js';
import type { StackInfo } from '../../synthesis/assembly-reader.js';
import type { TemplateResource } from '../../types/resource.js';
import { parseContainerDefinition, buildSubstitutionContextFromImageContext } from './container.js';
import { pickString } from './pick.js';
import { resolveRoleArn } from './role-arn.js';
import type { ResolvedEcsTask, EcsImageResolutionContext, ParsedEcsTarget } from './types.js';
import { parseVolume } from './volume.js';

export function parseEcsTarget(target: string): ParsedEcsTarget {
  if (typeof target !== 'string' || target.length === 0) {
    throw new EcsTaskResolutionError(
      "Empty target. Pass a CDK display path (e.g. 'MyStack/MyService/TaskDef') or stack-qualified logical ID (e.g. 'MyStack:MyServiceTaskDefXYZ1234')."
    );
  }
  const colonIdx = target.indexOf(':');
  const slashIdx = target.indexOf('/');
  if (colonIdx > 0 && (slashIdx === -1 || colonIdx < slashIdx)) {
    const stackPattern = target.substring(0, colonIdx);
    const pathOrId = target.substring(colonIdx + 1);
    if (pathOrId.length === 0) {
      throw new EcsTaskResolutionError(`Target '${target}' has no logical ID after ':'.`);
    }
    return { stackPattern, pathOrId, isPath: pathOrId.includes('/') };
  }
  if (slashIdx > 0) {
    return { stackPattern: target.substring(0, slashIdx), pathOrId: target, isPath: true };
  }
  return { stackPattern: null, pathOrId: target, isPath: false };
}

/**
 * Resolve a parsed target against the synthesized stacks. Throws
 * `EcsTaskResolutionError` with an actionable message (listing every
 * available task definition in the matched stack) on any miss.
 *
 * Optional `context` (issue #264): when the caller can supply AWS
 * pseudo-parameter values (Tier 1) and / or cdkd state-recorded resources
 * (Tier 2), `Fn::Sub`-shaped ECR image URIs that reference
 * `${AWS::AccountId}` / `${AWS::Region}` / a same-stack
 * `AWS::ECR::Repository` are substituted before classification.
 */
export function resolveEcsTaskTarget(
  target: string,
  stacks: StackInfo[],
  context?: EcsImageResolutionContext
): ResolvedEcsTask {
  if (stacks.length === 0) {
    throw new EcsTaskResolutionError('No stacks found in the synthesized assembly.');
  }
  const parsed = parseEcsTarget(target);
  const stack = pickStack(parsed, stacks, target);
  const resources = stack.template.Resources ?? {};

  let logicalId: string | undefined;
  let resource: TemplateResource | undefined;

  if (parsed.isPath) {
    const index = buildCdkPathIndex(stack.template);
    const resolved = resolveCdkPathToLogicalIds(parsed.pathOrId, index);
    const taskDefs = resolved.filter(
      ({ logicalId: l }) => resources[l]?.Type === 'AWS::ECS::TaskDefinition'
    );
    if (taskDefs.length === 0) {
      throw notFoundError(target, stack, resources);
    }
    if (taskDefs.length > 1) {
      throw new EcsTaskResolutionError(
        `Target '${target}' matches ${taskDefs.length} task definitions in ${stack.stackName}: ` +
          taskDefs.map((t) => t.logicalId).join(', ') +
          '. Refine the path or use the stack:LogicalId form.'
      );
    }
    logicalId = taskDefs[0]!.logicalId;
    resource = resources[logicalId];
  } else {
    resource = resources[parsed.pathOrId];
    if (!resource) throw notFoundError(target, stack, resources);
    logicalId = parsed.pathOrId;
  }

  if (!logicalId || !resource) throw notFoundError(target, stack, resources);

  if (resource.Type === 'AWS::Lambda::Function') {
    throw new EcsTaskResolutionError(
      `Resource '${logicalId}' in ${stack.stackName} is a Lambda function, not an ECS task definition. ` +
        'Use `cdkd local invoke` for Lambda; `cdkd local run-task` is ECS only.'
    );
  }
  if (resource.Type !== 'AWS::ECS::TaskDefinition') {
    throw new EcsTaskResolutionError(
      `Resource '${logicalId}' in ${stack.stackName} is ${resource.Type}, not an AWS::ECS::TaskDefinition.`
    );
  }

  return extractTaskDefinitionProperties(stack, logicalId, resource, context);
}

function pickStack(parsed: ParsedEcsTarget, stacks: StackInfo[], target: string): StackInfo {
  // A path-form target's stack is the LONGEST display-path prefix, not the
  // first segment, which is the Stage id for a Stage stack
  // (go-to-k/cdkd#3953); a wildcard head such as `My*` and the colon form go
  // through matchStacks. Two stacks sharing a physical name (a Stage deployed
  // twice) are refused as ambiguous, never resolved to the first (#5175).
  const selection = selectTargetStack(parsed, target, stacks);
  switch (selection.kind) {
    case 'found':
      return selection.stack;
    case 'no-prefix':
      throw new EcsTaskResolutionError(
        `Multiple stacks in app, target '${parsed.pathOrId}' is missing a stack prefix. ` +
          `Use 'StackName:${parsed.pathOrId}' or 'StackName/...' (path form). ` +
          `Available stacks: ${stacks.map(describeStack).join(', ')}.`
      );
    case 'not-found':
      throw new EcsTaskResolutionError(
        `Stack '${selection.pattern}' not found. ` +
          `Available stacks: ${stacks.map(describeStack).join(', ')}.`
      );
    case 'ambiguous':
      throw new EcsTaskResolutionError(
        renderAmbiguousTargetStack(selection.pattern, selection.matched)
      );
  }
}

function extractTaskDefinitionProperties(
  stack: StackInfo,
  logicalId: string,
  resource: TemplateResource,
  context?: EcsImageResolutionContext
): ResolvedEcsTask {
  const props = resource.Properties ?? {};
  const warnings: string[] = [];

  const family = pickString(props['Family']) ?? logicalId;

  const rawNetworkMode = pickString(props['NetworkMode']) ?? 'bridge';
  let networkMode: ResolvedEcsTask['networkMode'];
  if (
    rawNetworkMode === 'bridge' ||
    rawNetworkMode === 'awsvpc' ||
    rawNetworkMode === 'host' ||
    rawNetworkMode === 'none'
  ) {
    networkMode = rawNetworkMode;
  } else {
    throw new EcsTaskResolutionError(
      `Task definition '${logicalId}' has unsupported NetworkMode '${rawNetworkMode}'. ` +
        'Supported values: bridge / awsvpc / host / none.'
    );
  }
  if (networkMode === 'awsvpc') {
    warnings.push(
      `NetworkMode 'awsvpc' on '${logicalId}' is mapped to docker bridge locally — ` +
        'docker cannot emulate ENI-per-task. AWS SDK calls still reach public endpoints via the developer network.'
    );
  }

  // Issue #544 — `ProxyConfiguration` (custom App Mesh / Envoy bootstrap)
  // is NOT honored by `cdkd local start-service` / `cdkd local run-task`
  // in v1. Design § 2 hard-rejects custom Envoy bootstrap; locally we
  // run the user's containers without the configured proxy and surface
  // a warn so users aren't surprised by the missing sidecar.
  if (props['ProxyConfiguration']) {
    warnings.push(
      `Task definition '${logicalId}' declares 'ProxyConfiguration' (custom Envoy / App Mesh bootstrap), ` +
        "which is NOT honored by 'cdkd local start-service' / 'cdkd local run-task' in v1. " +
        'Local execution will run without the configured proxy. See design doc § 2 for the rationale.'
    );
  }

  const resources = stack.template.Resources ?? {};

  const subContext = buildSubstitutionContextFromImageContext(context);
  const taskRoleArn = resolveRoleArn(props['TaskRoleArn'], resources, subContext);
  const executionRoleArn = resolveRoleArn(props['ExecutionRoleArn'], resources, subContext);

  const runtimePlatform = parseRuntimePlatform(props['RuntimePlatform']);

  const rawContainers = props['ContainerDefinitions'];
  if (!Array.isArray(rawContainers) || rawContainers.length === 0) {
    throw new EcsTaskResolutionError(`Task definition '${logicalId}' has no ContainerDefinitions.`);
  }
  const containers = rawContainers.map((c, idx) =>
    parseContainerDefinition(c, idx, logicalId, resources, stack, context)
  );

  // Surface per-container warnings (e.g. dropped intrinsic env vars /
  // secrets) on the task-level `warnings` array so the CLI prints them.
  for (const ctr of containers) {
    for (const w of ctr.warnings) {
      warnings.push(`Container '${ctr.name}': ${w}`);
    }
  }

  const rawVolumes = props['Volumes'];
  const volumes = Array.isArray(rawVolumes)
    ? rawVolumes.map((v, idx) => parseVolume(v, idx, logicalId, subContext))
    : [];

  // dependsOn must reference an existing container name.
  const containerNames = new Set(containers.map((c) => c.name));
  for (const c of containers) {
    for (const d of c.dependsOn) {
      if (!containerNames.has(d.containerName)) {
        throw new EcsTaskResolutionError(
          `Container '${c.name}' depends on '${d.containerName}', which is not defined in task '${logicalId}'.`
        );
      }
    }
  }

  const out: ResolvedEcsTask = {
    stack,
    taskDefinitionLogicalId: logicalId,
    resource,
    family,
    networkMode,
    containers,
    volumes,
    warnings,
  };
  if (taskRoleArn !== undefined) out.taskRoleArn = taskRoleArn;
  if (executionRoleArn !== undefined) out.executionRoleArn = executionRoleArn;
  if (runtimePlatform !== undefined) out.runtimePlatform = runtimePlatform;
  return out;
}

function parseRuntimePlatform(value: unknown): ResolvedEcsTask['runtimePlatform'] | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const obj = value as Record<string, unknown>;
  const cpu = obj['CpuArchitecture'];
  const os = obj['OperatingSystemFamily'];
  if (typeof cpu !== 'string' || typeof os !== 'string') return undefined;
  if (cpu !== 'X86_64' && cpu !== 'ARM64') return undefined;
  if (os !== 'LINUX') return undefined;
  return { cpuArchitecture: cpu, operatingSystemFamily: os };
}

function notFoundError(
  target: string,
  stack: StackInfo,
  resources: Record<string, TemplateResource>
): EcsTaskResolutionError {
  const tasks: { displayPath: string; logicalId: string }[] = [];
  for (const [logicalId, resource] of Object.entries(resources)) {
    if (resource.Type !== 'AWS::ECS::TaskDefinition') continue;
    const meta = resource.Metadata;
    const cdkPath = typeof meta?.['aws:cdk:path'] === 'string' ? meta['aws:cdk:path'] : '';
    tasks.push({ displayPath: cdkPath || logicalId, logicalId });
  }
  let msg = `target '${target}' did not match any ECS task definition in ${stack.stackName}.\n\n`;
  if (tasks.length === 0) {
    msg += `Stack ${stack.stackName} has no AWS::ECS::TaskDefinition resources.`;
  } else {
    const width = Math.max(...tasks.map((t) => t.displayPath.length));
    msg += `Available task definitions in ${stack.stackName}:\n`;
    for (const t of tasks) {
      msg += `  ${t.displayPath.padEnd(width)}  (${t.logicalId})\n`;
    }
  }
  return new EcsTaskResolutionError(msg.trimEnd());
}
