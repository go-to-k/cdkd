/**
 * Cloud Control can answer an update with SUCCESS while the live value stays
 * what it was (go-to-k/cdkd#7099). Measured in us-east-1 on 2026-11-27:
 * an `AWS::EC2::NetworkInterface` `PrivateIpAddresses` change adding a
 * secondary address, and an `AWS::EKS::Cluster`
 * `KubernetesNetworkConfig.ElasticLoadBalancing` toggle sent on its own. Both
 * reported SUCCESS, and the read model still held the old value. cdkd then
 * recorded the new value, so the deploy said success over a resource that
 * never changed.
 *
 * Each named key is a warning that keeps the previous value in the record, or,
 * for a pair in {@link FAILS_ON_UNAPPLIED}, a failed update. This names the
 * top-level keys whose update did not apply, judged
 * conservatively so an update that did apply can never be named:
 *
 *  - the key changed (previous and desired differ after normalization),
 *    and both sides declare it: a removal is left out, since some removals
 *    are kept by design, as CloudFormation keeps them;
 *  - the read model returns the key;
 *  - the key is not write-only, and neither side holds a secret reference or
 *    a mask (the read model never shows the sent value for those);
 *  - the live value equals the PREVIOUS value, and differs from the desired
 *    one, after normalization.
 *
 * Normalization sorts object keys, renders scalars as strings (a read model
 * answers `1` for a template's `"1"`), and drops null members; the live value
 * keeps only the object members either side declares.
 */
/** The stable, greppable prefix of every report this module drives. */
export const CC_SILENT_NOOP_TAG = '[cc-silent-noop]';

/**
 * The (type, top-level property) pairs a LIVE probe measured silently not
 * applying (go-to-k/cdkd#7099). Only these fail the resource; anything else
 * the detector names is a warning, since a handler that applies after
 * reporting success (eventual consistency) would otherwise break a deploy.
 * A pair joins only after its own live probe.
 */
const FAILS_ON_UNAPPLIED: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['AWS::EC2::NetworkInterface', new Set(['PrivateIpAddresses'])],
  ['AWS::EKS::Cluster', new Set(['KubernetesNetworkConfig'])],
]);

export function failsOnUnappliedUpdate(resourceType: string, key: string): boolean {
  return FAILS_ON_UNAPPLIED.get(resourceType)?.has(key) ?? false;
}

export function unappliedUpdateKeys(input: {
  previous: Readonly<Record<string, unknown>>;
  desired: Readonly<Record<string, unknown>>;
  live: Readonly<Record<string, unknown>> | undefined;
  writeOnly: ReadonlySet<string>;
}): string[] {
  const { previous, desired, live, writeOnly } = input;
  if (live === undefined) return [];
  const out: string[] = [];
  for (const key of Object.keys(desired)) {
    if (writeOnly.has(key)) continue;
    const before = previous[key];
    const after = desired[key];
    const now = live[key];
    if (before === undefined || after === undefined || now === undefined) continue;
    if (holdsStandIn(before) || holdsStandIn(after)) continue;
    const b = normalized(before);
    const a = normalized(after);
    if (b === a) continue;
    // Compare in the space the desired side declares: a read model also
    // returns members the template never declares (an EKS cluster's defaulted
    // `ServiceIpv4Cidr`), and a nested member the template REMOVED may be kept
    // by AWS by design, as a top-level removal is.
    const p = normalized(declaredOnly(before, after, after));
    if (p === a) continue;
    const n = normalized(declaredOnly(now, after, after));
    if (n === p) out.push(key);
  }
  return out.sort();
}

/** A secret reference or a mask: the read model never shows what was sent. */
function holdsStandIn(value: unknown): boolean {
  const text = JSON.stringify(value) ?? '';
  return text.includes('{{resolve:') || text.includes('****');
}

/** `live` cut down to the object members `a` or `b` declares, recursively. */
function declaredOnly(live: unknown, a: unknown, b: unknown): unknown {
  const isObject = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null && !Array.isArray(v);
  if (Array.isArray(live)) {
    const as = Array.isArray(a) ? a : [];
    const bs = Array.isArray(b) ? b : [];
    return live.map((item, i) => declaredOnly(item, as[i], bs[i]));
  }
  if (!isObject(live) || (!isObject(a) && !isObject(b))) return live;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(live)) {
    const ak = isObject(a) ? a[key] : undefined;
    const bk = isObject(b) ? b[key] : undefined;
    if (ak === undefined && bk === undefined) continue;
    out[key] = declaredOnly(live[key], ak, bk);
  }
  return out;
}

function normalized(value: unknown): string {
  return JSON.stringify(canonical(value));
}

function canonical(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const member = (value as Record<string, unknown>)[key];
      if (member === null || member === undefined) continue;
      out[key] = canonical(member);
    }
    return out;
  }
  return String(value);
}
