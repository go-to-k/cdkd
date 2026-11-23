/**
 * go-to-k/cdkd#6418: security-group rules a SIBLING standalone
 * `AWS::EC2::SecurityGroupIngress` / `AWS::EC2::SecurityGroupEgress` of the
 * same stack authorizes on a group, the rule-list analogue of
 * `stripSiblingOwnedMembers` (go-to-k/cdkd#6324).
 *
 * CDK never inlines a security-group-to-security-group rule
 * (`SecurityGroup.canInlineRule` is false), so `a.connections.allowFrom(b, ...)`
 * is a standalone rule resource while a CIDR rule of the same group stays in its
 * `SecurityGroupIngress` list. `DescribeSecurityGroups` reports both, so a group
 * whose template DECLARES an inline list read the sibling's rule as drift on
 * every fresh stack, and `cdkd drift --revert` REVOKED it (the group's
 * `update()` revokes what the previous side holds and the desired side lacks).
 * The #1498 undeclared-empty fold covers only a group declaring no list.
 *
 * CloudFormation's drift (measured, us-east-1): the stack's own sibling rules
 * leave the group `IN_SYNC`, while a rule nothing in the stack declares reads as
 * an `ADD`. So only a rule a sibling RECORD owns is dropped; every other extra
 * rule stays compared. A rule the group's own template also declares inline
 * stays compared too: the group then owns it as well.
 *
 * Applied on BOTH drift sides: the readback drops it (`readCurrentState`), and
 * {@link stripSiblingOwnedSgRules} drops it from the recorded baseline, so a
 * baseline captured after the sibling's write (a later UPDATE of the group, or a
 * record written before this fix) compares clean without a redeploy.
 *
 * Identity is what AWS keeps one rule for: group, protocol, port range and peer.
 * It differs from `sg-support.ts`'s `comparableIngressIdentity` (#4492) by
 * dropping the peer owner id: that one pairs two RECORDS, which spell the owner
 * alike, while this one pairs a record with AWS's readback, which always adds it.
 * `Description` is left out (AWS holds one rule whatever the description), and
 * so is the peer's owner id, which AWS reports on every same-account group pair
 * while a template rarely declares it; a group id names one group in any
 * account. A sibling whose identity cannot be compared (a redacted value,
 * unreadable ports, a `GroupName`-addressed rule) owns nothing, which fails
 * CLOSED: its rule stays reported.
 */
import type { ReadCurrentStateContext } from '../types/resource.js';
import { isRedactedRecordedValue } from './redacted-delete-address.js';
import {
  SG_RULE_ID_PATTERN,
  cfnIngressPortValue,
  recordedSgRuleId,
  sgCidrKey,
  sgProtocolKey,
} from './sg-rule-identity.js';
import {
  previousMaySurvive,
  type TemplatePolicies,
  type WriterRecord,
} from './iam-sibling-managed-policies.js';

type SgDirection = 'ingress' | 'egress';
type CfnSgRule = Record<string, unknown>;

const RULE_TYPE: Readonly<Record<SgDirection, string>> = {
  ingress: 'AWS::EC2::SecurityGroupIngress',
  egress: 'AWS::EC2::SecurityGroupEgress',
};

const LIST_KEY: Readonly<Record<SgDirection, 'SecurityGroupIngress' | 'SecurityGroupEgress'>> = {
  ingress: 'SecurityGroupIngress',
  egress: 'SecurityGroupEgress',
};

/** The peer keys each direction spells, in identity order. */
const PEER_KEYS: Readonly<Record<SgDirection, readonly string[]>> = {
  ingress: [
    'CidrIp',
    'CidrIpv6',
    'SourceSecurityGroupId',
    'SourceSecurityGroupName',
    'SourcePrefixListId',
  ],
  egress: ['CidrIp', 'CidrIpv6', 'DestinationSecurityGroupId', 'DestinationPrefixListId'],
};

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * `rule`'s identity in `direction`, or `undefined` when it cannot be compared:
 * not an object, unreadable ports, or a redacted value in an identity key.
 */
export function sgRuleOwnershipIdentity(rule: unknown, direction: SgDirection): string | undefined {
  if (!isPlainRecord(rule)) return undefined;
  const keys = ['IpProtocol', 'FromPort', 'ToPort', ...PEER_KEYS[direction]];
  if (keys.some((key) => isRedactedRecordedValue(rule[key]))) return undefined;
  const from = cfnIngressPortValue(rule['FromPort']);
  const to = cfnIngressPortValue(rule['ToPort']);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return undefined;
  return JSON.stringify([
    sgProtocolKey(rule['IpProtocol']),
    from,
    to,
    // go-to-k/cdkd#6854: a CIDR as EC2 stores it, as every rule identity keys it.
    ...PEER_KEYS[direction].map((key) =>
      key.startsWith('Cidr') ? sgCidrKey(rule[key] ?? null) : (rule[key] ?? null)
    ),
  ]);
}

/**
 * The identities of every rule in `direction` that a sibling standalone rule
 * record of the stack authorizes on `groupId`, minus those the group's own
 * `properties` (its template) also declare inline. Empty without a context or a
 * group id.
 *
 * `skip` (go-to-k/cdkd#6641) leaves out the siblings whose rule was assigned
 * by its `sgr-` id instead ({@link sgSiblingDecidedById}).
 */
export function siblingOwnedSgRuleIdentities(
  groupId: string | undefined,
  direction: SgDirection,
  properties: Record<string, unknown> | undefined,
  context: ReadCurrentStateContext | undefined,
  skip?: (logicalId: string, sibling: RuleIdRecord) => boolean
): Set<string> {
  const owned = new Set<string>();
  if (typeof groupId !== 'string' || groupId === '') return owned;
  for (const [lid, sibling] of Object.entries(context?.siblings ?? {})) {
    if (sibling.resourceType !== RULE_TYPE[direction]) continue;
    if (skip?.(lid, sibling) === true) continue;
    const props = sibling.properties;
    if (!isPlainRecord(props) || props['GroupId'] !== groupId) continue;
    const identity = sgRuleOwnershipIdentity(props, direction);
    if (identity !== undefined) owned.add(identity);
  }
  if (owned.size === 0) return owned;
  const inline = properties?.[LIST_KEY[direction]];
  if (Array.isArray(inline)) {
    for (const entry of inline) {
      const identity = sgRuleOwnershipIdentity(entry, direction);
      if (identity !== undefined) owned.delete(identity);
    }
  }
  return owned;
}

/** The ingress keys a rule's identity reads, `SourceSecurityGroupOwnerId` included. */
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
 * go-to-k/cdkd#6641: may the rule of standalone rule record `self` be decided
 * by its recorded `sgr-` id? ONE predicate for both sides (the group's
 * readback and revert helpers, and the record's own readback), so the two never
 * claim different rules. True when the record holds an id and an identity that
 * names one rule: no redacted identity value, no peer named by group name only
 * (AWS reports the group id), and no other rule record of the group in
 * `records` (other than `selfLogicalId`) declaring the same identity or
 * recording the same id, nor the group's own inline list (`groupProperties`)
 * declaring it (go-to-k/cdkd#4492: AWS keeps one rule for both). Otherwise the
 * rule stays matched by identity, as before. Whether the id is still live is
 * the caller's to check against the group's rules.
 */
export function sgSiblingDecidedById(
  selfLogicalId: string | undefined,
  self: RuleIdRecord,
  records: Iterable<readonly [string, RuleIdRecord]>,
  groupProperties: Record<string, unknown> | undefined
): boolean {
  if (!isPlainRecord(self)) return false;
  const direction: SgDirection | undefined =
    self.resourceType === RULE_TYPE.ingress
      ? 'ingress'
      : self.resourceType === RULE_TYPE.egress
        ? 'egress'
        : undefined;
  const props = self.properties;
  const id = recordedRuleIdOf(self);
  if (direction === undefined || !isPlainRecord(props) || id === undefined) return false;
  const groupId = props['GroupId'];
  if (typeof groupId !== 'string' || groupId === '') return false;
  if (INGRESS_IDENTITY_KEYS.some((key) => isRedactedRecordedValue(props[key]))) return false;
  if (props['SourceSecurityGroupName'] != null && props['SourceSecurityGroupId'] == null) {
    return false;
  }
  const identity = sgRuleOwnershipIdentity(props, direction);
  if (identity === undefined) return false;
  for (const [lid, other] of records) {
    if (lid === selfLogicalId || !isPlainRecord(other)) continue;
    if (other.resourceType !== RULE_TYPE[direction]) continue;
    const otherProps = other.properties;
    if (!isPlainRecord(otherProps) || otherProps['GroupId'] !== groupId) continue;
    if (recordedRuleIdOf(other) === id) return false;
    if (sgRuleOwnershipIdentity(otherProps, direction) === identity) return false;
  }
  const inline = groupProperties?.[LIST_KEY[direction]];
  if (
    Array.isArray(inline) &&
    inline.some((e) => sgRuleOwnershipIdentity(e, direction) === identity)
  ) {
    return false;
  }
  return true;
}

/**
 * The `skip` the drift-side helpers pass {@link siblingOwnedSgRuleIdentities}
 * for a group's LIVE side: the siblings the SDK readback assigned by id, whose
 * rules it already placed (a live rule at such a sibling's recorded identity is
 * a stranger's). A group read through Cloud Control (`context.ccApiRead`)
 * assigned nothing by id, so it skips none.
 */
export function skipSiblingsDecidedById(
  properties: Record<string, unknown> | undefined,
  context: ReadCurrentStateContext | undefined
): ((logicalId: string, sibling: RuleIdRecord) => boolean) | undefined {
  if (context?.ccApiRead === true) return undefined;
  const records = Object.entries(context?.siblings ?? {});
  return (lid, sibling) => sgSiblingDecidedById(lid, sibling, records, properties);
}

/** The record fields {@link siblingRecordedSgRuleIds} reads. */
export interface RuleIdRecord {
  resourceType: string;
  physicalId?: string | undefined;
  properties?: Record<string, unknown> | undefined;
  attributes?: Readonly<Record<string, unknown>> | undefined;
}

/**
 * A standalone rule record's `sgr-` id: its `attributes.Id`, or a Cloud
 * Control record's physical id, which IS the rule id.
 */
export function recordedRuleIdOf(record: RuleIdRecord): string | undefined {
  return (
    recordedSgRuleId(record.attributes) ??
    (typeof record.physicalId === 'string' && SG_RULE_ID_PATTERN.test(record.physicalId)
      ? record.physicalId
      : undefined)
  );
}

/**
 * go-to-k/cdkd#6641: the `sgr-` rule ids the stack's standalone rule records
 * in `direction` (every direction when omitted) recorded on `groupId`, each
 * with the record's own identity (`undefined` when it cannot be compared).
 * The id is the record's `attributes.Id`, or a Cloud Control record's
 * physical id, which IS the rule id. `ModifySecurityGroupRules` keeps the id
 * while it changes the rule's protocol, ports or peer, so a rule carrying a
 * sibling's id is that sibling's whatever its identity now reads.
 */
export function siblingRecordedSgRuleIds(
  groupId: string | undefined,
  records: Iterable<readonly [string, RuleIdRecord]> | undefined,
  direction?: SgDirection
): Map<string, string | undefined> {
  const ids = new Map<string, string | undefined>();
  if (typeof groupId !== 'string' || groupId === '' || records === undefined) return ids;
  for (const [, record] of records) {
    // A malformed state entry (`null`, a string) names no rule.
    if (!isPlainRecord(record)) continue;
    const recordDirection: SgDirection | undefined =
      record.resourceType === RULE_TYPE.ingress
        ? 'ingress'
        : record.resourceType === RULE_TYPE.egress
          ? 'egress'
          : undefined;
    if (recordDirection === undefined) continue;
    if (direction !== undefined && recordDirection !== direction) continue;
    const props = record.properties;
    if (!isPlainRecord(props) || props['GroupId'] !== groupId) continue;
    const id = recordedRuleIdOf(record);
    if (id !== undefined) ids.set(id, sgRuleOwnershipIdentity(props, recordDirection));
  }
  return ids;
}

/** `rules` without the ones `owned` names. Order is kept. */
export function withoutSiblingOwnedSgRules(
  rules: readonly CfnSgRule[],
  owned: ReadonlySet<string>,
  direction: SgDirection
): CfnSgRule[] {
  if (owned.size === 0) return [...rules];
  return rules.filter((rule) => {
    const identity = sgRuleOwnershipIdentity(rule, direction);
    return identity === undefined || !owned.has(identity);
  });
}

/**
 * For an `AWS::EC2::SecurityGroup`, `baseline` and `aws` without the inline
 * rules a sibling standalone rule record owns (see the module comment).
 * Non-mutating; each bag is returned by identity when it has nothing to drop.
 *
 * Dropping from the BASELINE is safe for `drift --revert`, which sends this
 * baseline as the desired side against the readback: the readback has dropped
 * the same rules, so `update()` sees them on neither side and neither revokes
 * nor re-authorizes them.
 */
export function stripSiblingOwnedSgRules(
  resourceType: string,
  physicalId: string | undefined,
  baseline: Record<string, unknown>,
  aws: Record<string, unknown>,
  properties: Record<string, unknown> | undefined,
  context: ReadCurrentStateContext | undefined
): { baseline: Record<string, unknown>; aws: Record<string, unknown> } {
  if (resourceType !== 'AWS::EC2::SecurityGroup') return { baseline, aws };
  let out = { baseline, aws };
  for (const direction of ['ingress', 'egress'] as const) {
    const owned = siblingOwnedSgRuleIdentities(physicalId, direction, properties, context);
    if (owned.size === 0) continue;
    // go-to-k/cdkd#6641: the readback already assigned the rules of an
    // id-recording sibling BY ID, so the live side drops by identity only for
    // a sibling recording none; a rule at an id-recording sibling's identity
    // that the readback kept is a stranger's and stays compared.
    const liveOwned = siblingOwnedSgRuleIdentities(
      physicalId,
      direction,
      properties,
      context,
      skipSiblingsDecidedById(properties, context)
    );
    const key = LIST_KEY[direction];
    const strip = (bag: Record<string, unknown>, drop: ReadonlySet<string>) => {
      const list = bag[key];
      if (!Array.isArray(list) || drop.size === 0) return bag;
      const kept = withoutSiblingOwnedSgRules(list as CfnSgRule[], drop, direction);
      return kept.length === list.length ? bag : { ...bag, [key]: kept };
    };
    out = { baseline: strip(out.baseline, owned), aws: strip(out.aws, liveOwned) };
  }
  return out;
}

/** The rule a standalone rule record writes: its group, direction and identity. */
function ruleWriteOf(record: WriterRecord): [string, SgDirection, string] | undefined {
  const direction: SgDirection | undefined =
    record.resourceType === RULE_TYPE.ingress
      ? 'ingress'
      : record.resourceType === RULE_TYPE.egress
        ? 'egress'
        : undefined;
  const props = record.properties;
  if (direction === undefined || !isPlainRecord(props)) return undefined;
  const group = props['GroupId'];
  if (typeof group !== 'string' || group === '' || isRedactedRecordedValue(group)) return undefined;
  const identity = sgRuleOwnershipIdentity(props, direction);
  return identity === undefined ? undefined : [group, direction, identity];
}

/** Per direction, the rule identities to drop from one group's baseline. */
export type StoppedSiblingSgRules = Record<SgDirection, Set<string>>;

/**
 * go-to-k/cdkd#6420, the security-group twin of `membersSiblingsStoppedWriting`
 * (go-to-k/cdkd#6343): per logical id of an `AWS::EC2::SecurityGroup` in
 * `next`, the rules a standalone rule record wrote onto it before this deploy
 * (`previous`) and no longer writes after it — the rule resource was removed,
 * or replaced by a different rule. That resource's own delete has just revoked
 * the rule, so a group baseline still holding it (one captured before #6418,
 * which recorded sibling rules on a group UPDATE) would read as a lost rule,
 * and `drift --revert` would RE-AUTHORIZE access the template no longer grants.
 *
 * The evidence is the rule record's own RECORDED write, never the readback. A
 * rule resource whose previous AWS resource may survive the deploy
 * (`previousMaySurvive`: retained, or a replaced old rule not confirmed gone)
 * stopped nothing. In-memory only; no AWS call.
 */
export function sgRulesSiblingsStoppedWriting(
  previous: Readonly<Record<string, WriterRecord>>,
  next: Readonly<Record<string, WriterRecord>>,
  oldMaySurvive: (logicalId: string) => boolean = () => false,
  templatePolicies?: TemplatePolicies
): Map<string, StoppedSiblingSgRules> {
  const key = (w: [string, SgDirection, string]): string => JSON.stringify(w);
  const stillWritten = new Set<string>();
  // A rule record of `next` cdkd cannot identify (a `GroupName`-addressed or
  // redacted one) may still write any rule of its direction, so that direction
  // prunes nothing: dropping a rule it holds would make the drift readback
  // report it as an ADD and `--revert` revoke access the template grants.
  const unreadable = new Set<SgDirection>();
  for (const record of Object.values(next)) {
    const w = ruleWriteOf(record);
    if (w !== undefined) stillWritten.add(key(w));
    else if (record.resourceType === RULE_TYPE.ingress) unreadable.add('ingress');
    else if (record.resourceType === RULE_TYPE.egress) unreadable.add('egress');
  }
  const stoppedByGroup = new Map<string, StoppedSiblingSgRules>();
  for (const [logicalId, record] of Object.entries(previous)) {
    const w = ruleWriteOf(record);
    if (w === undefined || stillWritten.has(key(w))) continue;
    if (previousMaySurvive(logicalId, record, next, oldMaySurvive, templatePolicies)) continue;
    const [group, direction, identity] = w;
    if (unreadable.has(direction)) continue;
    let entry = stoppedByGroup.get(group);
    if (entry === undefined) {
      stoppedByGroup.set(group, (entry = { ingress: new Set(), egress: new Set() }));
    }
    entry[direction].add(identity);
  }
  const result = new Map<string, StoppedSiblingSgRules>();
  if (stoppedByGroup.size === 0) return result;
  for (const [logicalId, record] of Object.entries(next)) {
    if (record.resourceType !== 'AWS::EC2::SecurityGroup') continue;
    const stopped =
      typeof record.physicalId === 'string' ? stoppedByGroup.get(record.physicalId) : undefined;
    if (stopped !== undefined) result.set(logicalId, stopped);
  }
  return result;
}

/**
 * `bag` without the {@link sgRulesSiblingsStoppedWriting} rules the group's own
 * `properties` do not declare inline. Returned by identity when nothing is
 * dropped.
 */
export function withoutStoppedSiblingSgRules(
  bag: Record<string, unknown>,
  stopped: StoppedSiblingSgRules,
  properties: Record<string, unknown> | undefined
): Record<string, unknown> {
  let out = bag;
  for (const direction of ['ingress', 'egress'] as const) {
    const drop = new Set(stopped[direction]);
    const inline = properties?.[LIST_KEY[direction]];
    if (Array.isArray(inline)) {
      for (const entry of inline) {
        const identity = sgRuleOwnershipIdentity(entry, direction);
        if (identity !== undefined) drop.delete(identity);
      }
    }
    if (drop.size === 0) continue;
    const listKey = LIST_KEY[direction];
    const list = out[listKey];
    if (!Array.isArray(list)) continue;
    const kept = withoutSiblingOwnedSgRules(list as CfnSgRule[], drop, direction);
    if (kept.length !== list.length) out = { ...out, [listKey]: kept };
  }
  return out;
}
