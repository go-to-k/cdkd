import type { ECSProvider } from '../ecs-provider.js';
import type {
  KeyValuePair,
  PortMapping,
  MountPoint,
  VolumeFrom,
  ContainerDependency,
  EnvironmentFile,
  Secret,
  Ulimit,
  LogConfiguration,
  HealthCheck,
  Volume,
  ContainerDefinition,
  TransportProtocol,
  ApplicationProtocol,
  LogDriver,
  EFSVolumeConfiguration,
  S3FilesVolumeConfiguration,
  EFSAuthorizationConfig,
  DockerVolumeConfiguration,
  FSxWindowsFileServerVolumeConfiguration,
  FSxWindowsFileServerAuthorizationConfig,
  HostVolumeProperties,
  Scope,
  EFSTransitEncryption,
  EFSAuthorizationConfigIAM,
  ContainerCondition,
  EnvironmentFileType,
  UlimitName,
  RepositoryCredentials,
  FirelensConfiguration,
  FirelensConfigurationType,
  ResourceRequirement,
  SystemControl,
  HostEntry,
  ContainerRestartPolicy,
  VersionConsistency,
} from '@aws-sdk/client-ecs';
import { pascalToCamelCaseKeys } from '../agentcore-case-convert.js';

/**
 * Convert CFn ContainerDefinitions to ECS SDK format.
 * CFn uses PascalCase, ECS SDK uses camelCase.
 */
export function convertContainerDefinitions(
  this: ECSProvider,
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
    healthCheck: this.convertHealthCheck(def['HealthCheck'] as Record<string, unknown> | undefined),
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
export function convertPortMappings(
  this: ECSProvider,
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
export function convertEnvironment(
  this: ECSProvider,
  entries?: Array<Record<string, unknown>>
): KeyValuePair[] | undefined {
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
export function convertEnvironmentFiles(
  this: ECSProvider,
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
export function convertSecrets(
  this: ECSProvider,
  entries?: Array<Record<string, unknown>>
): Secret[] | undefined {
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
export function convertMountPoints(
  this: ECSProvider,
  entries?: Array<Record<string, unknown>>
): MountPoint[] | undefined {
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
export function convertVolumesFrom(
  this: ECSProvider,
  entries?: Array<Record<string, unknown>>
): VolumeFrom[] | undefined {
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
export function convertDependsOn(
  this: ECSProvider,
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
export function convertUlimits(
  this: ECSProvider,
  entries?: Array<Record<string, unknown>>
): Ulimit[] | undefined {
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
export function convertLogConfiguration(
  this: ECSProvider,
  config?: Record<string, unknown>
): LogConfiguration | undefined {
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
export function convertFirelensConfiguration(
  this: ECSProvider,
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
export function convertHealthCheck(
  this: ECSProvider,
  check?: Record<string, unknown>
): HealthCheck | undefined {
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
export function convertVolumes(
  this: ECSProvider,
  volumes?: Array<Record<string, unknown>>
): Volume[] | undefined {
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
export function convertS3FilesVolumeConfiguration(
  this: ECSProvider,
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
export function convertVolumeHost(
  this: ECSProvider,
  host?: Record<string, unknown>
): HostVolumeProperties | undefined {
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
export function convertDockerVolumeConfiguration(
  this: ECSProvider,
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
export function convertEFSVolumeConfiguration(
  this: ECSProvider,
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
export function convertEFSAuthorizationConfig(
  this: ECSProvider,
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
export function convertFSxWindowsVolumeConfiguration(
  this: ECSProvider,
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
export function convertFSxWindowsAuthorizationConfig(
  this: ECSProvider,
  config?: Record<string, unknown>
): FSxWindowsFileServerAuthorizationConfig | undefined {
  if (!config) return undefined;
  return {
    credentialsParameter: config['CredentialsParameter'] as string,
    domain: config['Domain'] as string,
  };
}
