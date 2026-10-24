import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vite-plus/test';

const { mockSend, debug, warn } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
}));

// Every client a provider in this slice reads from `getAwsClients()` or builds
// itself routes to `mockSend`.
vi.mock('../../../src/utils/aws-clients.js', () => {
  const client = { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } };
  return { getAwsClients: () => new Proxy({}, { get: () => client }) };
});

function routedClient(pkg: string, ...classes: string[]) {
  return async () => {
    const actual = await vi.importActual<Record<string, unknown>>(pkg);
    const out: Record<string, unknown> = { ...actual };
    for (const name of classes) {
      out[name] = vi.fn().mockImplementation((cfg: { region?: string } | undefined) => ({
        send: mockSend,
        config: { region: () => Promise.resolve(cfg?.region ?? 'us-east-1') },
        middlewareStack: { add: vi.fn(), addRelativeTo: vi.fn() },
      }));
    }
    return out;
  };
}
vi.mock('@aws-sdk/client-ec2', routedClient('@aws-sdk/client-ec2', 'EC2Client'));
vi.mock('@aws-sdk/client-dynamodb', routedClient('@aws-sdk/client-dynamodb', 'DynamoDBClient'));
vi.mock(
  '@aws-sdk/client-application-auto-scaling',
  routedClient('@aws-sdk/client-application-auto-scaling', 'ApplicationAutoScalingClient')
);
vi.mock(
  '@aws-sdk/client-auto-scaling',
  routedClient('@aws-sdk/client-auto-scaling', 'AutoScalingClient')
);
vi.mock(
  '@aws-sdk/client-cognito-identity-provider',
  routedClient('@aws-sdk/client-cognito-identity-provider', 'CognitoIdentityProviderClient')
);

vi.mock('../../../src/deployment/intrinsic-function-resolver.js', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    getAccountInfo: () =>
      Promise.resolve({ accountId: '111122223333', region: 'us-east-1', partition: 'aws' }),
  };
});

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger: Record<string, unknown> = {
    debug,
    info: vi.fn(),
    warn,
    error: vi.fn(),
  };
  childLogger['child'] = () => childLogger;
  return { getLogger: () => childLogger };
});

import { EC2Provider } from '../../../src/provisioning/providers/ec2-provider.js';
import { DynamoDBTableProvider } from '../../../src/provisioning/providers/dynamodb-table-provider.js';
import { ASGProvider } from '../../../src/provisioning/providers/asg-provider.js';
import { CognitoUserPoolProvider } from '../../../src/provisioning/providers/cognito-provider.js';
import {
  hasRedactedCause,
  isNameCollisionErrorFrom,
  isRetryableTransientError,
  retryClassificationText,
} from '../../../src/deployment/retryable-errors.js';
import { VERBOSE_POINTER } from '../../../src/utils/aws-failure-text.js';
import { isMarkedNotGone } from '../../../src/provisioning/not-gone.js';
import { allowUnscopedCreateTokensForTests } from '../../../src/provisioning/providers/idempotency-token.js';
import { awsSdkError } from '../_aws-sdk-error.js';

// create() runs outside a withStackScope scope here, so the stack-scoped
// create token (go-to-k/cdkd#4428) is opted out of its guard.
beforeAll(() => {
  allowUnscopedCreateTokensForTests(true);
});
afterAll(() => {
  allowUnscopedCreateTokensForTests(false);
});

// go-to-k/cdkd#2319: a provider's create / update / delete wrap is persisted to
// `deployments/{runId}.jsonl`, so an AWS-authored failure is named by its class
// plus the --verbose pointer; AWS's text (the caller's role ARN) goes to the
// masked debug line and stays on `cause` for the retry classifiers.
const ACCOUNT_ARN = '111122223333:assumed-role';
const DENIED =
  'User: arn:aws:sts::111122223333:assumed-role/deployer/s3cr3t is not authorized to perform: x:Y';
const denied = (): Error => {
  const error = awsSdkError(DENIED, 'AccessDenied');
  Object.assign(error, { $fault: 'client' });
  return error;
};
const mask = (t: string): string => t.replaceAll('s3cr3t', '***');
const ctx = { maskSecrets: mask };
const debugLines = (): string[] => debug.mock.calls.map((c) => String(c[0]));
const warnLines = (): string[] => warn.mock.calls.map((c) => String(c[0]));
const commandName = (command: unknown): string =>
  (command as { constructor: { name: string } }).constructor.name;

async function caught(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected a rejection');
}

/**
 * Answer each command from `responses` (default `{}`), rejecting the commands
 * named in `failing` with their value.
 */
function answer(responses: Record<string, unknown>, failing: Record<string, unknown>): void {
  mockSend.mockImplementation(async (command: unknown) => {
    const name = commandName(command);
    if (name in failing) throw failing[name];
    return responses[name] ?? {};
  });
}

/**
 * `prime` makes only the site's own call reject, for a site an earlier call in
 * the same method would otherwise wrap first; without it every send rejects.
 */
type Case = {
  wrap: string;
  run: () => Promise<unknown>;
  prime?: (rejection: unknown) => void;
};

function reject(c: Case, rejection: unknown): void {
  if (c.prime) c.prime(rejection);
  else mockSend.mockRejectedValue(rejection);
}

const EC2_VPC = { CidrBlock: '10.0.0.0/16' };
const EC2_SUBNET = { VpcId: 'vpc-1', CidrBlock: '10.0.1.0/24' };
const EC2_SG = { GroupDescription: 'd', VpcId: 'vpc-1' };
const EC2_INGRESS = {
  GroupId: 'sg-1',
  IpProtocol: 'tcp',
  FromPort: 443,
  ToPort: 443,
  CidrIp: '0.0.0.0/0',
};
const EC2_ROUTE = { RouteTableId: 'rtb-1', DestinationCidrBlock: '0.0.0.0/0', GatewayId: 'igw-1' };
const EC2_NACL_ENTRY = {
  NetworkAclId: 'acl-1',
  RuleNumber: 100,
  Protocol: -1,
  RuleAction: 'allow',
  Egress: false,
  CidrBlock: '0.0.0.0/0',
};
const ec2 = (): EC2Provider => new EC2Provider();
const ec2Create =
  (type: string, props: Record<string, unknown>) => (): Promise<unknown> =>
    ec2().create('Res', type, props, ctx);
const ec2Update =
  (type: string, id: string, props: Record<string, unknown>, prev: Record<string, unknown>) =>
  (): Promise<unknown> =>
    ec2().update('Res', id, type, props, prev, ctx);
const ec2Delete =
  (type: string, id: string, props?: Record<string, unknown>) => (): Promise<unknown> =>
    ec2().delete('Res', id, type, props, ctx);

const TABLE = 'AWS::DynamoDB::Table';
const TABLE_NAME = 't1';
const ACTIVE_TABLE = {
  Table: {
    TableName: TABLE_NAME,
    TableArn: `arn:aws:dynamodb:us-east-1:111122223333:table/${TABLE_NAME}`,
    TableId: 'table-id-1',
    TableStatus: 'ACTIVE',
  },
};
const TABLE_PROPS = {
  TableName: TABLE_NAME,
  KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
  AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }],
  BillingMode: 'PAY_PER_REQUEST',
};
/** Reject only `failing`; DynamoDB answers every other command with an ACTIVE table. */
const tableFailOn =
  (failing: string) =>
  (rejection: unknown): void => {
    mockSend.mockImplementation(async (command: unknown) => {
      if (commandName(command) === failing) throw rejection;
      return ACTIVE_TABLE;
    });
  };

const ASG = 'AWS::AutoScaling::AutoScalingGroup';
const ASG_PROPS = { AutoScalingGroupName: 'my-asg', MinSize: '0', MaxSize: '1' };
const POOL = 'AWS::Cognito::UserPool';
const POOL_ID = 'us-east-1_abc123';

const ec2Cases: Case[] = [
  { wrap: 'Failed to create VPC Res', run: ec2Create('AWS::EC2::VPC', EC2_VPC) },
  {
    wrap: 'Failed to update VPC Res',
    run: ec2Update('AWS::EC2::VPC', 'vpc-1', { ...EC2_VPC, EnableDnsSupport: false }, EC2_VPC),
  },
  { wrap: 'Failed to delete VPC Res', run: ec2Delete('AWS::EC2::VPC', 'vpc-1') },
  { wrap: 'Failed to create Subnet Res', run: ec2Create('AWS::EC2::Subnet', EC2_SUBNET) },
  {
    wrap: 'Failed to update Subnet Res',
    run: ec2Update(
      'AWS::EC2::Subnet',
      'subnet-1',
      { ...EC2_SUBNET, MapPublicIpOnLaunch: true },
      EC2_SUBNET
    ),
  },
  { wrap: 'Failed to delete Subnet Res', run: ec2Delete('AWS::EC2::Subnet', 'subnet-1') },
  { wrap: 'Failed to create InternetGateway Res', run: ec2Create('AWS::EC2::InternetGateway', {}) },
  {
    wrap: 'Failed to delete InternetGateway Res',
    run: ec2Delete('AWS::EC2::InternetGateway', 'igw-1'),
  },
  { wrap: 'Failed to create EIP Res', run: ec2Create('AWS::EC2::EIP', { Domain: 'vpc' }) },
  { wrap: 'Failed to delete EIP Res', run: ec2Delete('AWS::EC2::EIP', '203.0.113.1|eipalloc-1') },
  {
    wrap: 'Failed to create VPCGatewayAttachment Res',
    run: ec2Create('AWS::EC2::VPCGatewayAttachment', { VpcId: 'vpc-1', InternetGatewayId: 'igw-1' }),
  },
  {
    wrap: 'Failed to delete VPCGatewayAttachment Res',
    run: ec2Delete('AWS::EC2::VPCGatewayAttachment', 'igw-1|vpc-1'),
  },
  {
    wrap: 'Failed to create NatGateway Res',
    run: ec2Create('AWS::EC2::NatGateway', { SubnetId: 'subnet-1', AllocationId: 'eipalloc-1' }),
  },
  { wrap: 'Failed to delete NatGateway Res', run: ec2Delete('AWS::EC2::NatGateway', 'nat-1') },
  {
    wrap: 'Failed to create RouteTable Res',
    run: ec2Create('AWS::EC2::RouteTable', { VpcId: 'vpc-1' }),
  },
  { wrap: 'Failed to delete RouteTable Res', run: ec2Delete('AWS::EC2::RouteTable', 'rtb-1') },
  { wrap: 'Failed to create Route Res', run: ec2Create('AWS::EC2::Route', EC2_ROUTE) },
  {
    wrap: 'Failed to update Route Res',
    run: ec2Update('AWS::EC2::Route', 'rtb-1|0.0.0.0/0', { ...EC2_ROUTE, GatewayId: 'igw-2' }, EC2_ROUTE),
  },
  { wrap: 'Failed to delete Route Res', run: ec2Delete('AWS::EC2::Route', 'rtb-1|0.0.0.0/0') },
  {
    // A destination the physical id does not name: the update deletes the
    // recorded route first, and passes that delete's wrap through.
    wrap: 'Failed to delete Route Res',
    run: ec2Update(
      'AWS::EC2::Route',
      'rtb-1|0.0.0.0/0',
      { ...EC2_ROUTE, DestinationCidrBlock: '10.0.0.0/8' },
      EC2_ROUTE
    ),
  },
  {
    wrap: 'Failed to create SubnetRouteTableAssociation Res',
    run: ec2Create('AWS::EC2::SubnetRouteTableAssociation', {
      SubnetId: 'subnet-1',
      RouteTableId: 'rtb-1',
    }),
  },
  {
    wrap: 'Failed to delete SubnetRouteTableAssociation Res',
    run: ec2Delete('AWS::EC2::SubnetRouteTableAssociation', 'rtbassoc-1'),
  },
  { wrap: 'Failed to create SecurityGroup Res', run: ec2Create('AWS::EC2::SecurityGroup', EC2_SG) },
  {
    wrap: 'Failed to update SecurityGroup Res',
    run: ec2Update(
      'AWS::EC2::SecurityGroup',
      'sg-1',
      {
        ...EC2_SG,
        SecurityGroupIngress: [{ IpProtocol: 'tcp', FromPort: 22, ToPort: 22, CidrIp: '10.0.0.0/8' }],
      },
      EC2_SG
    ),
  },
  { wrap: 'Failed to delete SecurityGroup Res', run: ec2Delete('AWS::EC2::SecurityGroup', 'sg-1') },
  {
    wrap: 'Failed to create SecurityGroupIngress Res',
    run: ec2Create('AWS::EC2::SecurityGroupIngress', EC2_INGRESS),
  },
  {
    wrap: 'Failed to delete SecurityGroupIngress Res',
    run: ec2Delete('AWS::EC2::SecurityGroupIngress', 'sg-1|tcp|443|443', EC2_INGRESS),
  },
  {
    // A rule change is a revoke then an authorize; the update passes the
    // revoke's wrap through.
    wrap: 'Failed to delete SecurityGroupIngress Res',
    run: ec2Update(
      'AWS::EC2::SecurityGroupIngress',
      'sg-1|tcp|443|443',
      { ...EC2_INGRESS, FromPort: 444, ToPort: 444 },
      EC2_INGRESS
    ),
  },
  {
    wrap: 'Failed to create EC2 Instance Res',
    run: ec2Create('AWS::EC2::Instance', { ImageId: 'ami-1', InstanceType: 't3.micro' }),
  },
  {
    wrap: 'Failed to update EC2 Instance Res',
    run: ec2Update(
      'AWS::EC2::Instance',
      'i-1',
      { ImageId: 'ami-1', InstanceType: 't3.small' },
      { ImageId: 'ami-1', InstanceType: 't3.micro' }
    ),
  },
  { wrap: 'Failed to terminate EC2 Instance Res', run: ec2Delete('AWS::EC2::Instance', 'i-1') },
  {
    wrap: 'Failed to create NetworkAcl Res',
    run: ec2Create('AWS::EC2::NetworkAcl', { VpcId: 'vpc-1' }),
  },
  { wrap: 'Failed to delete NetworkAcl Res', run: ec2Delete('AWS::EC2::NetworkAcl', 'acl-1') },
  {
    wrap: 'Failed to create NetworkAclEntry Res',
    run: ec2Create('AWS::EC2::NetworkAclEntry', EC2_NACL_ENTRY),
  },
  {
    wrap: 'Failed to update NetworkAclEntry Res',
    run: ec2Update(
      'AWS::EC2::NetworkAclEntry',
      'acl-1|100|false',
      { ...EC2_NACL_ENTRY, RuleAction: 'deny' },
      EC2_NACL_ENTRY
    ),
  },
  {
    wrap: 'Failed to delete NetworkAclEntry Res',
    run: ec2Delete('AWS::EC2::NetworkAclEntry', 'acl-1|100|false'),
  },
  {
    wrap: 'Failed to create SubnetNetworkAclAssociation Res',
    run: ec2Create('AWS::EC2::SubnetNetworkAclAssociation', {
      SubnetId: 'subnet-1',
      NetworkAclId: 'acl-1',
    }),
  },
  {
    wrap: 'Failed to update EC2 resource Res',
    run: ec2Update(
      'AWS::EC2::EIP',
      '203.0.113.1|eipalloc-1',
      { Domain: 'vpc', InstanceId: 'i-2' },
      { Domain: 'vpc' }
    ),
  },
];

const otherCases: Case[] = [
  {
    wrap: 'Failed to create DynamoDB table Res',
    run: () => new DynamoDBTableProvider().create('Res', TABLE, TABLE_PROPS, ctx),
    prime: tableFailOn('CreateTableCommand'),
  },
  {
    wrap: 'Failed to update DynamoDB table Res',
    run: () =>
      new DynamoDBTableProvider().update(
        'Res',
        TABLE_NAME,
        TABLE,
        { ...TABLE_PROPS, Tags: [{ Key: 'k', Value: 'v2' }] },
        { ...TABLE_PROPS, Tags: [{ Key: 'k', Value: 'v1' }] },
        ctx
      ),
    prime: tableFailOn('TagResourceCommand'),
  },
  {
    wrap: 'Failed to delete DynamoDB table Res',
    run: () => new DynamoDBTableProvider().delete('Res', TABLE_NAME, TABLE, {}, ctx),
    prime: tableFailOn('DeleteTableCommand'),
  },
  {
    wrap: 'Failed to create AutoScalingGroup MyAsg',
    run: () => new ASGProvider().create('MyAsg', ASG, ASG_PROPS, ctx),
  },
  {
    wrap: 'Failed to update AutoScalingGroup MyAsg',
    run: () =>
      new ASGProvider().update('MyAsg', 'my-asg', ASG, { ...ASG_PROPS, MaxSize: '2' }, ASG_PROPS, ctx),
    prime: (rejection) =>
      mockSend.mockImplementation(async (command: unknown) => {
        if (commandName(command) === 'UpdateAutoScalingGroupCommand') throw rejection;
        return { AutoScalingGroups: [{ AutoScalingGroupName: 'my-asg' }], Reservations: [] };
      }),
  },
  {
    wrap: 'Failed to delete AutoScalingGroup MyAsg',
    run: () => new ASGProvider().delete('MyAsg', 'my-asg', ASG, undefined, ctx),
  },
  {
    wrap: 'Failed to create Cognito User Pool Pool',
    run: () => new CognitoUserPoolProvider().create('Pool', POOL, {}, ctx),
  },
  {
    wrap: 'Failed to update Cognito User Pool Pool',
    run: () =>
      new CognitoUserPoolProvider().update(
        'Pool',
        POOL_ID,
        POOL,
        { AutoVerifiedAttributes: ['email'] },
        {},
        ctx
      ),
    prime: (rejection) =>
      mockSend.mockImplementation(async (command: unknown) => {
        if (commandName(command) === 'UpdateUserPoolCommand') throw rejection;
        return { UserPool: { Id: POOL_ID } };
      }),
  },
  {
    wrap: 'Failed to delete Cognito User Pool Pool',
    run: () => new CognitoUserPoolProvider().delete('Pool', POOL_ID, POOL, undefined, ctx),
  },
];

const cases: Case[] = [...ec2Cases, ...otherCases];

describe('tail-c provider wraps withhold AWS text (#2319)', () => {
  const savedNoWait = process.env['CDKD_NO_WAIT'];

  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockReset();
    // The EC2 creates skip their stabilization waits.
    process.env['CDKD_NO_WAIT'] = 'true';
  });
  afterEach(() => {
    if (savedNoWait === undefined) delete process.env['CDKD_NO_WAIT'];
    else process.env['CDKD_NO_WAIT'] = savedNoWait;
  });

  it('covers every wrap of the slice', () => {
    // Every EC2 wrap call site but the in-place VPCGatewayAttachment swap and
    // the delete-then-create Route / SecurityGroupIngress updates' own wraps,
    // which no single rejection reaches (the latter two pass the inner delete
    // wrap through, which the two update rows here reach instead).
    const ec2Source = readFileSync(
      fileURLToPath(new URL('../../../src/provisioning/providers/ec2-provider.ts', import.meta.url)),
      'utf8'
    );
    // Minus one: `wrapDeleteError`'s own call into `wrapCaughtError`.
    const ec2Wraps = (ec2Source.match(/this\.wrap(Caught|Delete)Error\(/g) ?? []).length - 1;
    expect(ec2Wraps).toBe(39);
    expect(new Set(ec2Cases.map((c) => c.wrap)).size).toBe(ec2Wraps - 3);
    expect(ec2Cases).toHaveLength(38);
    expect(otherCases).toHaveLength(9);
  });

  it.each(cases)('$wrap: an AWS-authored failure is named by its class', async (c) => {
    const rejection = denied();
    // Positive control: the fake error does carry the caller's identity.
    expect(rejection.message).toContain(ACCOUNT_ARN);
    reject(c, rejection);

    const failure = await caught(c.run());

    expect(failure.message.startsWith(`${c.wrap}: AccessDenied. ${VERBOSE_POINTER}`)).toBe(true);
    expect(failure.message).not.toContain(ACCOUNT_ARN);
    expect(failure.message).not.toContain('not authorized');
    expect(failure.cause).toBe(rejection);
    expect(hasRedactedCause(failure)).toBe(true);
    // `not authorized to perform` is retryable (IAM propagation), read on the chain.
    expect(isRetryableTransientError(failure, retryClassificationText(failure))).toBe(true);
    expect(debugLines().some((l) => l.startsWith(`${c.wrap}: ${mask(DENIED)}`))).toBe(true);
    expect(debugLines().join('\n')).not.toContain('s3cr3t');
  });

  // The class itself is AWS-authored text: `mask(failure.summary)` is what keeps
  // a secret spelled inside it out of the thrown (persisted) message.
  it.each(cases)('$wrap: a secret spelled in the class is masked', async (c) => {
    reject(
      c,
      Object.assign(new Error('denied'), {
        name: 'Denieds3cr3tException',
        $fault: 'client',
        $metadata: { httpStatusCode: 400 },
      })
    );

    const failure = await caught(c.run());

    expect(failure.message).toContain(`${c.wrap}: Denied***Exception. ${VERBOSE_POINTER}`);
    expect(failure.message).not.toContain('s3cr3t');
    expect(hasRedactedCause(failure)).toBe(true);
  });

  it.each(cases)('$wrap: a cdkd-authored failure keeps its text, masked', async (c) => {
    reject(c, new Error('socket hang up near s3cr3t'));

    const failure = await caught(c.run());

    expect(failure.message).toContain(`${c.wrap}: socket hang up near ***`);
    expect(failure.message).not.toContain('s3cr3t');
    expect(failure.message).not.toContain(VERBOSE_POINTER);
    // The mask changed the text, so the wrap is stamped (issue #4244).
    expect(hasRedactedCause(failure)).toBe(true);
  });

  it.each(cases)('$wrap: a cdkd-authored failure the mask leaves alone is not stamped', async (c) => {
    reject(c, new Error('socket hang up'));

    const failure = await caught(c.run());

    expect(failure.message).toContain(`${c.wrap}: socket hang up`);
    expect(hasRedactedCause(failure)).toBe(false);
  });

  it.each(cases)('$wrap: a non-Error throw is withheld, unstamped', async (c) => {
    reject(c, 'raw s3cr3t value');

    const failure = await caught(c.run());

    expect(failure.message).toContain(
      `${c.wrap}: a non-Error value of type string. ${VERBOSE_POINTER}`
    );
    expect(failure.message).not.toContain('s3cr3t');
    expect(hasRedactedCause(failure)).toBe(false);
  });

  // go-to-k/cdkd#2319: a delete wrap naming a FOREIGN NotFound by its class
  // spells `NotFoundException`, which the delete classifiers read as "already
  // deleted"; the mark keeps the record (only the typed not-found means gone).
  const deleteCases = cases.filter((c) => /^Failed to (delete|terminate) /.test(c.wrap));
  it('covers every delete wrap', () => {
    // 14 EC2 delete wraps plus the two updates reaching one, and one each for
    // DynamoDB, ASG and Cognito.
    expect(deleteCases).toHaveLength(19);
  });

  it.each(deleteCases)('$wrap: a foreign NotFound is marked not gone', async (c) => {
    reject(
      c,
      Object.assign(new Error('Key arn:aws:kms:us-east-1:111122223333:key/k is pending deletion'), {
        name: 'KMSNotFoundException',
        $fault: 'client',
        $metadata: { httpStatusCode: 400 },
      })
    );

    const failure = await caught(c.run());

    expect(failure.message).toContain(`${c.wrap}: KMSNotFoundException. ${VERBOSE_POINTER}`);
    expect(isMarkedNotGone(failure)).toBe(true);
  });

  it.each(deleteCases)('$wrap: a failure that is not a NotFound is not marked', async (c) => {
    reject(c, denied());

    const failure = await caught(c.run());

    expect(isMarkedNotGone(failure)).toBe(false);
  });

  // A ConflictException matches no collision pattern by its class, so only the
  // restatement keeps a create-first replacement recognising a taken name. The
  // SecurityGroupIngress and NetworkAclEntry creates read an "already exists"
  // themselves (an identical rule), so they are not in this set.
  const collisionCases = cases.filter(
    (c) =>
      c.wrap.startsWith('Failed to create ') &&
      !/SecurityGroupIngress|NetworkAclEntry/.test(c.wrap)
  );
  it('covers the create wraps the restatement applies to', () => {
    expect(collisionCases).toHaveLength(16);
  });

  it.each(collisionCases)('$wrap: restates an "already exists" the class does not carry', async (c) => {
    reject(c, awsSdkError('A resource named x already exists in 111122223333.', 'ConflictException'));

    const failure = await caught(c.run());

    expect(failure.message).toContain(
      `${c.wrap}: ConflictException. ${VERBOSE_POINTER} AWS reports that it already exists.`
    );
    expect(failure.message).not.toContain('111122223333');
    const logicalId = /\b(Res|MyAsg|Pool)$/.exec(c.wrap)![1]!;
    expect(isNameCollisionErrorFrom(failure, logicalId)).toBe(true);
  });
});

describe('tail-c cleanup warnings name an AWS failure by its class (#2319)', () => {
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

  type WarnCase = {
    head: string;
    run: () => Promise<unknown>;
    responses: Record<string, unknown>;
    /** The wiring call whose failure starts the cleanup. */
    wiring: string;
    /** The cleanup call. */
    cleanup: string;
    /** The debug line's head, when it is not `head`. */
    debugHead?: string;
    /** Runs with the stabilization waits on (the wiring call is deferred under --no-wait). */
    waits?: boolean;
  };

  const warnCases: WarnCase[] = [
    {
      head: 'Failed to clean up partially-created VPC Res (vpc-1): ',
      run: ec2Create('AWS::EC2::VPC', { ...EC2_VPC, EnableDnsHostnames: true }),
      responses: { CreateVpcCommand: { Vpc: { VpcId: 'vpc-1' } } },
      wiring: 'ModifyVpcAttributeCommand',
      cleanup: 'DeleteVpcCommand',
    },
    {
      head: 'Failed to clean up partially-created Subnet Res (subnet-1): ',
      run: ec2Create('AWS::EC2::Subnet', { ...EC2_SUBNET, MapPublicIpOnLaunch: true }),
      responses: { CreateSubnetCommand: { Subnet: { SubnetId: 'subnet-1' } } },
      wiring: 'ModifySubnetAttributeCommand',
      cleanup: 'DeleteSubnetCommand',
    },
    {
      head: 'Failed to clean up partially-created SecurityGroup Res (sg-1): ',
      run: ec2Create('AWS::EC2::SecurityGroup', {
        ...EC2_SG,
        SecurityGroupIngress: [{ IpProtocol: 'tcp', FromPort: 443, ToPort: 443, CidrIp: '0.0.0.0/0' }],
      }),
      responses: { CreateSecurityGroupCommand: { GroupId: 'sg-1' } },
      wiring: 'AuthorizeSecurityGroupIngressCommand',
      cleanup: 'DeleteSecurityGroupCommand',
    },
    {
      head: 'Failed to release partially-created EIP Res (eipalloc-1): ',
      run: ec2Create('AWS::EC2::EIP', { Domain: 'vpc', InstanceId: 'i-1' }),
      responses: { AllocateAddressCommand: { AllocationId: 'eipalloc-1', PublicIp: '1.2.3.4' } },
      wiring: 'AssociateAddressCommand',
      cleanup: 'ReleaseAddressCommand',
      waits: true,
    },
    {
      head: 'Failed to terminate partially-created EC2 Instance Res (i-1): ',
      run: ec2Create('AWS::EC2::Instance', { ImageId: 'ami-1', IamInstanceProfile: 'profile' }),
      responses: {
        RunInstancesCommand: { Instances: [{ InstanceId: 'i-1' }] },
        DescribeInstancesCommand: {
          Reservations: [{ Instances: [{ InstanceId: 'i-1', State: { Name: 'running' } }] }],
        },
        DescribeIamInstanceProfileAssociationsCommand: { IamInstanceProfileAssociations: [] },
      },
      wiring: 'AssociateIamInstanceProfileCommand',
      cleanup: 'TerminateInstancesCommand',
      waits: true,
    },
    {
      head: `Failed to roll back partially-created DynamoDB table ${TABLE_NAME}: `,
      run: () =>
        new DynamoDBTableProvider().create(
          'Res',
          TABLE,
          { ...TABLE_PROPS, PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true } },
          ctx
        ),
      responses: { CreateTableCommand: ACTIVE_TABLE, DescribeTableCommand: ACTIVE_TABLE },
      wiring: 'UpdateContinuousBackupsCommand',
      cleanup: 'DeleteTableCommand',
    },
    {
      head: `Failed to roll back partially-created Cognito User Pool ${POOL_ID}: `,
      run: () =>
        new CognitoUserPoolProvider().create(
          'Pool',
          POOL,
          { MfaConfiguration: 'OPTIONAL', EnabledMfas: ['SOFTWARE_TOKEN_MFA'] },
          ctx
        ),
      responses: { CreateUserPoolCommand: { UserPool: { Id: POOL_ID } } },
      wiring: 'SetUserPoolMfaConfigCommand',
      cleanup: 'DeleteUserPoolCommand',
      debugHead: `Rollback of partially-created Cognito User Pool ${POOL_ID} failed: `,
    },
  ];

  it.each(warnCases)('$head an AWS failure is its class at warn, its text at masked debug', async (c) => {
    if (c.waits === true) delete process.env['CDKD_NO_WAIT'];
    const cleanupError = denied();
    answer(c.responses, {
      [c.wiring]: new Error('wiring failed'),
      [c.cleanup]: cleanupError,
    });

    await caught(c.run());

    // The cleanup call was reached and refused with the caller's identity.
    expect(mockSend.mock.calls.some(([command]) => commandName(command) === c.cleanup)).toBe(true);
    expect(cleanupError.message).toContain(ACCOUNT_ARN);
    const lines = warnLines().filter((l) => l.startsWith(c.head));
    expect(lines).toHaveLength(1);
    expect(lines[0]!.startsWith(`${c.head}AccessDenied. ${VERBOSE_POINTER}`)).toBe(true);
    expect(lines[0]).not.toContain(ACCOUNT_ARN);
    expect(debugLines()).toContain(`${c.debugHead ?? c.head}${mask(DENIED)}`);
    expect(debugLines().join('\n')).not.toContain('s3cr3t');
  });

  it.each(warnCases)('$head a secret spelled in the class is masked at warn', async (c) => {
    if (c.waits === true) delete process.env['CDKD_NO_WAIT'];
    answer(c.responses, {
      [c.wiring]: new Error('wiring failed'),
      [c.cleanup]: Object.assign(new Error('denied'), {
        name: 'Denieds3cr3tException',
        $fault: 'client',
        $metadata: { httpStatusCode: 400 },
      }),
    });

    await caught(c.run());

    const lines = warnLines().filter((l) => l.startsWith(c.head));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(`Denied***Exception. ${VERBOSE_POINTER}`);
    expect(lines[0]).not.toContain('s3cr3t');
  });

  it.each(warnCases)('$head a cdkd-authored failure keeps its text at warn, masked', async (c) => {
    if (c.waits === true) delete process.env['CDKD_NO_WAIT'];
    answer(c.responses, {
      [c.wiring]: new Error('wiring failed'),
      [c.cleanup]: new Error('socket hang up near s3cr3t'),
    });

    await caught(c.run());

    const lines = warnLines().filter((l) => l.startsWith(c.head));
    expect(lines).toHaveLength(1);
    expect(lines[0]!.startsWith(`${c.head}socket hang up near ***`)).toBe(true);
    expect(lines[0]).not.toContain(VERBOSE_POINTER);
    // No debug line repeats a text the warn already carries.
    expect(debugLines().some((l) => l.startsWith(c.debugHead ?? c.head))).toBe(false);
  });

  // An "already exists" from a post-create step names some OTHER object, so
  // the wrap must not restate it as this resource's collision (#3826).
  it.each([
    {
      wrap: 'Failed to create DynamoDB table Res',
      run: () =>
        new DynamoDBTableProvider().create(
          'Res',
          TABLE,
          { ...TABLE_PROPS, PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true } },
          ctx
        ),
      responses: { CreateTableCommand: ACTIVE_TABLE, DescribeTableCommand: ACTIVE_TABLE },
      wiring: 'UpdateContinuousBackupsCommand',
    },
    {
      wrap: 'Failed to create VPC Res',
      run: ec2Create('AWS::EC2::VPC', { ...EC2_VPC, EnableDnsHostnames: true }),
      responses: { CreateVpcCommand: { Vpc: { VpcId: 'vpc-1' } } },
      wiring: 'ModifyVpcAttributeCommand',
    },
  ])('$wrap: an "already exists" from a post-create step is not restated', async (c) => {
    answer(c.responses, {
      [c.wiring]: awsSdkError('A resource named x already exists.', 'ConflictException'),
    });

    const failure = await caught(c.run());

    expect(mockSend.mock.calls.some(([command]) => commandName(command) === c.wiring)).toBe(true);
    expect(failure.message).toBe(`${c.wrap}: ConflictException. ${VERBOSE_POINTER}`);
    expect(isNameCollisionErrorFrom(failure, 'Res')).toBe(false);
  });

  it('names a denied tag write by its class at warn', async () => {
    const tagError = denied();
    answer({}, { CreateTagsCommand: tagError });

    await ec2().update(
      'Res',
      'vpc-1',
      'AWS::EC2::VPC',
      { ...EC2_VPC, Tags: [{ Key: 'k', Value: 'v2' }] },
      { ...EC2_VPC, Tags: [{ Key: 'k', Value: 'v1' }] },
      ctx
    );

    expect(mockSend.mock.calls.some(([command]) => commandName(command) === 'CreateTagsCommand')).toBe(true);
    const lines = warnLines().filter((l) => l.startsWith('Failed to add tags on vpc-1: '));
    expect(lines).toEqual([`Failed to add tags on vpc-1: AccessDenied. ${VERBOSE_POINTER}`]);
    expect(debugLines()).toContain(`Failed to add tags on vpc-1: ${mask(DENIED)}`);
    expect(debugLines().join('\n')).not.toContain('s3cr3t');
  });
});
