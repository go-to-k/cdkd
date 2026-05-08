import {
  CodeBuildClient,
  CreateProjectCommand,
  DeleteProjectCommand,
  UpdateProjectCommand,
  BatchGetProjectsCommand,
  ListProjectsCommand,
  ResourceNotFoundException,
  type SourceType,
  type EnvironmentType,
  type ComputeType,
  type ArtifactsType,
  type ArtifactNamespace,
  type ArtifactPackaging,
  type EnvironmentVariableType,
  type CacheType,
  type CacheMode,
  type ImagePullCredentialsType,
} from '@aws-sdk/client-codebuild';
import { getLogger } from '../../utils/logger.js';
import { ProvisioningError } from '../../utils/error-handler.js';
import { assertRegionMatch, type DeleteContext } from '../region-check.js';
import {
  CDK_PATH_TAG,
  normalizeAwsTagsToCfn,
  resolveExplicitPhysicalId,
} from '../import-helpers.js';
import type {
  ResourceProvider,
  ResourceCreateResult,
  ResourceUpdateResult,
  ResourceImportInput,
  ResourceImportResult,
} from '../../types/resource.js';

/**
 * SDK Provider for AWS CodeBuild resources
 *
 * Supports:
 * - AWS::CodeBuild::Project
 *
 * CodeBuild CreateProject/UpdateProject are synchronous - the CC API adds
 * unnecessary polling overhead for operations that complete immediately.
 */
export class CodeBuildProvider implements ResourceProvider {
  private client: CodeBuildClient | undefined;
  private readonly providerRegion = process.env['AWS_REGION'];
  private logger = getLogger().child('CodeBuildProvider');

  handledProperties = new Map<string, ReadonlySet<string>>([
    [
      'AWS::CodeBuild::Project',
      new Set([
        'Name',
        'Source',
        'Environment',
        'ServiceRole',
        'Artifacts',
        'Tags',
        'Description',
        'TimeoutInMinutes',
        'QueuedTimeoutInMinutes',
        'EncryptionKey',
        'Cache',
        'VpcConfig',
        'LogsConfig',
        'ConcurrentBuildLimit',
        'SecondaryArtifacts',
        'SecondarySources',
        'SecondarySourceVersions',
        'FileSystemLocations',
        'BuildBatchConfig',
        'BadgeEnabled',
        'SourceVersion',
      ]),
    ],
  ]);

  private getClient(): CodeBuildClient {
    if (!this.client) {
      this.client = new CodeBuildClient(this.providerRegion ? { region: this.providerRegion } : {});
    }
    return this.client;
  }

  private mapSource(source: Record<string, unknown> | undefined) {
    if (!source) {
      return { type: 'NO_SOURCE' as SourceType };
    }

    let buildspec: string | undefined;
    if (source['BuildSpec'] !== undefined) {
      const bs = source['BuildSpec'];
      buildspec = typeof bs === 'object' ? JSON.stringify(bs) : (bs as string);
    }

    return {
      type: ((source['Type'] as string) ?? 'NO_SOURCE') as SourceType,
      buildspec,
      location: source['Location'] as string | undefined,
      gitCloneDepth: source['GitCloneDepth'] as number | undefined,
      insecureSsl: source['InsecureSsl'] as boolean | undefined,
      reportBuildStatus: source['ReportBuildStatus'] as boolean | undefined,
    };
  }

  private mapArtifacts(artifacts: Record<string, unknown> | undefined) {
    if (!artifacts) {
      return { type: 'NO_ARTIFACTS' as ArtifactsType };
    }

    return {
      type: ((artifacts['Type'] as string) ?? 'NO_ARTIFACTS') as ArtifactsType,
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

  private mapProperties(logicalId: string, properties: Record<string, unknown>) {
    const name = (properties['Name'] as string | undefined) ?? logicalId;
    const source = properties['Source'] as Record<string, unknown> | undefined;
    const environment = properties['Environment'] as Record<string, unknown> | undefined;
    // Class 2 sanitize (docs/provider-development.md § 3b): readCurrentState
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

    // Map Cache (CFn PascalCase -> SDK camelCase)
    const cfnCache = properties['Cache'] as Record<string, unknown> | undefined;
    const cache = cfnCache
      ? {
          type: cfnCache['Type'] as string as CacheType,
          location: cfnCache['Location'] as string | undefined,
          modes: cfnCache['Modes'] as CacheMode[] | undefined,
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
    const secondarySources = cfnSecondarySources
      ? cfnSecondarySources.map((s) => this.mapSource(s))
      : undefined;

    // Map SecondaryArtifacts
    const cfnSecondaryArtifacts = properties['SecondaryArtifacts'] as
      | Array<Record<string, unknown>>
      | undefined;
    const secondaryArtifacts = cfnSecondaryArtifacts
      ? cfnSecondaryArtifacts.map((a) => this.mapArtifacts(a))
      : undefined;

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
    const cfnBuildBatchConfig = properties['BuildBatchConfig'] as
      | Record<string, unknown>
      | undefined;
    let buildBatchConfig: Record<string, unknown> | undefined;
    if (cfnBuildBatchConfig) {
      const restrictions = cfnBuildBatchConfig['Restrictions'] as
        | Record<string, unknown>
        | undefined;
      buildBatchConfig = {
        serviceRole: cfnBuildBatchConfig['ServiceRole'] as string | undefined,
        combineArtifacts: cfnBuildBatchConfig['CombineArtifacts'] as boolean | undefined,
        timeoutInMins: cfnBuildBatchConfig['TimeoutInMins'] as number | undefined,
        restrictions: restrictions
          ? {
              maximumBuildsAllowed: restrictions['MaximumBuildsAllowed'] as number | undefined,
              computeTypesAllowed: restrictions['ComputeTypesAllowed'] as string[] | undefined,
            }
          : undefined,
      };
    }

    return {
      name,
      source: this.mapSource(source),
      environment: {
        type: ((environment?.['Type'] as string) ?? 'LINUX_CONTAINER') as EnvironmentType,
        computeType: ((environment?.['ComputeType'] as string) ??
          'BUILD_GENERAL1_SMALL') as ComputeType,
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
      artifacts: this.mapArtifacts(artifacts),
      tags: tags ? tags.map((t) => ({ key: t.Key, value: t.Value })) : undefined,
      description: properties['Description'] as string | undefined,
      timeoutInMinutes: properties['TimeoutInMinutes'] as number | undefined,
      queuedTimeoutInMinutes: properties['QueuedTimeoutInMinutes'] as number | undefined,
      encryptionKey: sanitizeOptionalString(properties['EncryptionKey']),
      cache,
      vpcConfig,
      logsConfig,
      concurrentBuildLimit: properties['ConcurrentBuildLimit'] as number | undefined,
      secondarySources,
      secondaryArtifacts,
      secondarySourceVersions,
      fileSystemLocations,
      buildBatchConfig,
      badgeEnabled: properties['BadgeEnabled'] as boolean | undefined,
      sourceVersion: sanitizeOptionalString(properties['SourceVersion']),
    };
  }

  async create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
  ): Promise<ResourceCreateResult> {
    this.logger.debug(`Creating CodeBuild Project ${logicalId}`);

    try {
      const input = this.mapProperties(logicalId, properties);

      const result = await this.getClient().send(new CreateProjectCommand(input));

      const projectName = result.project!.name!;
      const projectArn = result.project!.arn!;

      this.logger.debug(`Successfully created CodeBuild Project ${logicalId}: ${projectName}`);

      return {
        physicalId: projectName,
        attributes: {
          Arn: projectArn,
        },
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to create CodeBuild Project ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        undefined,
        cause
      );
    }
  }

  async update(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    _previousProperties: Record<string, unknown>
  ): Promise<ResourceUpdateResult> {
    this.logger.debug(`Updating CodeBuild Project ${logicalId}: ${physicalId}`);

    try {
      const input = this.mapProperties(logicalId, properties);
      // Ensure the update targets the existing project
      input.name = physicalId;

      await this.getClient().send(new UpdateProjectCommand(input));

      this.logger.debug(`Successfully updated CodeBuild Project ${logicalId}`);

      return { physicalId, wasReplaced: false };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to update CodeBuild Project ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  async delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    _properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void> {
    this.logger.debug(`Deleting CodeBuild Project ${logicalId}: ${physicalId}`);

    try {
      await this.getClient().send(new DeleteProjectCommand({ name: physicalId }));
      this.logger.debug(`Successfully deleted CodeBuild Project ${logicalId}`);
    } catch (error) {
      if (error instanceof ResourceNotFoundException) {
        const clientRegion = await this.getClient().config.region();
        assertRegionMatch(
          clientRegion,
          context?.expectedRegion,
          resourceType,
          logicalId,
          physicalId
        );
        this.logger.debug(`CodeBuild Project ${physicalId} does not exist, skipping deletion`);
        return;
      }
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to delete CodeBuild Project ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  getAttribute(
    _physicalId: string,
    _resourceType: string,
    attributeName: string
  ): Promise<unknown> {
    // Arn is stored in attributes during create
    return Promise.resolve(attributeName);
  }

  /**
   * Adopt an existing CodeBuild project into cdkd state.
   *
   * Lookup order:
   *  1. `--resource` override or `Properties.Name` → verify via `BatchGetProjects`.
   *  2. `ListProjects` + `BatchGetProjects` (CodeBuild uses lowercase
   *     `key`/`value` tags, not the standard `Key`/`Value`), match
   *     `aws:cdk:path` tag.
   */
  /**
   * Read the AWS-current CodeBuild Project configuration in CFn-property shape.
   *
   * Issues `BatchGetProjects` and re-shapes the SDK's camelCase response back
   * to CFn's PascalCase shape (the `mapProperties` helper above goes the
   * other way at create time). Coverage targets every user-controllable
   * top-level field via the always-emit pattern (PR #145):
   *  - `Source` / `Artifacts` / `Environment` (with `EnvironmentVariables`
   *    sub-array): full reshape to CFn shape.
   *  - `LogsConfig` (`CloudWatchLogs` + `S3Logs` sub-shapes): always-emit
   *    placeholder so a console-side enable on a previously-default
   *    project surfaces as drift.
   *  - `VpcConfig` (VpcId / Subnets / SecurityGroupIds): always-emit
   *    placeholder.
   *  - `Cache` (Type / Location / Modes): always-emit placeholder.
   *
   * Still v1-omitted (known gaps, follow-up): `SecondarySources` /
   * `SecondaryArtifacts` / `SecondarySourceVersions` / `FileSystemLocations` /
   * `Triggers` / `BuildBatchConfig` / `ResourceAccessRole`. These are
   * rarely set in practice and surfacing them with partial shape would
   * fire false drift on every project that uses them.
   *
   * Tags are surfaced from the same `BatchGetProjects` response (CodeBuild
   * uses lower-case `key`/`value` shape; `normalizeAwsTagsToCfn` re-shapes
   * to CFn `[{Key, Value}]`). CDK's `aws:*` auto-tags are filtered out
   * and the result key is omitted when AWS reports no user tags. Returns
   * `undefined` when the project is gone (`projects` array empty /
   * `projectsNotFound` set).
   */
  async readCurrentState(
    physicalId: string,
    _logicalId: string,
    _resourceType: string
  ): Promise<Record<string, unknown> | undefined> {
    let project;
    try {
      const resp = await this.getClient().send(
        new BatchGetProjectsCommand({ names: [physicalId] })
      );
      project = resp.projects?.[0];
    } catch (err) {
      if (err instanceof ResourceNotFoundException) return undefined;
      throw err;
    }
    if (!project) return undefined;

    // CodeBuild projects are mutable via UpdateProject; emit user-controllable
    // top-level keys with placeholders so a console-side ADD on a property
    // not templated at deploy time surfaces as drift.
    const result: Record<string, unknown> = {};
    if (project.name !== undefined) result['Name'] = project.name;
    result['Description'] = project.description ?? '';
    result['ServiceRole'] = project.serviceRole ?? '';
    if (project.timeoutInMinutes !== undefined) {
      result['TimeoutInMinutes'] = project.timeoutInMinutes;
    }
    if (project.queuedTimeoutInMinutes !== undefined) {
      result['QueuedTimeoutInMinutes'] = project.queuedTimeoutInMinutes;
    }
    result['EncryptionKey'] = project.encryptionKey ?? '';
    if (project.concurrentBuildLimit !== undefined) {
      result['ConcurrentBuildLimit'] = project.concurrentBuildLimit;
    }
    result['BadgeEnabled'] = project.badge?.badgeEnabled ?? false;
    result['SourceVersion'] = project.sourceVersion ?? '';

    {
      const src: Record<string, unknown> = {};
      if (project.source?.type !== undefined) src['Type'] = project.source.type;
      if (project.source?.location !== undefined) src['Location'] = project.source.location;
      if (project.source?.buildspec !== undefined) src['BuildSpec'] = project.source.buildspec;
      if (project.source?.gitCloneDepth !== undefined) {
        src['GitCloneDepth'] = project.source.gitCloneDepth;
      }
      if (project.source?.insecureSsl !== undefined)
        src['InsecureSsl'] = project.source.insecureSsl;
      if (project.source?.reportBuildStatus !== undefined) {
        src['ReportBuildStatus'] = project.source.reportBuildStatus;
      }
      result['Source'] = src;
    }

    {
      const art: Record<string, unknown> = {};
      if (project.artifacts?.type !== undefined) art['Type'] = project.artifacts.type;
      if (project.artifacts?.location !== undefined) art['Location'] = project.artifacts.location;
      if (project.artifacts?.path !== undefined) art['Path'] = project.artifacts.path;
      if (project.artifacts?.name !== undefined) art['Name'] = project.artifacts.name;
      if (project.artifacts?.namespaceType !== undefined) {
        art['NamespaceType'] = project.artifacts.namespaceType;
      }
      if (project.artifacts?.packaging !== undefined)
        art['Packaging'] = project.artifacts.packaging;
      if (project.artifacts?.encryptionDisabled !== undefined) {
        art['EncryptionDisabled'] = project.artifacts.encryptionDisabled;
      }
      if (project.artifacts?.overrideArtifactName !== undefined) {
        art['OverrideArtifactName'] = project.artifacts.overrideArtifactName;
      }
      if (project.artifacts?.artifactIdentifier !== undefined) {
        art['ArtifactIdentifier'] = project.artifacts.artifactIdentifier;
      }
      result['Artifacts'] = art;
    }

    {
      const env: Record<string, unknown> = {};
      if (project.environment?.type !== undefined) env['Type'] = project.environment.type;
      if (project.environment?.image !== undefined) env['Image'] = project.environment.image;
      if (project.environment?.computeType !== undefined) {
        env['ComputeType'] = project.environment.computeType;
      }
      if (project.environment?.privilegedMode !== undefined) {
        env['PrivilegedMode'] = project.environment.privilegedMode;
      }
      if (project.environment?.imagePullCredentialsType !== undefined) {
        env['ImagePullCredentialsType'] = project.environment.imagePullCredentialsType;
      }
      if (project.environment?.certificate !== undefined) {
        env['Certificate'] = project.environment.certificate;
      }
      env['EnvironmentVariables'] = (project.environment?.environmentVariables ?? []).map((ev) => {
        const out: Record<string, unknown> = {};
        if (ev.name !== undefined) out['Name'] = ev.name;
        if (ev.value !== undefined) out['Value'] = ev.value;
        if (ev.type !== undefined) out['Type'] = ev.type;
        return out;
      });
      result['Environment'] = env;
    }

    // LogsConfig — both sub-shapes (cloudWatchLogs / s3Logs) are user-
    // controllable. Always-emit nested placeholders so a console-side
    // enable on either is detectable; AWS's CFn shape uses Status to
    // toggle each, so a console-side enable shows up as
    // Status: 'ENABLED' against the always-emit Status: 'DISABLED'.
    {
      const logs: Record<string, unknown> = {};
      const cw: Record<string, unknown> = {
        Status: project.logsConfig?.cloudWatchLogs?.status ?? 'ENABLED',
      };
      if (project.logsConfig?.cloudWatchLogs?.groupName !== undefined) {
        cw['GroupName'] = project.logsConfig.cloudWatchLogs.groupName;
      }
      if (project.logsConfig?.cloudWatchLogs?.streamName !== undefined) {
        cw['StreamName'] = project.logsConfig.cloudWatchLogs.streamName;
      }
      logs['CloudWatchLogs'] = cw;
      const s3: Record<string, unknown> = {
        Status: project.logsConfig?.s3Logs?.status ?? 'DISABLED',
      };
      if (project.logsConfig?.s3Logs?.location !== undefined) {
        s3['Location'] = project.logsConfig.s3Logs.location;
      }
      if (project.logsConfig?.s3Logs?.encryptionDisabled !== undefined) {
        s3['EncryptionDisabled'] = project.logsConfig.s3Logs.encryptionDisabled;
      }
      if (project.logsConfig?.s3Logs?.bucketOwnerAccess !== undefined) {
        s3['BucketOwnerAccess'] = project.logsConfig.s3Logs.bucketOwnerAccess;
      }
      logs['S3Logs'] = s3;
      result['LogsConfig'] = logs;
    }

    // VpcConfig — Class 1: AWS only returns vpcId / subnets / securityGroupIds
    // when the project actually has a VPC config (not all projects do).
    // Emit `{}` placeholder when AWS reports no VPC config so a console-
    // side ADD against the empty placeholder shows up via the comparator's
    // union-walk on the v3 observedProperties baseline.
    if (project.vpcConfig?.vpcId !== undefined) {
      const vpc: Record<string, unknown> = { VpcId: project.vpcConfig.vpcId };
      vpc['Subnets'] = project.vpcConfig.subnets ?? [];
      vpc['SecurityGroupIds'] = project.vpcConfig.securityGroupIds ?? [];
      result['VpcConfig'] = vpc;
    } else {
      result['VpcConfig'] = {};
    }

    // Cache — always-emit `{Type: 'NO_CACHE'}` placeholder (AWS-default
    // when not configured) so a console-side enable surfaces as drift.
    {
      const cache: Record<string, unknown> = {
        Type: project.cache?.type ?? 'NO_CACHE',
      };
      if (project.cache?.location !== undefined) cache['Location'] = project.cache.location;
      if (project.cache?.modes !== undefined) cache['Modes'] = project.cache.modes;
      result['Cache'] = cache;
    }

    // Tags from the same BatchGetProjects response (CodeBuild uses lower-case
    // {key, value} shape).
    const tags = normalizeAwsTagsToCfn(project.tags);
    result['Tags'] = tags;

    return result;
  }

  async import(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    const explicit = resolveExplicitPhysicalId(input, 'Name');
    if (explicit) {
      try {
        const resp = await this.getClient().send(
          new BatchGetProjectsCommand({ names: [explicit] })
        );
        return resp.projects?.[0]?.name ? { physicalId: explicit, attributes: {} } : null;
      } catch (err) {
        if (err instanceof ResourceNotFoundException) return null;
        throw err;
      }
    }

    if (!input.cdkPath) return null;

    let nextToken: string | undefined;
    do {
      const list = await this.getClient().send(
        new ListProjectsCommand({ ...(nextToken && { nextToken }) })
      );
      const names = (list.projects ?? []).filter((n): n is string => typeof n === 'string');
      if (names.length > 0) {
        const batch = await this.getClient().send(new BatchGetProjectsCommand({ names }));
        for (const proj of batch.projects ?? []) {
          if (!proj.name) continue;
          const tags = proj.tags ?? [];
          for (const t of tags) {
            if (t.key === CDK_PATH_TAG && t.value === input.cdkPath) {
              return { physicalId: proj.name, attributes: {} };
            }
          }
        }
      }
      nextToken = list.nextToken;
    } while (nextToken);
    return null;
  }
}
