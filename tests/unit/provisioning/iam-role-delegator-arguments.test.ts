/**
 * The `IAMRoleProvider` method bodies live in
 * `src/provisioning/providers/iam-role/*.ts`; the class keeps one
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

vi.mock('../../../src/provisioning/providers/iam-role/shared.js', () =>
  spied('../../../src/provisioning/providers/iam-role/shared.js')
);
vi.mock('../../../src/provisioning/providers/iam-role/create.js', () =>
  spied('../../../src/provisioning/providers/iam-role/create.js')
);
vi.mock('../../../src/provisioning/providers/iam-role/update.js', () =>
  spied('../../../src/provisioning/providers/iam-role/update.js')
);
vi.mock('../../../src/provisioning/providers/iam-role/delete.js', () =>
  spied('../../../src/provisioning/providers/iam-role/delete.js')
);
vi.mock('../../../src/provisioning/providers/iam-role/read-state.js', () =>
  spied('../../../src/provisioning/providers/iam-role/read-state.js')
);

import {
  DeleteRoleCommand,
  GetRoleCommand,
  ListAttachedRolePoliciesCommand,
  ListInstanceProfilesForRoleCommand,
  ListRolePoliciesCommand,
  ListRoleTagsCommand,
  TagRoleCommand,
  UntagRoleCommand,
} from '@aws-sdk/client-iam';
import { IAMRoleProvider } from '../../../src/provisioning/providers/iam-role-provider.js';
import * as shared from '../../../src/provisioning/providers/iam-role/shared.js';
import * as create from '../../../src/provisioning/providers/iam-role/create.js';
import * as update from '../../../src/provisioning/providers/iam-role/update.js';
import * as del from '../../../src/provisioning/providers/iam-role/delete.js';
import * as readState from '../../../src/provisioning/providers/iam-role/read-state.js';
import { createMaskedLogSinks } from '../../../src/provisioning/masked-retry-logger.js';
import { getLogger } from '../../../src/utils/logger.js';

const MODULES: Record<string, Record<string, unknown>> = {
  shared,
  create,
  update,
  delete: del,
  'read-state': readState,
};

/** [class method, companion module, companion function, declared parameter count] */
const DELEGATORS: ReadonlyArray<readonly [string, string, string, number]> = [
  ['wrapMaskedError', 'shared', 'wrapMaskedError', 3],
  ['create', 'create', 'create', 4],
  ['update', 'update', 'update', 6],
  ['updateManagedPolicies', 'update', 'updateManagedPolicies', 4],
  ['updateInlinePolicies', 'update', 'updateInlinePolicies', 5],
  ['updateTags', 'update', 'updateTags', 6],
  ['delete', 'delete', 'deleteImpl', 5],
  ['detachAllManagedPolicies', 'delete', 'detachAllManagedPolicies', 3],
  ['deleteAllInlinePolicies', 'delete', 'deleteAllInlinePolicies', 3],
  ['removeFromAllInstanceProfiles', 'delete', 'removeFromAllInstanceProfiles', 3],
  ['getAttribute', 'read-state', 'getAttribute', 3],
  ['isSameResource', 'read-state', 'isSameResource', 4],
  ['resourceIdentity', 'read-state', 'resourceIdentity', 3],
  ['readRoleIdIfExists', 'read-state', 'readRoleIdIfExists', 1],
  ['readCurrentState', 'read-state', 'readCurrentState', 5],
  ['import', 'read-state', 'importImpl', 1],
];

/** Methods whose bodies stay on the class. */
const KEPT_ON_CLASS = new Set(['constructor']);

type Callable = (...args: unknown[]) => unknown;
type Spy = ReturnType<typeof vi.fn>;

describe('IAMRoleProvider delegators hand every argument and the result on', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('the table names every method the class delegates', () => {
    const methods = Object.getOwnPropertyNames(IAMRoleProvider.prototype).filter(
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
      const provider = new IAMRoleProvider();
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

describe('IAMRoleProvider moved bodies send the SDK command the delegator names', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockReset();
  });

  /** The input of every sent command of `cls`, in send order. */
  function sent(cls: abstract new (...a: never[]) => unknown): unknown[] {
    return mockSend.mock.calls
      .map(([c]) => c as { input: unknown })
      .filter((c) => c instanceof cls)
      .map((c) => c.input);
  }

  it('readCurrentState reads the role and its tags by the physical id', async () => {
    mockSend.mockImplementation(async (command: unknown) => {
      if (command instanceof GetRoleCommand) {
        return { Role: { RoleName: 'my-role', Path: '/', AssumeRolePolicyDocument: '%7B%7D' } };
      }
      return {};
    });
    await new IAMRoleProvider().readCurrentState('my-role', 'MyRole', 'AWS::IAM::Role');
    expect(sent(GetRoleCommand)).toEqual([{ RoleName: 'my-role' }]);
    expect(sent(ListRoleTagsCommand)).toEqual([{ RoleName: 'my-role' }]);
  });

  it('delete lists what is attached, then deletes the role the physical id names', async () => {
    mockSend.mockImplementation(async (command: unknown) => {
      if (command instanceof GetRoleCommand) return { Role: { RoleName: 'my-role' } };
      return {};
    });
    await new IAMRoleProvider().delete('MyRole', 'my-role', 'AWS::IAM::Role');
    expect(sent(ListAttachedRolePoliciesCommand)).toEqual([{ RoleName: 'my-role' }]);
    expect(sent(ListRolePoliciesCommand)).toEqual([{ RoleName: 'my-role' }]);
    expect(sent(ListInstanceProfilesForRoleCommand)).toEqual([{ RoleName: 'my-role' }]);
    expect(sent(DeleteRoleCommand)).toEqual([{ RoleName: 'my-role' }]);
  });

  it('updateTags untags the removed keys and tags the set ones', async () => {
    mockSend.mockResolvedValue({});
    await new IAMRoleProvider().updateTags(
      'my-role',
      'AWS::IAM::Role',
      'MyRole',
      [{ Key: 'keep', Value: 'new' }],
      [
        { Key: 'keep', Value: 'old' },
        { Key: 'gone', Value: 'x' },
      ],
      createMaskedLogSinks(getLogger().child('test'), undefined)
    );
    expect(sent(UntagRoleCommand)).toEqual([{ RoleName: 'my-role', TagKeys: ['gone'] }]);
    expect(sent(TagRoleCommand)).toEqual([
      { RoleName: 'my-role', Tags: [{ Key: 'keep', Value: 'new' }] },
    ]);
  });
});
