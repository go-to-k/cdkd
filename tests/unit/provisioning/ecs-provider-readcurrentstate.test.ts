import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
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
      DefaultCapacityProviderStrategy: [],
      ClusterSettings: [{ Name: 'containerInsights', Value: 'enabled' }],
      Tags: [],
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
    // Class 1 gated keys (round-trip safety):
    //   - PlacementStrategy: omitted on Fargate (EC2-only field; AWS rejects
    //     `placementStrategy: []` on Fargate UpdateService).
    //   - CapacityProviderStrategy: omitted when LaunchType is set
    //     (mutually exclusive with capacityProviderStrategy on UpdateService).
    expect(result).toEqual({
      ServiceName: 'my-svc',
      Cluster: 'arn:aws:ecs:us-east-1:123:cluster/my-cluster',
      TaskDefinition: 'arn:aws:ecs:us-east-1:123:task-definition/td:1',
      DesiredCount: 2,
      LaunchType: 'FARGATE',
      EnableExecuteCommand: true,
      LoadBalancers: [],
      PlacementConstraints: [],
      ServiceRegistries: [],
      Tags: [],
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
      Volumes: [],
      PlacementConstraints: [],
      EphemeralStorage: { SizeInGiB: 21 },
      ContainerDefinitions: [],
      Tags: [],
    });
  });

  it('emits EnableFaultInjection when DescribeTaskDefinition returns it (#609 backfill)', async () => {
    mockSend.mockResolvedValueOnce({
      taskDefinition: {
        family: 'fi-td',
        enableFaultInjection: true,
      },
    });

    const result = await provider.readCurrentState(
      'arn:aws:ecs:us-east-1:123:task-definition/fi-td:1',
      'FiTd',
      'AWS::ECS::TaskDefinition'
    );

    expect(result?.EnableFaultInjection).toBe(true);
  });

  it('omits EnableFaultInjection when DescribeTaskDefinition does not return it', async () => {
    mockSend.mockResolvedValueOnce({
      taskDefinition: {
        family: 'plain-td',
      },
    });

    const result = await provider.readCurrentState(
      'arn:aws:ecs:us-east-1:123:task-definition/plain-td:1',
      'PlainTd',
      'AWS::ECS::TaskDefinition'
    );

    expect(result).toBeDefined();
    expect(result).not.toHaveProperty('EnableFaultInjection');
  });

  it('preserves explicit EnableFaultInjection=false on readback (distinct from omit)', async () => {
    // Locks in the `!== undefined` guard at the read side: a regression
    // to `if (td.enableFaultInjection)` would silently drop explicit `false`.
    mockSend.mockResolvedValueOnce({
      taskDefinition: {
        family: 'fi-false-td',
        enableFaultInjection: false,
      },
    });

    const result = await provider.readCurrentState(
      'arn:aws:ecs:us-east-1:123:task-definition/fi-false-td:1',
      'FiFalseTd',
      'AWS::ECS::TaskDefinition'
    );

    expect(result?.EnableFaultInjection).toBe(false);
  });

  it('returns undefined when cluster is gone', async () => {
    mockSend.mockResolvedValueOnce({ clusters: [] });

    const result = await provider.readCurrentState('gone', 'ClusterLogical', 'AWS::ECS::Cluster');

    expect(result).toBeUndefined();
  });

  it('surfaces Cluster Tags from DescribeClusters with aws:* filtered out', async () => {
    mockSend.mockResolvedValueOnce({
      clusters: [
        {
          clusterName: 'my-cluster',
          tags: [
            { key: 'Foo', value: 'Bar' },
            { key: 'aws:cdk:path', value: 'MyStack/MyCluster/Resource' },
          ],
        },
      ],
    });

    const result = await provider.readCurrentState(
      'my-cluster',
      'ClusterLogical',
      'AWS::ECS::Cluster'
    );

    expect(result?.Tags).toEqual([{ Key: 'Foo', Value: 'Bar' }]);
  });

  it('omits Cluster Tags when DescribeClusters returns no user tags', async () => {
    mockSend.mockResolvedValueOnce({
      clusters: [
        {
          clusterName: 'my-cluster',
          tags: [{ key: 'aws:cdk:path', value: 'MyStack/MyCluster/Resource' }],
        },
      ],
    });

    const result = await provider.readCurrentState(
      'my-cluster',
      'ClusterLogical',
      'AWS::ECS::Cluster'
    );

    expect(result?.Tags).toEqual([]);
  });
});
