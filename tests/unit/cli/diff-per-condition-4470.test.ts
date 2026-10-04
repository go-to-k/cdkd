/**
 * `cdkd diff` evaluates `Conditions` PER CONDITION (issue
 * [#4470](https://github.com/go-to-k/cdkd/issues/4470)).
 *
 * The diff used to skip the WHOLE `Conditions` section as soon as parameter
 * binding failed or any one condition referenced a token-valued (secret
 * dynamic-reference) parameter. With no verdicts in context, every `Fn::If`
 * resolved to its FALSE branch — including those on conditions that depend on
 * no parameter at all — so a condition-true property diffed as a perpetual
 * spurious UPDATE and `diff --fail` exited 1 on an unchanged stack.
 *
 * What is pinned here:
 *  - a condition independent of the unknown parameters gets its real verdict,
 *    beside a token-dependent one and beside a binding failure;
 *  - binding is per parameter, so one unbindable parameter does not unbind
 *    the rest;
 *  - an UNKNOWN verdict never prunes (no phantom DELETE), directly or through
 *    a `{Condition: X}` chain, while a KNOWN false one still does;
 *  - an UNKNOWN condition stays out of the returned `conditions` when state
 *    holds no recorded verdict for it. Reusing a recorded one is
 *    go-to-k/cdkd#4479's, pinned in `diff-recorded-verdicts-4479.test.ts`.
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

import { buildDiffTree, computeStackDiff, treeHasChanges } from '../../../src/cli/commands/diff-recursive.js';
import { DiffCalculator } from '../../../src/analyzer/diff-calculator.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { ResourceState, StackState } from '../../../src/types/state.js';
import type { S3StateBackend } from '../../../src/state/s3-state-backend.js';

const NESTED = 'AWS::CloudFormation::Stack';
const SSM = 'AWS::SSM::Parameter';
const SECRET_PARAM = 'SubFloorPinSsm';
const SECRET_EXPR = '{{resolve:secretsmanager:prod/db/cred:SecretString:pin::}}';

function res(resourceType: string, properties: Record<string, unknown>): ResourceState {
  return { physicalId: 'pid', resourceType, properties, attributes: {}, dependencies: [] };
}

function st(
  stackName: string,
  resources: Record<string, ResourceState>,
  outputs: Record<string, unknown> = {}
): StackState {
  return { stackName, region: 'us-east-1', resources, outputs, version: 6, lastModified: 0 };
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
  parameters?: Record<string, unknown>
) {
  return await computeStackDiff(
    state,
    template,
    'us-east-1',
    'S',
    fakeBackend({}),
    new DiffCalculator(),
    parameters ? { parameters } : {}
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  secretSend.mockImplementation(() => {
    throw new Error('cdkd diff must not fetch a secret value at plan time');
  });
});

describe('a token-dependent condition beside an independent one (#4470)', () => {
  // The issue's shape: `PinSsmNeverMatches` reads a parameter fed a secret
  // dynamic reference, `SpansOn` depends on nothing.
  const template = (): CloudFormationTemplate => ({
    Parameters: { [SECRET_PARAM]: { Type: 'String' } },
    Conditions: {
      PinSsmNeverMatches: { 'Fn::Equals': [{ Ref: SECRET_PARAM }, 'never'] },
      SpansOn: { 'Fn::Equals': ['on', 'on'] },
      SpansOff: { 'Fn::Equals': ['on', 'off'] },
    },
    Resources: {
      HandoffSpans: {
        Type: SSM,
        Properties: {
          Type: 'String',
          Value: { 'Fn::Join': ['', ['span', { 'Fn::If': ['SpansOn', '-prod', ''] }]] },
        },
      },
      OffOnly: { Type: SSM, Condition: 'SpansOff', Properties: { Type: 'String', Value: 'x' } },
    },
    Outputs: { Spans: { Value: { 'Fn::If': ['SpansOn', 'yes', 'no'] } } },
  });

  it('resolves an Fn::If on the independent condition by its real verdict (no spurious UPDATE)', async () => {
    const { changes, outputChanges } = await diff(
      st('S', { HandoffSpans: res(SSM, { Type: 'String', Value: 'span-prod' }) }, { Spans: 'yes' }),
      template(),
      { [SECRET_PARAM]: SECRET_EXPR }
    );
    expect(changes.get('HandoffSpans')!.changeType).toBe('NO_CHANGE');
    expect(outputChanges).toEqual([]);
    expect(secretSend).not.toHaveBeenCalled();
  });

  it('still prunes a resource gated on a KNOWN-false condition (no phantom CREATE)', async () => {
    const { changes } = await diff(
      st('S', { HandoffSpans: res(SSM, { Type: 'String', Value: 'span-prod' }) }),
      template(),
      { [SECRET_PARAM]: SECRET_EXPR }
    );
    expect(changes.has('OffOnly')).toBe(false);
  });

  it('reports the independent condition through the returned verdicts, and leaves the dependent one out', async () => {
    const { conditions } = await diff(st('S', {}), template(), { [SECRET_PARAM]: SECRET_EXPR });
    expect(conditions).toBeDefined();
    expect(conditions!['SpansOn']).toBe(true);
    expect(conditions!['SpansOff']).toBe(false);
    expect(Object.hasOwn(conditions!, 'PinSsmNeverMatches')).toBe(false);
  });
});

describe('a parameter-binding failure beside an independent condition (#4470)', () => {
  const template = (): CloudFormationTemplate => ({
    Parameters: {
      Req: { Type: 'String' },
      Env: { Type: 'String', Default: 'dev' },
    },
    Conditions: {
      IsX: { 'Fn::Equals': [{ Ref: 'Req' }, 'x'] },
      SpansOn: { 'Fn::Equals': ['on', 'on'] },
      IsDev: { 'Fn::Equals': [{ Ref: 'Env' }, 'dev'] },
    },
    Resources: {
      Spans: {
        Type: SSM,
        Properties: { Type: 'String', Value: { 'Fn::If': ['SpansOn', 'on-v', 'off-v'] } },
      },
      DevValue: {
        Type: SSM,
        Properties: { Type: 'String', Value: { 'Fn::If': ['IsDev', 'dev-v', 'prod-v'] } },
      },
      FromEnv: { Type: SSM, Properties: { Type: 'String', Value: { Ref: 'Env' } } },
      Gated: { Type: SSM, Condition: 'IsX', Properties: { Type: 'String', Value: 'g' } },
    },
  });

  const freshState = () =>
    st('S', {
      Spans: res(SSM, { Type: 'String', Value: 'on-v' }),
      DevValue: res(SSM, { Type: 'String', Value: 'dev-v' }),
      FromEnv: res(SSM, { Type: 'String', Value: 'dev' }),
      Gated: res(SSM, { Type: 'String', Value: 'g' }),
    });

  it('evaluates a condition that references no parameter', async () => {
    const { changes } = await diff(freshState(), template());
    expect(changes.get('Spans')!.changeType).toBe('NO_CHANGE');
  });

  it('binds every OTHER parameter, so its Ref and its conditions resolve (per-parameter binding)', async () => {
    const { changes, resolvedParameters } = await diff(freshState(), template());
    expect(resolvedParameters?.['Env']).toBe('dev');
    expect(changes.get('FromEnv')!.changeType).toBe('NO_CHANGE');
    expect(changes.get('DevValue')!.changeType).toBe('NO_CHANGE');
  });

  it('never prunes a resource gated on the condition over the unbound parameter (no phantom DELETE)', async () => {
    const { changes } = await diff(freshState(), template());
    expect(changes.get('Gated')!.changeType).toBe('NO_CHANGE');
  });
});

describe('an unknown verdict never prunes (#4470)', () => {
  it('keeps a resource gated through a {Condition: X} chain onto a token-dependent condition', async () => {
    // `Chained` never names the token parameter; it inherits the dependency
    // through `PinMatches`. Over the TOKEN `PinMatches` would answer false, so
    // pruning by it would drop `Gated` while it is still in state.
    const template: CloudFormationTemplate = {
      Parameters: { [SECRET_PARAM]: { Type: 'String' } },
      Conditions: {
        PinMatches: { 'Fn::Equals': [{ Ref: SECRET_PARAM }, 'the-real-pin'] },
        Chained: { 'Fn::And': [{ Condition: 'PinMatches' }, { 'Fn::Equals': ['a', 'a'] }] },
      },
      Resources: {
        Gated: { Type: SSM, Condition: 'Chained', Properties: { Type: 'String', Value: 'g' } },
      },
    };
    const { changes, conditions } = await diff(
      st('S', { Gated: res(SSM, { Type: 'String', Value: 'g' }) }),
      template,
      { [SECRET_PARAM]: SECRET_EXPR }
    );
    expect(changes.get('Gated')!.changeType).toBe('NO_CHANGE');
    expect(Object.hasOwn(conditions ?? {}, 'Chained')).toBe(false);
  });

  it('keeps a resource gated on a condition reading the unknown parameter through Fn::Sub', async () => {
    const template: CloudFormationTemplate = {
      Parameters: { Req: { Type: 'String' } },
      Conditions: { IsX: { 'Fn::Equals': [{ 'Fn::Sub': 'pre-${Req}' }, 'pre-x'] } },
      Resources: {
        Gated: { Type: SSM, Condition: 'IsX', Properties: { Type: 'String', Value: 'g' } },
      },
    };
    const { changes } = await diff(
      st('S', { Gated: res(SSM, { Type: 'String', Value: 'g' }) }),
      template
    );
    expect(changes.get('Gated')!.changeType).toBe('NO_CHANGE');
  });

  it('still reports DELETE for a KNOWN-false resource in state beside an unknown condition', async () => {
    const template: CloudFormationTemplate = {
      Parameters: { Req: { Type: 'String' } },
      Conditions: {
        IsX: { 'Fn::Equals': [{ Ref: 'Req' }, 'x'] },
        Never: { 'Fn::Equals': ['a', 'b'] },
      },
      Resources: {
        Off: { Type: SSM, Condition: 'Never', Properties: { Type: 'String', Value: 'o' } },
      },
    };
    const { changes } = await diff(
      st('S', { Off: res(SSM, { Type: 'String', Value: 'o' }) }),
      template
    );
    expect(changes.get('Off')!.changeType).toBe('DELETE');
  });
});

describe('the dependency closure is a fixpoint (#4470)', () => {
  it('terminates on a condition reference cycle and keeps its gated resource', async () => {
    const { changes } = await diff(
      st('S', { Gated: res(SSM, { Type: 'String', Value: 'g' }) }),
      {
        Parameters: { Req: { Type: 'String' } },
        Conditions: {
          A: { 'Fn::And': [{ Condition: 'B' }, { 'Fn::Equals': [{ Ref: 'Req' }, 'x'] }] },
          B: { 'Fn::Or': [{ Condition: 'A' }, { 'Fn::Equals': ['a', 'a'] }] },
        },
        Resources: {
          Gated: { Type: SSM, Condition: 'B', Properties: { Type: 'String', Value: 'g' } },
        },
      }
    );
    expect(changes.get('Gated')!.changeType).toBe('NO_CHANGE');
  });

  it('marks a cycle member unknown whatever the declaration order', async () => {
    // `A` is declared first and reaches the unknown `C` only AFTER its
    // back-edge through `B`; a memoized walk recorded `B` as known.
    const { changes, conditions } = await diff(
      st('S', { Gated: res(SSM, { Type: 'String', Value: 'g' }) }),
      {
        Parameters: { Req: { Type: 'String' } },
        Conditions: {
          A: { 'Fn::Or': [{ Condition: 'B' }, { Condition: 'C' }] },
          B: { 'Fn::And': [{ Condition: 'A' }, { 'Fn::Equals': ['a', 'a'] }] },
          C: { 'Fn::Equals': [{ Ref: 'Req' }, 'x'] },
        },
        Resources: {
          Gated: { Type: SSM, Condition: 'B', Properties: { Type: 'String', Value: 'g' } },
        },
      }
    );
    expect(Object.hasOwn(conditions ?? {}, 'B')).toBe(false);
    expect(changes.get('Gated')!.changeType).toBe('NO_CHANGE');
  });

  it('reaches an unknown parameter through a TWO-hop chain declared before its dependency', async () => {
    // One pass in declaration order meets `X` before `Y` is known: only the
    // fixpoint's repeat pass marks it.
    const { changes, conditions } = await diff(
      st('S', { Gated: res(SSM, { Type: 'String', Value: 'g' }) }),
      {
        Parameters: { Req: { Type: 'String' } },
        Conditions: {
          X: { 'Fn::And': [{ Condition: 'Y' }, { 'Fn::Equals': ['a', 'a'] }] },
          Y: { 'Fn::And': [{ Condition: 'Z' }, { 'Fn::Equals': ['a', 'a'] }] },
          Z: { 'Fn::Equals': [{ Ref: 'Req' }, 'x'] },
        },
        Resources: {
          Gated: { Type: SSM, Condition: 'X', Properties: { Type: 'String', Value: 'g' } },
        },
      }
    );
    expect(Object.hasOwn(conditions ?? {}, 'X')).toBe(false);
    expect(changes.get('Gated')!.changeType).toBe('NO_CHANGE');
  });

});

describe('the #1948 withholding keeps main\'s reading when a condition has no verdict (#4470)', () => {
  it('withholds a legacy stored output when the only secret sits in a KNOWN-false resource', async () => {
    // Main skipped evaluation here (a condition reads the secret-fed
    // parameter) and scanned the unpruned template; pruning `Off` must not
    // hide the reference and release the stored value.
    const { outputChanges } = await diff(
      st('S', {}, { Legacy: 'legacy-plaintext' }),
      {
        Parameters: { [SECRET_PARAM]: { Type: 'String' } },
        Conditions: {
          Off: { 'Fn::Equals': ['a', 'b'] },
          PinMatches: { 'Fn::Equals': [{ Ref: SECRET_PARAM }, 'x'] },
        },
        Resources: {
          Pruned: {
            Type: SSM,
            Condition: 'Off',
            Properties: { Type: 'String', Value: '{{resolve:secretsmanager:s:SecretString:k}}' },
          },
        },
      },
      { [SECRET_PARAM]: SECRET_EXPR }
    );
    const legacy = outputChanges.find((c) => c.name === 'Legacy');
    expect(legacy).toBeDefined();
    expect(legacy!.oldValueRedacted).toBe(true);
  });
});

describe('the nested path evaluates per condition too (#4470)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cdkd-diff-4470-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('resolves the child Fn::If on an independent condition beside a secret-fed one (the issue repro)', async () => {
    const childPath = join(dir, 'child.json');
    writeFileSync(
      childPath,
      JSON.stringify({
        Parameters: { [SECRET_PARAM]: { Type: 'String' } },
        Conditions: {
          PinSsmNeverMatches: { 'Fn::Equals': [{ Ref: SECRET_PARAM }, 'never'] },
          SpansOn: { 'Fn::Equals': ['on', 'on'] },
        },
        Resources: {
          HandoffSpans: {
            Type: SSM,
            Properties: {
              Type: 'String',
              Value: { 'Fn::Join': ['', ['span', { 'Fn::If': ['SpansOn', '-prod', ''] }]] },
            },
          },
          HandoffSpansIf: {
            Type: SSM,
            Properties: {
              Type: 'String',
              Value: { 'Fn::If': ['SpansOn', { 'Fn::Sub': `x-\${${SECRET_PARAM}}` }, 'none'] },
            },
          },
        },
      })
    );
    const root = await buildDiffTree({
      stackName: 'Parent',
      displayName: 'Parent',
      region: 'us-east-1',
      template: {
        Resources: {
          Child: {
            Type: NESTED,
            Metadata: { 'aws:asset:path': 'child.json' },
            Properties: { Parameters: { [SECRET_PARAM]: SECRET_EXPR } },
          },
        },
      },
      nestedTemplates: { Child: childPath },
      recursive: true,
      stateBackend: fakeBackend({
        Parent: st('Parent', { Child: res(NESTED, { Parameters: { [SECRET_PARAM]: SECRET_EXPR } }) }),
        'Parent~Child': st('Parent~Child', {
          HandoffSpans: res(SSM, { Type: 'String', Value: 'span-prod' }),
          HandoffSpansIf: res(SSM, { Type: 'String', Value: `x-${SECRET_EXPR}` }),
        }),
      }),
      diffCalculator: new DiffCalculator(),
      isNestedChild: false,
    });
    const child = root.children[0]!;
    expect(child.changes.get('HandoffSpans')!.changeType).toBe('NO_CHANGE');
    expect(child.changes.get('HandoffSpansIf')!.changeType).toBe('NO_CHANGE');
    expect(treeHasChanges(root)).toBe(false);
    expect(secretSend).not.toHaveBeenCalled();
  });

});
