import {
  ACCOUNT,
  createOnlyOf,
  DECLARED_DEFAULT,
  record,
  setOutputOverrides,
  TAG_THROWS,
  wire,
  type Bag,
  type BagCase,
  type Throw,
  type TypeCase,
} from './sdk-wire-harness.js';
import { describe, expect, it } from 'vite-plus/test';
import type { ResourceProvider } from '../../../src/types/resource.js';
import { ResourceUpdateNotSupportedError } from '../../../src/utils/error-handler.js';
import { EC2Provider } from '../../../src/provisioning/providers/ec2-provider.js';

/**
 * The sixteenth batch's EC2 wire cases (#3723): every type `EC2Provider`
 * handles, run by `sdk-wire-coverage-16-ec2.test.ts`.
 */

/**
 * A copy sharing no object with any other bag: the harness's `without` is a
 * `structuredClone`, which KEEPS shared references.
 */
const fresh = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const SRC = 'ec2-provider.ts';
const TAGS = [
  { Key: 'k1', Value: 'v1' },
  { Key: 'k2', Value: 'v2' },
];
const ALL = ['create', 'update-add', 'update-remove'];

/**
 * The provider with its retry / settle delays answered at once: the fake
 * reads answer the settled state on the first poll, so a delay only slows the
 * run. Nothing it sends changes.
 */
const ec2 = (): ResourceProvider =>
  Object.assign(new EC2Provider(), { sleep: () => new Promise<void>((resolve) => setImmediate(resolve)) }) as ResourceProvider;

/**
 * A provider whose `update()` is answered in place. The two association types'
 * real `update()` always refuses (no in-place API, ${SRC}:5737-5748 and
 * 1890-1896), and every handled property is create-only, so the engine
 * replaces on any change and the bag probes skip every update comparison; only
 * the harness's no-op `settled` update would reach it. `describeEc2Extras`
 * pins the real refusal, with nothing on the wire.
 */
const refusingUpdate = (): ResourceProvider => {
  const real = ec2();
  return Object.assign(Object.create(real) as ResourceProvider, {
    update: async (_logicalId: string, physicalId: string) => ({ physicalId, wasReplaced: false }),
  });
};

const required = (top: string, says: RegExp, line: string): Throw => ({
  why: `create() refuses a missing ${top} before any call (${SRC}:${line})`,
  says,
});

/**
 * Declaring a non-default `InstanceTenancy` on a VPC that lacks it is a
 * replacement (`vpcInstanceTenancyChangeReplaces`, replacement-rules.ts:53,
 * CloudFormation measured, go-to-k/cdkd#5449); only `drift --revert` reaches
 * `update()` with it, which refuses before any call.
 */
const TENANCY_REFUSED: Throw = {
  why: `default -> dedicated replaces the VPC in the engine (replacement-rules.ts:53); update() refuses that direction before any call (${SRC}:2463-2479)`,
  says: /AWS changes InstanceTenancy in place only to default/,
};

const EIP_KEPT = (member: string): string =>
  `a ${member} change is deliberately not applied: CloudFormation neither replaces the address nor changes it (change set "Modify, RequiresRecreation: Never", measured, go-to-k/cdkd#5449), and AWS has no call to move one (${SRC}:3607-3612)`;

const GATEWAY_REQUIRED: Throw = {
  why: `VpcId and exactly one of InternetGatewayId / VpnGatewayId are refused before any call when missing (${SRC}:3775-3792)`,
  says: /VpcId and exactly one of InternetGatewayId \/ VpnGatewayId are required/,
};

const NAT_UNCHANGEABLE: Throw = {
  why: `update() refuses a changed secondary address set before any call, naming the replacement (${SRC}:4660-4668)`,
  says: /cdkd cannot change Secondary\w+ of an existing NAT gateway/,
};
const NAT_SUBNET_REQUIRED: Throw = {
  why: `create() refuses a zonal NAT gateway with no SubnetId before any call (${SRC}:4492-4499)`,
  says: /SubnetId is required for NatGateway/,
};
const NAT_ZONE_UNUSABLE: Throw = {
  why: `an AvailabilityZoneAddresses entry missing its zone or allocation ids is refused before any call (${SRC}:775-795)`,
  says: /each entry needs AvailabilityZone or AvailabilityZoneId and a non-empty AllocationIds list/,
};
const ROUTE_REQUIRED: Throw = {
  why: `create() refuses a route with no RouteTableId or destination before any call (${SRC}:5294-5300)`,
  says: /RouteTableId and one of DestinationCidrBlock/,
};

const INGRESS_GROUP_REQUIRED = {
  'create:GroupId': required('GroupId', /GroupId is required for SecurityGroupIngress/, '6381-6387'),
};

const ACL_ENTRY_REQUIRED: Record<string, Throw> = {
  ...Object.fromEntries(
    ['NetworkAclId', 'RuleNumber', 'Protocol', 'RuleAction'].map((k) => [
      `create:${k}`,
      required(k, /NetworkAclId, RuleNumber, Protocol, and RuleAction are required/, '9671-9677'),
    ])
  ),
  ...Object.fromEntries(
    ['Protocol', 'RuleAction'].map((k) => [
      `update-remove:${k}`,
      {
        why: `Protocol and RuleAction are required by the CloudFormation schema; ReplaceNetworkAclEntry re-sends the whole entry, so update() refuses a missing one before any call (${SRC}:9851-9857)`,
        says: /Protocol and RuleAction are required for NetworkAclEntry/,
      },
    ])
  ),
};

const tc = (
  resourceType: string,
  physicalId: string,
  bags: BagCase[],
  extra: Partial<TypeCase> = {}
): TypeCase => ({
  resourceType,
  provider: ec2,
  physicalId,
  createOnly: createOnlyOf(resourceType),
  exempt: {},
  targets: [],
  bags: bags.map((b) => ({ ...b, bag: fresh(b.bag) })),
  ...extra,
});

const tagTargets = (command = 'DeleteTagsCommand') => [
  { path: ['Tags', 0], command, names: 'k1', notNames: 'k2' },
  { path: ['Tags', 1], command, names: 'k2', notNames: 'k1' },
];

const INSTANCE_THROWS: Record<string, Throw> = {
  'create:ImageId': required('ImageId', /ImageId is required for EC2 Instance/, '7428-7434'),
  'update-remove:InstanceType': {
    why: `CloudFormation fails an update that removes InstanceType ("No attributes specified", measured, go-to-k/cdkd#5446), so update() refuses it before any call (${SRC}:8280-8286)`,
    says: /InstanceType was removed from the template, and CloudFormation fails that update/,
  },
};

const INSTANCE_KEPT = (member: string): string =>
  `kept on removal: CloudFormation leaves a removed ${member} as it is (real CloudFormation A/B, #1160), so a removed one sends nothing (${SRC}:8110-8115)`;

/**
 * A BlockDeviceMappings change other than a DeleteOnTermination-only one is a
 * replacement (`instanceBlockDeviceMappingsChangeReplaces`,
 * replacement-rules.ts:96, 1098; CloudFormation measured, go-to-k/cdkd#5446),
 * so `update()` never applies it (${SRC}:8371-8381). The DeleteOnTermination
 * flips themselves reach the wire (ModifyInstanceAttribute), which the
 * update-add / update-remove probes of `Ebs.DeleteOnTermination` observe; its
 * update-vary drops the whole Ebs block from the base, a replacing change.
 */
const BDM_REASON = `a BlockDeviceMappings change other than a DeleteOnTermination-only one is routed to replacement (replacement-rules.ts:96, 1098; go-to-k/cdkd#5446), so update() applies none of it (${SRC}:8371-8381)`;
const BDM_PATHS = [
  '',
  '.0',
  '.0.DeviceName',
  '.0.Ebs',
  '.0.Ebs.Encrypted',
  '.0.Ebs.Iops',
  '.0.Ebs.KmsKeyId',
  '.0.Ebs.SnapshotId',
  '.0.Ebs.VolumeSize',
  '.0.Ebs.VolumeType',
  '.1',
  '.1.DeviceName',
  '.1.VirtualName',
  '.2',
  '.2.DeviceName',
  '.2.NoDevice',
];
const BDM_VARIED = [
  '.0.DeviceName',
  '.0.Ebs.DeleteOnTermination',
  '.0.Ebs.Encrypted',
  '.0.Ebs.Iops',
  '.0.Ebs.KmsKeyId',
  '.0.Ebs.SnapshotId',
  '.0.Ebs.VolumeSize',
  '.0.Ebs.VolumeType',
  '.1.DeviceName',
  '.1.VirtualName',
  '.2.DeviceName',
];
const BDM_REPLACES: Record<string, string> = Object.fromEntries([
  ...BDM_PATHS.flatMap((p) =>
    ['update-add', 'update-remove'].map((d) => [`${d}:BlockDeviceMappings${p}`, BDM_REASON])
  ),
  ...BDM_VARIED.map((p) => [`update-vary:BlockDeviceMappings${p}`, BDM_REASON]),
]);

const INSTANCE_CASE: TypeCase = tc(
    'AWS::EC2::Instance',
    'i-1',
    [
      {
        name: 'subnet and group ids',
        bag: {
          ImageId: 'ami-1',
          InstanceType: 't3.small',
          KeyName: 'key',
          SecurityGroupIds: ['sg-1', 'sg-2'],
          SubnetId: 'subnet-1',
          IamInstanceProfile: 'profile',
          UserData: 'ZWNobw==',
          BlockDeviceMappings: [
            {
              DeviceName: '/dev/xvda',
              Ebs: {
                DeleteOnTermination: false,
                Encrypted: true,
                Iops: 3000,
                KmsKeyId: 'key-1',
                SnapshotId: 'snap-1',
                VolumeSize: 20,
                VolumeType: 'gp3',
              },
            },
            { DeviceName: '/dev/sdb', VirtualName: 'ephemeral0' },
            { DeviceName: '/dev/sdc', NoDevice: {} },
          ],
          Tags: TAGS,
          AvailabilityZone: 'us-east-1a',
          DisableApiTermination: true,
          MetadataOptions: {
            HttpEndpoint: 'enabled',
            HttpProtocolIpv6: 'disabled',
            HttpPutResponseHopLimit: 2,
            HttpTokens: 'required',
            InstanceMetadataTags: 'enabled',
          },
          Monitoring: true,
          EbsOptimized: true,
          CreditSpecification: { CPUCredits: 'unlimited' },
        },
        variants: { UserData: 'ZWNobyAy' },
        expectedRemovalThrows: {
          ...TAG_THROWS(ALL, 2),
          ...INSTANCE_THROWS,
          'update-remove:DisableApiTermination': {
            why: `CloudFormation fails an update that removes DisableApiTermination from an existing instance (measured, #1160), so update() refuses it before any call (guardTerminationProtectionRemoval, ${SRC}:8088-8093)`,
            says: /DisableApiTermination was removed from the template, and CloudFormation fails that update/,
          },
        },
        expectedSilent: {
          'update-remove:MetadataOptions': INSTANCE_KEPT('MetadataOptions'),
          'update-remove:CreditSpecification': INSTANCE_KEPT('CreditSpecification'),
          'update-remove:CreditSpecification.CPUCredits': INSTANCE_KEPT('CreditSpecification'),
          ...BDM_REPLACES,
        },
      },
      {
        name: 'classic group names',
        bag: { ImageId: 'ami-1', InstanceType: 't3.small', SecurityGroups: ['default', 'web'] },
        expectedRemovalThrows: INSTANCE_THROWS,
      },
      {
        name: 'network interfaces',
        bag: {
          ImageId: 'ami-1',
          InstanceType: 't3.small',
          NetworkInterfaces: [
            {
              DeviceIndex: '0',
              AssociatePublicIpAddress: true,
              AssociateCarrierIpAddress: false,
              DeleteOnTermination: true,
              Description: 'eth0',
              EnaSrdSpecification: {
                EnaSrdEnabled: true,
                EnaSrdUdpSpecification: { EnaSrdUdpEnabled: true },
              },
              GroupSet: ['sg-1', 'sg-2'],
              Ipv6AddressCount: 1,
              PrivateIpAddress: '10.0.1.10',
              SecondaryPrivateIpAddressCount: 1,
              SubnetId: 'subnet-1',
            },
            {
              DeviceIndex: '1',
              NetworkInterfaceId: 'eni-1',
            },
            {
              DeviceIndex: '2',
              SubnetId: 'subnet-1',
              Ipv6Addresses: [{ Ipv6Address: '2001:db8::1' }],
              PrivateIpAddresses: [
                { Primary: true, PrivateIpAddress: '10.0.1.20' },
                { Primary: false, PrivateIpAddress: '10.0.1.21' },
              ],
            },
          ],
        },
        expectedRemovalThrows: INSTANCE_THROWS,
      },
    ],
    {
      targets: tagTargets(),
      arm: (_id, bag) =>
        setOutputOverrides({
          RunInstancesCommand: () => ({ Instances: [{ InstanceId: 'i-1' }] }),
          // The VPC's default group, which a removed SecurityGroupIds puts in place.
          DescribeSecurityGroupsCommand: () => ({ SecurityGroups: [{ GroupId: 'sg-default' }] }),
          // The profile association: present once the instance has a profile,
          // until a disassociate is the last write.
          DescribeIamInstanceProfileAssociationsCommand: () => ({
            IamInstanceProfileAssociations:
              (bag['IamInstanceProfile'] !== undefined || wire.length > 0) &&
              !wire.at(-1)?.includes('DisassociateIamInstanceProfile')
                ? [
                    {
                      AssociationId: 'iip-assoc-1',
                      InstanceId: 'i-1',
                      State: 'associated',
                      IamInstanceProfile: { Arn: `arn:aws:iam::${ACCOUNT}:instance-profile/profile` },
                    },
                  ]
                : [],
          }),
          DescribeInstancesCommand: () => ({
            Reservations: [
              {
                Instances: [
                  {
                    InstanceId: 'i-1',
                    // Stopped once a StopInstances is the last write (the
                    // in-place InstanceType / UserData path), else running.
                    State: wire.at(-1)?.includes('StopInstances')
                      ? { Name: 'stopped', Code: 80 }
                      : { Name: 'running', Code: 16 },
                    InstanceType: bag['InstanceType'] ?? 't3.micro',
                    VpcId: 'vpc-1',
                  },
                ],
              },
            ],
          }),
        }),
    }
  );
// An EbsOptimized change is a replacement (replacement-rules.ts:1062-1083: it
// is accepted only on a STOPPED instance), so the update probes skip it, as
// the engine's replacement would.
INSTANCE_CASE.createOnly = new Set([...INSTANCE_CASE.createOnly, 'EbsOptimized']);

export const CASES_16_EC2: TypeCase[] = [
  tc(
    'AWS::EC2::VPC',
    'vpc-1',
    [
      {
        name: 'full',
        bag: {
          CidrBlock: '10.0.0.0/16',
          InstanceTenancy: 'dedicated',
          EnableDnsHostnames: true,
          EnableDnsSupport: false,
          Tags: TAGS,
        },
        expectedRemovalThrows: {
          ...TAG_THROWS(ALL, 2),
          'create:CidrBlock': required('CidrBlock', /CidrBlock is required for VPC/, '2264'),
          'update-add:InstanceTenancy': TENANCY_REFUSED,
        },
        expectedSilent: {
          'update-vary:InstanceTenancy': `the varied update declares a non-default tenancy the base lacks, which is refused before any call (${SRC}:2474-2479), so neither side reaches the wire; the removal (dedicated -> default, ModifyVpcTenancy) is what update-remove observes`,
        },
      },
    ],
    { targets: tagTargets() }
  ),
  tc(
    'AWS::EC2::Subnet',
    'subnet-1',
    [
      {
        name: 'full',
        bag: {
          VpcId: 'vpc-1',
          CidrBlock: '10.0.1.0/24',
          AvailabilityZone: 'us-east-1a',
          MapPublicIpOnLaunch: true,
          Tags: TAGS,
        },
        expectedRemovalThrows: {
          ...TAG_THROWS(ALL, 2),
          'create:VpcId': required('VpcId', /VpcId and CidrBlock are required for Subnet/, '2724'),
          'create:CidrBlock': required('CidrBlock', /VpcId and CidrBlock are required for Subnet/, '2724'),
        },
      },
    ],
    { targets: tagTargets() }
  ),
  tc(
    'AWS::EC2::InternetGateway',
    'igw-1',
    [{ name: 'full', bag: { Tags: TAGS }, expectedRemovalThrows: TAG_THROWS(ALL, 2) }],
    { targets: tagTargets() }
  ),
  tc(
    'AWS::EC2::EIP',
    'eipalloc-1',
    [
      {
        name: 'full',
        bag: {
          Domain: 'vpc',
          InstanceId: 'i-1',
          NetworkBorderGroup: 'us-east-1',
          PublicIpv4Pool: 'amazon',
          Tags: TAGS,
        },
        expectedRemovalThrows: TAG_THROWS(ALL, 2),
        expectedSilent: {
          'create:Domain': `${DECLARED_DEFAULT}: an absent Domain is sent as vpc (${SRC}:3392-3397), which create-vary observes changing`,
          'update-add:Domain': EIP_KEPT('Domain'),
          'update-remove:Domain': EIP_KEPT('Domain'),
          'update-vary:Domain': EIP_KEPT('Domain'),
          'update-add:PublicIpv4Pool': EIP_KEPT('PublicIpv4Pool'),
          'update-remove:PublicIpv4Pool': EIP_KEPT('PublicIpv4Pool'),
          'update-vary:PublicIpv4Pool': EIP_KEPT('PublicIpv4Pool'),
        },
      },
    ],
    {
      targets: tagTargets(),
      arm: (_id, bag) =>
        setOutputOverrides({
          DescribeAddressesCommand: () => ({
            Addresses: [
              {
                AllocationId: 'eipalloc-1',
                ...(bag['InstanceId'] ? { AssociationId: 'eipassoc-1', InstanceId: bag['InstanceId'] } : {}),
              },
            ],
          }),
        }),
    }
  ),
  tc(
    'AWS::EC2::VPCGatewayAttachment',
    'igw-1|vpc-1',
    [
      {
        name: 'internet gateway',
        bag: { VpcId: 'vpc-1', InternetGatewayId: 'igw-1' },
        expectedRemovalThrows: {
          'create:VpcId': GATEWAY_REQUIRED,
          'create:InternetGatewayId': GATEWAY_REQUIRED,
          'update-add:InternetGatewayId': GATEWAY_REQUIRED,
          'update-remove:InternetGatewayId': GATEWAY_REQUIRED,
        },
      },
      {
        name: 'VPN gateway',
        bag: { VpcId: 'vpc-1', VpnGatewayId: 'vgw-1' },
        expectedRemovalThrows: {
          'create:VpcId': GATEWAY_REQUIRED,
          'create:VpnGatewayId': GATEWAY_REQUIRED,
          'update-add:VpnGatewayId': GATEWAY_REQUIRED,
          'update-remove:VpnGatewayId': GATEWAY_REQUIRED,
        },
      },
    ],
    {
      // The live attachment: the previous bag's gateway on its VPC until a
      // write, then what the last attach / detach left, so each wait returns
      // on its first poll and an attach of a gateway not yet attached is sent.
      arm: (_id, bag) =>
        setOutputOverrides({
          DescribeVpnGatewaysCommand: (input) => {
            const id = (input['VpnGatewayIds'] as string[] | undefined)?.[0];
            const last = wire.at(-1) ?? '';
            const vpcId = /VpcId=([^&"\\]+)/.exec(last)?.[1] ?? bag['VpcId'];
            const attached =
              last === ''
                ? bag['VpnGatewayId'] === id
                : last.includes('AttachVpnGateway') && last.includes(`VpnGatewayId=${id}`);
            return {
              VpnGateways: [
                { VpnGatewayId: id, VpcAttachments: [{ VpcId: vpcId, State: attached ? 'attached' : 'detached' }] },
              ],
            };
          },
        }),
    }
  ),
  tc(
    'AWS::EC2::NatGateway',
    'nat-1',
    [
      {
        name: 'public, zonal',
        bag: {
          AllocationId: 'eipalloc-1',
          SubnetId: 'subnet-1',
          ConnectivityType: 'public',
          PrivateIpAddress: '10.0.1.10',
          SecondaryAllocationIds: ['eipalloc-2', 'eipalloc-3'],
          SecondaryPrivateIpAddresses: ['10.0.1.11', '10.0.1.12'],
          Tags: TAGS,
        },
        expectedRemovalThrows: {
          ...TAG_THROWS(ALL, 2),
          'create:SubnetId': NAT_SUBNET_REQUIRED,
          ...Object.fromEntries(
            ['SecondaryAllocationIds', 'SecondaryPrivateIpAddresses'].flatMap((top) =>
              ['', '.0', '.1'].flatMap((i) =>
                ['update-add', 'update-remove'].map((d) => [`${d}:${top}${i}`, NAT_UNCHANGEABLE])
              )
            )
          ),
        },
        expectedSilent: Object.fromEntries(
          ['SecondaryAllocationIds', 'SecondaryPrivateIpAddresses'].flatMap((top) =>
            [0, 1].map((i) => [`update-vary:${top}.${i}`, NAT_UNCHANGEABLE.why])
          )
        ),
      },
      {
        name: 'private, address count',
        bag: {
          SubnetId: 'subnet-1',
          ConnectivityType: 'private',
          SecondaryPrivateIpAddressCount: 2,
        },
        expectedRemovalThrows: {
          'create:SubnetId': NAT_SUBNET_REQUIRED,
          'update-add:SecondaryPrivateIpAddressCount': NAT_UNCHANGEABLE,
          'update-remove:SecondaryPrivateIpAddressCount': NAT_UNCHANGEABLE,
        },
        expectedSilent: { 'update-vary:SecondaryPrivateIpAddressCount': NAT_UNCHANGEABLE.why },
      },
      {
        name: 'regional',
        bag: {
          AvailabilityMode: 'regional',
          VpcId: 'vpc-1',
          ConnectivityType: 'public',
          AvailabilityZoneAddresses: [
            { AvailabilityZone: 'us-east-1a', AllocationIds: ['eipalloc-4'] },
            { AvailabilityZoneId: 'use1-az2', AllocationIds: ['eipalloc-5'] },
          ],
        },
        expectedRemovalThrows: {
          'create:AvailabilityMode': NAT_SUBNET_REQUIRED,
          'update-add:AvailabilityZoneAddresses': {
            why: `adding AvailabilityZoneAddresses to a gateway created without it is refused before any call, naming the replacement (${SRC}:4694-4700)`,
            says: /Adding AvailabilityZoneAddresses to a gateway created without it replaces the gateway/,
          },
          'update-remove:AvailabilityZoneAddresses': {
            why: `dropping AvailabilityZoneAddresses is refused before any call: the gateway does not return to automatic zone expansion, and CloudFormation refuses the same update (${SRC}:4794-4799)`,
            says: /cannot drop AvailabilityZoneAddresses/,
          },
          ...Object.fromEntries(
            [
              '0.AllocationIds',
              '0.AllocationIds.0',
              '0.AvailabilityZone',
              '1.AllocationIds',
              '1.AllocationIds.0',
              '1.AvailabilityZoneId',
            ].flatMap((p) =>
              ['create', 'update-remove'].map((d) => [
                `${d}:AvailabilityZoneAddresses.${p}`,
                NAT_ZONE_UNUSABLE,
              ])
            )
          ),
        },
        expectedSilent: {
          'create-vary:AvailabilityMode': `the varied (non-regional) mode is a zonal gateway, which needs the SubnetId this bag does not carry, so it is refused before any call (${SRC}:4492-4499); the removal probe observes the mode reaching the wire`,
        },
      },
    ],
    {
      targets: tagTargets(),
      arm: () =>
        setOutputOverrides({
          DescribeNatGatewaysCommand: () => ({
            NatGateways: [{ NatGatewayId: 'nat-1', State: 'available', NatGatewayAddresses: [] }],
          }),
        }),
    }
  ),
  tc('AWS::EC2::RouteTable', 'rtb-1', [
    {
      name: 'full',
      bag: { VpcId: 'vpc-1', Tags: TAGS },
      expectedRemovalThrows: {
        ...TAG_THROWS(ALL, 2),
        'create:VpcId': required('VpcId', /VpcId is required for RouteTable/, '5168-5174'),
      },
    },
  ], {
    targets: tagTargets(),
  }),
  tc(
    'AWS::EC2::Route',
    'rtb-1|0.0.0.0/0',
    [
      ['GatewayId', 'igw-1'],
      ['CarrierGatewayId', 'cagw-1'],
      ['CoreNetworkArn', `arn:aws:networkmanager::${ACCOUNT}:core-network/core-network-1`],
      ['LocalGatewayId', 'lgw-1'],
      ['NatGatewayId', 'nat-1'],
      ['EgressOnlyInternetGatewayId', 'eigw-1'],
      ['InstanceId', 'i-1'],
      ['NetworkInterfaceId', 'eni-1'],
      ['TransitGatewayId', 'tgw-1'],
      ['VpcEndpointId', 'vpce-1'],
      ['VpcPeeringConnectionId', 'pcx-1'],
    ].map(([key, value]): BagCase => ({
      name: key!,
      bag: { RouteTableId: 'rtb-1', DestinationCidrBlock: '0.0.0.0/0', [key!]: value },
      expectedRemovalThrows: {
        'create:RouteTableId': ROUTE_REQUIRED,
        'create:DestinationCidrBlock': ROUTE_REQUIRED,
      },
    })).concat([
      {
        name: 'IPv6 destination',
        bag: { RouteTableId: 'rtb-1', DestinationIpv6CidrBlock: '::/0', GatewayId: 'igw-1' },
        expectedRemovalThrows: {
          'create:RouteTableId': ROUTE_REQUIRED,
          'create:DestinationIpv6CidrBlock': ROUTE_REQUIRED,
        },
      },
      {
        name: 'prefix-list destination',
        bag: { RouteTableId: 'rtb-1', DestinationPrefixListId: 'pl-1', GatewayId: 'igw-1' },
        expectedRemovalThrows: {
          'create:RouteTableId': ROUTE_REQUIRED,
          'create:DestinationPrefixListId': ROUTE_REQUIRED,
        },
      },
    ])
  ),
  tc(
    'AWS::EC2::SubnetRouteTableAssociation',
    'rtbassoc-1',
    [
      {
        name: 'full',
        bag: { SubnetId: 'subnet-1', RouteTableId: 'rtb-1' },
        expectedRemovalThrows: {
          'create:SubnetId': required('SubnetId', /SubnetId and RouteTableId are required/, '5694-5700'),
          'create:RouteTableId': required('RouteTableId', /SubnetId and RouteTableId are required/, '5694-5700'),
        },
      },
    ],
    { provider: refusingUpdate }
  ),
  tc(
    'AWS::EC2::SecurityGroup',
    'sg-1',
    [
      {
        name: 'full',
        bag: {
          GroupDescription: 'desc',
          GroupName: 'name',
          VpcId: 'vpc-1',
          SecurityGroupIngress: [
            { IpProtocol: 'tcp', FromPort: 80, ToPort: 80, CidrIp: '10.0.0.0/8', Description: 'a' },
            { IpProtocol: 'tcp', FromPort: 443, ToPort: 443, CidrIpv6: '::/0' },
            { IpProtocol: 'tcp', FromPort: 22, ToPort: 22, SourcePrefixListId: 'pl-1' },
            {
              IpProtocol: 'tcp',
              FromPort: 23,
              ToPort: 23,
              SourceSecurityGroupId: 'sg-3',
              SourceSecurityGroupOwnerId: ACCOUNT,
            },
          ],
          SecurityGroupEgress: [
            { IpProtocol: 'tcp', FromPort: 80, ToPort: 80, CidrIp: '10.0.0.0/8', Description: 'e' },
            { IpProtocol: 'tcp', FromPort: 443, ToPort: 443, DestinationSecurityGroupId: 'sg-2' },
            { IpProtocol: 'tcp', FromPort: 22, ToPort: 22, CidrIpv6: '::/0' },
            { IpProtocol: 'tcp', FromPort: 23, ToPort: 23, DestinationPrefixListId: 'pl-2' },
          ],
          Tags: TAGS,
        },
        expectedRemovalThrows: {
          ...TAG_THROWS(ALL, 2),
          'create:GroupDescription': required('GroupDescription', /GroupDescription is required/, '5805-5811'),
        },
      },
    ],
    {
      targets: tagTargets(),
      nestedExempt: {
        'SecurityGroupIngress.SourceSecurityGroupName': `the inline Name is not sent (silent drop): the rule builder reads only SourceSecurityGroupId / SourceSecurityGroupOwnerId (${SRC}:9368-9388), and unlike the standalone SecurityGroupIngress twin (${SRC}:1337-1348) the inline member has no unhandledByDesign entry; tracked by go-to-k/cdkd#5478`,
      },
    }
  ),
  tc(
    'AWS::EC2::SecurityGroupIngress',
    'sg-1|tcp|80|80',
    [
      {
        name: 'IPv4',
        bag: { GroupId: 'sg-1', IpProtocol: 'tcp', FromPort: 80, ToPort: 80, CidrIp: '10.0.0.0/8', Description: 'd' },
        expectedRemovalThrows: INGRESS_GROUP_REQUIRED,
      },
      {
        name: 'IPv6',
        bag: { GroupId: 'sg-1', IpProtocol: 'tcp', FromPort: 80, ToPort: 80, CidrIpv6: '::/0' },
        expectedRemovalThrows: INGRESS_GROUP_REQUIRED,
      },
      {
        name: 'source group',
        bag: {
          GroupId: 'sg-1',
          IpProtocol: 'tcp',
          FromPort: 80,
          ToPort: 80,
          SourceSecurityGroupId: 'sg-2',
          SourceSecurityGroupOwnerId: ACCOUNT,
        },
        expectedRemovalThrows: INGRESS_GROUP_REQUIRED,
      },
      {
        name: 'prefix list',
        bag: { GroupId: 'sg-1', IpProtocol: 'tcp', FromPort: 80, ToPort: 80, SourcePrefixListId: 'pl-1' },
        expectedRemovalThrows: INGRESS_GROUP_REQUIRED,
      },
    ]
  ),
  INSTANCE_CASE,
  tc('AWS::EC2::NetworkAcl', 'acl-1', [
    {
      name: 'full',
      bag: { VpcId: 'vpc-1', Tags: TAGS },
      expectedRemovalThrows: {
        ...TAG_THROWS(ALL, 2),
        'create:VpcId': required('VpcId', /VpcId is required for NetworkAcl/, '9548-9554'),
      },
    },
  ], {
    targets: tagTargets(),
  }),
  tc(
    'AWS::EC2::NetworkAclEntry',
    'acl-1|100|true',
    [
      {
        name: 'IPv4 ports',
        bag: {
          NetworkAclId: 'acl-1',
          RuleNumber: 100,
          Protocol: 6,
          RuleAction: 'allow',
          Egress: true,
          CidrBlock: '10.0.0.0/8',
          PortRange: { From: 80, To: 80 },
        },
        expectedRemovalThrows: ACL_ENTRY_REQUIRED,
      },
      {
        name: 'IPv6 ICMP',
        bag: {
          NetworkAclId: 'acl-1',
          RuleNumber: 100,
          Protocol: 58,
          RuleAction: 'deny',
          Egress: true,
          Ipv6CidrBlock: '::/0',
          Icmp: { Code: -1, Type: -1 },
        },
        expectedRemovalThrows: ACL_ENTRY_REQUIRED,
      },
    ]
  ),
  tc(
    'AWS::EC2::SubnetNetworkAclAssociation',
    'aclassoc-1',
    [
      {
        name: 'full',
        bag: { SubnetId: 'subnet-1', NetworkAclId: 'acl-1' },
        expectedRemovalThrows: {
          'create:SubnetId': required('SubnetId', /NetworkAclId and SubnetId are required/, '9930-9936'),
          'create:NetworkAclId': required('NetworkAclId', /NetworkAclId and SubnetId are required/, '9930-9936'),
        },
      },
    ],
    {
      provider: refusingUpdate,
      // The subnet's current (default) ACL association, which the create replaces.
      arm: () =>
        setOutputOverrides({
          DescribeNetworkAclsCommand: (input) => ({
            NetworkAcls: [
              {
                NetworkAclId: 'acl-0',
                Associations: [
                  {
                    SubnetId: (input['Filters'] as { Values: string[] }[] | undefined)?.[0]?.Values[0],
                    // Named for the subnet: the replace call addresses the subnet
                    // through its current association, never by SubnetId.
                    NetworkAclAssociationId: `aclassoc-${String((input['Filters'] as { Values: string[] }[] | undefined)?.[0]?.Values[0])}`,
                  },
                ],
              },
            ],
          }),
        }),
    }
  ),
];

/** Direct-call checks the bag probes cannot make. */
export function describeEc2Extras(): void {
  describe('EC2 association update', () => {
    it.each([
      ['AWS::EC2::SubnetRouteTableAssociation', 'rtbassoc-1', { SubnetId: 'subnet-1', RouteTableId: 'rtb-1' }],
      ['AWS::EC2::SubnetNetworkAclAssociation', 'aclassoc-1', { SubnetId: 'subnet-1', NetworkAclId: 'acl-1' }],
    ])('%s refuses an in-place update and sends nothing', async (resourceType, physicalId, bag) => {
      setOutputOverrides(undefined);
      let thrown: unknown;
      const outcome = await record(async () => {
        try {
          await ec2().update('L', physicalId, resourceType, structuredClone(bag), structuredClone(bag));
        } catch (error) {
          thrown = error;
        }
      });
      expect(outcome).toEqual({ threw: false, wire: '' });
      expect(thrown).toBeInstanceOf(ResourceUpdateNotSupportedError);
    });
  });
}
