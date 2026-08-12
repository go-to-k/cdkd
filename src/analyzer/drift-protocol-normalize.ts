/**
 * EC2 security-group `IpProtocol` VALUE canonicalization for the drift
 * comparator (issue
 * [#1643](https://github.com/go-to-k/cdkd/issues/1643)) — a sibling of
 * `drift-normalize.ts` for a difference that is not about ORDER, in the same
 * spirit as `drift-principal-normalize.ts`.
 *
 * EC2 owns the spelling of `IpProtocol`: it accepts an IANA protocol NUMBER or
 * a protocol NAME, and rewrites a subset of the numbers to their canonical
 * name before storing the rule. cdkd records what it SENT (the template's
 * value, post-#1633), AWS holds the canonical name, and
 * `readSecurityGroupIngressCurrentState` reads the name back — so the two
 * sides are two spellings of ONE protocol and every `cdkd drift` run reports
 * the difference forever. `drift --revert` cannot clear it either: it revokes
 * and re-authorizes into the same state, which is the permanent phantom drift
 * the #1591 / #1633 fixes address for their own arms.
 *
 * Unlike the send-side narrowing #1633 does, this is a READBACK-normalization
 * concern, so it lives here and runs on BOTH comparison sides. That placement
 * is load-bearing for two reasons: the baseline may be the user's TEMPLATE
 * (a resource deployed before observed-capture), where the value is whatever
 * they wrote; and it covers the inline
 * `AWS::EC2::SecurityGroup.SecurityGroupIngress[]` / `SecurityGroupEgress[]`
 * rules, which #1633 deliberately does not touch.
 *
 * ## The rename set is MEASURED, not guessed
 *
 * Probed against real AWS (us-east-1, 2026-08-12) by authorizing one rule per
 * protocol on a scratch security group and reading `IpProtocol` back, for
 * ingress AND egress:
 *
 * - RENAMED: `1` -> `icmp`, `6` -> `tcp`, `17` -> `udp`, `58` -> `icmpv6`.
 * - NOT renamed: `-1`, `0`, `2`, `4`, `27`, `41`, `47`, `50`, `51`, `88`,
 *   `89`, `94`, `103`, `112`, `132`, `255` — all read back as the number.
 *
 * So the rename set is exactly the four protocols EC2 has a NAME for, and it
 * is a CLOSED set rather than the open-ended IANA list the issue worried
 * about. `-1` is unaffected, which is why #1633's live test came back clean.
 *
 * The measured rename table, the case-folding rule and their bounds live with
 * the shared value canonicalizer in `src/utils/ip-protocol.ts` — this module
 * owns only WHERE in a resource's properties that canonicalization applies.
 *
 * **This pass matters for the `properties`-fallback baseline, not for a fresh
 * deploy.** A resource deployed by a current binary captures
 * `observedProperties` from the same `readCurrentState` the drift run uses, so
 * both sides already hold AWS's spelling and this is a no-op. The population it
 * is FOR is the one whose baseline is the user's TEMPLATE: state written before
 * observed-capture existed, or a provider that captures none. That is also why
 * the integ fixture has to strip `observedProperties` to exercise it — the
 * first version of this change asserted a fresh deploy would fail without the
 * module, and three independent reviews showed it would not.
 */

import { canonicalizeIpProtocolValue } from '../utils/ip-protocol.js';

/**
 * The resource types carrying an `IpProtocol` this pass rewrites, mapped to
 * the property path(s) it lives at. The standalone rule types carry it at the
 * top level; `AWS::EC2::SecurityGroup` carries it inside each element of its
 * two inline rule arrays.
 *
 * Deliberately a CLOSED table rather than a walk for any key named
 * `IpProtocol`: a blanket rewrite would turn an unrelated property whose value
 * happens to be `'6'` into `'tcp'`.
 */
const IP_PROTOCOL_PATHS: ReadonlyMap<string, readonly string[]> = new Map([
  ['AWS::EC2::SecurityGroupIngress', ['IpProtocol']],
  ['AWS::EC2::SecurityGroupEgress', ['IpProtocol']],
  [
    'AWS::EC2::SecurityGroup',
    ['SecurityGroupIngress[].IpProtocol', 'SecurityGroupEgress[].IpProtocol'],
  ],
]);

/**
 * Rewrite the `IpProtocol` at `path` inside `properties`, returning a copy
 * when anything changed and the original object otherwise.
 *
 * `path` is either a plain key (`'IpProtocol'`) or an array-crossing form
 * (`'SecurityGroupIngress[].IpProtocol'`) whose left half names an array
 * whose every element carries the key.
 */
function rewriteAtPath(properties: unknown, path: string): unknown {
  if (properties === null || typeof properties !== 'object' || Array.isArray(properties)) {
    return properties;
  }
  const bag = properties as Record<string, unknown>;

  const arrayMarker = path.indexOf('[].');
  if (arrayMarker === -1) {
    if (!(path in bag)) return properties;
    const next = canonicalizeIpProtocolValue(bag[path]);
    if (next === bag[path]) return properties;
    return { ...bag, [path]: next };
  }

  const arrayKey = path.slice(0, arrayMarker);
  const elementKey = path.slice(arrayMarker + '[].'.length);
  const list = bag[arrayKey];
  if (!Array.isArray(list)) return properties;

  let changed = false;
  const mapped = list.map((element) => {
    if (element === null || typeof element !== 'object' || Array.isArray(element)) return element;
    const rule = element as Record<string, unknown>;
    if (!(elementKey in rule)) return element;
    const next = canonicalizeIpProtocolValue(rule[elementKey]);
    if (next === rule[elementKey]) return element;
    changed = true;
    return { ...rule, [elementKey]: next };
  });
  if (!changed) return properties;
  return { ...bag, [arrayKey]: mapped };
}

/**
 * Canonicalize every `IpProtocol` on BOTH drift-comparison sides for the
 * security-group resource types that carry one.
 *
 * A resource type with no `IpProtocol` is returned untouched, so the caller
 * can invoke this unconditionally.
 */
export function canonicalizeIpProtocols(
  baseline: Record<string, unknown>,
  aws: Record<string, unknown>,
  resourceType: string
): { baseline: Record<string, unknown>; aws: Record<string, unknown> } {
  const paths = IP_PROTOCOL_PATHS.get(resourceType);
  if (paths === undefined) return { baseline, aws };

  let nextBaseline: unknown = baseline;
  let nextAws: unknown = aws;
  for (const path of paths) {
    nextBaseline = rewriteAtPath(nextBaseline, path);
    nextAws = rewriteAtPath(nextAws, path);
  }
  return {
    baseline: nextBaseline as Record<string, unknown>,
    aws: nextAws as Record<string, unknown>,
  };
}
