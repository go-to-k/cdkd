import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

// go-to-k/cdkd#4043, Phase A: an `Export.Name` that equals or embeds a
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
  }),
}));
vi.mock('p-limit', () => ({ default: vi.fn(() => <T>(fn: () => T) => fn()) }));

import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import {
  exportNameSecretExposure,
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
function harness(parameters: Record<string, string>) {
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
    { dryRun: false, parameters },
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
      expect(r.lines).toContain('Output Echo has an Export.Name that resolves to a value containing a secret');
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

  // Declaration ORDER: a name sees only the needles of the values and of the
  // names resolved BEFORE it (a residual, and the diff mirrors it).
  it('publishes an EARLIER literal name holding a value only a LATER name reads (a Phase B residual)', async () => {
    const r = await deployed(true, {
      First: { Value: 'a', Export: { Name: `lit-${NOECHO}` } },
      Second: { Value: 'b', Export: { Name: { Ref: 'Secret' } } },
    });
    expect(r.last.outputs[`lit-${NOECHO}`]).toBe('a');
    expect(r.last.exportNames).not.toContain(NOECHO);
  });

  it('refuses a LATER literal name holding a value an EARLIER name read', async () => {
    const r = await deployed(true, {
      First: { Value: 'b', Export: { Name: { Ref: 'Secret' } } },
      Second: { Value: 'a', Export: { Name: `lit-${NOECHO}` } },
    });
    expect(r.last.exportNames ?? []).toEqual([]);
    expect(JSON.stringify(r.last)).not.toContain(NOECHO);
  });

  it('publishes a LITERAL name holding a value only a RESOURCE reads (a Phase B residual)', async () => {
    const r = await deployed(true, {
      Echo: { Value: 'v', Export: { Name: `exp-${RESOURCE_ONLY}` } },
    });
    expect(r.last.outputs[`exp-${RESOURCE_ONLY}`]).toBe('v');
  });
});
