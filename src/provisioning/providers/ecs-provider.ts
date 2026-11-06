import {
  ECSClient,
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
  type LinuxParameters,
  type ClusterConfiguration,
  type TaskDefinitionPlacementConstraint,
  type RuntimePlatform,
  type ProxyConfiguration,
  type EFSVolumeConfiguration,
  type S3FilesVolumeConfiguration,
  type EFSAuthorizationConfig,
  type DockerVolumeConfiguration,
  type FSxWindowsFileServerVolumeConfiguration,
  type FSxWindowsFileServerAuthorizationConfig,
  type HostVolumeProperties,
  type FirelensConfiguration,
  type DeploymentController,
  type ServiceConnectConfiguration,
  type ServiceVolumeConfiguration,
  type VpcLatticeConfiguration,
  type GatewayConnector,
  type MonitoringConfiguration,
} from '@aws-sdk/client-ecs';
import { type ConsoleLogger, getLogger } from '../../utils/logger.js';
import { ProvisioningError } from '../../utils/error-handler.js';
import type { DeleteContext } from '../region-check.js';
import type {
  ResourceProvider,
  ResourceCreateResult,
  ResourceDeleteResult,
  ResourceUpdateResult,
  ResourceImportInput,
  ResourceImportResult,
  CreateContext,
  UpdateContext,
  ResourceNotFound,
} from '../../types/resource.js';
import type { MaskedLogSinks, MaskerFn } from '../masked-retry-logger.js';
import { ambientRegion } from '../../utils/stack-aws-scope.js';
import type { AmbiguousCreateWindow } from './ambiguous-create.js';
import type { RequestedRollout } from './ecs/shared.js';
import {
  getClient,
  getTaskDefinitionCreateClient,
  reportPossibleOrphanTaskDefinitions,
  wrapCaughtError,
  operationSinks,
  create,
  update,
  deleteImpl,
  getAttribute,
} from './ecs/core.js';
import {
  createCluster,
  updateCluster,
  deleteCluster,
  getClusterAttribute,
  createTaskDefinition,
  updateTaskDefinition,
  deleteTaskDefinition,
  getTaskDefinitionAttribute,
} from './ecs/cluster-task-definition.js';
import {
  createService,
  serviceNameHeld,
  wrapWaiterResultError,
  wrapSteadyStateError,
  settleService,
} from './ecs/service-create.js';
import { updateService } from './ecs/service-update.js';
import {
  deleteService,
  waitForServiceInactive,
  getServiceAttribute,
  applyTagDiff,
} from './ecs/service-delete.js';
import {
  convertContainerDefinitions,
  convertPortMappings,
  convertEnvironment,
  convertEnvironmentFiles,
  convertSecrets,
  convertMountPoints,
  convertVolumesFrom,
  convertDependsOn,
  convertUlimits,
  convertLogConfiguration,
  convertFirelensConfiguration,
  convertHealthCheck,
  convertVolumes,
  convertS3FilesVolumeConfiguration,
  convertVolumeHost,
  convertDockerVolumeConfiguration,
  convertEFSVolumeConfiguration,
  convertEFSAuthorizationConfig,
  convertFSxWindowsVolumeConfiguration,
  convertFSxWindowsAuthorizationConfig,
} from './ecs/convert-task-definition.js';
import {
  volumesToCfn,
  proxyConfigurationToCfn,
  containerDefinitionsToCfn,
  logConfigurationToCfn,
  linuxParametersToCfn,
  coerceBool,
} from './ecs/task-definition-to-cfn.js';
import {
  convertLoadBalancers,
  convertDeploymentConfiguration,
  resolveDeploymentConfiguration,
  convertCapacityProviderStrategy,
  convertPlacementConstraints,
  convertPlacementStrategies,
  convertServiceRegistries,
  convertDeploymentController,
  convertServiceConnectConfiguration,
  convertServiceVolumeConfigurations,
  convertVpcLatticeConfigurations,
  convertGatewayConnectors,
  convertMonitoringConfiguration,
  resolveForceNewDeployment,
  convertRuntimePlatform,
  convertEphemeralStorage,
  convertClusterConfiguration,
  convertProxyConfiguration,
  convertTaskDefinitionPlacementConstraints,
  convertLinuxParameters,
  convertNetworkConfiguration,
  isClusterNotFoundException,
  isNotFoundException,
  isServiceNotFoundException,
  isServiceNotActiveException,
} from './ecs/convert-service.js';
import {
  getDriftUnknownPaths,
  readCurrentState,
  readCurrentStateCluster,
  readCurrentStateService,
  readCurrentStateTaskDefinition,
} from './ecs/read-state.js';
import {
  generatedCreateName,
  lookupNames,
  importImpl,
  importCluster,
  importService,
  importTaskDefinition,
} from './ecs/import.js';

export {
  resetTaskDefinitionCreateRetryStateForTests,
  CIRCUIT_BREAKER_THRESHOLD_CONFIGURATION_DEFAULT,
  settleRolloutDelays,
  serviceInactiveWait,
  requestedRolloutOf,
  failedRequestedDeployment,
  controllerSkipsWait,
  rolloutSupersededBy,
} from './ecs/shared.js';
export type { RequestedRollout } from './ecs/shared.js';

export class ECSProvider implements ResourceProvider {
  ecsClient?: ECSClient;
  taskDefinitionCreateClient?: ECSClient;
  readonly providerRegion = ambientRegion();
  logger: ConsoleLogger = getLogger().child('ECSProvider');

  /**
   * `removalDefaults` is deliberately EMPTY for `AWS::ECS::Service`. A real
   * CloudFormation A/B (#5004) showed CloudFormation KEEPS the live value when
   * these are removed from the template: CapacityProviderStrategy,
   * PlacementConstraints, PlacementStrategies, PlatformVersion,
   * HealthCheckGracePeriodSeconds, EnableECSManagedTags, PropagateTags,
   * EnableExecuteCommand, (#1160) AvailabilityZoneRebalancing, and (#5634)
   * GatewayConnectors. `UpdateService` keeps an absent member, so sending
   * nothing is parity.
   * ServiceConnectConfiguration, VolumeConfigurations,
   * VpcLatticeConfigurations and Monitoring ARE reset by CloudFormation (see
   * `updateService`). The earlier #1160 resets for the keep list were
   * parity bugs and are removed.
   */
  removalDefaults = new Map<string, ReadonlyMap<string, unknown>>();

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
        // issue #609 backfill — the previously SDK-unwired Service members.
        'AvailabilityZoneRebalancing',
        'DeploymentController',
        'ForceNewDeployment',
        'Monitoring',
        'Role',
        'ServiceConnectConfiguration',
        'VolumeConfigurations',
        'VpcLatticeConfigurations',
        // go-to-k/cdkd#5634 — added by AWS in the 2026-10-20 schema refresh.
        'GatewayConnectors',
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

  getClient(): ECSClient {
    return getClient.call(this);
  }

  getTaskDefinitionCreateClient(): ECSClient {
    return getTaskDefinitionCreateClient.call(this);
  }

  reportPossibleOrphanTaskDefinitions(
    logicalId: string,
    family: string,
    window: AmbiguousCreateWindow,
    log: MaskedLogSinks
  ): Promise<void> {
    return reportPossibleOrphanTaskDefinitions.call(this, logicalId, family, window, log);
  }

  wrapCaughtError(
    mask: MaskerFn,
    error: unknown,
    build: (maskedText: string) => ProvisioningError
  ): ProvisioningError {
    return wrapCaughtError.call(this, mask, error, build);
  }

  operationSinks(
    context: CreateContext | UpdateContext | undefined,
    pairs: ReadonlyArray<readonly [raw: unknown, name: string | undefined]>
  ): MaskedLogSinks {
    return operationSinks.call(this, context, pairs);
  }

  create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    context?: CreateContext
  ): Promise<ResourceCreateResult> {
    return create.call(this, logicalId, resourceType, properties, context);
  }

  update(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>,
    context?: UpdateContext
  ): Promise<ResourceUpdateResult> {
    return update.call(
      this,
      logicalId,
      physicalId,
      resourceType,
      properties,
      previousProperties,
      context
    );
  }

  delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void | ResourceDeleteResult> {
    return deleteImpl.call(this, logicalId, physicalId, resourceType, properties, context);
  }

  getAttribute(physicalId: string, resourceType: string, attributeName: string): Promise<unknown> {
    return getAttribute.call(this, physicalId, resourceType, attributeName);
  }

  createCluster(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    log: MaskedLogSinks
  ): Promise<ResourceCreateResult> {
    return createCluster.call(this, logicalId, resourceType, properties, log);
  }

  updateCluster(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>,
    log: MaskedLogSinks
  ): Promise<ResourceUpdateResult> {
    return updateCluster.call(
      this,
      logicalId,
      physicalId,
      resourceType,
      properties,
      previousProperties,
      log
    );
  }

  deleteCluster(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    context?: DeleteContext
  ): Promise<void> {
    return deleteCluster.call(this, logicalId, physicalId, resourceType, context);
  }

  getClusterAttribute(physicalId: string, attributeName: string): Promise<unknown> {
    return getClusterAttribute.call(this, physicalId, attributeName);
  }

  createTaskDefinition(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    log: MaskedLogSinks
  ): Promise<ResourceCreateResult> {
    return createTaskDefinition.call(this, logicalId, resourceType, properties, log);
  }

  updateTaskDefinition(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>,
    log: MaskedLogSinks,
    maskSecrets: UpdateContext['maskSecrets']
  ): Promise<ResourceUpdateResult> {
    return updateTaskDefinition.call(
      this,
      logicalId,
      physicalId,
      resourceType,
      properties,
      previousProperties,
      log,
      maskSecrets
    );
  }

  deleteTaskDefinition(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    context?: DeleteContext
  ): Promise<void> {
    return deleteTaskDefinition.call(this, logicalId, physicalId, resourceType, context);
  }

  getTaskDefinitionAttribute(physicalId: string, attributeName: string): Promise<unknown> {
    return getTaskDefinitionAttribute.call(this, physicalId, attributeName);
  }

  createService(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    log: MaskedLogSinks,
    /** `CreateContext.replayingState`: a rollback's reverse-replacement re-create. */
    replayingState: boolean
  ): Promise<ResourceCreateResult> {
    return createService.call(this, logicalId, resourceType, properties, log, replayingState);
  }

  serviceNameHeld(cluster: string | undefined, serviceName: string): Promise<boolean> {
    return serviceNameHeld.call(this, cluster, serviceName);
  }

  wrapWaiterResultError(error: unknown, logicalId: string, log: MaskedLogSinks): unknown {
    return wrapWaiterResultError.call(this, error, logicalId, log);
  }

  wrapSteadyStateError(
    logicalId: string,
    waitError: unknown,
    cluster: unknown,
    log: MaskedLogSinks,
    /** `false` where the failure is only warned about (a state-borne replay). */
    offerNoWait = true
  ): Error {
    return wrapSteadyStateError.call(this, logicalId, waitError, cluster, log, offerNoWait);
  }

  settleService(
    logicalId: string,
    serviceRef: string,
    cluster: string | undefined,
    log: MaskedLogSinks,
    requested: RequestedRollout | undefined,
    /**
     * Why this service is not waited for whatever the mode (an ECS-unsettled
     * `DeploymentController`, a `drift --revert`), or `undefined` to follow
     * the run's wait mode.
     */
    skipReason: string | undefined
  ): Promise<void> {
    return settleService.call(this, logicalId, serviceRef, cluster, log, requested, skipReason);
  }

  updateService(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>,
    log: MaskedLogSinks,
    /** `cdkd drift --revert` (`UpdateContext.desiredFromAwsReadback`). */
    desiredFromAwsReadback: boolean,
    /** The rollback executor's revert arms (`UpdateContext.replayingState`). */
    replayingState: boolean
  ): Promise<ResourceUpdateResult> {
    return updateService.call(
      this,
      logicalId,
      physicalId,
      resourceType,
      properties,
      previousProperties,
      log,
      desiredFromAwsReadback,
      replayingState
    );
  }

  deleteService(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void | ResourceDeleteResult> {
    return deleteService.call(this, logicalId, physicalId, resourceType, properties, context);
  }

  waitForServiceInactive(
    logicalId: string,
    physicalId: string,
    cluster: string | undefined,
    resourceType: string
  ): Promise<void> {
    return waitForServiceInactive.call(this, logicalId, physicalId, cluster, resourceType);
  }

  getServiceAttribute(physicalId: string, attributeName: string): Promise<unknown> {
    return getServiceAttribute.call(this, physicalId, attributeName);
  }

  applyTagDiff(
    resourceArn: string,
    resourceType: string,
    logicalId: string,
    oldTagsRaw: unknown,
    newTagsRaw: unknown,
    log: MaskedLogSinks
  ): Promise<void> {
    return applyTagDiff.call(
      this,
      resourceArn,
      resourceType,
      logicalId,
      oldTagsRaw,
      newTagsRaw,
      log
    );
  }

  convertContainerDefinitions(
    defs?: Array<Record<string, unknown>>
  ): ContainerDefinition[] | undefined {
    return convertContainerDefinitions.call(this, defs);
  }

  convertPortMappings(mappings?: Array<Record<string, unknown>>): PortMapping[] | undefined {
    return convertPortMappings.call(this, mappings);
  }

  convertEnvironment(entries?: Array<Record<string, unknown>>): KeyValuePair[] | undefined {
    return convertEnvironment.call(this, entries);
  }

  convertEnvironmentFiles(entries?: Array<Record<string, unknown>>): EnvironmentFile[] | undefined {
    return convertEnvironmentFiles.call(this, entries);
  }

  convertSecrets(entries?: Array<Record<string, unknown>>): Secret[] | undefined {
    return convertSecrets.call(this, entries);
  }

  convertMountPoints(entries?: Array<Record<string, unknown>>): MountPoint[] | undefined {
    return convertMountPoints.call(this, entries);
  }

  convertVolumesFrom(entries?: Array<Record<string, unknown>>): VolumeFrom[] | undefined {
    return convertVolumesFrom.call(this, entries);
  }

  convertDependsOn(entries?: Array<Record<string, unknown>>): ContainerDependency[] | undefined {
    return convertDependsOn.call(this, entries);
  }

  convertUlimits(entries?: Array<Record<string, unknown>>): Ulimit[] | undefined {
    return convertUlimits.call(this, entries);
  }

  convertLogConfiguration(config?: Record<string, unknown>): LogConfiguration | undefined {
    return convertLogConfiguration.call(this, config);
  }

  convertFirelensConfiguration(
    config?: Record<string, unknown>
  ): FirelensConfiguration | undefined {
    return convertFirelensConfiguration.call(this, config);
  }

  convertHealthCheck(check?: Record<string, unknown>): HealthCheck | undefined {
    return convertHealthCheck.call(this, check);
  }

  convertVolumes(volumes?: Array<Record<string, unknown>>): Volume[] | undefined {
    return convertVolumes.call(this, volumes);
  }

  convertS3FilesVolumeConfiguration(
    config?: Record<string, unknown>
  ): S3FilesVolumeConfiguration | undefined {
    return convertS3FilesVolumeConfiguration.call(this, config);
  }

  convertVolumeHost(host?: Record<string, unknown>): HostVolumeProperties | undefined {
    return convertVolumeHost.call(this, host);
  }

  convertDockerVolumeConfiguration(
    config?: Record<string, unknown>
  ): DockerVolumeConfiguration | undefined {
    return convertDockerVolumeConfiguration.call(this, config);
  }

  convertEFSVolumeConfiguration(
    config?: Record<string, unknown>
  ): EFSVolumeConfiguration | undefined {
    return convertEFSVolumeConfiguration.call(this, config);
  }

  convertEFSAuthorizationConfig(
    config?: Record<string, unknown>
  ): EFSAuthorizationConfig | undefined {
    return convertEFSAuthorizationConfig.call(this, config);
  }

  convertFSxWindowsVolumeConfiguration(
    config?: Record<string, unknown>
  ): FSxWindowsFileServerVolumeConfiguration | undefined {
    return convertFSxWindowsVolumeConfiguration.call(this, config);
  }

  convertFSxWindowsAuthorizationConfig(
    config?: Record<string, unknown>
  ): FSxWindowsFileServerAuthorizationConfig | undefined {
    return convertFSxWindowsAuthorizationConfig.call(this, config);
  }

  volumesToCfn(volumes?: Volume[]): Array<Record<string, unknown>> {
    return volumesToCfn.call(this, volumes);
  }

  proxyConfigurationToCfn(config: ProxyConfiguration): Record<string, unknown> {
    return proxyConfigurationToCfn.call(this, config);
  }

  containerDefinitionsToCfn(defs?: ContainerDefinition[]): Array<Record<string, unknown>> {
    return containerDefinitionsToCfn.call(this, defs);
  }

  logConfigurationToCfn(lc: LogConfiguration): Record<string, unknown> {
    return logConfigurationToCfn.call(this, lc);
  }

  linuxParametersToCfn(lp: LinuxParameters): Record<string, unknown> {
    return linuxParametersToCfn.call(this, lp);
  }

  coerceBool(value: unknown): boolean | undefined {
    return coerceBool.call(this, value);
  }

  convertLoadBalancers(lbs?: Array<Record<string, unknown>>): LoadBalancer[] | undefined {
    return convertLoadBalancers.call(this, lbs);
  }

  convertDeploymentConfiguration(
    config?: Record<string, unknown>
  ): DeploymentConfiguration | undefined {
    return convertDeploymentConfiguration.call(this, config);
  }

  resolveDeploymentConfiguration(
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>
  ): DeploymentConfiguration | undefined {
    return resolveDeploymentConfiguration.call(this, properties, previousProperties);
  }

  convertCapacityProviderStrategy(
    items?: Array<Record<string, unknown>>
  ): CapacityProviderStrategyItem[] | undefined {
    return convertCapacityProviderStrategy.call(this, items);
  }

  convertPlacementConstraints(
    items?: Array<Record<string, unknown>>
  ): PlacementConstraint[] | undefined {
    return convertPlacementConstraints.call(this, items);
  }

  convertPlacementStrategies(
    items?: Array<Record<string, unknown>>
  ): PlacementStrategy[] | undefined {
    return convertPlacementStrategies.call(this, items);
  }

  convertServiceRegistries(items?: Array<Record<string, unknown>>): ServiceRegistry[] | undefined {
    return convertServiceRegistries.call(this, items);
  }

  convertDeploymentController(config?: Record<string, unknown>): DeploymentController | undefined {
    return convertDeploymentController.call(this, config);
  }

  convertServiceConnectConfiguration(
    config?: Record<string, unknown>
  ): ServiceConnectConfiguration | undefined {
    return convertServiceConnectConfiguration.call(this, config);
  }

  convertServiceVolumeConfigurations(
    items?: Array<Record<string, unknown>>
  ): ServiceVolumeConfiguration[] | undefined {
    return convertServiceVolumeConfigurations.call(this, items);
  }

  convertVpcLatticeConfigurations(
    items?: Array<Record<string, unknown>>
  ): VpcLatticeConfiguration[] | undefined {
    return convertVpcLatticeConfigurations.call(this, items);
  }

  convertGatewayConnectors(items?: Array<Record<string, unknown>>): GatewayConnector[] | undefined {
    return convertGatewayConnectors.call(this, items);
  }

  convertMonitoringConfiguration(
    config?: Record<string, unknown>
  ): MonitoringConfiguration | undefined {
    return convertMonitoringConfiguration.call(this, config);
  }

  resolveForceNewDeployment(
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>,
    log: MaskedLogSinks
  ): boolean | undefined {
    return resolveForceNewDeployment.call(this, properties, previousProperties, log);
  }

  convertRuntimePlatform(config?: Record<string, unknown>): RuntimePlatform | undefined {
    return convertRuntimePlatform.call(this, config);
  }

  convertEphemeralStorage(config?: Record<string, unknown>): { sizeInGiB: number } | undefined {
    return convertEphemeralStorage.call(this, config);
  }

  convertClusterConfiguration(config?: Record<string, unknown>): ClusterConfiguration | undefined {
    return convertClusterConfiguration.call(this, config);
  }

  convertProxyConfiguration(config?: Record<string, unknown>): ProxyConfiguration | undefined {
    return convertProxyConfiguration.call(this, config);
  }

  convertTaskDefinitionPlacementConstraints(
    items?: Array<Record<string, unknown>>
  ): TaskDefinitionPlacementConstraint[] | undefined {
    return convertTaskDefinitionPlacementConstraints.call(this, items);
  }

  convertLinuxParameters(config?: Record<string, unknown>): LinuxParameters | undefined {
    return convertLinuxParameters.call(this, config);
  }

  convertNetworkConfiguration(config?: Record<string, unknown>): NetworkConfiguration | undefined {
    return convertNetworkConfiguration.call(this, config);
  }

  isClusterNotFoundException(error: unknown): boolean {
    return isClusterNotFoundException.call(this, error);
  }

  isNotFoundException(error: unknown): boolean {
    return isNotFoundException.call(this, error);
  }

  isServiceNotFoundException(error: unknown): boolean {
    return isServiceNotFoundException.call(this, error);
  }

  isServiceNotActiveException(error: unknown): boolean {
    return isServiceNotActiveException.call(this, error);
  }

  getDriftUnknownPaths(resourceType: string): string[] {
    return getDriftUnknownPaths.call(this, resourceType);
  }

  readCurrentState(
    physicalId: string,
    _logicalId: string,
    resourceType: string
  ): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
    return readCurrentState.call(this, physicalId, _logicalId, resourceType);
  }

  readCurrentStateCluster(
    physicalId: string
  ): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
    return readCurrentStateCluster.call(this, physicalId);
  }

  readCurrentStateService(
    physicalId: string
  ): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
    return readCurrentStateService.call(this, physicalId);
  }

  readCurrentStateTaskDefinition(
    physicalId: string
  ): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
    return readCurrentStateTaskDefinition.call(this, physicalId);
  }

  generatedCreateName(
    resourceType: string,
    logicalId: string,
    properties: Record<string, unknown>
  ): string | undefined {
    return generatedCreateName.call(this, resourceType, logicalId, properties);
  }

  lookupNames(resourceType: string, names: readonly string[]): Promise<Map<string, string>> {
    return lookupNames.call(this, resourceType, names);
  }

  import(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    return importImpl.call(this, input);
  }

  importCluster(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    return importCluster.call(this, input);
  }

  importService(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    return importService.call(this, input);
  }

  importTaskDefinition(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    return importTaskDefinition.call(this, input);
  }
}
