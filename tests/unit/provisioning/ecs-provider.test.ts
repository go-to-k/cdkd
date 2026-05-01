import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock AWS clients before importing the provider
const mockSend = vi.fn();

vi.mock('@aws-sdk/client-ecs', async () => {
  const actual = await vi.importActual('@aws-sdk/client-ecs');
  return {
    ...actual,
    ECSClient: vi.fn().mockImplementation(() => ({
      send: mockSend,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
  };
});

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

import { ECSProvider } from '../../../src/provisioning/providers/ecs-provider.js';

describe('ECSProvider', () => {
  let provider: ECSProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new ECSProvider();
  });

  // ─── AWS::ECS::Cluster ──────────────────────────────────────────

  describe('AWS::ECS::Cluster', () => {
    describe('create', () => {
      it('should create cluster and return ARN', async () => {
        mockSend.mockResolvedValueOnce({
          cluster: {
            clusterArn: 'arn:aws:ecs:us-east-1:123456789012:cluster/my-cluster',
            clusterName: 'my-cluster',
          },
        });

        const result = await provider.create('MyCluster', 'AWS::ECS::Cluster', {
          ClusterName: 'my-cluster',
        });

        expect(result.physicalId).toBe('my-cluster');
        expect(result.attributes).toEqual({
          Arn: 'arn:aws:ecs:us-east-1:123456789012:cluster/my-cluster',
        });
        expect(mockSend).toHaveBeenCalledTimes(1);

        const createCall = mockSend.mock.calls[0][0];
        expect(createCall.constructor.name).toBe('CreateClusterCommand');
        expect(createCall.input.clusterName).toBe('my-cluster');
      });

      it('should use logicalId as cluster name when ClusterName is not provided', async () => {
        mockSend.mockResolvedValueOnce({
          cluster: {
            clusterArn: 'arn:aws:ecs:us-east-1:123456789012:cluster/MyCluster',
            clusterName: 'MyCluster',
          },
        });

        const result = await provider.create('MyCluster', 'AWS::ECS::Cluster', {});

        expect(result.physicalId).toBe('MyCluster');

        const createCall = mockSend.mock.calls[0][0];
        expect(createCall.input.clusterName).toBe('MyCluster');
      });

      it('should throw ProvisioningError on failure', async () => {
        mockSend.mockRejectedValueOnce(new Error('Access Denied'));

        await expect(
          provider.create('MyCluster', 'AWS::ECS::Cluster', {
            ClusterName: 'my-cluster',
          })
        ).rejects.toThrow('Failed to create ECS cluster MyCluster');
      });
    });

    describe('delete', () => {
      it('should delete cluster', async () => {
        mockSend.mockResolvedValueOnce({});

        await provider.delete(
          'MyCluster',
          'my-cluster',
          'AWS::ECS::Cluster'
        );

        expect(mockSend).toHaveBeenCalledTimes(1);

        const deleteCall = mockSend.mock.calls[0][0];
        expect(deleteCall.constructor.name).toBe('DeleteClusterCommand');
        expect(deleteCall.input.cluster).toBe('my-cluster');
      });

      it('should handle ClusterNotFoundException', async () => {
        const error = new Error('Cluster not found');
        error.name = 'ClusterNotFoundException';
        mockSend.mockRejectedValueOnce(error);

        await provider.delete(
          'MyCluster',
          'my-cluster',
          'AWS::ECS::Cluster'
        );

        expect(mockSend).toHaveBeenCalledTimes(1);
      });
    });
  });

  // ─── AWS::ECS::TaskDefinition ───────────────────────────────────

  describe('AWS::ECS::TaskDefinition', () => {
    describe('create', () => {
      it('should register task definition and return ARN', async () => {
        mockSend.mockResolvedValueOnce({
          taskDefinition: {
            taskDefinitionArn:
              'arn:aws:ecs:us-east-1:123456789012:task-definition/my-task:1',
          },
        });

        const result = await provider.create('MyTask', 'AWS::ECS::TaskDefinition', {
          Family: 'my-task',
          ContainerDefinitions: [
            {
              Name: 'web',
              Image: 'nginx:latest',
              Essential: true,
              PortMappings: [{ ContainerPort: 80, Protocol: 'tcp' }],
            },
          ],
          Cpu: '256',
          Memory: '512',
          NetworkMode: 'awsvpc',
          RequiresCompatibilities: ['FARGATE'],
        });

        expect(result.physicalId).toBe(
          'arn:aws:ecs:us-east-1:123456789012:task-definition/my-task:1'
        );
        expect(result.attributes).toEqual({
          TaskDefinitionArn:
            'arn:aws:ecs:us-east-1:123456789012:task-definition/my-task:1',
        });
        expect(mockSend).toHaveBeenCalledTimes(1);

        const registerCall = mockSend.mock.calls[0][0];
        expect(registerCall.constructor.name).toBe('RegisterTaskDefinitionCommand');
        expect(registerCall.input.family).toBe('my-task');
        expect(registerCall.input.cpu).toBe('256');
        expect(registerCall.input.memory).toBe('512');
        expect(registerCall.input.networkMode).toBe('awsvpc');
        expect(registerCall.input.requiresCompatibilities).toEqual(['FARGATE']);
      });

      it('should throw ProvisioningError on failure', async () => {
        mockSend.mockRejectedValueOnce(new Error('Access Denied'));

        await expect(
          provider.create('MyTask', 'AWS::ECS::TaskDefinition', {
            Family: 'my-task',
            ContainerDefinitions: [{ Name: 'web', Image: 'nginx:latest' }],
          })
        ).rejects.toThrow('Failed to create ECS task definition MyTask');
      });
    });

    describe('update', () => {
      it('should register new revision and deregister old', async () => {
        // RegisterTaskDefinition (new revision)
        mockSend.mockResolvedValueOnce({
          taskDefinition: {
            taskDefinitionArn:
              'arn:aws:ecs:us-east-1:123456789012:task-definition/my-task:2',
          },
        });
        // DeregisterTaskDefinition (old revision)
        mockSend.mockResolvedValueOnce({});

        const result = await provider.update(
          'MyTask',
          'arn:aws:ecs:us-east-1:123456789012:task-definition/my-task:1',
          'AWS::ECS::TaskDefinition',
          {
            Family: 'my-task',
            ContainerDefinitions: [{ Name: 'web', Image: 'nginx:latest' }],
            Cpu: '512',
            Memory: '1024',
          },
          {
            Family: 'my-task',
            ContainerDefinitions: [{ Name: 'web', Image: 'nginx:latest' }],
            Cpu: '256',
            Memory: '512',
          }
        );

        expect(result.physicalId).toBe(
          'arn:aws:ecs:us-east-1:123456789012:task-definition/my-task:2'
        );
        expect(result.wasReplaced).toBe(false);
        expect(result.attributes).toEqual({
          TaskDefinitionArn:
            'arn:aws:ecs:us-east-1:123456789012:task-definition/my-task:2',
        });
        expect(mockSend).toHaveBeenCalledTimes(2);

        const registerCall = mockSend.mock.calls[0][0];
        expect(registerCall.constructor.name).toBe('RegisterTaskDefinitionCommand');

        const deregisterCall = mockSend.mock.calls[1][0];
        expect(deregisterCall.constructor.name).toBe('DeregisterTaskDefinitionCommand');
        expect(deregisterCall.input.taskDefinition).toBe(
          'arn:aws:ecs:us-east-1:123456789012:task-definition/my-task:1'
        );
      });
    });

    describe('delete', () => {
      it('should deregister task definition', async () => {
        mockSend.mockResolvedValueOnce({});

        await provider.delete(
          'MyTask',
          'arn:aws:ecs:us-east-1:123456789012:task-definition/my-task:1',
          'AWS::ECS::TaskDefinition'
        );

        expect(mockSend).toHaveBeenCalledTimes(1);

        const deregisterCall = mockSend.mock.calls[0][0];
        expect(deregisterCall.constructor.name).toBe('DeregisterTaskDefinitionCommand');
        expect(deregisterCall.input.taskDefinition).toBe(
          'arn:aws:ecs:us-east-1:123456789012:task-definition/my-task:1'
        );
      });

      it('should handle not-found error for idempotent delete', async () => {
        const error = new Error('Task definition not found');
        error.name = 'ClientException';
        mockSend.mockRejectedValueOnce(error);

        await provider.delete(
          'MyTask',
          'arn:aws:ecs:us-east-1:123456789012:task-definition/my-task:1',
          'AWS::ECS::TaskDefinition'
        );

        expect(mockSend).toHaveBeenCalledTimes(1);
      });
    });
  });

  // ─── AWS::ECS::Service ──────────────────────────────────────────

  describe('AWS::ECS::Service', () => {
    describe('create', () => {
      it('should create service and return ARN', async () => {
        mockSend.mockResolvedValueOnce({
          service: {
            serviceArn: 'arn:aws:ecs:us-east-1:123456789012:service/my-cluster/my-service',
            serviceName: 'my-service',
          },
        });

        const result = await provider.create('MyService', 'AWS::ECS::Service', {
          Cluster: 'my-cluster',
          ServiceName: 'my-service',
          TaskDefinition: 'arn:aws:ecs:us-east-1:123456789012:task-definition/my-task:1',
          DesiredCount: 2,
          LaunchType: 'FARGATE',
          NetworkConfiguration: {
            AwsvpcConfiguration: {
              Subnets: ['subnet-123', 'subnet-456'],
              SecurityGroups: ['sg-789'],
              AssignPublicIp: 'ENABLED',
            },
          },
        });

        expect(result.physicalId).toBe(
          'arn:aws:ecs:us-east-1:123456789012:service/my-cluster/my-service'
        );
        expect(result.attributes).toEqual({
          ServiceArn: 'arn:aws:ecs:us-east-1:123456789012:service/my-cluster/my-service',
          Name: 'my-service',
        });
        expect(mockSend).toHaveBeenCalledTimes(1);

        const createCall = mockSend.mock.calls[0][0];
        expect(createCall.constructor.name).toBe('CreateServiceCommand');
        expect(createCall.input.cluster).toBe('my-cluster');
        expect(createCall.input.serviceName).toBe('my-service');
        expect(createCall.input.desiredCount).toBe(2);
        expect(createCall.input.launchType).toBe('FARGATE');
      });

      it('should throw ProvisioningError on failure', async () => {
        mockSend.mockRejectedValueOnce(new Error('Access Denied'));

        await expect(
          provider.create('MyService', 'AWS::ECS::Service', {
            Cluster: 'my-cluster',
            ServiceName: 'my-service',
            TaskDefinition: 'arn:aws:ecs:us-east-1:123456789012:task-definition/my-task:1',
          })
        ).rejects.toThrow('Failed to create ECS service MyService');
      });
    });

    describe('update', () => {
      it('should update service with task definition and desired count', async () => {
        mockSend.mockResolvedValueOnce({
          service: {
            serviceArn: 'arn:aws:ecs:us-east-1:123456789012:service/my-cluster/my-service',
            serviceName: 'my-service',
          },
        });

        const result = await provider.update(
          'MyService',
          'arn:aws:ecs:us-east-1:123456789012:service/my-cluster/my-service',
          'AWS::ECS::Service',
          {
            Cluster: 'my-cluster',
            ServiceName: 'my-service',
            TaskDefinition: 'arn:aws:ecs:us-east-1:123456789012:task-definition/my-task:2',
            DesiredCount: 4,
          },
          {
            Cluster: 'my-cluster',
            ServiceName: 'my-service',
            TaskDefinition: 'arn:aws:ecs:us-east-1:123456789012:task-definition/my-task:1',
            DesiredCount: 2,
          }
        );

        expect(result.physicalId).toBe(
          'arn:aws:ecs:us-east-1:123456789012:service/my-cluster/my-service'
        );
        expect(result.wasReplaced).toBe(false);
        expect(mockSend).toHaveBeenCalledTimes(1);

        const updateCall = mockSend.mock.calls[0][0];
        expect(updateCall.constructor.name).toBe('UpdateServiceCommand');
        expect(updateCall.input.taskDefinition).toBe(
          'arn:aws:ecs:us-east-1:123456789012:task-definition/my-task:2'
        );
        expect(updateCall.input.desiredCount).toBe(4);
      });

      it('should throw on immutable ServiceName change', async () => {
        await expect(
          provider.update(
            'MyService',
            'arn:aws:ecs:us-east-1:123456789012:service/my-cluster/my-service',
            'AWS::ECS::Service',
            {
              Cluster: 'my-cluster',
              ServiceName: 'new-service-name',
            },
            {
              Cluster: 'my-cluster',
              ServiceName: 'my-service',
            }
          )
        ).rejects.toThrow('Cannot update ServiceName');
      });
    });

    describe('delete', () => {
      it('should scale down to 0 then delete with force', async () => {
        // UpdateService (scale down to 0)
        mockSend.mockResolvedValueOnce({});
        // DeleteService (force)
        mockSend.mockResolvedValueOnce({});

        await provider.delete(
          'MyService',
          'arn:aws:ecs:us-east-1:123456789012:service/my-cluster/my-service',
          'AWS::ECS::Service',
          { Cluster: 'my-cluster' }
        );

        expect(mockSend).toHaveBeenCalledTimes(2);

        const updateCall = mockSend.mock.calls[0][0];
        expect(updateCall.constructor.name).toBe('UpdateServiceCommand');
        expect(updateCall.input.desiredCount).toBe(0);
        expect(updateCall.input.cluster).toBe('my-cluster');

        const deleteCall = mockSend.mock.calls[1][0];
        expect(deleteCall.constructor.name).toBe('DeleteServiceCommand');
        expect(deleteCall.input.force).toBe(true);
        expect(deleteCall.input.cluster).toBe('my-cluster');
      });

      it('should handle ServiceNotFoundException during scale down', async () => {
        const error = new Error('Service not found');
        error.name = 'ServiceNotFoundException';
        mockSend.mockRejectedValueOnce(error);

        await provider.delete(
          'MyService',
          'arn:aws:ecs:us-east-1:123456789012:service/my-cluster/my-service',
          'AWS::ECS::Service',
          { Cluster: 'my-cluster' }
        );

        // Only scale down attempted, no delete call
        expect(mockSend).toHaveBeenCalledTimes(1);
      });
    });
  });

  // ─── Unsupported resource type ──────────────────────────────────

  describe('unsupported resource type', () => {
    it('should throw on create with unsupported resource type', async () => {
      await expect(
        provider.create('MyResource', 'AWS::ECS::Unknown', {})
      ).rejects.toThrow('Unsupported resource type: AWS::ECS::Unknown');
    });

    it('should throw on update with unsupported resource type', async () => {
      await expect(
        provider.update('MyResource', 'phys-id', 'AWS::ECS::Unknown', {}, {})
      ).rejects.toThrow('Unsupported resource type: AWS::ECS::Unknown');
    });
  });
});
