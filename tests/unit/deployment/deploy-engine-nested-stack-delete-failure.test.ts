/**
 * DeployEngine DELETE branch — a nested stack whose child destroy FAILED
 * (issue https://github.com/go-to-k/cdkd/issues/1777, deploy-side reach).
 *
 * Removing an `AWS::CloudFormation::Stack` from the synth template routes that
 * row through the engine's DELETE branch, which calls the SAME
 * `NestedStackProvider.delete` that `cdkd destroy` does. #1777 made that method
 * THROW when the child stack's own destroy reported `errorCount > 0`, so the
 * blast radius is wider than the destroy path alone: a `cdkd deploy` that drops
 * a nested stack whose child cannot be destroyed now FAILS the deploy (and
 * triggers its rollback) where it previously recorded the row as deleted and
 * carried on.
 *
 * That asymmetry is the point, and it is why this file exists rather than being
 * folded into the destroy-side coverage: a `{ outcome: 'skipped' }` RETURN value
 * is still discarded by this call site (issue #1762), so the skip half of #1752
 * genuinely does not reach here — but a THROW cannot be discarded by anyone.
 *
 * These tests drive the engine's private `provisionResource` with a fake
 * provider, exactly like `deploy-engine-deletion-policy-snapshot.test.ts`
 * (whose harness this mirrors). `src/deployment/deploy-engine.ts` is NOT
 * modified by #1777 — what is pinned here is that the engine propagates the
 * provider's throw instead of swallowing it, and keeps the state record.
 *
 * SCOPE, stated because it is easy to over-read: like the destroy-side runner
 * file, these cases are PROBE-INERT for #1777's own fix — the provider is faked
 * here, so they pass identically against pre-#1777 code and the fix's mutation
 * probes do not turn them red. The fix's fence is the provider-level rows in
 * tests/unit/provisioning/nested-stack-provider.test.ts. What THIS file fences
 * is the deploy-side CONSEQUENCE of that throw, which is the half of the blast
 * radius a reader of the destroy-side tests would otherwise never see.
 */

import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
// Leaf module, deliberately NOT `providers/nested-stack-provider.js`: that path
// drags destroy-runner -> register-providers -> every provider into this
// deploy-engine unit test and closes an import cycle.
import { nestedStackChildFailureMessage } from '../../../src/provisioning/nested-stack-messages.js';
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

vi.mock('../../../src/deployment/resource-deadline.js', () => ({
  withResourceDeadline: vi.fn(async (operation: () => Promise<unknown>) => operation()),
}));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({}),
  setAwsClients: vi.fn(),
  AwsClients: vi.fn(),
}));

const NESTED_TYPE = 'AWS::CloudFormation::Stack';
/** The REAL message the provider throws — imported, never hand-copied. */
const CHILD_FAILURE_MESSAGE = nestedStackChildFailureMessage('MyStack~Child', 1, 0, false);

describe('DeployEngine DELETE branch — nested stack whose child failed (#1777)', () => {
  let deleteProvider: ResourceProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    deleteProvider = {
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn().mockResolvedValue(undefined),
      getAttribute: vi.fn(),
      // The real NestedStackProvider sets this (its child engine owns retry /
      // rollback), and the engine honors it — so production runs the delete
      // once. Without it this harness would exercise the outer retry loop, a
      // different code path.
      disableOuterRetry: true,
    } as unknown as ResourceProvider;
  });

  function makeEngine(): InstanceType<typeof DeployEngine> {
    const mockStateBackend = {
      getState: vi.fn(),
      saveState: vi.fn().mockResolvedValue('etag'),
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
      calculateDiff: vi.fn().mockResolvedValue(new Map()),
      hasChanges: vi.fn().mockReturnValue(false),
      filterByType: vi.fn().mockReturnValue([]),
    };
    const mockProviderRegistry = {
      getProvider: vi.fn().mockReturnValue(deleteProvider),
      getProviderFor: vi.fn().mockReturnValue({ provider: deleteProvider, provisionedBy: 'sdk' }),
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
      {},
      'us-east-1'
    );
  }

  /** Drive the DELETE branch for a nested-stack row removed from the template. */
  async function invokeNestedDelete(
    engine: InstanceType<typeof DeployEngine>
  ): Promise<{ run: Promise<void>; stateResources: Record<string, unknown> }> {
    const change: ResourceChange = {
      logicalId: 'Child',
      changeType: 'DELETE',
      resourceType: NESTED_TYPE,
      currentProperties: {},
    };
    const stateResources: Record<string, unknown> = {
      Child: {
        physicalId: 'arn:cdkd-local:us-east-1:123456789012:nested-stack/MyStack/Child',
        resourceType: NESTED_TYPE,
        properties: {},
        attributes: {},
        dependencies: [],
      },
    };
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
    // The template no longer declares the nested stack — that IS the removal.
    const run = provisionResource('Child', change, stateResources, 'MyStack', { Resources: {} });
    return { run, stateResources };
  }

  it("propagates the provider's throw — the deploy FAILS instead of recording the row deleted", async () => {
    (deleteProvider.delete as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error(CHILD_FAILURE_MESSAGE)
    );

    const { run, stateResources } = await invokeNestedDelete(makeEngine());

    // The engine re-wraps a failed delete as `Failed to delete resource <id>`
    // (its ordinary failure path for ANY resource type — which is exactly the
    // parity #1777 wants), keeping the provider's message on the cause chain.
    const err = await run.then(
      () => undefined,
      (e: unknown) => e as Error & { cause?: unknown }
    );
    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toContain('Failed to delete resource Child');
    expect(String((err!.cause as Error | undefined)?.message)).toContain(
      'Nested stack MyStack~Child failed to destroy'
    );
    // Pre-#1777 the provider returned normally here, so the engine reached
    // `delete stateResources[logicalId]` and the parent lost its only pointer
    // to a child stack with live resources.
    expect(Object.keys(stateResources)).toEqual(['Child']);
    expect(deleteProvider.delete).toHaveBeenCalledTimes(1);
  });

  it("the message is not mistaken for the engine's already-deleted arm", async () => {
    // The DELETE branch swallows `does not exist` / `was not found` /
    // `not found` / `No policy found` / `NoSuchEntity` / `NotFoundException` /
    // `ResourceNotFoundException` as an idempotent success AND drops the row.
    // Driven by the REAL builder, so this checks the shipped wording rather
    // than a literal in this file.
    (deleteProvider.delete as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error(CHILD_FAILURE_MESSAGE)
    );

    const { run, stateResources } = await invokeNestedDelete(makeEngine());

    await expect(run).rejects.toThrow();
    expect(Object.keys(stateResources)).toContain('Child');
  });

  it('control: an already-gone child IS swallowed and the row is dropped', async () => {
    // The inverted control that makes the assertion above meaningful — without
    // it, "the engine never swallows anything" would satisfy both tests while
    // breaking every idempotent re-run.
    (deleteProvider.delete as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('Stack MyStack~Child does not exist')
    );

    const { run, stateResources } = await invokeNestedDelete(makeEngine());

    await expect(run).resolves.toBeUndefined();
    expect(Object.keys(stateResources)).toEqual([]);
  });

  it('control: a CLEAN nested-stack delete still drops the row', async () => {
    (deleteProvider.delete as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

    const { run, stateResources } = await invokeNestedDelete(makeEngine());

    await expect(run).resolves.toBeUndefined();
    expect(Object.keys(stateResources)).toEqual([]);
  });
});
