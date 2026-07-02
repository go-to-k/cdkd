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
const createOnlyPropertiesCache = new Map<string, Promise<ReadonlyArray<readonly string[]>>>();

/**
 * Clear the per-type cache. Test-only helper.
 */
export function clearCreateOnlyPropertiesCache(): void {
  createOnlyPropertiesCache.clear();
}

/**
 * Resolve the create-only (immutable) property PATHS for a resource type,
 * each as the segment array after `/properties/` (e.g.
 * `['Name']`, `['SourceParameters', 'KinesisStreamParameters',
 * 'StartingPosition']`).
 *
 * Full paths — not top-level reductions — because reducing a NESTED
 * createOnly entry to its top-level container over-approximates: for
 * `AWS::Pipes::Pipe`, `SourceParameters` itself is mutable and only
 * stream-source sub-paths under it are createOnly, so an SQS pipe's
 * `SourceParameters.SqsQueueParameters.BatchSize` change (CFn: "No
 * interruption") was mis-classified as a replacement (issue #960). The diff
 * consults {@link createOnlyChangeRequiresReplacement} to compare at the
 * schema's actual path granularity.
 *
 * Never throws: a DescribeType failure logs a warning and resolves to an empty
 * list (graceful fallback to the registry-only classification). Only SUCCESSFUL
 * lookups are cached per resource type for the process lifetime; a failed
 * lookup is NOT cached, so a later call for the same type retries DescribeType
 * (a transient throttle must not poison the deploy's replacement detection).
 */
export function getCreateOnlyPropertyPaths(
  resourceType: string
): Promise<ReadonlyArray<readonly string[]>> {
  const cached = createOnlyPropertiesCache.get(resourceType);
  if (cached) {
    return cached;
  }
  const entry = fetchCreateOnlyPropertyPaths(resourceType).catch((error) => {
    // The lookup failed: drop the in-flight entry so a later call retries,
    // warn (once per failure), and fall back to an empty list for this call.
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
    return [];
  });
  createOnlyPropertiesCache.set(resourceType, entry);
  return entry;
}

/**
 * Decide whether a change to top-level property `topLevelKey` requires
 * replacement per the schema's createOnly paths.
 *
 * - A length-1 path (`['Name']`) marks the whole property createOnly — any
 *   change replaces (the pre-#960 behavior).
 * - A nested path (`['SourceParameters', ..., 'StartingPosition']`) replaces
 *   ONLY when the value AT that nested path differs between old and new —
 *   sibling sub-properties stay in-place-updatable, matching CloudFormation's
 *   per-path "Update requires: Replacement" annotations.
 * - A path that cannot be resolved against the values (an array or scalar
 *   where an object was expected, or a `*` wildcard segment) is treated
 *   conservatively as changed — replacement — since we cannot prove the
 *   immutable part stayed equal.
 *
 * Pure and synchronous so it is unit-testable without the DescribeType
 * plumbing; `valuesEqual` is injected by the diff calculator so nested
 * comparisons use the same equality as the top-level diff.
 */
export function createOnlyChangeRequiresReplacement(
  createOnlyPaths: ReadonlyArray<readonly string[]>,
  topLevelKey: string,
  oldValue: unknown,
  newValue: unknown,
  valuesEqual: (a: unknown, b: unknown) => boolean
): boolean {
  for (const path of createOnlyPaths) {
    if (path[0] !== topLevelKey) continue;
    if (path.length === 1) return true;

    const oldSub = valueAtPath(oldValue, path.slice(1));
    const newSub = valueAtPath(newValue, path.slice(1));
    if (!oldSub.resolved || !newSub.resolved) return true; // conservative
    if (!valuesEqual(oldSub.value, newSub.value)) return true;
  }
  return false;
}

/**
 * Walk `value` along `segments` of plain-object keys.
 *
 * An absent container (`undefined` / `null`) RESOLVES to `undefined` — that
 * is the load-bearing case: an SQS pipe has no `DynamoDBStreamParameters`
 * subtree on either side, so its stream-source createOnly paths compare
 * `undefined === undefined` and do not force a replacement. Only shapes we
 * cannot meaningfully traverse (arrays / scalars where an object is
 * expected, `*` wildcard segments) report unresolved, which the caller
 * treats conservatively.
 */
function valueAtPath(
  value: unknown,
  segments: readonly string[]
): { resolved: boolean; value?: unknown } {
  let current: unknown = value;
  for (const segment of segments) {
    if (segment === '*') return { resolved: false };
    if (current === undefined || current === null) return { resolved: true, value: undefined };
    if (typeof current !== 'object' || Array.isArray(current)) return { resolved: false };
    // An unresolved intrinsic ({'Fn::If': ...} / {Ref: ...}) is NOT a plain
    // container — descending into it would compare `undefined === undefined`
    // and let a change slip through IN-PLACE where CloudFormation would
    // replace (the one fails-unsafe direction). Report unresolved so the
    // caller stays conservative.
    if (isIntrinsicShaped(current)) return { resolved: false };
    current = (current as Record<string, unknown>)[segment];
  }
  return { resolved: true, value: current };
}

/**
 * True for a single-key object whose key is `Ref` or `Fn::*` — the shape of
 * an unresolved CloudFormation intrinsic.
 */
function isIntrinsicShaped(value: object): boolean {
  const keys = Object.keys(value);
  return keys.length === 1 && (keys[0] === 'Ref' || keys[0]!.startsWith('Fn::'));
}

/**
 * Fetch + parse the type's create-only property paths. THROWS on a
 * DescribeType failure — the caller ({@link getCreateOnlyPropertyPaths})
 * catches, warns, and declines to cache so the lookup can be retried later.
 */
async function fetchCreateOnlyPropertyPaths(
  resourceType: string
): Promise<ReadonlyArray<readonly string[]>> {
  const logger = getLogger().child('CreateOnlyProperties');
  const response = await getAwsClients().cloudFormation.send(
    new DescribeTypeCommand({ Type: 'RESOURCE', TypeName: resourceType })
  );

  const result: string[][] = [];
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
        // "/properties/Foo/Bar" — keep the FULL segment path so the diff can
        // compare at the schema's actual granularity (issue #960).
        if (!path.startsWith('/properties/')) continue;
        // Empty segments are dropped: a trailing slash degrades to the
        // (more conservative) whole-property path, and no real registry
        // schema names a property literally "" via an RFC 6901 empty
        // segment.
        const segments = path
          .slice('/properties/'.length)
          .split('/')
          .map(unescapeJsonPointerSegment)
          .filter((segment) => segment.length > 0);
        if (segments.length > 0) {
          result.push(segments);
        }
      }
    }
  }

  logger.debug(
    `Resolved ${result.length} create-only property paths for ${resourceType}` +
      (result.length > 0 ? `: ${result.map((p) => p.join('.')).join(', ')}` : '')
  );
  return result;
}

/**
 * Unescape an RFC 6901 JSON Pointer segment (`~1` -> `/`, `~0` -> `~`).
 */
function unescapeJsonPointerSegment(segment: string): string {
  return segment.replace(/~1/g, '/').replace(/~0/g, '~');
}
