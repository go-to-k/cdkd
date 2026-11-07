import { isAbsolute, resolve } from 'node:path';
import { existsSync, statSync } from 'node:fs';
import { EcsTaskResolutionError } from 'cdk-local/internal';
import { substituteAgainstState, type SubstitutionContext } from '../state-resolver.js';
import { pickString } from './pick.js';
import type { ResolvedEcsVolume } from './types.js';

export function parseVolume(
  raw: unknown,
  idx: number,
  taskLogicalId: string,
  subContext?: SubstitutionContext
): ResolvedEcsVolume {
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
  // SourcePath may be a flat string OR a CFn intrinsic (`Fn::Sub` /
  // `Fn::Join` / `Ref`) — CDK emits the intrinsic shape when the user
  // builds the path via `cdk.Fn.sub(...)` / `cdk.Fn.join(...)` (verified
  // via real `cdk synth` against `new ecs.Ec2TaskDefinition({ volumes:
  // [{ name, host: { sourcePath: cdk.Fn.sub('...') } }] })`). When state
  // + pseudo parameters are available (`--from-state` flow on
  // `cdkd local run-task` already populates the context for env / secret
  // / image resolution), we substitute the intrinsic in place via the
  // same `substituteAgainstState` helper. Unresolvable intrinsics
  // hard-error — a Host bind mount with a missing path is not safe to
  // proxy as an anonymous volume (the container would silently see an
  // empty mount instead of the data it expects). Closes Gap 6 of #286.
  const host = v['Host'];
  if (host && typeof host === 'object') {
    const rawSourcePath = (host as Record<string, unknown>)['SourcePath'];
    const sourcePath = resolveVolumeSourcePath(rawSourcePath, name, idx, taskLogicalId, subContext);
    if (sourcePath !== undefined) {
      const abs = isAbsolute(sourcePath) ? sourcePath : resolve(process.cwd(), sourcePath);
      return { name, kind: 'host', hostPath: abs };
    }
  }
  return { name, kind: 'host' };
}

/**
 * Resolve a volume `Host.SourcePath` value to a flat host-path string.
 * Handles flat strings (pre-PR behavior) and the CFn intrinsic shapes
 * (`Fn::Sub` / `Fn::Join` / `Ref` / `Fn::GetAtt`) that CDK emits when
 * the user builds the path via `cdk.Fn.sub(...)` / `cdk.Fn.join(...)`.
 * Returns `undefined` when the field is absent or empty (anonymous
 * volume — the legacy path); throws `EcsTaskResolutionError` when the
 * intrinsic cannot be resolved against the supplied context.
 *
 * The hard-error on unresolvable intrinsics matches the upstream
 * pre-Gap-6 behavior (which silently dropped the SourcePath and produced
 * an anonymous volume) only on the failure mode — but now with a precise
 * actionable message instead of mysteriously empty mounts at runtime.
 */
function resolveVolumeSourcePath(
  raw: unknown,
  volumeName: string,
  idx: number,
  taskLogicalId: string,
  subContext: SubstitutionContext | undefined
): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === 'string') return raw.length > 0 ? raw : undefined;
  if (typeof raw !== 'object') {
    throw new EcsTaskResolutionError(
      `Task '${taskLogicalId}' Volumes[${idx}] '${volumeName}' Host.SourcePath must be a string or a CFn intrinsic, got ${typeof raw}.`
    );
  }
  if (!subContext) {
    throw new EcsTaskResolutionError(
      `Task '${taskLogicalId}' Volumes[${idx}] '${volumeName}' Host.SourcePath is a CFn intrinsic (Ref/Fn::Sub/Fn::Join/Fn::GetAtt). ` +
        `Pass --from-state to substitute it against the deployed state + AWS pseudo parameters.`
    );
  }
  const sub = substituteAgainstState(raw, subContext);
  if (sub.kind === 'literal' && typeof sub.value === 'string' && sub.value.length > 0) {
    return sub.value;
  }
  throw new EcsTaskResolutionError(
    `Task '${taskLogicalId}' Volumes[${idx}] '${volumeName}' Host.SourcePath could not be resolved: ` +
      (sub.kind === 'literal' ? 'resolved to non-string / empty value' : sub.reason)
  );
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
