/**
 * Issue #2170 review round 3: the same sanitization rule was being widened BY
 * HAND one module at a time — the change had sanitized 1 of 5 readers of
 * `LockInfo.owner`. This leaf is the single definition every reader imports,
 * so these are the tests that pin the RULE; each consumer's own suite pins that
 * it routes through here rather than re-spelling it.
 */
import { describe, expect, it } from 'vite-plus/test';
import {
  displayIdent,
  displaySafe,
  IDENT_MAX_CODE_POINTS,
  STACK_REF_MAX_CODE_POINTS,
  truncateCodePoints,
  UNRENDERABLE,
} from '../../../src/utils/display-safe.js';

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

describe('displayIdent (issues #3064 / #3092)', () => {
  it('is the identity on every legitimate identifier shape', () => {
    // A rendering that changed any of these would move a fixture grep, a unit
    // pin and an operator's `--orphan` paste; the conditional quoting exists
    // so that it does not.
    for (const v of [
      'MyBucketF68F3FF0',
      'AWS::S3::Bucket',
      'AWS::CloudFormation::Stack::MODULE',
      'Custom::my-thing_v2@x',
      'CREATE',
      'CdkdBasicExample',
      // The name cdkd mints for a nested-stack child (`NestedStackProvider`).
      'CdkdParent~ChildStack',
      'us-east-1',
      '20260914T101010123Z-abcd',
      'cdkd/CdkdBasicExample/us-east-1',
      'arn:aws:iam::123456789012:role/cdkd-deploy+role,x=y',
    ]) {
      expect(displayIdent(v)).toBe(v);
    }
  });

  it('quotes a value that could plant the surrounding line\'s own annotation', () => {
    // All ASCII, so the allowlist keeps every character -- the same-line
    // spoof go-to-k/cdkd#3072 left open. Quoted, the boundary is visible.
    const spoof = 'X (AWS::RDS::DBInstance) -- already reverted';
    expect(displayIdent(spoof)).toBe(`"${spoof}"`);
    // JSON escaping keeps an embedded `"` from faking the closing quote.
    expect(displayIdent('X" (AWS::RDS::DBInstance) "Y')).toBe('"X\\" (AWS::RDS::DBInstance) \\"Y"');
    // The sanitized form decides: an id that becomes odd only after the
    // allowlist replaced its zero-width space is quoted too.
    expect(displayIdent('Vic\u200btim')).toBe('"Vic tim"');
  });

  it('cuts a value past the identifier cap and says how much it withheld', () => {
    const atCap = 'A'.repeat(IDENT_MAX_CODE_POINTS);
    expect(displayIdent(atCap)).toBe(atCap);
    const over = 'A'.repeat(IDENT_MAX_CODE_POINTS + 45);
    expect(displayIdent(over)).toBe(`${atCap} [cut: 45 more characters withheld]`);
    // The cut is measured AFTER sanitizing, so a value padded with invisibles
    // to sneak under the cap is measured by what it renders as -- and since
    // issue #3164 it is also QUOTED, because sanitization was not the identity
    // on it. That is the point of the padding rule: the bare form here was a
    // same-line spoof of the unpadded value.
    expect(displayIdent(`${atCap}\u200b`)).toBe(`"${atCap}"`);
  });

  it('renders nothing-left and absent values as the placeholder, unquoted', () => {
    expect(displayIdent('\u200b')).toBe(UNRENDERABLE);
    expect(displayIdent('')).toBe(UNRENDERABLE);
    expect(displayIdent(undefined)).toBe(UNRENDERABLE);
    expect(displayIdent(null)).toBe(UNRENDERABLE);
  });

  it('is never the identity on a value it changed', () => {
    for (const v of ['Vic\u200btim', 'X (Y)', 'A'.repeat(IDENT_MAX_CODE_POINTS + 1), '\u200b', ' X ']) {
      expect(displayIdent(v)).not.toBe(v);
    }
  });
});

describe('displayIdent quotes whenever sanitization was NOT the identity (issue #3164)', () => {
  // The allowlist cannot supply this half: `displaySafe` maps every
  // non-printable-ASCII character to a space and then TRIMS, so padding is gone
  // before the plain-identifier test runs and a padded value tested as plain.
  // Each of these rendered byte-identically to the bare `ProdStack` before the
  // fix, which is a same-line spoof from a one-character input. Every row is
  // therefore PADDING: an INNER control character sanitizes to `Prod Stack`,
  // which the allowlist already quoted, so it belongs to no spoof this rule
  // closes and is covered by the identity test below instead.
  const PADDED: Array<[string, string]> = [
    ['trailing space', 'ProdStack '],
    ['leading space', ' ProdStack'],
    ['tab', '\tProdStack'],
    ['NUL', 'ProdStack\u0000'],
    ['ESC', '\u001bProdStack'],
    ['zero-width joiner', 'ProdStack\u200b'],
  ];

  for (const [label, value] of PADDED) {
    it(`quotes a value padded with ${label}`, () => {
      const out = displayIdent(value);
      expect(out).not.toBe('ProdStack');
      expect(out.startsWith('"')).toBe(true);
    });
  }

  it('leaves a value sanitization did NOT touch bare', () => {
    for (const v of ['ProdStack', 'my-stack-1', 'Parent~Child', 'AWS::S3::Bucket', 'us-east-1']) {
      expect(displayIdent(v)).toBe(v);
    }
  });

  it('does NOT quote a bare comma -- a recorded residual, not an oversight', () => {
    // An IAM role name allows `[\\w+=,.@-]`, so a comma-bearing role ARN is a
    // legitimate shape this module renders (pinned as an identity shape above).
    // The cost is that a name ending in `,` still slips through the `', '` join
    // two `state.ts` prompts use, because the formatter supplies the space.
    // Tracked on go-to-k/cdkd#3179; pinned here so closing it there is a
    // deliberate, visible change rather than a silent one.
    expect(displayIdent('ProdStack,')).toBe('ProdStack,');
  });
});

describe('displayIdent maxCodePoints option (issue #3164)', () => {
  it('defaults to IDENT_MAX_CODE_POINTS when no option is given', () => {
    const over = 'A'.repeat(IDENT_MAX_CODE_POINTS + 3);
    expect(displayIdent(over)).toBe(
      `${'A'.repeat(IDENT_MAX_CODE_POINTS)} [cut: 3 more characters withheld]`
    );
  });

  it('WIDENS the cut when a caller passes a larger cap', () => {
    const long = 'A'.repeat(IDENT_MAX_CODE_POINTS + 3);
    expect(displayIdent(long, { maxCodePoints: STACK_REF_MAX_CODE_POINTS })).toBe(long);
  });

  it('NARROWS the cut when a caller passes a smaller cap', () => {
    // The floor half: without it, only the widening direction is watched.
    expect(displayIdent('ABCDEFGH', { maxCodePoints: 3 })).toBe(
      'ABC [cut: 5 more characters withheld]'
    );
  });

  it('refuses a cap that would make the cut meaningless', () => {
    // A slice with a negative length cuts from the END and reports a nonsense
    // withheld count; zero leaves nothing at all. Both are floored to 1.
    expect(displayIdent('ABCDEFGH', { maxCodePoints: -5 })).toBe(
      'A [cut: 7 more characters withheld]'
    );
    expect(displayIdent('ABCDEFGH', { maxCodePoints: 0 })).toBe(
      'A [cut: 7 more characters withheld]'
    );
  });

  it('floors a fractional cap', () => {
    // `3.9` is NOT the discriminating input: `slice(0, 3.9)` already truncates,
    // so it passes with or without the `Math.floor`. A cap between 0 and 1 is
    // what separates them -- floored it becomes 0 and the `Math.max(1, …)`
    // lifts it to 1, while an unfloored `slice(0, 0.5)` yields the empty
    // string and the render collapses to `""`.
    expect(displayIdent('ABCDEFGH', { maxCodePoints: 0.5 })).toBe(
      'A [cut: 7 more characters withheld]'
    );
    expect(displayIdent('ABCDEFGH', { maxCodePoints: 3.9 })).toBe(
      'ABC [cut: 5 more characters withheld]'
    );
  });

  it('falls back to the default for a non-finite cap', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY]) {
      const over = 'A'.repeat(IDENT_MAX_CODE_POINTS + 3);
      expect(displayIdent(over, { maxCodePoints: bad })).toBe(
        `${'A'.repeat(IDENT_MAX_CODE_POINTS)} [cut: 3 more characters withheld]`
      );
    }
  });

  it('QUOTES and CUTS together -- the only rule-2 x rule-3 combination', () => {
    // EXACT text, not `startsWith('"')` + `toContain('" [cut: ')`: those hold
    // for `JSON.stringify(clean)` too, which quotes the WHOLE value and drops
    // rule 2's payload bound on the quoted path entirely while still reporting
    // a withheld count. Pinning the rendered string is what distinguishes
    // "cut, then quoted" from "quoted, and a count printed beside it".
    const spoof = 'X (us-east-1) '.repeat(30);
    expect(spoof).toHaveLength(420);
    // 419, not 420: the withheld count is measured against the SANITIZED text,
    // whose trailing space the trim removed.
    expect(displayIdent(spoof, { maxCodePoints: 20 })).toBe(
      '"X (us-east-1) X (us-" [cut: 399 more characters withheld]'
    );
  });

  it('bounds the QUOTED payload, not just the unquoted one', () => {
    // The property behind the exact string above, stated so a future change
    // cannot satisfy the literal by coincidence: whatever the rendering, the
    // characters taken from the VALUE are capped.
    const out = displayIdent('Y (z) '.repeat(200), { maxCodePoints: 12 });
    const inner = out.slice(0, out.indexOf('" [cut:') + 1);
    expect(JSON.parse(inner)).toHaveLength(12);
  });
});

describe('displayIdent cannot be switched off by a hostile toString (issue #3164)', () => {
  it('reads the value ONCE, so a value that changes between reads cannot go bare', () => {
    // Two evaluations would sanitize the PADDED first reading and compare it
    // against the UNPADDED second one, making `altered` false and re-opening
    // the padding spoof on the very control that closes it.
    let n = 0;
    const flipFlop = {
      toString: () => (n++ === 0 ? 'ProdStack ' : 'ProdStack'),
    };
    const out = displayIdent(flipFlop);
    expect(out).not.toBe('ProdStack');
    expect(n).toBe(1);
  });

  // `.not.toThrow()` ALONE is a silent pass: mutating the inner catch to
  // `return ''` keeps every one of these green, and `''` reads as ABSENT --
  // which this module's header records as the issue #3064 bug it exists to
  // stop. So each case pins the VALUE, not just the absence of a throw.
  it('renders a throwing toString through the fallback, quoted', () => {
    const boom = {
      toString: () => {
        throw new Error('boom');
      },
    };
    // `String()` threw, so `Object.prototype.toString` supplied the text --
    // and because sanitization was not the identity on the ORIGINAL value, the
    // result is quoted rather than bare.
    expect(displayIdent(boom)).toBe('"[object Object]"');
  });

  it('renders a throwing Symbol.toStringTag as the sentinel, not as absent', () => {
    // BOTH paths throw: `String()` first, then the `Object.prototype.toString`
    // fallback, which reads `Symbol.toStringTag`.
    const doubleBoom = {
      toString: null,
      get [Symbol.toStringTag]() {
        throw new Error('boom from the tag');
      },
    };
    expect(displayIdent(doubleBoom)).toBe(`"${UNRENDERABLE}"`);
    expect(displaySafe(doubleBoom)).toBe(UNRENDERABLE);
    expect(displaySafe(doubleBoom)).not.toBe('');
  });

  it('renders a throwing Proxy trap as the sentinel, not as absent', () => {
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error('trap');
        },
      }
    );
    expect(displayIdent(hostile)).toBe(`"${UNRENDERABLE}"`);
    expect(displaySafe(hostile)).toBe(UNRENDERABLE);
    expect(displaySafe(hostile)).not.toBe('');
  });
});
