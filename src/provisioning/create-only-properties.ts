/**
 * Create-only (immutable) property resolution for replacement detection.
 *
 * CloudFormation marks some properties "Update requires: Replacement" — the
 * resource type's registry schema lists them under `createOnlyProperties`.
 * Changing such a property cannot be an in-place UPDATE; CloudFormation
 * transparently DELETE+CREATEs the resource. cdkd's diff classifier
 * (`ReplacementRulesRegistry`) only knows the ~25 types with a hand-authored
 * rule, so for every other type an immutable-property change was previously
 * mis-classified as an in-place UPDATE (the provider's `update()` then either
 * rejected it with a typed error — at best — or silently dropped it).
 *
 * This module resolves each resource type's `createOnlyProperties` from the
 * CloudFormation registry schema via `cloudformation:DescribeType`, reduced to
 * the TOP-LEVEL containing property names (a nested path like
 * `/properties/Foo/Bar` strips to `Foo`) so the diff's top-level property keys
 * match. The diff calculator consults it as a fallback for any property the
 * registry does not explicitly classify, so a createOnly change on ANY type now
 * correctly drives a replacement.
 *
 * Caching / failure semantics are identical to {@link
 * ./write-only-properties.ts} (the sibling DescribeType-backed resolver): only
 * SUCCESSFUL lookups are cached per resource type for the process (deploy)
 * lifetime — `cloudformation:DescribeType` is throttled per-account and the
 * schema cannot change mid-deploy. A FAILED lookup (missing IAM permission,
 * transient throttle / 5xx) is logged as a warning and resolves to an empty set
 * WITHOUT poisoning the cache, so the caller gracefully falls back to the
 * registry-only classification for THIS resource while a later resource of the
 * same type retries. A caller permanently without `cloudformation:DescribeType`
 * simply keeps the pre-existing registry-only behavior — no regression.
 */

import { DescribeTypeCommand } from '@aws-sdk/client-cloudformation';
import { getAwsClients } from '../utils/aws-clients.js';
import { getLogger } from '../utils/logger.js';

/**
 * Per-type cache of SUCCESSFUL lookups only. The value is the in-flight (or
 * settled) promise so concurrent diffs of the same resource type share a
 * single DescribeType call. A failed lookup removes its own entry so a later
 * call retries instead of being permanently poisoned by a transient throttle.
 */
const createOnlyPropertiesCache = new Map<string, Promise<ReadonlySet<string>>>();

/**
 * Clear the per-type cache. Test-only helper.
 */
export function clearCreateOnlyPropertiesCache(): void {
  createOnlyPropertiesCache.clear();
}

/**
 * Resolve the TOP-LEVEL create-only (immutable) property names for a resource
 * type.
 *
 * Never throws: a DescribeType failure logs a warning and resolves to an empty
 * set (graceful fallback to the registry-only classification). Only SUCCESSFUL
 * lookups are cached per resource type for the process lifetime; a failed
 * lookup is NOT cached, so a later call for the same type retries DescribeType
 * (a transient throttle must not poison the deploy's replacement detection).
 */
export function getTopLevelCreateOnlyProperties(
  resourceType: string
): Promise<ReadonlySet<string>> {
  const cached = createOnlyPropertiesCache.get(resourceType);
  if (cached) {
    return cached;
  }
  const entry = fetchTopLevelCreateOnlyProperties(resourceType).catch((error) => {
    // The lookup failed: drop the in-flight entry so a later call retries,
    // warn (once per failure), and fall back to an empty set for this call.
    createOnlyPropertiesCache.delete(resourceType);
    const message = error instanceof Error ? error.message : String(error);
    getLogger()
      .child('CreateOnlyProperties')
      .warn(
        `Failed to resolve create-only properties for ${resourceType} via ` +
          `cloudformation:DescribeType (${message}). Falling back to the registry-only ` +
          `replacement classification for this resource — an immutable-property change ` +
          `may be mis-classified as an in-place update. Grant cloudformation:DescribeType ` +
          `to enable schema-driven replacement detection.`
      );
    return new Set<string>();
  });
  createOnlyPropertiesCache.set(resourceType, entry);
  return entry;
}

/**
 * Fetch + parse the type's create-only properties. THROWS on a DescribeType
 * failure — the caller ({@link getTopLevelCreateOnlyProperties}) catches,
 * warns, and declines to cache so the lookup can be retried later.
 */
async function fetchTopLevelCreateOnlyProperties(
  resourceType: string
): Promise<ReadonlySet<string>> {
  const logger = getLogger().child('CreateOnlyProperties');
  const response = await getAwsClients().cloudFormation.send(
    new DescribeTypeCommand({ Type: 'RESOURCE', TypeName: resourceType })
  );

  const result = new Set<string>();
  // A response without a Schema (e.g. a still-registering / private type, or a
  // type with no CFn registry schema) carries no createOnlyProperties to
  // extract; treat it as "none" without a warning — it is a successful,
  // cacheable lookup, not a failure.
  if (response.Schema) {
    const parsed = JSON.parse(response.Schema) as { createOnlyProperties?: unknown };
    const createOnly = parsed.createOnlyProperties;
    if (Array.isArray(createOnly)) {
      for (const path of createOnly) {
        if (typeof path !== 'string') continue;
        // Schema entries are JSON pointers like "/properties/Foo" or nested
        // "/properties/Foo/Bar" — keep only the top-level containing property
        // name (the diff compares top-level keys).
        const match = /^\/properties\/([^/]+)/.exec(path);
        if (match?.[1]) {
          result.add(unescapeJsonPointerSegment(match[1]));
        }
      }
    }
  }

  logger.debug(
    `Resolved ${result.size} top-level create-only properties for ${resourceType}` +
      (result.size > 0 ? `: ${[...result].join(', ')}` : '')
  );
  return result;
}

/**
 * Unescape an RFC 6901 JSON Pointer segment (`~1` -> `/`, `~0` -> `~`).
 */
function unescapeJsonPointerSegment(segment: string): string {
  return segment.replace(/~1/g, '/').replace(/~0/g, '~');
}
