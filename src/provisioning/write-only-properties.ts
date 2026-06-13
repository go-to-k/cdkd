/**
 * Write-only property resolution for Cloud Control API updates (issue #809).
 *
 * Cloud Control API applies UPDATE patch documents with read-modify-write
 * semantics: the type's read handler returns the current model, the patch is
 * applied on top, and the result becomes the desired state handed to the
 * update handler. Read handlers cannot return write-only properties, so any
 * write-only property that is not explicitly present in the patch document
 * vanishes from the desired state on every CC-routed UPDATE (e.g.
 * `AWS::ECS::Service` loses `VolumeConfigurations` and the update hard-fails;
 * for other types the loss is silent).
 *
 * This module resolves each resource type's `writeOnlyProperties` from the
 * CloudFormation registry schema via `cloudformation:DescribeType`, reduced
 * to the TOP-LEVEL containing property names (a nested path like
 * `/properties/Foo/Bar` strips to `Foo` — re-adding the whole containing
 * property is sufficient and matches terraform-provider-awscc's approach of
 * clearing write-only attribute paths in the prior state so the patch
 * generator always emits `add` ops for them).
 *
 * Only SUCCESSFUL lookups are cached per resource type for the process
 * (deploy) lifetime — `cloudformation:DescribeType` is throttled per-account,
 * and the schema cannot change mid-deploy. A FAILED lookup (missing IAM
 * permission, transient throttle / 5xx) is logged as a warning and resolves
 * to an empty set WITHOUT poisoning the cache, so the caller gracefully falls
 * back to the minimal patch for THIS update while a later update of the same
 * type retries `DescribeType`. Caching failures would let a single transient
 * throttle on the first CC-routed UPDATE silently disable write-only
 * re-inclusion for every CC-routed type for the rest of the deploy —
 * reintroducing the exact hard-fail this module fixes. No regression for
 * callers permanently without the `cloudformation:DescribeType` permission:
 * each update simply re-warns and re-falls-back.
 */

import { DescribeTypeCommand } from '@aws-sdk/client-cloudformation';
import { getAwsClients } from '../utils/aws-clients.js';
import { getLogger } from '../utils/logger.js';

/**
 * Per-type cache of SUCCESSFUL lookups only. The value is the in-flight (or
 * settled) promise so that concurrent updates of the same resource type share
 * a single DescribeType call. A failed lookup removes its own entry so a
 * later call retries instead of being permanently poisoned by a transient
 * throttle / 5xx.
 */
const writeOnlyPropertiesCache = new Map<string, Promise<ReadonlySet<string>>>();

/**
 * Clear the per-type cache. Test-only helper.
 */
export function clearWriteOnlyPropertiesCache(): void {
  writeOnlyPropertiesCache.clear();
}

/**
 * Resolve the TOP-LEVEL write-only property names for a resource type.
 *
 * Never throws: a DescribeType failure logs a warning and resolves to an
 * empty set (graceful fallback to the minimal patch). Only SUCCESSFUL
 * lookups are cached per resource type for the process lifetime; a failed
 * lookup is NOT cached, so a later call for the same type retries
 * DescribeType (a transient throttle must not poison the deploy).
 */
export function getTopLevelWriteOnlyProperties(resourceType: string): Promise<ReadonlySet<string>> {
  const cached = writeOnlyPropertiesCache.get(resourceType);
  if (cached) {
    return cached;
  }
  const entry = fetchTopLevelWriteOnlyProperties(resourceType).catch((error) => {
    // The lookup failed: drop the in-flight entry so a later call retries,
    // warn (once per failure), and fall back to an empty set for this call.
    writeOnlyPropertiesCache.delete(resourceType);
    const message = error instanceof Error ? error.message : String(error);
    getLogger()
      .child('WriteOnlyProperties')
      .warn(
        `Failed to resolve write-only properties for ${resourceType} via ` +
          `cloudformation:DescribeType (${message}). Falling back to a minimal ` +
          `update patch — write-only properties (if any) may be dropped by the ` +
          `Cloud Control read-modify-write update. Grant cloudformation:DescribeType ` +
          `to enable write-only property re-inclusion.`
      );
    return new Set<string>();
  });
  writeOnlyPropertiesCache.set(resourceType, entry);
  return entry;
}

/**
 * Fetch + parse the type's write-only properties. THROWS on a DescribeType
 * failure — the caller (`getTopLevelWriteOnlyProperties`) catches, warns, and
 * declines to cache so the lookup can be retried later.
 */
async function fetchTopLevelWriteOnlyProperties(
  resourceType: string
): Promise<ReadonlySet<string>> {
  const logger = getLogger().child('WriteOnlyProperties');
  const response = await getAwsClients().cloudFormation.send(
    new DescribeTypeCommand({ Type: 'RESOURCE', TypeName: resourceType })
  );

  const result = new Set<string>();
  // A response without a Schema (e.g. a still-registering / publisher type)
  // carries no writeOnlyProperties to extract; treat it as "none" without a
  // warning — it is a successful, cacheable lookup, not a failure.
  if (response.Schema) {
    const parsed = JSON.parse(response.Schema) as { writeOnlyProperties?: unknown };
    const writeOnly = parsed.writeOnlyProperties;
    if (Array.isArray(writeOnly)) {
      for (const path of writeOnly) {
        if (typeof path !== 'string') continue;
        // Schema entries are JSON pointers like "/properties/Foo" or
        // nested "/properties/Foo/Bar" — keep only the top-level
        // containing property name.
        const match = /^\/properties\/([^/]+)/.exec(path);
        if (match?.[1]) {
          result.add(unescapeJsonPointerSegment(match[1]));
        }
      }
    }
  }

  logger.debug(
    `Resolved ${result.size} top-level write-only properties for ${resourceType}` +
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
