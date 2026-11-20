import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

/**
 * go-to-k/cdkd#6641: a security group's sibling standalone rules are owned by
 * their recorded `sgr-` id, on the group's readback and revert and on the
 * standalone rule's own readback. `ModifySecurityGroupRules` keeps the id while
 * it moves a rule; a rule at a sibling's recorded identity under another id is
 * a stranger's. End to end: `tests/unit/cli/drift-sg-moved-sibling-rule-6641.test.ts`.
 */

const { mockSend, warn } = vi.hoisted(() => ({ mockSend: vi.fn(), warn: vi.fn() }));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    ec2: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
    ec2SingleSend: { send: mockSend },
  }),
}));

vi.mock('../../../src/utils/logger.js', () => {
  const child = { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() };
  return {
    getLogger: () => ({ child: () => child, debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() }),
  };
});

import { EC2Provider } from '../../../src/provisioning/providers/ec2-provider.js';
import { RESOURCE_NOT_FOUND } from '../../../src/types/resource.js';
import { ResourceUpdateNotSupportedError } from '../../../src/utils/error-handler.js';
import {
  siblingRecordedSgRuleIds,
  stripSiblingOwnedSgRules,
} from '../../../src/provisioning/sg-sibling-rules.js';
import { cfnSgRuleOfDescribed } from '../../../src/provisioning/providers/ec2/sg-rule-by-id.js';
import { refuseCcGroupRevertChangingRules } from '../../../src/provisioning/providers/ec2/sg-revert-guard.js';

const GROUP = 'sg-0aaaaaaaaaaaaaaaa';
const SIB_ID = 'sgr-0aaaaaaaaaaaaaaa1';
const INLINE_ID = 'sgr-0bbbbbbbbbbbbbbb1';
const STRANGER_ID = 'sgr-0ddddddddddddddd1';

interface Rule {
  id: string;
  port: number;
  cidr: string;
  egress?: boolean;
}
const INLINE: Rule = { id: INLINE_ID, port: 443, cidr: '10.0.0.0/16' };
const RECORDED = { IpProtocol: 'tcp', FromPort: 8443, ToPort: 8443, CidrIp: '10.1.0.0/16' };
const cfn = (r: Rule) => ({ IpProtocol: 'tcp', FromPort: r.port, ToPort: r.port, CidrIp: r.cidr });

/** The mocked EC2 holds `live`; both describe calls read it. */
let live: Rule[] = [];
let rulesFailure: Error | undefined;
function route(cmd: { constructor: { name: string }; input: Record<string, unknown> }) {
  const name = cmd.constructor.name;
  if (name === 'DescribeSecurityGroupsCommand') {
    const perms = (egress: boolean) =>
      live
        .filter((r) => (r.egress ?? false) === egress)
        .map((r) => ({ IpProtocol: 'tcp', FromPort: r.port, ToPort: r.port, IpRanges: [{ CidrIp: r.cidr }] }));
    return {
      SecurityGroups: [
        { GroupId: GROUP, GroupName: 'A', Description: 'A', VpcId: 'vpc-1', IpPermissions: perms(false), IpPermissionsEgress: perms(true) },
      ],
    };
  }
  if (name === 'DescribeSecurityGroupRulesCommand') {
    if (rulesFailure) throw rulesFailure;
    return {
      SecurityGroupRules: live.map((r) => ({
        SecurityGroupRuleId: r.id,
        GroupId: GROUP,
        IsEgress: r.egress ?? false,
        IpProtocol: 'tcp',
        FromPort: r.port,
        ToPort: r.port,
        CidrIpv4: r.cidr,
      })),
    };
  }
  return {};
}
const names = (): string[] =>
  mockSend.mock.calls.map(([c]) => (c as { constructor: { name: string } }).constructor.name);
const count = (name: string): number => names().filter((n) => n === name).length;

const sibling = (
  props: Record<string, unknown> = RECORDED,
  extra: Record<string, unknown> = { attributes: { Id: SIB_ID } },
  type = 'AWS::EC2::SecurityGroupIngress'
) => ({ resourceType: type, properties: { GroupId: GROUP, ...props }, ...extra });
const groupProps = { GroupDescription: 'A', VpcId: 'vpc-1', SecurityGroupIngress: [cfn(INLINE)] };

let provider: EC2Provider;
beforeEach(() => {
  mockSend.mockReset();
  mockSend.mockImplementation(async (cmd) => route(cmd));
  warn.mockReset();
  rulesFailure = undefined;
  provider = new EC2Provider();
});

describe('the group readback (go-to-k/cdkd#6641)', () => {
  const read = async (siblings: Record<string, unknown>, extra: Record<string, unknown> = {}, props = groupProps) =>
    (await provider.readCurrentState(GROUP, 'SgA', 'AWS::EC2::SecurityGroup', props, {
      siblings,
      ...extra,
    } as never)) as Record<string, unknown>;

  it('leaves out the live rule carrying a sibling id, though its ports moved', async () => {
    live = [INLINE, { id: SIB_ID, port: 8444, cidr: '10.1.0.0/16' }];
    expect((await read({ Rule: sibling() }))['SecurityGroupIngress']).toEqual([cfn(INLINE)]);
    expect(count('DescribeSecurityGroupRulesCommand')).toBe(1);
  });

  it("reports a stranger at the sibling's recorded identity and leaves out the sibling's widened rule (B1)", async () => {
    const widened: Rule = { id: SIB_ID, port: 22, cidr: '0.0.0.0/0' };
    const stranger: Rule = { id: STRANGER_ID, port: 8443, cidr: '10.1.0.0/16' };
    live = [INLINE, widened, stranger];
    expect((await read({ Rule: sibling() }))['SecurityGroupIngress']).toEqual([cfn(INLINE), cfn(stranger)]);
  });

  it('reads the ids once even when nothing moved (one call per group with an id-recording sibling)', async () => {
    live = [INLINE, { id: SIB_ID, port: 8443, cidr: '10.1.0.0/16' }];
    expect((await read({ Rule: sibling() }))['SecurityGroupIngress']).toEqual([cfn(INLINE)]);
    expect(count('DescribeSecurityGroupRulesCommand')).toBe(1);
  });

  it.each([
    ['no sibling records an id', { Rule: sibling(RECORDED, {}) }, {}],
    ['on the deploy capture', { Rule: sibling() }, { afterOwnWrite: true }],
  ])('matches by identity with no rule-id call when %s', async (_label, siblings, extra) => {
    live = [INLINE, { id: SIB_ID, port: 8443, cidr: '10.1.0.0/16' }];
    expect((await read(siblings, extra))['SecurityGroupIngress']).toEqual([cfn(INLINE)]);
    expect(count('DescribeSecurityGroupRulesCommand')).toBe(0);
  });

  it('falls back to identity matching, with a warning naming the permission, when the ids are denied', async () => {
    live = [INLINE, { id: SIB_ID, port: 8444, cidr: '10.1.0.0/16' }];
    rulesFailure = Object.assign(new Error('not authorized'), { name: 'UnauthorizedOperation' });
    expect((await read({ Rule: sibling() }))['SecurityGroupIngress']).toEqual([
      cfn(INLINE),
      cfn({ id: SIB_ID, port: 8444, cidr: '10.1.0.0/16' }),
    ]);
    expect(String(warn.mock.calls[0]?.[0])).toContain('ec2:DescribeSecurityGroupRules');
  });

  it('keeps hiding a rule re-authorized at a sibling record values when the sibling id is gone (no revoke of template-granted access)', async () => {
    live = [INLINE, { id: STRANGER_ID, port: 8443, cidr: '10.1.0.0/16' }];
    expect((await read({ Rule: sibling() }))['SecurityGroupIngress']).toEqual([cfn(INLINE)]);
  });

  it('matches #4492 twins by identity: a widened shared rule is reported on the group', async () => {
    const widened: Rule = { id: SIB_ID, port: 22, cidr: '192.0.2.0/24' };
    live = [INLINE, widened, { id: STRANGER_ID, port: 8443, cidr: '10.1.0.0/16' }];
    const bag = await read({ A: sibling(), B: sibling() });
    expect(bag['SecurityGroupIngress']).toEqual([cfn(INLINE), cfn(widened)]);
  });

  it("keeps a rule the group's own template also declares inline", async () => {
    const moved: Rule = { id: SIB_ID, port: 8444, cidr: '10.1.0.0/16' };
    live = [INLINE, moved];
    const props = { ...groupProps, SecurityGroupIngress: [cfn(INLINE), cfn(moved)] };
    expect((await read({ Rule: sibling() }, {}, props))['SecurityGroupIngress']).toEqual([cfn(INLINE), cfn(moved)]);
  });

  it('owns a moved egress rule a Cloud Control record names by its physical id', async () => {
    const moved: Rule = { id: SIB_ID, port: 8444, cidr: '10.1.0.0/16', egress: true };
    const inlineOut: Rule = { id: INLINE_ID, port: 443, cidr: '10.0.0.0/16', egress: true };
    live = [INLINE, inlineOut, moved];
    const props = { ...groupProps, SecurityGroupEgress: [cfn(inlineOut)] };
    const bag = await read(
      { Rule: sibling(RECORDED, { physicalId: SIB_ID }, 'AWS::EC2::SecurityGroupEgress') },
      {},
      props
    );
    expect(bag['SecurityGroupEgress']).toEqual([cfn(inlineOut)]);
  });
});

describe('the standalone ingress readback (go-to-k/cdkd#6641)', () => {
  const PHYS = `${GROUP}|tcp|8443|8443`;
  const read = (props: Record<string, unknown> = { GroupId: GROUP, ...RECORDED }, context: Record<string, unknown> = { attributes: { Id: SIB_ID } }) =>
    provider.readCurrentState(PHYS, 'SgARule', 'AWS::EC2::SecurityGroupIngress', props, context as never);

  it('reads the rule its id names after its ports moved: drift, not a deletion', async () => {
    live = [INLINE, { id: SIB_ID, port: 8444, cidr: '10.1.0.0/16' }];
    expect(await read()).toEqual({ GroupId: GROUP, ...RECORDED, FromPort: 8444, ToPort: 8444 });
    expect(count('DescribeSecurityGroupsCommand')).toBe(0);
  });

  it('reads the widened rule, not the stranger at its recorded identity (B1)', async () => {
    live = [INLINE, { id: SIB_ID, port: 22, cidr: '0.0.0.0/0' }, { id: STRANGER_ID, port: 8443, cidr: '10.1.0.0/16' }];
    expect(await read()).toEqual({ GroupId: GROUP, IpProtocol: 'tcp', FromPort: 22, ToPort: 22, CidrIp: '0.0.0.0/0' });
  });

  it('answers a rule that did not move in the record spelling, so it compares clean (M3)', async () => {
    live = [INLINE, { id: SIB_ID, port: 8443, cidr: '10.1.0.0/16' }];
    const props = { GroupId: GROUP, IpProtocol: '6', FromPort: '8443', ToPort: '8443', CidrIp: '10.1.0.5/16' };
    expect(await read(props)).toEqual(props);
  });

  it('matches by identity when the id is gone: a rule re-authorized at the record values is still the record\'s', async () => {
    live = [INLINE, { id: STRANGER_ID, port: 8443, cidr: '10.1.0.0/16' }];
    expect(await read()).toEqual({ GroupId: GROUP, ...RECORDED });
  });

  it('reads as deleted when the id is gone and nothing sits at the recorded identity', async () => {
    live = [INLINE];
    expect(await read()).toBe(RESOURCE_NOT_FOUND);
  });

  it.each([
    ['without a recorded id', { GroupId: GROUP, ...RECORDED }, {}],
    ['on the deploy capture', { GroupId: GROUP, ...RECORDED }, { attributes: { Id: SIB_ID }, afterOwnWrite: true }],
    ['when another record holds the same id', { GroupId: GROUP, ...RECORDED }, {
      attributes: { Id: SIB_ID },
      siblings: { Twin: { resourceType: 'AWS::EC2::SecurityGroupIngress', properties: { GroupId: GROUP, IpProtocol: 'tcp', FromPort: 1, ToPort: 1, CidrIp: '10.9.0.0/16' }, attributes: { Id: SIB_ID } } },
    }],
    ['for a peer named by group name', { GroupId: GROUP, IpProtocol: 'tcp', FromPort: 8443, ToPort: 8443, SourceSecurityGroupName: 'B' }, { attributes: { Id: SIB_ID } }],
    ['for a redacted identity value', { GroupId: GROUP, ...RECORDED, CidrIp: '***' }, { attributes: { Id: SIB_ID } }],
  ])('keeps the identity path %s', async (_label, props, context) => {
    live = [INLINE, { id: SIB_ID, port: 8443, cidr: '10.1.0.0/16' }];
    await read(props, context);
    expect(count('DescribeSecurityGroupsCommand')).toBeGreaterThan(0);
    expect(count('DescribeSecurityGroupRulesCommand')).toBe(0);
  });

  it('throws when the listing call fails, never reading a stranger by identity (the group may have assigned the rule by id)', async () => {
    live = [INLINE, { id: SIB_ID, port: 22, cidr: '192.0.2.0/24' }, { id: STRANGER_ID, port: 8443, cidr: '10.1.0.0/16' }];
    rulesFailure = Object.assign(new Error('Rate exceeded'), { name: 'Throttling' });
    await expect(read()).rejects.toThrow(/Rate exceeded/);
    expect(count('DescribeSecurityGroupsCommand')).toBe(0);
  });

  it('keeps the identity path when the listing has more pages than cdkd reads', async () => {
    live = [INLINE, { id: SIB_ID, port: 8443, cidr: '10.1.0.0/16' }];
    vi.spyOn(provider, 'listGroupRules').mockResolvedValue(undefined);
    expect(await read()).toEqual({ GroupId: GROUP, ...RECORDED });
    expect(count('DescribeSecurityGroupsCommand')).toBe(1);
  });
});

describe("the group's revert never revokes a standalone rule's live rule (go-to-k/cdkd#6641)", () => {
  const MOVED = { ...RECORDED, FromPort: 8444, ToPort: 8444 };
  const update = (context: Record<string, unknown>, previous: Array<Record<string, unknown>> = [cfn(INLINE), MOVED]) =>
    provider.update(
      'SgA',
      GROUP,
      'AWS::EC2::SecurityGroup',
      { ...groupProps, Tags: [{ Key: 'k', Value: 'v' }] },
      { ...groupProps, SecurityGroupIngress: previous },
      context as never
    );
  const writes = () => names().filter((n) => !n.startsWith('Describe'));

  it('refuses before ANY write (tags included) when a rule it would revoke carries a sibling id', async () => {
    live = [INLINE, { id: SIB_ID, port: 8444, cidr: '10.1.0.0/16' }];
    await expect(update({ desiredFromAwsReadback: true, siblingSgRuleIds: new Set([SIB_ID]) })).rejects.toBeInstanceOf(
      ResourceUpdateNotSupportedError
    );
    expect(writes()).toEqual([]);
  });

  it("revokes a stranger's rule, reading the ids once", async () => {
    live = [INLINE, { id: STRANGER_ID, port: 8444, cidr: '10.1.0.0/16' }];
    await update({ desiredFromAwsReadback: true, siblingSgRuleIds: new Set([SIB_ID]) });
    expect(writes()).toContain('RevokeSecurityGroupIngressCommand');
    expect(count('DescribeSecurityGroupRulesCommand')).toBe(1);
  });

  it('refuses before any write, naming the permission, when the ids are denied', async () => {
    live = [INLINE, { id: STRANGER_ID, port: 8444, cidr: '10.1.0.0/16' }];
    rulesFailure = Object.assign(new Error('not authorized'), { name: 'UnauthorizedOperation' });
    await expect(update({ desiredFromAwsReadback: true, siblingSgRuleIds: new Set([SIB_ID]) })).rejects.toThrow(
      /ec2:DescribeSecurityGroupRules/
    );
    expect(writes()).toEqual([]);
  });

  it.each([
    ['a revert that revokes nothing', { desiredFromAwsReadback: true, siblingSgRuleIds: new Set([SIB_ID]) }, [cfn(INLINE)]],
    ['a deploy', { siblingSgRuleIds: new Set([SIB_ID]) }, [cfn(INLINE), MOVED]],
  ])('makes no rule-id call on %s', async (_label, context, previous) => {
    live = [INLINE];
    await update(context, previous);
    expect(count('DescribeSecurityGroupRulesCommand')).toBe(0);
  });
});

describe('siblingRecordedSgRuleIds / cfnSgRuleOfDescribed', () => {
  it('collects attributes.Id and a Cloud Control physical id, on this group only, skipping malformed entries', () => {
    const ids = siblingRecordedSgRuleIds(GROUP, [
      ['A', { resourceType: 'AWS::EC2::SecurityGroupIngress', properties: { GroupId: GROUP, ...RECORDED }, attributes: { Id: SIB_ID } }],
      ['B', { resourceType: 'AWS::EC2::SecurityGroupEgress', physicalId: STRANGER_ID, properties: { GroupId: GROUP, ...RECORDED } }],
      ['C', { resourceType: 'AWS::EC2::SecurityGroupIngress', properties: { GroupId: 'sg-other' }, attributes: { Id: 'sgr-0c' } }],
      ['D', { resourceType: 'AWS::EC2::SecurityGroupIngress', physicalId: `${GROUP}|tcp|1|1`, properties: { GroupId: GROUP } }],
      ['E', null as never],
    ]);
    expect([...ids.keys()]).toEqual([SIB_ID, STRANGER_ID]);
  });

  it('spells an all-protocols rule without ports and an SG peer by direction', () => {
    expect(
      cfnSgRuleOfDescribed({
        IsEgress: false,
        IpProtocol: '-1',
        FromPort: -1,
        ToPort: -1,
        ReferencedGroupInfo: { GroupId: 'sg-peer', UserId: '123456789012' },
      })
    ).toEqual({ IpProtocol: '-1', SourceSecurityGroupId: 'sg-peer', SourceSecurityGroupOwnerId: '123456789012' });
    expect(cfnSgRuleOfDescribed({ IsEgress: true, IpProtocol: 'tcp', FromPort: 1, ToPort: 2, PrefixListId: 'pl-1' })).toEqual({
      IpProtocol: 'tcp',
      FromPort: 1,
      ToPort: 2,
      DestinationPrefixListId: 'pl-1',
    });
  });
});

describe('the drift-side live strip by route (go-to-k/cdkd#6641)', () => {
  const unmoved = cfn({ id: SIB_ID, port: 8443, cidr: '10.1.0.0/16' });
  const strip = (extra: Record<string, unknown>) =>
    stripSiblingOwnedSgRules(
      'AWS::EC2::SecurityGroup',
      GROUP,
      { SecurityGroupIngress: [cfn(INLINE)] },
      { SecurityGroupIngress: [cfn(INLINE), unmoved] },
      groupProps,
      { siblings: { Rule: sibling() }, ...extra } as never
    ).aws['SecurityGroupIngress'];

  it("leaves a rule at an id-decided sibling's identity on the SDK route (the readback placed it by id)", () => {
    expect(strip({})).toEqual([cfn(INLINE), unmoved]);
  });

  it('strips it by identity on the Cloud Control route, which assigns nothing by id', () => {
    expect(strip({ ccApiRead: true })).toEqual([cfn(INLINE)]);
  });
});

describe("a Cloud Control group's revert refuses a rule-list change when a standalone rule may target it (go-to-k/cdkd#6641)", () => {
  const previous = { SecurityGroupIngress: [cfn(INLINE), cfn({ id: STRANGER_ID, port: 9999, cidr: '10.9.0.0/16' })] };
  const desired = { SecurityGroupIngress: [cfn(INLINE)] };
  const run = (ruleProps: Record<string, unknown>, groupName?: string) => () =>
    refuseCcGroupRevertChangingRules(
      'SgA',
      GROUP,
      'AWS::EC2::SecurityGroup',
      desired,
      previous,
      [['Rule', { resourceType: 'AWS::EC2::SecurityGroupIngress', properties: { ...RECORDED, ...ruleProps } }]],
      groupName
    );

  it.each([
    ['its id', { GroupId: GROUP }, undefined],
    ['its name (a default-VPC rule)', { GroupName: 'web' }, 'web'],
    ['a redacted id and no name', { GroupId: '***' }, 'web'],
    ['an unresolved id and no name', { GroupId: { Ref: 'Sg' } }, 'web'],
  ])('refuses when a rule record targets the group by %s', (_label, ruleProps, groupName) => {
    expect(run(ruleProps, groupName)).toThrow(ResourceUpdateNotSupportedError);
  });

  it.each([
    ['another group id', { GroupId: 'sg-0ffffffffffffffff' }, 'web'],
    ['another group name', { GroupName: 'other' }, 'web'],
  ])('lets the revert through when the only rule record targets %s', (_label, ruleProps, groupName) => {
    expect(run(ruleProps, groupName)).not.toThrow();
  });
});
