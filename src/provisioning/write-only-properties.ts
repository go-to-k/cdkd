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
 * Results are cached per resource type for the process (deploy) lifetime —
 * `cloudformation:DescribeType` is throttled per-account, and the schema
 * cannot change mid-deploy. Failures (missing IAM permission, throttling)
 * are logged as a warning ONCE per type and cached as "no write-only
 * properties" so the caller gracefully falls back to the minimal patch —
 * no regression for callers without the `cloudformation:DescribeType`
 * permission.
 */

import { DescribeTypeCommand } from '@aws-sdk/client-cloudformation';
import { getAwsClients } from '../utils/aws-clients.js';
import { getLogger } from '../utils/logger.js';

/**
 * Per-type cache. The value is the in-flight (or settled) promise so that
 * concurrent updates of the same resource type share a single DescribeType
 * call. The promise never rejects — failures resolve to an empty set.
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
 * empty set (graceful fallback to the minimal patch). Cached per resource
 * type for the process lifetime.
 */
export function getTopLevelWriteOnlyProperties(resourceType: string): Promise<ReadonlySet<string>> {
  let entry = writeOnlyPropertiesCache.get(resourceType);
  if (!entry) {
    entry = fetchTopLevelWriteOnlyProperties(resourceType);
    writeOnlyPropertiesCache.set(resourceType, entry);
  }
  return entry;
}

async function fetchTopLevelWriteOnlyProperties(
  resourceType: string
): Promise<ReadonlySet<string>> {
  const logger = getLogger().child('WriteOnlyProperties');
  try {
    const response = await getAwsClients().cloudFormation.send(
      new DescribeTypeCommand({ Type: 'RESOURCE', TypeName: resourceType })
    );

    const result = new Set<string>();
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
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(
      `Failed to resolve write-only properties for ${resourceType} via ` +
        `cloudformation:DescribeType (${message}). Falling back to a minimal ` +
        `update patch — write-only properties (if any) may be dropped by the ` +
        `Cloud Control read-modify-write update. Grant cloudformation:DescribeType ` +
        `to enable write-only property re-inclusion.`
    );
    return new Set<string>();
  }
}

/**
 * Unescape an RFC 6901 JSON Pointer segment (`~1` -> `/`, `~0` -> `~`).
 */
function unescapeJsonPointerSegment(segment: string): string {
  return segment.replace(/~1/g, '/').replace(/~0/g, '~');
}
