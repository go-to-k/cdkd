/**
 * `cdkd drift`'s human report treats every value it prints out of a state
 * record or an AWS readback as untrusted text (issue go-to-k/cdkd#3232).
 *
 * One scenario per FIELD × per ROW the field reaches, because the sanitizing
 * sits at the row that prints the value: a probe that restores one row's raw
 * interpolation must red the case for THAT row, not be covered by a sibling.
 * Each planted character is asserted per written line, never over a joined
 * string — a joined string would let a forged row hide inside a legitimate one.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test';

import { writeHumanReport, type DriftOutcome } from '../../../src/cli/commands/drift.js';
import {
  IDENT_MAX_CODE_POINTS,
  STACK_REF_MAX_CODE_POINTS,
} from '../../../src/utils/display-safe.js';

type Report = Parameters<typeof writeHumanReport>[0][number];
type Drifted = Extract<DriftOutcome, { kind: 'drifted' }>;

function report(partial: Partial<Report> & Pick<Report, 'outcomes'>): Report {
  return {
    stackName: 'Prod',
    region: 'us-east-1',
    state: {} as Report['state'],
    etag: '',
    migrationPending: false,
    warnings: [],
    ...partial,
  };
}

function drifted(
  logicalId: string,
  resourceType: string,
  changes: Drifted['changes'],
  notComparedCause: Drifted['notComparedCause'] = undefined
): DriftOutcome {
  return {
    kind: 'drifted',
    logicalId,
    resourceType,
    changes,
    awsProperties: {},
    secrets: {} as Drifted['secrets'],
    maskedPaths: new Set() as unknown as Drifted['maskedPaths'],
    uncertifiedPaths: [],
    secretsIncomplete: false,
    notComparedCause,
  };
}

function clean(logicalId = 'Bucket', resourceType = 'AWS::S3::Bucket'): DriftOutcome {
  return { kind: 'clean', logicalId, resourceType };
}

function unsupported(logicalId = 'Thing', resourceType = 'AWS::X::Y'): DriftOutcome {
  return { kind: 'unsupported', logicalId, resourceType };
}

function notCompared(logicalId = 'Fn', resourceType = 'AWS::Lambda::Function'): DriftOutcome {
  return { kind: 'notCompared', logicalId, resourceType, notComparedCause: 'refused' };
}

let chunks: string[];
let original: typeof process.stdout.write;
beforeEach(() => {
  chunks = [];
  original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8'));
    return true;
  }) as typeof process.stdout.write;
});
afterEach(() => {
  process.stdout.write = original;
});

function render(...reports: Report[]): { joined: string; lines: string[] } {
  writeHumanReport(reports);
  const joined = chunks.join('');
  return { joined, lines: joined.split('\n') };
}

/**
 * The characters the issue names, each a different forging route: an escape
 * (cursor movement, screen clear), a newline (a whole invented row), a C0
 * control the terminal may act on, LINE SEPARATOR (a line break the shell's
 * line discipline does not see) and RIGHT-TO-LEFT OVERRIDE (reorders what the
 * reader sees).
 */
const PLANTED: ReadonlyArray<[name: string, char: string, inQuotedValue: string]> = [
  // The third element is what a property VALUE, which is JSON-quoted when it
  // carries such a character, prints in its place: its `\uXXXX` / `\n` escape
  // text, whether JSON writes it or `escapeJsonLiterals` does. Spelled by
  // concatenation so no editor turns the escape text into the character.
  ['ESC', '\x1b', '\\' + 'u001b'],
  ['newline', '\n', '\\' + 'n'],
  ['ENQ', '\x05', '\\' + 'u0005'],
  ['LINE SEPARATOR', '\u2028', '\\' + 'u2028'],
  ['RIGHT-TO-LEFT OVERRIDE', '\u202e', '\\' + 'u202e'],
];

/**
 * Every (field, row) pair the report prints a record- or readback-derived value
 * on. The value is `A<char>FORGED`; a sanitized identifier row carries
 * `A FORGED`, a sanitized value row the JSON-quoted `"A<escape>FORGED"`, and no
 * line begins with `FORGED`.
 */
const SCENARIOS: ReadonlyArray<
  [name: string, build: (v: string) => Report, row: string, quoted?: 'quoted']
> = [
  ['stack name on the ✓ heading', (v) => report({ stackName: v, outcomes: [clean()] }), '✓ '],
  ['region on the ✓ heading', (v) => report({ region: v, outcomes: [clean()] }), '✓ '],
  [
    'stack name on the drift-detected heading',
    (v) => report({ stackName: v, outcomes: [drifted('R', 'T', [])] }),
    '⚠ ',
  ],
  [
    'region on the drift-detected heading',
    (v) => report({ region: v, outcomes: [drifted('R', 'T', [])] }),
    '⚠ ',
  ],
  [
    'stack name on the NOTHING-compared heading',
    (v) => report({ stackName: v, outcomes: [unsupported()] }),
    '⚠ ',
  ],
  [
    'region on the NOTHING-compared heading',
    (v) => report({ region: v, outcomes: [unsupported()] }),
    '⚠ ',
  ],
  [
    'stack name on the partially-compared heading',
    (v) => report({ stackName: v, outcomes: [notCompared()] }),
    '⚠ ',
  ],
  [
    'region on the partially-compared heading',
    (v) => report({ region: v, outcomes: [notCompared()] }),
    '⚠ ',
  ],
  ['logical id on a ~ row', (v) => report({ outcomes: [drifted(v, 'T', [])] }), '  ~ '],
  ['resource type on a ~ row', (v) => report({ outcomes: [drifted('R', v, [])] }), '  ~ '],
  [
    'property path on the - row',
    (v) => report({ outcomes: [drifted('R', 'T', [{ path: v, stateValue: 1, awsValue: 2 }])] }),
    '    - ',
  ],
  [
    'property path on the + row',
    (v) => report({ outcomes: [drifted('R', 'T', [{ path: v, stateValue: 1, awsValue: 2 }])] }),
    '    + ',
  ],
  [
    'state value on the - row',
    (v) => report({ outcomes: [drifted('R', 'T', [{ path: 'P', stateValue: v, awsValue: 2 }])] }),
    '    - ',
    'quoted',
  ],
  [
    'AWS value on the + row',
    (v) => report({ outcomes: [drifted('R', 'T', [{ path: 'P', stateValue: 1, awsValue: v }])] }),
    '    + ',
    'quoted',
  ],
  ['logical id on a ! row', (v) => report({ outcomes: [notCompared(v)] }), '    ! '],
  ['resource type on a ! row', (v) => report({ outcomes: [notCompared('Fn', v)] }), '    ! '],
  ['logical id on a ? row', (v) => report({ outcomes: [unsupported(v)] }), '    ? '],
  ['resource type on a ? row', (v) => report({ outcomes: [unsupported('Thing', v)] }), '    ? '],
];

describe('writeHumanReport treats record- and readback-derived values as untrusted text (go-to-k/cdkd#3232)', () => {
  for (const [scenario, build, row, quoted] of SCENARIOS) {
    for (const [name, char, inQuotedValue] of PLANTED) {
      const shown = quoted ? `"A${inQuotedValue}FORGED"` : 'A FORGED';
      it(`${scenario}: ${name} prints as ${quoted ? 'quoted escape text' : 'a space'} and forges no row`, () => {
        const { joined, lines } = render(build(`A${char}FORGED`));
        // The forged text stays on the row it was planted in.
        const carrier = lines.filter((l) => l.startsWith(row) && l.includes(shown));
        expect(carrier, joined).toHaveLength(1);
        // Asserted per LINE: no line begins with the text a newline would have
        // put at column 0, and no line carries the character itself.
        expect(lines.filter((l) => l.startsWith('FORGED'))).toEqual([]);
        if (char !== '\n') {
          expect(lines.filter((l) => l.includes(char))).toEqual([]);
        }
      });
    }
  }

  it('renders an ordinary drifted report byte-for-byte as before', () => {
    const { joined } = render(
      report({
        outcomes: [
          drifted('Bucket1', 'AWS::S3::Bucket', [
            { path: 'VersioningConfiguration.Status', stateValue: 'Enabled', awsValue: 'Suspended' },
            { path: 'Tags', stateValue: [{ Key: 'a', Value: 'b' }], awsValue: null },
          ]),
          clean('Bucket2'),
        ],
      })
    );
    expect(joined).toBe(
      '\n⚠ Prod (us-east-1): drift detected on 1 resource\n\n' +
        '  ~ Bucket1 (AWS::S3::Bucket)\n' +
        '    - VersioningConfiguration.Status: Enabled\n' +
        '    + VersioningConfiguration.Status: Suspended\n' +
        '    - Tags: [{"Key":"a","Value":"b"}]\n' +
        '    + Tags: null\n' +
        '\n'
    );
  });

  it('renders the ✓ heading and the ! and ? rows byte-for-byte as before', () => {
    const { joined } = render(
      report({ outcomes: [clean(), unsupported()] }),
      report({ stackName: 'Parent~Child', region: 'eu-west-1', outcomes: [notCompared()] })
    );
    expect(joined).toBe(
      '✓ Prod (us-east-1): no drift detected (1 resource checked, 1 unsupported)\n' +
        '\n  1 resource(s) reported as drift unknown — provider does not yet support drift detection:\n' +
        '    ? Thing (AWS::X::Y)\n' +
        '⚠ Parent~Child (eu-west-1): no drift detected, but 0 of 1 resource fully checked ' +
        '(1 only partially compared), 0 unsupported\n' +
        '\n  1 resource(s) only PARTIALLY compared — cdkd could not, or refused to, resolve a ' +
        'dynamic reference their state records, so their secret-bearing properties were NOT compared:\n' +
        '    ! Fn (AWS::Lambda::Function) — cdkd refused to resolve a dynamic reference its state ' +
        'records (spell the reference as a full ARN, which names its region)\n'
    );
  });

  it('quotes a value whose edges are whitespace or that carries a tab or a newline, so a drift that differs only there shows two sides', () => {
    // Each pair on EACH side in turn, so a trim, or a quoting rule applied to
    // one arm only, reds a case. Asserted as exact lines AND as the two sides
    // differing, which is the property the reader needs.
    const NL_JSON = '\\' + 'n';
    const TAB_JSON = '\\' + 't';
    const BS = '\\';
    const pairs: Array<[path: string, stateValue: string, awsValue: string, minus: string, plus: string]> = [
      ['P', ' value ', 'value', '" value "', 'value'],
      ['Q', 'value', ' value ', 'value', '" value "'],
      ['TrailingNewline', 'abc\n', 'abc', `"abc${NL_JSON}"`, 'abc'],
      ['LeadingNewline', 'abc', '\nabc', 'abc', `"${NL_JSON}abc"`],
      ['Tab', 'a\tb', 'a b', `"a${TAB_JSON}b"`, 'a b'],
      ['TabOnPlus', 'a b', 'a\tb', 'a b', `"a${TAB_JSON}b"`],
      ['TrailingSpace', 'abc ', 'abc', '"abc "', 'abc'],
      ['LeadingSpace', 'abc', ' abc', 'abc', '" abc"'],
      // Both sides quoted: the characters JSON leaves literal are escaped too,
      // so they never print like a space or like each other.
      ['LsVsSpace', 'abc\u2028', 'abc ', `"abc${BS}u2028"`, '"abc "'],
      ['DelVsC1', 'a\u007fb', 'a\u009fb', `"a${BS}u007fb"`, `"a${BS}u009fb"`],
      ['TwoLiterals', 'a\u2028b\u2028', 'a\u2028b ', `"a${BS}u2028b${BS}u2028"`, `"a${BS}u2028b "`],
      ['BidiVsBidi', 'a\u202a', 'a\u2066', `"a${BS}u202a"`, `"a${BS}u2066"`],
      ['NoBreakSpace', 'abc', 'abc\u00a0', 'abc', '"abc\u00a0"'],
    ];
    const { lines } = render(
      report({
        outcomes: [
          drifted(
            'R',
            'T',
            pairs.map(([path, stateValue, awsValue]) => ({ path, stateValue, awsValue }))
          ),
        ],
      })
    );
    for (const [path, , , minus, plus] of pairs) {
      const minusLine = lines.find((l) => l.startsWith(`    - ${path}: `));
      const plusLine = lines.find((l) => l.startsWith(`    + ${path}: `));
      expect(minusLine).toBe(`    - ${path}: ${minus}`);
      expect(plusLine).toBe(`    + ${path}: ${plus}`);
      expect(minusLine?.slice(6)).not.toBe(plusLine?.slice(6));
    }
  });

  it('quotes a value carrying any character safeMsg alters, at every edge of every range', () => {
    // One case per range END of the set `reportValue` quotes for, so narrowing
    // any range reds a case. JSON escapes the C0 ones and `escapeJsonLiterals`
    // the ones JSON leaves literal, so each prints as its own escape text and
    // no two of them print alike.
    const edges: Array<[char: string, shown: string]> = [
      ['\u0000', '\\' + 'u0000'],
      ['\u001f', '\\' + 'u001f'],
      ['\u007f', '\\' + 'u007f'],
      ['\u009f', '\\' + 'u009f'],
      ['\u2028', '\\' + 'u2028'],
      ['\u2029', '\\' + 'u2029'],
      ['\u202a', '\\' + 'u202a'],
      ['\u202e', '\\' + 'u202e'],
      ['\u2066', '\\' + 'u2066'],
      ['\u2069', '\\' + 'u2069'],
    ];
    const { lines } = render(
      report({
        outcomes: [
          drifted(
            'R',
            'T',
            edges.map(([char], i) => ({ path: `P${i}`, stateValue: `a${char}b`, awsValue: 'a b' }))
          ),
        ],
      })
    );
    edges.forEach(([, shown], i) => {
      expect(lines).toContain(`    - P${i}: "a${shown}b"`);
      expect(lines).toContain(`    + P${i}: a b`);
    });
    // And the character just outside a range is left alone.
    const { lines: outside } = render(
      report({
        outcomes: [drifted('R', 'T', [{ path: 'P', stateValue: 'a\u00a0b\u2065c', awsValue: 1 }])],
      })
    );
    expect(outside).toContain('    - P: a\u00a0b\u2065c');
  });

  it('quotes a value that already starts with a double quote, so it cannot pass for a quoted one', () => {
    // Without this, the RAW text `"abc\n"` (quote, abc, backslash, n, quote)
    // would print exactly as the quoted form of `abc` plus a newline.
    const NL_JSON = '\\' + 'n';
    const { lines } = render(
      report({
        outcomes: [
          drifted('R', 'T', [
            { path: 'P', stateValue: 'abc\n', awsValue: `"abc${NL_JSON}"` },
            { path: 'Q', stateValue: '"', awsValue: 'a"b' },
          ]),
        ],
      })
    );
    expect(lines).toContain(`    - P: "abc${NL_JSON}"`);
    expect(lines).toContain(`    + P: "\\"abc\\${NL_JSON}\\""`);
    expect(lines).toContain('    - Q: "\\""');
    // A quote INSIDE a value is not at its start and changes nothing.
    expect(lines).toContain('    + Q: a"b');
  });

  it('JSON-encodes a structured value first, so every nested control, LINE SEPARATOR included, arrives as escape text', () => {
    // `formatScalar` then `escapeJsonLiterals` run before `safeMsg`: JSON
    // escapes a C0 control and a newline, and `escapeJsonLiterals` the U+2028
    // / U+2029 and bidi characters JSON leaves literal, so the text is inert
    // and a nested LINE SEPARATOR cannot print like a nested space. The escape
    // text is spelled by concatenation so no editor turns it into the character.
    const NL_JSON = '\\' + 'n';
    const ESC_JSON = '\\' + 'u001b';
    const LS_JSON = '\\' + 'u2028';
    const { joined, lines } = render(
      report({
        outcomes: [
          drifted('R', 'T', [
            {
              path: 'P',
              stateValue: { k: 'a\u2028FORGED', n: 'x\ny\x1bz' },
              awsValue: 'x\x1b[2JFORGED',
            },
            { path: 'Q', stateValue: { k: 'a\u2028' }, awsValue: { k: 'a ' } },
            // A LIST, and a control on the AWS side of each shape.
            { path: 'L', stateValue: ['a', 'b'], awsValue: ['a\u2028', 'b\u202e'] },
            { path: 'O', stateValue: { k: 'a' }, awsValue: { k: 'a\u2066\x1b' } },
          ]),
        ],
      })
    );
    expect(joined).not.toContain('\u2028');
    expect(joined).not.toContain('\x1b');
    expect(lines).toContain(`    - P: {"k":"a${LS_JSON}FORGED","n":"x${NL_JSON}y${ESC_JSON}z"}`);
    // A string value with a control is quoted the same way (go-to-k/cdkd#3921 M0).
    expect(lines).toContain(`    + P: "x${ESC_JSON}[2JFORGED"`);
    // A nested LINE SEPARATOR and a nested space print differently.
    expect(lines).toContain(`    - Q: {"k":"a${LS_JSON}"}`);
    expect(lines).toContain('    + Q: {"k":"a "}');
    const RLO_JSON = '\\' + 'u202e';
    const LRI_JSON = '\\' + 'u2066';
    expect(lines).toContain('    - L: ["a","b"]');
    expect(lines).toContain(`    + L: ["a${LS_JSON}","b${RLO_JSON}"]`);
    expect(lines).toContain('    - O: {"k":"a"}');
    expect(lines).toContain(`    + O: {"k":"a${LRI_JSON}${ESC_JSON}"}`);
  });

  it("keeps a colour or styling code cdkd's own output uses inside an identifier, as every logger line does, and quotes one in a value", () => {
    // `safeMsg`'s allowlist (go-to-k/cdkd#3479: cdkd's colours, bold, dim,
    // reset): such a sequence in an identifier is kept — and, unreset, styles
    // the rows after it too, since nothing here adds a reset — while any other
    // CSI or terminated OSC is removed whole, a colour code outside the set
    // becomes a reset, and the ESC of a sequence `safeMsg` does not parse
    // (`ESC 7`, an unterminated OSC) becomes a space with the rest kept.
    // Pinned here so the docs' "one allowance" sentence is derived from a case
    // rather than asserted; the reset in the fixture is the identifier's own.
    // The path prints on BOTH lines of a change, so a strip applied to one
    // completed line reds a case. A property VALUE carrying the same code is
    // JSON-quoted first, so its ESC prints as escape text, never as colour.
    const ESC_JSON = '\\' + 'u001b';
    const paths: Array<[planted: string, shown: string]> = [
      ['a\x1b[31mb\x1b[0m', 'a\x1b[31mb\x1b[0m'],
      ['c\x1b[1md\x1b[0m', 'c\x1b[1md\x1b[0m'],
      ['a\x1b[2Jb', 'ab'],
      ['a\x1b[38;5;1mb', 'a\x1b[0mb'],
      ['c\x1b]8;;u\x07d', 'cd'],
      ['a\x1b7b', 'a 7b'],
      ['c\x1b]8;;ud', 'c ]8;;ud'],
    ];
    const { lines } = render(
      report({
        outcomes: [
          drifted('R', 'T', [
            ...paths.map(([path]) => ({ path, stateValue: 1, awsValue: 2 })),
            { path: 'V', stateValue: 'a\x1b[31mb\x1b[0m', awsValue: 'ab' },
          ]),
        ],
      })
    );
    for (const [, shown] of paths) {
      expect(lines).toContain(`    - ${shown}: 1`);
      expect(lines).toContain(`    + ${shown}: 2`);
    }
    expect(lines).toContain(`    - V: "a${ESC_JSON}[31mb${ESC_JSON}[0m"`);
    expect(lines).toContain('    + V: ab');
  });

  it('sanitizes a resource that is both drifted and only partially compared on both of its rows', () => {
    // A drifted outcome carrying `notComparedCause` prints on the `~` row AND
    // on the `!` row; each goes through `reportResource`.
    const { joined, lines } = render(
      report({
        outcomes: [
          drifted(
            'A\nFORGED',
            'T\x1b[2J',
            [{ path: 'P', stateValue: 1, awsValue: 2 }],
            'refused'
          ),
        ],
      })
    );
    expect(lines.filter((l) => l.startsWith('  ~ A FORGED (T)')), joined).toHaveLength(1);
    expect(lines.filter((l) => l.startsWith('    ! A FORGED (T) — ')), joined).toHaveLength(1);
    expect(lines.filter((l) => l.startsWith('FORGED'))).toEqual([]);
    expect(joined).not.toContain('\x1b');
  });

  it('caps every identifier, and never a property value', () => {
    const longId = 'a'.repeat(IDENT_MAX_CODE_POINTS + 1);
    const longStack = 's'.repeat(STACK_REF_MAX_CODE_POINTS + 1);
    const longValue = 'v'.repeat(5000);
    const longAwsValue = 'w'.repeat(5000);
    const { lines } = render(
      report({
        stackName: longStack,
        region: 'r'.repeat(IDENT_MAX_CODE_POINTS + 1),
        outcomes: [
          drifted(longId, 't'.repeat(IDENT_MAX_CODE_POINTS + 1), [
            {
              path: 'p'.repeat(IDENT_MAX_CODE_POINTS + 1),
              stateValue: longValue,
              awsValue: longAwsValue,
            },
          ]),
        ],
      })
    );
    expect(lines).toContain(
      `⚠ ${'s'.repeat(STACK_REF_MAX_CODE_POINTS)}... (${'r'.repeat(IDENT_MAX_CODE_POINTS)}...): drift detected on 1 resource`
    );
    expect(lines).toContain(
      `  ~ ${'a'.repeat(IDENT_MAX_CODE_POINTS)}... (${'t'.repeat(IDENT_MAX_CODE_POINTS)}...)`
    );
    expect(lines).toContain(`    - ${'p'.repeat(IDENT_MAX_CODE_POINTS)}...: ${longValue}`);
    expect(lines).toContain(`    + ${'p'.repeat(IDENT_MAX_CODE_POINTS)}...: ${longAwsValue}`);
  });

  it("keeps an identifier's padding and cdkd's own styling on every helper", () => {
    // No trim, and `safeMsg`'s SGR allowance (the `reportIdent` doc; a
    // property VALUE is quoted instead, pinned above). Pinned on every helper, so a
    // `.trim()` or a `displaySafe` pass added to `reportIdent` reds a case.
    // Padding AND an allowed sequence on every helper's inputs — heading,
    // resource row, change line — so a strip applied to any one helper's
    // result reds a case of its own.
    const { lines } = render(
      report({
        stackName: ' \x1b[1mProd\x1b[0m ',
        region: ' \x1b[31mr\x1b[0m ',
        outcomes: [
          drifted(' Id ', 'a\x1b[1mT\x1b[0m', [
            { path: ' \x1b[31mP\x1b[0m ', stateValue: 1, awsValue: 2 },
          ]),
          notCompared('\x1b[31mFn\x1b[0m', ' L '),
        ],
      })
    );
    expect(lines).toContain(
      '⚠  \x1b[1mProd\x1b[0m  ( \x1b[31mr\x1b[0m ): drift detected on 1 resource'
    );
    expect(lines).toContain('  ~  Id  (a\x1b[1mT\x1b[0m)');
    expect(lines).toContain('    -  \x1b[31mP\x1b[0m : 1');
    expect(lines).toContain('    +  \x1b[31mP\x1b[0m : 2');
    expect(lines.filter((l) => l.startsWith('    ! \x1b[31mFn\x1b[0m ( L ) — '))).toHaveLength(1);
  });

  // The cap sits in `reportIdent`, but each row reaches it through its own
  // helper call, so a site rewritten as an uncapped `safeMsg` template keeps
  // sanitizing and stops capping: one oversized case per (field, row).
  const CAP_SITES: ReadonlyArray<[name: string, cap: number, build: (v: string) => Report]> = [
    ['stack name on the ✓ heading', STACK_REF_MAX_CODE_POINTS, (v) => report({ stackName: v, outcomes: [clean()] })],
    ['region on the ✓ heading', IDENT_MAX_CODE_POINTS, (v) => report({ region: v, outcomes: [clean()] })],
    ['stack name on the NOTHING-compared heading', STACK_REF_MAX_CODE_POINTS, (v) => report({ stackName: v, outcomes: [unsupported()] })],
    ['region on the NOTHING-compared heading', IDENT_MAX_CODE_POINTS, (v) => report({ region: v, outcomes: [unsupported()] })],
    ['stack name on the partially-compared heading', STACK_REF_MAX_CODE_POINTS, (v) => report({ stackName: v, outcomes: [notCompared()] })],
    ['region on the partially-compared heading', IDENT_MAX_CODE_POINTS, (v) => report({ region: v, outcomes: [notCompared()] })],
    ['logical id on a ! row', IDENT_MAX_CODE_POINTS, (v) => report({ outcomes: [notCompared(v)] })],
    ['resource type on a ! row', IDENT_MAX_CODE_POINTS, (v) => report({ outcomes: [notCompared('Fn', v)] })],
    ['logical id on a ? row', IDENT_MAX_CODE_POINTS, (v) => report({ outcomes: [unsupported(v)] })],
    ['resource type on a ? row', IDENT_MAX_CODE_POINTS, (v) => report({ outcomes: [unsupported('Thing', v)] })],
  ];
  for (const [name, cap, build] of CAP_SITES) {
    it(`caps the ${name}`, () => {
      const { lines } = render(build('x'.repeat(cap + 1)));
      expect(lines.filter((l) => l.includes(`${'x'.repeat(cap)}...`))).toHaveLength(1);
      expect(lines.filter((l) => l.includes('x'.repeat(cap + 1)))).toEqual([]);
    });
  }

  it('does not cut an identifier exactly at the cap, and never inside a surrogate pair', () => {
    const atCap = 'a'.repeat(IDENT_MAX_CODE_POINTS);
    const emoji = '😀'.repeat(IDENT_MAX_CODE_POINTS + 1);
    const { lines } = render(
      report({ outcomes: [drifted(atCap, emoji, [])] })
    );
    expect(lines).toContain(`  ~ ${atCap} (${'😀'.repeat(IDENT_MAX_CODE_POINTS)}...)`);
  });
});
