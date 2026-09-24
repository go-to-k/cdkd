/**
 * Issue [go-to-k/cdkd#3314](https://github.com/go-to-k/cdkd/issues/3314), the
 * engine half. `DiffCalculator.calculateDiff` refuses an unreadable resource
 * ROW (`tests/unit/analyzer/diff-calculator-malformed-properties.test.ts` pins
 * it there), but a deploy walks the rows BEFORE the diff. Measured before this
 * fix: with `captureObservedState: true` (the CLI default) a `null` row died in
 * `kickOffAutoRefreshObservedProperties` on a bare `TypeError: Cannot read
 * properties of null (reading 'observedProperties')`, and on real AWS the CLI's
 * prefix-migration gate (`onCurrentStateLoaded`) died even earlier, on
 * `reading 'resourceType'`. With the capture off, the same record PROVISIONED
 * a CREATE of a resource the record already names. So the engine refuses at its
 * state LOAD, which dominates all of them.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import { DiffCalculator } from '../../../src/analyzer/diff-calculator.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { StackState } from '../../../src/types/state.js';
import { STATE_SCHEMA_VERSION_CURRENT } from '../../../src/types/state.js';
import { STATE_RESOURCES_MALFORMED } from '../../../src/state/malformed-resources-bag.js';
import { CdkdError } from '../../../src/utils/error-handler.js';
import { isMarkedNonRetryable } from '../../../src/deployment/retryable-errors.js';

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

const STACK = 'malformed-entries-stack';
const REGION = 'us-east-1';

describe('DeployEngine refuses an unreadable resource ENTRY (go-to-k/cdkd#3314)', () => {
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
    getExecutionLevels: vi.fn().mockReturnValue([['ParamA']]),
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

  function makeState(resources: unknown): StackState {
    return {
      version: STATE_SCHEMA_VERSION_CURRENT,
      region: REGION,
      stackName: STACK,
      resources: resources as StackState['resources'],
      outputs: {},
      lastModified: 0,
    };
  }

  const template: CloudFormationTemplate = {
    Resources: { ParamA: { Type: 'AWS::SSM::Parameter', Properties: { Value: 'x' } } },
  };

  function makeEngine(dryRun = false, captureObservedState = true): DeployEngine {
    return new DeployEngine(
      stateBackend as never,
      lockManager as never,
      dagBuilder as never,
      new DiffCalculator(),
      makeProviderRegistry() as never,
      { dryRun, captureObservedState },
      REGION,
      exportIndexStore as never
    );
  }


  const healthy = {
    physicalId: 'phys-param-a',
    resourceType: 'AWS::SSM::Parameter',
    properties: { Value: 'x' },
    attributes: {},
    dependencies: [],
  };

  // Every arm the flags open. `capture` is the arm that used to die before the
  // diff; `no capture` provisioned the CREATE; `dry run` returns before
  // provisioning but still printed a CREATE plan.
  for (const [label, dryRun, capture] of [
    ['with the observed-state capture on (the default)', false, true],
    ['with the observed-state capture off', false, false],
    ['under --dry-run', true, true],
  ] as const) {
    it(`refuses a null row ${label}, provisioning and writing nothing`, async () => {
      stateBackend.getState.mockResolvedValue({
        state: makeState({ ParamA: null }),
        etag: 'etag-old',
      });
      const err = (await makeEngine(dryRun, capture)
        .deploy(STACK, template)
        .catch((e: unknown) => e)) as CdkdError;

      expect(err, 'the deploy did not refuse: it planned or provisioned the row as absent').toBeInstanceOf(
        CdkdError
      );
      expect(err.code).toBe(STATE_RESOURCES_MALFORMED);
      expect(err.message).toContain('ParamA');
      expect(err.message).toContain('planned as a CREATE');
      expect(
        provisioned,
        'the deploy called a provider before refusing, so it created a second copy of a resource ' +
          'the record already names'
      ).toEqual([]);
      expect(stateBackend.saveState).not.toHaveBeenCalled();
      expect(isMarkedNonRetryable(err)).toBe(true);
      expect(lockManager.releaseLock).toHaveBeenCalledWith(STACK, REGION);
    });
  }

  // The other shapes, on the default arm. None of them crashes the
  // auto-refresh walk the way `null` does, so without the load refusal the walk
  // goes on to look up a provider for the healthy sibling (and the damaged row)
  // and fires an AWS read before the diff refuses. The provider-lookup
  // assertion is what pins the refusal to the LOAD.
  for (const [label, row] of [
    ['a string', 'ab'],
    ['a number', 5],
    ['a typeless object', { physicalId: 'phys-param-a', properties: { Value: 'x' } }],
  ] as const) {
    it(`refuses ${label} row at the load on the default arm`, async () => {
      const registry = makeProviderRegistry();
      stateBackend.getState.mockResolvedValue({
        state: makeState({ Healthy: { ...healthy, physicalId: 'phys-healthy' }, ParamA: row }),
        etag: 'etag-old',
      });
      const engine = new DeployEngine(
        stateBackend as never,
        lockManager as never,
        dagBuilder as never,
        new DiffCalculator(),
        registry as never,
        { dryRun: false, captureObservedState: true },
        REGION,
        exportIndexStore as never
      );
      const err = (await engine.deploy(STACK, template).catch((e: unknown) => e)) as CdkdError;
      expect(err).toBeInstanceOf(CdkdError);
      expect(err.code).toBe(STATE_RESOURCES_MALFORMED);
      expect(err.message).toContain('ParamA');
      expect(registry.getProviderFor, 'the auto-refresh walk ran before the refusal').not.toHaveBeenCalled();
      expect(provisioned).toEqual([]);
      expect(stateBackend.saveState).not.toHaveBeenCalled();
    });
  }

  it('refuses at the LOAD, before the pre-flight gate and before any AWS read', async () => {
    // A TYPELESS row rather than `null`: the auto-refresh walk does not die on
    // it, so without the load refusal it goes on to look up a provider for the
    // healthy row beside it (which lacks `observedProperties`) and fires an AWS
    // read. That makes the `getProviderFor` assertion below discriminating. A
    // `null` row would crash the walk before any lookup and pass it vacuously.
    const registry = makeProviderRegistry();
    const onCurrentStateLoaded = vi.fn().mockResolvedValue(undefined);
    stateBackend.getState.mockResolvedValue({
      state: makeState({
        Healthy: { ...healthy, physicalId: 'phys-healthy' },
        ParamA: { physicalId: 'phys-param-a', properties: { Value: 'x' } },
      }),
      etag: 'etag-old',
    });
    const engine = new DeployEngine(
      stateBackend as never,
      lockManager as never,
      dagBuilder as never,
      new DiffCalculator(),
      registry as never,
      { dryRun: false, captureObservedState: true, onCurrentStateLoaded },
      REGION,
      exportIndexStore as never
    );
    const err = (await engine.deploy(STACK, template).catch((e: unknown) => e)) as CdkdError;
    expect(err).toBeInstanceOf(CdkdError);
    expect(err.code).toBe(STATE_RESOURCES_MALFORMED);
    expect(onCurrentStateLoaded, 'the pre-flight gate ran over the damaged row').not.toHaveBeenCalled();
    expect(
      registry.getProviderFor,
      'the auto-refresh walk ran before the refusal, reading AWS for a record the deploy refuses'
    ).not.toHaveBeenCalled();
    // At the load the engine holds a TRUSTED identity, so the remedy names it.
    expect(err.message).toContain(STACK);
    expect(err.message.endsWith(`--stack-region ${REGION} --json`)).toBe(true);
  });

  it('deploys normally when every row is readable', async () => {
    stateBackend.getState.mockResolvedValue({
      state: makeState({ ParamA: healthy }),
      etag: 'etag-old',
    });
    const result = await makeEngine()
      .deploy(STACK, template)
      .catch((e: unknown) => e);
    // Any Error, not only a CdkdError: a bare TypeError is the failure mode.
    expect(result).not.toBeInstanceOf(Error);
    expect(provisioned).toEqual([]);
  });
});
