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
 * Normalization is deliberately loose, so a value AWS only re-spells is
 * never named (a missed no-op costs a warning nobody sees; a false one
 * re-sends the change on every deploy, and fails it for an allow-listed
 * pair). Object keys are sorted and null members dropped; every array is
 * compared as a multiset, so a reorder is no change (an interface's
 * secondary addresses compare as a set); a string holding JSON compares as
 * the parsed value, a numeric string or number as its `Number` form
 * (`"1.0"` is `1`), and any other scalar case-insensitively. Each side is
 * also cut to the object members both the desired side and the read model
 * hold (for a list, the members every element holds), so a member the
 * template adds that AWS never returns (a default the read model omits) is no
 * change either.
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
  // Measured in us-east-1 (go-to-k/cdkd#7083): SUCCESS, and the live session
  // kept its old interface (EC2's ModifyTrafficMirrorSession has no member
  // for it), while CloudFormation updates it in place.
  ['AWS::EC2::TrafficMirrorSession', new Set(['NetworkInterfaceId'])],
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
    if (normalized(before) === normalized(after)) continue;
    // Compare in the space the desired side declares AND the read model
    // returns: a read model also returns members the template never declares
    // (an EKS cluster's defaulted `ServiceIpv4Cidr`), a nested member the
    // template REMOVED may be kept by AWS by design, as a top-level removal
    // is, and a member the read model omits cannot be judged at all.
    const p = normalized(cut(before, after, now));
    const a = normalized(cut(after, after, now));
    if (p === a) continue;
    const n = normalized(cut(now, after, now));
    if (n === p) out.push(key);
  }
  return out.sort();
}

/** A secret reference or a mask: the read model never shows what was sent. */
function holdsStandIn(value: unknown): boolean {
  const text = JSON.stringify(value) ?? '';
  return text.includes('{{resolve:') || text.includes('****');
}

type Plain = Record<string, unknown>;
const isObject = (v: unknown): v is Plain =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * `value` cut down to the object members BOTH `a` and `b` hold, recursively.
 * An array's elements are cut by the union of the members the other side's
 * elements hold, so a reordered list is cut the same way.
 */
function cut(value: unknown, a: unknown, b: unknown): unknown {
  if (Array.isArray(value)) {
    const sa = elementShape(a);
    const sb = elementShape(b);
    return value.map((item) => cut(item, sa, sb));
  }
  if (!isObject(value) || !isObject(a) || !isObject(b)) return value;
  const out: Plain = {};
  for (const key of Object.keys(value)) {
    if (a[key] === undefined || b[key] === undefined) continue;
    out[key] = cut(value[key], a[key], b[key]);
  }
  return out;
}

/**
 * The members EVERY object element of `list` holds, recursively; `list`
 * itself when it is no array. An intersection, not a union: a read model may
 * omit a defaulted member on one element and return it on another, and a
 * member any element lacks cannot be judged on that element.
 */
function elementShape(list: unknown): unknown {
  if (!Array.isArray(list)) return list;
  return commonShape(list);
}

function commonShape(values: readonly unknown[]): unknown {
  const objects = values.filter(isObject);
  if (objects.length === 0) {
    const arrays = values.filter(Array.isArray);
    return arrays.length > 0 && arrays.length === values.length ? arrays.flat() : values[0];
  }
  const out: Plain = {};
  for (const key of Object.keys(objects[0]!)) {
    const members = objects.map((item) => item[key]);
    if (members.some((member) => member === undefined || member === null)) continue;
    out[key] = commonShape(members);
  }
  return out;
}

function normalized(value: unknown): string {
  return JSON.stringify(canonical(value));
}

const NUMERIC = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

function canonical(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    return value
      .map(canonical)
      .map((item) => JSON.stringify(item))
      .sort()
      .map((item) => JSON.parse(item) as unknown);
  }
  if (typeof value === 'object') {
    const out: Plain = {};
    for (const key of Object.keys(value as Plain).sort()) {
      const member = (value as Plain)[key];
      if (member === null || member === undefined) continue;
      out[key] = canonical(member);
    }
    return out;
  }
  if (typeof value === 'string') {
    const text = value.trim();
    if (text.startsWith('{') || text.startsWith('[')) {
      try {
        return canonical(JSON.parse(text) as unknown);
      } catch {
        // Not JSON: compared as text below.
      }
    }
    if (NUMERIC.test(text)) return String(Number(text));
    return text.toLowerCase();
  }
  if (typeof value === 'number' || typeof value === 'bigint') return String(Number(value));
  if (typeof value === 'boolean') return String(value);
  return null;
}
