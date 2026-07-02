import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import { NotFoundException } from '@aws-sdk/client-api-gateway';

// Mock AWS clients before importing the provider
const mockSend = vi.fn();

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    apiGateway: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
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
import { ResourceUpdateNotSupportedError } from '../../../src/utils/error-handler.js';

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
      it('should reject with ResourceUpdateNotSupportedError (deployments are immutable)', async () => {
        await expect(
          provider.update(
            'MyDeployment',
            'deploy-123',
            resourceType,
            { RestApiId: 'api-id' },
            { RestApiId: 'api-id' }
          )
        ).rejects.toThrow(ResourceUpdateNotSupportedError);
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

      it('should create a stage with TracingEnabled and Variables (#609 backfill)', async () => {
        mockSend.mockResolvedValueOnce({});

        const result = await provider.create('MyStage', resourceType, {
          RestApiId: 'api-id',
          StageName: 'prod',
          DeploymentId: 'deploy-123',
          TracingEnabled: true,
          Variables: { appVersion: '1.0.0', featureFlag: 'enabled' },
        });

        expect(result.physicalId).toBe('prod');

        const command = mockSend.mock.calls[0][0];
        expect(command.constructor.name).toBe('CreateStageCommand');
        expect(command.input.tracingEnabled).toBe(true);
        expect(command.input.variables).toEqual({
          appVersion: '1.0.0',
          featureFlag: 'enabled',
        });
      });

      it('should omit TracingEnabled/Variables from CreateStage when absent', async () => {
        mockSend.mockResolvedValueOnce({});

        await provider.create('MyStage', resourceType, {
          RestApiId: 'api-id',
          StageName: 'prod',
          DeploymentId: 'deploy-123',
        });

        const command = mockSend.mock.calls[0][0];
        expect(command.input.tracingEnabled).toBeUndefined();
        expect(command.input.variables).toBeUndefined();
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

      it('should patch /tracingEnabled when TracingEnabled changes (#609 backfill)', async () => {
        mockSend.mockResolvedValueOnce({});

        await provider.update(
          'MyStage',
          'prod',
          resourceType,
          { RestApiId: 'api-id', StageName: 'prod', DeploymentId: 'deploy-123', TracingEnabled: true },
          { RestApiId: 'api-id', StageName: 'prod', DeploymentId: 'deploy-123', TracingEnabled: false }
        );

        const command = mockSend.mock.calls[0][0];
        expect(command.constructor.name).toBe('UpdateStageCommand');
        expect(command.input.patchOperations).toEqual([
          { op: 'replace', path: '/tracingEnabled', value: 'true' },
        ]);
      });

      it('applies MethodSettings on create via a post-CreateStage UpdateStage (issue #966)', async () => {
        mockSend.mockResolvedValueOnce({}); // CreateStage
        mockSend.mockResolvedValueOnce({}); // UpdateStage (method settings)

        const result = await provider.create('MyStage', resourceType, {
          RestApiId: 'api-id',
          StageName: 'prod',
          DeploymentId: 'deploy-123',
          MethodSettings: [
            {
              ResourcePath: '/*',
              HttpMethod: '*',
              ThrottlingRateLimit: 100,
              ThrottlingBurstLimit: 50,
              MetricsEnabled: true,
            },
          ],
        });

        expect(result.physicalId).toBe('prod');
        expect(mockSend).toHaveBeenCalledTimes(2);
        expect(mockSend.mock.calls[0][0].constructor.name).toBe('CreateStageCommand');
        const update = mockSend.mock.calls[1][0];
        expect(update.constructor.name).toBe('UpdateStageCommand');
        expect(update.input).toEqual({
          restApiId: 'api-id',
          stageName: 'prod',
          patchOperations: [
            { op: 'replace', path: '/*/*/throttling/rateLimit', value: '100' },
            { op: 'replace', path: '/*/*/throttling/burstLimit', value: '50' },
            { op: 'replace', path: '/*/*/metrics/enabled', value: 'true' },
          ],
        });
      });

      it('patches only the changed MethodSettings field on update (issue #966)', async () => {
        mockSend.mockResolvedValueOnce({});

        await provider.update(
          'MyStage',
          'prod',
          resourceType,
          {
            RestApiId: 'api-id',
            StageName: 'prod',
            DeploymentId: 'deploy-123',
            MethodSettings: [
              { ResourcePath: '/*', HttpMethod: '*', ThrottlingRateLimit: 50, ThrottlingBurstLimit: 25 },
            ],
          },
          {
            RestApiId: 'api-id',
            StageName: 'prod',
            DeploymentId: 'deploy-123',
            MethodSettings: [
              { ResourcePath: '/*', HttpMethod: '*', ThrottlingRateLimit: 100, ThrottlingBurstLimit: 25 },
            ],
          }
        );

        const command = mockSend.mock.calls[0][0];
        expect(command.constructor.name).toBe('UpdateStageCommand');
        expect(command.input.patchOperations).toEqual([
          { op: 'replace', path: '/*/*/throttling/rateLimit', value: '50' },
        ]);
      });

      it('removes the whole key for a dropped entry, and reset-and-rebuilds a kept entry that dropped a field (issue #966)', async () => {
        mockSend.mockResolvedValueOnce({});

        await provider.update(
          'MyStage',
          'prod',
          resourceType,
          {
            RestApiId: 'api-id',
            StageName: 'prod',
            DeploymentId: 'deploy-123',
            // The /~1pets GET entry keeps metrics but drops its rate limit;
            // the wildcard entry disappears entirely. API Gateway rejects
            // field-level removes, so the kept entry is cleared and rebuilt
            // (remove /{key} + replace of every remaining field) in the same
            // UpdateStage call — live-verified sequential application.
            MethodSettings: [
              { ResourcePath: '/~1pets', HttpMethod: 'GET', MetricsEnabled: true },
            ],
          },
          {
            RestApiId: 'api-id',
            StageName: 'prod',
            DeploymentId: 'deploy-123',
            MethodSettings: [
              { ResourcePath: '/*', HttpMethod: '*', ThrottlingRateLimit: 100 },
              {
                ResourcePath: '/~1pets',
                HttpMethod: 'GET',
                MetricsEnabled: true,
                ThrottlingRateLimit: 10,
              },
            ],
          }
        );

        const command = mockSend.mock.calls[0][0];
        expect(command.input.patchOperations).toEqual([
          { op: 'remove', path: '/*/*' },
          { op: 'remove', path: '/~1pets/GET' },
          { op: 'replace', path: '/~1pets/GET/metrics/enabled', value: 'true' },
        ]);
      });

      it('maps every CFn MethodSetting field to its UpdateStage patch path, incl. false/0 values and the root resource path (issue #966)', async () => {
        mockSend.mockResolvedValueOnce({}); // CreateStage
        mockSend.mockResolvedValueOnce({}); // UpdateStage

        await provider.create('MyStage', resourceType, {
          RestApiId: 'api-id',
          StageName: 'prod',
          DeploymentId: 'deploy-123',
          MethodSettings: [
            {
              // The ROOT path is the bare '/', which API Gateway keys as
              // `~1/GET` (live-verified) — plain slash-stripping would build
              // the malformed `//GET/...` patch path.
              ResourcePath: '/',
              HttpMethod: 'GET',
              ThrottlingRateLimit: 0,
              ThrottlingBurstLimit: 5,
              MetricsEnabled: false,
              LoggingLevel: 'ERROR',
              DataTraceEnabled: true,
              CachingEnabled: true,
              CacheTtlInSeconds: 60,
              CacheDataEncrypted: false,
              RequireAuthorizationForCacheControl: true,
              UnauthorizedCacheControlHeaderStrategy: 'FAIL_WITH_403',
            },
          ],
        });

        const update = mockSend.mock.calls[1][0];
        expect(update.input.patchOperations).toEqual([
          { op: 'replace', path: '/~1/GET/throttling/rateLimit', value: '0' },
          { op: 'replace', path: '/~1/GET/throttling/burstLimit', value: '5' },
          { op: 'replace', path: '/~1/GET/metrics/enabled', value: 'false' },
          { op: 'replace', path: '/~1/GET/logging/loglevel', value: 'ERROR' },
          { op: 'replace', path: '/~1/GET/logging/dataTrace', value: 'true' },
          { op: 'replace', path: '/~1/GET/caching/enabled', value: 'true' },
          { op: 'replace', path: '/~1/GET/caching/ttlInSeconds', value: '60' },
          { op: 'replace', path: '/~1/GET/caching/dataEncrypted', value: 'false' },
          {
            op: 'replace',
            path: '/~1/GET/caching/requireAuthorizationForCacheControl',
            value: 'true',
          },
          {
            op: 'replace',
            path: '/~1/GET/caching/unauthorizedCacheControlHeaderStrategy',
            value: 'FAIL_WITH_403',
          },
        ]);
      });

      it('rides MethodSettings ops on the same UpdateStage call as other stage changes (issue #966)', async () => {
        mockSend.mockResolvedValueOnce({});

        await provider.update(
          'MyStage',
          'prod',
          resourceType,
          {
            RestApiId: 'api-id',
            StageName: 'prod',
            DeploymentId: 'deploy-123',
            Variables: { appVersion: '2.0.0' },
            MethodSettings: [
              { ResourcePath: '/*', HttpMethod: '*', ThrottlingRateLimit: 50 },
            ],
          },
          {
            RestApiId: 'api-id',
            StageName: 'prod',
            DeploymentId: 'deploy-123',
            Variables: { appVersion: '1.0.0' },
            MethodSettings: [
              { ResourcePath: '/*', HttpMethod: '*', ThrottlingRateLimit: 100 },
            ],
          }
        );

        expect(mockSend).toHaveBeenCalledTimes(1);
        const command = mockSend.mock.calls[0][0];
        expect(command.input.patchOperations).toEqual([
          { op: 'replace', path: '/variables/appVersion', value: '2.0.0' },
          { op: 'replace', path: '/*/*/throttling/rateLimit', value: '50' },
        ]);
      });

      it('best-effort deletes the stage and rethrows when the post-create MethodSettings patch fails (issue #966)', async () => {
        mockSend.mockResolvedValueOnce({}); // CreateStage succeeds
        mockSend.mockRejectedValueOnce(new Error('BadRequestException: bad patch')); // UpdateStage fails
        mockSend.mockResolvedValueOnce({}); // DeleteStage cleanup

        await expect(
          provider.create('MyStage', resourceType, {
            RestApiId: 'api-id',
            StageName: 'prod',
            DeploymentId: 'deploy-123',
            MethodSettings: [{ ResourcePath: '/*', HttpMethod: '*', ThrottlingRateLimit: 100 }],
          })
        ).rejects.toThrow('Failed to create API Gateway Stage');

        // Without the cleanup the created stage holds the name and every
        // retry dies with ConflictException (corpse-blocks-retry class).
        expect(mockSend).toHaveBeenCalledTimes(3);
        const cleanup = mockSend.mock.calls[2][0];
        expect(cleanup.constructor.name).toBe('DeleteStageCommand');
        expect(cleanup.input).toEqual({ restApiId: 'api-id', stageName: 'prod' });
      });

      it('emits no UpdateStage call when MethodSettings are unchanged (issue #966)', async () => {
        const settings = [
          { ResourcePath: '/*', HttpMethod: '*', ThrottlingRateLimit: 100 },
        ];
        const result = await provider.update(
          'MyStage',
          'prod',
          resourceType,
          {
            RestApiId: 'api-id',
            StageName: 'prod',
            DeploymentId: 'deploy-123',
            MethodSettings: settings,
          },
          {
            RestApiId: 'api-id',
            StageName: 'prod',
            DeploymentId: 'deploy-123',
            MethodSettings: [...settings.map((s) => ({ ...s }))],
          }
        );

        expect(result.physicalId).toBe('prod');
        expect(mockSend).not.toHaveBeenCalled();
      });

      it('should add/replace and remove /variables keys when Variables changes (#609 backfill)', async () => {
        mockSend.mockResolvedValueOnce({});

        await provider.update(
          'MyStage',
          'prod',
          resourceType,
          {
            RestApiId: 'api-id',
            StageName: 'prod',
            DeploymentId: 'deploy-123',
            // appVersion changed, newFlag added, staleFlag dropped.
            Variables: { appVersion: '2.0.0', newFlag: 'on' },
          },
          {
            RestApiId: 'api-id',
            StageName: 'prod',
            DeploymentId: 'deploy-123',
            Variables: { appVersion: '1.0.0', staleFlag: 'off' },
          }
        );

        const command = mockSend.mock.calls[0][0];
        expect(command.input.patchOperations).toEqual([
          { op: 'replace', path: '/variables/appVersion', value: '2.0.0' },
          { op: 'replace', path: '/variables/newFlag', value: 'on' },
          { op: 'remove', path: '/variables/staleFlag' },
        ]);
      });

      it('should not emit a /variables patch op for an unchanged key (#609 backfill)', async () => {
        const result = await provider.update(
          'MyStage',
          'prod',
          resourceType,
          {
            RestApiId: 'api-id',
            StageName: 'prod',
            DeploymentId: 'deploy-123',
            TracingEnabled: true,
            Variables: { appVersion: '1.0.0' },
          },
          {
            RestApiId: 'api-id',
            StageName: 'prod',
            DeploymentId: 'deploy-123',
            TracingEnabled: true,
            Variables: { appVersion: '1.0.0' },
          }
        );

        expect(result.physicalId).toBe('prod');
        expect(mockSend).not.toHaveBeenCalled();
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

      it('should forward all PutMethod-supported fields (apiKeyRequired / operationName / requestParameters / requestModels / requestValidatorId / authorizationScopes)', async () => {
        mockSend.mockResolvedValueOnce({}); // PutMethodCommand

        await provider.create('MyMethod', resourceType, {
          RestApiId: 'api-id',
          ResourceId: 'resource-id',
          HttpMethod: 'POST',
          AuthorizationType: 'COGNITO_USER_POOLS',
          AuthorizerId: 'auth-1',
          ApiKeyRequired: true,
          OperationName: 'CreatePet',
          RequestParameters: { 'method.request.querystring.name': true },
          RequestModels: { 'application/json': 'PetModel' },
          RequestValidatorId: 'validator-1',
          AuthorizationScopes: ['pets:write'],
        });

        const command = mockSend.mock.calls[0][0];
        expect(command.constructor.name).toBe('PutMethodCommand');
        expect(command.input).toEqual({
          restApiId: 'api-id',
          resourceId: 'resource-id',
          httpMethod: 'POST',
          authorizationType: 'COGNITO_USER_POOLS',
          authorizerId: 'auth-1',
          apiKeyRequired: true,
          operationName: 'CreatePet',
          requestParameters: { 'method.request.querystring.name': true },
          requestModels: { 'application/json': 'PetModel' },
          requestValidatorId: 'validator-1',
          authorizationScopes: ['pets:write'],
        });
      });

      it('should forward Integration.ResponseTransferMode to PutIntegrationCommand (closes the AWS_PROXY streaming bug)', async () => {
        // CDK's LambdaIntegration({ responseTransferMode: STREAM }) emits
        // a streaming URI + ResponseTransferMode=STREAM. Pre-fix cdkd
        // dropped ResponseTransferMode and AWS rejected with:
        //   "Invalid ResponseTransferMode. Cannot use ResponseTransferMode
        //    BUFFERED for Lambda functions invoked by
        //    InvokeWithResponseStream for AWS_PROXY integrations."
        mockSend.mockResolvedValueOnce({}); // PutMethodCommand
        mockSend.mockResolvedValueOnce({}); // PutIntegrationCommand

        await provider.create('MyMethod', resourceType, {
          RestApiId: 'api-id',
          ResourceId: 'resource-id',
          HttpMethod: 'POST',
          AuthorizationType: 'NONE',
          Integration: {
            Type: 'AWS_PROXY',
            IntegrationHttpMethod: 'POST',
            Uri: 'arn:aws:apigateway:us-east-1:lambda:path/2015-03-31/functions/arn:aws:lambda:us-east-1:123456789012:function:ChatFn/response-streaming-invocations',
            ResponseTransferMode: 'STREAM',
          },
        });

        const putIntegrationCmd = mockSend.mock.calls[1][0];
        expect(putIntegrationCmd.constructor.name).toBe('PutIntegrationCommand');
        expect(putIntegrationCmd.input.responseTransferMode).toBe('STREAM');
      });

      it('should forward every Integration field supported by PutIntegrationRequest', async () => {
        mockSend.mockResolvedValueOnce({}); // PutMethodCommand
        mockSend.mockResolvedValueOnce({}); // PutIntegrationCommand

        await provider.create('MyMethod', resourceType, {
          RestApiId: 'api-id',
          ResourceId: 'resource-id',
          HttpMethod: 'POST',
          AuthorizationType: 'NONE',
          Integration: {
            Type: 'HTTP_PROXY',
            IntegrationHttpMethod: 'POST',
            Uri: 'https://example.com/api',
            ConnectionType: 'VPC_LINK',
            ConnectionId: 'vpclink-1',
            Credentials: 'arn:aws:iam::123456789012:role/ApiGwExec',
            RequestParameters: {
              'integration.request.header.X-Foo': "'bar'",
            },
            RequestTemplates: {
              'application/json': '{"foo":"bar"}',
            },
            PassthroughBehavior: 'WHEN_NO_MATCH',
            ContentHandling: 'CONVERT_TO_BINARY',
            TimeoutInMillis: 5000,
            CacheNamespace: 'foo',
            CacheKeyParameters: ['method.request.querystring.foo'],
            TlsConfig: { InsecureSkipVerification: true },
            ResponseTransferMode: 'BUFFERED',
          },
        });

        const putIntegrationCmd = mockSend.mock.calls[1][0];
        expect(putIntegrationCmd.constructor.name).toBe('PutIntegrationCommand');
        expect(putIntegrationCmd.input).toEqual({
          restApiId: 'api-id',
          resourceId: 'resource-id',
          httpMethod: 'POST',
          type: 'HTTP_PROXY',
          integrationHttpMethod: 'POST',
          uri: 'https://example.com/api',
          connectionType: 'VPC_LINK',
          connectionId: 'vpclink-1',
          credentials: 'arn:aws:iam::123456789012:role/ApiGwExec',
          requestParameters: {
            'integration.request.header.X-Foo': "'bar'",
          },
          requestTemplates: {
            'application/json': '{"foo":"bar"}',
          },
          passthroughBehavior: 'WHEN_NO_MATCH',
          contentHandling: 'CONVERT_TO_BINARY',
          timeoutInMillis: 5000,
          cacheNamespace: 'foo',
          cacheKeyParameters: ['method.request.querystring.foo'],
          tlsConfig: { insecureSkipVerification: true },
          responseTransferMode: 'BUFFERED',
        });
      });

      it('should convert TlsConfig.InsecureSkipVerification PascalCase (CFn) to camelCase (SDK)', async () => {
        // CFn emits PascalCase; AWS SDK input shape is camelCase. Passing
        // the CFn object verbatim would silently drop the field at the SDK
        // serializer boundary — same class of "silent property drop" bug as
        // the parent ResponseTransferMode regression this provider fix
        // resolves. Belt-and-suspenders test against future regression.
        mockSend.mockResolvedValueOnce({});
        mockSend.mockResolvedValueOnce({});

        await provider.create('MyMethod', resourceType, {
          RestApiId: 'api-id',
          ResourceId: 'resource-id',
          HttpMethod: 'POST',
          AuthorizationType: 'NONE',
          Integration: {
            Type: 'HTTP',
            IntegrationHttpMethod: 'POST',
            Uri: 'https://example.com/api',
            TlsConfig: { InsecureSkipVerification: true },
          },
        });

        const putIntegrationCmd = mockSend.mock.calls[1][0];
        expect(putIntegrationCmd.input.tlsConfig).toEqual({
          insecureSkipVerification: true,
        });
      });

      it('should issue PutIntegrationResponseCommand per Integration.IntegrationResponses entry', async () => {
        mockSend.mockResolvedValueOnce({}); // PutMethodCommand
        mockSend.mockResolvedValueOnce({}); // PutIntegrationCommand
        mockSend.mockResolvedValueOnce({}); // PutIntegrationResponseCommand #1
        mockSend.mockResolvedValueOnce({}); // PutIntegrationResponseCommand #2

        await provider.create('MyMethod', resourceType, {
          RestApiId: 'api-id',
          ResourceId: 'resource-id',
          HttpMethod: 'POST',
          AuthorizationType: 'NONE',
          Integration: {
            Type: 'AWS',
            IntegrationHttpMethod: 'POST',
            Uri: 'arn:aws:apigateway:us-east-1:lambda:path/2015-03-31/functions/arn:aws:lambda:us-east-1:123456789012:function:Fn/invocations',
            IntegrationResponses: [
              {
                StatusCode: '200',
                SelectionPattern: '',
                ResponseParameters: {
                  'method.response.header.X-Foo': "'bar'",
                },
                ResponseTemplates: {
                  'application/json': '$input.body',
                },
              },
              {
                StatusCode: '400',
                SelectionPattern: '4\\d{2}',
                ContentHandling: 'CONVERT_TO_TEXT',
              },
            ],
          },
        });

        expect(mockSend).toHaveBeenCalledTimes(4);

        const irCmd1 = mockSend.mock.calls[2][0];
        expect(irCmd1.constructor.name).toBe('PutIntegrationResponseCommand');
        expect(irCmd1.input).toEqual({
          restApiId: 'api-id',
          resourceId: 'resource-id',
          httpMethod: 'POST',
          statusCode: '200',
          selectionPattern: '',
          responseParameters: {
            'method.response.header.X-Foo': "'bar'",
          },
          responseTemplates: {
            'application/json': '$input.body',
          },
          contentHandling: undefined,
        });

        const irCmd2 = mockSend.mock.calls[3][0];
        expect(irCmd2.constructor.name).toBe('PutIntegrationResponseCommand');
        expect(irCmd2.input).toEqual({
          restApiId: 'api-id',
          resourceId: 'resource-id',
          httpMethod: 'POST',
          statusCode: '400',
          selectionPattern: '4\\d{2}',
          responseParameters: undefined,
          responseTemplates: undefined,
          contentHandling: 'CONVERT_TO_TEXT',
        });
      });

      it('should issue PutMethodResponseCommand BEFORE PutIntegrationResponseCommand (CORS preflight OPTIONS regression)', async () => {
        // Regression test for CORS preflight OPTIONS deploy failure:
        //   "Invalid mapping expression specified: ... [No method response
        //    exists for method.]"
        // AWS rejects PutIntegrationResponse when the matching MethodResponse
        // does not yet exist. CDK's `RestApi({ defaultCorsPreflightOptions })`
        // emits both arrays on each generated OPTIONS method.
        mockSend.mockResolvedValueOnce({}); // PutMethodCommand
        mockSend.mockResolvedValueOnce({}); // PutIntegrationCommand
        mockSend.mockResolvedValueOnce({}); // PutMethodResponseCommand
        mockSend.mockResolvedValueOnce({}); // PutIntegrationResponseCommand

        await provider.create('CorsOptionsMethod', resourceType, {
          RestApiId: 'api-id',
          ResourceId: 'resource-id',
          HttpMethod: 'OPTIONS',
          AuthorizationType: 'NONE',
          Integration: {
            Type: 'MOCK',
            RequestTemplates: { 'application/json': '{"statusCode": 204}' },
            IntegrationResponses: [
              {
                StatusCode: '204',
                ResponseParameters: {
                  'method.response.header.Access-Control-Allow-Origin': "'*'",
                  'method.response.header.Access-Control-Allow-Methods': "'GET,POST,OPTIONS'",
                },
              },
            ],
          },
          MethodResponses: [
            {
              StatusCode: '204',
              ResponseParameters: {
                'method.response.header.Access-Control-Allow-Origin': true,
                'method.response.header.Access-Control-Allow-Methods': true,
              },
            },
          ],
        });

        expect(mockSend).toHaveBeenCalledTimes(4);
        const names = mockSend.mock.calls.map((c) => c[0].constructor.name);
        expect(names).toEqual([
          'PutMethodCommand',
          'PutIntegrationCommand',
          'PutMethodResponseCommand',
          'PutIntegrationResponseCommand',
        ]);
      });

      it('should issue PutMethodResponseCommand even when Integration is absent', async () => {
        mockSend.mockResolvedValueOnce({}); // PutMethodCommand
        mockSend.mockResolvedValueOnce({}); // PutMethodResponseCommand

        await provider.create('MyMethod', resourceType, {
          RestApiId: 'api-id',
          ResourceId: 'resource-id',
          HttpMethod: 'GET',
          AuthorizationType: 'NONE',
          MethodResponses: [{ StatusCode: '200' }],
        });

        expect(mockSend).toHaveBeenCalledTimes(2);
        const names = mockSend.mock.calls.map((c) => c[0].constructor.name);
        expect(names).toEqual(['PutMethodCommand', 'PutMethodResponseCommand']);
      });

      it('should NOT issue PutIntegrationResponseCommand when Integration.IntegrationResponses is absent', async () => {
        mockSend.mockResolvedValueOnce({}); // PutMethodCommand
        mockSend.mockResolvedValueOnce({}); // PutIntegrationCommand

        await provider.create('MyMethod', resourceType, {
          RestApiId: 'api-id',
          ResourceId: 'resource-id',
          HttpMethod: 'POST',
          AuthorizationType: 'NONE',
          Integration: {
            Type: 'AWS_PROXY',
            IntegrationHttpMethod: 'POST',
            Uri: 'arn:aws:apigateway:us-east-1:lambda:path/2015-03-31/functions/arn:aws:lambda:us-east-1:123456789012:function:Fn/invocations',
          },
        });

        // Only PutMethod + PutIntegration. No PutIntegrationResponse.
        expect(mockSend).toHaveBeenCalledTimes(2);
        const names = mockSend.mock.calls.map((c) => c[0].constructor.name);
        expect(names).not.toContain('PutIntegrationResponseCommand');
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

      it('should DeleteMethodCommand when PutIntegrationCommand fails after PutMethodCommand succeeded', async () => {
        // Partial-failure cleanup: PutMethod succeeds (AWS commits the
        // Method) but PutIntegration fails. Without cleanup, the next
        // redeploy hits "Method already exists for this resource".
        mockSend.mockResolvedValueOnce({}); // PutMethodCommand
        mockSend.mockRejectedValueOnce(new Error('PutIntegration boom')); // PutIntegrationCommand
        mockSend.mockResolvedValueOnce({}); // DeleteMethodCommand cleanup

        await expect(
          provider.create('MyMethod', resourceType, {
            RestApiId: 'api-id',
            ResourceId: 'resource-id',
            HttpMethod: 'POST',
            AuthorizationType: 'NONE',
            Integration: {
              Type: 'AWS_PROXY',
              IntegrationHttpMethod: 'POST',
              Uri: 'arn:aws:apigateway:us-east-1:lambda:path/2015-03-31/functions/arn:aws:lambda:us-east-1:123456789012:function:Fn/invocations',
            },
          })
        ).rejects.toThrow('Failed to create API Gateway Method');

        expect(mockSend).toHaveBeenCalledTimes(3);
        const names = mockSend.mock.calls.map((c) => c[0].constructor.name);
        expect(names).toEqual(['PutMethodCommand', 'PutIntegrationCommand', 'DeleteMethodCommand']);

        const deleteCmd = mockSend.mock.calls[2][0];
        expect(deleteCmd.input).toEqual({
          restApiId: 'api-id',
          resourceId: 'resource-id',
          httpMethod: 'POST',
        });
      });

      it('should DeleteMethodCommand when PutMethodResponseCommand fails (CORS preflight regression class)', async () => {
        // CORS preflight: PutMethod + PutIntegration succeed, then a
        // PutMethodResponse fails (e.g. on a misconfigured CFn shape).
        // Cleanup must fire so the next redeploy can re-CREATE.
        mockSend.mockResolvedValueOnce({}); // PutMethodCommand
        mockSend.mockResolvedValueOnce({}); // PutIntegrationCommand
        mockSend.mockRejectedValueOnce(new Error('PutMethodResponse boom'));
        mockSend.mockResolvedValueOnce({}); // DeleteMethodCommand cleanup

        await expect(
          provider.create('CorsOptionsMethod', resourceType, {
            RestApiId: 'api-id',
            ResourceId: 'resource-id',
            HttpMethod: 'OPTIONS',
            AuthorizationType: 'NONE',
            Integration: {
              Type: 'MOCK',
              IntegrationResponses: [{ StatusCode: '204' }],
            },
            MethodResponses: [{ StatusCode: '204' }],
          })
        ).rejects.toThrow('Failed to create API Gateway Method');

        const names = mockSend.mock.calls.map((c) => c[0].constructor.name);
        expect(names).toEqual([
          'PutMethodCommand',
          'PutIntegrationCommand',
          'PutMethodResponseCommand',
          'DeleteMethodCommand',
        ]);
      });

      it('should DeleteMethodCommand when PutIntegrationResponseCommand fails (post-fix #373 belt and braces)', async () => {
        // After PR #373's ordering fix, PutIntegrationResponse can still
        // fail on unrelated AWS-side issues (validation, throttling, etc.)
        // — the cleanup must still fire so we never leave an orphan.
        mockSend.mockResolvedValueOnce({}); // PutMethodCommand
        mockSend.mockResolvedValueOnce({}); // PutIntegrationCommand
        mockSend.mockResolvedValueOnce({}); // PutMethodResponseCommand
        mockSend.mockRejectedValueOnce(new Error('PutIntegrationResponse boom'));
        mockSend.mockResolvedValueOnce({}); // DeleteMethodCommand cleanup

        await expect(
          provider.create('CorsOptionsMethod', resourceType, {
            RestApiId: 'api-id',
            ResourceId: 'resource-id',
            HttpMethod: 'OPTIONS',
            AuthorizationType: 'NONE',
            Integration: {
              Type: 'MOCK',
              IntegrationResponses: [{ StatusCode: '204' }],
            },
            MethodResponses: [{ StatusCode: '204' }],
          })
        ).rejects.toThrow('Failed to create API Gateway Method');

        const names = mockSend.mock.calls.map((c) => c[0].constructor.name);
        expect(names).toEqual([
          'PutMethodCommand',
          'PutIntegrationCommand',
          'PutMethodResponseCommand',
          'PutIntegrationResponseCommand',
          'DeleteMethodCommand',
        ]);
      });

      it('should NOT issue DeleteMethodCommand when PutMethodCommand itself fails', async () => {
        // PutMethod failure means AWS never committed the resource, so
        // there's nothing to clean up. Cleanup firing here would issue
        // an unnecessary DeleteMethod that AWS would reject with
        // NotFoundException — noise on the wire and in the logs.
        mockSend.mockRejectedValueOnce(new Error('PutMethod boom'));

        await expect(
          provider.create('MyMethod', resourceType, {
            RestApiId: 'api-id',
            ResourceId: 'resource-id',
            HttpMethod: 'GET',
            AuthorizationType: 'NONE',
          })
        ).rejects.toThrow('Failed to create API Gateway Method');

        expect(mockSend).toHaveBeenCalledTimes(1);
        expect(mockSend.mock.calls[0][0].constructor.name).toBe('PutMethodCommand');
      });

      it('should re-throw the original error even when the cleanup DeleteMethodCommand itself fails', async () => {
        // Cleanup is best-effort: a DeleteMethod failure must not mask
        // the original create failure. The user needs to see what
        // actually broke, plus a warn-level log pointing them at the
        // manual `aws apigateway delete-method` command.
        const originalErr = new Error('PutIntegration boom (original)');
        mockSend.mockResolvedValueOnce({}); // PutMethodCommand
        mockSend.mockRejectedValueOnce(originalErr); // PutIntegrationCommand
        mockSend.mockRejectedValueOnce(new Error('DeleteMethod also failed')); // DeleteMethodCommand cleanup

        await expect(
          provider.create('MyMethod', resourceType, {
            RestApiId: 'api-id',
            ResourceId: 'resource-id',
            HttpMethod: 'POST',
            AuthorizationType: 'NONE',
            Integration: { Type: 'AWS_PROXY' },
          })
        ).rejects.toThrow('PutIntegration boom (original)');

        const names = mockSend.mock.calls.map((c) => c[0].constructor.name);
        expect(names).toEqual(['PutMethodCommand', 'PutIntegrationCommand', 'DeleteMethodCommand']);
      });
    });

    describe('update', () => {
      it('should be a no-op when state matches AWS (no patch ops emitted)', async () => {
        // Method.update is now plumbed (UpdateMethodCommand patch ops).
        // With no diff between new and previous properties, no SDK call
        // should fire — the round-trip "drift --revert with no real
        // change" case.
        await provider.update(
          'MyMethod',
          'api-id|resource-id|GET',
          resourceType,
          { RestApiId: 'api-id', ResourceId: 'resource-id', HttpMethod: 'GET' },
          { RestApiId: 'api-id', ResourceId: 'resource-id', HttpMethod: 'GET' }
        );
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
