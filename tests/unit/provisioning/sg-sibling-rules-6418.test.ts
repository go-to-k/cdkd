import { describe, it, expect } from 'vite-plus/test';
import {
  sgRuleOwnershipIdentity,
  siblingOwnedSgRuleIdentities,
  stripSiblingOwnedSgRules,
} from '../../../src/provisioning/sg-sibling-rules.js';

/**
 * go-to-k/cdkd#6418: which inline-list rules of an `AWS::EC2::SecurityGroup` a
 * sibling standalone rule record owns. The end-to-end drift / revert behaviour
 * is pinned in `tests/unit/cli/drift-sg-sibling-rules-6418.test.ts`.
 */

const GROUP = 'sg-0aaaaaaaaaaaaaaaa';
const PEER = 'sg-0bbbbbbbbbbbbbbbb';

const siblingRule = { IpProtocol: 'tcp', FromPort: 5432, ToPort: 5432, SourceSecurityGroupId: PEER };
const liveRule = { ...siblingRule, SourceSecurityGroupOwnerId: '123456789012', Description: 'from B' };
const inlineRule = { IpProtocol: 'tcp', FromPort: 443, ToPort: 443, CidrIp: '10.0.0.0/16' };

function contextWith(props: Record<string, unknown>, type = 'AWS::EC2::SecurityGroupIngress') {
  return { siblings: { Rule: { resourceType: type, properties: { GroupId: GROUP, ...props } } } };
}

describe('sgRuleOwnershipIdentity', () => {
  it("ignores Description and the peer's owner id, which AWS reports and a template rarely declares", () => {
    expect(sgRuleOwnershipIdentity(liveRule, 'ingress')).toBe(
      sgRuleOwnershipIdentity(siblingRule, 'ingress')
    );
  });

  it('folds a numeric-string port and a protocol number onto the live spelling', () => {
    expect(
      sgRuleOwnershipIdentity({ ...siblingRule, IpProtocol: '6', FromPort: '5432' }, 'ingress')
    ).toBe(sgRuleOwnershipIdentity(liveRule, 'ingress'));
  });

  it.each([
    ['a different port', { ...siblingRule, ToPort: 5433 }],
    ['a different peer', { ...siblingRule, SourceSecurityGroupId: 'sg-0ccccccccccccccc' }],
    ['a CIDR instead of a peer', { IpProtocol: 'tcp', FromPort: 5432, ToPort: 5432, CidrIp: '10.0.0.0/8' }],
  ])('tells %s apart', (_label, other) => {
    expect(sgRuleOwnershipIdentity(other, 'ingress')).not.toBe(
      sgRuleOwnershipIdentity(siblingRule, 'ingress')
    );
  });

  it('tells egress rules apart by their Destination* peer', () => {
    const egress = { IpProtocol: 'tcp', FromPort: 8080, ToPort: 8080, DestinationSecurityGroupId: PEER };
    expect(
      sgRuleOwnershipIdentity({ ...egress, DestinationSecurityGroupId: 'sg-0ccccccccccccccc' }, 'egress')
    ).not.toBe(sgRuleOwnershipIdentity(egress, 'egress'));
  });

  it.each([
    ['a redacted peer', { ...siblingRule, SourceSecurityGroupId: '***' }],
    ['an unreadable port', { ...siblingRule, FromPort: 'all' }],
    ['a non-object', 'tcp'],
  ])('answers undefined for %s', (_label, rule) => {
    expect(sgRuleOwnershipIdentity(rule, 'ingress')).toBeUndefined();
  });
});

describe('siblingOwnedSgRuleIdentities', () => {
  it('names the rule a sibling SecurityGroupIngress authorizes on this group', () => {
    const owned = siblingOwnedSgRuleIdentities(GROUP, 'ingress', {}, contextWith(siblingRule));
    expect([...owned]).toEqual([sgRuleOwnershipIdentity(siblingRule, 'ingress')]);
  });

  it.each([
    ['no context', GROUP, undefined],
    ['no group id', undefined, contextWith(siblingRule)],
    ['a sibling on another group', GROUP, {
      siblings: { Rule: { resourceType: 'AWS::EC2::SecurityGroupIngress', properties: { ...siblingRule, GroupId: 'sg-other' } } },
    }],
    ['a GroupName-addressed sibling', GROUP, {
      siblings: { Rule: { resourceType: 'AWS::EC2::SecurityGroupIngress', properties: { ...siblingRule, GroupName: 'A' } } },
    }],
    ['an egress sibling, read as ingress', GROUP, contextWith(siblingRule, 'AWS::EC2::SecurityGroupEgress')],
    ['a redacted sibling', GROUP, contextWith({ ...siblingRule, SourceSecurityGroupId: '***' })],
  ])('owns nothing for %s', (_label, group, context) => {
    expect(siblingOwnedSgRuleIdentities(group, 'ingress', {}, context).size).toBe(0);
  });

  it("keeps a rule the group's own template also declares inline", () => {
    const owned = siblingOwnedSgRuleIdentities(
      GROUP,
      'ingress',
      { SecurityGroupIngress: [inlineRule, siblingRule] },
      contextWith(siblingRule)
    );
    expect(owned.size).toBe(0);
  });

  it('reads egress siblings by their Destination* peer', () => {
    const egress = { IpProtocol: 'tcp', FromPort: 8080, ToPort: 8080, DestinationSecurityGroupId: PEER };
    const owned = siblingOwnedSgRuleIdentities(
      GROUP,
      'egress',
      {},
      contextWith(egress, 'AWS::EC2::SecurityGroupEgress')
    );
    expect([...owned]).toEqual([sgRuleOwnershipIdentity(egress, 'egress')]);
  });
});

describe('stripSiblingOwnedSgRules', () => {
  const stranger = { IpProtocol: 'tcp', FromPort: 9999, ToPort: 9999, CidrIp: '10.9.0.0/16' };

  it('drops the sibling rule from both bags, keeps every other rule, and mutates neither', () => {
    const baseline = { SecurityGroupIngress: [inlineRule, siblingRule] };
    const aws = { SecurityGroupIngress: [inlineRule, liveRule, stranger] };
    const out = stripSiblingOwnedSgRules(
      'AWS::EC2::SecurityGroup',
      GROUP,
      baseline,
      aws,
      { SecurityGroupIngress: [inlineRule] },
      contextWith(siblingRule)
    );
    expect(out.baseline).toEqual({ SecurityGroupIngress: [inlineRule] });
    expect(out.aws).toEqual({ SecurityGroupIngress: [inlineRule, stranger] });
    expect(baseline.SecurityGroupIngress).toHaveLength(2);
    expect(aws.SecurityGroupIngress).toHaveLength(3);
  });

  it.each([
    ['another type', 'AWS::EC2::SecurityGroupIngress', contextWith(siblingRule)],
    ['no owning sibling', 'AWS::EC2::SecurityGroup', undefined],
  ])('returns both bags by identity for %s', (_label, type, context) => {
    const baseline = { SecurityGroupIngress: [liveRule] };
    const aws = { SecurityGroupIngress: [liveRule] };
    const out = stripSiblingOwnedSgRules(type, GROUP, baseline, aws, {}, context);
    expect(out.baseline).toBe(baseline);
    expect(out.aws).toBe(aws);
  });
});
