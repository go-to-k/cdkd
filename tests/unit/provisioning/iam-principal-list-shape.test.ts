/**
 * A recorded or desired IAM principal list that is not a list of IAM names is
 * refused before ANY call (go-to-k/cdkd#3906, go-to-k/cdkd#3888):
 * `AWS::IAM::ManagedPolicy` `Groups` / `Roles` / `Users`,
 * `AWS::IAM::InstanceProfile` `Roles`, `AWS::IAM::User` `Groups` and
 * `AWS::IAM::UserToGroupAddition` `Users`. Each used to be cast and iterated,
 * so a string was walked by character: a rollback revert or `drift --revert`
 * (whose DESIRED side is a recorded bag) ATTACHED a managed policy to, or put a
 * role into an instance profile for, one-letter principals; a delete removed
 * one-letter users from a group. A valid list still sends exactly the expected
 * calls, and a SECRET-DERIVED recorded list (a dynamic reference or its mask,
 * which cdkd keeps in state by design) is read from IAM instead wherever a live
 * source exists.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const mockSend = vi.fn();

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    iam: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
  }),
}));

const warnSpy = vi.hoisted(() => vi.fn());
vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: warnSpy,
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

import { IAMManagedPolicyProvider } from '../../../src/provisioning/providers/iam-managed-policy-provider.js';
import { IAMInstanceProfileProvider } from '../../../src/provisioning/providers/iam-instance-profile-provider.js';
import {
  IAMUserGroupProvider,
  MEMBERSHIP_MALFORMED_USERS_SKIP_REASON,
} from '../../../src/provisioning/providers/iam-user-group-provider.js';

/**
 * Each malformed shape of one list. Every value carries the marker `Zq`, so a
 * message echoing record content is caught for every shape.
 */
const MALFORMED_VALUES: Array<[string, unknown]> = [
  ['a string', 'AdminRoleZq'],
  ['an object', { leakZq: 'valueZq' }],
  ['a non-string entry', ['okZq', 7]],
  ["a name outside IAM's character set", ['arn:aws:iam::1:role/xZq']],
];
const LEAK = 'Zq';
const SECRET_DERIVED: Array<[string, unknown]> = [
  ['a dynamic reference entry', ['{{resolve:secretsmanager:app:SecretString:role}}']],
  ["cdkd's mask", ['***']],
  ['a bare-string dynamic reference', '{{resolve:secretsmanager:app:SecretString:role}}'],
  ['a nested dynamic reference', [{ ref: '{{resolve:secretsmanager:app:SecretString:role}}' }]],
];
const READ_LIVE = 'cdkd reads it from IAM instead once every other list is well-formed';

/** `[command name, input]` for every call, in order. */
const calls = (): Array<[string, Record<string, unknown>]> =>
  mockSend.mock.calls.map((c) => {
    const cmd = c[0] as { constructor: { name: string }; input: Record<string, unknown> };
    return [cmd.constructor.name, cmd.input];
  });
const only = (pattern: RegExp) => calls().filter(([name]) => pattern.test(name));
/** The rejection's message, or a failure when the call resolved. */
const failure = async (p: Promise<unknown>): Promise<string> =>
  p.then(
    () => {
      throw new Error('expected a rejection');
    },
    (e: unknown) => (e as Error).message
  );

/** What the live reads answer; a test overrides one to fail it or to name principals. */
let live: Record<string, unknown>;

beforeEach(() => {
  mockSend.mockReset();
  warnSpy.mockReset();
  live = {
    ListEntitiesForPolicyCommand: { PolicyGroups: [], PolicyRoles: [], PolicyUsers: [] },
    GetInstanceProfileCommand: {
      InstanceProfile: { Arn: 'arn:aws:iam::111122223333:instance-profile/ip', Roles: [] },
    },
    ListGroupsForUserCommand: { Groups: [] },
  };
  mockSend.mockImplementation(
    async (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => {
    const name = cmd.constructor.name;
    if (Object.hasOwn(live, name)) {
      const entry = live[name];
      // A function answers per request, for the pagination cases.
      const answer = typeof entry === 'function' ? (entry as (i: unknown) => unknown)(cmd.input) : entry;
      if (answer instanceof Error) throw answer;
      return answer;
    }
    switch (name) {
      case 'CreatePolicyCommand':
        return { Policy: { Arn: 'arn:aws:iam::111122223333:policy/pol' } };
      case 'CreateInstanceProfileCommand':
        return { InstanceProfile: { Arn: 'arn:aws:iam::111122223333:instance-profile/ip' } };
      case 'CreateUserCommand':
      case 'GetUserCommand':
        return { User: { Arn: 'arn:aws:iam::111122223333:user/u' } };
      default:
        return {};
    }
  });
});
/** Two pages: `first` with a Marker, then `second`. */
const paged =
  (first: Record<string, unknown>, second: Record<string, unknown>) =>
  (input: unknown): unknown =>
    (input as { Marker?: string }).Marker === 'm2' ? second : { ...first, IsTruncated: true, Marker: 'm2' };

// ─── AWS::IAM::ManagedPolicy ──────────────────────────────────────────

describe('IAMManagedPolicyProvider (go-to-k/cdkd#3906)', () => {
  const TYPE = 'AWS::IAM::ManagedPolicy';
  const ARN = 'arn:aws:iam::111122223333:policy/pol';
  const DOC = { Version: '2012-10-17', Statement: [] };
  const base = { ManagedPolicyName: 'pol', PolicyDocument: DOC };

  describe.each(['Groups', 'Roles', 'Users'])('%s', (key) => {
    it.each(MALFORMED_VALUES)('create: %s sends nothing', async (_what, value) => {
      const msg = await failure(
        new IAMManagedPolicyProvider().create('MP', TYPE, { ...base, [key]: value })
      );
      expect(msg).toContain(`${key} of IAM managed policy MP is not a list of IAM names`);
      expect(msg).not.toContain(LEAK);
      expect(mockSend).not.toHaveBeenCalled();
    });

    it.each(MALFORMED_VALUES)(
      'update: %s on the DESIRED side (a rollback revert replays a recorded bag) sends nothing',
      async (_what, value) => {
        const msg = await failure(
          new IAMManagedPolicyProvider().update(
            'MP',
            ARN,
            TYPE,
            { ...base, [key]: value },
            { ...base, [key]: ['real'] }
          )
        );
        expect(msg).toContain(`desired ${key} of IAM managed policy MP is not a list`);
        // The desired side gets no state.json repair.
        expect(msg).not.toContain('state.json');
        expect(msg).not.toContain(LEAK);
        expect(mockSend).not.toHaveBeenCalled();
      }
    );

    it.each(MALFORMED_VALUES)(
      'update: %s on the RECORDED side sends nothing and names the state repair',
      async (_what, value) => {
        const msg = await failure(
          new IAMManagedPolicyProvider().update(
            'MP',
            ARN,
            TYPE,
            { ...base, [key]: ['real'] },
            { ...base, [key]: value }
          )
        );
        expect(msg).toContain(
          `recorded ${key} of IAM managed policy MP is not a list of IAM names — no managed ` +
            `policy was attached, detached or replaced: repair the recorded ${key} in state.json ` +
            'to a list of group / role / user names and re-run'
        );
        expect(msg).not.toContain(LEAK);
        expect(mockSend).not.toHaveBeenCalled();
      }
    );

    it.each(SECRET_DERIVED)(
      'update: a recorded %s is read from IAM ADD-only: the missing name is attached, nothing is detached',
      async (_what, value) => {
        live['ListEntitiesForPolicyCommand'] = {
          PolicyGroups: [{ GroupName: 'g-live' }, { GroupName: 'g-elsewhere' }],
          PolicyRoles: [{ RoleName: 'r-live' }, { RoleName: 'r-elsewhere' }],
          PolicyUsers: [{ UserName: 'u-live' }, { UserName: 'u-elsewhere' }],
        };
        const kinds = { Groups: ['g-live'], Roles: ['r-live'], Users: ['u-live'] };
        const p = key[0]!.toLowerCase();
        await new IAMManagedPolicyProvider().update(
          'MP',
          ARN,
          TYPE,
          { ...base, ...kinds, [key]: [`${p}-live`, 'real'] },
          { ...base, ...kinds, [key]: value }
        );
        const singular = { Groups: 'Group', Roles: 'Role', Users: 'User' }[key]!;
        // `*-elsewhere` is attached by another route (a Role's
        // ManagedPolicyArns, another stack): never detached on IAM's evidence.
        expect(calls()).toEqual([
          ['ListEntitiesForPolicyCommand', { PolicyArn: ARN }],
          [`Attach${singular}PolicyCommand`, { [`${singular}Name`]: 'real', PolicyArn: ARN }],
        ]);
        expect(String(warnSpy.mock.calls[0]?.[0])).toContain('cdkd detaches none of them');
      }
    );
  });

  it('update: only the secret-derived kind comes from IAM; a well-formed recorded kind keeps the record', async () => {
    // Users is recorded ABSENT and IAM holds an attachment made elsewhere: not
    // detached. Roles is recorded well-formed and diffed from the record.
    live['ListEntitiesForPolicyCommand'] = {
      PolicyGroups: [],
      PolicyRoles: [],
      PolicyUsers: [{ UserName: 'attachedElsewhere' }],
    };
    await new IAMManagedPolicyProvider().update(
      'MP',
      ARN,
      TYPE,
      { ...base, Groups: ['g1'], Roles: ['kept'] },
      { ...base, Groups: ['***'], Roles: ['kept', 'dropped'] }
    );
    expect(calls()).toEqual([
      ['ListEntitiesForPolicyCommand', { PolicyArn: ARN }],
      ['AttachGroupPolicyCommand', { GroupName: 'g1', PolicyArn: ARN }],
      ['DetachRolePolicyCommand', { RoleName: 'dropped', PolicyArn: ARN }],
    ]);
  });

  it('update: no warning when IAM names nothing the template does not', async () => {
    live['ListEntitiesForPolicyCommand'] = {
      PolicyGroups: [],
      PolicyRoles: [{ RoleName: 'r1' }],
      PolicyUsers: [],
    };
    await new IAMManagedPolicyProvider().update(
      'MP',
      ARN,
      TYPE,
      { ...base, Roles: ['r1', 'r2'] },
      { ...base, Roles: ['***'] }
    );
    expect(only(/^(Attach|Detach)/)).toEqual([['AttachRolePolicyCommand', { RoleName: 'r2', PolicyArn: ARN }]]);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('update: the live read follows every page', async () => {
    live['ListEntitiesForPolicyCommand'] = paged(
      { PolicyGroups: [], PolicyRoles: [{ RoleName: 'r1' }], PolicyUsers: [] },
      { PolicyGroups: [], PolicyRoles: [{ RoleName: 'r2' }], PolicyUsers: [] }
    );
    await new IAMManagedPolicyProvider().update(
      'MP',
      ARN,
      TYPE,
      { ...base, Roles: ['r1', 'r2'] },
      { ...base, Roles: ['***'] }
    );
    // r2 is on page 2: already attached, so nothing is sent for it.
    expect(calls()).toEqual([
      ['ListEntitiesForPolicyCommand', { PolicyArn: ARN }],
      ['ListEntitiesForPolicyCommand', { PolicyArn: ARN, Marker: 'm2' }],
    ]);
  });

  it('update: a secret-derived recorded list does not block a replacement, which reads nothing live', async () => {
    await new IAMManagedPolicyProvider().update(
      'MP',
      ARN,
      TYPE,
      { ...base, ManagedPolicyName: 'renamed', Roles: ['real'] },
      { ...base, Roles: ['***'] }
    );
    expect(only(/^CreatePolicy|^AttachRolePolicy/)).toEqual([
      ['CreatePolicyCommand', expect.objectContaining({ PolicyName: 'renamed' })],
      ['AttachRolePolicyCommand', { RoleName: 'real', PolicyArn: ARN }],
    ]);
    expect(calls()[0]![0]).toBe('CreatePolicyCommand');
  });

  it('update: a failed live read refuses with nothing written', async () => {
    live['ListEntitiesForPolicyCommand'] = new Error('AccessDenied');
    const msg = await failure(
      new IAMManagedPolicyProvider().update(
        'MP',
        ARN,
        TYPE,
        { ...base, Roles: ['real'] },
        { ...base, Roles: ['***'] }
      )
    );
    expect(msg).toContain(
      "the recorded Roles of IAM managed policy MP is secret-derived and the policy's " +
        'attachments could not be read from IAM — no managed policy was attached or detached'
    );
    expect(calls().map(([n]) => n)).toEqual(['ListEntitiesForPolicyCommand']);
  });

  it('update: a secret-derived recorded list beside a malformed DESIRED side is not read live', async () => {
    const msg = await failure(
      new IAMManagedPolicyProvider().update(
        'MP',
        ARN,
        TYPE,
        { ...base, Roles: 'AdminRoleZq' },
        { ...base, Roles: ['***'] }
      )
    );
    expect(msg).toContain('desired Roles / recorded Roles of IAM managed policy MP');
    expect(msg).toContain(`the recorded Roles is secret-derived`);
    expect(msg).toContain(READ_LIVE);
    expect(msg).not.toContain(LEAK);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('update: a secret-derived recorded list beside a PLAIN malformed one is refused, naming each', async () => {
    const msg = await failure(
      new IAMManagedPolicyProvider().update(
        'MP',
        ARN,
        TYPE,
        { ...base, Roles: ['real'], Users: ['u'] },
        { ...base, Roles: ['***'], Users: 'AdminRoleZq' }
      )
    );
    expect(msg).toContain('recorded Roles / recorded Users of IAM managed policy MP');
    expect(msg).toContain('repair the recorded Users in state.json');
    expect(msg).toContain(`the recorded Roles is secret-derived`);
    expect(msg).not.toContain('repair the recorded Roles');
    expect(msg).not.toContain(LEAK);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('update: both sides malformed name every kind in one message', async () => {
    const msg = await failure(
      new IAMManagedPolicyProvider().update(
        'MP',
        ARN,
        TYPE,
        { ...base, Roles: 'AdminRoleZq' },
        { ...base, Users: { leakZq: 1 } }
      )
    );
    expect(msg).toMatch(
      /^desired Roles \/ recorded Users of IAM managed policy MP is not a list of IAM names — no managed policy was attached, detached or replaced: repair the recorded Users in state\.json/
    );
    expect(msg).not.toContain(LEAK);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('update: a malformed RECORDED list refuses even a replacement, before its CreatePolicy', async () => {
    await expect(
      new IAMManagedPolicyProvider().update(
        'MP',
        ARN,
        TYPE,
        { ...base, ManagedPolicyName: 'renamed', Roles: ['real'] },
        { ...base, Roles: 'AdminRole' }
      )
    ).rejects.toThrow('recorded Roles of IAM managed policy MP is not a list of IAM names');
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('create: a valid list attaches exactly the listed principals, a null list read as absent', async () => {
    await new IAMManagedPolicyProvider().create('MP', TYPE, {
      ...base,
      Groups: ['g1'],
      Roles: null,
      Users: ['u1', 'u2'],
    });
    expect(only(/^(Attach|Detach)/)).toEqual([
      ['AttachGroupPolicyCommand', { GroupName: 'g1', PolicyArn: ARN }],
      ['AttachUserPolicyCommand', { UserName: 'u1', PolicyArn: ARN }],
      ['AttachUserPolicyCommand', { UserName: 'u2', PolicyArn: ARN }],
    ]);
  });

  it('update: valid lists attach and detach exactly the difference, reading nothing live', async () => {
    await new IAMManagedPolicyProvider().update(
      'MP',
      ARN,
      TYPE,
      { ...base, Roles: ['keep', 'added'], Users: [] },
      { ...base, Roles: ['keep', 'removed'], Users: ['gone'] }
    );
    expect(calls()).toEqual([
      ['AttachRolePolicyCommand', { RoleName: 'added', PolicyArn: ARN }],
      ['DetachRolePolicyCommand', { RoleName: 'removed', PolicyArn: ARN }],
      ['DetachUserPolicyCommand', { UserName: 'gone', PolicyArn: ARN }],
    ]);
  });
});

// ─── AWS::IAM::InstanceProfile ────────────────────────────────────────

describe('IAMInstanceProfileProvider (go-to-k/cdkd#3906)', () => {
  const TYPE = 'AWS::IAM::InstanceProfile';

  it.each(MALFORMED_VALUES)('create: %s sends nothing', async (_what, value) => {
    const msg = await failure(
      new IAMInstanceProfileProvider().create('IP', TYPE, { InstanceProfileName: 'ip', Roles: value })
    );
    expect(msg).toContain('Roles of IAM instance profile IP is not a list of IAM role names');
    expect(msg).not.toContain(LEAK);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it.each(MALFORMED_VALUES)(
    'update: %s on the DESIRED side (a rollback revert replays a recorded bag) sends nothing',
    async (_what, value) => {
      const msg = await failure(
        new IAMInstanceProfileProvider().update('IP', 'ip', TYPE, { Roles: value }, { Roles: ['real'] })
      );
      expect(msg).toContain(
        'desired Roles of IAM instance profile IP is not a list of IAM role names — no role was ' +
          'added or removed'
      );
      expect(msg).not.toContain(LEAK);
      expect(mockSend).not.toHaveBeenCalled();
    }
  );

  it.each(MALFORMED_VALUES)('update: %s on the RECORDED side sends nothing', async (_what, value) => {
    const msg = await failure(
      new IAMInstanceProfileProvider().update('IP', 'ip', TYPE, { Roles: ['real'] }, { Roles: value })
    );
    expect(msg).toContain(
      'recorded Roles of IAM instance profile IP is not a list of IAM role names — no role was ' +
        'added or removed: repair the recorded Roles in state.json to a list of role names and re-run'
    );
    expect(msg).not.toContain(LEAK);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it.each(SECRET_DERIVED)(
    'update: a recorded %s is read from IAM, and exactly the diff against IAM is sent',
    async (_what, value) => {
      live['GetInstanceProfileCommand'] = { InstanceProfile: { Roles: [{ RoleName: 'LiveRole' }] } };
      await new IAMInstanceProfileProvider().update(
        'IP',
        'ip',
        TYPE,
        { Roles: ['NewRole'] },
        { Roles: value }
      );
      expect(only(/Role|GetInstanceProfile/)).toEqual([
        ['GetInstanceProfileCommand', { InstanceProfileName: 'ip' }],
        ['RemoveRoleFromInstanceProfileCommand', { InstanceProfileName: 'ip', RoleName: 'LiveRole' }],
        ['AddRoleToInstanceProfileCommand', { InstanceProfileName: 'ip', RoleName: 'NewRole' }],
        ['GetInstanceProfileCommand', { InstanceProfileName: 'ip' }],
      ]);
    }
  );

  it('update: a failed live read refuses with nothing written', async () => {
    live['GetInstanceProfileCommand'] = new Error('AccessDenied');
    const msg = await failure(
      new IAMInstanceProfileProvider().update('IP', 'ip', TYPE, { Roles: ['NewRole'] }, { Roles: ['***'] })
    );
    expect(msg).toContain(
      "the recorded Roles of IAM instance profile IP is secret-derived and the profile's roles " +
        'could not be read from IAM — no role was added or removed'
    );
    expect(calls().map(([n]) => n)).toEqual(['GetInstanceProfileCommand']);
  });

  it('update: a secret-derived recorded Roles beside a malformed DESIRED side is not read live', async () => {
    const msg = await failure(
      new IAMInstanceProfileProvider().update('IP', 'ip', TYPE, { Roles: 'AdminRoleZq' }, { Roles: ['***'] })
    );
    expect(msg).toContain('desired Roles / recorded Roles of IAM instance profile IP');
    expect(msg).toContain(READ_LIVE);
    expect(msg).not.toContain(LEAK);
    // Refused before GetInstanceProfile: nothing is sent.
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('create: a valid list adds exactly its role', async () => {
    await new IAMInstanceProfileProvider().create('IP', TYPE, {
      InstanceProfileName: 'ip',
      Roles: ['r1'],
    });
    expect(only(/Role/)).toEqual([
      ['AddRoleToInstanceProfileCommand', { InstanceProfileName: 'ip', RoleName: 'r1' }],
    ]);
  });

  it('update: a valid swap removes the old role and adds the new one, and nothing else', async () => {
    await new IAMInstanceProfileProvider().update(
      'IP',
      'ip',
      TYPE,
      { Roles: ['NewRole'] },
      { Roles: ['OldRole'] }
    );
    expect(calls()).toEqual([
      ['RemoveRoleFromInstanceProfileCommand', { InstanceProfileName: 'ip', RoleName: 'OldRole' }],
      ['AddRoleToInstanceProfileCommand', { InstanceProfileName: 'ip', RoleName: 'NewRole' }],
      ['GetInstanceProfileCommand', { InstanceProfileName: 'ip' }],
    ]);
  });

  it('update: an unchanged role is neither removed nor re-added (no substring test)', async () => {
    await new IAMInstanceProfileProvider().update(
      'IP',
      'ip',
      TYPE,
      { Roles: ['AdminRole'] },
      { Roles: ['AdminRole'] }
    );
    expect(only(/Role/)).toEqual([]);
  });

  it('update: a desired list naming a prefix of the recorded role still swaps (no substring test)', async () => {
    await new IAMInstanceProfileProvider().update(
      'IP',
      'ip',
      TYPE,
      { Roles: ['Admin'] },
      { Roles: ['AdminRole'] }
    );
    expect(only(/Role/)).toEqual([
      ['RemoveRoleFromInstanceProfileCommand', { InstanceProfileName: 'ip', RoleName: 'AdminRole' }],
      ['AddRoleToInstanceProfileCommand', { InstanceProfileName: 'ip', RoleName: 'Admin' }],
    ]);
  });
});

// ─── AWS::IAM::User Groups ────────────────────────────────────────────

describe('IAMUserGroupProvider AWS::IAM::User Groups (go-to-k/cdkd#3888)', () => {
  const TYPE = 'AWS::IAM::User';

  it.each(MALFORMED_VALUES)('create: %s sends nothing', async (_what, value) => {
    const msg = await failure(
      new IAMUserGroupProvider().create('U', TYPE, { UserName: 'u', Groups: value })
    );
    expect(msg).toContain('Groups of IAM user U is not a list of IAM group names — no user was created');
    expect(msg).not.toContain(LEAK);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it.each(MALFORMED_VALUES)(
    'update: %s on the DESIRED side (a rollback revert replays a recorded bag) sends nothing',
    async (_what, value) => {
      const msg = await failure(
        new IAMUserGroupProvider().update('U', 'u', TYPE, { Groups: value }, { Groups: ['g'] })
      );
      expect(msg).toContain('desired Groups of IAM user U is not a list of group names');
      expect(msg).not.toContain(LEAK);
      expect(mockSend).not.toHaveBeenCalled();
    }
  );

  it.each(MALFORMED_VALUES)('update: %s on the RECORDED side sends nothing', async (_what, value) => {
    const msg = await failure(
      new IAMUserGroupProvider().update('U', 'u', TYPE, { Groups: ['g'] }, { Groups: value })
    );
    expect(msg).toContain(
      'recorded Groups of IAM user U is not a list of group names — no group membership, tag, ' +
        'policy or login profile was changed: repair the recorded Groups in state.json to a list ' +
        'of group names and re-run'
    );
    expect(msg).not.toContain(LEAK);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it.each(SECRET_DERIVED)(
    'update: a recorded %s is read from IAM ADD-only: the user joins the missing group, leaves none',
    async (_what, value) => {
      // viaUTGA is a membership another resource made: never removed on IAM's evidence.
      live['ListGroupsForUserCommand'] = { Groups: [{ GroupName: 'g-live' }, { GroupName: 'viaUTGA' }] };
      await new IAMUserGroupProvider().update(
        'U',
        'u',
        TYPE,
        { Groups: ['g-live', 'NewGroup'] },
        { Groups: value }
      );
      expect(only(/Group/)).toEqual([
        ['ListGroupsForUserCommand', { UserName: 'u' }],
        ['AddUserToGroupCommand', { UserName: 'u', GroupName: 'NewGroup' }],
      ]);
      expect(String(warnSpy.mock.calls[0]?.[0])).toContain('cdkd removes the user from none of them');
    }
  );

  it('update: no warning when IAM names no group the template does not', async () => {
    live['ListGroupsForUserCommand'] = { Groups: [{ GroupName: 'g1' }] };
    await new IAMUserGroupProvider().update('U', 'u', TYPE, { Groups: ['g1', 'g2'] }, { Groups: ['***'] });
    expect(only(/^(Add|Remove)UserToGroup|^RemoveUserFromGroup/)).toEqual([
      ['AddUserToGroupCommand', { UserName: 'u', GroupName: 'g2' }],
    ]);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('update: the live group read follows every page', async () => {
    live['ListGroupsForUserCommand'] = paged(
      { Groups: [{ GroupName: 'g1' }] },
      { Groups: [{ GroupName: 'g2' }] }
    );
    await new IAMUserGroupProvider().update('U', 'u', TYPE, { Groups: ['g1', 'g2'] }, { Groups: ['***'] });
    expect(only(/Group/)).toEqual([
      ['ListGroupsForUserCommand', { UserName: 'u' }],
      ['ListGroupsForUserCommand', { UserName: 'u', Marker: 'm2' }],
    ]);
  });

  it('update: a failed live read refuses with nothing written', async () => {
    live['ListGroupsForUserCommand'] = new Error('AccessDenied');
    const msg = await failure(
      new IAMUserGroupProvider().update(
        'U',
        'u',
        TYPE,
        { Groups: ['g'], Tags: [{ Key: 'k', Value: 'v' }] },
        { Groups: ['***'] }
      )
    );
    expect(msg).toContain(
      'the recorded Groups of IAM user U is secret-derived and could not be read from IAM — no ' +
        'group membership, tag, policy or login profile was changed'
    );
    expect(calls().map(([n]) => n)).toEqual(['ListGroupsForUserCommand']);
  });

  it('update: a secret-derived recorded Groups beside a malformed DESIRED side is not read live', async () => {
    const msg = await failure(
      new IAMUserGroupProvider().update('U', 'u', TYPE, { Groups: 'AdminRoleZq' }, { Groups: ['***'] })
    );
    expect(msg).toContain('desired Groups / recorded Groups of IAM user U');
    expect(msg).toContain(READ_LIVE);
    expect(msg).not.toContain(LEAK);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('update: a malformed recorded Groups changes nothing else either (tags included)', async () => {
    await expect(
      new IAMUserGroupProvider().update(
        'U',
        'u',
        TYPE,
        { Groups: ['g'], Tags: [{ Key: 'k', Value: 'v' }] },
        { Groups: 'AdminRole' }
      )
    ).rejects.toThrow('recorded Groups of IAM user U is not a list of group names');
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('create: a valid list adds the user to exactly its groups', async () => {
    await new IAMUserGroupProvider().create('U', TYPE, { UserName: 'u', Groups: ['g1', 'g2'] });
    expect(only(/Group/)).toEqual([
      ['AddUserToGroupCommand', { UserName: 'u', GroupName: 'g1' }],
      ['AddUserToGroupCommand', { UserName: 'u', GroupName: 'g2' }],
    ]);
  });

  it('update: valid lists add and remove exactly the difference, reading nothing live', async () => {
    await new IAMUserGroupProvider().update(
      'U',
      'u',
      TYPE,
      { Groups: ['keep', 'added'] },
      { Groups: ['keep', 'removed'] }
    );
    expect(only(/Group/)).toEqual([
      ['AddUserToGroupCommand', { UserName: 'u', GroupName: 'added' }],
      ['RemoveUserFromGroupCommand', { UserName: 'u', GroupName: 'removed' }],
    ]);
  });
});

// ─── AWS::IAM::UserToGroupAddition ────────────────────────────────────

describe('IAMUserGroupProvider AWS::IAM::UserToGroupAddition (go-to-k/cdkd#3888)', () => {
  const TYPE = 'AWS::IAM::UserToGroupAddition';

  it.each(MALFORMED_VALUES)('create: %s sends nothing', async (_what, value) => {
    const msg = await failure(
      new IAMUserGroupProvider().create('M', TYPE, { GroupName: 'grp', Users: value })
    );
    expect(msg).toContain('Users of IAM UserToGroupAddition M is not a list of IAM user names');
    expect(msg).not.toContain(LEAK);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it.each<[string, Record<string, unknown>]>([
    ['an empty Users', { GroupName: 'grp', Users: [] }],
    ['no Users', { GroupName: 'grp' }],
  ])('create: %s is refused with no call', async (_what, properties) => {
    await expect(new IAMUserGroupProvider().create('M', TYPE, properties)).rejects.toThrow(
      'Users is required for M'
    );
    expect(mockSend).not.toHaveBeenCalled();
  });

  it.each(MALFORMED_VALUES)(
    'update: %s on the DESIRED side (a rollback revert replays a recorded bag) sends nothing',
    async (_what, value) => {
      const msg = await failure(
        new IAMUserGroupProvider().update(
          'M',
          'M',
          TYPE,
          { GroupName: 'grp', Users: value },
          { GroupName: 'grp', Users: ['alice'] }
        )
      );
      expect(msg).toContain(
        'desired Users of IAM UserToGroupAddition M is not a list of user names — no user was ' +
          'added to or removed from a group'
      );
      expect(msg).not.toContain(LEAK);
      expect(mockSend).not.toHaveBeenCalled();
    }
  );

  it.each(MALFORMED_VALUES)('update: %s on the RECORDED side sends nothing', async (_what, value) => {
    const msg = await failure(
      new IAMUserGroupProvider().update(
        'M',
        'M',
        TYPE,
        { GroupName: 'grp', Users: ['alice'] },
        { GroupName: 'grp', Users: value }
      )
    );
    expect(msg).toContain(
      'recorded Users of IAM UserToGroupAddition M is not a list of user names — no user was ' +
        'added to or removed from a group: repair the recorded Users in state.json to a list of ' +
        'user names and re-run'
    );
    expect(msg).not.toContain(LEAK);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it.each(SECRET_DERIVED)(
    'update: a recorded %s has no live source, so it is refused with its way out',
    async (_what, value) => {
      const msg = await failure(
        new IAMUserGroupProvider().update(
          'M',
          'M',
          TYPE,
          { GroupName: 'grp', Users: ['alice'] },
          { GroupName: 'grp', Users: value }
        )
      );
      expect(msg).toContain(
        'the recorded Users is secret-derived (cdkd keeps the dynamic reference or its mask in ' +
          'state), so do not write the name into state.json; cdkd cannot diff it, so make the ' +
          "membership change by hand, then drop this record with 'cdkd orphan <constructPath>' " +
          'so the next deploy re-creates it from the template'
      );
      expect(msg).not.toContain('repair the recorded');
      expect(mockSend).not.toHaveBeenCalled();
    }
  );

  it.each(MALFORMED_VALUES)('delete: %s is SKIPPED with no call', async (_what, value) => {
    const result = await new IAMUserGroupProvider().delete('M', 'M', TYPE, {
      GroupName: 'grp',
      Users: value,
    });
    expect(result).toEqual({ outcome: 'skipped', reason: MEMBERSHIP_MALFORMED_USERS_SKIP_REASON });
    expect(mockSend).not.toHaveBeenCalled();
    const warned = String(warnSpy.mock.calls[0]?.[0]);
    expect(warned).toContain(
      'Repair the recorded Users in state.json to a list of user names and re-run'
    );
    expect(warned).toContain('UNLESS the group or the users are themselves part of this stack');
    // `cdkd state orphan` drops the WHOLE stack's record, so the plain repair
    // names it only inside the UNLESS clause (this arm is also reached from a
    // deploy).
    expect(warned.split('cdkd state orphan').length - 1).toBe(1);
    expect(warned).not.toContain(LEAK);
  });

  it.each(SECRET_DERIVED)('delete: a recorded %s is SKIPPED, with the way out stated', async (_what, value) => {
    const result = await new IAMUserGroupProvider().delete('M', 'M', TYPE, {
      GroupName: 'grp',
      Users: value,
    });
    expect(result).toEqual({ outcome: 'skipped', reason: MEMBERSHIP_MALFORMED_USERS_SKIP_REASON });
    expect(mockSend).not.toHaveBeenCalled();
    const warned = String(warnSpy.mock.calls[0]?.[0]);
    expect(warned).toContain('The recorded Users is secret-derived');
    expect(warned).toContain('cdkd will keep skipping this record');
    // The way out when the group and users are OUTSIDE the stack: scoped to
    // the destroy that leaves this as the last record.
    expect(warned).toContain(
      "on cdkd destroy every other resource is still deleted, so once this is the stack's last " +
        "record 'cdkd state orphan <stack> --stack-region <region>' clears it"
    );
    expect(warned).not.toContain('Repair the recorded Users');
  });

  it('create: a valid list adds exactly its users', async () => {
    await new IAMUserGroupProvider().create('M', TYPE, { GroupName: 'grp', Users: ['alice', 'bob'] });
    expect(calls()).toEqual([
      ['AddUserToGroupCommand', { GroupName: 'grp', UserName: 'alice' }],
      ['AddUserToGroupCommand', { GroupName: 'grp', UserName: 'bob' }],
    ]);
  });

  it('update: valid lists add and remove exactly the difference', async () => {
    await new IAMUserGroupProvider().update(
      'M',
      'M',
      TYPE,
      { GroupName: 'grp', Users: ['keep', 'added'] },
      { GroupName: 'grp', Users: ['keep', 'removed'] }
    );
    expect(calls()).toEqual([
      ['AddUserToGroupCommand', { GroupName: 'grp', UserName: 'added' }],
      ['RemoveUserFromGroupCommand', { GroupName: 'grp', UserName: 'removed' }],
    ]);
  });

  it('update: a group change removes the recorded users from the old group and adds the desired ones to the new', async () => {
    await new IAMUserGroupProvider().update(
      'M',
      'M',
      TYPE,
      { GroupName: 'g2', Users: ['bob'] },
      { GroupName: 'g1', Users: ['alice'] }
    );
    expect(calls()).toEqual([
      ['RemoveUserFromGroupCommand', { GroupName: 'g1', UserName: 'alice' }],
      ['AddUserToGroupCommand', { GroupName: 'g2', UserName: 'bob' }],
    ]);
  });

  it('delete: a valid list removes exactly its users', async () => {
    const result = await new IAMUserGroupProvider().delete('M', 'M', TYPE, {
      GroupName: 'grp',
      Users: ['alice'],
    });
    expect(result).toBeUndefined();
    expect(calls()).toEqual([['RemoveUserFromGroupCommand', { GroupName: 'grp', UserName: 'alice' }]]);
  });
});
