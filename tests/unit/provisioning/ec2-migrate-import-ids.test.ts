import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  DescribeInstancesCommand,
  DescribeInternetGatewaysCommand,
  DescribeNetworkAclsCommand,
  DescribeRouteTablesCommand,
} from '@aws-sdk/client-ec2';

const mockSend = vi.fn();

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    ec2: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
  }),
}));

vi.mock('../../../src/utils/logger.js', () => {
  const fns = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => fns };
  return { getLogger: () => fns };
});

import { EC2Provider } from '../../../src/provisioning/providers/ec2-provider.js';

/**
 * Issue #3661: `--migrate-from-cloudformation` hands `import()` the physical
 * ids `DescribeStackResources` reports. These nine types returned `null`, so
 * the CloudFormation stack was retired with them orphaned and the next deploy
 * re-created them. The CloudFormation ids below were MEASURED on a stack
 * CloudFormation created (2026-09-25, recorded on the issue); each arm must
 * also accept cdkd's own form, which the #1852 heal re-reads with.
 */
const VPC = 'vpc-0ae97b9333626cb64';
const RTB = 'rtb-060869cb45357a579';
const IGW = 'igw-0803cffd840e0c1fe';
const ACL = 'acl-04a259a5caa34a32c';

const importAs = (resourceType: string, knownPhysicalId: string, properties = {}) =>
  new EC2Provider().import({
    logicalId: 'X',
    resourceType,
    stackName: 'S',
    region: 'us-east-1',
    properties,
    knownPhysicalId,
  });

describe('EC2Provider import() of CloudFormation-created VPC plumbing (issue #3661)', () => {
  beforeEach(() => mockSend.mockReset());

  it('RouteTable: verifies the rtb- id and records RouteTableId', async () => {
    mockSend.mockResolvedValueOnce({ RouteTables: [{ RouteTableId: RTB }] });
    await expect(importAs('AWS::EC2::RouteTable', RTB)).resolves.toStrictEqual({
      physicalId: RTB,
      attributes: { RouteTableId: RTB },
    });
    expect(mockSend.mock.calls[0]![0]).toBeInstanceOf(DescribeRouteTablesCommand);
  });

  it('InternetGateway: verifies the igw- id and records InternetGatewayId', async () => {
    mockSend.mockResolvedValueOnce({ InternetGateways: [{ InternetGatewayId: IGW }] });
    await expect(importAs('AWS::EC2::InternetGateway', IGW)).resolves.toStrictEqual({
      physicalId: IGW,
      attributes: { InternetGatewayId: IGW },
    });
  });

  it('NetworkAcl: verifies the acl- id and records Id', async () => {
    mockSend.mockResolvedValueOnce({ NetworkAcls: [{ NetworkAclId: ACL }] });
    await expect(importAs('AWS::EC2::NetworkAcl', ACL)).resolves.toStrictEqual({
      physicalId: ACL,
      attributes: { Id: ACL },
    });
  });

  it('Route: CloudFormation `rtb|destination` is verified against the table routes', async () => {
    mockSend.mockResolvedValue({
      RouteTables: [{ Routes: [{ DestinationCidrBlock: '0.0.0.0/0', GatewayId: IGW }] }],
    });
    await expect(importAs('AWS::EC2::Route', `${RTB}|0.0.0.0/0`)).resolves.toStrictEqual({
      physicalId: `${RTB}|0.0.0.0/0`,
      attributes: {},
    });
    await expect(importAs('AWS::EC2::Route', `${RTB}|10.9.0.0/16`)).resolves.toBeNull();
  });

  it('VPCGatewayAttachment: CloudFormation `IGW|vpc` is rebuilt as cdkd `igw|vpc` from the template', async () => {
    mockSend.mockResolvedValueOnce({
      InternetGateways: [
        { InternetGatewayId: IGW, Attachments: [{ VpcId: VPC, State: 'available' }] },
      ],
    });
    await expect(
      importAs('AWS::EC2::VPCGatewayAttachment', `IGW|${VPC}`, {
        VpcId: VPC,
        InternetGatewayId: IGW,
      })
    ).resolves.toStrictEqual({ physicalId: `${IGW}|${VPC}`, attributes: {} });
    const call = mockSend.mock.calls[0]![0] as DescribeInternetGatewaysCommand;
    expect(call.input).toEqual({ InternetGatewayIds: [IGW] });
  });

  it('VPCGatewayAttachment: with no gateway in the template, finds the one attached to the VPC', async () => {
    mockSend.mockResolvedValueOnce({
      InternetGateways: [
        { InternetGatewayId: IGW, Attachments: [{ VpcId: VPC, State: 'available' }] },
      ],
    });
    await expect(
      importAs('AWS::EC2::VPCGatewayAttachment', `${VPC}|IGW`)
    ).resolves.toStrictEqual({ physicalId: `${IGW}|${VPC}`, attributes: {} });
    const call = mockSend.mock.calls[0]![0] as DescribeInternetGatewaysCommand;
    expect(call.input).toEqual({ Filters: [{ Name: 'attachment.vpc-id', Values: [VPC] }] });
  });

  it('VPCGatewayAttachment: cdkd `igw|vpc` (the heal re-read) round-trips', async () => {
    mockSend.mockResolvedValueOnce({
      InternetGateways: [
        { InternetGatewayId: IGW, Attachments: [{ VpcId: VPC, State: 'available' }] },
      ],
    });
    await expect(
      importAs('AWS::EC2::VPCGatewayAttachment', `${IGW}|${VPC}`)
    ).resolves.toStrictEqual({ physicalId: `${IGW}|${VPC}`, attributes: {} });
  });

  it('VPCGatewayAttachment: declines a VPN gateway attachment without an AWS call', async () => {
    await expect(
      importAs('AWS::EC2::VPCGatewayAttachment', `VGW|${VPC}`, { VpnGatewayId: 'vgw-1' })
    ).resolves.toBeNull();
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('NetworkAclEntry: a generated CloudFormation name is located from the template', async () => {
    mockSend.mockResolvedValueOnce({
      NetworkAcls: [{ Entries: [{ RuleNumber: 100, Egress: false }] }],
    });
    await expect(
      importAs('AWS::EC2::NetworkAclEntry', 'CdkdEc-AclEn-aRdUO3zKO34t', {
        NetworkAclId: ACL,
        RuleNumber: 100,
        Egress: false,
      })
    ).resolves.toStrictEqual({ physicalId: `${ACL}|100|false`, attributes: {} });
    const call = mockSend.mock.calls[0]![0] as DescribeNetworkAclsCommand;
    expect(call.input).toEqual({ NetworkAclIds: [ACL] });
  });

  it('NetworkAclEntry: cdkd `acl|rule|egress` round-trips, and a missing entry declines', async () => {
    mockSend.mockResolvedValue({ NetworkAcls: [{ Entries: [{ RuleNumber: 100, Egress: true }] }] });
    await expect(importAs('AWS::EC2::NetworkAclEntry', `${ACL}|100|true`)).resolves.toStrictEqual({
      physicalId: `${ACL}|100|true`,
      attributes: {},
    });
    await expect(importAs('AWS::EC2::NetworkAclEntry', `${ACL}|100|false`)).resolves.toBeNull();
  });

  it('SubnetRouteTableAssociation: verifies the rtbassoc- id by association filter', async () => {
    mockSend.mockResolvedValueOnce({ RouteTables: [{ RouteTableId: RTB }] });
    await expect(
      importAs('AWS::EC2::SubnetRouteTableAssociation', 'rtbassoc-0e3721ddbb09c89e3')
    ).resolves.toStrictEqual({ physicalId: 'rtbassoc-0e3721ddbb09c89e3', attributes: {} });
  });

  it('SubnetNetworkAclAssociation: verifies the aclassoc- id and records AssociationId', async () => {
    mockSend.mockResolvedValueOnce({ NetworkAcls: [{ NetworkAclId: ACL }] });
    await expect(
      importAs('AWS::EC2::SubnetNetworkAclAssociation', 'aclassoc-08c2890fd610c6c31')
    ).resolves.toStrictEqual({
      physicalId: 'aclassoc-08c2890fd610c6c31',
      attributes: { AssociationId: 'aclassoc-08c2890fd610c6c31' },
    });
  });

  it('Instance: records the describedInstanceAttributes map, and declines a terminated one', async () => {
    mockSend.mockResolvedValueOnce({
      Reservations: [
        {
          Instances: [
            {
              InstanceId: 'i-0abc',
              State: { Name: 'running' },
              PrivateIpAddress: '10.0.0.5',
              PrivateDnsName: 'ip-10-0-0-5.ec2.internal',
              Placement: { AvailabilityZone: 'us-east-1a' },
            },
          ],
        },
      ],
    });
    const result = await importAs('AWS::EC2::Instance', 'i-0abc');
    expect(result?.physicalId).toBe('i-0abc');
    expect(result?.attributes).toMatchObject({
      InstanceId: 'i-0abc',
      PrivateIp: '10.0.0.5',
      AvailabilityZone: 'us-east-1a',
    });
    expect(mockSend.mock.calls[0]![0]).toBeInstanceOf(DescribeInstancesCommand);

    mockSend.mockResolvedValueOnce({
      Reservations: [{ Instances: [{ InstanceId: 'i-0abc', State: { Name: 'terminated' } }] }],
    });
    await expect(importAs('AWS::EC2::Instance', 'i-0abc')).resolves.toBeNull();
  });

  it('Route: an IPv6 and a prefix-list destination match, and a 3-segment id declines', async () => {
    mockSend.mockResolvedValue({
      RouteTables: [
        { Routes: [{ DestinationIpv6CidrBlock: '::/0' }, { DestinationPrefixListId: 'pl-0abc' }] },
      ],
    });
    await expect(importAs('AWS::EC2::Route', `${RTB}|::/0`)).resolves.not.toBeNull();
    await expect(importAs('AWS::EC2::Route', `${RTB}|pl-0abc`)).resolves.not.toBeNull();
    mockSend.mockClear();
    await expect(importAs('AWS::EC2::Route', `${RTB}|0.0.0.0/0|x`)).resolves.toBeNull();
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('Route: a non-canonical IPv4 CIDR in the id matches the host-bit-cleared route AWS stores (#1771)', async () => {
    mockSend.mockResolvedValueOnce({
      RouteTables: [{ Routes: [{ DestinationCidrBlock: '100.68.0.0/18' }] }],
    });
    await expect(importAs('AWS::EC2::Route', `${RTB}|100.68.0.18/18`)).resolves.toStrictEqual({
      physicalId: `${RTB}|100.68.0.18/18`,
      attributes: {},
    });
  });

  it('VPCGatewayAttachment: a detached gateway is not adopted', async () => {
    mockSend.mockResolvedValueOnce({
      InternetGateways: [
        { InternetGatewayId: IGW, Attachments: [{ VpcId: VPC, State: 'detached' }] },
      ],
    });
    await expect(
      importAs('AWS::EC2::VPCGatewayAttachment', `IGW|${VPC}`, { InternetGatewayId: IGW })
    ).resolves.toBeNull();
  });

  it('NetworkAclEntry: a string `Egress: "true"` and an absent `Egress` (false) both locate the entry', async () => {
    mockSend.mockResolvedValueOnce({ NetworkAcls: [{ Entries: [{ RuleNumber: 7, Egress: true }] }] });
    await expect(
      importAs('AWS::EC2::NetworkAclEntry', 'Gen-Name-1', {
        NetworkAclId: ACL,
        RuleNumber: '7',
        Egress: 'true',
      })
    ).resolves.toStrictEqual({ physicalId: `${ACL}|7|true`, attributes: {} });
    mockSend.mockResolvedValueOnce({ NetworkAcls: [{ Entries: [{ RuleNumber: 7, Egress: false }] }] });
    await expect(
      importAs('AWS::EC2::NetworkAclEntry', 'Gen-Name-2', { NetworkAclId: ACL, RuleNumber: 7 })
    ).resolves.toStrictEqual({ physicalId: `${ACL}|7|false`, attributes: {} });
  });

  it('Instance: a shutting-down instance is declined', async () => {
    mockSend.mockResolvedValueOnce({
      Reservations: [{ Instances: [{ InstanceId: 'i-0abc', State: { Name: 'shutting-down' } }] }],
    });
    await expect(importAs('AWS::EC2::Instance', 'i-0abc')).resolves.toBeNull();
  });

  it.each([
    ['AWS::EC2::RouteTable', 'Stack-Rtb-1ABC'],
    ['AWS::EC2::InternetGateway', 'Stack-Igw-1ABC'],
    ['AWS::EC2::NetworkAcl', 'Stack-Acl-1ABC'],
    ['AWS::EC2::Route', 'Stack-Route-1ABC'],
    ['AWS::EC2::SubnetRouteTableAssociation', 'Stack-Assoc-1ABC'],
    ['AWS::EC2::SubnetNetworkAclAssociation', 'Stack-Assoc-1ABC'],
    ['AWS::EC2::Instance', 'Stack-Inst-1ABC'],
  ])('%s: a malformed id declines WITHOUT an AWS call (a *.Malformed throw would abort the import)', async (type, id) => {
    await expect(importAs(type, id)).resolves.toBeNull();
    expect(mockSend).not.toHaveBeenCalled();
  });
});
