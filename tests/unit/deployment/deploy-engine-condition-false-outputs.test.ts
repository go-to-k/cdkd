/**
 * Issue #1028: an Output carrying a `Condition:` key that evaluates false must
 * be skipped silently — not resolved (CFn never creates it), not warned about,
 * not persisted to state outputs, and not published as an export. Resources
 * got condition filtering in #840; this pins the same semantics for Outputs.
 *
 * The resolver is mocked pass-through with `evaluateConditions` returning the
 * per-test conditions map, so without the fix the condition-false output WOULD
 * resolve successfully and be wrongly published — the dangerous case.
 */

import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { ResourceChange, StackState } from '../../../src/types/state.js';
import { STATE_SCHEMA_VERSION_CURRENT } from '../../../src/types/state.js';

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

// Pass-through resolver; conditions come from the mutable holder below.
const conditionsHolder: { value: Record<string, boolean> } = { value: {} };
vi.mock('../../../src/deployment/intrinsic-function-resolver.js', () => ({
  IntrinsicFunctionResolver: vi.fn().mockImplementation(() => ({
    getPhysicalIdFallbackCount: vi.fn().mockReturnValue(0),
    resetPhysicalIdFallbackCount: vi.fn(),
    resolve: vi.fn().mockImplementation((props: unknown) => Promise.resolve(props)),
    resolveParameters: vi.fn().mockResolvedValue({}),
    evaluateConditions: vi.fn().mockImplementation(() => Promise.resolve(conditionsHolder.value)),
  })),
}));

vi.mock('p-limit', () => ({
  default: vi.fn(() => <T>(fn: () => T) => fn()),
}));

describe('DeployEngine - condition-false Outputs are skipped (#1028)', () => {
  const stackName = 'cond-output-stack';

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
  let mockExportIndexStore: {
    updateForStack: ReturnType<typeof vi.fn>;
    lookup: ReturnType<typeof vi.fn>;
    patchEntry: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    conditionsHolder.value = {};

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
      getState: vi.fn(),
      saveState: vi.fn().mockResolvedValue('etag-new'),
    };
    mockExportIndexStore = {
      updateForStack: vi.fn().mockResolvedValue(undefined),
      lookup: vi.fn().mockResolvedValue(null),
      patchEntry: vi.fn().mockResolvedValue(undefined),
    };
  });

  function makeState(outputs: Record<string, string>): StackState {
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
      outputs,
      lastModified: 0,
    };
  }

  const template: CloudFormationTemplate = {
    Conditions: { IsProd: { 'Fn::Equals': ['dev', 'prod'] } },
    Resources: {
      ParamA: { Type: 'AWS::SSM::Parameter', Properties: { Value: 'x' } },
      ProdOnly: {
        Type: 'AWS::SNS::Topic',
        Condition: 'IsProd',
        Properties: { TopicName: 'prod-only' },
      },
    },
    Outputs: {
      ProdTopicArn: {
        Condition: 'IsProd',
        Value: { Ref: 'ProdOnly' },
        Export: { Name: 'prod:TopicArn' },
      },
      AlwaysOut: { Value: 'always-value' },
    },
  };

  function makeEngine() {
    return new DeployEngine(
      mockStateBackend as never,
      mockLockManager as never,
      mockDagBuilder as never,
      mockDiffCalculator as never,
      mockProviderRegistry as never,
      { dryRun: false },
      'us-east-1',
      mockExportIndexStore as never
    );
  }

  it('does not resolve, persist, or export a condition-false Output', async () => {
    conditionsHolder.value = { IsProd: false };
    mockStateBackend.getState.mockResolvedValue({ state: makeState({}), etag: 'etag-old' });

    const engine = makeEngine();
    const result = await engine.deploy(stackName, template);

    // The pass-through resolver WOULD have produced a value for ProdTopicArn
    // ({Ref: ProdOnly}) — the fix must skip it before resolution.
    expect(mockStateBackend.saveState).toHaveBeenCalledTimes(1);
    const saved = mockStateBackend.saveState.mock.calls[0]![2] as StackState;
    expect(saved.outputs).toEqual({ AlwaysOut: 'always-value' });
    expect(saved.outputs).not.toHaveProperty('ProdTopicArn');
    expect(saved.outputs).not.toHaveProperty('prod:TopicArn');
    expect(result.outputs).toEqual({ AlwaysOut: 'always-value' });
  });

  it('keeps an Output whose condition evaluates true', async () => {
    conditionsHolder.value = { IsProd: true };
    mockStateBackend.getState.mockResolvedValue({ state: makeState({}), etag: 'etag-old' });

    const engine = makeEngine();
    const result = await engine.deploy(stackName, template);

    const saved = mockStateBackend.saveState.mock.calls[0]![2] as StackState;
    expect(saved.outputs).toEqual({
      ProdTopicArn: { Ref: 'ProdOnly' },
      'prod:TopicArn': { Ref: 'ProdOnly' },
      AlwaysOut: 'always-value',
    });
    expect(result.outputs).toEqual({
      ProdTopicArn: { Ref: 'ProdOnly' },
      AlwaysOut: 'always-value',
    });
  });

  it('removes a previously-persisted condition-false output and updates the exports index without it', async () => {
    // Condition flip true -> false: the prior deploy persisted the output +
    // export; this deploy must drop both from state AND from the exports
    // index (the no-change path's outputsChanged handling).
    conditionsHolder.value = { IsProd: false };
    mockStateBackend.getState.mockResolvedValue({
      state: makeState({
        ProdTopicArn: 'arn:prod',
        'prod:TopicArn': 'arn:prod',
        AlwaysOut: 'always-value',
      }),
      etag: 'etag-old',
    });

    const engine = makeEngine();
    await engine.deploy(stackName, template);

    expect(mockStateBackend.saveState).toHaveBeenCalledTimes(1);
    const saved = mockStateBackend.saveState.mock.calls[0]![2] as StackState;
    expect(saved.outputs).toEqual({ AlwaysOut: 'always-value' });
    expect(mockExportIndexStore.updateForStack).toHaveBeenCalledWith(stackName, 'us-east-1', {
      AlwaysOut: 'always-value',
    });
  });

  it('keeps an Output whose condition name is unknown (filterResourcesByCondition parity)', async () => {
    conditionsHolder.value = {};
    mockStateBackend.getState.mockResolvedValue({ state: makeState({}), etag: 'etag-old' });

    const engine = makeEngine();
    await engine.deploy(stackName, template);

    const saved = mockStateBackend.saveState.mock.calls[0]![2] as StackState;
    expect(saved.outputs).toHaveProperty('ProdTopicArn');
  });
});
