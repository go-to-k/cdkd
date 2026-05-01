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
import { CDK_PATH_TAG, resolveExplicitPhysicalId } from '../import-helpers.js';
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
    const serviceRole = properties['ServiceRole'] as string | undefined;
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
      encryptionKey: properties['EncryptionKey'] as string | undefined,
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
      sourceVersion: properties['SourceVersion'] as string | undefined,
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
