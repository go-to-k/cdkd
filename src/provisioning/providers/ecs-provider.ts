import {
  ECSClient,
  CreateClusterCommand,
  DeleteClusterCommand,
  DescribeClustersCommand,
  PutClusterCapacityProvidersCommand,
  UpdateClusterCommand,
  RegisterTaskDefinitionCommand,
  DeregisterTaskDefinitionCommand,
  DescribeTaskDefinitionCommand,
  CreateServiceCommand,
  UpdateServiceCommand,
  DeleteServiceCommand,
  DescribeServicesCommand,
  waitUntilServicesStable,
  TagResourceCommand,
  UntagResourceCommand,
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
  type AdvancedConfiguration,
  type DeploymentConfiguration,
  type CapacityProviderStrategyItem,
  type PlacementConstraint,
  type PlacementStrategy,
  type ServiceRegistry,
  type LinuxParameters,
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
  type S3FilesVolumeConfiguration,
  type EFSAuthorizationConfig,
  type DockerVolumeConfiguration,
  type FSxWindowsFileServerVolumeConfiguration,
  type FSxWindowsFileServerAuthorizationConfig,
  type HostVolumeProperties,
  type Scope,
  type EFSTransitEncryption,
  type EFSAuthorizationConfigIAM,
  type AssignPublicIp,
  type ContainerCondition,
  type EnvironmentFileType,
  type UlimitName,
  type RepositoryCredentials,
  type FirelensConfiguration,
  type FirelensConfigurationType,
  type ResourceRequirement,
  type SystemControl,
  type HostEntry,
  type ContainerRestartPolicy,
  type VersionConsistency,
  type AvailabilityZoneRebalancing,
  type DeploymentController,
  type ServiceConnectConfiguration,
  type ServiceVolumeConfiguration,
  type VpcLatticeConfiguration,
  type MonitoringConfiguration,
} from '@aws-sdk/client-ecs';
import { getLogger } from '../../utils/logger.js';
import { ProvisioningError, ResourceUpdateNotSupportedError } from '../../utils/error-handler.js';
import { generateResourceName } from '../resource-name.js';
import { assertRegionMatch, type DeleteContext } from '../region-check.js';
import { normalizeAwsTagsToCfn, resolveExplicitPhysicalId } from '../import-helpers.js';
import { pascalToCamelCaseKeys, camelToPascalCaseKeys } from './agentcore-case-convert.js';
import type {
  ResourceProvider,
  ResourceCreateResult,
  ResourceUpdateResult,
  ResourceImportInput,
  ResourceImportResult,
} from '../../types/resource.js';
import { clearOnUpdateRemoval } from '../update-removal.js';
import { readConfigString } from '../config-shape.js';
import { resolvedResourceTimeoutMs } from '../resource-timeout-registry.js';

/**
 * Convert CFn Tags (Array<{Key, Value}>) to ECS Tags (Array<{key, value}>)
 */
function convertTags(tags?: Array<{ Key: string; Value: string }>): Tag[] | undefined {
  if (!tags || tags.length === 0) return undefined;
  return tags.map((t) => ({ key: t.Key, value: t.Value }));
}

/**
 * `DeploymentConfiguration.LifecycleHooks[].HookDetails` is a free-form JSON
 * document (SDK `__DocumentType`) whose inner keys are user-supplied hook
 * payload fields, NOT CloudFormation property names. The recursive
 * PascalCase->camelCase key flip must therefore copy its value subtree
 * verbatim (the `HookDetails` key itself is still flipped to `hookDetails`).
 * See `convertDeploymentConfiguration`.
 */
const DEPLOYMENT_CONFIG_PRESERVE_KEYS: ReadonlySet<string> = new Set(['HookDetails']);

/**
 * Read-side (camelCase -> PascalCase) counterpart of
 * `DEPLOYMENT_CONFIG_PRESERVE_KEYS` for `readCurrentState` (issue #1165 /
 * #1167). The SDK response carries the free-form document under the camelCase
 * key `hookDetails`, so the reverse key-flip must copy its value subtree
 * verbatim (the key itself is still flipped to `HookDetails`).
 */
const DEPLOYMENT_CONFIG_PRESERVE_KEYS_CAMEL: ReadonlySet<string> = new Set(['hookDetails']);

/**
 * `ServiceConnectConfiguration.LogConfiguration.Options` is a free-form
 * log-driver option map (e.g. `awslogs-group`) whose keys are user data, NOT
 * CloudFormation property names — copy the value subtree verbatim while the
 * `Options` key itself still flips to `options` (issue #609; same rule as
 * `DEPLOYMENT_CONFIG_PRESERVE_KEYS` above and the container-level
 * `LogConfiguration.Options` handling in `convertLogConfiguration`).
 */
const SERVICE_CONNECT_PRESERVE_KEYS: ReadonlySet<string> = new Set(['Options']);

/**
 * Derive the cluster name from a long-format ECS Service ARN
 * (`arn:<partition>:ecs:<region>:<account>:service/<clusterName>/<serviceName>`)
 * so `DescribeServices` can be scoped to the right cluster (issue #1170).
 * Returns `undefined` for the legacy short-format ARN
 * (`.../service/<serviceName>`, which does not encode a cluster) or any input
 * that does not match the ARN shape — the caller then falls back to the default
 * cluster, matching what the short-format ARN implies.
 */
function clusterNameFromServiceArn(arn: string): string | undefined {
  // ARN = arn:<partition>:<service>:<region>:<account>:<resource>
  const resource = arn.split(':')[5];
  if (!resource) return undefined;
  // resource = service/<clusterName>/<serviceName> (long) OR service/<serviceName> (short)
  const segments = resource.split('/');
  if (segments[0] !== 'service') return undefined;
  return segments.length >= 3 ? segments[1] : undefined;
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
  private readonly providerRegion = process.env['AWS_REGION'];
  private logger = getLogger().child('ECSProvider');

  handledProperties = new Map<string, ReadonlySet<string>>([
    [
      'AWS::ECS::Cluster',
      new Set([
        'ClusterName',
        'CapacityProviders',
        'DefaultCapacityProviderStrategy',
        'Configuration',
        'ClusterSettings',
        'ServiceConnectDefaults',
        'Tags',
      ]),
    ],
    [
      'AWS::ECS::TaskDefinition',
      new Set([
        'Family',
        'ContainerDefinitions',
        'Cpu',
        'Memory',
        'NetworkMode',
        'RequiresCompatibilities',
        'ExecutionRoleArn',
        'TaskRoleArn',
        'Volumes',
        'PlacementConstraints',
        'RuntimePlatform',
        'ProxyConfiguration',
        'PidMode',
        'IpcMode',
        'EphemeralStorage',
        'EnableFaultInjection',
        'Tags',
      ]),
    ],
    [
      'AWS::ECS::Service',
      new Set([
        'Cluster',
        'ServiceName',
        'TaskDefinition',
        'DesiredCount',
        'LaunchType',
        'NetworkConfiguration',
        'LoadBalancers',
        'CapacityProviderStrategy',
        'DeploymentConfiguration',
        'PlacementConstraints',
        'PlacementStrategies',
        'PlatformVersion',
        'HealthCheckGracePeriodSeconds',
        'SchedulingStrategy',
        'EnableECSManagedTags',
        'PropagateTags',
        'EnableExecuteCommand',
        'ServiceRegistries',
        'Tags',
        // issue #609 backfill — the previously silent-dropped Service members.
        'AvailabilityZoneRebalancing',
        'DeploymentController',
        'ForceNewDeployment',
        'Monitoring',
        'Role',
        'ServiceConnectConfiguration',
        'VolumeConfigurations',
        'VpcLatticeConfigurations',
      ]),
    ],
  ]);

  unhandledByDesign = new Map<string, ReadonlyMap<string, string>>([
    [
      'AWS::ECS::TaskDefinition',
      new Map<string, string>([
        [
          'InferenceAccelerators',
          'AWS Elastic Inference end-of-life 2024-04; use AWS Inferentia / Trainium accelerator instance families instead',
        ],
      ]),
    ],
  ]);

  private getClient(): ECSClient {
    if (!this.ecsClient) {
      this.ecsClient = new ECSClient(this.providerRegion ? { region: this.providerRegion } : {});
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
        return this.updateCluster(
          logicalId,
          physicalId,
          resourceType,
          properties,
          previousProperties
        );
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
    properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void> {
    switch (resourceType) {
      case 'AWS::ECS::Cluster':
        return this.deleteCluster(logicalId, physicalId, resourceType, context);
      case 'AWS::ECS::TaskDefinition':
        return this.deleteTaskDefinition(logicalId, physicalId, resourceType, context);
      case 'AWS::ECS::Service':
        return this.deleteService(logicalId, physicalId, resourceType, properties, context);
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
          defaultCapacityProviderStrategy: this.convertCapacityProviderStrategy(
            properties['DefaultCapacityProviderStrategy'] as
              | Array<Record<string, unknown>>
              | undefined
          ),
          configuration: this.convertClusterConfiguration(
            properties['Configuration'] as Record<string, unknown> | undefined
          ),
          settings: properties['ClusterSettings']
            ? (properties['ClusterSettings'] as Array<Record<string, unknown>>).map((s) => ({
                name: (s['Name'] || s['name']) as string as 'containerInsights',
                value: ((s['Value'] || s['value']) as string) ?? undefined,
              }))
            : undefined,
          serviceConnectDefaults: properties['ServiceConnectDefaults']
            ? {
                namespace: (properties['ServiceConnectDefaults'] as Record<string, unknown>)[
                  'Namespace'
                ] as string,
              }
            : undefined,
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
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>
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
              this.convertCapacityProviderStrategy(
                properties['DefaultCapacityProviderStrategy'] as
                  | Array<Record<string, unknown>>
                  | undefined
              ) || [],
          })
        );
        this.logger.debug(`Updated capacity providers for ECS cluster ${physicalId}`);
      }

      // Apply ClusterSettings / Configuration / ServiceConnectDefaults via
      // UpdateClusterCommand when any changed. Issue a single call so AWS
      // evaluates the new shape atomically (avoids partial-apply on a
      // per-field call). Skipped entirely when nothing differs so a
      // no-drift round-trip stays mutation-free against AWS.
      const settingsChanged =
        JSON.stringify(previousProperties['ClusterSettings'] ?? null) !==
        JSON.stringify(properties['ClusterSettings'] ?? null);
      const configChanged =
        JSON.stringify(previousProperties['Configuration'] ?? null) !==
        JSON.stringify(properties['Configuration'] ?? null);
      const svcConnectChanged =
        JSON.stringify(previousProperties['ServiceConnectDefaults'] ?? null) !==
        JSON.stringify(properties['ServiceConnectDefaults'] ?? null);

      if (settingsChanged || configChanged || svcConnectChanged) {
        const settingsInput = settingsChanged
          ? (
              (properties['ClusterSettings'] as Array<Record<string, unknown>> | undefined) ?? []
            ).map((s) => ({
              name: (s['Name'] || s['name']) as 'containerInsights',
              value: ((s['Value'] || s['value']) as string) ?? undefined,
            }))
          : undefined;

        // AWS UpdateCluster accepts `serviceConnectDefaults: { namespace: '' }`
        // as the "clear the cluster's default namespace" sentinel (per
        // ClusterServiceConnectDefaultsRequest docs). When the user removes
        // the property from their template, pass that sentinel so AWS
        // actually clears the value instead of treating "absent" as no-op.
        const svcConnectInput = svcConnectChanged
          ? properties['ServiceConnectDefaults']
            ? {
                namespace: (properties['ServiceConnectDefaults'] as Record<string, unknown>)[
                  'Namespace'
                ] as string,
              }
            : { namespace: '' }
          : undefined;

        await client.send(
          new UpdateClusterCommand({
            cluster: physicalId,
            ...(settingsChanged && { settings: settingsInput }),
            ...(configChanged && {
              configuration: this.convertClusterConfiguration(
                properties['Configuration'] as Record<string, unknown> | undefined
              ),
            }),
            ...(svcConnectChanged && { serviceConnectDefaults: svcConnectInput }),
          })
        );
        this.logger.debug(
          `Updated ECS cluster ${physicalId} (settings=${settingsChanged}, config=${configChanged}, svcConnect=${svcConnectChanged})`
        );
      }

      // Describe cluster to get current ARN
      const describeResponse = await client.send(
        new DescribeClustersCommand({ clusters: [physicalId] })
      );
      const cluster = describeResponse.clusters?.[0];

      // Apply tag diff. ECS uses lowercase camelCase tags.
      if (cluster?.clusterArn) {
        await this.applyTagDiff(
          cluster.clusterArn,
          previousProperties['Tags'] as Array<{ Key?: string; Value?: string }> | undefined,
          properties['Tags'] as Array<{ Key?: string; Value?: string }> | undefined
        );
      }

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
    resourceType: string,
    context?: DeleteContext
  ): Promise<void> {
    this.logger.debug(`Deleting ECS cluster ${logicalId}: ${physicalId}`);
    const client = this.getClient();

    try {
      await client.send(new DeleteClusterCommand({ cluster: physicalId }));
      this.logger.debug(`Successfully deleted ECS cluster ${logicalId}`);
    } catch (error) {
      // Handle ClusterNotFoundException for idempotent delete
      if (this.isClusterNotFoundException(error)) {
        const clientRegion = await client.config.region();
        assertRegionMatch(
          clientRegion,
          context?.expectedRegion,
          resourceType,
          logicalId,
          physicalId
        );
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
          placementConstraints: this.convertTaskDefinitionPlacementConstraints(
            properties['PlacementConstraints'] as Array<Record<string, unknown>> | undefined
          ),
          tags: convertTags(
            properties['Tags'] as Array<{ Key: string; Value: string }> | undefined
          ),
          runtimePlatform: this.convertRuntimePlatform(
            properties['RuntimePlatform'] as Record<string, unknown> | undefined
          ),
          proxyConfiguration: this.convertProxyConfiguration(
            properties['ProxyConfiguration'] as Record<string, unknown> | undefined
          ),
          pidMode: properties['PidMode'] as PidMode | undefined,
          ipcMode: properties['IpcMode'] as IpcMode | undefined,
          ephemeralStorage: this.convertEphemeralStorage(
            properties['EphemeralStorage'] as Record<string, unknown> | undefined
          ),
          enableFaultInjection: properties['EnableFaultInjection'] as boolean | undefined,
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
    _physicalId: string,
    _resourceType: string,
    _properties: Record<string, unknown>
  ): Promise<ResourceUpdateResult> {
    // ECS TaskDefinitions are immutable revisioned resources: every property
    // change creates a new revision via RegisterTaskDefinition, and the new
    // revision's `taskDefinitionArn` differs from the cdkd-state physicalId.
    // Routing this through `cdkd drift --revert` would silently swap state's
    // physicalId for a freshly-registered revision (and deregister the
    // previous one) without the user's awareness — surface a clear error
    // instead. The deploy code path uses Replace (CREATE→DELETE) for property
    // changes, which is the correct semantics here.
    return Promise.reject(
      new ResourceUpdateNotSupportedError(
        'AWS::ECS::TaskDefinition',
        logicalId,
        'ECS TaskDefinition revisions are immutable on AWS — there is no UpdateTaskDefinition API; every change registers a new revision via RegisterTaskDefinition. Re-deploy with cdkd deploy --replace, or destroy + redeploy the stack.'
      )
    );
  }

  private async deleteTaskDefinition(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    context?: DeleteContext
  ): Promise<void> {
    this.logger.debug(`Deleting ECS task definition ${logicalId}: ${physicalId}`);
    const client = this.getClient();

    try {
      await client.send(new DeregisterTaskDefinitionCommand({ taskDefinition: physicalId }));
      this.logger.debug(`Successfully deregistered ECS task definition ${logicalId}`);
    } catch (error) {
      // Handle not found for idempotent delete
      if (this.isNotFoundException(error)) {
        const clientRegion = await client.config.region();
        assertRegionMatch(
          clientRegion,
          context?.expectedRegion,
          resourceType,
          logicalId,
          physicalId
        );
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
          loadBalancers: this.convertLoadBalancers(
            properties['LoadBalancers'] as Array<Record<string, unknown>> | undefined
          ),
          capacityProviderStrategy: this.convertCapacityProviderStrategy(
            properties['CapacityProviderStrategy'] as Array<Record<string, unknown>> | undefined
          ),
          deploymentConfiguration: this.convertDeploymentConfiguration(
            properties['DeploymentConfiguration'] as Record<string, unknown> | undefined
          ),
          placementConstraints: this.convertPlacementConstraints(
            properties['PlacementConstraints'] as Array<Record<string, unknown>> | undefined
          ),
          placementStrategy: this.convertPlacementStrategies(
            (properties['PlacementStrategies'] ?? properties['PlacementStrategy']) as
              | Array<Record<string, unknown>>
              | undefined
          ),
          platformVersion: properties['PlatformVersion'] as string | undefined,
          healthCheckGracePeriodSeconds: properties['HealthCheckGracePeriodSeconds'] as
            | number
            | undefined,
          schedulingStrategy: properties['SchedulingStrategy'] as SchedulingStrategy | undefined,
          enableECSManagedTags: properties['EnableECSManagedTags'] as boolean | undefined,
          propagateTags: properties['PropagateTags'] as PropagateTags | undefined,
          enableExecuteCommand: properties['EnableExecuteCommand'] as boolean | undefined,
          serviceRegistries: this.convertServiceRegistries(
            properties['ServiceRegistries'] as Array<Record<string, unknown>> | undefined
          ),
          tags: convertTags(
            properties['Tags'] as Array<{ Key: string; Value: string }> | undefined
          ),
          // issue #609 backfill — previously silent-dropped Service members.
          // `ForceNewDeployment` is deliberately NOT mapped here: it is a
          // CFn-only rollout trigger with no CreateService counterpart (the
          // SDK's `forceNewDeployment` boolean exists only on UpdateService),
          // so it is a create-path no-op — see `resolveForceNewDeployment`.
          availabilityZoneRebalancing: properties['AvailabilityZoneRebalancing'] as
            | AvailabilityZoneRebalancing
            | undefined,
          deploymentController: this.convertDeploymentController(
            properties['DeploymentController'] as Record<string, unknown> | undefined
          ),
          // `Role` is the legacy classic-ELB service role override — a real
          // create-only CFn property (createOnlyProperties in the registry
          // schema), passed through verbatim; a change classifies as
          // replacement via the create-only fallback in the diff layer.
          role: properties['Role'] as string | undefined,
          serviceConnectConfiguration: this.convertServiceConnectConfiguration(
            properties['ServiceConnectConfiguration'] as Record<string, unknown> | undefined
          ),
          volumeConfigurations: this.convertServiceVolumeConfigurations(
            properties['VolumeConfigurations'] as Array<Record<string, unknown>> | undefined
          ),
          vpcLatticeConfigurations: this.convertVpcLatticeConfigurations(
            properties['VpcLatticeConfigurations'] as Array<Record<string, unknown>> | undefined
          ),
          monitoring: this.convertMonitoringConfiguration(
            properties['Monitoring'] as Record<string, unknown> | undefined
          ),
        })
      );

      const service = response.service;
      if (!service || !service.serviceArn) {
        throw new Error('CreateService did not return service ARN');
      }

      this.logger.debug(`Successfully created ECS service ${logicalId}: ${service.serviceArn}`);

      // Under --full-wait a steady-state timeout has to fail the resource,
      // which means throwing AFTER AWS has already created the service. The
      // throw aborts before the success-return, so cdkd state would not carry
      // the service while AWS does, and the next deploy's CreateService would
      // collide on the name. Clean up best-effort first, mirroring the
      // partial-create handling in the ELBv2 / EC2 Instance providers.
      // `force: true` deletes without a separate scale-to-0 round trip.
      // The cleanup NARROWS the collision window rather than closing it:
      // DeleteService returns with the service in DRAINING, which outlives
      // the call, so an immediate retry can still hit a name conflict until
      // draining completes (issue #1291 item 4).
      //
      // The UPDATE path deliberately does NOT delete on the same timeout,
      // and the asymmetry is about STATE OWNERSHIP, not about whether AWS
      // holds the service. Both cases end with AWS holding a service that is
      // not steady, so "AWS has it" alone cannot explain the difference:
      //
      //   - CREATE: cdkd has no state record and, because the throw skips the
      //     success-return, never will. The service is unreachable from cdkd
      //     forever after — an orphan that also blocks the retry, since the
      //     next CreateService hits the name. Deleting it is the only way back
      //     to a consistent pair.
      //   - UPDATE: the state record already exists and keeps pointing at this
      //     same serviceArn. The failure leaves a live, previously-working
      //     service mid-rollout; cdkd can still see it, `cdkd destroy` still
      //     removes it, and the next deploy retries UpdateService against it.
      //     Deleting there would DESTROY a running service (dropping every
      //     task serving traffic) to react to a wait that timed out — turning
      //     a recoverable stall into an outage.
      //
      // So the rule is "delete only what cdkd is about to lose track of",
      // which is exactly the create case.
      try {
        await this.settleService(
          logicalId,
          service.serviceName ?? service.serviceArn,
          properties['Cluster'] as string | undefined
        );
      } catch (waitError) {
        // Include --cluster: a service in a non-default cluster cannot be
        // addressed without it, and the ARN alone is not documented to imply
        // the cluster. Matches the INFO hint's shape.
        const cleanupCluster = properties['Cluster'] as string | undefined;
        const clusterArg = cleanupCluster ? ` --cluster ${cleanupCluster}` : '';
        try {
          await client.send(
            new DeleteServiceCommand({
              cluster: properties['Cluster'] as string | undefined,
              service: service.serviceArn,
              force: true,
            })
          );
          // warn, not debug: the dominant --full-wait failure is a crashing
          // container, and this delete removes the service the user would
          // reach for first when asking "why". Say where the evidence
          // still lives (issue #1291 item 2).
          this.logger.warn(
            `Deleted partially-created ECS service ${logicalId} (${service.serviceArn}) after the steady-state wait failed, so the next deploy's CreateService does not collide on the name. Its stopped tasks remain inspectable for about an hour: aws ecs list-tasks${clusterArg} --desired-status STOPPED`
          );
        } catch (cleanupError) {
          this.logger.warn(
            `Failed to clean up partially-created ECS service ${logicalId} (${service.serviceArn}): ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}. Manual deletion may be required before the next deploy: aws ecs delete-service${clusterArg} --service ${service.serviceArn} --force`
          );
        }
        // The SDK waiter's bare "Waiter has timed out" explains nothing.
        // Carry the diagnosis path in the thrown message; the wrapping
        // ProvisioningError in the outer catch preserves it verbatim, and
        // the cause chain keeps the original waiter error reachable for
        // `cdkd events` metadata extraction.
        throw new Error(
          `ECS service ${logicalId} did not reach steady state under --full-wait: ${waitError instanceof Error ? waitError.message : String(waitError)}. Inspect why its tasks stopped (stopped tasks stay visible for about an hour): aws ecs list-tasks${clusterArg} --desired-status STOPPED, then aws ecs describe-tasks${clusterArg} --tasks <task-arn> --query 'tasks[].[stoppedReason,containers[].reason]'`,
          { cause: waitError }
        );
      }

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

  /**
   * Settle an ECS Service according to the run's wait mode.
   *
   * cdkd does NOT wait for steady state by default (issue #1275). The three
   * engines genuinely disagree on what "done" means for a Service:
   * CloudFormation waits for steady state, Terraform's `aws_ecs_service`
   * defaults `wait_for_steady_state` to false, and nothing downstream needs
   * the service to be running (`Fn::GetAtt` yields Name / ServiceArn, both
   * valid the instant CreateService returns). cdkd takes the fast side and
   * documents the divergence.
   *
   * There is deliberately no health probe on the default path. Right after
   * CreateService a healthy service and a doomed one are indistinguishable
   * (`ACTIVE`, `runningCount: 0`, `rolloutState: IN_PROGRESS`); a circuit
   * breaker failure surfaces tens of seconds to minutes later. A one-shot
   * check would warn on every deploy AND imply a guarantee ("no warning, so
   * the rollout was fine") it cannot support. The INFO line instead hands
   * over the exact command that CAN answer the question.
   */
  private async settleService(
    logicalId: string,
    serviceRef: string,
    cluster: string | undefined
  ): Promise<void> {
    if (process.env['CDKD_FULL_WAIT'] === 'true') {
      this.logger.debug(`Waiting for ECS service ${logicalId} to reach steady state...`);
      // 600s matches Terraform's `aws_ecs_service` default create timeout. An
      // explicit `--resource-timeout` (per-type or global) lifts the cap so
      // the inner waiter can never undercut the outer per-resource deadline
      // the same flag raises (issue #1280) — but never lowers it below the
      // 600s floor.
      const maxWaitTime = Math.max(
        600,
        (resolvedResourceTimeoutMs('AWS::ECS::Service') ?? 0) / 1000
      );
      await waitUntilServicesStable(
        // minDelay/maxDelay override the AWS SDK defaults (15s / 120s) per the
        // #1177 poll-cap sweep.
        { client: this.getClient(), maxWaitTime, minDelay: 5, maxDelay: 10 },
        { cluster, services: [serviceRef] }
      );
      this.logger.debug(`ECS service ${logicalId} reached steady state`);
      return;
    }

    const clusterArg = cluster ? ` --cluster ${cluster}` : '';
    // Mention --full-wait only when the invoking COMMAND actually declares
    // it (cdkd deploy sets CDKD_WAIT_FLAGS_AVAILABLE; `cdkd drift --revert`
    // reaches this same code through provider.update and does NOT — the
    // flag does not exist there, so advertising it would tell the user to
    // pass an option the command rejects (issue #1291 item 1).
    const fullWaitHint =
      process.env['CDKD_WAIT_FLAGS_AVAILABLE'] === 'true' ? '; pass --full-wait to wait' : '';
    this.logger.info(
      `ECS service ${logicalId} accepted (not waiting for steady state${fullWaitHint}). ` +
        `To wait manually: aws ecs wait services-stable${clusterArg} --services ${serviceRef}`
    );
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

    // loadBalancers / serviceRegistries are only accepted by UpdateService when
    // the service uses the ECS rolling-update deployment controller. For
    // CODE_DEPLOY (blue/green) and EXTERNAL controllers, AWS rejects these
    // parameters (blue/green updates them via a new CodeDeploy deployment;
    // EXTERNAL via a new task set) — see the AWS UpdateService API docs. The
    // deployment controller defaults to ECS when unspecified. enableECSManagedTags
    // / propagateTags are accepted under ALL three controllers, so they are
    // mapped unconditionally.
    // Wrapped: this point in `updateService` has no enclosing catch, so the
    // helper's plain Error would otherwise escape untyped into the deploy
    // engine's retry loop instead of surfacing as a ProvisioningError.
    let deploymentControllerType: string;
    try {
      deploymentControllerType = readConfigString(
        properties['DeploymentController'],
        'Type',
        'ECS',
        'AWS::ECS::Service DeploymentController'
      );
    } catch (error) {
      throw new ProvisioningError(
        error instanceof Error ? error.message : String(error),
        resourceType,
        logicalId,
        physicalId,
        error instanceof Error ? error : undefined
      );
    }
    const isEcsController = deploymentControllerType === 'ECS';

    // Only send loadBalancers / serviceRegistries when they actually changed, so
    // a no-drift update stays mutation-free and doesn't trigger a spurious new
    // deployment. Removal-from-template is sent as an empty list (the AWS-
    // documented "clear" sentinel), not an omitted field (which AWS treats as
    // "leave unchanged"). Both fields are gated on the ECS rolling controller.
    const loadBalancersChanged =
      JSON.stringify(previousProperties['LoadBalancers'] ?? null) !==
      JSON.stringify(properties['LoadBalancers'] ?? null);
    const serviceRegistriesChanged =
      JSON.stringify(previousProperties['ServiceRegistries'] ?? null) !==
      JSON.stringify(properties['ServiceRegistries'] ?? null);

    // A LoadBalancers / ServiceRegistries change under a non-ECS controller
    // (CODE_DEPLOY blue/green or EXTERNAL) is applied by AWS via a new
    // CodeDeploy deployment / task set, NOT UpdateService — cdkd does not
    // orchestrate those. Fail loudly rather than silently omitting the field
    // (which would report success, poison state with the new value, and leave
    // AWS on the old config — the exact silent-drop class #975 fixes).
    if (!isEcsController && (loadBalancersChanged || serviceRegistriesChanged)) {
      throw new ProvisioningError(
        `AWS::ECS::Service '${logicalId}' changes LoadBalancers/ServiceRegistries under the ` +
          `'${deploymentControllerType}' deployment controller, which applies them via a new ` +
          `CodeDeploy deployment / task set rather than UpdateService. cdkd does not support ` +
          `updating these under a non-ECS controller; recreate the service or manage the ` +
          `blue/green deployment out-of-band.`,
        resourceType,
        logicalId,
        physicalId
      );
    }

    const loadBalancersInput =
      isEcsController && loadBalancersChanged
        ? (this.convertLoadBalancers(
            properties['LoadBalancers'] as Array<Record<string, unknown>> | undefined
          ) ?? [])
        : undefined;
    const serviceRegistriesInput =
      isEcsController && serviceRegistriesChanged
        ? (this.convertServiceRegistries(
            properties['ServiceRegistries'] as Array<Record<string, unknown>> | undefined
          ) ?? [])
        : undefined;

    // issue #1160 — reset removed fields to their CloudFormation defaults.
    // UpdateService uses merge semantics: an ABSENT input field means "no
    // change", so a property dropped from the template silently keeps its old
    // live value (deploy goes green, state.json records the removal, next diff
    // says "No changes" — the divergence is permanent and invisible). For each
    // removable field we send its explicit reset value when it was present
    // before and is now absent. Reset values were live-probed against real AWS
    // (2026-07-22, issue #1160): platformVersion clears on 'LATEST',
    // healthCheckGracePeriodSeconds on 0, propagateTags on 'NONE',
    // enableECSManagedTags on false, and each array field on an empty array
    // ([] accepted + AWS-documented as the clear sentinel). enableExecuteCommand
    // resets on false per the CFn default (a plain boolean; not live-probed
    // because execute-command requires an SSM-capable task role). LoadBalancers /
    // ServiceRegistries already clear via #975 (their change-detected empty-list
    // sentinel above).
    //
    // The array fields below are converted from CFn PascalCase to SDK camelCase
    // via their `convert*` helpers before the removal-reset check (issue #1165 —
    // the same silent-drop class as `DeploymentConfiguration` below; without the
    // conversion the SDK reads the camelCase keys, finds them absent, and drops
    // the whole value on update). `clearOnUpdateRemoval` only inspects the
    // PREVIOUS side for presence, so it may stay raw.
    //
    // `DeploymentConfiguration` casing is now fixed on both create() and
    // update() (converted via `convertDeploymentConfiguration`). Its removal
    // RESET to CFn defaults is still deferred to issue #1160: unlike the array
    // fields (whose reset is a plain empty list), it merges at the SUB-FIELD
    // level, so a correct reset must send the full default shape whose exact
    // values need a per-field live probe against real AWS (the #1160 rule).
    // The SAME sub-field merge also means a KEPT-but-partial
    // DeploymentConfiguration (one sub-field dropped from a still-present
    // block) silently retains the dropped sub-field's live value — the #1160
    // bug class one level down, tracked as issue #1225 alongside the
    // whole-block reset (both blocked on the same live probes:
    // deployment-type-dependent MaximumPercent/MinimumHealthyPercent defaults
    // — REPLICA 200/100, DAEMON min 0 via API — plus the
    // DeploymentCircuitBreaker / Alarms clear shapes).
    // Absent-from-template still passes `undefined` (no reset) below. Also not
    // reset (immutable / required / always-carried): ServiceName (immutable,
    // guarded above), Cluster / TaskDefinition / DesiredCount /
    // NetworkConfiguration, SchedulingStrategy (create-only).
    const capacityProviderStrategyInput = clearOnUpdateRemoval(
      this.convertCapacityProviderStrategy(
        properties['CapacityProviderStrategy'] as Array<Record<string, unknown>> | undefined
      ),
      previousProperties['CapacityProviderStrategy'] as CapacityProviderStrategyItem[] | undefined,
      // Empty list reverts the service to its launch type (AWS-documented). If
      // the service was created with a capacity provider and no launch type,
      // AWS rejects the reset — the same constraint CloudFormation faces.
      []
    );
    const placementConstraintsInput = clearOnUpdateRemoval(
      this.convertPlacementConstraints(
        properties['PlacementConstraints'] as Array<Record<string, unknown>> | undefined
      ),
      previousProperties['PlacementConstraints'] as PlacementConstraint[] | undefined,
      []
    );
    const placementStrategyInput = clearOnUpdateRemoval(
      this.convertPlacementStrategies(
        (properties['PlacementStrategies'] ?? properties['PlacementStrategy']) as
          | Array<Record<string, unknown>>
          | undefined
      ),
      (previousProperties['PlacementStrategies'] ?? previousProperties['PlacementStrategy']) as
        | PlacementStrategy[]
        | undefined,
      []
    );
    const platformVersionInput = clearOnUpdateRemoval(
      properties['PlatformVersion'] as string | undefined,
      previousProperties['PlatformVersion'] as string | undefined,
      'LATEST'
    );
    const healthCheckGracePeriodSecondsInput = clearOnUpdateRemoval(
      properties['HealthCheckGracePeriodSeconds'] as number | undefined,
      previousProperties['HealthCheckGracePeriodSeconds'] as number | undefined,
      0
    );
    const enableECSManagedTagsInput = clearOnUpdateRemoval(
      properties['EnableECSManagedTags'] as boolean | undefined,
      previousProperties['EnableECSManagedTags'] as boolean | undefined,
      false
    );
    const propagateTagsInput = clearOnUpdateRemoval(
      properties['PropagateTags'] as PropagateTags | undefined,
      previousProperties['PropagateTags'] as PropagateTags | undefined,
      'NONE'
    );
    const enableExecuteCommandInput = clearOnUpdateRemoval(
      properties['EnableExecuteCommand'] as boolean | undefined,
      previousProperties['EnableExecuteCommand'] as boolean | undefined,
      false
    );

    // issue #609 backfill — the previously silent-dropped Service members on
    // the update path. All of the config blobs below are change-gated (like
    // LoadBalancers / ServiceRegistries above) because the AWS docs mark them
    // "this parameter triggers a new service deployment": re-sending an
    // unchanged value on an unrelated update could start a spurious rollout.
    //
    // Removal (present before, absent now) semantics per member — the #1160
    // doctrine wants live-probed reset sentinels; none of these have been
    // live-probed yet, so each choice below is documented from the API docs
    // and marked UNVERIFIED-LIVE where a probe is still owed:
    //   - ServiceConnectConfiguration -> `{ enabled: false }`. The ECS
    //     developer guide documents Service Connect as disabled by default
    //     and `enabled: false` as the API's turn-off shape (`enabled` is the
    //     only required member). UNVERIFIED-LIVE.
    //   - VolumeConfigurations / VpcLatticeConfigurations -> `[]`, matching
    //     the empty-list clear sentinel of the sibling list members
    //     (LoadBalancers / ServiceRegistries / PlacementConstraints). Unlike
    //     those, the UpdateService doc does not spell out "pass an empty list
    //     to remove" for these two. UNVERIFIED-LIVE.
    //   - AvailabilityZoneRebalancing -> DEFERRED (no reset sent). The SDK
    //     doc is explicit that an absent value on UpdateService keeps the
    //     existing setting, and the defaults genuinely diverge (CreateService
    //     defaults ENABLED; a service that never had a value is treated as
    //     DISABLED), so there is no single defensible CFn reset value without
    //     a live probe — same deferral shape as DeploymentConfiguration above.
    //   - Monitoring -> DEFERRED (no reset sent). Its removal reset would
    //     need the sub-field merge semantics of MonitoringConfiguration
    //     live-probed first (the DeploymentConfiguration precedent above).
    //   - DeploymentController -> no reset by design: absent means the
    //     default ECS controller, and sending nothing keeps AWS's current
    //     controller (the property is only sent when present AND changed —
    //     the SDK supports an explicit change for ECS<->CODE_DEPLOY
    //     migration).
    //   - Role -> create-only (registry schema createOnlyProperties); a
    //     change is classified as replacement by the diff layer, so update()
    //     never delivers it (UpdateService has no role member).
    const availabilityZoneRebalancingChanged =
      JSON.stringify(previousProperties['AvailabilityZoneRebalancing'] ?? null) !==
      JSON.stringify(properties['AvailabilityZoneRebalancing'] ?? null);
    const availabilityZoneRebalancingInput =
      availabilityZoneRebalancingChanged && properties['AvailabilityZoneRebalancing'] !== undefined
        ? (properties['AvailabilityZoneRebalancing'] as AvailabilityZoneRebalancing)
        : undefined;

    const deploymentControllerChanged =
      JSON.stringify(previousProperties['DeploymentController'] ?? null) !==
      JSON.stringify(properties['DeploymentController'] ?? null);
    const deploymentControllerInput =
      deploymentControllerChanged && properties['DeploymentController'] != null
        ? this.convertDeploymentController(
            properties['DeploymentController'] as Record<string, unknown>
          )
        : undefined;

    const serviceConnectChanged =
      JSON.stringify(previousProperties['ServiceConnectConfiguration'] ?? null) !==
      JSON.stringify(properties['ServiceConnectConfiguration'] ?? null);
    const serviceConnectConfigurationInput = serviceConnectChanged
      ? clearOnUpdateRemoval(
          this.convertServiceConnectConfiguration(
            properties['ServiceConnectConfiguration'] as Record<string, unknown> | undefined
          ),
          previousProperties['ServiceConnectConfiguration'] as
            | ServiceConnectConfiguration
            | undefined,
          { enabled: false }
        )
      : undefined;

    const volumeConfigurationsChanged =
      JSON.stringify(previousProperties['VolumeConfigurations'] ?? null) !==
      JSON.stringify(properties['VolumeConfigurations'] ?? null);
    const volumeConfigurationsInput = volumeConfigurationsChanged
      ? clearOnUpdateRemoval(
          this.convertServiceVolumeConfigurations(
            properties['VolumeConfigurations'] as Array<Record<string, unknown>> | undefined
          ),
          previousProperties['VolumeConfigurations'] as ServiceVolumeConfiguration[] | undefined,
          []
        )
      : undefined;

    const vpcLatticeConfigurationsChanged =
      JSON.stringify(previousProperties['VpcLatticeConfigurations'] ?? null) !==
      JSON.stringify(properties['VpcLatticeConfigurations'] ?? null);
    const vpcLatticeConfigurationsInput = vpcLatticeConfigurationsChanged
      ? clearOnUpdateRemoval(
          this.convertVpcLatticeConfigurations(
            properties['VpcLatticeConfigurations'] as Array<Record<string, unknown>> | undefined
          ),
          previousProperties['VpcLatticeConfigurations'] as VpcLatticeConfiguration[] | undefined,
          []
        )
      : undefined;

    const monitoringChanged =
      JSON.stringify(previousProperties['Monitoring'] ?? null) !==
      JSON.stringify(properties['Monitoring'] ?? null);
    const monitoringInput =
      monitoringChanged && properties['Monitoring'] != null
        ? this.convertMonitoringConfiguration(properties['Monitoring'] as Record<string, unknown>)
        : undefined;

    // CFn ForceNewDeployment `{EnableForceNewDeployment, ForceNewDeploymentNonce}`
    // -> the SDK's plain `forceNewDeployment` boolean (only send `true`; the
    // field is a one-shot trigger, never persisted state).
    const forceNewDeploymentInput = this.resolveForceNewDeployment(properties, previousProperties);

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
          capacityProviderStrategy: capacityProviderStrategyInput,
          // DeploymentConfiguration is converted PascalCase->camelCase (issue
          // #1165); a change is sent through, an absent value passes undefined
          // (removal RESET to defaults still deferred — see the comment block
          // above).
          deploymentConfiguration: this.convertDeploymentConfiguration(
            properties['DeploymentConfiguration'] as Record<string, unknown> | undefined
          ),
          placementConstraints: placementConstraintsInput,
          placementStrategy: placementStrategyInput,
          platformVersion: platformVersionInput,
          healthCheckGracePeriodSeconds: healthCheckGracePeriodSecondsInput,
          enableECSManagedTags: enableECSManagedTagsInput,
          propagateTags: propagateTagsInput,
          enableExecuteCommand: enableExecuteCommandInput,
          loadBalancers: loadBalancersInput,
          serviceRegistries: serviceRegistriesInput,
          // issue #609 backfill (change-gated; removal semantics documented
          // in the block above the try).
          availabilityZoneRebalancing: availabilityZoneRebalancingInput,
          deploymentController: deploymentControllerInput,
          serviceConnectConfiguration: serviceConnectConfigurationInput,
          volumeConfigurations: volumeConfigurationsInput,
          vpcLatticeConfigurations: vpcLatticeConfigurationsInput,
          monitoring: monitoringInput,
          forceNewDeployment: forceNewDeploymentInput,
        })
      );

      const service = response.service;

      // Apply tag diff. ECS Service ARN comes from the UpdateService response.
      if (service?.serviceArn) {
        await this.applyTagDiff(
          service.serviceArn,
          previousProperties['Tags'] as Array<{ Key?: string; Value?: string }> | undefined,
          properties['Tags'] as Array<{ Key?: string; Value?: string }> | undefined
        );
      }

      // UpdateService is fire-and-forget for the same reason CreateService is
      // (issue #1275): the rolling deployment it starts settles minutes later.
      await this.settleService(
        logicalId,
        service?.serviceName ?? physicalId,
        properties['Cluster'] as string | undefined
      );

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
    properties?: Record<string, unknown>,
    context?: DeleteContext
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
          const clientRegion = await client.config.region();
          assertRegionMatch(
            clientRegion,
            context?.expectedRegion,
            resourceType,
            logicalId,
            physicalId
          );
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
        const clientRegion = await client.config.region();
        assertRegionMatch(
          clientRegion,
          context?.expectedRegion,
          resourceType,
          logicalId,
          physicalId
        );
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

    // physicalId is the service ARN (what createService stores). DescribeServices
    // scopes to the default cluster unless a cluster is given, so a Service in a
    // non-default cluster would come back MISSING; derive the cluster from the
    // ARN so the lookup is scoped correctly (issue #1170).
    const response = await client.send(
      new DescribeServicesCommand({
        cluster: clusterNameFromServiceArn(physicalId),
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
   * Apply a diff between old and new CFn-shape Tags arrays via ECS's
   * `TagResource` / `UntagResource` APIs. ECS uses lowercase camelCase
   * (`{ key, value }`) for tags. Resource ARN identifies the cluster /
   * service / task definition.
   */
  private async applyTagDiff(
    resourceArn: string,
    oldTagsRaw: Array<{ Key?: string; Value?: string }> | undefined,
    newTagsRaw: Array<{ Key?: string; Value?: string }> | undefined
  ): Promise<void> {
    const toMap = (
      tags: Array<{ Key?: string; Value?: string }> | undefined
    ): Map<string, string> => {
      const m = new Map<string, string>();
      for (const t of tags ?? []) {
        if (t.Key !== undefined && t.Value !== undefined) m.set(t.Key, t.Value);
      }
      return m;
    };

    const oldMap = toMap(oldTagsRaw);
    const newMap = toMap(newTagsRaw);

    const tagsToAdd: Tag[] = [];
    for (const [k, v] of newMap) {
      if (oldMap.get(k) !== v) tagsToAdd.push({ key: k, value: v });
    }
    const tagsToRemove: string[] = [];
    for (const k of oldMap.keys()) {
      if (!newMap.has(k)) tagsToRemove.push(k);
    }

    if (tagsToRemove.length > 0) {
      await this.getClient().send(new UntagResourceCommand({ resourceArn, tagKeys: tagsToRemove }));
      this.logger.debug(`Removed ${tagsToRemove.length} tag(s) from ECS resource ${resourceArn}`);
    }
    if (tagsToAdd.length > 0) {
      await this.getClient().send(new TagResourceCommand({ resourceArn, tags: tagsToAdd }));
      this.logger.debug(`Added/updated ${tagsToAdd.length} tag(s) on ECS resource ${resourceArn}`);
    }
  }

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
      environment: this.convertEnvironment(
        def['Environment'] as Array<Record<string, unknown>> | undefined
      ),
      environmentFiles: this.convertEnvironmentFiles(
        def['EnvironmentFiles'] as Array<Record<string, unknown>> | undefined
      ),
      secrets: this.convertSecrets(def['Secrets'] as Array<Record<string, unknown>> | undefined),
      portMappings: this.convertPortMappings(
        def['PortMappings'] as Array<Record<string, unknown>> | undefined
      ),
      mountPoints: this.convertMountPoints(
        def['MountPoints'] as Array<Record<string, unknown>> | undefined
      ),
      volumesFrom: this.convertVolumesFrom(
        def['VolumesFrom'] as Array<Record<string, unknown>> | undefined
      ),
      dependsOn: this.convertDependsOn(
        def['DependsOn'] as Array<Record<string, unknown>> | undefined
      ),
      links: def['Links'] as string[] | undefined,
      workingDirectory: def['WorkingDirectory'] as string | undefined,
      disableNetworking: def['DisableNetworking'] as boolean | undefined,
      privileged: def['Privileged'] as boolean | undefined,
      readonlyRootFilesystem: def['ReadonlyRootFilesystem'] as boolean | undefined,
      user: def['User'] as string | undefined,
      ulimits: this.convertUlimits(def['Ulimits'] as Array<Record<string, unknown>> | undefined),
      logConfiguration: this.convertLogConfiguration(
        def['LogConfiguration'] as Record<string, unknown> | undefined
      ),
      healthCheck: this.convertHealthCheck(
        def['HealthCheck'] as Record<string, unknown> | undefined
      ),
      linuxParameters: this.convertLinuxParameters(
        def['LinuxParameters'] as Record<string, unknown> | undefined
      ),
      dockerLabels: def['DockerLabels'] as Record<string, string> | undefined,
      startTimeout: def['StartTimeout'] as number | undefined,
      stopTimeout: def['StopTimeout'] as number | undefined,
      interactive: def['Interactive'] as boolean | undefined,
      pseudoTerminal: def['PseudoTerminal'] as boolean | undefined,
      // issue #1173: these container sub-fields were previously unmapped, so
      // they were silently dropped on RegisterTaskDefinition. Each is a
      // mechanical first-letter flip (pascalToCamelCaseKeys) EXCEPT
      // FirelensConfiguration, whose `Options` is a free-form map whose keys
      // are user data (NOT CFn property names) and must be copied verbatim.
      repositoryCredentials: def['RepositoryCredentials']
        ? (pascalToCamelCaseKeys(def['RepositoryCredentials']) as RepositoryCredentials)
        : undefined,
      firelensConfiguration: this.convertFirelensConfiguration(
        def['FirelensConfiguration'] as Record<string, unknown> | undefined
      ),
      resourceRequirements: def['ResourceRequirements']
        ? (pascalToCamelCaseKeys(def['ResourceRequirements']) as ResourceRequirement[])
        : undefined,
      systemControls: def['SystemControls']
        ? (pascalToCamelCaseKeys(def['SystemControls']) as SystemControl[])
        : undefined,
      extraHosts: def['ExtraHosts']
        ? (pascalToCamelCaseKeys(def['ExtraHosts']) as HostEntry[])
        : undefined,
      restartPolicy: def['RestartPolicy']
        ? (pascalToCamelCaseKeys(def['RestartPolicy']) as ContainerRestartPolicy)
        : undefined,
      dnsServers: def['DnsServers'] as string[] | undefined,
      dnsSearchDomains: def['DnsSearchDomains'] as string[] | undefined,
      dockerSecurityOptions: def['DockerSecurityOptions'] as string[] | undefined,
      credentialSpecs: def['CredentialSpecs'] as string[] | undefined,
      hostname: def['Hostname'] as string | undefined,
      versionConsistency: def['VersionConsistency'] as VersionConsistency | undefined,
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
      containerPortRange: m['ContainerPortRange'] as string | undefined,
      hostPort: m['HostPort'] as number | undefined,
      protocol: m['Protocol'] as TransportProtocol | undefined,
      appProtocol: m['AppProtocol'] as ApplicationProtocol | undefined,
      name: m['Name'] as string | undefined,
    }));
  }

  /**
   * Convert CFn Environment (KeyValuePair) to ECS SDK format.
   * CFn template emits `{Name, Value}` (PascalCase); ECS SDK requires
   * `{name, value}` (camelCase). Pre-fix the cast `as KeyValuePair[]`
   * silently dropped both fields and AWS rejected RegisterTaskDefinition
   * with a generic null/empty validation error.
   */
  private convertEnvironment(entries?: Array<Record<string, unknown>>): KeyValuePair[] | undefined {
    if (!entries) return undefined;
    return entries.map((e) => ({
      name: e['Name'] as string | undefined,
      value: e['Value'] as string | undefined,
    }));
  }

  /**
   * Convert CFn EnvironmentFiles (S3-backed env-var files) to ECS SDK format.
   * CFn: `{Type, Value}` → SDK: `{type, value}`.
   */
  private convertEnvironmentFiles(
    entries?: Array<Record<string, unknown>>
  ): EnvironmentFile[] | undefined {
    if (!entries) return undefined;
    return entries.map((e) => ({
      type: e['Type'] as EnvironmentFileType | undefined,
      value: e['Value'] as string | undefined,
    }));
  }

  /**
   * Convert CFn Secrets to ECS SDK format.
   * CFn: `{Name, ValueFrom}` → SDK: `{name, valueFrom}`.
   * Same PascalCase→camelCase trap as convertEnvironment — discovered
   * end-to-end via the local-run-task-from-state integ on 2026-05-12
   * (issue #291 fixture).
   */
  private convertSecrets(entries?: Array<Record<string, unknown>>): Secret[] | undefined {
    if (!entries) return undefined;
    return entries.map((e) => ({
      name: e['Name'] as string | undefined,
      valueFrom: e['ValueFrom'] as string | undefined,
    }));
  }

  /**
   * Convert CFn MountPoints to ECS SDK format.
   * CFn: `{SourceVolume, ContainerPath, ReadOnly}` → SDK: `{sourceVolume,
   * containerPath, readOnly}`.
   */
  private convertMountPoints(entries?: Array<Record<string, unknown>>): MountPoint[] | undefined {
    if (!entries) return undefined;
    return entries.map((e) => ({
      sourceVolume: e['SourceVolume'] as string | undefined,
      containerPath: e['ContainerPath'] as string | undefined,
      readOnly: e['ReadOnly'] as boolean | undefined,
    }));
  }

  /**
   * Convert CFn VolumesFrom to ECS SDK format.
   * CFn: `{SourceContainer, ReadOnly}` → SDK: `{sourceContainer, readOnly}`.
   */
  private convertVolumesFrom(entries?: Array<Record<string, unknown>>): VolumeFrom[] | undefined {
    if (!entries) return undefined;
    return entries.map((e) => ({
      sourceContainer: e['SourceContainer'] as string | undefined,
      readOnly: e['ReadOnly'] as boolean | undefined,
    }));
  }

  /**
   * Convert CFn DependsOn to ECS SDK format.
   * CFn: `{ContainerName, Condition}` → SDK: `{containerName, condition}`.
   * The pre-existing local-run-task-multi-container integ was relying
   * on ECS SDK being lenient about the dependsOn key casing on input,
   * but per the SDK type definition the input is camelCase so this
   * converter brings the actual wire shape in line with the contract.
   */
  private convertDependsOn(
    entries?: Array<Record<string, unknown>>
  ): ContainerDependency[] | undefined {
    if (!entries) return undefined;
    return entries.map((e) => ({
      containerName: e['ContainerName'] as string | undefined,
      condition: e['Condition'] as ContainerCondition | undefined,
    }));
  }

  /**
   * Convert CFn Ulimits to ECS SDK format.
   * CFn: `{Name, SoftLimit, HardLimit}` → SDK: `{name, softLimit, hardLimit}`.
   */
  private convertUlimits(entries?: Array<Record<string, unknown>>): Ulimit[] | undefined {
    if (!entries) return undefined;
    return entries.map((e) => ({
      name: e['Name'] as UlimitName | undefined,
      softLimit: e['SoftLimit'] as number | undefined,
      hardLimit: e['HardLimit'] as number | undefined,
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
      secretOptions: this.convertSecrets(
        config['SecretOptions'] as Array<Record<string, unknown>> | undefined
      ),
    };
  }

  /**
   * Convert CFn `ContainerDefinitions[].FirelensConfiguration` to the ECS SDK
   * shape (issue #1173). `Type` flips to `type`, but `Options` is a free-form
   * map of user-supplied FireLens options (e.g. `enable-ecs-log-metadata`,
   * `config-file-value`) whose keys are NOT CFn property names, so it is copied
   * verbatim rather than case-flipped.
   */
  private convertFirelensConfiguration(
    config?: Record<string, unknown>
  ): FirelensConfiguration | undefined {
    if (!config) return undefined;
    return {
      type: config['Type'] as FirelensConfigurationType | undefined,
      options: config['Options'] as Record<string, string> | undefined,
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
   * Convert CFn Volumes to ECS SDK format.
   *
   * Every nested volume-configuration block is PascalCase in the CFn
   * template and camelCase in the ECS SDK input, so each sub-block runs
   * through a dedicated converter — the same PascalCase->camelCase trap
   * already fixed for the ContainerDefinitions sub-arrays
   * (convertEnvironment / convertSecrets / convertMountPoints etc.).
   * Before issue #815, `Host` / `EFSVolumeConfiguration` were cast through
   * raw (so their nested keys reached the SDK still PascalCase) and
   * `DockerVolumeConfiguration` / `FSxWindowsFileServerVolumeConfiguration`
   * were not mapped at all (silently dropped).
   */
  private convertVolumes(volumes?: Array<Record<string, unknown>>): Volume[] | undefined {
    if (!volumes) return undefined;

    return volumes.map((v) => ({
      name: v['Name'] as string,
      host: this.convertVolumeHost(v['Host'] as Record<string, unknown> | undefined),
      dockerVolumeConfiguration: this.convertDockerVolumeConfiguration(
        v['DockerVolumeConfiguration'] as Record<string, unknown> | undefined
      ),
      efsVolumeConfiguration: this.convertEFSVolumeConfiguration(
        v['EFSVolumeConfiguration'] as Record<string, unknown> | undefined
      ),
      fsxWindowsFileServerVolumeConfiguration: this.convertFSxWindowsVolumeConfiguration(
        v['FSxWindowsFileServerVolumeConfiguration'] as Record<string, unknown> | undefined
      ),
      // SDK member is `s3filesVolumeConfiguration` — an all-lowercase
      // `s3files` prefix, NOT the mechanical `s3FilesVolumeConfiguration`
      // first-letter flip, so the shared key-flip converter can never reach
      // it (nested-key critic catch, issue #1373).
      s3filesVolumeConfiguration: this.convertS3FilesVolumeConfiguration(
        v['S3FilesVolumeConfiguration'] as Record<string, unknown> | undefined
      ),
      // ConfiguredAtLaunch marks the volume as attach-at-launch so a
      // same-stack AWS::ECS::Service can carry a matching
      // VolumeConfigurations entry (managed EBS volume). Dropping it made
      // the Service create fail with "Volume configuration provided but no
      // matching configuredAtLaunch volume found in task definition"
      // (issue #806).
      configuredAtLaunch: this.coerceBool(v['ConfiguredAtLaunch']),
    }));
  }

  /**
   * Convert CFn Volumes[].S3FilesVolumeConfiguration to ECS SDK format.
   * CFn: `{FileSystemArn, AccessPointArn, RootDirectory,
   * TransitEncryptionPort}` -> SDK members of the same spelling modulo the
   * first-letter flip. The parent key itself is the irregular one (see
   * `convertVolumes`).
   */
  private convertS3FilesVolumeConfiguration(
    config?: Record<string, unknown>
  ): S3FilesVolumeConfiguration | undefined {
    if (!config) return undefined;
    return {
      fileSystemArn: config['FileSystemArn'] as string,
      accessPointArn: config['AccessPointArn'] as string | undefined,
      rootDirectory: config['RootDirectory'] as string | undefined,
      // CFn templates carry stringly-typed numerics; coerce like the EFS
      // sibling above.
      transitEncryptionPort:
        config['TransitEncryptionPort'] !== undefined
          ? Number(config['TransitEncryptionPort'])
          : undefined,
    };
  }

  /**
   * Convert CFn Volumes[].Host to ECS SDK format.
   * CFn: `{SourcePath}` -> SDK: `{sourcePath}`.
   */
  private convertVolumeHost(host?: Record<string, unknown>): HostVolumeProperties | undefined {
    if (!host) return undefined;
    return {
      sourcePath: host['SourcePath'] as string | undefined,
    };
  }

  /**
   * Convert CFn Volumes[].DockerVolumeConfiguration to ECS SDK format.
   * CFn: `{Scope, Autoprovision, Driver, DriverOpts, Labels}`
   * -> SDK: `{scope, autoprovision, driver, driverOpts, labels}`.
   */
  private convertDockerVolumeConfiguration(
    config?: Record<string, unknown>
  ): DockerVolumeConfiguration | undefined {
    if (!config) return undefined;
    return {
      scope: config['Scope'] as Scope | undefined,
      autoprovision: this.coerceBool(config['Autoprovision']),
      driver: config['Driver'] as string | undefined,
      driverOpts: config['DriverOpts'] as Record<string, string> | undefined,
      labels: config['Labels'] as Record<string, string> | undefined,
    };
  }

  /**
   * Convert CFn Volumes[].EFSVolumeConfiguration to ECS SDK format.
   * CFn: `{FilesystemId, RootDirectory, TransitEncryption,
   * TransitEncryptionPort, AuthorizationConfig}`
   * -> SDK: `{fileSystemId, rootDirectory, transitEncryption,
   * transitEncryptionPort, authorizationConfig}`.
   * Note the CFn property is `FilesystemId` (lowercase `s`) while the SDK
   * field is `fileSystemId` — they are not a simple first-letter case flip.
   */
  private convertEFSVolumeConfiguration(
    config?: Record<string, unknown>
  ): EFSVolumeConfiguration | undefined {
    if (!config) return undefined;
    return {
      fileSystemId: config['FilesystemId'] as string,
      rootDirectory: config['RootDirectory'] as string | undefined,
      transitEncryption: config['TransitEncryption'] as EFSTransitEncryption | undefined,
      transitEncryptionPort:
        config['TransitEncryptionPort'] !== undefined
          ? Number(config['TransitEncryptionPort'])
          : undefined,
      authorizationConfig: this.convertEFSAuthorizationConfig(
        config['AuthorizationConfig'] as Record<string, unknown> | undefined
      ),
    };
  }

  /**
   * Convert CFn EFSVolumeConfiguration.AuthorizationConfig to ECS SDK format.
   * CFn: `{AccessPointId, IAM}` -> SDK: `{accessPointId, iam}`.
   * Note the CFn key is `IAM` (all caps), NOT `Iam` — not a simple
   * first-letter case flip (verified against the CDK L1 `IAM` mapping).
   */
  private convertEFSAuthorizationConfig(
    config?: Record<string, unknown>
  ): EFSAuthorizationConfig | undefined {
    if (!config) return undefined;
    return {
      accessPointId: config['AccessPointId'] as string | undefined,
      iam: config['IAM'] as EFSAuthorizationConfigIAM | undefined,
    };
  }

  /**
   * Convert CFn Volumes[].FSxWindowsFileServerVolumeConfiguration to ECS
   * SDK format.
   * CFn: `{FileSystemId, RootDirectory, AuthorizationConfig}`
   * -> SDK: `{fileSystemId, rootDirectory, authorizationConfig}`.
   */
  private convertFSxWindowsVolumeConfiguration(
    config?: Record<string, unknown>
  ): FSxWindowsFileServerVolumeConfiguration | undefined {
    if (!config) return undefined;
    return {
      fileSystemId: config['FileSystemId'] as string,
      rootDirectory: config['RootDirectory'] as string,
      authorizationConfig: this.convertFSxWindowsAuthorizationConfig(
        config['AuthorizationConfig'] as Record<string, unknown> | undefined
      ) as FSxWindowsFileServerAuthorizationConfig,
    };
  }

  /**
   * Convert CFn FSxWindowsFileServerVolumeConfiguration.AuthorizationConfig
   * to ECS SDK format.
   * CFn: `{CredentialsParameter, Domain}`
   * -> SDK: `{credentialsParameter, domain}`.
   */
  private convertFSxWindowsAuthorizationConfig(
    config?: Record<string, unknown>
  ): FSxWindowsFileServerAuthorizationConfig | undefined {
    if (!config) return undefined;
    return {
      credentialsParameter: config['CredentialsParameter'] as string,
      domain: config['Domain'] as string,
    };
  }

  /**
   * Convert the camelCase SDK `volumes` shape returned by
   * DescribeTaskDefinition back to the PascalCase CFn template form, so the
   * `readCurrentState` snapshot matches the deploy-time template
   * representation for drift comparison (issue #815). Only volume keys
   * present on the SDK side are emitted, so a future field cdkd does not
   * map cannot surface as phantom drift. TaskDefinitions are immutable
   * replace-only today, so this is forward-looking normalization.
   */
  private volumesToCfn(volumes?: Volume[]): Array<Record<string, unknown>> {
    if (!volumes) return [];
    return volumes.map((v) => {
      const out: Record<string, unknown> = {};
      if (v.name !== undefined) out['Name'] = v.name;
      if (v.host !== undefined) {
        const host: Record<string, unknown> = {};
        if (v.host.sourcePath !== undefined) host['SourcePath'] = v.host.sourcePath;
        out['Host'] = host;
      }
      if (v.dockerVolumeConfiguration !== undefined) {
        const d = v.dockerVolumeConfiguration;
        const docker: Record<string, unknown> = {};
        if (d.scope !== undefined) docker['Scope'] = d.scope;
        if (d.autoprovision !== undefined) docker['Autoprovision'] = d.autoprovision;
        if (d.driver !== undefined) docker['Driver'] = d.driver;
        if (d.driverOpts !== undefined) docker['DriverOpts'] = d.driverOpts;
        if (d.labels !== undefined) docker['Labels'] = d.labels;
        out['DockerVolumeConfiguration'] = docker;
      }
      if (v.efsVolumeConfiguration !== undefined) {
        const e = v.efsVolumeConfiguration;
        const efs: Record<string, unknown> = {};
        if (e.fileSystemId !== undefined) efs['FilesystemId'] = e.fileSystemId;
        if (e.rootDirectory !== undefined) efs['RootDirectory'] = e.rootDirectory;
        if (e.transitEncryption !== undefined) efs['TransitEncryption'] = e.transitEncryption;
        if (e.transitEncryptionPort !== undefined) {
          efs['TransitEncryptionPort'] = e.transitEncryptionPort;
        }
        if (e.authorizationConfig !== undefined) {
          const a = e.authorizationConfig;
          const auth: Record<string, unknown> = {};
          if (a.accessPointId !== undefined) auth['AccessPointId'] = a.accessPointId;
          if (a.iam !== undefined) auth['IAM'] = a.iam;
          efs['AuthorizationConfig'] = auth;
        }
        out['EFSVolumeConfiguration'] = efs;
      }
      if (v.s3filesVolumeConfiguration !== undefined) {
        const s = v.s3filesVolumeConfiguration;
        const s3f: Record<string, unknown> = {};
        if (s.fileSystemArn !== undefined) s3f['FileSystemArn'] = s.fileSystemArn;
        if (s.accessPointArn !== undefined) s3f['AccessPointArn'] = s.accessPointArn;
        if (s.rootDirectory !== undefined) s3f['RootDirectory'] = s.rootDirectory;
        if (s.transitEncryptionPort !== undefined) {
          s3f['TransitEncryptionPort'] = s.transitEncryptionPort;
        }
        out['S3FilesVolumeConfiguration'] = s3f;
      }
      if (v.fsxWindowsFileServerVolumeConfiguration !== undefined) {
        const f = v.fsxWindowsFileServerVolumeConfiguration;
        const fsx: Record<string, unknown> = {};
        if (f.fileSystemId !== undefined) fsx['FileSystemId'] = f.fileSystemId;
        if (f.rootDirectory !== undefined) fsx['RootDirectory'] = f.rootDirectory;
        if (f.authorizationConfig !== undefined) {
          const a = f.authorizationConfig;
          const auth: Record<string, unknown> = {};
          if (a.credentialsParameter !== undefined) {
            auth['CredentialsParameter'] = a.credentialsParameter;
          }
          if (a.domain !== undefined) auth['Domain'] = a.domain;
          fsx['AuthorizationConfig'] = auth;
        }
        out['FSxWindowsFileServerVolumeConfiguration'] = fsx;
      }
      if (v.configuredAtLaunch !== undefined) out['ConfiguredAtLaunch'] = v.configuredAtLaunch;
      return out;
    });
  }

  /**
   * Reverse of `convertProxyConfiguration` for `readCurrentState` (issue
   * #1167): map the SDK camelCase `ProxyConfiguration` back to the CFn
   * PascalCase shape so the drift baseline (state `properties`, PascalCase)
   * and the AWS-current read compare apples-to-apples. Unlike the pure
   * first-letter flips, the SDK field `properties` maps back to the CFn key
   * `ProxyConfigurationProperties` (a `{Name,Value}[]`), so it needs an
   * explicit remap rather than `camelToPascalCaseKeys`.
   */
  private proxyConfigurationToCfn(config: ProxyConfiguration): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    if (config.type !== undefined) out['Type'] = config.type;
    if (config.containerName !== undefined) out['ContainerName'] = config.containerName;
    if (config.properties !== undefined) {
      out['ProxyConfigurationProperties'] = config.properties.map((p) => ({
        Name: p.name,
        Value: p.value,
      }));
    }
    return out;
  }

  /**
   * Reverse of `convertContainerDefinitions` for `readCurrentState` (issue
   * #1169). Emits CFn PascalCase so the drift baseline (state `properties`
   * PascalCase, or `observedProperties` captured via this same reader) compares
   * apples-to-apples instead of phantom-drifting on the whole array — the drift
   * comparator compares arrays wholesale via `deepEqual`, so the previous raw
   * SDK camelCase read (`result['ContainerDefinitions'] = td.containerDefinitions`)
   * never matched a PascalCase baseline.
   *
   * Two rules keep the read side matching a template that omits AWS's defaults:
   *   1. Only the fields `convertContainerDefinitions` can SET are emitted, so
   *      the round-trip is symmetric — a field cdkd cannot set is never surfaced
   *      as drift against a template that lacks it.
   *   2. AWS-defaulted-empty divergences are normalized away — `Cpu: 0`, empty
   *      arrays (`PortMappings` / `Environment` / ...), and an empty
   *      `LinuxParameters.Capabilities: {Add:[],Drop:[]}` are dropped so they
   *      equal "absent" (what the template has). AWS returns these defaults on
   *      EVERY read, so without this the `properties` fallback baseline
   *      (pre-observedProperties state) would phantom-drift on every run; the
   *      normalization trades that for a rare edge — a template that EXPLICITLY
   *      sets one of these to its empty/zero default AND has no observed baseline
   *      (CDK L2 never emits e.g. an explicit `Cpu: 0`). On the normal
   *      `observedProperties` path both sides run through this reader, so the
   *      snapshot is self-consistent regardless.
   *
   * Free-form maps (`DockerLabels`, `LogConfiguration.Options`) are copied
   * verbatim — their keys are user data (log-driver options / container labels),
   * NOT CFn property names, so they must not be case-flipped.
   */
  private containerDefinitionsToCfn(defs?: ContainerDefinition[]): Array<Record<string, unknown>> {
    if (!defs) return [];
    return defs.map((c) => {
      const out: Record<string, unknown> = {};
      if (c.name !== undefined) out['Name'] = c.name;
      if (c.image !== undefined) out['Image'] = c.image;
      // Cpu 0 is the AWS default for a container that omits it; drop so it
      // matches a template without an explicit Cpu.
      if (c.cpu !== undefined && c.cpu !== 0) out['Cpu'] = c.cpu;
      if (c.memory !== undefined) out['Memory'] = c.memory;
      if (c.memoryReservation !== undefined) out['MemoryReservation'] = c.memoryReservation;
      if (c.essential !== undefined) out['Essential'] = c.essential;
      if (c.command && c.command.length > 0) out['Command'] = [...c.command];
      if (c.entryPoint && c.entryPoint.length > 0) out['EntryPoint'] = [...c.entryPoint];
      if (c.environment && c.environment.length > 0) {
        out['Environment'] = c.environment.map((e) => ({ Name: e.name, Value: e.value }));
      }
      if (c.environmentFiles && c.environmentFiles.length > 0) {
        out['EnvironmentFiles'] = c.environmentFiles.map((e) => ({ Type: e.type, Value: e.value }));
      }
      if (c.secrets && c.secrets.length > 0) {
        out['Secrets'] = c.secrets.map((s) => ({ Name: s.name, ValueFrom: s.valueFrom }));
      }
      if (c.portMappings && c.portMappings.length > 0) {
        out['PortMappings'] = camelToPascalCaseKeys(c.portMappings);
      }
      if (c.mountPoints && c.mountPoints.length > 0) {
        out['MountPoints'] = camelToPascalCaseKeys(c.mountPoints);
      }
      if (c.volumesFrom && c.volumesFrom.length > 0) {
        out['VolumesFrom'] = camelToPascalCaseKeys(c.volumesFrom);
      }
      if (c.dependsOn && c.dependsOn.length > 0) {
        out['DependsOn'] = camelToPascalCaseKeys(c.dependsOn);
      }
      if (c.links && c.links.length > 0) out['Links'] = [...c.links];
      if (c.workingDirectory !== undefined) out['WorkingDirectory'] = c.workingDirectory;
      if (c.disableNetworking !== undefined) out['DisableNetworking'] = c.disableNetworking;
      if (c.privileged !== undefined) out['Privileged'] = c.privileged;
      if (c.readonlyRootFilesystem !== undefined) {
        out['ReadonlyRootFilesystem'] = c.readonlyRootFilesystem;
      }
      if (c.user !== undefined) out['User'] = c.user;
      if (c.ulimits && c.ulimits.length > 0) out['Ulimits'] = camelToPascalCaseKeys(c.ulimits);
      if (c.logConfiguration) {
        out['LogConfiguration'] = this.logConfigurationToCfn(c.logConfiguration);
      }
      if (c.healthCheck) out['HealthCheck'] = camelToPascalCaseKeys(c.healthCheck);
      if (c.linuxParameters) {
        const lp = this.linuxParametersToCfn(c.linuxParameters);
        if (Object.keys(lp).length > 0) out['LinuxParameters'] = lp;
      }
      if (c.dockerLabels && Object.keys(c.dockerLabels).length > 0) {
        out['DockerLabels'] = { ...c.dockerLabels };
      }
      if (c.startTimeout !== undefined) out['StartTimeout'] = c.startTimeout;
      if (c.stopTimeout !== undefined) out['StopTimeout'] = c.stopTimeout;
      if (c.interactive !== undefined) out['Interactive'] = c.interactive;
      if (c.pseudoTerminal !== undefined) out['PseudoTerminal'] = c.pseudoTerminal;
      // issue #1173: reverse-map the newly-settable sub-fields (see
      // convertContainerDefinitions). FirelensConfiguration.Options is a
      // free-form map copied verbatim; the rest are first-letter flips.
      if (c.repositoryCredentials) {
        out['RepositoryCredentials'] = camelToPascalCaseKeys(c.repositoryCredentials);
      }
      if (c.firelensConfiguration) {
        const fc: Record<string, unknown> = {};
        if (c.firelensConfiguration.type !== undefined) fc['Type'] = c.firelensConfiguration.type;
        if (
          c.firelensConfiguration.options &&
          Object.keys(c.firelensConfiguration.options).length > 0
        ) {
          fc['Options'] = { ...c.firelensConfiguration.options };
        }
        if (Object.keys(fc).length > 0) out['FirelensConfiguration'] = fc;
      }
      if (c.resourceRequirements && c.resourceRequirements.length > 0) {
        out['ResourceRequirements'] = camelToPascalCaseKeys(c.resourceRequirements);
      }
      if (c.systemControls && c.systemControls.length > 0) {
        out['SystemControls'] = camelToPascalCaseKeys(c.systemControls);
      }
      if (c.extraHosts && c.extraHosts.length > 0) {
        out['ExtraHosts'] = camelToPascalCaseKeys(c.extraHosts);
      }
      if (c.restartPolicy) out['RestartPolicy'] = camelToPascalCaseKeys(c.restartPolicy);
      if (c.dnsServers && c.dnsServers.length > 0) out['DnsServers'] = [...c.dnsServers];
      if (c.dnsSearchDomains && c.dnsSearchDomains.length > 0) {
        out['DnsSearchDomains'] = [...c.dnsSearchDomains];
      }
      if (c.dockerSecurityOptions && c.dockerSecurityOptions.length > 0) {
        out['DockerSecurityOptions'] = [...c.dockerSecurityOptions];
      }
      if (c.credentialSpecs && c.credentialSpecs.length > 0) {
        out['CredentialSpecs'] = [...c.credentialSpecs];
      }
      if (c.hostname !== undefined) out['Hostname'] = c.hostname;
      // AWS returns `versionConsistency: 'enabled'` by default even when the
      // template omits it, so drop that default to equal "absent" (mirrors the
      // Cpu: 0 / empty-array normalization above); a non-default 'disabled'
      // still surfaces so real drift is caught.
      if (c.versionConsistency !== undefined && c.versionConsistency !== 'enabled') {
        out['VersionConsistency'] = c.versionConsistency;
      }
      return out;
    });
  }

  /**
   * Reverse of `convertLogConfiguration` for `containerDefinitionsToCfn`.
   * `LogDriver` flips; `Options` is a free-form log-driver option map copied
   * verbatim (its keys, e.g. `awslogs-group`, are NOT CFn property names);
   * `SecretOptions` is a `{Name, ValueFrom}[]` list. Emit-when-present so an
   * absent / empty sub-field does not phantom-drift.
   */
  private logConfigurationToCfn(lc: LogConfiguration): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    if (lc.logDriver !== undefined) out['LogDriver'] = lc.logDriver;
    if (lc.options && Object.keys(lc.options).length > 0) out['Options'] = { ...lc.options };
    if (lc.secretOptions && lc.secretOptions.length > 0) {
      out['SecretOptions'] = lc.secretOptions.map((s) => ({
        Name: s.name,
        ValueFrom: s.valueFrom,
      }));
    }
    return out;
  }

  /**
   * Reverse of `convertLinuxParameters` for `containerDefinitionsToCfn`. The
   * SET side is a mechanical first-letter flip (`pascalToCamelCaseKeys`), so the
   * read side is the inverse `camelToPascalCaseKeys` — plus normalization of the
   * AWS-defaulted-empty `Capabilities` / `Devices` / `Tmpfs`: AWS returns
   * `capabilities: {add:[], drop:[]}` even when the template set neither, so the
   * empty `Add` / `Drop` (and an otherwise-empty `Capabilities`) and empty
   * `Devices` / `Tmpfs` arrays are dropped to equal a template that omits them.
   */
  private linuxParametersToCfn(lp: LinuxParameters): Record<string, unknown> {
    const out = camelToPascalCaseKeys(lp) as Record<string, unknown>;
    const caps = out['Capabilities'] as Record<string, unknown> | undefined;
    if (caps) {
      const normalized: Record<string, unknown> = {};
      if (Array.isArray(caps['Add']) && caps['Add'].length > 0) normalized['Add'] = caps['Add'];
      if (Array.isArray(caps['Drop']) && caps['Drop'].length > 0) normalized['Drop'] = caps['Drop'];
      if (Object.keys(normalized).length > 0) out['Capabilities'] = normalized;
      else delete out['Capabilities'];
    }
    for (const key of ['Devices', 'Tmpfs']) {
      if (Array.isArray(out[key]) && (out[key] as unknown[]).length === 0) delete out[key];
    }
    return out;
  }

  /**
   * Coerce a CFn boolean property to a real boolean at the wire boundary.
   * CFn templates can carry booleans as the strings "true" / "false"
   * (e.g. via Fn::Sub / parameter plumbing), so the SDK input must
   * normalize both. Returns `undefined` for absent props so the field is
   * omitted from the SDK input (AWS keeps its default) rather than being
   * forced to `false`.
   */
  private coerceBool(value: unknown): boolean | undefined {
    if (value === undefined || value === null) return undefined;
    if (typeof value === 'boolean') return value;
    if (value === 'true') return true;
    if (value === 'false') return false;
    return undefined;
  }

  /**
   * Convert CFn NetworkConfiguration to ECS SDK format
   */
  /**
   * Convert CFn PascalCase LoadBalancers to SDK camelCase
   */
  private convertLoadBalancers(lbs?: Array<Record<string, unknown>>): LoadBalancer[] | undefined {
    if (!lbs) return undefined;
    return lbs.map((lb) => ({
      targetGroupArn: lb['TargetGroupArn'] as string | undefined,
      containerName: lb['ContainerName'] as string | undefined,
      containerPort: lb['ContainerPort'] as number | undefined,
      loadBalancerName: lb['LoadBalancerName'] as string | undefined,
      // Blue/green deployment block (AlternateTargetGroupArn /
      // ProductionListenerRule / TestListenerRule / RoleArn) — every member is
      // a pure first-letter case flip, so the shared recursive converter
      // delivers the whole subtree including members CFn adds later.
      advancedConfiguration: lb['AdvancedConfiguration']
        ? (pascalToCamelCaseKeys(lb['AdvancedConfiguration']) as AdvancedConfiguration)
        : undefined,
    }));
  }

  /**
   * Convert the CFn PascalCase `DeploymentConfiguration` block to the ECS SDK
   * camelCase input shape (issue #1165). Every field is a pure first-letter
   * case flip (`MaximumPercent` -> `maximumPercent`, `DeploymentCircuitBreaker`
   * -> `deploymentCircuitBreaker` with `{Enable, Rollback}` -> `{enable,
   * rollback}`, `Alarms.AlarmNames` -> `alarms.alarmNames`, and the blue/green
   * `Strategy` / `BakeTimeInMinutes` / `LifecycleHooks` / `LinearConfiguration`
   * / `CanaryConfiguration` fields), so the shared recursive key-flip converter
   * handles the whole subtree — including fields CDK/CFn add later, which avoids
   * re-introducing the silent-drop this fix closes. The one exception is
   * `LifecycleHooks[].HookDetails`, a free-form document copied verbatim (see
   * `DEPLOYMENT_CONFIG_PRESERVE_KEYS`).
   *
   * Before this fix the block was passed RAW into the SDK's camelCase
   * `deploymentConfiguration` field, so the SDK read `.maximumPercent` (absent)
   * and serialized nothing — a custom `minHealthyPercent` / `maxHealthyPercent`
   * / circuit breaker / deployment alarms deployed as the AWS defaults, silently
   * (state recorded the intended value, `cdkd diff` showed "No changes").
   */
  private convertDeploymentConfiguration(
    config?: Record<string, unknown>
  ): DeploymentConfiguration | undefined {
    if (!config) return undefined;
    return pascalToCamelCaseKeys(
      config,
      DEPLOYMENT_CONFIG_PRESERVE_KEYS
    ) as DeploymentConfiguration;
  }

  /**
   * Convert the CFn PascalCase `CapacityProviderStrategy` array to the ECS SDK
   * camelCase input shape (issue #1165). Each element `{CapacityProvider,
   * Weight, Base}` is a pure first-letter case flip to `{capacityProvider,
   * weight, base}`.
   */
  private convertCapacityProviderStrategy(
    items?: Array<Record<string, unknown>>
  ): CapacityProviderStrategyItem[] | undefined {
    if (!items) return undefined;
    return pascalToCamelCaseKeys(items) as CapacityProviderStrategyItem[];
  }

  /**
   * Convert the CFn PascalCase `PlacementConstraints` array to the ECS SDK
   * camelCase input shape (issue #1165). Each element `{Type, Expression}` ->
   * `{type, expression}`.
   */
  private convertPlacementConstraints(
    items?: Array<Record<string, unknown>>
  ): PlacementConstraint[] | undefined {
    if (!items) return undefined;
    return pascalToCamelCaseKeys(items) as PlacementConstraint[];
  }

  /**
   * Convert the CFn PascalCase `PlacementStrategies` array to the ECS SDK
   * camelCase input shape (issue #1165). Each element `{Type, Field}` ->
   * `{type, field}`.
   */
  private convertPlacementStrategies(
    items?: Array<Record<string, unknown>>
  ): PlacementStrategy[] | undefined {
    if (!items) return undefined;
    return pascalToCamelCaseKeys(items) as PlacementStrategy[];
  }

  /**
   * Convert the CFn PascalCase `ServiceRegistries` array to the ECS SDK
   * camelCase input shape (issue #1165). Each element `{RegistryArn, Port,
   * ContainerName, ContainerPort}` -> `{registryArn, port, containerName,
   * containerPort}`.
   */
  private convertServiceRegistries(
    items?: Array<Record<string, unknown>>
  ): ServiceRegistry[] | undefined {
    if (!items) return undefined;
    return pascalToCamelCaseKeys(items) as ServiceRegistry[];
  }

  /**
   * Convert the CFn PascalCase `DeploymentController` block (`{Type}`) to the
   * ECS SDK camelCase input shape (`{type}`) — a pure first-letter flip
   * (issue #609).
   */
  private convertDeploymentController(
    config?: Record<string, unknown>
  ): DeploymentController | undefined {
    if (!config) return undefined;
    return pascalToCamelCaseKeys(config) as DeploymentController;
  }

  /**
   * Convert the CFn PascalCase `ServiceConnectConfiguration` block to the ECS
   * SDK camelCase input shape (issue #609). Every key in the subtree is a pure
   * first-letter flip (`Enabled` / `Namespace` / `Services[].{PortName,
   * DiscoveryName, ClientAliases, IngressPortOverride, Timeout, Tls}` /
   * `LogConfiguration` / `AccessLogConfiguration`), so the shared recursive
   * converter delivers the whole subtree — EXCEPT
   * `LogConfiguration.Options`, a free-form log-driver option map copied
   * verbatim (see {@link SERVICE_CONNECT_PRESERVE_KEYS}).
   */
  private convertServiceConnectConfiguration(
    config?: Record<string, unknown>
  ): ServiceConnectConfiguration | undefined {
    if (!config) return undefined;
    return pascalToCamelCaseKeys(
      config,
      SERVICE_CONNECT_PRESERVE_KEYS
    ) as ServiceConnectConfiguration;
  }

  /**
   * Convert the CFn PascalCase `VolumeConfigurations` array to the ECS SDK
   * camelCase input shape (issue #609). Every key is a pure first-letter flip
   * — including the two spellings worth calling out: `ManagedEBSVolume` ->
   * `managedEBSVolume` and `SizeInGiB` -> `sizeInGiB` (both verified against
   * the SDK model; only the FIRST character flips, the interior case is
   * identical), so the shared recursive converter delivers the whole subtree
   * (`Encrypted` / `KmsKeyId` / `VolumeType` / `SnapshotId` /
   * `VolumeInitializationRate` / `Iops` / `Throughput` / `TagSpecifications`
   * / `RoleArn` / `FilesystemType`).
   */
  private convertServiceVolumeConfigurations(
    items?: Array<Record<string, unknown>>
  ): ServiceVolumeConfiguration[] | undefined {
    if (!items) return undefined;
    return pascalToCamelCaseKeys(items) as ServiceVolumeConfiguration[];
  }

  /**
   * Convert the CFn PascalCase `VpcLatticeConfigurations` array to the ECS
   * SDK camelCase input shape (issue #609). Each element `{RoleArn,
   * TargetGroupArn, PortName}` is a pure first-letter flip.
   */
  private convertVpcLatticeConfigurations(
    items?: Array<Record<string, unknown>>
  ): VpcLatticeConfiguration[] | undefined {
    if (!items) return undefined;
    return pascalToCamelCaseKeys(items) as VpcLatticeConfiguration[];
  }

  /**
   * Convert the CFn PascalCase `Monitoring` block to the ECS SDK camelCase
   * `monitoring` input shape (issue #609). Every key is a pure first-letter
   * flip (`MetricConfigurations[].{MetricNames, ResolutionSeconds}`).
   */
  private convertMonitoringConfiguration(
    config?: Record<string, unknown>
  ): MonitoringConfiguration | undefined {
    if (!config) return undefined;
    return pascalToCamelCaseKeys(config) as MonitoringConfiguration;
  }

  /**
   * Translate the CFn-only `ForceNewDeployment` trigger object
   * (`{EnableForceNewDeployment, ForceNewDeploymentNonce}`) into the SDK's
   * plain `forceNewDeployment` boolean on UpdateService (issue #609).
   *
   * A forced rollout is requested when EITHER the template says
   * `EnableForceNewDeployment: true` OR the nonce changed vs the previous
   * deploy's recorded value (introducing a nonce counts as a change). On any
   * other shape — block absent, malformed, enable false with an unchanged
   * nonce — return `undefined` so the field is omitted (AWS's documented
   * default: deployments are not forced).
   *
   * Create-path: deliberate no-op — CreateService has no such member, and the
   * initial deployment IS a fresh rollout by definition.
   *
   * This is UPDATE-path code, so a malformed desired block WARNS and skips
   * rather than throwing (the config-shape doctrine: a rollback replays
   * `update()` with a historical state record as the desired bag).
   */
  private resolveForceNewDeployment(
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>
  ): boolean | undefined {
    const desired = properties['ForceNewDeployment'];
    if (desired == null) return undefined;
    if (typeof desired !== 'object' || Array.isArray(desired)) {
      this.logger.warn(
        `AWS::ECS::Service ForceNewDeployment is not an object (got ${Array.isArray(desired) ? 'array' : typeof desired}); skipping the forced-rollout translation`
      );
      return undefined;
    }
    const block = desired as Record<string, unknown>;
    const enable = this.coerceBool(block['EnableForceNewDeployment']);
    const nonce = block['ForceNewDeploymentNonce'];
    const previous = previousProperties['ForceNewDeployment'];
    const previousNonce =
      previous != null && typeof previous === 'object' && !Array.isArray(previous)
        ? (previous as Record<string, unknown>)['ForceNewDeploymentNonce']
        : undefined;
    // Value comparison, not identity: a non-string nonce (a number, or an
    // unresolved-intrinsic object surviving to this layer) is a fresh object
    // reference on every deploy, and an identity compare would read it as
    // "changed" and force a spurious rollout on EVERY update (review catch).
    const nonceChanged =
      nonce !== undefined && JSON.stringify(nonce) !== JSON.stringify(previousNonce);
    return enable === true || nonceChanged ? true : undefined;
  }

  /**
   * Convert the CFn PascalCase `TaskDefinition.RuntimePlatform` to the ECS SDK
   * camelCase input shape (issue #1165). `{CpuArchitecture,
   * OperatingSystemFamily}` -> `{cpuArchitecture, operatingSystemFamily}`.
   *
   * High-impact: before the fix a `RuntimePlatform: { CpuArchitecture: ARM64 }`
   * (Graviton Fargate) was passed raw into the SDK's camelCase slot and
   * silently dropped, so the task definition registered as the default X86_64.
   */
  private convertRuntimePlatform(config?: Record<string, unknown>): RuntimePlatform | undefined {
    if (!config) return undefined;
    return pascalToCamelCaseKeys(config) as RuntimePlatform;
  }

  /**
   * Convert the CFn PascalCase `TaskDefinition.EphemeralStorage` to the ECS SDK
   * camelCase input shape (issue #1165). `{SizeInGiB}` -> `{sizeInGiB}` — the
   * value under the wrong-cased key was silently dropped before the fix, so a
   * custom ephemeral storage size reverted to the AWS default.
   */
  private convertEphemeralStorage(
    config?: Record<string, unknown>
  ): { sizeInGiB: number } | undefined {
    if (!config) return undefined;
    return pascalToCamelCaseKeys(config) as { sizeInGiB: number };
  }

  /**
   * Convert the CFn PascalCase `Cluster.Configuration` to the ECS SDK camelCase
   * input shape (issue #1165). Every key is a pure first-letter flip
   * (`ExecuteCommandConfiguration` / `ManagedStorageConfiguration` and their
   * nested `KmsKeyId` / `LogConfiguration` / `CloudWatchLogGroupName` /
   * `S3BucketName` fields), so the shared recursive converter handles the whole
   * subtree.
   */
  private convertClusterConfiguration(
    config?: Record<string, unknown>
  ): ClusterConfiguration | undefined {
    if (!config) return undefined;
    return pascalToCamelCaseKeys(config) as ClusterConfiguration;
  }

  /**
   * Convert the CFn PascalCase `TaskDefinition.ProxyConfiguration` to the ECS
   * SDK camelCase input shape (issue #1165). Unlike the other nested fields,
   * this is NOT a pure first-letter flip: the CFn key
   * `ProxyConfigurationProperties` maps to the SDK's `properties` field (a
   * `KeyValuePair[]`), so it needs an explicit remap rather than the recursive
   * converter.
   */
  private convertProxyConfiguration(
    config?: Record<string, unknown>
  ): ProxyConfiguration | undefined {
    if (!config) return undefined;
    return {
      type: config['Type'] as ProxyConfiguration['type'],
      containerName: config['ContainerName'] as string | undefined,
      properties: this.convertEnvironment(
        config['ProxyConfigurationProperties'] as Array<Record<string, unknown>> | undefined
      ),
    };
  }

  /**
   * Convert the CFn PascalCase `TaskDefinition.PlacementConstraints` array to
   * the ECS SDK camelCase input shape (issue #1165). Each element `{Type,
   * Expression}` -> `{type, expression}`. Distinct from the Service's
   * `PlacementConstraints` only in the SDK element type
   * (`TaskDefinitionPlacementConstraint` vs `PlacementConstraint`); both are a
   * pure first-letter flip.
   */
  private convertTaskDefinitionPlacementConstraints(
    items?: Array<Record<string, unknown>>
  ): TaskDefinitionPlacementConstraint[] | undefined {
    if (!items) return undefined;
    return pascalToCamelCaseKeys(items) as TaskDefinitionPlacementConstraint[];
  }

  /**
   * Convert the CFn PascalCase `ContainerDefinitions[].LinuxParameters` to the
   * ECS SDK camelCase input shape (issue #1165). Every key is a pure
   * first-letter flip (`Capabilities.{Add,Drop}`, `Devices[].{HostPath,
   * ContainerPath,Permissions}`, `Tmpfs[].{ContainerPath,Size,MountOptions}`,
   * `InitProcessEnabled` / `SharedMemorySize` / `MaxSwap` / `Swappiness`), so
   * the shared recursive converter handles the whole subtree. Before this fix
   * the block was passed raw, so a `LinuxParameters.Capabilities` /
   * `Devices` / `InitProcessEnabled` was silently dropped on register.
   */
  private convertLinuxParameters(config?: Record<string, unknown>): LinuxParameters | undefined {
    if (!config) return undefined;
    return pascalToCamelCaseKeys(config) as LinuxParameters;
  }

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

  /**
   * State property paths `readCurrentState` deliberately cannot read back
   * from AWS (issue #609) — fed into the drift comparator's `ignorePaths` so
   * a template that sets them does not phantom-drift as "removed" on every
   * run:
   *   - `ServiceConnectConfiguration` / `VolumeConfigurations` /
   *     `VpcLatticeConfigurations`: DescribeServices does not return them on
   *     the top-level `Service` shape (they surface only per-deployment
   *     under `deployments[]`, which is rollout metadata, not service
   *     config). `VolumeConfigurations` is also registry-recorded write-only.
   *   - `Monitoring`: not returned by DescribeServices at all.
   *   - `ForceNewDeployment`: a write-only rollout trigger, not persisted
   *     service state.
   *   - `Role`: AWS reports `Service.roleArn` as the service-linked
   *     AWSServiceRoleForECS ARN when the template omits Role, and always as
   *     a full ARN when the template may carry a bare role name — a
   *     mechanical reverse-map would manufacture drift in both directions.
   */
  getDriftUnknownPaths(resourceType: string): string[] {
    if (resourceType === 'AWS::ECS::Service') {
      return [
        'ServiceConnectConfiguration',
        'VolumeConfigurations',
        'VpcLatticeConfigurations',
        'Monitoring',
        'ForceNewDeployment',
        'Role',
      ];
    }
    return [];
  }

  /**
   * Read the AWS-current ECS resource configuration in CFn-property shape.
   *
   * Dispatches by resource type:
   *   - `AWS::ECS::Cluster` → `DescribeClusters`
   *   - `AWS::ECS::Service` → `DescribeServices`. Service physicalIds come in
   *     two forms — the service ARN (what `createService` stores) and the
   *     composite `<clusterArn>|<serviceName>` — and both are accepted (#1170).
   *   - `AWS::ECS::TaskDefinition` → `DescribeTaskDefinition`
   *
   * Each branch surfaces only the keys cdkd's `create()` accepts, mapping
   * the SDK's camelCase to CFn PascalCase. Tags are surfaced via
   * `DescribeClusters/Services(include=[TAGS])` for cluster / service, and
   * via `DescribeTaskDefinition(include=[TAGS])` for task definitions —
   * with CDK's `aws:*` auto-tags filtered out. Tag-result keys are omitted
   * when AWS reports no user tags.
   */
  async readCurrentState(
    physicalId: string,
    _logicalId: string,
    resourceType: string
  ): Promise<Record<string, unknown> | undefined> {
    switch (resourceType) {
      case 'AWS::ECS::Cluster':
        return this.readCurrentStateCluster(physicalId);
      case 'AWS::ECS::Service':
        return this.readCurrentStateService(physicalId);
      case 'AWS::ECS::TaskDefinition':
        return this.readCurrentStateTaskDefinition(physicalId);
      default:
        return undefined;
    }
  }

  private async readCurrentStateCluster(
    physicalId: string
  ): Promise<Record<string, unknown> | undefined> {
    let resp: {
      clusters?: Array<{
        clusterName?: string;
        capacityProviders?: string[];
        defaultCapacityProviderStrategy?: CapacityProviderStrategyItem[];
        configuration?: ClusterConfiguration;
        settings?: Array<{ name?: string; value?: string }>;
        serviceConnectDefaults?: { namespace?: string };
        tags?: Array<{ key?: string; value?: string }>;
      }>;
    };
    try {
      resp = (await this.getClient().send(
        // AWS DescribeClusters omits `settings` / `configuration` from the
        // response unless they are explicitly requested via `include`. Without
        // SETTINGS / CONFIGURATIONS the readCurrentState round-trip silently
        // surfaces empty `ClusterSettings: []` even when the cluster has
        // containerInsights enabled — a console-side toggle then can't be
        // detected as drift because both the deploy-time observedProperties
        // baseline AND the drift-time AWS read would identically miss the
        // field. Discovered by the drift-revert integ test (PR #201).
        new DescribeClustersCommand({
          clusters: [physicalId],
          include: ['TAGS', 'SETTINGS', 'CONFIGURATIONS'],
        })
      )) as unknown as typeof resp;
    } catch {
      return undefined;
    }
    const c = resp.clusters?.[0];
    if (!c || !c.clusterName) return undefined;

    const result: Record<string, unknown> = { ClusterName: c.clusterName };
    result['CapacityProviders'] = c.capacityProviders ? [...c.capacityProviders] : [];
    // Reverse-map SDK camelCase -> CFn PascalCase so the drift baseline
    // (state `properties`, PascalCase) and this AWS-current read compare
    // apples-to-apples (issue #1167 — mirror of the #1165 SET-path fix).
    result['DefaultCapacityProviderStrategy'] = camelToPascalCaseKeys(
      c.defaultCapacityProviderStrategy ?? []
    );
    if (c.configuration) result['Configuration'] = camelToPascalCaseKeys(c.configuration);
    result['ClusterSettings'] = (c.settings ?? []).map((s) => ({
      Name: s.name,
      Value: s.value,
    }));
    // `ServiceConnectDefaults`: emit-when-present (NOT a default-when-absent
    // placeholder — a cluster that never set a default Service Connect
    // namespace returns no `serviceConnectDefaults` from `DescribeClusters`,
    // and emitting a phantom `{ Namespace: '' }` placeholder would force
    // guaranteed drift on every clean run for the typical case).
    if (c.serviceConnectDefaults?.namespace !== undefined) {
      result['ServiceConnectDefaults'] = { Namespace: c.serviceConnectDefaults.namespace };
    }
    const tags = normalizeAwsTagsToCfn(c.tags);
    result['Tags'] = tags;
    return result;
  }

  private async readCurrentStateService(
    physicalId: string
  ): Promise<Record<string, unknown> | undefined> {
    // Service physicalId can be either the composite form `<clusterArn>|<serviceName>`
    // or the service ARN. `createService` stores the ARN (which has no `|`), so a
    // clusterArn|name split alone made `cdkd drift` report every cdkd-created
    // Service as drift-unknown (issue #1170). Accept BOTH: the composite form
    // still splits on `|`, while the ARN form derives the cluster from the ARN
    // (DescribeServices scopes to that cluster, falling back to the default
    // cluster when the legacy short-format ARN does not encode one).
    // `cluster` holds a cluster ARN (composite form) or a cluster name (derived
    // from the service ARN); DescribeServices accepts either, or the default
    // cluster when undefined.
    let cluster: string | undefined;
    let serviceName: string;
    const sep = physicalId.indexOf('|');
    if (sep >= 0) {
      cluster = physicalId.substring(0, sep);
      serviceName = physicalId.substring(sep + 1);
    } else {
      serviceName = physicalId;
      cluster = clusterNameFromServiceArn(physicalId);
    }

    let resp: {
      services?: Array<{
        serviceName?: string;
        clusterArn?: string;
        taskDefinition?: string;
        desiredCount?: number;
        launchType?: string;
        platformVersion?: string;
        schedulingStrategy?: string;
        propagateTags?: string;
        enableECSManagedTags?: boolean;
        enableExecuteCommand?: boolean;
        healthCheckGracePeriodSeconds?: number;
        networkConfiguration?: NetworkConfiguration;
        loadBalancers?: LoadBalancer[];
        capacityProviderStrategy?: CapacityProviderStrategyItem[];
        deploymentConfiguration?: DeploymentConfiguration;
        placementConstraints?: PlacementConstraint[];
        placementStrategy?: PlacementStrategy[];
        serviceRegistries?: ServiceRegistry[];
        availabilityZoneRebalancing?: string;
        deploymentController?: DeploymentController;
        tags?: Array<{ key?: string; value?: string }>;
      }>;
    };
    try {
      resp = (await this.getClient().send(
        new DescribeServicesCommand({
          cluster,
          services: [serviceName],
          include: ['TAGS'],
        })
      )) as unknown as typeof resp;
    } catch {
      return undefined;
    }
    const s = resp.services?.[0];
    if (!s || !s.serviceName) return undefined;

    const result: Record<string, unknown> = {};
    if (s.serviceName !== undefined) result['ServiceName'] = s.serviceName;
    if (s.clusterArn !== undefined) result['Cluster'] = s.clusterArn;
    if (s.taskDefinition !== undefined) result['TaskDefinition'] = s.taskDefinition;
    if (s.desiredCount !== undefined) result['DesiredCount'] = s.desiredCount;
    if (s.launchType !== undefined) result['LaunchType'] = s.launchType;
    if (s.platformVersion !== undefined) result['PlatformVersion'] = s.platformVersion;
    if (s.schedulingStrategy !== undefined) result['SchedulingStrategy'] = s.schedulingStrategy;
    if (s.propagateTags !== undefined) result['PropagateTags'] = s.propagateTags;
    if (s.enableECSManagedTags !== undefined) {
      result['EnableECSManagedTags'] = s.enableECSManagedTags;
    }
    if (s.enableExecuteCommand !== undefined) {
      result['EnableExecuteCommand'] = s.enableExecuteCommand;
    }
    if (s.healthCheckGracePeriodSeconds !== undefined) {
      result['HealthCheckGracePeriodSeconds'] = s.healthCheckGracePeriodSeconds;
    }
    // NetworkConfiguration / LoadBalancers are also converted on the SET path
    // (convertNetworkConfiguration / convertLoadBalancers); reverse-map them here
    // too so the read side is consistently PascalCase (issue #1167). Both are
    // pure first-letter flips (`awsvpcConfiguration.{subnets,securityGroups,
    // assignPublicIp}`, `{targetGroupArn,containerName,containerPort,
    // loadBalancerName,advancedConfiguration.{alternateTargetGroupArn,
    // productionListenerRule,testListenerRule,roleArn}}` — issue #1473).
    if (s.networkConfiguration) {
      result['NetworkConfiguration'] = camelToPascalCaseKeys(s.networkConfiguration);
    }
    result['LoadBalancers'] = camelToPascalCaseKeys(s.loadBalancers ?? []);
    // Class 1: LaunchType vs CapacityProviderStrategy are mutually exclusive
    // on the AWS API side. UpdateService rejects when both arrive together
    // (e.g. `launchType=FARGATE` + `capacityProviderStrategy=[]`). Skip the
    // empty placeholder when LaunchType is set so `cdkd drift --revert`
    // doesn't push a structurally-invalid input back to AWS. A non-empty
    // strategy still surfaces (drift detection on the strategy itself).
    // Reverse-map SDK camelCase -> CFn PascalCase (issue #1167 — mirror of the
    // #1165 SET-path fix) so a resource whose drift baseline falls back to the
    // template `properties` (PascalCase) does not phantom-drift on these nested
    // fields. `DeploymentConfiguration.LifecycleHooks[].HookDetails` is a
    // free-form document copied verbatim.
    if (s.capacityProviderStrategy && s.capacityProviderStrategy.length > 0) {
      result['CapacityProviderStrategy'] = camelToPascalCaseKeys(s.capacityProviderStrategy);
    } else if (!s.launchType) {
      result['CapacityProviderStrategy'] = [];
    }
    if (s.deploymentConfiguration) {
      result['DeploymentConfiguration'] = camelToPascalCaseKeys(
        s.deploymentConfiguration,
        DEPLOYMENT_CONFIG_PRESERVE_KEYS_CAMEL
      );
    }
    result['PlacementConstraints'] = camelToPascalCaseKeys(s.placementConstraints ?? []);
    // Class 1: PlacementStrategy is EC2-only. Emitting `[]` on a Fargate
    // service means `cdkd drift --revert` pushes `placementStrategy: []` to
    // UpdateService, which AWS rejects with "Placement strategies are not
    // valid for tasks using the Fargate launch type." Discriminator-gated
    // emit: only surface PlacementStrategy when LaunchType is EC2 (or
    // EXTERNAL) — Fargate services cannot legally have one, so the emit
    // would never detect a real console-side change anyway.
    // CFn schema spells this property `PlacementStrategies` (plural);
    // AWS API uses the singular `placementStrategy`. Emit BOTH names so
    // drift comparison works for state files written by either name —
    // pre-#613-fix templates that wrote the legacy `PlacementStrategy`
    // AND post-fix templates that use the CFn-canonical
    // `PlacementStrategies` both round-trip cleanly.
    if (s.launchType === 'EC2' || s.launchType === 'EXTERNAL') {
      const strategy = camelToPascalCaseKeys(s.placementStrategy ?? []);
      result['PlacementStrategy'] = strategy;
      result['PlacementStrategies'] = strategy;
    } else if (s.placementStrategy && s.placementStrategy.length > 0) {
      // Defensive: surface a non-empty strategy regardless of launch type
      // (so drift still flags an out-of-band attach if AWS ever permits it).
      const strategy = camelToPascalCaseKeys(s.placementStrategy);
      result['PlacementStrategy'] = strategy;
      result['PlacementStrategies'] = strategy;
    }
    result['ServiceRegistries'] = camelToPascalCaseKeys(s.serviceRegistries ?? []);
    // issue #609 read-back additions. Only what the top-level `Service` shape
    // actually returns is surfaced: DescribeServices does NOT return
    // `serviceConnectConfiguration` / `volumeConfigurations` /
    // `vpcLatticeConfigurations` / `monitoring` on the Service itself (the
    // first three only appear per-deployment under `deployments[]`), and
    // `ForceNewDeployment` is a write-only rollout trigger — all five are
    // declared in `getDriftUnknownPaths` instead of being fabricated here.
    // `Role` is deliberately NOT reverse-mapped from `Service.roleArn`: for
    // the typical template that omits Role, AWS reports the
    // AWSServiceRoleForECS service-linked role ARN there, and a template that
    // DOES set Role may carry a role NAME while AWS always reports the full
    // ARN — either way a mechanical read-back would manufacture phantom
    // drift, so Role is also covered by `getDriftUnknownPaths`.
    if (s.availabilityZoneRebalancing !== undefined) {
      result['AvailabilityZoneRebalancing'] = s.availabilityZoneRebalancing;
    }
    // DescribeServices omits `deploymentController` for services on the
    // default ECS controller (the SDK API doc: "If a service is using the ECS
    // deployment controller, the deploymentController ... parameters will not
    // be returned"), so an absent field MEANS the ECS controller — emit the
    // CFn shape either way so an explicit `DeploymentController: {Type: ECS}`
    // template does not phantom-drift. UNVERIFIED-LIVE: whether current
    // DescribeServices echoes the controller for ECS-controller services; the
    // fallback makes both behaviors correct.
    result['DeploymentController'] = { Type: s.deploymentController?.type ?? 'ECS' };
    const tags = normalizeAwsTagsToCfn(s.tags);
    result['Tags'] = tags;
    return result;
  }

  private async readCurrentStateTaskDefinition(
    physicalId: string
  ): Promise<Record<string, unknown> | undefined> {
    let resp: {
      taskDefinition?: {
        family?: string;
        cpu?: string;
        memory?: string;
        networkMode?: string;
        requiresCompatibilities?: string[];
        executionRoleArn?: string;
        taskRoleArn?: string;
        volumes?: Volume[];
        placementConstraints?: TaskDefinitionPlacementConstraint[];
        runtimePlatform?: RuntimePlatform;
        proxyConfiguration?: ProxyConfiguration;
        pidMode?: string;
        ipcMode?: string;
        ephemeralStorage?: { sizeInGiB?: number };
        enableFaultInjection?: boolean;
        containerDefinitions?: ContainerDefinition[];
      };
      tags?: Array<{ key?: string; value?: string }>;
    };
    try {
      resp = (await this.getClient().send(
        new DescribeTaskDefinitionCommand({ taskDefinition: physicalId, include: ['TAGS'] })
      )) as unknown as typeof resp;
    } catch {
      return undefined;
    }
    const td = resp.taskDefinition;
    if (!td) return undefined;

    const result: Record<string, unknown> = {};
    if (td.family !== undefined) result['Family'] = td.family;
    if (td.cpu !== undefined) result['Cpu'] = td.cpu;
    if (td.memory !== undefined) result['Memory'] = td.memory;
    if (td.networkMode !== undefined) result['NetworkMode'] = td.networkMode;
    result['RequiresCompatibilities'] = td.requiresCompatibilities
      ? [...td.requiresCompatibilities]
      : [];
    if (td.executionRoleArn !== undefined) result['ExecutionRoleArn'] = td.executionRoleArn;
    if (td.taskRoleArn !== undefined) result['TaskRoleArn'] = td.taskRoleArn;
    result['Volumes'] = this.volumesToCfn(td.volumes);
    // Reverse-map SDK camelCase -> CFn PascalCase (issue #1167 — mirror of the
    // #1165 SET-path fix). `ProxyConfiguration` uses an explicit remap because
    // the SDK field `properties` maps back to CFn `ProxyConfigurationProperties`.
    result['PlacementConstraints'] = camelToPascalCaseKeys(td.placementConstraints ?? []);
    if (td.runtimePlatform) result['RuntimePlatform'] = camelToPascalCaseKeys(td.runtimePlatform);
    if (td.proxyConfiguration) {
      result['ProxyConfiguration'] = this.proxyConfigurationToCfn(td.proxyConfiguration);
    }
    if (td.pidMode !== undefined) result['PidMode'] = td.pidMode;
    if (td.ipcMode !== undefined) result['IpcMode'] = td.ipcMode;
    if (td.ephemeralStorage?.sizeInGiB !== undefined) {
      result['EphemeralStorage'] = { SizeInGiB: td.ephemeralStorage.sizeInGiB };
    }
    if (td.enableFaultInjection !== undefined) {
      result['EnableFaultInjection'] = td.enableFaultInjection;
    }
    // Reverse-map the container definitions from SDK camelCase to CFn
    // PascalCase (issue #1169). The previous raw `td.containerDefinitions`
    // surfaced camelCase, so the drift comparator (which compares this array
    // wholesale via deepEqual) phantom-drifted the whole block against the
    // PascalCase baseline.
    result['ContainerDefinitions'] = this.containerDefinitionsToCfn(td.containerDefinitions);
    const tags = normalizeAwsTagsToCfn(resp.tags);
    result['Tags'] = tags;
    return result;
  }

  /**
   * Adopt an existing ECS resource into cdkd state.
   *
   * Supported types: `AWS::ECS::Cluster`, `AWS::ECS::Service`,
   * `AWS::ECS::TaskDefinition` — all explicit-override only (see the
   * per-branch notes on why the `aws:cdk:path` tag walk was removed).
   *
   * `createService` stores the service ARN as the Service physical id (and
   * the mutation ops pass it straight through as the `service` argument, with
   * the cluster read from the template `Cluster` property). The explicit
   * `--resource` override is honored verbatim, so a caller may also supply the
   * composite `<clusterArn>|<serviceName>` form that `readCurrentState` accepts.
   */
  async import(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    switch (input.resourceType) {
      case 'AWS::ECS::Cluster':
        return this.importCluster(input);
      case 'AWS::ECS::Service':
        return this.importService(input);
      case 'AWS::ECS::TaskDefinition':
        return this.importTaskDefinition(input);
      default:
        return null;
    }
  }

  private async importCluster(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    const explicit = resolveExplicitPhysicalId(input, 'ClusterName');
    if (explicit) {
      try {
        const resp = await this.getClient().send(
          new DescribeClustersCommand({ clusters: [explicit] })
        );
        return resp.clusters?.[0]?.clusterName
          ? { physicalId: resp.clusters[0].clusterName, attributes: {} }
          : null;
      } catch (err) {
        if (this.isClusterNotFoundException(err) || this.isServiceNotFoundException(err)) {
          return null;
        }
        throw err;
      }
    }
    // No `aws:cdk:path` tag walk: AWS rejects `aws:`-prefixed tag writes, so
    // that tag never exists on a real resource and the walk could not match
    // (issue #1134). Auto-mode import resolves ids from CloudFormation's
    // `DescribeStackResources` or the template's physical-name property; a
    // cluster reaching here needs an explicit `--resource` override.
    return null;
  }

  private async importService(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    // `createService` stores the service ARN as the physical id; an explicit
    // override is honored as-is (the composite `<clusterArn>|<serviceName>`
    // form is also accepted by readCurrentState).
    if (input.knownPhysicalId) {
      return { physicalId: input.knownPhysicalId, attributes: {} };
    }
    // No `aws:cdk:path` tag walk: AWS rejects `aws:`-prefixed tag writes, so
    // that tag never exists on a real resource and the walk could not match
    // (issue #1134). Auto-mode import resolves ids from CloudFormation's
    // `DescribeStackResources` or the template's physical-name property; a
    // service reaching here needs an explicit `--resource` override.
    return null;
  }

  private async importTaskDefinition(
    input: ResourceImportInput
  ): Promise<ResourceImportResult | null> {
    // TaskDefinitions are immutable revisions; physical id is the full
    // `family:revision` ARN. CDK templates rarely encode a stable
    // identifier, so we only support explicit overrides for these.
    if (input.knownPhysicalId) {
      try {
        const resp = await this.getClient().send(
          new DescribeTaskDefinitionCommand({ taskDefinition: input.knownPhysicalId })
        );
        const arn = resp.taskDefinition?.taskDefinitionArn;
        return arn ? { physicalId: arn, attributes: {} } : null;
      } catch (err) {
        if (this.isClusterNotFoundException(err) || this.isServiceNotFoundException(err)) {
          return null;
        }
        throw err;
      }
    }
    return null;
  }
}
