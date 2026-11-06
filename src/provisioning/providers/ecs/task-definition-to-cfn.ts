import type { ECSProvider } from '../ecs-provider.js';
import type {
  LogConfiguration,
  Volume,
  ContainerDefinition,
  LinuxParameters,
  ProxyConfiguration,
} from '@aws-sdk/client-ecs';
import { camelToPascalCaseKeys } from '../agentcore-case-convert.js';

/**
 * Convert the camelCase SDK `volumes` shape returned by
 * DescribeTaskDefinition back to the PascalCase CFn template form, so the
 * `readCurrentState` snapshot matches the deploy-time template
 * representation for drift comparison (issue #815). Only volume keys
 * present on the SDK side are emitted, so a future field cdkd does not
 * map cannot surface as phantom drift. TaskDefinitions are immutable
 * replace-only today, so this is forward-looking normalization.
 */
export function volumesToCfn(
  this: ECSProvider,
  volumes?: Volume[]
): Array<Record<string, unknown>> {
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
export function proxyConfigurationToCfn(
  this: ECSProvider,
  config: ProxyConfiguration
): Record<string, unknown> {
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
export function containerDefinitionsToCfn(
  this: ECSProvider,
  defs?: ContainerDefinition[]
): Array<Record<string, unknown>> {
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
export function logConfigurationToCfn(
  this: ECSProvider,
  lc: LogConfiguration
): Record<string, unknown> {
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
export function linuxParametersToCfn(
  this: ECSProvider,
  lp: LinuxParameters
): Record<string, unknown> {
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
export function coerceBool(this: ECSProvider, value: unknown): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return undefined;
}
