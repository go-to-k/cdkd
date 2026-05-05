import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  DescribeClustersCommand,
  DescribeServicesCommand,
  DescribeTaskDefinitionCommand,
} from '@aws-sdk/client-ecs';

const mockSend = vi.fn();

vi.mock('@aws-sdk/client-ecs', async (importOriginal) => {
  const orig = (await importOriginal()) as Record<string, unknown>;
  return {
    ...orig,
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

describe('ECSProvider.readCurrentState', () => {
  let provider: ECSProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new ECSProvider();
  });

  it('returns CFn-shaped Cluster fields from DescribeClusters', async () => {
    mockSend.mockResolvedValueOnce({
      clusters: [
        {
          clusterName: 'my-cluster',
          capacityProviders: ['FARGATE'],
          settings: [{ name: 'containerInsights', value: 'enabled' }],
        },
      ],
    });

    const result = await provider.readCurrentState(
      'my-cluster',
      'ClusterLogical',
      'AWS::ECS::Cluster'
    );

    expect(mockSend.mock.calls[0]?.[0]).toBeInstanceOf(DescribeClustersCommand);
    expect(result).toEqual({
      ClusterName: 'my-cluster',
      CapacityProviders: ['FARGATE'],
      ClusterSettings: [{ Name: 'containerInsights', Value: 'enabled' }],
    });
  });

  it('returns CFn-shaped Service fields from DescribeServices', async () => {
    mockSend.mockResolvedValueOnce({
      services: [
        {
          serviceName: 'my-svc',
          clusterArn: 'arn:aws:ecs:us-east-1:123:cluster/my-cluster',
          taskDefinition: 'arn:aws:ecs:us-east-1:123:task-definition/td:1',
          desiredCount: 2,
          launchType: 'FARGATE',
          enableExecuteCommand: true,
        },
      ],
    });

    const result = await provider.readCurrentState(
      'arn:aws:ecs:us-east-1:123:cluster/my-cluster|my-svc',
      'SvcLogical',
      'AWS::ECS::Service'
    );

    expect(mockSend.mock.calls[0]?.[0]).toBeInstanceOf(DescribeServicesCommand);
    expect(result).toEqual({
      ServiceName: 'my-svc',
      Cluster: 'arn:aws:ecs:us-east-1:123:cluster/my-cluster',
      TaskDefinition: 'arn:aws:ecs:us-east-1:123:task-definition/td:1',
      DesiredCount: 2,
      LaunchType: 'FARGATE',
      EnableExecuteCommand: true,
    });
  });

  it('returns CFn-shaped TaskDefinition fields from DescribeTaskDefinition', async () => {
    mockSend.mockResolvedValueOnce({
      taskDefinition: {
        family: 'my-td',
        cpu: '256',
        memory: '512',
        networkMode: 'awsvpc',
        requiresCompatibilities: ['FARGATE'],
        executionRoleArn: 'arn:aws:iam::123:role/exec',
        ephemeralStorage: { sizeInGiB: 21 },
      },
    });

    const result = await provider.readCurrentState(
      'arn:aws:ecs:us-east-1:123:task-definition/my-td:1',
      'TDLogical',
      'AWS::ECS::TaskDefinition'
    );

    expect(mockSend.mock.calls[0]?.[0]).toBeInstanceOf(DescribeTaskDefinitionCommand);
    expect(result).toEqual({
      Family: 'my-td',
      Cpu: '256',
      Memory: '512',
      NetworkMode: 'awsvpc',
      RequiresCompatibilities: ['FARGATE'],
      ExecutionRoleArn: 'arn:aws:iam::123:role/exec',
      EphemeralStorage: { SizeInGiB: 21 },
    });
  });

  it('returns undefined when cluster is gone', async () => {
    mockSend.mockResolvedValueOnce({ clusters: [] });

    const result = await provider.readCurrentState('gone', 'ClusterLogical', 'AWS::ECS::Cluster');

    expect(result).toBeUndefined();
  });
});
