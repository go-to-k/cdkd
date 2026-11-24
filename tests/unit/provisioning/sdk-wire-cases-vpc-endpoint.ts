import {
  TAG_THROWS,
  createOnlyOf,
  setOutputOverrides,
  type Throw,
  type TypeCase,
} from './sdk-wire-harness.js';
import { EC2VPCEndpointProvider } from '../../../src/provisioning/providers/ec2-vpc-endpoint-provider.js';

/**
 * The VPC endpoint wire case (go-to-k/cdkd#6939). Run by
 * `sdk-wire-coverage-vpc-endpoint.test.ts`, which mocks the EC2 client
 * `getAwsClients()` answers; the ledger in `sdk-wire-coverage.test.ts` counts
 * it as covered. `DescribeVpcEndpoints` answers `available`, so every wait
 * reads once.
 */

const ID = 'vpce-0123456789abcdef0';
const ALL = ['create', 'update-add', 'update-remove'];
const VPC_REQUIRED: Throw = {
  why: 'VpcId is required by the schema; create() refuses it missing before any call',
  says: /VpcId must be a VPC id/,
};
const VPC_REQUIRED_THROWS = { 'create:VpcId': VPC_REQUIRED };
const NO_RESET_VALUE =
  'a removed IpAddressType / DnsOptions member keeps its live value: the type documents no value to reset it to, and the update caller warns';

const provider = (): EC2VPCEndpointProvider => {
  const p = new EC2VPCEndpointProvider();
  p.endpointWait = { ...p.endpointWait, pollIntervalMs: 0, sleep: async () => {} };
  return p;
};

export const CASES_VPC_ENDPOINT: TypeCase[] = [
  {
    resourceType: 'AWS::EC2::VPCEndpoint',
    provider,
    physicalId: ID,
    createOnly: createOnlyOf('AWS::EC2::VPCEndpoint'),
    arm: () =>
      setOutputOverrides({
        CreateVpcEndpointCommand: () => ({ VpcEndpoint: { VpcEndpointId: ID, State: 'pending' } }),
        DescribeVpcEndpointsCommand: () => ({
          VpcEndpoints: [{ VpcEndpointId: ID, State: 'available' }],
        }),
      }),
    exempt: {},
    targets: [],
    bags: [
      {
        name: 'Interface endpoint, every declared property',
        bag: {
          VpcId: 'vpc-1',
          ServiceName: 'com.amazonaws.us-east-1.secretsmanager',
          VpcEndpointType: 'Interface',
          SubnetIds: ['subnet-1', 'subnet-2'],
          SecurityGroupIds: ['sg-1'],
          PolicyDocument: {
            Statement: [{ Effect: 'Allow', Principal: '*', Action: '*', Resource: '*' }],
          },
          PrivateDnsEnabled: true,
          DnsOptions: {
            DnsRecordIpType: 'ipv4',
            PrivateDnsOnlyForInboundResolverEndpoint: 'OnlyInboundResolver',
            PrivateDnsPreference: 'VERIFIED_DOMAINS_ONLY',
            PrivateDnsSpecifiedDomains: ['example.com'],
          },
          IpAddressType: 'ipv4',
          ServiceRegion: 'us-east-1',
          Tags: [{ Key: 'k1', Value: 'v1' }],
        },
        expectedRemovalThrows: { ...TAG_THROWS(ALL, 1), ...VPC_REQUIRED_THROWS },
        expectedSilent: { 'update-remove:IpAddressType': NO_RESET_VALUE },
      },
      {
        name: 'Gateway endpoint',
        bag: {
          VpcId: 'vpc-1',
          ServiceName: 'com.amazonaws.us-east-1.s3',
          VpcEndpointType: 'Gateway',
          RouteTableIds: ['rtb-1'],
        },
        expectedRemovalThrows: VPC_REQUIRED_THROWS,
      },
      {
        name: 'ServiceNetwork and Resource endpoints',
        bag: {
          VpcId: 'vpc-1',
          VpcEndpointType: 'ServiceNetwork',
          ServiceNetworkArn: 'arn:aws:vpc-lattice:us-east-1:123456789012:servicenetwork/sn-1',
          ResourceConfigurationArn:
            'arn:aws:vpc-lattice:us-east-1:123456789012:resourceconfiguration/rcfg-1',
          SubnetIds: ['subnet-1'],
        },
        expectedRemovalThrows: VPC_REQUIRED_THROWS,
      },
    ],
  },
];
