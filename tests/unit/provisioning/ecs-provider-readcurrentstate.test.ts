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
import { RESOURCE_NOT_FOUND } from '../../../src/types/resource.js';

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
      // issue #609: DescribeServices omits `deploymentController` for the
      // default ECS controller, so an absent field MEANS ECS — the reader
      // emits the CFn shape either way so an explicit `{Type: ECS}` template
      // does not phantom-drift.
      DeploymentController: { Type: 'ECS' },
      Tags: [],
    });
  });

  it('reverse-maps the #609 Service additions (AvailabilityZoneRebalancing / DeploymentController) and never fabricates the unreadable members', async () => {
    mockSend.mockResolvedValueOnce({
      services: [
        {
          serviceName: 'my-svc',
          clusterArn: 'arn:aws:ecs:us-east-1:123:cluster/my-cluster',
          launchType: 'FARGATE',
          availabilityZoneRebalancing: 'ENABLED',
          deploymentController: { type: 'CODE_DEPLOY' },
          // AWS reports the service-linked AWSServiceRoleForECS role ARN here
          // for a template that never set Role — it must NOT surface as Role.
          roleArn:
            'arn:aws:iam::123:role/aws-service-role/ecs.amazonaws.com/AWSServiceRoleForECS',
        },
      ],
    });

    const result = (await provider.readCurrentState(
      'arn:aws:ecs:us-east-1:123:cluster/my-cluster|my-svc',
      'SvcLogical',
      'AWS::ECS::Service'
    )) as Record<string, unknown>;

    expect(result['AvailabilityZoneRebalancing']).toBe('ENABLED');
    expect(result['DeploymentController']).toEqual({ Type: 'CODE_DEPLOY' });
    // Not readable from the top-level Service shape (declared in
    // getDriftUnknownPaths instead) — never fabricated:
    expect(result).not.toHaveProperty('Role');
    expect(result).not.toHaveProperty('ServiceConnectConfiguration');
    expect(result).not.toHaveProperty('VolumeConfigurations');
    expect(result).not.toHaveProperty('VpcLatticeConfigurations');
    expect(result).not.toHaveProperty('Monitoring');
    expect(result).not.toHaveProperty('ForceNewDeployment');
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

    const result = (await provider.readCurrentState(
      'arn:aws:ecs:us-east-1:123:service/my-cluster/my-svc',
      'SvcLogical',
      'AWS::ECS::Service'
    )) as Record<string, unknown> | undefined;

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

    const result = (await provider.readCurrentState(
      'arn:aws:ecs:us-east-1:123:service/my-svc',
      'SvcLogical',
      'AWS::ECS::Service'
    )) as Record<string, unknown> | undefined;

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

  // --- issue #1169: reverse-map ContainerDefinitions SDK camelCase -> CFn PascalCase ---
  it('reverse-maps ContainerDefinitions to CFn PascalCase and normalizes AWS-defaulted empties (issue #1169)', async () => {
    mockSend.mockResolvedValueOnce({
      taskDefinition: {
        family: 'my-td',
        containerDefinitions: [
          {
            name: 'AppContainer',
            image: 'public.ecr.aws/amazonlinux/amazonlinux:latest',
            memory: 512,
            essential: true,
            command: ['echo', 'hello'],
            // AWS-defaulted empties that must be dropped so they equal a
            // template that omits them:
            cpu: 0,
            portMappings: [],
            environment: [],
            mountPoints: [],
            volumesFrom: [],
            systemControls: [],
            logConfiguration: {
              logDriver: 'awslogs',
              // free-form option keys must be preserved verbatim (NOT flipped):
              options: {
                'awslogs-group': '/ecs/app',
                'awslogs-region': 'us-east-1',
                'awslogs-stream-prefix': 'cdkd',
              },
            },
            linuxParameters: {
              initProcessEnabled: true,
              // AWS always returns the capability pair even when empty:
              capabilities: { add: [], drop: [] },
            },
          },
        ],
      },
    });

    const result = (await provider.readCurrentState(
      'arn:aws:ecs:us-east-1:123:task-definition/my-td:1',
      'TDLogical',
      'AWS::ECS::TaskDefinition'
    )) as Record<string, unknown>;

    expect(result['ContainerDefinitions']).toEqual([
      {
        Name: 'AppContainer',
        Image: 'public.ecr.aws/amazonlinux/amazonlinux:latest',
        Memory: 512,
        Essential: true,
        Command: ['echo', 'hello'],
        LogConfiguration: {
          LogDriver: 'awslogs',
          Options: {
            'awslogs-group': '/ecs/app',
            'awslogs-region': 'us-east-1',
            'awslogs-stream-prefix': 'cdkd',
          },
        },
        LinuxParameters: {
          InitProcessEnabled: true,
        },
      },
    ]);
  });

  it('reverse-maps populated ContainerDefinitions sub-lists to PascalCase (issue #1169)', async () => {
    mockSend.mockResolvedValueOnce({
      taskDefinition: {
        family: 'my-td',
        containerDefinitions: [
          {
            name: 'c1',
            image: 'img',
            cpu: 256,
            environment: [{ name: 'FOO', value: 'bar' }],
            secrets: [{ name: 'SEC', valueFrom: 'arn:aws:ssm:...:parameter/x' }],
            portMappings: [{ containerPort: 8080, hostPort: 8080, protocol: 'tcp' }],
            mountPoints: [{ sourceVolume: 'v', containerPath: '/data', readOnly: true }],
            dependsOn: [{ containerName: 'c0', condition: 'START' }],
            ulimits: [{ name: 'nofile', softLimit: 1024, hardLimit: 2048 }],
            linuxParameters: {
              initProcessEnabled: false,
              capabilities: { add: ['NET_ADMIN'], drop: [] },
            },
          },
        ],
      },
    });

    const result = (await provider.readCurrentState(
      'arn:aws:ecs:us-east-1:123:task-definition/my-td:1',
      'TDLogical',
      'AWS::ECS::TaskDefinition'
    )) as Record<string, unknown>;

    expect(result['ContainerDefinitions']).toEqual([
      {
        Name: 'c1',
        Image: 'img',
        Cpu: 256,
        Environment: [{ Name: 'FOO', Value: 'bar' }],
        Secrets: [{ Name: 'SEC', ValueFrom: 'arn:aws:ssm:...:parameter/x' }],
        PortMappings: [{ ContainerPort: 8080, HostPort: 8080, Protocol: 'tcp' }],
        MountPoints: [{ SourceVolume: 'v', ContainerPath: '/data', ReadOnly: true }],
        DependsOn: [{ ContainerName: 'c0', Condition: 'START' }],
        Ulimits: [{ Name: 'nofile', SoftLimit: 1024, HardLimit: 2048 }],
        LinuxParameters: {
          InitProcessEnabled: false,
          // non-empty Add survives; empty Drop is dropped:
          Capabilities: { Add: ['NET_ADMIN'] },
        },
      },
    ]);
  });

  it('reverse-maps the #1173 ContainerDefinition sub-fields to PascalCase (issue #1173)', async () => {
    mockSend.mockResolvedValueOnce({
      taskDefinition: {
        family: 'my-td',
        containerDefinitions: [
          {
            name: 'c1',
            image: 'img',
            repositoryCredentials: {
              credentialsParameter: 'arn:aws:secretsmanager:us-east-1:123:secret:reg',
            },
            firelensConfiguration: {
              type: 'fluentbit',
              options: { 'enable-ecs-log-metadata': 'true' },
            },
            resourceRequirements: [{ type: 'GPU', value: '1' }],
            systemControls: [{ namespace: 'net.core.somaxconn', value: '1024' }],
            extraHosts: [{ hostname: 'db.local', ipAddress: '10.0.0.5' }],
            restartPolicy: { enabled: true, ignoredExitCodes: [1], restartAttemptPeriod: 60 },
            dnsServers: ['10.0.0.2'],
            dnsSearchDomains: ['example.internal'],
            dockerSecurityOptions: ['label:user:me'],
            credentialSpecs: ['credentialspecdomainless:arn:aws:...'],
            hostname: 'web-host',
            versionConsistency: 'disabled',
          },
        ],
      },
    });

    const result = (await provider.readCurrentState(
      'arn:aws:ecs:us-east-1:123:task-definition/my-td:1',
      'TDLogical',
      'AWS::ECS::TaskDefinition'
    )) as Record<string, unknown>;

    expect(result['ContainerDefinitions']).toEqual([
      {
        Name: 'c1',
        Image: 'img',
        RepositoryCredentials: {
          CredentialsParameter: 'arn:aws:secretsmanager:us-east-1:123:secret:reg',
        },
        // free-form FireLens option keys preserved verbatim:
        FirelensConfiguration: {
          Type: 'fluentbit',
          Options: { 'enable-ecs-log-metadata': 'true' },
        },
        ResourceRequirements: [{ Type: 'GPU', Value: '1' }],
        SystemControls: [{ Namespace: 'net.core.somaxconn', Value: '1024' }],
        ExtraHosts: [{ Hostname: 'db.local', IpAddress: '10.0.0.5' }],
        RestartPolicy: { Enabled: true, IgnoredExitCodes: [1], RestartAttemptPeriod: 60 },
        DnsServers: ['10.0.0.2'],
        DnsSearchDomains: ['example.internal'],
        DockerSecurityOptions: ['label:user:me'],
        CredentialSpecs: ['credentialspecdomainless:arn:aws:...'],
        Hostname: 'web-host',
        VersionConsistency: 'disabled',
      },
    ]);
  });

  it('drops the AWS-default VersionConsistency=enabled so it does not phantom-drift (issue #1173)', async () => {
    // AWS returns versionConsistency: 'enabled' by default even when the
    // template omits it; the read must drop the default (like Cpu: 0) so a
    // template that omits it does not phantom-drift on the properties baseline.
    mockSend.mockResolvedValueOnce({
      taskDefinition: {
        family: 'my-td',
        containerDefinitions: [{ name: 'c1', image: 'img', versionConsistency: 'enabled' }],
      },
    });

    const result = (await provider.readCurrentState(
      'arn:aws:ecs:us-east-1:123:task-definition/my-td:1',
      'TDLogical',
      'AWS::ECS::TaskDefinition'
    )) as Record<string, unknown>;

    expect(result['ContainerDefinitions']).toEqual([{ Name: 'c1', Image: 'img' }]);
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
          {
            name: 's3files-vol',
            // The irregular all-lowercase-prefix SDK member (issue #1373).
            s3filesVolumeConfiguration: {
              fileSystemArn: 'arn:aws:s3:us-east-1:123:files/my-fs',
              accessPointArn: 'arn:aws:s3:us-east-1:123:files-access-point/my-ap',
              rootDirectory: '/',
              transitEncryptionPort: 443,
            },
          },
        ],
      },
    });

    const result = (await provider.readCurrentState(
      'arn:aws:ecs:us-east-1:123:task-definition/vol-td:1',
      'VolTd',
      'AWS::ECS::TaskDefinition'
    )) as Record<string, unknown> | undefined;

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
      {
        Name: 's3files-vol',
        S3FilesVolumeConfiguration: {
          FileSystemArn: 'arn:aws:s3:us-east-1:123:files/my-fs',
          AccessPointArn: 'arn:aws:s3:us-east-1:123:files-access-point/my-ap',
          RootDirectory: '/',
          TransitEncryptionPort: 443,
        },
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

    const result = (await provider.readCurrentState(
      'arn:aws:ecs:us-east-1:123:task-definition/fi-td:1',
      'FiTd',
      'AWS::ECS::TaskDefinition'
    )) as Record<string, unknown> | undefined;

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

    const result = (await provider.readCurrentState(
      'arn:aws:ecs:us-east-1:123:task-definition/fi-false-td:1',
      'FiFalseTd',
      'AWS::ECS::TaskDefinition'
    )) as Record<string, unknown> | undefined;

    expect(result?.EnableFaultInjection).toBe(false);
  });

  it('returns RESOURCE_NOT_FOUND when cluster is gone (a MISSING failure)', async () => {
    mockSend.mockResolvedValueOnce({ clusters: [], failures: [{ arn: 'gone', reason: 'MISSING' }] });

    const result = await provider.readCurrentState('gone', 'ClusterLogical', 'AWS::ECS::Cluster');

    expect(result).toBe(RESOURCE_NOT_FOUND);
  });

  it('keeps undefined for an empty clusters list with no failures (no answer)', async () => {
    mockSend.mockResolvedValueOnce({ clusters: [] });

    const result = await provider.readCurrentState('gone', 'ClusterLogical', 'AWS::ECS::Cluster');

    expect(result).toBeUndefined();
  });

  it('keeps undefined for a short-format service ARN the default cluster reports MISSING', async () => {
    // The legacy ARN names no cluster, so the call asked the DEFAULT cluster;
    // its MISSING says nothing about a service in a named cluster.
    mockSend.mockResolvedValueOnce({
      services: [],
      failures: [{ arn: 'x', reason: 'MISSING' }],
    });

    const result = await provider.readCurrentState(
      'arn:aws:ecs:us-east-1:123456789012:service/my-svc',
      'SvcLogical',
      'AWS::ECS::Service'
    );

    expect(result).toBeUndefined();
  });

  it('keeps undefined for a short-format service ARN whose default-cluster call says ServiceNotFound', async () => {
    mockSend.mockRejectedValueOnce(
      Object.assign(new Error('Service not found'), { name: 'ServiceNotFoundException' })
    );

    const result = await provider.readCurrentState(
      'arn:aws:ecs:us-east-1:123456789012:service/my-svc',
      'SvcLogical',
      'AWS::ECS::Service'
    );

    expect(result).toBeUndefined();
  });

  // go-to-k/cdkd#4283: a deleted resource reads as gone, not as "no read path".
  describe('not-found answers (go-to-k/cdkd#4283)', () => {
    const svcArn = 'arn:aws:ecs:us-east-1:123:service/my-cluster/my-svc';
    const tdArn = 'arn:aws:ecs:us-east-1:123:task-definition/my-td:1';
    const named = (name: string, message: string): Error =>
      Object.assign(new Error(message), { name });

    it('Cluster: a MISSING failure is gone; another failure reason is not', async () => {
      mockSend.mockResolvedValueOnce({ clusters: [], failures: [{ reason: 'MISSING' }] });
      expect(await provider.readCurrentState('gone', 'C', 'AWS::ECS::Cluster')).toBe(
        RESOURCE_NOT_FOUND
      );

      mockSend.mockResolvedValueOnce({ clusters: [], failures: [{ reason: 'INTERNAL' }] });
      expect(await provider.readCurrentState('gone', 'C', 'AWS::ECS::Cluster')).toBeUndefined();
    });

    it('Cluster: ClusterNotFoundException is gone; AccessDenied is not', async () => {
      mockSend.mockRejectedValueOnce(named('ClusterNotFoundException', 'Cluster not found.'));
      expect(await provider.readCurrentState('gone', 'C', 'AWS::ECS::Cluster')).toBe(
        RESOURCE_NOT_FOUND
      );

      mockSend.mockRejectedValueOnce(named('AccessDeniedException', 'denied'));
      expect(await provider.readCurrentState('gone', 'C', 'AWS::ECS::Cluster')).toBeUndefined();
    });

    it('Service: empty list with MISSING failure is gone; another reason is not', async () => {
      mockSend.mockResolvedValueOnce({ services: [], failures: [{ reason: 'MISSING' }] });
      expect(await provider.readCurrentState(svcArn, 'S', 'AWS::ECS::Service')).toBe(
        RESOURCE_NOT_FOUND
      );

      mockSend.mockResolvedValueOnce({ services: [], failures: [{ reason: 'INTERNAL' }] });
      expect(await provider.readCurrentState(svcArn, 'S', 'AWS::ECS::Service')).toBeUndefined();
    });

    it.each(['ClusterNotFoundException', 'ServiceNotFoundException'])(
      'Service: %s is gone',
      async (name) => {
        mockSend.mockRejectedValueOnce(named(name, 'not found'));
        expect(await provider.readCurrentState(svcArn, 'S', 'AWS::ECS::Service')).toBe(
          RESOURCE_NOT_FOUND
        );
      }
    );

    it('Service: AccessDenied is not gone', async () => {
      mockSend.mockRejectedValueOnce(named('AccessDeniedException', 'denied'));
      expect(await provider.readCurrentState(svcArn, 'S', 'AWS::ECS::Service')).toBeUndefined();
    });

    it('TaskDefinition: "Unable to describe task definition" is gone', async () => {
      mockSend.mockRejectedValueOnce(
        named('ClientException', 'Unable to describe task definition.')
      );
      expect(await provider.readCurrentState(tdArn, 'T', 'AWS::ECS::TaskDefinition')).toBe(
        RESOURCE_NOT_FOUND
      );
    });

    it.each([
      ['ClientException', 'User is not authorized to perform ecs:DescribeTaskDefinition'],
      ['AccessDeniedException', 'denied'],
    ])('TaskDefinition: %s (%s) is not gone', async (name, message) => {
      mockSend.mockRejectedValueOnce(named(name, message));
      expect(
        await provider.readCurrentState(tdArn, 'T', 'AWS::ECS::TaskDefinition')
      ).toBeUndefined();
    });
  });

  // go-to-k/cdkd#4272: ECS keeps LISTING a deleted resource for a while under a
  // terminal status. Each reader answers "gone" for that status only, and
  // present for every other one, so a live resource never reads as deleted.
  describe('a deleted resource ECS still lists (go-to-k/cdkd#4272)', () => {
    it.each([
      ['INACTIVE', false],
      ['ACTIVE', true],
      ['PROVISIONING', true],
      ['DEPROVISIONING', true],
      ['FAILED', true],
      [undefined, true],
    ])('Cluster with status %s reads as present=%s', async (status, present) => {
      mockSend.mockResolvedValueOnce({ clusters: [{ clusterName: 'my-cluster', status }] });

      const result = await provider.readCurrentState(
        'my-cluster',
        'ClusterLogical',
        'AWS::ECS::Cluster'
      );

      expect(mockSend).toHaveBeenCalledTimes(1);
      if (present) {
        expect((result as Record<string, unknown>)?.ClusterName).toBe('my-cluster');
      } else {
        expect(result).toBe(RESOURCE_NOT_FOUND);
      }
    });

    it.each([
      ['INACTIVE', false],
      ['ACTIVE', true],
      ['DRAINING', true],
      [undefined, true],
    ])('Service with status %s reads as present=%s', async (status, present) => {
      mockSend.mockResolvedValueOnce({
        services: [{ serviceName: 'my-svc', status, launchType: 'FARGATE' }],
      });

      const result = await provider.readCurrentState(
        'arn:aws:ecs:us-east-1:123:service/my-cluster/my-svc',
        'SvcLogical',
        'AWS::ECS::Service'
      );

      expect(mockSend).toHaveBeenCalledTimes(1);
      if (present) {
        expect((result as Record<string, unknown>)?.ServiceName).toBe('my-svc');
      } else {
        expect(result).toBe(RESOURCE_NOT_FOUND);
      }
    });

    it.each([
      ['INACTIVE', false],
      ['DELETE_IN_PROGRESS', false],
      ['ACTIVE', true],
      [undefined, true],
    ])('TaskDefinition with status %s reads as present=%s', async (status, present) => {
      mockSend.mockResolvedValueOnce({ taskDefinition: { family: 'my-td', status } });

      const result = await provider.readCurrentState(
        'arn:aws:ecs:us-east-1:123:task-definition/my-td:1',
        'TdLogical',
        'AWS::ECS::TaskDefinition'
      );

      expect(mockSend).toHaveBeenCalledTimes(1);
      if (present) {
        expect((result as Record<string, unknown>)?.Family).toBe('my-td');
      } else {
        expect(result).toBe(RESOURCE_NOT_FOUND);
      }
    });

    it.each([
      ['INACTIVE', false],
      ['DELETE_IN_PROGRESS', false],
      ['ACTIVE', true],
      [undefined, true],
    ])(
      'import of a TaskDefinition with status %s adopts it=%s',
      async (status, adopted) => {
        const arn = 'arn:aws:ecs:us-east-1:123:task-definition/my-td:1';
        mockSend.mockResolvedValueOnce({ taskDefinition: { taskDefinitionArn: arn, status } });

        const result = await provider.import({
          logicalId: 'TdLogical',
          resourceType: 'AWS::ECS::TaskDefinition',
          stackName: 'Stack',
          region: 'us-east-1',
          properties: {},
          knownPhysicalId: arn,
        });

        expect(mockSend.mock.calls[0]?.[0]).toBeInstanceOf(DescribeTaskDefinitionCommand);
        expect(result).toEqual(adopted ? { physicalId: arn, attributes: {} } : null);
      }
    );
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

    const result = (await provider.readCurrentState(
      'my-cluster',
      'ClusterLogical',
      'AWS::ECS::Cluster'
    )) as Record<string, unknown> | undefined;

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

    const result = (await provider.readCurrentState(
      'my-cluster',
      'ClusterLogical',
      'AWS::ECS::Cluster'
    )) as Record<string, unknown> | undefined;

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

    const result = (await provider.readCurrentState(
      'my-cluster',
      'ClusterLogical',
      'AWS::ECS::Cluster'
    )) as Record<string, unknown> | undefined;

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
