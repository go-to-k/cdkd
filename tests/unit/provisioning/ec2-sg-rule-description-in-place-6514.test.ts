import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  AuthorizeSecurityGroupEgressCommand,
  AuthorizeSecurityGroupIngressCommand,
  RevokeSecurityGroupEgressCommand,
  RevokeSecurityGroupIngressCommand,
  UpdateSecurityGroupRuleDescriptionsEgressCommand,
  UpdateSecurityGroupRuleDescriptionsIngressCommand,
} from '@aws-sdk/client-ec2';

const mockSend = vi.hoisted(() => vi.fn());

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    ec2: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
    ec2SingleSend: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
  }),
}));

const { childLogger } = vi.hoisted(() => ({
  childLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn((): unknown => childLogger) },
}));

vi.mock('../../../src/utils/logger.js', () => {
  return {
    getLogger: () => ({
      child: () => childLogger,
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  };
});

import { EC2Provider } from '../../../src/provisioning/providers/ec2-provider.js';
import { withStackRecords } from '../../../src/deployment/stack-records-scope.js';
import type { ResourceState } from '../../../src/types/state.js';
import { awsSdkError } from '../_aws-sdk-error.js';

/**
 * go-to-k/cdkd#6514: a description-only edit of a security group rule is
 * applied in place (`UpdateSecurityGroupRuleDescriptions*`), as CloudFormation
 * does: the rule keeps its `sgr-` id and is never revoked.
 */
const GROUP_ID = 'sg-0123456789abcdef0';
const PEER_ID = 'sg-0fedcba9876543210';
const RULE_ID = 'sgr-0a1b2c3d4e5f60718';

const sent = () => mockSend.mock.calls.map((c) => c[0] as { constructor: unknown; input: unknown });
const sentOf = <T>(ctor: new (...args: never[]) => T) => sent().filter((c): c is T & { input: unknown } => c instanceof ctor);
const revokesOrAuthorizes = () =>
  sent().filter(
    (c) =>
      c instanceof RevokeSecurityGroupIngressCommand ||
      c instanceof RevokeSecurityGroupEgressCommand ||
      c instanceof AuthorizeSecurityGroupIngressCommand ||
      c instanceof AuthorizeSecurityGroupEgressCommand
  );
const permissionNotFound = () =>
  Promise.reject(
    Object.assign(new Error('The specified rule does not exist in this security group.'), {
      name: 'InvalidPermission.NotFound',
    })
  );

let provider: EC2Provider;

beforeEach(() => {
  vi.clearAllMocks();
  provider = new EC2Provider();
  mockSend.mockResolvedValue({ Return: true });
});

describe('inline SecurityGroup rules: a description-only change is in place (#6514)', () => {
  const INGRESS = { IpProtocol: 'tcp', FromPort: 443, ToPort: 443, CidrIp: '10.0.0.0/16', Description: 'v1' };
  const EGRESS = {
    IpProtocol: 'tcp',
    FromPort: 443,
    ToPort: 443,
    DestinationSecurityGroupId: PEER_ID,
    Description: 'v1',
  };

  it('ingress: one UpdateSecurityGroupRuleDescriptionsIngress carrying the new description, no revoke / authorize', async () => {
    await provider.applySecurityGroupRuleDiff(
      GROUP_ID,
      [INGRESS],
      [{ ...INGRESS, Description: 'v2' }],
      'ingress',
      'Sg'
    );

    expect(revokesOrAuthorizes()).toEqual([]);
    const updates = sentOf(UpdateSecurityGroupRuleDescriptionsIngressCommand);
    expect(updates.map((c) => c.input)).toEqual([
      {
        GroupId: GROUP_ID,
        IpPermissions: [
          {
            IpProtocol: 'tcp',
            FromPort: 443,
            ToPort: 443,
            IpRanges: [{ CidrIp: '10.0.0.0/16', Description: 'v2' }],
          },
        ],
      },
    ]);
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it('ingress: a removed description sends the permission with none, which clears it', async () => {
    const { Description: _omit, ...withoutDescription } = INGRESS;
    await provider.applySecurityGroupRuleDiff(GROUP_ID, [INGRESS], [withoutDescription], 'ingress', 'Sg');

    expect(revokesOrAuthorizes()).toEqual([]);
    expect(sentOf(UpdateSecurityGroupRuleDescriptionsIngressCommand).map((c) => c.input)).toEqual([
      {
        GroupId: GROUP_ID,
        IpPermissions: [{ IpProtocol: 'tcp', FromPort: 443, ToPort: 443, IpRanges: [{ CidrIp: '10.0.0.0/16' }] }],
      },
    ]);
  });

  it('ingress: a peer named by group name keeps its name on the description call (#5478 inline flag)', async () => {
    const named = { IpProtocol: 'tcp', FromPort: 22, ToPort: 22, SourceSecurityGroupName: 'default', Description: 'v1' };
    await provider.applySecurityGroupRuleDiff(GROUP_ID, [named], [{ ...named, Description: 'v2' }], 'ingress', 'Sg');

    expect(revokesOrAuthorizes()).toEqual([]);
    expect(sentOf(UpdateSecurityGroupRuleDescriptionsIngressCommand).map((c) => c.input)).toEqual([
      {
        GroupId: GROUP_ID,
        IpPermissions: [
          {
            IpProtocol: 'tcp',
            FromPort: 22,
            ToPort: 22,
            UserIdGroupPairs: [{ GroupName: 'default', Description: 'v2' }],
          },
        ],
      },
    ]);
  });

  it('egress: one UpdateSecurityGroupRuleDescriptionsEgress, no revoke / authorize', async () => {
    await provider.applySecurityGroupRuleDiff(GROUP_ID, [EGRESS], [{ ...EGRESS, Description: 'v2' }], 'egress', 'Sg');

    expect(revokesOrAuthorizes()).toEqual([]);
    expect(sentOf(UpdateSecurityGroupRuleDescriptionsIngressCommand)).toEqual([]);
    expect(sentOf(UpdateSecurityGroupRuleDescriptionsEgressCommand).map((c) => c.input)).toEqual([
      {
        GroupId: GROUP_ID,
        IpPermissions: [
          {
            IpProtocol: 'tcp',
            FromPort: 443,
            ToPort: 443,
            UserIdGroupPairs: [{ GroupId: PEER_ID, Description: 'v2' }],
          },
        ],
      },
    ]);
  });

  it('an unchanged rule makes no AWS call at all', async () => {
    await provider.applySecurityGroupRuleDiff(GROUP_ID, [INGRESS], [{ ...INGRESS }], 'ingress', 'Sg');
    await provider.applySecurityGroupRuleDiff(GROUP_ID, [EGRESS], [{ ...EGRESS }], 'egress', 'Sg');

    expect(mockSend).not.toHaveBeenCalled();
  });

  it('a protocol spelled by number on one side is still the same rule (#1643 canonicalization)', async () => {
    await provider.applySecurityGroupRuleDiff(
      GROUP_ID,
      [{ ...INGRESS, IpProtocol: 'tcp' }],
      [{ ...INGRESS, IpProtocol: '6', Description: 'v2' }],
      'ingress',
      'Sg'
    );

    expect(revokesOrAuthorizes()).toEqual([]);
    expect(sentOf(UpdateSecurityGroupRuleDescriptionsIngressCommand)).toHaveLength(1);
  });

  it('an identity change is still a revoke + authorize, with no description call', async () => {
    await provider.applySecurityGroupRuleDiff(
      GROUP_ID,
      [INGRESS],
      [{ ...INGRESS, CidrIp: '10.1.0.0/16', Description: 'v2' }],
      'ingress',
      'Sg'
    );

    expect(sentOf(UpdateSecurityGroupRuleDescriptionsIngressCommand)).toEqual([]);
    expect(sentOf(RevokeSecurityGroupIngressCommand)).toHaveLength(1);
    expect(sentOf(AuthorizeSecurityGroupIngressCommand)).toHaveLength(1);
  });

  it('a rule revoked out of band (InvalidPermission.NotFound) is authorized again', async () => {
    mockSend.mockImplementation((command: unknown) =>
      command instanceof UpdateSecurityGroupRuleDescriptionsEgressCommand
        ? permissionNotFound()
        : Promise.resolve({ Return: true })
    );

    await provider.applySecurityGroupRuleDiff(GROUP_ID, [EGRESS], [{ ...EGRESS, Description: 'v2' }], 'egress', 'Sg');

    expect(sentOf(RevokeSecurityGroupEgressCommand)).toEqual([]);
    expect(sentOf(AuthorizeSecurityGroupEgressCommand).map((c) => c.input)).toEqual([
      {
        GroupId: GROUP_ID,
        IpPermissions: [
          {
            IpProtocol: 'tcp',
            FromPort: 443,
            ToPort: 443,
            UserIdGroupPairs: [{ GroupId: PEER_ID, Description: 'v2' }],
          },
        ],
      },
    ]);
  });

  it('any other description failure is thrown', async () => {
    mockSend.mockRejectedValue(Object.assign(new Error('denied'), { name: 'UnauthorizedOperation' }));

    await expect(
      provider.applySecurityGroupRuleDiff(GROUP_ID, [INGRESS], [{ ...INGRESS, Description: 'v2' }], 'ingress', 'Sg')
    ).rejects.toThrow('denied');
  });

  it('a rule the update removes is revoked BEFORE a description call that then fails', async () => {
    const removed = { IpProtocol: 'tcp', FromPort: 22, ToPort: 22, CidrIp: '0.0.0.0/0' };
    mockSend.mockImplementation((command: unknown) =>
      command instanceof UpdateSecurityGroupRuleDescriptionsIngressCommand
        ? Promise.reject(Object.assign(new Error('denied'), { name: 'UnauthorizedOperation' }))
        : Promise.resolve({ Return: true })
    );

    await expect(
      provider.applySecurityGroupRuleDiff(
        GROUP_ID,
        [INGRESS, removed],
        [{ ...INGRESS, Description: 'v2' }],
        'ingress',
        'Sg'
      )
    ).rejects.toThrow('denied');

    const order = sent().map((c) => (c as { constructor: { name: string } }).constructor.name);
    expect(order).toEqual(['RevokeSecurityGroupIngressCommand', 'UpdateSecurityGroupRuleDescriptionsIngressCommand']);
    expect(sentOf(RevokeSecurityGroupIngressCommand)[0]!.input).toEqual({
      GroupId: GROUP_ID,
      IpPermissions: [{ IpProtocol: 'tcp', FromPort: 22, ToPort: 22, IpRanges: [{ CidrIp: '0.0.0.0/0' }] }],
    });
  });

  it('a redacted desired description (a state-borne caller) is never sent as the live one', async () => {
    await provider.applySecurityGroupRuleDiff(GROUP_ID, [INGRESS], [{ ...INGRESS, Description: '***' }], 'ingress', 'Sg');

    expect(mockSend).not.toHaveBeenCalled();
  });

  it('an ingress rule a standalone record of the stack also holds keeps its description (#4492)', async () => {
    const standalone = {
      physicalId: `${GROUP_ID}|tcp|443|443`,
      resourceType: 'AWS::EC2::SecurityGroupIngress',
      properties: { GroupId: GROUP_ID, ...INGRESS },
      attributes: { Id: RULE_ID },
      dependencies: [],
    } as unknown as ResourceState;
    const view = { live: () => [['Standalone', standalone] as const], survivors: () => [['Standalone', standalone] as const] };

    await withStackRecords(view, () =>
      provider.applySecurityGroupRuleDiff(GROUP_ID, [INGRESS], [{ ...INGRESS, Description: 'v2' }], 'ingress', 'Sg')
    );

    expect(mockSend).not.toHaveBeenCalled();
  });
});

describe('standalone SecurityGroupIngress: a description-only change is in place (#6514)', () => {
  const TYPE = 'AWS::EC2::SecurityGroupIngress';
  const PHYSICAL_ID = `${GROUP_ID}|tcp|8443|8443`;
  const RULE = Object.freeze({
    GroupId: GROUP_ID,
    IpProtocol: 'tcp',
    FromPort: 8443,
    ToPort: 8443,
    CidrIp: '10.0.0.0/16',
    Description: 'v1',
  }) as Record<string, unknown>;

  const update = (desired: Record<string, unknown>) =>
    provider.update('Standalone', PHYSICAL_ID, TYPE, desired, RULE, { recordedAttributes: { Id: RULE_ID } });

  it('one UpdateSecurityGroupRuleDescriptionsIngress, no revoke / authorize, not replaced, the rule id kept', async () => {
    const result = await update({ ...RULE, Description: 'v2' });

    expect(revokesOrAuthorizes()).toEqual([]);
    expect(sentOf(UpdateSecurityGroupRuleDescriptionsIngressCommand).map((c) => c.input)).toEqual([
      {
        GroupId: GROUP_ID,
        IpPermissions: [
          {
            IpProtocol: 'tcp',
            FromPort: 8443,
            ToPort: 8443,
            IpRanges: [{ CidrIp: '10.0.0.0/16', Description: 'v2' }],
          },
        ],
      },
    ]);
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ physicalId: PHYSICAL_ID, wasReplaced: false, attributes: { Id: RULE_ID } });
  });

  it('a removed description sends the permission with none, which clears it', async () => {
    const { Description: _omit, ...withoutDescription } = RULE;
    const result = await update(withoutDescription);

    expect(revokesOrAuthorizes()).toEqual([]);
    expect(sentOf(UpdateSecurityGroupRuleDescriptionsIngressCommand).map((c) => c.input)).toEqual([
      {
        GroupId: GROUP_ID,
        IpPermissions: [{ IpProtocol: 'tcp', FromPort: 8443, ToPort: 8443, IpRanges: [{ CidrIp: '10.0.0.0/16' }] }],
      },
    ]);
    expect(result).toMatchObject({ wasReplaced: false, attributes: { Id: RULE_ID } });
  });

  it('an identity change is still a revoke + authorize, replaced, with no description call', async () => {
    mockSend.mockImplementation((command: unknown) =>
      command instanceof AuthorizeSecurityGroupIngressCommand
        ? Promise.resolve({ SecurityGroupRules: [{ SecurityGroupRuleId: 'sgr-0ddddddddddddddd0' }] })
        : Promise.resolve({ Return: true })
    );

    const result = await update({ ...RULE, CidrIp: '10.1.0.0/16', Description: 'v2' });

    expect(sentOf(UpdateSecurityGroupRuleDescriptionsIngressCommand)).toEqual([]);
    expect(sentOf(RevokeSecurityGroupIngressCommand).map((c) => c.input)).toEqual([
      { GroupId: GROUP_ID, SecurityGroupRuleIds: [RULE_ID] },
    ]);
    expect(sentOf(AuthorizeSecurityGroupIngressCommand)).toHaveLength(1);
    expect(result).toMatchObject({ wasReplaced: true, attributes: { Id: 'sgr-0ddddddddddddddd0' } });
  });

  it('a rule revoked out of band falls through to the revoke + authorize that re-creates it', async () => {
    mockSend.mockImplementation((command: unknown) => {
      if (command instanceof UpdateSecurityGroupRuleDescriptionsIngressCommand) return permissionNotFound();
      if (command instanceof AuthorizeSecurityGroupIngressCommand) {
        return Promise.resolve({ SecurityGroupRules: [{ SecurityGroupRuleId: 'sgr-0ddddddddddddddd0' }] });
      }
      return Promise.resolve({ Return: true });
    });

    const result = await update({ ...RULE, Description: 'v2' });

    expect(sentOf(AuthorizeSecurityGroupIngressCommand)).toHaveLength(1);
    expect(result).toMatchObject({ wasReplaced: true, attributes: { Id: 'sgr-0ddddddddddddddd0' } });
  });

  it('a failed description call names the AWS failure by its class, not its text', async () => {
    const error = awsSdkError(
      'User arn:aws:iam::123456789012:user/secret-name is not authorized',
      'UnauthorizedOperation'
    );
    Object.assign(error, { $fault: 'client' });
    mockSend.mockRejectedValue(error);

    const failure = await update({ ...RULE, Description: 'v2' }).then(
      () => undefined,
      (error: unknown) => error as Error
    );

    expect(failure?.message).toContain('Failed to update the description of SecurityGroupIngress Standalone');
    expect(failure?.message).not.toContain('secret-name');
    expect(revokesOrAuthorizes()).toEqual([]);
  });
});
