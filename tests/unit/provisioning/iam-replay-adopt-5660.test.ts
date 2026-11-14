import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  AddRoleToInstanceProfileCommand,
  AddUserToGroupCommand,
  AttachGroupPolicyCommand,
  AttachRolePolicyCommand,
  AttachUserPolicyCommand,
  CreateGroupCommand,
  CreateInstanceProfileCommand,
  CreateLoginProfileCommand,
  CreatePolicyCommand,
  CreatePolicyVersionCommand,
  CreateUserCommand,
  DeleteGroupCommand,
  DeleteInstanceProfileCommand,
  DeleteLoginProfileCommand,
  DeletePolicyCommand,
  DeleteUserCommand,
  GetGroupCommand,
  GetInstanceProfileCommand,
  GetPolicyCommand,
  GetUserCommand,
  ListAttachedUserPoliciesCommand,
  ListEntitiesForPolicyCommand,
  ListPolicyVersionsCommand,
  PutGroupPolicyCommand,
  PutUserPermissionsBoundaryCommand,
  PutUserPolicyCommand,
  RemoveRoleFromInstanceProfileCommand,
  UpdateLoginProfileCommand,
} from '@aws-sdk/client-iam';

const { mockSend } = vi.hoisted(() => ({ mockSend: vi.fn() }));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    iam: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
  }),
}));

import { IAMUserGroupProvider } from '../../../src/provisioning/providers/iam-user-group-provider.js';
import { IAMInstanceProfileProvider } from '../../../src/provisioning/providers/iam-instance-profile-provider.js';
import { IAMManagedPolicyProvider } from '../../../src/provisioning/providers/iam-managed-policy-provider.js';
import {
  isRetryableTransientError,
  retryClassificationText,
} from '../../../src/deployment/retryable-errors.js';
import {
  CreatedResourceSink,
  collectCreatedResources,
} from '../../../src/provisioning/created-resource-sink.js';
import {
  createdBeforeFailure,
  createdResourceIdentityBeforeFailure,
} from '../../../src/provisioning/auxiliary-failure.js';

const LOGICAL_ID = 'Thing';
const NAME = 'explicit-name';
const MINE = 'AIDAMINE';
const FOREIGN = 'AIDAFOREIGN';
const POLICY_ARN = 'arn:aws:iam::aws:policy/A';
const DOC = { Version: '2012-10-17', Statement: [] };
const PASSWORD = 'correct-horse-battery-staple';
const CUSTOMER_ARN = `arn:aws:iam::123456789012:policy/team/${NAME}`;

const awsError = (name: string, httpStatusCode: number, message = `${name} from AWS`): Error =>
  Object.assign(new Error(message), {
    name,
    $fault: 'client',
    $metadata: { httpStatusCode },
  });
const throttling = (): Error => awsError('Throttling', 400);
const collision = (): Error => awsError('EntityAlreadyExistsException', 409);

type Answer = (input: Record<string, unknown>) => unknown;
type Answers = Map<unknown, Answer>;

const account = (answers: Answers): void => {
  mockSend.mockImplementation((command: { constructor: unknown; input: never }) => {
    const answer = answers.get(command.constructor);
    return Promise.resolve().then(() => (answer ? answer(command.input) : {}));
  });
};

const calls = (command: unknown): Array<Record<string, unknown>> =>
  mockSend.mock.calls
    .map(([sent]) => sent as { constructor: unknown; input: Record<string, unknown> })
    .filter((sent) => sent.constructor === command)
    .map((sent) => sent.input);

const sent = (): unknown[] => mockSend.mock.calls.map(([command]) => command.constructor);

interface TypeCase {
  label: string;
  type: string;
  provider: () => {
    create: (
      logicalId: string,
      type: string,
      properties: Record<string, unknown>
    ) => Promise<{ physicalId: string; attributes?: Record<string, unknown> }>;
  };
  properties: Record<string, unknown>;
  physicalId: string;
  createCommand: unknown;
  created: unknown;
  /** The wiring call the failed attempt loses to a throttle. */
  wiring: unknown;
  /** The delete the failed attempt's cleanup loses to a throttle. */
  deleteCommand: unknown;
  readCommand: unknown;
  readInput: Record<string, unknown>;
  live: (identity: string) => unknown;
  attributes: Record<string, unknown>;
  /** Writes an adopted replay must never send. */
  destructive: unknown[];
  /**
   * `readCommand` calls a FINISHED create makes after its wiring, to record
   * attributes the wiring moved (ManagedPolicy's `AttachmentCount`,
   * go-to-k/cdkd#6242). Not an adoption read.
   */
  attributeReads?: number;
}

const USER_ARN = `arn:aws:iam::1:user/${NAME}`;
const GROUP_ARN = `arn:aws:iam::1:group/${NAME}`;
const PROFILE_ARN = `arn:aws:iam::1:instance-profile/${NAME}`;

const TYPES: TypeCase[] = [
  {
    label: 'User',
    type: 'AWS::IAM::User',
    provider: () => new IAMUserGroupProvider(),
    properties: {
      UserName: NAME,
      PermissionsBoundary: POLICY_ARN,
      LoginProfile: { Password: PASSWORD, PasswordResetRequired: true },
      ManagedPolicyArns: [POLICY_ARN],
      Groups: ['g'],
      Policies: [{ PolicyName: 'inline', PolicyDocument: DOC }],
    },
    physicalId: NAME,
    createCommand: CreateUserCommand,
    created: { User: { Arn: USER_ARN, UserId: MINE } },
    wiring: AddUserToGroupCommand,
    deleteCommand: DeleteUserCommand,
    readCommand: GetUserCommand,
    readInput: { UserName: NAME },
    live: (UserId) => ({ User: { Arn: USER_ARN, UserId } }),
    attributes: { Arn: USER_ARN },
    destructive: [DeleteUserCommand, DeleteLoginProfileCommand],
  },
  {
    label: 'Group',
    type: 'AWS::IAM::Group',
    provider: () => new IAMUserGroupProvider(),
    properties: {
      GroupName: NAME,
      ManagedPolicyArns: [POLICY_ARN],
      Policies: [{ PolicyName: 'inline', PolicyDocument: DOC }],
    },
    physicalId: NAME,
    createCommand: CreateGroupCommand,
    created: { Group: { Arn: GROUP_ARN, GroupId: MINE } },
    wiring: AttachGroupPolicyCommand,
    deleteCommand: DeleteGroupCommand,
    readCommand: GetGroupCommand,
    readInput: { GroupName: NAME, MaxItems: 1 },
    live: (GroupId) => ({ Group: { Arn: GROUP_ARN, GroupId } }),
    attributes: { Arn: GROUP_ARN },
    destructive: [DeleteGroupCommand],
  },
  {
    label: 'InstanceProfile',
    type: 'AWS::IAM::InstanceProfile',
    provider: () => new IAMInstanceProfileProvider(),
    properties: { InstanceProfileName: NAME, Roles: ['r'] },
    physicalId: NAME,
    createCommand: CreateInstanceProfileCommand,
    created: { InstanceProfile: { Arn: PROFILE_ARN, InstanceProfileId: MINE } },
    wiring: AddRoleToInstanceProfileCommand,
    deleteCommand: DeleteInstanceProfileCommand,
    readCommand: GetInstanceProfileCommand,
    readInput: { InstanceProfileName: NAME },
    live: (InstanceProfileId) => ({
      InstanceProfile: { Arn: PROFILE_ARN, InstanceProfileId, Roles: [] },
    }),
    attributes: { Arn: PROFILE_ARN },
    destructive: [DeleteInstanceProfileCommand, RemoveRoleFromInstanceProfileCommand],
  },
  {
    label: 'ManagedPolicy',
    type: 'AWS::IAM::ManagedPolicy',
    provider: () => new IAMManagedPolicyProvider(),
    properties: {
      ManagedPolicyName: NAME,
      Path: '/team/',
      PolicyDocument: DOC,
      Roles: ['r'],
    },
    physicalId: CUSTOMER_ARN,
    createCommand: CreatePolicyCommand,
    created: { Policy: { Arn: CUSTOMER_ARN, PolicyId: MINE } },
    wiring: AttachRolePolicyCommand,
    deleteCommand: DeletePolicyCommand,
    readCommand: GetPolicyCommand,
    readInput: { PolicyArn: CUSTOMER_ARN },
    live: (PolicyId) => ({ Policy: { Arn: CUSTOMER_ARN, PolicyId } }),
    attributes: { PolicyArn: CUSTOMER_ARN, PolicyId: MINE },
    destructive: [DeletePolicyCommand, CreatePolicyVersionCommand],
    attributeReads: 1,
  },
];

/**
 * The issue's account: the first wiring call and the cleanup's delete are
 * throttled, and every later create collides with what the first one made.
 */
const failedAttempt = (t: TypeCase, overrides: [unknown, Answer][] = []): Answers => {
  let creates = 0;
  let wirings = 0;
  const answers: Answers = new Map<unknown, Answer>([
    [
      t.createCommand,
      () => {
        creates += 1;
        if (creates > 1) throw collision();
        return t.created;
      },
    ],
    [
      t.wiring,
      () => {
        wirings += 1;
        if (wirings === 1) throw throttling();
        return {};
      },
    ],
    [
      t.deleteCommand,
      () => {
        throw throttling();
      },
    ],
    [t.readCommand, () => t.live(MINE)],
    [ListAttachedUserPoliciesCommand, () => ({ AttachedPolicies: [] })],
    [ListEntitiesForPolicyCommand, () => ({})],
    [ListPolicyVersionsCommand, () => ({ Versions: [] })],
    ...overrides,
  ]);
  account(answers);
  return answers;
};

describe.each(TYPES)('$label: a replay colliding with its own leftover (#5660)', (t) => {
  let sink: CreatedResourceSink;
  const create = () => t.provider().create(LOGICAL_ID, t.type, t.properties);
  const inOperation = <T>(fn: () => Promise<T>): Promise<T> => collectCreatedResources(sink, fn);
  const failed = /Failed to create IAM/;

  beforeEach(() => {
    mockSend.mockReset();
    sink = new CreatedResourceSink(LOGICAL_ID, t.type);
  });

  it('finishes the entity the failed attempt made, re-running the wiring', async () => {
    failedAttempt(t);
    await inOperation(async () => {
      const first = await create().catch((e: unknown) => e);
      expect(String(first)).toMatch(failed);
      // A terminal first failure would never reach the replay under test.
      expect(isRetryableTransientError(first, retryClassificationText(first))).toBe(true);
      mockSend.mockClear();
      await expect(create()).resolves.toEqual({
        physicalId: t.physicalId,
        attributes: t.attributes,
      });
    });
    expect(calls(t.readCommand)).toEqual(
      Array.from({ length: 1 + (t.attributeReads ?? 0) }, () => t.readInput)
    );
    expect(calls(t.wiring)).toHaveLength(1);
    // An adopted entity is not reported again: a report means this attempt made it.
    expect((sink as unknown as { reports: unknown[] }).reports).toHaveLength(1);
    for (const command of t.destructive) expect(calls(command)).toEqual([]);
  });

  it('never touches a same-named entity with another identity', async () => {
    failedAttempt(t, [[t.readCommand, () => t.live(FOREIGN)]]);
    await inOperation(async () => {
      await expect(create()).rejects.toThrow(failed);
      mockSend.mockClear();
      await expect(create()).rejects.toThrow(/EntityAlreadyExists/);
    });
    expect(sent()).toEqual([t.createCommand, t.readCommand]);
  });

  it('claims nothing in a later operation, or outside one', async () => {
    failedAttempt(t);
    await inOperation(async () => {
      await expect(create()).rejects.toThrow(failed);
    });
    sink = new CreatedResourceSink(LOGICAL_ID, t.type);
    for (const run of [() => inOperation(create), create]) {
      mockSend.mockClear();
      await expect(run()).rejects.toThrow(/EntityAlreadyExists/);
      expect(sent()).toEqual([t.createCommand]);
    }
  });

  it('does not read when the report names another entity', async () => {
    failedAttempt(t);
    sink.record({ physicalId: `${t.physicalId}-other`, createdResourceIdentity: MINE });
    mockSend.mockImplementationOnce(() => Promise.reject(collision()));
    await inOperation(async () => {
      await expect(create()).rejects.toThrow(/EntityAlreadyExists/);
    });
    expect(sent()).toEqual([t.createCommand]);
  });

  it('needs the identity: a report without one proves nothing', async () => {
    failedAttempt(t);
    sink.record({ physicalId: t.physicalId });
    mockSend.mockImplementationOnce(() => Promise.reject(collision()));
    await inOperation(async () => {
      await expect(create()).rejects.toThrow(/EntityAlreadyExists/);
    });
    expect(sent()).toEqual([t.createCommand]);
  });

  it('adopts only on a collision', async () => {
    failedAttempt(t);
    sink.record({ physicalId: t.physicalId, createdResourceIdentity: MINE });
    mockSend.mockImplementationOnce(() => Promise.reject(awsError('LimitExceededException', 409)));
    await inOperation(async () => {
      await expect(create()).rejects.toThrow(/LimitExceeded/);
    });
    expect(sent()).toEqual([t.createCommand]);
  });

  it.each([
    ['throttled', throttling, /Throttling/],
    [
      'answered with a 5xx',
      () => Object.assign(awsError('ServiceFailureException', 500), { $fault: 'server' }),
      /ServiceFailure/,
    ],
  ])('rethrows with no write when the read is %s, then finishes', async (_, failure, shown) => {
    let reads = 0;
    failedAttempt(t, [
      [
        t.readCommand,
        () => {
          reads += 1;
          if (reads === 1) throw failure();
          return t.live(MINE);
        },
      ],
    ]);
    await inOperation(async () => {
      await expect(create()).rejects.toThrow(failed);
      mockSend.mockClear();
      const error = (await create().catch((e: unknown) => e)) as Error;
      expect(error.message).toMatch(shown);
      // What makes the engine retry, as `withRetry` asks it.
      expect(isRetryableTransientError(error, retryClassificationText(error))).toBe(true);
      expect(sent()).toEqual([t.createCommand, t.readCommand]);
      await expect(create()).resolves.toMatchObject({ physicalId: t.physicalId });
    });
  });

  it('fails with the collision and no write when the read is refused', async () => {
    failedAttempt(t, [
      [
        t.readCommand,
        () => {
          throw awsError('AccessDenied', 403);
        },
      ],
    ]);
    await inOperation(async () => {
      await expect(create()).rejects.toThrow(failed);
      mockSend.mockClear();
      await expect(create()).rejects.toThrow(/EntityAlreadyExists/);
    });
    expect(sent()).toEqual([t.createCommand, t.readCommand]);
  });

  it('strips nothing when the adopted wiring fails, stays marked, and a later replay finishes', async () => {
    let wirings = 0;
    failedAttempt(t, [
      [
        t.wiring,
        () => {
          wirings += 1;
          if (wirings <= 2) throw throttling();
          return {};
        },
      ],
    ]);
    await inOperation(async () => {
      await expect(create()).rejects.toThrow(failed);
      mockSend.mockClear();
      const error = await create().catch((e: unknown) => e);
      expect(createdBeforeFailure(error, LOGICAL_ID, t.type)).toBe(t.physicalId);
      expect(createdResourceIdentityBeforeFailure(error, LOGICAL_ID, t.type)).toBe(MINE);
      expect(sink.report).toEqual({ physicalId: t.physicalId, createdResourceIdentity: MINE });
      for (const command of t.destructive) expect(calls(command)).toEqual([]);
      await expect(create()).resolves.toMatchObject({ physicalId: t.physicalId });
    });
    for (const command of t.destructive) expect(calls(command)).toEqual([]);
    expect(calls(t.readCommand)).toHaveLength(2 + (t.attributeReads ?? 0));
  });
});

describe('the per-type wiring on an adopted entity (#5660)', () => {
  beforeEach(() => {
    mockSend.mockReset();
  });

  const user = TYPES[0]!;
  const profile = TYPES[2]!;
  const policy = TYPES[3]!;
  const replay = async (t: TypeCase): Promise<void> => {
    const sink = new CreatedResourceSink(LOGICAL_ID, t.type);
    await collectCreatedResources(sink, async () => {
      await t.provider().create(LOGICAL_ID, t.type, t.properties).catch(() => undefined);
      await t.provider().create(LOGICAL_ID, t.type, t.properties);
    });
  };

  describe('User', () => {
    const profileInput = { UserName: NAME, Password: PASSWORD, PasswordResetRequired: true };

    it('re-sends every wiring call on the adopted user', async () => {
      failedAttempt(user);
      await replay(user);
      expect(calls(PutUserPermissionsBoundaryCommand)).toHaveLength(2);
      expect(calls(AddUserToGroupCommand)).toHaveLength(2);
      expect(calls(PutUserPolicyCommand)).toHaveLength(1);
      expect(calls(AttachUserPolicyCommand)).toHaveLength(2);
    });

    it('sets the declared password when the earlier attempt left a login profile', async () => {
      let creates = 0;
      failedAttempt(user, [
        [
          // The cleanup stops here, so the attempt's login profile stays.
          DeleteLoginProfileCommand,
          () => {
            throw throttling();
          },
        ],
        [
          CreateLoginProfileCommand,
          () => {
            creates += 1;
            if (creates > 1) throw collision();
            return {};
          },
        ],
      ]);
      await replay(user);
      expect(calls(CreateLoginProfileCommand)).toEqual([profileInput, profileInput]);
      expect(calls(UpdateLoginProfileCommand)).toEqual([profileInput]);
    });

    it('creates again the profile the cleanup removed, without an update', async () => {
      failedAttempt(user);
      await replay(user);
      expect(calls(DeleteLoginProfileCommand)).toHaveLength(1);
      expect(calls(CreateLoginProfileCommand)).toEqual([profileInput, profileInput]);
      expect(calls(UpdateLoginProfileCommand)).toEqual([]);
    });

    const settling = (): Error =>
      awsError(
        'EntityTemporarilyUnmodifiableException',
        409,
        `Login Profile for User ${NAME} cannot be modified ${PASSWORD}`
      );

    it('restates a settling profile as retryable, and the next replay updates again', async () => {
      let creates = 0;
      let updates = 0;
      failedAttempt(user, [
        [
          DeleteLoginProfileCommand,
          () => {
            throw throttling();
          },
        ],
        [
          CreateLoginProfileCommand,
          () => {
            creates += 1;
            if (creates > 1) throw collision();
            return {};
          },
        ],
        [
          UpdateLoginProfileCommand,
          () => {
            updates += 1;
            if (updates === 1) throw settling();
            return {};
          },
        ],
      ]);
      const sink = new CreatedResourceSink(LOGICAL_ID, user.type);
      const run = () => user.provider().create(LOGICAL_ID, user.type, user.properties);
      await collectCreatedResources(sink, async () => {
        await run().catch(() => undefined);
        const error = (await run().catch((e: unknown) => e)) as Error;
        expect(isRetryableTransientError(error, retryClassificationText(error))).toBe(true);
        expect(error.message).not.toContain(PASSWORD);
        expect(error.message).not.toContain('cannot be modified');
        const causeNames: string[] = [];
        for (let e: unknown = error; e instanceof Error; e = e.cause) causeNames.push(e.name);
        expect(causeNames).toContain('EntityTemporarilyUnmodifiableException');
        expect(createdResourceIdentityBeforeFailure(error, LOGICAL_ID, user.type)).toBe(MINE);
        await expect(run()).resolves.toMatchObject({ physicalId: NAME });
      });
      expect(calls(UpdateLoginProfileCommand)).toEqual([profileInput, profileInput]);
      expect(calls(DeleteUserCommand)).toEqual([]); // That cleanup stopped at the login profile.
    });

    it('leaves that error unclassified on a create that adopted nothing', async () => {
      failedAttempt(user, [
        [
          CreateLoginProfileCommand,
          () => {
            throw settling();
          },
        ],
      ]);
      const error = (await user
        .provider()
        .create(LOGICAL_ID, user.type, user.properties)
        .catch((e: unknown) => e)) as Error;
      expect(isRetryableTransientError(error, retryClassificationText(error))).toBe(false);
      expect(error.message).not.toContain('concurrent update operation');
      expect(calls(UpdateLoginProfileCommand)).toEqual([]);
    });

    it('does not answer any other login profile failure with an update', async () => {
      let creates = 0;
      failedAttempt(user, [
        [
          CreateLoginProfileCommand,
          () => {
            creates += 1;
            if (creates > 1) throw awsError('PasswordPolicyViolationException', 400);
            return {};
          },
        ],
      ]);
      await expect(replay(user)).rejects.toThrow(/PasswordPolicyViolation/);
      expect(calls(UpdateLoginProfileCommand)).toEqual([]);
    });

    it('never updates a profile on a user it made in this attempt', async () => {
      failedAttempt(user, [
        [
          CreateLoginProfileCommand,
          () => {
            throw collision();
          },
        ],
      ]);
      await expect(
        user.provider().create(LOGICAL_ID, user.type, user.properties)
      ).rejects.toThrow(/Failed to create IAM user/);
      expect(calls(UpdateLoginProfileCommand)).toEqual([]);
    });

    it('surfaces a refused profile update without the password, stripping nothing', async () => {
      let creates = 0;
      failedAttempt(user, [
        [
          CreateLoginProfileCommand,
          () => {
            creates += 1;
            if (creates > 1) throw collision();
            return {};
          },
        ],
        [
          UpdateLoginProfileCommand,
          () => {
            throw awsError('PasswordPolicyViolationException', 400, `refused ${PASSWORD}`);
          },
        ],
      ]);
      const sink = new CreatedResourceSink(LOGICAL_ID, user.type);
      const error = await collectCreatedResources(sink, async () => {
        await user
          .provider()
          .create(LOGICAL_ID, user.type, user.properties)
          .catch(() => undefined);
        return user
          .provider()
          .create(LOGICAL_ID, user.type, user.properties)
          .catch((e: unknown) => e);
      });
      expect(String(error)).toMatch(/PasswordPolicyViolation/);
      expect(String(error)).not.toContain(PASSWORD);
      expect(calls(DeleteUserCommand)).toHaveLength(1); // The first attempt's cleanup alone.
    });
  });

  describe('Group', () => {
    it('re-sends the managed policies and the inline policies', async () => {
      const group = TYPES[1]!;
      failedAttempt(group);
      await replay(group);
      expect(calls(AttachGroupPolicyCommand)).toHaveLength(2);
      expect(calls(PutGroupPolicyCommand)).toEqual([
        { GroupName: NAME, PolicyName: 'inline', PolicyDocument: JSON.stringify(DOC) },
      ]);
    });
  });

  describe('InstanceProfile', () => {
    it('does not re-add the role the identity read shows on the profile', async () => {
      failedAttempt(profile, [
        [
          GetInstanceProfileCommand,
          () => ({
            InstanceProfile: {
              Arn: PROFILE_ARN,
              InstanceProfileId: MINE,
              Roles: [{ RoleName: 'r' }],
            },
          }),
        ],
      ]);
      await replay(profile);
      expect(calls(AddRoleToInstanceProfileCommand)).toHaveLength(1); // The failed attempt's.
    });

    it.each([
      ['r', 'R'],
      ['R', 'r'],
    ])('compares role names as IAM does: declared %s, held %s', async (declared, held) => {
      const cased = { ...profile, properties: { ...profile.properties, Roles: [declared] } };
      failedAttempt(cased, [
        [
          GetInstanceProfileCommand,
          () => ({
            InstanceProfile: {
              Arn: PROFILE_ARN,
              InstanceProfileId: MINE,
              Roles: [{ RoleName: held }],
            },
          }),
        ],
      ]);
      await replay(cased);
      expect(calls(AddRoleToInstanceProfileCommand)).toHaveLength(1); // The failed attempt's.
    });

    // Synthetic: a real profile holds one role, so this pins the loop, not an account.
    it('still adds the declared roles after one it skips', async () => {
      const two = { ...profile, properties: { ...profile.properties, Roles: ['held', 'r'] } };
      failedAttempt(two, [
        [
          GetInstanceProfileCommand,
          () => ({
            InstanceProfile: {
              Arn: PROFILE_ARN,
              InstanceProfileId: MINE,
              Roles: [{ RoleName: 'held' }],
            },
          }),
        ],
      ]);
      await replay(two);
      expect(calls(AddRoleToInstanceProfileCommand).at(-1)).toEqual({
        InstanceProfileName: NAME,
        RoleName: 'r',
      });
    });

    it('leaves a profile holding another role marked and untouched', async () => {
      let adds = 0;
      failedAttempt(profile, [
        [
          GetInstanceProfileCommand,
          () => ({
            InstanceProfile: {
              Arn: PROFILE_ARN,
              InstanceProfileId: MINE,
              Roles: [{ RoleName: 'other' }],
            },
          }),
        ],
        [
          AddRoleToInstanceProfileCommand,
          () => {
            adds += 1;
            throw adds === 1 ? throttling() : awsError('LimitExceededException', 409);
          },
        ],
      ]);
      const sink = new CreatedResourceSink(LOGICAL_ID, profile.type);
      const error = await collectCreatedResources(sink, async () => {
        const run = () => profile.provider().create(LOGICAL_ID, profile.type, profile.properties);
        await run().catch(() => undefined);
        return run().catch((e: unknown) => e);
      });
      expect(String(error)).toMatch(/LimitExceeded/);
      // The name is in the throttling table, so a stale read recovers on a retry.
      expect(isRetryableTransientError(error, retryClassificationText(error))).toBe(true);
      expect(createdResourceIdentityBeforeFailure(error, LOGICAL_ID, profile.type)).toBe(MINE);
      expect(calls(RemoveRoleFromInstanceProfileCommand)).toEqual([]);
      expect(calls(DeleteInstanceProfileCommand)).toHaveLength(1); // The failed attempt's.
    });
  });

  describe('ManagedPolicy', () => {
    it('never makes a policy version: the document came with CreatePolicy', async () => {
      failedAttempt(policy);
      await replay(policy);
      expect(calls(CreatePolicyVersionCommand)).toEqual([]);
      expect(calls(AttachRolePolicyCommand)).toHaveLength(2);
    });

    it('finishes a replacement inside update(), deleting only the old policy', async () => {
      const oldArn = 'arn:aws:iam::123456789012:policy/team/old-name';
      failedAttempt(policy, [
        [
          DeletePolicyCommand,
          (input) => {
            if (input['PolicyArn'] !== oldArn) throw throttling();
            return {};
          },
        ],
      ]);
      const rename = () =>
        new IAMManagedPolicyProvider().update(LOGICAL_ID, oldArn, policy.type, policy.properties, {
          ...policy.properties,
          ManagedPolicyName: 'old-name',
        });
      const sink = new CreatedResourceSink(LOGICAL_ID, policy.type);
      await collectCreatedResources(sink, async () => {
        await expect(rename()).rejects.toThrow(/Failed to create IAM/);
        mockSend.mockClear();
        const result = await rename();
        expect(result).toMatchObject({ physicalId: CUSTOMER_ARN, wasReplaced: true });
        expect(result.outcome).toBeUndefined(); // Not the partial arm of a failed old delete.
      });
      expect(calls(GetPolicyCommand)[0]).toEqual({ PolicyArn: CUSTOMER_ARN });
      expect(calls(DeletePolicyCommand)).toEqual([{ PolicyArn: oldArn }]);
    });

    it.each([
      ['another path', 'elsewhere/'],
      ['a path ending in the declared one', 'x/team/'],
    ])('treats the same name under %s as another policy', async (_, path) => {
      failedAttempt(policy);
      const sink = new CreatedResourceSink(LOGICAL_ID, policy.type);
      sink.record({
        physicalId: `arn:aws:iam::123456789012:policy/${path}${NAME}`,
        createdResourceIdentity: MINE,
      });
      mockSend.mockImplementationOnce(() => Promise.reject(collision()));
      await collectCreatedResources(sink, async () => {
        await expect(
          policy.provider().create(LOGICAL_ID, policy.type, policy.properties)
        ).rejects.toThrow(/EntityAlreadyExists/);
      });
      expect(calls(GetPolicyCommand)).toEqual([]);
    });

    it('names the create when a fresh policy answers with no ARN', async () => {
      failedAttempt(policy, [[CreatePolicyCommand, () => ({ Policy: { PolicyId: MINE } })]]);
      await expect(
        policy.provider().create(LOGICAL_ID, policy.type, policy.properties)
      ).rejects.toThrow(/CreatePolicy succeeded but no Arn/);
    });

    it('names the read when the adopted policy answers with no ARN', async () => {
      failedAttempt(policy, [[GetPolicyCommand, () => ({ Policy: { PolicyId: MINE } })]]);
      await expect(replay(policy)).rejects.toThrow(/GetPolicy succeeded but no Arn/);
      expect(calls(AttachRolePolicyCommand)).toHaveLength(1); // The failed attempt's.
    });

    it('reads the root path when none is declared', async () => {
      const arn = `arn:aws:iam::123456789012:policy/${NAME}`;
      const rooted: TypeCase = {
        ...policy,
        properties: { ManagedPolicyName: NAME, PolicyDocument: DOC, Roles: ['r'] },
        created: { Policy: { Arn: arn, PolicyId: MINE } },
        live: (PolicyId) => ({ Policy: { Arn: arn, PolicyId } }),
      };
      failedAttempt(rooted);
      await replay(rooted);
      // The adoption read, then the #6242 attribute read after the attach.
      expect(calls(GetPolicyCommand)).toEqual([{ PolicyArn: arn }, { PolicyArn: arn }]);
    });
  });
});
