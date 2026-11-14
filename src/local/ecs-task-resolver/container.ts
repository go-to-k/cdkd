import { EcsTaskResolutionError } from 'cdk-local/internal';
import type { StackInfo } from '../../synthesis/assembly-reader.js';
import type { TemplateResource } from '../../types/resource.js';
import { defineOwnKey } from '../../utils/own-keys.js';
import { substituteAgainstState, type SubstitutionContext } from '../state-resolver.js';
import { parseContainerImage } from './image.js';
import { pickString, pickStringArray } from './pick.js';
import type {
  ResolvedEcsContainer,
  ResolvedEcsTask,
  EcsImageResolutionContext,
  UnresolvedCommandElement,
} from './types.js';

export function parseContainerDefinition(
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

  const subContext = buildSubstitutionContextFromImageContext(context);
  // An argv element that does not resolve is RECORDED, not dropped: dropping
  // it ran a different command (`--bucket` with no value, go-to-k/cdkd#6271).
  // The CLI refuses the run via `assertEcsTaskCommandsResolved` once the
  // cross-stack post-pass has had its chance at the element.
  const unresolvedCommandElements: UnresolvedCommandElement[] = [];
  const command = resolveArgvArray(
    c['Command'],
    'Command',
    subContext,
    unresolvedCommandElements
  );
  const entryPoint = resolveArgvArray(
    c['EntryPoint'],
    'EntryPoint',
    subContext,
    unresolvedCommandElements
  );
  const workingDirectory = pickString(c['WorkingDirectory']);

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
        // Own-key define (issue #3515): an env var NAMED `__proto__` becomes
        // a key of this `{}` literal, and a plain assignment would run
        // Object.prototype's setter and drop it silently.
        defineOwnKey(environment, key, String(value));
        continue;
      }
      // Intrinsic-valued entry. With `--from-state` we try to substitute
      // against state + pseudo parameters (closes #291); without it the
      // value is dropped and a warn is surfaced via the task's
      // `warnings` array (matches PR 1 `cdkd local invoke` semantics).
      if (subContext) {
        const sub = substituteAgainstState(value, subContext);
        if (sub.kind === 'literal') {
          defineOwnKey(environment, key, String(sub.value));
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
      const portName = typeof p['Name'] === 'string' ? p['Name'] : undefined;
      if (portName !== undefined) pm.name = portName;
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
    const command2 = resolveArgvArray(
      h['Command'],
      'HealthCheck.Command',
      subContext,
      unresolvedCommandElements
    );
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
  if (droppedSecretKeys.length > 0) out.droppedSecretNames = droppedSecretKeys.map((d) => d.key);
  if (unresolvedCommandElements.length > 0) {
    out.unresolvedCommandElements = unresolvedCommandElements;
  }
  return out;
}

/**
 * Resolve a container argv array (`Command` / `EntryPoint` /
 * `HealthCheck.Command`). ECS resolves every element at deploy time, so an
 * intrinsic element is substituted against state as `Environment` is
 * (go-to-k/cdkd#6271). One that cannot be resolved keeps its POSITION as an
 * empty placeholder and is recorded in `unresolved`; the run is refused
 * before any container starts, so the placeholder never reaches docker.
 */
function resolveArgvArray(
  raw: unknown,
  field: UnresolvedCommandElement['field'],
  subContext: SubstitutionContext | undefined,
  unresolved: UnresolvedCommandElement[]
): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  return raw.map((element: unknown, index) => {
    if (typeof element === 'string') return element;
    if (typeof element === 'number' || typeof element === 'boolean') return String(element);
    if (!element || typeof element !== 'object' || Array.isArray(element)) {
      unresolved.push({ field, index, reason: 'not a string or an intrinsic' });
      return '';
    }
    if (!subContext) {
      unresolved.push({
        field,
        index,
        reason:
          'intrinsic-valued; pass --from-state (cdkd-deployed) or --from-cfn-stack (cdk-deployed) to substitute it against deployed state',
      });
      return '';
    }
    const sub = substituteAgainstState(element, subContext);
    if (sub.kind === 'literal') {
      const literal = argvLiteral(sub.value);
      if (literal !== undefined) return literal;
    }
    unresolved.push({
      field,
      index,
      reason: sub.kind === 'literal' ? 'resolved to a non-string value' : sub.reason,
    });
    return '';
  });
}

/**
 * The argv string for a substituted value, or `undefined` when it is not one
 * ECS could pass as an argument. A `{{resolve:...}}` dynamic reference is not
 * resolved on an argv (it would land on the `docker run` command line), so
 * it is refused rather than run as the literal token.
 */
export function argvLiteral(value: unknown): string | undefined {
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value !== 'string') return undefined;
  return value.includes('{{resolve:') ? undefined : value;
}

/**
 * Refuse the run when any container argv element (`Command` / `EntryPoint` /
 * `HealthCheck.Command`) is still unresolved after the sync pass and the
 * cross-stack post-pass: running without it runs a different command than
 * the deployed task (go-to-k/cdkd#6271).
 */
export function assertEcsTaskCommandsResolved(task: ResolvedEcsTask): void {
  const lines: string[] = [];
  for (const container of task.containers) {
    for (const u of container.unresolvedCommandElements ?? []) {
      lines.push(`  - Container '${container.name}' ${u.field}[${u.index}]: ${u.reason}`);
    }
  }
  if (lines.length === 0) return;
  throw new EcsTaskResolutionError(
    `Task '${task.taskDefinitionLogicalId}' has container command elements cdkd could not resolve:\n` +
      `${lines.join('\n')}\n` +
      'cdkd refuses to run the task with these arguments missing, since that runs a different command than the deployed task. ' +
      'Deploy the stack and pass --from-state (cdkd-deployed) or --from-cfn-stack (cdk-deployed) so each element resolves against deployed state.'
  );
}

/**
 * Map the ECS image-resolution context's `stateResources` +
 * `pseudoParameters` into the shape `substituteAgainstState` expects
 * (closes #291). Returns `undefined` when state has not been loaded —
 * the caller falls back to the pre-PR literal-only path.
 */
export function buildSubstitutionContextFromImageContext(
  context: EcsImageResolutionContext | undefined
): SubstitutionContext | undefined {
  if (!context?.stateResources) return undefined;
  const subContext: SubstitutionContext = { resources: context.stateResources };
  if (context.pseudoParameters) {
    subContext.pseudoParameters = { ...context.pseudoParameters };
  }
  return subContext;
}
