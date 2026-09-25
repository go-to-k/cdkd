import type {
  CanonicalizePropertiesFn,
  CreateOnlyEquivalenceFn,
} from '../analyzer/diff-calculator.js';
import { describeAwsFailure } from '../utils/aws-failure-text.js';
import type { ResourceProvider } from '../types/resource.js';
import { getLogger } from '../utils/logger.js';

/**
 * The registry surface this helper needs — narrowed so tests can pass a stub.
 *
 * `hasProvider` is part of it deliberately: `ProviderRegistry.getProvider`
 * THROWS for an unregistered type rather than returning `undefined`, and every
 * Cloud-Control-routed resource in a stack is unregistered here. Probing first
 * keeps the catch below for real provider bugs instead of it firing twice per
 * CC resource with a misleading "canonicalizeDesiredProperties failed" line.
 */
export interface ProviderLookup {
  hasProvider(resourceType: string): boolean;
  getProvider(resourceType: string): ResourceProvider;
}

/**
 * Build the diff-time property normalizer from a provider registry (issue
 * #1591).
 *
 * ONE builder shared by `cdkd deploy` (the engine) and `cdkd diff` (the
 * command), because the two MUST agree: the diff is the preview of the deploy,
 * and a preview that narrows differently from the apply forecasts a change the
 * deploy will never make — the same class of bug as the phantom drift this
 * issue is about, moved one command over.
 *
 * Best-effort by construction. An unregistered type, a provider without the
 * hook, or a hook that throws all fall back to the properties unchanged — the
 * pre-#1591 behavior. A comparison refinement must never be able to take down
 * a deploy or a diff.
 */
export function makeCanonicalizePropertiesFn(registry: ProviderLookup): CanonicalizePropertiesFn {
  const logger = getLogger().child('canonicalize-properties');
  return (resourceType, properties) => {
    try {
      if (!registry.hasProvider(resourceType)) return properties;
      const provider = registry.getProvider(resourceType);
      return provider.canonicalizeDesiredProperties?.(resourceType, properties) ?? properties;
    } catch (error) {
      logger.debug(
        `canonicalizeDesiredProperties failed for ${resourceType}: ${
          describeAwsFailure(error).detail
        }`
      );
      return properties;
    }
  };
}

/**
 * Build the diff-time createOnly equivalence check from a provider registry
 * (issue #3769). Shared by `cdkd deploy` and `cdkd diff` for the same reason as
 * {@link makeCanonicalizePropertiesFn}: the preview must plan what the apply
 * does.
 *
 * FAILS CLOSED, the opposite of the normalizer above: an unregistered type, a
 * provider without the hook, or a hook that throws all answer `false`, which
 * keeps the schema's replacement. A wrong `true` would update a resource in
 * place that should have been replaced.
 */
export function makeCreateOnlyEquivalenceFn(registry: ProviderLookup): CreateOnlyEquivalenceFn {
  const logger = getLogger().child('canonicalize-properties');
  return (resourceType, key, oldValue, newValue, context) => {
    try {
      if (!registry.hasProvider(resourceType)) return false;
      const provider = registry.getProvider(resourceType);
      return (
        provider.createOnlyValuesEquivalent?.(resourceType, key, oldValue, newValue, context) ===
        true
      );
    } catch (error) {
      logger.debug(
        `createOnlyValuesEquivalent failed for ${resourceType}: ${describeAwsFailure(error).detail}`
      );
      return false;
    }
  };
}
