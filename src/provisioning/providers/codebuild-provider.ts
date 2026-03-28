import {
  CodeBuildClient,
  CreateProjectCommand,
  DeleteProjectCommand,
  UpdateProjectCommand,
  ResourceNotFoundException,
  type SourceType,
  type EnvironmentType,
  type ComputeType,
  type ArtifactsType,
  type EnvironmentVariableType,
} from '@aws-sdk/client-codebuild';
import { getLogger } from '../../utils/logger.js';
import { ProvisioningError } from '../../utils/error-handler.js';
import type {
  ResourceProvider,
  ResourceCreateResult,
  ResourceUpdateResult,
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

  private getClient(): CodeBuildClient {
    if (!this.client) {
      this.client = new CodeBuildClient(this.providerRegion ? { region: this.providerRegion } : {});
    }
    return this.client;
  }

  private mapProperties(logicalId: string, properties: Record<string, unknown>) {
    const name = (properties['Name'] as string | undefined) ?? logicalId;
    const source = properties['Source'] as Record<string, unknown> | undefined;
    const environment = properties['Environment'] as Record<string, unknown> | undefined;
    const serviceRole = properties['ServiceRole'] as string | undefined;
    const artifacts = properties['Artifacts'] as Record<string, unknown> | undefined;
    const tags = properties['Tags'] as Array<{ Key: string; Value: string }> | undefined;

    let buildspec: string | undefined;
    if (source?.['BuildSpec'] !== undefined) {
      const bs = source['BuildSpec'];
      buildspec = typeof bs === 'object' ? JSON.stringify(bs) : (bs as string);
    }

    const envVars = environment?.['EnvironmentVariables'] as
      | Array<{ Name: string; Value: string; Type?: string }>
      | undefined;

    return {
      name,
      source: {
        type: ((source?.['Type'] as string) ?? 'NO_SOURCE') as SourceType,
        buildspec,
        location: source?.['Location'] as string | undefined,
      },
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
      },
      serviceRole,
      artifacts: {
        type: ((artifacts?.['Type'] as string) ?? 'NO_ARTIFACTS') as ArtifactsType,
      },
      tags: tags ? tags.map((t) => ({ key: t.Key, value: t.Value })) : undefined,
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
    _properties?: Record<string, unknown>
  ): Promise<void> {
    this.logger.debug(`Deleting CodeBuild Project ${logicalId}: ${physicalId}`);

    try {
      await this.getClient().send(new DeleteProjectCommand({ name: physicalId }));
      this.logger.debug(`Successfully deleted CodeBuild Project ${logicalId}`);
    } catch (error) {
      if (error instanceof ResourceNotFoundException) {
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
}
