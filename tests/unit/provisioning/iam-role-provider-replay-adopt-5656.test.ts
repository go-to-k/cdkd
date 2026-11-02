import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  AttachRolePolicyCommand,
  CreateRoleCommand,
  DeleteRoleCommand,
  DetachRolePolicyCommand,
  DeleteRolePolicyCommand,
  GetRoleCommand,
  ListAttachedRolePoliciesCommand,
  ListRolePoliciesCommand,
  PutRolePolicyCommand,
  TagRoleCommand,
} from '@aws-sdk/client-iam';

const { mockSend } = vi.hoisted(() => ({ mockSend: vi.fn() }));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    iam: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
  }),
}));

import { IAMRoleProvider } from '../../../src/provisioning/providers/iam-role-provider.js';
import {
  CreatedResourceSink,
  collectCreatedResources,
  reportCreatedResource,
  reportedCreatedResource,
  retractCreatedResource,
} from '../../../src/provisioning/created-resource-sink.js';

const TYPE = 'AWS::IAM::Role';
const LOGICAL_ID = 'MyRole';
const NAME = 'explicit-role';
const MINE = 'AROAMINE';
const POLICY_A = 'arn:aws:iam::aws:policy/A';
const POLICY_B = 'arn:aws:iam::aws:policy/B';

const properties = {
  RoleName: NAME,
  AssumeRolePolicyDocument: { Version: '2012-10-17', Statement: [] },
  ManagedPolicyArns: [POLICY_A, POLICY_B],
  Policies: [{ PolicyName: 'inline', PolicyDocument: { Version: '2012-10-17', Statement: [] } }],
  Tags: [{ Key: 'k', Value: 'v' }],
};

const awsError = (name: string, httpStatusCode: number): Error =>
  Object.assign(new Error(`${name} from AWS`), {
    name,
    $fault: 'client',
    $metadata: { httpStatusCode },
  });
const throttling = (): Error => awsError('Throttling', 400);
const collision = (): Error => awsError('EntityAlreadyExistsException', 409);

/** Answers by command, so a test states the account rather than a call order. */
const account = (answers: Map<unknown, (input: Record<string, unknown>) => unknown>): void => {
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

const failedAttempt = (extra?: [unknown, (i: Record<string, unknown>) => unknown][]) => {
  let creates = 0;
  let attaches = 0;
  account(
    new Map<unknown, (input: Record<string, unknown>) => unknown>([
      [
        CreateRoleCommand,
        () => {
          creates += 1;
          if (creates > 1) throw collision();
          return { Role: { Arn: `arn:aws:iam::1:role/${NAME}`, RoleId: MINE } };
        },
      ],
      [
        AttachRolePolicyCommand,
        () => {
          attaches += 1;
          // POLICY_A lands; POLICY_B is throttled on the failed attempt only.
          if (attaches === 2) throw throttling();
          return {};
        },
      ],
      [ListAttachedRolePoliciesCommand, () => ({ AttachedPolicies: [{ PolicyArn: POLICY_A }] })],
      [ListRolePoliciesCommand, () => ({ PolicyNames: [] })],
      [
        DeleteRoleCommand,
        () => {
          throw throttling();
        },
      ],
      [GetRoleCommand, () => ({ Role: { Arn: `arn:aws:iam::1:role/${NAME}`, RoleId: MINE } })],
      ...(extra ?? []),
    ])
  );
};

describe('IAMRoleProvider: a replay colliding with its own left-behind role (#5656)', () => {
  let provider: IAMRoleProvider;
  let sink: CreatedResourceSink;
  const inOperation = <T>(fn: () => Promise<T>): Promise<T> => collectCreatedResources(sink, fn);
  const create = () => provider.create(LOGICAL_ID, TYPE, properties);

  beforeEach(() => {
    mockSend.mockReset();
    provider = new IAMRoleProvider();
    sink = new CreatedResourceSink(LOGICAL_ID, TYPE);
  });

  it('finishes the role the failed attempt made, re-running all the wiring', async () => {
    failedAttempt();
    await inOperation(async () => {
      await expect(create()).rejects.toThrow(/Failed to create IAM role/);
      const result = await create();
      expect(result).toEqual({
        physicalId: NAME,
        attributes: { Arn: `arn:aws:iam::1:role/${NAME}`, RoleId: MINE },
      });
    });
    expect(calls(GetRoleCommand)).toEqual([{ RoleName: NAME }]);
    // The cleanup detached POLICY_A, so the replay's attach of it is what restores it.
    expect(calls(DetachRolePolicyCommand)).toEqual([{ RoleName: NAME, PolicyArn: POLICY_A }]);
    expect(calls(AttachRolePolicyCommand).slice(2)).toEqual([
      { RoleName: NAME, PolicyArn: POLICY_A },
      { RoleName: NAME, PolicyArn: POLICY_B },
    ]);
    expect(calls(PutRolePolicyCommand)).toHaveLength(1);
    expect(calls(TagRoleCommand)).toEqual([]);
    expect(calls(DeleteRoleCommand)).toHaveLength(1); // The failed attempt's cleanup alone.
  });

  it('never touches a same-named role with another RoleId', async () => {
    failedAttempt([[GetRoleCommand, () => ({ Role: { RoleId: 'AROAFOREIGN' } })]]);
    await inOperation(async () => {
      await expect(create()).rejects.toThrow(/Failed to create IAM role/);
      mockSend.mockClear();
      await expect(create()).rejects.toThrow(/EntityAlreadyExists/);
    });
    expect(mockSend.mock.calls.map(([sent]) => sent.constructor)).toEqual([
      CreateRoleCommand,
      GetRoleCommand,
    ]);
  });

  it('claims nothing when no attempt of this operation made the role (a later deploy)', async () => {
    failedAttempt();
    await inOperation(async () => {
      await expect(create()).rejects.toThrow(/Failed to create IAM role/);
    });
    // A new operation, a new sink; outside any operation reads the same.
    sink = new CreatedResourceSink(LOGICAL_ID, TYPE);
    for (const run of [() => inOperation(create), create]) {
      mockSend.mockClear();
      await expect(run()).rejects.toThrow(/EntityAlreadyExists/);
      expect(mockSend.mock.calls.map(([sent]) => sent.constructor)).toEqual([CreateRoleCommand]);
    }
  });

  it('does not read the role when the report names another role', async () => {
    failedAttempt();
    sink = new CreatedResourceSink(LOGICAL_ID, TYPE);
    sink.record({ physicalId: 'other-role', createdResourceIdentity: MINE });
    await inOperation(async () => {
      mockSend.mockImplementationOnce(() => Promise.reject(collision()));
      await expect(create()).rejects.toThrow(/EntityAlreadyExists/);
    });
    expect(calls(GetRoleCommand)).toEqual([]);
  });

  it('needs the RoleId: a report without one proves nothing', async () => {
    failedAttempt();
    sink.record({ physicalId: NAME });
    await inOperation(async () => {
      mockSend.mockImplementationOnce(() => Promise.reject(collision()));
      await expect(create()).rejects.toThrow(/EntityAlreadyExists/);
    });
    expect(calls(GetRoleCommand)).toEqual([]);
  });

  it('adopts only on a collision: any other CreateRole failure surfaces untouched', async () => {
    failedAttempt();
    sink.record({ physicalId: NAME, createdResourceIdentity: MINE });
    await inOperation(async () => {
      mockSend.mockImplementationOnce(() => Promise.reject(awsError('LimitExceededException', 409)));
      await expect(create()).rejects.toThrow(/LimitExceeded/);
    });
    expect(calls(GetRoleCommand)).toEqual([]);
  });

  it.each([
    ['throttled', throttling, /Throttling/],
    ['answered with a 5xx', () => awsError('ServiceFailure', 500), /ServiceFailure/],
  ])('leaves the proof standing when the identity read is %s', async (_, failure, shown) => {
    let reads = 0;
    failedAttempt([
      [
        GetRoleCommand,
        () => {
          reads += 1;
          if (reads === 1) throw failure();
          return { Role: { Arn: 'arn', RoleId: MINE } };
        },
      ],
    ]);
    await inOperation(async () => {
      await expect(create()).rejects.toThrow(/Failed to create IAM role/);
      mockSend.mockClear();
      await expect(create()).rejects.toThrow(shown);
      // No write on a read that could not answer.
      expect(mockSend.mock.calls.map(([sent]) => sent.constructor)).toEqual([
        CreateRoleCommand,
        GetRoleCommand,
      ]);
      await expect(create()).resolves.toMatchObject({ attributes: { RoleId: MINE } });
    });
  });

  it('fails with the collision when the identity read is refused', async () => {
    failedAttempt([
      [
        GetRoleCommand,
        () => {
          throw awsError('AccessDenied', 403);
        },
      ],
    ]);
    await inOperation(async () => {
      await expect(create()).rejects.toThrow(/Failed to create IAM role/);
      await expect(create()).rejects.toThrow(/EntityAlreadyExists/);
    });
    expect(calls(AttachRolePolicyCommand)).toHaveLength(2);
  });

  it('does not treat a role the cleanup deleted as left behind', async () => {
    let attaches = 0;
    let creates = 0;
    account(
      new Map<unknown, (input: Record<string, unknown>) => unknown>([
        [
          CreateRoleCommand,
          () => {
            creates += 1;
            if (creates === 2) throw collision(); // Someone took the freed name.
            return { Role: { RoleId: MINE } };
          },
        ],
        [
          AttachRolePolicyCommand,
          () => {
            attaches += 1;
            if (attaches === 1) throw throttling();
            return {};
          },
        ],
        [ListAttachedRolePoliciesCommand, () => ({ AttachedPolicies: [] })],
        [ListRolePoliciesCommand, () => ({ PolicyNames: [] })],
      ])
    );
    await inOperation(async () => {
      await expect(create()).rejects.toThrow(/Failed to create IAM role/);
      await expect(create()).rejects.toThrow(/EntityAlreadyExists/);
    });
    expect(calls(GetRoleCommand)).toEqual([]);
    expect(sink.report).toBeUndefined();
  });

  it('reads a retracted report as nothing, and only inside its own anchor', async () => {
    await inOperation(async () => {
      reportCreatedResource(LOGICAL_ID, TYPE, NAME, MINE);
      expect(reportedCreatedResource(LOGICAL_ID, TYPE)).toEqual({
        physicalId: NAME,
        createdResourceIdentity: MINE,
      });
      expect(reportedCreatedResource('Other', TYPE)).toBeUndefined();
      expect(reportedCreatedResource(LOGICAL_ID, 'AWS::IAM::User')).toBeUndefined();
      retractCreatedResource(LOGICAL_ID, TYPE, NAME);
      expect(reportedCreatedResource(LOGICAL_ID, TYPE)).toBeUndefined();
    });
    expect(reportedCreatedResource(LOGICAL_ID, TYPE)).toBeUndefined();
  });

  it('finishes a rename replay, deleting only the old role', async () => {
    failedAttempt();
    const rename = () =>
      provider.update(LOGICAL_ID, 'old-role', TYPE, properties, { ...properties, RoleName: 'old-role' });
    await inOperation(async () => {
      await expect(rename()).rejects.toThrow(/Failed to create IAM role/);
      mockSend.mockClear();
      await expect(rename()).resolves.toMatchObject({ physicalId: NAME, wasReplaced: true });
    });
    expect(calls(GetRoleCommand)[0]).toEqual({ RoleName: NAME });
    expect(calls(DeleteRoleCommand)).toEqual([{ RoleName: 'old-role' }]);
  });

  it('strips nothing from an adopted role whose wiring fails, and a later replay finishes it', async () => {
    let attaches = 0;
    failedAttempt([
      [
        AttachRolePolicyCommand,
        () => {
          attaches += 1;
          if (attaches === 2 || attaches === 3) throw throttling();
          return {};
        },
      ],
    ]);
    const { createdBeforeFailure, createdResourceIdentityBeforeFailure } = await import(
      '../../../src/provisioning/auxiliary-failure.js'
    );
    await inOperation(async () => {
      await expect(create()).rejects.toThrow(/Failed to create IAM role/);
      const error = await create().catch((e: unknown) => e);
      expect(createdBeforeFailure(error, LOGICAL_ID, TYPE)).toBe(NAME);
      expect(createdResourceIdentityBeforeFailure(error, LOGICAL_ID, TYPE)).toBe(MINE);
      expect(sink.report).toEqual({ physicalId: NAME, createdResourceIdentity: MINE });
      // The cleanup ran for the attempt that made the role, never for the adopted one.
      expect(calls(ListAttachedRolePoliciesCommand)).toHaveLength(1);
      expect(calls(DeleteRoleCommand)).toHaveLength(1);
      await expect(create()).resolves.toMatchObject({ attributes: { RoleId: MINE } });
    });
    expect(calls(DeleteRolePolicyCommand)).toEqual([]);
    expect(calls(GetRoleCommand)).toHaveLength(2);
  });
});
