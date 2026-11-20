/**
 * go-to-k/cdkd#6627: the `--revert` plan names each member it removes under an
 * IAM principal key the template does not declare, printed through the plan's
 * own value renderer, before the confirmation prompt.
 */
import { describe, expect, it } from 'vite-plus/test';

import {
  printRevertPlan,
  type DriftOutcome,
  type HumanTextSink,
} from '../../../src/cli/commands/drift.js';

type Report = Parameters<typeof printRevertPlan>[0][number];
type Drifted = Extract<DriftOutcome, { kind: 'drifted' }>;
type Change = Drifted['changes'][number];

function report(properties: Record<string, unknown>, changes: Change[]): Report {
  const outcome: DriftOutcome = {
    kind: 'drifted',
    logicalId: 'Subject',
    resourceType: 'AWS::IAM::Role',
    changes,
    awsProperties: {},
    secrets: new Map() as unknown as Drifted['secrets'],
    maskedPaths: new Set() as unknown as Drifted['maskedPaths'],
    uncertifiedPaths: [],
    secretsIncomplete: false,
    notComparedCause: undefined,
  };
  return {
    stackName: 'Prod',
    region: 'us-east-1',
    state: {
      resources: {
        Subject: {
          physicalId: 'app-role',
          resourceType: 'AWS::IAM::Role',
          properties,
          observedProperties: {},
        },
      },
    } as unknown as Report['state'],
    etag: '',
    migrationPending: false,
    producerRegions: { regions: [], complete: true },
    warnings: [],
    outcomes: [outcome],
  };
}

function render(r: Report): string[] {
  const chunks: string[] = [];
  const out: HumanTextSink = {
    write: (chunk) => {
      chunks.push(chunk);
    },
    stream: process.stdout,
  };
  printRevertPlan([r], out);
  return chunks.join('').split('\n');
}

const ARN = 'arn:aws:iam::aws:policy/AdministratorAccess';
const KEPT = 'arn:aws:iam::123456789012:policy/Kept';

describe('the revert plan lists each undeclared grant member it removes (go-to-k/cdkd#6627)', () => {
  it('one line per removed member, none for a member the baseline records', () => {
    const lines = render(
      report({}, [
        { path: 'ManagedPolicyArns', stateValue: [KEPT], awsValue: [KEPT, ARN] },
        {
          path: 'Policies',
          stateValue: [],
          awsValue: [{ PolicyName: 'oob', PolicyDocument: { Statement: [] } }],
        },
        { path: 'PermissionsBoundary', stateValue: '', awsValue: ARN },
      ])
    );
    expect(lines).toContain(`    - detaches managed policy ${ARN}`);
    expect(lines).toContain('    - deletes inline policy oob');
    expect(lines).toContain(`    - deletes permissions boundary ${ARN}`);
    expect(lines.some((l) => l.includes(`- detaches managed policy ${KEPT}`))).toBe(false);
    expect(lines.join('\n')).toContain(
      "run 'cdkd drift --accept' for this stack instead: it records everything AWS holds on every drifted resource of the stack"
    );
  });

  it('an inline policy both sides name under different documents is a restore, with the pinned-document note', () => {
    const lines = render(
      report({}, [
        {
          path: 'Policies',
          stateValue: [{ PolicyName: 'accepted', PolicyDocument: { a: 1 } }],
          awsValue: [{ PolicyName: 'accepted', PolicyDocument: { a: 2 } }],
        },
      ])
    );
    expect(lines).toContain('    ~ restores inline policy accepted to its recorded document');
    expect(lines.some((l) => l.includes('- deletes inline policy'))).toBe(false);
    expect(lines.join('\n')).toContain('A recorded inline policy document is pinned');
    expect(lines.join('\n')).not.toContain('--accept for this stack');
  });

  it('a list the redaction masked names no member but says its unrecorded members go', () => {
    const lines = render(report({}, [{ path: 'Policies', stateValue: [], awsValue: '***' }]));
    expect(lines).toContain(
      '    - removes each Policies member no record holds (the live list is withheld)'
    );
    expect(lines.some((l) => l.includes('- deletes inline policy'))).toBe(false);
  });

  it('an inline policy without a string name prints whole', () => {
    const lines = render(
      report({}, [{ path: 'Policies', stateValue: [], awsValue: [{ PolicyDocument: {} }] }])
    );
    expect(lines).toContain('    - deletes inline policy {"PolicyDocument":{}}');
  });

  it('a member carrying a control character cannot forge a plan line', () => {
    const lines = render(
      report({}, [
        { path: 'ManagedPolicyArns', stateValue: [], awsValue: ['arn:x\n    - detaches nothing'] },
      ])
    );
    expect(lines.some((l) => l.startsWith('    - detaches nothing'))).toBe(false);
  });

  it('a key the template declares gets no member line (the ordinary change line covers it)', () => {
    const lines = render(
      report({ ManagedPolicyArns: [KEPT] }, [
        { path: 'ManagedPolicyArns', stateValue: [KEPT], awsValue: [KEPT, ARN] },
      ])
    );
    expect(lines.some((l) => l.includes('- detaches managed policy'))).toBe(false);
    expect(lines.join('\n')).not.toContain('--accept');
  });
});
