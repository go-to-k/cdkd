/**
 * `cdkd drift`'s accept and revert plans print a drifted row's PATH masked with
 * the row's printing bag (go-to-k/cdkd#3869), in the lines the report test file
 * does not reach: the accept plan's SKIPPED line and the revert plan's
 * preserved-tag and unbaselined-path lists. Each with an ordinary-name control.
 */
import { describe, expect, it } from 'vite-plus/test';

import {
  printAcceptPlan,
  printRevertPlan,
  type DriftOutcome,
  type HumanTextSink,
} from '../../../src/cli/commands/drift.js';
import { recordLogOnlyValue } from '../../../src/deployment/secret-redaction.js';

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
  extra: Partial<Pick<Drifted, 'awsProperties' | 'maskedPaths' | 'secrets' | 'printingNeedles'>> = {}
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

const NAME = 'team-secret-drift-user';

/** A printing bag holding `NAME` as a log-only needle, or none for the control. */
function needles(secretNamed: boolean): Drifted['printingNeedles'] {
  const bag = new Map() as NonNullable<Drifted['printingNeedles']>;
  if (secretNamed) recordLogOnlyValue(bag, NAME);
  return bag;
}

describe("drift plans mask a path keyed by a secret-derived name (go-to-k/cdkd#3869)", () => {
  it.each([
    [true, 'Meta.***'],
    [false, `Meta.${NAME}`],
  ])("the accept plan's SKIPPED line (secret-named: %s)", (secretNamed, expected) => {
    const path = `Meta.${NAME}`;
    const { lines } = render(
      printAcceptPlan,
      report({
        outcomes: [
          drifted('R', 'T', [{ path, stateValue: '***', awsValue: 'b' }], {
            maskedPaths: new Set([path]) as unknown as Drifted['maskedPaths'],
            printingNeedles: needles(secretNamed),
          }),
        ],
      })
    );
    const skipped = lines.filter((l) => l.includes('SKIPPED'));
    // Premise: the refusal arm printed its line.
    expect(skipped.length).toBe(1);
    expect(skipped[0]).toContain(expected);
    if (secretNamed) expect(lines.join('\n')).not.toContain(NAME);
  });

  it.each([
    [true, 'Cfg.***'],
    [false, `Cfg.${NAME}`],
  ])("the revert plan's unbaselined-path list (secret-named: %s)", (secretNamed, expected) => {
    const { lines } = render(
      printRevertPlan,
      report({
        resources: { R: { properties: { Cfg: { a: 1 } } } },
        outcomes: [
          drifted('R', 'T', [{ path: 'Cfg.a', stateValue: 1, awsValue: 2 }], {
            awsProperties: { Cfg: { a: 2, [NAME]: 3 } },
            printingNeedles: needles(secretNamed),
          }),
        ],
      })
    );
    // Premise: the list printed the readback key.
    expect(lines.some((l) => l.trim() === expected)).toBe(true);
    if (secretNamed) expect(lines.join('\n')).not.toContain(NAME);
  });

  it.each([
    [true, 'Tags.aws:***'],
    [false, `Tags.aws:${NAME}`],
  ])("the revert plan's preserved-tag list (secret-named: %s)", (secretNamed, expected) => {
    const { lines } = render(
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
                { Key: `aws:${NAME}`, Value: 'y' },
              ],
            },
            printingNeedles: needles(secretNamed),
          }),
        ],
      })
    );
    expect(lines.some((l) => l.trim() === expected)).toBe(true);
    if (secretNamed) expect(lines.join('\n')).not.toContain(NAME);
  });
});
