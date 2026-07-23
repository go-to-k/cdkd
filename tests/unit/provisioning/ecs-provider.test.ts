import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

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

      it('forwards ServiceConnectDefaults to CreateCluster when present', async () => {
        mockSend.mockResolvedValueOnce({
          cluster: {
            clusterArn: 'arn:aws:ecs:us-east-1:123456789012:cluster/my-cluster',
            clusterName: 'my-cluster',
          },
        });

        await provider.create('MyCluster', 'AWS::ECS::Cluster', {
          ClusterName: 'my-cluster',
          ServiceConnectDefaults: { Namespace: 'arn:aws:servicediscovery:us-east-1:0:namespace/ns-foo' },
        });

        const createCall = mockSend.mock.calls[0][0];
        expect(createCall.constructor.name).toBe('CreateClusterCommand');
        expect(createCall.input.serviceConnectDefaults).toEqual({
          namespace: 'arn:aws:servicediscovery:us-east-1:0:namespace/ns-foo',
        });
      });

      it('omits ServiceConnectDefaults from CreateCluster when absent', async () => {
        mockSend.mockResolvedValueOnce({
          cluster: {
            clusterArn: 'arn:aws:ecs:us-east-1:123456789012:cluster/my-cluster',
            clusterName: 'my-cluster',
          },
        });

        await provider.create('MyCluster', 'AWS::ECS::Cluster', {
          ClusterName: 'my-cluster',
        });

        const createCall = mockSend.mock.calls[0][0];
        expect(createCall.input.serviceConnectDefaults).toBeUndefined();
      });

      it('should convert Configuration PascalCase -> camelCase on CreateCluster (issue #1165)', async () => {
        mockSend.mockResolvedValueOnce({
          cluster: {
            clusterArn: 'arn:aws:ecs:us-east-1:123456789012:cluster/my-cluster',
            clusterName: 'my-cluster',
          },
        });

        await provider.create('MyCluster', 'AWS::ECS::Cluster', {
          ClusterName: 'my-cluster',
          Configuration: {
            ExecuteCommandConfiguration: {
              Logging: 'OVERRIDE',
              KmsKeyId: 'arn:aws:kms:us-east-1:123456789012:key/abc',
              LogConfiguration: {
                CloudWatchLogGroupName: '/ecs/exec',
                CloudWatchEncryptionEnabled: true,
                S3BucketName: 'my-exec-bucket',
              },
            },
          },
        });

        const createCall = mockSend.mock.calls[0][0];
        expect(createCall.input.configuration).toEqual({
          executeCommandConfiguration: {
            logging: 'OVERRIDE',
            kmsKeyId: 'arn:aws:kms:us-east-1:123456789012:key/abc',
            logConfiguration: {
              cloudWatchLogGroupName: '/ecs/exec',
              cloudWatchEncryptionEnabled: true,
              s3BucketName: 'my-exec-bucket',
            },
          },
        });
      });

      it('should convert DefaultCapacityProviderStrategy PascalCase -> camelCase on CreateCluster (issue #1165)', async () => {
        mockSend.mockResolvedValueOnce({
          cluster: {
            clusterArn: 'arn:aws:ecs:us-east-1:123456789012:cluster/my-cluster',
            clusterName: 'my-cluster',
          },
        });

        await provider.create('MyCluster', 'AWS::ECS::Cluster', {
          ClusterName: 'my-cluster',
          DefaultCapacityProviderStrategy: [
            { CapacityProvider: 'FARGATE', Weight: 1, Base: 2 },
            { CapacityProvider: 'FARGATE_SPOT', Weight: 4 },
          ],
        });

        const createCall = mockSend.mock.calls[0][0];
        expect(createCall.input.defaultCapacityProviderStrategy).toEqual([
          { capacityProvider: 'FARGATE', weight: 1, base: 2 },
          { capacityProvider: 'FARGATE_SPOT', weight: 4 },
        ]);
      });
    });

    describe('update', () => {
      it('should convert DefaultCapacityProviderStrategy PascalCase -> camelCase on PutClusterCapacityProviders (issue #1165)', async () => {
        // PutClusterCapacityProviders, then DescribeClusters for the ARN.
        mockSend.mockResolvedValueOnce({});
        mockSend.mockResolvedValueOnce({
          clusters: [{ clusterArn: 'arn:aws:ecs:us-east-1:123456789012:cluster/my-cluster' }],
        });

        await provider.update(
          'MyCluster',
          'my-cluster',
          'AWS::ECS::Cluster',
          {
            ClusterName: 'my-cluster',
            DefaultCapacityProviderStrategy: [{ CapacityProvider: 'FARGATE', Weight: 1, Base: 3 }],
          },
          { ClusterName: 'my-cluster' }
        );

        const putCall = mockSend.mock.calls[0][0];
        expect(putCall.constructor.name).toBe('PutClusterCapacityProvidersCommand');
        expect(putCall.input.defaultCapacityProviderStrategy).toEqual([
          { capacityProvider: 'FARGATE', weight: 1, base: 3 },
        ]);
      });

      it('should convert Configuration PascalCase -> camelCase on UpdateCluster (issue #1165)', async () => {
        // UpdateCluster (config changed), then DescribeClusters for the ARN.
        mockSend.mockResolvedValueOnce({});
        mockSend.mockResolvedValueOnce({
          clusters: [{ clusterArn: 'arn:aws:ecs:us-east-1:123456789012:cluster/my-cluster' }],
        });

        await provider.update(
          'MyCluster',
          'my-cluster',
          'AWS::ECS::Cluster',
          {
            ClusterName: 'my-cluster',
            Configuration: {
              ExecuteCommandConfiguration: { Logging: 'OVERRIDE', KmsKeyId: 'key-abc' },
            },
          },
          { ClusterName: 'my-cluster' }
        );

        const updateCall = mockSend.mock.calls[0][0];
        expect(updateCall.constructor.name).toBe('UpdateClusterCommand');
        expect(updateCall.input.configuration).toEqual({
          executeCommandConfiguration: { logging: 'OVERRIDE', kmsKeyId: 'key-abc' },
        });
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

      it('should convert RuntimePlatform / EphemeralStorage / ProxyConfiguration PascalCase -> camelCase (issue #1165)', async () => {
        mockSend.mockResolvedValueOnce({
          taskDefinition: {
            taskDefinitionArn: 'arn:aws:ecs:us-east-1:123456789012:task-definition/my-task:1',
          },
        });

        await provider.create('MyTask', 'AWS::ECS::TaskDefinition', {
          Family: 'my-task',
          ContainerDefinitions: [{ Name: 'web', Image: 'nginx:latest' }],
          RequiresCompatibilities: ['FARGATE'],
          // Graviton — before the fix this was passed raw and silently dropped,
          // so the task definition registered as the default X86_64.
          RuntimePlatform: { CpuArchitecture: 'ARM64', OperatingSystemFamily: 'LINUX' },
          EphemeralStorage: { SizeInGiB: 30 },
          PlacementConstraints: [{ Type: 'memberOf', Expression: 'attribute:ecs.os-type == linux' }],
          ProxyConfiguration: {
            Type: 'APPMESH',
            ContainerName: 'envoy',
            ProxyConfigurationProperties: [
              { Name: 'AppPorts', Value: '80' },
              { Name: 'IgnoredUID', Value: '1337' },
            ],
          },
        });

        const input = mockSend.mock.calls[0][0].input;
        expect(input.runtimePlatform).toEqual({
          cpuArchitecture: 'ARM64',
          operatingSystemFamily: 'LINUX',
        });
        expect(input.ephemeralStorage).toEqual({ sizeInGiB: 30 });
        expect(input.placementConstraints).toEqual([
          { type: 'memberOf', expression: 'attribute:ecs.os-type == linux' },
        ]);
        expect(input.proxyConfiguration).toEqual({
          type: 'APPMESH',
          containerName: 'envoy',
          properties: [
            { name: 'AppPorts', value: '80' },
            { name: 'IgnoredUID', value: '1337' },
          ],
        });
      });

      it('should convert ContainerDefinition LinuxParameters + LogConfiguration.SecretOptions PascalCase -> camelCase (issue #1165)', async () => {
        mockSend.mockResolvedValueOnce({
          taskDefinition: {
            taskDefinitionArn: 'arn:aws:ecs:us-east-1:123456789012:task-definition/my-task:1',
          },
        });

        await provider.create('MyTask', 'AWS::ECS::TaskDefinition', {
          Family: 'my-task',
          ContainerDefinitions: [
            {
              Name: 'web',
              Image: 'nginx:latest',
              LinuxParameters: {
                InitProcessEnabled: true,
                SharedMemorySize: 64,
                Capabilities: { Add: ['NET_ADMIN'], Drop: ['ALL'] },
                Devices: [{ HostPath: '/dev/null', ContainerPath: '/dev/null', Permissions: ['read'] }],
                Tmpfs: [{ ContainerPath: '/run', Size: 100, MountOptions: ['noexec'] }],
              },
              LogConfiguration: {
                LogDriver: 'awslogs',
                Options: { 'awslogs-group': '/ecs/web' },
                SecretOptions: [
                  { Name: 'token', ValueFrom: 'arn:aws:secretsmanager:us-east-1:0:secret:tok' },
                ],
              },
            },
          ],
        });

        const container = mockSend.mock.calls[0][0].input.containerDefinitions[0];
        expect(container.linuxParameters).toEqual({
          initProcessEnabled: true,
          sharedMemorySize: 64,
          capabilities: { add: ['NET_ADMIN'], drop: ['ALL'] },
          devices: [{ hostPath: '/dev/null', containerPath: '/dev/null', permissions: ['read'] }],
          tmpfs: [{ containerPath: '/run', size: 100, mountOptions: ['noexec'] }],
        });
        expect(container.logConfiguration.secretOptions).toEqual([
          { name: 'token', valueFrom: 'arn:aws:secretsmanager:us-east-1:0:secret:tok' },
        ]);
      });

      it('converts ContainerDefinition PascalCase array fields to ECS SDK camelCase', async () => {
        // Regression guard for the deploy-time AWS rejection caught by
        // the local-run-task-from-state integ on 2026-05-12: the pre-fix
        // `secrets: def['Secrets'] as Secret[]` cast left the wire shape
        // in PascalCase and AWS rejected RegisterTaskDefinition with
        // "secret.name should not be null or empty". This test asserts
        // every nested-object array field is rebuilt in camelCase.
        mockSend.mockResolvedValueOnce({
          taskDefinition: {
            taskDefinitionArn:
              'arn:aws:ecs:us-east-1:123456789012:task-definition/my-task:1',
          },
        });

        await provider.create('MyTask', 'AWS::ECS::TaskDefinition', {
          Family: 'my-task',
          ContainerDefinitions: [
            {
              Name: 'web',
              Image: 'nginx:latest',
              Environment: [{ Name: 'FOO', Value: 'bar' }],
              EnvironmentFiles: [{ Type: 's3', Value: 'arn:aws:s3:::my-bucket/env' }],
              Secrets: [{ Name: 'DB_PASSWORD', ValueFrom: 'arn:aws:secretsmanager:us-east-1:123:secret:s' }],
              MountPoints: [{ SourceVolume: 'data', ContainerPath: '/data', ReadOnly: true }],
              VolumesFrom: [{ SourceContainer: 'sidecar', ReadOnly: false }],
              DependsOn: [{ ContainerName: 'sidecar', Condition: 'START' }],
              Ulimits: [{ Name: 'nofile', SoftLimit: 1024, HardLimit: 2048 }],
            },
          ],
          Cpu: '256',
          Memory: '512',
        });

        const input = mockSend.mock.calls[0][0].input;
        const c = input.containerDefinitions[0];
        expect(c.environment).toEqual([{ name: 'FOO', value: 'bar' }]);
        expect(c.environmentFiles).toEqual([
          { type: 's3', value: 'arn:aws:s3:::my-bucket/env' },
        ]);
        expect(c.secrets).toEqual([
          { name: 'DB_PASSWORD', valueFrom: 'arn:aws:secretsmanager:us-east-1:123:secret:s' },
        ]);
        expect(c.mountPoints).toEqual([
          { sourceVolume: 'data', containerPath: '/data', readOnly: true },
        ]);
        expect(c.volumesFrom).toEqual([{ sourceContainer: 'sidecar', readOnly: false }]);
        expect(c.dependsOn).toEqual([{ containerName: 'sidecar', condition: 'START' }]);
        expect(c.ulimits).toEqual([{ name: 'nofile', softLimit: 1024, hardLimit: 2048 }]);
      });

      it('maps the previously-dropped ContainerDefinition sub-fields to SDK camelCase (issue #1173)', async () => {
        mockSend.mockResolvedValueOnce({
          taskDefinition: {
            taskDefinitionArn: 'arn:aws:ecs:us-east-1:123456789012:task-definition/subfields:1',
          },
        });

        await provider.create('SubfieldsTask', 'AWS::ECS::TaskDefinition', {
          Family: 'subfields',
          ContainerDefinitions: [
            {
              Name: 'web',
              Image: 'nginx:latest',
              RepositoryCredentials: {
                CredentialsParameter: 'arn:aws:secretsmanager:us-east-1:123:secret:reg',
              },
              FirelensConfiguration: {
                Type: 'fluentbit',
                // free-form keys must survive verbatim:
                Options: { 'enable-ecs-log-metadata': 'true', 'config-file-value': '/extra.conf' },
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
          ],
        });

        const c = mockSend.mock.calls[0][0].input.containerDefinitions[0];
        expect(c.repositoryCredentials).toEqual({
          credentialsParameter: 'arn:aws:secretsmanager:us-east-1:123:secret:reg',
        });
        expect(c.firelensConfiguration).toEqual({
          type: 'fluentbit',
          options: { 'enable-ecs-log-metadata': 'true', 'config-file-value': '/extra.conf' },
        });
        expect(c.resourceRequirements).toEqual([{ type: 'GPU', value: '1' }]);
        expect(c.systemControls).toEqual([{ namespace: 'net.core.somaxconn', value: '1024' }]);
        expect(c.extraHosts).toEqual([{ hostname: 'db.local', ipAddress: '10.0.0.5' }]);
        expect(c.restartPolicy).toEqual({
          enabled: true,
          ignoredExitCodes: [1],
          restartAttemptPeriod: 60,
        });
        expect(c.dnsServers).toEqual(['10.0.0.2']);
        expect(c.dnsSearchDomains).toEqual(['example.internal']);
        expect(c.dockerSecurityOptions).toEqual(['label:user:me']);
        expect(c.credentialSpecs).toEqual(['credentialspecdomainless:arn:aws:...']);
        expect(c.hostname).toBe('web-host');
        expect(c.versionConsistency).toBe('disabled');
      });

      it('passes through undefined ContainerDefinition array fields without crashing', async () => {
        // Defensive — most container definitions don't set most of these
        // optional fields; the converter must not blow up on undefined.
        mockSend.mockResolvedValueOnce({
          taskDefinition: {
            taskDefinitionArn:
              'arn:aws:ecs:us-east-1:123456789012:task-definition/minimal:1',
          },
        });

        await provider.create('MinimalTask', 'AWS::ECS::TaskDefinition', {
          Family: 'minimal',
          ContainerDefinitions: [{ Name: 'web', Image: 'nginx:latest' }],
        });

        const c = mockSend.mock.calls[0][0].input.containerDefinitions[0];
        expect(c.environment).toBeUndefined();
        expect(c.environmentFiles).toBeUndefined();
        expect(c.secrets).toBeUndefined();
        expect(c.mountPoints).toBeUndefined();
        expect(c.volumesFrom).toBeUndefined();
        expect(c.dependsOn).toBeUndefined();
        expect(c.ulimits).toBeUndefined();
      });

      it('forwards EnableFaultInjection=true onto RegisterTaskDefinition (#609 backfill)', async () => {
        // #609 backfill: EnableFaultInjection rides directly on
        // RegisterTaskDefinition (no separate API). The SDK key is
        // camelCase `enableFaultInjection`.
        mockSend.mockResolvedValueOnce({
          taskDefinition: {
            taskDefinitionArn:
              'arn:aws:ecs:us-east-1:123456789012:task-definition/fi-task:1',
          },
        });

        await provider.create('FiTask', 'AWS::ECS::TaskDefinition', {
          Family: 'fi-task',
          ContainerDefinitions: [{ Name: 'web', Image: 'nginx:latest' }],
          EnableFaultInjection: true,
        });

        const input = mockSend.mock.calls[0][0].input;
        expect(input.enableFaultInjection).toBe(true);
      });

      it('omits enableFaultInjection when EnableFaultInjection is absent (omit-when-absent)', async () => {
        mockSend.mockResolvedValueOnce({
          taskDefinition: {
            taskDefinitionArn:
              'arn:aws:ecs:us-east-1:123456789012:task-definition/fi-task:1',
          },
        });

        await provider.create('FiTask', 'AWS::ECS::TaskDefinition', {
          Family: 'fi-task',
          ContainerDefinitions: [{ Name: 'web', Image: 'nginx:latest' }],
        });

        const input = mockSend.mock.calls[0][0].input;
        expect(input.enableFaultInjection).toBeUndefined();
      });

      it('preserves explicit EnableFaultInjection=false (distinct from omit)', async () => {
        // Locks in `!== undefined` semantics: a future "skip-when-falsy"
        // refactor would silently drop explicit `false` without this test.
        mockSend.mockResolvedValueOnce({
          taskDefinition: {
            taskDefinitionArn:
              'arn:aws:ecs:us-east-1:123456789012:task-definition/fi-task:1',
          },
        });

        await provider.create('FiTask', 'AWS::ECS::TaskDefinition', {
          Family: 'fi-task',
          ContainerDefinitions: [{ Name: 'web', Image: 'nginx:latest' }],
          EnableFaultInjection: false,
        });

        const input = mockSend.mock.calls[0][0].input;
        expect(input.enableFaultInjection).toBe(false);
      });

      it('forwards Volumes[].ConfiguredAtLaunch onto RegisterTaskDefinition (issue #806)', async () => {
        // Regression guard for issue #806: ConfiguredAtLaunch was silently
        // dropped by convertVolumes, so a same-stack ECS Service with
        // VolumeConfigurations (managed EBS volume) failed to create with
        // "Volume configuration provided but no matching configuredAtLaunch
        // volume found in task definition".
        mockSend.mockResolvedValueOnce({
          taskDefinition: {
            taskDefinitionArn:
              'arn:aws:ecs:us-east-1:123456789012:task-definition/ebs-task:1',
          },
        });

        await provider.create('EbsTask', 'AWS::ECS::TaskDefinition', {
          Family: 'ebs-task',
          ContainerDefinitions: [
            {
              Name: 'web',
              Image: 'nginx:latest',
              MountPoints: [{ SourceVolume: 'docker-data', ContainerPath: '/data' }],
            },
          ],
          Volumes: [{ Name: 'docker-data', ConfiguredAtLaunch: true }],
        });

        const input = mockSend.mock.calls[0][0].input;
        expect(input.volumes).toEqual([
          {
            name: 'docker-data',
            host: undefined,
            dockerVolumeConfiguration: undefined,
            efsVolumeConfiguration: undefined,
            fsxWindowsFileServerVolumeConfiguration: undefined,
            configuredAtLaunch: true,
          },
        ]);
      });

      it('coerces stringly-typed ConfiguredAtLaunch ("true"/"false") to real booleans', async () => {
        // CFn booleans can arrive as the strings "true" / "false" (e.g. via
        // Fn::Sub / parameter plumbing); the wire boundary must normalize.
        mockSend.mockResolvedValueOnce({
          taskDefinition: {
            taskDefinitionArn:
              'arn:aws:ecs:us-east-1:123456789012:task-definition/ebs-task:1',
          },
        });

        await provider.create('EbsTask', 'AWS::ECS::TaskDefinition', {
          Family: 'ebs-task',
          ContainerDefinitions: [{ Name: 'web', Image: 'nginx:latest' }],
          Volumes: [
            { Name: 'vol-a', ConfiguredAtLaunch: 'true' },
            { Name: 'vol-b', ConfiguredAtLaunch: 'false' },
          ],
        });

        const input = mockSend.mock.calls[0][0].input;
        expect(input.volumes[0].configuredAtLaunch).toBe(true);
        expect(input.volumes[1].configuredAtLaunch).toBe(false);
      });

      it('omits configuredAtLaunch when ConfiguredAtLaunch is absent (omit-when-absent)', async () => {
        mockSend.mockResolvedValueOnce({
          taskDefinition: {
            taskDefinitionArn:
              'arn:aws:ecs:us-east-1:123456789012:task-definition/efs-task:1',
          },
        });

        await provider.create('EfsTask', 'AWS::ECS::TaskDefinition', {
          Family: 'efs-task',
          ContainerDefinitions: [{ Name: 'web', Image: 'nginx:latest' }],
          // CFn uses PascalCase `SourcePath` under `Host` (issue #815).
          Volumes: [{ Name: 'plain-vol', Host: { SourcePath: '/var/data' } }],
        });

        const input = mockSend.mock.calls[0][0].input;
        expect(input.volumes[0].configuredAtLaunch).toBeUndefined();
        expect(input.volumes[0].host).toEqual({ sourcePath: '/var/data' });
      });

      it('preserves explicit ConfiguredAtLaunch=false (distinct from omit)', async () => {
        mockSend.mockResolvedValueOnce({
          taskDefinition: {
            taskDefinitionArn:
              'arn:aws:ecs:us-east-1:123456789012:task-definition/ebs-task:1',
          },
        });

        await provider.create('EbsTask', 'AWS::ECS::TaskDefinition', {
          Family: 'ebs-task',
          ContainerDefinitions: [{ Name: 'web', Image: 'nginx:latest' }],
          Volumes: [{ Name: 'vol-a', ConfiguredAtLaunch: false }],
        });

        const input = mockSend.mock.calls[0][0].input;
        expect(input.volumes[0].configuredAtLaunch).toBe(false);
      });
    });

    describe('volume sub-configurations (issue #815)', () => {
      // Regression guard for issue #815: convertVolumes did not map
      // DockerVolumeConfiguration / FSxWindowsFileServerVolumeConfiguration
      // at all (silently dropped) and cast Host / EFSVolumeConfiguration
      // through raw (nested keys reached the SDK still PascalCase). Each
      // volume sub-block must run through the PascalCase->camelCase
      // conversion so the registered task definition is correct on AWS.
      const arnResp = {
        taskDefinition: {
          taskDefinitionArn:
            'arn:aws:ecs:us-east-1:123456789012:task-definition/vol-task:1',
        },
      };

      it('converts EFSVolumeConfiguration PascalCase keys to SDK camelCase', async () => {
        mockSend.mockResolvedValueOnce(arnResp);

        await provider.create('EfsTask', 'AWS::ECS::TaskDefinition', {
          Family: 'efs-task',
          ContainerDefinitions: [{ Name: 'web', Image: 'nginx:latest' }],
          Volumes: [
            {
              Name: 'efs-data',
              // CFn uses `FilesystemId` (lowercase s) and `IAM` (all caps)
              // under AuthorizationConfig — not a simple first-letter flip.
              EFSVolumeConfiguration: {
                FilesystemId: 'fs-01234567',
                RootDirectory: '/data',
                TransitEncryption: 'ENABLED',
                TransitEncryptionPort: 2049,
                AuthorizationConfig: {
                  AccessPointId: 'fsap-0123456789abcdef0',
                  IAM: 'ENABLED',
                },
              },
            },
          ],
        });

        const input = mockSend.mock.calls[0][0].input;
        expect(input.volumes[0].efsVolumeConfiguration).toEqual({
          fileSystemId: 'fs-01234567',
          rootDirectory: '/data',
          transitEncryption: 'ENABLED',
          transitEncryptionPort: 2049,
          authorizationConfig: {
            accessPointId: 'fsap-0123456789abcdef0',
            iam: 'ENABLED',
          },
        });
        // The Docker/FSx siblings are absent -> omitted.
        expect(input.volumes[0].dockerVolumeConfiguration).toBeUndefined();
        expect(input.volumes[0].fsxWindowsFileServerVolumeConfiguration).toBeUndefined();
      });

      it('coerces a stringly-typed EFS TransitEncryptionPort to a number', async () => {
        mockSend.mockResolvedValueOnce(arnResp);

        await provider.create('EfsTask', 'AWS::ECS::TaskDefinition', {
          Family: 'efs-task',
          ContainerDefinitions: [{ Name: 'web', Image: 'nginx:latest' }],
          Volumes: [
            {
              Name: 'efs-data',
              EFSVolumeConfiguration: { FilesystemId: 'fs-01234567', TransitEncryptionPort: '2049' },
            },
          ],
        });

        const input = mockSend.mock.calls[0][0].input;
        expect(input.volumes[0].efsVolumeConfiguration.transitEncryptionPort).toBe(2049);
      });

      it('converts DockerVolumeConfiguration PascalCase keys to SDK camelCase', async () => {
        mockSend.mockResolvedValueOnce(arnResp);

        await provider.create('DockerTask', 'AWS::ECS::TaskDefinition', {
          Family: 'docker-task',
          ContainerDefinitions: [{ Name: 'web', Image: 'nginx:latest' }],
          Volumes: [
            {
              Name: 'docker-vol',
              DockerVolumeConfiguration: {
                Scope: 'shared',
                Autoprovision: true,
                Driver: 'local',
                DriverOpts: { type: 'nfs' },
                Labels: { team: 'platform' },
              },
            },
          ],
        });

        const input = mockSend.mock.calls[0][0].input;
        expect(input.volumes[0].dockerVolumeConfiguration).toEqual({
          scope: 'shared',
          autoprovision: true,
          driver: 'local',
          driverOpts: { type: 'nfs' },
          labels: { team: 'platform' },
        });
      });

      it('coerces a stringly-typed DockerVolumeConfiguration Autoprovision boolean', async () => {
        mockSend.mockResolvedValueOnce(arnResp);

        await provider.create('DockerTask', 'AWS::ECS::TaskDefinition', {
          Family: 'docker-task',
          ContainerDefinitions: [{ Name: 'web', Image: 'nginx:latest' }],
          Volumes: [
            { Name: 'docker-vol', DockerVolumeConfiguration: { Scope: 'shared', Autoprovision: 'true' } },
          ],
        });

        const input = mockSend.mock.calls[0][0].input;
        expect(input.volumes[0].dockerVolumeConfiguration.autoprovision).toBe(true);
      });

      it('converts FSxWindowsFileServerVolumeConfiguration PascalCase keys to SDK camelCase', async () => {
        mockSend.mockResolvedValueOnce(arnResp);

        await provider.create('FsxTask', 'AWS::ECS::TaskDefinition', {
          Family: 'fsx-task',
          ContainerDefinitions: [{ Name: 'web', Image: 'nginx:latest' }],
          Volumes: [
            {
              Name: 'fsx-data',
              // CFn uses `FileSystemId` (capital S) here, unlike EFS's
              // `FilesystemId` (lowercase s).
              FSxWindowsFileServerVolumeConfiguration: {
                FileSystemId: 'fs-0abcdef0123456789',
                RootDirectory: '\\data',
                AuthorizationConfig: {
                  CredentialsParameter:
                    'arn:aws:secretsmanager:us-east-1:123456789012:secret:fsx-creds',
                  Domain: 'corp.example.com',
                },
              },
            },
          ],
        });

        const input = mockSend.mock.calls[0][0].input;
        expect(input.volumes[0].fsxWindowsFileServerVolumeConfiguration).toEqual({
          fileSystemId: 'fs-0abcdef0123456789',
          rootDirectory: '\\data',
          authorizationConfig: {
            credentialsParameter:
              'arn:aws:secretsmanager:us-east-1:123456789012:secret:fsx-creds',
            domain: 'corp.example.com',
          },
        });
      });

      it('converts Host.SourcePath PascalCase key to SDK camelCase', async () => {
        mockSend.mockResolvedValueOnce(arnResp);

        await provider.create('HostTask', 'AWS::ECS::TaskDefinition', {
          Family: 'host-task',
          ContainerDefinitions: [{ Name: 'web', Image: 'nginx:latest' }],
          Volumes: [{ Name: 'host-vol', Host: { SourcePath: '/ecs/data' } }],
        });

        const input = mockSend.mock.calls[0][0].input;
        expect(input.volumes[0].host).toEqual({ sourcePath: '/ecs/data' });
      });

      it('omits every volume sub-configuration when absent (omit-when-absent)', async () => {
        mockSend.mockResolvedValueOnce(arnResp);

        await provider.create('BareTask', 'AWS::ECS::TaskDefinition', {
          Family: 'bare-task',
          ContainerDefinitions: [{ Name: 'web', Image: 'nginx:latest' }],
          Volumes: [{ Name: 'bare-vol' }],
        });

        const input = mockSend.mock.calls[0][0].input;
        expect(input.volumes[0].host).toBeUndefined();
        expect(input.volumes[0].dockerVolumeConfiguration).toBeUndefined();
        expect(input.volumes[0].efsVolumeConfiguration).toBeUndefined();
        expect(input.volumes[0].fsxWindowsFileServerVolumeConfiguration).toBeUndefined();
      });
    });

    describe('update', () => {
      it('rejects with ResourceUpdateNotSupportedError; revisions are immutable', async () => {
        // TaskDefinition revisions are immutable: every property change
        // creates a new revision via RegisterTaskDefinition, and the new
        // ARN diverges from cdkd state's physicalId. Routing through
        // `cdkd drift --revert` would silently swap state's physicalId
        // for a freshly-registered revision and deregister the previous
        // one. The deploy code path uses Replace (CREATE→DELETE) for
        // property changes; `update()` itself must reject loudly.
        await expect(
          provider.update(
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
          )
        ).rejects.toMatchObject({ name: 'ResourceUpdateNotSupportedError' });

        // No spurious AWS calls — error fires before any send().
        expect(mockSend).not.toHaveBeenCalled();
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

      // --- issue #1165: CFn PascalCase nested-object -> SDK camelCase ---------
      // These five fields were previously passed RAW (PascalCase) into the SDK's
      // camelCase input slots, so the SDK read absent keys and silently dropped
      // the whole value on create. Every test feeds the CFn PascalCase shape and
      // asserts the SDK command receives camelCase.
      it('should convert DeploymentConfiguration PascalCase -> camelCase on create (issue #1165)', async () => {
        mockSend.mockResolvedValueOnce({
          service: {
            serviceArn: 'arn:aws:ecs:us-east-1:123456789012:service/my-cluster/my-service',
            serviceName: 'my-service',
          },
        });

        await provider.create('MyService', 'AWS::ECS::Service', {
          Cluster: 'my-cluster',
          ServiceName: 'my-service',
          DeploymentConfiguration: {
            MaximumPercent: 250,
            MinimumHealthyPercent: 50,
            DeploymentCircuitBreaker: { Enable: true, Rollback: true },
            Alarms: { AlarmNames: ['alarm-a', 'alarm-b'], Enable: true, Rollback: false },
          },
        });

        const input = mockSend.mock.calls[0][0].input;
        expect(input.deploymentConfiguration).toEqual({
          maximumPercent: 250,
          minimumHealthyPercent: 50,
          deploymentCircuitBreaker: { enable: true, rollback: true },
          alarms: { alarmNames: ['alarm-a', 'alarm-b'], enable: true, rollback: false },
        });
      });

      it('should preserve DeploymentConfiguration LifecycleHooks HookDetails verbatim (issue #1165)', async () => {
        mockSend.mockResolvedValueOnce({
          service: {
            serviceArn: 'arn:aws:ecs:us-east-1:123456789012:service/my-cluster/my-service',
            serviceName: 'my-service',
          },
        });

        await provider.create('MyService', 'AWS::ECS::Service', {
          Cluster: 'my-cluster',
          ServiceName: 'my-service',
          DeploymentConfiguration: {
            Strategy: 'BLUE_GREEN',
            BakeTimeInMinutes: 5,
            LifecycleHooks: [
              {
                HookTargetArn: 'arn:aws:lambda:us-east-1:123456789012:function:hook',
                RoleArn: 'arn:aws:iam::123456789012:role/hook-role',
                LifecycleStages: ['POST_TEST_TRAFFIC_SHIFT'],
                // Free-form document: inner keys are user data, not CFn props,
                // so they must reach the SDK byte-identical (NOT case-flipped).
                HookDetails: { CustomKey: 'CustomValue', Nested: { KeepMe: 1 } },
              },
            ],
          },
        });

        const dc = mockSend.mock.calls[0][0].input.deploymentConfiguration;
        expect(dc.strategy).toBe('BLUE_GREEN');
        expect(dc.bakeTimeInMinutes).toBe(5);
        expect(dc.lifecycleHooks).toEqual([
          {
            hookTargetArn: 'arn:aws:lambda:us-east-1:123456789012:function:hook',
            roleArn: 'arn:aws:iam::123456789012:role/hook-role',
            lifecycleStages: ['POST_TEST_TRAFFIC_SHIFT'],
            hookDetails: { CustomKey: 'CustomValue', Nested: { KeepMe: 1 } },
          },
        ]);
      });

      it('should convert CapacityProviderStrategy / PlacementConstraints / PlacementStrategies / ServiceRegistries PascalCase -> camelCase on create (issue #1165)', async () => {
        mockSend.mockResolvedValueOnce({
          service: {
            serviceArn: 'arn:aws:ecs:us-east-1:123456789012:service/my-cluster/my-service',
            serviceName: 'my-service',
          },
        });

        await provider.create('MyService', 'AWS::ECS::Service', {
          Cluster: 'my-cluster',
          ServiceName: 'my-service',
          CapacityProviderStrategy: [{ CapacityProvider: 'FARGATE_SPOT', Weight: 2, Base: 1 }],
          PlacementConstraints: [{ Type: 'memberOf', Expression: 'attribute:ecs.instance-type =~ t2.*' }],
          PlacementStrategies: [{ Type: 'spread', Field: 'attribute:ecs.availability-zone' }],
          ServiceRegistries: [
            {
              RegistryArn: 'arn:aws:servicediscovery:us-east-1:123456789012:service/srv-abc',
              Port: 8080,
              ContainerName: 'web',
              ContainerPort: 8080,
            },
          ],
        });

        const input = mockSend.mock.calls[0][0].input;
        expect(input.capacityProviderStrategy).toEqual([
          { capacityProvider: 'FARGATE_SPOT', weight: 2, base: 1 },
        ]);
        expect(input.placementConstraints).toEqual([
          { type: 'memberOf', expression: 'attribute:ecs.instance-type =~ t2.*' },
        ]);
        expect(input.placementStrategy).toEqual([
          { type: 'spread', field: 'attribute:ecs.availability-zone' },
        ]);
        expect(input.serviceRegistries).toEqual([
          {
            registryArn: 'arn:aws:servicediscovery:us-east-1:123456789012:service/srv-abc',
            port: 8080,
            containerName: 'web',
            containerPort: 8080,
          },
        ]);
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

      it('should map EnableECSManagedTags and PropagateTags into UpdateService (issue #975)', async () => {
        mockSend.mockResolvedValueOnce({
          service: {
            serviceArn: 'arn:aws:ecs:us-east-1:123456789012:service/my-cluster/my-service',
            serviceName: 'my-service',
          },
        });

        await provider.update(
          'MyService',
          'arn:aws:ecs:us-east-1:123456789012:service/my-cluster/my-service',
          'AWS::ECS::Service',
          {
            Cluster: 'my-cluster',
            ServiceName: 'my-service',
            EnableECSManagedTags: true,
            PropagateTags: 'TASK_DEFINITION',
          },
          {
            Cluster: 'my-cluster',
            ServiceName: 'my-service',
            EnableECSManagedTags: false,
          }
        );

        const updateCall = mockSend.mock.calls[0][0];
        expect(updateCall.constructor.name).toBe('UpdateServiceCommand');
        expect(updateCall.input.enableECSManagedTags).toBe(true);
        expect(updateCall.input.propagateTags).toBe('TASK_DEFINITION');
      });

      it('should map changed LoadBalancers into UpdateService for the ECS controller (issue #975)', async () => {
        mockSend.mockResolvedValueOnce({
          service: {
            serviceArn: 'arn:aws:ecs:us-east-1:123456789012:service/my-cluster/my-service',
            serviceName: 'my-service',
          },
        });

        await provider.update(
          'MyService',
          'arn:aws:ecs:us-east-1:123456789012:service/my-cluster/my-service',
          'AWS::ECS::Service',
          {
            Cluster: 'my-cluster',
            ServiceName: 'my-service',
            LoadBalancers: [
              {
                TargetGroupArn: 'arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/tg/abc',
                ContainerName: 'web',
                ContainerPort: 8080,
              },
            ],
          },
          {
            Cluster: 'my-cluster',
            ServiceName: 'my-service',
          }
        );

        const updateCall = mockSend.mock.calls[0][0];
        expect(updateCall.constructor.name).toBe('UpdateServiceCommand');
        expect(updateCall.input.loadBalancers).toEqual([
          {
            targetGroupArn: 'arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/tg/abc',
            containerName: 'web',
            containerPort: 8080,
            loadBalancerName: undefined,
          },
        ]);
      });

      it('should send empty LoadBalancers list on removal for the ECS controller (issue #975)', async () => {
        mockSend.mockResolvedValueOnce({
          service: {
            serviceArn: 'arn:aws:ecs:us-east-1:123456789012:service/my-cluster/my-service',
            serviceName: 'my-service',
          },
        });

        await provider.update(
          'MyService',
          'arn:aws:ecs:us-east-1:123456789012:service/my-cluster/my-service',
          'AWS::ECS::Service',
          {
            Cluster: 'my-cluster',
            ServiceName: 'my-service',
          },
          {
            Cluster: 'my-cluster',
            ServiceName: 'my-service',
            LoadBalancers: [
              {
                TargetGroupArn: 'arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/tg/abc',
                ContainerName: 'web',
                ContainerPort: 8080,
              },
            ],
          }
        );

        const updateCall = mockSend.mock.calls[0][0];
        expect(updateCall.input.loadBalancers).toEqual([]);
      });

      it('should map changed and removed ServiceRegistries for the ECS controller (issue #975)', async () => {
        // Changed: pass through
        mockSend.mockResolvedValueOnce({
          service: {
            serviceArn: 'arn:aws:ecs:us-east-1:123456789012:service/my-cluster/my-service',
            serviceName: 'my-service',
          },
        });

        await provider.update(
          'MyService',
          'arn:aws:ecs:us-east-1:123456789012:service/my-cluster/my-service',
          'AWS::ECS::Service',
          {
            Cluster: 'my-cluster',
            ServiceName: 'my-service',
            // CFn PascalCase input — must reach the SDK as camelCase (issue #1165).
            ServiceRegistries: [
              {
                RegistryArn: 'arn:aws:servicediscovery:us-east-1:123456789012:service/srv-abc',
                ContainerName: 'web',
                ContainerPort: 8080,
              },
            ],
          },
          {
            Cluster: 'my-cluster',
            ServiceName: 'my-service',
          }
        );

        expect(mockSend.mock.calls[0][0].input.serviceRegistries).toEqual([
          {
            registryArn: 'arn:aws:servicediscovery:us-east-1:123456789012:service/srv-abc',
            containerName: 'web',
            containerPort: 8080,
          },
        ]);

        // Removed: empty list
        mockSend.mockResolvedValueOnce({
          service: {
            serviceArn: 'arn:aws:ecs:us-east-1:123456789012:service/my-cluster/my-service',
            serviceName: 'my-service',
          },
        });

        await provider.update(
          'MyService',
          'arn:aws:ecs:us-east-1:123456789012:service/my-cluster/my-service',
          'AWS::ECS::Service',
          {
            Cluster: 'my-cluster',
            ServiceName: 'my-service',
          },
          {
            Cluster: 'my-cluster',
            ServiceName: 'my-service',
            ServiceRegistries: [
              { RegistryArn: 'arn:aws:servicediscovery:us-east-1:123456789012:service/srv-abc' },
            ],
          }
        );

        expect(mockSend.mock.calls[1][0].input.serviceRegistries).toEqual([]);
      });

      it('should THROW on a LoadBalancers / ServiceRegistries change under a non-ECS controller instead of silently dropping (issue #975)', async () => {
        // AWS applies LB/SR changes under CODE_DEPLOY via a new CodeDeploy
        // deployment, NOT UpdateService — cdkd cannot honor them, so it must
        // fail loudly rather than report success + poison state (the silent-
        // drop class this PR fixes).
        await expect(
          provider.update(
            'MyService',
            'arn:aws:ecs:us-east-1:123456789012:service/my-cluster/my-service',
            'AWS::ECS::Service',
            {
              Cluster: 'my-cluster',
              ServiceName: 'my-service',
              DeploymentController: { Type: 'CODE_DEPLOY' },
              PropagateTags: 'SERVICE',
              LoadBalancers: [
                {
                  TargetGroupArn: 'arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/tg/new',
                  ContainerName: 'web',
                  ContainerPort: 8080,
                },
              ],
              ServiceRegistries: [
                { RegistryArn: 'arn:aws:servicediscovery:us-east-1:123456789012:service/srv-new' },
              ],
            },
            {
              Cluster: 'my-cluster',
              ServiceName: 'my-service',
              DeploymentController: { Type: 'CODE_DEPLOY' },
            }
          )
        ).rejects.toThrow(/non-ECS controller|CODE_DEPLOY/);
        // The UpdateService call must never have been issued.
        expect(mockSend).not.toHaveBeenCalled();
      });

      it('should still update propagateTags under a non-ECS controller when LB/SR are unchanged (issue #975)', async () => {
        mockSend.mockResolvedValueOnce({
          service: {
            serviceArn: 'arn:aws:ecs:us-east-1:123456789012:service/my-cluster/my-service',
            serviceName: 'my-service',
          },
        });

        const lb = [
          {
            TargetGroupArn: 'arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/tg/same',
            ContainerName: 'web',
            ContainerPort: 8080,
          },
        ];
        await provider.update(
          'MyService',
          'arn:aws:ecs:us-east-1:123456789012:service/my-cluster/my-service',
          'AWS::ECS::Service',
          {
            Cluster: 'my-cluster',
            ServiceName: 'my-service',
            DeploymentController: { Type: 'CODE_DEPLOY' },
            PropagateTags: 'SERVICE',
            LoadBalancers: lb,
          },
          {
            Cluster: 'my-cluster',
            ServiceName: 'my-service',
            DeploymentController: { Type: 'CODE_DEPLOY' },
            PropagateTags: 'NONE',
            LoadBalancers: lb,
          }
        );

        const updateCall = mockSend.mock.calls[0][0];
        // enableECSManagedTags / propagateTags are accepted under all controllers;
        // unchanged LB/SR are omitted (no CodeDeploy-only path triggered).
        expect(updateCall.input.propagateTags).toBe('SERVICE');
        expect(updateCall.input.loadBalancers).toBeUndefined();
        expect(updateCall.input.serviceRegistries).toBeUndefined();
      });

      it('should not send unchanged LoadBalancers / ServiceRegistries (no-drift stays mutation-free)', async () => {
        mockSend.mockResolvedValueOnce({
          service: {
            serviceArn: 'arn:aws:ecs:us-east-1:123456789012:service/my-cluster/my-service',
            serviceName: 'my-service',
          },
        });

        const lbs = [
          {
            TargetGroupArn: 'arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/tg/abc',
            ContainerName: 'web',
            ContainerPort: 8080,
          },
        ];

        await provider.update(
          'MyService',
          'arn:aws:ecs:us-east-1:123456789012:service/my-cluster/my-service',
          'AWS::ECS::Service',
          {
            Cluster: 'my-cluster',
            ServiceName: 'my-service',
            DesiredCount: 4,
            LoadBalancers: lbs,
          },
          {
            Cluster: 'my-cluster',
            ServiceName: 'my-service',
            DesiredCount: 2,
            LoadBalancers: lbs,
          }
        );

        const updateCall = mockSend.mock.calls[0][0];
        expect(updateCall.input.desiredCount).toBe(4);
        expect(updateCall.input.loadBalancers).toBeUndefined();
        expect(updateCall.input.serviceRegistries).toBeUndefined();
      });

      // --- issue #1160: absent-field removal reset to CFn defaults -----------
      // UpdateService uses merge semantics, so a field DROPPED from the template
      // must be sent as its explicit CFn-default reset value (live-probed against
      // real AWS 2026-07-22), else the old live value silently persists.
      describe('removal reset to CFn defaults (issue #1160)', () => {
        const arn = 'arn:aws:ecs:us-east-1:123456789012:service/my-cluster/my-service';
        const okResponse = { service: { serviceArn: arn, serviceName: 'my-service' } };

        it('resets removed scalar/enum fields to their CFn defaults on update', async () => {
          mockSend.mockResolvedValueOnce(okResponse);

          await provider.update('MyService', arn, 'AWS::ECS::Service', {
            Cluster: 'my-cluster',
            ServiceName: 'my-service',
          }, {
            Cluster: 'my-cluster',
            ServiceName: 'my-service',
            PlatformVersion: '1.4.0',
            HealthCheckGracePeriodSeconds: 30,
            PropagateTags: 'TASK_DEFINITION',
            EnableECSManagedTags: true,
            EnableExecuteCommand: true,
            CapacityProviderStrategy: [{ CapacityProvider: 'FARGATE', Weight: 1 }],
            PlacementConstraints: [{ Type: 'distinctInstance' }],
            PlacementStrategies: [{ Type: 'spread', Field: 'attribute:ecs.availability-zone' }],
          });

          const input = mockSend.mock.calls[0][0].input;
          expect(input.platformVersion).toBe('LATEST');
          expect(input.healthCheckGracePeriodSeconds).toBe(0);
          expect(input.propagateTags).toBe('NONE');
          expect(input.enableECSManagedTags).toBe(false);
          expect(input.enableExecuteCommand).toBe(false);
          expect(input.capacityProviderStrategy).toEqual([]);
          expect(input.placementConstraints).toEqual([]);
          expect(input.placementStrategy).toEqual([]);
        });

        it('leaves a never-present field absent (no spurious reset value)', async () => {
          mockSend.mockResolvedValueOnce(okResponse);

          await provider.update('MyService', arn, 'AWS::ECS::Service', {
            Cluster: 'my-cluster',
            ServiceName: 'my-service',
            DesiredCount: 3,
          }, {
            Cluster: 'my-cluster',
            ServiceName: 'my-service',
            DesiredCount: 1,
          });

          const input = mockSend.mock.calls[0][0].input;
          expect(input.platformVersion).toBeUndefined();
          expect(input.healthCheckGracePeriodSeconds).toBeUndefined();
          expect(input.propagateTags).toBeUndefined();
          expect(input.enableECSManagedTags).toBeUndefined();
          expect(input.enableExecuteCommand).toBeUndefined();
          expect(input.capacityProviderStrategy).toBeUndefined();
          expect(input.placementConstraints).toBeUndefined();
          expect(input.placementStrategy).toBeUndefined();
          expect(input.deploymentConfiguration).toBeUndefined();
        });

        it('passes kept/changed fields through unchanged (no reset when present)', async () => {
          mockSend.mockResolvedValueOnce(okResponse);

          await provider.update('MyService', arn, 'AWS::ECS::Service', {
            Cluster: 'my-cluster',
            ServiceName: 'my-service',
            PlatformVersion: '1.4.0',
            HealthCheckGracePeriodSeconds: 45,
            PropagateTags: 'SERVICE',
            EnableECSManagedTags: true,
            PlacementConstraints: [{ Type: 'distinctInstance' }],
          }, {
            Cluster: 'my-cluster',
            ServiceName: 'my-service',
            PlatformVersion: '1.3.0',
            HealthCheckGracePeriodSeconds: 30,
            PropagateTags: 'TASK_DEFINITION',
            EnableECSManagedTags: false,
          });

          const input = mockSend.mock.calls[0][0].input;
          expect(input.platformVersion).toBe('1.4.0');
          expect(input.healthCheckGracePeriodSeconds).toBe(45);
          expect(input.propagateTags).toBe('SERVICE');
          expect(input.enableECSManagedTags).toBe(true);
          expect(input.placementConstraints).toEqual([{ type: 'distinctInstance' }]);
        });
      });

      // --- issue #1165: nested-object casing on the update SET path ----------
      it('should convert DeploymentConfiguration + CapacityProviderStrategy PascalCase -> camelCase on update (issue #1165)', async () => {
        const arn = 'arn:aws:ecs:us-east-1:123456789012:service/my-cluster/my-service';
        mockSend.mockResolvedValueOnce({ service: { serviceArn: arn, serviceName: 'my-service' } });

        await provider.update(
          'MyService',
          arn,
          'AWS::ECS::Service',
          {
            Cluster: 'my-cluster',
            ServiceName: 'my-service',
            DeploymentConfiguration: {
              MaximumPercent: 150,
              MinimumHealthyPercent: 75,
              DeploymentCircuitBreaker: { Enable: true, Rollback: false },
            },
            CapacityProviderStrategy: [{ CapacityProvider: 'FARGATE', Weight: 1, Base: 2 }],
            PlacementConstraints: [{ Type: 'memberOf', Expression: 'attribute:ecs.os-type == linux' }],
            PlacementStrategies: [{ Type: 'binpack', Field: 'memory' }],
          },
          {
            Cluster: 'my-cluster',
            ServiceName: 'my-service',
            DeploymentConfiguration: { MaximumPercent: 200 },
          }
        );

        const input = mockSend.mock.calls[0][0].input;
        expect(input.deploymentConfiguration).toEqual({
          maximumPercent: 150,
          minimumHealthyPercent: 75,
          deploymentCircuitBreaker: { enable: true, rollback: false },
        });
        expect(input.capacityProviderStrategy).toEqual([
          { capacityProvider: 'FARGATE', weight: 1, base: 2 },
        ]);
        expect(input.placementConstraints).toEqual([
          { type: 'memberOf', expression: 'attribute:ecs.os-type == linux' },
        ]);
        expect(input.placementStrategy).toEqual([{ type: 'binpack', field: 'memory' }]);
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

    describe('getAttribute', () => {
      it('scopes DescribeServices to the cluster derived from the service ARN (issue #1170)', async () => {
        // Without the cluster, DescribeServices defaults to the `default`
        // cluster and a Service in a named cluster comes back MISSING. The
        // cluster is derived from the long-format service ARN.
        mockSend.mockResolvedValueOnce({
          services: [
            {
              serviceArn: 'arn:aws:ecs:us-east-1:123456789012:service/my-cluster/my-service',
              serviceName: 'my-service',
            },
          ],
        });

        const arn = await provider.getAttribute(
          'arn:aws:ecs:us-east-1:123456789012:service/my-cluster/my-service',
          'AWS::ECS::Service',
          'ServiceArn'
        );

        const call = mockSend.mock.calls[0][0];
        expect(call.constructor.name).toBe('DescribeServicesCommand');
        expect(call.input.cluster).toBe('my-cluster');
        expect(call.input.services).toEqual([
          'arn:aws:ecs:us-east-1:123456789012:service/my-cluster/my-service',
        ]);
        expect(arn).toBe('arn:aws:ecs:us-east-1:123456789012:service/my-cluster/my-service');
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
