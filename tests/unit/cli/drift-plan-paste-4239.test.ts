/**
 * A `cdkd drift --accept` / `--revert` plan line pasted into a shell must not
 * redirect into a file its value names (issue go-to-k/cdkd#4239). The line was
 * `<path>: <from> -> <to>`, and pasted, `->` is `-` plus a `>` redirect onto
 * the bare value after it — so a readback or baseline value `bucket` truncated
 * `./bucket`. Red on the `->` separator: the harness plants `bucket` as a decoy
 * with content, and the truncation is what it detects.
 */
import { describe, expect, it } from 'vite-plus/test';

import {
  printAcceptPlan,
  printRevertPlan,
  type DriftOutcome,
  type HumanTextSink,
} from '../../../src/cli/commands/drift.js';
import { SECRET_MASK } from '../../../src/deployment/secret-redaction.js';
import {
  PASTE_CHILD_TIMEOUT_MS,
  segmentsOf,
  spanRun,
  spansThatRun,
  withPasteDir,
} from '../utils/paste-harness.js';

type Report = Parameters<typeof printAcceptPlan>[0][number];
type Drifted = Extract<DriftOutcome, { kind: 'drifted' }>;

function report(changes: Drifted['changes'], maskedPaths: string[] = []): Report {
  const outcome: DriftOutcome = {
    kind: 'drifted',
    logicalId: 'Param',
    resourceType: 'AWS::SSM::Parameter',
    changes,
    awsProperties: {},
    secrets: new Map() as unknown as Drifted['secrets'],
    maskedPaths: new Set(maskedPaths) as unknown as Drifted['maskedPaths'],
    uncertifiedPaths: [],
    secretsIncomplete: false,
    notComparedCause: undefined,
  };
  return {
    stackName: 'Prod',
    region: 'us-east-1',
    state: { resources: {} } as unknown as Report['state'],
    etag: '',
    migrationPending: false,
    producerRegions: { regions: [], complete: true },
    warnings: [],
    outcomes: [outcome],
  };
}

function render(print: typeof printAcceptPlan, r: Report): string {
  let text = '';
  const sink: HumanTextSink = {
    write: (chunk) => {
      text += chunk;
    },
    stream: process.stdout,
  };
  print([r], sink);
  return text;
}

describe('a pasted drift plan line redirects nothing (go-to-k/cdkd#4239)', () => {
  // `bucket` sits on the RIGHT of the separator in each plan: the accept plan
  // prints `<baseline> → <readback>`, the revert plan `<readback> → <baseline>`.
  const cases: [string, typeof printAcceptPlan, Drifted['changes']][] = [
    ['--accept', printAcceptPlan, [{ path: 'Value', stateValue: 'prod', awsValue: 'bucket' }]],
    ['--revert', printRevertPlan, [{ path: 'Value', stateValue: 'bucket', awsValue: 'prod' }]],
  ];
  // A value carrying its OWN `->` before a decoy: bare, it is the same redirect
  // the separator stopped printing, so the value is quoted.
  const ownArrow: [string, typeof printAcceptPlan, Drifted['changes']][] = [
    ['--accept', printAcceptPlan, [{ path: 'Value', stateValue: 'prod', awsValue: 'a->bucket' }]],
    ['--revert', printRevertPlan, [{ path: 'Value', stateValue: 'prod', awsValue: 'a->bucket' }]],
  ];
  for (const [mode, print, changes] of ownArrow) {
    it(
      `${mode}: a value's own -> redirects nothing`,
      () => {
        const text = render(print, report(changes));
        withPasteDir((dir) => {
          expect(spansThatRun(text, dir)).toEqual([]);
        });
        expect(text).toContain('"a->bucket"');
      },
      PASTE_CHILD_TIMEOUT_MS * 20
    );
  }
  for (const [mode, print, changes] of cases) {
    it(
      `${mode}: no span of the plan touches a file`,
      () => {
        const text = render(print, report(changes));
        withPasteDir((dir) => {
          expect(spansThatRun(text, dir)).toEqual([]);
        });
        // After the paste check, so a revert to `->` reds THAT assertion
        // first; this pin proves the value reached the line at all.
        expect(text).toContain('Value: prod → bucket');
      },
      PASTE_CHILD_TIMEOUT_MS * 20
    );
  }

  it(
    '--accept: the SKIPPED row of a masked baseline runs nothing either',
    () => {
      // Review of PR go-to-k/cdkd#4247: the refusal reason printed on this row
      // once spelled its remedy as a backticked `cdkd deploy`, which a pasted
      // clause of the row ran as a command substitution.
      const text = render(
        printAcceptPlan,
        report([{ path: 'Value', stateValue: SECRET_MASK, awsValue: 'bucket' }], ['Value'])
      );
      withPasteDir((dir) => {
        expect(spansThatRun(text, dir)).toEqual([]);
        // `spansThatRun` counts touched files, and a stubbed `cdkd` writes
        // none, so the verb is asked about separately, span by span.
        const ranVerb = [...segmentsOf(text)].filter((span) => spanRun(span, dir, {}).verbRan);
        expect(ranVerb).toEqual([]);
      });
      expect(text).toContain('Value: SKIPPED');
      expect(text).toContain('a deploy that CHANGES this resource');
    },
    PASTE_CHILD_TIMEOUT_MS * 40
  );
});
