/**
 * The security group rule lists of the post-write baseline capture
 * (`ReadCurrentStateContext.afterOwnWrite`, go-to-k/cdkd#6609): when a
 * declared rule reads back, compared on a key both spellings share.
 */
import { cfnIngressPortValue, sgProtocolKey } from './sg-rule-identity.js';

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
