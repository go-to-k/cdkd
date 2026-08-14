/**
 * Drift detection between cdkd state-recorded properties and AWS-current
 * properties.
 *
 * cdkd does not go through CloudFormation, so CFn-style drift detection
 * doesn't apply. Instead, the drift command asks each provider for its
 * `readCurrentState` snapshot and this module compares it against the
 * `properties` field saved in state.
 *
 * Comparison rules:
 *
 *   - Only keys present in **state** are compared. AWS reports many
 *     managed-by-AWS fields (timestamps, generated identifiers, account-
 *     wide defaults, etc.) that cdkd never set; treating those as drift
 *     would fire false positives on every resource. Mirrors the diff
 *     calculator's "keys-only-in-old-side ignored" rule, but applied in
 *     the opposite direction (state is now the authoritative side).
 *   - Nested objects are compared structurally — a property change deep
 *     inside (`VersioningConfiguration.Status`) surfaces with the dotted
 *     path so the CLI output points at exactly the leaf that drifted.
 *   - Arrays compare by element-wise structural equality. Re-ordered or
 *     resized arrays surface as a single drift entry on the parent path
 *     (we do not synthesize per-index drift entries — that's not useful
 *     output).
 */

import {
  canonicalizeIdArraysDeep,
  canonicalizeTagListsDeep,
  canonicalizeUnorderedArraysAtPaths,
  matchesPathPrefix,
} from './drift-normalize.js';

/**
 * A single property-level drift between state and AWS-current.
 *
 * `path` uses dot-notation for nested objects (`A.B.C`); array indices
 * are not appended since whole-array drifts are reported as a single
 * entry on the parent path.
 */
export interface PropertyDrift {
  path: string;
  stateValue: unknown;
  awsValue: unknown;
}

/**
 * Compare cdkd state-recorded properties against AWS-current properties
 * and produce a flat list of property-level drifts.
 *
 * Default key-walk strategy: only descend into keys present in
 * `stateProperties`. Any key in `awsProperties` that does not have a
 * counterpart in state is silently ignored — those are the AWS-managed
 * fields cdkd never set, and surfacing them would fire false-positive
 * drift on every clean run (Lambda's `LastUpdateStatus`, S3's
 * `CreationDate`, etc., even after the wire-layer strip pass).
 *
 * `options.unionWalkObjects: true` flips the strategy to walk the union
 * of `stateValue`'s and `awsValue`'s keys when both sides are plain
 * objects. This is what lets a console-side **key add** to a map-shaped
 * property surface as drift — e.g. `Lambda::Function.Environment.Variables`
 * gaining `EXTRA: 'hacked'` in the AWS console after a deploy that only
 * templated `FOO`. Safe to enable when `stateProperties` is the
 * deploy-time AWS snapshot stored in `ResourceState.observedProperties`
 * (= "what AWS actually had at deploy time", which already includes any
 * AWS-managed defaults — those will match between baseline and current
 * unless they genuinely changed). NOT safe to enable when the baseline is
 * the user-templated `properties` field (the v2 fallback path) — there the
 * baseline is "user intent only" and AWS-side defaults the user did not
 * template would be reported as drift on every run.
 *
 * `options.ignorePaths` is supplied by the provider (via
 * `getDriftUnknownPaths`) for state keys it can never read back from AWS
 * (e.g. Lambda `Code`, Secrets Manager `SecretString`). A path matches when
 * it is exactly equal to the entry, or when the entry is a prefix followed
 * by `.` — so `'Code'` excludes the whole `Code` subtree, and
 * `'VpcConfig.SubnetIds'` excludes only that leaf.
 *
 * `options.unorderedPaths` is supplied by the provider (via
 * `getDriftUnorderedPaths`) for arrays that are semantically UNORDERED sets —
 * of plain strings (FSx `WindowsConfiguration.Aliases`) or of OBJECTS (ELBv2
 * `TargetGroup.Targets`, issue #1620, ordered by a key-order-independent
 * canonical serialization). Those are sorted on BOTH sides before comparison
 * so an AWS-side reorder is not phantom drift. Path matching uses the same
 * prefix rule as `ignorePaths`.
 */
export function calculateResourceDrift(
  stateProperties: Record<string, unknown>,
  awsProperties: Record<string, unknown>,
  options?: {
    ignorePaths?: readonly string[];
    unionWalkObjects?: boolean;
    unorderedPaths?: readonly string[];
  }
): PropertyDrift[] {
  const drifts: PropertyDrift[] = [];
  const ignore = options?.ignorePaths ?? [];
  const union = options?.unionWalkObjects ?? false;
  const unordered = options?.unorderedPaths ?? [];
  // Canonicalize tag lists and AWS resource-id/ARN arrays on BOTH sides before
  // any comparison. AWS does not guarantee element ordering across reads, so a
  // reorder between the deploy-time observedProperties snapshot and a later
  // drift read would otherwise surface as phantom drift (the deepEqual walk
  // below compares arrays positionally). See drift-normalize.ts.
  stateProperties = canonicalizeUnorderedArraysAtPaths(
    canonicalizeIdArraysDeep(canonicalizeTagListsDeep(stateProperties)),
    unordered
  ) as Record<string, unknown>;
  awsProperties = canonicalizeUnorderedArraysAtPaths(
    canonicalizeIdArraysDeep(canonicalizeTagListsDeep(awsProperties)),
    unordered
  ) as Record<string, unknown>;
  // Top-level walk is intentionally state-keys-only even with union mode:
  // the top-level shape is fully described by what `provider.create()`
  // takes, and AWS surfaces a long tail of read-only top-level fields
  // (FunctionArn, RevisionId, ...) that the provider's wire-layer strip
  // doesn't bother filtering. Union-walk only makes sense one level
  // deeper, on map-shaped values (Environment.Variables, etc.).
  for (const key of Object.keys(stateProperties)) {
    if (isIgnoredPath(key, ignore)) continue;
    diffAt(key, stateProperties[key], awsProperties[key], drifts, ignore, union);
  }
  return drifts;
}

/**
 * Top-level keys of an `observedProperties` drift baseline that must NOT be
 * compared: keys the user never declared in the template (`declared` is the
 * state record's `properties` — the template intent) whose captured value was
 * EMPTY (absent container / `null` / `[]` / `{}`) at deploy time.
 *
 * WHY (issue #1498): the observed snapshot is captured per-resource right
 * after THAT resource settles, which is structurally BEFORE dependent sibling
 * resources run. A parent property that a separate resource type materializes
 * later — `AWS::ECS::ClusterCapacityProviderAssociations` populating
 * `Cluster.CapacityProviders`, `AWS::AutoScaling::LifecycleHook` populating
 * the ASG's `LifecycleHookSpecificationList`, standalone
 * `AWS::EC2::SecurityGroupIngress` rules populating the group's ingress list —
 * is therefore captured empty and later populated, producing PERMANENT
 * phantom drift on a fresh, untouched stack. Worse, `drift --revert` then
 * strips that sibling-managed configuration from AWS. AWS services author the
 * same shape asynchronously (ECS attaches the `AmazonECSManaged` tag + its
 * managed draining hook when a capacity provider binds an ASG).
 *
 * CloudFormation's drift detection only compares property values explicitly
 * set in the template, so none of this class fires there. Skipping exactly
 * the "undeclared AND captured-empty" keys restores that parity for the
 * phantom class while keeping the observed baseline's extra power: an
 * undeclared key captured with a REAL value (an AWS-side default such as a
 * cluster setting) is still compared, so a console-side change to it still
 * surfaces as drift.
 *
 * Returned keys are fed into `calculateResourceDrift`'s `ignorePaths`, so
 * they are excluded as whole subtrees from detection — and therefore from
 * `--revert` / `--accept`, which operate on the detected changes.
 */
export function undeclaredEmptyObservedKeys(
  observed: Record<string, unknown>,
  declared: Record<string, unknown>
): string[] {
  const keys: string[] = [];
  for (const key of Object.keys(observed)) {
    if (key in declared) continue;
    const value = observed[key];
    const isEmptyContainer =
      value === null ||
      value === undefined ||
      (Array.isArray(value) && value.length === 0) ||
      (isPlainObject(value) && Object.keys(value).length === 0);
    if (isEmptyContainer) keys.push(key);
  }
  return keys;
}

/**
 * Thin alias over the shared {@link matchesPathPrefix} rule, kept as a named
 * function because "ignored" is what the path list means at these call sites.
 * Sharing the implementation with `getDriftUnorderedPaths` is deliberate: both
 * lists are provider-declared and documented as reading the same way, so they
 * must not be able to drift apart.
 */
function isIgnoredPath(path: string, ignorePaths: readonly string[]): boolean {
  return matchesPathPrefix(path, ignorePaths);
}

/**
 * Recursive worker. Pushes drift entries into `out` rather than
 * returning them so nested calls share a single accumulator and the
 * common case of "no drift" allocates nothing.
 */
function diffAt(
  path: string,
  stateValue: unknown,
  awsValue: unknown,
  out: PropertyDrift[],
  ignorePaths: readonly string[],
  unionWalkObjects: boolean
): void {
  if (deepEqual(stateValue, awsValue)) return;

  // A state leaf holding an unresolved `{{resolve:...}}` dynamic reference (GHSA
  // fix: cdkd persists the expression, not the resolved secret) cannot be
  // compared against the AWS readback, which returns the resolved plaintext (or
  // nothing, for a write-only secret). Comparing would report permanent phantom
  // drift on every secret-bearing property, and `--revert` would then write the
  // expression string back to AWS as a literal. Skip it.
  if (typeof stateValue === 'string' && stateValue.includes('{{resolve:')) return;

  if (
    isPlainObject(stateValue) &&
    isPlainObject(awsValue) &&
    !Array.isArray(stateValue) &&
    !Array.isArray(awsValue)
  ) {
    // Recurse into nested object. With unionWalkObjects on, walk the
    // union of state + aws keys so console-side key additions to a
    // map-shaped property (e.g. Lambda Environment.Variables) surface as
    // drift; without it, only state's keys are walked (preserves the
    // pre-unionWalkObjects behavior for the v2-state-fallback baseline).
    const keys = unionWalkObjects
      ? new Set([...Object.keys(stateValue), ...Object.keys(awsValue)])
      : Object.keys(stateValue);
    for (const key of keys) {
      const childPath = `${path}.${key}`;
      if (isIgnoredPath(childPath, ignorePaths)) continue;
      diffAt(childPath, stateValue[key], awsValue[key], out, ignorePaths, unionWalkObjects);
    }
    return;
  }

  out.push({ path, stateValue, awsValue });
}

/**
 * Structural equality used by the drift comparator. Identical to a
 * plain `JSON.stringify`-roundtrip equality except it tolerates
 * undefined-vs-missing-key gaps the same way (both serialize away).
 */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || a === undefined || b === undefined) {
    return a === b;
  }
  if (typeof a !== typeof b) return false;
  if (typeof a !== 'object') return false;

  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }

  const aObj = a as Record<string, unknown>;
  const bObj = b as Record<string, unknown>;
  const aKeys = Object.keys(aObj);
  const bKeys = Object.keys(bObj);
  if (aKeys.length !== bKeys.length) return false;
  for (const key of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(bObj, key)) return false;
    if (!deepEqual(aObj[key], bObj[key])) return false;
  }
  return true;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
