/**
 * go-to-k/cdkd#5238: each deploy records the synthesized stack's
 * `terminationProtection` on the root record, so `cdkd state destroy` (no
 * CDK app) can honor it -- including a deploy with no resource change, and
 * never on a nested child. Harness from `deploy-engine-pending-moves.test.ts`.
 */
/**
 * go-to-k/cdkd#5212: `cdkd deploy` refuses a stack whose record says an
 * interrupted `cdkd refactor` is moving resources out of it -- the
 * destination may already hold them, and this deploy would delete each one
 * the template no longer declares. The refusal is a field test on the record
 * the deploy already loaded: no provider call, no save.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import { DiffCalculator } from '../../../src/analyzer/diff-calculator.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { StackState } from '../../../src/types/state.js';
import { STATE_SCHEMA_VERSION_CURRENT } from '../../../src/types/state.js';
import { resetRefactorMarkerReadsForTest } from '../../../src/state/refactor-marker.js';

// No real AWS client: the create-only DescribeType prefetch reads the
// process-global client factory (see _inert-cloudformation-client.ts).
vi.mock('../../../src/utils/aws-clients.js', async (importOriginal) =>
  (await import('./_inert-cloudformation-client.js')).withInertCloudFormationClient(importOriginal)
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

vi.mock('../../../src/deployment/intrinsic-function-resolver.js', () => ({
  IntrinsicFunctionResolver: vi.fn().mockImplementation(() => ({
    getPhysicalIdFallbackCount: vi.fn().mockReturnValue(0),
    resetPhysicalIdFallbackCount: vi.fn(),
    resolve: vi.fn().mockImplementation((props: unknown) => Promise.resolve(props)),
    resolveParameters: vi.fn().mockResolvedValue({}),
    evaluateConditions: vi.fn().mockResolvedValue({}),
  })),
}));

vi.mock('p-limit', () => ({ default: vi.fn(() => <T>(fn: () => T) => fn()) }));

const STACK = 'S';
const REGION = 'us-east-1';

const row = () => ({
  resourceType: 'AWS::SSM::Parameter',
  physicalId: 'p',
  properties: { Value: 'x' },
  attributes: {},
  dependencies: [],
});

function makeState(patch: Partial<StackState>): StackState {
  return {
    version: STATE_SCHEMA_VERSION_CURRENT,
    region: REGION,
    stackName: STACK,
    resources: { Kept: row(), Moving: row() } as never,
    outputs: {},
    lastModified: 0,
    ...patch,
  };
}

// The template no longer declares `Moving`: an ordinary deploy would delete it.
const template: CloudFormationTemplate = {
  Resources: { Kept: { Type: 'AWS::SSM::Parameter', Properties: { Value: 'x' } } },
};


const unchanged = (patch: Partial<StackState> = {}) => makeState({ resources: { Kept: row() } as never, ...patch });
const savedStates = (save: ReturnType<typeof vi.fn>) =>
  save.mock.calls.map((c) => c[2] as StackState);

describe('cdkd deploy records terminationProtection (go-to-k/cdkd#5238)', () => {
  let stateBackend: { getState: ReturnType<typeof vi.fn>; saveState: ReturnType<typeof vi.fn> };
  let provider: Record<string, ReturnType<typeof vi.fn>>;

  beforeEach(() => {
    vi.clearAllMocks();
    resetRefactorMarkerReadsForTest();
    stateBackend = { getState: vi.fn(), saveState: vi.fn().mockResolvedValue('etag-new') };
    provider = {
      create: vi.fn().mockResolvedValue({ physicalId: 'p' }),
      update: vi.fn().mockResolvedValue({ physicalId: 'p' }),
      delete: vi.fn().mockResolvedValue(undefined),
      getAttribute: vi.fn().mockResolvedValue(undefined),
      readCurrentState: vi.fn().mockResolvedValue({}),
    };
  });

  function makeEngine(options: Record<string, unknown> = {}): DeployEngine {
    return new DeployEngine(
      stateBackend as never,
      {
        acquireLockWithRetry: vi.fn().mockResolvedValue(true),
        releaseLock: vi.fn().mockResolvedValue(undefined),
      } as never,
      {
        buildGraph: vi.fn().mockReturnValue({}),
        getExecutionLevels: vi.fn().mockReturnValue([['Kept']]),
        getDirectDependencies: vi.fn().mockReturnValue([]),
      } as never,
      new DiffCalculator(),
      {
        getProvider: vi.fn().mockReturnValue(provider),
        getProviderFor: vi.fn().mockReturnValue({ provider, provisionedBy: 'sdk' }),
        getRegisteredTypes: vi.fn().mockReturnValue([]),
        validateResourceTypes: vi.fn(),
        validateResourceProperties: vi.fn(),
        reportSilentDropDecisions: vi.fn(),
        getEffectivePropertiesFn: vi.fn().mockReturnValue(undefined),
      } as never,
      options,
      REGION,
      {
        updateForStack: vi.fn().mockResolvedValue(undefined),
        prefetch: vi.fn().mockResolvedValue(undefined),
        lookup: vi.fn().mockResolvedValue(null),
        patchEntry: vi.fn().mockResolvedValue(undefined),
      } as never
    );
  }


  /**
   * A record one deploy has already settled: deployed again with the same
   * setting it saves nothing, so a save in the cases below is the toggle's.
   */
  async function settled(terminationProtection: boolean): Promise<StackState> {
    stateBackend.getState.mockResolvedValue({ state: unchanged(), etag: 'e' });
    await makeEngine(terminationProtection ? { terminationProtection: true } : {}).deploy(STACK, template);
    const state = savedStates(stateBackend.saveState).at(-1)!;
    stateBackend.saveState.mockClear();
    stateBackend.getState.mockResolvedValue({ state, etag: 'e2' });
    return state;
  }

  it('CONTROL: a settled record deployed with the same setting saves nothing', async () => {
    for (const on of [false, true]) {
      await settled(on);
      await makeEngine(on ? { terminationProtection: true } : {}).deploy(STACK, template);
      expect(stateBackend.saveState, `terminationProtection ${on}`).not.toHaveBeenCalled();
    }
  });

  it('a no-change deploy that turns protection ON saves the field', async () => {
    await settled(false);
    await makeEngine({ terminationProtection: true }).deploy(STACK, template);
    expect(stateBackend.saveState).toHaveBeenCalledTimes(1);
    expect(savedStates(stateBackend.saveState)[0]!.terminationProtection).toBe(true);
  });

  it('a no-change deploy that turns protection OFF saves without the field', async () => {
    expect((await settled(true)).terminationProtection).toBe(true);
    await makeEngine().deploy(STACK, template);
    expect(stateBackend.saveState).toHaveBeenCalledTimes(1);
    expect(Object.hasOwn(savedStates(stateBackend.saveState)[0]!, 'terminationProtection')).toBe(false);
  });

  it('a deploy that changes resources writes it on every save', async () => {
    stateBackend.getState.mockResolvedValue({ state: makeState({}), etag: 'e' });
    await makeEngine({ terminationProtection: true }).deploy(STACK, template);
    const saved = savedStates(stateBackend.saveState);
    expect(saved.length).toBeGreaterThan(0);
    expect(saved.every((s) => s.terminationProtection === true)).toBe(true);
  });

  it('a first deploy of a protected stack records it', async () => {
    stateBackend.getState.mockResolvedValue(null);
    (stateBackend as unknown as Record<string, unknown>)['stackInstanceIdForFirstWrite'] = vi
      .fn()
      .mockResolvedValue('11111111-1111-4111-8111-111111111111');
    await makeEngine({ terminationProtection: true }).deploy(STACK, template);
    expect(savedStates(stateBackend.saveState).at(-1)?.terminationProtection).toBe(true);
  });

  it('a nested child records none: the setting is the root stack\'s', async () => {
    stateBackend.getState.mockResolvedValue({ state: makeState({}), etag: 'e' });
    await makeEngine({
      terminationProtection: true,
      parentStackInfo: { parentStack: 'Root', parentLogicalId: 'Child', parentRegion: REGION },
    }).deploy(STACK, template);
    const saved = savedStates(stateBackend.saveState);
    expect(saved.length).toBeGreaterThan(0);
    expect(saved.some((s) => Object.hasOwn(s, 'terminationProtection'))).toBe(false);
  });
});

describe('stackInstanceIdCarriedFrom carries terminationProtection (go-to-k/cdkd#5238)', () => {
  it('carries true, so a non-deploy writer keeps the protection, and nothing else', async () => {
    const { stackInstanceIdCarriedFrom } = await import('../../../src/types/state.js');
    expect(stackInstanceIdCarriedFrom({ terminationProtection: true })).toEqual({
      terminationProtection: true,
    });
    expect(stackInstanceIdCarriedFrom({})).toEqual({});
    expect(stackInstanceIdCarriedFrom({ terminationProtection: 'yes' as never })).toEqual({});
  });
});
