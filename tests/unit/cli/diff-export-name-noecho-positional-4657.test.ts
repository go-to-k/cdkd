/**
 * go-to-k/cdkd#4657, the PREVIEW half of two deploy refusals, through
 * `computeStackDiff` with the real resolver:
 *
 * - The POSITIONAL twin: an `Export.Name` intrinsic READING a `NoEcho`
 *   parameter is refused at any value length, so a name embedding a 1-3
 *   character value previews no ADD (the deploy's
 *   `export-name-noecho-refusal-4043.test.ts` pins the deploy side).
 * - The no-change merge's carried-alias verdict: a failed output's stored
 *   literal alias the verdict refuses is not carried, so the preview shows
 *   it leaving (`no-change-carried-alias-noecho-4657.test.ts` pins the deploy).
 */

import { describe, expect, it, vi } from 'vite-plus/test';

vi.mock('../../../src/utils/logger.js', () => {
  const fns = {
    setLevel: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => fns,
  };
  return { getLogger: () => fns };
});
vi.mock('@aws-sdk/client-cloudformation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-cloudformation')>();
  return {
    ...actual,
    CloudFormationClient: vi.fn().mockImplementation(() => ({
      send: async () => {
        throw Object.assign(new Error('not in this test'), { name: 'TypeNotFoundException' });
      },
    })),
  };
});

import { computeStackDiff, renderOutputChangeLines } from '../../../src/cli/commands/diff-recursive.js';
import { DiffCalculator } from '../../../src/analyzer/diff-calculator.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import { STATE_SCHEMA_VERSION_CURRENT, type StackState } from '../../../src/types/state.js';
import type { S3StateBackend } from '../../../src/state/s3-state-backend.js';

function stateWith(outputs: Record<string, unknown>, exportNames?: string[]): StackState {
  return {
    stackName: 'S',
    region: 'us-east-1',
    resources: {
      A: {
        physicalId: 'pid',
        resourceType: 'AWS::SSM::Parameter',
        properties: { Value: 'x' },
        attributes: {},
        dependencies: [],
      },
    },
    outputs,
    ...(exportNames !== undefined && { exportNames }),
    version: STATE_SCHEMA_VERSION_CURRENT,
    lastModified: 0,
  };
}

function templateOf(
  outputs: Record<string, unknown>,
  options: { noEcho?: boolean; value?: string; conditions?: Record<string, unknown> } = {}
): CloudFormationTemplate {
  return {
    Parameters: {
      Short: { Type: 'String', NoEcho: options.noEcho ?? true, Default: options.value ?? 'ab' },
    },
    ...(options.conditions !== undefined && { Conditions: options.conditions }),
    Resources: { A: { Type: 'AWS::SSM::Parameter', Properties: { Value: 'x' } } },
    Outputs: outputs,
  } as unknown as CloudFormationTemplate;
}

async function diffOf(
  state: StackState,
  template: CloudFormationTemplate,
  options: Record<string, unknown> = {}
) {
  const backend = { getState: async () => null } as unknown as S3StateBackend;
  return computeStackDiff(state, template, 'us-east-1', 'S', backend, new DiffCalculator(), options);
}

async function outputChangesOf(
  state: StackState,
  template: CloudFormationTemplate,
  options: Record<string, unknown> = {}
): Promise<string[]> {
  const result = await diffOf(state, template, options);
  return result.outputChanges.map((c) => `${c.changeType} ${c.name}`);
}

const INNOCENT = { Innocent: { Value: 'w', Export: { Name: 'plain-export' } } };
const STORED = { Out: 'v', Innocent: 'w' };

describe('cdkd diff previews the positional NoEcho export-name refusal (go-to-k/cdkd#4657)', () => {
  const shapes: Array<[string, unknown]> = [
    ['an Fn::Sub', { 'Fn::Sub': 'x-${Short}-y' }],
    ['an Fn::Join', { 'Fn::Join': ['-', ['x', { Ref: 'Short' }, 'y']] }],
    [
      'an Fn::Select over a list holding the Ref',
      { 'Fn::Join': ['', ['x-', { 'Fn::Select': [0, [{ Ref: 'Short' }, 'b']] }, '-y']] },
    ],
    ['an Fn::Sub variable bound to the Ref', { 'Fn::Sub': ['x-${V}-y', { V: { Ref: 'Short' } }] }],
  ];

  for (const [label, name] of shapes) {
    it(`previews no ADD for ${label} embedding a 2-character NoEcho value`, async () => {
      const template = templateOf({ Out: { Value: 'v', Export: { Name: name } }, ...INNOCENT });
      expect(await outputChangesOf(stateWith(STORED), template)).toEqual(['ADD plain-export']);
    });

    it(`previews the ADD for ${label} when the parameter is not NoEcho (negative control)`, async () => {
      const template = templateOf(
        { Out: { Value: 'v', Export: { Name: name } }, ...INNOCENT },
        { noEcho: false }
      );
      expect((await outputChangesOf(stateWith(STORED), template)).sort()).toEqual(
        ['ADD plain-export', 'ADD x-ab-y'].sort()
      );
    });
  }

  it('reads only the Fn::If branch a known condition selected', async () => {
    const ifName = { 'Fn::If': ['UseSecret', { 'Fn::Sub': 'x-${Short}-y' }, 'public-name'] };
    const off = templateOf(
      { Out: { Value: 'v', Export: { Name: ifName } } },
      { conditions: { UseSecret: { 'Fn::Equals': ['a', 'b'] } } }
    );
    expect(await outputChangesOf(stateWith({ Out: 'v' }), off)).toEqual(['ADD public-name']);
    const on = templateOf(
      { Out: { Value: 'v', Export: { Name: ifName } }, ...INNOCENT },
      { conditions: { UseSecret: { 'Fn::Equals': ['a', 'a'] } } }
    );
    // The innocent sibling proves the outputs pass ran.
    expect(await outputChangesOf(stateWith(STORED), on)).toEqual(['ADD plain-export']);
  });

  it('reads BOTH branches of an Fn::If whose condition the diff cannot evaluate (fail-closed)', async () => {
    // `UseSecret` reads `Unbound`, a parameter with no value, so the diff has
    // no verdict; its resolver takes the FALSE branch (`public-name`), while
    // the deploy may take the NoEcho one. The preview must not show it added.
    const template = templateOf(
      {
        Out: {
          Value: 'v',
          Export: {
            Name: { 'Fn::If': ['UseSecret', { 'Fn::Sub': 'x-${Short}-y' }, 'public-name'] },
          },
        },
      },
      { conditions: { UseSecret: { 'Fn::Equals': [{ Ref: 'Unbound' }, 'yes'] } } }
    );
    (template.Parameters as Record<string, unknown>)['Unbound'] = { Type: 'String' };
    const changes = await outputChangesOf(stateWith({ Out: 'v' }), template);
    expect(changes).not.toContain('ADD public-name');
    // Premise: with a known FALSE verdict the same template previews the add.
    (template.Conditions as Record<string, unknown>)['UseSecret'] = { 'Fn::Equals': ['a', 'b'] };
    expect(await outputChangesOf(stateWith({ Out: 'v' }), template)).toEqual(['ADD public-name']);
  });

  it('leaves a LITERAL name to the containment arms, as the deploy does', async () => {
    const template = templateOf({ Out: { Value: 'v', Export: { Name: 'x-ab-y' } } });
    expect(await outputChangesOf(stateWith({ Out: 'v' }), template)).toEqual(['ADD x-ab-y']);
  });

  it("refuses a nested child's name reading a parameter its parent fills from a NoEcho source", async () => {
    const template = templateOf(
      { Out: { Value: 'v', Export: { Name: { 'Fn::Sub': 'x-${Short}-y' } } }, ...INNOCENT },
      { noEcho: false }
    );
    expect(
      await outputChangesOf(stateWith(STORED), template, {
        inheritedNoEchoParameters: new Set(['Short']),
      })
    ).toEqual(['ADD plain-export']);
  });
});

describe('cdkd diff previews the carried-alias verdict of the no-change merge (go-to-k/cdkd#4657)', () => {
  const NOECHO = 'hunter2CarriedAlias';
  const LEAKY = `exp-${NOECHO}`;
  const FAILS = { 'Fn::GetAtt': ['Missing', 'Arn'] };
  const outputs = {
    Leaky: { Value: FAILS, Export: { Name: LEAKY } },
    Plain: { Value: FAILS, Export: { Name: 'plain-carried' } },
  };
  const stored = () =>
    stateWith({ Leaky: 'v', [LEAKY]: 'v', Plain: 'p', 'plain-carried': 'p' }, [
      LEAKY,
      'plain-carried',
    ]);

  it('previews the refused carried alias leaving, and carries the innocent one', async () => {
    const template = templateOf(outputs, { value: NOECHO });
    const result = await diffOf(stored(), template);
    expect(result.outputChanges.map((c) => `${c.changeType} ${c.name}`)).toEqual([`REMOVE ${LEAKY}`]);
    // The row's DISPLAY never prints the value its name holds.
    const shown = result.outputChanges[0]!.nameDisplay;
    expect(shown).toBeDefined();
    expect(JSON.stringify(shown)).not.toContain(NOECHO);
  });

  it('carries both when the parameter is not NoEcho (negative control)', async () => {
    const template = templateOf(outputs, { value: NOECHO, noEcho: false });
    expect(await outputChangesOf(stored(), template)).toEqual([]);
  });
});

describe('cdkd diff withholds a stored alias a NoEcho-refused name published (go-to-k/cdkd#4657 review)', () => {
  // An older binary published `x-ab-y` from `Fn::Sub: x-${Short}-y`, `Short`
  // a 2-character NoEcho value. Today the name is refused, so the stored key
  // previews as a REMOVE; its name holds the value under the containment
  // floor, so only the refused-name set can withhold it.
  const stored = () => stateWith({ Out: 'v', 'x-ab-y': 'v' }, ['x-ab-y']);
  const outputs = { Out: { Value: 'v', Export: { Name: { 'Fn::Sub': 'x-${Short}-y' } } } };

  it('withholds the REMOVE row of the refused alias, and renders no copy of the value', async () => {
    const result = await diffOf(stored(), templateOf(outputs));
    expect(result.outputChanges.map((c) => `${c.changeType} ${c.name}`)).toEqual(['REMOVE x-ab-y']);
    expect(result.outputChanges[0]!.nameDisplay).toEqual({ kind: 'withheld' });
    const lines: string[] = [];
    renderOutputChangeLines(result.outputChanges, (line) => lines.push(line));
    expect(lines.join('\n')).toContain('-');
    expect(lines.join('\n')).not.toContain('x-ab-y');
  });

  it('keeps the alias, with no row, when the parameter is not NoEcho (negative control)', async () => {
    const result = await diffOf(stored(), templateOf(outputs, { noEcho: false }));
    expect(result.outputChanges).toEqual([]);
  });
});
