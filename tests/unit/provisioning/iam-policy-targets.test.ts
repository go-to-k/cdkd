import { describe, it, expect } from 'vite-plus/test';
import {
  holdsSecretDerivedEntry,
  IAM_PRINCIPAL_NAME,
  onlySecretDerived,
  readPrincipalLists,
  readRecordedPrincipals,
  recordedPrincipalsRepair,
  SECRET_DERIVED_READ_LIVE,
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
