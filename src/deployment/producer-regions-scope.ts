import { AsyncLocalStorage } from 'node:async_hooks';
import { canonicalizeRegion } from '../utils/aws-partition.js';

/**
 * The producer regions a stack reads across, as evidence for a rollback
 * replay's cross-region secret refusal (issue #2057), carried from a PARENT
 * stack down to its nested children (go-to-k/cdkd#4174).
 *
 * A child receives a parent's cross-region value only as a Parameter: the
 * parent resolves it, and the child records the parent's region-less
 * `{{resolve:...}}` spelling (`inheritedSecrets`), while its own `imports` /
 * `outputReads` never name the parent's producer region. A child replay that
 * classifies against its own reads alone answers `local` for such a reference
 * and resolves it against a same-named secret in the stack's region.
 */
export interface ProducerRegionEvidence {
  /** The stack's own producer regions, unioned with every ancestor's. */
  readonly regions: readonly string[];
  /**
   * `false` when an ancestor's regions could not be established (a nested
   * child rolled back on its own, or a driver that bound nothing). A replay
   * then refuses every region-less secret reference instead of resolving it
   * locally.
   */
  readonly complete: boolean;
}

/**
 * Bound by the two places a provider call on a nested-stack row can start:
 * the deploy engine around its provisioning (for the child engine it builds)
 * and the rollback executor around a replay (for a child journal replay).
 * `NestedStackProvider` reads it. A getter, so the value is taken when the
 * child needs it: the deploy engine's reads grow while it provisions.
 */
const producerRegionsStore = new AsyncLocalStorage<() => ProducerRegionEvidence>();

export function withProducerRegions<T>(evidence: () => ProducerRegionEvidence, fn: () => T): T {
  return producerRegionsStore.run(evidence, fn);
}

/**
 * The getter bound for the stack whose provider call is in flight, or
 * `undefined` when no binder is on the stack. A reader treats `undefined` as
 * INCOMPLETE evidence, never as "no producer regions".
 */
export function getCurrentProducerRegions(): (() => ProducerRegionEvidence) | undefined {
  return producerRegionsStore.getStore();
}

/**
 * A nested child's evidence: its own regions unioned with the inherited ones,
 * complete only when the inherited evidence is. Deduplicated
 * case-insensitively, keeping each region's first spelling (own first), as
 * `producerRegionsFromState` does.
 */
export function inheritProducerRegions(
  own: readonly string[],
  inherited: ProducerRegionEvidence | undefined
): ProducerRegionEvidence {
  const seen = new Set<string>();
  const regions: string[] = [];
  for (const region of [...own, ...(inherited?.regions ?? [])]) {
    const canonical = canonicalizeRegion(region);
    if (!canonical || seen.has(canonical)) continue;
    seen.add(canonical);
    regions.push(region);
  }
  return { regions, complete: inherited?.complete === true };
}
