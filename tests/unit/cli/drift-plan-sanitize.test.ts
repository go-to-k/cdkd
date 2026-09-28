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
  type DriftOutcome,
  type HumanTextSink,
} from '../../../src/cli/commands/drift.js';
import { IDENT_MAX_CODE_POINTS } from '../../../src/utils/display-safe.js';

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
const REFUSED = { R: { observedBaselineRefused: true } };

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

  it('renders an ordinary accept plan byte-for-byte as before', () => {
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
        '    VersioningConfiguration.Status: Enabled -> Suspended\n' +
        '    Tags: [{"Key":"a","Value":"b"}] -> null\n'
    );
  });

  it('renders an ordinary revert plan byte-for-byte as before', () => {
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
        '    VersioningConfiguration.Status: Suspended -> Enabled\n'
    );
  });

  it('quotes a plan value whose edges are whitespace or that carries a newline, so the two sides stay distinct', () => {
    const NL_JSON = '\\' + 'n';
    const changes: Change[] = [
      { path: 'TrailingNewline', stateValue: 'abc\n', awsValue: 'abc' },
      { path: 'Padded', stateValue: 'value', awsValue: ' value ' },
    ];
    const accept = render(printAcceptPlan, report({ outcomes: [drifted('R', 'T', changes)] }));
    expect(accept.lines).toContain(`    TrailingNewline: "abc${NL_JSON}" -> abc`);
    expect(accept.lines).toContain('    Padded: value -> " value "');
    const revert = render(printRevertPlan, report({ outcomes: [drifted('R', 'T', changes)] }));
    expect(revert.lines).toContain(`    TrailingNewline: abc -> "abc${NL_JSON}"`);
    expect(revert.lines).toContain('    Padded: " value " -> value');
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
    expect(lines).toContain(`    ${'p'.repeat(IDENT_MAX_CODE_POINTS)}...: 1 -> ${longValue}`);
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
