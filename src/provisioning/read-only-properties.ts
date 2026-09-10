/**
 * Read-only property resolution for `CloudControlProvider.import()` (issue
 * [#2847](https://github.com/go-to-k/cdkd/issues/2847)) — the read-side sibling
 * of {@link file://./write-only-properties.ts}, sharing its `DescribeType` +
 * per-type cache + top-level reduction, and differing from it in exactly one
 * way that is the point of the module: it distinguishes "this type declares no
 * read-only properties" from "cdkd could not find out".
 *
 * WHY THE DISTINCTION IS LOAD-BEARING. The write-only caller degrades SAFELY to
 * the empty set (a smaller UPDATE patch). This caller does not: its empty set
 * would mean "surface no attributes", while its `undefined` means "cdkd cannot
 * tell an attribute from a property for this type". Collapsing the two into one
 * `Set` — which is what the write-only sibling's signature does — makes a
 * missing `cloudformation:DescribeType` permission indistinguishable from a
 * type with no attributes, and the CALLER's fail-closed arm then cannot be
 * written at all. So the return type is `ReadonlySet<string> | undefined` and
 * the failure is the `undefined`.
 *
 * WHAT `readOnlyProperties` MEANS HERE. In the CloudFormation registry schema a
 * type's `readOnlyProperties` are exactly the values `Fn::GetAtt` may read —
 * that is the definition CloudFormation itself applies, and it is why the
 * narrowing this module enables is a CORRECTNESS fix as much as a security one.
 * Cloud Control's `GetResource` returns the whole resource MODEL, whose keys are
 * every readable property, writable ones included; a `Fn::GetAtt` naming one of
 * those is rejected by CloudFormation at template validation, so nothing cdkd
 * drops here was ever a legitimate attribute.
 *
 * TOP-LEVEL REDUCTION, deliberately the same convention as the write-only
 * sibling: a nested pointer `/properties/Endpoint/Address` reduces to
 * `Endpoint`, so the whole containing property is kept. Keeping the container is
 * what makes the resolver's nested-path walk (`Endpoint.Address`, issue #381)
 * keep working; reducing to the leaf instead would drop the object the walk
 * descends into.
 *
 * CACHING matches the sibling exactly and for the same reason: only SUCCESSFUL
 * lookups are cached for the process lifetime, so a transient throttle on the
 * first imported resource of a type cannot poison every later one. A schema-less
 * response is a SUCCESSFUL lookup of an empty set, not a failure — a type AWS
 * publishes with no `readOnlyProperties` genuinely has no attributes.
 */

import { describeTypeWithThrottleRetry, hasNoRegistrySchema } from './describe-type.js';
import { getLogger } from '../utils/logger.js';

/**
 * Per-type cache of SUCCESSFUL lookups only, holding the in-flight promise so
 * concurrent imports of the same type share one `DescribeType` call. A failed
 * lookup removes its own entry so a later call retries.
 */
const readOnlyPropertiesCache = new Map<string, Promise<ReadonlySet<string>>>();

/** Clear the per-type cache. Test-only helper. */
export function clearReadOnlyPropertiesCache(): void {
  readOnlyPropertiesCache.clear();
}

/**
 * Resolve the TOP-LEVEL read-only (i.e. `Fn::GetAtt`-able) property names for a
 * resource type.
 *
 * Returns `undefined` when the schema could not be resolved — a missing
 * `cloudformation:DescribeType` permission, an exhausted throttle retry, or a
 * type with no registry entry at all. Callers MUST treat `undefined` as "cannot
 * certify" rather than as "none": the two are different answers and this
 * function is the only place that can still tell them apart.
 *
 * Never throws.
 */
export function getTopLevelReadOnlyProperties(
  resourceType: string
): Promise<ReadonlySet<string> | undefined> {
  // A type with no registry entry (`Custom::*`, the `AWS::CDK::Metadata`
  // sentinel) can only produce a failed DescribeType plus a misleading "grant
  // cloudformation:DescribeType" warning, so it short-circuits — but to
  // `undefined`, NOT to the empty set the write-only sibling returns here. The
  // sibling's answer is "this type has no write-only properties", which is true
  // for a schema-less type. The answer THIS function would be giving is "this
  // type has no attributes", which is not: cdkd simply has no schema to read.
  if (hasNoRegistrySchema(resourceType)) {
    return Promise.resolve(undefined);
  }
  const cached = readOnlyPropertiesCache.get(resourceType);
  if (cached) {
    return cached;
  }
  const entry = fetchTopLevelReadOnlyProperties(resourceType);
  readOnlyPropertiesCache.set(resourceType, entry);
  return entry.catch((error) => {
    // Drop the in-flight entry so a later call retries, then report the
    // FAILURE as `undefined`. The `.catch` deliberately sits OUTSIDE what was
    // stored in the cache: caching the recovered promise would cache the
    // failure, which is the poisoning the sibling module's header argues
    // against.
    readOnlyPropertiesCache.delete(resourceType);
    const message = error instanceof Error ? error.message : String(error);
    getLogger()
      .child('ReadOnlyProperties')
      .debug(
        `Failed to resolve read-only properties for ${resourceType} via ` +
          `cloudformation:DescribeType (${message}).`
      );
    return undefined;
  });
}

/**
 * Fetch + parse the type's read-only properties. THROWS on a DescribeType
 * failure — the caller catches, reports `undefined`, and declines to cache.
 */
async function fetchTopLevelReadOnlyProperties(resourceType: string): Promise<ReadonlySet<string>> {
  const logger = getLogger().child('ReadOnlyProperties');
  const response = await describeTypeWithThrottleRetry(resourceType);

  const result = new Set<string>();
  // A response carrying no Schema is a SUCCESSFUL lookup of "no attributes" —
  // the same reading the write-only sibling applies to the same shape.
  if (response.Schema) {
    const parsed = JSON.parse(response.Schema) as { readOnlyProperties?: unknown };
    const readOnly = parsed.readOnlyProperties;
    if (Array.isArray(readOnly)) {
      for (const path of readOnly) {
        if (typeof path !== 'string') continue;
        // Schema entries are JSON pointers like "/properties/Foo" or nested
        // "/properties/Foo/Bar" — keep only the top-level containing property.
        const match = /^\/properties\/([^/]+)/.exec(path);
        if (match?.[1]) {
          result.add(unescapeJsonPointerSegment(match[1]));
        }
      }
    }
  }

  logger.debug(
    `Resolved ${result.size} top-level read-only properties for ${resourceType}` +
      (result.size > 0 ? `: ${[...result].join(', ')}` : '')
  );
  return result;
}

/** Unescape an RFC 6901 JSON Pointer segment (`~1` -> `/`, `~0` -> `~`). */
function unescapeJsonPointerSegment(segment: string): string {
  return segment.replace(/~1/g, '/').replace(/~0/g, '~');
}
