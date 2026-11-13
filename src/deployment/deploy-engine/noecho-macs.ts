/**
 * go-to-k/cdkd#6146: the engine-side glue of the `NoEcho` value MACs: the
 * provision path's wait for them, the in-place update's sink for a key the
 * provider left unsent, and the carry of a record's MACs to the save.
 */
import type { DeployEngine } from '../deploy-engine.js';
import type { CloudFormationTemplate, UpdateContext } from '../../types/resource.js';
import type { ResourceState } from '../../types/state.js';
import { noEchoParametersReadBy } from '../secret-redaction.js';
import { noEchoPositionSources } from './noecho.js';

// Re-exported so `update-in-place.ts` takes both from one import (file-size cap).
export { noEchoPositionSources };

/**
 * go-to-k/cdkd#6146: wait for the run's `NoEcho` value MACs when `logicalId`'s
 * template properties read a `NoEcho` parameter; a no-op (no KMS call) for any
 * other resource and for a stack declaring none.
 */
export async function awaitNoEchoMacsFor(
  engine: Pick<DeployEngine, 'noEchoRun'>,
  logicalId: string,
  resources: Record<string, ResourceState>,
  template: CloudFormationTemplate | undefined,
  conditions: Record<string, boolean> | undefined
): Promise<void> {
  const macs = engine.noEchoRun.noEchoMacs;
  if (macs === undefined || template === undefined) return;
  const declared = template.Resources;
  if (declared === null || typeof declared !== 'object' || !Object.hasOwn(declared, logicalId)) {
    return;
  }
  const sources = noEchoPositionSources(engine.noEchoRun, resources, template, conditions);
  if (sources === undefined || sources.parameters.size === 0) return;
  if (noEchoParametersReadBy(declared[logicalId]?.Properties ?? {}, sources).length === 0) return;
  await macs.macs();
}

/**
 * The `UpdateContext.keptNoEchoOnlyProperty` sink of `logicalId`'s in-place
 * update: a key of `noEchoOnly` the provider left unsent keeps its previous
 * `NoEcho` value MAC at the save, which still describes what AWS holds. Built
 * right before the provider call, it also records the keys the call is
 * handed (`sent`), whose MACs a failure drops (`dropFailedUpdateMacs`).
 */
export function keptNoEchoMacSink(
  engine: Pick<DeployEngine, 'noEchoRun'>,
  logicalId: string,
  noEchoOnly: ReadonlySet<string>,
  sent?: ReadonlySet<string>
): (propertyName: string) => void {
  if (sent !== undefined) engine.noEchoRun.noEchoMacSent.set(logicalId, new Set(sent));
  return (propertyName) => {
    if (!noEchoOnly.has(propertyName)) return;
    let kept = engine.noEchoRun.noEchoMacKept.get(logicalId);
    if (kept === undefined) {
      kept = new Set<string>();
      engine.noEchoRun.noEchoMacKept.set(logicalId, kept);
    }
    kept.add(propertyName);
  };
}

/**
 * The `NoEcho` fields of an in-place update's `UpdateContext`: the keys named
 * only for an unconfirmed `NoEcho` value, and the sink for one left unsent.
 */
export function noEchoUpdateContext(
  engine: Pick<DeployEngine, 'noEchoRun'>,
  logicalId: string,
  noEchoOnly: ReadonlySet<string>,
  sent: ReadonlySet<string>
): Pick<UpdateContext, 'noEchoOnlyChangedProperties' | 'keptNoEchoOnlyProperty'> {
  return {
    noEchoOnlyChangedProperties: noEchoOnly,
    keptNoEchoOnlyProperty: keptNoEchoMacSink(engine, logicalId, noEchoOnly, sent),
  };
}

/**
 * The finished update's record carry of `current`'s `NoEcho` value MACs to
 * the save, which rebuilds them from this run's and keeps only a key the
 * provider left unsent at its previous entry. A replacement (in `update()` or
 * the update-failure fallback) starts fresh: the new resource was sent every
 * key, so nothing is kept. The update finished, so its handed keys clear.
 */
export function carriedNoEchoMacs(
  engine: Pick<DeployEngine, 'noEchoRun'>,
  logicalId: string,
  current: ResourceState,
  wasReplaced: boolean | undefined
): Pick<ResourceState, 'noEchoValueMacs'> {
  engine.noEchoRun.noEchoMacSent.delete(logicalId);
  if (wasReplaced === true) engine.noEchoRun.noEchoMacKept.delete(logicalId);
  return wasReplaced === true || current.noEchoValueMacs === undefined
    ? {}
    : { noEchoValueMacs: current.noEchoValueMacs };
}

/**
 * The failure save's drop: each record whose update was handed keys and did
 * not finish loses those keys' `NoEcho` value MACs, since AWS may hold the
 * new value or the old one. The next deploy finds no MAC and re-sends.
 */
export function dropFailedUpdateMacs(
  engine: Pick<DeployEngine, 'noEchoRun'>,
  resources: Record<string, ResourceState>,
  only?: string
): void {
  for (const [logicalId, sent] of engine.noEchoRun.noEchoMacSent) {
    if (only !== undefined && logicalId !== only) continue;
    const record = Object.hasOwn(resources, logicalId) ? resources[logicalId] : undefined;
    const macs = record?.noEchoValueMacs;
    if (record === undefined || macs === undefined) continue;
    const left = Object.fromEntries(Object.entries(macs).filter(([key]) => !sent.has(key)));
    const { noEchoValueMacs: _dropped, ...rest } = record;
    resources[logicalId] = (
      Object.keys(left).length > 0 ? { ...rest, noEchoValueMacs: left } : rest
    ) as ResourceState;
  }
}
