/**
 * Security-group rule identity primitives shared by the EC2 provider's rule
 * lookups and by `cdkd drift`'s sibling-owned rule strip
 * (`sg-sibling-rules.ts`, go-to-k/cdkd#6418). A LEAF: it imports no SDK
 * client, so the drift command can read rule identity without loading the
 * EC2 provider.
 */
import { canonicalizeIpProtocolValue } from '../utils/ip-protocol.js';
import { canonicalizeIpv4Cidr } from '../utils/ipv4-cidr.js';
import { canonicalizeIpv6Cidr } from '../utils/ipv6-cidr.js';

/**
 * The `IpProtocol` component of a security-group rule identity key.
 *
 * A NUMBER is stringified so a record written BEFORE issue #1633 still matches:
 * AWS always reports the protocol as a string, so a legacy record holding the
 * number `-1` keyed as `{"p":-1}` against AWS's `{"p":"-1"}` and matched
 * nothing — `readSecurityGroupIngressCurrentState` returned `undefined` and
 * `cdkd drift` reported the rule as GONE, forever. The canonicalizer makes such
 * a record's diff NO_CHANGE, so no deploy ever rewrites it either; normalizing
 * at the KEY is what heals the existing population with no migration.
 *
 * Anything that is neither a string nor a number is passed through UNCHANGED
 * rather than blanket-`String()`-ed: a malformed object would otherwise key as
 * the useless `'[object Object]'`, silently collapsing every malformed record
 * onto one bucket. Such a rule matches nothing either way — this keeps the
 * non-match honest instead of manufacturing a fake identity.
 */
export function sgProtocolKey(value: unknown): unknown {
  // Issue #1643 extends the #1633 normalization from the value's TYPE to its
  // SPELLING, for the same reason and at the same place. AWS not only always
  // reports the protocol as a string, it also substitutes the canonical NAME
  // for the four numbers it has one for (`1`/`6`/`17`/`58` ->
  // `icmp`/`tcp`/`udp`/`icmpv6`, measured us-east-1 2026-08-12) and lower-cases
  // a name it is given. So a record holding `'6'` keyed as `{"p":"6"}` against
  // AWS's `{"p":"tcp"}` and matched nothing — exactly the failure the comment
  // below describes for the legacy numeric `-1`, one value-mapping deeper.
  // Normalizing at the KEY heals the existing population with no migration
  // here too, and keeps the standalone lookup and the inline-rule reconcile
  // reading ONE definition of protocol identity.
  return canonicalizeIpProtocolValue(value ?? '-1');
}

/**
 * go-to-k/cdkd#6854: a security-group rule CIDR as EC2 stores it, for rule
 * identity. EC2 clears host bits and writes IPv6 compressed and lower-cased
 * (`10.0.0.5/24` is stored as `10.0.0.0/24`, `2001:DB8:0:2:0:0:0:5/64` as
 * `2001:db8:0:2::/64`), and refuses a second rule at another spelling of one
 * network as `InvalidPermission.Duplicate` (all measured us-east-1,
 * 2026-11-23), so two spellings with one key are one rule. A spelling EC2
 * refuses as malformed (a leading zero in an octet or a prefix, a prefix with
 * no digits) or anything that is not a CIDR is keyed as written, never folded
 * onto a valid network. Not a string: returned as it is.
 */
export function sgCidrKey(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const ipv4 = /^(0|[1-9]\d{0,2})(\.(0|[1-9]\d{0,2})){3}\/(0|[1-9]\d?)$/.test(value)
    ? canonicalizeIpv4Cidr(value)
    : undefined;
  if (ipv4 !== undefined) return ipv4;
  const slash = value.lastIndexOf('/');
  if (value.includes(':') && /^(0|[1-9]\d{0,2})$/.test(value.slice(slash + 1))) {
    return canonicalizeIpv6Cidr(value) ?? value;
  }
  return value;
}

/**
 * A CFn `FromPort` / `ToPort` in the NUMBER form `DescribeSecurityGroupRules`
 * reports, for `sg-support.ts`'s `securityGroupRuleMatchesCfnIngress` compare.
 *
 * An identity compare against `properties['FromPort'] as number` was wrong for
 * the same reason issue #1513 documents one property over: a YAML / JSON
 * template may spell a port as the STRING `"443"`, and `buildIpPermission`
 * passes it through to AWS unchanged, so such a rule deploys fine and would
 * then never match its own AWS-side row.
 *
 * Absent, `null`, and blank (INCLUDING whitespace-only) are AWS's `-1`, "all
 * ports". Everything that is not a number or a numeric string is `NaN`, which
 * compares unequal to everything — so the lookup records nothing rather than
 * matching some unrelated rule.
 *
 * A bare `Number(value)` was NOT enough for that last sentence, which an earlier
 * cut of this function claimed anyway: `Number` maps `' '` and `[]` to `0`,
 * `true` to `1`, and `['443']` to `443`. A whitespace-only port would then have
 * matched an ICMP **type-0** rule — a different rule, silently recorded — which
 * is the exact outcome the claim promised it could not produce.
 */
export function cfnIngressPortValue(value: unknown): number {
  if (value === undefined || value === null) return -1;
  if (typeof value === 'number') return Number.isFinite(value) ? value : Number.NaN;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') return -1;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : Number.NaN;
  }
  // Booleans, arrays, objects: not a port in any spelling AWS or CFn accepts.
  return Number.NaN;
}

/**
 * The `sgr-…` security-group rule id, anchored.
 *
 * Here, in a leaf with no SDK client, so `cdkd drift --revert` reads recorded
 * rule ids without loading the EC2 provider (go-to-k/cdkd#6641);
 * `sg-support.ts` re-exports it. `src/cli/commands/export/sg-ingress-rule-id.ts`
 * keeps its own copy.
 *
 * Anchoring is what discriminates. `startsWith('sgr-')` also accepts
 * `sgr-0abc|tcp|443|443` — a composite wearing the identifier's prefix — which
 * on the import path reaches AWS as a malformed id and raises
 * `InvalidSecurityGroupRuleId.Malformed`, an error `isNotFoundError` does not
 * match, so `verifyExplicit` would THROW and abort the whole `cdkd import` run
 * instead of declining that one row.
 */
export const SG_RULE_ID_PATTERN = /^sgr-[0-9a-f]+$/;

/** A record's recorded `sgr-` rule id, when it has one. */
export function recordedSgRuleId(
  attributes: Readonly<Record<string, unknown>> | undefined
): string | undefined {
  const recorded = attributes?.['Id'];
  return typeof recorded === 'string' && SG_RULE_ID_PATTERN.test(recorded) ? recorded : undefined;
}
