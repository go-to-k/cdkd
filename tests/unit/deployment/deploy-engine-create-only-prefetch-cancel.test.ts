/**
 * The deploy-start create-only prefetch is opportunistic (issue #3718): when
 * `deploy()` settles — resolved or rejected — no background DescribeType may
 * still be running or queued, since one in a throttle backoff would otherwise
 * hold the process open for up to ~15 s. Runs the REAL resolver and limiter,
 * with a CloudFormation client whose calls only ever end by abort.
 */

import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const signals: AbortSignal[] = [];
const cfnSend = vi.hoisted(() => vi.fn());
vi.mock('../../../src/utils/aws-clients.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../src/utils/aws-clients.js')>();
  return { ...original, getAwsClients: () => ({ cloudFormation: { send: cfnSend } }) };
});

import { clearCreateOnlyPropertiesCache } from '../../../src/provisioning/create-only-properties.js';
import { describeTypeQueueDepth } from '../../../src/provisioning/describe-type.js';
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

describe('DeployEngine - the create-only prefetch never outlives the deploy (issue #3718)', () => {
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
    clearCreateOnlyPropertiesCache();
    signals.length = 0;

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

  beforeEach(() => {
    cfnSend.mockImplementation(
      (_command: unknown, options?: { abortSignal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          const signal = options!.abortSignal!;
          signals.push(signal);
          signal.addEventListener('abort', () => reject(new Error('aborted')));
        })
    );
  });

  it('a successful deploy leaves no DescribeType running or queued', async () => {
    mockDiffCalculator.calculateDiff.mockResolvedValue(makeCreateDiff());

    await makeEngine().deploy(stackName, template);

    expect(signals.length).toBe(2);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(describeTypeQueueDepth()).toEqual({ active: 0, pending: 0 });
  });

  it('a FAILED deploy leaves no DescribeType running or queued either', async () => {
    mockLockManager.acquireLockWithRetry.mockRejectedValue(new Error('lock boom'));

    await expect(makeEngine().deploy(stackName, template)).rejects.toThrow();

    expect(signals.length).toBe(2);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(describeTypeQueueDepth()).toEqual({ active: 0, pending: 0 });
  });
});
