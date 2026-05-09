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
    it('returns GroupName + GroupDescription + VpcId, with empty rule placeholders when AWS reports no rules', async () => {
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
      // SecurityGroupIngress / SecurityGroupEgress always emitted (even
      // as `[]`) so the v3 observedProperties baseline catches a
      // console-side rule ADD on a templated SG.
      expect(result).toEqual({
        GroupName: 'web',
        GroupDescription: 'web tier',
        VpcId: 'vpc-1',
        SecurityGroupIngress: [],
        SecurityGroupEgress: [],
      });
    });

    it('reverse-maps AWS IpPermissions[] into CFn SecurityGroupIngress[] (one rule per IpRanges entry)', async () => {
      mockSend.mockResolvedValueOnce({
        SecurityGroups: [
          {
            GroupId: 'sg-1',
            GroupName: 'web',
            Description: 'web tier',
            VpcId: 'vpc-1',
            IpPermissions: [
              {
                IpProtocol: 'tcp',
                FromPort: 80,
                ToPort: 80,
                IpRanges: [
                  { CidrIp: '10.0.0.0/8', Description: 'office' },
                  { CidrIp: '192.168.0.0/16' },
                ],
                Ipv6Ranges: [],
                UserIdGroupPairs: [],
                PrefixListIds: [],
              },
              {
                IpProtocol: 'tcp',
                FromPort: 443,
                ToPort: 443,
                IpRanges: [{ CidrIp: '0.0.0.0/0', Description: 'public-https' }],
              },
            ],
          },
        ],
      });

      const result = await provider.readCurrentState(
        'sg-1',
        'Logical',
        'AWS::EC2::SecurityGroup'
      );

      expect(result?.['SecurityGroupIngress']).toEqual([
        { IpProtocol: 'tcp', FromPort: 80, ToPort: 80, CidrIp: '10.0.0.0/8', Description: 'office' },
        { IpProtocol: 'tcp', FromPort: 80, ToPort: 80, CidrIp: '192.168.0.0/16' },
        {
          IpProtocol: 'tcp',
          FromPort: 443,
          ToPort: 443,
          CidrIp: '0.0.0.0/0',
          Description: 'public-https',
        },
      ]);
    });

    it('flattens UserIdGroupPairs and PrefixListIds into separate CFn ingress rules', async () => {
      mockSend.mockResolvedValueOnce({
        SecurityGroups: [
          {
            GroupId: 'sg-1',
            VpcId: 'vpc-1',
            IpPermissions: [
              {
                IpProtocol: 'tcp',
                FromPort: 5432,
                ToPort: 5432,
                UserIdGroupPairs: [
                  { GroupId: 'sg-2', UserId: '111122223333', Description: 'app' },
                ],
                PrefixListIds: [{ PrefixListId: 'pl-abc', Description: 's3-vpce' }],
              },
            ],
          },
        ],
      });

      const result = await provider.readCurrentState(
        'sg-1',
        'Logical',
        'AWS::EC2::SecurityGroup'
      );

      expect(result?.['SecurityGroupIngress']).toEqual([
        {
          IpProtocol: 'tcp',
          FromPort: 5432,
          ToPort: 5432,
          SourceSecurityGroupId: 'sg-2',
          SourceSecurityGroupOwnerId: '111122223333',
          Description: 'app',
        },
        {
          IpProtocol: 'tcp',
          FromPort: 5432,
          ToPort: 5432,
          SourcePrefixListId: 'pl-abc',
          Description: 's3-vpce',
        },
      ]);
    });

    it('uses Destination* field names for egress (not Source*)', async () => {
      // Pass state-egress so the AWS-default filter doesn't strip
      // DestinationSecurityGroupId-only rules; this test focuses on
      // direction-aware field naming.
      mockSend.mockResolvedValueOnce({
        SecurityGroups: [
          {
            GroupId: 'sg-1',
            VpcId: 'vpc-1',
            IpPermissionsEgress: [
              {
                IpProtocol: 'tcp',
                FromPort: 5432,
                ToPort: 5432,
                UserIdGroupPairs: [{ GroupId: 'sg-db' }],
              },
              {
                IpProtocol: 'tcp',
                FromPort: 443,
                ToPort: 443,
                PrefixListIds: [{ PrefixListId: 'pl-xyz' }],
              },
            ],
          },
        ],
      });

      const result = await provider.readCurrentState(
        'sg-1',
        'Logical',
        'AWS::EC2::SecurityGroup',
        // state egress matters for the filter logic — non-empty here.
        {
          SecurityGroupEgress: [
            { IpProtocol: 'tcp', FromPort: 5432, ToPort: 5432, DestinationSecurityGroupId: 'sg-db' },
          ],
        }
      );

      expect(result?.['SecurityGroupEgress']).toEqual([
        // state-templated rule is reconciled to position 0
        {
          IpProtocol: 'tcp',
          FromPort: 5432,
          ToPort: 5432,
          DestinationSecurityGroupId: 'sg-db',
        },
        // unmatched AWS rule appended after state-matched rules
        {
          IpProtocol: 'tcp',
          FromPort: 443,
          ToPort: 443,
          DestinationPrefixListId: 'pl-xyz',
        },
      ]);
    });

    it('filters AWS auto-default egress when state did not template SecurityGroupEgress', async () => {
      mockSend.mockResolvedValueOnce({
        SecurityGroups: [
          {
            GroupId: 'sg-1',
            VpcId: 'vpc-1',
            IpPermissionsEgress: [
              // AWS-default rule (allow all)
              {
                IpProtocol: '-1',
                IpRanges: [{ CidrIp: '0.0.0.0/0' }],
              },
            ],
          },
        ],
      });

      const result = await provider.readCurrentState(
        'sg-1',
        'Logical',
        'AWS::EC2::SecurityGroup'
      );

      // Default egress filtered out — emit empty array placeholder so
      // observedProperties still has the key for future drift detection.
      expect(result?.['SecurityGroupEgress']).toEqual([]);
    });

    it('keeps AWS auto-default egress when state DID template egress (state owns the list)', async () => {
      mockSend.mockResolvedValueOnce({
        SecurityGroups: [
          {
            GroupId: 'sg-1',
            VpcId: 'vpc-1',
            IpPermissionsEgress: [
              {
                IpProtocol: '-1',
                IpRanges: [{ CidrIp: '0.0.0.0/0' }],
              },
            ],
          },
        ],
      });

      const result = await provider.readCurrentState(
        'sg-1',
        'Logical',
        'AWS::EC2::SecurityGroup',
        { SecurityGroupEgress: [{ IpProtocol: '-1', CidrIp: '0.0.0.0/0' }] }
      );

      // State templated egress — even if the rule shape matches the
      // AWS-default tuple, surface it as-is. The filter only fires on
      // state-undefined to avoid stripping a user-defined rule that
      // happens to match the default.
      expect(result?.['SecurityGroupEgress']).toEqual([{ IpProtocol: '-1', CidrIp: '0.0.0.0/0' }]);
    });

    it('reorders AWS rules to match state-templated order (state-driven order reconciliation)', async () => {
      // AWS returns rules in normalized order (typically port-ascending);
      // state has them in user-templated order. Reconcile so the
      // comparator's positional array compare doesn't fire on order alone.
      mockSend.mockResolvedValueOnce({
        SecurityGroups: [
          {
            GroupId: 'sg-1',
            VpcId: 'vpc-1',
            IpPermissions: [
              { IpProtocol: 'tcp', FromPort: 22, ToPort: 22, IpRanges: [{ CidrIp: '0.0.0.0/0' }] },
              { IpProtocol: 'tcp', FromPort: 443, ToPort: 443, IpRanges: [{ CidrIp: '0.0.0.0/0' }] },
              { IpProtocol: 'tcp', FromPort: 80, ToPort: 80, IpRanges: [{ CidrIp: '0.0.0.0/0' }] },
            ],
          },
        ],
      });

      const result = await provider.readCurrentState(
        'sg-1',
        'Logical',
        'AWS::EC2::SecurityGroup',
        {
          SecurityGroupIngress: [
            { IpProtocol: 'tcp', FromPort: 80, ToPort: 80, CidrIp: '0.0.0.0/0' },
            { IpProtocol: 'tcp', FromPort: 443, ToPort: 443, CidrIp: '0.0.0.0/0' },
            { IpProtocol: 'tcp', FromPort: 22, ToPort: 22, CidrIp: '0.0.0.0/0' },
          ],
        }
      );

      expect(result?.['SecurityGroupIngress']).toEqual([
        { IpProtocol: 'tcp', FromPort: 80, ToPort: 80, CidrIp: '0.0.0.0/0' },
        { IpProtocol: 'tcp', FromPort: 443, ToPort: 443, CidrIp: '0.0.0.0/0' },
        { IpProtocol: 'tcp', FromPort: 22, ToPort: 22, CidrIp: '0.0.0.0/0' },
      ]);
    });

    it('appends unmatched AWS rules after state-matched rules (console-side ADD detection)', async () => {
      mockSend.mockResolvedValueOnce({
        SecurityGroups: [
          {
            GroupId: 'sg-1',
            VpcId: 'vpc-1',
            IpPermissions: [
              { IpProtocol: 'tcp', FromPort: 80, ToPort: 80, IpRanges: [{ CidrIp: '0.0.0.0/0' }] },
              // Console-side add: not in state.
              { IpProtocol: 'tcp', FromPort: 22, ToPort: 22, IpRanges: [{ CidrIp: '1.2.3.4/32' }] },
            ],
          },
        ],
      });

      const result = await provider.readCurrentState(
        'sg-1',
        'Logical',
        'AWS::EC2::SecurityGroup',
        {
          SecurityGroupIngress: [
            { IpProtocol: 'tcp', FromPort: 80, ToPort: 80, CidrIp: '0.0.0.0/0' },
          ],
        }
      );

      // State has 1 rule (port 80), AWS has 2. Reconciled output: state
      // rule first (matched), then unmatched AWS rule (port 22). The
      // comparator sees positional drift on index 1 (state has nothing,
      // AWS has the SSH rule) — correct console-side ADD detection.
      expect(result?.['SecurityGroupIngress']).toEqual([
        { IpProtocol: 'tcp', FromPort: 80, ToPort: 80, CidrIp: '0.0.0.0/0' },
        { IpProtocol: 'tcp', FromPort: 22, ToPort: 22, CidrIp: '1.2.3.4/32' },
      ]);
    });

    it('flattens IPv6 ranges into separate rules with CidrIpv6 field', async () => {
      mockSend.mockResolvedValueOnce({
        SecurityGroups: [
          {
            GroupId: 'sg-1',
            VpcId: 'vpc-1',
            IpPermissions: [
              {
                IpProtocol: 'tcp',
                FromPort: 80,
                ToPort: 80,
                IpRanges: [{ CidrIp: '0.0.0.0/0' }],
                Ipv6Ranges: [{ CidrIpv6: '::/0', Description: 'all-v6' }],
              },
            ],
          },
        ],
      });

      const result = await provider.readCurrentState(
        'sg-1',
        'Logical',
        'AWS::EC2::SecurityGroup'
      );

      expect(result?.['SecurityGroupIngress']).toEqual([
        { IpProtocol: 'tcp', FromPort: 80, ToPort: 80, CidrIp: '0.0.0.0/0' },
        {
          IpProtocol: 'tcp',
          FromPort: 80,
          ToPort: 80,
          CidrIpv6: '::/0',
          Description: 'all-v6',
        },
      ]);
    });
  });

  describe('AWS::EC2::Instance', () => {
    it('returns top-level fields with always-emit placeholders for running instance with no EBS volumes', async () => {
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
      // SecurityGroupIds / BlockDeviceMappings / Tags / Monitoring always
      // emitted so the v3 observedProperties baseline catches console-side
      // ADDs even on minimum-config instances.
      expect(result).toEqual({
        ImageId: 'ami-1',
        InstanceType: 't3.micro',
        SubnetId: 'subnet-1',
        SecurityGroupIds: [],
        Monitoring: false,
        BlockDeviceMappings: [],
        Tags: [],
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

    it('surfaces SecurityGroupIds sorted (stable positional compare against template order)', async () => {
      mockSend.mockResolvedValueOnce({
        Reservations: [
          {
            Instances: [
              {
                InstanceId: 'i-1',
                State: { Name: 'running' },
                // AWS does not preserve template order — sort the result so
                // the comparator's positional array compare is stable.
                SecurityGroups: [
                  { GroupId: 'sg-z', GroupName: 'last' },
                  { GroupId: 'sg-a', GroupName: 'first' },
                  { GroupId: 'sg-m', GroupName: 'middle' },
                ],
              },
            ],
          },
        ],
      });

      const result = await provider.readCurrentState('i-1', 'Logical', 'AWS::EC2::Instance');
      expect(result?.['SecurityGroupIds']).toEqual(['sg-a', 'sg-m', 'sg-z']);
    });

    it('maps Monitoring.State to CFn boolean', async () => {
      // Cover the two enabled-ish states (enabled, pending) → true,
      // and a disabled-ish state (disabled, disabling) → false.
      for (const [state, expected] of [
        ['enabled', true],
        ['pending', true],
        ['disabled', false],
        ['disabling', false],
      ] as const) {
        mockSend.mockResolvedValueOnce({
          Reservations: [
            {
              Instances: [
                {
                  InstanceId: 'i-1',
                  State: { Name: 'running' },
                  Monitoring: { State: state },
                },
              ],
            },
          ],
        });

        const result = await provider.readCurrentState('i-1', 'Logical', 'AWS::EC2::Instance');
        expect(result?.['Monitoring']).toBe(expected);
      }
    });

    it('surfaces SourceDestCheck / Tenancy / IamInstanceProfile / PrivateIpAddress when set', async () => {
      mockSend.mockResolvedValueOnce({
        Reservations: [
          {
            Instances: [
              {
                InstanceId: 'i-1',
                State: { Name: 'running' },
                SourceDestCheck: false,
                PrivateIpAddress: '10.0.1.42',
                Placement: { Tenancy: 'dedicated' },
                IamInstanceProfile: { Arn: 'arn:aws:iam::1:instance-profile/web' },
              },
            ],
          },
        ],
      });

      const result = await provider.readCurrentState('i-1', 'Logical', 'AWS::EC2::Instance');
      expect(result?.['SourceDestCheck']).toBe(false);
      expect(result?.['PrivateIpAddress']).toBe('10.0.1.42');
      expect(result?.['Tenancy']).toBe('dedicated');
      expect(result?.['IamInstanceProfile']).toBe('arn:aws:iam::1:instance-profile/web');
    });

    it('reverse-maps BlockDeviceMappings using DescribeVolumes for full Ebs sub-shape', async () => {
      // First call: DescribeInstances. Second call: DescribeVolumes for the
      // attached volumes.
      mockSend
        .mockResolvedValueOnce({
          Reservations: [
            {
              Instances: [
                {
                  InstanceId: 'i-1',
                  State: { Name: 'running' },
                  BlockDeviceMappings: [
                    {
                      DeviceName: '/dev/sda1',
                      Ebs: { VolumeId: 'vol-aaa', DeleteOnTermination: true },
                    },
                    {
                      DeviceName: '/dev/sdb',
                      Ebs: { VolumeId: 'vol-bbb', DeleteOnTermination: false },
                    },
                  ],
                },
              ],
            },
          ],
        })
        .mockResolvedValueOnce({
          Volumes: [
            {
              VolumeId: 'vol-aaa',
              VolumeType: 'gp3',
              Size: 8,
              Iops: 3000,
              Throughput: 125,
              Encrypted: true,
              KmsKeyId: 'arn:aws:kms:us-east-1:1:key/abc',
            },
            {
              VolumeId: 'vol-bbb',
              VolumeType: 'gp2',
              Size: 100,
              Encrypted: false,
              SnapshotId: 'snap-xyz',
            },
          ],
        });

      const result = await provider.readCurrentState('i-1', 'Logical', 'AWS::EC2::Instance');

      expect(result?.['BlockDeviceMappings']).toEqual([
        {
          DeviceName: '/dev/sda1',
          Ebs: {
            DeleteOnTermination: true,
            VolumeType: 'gp3',
            VolumeSize: 8,
            Iops: 3000,
            Throughput: 125,
            Encrypted: true,
            KmsKeyId: 'arn:aws:kms:us-east-1:1:key/abc',
          },
        },
        {
          DeviceName: '/dev/sdb',
          Ebs: {
            DeleteOnTermination: false,
            VolumeType: 'gp2',
            VolumeSize: 100,
            Encrypted: false,
            SnapshotId: 'snap-xyz',
          },
        },
      ]);
    });

    it('falls back to DeleteOnTermination-only on DescribeVolumes failure (best-effort)', async () => {
      mockSend
        .mockResolvedValueOnce({
          Reservations: [
            {
              Instances: [
                {
                  InstanceId: 'i-1',
                  State: { Name: 'running' },
                  BlockDeviceMappings: [
                    {
                      DeviceName: '/dev/sda1',
                      Ebs: { VolumeId: 'vol-aaa', DeleteOnTermination: true },
                    },
                  ],
                },
              ],
            },
          ],
        })
        .mockRejectedValueOnce(new Error('UnauthorizedOperation: ec2:DescribeVolumes'));

      const result = await provider.readCurrentState('i-1', 'Logical', 'AWS::EC2::Instance');

      // Volume-side fields absent — the partial shape (DeleteOnTermination
      // only) is still surfaced. Better than nothing for users without
      // ec2:DescribeVolumes permission.
      expect(result?.['BlockDeviceMappings']).toEqual([
        {
          DeviceName: '/dev/sda1',
          Ebs: { DeleteOnTermination: true },
        },
      ]);
    });

    it('surfaces Tags with aws:* filtered out', async () => {
      mockSend.mockResolvedValueOnce({
        Reservations: [
          {
            Instances: [
              {
                InstanceId: 'i-1',
                State: { Name: 'running' },
                Tags: [
                  { Key: 'Name', Value: 'web-1' },
                  { Key: 'aws:cdk:path', Value: 'MyStack/web' },
                ],
              },
            ],
          },
        ],
      });

      const result = await provider.readCurrentState('i-1', 'Logical', 'AWS::EC2::Instance');
      expect(result?.['Tags']).toEqual([{ Key: 'Name', Value: 'web-1' }]);
    });

    it('surfaces DisableApiTermination via DescribeInstanceAttribute', async () => {
      // First call: DescribeInstances. Second: DescribeInstanceAttribute
      // (DisableApiTermination=true).
      mockSend
        .mockResolvedValueOnce({
          Reservations: [
            {
              Instances: [
                {
                  InstanceId: 'i-1',
                  State: { Name: 'running' },
                },
              ],
            },
          ],
        })
        .mockResolvedValueOnce({ DisableApiTermination: { Value: true } });

      const result = await provider.readCurrentState('i-1', 'Logical', 'AWS::EC2::Instance');
      expect(result?.['DisableApiTermination']).toBe(true);
    });

    it('omits DisableApiTermination when DescribeInstanceAttribute fails (best-effort)', async () => {
      mockSend
        .mockResolvedValueOnce({
          Reservations: [
            {
              Instances: [
                {
                  InstanceId: 'i-1',
                  State: { Name: 'running' },
                },
              ],
            },
          ],
        })
        .mockRejectedValueOnce(new Error('UnauthorizedOperation: ec2:DescribeInstanceAttribute'));

      const result = await provider.readCurrentState('i-1', 'Logical', 'AWS::EC2::Instance');
      expect(result?.['DisableApiTermination']).toBeUndefined();
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

  describe('AWS::EC2::VPCGatewayAttachment', () => {
    it('returns InternetGatewayId + VpcId when IGW is attached to the recorded VPC', async () => {
      mockSend.mockResolvedValueOnce({
        InternetGateways: [
          {
            InternetGatewayId: 'igw-1',
            Attachments: [{ VpcId: 'vpc-1', State: 'available' }],
          },
        ],
      });

      const result = await provider.readCurrentState(
        'igw-1|vpc-1',
        'Logical',
        'AWS::EC2::VPCGatewayAttachment'
      );

      expect(mockSend.mock.calls[0]?.[0]).toBeInstanceOf(DescribeInternetGatewaysCommand);
      expect(result).toEqual({ InternetGatewayId: 'igw-1', VpcId: 'vpc-1' });
    });

    it('returns undefined when IGW is no longer attached to the recorded VPC', async () => {
      mockSend.mockResolvedValueOnce({
        InternetGateways: [
          {
            InternetGatewayId: 'igw-1',
            Attachments: [{ VpcId: 'vpc-other' }],
          },
        ],
      });

      const result = await provider.readCurrentState(
        'igw-1|vpc-1',
        'Logical',
        'AWS::EC2::VPCGatewayAttachment'
      );
      expect(result).toBeUndefined();
    });
  });

  describe('AWS::EC2::Route', () => {
    it('returns target field AWS reports for the route (NatGatewayId)', async () => {
      mockSend.mockResolvedValueOnce({
        RouteTables: [
          {
            RouteTableId: 'rtb-1',
            Routes: [
              {
                DestinationCidrBlock: '10.0.0.0/16',
                GatewayId: 'local',
                State: 'active',
              },
              {
                DestinationCidrBlock: '0.0.0.0/0',
                NatGatewayId: 'nat-abc',
                State: 'active',
              },
            ],
          },
        ],
      });

      const result = await provider.readCurrentState(
        'rtb-1|0.0.0.0/0',
        'Logical',
        'AWS::EC2::Route'
      );
      expect(result).toEqual({
        RouteTableId: 'rtb-1',
        DestinationCidrBlock: '0.0.0.0/0',
        NatGatewayId: 'nat-abc',
      });
    });

    it('matches IPv6 cidr in physicalId against DestinationIpv6CidrBlock', async () => {
      mockSend.mockResolvedValueOnce({
        RouteTables: [
          {
            RouteTableId: 'rtb-1',
            Routes: [
              {
                DestinationIpv6CidrBlock: '::/0',
                EgressOnlyInternetGatewayId: 'eigw-1',
              },
            ],
          },
        ],
      });

      const result = await provider.readCurrentState(
        'rtb-1|::/0',
        'Logical',
        'AWS::EC2::Route'
      );
      expect(result).toEqual({
        RouteTableId: 'rtb-1',
        DestinationIpv6CidrBlock: '::/0',
        EgressOnlyInternetGatewayId: 'eigw-1',
      });
    });

    it('returns undefined when route has been removed', async () => {
      mockSend.mockResolvedValueOnce({
        RouteTables: [{ RouteTableId: 'rtb-1', Routes: [] }],
      });
      const result = await provider.readCurrentState(
        'rtb-1|10.0.0.0/0',
        'Logical',
        'AWS::EC2::Route'
      );
      expect(result).toBeUndefined();
    });
  });

  describe('AWS::EC2::SubnetRouteTableAssociation', () => {
    it('returns SubnetId + RouteTableId when AWS still has the association', async () => {
      mockSend.mockResolvedValueOnce({
        RouteTables: [
          {
            RouteTableId: 'rtb-1',
            Associations: [
              {
                RouteTableAssociationId: 'rtbassoc-1',
                SubnetId: 'subnet-1',
                RouteTableId: 'rtb-1',
                AssociationState: { State: 'associated' },
              },
            ],
          },
        ],
      });

      const result = await provider.readCurrentState(
        'rtbassoc-1',
        'Logical',
        'AWS::EC2::SubnetRouteTableAssociation'
      );
      expect(result).toEqual({ SubnetId: 'subnet-1', RouteTableId: 'rtb-1' });
    });

    it('returns undefined when no route table has the association', async () => {
      mockSend.mockResolvedValueOnce({ RouteTables: [] });
      const result = await provider.readCurrentState(
        'rtbassoc-missing',
        'Logical',
        'AWS::EC2::SubnetRouteTableAssociation'
      );
      expect(result).toBeUndefined();
    });
  });

  describe('AWS::EC2::SecurityGroupIngress (standalone)', () => {
    it('finds the matching rule by full state signature when multiple AWS rules share the (group, protocol, ports) tuple', async () => {
      mockSend.mockResolvedValueOnce({
        SecurityGroups: [
          {
            GroupId: 'sg-1',
            IpPermissions: [
              {
                IpProtocol: 'tcp',
                FromPort: 80,
                ToPort: 80,
                IpRanges: [
                  { CidrIp: '10.0.0.0/8' },
                  { CidrIp: '192.168.0.0/16' },
                ],
              },
            ],
          },
        ],
      });

      // State has the second rule (192.168.x).
      const result = await provider.readCurrentState(
        'sg-1|tcp|80|80',
        'Logical',
        'AWS::EC2::SecurityGroupIngress',
        {
          GroupId: 'sg-1',
          IpProtocol: 'tcp',
          FromPort: 80,
          ToPort: 80,
          CidrIp: '192.168.0.0/16',
        }
      );
      expect(result).toEqual({
        GroupId: 'sg-1',
        IpProtocol: 'tcp',
        FromPort: 80,
        ToPort: 80,
        CidrIp: '192.168.0.0/16',
      });
    });

    it('returns the first candidate when state passes no properties (best-effort, unique tuple)', async () => {
      mockSend.mockResolvedValueOnce({
        SecurityGroups: [
          {
            GroupId: 'sg-1',
            IpPermissions: [
              {
                IpProtocol: 'tcp',
                FromPort: 22,
                ToPort: 22,
                IpRanges: [{ CidrIp: '0.0.0.0/0' }],
              },
            ],
          },
        ],
      });

      const result = await provider.readCurrentState(
        'sg-1|tcp|22|22',
        'Logical',
        'AWS::EC2::SecurityGroupIngress'
      );
      expect(result).toEqual({
        GroupId: 'sg-1',
        IpProtocol: 'tcp',
        FromPort: 22,
        ToPort: 22,
        CidrIp: '0.0.0.0/0',
      });
    });

    it('returns undefined when state signature does not match any AWS rule (rule was removed)', async () => {
      mockSend.mockResolvedValueOnce({
        SecurityGroups: [
          {
            GroupId: 'sg-1',
            IpPermissions: [
              // tuple matches but cidr is different — comparator should
              // fail to match and return undefined (gone) rather than
              // return a different rule that happens to share the tuple.
              {
                IpProtocol: 'tcp',
                FromPort: 80,
                ToPort: 80,
                IpRanges: [{ CidrIp: '10.0.0.0/8' }],
              },
            ],
          },
        ],
      });

      const result = await provider.readCurrentState(
        'sg-1|tcp|80|80',
        'Logical',
        'AWS::EC2::SecurityGroupIngress',
        {
          GroupId: 'sg-1',
          IpProtocol: 'tcp',
          FromPort: 80,
          ToPort: 80,
          CidrIp: '192.168.0.0/16',
        }
      );
      expect(result).toBeUndefined();
    });
  });

  describe('AWS::EC2::NetworkAclEntry', () => {
    it('returns matching entry by RuleNumber + Egress with Protocol normalized to number', async () => {
      mockSend.mockResolvedValueOnce({
        NetworkAcls: [
          {
            NetworkAclId: 'acl-1',
            Entries: [
              {
                RuleNumber: 100,
                Protocol: '6', // tcp
                RuleAction: 'allow',
                Egress: false,
                CidrBlock: '0.0.0.0/0',
                PortRange: { From: 80, To: 80 },
              },
              // Different rule — should not match.
              {
                RuleNumber: 200,
                Protocol: '17',
                RuleAction: 'allow',
                Egress: false,
              },
            ],
          },
        ],
      });

      const result = await provider.readCurrentState(
        'acl-1|100|false',
        'Logical',
        'AWS::EC2::NetworkAclEntry'
      );
      expect(result).toEqual({
        NetworkAclId: 'acl-1',
        RuleNumber: 100,
        Egress: false,
        Protocol: 6,
        RuleAction: 'allow',
        CidrBlock: '0.0.0.0/0',
        PortRange: { From: 80, To: 80 },
      });
    });

    it('handles IcmpTypeCode', async () => {
      mockSend.mockResolvedValueOnce({
        NetworkAcls: [
          {
            NetworkAclId: 'acl-1',
            Entries: [
              {
                RuleNumber: 110,
                Protocol: '1', // icmp
                RuleAction: 'allow',
                Egress: true,
                CidrBlock: '0.0.0.0/0',
                IcmpTypeCode: { Type: 8, Code: -1 },
              },
            ],
          },
        ],
      });

      const result = await provider.readCurrentState(
        'acl-1|110|true',
        'Logical',
        'AWS::EC2::NetworkAclEntry'
      );
      expect(result?.['IcmpTypeCode']).toEqual({ Type: 8, Code: -1 });
      expect(result?.['Protocol']).toBe(1);
    });

    it('returns undefined when entry has been removed', async () => {
      mockSend.mockResolvedValueOnce({
        NetworkAcls: [{ NetworkAclId: 'acl-1', Entries: [] }],
      });
      const result = await provider.readCurrentState(
        'acl-1|100|false',
        'Logical',
        'AWS::EC2::NetworkAclEntry'
      );
      expect(result).toBeUndefined();
    });
  });

  describe('AWS::EC2::SubnetNetworkAclAssociation', () => {
    it('returns NetworkAclId + SubnetId when AWS still has the association', async () => {
      mockSend.mockResolvedValueOnce({
        NetworkAcls: [
          {
            NetworkAclId: 'acl-2',
            Associations: [
              {
                NetworkAclAssociationId: 'aclassoc-1',
                NetworkAclId: 'acl-2',
                SubnetId: 'subnet-1',
              },
            ],
          },
        ],
      });

      const result = await provider.readCurrentState(
        'aclassoc-1',
        'Logical',
        'AWS::EC2::SubnetNetworkAclAssociation'
      );
      expect(result).toEqual({ NetworkAclId: 'acl-2', SubnetId: 'subnet-1' });
    });

    it('returns undefined when no NACL has the association id', async () => {
      mockSend.mockResolvedValueOnce({ NetworkAcls: [] });
      const result = await provider.readCurrentState(
        'aclassoc-missing',
        'Logical',
        'AWS::EC2::SubnetNetworkAclAssociation'
      );
      expect(result).toBeUndefined();
    });
  });

  describe('getDriftUnknownPaths', () => {
    // Sub-resource types whose AWS objects do NOT carry tags (route
    // entries, NACL entries, route-table associations, NACL
    // associations, IGW attachments). The CFn schemas for these types
    // also do not model `Tags`. Declaring `'Tags'` as drift-unknown is
    // defense-in-depth for future schema changes / custom property
    // overrides.
    const SUB_RESOURCE_TYPES = [
      'AWS::EC2::Route',
      'AWS::EC2::VPCGatewayAttachment',
      'AWS::EC2::SubnetRouteTableAssociation',
      'AWS::EC2::SecurityGroupIngress',
      'AWS::EC2::NetworkAclEntry',
      'AWS::EC2::SubnetNetworkAclAssociation',
    ] as const;

    for (const t of SUB_RESOURCE_TYPES) {
      it(`returns ['Tags'] for ${t}`, () => {
        expect(provider.getDriftUnknownPaths(t)).toEqual(['Tags']);
      });
    }

    it('returns [] for tag-bearing parent resource types (VPC / Subnet / SG / Instance / etc.)', () => {
      const TAG_BEARING_TYPES = [
        'AWS::EC2::VPC',
        'AWS::EC2::Subnet',
        'AWS::EC2::InternetGateway',
        'AWS::EC2::NatGateway',
        'AWS::EC2::RouteTable',
        'AWS::EC2::SecurityGroup',
        'AWS::EC2::Instance',
        'AWS::EC2::NetworkAcl',
      ];
      for (const t of TAG_BEARING_TYPES) {
        expect(provider.getDriftUnknownPaths(t)).toEqual([]);
      }
    });
  });
});
