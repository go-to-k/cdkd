import type { ECSProvider } from '../ecs-provider.js';
import type {
  NetworkConfiguration,
  LoadBalancer,
  AdvancedConfiguration,
  DeploymentConfiguration,
  CapacityProviderStrategyItem,
  PlacementConstraint,
  PlacementStrategy,
  ServiceRegistry,
  LinuxParameters,
  ClusterConfiguration,
  TaskDefinitionPlacementConstraint,
  RuntimePlatform,
  ProxyConfiguration,
  AssignPublicIp,
  DeploymentController,
  ServiceConnectConfiguration,
  ServiceVolumeConfiguration,
  VpcLatticeConfiguration,
  GatewayConnector,
  MonitoringConfiguration,
  ThresholdConfiguration,
} from '@aws-sdk/client-ecs';
import { pascalToCamelCaseKeys } from '../agentcore-case-convert.js';
import type { MaskedLogSinks } from '../../masked-retry-logger.js';
import { clearOnUpdateRemoval } from '../../update-removal.js';
import {
  DEPLOYMENT_CONFIG_PRESERVE_KEYS,
  SERVICE_CONNECT_PRESERVE_KEYS,
  CIRCUIT_BREAKER_RESET_ON_HEALTHY_TASK_DEFAULT,
  CIRCUIT_BREAKER_THRESHOLD_CONFIGURATION_DEFAULT,
  isPlainCfnObject,
} from './shared.js';

/**
 * Convert CFn NetworkConfiguration to ECS SDK format
 */
/**
 * Convert CFn PascalCase LoadBalancers to SDK camelCase
 */
export function convertLoadBalancers(
  this: ECSProvider,
  lbs?: Array<Record<string, unknown>>
): LoadBalancer[] | undefined {
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
export function convertDeploymentConfiguration(
  this: ECSProvider,
  config?: Record<string, unknown>
): DeploymentConfiguration | undefined {
  if (!config) return undefined;
  return pascalToCamelCaseKeys(config, DEPLOYMENT_CONFIG_PRESERVE_KEYS) as DeploymentConfiguration;
}

/**
 * UPDATE-path `DeploymentConfiguration` resolver: the verbatim conversion
 * above, plus the ONE member-level removal reset real AWS measurement found
 * in this property tree (issue #1861).
 *
 * The rule this keys on is previous-present / current-absent — exactly the
 * semantic `clearOnUpdateRemoval` implements for TOP-LEVEL properties, which
 * is why this reuses that helper rather than re-spelling the predicate. What
 * is new is only the DEPTH: the member lives inside a nested struct the
 * template STILL DECLARES.
 *
 * Scope is deliberately narrow, and each boundary is measured rather than
 * reasoned about (us-east-1, 2026-08-13; the full A/B table is in the long
 * comment inside `updateService`):
 *   - Only `DeploymentCircuitBreaker`'s two OPTIONAL members
 *     (`ResetOnHealthyTask`, `ThresholdConfiguration`). Its REQUIRED sibling
 *     `Rollback` reads as REPLACED, so one block holds members with
 *     different semantics and no row generalizes to its neighbours.
 *   - NOT the depth-1 siblings `LinearConfiguration` / `CanaryConfiguration`
 *     / `LifecycleHooks[].TimeoutConfiguration`: those are already PARITY
 *     because the ECS API ITSELF replaces the struct and default-fills the
 *     omitted member, so adding a reset there would be the divergence.
 *   - NOT the whole-struct cases. Removing the whole `DeploymentConfiguration`
 *     resets nothing under either engine, and the parent
 *     `DeploymentCircuitBreaker` disappearing entirely was never measured —
 *     so BOTH sides must still declare the block for a member omission to
 *     read as a removal.
 *   - NOT "always send the defaults": a member the template NEVER declared
 *     is left alone by CloudFormation even when the block around it changes,
 *     and `clearOnUpdateRemoval` returning `undefined` for that case is what
 *     keeps cdkd from clobbering an out-of-band value CFn preserves.
 *   - NOT scoped by scheduling strategy, and that is a deliberate omission
 *     rather than an unconsidered one. The A/B ran on a ROLLING / REPLICA /
 *     Fargate service and DAEMON was never exercised, so the question is
 *     fair — and DAEMON is genuinely REACHABLE here, because the SDK states
 *     that CODE_DEPLOY / EXTERNAL controllers do not support DAEMON, so a
 *     DAEMON service necessarily runs the ECS rolling-update type and can
 *     carry a circuit breaker. What makes the omission safe is narrower and
 *     PER-FIELD: the SDK documents these TWO members' defaults with no
 *     strategy dimension. It is not a general property of this block —
 *     `minimumHealthyPercent`'s default IS strategy-dependent (100% replica
 *     vs 0% DAEMON), and stays correct only because cdkd passes it through
 *     rather than defaulting it.
 *
 * The previous side stays RAW CFn PascalCase on purpose: `clearOnUpdateRemoval`
 * only inspects it for PRESENCE, the same shortcut the top-level call sites
 * in `updateService` take.
 *
 * SCOPE OF THAT PRESENCE TEST — state it as what it literally is, because
 * the obvious reading is stronger than the truth. It means "the previous
 * BAG carried this member", NOT "the previous TEMPLATE declared it". Those
 * coincide on the deploy path, where `previousProperties` is the last
 * deployed template. They do NOT at `drift --revert`
 * (`src/cli/commands/drift.ts`, the `provider.update(...)` call that passes
 * `outcome.awsProperties`), where the previous bag is an AWS READBACK: a
 * member the template never declared but AWS reports is present there, so a
 * desired side that omits it reads as a removal and gets the default sent.
 * The window is narrow — the revert path's own desired bag is built from
 * `observedProperties`, which normally carries the member too, and its
 * `preserveUntemplated` arm recurses via `mergeUntemplatedValue` and keeps
 * AWS-only members — but it is real when an `observedProperties` snapshot
 * predates AWS reporting the member. Kept on purpose (issue #1160): a
 * nested `clearOnUpdateRemoval` that read presence from the desired bag
 * instead would stop reverting a console change the baseline declares as
 * unset (the Lambda URL `Cors` placeholder arm depends on the readback), so
 * only a TOP-LEVEL removal is judged template-vs-template
 * (`UpdateContext.removedProperties`), which is empty on that path. It is
 * unit-pinned so the next member copied onto this pattern does not inherit
 * the premise unchecked.
 */
export function resolveDeploymentConfiguration(
  this: ECSProvider,
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>
): DeploymentConfiguration | undefined {
  const desired = this.convertDeploymentConfiguration(
    properties['DeploymentConfiguration'] as Record<string, unknown> | undefined
  );
  const desiredBreaker = desired?.deploymentCircuitBreaker;
  // PLAIN-OBJECT guard, not truthiness. A template can put anything here —
  // `DeploymentCircuitBreaker: 'oops'` / `[]` / `7` are all truthy, and the
  // rebuild arm below would spread them: a string spreads to
  // `{0:'o',1:'o',2:'p',3:'s'}` and then gains both synthesized defaults,
  // turning a malformed template into a differently-malformed one. No live
  // mutation results either way (the rebuilt block has no `enable` /
  // `rollback`, so AWS rejects the whole `UpdateService` exactly as it did
  // before this fix), but "malformed shapes fall back to the pre-change
  // pass-through" should be literally TRUE rather than nearly true — so
  // anything that is not a plain object is handed straight back untouched.
  if (!desired || !isPlainCfnObject(desiredBreaker)) return desired;

  const previousDeploymentConfiguration = previousProperties['DeploymentConfiguration'];
  const previousBreaker = isPlainCfnObject(previousDeploymentConfiguration)
    ? previousDeploymentConfiguration['DeploymentCircuitBreaker']
    : undefined;
  // Same guard on the previous side: only PRESENCE is read from it, but a
  // non-object there would make `previousBreaker['ResetOnHealthyTask']`
  // read an index off a string or an array element off a list, which is a
  // presence answer nobody wrote down.
  if (!isPlainCfnObject(previousBreaker)) return desired;

  const resetOnHealthyTask = clearOnUpdateRemoval(
    desiredBreaker.resetOnHealthyTask,
    previousBreaker['ResetOnHealthyTask'] as boolean | undefined,
    CIRCUIT_BREAKER_RESET_ON_HEALTHY_TASK_DEFAULT
  );
  const thresholdConfiguration = clearOnUpdateRemoval(
    desiredBreaker.thresholdConfiguration,
    // Cast for the helper's signature only. The previous side is raw CFn
    // `{Type, Value}` PascalCase, NOT the camelCase SDK shape this names —
    // sound because only PRESENCE is read, never the value.
    previousBreaker['ThresholdConfiguration'] as ThresholdConfiguration | undefined,
    // A FRESH copy per call — see the constant's note. The SDK input must
    // never carry the shared module-level object.
    { ...CIRCUIT_BREAKER_THRESHOLD_CONFIGURATION_DEFAULT }
  );

  if (
    resetOnHealthyTask === desiredBreaker.resetOnHealthyTask &&
    thresholdConfiguration === desiredBreaker.thresholdConfiguration
  ) {
    return desired;
  }

  return {
    ...desired,
    deploymentCircuitBreaker: {
      ...desiredBreaker,
      // Conditional spreads keep the built OBJECT's key set equal to what
      // the template declared, so a never-declared member is absent rather
      // than an explicit `undefined` key. This is a shape claim, NOT a wire
      // claim: the SDK omits `undefined` members, and both forms were
      // measured through a real `UpdateServiceCommand` with a capturing
      // request handler to serialize byte-identically (102 bytes). Keeping
      // the shape honest still matters — the object is what unit assertions,
      // logs and any future diff of this input see.
      ...(resetOnHealthyTask !== undefined ? { resetOnHealthyTask } : {}),
      ...(thresholdConfiguration !== undefined ? { thresholdConfiguration } : {}),
    },
  };
}

/**
 * Convert the CFn PascalCase `CapacityProviderStrategy` array to the ECS SDK
 * camelCase input shape (issue #1165). Each element `{CapacityProvider,
 * Weight, Base}` is a pure first-letter case flip to `{capacityProvider,
 * weight, base}`.
 */
export function convertCapacityProviderStrategy(
  this: ECSProvider,
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
export function convertPlacementConstraints(
  this: ECSProvider,
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
export function convertPlacementStrategies(
  this: ECSProvider,
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
export function convertServiceRegistries(
  this: ECSProvider,
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
export function convertDeploymentController(
  this: ECSProvider,
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
export function convertServiceConnectConfiguration(
  this: ECSProvider,
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
export function convertServiceVolumeConfigurations(
  this: ECSProvider,
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
export function convertVpcLatticeConfigurations(
  this: ECSProvider,
  items?: Array<Record<string, unknown>>
): VpcLatticeConfiguration[] | undefined {
  if (!items) return undefined;
  return pascalToCamelCaseKeys(items) as VpcLatticeConfiguration[];
}

/**
 * Convert the CFn PascalCase `GatewayConnectors` array to the ECS SDK
 * camelCase input shape (go-to-k/cdkd#5634). Every key of `{PortName,
 * HealthCheck: {HealthCheckProtocol, HealthCheckPort, HealthCheckPath,
 * HealthCheckTimeoutSeconds, HealthCheckIntervalSeconds,
 * HealthyThresholdCount, UnhealthyThresholdCount, Matcher: {HttpCode,
 * GrpcCode}}, Filters: {AccessTypes}}` is a pure first-letter flip; the
 * enum VALUES (`HTTP`, `PUBLIC`, ...) pass through untouched.
 */
export function convertGatewayConnectors(
  this: ECSProvider,
  items?: Array<Record<string, unknown>>
): GatewayConnector[] | undefined {
  if (!items) return undefined;
  return pascalToCamelCaseKeys(items) as GatewayConnector[];
}

/**
 * Convert the CFn PascalCase `Monitoring` block to the ECS SDK camelCase
 * `monitoring` input shape (issue #609). Every key is a pure first-letter
 * flip (`MetricConfigurations[].{MetricNames, ResolutionSeconds}`).
 */
export function convertMonitoringConfiguration(
  this: ECSProvider,
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
export function resolveForceNewDeployment(
  this: ECSProvider,
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>,
  log: MaskedLogSinks
): boolean | undefined {
  const desired = properties['ForceNewDeployment'];
  if (desired == null) return undefined;
  if (typeof desired !== 'object' || Array.isArray(desired)) {
    log.warn(
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
export function convertRuntimePlatform(
  this: ECSProvider,
  config?: Record<string, unknown>
): RuntimePlatform | undefined {
  if (!config) return undefined;
  return pascalToCamelCaseKeys(config) as RuntimePlatform;
}

/**
 * Convert the CFn PascalCase `TaskDefinition.EphemeralStorage` to the ECS SDK
 * camelCase input shape (issue #1165). `{SizeInGiB}` -> `{sizeInGiB}` — the
 * value under the wrong-cased key was silently dropped before the fix, so a
 * custom ephemeral storage size reverted to the AWS default.
 */
export function convertEphemeralStorage(
  this: ECSProvider,
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
export function convertClusterConfiguration(
  this: ECSProvider,
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
export function convertProxyConfiguration(
  this: ECSProvider,
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
export function convertTaskDefinitionPlacementConstraints(
  this: ECSProvider,
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
export function convertLinuxParameters(
  this: ECSProvider,
  config?: Record<string, unknown>
): LinuxParameters | undefined {
  if (!config) return undefined;
  return pascalToCamelCaseKeys(config) as LinuxParameters;
}

export function convertNetworkConfiguration(
  this: ECSProvider,
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
export function isClusterNotFoundException(this: ECSProvider, error: unknown): boolean {
  if (error instanceof Error) {
    return error.name === 'ClusterNotFoundException' || error.message.includes('Cluster not found');
  }
  return false;
}

/**
 * Check if error is a not-found error (for task definitions)
 */
export function isNotFoundException(this: ECSProvider, error: unknown): boolean {
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
export function isServiceNotFoundException(this: ECSProvider, error: unknown): boolean {
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

/** The NOT-ACTIVE arm of {@link isServiceNotFoundException} (go-to-k/cdkd#5664). */
export function isServiceNotActiveException(this: ECSProvider, error: unknown): boolean {
  return error instanceof Error && error.name === 'ServiceNotActiveException';
}
