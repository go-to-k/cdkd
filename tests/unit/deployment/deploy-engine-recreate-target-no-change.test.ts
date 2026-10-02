/**
 * Issue [#2651](https://github.com/go-to-k/cdkd/issues/2651): a
 * `--recreate-via-*` target whose template did not change is still recreated.
 *
 * Two gates used to drop it, and each case below reaches exactly one:
 *
 *   - the DIFF calls the target NO_CHANGE, and a NO_CHANGE row is never
 *     dispatched — a stack with nothing else to do printed "No changes
 *     detected" right under the consented recreate plan;
 *   - the diff calls it an UPDATE (an intrinsic it could not resolve, say),
 *     but the UPDATE arm's post-resolution skip finds the resolved bag equal
 *     to the record and returns before it reads the targets.
 *
 * Driven through `engine.deploy()` so the promotion, the dispatch and the
 * summary are the production ones. The diff double is the only seam: it
 * returns the change map a real diff would for an unchanged template.
 */

import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { ResourceChange, ResourceState, StackState } from '../../../src/types/state.js';
import { STATE_SCHEMA_VERSION_CURRENT } from '../../../src/types/state.js';
import { getLogger } from '../../../src/utils/logger.js';

// No real AWS client: the create-only DescribeType prefetch reads the
// process-global client factory (see _inert-cloudformation-client.ts).
vi.mock('../../../src/utils/aws-clients.js', async (importOriginal) =>
  (await import('./_inert-cloudformation-client.js')).withInertCloudFormationClient(importOriginal)
);

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

vi.mock('../../../src/deployment/intrinsic-function-resolver.js', () => ({
  IntrinsicFunctionResolver: vi.fn().mockImplementation(() => ({
    getPhysicalIdFallbackCount: vi.fn().mockReturnValue(0),
    resetPhysicalIdFallbackCount: vi.fn(),
    resolve: vi.fn().mockImplementation((props: unknown) => Promise.resolve(props)),
    resolveParameters: vi.fn().mockResolvedValue({}),
    evaluateConditions: vi.fn().mockResolvedValue({}),
  })),
}));

vi.mock('p-limit', () => ({
  default: vi.fn(() => <T>(fn: () => T) => fn()),
}));

const STACK_NAME = 'MyStack';
const TARGET = 'MyFn';
const BYSTANDER = 'OtherFn';
const TYPE = 'AWS::Lambda::Function';
const PROPS = { FunctionName: 'my-fn', Runtime: 'nodejs22.x' };

type ProviderDouble = {
  create: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
  getAttribute: ReturnType<typeof vi.fn>;
};

function makeProvider(createdPhysicalId: string): ProviderDouble {
  return {
    create: vi.fn().mockResolvedValue({ physicalId: createdPhysicalId, attributes: {} }),
    update: vi.fn().mockResolvedValue({ physicalId: createdPhysicalId }),
    delete: vi.fn().mockResolvedValue(undefined),
    getAttribute: vi.fn(),
  };
}

describe('a --recreate-via-* target with no template change is recreated (#2651)', () => {
  let sdk: ProviderDouble;
  let cc: ProviderDouble;
  let mockStateBackend: { getState: ReturnType<typeof vi.fn>; saveState: ReturnType<typeof vi.fn> };
  let mockDiffCalculator: {
    calculateDiff: ReturnType<typeof vi.fn>;
    hasChanges: ReturnType<typeof vi.fn>;
    filterByType: ReturnType<typeof vi.fn>;
  };
  const logger = getLogger() as unknown as {
    warn: ReturnType<typeof vi.fn>;
    info: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    sdk = makeProvider('sdk-new-pid');
    cc = makeProvider('cc-new-pid');
    mockStateBackend = {
      getState: vi.fn(),
      saveState: vi.fn().mockResolvedValue('etag-new'),
    };
    // The real calculator's two summary methods, over whatever map it returned.
    mockDiffCalculator = {
      calculateDiff: vi.fn(),
      hasChanges: vi
        .fn()
        .mockImplementation((changes: Map<string, ResourceChange>) =>
          Array.from(changes.values()).some((c) => c.changeType !== 'NO_CHANGE')
        ),
      filterByType: vi
        .fn()
        .mockImplementation((changes: Map<string, ResourceChange>, type: string) =>
          Array.from(changes.values()).filter((c) => c.changeType === type)
        ),
    };
  });

  function makeEngine(recreate: { viaCcApi?: string[]; viaSdkProvider?: string[]; stack?: string }) {
    return new DeployEngine(
      mockStateBackend as never,
      {
        acquireLockWithRetry: vi.fn().mockResolvedValue(true),
        releaseLock: vi.fn().mockResolvedValue(undefined),
      } as never,
      {
        buildGraph: vi.fn().mockReturnValue({}),
        getExecutionLevels: vi.fn().mockReturnValue([]),
        getDirectDependencies: vi.fn().mockReturnValue([]),
      } as never,
      mockDiffCalculator as never,
      {
        getProvider: vi.fn().mockReturnValue(sdk),
        // A recorded / hinted `cc-api` layer routes to Cloud Control.
        getProviderFor: vi
          .fn()
          .mockImplementation((input: { provisionedBy?: 'sdk' | 'cc-api' }) =>
            input.provisionedBy === 'cc-api'
              ? { provider: cc, provisionedBy: 'cc-api' as const }
              : { provider: sdk, provisionedBy: 'sdk' as const }
          ),
        getRegisteredTypes: vi.fn().mockReturnValue([]),
        validateResourceTypes: vi.fn(),
        validateResourceProperties: vi.fn(),
        ccRouteUnavailableReason: vi.fn().mockReturnValue(undefined),
      } as never,
      {
        dryRun: false,
        recreateTargets: {
          stackName: recreate.stack ?? STACK_NAME,
          viaCcApi: new Set(recreate.viaCcApi ?? []),
          viaSdkProvider: new Set(recreate.viaSdkProvider ?? []),
        },
      } as never,
      'us-east-1',
      {
        updateForStack: vi.fn().mockResolvedValue(undefined),
        lookup: vi.fn().mockResolvedValue(null),
        patchEntry: vi.fn().mockResolvedValue(undefined),
      } as never
    );
  }

  /**
   * State holds both functions on `layer`; the diff returns each as
   * `changeType` with identical bags on both sides — what an unchanged
   * template diffs to.
   */
  function arrange(
    layer: 'sdk' | 'cc-api',
    changeType: 'NO_CHANGE' | 'UPDATE' = 'NO_CHANGE'
  ): CloudFormationTemplate {
    const record = (id: string): ResourceState =>
      ({
        physicalId: `${id}-old-pid`,
        resourceType: TYPE,
        properties: { ...PROPS },
        attributes: {},
        dependencies: [],
        provisionedBy: layer,
      }) as unknown as ResourceState;
    const state: StackState = {
      version: STATE_SCHEMA_VERSION_CURRENT,
      region: 'us-east-1',
      stackName: STACK_NAME,
      resources: { [TARGET]: record(TARGET), [BYSTANDER]: record(BYSTANDER) },
      outputs: {},
      lastModified: 0,
    };
    mockStateBackend.getState.mockResolvedValue({ state, etag: 'etag-old' });
    const change = (id: string): ResourceChange => ({
      logicalId: id,
      changeType,
      resourceType: TYPE,
      currentProperties: { ...PROPS },
      desiredProperties: { ...PROPS },
      ...(changeType === 'UPDATE' && { propertyChanges: [] }),
    });
    mockDiffCalculator.calculateDiff.mockResolvedValue(
      new Map<string, ResourceChange>([
        [TARGET, change(TARGET)],
        [BYSTANDER, change(BYSTANDER)],
      ])
    );
    return {
      Resources: {
        [TARGET]: { Type: TYPE, Properties: { ...PROPS } },
        [BYSTANDER]: { Type: TYPE, Properties: { ...PROPS } },
      },
    } as CloudFormationTemplate;
  }

  function savedRecord(id: string): ResourceState | undefined {
    const calls = mockStateBackend.saveState.mock.calls;
    const last = calls[calls.length - 1];
    return (last?.[2] as StackState | undefined)?.resources[id];
  }

  function infoLines(): string[] {
    return logger.info.mock.calls.map((c) => String(c[0]));
  }

  it('--recreate-via-cc-api: a NO_CHANGE target is destroyed on its SDK layer and created on Cloud Control', async () => {
    const template = arrange('sdk');
    const result = await makeEngine({ viaCcApi: [TARGET] }).deploy(STACK_NAME, template);

    expect(sdk.delete).toHaveBeenCalledTimes(1);
    expect(sdk.delete.mock.calls[0]![0]).toBe(TARGET);
    expect(cc.create).toHaveBeenCalledTimes(1);
    expect(cc.create.mock.calls[0]![0]).toBe(TARGET);
    // The recreate sends the template's bag: a promotion that emptied
    // `desiredProperties` would create a resource with nothing in it.
    expect(cc.create.mock.calls[0]![2]).toEqual(PROPS);
    expect(savedRecord(TARGET)?.provisionedBy).toBe('cc-api');
    expect(savedRecord(TARGET)?.physicalId).toBe('cc-new-pid');
    // The run is not reported as a no-op.
    expect(infoLines()).not.toContain('No changes detected. Stack is up to date.');
    expect(result.updated).toBe(1);
    expect(result.unchanged).toBe(1);
  });

  it('--recreate-via-sdk-provider: a NO_CHANGE target is destroyed on Cloud Control and created on its SDK provider', async () => {
    const template = arrange('cc-api');
    await makeEngine({ viaSdkProvider: [TARGET] }).deploy(STACK_NAME, template);

    expect(cc.delete).toHaveBeenCalledTimes(1);
    expect(cc.delete.mock.calls[0]![0]).toBe(TARGET);
    expect(sdk.create).toHaveBeenCalledTimes(1);
    expect(sdk.create.mock.calls[0]![0]).toBe(TARGET);
    expect(sdk.create.mock.calls[0]![2]).toEqual(PROPS);
    expect(savedRecord(TARGET)?.provisionedBy).toBe('sdk');
  });

  it('the UPDATE arm does not skip a target whose resolved bag equals its record', async () => {
    // The diff says UPDATE, so the dispatch is reached without the promotion;
    // what is under test is the post-resolution no-op skip.
    const template = arrange('sdk', 'UPDATE');
    await makeEngine({ viaCcApi: [TARGET] }).deploy(STACK_NAME, template);

    expect(sdk.delete).toHaveBeenCalledTimes(1);
    expect(sdk.delete.mock.calls[0]![0]).toBe(TARGET);
    expect(cc.create).toHaveBeenCalledTimes(1);
    expect(savedRecord(TARGET)?.provisionedBy).toBe('cc-api');
    // The non-target with the same equal bags still takes the skip.
    expect(sdk.update).not.toHaveBeenCalled();
    expect(savedRecord(BYSTANDER)?.physicalId).toBe(`${BYSTANDER}-old-pid`);
  });

  it('leaves an unnamed NO_CHANGE resource alone', async () => {
    const template = arrange('sdk');
    await makeEngine({ viaCcApi: [TARGET] }).deploy(STACK_NAME, template);

    for (const p of [sdk, cc]) {
      for (const fn of [p.create, p.update, p.delete]) {
        expect(fn.mock.calls.map((c) => c[0])).not.toContain(BYSTANDER);
      }
    }
    expect(savedRecord(BYSTANDER)?.physicalId).toBe(`${BYSTANDER}-old-pid`);
    expect(savedRecord(BYSTANDER)?.provisionedBy).toBe('sdk');
  });

  it('does not promote a target validated against ANOTHER stack (#2567 scope)', async () => {
    // A nested child engine receives the parent's option bag; its ids were
    // never validated there.
    const template = arrange('sdk');
    await makeEngine({ viaCcApi: [TARGET], stack: 'SomeOtherStack' }).deploy(STACK_NAME, template);

    for (const p of [sdk, cc]) {
      expect(p.create).not.toHaveBeenCalled();
      expect(p.delete).not.toHaveBeenCalled();
    }
    expect(infoLines()).toContain('No changes detected. Stack is up to date.');
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('warns when a target is not in this deploy at all, instead of dropping it in silence', async () => {
    const template = arrange('sdk');
    await makeEngine({ viaCcApi: ['GoneFn'] }).deploy(STACK_NAME, template);

    const warned = logger.warn.mock.calls.map((c) => String(c[0]));
    expect(warned).toContain(
      '--recreate-via-cc-api GoneFn: not recreated, this deploy has no such resource.'
    );
  });
});
