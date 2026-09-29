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
  'by cdkd). The new record keeps the reference (or its mask) again, so a later change to ' +
  'this policy is refused the same way';

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
    // Only a deploy reaches this (a rollback replay re-resolves references and
    // refuses a masked bag first), so the value is the template's own.
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
        `policy was attached or detached ${DESIRED_SIDE_NOTE}: repair the recorded Roles in ` +
        'state.json to a list of role / group / user names and re-run; fix the desired side ' +
        'first, or the next deploy is refused the same way'
    );
    expect(mockSend).not.toHaveBeenCalled();
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
