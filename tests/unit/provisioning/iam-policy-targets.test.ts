import { describe, it, expect } from 'vite-plus/test';
import {
  IAM_PRINCIPAL_NAME,
  readRecordedPrincipals,
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
