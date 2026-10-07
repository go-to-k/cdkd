import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

// go-to-k/cdkd#4043, Phases A and B: an `Export.Name` that equals or embeds a
// `NoEcho` parameter's value is REFUSED, as the #1919 rule refuses a
// dynamic-reference secret. The alias is a state KEY and an exports-index key,
// and a key cannot be masked. The refusal reads the outputs pass's LOG-ONLY
// needles by containment (`printingCorpusOf(nameSecrets)`), so it gets the
// canonical and detection haystacks (#2874, #2889, #4001) and their floor.
const logLines = vi.hoisted(() => [] as string[]);
vi.mock('../../../src/utils/logger.js', () => {
  const capture = (...args: unknown[]): void => {
    logLines.push(args.map(String).join(' '));
  };
  const fns = {
    setLevel: vi.fn(),
    debug: capture,
    info: capture,
    warn: capture,
    error: capture,
    child: () => fns,
  };
  return { getLogger: () => fns };
});
vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    sts: { send: vi.fn().mockResolvedValue({ Account: '123456789012' }) },
    // An SSM-typed parameter's lookup (go-to-k/cdkd#4043 round 2).
    ssm: { send: vi.fn().mockResolvedValue({ Parameter: { Value: 'resolvedSsmSecret77' } }) },
  }),
}));
vi.mock('p-limit', () => ({ default: vi.fn(() => <T>(fn: () => T) => fn()) }));

import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import {
  exportNameSecretExposure,
  isNoEchoOnlyExposure,
  noEchoParameterExportNameWarning,
  noEchoParameterValueSeed,
  secretBearingExportNameWarning,
} from '../../../src/deployment/outputs-export-alias.js';
import {
  SECRET_MASK,
  recordLogOnlyValue,
  shareLogOnlyValues,
  type RecordedSecretValues,
} from '../../../src/deployment/secret-redaction.js';
import type { CloudFormationTemplate, TemplateOutput } from '../../../src/types/resource.js';
import type { ResourceChange, StackState } from '../../../src/types/state.js';

const NOECHO = 'hunter2NoEchoExport';

/** The engine's shape: a name map SHARING the pass map's log-only set. */
function passAndName(...needles: string[]): {
  pass: RecordedSecretValues;
  name: RecordedSecretValues;
} {
  const pass: RecordedSecretValues = new Map();
  const name: RecordedSecretValues = new Map();
  shareLogOnlyValues(name, pass);
  for (const needle of needles) recordLogOnlyValue(pass, needle);
  return { pass, name };
}

function exposed(exportName: string, ...needles: string[]): string[] | undefined {
  const { pass, name } = passAndName(...needles);
  const exposure = exportNameSecretExposure(exportName, name, pass);
  return exposure === undefined ? undefined : [...exposure.keys()];
}

describe('exportNameSecretExposure - a NoEcho value (go-to-k/cdkd#4043)', () => {
  it('refuses a name EQUAL to the value', () => {
    expect(exposed(NOECHO, NOECHO)).toEqual([NOECHO]);
  });

  it('refuses a name EMBEDDING the value', () => {
    expect(exposed(`exp-${NOECHO}-api`, NOECHO)).toEqual([NOECHO]);
  });

  it('refuses a name spelling the value in FULL-WIDTH characters (#4001 detection)', () => {
    // `abcd1234` in full-width letters and digits: NFKC folds it to the value.
    const fullWidth = 'ａｂｃｄ１２３４';
    expect(fullWidth.normalize('NFKC')).toBe('abcd1234');
    expect(exposed(`exp-${fullWidth}`, 'abcd1234')).toEqual(['abcd1234']);
  });

  it('refuses a name spelling the value with a compatibility LIGATURE (#4001 detection)', () => {
    // `U+FB01` folds to `fi`.
    expect(exposed('exp-proﬁle-x', 'profile')).toEqual(['profile']);
  });

  it('refuses a WHOLE name equal to a 1-3 character value, and not one embedding it', () => {
    expect(exposed('ab', 'ab')).toEqual(['ab']);
    // The containment floor: a sub-floor value embedded in a longer name is
    // coincidence-shaped, and refusing on it would drop ordinary exports. A
    // literal `x-ab-y` stays published; Phase B's positional refusal closes
    // only the case where the resolver SUBSTITUTED the value into the name.
    expect(exposed('x-ab-y', 'ab')).toBeUndefined();
  });

  it('publishes an innocent name beside a NoEcho value', () => {
    expect(exposed('PlainExport', NOECHO)).toBeUndefined();
  });

  it('keeps a map entry expression when the same plaintext is also a log-only needle', () => {
    // In the PASS map, not the name's own: `printingCorpusOf(name)` would
    // prefer a map entry of the name itself anyway.
    const { pass, name } = passAndName('dynref-plain');
    pass.set('dynref-plain', '{{resolve:ssm-secure:/x}}');
    const exposure = exportNameSecretExposure('exp-dynref-plain', name, pass);
    expect(exposure?.get('dynref-plain')).toBe('{{resolve:ssm-secure:/x}}');
  });
});

describe('the resolver masks a thrown error with the print-only corpus (go-to-k/cdkd#4043)', () => {
  it('masks a value only printingSecrets holds', async () => {
    const { IntrinsicFunctionResolver } = await import(
      '../../../src/deployment/intrinsic-function-resolver.js'
    );
    const printing: RecordedSecretValues = new Map();
    recordLogOnlyValue(printing, NOECHO);
    const resolver = new IntrinsicFunctionResolver('us-east-1');
    const masked = (
      resolver as unknown as {
        maskNamedError: (e: unknown, x: undefined, c: unknown) => unknown;
      }
    ).maskNamedError(new Error(`could not read ${NOECHO} here`), undefined, {
      template: { Resources: {} },
      resources: {},
      recordedSecretValues: new Map(),
      printingSecrets: printing,
    }) as Error;
    expect(masked.message).toBe(`could not read ${SECRET_MASK} here`);
  });
});

describe('secretBearingExportNameWarning - never prints the NoEcho value (go-to-k/cdkd#4043)', () => {
  it('masks an embedded value', () => {
    const { pass, name } = passAndName(NOECHO);
    const exportName = `exp-${NOECHO}`;
    const exposure = exportNameSecretExposure(exportName, name, pass)!;
    const message = secretBearingExportNameWarning('Echo', exportName, exposure, pass);
    expect(message).toContain(`Output Echo has an Export.Name`);
    expect(message).toContain(`(masked: "exp-${SECRET_MASK}")`);
    expect(message).not.toContain(NOECHO);
  });

  it('masks a whole 1-3 character value', () => {
    const { pass, name } = passAndName('ab');
    const exposure = exportNameSecretExposure('ab', name, pass)!;
    const message = secretBearingExportNameWarning('Echo', 'ab', exposure, pass);
    expect(message).toContain(`(masked: "${SECRET_MASK}")`);
  });

  it('withholds a name whose only hit is its full-width spelling', () => {
    const fullWidth = 'ａｂｃｄ１２３４';
    const { pass, name } = passAndName('abcd1234');
    const exposure = exportNameSecretExposure(`exp-${fullWidth}`, name, pass)!;
    const message = secretBearingExportNameWarning('Echo', `exp-${fullWidth}`, exposure, pass);
    expect(message).toContain('skipping the export alias');
    expect(message).not.toContain(fullWidth);
    expect(message).not.toContain('abcd1234');
    expect(message).not.toContain('(masked:');
  });
});

// The ENGINE half, with the REAL resolver: the refused alias reaches neither
// `state.outputs`, `exportNames`, nor the exports index.
function harness(
  parameters: Record<string, string>,
  inheritedSecrets?: RecordedSecretValues,
  extraOptions: Record<string, unknown> = {}
) {
  const props = { Name: '/app/param', Type: 'String', Value: { Ref: 'ResourceOnly' } };
  const provider = {
    create: vi.fn().mockResolvedValue({ physicalId: '/app/param' }),
    update: vi.fn(),
    delete: vi.fn().mockResolvedValue(undefined),
    getAttribute: vi.fn(),
    readCurrentState: vi.fn().mockResolvedValue(undefined),
  };
  const saveState = vi.fn().mockResolvedValue('etag');
  const updateForStack = vi.fn().mockResolvedValue(undefined);
  const diff = {
    calculateDiff: vi.fn().mockResolvedValue(
      new Map<string, ResourceChange>([
        [
          'R',
          {
            logicalId: 'R',
            changeType: 'CREATE',
            resourceType: 'AWS::SSM::Parameter',
            desiredProperties: props,
          },
        ],
      ])
    ),
    hasChanges: vi.fn().mockReturnValue(true),
    filterByType: vi
      .fn()
      .mockImplementation((c: Map<string, ResourceChange>, t: string) =>
        [...c.values()].filter((x) => x.changeType === t)
      ),
  };
  const engine = new DeployEngine(
    {
      getState: vi.fn().mockResolvedValue({ state: null, etag: undefined }),
      saveState,
      loadRollbackJournal: vi.fn().mockResolvedValue(null),
      appendRollbackJournalSegment: vi.fn(),
      popRollbackJournalSegment: vi.fn(),
      deleteRollbackJournal: vi.fn(),
    } as never,
    { acquireLockWithRetry: vi.fn().mockResolvedValue(true), releaseLock: vi.fn() } as never,
    {
      buildGraph: vi.fn().mockReturnValue({}),
      getExecutionLevels: vi.fn().mockReturnValue([['R']]),
      getDirectDependencies: vi.fn().mockReturnValue([]),
    } as never,
    diff as never,
    {
      getProvider: vi.fn().mockReturnValue(provider),
      getProviderFor: vi.fn().mockReturnValue({ provider, provisionedBy: 'sdk' }),
      getRegisteredTypes: vi.fn().mockReturnValue([]),
      validateResourceTypes: vi.fn(),
      validateResourceProperties: vi.fn(),
    } as never,
    { dryRun: false, parameters, ...(inheritedSecrets && { inheritedSecrets }), ...extraOptions },
    'us-east-1',
    { updateForStack } as never
  );
  return { engine, saveState, updateForStack, props };
}

function templateOf(
  noEcho: boolean,
  outputs: Record<string, unknown>,
  props: Record<string, unknown>
): CloudFormationTemplate {
  return {
    Parameters: {
      Secret: { Type: 'String', NoEcho: noEcho },
      ResourceOnly: { Type: 'String', NoEcho: true },
    },
    Resources: { R: { Type: 'AWS::SSM::Parameter', Properties: props } },
    Outputs: outputs as unknown as Record<string, TemplateOutput>,
  };
}

const RESOURCE_ONLY = 'resourceOnlyNoEchoValue';

async function deployed(noEcho: boolean, outputs: Record<string, unknown>) {
  const h = harness({ Secret: NOECHO, ResourceOnly: RESOURCE_ONLY });
  await h.engine.deploy('s', templateOf(noEcho, outputs, h.props));
  const states = h.saveState.mock.calls.map((call) => call[2] as StackState);
  expect(states.length).toBeGreaterThan(0);
  const last = states[states.length - 1]!;
  expect(h.updateForStack).toHaveBeenCalled();
  const indexed = h.updateForStack.mock.calls.map((call) => call[2] as Record<string, unknown>);
  return { states, last, indexed, lines: logLines.join('\n') };
}

const INNOCENT = { Innocent: { Value: 'w', Export: { Name: 'plain-export' } } };

beforeEach(() => {
  logLines.length = 0;
});

describe('DeployEngine - an Export.Name holding a NoEcho value is refused (go-to-k/cdkd#4043)', () => {
  // Both read the parameter, so the positional refusal (go-to-k/cdkd#4657)
  // decides them, ahead of the containment arms.
  const cases: Array<[string, unknown, string]> = [
    ['a Ref equal to the value', { Ref: 'Secret' }, NOECHO],
    ['an Fn::Sub embedding the value', { 'Fn::Sub': 'exp-${Secret}' }, `exp-${NOECHO}`],
  ];

  for (const [label, name, published] of cases) {
    it(`refuses ${label}: nothing in state or the exports index, the value in no line`, async () => {
      const r = await deployed(true, { Echo: { Value: 'v', Export: { Name: name } }, ...INNOCENT });
      for (const state of r.states) {
        expect(Object.keys(state.outputs)).not.toContain(published);
        expect(state.exportNames ?? []).not.toContain(published);
        expect(JSON.stringify(state)).not.toContain(NOECHO);
      }
      for (const index of r.indexed) expect(Object.keys(index)).not.toContain(published);
      // The output itself and the innocent sibling alias are still published.
      expect(r.last.outputs['Echo']).toBe('v');
      expect(r.last.outputs['plain-export']).toBe('w');
      expect(r.last.exportNames).toContain('plain-export');
      expect(r.indexed.some((index) => index['plain-export'] === 'w')).toBe(true);
      expect(r.lines).toContain(
        'Output Echo has an Export.Name that reads the NoEcho template parameter Secret'
      );
      expect(r.lines).not.toContain(NOECHO);
    });

    it(`publishes ${label} when the parameter is not NoEcho (negative control)`, async () => {
      const r = await deployed(false, { Echo: { Value: 'v', Export: { Name: name } }, ...INNOCENT });
      expect(r.last.outputs[published]).toBe('v');
      expect(r.last.exportNames).toContain(published);
      expect(r.indexed.some((index) => index[published] === 'v')).toBe(true);
    });
  }

  it('refuses a name that is the Fn::Base64 of the value an output value read (the encoding needle)', async () => {
    const encoded = Buffer.from(NOECHO).toString('base64');
    const r = await deployed(true, {
      Reader: { Value: { Ref: 'Secret' } },
      Echo: { Value: 'v', Export: { Name: { 'Fn::Base64': { 'Fn::Join': ['', [NOECHO]] } } } },
      ...INNOCENT,
    });
    expect(Object.keys(r.last.outputs)).not.toContain(encoded);
    expect(r.last.exportNames).toEqual(['plain-export']);
    expect(r.lines).not.toContain(encoded);
  });

  it('refuses a LITERAL name equal to a value another output reads (the pass-wide set)', async () => {
    const r = await deployed(true, {
      Reader: { Value: { Ref: 'Secret' } },
      Echo: { Value: 'v', Export: { Name: NOECHO } },
      ...INNOCENT,
    });
    expect(Object.keys(r.last.outputs)).not.toContain(NOECHO);
    expect(r.last.exportNames).not.toContain(NOECHO);
    expect(r.last.exportNames).toContain('plain-export');
  });

  // Declaration ORDER (Phase B): every name is resolved before any alias is
  // decided, so an EARLIER name is decided against a LATER name's needles too.
  // The needle here is the `Fn::Base64` encoding a later NAME records, which
  // no output value reads and the `NoEcho` seed does not hold, so only the
  // resolve-then-decide split can refuse the earlier name.
  it('refuses an EARLIER literal name holding a needle only a LATER name records', async () => {
    const encoded = Buffer.from(NOECHO).toString('base64');
    const r = await deployed(true, {
      First: { Value: 'a', Export: { Name: `lit-${encoded}` } },
      Second: { Value: 'b', Export: { Name: { 'Fn::Base64': { Ref: 'Secret' } } } },
      ...INNOCENT,
    });
    expect(Object.keys(r.last.outputs)).not.toContain(`lit-${encoded}`);
    expect(r.last.exportNames).toEqual(['plain-export']);
    expect(r.lines).toContain('Output First has an Export.Name that resolves to a value containing a secret');
    expect(r.lines).not.toContain(encoded);
  });

  it('refuses a LATER literal name holding a value an EARLIER name read', async () => {
    const r = await deployed(true, {
      First: { Value: 'b', Export: { Name: { Ref: 'Secret' } } },
      Second: { Value: 'a', Export: { Name: `lit-${NOECHO}` } },
    });
    expect(r.last.exportNames ?? []).toEqual([]);
    expect(JSON.stringify(r.last)).not.toContain(NOECHO);
  });

  // The SEED (Phase B, maintainer decision on #4043): every `NoEcho` value,
  // whether or not an output reads it, at the #1919 floor.
  it('refuses a LITERAL name holding a value only a RESOURCE reads', async () => {
    const r = await deployed(true, {
      Echo: { Value: 'v', Export: { Name: `exp-${RESOURCE_ONLY}` } },
      ...INNOCENT,
    });
    // The outputs and export names only: the resource's own property still
    // persists the value (the state.json half of #4043, a later phase).
    for (const state of r.states) {
      expect(JSON.stringify(state.outputs)).not.toContain(RESOURCE_ONLY);
      expect(JSON.stringify(state.exportNames ?? [])).not.toContain(RESOURCE_ONLY);
    }
    for (const index of r.indexed) expect(JSON.stringify(index)).not.toContain(RESOURCE_ONLY);
    expect(r.last.outputs['Echo']).toBe('v');
    expect(r.last.exportNames).toEqual(['plain-export']);
    expect(r.lines).toContain('Output Echo has an Export.Name that resolves to a value containing a secret');
    // The NoEcho reason, not a substituted secret's (the seed alone refused it).
    expect(r.lines).toContain('The name contains the value of a NoEcho template parameter');
    expect(r.lines).not.toContain(RESOURCE_ONLY);
  });

  it('publishes a literal name holding the value of a parameter that is not NoEcho (negative control)', async () => {
    // `Secret` is declared without NoEcho here, and nothing reads it.
    const r = await deployed(false, {
      Echo: { Value: 'v', Export: { Name: `exp-${NOECHO}` } },
    });
    expect(r.last.outputs[`exp-${NOECHO}`]).toBe('v');
    expect(r.last.exportNames).toEqual([`exp-${NOECHO}`]);
  });
});

describe('DeployEngine - a nested child seeds its verdict from the parent (go-to-k/cdkd#4043, Phase B)', () => {
  it("refuses a child's literal name spelling a parent NoEcho value a child parameter carries", async () => {
    // A CDK child declares no NoEcho: only the inherited bag knows the value.
    const inherited: RecordedSecretValues = new Map();
    recordLogOnlyValue(inherited, NOECHO);
    const h = harness({ Secret: `prefix-${NOECHO}`, ResourceOnly: RESOURCE_ONLY }, inherited);
    const template = templateOf(
      false,
      { Echo: { Value: 'v', Export: { Name: `child-${NOECHO}` } }, ...INNOCENT },
      h.props
    );
    await h.engine.deploy('s', template);
    const states = h.saveState.mock.calls.map((call) => call[2] as StackState);
    const last = states[states.length - 1]!;
    expect(last.outputs['Echo']).toBe('v');
    expect(last.exportNames).toEqual(['plain-export']);
    for (const state of states) expect(JSON.stringify(state.outputs)).not.toContain(NOECHO);
    const indexed = h.updateForStack.mock.calls.map((call) => call[2] as Record<string, unknown>);
    expect(indexed.length).toBeGreaterThan(0);
    for (const index of indexed) expect(JSON.stringify(index)).not.toContain(NOECHO);
    const lines = logLines.join('\n');
    expect(lines).toContain(
      'Output Echo has an Export.Name that resolves to a value containing a secret (masked: "child-***")'
    );
    expect(lines).not.toContain(NOECHO);
  });
});

describe('DeployEngine - a NoEcho value that is a whole {{resolve:...}} token (go-to-k/cdkd#4043, parity row)', () => {
  it('publishes a literal name spelling the token: the deploy binds the parameter to the token text, not its plaintext', async () => {
    const token = '{{resolve:ssm:/app/p}}';
    const h = harness({ Secret: token, ResourceOnly: RESOURCE_ONLY });
    const template = templateOf(true, { Echo: { Value: 'v', Export: { Name: `lit-${token}` } } }, h.props);
    await h.engine.deploy('s', template);
    const states = h.saveState.mock.calls.map((call) => call[2] as StackState);
    const last = states[states.length - 1]!;
    expect(last.outputs[`lit-${token}`]).toBe('v');
    expect(last.exportNames).toEqual([`lit-${token}`]);
  });
});

describe('DeployEngine - a NoEcho Number spelled by the operator (go-to-k/cdkd#4043)', () => {
  it('refuses a literal name spelling the user value as written, though the parameter binds coerced', async () => {
    const h = harness({ Secret: '0x1F2A', ResourceOnly: RESOURCE_ONLY });
    const template = templateOf(true, { Echo: { Value: 'v', Export: { Name: 'exp-0x1F2A' } }, ...INNOCENT }, h.props);
    template.Parameters!['Secret'] = { Type: 'Number', NoEcho: true };
    await h.engine.deploy('s', template);
    const states = h.saveState.mock.calls.map((call) => call[2] as StackState);
    const last = states[states.length - 1]!;
    expect(last.outputs['Echo']).toBe('v');
    expect(last.exportNames).toEqual(['plain-export']);
  });
});

describe('DeployEngine - a NoEcho SSM-typed parameter (go-to-k/cdkd#4043)', () => {
  it('seeds the looked-up value, never the SSM parameter NAME the operator spelled', async () => {
    const h = harness({ ResourceOnly: RESOURCE_ONLY });
    const template = templateOf(
      true,
      {
        ByName: { Value: 'n', Export: { Name: 'exp-DbPasswordArn' } },
        ByValue: { Value: 'v', Export: { Name: 'exp-resolvedSsmSecret77' } },
      },
      h.props
    );
    template.Parameters!['Secret'] = {
      Type: 'AWS::SSM::Parameter::Value<String>',
      NoEcho: true,
      Default: 'DbPassword',
    };
    // Referenced by a resource, so the deploy looks it up (an unreferenced
    // SSM-typed parameter is never resolved).
    (template.Resources['R']!.Properties as Record<string, unknown>)['Description'] = {
      Ref: 'Secret',
    };
    await h.engine.deploy('s', template);
    const states = h.saveState.mock.calls.map((call) => call[2] as StackState);
    const last = states[states.length - 1]!;
    // The name spelling the SSM path publishes; the one spelling the secret is refused.
    expect(last.exportNames).toEqual(['exp-DbPasswordArn']);
  });
});

describe('DeployEngine - an operator-supplied NoEcho SSM-typed value (go-to-k/cdkd#4043)', () => {
  it('publishes a name spelling the SSM name, which the deploy binds without a lookup', async () => {
    const h = harness({ Secret: 'DbPassword', ResourceOnly: RESOURCE_ONLY });
    const template = templateOf(
      true,
      { ByName: { Value: 'n', Export: { Name: 'exp-DbPasswordArn' } } },
      h.props
    );
    template.Parameters!['Secret'] = { Type: 'AWS::SSM::Parameter::Value<String>', NoEcho: true };
    (template.Resources['R']!.Properties as Record<string, unknown>)['Description'] = {
      Ref: 'Secret',
    };
    await h.engine.deploy('s', template);
    const states = h.saveState.mock.calls.map((call) => call[2] as StackState);
    expect(states[states.length - 1]!.exportNames).toEqual(['exp-DbPasswordArn']);
  });
});

describe('secretBearingExportNameWarning - the NoEcho reason (go-to-k/cdkd#4043)', () => {
  it('names a NoEcho parameter and the coincidental-match floor when only the seed refused the name', () => {
    const seed = noEchoParameterValueSeed({ Env: { NoEcho: true } }, { Env: 'prod' });
    const name: RecordedSecretValues = new Map();
    const pass: RecordedSecretValues = new Map();
    const exposure = exportNameSecretExposure('prod-VpcId', name, pass, seed)!;
    expect(isNoEchoOnlyExposure(exposure, name, pass)).toBe(true);
    const message = secretBearingExportNameWarning('Vpc', 'prod-VpcId', exposure, pass, true);
    expect(message).toContain('(masked: "***-VpcId")');
    expect(message).toContain('The name contains the value of a NoEcho template parameter');
    expect(message).toContain('even where the match is a coincidence');
    expect(message).toContain('An existing Fn::ImportValue of this name stops resolving');
    expect(message).not.toContain('prod');
  });

  it('is not NoEcho-only when only the pass map holds the plaintext', () => {
    const name: RecordedSecretValues = new Map();
    const pass: RecordedSecretValues = new Map([['passOnlySecret9', '{{resolve:secretsmanager:P}}']]);
    const exposure = exportNameSecretExposure('x-passOnlySecret9', name, pass)!;
    expect([...exposure.keys()]).toEqual(['passOnlySecret9']);
    expect(isNoEchoOnlyExposure(exposure, name, pass)).toBe(false);
  });

  it('keeps the secret wording when the name holds a substituted secret', () => {
    const name: RecordedSecretValues = new Map([['s3cretValue', '{{resolve:secretsmanager:S}}']]);
    const pass: RecordedSecretValues = new Map(name);
    const exposure = exportNameSecretExposure('x-s3cretValue', name, pass)!;
    expect(isNoEchoOnlyExposure(exposure, name, pass)).toBe(false);
    expect(secretBearingExportNameWarning('O', 'x-s3cretValue', exposure, pass)).toContain(
      'would persist the secret in plaintext'
    );
  });
});

describe('noEchoParameterValueSeed - the export-name verdict seed (go-to-k/cdkd#4043, Phase B)', () => {
  const seeded = (exportName: string, seed: RecordedSecretValues): string[] | undefined => {
    const exposure = exportNameSecretExposure(exportName, new Map(), new Map(), seed);
    return exposure === undefined ? undefined : [...exposure.keys()];
  };

  it('seeds each NoEcho parameter value and no other parameter', () => {
    const seed = noEchoParameterValueSeed(
      { Hidden: { NoEcho: true }, Plain: {} },
      { Hidden: 'hiddenValue1', Plain: 'plainValue1' }
    );
    expect(seeded('exp-hiddenValue1', seed)).toEqual(['hiddenValue1']);
    expect(seeded('exp-plainValue1', seed)).toBeUndefined();
  });

  it('applies the #1919 floor: a whole name at any length, an embedded value at 4+', () => {
    const seed = noEchoParameterValueSeed({ Short: { NoEcho: true } }, { Short: 'ab' });
    expect(seeded('ab', seed)).toEqual(['ab']);
    expect(seeded('x-ab-y', seed)).toBeUndefined();
  });

  it('seeds a Number and each element of a list, as a log line spells them', () => {
    const seed = noEchoParameterValueSeed(
      { Port: { NoEcho: true }, Hosts: { NoEcho: true } },
      { Port: 73915, Hosts: ['alpha-host', 'beta-host'] }
    );
    expect(seeded('exp-73915', seed)).toEqual(['73915']);
    expect(seeded('exp-beta-host', seed)).toEqual(['beta-host']);
  });

  it("seeds a nested child's parameter carrying a parent's NoEcho value, though the child declares no NoEcho", () => {
    const inherited: RecordedSecretValues = new Map();
    recordLogOnlyValue(inherited, 'parentNoEcho1');
    const seed = noEchoParameterValueSeed(
      { FromParent: { Type: 'String' } as { NoEcho?: unknown } },
      { FromParent: 'prefix-parentNoEcho1', Other: 'ordinary' },
      inherited
    );
    expect(seeded('exp-parentNoEcho1', seed)).toEqual(['parentNoEcho1']);
    // Only what a parameter CARRIES: an inherited needle no parameter holds
    // is not seeded.
    recordLogOnlyValue(inherited, 'unrelatedNeedle');
    const again = noEchoParameterValueSeed({}, { FromParent: 'prefix-parentNoEcho1' }, inherited);
    expect(seeded('exp-unrelatedNeedle', again)).toBeUndefined();
  });

  it('leaves out a value that is a whole {{resolve:...}} token, alone or as a list', () => {
    const seed = noEchoParameterValueSeed(
      { Tok: { NoEcho: true }, Toks: { NoEcho: true } },
      { Tok: '{{resolve:ssm:/p}}', Toks: ['{{resolve:ssm:/a}}', '{{resolve:ssm:/b}}'] }
    );
    expect(seeded('{{resolve:ssm:/p}}', seed)).toBeUndefined();
    expect(seeded('x-{{resolve:ssm:/a}}', seed)).toBeUndefined();
  });

  it('seeds the operator spelling of a coerced Number value, from the user value or else the Default', () => {
    const fromUser = noEchoParameterValueSeed(
      { Port: { NoEcho: true } },
      { Port: 7978 },
      undefined,
      { Port: '0x1F2A' }
    );
    expect(seeded('exp-0x1F2A', fromUser)).toEqual(['0x1F2A']);
    const fromDefault = noEchoParameterValueSeed(
      { Big: { NoEcho: true, Default: '1e10' } },
      { Big: 10000000000 }
    );
    expect(seeded('exp-1e10-x', fromDefault)).toEqual(['1e10']);
    // A user value wins over the Default.
    const both = noEchoParameterValueSeed(
      { Port: { NoEcho: true, Default: '0x0BAD' } },
      { Port: 7978 },
      undefined,
      { Port: '0x1F2A' }
    );
    expect(seeded('exp-0x0BAD', both)).toBeUndefined();
  });

  it('does not seed the SSM parameter NAME of an SSM-typed NoEcho parameter', () => {
    const seed = noEchoParameterValueSeed(
      { Pw: { NoEcho: true, Type: 'AWS::SSM::Parameter::Value<String>', Default: 'DbPassword' } },
      { Pw: 'lookedUpSecret1' }
    );
    expect(seeded('exp-DbPasswordArn', seed)).toBeUndefined();
    expect(seeded('exp-lookedUpSecret1', seed)).toEqual(['lookedUpSecret1']);
  });

  it('does not seed an operator-supplied SSM-typed value bound unresolved (it is still the SSM name)', () => {
    const seed = noEchoParameterValueSeed(
      { Pw: { NoEcho: true, Type: 'AWS::SSM::Parameter::Value<String>' } },
      { Pw: 'DbPassword' },
      undefined,
      { Pw: 'DbPassword' }
    );
    expect(seeded('exp-DbPasswordArn', seed)).toBeUndefined();
    // A non-SSM NoEcho value equal to its spelling is still seeded.
    const plain = noEchoParameterValueSeed(
      { Pw: { NoEcho: true, Type: 'String' } },
      { Pw: 'DbPassword' },
      undefined,
      { Pw: 'DbPassword' }
    );
    expect(seeded('exp-DbPasswordArn', plain)).toEqual(['DbPassword']);
  });

  it('seeds nothing when no parameter values are bound', () => {
    expect(seeded('anything', noEchoParameterValueSeed({ Hidden: { NoEcho: true } }, undefined))).toBeUndefined();
  });

  it('seeds the comma-joined form of a list value', () => {
    const seed = noEchoParameterValueSeed({ Hosts: { NoEcho: true } }, { Hosts: ['ab', 'cd'] });
    expect(seeded('x-ab,cd-y', seed)).toEqual(['ab,cd']);
  });

  it('masks a seeded value in the refusal warning', () => {
    const seed = noEchoParameterValueSeed({ Hidden: { NoEcho: true } }, { Hidden: 'hiddenValue1' });
    const exposure = exportNameSecretExposure('exp-hiddenValue1', new Map(), new Map(), seed)!;
    const message = secretBearingExportNameWarning('Echo', 'exp-hiddenValue1', exposure, new Map());
    expect(message).toContain(`(masked: "exp-${SECRET_MASK}")`);
    expect(message).not.toContain('hiddenValue1');
  });
});

// go-to-k/cdkd#4657: the POSITIONAL twin. An `Export.Name` intrinsic that READS
// a `NoEcho` parameter is refused from the template, at any value length: the
// containment arms above need a value of 4+ characters to see one embedded.
describe('DeployEngine - an Export.Name intrinsic reading a NoEcho parameter is refused at any length (go-to-k/cdkd#4657)', () => {
  async function deployedWith(
    secretValue: string,
    noEcho: boolean,
    outputs: Record<string, unknown>,
    options: { conditions?: Record<string, unknown>; extra?: Record<string, unknown> } = {}
  ) {
    const h = harness({ Secret: secretValue, ResourceOnly: RESOURCE_ONLY }, undefined, options.extra);
    const template = templateOf(noEcho, outputs, h.props);
    if (options.conditions) template.Conditions = options.conditions;
    await h.engine.deploy('s', template);
    const states = h.saveState.mock.calls.map((call) => call[2] as StackState);
    expect(states.length).toBeGreaterThan(0);
    const indexed = h.updateForStack.mock.calls.map((call) => call[2] as Record<string, unknown>);
    expect(indexed.length).toBeGreaterThan(0);
    return { states, last: states[states.length - 1]!, indexed, lines: logLines.join('\n') };
  }

  const shapes: Array<[string, unknown, string]> = [
    ['an Fn::Sub', { 'Fn::Sub': 'x-${Secret}-y' }, 'x-ab-y'],
    ['an Fn::Join', { 'Fn::Join': ['-', ['x', { Ref: 'Secret' }, 'y']] }, 'x-ab-y'],
    [
      'an Fn::Select over a list holding the Ref',
      { 'Fn::Join': ['', ['x-', { 'Fn::Select': [0, [{ Ref: 'Secret' }, 'b']] }, '-y']] },
      'x-ab-y',
    ],
    [
      'an Fn::Sub variable bound to the Ref',
      { 'Fn::Sub': ['x-${V}-y', { V: { Ref: 'Secret' } }] },
      'x-ab-y',
    ],
  ];

  for (const [label, name, published] of shapes) {
    it(`refuses ${label} embedding a 2-character NoEcho value, naming the output and the parameter`, async () => {
      const r = await deployedWith('ab', true, {
        Echo: { Value: 'v', Export: { Name: name } },
        ...INNOCENT,
      });
      for (const state of r.states) {
        expect(Object.keys(state.outputs)).not.toContain(published);
        expect(state.exportNames ?? []).not.toContain(published);
      }
      for (const index of r.indexed) expect(Object.keys(index)).not.toContain(published);
      // The output and the innocent sibling alias are still published.
      expect(r.last.outputs['Echo']).toBe('v');
      expect(r.last.exportNames).toEqual(['plain-export']);
      expect(r.indexed.some((index) => index['plain-export'] === 'w')).toBe(true);
      expect(r.lines).toContain(
        'Output Echo has an Export.Name that reads the NoEcho template parameter Secret — skipping the export alias'
      );
      // Never the resolved name, which holds the value. The refusal line
      // only: the resolver's own debug trace of a sub-floor value is the
      // print masker's documented MIN_NEEDLE_LENGTH bound, not this verdict's.
      const refusal = r.lines.split('\n').filter((line) => line.includes('reads the NoEcho'));
      expect(refusal).toHaveLength(1);
      expect(refusal[0]).not.toContain(published);
      expect(refusal[0]).not.toContain('ab-');
    });

    it(`publishes ${label} embedding the same value when the parameter is not NoEcho (negative control)`, async () => {
      const r = await deployedWith('ab', false, { Echo: { Value: 'v', Export: { Name: name } } });
      expect(r.last.outputs[published]).toBe('v');
      expect(r.last.exportNames).toEqual([published]);
    });
  }

  it('refuses a 4+ character value through the positional arm too, with the parameter-naming reason', async () => {
    const r = await deployedWith(NOECHO, true, {
      Echo: { Value: 'v', Export: { Name: { 'Fn::Join': ['-', ['x', { Ref: 'Secret' }]] } } },
      ...INNOCENT,
    });
    expect(r.last.exportNames).toEqual(['plain-export']);
    for (const state of r.states) expect(JSON.stringify(state)).not.toContain(NOECHO);
    expect(r.lines).toContain('reads the NoEcho template parameter Secret');
    expect(r.lines).not.toContain(NOECHO);
  });

  it('reads only the Fn::If branch the condition selected: a public branch publishes, the NoEcho branch is refused', async () => {
    const ifName = { 'Fn::If': ['UseSecret', { 'Fn::Sub': 'x-${Secret}-y' }, 'public-name'] };
    const off = await deployedWith(
      'ab',
      true,
      { Echo: { Value: 'v', Export: { Name: ifName } } },
      { conditions: { UseSecret: { 'Fn::Equals': ['a', 'b'] } } }
    );
    expect(off.last.exportNames).toEqual(['public-name']);
    expect(off.last.outputs['public-name']).toBe('v');
    logLines.length = 0;
    const on = await deployedWith(
      'ab',
      true,
      { Echo: { Value: 'v', Export: { Name: ifName } } },
      { conditions: { UseSecret: { 'Fn::Equals': ['a', 'a'] } } }
    );
    expect(on.last.exportNames).toEqual([]);
    expect(Object.keys(on.last.outputs)).not.toContain('x-ab-y');
    expect(on.lines).toContain('reads the NoEcho template parameter Secret');
  });

  it('leaves a LITERAL name to the containment arms (a literal reads no parameter)', async () => {
    // `x-ab-y` spelled literally beside a 2-character NoEcho value: under the
    // floor, so the containment scan publishes it, and the positional arm has
    // no intrinsic to read.
    const r = await deployedWith('ab', true, { Echo: { Value: 'v', Export: { Name: 'x-ab-y' } } });
    expect(r.last.exportNames).toEqual(['x-ab-y']);
  });

  it("refuses a nested child's name reading a parameter its parent fills from a NoEcho source", async () => {
    // The child declares `Secret` plain; the parent's row marked it.
    const r = await deployedWith(
      'ab',
      false,
      { Echo: { Value: 'v', Export: { Name: { 'Fn::Sub': 'x-${Secret}-y' } } }, ...INNOCENT },
      { extra: { passedNoEchoParameters: new Set(['Secret']) } }
    );
    expect(r.last.exportNames).toEqual(['plain-export']);
    expect(r.lines).toContain('reads the NoEcho template parameter Secret');
  });
});

describe('noEchoParameterExportNameWarning (go-to-k/cdkd#4657)', () => {
  it('names every parameter read and masks the output key against the corpus', () => {
    const pass: RecordedSecretValues = new Map();
    recordLogOnlyValue(pass, 'leakyKey77');
    const message = noEchoParameterExportNameWarning('Out-leakyKey77', ['A', 'B'], pass);
    expect(message).toContain('Output Out-*** has an Export.Name that reads the NoEcho template parameters A, B');
    expect(message).not.toContain('leakyKey77');
  });
});
