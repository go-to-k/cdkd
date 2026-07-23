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

  it('accepts a bare service ARN physicalId and scopes DescribeServices to the ARN cluster (issue #1170)', async () => {
    // `createService` stores the service ARN (no `|`), so `readCurrentState`
    // must accept the ARN form or every cdkd-created Service reads back as
    // drift-unknown. The cluster is derived from the long-format ARN.
    mockSend.mockResolvedValueOnce({
      services: [
        {
          serviceName: 'my-svc',
          clusterArn: 'arn:aws:ecs:us-east-1:123:cluster/my-cluster',
          taskDefinition: 'arn:aws:ecs:us-east-1:123:task-definition/td:1',
          desiredCount: 2,
          launchType: 'FARGATE',
        },
      ],
    });

    const result = await provider.readCurrentState(
      'arn:aws:ecs:us-east-1:123:service/my-cluster/my-svc',
      'SvcLogical',
      'AWS::ECS::Service'
    );

    const cmd = mockSend.mock.calls[0]?.[0];
    expect(cmd).toBeInstanceOf(DescribeServicesCommand);
    // Cluster derived from the ARN, service name is the full ARN.
    expect((cmd as DescribeServicesCommand).input).toMatchObject({
      cluster: 'my-cluster',
      services: ['arn:aws:ecs:us-east-1:123:service/my-cluster/my-svc'],
    });
    expect(result).not.toBeUndefined();
    expect(result?.['ServiceName']).toBe('my-svc');
  });

  it('accepts a short-format service ARN physicalId and falls back to the default cluster (issue #1170)', async () => {
    // Legacy short-format ARN does not encode a cluster; the reader must not
    // return undefined — it passes an undefined cluster (AWS default cluster).
    mockSend.mockResolvedValueOnce({
      services: [{ serviceName: 'my-svc', desiredCount: 1, launchType: 'FARGATE' }],
    });

    const result = await provider.readCurrentState(
      'arn:aws:ecs:us-east-1:123:service/my-svc',
      'SvcLogical',
      'AWS::ECS::Service'
    );

    const cmd = mockSend.mock.calls[0]?.[0];
    expect(cmd).toBeInstanceOf(DescribeServicesCommand);
    expect((cmd as DescribeServicesCommand).input.cluster).toBeUndefined();
    expect((cmd as DescribeServicesCommand).input.services).toEqual([
      'arn:aws:ecs:us-east-1:123:service/my-svc',
    ]);
    expect(result?.['ServiceName']).toBe('my-svc');
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

  // --- issue #1167: reverse-map nested objects SDK camelCase -> CFn PascalCase ---
  // The drift baseline is state `properties` (PascalCase) or `observedProperties`;
  // readCurrentState must return PascalCase nested shapes so a resource whose
  // baseline falls back to the template `properties` does not phantom-drift.
  it('reverse-maps Cluster DefaultCapacityProviderStrategy + Configuration to PascalCase (issue #1167)', async () => {
    mockSend.mockResolvedValueOnce({
      clusters: [
        {
          clusterName: 'my-cluster',
          defaultCapacityProviderStrategy: [{ capacityProvider: 'FARGATE', weight: 1, base: 2 }],
          configuration: {
            executeCommandConfiguration: {
              logging: 'OVERRIDE',
              kmsKeyId: 'key-abc',
              logConfiguration: { cloudWatchLogGroupName: '/ecs/exec', s3BucketName: 'b' },
            },
          },
        },
      ],
    });

    const result = (await provider.readCurrentState(
      'my-cluster',
      'ClusterLogical',
      'AWS::ECS::Cluster'
    )) as Record<string, unknown>;

    expect(result['DefaultCapacityProviderStrategy']).toEqual([
      { CapacityProvider: 'FARGATE', Weight: 1, Base: 2 },
    ]);
    expect(result['Configuration']).toEqual({
      ExecuteCommandConfiguration: {
        Logging: 'OVERRIDE',
        KmsKeyId: 'key-abc',
        LogConfiguration: { CloudWatchLogGroupName: '/ecs/exec', S3BucketName: 'b' },
      },
    });
  });

  it('reverse-maps Service DeploymentConfiguration / CapacityProviderStrategy / PlacementConstraints / PlacementStrategy / ServiceRegistries to PascalCase (issue #1167)', async () => {
    mockSend.mockResolvedValueOnce({
      services: [
        {
          serviceName: 'my-svc',
          clusterArn: 'arn:aws:ecs:us-east-1:123:cluster/my-cluster',
          launchType: 'EC2',
          networkConfiguration: {
            awsvpcConfiguration: {
              subnets: ['subnet-1'],
              securityGroups: ['sg-1'],
              assignPublicIp: 'ENABLED',
            },
          },
          loadBalancers: [
            {
              targetGroupArn: 'arn:aws:elasticloadbalancing:us-east-1:0:targetgroup/tg/abc',
              containerName: 'web',
              containerPort: 8080,
            },
          ],
          capacityProviderStrategy: [{ capacityProvider: 'FARGATE', weight: 2, base: 1 }],
          deploymentConfiguration: {
            maximumPercent: 150,
            minimumHealthyPercent: 50,
            deploymentCircuitBreaker: { enable: true, rollback: true },
            alarms: { alarmNames: ['a'], enable: true, rollback: false },
            lifecycleHooks: [
              {
                hookTargetArn: 'arn:aws:lambda:us-east-1:0:function:h',
                roleArn: 'arn:aws:iam::0:role/r',
                lifecycleStages: ['POST_TEST_TRAFFIC_SHIFT'],
                // Free-form document: inner keys must be preserved verbatim.
                hookDetails: { CustomKey: 'CustomValue', Nested: { KeepMe: 1 } },
              },
            ],
          },
          placementConstraints: [{ type: 'memberOf', expression: 'attribute:ecs.os-type == linux' }],
          placementStrategy: [{ type: 'spread', field: 'attribute:ecs.availability-zone' }],
          serviceRegistries: [
            { registryArn: 'arn:aws:servicediscovery:us-east-1:0:service/srv', containerName: 'web', containerPort: 8080 },
          ],
        },
      ],
    });

    const result = (await provider.readCurrentState(
      'arn:aws:ecs:us-east-1:123:cluster/my-cluster|my-svc',
      'SvcLogical',
      'AWS::ECS::Service'
    )) as Record<string, unknown>;

    expect(result['NetworkConfiguration']).toEqual({
      AwsvpcConfiguration: {
        Subnets: ['subnet-1'],
        SecurityGroups: ['sg-1'],
        AssignPublicIp: 'ENABLED',
      },
    });
    expect(result['LoadBalancers']).toEqual([
      {
        TargetGroupArn: 'arn:aws:elasticloadbalancing:us-east-1:0:targetgroup/tg/abc',
        ContainerName: 'web',
        ContainerPort: 8080,
      },
    ]);
    expect(result['CapacityProviderStrategy']).toEqual([
      { CapacityProvider: 'FARGATE', Weight: 2, Base: 1 },
    ]);
    expect(result['DeploymentConfiguration']).toEqual({
      MaximumPercent: 150,
      MinimumHealthyPercent: 50,
      DeploymentCircuitBreaker: { Enable: true, Rollback: true },
      Alarms: { AlarmNames: ['a'], Enable: true, Rollback: false },
      LifecycleHooks: [
        {
          HookTargetArn: 'arn:aws:lambda:us-east-1:0:function:h',
          RoleArn: 'arn:aws:iam::0:role/r',
          LifecycleStages: ['POST_TEST_TRAFFIC_SHIFT'],
          HookDetails: { CustomKey: 'CustomValue', Nested: { KeepMe: 1 } },
        },
      ],
    });
    expect(result['PlacementConstraints']).toEqual([
      { Type: 'memberOf', Expression: 'attribute:ecs.os-type == linux' },
    ]);
    // EC2 launch type surfaces both spellings.
    expect(result['PlacementStrategy']).toEqual([
      { Type: 'spread', Field: 'attribute:ecs.availability-zone' },
    ]);
    expect(result['PlacementStrategies']).toEqual([
      { Type: 'spread', Field: 'attribute:ecs.availability-zone' },
    ]);
    expect(result['ServiceRegistries']).toEqual([
      { RegistryArn: 'arn:aws:servicediscovery:us-east-1:0:service/srv', ContainerName: 'web', ContainerPort: 8080 },
    ]);
  });

  it('reverse-maps TaskDefinition RuntimePlatform / ProxyConfiguration / PlacementConstraints to PascalCase (issue #1167)', async () => {
    mockSend.mockResolvedValueOnce({
      taskDefinition: {
        family: 'my-td',
        runtimePlatform: { cpuArchitecture: 'ARM64', operatingSystemFamily: 'LINUX' },
        proxyConfiguration: {
          type: 'APPMESH',
          containerName: 'envoy',
          properties: [
            { name: 'AppPorts', value: '80' },
            { name: 'IgnoredUID', value: '1337' },
          ],
        },
        placementConstraints: [{ type: 'memberOf', expression: 'attribute:ecs.os-type == linux' }],
      },
    });

    const result = (await provider.readCurrentState(
      'arn:aws:ecs:us-east-1:123:task-definition/my-td:1',
      'TDLogical',
      'AWS::ECS::TaskDefinition'
    )) as Record<string, unknown>;

    expect(result['RuntimePlatform']).toEqual({
      CpuArchitecture: 'ARM64',
      OperatingSystemFamily: 'LINUX',
    });
    // SDK `properties` maps back to CFn `ProxyConfigurationProperties`.
    expect(result['ProxyConfiguration']).toEqual({
      Type: 'APPMESH',
      ContainerName: 'envoy',
      ProxyConfigurationProperties: [
        { Name: 'AppPorts', Value: '80' },
        { Name: 'IgnoredUID', Value: '1337' },
      ],
    });
    expect(result['PlacementConstraints']).toEqual([
      { Type: 'memberOf', Expression: 'attribute:ecs.os-type == linux' },
    ]);
  });

  it('normalizes camelCase SDK volume shape back to PascalCase CFn form (issue #815)', async () => {
    // DescribeTaskDefinition returns camelCase volume sub-keys; the
    // readCurrentState snapshot must match the deploy-time PascalCase
    // template form so a future drift comparison does not see a phantom
    // key-case divergence.
    mockSend.mockResolvedValueOnce({
      taskDefinition: {
        family: 'vol-td',
        volumes: [
          { name: 'host-vol', host: { sourcePath: '/ecs/data' } },
          {
            name: 'efs-vol',
            efsVolumeConfiguration: {
              fileSystemId: 'fs-01234567',
              rootDirectory: '/data',
              transitEncryption: 'ENABLED',
              transitEncryptionPort: 2049,
              authorizationConfig: { accessPointId: 'fsap-0', iam: 'ENABLED' },
            },
          },
          {
            name: 'docker-vol',
            dockerVolumeConfiguration: { scope: 'shared', autoprovision: true, driver: 'local' },
          },
          {
            name: 'fsx-vol',
            fsxWindowsFileServerVolumeConfiguration: {
              fileSystemId: 'fs-0abc',
              rootDirectory: '\\data',
              authorizationConfig: { credentialsParameter: 'arn:secret', domain: 'corp.local' },
            },
            configuredAtLaunch: false,
          },
        ],
      },
    });

    const result = await provider.readCurrentState(
      'arn:aws:ecs:us-east-1:123:task-definition/vol-td:1',
      'VolTd',
      'AWS::ECS::TaskDefinition'
    );

    expect(result?.Volumes).toEqual([
      { Name: 'host-vol', Host: { SourcePath: '/ecs/data' } },
      {
        Name: 'efs-vol',
        EFSVolumeConfiguration: {
          FilesystemId: 'fs-01234567',
          RootDirectory: '/data',
          TransitEncryption: 'ENABLED',
          TransitEncryptionPort: 2049,
          AuthorizationConfig: { AccessPointId: 'fsap-0', IAM: 'ENABLED' },
        },
      },
      {
        Name: 'docker-vol',
        DockerVolumeConfiguration: { Scope: 'shared', Autoprovision: true, Driver: 'local' },
      },
      {
        Name: 'fsx-vol',
        FSxWindowsFileServerVolumeConfiguration: {
          FileSystemId: 'fs-0abc',
          RootDirectory: '\\data',
          AuthorizationConfig: { CredentialsParameter: 'arn:secret', Domain: 'corp.local' },
        },
        ConfiguredAtLaunch: false,
      },
    ]);
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

  it('emits ServiceConnectDefaults when DescribeClusters returns one', async () => {
    mockSend.mockResolvedValueOnce({
      clusters: [
        {
          clusterName: 'my-cluster',
          serviceConnectDefaults: {
            namespace: 'arn:aws:servicediscovery:us-east-1:0:namespace/ns-foo',
          },
        },
      ],
    });

    const result = await provider.readCurrentState(
      'my-cluster',
      'ClusterLogical',
      'AWS::ECS::Cluster'
    );

    expect(result?.ServiceConnectDefaults).toEqual({
      Namespace: 'arn:aws:servicediscovery:us-east-1:0:namespace/ns-foo',
    });
  });

  it('omits ServiceConnectDefaults when DescribeClusters returns none (typical cluster)', async () => {
    // Emit-when-present: a cluster that never set a default Service
    // Connect namespace returns no `serviceConnectDefaults` from
    // DescribeClusters. Emitting a placeholder `{ Namespace: '' }`
    // would force guaranteed drift on every clean run for the typical
    // case where users do not configure a cluster-wide default.
    mockSend.mockResolvedValueOnce({
      clusters: [
        {
          clusterName: 'my-cluster',
        },
      ],
    });

    const result = await provider.readCurrentState(
      'my-cluster',
      'ClusterLogical',
      'AWS::ECS::Cluster'
    );

    expect(result).not.toHaveProperty('ServiceConnectDefaults');
  });
});
