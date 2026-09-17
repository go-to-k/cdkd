/**
 * Issue [go-to-k/cdkd#3191](https://github.com/go-to-k/cdkd/issues/3191), from
 * the WRITE-CAPABLE side.
 *
 * The analyzer suite proves `DiffCalculator.calculateDiff` refuses a record
 * whose resource `properties` map cannot be read. This file drives the same
 * refusal through `DeployEngine.deploy` — the only caller of that method that
 * provisions — because the refusal's own text makes a claim about the ENGINE
 * that no calculator-level case can check: *"Nothing was provisioned and no
 * state was written FOR THIS STACK."*
 *
 * That claim is not free. By the time the diff runs, `deploy` has already
 * taken the stack lock and fired fire-and-forget
 * `provider.readCurrentState` reads (`kickOffAutoRefreshObservedProperties`).
 * Neither persists anything — the save they would be drained into never
 * happens — but a guard written any later, or a refusal that stranded the
 * lock, would make the sentence false. So the assertions below are the claim,
 * not a restatement of the analyzer's.
 *
 * The calculator is the REAL one here, deliberately: the sibling
 * `deploy-engine-malformed-outputs-refusal.test.ts` mocks it, which is right
 * for a guard that lives in the engine and wrong for one that lives in the
 * calculator — a mock would assert only what the engine passes.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import { DiffCalculator } from '../../../src/analyzer/diff-calculator.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { StackState } from '../../../src/types/state.js';
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

const STACK = 'malformed-properties-stack';
const REGION = 'us-east-1';

describe('DeployEngine refuses an unreadable properties map (go-to-k/cdkd#3191)', () => {
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
  /** Every provider call the run made — the "nothing was provisioned" claim. */
  let provisioned: string[];

  beforeEach(() => {
    vi.clearAllMocks();
    provisioned = [];
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

  function makeProviderRegistry() {
    const provider = {
      create: vi.fn().mockImplementation(() => {
        provisioned.push('create');
        return Promise.resolve({ physicalId: 'p' });
      }),
      update: vi.fn().mockImplementation(() => {
        provisioned.push('update');
        return Promise.resolve({ physicalId: 'p' });
      }),
      delete: vi.fn().mockImplementation(() => {
        provisioned.push('delete');
        return Promise.resolve();
      }),
      getAttribute: vi.fn().mockResolvedValue(undefined),
      readCurrentState: vi.fn().mockResolvedValue({}),
    };
    return {
      getProvider: vi.fn().mockReturnValue(provider),
      getProviderFor: vi.fn().mockReturnValue({ provider, provisionedBy: 'sdk' }),
      getRegisteredTypes: vi.fn().mockReturnValue([]),
      validateResourceTypes: vi.fn(),
      validateResourceProperties: vi.fn(),
      reportSilentDropDecisions: vi.fn(),
      getEffectivePropertiesFn: vi.fn().mockReturnValue(undefined),
    };
  }

  function makeState(properties: unknown): StackState {
    return {
      version: STATE_SCHEMA_VERSION_CURRENT,
      region: REGION,
      stackName: STACK,
      resources: {
        ParamA: {
          physicalId: 'phys-param-a',
          resourceType: 'AWS::SSM::Parameter',
          properties: properties as Record<string, unknown>,
          attributes: {},
          dependencies: [],
        },
      },
      outputs: {},
      lastModified: 0,
    };
  }

  const template: CloudFormationTemplate = {
    Resources: { ParamA: { Type: 'AWS::SSM::Parameter', Properties: { Value: 'x' } } },
  };

  function makeEngine(): DeployEngine {
    return new DeployEngine(
      stateBackend as never,
      lockManager as never,
      dagBuilder as never,
      new DiffCalculator(),
      makeProviderRegistry() as never,
      { dryRun: false },
      REGION,
      exportIndexStore as never
    );
  }

  for (const [label, properties] of [
    ['a string map', 'abcdef'],
    ['a list map', []],
    ['a number map', 5],
    ['a null map', null],
  ] as Array<[string, unknown]>) {
    it(`refuses ${label}, provisioning nothing and writing nothing`, async () => {
      stateBackend.getState.mockResolvedValue({ state: makeState(properties), etag: 'etag-old' });
      const err = (await makeEngine()
        .deploy(STACK, template)
        .catch((e: unknown) => e)) as CdkdError;

      expect(err).toBeInstanceOf(CdkdError);
      expect(err.code).toBe(STATE_RESOURCES_MALFORMED);

      // The claim the refusal's own text makes, in two halves. Without the
      // guard this fixture is a REPLACEMENT — `AWS::SSM::Parameter`'s `Value`
      // reads as absent-in-current — so both of these would be non-empty.
      expect(
        provisioned,
        'the deploy called a provider before refusing, so the refusal claims more than it did'
      ).toEqual([]);
      expect(
        stateBackend.saveState,
        'the deploy wrote the record before refusing, laundering the damaged map'
      ).not.toHaveBeenCalled();
      expect(exportIndexStore.updateForStack).not.toHaveBeenCalled();

      // The lock IS held by this point, so the refusal must not strand it.
      expect(lockManager.releaseLock).toHaveBeenCalledWith(STACK, REGION);
    });
  }

  it('deploys normally when the map is readable', async () => {
    // The non-firing side at the ENGINE, not just at the calculator: a guard
    // that refused every record would satisfy every assertion above.
    stateBackend.getState.mockResolvedValue({
      state: makeState({ Value: 'x' }),
      etag: 'etag-old',
    });
    const result = await makeEngine()
      .deploy(STACK, template)
      .catch((e: unknown) => e);
    expect(result).not.toBeInstanceOf(CdkdError);
    expect(lockManager.releaseLock).toHaveBeenCalledWith(STACK, REGION);
  });
});
