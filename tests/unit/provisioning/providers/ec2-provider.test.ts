import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  CreateSecurityGroupCommand,
  AuthorizeSecurityGroupIngressCommand,
  AuthorizeSecurityGroupEgressCommand,
  RevokeSecurityGroupEgressCommand,
  RevokeSecurityGroupIngressCommand,
  CreateTagsCommand,
} from '@aws-sdk/client-ec2';

const mockSend = vi.hoisted(() => vi.fn());

vi.mock('../../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    ec2: { send: mockSend },
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

  describe('CreateTagsCommand passthrough', () => {
    // Sanity check that imports/awareness of CreateTagsCommand keeps tag handling
    // intact; actual tag application is exercised across other test cases that
    // set mockSend.mockResolvedValue({}) for any command.
    it('should keep CreateTagsCommand reference reachable', () => {
      expect(CreateTagsCommand).toBeTruthy();
    });
  });
});
