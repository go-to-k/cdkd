/**
 * Unit-level coverage of the `--recreate-via-sdk-provider` engine
 * wire-through (issue [#651]). Mirror of
 * `deploy-engine-recreate-via-cc-api.test.ts` with the routing direction
 * flipped:
 *
 *   - Baseline state has `provisionedBy: 'cc-api'` (the resource landed
 *     on CC because cdkd auto-routed a silent-drop property).
 *   - The deploy engine receives the resource via
 *     `recreateViaSdkProviderTargets` (NOT `recreateViaCcApiTargets`).
 *   - The destroy uses the recorded `provisionedBy: 'cc-api'` provider.
 *   - The create's `getProviderFor` call receives the synthetic hint
 *     `provisionedBy: 'sdk'` so routing returns the SDK provider.
 *   - The new state record stamps `provisionedBy: 'sdk'` so every
 *     subsequent op stays on SDK.
 *
 * Also covers the failure path: a destroy throw re-throws (does NOT
 * warn-and-continue), same as the forward direction.
 */

import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import type { CloudFormationTemplate, ResourceProvider } from '../../../src/types/resource.js';
import type { ResourceChange } from '../../../src/types/state.js';

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
    getPhysicalIdFallbackCount: vi.fn().mockReturnValue(0),
    resetPhysicalIdFallbackCount: vi.fn(),
    resolve: vi.fn().mockImplementation((value: unknown) => Promise.resolve(value)),
    resolveParameters: vi.fn().mockReturnValue({}),
    evaluateConditions: vi.fn().mockResolvedValue({}),
  })),
}));

vi.mock('../../../src/deployment/resource-deadline.js', () => ({
  withResourceDeadline: vi.fn(async (operation: () => Promise<unknown>) => operation()),
}));

describe('DeployEngine — --recreate-via-sdk-provider wire-through (#651)', () => {
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
      create: vi.fn().mockImplementation(async () => {
        callOrder.push('sdk.create');
        return { physicalId: 'new-sdk-pid', attributes: {} };
      }),
      update: vi.fn(),
      delete: vi.fn(),
      getAttribute: vi.fn(),
    };
    ccProvider = {
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn().mockImplementation(async () => {
        callOrder.push('cc.delete');
      }),
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
        // Reverse direction: when `provisionedBy: 'cc-api'` is passed
        // (the destroy lookup for the legacy CC-managed copy), return
        // the CC provider. When `provisionedBy: 'sdk'` is passed (the
        // create-side hint forced by the recreate flag), return the
        // SDK provider — this is the assertion target for #651.
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
        recreateViaSdkProviderTargets: new Set(['MyLambda']),
      },
      'us-east-1'
    );
  }

  async function invokeProvision(
    engine: InstanceType<typeof DeployEngine>,
    change: ResourceChange,
    stateResources: Record<
      string,
      {
        physicalId: string;
        resourceType: string;
        properties: Record<string, unknown>;
        attributes: Record<string, unknown>;
        dependencies: string[];
        provisionedBy?: 'sdk' | 'cc-api';
      }
    >,
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
      currentProperties: { Runtime: 'nodejs20.x' },
      desiredProperties: { Runtime: 'nodejs22.x' },
      propertyChanges: [
        {
          path: 'Runtime',
          oldValue: 'nodejs20.x',
          newValue: 'nodejs22.x',
          requiresReplacement: false,
        },
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
        physicalId: 'old-cc-pid',
        resourceType: 'AWS::Lambda::Function',
        properties: { Runtime: 'nodejs20.x' },
        attributes: {},
        dependencies: [],
        provisionedBy: 'cc-api',
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
    expect(callOrder).toEqual(['cc.delete', 'sdk.create']);
  });

  it('the destroy-then-create re-create passes a masker-ONLY context, never replayingState (#1463 inverse fence)', async () => {
    // `CreateContext.replayingState` is the rollback executor's signal that a
    // create replays a cdkd STATE record, and a provider pre-flight refusal
    // DOWNGRADES to a warning when it is set. `--recreate-via-*` re-creates
    // from freshly resolved TEMPLATE properties, so it must never set it —
    // the refusal has to stand where the user can fix the input.
    //
    // Pinned by the context's EXACT key set, not by value: a reviewer injected
    // `{ replayingState: true }` at each deploy-engine create site and the full
    // suite stayed green, so nothing pinned this direction. This used to assert
    // `call.length === 3` — no 4th argument at all — which issue #1932 item 3
    // made impossible: every create site now carries a `maskSecrets` capability
    // so a provider warn cannot echo a resolved secret. Asserting the key set is
    // EXACTLY `['maskSecrets']` keeps the original fence's power (it fails on
    // `replayingState`, and on any OTHER field a future edit adds) while
    // admitting the one field that is deliberately universal.
    const engine = makeEngine();
    await invokeProvision(engine, makeUpdateChange(), makeState(), makeTemplate());
    const calls = vi.mocked(sdkProvider.create).mock.calls;
    expect(calls).toHaveLength(1);
    for (const call of calls) {
      expect(call).toHaveLength(4);
      // Exactly the masker, nothing else. `replayingState` in here would mean a
      // template-driven replacement had started claiming to be a state replay.
      expect(Object.keys((call[3] ?? {}) as Record<string, unknown>)).toEqual(['maskSecrets']);
    }
  });

  it('routes the destroy via the recorded provisionedBy (cc-api) AND the create via the forced sdk hint', async () => {
    const engine = makeEngine();
    await invokeProvision(engine, makeUpdateChange(), makeState(), makeTemplate());
    const replaceCall = getProviderForCalls.find((c) => c.provisionedBy === 'sdk');
    const destroyCall = getProviderForCalls.find(
      (c) => c.provisionedBy === 'cc-api' && c.properties === undefined
    );
    expect(replaceCall).toBeDefined();
    expect(destroyCall).toBeDefined();
  });

  it('stamps the new state record with provisionedBy: sdk so subsequent deploys stay on SDK', async () => {
    const engine = makeEngine();
    const state = makeState();
    await invokeProvision(engine, makeUpdateChange(), state, makeTemplate());
    expect(state.MyLambda?.provisionedBy).toBe('sdk');
    expect(state.MyLambda?.physicalId).toBe('new-sdk-pid');
  });

  it('retries the re-create through the SQS QueueDeletedRecently cooldown (issue #1214)', async () => {
    // The destroy-then-create order just released the old name, so a
    // custom-named SQS-like re-create can hit the 60s cooldown.
    //
    // The error-CODE form used to be what isolated the OUTER filter: only
    // `isNameCooldownError` matched it, so the inner generic retry rethrew
    // immediately and this assertion could only pass through
    // `isRecreateRetryableError` (the fix under test). Issue
    // [#2116](https://github.com/go-to-k/cdkd/issues/2116) put every cooldown
    // spelling into the generic table too -- deliberately, so an ordinary
    // create in a fresh process rides the window out as well -- and that
    // falsified the sentence this comment used to carry. MEASURED, not
    // assumed: with `isRecreateRetryableError` cut back to collision-only,
    // this suite passed 18/18 (6 of 6 tests in the file's own count) with the
    // outer filter doing nothing.
    //
    // `disableOuterRetry` restores the isolation: it makes
    // `DeployEngine.withRetry` single-shot, so the ONLY thing that can absorb
    // the cooldown is the outer `isRecreateRetryableError` loop. Same repair
    // as the twin case in
    // `deploy-engine-named-replacement-collision.test.ts`.
    sdkProvider.disableOuterRetry = true;
    let failures = 1;
    sdkProvider.create = vi.fn().mockImplementation(async () => {
      callOrder.push('sdk.create');
      if (failures-- > 0) {
        throw new Error(
          'Failed to create SQS queue MyLambda: AWS.SimpleQueueService.QueueDeletedRecently'
        );
      }
      return { physicalId: 'new-sdk-pid', attributes: {} };
    });
    const engine = makeEngine();
    const state = makeState();
    await invokeProvision(engine, makeUpdateChange(), state, makeTemplate());
    expect(callOrder).toEqual(['cc.delete', 'sdk.create', 'sdk.create']);
    expect(state.MyLambda?.physicalId).toBe('new-sdk-pid');
  }, 15_000);

  it('re-throws when the destroy fails — does NOT warn-and-continue (load-bearing for the destroy-then-create path)', async () => {
    // Override ccProvider.delete to reject (the legacy CC-managed copy
    // is destroyed via the CC provider in the reverse direction).
    ccProvider.delete = vi.fn().mockImplementation(async () => {
      throw new Error('CC API: HandlerErrorCode.NotFound (transient)');
    });
    const engine = makeEngine();
    try {
      await invokeProvision(engine, makeUpdateChange(), makeState(), makeTemplate());
      throw new Error('expected provisionResource to throw');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).toMatch(/Failed to update resource MyLambda/);
      const cause = error instanceof Error ? (error as Error & { cause?: Error }).cause : undefined;
      const causeMsg = cause instanceof Error ? cause.message : String(cause);
      expect(causeMsg).toMatch(/Failed to destroy old resource MyLambda/);
      expect(causeMsg).toMatch(/--recreate-via-sdk-provider/);
    }
    expect(sdkProvider.create).not.toHaveBeenCalled();
  });
});
