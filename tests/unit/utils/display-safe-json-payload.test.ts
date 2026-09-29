import { describe, it, expect } from 'vite-plus/test';
import { stringifyJsonPayload } from '../../../src/utils/display-safe.js';

/**
 * `stringifyJsonPayload` is the `--json` serializer (go-to-k/cdkd#3163): it must
 * emit no raw control / format / separator character, and it must stay a
 * lossless JSON encoding -- `JSON.parse` of its output equals `JSON.parse` of
 * `JSON.stringify`'s.
 */
describe('stringifyJsonPayload', () => {
  const RAW_CLASS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

  /** Every code point of the escaped class in the BMP, plus the astral `Cf` ones. */
  function classMembers(): string[] {
    const out: string[] = [];
    for (let cp = 0; cp <= 0x10ffff; cp++) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue; // lone surrogates: JSON.stringify's own job
      const ch = String.fromCodePoint(cp);
      if (RAW_CLASS.test(ch)) out.push(ch);
    }
    return out;
  }

  it('matches JSON.stringify(value, null, 2) byte-for-byte on a plain payload', () => {
    const value = [
      { stackName: 'ProdStack', region: 'us-east-1', count: 3, ok: true, none: null },
      { nested: { list: [1, 'two', { three: '\u00e9 \u65e5 \u{1f600}' }] } },
    ];
    expect(stringifyJsonPayload(value)).toBe(JSON.stringify(value, null, 2));
  });

  it('escapes every member of the class and round-trips it', () => {
    const members = classMembers();
    // Floor: the class really was enumerated (C0 + DEL + C1 alone is 65).
    expect(members.length).toBeGreaterThan(150);
    const value = { members, joined: members.join('') };

    const out = stringifyJsonPayload(value);

    expect(out.replace(/\n/g, '')).not.toMatch(RAW_CLASS);
    expect(JSON.parse(out)).toEqual(value);
  });

  it.each([
    ['DEL', '\u007f', '\\u007f'],
    ['NEL', '\u0085', '\\u0085'],
    ['C1 CSI', '\u009b', '\\u009b'],
    ['LINE SEPARATOR', ' ', '\\u2028'],
    ['PARAGRAPH SEPARATOR', ' ', '\\u2029'],
    ['RLO', '‮', '\\u202e'],
    ['LRI', '⁦', '\\u2066'],
    ['ZWSP', '​', '\\u200b'],
    ['BOM', '﻿', '\\ufeff'],
    ['astral TAG', '\u{e0001}', '\\udb40\\udc01'],
  ])('writes %s as its escape', (_label, ch, escaped) => {
    const out = stringifyJsonPayload({ v: `a${ch}b` });
    expect(out).toBe(`{\n  "v": "a${escaped}b"\n}`);
    expect(JSON.parse(out)).toEqual({ v: `a${ch}b` });
  });

  it('escapes in object KEYS too', () => {
    const value = { [`k `]: 1 };
    const out = stringifyJsonPayload(value);
    expect(out).toContain('"k\\u2028"');
    expect(JSON.parse(out)).toEqual(value);
  });

  it('keeps a preceding escaped backslash intact', () => {
    // `\\` then a raw CSI: the escape must not merge with the backslash pair.
    const value = { v: '\\\u009b' };
    const out = stringifyJsonPayload(value);
    expect(out).toContain('"\\\\\\u009b"');
    expect(JSON.parse(out)).toEqual(value);
  });

  it('leaves C0 exactly as JSON.stringify escapes it, and keeps the layout newlines', () => {
    const value = { v: 'a\nb\u001b[31mc\td' };
    expect(stringifyJsonPayload(value)).toBe(JSON.stringify(value, null, 2));
  });
});
