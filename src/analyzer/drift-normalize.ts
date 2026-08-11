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
 * Plain-string arrays and NON-tag object arrays are NOT canonicalized by the
 * two heuristic passes above, because either can be order-significant. But
 * several CFn inputs are semantically unordered sets of plain strings (FSx
 * `WindowsConfiguration.Aliases`, `...SelfManagedActiveDirectoryConfiguration.DnsIps`,
 * ...) or of objects (ELBv2 `TargetGroup.Targets`), so
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
 * Match a dotted property path against a provider-declared path list.
 *
 * An entry matches when the path is exactly equal to it, OR when the entry is
 * a prefix followed by `.`. Every entry is therefore a SUBTREE declaration:
 * `'VpcConfig'` matches `VpcConfig`, `VpcConfig.SubnetIds`, and anything
 * deeper. There is no leaf-only form.
 *
 * Shared by the two provider-declared path lists so their semantics cannot
 * drift apart: `getDriftUnknownPaths` (via `isIgnoredPath` in
 * `drift-calculator.ts`) and `getDriftUnorderedPaths` (via
 * {@link canonicalizeUnorderedArraysAtPaths} below).
 */
export function matchesPathPrefix(path: string, entries: readonly string[]): boolean {
  for (const entry of entries) {
    if (path === entry) return true;
    if (path.startsWith(`${entry}.`)) return true;
  }
  return false;
}

/**
 * Sort plain-string arrays AND object arrays found at one of the
 * provider-declared `paths`, and ONLY there. Unlike the two heuristic passes
 * above, this one is opt-in per resource type via
 * `ResourceProvider.getDriftUnorderedPaths` — a list is order-significant
 * unless the provider says otherwise.
 *
 * Paths use dot-notation for nested keys and are matched by the shared
 * {@link matchesPathPrefix} rule, the same one `getDriftUnknownPaths` uses. So
 * `'WindowsConfiguration'` covers every plain-string array in that subtree, and
 * `'WindowsConfiguration.Aliases'` covers that path and everything beneath it
 * (every entry is a subtree declaration — there is no leaf-only form).
 *
 * One semantic DIVERGENCE from `getDriftUnknownPaths`, required for this pass
 * to work: `isIgnoredPath` never sees a path that crosses an array, because the
 * comparator's `diffAt` compares arrays wholesale via `deepEqual` and never
 * descends into elements. This walk DOES descend into array elements, giving
 * each element its parent's path (array indices never appear in paths). So
 * `'Items.Aliases'` is meaningful here — it reaches an `Aliases` array inside
 * each element of `Items` — while being inert as an ignore-path. The divergence
 * is strictly more permissive; nothing that matches for ignore-paths fails to
 * match here.
 *
 * TWO element shapes are sorted, each only when the array is HOMOGENEOUS in it:
 *
 * 1. every element a plain string — sorted lexically;
 * 2. every element a plain object — sorted by {@link canonicalJson}, a
 *    key-order-independent serialization (issue
 *    [#1620](https://github.com/go-to-k/cdkd/issues/1620)). Key order must not
 *    participate: AWS's readback order for an object's own keys is no more
 *    guaranteed than its order for the list, so sorting on raw
 *    `JSON.stringify` would make the comparison depend on it and reintroduce
 *    the phantom drift this pass exists to remove. `ElasticLoadBalancingV2::
 *    TargetGroup.Targets` is the first consumer.
 *
 * A MIXED array (strings and objects, or anything else) is left untouched, so
 * a mis-declared path can never reorder a heterogeneous list. Nested arrays are
 * also left alone: an array element that is itself an array is not descended
 * into, so `{P: [['b','a']]}` never has its INNER list sorted by a `'P'`
 * declaration. That exclusion is a deliberate decision rather than an
 * inherited accident — no CFn shape in tree is an array-of-arrays, and an
 * inner list's own order-significance is a separate question from its
 * container's, which the single declared path cannot express.
 */
export function canonicalizeUnorderedArraysAtPaths(v: unknown, paths: readonly string[]): unknown {
  if (paths.length === 0) return v;
  return walkUnordered(v, '', paths);
}

/**
 * Serialize a value with every object's keys emitted in sorted order, so two
 * structurally equal objects produce the same string regardless of the key
 * order they were built in. Used ONLY as a sort key — the returned string is
 * never compared for equality by the drift comparator, which keeps its own
 * `deepEqual`.
 */
function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (v && typeof v === 'object') {
    const entries = Object.keys(v as Record<string, unknown>)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((v as Record<string, unknown>)[k])}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}

const isPlainObjectElement = (el: unknown): boolean =>
  el !== null && typeof el === 'object' && !Array.isArray(el);

function walkUnordered(v: unknown, path: string, paths: readonly string[]): unknown {
  if (Array.isArray(v)) {
    // Array elements inherit the parent path (indices never appear in paths),
    // but a nested array is passed through untouched — see the docstring.
    const mapped = v.map((el) => (Array.isArray(el) ? el : walkUnordered(el, path, paths)));
    if (mapped.length > 1 && matchesPathPrefix(path, paths)) {
      if (mapped.every((el) => typeof el === 'string'))
        return [...(mapped as string[])].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      if (mapped.every(isPlainObjectElement)) {
        const keyed = mapped.map((el) => ({ el, key: canonicalJson(el) }));
        keyed.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
        return keyed.map((k) => k.el);
      }
    }
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
