/**
 * Leaf helpers of the `UPDATE` arm (`provisionUpdate`), split out of
 * `deploy-engine/update.ts` (go-to-k/cdkd#5835).
 */
import { type DeployEngine } from '../../deploy-engine.js';
import { extractAllDependencies } from '../record-shape.js';
import type { CloudFormationTemplate } from '../../../types/resource.js';
import { type ResourceState } from '../../../types/state.js';
import { keyOrderFreeJson } from '../../deploy-value-equality.js';
import {
  SECRET_MASK,
  maskAtCoordinates,
  isSingleDynamicReferenceToken,
  recordLogOnlyValue,
  maskSecretsInText,
  type RecordedSecretValues,
} from '../../secret-redaction.js';

/**
 * Is `value` the mask at every leaf (a scalar `***`, or a list / object of
 * nothing but masks, as `maskWholeValue` writes a list parameter)?
 */
export function isWhollyMask(value: unknown): boolean {
  if (value === SECRET_MASK) return true;
  if (Array.isArray(value)) return value.length > 0 && value.every(isWhollyMask);
  if (value !== null && typeof value === 'object') {
    const children = Object.values(value as Record<string, unknown>);
    return children.length > 0 && children.every(isWhollyMask);
  }
  return false;
}

/** A copy of `bag` with the leaf at `coordinate` set to `value` (containers copied on the path). */
export function setAtCoordinate(
  bag: Record<string, unknown>,
  coordinate: readonly (string | number)[],
  value: unknown
): Record<string, unknown> {
  const write = (node: unknown, depth: number): unknown => {
    if (depth === coordinate.length) return value;
    const segment = coordinate[depth]!;
    if (Array.isArray(node) && typeof segment === 'number') {
      const copy = [...node];
      copy[segment] = write(node[segment], depth + 1);
      return copy;
    }
    if (node !== null && typeof node === 'object' && typeof segment === 'string') {
      const record = node as Record<string, unknown>;
      return { ...record, [segment]: write(record[segment], depth + 1) };
    }
    return node;
  };
  return write(bag, 0) as Record<string, unknown>;
}

/**
 * The printed form of every string and number leaf of `value`, at any depth.
 * A boolean is left out: `true` would mask every line saying it.
 */
export function scalarLeavesOf(value: unknown, into: Set<string> = new Set()): Set<string> {
  if (typeof value === 'string') into.add(value);
  else if (typeof value === 'number') into.add(String(value));
  else if (Array.isArray(value)) for (const item of value) scalarLeavesOf(item, into);
  else if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) scalarLeavesOf(item, into);
  }
  return into;
}

/**
 * Records each scalar leaf of `stored` (a pre-v11 record's stored plaintext at
 * a `NoEcho` position its migration witness found different,
 * go-to-k/cdkd#4741) as a LOG-ONLY needle of the print-only `registry`, except
 * the mask itself and any leaf the desired side holds in the clear at the same
 * coordinate: a shape-moved list or object is compared whole, and its other
 * leaves (`EMAIL`, a threshold) are not the secret. There (`shapeMoved`) a
 * `"true"` / `"false"` string is skipped too, like a boolean: a sibling flag
 * would mask every line saying it. A whole-leaf position records it, being
 * the value itself.
 */
export function recordPreviousNoEchoLeaves(
  registry: RecordedSecretValues,
  stored: unknown,
  desiredLeaves: ReadonlySet<string>,
  resolution: RecordedSecretValues,
  shapeMoved: boolean
): void {
  for (const leaf of scalarLeavesOf(stored)) {
    if (leaf === SECRET_MASK || desiredLeaves.has(leaf)) continue;
    if (shapeMoved && (leaf === 'true' || leaf === 'false')) continue;
    recordLogOnlyValue(registry, leaf);
    // A site masking with the resolution bag alone (a provider's capability,
    // a delete error) runs first and can cut a secret embedded in the leaf,
    // leaving a text the whole-leaf needle no longer matches: that spelling
    // is recorded too.
    const partlyMasked = maskSecretsInText(leaf, resolution);
    if (partlyMasked !== leaf && partlyMasked !== SECRET_MASK) {
      recordLogOnlyValue(registry, partlyMasked);
    }
  }
}

/**
 * Does the record hold a `{{resolve:` reference EMBEDDED in a longer string,
 * in its properties or attributes: the shape a pre-go-to-k/cdkd#4810 deploy
 * left for a reader's copy of a physical id. A whole-token leaf is a literal
 * reference, never such a copy, so it costs no lookup. Not narrowed further:
 * a copy can sit after any text (`s3://` and a short id), and the resolver
 * caches each reference's lookup.
 */
export function recordHoldsEmbeddedReference(record: {
  properties?: unknown;
  attributes?: unknown;
}): boolean {
  const walk = (node: unknown): boolean => {
    if (typeof node === 'string') {
      return node.includes('{{resolve:') && !isSingleDynamicReferenceToken(node);
    }
    if (node === null || typeof node !== 'object') return false;
    return Object.values(node as Record<string, unknown>).some(walk);
  };
  return walk(record.properties) || walk(record.attributes);
}

/**
 * The top-level properties of `resolvedProps` in which the redaction rewrote a
 * plaintext into a reference (go-to-k/cdkd#4838). Compared after the same
 * coordinate masking the skip check applies, so a `NoEcho` mask is no rewrite.
 */
export function redactionRewrittenPaths(
  resolvedProps: Record<string, unknown>,
  desiredForSkipCheck: Record<string, unknown>,
  comparisonCoordinates: Parameters<typeof maskAtCoordinates>[1]
): Set<string> {
  const masked = maskAtCoordinates({ ...resolvedProps }, comparisonCoordinates);
  return new Set(
    Object.keys(masked).filter(
      (key) => keyOrderFreeJson(masked[key]) !== keyOrderFreeJson(desiredForSkipCheck[key])
    )
  );
}

/**
 * Does any dependency `extractAllDependencies` reports for `logicalId` (a
 * `Ref`, `Fn::GetAtt`, `Fn::Sub` reference or `DependsOn`) name a resource
 * whose physical id this run changed from the one it loaded
 * (go-to-k/cdkd#4838)? Scoped to THIS run: a reader left stale by an earlier
 * interrupted deploy, a nested child fed by a parameter, or a cross-stack
 * consumer is not seen (go-to-k/cdkd#4852).
 */
export function readsProducerReplacedThisRun(
  engine: DeployEngine,
  template: CloudFormationTemplate | undefined,
  logicalId: string,
  stateResources: Record<string, ResourceState>
): boolean {
  return (extractAllDependencies(template, logicalId) ?? []).some((id) => {
    const loaded = Object.hasOwn(engine.healBaseline, id) ? engine.healBaseline[id] : undefined;
    if (loaded === undefined) return false;
    const now = Object.hasOwn(stateResources, id) ? stateResources[id] : undefined;
    return now !== undefined && now.physicalId !== loaded.physicalId;
  });
}
