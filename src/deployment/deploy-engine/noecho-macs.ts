/**
 * go-to-k/cdkd#6146: the engine-side glue of the `NoEcho` value MACs: the
 * provision path's wait for them, the in-place update's sink for a key the
 * provider left unsent, and the carry of a record's MACs to the save.
 */
import type { DeployEngine } from '../deploy-engine.js';
import type { CloudFormationTemplate, UpdateContext } from '../../types/resource.js';
import type { ResourceState } from '../../types/state.js';
import { noEchoParametersReadBy, type NoEchoPositionSources } from '../secret-redaction.js';
import type { BindingFingerprinter } from '../masked-property-fingerprints.js';
import { noEchoMacParametersOf } from '../noecho-value-macs.js';
import { noEchoPositionSources } from './noecho.js';
import { readsOnlyNoEchoParameters } from './update/noecho-macs.js';

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
 * go-to-k/cdkd#6209: the keys of `desiredProps` whose NoEcho value MAC entry
 * may carry an input binding, each with the `NoEcho` parameters its MACs
 * cover: a top-level property that reads a `NoEcho` parameter AND something
 * else (a key reading nothing but `NoEcho` parameters settles without one,
 * and its entry stays as before). Empty for a stack declaring no `NoEcho`
 * parameter, before `sources` is even built: no walk, no resolution, no AWS
 * call. Handed to `inputFingerprinter` as its `coveredFor`, so the binding
 * comes from the same walk as the input fingerprint.
 */
export function noEchoMacCover(
  engine: Pick<DeployEngine, 'noEchoRun'>,
  desiredProps: Record<string, unknown>,
  sources: () => NoEchoPositionSources | undefined
): ReadonlyMap<string, ReadonlySet<string>> {
  const cover = new Map<string, ReadonlySet<string>>();
  if (engine.noEchoRun.noEchoMacs === undefined) return cover;
  const positions = sources();
  if (positions === undefined || positions.parameters.size === 0) return cover;
  for (const key of Object.keys(desiredProps)) {
    const value = desiredProps[key];
    const parameters = noEchoMacParametersOf(value, positions);
    if (parameters.length === 0 || readsOnlyNoEchoParameters(value, positions.parameters)) continue;
    cover.set(key, new Set(parameters));
  }
  return cover;
}

/**
 * go-to-k/cdkd#6209: records (and returns) the input bindings of
 * `logicalId`'s resolution in this deploy: for each key of `cover`
 * ({@link noEchoMacCover}), the input fingerprint it resolves to when every
 * input other than its `NoEcho` parameters was resolved and hashed, read
 * from `fingerprinter`'s memoized walk (`binding`), for a key `stampable`
 * holds only (the input fingerprints the save may stamp: a binding is
 * stamped only beside one, so any other key's walk would be wasted). A walk
 * that throws is no binding. Replaces the logical id's previous entry, so a
 * later resolution never leaves an earlier one's binding behind.
 */
export async function noEchoMacInputBindingsFor(
  engine: Pick<DeployEngine, 'noEchoRun'>,
  logicalId: string,
  cover: ReadonlyMap<string, ReadonlySet<string>>,
  fingerprinter: BindingFingerprinter | undefined,
  stampable: Readonly<Record<string, string>> | undefined
): Promise<ReadonlyMap<string, string>> {
  const bindings = new Map<string, string>();
  engine.noEchoRun.noEchoMacInputBindings.delete(logicalId);
  if (fingerprinter === undefined || stampable === undefined) return bindings;
  for (const key of cover.keys()) {
    if (!Object.hasOwn(stampable, key)) continue;
    const binding = await fingerprinter.binding(key).catch(() => undefined);
    if (binding !== undefined) bindings.set(key, binding);
  }
  if (bindings.size > 0) engine.noEchoRun.noEchoMacInputBindings.set(logicalId, bindings);
  return bindings;
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
