import {
  SSMClient,
  PutParameterCommand,
  DeleteParameterCommand,
  AddTagsToResourceCommand,
  RemoveTagsFromResourceCommand,
  ParameterNotFound,
  type ParameterType,
  type Tag,
} from '@aws-sdk/client-ssm';
import { getLogger } from '../../utils/logger.js';
import { getAwsClients } from '../../utils/aws-clients.js';
import { ProvisioningError } from '../../utils/error-handler.js';
import { assertRegionMatch, type DeleteContext } from '../region-check.js';
import { generateResourceName } from '../resource-name.js';
import type {
  ResourceProvider,
  ResourceCreateResult,
  ResourceUpdateResult,
} from '../../types/resource.js';

/**
 * AWS SSM Parameter Provider
 *
 * Implements resource provisioning for AWS::SSM::Parameter using the SSM SDK.
 * This is required because SSM Parameter is not supported by Cloud Control API.
 */
export class SSMParameterProvider implements ResourceProvider {
  private ssmClient: SSMClient;
  private logger = getLogger().child('SSMParameterProvider');

  handledProperties = new Map<string, ReadonlySet<string>>([
    [
      'AWS::SSM::Parameter',
      new Set([
        'Name',
        'Type',
        'Value',
        'Description',
        'Tags',
        'AllowedPattern',
        'Tier',
        'Policies',
        'DataType',
      ]),
    ],
  ]);

  constructor() {
    const awsClients = getAwsClients();
    this.ssmClient = awsClients.ssm;
  }

  /**
   * Create an SSM parameter
   */
  async create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
  ): Promise<ResourceCreateResult> {
    this.logger.debug(`Creating SSM parameter ${logicalId}`);

    const name =
      (properties['Name'] as string | undefined) ||
      `/${generateResourceName(logicalId, { maxLength: 1023, allowedPattern: /[^a-zA-Z0-9-/_]/g })}`;
    const type = (properties['Type'] as string | undefined) || 'String';
    const value = properties['Value'] as string | undefined;

    if (!value) {
      throw new ProvisioningError(
        `Value is required for SSM parameter ${logicalId}`,
        resourceType,
        logicalId
      );
    }

    try {
      const putParams: import('@aws-sdk/client-ssm').PutParameterCommandInput = {
        Name: name,
        Type: type as ParameterType,
        Value: value,
        Description: properties['Description'] as string | undefined,
        Overwrite: false,
      };
      if (properties['AllowedPattern']) {
        putParams.AllowedPattern = properties['AllowedPattern'] as string;
      }
      if (properties['Tier']) {
        putParams.Tier = properties['Tier'] as import('@aws-sdk/client-ssm').ParameterTier;
      }
      if (properties['Policies']) {
        putParams.Policies = properties['Policies'] as string;
      }
      if (properties['DataType']) {
        putParams.DataType = properties['DataType'] as string;
      }

      await this.ssmClient.send(new PutParameterCommand(putParams));

      // Apply tags if specified
      if (properties['Tags']) {
        const cfnTags = properties['Tags'] as Array<{ Key: string; Value: string }>;
        const ssmTags: Tag[] = cfnTags.map((t) => ({ Key: t.Key, Value: t.Value }));
        await this.ssmClient.send(
          new AddTagsToResourceCommand({
            ResourceType: 'Parameter',
            ResourceId: name,
            Tags: ssmTags,
          })
        );
      }

      this.logger.debug(`Successfully created SSM parameter ${logicalId}: ${name}`);

      return {
        physicalId: name,
        attributes: {
          Type: type as ParameterType,
          Value: value,
        },
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to create SSM parameter ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        undefined,
        cause
      );
    }
  }

  /**
   * Update an SSM parameter
   */
  async update(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>
  ): Promise<ResourceUpdateResult> {
    this.logger.debug(`Updating SSM parameter ${logicalId}: ${physicalId}`);

    const type = (properties['Type'] as string | undefined) || 'String';
    const value = properties['Value'] as string | undefined;

    if (!value) {
      throw new ProvisioningError(
        `Value is required for SSM parameter ${logicalId}`,
        resourceType,
        logicalId,
        physicalId
      );
    }

    try {
      const putParams: import('@aws-sdk/client-ssm').PutParameterCommandInput = {
        Name: physicalId,
        Type: type as ParameterType,
        Value: value,
        Description: properties['Description'] as string | undefined,
        Overwrite: true,
      };
      if (properties['AllowedPattern']) {
        putParams.AllowedPattern = properties['AllowedPattern'] as string;
      }
      if (properties['Tier']) {
        putParams.Tier = properties['Tier'] as import('@aws-sdk/client-ssm').ParameterTier;
      }
      if (properties['Policies']) {
        putParams.Policies = properties['Policies'] as string;
      }
      if (properties['DataType']) {
        putParams.DataType = properties['DataType'] as string;
      }

      await this.ssmClient.send(new PutParameterCommand(putParams));

      // Update Tags if changed
      const newTags = properties['Tags'] as Array<{ Key: string; Value: string }> | undefined;
      const oldTags = previousProperties['Tags'] as
        | Array<{ Key: string; Value: string }>
        | undefined;
      if (JSON.stringify(newTags) !== JSON.stringify(oldTags)) {
        // Remove old tags
        if (oldTags && oldTags.length > 0) {
          await this.ssmClient.send(
            new RemoveTagsFromResourceCommand({
              ResourceType: 'Parameter',
              ResourceId: physicalId,
              TagKeys: oldTags.map((t) => t.Key),
            })
          );
        }
        // Apply new tags
        if (newTags && newTags.length > 0) {
          const ssmTags: Tag[] = newTags.map((t) => ({ Key: t.Key, Value: t.Value }));
          await this.ssmClient.send(
            new AddTagsToResourceCommand({
              ResourceType: 'Parameter',
              ResourceId: physicalId,
              Tags: ssmTags,
            })
          );
        }
        this.logger.debug(`Updated tags for SSM parameter ${physicalId}`);
      }

      this.logger.debug(`Successfully updated SSM parameter ${logicalId}`);

      return {
        physicalId,
        wasReplaced: false,
        attributes: {
          Type: type as ParameterType,
          Value: value,
        },
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to update SSM parameter ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  /**
   * Delete an SSM parameter
   */
  async delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    _properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void> {
    this.logger.debug(`Deleting SSM parameter ${logicalId}: ${physicalId}`);

    try {
      await this.ssmClient.send(
        new DeleteParameterCommand({
          Name: physicalId,
        })
      );

      this.logger.debug(`Successfully deleted SSM parameter ${logicalId}`);
    } catch (error) {
      if (error instanceof ParameterNotFound) {
        const clientRegion = await this.ssmClient.config.region();
        assertRegionMatch(
          clientRegion,
          context?.expectedRegion,
          resourceType,
          logicalId,
          physicalId
        );
        this.logger.debug(`Parameter ${physicalId} does not exist, skipping deletion`);
        return;
      }

      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to delete SSM parameter ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }
}
