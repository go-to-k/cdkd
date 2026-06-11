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
