import { describe, it, expect } from 'vite-plus/test';
import {
  holdsSecretDerivedEntry,
  IAM_PRINCIPAL_NAME,
  onlySecretDerived,
  readPrincipalLists,
  readRecordedPrincipals,
  recordedPrincipalsRepair,
  SECRET_DERIVED_READ_LIVE,
  withUnchangedSecretPrincipalLists,
} from '../../../src/provisioning/iam-policy-targets.js';

describe('readRecordedPrincipals (go-to-k/cdkd#3878)', () => {
  it.each([undefined, null])('reads %s as absent', (value) => {
    expect(readRecordedPrincipals(value)).toEqual({ kind: 'absent' });
  });

  it('reads a list of IAM names, the empty list included', () => {
    expect(readRecordedPrincipals(['r1', 'svc.role+a=b,c@d-e_f'])).toEqual({
      kind: 'names',
      names: ['r1', 'svc.role+a=b,c@d-e_f'],
    });
    expect(readRecordedPrincipals([])).toEqual({ kind: 'names', names: [] });
  });

  it.each([
    ['a string', 'AdminRole', 'found string'],
    ['an object', {}, 'found object'],
    ['a number', 7, 'found number'],
    // Falsy but not null: absent would hand a legacy id's role the delete.
    ['an empty string', '', 'found string'],
    ['zero', 0, 'found number'],
    ['false', false, 'found boolean'],
    ['a non-string entry', ['r1', 7], 'a 2-element list holding a non-name entry'],
    ['an empty name', [''], 'a 1-element list holding a non-name entry'],
    ['a name with a space', ['r 1'], 'a 1-element list holding a non-name entry'],
    ['a name with a newline', ['r1\nx'], 'a 1-element list holding a non-name entry'],
    ['a name past 128 characters', ['r'.repeat(129)], 'a 1-element list holding a non-name entry'],
  ])('reads %s as malformed, naming only its shape', (_what, value, detail) => {
    expect(readRecordedPrincipals(value)).toEqual({ kind: 'malformed', detail });
  });

  it('accepts exactly 128 characters and IAM\'s full character set', () => {
    expect(IAM_PRINCIPAL_NAME.test('r'.repeat(128))).toBe(true);
    expect(IAM_PRINCIPAL_NAME.test('Aa0_+=,.@-')).toBe(true);
  });
});

describe('readPrincipalLists (go-to-k/cdkd#3906, go-to-k/cdkd#3888)', () => {
  it('returns every kind, an absent or null one as undefined', () => {
    expect(readPrincipalLists({ Roles: ['r1'], Users: null, Groups: undefined })).toEqual({
      lists: { Roles: ['r1'], Users: undefined, Groups: undefined },
    });
  });

  it('names every malformed kind and which are secret-derived, keeping the well-formed ones', () => {
    expect(
      readPrincipalLists({
        Roles: 'AdminRole',
        Users: ['{{resolve:secretsmanager:s:SecretString:u}}'],
        Groups: ['***'],
        Extra: ['ok'],
      })
    ).toEqual({
      lists: { Extra: ['ok'] },
      malformed: ['Roles', 'Users', 'Groups'],
      secretDerived: ['Users', 'Groups'],
    });
  });

  it.each([
    ['a bare string', '{{resolve:ssm-secure:p}}'],
    ['a nested object', [{ a: { b: '{{resolve:secretsmanager:s}}' } }]],
    ['a nested list', [['***']]],
  ])('finds a dynamic reference or mask in %s', (_what, value) => {
    expect(readPrincipalLists({ Roles: value })).toMatchObject({ secretDerived: ['Roles'] });
  });
});

describe('holdsSecretDerivedEntry (go-to-k/cdkd#3989 review)', () => {
  it.each([
    ['a whole-value mask', '***'],
    ['a reference inside a string', 'arn:{{resolve:secretsmanager:s}}'],
    ['a mask as a list entry', ['x', '***']],
    ['a mask as a nested member', { a: [{ b: '***' }] }],
    ['a mask as a key', { '***': 'v' }],
  ])('finds %s', (_what, value) => {
    expect(holdsSecretDerivedEntry(value)).toBe(true);
  });

  it.each([
    ['a legitimate a***b tag key', 'a***b'],
    ['a longer run of stars', '****'],
    ['a mask spliced into a string', 'prefix-***'],
    ['a plain nested value', { Key: 'team', Value: ['a', 1, null] }],
    ['a non-string scalar', 42],
  ])('does not flag %s', (_what, value) => {
    expect(holdsSecretDerivedEntry(value)).toBe(false);
  });

  it('terminates on a cyclic value', () => {
    const cyclic: Record<string, unknown> = { a: 'x' };
    cyclic['self'] = cyclic;
    expect(holdsSecretDerivedEntry(cyclic)).toBe(false);
  });
});

describe('onlySecretDerived', () => {
  it('is true only when every malformed kind is secret-derived', () => {
    expect(onlySecretDerived(readPrincipalLists({ Roles: ['***'] }))).toBe(true);
    expect(onlySecretDerived(readPrincipalLists({ Roles: ['***'], Users: 'x' }))).toBe(false);
    expect(onlySecretDerived(readPrincipalLists({ Roles: ['r1'] }))).toBe(false);
  });
});

describe('recordedPrincipalsRepair', () => {
  it('sends a plain malformed list to state.json, and says what the provider does with a secret-derived one', () => {
    expect(
      recordedPrincipalsRepair(['Roles', 'Users'], ['Users'], 'role / user names', SECRET_DERIVED_READ_LIVE)
    ).toBe(
      'repair the recorded Roles in state.json to a list of role / user names and re-run; the ' +
        'recorded Users is secret-derived (cdkd keeps the dynamic reference or its mask in ' +
        'state), so do not write the name into state.json; cdkd reads it from IAM instead once ' +
        'every other list is well-formed'
    );
  });
});

describe('withUnchangedSecretPrincipalLists (go-to-k/cdkd#4064)', () => {
  const EXPR = '{{resolve:secretsmanager:sdp:SecretString:role::}}';
  const OTHER = '{{resolve:secretsmanager:other:SecretString:role::}}';
  const POLICY = 'AWS::IAM::Policy';
  const run = (
    recorded: unknown,
    redacted: unknown,
    type = POLICY,
    key = 'Roles'
  ): { previous: Record<string, unknown>; out: Record<string, unknown>; dropped: string[] } => {
    const previous = { PolicyName: 'pol', [key]: recorded };
    const r = withUnchangedSecretPrincipalLists(type, 'pol', previous, {
      PolicyName: 'pol',
      [key]: redacted,
    });
    return { previous, out: r.previous, dropped: r.dropped };
  };

  it('drops a reference the desired side still holds, keeping plain names, and names the kind', () => {
    const { previous, out, dropped } = run(['plain', EXPR], ['added', 'plain', EXPR]);
    expect(out['Roles']).toEqual(['plain']);
    expect(out['PolicyName']).toBe('pol');
    expect(dropped).toEqual(['Roles']);
    // A copy: the record itself is never rewritten.
    expect(previous['Roles']).toEqual(['plain', EXPR]);
    // No plaintext is ever introduced: only recorded entries survive.
    expect(JSON.stringify(out)).not.toContain('added');
  });

  it('covers UserToGroupAddition Users and every IAM::Policy kind', () => {
    expect(run([EXPR], [EXPR], 'AWS::IAM::UserToGroupAddition', 'Users').out['Users']).toEqual([]);
    expect(run([EXPR], [EXPR], POLICY, 'Groups').out['Groups']).toEqual([]);
    expect(run([EXPR], [EXPR], POLICY, 'Users').out['Users']).toEqual([]);
  });

  it.each([
    ['a re-pointed reference', [OTHER], [EXPR]],
    ['one of two references re-pointed', [EXPR, OTHER], [EXPR]],
    ['a recorded mask', ['***'], ['***']],
    ['a mask beside a matched reference', [EXPR, '***'], [EXPR, '***']],
    ['a reference in place of the list', EXPR, EXPR],
    ['a reference in place of the list, beside a desired list', EXPR, [EXPR]],
    ['a plain recorded list', ['r1'], ['r1']],
    ['a desired side that is not a list', [EXPR], EXPR],
  ])('%s: returns the previous side itself', (_what, recorded, redacted) => {
    const { previous, out, dropped } = run(recorded, redacted);
    expect(out).toBe(previous);
    expect(dropped).toEqual([]);
  });

  it.each([['AWS::IAM::ManagedPolicy'], ['AWS::IAM::InstanceProfile'], ['constructor'], ['__proto__']])(
    '%s is not a type without a live source: returns the previous side itself',
    (type) => {
      const { previous, out } = run([EXPR], [EXPR], type);
      expect(out).toBe(previous);
    }
  );

  it.each([
    ['UserToGroupAddition GroupName', 'AWS::IAM::UserToGroupAddition', 'GroupName', 'Users'],
    ['IAM::Policy PolicyName', POLICY, 'PolicyName', 'Roles'],
  ])('a changed attachment target (%s) keeps the record, so the provider refuses', (_what, type, target, key) => {
    // The provider removes the OLD target only from principals the recorded
    // side still lists: a dropped one would keep the old membership / policy.
    const previous = { [target]: 'old', [key]: [EXPR] };
    const r = withUnchangedSecretPrincipalLists(type, 'old', previous, {
      [target]: 'new',
      [key]: [EXPR],
    });
    expect(r.previous).toBe(previous);
    expect(r.dropped).toEqual([]);
    // The same target, spelled the same, still drops.
    expect(
      withUnchangedSecretPrincipalLists(type, 'old', previous, { [target]: 'old', [key]: [EXPR] })
        .dropped
    ).toEqual([key]);
  });

  it.each([
    ['a secret reference', '{{resolve:secretsmanager:grp:SecretString:name::}}'],
    ['the mask', '***'],
  ])('a GroupName recorded as %s keeps the record: equal redactions prove nothing', (_what, group) => {
    const previous = { GroupName: group, Users: [EXPR] };
    const r = withUnchangedSecretPrincipalLists('AWS::IAM::UserToGroupAddition', 'phys', previous, {
      GroupName: group,
      Users: [EXPR],
    });
    expect(r.previous).toBe(previous);
    expect(r.dropped).toEqual([]);
  });

  it('a key absent from the record is not added', () => {
    // The target matches, so this reaches the per-key absent check.
    const previous = { PolicyName: 'pol' };
    const r = withUnchangedSecretPrincipalLists(POLICY, 'pol', previous, {
      PolicyName: 'pol',
      Roles: [EXPR],
    });
    expect(r.previous).toBe(previous);
    expect(r.dropped).toEqual([]);
  });

  it('drops NOTHING when another kind keeps an undroppable secret entry (all or nothing)', () => {
    // Roles alone would drop, but Users was re-pointed: the provider refuses
    // over Users, so dropping Roles would only make the warning disagree.
    const previous = { PolicyName: 'pol', Roles: [EXPR], Users: [OTHER] };
    const r = withUnchangedSecretPrincipalLists(POLICY, 'pol', previous, {
      PolicyName: 'pol',
      Roles: [EXPR],
      Users: [EXPR],
    });
    expect(r.previous).toBe(previous);
    expect(r.dropped).toEqual([]);
  });

  it.each([
    ['a different name', 'other-pol'],
    ['a legacy id naming a different policy', 'other-pol:role'],
  ])('an IAM::Policy whose physical id is %s keeps the record', (_what, physicalId) => {
    // The provider takes the OLD policy name from the physical id, so a record
    // whose PolicyName disagrees with it is not what the provider would detach.
    const previous = { PolicyName: 'pol', Roles: [EXPR] };
    const r = withUnchangedSecretPrincipalLists(POLICY, physicalId, previous, {
      PolicyName: 'pol',
      Roles: [EXPR],
    });
    expect(r.previous).toBe(previous);
  });

  it('a legacy "<policyName>:<roleName>" id naming the same policy still drops', () => {
    expect(run([EXPR], [EXPR]).dropped).toEqual(['Roles']);
    const r = withUnchangedSecretPrincipalLists(POLICY, 'pol:role', { PolicyName: 'pol', Roles: [EXPR] }, {
      PolicyName: 'pol',
      Roles: [EXPR],
    });
    expect(r.dropped).toEqual(['Roles']);
  });

  it('drops a partially embedded reference the desired side holds verbatim', () => {
    const embedded = `prefix-${EXPR}`;
    const { out, dropped } = run([embedded], [embedded, 'added']);
    expect(out['Roles']).toEqual([]);
    expect(dropped).toEqual(['Roles']);
  });

  it('names every dropped kind, and rewrites every one of them', () => {
    const previous = { PolicyName: 'pol', Roles: [EXPR], Users: [OTHER] };
    const r = withUnchangedSecretPrincipalLists(POLICY, 'pol', previous, {
      PolicyName: 'pol',
      Roles: [EXPR],
      Users: [OTHER],
    });
    expect(r.dropped).toEqual(['Roles', 'Users']);
    expect(r.previous['Roles']).toEqual([]);
    expect(r.previous['Users']).toEqual([]);
  });

  it('drops NOTHING when another kind holds a mask (all or nothing on the mask arm)', () => {
    const previous = { PolicyName: 'pol', Roles: [EXPR], Users: ['***'] };
    const r = withUnchangedSecretPrincipalLists(POLICY, 'pol', previous, {
      PolicyName: 'pol',
      Roles: [EXPR],
      Users: ['***'],
    });
    expect(r.previous).toBe(previous);
    expect(r.dropped).toEqual([]);
  });
});
