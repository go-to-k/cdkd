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
    mockSend.mockReset();
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
        await vi.advanceTimersByTimeAsync(10000);

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

        await vi.advanceTimersByTimeAsync(10000);

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

        // Advance past both retry delays (2 retries x 10000ms)
        await vi.advanceTimersByTimeAsync(20000);

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

        await vi.advanceTimersByTimeAsync(10000);

        const result = await promise;
        expect(result.physicalId).toBe('ApiGatewayAccount');
        expect(mockSend).toHaveBeenCalledTimes(2);
      });
    });

    describe('delete', () => {
      it('should clear CloudWatchRoleArn on delete', async () => {
        mockSend.mockResolvedValueOnce({});

        await provider.delete('MyAccount', 'ApiGatewayAccount', resourceType, {});

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
          provider.delete('MyAccount', 'ApiGatewayAccount', resourceType, {})
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

  // ─── AWS::ApiGateway::Deployment ─────────────────────────────────

  describe('AWS::ApiGateway::Deployment', () => {
    const resourceType = 'AWS::ApiGateway::Deployment';

    describe('create', () => {
      it('should create a deployment with restApiId', async () => {
        mockSend.mockResolvedValueOnce({ id: 'deploy-123' });

        const result = await provider.create('MyDeployment', resourceType, {
          RestApiId: 'api-id',
        });

        expect(result.physicalId).toBe('deploy-123');
        expect(result.attributes).toEqual({ DeploymentId: 'deploy-123' });
        expect(mockSend).toHaveBeenCalledTimes(1);

        const command = mockSend.mock.calls[0][0];
        expect(command.constructor.name).toBe('CreateDeploymentCommand');
        expect(command.input).toEqual({
          restApiId: 'api-id',
          description: undefined,
        });
      });

      it('should create a deployment with description', async () => {
        mockSend.mockResolvedValueOnce({ id: 'deploy-456' });

        const result = await provider.create('MyDeployment', resourceType, {
          RestApiId: 'api-id',
          Description: 'My deployment',
        });

        expect(result.physicalId).toBe('deploy-456');

        const command = mockSend.mock.calls[0][0];
        expect(command.input.description).toBe('My deployment');
      });

      it('should throw when RestApiId is missing', async () => {
        await expect(
          provider.create('MyDeployment', resourceType, {})
        ).rejects.toThrow('RestApiId is required for API Gateway Deployment');
      });

      it('should throw on API error', async () => {
        mockSend.mockRejectedValueOnce(new Error('API error'));

        await expect(
          provider.create('MyDeployment', resourceType, {
            RestApiId: 'api-id',
          })
        ).rejects.toThrow('Failed to create API Gateway Deployment');
      });
    });

    describe('update', () => {
      it('should return no-op (deployments are immutable)', async () => {
        const result = await provider.update(
          'MyDeployment',
          'deploy-123',
          resourceType,
          { RestApiId: 'api-id' },
          { RestApiId: 'api-id' }
        );

        expect(result.physicalId).toBe('deploy-123');
        expect(result.wasReplaced).toBe(false);
        expect(result.attributes).toEqual({ DeploymentId: 'deploy-123' });
        expect(mockSend).not.toHaveBeenCalled();
      });
    });

    describe('delete', () => {
      it('should delete a deployment', async () => {
        mockSend.mockResolvedValueOnce({});

        await provider.delete('MyDeployment', 'deploy-123', resourceType, {
          RestApiId: 'api-id',
        });

        expect(mockSend).toHaveBeenCalledTimes(1);

        const command = mockSend.mock.calls[0][0];
        expect(command.constructor.name).toBe('DeleteDeploymentCommand');
        expect(command.input).toEqual({
          restApiId: 'api-id',
          deploymentId: 'deploy-123',
        });
      });

      it('should skip deletion when deployment not found', async () => {
        mockSend.mockRejectedValueOnce(
          new NotFoundException({ $metadata: {}, message: 'not found' })
        );

        await provider.delete('MyDeployment', 'deploy-123', resourceType, {
          RestApiId: 'api-id',
        });

        expect(mockSend).toHaveBeenCalledTimes(1);
      });

      it('should throw when RestApiId is missing', async () => {
        await expect(
          provider.delete('MyDeployment', 'deploy-123', resourceType, {})
        ).rejects.toThrow('RestApiId is required to delete API Gateway Deployment');
      });

      it('should throw when properties are not provided', async () => {
        await expect(
          provider.delete('MyDeployment', 'deploy-123', resourceType)
        ).rejects.toThrow('RestApiId is required to delete API Gateway Deployment');
      });

      it('should throw on API error', async () => {
        mockSend.mockRejectedValueOnce(new Error('service error'));

        await expect(
          provider.delete('MyDeployment', 'deploy-123', resourceType, {
            RestApiId: 'api-id',
          })
        ).rejects.toThrow('Failed to delete API Gateway Deployment');
      });
    });

    describe('getAttribute', () => {
      it('should return physicalId for DeploymentId attribute', async () => {
        const result = await provider.getAttribute(
          'deploy-123',
          resourceType,
          'DeploymentId'
        );

        expect(result).toBe('deploy-123');
      });

      it('should return undefined for unknown attributes', async () => {
        const result = await provider.getAttribute(
          'deploy-123',
          resourceType,
          'UnknownAttr'
        );

        expect(result).toBeUndefined();
      });
    });
  });

  // ─── AWS::ApiGateway::Stage ────────────────────────────────────

  describe('AWS::ApiGateway::Stage', () => {
    const resourceType = 'AWS::ApiGateway::Stage';

    describe('create', () => {
      it('should create a stage with required properties', async () => {
        mockSend.mockResolvedValueOnce({});

        const result = await provider.create('MyStage', resourceType, {
          RestApiId: 'api-id',
          StageName: 'prod',
          DeploymentId: 'deploy-123',
        });

        expect(result.physicalId).toBe('prod');
        expect(result.attributes).toEqual({ StageName: 'prod' });
        expect(mockSend).toHaveBeenCalledTimes(1);

        const command = mockSend.mock.calls[0][0];
        expect(command.constructor.name).toBe('CreateStageCommand');
        expect(command.input).toEqual({
          restApiId: 'api-id',
          stageName: 'prod',
          deploymentId: 'deploy-123',
          description: undefined,
        });
      });

      it('should create a stage with description', async () => {
        mockSend.mockResolvedValueOnce({});

        const result = await provider.create('MyStage', resourceType, {
          RestApiId: 'api-id',
          StageName: 'prod',
          DeploymentId: 'deploy-123',
          Description: 'Production stage',
        });

        expect(result.physicalId).toBe('prod');

        const command = mockSend.mock.calls[0][0];
        expect(command.input.description).toBe('Production stage');
      });

      it('should throw when required properties are missing', async () => {
        await expect(
          provider.create('MyStage', resourceType, {
            RestApiId: 'api-id',
            StageName: 'prod',
          })
        ).rejects.toThrow('RestApiId, StageName, and DeploymentId are required');
      });

      it('should throw when RestApiId is missing', async () => {
        await expect(
          provider.create('MyStage', resourceType, {
            StageName: 'prod',
            DeploymentId: 'deploy-123',
          })
        ).rejects.toThrow('RestApiId, StageName, and DeploymentId are required');
      });

      it('should throw on API error', async () => {
        mockSend.mockRejectedValueOnce(new Error('API error'));

        await expect(
          provider.create('MyStage', resourceType, {
            RestApiId: 'api-id',
            StageName: 'prod',
            DeploymentId: 'deploy-123',
          })
        ).rejects.toThrow('Failed to create API Gateway Stage');
      });
    });

    describe('update', () => {
      it('should update stage when deploymentId changes', async () => {
        mockSend.mockResolvedValueOnce({});

        const result = await provider.update(
          'MyStage',
          'prod',
          resourceType,
          { RestApiId: 'api-id', StageName: 'prod', DeploymentId: 'deploy-456' },
          { RestApiId: 'api-id', StageName: 'prod', DeploymentId: 'deploy-123' }
        );

        expect(result.physicalId).toBe('prod');
        expect(result.wasReplaced).toBe(false);
        expect(result.attributes).toEqual({ StageName: 'prod' });
        expect(mockSend).toHaveBeenCalledTimes(1);

        const command = mockSend.mock.calls[0][0];
        expect(command.constructor.name).toBe('UpdateStageCommand');
        expect(command.input).toEqual({
          restApiId: 'api-id',
          stageName: 'prod',
          patchOperations: [
            { op: 'replace', path: '/deploymentId', value: 'deploy-456' },
          ],
        });
      });

      it('should update stage when description changes', async () => {
        mockSend.mockResolvedValueOnce({});

        const result = await provider.update(
          'MyStage',
          'prod',
          resourceType,
          { RestApiId: 'api-id', StageName: 'prod', DeploymentId: 'deploy-123', Description: 'New desc' },
          { RestApiId: 'api-id', StageName: 'prod', DeploymentId: 'deploy-123', Description: 'Old desc' }
        );

        expect(result.physicalId).toBe('prod');
        expect(result.wasReplaced).toBe(false);
        expect(mockSend).toHaveBeenCalledTimes(1);

        const command = mockSend.mock.calls[0][0];
        expect(command.input.patchOperations).toEqual([
          { op: 'replace', path: '/description', value: 'New desc' },
        ]);
      });

      it('should return no-op when nothing changed', async () => {
        const result = await provider.update(
          'MyStage',
          'prod',
          resourceType,
          { RestApiId: 'api-id', StageName: 'prod', DeploymentId: 'deploy-123' },
          { RestApiId: 'api-id', StageName: 'prod', DeploymentId: 'deploy-123' }
        );

        expect(result.physicalId).toBe('prod');
        expect(result.wasReplaced).toBe(false);
        expect(result.attributes).toEqual({ StageName: 'prod' });
        expect(mockSend).not.toHaveBeenCalled();
      });

      it('should throw when RestApiId is missing', async () => {
        await expect(
          provider.update(
            'MyStage',
            'prod',
            resourceType,
            { StageName: 'prod', DeploymentId: 'deploy-123' },
            { StageName: 'prod', DeploymentId: 'deploy-123' }
          )
        ).rejects.toThrow('RestApiId is required to update API Gateway Stage');
      });

      it('should throw on API error', async () => {
        mockSend.mockRejectedValueOnce(new Error('service error'));

        await expect(
          provider.update(
            'MyStage',
            'prod',
            resourceType,
            { RestApiId: 'api-id', StageName: 'prod', DeploymentId: 'deploy-456' },
            { RestApiId: 'api-id', StageName: 'prod', DeploymentId: 'deploy-123' }
          )
        ).rejects.toThrow('Failed to update API Gateway Stage');
      });
    });

    describe('delete', () => {
      it('should delete a stage', async () => {
        mockSend.mockResolvedValueOnce({});

        await provider.delete('MyStage', 'prod', resourceType, {
          RestApiId: 'api-id',
        });

        expect(mockSend).toHaveBeenCalledTimes(1);

        const command = mockSend.mock.calls[0][0];
        expect(command.constructor.name).toBe('DeleteStageCommand');
        expect(command.input).toEqual({
          restApiId: 'api-id',
          stageName: 'prod',
        });
      });

      it('should skip deletion when stage not found', async () => {
        mockSend.mockRejectedValueOnce(
          new NotFoundException({ $metadata: {}, message: 'not found' })
        );

        await provider.delete('MyStage', 'prod', resourceType, {
          RestApiId: 'api-id',
        });

        expect(mockSend).toHaveBeenCalledTimes(1);
      });

      it('should throw when RestApiId is missing', async () => {
        await expect(
          provider.delete('MyStage', 'prod', resourceType, {})
        ).rejects.toThrow('RestApiId is required to delete API Gateway Stage');
      });

      it('should throw when properties are not provided', async () => {
        await expect(
          provider.delete('MyStage', 'prod', resourceType)
        ).rejects.toThrow('RestApiId is required to delete API Gateway Stage');
      });

      it('should throw on API error', async () => {
        mockSend.mockRejectedValueOnce(new Error('service error'));

        await expect(
          provider.delete('MyStage', 'prod', resourceType, {
            RestApiId: 'api-id',
          })
        ).rejects.toThrow('Failed to delete API Gateway Stage');
      });
    });

    describe('getAttribute', () => {
      it('should return physicalId for StageName attribute', async () => {
        const result = await provider.getAttribute(
          'prod',
          resourceType,
          'StageName'
        );

        expect(result).toBe('prod');
      });

      it('should return undefined for unknown attributes', async () => {
        const result = await provider.getAttribute(
          'prod',
          resourceType,
          'UnknownAttr'
        );

        expect(result).toBeUndefined();
      });
    });
  });

  // ─── AWS::ApiGateway::Method ──────────────────────────────────────

  describe('AWS::ApiGateway::Method', () => {
    const resourceType = 'AWS::ApiGateway::Method';

    describe('create', () => {
      it('should create a method with required properties', async () => {
        mockSend.mockResolvedValueOnce({}); // PutMethodCommand

        const result = await provider.create('MyMethod', resourceType, {
          RestApiId: 'api-id',
          ResourceId: 'resource-id',
          HttpMethod: 'GET',
          AuthorizationType: 'NONE',
        });

        expect(result.physicalId).toBe('api-id|resource-id|GET');
        expect(result.attributes).toEqual({});
        expect(mockSend).toHaveBeenCalledTimes(1);

        const command = mockSend.mock.calls[0][0];
        expect(command.constructor.name).toBe('PutMethodCommand');
        expect(command.input).toEqual({
          restApiId: 'api-id',
          resourceId: 'resource-id',
          httpMethod: 'GET',
          authorizationType: 'NONE',
        });
      });

      it('should default authorizationType to NONE when not specified', async () => {
        mockSend.mockResolvedValueOnce({}); // PutMethodCommand

        const result = await provider.create('MyMethod', resourceType, {
          RestApiId: 'api-id',
          ResourceId: 'resource-id',
          HttpMethod: 'POST',
        });

        expect(result.physicalId).toBe('api-id|resource-id|POST');

        const command = mockSend.mock.calls[0][0];
        expect(command.input.authorizationType).toBe('NONE');
      });

      it('should create method with integration', async () => {
        mockSend.mockResolvedValueOnce({}); // PutMethodCommand
        mockSend.mockResolvedValueOnce({}); // PutIntegrationCommand

        const result = await provider.create('MyMethod', resourceType, {
          RestApiId: 'api-id',
          ResourceId: 'resource-id',
          HttpMethod: 'POST',
          AuthorizationType: 'NONE',
          Integration: {
            Type: 'AWS_PROXY',
            IntegrationHttpMethod: 'POST',
            Uri: 'arn:aws:apigateway:us-east-1:lambda:path/2015-03-31/functions/arn:aws:lambda:us-east-1:123456789012:function:MyFunc/invocations',
          },
        });

        expect(result.physicalId).toBe('api-id|resource-id|POST');
        expect(mockSend).toHaveBeenCalledTimes(2);

        const putMethodCmd = mockSend.mock.calls[0][0];
        expect(putMethodCmd.constructor.name).toBe('PutMethodCommand');

        const putIntegrationCmd = mockSend.mock.calls[1][0];
        expect(putIntegrationCmd.constructor.name).toBe('PutIntegrationCommand');
        expect(putIntegrationCmd.input).toEqual({
          restApiId: 'api-id',
          resourceId: 'resource-id',
          httpMethod: 'POST',
          type: 'AWS_PROXY',
          integrationHttpMethod: 'POST',
          uri: 'arn:aws:apigateway:us-east-1:lambda:path/2015-03-31/functions/arn:aws:lambda:us-east-1:123456789012:function:MyFunc/invocations',
        });
      });

      it('should throw when required properties are missing', async () => {
        await expect(
          provider.create('MyMethod', resourceType, {
            RestApiId: 'api-id',
            HttpMethod: 'GET',
          })
        ).rejects.toThrow('RestApiId, ResourceId, and HttpMethod are required');
      });

      it('should throw when RestApiId is missing', async () => {
        await expect(
          provider.create('MyMethod', resourceType, {
            ResourceId: 'resource-id',
            HttpMethod: 'GET',
          })
        ).rejects.toThrow('RestApiId, ResourceId, and HttpMethod are required');
      });

      it('should throw when HttpMethod is missing', async () => {
        await expect(
          provider.create('MyMethod', resourceType, {
            RestApiId: 'api-id',
            ResourceId: 'resource-id',
          })
        ).rejects.toThrow('RestApiId, ResourceId, and HttpMethod are required');
      });

      it('should throw on API error', async () => {
        mockSend.mockRejectedValueOnce(new Error('API error'));

        await expect(
          provider.create('MyMethod', resourceType, {
            RestApiId: 'api-id',
            ResourceId: 'resource-id',
            HttpMethod: 'GET',
            AuthorizationType: 'NONE',
          })
        ).rejects.toThrow('Failed to create API Gateway Method');
      });
    });

    describe('update', () => {
      it('should return no-op (methods are replaced via new deployment)', async () => {
        const result = await provider.update(
          'MyMethod',
          'api-id|resource-id|GET',
          resourceType,
          { RestApiId: 'api-id', ResourceId: 'resource-id', HttpMethod: 'GET' },
          { RestApiId: 'api-id', ResourceId: 'resource-id', HttpMethod: 'GET' }
        );

        expect(result.physicalId).toBe('api-id|resource-id|GET');
        expect(result.wasReplaced).toBe(false);
        expect(result.attributes).toEqual({});
        expect(mockSend).not.toHaveBeenCalled();
      });
    });

    describe('delete', () => {
      it('should delete a method by parsing physicalId', async () => {
        mockSend.mockResolvedValueOnce({});

        await provider.delete('MyMethod', 'api-id|resource-id|GET', resourceType);

        expect(mockSend).toHaveBeenCalledTimes(1);

        const command = mockSend.mock.calls[0][0];
        expect(command.constructor.name).toBe('DeleteMethodCommand');
        expect(command.input).toEqual({
          restApiId: 'api-id',
          resourceId: 'resource-id',
          httpMethod: 'GET',
        });
      });

      it('should skip deletion when method not found', async () => {
        mockSend.mockRejectedValueOnce(
          new NotFoundException({ $metadata: {}, message: 'not found' })
        );

        await provider.delete('MyMethod', 'api-id|resource-id|GET', resourceType);

        expect(mockSend).toHaveBeenCalledTimes(1);
      });

      it('should throw on invalid physicalId format', async () => {
        await expect(
          provider.delete('MyMethod', 'invalid-id', resourceType)
        ).rejects.toThrow('Invalid physicalId format for API Gateway Method');
      });

      it('should throw on API error', async () => {
        mockSend.mockRejectedValueOnce(new Error('service error'));

        await expect(
          provider.delete('MyMethod', 'api-id|resource-id|GET', resourceType)
        ).rejects.toThrow('Failed to delete API Gateway Method');
      });
    });

    describe('getAttribute', () => {
      it('should return RestApiId from physicalId', async () => {
        const result = await provider.getAttribute(
          'api-id|resource-id|GET',
          resourceType,
          'RestApiId'
        );

        expect(result).toBe('api-id');
      });

      it('should return ResourceId from physicalId', async () => {
        const result = await provider.getAttribute(
          'api-id|resource-id|GET',
          resourceType,
          'ResourceId'
        );

        expect(result).toBe('resource-id');
      });

      it('should return HttpMethod from physicalId', async () => {
        const result = await provider.getAttribute(
          'api-id|resource-id|GET',
          resourceType,
          'HttpMethod'
        );

        expect(result).toBe('GET');
      });

      it('should return undefined for unknown attributes', async () => {
        const result = await provider.getAttribute(
          'api-id|resource-id|GET',
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
