import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  AddRoleToInstanceProfileCommand,
  AttachGroupPolicyCommand,
  AttachRolePolicyCommand,
  CreateGroupCommand,
  CreateInstanceProfileCommand,
  CreatePolicyCommand,
  CreateRoleCommand,
  CreateUserCommand,
  AttachUserPolicyCommand,
  DeleteGroupCommand,
  DeleteInstanceProfileCommand,
  DeletePolicyCommand,
  DeleteRoleCommand,
  DeleteUserCommand,
  GetGroupCommand,
  GetInstanceProfileCommand,
  GetPolicyCommand,
  GetRoleCommand,
  GetUserCommand,
} from '@aws-sdk/client-iam';

const { mockSend, lines } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  lines: [] as string[],
}));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    iam: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
  }),
}));

vi.mock('../../../src/utils/logger.js', async (original) => {
  const logger: Record<string, unknown> = {};
  for (const level of ['debug', 'info', 'warn', 'error']) {
    logger[level] = (line: string) => lines.push(line);
  }
  logger['child'] = () => logger;
  return { ...(await original<object>()), getLogger: () => logger };
});

import { IAMUserGroupProvider } from '../../../src/provisioning/providers/iam-user-group-provider.js';
import { IAMInstanceProfileProvider } from '../../../src/provisioning/providers/iam-instance-profile-provider.js';
import { IAMManagedPolicyProvider } from '../../../src/provisioning/providers/iam-managed-policy-provider.js';
import { IAMRoleProvider } from '../../../src/provisioning/providers/iam-role-provider.js';
import {
  CreatedResourceSink,
  collectCreatedResources,
} from '../../../src/provisioning/created-resource-sink.js';

const LOGICAL_ID = 'Thing';
const SECRET = 'Sup3r_S3cret.Value';
const DOC = { Version: '2012-10-17', Statement: [] };
const POLICY_ARN = 'arn:aws:iam::aws:policy/A';
const maskSecrets = (text: string): string => text.split(SECRET).join('***');

const awsError = (name: string, status: number, message = `${name} from AWS`): Error =>
  Object.assign(new Error(message), {
    name,
    $fault: 'client',
    $metadata: { httpStatusCode: status },
  });

interface Provider {
  create: (
    id: string,
    type: string,
    properties: Record<string, unknown>,
    context: { maskSecrets: (text: string) => string }
  ) => Promise<unknown>;
}

const arnOf = (name: string): string => `arn:aws:iam::123456789012:policy/${name}`;

const TYPES = [
  {
    label: 'Role',
    type: 'AWS::IAM::Role',
    provider: () => new IAMRoleProvider() as unknown as Provider,
    properties: {
      RoleName: SECRET,
      AssumeRolePolicyDocument: DOC,
      ManagedPolicyArns: [POLICY_ARN],
    },
    create: CreateRoleCommand,
    answer: (id: string, name: string): unknown => ({ Role: { Arn: name, RoleId: id } }),
    wiring: AttachRolePolicyCommand,
    remove: DeleteRoleCommand,
    read: GetRoleCommand,
  },
  {
    label: 'User',
    type: 'AWS::IAM::User',
    provider: () => new IAMUserGroupProvider() as unknown as Provider,
    properties: { UserName: SECRET, ManagedPolicyArns: [POLICY_ARN] },
    create: CreateUserCommand,
    answer: (id: string, name: string): unknown => ({ User: { Arn: name, UserId: id } }),
    wiring: AttachUserPolicyCommand,
    remove: DeleteUserCommand,
    read: GetUserCommand,
  },
  {
    label: 'Group',
    type: 'AWS::IAM::Group',
    provider: () => new IAMUserGroupProvider() as unknown as Provider,
    properties: { GroupName: SECRET, ManagedPolicyArns: [POLICY_ARN] },
    create: CreateGroupCommand,
    answer: (id: string, name: string): unknown => ({ Group: { Arn: name, GroupId: id } }),
    wiring: AttachGroupPolicyCommand,
    remove: DeleteGroupCommand,
    read: GetGroupCommand,
  },
  {
    label: 'InstanceProfile',
    type: 'AWS::IAM::InstanceProfile',
    provider: () => new IAMInstanceProfileProvider() as unknown as Provider,
    properties: { InstanceProfileName: SECRET, Roles: ['r'] },
    create: CreateInstanceProfileCommand,
    answer: (id: string, name: string): unknown => ({
      InstanceProfile: { Arn: name, InstanceProfileId: id, Roles: [] },
    }),
    wiring: AddRoleToInstanceProfileCommand,
    remove: DeleteInstanceProfileCommand,
    read: GetInstanceProfileCommand,
  },
  {
    label: 'ManagedPolicy',
    type: 'AWS::IAM::ManagedPolicy',
    provider: () => new IAMManagedPolicyProvider() as unknown as Provider,
    properties: { ManagedPolicyName: SECRET, PolicyDocument: DOC, Roles: ['r'] },
    create: CreatePolicyCommand,
    answer: (id: string, name: string): unknown => ({
      Policy: { Arn: arnOf(name), PolicyId: id },
    }),
    wiring: AttachRolePolicyCommand,
    remove: DeletePolicyCommand,
    read: GetPolicyCommand,
  },
];

describe.each(TYPES)('$label: the replay lines mask a rewritten name (#5660)', (t) => {
  /**
   * Fails the first attempt as the issue does, replays once and answers the
   * identity read with `read`. Returns the name the provider derived: the
   * template's secret rewritten, which only the derived-name mask can match.
   */
  const replay = async (read: (name: string) => unknown): Promise<string> => {
    let name = '';
    let creates = 0;
    let wirings = 0;
    mockSend.mockImplementation(async (command: { constructor: unknown; input: object }) => {
      switch (command.constructor) {
        case t.create:
          creates += 1;
          if (creates > 1) throw awsError('EntityAlreadyExistsException', 409);
          name = String(
            Object.entries(command.input).find(([key]) => key.endsWith('Name'))?.[1] ?? ''
          );
          return t.answer('MINE', name);
        case t.wiring:
          wirings += 1;
          if (wirings === 1) throw awsError('Throttling', 400);
          return {};
        case t.remove:
          throw awsError('Throttling', 400);
        case t.read:
          return read(name);
        default:
          return {};
      }
    });
    const provider = t.provider();
    const run = () =>
      provider.create(LOGICAL_ID, t.type, t.properties, { maskSecrets }).catch(() => undefined);
    await collectCreatedResources(new CreatedResourceSink(LOGICAL_ID, t.type), async () => {
      await run();
      await run();
    });
    return name;
  };

  beforeEach(() => {
    mockSend.mockReset();
    lines.length = 0;
  });

  it.each([
    ['finishing', /finishing/, (name: string) => t.answer('MINE', name)],
    ['a foreign holder', /left untouched/, (name: string) => t.answer('FOREIGN', name)],
    [
      'a refused read',
      /to identify it/,
      (name: string) => {
        throw awsError('AccessDenied', 403, `denied on ${name}`);
      },
    ],
  ])('on %s', async (_, line, read) => {
    const name = await replay(read);
    expect(name).not.toBe(SECRET);
    const printed = lines.filter((candidate) => line.test(candidate));
    expect(printed).toHaveLength(1);
    expect(printed[0]).not.toContain(name);
    expect(printed[0]).not.toContain(SECRET);
  });
});
