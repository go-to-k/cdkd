/**
 * go-to-k/cdkd#6274: a record of an un-named SSM parameter created before
 * go-to-k/cdkd#6272 holds `/<generated name>`, so its Ref still made CDK's
 * grantRead / grantWrite ARN `parameter//<name>`. The deploy (and `cdkd diff`)
 * re-spells exactly that shape as `<name>` -- the same parameter in SSM -- so
 * the dependents holding the old Ref update in the same deploy.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { healSlashedSsmParameterNames } from '../../../src/deployment/ssm-slashed-name-heal.js';
import { generatedNameFor, withStackScope } from '../../../src/provisioning/resource-name.js';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import { DiffCalculator } from '../../../src/analyzer/diff-calculator.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { ResourceState, StackState } from '../../../src/types/state.js';
import { STATE_SCHEMA_VERSION_CURRENT } from '../../../src/types/state.js';
import { resetRefactorMarkerReadsForTest } from '../../../src/state/refactor-marker.js';

vi.mock('../../../src/utils/aws-clients.js', async (importOriginal) =>
  (await import('./_inert-cloudformation-client.js')).withInertCloudFormationClient(importOriginal)
);

const { logged } = vi.hoisted(() => ({ logged: [] as string[] }));
vi.mock('../../../src/utils/logger.js', () => {
  const fns = {
    setLevel: vi.fn(),
    debug: vi.fn(),
    info: vi.fn((m: string) => logged.push(m)),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => fns,
  };
  return { getLogger: () => fns };
});

vi.mock('../../../src/utils/live-renderer.js', () => ({
  getLiveRenderer: () => ({
    start: vi.fn(),
    stop: vi.fn(),
    addTask: vi.fn(),
    removeTask: vi.fn(),
    updateTaskLabel: vi.fn(),
    printAbove: (write: () => void) => write(),
  }),
}));

vi.mock('p-limit', () => ({ default: vi.fn(() => <T>(fn: () => T) => fn()) }));

const TYPE = 'AWS::SSM::Parameter';
const STACK = 'S';
const REGION = 'us-east-1';
const ID = '3f2c1d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f';

/** The name cdkd now generates for `logicalId` (no leading slash). */
function generated(logicalId: string, stackInstanceId?: string, generation = 0): string {
  return withStackScope(
    {
      stackName: STACK,
      stackInstanceId,
      nameGenerations:
        stackInstanceId === undefined ? undefined : new Map([[logicalId, generation]]),
    },
    () => generatedNameFor(TYPE, logicalId)
  );
}

function record(physicalId: string, patch: Partial<ResourceState> = {}): ResourceState {
  return { resourceType: TYPE, physicalId, properties: { Type: 'String', Value: 'v' }, ...patch };
}

function stateOf(resources: Record<string, ResourceState>, stackInstanceId?: string): StackState {
  return {
    version: STATE_SCHEMA_VERSION_CURRENT,
    region: REGION,
    stackName: STACK,
    resources,
    outputs: {},
    lastModified: 0,
    ...(stackInstanceId !== undefined && { stackInstanceId }),
  };
}

const unnamed = (logicalIds: string[], props: Record<string, unknown> = {}): CloudFormationTemplate => ({
  Resources: Object.fromEntries(
    logicalIds.map((id) => [id, { Type: TYPE, Properties: { Type: 'String', Value: 'v', ...props } }])
  ),
});

describe('healSlashedSsmParameterNames (go-to-k/cdkd#6274)', () => {
  it('re-spells a legacy stack\'s generated /<stack>-<logicalId> without its slash', () => {
    const name = generated('Param');
    expect(name).toBe('S-Param');
    const state = stateOf({ Param: record(`/${name}`) });
    const { resources, heals } = healSlashedSsmParameterNames(state, unnamed(['Param']), STACK);
    expect(heals).toEqual([{ logicalId: 'Param', from: `/${name}`, to: name }]);
    expect(resources['Param']!.physicalId).toBe(name);
    // Neither input is mutated.
    expect(state.resources['Param']!.physicalId).toBe(`/${name}`);
  });

  it('re-spells the suffixed name of the record\'s own generation on a stack with an instance id', () => {
    for (const generation of [0, 3]) {
      const name = generated('Param', ID, generation);
      const state = stateOf(
        { Param: record(`/${name}`, generation === 0 ? {} : { nameGeneration: generation }) },
        ID
      );
      const { resources } = healSlashedSsmParameterNames(state, unnamed(['Param']), STACK);
      expect(resources['Param']!.physicalId, `generation ${generation}`).toBe(name);
    }
  });

  it('re-spells a legacy name a migrated stack (now with an instance id) still holds', () => {
    const name = generated('Param');
    const state = stateOf({ Param: record(`/${name}`) }, ID);
    const { heals } = healSlashedSsmParameterNames(state, unnamed(['Param']), STACK);
    expect(heals.map((h) => h.to)).toEqual([name]);
  });

  it('moves an observed baseline Name captured under the old spelling with it', () => {
    const name = generated('Param');
    const state = stateOf({
      Param: record(`/${name}`, { observedProperties: { Name: `/${name}`, Value: 'v' } }),
    });
    const { resources } = healSlashedSsmParameterNames(state, unnamed(['Param']), STACK);
    expect(resources['Param']!.observedProperties).toEqual({ Name: name, Value: 'v' });
  });

  it('leaves every other record exactly as recorded', () => {
    const legacy = generated('Param');
    const cases: Array<[string, StackState, CloudFormationTemplate]> = [
      ['a name the template declares', stateOf({ Param: record(`/${legacy}`) }), unnamed(['Param'], { Name: `/${legacy}` })],
      [
        'a name the template declares through an intrinsic',
        stateOf({ Param: record(`/${legacy}`) }),
        unnamed(['Param'], { Name: { 'Fn::Sub': '/${AWS::StackName}-Param' } }),
      ],
      [
        'a name the record declared',
        stateOf({ Param: record(`/${legacy}`, { properties: { Name: `/${legacy}`, Value: 'v' } }) }),
        unnamed(['Param']),
      ],
      ['a multi-level name', stateOf({ Param: record(`/app/${legacy}`) }), unnamed(['Param'])],
      ['a slash-less name', stateOf({ Param: record(legacy) }), unnamed(['Param'])],
      ['another logical id\'s name', stateOf({ Param: record(`/${generated('Other')}`) }), unnamed(['Param'])],
      ['a user\'s own one-level name', stateOf({ Param: record('/my-param') }), unnamed(['Param'])],
      [
        'a suffixed name of another generation',
        stateOf({ Param: record(`/${generated('Param', ID, 1)}`) }, ID),
        unnamed(['Param']),
      ],
      [
        'a suffixed name of another stack instance',
        stateOf({ Param: record(`/${generated('Param', '11111111-1111-4111-8111-111111111111')}`) }, ID),
        unnamed(['Param']),
      ],
      ['a record the template no longer declares', stateOf({ Param: record(`/${legacy}`) }), unnamed([])],
      [
        'a logical id the template now declares as another type',
        stateOf({ Param: record(`/${legacy}`) }),
        { Resources: { Param: { Type: 'AWS::SNS::Topic', Properties: {} } } },
      ],
      [
        'another resource type',
        stateOf({ Param: { ...record(`/${legacy}`), resourceType: 'AWS::SNS::Topic' } }),
        { Resources: { Param: { Type: 'AWS::SNS::Topic', Properties: {} } } },
      ],
    ];
    for (const [label, state, template] of cases) {
      const result = healSlashedSsmParameterNames(state, template, STACK);
      expect(result.heals, label).toEqual([]);
      expect(result.resources, label).toBe(state.resources);
    }
  });
});

describe('cdkd deploy heals the record and updates its dependents (go-to-k/cdkd#6274)', () => {
  const NAME = 'S-Param';
  let stateBackend: { getState: ReturnType<typeof vi.fn>; saveState: ReturnType<typeof vi.fn> };
  let provider: Record<string, ReturnType<typeof vi.fn>>;

  beforeEach(() => {
    vi.clearAllMocks();
    logged.length = 0;
    resetRefactorMarkerReadsForTest();
    stateBackend = { getState: vi.fn(), saveState: vi.fn().mockResolvedValue('etag-new') };
    provider = {
      create: vi.fn(),
      update: vi.fn().mockImplementation((_id: string, physicalId: string) =>
        Promise.resolve({ physicalId, wasReplaced: false })
      ),
      delete: vi.fn(),
      getAttribute: vi.fn().mockResolvedValue(undefined),
      readCurrentState: vi.fn().mockResolvedValue({}),
    };
  });

  function makeEngine(levels: string[][]): DeployEngine {
    return new DeployEngine(
      stateBackend as never,
      {
        acquireLockWithRetry: vi.fn().mockResolvedValue(true),
        releaseLock: vi.fn().mockResolvedValue(undefined),
      } as never,
      {
        buildGraph: vi.fn().mockReturnValue({}),
        getExecutionLevels: vi.fn().mockReturnValue(levels),
        getDirectDependencies: vi.fn().mockReturnValue([]),
      } as never,
      new DiffCalculator(),
      {
        getProvider: vi.fn().mockReturnValue(provider),
        getProviderFor: vi.fn().mockReturnValue({ provider, provisionedBy: 'sdk' }),
        getRegisteredTypes: vi.fn().mockReturnValue([]),
        validateResourceTypes: vi.fn(),
        validateResourceProperties: vi.fn(),
        reportSdkUnwiredDecisions: vi.fn(),
        getEffectivePropertiesFn: vi.fn().mockReturnValue(undefined),
      } as never,
      {},
      REGION,
      {
        updateForStack: vi.fn().mockResolvedValue(undefined),
        prefetch: vi.fn().mockResolvedValue(undefined),
        lookup: vi.fn().mockResolvedValue(null),
        patchEntry: vi.fn().mockResolvedValue(undefined),
      } as never
    );
  }

  const savedStates = () => stateBackend.saveState.mock.calls.map((c) => c[2] as StackState);

  it('updates a dependent holding the old Ref to the new spelling, and records both', async () => {
    const template: CloudFormationTemplate = {
      Resources: {
        Param: { Type: TYPE, Properties: { Type: 'String', Value: 'v' } },
        // Stands in for an IAM policy / env var: a property built from Ref.
        Reader: { Type: TYPE, Properties: { Type: 'String', Value: { Ref: 'Param' } } },
      },
    };
    stateBackend.getState.mockResolvedValue({
      state: stateOf({
        Param: record(`/${NAME}`),
        Reader: record('S-Reader', {
          properties: { Type: 'String', Value: `/${NAME}` },
          dependencies: ['Param'],
        }),
      }),
      etag: 'e',
    });
    await makeEngine([['Param'], ['Reader']]).deploy(STACK, template);

    expect(provider['update']).toHaveBeenCalledTimes(1);
    const [logicalId, , , desired] = provider['update']!.mock.calls[0]!;
    expect(logicalId).toBe('Reader');
    expect((desired as Record<string, unknown>)['Value']).toBe(NAME);
    const saved = savedStates().at(-1)!;
    expect(saved.resources['Param']!.physicalId).toBe(NAME);
    expect(saved.resources['Reader']!.properties['Value']).toBe(NAME);
    expect(logged.some((m) => m.includes('go-to-k/cdkd#6274'))).toBe(true);
  });

  it('saves the re-spelled record even when nothing else changes', async () => {
    stateBackend.getState.mockResolvedValue({
      state: stateOf({ Param: record(`/${NAME}`, { observedProperties: {} }) }),
      etag: 'e',
    });
    await makeEngine([['Param']]).deploy(STACK, unnamed(['Param']));
    expect(provider['update']).not.toHaveBeenCalled();
    expect(savedStates().at(-1)?.resources['Param']?.physicalId).toBe(NAME);
  });

  it('CONTROL: a slash-less record deployed again saves nothing', async () => {
    stateBackend.getState.mockResolvedValue({
      state: stateOf({ Param: record(NAME, { observedProperties: {} }) }),
      etag: 'e',
    });
    await makeEngine([['Param']]).deploy(STACK, unnamed(['Param']));
    expect(stateBackend.saveState).not.toHaveBeenCalled();
  });
});
