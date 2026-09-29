import { describe, it, expect } from 'vite-plus/test';
import { IDENT_MAX_CODE_POINTS, plainIdentOr } from '../../../src/utils/display-safe.js';

const DESCRIBED = 'described';

describe('plainIdentOr (go-to-k/cdkd#4115)', () => {
  it('returns a plain identifier unchanged', () => {
    for (const value of ['alice@host:4242', 'deploy', 'user.name@ip-10-0-0-1.ec2.internal:77']) {
      expect(plainIdentOr(value, DESCRIBED), value).toBe(value);
    }
  });

  it('describes a whitespace-free value that displayIdent does not render unchanged', () => {
    // The round-trip half: no whitespace, but past the cap, carrying a quote,
    // non-ASCII, or empty.
    for (const value of [
      'a'.repeat(IDENT_MAX_CODE_POINTS + 1),
      'alice"@host',
      "alice'@host",
      'alice$(id)@host',
      'alicé@host',
      '',
    ]) {
      expect(plainIdentOr(value, DESCRIBED), JSON.stringify(value)).toBe(DESCRIBED);
    }
  });

  it("describes a value that is displayIdent's own cut output", () => {
    const forged = 'a'.repeat(IDENT_MAX_CODE_POINTS) + ' [cut: 35 more characters withheld]';
    expect(plainIdentOr(forged, DESCRIBED)).toBe(DESCRIBED);
  });
});
