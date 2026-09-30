/**
 * `IAMPolicyProvider.create` / `update` / `readCurrentState` read `Roles` /
 * `Groups` / `Users` through the shared reader and refuse a list that is not a
 * list of IAM names BEFORE any call (go-to-k/cdkd#3878). Each used to cast and
 * iterate the value, so a string addressed one-letter principals: a GRANT on
 * the put paths (a rollback replays `update()` with a recorded bag as the
 * desired side), a detach on update, a read of another principal's policy on
 * drift. The delete arm is pinned in `provider-delete-skip-outcome.test.ts`.
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

import { IAMPolicyProvider } from '../../../src/provisioning/providers/iam-policy-provider.js';

const TYPE = 'AWS::IAM::Policy';
const DOC = { Version: '2012-10-17', Statement: [] };

/** A secret-derived recorded list: cdkd keeps the reference or its mask in state (go-to-k/cdkd#3907). */
const SECRET_DERIVED: Array<[string, Record<string, unknown>]> = [
  ['a dynamic-reference entry', { Roles: ['{{resolve:secretsmanager:roles:SecretString:admin}}'] }],
  ['a masked entry', { Groups: ['***'] }],
  ['a dynamic reference in place of the list', { Users: '{{resolve:secretsmanager:users}}' }],
];

/** The note every secret-derived kind carries, pinned verbatim once. */
const SECRET_DERIVED_NOTE =
  'is secret-derived (cdkd keeps the dynamic reference or its mask in state), so do not write ' +
  'the name into state.json';

/** The update refusal's orphan route, with the rename clause when the policy name changes. */
const orphanRoute = (renamed: boolean): string =>
  'IAM has no call that lists the principals holding an inline policy, so cdkd cannot diff ' +
  'it: detach the inline policy by hand from every principal it should no longer be on' +
  (renamed
    ? ', and since this change renames the policy, also remove the OLD-named inline policy ' +
      'from every principal that holds it (the re-created record names only the new one)'
    : '') +
  ", then drop this record with 'cdkd orphan <constructPath>' so the next deploy re-attaches " +
  'it from the template (an attachment left in place across the orphan is no longer tracked ' +
  'by cdkd). A later update proceeds only while the template spells the same reference and ' +
  'PolicyName, so a changed reference, a rename or a mask is refused this way again';

const SECRET_DERIVED_REPAIR = `${SECRET_DERIVED_NOTE}; ${orphanRoute(false)}`;

const DESIRED_SIDE_NOTE =
  "(the desired side is the template's value on a deploy, and the recorded value being " +
  "restored on a rollback revert or 'cdkd drift --revert')";

const MALFORMED: Array<[string, Record<string, unknown>]> = [
  ['a string', { Roles: 'AdminRole' }],
  ['an object beside a valid list', { Roles: ['r1'], Groups: {} }],
  ['a non-string entry', { Users: ['u1', 7] }],
  ['a name outside IAM\'s character set', { Roles: ['arn:aws:iam::1:role/x'] }],
];

/** The command names sent, in order. */
const sent = (): string[] =>
  mockSend.mock.calls.map((c) => (c[0] as { constructor: { name: string } }).constructor.name);

/** The inputs sent, in order. */
const inputs = (): Array<Record<string, unknown>> =>
  mockSend.mock.calls.map((c) => (c[0] as { input: Record<string, unknown> }).input);

beforeEach(() => {
  mockSend.mockReset();
  mockSend.mockResolvedValue({});
});

describe('IAMPolicyProvider.create refuses a malformed principal list', () => {
  it.each(MALFORMED)('%s: throws with no AWS call', async (_what, lists) => {
    await expect(
      new IAMPolicyProvider().create('P', TYPE, { PolicyName: 'pol', PolicyDocument: DOC, ...lists })
    ).rejects.toThrow(/is not a list of IAM names — no inline policy was attached/);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('attaches to exactly the listed principals, with a null list read as absent', async () => {
    await new IAMPolicyProvider().create('P', TYPE, {
      PolicyName: 'pol',
      PolicyDocument: DOC,
      Roles: ['r1'],
      Groups: null,
      Users: ['u1'],
    });
    expect(sent()).toEqual(['PutRolePolicyCommand', 'PutUserPolicyCommand']);
    // The full inputs, as `update` and `delete` assert them: a class name alone
    // passes with the wrong principal or policy name.
    expect(inputs()).toEqual([
      { RoleName: 'r1', PolicyName: 'pol', PolicyDocument: JSON.stringify(DOC) },
      { UserName: 'u1', PolicyName: 'pol', PolicyDocument: JSON.stringify(DOC) },
    ]);
  });
});

describe('IAMPolicyProvider.update refuses a malformed principal list on EITHER side', () => {
  const valid = { PolicyName: 'pol', PolicyDocument: DOC, Roles: ['r1'] };

  it.each(MALFORMED)('%s on the RECORDED side: throws with no AWS call', async (_what, lists) => {
    await expect(
      new IAMPolicyProvider().update('P', 'pol', TYPE, valid, { ...valid, ...lists })
    ).rejects.toThrow(
      /recorded (\w+) of IAM policy P is not a list of IAM names — no inline policy was attached or detached: repair the recorded \1 in state\.json to a list of role \/ group \/ user names and re-run$/
    );
    expect(mockSend).not.toHaveBeenCalled();
  });

  it.each(SECRET_DERIVED)(
    '%s on the RECORDED side: throws with no call, and never asks for the name in state.json',
    async (_what, lists) => {
      const kind = Object.keys(lists)[0]!;
      const error = await new IAMPolicyProvider()
        .update('P', 'pol', TYPE, valid, { ...valid, ...lists })
        .catch((e: unknown) => e);
      const msg = (error as Error).message;
      expect(msg).toBe(
        `recorded ${kind} of IAM policy P is not a list of IAM names — no inline policy was ` +
          `attached or detached: the recorded ${kind} ${SECRET_DERIVED_REPAIR}`
      );
      expect(msg).not.toContain('repair the recorded');
      expect(mockSend).not.toHaveBeenCalled();
    }
  );

  it('with a plain and a secret-derived recorded kind, offers only the orphan route', async () => {
    // A state.json repair of Roles alone would still be refused over Users, so
    // it is not offered beside the route that drops the whole record.
    const error = await new IAMPolicyProvider()
      .update('P', 'pol', TYPE, valid, { ...valid, Roles: 'AdminRole', Users: ['***'] })
      .catch((e: unknown) => e);
    expect((error as Error).message).toBe(
      'recorded Roles / recorded Users of IAM policy P is not a list of IAM names — no inline ' +
        `policy was attached or detached: the recorded Users ${SECRET_DERIVED_NOTE}, and the ` +
        'recorded Roles need not be repaired there either: the route below drops the whole ' +
        `record; ${orphanRoute(false)}`
    );
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('adds the old-name cleanup when the refused update also renames the policy', async () => {
    // After the orphan, create() puts only the NEW name, so the old-named
    // policy would stay on every recorded principal, untracked.
    const error = await new IAMPolicyProvider()
      .update('P', 'old-pol', TYPE, { ...valid, PolicyName: 'new-pol' }, {
        ...valid,
        PolicyName: 'old-pol',
        Roles: ['{{resolve:secretsmanager:roles}}'],
      })
      .catch((e: unknown) => e);
    expect((error as Error).message).toBe(
      'recorded Roles of IAM policy P is not a list of IAM names — no inline policy was ' +
        `attached or detached: the recorded Roles ${SECRET_DERIVED_NOTE}; ${orphanRoute(true)}`
    );
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('sends a secret-derived DESIRED side back to the template', async () => {
    // Only the template's own value reaches this: a deploy refuses a masked
    // attribute read, and a rollback replay re-resolves references and refuses
    // a masked bag, before update() runs.
    const error = await new IAMPolicyProvider()
      .update('P', 'pol', TYPE, { ...valid, Groups: ['***'] }, valid)
      .catch((e: unknown) => e);
    expect((error as Error).message).toBe(
      'desired Groups of IAM policy P is not a list of IAM names — no inline policy was ' +
        `attached or detached ${DESIRED_SIDE_NOTE}: the desired Groups holds a dynamic ` +
        "reference or cdkd's mask that resolved to no names; fix that value in the template"
    );
    expect((error as Error).message).not.toContain('re-run');
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('names BOTH sides when both are malformed, the desired note beside the recorded repair', async () => {
    const error = await new IAMPolicyProvider()
      .update('P', 'pol', TYPE, { ...valid, Groups: {} }, { ...valid, Roles: 'AdminRole' })
      .catch((e: unknown) => e);
    expect((error as Error).message).toBe(
      'desired Groups / recorded Roles of IAM policy P is not a list of IAM names — no inline ' +
        `policy was attached or detached ${DESIRED_SIDE_NOTE}: fix the desired side first, ` +
        'since the repair below re-applies it; then repair the recorded Roles in state.json to ' +
        'a list of role / group / user names and re-run'
    );
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('orders a malformed desired side BEFORE the orphan route of a secret-derived record', async () => {
    const error = await new IAMPolicyProvider()
      .update('P', 'pol', TYPE, { ...valid, Groups: {} }, {
        ...valid,
        Roles: ['{{resolve:secretsmanager:roles}}'],
      })
      .catch((e: unknown) => e);
    const msg = (error as Error).message;
    expect(msg).toBe(
      'desired Groups / recorded Roles of IAM policy P is not a list of IAM names — no inline ' +
        `policy was attached or detached ${DESIRED_SIDE_NOTE}: fix the desired side first, ` +
        `since the repair below re-applies it; then the recorded Roles ${SECRET_DERIVED_NOTE}; ` +
        orphanRoute(false)
    );
    expect(msg.split('refused this way again').length - 1).toBe(1);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('asks for a secret-derived desired side to be fixed in the template first', async () => {
    const error = await new IAMPolicyProvider()
      .update('P', 'pol', TYPE, { ...valid, Groups: ['***'] }, { ...valid, Roles: 'AdminRole' })
      .catch((e: unknown) => e);
    expect((error as Error).message).toBe(
      'desired Groups / recorded Roles of IAM policy P is not a list of IAM names — no inline ' +
        `policy was attached or detached ${DESIRED_SIDE_NOTE}: the desired Groups holds a ` +
        "dynamic reference or cdkd's mask that resolved to no names; fix that value in the " +
        'template first, since the repair below re-applies it; then repair the recorded Roles ' +
        'in state.json to a list of role / group / user names and re-run'
    );
  });

  it.each(MALFORMED)('%s on the DESIRED side: throws with no AWS call', async (_what, lists) => {
    // The rollback revert arm replays update() with a RECORDED bag here, so a
    // string would otherwise drive `PutRolePolicy` to one-letter roles.
    const error = await new IAMPolicyProvider()
      .update('P', 'pol', TYPE, { ...valid, ...lists }, valid)
      .catch((e: unknown) => e);
    // The desired side is the TEMPLATE only on a deploy: on a rollback revert
    // or `drift --revert` it is a recorded bag, so the message names both sources rather than
    // sending the user to a template that does not hold the value
    // (go-to-k/cdkd#3907). No state.json repair: the recorded side is fine.
    expect((error as Error).message).toMatch(
      new RegExp(
        `^desired \\w+( / desired \\w+)* of IAM policy P is not a list of IAM names — no ` +
          `inline policy was attached or detached ${DESIRED_SIDE_NOTE.replace(/[()]/g, '\\$&')}$`
      )
    );
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('reads a null list as absent on either side', async () => {
    // Recorded `Roles: null` (a hand-edited or pre-v7 record) detaches nothing
    // from roles; a desired `Users: null` attaches to no user and still
    // detaches the recorded user.
    await new IAMPolicyProvider().update(
      'P',
      'pol',
      TYPE,
      { ...valid, Roles: ['r2'], Users: null },
      { ...valid, Roles: null, Users: ['u1'] }
    );
    expect(inputs()).toEqual([
      { RoleName: 'r2', PolicyName: 'pol', PolicyDocument: JSON.stringify(DOC) },
      { UserName: 'u1', PolicyName: 'pol' },
    ]);
  });

  it('still moves the policy between valid lists', async () => {
    await new IAMPolicyProvider().update(
      'P',
      'pol',
      TYPE,
      { ...valid, Roles: ['r2'] },
      { ...valid, Roles: ['r1'] }
    );
    const inputs = mockSend.mock.calls.map((c) => (c[0] as { input: Record<string, unknown> }).input);
    expect(inputs).toEqual([
      expect.objectContaining({ RoleName: 'r2', PolicyName: 'pol' }),
      { RoleName: 'r1', PolicyName: 'pol' },
    ]);
  });
});

describe('IAMPolicyProvider.readCurrentState reads a malformed list as drift unknown', () => {
  it.each(MALFORMED)('%s: returns undefined with no AWS call', async (_what, lists) => {
    await expect(
      new IAMPolicyProvider().readCurrentState('pol', 'P', TYPE, {
        PolicyName: 'pol',
        PolicyDocument: DOC,
        ...lists,
      })
    ).resolves.toBeUndefined();
    expect(mockSend).not.toHaveBeenCalled();
  });
});

describe('IAMPolicyProvider.update removes the OLD-named policy on a rename (go-to-k/cdkd#4152)', () => {
  const docStr = JSON.stringify(DOC);
  const put = (kind: 'Role' | 'Group' | 'User', name: string, policy: string) => ({
    [`${kind}Name`]: name,
    PolicyName: policy,
    PolicyDocument: docStr,
  });
  const del = (kind: 'Role' | 'Group' | 'User', name: string, policy: string) => ({
    [`${kind}Name`]: name,
    PolicyName: policy,
  });

  it('removes the old name from a RETAINED principal too, after every put', async () => {
    await new IAMPolicyProvider().update(
      'P',
      'old-pol',
      TYPE,
      { PolicyName: 'new-pol', PolicyDocument: DOC, Roles: ['kept', 'added'] },
      { PolicyName: 'old-pol', PolicyDocument: DOC, Roles: ['kept', 'gone'] }
    );
    expect(inputs()).toEqual([
      put('Role', 'kept', 'new-pol'),
      put('Role', 'added', 'new-pol'),
      // The retained role used to keep `old-pol`, still granting, untracked.
      del('Role', 'kept', 'old-pol'),
      del('Role', 'gone', 'old-pol'),
    ]);
  });

  it('covers groups and users, each kind putting before it removes', async () => {
    await new IAMPolicyProvider().update(
      'P',
      'old-pol',
      TYPE,
      { PolicyName: 'new-pol', PolicyDocument: DOC, Roles: ['r'], Groups: ['g'], Users: ['u'] },
      { PolicyName: 'old-pol', PolicyDocument: DOC, Roles: ['r'], Groups: ['g'], Users: ['u'] }
    );
    // Per kind: an earlier kind's leaving principals are already revoked if a
    // later kind's put fails.
    expect(inputs()).toEqual([
      put('Role', 'r', 'new-pol'),
      del('Role', 'r', 'old-pol'),
      put('Group', 'g', 'new-pol'),
      del('Group', 'g', 'old-pol'),
      put('User', 'u', 'new-pol'),
      del('User', 'u', 'old-pol'),
    ]);
  });

  it('without a rename, a retained principal gets no removal (a mixed-case name included)', async () => {
    // Mixed case, like CDK's `...DefaultPolicyABC123`: a comparison that
    // lowercases only one side would read this as a rename and delete the
    // policy the put just wrote.
    await new IAMPolicyProvider().update(
      'P',
      'MyPol',
      TYPE,
      { PolicyName: 'MyPol', PolicyDocument: DOC, Groups: ['kept'] },
      { PolicyName: 'MyPol', PolicyDocument: DOC, Groups: ['kept', 'gone'] }
    );
    expect(inputs()).toEqual([put('Group', 'kept', 'MyPol'), del('Group', 'gone', 'MyPol')]);
  });

  it('a rollback revert removes the ATTEMPTED new name the record names beside the physical id', async () => {
    // The revert replays update() with the attempted bag as the previous side
    // while the physical id is still the old name: an interrupted rename left
    // `new-pol` on the principals, and only the recorded side names it.
    await new IAMPolicyProvider().update(
      'P',
      'old-pol',
      TYPE,
      { PolicyName: 'old-pol', PolicyDocument: DOC, Users: ['kept'] },
      { PolicyName: 'new-pol', PolicyDocument: DOC, Users: ['kept', 'added'] }
    );
    expect(inputs()).toEqual([
      put('User', 'kept', 'old-pol'),
      del('User', 'kept', 'new-pol'),
      // A principal leaving the list loses every name it may hold.
      del('User', 'added', 'old-pol'),
      del('User', 'added', 'new-pol'),
    ]);
  });

  it.each([
    ['a secret reference', '{{resolve:secretsmanager:pol:SecretString:name::}}'],
    ['the mask', '***'],
    ['a non-string', { Ref: 'X' }],
    ['a name embedding braces', 'a{{x}}'],
    ['a name past 128 characters', 'p'.repeat(129)],
  ])('a recorded PolicyName that is %s is never sent', async (_what, recorded) => {
    await new IAMPolicyProvider().update(
      'P',
      'old-pol',
      TYPE,
      { PolicyName: 'new-pol', PolicyDocument: DOC, Roles: ['kept'] },
      { PolicyName: recorded, PolicyDocument: DOC, Roles: ['kept'] }
    );
    expect(inputs()).toEqual([put('Role', 'kept', 'new-pol'), del('Role', 'kept', 'old-pol')]);
  });

  it('a legacy "<policyName>:<roleName>" physical id names the old policy by its first segment', async () => {
    // No recorded PolicyName, so only the split can supply `old-pol`.
    await new IAMPolicyProvider().update(
      'P',
      'old-pol:legacy-role',
      TYPE,
      { PolicyName: 'new-pol', PolicyDocument: DOC, Roles: ['kept'] },
      { PolicyDocument: DOC, Roles: ['kept'] }
    );
    expect(inputs()).toEqual([put('Role', 'kept', 'new-pol'), del('Role', 'kept', 'old-pol')]);
  });

  it('a failing put stops before its kind removes anything, so no listed principal loses the policy', async () => {
    mockSend.mockImplementation(
      (cmd: { constructor: { name: string }; input: Record<string, unknown> }) =>
        cmd.constructor.name === 'PutGroupPolicyCommand' && cmd.input['GroupName'] === 'g2'
          ? Promise.reject(new Error('throttled'))
          : Promise.resolve({})
    );
    await expect(
      new IAMPolicyProvider().update(
        'P',
        'old-pol',
        TYPE,
        { PolicyName: 'new-pol', PolicyDocument: DOC, Roles: ['r'], Groups: ['g1', 'g2'] },
        { PolicyName: 'old-pol', PolicyDocument: DOC, Roles: ['r', 'gone'], Groups: ['g1'] }
      )
    ).rejects.toThrow(/Failed to update IAM policy P: throttled/);
    // Roles finished (the leaving role is revoked); groups stopped at the put,
    // so g1 still holds old-pol beside new-pol and loses nothing.
    expect(inputs()).toEqual([
      put('Role', 'r', 'new-pol'),
      del('Role', 'r', 'old-pol'),
      del('Role', 'gone', 'old-pol'),
      put('Group', 'g1', 'new-pol'),
      put('Group', 'g2', 'new-pol'),
    ]);
  });

  it.each([
    ['upper to lower', 'MyPolicy', 'mypolicy'],
    ['lower to upper', 'mypolicy', 'MyPolicy'],
  ])('a case-only rename (%s) removes nothing from a retained principal', async (_what, from, to) => {
    // Measured: IAM inline policy names are case-insensitive on one principal.
    await new IAMPolicyProvider().update(
      'P',
      from,
      TYPE,
      { PolicyName: to, PolicyDocument: DOC, Roles: ['kept'] },
      { PolicyName: from, PolicyDocument: DOC, Roles: ['kept', 'gone'] }
    );
    expect(inputs()).toEqual([put('Role', 'kept', to), del('Role', 'gone', from)]);
  });

  it('a case-only rename, spelled out, removes nothing from a retained principal (IAM names are case-insensitive)', async () => {
    await new IAMPolicyProvider().update(
      'P',
      'MyPolicy',
      TYPE,
      { PolicyName: 'mypolicy', PolicyDocument: DOC, Roles: ['kept'] },
      { PolicyName: 'MyPolicy', PolicyDocument: DOC, Roles: ['kept', 'gone'] }
    );
    expect(inputs()).toEqual([
      put('Role', 'kept', 'mypolicy'),
      // A leaving principal still loses the name it holds.
      del('Role', 'gone', 'MyPolicy'),
    ]);
  });

  it('known limit: two policies swapping names on one role remove each other (fail-closed)', async () => {
    // Pinned so a change here is deliberate: the update has no view of sibling
    // AWS::IAM::Policy resources, so A (x -> y) then B (y -> x) on role R each
    // remove the name the other now holds.
    const provider = new IAMPolicyProvider();
    await provider.update(
      'A',
      'x',
      TYPE,
      { PolicyName: 'y', PolicyDocument: DOC, Roles: ['R'] },
      { PolicyName: 'x', PolicyDocument: DOC, Roles: ['R'] }
    );
    await provider.update(
      'B',
      'y',
      TYPE,
      { PolicyName: 'x', PolicyDocument: DOC, Roles: ['R'] },
      { PolicyName: 'y', PolicyDocument: DOC, Roles: ['R'] }
    );
    expect(inputs()).toEqual([
      put('Role', 'R', 'y'),
      del('Role', 'R', 'x'),
      put('Role', 'R', 'x'),
      del('Role', 'R', 'y'),
    ]);
  });

  it('an old name already gone (NoSuchEntity) is skipped, and the rest still removed', async () => {
    const { NoSuchEntityException } = await import('@aws-sdk/client-iam');
    mockSend.mockImplementation((cmd: { constructor: { name: string }; input: Record<string, unknown> }) =>
      cmd.constructor.name === 'DeleteRolePolicyCommand' && cmd.input['RoleName'] === 'a'
        ? Promise.reject(new NoSuchEntityException({ message: 'gone', $metadata: {} }))
        : Promise.resolve({})
    );
    await new IAMPolicyProvider().update(
      'P',
      'old-pol',
      TYPE,
      { PolicyName: 'new-pol', PolicyDocument: DOC, Roles: ['a', 'b'] },
      { PolicyName: 'old-pol', PolicyDocument: DOC, Roles: ['a', 'b'] }
    );
    expect(sent()).toEqual([
      'PutRolePolicyCommand',
      'PutRolePolicyCommand',
      'DeleteRolePolicyCommand',
      'DeleteRolePolicyCommand',
    ]);
  });
});

describe('IAMPolicyProvider.update rename edge cases (go-to-k/cdkd#4152)', () => {
  // A physical id that is not a policy name: a secret-derived name recorded
  // as its reference (the record's PolicyName is the mask).
  const UNUSABLE_ID = '{{resolve:secretsmanager:pol:SecretString:name::}}';

  it('a principal with TWO candidate old names still gets the second removal after a NoSuchEntity', async () => {
    const { NoSuchEntityException } = await import('@aws-sdk/client-iam');
    mockSend.mockImplementation(
      (cmd: { constructor: { name: string }; input: Record<string, unknown> }) =>
        cmd.constructor.name === 'DeleteUserPolicyCommand' && cmd.input['PolicyName'] === 'phys-pol'
          ? Promise.reject(new NoSuchEntityException({ message: 'gone', $metadata: {} }))
          : Promise.resolve({})
    );
    await new IAMPolicyProvider().update(
      'P',
      'phys-pol',
      TYPE,
      { PolicyName: 'phys-pol', PolicyDocument: DOC, Users: ['kept'] },
      { PolicyName: 'attempted-pol', PolicyDocument: DOC, Users: ['kept', 'gone'] }
    );
    expect(inputs().slice(1)).toEqual([
      { UserName: 'kept', PolicyName: 'attempted-pol' },
      { UserName: 'gone', PolicyName: 'phys-pol' },
      { UserName: 'gone', PolicyName: 'attempted-pol' },
    ]);
  });

  it.each([
    ['upper to lower', 'MyRole', 'myrole'],
    ['lower to upper', 'myrole', 'MyRole'],
  ])('a principal respelled only in case (%s) stays: it keeps the policy', async (_what, recorded, desired) => {
    // IAM principal names are case-insensitive: without the case-insensitive
    // match the recorded spelling read as leaving and lost `pol` right after
    // the put on the other spelling (the same role) wrote it.
    await new IAMPolicyProvider().update(
      'P',
      'pol',
      TYPE,
      { PolicyName: 'pol', PolicyDocument: DOC, Roles: [desired] },
      { PolicyName: 'pol', PolicyDocument: DOC, Roles: [recorded] }
    );
    expect(inputs()).toEqual([
      { RoleName: desired, PolicyName: 'pol', PolicyDocument: JSON.stringify(DOC) },
    ]);
  });

  it.each([
    ['upper to lower', 'MyRole', 'myrole'],
    ['lower to upper', 'myrole', 'MyRole'],
  ])('a case-only principal respelling (%s) is not a leaver for the no-usable-name refusal', async (_what, recorded, desired) => {
    await new IAMPolicyProvider().update(
      'P',
      UNUSABLE_ID,
      TYPE,
      { PolicyName: 'pol', PolicyDocument: DOC, Roles: [desired] },
      { PolicyName: '***', PolicyDocument: DOC, Roles: [recorded] }
    );
    expect(sent()).toEqual(['PutRolePolicyCommand']);
  });

  it('a removal failing with anything but NoSuchEntity fails the update', async () => {
    mockSend.mockImplementation((cmd: { constructor: { name: string } }) =>
      cmd.constructor.name === 'DeleteRolePolicyCommand'
        ? Promise.reject(new Error('AccessDenied'))
        : Promise.resolve({})
    );
    await expect(
      new IAMPolicyProvider().update(
        'P',
        'old-pol',
        TYPE,
        { PolicyName: 'new-pol', PolicyDocument: DOC, Roles: ['kept'] },
        { PolicyName: 'old-pol', PolicyDocument: DOC, Roles: ['kept'] }
      )
    ).rejects.toThrow(/Failed to update IAM policy P: AccessDenied/);
  });

  it.each([
    ['a Role', { Roles: ['kept', 'gone'] }, { Roles: ['kept'] }],
    ['a Group', { Roles: ['kept'], Groups: ['gone'] }, { Roles: ['kept'] }],
    ['a User', { Roles: ['kept'], Users: ['gone'] }, { Roles: ['kept'] }],
  ])('refuses before any call when only %s leaves and no old policy name is usable', async (_what, recorded, desired) => {
    await expect(
      new IAMPolicyProvider().update(
        'P',
        UNUSABLE_ID,
        TYPE,
        { PolicyName: 'pol', PolicyDocument: DOC, ...desired },
        { PolicyName: '***', PolicyDocument: DOC, ...recorded }
      )
    ).rejects.toThrow(/IAM policy P has no usable recorded policy name .* cannot be detached/);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('an EMPTY physical id with an unusable recorded PolicyName is refused the same way', async () => {
    // The #1770 shape, which takes no legacy split.
    await expect(
      new IAMPolicyProvider().update(
        'P',
        '',
        TYPE,
        { PolicyName: 'pol', PolicyDocument: DOC, Roles: ['kept'] },
        { PolicyName: '***', PolicyDocument: DOC, Roles: ['kept', 'gone'] }
      )
    ).rejects.toThrow(/IAM policy P has no usable recorded policy name/);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('with no usable old name and nobody leaving, the update proceeds', async () => {
    await new IAMPolicyProvider().update(
      'P',
      UNUSABLE_ID,
      TYPE,
      { PolicyName: 'pol', PolicyDocument: DOC, Roles: ['kept', 'added'] },
      { PolicyName: '***', PolicyDocument: DOC, Roles: ['kept'] }
    );
    expect(sent()).toEqual(['PutRolePolicyCommand', 'PutRolePolicyCommand']);
  });
});
