import { describe, expect, it } from 'vite-plus/test';
import { escapeRegExp, stripControlChars, stripForDisplay } from '../../../src/utils/regexp.js';

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

describe('stripForDisplay (go-to-k/cdkd#2888)', () => {
  it('replaces U+2028 / U+2029 with a space, which stripControlChars alone keeps', () => {
    expect(stripControlChars('a\u2028b\u2029c')).toBe('a\u2028b\u2029c');
    expect(stripForDisplay('a\u2028b\u2029c')).toBe('a b c');
  });

  it('still deletes the strip class, so an ESC sequence is broken the same way', () => {
    expect(stripForDisplay('Evil\u001b[31mId\u202e\u200f')).toBe('Evil[31mId');
  });

  it('trims what is left at the edges', () => {
    expect(stripForDisplay('\u2028 Key \u001b')).toBe('Key');
    expect(stripForDisplay('\u2029')).toBe('');
  });

  it('deletes exactly the strip class from between two characters, and nothing more', () => {
    // The property that keeps a mask -> strip -> mask caller safe: a deletion
    // the strip did not make could join two halves of a split needle.
    // Enumerated over the BMP rather than hand-picked.
    let deleted = 0;
    let replaced = 0;
    for (let cp = 0; cp <= 0xffff; cp++) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue;
      const c = String.fromCharCode(cp);
      const input = `a${c}b`;
      const shown = stripForDisplay(input);
      const stripped = stripControlChars(input);
      if (stripped === 'ab') {
        deleted++;
        expect(shown).toBe('ab');
      } else if (cp === 0x2028 || cp === 0x2029) {
        replaced++;
        expect(shown).toBe('a b');
      } else {
        expect(shown).toBe(input);
      }
    }
    // Floors, so a loop that never reaches an arm cannot pass vacuously.
    expect(deleted).toBeGreaterThanOrEqual(32 + 33 + 2 + 5 + 4);
    expect(replaced).toBe(2);
  });
});
