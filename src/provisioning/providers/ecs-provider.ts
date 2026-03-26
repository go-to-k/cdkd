import {
  ECSClient,
  CreateClusterCommand,
  DeleteClusterCommand,
  DescribeClustersCommand,
  PutClusterCapacityProvidersCommand,
  RegisterTaskDefinitionCommand,
  DeregisterTaskDefinitionCommand,
  DescribeTaskDefinitionCommand,
  CreateServiceCommand,
  UpdateServiceCommand,
  DeleteServiceCommand,
  DescribeServicesCommand,
  type Tag,
  type KeyValuePair,
  type PortMapping,
  type MountPoint,
  type VolumeFrom,
  type ContainerDependency,
  type EnvironmentFile,
  type Secret,
  type Ulimit,
  type LogConfiguration,
  type HealthCheck,
  type Volume,
  type ContainerDefinition,
  type NetworkConfiguration,
  type LoadBalancer,
  type DeploymentConfiguration,
  type CapacityProviderStrategyItem,
  type PlacementConstraint,
  type PlacementStrategy,
  type ServiceRegistry,
  type ClusterConfiguration,
  type NetworkMode,
  type Compatibility,
  type TaskDefinitionPlacementConstraint,
  type RuntimePlatform,
  type ProxyConfiguration,
  type PidMode,
  type IpcMode,
  type LaunchType,
  type SchedulingStrategy,
  type PropagateTags,
  type TransportProtocol,
  type ApplicationProtocol,
  type LogDriver,
  type EFSVolumeConfiguration,
  type AssignPublicIp,
} from '@aws-sdk/client-ecs';
import { getLogger } from '../../utils/logger.js';
import { ProvisioningError } from '../../utils/error-handler.js';
import { generateResourceName } from '../resource-name.js';
import type {
  ResourceProvider,
  ResourceCreateResult,
  ResourceUpdateResult,
} from '../../types/resource.js';

/**
 * Convert CFn Tags (Array<{Key, Value}>) to ECS Tags (Array<{key, value}>)
 */
function convertTags(tags?: Array<{ Key: string; Value: string }>): Tag[] | undefined {
  if (!tags || tags.length === 0) return undefined;
  return tags.map((t) => ({ key: t.Key, value: t.Value }));
}

/**
 * AWS ECS Provider
 *
 * Implements resource provisioning for ECS resources:
 * - AWS::ECS::Cluster
 * - AWS::ECS::TaskDefinition
 * - AWS::ECS::Service
 *
 * WHY: ECS CreateCluster and RegisterTaskDefinition are synchronous.
 * The CC API adds unnecessary polling overhead for operations that
 * complete immediately. This SDK provider eliminates that polling.
 */
export class ECSProvider implements ResourceProvider {
  private ecsClient?: ECSClient;
  private logger = getLogger().child('ECSProvider');

  private getClient(): ECSClient {
    if (!this.ecsClient) {
      this.ecsClient = new ECSClient({});
    }
    return this.ecsClient;
  }

  // ─── Dispatch ─────────────────────────────────────────────────────

  async create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
  ): Promise<ResourceCreateResult> {
    switch (resourceType) {
      case 'AWS::ECS::Cluster':
        return this.createCluster(logicalId, resourceType, properties);
      case 'AWS::ECS::TaskDefinition':
        return this.createTaskDefinition(logicalId, resourceType, properties);
      case 'AWS::ECS::Service':
        return this.createService(logicalId, resourceType, properties);
      default:
        throw new ProvisioningError(
          `Unsupported resource type: ${resourceType}`,
          resourceType,
          logicalId
        );
    }
  }

  async update(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>
  ): Promise<ResourceUpdateResult> {
    switch (resourceType) {
      case 'AWS::ECS::Cluster':
        return this.updateCluster(logicalId, physicalId, resourceType, properties);
      case 'AWS::ECS::TaskDefinition':
        return this.updateTaskDefinition(logicalId, physicalId, resourceType, properties);
      case 'AWS::ECS::Service':
        return this.updateService(
          logicalId,
          physicalId,
          resourceType,
          properties,
          previousProperties
        );
      default:
        throw new ProvisioningError(
          `Unsupported resource type: ${resourceType}`,
          resourceType,
          logicalId,
          physicalId
        );
    }
  }

  async delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties?: Record<string, unknown>
  ): Promise<void> {
    switch (resourceType) {
      case 'AWS::ECS::Cluster':
        return this.deleteCluster(logicalId, physicalId, resourceType);
      case 'AWS::ECS::TaskDefinition':
        return this.deleteTaskDefinition(logicalId, physicalId, resourceType);
      case 'AWS::ECS::Service':
        return this.deleteService(logicalId, physicalId, resourceType, properties);
      default:
        throw new ProvisioningError(
          `Unsupported resource type: ${resourceType}`,
          resourceType,
          logicalId,
          physicalId
        );
    }
  }

  async getAttribute(
    physicalId: string,
    resourceType: string,
    attributeName: string
  ): Promise<unknown> {
    switch (resourceType) {
      case 'AWS::ECS::Cluster':
        return this.getClusterAttribute(physicalId, attributeName);
      case 'AWS::ECS::TaskDefinition':
        return this.getTaskDefinitionAttribute(physicalId, attributeName);
      case 'AWS::ECS::Service':
        return this.getServiceAttribute(physicalId, attributeName);
      default:
        return undefined;
    }
  }

  // ─── AWS::ECS::Cluster ──────────────────────────────────────────

  private async createCluster(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
  ): Promise<ResourceCreateResult> {
    this.logger.debug(`Creating ECS cluster ${logicalId}`);
    const client = this.getClient();

    const clusterName =
      (properties['ClusterName'] as string | undefined) ||
      generateResourceName(logicalId, { maxLength: 255 });

    try {
      const response = await client.send(
        new CreateClusterCommand({
          clusterName,
          capacityProviders: properties['CapacityProviders'] as string[] | undefined,
          defaultCapacityProviderStrategy: properties['DefaultCapacityProviderStrategy'] as
            | CapacityProviderStrategyItem[]
            | undefined,
          configuration: properties['Configuration'] as ClusterConfiguration | undefined,
          settings: properties['ClusterSettings'] as
            | Array<{ name: 'containerInsights'; value: string }>
            | undefined,
          tags: convertTags(
            properties['Tags'] as Array<{ Key: string; Value: string }> | undefined
          ),
        })
      );

      const cluster = response.cluster;
      if (!cluster || !cluster.clusterArn) {
        throw new Error('CreateCluster did not return cluster ARN');
      }

      this.logger.debug(`Successfully created ECS cluster ${logicalId}: ${cluster.clusterArn}`);

      return {
        physicalId: clusterName,
        attributes: {
          Arn: cluster.clusterArn,
        },
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to create ECS cluster ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        clusterName,
        cause
      );
    }
  }

  private async updateCluster(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
  ): Promise<ResourceUpdateResult> {
    this.logger.debug(`Updating ECS cluster ${logicalId}: ${physicalId}`);
    const client = this.getClient();

    try {
      // Update capacity providers if specified
      if (properties['CapacityProviders'] || properties['DefaultCapacityProviderStrategy']) {
        await client.send(
          new PutClusterCapacityProvidersCommand({
            cluster: physicalId,
            capacityProviders: (properties['CapacityProviders'] as string[]) || [],
            defaultCapacityProviderStrategy:
              (properties['DefaultCapacityProviderStrategy'] as CapacityProviderStrategyItem[]) ||
              [],
          })
        );
        this.logger.debug(`Updated capacity providers for ECS cluster ${physicalId}`);
      }

      // Describe cluster to get current ARN
      const describeResponse = await client.send(
        new DescribeClustersCommand({ clusters: [physicalId] })
      );
      const cluster = describeResponse.clusters?.[0];

      return {
        physicalId,
        wasReplaced: false,
        attributes: {
          Arn: cluster?.clusterArn,
        },
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to update ECS cluster ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  private async deleteCluster(
    logicalId: string,
    physicalId: string,
    resourceType: string
  ): Promise<void> {
    this.logger.debug(`Deleting ECS cluster ${logicalId}: ${physicalId}`);
    const client = this.getClient();

    try {
      await client.send(new DeleteClusterCommand({ cluster: physicalId }));
      this.logger.debug(`Successfully deleted ECS cluster ${logicalId}`);
    } catch (error) {
      // Handle ClusterNotFoundException for idempotent delete
      if (this.isClusterNotFoundException(error)) {
        this.logger.debug(`ECS cluster ${physicalId} not found, skipping deletion`);
        return;
      }
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to delete ECS cluster ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  private async getClusterAttribute(physicalId: string, attributeName: string): Promise<unknown> {
    const client = this.getClient();
    const response = await client.send(new DescribeClustersCommand({ clusters: [physicalId] }));
    const cluster = response.clusters?.[0];
    if (!cluster) return undefined;

    switch (attributeName) {
      case 'Arn':
        return cluster.clusterArn;
      default:
        return undefined;
    }
  }

  // ─── AWS::ECS::TaskDefinition ───────────────────────────────────

  private async createTaskDefinition(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
  ): Promise<ResourceCreateResult> {
    this.logger.debug(`Creating ECS task definition ${logicalId}`);
    const client = this.getClient();

    try {
      const response = await client.send(
        new RegisterTaskDefinitionCommand({
          family:
            (properties['Family'] as string | undefined) ||
            generateResourceName(logicalId, { maxLength: 255 }),
          containerDefinitions: this.convertContainerDefinitions(
            properties['ContainerDefinitions'] as Array<Record<string, unknown>> | undefined
          ),
          cpu: properties['Cpu'] as string | undefined,
          memory: properties['Memory'] as string | undefined,
          networkMode: properties['NetworkMode'] as NetworkMode | undefined,
          requiresCompatibilities: properties['RequiresCompatibilities'] as
            | Compatibility[]
            | undefined,
          executionRoleArn: properties['ExecutionRoleArn'] as string | undefined,
          taskRoleArn: properties['TaskRoleArn'] as string | undefined,
          volumes: this.convertVolumes(
            properties['Volumes'] as Array<Record<string, unknown>> | undefined
          ),
          placementConstraints: properties['PlacementConstraints'] as
            | TaskDefinitionPlacementConstraint[]
            | undefined,
          tags: convertTags(
            properties['Tags'] as Array<{ Key: string; Value: string }> | undefined
          ),
          runtimePlatform: properties['RuntimePlatform'] as RuntimePlatform | undefined,
          proxyConfiguration: properties['ProxyConfiguration'] as ProxyConfiguration | undefined,
          pidMode: properties['PidMode'] as PidMode | undefined,
          ipcMode: properties['IpcMode'] as IpcMode | undefined,
          ephemeralStorage: properties['EphemeralStorage'] as { sizeInGiB: number } | undefined,
        })
      );

      const taskDef = response.taskDefinition;
      if (!taskDef || !taskDef.taskDefinitionArn) {
        throw new Error('RegisterTaskDefinition did not return task definition ARN');
      }

      this.logger.debug(
        `Successfully created ECS task definition ${logicalId}: ${taskDef.taskDefinitionArn}`
      );

      return {
        physicalId: taskDef.taskDefinitionArn,
        attributes: {
          TaskDefinitionArn: taskDef.taskDefinitionArn,
        },
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to create ECS task definition ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        undefined,
        cause
      );
    }
  }

  private async updateTaskDefinition(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
  ): Promise<ResourceUpdateResult> {
    this.logger.debug(`Updating ECS task definition ${logicalId}: ${physicalId}`);

    // TaskDefinition updates create a new revision (RegisterTaskDefinition)
    const result = await this.createTaskDefinition(logicalId, resourceType, properties);

    // Deregister old revision
    try {
      const client = this.getClient();
      await client.send(new DeregisterTaskDefinitionCommand({ taskDefinition: physicalId }));
      this.logger.debug(`Deregistered old task definition revision: ${physicalId}`);
    } catch (error) {
      this.logger.debug(
        `Failed to deregister old task definition ${physicalId}: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    return {
      physicalId: result.physicalId,
      wasReplaced: false,
      attributes: result.attributes ?? {},
    };
  }

  private async deleteTaskDefinition(
    logicalId: string,
    physicalId: string,
    resourceType: string
  ): Promise<void> {
    this.logger.debug(`Deleting ECS task definition ${logicalId}: ${physicalId}`);
    const client = this.getClient();

    try {
      await client.send(new DeregisterTaskDefinitionCommand({ taskDefinition: physicalId }));
      this.logger.debug(`Successfully deregistered ECS task definition ${logicalId}`);
    } catch (error) {
      // Handle not found for idempotent delete
      if (this.isNotFoundException(error)) {
        this.logger.debug(`ECS task definition ${physicalId} not found, skipping deletion`);
        return;
      }
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to delete ECS task definition ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  private async getTaskDefinitionAttribute(
    physicalId: string,
    attributeName: string
  ): Promise<unknown> {
    const client = this.getClient();
    const response = await client.send(
      new DescribeTaskDefinitionCommand({ taskDefinition: physicalId })
    );
    const taskDef = response.taskDefinition;
    if (!taskDef) return undefined;

    switch (attributeName) {
      case 'TaskDefinitionArn':
        return taskDef.taskDefinitionArn;
      default:
        return undefined;
    }
  }

  // ─── AWS::ECS::Service ──────────────────────────────────────────

  private async createService(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
  ): Promise<ResourceCreateResult> {
    this.logger.debug(`Creating ECS service ${logicalId}`);
    const client = this.getClient();

    const serviceName =
      (properties['ServiceName'] as string | undefined) ||
      generateResourceName(logicalId, { maxLength: 255 });

    try {
      const response = await client.send(
        new CreateServiceCommand({
          cluster: properties['Cluster'] as string | undefined,
          serviceName,
          taskDefinition: properties['TaskDefinition'] as string | undefined,
          desiredCount: properties['DesiredCount'] as number | undefined,
          launchType: properties['LaunchType'] as LaunchType | undefined,
          networkConfiguration: this.convertNetworkConfiguration(
            properties['NetworkConfiguration'] as Record<string, unknown> | undefined
          ),
          loadBalancers: properties['LoadBalancers'] as LoadBalancer[] | undefined,
          capacityProviderStrategy: properties['CapacityProviderStrategy'] as
            | CapacityProviderStrategyItem[]
            | undefined,
          deploymentConfiguration: properties['DeploymentConfiguration'] as
            | DeploymentConfiguration
            | undefined,
          placementConstraints: properties['PlacementConstraints'] as
            | PlacementConstraint[]
            | undefined,
          placementStrategy: properties['PlacementStrategy'] as PlacementStrategy[] | undefined,
          platformVersion: properties['PlatformVersion'] as string | undefined,
          healthCheckGracePeriodSeconds: properties['HealthCheckGracePeriodSeconds'] as
            | number
            | undefined,
          schedulingStrategy: properties['SchedulingStrategy'] as SchedulingStrategy | undefined,
          enableECSManagedTags: properties['EnableECSManagedTags'] as boolean | undefined,
          propagateTags: properties['PropagateTags'] as PropagateTags | undefined,
          enableExecuteCommand: properties['EnableExecuteCommand'] as boolean | undefined,
          serviceRegistries: properties['ServiceRegistries'] as ServiceRegistry[] | undefined,
          tags: convertTags(
            properties['Tags'] as Array<{ Key: string; Value: string }> | undefined
          ),
        })
      );

      const service = response.service;
      if (!service || !service.serviceArn) {
        throw new Error('CreateService did not return service ARN');
      }

      this.logger.debug(`Successfully created ECS service ${logicalId}: ${service.serviceArn}`);

      return {
        physicalId: service.serviceArn,
        attributes: {
          ServiceArn: service.serviceArn,
          Name: service.serviceName,
        },
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to create ECS service ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        serviceName,
        cause
      );
    }
  }

  private async updateService(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>
  ): Promise<ResourceUpdateResult> {
    this.logger.debug(`Updating ECS service ${logicalId}: ${physicalId}`);
    const client = this.getClient();

    // ServiceName is immutable - if changed, requires replacement
    const newServiceName = properties['ServiceName'] as string | undefined;
    const oldServiceName = previousProperties['ServiceName'] as string | undefined;
    if (newServiceName && oldServiceName && newServiceName !== oldServiceName) {
      throw new ProvisioningError(
        `Cannot update ServiceName for ECS service ${logicalId} (immutable property, requires replacement)`,
        resourceType,
        logicalId,
        physicalId
      );
    }

    try {
      const response = await client.send(
        new UpdateServiceCommand({
          cluster: properties['Cluster'] as string | undefined,
          service: physicalId,
          taskDefinition: properties['TaskDefinition'] as string | undefined,
          desiredCount: properties['DesiredCount'] as number | undefined,
          networkConfiguration: this.convertNetworkConfiguration(
            properties['NetworkConfiguration'] as Record<string, unknown> | undefined
          ),
          capacityProviderStrategy: properties['CapacityProviderStrategy'] as
            | CapacityProviderStrategyItem[]
            | undefined,
          deploymentConfiguration: properties['DeploymentConfiguration'] as
            | DeploymentConfiguration
            | undefined,
          placementConstraints: properties['PlacementConstraints'] as
            | PlacementConstraint[]
            | undefined,
          placementStrategy: properties['PlacementStrategy'] as PlacementStrategy[] | undefined,
          platformVersion: properties['PlatformVersion'] as string | undefined,
          healthCheckGracePeriodSeconds: properties['HealthCheckGracePeriodSeconds'] as
            | number
            | undefined,
          enableExecuteCommand: properties['EnableExecuteCommand'] as boolean | undefined,
        })
      );

      const service = response.service;

      return {
        physicalId,
        wasReplaced: false,
        attributes: {
          ServiceArn: service?.serviceArn || physicalId,
          Name: service?.serviceName,
        },
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to update ECS service ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  private async deleteService(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties?: Record<string, unknown>
  ): Promise<void> {
    this.logger.debug(`Deleting ECS service ${logicalId}: ${physicalId}`);
    const client = this.getClient();

    const cluster = properties?.['Cluster'] as string | undefined;

    try {
      // First scale down to 0
      try {
        await client.send(
          new UpdateServiceCommand({
            cluster,
            service: physicalId,
            desiredCount: 0,
          })
        );
        this.logger.debug(`Scaled down ECS service ${physicalId} to 0`);
      } catch (error) {
        // If service not found during scale down, it's already gone
        if (this.isServiceNotFoundException(error)) {
          this.logger.debug(
            `ECS service ${physicalId} not found during scale down, skipping deletion`
          );
          return;
        }
        throw error;
      }

      // Then force delete
      await client.send(
        new DeleteServiceCommand({
          cluster,
          service: physicalId,
          force: true,
        })
      );
      this.logger.debug(`Successfully deleted ECS service ${logicalId}`);
    } catch (error) {
      if (this.isServiceNotFoundException(error)) {
        this.logger.debug(`ECS service ${physicalId} not found, skipping deletion`);
        return;
      }
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to delete ECS service ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  private async getServiceAttribute(physicalId: string, attributeName: string): Promise<unknown> {
    const client = this.getClient();

    // Extract cluster from service ARN if possible
    const response = await client.send(
      new DescribeServicesCommand({
        services: [physicalId],
      })
    );
    const service = response.services?.[0];
    if (!service) return undefined;

    switch (attributeName) {
      case 'ServiceArn':
        return service.serviceArn;
      case 'Name':
        return service.serviceName;
      default:
        return undefined;
    }
  }

  // ─── Helpers ────────────────────────────────────────────────────

  /**
   * Convert CFn ContainerDefinitions to ECS SDK format.
   * CFn uses PascalCase, ECS SDK uses camelCase.
   */
  private convertContainerDefinitions(
    defs?: Array<Record<string, unknown>>
  ): ContainerDefinition[] | undefined {
    if (!defs) return undefined;

    return defs.map((def) => ({
      name: def['Name'] as string,
      image: def['Image'] as string,
      cpu: def['Cpu'] as number | undefined,
      memory: def['Memory'] as number | undefined,
      memoryReservation: def['MemoryReservation'] as number | undefined,
      essential: def['Essential'] as boolean | undefined,
      command: def['Command'] as string[] | undefined,
      entryPoint: def['EntryPoint'] as string[] | undefined,
      environment: def['Environment'] as KeyValuePair[] | undefined,
      environmentFiles: def['EnvironmentFiles'] as EnvironmentFile[] | undefined,
      secrets: def['Secrets'] as Secret[] | undefined,
      portMappings: this.convertPortMappings(
        def['PortMappings'] as Array<Record<string, unknown>> | undefined
      ),
      mountPoints: def['MountPoints'] as MountPoint[] | undefined,
      volumesFrom: def['VolumesFrom'] as VolumeFrom[] | undefined,
      dependsOn: def['DependsOn'] as ContainerDependency[] | undefined,
      links: def['Links'] as string[] | undefined,
      workingDirectory: def['WorkingDirectory'] as string | undefined,
      disableNetworking: def['DisableNetworking'] as boolean | undefined,
      privileged: def['Privileged'] as boolean | undefined,
      readonlyRootFilesystem: def['ReadonlyRootFilesystem'] as boolean | undefined,
      user: def['User'] as string | undefined,
      ulimits: def['Ulimits'] as Ulimit[] | undefined,
      logConfiguration: this.convertLogConfiguration(
        def['LogConfiguration'] as Record<string, unknown> | undefined
      ),
      healthCheck: this.convertHealthCheck(
        def['HealthCheck'] as Record<string, unknown> | undefined
      ),
      linuxParameters: def['LinuxParameters'] as Record<string, unknown> | undefined,
      dockerLabels: def['DockerLabels'] as Record<string, string> | undefined,
      startTimeout: def['StartTimeout'] as number | undefined,
      stopTimeout: def['StopTimeout'] as number | undefined,
      interactive: def['Interactive'] as boolean | undefined,
      pseudoTerminal: def['PseudoTerminal'] as boolean | undefined,
    }));
  }

  /**
   * Convert CFn PortMappings to ECS SDK format
   */
  private convertPortMappings(
    mappings?: Array<Record<string, unknown>>
  ): PortMapping[] | undefined {
    if (!mappings) return undefined;

    return mappings.map((m) => ({
      containerPort: m['ContainerPort'] as number | undefined,
      hostPort: m['HostPort'] as number | undefined,
      protocol: m['Protocol'] as TransportProtocol | undefined,
      appProtocol: m['AppProtocol'] as ApplicationProtocol | undefined,
      name: m['Name'] as string | undefined,
    }));
  }

  /**
   * Convert CFn LogConfiguration to ECS SDK format
   */
  private convertLogConfiguration(config?: Record<string, unknown>): LogConfiguration | undefined {
    if (!config) return undefined;

    return {
      logDriver: config['LogDriver'] as LogDriver,
      options: config['Options'] as Record<string, string> | undefined,
      secretOptions: config['SecretOptions'] as Secret[] | undefined,
    };
  }

  /**
   * Convert CFn HealthCheck to ECS SDK format
   */
  private convertHealthCheck(check?: Record<string, unknown>): HealthCheck | undefined {
    if (!check) return undefined;

    return {
      command: check['Command'] as string[],
      interval: check['Interval'] as number | undefined,
      timeout: check['Timeout'] as number | undefined,
      retries: check['Retries'] as number | undefined,
      startPeriod: check['StartPeriod'] as number | undefined,
    };
  }

  /**
   * Convert CFn Volumes to ECS SDK format
   */
  private convertVolumes(volumes?: Array<Record<string, unknown>>): Volume[] | undefined {
    if (!volumes) return undefined;

    return volumes.map((v) => ({
      name: v['Name'] as string,
      host: v['Host'] as { sourcePath?: string } | undefined,
      efsVolumeConfiguration: v['EFSVolumeConfiguration'] as EFSVolumeConfiguration | undefined,
    }));
  }

  /**
   * Convert CFn NetworkConfiguration to ECS SDK format
   */
  private convertNetworkConfiguration(
    config?: Record<string, unknown>
  ): NetworkConfiguration | undefined {
    if (!config) return undefined;

    const awsvpcConfig = config['AwsvpcConfiguration'] as Record<string, unknown> | undefined;
    if (!awsvpcConfig) return undefined;

    return {
      awsvpcConfiguration: {
        subnets: awsvpcConfig['Subnets'] as string[],
        securityGroups: awsvpcConfig['SecurityGroups'] as string[] | undefined,
        assignPublicIp: awsvpcConfig['AssignPublicIp'] as AssignPublicIp | undefined,
      },
    };
  }

  /**
   * Check if error is ClusterNotFoundException
   */
  private isClusterNotFoundException(error: unknown): boolean {
    if (error instanceof Error) {
      return (
        error.name === 'ClusterNotFoundException' || error.message.includes('Cluster not found')
      );
    }
    return false;
  }

  /**
   * Check if error is a not-found error (for task definitions)
   */
  private isNotFoundException(error: unknown): boolean {
    if (error instanceof Error) {
      return (
        error.name === 'ClientException' ||
        error.name === 'InvalidParameterException' ||
        error.message.includes('not found') ||
        error.message.includes('does not exist')
      );
    }
    return false;
  }

  /**
   * Check if error is ServiceNotFoundException
   */
  private isServiceNotFoundException(error: unknown): boolean {
    if (error instanceof Error) {
      return (
        error.name === 'ServiceNotFoundException' ||
        error.name === 'ServiceNotActiveException' ||
        error.message.includes('service not found') ||
        error.message.includes('Service not found')
      );
    }
    return false;
  }
}
