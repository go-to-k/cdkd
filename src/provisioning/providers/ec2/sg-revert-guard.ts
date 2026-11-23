/**
 * go-to-k/cdkd#6641: the security-group rule diff key, and the check that a
 * group's `drift --revert` never revokes a standalone rule's live rule.
 */
import { ResourceUpdateNotSupportedError } from '../../../utils/error-handler.js';
import { isRedactedRecordedValue } from '../../redacted-delete-address.js';
import { sgProtocolKey } from './sg-support.js';
import { sgRevokesHeldBySiblings, sgRulesReadFailure } from './sg-rule-by-id.js';
import type { SecurityGroupRule } from '@aws-sdk/client-ec2';

/**
 * The rule identity `applySecurityGroupRuleDiff` diffs by: what AWS treats as
 * the rule (protocol, ports, CIDR, peer group, prefix list), without the
 * description.
 */
export function sgRuleDiffKey(
  rule: Record<string, unknown>,
  direction: 'ingress' | 'egress'
): string {
  const peerKey =
    direction === 'egress'
      ? (rule['DestinationSecurityGroupId'] as string | undefined)
      : (rule['SourceSecurityGroupId'] as string | undefined);
  const prefixKey =
    direction === 'egress'
      ? (rule['DestinationPrefixListId'] as string | undefined)
      : (rule['SourcePrefixListId'] as string | undefined);
  // Include the cross-account peer owner id (ingress only) so a same-id
  // group in a different account is not collapsed into the same rule.
  const peerOwner =
    direction === 'ingress'
      ? (rule['SourceSecurityGroupOwnerId'] as string | undefined)
      : undefined;
  // go-to-k/cdkd#5478: a peer named by group name is a rule of its own.
  // Keyed only when no id is given, since the wire then sends the id
  // alone: a redundant name must not churn revoke / authorize. `sgRuleKey`
  // (the drift read side) does not key the name, because AWS reports the
  // peer by id, so a `cdkd drift --revert` of a name-only rule re-attaches
  // it (revoke + authorize of the same peer).
  const peerName =
    direction === 'ingress' ? (rule['SourceSecurityGroupName'] as string | undefined) : undefined;
  return JSON.stringify({
    // Same canonicalization as `sgRuleKey` (issue #1643) — the two keys
    // MUST agree on identity, which is what this function's sibling JSDoc
    // promises. One deliberate exception (go-to-k/cdkd#6854): the CIDR is
    // keyed as written here, so a template edit between two spellings of one
    // network revokes and re-authorizes that rule (churn, never another
    // rule); the drift readback echoes the record's spelling, so a revert
    // sees no such pair. `sgRuleKey` also keys `Description`, which only pairs drift
    // read-back rules; here the description is compared per pair below.
    // Without it a `--revert` of a drifted inline rule set keys the
    // previous side (AWS's `tcp`) differently from the desired side
    // (state's `'6'`), so EVERY rule is revoked and re-authorized instead
    // of only the drifted one — a window with no rules on a live group.
    p: sgProtocolKey(rule['IpProtocol']),
    f: rule['FromPort'] ?? null,
    t: rule['ToPort'] ?? null,
    c4: rule['CidrIp'] ?? null,
    c6: rule['CidrIpv6'] ?? null,
    peer: peerKey ?? null,
    peerName: peerKey ? null : (peerName ?? null),
    peerOwner: peerOwner ?? null,
    pl: prefixKey ?? null,
  });
}

/** The rules `applySecurityGroupRuleDiff` would revoke: on `previous`, not on `next`. */
function sgRulesToRevoke(
  previous: Array<Record<string, unknown>>,
  next: Array<Record<string, unknown>>,
  direction: 'ingress' | 'egress'
): Array<Record<string, unknown>> {
  const nextKeys = new Set(next.map((rule) => sgRuleDiffKey(rule, direction)));
  const seen = new Set<string>();
  return previous.filter((rule) => {
    const key = sgRuleDiffKey(rule, direction);
    if (nextKeys.has(key) || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * go-to-k/cdkd#6641: a group's `drift --revert` never revokes a live rule
 * whose `sgr-` id a standalone rule record of the stack holds. Its readback
 * already leaves such a rule out of the previous side; this is the check that
 * does not trust that (a readback that fell back to identity matching). One
 * `DescribeSecurityGroupRules`, only when the revert revokes something. A
 * held rule, or rules that cannot be read with their ids, refuse the whole
 * revert BEFORE any write (Tags included), so the group is left as it is and
 * the revert is counted as not reverted.
 */
export async function refuseRevertRevokingSiblingRules(
  listRules: (groupId: string) => Promise<SecurityGroupRule[] | undefined>,
  logicalId: string,
  groupId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>,
  siblingIds: ReadonlySet<string>
): Promise<void> {
  const list = (bag: Record<string, unknown>, key: string): Array<Record<string, unknown>> =>
    Array.isArray(bag[key]) ? (bag[key] as Array<Record<string, unknown>>) : [];
  const toRevoke = {
    ingress: sgRulesToRevoke(
      list(previousProperties, 'SecurityGroupIngress'),
      list(properties, 'SecurityGroupIngress'),
      'ingress'
    ),
    egress: sgRulesToRevoke(
      list(previousProperties, 'SecurityGroupEgress'),
      list(properties, 'SecurityGroupEgress'),
      'egress'
    ),
  };
  if (toRevoke.ingress.length === 0 && toRevoke.egress.length === 0) return;
  let rules;
  let failure = 'more pages than cdkd reads';
  try {
    rules = await listRules(groupId);
  } catch (err) {
    failure = sgRulesReadFailure(err);
  }
  if (rules === undefined) {
    throw new ResourceUpdateNotSupportedError(
      resourceType,
      logicalId,
      `its rules could not be read with their ids (${failure}), so cdkd cannot tell whether a rule the revert would revoke is a standalone rule's of this stack. Nothing was changed`
    );
  }
  const reasons = new Set<string>();
  for (const direction of ['ingress', 'egress'] as const) {
    for (const reason of sgRevokesHeldBySiblings(
      rules,
      groupId,
      toRevoke[direction],
      direction,
      siblingIds
    ).values()) {
      reasons.add(reason);
    }
  }
  if (reasons.size > 0) {
    throw new ResourceUpdateNotSupportedError(
      resourceType,
      logicalId,
      `${[...reasons].join('; ')}, and a group's revert never revokes a standalone rule of its stack. Nothing was changed; the standalone rule's own drift is reported on its resource`
    );
  }
}

/**
 * go-to-k/cdkd#6641: `drift --revert` of a security group provisioned through
 * Cloud Control. That provider sends a changed `SecurityGroupIngress` /
 * `SecurityGroupEgress` as ONE replace of the whole list, and the revert's
 * desired list leaves out the rules the stack's standalone rule records own,
 * so any change would drop those live rules. So when a standalone rule record
 * of the stack names the group (by id or name, with or without a recorded id,
 * or with a target that cannot be identified) and either list
 * differs between the live (`previous`) and desired side, the revert refuses
 * before anything is sent; such a group is reverted by redeploying it.
 */
export function refuseCcGroupRevertChangingRules(
  logicalId: string,
  groupId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>,
  records: Iterable<readonly [string, { resourceType?: unknown; properties?: unknown }]>,
  /** The group's name (a default-VPC rule may target the group by it). */
  groupName?: unknown
): void {
  // A rule record counts when it names this group by id or by name, or when
  // its target cannot be identified at all (fail safe).
  const named = (value: unknown): value is string =>
    typeof value === 'string' && value !== '' && !isRedactedRecordedValue(value);
  let hasSibling = false;
  for (const [, record] of records) {
    if (typeof record !== 'object' || record === null) continue;
    if (
      record.resourceType !== 'AWS::EC2::SecurityGroupIngress' &&
      record.resourceType !== 'AWS::EC2::SecurityGroupEgress'
    ) {
      continue;
    }
    const props = record.properties as Record<string, unknown> | undefined;
    const id = typeof props === 'object' && props !== null ? props['GroupId'] : undefined;
    const name = typeof props === 'object' && props !== null ? props['GroupName'] : undefined;
    if (
      id === groupId ||
      (named(groupName) && name === groupName) ||
      (!named(id) && !named(name))
    ) {
      hasSibling = true;
      break;
    }
  }
  if (!hasSibling) return;
  const list = (bag: Record<string, unknown>, key: string): string =>
    JSON.stringify(Array.isArray(bag[key]) ? bag[key] : []);
  const changed = ['SecurityGroupIngress', 'SecurityGroupEgress'].filter(
    (key) => list(properties, key) !== list(previousProperties, key)
  );
  if (changed.length === 0) return;
  throw new ResourceUpdateNotSupportedError(
    resourceType,
    logicalId,
    `its ${changed.join(' and ')} would change, and a security group provisioned through Cloud Control replaces the whole list, which would drop the rules this stack's standalone rule resources own. Nothing was changed; revert it by redeploying the stack`
  );
}
