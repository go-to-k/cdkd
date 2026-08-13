import { describe, expect, it } from 'vite-plus/test';
import { escapeRegExp } from '../../../src/utils/regexp.js';

/**
 * Module-own coverage for the shared `escapeRegExp` (issue #1793 review).
 *
 * The helper was three copies before this PR, each interpolating a
 * user-controlled name (an AWS region, a bootstrap-marker asset bucket /
 * container repo, an ECR host label) into a pattern. Coverage was purely
 * INDIRECT — via the gc look-alike arms — which left the third call site,
 * `src/assets/asset-redirect.ts`, vouched for by nothing.
 *
 * The load-bearing property is not "the output looks escaped" but that the
 * escaped literal matches ITSELF and NOTHING ELSE: in `gc.ts` a widened match
 * decides which live assets read as referenced, and an unescaped `.` matching
 * any character is what would let one asset name vouch for a different one.
 */
describe('escapeRegExp', () => {
  it('leaves a string with no special characters byte-identical', () => {
    expect(escapeRegExp('cdkd-assets-123456789012-us-east-1')).toBe(
      'cdkd-assets-123456789012-us-east-1'
    );
  });

  it('escapes every character the non-u pattern treats as special', () => {
    // One assertion per character rather than a single blob, so a dropped
    // member of the class names itself instead of failing an opaque compare.
    for (const special of ['.', '*', '+', '?', '^', '$', '{', '}', '(', ')', '|', '[', ']', '\\']) {
      expect(escapeRegExp(special)).toBe(`\\${special}`);
    }
  });

  it('does NOT escape `-`, which is only special inside a character class', () => {
    // Pins the deliberate omission the module documents. If a future caller
    // embeds into a class, that caller is wrong, not this helper.
    expect(escapeRegExp('a-b')).toBe('a-b');
  });

  it('makes a `.`-bearing literal match itself and NOT an arbitrary character', () => {
    // The regression this helper exists to prevent, stated as behavior: an
    // unescaped `dkr.ecr` would also match `dkrxecr`.
    const pattern = new RegExp(`^${escapeRegExp('123456789012.dkr.ecr.us-east-1.amazonaws.com')}$`);
    expect(pattern.test('123456789012.dkr.ecr.us-east-1.amazonaws.com')).toBe(true);
    expect(pattern.test('123456789012xdkrxecrxus-east-1xamazonaws.com')).toBe(false);
  });

  it('keeps a literal containing regex metacharacters inert', () => {
    // An S3 key / repo name is user-controlled; a `+` or `(` in one must not
    // become a quantifier or a group.
    const pattern = new RegExp(escapeRegExp('a+b(c)'));
    expect(pattern.test('a+b(c)')).toBe(true);
    expect(pattern.test('aab')).toBe(false);
    expect(pattern.test('abc')).toBe(false);
  });

  it('escapes a backslash so the result stays a valid pattern', () => {
    // A lone `\` would otherwise escape whatever follows it when interpolated.
    expect(() => new RegExp(escapeRegExp('back\\slash'))).not.toThrow();
    expect(new RegExp(`^${escapeRegExp('back\\slash')}$`).test('back\\slash')).toBe(true);
  });

  it('returns an empty string unchanged', () => {
    expect(escapeRegExp('')).toBe('');
  });
});
