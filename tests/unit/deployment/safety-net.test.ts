import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { ResourceChange, StackState } from '../../../src/types/state.js';

// Mock logger
const mockLoggerInfo = vi.fn();
const mockLoggerWarn = vi.fn();
vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    debug: vi.fn(),
    info: mockLoggerInfo,
    warn: mockLoggerWarn,
    error: vi.fn(),
    child: () => ({
      debug: vi.fn(),
      info: mockLoggerInfo,
      warn: mockLoggerWarn,
      error: vi.fn(),
    }),
  }),
}));

// Mock IntrinsicFunctionResolver - resolve returns properties as-is
vi.mock('../../../src/deployment/intrinsic-function-resolver.js', () => ({
  IntrinsicFunctionResolver: vi.fn().mockImplementation(() => ({
    resolve: vi.fn().mockImplementation((props: unknown) => Promise.resolve(props)),
    resolveParameters: vi.fn().mockReturnValue({}),
    evaluateConditions: vi.fn().mockResolvedValue({}),
  })),
}));

// Mock p-limit to just run the function immediately
vi.mock('p-limit', () => ({
  default: vi.fn(() => <T>(fn: () => T) => fn()),
}));

// Mock CloudControlProvider.isSupportedResourceType
vi.mock('../../../src/provisioning/cloud-control-provider.js', () => ({
  CloudControlProvider: {
    isSupportedResourceType: vi.fn((type: string) => {
      // IAM types are NOT supported by CC API
      const unsupported = new Set([
        'AWS::IAM::Role',
        'AWS::IAM::Policy',
        'AWS::Lambda::LayerVersion',
      ]);
      return !unsupported.has(type);
    }),
  },
}));

describe('DeployEngine - Safety Net (CC API Fallback)', () => {
  let mockSdkProvider: {
    create: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
    handledProperties?: Map<string, ReadonlySet<string>>;
    disableCcApiFallback?: boolean;
  };

  let mockCcApiProvider: {
    create: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
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
    getCloudControlProvider: ReturnType<typeof vi.fn>;
    validateResourceTypes: ReturnType<typeof vi.fn>;
  };

  const stackName = 'test-stack';

  beforeEach(() => {
    vi.clearAllMocks();

    mockSdkProvider = {
      create: vi.fn().mockResolvedValue({
        physicalId: 'physical-id-1',
        attributes: { Arn: 'arn:aws:s3:::test' },
      }),
      update: vi.fn().mockResolvedValue({
        physicalId: 'physical-id-1',
        wasReplaced: false,
      }),
      delete: vi.fn().mockResolvedValue(undefined),
    };

    mockCcApiProvider = {
      create: vi.fn().mockResolvedValue({
        physicalId: 'cc-physical-id-1',
        attributes: { Arn: 'arn:aws:s3:::test-cc' },
      }),
      update: vi.fn().mockResolvedValue({
        physicalId: 'physical-id-1',
        wasReplaced: false,
      }),
      delete: vi.fn().mockResolvedValue(undefined),
    };

    const currentState: StackState = {
      version: 1,
      stackName,
      resources: {},
      outputs: {},
      lastModified: Date.now(),
    };

    mockStateBackend = {
      getState: vi.fn().mockResolvedValue({
        state: currentState,
        etag: 'etag-123',
      }),
      saveState: vi.fn().mockResolvedValue('etag-456'),
    };

    mockLockManager = {
      acquireLockWithRetry: vi.fn().mockResolvedValue(true),
      releaseLock: vi.fn().mockResolvedValue(undefined),
    };

    mockDagBuilder = {
      buildGraph: vi.fn().mockReturnValue({}),
      getExecutionLevels: vi.fn().mockReturnValue([['TestResource']]),
      getDirectDependencies: vi.fn().mockReturnValue([]),
    };

    mockDiffCalculator = {
      calculateDiff: vi.fn(),
      hasChanges: vi.fn().mockReturnValue(true),
      filterByType: vi.fn().mockImplementation(
        (changes: Map<string, ResourceChange>, type: string) => {
          return Array.from(changes.values()).filter((c) => c.changeType === type);
        }
      ),
    };

    mockProviderRegistry = {
      getProvider: vi.fn().mockReturnValue(mockSdkProvider),
      getCloudControlProvider: vi.fn().mockReturnValue(mockCcApiProvider),
      validateResourceTypes: vi.fn(),
    };
  });

  function createEngine() {
    return new DeployEngine(
      mockStateBackend as any,
      mockLockManager as any,
      mockDagBuilder as any,
      mockDiffCalculator as any,
      mockProviderRegistry as any
    );
  }

  function setupCreateChange(
    resourceType: string,
    properties: Record<string, unknown>
  ) {
    const template: CloudFormationTemplate = {
      Resources: {
        TestResource: {
          Type: resourceType,
          Properties: properties,
        },
      },
    };

    const changes = new Map<string, ResourceChange>([
      [
        'TestResource',
        {
          logicalId: 'TestResource',
          changeType: 'CREATE',
          resourceType,
          desiredProperties: properties,
        },
      ],
    ]);

    mockDiffCalculator.calculateDiff.mockResolvedValue(changes);
    return template;
  }

  it('should use SDK provider when all properties are handled', async () => {
    // SDK provider handles BucketName and Tags
    mockSdkProvider.handledProperties = new Map([
      ['AWS::S3::Bucket', new Set(['BucketName', 'Tags'])],
    ]);

    const template = setupCreateChange('AWS::S3::Bucket', {
      BucketName: 'test-bucket',
      Tags: [{ Key: 'env', Value: 'test' }],
    });

    const engine = createEngine();
    await engine.deploy(stackName, template);

    // SDK provider should be used, not CC API
    expect(mockSdkProvider.create).toHaveBeenCalledTimes(1);
    expect(mockCcApiProvider.create).not.toHaveBeenCalled();
  });

  it('should fall back to CC API when SDK provider has unhandled properties', async () => {
    // SDK provider only handles BucketName, NOT CorsConfiguration
    mockSdkProvider.handledProperties = new Map([
      ['AWS::S3::Bucket', new Set(['BucketName'])],
    ]);

    const template = setupCreateChange('AWS::S3::Bucket', {
      BucketName: 'test-bucket',
      CorsConfiguration: { CorsRules: [] },
    });

    const engine = createEngine();
    await engine.deploy(stackName, template);

    // CC API should be used instead of SDK provider
    expect(mockCcApiProvider.create).toHaveBeenCalledTimes(1);
    expect(mockSdkProvider.create).not.toHaveBeenCalled();
  });

  it('should use SDK provider when handledProperties is not declared (assume full coverage)', async () => {
    // No handledProperties declared — assume the provider handles everything
    delete mockSdkProvider.handledProperties;

    const template = setupCreateChange('AWS::S3::Bucket', {
      BucketName: 'test-bucket',
      CorsConfiguration: { CorsRules: [] },
      LifecycleConfiguration: { Rules: [] },
    });

    const engine = createEngine();
    await engine.deploy(stackName, template);

    // SDK provider should be used (no safety net without declaration)
    expect(mockSdkProvider.create).toHaveBeenCalledTimes(1);
    expect(mockCcApiProvider.create).not.toHaveBeenCalled();
  });

  it('should throw error when CC API is not supported and properties are unhandled', async () => {
    // IAM::Role is not supported by CC API
    mockSdkProvider.handledProperties = new Map([
      ['AWS::IAM::Role', new Set(['RoleName', 'AssumeRolePolicyDocument'])],
    ]);

    const template = setupCreateChange('AWS::IAM::Role', {
      RoleName: 'test-role',
      AssumeRolePolicyDocument: {},
      SomeNewProperty: 'value', // Not handled by SDK provider
    });

    const engine = createEngine();
    await expect(engine.deploy(stackName, template)).rejects.toThrow(
      /Failed to create resource TestResource/
    );

    // Neither provider should have been called for create
    expect(mockSdkProvider.create).not.toHaveBeenCalled();
    expect(mockCcApiProvider.create).not.toHaveBeenCalled();
  });

  it('should throw error when disableCcApiFallback is true even if CC API supports the type', async () => {
    // Provider exists because CC API has known issues — disable fallback
    mockSdkProvider.handledProperties = new Map([
      ['AWS::S3::Bucket', new Set(['BucketName'])],
    ]);
    mockSdkProvider.disableCcApiFallback = true;

    const template = setupCreateChange('AWS::S3::Bucket', {
      BucketName: 'test-bucket',
      CorsConfiguration: { CorsRules: [] }, // Not handled
    });

    const engine = createEngine();
    await expect(engine.deploy(stackName, template)).rejects.toThrow(
      /Failed to create resource TestResource/
    );

    expect(mockSdkProvider.create).not.toHaveBeenCalled();
    expect(mockCcApiProvider.create).not.toHaveBeenCalled();
  });

  it('should log info message when falling back to CC API', async () => {
    mockSdkProvider.handledProperties = new Map([
      ['AWS::S3::Bucket', new Set(['BucketName'])],
    ]);

    const template = setupCreateChange('AWS::S3::Bucket', {
      BucketName: 'test-bucket',
      CorsConfiguration: { CorsRules: [] },
    });

    const engine = createEngine();
    await engine.deploy(stackName, template);

    // Should have logged fallback info
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      expect.stringContaining('falling back to CC API')
    );
  });
});
