/**
 * go-to-k/cdkd#4705: `DeployEngineOptions.onDestructivePlan` is called with a
 * plan that deletes or replaces, after the diff and before any provider call,
 * and never for an in-place update; a throw changes nothing. Harness copied
 * from `deploy-engine-require-approval.test.ts`.
 */

import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { ResourceChange, ResourceState, StackState } from '../../../src/types/state.js';
import { STATE_SCHEMA_VERSION_CURRENT } from '../../../src/types/state.js';

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

function record(extra: Partial<ResourceState> = {}): ResourceState {
  return {
    physicalId: 'pid',
    resourceType: 'AWS::SQS::Queue',
    properties: { Marker: 'old' },
    attributes: {},
    dependencies: [],
    ...extra,
  } as ResourceState;
}

/** An in-place UPDATE of `Kept`, plus whatever `extra` rows the case adds. */
function arrange(
  mocks: { getState: ReturnType<typeof vi.fn>; calculateDiff: ReturnType<typeof vi.fn> },
  resources: Record<string, ResourceState>,
  changes: ResourceChange[]
): CloudFormationTemplate {
  const state: StackState = {
    version: STATE_SCHEMA_VERSION_CURRENT,
    region: 'us-east-1',
    stackName: STACK_NAME,
    resources,
    outputs: {},
    lastModified: 0,
  };
  mocks.getState.mockResolvedValue({ state, etag: 'etag-old' });
  mocks.calculateDiff.mockResolvedValue(new Map(changes.map((c) => [c.logicalId, c])));
  return {
    Resources: {
      Kept: {
        Type: 'AWS::SQS::Queue',
        Properties: { Marker: 'new' },
        Metadata: { 'aws:cdk:path': 'MyStack/Kept/Resource' },
      },
    },
  } as CloudFormationTemplate;
}

const inPlaceUpdate: ResourceChange = {
  logicalId: 'Kept',
  changeType: 'UPDATE',
  resourceType: 'AWS::SQS::Queue',
  currentProperties: { Marker: 'old' },
  desiredProperties: { Marker: 'new' },
  propertyChanges: [{ path: 'Marker', oldValue: 'old', newValue: 'new', requiresReplacement: false }],
};

const deletion: ResourceChange = {
  logicalId: 'Gone',
  changeType: 'DELETE',
  resourceType: 'AWS::SQS::Queue',
  currentProperties: { Marker: 'old' },
};

describe('DeployEngine onDestructivePlan (go-to-k/cdkd#4705)', () => {
  let mockStateBackend: { getState: ReturnType<typeof vi.fn>; saveState: ReturnType<typeof vi.fn> };
  let mockDiffCalculator: {
    calculateDiff: ReturnType<typeof vi.fn>;
    hasChanges: ReturnType<typeof vi.fn>;
    filterByType: ReturnType<typeof vi.fn>;
  };
  let provider: {
    create: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
    getAttribute: ReturnType<typeof vi.fn>;
  };
  let hook: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockDiffCalculator = {
      calculateDiff: vi.fn(),
      hasChanges: vi.fn().mockReturnValue(true),
      filterByType: vi
        .fn()
        .mockImplementation((changes: Map<string, ResourceChange>, type: string) =>
          Array.from(changes.values()).filter((c) => c.changeType === type)
        ),
    };
    provider = {
      create: vi.fn().mockResolvedValue({ physicalId: 'new-pid', attributes: {} }),
      update: vi.fn().mockResolvedValue({ physicalId: 'pid' }),
      delete: vi.fn().mockResolvedValue(undefined),
      getAttribute: vi.fn(),
    };
    mockStateBackend = {
      getState: vi.fn(),
      saveState: vi.fn().mockResolvedValue('etag-new'),
    };
    hook = vi.fn().mockResolvedValue(undefined);
  });

  function makeEngine(options: Record<string, unknown> = {}) {
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
        getProvider: vi.fn().mockReturnValue(provider),
        getProviderFor: vi.fn().mockReturnValue({ provider, provisionedBy: 'sdk' as const }),
        getRegisteredTypes: vi.fn().mockReturnValue([]),
        validateResourceTypes: vi.fn(),
        validateResourceProperties: vi.fn(),
      } as never,
      { dryRun: false, onDestructivePlan: hook, ...options } as never,
      'us-east-1',
      {
        updateForStack: vi.fn().mockResolvedValue(undefined),
        lookup: vi.fn().mockResolvedValue(null),
        patchEntry: vi.fn().mockResolvedValue(undefined),
      } as never
    );
  }

  const mocks = () => ({
    getState: mockStateBackend.getState,
    calculateDiff: mockDiffCalculator.calculateDiff,
  });

  it('is not called for an in-place update (an everyday deploy pays nothing)', async () => {
    const template = arrange(mocks(), { Kept: record() }, [inPlaceUpdate]);
    await makeEngine().deploy(STACK_NAME, template);
    expect(hook).not.toHaveBeenCalled();
  });

  it('is called with the stack and the destructive changes for a deletion', async () => {
    const template = arrange(mocks(), { Kept: record(), Gone: record({ physicalId: 'gone' }) }, [
      inPlaceUpdate,
      deletion,
    ]);
    await makeEngine().deploy(STACK_NAME, template);
    expect(hook).toHaveBeenCalledTimes(1);
    expect(hook.mock.calls[0]![0]).toBe(STACK_NAME);
    expect(
      (hook.mock.calls[0]![1] as Array<{ logicalId: string }>).map((c) => c.logicalId)
    ).toEqual(['Gone']);
  });

  it('a throw refuses the deploy before any provider call', async () => {
    hook.mockRejectedValue(new Error('refused by the cross-prefix check'));
    const template = arrange(mocks(), { Kept: record(), Gone: record({ physicalId: 'gone' }) }, [
      inPlaceUpdate,
      deletion,
    ]);
    await expect(makeEngine().deploy(STACK_NAME, template)).rejects.toThrow(
      'refused by the cross-prefix check'
    );
    expect(provider.update).not.toHaveBeenCalled();
    expect(provider.delete).not.toHaveBeenCalled();
    expect(mockStateBackend.saveState).not.toHaveBeenCalled();
  });

  it('is called for a REPLACEMENT (a create-only property changes)', async () => {
    const replace: ResourceChange = {
      ...inPlaceUpdate,
      propertyChanges: [{ path: 'Marker', oldValue: 'old', newValue: 'new', requiresReplacement: true }],
    };
    const template = arrange(mocks(), { Kept: record() }, [replace]);
    hook.mockRejectedValue(new Error('refused'));
    await expect(makeEngine().deploy(STACK_NAME, template)).rejects.toThrow('refused');
    expect(
      (hook.mock.calls[0]![1] as Array<{ logicalId: string; impact: string }>).map((c) => c.impact)
    ).toEqual(['WILL_REPLACE']);
    expect(provider.create).not.toHaveBeenCalled();
  });

  it('is called for a --recreate-via-* target (WILL_REPLACE)', async () => {
    const template = arrange(mocks(), { Kept: record() }, [inPlaceUpdate]);
    await makeEngine({
      recreateTargets: { stackName: STACK_NAME, viaCcApi: new Set(['Kept']), viaSdkProvider: new Set() },
    })
      .deploy(STACK_NAME, template)
      .catch(() => undefined);
    expect(hook).toHaveBeenCalled();
  });

  it('is NOT called for a may-replace (an unresolved value) or a retained removal (orphan)', async () => {
    const mayReplace: ResourceChange = {
      ...inPlaceUpdate,
      propertyChanges: [
        {
          path: 'Marker',
          oldValue: 'old',
          newValue: 'new',
          requiresReplacement: true,
          inPlacePropagated: true,
        },
      ],
    };
    const template = arrange(
      mocks(),
      { Kept: record(), Gone: record({ physicalId: 'gone', deletionPolicy: 'Retain' }) },
      [mayReplace, deletion]
    );
    await makeEngine().deploy(STACK_NAME, template).catch(() => undefined);
    expect(hook).not.toHaveBeenCalled();
  });

  it('is called for a nested-stack row UPDATE, whose child plan the parent cannot see yet', async () => {
    const nestedUpdate: ResourceChange = {
      logicalId: 'Child',
      changeType: 'UPDATE',
      resourceType: 'AWS::CloudFormation::Stack',
      currentProperties: {},
      desiredProperties: {},
      propertyChanges: [],
    };
    const template = arrange(mocks(), { Kept: record(), Child: record({ resourceType: 'AWS::CloudFormation::Stack' }) }, [
      nestedUpdate,
    ]);
    hook.mockRejectedValue(new Error('refused by the cross-prefix check'));
    await expect(makeEngine().deploy(STACK_NAME, template)).rejects.toThrow(
      'refused by the cross-prefix check'
    );
    expect(provider.update).not.toHaveBeenCalled();
  });

  it('runs BEFORE the --require-approval prompt: a refused plan never asks', async () => {
    const approve = vi.fn().mockResolvedValue(true);
    hook.mockRejectedValue(new Error('refused by the cross-prefix check'));
    const template = arrange(mocks(), { Kept: record(), Gone: record({ physicalId: 'gone' }) }, [
      deletion,
    ]);
    await expect(
      makeEngine({ requireApproval: 'destructive', approveDeployment: approve }).deploy(
        STACK_NAME,
        template
      )
    ).rejects.toThrow('refused by the cross-prefix check');
    expect(approve).not.toHaveBeenCalled();
  });

  it('is not called on a dry run', async () => {
    const template = arrange(mocks(), { Kept: record(), Gone: record({ physicalId: 'gone' }) }, [
      deletion,
    ]);
    await makeEngine({ dryRun: true }).deploy(STACK_NAME, template);
    expect(hook).not.toHaveBeenCalled();
  });
});
