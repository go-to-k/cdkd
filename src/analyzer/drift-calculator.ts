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
import { hasPlainPrototype } from '../utils/own-keys.js';

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
  // Compared and DESCENDED in JSON form (issue #3121 follow-up): a `Date` the
  // raw SDK readback carries now survives the canonicalizers by identity, and
  // the persisted baseline holds its ISO string, so without the fold run 2
  // compared `'2026-...'` against a `Date` -- `typeof` mismatch, drift
  // forever. The PUSHED values stay the originals: `--accept` serializes the
  // Date to the same ISO string, and a caller inspecting `awsValue` sees what
  // AWS returned.
  const stateForm = jsonForm(stateValue);
  const awsForm = jsonForm(awsValue);
  if (deepEqual(stateForm, awsForm)) return;

  // FALLBACK for a state leaf whose `{{resolve:...}}` dynamic reference could
  // not be resolved (GHSA fix: cdkd persists the expression, not the resolved
  // secret). An expression cannot be compared against the AWS readback, which
  // returns the resolved plaintext (or nothing, for a write-only secret), so
  // comparing reports phantom drift on every secret-bearing property.
  //
  // This is no longer the mechanism that normally handles a secret-bearing
  // leaf. `cdkd drift` — the only caller of `calculateResourceDrift` — now
  // re-resolves its baseline before comparing (issue #1914), so a resolvable
  // reference arrives here as plaintext on BOTH sides and is compared properly;
  // it was the blanket skip here that made a console edit of such a property
  // undetectable and unrevertible. What still reaches this line is the case
  // that has no better answer: a deleted secret, a rotated-away version, a
  // least-privilege role without `secretsmanager:GetSecretValue`, or a
  // reference spelling cdkd cannot resolve at all. `runDriftForStack` warns
  // per-resource and falls back to the unresolved baseline for exactly those,
  // and this line is what then keeps the resource's other properties comparable
  // instead of drowning them in phantom drift.
  if (typeof stateValue === 'string' && stateValue.includes('{{resolve:')) return;

  if (
    isPlainObject(stateForm) &&
    isPlainObject(awsForm) &&
    !Array.isArray(stateForm) &&
    !Array.isArray(awsForm)
  ) {
    // Recurse into nested object. With unionWalkObjects on, walk the
    // union of state + aws keys so console-side key additions to a
    // map-shaped property (e.g. Lambda Environment.Variables) surface as
    // drift; without it, only state's keys are walked (preserves the
    // pre-unionWalkObjects behavior for the v2-state-fallback baseline).
    const keys = unionWalkObjects
      ? new Set([...Object.keys(stateForm), ...Object.keys(awsForm)])
      : Object.keys(stateForm);
    for (const key of keys) {
      const childPath = `${path}.${key}`;
      if (isIgnoredPath(childPath, ignorePaths)) continue;
      diffAt(childPath, stateForm[key], awsForm[key], out, ignorePaths, unionWalkObjects);
    }
    return;
  }

  out.push({ path, stateValue, awsValue });
}

/**
 * The form `JSON.stringify` would serialize a value as, for the ONE shape the
 * comparator's "JSON-roundtrip equality" contract did not cover: a NON-PLAIN
 * object carrying `toJSON` (a `Date`, which serializes as its ISO string; a
 * `Buffer`, whose prototype `toJSON` yields `{type, data}`). Every other value
 * is returned untouched. What the comparator then does with an untouched
 * non-plain object is what it does with a plain one -- it walks the OWN keys
 * (`deepEqual` below, and `diffAt`'s descend gate, test `typeof === 'object'`
 * and nothing about the prototype) -- so a `Uint8Array` compares by its
 * index keys (the persisted `{"0":1,"1":2}` equals the readback typed array,
 * the convergence this fold exists for) and a keyless `Map` / class instance
 * compares equal to `{}` and to any other keyless one. That last case is
 * PRE-EXISTING and is not what the canonicalizers' identity return protects:
 * they keep a non-plain node from being REBUILT as `{}`, and this fold keeps
 * the JSON-carrying ones from drifting forever against their persisted form;
 * neither adds a prototype guard here, because a bare `hasPlainPrototype`
 * gate would break the typed-array convergence (PR #3148 delta review).
 */
function jsonForm(value: unknown): unknown {
  if (value === null || typeof value !== 'object' || hasPlainPrototype(value)) return value;
  const toJSON = (value as { toJSON?: unknown }).toJSON;
  return typeof toJSON === 'function' ? (toJSON.call(value) as unknown) : value;
}

/**
 * Structural equality used by the drift comparator. Identical to a
 * plain `JSON.stringify`-roundtrip equality except it tolerates
 * undefined-vs-missing-key gaps the same way (both serialize away).
 * `Date`s (and anything else non-plain with `toJSON`) are compared in their
 * JSON form via {@link jsonForm}, so the persisted ISO string of an accepted
 * readback equals the `Date` the next readback returns.
 */
function deepEqual(a: unknown, b: unknown): boolean {
  a = jsonForm(a);
  b = jsonForm(b);
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

/**
 * {@link deepEqual}, except that a `mask` STRING on the state side matches any
 * STRING on the AWS side (issue
 * [#3595](https://github.com/go-to-k/cdkd/issues/3595)).
 *
 * Answers "do these two differ ANYWHERE other than at a masked position?" —
 * the question that separates a baseline cdkd could not certify from real
 * drift beside it. Positional and shape-strict on purpose: an array whose
 * length changed or whose elements AWS reordered is NOT equal, because a mask
 * cannot say which element it stood for, and treating a reorder as equal would
 * hide an edit. Only a string can match a mask, since the redaction masks
 * string leaves alone.
 */
export function equalModuloMask(state: unknown, aws: unknown, mask: string): boolean {
  const a = jsonForm(state);
  const b = jsonForm(aws);
  if (a === mask && typeof b === 'string') return true;
  if (a === b) return true;
  if (a === null || b === null || a === undefined || b === undefined) return a === b;
  if (typeof a !== typeof b || typeof a !== 'object') return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => equalModuloMask(v, b[i], mask));
  }
  const aObj = a as Record<string, unknown>;
  const bObj = b as Record<string, unknown>;
  const aKeys = Object.keys(aObj);
  if (aKeys.length !== Object.keys(bObj).length) return false;
  return aKeys.every(
    (key) =>
      Object.prototype.hasOwnProperty.call(bObj, key) && equalModuloMask(aObj[key], bObj[key], mask)
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
