/**
 * Order-normalization helpers for the drift comparator.
 *
 * `cdkd drift` compares `resource.observedProperties ?? properties` (a
 * deploy-time AWS snapshot) against a later AWS read, and the comparator in
 * `drift-calculator.ts` compares arrays POSITIONALLY (no order normalization).
 * AWS does not guarantee element ordering across reads, so when AWS returns a
 * CFn tag list ({Key,Value}[]) or an AWS resource-id/ARN array (SubnetIds,
 * SecurityGroupIds, ...) in a different order between the deploy-time snapshot
 * and a later drift read, the reorder surfaces as PHANTOM drift even though
 * nothing actually changed.
 *
 * Both kinds are semantically UNORDERED sets, so we canonicalize (sort) them
 * on BOTH sides before the diff. These two passes were surfaced by dogfooding
 * the sibling cdk-real-drift (cdkrd) tool, which hit the same false-positive
 * classes against the same kind of AWS-snapshot baseline.
 *
 * Plain-string arrays are NOT canonicalized by the two heuristic passes above,
 * because a scalar list can be order-significant. But several CFn inputs are
 * semantically unordered sets of plain strings (FSx `WindowsConfiguration.Aliases`,
 * `...SelfManagedActiveDirectoryConfiguration.DnsIps`, ...), so
 * {@link canonicalizeUnorderedArraysAtPaths} sorts them at an explicit,
 * provider-declared path list only — an opt-in seam mirroring
 * `getDriftUnknownPaths` (see `ResourceProvider.getDriftUnorderedPaths`).
 * Doing it HERE rather than inside the provider's reverse-mapper is load-bearing:
 * the normalizer runs on BOTH comparison sides, so it stays correct for the
 * `properties`-fallback baseline (a resource deployed before observed-capture,
 * whose baseline is the user's TEMPLATE order). Sorting only the AWS read side
 * would manufacture drift on exactly that path.
 */

export function canonicalizeTagListsDeep(v: unknown): unknown {
  if (Array.isArray(v)) {
    const mapped = v.map(canonicalizeTagListsDeep);
    const allKeyed =
      mapped.length > 0 &&
      mapped.every(
        (t) => t && typeof t === 'object' && typeof (t as { Key?: unknown }).Key === 'string'
      );
    if (allKeyed) {
      return [...mapped].sort((a, b) => {
        const ka = (a as { Key: string }).Key;
        const kb = (b as { Key: string }).Key;
        if (ka !== kb) return ka < kb ? -1 : 1;
        return JSON.stringify(a) < JSON.stringify(b) ? -1 : 1;
      });
    }
    return mapped;
  }
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>))
      out[k] = canonicalizeTagListsDeep(val);
    return out;
  }
  return v;
}

const ID_RE = /^[a-z][a-z0-9]*-[0-9a-f]{6,}$/;
const isIdLike = (s: unknown): boolean =>
  typeof s === 'string' && (s.startsWith('arn:') || ID_RE.test(s));

export function canonicalizeIdArraysDeep(v: unknown): unknown {
  if (Array.isArray(v)) {
    const mapped = v.map(canonicalizeIdArraysDeep);
    if (mapped.length > 1 && mapped.every(isIdLike))
      return [...(mapped as string[])].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    return mapped;
  }
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>))
      out[k] = canonicalizeIdArraysDeep(val);
    return out;
  }
  return v;
}

/**
 * Sort plain-string arrays found at one of the provider-declared `paths`, and
 * ONLY there. Unlike the two heuristic passes above, this one is opt-in per
 * resource type via `ResourceProvider.getDriftUnorderedPaths` — a scalar list
 * is order-significant unless the provider says otherwise.
 *
 * Path semantics match `isIgnoredPath` in `drift-calculator.ts` (the sibling
 * provider-declared path list): dot-notation for nested keys, and an entry
 * matches a path that is exactly equal to it OR prefixed by `<entry>.`. So
 * `'WindowsConfiguration'` covers every plain-string array under that subtree,
 * while `'WindowsConfiguration.Aliases'` covers only that leaf. Array indices
 * never appear in paths (the drift comparator does not synthesize per-index
 * paths either), so elements of an array inherit their parent's path.
 *
 * Only arrays whose every element is a plain string are sorted; anything else
 * at a declared path is left untouched, so a mis-declared path can never
 * reorder object or mixed-type elements.
 */
export function canonicalizeUnorderedArraysAtPaths(v: unknown, paths: readonly string[]): unknown {
  if (paths.length === 0) return v;
  return walkUnordered(v, '', paths);
}

function isUnorderedPath(path: string, paths: readonly string[]): boolean {
  for (const entry of paths) {
    if (path === entry) return true;
    if (path.startsWith(`${entry}.`)) return true;
  }
  return false;
}

function walkUnordered(v: unknown, path: string, paths: readonly string[]): unknown {
  if (Array.isArray(v)) {
    const mapped = v.map((el) => walkUnordered(el, path, paths));
    if (
      mapped.length > 1 &&
      isUnorderedPath(path, paths) &&
      mapped.every((el) => typeof el === 'string')
    )
      return [...(mapped as string[])].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    return mapped;
  }
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>))
      out[k] = walkUnordered(val, path === '' ? k : `${path}.${k}`, paths);
    return out;
  }
  return v;
}
