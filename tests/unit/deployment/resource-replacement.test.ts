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

describe('DeployEngine - Resource Replacement', () => {
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

  const template: CloudFormationTemplate = {
    Resources: {
      MyBucket: {
        Type: 'AWS::S3::Bucket',
        Properties: {
          BucketName: 'new-bucket-name',
        },
      },
    },
  };

  const currentState: StackState = {
    version: 1,
    stackName,
    resources: {
      MyBucket: {
        physicalId: 'old-bucket-physical-id',
        resourceType: 'AWS::S3::Bucket',
        properties: { BucketName: 'old-bucket-name' },
      },
    },
    outputs: {},
    lastModified: Date.now(),
  };

  beforeEach(() => {
    vi.clearAllMocks();

    mockProvider = {
      create: vi.fn().mockResolvedValue({
        physicalId: 'new-bucket-physical-id',
        attributes: { Arn: 'arn:aws:s3:::new-bucket-name' },
      }),
      update: vi.fn().mockResolvedValue({
        physicalId: 'old-bucket-physical-id',
        wasReplaced: false,
      }),
      delete: vi.fn().mockResolvedValue(undefined),
      getAttribute: vi.fn(),
    };

    mockStateBackend = {
      getState: vi.fn().mockResolvedValue({
        state: { ...currentState, resources: { ...currentState.resources } },
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

  it('should replace resource when propertyChanges has requiresReplacement: true', async () => {
    const changes = new Map<string, ResourceChange>([
      [
        'MyBucket',
        {
          logicalId: 'MyBucket',
          changeType: 'UPDATE',
          resourceType: 'AWS::S3::Bucket',
          currentProperties: { BucketName: 'old-bucket-name' },
          desiredProperties: { BucketName: 'new-bucket-name' },
          propertyChanges: [
            {
              path: 'BucketName',
              oldValue: 'old-bucket-name',
              newValue: 'new-bucket-name',
              requiresReplacement: true,
            },
          ],
        },
      ],
    ]);

    mockDiffCalculator.calculateDiff.mockReturnValue(changes);

    const engine = new DeployEngine(
      mockStateBackend as any,
      mockLockManager as any,
      mockDagBuilder as any,
      mockDiffCalculator as any,
      mockProviderRegistry as any
    );

    const result = await engine.deploy(stackName, template);

    // 1. provider.create() should be called first (new resource)
    expect(mockProvider.create).toHaveBeenCalledWith(
      'MyBucket',
      'AWS::S3::Bucket',
      expect.objectContaining({ BucketName: 'new-bucket-name' })
    );

    // 2. provider.delete() should be called second (old resource)
    expect(mockProvider.delete).toHaveBeenCalledWith(
      'MyBucket',
      'old-bucket-physical-id',
      'AWS::S3::Bucket',
      expect.objectContaining({ BucketName: 'old-bucket-name' })
    );

    // Verify create was called before delete (CFn order: CREATE new → DELETE old)
    const createOrder = mockProvider.create.mock.invocationCallOrder[0];
    const deleteOrder = mockProvider.delete.mock.invocationCallOrder[0];
    expect(createOrder).toBeLessThan(deleteOrder);

    // 3. State should be updated with new physicalId
    // saveState is called: partial save after level + final save
    expect(mockStateBackend.saveState).toHaveBeenCalled();
    const savedState = mockStateBackend.saveState.mock.calls[0][1] as StackState;
    expect(savedState.resources['MyBucket'].physicalId).toBe('new-bucket-physical-id');
    expect(savedState.resources['MyBucket'].attributes).toEqual({
      Arn: 'arn:aws:s3:::new-bucket-name',
    });

    // provider.update() should NOT be called during replacement
    expect(mockProvider.update).not.toHaveBeenCalled();

    // Result should count as an update
    expect(result.updated).toBe(1);
    expect(result.created).toBe(0);
    expect(result.deleted).toBe(0);
  });

  it('should perform in-place update when no property requires replacement', async () => {
    const changes = new Map<string, ResourceChange>([
      [
        'MyBucket',
        {
          logicalId: 'MyBucket',
          changeType: 'UPDATE',
          resourceType: 'AWS::S3::Bucket',
          currentProperties: { Tags: [{ Key: 'env', Value: 'old' }] },
          desiredProperties: { Tags: [{ Key: 'env', Value: 'new' }] },
          propertyChanges: [
            {
              path: 'Tags',
              oldValue: [{ Key: 'env', Value: 'old' }],
              newValue: [{ Key: 'env', Value: 'new' }],
              requiresReplacement: false,
            },
          ],
        },
      ],
    ]);

    mockDiffCalculator.calculateDiff.mockReturnValue(changes);

    const engine = new DeployEngine(
      mockStateBackend as any,
      mockLockManager as any,
      mockDagBuilder as any,
      mockDiffCalculator as any,
      mockProviderRegistry as any
    );

    await engine.deploy(stackName, template);

    // In-place update: provider.update() should be called, not create+delete
    expect(mockProvider.update).toHaveBeenCalledTimes(1);
    expect(mockProvider.create).not.toHaveBeenCalled();
    expect(mockProvider.delete).not.toHaveBeenCalled();
  });

  it('should still update state even if delete of old resource fails during replacement', async () => {
    mockProvider.delete.mockRejectedValue(new Error('Delete failed'));

    const changes = new Map<string, ResourceChange>([
      [
        'MyBucket',
        {
          logicalId: 'MyBucket',
          changeType: 'UPDATE',
          resourceType: 'AWS::S3::Bucket',
          currentProperties: { BucketName: 'old-bucket-name' },
          desiredProperties: { BucketName: 'new-bucket-name' },
          propertyChanges: [
            {
              path: 'BucketName',
              oldValue: 'old-bucket-name',
              newValue: 'new-bucket-name',
              requiresReplacement: true,
            },
          ],
        },
      ],
    ]);

    mockDiffCalculator.calculateDiff.mockReturnValue(changes);

    const engine = new DeployEngine(
      mockStateBackend as any,
      mockLockManager as any,
      mockDagBuilder as any,
      mockDiffCalculator as any,
      mockProviderRegistry as any
    );

    // Should NOT throw even though delete failed - the code catches delete errors as warnings
    const result = await engine.deploy(stackName, template);

    // Create should have succeeded
    expect(mockProvider.create).toHaveBeenCalledTimes(1);

    // Delete was attempted but failed
    expect(mockProvider.delete).toHaveBeenCalledTimes(1);

    // State should still be saved with the new physicalId
    const savedState = mockStateBackend.saveState.mock.calls[0][1] as StackState;
    expect(savedState.resources['MyBucket'].physicalId).toBe('new-bucket-physical-id');

    expect(result.updated).toBe(1);
  });

  it('should handle replacement with multiple property changes where only some require replacement', async () => {
    const changes = new Map<string, ResourceChange>([
      [
        'MyBucket',
        {
          logicalId: 'MyBucket',
          changeType: 'UPDATE',
          resourceType: 'AWS::S3::Bucket',
          currentProperties: { BucketName: 'old-name', Tags: [] },
          desiredProperties: { BucketName: 'new-name', Tags: [{ Key: 'env', Value: 'prod' }] },
          propertyChanges: [
            {
              path: 'BucketName',
              oldValue: 'old-name',
              newValue: 'new-name',
              requiresReplacement: true,
            },
            {
              path: 'Tags',
              oldValue: [],
              newValue: [{ Key: 'env', Value: 'prod' }],
              requiresReplacement: false,
            },
          ],
        },
      ],
    ]);

    mockDiffCalculator.calculateDiff.mockReturnValue(changes);

    const engine = new DeployEngine(
      mockStateBackend as any,
      mockLockManager as any,
      mockDagBuilder as any,
      mockDiffCalculator as any,
      mockProviderRegistry as any
    );

    await engine.deploy(stackName, template);

    // Should do replacement (create+delete), not in-place update
    expect(mockProvider.create).toHaveBeenCalledTimes(1);
    expect(mockProvider.delete).toHaveBeenCalledTimes(1);
    expect(mockProvider.update).not.toHaveBeenCalled();
  });

  it('should always release lock even when deployment fails', async () => {
    mockProvider.create.mockRejectedValue(new Error('Create failed'));

    const changes = new Map<string, ResourceChange>([
      [
        'MyBucket',
        {
          logicalId: 'MyBucket',
          changeType: 'UPDATE',
          resourceType: 'AWS::S3::Bucket',
          currentProperties: { BucketName: 'old-name' },
          desiredProperties: { BucketName: 'new-name' },
          propertyChanges: [
            {
              path: 'BucketName',
              oldValue: 'old-name',
              newValue: 'new-name',
              requiresReplacement: true,
            },
          ],
        },
      ],
    ]);

    mockDiffCalculator.calculateDiff.mockReturnValue(changes);

    const engine = new DeployEngine(
      mockStateBackend as any,
      mockLockManager as any,
      mockDagBuilder as any,
      mockDiffCalculator as any,
      mockProviderRegistry as any
    );

    await expect(engine.deploy(stackName, template)).rejects.toThrow();

    // Lock should still be released
    expect(mockLockManager.releaseLock).toHaveBeenCalledWith(stackName);
  });
});
