/**
 * Helpers for cdkd's genuinely-unsupported resource types.
 *
 * The data ({@link NON_PROVISIONABLE_TYPES}) is generated from the
 * provider-coverage audit (`vp run gen:unsupported-types`); this module adds
 * the runtime predicates + the actionable issue link used by the pre-flight
 * check (see {@link ../provisioning/provider-registry.ProviderRegistry.validateResourceTypes}).
 */
import { NON_PROVISIONABLE_TYPES } from './unsupported-types.generated.js';

export { NON_PROVISIONABLE_TYPES };

/**
 * True if AWS reports the type as `ProvisioningType: NON_PROVISIONABLE`
 * (Cloud Control API cannot create/update/delete it) and cdkd has no SDK
 * provider for it.
 */
export function isNonProvisionable(resourceType: string): boolean {
  return NON_PROVISIONABLE_TYPES.has(resourceType);
}

/**
 * A 1-click pre-filled GitHub issue link requesting cdkd support for a
 * resource type. Surfaced in the pre-flight error so a user hitting an
 * unsupported type lands directly in the "request support" flow.
 */
export function unsupportedTypeIssueUrl(resourceType: string): string {
  const title = encodeURIComponent(`Support resource type ${resourceType}`);
  return `https://github.com/go-to-k/cdkd/issues/new?title=${title}&labels=resource-support`;
}
