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
 * Caching semantics match {@link ./write-only-properties.ts} (the sibling
 * DescribeType-backed resolver): only SUCCESSFUL lookups are cached per
 * resource type for the process (deploy) lifetime — `cloudformation:DescribeType`
 * is throttled per-account and the schema cannot change mid-deploy.
 *
 * A FAILED lookup (missing IAM permission, a throttle outlasting its retries,
 * a 5xx) is logged as a warning and resolves to cdkd's COMMITTED snapshot of
 * the type's create-only paths when it has one (issue #3718,
 * `create-only-snapshot.generated.ts`), else to an empty list — the
 * registry-only classification. The fallback is NOT cached: a later resource
 * of the same type retries the live lookup, and the live answer always wins
 * when it succeeds. Before the snapshot, a failed lookup silently missed every
 * schema-only create-only change for that resource.
 */

import type { DescribeTypeCommandOutput } from '@aws-sdk/client-cloudformation';
import { hasNoRegistrySchema, scheduleDescribeType } from './describe-type.js';
import { BackgroundTaskCancelledError, type ScheduledTask } from '../utils/concurrency-limiter.js';
import { parseCreateOnlyPropertyPointers } from './create-only-paths.js';
import { CREATE_ONLY_PATHS_SNAPSHOT } from './create-only-snapshot.generated.js';
import { describeAwsFailure } from '../utils/aws-failure-text.js';
import { getLogger } from '../utils/logger.js';

/**
 * Per-type cache of SUCCESSFUL lookups only. The value is the in-flight (or
 * settled) promise so concurrent diffs of the same resource type share a
 * single DescribeType call. A failed lookup removes its own entry so a later
 * call retries instead of being permanently poisoned by a transient throttle.
 */
const createOnlyPropertiesCache = new Map<string, Promise<ReadonlyArray<readonly string[]>>>();

/**
 * The scheduling handle of each lookup still IN FLIGHT, so an awaited lookup
 * of a type a prefetch already queued promotes that one call instead of
 * issuing a second one, and a prefetch's `cancel()` can withdraw the calls it
 * started (issue #3718).
 */
const inFlightLookups = new Map<string, InFlightLookup>();

interface InFlightLookup {
  readonly scheduled: ScheduledTask<DescribeTypeCommandOutput>;
  /** Some caller is awaiting the answer (an urgent lookup, or one that joined). */
  awaited: boolean;
}

/**
 * Clear the per-type cache. Test-only helper.
 */
export function clearCreateOnlyPropertiesCache(): void {
  createOnlyPropertiesCache.clear();
  inFlightLookups.clear();
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
 * Never throws: a DescribeType failure logs a warning and resolves to the
 * committed snapshot's paths for the type, or to an empty list for a type
 * with no snapshot (graceful fallback to the registry-only classification).
 * Only SUCCESSFUL lookups are cached per resource type for the process
 * lifetime; a failed lookup is NOT cached, so a later call for the same type
 * retries DescribeType (a transient throttle must not pin the deploy to the
 * snapshot).
 *
 * The call is an URGENT DescribeType: it waits only behind other urgent ones,
 * never behind a queued {@link prefetchCreateOnlyPropertyPaths}, and awaiting
 * a type a prefetch already queued promotes that queued call.
 */
export function getCreateOnlyPropertyPaths(
  resourceType: string
): Promise<ReadonlyArray<readonly string[]>> {
  return lookupCreateOnlyPropertyPaths(resourceType, false);
}

/** What {@link prefetchCreateOnlyPropertyPaths} returns. */
export interface CreateOnlyPrefetch {
  /**
   * Withdraw every call THIS prefetch started that nobody has awaited yet: a
   * queued one is dropped and a running one aborted, caching nothing and
   * warning nothing. A call an awaited lookup has since joined is promoted and
   * so left alone, as is every call another prefetch started. Idempotent.
   */
  cancel(): void;
}

/**
 * Warm the cache for each of `resourceTypes` without waiting (issue #1180),
 * as BACKGROUND DescribeType calls behind every awaited lookup (issue #3718).
 * Duplicates and schema-less types are skipped; it never throws and never
 * leaves an unhandled rejection.
 *
 * The prefetch is purely opportunistic, so its owner MUST `cancel()` it when
 * the work it was warming for is done: an unfinished background lookup (a
 * throttle backoff can run to ~15 s) must never delay a command's completion.
 * The handle is per call, so a nested-stack child engine cancelling its own
 * prefetch cannot withdraw its parent's.
 */
export function prefetchCreateOnlyPropertyPaths(
  resourceTypes: Iterable<string>
): CreateOnlyPrefetch {
  const started: Array<[string, InFlightLookup]> = [];
  for (const type of new Set(resourceTypes)) {
    if (hasNoRegistrySchema(type) || createOnlyPropertiesCache.has(type)) continue;
    // lookupCreateOnlyPropertyPaths never rejects, but a fire-and-forget
    // call must not be the one place an unexpected rejection goes unhandled.
    void lookupCreateOnlyPropertyPaths(type, true).catch(() => {});
    const lookup = inFlightLookups.get(type);
    if (lookup) started.push([type, lookup]);
  }
  return {
    cancel: () => {
      // Newest first: the calls still QUEUED are the later ones, and
      // withdrawing a running call frees a slot, which would otherwise start
      // the next queued call of this same prefetch before it is withdrawn.
      for (const [type, lookup] of started.splice(0).reverse()) {
        if (inFlightLookups.get(type) !== lookup || !lookup.scheduled.cancel()) continue;
        // Dropped synchronously, so a lookup arriving after the cancel starts
        // a fresh call instead of joining the withdrawn one.
        inFlightLookups.delete(type);
        createOnlyPropertiesCache.delete(type);
      }
    },
  };
}

/**
 * The distinct resource types of a template's `Resources`, for
 * {@link prefetchCreateOnlyPropertyPaths}. Tolerates a missing or malformed
 * section (the prefetch must never be the thing that throws).
 */
export function templateResourceTypes(resources: unknown): string[] {
  if (resources === null || typeof resources !== 'object') return [];
  const types = new Set<string>();
  for (const resource of Object.values(resources as Record<string, unknown>)) {
    if (resource === null || typeof resource !== 'object') continue;
    const type = (resource as { Type?: unknown }).Type;
    if (typeof type === 'string') types.add(type);
  }
  return [...types];
}

function lookupCreateOnlyPropertyPaths(
  resourceType: string,
  background: boolean
): Promise<ReadonlyArray<readonly string[]>> {
  // Schema-less types (custom resources + the `AWS::CDK::Metadata` synth
  // sentinel) have no CloudFormation registry entry, so the lookup would
  // ALWAYS fail — wasting an API call and emitting a misleading "grant
  // cloudformation:DescribeType" warning on every diff/deploy (issue #1016
  // for custom resources; the same class for the CDK metadata pseudo-
  // resource, which the deploy-start prefetch fed in on EVERY deploy).
  // Replacement semantics for custom resources are handler-driven (the
  // handler returns a new PhysicalResourceId on UPDATE) and the metadata
  // sentinel is never provisioned at all, so an empty createOnly list is
  // the correct answer for both.
  if (hasNoRegistrySchema(resourceType)) {
    return Promise.resolve([]);
  }
  const cached = createOnlyPropertiesCache.get(resourceType);
  if (cached) {
    // Promoting also makes a running prefetch call uncancellable: this
    // caller is now awaiting it.
    const inFlight = inFlightLookups.get(resourceType);
    if (!background && inFlight) {
      inFlight.awaited = true;
      inFlight.scheduled.promote();
    }
    return cached;
  }
  const scheduled = scheduleDescribeType(resourceType, { background });
  const lookup: InFlightLookup = { scheduled, awaited: !background };
  inFlightLookups.set(resourceType, lookup);
  const entry: Promise<ReadonlyArray<readonly string[]>> = scheduled.promise
    .then((response) => parseCreateOnlyResponse(resourceType, response.Schema))
    .catch((error: unknown) => {
      // A withdrawn prefetch is not a failure: its owner no longer needs the
      // answer, and `cancel()` already dropped it from the cache.
      if (error instanceof BackgroundTaskCancelledError) return [];
      // The lookup failed: drop the in-flight entry so a later call retries
      // live, warn (once per failure), and fall back for this call.
      if (createOnlyPropertiesCache.get(resourceType) === entry) {
        createOnlyPropertiesCache.delete(resourceType);
      }
      // A failure nobody awaited logs at debug only: the fallback is not
      // cached, so the diff's own lookup retries and warns once, and a
      // no-permission run must not print one warning per prefetched type.
      return fallBackToSnapshot(resourceType, error, lookup.awaited);
    })
    .finally(() => {
      if (inFlightLookups.get(resourceType) === lookup) {
        inFlightLookups.delete(resourceType);
      }
    });
  createOnlyPropertiesCache.set(resourceType, entry);
  return entry;
}

function fallBackToSnapshot(
  resourceType: string,
  error: unknown,
  awaited: boolean
): ReadonlyArray<readonly string[]> {
  const message = describeAwsFailure(error).detail;
  const child = getLogger().child('CreateOnlyProperties');
  const logger = { warn: (line: string) => (awaited ? child.warn(line) : child.debug(line)) };
  const snapshot = CREATE_ONLY_PATHS_SNAPSHOT.get(resourceType);
  if (snapshot) {
    logger.warn(
      `Failed to resolve create-only properties for ${resourceType} via ` +
        `cloudformation:DescribeType (${message}). Falling back to cdkd's bundled schema ` +
        `snapshot for this resource — it can lag AWS's current schema, so a property AWS ` +
        `has since made updatable may be classified as a replacement. Grant ` +
        `cloudformation:DescribeType to use the live schema.`
    );
    return snapshot;
  }
  logger.warn(
    `Failed to resolve create-only properties for ${resourceType} via ` +
      `cloudformation:DescribeType (${message}). Falling back to the registry-only ` +
      `replacement classification for this resource — an immutable-property change ` +
      `may be mis-classified as an in-place update. Grant cloudformation:DescribeType ` +
      `to enable schema-driven replacement detection.`
  );
  return [];
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
 * Parse a DescribeType response's schema into create-only paths.
 *
 * A response without a Schema (e.g. a still-registering / private type, or a
 * type with no CFn registry schema) carries no createOnlyProperties to
 * extract; treat it as "none" without a warning — it is a successful,
 * cacheable lookup, not a failure. A Schema that is not JSON THROWS, which the
 * caller handles as a failed lookup.
 */
function parseCreateOnlyResponse(
  resourceType: string,
  schema: string | undefined
): ReadonlyArray<readonly string[]> {
  const result = schema
    ? parseCreateOnlyPropertyPointers(
        (JSON.parse(schema) as { createOnlyProperties?: unknown }).createOnlyProperties
      )
    : [];
  getLogger()
    .child('CreateOnlyProperties')
    .debug(
      `Resolved ${result.length} create-only property paths for ${resourceType}` +
        (result.length > 0 ? `: ${result.map((p) => p.join('.')).join(', ')}` : '')
    );
  return result;
}
