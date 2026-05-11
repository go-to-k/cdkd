import { dirname, isAbsolute, resolve } from 'node:path';
import { existsSync, statSync } from 'node:fs';
import type { StackInfo } from '../synthesis/assembly-reader.js';
import type { TemplateResource } from '../types/resource.js';
import { buildCdkPathIndex, resolveCdkPathToLogicalIds } from '../cli/cdk-path.js';
import { matchStacks } from '../cli/stack-matcher.js';
import type { ResourceState } from '../types/state.js';

/**
 * Result of resolving a `cdkd local run-task <target>` argument back to a
 * concrete `AWS::ECS::TaskDefinition` in the synthesized assembly. The
 * shape mirrors what the ECS API + the CFn template expose so the runner
 * can directly translate each field into `docker run` flags / `docker
 * network` lifecycle calls without re-walking the template.
 *
 * Phase 1: no AWS-side ECS API calls are needed to build this — every
 * field is template-derived. `Secrets[].valueFrom` resolution happens
 * separately in `ecs-secrets-resolver.ts` so this module stays free of
 * AWS SDK imports.
 */
export interface ResolvedEcsTask {
  /** Stack the task definition belongs to. */
  stack: StackInfo;
  /** Logical id of the AWS::ECS::TaskDefinition resource. */
  taskDefinitionLogicalId: string;
  /** Raw template entry — kept for future feature additions. */
  resource: TemplateResource;
  /**
   * Task family. Falls back to the logical id when not declared (CDK auto-
   * generates a family in this case but only at deploy time; locally we
   * surface the logical id so logs are still identifiable).
   */
  family: string;
  /**
   * Default `bridge`. `awsvpc` is mapped to `bridge` locally with a warn
   * because docker cannot emulate ENI-per-task; `host` and `none` pass
   * through unchanged.
   */
  networkMode: 'bridge' | 'awsvpc' | 'host' | 'none';
  /**
   * Resolved task role ARN. Surfaced as either:
   *   - a flat string ARN passed through verbatim from the template, OR
   *   - a synth-time placeholder of the shape
   *     `arn:aws:iam::${AWS::AccountId}:role/<RoleLogicalId>` when the
   *     `TaskRoleArn` is a `Ref` / `Fn::GetAtt` against an `AWS::IAM::Role`
   *     in the same stack. The CLI substitutes the placeholder account
   *     segment lazily via STS `GetCallerIdentity` when (and only when)
   *     `--assume-task-role` is used in its bare form.
   *   - `undefined` when the template's `TaskRoleArn` is missing OR is an
   *     intrinsic that doesn't reference a same-stack IAM Role (e.g.
   *     points at a non-IAM-Role resource type or is an unsupported
   *     intrinsic shape — see `resolveRoleArn`).
   */
  taskRoleArn?: string;
  /** Resolved execution role ARN. Follows the same shape as `taskRoleArn`. */
  executionRoleArn?: string;
  containers: ResolvedEcsContainer[];
  volumes: ResolvedEcsVolume[];
  /**
   * `RuntimePlatform.CpuArchitecture` + `OperatingSystemFamily`. Only
   * `X86_64` / `ARM64` + `LINUX` are routed in v1; other values pass
   * through unchanged but the docker-runner only honors the arch field.
   */
  runtimePlatform?: { cpuArchitecture: 'X86_64' | 'ARM64'; operatingSystemFamily: 'LINUX' };
  /**
   * Resolution warnings (e.g. `awsvpc` → `bridge` map) the caller may
   * want to surface at startup. Non-fatal — the runner still proceeds.
   */
  warnings: string[];
}

export interface ResolvedEcsContainer {
  name: string;
  image: ResolvedEcsImage;
  command?: string[];
  entryPoint?: string[];
  workingDirectory?: string;
  /** Literal-only env vars; intrinsic-valued entries are dropped (matches `cdkd local invoke` v1). */
  environment: Record<string, string>;
  /** SecretArn entries. Resolved to real values by `ecs-secrets-resolver.ts`. */
  secrets: { name: string; valueFrom: string }[];
  portMappings: { containerPort: number; hostPort?: number; protocol: 'tcp' | 'udp' }[];
  mountPoints: { sourceVolume: string; containerPath: string; readOnly: boolean }[];
  dependsOn: { containerName: string; condition: 'START' | 'COMPLETE' | 'SUCCESS' | 'HEALTHY' }[];
  links: string[];
  /** Default true per AWS docs — when not set, the container is treated as essential. */
  essential: boolean;
  healthCheck?: {
    command: string[];
    interval?: number;
    timeout?: number;
    retries?: number;
    startPeriod?: number;
  };
  user?: string;
  privileged?: boolean;
  readonlyRootFilesystem?: boolean;
  ulimits: { name: string; softLimit: number; hardLimit: number }[];
}

export type ResolvedEcsImage =
  | { kind: 'cdk-asset'; assetHash?: string }
  | { kind: 'ecr'; uri: string; account: string; region: string }
  | { kind: 'public'; uri: string };

export interface ResolvedEcsVolume {
  name: string;
  kind: 'host' | 'docker';
  /** Absolute host path for a bind mount. Undefined → docker anonymous volume. */
  hostPath?: string;
  /**
   * `DockerVolumeConfiguration`. When set, the volume is realized via
   * `docker volume create` rather than a bind mount.
   */
  dockerVolumeConfig?: {
    scope: 'task' | 'shared';
    autoprovision?: boolean;
    driver?: string;
    driverOpts?: Record<string, string>;
    labels?: Record<string, string>;
  };
}

export class EcsTaskResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EcsTaskResolutionError';
    Object.setPrototypeOf(this, EcsTaskResolutionError.prototype);
  }
}

/**
 * Derive the AWS partition / URL suffix for an AWS region. Same mapping
 * CloudFormation applies to `${AWS::Partition}` / `${AWS::URLSuffix}`.
 * Exported so the CLI can keep the STS hop minimal — caller passes the
 * region in once, this returns the matching partition + suffix.
 */
export function derivePartitionAndUrlSuffix(region: string): {
  partition: string;
  urlSuffix: string;
} {
  if (region.startsWith('cn-')) return { partition: 'aws-cn', urlSuffix: 'amazonaws.com.cn' };
  if (region.startsWith('us-gov-')) return { partition: 'aws-us-gov', urlSuffix: 'amazonaws.com' };
  if (region.startsWith('us-iso-')) return { partition: 'aws-iso', urlSuffix: 'c2s.ic.gov' };
  if (region.startsWith('us-isob-')) return { partition: 'aws-iso-b', urlSuffix: 'sc2s.sgov.gov' };
  return { partition: 'aws', urlSuffix: 'amazonaws.com' };
}

/**
 * Optional substitution data fed into `parseContainerImage`. Closes issue
 * #264 — container `Image` fields shaped as `Fn::Sub` against AWS pseudo
 * parameters (`${AWS::AccountId}` / `${AWS::Region}` / `${AWS::Partition}` /
 * `${AWS::URLSuffix}`) and / or same-stack `AWS::ECR::Repository` refs are
 * resolvable at runtime when the caller can supply the account ID + region
 * (Tier 1, no state needed) and optionally the cdkd state-recorded
 * `physicalId` map (Tier 2, `--from-state`).
 *
 * The CLI command resolves both blocks lazily — STS is only invoked when
 * at least one container's `Image` references the pseudo parameters — and
 * passes the resolved shape here. The resolver itself stays pure and
 * synchronous.
 */
export interface EcsImageResolutionContext {
  /**
   * Resolved AWS pseudo parameters. When undefined for a given key, the
   * substitution is treated as missing and the value passes through to
   * the existing error path. Caller is expected to populate every key
   * when it populates any (we derive partition / URL suffix from region
   * in the CLI layer).
   */
  pseudoParameters?: {
    accountId?: string;
    region?: string;
    partition?: string;
    urlSuffix?: string;
  };
  /**
   * `state.resources` from cdkd's S3 state record for the target stack,
   * loaded by the CLI command before resolution when `--from-state` is
   * passed. Used to substitute `${<LogicalId>}` against an
   * `AWS::ECR::Repository` and the `Fn::GetAtt` `RepositoryUri` shape.
   * Undefined when `--from-state` is not in effect.
   */
  stateResources?: Record<string, ResourceState>;
}

/**
 * Parse a `target` argument into (optional stack pattern, path-or-id).
 * Mirrors `lambda-resolver.parseTarget` exactly — same accepted forms,
 * same single-stack auto-detect rule.
 */
export interface ParsedEcsTarget {
  stackPattern: string | null;
  pathOrId: string;
  isPath: boolean;
}

/**
 * Walk the matched stack's template and report whether any container's
 * `Image` field needs Tier 1 (pseudo-parameter) or Tier 2 (state-recorded
 * ECR Repository) substitution. The CLI uses this to make the STS /
 * state-load calls lazy — flat strings / cdk-asset shapes / Fn::Sub bodies
 * with no recognized placeholders skip both calls entirely.
 *
 * The probe is per-stack rather than per-target because we don't run the
 * full target resolver until the substitution context is built; cheap
 * O(resources) scan over the template's task definitions is sufficient.
 */
export interface EcsImageResolutionNeeds {
  /** Any `Fn::Sub` body references an `AWS::*` pseudo parameter. */
  needsPseudoParameters: boolean;
  /**
   * Any `Fn::Sub` body references an `AWS::ECR::Repository` logical ID,
   * OR any `Fn::GetAtt: [<Repo>, 'RepositoryUri' | 'Arn']` is present.
   */
  needsStateResources: boolean;
}

export function detectEcsImageResolutionNeeds(stack: StackInfo): EcsImageResolutionNeeds {
  const resources = stack.template.Resources ?? {};
  let needsPseudoParameters = false;
  let needsStateResources = false;

  for (const res of Object.values(resources)) {
    if (res.Type !== 'AWS::ECS::TaskDefinition') continue;
    const props = res.Properties ?? {};
    const containers = Array.isArray(props['ContainerDefinitions'])
      ? props['ContainerDefinitions']
      : [];
    for (const c of containers) {
      if (!c || typeof c !== 'object') continue;
      const image = (c as Record<string, unknown>)['Image'];
      const need = inspectImageForSubstitutions(image, resources);
      if (need.pseudo) needsPseudoParameters = true;
      if (need.state) needsStateResources = true;
      if (needsPseudoParameters && needsStateResources) break;
    }
    if (needsPseudoParameters && needsStateResources) break;
  }
  return { needsPseudoParameters, needsStateResources };
}

function inspectImageForSubstitutions(
  image: unknown,
  resources: Record<string, TemplateResource>
): { pseudo: boolean; state: boolean } {
  if (!image || typeof image !== 'object') return { pseudo: false, state: false };
  const obj = image as Record<string, unknown>;

  // Fn::GetAtt direct shape against an ECR::Repository — Tier 2 only.
  const getAtt = obj['Fn::GetAtt'];
  if (getAtt !== undefined) {
    let lid: string | undefined;
    if (Array.isArray(getAtt) && typeof getAtt[0] === 'string') lid = getAtt[0];
    else if (typeof getAtt === 'string') lid = getAtt.split('.')[0];
    if (lid && resources[lid]?.Type === 'AWS::ECR::Repository') {
      return { pseudo: false, state: true };
    }
  }

  // Fn::Join body: recursively walk every element for references that
  // would trigger Tier 1 (pseudo) / Tier 2 (state) needs. CDK 2.x
  // synthesizes `ContainerImage.fromEcrRepository(repo)` as a Fn::Join
  // containing nested Fn::Select / Fn::Split over the repo's Arn GetAtt
  // plus a Ref to the repo and `Ref: AWS::URLSuffix`.
  const join = obj['Fn::Join'];
  if (Array.isArray(join) && join.length === 2 && Array.isArray(join[1])) {
    const scan: { pseudo: boolean; state: boolean } = { pseudo: false, state: false };
    inspectIntrinsicNeeds(join[1], resources, scan);
    if (scan.pseudo || scan.state) return scan;
  }

  // Fn::Sub body: scan every `${...}` placeholder.
  let sub: string | undefined;
  const subRaw = obj['Fn::Sub'];
  if (typeof subRaw === 'string') sub = subRaw;
  else if (Array.isArray(subRaw) && typeof subRaw[0] === 'string') sub = subRaw[0];
  if (!sub) return { pseudo: false, state: false };

  let pseudo = false;
  let state = false;
  const placeholderRegex = /\$\{([^}]+)\}/g;
  let m: RegExpExecArray | null;
  while ((m = placeholderRegex.exec(sub)) !== null) {
    const key = m[1]!;
    if (key.startsWith('AWS::')) {
      pseudo = true;
      continue;
    }
    const dot = key.indexOf('.');
    const lid = dot === -1 ? key : key.slice(0, dot);
    if (resources[lid]?.Type === 'AWS::ECR::Repository') state = true;
  }
  return { pseudo, state };
}

/**
 * Recursive needs probe used by `inspectImageForSubstitutions` for the
 * `Fn::Join` shape: walk every nested intrinsic and flag whether a
 * `Ref: AWS::*` pseudo parameter is reachable (Tier 1 needed) or a
 * `Ref` / `Fn::GetAtt` against an `AWS::ECR::Repository` is reachable
 * (Tier 2 needed).
 */
function inspectIntrinsicNeeds(
  node: unknown,
  resources: Record<string, TemplateResource>,
  scan: { pseudo: boolean; state: boolean }
): void {
  if (node === null || node === undefined) return;
  if (typeof node === 'string' || typeof node === 'number' || typeof node === 'boolean') return;
  if (Array.isArray(node)) {
    for (const item of node) inspectIntrinsicNeeds(item, resources, scan);
    return;
  }
  if (typeof node !== 'object') return;
  const obj = node as Record<string, unknown>;

  if (typeof obj['Ref'] === 'string') {
    const target = obj['Ref'];
    if (target.startsWith('AWS::')) scan.pseudo = true;
    else if (resources[target]?.Type === 'AWS::ECR::Repository') scan.state = true;
    return;
  }

  const getAtt = obj['Fn::GetAtt'];
  if (getAtt !== undefined) {
    let lid: string | undefined;
    if (Array.isArray(getAtt) && typeof getAtt[0] === 'string') lid = getAtt[0];
    else if (typeof getAtt === 'string') lid = getAtt.split('.')[0];
    if (lid && resources[lid]?.Type === 'AWS::ECR::Repository') scan.state = true;
    return;
  }

  // For every other intrinsic shape, descend into its arguments so a
  // `Fn::Select` / `Fn::Split` / `Fn::Join` / `Fn::Sub` wrapper does
  // not hide a reference deeper in the tree.
  for (const value of Object.values(obj)) {
    inspectIntrinsicNeeds(value, resources, scan);
  }
}

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
  const stack = pickStack(parsed, stacks);
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

function pickStack(parsed: ParsedEcsTarget, stacks: StackInfo[]): StackInfo {
  if (parsed.stackPattern === null) {
    if (stacks.length === 1) return stacks[0]!;
    throw new EcsTaskResolutionError(
      `Multiple stacks in app, target '${parsed.pathOrId}' is missing a stack prefix. ` +
        `Use 'StackName:${parsed.pathOrId}' or 'StackName/...' (path form). ` +
        `Available stacks: ${stacks.map((s) => s.stackName).join(', ')}.`
    );
  }
  const matched = matchStacks(stacks, [parsed.stackPattern]);
  if (matched.length === 0) {
    throw new EcsTaskResolutionError(
      `Stack '${parsed.stackPattern}' not found. ` +
        `Available stacks: ${stacks.map((s) => s.stackName).join(', ')}.`
    );
  }
  if (matched.length > 1) {
    throw new EcsTaskResolutionError(
      `Stack pattern '${parsed.stackPattern}' matched ${matched.length} stacks: ` +
        matched.map((s) => s.stackName).join(', ') +
        '. Use a more specific pattern.'
    );
  }
  return matched[0]!;
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

  const resources = stack.template.Resources ?? {};

  const taskRoleArn = resolveRoleArn(props['TaskRoleArn'], resources);
  const executionRoleArn = resolveRoleArn(props['ExecutionRoleArn'], resources);

  const runtimePlatform = parseRuntimePlatform(props['RuntimePlatform']);

  const rawContainers = props['ContainerDefinitions'];
  if (!Array.isArray(rawContainers) || rawContainers.length === 0) {
    throw new EcsTaskResolutionError(`Task definition '${logicalId}' has no ContainerDefinitions.`);
  }
  const containers = rawContainers.map((c, idx) =>
    parseContainerDefinition(c, idx, logicalId, resources, stack, context)
  );

  const rawVolumes = props['Volumes'];
  const volumes = Array.isArray(rawVolumes)
    ? rawVolumes.map((v, idx) => parseVolume(v, idx, logicalId))
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

function parseContainerDefinition(
  raw: unknown,
  idx: number,
  taskLogicalId: string,
  resources: Record<string, TemplateResource>,
  stack: StackInfo,
  context?: EcsImageResolutionContext
): ResolvedEcsContainer {
  if (!raw || typeof raw !== 'object') {
    throw new EcsTaskResolutionError(
      `Task '${taskLogicalId}' ContainerDefinitions[${idx}] is not an object.`
    );
  }
  const c = raw as Record<string, unknown>;
  const name = pickString(c['Name']);
  if (!name) {
    throw new EcsTaskResolutionError(
      `Task '${taskLogicalId}' ContainerDefinitions[${idx}] has no Name.`
    );
  }

  const image = parseContainerImage(c['Image'], name, taskLogicalId, resources, stack, context);

  const command = pickStringArray(c['Command']);
  const entryPoint = pickStringArray(c['EntryPoint']);
  const workingDirectory = pickString(c['WorkingDirectory']);

  const environment: Record<string, string> = {};
  if (Array.isArray(c['Environment'])) {
    for (const entry of c['Environment'] as unknown[]) {
      if (!entry || typeof entry !== 'object') continue;
      const e = entry as Record<string, unknown>;
      const key = pickString(e['Name']);
      const value = e['Value'];
      if (!key) continue;
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        environment[key] = String(value);
      }
      // Intrinsic-valued entries are silently dropped here; the runner's
      // logger warns. Matches `cdkd local invoke` v1 semantics.
    }
  }

  const secrets: ResolvedEcsContainer['secrets'] = [];
  if (Array.isArray(c['Secrets'])) {
    for (const entry of c['Secrets'] as unknown[]) {
      if (!entry || typeof entry !== 'object') continue;
      const e = entry as Record<string, unknown>;
      const sName = pickString(e['Name']);
      const valueFrom = pickString(e['ValueFrom']);
      if (sName && valueFrom) secrets.push({ name: sName, valueFrom });
    }
  }

  const portMappings: ResolvedEcsContainer['portMappings'] = [];
  if (Array.isArray(c['PortMappings'])) {
    for (const entry of c['PortMappings'] as unknown[]) {
      if (!entry || typeof entry !== 'object') continue;
      const p = entry as Record<string, unknown>;
      const containerPort = typeof p['ContainerPort'] === 'number' ? p['ContainerPort'] : undefined;
      if (containerPort === undefined) continue;
      const hostPort = typeof p['HostPort'] === 'number' ? p['HostPort'] : undefined;
      const protocol = pickString(p['Protocol']) === 'udp' ? 'udp' : 'tcp';
      const pm: ResolvedEcsContainer['portMappings'][number] = { containerPort, protocol };
      if (hostPort !== undefined) pm.hostPort = hostPort;
      portMappings.push(pm);
    }
  }

  const mountPoints: ResolvedEcsContainer['mountPoints'] = [];
  if (Array.isArray(c['MountPoints'])) {
    for (const entry of c['MountPoints'] as unknown[]) {
      if (!entry || typeof entry !== 'object') continue;
      const m = entry as Record<string, unknown>;
      const sourceVolume = pickString(m['SourceVolume']);
      const containerPath = pickString(m['ContainerPath']);
      if (!sourceVolume || !containerPath) continue;
      mountPoints.push({
        sourceVolume,
        containerPath,
        readOnly: m['ReadOnly'] === true,
      });
    }
  }

  const dependsOn: ResolvedEcsContainer['dependsOn'] = [];
  if (Array.isArray(c['DependsOn'])) {
    for (const entry of c['DependsOn'] as unknown[]) {
      if (!entry || typeof entry !== 'object') continue;
      const d = entry as Record<string, unknown>;
      const containerName = pickString(d['ContainerName']);
      const condition = pickString(d['Condition']);
      if (!containerName || !condition) continue;
      if (
        condition !== 'START' &&
        condition !== 'COMPLETE' &&
        condition !== 'SUCCESS' &&
        condition !== 'HEALTHY'
      ) {
        throw new EcsTaskResolutionError(
          `Container '${name}' has invalid DependsOn condition '${condition}'. ` +
            'Accepted values: START / COMPLETE / SUCCESS / HEALTHY.'
        );
      }
      dependsOn.push({ containerName, condition });
    }
  }

  const links = pickStringArray(c['Links']) ?? [];
  const essential = c['Essential'] === false ? false : true;

  let healthCheck: ResolvedEcsContainer['healthCheck'] | undefined;
  if (c['HealthCheck'] && typeof c['HealthCheck'] === 'object') {
    const h = c['HealthCheck'] as Record<string, unknown>;
    const command2 = pickStringArray(h['Command']);
    if (command2 && command2.length > 0) {
      healthCheck = { command: command2 };
      if (typeof h['Interval'] === 'number') healthCheck.interval = h['Interval'];
      if (typeof h['Timeout'] === 'number') healthCheck.timeout = h['Timeout'];
      if (typeof h['Retries'] === 'number') healthCheck.retries = h['Retries'];
      if (typeof h['StartPeriod'] === 'number') healthCheck.startPeriod = h['StartPeriod'];
    }
  }

  const user = pickString(c['User']);
  const privileged = c['Privileged'] === true ? true : undefined;
  const readonlyRootFilesystem = c['ReadonlyRootFilesystem'] === true ? true : undefined;

  const ulimits: ResolvedEcsContainer['ulimits'] = [];
  if (Array.isArray(c['Ulimits'])) {
    for (const entry of c['Ulimits'] as unknown[]) {
      if (!entry || typeof entry !== 'object') continue;
      const u = entry as Record<string, unknown>;
      const uName = pickString(u['Name']);
      const soft = typeof u['SoftLimit'] === 'number' ? u['SoftLimit'] : undefined;
      const hard = typeof u['HardLimit'] === 'number' ? u['HardLimit'] : undefined;
      if (!uName || soft === undefined || hard === undefined) continue;
      ulimits.push({ name: uName, softLimit: soft, hardLimit: hard });
    }
  }

  const out: ResolvedEcsContainer = {
    name,
    image,
    environment,
    secrets,
    portMappings,
    mountPoints,
    dependsOn,
    links,
    essential,
    ulimits,
  };
  if (command !== undefined) out.command = command;
  if (entryPoint !== undefined) out.entryPoint = entryPoint;
  if (workingDirectory !== undefined) out.workingDirectory = workingDirectory;
  if (healthCheck !== undefined) out.healthCheck = healthCheck;
  if (user !== undefined) out.user = user;
  if (privileged !== undefined) out.privileged = privileged;
  if (readonlyRootFilesystem !== undefined) out.readonlyRootFilesystem = readonlyRootFilesystem;
  return out;
}

/**
 * Parse the `Image` field of an ECS container definition.
 *
 * Three shapes:
 *   - `<account>.dkr.ecr.<region>.amazonaws.com/<repo>:<tag>` — same-account
 *     same-region ECR. Cross-account/region is hard-errored (matches
 *     `cdkd local invoke`'s ECR-pull semantics).
 *   - `Fn::Sub` / `Fn::Join` / `Ref` referencing a `Code.fromAsset`-style
 *     CDK asset image. Surfaces `kind: 'cdk-asset'` with the optional
 *     asset hash so the runner can route through `docker-build.ts`.
 *   - Any other public URI (`public.ecr.aws/...`, `docker.io/...`,
 *     `nginx:latest`, etc.) — `kind: 'public'`, runner does a `docker pull`.
 *
 * Two-tier substitution (issue #264):
 *   - **Tier 1** — when `context.pseudoParameters` is populated, AWS pseudo
 *     parameters in `Fn::Sub` bodies (`${AWS::AccountId}` / `${AWS::Region}` /
 *     `${AWS::Partition}` / `${AWS::URLSuffix}`) are substituted before
 *     regex matching. The CLI resolves these via STS + region env once
 *     per invocation.
 *   - **Tier 2** — when `context.stateResources` is populated
 *     (`--from-state`), `${<LogicalId>}` placeholders that resolve to an
 *     `AWS::ECR::Repository` are substituted with the state-recorded
 *     `physicalId`, and `Fn::GetAtt: [<Repo>, 'RepositoryUri']` shapes
 *     are resolved via the same state record.
 *
 * Tier 3 (cross-account / cross-region pull) is deferred — `pullEcrImage`
 * surfaces the same workaround pointer it already does.
 */
function parseContainerImage(
  raw: unknown,
  containerName: string,
  taskLogicalId: string,
  resources: Record<string, TemplateResource>,
  _stack: StackInfo,
  context?: EcsImageResolutionContext
): ResolvedEcsImage {
  // Tier 2: handle `Fn::GetAtt: [<Repo>, 'RepositoryUri']` directly — it
  // produces a complete `<acct>.dkr.ecr.<region>.amazonaws.com/<name>` URI
  // we can match against the ECR regex below. The tag is whatever the
  // template provides; for the bare GetAtt shape there is none, which is
  // unusual but we surface the resulting tagless URI rather than guess.
  const getAttImage = tryResolveImageGetAtt(raw, resources, context);
  if (getAttImage) {
    return classifyResolvedImage(getAttImage);
  }

  // Issue #271: CDK 2.x synthesizes `ContainerImage.fromEcrRepository(repo)`
  // as a `Fn::Join` that builds the ECR URI from nested `Fn::Select` /
  // `Fn::Split` over the repository's `Arn` GetAtt plus a `Ref` to the
  // repo and `Ref: AWS::URLSuffix`. The repository's account-id and
  // region only exist in cdkd's S3 state (set at deploy time), so this
  // shape inherently requires `--from-state` (Tier 2).
  const joinResolved = tryResolveImageFnJoin(raw, resources, context);
  if (joinResolved.kind === 'resolved') {
    return classifyResolvedImage(joinResolved.uri);
  }
  if (joinResolved.kind === 'needs-state') {
    throw new EcsTaskResolutionError(
      `Container '${containerName}' in task '${taskLogicalId}' references same-stack ECR repository '${joinResolved.repoLogicalId}' via Fn::Join. ` +
        'cdkd local run-task cannot resolve the repository URI without state — ' +
        'pass --from-state (the stack must have been deployed via cdkd deploy), ' +
        'build via ContainerImage.fromAsset, or pin a public image.'
    );
  }
  if (joinResolved.kind === 'unsupported-join') {
    throw new EcsTaskResolutionError(
      `Container '${containerName}' in task '${taskLogicalId}' has an unsupported Fn::Join Image shape: ${joinResolved.reason}. ` +
        'cdkd local run-task recognizes the canonical CDK 2.x ContainerImage.fromEcrRepository Fn::Join shape ' +
        '(delimiter "" with nested Fn::Select/Fn::Split over an ECR Repository Arn GetAtt + Ref to the repo).'
    );
  }

  const flat = extractImageString(raw);
  if (!flat) {
    throw new EcsTaskResolutionError(
      `Container '${containerName}' in task '${taskLogicalId}' has an unparseable Image property. ` +
        'cdkd local run-task v1 supports flat string images, single-key Fn::Sub bodies, and CDK-asset Image references.'
    );
  }

  // CDK asset shape: contains the bootstrap-assets repo placeholder. The
  // tail `:<hash>` is the asset hash (same shape used by Lambda container
  // images — see `getDockerImageBySourceHash`).
  if (flat.includes('cdk-hnb659fds-container-assets-')) {
    const hashMatch = /:([a-f0-9]{8,})$/.exec(flat);
    const out: ResolvedEcsImage = { kind: 'cdk-asset' };
    if (hashMatch) out.assetHash = hashMatch[1]!;
    return out;
  }

  // Substitute pseudo parameters + same-stack ECR Ref placeholders into
  // the flat string when context is supplied. Pure string-rewrite —
  // unresolved placeholders pass through verbatim so the post-walk
  // diagnostics below can route to the precise error message.
  const substituted = substituteImagePlaceholders(flat, resources, context);

  // Unresolved `${...}` placeholders survived substitution. Surface a
  // precise hint BEFORE the ECR regex match — otherwise a leftover
  // `${MyRepo}` in the path portion would still match the host-portion
  // regex and silently produce a broken URI for `docker pull` to fail on.
  if (substituted.includes('${')) {
    const unresolvedRepoRef = findUnresolvedEcrRepositoryRef(substituted, resources);
    if (unresolvedRepoRef) {
      throw new EcsTaskResolutionError(
        `Container '${containerName}' in task '${taskLogicalId}' references same-stack ECR repository '${unresolvedRepoRef}'. ` +
          'cdkd local run-task v1 cannot resolve the repository URI without state — ' +
          'pass --from-state (the stack must have been deployed via cdkd deploy), ' +
          'build via ContainerImage.fromAsset, or pin a public image.'
      );
    }
    if (substituted.includes('AWS::')) {
      throw new EcsTaskResolutionError(
        `Container '${containerName}' in task '${taskLogicalId}' has an Image that references AWS pseudo parameters (${substituted}). ` +
          'cdkd could not resolve them: confirm AWS credentials are configured so STS GetCallerIdentity succeeds, ' +
          'and that --region / AWS_REGION names the target region. ' +
          'Workaround: build the image locally (ContainerImage.fromAsset) or pin a public image.'
      );
    }
    // Some other placeholder survived (e.g. a Parameter ref). Surface as
    // a generic resolver failure rather than letting it slip through as
    // a "public" image.
    throw new EcsTaskResolutionError(
      `Container '${containerName}' in task '${taskLogicalId}' has an Image with unresolved \${...} placeholders (${substituted}). ` +
        'cdkd local run-task v1 only resolves AWS pseudo parameters and same-stack AWS::ECR::Repository refs.'
    );
  }

  // Account-scoped ECR repo.
  const ecrMatch = /^(\d{12})\.dkr\.ecr\.([^.]+)\.amazonaws\.com(?:\.cn)?\//.exec(substituted);
  if (ecrMatch) {
    return { kind: 'ecr', uri: substituted, account: ecrMatch[1]!, region: ecrMatch[2]! };
  }

  return { kind: 'public', uri: substituted };
}

/**
 * When the flat string still contains `${X}` after substitution, check
 * whether `X` (or `X.<attr>`) names a same-stack `AWS::ECR::Repository`.
 * Returns the logical ID of the offending repo for a precise error
 * message; `undefined` otherwise.
 */
function findUnresolvedEcrRepositoryRef(
  substituted: string,
  resources: Record<string, TemplateResource>
): string | undefined {
  const placeholderRegex = /\$\{([^}]+)\}/g;
  let m: RegExpExecArray | null;
  while ((m = placeholderRegex.exec(substituted)) !== null) {
    const key = m[1]!;
    if (key.startsWith('AWS::')) continue;
    const dot = key.indexOf('.');
    const lid = dot === -1 ? key : key.slice(0, dot);
    if (resources[lid]?.Type === 'AWS::ECR::Repository') return lid;
  }
  return undefined;
}

/**
 * Classify a fully-substituted image URI (Tier 1 / Tier 2 produced a
 * concrete string) into the `ResolvedEcsImage` shape. Splits out so the
 * `Fn::GetAtt` path can share the regex-match branches.
 */
function classifyResolvedImage(uri: string): ResolvedEcsImage {
  if (uri.includes('cdk-hnb659fds-container-assets-')) {
    const hashMatch = /:([a-f0-9]{8,})$/.exec(uri);
    const out: ResolvedEcsImage = { kind: 'cdk-asset' };
    if (hashMatch) out.assetHash = hashMatch[1]!;
    return out;
  }
  const ecrMatch = /^(\d{12})\.dkr\.ecr\.([^.]+)\.amazonaws\.com(?:\.cn)?\//.exec(uri);
  if (ecrMatch) {
    return { kind: 'ecr', uri, account: ecrMatch[1]!, region: ecrMatch[2]! };
  }
  return { kind: 'public', uri };
}

/**
 * Substitute Tier 1 (pseudo-parameter) and Tier 2 (state-recorded ECR
 * Repository physical id) placeholders inside a `Fn::Sub`-derived flat
 * string. Substitutions are best-effort per placeholder: every `${...}`
 * we recognize is replaced; unknown placeholders (or recognized ones for
 * which we have no value) pass through untouched so the caller's error
 * path can name them.
 */
function substituteImagePlaceholders(
  flat: string,
  resources: Record<string, TemplateResource>,
  context: EcsImageResolutionContext | undefined
): string {
  if (!flat.includes('${')) return flat;
  return flat.replace(/\$\{([^}]+)\}/g, (full, key: string) => {
    if (context?.pseudoParameters) {
      if (key === 'AWS::AccountId' && context.pseudoParameters.accountId) {
        return context.pseudoParameters.accountId;
      }
      if (key === 'AWS::Region' && context.pseudoParameters.region) {
        return context.pseudoParameters.region;
      }
      if (key === 'AWS::Partition' && context.pseudoParameters.partition) {
        return context.pseudoParameters.partition;
      }
      if (key === 'AWS::URLSuffix' && context.pseudoParameters.urlSuffix) {
        return context.pseudoParameters.urlSuffix;
      }
    }
    if (context?.stateResources) {
      const dot = key.indexOf('.');
      const logicalId = dot === -1 ? key : key.slice(0, dot);
      const refResource = resources[logicalId];
      const stateEntry = context.stateResources[logicalId];
      if (refResource?.Type === 'AWS::ECR::Repository' && stateEntry) {
        if (dot === -1) {
          // `${<Repo>}` → the repository's physical id (its Name).
          return stateEntry.physicalId;
        }
        const attr = key.slice(dot + 1);
        const cached = stateEntry.attributes?.[attr];
        if (typeof cached === 'string') return cached;
      }
    }
    return full;
  });
}

/**
 * Handle the discrete `Fn::GetAtt: [<Repo>, 'RepositoryUri']` /
 * `'<Repo>.RepositoryUri'` shape against state-recorded resources. CDK
 * occasionally emits this instead of `Fn::Sub` when the user writes
 * `ContainerImage.fromEcrRepository(repo, tag)` and the tag is a literal.
 * Returns the resolved URI string on hit, `undefined` on miss (the caller
 * falls through to `extractImageString` for `Fn::Sub` / `Fn::Join` / `Ref`).
 */
function tryResolveImageGetAtt(
  raw: unknown,
  resources: Record<string, TemplateResource>,
  context: EcsImageResolutionContext | undefined
): string | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const obj = raw as Record<string, unknown>;
  const arg = obj['Fn::GetAtt'];
  if (arg === undefined) return undefined;

  let logicalId: string | undefined;
  let attr: string | undefined;
  if (
    Array.isArray(arg) &&
    arg.length === 2 &&
    typeof arg[0] === 'string' &&
    typeof arg[1] === 'string'
  ) {
    logicalId = arg[0];
    attr = arg[1];
  } else if (typeof arg === 'string') {
    const dot = arg.indexOf('.');
    if (dot > 0 && dot < arg.length - 1) {
      logicalId = arg.slice(0, dot);
      attr = arg.slice(dot + 1);
    }
  }
  if (!logicalId || !attr) return undefined;

  const refResource = resources[logicalId];
  if (refResource?.Type !== 'AWS::ECR::Repository') return undefined;
  if (attr !== 'RepositoryUri' && attr !== 'Arn') return undefined;

  const cached = context?.stateResources?.[logicalId]?.attributes?.[attr];
  if (typeof cached === 'string' && cached.length > 0) return cached;
  return undefined;
}

function extractImageString(value: unknown): string | undefined {
  if (typeof value === 'string' && value.length > 0) return value;
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const sub = obj['Fn::Sub'];
    if (typeof sub === 'string' && sub.length > 0) return sub;
    if (Array.isArray(sub) && typeof sub[0] === 'string') return sub[0];
    const join = obj['Fn::Join'];
    if (Array.isArray(join) && join.length === 2 && Array.isArray(join[1])) {
      const sep = typeof join[0] === 'string' ? join[0] : '';
      const parts = (join[1] as unknown[])
        .map((p) => (typeof p === 'string' ? p : extractImageString(p)))
        .filter((p): p is string => p !== undefined);
      if (parts.length === (join[1] as unknown[]).length) return parts.join(sep);
    }
  }
  return undefined;
}

/**
 * Outcome of attempting to resolve a `Fn::Join`-shaped Image against the
 * substitution context. Discriminated so the caller can route each case
 * to the right error / classification path.
 */
type FnJoinResolveOutcome =
  | { kind: 'not-applicable' }
  | { kind: 'resolved'; uri: string }
  | { kind: 'needs-state'; repoLogicalId: string }
  | { kind: 'unsupported-join'; reason: string };

/**
 * Issue #271: resolve the canonical CDK 2.x `Fn::Join` shape emitted by
 * `ContainerImage.fromEcrRepository(repo, tag)`.
 *
 * The shape is a `Fn::Join` with delimiter `""` whose elements include
 * nested `Fn::Select` / `Fn::Split` over an `Fn::GetAtt: [<Repo>, 'Arn']`
 * plus a `Ref` to the same `AWS::ECR::Repository` and a `Ref:
 * AWS::URLSuffix`. The account-id + region only exist in cdkd's S3 state
 * (recorded at deploy time on the Repository's `Arn` attribute), so the
 * resolver inherently requires `--from-state` (Tier 2). With state
 * available the helper walks every element via a generic intrinsic
 * resolver and concatenates the resolved strings.
 *
 * Returns `not-applicable` when `raw` isn't an `Fn::Join` (the caller
 * falls through to `extractImageString` / `Fn::Sub` handling). Returns
 * `needs-state` when the `Fn::Join` references a same-stack ECR
 * Repository but no state was supplied (the caller surfaces a
 * `--from-state` hint). Returns `unsupported-join` when the join shape
 * doesn't fit the canonical CDK 2.x pattern (e.g. delimiter != "",
 * non-recognized nested intrinsic) so the caller can route to a precise
 * error.
 */
function tryResolveImageFnJoin(
  raw: unknown,
  resources: Record<string, TemplateResource>,
  context: EcsImageResolutionContext | undefined
): FnJoinResolveOutcome {
  if (!raw || typeof raw !== 'object') return { kind: 'not-applicable' };
  const obj = raw as Record<string, unknown>;
  const arg = obj['Fn::Join'];
  if (arg === undefined) return { kind: 'not-applicable' };

  if (!Array.isArray(arg) || arg.length !== 2 || !Array.isArray(arg[1])) {
    return { kind: 'unsupported-join', reason: 'Fn::Join must be [delimiter, [elements]]' };
  }
  const [delimiter, elements] = arg as [unknown, unknown[]];
  if (typeof delimiter !== 'string') {
    return {
      kind: 'unsupported-join',
      reason: `Fn::Join delimiter must be a string, got ${typeof delimiter}`,
    };
  }

  // Find a same-stack ECR::Repository referenced by either a `Ref` or
  // `Fn::GetAtt` somewhere in the element tree. The presence of such a
  // reference is the load-bearing signal that this Fn::Join is an ECR
  // image URI (rather than an unrelated Join that happens to be the
  // Image field).
  const repoLogicalId = findEcrRepositoryRefInTree(elements, resources);

  const stateResources = context?.stateResources;
  if (repoLogicalId && !stateResources) {
    return { kind: 'needs-state', repoLogicalId };
  }

  // Walk every element through the generic intrinsic resolver. Any
  // unresolvable element aborts with `unsupported-join`.
  const parts: string[] = [];
  for (const element of elements) {
    const r = resolveImageIntrinsic(element, resources, context);
    if (r === undefined) {
      // No ECR Repository reference AND we could not produce a string —
      // this isn't a canonical CDK 2.x ECR Fn::Join. Surface `not-
      // applicable` so the caller falls back to the existing
      // `extractImageString` / public-image path.
      if (!repoLogicalId) return { kind: 'not-applicable' };
      return {
        kind: 'unsupported-join',
        reason: 'one or more Fn::Join elements could not be resolved',
      };
    }
    parts.push(r);
  }

  return { kind: 'resolved', uri: parts.join(delimiter) };
}

/**
 * Walk a tree of intrinsic nodes and return the logical ID of the first
 * `AWS::ECR::Repository` referenced via `Ref` or `Fn::GetAtt`. Used to
 * detect whether a `Fn::Join` Image shape is an ECR image URI (and so
 * needs Tier 2 / `--from-state` resolution).
 */
function findEcrRepositoryRefInTree(
  node: unknown,
  resources: Record<string, TemplateResource>
): string | undefined {
  if (node === null || node === undefined) return undefined;
  if (typeof node === 'string' || typeof node === 'number' || typeof node === 'boolean') {
    return undefined;
  }
  if (Array.isArray(node)) {
    for (const item of node) {
      const hit = findEcrRepositoryRefInTree(item, resources);
      if (hit) return hit;
    }
    return undefined;
  }
  if (typeof node !== 'object') return undefined;
  const obj = node as Record<string, unknown>;

  if (typeof obj['Ref'] === 'string') {
    const target = obj['Ref'];
    if (resources[target]?.Type === 'AWS::ECR::Repository') return target;
    return undefined;
  }

  const getAtt = obj['Fn::GetAtt'];
  if (getAtt !== undefined) {
    let lid: string | undefined;
    if (Array.isArray(getAtt) && typeof getAtt[0] === 'string') lid = getAtt[0];
    else if (typeof getAtt === 'string') lid = getAtt.split('.')[0];
    if (lid && resources[lid]?.Type === 'AWS::ECR::Repository') return lid;
    return undefined;
  }

  for (const value of Object.values(obj)) {
    const hit = findEcrRepositoryRefInTree(value, resources);
    if (hit) return hit;
  }
  return undefined;
}

/**
 * Generic recursive resolver for the intrinsic-function subset needed to
 * construct an ECR image URI from a `Fn::Join` tree. Handles:
 *
 *   - literal strings / numbers / booleans (returned as their string form)
 *   - `Ref: AWS::URLSuffix` / `AWS::Partition` / `AWS::Region` /
 *     `AWS::AccountId` against `context.pseudoParameters`
 *   - `Ref: <ECRRepoLogicalId>` against `context.stateResources` →
 *     `physicalId`
 *   - `Fn::GetAtt: [<ECRRepoLogicalId>, 'Arn'|'RepositoryUri']` against
 *     `context.stateResources.attributes`
 *   - `Fn::Split: [delimiter, str]` (where `str` resolves to a string)
 *   - `Fn::Select: [index, list]` (where `list` resolves to an array)
 *   - `Fn::Join: [delimiter, [elements]]` (recursive — each element
 *     resolved via this function)
 *
 * Returns `undefined` when any sub-resolution fails so the caller can
 * route the outer Fn::Join to `unsupported-join`. Deliberately tight
 * scope — `Fn::If` / `Fn::FindInMap` / etc. are out of scope here; this
 * is a minimal resolver for ECR Image URI construction, not a general-
 * purpose deploy-time resolver.
 *
 * `Fn::Split` returns an array, `Fn::GetAtt: [Repo, Arn]` returns a
 * string the calling `Fn::Split` then walks. To support both shapes
 * without two separate functions, the helper carries an internal
 * "expected shape" along: `Fn::Split` calls `resolveAsString`, `Fn::
 * Select` over a string calls `resolveAsList`, etc. — see the per-arm
 * spots below.
 */
function resolveImageIntrinsic(
  node: unknown,
  resources: Record<string, TemplateResource>,
  context: EcsImageResolutionContext | undefined
): string | undefined {
  const v = resolveImageIntrinsicAny(node, resources, context);
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return undefined;
}

/**
 * Same resolver as `resolveImageIntrinsic` but returns the raw resolved
 * value (string / number / boolean / array of strings). Used by
 * `Fn::Select` over a `Fn::Split` (which produces a string[]).
 */
function resolveImageIntrinsicAny(
  node: unknown,
  resources: Record<string, TemplateResource>,
  context: EcsImageResolutionContext | undefined
): string | number | boolean | string[] | undefined {
  if (node === null || node === undefined) return undefined;
  if (typeof node === 'string' || typeof node === 'number' || typeof node === 'boolean') {
    return node;
  }
  if (Array.isArray(node)) {
    // A bare array isn't a valid intrinsic at this layer.
    return undefined;
  }
  if (typeof node !== 'object') return undefined;
  const obj = node as Record<string, unknown>;
  const keys = Object.keys(obj);
  if (keys.length !== 1) return undefined;
  const intrinsic = keys[0]!;
  const arg = obj[intrinsic];

  if (intrinsic === 'Ref') {
    if (typeof arg !== 'string') return undefined;
    if (arg.startsWith('AWS::')) {
      const p = context?.pseudoParameters;
      if (!p) return undefined;
      if (arg === 'AWS::URLSuffix') return p.urlSuffix;
      if (arg === 'AWS::Partition') return p.partition;
      if (arg === 'AWS::Region') return p.region;
      if (arg === 'AWS::AccountId') return p.accountId;
      return undefined;
    }
    const refResource = resources[arg];
    if (refResource?.Type !== 'AWS::ECR::Repository') return undefined;
    const stateEntry = context?.stateResources?.[arg];
    if (!stateEntry) return undefined;
    return stateEntry.physicalId;
  }

  if (intrinsic === 'Fn::GetAtt') {
    let logicalId: string | undefined;
    let attr: string | undefined;
    if (
      Array.isArray(arg) &&
      arg.length === 2 &&
      typeof arg[0] === 'string' &&
      typeof arg[1] === 'string'
    ) {
      logicalId = arg[0];
      attr = arg[1];
    } else if (typeof arg === 'string') {
      const dot = arg.indexOf('.');
      if (dot > 0 && dot < arg.length - 1) {
        logicalId = arg.slice(0, dot);
        attr = arg.slice(dot + 1);
      }
    }
    if (!logicalId || !attr) return undefined;
    if (resources[logicalId]?.Type !== 'AWS::ECR::Repository') return undefined;
    const cached = context?.stateResources?.[logicalId]?.attributes?.[attr];
    if (typeof cached === 'string' && cached.length > 0) return cached;
    return undefined;
  }

  if (intrinsic === 'Fn::Split') {
    if (!Array.isArray(arg) || arg.length !== 2) return undefined;
    const argArr = arg as unknown[];
    const delim = argArr[0];
    if (typeof delim !== 'string') return undefined;
    const src = resolveImageIntrinsicAny(argArr[1], resources, context);
    if (typeof src !== 'string') return undefined;
    return src.split(delim);
  }

  if (intrinsic === 'Fn::Select') {
    if (!Array.isArray(arg) || arg.length !== 2) return undefined;
    const argArr = arg as unknown[];
    const rawIndex = argArr[0];
    let index: number | undefined;
    if (typeof rawIndex === 'number') {
      index = rawIndex;
    } else if (typeof rawIndex === 'string' && /^-?\d+$/.test(rawIndex)) {
      index = Number.parseInt(rawIndex, 10);
    }
    if (index === undefined || !Number.isFinite(index)) return undefined;
    const list = resolveImageIntrinsicAny(argArr[1], resources, context);
    if (Array.isArray(list)) {
      if (index < 0 || index >= list.length) return undefined;
      const picked = list[index];
      if (typeof picked === 'string') return picked;
      return undefined;
    }
    // Some templates pass a literal array of intrinsics directly under
    // Fn::Select. Resolve each element on the fly.
    if (Array.isArray(argArr[1])) {
      const listLiteral = argArr[1] as unknown[];
      if (index < 0 || index >= listLiteral.length) return undefined;
      return resolveImageIntrinsic(listLiteral[index], resources, context);
    }
    return undefined;
  }

  if (intrinsic === 'Fn::Join') {
    if (!Array.isArray(arg) || arg.length !== 2) return undefined;
    const [delim, parts] = arg as [unknown, unknown];
    if (typeof delim !== 'string' || !Array.isArray(parts)) return undefined;
    const resolved: string[] = [];
    for (const part of parts) {
      const r = resolveImageIntrinsic(part, resources, context);
      if (r === undefined) return undefined;
      resolved.push(r);
    }
    return resolved.join(delim);
  }

  if (intrinsic === 'Fn::Sub') {
    // Reuse the existing single-string Fn::Sub substituter, which
    // already handles Tier 1 + Tier 2 + the same-stack ECR Ref shape.
    let template: string | undefined;
    if (typeof arg === 'string') template = arg;
    else if (Array.isArray(arg) && typeof arg[0] === 'string') template = arg[0];
    if (template === undefined) return undefined;
    const out = substituteImagePlaceholders(template, resources, context);
    if (out.includes('${')) return undefined;
    return out;
  }

  return undefined;
}

function parseVolume(raw: unknown, idx: number, taskLogicalId: string): ResolvedEcsVolume {
  if (!raw || typeof raw !== 'object') {
    throw new EcsTaskResolutionError(`Task '${taskLogicalId}' Volumes[${idx}] is not an object.`);
  }
  const v = raw as Record<string, unknown>;
  const name = pickString(v['Name']);
  if (!name) {
    throw new EcsTaskResolutionError(`Task '${taskLogicalId}' Volumes[${idx}] has no Name.`);
  }

  if (v['EFSVolumeConfiguration']) {
    throw new EcsTaskResolutionError(
      `Task '${taskLogicalId}' Volumes[${idx}] '${name}' uses EFSVolumeConfiguration, which cdkd local run-task cannot proxy locally. ` +
        `Workaround: bind-mount a local directory at the same containerPath via Host: { SourcePath: '<local-path>' }, or override at runtime via --env-vars semantics for a Phase 2 follow-up.`
    );
  }
  if (v['FSxWindowsFileServerVolumeConfiguration']) {
    throw new EcsTaskResolutionError(
      `Task '${taskLogicalId}' Volumes[${idx}] '${name}' uses FSxWindowsFileServerVolumeConfiguration, which cdkd local run-task cannot proxy locally.`
    );
  }

  const dockerCfg = v['DockerVolumeConfiguration'];
  if (dockerCfg && typeof dockerCfg === 'object') {
    const d = dockerCfg as Record<string, unknown>;
    const scope = pickString(d['Scope']) === 'shared' ? 'shared' : 'task';
    const cfg: ResolvedEcsVolume['dockerVolumeConfig'] = { scope };
    if (typeof d['Autoprovision'] === 'boolean') cfg.autoprovision = d['Autoprovision'];
    const driver = pickString(d['Driver']);
    if (driver) cfg.driver = driver;
    if (d['DriverOpts'] && typeof d['DriverOpts'] === 'object') {
      const opts: Record<string, string> = {};
      for (const [k, val] of Object.entries(d['DriverOpts'] as Record<string, unknown>)) {
        if (typeof val === 'string') opts[k] = val;
      }
      cfg.driverOpts = opts;
    }
    if (d['Labels'] && typeof d['Labels'] === 'object') {
      const labels: Record<string, string> = {};
      for (const [k, val] of Object.entries(d['Labels'] as Record<string, unknown>)) {
        if (typeof val === 'string') labels[k] = val;
      }
      cfg.labels = labels;
    }
    return { name, kind: 'docker', dockerVolumeConfig: cfg };
  }

  // Host bind mount (or anonymous when SourcePath unset).
  const host = v['Host'];
  if (host && typeof host === 'object') {
    const sourcePath = pickString((host as Record<string, unknown>)['SourcePath']);
    if (sourcePath) {
      const abs = isAbsolute(sourcePath) ? sourcePath : resolve(process.cwd(), sourcePath);
      return { name, kind: 'host', hostPath: abs };
    }
  }
  return { name, kind: 'host' };
}

/**
 * Synth-time placeholder marker used in the account-id segment of an ARN
 * when the role's account cannot be known statically (the role is defined
 * inline as an `AWS::IAM::Role` in the same stack). The CLI replaces this
 * with the live account via STS `GetCallerIdentity` lazily — only when
 * `--assume-task-role` is used in its bare form and the resolved ARN
 * still contains this marker.
 */
export const TASK_ROLE_ACCOUNT_PLACEHOLDER = '${AWS::AccountId}';

/**
 * Resolve a Task / Execution role ARN reference. Accepts a flat string ARN,
 * a `Ref` / `Fn::GetAtt[..., 'Arn']` against an `AWS::IAM::Role` in the
 * same stack. Returns a synth-time placeholder ARN of the shape
 * `arn:aws:iam::${AWS::AccountId}:role/<RoleLogicalId>` when the
 * referenced resource is an inline IAM Role (the account segment is filled
 * in by the CLI lazily via STS). Returns `undefined` when the reference
 * cannot be resolved to an IAM Role (e.g. the logical id is missing,
 * points at some other resource type, or the value is some unsupported
 * intrinsic shape).
 */
function resolveRoleArn(
  value: unknown,
  resources: Record<string, TemplateResource>
): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') return value;
  if (typeof value !== 'object') return undefined;
  const obj = value as Record<string, unknown>;

  let refLogicalId: string | undefined;
  if ('Ref' in obj && typeof obj['Ref'] === 'string') {
    refLogicalId = obj['Ref'];
  } else if ('Fn::GetAtt' in obj) {
    const arg = obj['Fn::GetAtt'];
    if (Array.isArray(arg) && typeof arg[0] === 'string') {
      // Accept `[<LogicalId>, 'Arn']`; other attribute names (rare on IAM
      // Role refs) fall through to undefined since the placeholder we emit
      // is always the role ARN shape.
      const attr = typeof arg[1] === 'string' ? arg[1] : '';
      if (attr === '' || attr === 'Arn') refLogicalId = arg[0];
    }
  }
  if (refLogicalId === undefined) return undefined;

  const role = resources[refLogicalId];
  if (role?.Type !== 'AWS::IAM::Role') return undefined;
  return `arn:aws:iam::${TASK_ROLE_ACCOUNT_PLACEHOLDER}:role/${refLogicalId}`;
}

function pickString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function pickStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: string[] = [];
  for (const v of value) {
    if (typeof v === 'string') out.push(v);
  }
  return out;
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

/**
 * Resolve a `kind: 'cdk-asset'` Image entry back to the on-disk build
 * context recorded in the stack's asset manifest. Surfaces an absolute
 * path to the cdk.out asset directory + the dockerfile name so the
 * runner can hand the pair to `buildDockerImage` directly. Returns
 * `undefined` when the asset isn't in the manifest — the caller hard-
 * errors with a clear "re-synthesize" pointer.
 */
export function buildCdkOutDir(stack: StackInfo): string | undefined {
  if (!stack.assetManifestPath) return undefined;
  return dirname(stack.assetManifestPath);
}

/**
 * Verify that a directory referenced by a docker-volume `Host.SourcePath`
 * actually exists. Surfaced as a warning rather than a hard error so
 * users can bind-mount future-created paths.
 */
export function checkVolumeHostPath(hostPath: string): boolean {
  try {
    return existsSync(hostPath) && statSync(hostPath).isDirectory();
  } catch {
    return false;
  }
}
