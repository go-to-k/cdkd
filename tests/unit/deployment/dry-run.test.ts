import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { ResourceChange, StackState } from '../../../src/types/state.js';

// Mock logger
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

// Mock IntrinsicFunctionResolver - resolve returns properties as-is, others are no-ops
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

describe('DeployEngine - Dry Run Mode', () => {
  // Shared mocks
  let mockProvider: {
    create: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
    getAttribute: ReturnType<typeof vi.fn>;
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
  };

  let mockDiffCalculator: {
    calculateDiff: ReturnType<typeof vi.fn>;
    hasChanges: ReturnType<typeof vi.fn>;
    filterByType: ReturnType<typeof vi.fn>;
  };

  let mockProviderRegistry: {
    getProvider: ReturnType<typeof vi.fn>;
    validateResourceTypes: ReturnType<typeof vi.fn>;
  };

  const stackName = 'test-stack';

  beforeEach(() => {
    vi.clearAllMocks();

    mockProvider = {
      create: vi.fn().mockResolvedValue({
        physicalId: 'new-physical-id',
        attributes: { Arn: 'arn:aws:s3:::my-bucket' },
      }),
      update: vi.fn().mockResolvedValue({
        physicalId: 'existing-physical-id',
        wasReplaced: false,
      }),
      delete: vi.fn().mockResolvedValue(undefined),
      getAttribute: vi.fn(),
    };

    mockStateBackend = {
      getState: vi.fn().mockResolvedValue({
        state: {
          version: 1,
          stackName,
          resources: {},
          outputs: {},
          lastModified: Date.now(),
        },
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
      getExecutionLevels: vi.fn().mockReturnValue([['MyBucket']]),
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
      getProvider: vi.fn().mockReturnValue(mockProvider),
      validateResourceTypes: vi.fn(),
    };
  });

  // Helper to create a DeployEngine with dryRun enabled
  function createDryRunEngine(): InstanceType<typeof DeployEngine> {
    return new DeployEngine(
      mockStateBackend as any,
      mockLockManager as any,
      mockDagBuilder as any,
      mockDiffCalculator as any,
      mockProviderRegistry as any,
      { dryRun: true }
    );
  }

  // Helper to create a DeployEngine with dryRun disabled (normal mode)
  function createNormalEngine(): InstanceType<typeof DeployEngine> {
    return new DeployEngine(
      mockStateBackend as any,
      mockLockManager as any,
      mockDagBuilder as any,
      mockDiffCalculator as any,
      mockProviderRegistry as any,
      { dryRun: false }
    );
  }

  describe('CREATE scenario', () => {
    const template: CloudFormationTemplate = {
      Resources: {
        MyBucket: {
          Type: 'AWS::S3::Bucket',
          Properties: { BucketName: 'my-bucket' },
        },
      },
    };

    it('should return correct counts without calling provider.create', async () => {
      const changes = new Map<string, ResourceChange>([
        [
          'MyBucket',
          {
            logicalId: 'MyBucket',
            changeType: 'CREATE',
            resourceType: 'AWS::S3::Bucket',
            desiredProperties: { BucketName: 'my-bucket' },
          },
        ],
      ]);

      mockDiffCalculator.calculateDiff.mockResolvedValue(changes);

      const engine = createDryRunEngine();
      const result = await engine.deploy(stackName, template);

      expect(result.created).toBe(1);
      expect(result.updated).toBe(0);
      expect(result.deleted).toBe(0);
      expect(result.unchanged).toBe(0);
      expect(result.stackName).toBe(stackName);

      // Provider should NOT be called
      expect(mockProvider.create).not.toHaveBeenCalled();
      expect(mockProvider.update).not.toHaveBeenCalled();
      expect(mockProvider.delete).not.toHaveBeenCalled();
    });
  });

  describe('UPDATE scenario', () => {
    const template: CloudFormationTemplate = {
      Resources: {
        MyBucket: {
          Type: 'AWS::S3::Bucket',
          Properties: { BucketName: 'updated-bucket' },
        },
      },
    };

    beforeEach(() => {
      mockStateBackend.getState.mockResolvedValue({
        state: {
          version: 1,
          stackName,
          resources: {
            MyBucket: {
              physicalId: 'existing-physical-id',
              resourceType: 'AWS::S3::Bucket',
              properties: { BucketName: 'old-bucket' },
            },
          },
          outputs: {},
          lastModified: Date.now(),
        } satisfies StackState,
        etag: 'etag-123',
      });
    });

    it('should return correct counts without calling provider.update', async () => {
      const changes = new Map<string, ResourceChange>([
        [
          'MyBucket',
          {
            logicalId: 'MyBucket',
            changeType: 'UPDATE',
            resourceType: 'AWS::S3::Bucket',
            currentProperties: { BucketName: 'old-bucket' },
            desiredProperties: { BucketName: 'updated-bucket' },
          },
        ],
      ]);

      mockDiffCalculator.calculateDiff.mockResolvedValue(changes);

      const engine = createDryRunEngine();
      const result = await engine.deploy(stackName, template);

      expect(result.created).toBe(0);
      expect(result.updated).toBe(1);
      expect(result.deleted).toBe(0);
      expect(result.unchanged).toBe(0);
      expect(result.stackName).toBe(stackName);

      // Provider should NOT be called
      expect(mockProvider.create).not.toHaveBeenCalled();
      expect(mockProvider.update).not.toHaveBeenCalled();
      expect(mockProvider.delete).not.toHaveBeenCalled();
    });
  });

  describe('DELETE scenario', () => {
    const template: CloudFormationTemplate = {
      Resources: {},
    };

    beforeEach(() => {
      mockStateBackend.getState.mockResolvedValue({
        state: {
          version: 1,
          stackName,
          resources: {
            MyBucket: {
              physicalId: 'existing-physical-id',
              resourceType: 'AWS::S3::Bucket',
              properties: { BucketName: 'my-bucket' },
            },
          },
          outputs: {},
          lastModified: Date.now(),
        } satisfies StackState,
        etag: 'etag-123',
      });

      mockDagBuilder.getExecutionLevels.mockReturnValue([['MyBucket']]);
    });

    it('should return correct counts without calling provider.delete', async () => {
      const changes = new Map<string, ResourceChange>([
        [
          'MyBucket',
          {
            logicalId: 'MyBucket',
            changeType: 'DELETE',
            resourceType: 'AWS::S3::Bucket',
            currentProperties: { BucketName: 'my-bucket' },
          },
        ],
      ]);

      mockDiffCalculator.calculateDiff.mockResolvedValue(changes);

      const engine = createDryRunEngine();
      const result = await engine.deploy(stackName, template);

      expect(result.created).toBe(0);
      expect(result.updated).toBe(0);
      expect(result.deleted).toBe(1);
      expect(result.unchanged).toBe(0);
      expect(result.stackName).toBe(stackName);

      // Provider should NOT be called
      expect(mockProvider.create).not.toHaveBeenCalled();
      expect(mockProvider.update).not.toHaveBeenCalled();
      expect(mockProvider.delete).not.toHaveBeenCalled();
    });
  });

  describe('mixed CREATE + UPDATE + DELETE + NO_CHANGE scenario', () => {
    const template: CloudFormationTemplate = {
      Resources: {
        NewResource: {
          Type: 'AWS::SNS::Topic',
          Properties: { TopicName: 'new-topic' },
        },
        UpdatedBucket: {
          Type: 'AWS::S3::Bucket',
          Properties: { BucketName: 'updated-bucket' },
        },
        UnchangedQueue: {
          Type: 'AWS::SQS::Queue',
          Properties: { QueueName: 'my-queue' },
        },
      },
    };

    beforeEach(() => {
      mockStateBackend.getState.mockResolvedValue({
        state: {
          version: 1,
          stackName,
          resources: {
            UpdatedBucket: {
              physicalId: 'bucket-physical-id',
              resourceType: 'AWS::S3::Bucket',
              properties: { BucketName: 'old-bucket' },
            },
            DeletedTable: {
              physicalId: 'table-physical-id',
              resourceType: 'AWS::DynamoDB::Table',
              properties: { TableName: 'my-table' },
            },
            UnchangedQueue: {
              physicalId: 'queue-physical-id',
              resourceType: 'AWS::SQS::Queue',
              properties: { QueueName: 'my-queue' },
            },
          },
          outputs: {},
          lastModified: Date.now(),
        } satisfies StackState,
        etag: 'etag-123',
      });

      mockDagBuilder.getExecutionLevels.mockReturnValue([
        ['NewResource', 'UpdatedBucket', 'UnchangedQueue', 'DeletedTable'],
      ]);
    });

    it('should return correct counts for all change types', async () => {
      const changes = new Map<string, ResourceChange>([
        [
          'NewResource',
          {
            logicalId: 'NewResource',
            changeType: 'CREATE',
            resourceType: 'AWS::SNS::Topic',
            desiredProperties: { TopicName: 'new-topic' },
          },
        ],
        [
          'UpdatedBucket',
          {
            logicalId: 'UpdatedBucket',
            changeType: 'UPDATE',
            resourceType: 'AWS::S3::Bucket',
            currentProperties: { BucketName: 'old-bucket' },
            desiredProperties: { BucketName: 'updated-bucket' },
          },
        ],
        [
          'DeletedTable',
          {
            logicalId: 'DeletedTable',
            changeType: 'DELETE',
            resourceType: 'AWS::DynamoDB::Table',
            currentProperties: { TableName: 'my-table' },
          },
        ],
        [
          'UnchangedQueue',
          {
            logicalId: 'UnchangedQueue',
            changeType: 'NO_CHANGE',
            resourceType: 'AWS::SQS::Queue',
          },
        ],
      ]);

      mockDiffCalculator.calculateDiff.mockResolvedValue(changes);

      const engine = createDryRunEngine();
      const result = await engine.deploy(stackName, template);

      expect(result.created).toBe(1);
      expect(result.updated).toBe(1);
      expect(result.deleted).toBe(1);
      expect(result.unchanged).toBe(1);
      expect(result.stackName).toBe(stackName);

      // No provider methods should be called
      expect(mockProvider.create).not.toHaveBeenCalled();
      expect(mockProvider.update).not.toHaveBeenCalled();
      expect(mockProvider.delete).not.toHaveBeenCalled();
    });
  });

  describe('lock and state behavior', () => {
    const template: CloudFormationTemplate = {
      Resources: {
        MyBucket: {
          Type: 'AWS::S3::Bucket',
          Properties: { BucketName: 'my-bucket' },
        },
      },
    };

    it('should not save state in dry-run mode', async () => {
      const changes = new Map<string, ResourceChange>([
        [
          'MyBucket',
          {
            logicalId: 'MyBucket',
            changeType: 'CREATE',
            resourceType: 'AWS::S3::Bucket',
            desiredProperties: { BucketName: 'my-bucket' },
          },
        ],
      ]);

      mockDiffCalculator.calculateDiff.mockResolvedValue(changes);

      const engine = createDryRunEngine();
      await engine.deploy(stackName, template);

      // saveState should NOT be called (dry-run returns before executeDeployment)
      expect(mockStateBackend.saveState).not.toHaveBeenCalled();
    });

    it('should still acquire and release lock in dry-run mode', async () => {
      // Note: The current implementation acquires the lock even in dry-run mode
      // because the dry-run check happens after lock acquisition. This test
      // documents the current behavior.
      const changes = new Map<string, ResourceChange>([
        [
          'MyBucket',
          {
            logicalId: 'MyBucket',
            changeType: 'CREATE',
            resourceType: 'AWS::S3::Bucket',
            desiredProperties: { BucketName: 'my-bucket' },
          },
        ],
      ]);

      mockDiffCalculator.calculateDiff.mockResolvedValue(changes);

      const engine = createDryRunEngine();
      await engine.deploy(stackName, template);

      // Lock is acquired and released (current implementation behavior)
      expect(mockLockManager.acquireLockWithRetry).toHaveBeenCalledWith(stackName, undefined, 'deploy');
      expect(mockLockManager.releaseLock).toHaveBeenCalledWith(stackName);
    });
  });

  describe('dry-run vs normal mode comparison', () => {
    const template: CloudFormationTemplate = {
      Resources: {
        MyBucket: {
          Type: 'AWS::S3::Bucket',
          Properties: { BucketName: 'my-bucket' },
        },
      },
    };

    it('normal mode should call provider.create while dry-run should not', async () => {
      const changes = new Map<string, ResourceChange>([
        [
          'MyBucket',
          {
            logicalId: 'MyBucket',
            changeType: 'CREATE',
            resourceType: 'AWS::S3::Bucket',
            desiredProperties: { BucketName: 'my-bucket' },
          },
        ],
      ]);

      mockDiffCalculator.calculateDiff.mockResolvedValue(changes);

      // Dry-run mode
      const dryRunEngine = createDryRunEngine();
      const dryRunResult = await dryRunEngine.deploy(stackName, template);

      expect(mockProvider.create).not.toHaveBeenCalled();
      expect(dryRunResult.created).toBe(1);

      // Reset mocks
      vi.clearAllMocks();

      // Re-setup mocks after clearAllMocks
      mockStateBackend.getState.mockResolvedValue({
        state: {
          version: 1,
          stackName,
          resources: {},
          outputs: {},
          lastModified: Date.now(),
        },
        etag: 'etag-123',
      });
      mockStateBackend.saveState.mockResolvedValue('etag-456');
      mockLockManager.acquireLockWithRetry.mockResolvedValue(true);
      mockLockManager.releaseLock.mockResolvedValue(undefined);
      mockDagBuilder.buildGraph.mockReturnValue({});
      mockDagBuilder.getExecutionLevels.mockReturnValue([['MyBucket']]);
      mockDiffCalculator.calculateDiff.mockResolvedValue(changes);
      mockDiffCalculator.hasChanges.mockReturnValue(true);
      mockDiffCalculator.filterByType.mockImplementation(
        (ch: Map<string, ResourceChange>, type: string) => {
          return Array.from(ch.values()).filter((c) => c.changeType === type);
        }
      );
      mockProviderRegistry.getProvider.mockReturnValue(mockProvider);
      mockProviderRegistry.validateResourceTypes.mockReturnValue(undefined);
      mockProvider.create.mockResolvedValue({
        physicalId: 'new-physical-id',
        attributes: { Arn: 'arn:aws:s3:::my-bucket' },
      });

      // Normal mode
      const normalEngine = createNormalEngine();
      const normalResult = await normalEngine.deploy(stackName, template);

      expect(mockProvider.create).toHaveBeenCalledTimes(1);
      expect(normalResult.created).toBe(1);

      // Normal mode should save state
      expect(mockStateBackend.saveState).toHaveBeenCalled();
    });
  });

  describe('no changes scenario', () => {
    const template: CloudFormationTemplate = {
      Resources: {
        MyBucket: {
          Type: 'AWS::S3::Bucket',
          Properties: { BucketName: 'my-bucket' },
        },
      },
    };

    it('should return all unchanged when no diff is detected (even in dry-run)', async () => {
      mockStateBackend.getState.mockResolvedValue({
        state: {
          version: 1,
          stackName,
          resources: {
            MyBucket: {
              physicalId: 'bucket-id',
              resourceType: 'AWS::S3::Bucket',
              properties: { BucketName: 'my-bucket' },
            },
          },
          outputs: {},
          lastModified: Date.now(),
        } satisfies StackState,
        etag: 'etag-123',
      });

      // No changes detected
      mockDiffCalculator.hasChanges.mockReturnValue(false);
      mockDiffCalculator.calculateDiff.mockResolvedValue(new Map());

      const engine = createDryRunEngine();
      const result = await engine.deploy(stackName, template);

      expect(result.created).toBe(0);
      expect(result.updated).toBe(0);
      expect(result.deleted).toBe(0);
      expect(result.unchanged).toBe(1);

      // No provider calls and no state save
      expect(mockProvider.create).not.toHaveBeenCalled();
      expect(mockProvider.update).not.toHaveBeenCalled();
      expect(mockProvider.delete).not.toHaveBeenCalled();
      expect(mockStateBackend.saveState).not.toHaveBeenCalled();
    });
  });

  describe('durationMs', () => {
    const template: CloudFormationTemplate = {
      Resources: {
        MyBucket: {
          Type: 'AWS::S3::Bucket',
          Properties: { BucketName: 'my-bucket' },
        },
      },
    };

    it('should return a non-negative durationMs', async () => {
      const changes = new Map<string, ResourceChange>([
        [
          'MyBucket',
          {
            logicalId: 'MyBucket',
            changeType: 'CREATE',
            resourceType: 'AWS::S3::Bucket',
            desiredProperties: { BucketName: 'my-bucket' },
          },
        ],
      ]);

      mockDiffCalculator.calculateDiff.mockResolvedValue(changes);

      const engine = createDryRunEngine();
      const result = await engine.deploy(stackName, template);

      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });
  });
});
