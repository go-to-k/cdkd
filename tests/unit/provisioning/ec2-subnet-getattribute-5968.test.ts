import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';

// go-to-k/cdkd#5968: `cdkd orphan` reads a Subnet's `Fn::GetAtt` through the
// provider's `getAttribute`, which answered only `SubnetId` / `AvailabilityZone`
// (and, after #5946, the create-only members). Every return value is now read
// live, in the SAME value shapes the deploy resolver's Subnet arm (#5944)
// serves: what `cdkd orphan` splices into a sibling is what a deploy resolves.

const mockEc2Send = vi.hoisted(() => vi.fn());
vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    sts: { send: vi.fn().mockResolvedValue({ Account: '123456789012' }) },
    ec2: { send: mockEc2Send, config: { region: () => Promise.resolve('us-east-1') } },
  }),
}));

vi.mock('../../../src/utils/logger.js', () => {
  const log = {
    setLevel: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => log,
  };
  return { getLogger: () => log };
});

import { EC2Provider } from '../../../src/provisioning/providers/ec2-provider.js';
import {
  IntrinsicFunctionResolver,
  type ResolverContext,
  resetAccountInfoCache,
} from '../../../src/deployment/intrinsic-function-resolver.js';
import { subnetIpv6AttributeWait } from '../../../src/deployment/intrinsic-resolver/getatt-construct-compute.js';
import { IntrinsicResolutionRefusalError } from '../../../src/utils/error-handler.js';
import { rewriteResourceReferences } from '../../../src/analyzer/orphan-rewriter.js';
import type { ProviderRegistry } from '../../../src/provisioning/provider-registry.js';
import type { StackState } from '../../../src/types/state.js';

const TYPE = 'AWS::EC2::Subnet';
const SUBNET_ID = 'subnet-0123456789abcdef0';

const assoc = (block: string, state: string) => ({
  Ipv6CidrBlock: block,
  Ipv6CidrBlockState: { State: state },
});

const FULL_SUBNET = {
  SubnetId: SUBNET_ID,
  VpcId: 'vpc-0aaa',
  CidrBlock: '10.0.1.0/24',
  AvailabilityZone: 'us-east-1a',
  AvailabilityZoneId: 'use1-az4',
  OutpostArn: 'arn:aws:outposts:us-east-1:123456789012:outpost/op-0abc',
  Ipv6CidrBlockAssociationSet: [
    assoc('2600:1f18:1::/64', 'disassociated'),
    assoc('2600:1f18:2::/64', 'associated'),
  ],
  BlockPublicAccessStates: { InternetGatewayBlockMode: 'block-ingress' },
};

const NACLS_WITH_ASSOCIATION = {
  NetworkAcls: [
    {
      NetworkAclId: 'acl-0aaa',
      Associations: [
        { SubnetId: 'subnet-0ffffffffffffffff', NetworkAclAssociationId: 'aclassoc-0other' },
        { SubnetId: SUBNET_ID, NetworkAclAssociationId: 'aclassoc-0live' },
      ],
    },
  ],
};

/** Answer DescribeSubnets / DescribeNetworkAcls from the given responses. */
function answer(subnet: Record<string, unknown> | undefined, nacls: unknown = { NetworkAcls: [] }) {
  mockEc2Send.mockImplementation((cmd: { constructor: { name: string } }) => {
    if (cmd.constructor.name === 'DescribeSubnetsCommand') {
      return Promise.resolve({ Subnets: subnet ? [subnet] : [] });
    }
    if (cmd.constructor.name === 'DescribeNetworkAclsCommand') return Promise.resolve(nacls);
    return Promise.reject(new Error(`unexpected ${cmd.constructor.name}`));
  });
}

function resolverContext(): ResolverContext {
  return {
    template: { Resources: { Subnet: { Type: TYPE, Properties: {} } } },
    resources: {
      Subnet: {
        physicalId: SUBNET_ID,
        resourceType: TYPE,
        properties: {},
        attributes: { SubnetId: SUBNET_ID },
        dependencies: [],
      },
    },
  };
}

/** The resolver's answer, or `REFUSED` for its `refuseUnservedAttribute` arm. */
const REFUSED = Symbol('refused');
async function resolverAnswer(attribute: string): Promise<unknown> {
  try {
    return await new IntrinsicFunctionResolver().resolve(
      { 'Fn::GetAtt': ['Subnet', attribute] },
      resolverContext()
    );
  } catch (e) {
    if (e instanceof IntrinsicResolutionRefusalError) return REFUSED;
    throw e;
  }
}

describe('EC2Provider.getAttribute on AWS::EC2::Subnet (go-to-k/cdkd#5968)', () => {
  let provider: EC2Provider;
  const realSleep = subnetIpv6AttributeWait.sleep;

  beforeEach(() => {
    mockEc2Send.mockReset();
    resetAccountInfoCache();
    subnetIpv6AttributeWait.sleep = async () => {};
    provider = new EC2Provider();
  });
  afterEach(() => {
    subnetIpv6AttributeWait.sleep = realSleep;
  });

  // Each row: a live subnet (+ network ACLs), an attribute, and the value the
  // provider must answer (`undefined` where the resolver refuses).
  const rows: Array<{
    name: string;
    subnet: Record<string, unknown> | undefined;
    nacls?: unknown;
    attribute: string;
    expected: unknown;
  }> = [
    {
      name: 'Ipv6CidrBlocks: the associated block, never a disassociated one',
      subnet: FULL_SUBNET,
      attribute: 'Ipv6CidrBlocks',
      expected: ['2600:1f18:2::/64'],
    },
    {
      name: 'Ipv6CidrBlocks: [] when only disassociating / disassociated blocks remain',
      subnet: {
        ...FULL_SUBNET,
        Ipv6CidrBlockAssociationSet: [
          assoc('2600:1f18:1::/64', 'disassociated'),
          assoc('2600:1f18:2::/64', 'disassociating'),
        ],
      },
      attribute: 'Ipv6CidrBlocks',
      expected: [],
    },
    {
      name: 'Ipv6CidrBlocks: [] for an IPv4-only subnet',
      subnet: { SubnetId: SUBNET_ID },
      attribute: 'Ipv6CidrBlocks',
      expected: [],
    },
    {
      name: "NetworkAclAssociationId: the subnet's own association, not a sibling's",
      subnet: FULL_SUBNET,
      nacls: NACLS_WITH_ASSOCIATION,
      attribute: 'NetworkAclAssociationId',
      expected: 'aclassoc-0live',
    },
    {
      name: 'NetworkAclAssociationId: undefined when DescribeNetworkAcls reports none',
      subnet: FULL_SUBNET,
      attribute: 'NetworkAclAssociationId',
      expected: undefined,
    },
    {
      name: 'BlockPublicAccessStates: the whole live object',
      subnet: FULL_SUBNET,
      attribute: 'BlockPublicAccessStates',
      expected: { InternetGatewayBlockMode: 'block-ingress' },
    },
    {
      name: 'BlockPublicAccessStates.<member>: the dotted member',
      subnet: FULL_SUBNET,
      attribute: 'BlockPublicAccessStates.InternetGatewayBlockMode',
      expected: 'block-ingress',
    },
    {
      name: 'BlockPublicAccessStates.<member>: an inherited name is not an own key',
      subnet: FULL_SUBNET,
      attribute: 'BlockPublicAccessStates.constructor',
      expected: undefined,
    },
    {
      name: "BlockPublicAccessStates.<member>: a '' member reads as absent",
      subnet: { ...FULL_SUBNET, BlockPublicAccessStates: { InternetGatewayBlockMode: '' } },
      attribute: 'BlockPublicAccessStates.InternetGatewayBlockMode',
      expected: undefined,
    },
    {
      name: 'BlockPublicAccessStates.<member>: a null member reads as absent',
      subnet: { ...FULL_SUBNET, BlockPublicAccessStates: { InternetGatewayBlockMode: null } },
      attribute: 'BlockPublicAccessStates.InternetGatewayBlockMode',
      expected: undefined,
    },
    {
      name: 'BlockPublicAccessStates: undefined when DescribeSubnets omits it',
      subnet: { SubnetId: SUBNET_ID },
      attribute: 'BlockPublicAccessStates',
      expected: undefined,
    },
    {
      name: 'OutpostArn: the live ARN',
      subnet: FULL_SUBNET,
      attribute: 'OutpostArn',
      expected: FULL_SUBNET.OutpostArn,
    },
    {
      name: 'OutpostArn: undefined for a subnet not on an Outpost',
      subnet: { SubnetId: SUBNET_ID, VpcId: 'vpc-0aaa' },
      attribute: 'OutpostArn',
      expected: undefined,
    },
    {
      name: "OutpostArn: '' reads as absent",
      subnet: { ...FULL_SUBNET, OutpostArn: '' },
      attribute: 'OutpostArn',
      expected: undefined,
    },
    {
      name: 'CidrBlock: undefined on an IPv6-only subnet',
      subnet: { SubnetId: SUBNET_ID, Ipv6Native: true },
      attribute: 'CidrBlock',
      expected: undefined,
    },
    { name: 'CidrBlock', subnet: FULL_SUBNET, attribute: 'CidrBlock', expected: '10.0.1.0/24' },
    { name: 'VpcId', subnet: FULL_SUBNET, attribute: 'VpcId', expected: 'vpc-0aaa' },
    {
      name: 'AvailabilityZone',
      subnet: FULL_SUBNET,
      attribute: 'AvailabilityZone',
      expected: 'us-east-1a',
    },
    {
      name: 'AvailabilityZoneId',
      subnet: FULL_SUBNET,
      attribute: 'AvailabilityZoneId',
      expected: 'use1-az4',
    },
    {
      name: 'a subnet DescribeSubnets no longer returns',
      subnet: undefined,
      attribute: 'VpcId',
      expected: undefined,
    },
  ];

  for (const row of rows) {
    it(`${row.name} — and agrees with the deploy resolver`, async () => {
      answer(row.subnet, row.nacls);
      const value = await provider.getAttribute(SUBNET_ID, TYPE, row.attribute);
      expect(value).toEqual(row.expected);
      // The resolver reads the same mocked AWS: served values are equal, and
      // where the provider answers undefined the resolver refuses.
      const resolved = await resolverAnswer(row.attribute);
      expect(resolved).toEqual(row.expected === undefined ? REFUSED : row.expected);
    });
  }

  it('NetworkAclAssociationId: filters DescribeNetworkAcls on association.subnet-id', async () => {
    answer(FULL_SUBNET, NACLS_WITH_ASSOCIATION);
    await provider.getAttribute(SUBNET_ID, TYPE, 'NetworkAclAssociationId');
    const cmd = mockEc2Send.mock.calls[0]![0] as {
      constructor: { name: string };
      input: Record<string, unknown>;
    };
    expect(cmd.constructor.name).toBe('DescribeNetworkAclsCommand');
    expect(cmd.input).toEqual({
      Filters: [{ Name: 'association.subnet-id', Values: [SUBNET_ID] }],
    });
  });

  it('NetworkAclAssociationId: a physical id that is not subnet-<hex> never reaches the filter', async () => {
    answer(FULL_SUBNET, NACLS_WITH_ASSOCIATION);
    expect(await provider.getAttribute('subnet-*', TYPE, 'NetworkAclAssociationId')).toBeUndefined();
    expect(mockEc2Send).not.toHaveBeenCalled();
  });

  it('Ipv6CidrBlocks: THROWS while the only block is still associating, where the resolver refuses after its wait', async () => {
    answer({
      ...FULL_SUBNET,
      Ipv6CidrBlockAssociationSet: [
        assoc('2600:1f18:1::/64', 'disassociated'),
        assoc('2600:1f18:3::/64', 'associating'),
      ],
    });
    await expect(provider.getAttribute(SUBNET_ID, TYPE, 'Ipv6CidrBlocks')).rejects.toThrow(
      "the subnet's IPv6 CIDR block is still associating; run cdkd orphan again once it is associated"
    );
    expect(await resolverAnswer('Ipv6CidrBlocks')).toBe(REFUSED);
  });

  it('an unknown attribute name answers undefined without an AWS call', async () => {
    answer(FULL_SUBNET, NACLS_WITH_ASSOCIATION);
    expect(await provider.getAttribute(SUBNET_ID, TYPE, 'NoSuchAttribute')).toBeUndefined();
    expect(mockEc2Send).not.toHaveBeenCalled();
  });

  // A failed read is not swallowed (it reached the user as only "provider
  // returned undefined"): the AWS error itself propagates to the rewriter.
  for (const [attribute, api] of [
    ['NetworkAclAssociationId', 'DescribeNetworkAclsCommand'],
    ['Ipv6CidrBlocks', 'DescribeSubnetsCommand'],
    ['BlockPublicAccessStates.InternetGatewayBlockMode', 'DescribeSubnetsCommand'],
    ['VpcId', 'DescribeSubnetsCommand'],
  ] as const) {
    it(`${attribute}: a failed ${api} propagates the AWS error, where the resolver refuses`, async () => {
      const denied = Object.assign(new Error(`not authorized to perform ${api}`), {
        name: 'UnauthorizedOperation',
      });
      mockEc2Send.mockImplementation((cmd: { constructor: { name: string } }) =>
        cmd.constructor.name === api
          ? Promise.reject(denied)
          : Promise.reject(new Error(`unexpected ${cmd.constructor.name}`))
      );
      await expect(provider.getAttribute(SUBNET_ID, TYPE, attribute)).rejects.toBe(denied);
      expect(await resolverAnswer(attribute)).toBe(REFUSED);
    });
  }

  // provider-rules.md: a `*NotFound` answers `undefined` (no throw), so
  // `--force` falls back to the recorded value exactly as for an absent one.
  it('an InvalidSubnetID.NotFound answers undefined, not a throw', async () => {
    const notFound = Object.assign(new Error(`The subnet ID '${SUBNET_ID}' does not exist`), {
      name: 'InvalidSubnetID.NotFound',
    });
    mockEc2Send.mockRejectedValue(notFound);
    expect(await provider.getAttribute(SUBNET_ID, TYPE, 'VpcId')).toBeUndefined();
    expect(await provider.getAttribute(SUBNET_ID, TYPE, 'Ipv6CidrBlocks')).toBeUndefined();
    expect(
      await provider.getAttribute(SUBNET_ID, TYPE, 'BlockPublicAccessStates.InternetGatewayBlockMode')
    ).toBeUndefined();
  });

  it('cdkd orphan reports the propagated AWS failure as the unresolvable reason', async () => {
    const denied = Object.assign(new Error('not authorized to perform DescribeSubnets'), {
      name: 'UnauthorizedOperation',
    });
    mockEc2Send.mockRejectedValue(denied);
    const registry = {
      getProviderFor: vi.fn(() => ({ provider, provisionedBy: 'sdk' })),
    } as unknown as ProviderRegistry;
    const state: StackState = {
      version: 2,
      stackName: 'TestStack',
      region: 'us-east-1',
      lastModified: 0,
      outputs: {},
      resources: {
        Subnet: { physicalId: SUBNET_ID, resourceType: TYPE, properties: {}, attributes: {} },
        Other: {
          physicalId: 'o',
          resourceType: 'AWS::SSM::Parameter',
          properties: { Vpc: { 'Fn::GetAtt': ['Subnet', 'VpcId'] } },
        },
      },
    };
    const result = await rewriteResourceReferences(state, ['Subnet'], registry);
    expect(result.unresolvable).toHaveLength(1);
    expect(result.unresolvable[0]!.reason).toContain('not authorized to perform DescribeSubnets');
    expect(result.unresolvable[0]!.reason).not.toContain('provider returned undefined');
  });

  it('cdkd orphan splices each live value into the sibling through the real provider', async () => {
    answer(FULL_SUBNET, NACLS_WITH_ASSOCIATION);
    const registry = {
      getProviderFor: vi.fn(() => ({ provider, provisionedBy: 'sdk' })),
    } as unknown as ProviderRegistry;
    const state: StackState = {
      version: 2,
      stackName: 'TestStack',
      region: 'us-east-1',
      lastModified: 0,
      outputs: {},
      resources: {
        Subnet: {
          physicalId: SUBNET_ID,
          resourceType: TYPE,
          properties: {},
          attributes: { SubnetId: SUBNET_ID, AvailabilityZone: 'us-east-1a' },
        },
        Other: {
          physicalId: 'o',
          resourceType: 'AWS::SSM::Parameter',
          properties: {
            Blocks: { 'Fn::GetAtt': ['Subnet', 'Ipv6CidrBlocks'] },
            Nacl: { 'Fn::GetAtt': ['Subnet', 'NetworkAclAssociationId'] },
            Bpa: { 'Fn::GetAtt': ['Subnet', 'BlockPublicAccessStates'] },
            Igw: { 'Fn::GetAtt': ['Subnet', 'BlockPublicAccessStates.InternetGatewayBlockMode'] },
            Outpost: { 'Fn::GetAtt': ['Subnet', 'OutpostArn'] },
            Vpc: { 'Fn::GetAtt': ['Subnet', 'VpcId'] },
          },
        },
      },
    };
    const result = await rewriteResourceReferences(state, ['Subnet'], registry);
    expect(result.unresolvable).toEqual([]);
    expect(result.state.resources['Other']?.properties).toEqual({
      Blocks: ['2600:1f18:2::/64'],
      Nacl: 'aclassoc-0live',
      Bpa: { InternetGatewayBlockMode: 'block-ingress' },
      Igw: 'block-ingress',
      Outpost: FULL_SUBNET.OutpostArn,
      Vpc: 'vpc-0aaa',
    });
  });
});
