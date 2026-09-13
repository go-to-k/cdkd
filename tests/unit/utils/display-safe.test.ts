/**
 * Issue #2170 review round 3: the same sanitization rule was being widened BY
 * HAND one module at a time — the change had sanitized 1 of 5 readers of
 * `LockInfo.owner`. This leaf is the single definition every reader imports,
 * so these are the tests that pin the RULE; each consumer's own suite pins that
 * it routes through here rather than re-spelling it.
 */
import { describe, expect, it } from 'vite-plus/test';
import { displaySafe, truncateCodePoints } from '../../../src/utils/display-safe.js';

describe('displaySafe — denylist mode (owner / operation, may be non-ASCII)', () => {
  it('strips the classes a C0 + DEL denylist misses', () => {
    // Each of these forges a LINE or an ESCAPE somewhere cdkd's output lands:
    // a terminal, a thrown error, or the persisted deployment-events store.
    const cases: Array<[string, string]> = [
      ['\u0000', 'NUL'],
      ['\r', 'CR'],
      ['\u001b', 'ESC'],
      ['\u007f', 'DEL'],
      ['\u0085', 'NEL'],
      ['\u009b', 'CSI (C1)'],
      ['\u2028', 'LINE SEPARATOR'],
      ['\u2029', 'PARAGRAPH SEPARATOR'],
      ['\u202e', 'RLO (Trojan Source)'],
      ['\u2066', 'LRI'],
      ['\u2069', 'PDI'],
    ];
    for (const [ch, label] of cases) {
      expect(displaySafe(`a${ch}b`), `not stripped: ${label}`).not.toContain(ch);
    }
  });

  it('keeps ordinary non-ASCII, which an owner may legitimately carry', () => {
    // `owner` is `${USER}@${HOSTNAME}:${pid}` — a username is not ASCII-only
    // everywhere, so this mode must not be a blanket ASCII filter.
    expect(displaySafe('José@häst:42')).toBe('José@häst:42');
  });

  it('absorbs a non-string value instead of throwing', () => {
    // `getLockInfo` is an unvalidated `JSON.parse(...) as LockInfo`, so a
    // hand-written lock.json can carry anything here. Throwing landed in a
    // best-effort catch and silently degraded the caller's message.
    expect(displaySafe(12345)).toBe('12345');
    expect(displaySafe({ a: 1 })).toBe('[object Object]');
  });

  it('renders an ABSENT value as EMPTY, not as the word', () => {
    // `String(undefined)` is `'undefined'`, a TRUTHY string. The callers that
    // key a decision on emptiness — the lock summary, the refusals that fall
    // back to `UNRENDERABLE` — were answered "yes, there is a value" for a
    // lock.json carrying none, which printed `held by undefined` AND certified
    // the holder as live. (Not every caller does: `ConsoleLogger` concatenates
    // the result and `sameLockIdentity` only compares two of them.)
    expect(displaySafe(undefined)).toBe('');
    expect(displaySafe(null)).toBe('');
  });

  it('returns EMPTY for a value with nothing renderable left', () => {
    // Load-bearing: callers key their suppression on emptiness, because an
    // empty `--stack-region ''` is what makes `force-unlock` widen to every
    // region holding the stack name.
    expect(displaySafe('\u0000\u0001\u001b')).toBe('');
    expect(displaySafe('   ')).toBe('');
  });
});

describe('displaySafe — asciiOnly mode (stack name / region, known charset)', () => {
  it('is a positive allowlist, so the invisible formatters do not survive', () => {
    // The documented residual of the denylist: ZWSP / ZWJ / BOM and the bidi
    // MARKS pass it. A stack name and an AWS region have a known ASCII
    // charset, so they take the allowlist and have no residual at all.
    for (const ch of ['\u200b', '\u200d', '\ufeff', '\u200e', '\u200f', '\u061c']) {
      expect(displaySafe(`a${ch}b`, { asciiOnly: true })).toBe('a b');
    }
  });

  it('leaves printable ASCII exactly as it was', () => {
    expect(displaySafe('Parent~Child', { asciiOnly: true })).toBe('Parent~Child');
    expect(displaySafe('us-east-1', { asciiOnly: true })).toBe('us-east-1');
  });

  it('is DIFFERENT from the denylist mode — a caller must pick deliberately', () => {
    // Non-vacuity: if the two modes agreed, the option would be decoration and
    // a caller choosing the wrong one would be invisible.
    const zwsp = 'a\u200bb';
    expect(displaySafe(zwsp)).toBe(zwsp);
    expect(displaySafe(zwsp, { asciiOnly: true })).toBe('a b');
  });
});

describe('displaySafe — a value whose String conversion THROWS (issue #2947)', () => {
  it('renders an object with a non-callable toString instead of throwing', () => {
    const value = JSON.parse('{"toString": null}') as unknown;
    // The premise, asserted rather than assumed: `String` itself throws here.
    expect(() => String(value)).toThrow(TypeError);
    expect(displaySafe(value)).toBe('[object Object]');
  });

  it('renders an array holding one through its own tag', () => {
    const value = JSON.parse('[{"toString": null}]') as unknown;
    expect(() => String(value)).toThrow(TypeError);
    expect(displaySafe(value)).toBe('[object Array]');
  });

  it('sanitizes the FALLBACK tag too, rather than returning it straight', () => {
    // Unreachable from `JSON.parse` — a `Symbol.toStringTag` is not a JSON key
    // — and that is exactly why it is needed: every tag a JSON-derived value
    // can produce (`[object Object]`, `[object Array]`) is already inert, so
    // no other case can tell "the catch arm flows through the sanitizer" from
    // "the catch arm returns its tag". This one can.
    const value = { toString: null, [Symbol.toStringTag]: 'Ta\u0007g' } as unknown;
    expect(() => String(value)).toThrow(TypeError);
    // The premise: the tag the fallback produces carries the control character.
    expect(Object.prototype.toString.call(value)).toBe('[object Ta\u0007g]');

    expect(displaySafe(value)).toBe('[object Ta g]');
  });

  it('leaves every value String already handled exactly as it was', () => {
    for (const value of [42, true, 'plain', {}, [1, 2]]) {
      expect(displaySafe(value)).toBe(String(value));
    }
  });
});

describe('truncateCodePoints (issue #2947)', () => {
  it('never splits a surrogate pair at the cut', () => {
    const text = 'abcdefghijk\u{1F600}rest'; // 11 BMP chars, then one astral
    // The premise: a UTF-16 slice at 12 DOES leave a lone high surrogate.
    expect(/[\uD800-\uDBFF]$/.test(text.slice(0, 12))).toBe(true);

    const cut = truncateCodePoints(text, 12);

    expect(cut).toEqual({ text: 'abcdefghijk\u{1F600}', truncated: true });
    expect(/[\uD800-\uDBFF]$/.test(cut.text)).toBe(false);
  });

  it('counts an astral character as ONE, so 12 code points in 13 units is not cut', () => {
    const text = 'abcdefghijk\u{1F600}';
    expect(text.length).toBe(13);
    expect(truncateCodePoints(text, 12)).toEqual({ text, truncated: false });
  });

  it('reports no truncation for a value exactly the window long', () => {
    expect(truncateCodePoints('abc', 3)).toEqual({ text: 'abc', truncated: false });
  });
});
