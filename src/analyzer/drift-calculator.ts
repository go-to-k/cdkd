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
 * The comparator only descends into keys present in `stateProperties`.
 * Any key in `awsProperties` that does not have a counterpart in state is
 * silently ignored — those are the AWS-managed fields cdkd never set.
 *
 * `options.ignorePaths` is supplied by the provider (via
 * `getDriftUnknownPaths`) for state keys it can never read back from AWS
 * (e.g. Lambda `Code`, Secrets Manager `SecretString`). A path matches when
 * it is exactly equal to the entry, or when the entry is a prefix followed
 * by `.` — so `'Code'` excludes the whole `Code` subtree, and
 * `'VpcConfig.SubnetIds'` excludes only that leaf.
 */
export function calculateResourceDrift(
  stateProperties: Record<string, unknown>,
  awsProperties: Record<string, unknown>,
  options?: { ignorePaths?: readonly string[] }
): PropertyDrift[] {
  const drifts: PropertyDrift[] = [];
  const ignore = options?.ignorePaths ?? [];
  for (const key of Object.keys(stateProperties)) {
    if (isIgnoredPath(key, ignore)) continue;
    diffAt(key, stateProperties[key], awsProperties[key], drifts, ignore);
  }
  return drifts;
}

function isIgnoredPath(path: string, ignorePaths: readonly string[]): boolean {
  for (const entry of ignorePaths) {
    if (path === entry) return true;
    if (path.startsWith(`${entry}.`)) return true;
  }
  return false;
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
  ignorePaths: readonly string[]
): void {
  if (deepEqual(stateValue, awsValue)) return;

  if (
    isPlainObject(stateValue) &&
    isPlainObject(awsValue) &&
    !Array.isArray(stateValue) &&
    !Array.isArray(awsValue)
  ) {
    // Recurse into object: only compare keys that exist in state, so
    // AWS-managed fields outside cdkd's control don't surface as drift.
    for (const key of Object.keys(stateValue)) {
      const childPath = `${path}.${key}`;
      if (isIgnoredPath(childPath, ignorePaths)) continue;
      diffAt(childPath, stateValue[key], awsValue[key], out, ignorePaths);
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
