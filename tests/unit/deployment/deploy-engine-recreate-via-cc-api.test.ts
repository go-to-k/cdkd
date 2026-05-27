/**
 * Unit-level coverage of the `--recreate-via-cc-api` engine wire-through
 * (issue [#615]). The full happy path is verified end-to-end by
 * `tests/integration/recreate-via-cc-api/verify.sh`; this file covers
 * the failure path that the integ does NOT exercise:
 *
 *   - The destroy of the OLD resource throws → the engine re-throws
 *     (does NOT warn-and-continue, which is the legacy
 *     property-driven-replacement behavior). The re-throw is
 *     load-bearing — a swallowed destroy failure would produce a
 *     confusing `AlreadyExists` during the subsequent CREATE, since
 *     the recreate-via-cc-api path uses destroy-then-create ordering
 *     specifically because the user-supplied physical name collides
 *     with the still-alive old resource.
 *
 * Also covers the happy-path wire-through assertions a mocked test can
 * make cheaply:
 *
 *   - The destroy is called BEFORE the create (mocked provider
 *     instrumentation records the order).
 *   - The CREATE-side `getProviderFor` receives the synthetic
 *     `provisionedBy: 'cc-api'` hint so the sticky rule routes via CC
 *     even when the template carries no silent-drop property.
 *   - The DESTROY-side `getProviderFor` receives the RECORDED
 *     `provisionedBy` from existing state (SDK for the legacy case),
 *     so the destroy hits the right provider.
 *   - The new state record stamps `provisionedBy: 'cc-api'` so every
 *     subsequent op routes via CC (sticky).
 */

import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import type { CloudFormationTemplate, ResourceProvider } from '../../../src/types/resource.js';
import type { ResourceChange, StackState } from '../../../src/types/state.js';

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

vi.mock('p-limit', () => ({
  default: vi.fn(() => <T>(fn: () => T) => fn()),
}));

vi.mock('../../../src/deployment/intrinsic-function-resolver.js', () => ({
  IntrinsicFunctionResolver: vi.fn().mockImplementation(() => ({
    resolve: vi.fn().mockImplementation((value: unknown) => Promise.resolve(value)),
    resolveParameters: vi.fn().mockReturnValue({}),
    evaluateConditions: vi.fn().mockResolvedValue({}),
  })),
}));

// Bypass the per-resource-deadline wrapper so the recreate code path
// runs synchronously without the timer / `Promise.race` plumbing.
vi.mock('../../../src/deployment/resource-deadline.js', () => ({
  withResourceDeadline: vi.fn(async (operation: () => Promise<unknown>) => operation()),
}));

describe('DeployEngine — --recreate-via-cc-api wire-through (#615)', () => {
  let callOrder: string[];
  let sdkProvider: ResourceProvider;
  let ccProvider: ResourceProvider;
  let getProviderForCalls: Array<{
    resourceType: string;
    provisionedBy?: 'sdk' | 'cc-api';
    properties?: unknown;
  }>;

  beforeEach(() => {
    callOrder = [];
    getProviderForCalls = [];

    sdkProvider = {
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn().mockImplementation(async () => {
        callOrder.push('sdk.delete');
      }),
      getAttribute: vi.fn(),
    };
    ccProvider = {
      create: vi.fn().mockImplementation(async () => {
        callOrder.push('cc.create');
        return { physicalId: 'new-cc-pid', attributes: {} };
      }),
      update: vi.fn(),
      delete: vi.fn(),
      getAttribute: vi.fn(),
    };
  });

  function makeEngine(): InstanceType<typeof DeployEngine> {
    const mockStateBackend = {
      getState: vi.fn(),
      saveState: vi.fn().mockResolvedValue('etag-2'),
    };
    const mockLockManager = {
      acquireLockWithRetry: vi.fn().mockResolvedValue(true),
      releaseLock: vi.fn().mockResolvedValue(undefined),
    };
    const mockDagBuilder = {
      buildGraph: vi.fn().mockReturnValue({}),
      getExecutionLevels: vi.fn().mockReturnValue([]),
      getDirectDependencies: vi.fn().mockReturnValue([]),
    };
    const mockDiffCalculator = {
      calculateDiff: vi.fn().mockResolvedValue(new Map<string, ResourceChange>()),
      hasChanges: vi.fn().mockReturnValue(false),
      filterByType: vi.fn().mockReturnValue([]),
    };

    const mockProviderRegistry = {
      // Route based on the `provisionedBy` hint we pass — emulates the
      // real registry's rule 2 (sticky CC) without standing up the
      // whole property-coverage matrix.
      getProvider: vi.fn().mockReturnValue(sdkProvider),
      getProviderFor: vi.fn().mockImplementation((input: {
        resourceType: string;
        provisionedBy?: 'sdk' | 'cc-api';
        properties?: unknown;
      }) => {
        getProviderForCalls.push({
          resourceType: input.resourceType,
          ...(input.provisionedBy !== undefined && { provisionedBy: input.provisionedBy }),
          ...(input.properties !== undefined && { properties: input.properties }),
        });
        if (input.provisionedBy === 'cc-api') {
          return { provider: ccProvider, provisionedBy: 'cc-api' as const };
        }
        return { provider: sdkProvider, provisionedBy: 'sdk' as const };
      }),
      getRegisteredTypes: vi.fn().mockReturnValue([]),
      validateResourceTypes: vi.fn(),
      validateResourceProperties: vi.fn(),
    };

    return new DeployEngine(
      mockStateBackend as unknown as never,
      mockLockManager as unknown as never,
      mockDagBuilder as unknown as never,
      mockDiffCalculator as unknown as never,
      mockProviderRegistry as unknown as never,
      {
        recreateViaCcApiTargets: new Set(['MyLambda']),
      },
      'us-east-1'
    );
  }

  /**
   * Reach into the engine's private `provisionResource` to exercise
   * the UPDATE branch directly. Mirrors the call signature the
   * top-level `executeDeployment` path uses internally.
   */
  async function invokeProvision(
    engine: InstanceType<typeof DeployEngine>,
    change: ResourceChange,
    stateResources: Record<string, { physicalId: string; resourceType: string; properties: Record<string, unknown>; attributes: Record<string, unknown>; dependencies: string[]; provisionedBy?: 'sdk' | 'cc-api' }>,
    template: CloudFormationTemplate
  ): Promise<void> {
    type ProvisionResourceFn = (
      logicalId: string,
      change: ResourceChange,
      stateResources: Record<string, unknown>,
      stackName: string,
      template: CloudFormationTemplate
    ) => Promise<void>;
    const provisionResource = (
      engine as unknown as { provisionResource: ProvisionResourceFn }
    ).provisionResource.bind(engine);
    await provisionResource('MyLambda', change, stateResources, 'MyStack', template);
  }

  function makeUpdateChange(): ResourceChange {
    return {
      logicalId: 'MyLambda',
      changeType: 'UPDATE',
      resourceType: 'AWS::Lambda::Function',
      // Desired must differ from current so the early no-op short-circuit
      // (JSON.stringify-equality skip) does NOT fire and the recreate
      // replacement code path actually runs.
      currentProperties: { Runtime: 'nodejs20.x' },
      desiredProperties: { Runtime: 'nodejs22.x' },
      // No `requiresReplacement: true` — the recreate flag is the
      // only signal driving the replacement code path.
      propertyChanges: [
        { path: 'Runtime', oldValue: 'nodejs20.x', newValue: 'nodejs22.x', requiresReplacement: false },
      ],
    };
  }

  function makeState(): Record<
    string,
    {
      physicalId: string;
      resourceType: string;
      properties: Record<string, unknown>;
      attributes: Record<string, unknown>;
      dependencies: string[];
      provisionedBy?: 'sdk' | 'cc-api';
    }
  > {
    return {
      MyLambda: {
        physicalId: 'old-sdk-pid',
        resourceType: 'AWS::Lambda::Function',
        properties: { Runtime: 'nodejs20.x' },
        attributes: {},
        dependencies: [],
        provisionedBy: 'sdk',
      },
    };
  }

  function makeTemplate(): CloudFormationTemplate {
    return {
      Resources: {
        MyLambda: {
          Type: 'AWS::Lambda::Function',
          Properties: { Runtime: 'nodejs20.x' },
        },
      },
    };
  }

  it('destroys the OLD resource BEFORE creating the new one (destroy-then-create order)', async () => {
    const engine = makeEngine();
    await invokeProvision(engine, makeUpdateChange(), makeState(), makeTemplate());
    expect(callOrder).toEqual(['sdk.delete', 'cc.create']);
  });

  it('routes the destroy via the recorded provisionedBy (SDK) AND the create via the forced cc-api hint', async () => {
    const engine = makeEngine();
    await invokeProvision(engine, makeUpdateChange(), makeState(), makeTemplate());
    // First getProviderFor call: the live-progress label's peek (CREATE/UPDATE
    // routes via getProviderFor with the recorded sticky provisionedBy hint).
    // Subsequent calls: the replace-decision (provisionedBy: 'cc-api' forced)
    // and the old-delete-provider (recorded 'sdk').
    const replaceCall = getProviderForCalls.find(
      (c) => c.provisionedBy === 'cc-api'
    );
    const destroyCall = getProviderForCalls.find(
      (c) => c.provisionedBy === 'sdk' && c.properties === undefined
    );
    expect(replaceCall).toBeDefined();
    expect(destroyCall).toBeDefined();
  });

  it('stamps the new state record with provisionedBy: cc-api so subsequent deploys take the sticky CC path', async () => {
    const engine = makeEngine();
    const state = makeState();
    await invokeProvision(engine, makeUpdateChange(), state, makeTemplate());
    expect(state.MyLambda?.provisionedBy).toBe('cc-api');
    expect(state.MyLambda?.physicalId).toBe('new-cc-pid');
  });

  it('re-throws when the destroy fails — does NOT warn-and-continue (load-bearing for the destroy-then-create path)', async () => {
    // Override sdkProvider.delete to reject.
    sdkProvider.delete = vi.fn().mockImplementation(async () => {
      throw new Error('AWS SDK: ResourceNotFoundException (transient)');
    });
    const engine = makeEngine();
    // The engine's provisionResource catch wraps errors in
    // ProvisioningError; the original "Failed to destroy old resource"
    // is the `cause`. Both the wrapped surface AND the inner cause
    // matter: the inner message proves the recreate-specific re-throw
    // fired (not a swallowed-then-failed-create chain), and the wrap
    // means the deploy engine's standard rollback path treats the
    // failure consistently with other provisioning failures.
    try {
      await invokeProvision(engine, makeUpdateChange(), makeState(), makeTemplate());
      throw new Error('expected provisionResource to throw');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).toMatch(/Failed to update resource MyLambda/);
      const cause = error instanceof Error ? (error as Error & { cause?: Error }).cause : undefined;
      const causeMsg = cause instanceof Error ? cause.message : String(cause);
      expect(causeMsg).toMatch(/Failed to destroy old resource MyLambda/);
    }
    // The re-throw fires BEFORE any create attempt — verifies the
    // engine doesn't swallow-and-create-anyway (which would hit the
    // AlreadyExists collision the destroy-then-create order was designed
    // to avoid).
    expect(ccProvider.create).not.toHaveBeenCalled();
  });
});
