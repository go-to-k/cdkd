/**
 * go-to-k/cdkd#6609, slice C: the members a separate call writes onto an IAM
 * role / user / group / managed policy / instance profile, an S3 bucket
 * policy, an event bus `Policy` and a security group's rule lists are settled
 * on the baseline captured right after cdkd's own write, and every other read
 * takes the first answer.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const mockSend = vi.fn();
const fakeClient = { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } };

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    iam: fakeClient,
    s3: fakeClient,
    eventBridge: fakeClient,
    ec2: fakeClient,
    ec2SingleSend: fakeClient,
    cloudFront: fakeClient,
    sts: fakeClient,
  }),
}));

// The EC2 provider reads the shared schedule directly; zero it for every provider.
vi.mock('../../../src/provisioning/settle-after-own-write.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  OWN_WRITE_REREAD_DELAYS_MS: [0, 0, 0],
}));

const childLogger = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: vi.fn(function (this: unknown) { return this; }),
}));
/** The `refresh-observed` warnings, for the unsettled outcome (value-free). */
const unsettledWarnings = (): string[] =>
  childLogger.warn.mock.calls
    .map((c) => String(c[0]))
    .filter((m) => m.includes('refresh-observed'));

vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    child: () => childLogger,
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { IAMRoleProvider } from '../../../src/provisioning/providers/iam-role-provider.js';
import { IAMUserGroupProvider } from '../../../src/provisioning/providers/iam-user-group-provider.js';
import { IAMManagedPolicyProvider } from '../../../src/provisioning/providers/iam-managed-policy-provider.js';
import { IAMInstanceProfileProvider } from '../../../src/provisioning/providers/iam-instance-profile-provider.js';
import { S3BucketPolicyProvider } from '../../../src/provisioning/providers/s3-bucket-policy-provider.js';
import { EventBridgeBusProvider } from '../../../src/provisioning/providers/eventbridge-bus-provider.js';
import { EC2Provider } from '../../../src/provisioning/providers/ec2-provider.js';
import type { ReadCurrentStateContext } from '../../../src/types/resource.js';
import { ResourceNotFoundException } from '@aws-sdk/client-eventbridge';
import { calculateResourceDrift } from '../../../src/analyzer/drift-calculator.js';
import { preFixBaselineUncomparedDriftKeys } from '../../../src/cli/commands/drift/baseline-keys.js';

const AFTER: ReadCurrentStateContext = { afterOwnWrite: true };
const ACCT = '111111111111';

/** Per SDK command name, the answers in order (the last one repeats); others answer `{}`. */
let script: Record<string, Array<(input: Record<string, unknown>) => unknown>> = {};
function answer(
  command: string,
  ...answers: Array<(input: Record<string, unknown>) => unknown>
): void {
  script[command] = answers;
}
const callsOf = (command: string): number =>
  mockSend.mock.calls.filter((c) => (c[0] as object).constructor.name === command).length;
const fail = (name: string) => () => {
  throw Object.assign(new Error(name), { name, $metadata: {} });
};

beforeEach(() => {
  mockSend.mockReset();
  childLogger.warn.mockClear();
  script = {};
  const served: Record<string, number> = {};
  mockSend.mockImplementation((command: { input: Record<string, unknown> }) => {
    const name = command.constructor.name;
    const queue = script[name];
    if (queue === undefined) return Promise.resolve({});
    const index = Math.min(served[name] ?? 0, queue.length - 1);
    served[name] = (served[name] ?? 0) + 1;
    try {
      return Promise.resolve(queue[index]!(command.input));
    } catch (error) {
      return Promise.reject(error);
    }
  });
});

function zeroDelays<T extends object>(provider: T): T {
  (provider as unknown as { ownWriteRereadDelaysMs: readonly number[] }).ownWriteRereadDelaysMs = [
    0, 0, 0,
  ];
  return provider;
}
type Read = Record<string, unknown> | symbol | undefined;
const bag = (read: unknown): Record<string, unknown> => read as Record<string, unknown>;
const encoded = (doc: unknown): string => encodeURIComponent(JSON.stringify(doc));

const DOC = {
  Version: '2012-10-17',
  Statement: [{ Action: 's3:GetObject', Effect: 'Allow', Resource: 'arn:aws:s3:::b/*' }],
};
const OLD_DOC = {
  Version: '2012-10-17',
  Statement: [{ Action: 's3:PutObject', Effect: 'Allow', Resource: 'arn:aws:s3:::old/*' }],
};
const ARN_A = 'arn:aws:iam::aws:policy/ReadOnlyAccess';
const ARN_B = `arn:aws:iam::${ACCT}:policy/mine`;
const ARN_OLD = 'arn:aws:iam::aws:policy/AdministratorAccess';
const BOUNDARY = `arn:aws:iam::${ACCT}:policy/boundary`;

/**
 * One settled member: the declared bag, the command whose answers the test
 * scripts (the member's own re-read), its three answers, the other commands'
 * fixed answers, and what each outcome records under `key`.
 */
interface Spec {
  name: string;
  key: string;
  read: (properties: Record<string, unknown>, context?: ReadCurrentStateContext) => Promise<Read>;
  properties: Record<string, unknown>;
  command: string;
  good: () => unknown;
  absent: () => unknown;
  other: () => unknown;
  base?: Record<string, () => unknown>;
  /** A list read holding every declared entry plus one the template does not declare. */
  extra?: () => unknown;
  goodValue: unknown;
  /** What a kept-declared baseline records under `key` (`NO_BASELINE`: the whole read is `undefined`). */
  declaredValue: unknown;
  otherValue: unknown;
  absentValue: unknown;
}
const NO_BASELINE = Symbol('no baseline');

const role = () => zeroDelays(new IAMRoleProvider());
const userGroup = () => zeroDelays(new IAMUserGroupProvider());
const getRole = (extra: Record<string, unknown> = {}) => () => ({
  Role: { RoleName: 'r', AssumeRolePolicyDocument: encoded(TRUST), ...extra },
});
const TRUST = {
  Version: '2012-10-17',
  Statement: [
    { Action: 'sts:AssumeRole', Effect: 'Allow', Principal: { Service: 'lambda.amazonaws.com' } },
  ],
};
const OLD_TRUST = {
  Version: '2012-10-17',
  Statement: [
    { Action: 'sts:AssumeRole', Effect: 'Allow', Principal: { Service: 'ec2.amazonaws.com' } },
  ],
};
const attached = (...arns: string[]) => () => ({
  AttachedPolicies: arns.map((PolicyArn) => ({ PolicyArn })),
});
const names = (...PolicyNames: string[]) => () => ({ PolicyNames });

const specs: Spec[] = [
  {
    name: 'AWS::IAM::Role AssumeRolePolicyDocument',
    key: 'AssumeRolePolicyDocument',
    read: (p, c) => role().readCurrentState('r', 'Role', 'AWS::IAM::Role', p, c),
    properties: { AssumeRolePolicyDocument: TRUST },
    command: 'GetRoleCommand',
    good: getRole(),
    absent: getRole({ AssumeRolePolicyDocument: encoded(OLD_TRUST) }),
    other: getRole({ AssumeRolePolicyDocument: encoded(OLD_TRUST) }),
    goodValue: TRUST,
    declaredValue: OLD_TRUST,
    otherValue: OLD_TRUST,
    absentValue: OLD_TRUST,
  },
  {
    name: 'AWS::IAM::Role PermissionsBoundary',
    key: 'PermissionsBoundary',
    read: (p, c) => role().readCurrentState('r', 'Role', 'AWS::IAM::Role', p, c),
    properties: { PermissionsBoundary: BOUNDARY },
    command: 'GetRoleCommand',
    good: getRole({ PermissionsBoundary: { PermissionsBoundaryArn: BOUNDARY } }),
    absent: getRole(),
    other: getRole({ PermissionsBoundary: { PermissionsBoundaryArn: ARN_OLD } }),
    goodValue: BOUNDARY,
    declaredValue: BOUNDARY,
    otherValue: ARN_OLD,
    absentValue: '',
  },
  {
    name: 'AWS::IAM::Role ManagedPolicyArns',
    key: 'ManagedPolicyArns',
    read: (p, c) => role().readCurrentState('r', 'Role', 'AWS::IAM::Role', p, c),
    properties: { ManagedPolicyArns: [ARN_A, ARN_B] },
    command: 'ListAttachedRolePoliciesCommand',
    base: { GetRoleCommand: getRole() },
    // ListAttachedRolePolicies answers in its own order.
    good: attached(ARN_B, ARN_A),
    absent: attached(),
    other: attached(ARN_A, ARN_OLD),
    extra: attached(ARN_OLD, ARN_B, ARN_A),
    goodValue: [ARN_B, ARN_A],
    declaredValue: [ARN_A, ARN_B],
    // The declared ARN still unread is added at its declared position.
    otherValue: [ARN_A, ARN_B, ARN_OLD],
    absentValue: [],
  },
  {
    name: 'AWS::IAM::Role Policies',
    key: 'Policies',
    read: (p, c) => role().readCurrentState('r', 'Role', 'AWS::IAM::Role', p, c),
    properties: { Policies: [{ PolicyName: 'p', PolicyDocument: DOC }] },
    command: 'ListRolePoliciesCommand',
    base: { GetRoleCommand: getRole(), GetRolePolicyCommand: () => ({ PolicyDocument: encoded(DOC) }) },
    good: names('p'),
    absent: names(),
    other: names('old'),
    extra: names('old', 'p'),
    goodValue: [{ PolicyName: 'p', PolicyDocument: DOC }],
    declaredValue: [{ PolicyName: 'p', PolicyDocument: DOC }],
    otherValue: [
      { PolicyName: 'p', PolicyDocument: DOC },
      { PolicyName: 'old', PolicyDocument: DOC },
    ],
    absentValue: [],
  },
  {
    name: 'AWS::IAM::User PermissionsBoundary',
    key: 'PermissionsBoundary',
    read: (p, c) => userGroup().readCurrentState('u', 'User', 'AWS::IAM::User', p, c),
    properties: { PermissionsBoundary: BOUNDARY },
    command: 'GetUserCommand',
    good: () => ({ User: { UserName: 'u', PermissionsBoundary: { PermissionsBoundaryArn: BOUNDARY } } }),
    absent: () => ({ User: { UserName: 'u' } }),
    other: () => ({ User: { UserName: 'u', PermissionsBoundary: { PermissionsBoundaryArn: ARN_OLD } } }),
    goodValue: BOUNDARY,
    declaredValue: BOUNDARY,
    otherValue: ARN_OLD,
    absentValue: '',
  },
  {
    name: 'AWS::IAM::User ManagedPolicyArns',
    key: 'ManagedPolicyArns',
    read: (p, c) => userGroup().readCurrentState('u', 'User', 'AWS::IAM::User', p, c),
    properties: { ManagedPolicyArns: [ARN_A] },
    command: 'ListAttachedUserPoliciesCommand',
    base: { GetUserCommand: () => ({ User: { UserName: 'u' } }) },
    good: attached(ARN_A),
    absent: attached(),
    other: attached(ARN_OLD),
    extra: attached(ARN_OLD, ARN_A),
    goodValue: [ARN_A],
    declaredValue: [ARN_A],
    otherValue: [ARN_A, ARN_OLD],
    absentValue: [],
  },
  {
    name: 'AWS::IAM::User Groups',
    key: 'Groups',
    read: (p, c) => userGroup().readCurrentState('u', 'User', 'AWS::IAM::User', p, c),
    properties: { Groups: ['g1', 'g2'] },
    command: 'ListGroupsForUserCommand',
    base: { GetUserCommand: () => ({ User: { UserName: 'u' } }) },
    good: () => ({ Groups: [{ GroupName: 'g2' }, { GroupName: 'g1' }] }),
    absent: () => ({ Groups: [] }),
    other: () => ({ Groups: [{ GroupName: 'g1' }, { GroupName: 'gone' }] }),
    extra: () => ({ Groups: [{ GroupName: 'g2' }, { GroupName: 'other' }, { GroupName: 'g1' }] }),
    goodValue: ['g2', 'g1'],
    declaredValue: ['g1', 'g2'],
    otherValue: ['g1', 'g2', 'gone'],
    absentValue: [],
  },
  {
    name: 'AWS::IAM::User Policies',
    key: 'Policies',
    read: (p, c) => userGroup().readCurrentState('u', 'User', 'AWS::IAM::User', p, c),
    properties: { Policies: [{ PolicyName: 'p', PolicyDocument: JSON.stringify(DOC) }] },
    command: 'ListUserPoliciesCommand',
    base: {
      GetUserCommand: () => ({ User: { UserName: 'u' } }),
      GetUserPolicyCommand: () => ({ PolicyDocument: encoded(DOC) }),
    },
    good: names('p'),
    absent: names(),
    other: names('old'),
    extra: names('old', 'p'),
    goodValue: [{ PolicyName: 'p', PolicyDocument: DOC }],
    // A declared JSON-string document is kept in the read's parsed shape.
    declaredValue: [{ PolicyName: 'p', PolicyDocument: DOC }],
    otherValue: [
      { PolicyName: 'p', PolicyDocument: DOC },
      { PolicyName: 'old', PolicyDocument: DOC },
    ],
    absentValue: [],
  },
  {
    name: 'AWS::IAM::Group ManagedPolicyArns',
    key: 'ManagedPolicyArns',
    read: (p, c) => userGroup().readCurrentState('g', 'Group', 'AWS::IAM::Group', p, c),
    properties: { ManagedPolicyArns: [ARN_A] },
    command: 'ListAttachedGroupPoliciesCommand',
    base: { GetGroupCommand: () => ({ Group: { GroupName: 'g' } }) },
    good: attached(ARN_A),
    absent: attached(),
    other: attached(ARN_OLD),
    extra: attached(ARN_OLD, ARN_A),
    goodValue: [ARN_A],
    declaredValue: [ARN_A],
    otherValue: [ARN_A, ARN_OLD],
    absentValue: [],
  },
  {
    name: 'AWS::IAM::Group Policies',
    key: 'Policies',
    read: (p, c) => userGroup().readCurrentState('g', 'Group', 'AWS::IAM::Group', p, c),
    properties: { Policies: [{ PolicyName: 'p', PolicyDocument: DOC }] },
    command: 'ListGroupPoliciesCommand',
    base: {
      GetGroupCommand: () => ({ Group: { GroupName: 'g' } }),
      GetGroupPolicyCommand: () => ({ PolicyDocument: encoded(DOC) }),
    },
    good: names('p'),
    absent: names(),
    other: names('old'),
    extra: names('old', 'p'),
    goodValue: [{ PolicyName: 'p', PolicyDocument: DOC }],
    declaredValue: [{ PolicyName: 'p', PolicyDocument: DOC }],
    otherValue: [
      { PolicyName: 'p', PolicyDocument: DOC },
      { PolicyName: 'old', PolicyDocument: DOC },
    ],
    absentValue: [],
  },
  {
    name: 'AWS::IAM::ManagedPolicy PolicyDocument',
    key: 'PolicyDocument',
    read: (p, c) =>
      zeroDelays(new IAMManagedPolicyProvider()).readCurrentState(
        'arn:aws:iam::111111111111:policy/mp',
        'Mp',
        'AWS::IAM::ManagedPolicy',
        p,
        c
      ),
    properties: { PolicyDocument: DOC },
    command: 'GetPolicyVersionCommand',
    base: { GetPolicyCommand: () => ({ Policy: { PolicyName: 'mp', DefaultVersionId: 'v2' } }) },
    good: () => ({ PolicyVersion: { Document: encoded(DOC) } }),
    absent: () => ({ PolicyVersion: { Document: encoded(OLD_DOC) } }),
    other: () => ({ PolicyVersion: { Document: encoded(OLD_DOC) } }),
    goodValue: DOC,
    declaredValue: OLD_DOC,
    otherValue: OLD_DOC,
    absentValue: OLD_DOC,
  },
  {
    name: 'AWS::IAM::ManagedPolicy Roles',
    key: 'Roles',
    read: (p, c) =>
      zeroDelays(new IAMManagedPolicyProvider()).readCurrentState(
        'arn:aws:iam::111111111111:policy/mp',
        'Mp',
        'AWS::IAM::ManagedPolicy',
        p,
        c
      ),
    properties: { Roles: ['r1'] },
    command: 'ListEntitiesForPolicyCommand',
    base: { GetPolicyCommand: () => ({ Policy: { PolicyName: 'mp' } }) },
    good: () => ({ PolicyRoles: [{ RoleName: 'r1' }] }),
    absent: () => ({}),
    other: () => ({ PolicyRoles: [{ RoleName: 'old' }] }),
    // A role attaching the policy through its own ManagedPolicyArns, unstripped on the capture.
    extra: () => ({ PolicyRoles: [{ RoleName: 'attacher' }, { RoleName: 'r1' }] }),
    goodValue: ['r1'],
    declaredValue: ['r1'],
    otherValue: ['r1', 'old'],
    absentValue: [],
  },
  {
    name: 'AWS::IAM::InstanceProfile Roles',
    key: 'Roles',
    read: (p, c) =>
      zeroDelays(new IAMInstanceProfileProvider()).readCurrentState(
        'ip',
        'Profile',
        'AWS::IAM::InstanceProfile',
        p,
        c
      ),
    properties: { Roles: ['r1'] },
    command: 'GetInstanceProfileCommand',
    good: () => ({ InstanceProfile: { InstanceProfileName: 'ip', Roles: [{ RoleName: 'r1' }] } }),
    absent: () => ({ InstanceProfile: { InstanceProfileName: 'ip', Roles: [] } }),
    other: () => ({ InstanceProfile: { InstanceProfileName: 'ip', Roles: [{ RoleName: 'old' }] } }),
    goodValue: ['r1'],
    declaredValue: ['r1'],
    otherValue: ['r1', 'old'],
    absentValue: [],
  },
  {
    name: 'AWS::S3::BucketPolicy PolicyDocument',
    key: 'PolicyDocument',
    read: (p, c) =>
      zeroDelays(new S3BucketPolicyProvider()).readCurrentState(
        'bkt',
        'Policy',
        'AWS::S3::BucketPolicy',
        p,
        c
      ),
    properties: { Bucket: 'bkt', PolicyDocument: DOC },
    command: 'GetBucketPolicyCommand',
    good: () => ({ Policy: JSON.stringify(DOC) }),
    absent: fail('NoSuchBucketPolicy'),
    other: () => ({ Policy: JSON.stringify(OLD_DOC) }),
    goodValue: DOC,
    declaredValue: NO_BASELINE,
    otherValue: OLD_DOC,
    absentValue: NO_BASELINE,
  },
  {
    name: 'AWS::Events::EventBus Policy',
    key: 'Policy',
    read: (p, c) =>
      zeroDelays(new EventBridgeBusProvider()).readCurrentState(
        'bus',
        'Bus',
        'AWS::Events::EventBus',
        p,
        c
      ),
    properties: { Name: 'bus', Policy: DOC },
    command: 'DescribeEventBusCommand',
    good: () => ({ Name: 'bus', Policy: JSON.stringify(DOC) }),
    absent: () => ({ Name: 'bus' }),
    other: () => ({ Name: 'bus', Policy: JSON.stringify(OLD_DOC) }),
    goodValue: DOC,
    declaredValue: DOC,
    otherValue: OLD_DOC,
    absentValue: undefined,
  },
];

const INGRESS = {
  CidrIp: '10.0.0.0/8',
  Description: 'from 10.0.0.0/8:443',
  FromPort: 443,
  IpProtocol: 'tcp',
  ToPort: 443,
};
const EGRESS = {
  CidrIp: '0.0.0.0/0',
  Description: 'Allow all outbound traffic by default',
  IpProtocol: '-1',
};
const ingressPermission = {
  IpProtocol: 'tcp',
  FromPort: 443,
  ToPort: 443,
  IpRanges: [{ CidrIp: '10.0.0.0/8', Description: 'from 10.0.0.0/8:443' }],
};
const oldPermission = {
  IpProtocol: 'tcp',
  FromPort: 22,
  ToPort: 22,
  IpRanges: [{ CidrIp: '10.0.0.0/8' }],
};
const sgAnswer = (ingress: unknown[], egress: unknown[]) => () => ({
  SecurityGroups: [
    {
      GroupId: 'sg-1',
      GroupName: 'g',
      Description: 'd',
      VpcId: 'vpc-1',
      IpPermissions: ingress,
      IpPermissionsEgress: egress,
    },
  ],
});
const readSg = (p: Record<string, unknown>, c?: ReadCurrentStateContext) =>
  new EC2Provider().readCurrentState('sg-1', 'Sg', 'AWS::EC2::SecurityGroup', p, c);
// CDK's default egress, as EC2 stores it.
const cdkEgressPermission = {
  IpProtocol: '-1',
  IpRanges: [{ CidrIp: '0.0.0.0/0', Description: 'Allow all outbound traffic by default' }],
};
specs.push(
  {
    name: 'AWS::EC2::SecurityGroup SecurityGroupIngress',
    key: 'SecurityGroupIngress',
    read: readSg,
    properties: { GroupDescription: 'd', SecurityGroupIngress: [INGRESS] },
    command: 'DescribeSecurityGroupsCommand',
    good: sgAnswer([ingressPermission], []),
    absent: sgAnswer([], []),
    other: sgAnswer([oldPermission], []),
    extra: sgAnswer([oldPermission, ingressPermission], []),
    goodValue: [INGRESS],
    declaredValue: [INGRESS],
    otherValue: [INGRESS, { IpProtocol: 'tcp', FromPort: 22, ToPort: 22, CidrIp: '10.0.0.0/8' }],
    absentValue: [],
  },
  {
    name: 'AWS::EC2::SecurityGroup SecurityGroupEgress',
    key: 'SecurityGroupEgress',
    read: readSg,
    properties: { GroupDescription: 'd', SecurityGroupEgress: [EGRESS] },
    command: 'DescribeSecurityGroupsCommand',
    good: sgAnswer([], [cdkEgressPermission]),
    absent: sgAnswer([], []),
    // The allow-all rule EC2 creates with the group, not yet revoked.
    other: sgAnswer([], [{ IpProtocol: '-1', IpRanges: [{ CidrIp: '0.0.0.0/0' }] }]),
    goodValue: [EGRESS],
    declaredValue: [EGRESS],
    otherValue: [EGRESS, { IpProtocol: '-1', CidrIp: '0.0.0.0/0' }],
    absentValue: [],
  }
);

/** The recorded member, `NO_BASELINE` when the read recorded no baseline at all. */
const recorded = (read: Read, key: string): unknown =>
  read === undefined ? NO_BASELINE : bag(read)[key];
const script4 = (spec: Spec, ...answers: Array<() => unknown>): void => {
  for (const [command, value] of Object.entries(spec.base ?? {})) answer(command, value);
  answer(spec.command, ...answers);
};
/** A re-read command's answers: each of `spec.command`'s is one read of the member. */
const throttled = fail('ThrottlingException');
const refused = fail('AccessDeniedException');

describe.each(specs)('$name', (spec) => {
  it('settled on the first read: recorded as read, one call, no warning', async () => {
    script4(spec, spec.good);
    const read = await spec.read(spec.properties, AFTER);
    expect(recorded(read, spec.key)).toEqual(spec.goodValue);
    expect(callsOf(spec.command)).toBe(1);
    expect(unsettledWarnings()).toEqual([]);
  });

  it('a just-added member read as missing settles on a re-read', async () => {
    script4(spec, spec.absent, spec.good);
    const read = await spec.read(spec.properties, AFTER);
    expect(recorded(read, spec.key)).toEqual(spec.goodValue);
    expect(callsOf(spec.command)).toBe(2);
    expect(unsettledWarnings()).toEqual([]);
  });

  it('a replaced member read as its previous value settles on a re-read', async () => {
    script4(spec, spec.other, spec.good);
    const read = await spec.read(spec.properties, AFTER);
    expect(recorded(read, spec.key)).toEqual(spec.goodValue);
    expect(callsOf(spec.command)).toBe(2);
  });

  it('still missing after the schedule: the declared member is kept (4 reads, one warning)', async () => {
    script4(spec, spec.absent);
    const read = await spec.read(spec.properties, AFTER);
    expect(recorded(read, spec.key)).toEqual(spec.declaredValue);
    expect(callsOf(spec.command)).toBe(4);
    expect(unsettledWarnings()).toHaveLength(1);
    expect(unsettledWarnings()[0]).toContain(spec.key);
  });

  it('another value after the schedule: recorded as read, one value-free warning', async () => {
    script4(spec, spec.other);
    const read = await spec.read(spec.properties, AFTER);
    expect(recorded(read, spec.key)).toEqual(spec.otherValue);
    expect(callsOf(spec.command)).toBe(4);
    const warnings = unsettledWarnings();
    expect(warnings).toHaveLength(1);
    for (const needle of ['old', 's3:', 'ec2.amazonaws.com', 'AdministratorAccess', '10.0.0.0']) {
      expect(warnings[0]).not.toContain(needle);
    }
  });

  it('a deterministic re-read failure ends the schedule', async () => {
    script4(spec, spec.other, refused, spec.good);
    const read = await spec.read(spec.properties, AFTER);
    expect(recorded(read, spec.key)).toEqual(spec.otherValue);
    expect(callsOf(spec.command)).toBe(2);
  });

  it('a transient re-read failure keeps the newest answer and the schedule goes on', async () => {
    script4(spec, spec.other, throttled, throttled, throttled);
    const read = await spec.read(spec.properties, AFTER);
    expect(recorded(read, spec.key)).toEqual(spec.otherValue);
    expect(callsOf(spec.command)).toBe(4);
  });

  it('a transient failure, then the declared member: settled', async () => {
    script4(spec, spec.other, throttled, spec.good);
    const read = await spec.read(spec.properties, AFTER);
    expect(recorded(read, spec.key)).toEqual(spec.goodValue);
    expect(callsOf(spec.command)).toBe(3);
  });

  it('without the post-write context the first answer is believed (one call)', async () => {
    script4(spec, spec.absent, spec.good);
    const read = await spec.read(spec.properties, undefined);
    if (spec.absentValue === NO_BASELINE) {
      expect(typeof read).toBe('symbol'); // RESOURCE_NOT_FOUND: the policy is gone
    } else {
      expect(bag(read)[spec.key]).toEqual(spec.absentValue);
    }
    expect(callsOf(spec.command)).toBe(1);
    expect(unsettledWarnings()).toEqual([]);
  });

  it('on the post-write capture, an undeclared member is not settled (one call)', async () => {
    script4(spec, spec.other, spec.good);
    const undeclared = { ...spec.properties };
    delete undeclared[spec.key];
    await spec.read(undeclared, AFTER);
    expect(callsOf(spec.command)).toBe(1);
  });
});

describe.each(specs.filter((spec) => spec.extra !== undefined))('$name (list)', (spec) => {
  it('every declared entry plus an undeclared one (a sibling\'s, an out-of-band one) is settled: one call, recorded as read', async () => {
    script4(spec, spec.extra!, spec.good);
    const read = await spec.read(spec.properties, AFTER);
    expect(callsOf(spec.command)).toBe(1);
    const value = recorded(read, spec.key) as unknown[];
    expect(value.length).toBe((spec.goodValue as unknown[]).length + 1);
    expect(unsettledWarnings()).toEqual([]);
  });
});

describe('stored spellings and sibling-owned members settle on the first read', () => {
  it('a role ManagedPolicyArns read minus a sibling ManagedPolicy attach (#6614) is the declared list', async () => {
    answer('GetRoleCommand', getRole());
    answer('ListAttachedRolePoliciesCommand', attached(ARN_A, ARN_B));
    const context: ReadCurrentStateContext = {
      afterOwnWrite: true,
      siblings: {
        Mp: {
          resourceType: 'AWS::IAM::ManagedPolicy',
          physicalId: ARN_B,
          properties: { Roles: ['r'] },
          attributes: {},
        },
      },
    } as unknown as ReadCurrentStateContext;
    const read = await role().readCurrentState(
      'r',
      'Role',
      'AWS::IAM::Role',
      { ManagedPolicyArns: [ARN_A] },
      context
    );
    expect(bag(read)['ManagedPolicyArns']).toEqual([ARN_A]);
    expect(callsOf('ListAttachedRolePoliciesCommand')).toBe(1);
  });

  it('a security group ingress rule from a peer group, read with its owner id, is the declared rule', async () => {
    const declared = {
      Description: 'from peer:443',
      FromPort: 443,
      IpProtocol: 'tcp',
      SourceSecurityGroupId: 'sg-peer',
      ToPort: 443,
    };
    answer(
      'DescribeSecurityGroupsCommand',
      sgAnswer(
        [
          {
            IpProtocol: 'tcp',
            FromPort: 443,
            ToPort: 443,
            UserIdGroupPairs: [{ GroupId: 'sg-peer', UserId: ACCT, Description: 'from peer:443' }],
          },
        ],
        []
      )
    );
    await readSg({ GroupDescription: 'd', SecurityGroupIngress: [declared] }, AFTER);
    expect(callsOf('DescribeSecurityGroupsCommand')).toBe(1);
  });

  it('a CDK enforce-SSL bucket policy, stored as S3 stored it (2026-11-19, us-east-1), is the declared one', async () => {
    const declared = {
      Statement: [
        {
          Action: 's3:*',
          Condition: { Bool: { 'aws:SecureTransport': 'false' } },
          Effect: 'Deny',
          Principal: { AWS: '*' },
          Resource: ['arn:aws:s3:::bkt', 'arn:aws:s3:::bkt/*'],
        },
      ],
      Version: '2012-10-17',
    };
    // S3 keeps the document as sent, its keys in its own order.
    const stored = {
      Version: '2012-10-17',
      Statement: [
        {
          Effect: 'Deny',
          Principal: { AWS: '*' },
          Action: 's3:*',
          Resource: ['arn:aws:s3:::bkt', 'arn:aws:s3:::bkt/*'],
          Condition: { Bool: { 'aws:SecureTransport': 'false' } },
        },
      ],
    };
    answer('GetBucketPolicyCommand', () => ({ Policy: JSON.stringify(stored) }));
    const read = await zeroDelays(new S3BucketPolicyProvider()).readCurrentState(
      'bkt',
      'Policy',
      'AWS::S3::BucketPolicy',
      { Bucket: 'bkt', PolicyDocument: declared },
      AFTER
    );
    expect(bag(read)['PolicyDocument']).toEqual(stored);
    expect(callsOf('GetBucketPolicyCommand')).toBe(1);
  });
});

describe('review round 1 (#6629)', () => {
  it('an inline policy under its declared name with the OLD document settles on a re-read', async () => {
    answer('GetRoleCommand', getRole());
    answer('ListRolePoliciesCommand', names('p'));
    answer(
      'GetRolePolicyCommand',
      () => ({ PolicyDocument: encoded(OLD_DOC) }),
      () => ({ PolicyDocument: encoded(DOC) })
    );
    const read = await role().readCurrentState(
      'r',
      'Role',
      'AWS::IAM::Role',
      { Policies: [{ PolicyName: 'p', PolicyDocument: DOC }] },
      AFTER
    );
    expect(bag(read)['Policies']).toEqual([{ PolicyName: 'p', PolicyDocument: DOC }]);
    expect(callsOf('GetRolePolicyCommand')).toBe(2);
    expect(unsettledWarnings()).toEqual([]);
  });

  it('an inline policy keeping the OLD document through the schedule is recorded as read, never merged', async () => {
    answer('GetRoleCommand', getRole());
    answer('ListRolePoliciesCommand', names('p'));
    answer('GetRolePolicyCommand', () => ({ PolicyDocument: encoded(OLD_DOC) }));
    const read = await role().readCurrentState(
      'r',
      'Role',
      'AWS::IAM::Role',
      { Policies: [{ PolicyName: 'p', PolicyDocument: DOC }] },
      AFTER
    );
    expect(bag(read)['Policies']).toEqual([{ PolicyName: 'p', PolicyDocument: OLD_DOC }]);
    expect(callsOf('GetRolePolicyCommand')).toBe(4);
    expect(unsettledWarnings()).toHaveLength(1);
  });

  it('a managed policy whose default version is still v1 settles once GetPolicy answers v2 (versions are immutable)', async () => {
    const MP = 'arn:aws:iam::111111111111:policy/mp';
    answer(
      'GetPolicyCommand',
      () => ({ Policy: { PolicyName: 'mp', DefaultVersionId: 'v1' } }),
      () => ({ Policy: { PolicyName: 'mp', DefaultVersionId: 'v1' } }),
      () => ({ Policy: { PolicyName: 'mp', DefaultVersionId: 'v2' } })
    );
    answer('GetPolicyVersionCommand', (input) => ({
      PolicyVersion: { Document: encoded(input['VersionId'] === 'v2' ? DOC : OLD_DOC) },
    }));
    const read = await zeroDelays(new IAMManagedPolicyProvider()).readCurrentState(
      MP,
      'Mp',
      'AWS::IAM::ManagedPolicy',
      { PolicyDocument: DOC },
      AFTER
    );
    expect(bag(read)['PolicyDocument']).toEqual(DOC);
    expect(callsOf('GetPolicyCommand')).toBe(3);
    expect(callsOf('GetPolicyVersionCommand')).toBe(3);
  });

  it('the managed policy Roles / Users / Groups re-reads share one ListEntitiesForPolicy per round', async () => {
    answer('GetPolicyCommand', () => ({ Policy: { PolicyName: 'mp' } }));
    answer('ListEntitiesForPolicyCommand', () => ({}));
    await zeroDelays(new IAMManagedPolicyProvider()).readCurrentState(
      'arn:aws:iam::111111111111:policy/mp',
      'Mp',
      'AWS::IAM::ManagedPolicy',
      { Roles: ['r1'], Users: ['u1'], Groups: ['g1'] },
      AFTER
    );
    expect(callsOf('ListEntitiesForPolicyCommand')).toBe(4);
    expect(unsettledWarnings()).toHaveLength(3);
  });

  it('an event bus gone during the post-write read is RESOURCE_NOT_FOUND after one call', async () => {
    answer('DescribeEventBusCommand', () => {
      throw new ResourceNotFoundException({ message: 'gone', $metadata: {} });
    });
    const read = await zeroDelays(new EventBridgeBusProvider()).readCurrentState(
      'bus',
      'Bus',
      'AWS::Events::EventBus',
      { Name: 'bus', Policy: DOC },
      AFTER
    );
    expect(typeof read).toBe('symbol');
    expect(callsOf('DescribeEventBusCommand')).toBe(1);
  });

  it('a declared bus Policy settles on read 1 beside a sibling EventBusPolicy statement', async () => {
    const declared = {
      Version: '2012-10-17',
      Statement: [{ Sid: 'mine', Effect: 'Allow', Principal: '*', Action: 'events:PutEvents', Resource: '*' }],
    };
    const live = {
      Version: '2012-10-17',
      Statement: [
        declared.Statement[0],
        { Sid: 'sibling', Effect: 'Allow', Principal: { AWS: ACCT }, Action: 'events:PutRule', Resource: '*' },
      ],
    };
    answer('DescribeEventBusCommand', () => ({ Name: 'bus', Policy: JSON.stringify(live) }));
    const read = await zeroDelays(new EventBridgeBusProvider()).readCurrentState(
      'bus',
      'Bus',
      'AWS::Events::EventBus',
      { Name: 'bus', Policy: declared },
      AFTER
    );
    expect(bag(read)['Policy']).toEqual(live);
    expect(callsOf('DescribeEventBusCommand')).toBe(1);
    expect(unsettledWarnings()).toEqual([]);
  });

  it('an S3 GetBucketPolicy answer without a Policy is undefined after one call, no warning', async () => {
    answer('GetBucketPolicyCommand', () => ({}));
    const read = await zeroDelays(new S3BucketPolicyProvider()).readCurrentState(
      'bkt',
      'Policy',
      'AWS::S3::BucketPolicy',
      { Bucket: 'bkt', PolicyDocument: DOC },
      AFTER
    );
    expect(read).toBeUndefined();
    expect(callsOf('GetBucketPolicyCommand')).toBe(1);
    expect(unsettledWarnings()).toEqual([]);
  });

  it.each([
    ['AWS::IAM::Role', 'RoleLid', () => role().readCurrentState('r', 'RoleLid', 'AWS::IAM::Role', { ManagedPolicyArns: [ARN_A] }, AFTER), { GetRoleCommand: getRole(), ListAttachedRolePoliciesCommand: attached() }],
    ['AWS::IAM::User', 'UserLid', () => userGroup().readCurrentState('u', 'UserLid', 'AWS::IAM::User', { ManagedPolicyArns: [ARN_A] }, AFTER), { GetUserCommand: () => ({ User: { UserName: 'u' } }), ListAttachedUserPoliciesCommand: attached() }],
    ['AWS::IAM::Group', 'GroupLid', () => userGroup().readCurrentState('g', 'GroupLid', 'AWS::IAM::Group', { ManagedPolicyArns: [ARN_A] }, AFTER), { GetGroupCommand: () => ({ Group: { GroupName: 'g' } }), ListAttachedGroupPoliciesCommand: attached() }],
  ] as const)('the %s warning names the logical id', async (_type, lid, read, answers) => {
    for (const [command, value] of Object.entries(answers)) answer(command, value);
    await read();
    expect(unsettledWarnings()).toHaveLength(1);
    expect(unsettledWarnings()[0]).toContain(lid);
    expect(unsettledWarnings()[0]).not.toContain(' r:');
  });

  it('a role whose trust policy agrees and whose ARNs lag reads GetRole once', async () => {
    answer('GetRoleCommand', getRole());
    answer('ListAttachedRolePoliciesCommand', attached(), attached(ARN_A));
    const read = await role().readCurrentState(
      'r',
      'Role',
      'AWS::IAM::Role',
      { AssumeRolePolicyDocument: TRUST, ManagedPolicyArns: [ARN_A] },
      AFTER
    );
    expect(bag(read)['ManagedPolicyArns']).toEqual([ARN_A]);
    expect(callsOf('GetRoleCommand')).toBe(1);
    expect(callsOf('ListAttachedRolePoliciesCommand')).toBe(2);
  });

  // CFn-accepted spellings `sgRuleKey` cannot match: each must settle on read 1
  // and the recorded list must be the read, with no duplicate rule.
  it.each([
    [
      'all-traffic with FromPort / ToPort -1 (AWS drops the ports)',
      { CidrIp: '10.0.0.0/8', IpProtocol: '-1', FromPort: -1, ToPort: -1 },
      { IpProtocol: '-1', IpRanges: [{ CidrIp: '10.0.0.0/8' }] },
    ],
    [
      'all-traffic with a port range (AWS drops the ports)',
      { CidrIp: '10.0.0.0/8', IpProtocol: '-1', FromPort: 0, ToPort: 65535 },
      { IpProtocol: '-1', IpRanges: [{ CidrIp: '10.0.0.0/8' }] },
    ],
    [
      'string ports',
      { CidrIp: '10.0.0.0/8', IpProtocol: 'tcp', FromPort: '443', ToPort: '443' },
      { IpProtocol: 'tcp', FromPort: 443, ToPort: 443, IpRanges: [{ CidrIp: '10.0.0.0/8' }] },
    ],
    [
      "Description: ''",
      { CidrIp: '10.0.0.0/8', IpProtocol: 'tcp', FromPort: 443, ToPort: 443, Description: '' },
      { IpProtocol: 'tcp', FromPort: 443, ToPort: 443, IpRanges: [{ CidrIp: '10.0.0.0/8' }] },
    ],
    [
      'a peer by SourceSecurityGroupName (read back as its id and owner)',
      { IpProtocol: 'tcp', FromPort: 443, ToPort: 443, SourceSecurityGroupName: 'peer' },
      {
        IpProtocol: 'tcp',
        FromPort: 443,
        ToPort: 443,
        UserIdGroupPairs: [{ GroupId: 'sg-peer', UserId: ACCT }],
      },
    ],
  ])('a security group ingress rule declared with %s settles on read 1', async (_label, declared, permission) => {
    answer('DescribeSecurityGroupsCommand', sgAnswer([permission], []));
    const read = await readSg({ GroupDescription: 'd', SecurityGroupIngress: [declared] }, AFTER);
    expect(callsOf('DescribeSecurityGroupsCommand')).toBe(1);
    expect(unsettledWarnings()).toEqual([]);
    expect(bag(read)['SecurityGroupIngress']).toHaveLength(1);
  });

  it('a swapped security group rule past the schedule: the read one kept, the declared one added at its position, one warning', async () => {
    answer('DescribeSecurityGroupsCommand', sgAnswer([oldPermission], []));
    const read = await readSg({ GroupDescription: 'd', SecurityGroupIngress: [INGRESS] }, AFTER);
    expect(bag(read)['SecurityGroupIngress']).toEqual([
      INGRESS,
      { IpProtocol: 'tcp', FromPort: 22, ToPort: 22, CidrIp: '10.0.0.0/8' },
    ]);
    expect(unsettledWarnings()).toHaveLength(1);
  });

  it('a declared list [A, B] read as [B] every round records [A, B] (declared order, never at the tail)', async () => {
    answer('GetUserCommand', () => ({ User: { UserName: 'u' } }));
    answer('ListGroupsForUserCommand', () => ({ Groups: [{ GroupName: 'g2' }] }));
    const read = await userGroup().readCurrentState(
      'u',
      'User',
      'AWS::IAM::User',
      { Groups: ['g1', 'g2'] },
      AFTER
    );
    expect(bag(read)['Groups']).toEqual(['g1', 'g2']);
    expect(callsOf('ListGroupsForUserCommand')).toBe(4);
    expect(unsettledWarnings()).toHaveLength(1);
  });

  it('a swapped list entry past the schedule: the read one kept, the declared one added, one warning', async () => {
    answer('GetInstanceProfileCommand', () => ({
      InstanceProfile: { InstanceProfileName: 'ip', Roles: [{ RoleName: 'y' }] },
    }));
    const read = await zeroDelays(new IAMInstanceProfileProvider()).readCurrentState(
      'ip',
      'Profile',
      'AWS::IAM::InstanceProfile',
      { Roles: ['x'] },
      AFTER
    );
    expect(bag(read)['Roles']).toEqual(['x', 'y']);
    expect(unsettledWarnings()).toHaveLength(1);
  });

  it('a kept declared rule is recorded in the readback shape (-1 without ports, no empty Description, numeric ports)', async () => {
    answer('DescribeSecurityGroupsCommand', sgAnswer([], []));
    const read = await readSg(
      {
        GroupDescription: 'd',
        SecurityGroupIngress: [
          { CidrIp: '10.0.0.0/8', IpProtocol: '-1', FromPort: -1, ToPort: -1, Description: '' },
          { CidrIp: '10.1.0.0/16', IpProtocol: '6', FromPort: '443', ToPort: '443' },
          { IpProtocol: 'tcp', FromPort: 80, ToPort: 80, SourceSecurityGroupName: 'peer' },
        ],
      },
      AFTER
    );
    // The name-declared rule cannot be matched, so it is never added.
    expect(bag(read)['SecurityGroupIngress']).toEqual([
      { CidrIp: '10.0.0.0/8', IpProtocol: '-1' },
      { CidrIp: '10.1.0.0/16', IpProtocol: 'tcp', FromPort: 443, ToPort: 443 },
    ]);
  });

  it("a rule declared with IpProtocol '6' reading back as tcp settles on read 1", async () => {
    answer(
      'DescribeSecurityGroupsCommand',
      sgAnswer(
        [{ IpProtocol: 'tcp', FromPort: 443, ToPort: 443, IpRanges: [{ CidrIp: '10.0.0.0/8' }] }],
        []
      )
    );
    await readSg(
      {
        GroupDescription: 'd',
        SecurityGroupIngress: [{ CidrIp: '10.0.0.0/8', IpProtocol: '6', FromPort: 443, ToPort: 443 }],
      },
      AFTER
    );
    expect(callsOf('DescribeSecurityGroupsCommand')).toBe(1);
    expect(unsettledWarnings()).toEqual([]);
  });

  it('two identical declared rules against one read rule are not settled (multiset)', async () => {
    answer('DescribeSecurityGroupsCommand', sgAnswer([ingressPermission], []));
    await readSg({ GroupDescription: 'd', SecurityGroupIngress: [INGRESS, INGRESS] }, AFTER);
    expect(callsOf('DescribeSecurityGroupsCommand')).toBe(4);
  });

  it('a security group rule matched only by the settle key: the unsettled baseline is in the order a settled read reconciles to', async () => {
    const peer = { Description: 'p', FromPort: 443, IpProtocol: 'tcp', SourceSecurityGroupId: 'sg-peer', ToPort: 443 };
    const cidr = { CidrIp: '10.0.0.0/8', FromPort: 22, IpProtocol: 'tcp', ToPort: 22 };
    const peerPermission = {
      IpProtocol: 'tcp',
      FromPort: 443,
      ToPort: 443,
      UserIdGroupPairs: [{ GroupId: 'sg-peer', UserId: ACCT, Description: 'p' }],
    };
    const cidrPermission = { IpProtocol: 'tcp', FromPort: 22, ToPort: 22, IpRanges: [{ CidrIp: '10.0.0.0/8' }] };
    const properties = { GroupDescription: 'd', SecurityGroupIngress: [peer, cidr] };
    answer('DescribeSecurityGroupsCommand', sgAnswer([peerPermission], []));
    const captured = await readSg(properties, AFTER);
    expect(unsettledWarnings()).toHaveLength(1);
    answer('DescribeSecurityGroupsCommand', sgAnswer([peerPermission, cidrPermission], []));
    const settled = await readSg(properties, undefined);
    expect(bag(captured)['SecurityGroupIngress']).toEqual(bag(settled)['SecurityGroupIngress']);
  });

  it('a declared rule without IpProtocol is never recorded', async () => {
    answer('DescribeSecurityGroupsCommand', sgAnswer([], []));
    const read = await readSg(
      { GroupDescription: 'd', SecurityGroupIngress: [{ CidrIp: '10.0.0.0/8', FromPort: 22, ToPort: 22 }] },
      AFTER
    );
    expect(bag(read)['SecurityGroupIngress']).toEqual([]);
  });

  it('managed policy Roles declared [r2, r1], read by AWS as [r1, r2] with r1 lagging: the baseline compares equal to the settled read', async () => {
    const provider = zeroDelays(new IAMManagedPolicyProvider());
    const MP = 'arn:aws:iam::111111111111:policy/mp';
    const properties = { Roles: ['r2', 'r1'] };
    answer('GetPolicyCommand', () => ({ Policy: { PolicyName: 'mp' } }));
    answer('ListEntitiesForPolicyCommand', () => ({ PolicyRoles: [{ RoleName: 'r2' }] }));
    const captured = bag(await provider.readCurrentState(MP, 'Mp', 'AWS::IAM::ManagedPolicy', properties, AFTER));
    expect(unsettledWarnings()).toHaveLength(1);
    answer('ListEntitiesForPolicyCommand', () => ({
      PolicyRoles: [{ RoleName: 'r1' }, { RoleName: 'r2' }],
    }));
    const settled = bag(await provider.readCurrentState(MP, 'Mp', 'AWS::IAM::ManagedPolicy', properties, undefined));
    expect(captured['Roles']).toEqual(['r2', 'r1']);
    expect(settled['Roles']).toEqual(['r1', 'r2']);
    const compare = (unorderedPaths: string[]) =>
      calculateResourceDrift(captured, settled, { unorderedPaths }).filter((d) =>
        String((d as { path?: unknown }).path ?? (d as { propertyPath?: unknown }).propertyPath).startsWith('Roles')
      );
    expect(compare(provider.getDriftUnorderedPaths('AWS::IAM::ManagedPolicy'))).toEqual([]);
    expect(compare([]).length).toBeGreaterThan(0);
  });

  it('a user Groups declared [g2, g1], read as [g1, g2] with g1 lagging: the baseline compares equal to the settled read', async () => {
    const provider = userGroup();
    const properties = { Groups: ['g2', 'g1'] };
    answer('GetUserCommand', () => ({ User: { UserName: 'u' } }));
    answer('ListGroupsForUserCommand', () => ({ Groups: [{ GroupName: 'g2' }] }));
    const captured = bag(await provider.readCurrentState('u', 'User', 'AWS::IAM::User', properties, AFTER));
    answer('ListGroupsForUserCommand', () => ({ Groups: [{ GroupName: 'g1' }, { GroupName: 'g2' }] }));
    const settled = bag(await provider.readCurrentState('u', 'User', 'AWS::IAM::User', properties, undefined));
    const drifts = calculateResourceDrift(captured, settled, {
      unorderedPaths: provider.getDriftUnorderedPaths('AWS::IAM::User'),
    });
    expect(drifts).toEqual([]);
  });
});

// ─── The drift heal (fourth rule of preFixBaselineUncomparedDriftKeys) ─────
describe('heal: a member is skipped only while the live value is exactly the declared one', () => {
  // A baseline frozen before the write showed: the heal ignores what it holds.
  const STALE = { Stale: true };
  const heal = (type: string, properties: Record<string, unknown>, aws: Record<string, unknown>) =>
    preFixBaselineUncomparedDriftKeys(type, STALE, properties, aws);
  const DOC_C = {
    Version: '2012-10-17',
    Statement: [{ Action: 's3:ListBucket', Effect: 'Allow', Resource: 'arn:aws:s3:::c' }],
  };
  // The same document as IAM stores it: a one-element Action list folds to its scalar.
  const DOC_STORED = {
    Version: '2012-10-17',
    Statement: [{ Action: ['s3:GetObject'], Effect: 'Allow', Resource: 'arn:aws:s3:::b/*' }],
  };
  const pol = (PolicyName: string, PolicyDocument: unknown) => ({ PolicyName, PolicyDocument });

  interface HealCase {
    type: string;
    key: string;
    declared: unknown;
    /** Live values equal to the declared one (spelling and order aside). */
    same: unknown[];
    /** Live values that are not: superset, subset, swapped entry, other document. */
    differ: Array<[string, unknown]>;
  }
  const list = (a: string, b: string, c: string): Omit<HealCase, 'type' | 'key'> => ({
    declared: [a, b],
    same: [[a, b], [b, a]],
    differ: [
      ['superset', [a, b, c]],
      ['subset', [a]],
      ['swapped entry', [a, c]],
      ['empty', []],
    ],
  });
  const inline: Omit<HealCase, 'type' | 'key'> = {
    declared: [pol('p1', DOC), pol('p2', DOC_C)],
    same: [
      [pol('p1', DOC_STORED), pol('p2', DOC_C)],
      [pol('p2', DOC_C), pol('p1', DOC)],
    ],
    differ: [
      ['superset', [pol('p1', DOC), pol('p2', DOC_C), pol('p3', DOC)]],
      ['subset', [pol('p1', DOC)]],
      ['swapped entry', [pol('p1', DOC), pol('p3', DOC_C)]],
      ['other document', [pol('p1', DOC), pol('p2', OLD_DOC)]],
    ],
  };
  const doc: Omit<HealCase, 'type' | 'key'> = {
    declared: DOC,
    same: [DOC_STORED, JSON.stringify(DOC)],
    differ: [
      ['other document', OLD_DOC],
      ['extra statement', { ...DOC, Statement: [...DOC.Statement, ...DOC_C.Statement] }],
      ['none', undefined],
    ],
  };
  const boundary: Omit<HealCase, 'type' | 'key'> = {
    declared: BOUNDARY,
    same: [BOUNDARY],
    differ: [
      ['other boundary', `arn:aws:iam::${ACCT}:policy/other`],
      ['none set', ''],
    ],
  };
  const sgIn = (port: number, extra: Record<string, unknown> = {}) => ({
    CidrIp: '10.0.0.0/8',
    FromPort: port,
    IpProtocol: 'tcp',
    ToPort: port,
    ...extra,
  });
  const cases: HealCase[] = [
    { type: 'AWS::IAM::Role', key: 'AssumeRolePolicyDocument', ...doc },
    { type: 'AWS::IAM::Role', key: 'PermissionsBoundary', ...boundary },
    { type: 'AWS::IAM::Role', key: 'ManagedPolicyArns', ...list(ARN_A, ARN_B, ARN_OLD) },
    { type: 'AWS::IAM::Role', key: 'Policies', ...inline },
    { type: 'AWS::IAM::User', key: 'PermissionsBoundary', ...boundary },
    { type: 'AWS::IAM::User', key: 'ManagedPolicyArns', ...list(ARN_A, ARN_B, ARN_OLD) },
    { type: 'AWS::IAM::User', key: 'Groups', ...list('g1', 'g2', 'g3') },
    { type: 'AWS::IAM::User', key: 'Policies', ...inline },
    { type: 'AWS::IAM::Group', key: 'ManagedPolicyArns', ...list(ARN_A, ARN_B, ARN_OLD) },
    { type: 'AWS::IAM::Group', key: 'Policies', ...inline },
    { type: 'AWS::IAM::ManagedPolicy', key: 'PolicyDocument', ...doc },
    { type: 'AWS::IAM::ManagedPolicy', key: 'Roles', ...list('r1', 'r2', 'r3') },
    { type: 'AWS::IAM::ManagedPolicy', key: 'Users', ...list('u1', 'u2', 'u3') },
    { type: 'AWS::IAM::ManagedPolicy', key: 'Groups', ...list('g1', 'g2', 'g3') },
    { type: 'AWS::IAM::InstanceProfile', key: 'Roles', ...list('r1', 'r2', 'r3') },
    { type: 'AWS::S3::BucketPolicy', key: 'PolicyDocument', ...doc },
    { type: 'AWS::Events::EventBus', key: 'Policy', ...doc },
    {
      type: 'AWS::EC2::SecurityGroup',
      key: 'SecurityGroupIngress',
      // Declared as CFn accepts it; read back as EC2 answers (numeric ports, peer owner id).
      declared: [
        { ...sgIn(443), FromPort: '443', ToPort: '443', Description: '' },
        { IpProtocol: '6', FromPort: 80, ToPort: 80, SourceSecurityGroupId: 'sg-peer' },
      ],
      same: [
        [
          sgIn(443),
          {
            IpProtocol: 'tcp',
            FromPort: 80,
            ToPort: 80,
            SourceSecurityGroupId: 'sg-peer',
            SourceSecurityGroupOwnerId: ACCT,
          },
        ],
        [
          { IpProtocol: 'tcp', FromPort: 80, ToPort: 80, SourceSecurityGroupId: 'sg-peer' },
          sgIn(443),
        ],
      ],
      differ: [
        [
          'superset',
          [
            sgIn(443),
            { IpProtocol: 'tcp', FromPort: 80, ToPort: 80, SourceSecurityGroupId: 'sg-peer' },
            sgIn(22),
          ],
        ],
        ['subset', [sgIn(443)]],
        [
          'swapped entry',
          [sgIn(443), { IpProtocol: 'tcp', FromPort: 80, ToPort: 80, SourceSecurityGroupId: 'sg-x' }],
        ],
        [
          'other description',
          [
            sgIn(443, { Description: 'changed' }),
            { IpProtocol: 'tcp', FromPort: 80, ToPort: 80, SourceSecurityGroupId: 'sg-peer' },
          ],
        ],
      ],
    },
    {
      type: 'AWS::EC2::SecurityGroup',
      key: 'SecurityGroupEgress',
      declared: [{ ...EGRESS, FromPort: 0, ToPort: 65535 }],
      same: [[EGRESS]],
      differ: [
        ['superset', [EGRESS, { CidrIp: '10.0.0.0/8', IpProtocol: 'tcp', FromPort: 1, ToPort: 1 }]],
        ['subset', []],
        ['swapped entry', [{ ...EGRESS, CidrIp: '10.0.0.0/8' }]],
      ],
    },
  ];

  describe.each(cases)('$type $key', (c) => {
    const properties = { [c.key]: c.declared };
    it.each(c.same.map((v, i) => [i, v] as const))('live #%s equal to the declared value: skipped', (_i, live) => {
      expect(heal(c.type, properties, { [c.key]: live })).toEqual([c.key]);
    });
    it.each(c.differ)('live %s: compared', (_label, live) => {
      expect(heal(c.type, properties, { [c.key]: live })).toEqual([]);
    });
    it('undeclared: compared', () => {
      expect(heal(c.type, {}, { [c.key]: c.same[0] })).toEqual([]);
    });
  });

  it('each member of one resource heals on its own', () => {
    const properties = { AssumeRolePolicyDocument: DOC, ManagedPolicyArns: [ARN_A] };
    expect(
      heal('AWS::IAM::Role', properties, {
        AssumeRolePolicyDocument: DOC_STORED,
        ManagedPolicyArns: [ARN_A, ARN_OLD],
      })
    ).toEqual(['AssumeRolePolicyDocument']);
  });

  it('a rule declared by SourceSecurityGroupName alone keeps its list compared', () => {
    const declared = [
      sgIn(443),
      { IpProtocol: 'tcp', FromPort: 80, ToPort: 80, SourceSecurityGroupName: 'peer' },
    ];
    const live = [
      sgIn(443),
      { IpProtocol: 'tcp', FromPort: 80, ToPort: 80, SourceSecurityGroupId: 'sg-peer' },
    ];
    expect(
      heal('AWS::EC2::SecurityGroup', { SecurityGroupIngress: declared }, { SecurityGroupIngress: live })
    ).toEqual([]);
    // ...also when the live group lacks it.
    expect(
      heal(
        'AWS::EC2::SecurityGroup',
        { SecurityGroupIngress: declared },
        { SecurityGroupIngress: [sgIn(443)] }
      )
    ).toEqual([]);
  });

  it('a security group read through the provider heals against its declaration', async () => {
    answer('DescribeSecurityGroupsCommand', sgAnswer([ingressPermission], [cdkEgressPermission]));
    const properties = { SecurityGroupIngress: [INGRESS], SecurityGroupEgress: [EGRESS] };
    const live = bag(await readSg(properties));
    expect(heal('AWS::EC2::SecurityGroup', properties, live)).toEqual([
      'SecurityGroupIngress',
      'SecurityGroupEgress',
    ]);
    answer(
      'DescribeSecurityGroupsCommand',
      sgAnswer([ingressPermission, oldPermission], [cdkEgressPermission])
    );
    const added = bag(await readSg(properties));
    expect(heal('AWS::EC2::SecurityGroup', properties, added)).toEqual(['SecurityGroupEgress']);
  });

  it('residual: a managed policy whose live Roles hold a sibling attacher is compared', () => {
    expect(
      heal('AWS::IAM::ManagedPolicy', { Roles: ['declared'] }, { Roles: ['declared', 'attacher'] })
    ).toEqual([]);
  });

  it('residual: an event bus Policy holding a sibling EventBusPolicy statement is compared', () => {
    const sibling = { ...DOC, Statement: [...DOC.Statement, ...DOC_C.Statement] };
    expect(heal('AWS::Events::EventBus', { Policy: DOC }, { Policy: sibling })).toEqual([]);
  });
});
