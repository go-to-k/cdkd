import { dirname, isAbsolute, resolve } from 'node:path';
import { existsSync, statSync } from 'node:fs';
import type { StackInfo } from '../synthesis/assembly-reader.js';
import type { TemplateResource } from '../types/resource.js';
import { buildCdkPathIndex, resolveCdkPathToLogicalIds } from '../cli/cdk-path.js';
import { matchStacks } from '../cli/stack-matcher.js';
import {
  substituteImagePlaceholders,
  tryResolveImageFnJoin,
  type ImageResolutionContext,
} from './intrinsic-image.js';
import { substituteAgainstState, type SubstitutionContext } from './state-resolver.js';

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
  /**
   * Non-fatal warnings produced while parsing this container — typically
   * intrinsic-valued env vars or secret ValueFrom entries that could not
   * be substituted against state. The CLI prints these so the user
   * understands why an expected env / secret is missing.
   */
  warnings: string[];
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
/**
 * Substitution context for ECS resolution. Re-exported alias for the
 * shared `ImageResolutionContext` in `intrinsic-image.ts` (extracted
 * in issue #286 Gap 2 when `lambda-resolver.ts` needed the same
 * resolver). The shared type carries `pseudoParameters` (Tier 1) +
 * `stateResources` (Tier 2). `stateResources` is consumed by:
 *   - Image (PR #267): `${<LogicalId>}` against an `AWS::ECR::Repository`
 *     and the `Fn::GetAtt: [<Repo>, 'RepositoryUri']` shape.
 *   - Environment / Secrets (issue #291): intrinsic-valued
 *     `Environment[].Value` and `Secrets[].ValueFrom` entries
 *     (`Ref` / `Fn::GetAtt` / `Fn::Sub` / `Fn::Join`) are substituted
 *     via `state-resolver.ts`'s `substituteAgainstState`.
 * Existing consumers (`src/cli/commands/local-run-task.ts`) import the
 * alias; new code should reach for `ImageResolutionContext` directly.
 */
export type EcsImageResolutionContext = ImageResolutionContext;

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
  /**
   * Any container's `Environment[].Value` OR `Secrets[].ValueFrom` is
   * an intrinsic (`Ref` / `Fn::GetAtt` / `Fn::Sub` / `Fn::Join`). Issue
   * #291: without `--from-state` these are silently dropped; with the
   * flag set, cdkd loads state and substitutes them via
   * `state-resolver.ts`.
   */
  needsEnvOrSecretSubstitution: boolean;
}

export function detectEcsImageResolutionNeeds(stack: StackInfo): EcsImageResolutionNeeds {
  const resources = stack.template.Resources ?? {};
  let needsPseudoParameters = false;
  let needsStateResources = false;
  let needsEnvOrSecretSubstitution = false;

  for (const res of Object.values(resources)) {
    if (res.Type !== 'AWS::ECS::TaskDefinition') continue;
    const props = res.Properties ?? {};
    const containers = Array.isArray(props['ContainerDefinitions'])
      ? props['ContainerDefinitions']
      : [];
    for (const c of containers) {
      if (!c || typeof c !== 'object') continue;
      const co = c as Record<string, unknown>;
      const image = co['Image'];
      const need = inspectImageForSubstitutions(image, resources);
      if (need.pseudo) needsPseudoParameters = true;
      if (need.state) needsStateResources = true;
      if (containerHasIntrinsicEnvOrSecret(co)) needsEnvOrSecretSubstitution = true;
    }
  }
  return { needsPseudoParameters, needsStateResources, needsEnvOrSecretSubstitution };
}

/**
 * Returns true when any `Environment[].Value` or `Secrets[].ValueFrom`
 * is an intrinsic (non-literal). Used to gate `--from-state` state
 * loading at the CLI layer — issue #291.
 */
function containerHasIntrinsicEnvOrSecret(c: Record<string, unknown>): boolean {
  const env = c['Environment'];
  if (Array.isArray(env)) {
    for (const entry of env) {
      if (!entry || typeof entry !== 'object') continue;
      const v = (entry as Record<string, unknown>)['Value'];
      if (
        v !== undefined &&
        typeof v !== 'string' &&
        typeof v !== 'number' &&
        typeof v !== 'boolean'
      ) {
        return true;
      }
    }
  }
  const secrets = c['Secrets'];
  if (Array.isArray(secrets)) {
    for (const entry of secrets) {
      if (!entry || typeof entry !== 'object') continue;
      const v = (entry as Record<string, unknown>)['ValueFrom'];
      if (v !== undefined && typeof v !== 'string') return true;
    }
  }
  return false;
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

  // Surface per-container warnings (e.g. dropped intrinsic env vars /
  // secrets) on the task-level `warnings` array so the CLI prints them.
  for (const ctr of containers) {
    for (const w of ctr.warnings) {
      warnings.push(`Container '${ctr.name}': ${w}`);
    }
  }

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

  const subContext = buildSubstitutionContextFromImageContext(context);
  const environment: Record<string, string> = {};
  const droppedEnvKeys: { key: string; reason: string }[] = [];
  if (Array.isArray(c['Environment'])) {
    for (const entry of c['Environment'] as unknown[]) {
      if (!entry || typeof entry !== 'object') continue;
      const e = entry as Record<string, unknown>;
      const key = pickString(e['Name']);
      const value = e['Value'];
      if (!key) continue;
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        environment[key] = String(value);
        continue;
      }
      // Intrinsic-valued entry. With `--from-state` we try to substitute
      // against state + pseudo parameters (closes #291); without it the
      // value is dropped and a warn is surfaced via the task's
      // `warnings` array (matches PR 1 `cdkd local invoke` semantics).
      if (subContext) {
        const sub = substituteAgainstState(value, subContext);
        if (sub.kind === 'literal') {
          environment[key] = String(sub.value);
          continue;
        }
        droppedEnvKeys.push({ key, reason: sub.reason });
      } else {
        droppedEnvKeys.push({
          key,
          reason: 'intrinsic-valued; pass --from-state to substitute against deployed state',
        });
      }
    }
  }

  const secrets: ResolvedEcsContainer['secrets'] = [];
  const droppedSecretKeys: { key: string; reason: string }[] = [];
  if (Array.isArray(c['Secrets'])) {
    for (const entry of c['Secrets'] as unknown[]) {
      if (!entry || typeof entry !== 'object') continue;
      const e = entry as Record<string, unknown>;
      const sName = pickString(e['Name']);
      const valueFromRaw = e['ValueFrom'];
      if (!sName) continue;
      // Literal string ValueFrom (pre-resolved, or fromSecretCompleteArn).
      if (typeof valueFromRaw === 'string' && valueFromRaw.length > 0) {
        secrets.push({ name: sName, valueFrom: valueFromRaw });
        continue;
      }
      // Intrinsic-valued (`Ref` / `Fn::GetAtt` / `Fn::Join` / `Fn::Sub`).
      // With `--from-state` substitute against deployed state + pseudo
      // parameters; without it, drop the secret and warn — the user's
      // workaround is `fromSecretCompleteArn` (literal ARN at synth time).
      if (subContext) {
        const sub = substituteAgainstState(valueFromRaw, subContext);
        if (sub.kind === 'literal' && typeof sub.value === 'string' && sub.value.length > 0) {
          secrets.push({ name: sName, valueFrom: sub.value });
          continue;
        }
        droppedSecretKeys.push({
          key: sName,
          reason: sub.kind === 'literal' ? 'resolved to non-string / empty value' : sub.reason,
        });
      } else {
        droppedSecretKeys.push({
          key: sName,
          reason: 'intrinsic-valued ValueFrom; pass --from-state to resolve the deployed ARN',
        });
      }
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

  const warnings: string[] = [];
  for (const d of droppedEnvKeys) {
    warnings.push(`Environment '${d.key}' dropped: ${d.reason}`);
  }
  for (const d of droppedSecretKeys) {
    warnings.push(`Secret '${d.key}' dropped: ${d.reason}`);
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
    warnings,
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
 * Map the ECS image-resolution context's `stateResources` +
 * `pseudoParameters` into the shape `substituteAgainstState` expects
 * (closes #291). Returns `undefined` when state has not been loaded —
 * the caller falls back to the pre-PR literal-only path.
 */
function buildSubstitutionContextFromImageContext(
  context: EcsImageResolutionContext | undefined
): SubstitutionContext | undefined {
  if (!context?.stateResources) return undefined;
  const subContext: SubstitutionContext = { resources: context.stateResources };
  if (context.pseudoParameters) {
    subContext.pseudoParameters = { ...context.pseudoParameters };
  }
  return subContext;
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

// `tryResolveImageFnJoin` (plus supporting helpers `findEcrRepositoryRefInTree` /
// `resolveImageIntrinsic` / `resolveImageIntrinsicAny`) and the
// `FnJoinResolveOutcome` type were extracted to `intrinsic-image.ts` so
// `lambda-resolver.ts` can reuse them for container Lambdas (`Code.ImageUri`).
// Both call sites import the shared helper at the top of their respective
// resolver. See issue #286 Gap 2 and PR #280 for the original ECS shape.

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
