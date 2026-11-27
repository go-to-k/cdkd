/**
 * go-to-k/cdkd#7097: a nested-stack row record written before cdkd masked a
 * secret-derived child output holds that output's PLAINTEXT. A deploy over it
 * persisted the plaintext into the parent's outputs and exports. The record
 * now reads as a current one does: each output the child template derives
 * from a parameter the row passes mixed with a dynamic reference reads `***`,
 * and nothing else changes. When the child template cannot be read, the deploy
 * is refused, naming the row and the output, never the value.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vite-plus/test';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { StackState } from '../../../src/types/state.js';
import { STATE_SCHEMA_VERSION_CURRENT } from '../../../src/types/state.js';

const logged = vi.hoisted(() => ({ lines: [] as string[] }));
vi.mock('../../../src/utils/logger.js', () => {
  const push = (message: string) => {
    logged.lines.push(String(message));
  };
  const fns = { setLevel: vi.fn(), debug: vi.fn(push), info: vi.fn(push), warn: vi.fn(push), error: vi.fn(push), child: () => fns };
  return { getLogger: () => fns };
});
const renderer = {
  start: vi.fn(),
  stop: vi.fn(),
  addTask: vi.fn(),
  removeTask: vi.fn(),
  updateTaskLabel: vi.fn(),
  printAbove: (write: () => void) => write(),
};
vi.mock('../../../src/utils/live-renderer.js', () => ({ getLiveRenderer: () => renderer }));
vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    cloudFormation: {
      send: vi.fn(() =>
        Promise.reject(Object.assign(new Error('not authorized: cloudformation:DescribeType'), { name: 'AccessDeniedException' }))
      ),
    },
    sts: { send: vi.fn().mockResolvedValue({ Account: '123456789012' }) },
    ssm: {
      send: vi.fn(async () => ({ Parameter: { Type: 'SecureString', Value: 'b1g-s3cret-7097' } })),
    },
  }),
}));
vi.mock('p-limit', () => ({ default: vi.fn(() => <T>(fn: () => T) => fn()) }));

const { maskLegacyTaintedRowOutputs } = await import('../../../src/deployment/legacy-row-output-mask.js');
const { childTemplateLoader } = await import('../../../src/deployment/nested-output-templates.js');
const { DeployEngine } = await import('../../../src/deployment/deploy-engine.js');
const { DiffCalculator } = await import('../../../src/analyzer/diff-calculator.js');
const { DagBuilder } = await import('../../../src/analyzer/dag-builder.js');
const { withNestedStackContext } = await import('../../../src/provisioning/nested-stack-context.js');
const { findAffectedExports } = await import('../../../src/deployment/export-change-guard.js');

const PIN = 'q7';
const A = '{{resolve:ssm-secure:/app/a}}';
const STACK = 'prod-7097';
const REGION = 'us-east-1';
const CHILD_ARN = `arn:cdkd-local:${REGION}:123456789012:nested-stack/${STACK}/Row`;

const CHILD = {
  Parameters: { X: { Type: 'String' } },
  Resources: {},
  Outputs: {
    // Derived from the mixed parameter: a current record holds `***`.
    Piece: { Value: { 'Fn::Select': [0, { 'Fn::Split': ['/', { Ref: 'X' }] }] } },
    // Reads nothing the row passes mixed: its value is no secret's.
    Plain: { Value: 'plain-7097' },
  },
};

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'cdkd-7097-'));
  writeFileSync(join(dir, 'child.json'), JSON.stringify(CHILD));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const ROW_PROPERTIES = {
  TemplateURL: 'https://s3.amazonaws.com/assets/child.json',
  Parameters: { X: { 'Fn::Join': ['', [{ Ref: 'Sep' }, '/', A]] } },
};

function parentTemplate(): CloudFormationTemplate {
  return {
    Parameters: { Sep: { Type: 'String', Default: PIN } },
    Resources: {
      Row: {
        Type: 'AWS::CloudFormation::Stack',
        Metadata: { 'aws:asset:path': 'child.json' },
        Properties: structuredClone(ROW_PROPERTIES),
      },
    },
    Outputs: {
      Out: { Value: { 'Fn::GetAtt': ['Row', 'Outputs.Piece'] }, Export: { Name: 'piece-export' } },
      PlainOut: { Value: { 'Fn::GetAtt': ['Row', 'Outputs.Plain'] } },
    },
  } as CloudFormationTemplate;
}

/** The LEGACY record: the piece in plaintext where a current deploy stores `***`. */
function legacyState(): StackState {
  return {
    version: STATE_SCHEMA_VERSION_CURRENT,
    region: REGION,
    stackName: STACK,
    resources: {
      Row: {
        physicalId: CHILD_ARN,
        resourceType: 'AWS::CloudFormation::Stack',
        properties: { TemplateURL: ROW_PROPERTIES.TemplateURL, Parameters: { X: `${PIN}/${A}` } },
        attributes: { 'Outputs.Piece': PIN, 'Outputs.Plain': 'plain-7097' },
        dependencies: [],
      },
    },
    outputs: { Out: PIN, 'piece-export': PIN, PlainOut: 'plain-7097' },
    lastModified: 0,
  } as unknown as StackState;
}

describe('maskLegacyTaintedRowOutputs (#7097)', () => {
  it('masks only the outputs the child derives from the mixed parameter', () => {
    const state = legacyState();
    maskLegacyTaintedRowOutputs(state, parentTemplate(), STACK, childTemplateLoader({ Row: join(dir, 'child.json') }));
    expect(state.resources['Row']!.attributes).toEqual({ 'Outputs.Piece': '***', 'Outputs.Plain': 'plain-7097' });
  });

  it('leaves a row whose record holds no secret parameter untouched, child template or not', () => {
    const state = legacyState();
    state.resources['Row']!.properties!['Parameters'] = { X: `${PIN}/plain` };
    maskLegacyTaintedRowOutputs(state, parentTemplate(), STACK, undefined);
    expect(state.resources['Row']!.attributes!['Outputs.Piece']).toBe(PIN);
  });

  it('keeps every output of a row mixing a PUBLIC ssm reference, which the record holds resolved (review)', () => {
    const template = parentTemplate();
    (template.Resources!['Row'] as { Properties: Record<string, unknown> }).Properties['Parameters'] = {
      X: '{{resolve:ssm:/public/name}}/v1',
    };
    const state = legacyState();
    state.resources['Row']!.properties!['Parameters'] = { X: 'public-value/v1' };
    state.resources['Row']!.attributes = { 'Outputs.Piece': 'public-value', 'Outputs.Plain': 'plain-7097' };
    maskLegacyTaintedRowOutputs(state, template, STACK, childTemplateLoader({ Row: join(dir, 'child.json') }));
    expect(state.resources['Row']!.attributes).toEqual({
      'Outputs.Piece': 'public-value',
      'Outputs.Plain': 'plain-7097',
    });
  });

  it('masks a row whose record holds the parameter as the mask (a grandchild fed an inherited mixed value)', () => {
    const state = legacyState();
    state.resources['Row']!.properties!['Parameters'] = { X: '***' };
    maskLegacyTaintedRowOutputs(state, parentTemplate(), STACK, childTemplateLoader({ Row: join(dir, 'child.json') }));
    expect(state.resources['Row']!.attributes!['Outputs.Piece']).toBe('***');
  });


  it('refuses, naming the row and the output but never the value, when the child template cannot be read', () => {
    const state = legacyState();
    let thrown: unknown;
    try {
      maskLegacyTaintedRowOutputs(state, parentTemplate(), STACK, childTemplateLoader({}));
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).toContain('nested stack Row');
    expect(message).toContain('output(s) Piece');
    expect(message).toContain('--replace-resource Row');
    expect(message.includes(`${PIN}`) && !message.includes('Piece')).toBe(false);
    expect(message.replace(/Piece|Plain|piece/g, '')).not.toContain(PIN);
  });
});

describe('the class: every child output shape over the mixed parameter reads as the mask, and only those (#7097)', () => {
  const MIXED = { Ref: 'X' };
  const OTHER = { Ref: 'Y' };
  /** [label, output value, derived from X?] */
  const SHAPES: Array<[string, unknown, boolean]> = [
    ['Ref', MIXED, true],
    ['Select over Split', { 'Fn::Select': [0, { 'Fn::Split': ['/', MIXED] }] }, true],
    ['Join', { 'Fn::Join': ['-', [MIXED, 'a']] }, true],
    ['Sub string', { 'Fn::Sub': 'p-${X}' }, true],
    ['Sub variable', { 'Fn::Sub': ['${V}', { V: MIXED }] }, true],
    ['If branch', { 'Fn::If': ['C', MIXED, 'b'] }, true],
    ['GetAtt of a resource reading X', { 'Fn::GetAtt': ['Reader', 'Value'] }, true],
    ['Ref to an unmixed parameter', OTHER, false],
    ['literal', 'lit', false],
    ['GetAtt of a resource reading nothing mixed', { 'Fn::GetAtt': ['Other', 'Value'] }, false],
    // An id of a resource that merely reads X: a current record keeps such an
    // id copy as written (#4849), so a parent reading it is not refused (review).
    ['GetAtt Arn of a resource reading X', { 'Fn::GetAtt': ['Fn', 'Arn'] }, false],
    ['Ref of a resource reading X', { Ref: 'Fn' }, false],
    ['Sub of an id of a resource reading X', { 'Fn::Sub': '${Fn.Arn}' }, false],
  ];
  it.each(SHAPES)('%s', (_label, value, derived) => {
    const child = {
      Parameters: { X: { Type: 'String' }, Y: { Type: 'String' } },
      Conditions: { C: { 'Fn::Equals': ['a', 'a'] } },
      Resources: {
        Reader: { Type: 'AWS::SSM::Parameter', Properties: { Type: 'String', Value: MIXED } },
        Other: { Type: 'AWS::SSM::Parameter', Properties: { Type: 'String', Value: OTHER } },
        Fn: {
          Type: 'AWS::Lambda::Function',
          Properties: { Handler: 'h', Environment: { Variables: { V: MIXED } } },
        },
      },
      Outputs: { O: { Value: value } },
    };
    const path = join(dir, `shape-${_label.replace(/\W+/g, '-')}.json`);
    writeFileSync(path, JSON.stringify(child));
    const template = parentTemplate();
    (template.Resources!['Row'] as { Properties: Record<string, unknown> }).Properties['Parameters'] = {
      X: { 'Fn::Join': ['', [{ Ref: 'Sep' }, '/', A]] },
      Y: 'plain',
    };
    const state = legacyState();
    state.resources['Row']!.attributes = { 'Outputs.O': 'legacy-value' };
    maskLegacyTaintedRowOutputs(state, template, STACK, childTemplateLoader({ Row: path }));
    expect(state.resources['Row']!.attributes!['Outputs.O']).toBe(derived ? '***' : 'legacy-value');
  });
});

describe('a secret composed one level down: the row record holds no secret parameter (review: depth 3)', () => {
  const SECRET_MIX = { 'Fn::Join': ['', [{ Ref: 'Sep' }, '/', A]] };
  const PUBLIC_MIX = { 'Fn::Join': ['', [{ Ref: 'Sep' }, '/', '{{resolve:ssm:/public/name}}']] };
  /** Root -> Row (child.json) -> Grand (grand.json); the CHILD composes the reference. */
  function tree(name: string, grandParameter: unknown, writeGrand = true): string {
    const sub = join(dir, name);
    mkdirSync(sub, { recursive: true });
    if (writeGrand) {
      writeFileSync(
        join(sub, 'grand.json'),
        JSON.stringify({
          Parameters: { Y: { Type: 'String' } },
          Outputs: {
            J: { Value: { 'Fn::Select': [0, { 'Fn::Split': ['/', { Ref: 'Y' }] }] } },
            J2: { Value: 'grand-plain' },
          },
        })
      );
    }
    writeFileSync(
      join(sub, 'child.json'),
      JSON.stringify({
        Parameters: { Sep: { Type: 'String' } },
        Resources: {
          Grand: {
            Type: 'AWS::CloudFormation::Stack',
            Metadata: { 'aws:asset:path': 'grand.json' },
            Properties: { TemplateURL: 'https://s3.amazonaws.com/assets/grand.json', Parameters: { Y: grandParameter } },
          },
        },
        Outputs: {
          K: { Value: { 'Fn::GetAtt': ['Grand', 'Outputs.J'] } },
          K2: { Value: { 'Fn::GetAtt': ['Grand', 'Outputs.J2'] } },
        },
      })
    );
    return join(sub, 'child.json');
  }
  function depth3State(): StackState {
    const state = legacyState();
    state.resources['Row']!.properties!['Parameters'] = { Sep: PIN };
    state.resources['Row']!.attributes = { 'Outputs.K': PIN, 'Outputs.K2': 'grand-plain' };
    return state;
  }

  it('masks the child output reading the grandchild output derived from the secret, and only it', () => {
    const state = depth3State();
    const masked = maskLegacyTaintedRowOutputs(
      state,
      parentTemplate(),
      STACK,
      childTemplateLoader({ Row: tree('d3-secret', SECRET_MIX) })
    );
    expect(state.resources['Row']!.attributes).toEqual({ 'Outputs.K': '***', 'Outputs.K2': 'grand-plain' });
    expect([...(masked.get('Row') ?? [])]).toEqual(['Outputs.K']);
  });

  it('keeps every output when the child composes a PUBLIC ssm reference', () => {
    const state = depth3State();
    maskLegacyTaintedRowOutputs(state, parentTemplate(), STACK, childTemplateLoader({ Row: tree('d3-public', PUBLIC_MIX) }));
    expect(state.resources['Row']!.attributes).toEqual({ 'Outputs.K': PIN, 'Outputs.K2': 'grand-plain' });
  });

  it('masks every output reading the grandchild when its template cannot be read', () => {
    const state = depth3State();
    maskLegacyTaintedRowOutputs(
      state,
      parentTemplate(),
      STACK,
      childTemplateLoader({ Row: tree('d3-nogrand', SECRET_MIX, false) })
    );
    expect(state.resources['Row']!.attributes).toEqual({ 'Outputs.K': '***', 'Outputs.K2': '***' });
  });
});

describe('a deploy over a legacy mixed-fed row record persists no plaintext (#7097)', () => {
  let saveState: ReturnType<typeof vi.fn>;
  let indexWrites: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    indexWrites = vi.fn().mockResolvedValue(undefined);
    logged.lines.length = 0;
    saveState = vi.fn().mockResolvedValue('etag-new');
  });

  async function deploy(
    nestedTemplates: Record<string, string>,
    consumers: StackState[] = [],
    template: CloudFormationTemplate = parentTemplate(),
    seed: (state: StackState) => void = () => undefined
  ) {
    const provider = {
      create: vi.fn(),
      update: vi.fn(async (_id: string, physicalId: string) => ({ physicalId, wasReplaced: false })),
      delete: vi.fn(),
      getAttribute: vi.fn(),
      readCurrentState: vi.fn().mockResolvedValue(undefined),
    };
    const engine = new DeployEngine(
      {
        getState: vi.fn(async (name: string) => {
          const consumer = consumers.find((c) => c.stackName === name);
          if (consumer) return { state: structuredClone(consumer), etag: 'e0' };
          const state = legacyState();
          seed(state);
          return { state, etag: 'e0' };
        }),
        saveState,
        listStacks: vi.fn().mockResolvedValue(
          consumers.map((c) => ({ stackName: c.stackName, region: REGION }))
        ),
      } as never,
      { acquireLockWithRetry: vi.fn().mockResolvedValue(true), releaseLock: vi.fn().mockResolvedValue(undefined) } as never,
      new DagBuilder(),
      new DiffCalculator(),
      {
        getProvider: vi.fn().mockReturnValue(provider),
        getProviderFor: vi.fn().mockReturnValue({ provider, provisionedBy: 'sdk' }),
        getRegisteredTypes: vi.fn().mockReturnValue([]),
        validateResourceTypes: vi.fn(),
        validateResourceProperties: vi.fn(),
      } as never,
      { dryRun: false },
      REGION,
      {
        updateForStack: indexWrites,
        prefetch: vi.fn().mockResolvedValue(undefined),
        lookup: vi.fn().mockResolvedValue(null),
        patchEntry: vi.fn().mockResolvedValue(undefined),
      } as never
    );
    let thrown: unknown;
    await withNestedStackContext({ nestedTemplates } as never, () =>
      engine.deploy(STACK, template)
    ).catch((e: unknown) => {
      thrown = e;
    });
    const saved = saveState.mock.calls
      .map((call) => call.find((a: unknown) => typeof a === 'object' && a !== null && 'resources' in (a as object)))
      .filter(Boolean) as StackState[];
    return { thrown, saved };
  }

  it('persists the mask for the derived output and its export, the plain output as it is', async () => {
    const { thrown, saved } = await deploy({ Row: join(dir, 'child.json') });
    expect(thrown).toBeUndefined();
    const last = saved.at(-1);
    expect(last, 'a state save').toBeDefined();
    expect(last!.outputs['Out']).toBe('***');
    expect(last!.outputs['PlainOut']).toBe('plain-7097');
    // The export alias and the exports index carry the mask, never the piece.
    expect(last!.outputs['piece-export']).toBe('***');
    // The index IS rewritten (the value moved from the legacy plaintext to the
    // mask), and carries the mask, never the piece (review round 1).
    expect(indexWrites).toHaveBeenCalled();
    expect(JSON.stringify(indexWrites.mock.calls)).toContain('***');
    expect(JSON.stringify(indexWrites.mock.calls).includes(`"${PIN}"`)).toBe(false);
    const every = JSON.stringify(saved);
    expect(every.replace(/\{\{resolve:[^}]+\}\}/g, '').includes(`"${PIN}"`), every).toBe(false);
    // The parent's own `Sep` lines print the template's default: its own input,
    // out of scope as in #7077. No other line prints the piece.
    const own = /^(Parameter Sep: using default value |Resolved Ref to parameter: Sep resolved to )/;
    expect(
      logged.lines.filter((line) => !own.test(line) && (line.includes(`"${PIN}"`) || line.endsWith(` ${PIN}`)))
    ).toEqual([]);
  });

  it('is not refused by the export guard for an export COMPOSED over the derived output (review round 2)', async () => {
    const consumer = {
      version: STATE_SCHEMA_VERSION_CURRENT,
      region: REGION,
      stackName: 'cons-7097',
      resources: {},
      outputs: {},
      imports: [{ exportName: 'piece-export', sourceStack: STACK, sourceRegion: REGION }],
      lastModified: 0,
    } as unknown as StackState;
    const template = parentTemplate();
    template.Outputs!['Out'] = {
      Value: { 'Fn::Join': ['', ['x-', { 'Fn::GetAtt': ['Row', 'Outputs.Piece'] }]] },
      Export: { Name: 'piece-export' },
    };
    // The legacy record published the composed value over the plaintext.
    const { thrown, saved } = await deploy({ Row: join(dir, 'child.json') }, [consumer], template, (state) => {
      state.outputs['Out'] = `x-${PIN}`;
      state.outputs['piece-export'] = `x-${PIN}`;
    });
    expect(thrown).toBeUndefined();
    expect(saved.at(-1)!.outputs['Out']).toBe('x-***');
  });

  it('is not refused by the export guard while a consumer still imports the export (review)', async () => {
    const consumer = {
      version: STATE_SCHEMA_VERSION_CURRENT,
      region: REGION,
      stackName: 'cons-7097',
      resources: {},
      outputs: {},
      imports: [{ exportName: 'piece-export', sourceStack: STACK, sourceRegion: REGION }],
      lastModified: 0,
    } as unknown as StackState;
    const { thrown, saved } = await deploy({ Row: join(dir, 'child.json') }, [consumer]);
    expect(thrown).toBeUndefined();
    expect(saved.at(-1)!.outputs['Out']).toBe('***');
  });

  it('keeps an unrelated Lambda ARN of the same row in plaintext, and its importer is not refused (review)', async () => {
    const ARN = `arn:aws:lambda:${REGION}:123456789012:function:fn-7097`;
    const childPath = join(dir, 'child-fn.json');
    writeFileSync(
      childPath,
      JSON.stringify({
        ...CHILD,
        Resources: {
          Fn: {
            Type: 'AWS::Lambda::Function',
            Properties: { Handler: 'h', Environment: { Variables: { V: { Ref: 'X' } } } },
          },
        },
        Outputs: { ...CHILD.Outputs, FnArn: { Value: { 'Fn::GetAtt': ['Fn', 'Arn'] } } },
      })
    );
    const consumer = {
      version: STATE_SCHEMA_VERSION_CURRENT,
      region: REGION,
      stackName: 'cons-fn-7097',
      resources: {},
      outputs: {},
      imports: [{ exportName: 'fn-arn-export', sourceStack: STACK, sourceRegion: REGION }],
      lastModified: 0,
    } as unknown as StackState;
    const template = parentTemplate();
    template.Outputs!['FnArnOut'] = {
      Value: { 'Fn::GetAtt': ['Row', 'Outputs.FnArn'] },
      Export: { Name: 'fn-arn-export' },
    };
    const { thrown, saved } = await deploy({ Row: childPath }, [consumer], template, (state) => {
      state.resources['Row']!.attributes!['Outputs.FnArn'] = ARN;
      state.outputs['FnArnOut'] = ARN;
      state.outputs['fn-arn-export'] = ARN;
    });
    expect(thrown).toBeUndefined();
    const last = saved.at(-1)!;
    expect(last.outputs['Out']).toBe('***');
    expect(last.outputs['FnArnOut']).toBe(ARN);
    expect(last.outputs['fn-arn-export']).toBe(ARN);
  });

  it('refuses the deploy when the child template cannot be read, and saves nothing new', async () => {
    const { thrown, saved } = await deploy({});
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain('nested stack Row');
    expect(JSON.stringify(saved).includes(`"${PIN}"`)).toBe(false);
  });
});

describe('cdkd diff: a deleted nested row masks its subtree by its recorded taint (#7097 note)', () => {
  async function diffDeleted(rowParameters: Record<string, unknown>) {
    const { buildDiffTree, diffTreeToJson, renderDiffTree } = await import(
      '../../../src/cli/commands/diff-recursive.js'
    );
    const states: Record<string, StackState> = {
      Parent: {
        version: STATE_SCHEMA_VERSION_CURRENT,
        region: REGION,
        stackName: 'Parent',
        resources: {
          Row: {
            physicalId: 'arn:cdkd-local:us-east-1:123456789012:nested-stack/Parent/Row',
            resourceType: 'AWS::CloudFormation::Stack',
            properties: { TemplateURL: 'u', Parameters: rowParameters },
            attributes: {},
            dependencies: [],
          },
        },
        outputs: {},
        lastModified: 0,
      } as unknown as StackState,
      'Parent~Row': {
        version: STATE_SCHEMA_VERSION_CURRENT,
        region: REGION,
        stackName: 'Parent~Row',
        resources: {
          Db: {
            physicalId: 'db',
            resourceType: 'AWS::SSM::Parameter',
            properties: { Type: 'String', Value: PIN },
            attributes: {},
            dependencies: [],
          },
        },
        outputs: { Piece: PIN },
        lastModified: 0,
      } as unknown as StackState,
    };
    const root = await buildDiffTree({
      stackName: 'Parent',
      displayName: 'Parent',
      region: REGION,
      template: { Resources: {} },
      parameters: {},
      nestedTemplates: {},
      recursive: true,
      stateBackend: {
        getState: async (name: string) => (states[name] ? { state: structuredClone(states[name]), etag: 'e' } : null),
        listStacks: async () => [],
      },
      diffCalculator: new DiffCalculator(),
      isNestedChild: false,
    } as never);
    const lines: string[] = [];
    renderDiffTree(root, true, (line: string) => lines.push(line));
    return [...lines, JSON.stringify(diffTreeToJson(root))].join('\n');
  }

  it('a row whose recorded Parameters mix a reference prints no value of its subtree', async () => {
    const printed = await diffDeleted({ X: `${PIN}/${A}` });
    expect(printed).toContain('Db');
    expect(printed.replace(/\{\{resolve:[^}]+\}\}/g, '').includes(PIN), printed).toBe(false);
  });

  it('a row with ordinary recorded Parameters still prints its values (control)', async () => {
    const printed = await diffDeleted({ X: 'plain' });
    expect(printed).toContain(PIN);
  });
});


describe('the export guard relaxation is scoped to the reads the legacy mask rewrote (review)', () => {
  const template = {
    Resources: { Row: { Type: 'AWS::CloudFormation::Stack', Properties: {} } },
    Outputs: {
      Out: { Value: { 'Fn::Join': ['', ['x-', { 'Fn::GetAtt': ['Row', 'Outputs.Secret'] }]] }, Export: { Name: 'e' } },
    },
  } as unknown as CloudFormationTemplate;
  const judge = async (legacyMaskedReads: Map<string, Set<string>> | undefined, desired = 'x-***') =>
    findAffectedExports({
      template,
      conditions: {},
      changes: new Map(),
      currentState: { outputs: { Out: 'x-plain', e: 'x-plain' }, exportNames: ['e'] } as never,
      resolve: () => Promise.resolve(desired),
      replaces: () => false,
      legacyMaskedReads,
    });

  it('a non-legacy export that newly holds the mask is CHANGED', async () => {
    expect(await judge(undefined)).toEqual([{ exportName: 'e', reason: 'changed' }]);
    expect(await judge(new Map([['Row', new Set(['Outputs.Other'])]]))).toEqual([
      { exportName: 'e', reason: 'changed' },
    ]);
  });

  it('an export reading a masked legacy read is unchanged, unless the text around the mask moved', async () => {
    const masked = new Map([['Row', new Set(['Outputs.Secret'])]]);
    expect(await judge(masked)).toEqual([]);
    expect(await judge(masked, 'y-***')).toEqual([{ exportName: 'e', reason: 'changed' }]);
  });
});

