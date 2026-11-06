import type { ECSProvider } from '../ecs-provider.js';
import {
  DescribeClustersCommand,
  DescribeTaskDefinitionCommand,
  DescribeServicesCommand,
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
  type TaskDefinitionPlacementConstraint,
  type RuntimePlatform,
  type ProxyConfiguration,
  type DeploymentController,
} from '@aws-sdk/client-ecs';
import { normalizeAwsTagsToCfn } from '../../import-helpers.js';
import { camelToPascalCaseKeys } from '../agentcore-case-convert.js';
import type { ResourceNotFound } from '../../../types/resource.js';
import { RESOURCE_NOT_FOUND } from '../../../types/resource.js';
import {
  DEPLOYMENT_CONFIG_PRESERVE_KEYS_CAMEL,
  describeListedNothingGone,
  isTaskDefinitionMissingError,
  isDeregisteredTaskDefinitionStatus,
  clusterNameFromServiceArn,
  isEcsErrorNamed,
} from './shared.js';

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
 *   - `Monitoring` / `GatewayConnectors` (go-to-k/cdkd#5634): not returned
 *     by DescribeServices at all — only the service REVISION carries them
 *     (`GatewayConnectors` is also registry-recorded write-only).
 *   - `ForceNewDeployment`: a write-only rollout trigger, not persisted
 *     service state.
 *   - `Role`: AWS reports `Service.roleArn` as the service-linked
 *     AWSServiceRoleForECS ARN when the template omits Role, and always as
 *     a full ARN when the template may carry a bare role name — a
 *     mechanical reverse-map would manufacture drift in both directions.
 */
export function getDriftUnknownPaths(this: ECSProvider, resourceType: string): string[] {
  if (resourceType === 'AWS::ECS::Service') {
    return [
      'ServiceConnectConfiguration',
      'VolumeConfigurations',
      'VpcLatticeConfigurations',
      'Monitoring',
      'ForceNewDeployment',
      'Role',
      'GatewayConnectors',
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
export async function readCurrentState(
  this: ECSProvider,
  physicalId: string,
  _logicalId: string,
  resourceType: string
): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
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

export async function readCurrentStateCluster(
  this: ECSProvider,
  physicalId: string
): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
  let resp: {
    clusters?: Array<{
      clusterName?: string;
      status?: string;
      capacityProviders?: string[];
      defaultCapacityProviderStrategy?: CapacityProviderStrategyItem[];
      configuration?: ClusterConfiguration;
      settings?: Array<{ name?: string; value?: string }>;
      serviceConnectDefaults?: { namespace?: string };
      tags?: Array<{ key?: string; value?: string }>;
    }>;
    failures?: Array<{ reason?: string }>;
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
  } catch (err) {
    if (isEcsErrorNamed(err, ['ClusterNotFoundException'])) return RESOURCE_NOT_FOUND;
    return undefined;
  }
  const c = resp.clusters?.[0];
  if (!c || !c.clusterName) {
    // Nothing listed: only `MISSING` failures say the cluster is gone; any
    // other failure reason is a lookup that did not answer.
    return describeListedNothingGone(resp.failures) ? RESOURCE_NOT_FOUND : undefined;
  }
  // An `INACTIVE` cluster is a DELETED one that `DescribeClusters` still
  // lists for a while; reading it as present would make `cdkd drift`
  // compare a deleted cluster's properties. Same rule as `importCluster`
  // (go-to-k/cdkd#4272); every other status is a live cluster.
  if (c.status === 'INACTIVE') return RESOURCE_NOT_FOUND;

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

export async function readCurrentStateService(
  this: ECSProvider,
  physicalId: string
): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
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
      status?: string;
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
    failures?: Array<{ reason?: string }>;
  };
  try {
    resp = (await this.getClient().send(
      new DescribeServicesCommand({
        cluster,
        services: [serviceName],
        include: ['TAGS'],
      })
    )) as unknown as typeof resp;
  } catch (err) {
    // A deleted cluster takes its services with it. Error NAMES only: the
    // message matches the delete path also uses prove nothing here. And only
    // for a cluster the id NAMED: with none, the call asked the DEFAULT
    // cluster, whose answer says nothing about a service in a named one.
    if (
      cluster !== undefined &&
      isEcsErrorNamed(err, [
        'ClusterNotFoundException',
        'ServiceNotFoundException',
        'ServiceNotActiveException',
      ])
    ) {
      return RESOURCE_NOT_FOUND;
    }
    return undefined;
  }
  const s = resp.services?.[0];
  if (!s || !s.serviceName) {
    // Same default-cluster caveat as the catch above.
    return cluster !== undefined && describeListedNothingGone(resp.failures)
      ? RESOURCE_NOT_FOUND
      : undefined;
  }
  // `DescribeServices` keeps listing a DELETED service as `INACTIVE` for a
  // while (go-to-k/cdkd#4272, the cluster rule). `DRAINING` is a delete in
  // progress, but the service still exists, so it stays present.
  if (s.status === 'INACTIVE') return RESOURCE_NOT_FOUND;

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
  // `vpcLatticeConfigurations` / `monitoring` / `gatewayConnectors`
  // (#5634) on the Service itself (the first three only appear
  // per-deployment under `deployments[]`), and `ForceNewDeployment` is a
  // write-only rollout trigger — all six are declared in
  // `getDriftUnknownPaths` instead of being fabricated here.
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

export async function readCurrentStateTaskDefinition(
  this: ECSProvider,
  physicalId: string
): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
  let resp: {
    taskDefinition?: {
      family?: string;
      status?: string;
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
  } catch (err) {
    if (isTaskDefinitionMissingError(err)) return RESOURCE_NOT_FOUND;
    return undefined;
  }
  const td = resp.taskDefinition;
  if (!td) return undefined;
  if (isDeregisteredTaskDefinitionStatus(td.status)) return RESOURCE_NOT_FOUND;

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
