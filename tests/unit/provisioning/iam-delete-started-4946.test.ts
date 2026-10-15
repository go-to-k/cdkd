/**
 * go-to-k/cdkd#4946: an IAM delete that already stripped the resource (a
 * policy detached, an inline policy deleted, a role removed from a profile,
 * a membership removed, ...) before AWS refused a later call by name marks
 * the error it throws, so the replacement path reads `'unconfirmed'` rather
 * than `'kept'` and never re-adopts a stripped shell. A refusal before any
 * strip stays unmarked and keeps its `'kept'`.
 *
 * Every case drives the provider's real `delete()` against a mocked IAM
 * client and reads the thrown error through both `isDeleteStarted` and the
 * consumer, `replacedDeleteFailureVerdict`.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { NoSuchEntityException } from '@aws-sdk/client-iam';

const mockSend = vi.fn();

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    iam: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
  }),
}));

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  return {
    getLogger: () => ({
      child: () => childLogger,
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  };
});

import { IAMRoleProvider } from '../../../src/provisioning/providers/iam-role-provider.js';
import { IAMManagedPolicyProvider } from '../../../src/provisioning/providers/iam-managed-policy-provider.js';
import { IAMUserGroupProvider } from '../../../src/provisioning/providers/iam-user-group-provider.js';
import { IAMPolicyProvider } from '../../../src/provisioning/providers/iam-policy-provider.js';
import { IAMInstanceProfileProvider } from '../../../src/provisioning/providers/iam-instance-profile-provider.js';
import { isDeleteStarted } from '../../../src/provisioning/delete-started.js';
import { replacedDeleteFailureVerdict } from '../../../src/deployment/rollback-executor/replaced-survivor.js';

/** An AWS refusal by name, shaped like the SDK's service exception. */
function accessDenied(): Error {
  return Object.assign(new Error('User is not authorized to perform this action'), {
    name: 'AccessDenied',
    $metadata: { httpStatusCode: 403 },
  });
}

function notFound(): NoSuchEntityException {
  return new NoSuchEntityException({ $metadata: {}, message: 'not found' });
}

type Handler = (input: Record<string, unknown>) => unknown;

/** Command names sent, in order, for asserting the refused call was reached. */
let sent: string[];

/**
 * Answer each command by its class name: a handler's return value resolves,
 * a thrown error rejects, and an unlisted command resolves `{}`.
 */
function drive(handlers: Record<string, Handler>): void {
  mockSend.mockImplementation(
    async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
      const name = command.constructor.name;
      sent.push(name);
      const handler = handlers[name];
      return handler ? handler(command.input) : {};
    }
  );
}

const refuse = (): never => {
  throw accessDenied();
};
const gone = (): never => {
  throw notFound();
};

async function thrownBy(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected the delete to throw');
}

async function expectStripped(promise: Promise<unknown>): Promise<void> {
  const error = await thrownBy(promise);
  expect(isDeleteStarted(error)).toBe(true);
  expect(replacedDeleteFailureVerdict(error)).toBe('unconfirmed');
}

async function expectWhole(promise: Promise<unknown>): Promise<void> {
  const error = await thrownBy(promise);
  expect(isDeleteStarted(error)).toBe(false);
  expect(replacedDeleteFailureVerdict(error)).toBe('kept');
}

beforeEach(() => {
  vi.clearAllMocks();
  mockSend.mockReset();
  sent = [];
});

describe('AWS::IAM::Role delete (go-to-k/cdkd#4946)', () => {
  const del = () => new IAMRoleProvider().delete('R', 'my-role', 'AWS::IAM::Role');
  const empty: Record<string, Handler> = {
    GetRoleCommand: () => ({ Role: { RoleName: 'my-role' } }),
    ListAttachedRolePoliciesCommand: () => ({ AttachedPolicies: [] }),
    ListRolePoliciesCommand: () => ({ PolicyNames: [] }),
    ListInstanceProfilesForRoleCommand: () => ({ InstanceProfiles: [] }),
    DeleteRoleCommand: refuse,
  };

  it('a managed policy detached, then DeleteRole refused: unconfirmed', async () => {
    drive({
      ...empty,
      ListAttachedRolePoliciesCommand: () => ({
        AttachedPolicies: [{ PolicyArn: 'arn:aws:iam::123456789012:policy/P' }],
      }),
    });
    await expectStripped(del());
    expect(sent).toContain('DetachRolePolicyCommand');
    expect(sent.at(-1)).toBe('DeleteRoleCommand');
  });

  it('an inline policy deleted, then DeleteRole refused: unconfirmed', async () => {
    drive({ ...empty, ListRolePoliciesCommand: () => ({ PolicyNames: ['inline'] }) });
    await expectStripped(del());
    expect(sent).toContain('DeleteRolePolicyCommand');
    expect(sent.at(-1)).toBe('DeleteRoleCommand');
  });

  it('removed from an instance profile, then DeleteRole refused: unconfirmed', async () => {
    drive({
      ...empty,
      ListInstanceProfilesForRoleCommand: () => ({
        InstanceProfiles: [{ InstanceProfileName: 'prof' }],
      }),
    });
    await expectStripped(del());
    expect(sent).toContain('RemoveRoleFromInstanceProfileCommand');
    expect(sent.at(-1)).toBe('DeleteRoleCommand');
  });

  it('a managed policy detached, then the inline-policy delete refused: unconfirmed', async () => {
    drive({
      ...empty,
      ListAttachedRolePoliciesCommand: () => ({
        AttachedPolicies: [{ PolicyArn: 'arn:aws:iam::123456789012:policy/P' }],
      }),
      ListRolePoliciesCommand: () => ({ PolicyNames: ['inline'] }),
      DeleteRolePolicyCommand: refuse,
    });
    await expectStripped(del());
    expect(sent).not.toContain('DeleteRoleCommand');
  });

  it('nothing to strip, DeleteRole refused: kept', async () => {
    drive(empty);
    await expectWhole(del());
    expect(sent.at(-1)).toBe('DeleteRoleCommand');
  });

  it('the first detach itself refused: kept', async () => {
    drive({
      ...empty,
      ListAttachedRolePoliciesCommand: () => ({
        AttachedPolicies: [{ PolicyArn: 'arn:aws:iam::123456789012:policy/P' }],
      }),
      DetachRolePolicyCommand: refuse,
    });
    await expectWhole(del());
    expect(sent).not.toContain('DeleteRoleCommand');
  });

  it('a detach answered not-found is not a strip: kept', async () => {
    drive({
      ...empty,
      ListAttachedRolePoliciesCommand: () => ({
        AttachedPolicies: [{ PolicyArn: 'arn:aws:iam::123456789012:policy/P' }],
      }),
      DetachRolePolicyCommand: gone,
    });
    await expectWhole(del());
    expect(sent.at(-1)).toBe('DeleteRoleCommand');
  });
});

describe('AWS::IAM::ManagedPolicy delete (go-to-k/cdkd#4946)', () => {
  const ARN = 'arn:aws:iam::123456789012:policy/mp';
  const del = () => new IAMManagedPolicyProvider().delete('M', ARN, 'AWS::IAM::ManagedPolicy');
  const empty: Record<string, Handler> = {
    GetPolicyCommand: () => ({ Policy: { Arn: ARN } }),
    ListEntitiesForPolicyCommand: () => ({ PolicyGroups: [], PolicyRoles: [], PolicyUsers: [] }),
    ListPolicyVersionsCommand: () => ({ Versions: [{ VersionId: 'v1', IsDefaultVersion: true }] }),
    DeletePolicyCommand: refuse,
  };

  it.each([
    ['group', { PolicyGroups: [{ GroupName: 'g' }] }, 'DetachGroupPolicyCommand'],
    ['role', { PolicyRoles: [{ RoleName: 'r' }] }, 'DetachRolePolicyCommand'],
    ['user', { PolicyUsers: [{ UserName: 'u' }] }, 'DetachUserPolicyCommand'],
  ])('detached from a %s, then DeletePolicy refused: unconfirmed', async (_k, entities, detach) => {
    drive({ ...empty, ListEntitiesForPolicyCommand: () => entities });
    await expectStripped(del());
    expect(sent).toContain(detach);
    expect(sent.at(-1)).toBe('DeletePolicyCommand');
  });

  it('detached from a role, then the next detach refused: unconfirmed', async () => {
    drive({
      ...empty,
      ListEntitiesForPolicyCommand: () => ({
        PolicyRoles: [{ RoleName: 'r' }],
        PolicyUsers: [{ UserName: 'u' }],
      }),
      DetachUserPolicyCommand: refuse,
    });
    await expectStripped(del());
    expect(sent).not.toContain('DeletePolicyCommand');
  });

  it('no principal, DeletePolicy refused: kept', async () => {
    drive(empty);
    await expectWhole(del());
    expect(sent.at(-1)).toBe('DeletePolicyCommand');
  });

  it('only non-default versions deleted, DeletePolicy refused: kept (versions are not a strip)', async () => {
    drive({
      ...empty,
      ListPolicyVersionsCommand: () => ({
        Versions: [
          { VersionId: 'v1', IsDefaultVersion: true },
          { VersionId: 'v2', IsDefaultVersion: false },
        ],
      }),
    });
    await expectWhole(del());
    expect(sent).toContain('DeletePolicyVersionCommand');
    expect(sent.at(-1)).toBe('DeletePolicyCommand');
  });

  it('the first detach itself refused: kept', async () => {
    drive({
      ...empty,
      ListEntitiesForPolicyCommand: () => ({ PolicyGroups: [{ GroupName: 'g' }] }),
      DetachGroupPolicyCommand: refuse,
    });
    await expectWhole(del());
    expect(sent).not.toContain('DeletePolicyCommand');
  });
});

describe('AWS::IAM::User delete (go-to-k/cdkd#4946)', () => {
  const del = () => new IAMUserGroupProvider().delete('U', 'alice', 'AWS::IAM::User');
  const empty: Record<string, Handler> = {
    GetUserCommand: () => ({ User: { UserName: 'alice' } }),
    ListGroupsForUserCommand: () => ({ Groups: [] }),
    ListAttachedUserPoliciesCommand: () => ({ AttachedPolicies: [] }),
    ListUserPoliciesCommand: () => ({ PolicyNames: [] }),
    DeleteLoginProfileCommand: gone,
    ListAccessKeysCommand: () => ({ AccessKeyMetadata: [] }),
    DeleteUserPermissionsBoundaryCommand: gone,
    DeleteUserCommand: refuse,
  };

  it.each<[string, Record<string, Handler>, string]>([
    [
      'removed from a group',
      { ListGroupsForUserCommand: () => ({ Groups: [{ GroupName: 'g' }] }) },
      'RemoveUserFromGroupCommand',
    ],
    [
      'a managed policy detached',
      {
        ListAttachedUserPoliciesCommand: () => ({
          AttachedPolicies: [{ PolicyArn: 'arn:aws:iam::123456789012:policy/P' }],
        }),
      },
      'DetachUserPolicyCommand',
    ],
    [
      'an inline policy deleted',
      { ListUserPoliciesCommand: () => ({ PolicyNames: ['inline'] }) },
      'DeleteUserPolicyCommand',
    ],
    ['the login profile deleted', { DeleteLoginProfileCommand: () => ({}) }, 'DeleteLoginProfileCommand'],
    [
      'an access key deleted',
      { ListAccessKeysCommand: () => ({ AccessKeyMetadata: [{ AccessKeyId: 'AKIAEXAMPLE' }] }) },
      'DeleteAccessKeyCommand',
    ],
    [
      'the permissions boundary deleted',
      {
        GetUserCommand: () => ({
          User: {
            UserName: 'alice',
            PermissionsBoundary: { PermissionsBoundaryArn: 'arn:aws:iam::123456789012:policy/b' },
          },
        }),
        DeleteUserPermissionsBoundaryCommand: () => ({}),
      },
      'DeleteUserPermissionsBoundaryCommand',
    ],
  ])('%s, then DeleteUser refused: unconfirmed', async (_k, override, strip) => {
    drive({ ...empty, ...override });
    await expectStripped(del());
    expect(sent).toContain(strip);
    expect(sent.at(-1)).toBe('DeleteUserCommand');
  });

  it('a boundary delete answered with success for a user the read saw none on is no strip: kept', async () => {
    drive({ ...empty, DeleteUserPermissionsBoundaryCommand: () => ({}) });
    await expectWhole(del());
    expect(sent).toContain('DeleteUserPermissionsBoundaryCommand');
    expect(sent.at(-1)).toBe('DeleteUserCommand');
  });

  it('the login profile deleted, then the access-key delete refused: unconfirmed', async () => {
    drive({
      ...empty,
      DeleteLoginProfileCommand: () => ({}),
      ListAccessKeysCommand: () => ({ AccessKeyMetadata: [{ AccessKeyId: 'AKIAEXAMPLE' }] }),
      DeleteAccessKeyCommand: refuse,
    });
    await expectStripped(del());
    expect(sent).not.toContain('DeleteUserCommand');
  });

  it('nothing to strip, DeleteUser refused: kept', async () => {
    drive(empty);
    await expectWhole(del());
    expect(sent.at(-1)).toBe('DeleteUserCommand');
  });

  it('the first group removal itself refused: kept', async () => {
    drive({
      ...empty,
      ListGroupsForUserCommand: () => ({ Groups: [{ GroupName: 'g' }] }),
      RemoveUserFromGroupCommand: refuse,
    });
    await expectWhole(del());
    expect(sent).not.toContain('DeleteUserCommand');
  });
});

describe('AWS::IAM::Group delete (go-to-k/cdkd#4946)', () => {
  const del = () => new IAMUserGroupProvider().delete('G', 'eng', 'AWS::IAM::Group');
  const empty: Record<string, Handler> = {
    ListAttachedGroupPoliciesCommand: () => ({ AttachedPolicies: [] }),
    ListGroupPoliciesCommand: () => ({ PolicyNames: [] }),
    GetGroupCommand: () => ({ Group: { GroupName: 'eng' }, Users: [] }),
    DeleteGroupCommand: refuse,
  };

  it.each<[string, Record<string, Handler>, string]>([
    [
      'a managed policy detached',
      {
        ListAttachedGroupPoliciesCommand: () => ({
          AttachedPolicies: [{ PolicyArn: 'arn:aws:iam::123456789012:policy/P' }],
        }),
      },
      'DetachGroupPolicyCommand',
    ],
    [
      'an inline policy deleted',
      { ListGroupPoliciesCommand: () => ({ PolicyNames: ['inline'] }) },
      'DeleteGroupPolicyCommand',
    ],
    [
      'a user removed',
      { GetGroupCommand: () => ({ Group: { GroupName: 'eng' }, Users: [{ UserName: 'alice' }] }) },
      'RemoveUserFromGroupCommand',
    ],
  ])('%s, then DeleteGroup refused: unconfirmed', async (_k, override, strip) => {
    drive({ ...empty, ...override });
    await expectStripped(del());
    expect(sent).toContain(strip);
    expect(sent.at(-1)).toBe('DeleteGroupCommand');
  });

  it('nothing to strip, DeleteGroup refused: kept', async () => {
    drive(empty);
    await expectWhole(del());
    expect(sent.at(-1)).toBe('DeleteGroupCommand');
  });

  it('the first detach itself refused: kept', async () => {
    drive({
      ...empty,
      ListAttachedGroupPoliciesCommand: () => ({
        AttachedPolicies: [{ PolicyArn: 'arn:aws:iam::123456789012:policy/P' }],
      }),
      DetachGroupPolicyCommand: refuse,
    });
    await expectWhole(del());
    expect(sent).not.toContain('DeleteGroupCommand');
  });
});

describe('AWS::IAM::UserToGroupAddition delete (go-to-k/cdkd#4946)', () => {
  const del = () =>
    new IAMUserGroupProvider().delete('A', 'A', 'AWS::IAM::UserToGroupAddition', {
      GroupName: 'eng',
      Users: ['alice', 'bob'],
    });

  it('the first user removed, then the second removal refused: unconfirmed', async () => {
    drive({
      RemoveUserFromGroupCommand: (input) => (input['UserName'] === 'bob' ? refuse() : {}),
    });
    await expectStripped(del());
    expect(sent).toEqual(['RemoveUserFromGroupCommand', 'RemoveUserFromGroupCommand']);
  });

  it('the first removal itself refused: kept', async () => {
    drive({ RemoveUserFromGroupCommand: refuse });
    await expectWhole(del());
    expect(sent).toEqual(['RemoveUserFromGroupCommand']);
  });

  it('the first removal answered not-found, then the second refused: kept', async () => {
    drive({
      RemoveUserFromGroupCommand: (input) => (input['UserName'] === 'bob' ? refuse() : gone()),
    });
    await expectWhole(del());
    expect(sent).toEqual(['RemoveUserFromGroupCommand', 'RemoveUserFromGroupCommand']);
  });
});

describe('AWS::IAM::Policy delete (go-to-k/cdkd#4946)', () => {
  const del = (properties: Record<string, unknown>) =>
    new IAMPolicyProvider().delete('P', 'pol', 'AWS::IAM::Policy', {
      PolicyName: 'pol',
      ...properties,
    });

  it.each([
    ['Roles', 'DeleteRolePolicyCommand', 'RoleName'],
    ['Groups', 'DeleteGroupPolicyCommand', 'GroupName'],
    ['Users', 'DeleteUserPolicyCommand', 'UserName'],
  ])(
    'removed from the first of two %s, then the second refused: unconfirmed',
    async (kind, command, key) => {
      drive({ [command]: (input) => (input[key] === 'second' ? refuse() : {}) });
      await expectStripped(del({ [kind]: ['first', 'second'] }));
      expect(sent).toEqual([command, command]);
    }
  );

  it('removed from a role, then the group removal refused: unconfirmed', async () => {
    drive({ DeleteGroupPolicyCommand: refuse });
    await expectStripped(del({ Roles: ['r'], Groups: ['g'] }));
    expect(sent).toEqual(['DeleteRolePolicyCommand', 'DeleteGroupPolicyCommand']);
  });

  it('the first removal itself refused: kept', async () => {
    drive({ DeleteRolePolicyCommand: refuse });
    await expectWhole(del({ Roles: ['first', 'second'] }));
    expect(sent).toEqual(['DeleteRolePolicyCommand']);
  });

  it('the first removal answered not-found, then the second refused: kept', async () => {
    drive({
      DeleteRolePolicyCommand: (input) => (input['RoleName'] === 'second' ? refuse() : gone()),
    });
    await expectWhole(del({ Roles: ['first', 'second'] }));
    expect(sent).toEqual(['DeleteRolePolicyCommand', 'DeleteRolePolicyCommand']);
  });
});

describe('AWS::IAM::InstanceProfile delete (go-to-k/cdkd#4946)', () => {
  const del = () =>
    new IAMInstanceProfileProvider().delete('I', 'prof', 'AWS::IAM::InstanceProfile');

  it('a role removed, then DeleteInstanceProfile refused: unconfirmed', async () => {
    drive({
      GetInstanceProfileCommand: () => ({ InstanceProfile: { Roles: [{ RoleName: 'r' }] } }),
      DeleteInstanceProfileCommand: refuse,
    });
    await expectStripped(del());
    expect(sent).toEqual([
      'GetInstanceProfileCommand',
      'RemoveRoleFromInstanceProfileCommand',
      'DeleteInstanceProfileCommand',
    ]);
  });

  it('no role, DeleteInstanceProfile refused: kept', async () => {
    drive({
      GetInstanceProfileCommand: () => ({ InstanceProfile: { Roles: [] } }),
      DeleteInstanceProfileCommand: refuse,
    });
    await expectWhole(del());
    expect(sent.at(-1)).toBe('DeleteInstanceProfileCommand');
  });

  it('the role removal itself refused: kept', async () => {
    drive({
      GetInstanceProfileCommand: () => ({ InstanceProfile: { Roles: [{ RoleName: 'r' }] } }),
      RemoveRoleFromInstanceProfileCommand: refuse,
    });
    await expectWhole(del());
    expect(sent).not.toContain('DeleteInstanceProfileCommand');
  });
});
