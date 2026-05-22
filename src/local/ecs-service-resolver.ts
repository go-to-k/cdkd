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
 * needs: `DesiredCount`, `HealthCheckGracePeriodSeconds`, and the
 * physical task-definition logical ID (so the runner can name its
 * docker networks after the service rather than only after the task
 * definition).
 *
 * The `LoadBalancers[]` and `ServiceConnectConfiguration` fields are
 * intentionally NOT surfaced in v1 — local load-balancer emulation +
 * Service Connect / Cloud Map are deferred to follow-up PRs per the
 * issue's own PR-split recommendation (see CLAUDE.md "cdkd local
 * start-service" bullet for the deferral list). They will land here as
 * additional fields when the next PR adds the LB emulator.
 */
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
   * cdkd uses this as the time-from-start before a failing task counts
   * as "unhealthy" and triggers a restart. Defaults to 30s locally.
   */
  healthCheckGracePeriodSeconds: number;
  /**
   * The resolved task descriptor (every container / volume / network mode /
   * runtime platform / task-role detail). cdkd reuses this verbatim per
   * replica instance.
   */
  task: ResolvedEcsTask;
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
  // emulated locally without reading source. Each warning explicitly
  // names the deferred follow-up so users can track when it lands.
  if (Array.isArray(props['LoadBalancers']) && (props['LoadBalancers'] as unknown[]).length > 0) {
    warnings.push(
      `ECS Service '${serviceLogicalId}' declares LoadBalancers, but local load-balancer ` +
        'emulation is deferred to a follow-up PR. Containers are NOT registered to a local ' +
        'listener; reach them via their published ports.'
    );
  }
  if (props['ServiceConnectConfiguration']) {
    warnings.push(
      `ECS Service '${serviceLogicalId}' declares ServiceConnectConfiguration, but Service ` +
        'Connect / Cloud Map emulation is deferred (tracked in #460). Cross-service discovery ' +
        'between locally-run services is not provided.'
    );
  }

  return {
    stack,
    serviceLogicalId,
    resource,
    serviceName,
    desiredCount,
    healthCheckGracePeriodSeconds,
    task,
    warnings,
  };
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
