import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  DescribeVpcsCommand,
  DescribeVpcAttributeCommand,
  DescribeSubnetsCommand,
  DescribeInternetGatewaysCommand,
  DescribeNatGatewaysCommand,
  DescribeRouteTablesCommand,
  DescribeSecurityGroupsCommand,
  DescribeInstancesCommand,
  DescribeNetworkAclsCommand,
} from '@aws-sdk/client-ec2';

const mockSend = vi.fn();

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    ec2: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
  }),
}));

vi.mock('../../../src/utils/logger.js', () => {
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

import { EC2Provider } from '../../../src/provisioning/providers/ec2-provider.js';

describe('EC2Provider.readCurrentState', () => {
  let provider: EC2Provider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new EC2Provider();
  });

  describe('AWS::EC2::VPC', () => {
    it('returns CFn-shaped properties incl. DNS attributes', async () => {
      mockSend.mockResolvedValueOnce({
        Vpcs: [{ VpcId: 'vpc-1', CidrBlock: '10.0.0.0/16', InstanceTenancy: 'default' }],
      });
      mockSend.mockResolvedValueOnce({ EnableDnsHostnames: { Value: true } });
      mockSend.mockResolvedValueOnce({ EnableDnsSupport: { Value: true } });

      const result = await provider.readCurrentState('vpc-1', 'Logical', 'AWS::EC2::VPC');

      expect(mockSend.mock.calls[0]?.[0]).toBeInstanceOf(DescribeVpcsCommand);
      expect(mockSend.mock.calls[1]?.[0]).toBeInstanceOf(DescribeVpcAttributeCommand);
      expect(mockSend.mock.calls[2]?.[0]).toBeInstanceOf(DescribeVpcAttributeCommand);
      expect(result).toEqual({
        CidrBlock: '10.0.0.0/16',
        InstanceTenancy: 'default',
        EnableDnsHostnames: true,
        EnableDnsSupport: true,
      });
    });

    it('returns undefined when VPC not found', async () => {
      const err = new Error('not found');
      (err as { name?: string }).name = 'InvalidVpcID.NotFound';
      mockSend.mockRejectedValueOnce(err);

      const result = await provider.readCurrentState('vpc-x', 'Logical', 'AWS::EC2::VPC');
      expect(result).toBeUndefined();
    });
  });

  describe('AWS::EC2::Subnet', () => {
    it('returns CFn-shaped properties', async () => {
      mockSend.mockResolvedValueOnce({
        Subnets: [
          {
            SubnetId: 'subnet-1',
            VpcId: 'vpc-1',
            CidrBlock: '10.0.1.0/24',
            AvailabilityZone: 'us-east-1a',
            MapPublicIpOnLaunch: true,
          },
        ],
      });

      const result = await provider.readCurrentState('subnet-1', 'Logical', 'AWS::EC2::Subnet');

      expect(mockSend.mock.calls[0]?.[0]).toBeInstanceOf(DescribeSubnetsCommand);
      expect(result).toEqual({
        VpcId: 'vpc-1',
        CidrBlock: '10.0.1.0/24',
        AvailabilityZone: 'us-east-1a',
        MapPublicIpOnLaunch: true,
      });
    });
  });

  describe('AWS::EC2::InternetGateway', () => {
    it('returns empty object when IGW exists (existence-only check)', async () => {
      mockSend.mockResolvedValueOnce({
        InternetGateways: [{ InternetGatewayId: 'igw-1' }],
      });

      const result = await provider.readCurrentState(
        'igw-1',
        'Logical',
        'AWS::EC2::InternetGateway'
      );

      expect(mockSend.mock.calls[0]?.[0]).toBeInstanceOf(DescribeInternetGatewaysCommand);
      expect(result).toEqual({});
    });

    it('returns undefined when IGW not found', async () => {
      mockSend.mockResolvedValueOnce({ InternetGateways: [] });
      const result = await provider.readCurrentState(
        'igw-x',
        'Logical',
        'AWS::EC2::InternetGateway'
      );
      expect(result).toBeUndefined();
    });
  });

  describe('AWS::EC2::NatGateway', () => {
    it('returns CFn-shaped properties (skip deleted gateway)', async () => {
      mockSend.mockResolvedValueOnce({
        NatGateways: [
          {
            NatGatewayId: 'nat-1',
            State: 'available',
            SubnetId: 'subnet-1',
            ConnectivityType: 'public',
            NatGatewayAddresses: [
              { AllocationId: 'eipalloc-1', PrivateIp: '10.0.0.5' },
            ],
          },
        ],
      });

      const result = await provider.readCurrentState(
        'nat-1',
        'Logical',
        'AWS::EC2::NatGateway'
      );

      expect(mockSend.mock.calls[0]?.[0]).toBeInstanceOf(DescribeNatGatewaysCommand);
      expect(result).toEqual({
        SubnetId: 'subnet-1',
        ConnectivityType: 'public',
        AllocationId: 'eipalloc-1',
        PrivateIpAddress: '10.0.0.5',
      });
    });
  });

  describe('AWS::EC2::RouteTable', () => {
    it('returns VpcId', async () => {
      mockSend.mockResolvedValueOnce({
        RouteTables: [{ RouteTableId: 'rtb-1', VpcId: 'vpc-1' }],
      });

      const result = await provider.readCurrentState(
        'rtb-1',
        'Logical',
        'AWS::EC2::RouteTable'
      );

      expect(mockSend.mock.calls[0]?.[0]).toBeInstanceOf(DescribeRouteTablesCommand);
      expect(result).toEqual({ VpcId: 'vpc-1' });
    });
  });

  describe('AWS::EC2::SecurityGroup', () => {
    it('returns GroupName + GroupDescription + VpcId', async () => {
      mockSend.mockResolvedValueOnce({
        SecurityGroups: [
          {
            GroupId: 'sg-1',
            GroupName: 'web',
            Description: 'web tier',
            VpcId: 'vpc-1',
          },
        ],
      });

      const result = await provider.readCurrentState(
        'sg-1',
        'Logical',
        'AWS::EC2::SecurityGroup'
      );

      expect(mockSend.mock.calls[0]?.[0]).toBeInstanceOf(DescribeSecurityGroupsCommand);
      expect(result).toEqual({
        GroupName: 'web',
        GroupDescription: 'web tier',
        VpcId: 'vpc-1',
      });
    });
  });

  describe('AWS::EC2::Instance', () => {
    it('returns ImageId + InstanceType + SubnetId for running instance', async () => {
      mockSend.mockResolvedValueOnce({
        Reservations: [
          {
            Instances: [
              {
                InstanceId: 'i-1',
                ImageId: 'ami-1',
                InstanceType: 't3.micro',
                SubnetId: 'subnet-1',
                State: { Name: 'running' },
              },
            ],
          },
        ],
      });

      const result = await provider.readCurrentState('i-1', 'Logical', 'AWS::EC2::Instance');

      expect(mockSend.mock.calls[0]?.[0]).toBeInstanceOf(DescribeInstancesCommand);
      expect(result).toEqual({
        ImageId: 'ami-1',
        InstanceType: 't3.micro',
        SubnetId: 'subnet-1',
      });
    });

    it('returns undefined for terminated instance', async () => {
      mockSend.mockResolvedValueOnce({
        Reservations: [
          {
            Instances: [
              { InstanceId: 'i-1', State: { Name: 'terminated' } },
            ],
          },
        ],
      });

      const result = await provider.readCurrentState('i-1', 'Logical', 'AWS::EC2::Instance');
      expect(result).toBeUndefined();
    });
  });

  describe('AWS::EC2::NetworkAcl', () => {
    it('returns VpcId', async () => {
      mockSend.mockResolvedValueOnce({
        NetworkAcls: [{ NetworkAclId: 'acl-1', VpcId: 'vpc-1' }],
      });

      const result = await provider.readCurrentState(
        'acl-1',
        'Logical',
        'AWS::EC2::NetworkAcl'
      );

      expect(mockSend.mock.calls[0]?.[0]).toBeInstanceOf(DescribeNetworkAclsCommand);
      expect(result).toEqual({ VpcId: 'vpc-1' });
    });
  });

  describe('Unsupported sub-resource types', () => {
    it('returns undefined for AWS::EC2::Route (skipped per JSDoc)', async () => {
      const result = await provider.readCurrentState(
        'rtb-1|10.0.0.0/0',
        'Logical',
        'AWS::EC2::Route'
      );
      expect(result).toBeUndefined();
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('returns undefined for AWS::EC2::VPCGatewayAttachment', async () => {
      const result = await provider.readCurrentState(
        'igw-1|vpc-1',
        'Logical',
        'AWS::EC2::VPCGatewayAttachment'
      );
      expect(result).toBeUndefined();
    });

    it('returns undefined for AWS::EC2::SecurityGroupIngress', async () => {
      const result = await provider.readCurrentState(
        'some-id',
        'Logical',
        'AWS::EC2::SecurityGroupIngress'
      );
      expect(result).toBeUndefined();
    });
  });
});
