import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import {
  IntrinsicFunctionResolver,
  type ResolverContext,
  resetAccountInfoCache,
} from '../../../src/deployment/intrinsic-function-resolver.js';
import { subnetIpv6AttributeWait } from '../../../src/deployment/intrinsic-resolver/getatt-construct-compute.js';
import { IntrinsicResolutionRefusalError } from '../../../src/utils/error-handler.js';
import { isMarkedNonRetryable } from '../../../src/deployment/retryable-errors.js';

// go-to-k/cdkd#5944: `Fn::GetAtt` on an SDK-provisioned `AWS::EC2::Subnet`
// served the SUBNET ID for every attribute but `SubnetId` (or refused it under
// --strict-getatt). Each attribute is now read live; the three mutable ones are
// read live even when the record holds a value.

const warnSpy = vi.hoisted(() => vi.fn());
vi.mock('../../../src/utils/logger.js', () => {
  const log = { debug: vi.fn(), info: vi.fn(), warn: warnSpy, error: vi.fn() };
  return { getLogger: () => ({ ...log, child: () => log }) };
});

const mockEc2Send = vi.hoisted(() => vi.fn());
vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    sts: { send: vi.fn().mockResolvedValue({ Account: '123456789012' }) },
    ec2: { send: mockEc2Send },
  }),
}));

const SUBNET_ID = 'subnet-0123456789abcdef0';

function makeContext(
  attributes: Record<string, unknown> | undefined,
  physicalId = SUBNET_ID
): ResolverContext {
  return {
    template: { Resources: { Subnet: { Type: 'AWS::EC2::Subnet', Properties: {} } } },
    resources: {
      Subnet: {
        physicalId,
        resourceType: 'AWS::EC2::Subnet',
        properties: {},
        attributes,
        dependencies: [],
      },
    },
  };
}

type Cmd = { constructor: { name: string }; input: Record<string, unknown> };
const commandNames = (): string[] =>
  mockEc2Send.mock.calls.map((c) => (c[0] as Cmd).constructor.name);

async function rejectionOf(p: Promise<unknown>): Promise<unknown> {
  return p.then(
    () => undefined,
    (e: unknown) => e
  );
}

const assoc = (block: string, state: string) => ({
  Ipv6CidrBlock: block,
  Ipv6CidrBlockState: { State: state },
});

describe('Fn::GetAtt on AWS::EC2::Subnet reads the attribute live (go-to-k/cdkd#5944)', () => {
  let resolver: IntrinsicFunctionResolver;
  const sleep = vi.fn(async () => {});
  const realSleep = subnetIpv6AttributeWait.sleep;

  beforeEach(() => {
    resolver = new IntrinsicFunctionResolver();
    resetAccountInfoCache();
    mockEc2Send.mockReset();
    warnSpy.mockReset();
    sleep.mockClear();
    subnetIpv6AttributeWait.sleep = sleep;
  });
  afterEach(() => {
    subnetIpv6AttributeWait.sleep = realSleep;
  });

  it('Ipv6CidrBlocks: returns the associated blocks from DescribeSubnets, not the subnet id', async () => {
    mockEc2Send.mockResolvedValue({
      Subnets: [
        {
          SubnetId: SUBNET_ID,
          Ipv6CidrBlockAssociationSet: [
            assoc('2600:1f18:1::/64', 'disassociated'),
            assoc('2600:1f18:2::/64', 'associated'),
          ],
        },
      ],
    });
    const value = await resolver.resolve(
      { 'Fn::GetAtt': ['Subnet', 'Ipv6CidrBlocks'] },
      makeContext({ SubnetId: SUBNET_ID, AvailabilityZone: 'us-east-1a' })
    );
    expect(value).toEqual(['2600:1f18:2::/64']);
    const cmd = mockEc2Send.mock.calls[0]![0] as Cmd;
    expect(cmd.constructor.name).toBe('DescribeSubnetsCommand');
    expect(cmd.input).toEqual({ SubnetIds: [SUBNET_ID] });
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('Ipv6CidrBlocks: reads live even when the record holds a stale value (an in-place block change re-records nothing)', async () => {
    mockEc2Send.mockResolvedValue({
      Subnets: [{ Ipv6CidrBlockAssociationSet: [assoc('2600:1f18:9::/64', 'associated')] }],
    });
    const value = await resolver.resolve(
      { 'Fn::GetAtt': ['Subnet', 'Ipv6CidrBlocks'] },
      makeContext({ SubnetId: SUBNET_ID, Ipv6CidrBlocks: ['2600:1f18:1::/64'] })
    );
    expect(value).toEqual(['2600:1f18:9::/64']);
    expect(mockEc2Send).toHaveBeenCalledTimes(1);
  });

  it('Ipv6CidrBlocks: an IPv4-only subnet answers [] with no wait', async () => {
    mockEc2Send.mockResolvedValue({ Subnets: [{ SubnetId: SUBNET_ID }] });
    expect(
      await resolver.resolve({ 'Fn::GetAtt': ['Subnet', 'Ipv6CidrBlocks'] }, makeContext({}))
    ).toEqual([]);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('Ipv6CidrBlocks: the ec2-subnet-dns64 fixture output joins to blocks:<cidr>, and blocks: when empty', async () => {
    const output = {
      'Fn::Join': ['', ['blocks:', { 'Fn::Join': [',', { 'Fn::GetAtt': ['Subnet', 'Ipv6CidrBlocks'] }] }]],
    };
    mockEc2Send.mockResolvedValueOnce({
      Subnets: [{ Ipv6CidrBlockAssociationSet: [assoc('2600:1f18:5::/64', 'associated')] }],
    });
    expect(await resolver.resolve(output, makeContext({}))).toBe('blocks:2600:1f18:5::/64');
    mockEc2Send.mockResolvedValueOnce({ Subnets: [{ SubnetId: SUBNET_ID }] });
    expect(await resolver.resolve(output, makeContext({}))).toBe('blocks:');
  });

  it('Ipv6CidrBlocks: waits while the block is associating, then serves it', async () => {
    mockEc2Send
      .mockResolvedValueOnce({
        Subnets: [{ Ipv6CidrBlockAssociationSet: [assoc('2600:1f18:3::/64', 'associating')] }],
      })
      .mockResolvedValueOnce({
        Subnets: [{ Ipv6CidrBlockAssociationSet: [assoc('2600:1f18:3::/64', 'associated')] }],
      });
    expect(
      await resolver.resolve({ 'Fn::GetAtt': ['Subnet', 'Ipv6CidrBlocks'] }, makeContext({}))
    ).toEqual(['2600:1f18:3::/64']);
    expect(mockEc2Send).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(subnetIpv6AttributeWait.delayMs);
  });

  it('Ipv6CidrBlocks: refuses (unmarked) a block still associating after the budget, never []', async () => {
    mockEc2Send.mockResolvedValue({
      Subnets: [{ Ipv6CidrBlockAssociationSet: [assoc('2600:1f18:3::/64', 'associating')] }],
    });
    const refusal = await rejectionOf(
      resolver.resolve({ 'Fn::GetAtt': ['Subnet', 'Ipv6CidrBlocks'] }, makeContext({}))
    );
    expect(refusal).toBeInstanceOf(IntrinsicResolutionRefusalError);
    expect((refusal as Error).message).toContain('still associating');
    expect(isMarkedNonRetryable(refusal as Error)).toBe(false);
    expect(mockEc2Send).toHaveBeenCalledTimes(subnetIpv6AttributeWait.attempts);
    expect(sleep).toHaveBeenCalledTimes(subnetIpv6AttributeWait.attempts - 1);
  });

  it('Ipv6CidrBlocks: resolves under --strict-getatt, which refused the old physical-id fallback', async () => {
    resolver = new IntrinsicFunctionResolver(undefined, { strictGetAtt: true });
    mockEc2Send.mockResolvedValue({
      Subnets: [{ Ipv6CidrBlockAssociationSet: [assoc('2600:1f18:4::/64', 'associated')] }],
    });
    expect(
      await resolver.resolve({ 'Fn::GetAtt': ['Subnet', 'Ipv6CidrBlocks'] }, makeContext({}))
    ).toEqual(['2600:1f18:4::/64']);
  });

  it('a failed DescribeSubnets refuses (unmarked) naming the error class, and serves no subnet id', async () => {
    mockEc2Send.mockRejectedValue(
      Object.assign(new Error('not authorized for account 123456789012'), {
        name: 'UnauthorizedOperation',
        $metadata: { httpStatusCode: 403 },
      })
    );
    const refusal = await rejectionOf(
      resolver.resolve({ 'Fn::GetAtt': ['Subnet', 'Ipv6CidrBlocks'] }, makeContext({}))
    );
    expect(refusal).toBeInstanceOf(IntrinsicResolutionRefusalError);
    const message = (refusal as Error).message;
    expect(message).toContain('DescribeSubnets failed (UnauthorizedOperation, HTTP 403)');
    expect(message).not.toContain('123456789012');
    expect(isMarkedNonRetryable(refusal as Error)).toBe(false);
  });

  it('a subnet DescribeSubnets does not return refuses', async () => {
    mockEc2Send.mockResolvedValue({ Subnets: [] });
    const refusal = await rejectionOf(
      resolver.resolve({ 'Fn::GetAtt': ['Subnet', 'VpcId'] }, makeContext({}))
    );
    expect(refusal).toBeInstanceOf(IntrinsicResolutionRefusalError);
    expect((refusal as Error).message).toContain('DescribeSubnets returned no subnet');
  });

  it('refuses (marked, no read) a physical id that is not subnet-<hex>', async () => {
    for (const physicalId of ['subnet-*', 'constructor', 'my-subnet']) {
      const refusal = await rejectionOf(
        resolver.resolve(
          { 'Fn::GetAtt': ['Subnet', 'NetworkAclAssociationId'] },
          makeContext({}, physicalId)
        )
      );
      expect(refusal, physicalId).toBeInstanceOf(IntrinsicResolutionRefusalError);
      expect((refusal as Error).message).toContain('is not a subnet id (subnet-<hex>)');
      expect(isMarkedNonRetryable(refusal as Error)).toBe(true);
    }
    expect(mockEc2Send).not.toHaveBeenCalled();
  });

  it('NetworkAclAssociationId: reads the association by subnet-id filter, live even over a recorded value', async () => {
    mockEc2Send.mockResolvedValue({
      NetworkAcls: [
        {
          NetworkAclId: 'acl-0aaa',
          Associations: [
            { SubnetId: 'subnet-0other', NetworkAclAssociationId: 'aclassoc-0other' },
            { SubnetId: SUBNET_ID, NetworkAclAssociationId: 'aclassoc-0live' },
          ],
        },
      ],
    });
    expect(
      await resolver.resolve(
        { 'Fn::GetAtt': ['Subnet', 'NetworkAclAssociationId'] },
        makeContext({ NetworkAclAssociationId: 'aclassoc-0stale' })
      )
    ).toBe('aclassoc-0live');
    const cmd = mockEc2Send.mock.calls[0]![0] as Cmd;
    expect(cmd.constructor.name).toBe('DescribeNetworkAclsCommand');
    expect(cmd.input).toEqual({
      Filters: [{ Name: 'association.subnet-id', Values: [SUBNET_ID] }],
    });
  });

  it('NetworkAclAssociationId: no association for the subnet refuses', async () => {
    mockEc2Send.mockResolvedValue({ NetworkAcls: [] });
    const refusal = await rejectionOf(
      resolver.resolve({ 'Fn::GetAtt': ['Subnet', 'NetworkAclAssociationId'] }, makeContext({}))
    );
    expect(refusal).toBeInstanceOf(IntrinsicResolutionRefusalError);
    expect((refusal as Error).message).toContain('no network ACL association');
  });

  it('BlockPublicAccessStates: serves the live object, even over a recorded value', async () => {
    mockEc2Send.mockResolvedValue({
      Subnets: [{ BlockPublicAccessStates: { InternetGatewayBlockMode: 'block-ingress' } }],
    });
    expect(
      await resolver.resolve(
        { 'Fn::GetAtt': ['Subnet', 'BlockPublicAccessStates'] },
        makeContext({ BlockPublicAccessStates: { InternetGatewayBlockMode: 'off' } })
      )
    ).toEqual({ InternetGatewayBlockMode: 'block-ingress' });
    expect(commandNames()).toEqual(['DescribeSubnetsCommand']);
  });

  it('OutpostArn: serves the live ARN, and refuses for a subnet not on an Outpost', async () => {
    const arn = 'arn:aws:outposts:us-east-1:123456789012:outpost/op-0123456789abcdef0';
    mockEc2Send.mockResolvedValueOnce({ Subnets: [{ OutpostArn: arn }] });
    expect(
      await resolver.resolve({ 'Fn::GetAtt': ['Subnet', 'OutpostArn'] }, makeContext({}))
    ).toBe(arn);
    mockEc2Send.mockResolvedValueOnce({ Subnets: [{ SubnetId: SUBNET_ID }] });
    const refusal = await rejectionOf(
      resolver.resolve({ 'Fn::GetAtt': ['Subnet', 'OutpostArn'] }, makeContext({}))
    );
    expect(refusal).toBeInstanceOf(IntrinsicResolutionRefusalError);
    expect((refusal as Error).message).toContain('not on an Outpost');
  });

  it('CidrBlock: an IPv6-only subnet has none, and refuses rather than serving the subnet id', async () => {
    mockEc2Send.mockResolvedValue({ Subnets: [{ Ipv6Native: true }] });
    const refusal = await rejectionOf(
      resolver.resolve({ 'Fn::GetAtt': ['Subnet', 'CidrBlock'] }, makeContext({}))
    );
    expect(refusal).toBeInstanceOf(IntrinsicResolutionRefusalError);
    expect((refusal as Error).message).toContain('IPv6-only subnet has no IPv4 block');
  });

  it.each([
    ['VpcId', { VpcId: 'vpc-0abc' }, 'vpc-0abc'],
    ['CidrBlock', { CidrBlock: '10.0.1.0/24' }, '10.0.1.0/24'],
    ['AvailabilityZone', { AvailabilityZone: 'us-east-1b' }, 'us-east-1b'],
    ['AvailabilityZoneId', { AvailabilityZoneId: 'use1-az4' }, 'use1-az4'],
  ])('%s: a record lacking it reads DescribeSubnets', async (name, subnet, expected) => {
    mockEc2Send.mockResolvedValue({ Subnets: [subnet] });
    expect(
      await resolver.resolve(
        { 'Fn::GetAtt': ['Subnet', name] },
        makeContext({ SubnetId: SUBNET_ID })
      )
    ).toBe(expected);
    expect(commandNames()).toEqual(['DescribeSubnetsCommand']);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('BlockPublicAccessStates.InternetGatewayBlockMode: walks the live object on an SDK record (no subnet-id fallback)', async () => {
    mockEc2Send.mockResolvedValue({
      Subnets: [{ BlockPublicAccessStates: { InternetGatewayBlockMode: 'block-ingress' } }],
    });
    expect(
      await resolver.resolve(
        { 'Fn::GetAtt': ['Subnet', 'BlockPublicAccessStates.InternetGatewayBlockMode'] },
        makeContext({ SubnetId: SUBNET_ID })
      )
    ).toBe('block-ingress');
    expect(commandNames()).toEqual(['DescribeSubnetsCommand']);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('BlockPublicAccessStates.InternetGatewayBlockMode: a Cloud Control nested record is read live, not walked', async () => {
    mockEc2Send.mockResolvedValue({
      Subnets: [{ BlockPublicAccessStates: { InternetGatewayBlockMode: 'block-ingress' } }],
    });
    expect(
      await resolver.resolve(
        { 'Fn::GetAtt': ['Subnet', 'BlockPublicAccessStates.InternetGatewayBlockMode'] },
        makeContext({ BlockPublicAccessStates: { InternetGatewayBlockMode: 'off' } })
      )
    ).toBe('block-ingress');
    expect(commandNames()).toEqual(['DescribeSubnetsCommand']);
  });

  it('BlockPublicAccessStates: refuses when DescribeSubnets reports none, and a dotted member is walked by own keys only', async () => {
    mockEc2Send.mockResolvedValue({ Subnets: [{ SubnetId: SUBNET_ID }] });
    for (const name of [
      'BlockPublicAccessStates',
      'BlockPublicAccessStates.InternetGatewayBlockMode',
      'BlockPublicAccessStates.constructor',
    ]) {
      const refusal = await rejectionOf(
        resolver.resolve({ 'Fn::GetAtt': ['Subnet', name] }, makeContext({}))
      );
      expect(refusal, name).toBeInstanceOf(IntrinsicResolutionRefusalError);
      expect((refusal as Error).message).toContain('DescribeSubnets reports no value');
    }
  });

  it('a failed DescribeNetworkAcls refuses (unmarked) naming the read', async () => {
    mockEc2Send.mockRejectedValue(
      Object.assign(new Error('denied'), {
        name: 'UnauthorizedOperation',
        $metadata: { httpStatusCode: 403 },
      })
    );
    const refusal = await rejectionOf(
      resolver.resolve({ 'Fn::GetAtt': ['Subnet', 'NetworkAclAssociationId'] }, makeContext({}))
    );
    expect(refusal).toBeInstanceOf(IntrinsicResolutionRefusalError);
    expect((refusal as Error).message).toContain(
      'DescribeNetworkAcls failed (UnauthorizedOperation, HTTP 403)'
    );
    expect(isMarkedNonRetryable(refusal as Error)).toBe(false);
  });

  it('AvailabilityZone: an empty value from DescribeSubnets refuses', async () => {
    mockEc2Send.mockResolvedValue({ Subnets: [{ AvailabilityZone: '' }] });
    const refusal = await rejectionOf(
      resolver.resolve({ 'Fn::GetAtt': ['Subnet', 'AvailabilityZone'] }, makeContext({}))
    );
    expect(refusal).toBeInstanceOf(IntrinsicResolutionRefusalError);
  });

  it('a create-only attribute the record lacks goes through the #1852 heal first, so the re-read value is served with no resolver read', async () => {
    const attributeHealer = vi
      .fn()
      .mockResolvedValue({ kind: 'read', attributes: { AvailabilityZone: 'us-east-1c' } });
    const context = { ...makeContext({ SubnetId: SUBNET_ID }), attributeHealer } as ResolverContext;
    expect(
      await resolver.resolve({ 'Fn::GetAtt': ['Subnet', 'AvailabilityZone'] }, context)
    ).toBe('us-east-1c');
    expect(attributeHealer).toHaveBeenCalledTimes(1);
    expect(mockEc2Send).not.toHaveBeenCalled();
  });

  it('a create-only attribute the heal does not return is read live after it', async () => {
    const attributeHealer = vi.fn().mockResolvedValue({ kind: 'read', attributes: {} });
    mockEc2Send.mockResolvedValue({ Subnets: [{ VpcId: 'vpc-0live' }] });
    const context = { ...makeContext({ SubnetId: SUBNET_ID }), attributeHealer } as ResolverContext;
    expect(await resolver.resolve({ 'Fn::GetAtt': ['Subnet', 'VpcId'] }, context)).toBe(
      'vpc-0live'
    );
    expect(attributeHealer).toHaveBeenCalledTimes(1);
    expect(commandNames()).toEqual(['DescribeSubnetsCommand']);
  });

  it('the forced-live attributes skip the heal and read AWS directly', async () => {
    const attributeHealer = vi.fn().mockResolvedValue({ kind: 'read', attributes: {} });
    mockEc2Send.mockResolvedValue({
      Subnets: [{ Ipv6CidrBlockAssociationSet: [assoc('2600:1f18:6::/64', 'associated')] }],
    });
    const context = { ...makeContext({}), attributeHealer } as ResolverContext;
    expect(
      await resolver.resolve({ 'Fn::GetAtt': ['Subnet', 'Ipv6CidrBlocks'] }, context)
    ).toEqual(['2600:1f18:6::/64']);
    expect(attributeHealer).not.toHaveBeenCalled();
  });

  it('a recorded create-only attribute is served from state with no read', async () => {
    expect(
      await resolver.resolve(
        { 'Fn::GetAtt': ['Subnet', 'AvailabilityZone'] },
        makeContext({ SubnetId: SUBNET_ID, AvailabilityZone: 'us-east-1a' })
      )
    ).toBe('us-east-1a');
    expect(mockEc2Send).not.toHaveBeenCalled();
  });
});
