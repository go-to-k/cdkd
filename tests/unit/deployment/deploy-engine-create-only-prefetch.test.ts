/**
 * Part of #1180 (deploy-overhead reduction). doDeploy fires a fire-and-forget
 * prefetch of each distinct template resource type's create-only property paths
 * (`getCreateOnlyPropertyPaths`, backed by cloudformation:DescribeType, ~0.8s
 * cold per type, module-cached for the deploy lifetime) at the very start of the
 * deploy — in parallel with the lock acquisition + state read — so that the
 * later diff's per-resource create-only lookups hit a warm cache instead of
 * paying the round-trip inline on the critical path.
 *
 * These tests pin two properties of that prefetch:
 *  1. it warms the cache for EACH distinct resource type exactly once (dedup);
 *  2. a rejecting lookup never surfaces as an unhandled promise rejection
 *     (the fire-and-forget call carries its own `.catch`).
 */

import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const getCreateOnlyPropertyPaths = vi.fn<(type: string) => Promise<ReadonlyArray<readonly string[]>>>();

vi.mock('../../../src/provisioning/create-only-properties.js', () => ({
  getCreateOnlyPropertyPaths: (type: string) => getCreateOnlyPropertyPaths(type),
  createOnlyChangeRequiresReplacement: vi.fn().mockReturnValue(false),
}));

import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
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

describe('DeployEngine - create-only DescribeType prefetch (#1180)', () => {
  const stackName = 'prefetch-stack';

  let mockProvider: {
    create: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
    getAttribute: ReturnType<typeof vi.fn>;
    readCurrentState: ReturnType<typeof vi.fn>;
  };
  let mockStateBackend: { getState: ReturnType<typeof vi.fn>; saveState: ReturnType<typeof vi.fn> };
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
    getCreateOnlyPropertyPaths.mockResolvedValue([]);

    mockProvider = {
      create: vi
        .fn()
        .mockImplementation((logicalId: string) =>
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
      getExecutionLevels: vi.fn().mockReturnValue([['A', 'B', 'C']]),
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

  const template: CloudFormationTemplate = {
    Resources: {
      A: { Type: 'AWS::SSM::Parameter', Properties: { Value: 'a' } },
      B: { Type: 'AWS::SQS::Queue', Properties: {} },
      // Duplicate type — must NOT trigger a second prefetch for AWS::SSM::Parameter.
      C: { Type: 'AWS::SSM::Parameter', Properties: { Value: 'c' } },
    },
  };

  function makeCreateDiff(): Map<string, ResourceChange> {
    return new Map<string, ResourceChange>(
      Object.entries(template.Resources).map(([id, res]) => [
        id,
        {
          logicalId: id,
          changeType: 'CREATE',
          resourceType: res.Type,
          desiredProperties: res.Properties,
        },
      ])
    );
  }

  it('warms the create-only cache once per DISTINCT resource type', async () => {
    mockDiffCalculator.calculateDiff.mockResolvedValue(makeCreateDiff());

    const engine = makeEngine();
    await engine.deploy(stackName, template);

    // Two distinct types (AWS::SSM::Parameter appears twice) → two prefetch calls.
    const prefetched = getCreateOnlyPropertyPaths.mock.calls.map((c) => c[0]);
    expect(new Set(prefetched)).toEqual(new Set(['AWS::SSM::Parameter', 'AWS::SQS::Queue']));
    expect(prefetched.filter((t) => t === 'AWS::SSM::Parameter')).toHaveLength(1);
  });

  it('does not surface an unhandled rejection when a prefetch lookup rejects', async () => {
    // getCreateOnlyPropertyPaths is documented never-throw, but if it ever
    // rejects the fire-and-forget prefetch must swallow it — otherwise the
    // process logs an unhandledRejection (and the test worker dies).
    getCreateOnlyPropertyPaths.mockRejectedValue(new Error('DescribeType boom'));
    mockDiffCalculator.calculateDiff.mockResolvedValue(makeCreateDiff());

    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const engine = makeEngine();
      // The deploy itself must still succeed — the prefetch is pure latency-hiding.
      await expect(engine.deploy(stackName, template)).resolves.toBeDefined();
      // Let any leaked rejection reach the handler.
      await new Promise((resolve) => setImmediate(resolve));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });
});
