import type { ResourceProvider, ResourceUpdateResult, UpdateContext } from '../types/resource.js';
import { safeMsg } from '../utils/display-safe.js';

/**
 * Clear-on-removal for merge-semantics update APIs (issue #1160 — the
 * absent-field removal silent-drop bug class; reference fix
 * `LambdaFunctionProvider`, #1157).
 *
 * CloudFormation resets a property REMOVED from the template to its default,
 * while most AWS `Update*` / `Modify*` APIs treat an absent input field as
 * "no change" (merge semantics). A provider `update()` that passes template
 * properties straight into the SDK input therefore silently keeps the old
 * live value on removal.
 *
 * Two shapes, one rule ("removed" = the previous TEMPLATE declared it and the
 * desired one does not):
 *
 * - A top-level property whose clear value is a CONSTANT, CFn-shaped and
 *   forwarded verbatim is DECLARED in `ResourceProvider.removalDefaults`; the
 *   update CALLER injects it ({@link prepareRemovalForUpdate}).
 * - Anything else (a coerced, aliased, nested, conditional or SDK-shaped
 *   clear) stays in the provider through {@link clearOnUpdateRemoval}.
 *
 * docs/provider-rules.md#update-removal-semantics-clear-on-removal has the
 * per-field checklist. A leaf (one import-free utility): the deploy engine,
 * the rollback executor and `drift --revert` all reach it.
 */

/**
 * Returns `newValue` when present, the `clearValue` when the field was
 * present before and is now absent (removal), and `undefined` when it was
 * never present (so a genuinely-absent field stays absent = no change).
 */
export function clearOnUpdateRemoval<T>(
  newValue: T | undefined,
  previousValue: T | undefined,
  clearValue: T
): T | undefined {
  if (newValue !== undefined) return newValue;
  if (previousValue !== undefined) return clearValue;
  return undefined;
}

const NONE: readonly string[] = Object.freeze([]);
const NONE_REMOVED: ReadonlySet<string> = new Set();

/**
 * The top-level keys `baseline` declares and `desired` omits — the same
 * presence test {@link clearOnUpdateRemoval} applies per field. O(keys of
 * `baseline`), allocation-free when nothing was removed.
 */
export function removedTemplateKeys(
  baseline: Readonly<Record<string, unknown>>,
  desired: Readonly<Record<string, unknown>>
): readonly string[] {
  // A malformed state record (a string, an array) declares no property.
  if (typeof baseline !== 'object' || baseline === null || Array.isArray(baseline)) return NONE;
  let removed: string[] | undefined;
  for (const key of Object.keys(baseline)) {
    if (baseline[key] !== undefined && desired[key] === undefined) (removed ??= []).push(key);
  }
  return removed ?? NONE;
}

/**
 * A fresh copy of a declared value (JSON-shaped: scalars, arrays, plain
 * objects), so a provider mutating what it is handed cannot touch the shared
 * constant. Cheaper than `structuredClone` by an order of magnitude here.
 */
function copyDeclared(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(copyDeclared);
  if (typeof value !== 'object' || value === null) return value;
  const out: Record<string, unknown> = {};
  for (const [key, member] of Object.entries(value)) out[key] = copyDeclared(member);
  return out;
}

/**
 * `properties` with each `removed` key the declaration names set to its clear
 * value (a fresh copy, so a provider mutating it cannot touch the shared
 * constant). Returns `properties` itself when nothing applies.
 */
function injectDeclared(
  declared: ReadonlyMap<string, unknown> | undefined,
  removed: readonly string[],
  properties: Record<string, unknown>
): Record<string, unknown> {
  if (declared === undefined) return properties;
  let out: Record<string, unknown> | undefined;
  for (const key of removed) {
    if (!declared.has(key)) continue;
    out ??= { ...properties };
    out[key] = copyDeclared(declared.get(key));
  }
  return out ?? properties;
}

/**
 * The update result with every INJECTED key taken back out of its
 * `effectiveProperties`. A provider that records `{ ...properties }` would
 * otherwise persist the reset value the template never declared, and the
 * next deploy would read it as removed again, forever.
 */
export function withoutInjectedRemovals<R extends ResourceUpdateResult>(
  result: R,
  injected: readonly string[]
): R {
  const effective = result.effectiveProperties;
  if (effective === undefined || !injected.some((key) => Object.hasOwn(effective, key))) {
    return result;
  }
  const recorded = { ...effective };
  for (const key of injected) delete recorded[key];
  return { ...result, effectiveProperties: recorded } as R;
}

/** What an update caller hands the provider, and what it must warn about. */
export interface RemovalPreparation {
  /** The desired bag with every declared clear value injected. */
  properties: Record<string, unknown>;
  /** The keys injected; hand them to {@link withoutInjectedRemovals}. */
  injected: readonly string[];
  /** The `UpdateContext` field every caller sets. */
  context: Pick<UpdateContext, 'removedProperties'>;
  /**
   * Removed keys the provider neither resets nor handles itself, on a type
   * whose `update()` was audited into `removalHandledInUpdate`. The caller
   * warns ONE line naming them; any other type, and the Cloud Control route,
   * is never reported, since cdkd cannot say what happens to its removed keys.
   */
  unhandled: readonly string[];
}

/**
 * The update caller's half of the removal contract, computed ONCE per
 * update before any retry loop. `baseline` is the previous TEMPLATE (the
 * state record the caller diffs against), never an AWS readback.
 */
export function prepareRemovalForUpdate(
  provider: ResourceProvider,
  resourceType: string,
  desired: Record<string, unknown>,
  baseline: Readonly<Record<string, unknown>>
): RemovalPreparation {
  const removed = removedTemplateKeys(baseline, desired);
  const context = { removedProperties: removed.length === 0 ? NONE_REMOVED : new Set(removed) };
  if (removed.length === 0) {
    return { properties: desired, injected: NONE, context, unhandled: NONE };
  }
  const declared = provider.removalDefaults?.get(resourceType);
  const handled = provider.removalHandledInUpdate?.get(resourceType);
  const properties = injectDeclared(declared, removed, desired);
  const injected = declared === undefined ? NONE : removed.filter((key) => declared.has(key));
  if (handled === undefined) return { properties, injected, context, unhandled: NONE };
  const unhandled = removed.filter((key) => !declared?.has(key) && !handled.has(key));
  return { properties, injected, context, unhandled };
}

/**
 * The provider's half: inject its own declaration when the caller did not.
 * A caller that ran {@link prepareRemovalForUpdate} sets
 * `context.removedProperties`, and then this returns `properties` untouched;
 * a direct call (a unit test, a provider's internal delegation) gets the same
 * injection from `previousProperties`.
 */
export function withRemovalDefaults(
  declarations: ResourceProvider['removalDefaults'],
  resourceType: string,
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>,
  context: UpdateContext | undefined
): Record<string, unknown> {
  if (context?.removedProperties !== undefined) return properties;
  const declared = declarations?.get(resourceType);
  if (declared === undefined) return properties;
  return injectDeclared(declared, removedTemplateKeys(previousProperties, properties), properties);
}

/**
 * The ONE line an update caller prints for {@link RemovalPreparation.unhandled}.
 * Every value is template-borne, so each is rendered through `safeMsg`. A
 * rollback revert restores an earlier state record, so there the property is
 * one the failed deploy ADDED, and the line says that instead.
 */
export function removalWarning(
  logicalId: string,
  resourceType: string,
  unhandled: readonly string[],
  caller: 'deploy' | 'rollback' = 'deploy'
): string {
  const one = unhandled.length === 1;
  const names = `${one ? 'property' : 'properties'} ${unhandled.join(', ')}`;
  return caller === 'rollback'
    ? safeMsg`${logicalId} (${resourceType}): ${names} ${one ? 'is' : 'are'} absent from the state being restored; the rollback leaves the value the failed deploy applied in place (CloudFormation would reset it to its default).`
    : safeMsg`${logicalId} (${resourceType}): ${names} ${one ? 'was' : 'were'} removed from the template; cdkd leaves the current AWS value in place (CloudFormation would reset it to its default).`;
}
