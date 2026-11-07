import {
  type SourceType,
  type EnvironmentType,
  type ComputeType,
  type ArtifactsType,
  type ArtifactNamespace,
  type ArtifactPackaging,
  type EnvironmentVariableType,
  type CacheType,
  type CacheMode,
  type HostKernel,
  type ImagePullCredentialsType,
  type SourceAuthType,
  type ProjectSource,
  type CreateProjectCommandInput,
  type BatchReportModeType,
} from '@aws-sdk/client-codebuild';
import { readConfigString, requireConfigArray } from '../../config-shape.js';
import type { CodeBuildProvider } from '../codebuild-provider.js';

/**
 * Return type is DECLARED on purpose. `new CreateProjectCommand(input)` takes
 * a variable, so TypeScript's excess-property check never runs there and a
 * misspelled SDK member (`gitSubModulesConfig`) would compile, be dropped by
 * the serializer, and still pass every unit test — the tests read back the
 * same key the mapper wrote, so they are tautological on spelling. A fresh
 * object literal returned against a declared type IS excess-property checked,
 * which turns each member name into a compile-time fact (issue #1386).
 */
export function mapSource(
  this: CodeBuildProvider,
  source: Record<string, unknown> | undefined,
  containerPath: string
): ProjectSource {
  // `!= null` rather than a truthiness gate: `Source: ''` is exactly the
  // malformed shape `readConfigString` exists to refuse, and a falsy gate
  // would skip the guard and silently build a NO_SOURCE project
  // (.claude/rules/providers.md, "cover the CREATE path").
  if (source == null) {
    return { type: 'NO_SOURCE' as SourceType };
  }

  let buildspec: string | undefined;
  if (source['BuildSpec'] !== undefined) {
    const bs = source['BuildSpec'];
    buildspec = typeof bs === 'object' ? JSON.stringify(bs) : (bs as string);
  }

  // Nested sub-blocks (issue #1386). `mapSource` builds a FRESH object, so
  // every CFn sub-key that is not named here is silently dropped by the SDK
  // serializer. CFn spellings verified against the live registry schema
  // (`cloudformation:DescribeType AWS::CodeBuild::Project`); SDK members
  // verified against `@aws-sdk/client-codebuild`'s `ProjectSource`.
  const cfnAuth = source['Auth'] as Record<string, unknown> | undefined;
  const cfnGitSubmodules = source['GitSubmodulesConfig'] as Record<string, unknown> | undefined;
  const cfnBuildStatus = source['BuildStatusConfig'] as Record<string, unknown> | undefined;

  return {
    type: readConfigString(source, 'Type', 'NO_SOURCE', containerPath) as SourceType,
    buildspec,
    location: source['Location'] as string | undefined,
    gitCloneDepth: source['GitCloneDepth'] as number | undefined,
    insecureSsl: source['InsecureSsl'] as boolean | undefined,
    reportBuildStatus: source['ReportBuildStatus'] as boolean | undefined,
    // SourceIdentifier is required by AWS on every SecondarySources entry
    // (which routes through this same helper) and optional on the primary
    // Source; omitting it made every SecondarySources template fail.
    sourceIdentifier: source['SourceIdentifier'] as string | undefined,
    auth: cfnAuth
      ? {
          type: cfnAuth['Type'] as SourceAuthType,
          resource: cfnAuth['Resource'] as string | undefined,
        }
      : undefined,
    gitSubmodulesConfig: cfnGitSubmodules
      ? { fetchSubmodules: cfnGitSubmodules['FetchSubmodules'] as boolean }
      : undefined,
    buildStatusConfig: cfnBuildStatus
      ? {
          context: cfnBuildStatus['Context'] as string | undefined,
          targetUrl: cfnBuildStatus['TargetUrl'] as string | undefined,
        }
      : undefined,
  };
}

export function mapArtifacts(
  this: CodeBuildProvider,
  artifacts: Record<string, unknown> | undefined,
  containerPath: string
) {
  // `!= null` for the same reason as `mapSource` above.
  if (artifacts == null) {
    return { type: 'NO_ARTIFACTS' as ArtifactsType };
  }

  return {
    type: readConfigString(artifacts, 'Type', 'NO_ARTIFACTS', containerPath) as ArtifactsType,
    location: artifacts['Location'] as string | undefined,
    path: artifacts['Path'] as string | undefined,
    name: artifacts['Name'] as string | undefined,
    namespaceType: artifacts['NamespaceType'] as ArtifactNamespace | undefined,
    packaging: artifacts['Packaging'] as ArtifactPackaging | undefined,
    overrideArtifactName: artifacts['OverrideArtifactName'] as boolean | undefined,
    encryptionDisabled: artifacts['EncryptionDisabled'] as boolean | undefined,
    artifactIdentifier: artifacts['ArtifactIdentifier'] as string | undefined,
  };
}

/**
 * Declared return type for the same excess-property reason as {@link mapSource}.
 * `undeclaredName` names a project the template does not name; called only then.
 */
export function mapProperties(
  this: CodeBuildProvider,
  undeclaredName: () => string,
  properties: Record<string, unknown>
): CreateProjectCommandInput {
  const name = (properties['Name'] as string | undefined) ?? undeclaredName();
  const source = properties['Source'] as Record<string, unknown> | undefined;
  const environment = properties['Environment'] as Record<string, unknown> | undefined;
  // Class 2 sanitize (docs/provider-rules.md#readcurrentstate-for-drift-detection): readCurrentState
  // emits `''` placeholders for ServiceRole / EncryptionKey / SourceVersion
  // so a console-side ADD on a project deployed without those keys
  // surfaces as drift. Shipping `''` back through CreateProject /
  // UpdateProject is structurally invalid — `serviceRole: ''` /
  // `encryptionKey: ''` get rejected by the AWS API. Drop empty
  // placeholders here so the wire layer never sees them; non-empty
  // values pass through unchanged. Symmetric with the placeholder
  // emit on the read side, mirroring `serializeRedrivePolicy` in
  // src/provisioning/providers/sqs-queue-provider.ts.
  const sanitizeOptionalString = (value: unknown): string | undefined => {
    if (typeof value !== 'string') return value as string | undefined;
    return value === '' ? undefined : value;
  };
  const serviceRole = sanitizeOptionalString(properties['ServiceRole']);
  const artifacts = properties['Artifacts'] as Record<string, unknown> | undefined;
  const tags = properties['Tags'] as Array<{ Key: string; Value: string }> | undefined;

  const envVars = environment?.['EnvironmentVariables'] as
    | Array<{ Name: string; Value: string; Type?: string }>
    | undefined;

  // Environment nested sub-blocks (issue #1386). Same fresh-object drop
  // hazard as `mapSource`.
  //
  // `Environment.HostKernel` IS mapped now. It was not, for the whole time
  // the installed `@aws-sdk/client-codebuild` had no member to map it onto
  // (issue #1386) — naming it then would have been a false claim of support.
  // The SDK grew `ProjectEnvironment.hostKernel`, which the (since retired)
  // nested-key KEY-pass allow-list entry had named as its own expiry
  // condition, and that checker's staleness pass is what surfaced that the
  // condition had been met.
  const cfnFleet = environment?.['Fleet'] as Record<string, unknown> | undefined;
  const cfnDockerServer = environment?.['DockerServer'] as Record<string, unknown> | undefined;

  // Map Cache (CFn PascalCase -> SDK camelCase)
  const cfnCache = properties['Cache'] as Record<string, unknown> | undefined;
  const cache = cfnCache
    ? {
        type: cfnCache['Type'] as string as CacheType,
        location: cfnCache['Location'] as string | undefined,
        modes: cfnCache['Modes'] as CacheMode[] | undefined,
        // CacheNamespace (issue #1386): scopes an S3 cache so it can be
        // shared across projects. SDK member `cacheNamespace`.
        cacheNamespace: cfnCache['CacheNamespace'] as string | undefined,
      }
    : undefined;

  // Map VpcConfig
  const cfnVpcConfig = properties['VpcConfig'] as Record<string, unknown> | undefined;
  const vpcConfig = cfnVpcConfig
    ? {
        vpcId: cfnVpcConfig['VpcId'] as string | undefined,
        subnets: cfnVpcConfig['Subnets'] as string[] | undefined,
        securityGroupIds: cfnVpcConfig['SecurityGroupIds'] as string[] | undefined,
      }
    : undefined;

  // Map LogsConfig
  const cfnLogsConfig = properties['LogsConfig'] as Record<string, unknown> | undefined;
  let logsConfig: Record<string, unknown> | undefined;
  if (cfnLogsConfig) {
    const cwLogs = cfnLogsConfig['CloudWatchLogs'] as Record<string, unknown> | undefined;
    const s3Logs = cfnLogsConfig['S3Logs'] as Record<string, unknown> | undefined;
    logsConfig = {
      cloudWatchLogs: cwLogs
        ? {
            status: cwLogs['Status'] as string | undefined,
            groupName: cwLogs['GroupName'] as string | undefined,
            streamName: cwLogs['StreamName'] as string | undefined,
          }
        : undefined,
      s3Logs: s3Logs
        ? {
            status: s3Logs['Status'] as string | undefined,
            location: s3Logs['Location'] as string | undefined,
            encryptionDisabled: s3Logs['EncryptionDisabled'] as boolean | undefined,
          }
        : undefined,
    };
  }

  // Map SecondarySources
  const cfnSecondarySources = properties['SecondarySources'] as
    | Array<Record<string, unknown>>
    | undefined;
  const secondarySources =
    cfnSecondarySources == null
      ? undefined
      : requireConfigArray(cfnSecondarySources, 'AWS::CodeBuild::Project SecondarySources').map(
          (s) => this.mapSource(s, 'AWS::CodeBuild::Project SecondarySources[]')
        );

  // Map SecondaryArtifacts
  const cfnSecondaryArtifacts = properties['SecondaryArtifacts'] as
    | Array<Record<string, unknown>>
    | undefined;
  const secondaryArtifacts =
    cfnSecondaryArtifacts == null
      ? undefined
      : requireConfigArray(cfnSecondaryArtifacts, 'AWS::CodeBuild::Project SecondaryArtifacts').map(
          (a) => this.mapArtifacts(a, 'AWS::CodeBuild::Project SecondaryArtifacts[]')
        );

  // Map SecondarySourceVersions
  const cfnSecondarySourceVersions = properties['SecondarySourceVersions'] as
    | Array<Record<string, unknown>>
    | undefined;
  const secondarySourceVersions = cfnSecondarySourceVersions
    ? cfnSecondarySourceVersions.map((sv) => ({
        sourceIdentifier: sv['SourceIdentifier'] as string,
        sourceVersion: sv['SourceVersion'] as string,
      }))
    : undefined;

  // Map FileSystemLocations
  const cfnFileSystemLocations = properties['FileSystemLocations'] as
    | Array<Record<string, unknown>>
    | undefined;
  const fileSystemLocations = cfnFileSystemLocations
    ? cfnFileSystemLocations.map((fsl) => ({
        type: fsl['Type'] as 'EFS' | undefined,
        location: fsl['Location'] as string | undefined,
        mountPoint: fsl['MountPoint'] as string | undefined,
        identifier: fsl['Identifier'] as string | undefined,
        mountOptions: fsl['MountOptions'] as string | undefined,
      }))
    : undefined;

  // Map BuildBatchConfig
  const cfnBuildBatchConfig = properties['BuildBatchConfig'] as Record<string, unknown> | undefined;
  let buildBatchConfig: Record<string, unknown> | undefined;
  if (cfnBuildBatchConfig) {
    const restrictions = cfnBuildBatchConfig['Restrictions'] as Record<string, unknown> | undefined;
    buildBatchConfig = {
      serviceRole: cfnBuildBatchConfig['ServiceRole'] as string | undefined,
      combineArtifacts: cfnBuildBatchConfig['CombineArtifacts'] as boolean | undefined,
      timeoutInMins: cfnBuildBatchConfig['TimeoutInMins'] as number | undefined,
      // Fifth member of the CFn `ProjectBuildBatchConfig` definition. It was
      // the one sub-key this file still dropped after the #1386 sweep, and
      // `readCurrentState` already reads it back — so the asymmetry sat in
      // this same file. Found by review, not by the sweep.
      batchReportMode: cfnBuildBatchConfig['BatchReportMode'] as BatchReportModeType | undefined,
      restrictions: restrictions
        ? {
            maximumBuildsAllowed: restrictions['MaximumBuildsAllowed'] as number | undefined,
            computeTypesAllowed: restrictions['ComputeTypesAllowed'] as string[] | undefined,
            fleetsAllowed: restrictions['FleetsAllowed'] as string[] | undefined,
          }
        : undefined,
    };
  }

  return {
    name,
    source: this.mapSource(source, 'AWS::CodeBuild::Project Source'),
    environment: {
      type: readConfigString(
        environment,
        'Type',
        'LINUX_CONTAINER',
        'AWS::CodeBuild::Project Environment'
      ) as EnvironmentType,
      computeType: readConfigString(
        environment,
        'ComputeType',
        'BUILD_GENERAL1_SMALL',
        'AWS::CodeBuild::Project Environment'
      ) as ComputeType,
      image: environment?.['Image'] as string | undefined,
      environmentVariables: envVars
        ? envVars.map((v) => ({
            name: v.Name,
            value: v.Value,
            type: (v.Type ?? 'PLAINTEXT') as EnvironmentVariableType,
          }))
        : undefined,
      privilegedMode: environment?.['PrivilegedMode'] as boolean | undefined,
      certificate: environment?.['Certificate'] as string | undefined,
      imagePullCredentialsType: environment?.['ImagePullCredentialsType'] as
        | ImagePullCredentialsType
        | undefined,
      // `HostKernel` was unmappable until the SDK grew the member: the CFn
      // registry declared the key while `ProjectEnvironment` had nothing to
      // put it on, so naming it here would have been a false claim of
      // support. `@aws-sdk/client-codebuild` 3.1126.0 declares
      // `ProjectEnvironment.hostKernel`.
      hostKernel: environment?.['HostKernel'] as HostKernel | undefined,
      fleet: cfnFleet ? { fleetArn: cfnFleet['FleetArn'] as string | undefined } : undefined,
      dockerServer: cfnDockerServer
        ? {
            computeType: cfnDockerServer['ComputeType'] as ComputeType,
            securityGroupIds: cfnDockerServer['SecurityGroupIds'] as string[] | undefined,
          }
        : undefined,
      registryCredential: environment?.['RegistryCredential']
        ? {
            credential: (environment['RegistryCredential'] as Record<string, unknown>)[
              'Credential'
            ] as string,
            credentialProvider: (environment['RegistryCredential'] as Record<string, unknown>)[
              'CredentialProvider'
            ] as 'SECRETS_MANAGER',
          }
        : undefined,
    },
    serviceRole,
    artifacts: this.mapArtifacts(artifacts, 'AWS::CodeBuild::Project Artifacts'),
    tags: tags ? tags.map((t) => ({ key: t.Key, value: t.Value })) : undefined,
    description: properties['Description'] as string | undefined,
    timeoutInMinutes: properties['TimeoutInMinutes'] as number | undefined,
    queuedTimeoutInMinutes: properties['QueuedTimeoutInMinutes'] as number | undefined,
    encryptionKey: sanitizeOptionalString(properties['EncryptionKey']),
    cache,
    vpcConfig,
    logsConfig,
    concurrentBuildLimit: properties['ConcurrentBuildLimit'] as number | undefined,
    // AutoRetryLimit (#609 backfill): integer 0-10; rides CreateProject /
    // UpdateProject directly (no separate control-plane API). Omit-when-
    // absent so a template that does not set it sends no field to AWS.
    autoRetryLimit: properties['AutoRetryLimit'] as number | undefined,
    secondarySources,
    secondaryArtifacts,
    secondarySourceVersions,
    fileSystemLocations,
    buildBatchConfig,
    badgeEnabled: properties['BadgeEnabled'] as boolean | undefined,
    sourceVersion: sanitizeOptionalString(properties['SourceVersion']),
  };
}
