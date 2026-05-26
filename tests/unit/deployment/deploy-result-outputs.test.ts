import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { ResourceChange } from '../../../src/types/state.js';

vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  }),
}));

vi.mock('../../../src/deployment/intrinsic-function-resolver.js', () => ({
  IntrinsicFunctionResolver: vi.fn().mockImplementation(() => ({
    resolve: vi.fn().mockImplementation((value: unknown) => Promise.resolve(value)),
    resolveParameters: vi.fn().mockReturnValue({}),
    evaluateConditions: vi.fn().mockResolvedValue({}),
  })),
}));

vi.mock('p-limit', () => ({
  default: vi.fn(() => <T>(fn: () => T) => fn()),
}));

describe('DeployEngine - DeployResult.outputs', () => {
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
    validateResourceTypes: ReturnType<typeof vi.fn>;
    validateResourceProperties: ReturnType<typeof vi.fn>;
  };

  const stackName = 'MyStack';

  beforeEach(() => {
    vi.clearAllMocks();

    mockStateBackend = {
      getState: vi.fn().mockResolvedValue({
        state: {
          version: 5,
          stackName,
          region: 'us-east-1',
          resources: {},
          outputs: {
            ChatApiEndpoint: 'https://abc.execute-api.us-east-1.amazonaws.com/prod/',
            // Duplicated under the Export.Name key — must NOT be surfaced.
            'my-export-name': 'https://abc.execute-api.us-east-1.amazonaws.com/prod/',
          },
          lastModified: Date.now(),
        },
        etag: 'etag-1',
      }),
      saveState: vi.fn().mockResolvedValue('etag-2'),
    };

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
      calculateDiff: vi.fn().mockResolvedValue(new Map<string, ResourceChange>()),
      hasChanges: vi.fn().mockReturnValue(false),
      filterByType: vi.fn().mockReturnValue([]),
    };

    mockProviderRegistry = {
      getProvider: vi.fn(),
      validateResourceTypes: vi.fn(),
      validateResourceProperties: vi.fn(),
    };
  });

  function makeEngine(): InstanceType<typeof DeployEngine> {
    return new DeployEngine(
      mockStateBackend as any,
      mockLockManager as any,
      mockDagBuilder as any,
      mockDiffCalculator as any,
      mockProviderRegistry as any,
      { dryRun: false, captureObservedState: false },
      'us-east-1'
    );
  }

  it('no-change path: returns outputs filtered by template.Outputs keys', async () => {
    const template: CloudFormationTemplate = {
      Resources: {},
      Outputs: {
        ChatApiEndpoint: {
          Value: 'https://abc.execute-api.us-east-1.amazonaws.com/prod/',
          Export: { Name: 'my-export-name' },
        },
      },
    };

    const engine = makeEngine();
    const result = await engine.deploy(stackName, template);

    expect(result.outputs).toEqual({
      ChatApiEndpoint: 'https://abc.execute-api.us-east-1.amazonaws.com/prod/',
    });
    expect(result.outputs && 'my-export-name' in result.outputs).toBe(false);
  });

  it('no-change path: omits outputs key entirely when template has no Outputs', async () => {
    const template: CloudFormationTemplate = { Resources: {} };

    const engine = makeEngine();
    const result = await engine.deploy(stackName, template);

    expect(result.outputs).toEqual({});
  });

  it('dry-run path: outputs field is undefined (no actual deploy)', async () => {
    const template: CloudFormationTemplate = {
      Resources: {
        Bucket: { Type: 'AWS::S3::Bucket', Properties: {} },
      },
      Outputs: {
        BucketName: { Value: { Ref: 'Bucket' } },
      },
    };
    const changes = new Map<string, ResourceChange>([
      [
        'Bucket',
        {
          logicalId: 'Bucket',
          changeType: 'CREATE',
          resourceType: 'AWS::S3::Bucket',
          desiredProperties: {},
        },
      ],
    ]);
    mockDiffCalculator.calculateDiff.mockResolvedValue(changes);
    mockDiffCalculator.hasChanges.mockReturnValue(true);
    mockDiffCalculator.filterByType.mockImplementation(
      (m: Map<string, ResourceChange>, t: string) =>
        Array.from(m.values()).filter((c) => c.changeType === t)
    );

    const engine = new DeployEngine(
      mockStateBackend as any,
      mockLockManager as any,
      mockDagBuilder as any,
      mockDiffCalculator as any,
      mockProviderRegistry as any,
      { dryRun: true },
      'us-east-1'
    );
    const result = await engine.deploy(stackName, template);

    expect(result.outputs).toBeUndefined();
  });
});
