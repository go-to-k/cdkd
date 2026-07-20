/**
 * Issue #1111 items 2 + 3 (engine side):
 *
 * - `--strict-getatt` makes an Output resolution failure fail the deploy;
 *   default mode keeps the warn-and-continue behavior (`outputs[key] =
 *   undefined`, dropped from the display outputs).
 * - The engine threads `strictGetAtt` into its resolver, resets the
 *   per-run fallback counter at the start of each deploy, and surfaces the
 *   count as `DeployResult.attributeFallbackCount`.
 *
 * The resolver is mocked (pass-through except a `__boom__` sentinel that
 * throws) so the tests exercise the ENGINE's catch/rethrow + counter
 * plumbing, not the resolver's own guard (covered in
 * intrinsic-getatt-fallback-guard.test.ts).
 */

import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import { IntrinsicFunctionResolver } from '../../../src/deployment/intrinsic-function-resolver.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { ResourceChange, StackState } from '../../../src/types/state.js';
import { STATE_SCHEMA_VERSION_CURRENT } from '../../../src/types/state.js';

const warnSpy = vi.hoisted(() => vi.fn());
vi.mock('../../../src/utils/logger.js', () => {
  const fns = {
    setLevel: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: warnSpy,
    error: vi.fn(),
    child: () => fns,
  };
  return { getLogger: () => fns };
});

// Mutable per-test knobs for the mocked resolver.
const fallbackCountHolder: { value: number } = { value: 0 };
const resetSpy = vi.hoisted(() => vi.fn());
vi.mock('../../../src/deployment/intrinsic-function-resolver.js', () => ({
  IntrinsicFunctionResolver: vi.fn().mockImplementation(() => ({
    getPhysicalIdFallbackCount: vi.fn().mockImplementation(() => fallbackCountHolder.value),
    resetPhysicalIdFallbackCount: resetSpy,
    resolve: vi
      .fn()
      .mockImplementation((value: unknown, context?: { recordedImports?: unknown[] }) => {
        if (value === '__boom__') {
          return Promise.reject(new Error('cannot construct attribute'));
        }
        // Sentinel standing in for an Fn::ImportValue resolution: the real
        // resolver appends a StateImportEntry to the context's
        // recordedImports bag (threaded from the engine's per-run array).
        if (
          value !== null &&
          typeof value === 'object' &&
          (value as Record<string, unknown>)['Value'] === '__record_import__'
        ) {
          context?.recordedImports?.push({
            sourceStack: 'producer-stack',
            sourceRegion: 'us-east-1',
            exportName: 'producer-export',
          });
          return Promise.resolve({ Value: 'imported-value' });
        }
        return Promise.resolve(value);
      }),
    resolveParameters: vi.fn().mockResolvedValue({}),
    evaluateConditions: vi.fn().mockResolvedValue({}),
  })),
}));

vi.mock('../../../src/provisioning/cloud-control-provider.js', () => ({
  CloudControlProvider: {
    isSupportedResourceType: vi.fn(() => true),
  },
}));

vi.mock('p-limit', () => ({
  default: vi.fn(() => <T>(fn: () => T) => fn()),
}));

describe('DeployEngine - --strict-getatt output failures + fallback counter (#1111)', () => {
  const stackName = 'strict-getatt-stack';

  let mockStateBackend: {
    getState: ReturnType<typeof vi.fn>;
    saveState: ReturnType<typeof vi.fn>;
  };
  let mockLockManager: {
    acquireLockWithRetry: ReturnType<typeof vi.fn>;
    releaseLock: ReturnType<typeof vi.fn>;
  };
  let mockDagBuilder: {
    buildGraph: ReturnType<typeof vi.fn>;
    getExecutionLevels: ReturnType<typeof vi.fn>;
    getDirectDependencies: ReturnType<typeof vi.fn>;
  };
  let mockDiffCalculator: {
    calculateDiff: ReturnType<typeof vi.fn>;
    hasChanges: ReturnType<typeof vi.fn>;
    filterByType: ReturnType<typeof vi.fn>;
  };
  let mockProviderRegistry: {
    getProvider: ReturnType<typeof vi.fn>;
    getProviderFor: ReturnType<typeof vi.fn>;
    getRegisteredTypes: ReturnType<typeof vi.fn>;
    validateResourceTypes: ReturnType<typeof vi.fn>;
    validateResourceProperties: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    fallbackCountHolder.value = 0;

    mockLockManager = {
      acquireLockWithRetry: vi.fn().mockResolvedValue(true),
      releaseLock: vi.fn().mockResolvedValue(undefined),
    };
    mockDagBuilder = {
      buildGraph: vi.fn().mockReturnValue({}),
      getExecutionLevels: vi.fn().mockReturnValue([]),
      getDirectDependencies: vi.fn().mockReturnValue([]),
    };
    mockDiffCalculator = {
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
    mockProviderRegistry = {
      getProvider: vi.fn(),
      getProviderFor: vi.fn(),
      getRegisteredTypes: vi.fn().mockReturnValue([]),
      validateResourceTypes: vi.fn(),
      validateResourceProperties: vi.fn(),
    };
    mockStateBackend = {
      getState: vi.fn().mockResolvedValue({ state: makeState(), etag: 'etag-old' }),
      saveState: vi.fn().mockResolvedValue('etag-new'),
    };
  });

  function makeState(): StackState {
    return {
      version: STATE_SCHEMA_VERSION_CURRENT,
      region: 'us-east-1',
      stackName,
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
      outputs: {},
      lastModified: 0,
    };
  }

  const template: CloudFormationTemplate = {
    Resources: {
      ParamA: { Type: 'AWS::SSM::Parameter', Properties: { Value: 'x' } },
    },
    Outputs: {
      Good: { Value: 'ok-value' },
      Bad: { Value: '__boom__' },
    },
  };

  function makeEngine(strictGetAtt?: boolean) {
    return new DeployEngine(
      mockStateBackend as never,
      mockLockManager as never,
      mockDagBuilder as never,
      mockDiffCalculator as never,
      mockProviderRegistry as never,
      { dryRun: false, ...(strictGetAtt !== undefined && { strictGetAtt }) },
      'us-east-1'
    );
  }

  it('default mode: an unresolvable Output warns and is skipped, deploy succeeds', async () => {
    const engine = makeEngine();
    const result = await engine.deploy(stackName, template);

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Failed to resolve output Bad'));
    // No-change path: a resolution failure keeps the previously persisted
    // outputs (empty here) instead of persisting a partial map — the deploy
    // still exits successfully in default mode.
    expect(result.outputs).toEqual({});
  });

  it('strict mode: an unresolvable Output fails the deploy with an actionable error', async () => {
    const engine = makeEngine(true);
    await expect(engine.deploy(stackName, template)).rejects.toThrow(
      /Failed to resolve output Bad: cannot construct attribute.*--strict-getatt/s
    );
  });

  it('threads strictGetAtt into the resolver constructor', () => {
    makeEngine(true);
    expect(vi.mocked(IntrinsicFunctionResolver)).toHaveBeenCalledWith('us-east-1', {
      strictGetAtt: true,
    });
    makeEngine();
    expect(vi.mocked(IntrinsicFunctionResolver)).toHaveBeenLastCalledWith('us-east-1', {
      strictGetAtt: false,
    });
  });

  it('resets the fallback counter ONCE on the no-change path and surfaces it in the result', async () => {
    // Deliberate counting semantics (review of #1111 item 3): the no-change
    // path returns after the diff, so only the deploy()-start reset fires —
    // its surfaced count covers diff + output-resolution fallbacks (each
    // site resolved once, no double count possible without provisioning).
    // The change path resets a second time after the diff phase; see the
    // change-path describe block below.
    fallbackCountHolder.value = 3;
    const engine = makeEngine();
    const result = await engine.deploy(stackName, template);

    expect(resetSpy).toHaveBeenCalledTimes(1);
    expect(result.attributeFallbackCount).toBe(3);
  });

  it('reports zero fallbacks when none occurred', async () => {
    const engine = makeEngine();
    const result = await engine.deploy(stackName, template);
    expect(result.attributeFallbackCount).toBe(0);
  });
});

/**
 * Review blocker on issue #1111 item 2: the `--strict-getatt` output
 * rethrow fires AFTER the rollback catch block, so it would propagate
 * through `doDeploy`'s catch-less try and skip the final `saveState`. On a
 * FIRST deploy `currentEtag === undefined` makes the incremental
 * per-resource saves no-ops too — every created resource would exist in
 * AWS with ZERO state written (invisible orphans, no rollback, re-runs
 * collide with "already exists"). The engine must PERSIST STATE FIRST
 * (`persistStateAfterOutputFailure`), then rethrow. These tests exercise
 * the CHANGE path with a real provisioning loop (mocked provider) and
 * FAIL without the persist-before-rethrow fix.
 */
describe('DeployEngine - strict output failure persists provisioning state (#1111 review blocker)', () => {
  const stackName = 'strict-output-persist-stack';

  beforeEach(() => {
    vi.clearAllMocks();
    fallbackCountHolder.value = 0;
  });

  function createProvider() {
    return {
      create: vi.fn().mockImplementation((logicalId: string) =>
        Promise.resolve({ physicalId: `phys-${logicalId}`, attributes: {} })
      ),
      update: vi.fn().mockResolvedValue({ physicalId: 'phys-x', wasReplaced: false }),
      delete: vi.fn().mockResolvedValue(undefined),
    };
  }

  function makeCreateChange(logicalId: string, properties: Record<string, unknown> = {}) {
    return {
      logicalId,
      changeType: 'CREATE',
      resourceType: 'AWS::SSM::Parameter',
      // provisionResourceBody's CREATE arm resolves `desiredProperties`.
      desiredProperties: properties,
      propertyChanges: [],
    } as unknown as ResourceChange;
  }

  function buildChangePathEngine(opts: {
    priorState?: StackState;
    priorEtag?: string;
    changes: Map<string, ResourceChange>;
    template: CloudFormationTemplate;
    strictGetAtt?: boolean;
  }) {
    const provider = createProvider();
    const stateBackend = {
      getState: vi
        .fn()
        .mockResolvedValue(
          opts.priorState ? { state: opts.priorState, etag: opts.priorEtag ?? 'etag-0' } : null
        ),
      saveState: vi.fn().mockResolvedValue('etag-next'),
    };
    const lockManager = {
      acquireLockWithRetry: vi.fn().mockResolvedValue(true),
      releaseLock: vi.fn().mockResolvedValue(undefined),
    };
    const dagBuilder = {
      buildGraph: vi.fn().mockReturnValue({}),
      getExecutionLevels: vi.fn().mockReturnValue([[...opts.changes.keys()]]),
      getDirectDependencies: vi.fn().mockReturnValue([]),
    };
    const diffCalculator = {
      calculateDiff: vi.fn().mockResolvedValue(opts.changes),
      hasChanges: vi.fn().mockReturnValue(true),
      filterByType: vi
        .fn()
        .mockImplementation((changes: Map<string, ResourceChange>, type: string) =>
          Array.from(changes.values()).filter((c) => c.changeType === type)
        ),
    };
    const providerRegistry = {
      getProvider: vi.fn().mockReturnValue(provider),
      getProviderFor: vi.fn().mockReturnValue({ provider, provisionedBy: 'sdk' }),
      getRegisteredTypes: vi.fn().mockReturnValue([]),
      getCloudControlProvider: vi.fn(),
      validateResourceTypes: vi.fn(),
      validateResourceProperties: vi.fn(),
    };
    const engine = new DeployEngine(
      stateBackend as never,
      lockManager as never,
      dagBuilder as never,
      diffCalculator as never,
      providerRegistry as never,
      { concurrency: 2, ...(opts.strictGetAtt !== undefined && { strictGetAtt: opts.strictGetAtt }) },
      'us-east-1'
    );
    return { engine, stateBackend, provider };
  }

  it('FIRST deploy + strict + failing Output: deploy rejects AND state records the created resources', async () => {
    const template: CloudFormationTemplate = {
      Resources: { ResA: { Type: 'AWS::SSM::Parameter', Properties: { Value: 'x' } } },
      Outputs: { Bad: { Value: '__boom__' } },
    };
    const { engine, stateBackend, provider } = buildChangePathEngine({
      changes: new Map([['ResA', makeCreateChange('ResA', { Value: 'x' })]]),
      template,
      strictGetAtt: true,
    });

    await expect(engine.deploy(stackName, template)).rejects.toThrow(
      /Failed to resolve output Bad.*--strict-getatt/s
    );

    // The resource WAS created in AWS...
    expect(provider.create).toHaveBeenCalledWith('ResA', 'AWS::SSM::Parameter', expect.anything());
    // ...and (no prior etag → per-resource saves are no-ops, no rollback ran)
    // the failure persist is the ONLY save — without it, ZERO state is
    // written and ResA becomes an invisible orphan.
    expect(stateBackend.saveState).toHaveBeenCalledTimes(1);
    const savedState = stateBackend.saveState.mock.calls[0]![2] as StackState;
    expect(savedState.resources['ResA']).toMatchObject({
      physicalId: 'phys-ResA',
      resourceType: 'AWS::SSM::Parameter',
    });
    // No output map was produced — the persist keeps the (empty) prior outputs.
    expect(savedState.outputs).toEqual({});
    // Rollback must NOT have fired (provisioning succeeded).
    expect(provider.delete).not.toHaveBeenCalled();
  });

  it('UPDATE deploy + strict + failing Output: state reflects this run (new resource + recordedImports), outputs stay previous', async () => {
    const priorState: StackState = {
      version: STATE_SCHEMA_VERSION_CURRENT,
      region: 'us-east-1',
      stackName,
      resources: {
        Old: {
          physicalId: 'phys-old',
          resourceType: 'AWS::SSM::Parameter',
          properties: { Value: 'old' },
          attributes: {},
          dependencies: [],
        },
      },
      outputs: { Prev: 'prev-value' },
      lastModified: 0,
    };
    const template: CloudFormationTemplate = {
      Resources: {
        Old: { Type: 'AWS::SSM::Parameter', Properties: { Value: 'old' } },
        // `__record_import__` makes the mocked resolver append a
        // StateImportEntry to the engine's recordedImports bag — standing in
        // for an Fn::ImportValue resolved during THIS run's provisioning.
        ResB: { Type: 'AWS::SSM::Parameter', Properties: { Value: '__record_import__' } },
      },
      Outputs: { Bad: { Value: '__boom__' } },
    };
    const { engine, stateBackend } = buildChangePathEngine({
      priorState,
      priorEtag: 'etag-0',
      changes: new Map([['ResB', makeCreateChange('ResB', { Value: '__record_import__' })]]),
      template,
      strictGetAtt: true,
    });

    await expect(engine.deploy(stackName, template)).rejects.toThrow(/Failed to resolve output Bad/);

    // Last save = the failure persist. It must carry this run's changes:
    // the new resource, the run's recordedImports, and the PREVIOUS outputs
    // (no new output map was produced).
    const lastCall = stateBackend.saveState.mock.calls.at(-1)!;
    const savedState = lastCall[2] as StackState;
    expect(savedState.resources['ResB']).toMatchObject({ physicalId: 'phys-ResB' });
    expect(savedState.resources['Old']).toMatchObject({ physicalId: 'phys-old' });
    expect(savedState.imports).toEqual([
      {
        sourceStack: 'producer-stack',
        sourceRegion: 'us-east-1',
        exportName: 'producer-export',
      },
    ]);
    expect(savedState.outputs).toEqual({ Prev: 'prev-value' });
  });

  it('retries the failure persist with a fresh ETag on save conflict', async () => {
    const template: CloudFormationTemplate = {
      Resources: { ResA: { Type: 'AWS::SSM::Parameter', Properties: { Value: 'x' } } },
      Outputs: { Bad: { Value: '__boom__' } },
    };
    const { engine, stateBackend } = buildChangePathEngine({
      changes: new Map([['ResA', makeCreateChange('ResA', { Value: 'x' })]]),
      template,
      strictGetAtt: true,
    });
    stateBackend.saveState.mockRejectedValueOnce(new Error('PreconditionFailed'));

    await expect(engine.deploy(stackName, template)).rejects.toThrow(/Failed to resolve output Bad/);

    // First attempt failed → fresh-ETag retry must have landed the state.
    expect(stateBackend.saveState).toHaveBeenCalledTimes(2);
    const savedState = stateBackend.saveState.mock.calls[1]![2] as StackState;
    expect(savedState.resources['ResA']).toMatchObject({ physicalId: 'phys-ResA' });
  });

  it('change path resets the fallback counter twice (deploy start + post-diff) so diff-phase fallbacks are not double-counted', async () => {
    const template: CloudFormationTemplate = {
      Resources: { ResA: { Type: 'AWS::SSM::Parameter', Properties: { Value: 'x' } } },
      Outputs: { Good: { Value: 'ok' } },
    };
    const { engine } = buildChangePathEngine({
      changes: new Map([['ResA', makeCreateChange('ResA', { Value: 'x' })]]),
      template,
    });

    const result = await engine.deploy(stackName, template);

    // Reset #1 at deploy() start (covers the no-change/dry-run early
    // returns); reset #2 right after the diff phase, so the surfaced
    // change-path summary counts provisioning + output resolution only —
    // never a diff-time fallback a second time.
    expect(resetSpy).toHaveBeenCalledTimes(2);
    expect(result.created).toBe(1);
  });
});
