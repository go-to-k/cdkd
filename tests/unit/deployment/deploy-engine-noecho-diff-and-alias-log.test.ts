import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

// go-to-k/cdkd#4049, the ENGINE half, with the REAL resolver and the REAL diff
// calculator: a `Ref` to a `NoEcho: true` parameter serving a create-only
// property is masked on the diff's `requires replacement` debug line, an
// `Export.Name` built from one is masked on the refusal warning, and the
// state the deploy PERSISTS is byte-identical to the same deploy without
// `NoEcho`.
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
vi.mock('../../../src/provisioning/create-only-properties.js', async () => {
  const actual = await vi.importActual<
    typeof import('../../../src/provisioning/create-only-properties.js')
  >('../../../src/provisioning/create-only-properties.js');
  return { ...actual, getCreateOnlyPropertyPaths: vi.fn().mockResolvedValue([]) };
});
vi.mock('../../../src/provisioning/write-only-properties.js', async () => {
  const actual = await vi.importActual<
    typeof import('../../../src/provisioning/write-only-properties.js')
  >('../../../src/provisioning/write-only-properties.js');
  return { ...actual, tryGetTopLevelWriteOnlyProperties: vi.fn().mockResolvedValue([]) };
});
vi.mock('p-limit', () => ({ default: vi.fn(() => <T>(fn: () => T) => fn()) }));

import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import { DiffCalculator } from '../../../src/analyzer/diff-calculator.js';
import { IntrinsicFunctionResolver } from '../../../src/deployment/intrinsic-function-resolver.js';
import {
  SECRET_MASK,
  printingCorpusOf,
  recordLogOnlyParameterValue,
  recordLogOnlyValue,
  type RecordedSecretValues,
} from '../../../src/deployment/secret-redaction.js';
import type { CloudFormationTemplate, TemplateOutput } from '../../../src/types/resource.js';
import type { StackState } from '../../../src/types/state.js';

// Alphanumeric: it is also spelled as an OUTPUT KEY below.
const NOECHO = 'Hunter2NoEchoValue';
const PREVIOUS = 'previous-parameter-name';

const OUTPUTS = {
  [NOECHO]: { Value: 'owner-value' },
  // Its `Export.Name` resolves to the NoEcho value, which is also the key of
  // the output above: the collision arm.
  Echo: { Value: 'echo-value', Export: { Name: { Ref: 'Secret' } } },
} as unknown as Record<string, TemplateOutput>;

function templateOf(noEcho: boolean): CloudFormationTemplate {
  return {
    Parameters: { Secret: { Type: 'String', NoEcho: noEcho } },
    Resources: {
      R: {
        Type: 'AWS::SSM::Parameter',
        Properties: { Name: { Ref: 'Secret' }, Type: 'String', Value: 'v' },
      },
    },
    Outputs: OUTPUTS,
  };
}

function currentState(): StackState {
  return {
    version: 10,
    stackName: 's',
    region: 'us-east-1',
    resources: {
      R: {
        physicalId: PREVIOUS,
        resourceType: 'AWS::SSM::Parameter',
        properties: { Name: PREVIOUS, Type: 'String', Value: 'v' },
        attributes: {},
        dependencies: [],
      },
    },
    outputs: {},
    lastModified: 0,
  } as StackState;
}

function harness(extraOptions: Record<string, unknown> = {}, state: StackState = currentState()) {
  const provider = {
    create: vi.fn().mockResolvedValue({ physicalId: NOECHO }),
    update: vi.fn(),
    delete: vi.fn().mockResolvedValue(undefined),
    getAttribute: vi.fn(),
    readCurrentState: vi.fn().mockResolvedValue(undefined),
  };
  const saveState = vi.fn().mockResolvedValue('etag');
  const engine = new DeployEngine(
    {
      getState: vi.fn().mockResolvedValue({ state, etag: 'e0' }),
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
    new DiffCalculator(),
    {
      getProvider: vi.fn().mockReturnValue(provider),
      getProviderFor: vi.fn().mockReturnValue({ provider, provisionedBy: 'sdk' }),
      getRegisteredTypes: vi.fn().mockReturnValue([]),
      validateResourceTypes: vi.fn(),
      validateResourceProperties: vi.fn(),
    } as never,
    {
      dryRun: false,
      forceStatefulRecreation: true,
      parameters: { Secret: NOECHO },
      ...extraOptions,
    },
    'us-east-1'
  );
  return { engine, provider, saveState };
}

beforeEach(() => {
  logLines.length = 0;
});

describe('DeployEngine - the diff and alias print surfaces mask a NoEcho value (go-to-k/cdkd#4049)', () => {
  it('masks the replacement debug line and the export-alias refusal warning', async () => {
    const h = harness();
    await h.engine.deploy('s', templateOf(true));
    const lines = logLines.join('\n');
    // Premise: both lines were printed, so their masking is what is tested.
    // Since go-to-k/cdkd#4043 the diff compares what state stores: the new
    // side is the mask, and the record's pre-v11 plaintext, which differs, is
    // shown as the witness placeholder rather than as the old value.
    expect(lines).toContain(
      `Property Name of AWS::SSM::Parameter requires replacement (from "(previous NoEcho value)" to "${SECRET_MASK}")`
    );
    // The name reads the NoEcho parameter, so the positional refusal fires
    // (go-to-k/cdkd#4657) before the collision arm could (go-to-k/cdkd#4043).
    expect(lines).toContain(
      'Output Echo has an Export.Name that reads the NoEcho template parameter Secret'
    );
    expect(lines).not.toContain('which is also the name of another output');
    // The value AWS receives is the real one.
    expect((h.provider.create.mock.calls[0]![2] as Record<string, unknown>)['Name']).toBe(NOECHO);
    expect(lines).not.toContain(NOECHO);
  });

  it("masks the replacement line with a nested child's inherited bag", async () => {
    // A CDK-synthesized child parameter never says NoEcho; only the parent's
    // bag knows the value.
    const inherited: RecordedSecretValues = new Map();
    recordLogOnlyValue(inherited, NOECHO);
    const h = harness({
      inheritedSecrets: inherited,
      parentStackInfo: { parentStack: 'P', parentLogicalId: 'C', parentRegion: 'us-east-1' },
    });
    await h.engine.deploy('s', { ...templateOf(false), Outputs: {} });
    const line = logLines.find((l) => l.includes('requires replacement ('));
    expect(line).toBe(
      `Property Name of AWS::SSM::Parameter requires replacement (from ${SECRET_MASK} to "${SECRET_MASK}")`
    );
    expect(logLines.join('\n')).not.toContain(NOECHO);
  });

  it("masks an old side only the nested child's inherited bag knows", async () => {
    // The new side is a literal, so the diff pass resolves no parameter and
    // its own bag stays empty: only the inherited bag can mask the value the
    // state record still holds.
    const inherited: RecordedSecretValues = new Map();
    recordLogOnlyValue(inherited, NOECHO);
    const state = currentState();
    state.resources['R']!.properties = { Name: NOECHO, Type: 'String', Value: 'v' };
    const h = harness(
      {
        inheritedSecrets: inherited,
        parentStackInfo: { parentStack: 'P', parentLogicalId: 'C', parentRegion: 'us-east-1' },
      },
      state
    );
    await h.engine.deploy('s', {
      Resources: {
        R: {
          Type: 'AWS::SSM::Parameter',
          Properties: { Name: 'literal-name', Type: 'String', Value: 'v' },
        },
      },
    });
    const line = logLines.find((l) => l.includes('requires replacement ('));
    expect(line).toBe(
      `Property Name of AWS::SSM::Parameter requires replacement (from "${SECRET_MASK}" to "literal-name")`
    );
  });
});

describe('DeployEngine - the replacement line knows every NoEcho value up front (go-to-k/cdkd#4049)', () => {
  it('masks an old side no resource of the diff pass references any more', async () => {
    // The property STOPPED reading the parameter and nothing else reads it,
    // so the diff pass never records the value: only the up-front record of
    // every NoEcho parameter's value can mask the state's old side.
    const state = currentState();
    state.resources['R']!.properties = { Name: NOECHO, Type: 'String', Value: 'v' };
    const h = harness({}, state);
    await h.engine.deploy('s', {
      Parameters: { Secret: { Type: 'String', NoEcho: true } },
      Resources: {
        R: {
          Type: 'AWS::SSM::Parameter',
          Properties: { Name: 'literal-name', Type: 'String', Value: 'v' },
        },
      },
    });
    const line = logLines.find((l) => l.includes('requires replacement ('));
    expect(line).toBe(
      `Property Name of AWS::SSM::Parameter requires replacement (from "${SECRET_MASK}" to "literal-name")`
    );
  });

  it('masks a longer NoEcho value whole when a shorter one inside it is already a needle', async () => {
    // `Short` is in the diff bag (R's Value reads it) and `Long`, which embeds
    // it, only in the up-front bag: masked one bag at a time, the shorter
    // needle cut the longer one and its remainder printed.
    const SHORT = 'abcd1234';
    const LONG = `XXsecretYY-${SHORT}-ZZtail`;
    const state = currentState();
    state.resources['R']!.properties = { Name: LONG, Type: 'String', Value: SHORT };
    const h = harness({ parameters: { Short: SHORT, Long: LONG } }, state);
    await h.engine.deploy('s', {
      Parameters: {
        Short: { Type: 'String', NoEcho: true },
        Long: { Type: 'String', NoEcho: true },
      },
      Resources: {
        R: {
          Type: 'AWS::SSM::Parameter',
          Properties: { Name: 'literal-name', Type: 'String', Value: { Ref: 'Short' } },
        },
      },
    });
    const line = logLines.find((l) => l.includes('requires replacement ('));
    expect(line).toBe(
      `Property Name of AWS::SSM::Parameter requires replacement (from "${SECRET_MASK}" to "literal-name")`
    );
  });

  it('prints the old side when the parameter is not NoEcho (negative control)', async () => {
    const state = currentState();
    state.resources['R']!.properties = { Name: NOECHO, Type: 'String', Value: 'v' };
    const h = harness({}, state);
    await h.engine.deploy('s', {
      Parameters: { Secret: { Type: 'String' } },
      Resources: {
        R: {
          Type: 'AWS::SSM::Parameter',
          Properties: { Name: 'literal-name', Type: 'String', Value: 'v' },
        },
      },
    });
    const line = logLines.find((l) => l.includes('requires replacement ('));
    expect(line).toBe(
      `Property Name of AWS::SSM::Parameter requires replacement (from "${NOECHO}" to "literal-name")`
    );
  });

  it("records the same spellings as the resolver's Ref recording", async () => {
    // The resolver's `recordNoEchoParameterValue` delegates to
    // `recordLogOnlyParameterValue`, the one spelling rule the up-front record
    // uses too; this pins that the two paths record the same needles,
    // degenerate values included.
    for (const value of [
      'plain-noecho-value',
      7391,
      true,
      ['alpha', 'beta', 42],
      [],
      '',
      null,
      [['nested-one', 'nested-two'], 'outer-three'],
    ]) {
      const viaResolver: RecordedSecretValues = new Map();
      await new IntrinsicFunctionResolver().resolve(
        { Ref: 'Secret' },
        {
          template: {
            Parameters: { Secret: { Type: 'String', NoEcho: true } },
            Resources: {},
          },
          resources: {},
          parameters: { Secret: value },
          recordedSecretValues: viaResolver,
        }
      );
      const viaHelper: RecordedSecretValues = new Map();
      recordLogOnlyParameterValue(viaHelper, value);
      const needles = (bag: RecordedSecretValues): string[] => [...printingCorpusOf(bag).keys()].sort();
      // Every spelling the up-front record prints, the resolver prints too.
      const fromResolver = needles(viaResolver);
      for (const needle of needles(viaHelper)) expect(fromResolver).toContain(needle);
      // Since go-to-k/cdkd#4043 the resolver ALSO registers each string leaf as
      // a mask-only map entry (the value arm); any extra needle is one of those.
      for (const needle of fromResolver) {
        if (!needles(viaHelper).includes(needle)) expect(viaResolver.get(needle)).toBe(SECRET_MASK);
      }
    }
  });
});

describe('DeployEngine - the diff pass bag feeds the replacement line (go-to-k/cdkd#4049)', () => {
  it('masks a derived needle only the diff pass records (Fn::Base64 of a NoEcho value)', async () => {
    // The resolver records `Fn::Base64` of a NoEcho value as a log-only needle
    // of the bag it resolves with; the up-front parameter record cannot know
    // it. So only the diff bag, read BY REFERENCE as the diff fills it, masks
    // the new side here.
    const encoded = Buffer.from(NOECHO).toString('base64');
    const h = harness();
    await h.engine.deploy('s', {
      Parameters: { Secret: { Type: 'String', NoEcho: true } },
      Resources: {
        R: {
          Type: 'AWS::SSM::Parameter',
          Properties: { Name: { 'Fn::Base64': { Ref: 'Secret' } }, Type: 'String', Value: 'v' },
        },
      },
    });
    const line = logLines.find((l) => l.includes('requires replacement ('));
    // go-to-k/cdkd#4043: compared as state stores it (the mask), with the
    // differing pre-v11 witness shown as the placeholder.
    expect(line).toBe(
      `Property Name of AWS::SSM::Parameter requires replacement (from "(previous NoEcho value)" to "${SECRET_MASK}")`
    );
    expect(line).not.toContain(encoded);
    expect(line).not.toContain(NOECHO);
  });
});

describe('DeployEngine - an output resolution failure is masked in one pass (go-to-k/cdkd#4049)', () => {
  const SHORT = 'abcd1234';
  const LONG = `XXsecretYY-${SHORT}-ZZtail`;

  async function failOutput(strictGetAtt: boolean): Promise<string> {
    // The inherited bag holds the SHORTER needle, the pass bag the longer one
    // that embeds it: masked bag by bag (inherited first), the short needle
    // cut the long one and the rest of it printed.
    const inherited: RecordedSecretValues = new Map();
    recordLogOnlyValue(inherited, SHORT);
    const h = harness({
      inheritedSecrets: inherited,
      strictGetAtt,
      parentStackInfo: { parentStack: 'P', parentLogicalId: 'C', parentRegion: 'us-east-1' },
    });
    const outputs = { Out: { Value: { 'Fn::GetAtt': ['R', 'Missing'] } } } as unknown as Record<
      string,
      TemplateOutput
    >;
    type Resolve = (
      value: unknown,
      ctx: { recordedSecretValues?: RecordedSecretValues }
    ) => Promise<unknown>;
    const resolver = (h.engine as unknown as { resolver: { resolve: Resolve } }).resolver;
    const real = resolver.resolve.bind(resolver);
    resolver.resolve = vi.fn<Resolve>(async (value, ctx) => {
      if (value === outputs['Out']!.Value) {
        recordLogOnlyValue(ctx.recordedSecretValues!, LONG);
        throw new Error(`could not read ${LONG} here`);
      }
      return real(value, ctx);
    });
    let thrown = '';
    try {
      await h.engine.deploy('s', { ...templateOf(false), Outputs: outputs });
    } catch (error) {
      const chain: string[] = [];
      for (let e: unknown = error; e instanceof Error; e = (e as { cause?: unknown }).cause) {
        chain.push(e.message);
      }
      thrown = chain.join('\n');
    }
    return `${logLines.join('\n')}\n${thrown}`;
  }

  it.each([
    ['the warn arm', false],
    ['the --strict-getatt arm', true],
  ])('masks the longer value whole on %s', async (_label, strict) => {
    const text = await failOutput(strict);
    // Premise: the failure was reported.
    expect(text).toContain(`could not read ${SECRET_MASK} here`);
    expect(text).not.toContain('XXsecretYY');
    expect(text).not.toContain('ZZtail');
  });
});

describe('DeployEngine - NoEcho persists as the mask (go-to-k/cdkd#4043, schema v11)', () => {
  it('saves *** where the NoEcho parameter served the record, and the clear value without NoEcho', async () => {
    const saved = async (noEcho: boolean): Promise<string> => {
      const h = harness();
      await h.engine.deploy('s', templateOf(noEcho));
      expect(h.saveState).toHaveBeenCalled();
      return JSON.stringify(
        h.saveState.mock.calls.map((call) => {
          const state = { ...(call[2] as StackState) };
          delete (state as { lastModified?: unknown }).lastModified;
          return state;
        })
      );
    };
    const withNoEcho = await saved(true);
    const noEchoLines = logLines.join('\n');
    logLines.length = 0;
    const without = await saved(false);
    // Negative control: without NoEcho the value is persisted and logged in
    // the clear, so the masked half below is not vacuous.
    expect(without).toContain(`"Name":"${NOECHO}"`);
    expect(logLines.join('\n')).toContain(NOECHO);
    // With NoEcho the property persists `***` and names its coordinate. Two
    // spellings stay by design: the physical id (AWS publishes a resource's
    // name) and a LITERAL output key the template itself spells.
    expect(withNoEcho).not.toContain(`"Name":"${NOECHO}"`);
    expect(withNoEcho).toContain('"Name":"***"');
    expect(withNoEcho).toContain('"noEchoLeaves":[["Name"]]');
    expect(withNoEcho).toContain(`"${NOECHO}":"owner-value"`);
    expect(noEchoLines).not.toContain(NOECHO);
    expect(withNoEcho).not.toBe(without);
  });
});
