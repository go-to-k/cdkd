/**
 * The security group rule lists of the post-write baseline capture
 * (`ReadCurrentStateContext.afterOwnWrite`, go-to-k/cdkd#6609): when a
 * declared rule reads back, compared on a key both spellings share.
 */
import { cfnIngressPortValue, sgProtocolKey } from './sg-rule-identity.js';
import { mergeDeclaredEntries } from './settle-own-write-members.js';

type SgDirection = 'ingress' | 'egress';

/**
 * A rule's settle key, the same for a declared rule and its read-back:
 *  - the protocol through `sgProtocolKey` (`'6'` and `'tcp'` are one);
 *  - for all-traffic (`-1`) no ports, which AWS drops, and otherwise the
 *    ports as numbers (CFn accepts `'443'`);
 *  - `''` the same as an absent value (a `Description: ''`);
 *  - no peer owner id, which AWS adds to a peer-group ingress rule and CDK
 *    never declares.
 *
 * `undefined` for a rule declaring its peer by `SourceSecurityGroupName`
 * alone: AWS reads it back as the group id, which the declaration does not
 * carry, so it never counts as missing (the capture never waits on it).
 */
export function sgSettleRuleKey(
  rule: Record<string, unknown>,
  direction: SgDirection
): string | undefined {
  const present = (value: unknown): unknown =>
    value === undefined || value === null || value === '' ? null : value;
  const peer =
    direction === 'egress' ? rule['DestinationSecurityGroupId'] : rule['SourceSecurityGroupId'];
  if (
    direction === 'ingress' &&
    present(rule['SourceSecurityGroupName']) !== null &&
    present(peer) === null
  ) {
    return undefined;
  }
  const protocol = sgProtocolKey(rule['IpProtocol']);
  const allTraffic = protocol === '-1';
  const port = (value: unknown): unknown => (allTraffic ? null : cfnIngressPortValue(value));
  return JSON.stringify({
    p: protocol,
    f: port(rule['FromPort']),
    t: port(rule['ToPort']),
    c4: present(rule['CidrIp']),
    c6: present(rule['CidrIpv6']),
    peer: present(peer),
    pl: present(
      direction === 'egress' ? rule['DestinationPrefixListId'] : rule['SourcePrefixListId']
    ),
    d: present(rule['Description']),
  });
}

/**
 * Whether every declared rule with a settle key reads back, as a multiset; a
 * read rule the template does not declare (a sibling's, an out-of-band one)
 * is ignored.
 */
export function declaredSgRulesRead(
  value: unknown,
  declared: readonly unknown[],
  direction: SgDirection
): boolean {
  if (!Array.isArray(value)) return false;
  const have = (value as unknown[]).map((rule) =>
    typeof rule === 'object' && rule !== null
      ? sgSettleRuleKey(rule as Record<string, unknown>, direction)
      : undefined
  );
  for (const rule of declared) {
    if (typeof rule !== 'object' || rule === null) continue;
    const key = sgSettleRuleKey(rule as Record<string, unknown>, direction);
    if (key === undefined) continue;
    const index = have.indexOf(key);
    if (index < 0) return false;
    have.splice(index, 1);
  }
  return true;
}

/**
 * The drift heal's STRICT test (go-to-k/cdkd#6609): the live rules are
 * exactly the declared ones, as a set of settle keys, whatever their order.
 * A superset or a subset is not, nor is any list with a rule declared by
 * `SourceSecurityGroupName` alone (its key cannot be matched).
 */
export function sgRulesAreDeclared(
  live: unknown,
  declared: unknown,
  direction: SgDirection
): boolean {
  if (!Array.isArray(live) || !Array.isArray(declared)) return false;
  const keys = (rules: unknown[]): Set<string> | undefined => {
    const out = new Set<string>();
    for (const rule of rules) {
      const key =
        typeof rule === 'object' && rule !== null
          ? sgSettleRuleKey(rule as Record<string, unknown>, direction)
          : undefined;
      if (key === undefined) return undefined;
      out.add(key);
    }
    return out;
  };
  const have = keys(live as unknown[]);
  const want = keys(declared as unknown[]);
  return (
    have !== undefined &&
    want !== undefined &&
    have.size === want.size &&
    [...want].every((key) => have.has(key))
  );
}

/**
 * A declared rule in the shape `DescribeSecurityGroups` reads it back: no
 * ports for all-traffic (`-1`), numeric ports otherwise, and no empty value
 * (a `Description: ''`). `undefined` for a rule the settle key cannot match.
 */
export function sgRuleReadbackShape(
  rule: Record<string, unknown>,
  direction: SgDirection
): Record<string, unknown> | undefined {
  // A rule without a protocol (CFn requires one) is never recorded.
  if (
    rule['IpProtocol'] === undefined ||
    rule['IpProtocol'] === null ||
    rule['IpProtocol'] === ''
  ) {
    return undefined;
  }
  if (sgSettleRuleKey(rule, direction) === undefined) return undefined;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(rule)) {
    if (value === undefined || value === null || value === '') continue;
    out[key] = value;
  }
  const protocol = sgProtocolKey(rule['IpProtocol']);
  out['IpProtocol'] = protocol;
  if (protocol === '-1') {
    delete out['FromPort'];
    delete out['ToPort'];
  } else {
    for (const key of ['FromPort', 'ToPort']) {
      if (out[key] !== undefined) out[key] = cfnIngressPortValue(out[key]);
    }
  }
  return out;
}

/**
 * The read rules plus each declared rule still unread, at its declared
 * position (`mergeDeclaredEntries`, matched on `sgSettleRuleKey`), in the
 * readback shape. A rule the settle key cannot match is never added.
 */
export function mergeDeclaredSgRules(
  read: unknown,
  declared: readonly unknown[],
  direction: SgDirection
): unknown[] {
  const keyOf = (rule: unknown): string | undefined =>
    typeof rule === 'object' && rule !== null
      ? sgSettleRuleKey(rule as Record<string, unknown>, direction)
      : undefined;
  return mergeDeclaredEntries(
    read,
    declared,
    (entry, want) => {
      const key = keyOf(want);
      return key !== undefined && keyOf(entry) === key;
    },
    (want) =>
      typeof want === 'object' && want !== null
        ? sgRuleReadbackShape(want as Record<string, unknown>, direction)
        : undefined
  );
}
