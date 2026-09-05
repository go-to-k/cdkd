import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import type { ResourceProvider } from '../../../src/types/resource.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { ResourceChange, ResourceState as StateRecord } from '../../../src/types/state.js';

/**
 * Issue [#2567](https://github.com/go-to-k/cdkd/issues/2567): a
 * `--recreate-via-cc-api` / `--recreate-via-sdk-provider` target is validated
 * ONCE, in `deploy.ts`, against the TOP-LEVEL stack — its template, its state
 * record, and (for the two conditionally stateful types) a live emptiness
 * probe. `NestedStackProvider.runChildDeploy` then spreads the parent's whole
 * option object into the CHILD engine, so a bare `ReadonlySet<string>` of
 * logical ids arrived in a stack the pre-flight had never looked at and was
 * matched there against the CHILD's logical ids.
 *
 * That is not merely a wasted flag. `recreateFlagged` is exactly the term that
 * SKIPS the mid-deploy property-driven stateful guard (the exemption pinned by
 * `deploy-engine-recreate-flagged-stateful-exemption.test.ts`, whose whole
 * justification is "the pre-flight already validated this target"). For a
 * child resource that merely SHARED a logical id with a validated parent one —
 * the same construct id in both stacks, or an `overrideLogicalId` — nothing
 * had validated anything, and a nested `AWS::S3::Bucket` could be DELETE +
 * CREATEd with neither check having seen it.
 *
 * The fix scopes the set: it travels with `stackName`, the stack the
 * pre-flight validated it against, and the engine matches it only there. The
 * child deploys as `<parent>~<logicalId>`, so an inherited set can never match
 * in a child.
 *
 * BOTH polarities in every case, because either alone is satisfiable by a
 * wrong implementation — a scope check that never matches would close the hole
 * by breaking the flag outright, which the MATCHING-stack arms refuse:
 *
 *   - matching stack  → the flag still drives a destroy + recreate, and still
 *     exempts a stateful property-driven replacement from the guard;
 *   - child stack     → the flag drives nothing at all, and the stateful guard
 *     is back in force.
 *
 * A note on what a "genuinely nested target" can do today, since scoping the
 * set could otherwise look like it removes a capability: it cannot remove one.
 * A logical id that exists ONLY in a child is not in the parent's template, so
 * `validateRecreateTargets` reports it under `unknownLogicalIds` and the deploy
 * refuses at pre-flight before any resource is touched — the flags have never
 * addressed a nested resource. The only ids that reached a child were ones
 * validated for the PARENT and colliding by accident, which is the defect.
 * `docs/cli-deploy-safety.md` now states the limitation, and
 * `renderRecreateTargetsErrors` names it when the template has nested stacks.
 */

const STATEFUL_TYPE = 'AWS::S3::Bucket';
/** The stack the pre-flight validated the targets against. */
const PARENT_STACK = 'MyStack';
/**
 * What `NestedStackProvider.deriveChildStackName` builds for a child. Written
 * out rather than derived so this file pins the real shape: the scope check is
 * a string comparison, and it is only sound because a child's name can never
 * equal its parent's.
 */
const CHILD_STACK = 'MyStack~Child';
/** The logical id both stacks declare — the collision the issue is about. */
const SHARED_LOGICAL_ID = 'MyBucket';

describe('recreate targets apply only to the stack they were validated against (#2567)', () => {
  let provider: ResourceProvider;

  beforeEach(() => {
    provider = {
      create: vi.fn().mockResolvedValue({ physicalId: 'new-pid', attributes: {} }),
      update: vi.fn().mockResolvedValue({ physicalId: 'old-name' }),
      delete: vi.fn().mockResolvedValue(undefined),
      getAttribute: vi.fn(),
      // Single-shot: the outer retry loop is a different code path and would
      // only obscure which arm was taken.
      disableOuterRetry: true,
    } as unknown as ResourceProvider;
  });

  function makeEngine(opts: {
    /** The stack the targets are scoped to — the parent, always. */
    targetsStack: string;
    direction: 'to-cc-api' | 'to-sdk';
  }): InstanceType<typeof DeployEngine> {
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
        recreateTargets: {
          stackName: opts.targetsStack,
          viaCcApi:
            opts.direction === 'to-cc-api' ? new Set([SHARED_LOGICAL_ID]) : new Set<string>(),
          viaSdkProvider:
            opts.direction === 'to-sdk' ? new Set([SHARED_LOGICAL_ID]) : new Set<string>(),
        },
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
          template: CloudFormationTemplate
        ) => Promise<unknown>;
      }
    ).provisionResource.bind(engine);
  }

  function stateFor(): Record<string, StateRecord> {
    return {
      [SHARED_LOGICAL_ID]: {
        physicalId: 'old-name',
        resourceType: STATEFUL_TYPE,
        properties: { BucketName: 'old-name', VersioningConfiguration: { Status: 'Suspended' } },
        attributes: {},
        dependencies: [],
        provisionedBy: 'sdk',
      } as unknown as StateRecord,
    };
  }

  /**
   * An ordinary in-place UPDATE — nothing about the template's diff drives a
   * replacement, so the ONLY thing that can turn this into a DELETE + CREATE is
   * the recreate flag matching. That makes `provider.delete` the discriminator:
   * called means the flag was honoured in this stack, not called means it was
   * not.
   */
  async function invokeInPlaceUpdate(
    engine: InstanceType<typeof DeployEngine>,
    stackName: string
  ): Promise<unknown> {
    const change: ResourceChange = {
      logicalId: SHARED_LOGICAL_ID,
      changeType: 'UPDATE',
      resourceType: STATEFUL_TYPE,
      currentProperties: { BucketName: 'old-name', VersioningConfiguration: { Status: 'Suspended' } },
      desiredProperties: { BucketName: 'old-name', VersioningConfiguration: { Status: 'Enabled' } },
      propertyChanges: [
        {
          path: 'VersioningConfiguration.Status',
          oldValue: 'Suspended',
          newValue: 'Enabled',
          requiresReplacement: false,
        },
      ],
    } as unknown as ResourceChange;
    return provisionOf(engine)(SHARED_LOGICAL_ID, change, stateFor(), stackName, {
      Resources: {
        [SHARED_LOGICAL_ID]: {
          Type: STATEFUL_TYPE,
          Properties: { BucketName: 'old-name', VersioningConfiguration: { Status: 'Enabled' } },
        },
      },
    });
  }

  /**
   * An UPDATE the diff classified as a REPLACEMENT because an immutable
   * property changed, on a stateful type, with no `--force-stateful-recreation`.
   * Reaching the provider at all requires the guard to have been SKIPPED, which
   * only a matched recreate flag does.
   */
  async function invokeStatefulReplacement(
    engine: InstanceType<typeof DeployEngine>,
    stackName: string
  ): Promise<unknown> {
    const change: ResourceChange = {
      logicalId: SHARED_LOGICAL_ID,
      changeType: 'UPDATE',
      resourceType: STATEFUL_TYPE,
      currentProperties: { BucketName: 'old-name' },
      desiredProperties: { BucketName: 'new-name' },
      propertyChanges: [
        {
          path: 'BucketName',
          requiresReplacement: true,
          oldValue: 'old-name',
          newValue: 'new-name',
        },
      ],
    } as unknown as ResourceChange;
    return provisionOf(engine)(SHARED_LOGICAL_ID, change, stateFor(), stackName, {
      Resources: {
        [SHARED_LOGICAL_ID]: { Type: STATEFUL_TYPE, Properties: { BucketName: 'new-name' } },
      },
    });
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

  for (const direction of ['to-cc-api', 'to-sdk'] as const) {
    const flag =
      direction === 'to-cc-api' ? '--recreate-via-cc-api' : '--recreate-via-sdk-provider';

    it(`${flag}: an in-place update in the VALIDATED stack is forced to a destroy + recreate`, async () => {
      const engine = makeEngine({ targetsStack: PARENT_STACK, direction });
      await invokeInPlaceUpdate(engine, PARENT_STACK);
      // The whole point of the flag: an update that would have gone in place is
      // turned into a replacement. Without this arm, a scope check that never
      // matches would look correct.
      expect(provider.delete).toHaveBeenCalled();
      expect(provider.create).toHaveBeenCalled();
      expect(provider.update).not.toHaveBeenCalled();
    });

    it(`${flag}: the SAME id in a nested CHILD stack is not a target — the update stays in place`, async () => {
      // The child engine is constructed by NestedStackProvider with the
      // parent's options spread in, so the target set still names PARENT_STACK
      // while the engine deploys the child.
      const engine = makeEngine({ targetsStack: PARENT_STACK, direction });
      await invokeInPlaceUpdate(engine, CHILD_STACK);
      // Pre-fix this deleted a bucket in a stack the user never named.
      expect(provider.delete).not.toHaveBeenCalled();
      expect(provider.create).not.toHaveBeenCalled();
      expect(provider.update).toHaveBeenCalled();
    });

    it(`${flag}: the stateful guard is exempted in the VALIDATED stack`, async () => {
      const engine = makeEngine({ targetsStack: PARENT_STACK, direction });
      await invokeStatefulReplacement(engine, PARENT_STACK);
      expect(provider.delete).toHaveBeenCalled();
      expect(provider.create).toHaveBeenCalled();
    });

    it(`${flag}: the stateful guard is BACK IN FORCE for the same id in a nested CHILD stack`, async () => {
      const engine = makeEngine({ targetsStack: PARENT_STACK, direction });
      const err = await invokeStatefulReplacement(engine, CHILD_STACK).then(
        () => undefined,
        (e: unknown) => e
      );
      expect(err, 'the child stateful replacement did not throw').toBeDefined();
      // The refusal is wrapped in the engine's per-resource ProvisioningError,
      // so the top-level message alone would pass for any update failure.
      expect(chainText(err)).toMatch(/force-stateful-recreation/);
      // And it must refuse BEFORE the destructive call — a throw downstream of
      // the delete still "fails" with the bucket already gone.
      expect(provider.delete).not.toHaveBeenCalled();
    });
  }

  it('a target set naming a DIFFERENT top-level stack is ignored too (not a nested-only guard)', async () => {
    // Same mechanism, non-nested spelling: nothing about the check depends on
    // the `<parent>~<child>` shape, so a sibling stack in the same run cannot
    // pick up another stack's targets either.
    const engine = makeEngine({ targetsStack: PARENT_STACK, direction: 'to-cc-api' });
    await invokeInPlaceUpdate(engine, 'SomeOtherStack');
    expect(provider.delete).not.toHaveBeenCalled();
    expect(provider.update).toHaveBeenCalled();
  });
});
