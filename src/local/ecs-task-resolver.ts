import { dirname, isAbsolute, resolve } from 'node:path';
import { existsSync, statSync } from 'node:fs';
import type { StackInfo } from '../synthesis/assembly-reader.js';
import type { TemplateResource } from '../types/resource.js';
import { buildCdkPathIndex, resolveCdkPathToLogicalIds } from '../cli/cdk-path.js';
import { matchStacks } from '../cli/stack-matcher.js';

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
  /** Resolved task role ARN, or the raw intrinsic when unresolvable at synth time. */
  taskRoleArn?: string;
  /** Resolved execution role ARN. cdkd only consults this when surfacing config. */
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
 * Parse a `target` argument into (optional stack pattern, path-or-id).
 * Mirrors `lambda-resolver.parseTarget` exactly — same accepted forms,
 * same single-stack auto-detect rule.
 */
export interface ParsedEcsTarget {
  stackPattern: string | null;
  pathOrId: string;
  isPath: boolean;
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
 */
export function resolveEcsTaskTarget(target: string, stacks: StackInfo[]): ResolvedEcsTask {
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

  return extractTaskDefinitionProperties(stack, logicalId, resource);
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
  resource: TemplateResource
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
    parseContainerDefinition(c, idx, logicalId, resources, stack)
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
  stack: StackInfo
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

  const image = parseContainerImage(c['Image'], name, taskLogicalId, resources, stack);

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
 */
function parseContainerImage(
  raw: unknown,
  containerName: string,
  taskLogicalId: string,
  resources: Record<string, TemplateResource>,
  _stack: StackInfo
): ResolvedEcsImage {
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

  // Account-scoped ECR repo.
  const ecrMatch = /^(\d{12})\.dkr\.ecr\.([^.]+)\.amazonaws\.com(?:\.cn)?\//.exec(flat);
  if (ecrMatch) {
    return { kind: 'ecr', uri: flat, account: ecrMatch[1]!, region: ecrMatch[2]! };
  }

  // A ref to a same-stack ECR repository (Fn::Sub embeds it). We can't
  // resolve the repo URI without state; surface a clearer error than
  // letting the runner try to `docker pull` a placeholder.
  if (flat.includes('${') && flat.includes('AWS::AccountId')) {
    throw new EcsTaskResolutionError(
      `Container '${containerName}' in task '${taskLogicalId}' has an Image that references AWS pseudo parameters (${flat}). ` +
        'cdkd local run-task v1 cannot resolve account-scoped ECR repos at synth time. ' +
        'Build the image locally (CDK ContainerImage.fromAsset) or pin to a public image to test locally.'
    );
  }
  // A Ref / GetAtt to a same-stack ECR::Repository that we cannot resolve
  // statically. Match against the resources map to surface a precise hint.
  for (const [refLogicalId, res] of Object.entries(resources)) {
    if (res.Type === 'AWS::ECR::Repository' && flat.includes(refLogicalId)) {
      throw new EcsTaskResolutionError(
        `Container '${containerName}' in task '${taskLogicalId}' references same-stack ECR repository '${refLogicalId}'. ` +
          'cdkd local run-task v1 cannot resolve the repository URI without state — build via ContainerImage.fromAsset or pin a public image.'
      );
    }
  }

  return { kind: 'public', uri: flat };
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
 * Resolve a Task / Execution role ARN reference. Accepts a flat string ARN,
 * a `Ref` / `Fn::GetAtt[..., 'Arn']` against an `AWS::IAM::Role` in the
 * same stack (no state load needed — we surface the synth-time placeholder
 * when the value is intrinsic, so `--assume-task-role` can later route off
 * the explicit ARN the user passes).
 */
function resolveRoleArn(
  value: unknown,
  resources: Record<string, TemplateResource>
): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') return value;
  if (typeof value !== 'object') return undefined;
  const obj = value as Record<string, unknown>;

  if ('Ref' in obj && typeof obj['Ref'] === 'string') {
    const refLogicalId = obj['Ref'];
    const role = resources[refLogicalId];
    if (role?.Type === 'AWS::IAM::Role') {
      // No state to resolve against — return undefined so caller surfaces
      // a clear "no resolvable task role" message. The user passes the
      // ARN explicitly via `--assume-task-role <arn>`.
      return undefined;
    }
  }
  if ('Fn::GetAtt' in obj) {
    const arg = obj['Fn::GetAtt'];
    if (Array.isArray(arg) && typeof arg[0] === 'string') {
      const refLogicalId = arg[0];
      const role = resources[refLogicalId];
      if (role?.Type === 'AWS::IAM::Role') {
        return undefined;
      }
    }
  }
  return undefined;
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
