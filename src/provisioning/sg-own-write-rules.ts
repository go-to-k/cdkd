/**
 * The security group rule lists of the post-write baseline capture
 * (`ReadCurrentStateContext.afterOwnWrite`, go-to-k/cdkd#6609): when a
 * declared rule reads back, compared on a key both spellings share.
 */
import { cfnIngressPortValue, sgCidrKey, sgProtocolKey } from './sg-rule-identity.js';
import { mergeDeclaredEntries, type OwnWriteMember } from './settle-own-write-members.js';
import type { MemberRead } from './settle-after-own-write.js';

type SgDirection = 'ingress' | 'egress';

/**
 * A rule's settle key, the same for a declared rule and its read-back:
 *  - the protocol through `sgProtocolKey` (`'6'` and `'tcp'` are one);
 *  - for all-traffic (`-1`) no ports, which AWS drops, and otherwise the
 *    ports as numbers (CFn accepts `'443'`);
 *  - `''` the same as an absent value (a `Description: ''`);
 *  - no peer owner id, which AWS adds to a peer-group ingress rule and CDK
 *    never declares;
 *  - a CIDR through `sgCidrKey` (host bits cleared, IPv6 compressed, as EC2
 *    stores it).
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
    // go-to-k/cdkd#6854: a CIDR as EC2 stores it, as every rule identity keys it.
    c4: sgCidrKey(present(rule['CidrIp'])),
    c6: sgCidrKey(present(rule['CidrIpv6'])),
    peer: present(peer),
    pl: present(
      direction === 'egress' ? rule['DestinationPrefixListId'] : rule['SourcePrefixListId']
    ),
    d: present(rule['Description']),
  });
}

/**
 * A rule's REMOVAL key (go-to-k/cdkd#6609): {@link sgSettleRuleKey} without
 * the description, because a revoke removes the rule whatever description it
 * carries. The one key a revoke notes (`recordOwnWriteRemoval`, from the rule
 * it revoked) and the capture matches a declared or read rule by, so the
 * spellings `sgSettleRuleKey` folds (string ports, `'6'` / `'tcp'`, an
 * added peer owner id, `''`) can never make a still-read revoked rule pass as
 * gone. `undefined` where the settle key is.
 */
export function sgRemovalRuleKey(
  rule: Record<string, unknown>,
  direction: SgDirection
): string | undefined {
  return sgSettleRuleKey({ ...rule, Description: undefined }, direction);
}

/**
 * The removal keys a capture waits to see gone: each of `removed` that no
 * declared rule has (a declared rule with the key was put back by the write).
 *
 * A declared ingress rule naming its peer by `SourceSecurityGroupName` alone
 * has no key, so it cannot be told apart from a revoked peer-group rule on the
 * same protocol and ports: the same update may have revoked that peer's rule
 * in another spelling (by id, `'443'` for `443`, with an owner id) and put it
 * back by name, and the read then still shows it. Waiting for it would never
 * settle, and dropping it would leave a declared live grant out of the
 * baseline (phantom drift, and `drift --revert` revoking it). So a revoked
 * PEER-GROUP rule whose protocol and ports (folded as the settle key folds
 * them) are those of a declared name-only rule is not waited on; any other
 * revoked rule still is. With such a rule declared, a key that does not parse
 * is not waited on either.
 */
export function sgRemovedNotDeclared(
  removed: ReadonlySet<string> | undefined,
  declared: readonly unknown[],
  direction: SgDirection
): Set<string> {
  const keep = new Set<string | undefined>();
  const namedPeerPorts = new Set<string>();
  for (const rule of declared) {
    if (typeof rule !== 'object' || rule === null) continue;
    const key = sgRemovalRuleKey(rule as Record<string, unknown>, direction);
    keep.add(key);
    if (key !== undefined) continue;
    // A name-only rule: its protocol and ports, folded through the same key.
    const asPeer = sgRemovalRuleKey(
      {
        ...(rule as Record<string, unknown>),
        SourceSecurityGroupName: undefined,
        SourceSecurityGroupId: 'named',
      },
      direction
    );
    const ports = asPeer === undefined ? undefined : protocolAndPorts(asPeer);
    if (ports !== undefined) namedPeerPorts.add(ports);
  }
  return new Set(
    [...(removed ?? [])].filter((key) => {
      if (keep.has(key)) return false;
      if (namedPeerPorts.size === 0) return true;
      let parsed: { peer?: unknown };
      try {
        parsed = JSON.parse(key) as { peer?: unknown };
      } catch {
        return false;
      }
      return !(parsed.peer !== null && namedPeerPorts.has(protocolAndPorts(key) ?? ''));
    })
  );
}

/** A removal key's protocol and ports, as one comparable string. */
function protocolAndPorts(key: string): string | undefined {
  try {
    const { p, f, t } = JSON.parse(key) as { p?: unknown; f?: unknown; t?: unknown };
    return JSON.stringify([p, f, t]);
  } catch {
    return undefined;
  }
}

/** Whether `rule`, as read, is one of `gone` (removal keys). */
export function sgRuleIsRemoved(
  rule: unknown,
  gone: ReadonlySet<string>,
  direction: SgDirection
): boolean {
  if (gone.size === 0 || typeof rule !== 'object' || rule === null) return false;
  const key = sgRemovalRuleKey(rule as Record<string, unknown>, direction);
  return key !== undefined && gone.has(key);
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

/**
 * A security group rule list as a post-write member: settled once every
 * declared rule reads back and no rule this write revoked (`revoked`, removal
 * keys) does. Unsettled, the read gains each declared rule still unread and
 * loses each revoked rule still read (`settle-own-write-members.ts`), then
 * `reorder` puts it in the read's own order.
 */
export function sgRuleListMember(
  key: string,
  direction: SgDirection,
  declared: readonly unknown[],
  revoked: ReadonlySet<string> | undefined,
  reorder: (rules: unknown[]) => unknown,
  read: () => Promise<MemberRead<unknown>>
): OwnWriteMember<unknown> {
  const gone = sgRemovedNotDeclared(revoked, declared, direction);
  return {
    key,
    declared,
    matches: (value) =>
      declaredSgRulesRead(value, declared, direction) &&
      !(value as unknown[]).some((rule) => sgRuleIsRemoved(rule, gone, direction)),
    whenUnsettled: (newest) =>
      reorder(
        mergeDeclaredSgRules(newest, declared, direction).filter(
          (rule) => !sgRuleIsRemoved(rule, gone, direction)
        )
      ),
    read,
  };
}
