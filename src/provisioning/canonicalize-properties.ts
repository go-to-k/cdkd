import type { CanonicalizePropertiesFn } from '../analyzer/diff-calculator.js';
import type { ResourceProvider } from '../types/resource.js';
import { getLogger } from '../utils/logger.js';

/** The registry surface this helper needs — narrowed so tests can pass a stub. */
export interface ProviderLookup {
  getProvider(resourceType: string): ResourceProvider | undefined;
}

/**
 * Build the diff-time property normalizer from a provider registry (issue
 * #1591).
 *
 * ONE builder shared by `cdkd deploy` (the engine) and `cdkd diff` (the
 * command), because the two MUST agree: the diff is the preview of the deploy,
 * and a preview that narrows differently from the apply forecasts a change the
 * deploy will never make — which is the same class of bug as the phantom drift
 * this whole issue is about, moved one command over.
 *
 * Best-effort by construction. A type with no registered provider, a provider
 * that does not implement the hook, or a hook that throws all fall back to the
 * properties unchanged — the pre-#1591 behavior. A comparison refinement must
 * never be able to take down a deploy or a diff.
 */
export function makeCanonicalizePropertiesFn(registry: ProviderLookup): CanonicalizePropertiesFn {
  const logger = getLogger().child('canonicalize-properties');
  return (resourceType, properties) => {
    try {
      const provider = registry.getProvider(resourceType);
      return provider?.canonicalizeDesiredProperties?.(resourceType, properties) ?? properties;
    } catch (error) {
      logger.debug(
        `canonicalizeDesiredProperties failed for ${resourceType}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      return properties;
    }
  };
}
