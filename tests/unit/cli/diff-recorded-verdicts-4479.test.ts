/**
 * `cdkd diff` reuses the condition verdicts a deploy RECORDED (issue
 * [#4479](https://github.com/go-to-k/cdkd/issues/4479)).
 *
 * A condition over a parameter fed a secret `{{resolve:...}}` reference has
 * no verdict at plan time, and an `Fn::If` on it took its FALSE branch: a
 * stack deployed under the TRUE branch diffed as a perpetual UPDATE.
 *
 * The deploy records each such verdict with a fingerprint of the condition's
 * definitions and parameter inputs (`src/deployment/condition-verdicts.ts`).
 * The diff reuses a verdict only when its own fingerprint is EQUAL, and then
 * diffs every slot against the true verdict. So a branch swap, an edited
 * slot, an edited condition and a changed secret reference are all still
 * reported. The records here are built by the deploy's own builder.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('../../../src/utils/aws-clients.js', async (importOriginal) =>
  (await import('../deployment/_inert-cloudformation-client.js')).withInertCloudFormationClient(importOriginal)
);

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

/** A live secret fetch is a failure of this file's premise. */
const secretSend = vi.hoisted(() => vi.fn());
vi.mock('@aws-sdk/client-secrets-manager', async (importOriginal) => {
  const actual = (await importOriginal()) as object;
  return {
    ...actual,
    SecretsManagerClient: vi.fn().mockImplementation(() => ({
      send: secretSend,
      config: { region: () => Promise.resolve('us-east-1') },
      destroy: () => undefined,
    })),
  };
});

import {
  buildDiffTree,
  computeStackDiff,
  treeHasChanges,
} from '../../../src/cli/commands/diff-recursive.js';
import { DiffCalculator } from '../../../src/analyzer/diff-calculator.js';
import {
  buildConditionVerdictRecord,
  conditionInputsFrom,
} from '../../../src/deployment/condition-verdicts.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { ResourceState, StackState } from '../../../src/types/state.js';
import type { S3StateBackend } from '../../../src/state/s3-state-backend.js';
import { getLogger } from '../../../src/utils/logger.js';

const NESTED = 'AWS::CloudFormation::Stack';
const SSM = 'AWS::SSM::Parameter';
const STAGE_EXPR = '{{resolve:secretsmanager:app/config:SecretString:stage::}}';

function res(resourceType: string, properties: Record<string, unknown>): ResourceState {
  return { physicalId: 'pid', resourceType, properties, attributes: {}, dependencies: [] };
}

function ssm(value: unknown): ResourceState {
  return res(SSM, { Type: 'String', Value: value });
}

function st(
  stackName: string,
  resources: Record<string, ResourceState>,
  outputs: Record<string, unknown> = {},
  conditionVerdicts?: StackState['conditionVerdicts']
): StackState {
  return {
    stackName,
    region: 'us-east-1',
    resources,
    outputs,
    version: 10,
    lastModified: 0,
    ...(conditionVerdicts && { conditionVerdicts }),
  };
}

/**
 * What the deploy records for `template` when its conditions evaluated to
 * `verdicts`: secret-fed parameters as their expressions, the rest bound.
 */
function recorded(
  template: CloudFormationTemplate,
  verdicts: Record<string, boolean>,
  tokens: Record<string, string> = { Stage: STAGE_EXPR },
  bound: Record<string, unknown> = {}
): StackState['conditionVerdicts'] {
  return buildConditionVerdictRecord(template, verdicts, conditionInputsFrom({ tokens, bound }));
}

function fakeBackend(states: Record<string, StackState>): S3StateBackend {
  return {
    getState: async (stackName: string) => {
      const state = states[stackName];
      return state ? { state, etag: 'fake' } : null;
    },
  } as unknown as S3StateBackend;
}

async function diff(
  state: StackState,
  template: CloudFormationTemplate,
  parameters: Record<string, unknown> = { Stage: STAGE_EXPR }
) {
  return await computeStackDiff(
    state,
    template,
    'us-east-1',
    'S',
    fakeBackend({}),
    new DiffCalculator(),
    { parameters }
  );
}

function ssmRow(value: unknown, extra: Record<string, unknown> = {}) {
  return { Type: SSM, ...extra, Properties: { Type: 'String', Value: value } };
}

const stageParam = { Stage: { Type: 'String' } };
const isProd = { 'Fn::Equals': [{ Ref: 'Stage' }, 'prod'] };

function changeType(result: Awaited<ReturnType<typeof diff>>, id: string): string | undefined {
  return result.changes.get(id)?.changeType;
}

beforeEach(() => {
  vi.clearAllMocks();
  secretSend.mockImplementation(() => {
    throw new Error('cdkd diff must not fetch a secret value at plan time');
  });
});

afterEach(() => {
  expect(secretSend).not.toHaveBeenCalled();
});

/** One resource slot and one output slot on `IsProd`. */
const repro = (isProdDefinition: unknown = isProd): CloudFormationTemplate => ({
  Parameters: stageParam,
  Conditions: { IsProd: isProdDefinition },
  Resources: { Size: ssmRow({ 'Fn::If': ['IsProd', 'big', 'small'] }) },
  Outputs: { SizeOut: { Value: { 'Fn::If': ['IsProd', 'big-out', 'small-out'] } } },
});
const trueDeploy = (record = recorded(repro(), { IsProd: true })) =>
  st('S', { Size: ssm('big') }, { SizeOut: 'big-out' }, record);

describe('the repro: an unchanged stack deployed under either branch (#4479)', () => {
  it('reports NO_CHANGE for a stack whose last deploy took the TRUE branch', async () => {
    const result = await diff(trueDeploy(), repro());
    expect(changeType(result, 'Size')).toBe('NO_CHANGE');
    expect(result.outputChanges).toEqual([]);
    expect(result.conditions?.['IsProd']).toBe(true);
  });

  it('reports NO_CHANGE for a stack whose last deploy took the FALSE branch', async () => {
    const result = await diff(
      st('S', { Size: ssm('small') }, { SizeOut: 'small-out' }, recorded(repro(), { IsProd: false })),
      repro()
    );
    expect(changeType(result, 'Size')).toBe('NO_CHANGE');
    expect(result.outputChanges).toEqual([]);
  });

  it('keeps the FALSE branch for a record written before the field existed', async () => {
    const result = await diff(st('S', { Size: ssm('big') }, { SizeOut: 'big-out' }), repro());
    expect(changeType(result, 'Size')).toBe('UPDATE');
    expect(Object.hasOwn(result.conditions ?? {}, 'IsProd')).toBe(false);
    // No record is no mismatch: nothing to warn about.
    const warns = (getLogger().warn as unknown as { mock: { calls: unknown[][] } }).mock.calls.flat();
    expect(warns.join('\n')).not.toContain('cannot tell which branch');
  });

  it('reads a malformed field as no record', async () => {
    for (const malformed of [
      'x',
      [],
      { IsProd: true },
      { IsProd: { verdict: 'true', fingerprint: 'sha256:x' } },
      { IsProd: { verdict: true } },
    ]) {
      const state = trueDeploy();
      (state as { conditionVerdicts?: unknown }).conditionVerdicts = malformed;
      const result = await diff(state, repro());
      expect(changeType(result, 'Size')).toBe('UPDATE');
    }
  });
});

describe('every slot is diffed against the TRUE verdict, so nothing is hidden (#4479)', () => {
  it('a branch swap after a TRUE deploy reports UPDATE', async () => {
    const swapped = repro();
    swapped.Resources!['Size'] = ssmRow({ 'Fn::If': ['IsProd', 'small', 'big'] });
    const result = await diff(trueDeploy(), swapped);
    expect(changeType(result, 'Size')).toBe('UPDATE');
  });

  it('a branch swap after a FALSE deploy reports UPDATE', async () => {
    const swapped = repro();
    swapped.Resources!['Size'] = ssmRow({ 'Fn::If': ['IsProd', 'small', 'big'] });
    const result = await diff(
      st('S', { Size: ssm('small') }, { SizeOut: 'small-out' }, recorded(repro(), { IsProd: false })),
      swapped
    );
    expect(changeType(result, 'Size')).toBe('UPDATE');
  });

  it('swapping every slot reports UPDATE on each', async () => {
    const swapped: CloudFormationTemplate = {
      ...repro(),
      Resources: { Size: ssmRow({ 'Fn::If': ['IsProd', 'small', 'big'] }) },
      Outputs: { SizeOut: { Value: { 'Fn::If': ['IsProd', 'small-out', 'big-out'] } } },
    };
    const result = await diff(trueDeploy(), swapped);
    expect(changeType(result, 'Size')).toBe('UPDATE');
    expect(result.outputChanges.map((c) => c.name)).toEqual(['SizeOut']);
  });

  it('an edited minority slot is reported while the slots that agree stay NO_CHANGE', async () => {
    const template: CloudFormationTemplate = {
      Parameters: stageParam,
      Conditions: { IsProd: isProd },
      Resources: {
        R1: ssmRow({ 'Fn::If': ['IsProd', 'big1', 'small1'] }),
        R2: ssmRow({ 'Fn::If': ['IsProd', 'big2', 'small2'] }),
        R4: ssmRow({ 'Fn::If': ['IsProd', 'huge4', 'big4'] }),
      },
    };
    const result = await diff(
      st('S', { R1: ssm('big1'), R2: ssm('big2'), R4: ssm('big4') }, {}, recorded(template, { IsProd: true })),
      template
    );
    expect(changeType(result, 'R4')).toBe('UPDATE');
    expect(changeType(result, 'R1')).toBe('NO_CHANGE');
    expect(changeType(result, 'R2')).toBe('NO_CHANGE');
  });

  it('P1: two properties matching only under opposite verdicts: the one off the TRUE verdict is UPDATE', async () => {
    const template: CloudFormationTemplate = {
      Parameters: stageParam,
      Conditions: { IsProd: isProd },
      Resources: {
        R1: ssmRow({ 'Fn::If': ['IsProd', 'x', 'y'] }),
        R2: ssmRow({ 'Fn::If': ['IsProd', 'u', 'v'] }),
      },
    };
    const result = await diff(
      st('S', { R1: ssm('x'), R2: ssm('v') }, {}, recorded(template, { IsProd: true })),
      template
    );
    expect(changeType(result, 'R1')).toBe('NO_CHANGE');
    expect(changeType(result, 'R2')).toBe('UPDATE');
  });

  it('P2: two members of one object matching only under opposite verdicts report UPDATE', async () => {
    const template: CloudFormationTemplate = {
      Parameters: stageParam,
      Conditions: { IsProd: isProd },
      Resources: {
        R: {
          Type: SSM,
          Properties: {
            Type: 'String',
            Value: 'v',
            Tags: {
              a: { 'Fn::If': ['IsProd', '1', '0'] },
              b: { 'Fn::If': ['IsProd', '1', '0'] },
            },
          },
        },
      },
    };
    const result = await diff(
      st(
        'S',
        { R: res(SSM, { Type: 'String', Value: 'v', Tags: { a: '1', b: '0' } }) },
        {},
        recorded(template, { IsProd: true })
      ),
      template
    );
    expect(changeType(result, 'R')).toBe('UPDATE');
  });
});

describe('correlated conditions take the verdicts the deploy computed (#4479)', () => {
  it('NOT shape: state no deploy produces (IsProd and NotProd both TRUE) reports UPDATE', async () => {
    const template: CloudFormationTemplate = {
      Parameters: stageParam,
      Conditions: { IsProd: isProd, NotProd: { 'Fn::Not': [{ Condition: 'IsProd' }] } },
      Resources: {
        A: ssmRow({ 'Fn::If': ['IsProd', 'a1', 'a0'] }),
        B: ssmRow({ 'Fn::If': ['NotProd', 'b1', 'b0'] }),
      },
    };
    const result = await diff(
      st('S', { A: ssm('a1'), B: ssm('b1') }, {}, recorded(template, { IsProd: true, NotProd: false })),
      template
    );
    expect(changeType(result, 'A')).toBe('NO_CHANGE');
    expect(changeType(result, 'B')).toBe('UPDATE');
  });

  it('NOT shape: a record reached through a {Condition: X} chain is reused', async () => {
    const template: CloudFormationTemplate = {
      Parameters: stageParam,
      Conditions: { IsProd: isProd, NotProd: { 'Fn::Not': [{ Condition: 'IsProd' }] } },
      Resources: { B: ssmRow({ 'Fn::If': ['NotProd', 'b1', 'b0'] }) },
    };
    const result = await diff(
      st('S', { B: ssm('b1') }, {}, recorded(template, { IsProd: false, NotProd: true })),
      template
    );
    expect(changeType(result, 'B')).toBe('NO_CHANGE');
  });

  it('EQ shape: one parameter compared to two literals is never both', async () => {
    const template: CloudFormationTemplate = {
      Parameters: stageParam,
      Conditions: { IsProd: isProd, IsDev: { 'Fn::Equals': [{ Ref: 'Stage' }, 'dev'] } },
      Resources: {
        P: ssmRow({ 'Fn::If': ['IsProd', 'p1', 'p0'] }),
        D: ssmRow({ 'Fn::If': ['IsDev', 'd1', 'd0'] }),
      },
    };
    const result = await diff(
      st('S', { P: ssm('p1'), D: ssm('d1') }, {}, recorded(template, { IsProd: true, IsDev: false })),
      template
    );
    expect(changeType(result, 'P')).toBe('NO_CHANGE');
    expect(changeType(result, 'D')).toBe('UPDATE');
  });
});

describe('a record is reused only on an EXACT fingerprint match (#4479)', () => {
  it('a condition literal edit (prod -> production) keeps FALSE and reports UPDATE', async () => {
    const result = await diff(trueDeploy(), repro({ 'Fn::Equals': [{ Ref: 'Stage' }, 'production'] }));
    expect(changeType(result, 'Size')).toBe('UPDATE');
    expect(result.outputChanges.map((c) => c.name)).toEqual(['SizeOut']);
    expect(Object.hasOwn(result.conditions ?? {}, 'IsProd')).toBe(false);
  });

  it('wrapping the condition in Fn::Not keeps FALSE', async () => {
    const result = await diff(trueDeploy(), repro({ 'Fn::Not': [isProd] }));
    expect(Object.hasOwn(result.conditions ?? {}, 'IsProd')).toBe(false);
    expect(changeType(result, 'Size')).toBe('UPDATE');
  });

  it('an edit to a condition reached through {Condition: X} keeps FALSE', async () => {
    const chained = (literal: string): CloudFormationTemplate => ({
      Parameters: stageParam,
      Conditions: {
        Base: { 'Fn::Equals': [{ Ref: 'Stage' }, literal] },
        IsProd: { 'Fn::And': [{ Condition: 'Base' }, { 'Fn::Equals': ['a', 'a'] }] },
      },
      Resources: { Size: ssmRow({ 'Fn::If': ['IsProd', 'big', 'small'] }) },
    });
    const result = await diff(
      st('S', { Size: ssm('big') }, {}, recorded(chained('prod'), { IsProd: true })),
      chained('production')
    );
    expect(changeType(result, 'Size')).toBe('UPDATE');
  });

  it('a different secret reference fed to the parameter keeps FALSE', async () => {
    const result = await diff(trueDeploy(), repro(), {
      Stage: '{{resolve:secretsmanager:app/other:SecretString:stage::}}',
    });
    expect(Object.hasOwn(result.conditions ?? {}, 'IsProd')).toBe(false);
    expect(changeType(result, 'Size')).toBe('UPDATE');
  });

  it('a changed value of a second, plain parameter in the closure keeps FALSE', async () => {
    const template = (envDefault: string): CloudFormationTemplate => ({
      Parameters: { Stage: { Type: 'String' }, Env: { Type: 'String', Default: envDefault } },
      Conditions: {
        IsProd: { 'Fn::And': [isProd, { 'Fn::Equals': [{ Ref: 'Env' }, 'x'] }] },
      },
      Resources: { Size: ssmRow({ 'Fn::If': ['IsProd', 'big', 'small'] }) },
    });
    const record = recorded(template('x'), { IsProd: true }, { Stage: STAGE_EXPR }, { Env: 'x' });
    const same = await diff(st('S', { Size: ssm('big') }, {}, record), template('x'));
    expect(changeType(same, 'Size')).toBe('NO_CHANGE');
    const edited = await diff(st('S', { Size: ssm('big') }, {}, record), template('y'));
    expect(Object.hasOwn(edited.conditions ?? {}, 'IsProd')).toBe(false);
  });

  it('an UNBOUND parameter in the closure keeps FALSE even with a record', async () => {
    const template: CloudFormationTemplate = {
      Parameters: { Stage: { Type: 'String' }, Req: { Type: 'String' } },
      Conditions: {
        IsProd: { 'Fn::And': [isProd, { 'Fn::Equals': [{ Ref: 'Req' }, 'r'] }] },
      },
      Resources: { Size: ssmRow({ 'Fn::If': ['IsProd', 'big', 'small'] }) },
    };
    const record = recorded(template, { IsProd: true }, { Stage: STAGE_EXPR }, { Req: 'r' });
    expect(record).toBeDefined();
    const result = await diff(st('S', { Size: ssm('big') }, {}, record), template);
    expect(Object.hasOwn(result.conditions ?? {}, 'IsProd')).toBe(false);
  });

  it('a parameter a state resource of the same logical id shadows keeps FALSE', async () => {
    const state = trueDeploy();
    state.resources['Stage'] = ssm('old-resource-with-this-id');
    const result = await diff(state, repro());
    expect(Object.hasOwn(result.conditions ?? {}, 'IsProd')).toBe(false);
  });

  it('a forged record for an unmodelled shape (Fn::Sub) is never reused', async () => {
    const template = repro({ 'Fn::Equals': [{ 'Fn::Sub': '${Stage}' }, 'prod'] });
    const forged = { IsProd: { verdict: true, fingerprint: 'sha256:anything' } };
    const result = await diff(st('S', { Size: ssm('big') }, {}, forged), template);
    expect(Object.hasOwn(result.conditions ?? {}, 'IsProd')).toBe(false);
    expect(changeType(result, 'Size')).toBe('UPDATE');
  });

  it('a record whose fingerprint was copied from another condition is never reused', async () => {
    const template: CloudFormationTemplate = {
      Parameters: stageParam,
      Conditions: { IsProd: isProd, IsDev: { 'Fn::Equals': [{ Ref: 'Stage' }, 'dev'] } },
      Resources: {
        P: ssmRow({ 'Fn::If': ['IsProd', 'p1', 'p0'] }),
        D: ssmRow({ 'Fn::If': ['IsDev', 'd1', 'd0'] }),
      },
    };
    const real = recorded(template, { IsProd: true, IsDev: false })!;
    const swapped = {
      IsProd: { verdict: false, fingerprint: real['IsDev']!.fingerprint },
      IsDev: { verdict: true, fingerprint: real['IsProd']!.fingerprint },
    };
    const result = await diff(st('S', { P: ssm('p1'), D: ssm('d0') }, {}, swapped), template);
    expect(Object.hasOwn(result.conditions ?? {}, 'IsProd')).toBe(false);
    expect(Object.hasOwn(result.conditions ?? {}, 'IsDev')).toBe(false);
  });
});

describe('a record that no longer matches keeps FALSE, in BOTH directions, and says so (#4479)', () => {
  const warned = () => (getLogger().warn as unknown as { mock: { calls: unknown[][] } }).mock.calls.flat().join('\n');

  it('a FALSE deploy then an edit that flips the condition to TRUE still shows FALSE (no change): the residual the warning names', async () => {
    // The deploy took FALSE (state holds `small`); the edit makes the real
    // verdict TRUE, so the next deploy writes `big`. The diff cannot know:
    // the fingerprint differs and it takes FALSE, as main always did.
    const state = st(
      'S',
      { Size: ssm('small') },
      { SizeOut: 'small-out' },
      recorded(repro(), { IsProd: false })
    );
    const result = await diff(state, repro({ 'Fn::Not': [isProd] }));
    expect(changeType(result, 'Size')).toBe('NO_CHANGE');
    expect(warned()).toContain('IsProd');
    expect(warned()).toContain('cannot tell which branch the next deploy takes');
  });

  it('a matching record warns nothing', async () => {
    await diff(trueDeploy(), repro());
    expect(warned()).not.toContain('cannot tell which branch');
  });
});

describe('a matched record prunes like a known verdict (#4479)', () => {
  const gated = (): CloudFormationTemplate => ({
    ...repro(),
    Resources: {
      Size: ssmRow({ 'Fn::If': ['IsProd', 'big', 'small'] }),
      Gated: ssmRow('g', { Condition: 'IsProd' }),
    },
  });

  it('a resource gated on a recorded-FALSE condition is a DELETE, as the deploy does', async () => {
    const result = await diff(
      st('S', { Size: ssm('small'), Gated: ssm('g') }, {}, recorded(gated(), { IsProd: false })),
      gated()
    );
    expect(changeType(result, 'Gated')).toBe('DELETE');
  });

  it('a resource gated on a recorded-TRUE condition is kept', async () => {
    const result = await diff(
      st('S', { Size: ssm('big'), Gated: ssm('g') }, {}, recorded(gated(), { IsProd: true })),
      gated()
    );
    expect(changeType(result, 'Gated')).toBe('NO_CHANGE');
  });

  it('an output gated on a recorded-FALSE condition is a REMOVE, on a recorded-TRUE one it is kept', async () => {
    const gatedOut = (): CloudFormationTemplate => ({
      ...repro(),
      Outputs: { GatedOut: { Condition: 'IsProd', Value: 'g' } },
    });
    const off = await diff(
      st('S', { Size: ssm('small') }, { GatedOut: 'g' }, recorded(gatedOut(), { IsProd: false })),
      gatedOut()
    );
    expect(off.outputChanges.map((c) => [c.name, c.changeType])).toEqual([['GatedOut', 'REMOVE']]);
    const on = await diff(
      st('S', { Size: ssm('big') }, { GatedOut: 'g' }, recorded(gatedOut(), { IsProd: true })),
      gatedOut()
    );
    expect(on.outputChanges).toEqual([]);
  });

  it('without a matching record the gated resource is never pruned', async () => {
    const result = await diff(st('S', { Size: ssm('small'), Gated: ssm('g') }), gated());
    expect(changeType(result, 'Gated')).toBe('NO_CHANGE');
  });
});

describe('a nested-stack row\'s Parameters entry uses the child\'s recorded verdict (#4479)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cdkd-diff-4479-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** Parent -> Child (fed the secret) -> Grand (fed an Fn::If over the child's condition). */
  async function tree(rowSize: unknown) {
    const childTemplate: CloudFormationTemplate = {
      Parameters: stageParam,
      Conditions: { IsProd: isProd },
      Resources: {
        Local: ssmRow({ 'Fn::If': ['IsProd', 'big', 'small'] }),
        Grand: {
          Type: NESTED,
          Metadata: { 'aws:asset:path': 'grand.json' },
          Properties: { Parameters: { Size: rowSize } },
        },
      },
    };
    writeFileSync(
      join(dir, 'grand.json'),
      JSON.stringify({
        Parameters: { Size: { Type: 'String' } },
        Resources: { Sized: ssmRow({ Ref: 'Size' }) },
      })
    );
    writeFileSync(join(dir, 'child.json'), JSON.stringify(childTemplate));
    return await buildDiffTree({
      stackName: 'Parent',
      displayName: 'Parent',
      region: 'us-east-1',
      template: {
        Resources: {
          Child: {
            Type: NESTED,
            Metadata: { 'aws:asset:path': 'child.json' },
            Properties: { Parameters: { Stage: STAGE_EXPR } },
          },
        },
      },
      nestedTemplates: { Child: join(dir, 'child.json') },
      recursive: true,
      stateBackend: fakeBackend({
        Parent: st('Parent', { Child: res(NESTED, { Parameters: { Stage: STAGE_EXPR } }) }),
        'Parent~Child': st(
          'Parent~Child',
          { Local: ssm('big'), Grand: res(NESTED, { Parameters: { Size: 'big' } }) },
          {},
          // Recorded against the template as DEPLOYED, before any edit below.
          recorded({ ...childTemplate, Resources: { Local: childTemplate.Resources!['Local']! } }, {
            IsProd: true,
          })
        ),
        'Parent~Child~Grand': st('Parent~Child~Grand', { Sized: ssm('big') }),
      }),
      diffCalculator: new DiffCalculator(),
      isNestedChild: false,
    });
  }

  it('an unchanged TRUE-deployed tree is clean, and the grandchild receives the TRUE-branch value', async () => {
    const root = await tree({ 'Fn::If': ['IsProd', 'big', 'small'] });
    const child = root.children[0]!;
    expect(child.changes.get('Grand')!.changeType).toBe('NO_CHANGE');
    expect(child.children[0]!.changes.get('Sized')!.changeType).toBe('NO_CHANGE');
    expect(treeHasChanges(root)).toBe(false);
  });

  it('an edited row Parameters entry whose FALSE branch equals state reports UPDATE down the tree', async () => {
    const root = await tree({ 'Fn::If': ['IsProd', 'huge', 'big'] });
    const child = root.children[0]!;
    expect(child.changes.get('Grand')!.changeType).toBe('UPDATE');
    expect(child.children[0]!.changes.get('Sized')!.changeType).toBe('UPDATE');
  });
});

describe('a child parameter whose parent row value changes or cannot be resolved (#4479)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cdkd-diff-4479-row-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** Child: `IsOn` over the token and `Mode` (Default `off`); deployed with Mode at its Default. */
  const childTemplate: CloudFormationTemplate = {
    Parameters: { Stage: { Type: 'String' }, Mode: { Type: 'String', Default: 'off' } },
    Conditions: {
      IsOn: {
        'Fn::And': [
          { 'Fn::Equals': [{ Ref: 'Stage' }, 'prod'] },
          { 'Fn::Equals': [{ Ref: 'Mode' }, 'off'] },
        ],
      },
    },
    Resources: { Local: ssmRow({ 'Fn::If': ['IsOn', 'big', 'small'] }) },
  };

  async function tree(rowMode: unknown, parentResources: Record<string, unknown> = {}) {
    writeFileSync(join(dir, 'child.json'), JSON.stringify(childTemplate));
    const row: Record<string, unknown> = { Stage: STAGE_EXPR };
    if (rowMode !== undefined) row['Mode'] = rowMode;
    return await buildDiffTree({
      stackName: 'Parent',
      displayName: 'Parent',
      region: 'us-east-1',
      template: {
        Resources: {
          ...(parentResources as CloudFormationTemplate['Resources']),
          Child: {
            Type: NESTED,
            Metadata: { 'aws:asset:path': 'child.json' },
            Properties: { Parameters: row },
          },
        },
      },
      nestedTemplates: { Child: join(dir, 'child.json') },
      recursive: true,
      stateBackend: fakeBackend({
        Parent: st('Parent', { Child: res(NESTED, { Parameters: { Stage: STAGE_EXPR } }) }),
        'Parent~Child': st(
          'Parent~Child',
          { Local: ssm('big') },
          {},
          recorded(childTemplate, { IsOn: true }, { Stage: STAGE_EXPR }, { Mode: 'off' })
        ),
      }),
      diffCalculator: new DiffCalculator(),
      isNestedChild: false,
    });
  }

  it('the unchanged tree (Mode at its Default, not passed) reuses the record', async () => {
    const root = await tree(undefined);
    expect(root.children[0]!.changes.get('Local')!.changeType).toBe('NO_CHANGE');
  });

  it('a row value that cannot be resolved now (a Ref to a resource not yet deployed) keeps FALSE', async () => {
    const root = await tree({ Ref: 'NewRes' }, { NewRes: ssmRow('x') });
    expect(root.children[0]!.changes.get('Local')!.changeType).toBe('UPDATE');
  });

  it('a plain value the parent now supplies keeps FALSE, even one the condition would accept', async () => {
    const root = await tree('off-but-supplied');
    expect(root.children[0]!.changes.get('Local')!.changeType).toBe('UPDATE');
  });

  it('a record over a parent-supplied plain value (one no deploy writes) is never reused', async () => {
    // The deploy withholds a parent-supplied plain value from the
    // fingerprint; the diff withholds it the same way, so even a record that
    // hashed one (an older or forged write) cannot match.
    writeFileSync(join(dir, 'child.json'), JSON.stringify(childTemplate));
    const root = await buildDiffTree({
      stackName: 'Parent',
      displayName: 'Parent',
      region: 'us-east-1',
      template: {
        Resources: {
          Child: {
            Type: NESTED,
            Metadata: { 'aws:asset:path': 'child.json' },
            Properties: { Parameters: { Stage: STAGE_EXPR, Mode: 'on' } },
          },
        },
      },
      nestedTemplates: { Child: join(dir, 'child.json') },
      recursive: true,
      stateBackend: fakeBackend({
        Parent: st('Parent', {
          Child: res(NESTED, { Parameters: { Stage: STAGE_EXPR, Mode: 'on' } }),
        }),
        'Parent~Child': st(
          'Parent~Child',
          { Local: ssm('small') },
          {},
          recorded(childTemplate, { IsOn: true }, { Stage: STAGE_EXPR }, { Mode: 'on' })
        ),
      }),
      diffCalculator: new DiffCalculator(),
      isNestedChild: false,
    });
    // State holds the FALSE branch (`small`): reusing the forged TRUE verdict
    // would diff `big` and report UPDATE.
    expect(root.children[0]!.changes.get('Local')!.changeType).toBe('NO_CHANGE');
  });

  it('a supplied value EQUAL to the Default is template text and keeps the record usable', async () => {
    const root = await tree('off');
    expect(root.children[0]!.changes.get('Local')!.changeType).toBe('NO_CHANGE');
  });
});

describe('the scrub-nested-child integ fixture\'s shape (#4479)', () => {
  // The synthesized child of tests/integration/scrub-nested-child.
  const secret = 'cdkd-scrub-nested-child-123456789012';
  const pwExpr = `{{resolve:secretsmanager:${secret}:SecretString:password::}}`;
  const stageExpr = `{{resolve:secretsmanager:${secret}:SecretString:stage::}}`;
  const apiExpr = `{{resolve:secretsmanager:${secret}:SecretString:api::}}`;
  const childTemplate = (
    options: { live?: string; literal?: string; swap?: boolean } = {}
  ): CloudFormationTemplate => {
    const live = options.live ?? 'scrub-nested-child live';
    const other = 'scrub-nested-child other';
    return {
      Parameters: { DbPassword: { Type: 'String' }, Stage: { Type: 'String' } },
      Conditions: {
        IsLive4479: {
          'Fn::Equals': [{ Ref: 'Stage' }, options.literal ?? 'cdkd-4479-stage-live'],
        },
      },
      Resources: {
        PwParam: {
          Type: SSM,
          Properties: {
            Description: { 'Fn::If': ['IsLive4479', ...(options.swap ? [other, live] : [live, other])] },
            Name: 'cdkd-scrub-nested-child-pw-123456789012',
            Type: 'String',
            Value: { Ref: 'DbPassword' },
          },
        },
      },
      Outputs: {
        PwOut: { Value: { Ref: 'DbPassword' } },
        ApiOut: { Value: apiExpr },
        Size4479: { Value: { 'Fn::If': ['IsLive4479', 'big-4479', 'small-4479'] } },
      },
    };
  };
  const deployed = () =>
    st(
      'S',
      {
        PwParam: res(SSM, {
          Description: 'scrub-nested-child live',
          Name: 'cdkd-scrub-nested-child-pw-123456789012',
          Type: 'String',
          Value: pwExpr,
        }),
      },
      { PwOut: pwExpr, ApiOut: apiExpr, Size4479: 'big-4479' },
      recorded(childTemplate(), { IsLive4479: true }, { DbPassword: pwExpr, Stage: stageExpr })
    );
  const inputs = { DbPassword: pwExpr, Stage: stageExpr };

  it('diffs the unchanged child clean', async () => {
    const result = await diff(deployed(), childTemplate(), inputs);
    expect(changeType(result, 'PwParam')).toBe('NO_CHANGE');
    expect(result.outputChanges).toEqual([]);
  });

  it('reports the condition literal edit (CDKD_4479_EDIT=literal)', async () => {
    const result = await diff(deployed(), childTemplate({ literal: 'cdkd-4479-stage-production' }), inputs);
    expect(changeType(result, 'PwParam')).toBe('UPDATE');
    expect(result.outputChanges.map((c) => c.name)).toEqual(['Size4479']);
  });

  it('reports the branch swap (CDKD_4479_EDIT=swap)', async () => {
    const result = await diff(deployed(), childTemplate({ swap: true }), inputs);
    expect(changeType(result, 'PwParam')).toBe('UPDATE');
    expect(result.changes.get('PwParam')!.propertyChanges![0]!.newValue).toBe(
      'scrub-nested-child other'
    );
    expect(result.outputChanges).toEqual([]);
  });
});
