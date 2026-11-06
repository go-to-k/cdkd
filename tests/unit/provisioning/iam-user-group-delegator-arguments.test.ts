/**
 * The `IAMUserGroupProvider` method bodies live in
 * `src/provisioning/providers/iam-user-group/*.ts`; the class keeps one
 * `return f.call(this, ...)` delegator per moved method, and each argument a
 * delegator hands on is a hand-off the split introduced.
 *
 * Every companion function is a pass-through spy on the real one. The first
 * block stubs each spy once and pins, for EVERY delegator, that it calls its
 * own function with the provider as `this`, every argument in declared order,
 * and returns that function's result. The second block runs real bodies end to
 * end and pins the SDK command each sends, by class and input.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const mockSend = vi.fn();

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    iam: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
  }),
}));

/** Replace every function a module exports with a pass-through spy. */
async function spied(path: string): Promise<Record<string, unknown>> {
  const actual = await vi.importActual<Record<string, unknown>>(path);
  return Object.fromEntries(
    Object.entries(actual).map(([k, v]) => [
      k,
      typeof v === 'function' ? vi.fn(v as (...a: unknown[]) => unknown) : v,
    ])
  );
}

vi.mock('../../../src/provisioning/providers/iam-user-group/core.js', () =>
  spied('../../../src/provisioning/providers/iam-user-group/core.js')
);
vi.mock('../../../src/provisioning/providers/iam-user-group/user-create.js', () =>
  spied('../../../src/provisioning/providers/iam-user-group/user-create.js')
);
vi.mock('../../../src/provisioning/providers/iam-user-group/user-update.js', () =>
  spied('../../../src/provisioning/providers/iam-user-group/user-update.js')
);
vi.mock('../../../src/provisioning/providers/iam-user-group/user-delete.js', () =>
  spied('../../../src/provisioning/providers/iam-user-group/user-delete.js')
);
vi.mock('../../../src/provisioning/providers/iam-user-group/group.js', () =>
  spied('../../../src/provisioning/providers/iam-user-group/group.js')
);
vi.mock('../../../src/provisioning/providers/iam-user-group/user-to-group-addition.js', () =>
  spied('../../../src/provisioning/providers/iam-user-group/user-to-group-addition.js')
);
vi.mock('../../../src/provisioning/providers/iam-user-group/read-state.js', () =>
  spied('../../../src/provisioning/providers/iam-user-group/read-state.js')
);
vi.mock('../../../src/provisioning/providers/iam-user-group/import.js', () =>
  spied('../../../src/provisioning/providers/iam-user-group/import.js')
);

import {
  AddUserToGroupCommand,
  DeleteGroupCommand,
  GetUserCommand,
} from '@aws-sdk/client-iam';
import { IAMUserGroupProvider } from '../../../src/provisioning/providers/iam-user-group-provider.js';
import * as core from '../../../src/provisioning/providers/iam-user-group/core.js';
import * as userCreate from '../../../src/provisioning/providers/iam-user-group/user-create.js';
import * as userUpdate from '../../../src/provisioning/providers/iam-user-group/user-update.js';
import * as userDelete from '../../../src/provisioning/providers/iam-user-group/user-delete.js';
import * as group from '../../../src/provisioning/providers/iam-user-group/group.js';
import * as userToGroupAddition from '../../../src/provisioning/providers/iam-user-group/user-to-group-addition.js';
import * as readState from '../../../src/provisioning/providers/iam-user-group/read-state.js';
import * as importMod from '../../../src/provisioning/providers/iam-user-group/import.js';

const MODULES: Record<string, Record<string, unknown>> = {
  core,
  'user-create': userCreate,
  'user-update': userUpdate,
  'user-delete': userDelete,
  group,
  'user-to-group-addition': userToGroupAddition,
  'read-state': readState,
  import: importMod,
};

/** [class method, companion module, companion function, declared parameter count] */
const DELEGATORS: ReadonlyArray<readonly [string, string, string, number]> = [
  ['wrapMaskedError', 'core', 'wrapMaskedError', 3],
  ['cleanupFailureText', 'core', 'cleanupFailureText', 3],
  ['create', 'core', 'create', 4],
  ['update', 'core', 'update', 6],
  ['delete', 'core', 'deleteImpl', 5],
  ['createUser', 'user-create', 'createUser', 4],
  ['updateUser', 'user-update', 'updateUser', 7],
  ['deleteUser', 'user-delete', 'deleteUser', 4],
  ['readLiveGroups', 'user-delete', 'readLiveGroups', 1],
  ['removeUserFromAllGroups', 'user-delete', 'removeUserFromAllGroups', 3],
  ['deleteAllAccessKeys', 'user-delete', 'deleteAllAccessKeys', 3],
  ['detachAllUserPolicies', 'user-delete', 'detachAllUserPolicies', 3],
  ['deleteAllUserInlinePolicies', 'user-delete', 'deleteAllUserInlinePolicies', 3],
  ['applyUserTagDiff', 'user-update', 'applyUserTagDiff', 6],
  ['updateUserManagedPolicies', 'user-update', 'updateUserManagedPolicies', 4],
  ['updateUserGroups', 'user-update', 'updateUserGroups', 4],
  ['updateUserInlinePolicies', 'user-update', 'updateUserInlinePolicies', 5],
  ['createGroup', 'group', 'createGroup', 4],
  ['updateGroup', 'group', 'updateGroup', 7],
  ['deleteGroup', 'group', 'deleteGroup', 4],
  ['detachAllGroupPolicies', 'group', 'detachAllGroupPolicies', 3],
  ['removeAllUsersFromGroup', 'group', 'removeAllUsersFromGroup', 3],
  ['updateGroupManagedPolicies', 'group', 'updateGroupManagedPolicies', 4],
  ['deleteAllGroupInlinePolicies', 'group', 'deleteAllGroupInlinePolicies', 3],
  ['updateGroupInlinePolicies', 'group', 'updateGroupInlinePolicies', 5],
  ['createUserToGroupAddition', 'user-to-group-addition', 'createUserToGroupAddition', 4],
  ['updateUserToGroupAddition', 'user-to-group-addition', 'updateUserToGroupAddition', 6],
  ['deleteUserToGroupAddition', 'user-to-group-addition', 'deleteUserToGroupAddition', 5],
  ['isSameResource', 'read-state', 'isSameResource', 4],
  ['resourceIdentity', 'read-state', 'resourceIdentity', 3],
  ['readIdIfExists', 'read-state', 'readIdIfExists', 2],
  ['readCurrentState', 'read-state', 'readCurrentState', 5],
  ['readUserCurrentState', 'read-state', 'readUserCurrentState', 3],
  ['readGroupCurrentState', 'read-state', 'readGroupCurrentState', 3],
  ['collectInlinePolicies', 'read-state', 'collectInlinePolicies', 4],
  ['import', 'import', 'importImpl', 1],
  ['importUser', 'import', 'importUser', 1],
  ['importGroup', 'import', 'importGroup', 1],
  ['importUserToGroupAddition', 'import', 'importUserToGroupAddition', 1],
];

/** Methods whose bodies stay on the class. */
const KEPT_ON_CLASS = new Set(['constructor']);

type Callable = (...args: unknown[]) => unknown;
type Spy = ReturnType<typeof vi.fn>;

describe('IAMUserGroupProvider delegators hand every argument and the result on', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('the table names every method the class delegates', () => {
    const methods = Object.getOwnPropertyNames(IAMUserGroupProvider.prototype).filter(
      (m) => !KEPT_ON_CLASS.has(m)
    );
    expect(methods.sort()).toEqual(DELEGATORS.map(([m]) => m).sort());
  });

  for (const [method, mod, fn, arity] of DELEGATORS) {
    it(`${method} calls ${mod}.${fn} with this, ${arity} argument(s) in order, and returns its result`, () => {
      const spy = MODULES[mod]![fn] as Spy;
      expect(vi.isMockFunction(spy), `${mod}.${fn} is not spied`).toBe(true);
      const result = { result: method };
      spy.mockImplementationOnce(() => result);
      const provider = new IAMUserGroupProvider();
      const args = Array.from({ length: arity }, (_, i) => ({ arg: i }));
      const returned = (provider as unknown as Record<string, Callable>)[method]!(...args);
      expect(returned).toBe(result);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0]).toEqual(args);
      spy.mock.calls[0]!.forEach((a, i) => expect(a).toBe(args[i]));
      expect(spy.mock.contexts[0]).toBe(provider);
    });
  }
});

describe('IAMUserGroupProvider moved bodies send the SDK command the delegator names', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockReset();
  });

  it('readCurrentState reads the user the physical id names', async () => {
    mockSend.mockImplementation(async (command: unknown) => {
      if (command instanceof GetUserCommand) return { User: { UserName: 'alice', Path: '/' } };
      return {};
    });
    await new IAMUserGroupProvider().readCurrentState('alice', 'MyUser', 'AWS::IAM::User');
    const gets = mockSend.mock.calls
      .map(([c]) => c as { input: unknown })
      .filter((c) => c instanceof GetUserCommand);
    expect(gets.map((c) => c.input)).toEqual([{ UserName: 'alice' }]);
  });

  it('delete deletes the group the physical id names', async () => {
    mockSend.mockResolvedValue({});
    await new IAMUserGroupProvider().delete('MyGroup', 'engineers', 'AWS::IAM::Group');
    const deletes = mockSend.mock.calls
      .map(([c]) => c as { input: unknown })
      .filter((c) => c instanceof DeleteGroupCommand);
    expect(deletes.map((c) => c.input)).toEqual([{ GroupName: 'engineers' }]);
  });

  it('create adds each user to the group a UserToGroupAddition names', async () => {
    mockSend.mockResolvedValue({});
    await new IAMUserGroupProvider().create('MyAddition', 'AWS::IAM::UserToGroupAddition', {
      GroupName: 'engineers',
      Users: ['alice', 'bob'],
    });
    const adds = mockSend.mock.calls
      .map(([c]) => c as { input: unknown })
      .filter((c) => c instanceof AddUserToGroupCommand);
    expect(adds.map((c) => c.input)).toEqual([
      { GroupName: 'engineers', UserName: 'alice' },
      { GroupName: 'engineers', UserName: 'bob' },
    ]);
  });
});
