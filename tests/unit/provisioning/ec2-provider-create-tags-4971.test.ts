import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import {
  AllocateAddressCommand,
  CreateInternetGatewayCommand,
  CreateNatGatewayCommand,
  CreateNetworkAclCommand,
  CreateRouteTableCommand,
  CreateSecurityGroupCommand,
  CreateSubnetCommand,
  CreateTagsCommand,
  CreateVpcCommand,
  DescribeInternetGatewaysCommand,
  RunInstancesCommand,
} from '@aws-sdk/client-ec2';

// go-to-k/cdkd#4971: the nine tagged EC2 creates send the template's tags in
// `TagSpecifications`, so an SCP requiring `aws:RequestTag/...` on the create
// action sees them, and a create that carried them sends no `CreateTags`. A
// role without `ec2:CreateTags` -- which the old post-create `CreateTags` only
// warned about -- still creates: the tagged create's denial is re-sent once
// untagged, then tagged by `CreateTags` as before.

const { mockSend, warn, debug, error } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
  error: vi.fn(),
}));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    ec2: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
  }),
}));

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug,
    info: vi.fn(),
    warn,
    error,
    child: vi.fn().mockReturnThis(),
  };
  return {
    getLogger: () => ({
      child: () => childLogger,
      debug,
      info: vi.fn(),
      warn,
      error,
    }),
  };
});

import { EC2Provider } from '../../../src/provisioning/providers/ec2-provider.js';
import { isMarkedNonRetryable } from '../../../src/deployment/retryable-errors.js';
import { RESOURCE_NOT_FOUND } from '../../../src/types/resource.js';

const TAGS = [
  { Key: 'Name', Value: 'app' },
  { Key: 'team', Value: '' },
];

/** Per type: the create command, the `TagSpecifications` resource type, and minimal props. */
const CREATES: Array<[string, new (input: never) => unknown, string, Record<string, unknown>]> = [
  ['AWS::EC2::VPC', CreateVpcCommand, 'vpc', { CidrBlock: '10.0.0.0/16' }],
  ['AWS::EC2::Subnet', CreateSubnetCommand, 'subnet', { VpcId: 'vpc-1', CidrBlock: '10.0.1.0/24' }],
  ['AWS::EC2::InternetGateway', CreateInternetGatewayCommand, 'internet-gateway', {}],
  ['AWS::EC2::EIP', AllocateAddressCommand, 'elastic-ip', { Domain: 'vpc' }],
  ['AWS::EC2::NatGateway', CreateNatGatewayCommand, 'natgateway', { SubnetId: 'subnet-1' }],
  ['AWS::EC2::RouteTable', CreateRouteTableCommand, 'route-table', { VpcId: 'vpc-1' }],
  [
    'AWS::EC2::SecurityGroup',
    CreateSecurityGroupCommand,
    'security-group',
    { GroupDescription: 'd', VpcId: 'vpc-1' },
  ],
  [
    'AWS::EC2::Instance',
    RunInstancesCommand,
    'instance',
    { ImageId: 'ami-1', InstanceType: 't3.micro' },
  ],
  ['AWS::EC2::NetworkAcl', CreateNetworkAclCommand, 'network-acl', { VpcId: 'vpc-1' }],
];

/** One response carrying every shape these creates and their follow-ups read. */
const RESPONSE = {
  Vpc: { VpcId: 'vpc-1', State: 'available', CidrBlock: '10.0.0.0/16' },
  Vpcs: [{ VpcId: 'vpc-1', State: 'available', CidrBlock: '10.0.0.0/16' }],
  Subnet: { SubnetId: 'subnet-1', AvailabilityZone: 'us-east-1a' },
  InternetGateway: { InternetGatewayId: 'igw-1' },
  AllocationId: 'eipalloc-1',
  PublicIp: '203.0.113.1',
  NatGateway: { NatGatewayId: 'nat-1' },
  RouteTable: { RouteTableId: 'rtb-1' },
  GroupId: 'sg-1',
  SecurityGroups: [{ GroupId: 'sg-1', IpPermissionsEgress: [] }],
  Instances: [{ InstanceId: 'i-1', State: { Name: 'running' } }],
  Reservations: [{ Instances: [{ InstanceId: 'i-1', State: { Name: 'running' } }] }],
  NetworkAcl: { NetworkAclId: 'acl-1' },
};

/** EC2's measured answer to a tagged create from a role without `ec2:CreateTags`. */
const createTagsDenied = (): Error =>
  Object.assign(
    new Error(
      'You are not authorized to perform this operation. User: arn:aws:sts::123456789012:assumed-role/r/s ' +
        'is not authorized to perform: ec2:CreateTags on resource: arn:aws:ec2:us-east-1:123456789012:vpc/* ' +
        'because no identity-based policy allows the ec2:CreateTags action. Encoded authorization failure message: x'
    ),
    { name: 'UnauthorizedOperation' }
  );

/** A denial of the create action itself (`deny` names how it was refused). */
const createDenied = (action: string, deny: string): Error =>
  Object.assign(
    new Error(
      `You are not authorized to perform this operation. User: arn:aws:sts::123456789012:assumed-role/r/s ` +
        `is not authorized to perform: ${action} on resource: arn:aws:ec2:us-east-1:123456789012:vpc/* ${deny}. ` +
        'Encoded authorization failure message: x'
    ),
    { name: 'UnauthorizedOperation' }
  );

const sent = (): Array<{ input: Record<string, unknown> }> =>
  mockSend.mock.calls.map((c) => c[0] as { input: Record<string, unknown> });

describe('EC2Provider sends tags on the create call (go-to-k/cdkd#4971)', () => {
  let provider: EC2Provider;
  const savedNoWait = process.env['CDKD_NO_WAIT'];

  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockReset();
    process.env['CDKD_NO_WAIT'] = 'true';
    mockSend.mockImplementation(async () => RESPONSE);
    provider = new EC2Provider();
  });

  afterEach(() => {
    if (savedNoWait === undefined) delete process.env['CDKD_NO_WAIT'];
    else process.env['CDKD_NO_WAIT'] = savedNoWait;
  });

  it.each(CREATES)(
    '%s carries the tags in TagSpecifications and sends no CreateTags',
    async (type, command, tagType, props) => {
      await provider.create('R', type, { ...props, Tags: TAGS });
      const creates = sent().filter((c) => c instanceof command);
      expect(creates).toHaveLength(1);
      expect(creates[0]!.input['TagSpecifications']).toEqual([
        { ResourceType: tagType, Tags: TAGS },
      ]);
      expect(sent().some((c) => c instanceof CreateTagsCommand)).toBe(false);
    }
  );

  it.each(CREATES)(
    '%s without Tags sends no TagSpecifications and no CreateTags',
    async (type, command, _tagType, props) => {
      await provider.create('R', type, { ...props });
      const creates = sent().filter((c) => c instanceof command);
      expect(creates).toHaveLength(1);
      expect('TagSpecifications' in creates[0]!.input).toBe(false);
      expect(sent().some((c) => c instanceof CreateTagsCommand)).toBe(false);
    }
  );

  it.each(CREATES)(
    '%s denied ec2:CreateTags is re-sent once untagged, then tagged by CreateTags',
    async (type, command, _tagType, props) => {
      let creates = 0;
      mockSend.mockImplementation(async (cmd: unknown) => {
        if (cmd instanceof command && creates++ === 0) throw createTagsDenied();
        return RESPONSE;
      });

      await provider.create('R', type, { ...props, Tags: TAGS });

      const createCalls = sent().filter((c) => c instanceof command);
      expect(createCalls).toHaveLength(2);
      expect(createCalls[0]!.input['TagSpecifications']).toBeDefined();
      expect('TagSpecifications' in createCalls[1]!.input).toBe(false);
      // A ClientToken (where the create has one) is the same on both sends.
      expect(createCalls[1]!.input['ClientToken']).toBe(createCalls[0]!.input['ClientToken']);
      const tagCalls = sent().filter((c) => c instanceof CreateTagsCommand);
      expect(tagCalls.map((c) => c.input['Tags'])).toEqual([TAGS]);
    }
  );

  it('surfaces the ec2:CreateTags denial when the untagged re-send is denied too', async () => {
    mockSend.mockImplementation(async (cmd: unknown) => {
      if (cmd instanceof CreateVpcCommand) {
        throw cmd.input.TagSpecifications
          ? createTagsDenied()
          : createDenied('ec2:CreateVpc', 'because no identity-based policy allows the ec2:CreateVpc action');
      }
      return RESPONSE;
    });

    const error = await provider
      .create('R', 'AWS::EC2::VPC', { CidrBlock: '10.0.0.0/16', Tags: TAGS })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('ec2:CreateTags');
    // A FIXED note says the re-send was refused too, so a role missing the
    // create action is told so in the same run; AWS's text for it (the
    // caller's session, the action, the encoded message) never joins the
    // message, which is persisted.
    expect((error as Error).message).toContain(
      'The create without tags was refused too (UnauthorizedOperation).'
    );
    expect((error as Error).message).not.toContain('ec2:CreateVpc');
    expect((error as Error).message).not.toContain('explicit deny');
    // An implicit denial may still be IAM propagation: the retry stays.
    expect(isMarkedNonRetryable(error)).toBe(false);
    expect(sent().filter((c) => c instanceof CreateVpcCommand)).toHaveLength(2);
  });

  it('marks the ec2:CreateTags denial non-retryable when the untagged re-send met an explicit deny', async () => {
    mockSend.mockImplementation(async (cmd: unknown) => {
      if (cmd instanceof CreateVpcCommand) {
        throw cmd.input.TagSpecifications
          ? createTagsDenied()
          : createDenied('ec2:CreateVpc', 'with an explicit deny in a service control policy');
      }
      return RESPONSE;
    });

    const error = await provider
      .create('R', 'AWS::EC2::VPC', { CidrBlock: '10.0.0.0/16', Tags: TAGS })
      .catch((e: unknown) => e);

    expect((error as Error).message).toContain('ec2:CreateTags');
    // The policy type comes from the fixed list, not AWS's sentence.
    expect((error as Error).message).toContain(
      'The create without tags was refused too (UnauthorizedOperation); explicit deny (service control policy).'
    );
    expect((error as Error).message).not.toContain('with an explicit deny');
    expect((error as Error).message).not.toContain('ec2:CreateVpc');
    expect(isMarkedNonRetryable(error)).toBe(true);
  });

  it('names a bare explicit deny when the policy type is not one the fixed list knows', async () => {
    mockSend.mockImplementation(async (cmd: unknown) => {
      if (cmd instanceof CreateVpcCommand) {
        throw cmd.input.TagSpecifications
          ? createTagsDenied()
          : createDenied('ec2:CreateVpc', 'with an explicit deny in a brand-new policy kind');
      }
      return RESPONSE;
    });

    const error = await provider
      .create('R', 'AWS::EC2::VPC', { CidrBlock: '10.0.0.0/16', Tags: TAGS })
      .catch((e: unknown) => e);

    expect((error as Error).message).toMatch(
      /The create without tags was refused too \(UnauthorizedOperation\); explicit deny\.$/
    );
    expect((error as Error).message).not.toContain('brand-new policy kind');
    expect(isMarkedNonRetryable(error)).toBe(true);
  });

  it("logs the untagged re-send's AWS text at debug only, never at warn or error", async () => {
    const RAW = 'with an explicit deny in a service control policy';
    mockSend.mockImplementation(async (cmd: unknown) => {
      if (cmd instanceof CreateVpcCommand) {
        throw cmd.input.TagSpecifications ? createTagsDenied() : createDenied('ec2:CreateVpc', RAW);
      }
      return RESPONSE;
    });

    await provider
      .create('R', 'AWS::EC2::VPC', { CidrBlock: '10.0.0.0/16', Tags: TAGS })
      .catch(() => undefined);

    const lines = (spy: typeof warn): string[] => spy.mock.calls.map((c) => String(c[0]));
    // Positive marker first: the text did reach a sink, the debug one.
    expect(lines(debug).some((l) => l.includes('without tags was refused') && l.includes(RAW))).toBe(
      true
    );
    expect(lines(warn).some((l) => l.includes(RAW) || l.includes('ec2:CreateVpc'))).toBe(false);
    expect(lines(error).some((l) => l.includes(RAW) || l.includes('ec2:CreateVpc'))).toBe(false);
  });

  it('surfaces any other answer of the untagged re-send as its own', async () => {
    mockSend.mockImplementation(async (cmd: unknown) => {
      if (cmd instanceof CreateVpcCommand) {
        if (cmd.input.TagSpecifications) {
          throw createTagsDenied();
        }
        throw Object.assign(new Error('VPC limit exceeded'), { name: 'VpcLimitExceeded' });
      }
      return RESPONSE;
    });

    const error = await provider
      .create('R', 'AWS::EC2::VPC', { CidrBlock: '10.0.0.0/16', Tags: TAGS })
      .catch((e: unknown) => e);

    expect((error as Error).message).toContain('VPC limit exceeded');
  });

  it.each([
    [
      'a denial of the create action itself',
      createDenied('ec2:CreateVpc', 'with an explicit deny in a service control policy'),
    ],
    [
      'a tag the create refused',
      Object.assign(new Error('Tag value exceeds the maximum length'), {
        name: 'InvalidParameterValue',
      }),
    ],
    [
      'an error naming ec2:CreateTags that is not a denial',
      Object.assign(new Error('Invalid TagSpecifications for ec2:CreateTags'), {
        name: 'InvalidParameterValue',
      }),
    ],
  ])('does not re-send untagged on %s', async (_label, failure) => {
    mockSend.mockImplementation(async (cmd: unknown) => {
      if (cmd instanceof CreateVpcCommand) throw failure;
      return RESPONSE;
    });

    await expect(
      provider.create('R', 'AWS::EC2::VPC', { CidrBlock: '10.0.0.0/16', Tags: TAGS })
    ).rejects.toThrow();
    expect(sent().filter((c) => c instanceof CreateVpcCommand)).toHaveLength(1);
    expect(sent().some((c) => c instanceof CreateTagsCommand)).toBe(false);
  });
});

describe('EC2Provider tagged create after an untagged one used its client token (go-to-k/cdkd#4971)', () => {
  let provider: EC2Provider;
  const savedNoWait = process.env['CDKD_NO_WAIT'];

  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockReset();
    process.env['CDKD_NO_WAIT'] = 'true';
    provider = new EC2Provider();
  });

  afterEach(() => {
    if (savedNoWait === undefined) delete process.env['CDKD_NO_WAIT'];
    else process.env['CDKD_NO_WAIT'] = savedNoWait;
  });

  /** EC2's measured answer to a token re-used with different parameters. */
  const mismatch = (): Error =>
    Object.assign(new Error('Wrong arguments for request with token cdkd-x'), {
      name: 'IdempotentParameterMismatch',
    });

  it('re-sends untagged with the same token, then tags with CreateTags', async () => {
    mockSend.mockImplementation(async (cmd: unknown) => {
      if (cmd instanceof CreateRouteTableCommand && cmd.input.TagSpecifications) throw mismatch();
      return RESPONSE;
    });

    await provider.create('R', 'AWS::EC2::RouteTable', { VpcId: 'vpc-1', Tags: TAGS });

    const creates = sent().filter((c) => c instanceof CreateRouteTableCommand);
    expect(creates).toHaveLength(2);
    expect('TagSpecifications' in creates[1]!.input).toBe(false);
    expect(creates[1]!.input['ClientToken']).toBe(creates[0]!.input['ClientToken']);
    expect(sent().filter((c) => c instanceof CreateTagsCommand)).toHaveLength(1);
  });

  it("surfaces the re-send's own answer when it fails too", async () => {
    mockSend.mockImplementation(async (cmd: unknown) => {
      if (cmd instanceof CreateRouteTableCommand) {
        throw cmd.input.TagSpecifications
          ? mismatch()
          : createDenied('ec2:CreateRouteTable', 'because no identity-based policy allows it');
      }
      return RESPONSE;
    });

    const error = await provider
      .create('R', 'AWS::EC2::RouteTable', { VpcId: 'vpc-1', Tags: TAGS })
      .catch((e: unknown) => e);

    expect((error as Error).message).toContain('ec2:CreateRouteTable');
    expect((error as Error).message).not.toContain('Wrong arguments');
  });
});

describe('EC2Provider.readCurrentState right after its own write (go-to-k/cdkd#4971)', () => {
  let provider: EC2Provider;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockReset();
    vi.useFakeTimers();
    provider = new EC2Provider();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const notFound = (): Error =>
    Object.assign(new Error('The internetGateway ID does not exist'), {
      name: 'InvalidInternetGatewayID.NotFound',
    });

  it('re-reads a not-found answer until the created resource is visible', async () => {
    let reads = 0;
    mockSend.mockImplementation(async (cmd: unknown) => {
      if (cmd instanceof DescribeInternetGatewaysCommand && reads++ < 2) throw notFound();
      return { InternetGateways: [{ InternetGatewayId: 'igw-1', Attachments: [], Tags: TAGS }] };
    });

    const read = provider.readCurrentState('igw-1', 'G', 'AWS::EC2::InternetGateway', undefined, {
      afterOwnWrite: true,
    });
    await vi.runAllTimersAsync();

    expect(await read).not.toBe(RESOURCE_NOT_FOUND);
    expect(reads).toBe(3);
  });

  it('answers gone after the bounded re-reads', async () => {
    mockSend.mockImplementation(async () => {
      throw notFound();
    });

    const read = provider.readCurrentState('igw-1', 'G', 'AWS::EC2::InternetGateway', undefined, {
      afterOwnWrite: true,
    });
    await vi.runAllTimersAsync();

    expect(await read).toBe(RESOURCE_NOT_FOUND);
    expect(mockSend).toHaveBeenCalledTimes(5);
  });

  it('answers gone at once outside the own-write capture', async () => {
    mockSend.mockImplementation(async () => {
      throw notFound();
    });

    await expect(
      provider.readCurrentState('igw-1', 'G', 'AWS::EC2::InternetGateway')
    ).resolves.toBe(RESOURCE_NOT_FOUND);
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it('spends no extra read when the first one finds the resource', async () => {
    mockSend.mockImplementation(async () => ({
      InternetGateways: [{ InternetGatewayId: 'igw-1', Attachments: [], Tags: TAGS }],
    }));

    await provider.readCurrentState('igw-1', 'G', 'AWS::EC2::InternetGateway', undefined, {
      afterOwnWrite: true,
    });
    expect(mockSend).toHaveBeenCalledTimes(1);
  });
});
