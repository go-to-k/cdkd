/**
 * go-to-k/cdkd#6774: IAM role, user and group names ignore case, so a
 * membership or attachment list whose entry is respelled only in case
 * (`my-user` -> `My-User`) names the SAME principal. Diffed case-sensitively,
 * the update added the new spelling (an IAM no-op) and then removed the old
 * one, taking the membership away after a successful deploy. Each list's
 * update now sends nothing for a case-only respelling, and a genuine rename
 * still adds the new principal and removes the old one.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

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
    child: vi.fn(function (this: unknown) { return this; }),
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

import { IAMInstanceProfileProvider } from '../../../src/provisioning/providers/iam-instance-profile-provider.js';
import { IAMUserGroupProvider } from '../../../src/provisioning/providers/iam-user-group-provider.js';
import { IAMManagedPolicyProvider } from '../../../src/provisioning/providers/iam-managed-policy-provider.js';
import { diffPrincipalNames } from '../../../src/provisioning/iam-policy-targets.js';

let sent: Array<{ name: string; input: Record<string, unknown> }>;

beforeEach(() => {
  vi.clearAllMocks();
  mockSend.mockReset();
  sent = [];
  mockSend.mockImplementation(
    async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
      sent.push({ name: command.constructor.name, input: command.input });
      if (command.constructor.name === 'GetInstanceProfileCommand') {
        return {
          InstanceProfile: {
            InstanceProfileName: 'my-profile',
            InstanceProfileId: 'AIPA-profile',
            Arn: 'arn:aws:iam::1:instance-profile/my-profile',
            Roles: [{ RoleName: 'my-role' }],
          },
        };
      }
      if (command.constructor.name === 'GetUserCommand') {
        return { User: { UserName: 'u', UserId: 'AIDA-u', Arn: 'arn:aws:iam::1:user/u' } };
      }
      return {};
    }
  );
});

const WRITE =
  /^(Add|Remove|Attach|Detach)(RoleToInstanceProfile|RoleFromInstanceProfile|UserToGroup|UserFromGroup|GroupPolicy|RolePolicy|UserPolicy)Command$/;
/** Each membership / attachment write, as `<command> <principal>`. */
const writes = (): string[] =>
  sent
    .filter((s) => WRITE.test(s.name))
    .map(
      (s) =>
        `${s.name.replace(/Command$/, '')} ${String(
          s.input['UserName'] ?? s.input['RoleName'] ?? s.input['GroupName']
        )}`
    );

describe('diffPrincipalNames (go-to-k/cdkd#6774)', () => {
  it('a case-only respelling is neither added nor removed', () => {
    expect(diffPrincipalNames(['My-User', 'b'], ['my-user', 'b'])).toEqual({
      added: [],
      removed: [],
    });
  });

  it('a genuine rename is added and removed, each side keeping its spelling', () => {
    expect(diffPrincipalNames(['New-User'], ['Old-User'])).toEqual({
      added: ['New-User'],
      removed: ['Old-User'],
    });
  });

  it('a name listed twice in two spellings counts once', () => {
    expect(diffPrincipalNames(['A', 'a'], undefined)).toEqual({ added: ['A'], removed: [] });
  });
});

describe('AWS::IAM::UserToGroupAddition Users (go-to-k/cdkd#6774)', () => {
  const update = (previous: string[], desired: string[]) =>
    new IAMUserGroupProvider().update(
      'UTG',
      'UTG-id',
      'AWS::IAM::UserToGroupAddition',
      { GroupName: 'my-group', Users: desired },
      { GroupName: 'my-group', Users: previous }
    );

  it('a user respelled only in case is neither added nor removed', async () => {
    await update(['my-user', 'other'], ['My-User', 'other']);
    expect(writes()).toEqual([]);
  });

  it('a genuine rename still adds the new user and removes the old one', async () => {
    await update(['my-user'], ['new-user']);
    expect(writes()).toEqual(['AddUserToGroup new-user', 'RemoveUserFromGroup my-user']);
  });
});

describe('AWS::IAM::User Groups (go-to-k/cdkd#6774)', () => {
  const update = (previous: string[], desired: string[]) =>
    new IAMUserGroupProvider().update(
      'U',
      'u',
      'AWS::IAM::User',
      { UserName: 'u', Groups: desired },
      { UserName: 'u', Groups: previous }
    );

  it('a group respelled only in case is neither joined nor left', async () => {
    await update(['my-group'], ['My-Group']);
    expect(writes()).toEqual([]);
  });

  it('a genuine rename still joins the new group and leaves the old one', async () => {
    await update(['my-group'], ['new-group']);
    expect(writes()).toEqual(['AddUserToGroup u', 'RemoveUserFromGroup u']);
    const groupsWritten = sent
      .filter((s) => /UserToGroup|UserFromGroup/.test(s.name))
      .map((s) => s.input['GroupName']);
    expect(groupsWritten).toEqual(['new-group', 'my-group']);
  });
});

describe('AWS::IAM::ManagedPolicy Roles / Users / Groups (go-to-k/cdkd#6774)', () => {
  const DOC = { Version: '2012-10-17', Statement: [] };
  const update = (previous: Record<string, string[]>, desired: Record<string, string[]>) =>
    new IAMManagedPolicyProvider().update(
      'MP',
      'arn:aws:iam::123456789012:policy/mp',
      'AWS::IAM::ManagedPolicy',
      { ManagedPolicyName: 'mp', PolicyDocument: DOC, ...desired },
      { ManagedPolicyName: 'mp', PolicyDocument: DOC, ...previous }
    );

  it('a principal respelled only in case is neither attached nor detached', async () => {
    const recordedAttributes = {
      PolicyId: 'ANPA-mp',
      DefaultVersionId: 'v1',
      AttachmentCount: 3,
      PermissionsBoundaryUsageCount: 0,
      IsAttachable: true,
      CreateDate: '2026-01-01T00:00:00Z',
      UpdateDate: '2026-01-01T00:00:00Z',
    };
    const result = await new IAMManagedPolicyProvider().update(
      'MP',
      'arn:aws:iam::123456789012:policy/mp',
      'AWS::IAM::ManagedPolicy',
      {
        ManagedPolicyName: 'mp',
        PolicyDocument: DOC,
        Roles: ['My-Role'],
        Users: ['MY-USER'],
        Groups: ['My-Group'],
      },
      {
        ManagedPolicyName: 'mp',
        PolicyDocument: DOC,
        Roles: ['my-role'],
        Users: ['my-user'],
        Groups: ['my-group'],
      },
      { recordedAttributes } as never
    );
    expect(writes()).toEqual([]);
    // Nothing moved, so the policy is not re-read and its recorded
    // AttachmentCount is kept (a failed re-read would have dropped it).
    expect(sent.map((s) => s.name)).not.toContain('GetPolicyCommand');
    expect(result.attributes?.['AttachmentCount']).toBe(3);
  });

  it('a genuine rename still attaches the new principal and detaches the old one', async () => {
    await update({ Roles: ['my-role'] }, { Roles: ['new-role'] });
    expect(writes()).toEqual(['AttachRolePolicy new-role', 'DetachRolePolicy my-role']);
  });
});

describe('AWS::IAM::InstanceProfile Roles (go-to-k/cdkd#6774)', () => {
  const update = (previous: string[], desired: string[]) =>
    new IAMInstanceProfileProvider().update(
      'IP',
      'my-profile',
      'AWS::IAM::InstanceProfile',
      { InstanceProfileName: 'my-profile', Roles: desired },
      { InstanceProfileName: 'my-profile', Roles: previous }
    );

  it('a role respelled only in case is neither removed nor added', async () => {
    await update(['my-role'], ['My-Role']);
    expect(writes()).toEqual([]);
  });

  it('a profile already holding `my-role` is the outcome an add of `My-Role` asked for', async () => {
    // A failed deploy's record lacks the role its add landed; IAM refuses a
    // second role with LimitExceeded, and the held one is the same role.
    const base = mockSend.getMockImplementation()!;
    mockSend.mockImplementation(
      async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
        if (command.constructor.name !== 'AddRoleToInstanceProfileCommand') return base(command);
        sent.push({ name: command.constructor.name, input: command.input });
        throw Object.assign(new Error('Cannot exceed quota'), {
          name: 'LimitExceededException',
          $metadata: {},
        });
      }
    );
    await expect(update([], ['My-Role'])).resolves.toMatchObject({ physicalId: 'my-profile' });
  });

  it('a genuine rename still removes the old role and adds the new one', async () => {
    await update(['my-role'], ['new-role']);
    expect(writes()).toEqual([
      'RemoveRoleFromInstanceProfile my-role',
      'AddRoleToInstanceProfile new-role',
    ]);
  });
});

describe('reads that compare a live list to the template ignore case (go-to-k/cdkd#6774)', () => {
  it('a managed policy with secret-derived recorded Roles keeps a live `my-role` the template spells `My-Role`', async () => {
    const DOC = { Version: '2012-10-17', Statement: [] };
    const base = mockSend.getMockImplementation()!;
    mockSend.mockImplementation(
      async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
        if (command.constructor.name !== 'ListEntitiesForPolicyCommand') return base(command);
        sent.push({ name: command.constructor.name, input: command.input });
        return { PolicyRoles: [{ RoleName: 'my-role' }], PolicyGroups: [], PolicyUsers: [] };
      }
    );
    await new IAMManagedPolicyProvider().update(
      'MP',
      'arn:aws:iam::123456789012:policy/mp',
      'AWS::IAM::ManagedPolicy',
      { ManagedPolicyName: 'mp', PolicyDocument: DOC, Roles: ['My-Role'] },
      {
        ManagedPolicyName: 'mp',
        PolicyDocument: DOC,
        Roles: ['{{resolve:secretsmanager:r:SecretString:n}}'],
      }
    );
    // The live `my-role` is the declared one: no attach, and no warning that
    // IAM lists an attachment the template does not name.
    expect(sent.map((s) => s.name)).toContain('ListEntitiesForPolicyCommand');
    expect(writes()).toEqual([]);
    const { getLogger } = await import('../../../src/utils/logger.js');
    const warn = getLogger().child('x').warn as unknown as ReturnType<typeof vi.fn>;
    expect(warn.mock.calls.map((c) => String(c[0])).join('\n')).not.toContain('secret-derived');
  });

  it('a managed policy read after its own write takes a live `my-role` as the declared `My-Role`', async () => {
    const base = mockSend.getMockImplementation()!;
    mockSend.mockImplementation(
      async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
        const name = command.constructor.name;
        if (name === 'GetPolicyCommand') return { Policy: { PolicyName: 'mp' } };
        if (name !== 'ListEntitiesForPolicyCommand') return base(command);
        sent.push({ name, input: command.input });
        return { PolicyRoles: [{ RoleName: 'my-role' }], PolicyGroups: [], PolicyUsers: [] };
      }
    );
    const provider = new IAMManagedPolicyProvider();
    (provider as unknown as { ownWriteRereadDelaysMs: readonly number[] }).ownWriteRereadDelaysMs =
      [0, 0, 0];
    const result = await provider.readCurrentState(
      'arn:aws:iam::123456789012:policy/mp',
      'MP',
      'AWS::IAM::ManagedPolicy',
      { Roles: ['My-Role'] },
      { afterOwnWrite: true } as never
    );
    // One read: the declared role already shows, so no re-read waits for it.
    expect(sent.filter((s) => s.name === 'ListEntitiesForPolicyCommand')).toHaveLength(1);
    expect((result as Record<string, unknown>)['Roles']).toEqual(['my-role']);
  });

  it('an instance profile read after its own write takes a live `my-role` as the declared `My-Role`', async () => {
    const provider = new IAMInstanceProfileProvider();
    const result = await provider.readCurrentState(
      'my-profile',
      'IP',
      'AWS::IAM::InstanceProfile',
      { InstanceProfileName: 'my-profile', Roles: ['My-Role'] },
      { afterOwnWrite: true } as never
    );
    // One read: the declared role already shows, so no re-read waits for it.
    expect(sent.filter((s) => s.name === 'GetInstanceProfileCommand')).toHaveLength(1);
    expect((result as Record<string, unknown>)['Roles']).toEqual(['my-role']);
  });
});
