import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { ResourceChange, ResourceState, StackState } from '../../../src/types/state.js';

vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  }),
}));

vi.mock('../../../src/deployment/intrinsic-function-resolver.js', () => ({
  IntrinsicFunctionResolver: vi.fn().mockImplementation(() => ({
    getPhysicalIdFallbackCount: vi.fn().mockReturnValue(0),
    resetPhysicalIdFallbackCount: vi.fn(),
    resolve: vi.fn().mockImplementation((props: unknown) => Promise.resolve(props)),
    resolveParameters: vi.fn().mockReturnValue({}),
    evaluateConditions: vi.fn().mockResolvedValue({}),
  })),
}));

vi.mock('../../../src/provisioning/cloud-control-provider.js', () => ({
  CloudControlProvider: {
    isSupportedResourceType: vi.fn(() => true),
  },
}));

describe('DeployEngine - Rollback (event-driven dispatch)', () => {
  const stackName = 'rollback-test';

  function createSdkProvider(failOn?: Set<string>) {
    return {
      create: vi.fn().mockImplementation((logicalId: string) => {
        if (failOn?.has(logicalId)) {
          return Promise.reject(new Error(`create failed: ${logicalId}`));
        }
        return Promise.resolve({
          physicalId: `phys-${logicalId}`,
          attributes: {},
        });
      }),
      update: vi.fn().mockResolvedValue({ physicalId: 'phys-x', wasReplaced: false }),
      delete: vi.fn().mockResolvedValue(undefined),
    };
  }

  function makeChange(logicalId: string, type: string): ResourceChange {
    return {
      logicalId,
      changeType: 'CREATE',
      resourceType: type,
      newProperties: {},
      propertyChanges: [],
    };
  }

  let mockProvider: ReturnType<typeof createSdkProvider>;
  let deleteCalls: string[];

  beforeEach(() => {
    vi.clearAllMocks();
    deleteCalls = [];
  });

  let mockStateBackend: {
    getState: ReturnType<typeof vi.fn>;
    saveState: ReturnType<typeof vi.fn>;
  };

  function buildEngine(opts: {
    template: CloudFormationTemplate;
    changes: Map<string, ResourceChange>;
    deps: Record<string, string[]>;
    failOn?: Set<string>;
    deleteFailOn?: Set<string>;
    noRollback?: boolean;
    currentResources?: Record<string, ResourceState>;
  }) {
    mockProvider = createSdkProvider(opts.failOn);
    // Track delete calls in order so we can verify rollback behavior.
    // ResourceProvider.delete signature: (logicalId, physicalId, resourceType, properties?)
    mockProvider.delete = vi.fn().mockImplementation(async (logicalId: string) => {
      if (opts.deleteFailOn?.has(logicalId)) {
        throw new Error(`delete failed: ${logicalId}`);
      }
      deleteCalls.push(logicalId);
    });

    const currentState: StackState = {
      version: 1,
      stackName,
      resources: opts.currentResources ?? {},
      outputs: {},
      lastModified: Date.now(),
    };

    mockStateBackend = {
      getState: vi.fn().mockResolvedValue({ state: currentState, etag: 'etag-0' }),
      saveState: vi.fn().mockResolvedValue('etag-1'),
    };

    const mockLockManager = {
      acquireLockWithRetry: vi.fn().mockResolvedValue(true),
      releaseLock: vi.fn().mockResolvedValue(undefined),
    };

    const mockDagBuilder = {
      buildGraph: vi.fn().mockReturnValue({}),
      getExecutionLevels: vi.fn().mockReturnValue([Object.keys(opts.deps)]),
      getDirectDependencies: vi.fn((_dag: unknown, id: string) => opts.deps[id] ?? []),
    };

    const mockDiffCalculator = {
      calculateDiff: vi.fn().mockResolvedValue(opts.changes),
      hasChanges: vi.fn().mockReturnValue(true),
      filterByType: vi.fn().mockImplementation(
        (changes: Map<string, ResourceChange>, type: string) =>
          [...changes.values()].filter((c) => c.changeType === type)
      ),
    };

    const mockProviderRegistry = {
      getProvider: vi.fn().mockReturnValue(mockProvider),
      getProviderFor: vi.fn().mockReturnValue({ provider: mockProvider, provisionedBy: 'sdk' }),
      getRegisteredTypes: vi.fn().mockReturnValue([]),
      getCloudControlProvider: vi.fn(),
      validateResourceTypes: vi.fn(),
      validateResourceProperties: vi.fn(),
    };

    return new DeployEngine(
      mockStateBackend as never,
      mockLockManager as never,
      mockDagBuilder as never,
      mockDiffCalculator as never,
      mockProviderRegistry as never,
      { concurrency: 4, noRollback: opts.noRollback ?? false },
      'us-east-1'
    );
  }

  it('rolls back already-CREATEd siblings when one independent resource fails', async () => {
    // A, B, C are independent. C fails. A and B succeed → both must be rolled back.
    const template: CloudFormationTemplate = {
      Resources: {
        A: { Type: 'AWS::S3::Bucket', Properties: {} },
        B: { Type: 'AWS::S3::Bucket', Properties: {} },
        C: { Type: 'AWS::S3::Bucket', Properties: {} },
      },
    };
    const changes = new Map<string, ResourceChange>([
      ['A', makeChange('A', 'AWS::S3::Bucket')],
      ['B', makeChange('B', 'AWS::S3::Bucket')],
      ['C', makeChange('C', 'AWS::S3::Bucket')],
    ]);

    const engine = buildEngine({
      template,
      changes,
      deps: { A: [], B: [], C: [] },
      failOn: new Set(['C']),
    });

    await expect(engine.deploy(stackName, template)).rejects.toThrow(/Failed to create resource C/);

    // A and B should have been rolled back (delete called).
    // C never succeeded, so it is NOT rolled back.
    expect(deleteCalls.sort()).toEqual(['A', 'B']);
  });

  it('rolls back upstream successes when a downstream dependency fails', async () => {
    // A → B → C chain. B fails. A succeeded → A is rolled back.
    // C is "skipped" (never started) due to B's failure → C is NOT rolled back.
    const template: CloudFormationTemplate = {
      Resources: {
        A: { Type: 'AWS::S3::Bucket', Properties: {} },
        B: { Type: 'AWS::S3::Bucket', Properties: {} },
        C: { Type: 'AWS::S3::Bucket', Properties: {} },
      },
    };
    const changes = new Map<string, ResourceChange>([
      ['A', makeChange('A', 'AWS::S3::Bucket')],
      ['B', makeChange('B', 'AWS::S3::Bucket')],
      ['C', makeChange('C', 'AWS::S3::Bucket')],
    ]);

    const engine = buildEngine({
      template,
      changes,
      deps: { A: [], B: ['A'], C: ['B'] },
      failOn: new Set(['B']),
    });

    await expect(engine.deploy(stackName, template)).rejects.toThrow(/Failed to create resource B/);

    // Only A was successfully created → only A is rolled back
    expect(deleteCalls).toEqual(['A']);
    // B failed mid-create — provider.create was called but no rollback delete on B
    // (failed resource has no physicalId in completedOperations)
    expect(mockProvider.create).toHaveBeenCalledWith('B', 'AWS::S3::Bucket', expect.any(Object));
    // C was never started (skipped due to B failure)
    expect(mockProvider.create).not.toHaveBeenCalledWith('C', expect.any(String), expect.any(Object));
  });

  it('rolls back deeper successes in dependency order (dependents deleted before deps)', async () => {
    // A → B succeed. C (depends on B) fails. → Rollback must delete B before A,
    // because B depends on A in CREATE direction (so A has more dependents).
    // DependsOn captured in state.dependencies drives the rollback delete order.
    const template: CloudFormationTemplate = {
      Resources: {
        A: { Type: 'AWS::S3::Bucket', Properties: {} },
        B: { Type: 'AWS::S3::Bucket', Properties: {}, DependsOn: ['A'] },
        C: { Type: 'AWS::S3::Bucket', Properties: {}, DependsOn: ['B'] },
      },
    };
    const changes = new Map<string, ResourceChange>([
      ['A', makeChange('A', 'AWS::S3::Bucket')],
      ['B', makeChange('B', 'AWS::S3::Bucket')],
      ['C', makeChange('C', 'AWS::S3::Bucket')],
    ]);

    const engine = buildEngine({
      template,
      changes,
      deps: { A: [], B: ['A'], C: ['B'] },
      failOn: new Set(['C']),
    });

    await expect(engine.deploy(stackName, template)).rejects.toThrow(/Failed to create resource C/);

    // Both A and B were created → both rolled back, B before A (reverse dep order)
    expect(deleteCalls).toEqual(['B', 'A']);
  });

  it('skips rollback when noRollback option is set', async () => {
    const template: CloudFormationTemplate = {
      Resources: {
        A: { Type: 'AWS::S3::Bucket', Properties: {} },
        B: { Type: 'AWS::S3::Bucket', Properties: {} },
      },
    };
    const changes = new Map<string, ResourceChange>([
      ['A', makeChange('A', 'AWS::S3::Bucket')],
      ['B', makeChange('B', 'AWS::S3::Bucket')],
    ]);

    const engine = buildEngine({
      template,
      changes,
      deps: { A: [], B: [] },
      failOn: new Set(['B']),
      noRollback: true,
    });

    await expect(engine.deploy(stackName, template)).rejects.toThrow(/Failed to create resource B/);
    expect(deleteCalls).toEqual([]);
  });

  it('saves state reflecting partial deletion when a DELETE fails mid-phase', async () => {
    // 3 DELETE changes dispatched concurrently. provider.delete throws for B.
    // A and C complete normally. Pre-rollback state save (in deploy-engine's
    // catch path) MUST reflect that A and C are gone but B remains — otherwise
    // the next deploy will think A/C still exist and skip them, leaving them
    // orphaned in AWS.
    const template: CloudFormationTemplate = { Resources: {} }; // empty new template = all DELETE
    const changes = new Map<string, ResourceChange>([
      ['A', { ...makeChange('A', 'AWS::S3::Bucket'), changeType: 'DELETE' }],
      ['B', { ...makeChange('B', 'AWS::S3::Bucket'), changeType: 'DELETE' }],
      ['C', { ...makeChange('C', 'AWS::S3::Bucket'), changeType: 'DELETE' }],
    ]);
    const currentResources: Record<string, ResourceState> = {
      A: { physicalId: 'phys-A', resourceType: 'AWS::S3::Bucket', properties: {} },
      B: { physicalId: 'phys-B', resourceType: 'AWS::S3::Bucket', properties: {} },
      C: { physicalId: 'phys-C', resourceType: 'AWS::S3::Bucket', properties: {} },
    };

    const engine = buildEngine({
      template,
      changes,
      deps: { A: [], B: [], C: [] },
      deleteFailOn: new Set(['B']),
      currentResources,
      noRollback: true, // suppress no-op DELETE rollback path; focus on state save
    });

    await expect(engine.deploy(stackName, template)).rejects.toThrow(/Failed to delete resource B/);

    // Inspect the most recent saveState call (could be pre-rollback or post-).
    const calls = mockStateBackend.saveState.mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    // saveState now: (stackName, region, state, options) — state is index 2.
    const finalSavedState = calls[calls.length - 1]![2] as StackState;

    // A and C deleted from state; B remains because its delete failed.
    expect(finalSavedState.resources['A']).toBeUndefined();
    expect(finalSavedState.resources['C']).toBeUndefined();
    expect(finalSavedState.resources['B']).toBeDefined();
  });

  it('CC-routed CREATE rollback dispatches via the CC provider, not the SDK provider (#614)', async () => {
    // A CREATE that auto-routed to CC API (because the template had a
    // silent-drop property) must roll back via the CC provider's delete.
    // Pre-#614, rollback used `getProvider(resourceType)` which is the
    // SDK provider — a CC-managed Lambda being rolled back via the SDK
    // would try to delete with the wrong API + wrong identifier
    // semantics. This test pins the threading of `provisionedBy` from
    // the routing decision into `CompletedOperation` and into the
    // rollback dispatch.
    const template: CloudFormationTemplate = {
      Resources: {
        CcRouted: { Type: 'AWS::Lambda::Function', Properties: {} },
        Failing: { Type: 'AWS::S3::Bucket', Properties: {} },
      },
    };
    const changes = new Map<string, ResourceChange>([
      ['CcRouted', makeChange('CcRouted', 'AWS::Lambda::Function')],
      ['Failing', makeChange('Failing', 'AWS::S3::Bucket')],
    ]);

    // The two providers track their delete calls separately so the test
    // can assert WHICH provider rolled back the CC-routed resource.
    const sdkProvider = createSdkProvider(new Set(['Failing']));
    const ccDeleteCalls: string[] = [];
    const ccProvider = {
      create: vi.fn().mockImplementation((logicalId: string) =>
        Promise.resolve({ physicalId: `cc-phys-${logicalId}`, attributes: {} })
      ),
      update: vi.fn().mockResolvedValue({ physicalId: 'cc-phys-x', wasReplaced: false }),
      delete: vi.fn().mockImplementation(async (logicalId: string) => {
        ccDeleteCalls.push(logicalId);
      }),
    };

    const mockStateBackendLocal = {
      getState: vi.fn().mockResolvedValue({
        state: {
          version: 7,
          stackName,
          resources: {},
          outputs: {},
          lastModified: Date.now(),
        } satisfies StackState,
        etag: 'etag-0',
      }),
      saveState: vi.fn().mockResolvedValue('etag-1'),
    };

    const mockLockManager = {
      acquireLockWithRetry: vi.fn().mockResolvedValue(true),
      releaseLock: vi.fn().mockResolvedValue(undefined),
    };

    const mockDagBuilder = {
      buildGraph: vi.fn().mockReturnValue({}),
      getExecutionLevels: vi.fn().mockReturnValue([['CcRouted', 'Failing']]),
      getDirectDependencies: vi.fn(() => []),
    };

    const mockDiffCalculator = {
      calculateDiff: vi.fn().mockResolvedValue(changes),
      hasChanges: vi.fn().mockReturnValue(true),
      filterByType: vi.fn().mockImplementation(
        (chs: Map<string, ResourceChange>, type: string) =>
          [...chs.values()].filter((c) => c.changeType === type)
      ),
    };

    // The registry routes CcRouted via CC (provisionedBy='cc-api') and
    // Failing via SDK. The rollback path must then route CcRouted's
    // delete back to the CC provider via `provisionedBy: 'cc-api'`.
    const mockProviderRegistry = {
      getProvider: vi.fn().mockReturnValue(sdkProvider),
      getProviderFor: vi.fn().mockImplementation(
        (input: { resourceType: string; provisionedBy?: 'sdk' | 'cc-api' }) => {
          if (input.provisionedBy === 'cc-api') {
            return { provider: ccProvider, provisionedBy: 'cc-api' };
          }
          if (input.resourceType === 'AWS::Lambda::Function') {
            // Fresh CREATE → routes to CC because of (notional) silent-drop.
            return {
              provider: ccProvider,
              provisionedBy: 'cc-api',
              ccRouteReason: { properties: ['LoggingConfig'] },
            };
          }
          return { provider: sdkProvider, provisionedBy: 'sdk' };
        }
      ),
      getRegisteredTypes: vi.fn().mockReturnValue([]),
      getCloudControlProvider: vi.fn(),
      validateResourceTypes: vi.fn(),
      validateResourceProperties: vi.fn(),
    };

    const engine = new DeployEngine(
      mockStateBackendLocal as never,
      mockLockManager as never,
      mockDagBuilder as never,
      mockDiffCalculator as never,
      mockProviderRegistry as never,
      { concurrency: 4, noRollback: false },
      'us-east-1'
    );

    await expect(engine.deploy(stackName, template)).rejects.toThrow(
      /Failed to create resource Failing/
    );

    // Both providers' create() ran: CcRouted via CC, Failing via SDK.
    expect(ccProvider.create).toHaveBeenCalledWith(
      'CcRouted',
      'AWS::Lambda::Function',
      expect.any(Object)
    );
    expect(sdkProvider.create).toHaveBeenCalledWith(
      'Failing',
      'AWS::S3::Bucket',
      expect.any(Object)
    );

    // The rollback delete for CcRouted MUST have gone through the CC
    // provider, not the SDK provider. This is the load-bearing
    // assertion that closes the silent-data-corruption hazard #614's
    // schema bump was meant to prevent.
    expect(ccDeleteCalls).toContain('CcRouted');
    expect(sdkProvider.delete).not.toHaveBeenCalledWith(
      'CcRouted',
      expect.any(String),
      expect.any(String),
      expect.any(Object),
      expect.any(Object)
    );
  });
});
