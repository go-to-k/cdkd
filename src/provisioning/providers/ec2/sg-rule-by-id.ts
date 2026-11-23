/**
 * go-to-k/cdkd#6641: security-group rule ownership resolved by `sgr-` id.
 *
 * `ModifySecurityGroupRules` changes a rule's protocol, ports or peer in place
 * and keeps its id. The group readback (`DescribeSecurityGroups`) carries no
 * rule ids, and a sibling standalone rule was matched to its record by
 * identity (`sg-sibling-rules.ts`), so a rule changed that way read as an
 * extra inline rule of the group, `cdkd drift --revert` REVOKED it, and the
 * rule's own record read as deleted. Matching by identity also let the two
 * sides claim different rules: a stranger's rule at the sibling's recorded
 * identity read as the sibling's, while the sibling's own moved rule read as
 * the group's.
 *
 * So on drift and revert, a group with a sibling rule record that records an
 * `sgr-` id has its rules read WITH their ids (`DescribeSecurityGroupRules`,
 * one call per such group per read), and ownership is decided by id on both
 * sides: the live rule carrying a sibling's id is that sibling's, reported on
 * the sibling's resource; a rule at the sibling's recorded identity under
 * another id is a stranger's, reported on the group and revoked by its revert.
 * A sibling recording no id (a legacy record) is still matched by identity. A
 * group with no id-recording sibling makes no extra call, and the deploy-time
 * capture (`afterOwnWrite`) makes none either.
 */
import { type SecurityGroupRule } from '@aws-sdk/client-ec2';
import type { ReadCurrentStateContext } from '../../../types/resource.js';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import { safeMsg } from '../../../utils/display-safe.js';
import { cfnIngressPortValue, recordedSgRuleId, sgProtocolKey } from '../../sg-rule-identity.js';
import {
  recordedRuleIdOf,
  sgRuleOwnershipIdentity,
  sgSiblingDecidedById,
} from '../../sg-sibling-rules.js';
import { type CfnSgRule, sgCidrKey } from './sg-support.js';
import type { EC2Provider } from '../ec2-provider.js';

type SgDirection = 'ingress' | 'egress';

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const LIST_KEY: Readonly<Record<SgDirection, 'SecurityGroupIngress' | 'SecurityGroupEgress'>> = {
  ingress: 'SecurityGroupIngress',
  egress: 'SecurityGroupEgress',
};

/** The AWS error names that mean the caller may not call `DescribeSecurityGroupRules`. */
const DENIED = new Set(['UnauthorizedOperation', 'AccessDenied', 'AccessDeniedException']);

/**
 * Why the group's rules could not be read with their ids, for a log line or an
 * error: the AWS failure's summary, plus the permission a denial needs.
 */
export function sgRulesReadFailure(err: unknown): string {
  const name = (err as { name?: unknown } | null)?.name;
  const summary = describeAwsFailure(err).summary;
  return typeof name === 'string' && DENIED.has(name)
    ? `${summary}; this read needs ec2:DescribeSecurityGroupRules`
    : summary;
}

/**
 * A `DescribeSecurityGroupRules` rule in the CFn shape `flattenIpPermissions`
 * gives the same rule: `Source*` / `Destination*` peer keys by direction, and no
 * ports on an all-protocols rule (its `IpPermission` carries none).
 */
export function cfnSgRuleOfDescribed(rule: SecurityGroupRule): CfnSgRule {
  const egress = rule.IsEgress === true;
  const out: CfnSgRule = {};
  if (rule.IpProtocol !== undefined) out['IpProtocol'] = rule.IpProtocol;
  if (rule.IpProtocol !== '-1') {
    if (rule.FromPort !== undefined) out['FromPort'] = rule.FromPort;
    if (rule.ToPort !== undefined) out['ToPort'] = rule.ToPort;
  }
  if (rule.CidrIpv4 !== undefined) out['CidrIp'] = rule.CidrIpv4;
  if (rule.CidrIpv6 !== undefined) out['CidrIpv6'] = rule.CidrIpv6;
  const peer = rule.ReferencedGroupInfo;
  if (peer?.GroupId !== undefined) {
    out[egress ? 'DestinationSecurityGroupId' : 'SourceSecurityGroupId'] = peer.GroupId;
    if (!egress && peer.UserId !== undefined) out['SourceSecurityGroupOwnerId'] = peer.UserId;
  }
  if (rule.PrefixListId !== undefined) {
    out[egress ? 'DestinationPrefixListId' : 'SourcePrefixListId'] = rule.PrefixListId;
  }
  if (rule.Description !== undefined) out['Description'] = rule.Description;
  return out;
}

/** What the group readback assigned by id: per direction the live rules' identities, and the siblings so decided. */
export interface SiblingIdOwnership {
  owned: Record<SgDirection, Set<string>>;
  decided: Set<string>;
}

/**
 * The group readback's half (`readSecurityGroupCurrentState`): for each sibling
 * rule record {@link sgSiblingDecidedById} lets decide by id whose id is live
 * on the group, the identity of the live rule carrying it (minus the rules the
 * group's own template also declares inline), and the sibling's logical id, so
 * the caller matches only the OTHER siblings by identity. A sibling whose id
 * is no longer live (its rule revoked, perhaps re-authorized under a new id)
 * stays matched by identity, as its own readback does. `undefined`, with no
 * call, on the deploy capture or when no sibling is decided by id; also
 * `undefined` when the rules cannot be read whole, with one warning: the
 * caller then matches every sibling by identity, as before go-to-k/cdkd#6641,
 * and the group's revert refuses for the same reason before it writes.
 */
export async function siblingIdOwnedSgRules(
  provider: EC2Provider,
  groupId: string,
  properties: Record<string, unknown> | undefined,
  context: ReadCurrentStateContext | undefined
): Promise<SiblingIdOwnership | undefined> {
  if (context?.afterOwnWrite === true) return undefined;
  const records = Object.entries(context?.siblings ?? {});
  const byId = new Map<string, string>();
  for (const [lid, sibling] of records) {
    const props = sibling.properties;
    if (!isPlainRecord(props) || props['GroupId'] !== groupId) continue;
    if (!sgSiblingDecidedById(lid, sibling, records, properties)) continue;
    const id = recordedRuleIdOf(sibling);
    if (id !== undefined) byId.set(id, lid);
  }
  if (byId.size === 0) return undefined;
  let rules: SecurityGroupRule[] | undefined;
  let failure = 'more pages than cdkd reads';
  try {
    rules = await provider.listGroupRules(groupId);
  } catch (err) {
    failure = sgRulesReadFailure(err);
  }
  if (rules === undefined) {
    provider.logger.warn(
      safeMsg`readCurrentState: the rules of ${groupId} could not be read with their ids (${failure}), so its standalone rules are matched by protocol, ports and peer`
    );
    return undefined;
  }
  const out: SiblingIdOwnership = {
    owned: { ingress: new Set(), egress: new Set() },
    decided: new Set(),
  };
  for (const rule of rules) {
    const id = rule.SecurityGroupRuleId;
    const lid = id === undefined ? undefined : byId.get(id);
    if (rule.GroupId !== groupId || lid === undefined) continue;
    const direction: SgDirection = rule.IsEgress === true ? 'egress' : 'ingress';
    const sibling = context?.siblings?.[lid];
    if (
      sibling?.resourceType !==
      (direction === 'egress' ? 'AWS::EC2::SecurityGroupEgress' : 'AWS::EC2::SecurityGroupIngress')
    )
      continue;
    const identity = sgRuleOwnershipIdentity(cfnSgRuleOfDescribed(rule), direction);
    if (identity === undefined) continue;
    out.owned[direction].add(identity);
    out.decided.add(lid);
  }
  for (const direction of ['ingress', 'egress'] as const) {
    const inline = properties?.[LIST_KEY[direction]];
    if (!Array.isArray(inline)) continue;
    for (const entry of inline) {
      const identity = sgRuleOwnershipIdentity(entry, direction);
      if (identity !== undefined) out.owned[direction].delete(identity);
    }
  }
  return out;
}

/**
 * The group revert's half (`updateSecurityGroup`): which of `toRevoke` name a
 * live rule of `rules` whose `sgr-` id is in `siblingIds`, the rule ids the
 * stack's standalone rule records hold on the group, each mapped to the reason.
 * A rule whose identity cannot be compared is held too. Pure.
 */
export function sgRevokesHeldBySiblings(
  rules: readonly SecurityGroupRule[],
  groupId: string,
  toRevoke: ReadonlyArray<Record<string, unknown>>,
  direction: SgDirection,
  siblingIds: ReadonlySet<string>
): Map<Record<string, unknown>, string> {
  const heldIdentities = new Map<string, string>();
  for (const rule of rules) {
    const id = rule.SecurityGroupRuleId;
    if (id === undefined || !siblingIds.has(id) || rule.GroupId !== groupId) continue;
    if ((rule.IsEgress === true) !== (direction === 'egress')) continue;
    const identity = sgRuleOwnershipIdentity(cfnSgRuleOfDescribed(rule), direction);
    if (identity !== undefined) heldIdentities.set(identity, id);
  }
  const held = new Map<Record<string, unknown>, string>();
  for (const rule of toRevoke) {
    const identity = sgRuleOwnershipIdentity(rule, direction);
    if (identity === undefined) {
      held.set(rule, 'a rule it would revoke cannot be compared with its standalone rules');
    } else {
      const id = heldIdentities.get(identity);
      if (id !== undefined) held.set(rule, `a rule it would revoke is ${id}, a standalone rule's`);
    }
  }
  return held;
}

/** The keys a standalone ingress rule's identity reads. */
const INGRESS_IDENTITY_KEYS = [
  'IpProtocol',
  'FromPort',
  'ToPort',
  'CidrIp',
  'CidrIpv6',
  'SourceSecurityGroupId',
  'SourceSecurityGroupName',
  'SourceSecurityGroupOwnerId',
  'SourcePrefixListId',
] as const;

/**
 * Does the live ingress rule describe what the record declares, under the
 * spellings AWS folds (a protocol number for its name, a numeric-string port, a
 * CIDR with host bits set)?
 */
function describedRuleMatchesRecord(
  rule: SecurityGroupRule,
  properties: Record<string, unknown>
): boolean {
  if (sgProtocolKey(rule.IpProtocol) !== sgProtocolKey(properties['IpProtocol'])) return false;
  if ((rule.FromPort ?? -1) !== cfnIngressPortValue(properties['FromPort'])) return false;
  if ((rule.ToPort ?? -1) !== cfnIngressPortValue(properties['ToPort'])) return false;
  const pairs: Array<[unknown, unknown]> = [
    [sgCidrKey(properties['CidrIp'] ?? undefined), sgCidrKey(rule.CidrIpv4)],
    [sgCidrKey(properties['CidrIpv6'] ?? undefined), sgCidrKey(rule.CidrIpv6)],
    [properties['SourceSecurityGroupId'] ?? undefined, rule.ReferencedGroupInfo?.GroupId],
    [properties['SourcePrefixListId'] ?? undefined, rule.PrefixListId],
  ];
  if (pairs.some(([declared, live]) => declared !== live)) return false;
  const owner = properties['SourceSecurityGroupOwnerId'];
  return owner == null || owner === rule.ReferencedGroupInfo?.UserId;
}

/**
 * The standalone ingress readback by id (`readSecurityGroupIngressCurrentState`):
 * the live rule carrying the record's recorded `sgr-` id. A rule that matches
 * the record answers in the record's spelling, so it compares clean; one moved
 * out of band answers as AWS has it, so the edit is drift on THIS resource; an
 * id no longer live is matched by identity, as the group's readback does.
 *
 * `'fallback'` hands the read to the identity path where an id does not
 * decide: the deploy capture, no recorded id, a record
 * `sgSiblingDecidedById` does not qualify, an id no longer live, or a listing
 * with more pages than cdkd reads (the group's readback falls back alike).
 * A failed listing call is thrown: the group's own listing may have succeeded
 * and assigned the rule by id, and the identity path could then read a stranger
 * at the record's identity as this record's.
 */
export async function readSgIngressById(
  provider: EC2Provider,
  groupId: string,
  properties: Record<string, unknown>,
  context: ReadCurrentStateContext | undefined
): Promise<CfnSgRule | 'gone' | 'fallback'> {
  if (context?.afterOwnWrite === true) return 'fallback';
  const recordedId = recordedSgRuleId(context?.attributes);
  if (recordedId === undefined) return 'fallback';
  // The group's readback decides by the same predicate, so the two sides
  // never claim different rules.
  const records = Object.entries(context?.siblings ?? {});
  const groupRecord = records.find(
    ([, r]) => r.resourceType === 'AWS::EC2::SecurityGroup' && r.physicalId === groupId
  )?.[1];
  const self = {
    resourceType: 'AWS::EC2::SecurityGroupIngress',
    properties: { ...properties, GroupId: groupId },
    attributes: context?.attributes,
  };
  if (!sgSiblingDecidedById(undefined, self, records, groupRecord?.properties)) return 'fallback';
  // A failed call is THROWN, so drift reports the read as failed (exit 2):
  // the group's own listing may have succeeded and assigned the rule by id,
  // so neither the identity path nor "cannot tell" (which exits 0) may answer.
  const rules = await provider.listGroupRules(groupId);
  if (rules === undefined) return 'fallback';
  const rule = rules.find((r) => r.SecurityGroupRuleId === recordedId);
  // The id is no longer live: matched by identity, as the group does (a rule
  // re-authorized at the record's values is still the record's).
  if (rule === undefined) return 'fallback';
  if (rule.GroupId !== groupId || rule.IsEgress === true) return 'gone';
  const live = cfnSgRuleOfDescribed(rule);
  if (properties['SourceSecurityGroupOwnerId'] == null) delete live['SourceSecurityGroupOwnerId'];
  if (describedRuleMatchesRecord(rule, properties)) {
    // The record's own spelling for every identity key it declares; the
    // description is AWS's, so a description edit is still drift.
    for (const key of INGRESS_IDENTITY_KEYS) {
      if (properties[key] != null) live[key] = properties[key];
    }
    return live;
  }
  // Moved: AWS's values, a protocol or port equal to the record's echoed in
  // the record's spelling (the comparison is type-strict).
  if (sgProtocolKey(rule.IpProtocol) === sgProtocolKey(properties['IpProtocol'])) {
    if (properties['IpProtocol'] != null) live['IpProtocol'] = properties['IpProtocol'];
  }
  for (const key of ['FromPort', 'ToPort'] as const) {
    const declared = properties[key];
    if (declared != null && cfnIngressPortValue(declared) === cfnIngressPortValue(live[key])) {
      live[key] = declared;
    }
  }
  return live;
}
