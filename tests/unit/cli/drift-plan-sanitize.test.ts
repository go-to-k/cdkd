/**
 * `cdkd drift --accept` / `--revert` print their plan with the same record- and
 * readback-derived fields as the human report, and treat every one as untrusted
 * text the same way (issue go-to-k/cdkd#3949; the report's own rule is
 * go-to-k/cdkd#3232). The revert plan is printed directly above the
 * confirmation prompt, so a forged row there misstates what the operator is
 * about to confirm.
 *
 * One scenario per FIELD × per ROW, because the sanitizing sits at the row
 * that prints the value, and every planted character is asserted per written
 * line, never over a joined string.
 */
import { describe, expect, it } from 'vite-plus/test';

import {
  printAcceptPlan,
  printRevertPlan,
  reportPlanValue,
  type DriftOutcome,
  type HumanTextSink,
} from '../../../src/cli/commands/drift.js';
import {
  IDENT_MAX_CODE_POINTS,
  STACK_REF_MAX_CODE_POINTS,
} from '../../../src/utils/display-safe.js';

type Report = Parameters<typeof printAcceptPlan>[0][number];
type Drifted = Extract<DriftOutcome, { kind: 'drifted' }>;
type Change = Drifted['changes'][number];

function report(
  partial: Partial<Omit<Report, 'state'>> &
    Pick<Report, 'outcomes'> & { resources?: Record<string, Record<string, unknown>> }
): Report {
  const { resources, ...rest } = partial;
  return {
    stackName: 'Prod',
    region: 'us-east-1',
    state: { resources: resources ?? {} } as unknown as Report['state'],
    etag: '',
    migrationPending: false,
    producerRegions: { regions: [], complete: true },
    warnings: [],
    ...rest,
  };
}

function drifted(
  logicalId: string,
  resourceType: string,
  changes: Change[],
  extra: Partial<Pick<Drifted, 'awsProperties' | 'maskedPaths' | 'secrets'>> = {}
): DriftOutcome {
  return {
    kind: 'drifted',
    logicalId,
    resourceType,
    changes,
    awsProperties: {},
    secrets: new Map() as unknown as Drifted['secrets'],
    maskedPaths: new Set() as unknown as Drifted['maskedPaths'],
    uncertifiedPaths: [],
    secretsIncomplete: false,
    notComparedCause: undefined,
    ...extra,
  };
}

const CHANGE: Change = { path: 'P', stateValue: 1, awsValue: 2 };
// The deploy-clearable class, so the plan rows keep their ordinary
// "Deploy a change" remedy; the other two classes are cased below (#3465).
const REFUSED = {
  R: { observedBaselineRefused: true, observedBaselineRefusalReason: 'incomplete-resolution' },
};

function render(
  print: typeof printAcceptPlan,
  ...reports: Report[]
): { joined: string; lines: string[] } {
  const chunks: string[] = [];
  const out: HumanTextSink = {
    write: (chunk) => {
      chunks.push(chunk);
    },
    stream: process.stdout,
  };
  print(reports, out);
  const joined = chunks.join('');
  return { joined, lines: joined.split('\n') };
}

/** The report test's characters: each a different forging route. */
const PLANTED: ReadonlyArray<[name: string, char: string, inQuotedValue: string]> = [
  ['ESC', '\x1b', '\\' + 'u001b'],
  ['newline', '\n', '\\' + 'n'],
  ['ENQ', '\x05', '\\' + 'u0005'],
  ['LINE SEPARATOR', ' ', '\\' + 'u2028'],
  ['RIGHT-TO-LEFT OVERRIDE', '‮', '\\' + 'u202e'],
];

/**
 * Every (field, row) pair a plan prints a record- or readback-derived value on.
 * The value is `A<char>FORGED`; a sanitized identifier carries `A FORGED`, a
 * sanitized value the JSON-quoted `"A<escape>FORGED"`, and no line begins with
 * `FORGED`.
 */
const SCENARIOS: ReadonlyArray<
  [
    name: string,
    print: typeof printAcceptPlan,
    build: (v: string) => Report,
    row: string,
    quoted?: 'quoted',
  ]
> = [
  // --accept
  [
    'accept: stack name on the update heading',
    printAcceptPlan,
    (v) => report({ stackName: v, outcomes: [drifted('R', 'T', [CHANGE])] }),
    'Plan (--accept): update cdkd state for ',
  ],
  [
    'accept: region on the update heading',
    printAcceptPlan,
    (v) => report({ region: v, outcomes: [drifted('R', 'T', [CHANGE])] }),
    'Plan (--accept): update cdkd state for ',
  ],
  [
    'accept: stack name on the nothing-accepted heading',
    printAcceptPlan,
    (v) => report({ stackName: v, resources: REFUSED, outcomes: [drifted('R', 'T', [CHANGE])] }),
    'Plan (--accept): no accepted values ',
  ],
  [
    'accept: region on the nothing-accepted heading',
    printAcceptPlan,
    (v) => report({ region: v, resources: REFUSED, outcomes: [drifted('R', 'T', [CHANGE])] }),
    'Plan (--accept): no accepted values ',
  ],
  [
    'accept: logical id on a ~ row',
    printAcceptPlan,
    (v) => report({ outcomes: [drifted(v, 'T', [CHANGE])] }),
    '  ~ ',
  ],
  [
    'accept: resource type on a ~ row',
    printAcceptPlan,
    (v) => report({ outcomes: [drifted('R', v, [CHANGE])] }),
    '  ~ ',
  ],
  [
    'accept: logical id on a baseline-refused ~ row',
    printAcceptPlan,
    (v) =>
      report({
        resources: { [v]: { observedBaselineRefused: true } },
        outcomes: [drifted(v, 'T', [CHANGE])],
      }),
    '  ~ ',
  ],
  [
    'accept: resource type on a baseline-refused ~ row',
    printAcceptPlan,
    (v) => report({ resources: REFUSED, outcomes: [drifted('R', v, [CHANGE])] }),
    '  ~ ',
  ],
  [
    'accept: property path on a change row',
    printAcceptPlan,
    (v) => report({ outcomes: [drifted('R', 'T', [{ path: v, stateValue: 1, awsValue: 2 }])] }),
    '    ',
  ],
  [
    'accept: state value on a change row',
    printAcceptPlan,
    (v) => report({ outcomes: [drifted('R', 'T', [{ path: 'P', stateValue: v, awsValue: 2 }])] }),
    '    P: ',
    'quoted',
  ],
  [
    'accept: AWS value on a change row',
    printAcceptPlan,
    (v) => report({ outcomes: [drifted('R', 'T', [{ path: 'P', stateValue: 1, awsValue: v }])] }),
    '    P: ',
    'quoted',
  ],
  [
    'accept: property path on a SKIPPED row',
    printAcceptPlan,
    (v) =>
      report({
        outcomes: [
          drifted('R', 'T', [{ path: v, stateValue: 1, awsValue: undefined }], {
            maskedPaths: new Set([v]) as unknown as Drifted['maskedPaths'],
          }),
        ],
      }),
    '    ',
  ],
  // --revert
  [
    'revert: stack name on the heading',
    printRevertPlan,
    (v) => report({ stackName: v, outcomes: [drifted('R', 'T', [CHANGE])] }),
    'Plan (--revert): ',
  ],
  [
    'revert: region on the heading',
    printRevertPlan,
    (v) => report({ region: v, outcomes: [drifted('R', 'T', [CHANGE])] }),
    'Plan (--revert): ',
  ],
  [
    'revert: logical id on a provider.update row',
    printRevertPlan,
    (v) => report({ outcomes: [drifted(v, 'T', [CHANGE])] }),
    '  → provider.update on ',
  ],
  [
    'revert: resource type on a provider.update row',
    printRevertPlan,
    (v) => report({ outcomes: [drifted('R', v, [CHANGE])] }),
    '  → provider.update on ',
  ],
  [
    'revert: logical id on a NOT-reverted ! row',
    printRevertPlan,
    (v) =>
      report({
        resources: { [v]: { observedBaselineRefused: true } },
        outcomes: [drifted(v, 'T', [CHANGE])],
      }),
    '  ! ',
  ],
  [
    'revert: resource type on a NOT-reverted ! row',
    printRevertPlan,
    (v) => report({ resources: REFUSED, outcomes: [drifted('R', v, [CHANGE])] }),
    '  ! ',
  ],
  [
    'revert: property path on a change row',
    printRevertPlan,
    (v) => report({ outcomes: [drifted('R', 'T', [{ path: v, stateValue: 1, awsValue: 2 }])] }),
    '    ',
  ],
  [
    'revert: AWS value on a change row',
    printRevertPlan,
    (v) => report({ outcomes: [drifted('R', 'T', [{ path: 'P', stateValue: 1, awsValue: v }])] }),
    '    P: ',
    'quoted',
  ],
  [
    'revert: state value on a change row',
    printRevertPlan,
    (v) => report({ outcomes: [drifted('R', 'T', [{ path: 'P', stateValue: v, awsValue: 2 }])] }),
    '    P: ',
    'quoted',
  ],
  [
    'revert: readback key on the unbaselined-value list',
    printRevertPlan,
    (v) =>
      report({
        resources: { R: { properties: { Cfg: { a: 1 } } } },
        outcomes: [
          drifted('R', 'T', [{ path: 'Cfg.a', stateValue: 1, awsValue: 2 }], {
            awsProperties: { Cfg: { a: 2, [v]: 3 } },
          }),
        ],
      }),
    '        Cfg.',
  ],
  [
    'revert: readback tag key on the preserved-tag list',
    printRevertPlan,
    (v) =>
      report({
        resources: {
          R: {
            properties: { Tags: [{ Key: 'Name', Value: 'x' }] },
            observedProperties: { Tags: [{ Key: 'Name', Value: 'x' }] },
          },
        },
        outcomes: [
          drifted('R', 'T', [{ path: 'Tags', stateValue: 1, awsValue: 2 }], {
            awsProperties: {
              Tags: [
                { Key: 'Name', Value: 'x' },
                { Key: `aws:${v}`, Value: 'y' },
              ],
            },
          }),
        ],
      }),
    '        Tags.aws:',
  ],
];

describe('the --accept / --revert plans treat record- and readback-derived values as untrusted text (go-to-k/cdkd#3949)', () => {
  for (const [scenario, print, build, row, quoted] of SCENARIOS) {
    for (const [name, char, inQuotedValue] of PLANTED) {
      const shown = quoted ? `"A${inQuotedValue}FORGED"` : 'A FORGED';
      it(`${scenario}: ${name} prints as ${quoted ? 'quoted escape text' : 'a space'} and forges no row`, () => {
        const { joined, lines } = render(print, build(`A${char}FORGED`));
        const carrier = lines.filter((l) => l.startsWith(row) && l.includes(shown));
        expect(carrier, joined).toHaveLength(1);
        expect(lines.filter((l) => l.startsWith('FORGED'))).toEqual([]);
        if (char !== '\n') {
          expect(lines.filter((l) => l.includes(char))).toEqual([]);
        }
      });
    }
  }

  it('renders an ordinary accept plan byte-for-byte', () => {
    const { joined } = render(
      printAcceptPlan,
      report({
        outcomes: [
          drifted('Bucket1', 'AWS::S3::Bucket', [
            { path: 'VersioningConfiguration.Status', stateValue: 'Enabled', awsValue: 'Suspended' },
            { path: 'Tags', stateValue: [{ Key: 'a', Value: 'b' }], awsValue: null },
          ]),
        ],
      })
    );
    expect(joined).toBe(
      '\nPlan (--accept): update cdkd state for Prod (us-east-1):\n' +
        '  ~ Bucket1 (AWS::S3::Bucket)\n' +
        '    VersioningConfiguration.Status: Enabled → Suspended\n' +
        '    Tags: [{"Key":"a","Value":"b"}] → null\n'
    );
  });

  it('renders an ordinary revert plan byte-for-byte', () => {
    const { joined } = render(
      printRevertPlan,
      report({
        outcomes: [
          drifted('Bucket1', 'AWS::S3::Bucket', [
            { path: 'VersioningConfiguration.Status', stateValue: 'Enabled', awsValue: 'Suspended' },
          ]),
        ],
      })
    );
    expect(joined).toBe(
      '\nPlan (--revert): push cdkd state values back into AWS for Prod (us-east-1):\n' +
        '  → provider.update on Bucket1 (AWS::S3::Bucket): revert 1 property path\n' +
        '    VersioningConfiguration.Status: Suspended → Enabled\n'
    );
  });

  it('quotes a plan value whose edges are whitespace or that carries a newline, so the two sides stay distinct', () => {
    const NL_JSON = '\\' + 'n';
    const changes: Change[] = [
      { path: 'TrailingNewline', stateValue: 'abc\n', awsValue: 'abc' },
      { path: 'Padded', stateValue: 'value', awsValue: ' value ' },
    ];
    const accept = render(printAcceptPlan, report({ outcomes: [drifted('R', 'T', changes)] }));
    expect(accept.lines).toContain(`    TrailingNewline: "abc${NL_JSON}" → abc`);
    expect(accept.lines).toContain('    Padded: value → " value "');
    const revert = render(printRevertPlan, report({ outcomes: [drifted('R', 'T', changes)] }));
    expect(revert.lines).toContain(`    TrailingNewline: abc → "abc${NL_JSON}"`);
    expect(revert.lines).toContain('    Padded: " value " → value');
  });

  it("quotes a plan value containing the separator's arrow, on either side, so each line splits one way", () => {
    // Unquoted, `Env: prod → prod → staging` would not say which value the
    // revert pushes. The ARROW is matched, not ` → `: `a →` / `b` and `a` /
    // `→ b` would otherwise both print `a → → b`, and a no-break space around
    // the arrow would pass. Only on a plan line: the report's `-` / `+` rows
    // carry no separator, so it stays unquoted there.
    const changes: Change[] = [
      { path: 'Env', stateValue: 'staging', awsValue: 'prod → prod' },
      { path: 'Rev', stateValue: 'a → b', awsValue: 'c' },
      { path: 'Tight', stateValue: 'a→b', awsValue: 'c' },
      { path: 'TrailingArrow', stateValue: 'b', awsValue: 'a →' },
      { path: 'LeadingArrow', stateValue: '→ b', awsValue: 'a' },
      { path: 'Nbsp', stateValue: 'staging', awsValue: 'prod\u00a0→\u00a0prod' },
      { path: 'Plain', stateValue: 'a-b', awsValue: 'c>d' },
    ];
    const revert = render(printRevertPlan, report({ outcomes: [drifted('R', 'T', changes)] }));
    expect(revert.lines).toContain('    Env: "prod → prod" → staging');
    expect(revert.lines).toContain('    Rev: c → "a → b"');
    expect(revert.lines).toContain('    Tight: c → "a→b"');
    expect(revert.lines).toContain('    TrailingArrow: "a →" → b');
    expect(revert.lines).toContain('    LeadingArrow: a → "→ b"');
    expect(revert.lines).toContain('    Nbsp: "prod\u00a0→\u00a0prod" → staging');
    expect(revert.lines).toContain('    Plain: c>d → a-b');
    const accept = render(printAcceptPlan, report({ outcomes: [drifted('R', 'T', changes)] }));
    expect(accept.lines).toContain('    Env: staging → "prod → prod"');
    expect(accept.lines).toContain('    Rev: "a → b" → c');
    expect(accept.lines).toContain('    TrailingArrow: b → "a →"');
    expect(accept.lines).toContain('    LeadingArrow: "→ b" → a');
  });

  it('quotes a plan value carrying an ASCII `->`, on either side (go-to-k/cdkd#4239)', () => {
    // Bare, a value's `->` is the redirect the separator change removed.
    const changes: Change[] = [
      { path: 'Env', stateValue: 'staging', awsValue: 'prod -> prod' },
      { path: 'Tight', stateValue: 'a->bucket', awsValue: 'c' },
    ];
    const revert = render(printRevertPlan, report({ outcomes: [drifted('R', 'T', changes)] }));
    expect(revert.lines).toContain('    Env: "prod -> prod" → staging');
    expect(revert.lines).toContain('    Tight: c → "a->bucket"');
    const accept = render(printAcceptPlan, report({ outcomes: [drifted('R', 'T', changes)] }));
    expect(accept.lines).toContain('    Env: staging → "prod -> prod"');
    expect(accept.lines).toContain('    Tight: "a->bucket" → c');
  });

  it('reportPlanValue quotes ASCII `->` and every Unicode arrow block, and nothing else', () => {
    const quoted = [
      'a->b',
      'a\u2190b', // ← first of Arrows
      'a\u2192b', // → the separator itself
      'a\u21FFb', // last of Arrows
      'a\u2794b', // ➔ first dingbat arrow
      'a\u27BFb', // last of the dingbat range
      'a\u27F0b', // first of Supplemental Arrows-A
      'a\u27F6b', // ⟶
      'a\u27FFb',
      'a\u2900b', // first of Supplemental Arrows-B
      'a\u297Fb',
      'a\u2B00b', // first of Miscellaneous Symbols and Arrows
      'a\u2B62b', // ⭢
      'a\u2B95b', // ⮕
      'a\u2BFFb',
      'a\u{1F800}b', // first of Supplemental Arrows-C
      'a\u{1F812}b', // 🠒
      'a\u{1F8FF}b',
      'a\uFFE9b', // first halfwidth arrow
      'a\uFFEBb', // ￫
      'a\uFFECb',
    ];
    for (const v of quoted) expect(reportPlanValue(v), v).toBe(JSON.stringify(v));
    // Just outside each block, and the ASCII neighbours of `->`.
    const bare = [
      'a\u218Fb',
      'a\u2200b',
      'a\u2793b',
      'a\u27C0b',
      'a\u28FFb',
      'a\u2980b',
      'a\u2AFFb',
      'a\u2C00b',
      'a\u{1F7FF}b',
      'a\u{1F900}b',
      'a\uFFE8b',
      'a\uFFEDb',
      'a-b',
      // Other redirect spellings are the #3950 value-display class, not arrows.
      'a>b',
      'a- >b',
      'a\u2212>b',
      'a=>b',
    ];
    for (const v of bare) expect(reportPlanValue(v), v).toBe(v);
  });

  it('caps a plan path, never a plan value', () => {
    const longPath = 'p'.repeat(IDENT_MAX_CODE_POINTS + 1);
    const longValue = 'v'.repeat(5000);
    const { lines } = render(
      printAcceptPlan,
      report({
        outcomes: [drifted('R', 'T', [{ path: longPath, stateValue: 1, awsValue: longValue }])],
      })
    );
    expect(lines).toContain(`    ${'p'.repeat(IDENT_MAX_CODE_POINTS)}...: 1 → ${longValue}`);
  });

  it('caps a path on a SKIPPED row and on a readback-key list', () => {
    // Both reach the cap through `reportPath`, a helper of its own.
    const longPath = 'p'.repeat(IDENT_MAX_CODE_POINTS + 1);
    const skipped = render(
      printAcceptPlan,
      report({
        outcomes: [
          drifted('R', 'T', [{ path: longPath, stateValue: 1, awsValue: undefined }], {
            maskedPaths: new Set([longPath]) as unknown as Drifted['maskedPaths'],
          }),
        ],
      })
    );
    expect(
      skipped.lines.filter((l) =>
        l.startsWith(`    ${'p'.repeat(IDENT_MAX_CODE_POINTS)}...: SKIPPED — `)
      )
    ).toHaveLength(1);
    const listed = render(
      printRevertPlan,
      report({
        resources: { R: { properties: { Cfg: { a: 1 } } } },
        outcomes: [
          drifted('R', 'T', [{ path: 'Cfg.a', stateValue: 1, awsValue: 2 }], {
            awsProperties: { Cfg: { a: 2, [longPath]: 3 } },
          }),
        ],
      })
    );
    const cut = `Cfg.${longPath}`.slice(0, IDENT_MAX_CODE_POINTS);
    expect(listed.lines).toContain(`        ${cut}...`);
  });

  // The cap sits in `reportIdent`, reached through each row's own helper call,
  // so a site rewritten as an uncapped `safeMsg` template keeps sanitizing and
  // stops capping: one oversized case per (field, row).
  const CAP_SITES: ReadonlyArray<
    [name: string, print: typeof printAcceptPlan, cap: number, build: (v: string) => Report]
  > = [
    ['accept: stack name on the update heading', printAcceptPlan, STACK_REF_MAX_CODE_POINTS, (v) => report({ stackName: v, outcomes: [drifted('R', 'T', [CHANGE])] })],
    ['accept: region on the update heading', printAcceptPlan, IDENT_MAX_CODE_POINTS, (v) => report({ region: v, outcomes: [drifted('R', 'T', [CHANGE])] })],
    ['accept: stack name on the nothing-accepted heading', printAcceptPlan, STACK_REF_MAX_CODE_POINTS, (v) => report({ stackName: v, resources: REFUSED, outcomes: [drifted('R', 'T', [CHANGE])] })],
    ['accept: region on the nothing-accepted heading', printAcceptPlan, IDENT_MAX_CODE_POINTS, (v) => report({ region: v, resources: REFUSED, outcomes: [drifted('R', 'T', [CHANGE])] })],
    ['accept: logical id on a ~ row', printAcceptPlan, IDENT_MAX_CODE_POINTS, (v) => report({ outcomes: [drifted(v, 'T', [CHANGE])] })],
    ['accept: resource type on a ~ row', printAcceptPlan, IDENT_MAX_CODE_POINTS, (v) => report({ outcomes: [drifted('R', v, [CHANGE])] })],
    ['accept: logical id on a baseline-refused ~ row', printAcceptPlan, IDENT_MAX_CODE_POINTS, (v) => report({ resources: { [v]: { observedBaselineRefused: true } }, outcomes: [drifted(v, 'T', [CHANGE])] })],
    ['accept: resource type on a baseline-refused ~ row', printAcceptPlan, IDENT_MAX_CODE_POINTS, (v) => report({ resources: REFUSED, outcomes: [drifted('R', v, [CHANGE])] })],
    ['revert: stack name on the heading', printRevertPlan, STACK_REF_MAX_CODE_POINTS, (v) => report({ stackName: v, outcomes: [drifted('R', 'T', [CHANGE])] })],
    ['revert: region on the heading', printRevertPlan, IDENT_MAX_CODE_POINTS, (v) => report({ region: v, outcomes: [drifted('R', 'T', [CHANGE])] })],
    ['revert: logical id on a provider.update row', printRevertPlan, IDENT_MAX_CODE_POINTS, (v) => report({ outcomes: [drifted(v, 'T', [CHANGE])] })],
    ['revert: resource type on a provider.update row', printRevertPlan, IDENT_MAX_CODE_POINTS, (v) => report({ outcomes: [drifted('R', v, [CHANGE])] })],
    ['revert: logical id on a NOT-reverted ! row', printRevertPlan, IDENT_MAX_CODE_POINTS, (v) => report({ resources: { [v]: { observedBaselineRefused: true } }, outcomes: [drifted(v, 'T', [CHANGE])] })],
    ['revert: resource type on a NOT-reverted ! row', printRevertPlan, IDENT_MAX_CODE_POINTS, (v) => report({ resources: REFUSED, outcomes: [drifted('R', v, [CHANGE])] })],
  ];
  for (const [name, print, cap, build] of CAP_SITES) {
    it(`caps the ${name}`, () => {
      const { lines } = render(print, build('x'.repeat(cap + 1)));
      expect(lines.filter((l) => l.includes(`${'x'.repeat(cap)}...`))).toHaveLength(1);
      expect(lines.filter((l) => l.includes('x'.repeat(cap + 1)))).toEqual([]);
    });
  }

  it.each([
    ['unverifiable-parameter', { observedBaselineRefusalReason: 'unverifiable-parameter' }, 'Deploying a change does NOT clear this refusal'],
    ['reason-less', {}, 'unless the resource reads a template parameter'],
  ] as const)(
    'names the %s refusal remedy on both plans instead of "Deploy a change" (issue #3465)',
    (_name, reason, remedy) => {
      const resources = { R: { observedBaselineRefused: true, ...reason } };
      const accept = render(printAcceptPlan, report({ resources, outcomes: [drifted('R', 'T', [CHANGE])] }));
      const skipped = accept.lines.filter((l) => l.startsWith("    SKIPPED — a 'cdkd import' run refused"));
      expect(skipped).toHaveLength(1);
      expect(skipped[0]).toContain(remedy);
      expect(skipped[0]).not.toContain('Deploy a change to this resource first.');

      const revert = render(printRevertPlan, report({ resources, outcomes: [drifted('R', 'T', [CHANGE])] }));
      const refused = revert.lines.filter((l) => l.startsWith("  ! R (T): NOT reverted — a 'cdkd import' run"));
      expect(refused).toHaveLength(1);
      expect(refused[0]).toContain(remedy);
      expect(refused[0]).not.toContain('Deploy a change to this resource first.');
    }
  );

  it('renders the ordinary nothing-accepted plan byte-for-byte, and the ordinary SKIPPED, ! and readback-list rows unchanged', () => {
    const accept = render(
      printAcceptPlan,
      report({
        resources: REFUSED,
        outcomes: [drifted('R', 'T', [CHANGE])],
      })
    );
    expect(accept.joined).toBe(
      '\nPlan (--accept): no accepted values will be written to cdkd state for Prod (us-east-1) ' +
        '— every drifted change below is refused (the run still writes the positioned re-redaction):\n' +
        '  ~ R (T)\n' +
        "    SKIPPED — a 'cdkd import' run refused this resource's observed-properties baseline; " +
        'accepting would write the AWS readback into properties it already found untrustworthy. ' +
        'Deploy a change to this resource first.\n'
    );
    const skipped = render(
      printAcceptPlan,
      report({
        outcomes: [
          drifted('R', 'T', [{ path: 'Cfg.k', stateValue: 1, awsValue: undefined }], {
            maskedPaths: new Set(['Cfg.k']) as unknown as Drifted['maskedPaths'],
          }),
        ],
      })
    );
    expect(skipped.lines.filter((l) => l.startsWith('    Cfg.k: SKIPPED — AWS no longer reports it'))).toHaveLength(1);
    const refused = render(printRevertPlan, report({ resources: REFUSED, outcomes: [drifted('R', 'T', [CHANGE])] }));
    expect(refused.lines.filter((l) => l.startsWith("  ! R (T): NOT reverted — a 'cdkd import' run"))).toHaveLength(1);
    expect(refused.joined).toContain('found untrustworthy. Deploy a change to this resource first.\n');
    const listed = render(
      printRevertPlan,
      report({
        resources: {
          R: {
            properties: { Tags: [{ Key: 'Name', Value: 'x' }], Cfg: { a: 1 } },
          },
        },
        outcomes: [
          drifted(
            'R',
            'T',
            [
              { path: 'Cfg.a', stateValue: 1, awsValue: 2 },
              { path: 'Tags', stateValue: 1, awsValue: 2 },
            ],
            {
              awsProperties: {
                Cfg: { a: 2, extra: 3 },
                Tags: [
                  { Key: 'Name', Value: 'x' },
                  { Key: 'aws:cloudformation:stack-name', Value: 'y' },
                ],
              },
            }
          ),
        ],
      })
    );
    expect(listed.lines).toContain('        Tags.aws:cloudformation:stack-name');
    expect(listed.lines).toContain('        Cfg.extra');
  });

  it('masks a preserved tag key BEFORE capping it, as the unbaselined list does', () => {
    const secret = 'S3cr3tValueNeverPrinted';
    const tagKey = 'aws:' + 'x'.repeat(IDENT_MAX_CODE_POINTS - 15) + secret;
    const { joined, lines } = render(
      printRevertPlan,
      report({
        resources: {
          R: {
            properties: { Tags: [{ Key: 'Name', Value: 'x' }] },
            observedProperties: { Tags: [{ Key: 'Name', Value: 'x' }] },
          },
        },
        outcomes: [
          drifted('R', 'T', [{ path: 'Tags', stateValue: 1, awsValue: 2 }], {
            awsProperties: {
              Tags: [
                { Key: 'Name', Value: 'x' },
                { Key: tagKey, Value: 'y' },
              ],
            },
            secrets: new Map([[secret, 'ref']]) as unknown as Drifted['secrets'],
          }),
        ],
      })
    );
    expect(lines).toContain(`        Tags.aws:${'x'.repeat(IDENT_MAX_CODE_POINTS - 15)}***`);
    expect(joined).not.toContain('S3cr');
  });

  it('masks a readback key BEFORE capping it, so the cut can never leave a secret prefix unmasked', () => {
    // The secret straddles the cap: capped first, the list would print its
    // prefix, which no longer matches the masker's needle.
    const secret = 'S3cr3tValueNeverPrinted';
    const key = 'x'.repeat(IDENT_MAX_CODE_POINTS - 10) + secret;
    const { joined, lines } = render(
      printRevertPlan,
      report({
        resources: { R: { properties: { Cfg: { a: 1 } } } },
        outcomes: [
          drifted('R', 'T', [{ path: 'Cfg.a', stateValue: 1, awsValue: 2 }], {
            awsProperties: { Cfg: { a: 2, [key]: 3 } },
            secrets: new Map([[secret, 'ref']]) as unknown as Drifted['secrets'],
          }),
        ],
      })
    );
    expect(lines).toContain(`        Cfg.${'x'.repeat(IDENT_MAX_CODE_POINTS - 10)}***`);
    expect(joined).not.toContain('S3cr');
  });
});
