/**
 * go-to-k/cdkd#6696: `cdkd drift` never reports "no drift" for something it
 * could not compare.
 *
 *   - `unsupported` (drift unknown: no provider can read the type) exits 2,
 *     like the other incomplete causes; drift (1) still outranks it.
 *   - `skipped` and the `unresolvedToken` / `noEchoParameter` causes keep
 *     exit 0.
 *   - The human report prints no `✓ ... no drift detected` over a drift-unknown
 *     resource, and a ✓ over a stack holding custom resources says it left
 *     them out (#323 still keeps them off the per-resource listing).
 *
 * The full-command cases (exit codes through `driftCommand`) live in
 * `drift.test.ts` and `drift-per-resource-failure.test.ts`; this file pins the
 * two pure seams those cases reach.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test';

import { writeHumanReport, type DriftOutcome } from '../../../src/cli/commands/drift.js';
import {
  incompleteRemediationMessage,
  outcomeExitSignal,
} from '../../../src/cli/commands/drift/outcome.js';

type Report = Parameters<typeof writeHumanReport>[0][number];

function report(outcomes: DriftOutcome[]): Report {
  return {
    stackName: 'Prod',
    region: 'us-east-1',
    state: {} as Report['state'],
    etag: '',
    migrationPending: false,
    producerRegions: { regions: [], complete: true },
    warnings: [],
    outcomes,
  };
}

const clean = (logicalId = 'Bucket'): DriftOutcome => ({
  kind: 'clean',
  logicalId,
  resourceType: 'AWS::S3::Bucket',
});
const unsupported = (logicalId = 'Record'): DriftOutcome => ({
  kind: 'unsupported',
  logicalId,
  resourceType: 'AWS::Route53::RecordSet',
});
const customSkip = (logicalId = 'AutoDelete'): DriftOutcome => ({
  kind: 'skipped',
  logicalId,
  resourceType: 'Custom::S3AutoDeleteObjects',
});
const nestedSkip = (logicalId = 'Child'): DriftOutcome => ({
  kind: 'skipped',
  logicalId,
  resourceType: 'AWS::CloudFormation::Stack',
});
const notCompared = (
  cause: Extract<DriftOutcome, { kind: 'notCompared' }>['notComparedCause']
): DriftOutcome => ({
  kind: 'notCompared',
  logicalId: 'Fn',
  resourceType: 'AWS::Lambda::Function',
  notComparedCause: cause,
});

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

/** The stack's summary line: the first line the report writes. */
function summaryLine(outcomes: DriftOutcome[]): string {
  writeHumanReport([report(outcomes)]);
  return chunks.join('').split('\n')[0] ?? '';
}

describe('outcomeExitSignal (go-to-k/cdkd#6696)', () => {
  it('routes a drift-unknown resource to the incomplete side (exit 2)', () => {
    expect(outcomeExitSignal(unsupported())).toBe('incomplete');
  });

  it.each([
    ['a custom resource', customSkip()],
    ['a nested row its own block compares', nestedSkip()],
    ['an unresolvable token', notCompared('unresolvedToken')],
    ['a NoEcho parameter mask', notCompared('noEchoParameter')],
    ['a compared, matching resource', clean()],
  ])('keeps %s at none (exit 0)', (_label, outcome) => {
    expect(outcomeExitSignal(outcome)).toBe('none');
  });
});

describe('the summary line never claims more than was compared (go-to-k/cdkd#6696)', () => {
  it('a fully compared stack keeps its ✓ line byte for byte', () => {
    expect(summaryLine([clean('A'), clean('B')])).toBe(
      '✓ Prod (us-east-1): no drift detected (2 resources checked, 0 unsupported)'
    );
  });

  it('a drift-unknown resource turns the ✓ into a ⚠ that names it', () => {
    const line = summaryLine([clean(), unsupported()]);
    expect(line).toBe(
      '⚠ Prod (us-east-1): no drift detected in 1 resource checked, but 1 resource could not ' +
        'be compared (1 unsupported, drift unknown)'
    );
    // The `?` row below still lists it.
    expect(chunks.join('')).toContain('? Record (AWS::Route53::RecordSet)');
  });

  it('plural counts read correctly', () => {
    expect(summaryLine([clean('A'), clean('B'), unsupported('R1'), unsupported('R2')])).toBe(
      '⚠ Prod (us-east-1): no drift detected in 2 resources checked, but 2 resources could not ' +
        'be compared (2 unsupported, drift unknown)'
    );
  });

  it('a custom resource keeps the ✓ but the line says it was left out, with no per-resource row', () => {
    expect(summaryLine([clean(), customSkip()])).toBe(
      '✓ Prod (us-east-1): no drift detected (1 resource checked, 0 unsupported) — excludes 1 ' +
        'custom resource, which cdkd does not drift-check'
    );
    // #323: no line names the custom resource itself.
    expect(chunks.join('')).not.toContain('AutoDelete');
  });

  it('pluralizes the custom-resource clause', () => {
    expect(summaryLine([clean(), customSkip('A'), customSkip('B')])).toContain(
      ' — excludes 2 custom resources, which cdkd does not drift-check'
    );
  });

  it('a nested row its own block compares is not counted as an excluded custom resource', () => {
    expect(summaryLine([clean(), nestedSkip()])).toBe(
      '✓ Prod (us-east-1): no drift detected (1 resource checked, 0 unsupported)'
    );
  });

  it('a drift-unknown line also names the custom resources it left out', () => {
    expect(summaryLine([clean(), unsupported(), customSkip()])).toBe(
      '⚠ Prod (us-east-1): no drift detected in 1 resource checked, but 1 resource could not ' +
        'be compared (1 unsupported, drift unknown) — excludes 1 custom resource, which cdkd ' +
        'does not drift-check'
    );
  });

  it.each(['unresolvedToken', 'noEchoParameter'] as const)(
    'an exit-0 %s cause gets no ✓, and the line names the custom resources too',
    (cause) => {
      const line = summaryLine([clean(), notCompared(cause), customSkip()]);
      expect(line.startsWith('⚠ Prod (us-east-1): no drift detected, but 1 of 2 ')).toBe(true);
      expect(line.endsWith(
        '0 unsupported — excludes 1 custom resource, which cdkd does not drift-check'
      )).toBe(true);
    }
  );

  it('drift on the same stack outranks drift unknown in the heading', () => {
    writeHumanReport([
      report([
        {
          kind: 'deleted',
          logicalId: 'Gone',
          resourceType: 'AWS::SQS::Queue',
        },
        unsupported(),
      ]),
    ]);
    const out = chunks.join('');
    expect(out).toContain('⚠ Prod (us-east-1): drift detected on 1 resource');
    expect(out).not.toContain('no drift detected');
  });
});

describe('the remediation line counts what was really uncompared (go-to-k/cdkd#6696)', () => {
  it('counts a drift-unknown resource as uncertain, and a nested row its block compares not at all', () => {
    const lines = incompleteRemediationMessage(
      [report([clean(), unsupported(), nestedSkip(), customSkip()])],
      'accept'
    );
    expect(lines[0]).toBe(
      'Comparison INCOMPLETE — nothing to accept, and that is NOT a clean bill of health: ' +
        '2 of 4 resource(s) could not be compared.'
    );
    expect(lines).toContain(
      'cdkd does not know whether these drifted — ' +
        '1 not compared AT ALL: their provider does not support drift detection yet.'
    );
    // The custom resource only: the nested row is not "a type cdkd does not
    // drift-check".
    expect(lines).toContain(
      'Not drift-checked by cdkd at all, which is a coverage limit rather than uncertainty — ' +
        '1 not compared AT ALL: cdkd does not drift-check the type.'
    );
  });
});
