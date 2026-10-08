import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

// go-to-k/cdkd#4657: the no-change merge CARRIES a failed output's literal
// export alias from state (go-to-k/cdkd#2771). It now re-runs the alias pass's
// export-name verdict over that name first, so an alias an earlier binary
// published over a value today's verdict refuses (a `NoEcho` parameter's) is
// dropped rather than republished. With the REAL resolver, so the verdict's
// corpora (the pass map, its log-only set, the `NoEcho` seed) are the ones a
// deploy builds.
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
vi.mock('../../../src/utils/aws-clients.js', async (importOriginal) =>
  (await import('./_inert-cloudformation-client.js')).withInertCloudFormationClient(importOriginal)
);
vi.mock('p-limit', () => ({ default: vi.fn(() => <T>(fn: () => T) => fn()) }));

import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import { STATE_SCHEMA_VERSION_CURRENT } from '../../../src/types/state.js';
import type { CloudFormationTemplate, TemplateOutput } from '../../../src/types/resource.js';
import type { ResourceChange, StackState } from '../../../src/types/state.js';

const NOECHO = 'hunter2CarriedAlias';
const LEAKY_ALIAS = `exp-${NOECHO}`;
// A value no output reads: an `Fn::GetAtt` of a resource the template lacks.
const FAILS = { 'Fn::GetAtt': ['Missing', 'Arn'] };

function previousState(outputs: Record<string, unknown>, exportNames: string[]): StackState {
  return {
    version: STATE_SCHEMA_VERSION_CURRENT,
    region: 'us-east-1',
    stackName: 's',
    resources: {
      R: {
        physicalId: '/app/param',
        resourceType: 'AWS::SSM::Parameter',
        properties: { Name: '/app/param', Type: 'String', Value: 'x' },
        observedProperties: { Name: '/app/param', Type: 'String', Value: 'x' },
        attributes: {},
        dependencies: [],
      },
    },
    outputs,
    exportNames,
    lastModified: 0,
  };
}

function harness(state: StackState) {
  const provider = {
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    getAttribute: vi.fn(),
    readCurrentState: vi.fn().mockResolvedValue(undefined),
  };
  const saveState = vi.fn().mockResolvedValue('etag');
  const updateForStack = vi.fn().mockResolvedValue(undefined);
  const diff = {
    calculateDiff: vi.fn().mockResolvedValue(
      new Map<string, ResourceChange>([
        ['R', { logicalId: 'R', changeType: 'NO_CHANGE', resourceType: 'AWS::SSM::Parameter' }],
      ])
    ),
    hasChanges: vi.fn().mockReturnValue(false),
    filterByType: vi
      .fn()
      .mockImplementation((c: Map<string, ResourceChange>, t: string) =>
        [...c.values()].filter((x) => x.changeType === t)
      ),
  };
  const engine = new DeployEngine(
    {
      getState: vi.fn().mockResolvedValue({ state, etag: 'etag-old' }),
      saveState,
      loadRollbackJournal: vi.fn().mockResolvedValue(null),
      appendRollbackJournalSegment: vi.fn(),
      popRollbackJournalSegment: vi.fn(),
      deleteRollbackJournal: vi.fn(),
    } as never,
    { acquireLockWithRetry: vi.fn().mockResolvedValue(true), releaseLock: vi.fn() } as never,
    {
      buildGraph: vi.fn().mockReturnValue({}),
      getExecutionLevels: vi.fn().mockReturnValue([]),
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
    { dryRun: false, parameters: { Secret: NOECHO } },
    'us-east-1',
    { updateForStack } as never
  );
  return { engine, saveState, updateForStack };
}

function templateOf(noEcho: boolean, outputs: Record<string, unknown>): CloudFormationTemplate {
  return {
    Parameters: { Secret: { Type: 'String', NoEcho: noEcho } },
    Resources: {
      R: {
        Type: 'AWS::SSM::Parameter',
        Properties: { Name: '/app/param', Type: 'String', Value: 'x' },
      },
    },
    Outputs: outputs as unknown as Record<string, TemplateOutput>,
  };
}

const OUTPUTS = {
  // Both fail this pass, so both carry their stored value and literal alias.
  Leaky: { Value: FAILS, Export: { Name: LEAKY_ALIAS } },
  Plain: { Value: FAILS, Export: { Name: 'plain-carried' } },
  Fresh: { Value: 'fresh' },
};

const PREVIOUS = previousState(
  { Leaky: 'v', [LEAKY_ALIAS]: 'v', Plain: 'p', 'plain-carried': 'p' },
  [LEAKY_ALIAS, 'plain-carried']
);

async function deployed(noEcho: boolean) {
  const h = harness(structuredClone(PREVIOUS));
  await h.engine.deploy('s', templateOf(noEcho, OUTPUTS));
  const states = h.saveState.mock.calls.map((call) => call[2] as StackState);
  expect(states).toHaveLength(1);
  const indexed = h.updateForStack.mock.calls.map((call) => call[2] as Record<string, unknown>);
  expect(indexed).toHaveLength(1);
  return { saved: states[0]!, index: indexed[0]!, lines: logLines.join('\n') };
}

beforeEach(() => {
  logLines.length = 0;
});

describe('the no-change merge re-decides a carried export alias (go-to-k/cdkd#4657)', () => {
  it('drops a carried alias holding a NoEcho value, keeps the output and the innocent carried alias', async () => {
    const r = await deployed(true);
    // The merge ran: the fresh output landed beside the carried ones.
    expect(r.saved.outputs['Fresh']).toBe('fresh');
    expect(r.saved.outputs['Leaky']).toBe('v');
    expect(r.saved.outputs['plain-carried']).toBe('p');
    expect(Object.keys(r.saved.outputs)).not.toContain(LEAKY_ALIAS);
    expect(r.saved.exportNames).toEqual(['plain-carried']);
    expect(r.index).toEqual({ 'plain-carried': 'p' });
    expect(JSON.stringify(r.saved)).not.toContain(NOECHO);
    expect(r.lines).toContain(
      'Output Leaky has an Export.Name that resolves to a value containing a secret (masked: "exp-***")'
    );
    expect(r.lines).not.toContain(NOECHO);
  });

  it('carries the same alias when the parameter is not NoEcho (negative control)', async () => {
    const r = await deployed(false);
    expect(r.saved.outputs[LEAKY_ALIAS]).toBe('v');
    expect([...(r.saved.exportNames ?? [])].sort()).toEqual([LEAKY_ALIAS, 'plain-carried'].sort());
    expect(r.index).toEqual({ [LEAKY_ALIAS]: 'v', 'plain-carried': 'p' });
  });
});

// go-to-k/cdkd#4657 review: a merge that KEEPS the previous bag whole carries
// its aliases unchecked, so the deploy names the outputs whose earlier alias
// today's verdict refuses, in one warning that never prints the alias.
describe('a kept-whole no-change bag names the outputs whose alias today refuses (go-to-k/cdkd#4657)', () => {
  const LIT_ALIAS = `lit-${NOECHO}`;
  const KEPT_OUTPUTS = {
    // An INTRINSIC name on a failed output with a stored value: the merge
    // keeps the whole bag (`intrinsic-export-name`).
    Leaky: { Value: FAILS, Export: { Name: { 'Fn::Sub': 'exp-${Secret}' } } },
    // A LITERAL name the previous record published, spelling the value.
    Lit: { Value: 'lit', Export: { Name: LIT_ALIAS } },
    Plain: { Value: 'p', Export: { Name: 'plain-export' } },
  };
  const KEPT_PREVIOUS = previousState(
    { Leaky: 'v', [LEAKY_ALIAS]: 'v', Lit: 'lit', [LIT_ALIAS]: 'lit', Plain: 'p', 'plain-export': 'p' },
    [LEAKY_ALIAS, LIT_ALIAS, 'plain-export']
  );

  async function keptDeploy(noEcho: boolean) {
    const h = harness(structuredClone(KEPT_PREVIOUS));
    await h.engine.deploy('s', templateOf(noEcho, KEPT_OUTPUTS));
    const lines = logLines.join('\n');
    return lines.split('\n').filter((line) => line.includes('Keeping the previously persisted outputs whole'));
  }

  it('warns once, naming both outputs and neither alias', async () => {
    const warned = await keptDeploy(true);
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain('of output(s) Leaky, Lit that holds a NoEcho parameter');
    expect(warned[0]).not.toContain(NOECHO);
    expect(warned[0]).not.toContain('Plain');
  });

  it('says nothing when the parameter is not NoEcho (negative control)', async () => {
    expect(await keptDeploy(false)).toEqual([]);
  });
});
