import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import type { ResourceProvider } from '../../../src/types/resource.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { ResourceChange, ResourceState as StateRecord } from '../../../src/types/state.js';

/**
 * Issue #2554: the property-driven stateful guard's `!recreateFlagged` term was
 * unfenced.
 *
 * The condition is
 * `propertyDrivenReplacement && !recreateFlagged && updateReplacePolicy !== 'Retain'`,
 * and `docs/cli-deploy-safety.md` documents the exemption: a `--recreate-via-*`
 * target skips THIS guard because the CLI pre-flight
 * (`probeStatefulRecreateTargetsAsync`) already validated it — and did so with
 * a live emptiness probe the mid-deploy site cannot run.
 *
 * Measured on PR #2519's HEAD: deleting the term left the whole
 * `tests/unit/deployment` suite green (120 files, 2031 tests). Every existing
 * `--recreate-via-*` test picks a NON-stateful type
 * (`AWS::Lambda::Function`), so the term never discriminated.
 *
 * The fixture has to be built ENGINE-side: the CLI pre-flight refuses a
 * stateful recreate target without `--force-stateful-recreation`, so the
 * combination this pins cannot be reached through the command layer at all.
 * That is the point — the exemption exists precisely because the pre-flight
 * already ran, so the engine must be driven directly to observe it.
 *
 * Both polarities, because either alone is satisfiable by a wrong
 * implementation: flagged + stateful must PROCEED (delete the old, create the
 * new), and un-flagged + stateful must REFUSE.
 */

const STATEFUL_TYPE = 'AWS::S3::Bucket';

describe('the property-driven stateful guard exempts a --recreate-via-* target (#2554)', () => {
  let provider: ResourceProvider;

  beforeEach(() => {
    provider = {
      create: vi.fn().mockResolvedValue({ physicalId: 'new-pid', attributes: {} }),
      update: vi.fn().mockResolvedValue({ physicalId: 'old-pid' }),
      delete: vi.fn().mockResolvedValue(undefined),
      getAttribute: vi.fn(),
      // Single-shot path: the outer retry loop is a different code path and
      // would only obscure which arm was taken.
      disableOuterRetry: true,
    } as unknown as ResourceProvider;
  });

  function makeEngine(opts: { recreateViaCcApi?: boolean } = {}): InstanceType<typeof DeployEngine> {
    const mockStateBackend = { getState: vi.fn(), saveState: vi.fn().mockResolvedValue('etag') };
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
      getProvider: vi.fn().mockReturnValue(provider),
      getProviderFor: vi.fn().mockReturnValue({ provider, provisionedBy: 'sdk' as const }),
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
        ...(opts.recreateViaCcApi === true && {
          recreateViaCcApiTargets: new Set(['MyBucket']),
        }),
      },
      'us-east-1'
    );
  }

  function provisionOf(engine: InstanceType<typeof DeployEngine>) {
    return (
      engine as unknown as {
        provisionResource: (
          logicalId: string,
          change: ResourceChange,
          stateResources: Record<string, unknown>,
          stackName: string,
          template: CloudFormationTemplate,
          parameterValues?: Record<string, unknown>,
          conditions?: Record<string, boolean>,
          counts?: unknown
        ) => Promise<unknown>;
      }
    ).provisionResource.bind(engine);
  }

  /**
   * An UPDATE the diff classified as a REPLACEMENT because an immutable
   * property changed — the `propertyDrivenReplacement` arm, reached on a plain
   * `cdkd deploy` with no flag.
   */
  async function invokeReplacement(engine: InstanceType<typeof DeployEngine>): Promise<unknown> {
    const change: ResourceChange = {
      logicalId: 'MyBucket',
      changeType: 'UPDATE',
      resourceType: STATEFUL_TYPE,
      currentProperties: { BucketName: 'old-name' },
      desiredProperties: { BucketName: 'new-name' },
      propertyChanges: [
        { path: 'BucketName', requiresReplacement: true, oldValue: 'old-name', newValue: 'new-name' },
      ],
    } as unknown as ResourceChange;
    const stateResources: Record<string, StateRecord> = {
      MyBucket: {
        physicalId: 'old-name',
        resourceType: STATEFUL_TYPE,
        properties: { BucketName: 'old-name' },
        attributes: {},
        dependencies: [],
        provisionedBy: 'sdk',
      },
    };
    return provisionOf(engine)(
      'MyBucket',
      change,
      stateResources,
      'MyStack',
      { Resources: { MyBucket: { Type: STATEFUL_TYPE, Properties: { BucketName: 'new-name' } } } },
      undefined,
      undefined,
      undefined
    );
  }

  /** Every message in the thrown error's cause chain, joined. */
  function chainText(e: unknown): string {
    const parts: string[] = [];
    let cur: unknown = e;
    for (let i = 0; i < 10 && cur != null; i++) {
      if (cur instanceof Error) parts.push(cur.message);
      cur = (cur as { cause?: unknown }).cause;
    }
    return parts.join('\n');
  }

  it('REFUSES an unflagged stateful property-driven replacement', async () => {
    const engine = makeEngine();
    // The guard's refusal reaches the caller WRAPPED in the engine's
    // per-resource `ProvisioningError`, so asserting on the top-level message
    // alone would pass for any update failure whatsoever. Read the chain.
    const err = await invokeReplacement(engine).then(
      () => undefined,
      (e: unknown) => e
    );
    expect(err, 'the unflagged stateful replacement did not throw').toBeDefined();
    expect(chainText(err)).toMatch(/force-stateful-recreation/);
    // The guard must refuse BEFORE the destructive call, not after — a refusal
    // thrown downstream of the delete would still "fail" while the bucket was
    // already gone.
    expect(provider.delete).not.toHaveBeenCalled();
  });

  it('PROCEEDS when the same resource is a --recreate-via-cc-api target — the pre-flight already validated it', async () => {
    const engine = makeEngine({ recreateViaCcApi: true });
    await invokeReplacement(engine);
    // The exemption is only meaningful if the replacement actually runs: the
    // old resource is deleted and the new one created. Asserting merely that
    // nothing threw would pass on an implementation that silently skipped the
    // resource entirely.
    expect(provider.delete).toHaveBeenCalledTimes(1);
    expect(provider.create).toHaveBeenCalledTimes(1);
  });
});
