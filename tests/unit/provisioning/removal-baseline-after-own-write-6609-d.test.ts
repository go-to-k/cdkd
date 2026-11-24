/**
 * go-to-k/cdkd#6609, slice D: an entry cdkd's own write just REMOVED (a
 * detached managed policy, a deleted inline policy, a group or role taken out,
 * a revoked security group rule, a deleted permissions boundary) holds the
 * baseline captured right after that write until no read shows it, and is
 * dropped from the baseline when one still does. Recorded as read, a stale
 * grant would equal a later out-of-band re-add of it, and drift would never
 * report that.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';

const mockSend = vi.fn();
const fakeClient = { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } };

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    iam: fakeClient,
    ec2: fakeClient,
    ec2SingleSend: fakeClient,
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
import { EC2Provider } from '../../../src/provisioning/providers/ec2-provider.js';
import type { ReadCurrentStateContext } from '../../../src/types/resource.js';
import type { ResourceState } from '../../../src/types/state.js';
import { withStackRecords } from '../../../src/deployment/stack-records-scope.js';
import {
  recordOwnWriteRemoval,
  takeOwnWriteRemovals,
} from '../../../src/provisioning/own-write-removals.js';
import { sgRemovalRuleKey } from '../../../src/provisioning/sg-own-write-rules.js';
import { calculateResourceDrift } from '../../../src/analyzer/drift-calculator.js';
import { preFixBaselineUncomparedDriftKeys } from '../../../src/cli/commands/drift/baseline-keys.js';
import { createMaskedLogSinks } from '../../../src/provisioning/masked-retry-logger.js';
import { NoSuchEntityException } from '@aws-sdk/client-iam';

const AFTER: ReadCurrentStateContext = { afterOwnWrite: true };
const ACCT = '111111111111';

/** Per SDK command name, the answers in order (the last one repeats); others answer `{}`. */
let script: Record<string, Array<(input: Record<string, unknown>) => unknown>> = {};
function answer(command: string, ...answers: Array<(input: Record<string, unknown>) => unknown>): void {
  script[command] = answers;
}
const callsOf = (command: string): number =>
  mockSend.mock.calls.filter((c) => (c[0] as object).constructor.name === command).length;
const inputsOf = (command: string): Array<Record<string, unknown>> =>
  mockSend.mock.calls
    .filter((c) => (c[0] as object).constructor.name === command)
    .map((c) => (c[0] as { input: Record<string, unknown> }).input);
const fail = (name: string, message = name) => () => {
  throw Object.assign(new Error(message), { name, $metadata: {} });
};

const NOTED: Array<[string, string]> = [];
const note = (type: string, id: string, key: string, identity: string): void => {
  NOTED.push([type, id]);
  recordOwnWriteRemoval(type, id, key, identity);
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
afterEach(() => {
  // Notes are process-wide: none may leak into the next test.
  for (const [type, id] of NOTED.splice(0)) takeOwnWriteRemovals(type, id);
  for (const type of TYPES) for (const id of IDS) takeOwnWriteRemovals(type, id);
});

function zeroDelays<T extends object>(provider: T): T {
  (provider as unknown as { ownWriteRereadDelaysMs: readonly number[] }).ownWriteRereadDelaysMs = [0, 0, 0];
  return provider;
}
type Read = Record<string, unknown> | symbol | undefined;
const bag = (read: unknown): Record<string, unknown> => read as Record<string, unknown>;
const encoded = (doc: unknown): string => encodeURIComponent(JSON.stringify(doc));

const DOC = {
  Version: '2012-10-17',
  Statement: [{ Action: 's3:GetObject', Effect: 'Allow', Resource: 'arn:aws:s3:::b/*' }],
};
const ARN_A = 'arn:aws:iam::aws:policy/ReadOnlyAccess';
const ARN_OLD = 'arn:aws:iam::aws:policy/AdministratorAccess';
const BOUNDARY = `arn:aws:iam::${ACCT}:policy/boundary`;
const MP_ARN = `arn:aws:iam::${ACCT}:policy/mp`;
const TYPES = [
  'AWS::IAM::Role',
  'AWS::IAM::User',
  'AWS::IAM::Group',
  'AWS::IAM::ManagedPolicy',
  'AWS::IAM::InstanceProfile',
  'AWS::EC2::SecurityGroup',
];
const IDS = ['r', 'u', 'g', MP_ARN, 'ip', 'sg-1'];

const role = () => zeroDelays(new IAMRoleProvider());
const userGroup = () => zeroDelays(new IAMUserGroupProvider());
const managedPolicy = () => zeroDelays(new IAMManagedPolicyProvider());
const profile = () => zeroDelays(new IAMInstanceProfileProvider());
const attached = (...arns: string[]) => () => ({ AttachedPolicies: arns.map((PolicyArn) => ({ PolicyArn })) });
const names = (...PolicyNames: string[]) => () => ({ PolicyNames });
const getRole = (extra: Record<string, unknown> = {}) => () => ({ Role: { RoleName: 'r', ...extra } });
const pol = (PolicyName: string) => ({ PolicyName, PolicyDocument: DOC });

// ─── Security group rules ──────────────────────────────────────────────────
const INGRESS = { CidrIp: '10.0.0.0/8', Description: 'https', FromPort: 443, IpProtocol: 'tcp', ToPort: 443 };
const ingressPermission = {
  IpProtocol: 'tcp',
  FromPort: 443,
  ToPort: 443,
  IpRanges: [{ CidrIp: '10.0.0.0/8', Description: 'https' }],
};
/** The rule the update revoked, as the template recorded it (CFn string ports). */
const OLD_INGRESS = { CidrIp: '10.0.0.0/8', Description: 'ssh', FromPort: '22', IpProtocol: 'tcp', ToPort: '22' };
/** The revoked rule as a stale read shows it, with ANOTHER description (a revoke ignores it). */
const oldPermission = {
  IpProtocol: 'tcp',
  FromPort: 22,
  ToPort: 22,
  IpRanges: [{ CidrIp: '10.0.0.0/8', Description: 'changed out of band' }],
};
const EGRESS = { CidrIp: '10.0.0.0/8', Description: 'out', FromPort: 443, IpProtocol: 'tcp', ToPort: 443 };
const egressPermission = {
  IpProtocol: 'tcp',
  FromPort: 443,
  ToPort: 443,
  IpRanges: [{ CidrIp: '10.0.0.0/8', Description: 'out' }],
};
/** The AWS-default allow-all egress a create revokes, as EC2 stores it. */
const allowAll = { IpProtocol: '-1', IpRanges: [{ CidrIp: '0.0.0.0/0' }] };
const sgAnswer = (ingress: unknown[], egress: unknown[]) => () => ({
  SecurityGroups: [
    { GroupId: 'sg-1', GroupName: 'g', Description: 'd', VpcId: 'vpc-1', IpPermissions: ingress, IpPermissionsEgress: egress },
  ],
});
const readSg = (p: Record<string, unknown>, c?: ReadCurrentStateContext) =>
  new EC2Provider().readCurrentState('sg-1', 'Sg', 'AWS::EC2::SecurityGroup', p, c);

/**
 * One list member a write can remove from: the declared bag, the read that
 * still shows the removed entry beside the declared ones (`stale`), the read
 * without it (`clean`), and what each records under `key`.
 */
interface Spec {
  name: string;
  type: string;
  id: string;
  key: string;
  removed: string;
  read: (properties: Record<string, unknown>, context?: ReadCurrentStateContext) => Promise<Read>;
  properties: Record<string, unknown>;
  /** The same bag declaring the removed entry again (the write put it back). */
  redeclared: Record<string, unknown>;
  /** The read showing `redeclared` (default: `stale`). */
  redeclaredRead?: () => unknown;
  /** The read already hides the removed entry once the template drops the key. */
  readHidesWhenUndeclared?: true;
  command: string;
  base?: Record<string, () => unknown>;
  stale: () => unknown;
  clean: () => unknown;
  /** The read that shows only the removed entry (the template dropped the whole key). */
  removedOnly: () => unknown;
  none: () => unknown;
  staleValue: unknown;
  cleanValue: unknown;
}

const ingressKey = sgRemovalRuleKey(OLD_INGRESS, 'ingress')!;
const allowAllKey = sgRemovalRuleKey({ IpProtocol: '-1', CidrIp: '0.0.0.0/0' }, 'egress')!;

const specs: Spec[] = [
  {
    name: 'AWS::IAM::Role ManagedPolicyArns',
    type: 'AWS::IAM::Role',
    id: 'r',
    key: 'ManagedPolicyArns',
    removed: ARN_OLD,
    read: (p, c) => role().readCurrentState('r', 'Role', 'AWS::IAM::Role', p, c),
    properties: { ManagedPolicyArns: [ARN_A] },
    redeclared: { ManagedPolicyArns: [ARN_A, ARN_OLD] },
    command: 'ListAttachedRolePoliciesCommand',
    base: { GetRoleCommand: getRole() },
    stale: attached(ARN_A, ARN_OLD),
    clean: attached(ARN_A),
    removedOnly: attached(ARN_OLD),
    none: attached(),
    staleValue: [ARN_A, ARN_OLD],
    cleanValue: [ARN_A],
  },
  {
    name: 'AWS::IAM::Role Policies',
    type: 'AWS::IAM::Role',
    id: 'r',
    key: 'Policies',
    removed: 'old',
    read: (p, c) => role().readCurrentState('r', 'Role', 'AWS::IAM::Role', p, c),
    properties: { Policies: [pol('p')] },
    redeclared: { Policies: [pol('p'), pol('old')] },
    command: 'ListRolePoliciesCommand',
    base: { GetRoleCommand: getRole(), GetRolePolicyCommand: () => ({ PolicyDocument: encoded(DOC) }) },
    stale: names('p', 'old'),
    clean: names('p'),
    removedOnly: names('old'),
    none: names(),
    staleValue: [pol('p'), pol('old')],
    cleanValue: [pol('p')],
  },
  {
    name: 'AWS::IAM::User ManagedPolicyArns',
    type: 'AWS::IAM::User',
    id: 'u',
    key: 'ManagedPolicyArns',
    removed: ARN_OLD,
    read: (p, c) => userGroup().readCurrentState('u', 'User', 'AWS::IAM::User', p, c),
    properties: { ManagedPolicyArns: [ARN_A] },
    redeclared: { ManagedPolicyArns: [ARN_A, ARN_OLD] },
    command: 'ListAttachedUserPoliciesCommand',
    base: { GetUserCommand: () => ({ User: { UserName: 'u' } }) },
    stale: attached(ARN_A, ARN_OLD),
    clean: attached(ARN_A),
    removedOnly: attached(ARN_OLD),
    none: attached(),
    staleValue: [ARN_A, ARN_OLD],
    cleanValue: [ARN_A],
  },
  {
    name: 'AWS::IAM::User Groups',
    type: 'AWS::IAM::User',
    id: 'u',
    key: 'Groups',
    removed: 'admins',
    read: (p, c) => userGroup().readCurrentState('u', 'User', 'AWS::IAM::User', p, c),
    properties: { Groups: ['g1'] },
    redeclared: { Groups: ['g1', 'admins'] },
    command: 'ListGroupsForUserCommand',
    base: { GetUserCommand: () => ({ User: { UserName: 'u' } }) },
    stale: () => ({ Groups: [{ GroupName: 'g1' }, { GroupName: 'admins' }] }),
    clean: () => ({ Groups: [{ GroupName: 'g1' }] }),
    removedOnly: () => ({ Groups: [{ GroupName: 'admins' }] }),
    none: () => ({ Groups: [] }),
    staleValue: ['g1', 'admins'],
    cleanValue: ['g1'],
  },
  {
    name: 'AWS::IAM::User Policies',
    type: 'AWS::IAM::User',
    id: 'u',
    key: 'Policies',
    removed: 'old',
    read: (p, c) => userGroup().readCurrentState('u', 'User', 'AWS::IAM::User', p, c),
    properties: { Policies: [pol('p')] },
    redeclared: { Policies: [pol('p'), pol('old')] },
    command: 'ListUserPoliciesCommand',
    base: {
      GetUserCommand: () => ({ User: { UserName: 'u' } }),
      GetUserPolicyCommand: () => ({ PolicyDocument: encoded(DOC) }),
    },
    stale: names('p', 'old'),
    clean: names('p'),
    removedOnly: names('old'),
    none: names(),
    staleValue: [pol('p'), pol('old')],
    cleanValue: [pol('p')],
  },
  {
    name: 'AWS::IAM::Group ManagedPolicyArns',
    type: 'AWS::IAM::Group',
    id: 'g',
    key: 'ManagedPolicyArns',
    removed: ARN_OLD,
    read: (p, c) => userGroup().readCurrentState('g', 'Group', 'AWS::IAM::Group', p, c),
    properties: { ManagedPolicyArns: [ARN_A] },
    redeclared: { ManagedPolicyArns: [ARN_A, ARN_OLD] },
    command: 'ListAttachedGroupPoliciesCommand',
    base: { GetGroupCommand: () => ({ Group: { GroupName: 'g' } }) },
    stale: attached(ARN_A, ARN_OLD),
    clean: attached(ARN_A),
    removedOnly: attached(ARN_OLD),
    none: attached(),
    staleValue: [ARN_A, ARN_OLD],
    cleanValue: [ARN_A],
  },
  {
    name: 'AWS::IAM::Group Policies',
    type: 'AWS::IAM::Group',
    id: 'g',
    key: 'Policies',
    removed: 'old',
    read: (p, c) => userGroup().readCurrentState('g', 'Group', 'AWS::IAM::Group', p, c),
    properties: { Policies: [pol('p')] },
    redeclared: { Policies: [pol('p'), pol('old')] },
    command: 'ListGroupPoliciesCommand',
    base: {
      GetGroupCommand: () => ({ Group: { GroupName: 'g' } }),
      GetGroupPolicyCommand: () => ({ PolicyDocument: encoded(DOC) }),
    },
    stale: names('p', 'old'),
    clean: names('p'),
    removedOnly: names('old'),
    none: names(),
    staleValue: [pol('p'), pol('old')],
    cleanValue: [pol('p')],
  },
  ...(['Roles', 'Groups', 'Users'] as const).map((key): Spec => {
    const field = { Roles: 'PolicyRoles', Groups: 'PolicyGroups', Users: 'PolicyUsers' }[key];
    const nameKey = { Roles: 'RoleName', Groups: 'GroupName', Users: 'UserName' }[key];
    const list = (...n: string[]) => () => ({ [field]: n.map((v) => ({ [nameKey]: v })) });
    return {
      name: `AWS::IAM::ManagedPolicy ${key}`,
      type: 'AWS::IAM::ManagedPolicy',
      id: MP_ARN,
      key,
      removed: 'gone',
      read: (p, c) => managedPolicy().readCurrentState(MP_ARN, 'Mp', 'AWS::IAM::ManagedPolicy', p, c),
      properties: { [key]: ['kept'] },
      redeclared: { [key]: ['kept', 'gone'] },
      command: 'ListEntitiesForPolicyCommand',
      base: { GetPolicyCommand: () => ({ Policy: { PolicyName: 'mp' } }) },
      stale: list('kept', 'gone'),
      clean: list('kept'),
      removedOnly: list('gone'),
      none: list(),
      staleValue: ['kept', 'gone'],
      cleanValue: ['kept'],
    };
  }),
  {
    name: 'AWS::IAM::InstanceProfile Roles',
    type: 'AWS::IAM::InstanceProfile',
    id: 'ip',
    key: 'Roles',
    removed: 'old',
    read: (p, c) => profile().readCurrentState('ip', 'Profile', 'AWS::IAM::InstanceProfile', p, c),
    properties: { Roles: ['r1'] },
    redeclared: { Roles: ['r1', 'old'] },
    command: 'GetInstanceProfileCommand',
    stale: () => ({ InstanceProfile: { InstanceProfileName: 'ip', Roles: [{ RoleName: 'r1' }, { RoleName: 'old' }] } }),
    clean: () => ({ InstanceProfile: { InstanceProfileName: 'ip', Roles: [{ RoleName: 'r1' }] } }),
    removedOnly: () => ({ InstanceProfile: { InstanceProfileName: 'ip', Roles: [{ RoleName: 'old' }] } }),
    none: () => ({ InstanceProfile: { InstanceProfileName: 'ip', Roles: [] } }),
    staleValue: ['r1', 'old'],
    cleanValue: ['r1'],
  },
  {
    name: 'AWS::EC2::SecurityGroup SecurityGroupIngress',
    type: 'AWS::EC2::SecurityGroup',
    id: 'sg-1',
    key: 'SecurityGroupIngress',
    removed: ingressKey,
    read: readSg,
    properties: { GroupDescription: 'd', SecurityGroupIngress: [INGRESS] },
    // Re-authorized by the same write with a new description: the removal key ignores it.
    redeclared: { GroupDescription: 'd', SecurityGroupIngress: [INGRESS, { ...OLD_INGRESS, Description: 'new' }] },
    redeclaredRead: sgAnswer(
      [ingressPermission, { ...oldPermission, IpRanges: [{ CidrIp: '10.0.0.0/8', Description: 'new' }] }],
      []
    ),
    command: 'DescribeSecurityGroupsCommand',
    stale: sgAnswer([ingressPermission, oldPermission], []),
    clean: sgAnswer([ingressPermission], []),
    removedOnly: sgAnswer([oldPermission], []),
    none: sgAnswer([], []),
    staleValue: [
      INGRESS,
      { IpProtocol: 'tcp', FromPort: 22, ToPort: 22, CidrIp: '10.0.0.0/8', Description: 'changed out of band' },
    ],
    cleanValue: [INGRESS],
  },
  {
    name: 'AWS::EC2::SecurityGroup SecurityGroupEgress',
    type: 'AWS::EC2::SecurityGroup',
    id: 'sg-1',
    key: 'SecurityGroupEgress',
    removed: allowAllKey,
    read: readSg,
    properties: { GroupDescription: 'd', SecurityGroupEgress: [EGRESS] },
    // CDK's own allow-all egress, re-authorized with its description after the revoke.
    redeclared: {
      GroupDescription: 'd',
      SecurityGroupEgress: [EGRESS, { CidrIp: '0.0.0.0/0', Description: 'Allow all', IpProtocol: '-1' }],
    },
    redeclaredRead: sgAnswer([], [egressPermission, { IpProtocol: '-1', IpRanges: [{ CidrIp: '0.0.0.0/0', Description: 'Allow all' }] }]),
    // With no egress declared, the read drops the AWS-default rule itself.
    readHidesWhenUndeclared: true,
    command: 'DescribeSecurityGroupsCommand',
    stale: sgAnswer([], [egressPermission, allowAll]),
    clean: sgAnswer([], [egressPermission]),
    removedOnly: sgAnswer([], [egressPermission, allowAll]),
    none: sgAnswer([], [egressPermission]),
    staleValue: [EGRESS, { IpProtocol: '-1', CidrIp: '0.0.0.0/0' }],
    cleanValue: [EGRESS],
  },
];

describe('AWS::IAM::User Groups: a removed group noted in another case than AWS spells it', () => {
  const spec = specs.find((s) => s.name === 'AWS::IAM::User Groups')!;

  it('still read in AWS spelling: re-read until gone, recorded without it', async () => {
    note(spec.type, spec.id, spec.key, 'Admins');
    answer('GetUserCommand', spec.base!['GetUserCommand']!);
    answer(spec.command, spec.stale, spec.clean);
    const read = bag(await spec.read(spec.properties, AFTER));
    expect(read[spec.key]).toEqual(spec.cleanValue);
    expect(callsOf(spec.command)).toBe(2);
  });

  it('declared again in another case: never waited on', async () => {
    note(spec.type, spec.id, spec.key, 'admins');
    answer('GetUserCommand', spec.base!['GetUserCommand']!);
    answer(spec.command, spec.stale);
    await spec.read({ Groups: ['g1', 'ADMINS'] }, AFTER);
    expect(callsOf(spec.command)).toBe(1);
  });
});

describe.each(specs)('$name: a removed entry on the capture', (spec) => {
  const setup = (...answers: Array<() => unknown>) => {
    for (const [command, base] of Object.entries(spec.base ?? {})) answer(command, base);
    answer(spec.command, ...answers);
  };

  it('still read on the first answer: re-read until gone, recorded without it, no warning', async () => {
    note(spec.type, spec.id, spec.key, spec.removed);
    setup(spec.stale, spec.clean);
    const read = bag(await spec.read(spec.properties, AFTER));
    expect(read[spec.key]).toEqual(spec.cleanValue);
    expect(callsOf(spec.command)).toBe(2);
    expect(unsettledWarnings()).toEqual([]);
  });

  it('still read after the schedule: dropped from the baseline, with one value-free warning', async () => {
    note(spec.type, spec.id, spec.key, spec.removed);
    setup(spec.stale);
    const read = bag(await spec.read(spec.properties, AFTER));
    expect(read[spec.key]).toEqual(spec.cleanValue);
    expect(callsOf(spec.command)).toBe(4);
    expect(unsettledWarnings()).toHaveLength(1);
    expect(unsettledWarnings()[0]).not.toContain(spec.removed);
  });

  it('gone on the first answer: no extra call', async () => {
    note(spec.type, spec.id, spec.key, spec.removed);
    setup(spec.clean);
    const read = bag(await spec.read(spec.properties, AFTER));
    expect(read[spec.key]).toEqual(spec.cleanValue);
    expect(callsOf(spec.command)).toBe(1);
  });

  it('no removal noted: an undeclared entry is taken as read, with no extra call', async () => {
    setup(spec.stale);
    const read = bag(await spec.read(spec.properties, AFTER));
    expect(read[spec.key]).toEqual(spec.staleValue);
    expect(callsOf(spec.command)).toBe(1);
  });

  it('a removed entry the template declares again (the write put it back) is never waited on', async () => {
    note(spec.type, spec.id, spec.key, spec.removed);
    setup(spec.redeclaredRead ?? spec.stale);
    await spec.read(spec.redeclared, AFTER);
    expect(callsOf(spec.command)).toBe(1);
    expect(unsettledWarnings()).toEqual([]);
  });

  it('outside the capture (drift): the note is neither consulted nor consumed', async () => {
    note(spec.type, spec.id, spec.key, spec.removed);
    setup(spec.stale);
    const read = bag(await spec.read(spec.properties, undefined));
    expect(read[spec.key]).toEqual(spec.staleValue);
    expect(callsOf(spec.command)).toBe(1);
    expect(takeOwnWriteRemovals(spec.type, spec.id)?.get(spec.key)).toEqual(new Set([spec.removed]));
  });

  it('the note is consumed by the one capture that takes it', async () => {
    note(spec.type, spec.id, spec.key, spec.removed);
    setup(spec.clean);
    await spec.read(spec.properties, AFTER);
    mockSend.mockClear();
    setup(spec.stale);
    await spec.read(spec.properties, AFTER);
    expect(callsOf(spec.command)).toBe(1);
  });

  describe.skipIf(spec.readHidesWhenUndeclared === true)('the template dropped the whole key', () => {
    const { [spec.key]: _dropped, ...withoutKey } = spec.properties;
    const empty = spec.key === 'SecurityGroupEgress' ? [EGRESS] : [];

    it('re-read until the removed entry is gone', async () => {
      note(spec.type, spec.id, spec.key, spec.removed);
      setup(spec.removedOnly, spec.none);
      const read = bag(await spec.read(withoutKey, AFTER));
      expect(read[spec.key]).toEqual(empty);
      expect(callsOf(spec.command)).toBe(2);
    });

    it('still read after the schedule: dropped, with one warning', async () => {
      note(spec.type, spec.id, spec.key, spec.removed);
      setup(spec.removedOnly);
      const read = bag(await spec.read(withoutKey, AFTER));
      expect(read[spec.key]).toEqual(empty);
      expect(unsettledWarnings()).toHaveLength(1);
    });

    it('no removal noted: no member is settled (one call)', async () => {
      setup(spec.removedOnly);
      await spec.read(withoutKey, AFTER);
      expect(callsOf(spec.command)).toBe(1);
    });
  });
});

describe.each([
  {
    name: 'AWS::IAM::Role PermissionsBoundary',
    type: 'AWS::IAM::Role',
    id: 'r',
    command: 'GetRoleCommand',
    read: (c?: ReadCurrentStateContext) => role().readCurrentState('r', 'Role', 'AWS::IAM::Role', {}, c),
    stale: getRole({ PermissionsBoundary: { PermissionsBoundaryArn: BOUNDARY } }),
    clean: getRole(),
  },
  {
    name: 'AWS::IAM::User PermissionsBoundary',
    type: 'AWS::IAM::User',
    id: 'u',
    command: 'GetUserCommand',
    read: (c?: ReadCurrentStateContext) => userGroup().readCurrentState('u', 'User', 'AWS::IAM::User', {}, c),
    stale: () => ({ User: { UserName: 'u', PermissionsBoundary: { PermissionsBoundaryArn: BOUNDARY } } }),
    clean: () => ({ User: { UserName: 'u' } }),
  },
])('$name deleted by the write', (spec) => {
  it('still read on the first answer: re-read until none', async () => {
    note(spec.type, spec.id, 'PermissionsBoundary', BOUNDARY);
    answer(spec.command, spec.stale, spec.clean);
    const read = bag(await spec.read(AFTER));
    expect(read['PermissionsBoundary']).toBe('');
    expect(callsOf(spec.command)).toBe(2);
  });

  it('still read after the schedule: recorded as none, with one warning', async () => {
    note(spec.type, spec.id, 'PermissionsBoundary', BOUNDARY);
    answer(spec.command, spec.stale);
    const read = bag(await spec.read(AFTER));
    expect(read['PermissionsBoundary']).toBe('');
    expect(unsettledWarnings()).toHaveLength(1);
    expect(unsettledWarnings()[0]).not.toContain(BOUNDARY);
  });

  it('no removal noted: the read boundary is taken as read', async () => {
    answer(spec.command, spec.stale);
    const read = bag(await spec.read(AFTER));
    expect(read['PermissionsBoundary']).toBe(BOUNDARY);
    expect(callsOf(spec.command)).toBe(1);
  });
});

describe('the capture takes the note before its first await', () => {
  it('a note recorded after the capture started (a rollback revert) is left for the next capture', async () => {
    note('AWS::IAM::Role', 'r', 'ManagedPolicyArns', ARN_OLD);
    answer('GetRoleCommand', getRole());
    answer('ListAttachedRolePoliciesCommand', attached(ARN_A));
    const pending = role().readCurrentState('r', 'Role', 'AWS::IAM::Role', { ManagedPolicyArns: [ARN_A] }, AFTER);
    // Synchronously after the call: the forward note is already taken.
    expect(takeOwnWriteRemovals('AWS::IAM::Role', 'r')).toBeUndefined();
    note('AWS::IAM::Role', 'r', 'ManagedPolicyArns', 'arn:aws:iam::aws:policy/Revert');
    await pending;
    expect(takeOwnWriteRemovals('AWS::IAM::Role', 'r')?.get('ManagedPolicyArns')).toEqual(
      new Set(['arn:aws:iam::aws:policy/Revert'])
    );
  });

  it("a stale capture meeting a revert's note is harmless: the revert removed only what that template declares", async () => {
    // The failed update attached ARN_B (declared); its revert detached it.
    const ARN_B = `arn:aws:iam::${ACCT}:policy/b`;
    note('AWS::IAM::Role', 'r', 'ManagedPolicyArns', ARN_B);
    answer('GetRoleCommand', getRole());
    answer('ListAttachedRolePoliciesCommand', attached(ARN_A, ARN_B));
    const read = bag(
      await role().readCurrentState('r', 'Role', 'AWS::IAM::Role', { ManagedPolicyArns: [ARN_A, ARN_B] }, AFTER)
    );
    expect(read['ManagedPolicyArns']).toEqual([ARN_A, ARN_B]);
    expect(callsOf('ListAttachedRolePoliciesCommand')).toBe(1);
  });

  it('a security group not found yet keeps its note for the retried read', async () => {
    note('AWS::EC2::SecurityGroup', 'sg-1', 'SecurityGroupEgress', allowAllKey);
    answer('DescribeSecurityGroupsCommand', () => ({ SecurityGroups: [] }), sgAnswer([], [egressPermission, allowAll]), sgAnswer([], [egressPermission]));
    const read = bag(await readSg({ GroupDescription: 'd', SecurityGroupEgress: [EGRESS] }, AFTER));
    expect(read['SecurityGroupEgress']).toEqual([EGRESS]);
  }, 20_000);
});

// ─── Where the notes come from ─────────────────────────────────────────────
const log = createMaskedLogSinks(childLogger as never, undefined);
const taken = (type: string, id: string) => takeOwnWriteRemovals(type, id);

describe('each removal call notes what it removed, once it succeeded', () => {
  it('a role: detached ARNs and deleted inline policy names; an attach or put notes nothing', async () => {
    const provider = role();
    await provider.updateManagedPolicies('r', [ARN_A], [ARN_OLD], log);
    await provider.updateInlinePolicies('r', [pol('p')], [pol('old')], log);
    const noted = taken('AWS::IAM::Role', 'r');
    expect(noted?.get('ManagedPolicyArns')).toEqual(new Set([ARN_OLD]));
    expect(noted?.get('Policies')).toEqual(new Set(['old']));
    expect([...(noted?.keys() ?? [])].sort()).toEqual(['ManagedPolicyArns', 'Policies']);
  });

  it('a role: a detach that throws notes nothing', async () => {
    answer('DetachRolePolicyCommand', fail('ServiceFailure'));
    await expect(role().updateManagedPolicies('r', [], [ARN_OLD], log)).rejects.toThrow();
    expect(taken('AWS::IAM::Role', 'r')).toBeUndefined();
  });

  it('a role: an inline policy another resource claimed (#4225) is kept, so not noted', async () => {
    await role().updateInlinePolicies('r', [], [pol('claimed')], log, () => true);
    expect(callsOf('DeleteRolePolicyCommand')).toBe(0);
    expect(taken('AWS::IAM::Role', 'r')).toBeUndefined();
  });

  it('a role update clears a note an earlier update that threw left behind, and notes a deleted boundary', async () => {
    note('AWS::IAM::Role', 'r', 'ManagedPolicyArns', 'arn:aws:iam::aws:policy/Leftover');
    answer('GetRoleCommand', getRole({ Arn: `arn:aws:iam::${ACCT}:role/r`, RoleId: 'AROAEXAMPLE' }));
    await role().update(
      'Role',
      'r',
      'AWS::IAM::Role',
      { RoleName: 'r', AssumeRolePolicyDocument: DOC },
      { RoleName: 'r', AssumeRolePolicyDocument: DOC, PermissionsBoundary: BOUNDARY }
    );
    expect(callsOf('DeleteRolePermissionsBoundaryCommand')).toBe(1);
    const noted = taken('AWS::IAM::Role', 'r');
    expect(noted?.get('PermissionsBoundary')).toEqual(new Set([BOUNDARY]));
    expect(noted?.has('ManagedPolicyArns')).toBe(false);
  });

  it('a user: detached ARNs, groups left and deleted inline policies, a tolerated "not found" included', async () => {
    const provider = userGroup();
    answer('DetachUserPolicyCommand', () => {
      throw new NoSuchEntityException({ message: 'gone', $metadata: {} });
    });
    await provider.updateUserManagedPolicies('u', [], [ARN_OLD], log);
    await provider.updateUserGroups('u', ['g1'], ['g1', 'admins'], log);
    await provider.updateUserInlinePolicies('u', [], [pol('old')], log, undefined);
    const noted = taken('AWS::IAM::User', 'u');
    expect(noted?.get('ManagedPolicyArns')).toEqual(new Set([ARN_OLD]));
    expect(noted?.get('Groups')).toEqual(new Set(['admins']));
    expect(noted?.get('Policies')).toEqual(new Set(['old']));
  });

  it('a group: detached ARNs and deleted inline policies', async () => {
    const provider = userGroup();
    await provider.updateGroupManagedPolicies('g', [ARN_A], [ARN_A, ARN_OLD], log);
    await provider.updateGroupInlinePolicies('g', [], [pol('old')], log, undefined);
    const noted = taken('AWS::IAM::Group', 'g');
    expect(noted?.get('ManagedPolicyArns')).toEqual(new Set([ARN_OLD]));
    expect(noted?.get('Policies')).toEqual(new Set(['old']));
  });

  it('a managed policy: each principal it was detached from, by kind', async () => {
    await managedPolicy().updatePrincipals(MP_ARN, [], ['g'], ['kept'], ['kept', 'r'], [], ['u'], log);
    const noted = taken('AWS::IAM::ManagedPolicy', MP_ARN);
    expect(noted?.get('Groups')).toEqual(new Set(['g']));
    expect(noted?.get('Roles')).toEqual(new Set(['r']));
    expect(noted?.get('Users')).toEqual(new Set(['u']));
  });

  it('a managed policy update clears a leftover note before detaching', async () => {
    note('AWS::IAM::ManagedPolicy', MP_ARN, 'Roles', 'leftover');
    await managedPolicy().updatePrincipals(MP_ARN, [], [], [], [], [], [], log);
    expect(taken('AWS::IAM::ManagedPolicy', MP_ARN)).toBeUndefined();
  });

  it('an instance profile: the role taken out, after clearing a leftover note', async () => {
    note('AWS::IAM::InstanceProfile', 'ip', 'Roles', 'leftover');
    await profile().update('Profile', 'ip', 'AWS::IAM::InstanceProfile', { Roles: ['r1'] }, { Roles: ['old'] });
    expect(taken('AWS::IAM::InstanceProfile', 'ip')?.get('Roles')).toEqual(new Set(['old']));
  });

  describe('a security group', () => {
    const provider = () => new EC2Provider();

    it('a revoked rule, by the removal key a read rule matches (CFn string ports folded)', async () => {
      await provider().applySecurityGroupRuleDiff('sg-1', [INGRESS, OLD_INGRESS], [INGRESS], 'ingress', 'Sg');
      expect(callsOf('RevokeSecurityGroupIngressCommand')).toBe(1);
      expect(taken('AWS::EC2::SecurityGroup', 'sg-1')?.get('SecurityGroupIngress')).toEqual(new Set([ingressKey]));
    });

    it('the capture right after waits for exactly that rule', async () => {
      await provider().applySecurityGroupRuleDiff('sg-1', [INGRESS, OLD_INGRESS], [INGRESS], 'ingress', 'Sg');
      answer('DescribeSecurityGroupsCommand', sgAnswer([ingressPermission, oldPermission], []), sgAnswer([ingressPermission], []));
      const read = bag(await readSg({ GroupDescription: 'd', SecurityGroupIngress: [INGRESS] }, AFTER));
      expect(read['SecurityGroupIngress']).toEqual([INGRESS]);
      expect(callsOf('DescribeSecurityGroupsCommand')).toBe(2);
    });

    it('a revoke "not found" tolerated is noted; one that throws otherwise is not', async () => {
      answer('RevokeSecurityGroupEgressCommand', fail('InvalidPermission.NotFound', 'The specified rule does not exist'));
      await provider().applySecurityGroupRuleDiff('sg-1', [EGRESS], [], 'egress', 'Sg');
      expect(taken('AWS::EC2::SecurityGroup', 'sg-1')?.get('SecurityGroupEgress')).toEqual(
        new Set([sgRemovalRuleKey(EGRESS, 'egress')])
      );
      answer('RevokeSecurityGroupEgressCommand', fail('UnauthorizedOperation'));
      await expect(provider().applySecurityGroupRuleDiff('sg-1', [EGRESS], [], 'egress', 'Sg')).rejects.toThrow();
      expect(taken('AWS::EC2::SecurityGroup', 'sg-1')).toBeUndefined();
    });

    it('an ingress rule a standalone record of the stack holds (#4492) is not revoked, so not noted', async () => {
      const standalone = {
        physicalId: 'sg-1|tcp|22|22',
        resourceType: 'AWS::EC2::SecurityGroupIngress',
        properties: { GroupId: 'sg-1', ...OLD_INGRESS },
        dependencies: [],
      } as unknown as ResourceState;
      const view = {
        live: () => [['Standalone', standalone] as const],
        survivors: () => [['Standalone', standalone] as const],
      };
      await withStackRecords(view as never, () =>
        provider().applySecurityGroupRuleDiff('sg-1', [INGRESS, OLD_INGRESS], [INGRESS], 'ingress', 'Sg')
      );
      expect(callsOf('RevokeSecurityGroupIngressCommand')).toBe(0);
      expect(taken('AWS::EC2::SecurityGroup', 'sg-1')).toBeUndefined();
    });

    it('a peer named by SourceSecurityGroupName alone is noted by the id the revoke answers', async () => {
      const named = { IpProtocol: 'tcp', FromPort: 443, ToPort: 443, SourceSecurityGroupName: 'peer' };
      answer('RevokeSecurityGroupIngressCommand', () => ({
        Return: true,
        RevokedSecurityGroupRules: [{ ReferencedGroupId: 'sg-peer' }],
      }));
      await provider().applySecurityGroupRuleDiff('sg-1', [named], [], 'ingress', 'Sg');
      const key = sgRemovalRuleKey({ IpProtocol: 'tcp', FromPort: 443, ToPort: 443, SourceSecurityGroupId: 'sg-peer' }, 'ingress');
      expect(taken('AWS::EC2::SecurityGroup', 'sg-1')?.get('SecurityGroupIngress')).toEqual(new Set([key]));
    });

    it('a peer named by SourceSecurityGroupName alone with no id answered is not noted', async () => {
      const named = { IpProtocol: 'tcp', FromPort: 443, ToPort: 443, SourceSecurityGroupName: 'peer' };
      answer('RevokeSecurityGroupIngressCommand', () => ({ Return: true }));
      await provider().applySecurityGroupRuleDiff('sg-1', [named], [], 'ingress', 'Sg');
      expect(taken('AWS::EC2::SecurityGroup', 'sg-1')).toBeUndefined();
    });

    it("a create's revoke of the AWS-default allow-all egress is noted", async () => {
      await provider().applyInlineEgress('sg-1', [EGRESS]);
      expect(inputsOf('RevokeSecurityGroupEgressCommand')[0]).toMatchObject({ GroupId: 'sg-1' });
      expect(taken('AWS::EC2::SecurityGroup', 'sg-1')?.get('SecurityGroupEgress')).toEqual(new Set([allowAllKey]));
    });

    it('an update clears a note an earlier update that threw left behind', async () => {
      note('AWS::EC2::SecurityGroup', 'sg-1', 'SecurityGroupIngress', 'leftover');
      await provider().update('Sg', 'sg-1', 'AWS::EC2::SecurityGroup', { GroupDescription: 'd' }, { GroupDescription: 'd' });
      expect(taken('AWS::EC2::SecurityGroup', 'sg-1')).toBeUndefined();
    });
  });
});

// ─── What drift then sees ──────────────────────────────────────────────────
describe('drift after an out-of-band re-add of a removed grant', () => {
  it('reports it against a baseline the stale read did not freeze', async () => {
    note('AWS::IAM::Role', 'r', 'ManagedPolicyArns', ARN_OLD);
    answer('GetRoleCommand', getRole());
    answer('ListAttachedRolePoliciesCommand', attached(ARN_A, ARN_OLD));
    const properties = { ManagedPolicyArns: [ARN_A] };
    const provider = role();
    const baseline = bag(await provider.readCurrentState('r', 'Role', 'AWS::IAM::Role', properties, AFTER));
    // Later, the grant is re-attached out of band.
    const live = bag(await provider.readCurrentState('r', 'Role', 'AWS::IAM::Role', properties, undefined));
    expect(live['ManagedPolicyArns']).toEqual([ARN_A, ARN_OLD]);
    // The strict heal does not skip a superset of the declared list.
    expect(preFixBaselineUncomparedDriftKeys('AWS::IAM::Role', baseline, properties, live)).not.toContain(
      'ManagedPolicyArns'
    );
    const drifts = calculateResourceDrift(baseline, live);
    expect(drifts.length).toBeGreaterThan(0);
  });
});

// ─── Round 1 review: a peer named by name, and every record site ───────────
describe('a declared ingress rule naming its peer by SourceSecurityGroupName alone', () => {
  const NAMED = { IpProtocol: 'tcp', FromPort: 443, ToPort: 443, SourceSecurityGroupName: 'peer', Description: 'by name' };
  const peerPermission = {
    IpProtocol: 'tcp',
    FromPort: 443,
    ToPort: 443,
    UserIdGroupPairs: [{ GroupId: 'sg-peer', UserId: ACCT, Description: 'by name' }],
  };
  const idKey = sgRemovalRuleKey({ IpProtocol: 'tcp', FromPort: '443', ToPort: '443', SourceSecurityGroupId: 'sg-peer' }, 'ingress')!;

  it('the same peer rule revoked in its id spelling and put back by name: settled at once, the declared rule kept', async () => {
    note('AWS::EC2::SecurityGroup', 'sg-1', 'SecurityGroupIngress', idKey);
    answer('DescribeSecurityGroupsCommand', sgAnswer([peerPermission], []));
    const read = bag(await readSg({ GroupDescription: 'd', SecurityGroupIngress: [NAMED] }, AFTER));
    expect(callsOf('DescribeSecurityGroupsCommand')).toBe(1);
    expect(read['SecurityGroupIngress']).toEqual([expect.objectContaining({ SourceSecurityGroupId: 'sg-peer', FromPort: 443 })]);
    expect(unsettledWarnings()).toEqual([]);
  });

  it('a revoked CIDR rule beside it is still waited on', async () => {
    note('AWS::EC2::SecurityGroup', 'sg-1', 'SecurityGroupIngress', ingressKey);
    answer('DescribeSecurityGroupsCommand', sgAnswer([peerPermission, oldPermission], []), sgAnswer([peerPermission], []));
    const read = bag(await readSg({ GroupDescription: 'd', SecurityGroupIngress: [NAMED] }, AFTER));
    expect(callsOf('DescribeSecurityGroupsCommand')).toBe(2);
    expect(read['SecurityGroupIngress']).toEqual([expect.objectContaining({ SourceSecurityGroupId: 'sg-peer' })]);
  });

  it('a revoked CIDR rule beside it still read after the schedule is dropped; the peer rule is kept', async () => {
    note('AWS::EC2::SecurityGroup', 'sg-1', 'SecurityGroupIngress', ingressKey);
    note('AWS::EC2::SecurityGroup', 'sg-1', 'SecurityGroupIngress', idKey);
    answer('DescribeSecurityGroupsCommand', sgAnswer([peerPermission, oldPermission], []));
    const read = bag(await readSg({ GroupDescription: 'd', SecurityGroupIngress: [NAMED] }, AFTER));
    expect(read['SecurityGroupIngress']).toEqual([expect.objectContaining({ SourceSecurityGroupId: 'sg-peer' })]);
    expect(unsettledWarnings()).toHaveLength(1);
  });

  it('a revoked peer-group rule on OTHER ports is still waited on, and dropped when still read', async () => {
    const otherKey = sgRemovalRuleKey({ IpProtocol: 'tcp', FromPort: 22, ToPort: 22, SourceSecurityGroupId: 'sg-2' }, 'ingress')!;
    const other = { IpProtocol: 'tcp', FromPort: 22, ToPort: 22, UserIdGroupPairs: [{ GroupId: 'sg-2', UserId: ACCT }] };
    note('AWS::EC2::SecurityGroup', 'sg-1', 'SecurityGroupIngress', otherKey);
    answer('DescribeSecurityGroupsCommand', sgAnswer([peerPermission, other], []));
    const read = bag(await readSg({ GroupDescription: 'd', SecurityGroupIngress: [NAMED] }, AFTER));
    expect(callsOf('DescribeSecurityGroupsCommand')).toBe(4);
    expect(read['SecurityGroupIngress']).toEqual([expect.objectContaining({ SourceSecurityGroupId: 'sg-peer' })]);
  });

  it('a revoked peer-group rule on the same ports but another protocol (udp 443) is still waited on, and dropped when still read', async () => {
    const udpKey = sgRemovalRuleKey({ IpProtocol: 'udp', FromPort: 443, ToPort: 443, SourceSecurityGroupId: 'sg-2' }, 'ingress')!;
    const udp = { IpProtocol: 'udp', FromPort: 443, ToPort: 443, UserIdGroupPairs: [{ GroupId: 'sg-2', UserId: ACCT }] };
    note('AWS::EC2::SecurityGroup', 'sg-1', 'SecurityGroupIngress', udpKey);
    answer('DescribeSecurityGroupsCommand', sgAnswer([peerPermission, udp], []));
    const read = bag(await readSg({ GroupDescription: 'd', SecurityGroupIngress: [NAMED] }, AFTER));
    expect(callsOf('DescribeSecurityGroupsCommand')).toBe(4);
    expect(read['SecurityGroupIngress']).toEqual([expect.objectContaining({ SourceSecurityGroupId: 'sg-peer' })]);
  });

  it("a revoked peer-group rule on the same ports in a string-port spelling ('443') is not waited on", async () => {
    // The same peer the read shows, so only the exemption keeps it from being waited on.
    const stringKey = sgRemovalRuleKey({ IpProtocol: '6', FromPort: '443', ToPort: '443', SourceSecurityGroupId: 'sg-peer' }, 'ingress')!;
    note('AWS::EC2::SecurityGroup', 'sg-1', 'SecurityGroupIngress', stringKey);
    answer('DescribeSecurityGroupsCommand', sgAnswer([peerPermission], []));
    // Declared in a spelling of its own too ('6', string ports): both sides fold.
    const declared = { ...NAMED, IpProtocol: '6', FromPort: '443', ToPort: '443' };
    const read = bag(await readSg({ GroupDescription: 'd', SecurityGroupIngress: [declared] }, AFTER));
    expect(callsOf('DescribeSecurityGroupsCommand')).toBe(1);
    expect(read['SecurityGroupIngress']).toHaveLength(1);
  });

  it('an all-traffic name-only rule exempts a revoked all-traffic peer-group rule', async () => {
    // CFn accepts ports on an all-traffic rule; AWS drops them, and so does the key.
    const all = { IpProtocol: '-1', FromPort: -1, ToPort: -1, SourceSecurityGroupName: 'peer' };
    const allKey = sgRemovalRuleKey({ IpProtocol: '-1', SourceSecurityGroupId: 'sg-peer' }, 'ingress')!;
    note('AWS::EC2::SecurityGroup', 'sg-1', 'SecurityGroupIngress', allKey);
    answer('DescribeSecurityGroupsCommand', sgAnswer([{ IpProtocol: '-1', UserIdGroupPairs: [{ GroupId: 'sg-peer', UserId: ACCT }] }], []));
    await readSg({ GroupDescription: 'd', SecurityGroupIngress: [all] }, AFTER);
    expect(callsOf('DescribeSecurityGroupsCommand')).toBe(1);
  });

  it('with no name-only rule declared, a revoked peer-group rule is still waited on', async () => {
    note('AWS::EC2::SecurityGroup', 'sg-1', 'SecurityGroupIngress', idKey);
    answer('DescribeSecurityGroupsCommand', sgAnswer([ingressPermission, peerPermission], []), sgAnswer([ingressPermission], []));
    await readSg({ GroupDescription: 'd', SecurityGroupIngress: [INGRESS] }, AFTER);
    expect(callsOf('DescribeSecurityGroupsCommand')).toBe(2);
  });
});

const boom = fail('ServiceFailure');
/** Each record site: the call it follows, and how to make the write that removes one entry. */
const recordSites: Array<{
  name: string;
  type: string;
  id: string;
  key: string;
  identity: string;
  command: string;
  write: () => Promise<unknown>;
}> = [
  { name: 'role ManagedPolicyArns', type: 'AWS::IAM::Role', id: 'r', key: 'ManagedPolicyArns', identity: ARN_OLD, command: 'DetachRolePolicyCommand', write: () => role().updateManagedPolicies('r', [], [ARN_OLD], log) },
  { name: 'role Policies', type: 'AWS::IAM::Role', id: 'r', key: 'Policies', identity: 'old', command: 'DeleteRolePolicyCommand', write: () => role().updateInlinePolicies('r', [], [pol('old')], log) },
  {
    name: 'role PermissionsBoundary',
    type: 'AWS::IAM::Role',
    id: 'r',
    key: 'PermissionsBoundary',
    identity: BOUNDARY,
    command: 'DeleteRolePermissionsBoundaryCommand',
    write: () =>
      role().update('Role', 'r', 'AWS::IAM::Role', { RoleName: 'r', AssumeRolePolicyDocument: DOC }, { RoleName: 'r', AssumeRolePolicyDocument: DOC, PermissionsBoundary: BOUNDARY }),
  },
  { name: 'user ManagedPolicyArns', type: 'AWS::IAM::User', id: 'u', key: 'ManagedPolicyArns', identity: ARN_OLD, command: 'DetachUserPolicyCommand', write: () => userGroup().updateUserManagedPolicies('u', [], [ARN_OLD], log) },
  { name: 'user Groups', type: 'AWS::IAM::User', id: 'u', key: 'Groups', identity: 'admins', command: 'RemoveUserFromGroupCommand', write: () => userGroup().updateUserGroups('u', [], ['admins'], log) },
  { name: 'user Policies', type: 'AWS::IAM::User', id: 'u', key: 'Policies', identity: 'old', command: 'DeleteUserPolicyCommand', write: () => userGroup().updateUserInlinePolicies('u', [], [pol('old')], log, undefined) },
  {
    name: 'user PermissionsBoundary',
    type: 'AWS::IAM::User',
    id: 'u',
    key: 'PermissionsBoundary',
    identity: BOUNDARY,
    command: 'DeleteUserPermissionsBoundaryCommand',
    write: () => userGroup().update('User', 'u', 'AWS::IAM::User', { UserName: 'u' }, { UserName: 'u', PermissionsBoundary: BOUNDARY }),
  },
  { name: 'group ManagedPolicyArns', type: 'AWS::IAM::Group', id: 'g', key: 'ManagedPolicyArns', identity: ARN_OLD, command: 'DetachGroupPolicyCommand', write: () => userGroup().updateGroupManagedPolicies('g', [], [ARN_OLD], log) },
  { name: 'group Policies', type: 'AWS::IAM::Group', id: 'g', key: 'Policies', identity: 'old', command: 'DeleteGroupPolicyCommand', write: () => userGroup().updateGroupInlinePolicies('g', [], [pol('old')], log, undefined) },
  { name: 'managed policy Roles', type: 'AWS::IAM::ManagedPolicy', id: MP_ARN, key: 'Roles', identity: 'r', command: 'DetachRolePolicyCommand', write: () => managedPolicy().updatePrincipals(MP_ARN, [], [], [], ['r'], [], [], log) },
  { name: 'managed policy Groups', type: 'AWS::IAM::ManagedPolicy', id: MP_ARN, key: 'Groups', identity: 'g', command: 'DetachGroupPolicyCommand', write: () => managedPolicy().updatePrincipals(MP_ARN, [], ['g'], [], [], [], [], log) },
  { name: 'managed policy Users', type: 'AWS::IAM::ManagedPolicy', id: MP_ARN, key: 'Users', identity: 'u', command: 'DetachUserPolicyCommand', write: () => managedPolicy().updatePrincipals(MP_ARN, [], [], [], [], [], ['u'], log) },
  { name: 'instance profile Roles', type: 'AWS::IAM::InstanceProfile', id: 'ip', key: 'Roles', identity: 'old', command: 'RemoveRoleFromInstanceProfileCommand', write: () => profile().update('Profile', 'ip', 'AWS::IAM::InstanceProfile', { Roles: [] }, { Roles: ['old'] }) },
  { name: 'security group rule revoke', type: 'AWS::EC2::SecurityGroup', id: 'sg-1', key: 'SecurityGroupIngress', identity: ingressKey, command: 'RevokeSecurityGroupIngressCommand', write: () => new EC2Provider().applySecurityGroupRuleDiff('sg-1', [OLD_INGRESS], [], 'ingress', 'Sg') },
  { name: 'security group default egress revoke', type: 'AWS::EC2::SecurityGroup', id: 'sg-1', key: 'SecurityGroupEgress', identity: allowAllKey, command: 'RevokeSecurityGroupEgressCommand', write: () => new EC2Provider().applyInlineEgress('sg-1', [EGRESS]) },
];

describe.each(recordSites)('record site: $name', (site) => {
  it('a call that succeeds notes the removed entry', async () => {
    await site.write();
    expect(callsOf(site.command)).toBeGreaterThan(0);
    expect(taken(site.type, site.id)?.get(site.key)).toEqual(new Set([site.identity]));
  });

  it('a call that throws notes nothing', async () => {
    answer(site.command, boom);
    await expect(site.write()).rejects.toThrow();
    expect(taken(site.type, site.id)).toBeUndefined();
  });
});

describe('every update clears a note an earlier update that threw left behind', () => {
  it.each([
    ['user', 'AWS::IAM::User', 'u', () => userGroup().update('User', 'u', 'AWS::IAM::User', { UserName: 'u' }, { UserName: 'u' })],
    ['group', 'AWS::IAM::Group', 'g', () => userGroup().update('Group', 'g', 'AWS::IAM::Group', { GroupName: 'g' }, { GroupName: 'g' })],
    ['role', 'AWS::IAM::Role', 'r', () => role().update('Role', 'r', 'AWS::IAM::Role', { RoleName: 'r', AssumeRolePolicyDocument: DOC }, { RoleName: 'r', AssumeRolePolicyDocument: DOC })],
  ] as const)('%s', async (_kind, type, id, update) => {
    note(type, id, 'Policies', 'leftover');
    await update();
    expect(taken(type, id)).toBeUndefined();
  });
});

it("a create's default-egress revoke answered \"not found\" (no default rule) still notes it", async () => {
  answer('RevokeSecurityGroupEgressCommand', fail('InvalidPermission.NotFound', 'The specified rule does not exist'));
  await new EC2Provider().applyInlineEgress('sg-1', [EGRESS]);
  expect(taken('AWS::EC2::SecurityGroup', 'sg-1')?.get('SecurityGroupEgress')).toEqual(new Set([allowAllKey]));
});

describe.each([
  { name: 'user', type: 'AWS::IAM::User', id: 'u', read: () => userGroup().readCurrentState('u', 'User', 'AWS::IAM::User', {}, AFTER) },
  { name: 'group', type: 'AWS::IAM::Group', id: 'g', read: () => userGroup().readCurrentState('g', 'Group', 'AWS::IAM::Group', {}, AFTER) },
  { name: 'managed policy', type: 'AWS::IAM::ManagedPolicy', id: MP_ARN, read: () => managedPolicy().readCurrentState(MP_ARN, 'Mp', 'AWS::IAM::ManagedPolicy', {}, AFTER) },
  { name: 'instance profile', type: 'AWS::IAM::InstanceProfile', id: 'ip', read: () => profile().readCurrentState('ip', 'Profile', 'AWS::IAM::InstanceProfile', {}, AFTER) },
  {
    name: 'security group',
    type: 'AWS::EC2::SecurityGroup',
    id: 'sg-1',
    read: () => {
      answer('DescribeSecurityGroupsCommand', sgAnswer([], []));
      return readSg({ GroupDescription: 'd' }, AFTER);
    },
  },
])('the $name capture takes its note before its first await', (spec) => {
  it('a note recorded once the capture started is left for the next capture', async () => {
    note(spec.type, spec.id, 'Roles', 'forward');
    const pending = spec.read();
    expect(takeOwnWriteRemovals(spec.type, spec.id)).toBeUndefined();
    note(spec.type, spec.id, 'Roles', 'revert');
    await pending.catch(() => undefined);
    expect(takeOwnWriteRemovals(spec.type, spec.id)?.get('Roles')).toEqual(new Set(['revert']));
  });
});
