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
const PLANTED: ReadonlyArray<[name: string, char: string]> = [
  ['ESC', '\x1b'],
  ['newline', '\n'],
  ['ENQ', '\x05'],
  ['LINE SEPARATOR', '\u2028'],
  ['RIGHT-TO-LEFT OVERRIDE', '\u202e'],
];

/**
 * Every (field, row) pair the report prints a record- or readback-derived value
 * on. The value is `A<char>FORGED`; a sanitized row carries `A FORGED` and no
 * line begins with `FORGED`.
 */
const SCENARIOS: ReadonlyArray<[name: string, build: (v: string) => Report, row: string]> = [
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
  ],
  [
    'AWS value on the + row',
    (v) => report({ outcomes: [drifted('R', 'T', [{ path: 'P', stateValue: 1, awsValue: v }])] }),
    '    + ',
  ],
  ['logical id on a ! row', (v) => report({ outcomes: [notCompared(v)] }), '    ! '],
  ['resource type on a ! row', (v) => report({ outcomes: [notCompared('Fn', v)] }), '    ! '],
  ['logical id on a ? row', (v) => report({ outcomes: [unsupported(v)] }), '    ? '],
  ['resource type on a ? row', (v) => report({ outcomes: [unsupported('Thing', v)] }), '    ? '],
];

describe('writeHumanReport treats record- and readback-derived values as untrusted text (go-to-k/cdkd#3232)', () => {
  for (const [scenario, build, row] of SCENARIOS) {
    for (const [name, char] of PLANTED) {
      it(`${scenario}: ${name} is replaced by a space and forges no row`, () => {
        const { joined, lines } = render(build(`A${char}FORGED`));
        // The forged text stays on the row it was planted in.
        const carrier = lines.filter((l) => l.startsWith(row) && l.includes('A FORGED'));
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

  it('keeps a value\'s own padding, so a drift that differs only by whitespace shows two sides', () => {
    // Padding on EACH side in turn, so a trim on either arm reds a case.
    const { lines } = render(
      report({
        outcomes: [
          drifted('R', 'T', [
            { path: 'P', stateValue: ' value ', awsValue: 'value' },
            { path: 'Q', stateValue: 'value', awsValue: ' value ' },
          ]),
        ],
      })
    );
    expect(lines).toContain('    - P:  value ');
    expect(lines).toContain('    + P: value');
    expect(lines).toContain('    - Q: value');
    expect(lines).toContain('    + Q:  value ');
  });

  it('JSON-encodes a structured value first, so a nested control arrives as escape text and a nested LINE SEPARATOR is replaced', () => {
    // `formatScalar` runs before `safeMsg`: JSON escapes a C0 control and a
    // newline (inert text, kept), and leaves U+2028 / U+2029 and the bidi
    // overrides literal (replaced like anywhere else). The escape text is
    // spelled by concatenation so no editor turns it into the character.
    const NL_JSON = '\\' + 'n';
    const ESC_JSON = '\\' + 'u001b';
    const { joined, lines } = render(
      report({
        outcomes: [
          drifted('R', 'T', [
            {
              path: 'P',
              stateValue: { k: 'a\u2028FORGED', n: 'x\ny\x1bz' },
              awsValue: 'x\x1b[2JFORGED',
            },
          ]),
        ],
      })
    );
    expect(joined).not.toContain('\u2028');
    expect(joined).not.toContain('\x1b');
    expect(lines).toContain(`    - P: {"k":"a FORGED","n":"x${NL_JSON}y${ESC_JSON}z"}`);
    expect(lines).toContain('    + P: xFORGED');
  });

  it("keeps a colour or styling code cdkd's own output uses inside a value, as every logger line does", () => {
    // `safeMsg`'s allowlist (go-to-k/cdkd#3479: cdkd's colours, bold, dim,
    // reset): such a sequence in the value is kept — and, unreset, styles the
    // rows after it too, since nothing here adds a reset — while any other
    // CSI or terminated OSC is removed whole, a colour code outside the set
    // becomes a reset, and the ESC of a sequence `safeMsg` does not parse
    // (`ESC 7`, an unterminated OSC) becomes a space with the rest kept.
    // Pinned here so the docs' "with one allowance" sentence is derived from a
    // case rather than asserted; the reset in the fixture is the value's own.
    // An allowed code on EACH side, and a forbidden one on each, so a strip
    // applied to one completed line reds a case.
    const { lines } = render(
      report({
        outcomes: [
          drifted('R', 'T', [
            { path: 'P', stateValue: 'a\x1b[31mb\x1b[0m', awsValue: 'c\x1b[1md\x1b[0m' },
            { path: 'Q', stateValue: 'a\x1b[2Jb', awsValue: 'c\x1b[2Jd' },
            { path: 'S', stateValue: 'a\x1b[38;5;1mb', awsValue: 'c\x1b]8;;u\x07d' },
            { path: 'U', stateValue: 'a\x1b7b', awsValue: 'c\x1b]8;;ud' },
          ]),
        ],
      })
    );
    expect(lines).toContain('    - P: a\x1b[31mb\x1b[0m');
    expect(lines).toContain('    + P: c\x1b[1md\x1b[0m');
    expect(lines).toContain('    - Q: ab');
    expect(lines).toContain('    + Q: cd');
    expect(lines).toContain('    - S: a\x1b[0mb');
    expect(lines).toContain('    + S: cd');
    expect(lines).toContain('    - U: a 7b');
    expect(lines).toContain('    + U: c ]8;;ud');
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

  it("keeps an identifier's padding and styling exactly as it keeps a value's", () => {
    // ONE rule for identifier and value alike (the `reportIdent` doc): no
    // trim, and `safeMsg`'s SGR allowance. Pinned on every helper, so a
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
