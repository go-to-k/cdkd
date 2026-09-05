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
 *
 * And BOTH halves of `recreateFlagged`, which is
 * `recreateViaCcApi || recreateViaSdkProvider`. Narrowing the guard to
 * `!recreateViaCcApi` alone left all 122 files / 2114 tests of
 * `tests/unit/deployment` green — the #651 reverse direction reproducing the
 * very condition this suite exists to close, because its own sibling suite
 * also picks only `AWS::Lambda::Function`.
 *
 * The premise carried a CAVEAT until issue
 * [#2567](https://github.com/go-to-k/cdkd/issues/2567): the exemption rests on
 * the CLI pre-flight having validated the target, and `NestedStackProvider`
 * spread `deployEngineOptions` into the CHILD engine, where a bare logical id
 * matching a child's resource cleared this guard with no pre-flight probe
 * behind it. The target set now travels with the stack it was validated
 * against and is matched only there, so the exemption below holds only where
 * its premise does. These cases still pin the TOP-LEVEL contract; the scoping
 * itself is pinned by
 * `tests/unit/deployment/deploy-engine-recreate-targets-stack-scope.test.ts`.
 */

const STATEFUL_TYPE = 'AWS::S3::Bucket';
/** The stack the engine is driven with AND the stack the targets are scoped to. */
const STACK_NAME = 'MyStack';

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

  function makeEngine(
    opts: { recreateViaCcApi?: boolean; recreateViaSdkProvider?: boolean } = {}
  ): InstanceType<typeof DeployEngine> {
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
        ...((opts.recreateViaCcApi === true || opts.recreateViaSdkProvider === true) && {
          recreateTargets: {
            // The stack `invokeReplacement` drives the engine with. Since issue
            // #2567 the two must agree or the target is not honoured at all —
            // which is exactly what the sibling suite
            // `deploy-engine-recreate-targets-stack-scope.test.ts` pins.
            stackName: STACK_NAME,
            viaCcApi: opts.recreateViaCcApi === true ? new Set(['MyBucket']) : new Set<string>(),
            viaSdkProvider:
              opts.recreateViaSdkProvider === true ? new Set(['MyBucket']) : new Set<string>(),
          },
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
      STACK_NAME,
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

  for (const direction of ['recreateViaCcApi', 'recreateViaSdkProvider'] as const) {
    it(`PROCEEDS when the same resource is a --${
      direction === 'recreateViaCcApi' ? 'recreate-via-cc-api' : 'recreate-via-sdk-provider'
    } target — the pre-flight already validated it`, async () => {
      const engine = makeEngine({ [direction]: true });
      await invokeReplacement(engine);
      // The exemption is only meaningful if the replacement actually runs: the
      // old resource is deleted and the new one created. Asserting merely that
      // nothing threw would pass on an implementation that silently skipped the
      // resource entirely.
      expect(provider.delete).toHaveBeenCalledTimes(1);
      expect(provider.create).toHaveBeenCalledTimes(1);
      // The LAST line of defence once the guard is exempted: `forceDataDelete`
      // is what lets `S3BucketProvider.delete` empty a non-empty bucket, and
      // the user passed no consent flag here, so it must be false. A change
      // flipping it on would keep every other assertion in this case green.
      expect(provider.delete).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.objectContaining({ forceDataDelete: false })
      );
    });
  }
});
