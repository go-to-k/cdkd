/**
 * Issue go-to-k/cdkd#3207: `DeployEngine.deploy` carried a loaded record's
 * `outputs` bag with a bare `?? {}` on the no-change merge path
 * (`persistedOutputs`) and verbatim on five failure-path saves, then SAVED the
 * result.
 *
 * `deploy` is the most write-capable consumer of that bag there is:
 * `Object.entries` walks a string as readily as a map, so a six-character bag
 * is rebuilt into a well-formed six-key map, the only signal the record was
 * damaged is gone permanently, and the next success republishes the fabricated
 * keys into `cdkd/_index/<region>/exports.json` — the namespace every other
 * stack's `Fn::ImportValue` binds against. REFUSE, which is the shape
 * go-to-k/cdkd#3192 settled for `cdkd orphan` / `import` / `scrub`.
 *
 * The cases are DOMINANCE cases: the guard sits at the LOAD, so a `saveState`
 * never happening is what discriminates it from a guard written at the merge.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { ResourceChange, StackState } from '../../../src/types/state.js';
import { STATE_SCHEMA_VERSION_CURRENT } from '../../../src/types/state.js';
import { STATE_RESOURCES_MALFORMED } from '../../../src/state/malformed-resources-bag.js';
import { CdkdError } from '../../../src/utils/error-handler.js';

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

const renderer = {
  start: vi.fn(),
  stop: vi.fn(),
  addTask: vi.fn(),
  removeTask: vi.fn(),
  updateTaskLabel: vi.fn(),
  printAbove: (write: () => void) => write(),
};
vi.mock('../../../src/utils/live-renderer.js', () => ({ getLiveRenderer: () => renderer }));

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

const STACK = 'malformed-outputs-stack';
const REGION = 'us-east-1';

describe('DeployEngine refuses a malformed `outputs` bag at the load (go-to-k/cdkd#3207)', () => {
  let stateBackend: { getState: ReturnType<typeof vi.fn>; saveState: ReturnType<typeof vi.fn> };
  let lockManager: {
    acquireLockWithRetry: ReturnType<typeof vi.fn>;
    releaseLock: ReturnType<typeof vi.fn>;
  };
  let exportIndexStore: {
    updateForStack: ReturnType<typeof vi.fn>;
    lookup: ReturnType<typeof vi.fn>;
    patchEntry: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    lockManager = {
      acquireLockWithRetry: vi.fn().mockResolvedValue(true),
      releaseLock: vi.fn().mockResolvedValue(undefined),
    };
    stateBackend = {
      getState: vi.fn(),
      saveState: vi.fn().mockResolvedValue('etag-new'),
    };
    exportIndexStore = {
      updateForStack: vi.fn().mockResolvedValue(undefined),
      lookup: vi.fn().mockResolvedValue(null),
      patchEntry: vi.fn().mockResolvedValue(undefined),
    };
  });

  const dagBuilder = {
    buildGraph: vi.fn().mockReturnValue({}),
    getExecutionLevels: vi.fn().mockReturnValue([]),
    getDirectDependencies: vi.fn().mockReturnValue([]),
  };
  const diffCalculator = {
    calculateDiff: vi.fn().mockResolvedValue(
      new Map<string, ResourceChange>([
        [
          'ParamA',
          { logicalId: 'ParamA', changeType: 'NO_CHANGE', resourceType: 'AWS::SSM::Parameter' },
        ],
      ])
    ),
    hasChanges: vi.fn().mockReturnValue(false),
    filterByType: vi
      .fn()
      .mockImplementation((changes: Map<string, ResourceChange>, type: string) =>
        Array.from(changes.values()).filter((c) => c.changeType === type)
      ),
  };
  const providerRegistry = {
    getProvider: vi.fn(),
    getProviderFor: vi.fn(),
    getRegisteredTypes: vi.fn().mockReturnValue([]),
    validateResourceTypes: vi.fn(),
    validateResourceProperties: vi.fn(),
  };

  function makeState(outputs: unknown, opts: { omitOutputs?: boolean } = {}): StackState {
    const state: StackState = {
      version: STATE_SCHEMA_VERSION_CURRENT,
      region: REGION,
      stackName: STACK,
      resources: {
        ParamA: {
          physicalId: 'phys-param-a',
          resourceType: 'AWS::SSM::Parameter',
          properties: { Value: 'x' },
          observedProperties: { Value: 'x' },
          attributes: {},
          dependencies: [],
        },
      },
      outputs: outputs as StackState['outputs'],
      lastModified: 0,
    };
    if (opts.omitOutputs) delete (state as Partial<StackState>).outputs;
    return state;
  }

  const template: CloudFormationTemplate = {
    Resources: { ParamA: { Type: 'AWS::SSM::Parameter', Properties: { Value: 'x' } } },
  };

  function makeEngine(): DeployEngine {
    return new DeployEngine(
      stateBackend as never,
      lockManager as never,
      dagBuilder as never,
      diffCalculator as never,
      providerRegistry as never,
      { dryRun: false },
      REGION,
      exportIndexStore as never
    );
  }

  const MALFORMED: Array<[string, unknown]> = [
    ['a string bag', 'abcdef'],
    ['a list bag', ['a', 'b']],
    ['a null bag', null],
    ['a number bag', 5],
    ['a boolean bag', true],
  ];

  for (const [label, bag] of MALFORMED) {
    it(`refuses ${label} with the shared code, and saves nothing`, async () => {
      stateBackend.getState.mockResolvedValue({ state: makeState(bag), etag: 'etag-old' });
      const err = (await makeEngine()
        .deploy(STACK, template)
        .catch((e: unknown) => e)) as CdkdError;
      expect(err).toBeInstanceOf(CdkdError);
      expect(err.code).toBe(STATE_RESOURCES_MALFORMED);
      // DOMINANCE: this fixture takes the NO_CHANGE path, whose refresh save is
      // exactly the write that would have laundered the bag. A guard written at
      // `persistedOutputs` instead of at the load leaves the five failure-path
      // saves in front of it.
      expect(
        stateBackend.saveState,
        'the deploy wrote the record before refusing, so the damaged bag is laundered'
      ).not.toHaveBeenCalled();
      // ...and the shared index must not be touched either.
      expect(exportIndexStore.updateForStack).not.toHaveBeenCalled();
      // The lock WAS taken by this point, so the refusal must not strand it.
      expect(lockManager.releaseLock).toHaveBeenCalledWith(STACK, REGION);
    });
  }

  it('names the deploy consequence — the rebuild and the shared exports index', async () => {
    stateBackend.getState.mockResolvedValue({ state: makeState('abcdef'), etag: 'etag-old' });
    const err = (await makeEngine()
      .deploy(STACK, template)
      .catch((e: unknown) => e)) as Error;
    expect(err.message).toContain('REBUILDS the bag before saving');
    expect(err.message).toContain('shared exports index');
  });

  // THE OTHER DIRECTION — a fence refusing every record would break every
  // deploy while satisfying each case above.
  const HEALTHY: Array<[string, () => StackState]> = [
    ['a populated bag', () => makeState({ BucketArn: 'arn:aws:s3:::b' })],
    ['an EMPTY bag', () => makeState({})],
    ['an ABSENT bag — a record cdkd writes on purpose', () => makeState(undefined, { omitOutputs: true })],
  ];

  for (const [label, build] of HEALTHY) {
    it(`deploys ${label} normally`, async () => {
      stateBackend.getState.mockResolvedValue({ state: build(), etag: 'etag-old' });
      await expect(makeEngine().deploy(STACK, template)).resolves.toBeDefined();
    });
  }

  it('deploys a FIRST-EVER stack, where no record exists at all', async () => {
    // The synthesized `currentState` literal the load falls back to carries
    // `outputs: {}`, so a guard that refused `undefined` would break every
    // first deploy. Nothing else in this file exercises that literal.
    stateBackend.getState.mockResolvedValue(null);
    await expect(makeEngine().deploy(STACK, template)).resolves.toBeDefined();
  });
});
