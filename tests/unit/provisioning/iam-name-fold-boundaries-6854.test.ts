/**
 * go-to-k/cdkd#6854 (lane E): the IAM name folds and attachment-set rules,
 * each with the pair it must NOT equate. Measured us-east-1, 2026-11-23
 * (docs/design/6854-e-unowned-normalization-rules.md): role and managed
 * policy names are unique ignoring case AND path (`CreateRole` /
 * `CreatePolicy` of a case- or path-variant name is `EntityAlreadyExists`);
 * `AttachRolePolicy` / `AddRoleToInstanceProfile` accept another case and
 * read back the stored case; a repeated attach lists the role once; an inline
 * policy name is one policy in any case (a second `PutRolePolicy` in another
 * case replaces the document and keeps the first spelling).
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
import { IAMPolicyProvider } from '../../../src/provisioning/providers/iam-policy-provider.js';
import { IAMRoleProvider } from '../../../src/provisioning/providers/iam-role-provider.js';
import { calculateResourceDrift } from '../../../src/analyzer/drift-calculator.js';

type Cmd = { constructor: { name: string }; input: Record<string, unknown> };
let sent: Array<{ name: string; input: Record<string, unknown> }>;

function route(answers: Record<string, (input: Record<string, unknown>) => unknown>): void {
  mockSend.mockImplementation(async (command: Cmd) => {
    sent.push({ name: command.constructor.name, input: command.input });
    const answer = answers[command.constructor.name];
    return answer ? answer(command.input) : {};
  });
}

const count = (name: string): number => sent.filter((s) => s.name === name).length;

beforeEach(() => {
  vi.clearAllMocks();
  mockSend.mockReset();
  sent = [];
});

const MP_ARN = 'arn:aws:iam::123456789012:policy/mp';

describe('own-write settle folds: only a case-only respelling is the declared principal', () => {
  const managedPolicyRead = async (live: string): Promise<void> => {
    route({
      GetPolicyCommand: () => ({ Policy: { PolicyName: 'mp' } }),
      ListEntitiesForPolicyCommand: () => ({
        PolicyRoles: [{ RoleName: live }],
        PolicyGroups: [],
        PolicyUsers: [],
      }),
    });
    const provider = new IAMManagedPolicyProvider();
    (provider as unknown as { ownWriteRereadDelaysMs: readonly number[] }).ownWriteRereadDelaysMs =
      [0, 0];
    await provider.readCurrentState(
      MP_ARN,
      'MP',
      'AWS::IAM::ManagedPolicy',
      { Roles: ['My-Role'] },
      { afterOwnWrite: true } as never
    );
  };

  it('managed policy: `my-role` settles at once; `my-role2` (beyond case) is re-read', async () => {
    await managedPolicyRead('my-role');
    expect(count('ListEntitiesForPolicyCommand')).toBe(1);
    sent = [];
    await managedPolicyRead('my-role2');
    expect(count('ListEntitiesForPolicyCommand')).toBe(3);
  });

  const profileRead = async (live: string): Promise<unknown> => {
    route({
      GetInstanceProfileCommand: () => ({
        InstanceProfile: {
          InstanceProfileName: 'my-profile',
          InstanceProfileId: 'AIPA-profile',
          Arn: 'arn:aws:iam::1:instance-profile/my-profile',
          Path: '/',
          Roles: [{ RoleName: live }],
        },
      }),
    });
    const provider = new IAMInstanceProfileProvider();
    (provider as unknown as { ownWriteRereadDelaysMs: readonly number[] }).ownWriteRereadDelaysMs =
      [0, 0];
    return provider.readCurrentState(
      'my-profile',
      'IP',
      'AWS::IAM::InstanceProfile',
      { InstanceProfileName: 'my-profile', Roles: ['My-Role'] },
      { afterOwnWrite: true } as never
    );
  };

  it('instance profile: `my-role` settles at once; `my-role-b` is re-read', async () => {
    await profileRead('my-role');
    expect(count('GetInstanceProfileCommand')).toBe(1);
    sent = [];
    await profileRead('my-role-b');
    expect(count('GetInstanceProfileCommand')).toBe(3);
  });

  it('UserToGroupAddition: a user in `admins` is in the declared `Admins`; one in `Admins2` is not', async () => {
    const read = async (groupOfUser: string): Promise<unknown> => {
      route({
        GetGroupCommand: () => ({ Group: { GroupName: 'Admins', GroupId: 'AGPA-g' }, Users: [] }),
        ListGroupsForUserCommand: () => ({ Groups: [{ GroupName: groupOfUser }] }),
      });
      return new IAMUserGroupProvider().readCurrentState(
        'Addition',
        'Addition',
        'AWS::IAM::UserToGroupAddition',
        { GroupName: 'Admins', Users: ['alice'] }
      );
    };
    expect(await read('admins')).toMatchObject({ Users: ['alice'] });
    expect(await read('Admins2')).toMatchObject({ Users: [] });
  });
});

describe('attachment lists are unordered sets, compared without case folding or de-duplication', () => {
  const drift = (
    type: string,
    unordered: string[],
    baseline: Record<string, unknown>,
    aws: Record<string, unknown>
  ): string[] =>
    calculateResourceDrift(baseline, aws, { unorderedPaths: unordered, resourceType: type }).map(
      (d) => d.path
    );

  it('managed policy Roles / Users / Groups: order only is no drift', () => {
    const unordered = new IAMManagedPolicyProvider().getDriftUnorderedPaths(
      'AWS::IAM::ManagedPolicy'
    );
    expect(unordered).toEqual(['Roles', 'Users', 'Groups']);
    expect(
      drift('AWS::IAM::ManagedPolicy', unordered, { Roles: ['b', 'a'] }, { Roles: ['a', 'b'] })
    ).toEqual([]);
  });

  it('managed policy: a name differing beyond case, or only in case, is drift; a repeated entry is too', () => {
    const unordered = ['Roles', 'Users', 'Groups'];
    expect(
      drift('AWS::IAM::ManagedPolicy', unordered, { Roles: ['a', 'b'] }, { Roles: ['a', 'c'] })
    ).toEqual(['Roles']);
    // No case fold in the comparison: strict, never hiding a change.
    expect(
      drift('AWS::IAM::ManagedPolicy', unordered, { Roles: ['My-Role'] }, { Roles: ['my-role'] })
    ).toEqual(['Roles']);
    // IAM lists a repeated attachment once (measured); the sort keeps both
    // sides as written, so a template repeating a name is not equated with
    // IAM's single entry (strict).
    expect(
      drift('AWS::IAM::ManagedPolicy', unordered, { Roles: ['a', 'a'] }, { Roles: ['a'] })
    ).toEqual(['Roles']);
  });

  it('a User Groups list: order only is no drift; another group is drift', () => {
    const provider = new IAMUserGroupProvider();
    const unordered = provider.getDriftUnorderedPaths('AWS::IAM::User');
    expect(unordered).toEqual(['Groups']);
    expect(provider.getDriftUnorderedPaths('AWS::IAM::Group')).toEqual([]);
    expect(
      drift('AWS::IAM::User', unordered, { Groups: ['g2', 'g1'] }, { Groups: ['g1', 'g2'] })
    ).toEqual([]);
    expect(
      drift('AWS::IAM::User', unordered, { Groups: ['g1', 'g2'] }, { Groups: ['g1', 'g3'] })
    ).toEqual(['Groups']);
  });
});

describe('AWS::IAM::Policy update folds', () => {
  const TYPE = 'AWS::IAM::Policy';
  const DOC = { Version: '2012-10-17', Statement: [] };
  const writes = (): string[] =>
    sent
      .filter((s) => /^(Put|Delete)RolePolicyCommand$/.test(s.name))
      .map((s) => `${s.name.replace(/Command$/, '')} ${String(s.input['RoleName'])} ${String(s.input['PolicyName'])}`);

  it('a rename differing beyond case removes the old name from a retained role', async () => {
    route({});
    await new IAMPolicyProvider().update(
      'P',
      'MyPolicy',
      TYPE,
      { PolicyName: 'MyPolicy2', PolicyDocument: DOC, Roles: ['kept'] },
      { PolicyName: 'MyPolicy', PolicyDocument: DOC, Roles: ['kept'] }
    );
    expect(writes()).toEqual(['PutRolePolicy kept MyPolicy2', 'DeleteRolePolicy kept MyPolicy']);
  });

  it('a role differing beyond case is a leaver and loses the policy; a case-only one stays', async () => {
    route({});
    await new IAMPolicyProvider().update(
      'P',
      'pol',
      TYPE,
      { PolicyName: 'pol', PolicyDocument: DOC, Roles: ['rolea', 'RoleB2'] },
      { PolicyName: 'pol', PolicyDocument: DOC, Roles: ['RoleA', 'RoleB'] }
    );
    expect(writes()).toEqual([
      'PutRolePolicy rolea pol',
      'PutRolePolicy RoleB2 pol',
      'DeleteRolePolicy RoleB pol',
    ]);
  });
});

describe('AWS::IAM::Role inline Policies are paired by exact name', () => {
  it('a live inline policy in another case is listed under its own name (strict, never hidden)', async () => {
    const doc = { Version: '2012-10-17', Statement: [] };
    route({
      GetRoleCommand: () => ({
        Role: {
          RoleName: 'r',
          RoleId: 'AROA-r',
          Arn: 'arn:aws:iam::1:role/r',
          Path: '/',
          AssumeRolePolicyDocument: encodeURIComponent(JSON.stringify(doc)),
        },
      }),
      ListRolePoliciesCommand: () => ({ PolicyNames: ['casepol'] }),
      GetRolePolicyCommand: (input) => ({
        PolicyName: input['PolicyName'],
        PolicyDocument: encodeURIComponent(JSON.stringify(doc)),
      }),
    });
    const state = (await new IAMRoleProvider().readCurrentState('r', 'R', 'AWS::IAM::Role', {
      Policies: [{ PolicyName: 'CasePol', PolicyDocument: doc }],
    })) as Record<string, unknown>;
    expect(state['Policies']).toEqual([{ PolicyName: 'casepol', PolicyDocument: doc }]);
    expect(
      calculateResourceDrift(
        { Policies: [{ PolicyName: 'CasePol', PolicyDocument: doc }] },
        { Policies: state['Policies'] },
        { resourceType: 'AWS::IAM::Role' }
      ).map((d) => d.path)
    ).toEqual(['Policies']);
  });
});
