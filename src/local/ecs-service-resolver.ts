import type { StackInfo } from '../synthesis/assembly-reader.js';
import type { TemplateResource } from '../types/resource.js';
import { buildCdkPathIndex, resolveCdkPathToLogicalIds } from '../cli/cdk-path.js';
import { matchStacks } from '../cli/stack-matcher.js';
import {
  EcsTaskResolutionError,
  parseEcsTarget,
  resolveEcsTaskTarget,
  type EcsImageResolutionContext,
  type ResolvedEcsTask,
} from './ecs-task-resolver.js';

/**
 * Phase 2 of #262 — synthesized `AWS::ECS::Service` resolved against the
 * cloud assembly. Wraps an already-resolved `ResolvedEcsTask` (Phase 1's
 * descriptor) plus the service-specific knobs `cdkd local start-service`
 * needs: `DesiredCount`, `HealthCheckGracePeriodSeconds`, the physical
 * task-definition logical ID (so the runner can name its docker networks
 * after the service rather than only after the task definition), AND
 * (Phase 3 / Issue #460) the Service Connect + ServiceRegistry surfaces
 * so the Cloud Map registry can publish each replica's endpoint for
 * peer discovery via the docker `--add-host` DNS overlay.
 *
 * `LoadBalancers[]` is intentionally NOT surfaced in v1 — local
 * load-balancer emulation is deferred to a follow-up PR per the issue's
 * own PR-split recommendation (see CLAUDE.md "cdkd local start-service"
 * bullet for the deferral list).
 */
/**
 * Resolved `AWS::ECS::Service.ServiceConnectConfiguration` (Phase 3 of #262).
 * Pre-PR cdkd warned and skipped this block; post-PR each entry's
 * `PortName` is matched against the producer TaskDef's
 * `ContainerDefinitions[].PortMappings[].Name` (verified empirically
 * via real `cdk synth` on 2026-05-22 — the CFn field is `PortName`,
 * NOT the design doc's `PortMappingName`) and the resolver surfaces
 * the resulting `(discoveryName, port, clientAliases)` tuples so the
 * Cloud Map registry can publish each replica's endpoint under the
 * configured DNS names.
 */
export interface ResolvedServiceConnect {
  /**
   * Namespace name (e.g. `cdkd-local.local`). CDK 2.x synthesizes
   * `ServiceConnectConfiguration.Namespace` as a literal string (not
   * a Ref / ARN) — verified empirically on 2026-05-22. The literal is
   * matched against the resolved `CloudMapIndex.namespacesByName` at
   * registry-publish time; an unmatched name surfaces as an error
   * before any container starts.
   */
  namespaceName: string;
  /**
   * Per-entry mapping: which port (from the task def) is exposed under
   * which DNS name (the Service Connect ClientAlias), and what the
   * canonical Cloud Map service-discovery name is.
   */
  services: ReadonlyArray<{
    /** The producer container's `PortMappings[].Name`. */
    portName: string;
    /**
     * Resolved containerPort from the matching `PortMappings[]` entry.
     * Falls back to the `ClientAliases[0].Port` when the producer side
     * cannot be resolved (rare — only when the resolver is invoked
     * against a service whose TaskDef hasn't been parsed yet).
     */
    containerPort: number;
    /**
     * The canonical Cloud Map discovery name. cdkd derives this from
     * `ClientAliases[0].DnsName` when the user supplied one; otherwise
     * defaults to the `PortName` so the registry publishes under a
     * meaningful key.
     */
    discoveryName: string;
    /** All ClientAlias entries (each becomes its own `--add-host` alias). */
    clientAliases: ReadonlyArray<{ dnsName?: string; port: number }>;
  }>;
}

/**
 * Resolved `AWS::ECS::Service.ServiceRegistries[]` (Phase 3 of #262).
 * Each entry binds an ECS Service to one `AWS::ServiceDiscovery::Service`
 * — the AWS-side ECS Agent calls `RegisterInstance` on each task launch.
 * Locally, the runner mirrors that behavior into the Cloud Map registry
 * after each replica's main container boots.
 */
export interface ResolvedServiceRegistry {
  /** Logical id of the `AWS::ServiceDiscovery::Service` this binds to. */
  cloudMapServiceLogicalId: string;
  /** Optional container name override (CFn `ContainerName`). */
  containerName?: string;
  /** Optional container port override (CFn `ContainerPort`). */
  containerPort?: number;
}

export interface ResolvedEcsService {
  /** Stack the service belongs to. */
  stack: StackInfo;
  /** Logical id of the AWS::ECS::Service resource. */
  serviceLogicalId: string;
  /** Raw template entry — kept for future feature additions (LB / Service Connect). */
  resource: TemplateResource;
  /**
   * Service name. Falls back to the logical id when the template does
   * not declare `ServiceName` (the AWS-deployed name would be
   * auto-generated; local execution does not need it for anything
   * load-bearing — used only in log lines).
   */
  serviceName: string;
  /** DesiredCount from the template; defaults to 1 when absent. */
  desiredCount: number;
  /**
   * HealthCheckGracePeriodSeconds from the template. AWS defaults to 0
   * when the service has no load balancer, 30s with an ALB attached.
   *
   * **Currently not consumed by the runner.** cdkd's
   * `ecs-service-runner.ts` is exit-code-driven (`docker wait` →
   * `shouldRestart`); there is no health-check polling in v1 because
   * health-check-driven restarts are only meaningful once the local
   * load-balancer emulator lands (see [docs/design/461-awsvpc-decision.md]
   * and the deferred LB scope in CLAUDE.md). The field is parsed,
   * surfaced on `ResolvedEcsService`, and intentionally retained so the
   * follow-up LB emulator PR can use it as the time-from-start before
   * an unhealthy target-group health check counts toward a restart. The
   * value defaults to 30s locally to match the AWS-with-ALB default.
   */
  healthCheckGracePeriodSeconds: number;
  /**
   * The resolved task descriptor (every container / volume / network mode /
   * runtime platform / task-role detail). cdkd reuses this verbatim per
   * replica instance.
   */
  task: ResolvedEcsTask;
  /**
   * Phase 3 of #262 / Issue #460 — `ServiceConnectConfiguration` resolved
   * against the producer TaskDef's PortMappings. `undefined` when the
   * service has no Service Connect block OR has it but `Enabled: false`.
   */
  serviceConnect?: ResolvedServiceConnect;
  /**
   * Phase 3 of #262 / Issue #460 — `ServiceRegistries[]` resolved. Empty
   * array when the service has no Cloud Map registration (the common
   * case for Service-Connect-only or no-discovery services). Each entry
   * names the `AWS::ServiceDiscovery::Service` logical id the runner
   * publishes replica endpoints under.
   */
  serviceRegistries: ReadonlyArray<ResolvedServiceRegistry>;
  /**
   * Resolution warnings (e.g. `awsvpc` → bridge map from the task
   * resolver, or load-balancer fields not honored locally). Non-fatal —
   * the runner still proceeds.
   */
  warnings: string[];
}

/**
 * Walk the synth template to locate an `AWS::ECS::Service` by display
 * path or stack-qualified logical id, resolve its `TaskDefinition`
 * reference, and chain into the existing `resolveEcsTaskTarget` machinery
 * to produce a `ResolvedEcsService` carrying both the service knobs and
 * the underlying task descriptor.
 *
 * Target shape mirrors `cdkd local run-task`: `<Stack>/<DisplayPath>` or
 * `<Stack>:<LogicalId>`; single-stack apps may omit the stack prefix.
 *
 * Optional `context` (same as the task resolver) carries the ECR image
 * substitution data — pseudo parameters (Tier 1) + state-recorded
 * resources (Tier 2). The CLI builds it lazily when the candidate
 * service's task definition actually needs substitution.
 */
export function resolveEcsServiceTarget(
  target: string,
  stacks: StackInfo[],
  context?: EcsImageResolutionContext
): ResolvedEcsService {
  if (stacks.length === 0) {
    throw new EcsTaskResolutionError('No stacks found in the synthesized assembly.');
  }
  const parsed = parseEcsTarget(target);
  const stack = pickStack(parsed, stacks);
  const resources = stack.template.Resources ?? {};

  let serviceLogicalId: string | undefined;
  let serviceResource: TemplateResource | undefined;

  if (parsed.isPath) {
    const index = buildCdkPathIndex(stack.template);
    const resolved = resolveCdkPathToLogicalIds(parsed.pathOrId, index);
    const services = resolved.filter(
      ({ logicalId: l }) => resources[l]?.Type === 'AWS::ECS::Service'
    );
    if (services.length === 0) {
      throw notFoundError(target, stack, resources);
    }
    if (services.length > 1) {
      throw new EcsTaskResolutionError(
        `Target '${target}' matches ${services.length} ECS services in ${stack.stackName}: ` +
          services.map((s) => s.logicalId).join(', ') +
          '. Refine the path or use the stack:LogicalId form.'
      );
    }
    serviceLogicalId = services[0]!.logicalId;
    serviceResource = resources[serviceLogicalId];
  } else {
    serviceResource = resources[parsed.pathOrId];
    if (!serviceResource) throw notFoundError(target, stack, resources);
    serviceLogicalId = parsed.pathOrId;
  }

  if (!serviceLogicalId || !serviceResource) throw notFoundError(target, stack, resources);

  if (serviceResource.Type === 'AWS::ECS::TaskDefinition') {
    throw new EcsTaskResolutionError(
      `Resource '${serviceLogicalId}' in ${stack.stackName} is an ECS TaskDefinition, not a Service. ` +
        'Use `cdkd local run-task` for one-shot tasks; `cdkd local start-service` is Service-only.'
    );
  }
  if (serviceResource.Type !== 'AWS::ECS::Service') {
    throw new EcsTaskResolutionError(
      `Resource '${serviceLogicalId}' in ${stack.stackName} is ${serviceResource.Type}, not an AWS::ECS::Service.`
    );
  }

  return extractServiceProperties(stack, serviceLogicalId, serviceResource, stacks, context);
}

/**
 * Pure-functional extraction from the synth resource. Exposed for unit
 * testing the per-field resolution rules (DesiredCount default, missing
 * TaskDefinition, intrinsic shapes).
 */
export function extractServiceProperties(
  stack: StackInfo,
  serviceLogicalId: string,
  resource: TemplateResource,
  stacks: StackInfo[],
  context?: EcsImageResolutionContext
): ResolvedEcsService {
  const props = (resource.Properties ?? {}) as Record<string, unknown>;
  const warnings: string[] = [];

  const taskDefRef = props['TaskDefinition'];
  if (taskDefRef === undefined || taskDefRef === null) {
    throw new EcsTaskResolutionError(
      `ECS Service '${serviceLogicalId}' in ${stack.stackName} has no TaskDefinition property.`
    );
  }
  const taskDefLogicalId = resolveTaskDefinitionReference(taskDefRef, stack, serviceLogicalId);

  // Chain into the existing task resolver. Reuses every per-container /
  // per-volume / network-mode resolution rule (incl. the `awsvpc` →
  // bridge map warn from #461).
  const task = resolveEcsTaskTarget(`${stack.stackName}:${taskDefLogicalId}`, stacks, context);

  const desiredCount = parseDesiredCount(props['DesiredCount'], serviceLogicalId);
  const healthCheckGracePeriodSeconds = parseHealthCheckGrace(
    props['HealthCheckGracePeriodSeconds'],
    serviceLogicalId
  );
  const serviceName = parseServiceName(props['ServiceName'], serviceLogicalId);

  // Surface deferred-feature warnings so users learn what's NOT
  // emulated locally without reading source.
  if (Array.isArray(props['LoadBalancers']) && (props['LoadBalancers'] as unknown[]).length > 0) {
    warnings.push(
      `ECS Service '${serviceLogicalId}' declares LoadBalancers, but local load-balancer ` +
        'emulation is deferred to a follow-up PR. Containers are NOT registered to a local ' +
        'listener; reach them via their published ports.'
    );
  }

  // Phase 3 of #262 / Issue #460 — Service Connect + ServiceRegistries
  // are now first-class. Parse + surface; the registry/runner layer
  // handles cross-service publish + DNS overlay.
  const serviceConnect = extractServiceConnect(props['ServiceConnectConfiguration'], task);
  const serviceRegistries = extractServiceRegistries(
    props['ServiceRegistries'],
    serviceLogicalId,
    warnings
  );

  const out: ResolvedEcsService = {
    stack,
    serviceLogicalId,
    resource,
    serviceName,
    desiredCount,
    healthCheckGracePeriodSeconds,
    task,
    serviceRegistries,
    warnings,
  };
  if (serviceConnect) out.serviceConnect = serviceConnect;
  return out;
}

/**
 * Parse `ServiceConnectConfiguration` against the producer TaskDef.
 * Returns `undefined` when the block is missing OR `Enabled: false`.
 *
 * Reject conditions (surface as resolver-time errors so the user sees
 * them BEFORE the docker network is created):
 *   - `Namespace` is not a literal string. CDK 2.x always emits a
 *     literal string here (verified 2026-05-22); cross-stack /
 *     intrinsic shapes are out of scope.
 *   - `Services[].PortName` doesn't match any of the TaskDef's
 *     `ContainerDefinitions[].PortMappings[].Name` entries.
 *
 * Note on `clientAliases[]` shape: each ClientAlias can declare a
 * `DnsName` (the bare short-name peers connect to, e.g. `orders`) AND
 * a `Port` (the listening port the alias maps to inside the consumer).
 * cdkd surfaces both verbatim; the registry / `--add-host` overlay
 * publishes each `DnsName` as a bare alias pointing at the same IP as
 * the canonical fqdn.
 */
function extractServiceConnect(
  raw: unknown,
  task: ResolvedEcsTask
): ResolvedServiceConnect | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const cfg = raw as Record<string, unknown>;
  // CFn default for `Enabled` is `true` when ServiceConnectConfiguration
  // is present (CDK always emits `Enabled: true`); honor an explicit
  // `false` as opt-out.
  if (cfg['Enabled'] === false) return undefined;

  const namespaceName = pickServiceConnectNamespace(cfg['Namespace']);
  if (!namespaceName) {
    throw new EcsTaskResolutionError(
      `ServiceConnectConfiguration.Namespace must be a literal string (the Cloud Map ` +
        `namespace name like 'cdkd-local.local'); got ${JSON.stringify(cfg['Namespace'])}. ` +
        'Intrinsic / cross-stack namespace references are not supported in v1.'
    );
  }

  const rawServices = cfg['Services'];
  if (!Array.isArray(rawServices) || rawServices.length === 0) {
    // No `Services[]` is valid in AWS — the task still gets the local
    // Cloud Map DNS resolver but doesn't expose anything itself. cdkd's
    // local emulation treats it the same way (registry publishes
    // nothing, consumer-side `--add-host` still works).
    return { namespaceName, services: [] };
  }

  // Build a `Name → containerPort` index from the producer TaskDef.
  // The lookup is across ALL containers because CDK emits port mapping
  // names without container-scoping them.
  const portByName = new Map<string, number>();
  for (const c of task.containers) {
    for (const pm of c.portMappings) {
      if (pm.name) portByName.set(pm.name, pm.containerPort);
    }
  }

  const services: Array<{
    portName: string;
    containerPort: number;
    discoveryName: string;
    clientAliases: Array<{ dnsName?: string; port: number }>;
  }> = [];
  for (const entry of rawServices) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    const portName = typeof e['PortName'] === 'string' ? e['PortName'] : undefined;
    if (!portName) {
      throw new EcsTaskResolutionError(
        `ServiceConnectConfiguration.Services[] entry has no PortName: ${JSON.stringify(entry)}. ` +
          'Every Service entry must reference a producer-side PortMappings[].Name.'
      );
    }
    const containerPort = portByName.get(portName);
    if (containerPort === undefined) {
      const available = [...portByName.keys()].join(', ') || '(none)';
      throw new EcsTaskResolutionError(
        `ServiceConnectConfiguration.Services[].PortName='${portName}' does not match any ` +
          `PortMappings[].Name on the producer TaskDef (available: ${available}).`
      );
    }
    const clientAliases: { dnsName?: string; port: number }[] = [];
    if (Array.isArray(e['ClientAliases'])) {
      for (const ca of e['ClientAliases'] as unknown[]) {
        if (!ca || typeof ca !== 'object') continue;
        const caObj = ca as Record<string, unknown>;
        const dnsName = typeof caObj['DnsName'] === 'string' ? caObj['DnsName'] : undefined;
        const port = typeof caObj['Port'] === 'number' ? caObj['Port'] : containerPort;
        const aliasEntry: { dnsName?: string; port: number } = { port };
        if (dnsName !== undefined) aliasEntry.dnsName = dnsName;
        clientAliases.push(aliasEntry);
      }
    }
    // `discoveryName` precedence: first ClientAlias with a DnsName, else
    // the PortName. Mirrors how AWS-side Service Connect publishes the
    // service in Cloud Map.
    const aliasWithName = clientAliases.find((c) => c.dnsName !== undefined);
    const discoveryName = aliasWithName?.dnsName ?? portName;
    services.push({ portName, containerPort, discoveryName, clientAliases });
  }

  return { namespaceName, services };
}

/**
 * Parse `ServiceRegistries[]`. Each entry's `RegistryArn` is the
 * canonical `Fn::GetAtt: [<CloudMapServiceLogicalId>, 'Arn']` shape;
 * cdkd surfaces the logical id (the AWS-side ARN is irrelevant
 * locally — the registry is in-process).
 *
 * Issue #544 — entries with a literal-string `RegistryArn` (rare
 * locally — would imply the user bound to an existing Cloud Map
 * service deployed out-of-band) are skipped with a warning, since the
 * in-process registry cannot resolve an external Cloud Map service
 * back to its `(namespace, name)` pair. Pre-fix this was a silent
 * `continue` and the user got no feedback about why the registration
 * didn't show up.
 */
function extractServiceRegistries(
  raw: unknown,
  serviceLogicalId: string,
  warnings: string[]
): ReadonlyArray<ResolvedServiceRegistry> {
  if (!Array.isArray(raw)) return [];
  const out: ResolvedServiceRegistry[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    const registryArn = e['RegistryArn'];
    let cloudMapServiceLogicalId: string | undefined;
    if (typeof registryArn === 'string') {
      // Already a literal ARN (rare locally — would imply the user
      // bound to an existing Cloud Map service deployed out-of-band).
      // We can't resolve it via the in-process registry; warn + skip.
      warnings.push(
        `ECS Service '${serviceLogicalId}' ServiceRegistries[] entry has a literal-string ` +
          `RegistryArn ('${registryArn}'); cdkd cannot resolve external Cloud Map services ` +
          'locally. Skipping this registration; peer services will not discover this endpoint ' +
          'through the in-process registry. Use Fn::GetAtt: [<CloudMapServiceLogicalId>, "Arn"] ' +
          'instead so cdkd can resolve the namespace + service name from the synthesized template.'
      );
      continue;
    }
    if (registryArn && typeof registryArn === 'object' && !Array.isArray(registryArn)) {
      const obj = registryArn as Record<string, unknown>;
      const getAtt = obj['Fn::GetAtt'];
      if (Array.isArray(getAtt) && typeof getAtt[0] === 'string') {
        cloudMapServiceLogicalId = getAtt[0];
      }
    }
    if (!cloudMapServiceLogicalId) continue;
    const reg: ResolvedServiceRegistry = { cloudMapServiceLogicalId };
    if (typeof e['ContainerName'] === 'string') reg.containerName = e['ContainerName'];
    if (typeof e['ContainerPort'] === 'number') reg.containerPort = e['ContainerPort'];
    out.push(reg);
  }
  return out;
}

function pickServiceConnectNamespace(raw: unknown): string | undefined {
  // CDK 2.x synthesizes `ServiceConnectConfiguration.Namespace` as a
  // literal string (verified via real `cdk synth` 2026-05-22).
  // Defensive: accept a `Ref` that points to a literal-only context
  // (rare; would land here only when the user hand-rolled a CfnService).
  if (typeof raw === 'string' && raw.length > 0) return raw;
  return undefined;
}

/**
 * Resolve `Properties.TaskDefinition` to a logical id in the same stack.
 * Accepted shapes — verified against real CDK 2.x `cdk synth` output on
 * 2026-05-22 (per `feedback_verify_cdk_synth_shape_before_resolver.md`):
 *   - `{Ref: '<TaskDefLogicalId>'}` — the CDK-canonical shape emitted by
 *     `new ecs.FargateService({ taskDefinition })`.
 *   - flat string `'<TaskDefLogicalId>'` — accepted defensively but CDK
 *     rarely emits this for cross-resource refs.
 * Other intrinsic shapes (`Fn::ImportValue` / `Fn::GetAtt` / etc.) are
 * rejected — cross-stack task definitions and `Fn::GetAtt` shapes have
 * no clean local resolution and would land here only as user errors.
 */
function resolveTaskDefinitionReference(
  taskDefRef: unknown,
  stack: StackInfo,
  serviceLogicalId: string
): string {
  if (typeof taskDefRef === 'string') {
    return taskDefRef;
  }
  if (taskDefRef && typeof taskDefRef === 'object' && !Array.isArray(taskDefRef)) {
    const obj = taskDefRef as Record<string, unknown>;
    const refValue = obj['Ref'];
    if (typeof refValue === 'string') {
      const resources = stack.template.Resources ?? {};
      const target = resources[refValue];
      if (!target) {
        throw new EcsTaskResolutionError(
          `ECS Service '${serviceLogicalId}' references TaskDefinition '${refValue}' but no ` +
            `such resource exists in ${stack.stackName}.`
        );
      }
      if (target.Type !== 'AWS::ECS::TaskDefinition') {
        throw new EcsTaskResolutionError(
          `ECS Service '${serviceLogicalId}' references '${refValue}' as TaskDefinition but it ` +
            `is of type ${target.Type}, not AWS::ECS::TaskDefinition.`
        );
      }
      return refValue;
    }
  }
  throw new EcsTaskResolutionError(
    `ECS Service '${serviceLogicalId}' has an unsupported TaskDefinition reference shape: ` +
      `${JSON.stringify(taskDefRef)}. cdkd local start-service v1 supports only Ref to a ` +
      'same-stack AWS::ECS::TaskDefinition; cross-stack TaskDefinitions are deferred.'
  );
}

function parseDesiredCount(raw: unknown, serviceLogicalId: string): number {
  if (raw === undefined || raw === null) return 1;
  if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0) {
    return Math.floor(raw);
  }
  if (typeof raw === 'string' && /^\d+$/.test(raw)) {
    return parseInt(raw, 10);
  }
  throw new EcsTaskResolutionError(
    `ECS Service '${serviceLogicalId}' has an unsupported DesiredCount value: ` +
      `${JSON.stringify(raw)}. Must be a non-negative integer.`
  );
}

function parseHealthCheckGrace(raw: unknown, _serviceLogicalId: string): number {
  if (raw === undefined || raw === null) return 30;
  if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0) {
    return Math.floor(raw);
  }
  if (typeof raw === 'string' && /^\d+$/.test(raw)) {
    return parseInt(raw, 10);
  }
  // Intrinsic shapes silently default to 30s — fail-soft because the
  // grace period is local-only behavior tuning, not a correctness
  // boundary.
  return 30;
}

function parseServiceName(raw: unknown, serviceLogicalId: string): string {
  if (typeof raw === 'string' && raw.length > 0) return raw;
  return serviceLogicalId;
}

/**
 * Local copy of the same `pickStack` helper used by the task resolver.
 * Kept in-file rather than exported from `ecs-task-resolver.ts` so future
 * service-specific extensions (e.g. cross-stack service-to-task refs)
 * can diverge without breaking the run-task code path.
 */
function pickStack(
  parsed: { stackPattern: string | null; pathOrId: string },
  stacks: StackInfo[]
): StackInfo {
  if (parsed.stackPattern === null) {
    if (stacks.length === 1) return stacks[0]!;
    throw new EcsTaskResolutionError(
      `Target has no stack prefix, and the assembly contains ${stacks.length} stacks: ` +
        `${stacks.map((s) => s.stackName).join(', ')}. Pass the target as 'Stack/Path' or 'Stack:LogicalId'.`
    );
  }
  const matched = matchStacks(stacks, [parsed.stackPattern]);
  if (matched.length === 0) {
    throw new EcsTaskResolutionError(
      `No stack matches '${parsed.stackPattern}'. Available stacks: ${stacks
        .map((s) => s.stackName)
        .join(', ')}.`
    );
  }
  if (matched.length > 1) {
    throw new EcsTaskResolutionError(
      `Multiple stacks match '${parsed.stackPattern}': ${matched.map((s) => s.stackName).join(', ')}. ` +
        'Refine the pattern.'
    );
  }
  return matched[0]!;
}

function notFoundError(
  target: string,
  stack: StackInfo,
  resources: Record<string, TemplateResource>
): EcsTaskResolutionError {
  const services = Object.entries(resources)
    .filter(([, r]) => r.Type === 'AWS::ECS::Service')
    .map(([id]) => id);
  if (services.length === 0) {
    return new EcsTaskResolutionError(
      `Target '${target}' did not match any resource in ${stack.stackName}, and the stack ` +
        'declares no AWS::ECS::Service resources at all.'
    );
  }
  return new EcsTaskResolutionError(
    `Target '${target}' did not match any ECS Service in ${stack.stackName}. ` +
      `Available services: ${services.join(', ')}.`
  );
}
