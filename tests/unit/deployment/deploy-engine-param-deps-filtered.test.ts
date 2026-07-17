/**
 * Issue #1032: template Parameter names must NOT be persisted into a
 * resource's state `dependencies`. `extractDependencies` captures every
 * `Ref` — including Refs to CFn Parameters — but a parameter is not a
 * provisioning-order edge, and the destroy-side graph build (which
 * reconstructs a pseudo-template from state with no `Parameters` section)
 * warns `depends on <Param>, but <Param> not found in template` for every
 * parameter-referencing resource on every destroy.
 */

import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
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

vi.mock('../../../src/deployment/intrinsic-function-resolver.js', () => ({
  IntrinsicFunctionResolver: vi.fn().mockImplementation(() => ({
    resolve: vi.fn().mockImplementation((props: unknown) => Promise.resolve(props)),
    resolveParameters: vi.fn().mockResolvedValue({}),
    evaluateConditions: vi.fn().mockResolvedValue({}),
  })),
}));

vi.mock('p-limit', () => ({
  default: vi.fn(() => <T>(fn: () => T) => fn()),
}));

describe('DeployEngine - template Parameter names filtered from state dependencies (#1032)', () => {
  const stackName = 'param-deps-stack';

  let mockProvider: {
    create: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
    getAttribute: ReturnType<typeof vi.fn>;
    readCurrentState: ReturnType<typeof vi.fn>;
  };
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

  beforeEach(() => {
    vi.clearAllMocks();

    mockProvider = {
      create: vi.fn().mockImplementation((logicalId: string) =>
        Promise.resolve({ physicalId: `phys-${logicalId}`, attributes: {} })
      ),
      update: vi.fn(),
      delete: vi.fn().mockResolvedValue(undefined),
      getAttribute: vi.fn(),
      readCurrentState: vi.fn().mockResolvedValue({}),
    };
    mockLockManager = {
      acquireLockWithRetry: vi.fn().mockResolvedValue(true),
      releaseLock: vi.fn().mockResolvedValue(undefined),
    };
    mockDagBuilder = {
      buildGraph: vi.fn().mockReturnValue({}),
      getExecutionLevels: vi.fn().mockReturnValue([['Dep', 'Main']]),
      getDirectDependencies: vi.fn().mockReturnValue([]),
    };
    mockDiffCalculator = {
      calculateDiff: vi.fn(),
      hasChanges: vi.fn().mockReturnValue(true),
      filterByType: vi
        .fn()
        .mockImplementation((changes: Map<string, ResourceChange>, type: string) =>
          Array.from(changes.values()).filter((c) => c.changeType === type)
        ),
    };
    mockProviderRegistry = {
      getProvider: vi.fn().mockReturnValue(mockProvider),
      getProviderFor: vi.fn().mockReturnValue({ provider: mockProvider, provisionedBy: 'sdk' }),
      getRegisteredTypes: vi.fn().mockReturnValue([]),
      validateResourceTypes: vi.fn(),
      validateResourceProperties: vi.fn(),
    };
    mockStateBackend = {
      getState: vi.fn().mockResolvedValue({ state: null, etag: undefined }),
      saveState: vi.fn().mockResolvedValue('etag-new'),
    };
  });

  function makeEngine() {
    return new DeployEngine(
      mockStateBackend as never,
      mockLockManager as never,
      mockDagBuilder as never,
      mockDiffCalculator as never,
      mockProviderRegistry as never,
      { dryRun: false },
      'us-east-1'
    );
  }

  it('CREATE: persists only resource dependencies, dropping Refs to template Parameters', async () => {
    const template: CloudFormationTemplate = {
      Parameters: {
        Env: { Type: 'String', Default: 'dev' },
        RetentionSeconds: { Type: 'Number', Default: 120 },
      },
      Resources: {
        Dep: { Type: 'AWS::SSM::Parameter', Properties: { Value: 'x' } },
        Main: {
          Type: 'AWS::SQS::Queue',
          Properties: {
            QueueName: { Ref: 'Env' },
            MessageRetentionPeriod: { Ref: 'RetentionSeconds' },
            Tag: { Ref: 'Dep' },
          },
        },
      },
    };

    mockDiffCalculator.calculateDiff.mockResolvedValue(
      new Map<string, ResourceChange>([
        [
          'Dep',
          {
            logicalId: 'Dep',
            changeType: 'CREATE',
            resourceType: 'AWS::SSM::Parameter',
            desiredProperties: template.Resources['Dep']!.Properties,
          },
        ],
        [
          'Main',
          {
            logicalId: 'Main',
            changeType: 'CREATE',
            resourceType: 'AWS::SQS::Queue',
            desiredProperties: template.Resources['Main']!.Properties,
          },
        ],
      ])
    );

    const engine = makeEngine();
    await engine.deploy(stackName, template);

    expect(mockStateBackend.saveState).toHaveBeenCalled();
    const saved = mockStateBackend.saveState.mock.calls.at(-1)![2] as StackState;
    // Only the real resource edge survives; parameter Refs are dropped.
    expect(saved.resources['Main']!.dependencies).toEqual(['Dep']);
    // Dep has no dependencies at all — the key is omitted from state.
    expect(saved.resources['Dep']!.dependencies).toBeUndefined();
  });
});
