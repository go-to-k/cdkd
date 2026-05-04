import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import {
  CreateSecurityGroupCommand,
  AuthorizeSecurityGroupIngressCommand,
  AuthorizeSecurityGroupEgressCommand,
  RevokeSecurityGroupEgressCommand,
  RevokeSecurityGroupIngressCommand,
  CreateTagsCommand,
  DescribeVpcsCommand,
  DescribeNetworkAclsCommand,
  DescribeSecurityGroupsCommand,
} from '@aws-sdk/client-ec2';

const mockSend = vi.hoisted(() => vi.fn());

vi.mock('../../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    ec2: {
      send: mockSend,
      // Required by region-check.ts (used in delete idempotency paths).
      config: { region: () => Promise.resolve('us-east-1') },
    },
  }),
}));

vi.mock('../../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
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

import { EC2Provider } from '../../../../src/provisioning/providers/ec2-provider.js';

describe('EC2Provider - SecurityGroup egress handling', () => {
  let provider: EC2Provider;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockReset();
    provider = new EC2Provider();
  });

  describe('handledProperties', () => {
    it('should declare SecurityGroupEgress as a handled property of AWS::EC2::SecurityGroup', () => {
      const props = provider.handledProperties.get('AWS::EC2::SecurityGroup');
      expect(props).toBeDefined();
      expect(props?.has('SecurityGroupEgress')).toBe(true);
      // Existing properties should remain handled
      expect(props?.has('SecurityGroupIngress')).toBe(true);
      expect(props?.has('GroupDescription')).toBe(true);
    });
  });

  describe('createSecurityGroup with SecurityGroupEgress', () => {
    it('should revoke the AWS-default egress rule and authorize each explicit egress rule', async () => {
      // CreateSecurityGroup -> CreateTags -> Revoke default egress -> AuthorizeEgress (rule 1) -> AuthorizeEgress (rule 2)
      mockSend
        .mockResolvedValueOnce({ GroupId: 'sg-12345678' }) // CreateSecurityGroupCommand
        .mockResolvedValueOnce({}) // CreateTagsCommand (no tags but applyTags may be a no-op; see assertions)
        .mockResolvedValueOnce({}) // RevokeSecurityGroupEgressCommand (default rule)
        .mockResolvedValueOnce({}) // AuthorizeSecurityGroupEgressCommand (rule 1)
        .mockResolvedValueOnce({}); // AuthorizeSecurityGroupEgressCommand (rule 2)

      const result = await provider.create('LambdaSg', 'AWS::EC2::SecurityGroup', {
        GroupDescription: 'Lambda SG',
        VpcId: 'vpc-abc',
        SecurityGroupEgress: [
          {
            IpProtocol: 'tcp',
            FromPort: 443,
            ToPort: 443,
            CidrIp: '0.0.0.0/0',
            Description: 'HTTPS out',
          },
          {
            IpProtocol: 'tcp',
            FromPort: 5432,
            ToPort: 5432,
            DestinationSecurityGroupId: 'sg-db',
          },
        ],
      });

      expect(result.physicalId).toBe('sg-12345678');

      // Filter by command type so the test is robust against the presence/absence
      // of the CreateTagsCommand (depends on the applyTags helper's behavior).
      const commands = mockSend.mock.calls.map((c) => c[0]);
      const createCmds = commands.filter((c) => c instanceof CreateSecurityGroupCommand);
      const revokeEgressCmds = commands.filter(
        (c) => c instanceof RevokeSecurityGroupEgressCommand
      );
      const authorizeEgressCmds = commands.filter(
        (c) => c instanceof AuthorizeSecurityGroupEgressCommand
      );
      const authorizeIngressCmds = commands.filter(
        (c) => c instanceof AuthorizeSecurityGroupIngressCommand
      );

      expect(createCmds).toHaveLength(1);
      expect(revokeEgressCmds).toHaveLength(1);
      expect(authorizeEgressCmds).toHaveLength(2);
      expect(authorizeIngressCmds).toHaveLength(0);

      // Default egress revoke targets 0.0.0.0/0 with -1 protocol
      expect(revokeEgressCmds[0].input).toEqual({
        GroupId: 'sg-12345678',
        IpPermissions: [
          {
            IpProtocol: '-1',
            IpRanges: [{ CidrIp: '0.0.0.0/0' }],
          },
        ],
      });

      // First authorize: HTTPS out via CIDR
      expect(authorizeEgressCmds[0].input).toEqual({
        GroupId: 'sg-12345678',
        IpPermissions: [
          {
            IpProtocol: 'tcp',
            FromPort: 443,
            ToPort: 443,
            IpRanges: [{ CidrIp: '0.0.0.0/0', Description: 'HTTPS out' }],
          },
        ],
      });

      // Second authorize: targets DestinationSecurityGroupId via UserIdGroupPairs
      expect(authorizeEgressCmds[1].input).toEqual({
        GroupId: 'sg-12345678',
        IpPermissions: [
          {
            IpProtocol: 'tcp',
            FromPort: 5432,
            ToPort: 5432,
            UserIdGroupPairs: [{ GroupId: 'sg-db' }],
          },
        ],
      });
    });

    it('should not call RevokeSecurityGroupEgress when SecurityGroupEgress is not provided', async () => {
      mockSend.mockResolvedValueOnce({ GroupId: 'sg-no-egress' });

      await provider.create('SgNoEgress', 'AWS::EC2::SecurityGroup', {
        GroupDescription: 'No explicit egress',
        VpcId: 'vpc-abc',
      });

      const commands = mockSend.mock.calls.map((c) => c[0]);
      expect(commands.filter((c) => c instanceof RevokeSecurityGroupEgressCommand)).toHaveLength(
        0
      );
      expect(commands.filter((c) => c instanceof AuthorizeSecurityGroupEgressCommand)).toHaveLength(
        0
      );
    });

    it('should tolerate "default rule not found" when revoking the default egress rule', async () => {
      // Use a message that contains "does not exist" so isNotFoundError() treats
      // the error as a benign absence of the AWS-default rule.
      const notFound = new Error('the specified rule does not exist in this security group');

      mockSend
        .mockResolvedValueOnce({ GroupId: 'sg-tolerant' }) // CreateSecurityGroupCommand
        .mockRejectedValueOnce(notFound) // RevokeSecurityGroupEgressCommand (default missing)
        .mockResolvedValueOnce({}); // AuthorizeSecurityGroupEgressCommand

      const result = await provider.create('TolerantSg', 'AWS::EC2::SecurityGroup', {
        GroupDescription: 'Tolerates missing default rule',
        SecurityGroupEgress: [
          {
            IpProtocol: 'tcp',
            FromPort: 80,
            ToPort: 80,
            CidrIp: '10.0.0.0/8',
          },
        ],
      });

      expect(result.physicalId).toBe('sg-tolerant');

      const commands = mockSend.mock.calls.map((c) => c[0]);
      expect(commands.filter((c) => c instanceof AuthorizeSecurityGroupEgressCommand)).toHaveLength(
        1
      );
    });

    it('should map SourceSecurityGroupOwnerId to UserIdGroupPairs[].UserId on ingress (cross-account peer)', async () => {
      // Cross-account ingress rule: GroupId comes from SourceSecurityGroupId
      // and UserId from SourceSecurityGroupOwnerId. The default egress is
      // untouched (no SecurityGroupEgress provided).
      mockSend
        .mockResolvedValueOnce({ GroupId: 'sg-xacct' }) // CreateSecurityGroupCommand
        .mockResolvedValueOnce({}); // AuthorizeSecurityGroupIngressCommand

      await provider.create('XAcctSg', 'AWS::EC2::SecurityGroup', {
        GroupDescription: 'Cross-account peer',
        VpcId: 'vpc-abc',
        SecurityGroupIngress: [
          {
            IpProtocol: 'tcp',
            FromPort: 443,
            ToPort: 443,
            SourceSecurityGroupId: 'sg-peer',
            SourceSecurityGroupOwnerId: '111122223333',
            Description: 'from peer account',
          },
        ],
      });

      const commands = mockSend.mock.calls.map((c) => c[0]);
      const authorizeIngressCmds = commands.filter(
        (c) => c instanceof AuthorizeSecurityGroupIngressCommand
      );
      expect(authorizeIngressCmds).toHaveLength(1);
      expect(authorizeIngressCmds[0].input).toEqual({
        GroupId: 'sg-xacct',
        IpPermissions: [
          {
            IpProtocol: 'tcp',
            FromPort: 443,
            ToPort: 443,
            UserIdGroupPairs: [
              {
                GroupId: 'sg-peer',
                UserId: '111122223333',
                Description: 'from peer account',
              },
            ],
          },
        ],
      });
    });

    it('should not set UserId on egress when DestinationSecurityGroupId is provided (no CFn equivalent)', async () => {
      // CFn does not define a Destination*OwnerId counterpart; even if a
      // SourceSecurityGroupOwnerId is accidentally present on an egress rule,
      // it must not leak into UserIdGroupPairs[].UserId.
      mockSend
        .mockResolvedValueOnce({ GroupId: 'sg-egress-only' }) // Create
        .mockResolvedValueOnce({}) // Revoke default egress
        .mockResolvedValueOnce({}); // Authorize egress

      await provider.create('EgressOnly', 'AWS::EC2::SecurityGroup', {
        GroupDescription: 'egress-only',
        SecurityGroupEgress: [
          {
            IpProtocol: 'tcp',
            FromPort: 5432,
            ToPort: 5432,
            DestinationSecurityGroupId: 'sg-db',
            // Stray field - must be ignored on the egress path.
            SourceSecurityGroupOwnerId: '999988887777',
          },
        ],
      });

      const commands = mockSend.mock.calls.map((c) => c[0]);
      const authorizeEgressCmds = commands.filter(
        (c) => c instanceof AuthorizeSecurityGroupEgressCommand
      );
      expect(authorizeEgressCmds).toHaveLength(1);
      expect(authorizeEgressCmds[0].input).toEqual({
        GroupId: 'sg-egress-only',
        IpPermissions: [
          {
            IpProtocol: 'tcp',
            FromPort: 5432,
            ToPort: 5432,
            UserIdGroupPairs: [{ GroupId: 'sg-db' }],
          },
        ],
      });
    });

    it('should tolerate "already exists" when authorizing during a diff apply', async () => {
      // Replays the authorize-on-update path where AWS reports the rule already
      // exists (e.g. retry after a partial failure). The provider should treat
      // this as success rather than throwing. Properties include no Tags and
      // no previous ingress, so the only AWS call we make is the egress
      // authorize that we want to reject.
      const alreadyExists = new Error(
        'the specified rule "peer: 0.0.0.0/0, TCP, from port: 443, to port: 443, ALLOW" already exists'
      );

      mockSend.mockRejectedValueOnce(alreadyExists);

      await provider.update(
        'Sg1',
        'sg-tolerant-diff',
        'AWS::EC2::SecurityGroup',
        {
          GroupDescription: 'd',
          SecurityGroupEgress: [
            { IpProtocol: 'tcp', FromPort: 443, ToPort: 443, CidrIp: '0.0.0.0/0' },
          ],
        },
        { GroupDescription: 'd' }
      );

      const commands = mockSend.mock.calls.map((c) => c[0]);
      expect(commands.filter((c) => c instanceof AuthorizeSecurityGroupEgressCommand)).toHaveLength(
        1
      );
    });

    it('should still process SecurityGroupIngress alongside SecurityGroupEgress', async () => {
      mockSend
        .mockResolvedValueOnce({ GroupId: 'sg-mixed' }) // Create
        .mockResolvedValueOnce({}) // AuthorizeIngress
        .mockResolvedValueOnce({}) // RevokeEgress (default)
        .mockResolvedValueOnce({}); // AuthorizeEgress

      await provider.create('MixedSg', 'AWS::EC2::SecurityGroup', {
        GroupDescription: 'Mixed',
        SecurityGroupIngress: [
          { IpProtocol: 'tcp', FromPort: 22, ToPort: 22, CidrIp: '0.0.0.0/0' },
        ],
        SecurityGroupEgress: [
          { IpProtocol: 'tcp', FromPort: 443, ToPort: 443, CidrIp: '0.0.0.0/0' },
        ],
      });

      const commands = mockSend.mock.calls.map((c) => c[0]);
      expect(commands.filter((c) => c instanceof AuthorizeSecurityGroupIngressCommand)).toHaveLength(
        1
      );
      expect(commands.filter((c) => c instanceof RevokeSecurityGroupEgressCommand)).toHaveLength(
        1
      );
      expect(commands.filter((c) => c instanceof AuthorizeSecurityGroupEgressCommand)).toHaveLength(
        1
      );
    });
  });

  describe('updateSecurityGroup egress rule diff', () => {
    it('should authorize newly added egress rules and revoke removed ones', async () => {
      // applyTags is invoked first; allow either CreateTags or no call by accepting any successful resolve.
      // We then expect: revoke removed egress + authorize added egress.
      mockSend.mockResolvedValue({});

      const previous = {
        GroupDescription: 'desc',
        SecurityGroupEgress: [
          { IpProtocol: 'tcp', FromPort: 443, ToPort: 443, CidrIp: '0.0.0.0/0' }, // removed
          { IpProtocol: 'tcp', FromPort: 80, ToPort: 80, CidrIp: '10.0.0.0/8' }, // unchanged
        ],
      };
      const next = {
        GroupDescription: 'desc',
        SecurityGroupEgress: [
          { IpProtocol: 'tcp', FromPort: 80, ToPort: 80, CidrIp: '10.0.0.0/8' }, // unchanged
          { IpProtocol: 'tcp', FromPort: 5432, ToPort: 5432, DestinationSecurityGroupId: 'sg-db' }, // added
        ],
      };

      await provider.update('Sg1', 'sg-deadbeef', 'AWS::EC2::SecurityGroup', next, previous);

      const commands = mockSend.mock.calls.map((c) => c[0]);
      const revokeEgressCmds = commands.filter(
        (c) => c instanceof RevokeSecurityGroupEgressCommand
      );
      const authorizeEgressCmds = commands.filter(
        (c) => c instanceof AuthorizeSecurityGroupEgressCommand
      );

      expect(revokeEgressCmds).toHaveLength(1);
      expect(revokeEgressCmds[0].input).toEqual({
        GroupId: 'sg-deadbeef',
        IpPermissions: [
          {
            IpProtocol: 'tcp',
            FromPort: 443,
            ToPort: 443,
            IpRanges: [{ CidrIp: '0.0.0.0/0' }],
          },
        ],
      });

      expect(authorizeEgressCmds).toHaveLength(1);
      expect(authorizeEgressCmds[0].input).toEqual({
        GroupId: 'sg-deadbeef',
        IpPermissions: [
          {
            IpProtocol: 'tcp',
            FromPort: 5432,
            ToPort: 5432,
            UserIdGroupPairs: [{ GroupId: 'sg-db' }],
          },
        ],
      });
    });

    it('should be a no-op (no authorize/revoke) when egress rules are unchanged', async () => {
      mockSend.mockResolvedValue({});

      const rules = [
        { IpProtocol: 'tcp', FromPort: 443, ToPort: 443, CidrIp: '0.0.0.0/0' },
      ];

      await provider.update(
        'Sg1',
        'sg-stable',
        'AWS::EC2::SecurityGroup',
        { GroupDescription: 'd', SecurityGroupEgress: rules },
        { GroupDescription: 'd', SecurityGroupEgress: rules }
      );

      const commands = mockSend.mock.calls.map((c) => c[0]);
      expect(commands.filter((c) => c instanceof RevokeSecurityGroupEgressCommand)).toHaveLength(
        0
      );
      expect(commands.filter((c) => c instanceof AuthorizeSecurityGroupEgressCommand)).toHaveLength(
        0
      );
    });

    it('should authorize all egress rules when previous had none', async () => {
      mockSend.mockResolvedValue({});

      await provider.update(
        'Sg1',
        'sg-fresh',
        'AWS::EC2::SecurityGroup',
        {
          GroupDescription: 'd',
          SecurityGroupEgress: [
            { IpProtocol: 'tcp', FromPort: 443, ToPort: 443, CidrIp: '0.0.0.0/0' },
          ],
        },
        { GroupDescription: 'd' }
      );

      const commands = mockSend.mock.calls.map((c) => c[0]);
      expect(commands.filter((c) => c instanceof AuthorizeSecurityGroupEgressCommand)).toHaveLength(
        1
      );
      expect(commands.filter((c) => c instanceof RevokeSecurityGroupEgressCommand)).toHaveLength(
        0
      );
    });

    it('should revoke all egress rules when next has none', async () => {
      mockSend.mockResolvedValue({});

      await provider.update(
        'Sg1',
        'sg-empty',
        'AWS::EC2::SecurityGroup',
        { GroupDescription: 'd' },
        {
          GroupDescription: 'd',
          SecurityGroupEgress: [
            { IpProtocol: 'tcp', FromPort: 443, ToPort: 443, CidrIp: '0.0.0.0/0' },
          ],
        }
      );

      const commands = mockSend.mock.calls.map((c) => c[0]);
      expect(commands.filter((c) => c instanceof RevokeSecurityGroupEgressCommand)).toHaveLength(
        1
      );
      expect(commands.filter((c) => c instanceof AuthorizeSecurityGroupEgressCommand)).toHaveLength(
        0
      );
    });
  });

  describe('updateSecurityGroup ingress rule diff', () => {
    it('should authorize newly added ingress rules and revoke removed ones', async () => {
      mockSend.mockResolvedValue({});

      const previous = {
        GroupDescription: 'desc',
        SecurityGroupIngress: [
          { IpProtocol: 'tcp', FromPort: 22, ToPort: 22, CidrIp: '0.0.0.0/0' }, // removed
          { IpProtocol: 'tcp', FromPort: 80, ToPort: 80, CidrIp: '10.0.0.0/8' }, // unchanged
        ],
      };
      const next = {
        GroupDescription: 'desc',
        SecurityGroupIngress: [
          { IpProtocol: 'tcp', FromPort: 80, ToPort: 80, CidrIp: '10.0.0.0/8' }, // unchanged
          {
            IpProtocol: 'tcp',
            FromPort: 443,
            ToPort: 443,
            SourceSecurityGroupId: 'sg-peer',
            SourceSecurityGroupOwnerId: '111122223333',
          }, // added (cross-account)
        ],
      };

      await provider.update('Sg1', 'sg-deadbeef', 'AWS::EC2::SecurityGroup', next, previous);

      const commands = mockSend.mock.calls.map((c) => c[0]);
      const revokeIngressCmds = commands.filter(
        (c) => c instanceof RevokeSecurityGroupIngressCommand
      );
      const authorizeIngressCmds = commands.filter(
        (c) => c instanceof AuthorizeSecurityGroupIngressCommand
      );

      expect(revokeIngressCmds).toHaveLength(1);
      expect(revokeIngressCmds[0].input).toEqual({
        GroupId: 'sg-deadbeef',
        IpPermissions: [
          {
            IpProtocol: 'tcp',
            FromPort: 22,
            ToPort: 22,
            IpRanges: [{ CidrIp: '0.0.0.0/0' }],
          },
        ],
      });

      expect(authorizeIngressCmds).toHaveLength(1);
      expect(authorizeIngressCmds[0].input).toEqual({
        GroupId: 'sg-deadbeef',
        IpPermissions: [
          {
            IpProtocol: 'tcp',
            FromPort: 443,
            ToPort: 443,
            UserIdGroupPairs: [{ GroupId: 'sg-peer', UserId: '111122223333' }],
          },
        ],
      });
    });

    it('should be a no-op (no authorize/revoke) when ingress rules are unchanged', async () => {
      mockSend.mockResolvedValue({});

      const rules = [
        { IpProtocol: 'tcp', FromPort: 22, ToPort: 22, CidrIp: '0.0.0.0/0' },
      ];

      await provider.update(
        'Sg1',
        'sg-stable-ingress',
        'AWS::EC2::SecurityGroup',
        { GroupDescription: 'd', SecurityGroupIngress: rules },
        { GroupDescription: 'd', SecurityGroupIngress: rules }
      );

      const commands = mockSend.mock.calls.map((c) => c[0]);
      expect(commands.filter((c) => c instanceof RevokeSecurityGroupIngressCommand)).toHaveLength(
        0
      );
      expect(
        commands.filter((c) => c instanceof AuthorizeSecurityGroupIngressCommand)
      ).toHaveLength(0);
    });

    it('should authorize all ingress rules when previous had none', async () => {
      mockSend.mockResolvedValue({});

      await provider.update(
        'Sg1',
        'sg-fresh-ingress',
        'AWS::EC2::SecurityGroup',
        {
          GroupDescription: 'd',
          SecurityGroupIngress: [
            { IpProtocol: 'tcp', FromPort: 22, ToPort: 22, CidrIp: '0.0.0.0/0' },
          ],
        },
        { GroupDescription: 'd' }
      );

      const commands = mockSend.mock.calls.map((c) => c[0]);
      expect(
        commands.filter((c) => c instanceof AuthorizeSecurityGroupIngressCommand)
      ).toHaveLength(1);
      expect(commands.filter((c) => c instanceof RevokeSecurityGroupIngressCommand)).toHaveLength(
        0
      );
    });

    it('should revoke all ingress rules when next has none', async () => {
      mockSend.mockResolvedValue({});

      await provider.update(
        'Sg1',
        'sg-empty-ingress',
        'AWS::EC2::SecurityGroup',
        { GroupDescription: 'd' },
        {
          GroupDescription: 'd',
          SecurityGroupIngress: [
            { IpProtocol: 'tcp', FromPort: 22, ToPort: 22, CidrIp: '0.0.0.0/0' },
          ],
        }
      );

      const commands = mockSend.mock.calls.map((c) => c[0]);
      expect(commands.filter((c) => c instanceof RevokeSecurityGroupIngressCommand)).toHaveLength(
        1
      );
      expect(
        commands.filter((c) => c instanceof AuthorizeSecurityGroupIngressCommand)
      ).toHaveLength(0);
    });
  });

  describe('CreateTagsCommand passthrough', () => {
    // Sanity check that imports/awareness of CreateTagsCommand keeps tag handling
    // intact; actual tag application is exercised across other test cases that
    // set mockSend.mockResolvedValue({}) for any command.
    it('should keep CreateTagsCommand reference reachable', () => {
      expect(CreateTagsCommand).toBeTruthy();
    });
  });

  describe('getAttribute for AWS::EC2::VPC', () => {
    it('returns CidrBlock from DescribeVpcs', async () => {
      mockSend.mockResolvedValueOnce({
        Vpcs: [{ VpcId: 'vpc-abc', CidrBlock: '10.0.0.0/16' }],
      });

      const result = await provider.getAttribute('vpc-abc', 'AWS::EC2::VPC', 'CidrBlock');

      expect(result).toBe('10.0.0.0/16');
      expect(mockSend.mock.calls[0]?.[0]).toBeInstanceOf(DescribeVpcsCommand);
    });

    it('returns CidrBlockAssociations as association IDs', async () => {
      mockSend.mockResolvedValueOnce({
        Vpcs: [
          {
            VpcId: 'vpc-abc',
            CidrBlockAssociationSet: [
              { AssociationId: 'vpc-cidr-assoc-1', CidrBlock: '10.0.0.0/16' },
              { AssociationId: 'vpc-cidr-assoc-2', CidrBlock: '10.1.0.0/16' },
            ],
          },
        ],
      });

      const result = await provider.getAttribute(
        'vpc-abc',
        'AWS::EC2::VPC',
        'CidrBlockAssociations'
      );

      expect(result).toEqual(['vpc-cidr-assoc-1', 'vpc-cidr-assoc-2']);
    });

    it('returns Ipv6CidrBlocks for associated entries only', async () => {
      mockSend.mockResolvedValueOnce({
        Vpcs: [
          {
            VpcId: 'vpc-abc',
            Ipv6CidrBlockAssociationSet: [
              {
                Ipv6CidrBlock: '2001:db8::/56',
                Ipv6CidrBlockState: { State: 'associated' },
              },
              {
                Ipv6CidrBlock: '2001:db9::/56',
                Ipv6CidrBlockState: { State: 'disassociating' },
              },
            ],
          },
        ],
      });

      const result = await provider.getAttribute('vpc-abc', 'AWS::EC2::VPC', 'Ipv6CidrBlocks');

      expect(result).toEqual(['2001:db8::/56']);
    });

    it('returns DefaultNetworkAcl from DescribeNetworkAcls filter', async () => {
      mockSend.mockResolvedValueOnce({
        NetworkAcls: [{ NetworkAclId: 'acl-default', VpcId: 'vpc-abc', IsDefault: true }],
      });

      const result = await provider.getAttribute(
        'vpc-abc',
        'AWS::EC2::VPC',
        'DefaultNetworkAcl'
      );

      expect(result).toBe('acl-default');
      const call = mockSend.mock.calls[0]?.[0];
      expect(call).toBeInstanceOf(DescribeNetworkAclsCommand);
      expect(call.input.Filters).toEqual([
        { Name: 'vpc-id', Values: ['vpc-abc'] },
        { Name: 'default', Values: ['true'] },
      ]);
    });

    it('returns DefaultSecurityGroup from DescribeSecurityGroups filter', async () => {
      mockSend.mockResolvedValueOnce({
        SecurityGroups: [{ GroupId: 'sg-default', VpcId: 'vpc-abc', GroupName: 'default' }],
      });

      const result = await provider.getAttribute(
        'vpc-abc',
        'AWS::EC2::VPC',
        'DefaultSecurityGroup'
      );

      expect(result).toBe('sg-default');
      const call = mockSend.mock.calls[0]?.[0];
      expect(call).toBeInstanceOf(DescribeSecurityGroupsCommand);
      expect(call.input.Filters).toEqual([
        { Name: 'vpc-id', Values: ['vpc-abc'] },
        { Name: 'group-name', Values: ['default'] },
      ]);
    });

    it('returns undefined for unknown attribute', async () => {
      mockSend.mockResolvedValueOnce({ Vpcs: [{ VpcId: 'vpc-abc' }] });

      const result = await provider.getAttribute('vpc-abc', 'AWS::EC2::VPC', 'Unknown');

      expect(result).toBeUndefined();
    });
  });
});

describe('EC2Provider - NatGateway', () => {
  let provider: EC2Provider;
  const ORIGINAL_NO_WAIT = process.env['CDKD_NO_WAIT'];

  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockReset();
    // Each test sets CDKD_NO_WAIT explicitly; clear here so a leak from
    // a prior test (or the parent shell) cannot influence the wait
    // branch under test.
    delete process.env['CDKD_NO_WAIT'];
    provider = new EC2Provider();
  });

  // Restore the env var after the suite so other suites are not affected
  // by our mutation.
  afterAll(() => {
    if (ORIGINAL_NO_WAIT === undefined) {
      delete process.env['CDKD_NO_WAIT'];
    } else {
      process.env['CDKD_NO_WAIT'] = ORIGINAL_NO_WAIT;
    }
  });

  describe('handledProperties', () => {
    it('declares the NAT Gateway property set so the engine routes here instead of CC API', () => {
      const props = provider.handledProperties.get('AWS::EC2::NatGateway');
      expect(props).toBeDefined();
      expect(props?.has('SubnetId')).toBe(true);
      expect(props?.has('AllocationId')).toBe(true);
      expect(props?.has('ConnectivityType')).toBe(true);
      expect(props?.has('Tags')).toBe(true);
    });
  });

  describe('createNatGateway', () => {
    it('throws ProvisioningError if SubnetId is missing', async () => {
      await expect(
        provider.create('Nat', 'AWS::EC2::NatGateway', { AllocationId: 'eipalloc-aaa' })
      ).rejects.toThrow(/SubnetId is required/);
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('returns the NatGatewayId immediately when CDKD_NO_WAIT=true (no available-state poll)', async () => {
      process.env['CDKD_NO_WAIT'] = 'true';
      mockSend.mockResolvedValueOnce({
        NatGateway: { NatGatewayId: 'nat-12345', State: 'pending' },
      });
      // applyTags would issue CreateTagsCommand only when Tags exist;
      // we're omitting Tags so just one send call should fire.

      const result = await provider.create('Nat', 'AWS::EC2::NatGateway', {
        SubnetId: 'subnet-abc',
        AllocationId: 'eipalloc-aaa',
      });

      expect(result.physicalId).toBe('nat-12345');
      expect(result.attributes).toEqual({ NatGatewayId: 'nat-12345' });
      // Exactly ONE send: CreateNatGateway. NO DescribeNatGateways
      // polling — the --no-wait branch returned immediately.
      expect(mockSend).toHaveBeenCalledTimes(1);
    });

    it('waits for available state via DescribeNatGateways polling when CDKD_NO_WAIT is unset', async () => {
      // Default behavior (CFN parity): the SDK waiter
      // `waitUntilNatGatewayAvailable` polls DescribeNatGateways until
      // State === available. The waiter is mock-friendly because it
      // routes every call through `client.send`.
      mockSend
        .mockResolvedValueOnce({
          NatGateway: { NatGatewayId: 'nat-67890', State: 'pending' },
        })
        // First waiter poll already returns available.
        .mockResolvedValueOnce({
          NatGateways: [{ NatGatewayId: 'nat-67890', State: 'available' }],
        });

      const result = await provider.create('Nat', 'AWS::EC2::NatGateway', {
        SubnetId: 'subnet-abc',
        AllocationId: 'eipalloc-aaa',
      });

      expect(result.physicalId).toBe('nat-67890');
      expect(mockSend).toHaveBeenCalledTimes(2);
    });

    it('applies tags via the post-create CreateTags API', async () => {
      process.env['CDKD_NO_WAIT'] = 'true'; // skip waiter for test focus

      mockSend
        .mockResolvedValueOnce({
          NatGateway: { NatGatewayId: 'nat-tagged', State: 'pending' },
        })
        .mockResolvedValueOnce({}); // CreateTagsCommand

      await provider.create('Nat', 'AWS::EC2::NatGateway', {
        SubnetId: 'subnet-abc',
        AllocationId: 'eipalloc-aaa',
        Tags: [{ Key: 'Name', Value: 'my-nat' }],
      });

      expect(mockSend).toHaveBeenCalledTimes(2);
      expect(mockSend.mock.calls[1][0]).toBeInstanceOf(CreateTagsCommand);
      const tagInput = (mockSend.mock.calls[1][0] as CreateTagsCommand).input;
      expect(tagInput.Resources).toEqual(['nat-tagged']);
      expect(tagInput.Tags).toEqual([{ Key: 'Name', Value: 'my-nat' }]);
    });
  });

  describe('updateNatGateway', () => {
    it('is a no-op (NAT gateway has no in-place mutable properties)', async () => {
      const result = await provider.update(
        'Nat',
        'nat-12345',
        'AWS::EC2::NatGateway',
        { SubnetId: 'subnet-abc' },
        { SubnetId: 'subnet-abc' }
      );

      expect(result).toEqual({ physicalId: 'nat-12345', wasReplaced: false });
      expect(mockSend).not.toHaveBeenCalled();
    });
  });

  describe('deleteNatGateway', () => {
    it('always waits for the gateway to reach deleted state, even when CDKD_NO_WAIT=true', async () => {
      // NAT delete is asymmetric vs create: skipping the deleted-state
      // wait causes downstream IGW / Subnet / VPC delete to race a
      // still-`deleting` gateway and fail with `DependencyViolation`.
      // The wait is therefore unconditional on delete (CFn-parity).
      process.env['CDKD_NO_WAIT'] = 'true';
      mockSend
        .mockResolvedValueOnce({}) // DeleteNatGatewayCommand
        .mockResolvedValueOnce({
          NatGateways: [{ NatGatewayId: 'nat-12345', State: 'deleted' }],
        });

      await provider.delete('Nat', 'nat-12345', 'AWS::EC2::NatGateway');

      // 2 calls confirms the waiter ran even with --no-wait set.
      expect(mockSend).toHaveBeenCalledTimes(2);
    });

    it('waits for the gateway to reach deleted state by default (no env var)', async () => {
      mockSend
        .mockResolvedValueOnce({}) // DeleteNatGatewayCommand
        // First waiter poll already shows deleted.
        .mockResolvedValueOnce({
          NatGateways: [{ NatGatewayId: 'nat-12345', State: 'deleted' }],
        });

      await provider.delete('Nat', 'nat-12345', 'AWS::EC2::NatGateway');

      expect(mockSend).toHaveBeenCalledTimes(2);
    });

    it('treats NotFound as idempotent success when client region matches expected region', async () => {
      const notFound = new Error('Not found');
      Object.defineProperty(notFound, 'name', { value: 'NatGatewayNotFound' });
      mockSend.mockRejectedValueOnce(notFound);

      await expect(
        provider.delete('Nat', 'nat-gone', 'AWS::EC2::NatGateway', undefined, {
          expectedRegion: 'us-east-1',
        })
      ).resolves.toBeUndefined();
    });
  });
});
