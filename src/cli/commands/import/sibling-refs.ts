import { cfnRefValueFromPhysicalId } from '../../../deployment/intrinsic-resolver/ref-values.js';
import type { TemplateResource } from '../../../types/resource.js';
import type { ImportRow } from './types.js';

/**
 * Feeding one resource's import to the next (go-to-k/cdkd#6662).
 *
 * `import-one.ts` substitutes a `{Ref: <X>}` in the properties a provider's
 * `import()` receives only when `X` has a physical id in hand. Before this,
 * that was the `--resource` / CloudFormation overrides alone, so a resource
 * that names its parent by `Ref` — a Route 53 record's `HostedZoneId` — got
 * the raw intrinsic even when the parent was adopted earlier in the SAME run,
 * and could neither be found in auto mode nor verified under an override.
 *
 * {@link dispatchInRefOrder} runs the import loop that way: {@link inRefOrder}
 * dispatches a `Ref` target before the resources naming it (template order
 * otherwise), and {@link adoptedRefValue} is the value a later row's `Ref`
 * takes from an adopted one.
 */

/** The logical ids a value names through `{Ref: <X>}`, at any depth. */
function refTargets(value: unknown, out: Set<string>): void {
  if (Array.isArray(value)) {
    for (const v of value) refTargets(v, out);
    return;
  }
  if (typeof value !== 'object' || value === null) return;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj);
  if (keys.length === 1 && keys[0] === 'Ref' && typeof obj['Ref'] === 'string') {
    out.add(obj['Ref']);
    return;
  }
  for (const v of Object.values(obj)) refTargets(v, out);
}

/**
 * `resources` with every `Ref` target among them placed before the resources
 * naming it, template order otherwise kept. A cycle (which no deployable
 * template has) is broken at the resource reached first, in template order.
 */
export function inRefOrder<T extends { logicalId: string; resource: TemplateResource }>(
  resources: readonly T[]
): T[] {
  const byId = new Map(resources.map((r) => [r.logicalId, r]));
  const ordered: T[] = [];
  const state = new Map<string, 'visiting' | 'done'>();
  const visit = (entry: T): void => {
    if (state.has(entry.logicalId)) return;
    state.set(entry.logicalId, 'visiting');
    const targets = new Set<string>();
    refTargets(entry.resource.Properties, targets);
    for (const id of targets) {
      const target = byId.get(id);
      if (target && id !== entry.logicalId) visit(target);
    }
    state.set(entry.logicalId, 'done');
    ordered.push(entry);
  };
  for (const entry of resources) visit(entry);
  return ordered;
}

/**
 * The value CloudFormation's `Ref` returns for a row this run adopted, or
 * `undefined` when there is none to give: a row that was not imported, or a
 * type whose `Ref` needs recorded state the import has not written yet.
 */
export function adoptedRefValue(row: ImportRow): string | undefined {
  if (row.outcome !== 'imported' || typeof row.physicalId !== 'string' || !row.physicalId) {
    return undefined;
  }
  // A type whose `Ref` is a recorded value rather than a segment of its id
  // reads it from the attributes the provider just returned, as the deploy
  // resolver reads them from state.
  const attributes = row.attributes ?? {};
  const fromAttributes = (keys: readonly string[]): string | undefined => {
    for (const key of keys) {
      const value = attributes[key];
      if (typeof value === 'string' && value !== '') return value;
    }
    return undefined;
  };
  try {
    const value = cfnRefValueFromPhysicalId(row.resourceType, row.physicalId, fromAttributes);
    return value === '' ? undefined : value;
  } catch {
    return undefined;
  }
}

/**
 * Import every resource with `importRow`, `Ref` targets first. `importRow`
 * receives the substitution map for that row: the overrides, plus the `Ref`
 * value of each resource adopted before it that no override names (an
 * override keeps precedence). Rows come back in TEMPLATE order, as the plan
 * and `--record-resource-mapping` print them.
 */
export async function dispatchInRefOrder<
  T extends { logicalId: string; resource: TemplateResource },
>(
  resources: readonly T[],
  overrides: ReadonlyMap<string, string>,
  importRow: (entry: T, refValues: Map<string, string>) => Promise<ImportRow>
): Promise<ImportRow[]> {
  const refValues = new Map(overrides);
  const rows: ImportRow[] = [];
  for (const entry of inRefOrder(resources)) {
    const row = await importRow(entry, refValues);
    rows.push(row);
    const refValue = overrides.has(entry.logicalId) ? undefined : adoptedRefValue(row);
    if (refValue !== undefined) refValues.set(entry.logicalId, refValue);
  }
  const templateIndex = new Map(resources.map(({ logicalId }, i) => [logicalId, i]));
  return rows.sort(
    (a, b) => (templateIndex.get(a.logicalId) ?? 0) - (templateIndex.get(b.logicalId) ?? 0)
  );
}
