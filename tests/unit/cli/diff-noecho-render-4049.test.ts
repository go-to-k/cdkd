/**
 * go-to-k/cdkd#4049, the `cdkd diff` rendering row: a property or output
 * served by a `NoEcho: true` parameter printed its value on the human `old:` /
 * `new:` lines, in `--json`'s `propertyChanges` and `outputChanges`, and on
 * `--verbose`'s `requires replacement (<old> -> <new>)` line. CloudFormation's
 * change set prints `****` for it.
 *
 * The cases run end to end through `computeStackDiff` / `buildDiffTree` with
 * the real resolver, since the needles come from the diff's own parameter
 * binding and resolve pass.
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

// The recursive walk warms the create-only `DescribeType` cache; answered
// with a refusal, which that best-effort lookup tolerates.
// A spy on the union masker's construction, to count how often the printing
// corpus is compiled.
vi.mock('../../../src/deployment/secret-redaction.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../src/deployment/secret-redaction.js')>();
  return { ...original, createUnionSecretMasker: vi.fn(original.createUnionSecretMasker) };
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
  maskDiffValue,
  maskOutputChangeForDisplay,
  renderChangeLines,
  renderOutputChangeLines,
  type DiffTreeNode,
} from '../../../src/cli/commands/diff-recursive.js';
import { DiffCalculator } from '../../../src/analyzer/diff-calculator.js';
import {
  recordLogOnlyValue,
  type RecordedSecretValues,
} from '../../../src/deployment/secret-redaction.js';
import * as secretRedaction from '../../../src/deployment/secret-redaction.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { ResourceState, StackState } from '../../../src/types/state.js';
import type { S3StateBackend } from '../../../src/state/s3-state-backend.js';
import { getLogger } from '../../../src/utils/logger.js';

/** Every argument the (mocked) logger was handed, as one string. */
function loggedText(): string {
  const log = getLogger();
  return [log.debug, log.info, log.warn, log.error]
    .flatMap((fn) => vi.mocked(fn).mock.calls.flat())
    .map((arg) => String(arg))
    .join('\n');
}

const NOECHO = 'noecho-plain-7731';
const OLD_NOECHO = 'noecho-rotated-4412';

function res(properties: Record<string, unknown>): ResourceState {
  return {
    physicalId: 'pid',
    resourceType: 'AWS::SSM::Parameter',
    properties,
    attributes: {},
    dependencies: [],
  };
}

function st(
  resources: Record<string, ResourceState>,
  outputs: Record<string, unknown> = {},
  stackName = 'S'
): StackState {
  return { stackName, region: 'us-east-1', resources, outputs, version: 6, lastModified: 0 };
}

/** A backend that serves `states` and records every write it is asked for. */
function backendOf(states: Record<string, StackState> = {}) {
  const writes = { saveState: vi.fn(), putState: vi.fn(), deleteState: vi.fn() };
  const backend = {
    getState: async (stackName: string) => {
      const state = states[stackName];
      return state ? { state, etag: 'e' } : null;
    },
    ...writes,
  } as unknown as S3StateBackend;
  return { backend, writes };
}

function noEchoTemplate(
  properties: Record<string, unknown>,
  outputs?: CloudFormationTemplate['Outputs'],
  parameter: Record<string, unknown> = { Type: 'String', NoEcho: true, Default: NOECHO }
): CloudFormationTemplate {
  return {
    Parameters: { DbUser: parameter },
    Resources: { A: { Type: 'AWS::SSM::Parameter', Properties: properties } },
    ...(outputs && { Outputs: outputs }),
  } as unknown as CloudFormationTemplate;
}

async function diffOf(state: StackState, template: CloudFormationTemplate) {
  const { backend, writes } = backendOf();
  const result = await computeStackDiff(
    state,
    template,
    'us-east-1',
    'S',
    backend,
    new DiffCalculator()
  );
  return { result, writes };
}

function nodeOf(result: Awaited<ReturnType<typeof computeStackDiff>>): DiffTreeNode {
  return {
    stackName: 'S',
    displayName: 'S',
    region: 'us-east-1',
    changes: result.changes,
    ccApiRoutes: new Map(),
    outputChanges: result.outputChanges,
    adoptedOrphans: [],
    blocking: [],
    unreadable: [],
    unreadableContainers: [],
    unreadableOrphans: [],
    destructiveChanges: [],
    children: [],
  };
}

/** Everything the human renderer and `--json` print for one node. */
function printed(node: DiffTreeNode): string {
  const lines: string[] = [];
  renderChangeLines(node.changes, (line) => lines.push(line));
  renderOutputChangeLines(node.outputChanges, (line) => lines.push(line));
  return `${lines.join('\n')}\n${JSON.stringify(diffTreeToJson(node))}`;
}

describe('cdkd diff masks a NoEcho parameter value it prints (#4049)', () => {
  it('masks a rotated value on both sides of a property row, human and --json', async () => {
    const state = st({ A: res({ Value: OLD_NOECHO }) });
    const { result } = await diffOf(state, noEchoTemplate({ Value: { Ref: 'DbUser' } }));

    const change = result.changes.get('A');
    expect(change?.changeType).toBe('UPDATE');
    expect(change?.propertyChanges).toEqual([
      expect.objectContaining({ path: 'Value', oldValue: '***', newValue: '***' }),
    ]);
    const out = printed(nodeOf(result));
    expect(out).not.toContain(NOECHO);
    expect(out).not.toContain(OLD_NOECHO);
    expect(out).toContain('old: "***"');
    expect(out).toContain('new: "***"');
  });

  it('masks the stored value of a property that stopped reading the parameter', async () => {
    // Nothing resolves a `Ref` to the parameter any more, so only the up-front
    // record of every NoEcho value knows it.
    const state = st({ A: res({ Value: NOECHO }) });
    const { result } = await diffOf(state, noEchoTemplate({ Value: 'literal-now' }));

    expect(result.changes.get('A')?.propertyChanges).toEqual([
      expect.objectContaining({ oldValue: '***', newValue: 'literal-now' }),
    ]);
    expect(printed(nodeOf(result))).not.toContain(NOECHO);
  });

  it('masks an embedded value and a Number parameter leaf', async () => {
    const state = st({ A: res({ Value: 'x', Tier: 1 }) });
    const { result } = await diffOf(
      state,
      {
        Parameters: {
          DbUser: { Type: 'String', NoEcho: true, Default: NOECHO },
          Port: { Type: 'Number', NoEcho: true, Default: '31337' },
        },
        Resources: {
          A: {
            Type: 'AWS::SSM::Parameter',
            Properties: {
              Value: { 'Fn::Join': ['', ['user=', { Ref: 'DbUser' }]] },
              Tier: { Ref: 'Port' },
            },
          },
        },
      } as CloudFormationTemplate
    );

    const out = printed(nodeOf(result));
    expect(out).not.toContain(NOECHO);
    expect(out).not.toContain('31337');
    expect(result.changes.get('A')?.propertyChanges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'Value', newValue: 'user=***' }),
        expect.objectContaining({ path: 'Tier', newValue: '***' }),
      ])
    );
  });

  it('masks the encoding the diff resolver records for an Fn::Base64 of the value', async () => {
    // Only the resolver's own bag knows the encoding: it is derived while the
    // diff resolves, and no parameter holds it.
    const encoded = Buffer.from(NOECHO).toString('base64');
    const state = st({ A: res({ Value: 'x' }) });
    const { result } = await diffOf(
      state,
      noEchoTemplate({ Value: { 'Fn::Base64': { Ref: 'DbUser' } } })
    );

    expect(result.changes.get('A')?.propertyChanges).toEqual([
      expect.objectContaining({ oldValue: '***', newValue: '***' }),
    ]);
    expect(printed(nodeOf(result))).not.toContain(encoded);
  });

  it("masks an output's value and withholds its old side, human and --json", async () => {
    const state = st({ A: res({ Value: 'x' }) }, { Out: OLD_NOECHO });
    const { result } = await diffOf(
      state,
      noEchoTemplate({ Value: 'x' }, { Out: { Value: { Ref: 'DbUser' } } })
    );

    expect(result.outputChanges).toEqual([
      { name: 'Out', changeType: 'MODIFY', oldValue: '***', newValue: '***', isExport: false },
    ]);
    const out = printed(nodeOf(result));
    expect(out).not.toContain(NOECHO);
    expect(out).not.toContain(OLD_NOECHO);
  });

  // An intrinsic name, which the template type spells as a string.
  const appExport = {
    Out: {
      Value: 'v',
      Export: { Name: { 'Fn::Join': ['-', ['app', { Ref: 'DbUser' }]] } as unknown as string },
    },
  };

  it('masks an export row NAME built from the value (a stored alias the deploy now drops)', async () => {
    // Published by a binary before go-to-k/cdkd#4043; the next deploy refuses
    // the alias, so the preview shows its REMOVE.
    const state = st({ A: res({ Value: 'x' }) }, { Out: 'v', [`app-${NOECHO}`]: 'v' });
    const { result } = await diffOf(state, noEchoTemplate({ Value: 'x' }, appExport));

    const out = printed(nodeOf(result));
    expect(out).not.toContain(NOECHO);
    // Only the alias moves: the output's own row is unchanged.
    expect(result.outputChanges).toHaveLength(1);
    expect(result.outputChanges[0]!.changeType).toBe('REMOVE');
    expect(result.outputChanges[0]!.nameDisplay).toEqual({ kind: 'masked', text: 'app-***' });
  });

  it('leaves a NoEcho parameter fed a dynamic reference printed as its expression', async () => {
    // `cdkd diff` prints a `{{resolve:...}}` reference as written; a nested
    // input arrives here as one.
    const ref = '{{resolve:secretsmanager:prod/db:SecretString:user}}';
    const { backend } = backendOf();
    const result = await computeStackDiff(
      st({ A: res({ Value: 'old-value-1' }) }),
      noEchoTemplate({ Value: { Ref: 'DbUser' } }, undefined, { Type: 'String', NoEcho: true }),
      'us-east-1',
      'S',
      backend,
      new DiffCalculator(),
      { parameters: { DbUser: ref } }
    );

    expect(result.changes.get('A')?.propertyChanges).toEqual([
      expect.objectContaining({ oldValue: 'old-value-1', newValue: ref }),
    ]);
  });

  it('masks with an inherited bag, for a child whose parameter is not NoEcho', async () => {
    const inherited: RecordedSecretValues = new Map();
    recordLogOnlyValue(inherited, NOECHO);
    const { backend } = backendOf();
    const result = await computeStackDiff(
      st({ A: res({ Value: 'old-value-1' }) }),
      {
        Parameters: { P: { Type: 'String' } },
        Resources: { A: { Type: 'AWS::SSM::Parameter', Properties: { Value: { Ref: 'P' } } } },
      } as CloudFormationTemplate,
      'us-east-1',
      'S',
      backend,
      new DiffCalculator(),
      { parameters: { P: NOECHO }, inheritedSecrets: inherited }
    );

    expect(result.changes.get('A')?.propertyChanges).toEqual([
      expect.objectContaining({ oldValue: '***', newValue: '***' }),
    ]);
  });

  it('hands the calculator a masker for the --verbose replacement line', async () => {
    const calculator = new DiffCalculator();
    const spy = vi.spyOn(calculator, 'calculateDiff');
    const { backend } = backendOf();
    await computeStackDiff(
      st({ A: res({ Value: 'x' }) }),
      noEchoTemplate({ Value: { Ref: 'DbUser' } }),
      'us-east-1',
      'S',
      backend,
      calculator
    );

    const maskForLog = spy.mock.calls[0]?.[6];
    expect(typeof maskForLog).toBe('function');
    expect(maskForLog?.(`requires replacement ("a" -> "${NOECHO}")`)).toBe(
      'requires replacement ("a" -> "***")'
    );
  });

  it('persists nothing, and leaves the state record byte-identical', async () => {
    const state = st({ A: res({ Value: OLD_NOECHO }) }, { Out: OLD_NOECHO });
    const before = JSON.stringify(state);
    const { writes } = await diffOf(
      state,
      noEchoTemplate({ Value: { Ref: 'DbUser' } }, { Out: { Value: { Ref: 'DbUser' } } })
    );

    expect(JSON.stringify(state)).toBe(before);
    expect(writes.saveState).not.toHaveBeenCalled();
    expect(writes.putState).not.toHaveBeenCalled();
    expect(writes.deleteState).not.toHaveBeenCalled();
  });

  it('returns the calculator records themselves when there is no NoEcho parameter', async () => {
    const calculator = new DiffCalculator();
    const spy = vi.spyOn(calculator, 'calculateDiff');
    const { backend } = backendOf();
    const result = await computeStackDiff(
      st({ A: res({ Value: 'old' }) }),
      { Resources: { A: { Type: 'AWS::SSM::Parameter', Properties: { Value: 'new' } } } },
      'us-east-1',
      'S',
      backend,
      calculator
    );

    const raw = await spy.mock.results[0]?.value;
    expect(result.changes.get('A')).toBe(raw.get('A'));
  });
});

describe('review round: arms the first cases left open (#4049)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('masks the BOUND value, not the Default, on a property that stopped reading it', async () => {
    const { backend } = backendOf();
    const result = await computeStackDiff(
      st({ A: res({ Value: 'bound-noecho-2222' }) }),
      noEchoTemplate({ Value: 'literal-now' }, undefined, {
        Type: 'String',
        NoEcho: true,
        Default: 'default-noecho-1111',
      }),
      'us-east-1',
      'S',
      backend,
      new DiffCalculator(),
      { parameters: { DbUser: 'bound-noecho-2222' } }
    );
    expect(printed(nodeOf(result))).not.toContain('bound-noecho-2222');
  });

  it('keeps an ordinary parameter value printed beside a NoEcho one', async () => {
    const { result } = await diffOf(st({ A: res({ Value: 'old-x', Other: 'y' }) }), {
      Parameters: {
        DbUser: { Type: 'String', NoEcho: true, Default: NOECHO },
        Plain: { Type: 'String', Default: 'plain-visible-5555' },
      },
      Resources: {
        A: {
          Type: 'AWS::SSM::Parameter',
          Properties: { Value: { Ref: 'Plain' }, Other: { Ref: 'DbUser' } },
        },
      },
    } as CloudFormationTemplate);
    expect(result.changes.get('A')?.propertyChanges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'Value', oldValue: 'old-x', newValue: 'plain-visible-5555' }),
      ])
    );
  });

  it('gives an ADDED property served by the value no old side', async () => {
    const { result } = await diffOf(
      st({ A: res({ Value: 'x' }) }),
      noEchoTemplate({ Value: 'x', Description: { Ref: 'DbUser' } })
    );
    const added = result.changes.get('A')?.propertyChanges?.find((c) => c.path === 'Description');
    expect(added?.newValue).toBe('***');
    expect(added?.oldValue).toBeUndefined();
  });

  it('masks an encoding recorded AFTER the masker was first used', async () => {
    const calculator = new DiffCalculator();
    const original = calculator.calculateDiff.bind(calculator);
    let maskForLog: ((text: string) => string) | undefined;
    vi.spyOn(calculator, 'calculateDiff').mockImplementation(async (...args) => {
      maskForLog = args[6];
      maskForLog?.('warm before the diff resolves anything');
      return original(...args);
    });
    const { backend } = backendOf();
    await computeStackDiff(
      st({ A: res({ Value: 'x' }) }),
      noEchoTemplate({ Value: { 'Fn::Base64': { Ref: 'DbUser' } } }),
      'us-east-1',
      'S',
      backend,
      calculator
    );
    const encoded = Buffer.from(NOECHO).toString('base64');
    expect(maskForLog?.(`("a" -> "${encoded}")`)).toBe('("a" -> "***")');
  });

  it('compiles the printing corpus once per bag growth, not once per leaf', async () => {
    const many: Record<string, unknown> = {};
    for (let i = 0; i < 50; i++) many[`K${i}`] = `leaf-${i}`;
    const { backend } = backendOf();
    vi.mocked(secretRedaction.createUnionSecretMasker).mockClear();
    const { result } = await (async () => ({
      result: await computeStackDiff(
        st({ A: res({ Value: 'x', Map: { ...many, K0: 'old' } }) }),
        noEchoTemplate({ Value: { Ref: 'DbUser' }, Map: many }),
        'us-east-1',
        'S',
        backend,
        new DiffCalculator()
      ),
    }))();
    expect(result.changes.get('A')?.changeType).toBe('UPDATE');
    expect(vi.mocked(secretRedaction.createUnionSecretMasker).mock.calls.length).toBeLessThanOrEqual(3);
  });

  it('rebuilds the --verbose masker per line, so an encoding recorded during the diff is masked', async () => {
    const calculator = new DiffCalculator();
    const spy = vi.spyOn(calculator, 'calculateDiff');
    const { backend } = backendOf();
    await computeStackDiff(
      st({ A: res({ Value: 'x' }) }),
      noEchoTemplate({ Value: { 'Fn::Base64': { Ref: 'DbUser' } } }),
      'us-east-1',
      'S',
      backend,
      calculator
    );
    const encoded = Buffer.from(NOECHO).toString('base64');
    const maskForLog = spy.mock.calls[0]?.[6] as (text: string) => string;
    expect(maskForLog(`("a" -> "${encoded}")`)).not.toContain(encoded);
  });

  it("masks a child's Fn::Base64 of the parent's value through a non-NoEcho parameter", async () => {
    const inherited: RecordedSecretValues = new Map();
    recordLogOnlyValue(inherited, NOECHO);
    const { backend } = backendOf();
    const result = await computeStackDiff(
      st({ A: res({ Value: 'x' }) }),
      {
        Parameters: { P: { Type: 'String' } },
        Resources: {
          A: { Type: 'AWS::SSM::Parameter', Properties: { Value: { 'Fn::Base64': { Ref: 'P' } } } },
        },
      } as CloudFormationTemplate,
      'us-east-1',
      'S',
      backend,
      new DiffCalculator(),
      { parameters: { P: NOECHO }, inheritedSecrets: inherited }
    );
    expect(printed(nodeOf(result))).not.toContain(Buffer.from(NOECHO).toString('base64'));
  });

  it("masks the child resolver's own debug lines with the parent's value", async () => {
    const inherited: RecordedSecretValues = new Map();
    recordLogOnlyValue(inherited, NOECHO);
    const { backend } = backendOf();
    await computeStackDiff(
      st({ A: res({ Value: 'x' }) }),
      {
        Parameters: { P: { Type: 'String' } },
        Resources: {
          A: {
            Type: 'AWS::SSM::Parameter',
            // `u-`, not `u=`: an assignment-shaped render is DESCRIBED on the
            // line whether or not the mask worked (go-to-k/cdkd#4161).
            Properties: { Value: { 'Fn::Join': ['', ['u-', { Ref: 'P' }]] } },
          },
        },
      } as CloudFormationTemplate,
      'us-east-1',
      'S',
      backend,
      new DiffCalculator(),
      { parameters: { P: NOECHO }, inheritedSecrets: inherited }
    );
    const logged = loggedText();
    // POSITIVE: the line printed the MASKED render, so the negative below
    // cannot pass on a description.
    expect(logged).toContain('Resolved Fn::Join: u-***');
    expect(logged).not.toContain(NOECHO);
  });

  it("masks a root resolver debug line reading a stored copy through Fn::GetAtt", async () => {
    const state = st({
      A: res({ Value: 'x' }),
      B: { ...res({ Value: 'b' }), attributes: { Value: NOECHO } },
    });
    await diffOf(state, {
      Parameters: { DbUser: { Type: 'String', NoEcho: true, Default: NOECHO } },
      Resources: {
        A: { Type: 'AWS::SSM::Parameter', Properties: { Value: { 'Fn::GetAtt': ['B', 'Value'] } } },
        B: { Type: 'AWS::SSM::Parameter', Properties: { Value: 'b' } },
      },
    } as CloudFormationTemplate);
    const logged = loggedText();
    // POSITIVE, on the line itself: `noecho-plain-7731` is shell-inert, so the
    // line prints its render rather than a description, and only the mask can
    // put `***` there. With the log-side masks removed it prints the plaintext
    // and this reds; the whole-token cases below are described either way.
    expect(logged).toContain('Resolved Fn::GetAtt from attributes: B.Value resolved to ***');
    expect(logged).not.toContain(NOECHO);
  });

  it('describes a list-typed NoEcho value of whole tokens on the resolver line (its `{` / `}` are not shell-inert)', async () => {
    const refs = [
      '{{resolve:secretsmanager:prod/a:SecretString:x}}',
      '{{resolve:secretsmanager:prod/b:SecretString:y}}',
    ];
    const { backend } = backendOf();
    await computeStackDiff(
      st({
        A: res({ Value: 'x' }),
        B: { ...res({ Value: 'b' }), attributes: { Value: refs[0] } },
      }),
      {
        Parameters: { DbUsers: { Type: 'CommaDelimitedList', NoEcho: true } },
        Resources: {
          A: {
            Type: 'AWS::SSM::Parameter',
            Properties: { Value: { 'Fn::GetAtt': ['B', 'Value'] } },
          },
          B: { Type: 'AWS::SSM::Parameter', Properties: { Value: 'b' } },
        },
      } as CloudFormationTemplate,
      'us-east-1',
      'S',
      backend,
      new DiffCalculator(),
      { parameters: { DbUsers: refs } }
    );
    // The resolver's own `--verbose` line DESCRIBES the expression, since its
    // `{` / `}` are not shell-inert (go-to-k/cdkd#4161); it prints no plaintext.
    expect(loggedText()).toContain('B.Value resolved to a value that cannot be shown safely here');
  });

  it('masks a NoEcho value that merely CONTAINS a dynamic reference', async () => {
    const framed = 'hunter2secret-{{resolve:ssm:/a}}';
    const { backend } = backendOf();
    const result = await computeStackDiff(
      st({ A: res({ Value: 'old-value-1' }) }),
      noEchoTemplate({ Value: { Ref: 'DbUser' } }, undefined, { Type: 'String', NoEcho: true }),
      'us-east-1',
      'S',
      backend,
      new DiffCalculator(),
      { parameters: { DbUser: framed } }
    );
    expect(printed(nodeOf(result))).not.toContain('hunter2secret');
  });

  it('masks a deleted GRANDchild REMOVE row with the root NoEcho value', async () => {
    const stack = (properties: Record<string, unknown>): ResourceState => ({
      ...res(properties),
      resourceType: 'AWS::CloudFormation::Stack',
    });
    const { backend } = backendOf({
      Parent: st({ Gone: stack({ Parameters: {} }) }, {}, 'Parent'),
      'Parent~Gone': st({ Grand: stack({ Parameters: {} }) }, {}, 'Parent~Gone'),
      'Parent~Gone~Grand': st({}, { Out: NOECHO }, 'Parent~Gone~Grand'),
    });
    const root = await buildDiffTree({
      stackName: 'Parent',
      displayName: 'Parent',
      region: 'us-east-1',
      template: {
        Parameters: { Pw: { Type: 'String', NoEcho: true, Default: NOECHO } },
        Resources: { Keep: { Type: 'AWS::SSM::Parameter', Properties: { Value: 'k' } } },
      } as CloudFormationTemplate,
      nestedTemplates: {},
      recursive: true,
      stateBackend: backend,
      diffCalculator: new DiffCalculator(),
      isNestedChild: false,
    });
    const grand = root.children[0]!.children[0]!;
    expect(grand.outputChanges).toHaveLength(1);
    expect(printed(grand)).not.toContain(NOECHO);
  });

  it('withholds a name computeOutputsDiff masked for another secret when it holds a NoEcho value too', () => {
    const mask = (text: string): string => text.split(NOECHO).join('***');
    const change = {
      name: `x-${NOECHO}-y`,
      changeType: 'REMOVE' as const,
      oldValue: 'v',
      isExport: false,
      nameDisplay: { kind: 'masked' as const, text: `***-${NOECHO}-y` },
    };
    expect(maskOutputChangeForDisplay(change, mask, new Map([[NOECHO, '***']])).nameDisplay).toEqual(
      { kind: 'withheld' }
    );
    // A name the corpus finds nothing in keeps the verdict it was given.
    expect(maskOutputChangeForDisplay(change, mask, new Map()).nameDisplay).toEqual(
      change.nameDisplay
    );
  });

  it("masks the child resolver's condition-evaluation lines with the parent's value", async () => {
    const inherited: RecordedSecretValues = new Map();
    recordLogOnlyValue(inherited, NOECHO);
    const { backend } = backendOf();
    await computeStackDiff(
      st({ A: res({ Value: 'x' }) }),
      {
        Parameters: { P: { Type: 'String' } },
        Conditions: { IsProd: { 'Fn::Equals': [{ Ref: 'P' }, 'prod'] } },
        Resources: {
          A: {
            Type: 'AWS::SSM::Parameter',
            Condition: 'IsProd',
            Properties: { Value: 'x' },
          },
        },
      } as unknown as CloudFormationTemplate,
      'us-east-1',
      'S',
      backend,
      new DiffCalculator(),
      { parameters: { P: NOECHO }, inheritedSecrets: inherited }
    );
    const logged = loggedText();
    expect(logged).toContain('***');
    expect(logged).not.toContain(NOECHO);
  });

  it("describes a whole-token NoEcho value on the resolver's own line (its `{` / `}` are not shell-inert)", async () => {
    const ref = '{{resolve:secretsmanager:prod/db:SecretString:user}}';
    const { backend } = backendOf();
    await computeStackDiff(
      st({
        A: res({ Value: 'x' }),
        B: { ...res({ Value: 'b' }), attributes: { Value: ref } },
      }),
      {
        Parameters: { DbUser: { Type: 'String', NoEcho: true } },
        Resources: {
          A: {
            Type: 'AWS::SSM::Parameter',
            Properties: { Value: { 'Fn::GetAtt': ['B', 'Value'] } },
          },
          B: { Type: 'AWS::SSM::Parameter', Properties: { Value: 'b' } },
        },
      } as CloudFormationTemplate,
      'us-east-1',
      'S',
      backend,
      new DiffCalculator(),
      { parameters: { DbUser: ref } }
    );
    // The resolver's own `--verbose` line DESCRIBES the expression, since its
    // `{` / `}` are not shell-inert (go-to-k/cdkd#4161); it prints no plaintext.
    expect(loggedText()).toContain('B.Value resolved to a value that cannot be shown safely here');
  });

  it('masks a deploy-refusal reason quoting the value', async () => {
    const inherited: RecordedSecretValues = new Map();
    recordLogOnlyValue(inherited, NOECHO);
    const { backend } = backendOf();
    const state: StackState = {
      ...st({ A: res({ Value: 'x' }) }),
      orphans: [
        {
          logicalId: 'Keep',
          orphanedAt: 1,
          state: { physicalId: 'live-keep', resourceType: 'AWS::SQS::Queue', properties: {} },
        },
      ] as unknown as StackState['orphans'],
    };
    const result = await computeStackDiff(
      state,
      noEchoTemplate({ Value: 'x' }),
      'us-east-1',
      'S',
      backend,
      new DiffCalculator(),
      {
        inheritedSecrets: inherited,
        previewOrphanAdoption: async () => ({
          adopted: {},
          refusals: [`orphan Keep: physical id queue-${NOECHO} is gone`],
        }),
      }
    );
    expect(result.blocking).toEqual(['orphan Keep: physical id queue-*** is gone']);
  });

  it('masks a repair reason, and a needle a control character split', async () => {
    const inherited: RecordedSecretValues = new Map();
    recordLogOnlyValue(inherited, NOECHO);
    const { backend } = backendOf();
    const split = `${NOECHO.slice(0, 6)}\u0007${NOECHO.slice(6)}`;
    const state: StackState = {
      ...st({ A: res({ Value: 'x' }) }),
      orphans: [
        {
          logicalId: 'Keep',
          orphanedAt: 1,
          state: { physicalId: 'live-keep', resourceType: 'AWS::SQS::Queue', properties: {} },
        },
        {
          // A kept row the deploy refuses: its reason NAMES the row.
          logicalId: `Keep-${NOECHO}`,
          orphanedAt: 1,
          state: {
            physicalId: 'live-torn',
            resourceType: 'AWS::SQS::Queue',
            properties: {},
            attributes: 'torn',
          },
        },
      ] as unknown as StackState['orphans'],
    };
    const result = await computeStackDiff(
      state,
      noEchoTemplate({ Value: 'x' }),
      'us-east-1',
      'S',
      backend,
      new DiffCalculator(),
      {
        inheritedSecrets: inherited,
        previewOrphanAdoption: async () => ({
          adopted: {},
          refusals: [`orphan Keep: physical id queue-${split} is gone`],
        }),
      }
    );
    expect(result.blocking).toEqual(['orphan Keep: physical id queue-*** is gone']);
    // The repair reason names the adopted record, whose id carries the value.
    expect(JSON.stringify(result.deployRefusals)).toContain('Keep-***');
    expect(JSON.stringify(result.deployRefusals)).not.toContain(NOECHO);
  });
});

describe('maskDiffValue', () => {
  const mask = (text: string): string => text.split(NOECHO).join('***');

  it('returns the value itself when nothing is masked', () => {
    const value = { a: ['x', 1, true, null], b: { c: 'y' } };
    expect(maskDiffValue(value, mask)).toBe(value);
  });

  it('masks keys and leaves without mutating the input', () => {
    const value = { [NOECHO]: 'k', list: [`p-${NOECHO}`], n: 5 };
    const before = JSON.stringify(value);
    expect(JSON.stringify(maskDiffValue(value, mask))).toBe(
      JSON.stringify({ '***': 'k', list: ['p-***'], n: 5 })
    );
    expect(JSON.stringify(value)).toBe(before);
  });

  it('masks a needle below the depth cap whole rather than printing it', () => {
    let deep: unknown = NOECHO;
    for (let i = 0; i < 40; i++) deep = { k: deep };
    expect(JSON.stringify(maskDiffValue(deep, mask))).not.toContain(NOECHO);
  });

  it('finds a needle holding a quote or backslash below the depth cap', () => {
    const needle = 'pa"ss\\word99';
    const quoteMask = (text: string): string => text.split(needle).join('***');
    let deep: unknown = `x-${needle}`;
    for (let i = 0; i < 40; i++) deep = { k: deep };
    expect(maskDiffValue(deep, quoteMask)).not.toBe(deep);
  });

  it.each([
    ['a KEY', { [NOECHO]: 'v' }, mask],
    ['an ARRAY element', [NOECHO], mask],
    ['a NUMBER leaf', 31337, (text: string): string => (text === '31337' ? '***' : text)],
  ])('finds a needle in %s below the depth cap', (_where, innermost, leafMask) => {
    let deep: unknown = innermost;
    for (let i = 0; i < 40; i++) deep = { k: deep };
    expect(maskDiffValue(deep, leafMask)).not.toBe(deep);
  });

  it('walks a shared subtree below the depth cap once, not once per path', () => {
    // 16 levels of `{a: x, b: x}` have 65536 paths and 17 distinct objects.
    let dag: unknown = 'plain';
    for (let i = 0; i < 16; i++) dag = { a: dag, b: dag };
    let deep: unknown = dag;
    for (let i = 0; i < 33; i++) deep = { k: deep };
    let calls = 0;
    const counting = (text: string): string => {
      calls++;
      return mask(text);
    };
    expect(maskDiffValue(deep, counting)).toBe(deep);
    expect(calls).toBeLessThan(500);
  });

  it('keeps a needle-free subtree below the depth cap as it is', () => {
    let deep: unknown = 'plain';
    for (let i = 0; i < 40; i++) deep = { k: deep };
    expect(maskDiffValue(deep, mask)).toBe(deep);
  });

  it('withholds an object whose masked keys collide rather than dropping a row', () => {
    const both = { [`a-${NOECHO}`]: 1, [`a-${NOECHO}${NOECHO}`]: 2 };
    const collide = (text: string): string => text.replace(new RegExp(`(${NOECHO})+`, 'g'), '***');
    expect(maskDiffValue(both, collide)).toBe('***');
  });

  it('masks a boolean leaf whose printed form is a needle', () => {
    expect(maskDiffValue(true, (text) => (text === 'true' ? '***' : text))).toBe('***');
  });
});

describe('cdkd diff --recursive masks a parent NoEcho value in the child (#4049)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cdkd-diff-noecho-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('masks the value the child reads through a parameter it does not declare NoEcho', async () => {
    const childPath = join(dir, 'child.json');
    writeFileSync(
      childPath,
      JSON.stringify({
        Parameters: { referencetoParentPw: { Type: 'String' } },
        Resources: {
          ChildRes: {
            Type: 'AWS::SSM::Parameter',
            Properties: { Value: { Ref: 'referencetoParentPw' } },
          },
        },
      })
    );
    const nestedRow = (value: unknown): ResourceState => ({
      ...res({ Parameters: { referencetoParentPw: value } }),
      resourceType: 'AWS::CloudFormation::Stack',
    });
    const { backend } = backendOf({
      Parent: st({ Child: nestedRow('old-value-1') }, {}, 'Parent'),
      'Parent~Child': st({ ChildRes: res({ Value: 'old-value-1' }) }, {}, 'Parent~Child'),
    });

    const root = await buildDiffTree({
      stackName: 'Parent',
      displayName: 'Parent',
      region: 'us-east-1',
      template: {
        Parameters: { Pw: { Type: 'String', NoEcho: true, Default: NOECHO } },
        Resources: {
          Child: {
            Type: 'AWS::CloudFormation::Stack',
            Metadata: { 'aws:asset:path': 'child.json' },
            Properties: { Parameters: { referencetoParentPw: { Ref: 'Pw' } } },
          },
        },
      } as CloudFormationTemplate,
      nestedTemplates: { Child: childPath },
      recursive: true,
      stateBackend: backend,
      diffCalculator: new DiffCalculator(),
      // A caller-supplied value; the Default-bound twin of this case is in
      // diff-recursive-child-params-4094.test.ts (go-to-k/cdkd#4094).
      parameters: { Pw: NOECHO },
      isNestedChild: false,
    });

    const child = root.children[0]!;
    expect(child.changes.get('ChildRes')?.propertyChanges).toEqual([
      expect.objectContaining({ path: 'Value', oldValue: '***', newValue: '***' }),
    ]);
    expect(root.changes.get('Child')?.propertyChanges).toEqual([
      expect.objectContaining({ newValue: { referencetoParentPw: '***' } }),
    ]);
    expect(printed(root)).not.toContain(NOECHO);
    expect(printed(child)).not.toContain(NOECHO);
  });

  it('masks a deleted child REMOVE row with the parent NoEcho value', async () => {
    const { backend } = backendOf({
      Parent: st(
        {
          Gone: {
            ...res({ Parameters: {} }),
            resourceType: 'AWS::CloudFormation::Stack',
          },
        },
        {},
        'Parent'
      ),
      'Parent~Gone': st({}, { Out: NOECHO }, 'Parent~Gone'),
    });

    const root = await buildDiffTree({
      stackName: 'Parent',
      displayName: 'Parent',
      region: 'us-east-1',
      template: {
        Parameters: { Pw: { Type: 'String', NoEcho: true, Default: NOECHO } },
        Resources: { Keep: { Type: 'AWS::SSM::Parameter', Properties: { Value: 'k' } } },
      } as CloudFormationTemplate,
      nestedTemplates: {},
      recursive: true,
      stateBackend: backend,
      diffCalculator: new DiffCalculator(),
      isNestedChild: false,
    });

    const gone = root.children[0]!;
    expect(gone.outputChanges).toEqual([
      expect.objectContaining({ name: 'Out', changeType: 'REMOVE', oldValue: '***' }),
    ]);
    expect(printed(gone)).not.toContain(NOECHO);
  });

  function writeChild(name: string): string {
    const childPath = join(dir, name);
    writeFileSync(
      childPath,
      JSON.stringify({
        Parameters: { In: { Type: 'String' } },
        Resources: {
          ChildRes: { Type: 'AWS::SSM::Parameter', Properties: { Value: { Ref: 'In' } } },
        },
      })
    );
    return childPath;
  }

  async function diffParentFeeding(
    childInput: unknown,
    parentResources: Record<string, ResourceState> = {}
  ): Promise<void> {
    const nested = (value: unknown): ResourceState => ({
      ...res({ Parameters: { In: value } }),
      resourceType: 'AWS::CloudFormation::Stack',
    });
    const { backend } = backendOf({
      Parent: st({ Child: nested('old-in'), ...parentResources }, {}, 'Parent'),
      'Parent~Child': st({ ChildRes: res({ Value: 'old-in' }) }, {}, 'Parent~Child'),
    });
    await buildDiffTree({
      stackName: 'Parent',
      displayName: 'Parent',
      region: 'us-east-1',
      template: {
        Parameters: { Pw: { Type: 'String', NoEcho: true, Default: NOECHO } },
        Resources: {
          Child: {
            Type: 'AWS::CloudFormation::Stack',
            Metadata: { 'aws:asset:path': 'child.json' },
            Properties: { Parameters: { In: childInput } },
          },
          ...Object.fromEntries(
            Object.keys(parentResources).map((id) => [
              id,
              { Type: 'AWS::SQS::Queue', Properties: {} },
            ])
          ),
        },
      } as CloudFormationTemplate,
      nestedTemplates: { Child: writeChild('child.json') },
      recursive: true,
      stateBackend: backend,
      diffCalculator: new DiffCalculator(),
      parameters: { Pw: NOECHO },
      isNestedChild: false,
    });
  }

  it("masks the child-parameter resolver's Fn::Sub line over the parent's value", async () => {
    vi.clearAllMocks();
    await diffParentFeeding({ 'Fn::Sub': 'user-${Pw}' });
    const logged = loggedText();
    expect(logged).toContain('user-***');
    expect(logged).not.toContain(NOECHO);
  });

  it("masks the child-parameter resolver's Ref line over a physical id embedding the value", async () => {
    vi.clearAllMocks();
    await diffParentFeeding(
      { Ref: 'Q' },
      { Q: { ...res({}), resourceType: 'AWS::SQS::Queue', physicalId: `queue-${NOECHO}` } }
    );
    const logged = loggedText();
    expect(logged).toContain('queue-***');
    expect(logged).not.toContain(NOECHO);
  });
});
