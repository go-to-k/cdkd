/**
 * go-to-k/cdkd#4723: an older binary published `Export.Name:
 * {Fn::Sub: 'x-${Short}-y'}` while the `NoEcho` parameter `Short` held `ab`, so
 * state holds the alias `x-ab-y`. The value then ROTATES to `cd`: today's
 * refused name is `x-cd-y`, which the stored key does not equal, and the
 * printing corpus holds only today's value (and only at 4+ characters), so the
 * REMOVE row printed the OLD value by name. While any declared intrinsic
 * `Export.Name` reads a `NoEcho` parameter, every stored alias the template
 * cannot account for is withheld, in the human rows and in `--json`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

import {
  buildDiffTree,
  computeStackDiff,
  diffTreeToJson,
  renderOutputChangeLines,
  type DiffTreeNode,
} from '../../../src/cli/commands/diff-recursive.js';
import { DiffCalculator } from '../../../src/analyzer/diff-calculator.js';
import { computeOutputsDiff, resolveTemplateOutputs } from '../../../src/analyzer/outputs-diff.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import {
  STATE_SCHEMA_VERSION_CURRENT,
  type ResourceState,
  type StackState,
} from '../../../src/types/state.js';
import type { S3StateBackend } from '../../../src/state/s3-state-backend.js';
import { WITHHELD_NAME_DISPLAY } from '../../../src/deployment/outputs-export-alias/warnings.js';

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
    // Rotated: the stored aliases below were published while it held `ab`.
    Parameters: {
      Short: { Type: 'String', NoEcho: options.noEcho ?? true, Default: options.value ?? 'cd' },
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

/** Every rendered surface of the rows: the human lines and the `--json` payload. */
function rendered(outputChanges: DiffTreeNode['outputChanges']): { human: string; json: string } {
  const lines: string[] = [];
  renderOutputChangeLines(outputChanges, (line) => lines.push(line));
  const node: DiffTreeNode = {
    stackName: 'S',
    displayName: 'S',
    region: 'us-east-1',
    changes: new Map(),
    ccApiRoutes: new Map(),
    outputChanges,
    adoptedOrphans: [],
    blocking: [],
    unreadable: [],
    unreadableContainers: [],
    unreadableOrphans: [],
    destructiveChanges: [],
    children: [],
  };
  return { human: lines.join('\n'), json: JSON.stringify(diffTreeToJson(node)) };
}

const rows = (changes: DiffTreeNode['outputChanges']): string[] =>
  changes.map((c) => `${c.changeType} ${c.name}${c.nameDisplay?.kind === 'withheld' ? ' (withheld)' : ''}`);

const SUB_NAME = { 'Fn::Sub': 'x-${Short}-y' };
const EXPORTER = { Out: { Value: 'v', Export: { Name: SUB_NAME } } };

describe('cdkd diff withholds a stored alias spelling a ROTATED NoEcho value (go-to-k/cdkd#4723)', () => {
  it('withholds the REMOVE row of the alias published under the old value, in human and --json output', async () => {
    const result = await diffOf(stateWith({ Out: 'v', 'x-ab-y': 'v' }, ['x-ab-y']), templateOf(EXPORTER));
    expect(rows(result.outputChanges)).toEqual(['REMOVE x-ab-y (withheld)']);
    const { human, json } = rendered(result.outputChanges);
    expect(human).toContain(WITHHELD_NAME_DISPLAY);
    expect(json).toContain('"changeType":"REMOVE"');
    expect(json).toContain('"nameRedacted":true');
    for (const surface of [human, json]) expect(surface).not.toContain('x-ab-y');
  });

  it('prints the alias by name when the parameter is not NoEcho (negative control)', async () => {
    const result = await diffOf(
      stateWith({ Out: 'v', 'x-ab-y': 'v' }, ['x-ab-y']),
      templateOf(EXPORTER, { noEcho: false })
    );
    expect(rows(result.outputChanges).sort()).toEqual(['ADD x-cd-y', 'REMOVE x-ab-y'].sort());
    expect(rendered(result.outputChanges).json).toContain('"name":"x-ab-y"');
  });

  it('withholds an unrelated stale alias too while a name reads NoEcho (stack-wide: state names no owner)', async () => {
    const stored = () =>
      stateWith({ Out: 'v', 'x-ab-y': 'v', 'legacy-export': 'w' }, ['x-ab-y', 'legacy-export']);
    const withNoEcho = await diffOf(stored(), templateOf(EXPORTER));
    expect(rows(withNoEcho.outputChanges).sort()).toEqual(
      ['REMOVE legacy-export (withheld)', 'REMOVE x-ab-y (withheld)'].sort()
    );
    // The same stale alias prints when no declared name reads a NoEcho value.
    const without = await diffOf(stored(), templateOf(EXPORTER, { noEcho: false }));
    expect(rows(without.outputChanges)).toContain('REMOVE legacy-export');
  });

  it('withholds an alphanumeric-only alias (`x${Short}y` published `xaby`)', async () => {
    const result = await diffOf(
      stateWith({ Out: 'v', xaby: 'v' }, ['xaby']),
      templateOf({ Out: { Value: 'v', Export: { Name: { 'Fn::Sub': 'x${Short}y' } } } })
    );
    expect(rows(result.outputChanges)).toEqual(['REMOVE xaby (withheld)']);
  });

  it('withholds every unaccounted key of a record that lists no exportNames (pre-v9)', async () => {
    const result = await diffOf(stateWith({ Out: 'v', 'x-ab-y': 'v' }), templateOf(EXPORTER));
    expect(rows(result.outputChanges)).toEqual(['REMOVE x-ab-y (withheld)']);
  });

  it("prints a deleted output's logical id the record does not list as an alias", async () => {
    const result = await diffOf(
      stateWith({ Out: 'v', 'x-ab-y': 'v', Gone: 'g' }, ['x-ab-y']),
      templateOf(EXPORTER)
    );
    expect(rows(result.outputChanges).sort()).toEqual(
      ['REMOVE Gone', 'REMOVE x-ab-y (withheld)'].sort()
    );
  });

  it('withholds the stored alias of a condition-FALSE exporter whose name reads NoEcho', async () => {
    // Today's own value: the exporter is skipped before the refusal pass, so
    // its name is in no refused set, and `cd` is under the containment floor.
    const result = await diffOf(
      stateWith({ Out: 'v', 'x-cd-y': 'v' }, ['x-cd-y']),
      templateOf(
        { Out: { Condition: 'Off', Value: 'v', Export: { Name: SUB_NAME } } },
        { conditions: { Off: { 'Fn::Equals': ['a', 'b'] } } }
      )
    );
    expect(rows(result.outputChanges).sort()).toEqual(
      ['REMOVE Out', 'REMOVE x-cd-y (withheld)'].sort()
    );
  });

  it('names ADD and MODIFY rows of a pre-v9 record: only an unaccounted key is withheld', async () => {
    const result = await diffOf(
      stateWith({ Out: 'old', 'x-ab-y': 'v' }),
      templateOf({ ...EXPORTER, Added: { Value: 'n' } })
    );
    expect(rows(result.outputChanges).sort()).toEqual(
      ['ADD Added', 'MODIFY Out', 'REMOVE x-ab-y (withheld)'].sort()
    );
  });

  describe('an Fn::If name whose NoEcho branch today\'s verdict drops', () => {
    // Published under a past TRUE verdict; today's verdict selects the literal.
    const ifTemplate = (options: { noEcho?: boolean; value?: string } = {}) =>
      templateOf(
        {
          Out: {
            Value: 'v',
            Export: { Name: { 'Fn::If': ['IsProd', SUB_NAME, 'static-name'] } },
          },
        },
        { ...options, conditions: { IsProd: { 'Fn::Equals': ['dev', 'prod'] } } }
      );
    const stored = () => stateWith({ Out: 'v', 'x-ab-y': 'v' }, ['x-ab-y']);

    it('withholds the alias published under the old value', async () => {
      const result = await diffOf(stored(), ifTemplate());
      expect(rows(result.outputChanges).sort()).toEqual(
        ['ADD static-name', 'REMOVE x-ab-y (withheld)'].sort()
      );
      const { human, json } = rendered(result.outputChanges);
      for (const surface of [human, json]) expect(surface).not.toContain('x-ab-y');
    });

    it('withholds the alias spelling the CURRENT value too', async () => {
      const result = await diffOf(stored(), ifTemplate({ value: 'ab' }));
      expect(rows(result.outputChanges)).toContain('REMOVE x-ab-y (withheld)');
      const { human, json } = rendered(result.outputChanges);
      for (const surface of [human, json]) expect(surface).not.toContain('x-ab-y');
    });

    it('prints the alias when the parameter is not NoEcho (negative control)', async () => {
      const result = await diffOf(stored(), ifTemplate({ noEcho: false }));
      expect(rows(result.outputChanges)).toContain('REMOVE x-ab-y');
    });
  });

  it("withholds in a nested child whose parameter the parent fills from a NoEcho source", async () => {
    const result = await diffOf(
      stateWith({ Out: 'v', 'x-ab-y': 'v' }, ['x-ab-y']),
      templateOf(EXPORTER, { noEcho: false }),
      { inheritedNoEchoParameters: new Set(['Short']) }
    );
    expect(rows(result.outputChanges)).toEqual(['REMOVE x-ab-y (withheld)']);
  });
});

describe('the gate without the diff\'s NoEcho sources (go-to-k/cdkd#4723)', () => {
  const template = templateOf(EXPORTER);
  const passOf = (sources?: { parameters: ReadonlySet<string> }) => ({
    resolveInto: () => async (value: unknown) => value,
    secrets: new Map(),
    ...(sources !== undefined && { noEchoNameSources: sources }),
  });

  it('stays false with no NoEcho sources, so a stale alias prints as before', async () => {
    const resolved = await resolveTemplateOutputs(template, async (value) => value, undefined, undefined, undefined, passOf());
    expect(resolved.exportNameReadsNoEcho).toBe(false);
    // Premise: the same template with the sources turns it on.
    const withSources = await resolveTemplateOutputs(
      template,
      async (value) => value,
      undefined,
      undefined,
      undefined,
      passOf({ parameters: new Set(['Short']) })
    );
    expect(withSources.exportNameReadsNoEcho).toBe(true);
    const changes = computeOutputsDiff({ Out: 'v', 'x-ab-y': 'v' }, { Out: 'v' }, new Set(), new Set(), {
      declaredKeys: resolved.declaredKeys,
      exportNameReadsNoEcho: resolved.exportNameReadsNoEcho,
      storedExportNames: ['x-ab-y'],
    });
    expect(rows(changes)).toEqual(['REMOVE x-ab-y']);
  });
});

describe('a nested child whose parent row feeds the NoEcho value through an Fn::If today drops (go-to-k/cdkd#4723)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cdkd-diff-4723-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const res = (properties: Record<string, unknown>, resourceType = 'AWS::SSM::Parameter'): ResourceState => ({
    physicalId: 'pid',
    resourceType,
    properties,
    attributes: {},
    dependencies: [],
  });

  async function childChanges(parentNoEcho: boolean): Promise<DiffTreeNode['outputChanges']> {
    const childPath = join(dir, 'child.json');
    writeFileSync(
      childPath,
      JSON.stringify({
        Parameters: { Short: { Type: 'String' } },
        Resources: { A: { Type: 'AWS::SSM::Parameter', Properties: { Value: 'x' } } },
        Outputs: EXPORTER,
      })
    );
    // Published while `On` was TRUE and the parent's NoEcho value was `ab`.
    const row = { Short: { 'Fn::If': ['On', { Ref: 'Pw' }, 'lit'] } };
    const states: Record<string, StackState> = {
      Parent: {
        ...stateWith({}),
        stackName: 'Parent',
        resources: { Child: res({ Parameters: { Short: 'ab' } }, 'AWS::CloudFormation::Stack') },
      },
      'Parent~Child': {
        ...stateWith({ Out: 'v', 'x-ab-y': 'v' }, ['x-ab-y']),
        stackName: 'Parent~Child',
      },
    };
    const backend = {
      getState: async (name: string) => (states[name] ? { state: states[name], etag: 'e' } : null),
    } as unknown as S3StateBackend;
    const root = await buildDiffTree({
      stackName: 'Parent',
      displayName: 'Parent',
      region: 'us-east-1',
      template: {
        Parameters: { Pw: { Type: 'String', NoEcho: parentNoEcho, Default: 'cd' } },
        Conditions: { On: { 'Fn::Equals': ['a', 'b'] } },
        Resources: {
          Child: {
            Type: 'AWS::CloudFormation::Stack',
            Metadata: { 'aws:asset:path': 'child.json' },
            Properties: { Parameters: row },
          },
        },
      } as unknown as CloudFormationTemplate,
      nestedTemplates: { Child: childPath },
      recursive: true,
      stateBackend: backend,
      diffCalculator: new DiffCalculator(),
      isNestedChild: false,
    });
    return root.children[0]!.outputChanges;
  }

  it("withholds the child's stale alias, in human and --json output", async () => {
    const changes = await childChanges(true);
    expect(rows(changes)).toContain('REMOVE x-ab-y (withheld)');
    const { human, json } = rendered(changes);
    for (const surface of [human, json]) expect(surface).not.toContain('x-ab-y');
  });

  it('prints it when the parent parameter is not NoEcho (negative control)', async () => {
    expect(rows(await childChanges(false))).toContain('REMOVE x-ab-y');
  });
});

describe('an Export.Name reading a NoEcho custom-resource ATTRIBUTE (go-to-k/cdkd#4723)', () => {
  // Published while the attribute was `ab`; the record now holds `cd`.
  async function changesOf(declaredNoEcho: boolean) {
    const state: StackState = {
      ...stateWith({ Out: 'v', 'x-ab-y': 'v' }, ['x-ab-y']),
      resources: {
        Cr: {
          physicalId: 'cr-pid',
          resourceType: 'Custom::Secret',
          properties: { ServiceToken: 'arn:aws:lambda:us-east-1:123456789012:function:f' },
          attributes: { Secret: 'cd' },
          dependencies: [],
          ...(declaredNoEcho && { noEchoAttributeNames: ['Secret'] }),
        },
      },
    };
    const template = {
      Resources: {
        Cr: {
          Type: 'Custom::Secret',
          Properties: { ServiceToken: 'arn:aws:lambda:us-east-1:123456789012:function:f' },
        },
      },
      Outputs: { Out: { Value: 'v', Export: { Name: { 'Fn::Sub': 'x-${Cr.Secret}-y' } } } },
    } as unknown as CloudFormationTemplate;
    return (await diffOf(state, template)).outputChanges;
  }

  it('withholds the stale alias, in human and --json output', async () => {
    const changes = await changesOf(true);
    expect(rows(changes)).toContain('REMOVE x-ab-y (withheld)');
    const { human, json } = rendered(changes);
    for (const surface of [human, json]) expect(surface).not.toContain('x-ab-y');
  });

  it('prints it when the attribute is not declared NoEcho (negative control)', async () => {
    expect(rows(await changesOf(false))).toContain('REMOVE x-ab-y');
  });
});
