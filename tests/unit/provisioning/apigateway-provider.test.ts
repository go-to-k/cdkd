import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NotFoundException } from '@aws-sdk/client-api-gateway';

// Mock AWS clients before importing the provider
const mockSend = vi.fn();

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    apiGateway: { send: mockSend },
  }),
}));

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  return {
    getLogger: () => ({
      child: () => childLogger,
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  };
});

import { ApiGatewayProvider } from '../../../src/provisioning/providers/apigateway-provider.js';

describe('ApiGatewayProvider', () => {
  let provider: ApiGatewayProvider;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    provider = new ApiGatewayProvider();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ─── AWS::ApiGateway::Account ─────────────────────────────────────

  describe('AWS::ApiGateway::Account', () => {
    const resourceType = 'AWS::ApiGateway::Account';

    describe('create', () => {
      it('should create account with CloudWatchRoleArn', async () => {
        mockSend.mockResolvedValueOnce({});

        const result = await provider.create('MyAccount', resourceType, {
          CloudWatchRoleArn: 'arn:aws:iam::123456789012:role/ApiGwCloudWatchRole',
        });

        expect(result.physicalId).toBe('ApiGatewayAccount');
        expect(mockSend).toHaveBeenCalledTimes(1);

        const command = mockSend.mock.calls[0][0];
        expect(command.constructor.name).toBe('UpdateAccountCommand');
        expect(command.input.patchOperations).toEqual([
          {
            op: 'replace',
            path: '/cloudwatchRoleArn',
            value: 'arn:aws:iam::123456789012:role/ApiGwCloudWatchRole',
          },
        ]);
      });

      it('should create account without CloudWatchRoleArn', async () => {
        mockSend.mockResolvedValueOnce({});

        const result = await provider.create('MyAccount', resourceType, {});

        expect(result.physicalId).toBe('ApiGatewayAccount');
        expect(mockSend).toHaveBeenCalledTimes(1);

        const command = mockSend.mock.calls[0][0];
        expect(command.input.patchOperations).toEqual([]);
      });

      it('should retry on IAM propagation error', async () => {
        // First attempt fails with IAM propagation error
        mockSend.mockRejectedValueOnce(new Error('The role ARN does not have required trust'));
        // Second attempt succeeds
        mockSend.mockResolvedValueOnce({});

        const promise = provider.create('MyAccount', resourceType, {
          CloudWatchRoleArn: 'arn:aws:iam::123456789012:role/ApiGwCloudWatchRole',
        });

        // Advance past the retry delay
        await vi.advanceTimersByTimeAsync(5000);

        const result = await promise;
        expect(result.physicalId).toBe('ApiGatewayAccount');
        expect(mockSend).toHaveBeenCalledTimes(2);
      });

      it('should retry on "not authorized" error', async () => {
        mockSend.mockRejectedValueOnce(new Error('not authorized to perform'));
        mockSend.mockResolvedValueOnce({});

        const promise = provider.create('MyAccount', resourceType, {
          CloudWatchRoleArn: 'arn:aws:iam::123456789012:role/ApiGwCloudWatchRole',
        });

        await vi.advanceTimersByTimeAsync(5000);

        const result = await promise;
        expect(result.physicalId).toBe('ApiGatewayAccount');
        expect(mockSend).toHaveBeenCalledTimes(2);
      });

      it('should throw after max retries on IAM propagation error', async () => {
        const error = new Error('The role ARN does not have required trust');
        mockSend.mockRejectedValueOnce(error);
        mockSend.mockRejectedValueOnce(error);
        mockSend.mockRejectedValueOnce(error);

        const promise = provider
          .create('MyAccount', resourceType, {
            CloudWatchRoleArn: 'arn:aws:iam::123456789012:role/ApiGwCloudWatchRole',
          })
          .catch((e: unknown) => e);

        // Advance past both retry delays
        await vi.advanceTimersByTimeAsync(10000);

        const result = await promise;
        expect(result).toBeDefined();
        expect((result as Error).message).toContain('Failed to create API Gateway Account');
        expect(mockSend).toHaveBeenCalledTimes(3);
      });

      it('should throw immediately on non-IAM errors', async () => {
        mockSend.mockRejectedValueOnce(new Error('Some other error'));

        await expect(
          provider.create('MyAccount', resourceType, {
            CloudWatchRoleArn: 'arn:aws:iam::123456789012:role/ApiGwCloudWatchRole',
          })
        ).rejects.toThrow('Failed to create API Gateway Account');

        expect(mockSend).toHaveBeenCalledTimes(1);
      });
    });

    describe('update', () => {
      it('should update account with new CloudWatchRoleArn', async () => {
        mockSend.mockResolvedValueOnce({});

        const result = await provider.update(
          'MyAccount',
          'ApiGatewayAccount',
          resourceType,
          { CloudWatchRoleArn: 'arn:aws:iam::123456789012:role/NewRole' },
          { CloudWatchRoleArn: 'arn:aws:iam::123456789012:role/OldRole' }
        );

        expect(result.physicalId).toBe('ApiGatewayAccount');
        expect(result.wasReplaced).toBe(false);
        expect(mockSend).toHaveBeenCalledTimes(1);
      });

      it('should retry on IAM propagation error during update', async () => {
        mockSend.mockRejectedValueOnce(new Error('not authorized to perform'));
        mockSend.mockResolvedValueOnce({});

        const promise = provider.update(
          'MyAccount',
          'ApiGatewayAccount',
          resourceType,
          { CloudWatchRoleArn: 'arn:aws:iam::123456789012:role/NewRole' },
          {}
        );

        await vi.advanceTimersByTimeAsync(5000);

        const result = await promise;
        expect(result.physicalId).toBe('ApiGatewayAccount');
        expect(mockSend).toHaveBeenCalledTimes(2);
      });
    });

    describe('delete', () => {
      it('should clear CloudWatchRoleArn on delete', async () => {
        mockSend.mockResolvedValueOnce({});

        await provider.delete('MyAccount', 'ApiGatewayAccount', resourceType);

        expect(mockSend).toHaveBeenCalledTimes(1);

        const command = mockSend.mock.calls[0][0];
        expect(command.constructor.name).toBe('UpdateAccountCommand');
        expect(command.input.patchOperations).toEqual([
          {
            op: 'replace',
            path: '/cloudwatchRoleArn',
            value: '',
          },
        ]);
      });

      it('should throw on delete failure', async () => {
        mockSend.mockRejectedValueOnce(new Error('Service error'));

        await expect(
          provider.delete('MyAccount', 'ApiGatewayAccount', resourceType)
        ).rejects.toThrow('Failed to delete API Gateway Account');
      });
    });

    describe('getAttribute', () => {
      it('should return undefined for any attribute', async () => {
        const result = await provider.getAttribute(
          'ApiGatewayAccount',
          resourceType,
          'SomeAttr'
        );

        expect(result).toBeUndefined();
      });
    });
  });

  // ─── AWS::ApiGateway::Resource ────────────────────────────────────

  describe('AWS::ApiGateway::Resource', () => {
    const resourceType = 'AWS::ApiGateway::Resource';

    describe('create', () => {
      it('should create a resource with restApiId, parentId, pathPart', async () => {
        mockSend.mockResolvedValueOnce({ id: 'abc123' });

        const result = await provider.create('MyResource', resourceType, {
          RestApiId: 'api-id',
          ParentId: 'parent-id',
          PathPart: 'users',
        });

        expect(result.physicalId).toBe('abc123');
        expect(result.attributes).toEqual({ ResourceId: 'abc123' });
        expect(mockSend).toHaveBeenCalledTimes(1);

        const command = mockSend.mock.calls[0][0];
        expect(command.constructor.name).toBe('CreateResourceCommand');
        expect(command.input).toEqual({
          restApiId: 'api-id',
          parentId: 'parent-id',
          pathPart: 'users',
        });
      });

      it('should throw when required properties are missing', async () => {
        await expect(
          provider.create('MyResource', resourceType, {
            RestApiId: 'api-id',
          })
        ).rejects.toThrow('RestApiId, ParentId, and PathPart are required');
      });

      it('should throw on API error', async () => {
        mockSend.mockRejectedValueOnce(new Error('API error'));

        await expect(
          provider.create('MyResource', resourceType, {
            RestApiId: 'api-id',
            ParentId: 'parent-id',
            PathPart: 'users',
          })
        ).rejects.toThrow('Failed to create API Gateway Resource');
      });
    });

    describe('update', () => {
      it('should return no change when pathPart is unchanged', async () => {
        const result = await provider.update(
          'MyResource',
          'abc123',
          resourceType,
          { RestApiId: 'api-id', ParentId: 'parent-id', PathPart: 'users' },
          { RestApiId: 'api-id', ParentId: 'parent-id', PathPart: 'users' }
        );

        expect(result.physicalId).toBe('abc123');
        expect(result.wasReplaced).toBe(false);
        expect(result.attributes).toEqual({ ResourceId: 'abc123' });
        expect(mockSend).not.toHaveBeenCalled();
      });

      it('should replace resource when pathPart changes', async () => {
        // CreateResource for new resource
        mockSend.mockResolvedValueOnce({ id: 'new-id' });
        // DeleteResource for old resource
        mockSend.mockResolvedValueOnce({});

        const result = await provider.update(
          'MyResource',
          'old-id',
          resourceType,
          { RestApiId: 'api-id', ParentId: 'parent-id', PathPart: 'orders' },
          { RestApiId: 'api-id', ParentId: 'parent-id', PathPart: 'users' }
        );

        expect(result.physicalId).toBe('new-id');
        expect(result.wasReplaced).toBe(true);
        expect(result.attributes).toEqual({ ResourceId: 'new-id' });
        expect(mockSend).toHaveBeenCalledTimes(2);
      });

      it('should still return new resource if old resource deletion fails during replacement', async () => {
        // CreateResource succeeds
        mockSend.mockResolvedValueOnce({ id: 'new-id' });
        // DeleteResource fails
        mockSend.mockRejectedValueOnce(new Error('delete failed'));

        const result = await provider.update(
          'MyResource',
          'old-id',
          resourceType,
          { RestApiId: 'api-id', ParentId: 'parent-id', PathPart: 'orders' },
          { RestApiId: 'api-id', ParentId: 'parent-id', PathPart: 'users' }
        );

        expect(result.physicalId).toBe('new-id');
        expect(result.wasReplaced).toBe(true);
      });
    });

    describe('delete', () => {
      it('should delete a resource', async () => {
        mockSend.mockResolvedValueOnce({});

        await provider.delete('MyResource', 'abc123', resourceType, {
          RestApiId: 'api-id',
        });

        expect(mockSend).toHaveBeenCalledTimes(1);

        const command = mockSend.mock.calls[0][0];
        expect(command.constructor.name).toBe('DeleteResourceCommand');
        expect(command.input).toEqual({
          restApiId: 'api-id',
          resourceId: 'abc123',
        });
      });

      it('should skip deletion when resource not found', async () => {
        mockSend.mockRejectedValueOnce(
          new NotFoundException({ $metadata: {}, message: 'not found' })
        );

        await provider.delete('MyResource', 'abc123', resourceType, {
          RestApiId: 'api-id',
        });

        expect(mockSend).toHaveBeenCalledTimes(1);
      });

      it('should throw when RestApiId is missing', async () => {
        await expect(
          provider.delete('MyResource', 'abc123', resourceType, {})
        ).rejects.toThrow('RestApiId is required to delete');
      });

      it('should throw when properties are not provided', async () => {
        await expect(
          provider.delete('MyResource', 'abc123', resourceType)
        ).rejects.toThrow('RestApiId is required to delete');
      });

      it('should throw on API error', async () => {
        mockSend.mockRejectedValueOnce(new Error('service error'));

        await expect(
          provider.delete('MyResource', 'abc123', resourceType, {
            RestApiId: 'api-id',
          })
        ).rejects.toThrow('Failed to delete API Gateway Resource');
      });
    });

    describe('getAttribute', () => {
      it('should return physicalId for ResourceId attribute', async () => {
        const result = await provider.getAttribute(
          'abc123',
          resourceType,
          'ResourceId'
        );

        expect(result).toBe('abc123');
      });

      it('should return undefined for unknown attributes', async () => {
        const result = await provider.getAttribute(
          'abc123',
          resourceType,
          'UnknownAttr'
        );

        expect(result).toBeUndefined();
      });
    });
  });

  // ─── Unsupported resource type ────────────────────────────────────

  describe('unsupported resource type', () => {
    it('should throw on create for unsupported type', async () => {
      await expect(
        provider.create('MyThing', 'AWS::ApiGateway::Unknown', {})
      ).rejects.toThrow('Unsupported resource type');
    });

    it('should throw on update for unsupported type', async () => {
      await expect(
        provider.update('MyThing', 'id', 'AWS::ApiGateway::Unknown', {}, {})
      ).rejects.toThrow('Unsupported resource type');
    });

    it('should throw on delete for unsupported type', async () => {
      await expect(
        provider.delete('MyThing', 'id', 'AWS::ApiGateway::Unknown')
      ).rejects.toThrow('Unsupported resource type');
    });

    it('should return undefined for getAttribute on unsupported type', async () => {
      const result = await provider.getAttribute('id', 'AWS::ApiGateway::Unknown', 'Attr');
      expect(result).toBeUndefined();
    });
  });
});
