/**
 * go-to-k/cdkd#4043, Phase A, the PREVIEW half: `cdkd diff` previews the
 * outputs bag the deploy persists, so an export alias the deploy now refuses
 * (its name holds a `NoEcho` value the outputs pass read) must not preview as
 * an ADD, or `cdkd diff --fail` reports a phantom row on every run. Through
 * `computeStackDiff` with the real resolver, since the needles come from the
 * diff's own parameter binding.
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

import { computeStackDiff } from '../../../src/cli/commands/diff-recursive.js';
import { DiffCalculator } from '../../../src/analyzer/diff-calculator.js';
import { resolveTemplateOutputs } from '../../../src/analyzer/outputs-diff.js';
import {
  recordLogOnlyValue,
  type RecordedSecretValues,
} from '../../../src/deployment/secret-redaction.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { StackState } from '../../../src/types/state.js';
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

const NOECHO = 'noecho-export-5517';
const RESOURCE_ONLY = 'resource-only-8823';

function stateWith(outputs: Record<string, unknown>): StackState {
  return {
    stackName: 'S',
    region: 'us-east-1',
    resources: {
      A: {
        physicalId: 'pid',
        resourceType: 'AWS::SSM::Parameter',
        properties: { Value: RESOURCE_ONLY },
        attributes: {},
        dependencies: [],
      },
    },
    outputs,
    version: 6,
    lastModified: 0,
  };
}

function templateOf(
  outputs: Record<string, unknown>,
  noEcho = true
): CloudFormationTemplate {
  return {
    Parameters: {
      DbUser: { Type: 'String', NoEcho: noEcho, Default: NOECHO },
      ResourceOnly: { Type: 'String', NoEcho: true, Default: RESOURCE_ONLY },
    },
    Resources: {
      A: { Type: 'AWS::SSM::Parameter', Properties: { Value: { Ref: 'ResourceOnly' } } },
    },
    Outputs: outputs,
  } as unknown as CloudFormationTemplate;
}

async function outputChangesOf(state: StackState, template: CloudFormationTemplate) {
  const backend = {
    getState: async () => null,
    saveState: vi.fn(),
    putState: vi.fn(),
    deleteState: vi.fn(),
  } as unknown as S3StateBackend;
  const result = await computeStackDiff(
    state,
    template,
    'us-east-1',
    'S',
    backend,
    new DiffCalculator()
  );
  return result.outputChanges.map((c) => `${c.changeType} ${c.name}`);
}

const SUB_NAME = { 'Fn::Sub': 'app-${DbUser}' };

describe('cdkd diff previews the NoEcho export-name refusal (go-to-k/cdkd#4043)', () => {
  it('previews no ADD for an alias whose name embeds a NoEcho value', async () => {
    const template = templateOf({ Out: { Value: 'v', Export: { Name: SUB_NAME } } });
    expect(await outputChangesOf(stateWith({ Out: 'v' }), template)).toEqual([]);
  });

  it('previews the ADD when the parameter is not NoEcho (negative control)', async () => {
    const template = templateOf({ Out: { Value: 'v', Export: { Name: SUB_NAME } } }, false);
    expect(await outputChangesOf(stateWith({ Out: 'v' }), template)).toEqual([
      `ADD app-${NOECHO}`,
    ]);
  });

  it('refuses a LITERAL name equal to a value another output reads', async () => {
    const template = templateOf({
      Reader: { Value: { Ref: 'DbUser' } },
      Out: { Value: 'v', Export: { Name: NOECHO } },
    });
    expect(
      await outputChangesOf(stateWith({ Reader: NOECHO, Out: 'v' }), template)
    ).toEqual([]);
  });

  // Declaration ORDER, as the deploy decides it: each name sees the values'
  // needles and those of the names resolved before it
  // (`export-name-noecho-refusal-4043.test.ts` pins the deploy side).
  it('publishes an EARLIER literal name holding a value only a LATER name reads, as the deploy does', async () => {
    const template = templateOf({
      First: { Value: 'a', Export: { Name: `lit-${NOECHO}` } },
      Second: { Value: 'b', Export: { Name: SUB_NAME } },
    });
    expect(await outputChangesOf(stateWith({ First: 'a', Second: 'b' }), template)).toEqual([
      `ADD lit-${NOECHO}`,
    ]);
  });

  it('refuses a LATER literal name holding a value an EARLIER name read', async () => {
    const template = templateOf({
      First: { Value: 'b', Export: { Name: SUB_NAME } },
      Second: { Value: 'a', Export: { Name: `lit-${NOECHO}` } },
    });
    expect(await outputChangesOf(stateWith({ First: 'b', Second: 'a' }), template)).toEqual([]);
  });

  it('publishes a literal name holding a value only a RESOURCE reads, as the deploy does', async () => {
    // The diff's resource pass records every NoEcho value; the Outputs pass
    // must read its OWN bag, as the deploy's outputs pass does.
    const template = templateOf({ Out: { Value: 'v', Export: { Name: `exp-${RESOURCE_ONLY}` } } });
    expect(await outputChangesOf(stateWith({ Out: 'v' }), template)).toEqual([
      `ADD exp-${RESOURCE_ONLY}`,
    ]);
  });
});

/** `stateWith`, plus a resource `B` whose stored attribute echoes the value. */
function stateWithEcho(outputs: Record<string, unknown>): StackState {
  const state = stateWith(outputs);
  state.resources['B'] = {
    physicalId: 'pid-b',
    resourceType: 'AWS::SSM::Parameter',
    properties: { Value: 'b' },
    attributes: { Value: NOECHO },
    dependencies: [],
  };
  return state;
}

function echoTemplate(outputs: Record<string, unknown>): CloudFormationTemplate {
  const template = templateOf(outputs);
  template.Resources['B'] = { Type: 'AWS::SSM::Parameter', Properties: { Value: 'b' } };
  return template;
}

describe("the Outputs pass's resolver lines stay masked (go-to-k/cdkd#4043 review)", () => {
  it('masks an Outputs-pass debug line reading a stored copy through Fn::GetAtt', async () => {
    vi.mocked(getLogger().debug).mockClear();
    await outputChangesOf(
      stateWithEcho({ O: 'previous' }),
      echoTemplate({ O: { Value: { 'Fn::GetAtt': ['B', 'Value'] } } })
    );
    const logged = loggedText();
    // Premise: the resolver printed the GetAtt line, so its masking is tested.
    expect(logged).toContain('B.Value resolved to ***');
    expect(logged).not.toContain(NOECHO);
  });

  it("refuses a name that is the Fn::Base64 of an echoed attribute once an output value read the value, as the deploy does", async () => {
    vi.mocked(getLogger().debug).mockClear();
    const encoded = Buffer.from(NOECHO).toString('base64');
    const changes = await outputChangesOf(
      stateWithEcho({ A: NOECHO, O: 'v' }),
      echoTemplate({
        A: { Value: { Ref: 'DbUser' } },
        O: { Value: 'v', Export: { Name: { 'Fn::Base64': { 'Fn::GetAtt': ['B', 'Value'] } } } },
      })
    );
    expect(changes).toEqual([]);
    expect(loggedText()).not.toContain(encoded);
  });

  it('masks an output value that is the Fn::Base64 of an echoed attribute no output read by Ref', async () => {
    // The pass bag holds no needle for it (the deploy records none either),
    // so only the print-only corpus can record the encoding for printing.
    vi.mocked(getLogger().debug).mockClear();
    const encoded = Buffer.from(NOECHO).toString('base64');
    const backend = { getState: async () => null } as unknown as S3StateBackend;
    const result = await computeStackDiff(
      stateWithEcho({ O: 'previous' }),
      echoTemplate({ O: { Value: { 'Fn::Base64': { 'Fn::GetAtt': ['B', 'Value'] } } } }),
      'us-east-1',
      'S',
      backend,
      new DiffCalculator()
    );
    expect(result.outputChanges.map((c) => `${c.changeType} ${c.name}`)).toEqual(['MODIFY O']);
    expect(JSON.stringify(result.outputChanges)).not.toContain(encoded);
    expect(loggedText()).not.toContain(encoded);
  });

  it('masks the owner key of a refused alias in its debug line', async () => {
    vi.mocked(getLogger().debug).mockClear();
    const tok = 'AliasTok5517xyz';
    const key = `Out${tok}`;
    const template = {
      Parameters: { Tok: { Type: 'String', NoEcho: true, Default: tok } },
      Resources: { A: { Type: 'AWS::SSM::Parameter', Properties: { Value: 'x' } } },
      Outputs: { [key]: { Value: 'v', Export: { Name: { 'Fn::Sub': 'app-${Tok}' } } } },
    } as unknown as CloudFormationTemplate;
    expect(await outputChangesOf(stateWith({ [key]: 'v' }), template)).toEqual([]);
    const logged = loggedText();
    expect(logged).toContain('Diff skipping export alias of');
    expect(logged).not.toContain(tok);
  });

  it('refuses one alias and still publishes its innocent sibling', async () => {
    const template = templateOf({
      Out: { Value: 'v', Export: { Name: SUB_NAME } },
      Innocent: { Value: 'w', Export: { Name: 'plain-export' } },
    });
    expect(await outputChangesOf(stateWith({ Out: 'v', Innocent: 'w' }), template)).toEqual([
      'ADD plain-export',
    ]);
  });
});

describe("the Outputs pass's own bag still masks what it prints (go-to-k/cdkd#4043)", () => {
  it('masks an output value encoding the NoEcho value (Fn::Base64), which only that bag records', async () => {
    const encoded = Buffer.from(NOECHO).toString('base64');
    const backend = { getState: async () => null } as unknown as S3StateBackend;
    const result = await computeStackDiff(
      stateWith({ Out: 'previous' }),
      templateOf({ Out: { Value: { 'Fn::Base64': { Ref: 'DbUser' } } } }),
      'us-east-1',
      'S',
      backend,
      new DiffCalculator()
    );
    // Premise: the row exists, so its masking is what is tested.
    expect(result.outputChanges.map((c) => `${c.changeType} ${c.name}`)).toEqual(['MODIFY Out']);
    expect(JSON.stringify(result.outputChanges)).not.toContain(encoded);
  });
});

describe("an Export.Name's own bag feeds the printing masker (go-to-k/cdkd#4043)", () => {
  it('masks a stored alias REMOVE row named by an encoding only the name resolution records', async () => {
    const encoded = Buffer.from(NOECHO).toString('base64');
    const backend = { getState: async () => null } as unknown as S3StateBackend;
    const result = await computeStackDiff(
      stateWith({ Out: 'v', [encoded]: 'v' }),
      templateOf({ Out: { Value: 'v', Export: { Name: { 'Fn::Base64': { Ref: 'DbUser' } } } } }),
      'us-east-1',
      'S',
      backend,
      new DiffCalculator()
    );
    // Premise: the refused alias's stored key is previewed as removed.
    expect(result.outputChanges.map((c) => c.changeType)).toEqual(['REMOVE']);
    // `name` stays the stored key; what the renderers print is `nameDisplay`.
    expect(result.outputChanges[0]!.nameDisplay).toEqual({ kind: 'masked', text: '***' });
  });
});

describe('resolveTemplateOutputs - the outputsPass bag (go-to-k/cdkd#4043)', () => {
  const template = {
    Outputs: { Out: { Value: 'v', Export: { Name: `exp-${NOECHO}` } } },
  } as unknown as CloudFormationTemplate;
  const identity = async (value: unknown): Promise<unknown> => value;

  it('refuses the alias when the pass bag holds the value as a log-only needle', async () => {
    const secrets: RecordedSecretValues = new Map();
    recordLogOnlyValue(secrets, NOECHO);
    const resolved = await resolveTemplateOutputs(template, identity, undefined, {}, undefined, {
      resolveInto: () => identity,
      secrets,
    });
    expect(Object.keys(resolved.outputs)).toEqual(['Out']);
    expect([...resolved.exportNames]).toEqual([]);
  });

  it("counts a #2740-skipped output's needles, as the deploy's value pass resolves it", async () => {
    const secrets: RecordedSecretValues = new Map();
    const skippedValue = { Ref: 'DbUser' };
    const withSkipped = {
      Outputs: {
        Skipped: { Value: skippedValue },
        Out: { Value: 'v', Export: { Name: `exp-${NOECHO}` } },
      },
    } as unknown as CloudFormationTemplate;
    const resolveInto =
      (bag: RecordedSecretValues) =>
      async (value: unknown): Promise<unknown> => {
        if (JSON.stringify(value) === JSON.stringify(skippedValue)) {
          recordLogOnlyValue(bag, NOECHO);
          return NOECHO;
        }
        return value;
      };
    const resolved = await resolveTemplateOutputs(
      withSkipped,
      identity,
      undefined,
      {},
      new Set(['Skipped']),
      { resolveInto, secrets }
    );
    expect(Object.keys(resolved.outputs)).toEqual(['Out']);
    expect([...resolved.exportNames]).toEqual([]);
  });

  it("decides a later literal name against an earlier name's MAP entries (forwarded into the pass)", async () => {
    const secrets: RecordedSecretValues = new Map();
    const namingValue = { 'Fn::Join': ['', ['n-', 'mapsecret']] };
    const withMapName = {
      Outputs: {
        First: { Value: 'a', Export: { Name: namingValue } },
        Second: { Value: 'b', Export: { Name: 'lit-mapsecret-x' } },
      },
    } as unknown as CloudFormationTemplate;
    const resolveInto =
      (bag: RecordedSecretValues) =>
      async (value: unknown): Promise<unknown> => {
        if (JSON.stringify(value) === JSON.stringify(namingValue)) {
          bag.set('mapsecret', '{{resolve:secretsmanager:S}}');
          return 'n-mapsecret';
        }
        return value;
      };
    const resolved = await resolveTemplateOutputs(withMapName, identity, undefined, {}, undefined, {
      resolveInto,
      secrets,
    });
    expect([...resolved.exportNames]).toEqual([]);
  });

  it('publishes it without an outputsPass', async () => {
    const resolved = await resolveTemplateOutputs(template, identity, undefined, {});
    expect([...resolved.exportNames]).toEqual([`exp-${NOECHO}`]);
  });
});
