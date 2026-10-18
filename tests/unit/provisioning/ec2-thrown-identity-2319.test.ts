import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';

/**
 * Every EC2 create / update / delete wrap must not write the CALLER'S IDENTITY
 * into a persisted store (go-to-k/cdkd#2319).
 *
 * A thrown `ProvisioningError` message is captured into
 * `deployments/{runId}.jsonl`, and EC2 words an `UnauthorizedOperation` as
 * `You are not authorized to perform this operation. User:
 * arn:aws:sts::<account>:assumed-role/<role>/<session> is not authorized to
 * perform: ...`. Every AWS fixture here carries that real wording and the
 * smithy service markers `describeAwsFailure` keys on.
 */

const { mockSend, debugSpy, warnSpy } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  debugSpy: vi.fn(),
  warnSpy: vi.fn(),
}));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    ec2: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
  }),
}));

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: debugSpy,
    info: vi.fn(),
    warn: warnSpy,
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  return {
    getLogger: () => ({
      child: () => childLogger,
      debug: debugSpy,
      info: vi.fn(),
      warn: warnSpy,
      error: vi.fn(),
    }),
  };
});

import { EC2Provider } from '../../../src/provisioning/providers/ec2-provider.js';
import { ProvisioningError } from '../../../src/utils/error-handler.js';
import {
  hasRedactedCause,
  isIamPropagationError,
  isMarkedNonRetryable,
  isNameCollisionErrorFrom,
  isRetryableTransientError,
  retryClassificationText,
} from '../../../src/deployment/retryable-errors.js';
import { VERBOSE_POINTER } from '../../../src/utils/aws-failure-text.js';

const CALLER_ACCOUNT = '210987654321';
const CALLER_ROLE = 'cdkd-deploy-role';
const CALLER_SESSION = 'cdkd-session-8f21';
const CALLER_ARN = `arn:aws:sts::${CALLER_ACCOUNT}:assumed-role/${CALLER_ROLE}/${CALLER_SESSION}`;

/** EC2's `UnauthorizedOperation` as it really words it, AWS-authored. */
function unauthorizedNamingTheCaller(
  action = 'ec2:CreateVpc',
  reason = `because no identity-based policy allows the ${action} action`
): Error {
  return Object.assign(
    new Error(
      `You are not authorized to perform this operation. User: ${CALLER_ARN} is not authorized ` +
        `to perform: ${action} on resource: arn:aws:ec2:us-east-1:${CALLER_ACCOUNT}:vpc/* ` +
        `${reason}. Encoded authorization failure message: x`
    ),
    { name: 'UnauthorizedOperation', $fault: 'client', $metadata: { httpStatusCode: 403 } }
  );
}

function expectNoIdentity(text: string): void {
  expect(text).not.toContain(CALLER_ACCOUNT);
  expect(text).not.toContain(CALLER_ROLE);
  expect(text).not.toContain(CALLER_SESSION);
}

type Run = (provider: EC2Provider) => Promise<unknown>;

const create =
  (type: string, props: Record<string, unknown>): Run =>
  (p) =>
    p.create('Res', type, props);
const update =
  (
    type: string,
    physicalId: string,
    props: Record<string, unknown>,
    previous: Record<string, unknown>
  ): Run =>
  (p) =>
    p.update('Res', physicalId, type, props, previous);
const del =
  (type: string, physicalId: string): Run =>
  (p) =>
    p.delete('Res', physicalId, type);

const VPC = { CidrBlock: '10.0.0.0/16' };
const SUBNET = { VpcId: 'vpc-1', CidrBlock: '10.0.1.0/24' };
const SG = { GroupDescription: 'd', VpcId: 'vpc-1' };
const INGRESS = { GroupId: 'sg-1', IpProtocol: 'tcp', FromPort: 443, ToPort: 443, CidrIp: '0.0.0.0/0' };
const ROUTE = { RouteTableId: 'rtb-1', DestinationCidrBlock: '0.0.0.0/0', GatewayId: 'igw-1' };
const NACL_ENTRY = {
  NetworkAclId: 'acl-1',
  RuleNumber: 100,
  Protocol: -1,
  RuleAction: 'allow',
  Egress: false,
  CidrBlock: '0.0.0.0/0',
};

/**
 * Each wrap in ec2-provider.ts, the call that reaches it, and the prefix it
 * throws. A SecurityGroupIngress update is a delete then a create, each
 * wrapping its own failure, which the update passes through: an AWS failure
 * there reaches the delete / create rows below, never the update's own wrap.
 * A Route target change is one `ReplaceRoute` (#5068), under its own wrap.
 */
const SITES: ReadonlyArray<[prefix: string, run: Run]> = [
  ['Failed to create VPC Res: ', create('AWS::EC2::VPC', VPC)],
  ['Failed to update VPC Res: ', update('AWS::EC2::VPC', 'vpc-1', { ...VPC, EnableDnsSupport: false }, VPC)],
  ['Failed to delete VPC Res: ', del('AWS::EC2::VPC', 'vpc-1')],
  ['Failed to create Subnet Res: ', create('AWS::EC2::Subnet', SUBNET)],
  [
    'Failed to update Subnet Res: ',
    update('AWS::EC2::Subnet', 'subnet-1', { ...SUBNET, MapPublicIpOnLaunch: true }, SUBNET),
  ],
  ['Failed to delete Subnet Res: ', del('AWS::EC2::Subnet', 'subnet-1')],
  ['Failed to create InternetGateway Res: ', create('AWS::EC2::InternetGateway', {})],
  ['Failed to delete InternetGateway Res: ', del('AWS::EC2::InternetGateway', 'igw-1')],
  ['Failed to create EIP Res: ', create('AWS::EC2::EIP', { Domain: 'vpc' })],
  ['Failed to delete EIP Res: ', del('AWS::EC2::EIP', '203.0.113.1|eipalloc-1')],
  [
    'Failed to create VPCGatewayAttachment Res: ',
    create('AWS::EC2::VPCGatewayAttachment', { VpcId: 'vpc-1', InternetGatewayId: 'igw-1' }),
  ],
  [
    'Failed to delete VPCGatewayAttachment Res: ',
    del('AWS::EC2::VPCGatewayAttachment', 'igw-1|vpc-1'),
  ],
  [
    'Failed to create NatGateway Res: ',
    create('AWS::EC2::NatGateway', { SubnetId: 'subnet-1', AllocationId: 'eipalloc-1' }),
  ],
  ['Failed to delete NatGateway Res: ', del('AWS::EC2::NatGateway', 'nat-1')],
  ['Failed to create RouteTable Res: ', create('AWS::EC2::RouteTable', { VpcId: 'vpc-1' })],
  ['Failed to delete RouteTable Res: ', del('AWS::EC2::RouteTable', 'rtb-1')],
  ['Failed to create Route Res: ', create('AWS::EC2::Route', ROUTE)],
  ['Failed to delete Route Res: ', del('AWS::EC2::Route', 'rtb-1|0.0.0.0/0')],
  [
    'Failed to update Route Res: ',
    update('AWS::EC2::Route', 'rtb-1|0.0.0.0/0', { ...ROUTE, GatewayId: 'igw-2' }, ROUTE),
  ],
  [
    'Failed to create SubnetRouteTableAssociation Res: ',
    create('AWS::EC2::SubnetRouteTableAssociation', { SubnetId: 'subnet-1', RouteTableId: 'rtb-1' }),
  ],
  [
    'Failed to delete SubnetRouteTableAssociation Res: ',
    del('AWS::EC2::SubnetRouteTableAssociation', 'rtbassoc-1'),
  ],
  ['Failed to create SecurityGroup Res: ', create('AWS::EC2::SecurityGroup', SG)],
  [
    'Failed to update SecurityGroup Res: ',
    update(
      'AWS::EC2::SecurityGroup',
      'sg-1',
      { ...SG, SecurityGroupIngress: [{ IpProtocol: 'tcp', FromPort: 22, ToPort: 22, CidrIp: '10.0.0.0/8' }] },
      SG
    ),
  ],
  ['Failed to delete SecurityGroup Res: ', del('AWS::EC2::SecurityGroup', 'sg-1')],
  ['Failed to create SecurityGroupIngress Res: ', create('AWS::EC2::SecurityGroupIngress', INGRESS)],
  [
    'Failed to delete SecurityGroupIngress Res: ',
    (p) =>
      p.delete('Res', 'sg-1|tcp|443|443', 'AWS::EC2::SecurityGroupIngress', INGRESS),
  ],
  [
    'Failed to create EC2 Instance Res: ',
    create('AWS::EC2::Instance', { ImageId: 'ami-1', InstanceType: 't3.micro' }),
  ],
  [
    'Failed to update EC2 Instance Res: ',
    update(
      'AWS::EC2::Instance',
      'i-1',
      { ImageId: 'ami-1', InstanceType: 't3.small' },
      { ImageId: 'ami-1', InstanceType: 't3.micro' }
    ),
  ],
  ['Failed to terminate EC2 Instance Res: ', del('AWS::EC2::Instance', 'i-1')],
  ['Failed to create NetworkAcl Res: ', create('AWS::EC2::NetworkAcl', { VpcId: 'vpc-1' })],
  ['Failed to delete NetworkAcl Res: ', del('AWS::EC2::NetworkAcl', 'acl-1')],
  ['Failed to create NetworkAclEntry Res: ', create('AWS::EC2::NetworkAclEntry', NACL_ENTRY)],
  ['Failed to delete NetworkAclEntry Res: ', del('AWS::EC2::NetworkAclEntry', 'acl-1|100|false')],
  [
    'Failed to create SubnetNetworkAclAssociation Res: ',
    create('AWS::EC2::SubnetNetworkAclAssociation', { SubnetId: 'subnet-1', NetworkAclId: 'acl-1' }),
  ],
  [
    'Failed to update EC2 resource Res: ',
    update('AWS::EC2::EIP', '203.0.113.1|eipalloc-1', { Domain: 'vpc', InstanceId: 'i-2' }, { Domain: 'vpc' }),
  ],
];

async function thrownBy(run: Run): Promise<unknown> {
  return run(new EC2Provider()).then(
    () => {
      throw new Error('expected the call to throw');
    },
    (e: unknown) => e
  );
}

describe('EC2Provider thrown errors keep the caller identity out (go-to-k/cdkd#2319)', () => {
  const savedNoWait = process.env['CDKD_NO_WAIT'];

  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockReset();
    process.env['CDKD_NO_WAIT'] = 'true';
  });

  afterEach(() => {
    if (savedNoWait === undefined) delete process.env['CDKD_NO_WAIT'];
    else process.env['CDKD_NO_WAIT'] = savedNoWait;
  });

  describe.each(SITES)('%s', (prefix, run) => {
    it('names an AWS-authored failure by its class, keeps the cause, and debugs the full text', async () => {
      const aws = unauthorizedNamingTheCaller();
      mockSend.mockRejectedValue(aws);

      const error = await thrownBy(run);

      expect(error).toBeInstanceOf(ProvisioningError);
      const message = (error as Error).message;
      expect(message).toBe(`${prefix}UnauthorizedOperation. ${VERBOSE_POINTER}`);
      expectNoIdentity(message);
      // The withheld text is not lost: it reaches debug under the same prefix,
      // and the cause chain carries it for the retry classifiers.
      expect((error as Error).cause).toBe(aws);
      expect(hasRedactedCause(error)).toBe(true);
      expect(debugSpy.mock.calls.map((c) => String(c[0]))).toContain(`${prefix}${aws.message}`);
    });

    it('keeps a cdkd-authored or transport failure verbatim and unstamped', async () => {
      // As the SDK gives up on a socket error: `$metadata` stamped by the retry
      // middleware, but no `$fault` and no HTTP status (go-to-k/cdkd#3297).
      const transport = Object.assign(new Error('connect ECONNREFUSED 10.0.0.1:443'), {
        $metadata: { attempts: 3, totalRetryDelay: 120 },
      });
      mockSend.mockRejectedValue(transport);

      const error = await thrownBy(run);

      expect((error as Error).message).toBe(`${prefix}connect ECONNREFUSED 10.0.0.1:443`);
      expect(hasRedactedCause(error)).toBe(false);
    });
  });

  it('keeps the IAM-propagation retry classification on the cause chain', async () => {
    mockSend.mockRejectedValue(unauthorizedNamingTheCaller());

    const error = await thrownBy(create('AWS::EC2::VPC', VPC));

    // The top-level message alone no longer says `not authorized to perform`;
    // the stamped chain does, so the dense IAM cadence still applies.
    expect(isIamPropagationError((error as Error).message)).toBe(false);
    const classified = retryClassificationText(error);
    expect(isIamPropagationError(classified)).toBe(true);
    expect(isRetryableTransientError(error, classified)).toBe(true);
  });

  it('still credits a security-group name collision on the create-first path', async () => {
    const duplicate = Object.assign(
      new Error(`The security group 'web' already exists for VPC 'vpc-1'`),
      { name: 'InvalidGroup.Duplicate', $fault: 'client', $metadata: { httpStatusCode: 400 } }
    );
    mockSend.mockRejectedValue(duplicate);

    const error = await thrownBy(create('AWS::EC2::SecurityGroup', { ...SG, GroupName: 'web' }));

    expect((error as Error).message).toBe(
      `Failed to create SecurityGroup Res: InvalidGroup.Duplicate. ${VERBOSE_POINTER} AWS reports that it already exists.`
    );
    expect(isNameCollisionErrorFrom(error, 'Res')).toBe(true);
  });

  it('does not credit a collision the AWS text never reported', async () => {
    mockSend.mockRejectedValue(unauthorizedNamingTheCaller());

    const error = await thrownBy(create('AWS::EC2::SecurityGroup', { ...SG, GroupName: 'web' }));

    expect((error as Error).message).not.toContain('already exists');
    expect(isNameCollisionErrorFrom(error, 'Res')).toBe(false);
  });

  it("keeps sendTaggedCreate's fixed note when the tagged and untagged creates are both denied", async () => {
    mockSend.mockImplementation((command: { input: Record<string, unknown> }) =>
      Promise.reject(
        unauthorizedNamingTheCaller(
          command.input['TagSpecifications'] !== undefined ? 'ec2:CreateTags' : 'ec2:CreateVpc'
        )
      )
    );

    const error = await thrownBy(
      create('AWS::EC2::VPC', { ...VPC, Tags: [{ Key: 'Name', Value: 'app' }] })
    );

    expect((error as Error).message).toBe(
      `Failed to create VPC Res: UnauthorizedOperation. ${VERBOSE_POINTER} ` +
        'The create without tags was refused too (UnauthorizedOperation).'
    );
    expectNoIdentity((error as Error).message);
  });

  it('keeps the explicit-deny note and its non-retryable mark when the untagged create met an explicit deny', async () => {
    mockSend.mockImplementation((command: { input: Record<string, unknown> }) =>
      Promise.reject(
        command.input['TagSpecifications'] !== undefined
          ? unauthorizedNamingTheCaller('ec2:CreateTags')
          : unauthorizedNamingTheCaller(
              'ec2:CreateVpc',
              'with an explicit deny in a service control policy'
            )
      )
    );

    const error = await thrownBy(
      create('AWS::EC2::VPC', { ...VPC, Tags: [{ Key: 'Name', Value: 'app' }] })
    );

    expect((error as Error).message).toBe(
      `Failed to create VPC Res: UnauthorizedOperation. ${VERBOSE_POINTER} ` +
        'The create without tags was refused too (UnauthorizedOperation); explicit deny (service control policy).'
    );
    expectNoIdentity((error as Error).message);
    expect(isMarkedNonRetryable(error)).toBe(true);
  });

  it('does not restate a collision for a non-Error throw that stringifies as one', async () => {
    mockSend.mockRejectedValue({ toString: () => `The security group 'web' already exists` });

    const error = await thrownBy(create('AWS::EC2::SecurityGroup', { ...SG, GroupName: 'web' }));

    expect((error as Error).message).toBe(
      `Failed to create SecurityGroup Res: a non-Error value of type object. ${VERBOSE_POINTER}`
    );
    expect(isNameCollisionErrorFrom(error, 'Res')).toBe(false);
  });

  it('names a non-Error throw by its type rather than stringifying it', async () => {
    const value = { toString: () => `${CALLER_ARN}` };
    mockSend.mockRejectedValue(value);

    const error = await thrownBy(create('AWS::EC2::VPC', VPC));

    expect((error as Error).message).toBe(
      `Failed to create VPC Res: a non-Error value of type object. ${VERBOSE_POINTER}`
    );
    expectNoIdentity((error as Error).message);
    expect(hasRedactedCause(error)).toBe(false);
  });
});
