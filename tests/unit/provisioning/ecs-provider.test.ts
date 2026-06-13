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
