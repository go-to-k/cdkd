import {
  SSMClient,
  PutParameterCommand,
  DeleteParameterCommand,
  ParameterNotFound,
  type ParameterType,
} from '@aws-sdk/client-ssm';
import { getLogger } from '../../utils/logger.js';
import { getAwsClients } from '../../utils/aws-clients.js';
import { ProvisioningError } from '../../utils/error-handler.js';
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

    const name = (properties['Name'] as string | undefined) || `/${logicalId}`;
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
      await this.ssmClient.send(
        new PutParameterCommand({
          Name: name,
          Type: type as ParameterType,
          Value: value,
          Description: properties['Description'] as string | undefined,
          Overwrite: false,
        })
      );

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
    _previousProperties: Record<string, unknown>
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
      await this.ssmClient.send(
        new PutParameterCommand({
          Name: physicalId,
          Type: type as ParameterType,
          Value: value,
          Description: properties['Description'] as string | undefined,
          Overwrite: true,
        })
      );

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
    _properties?: Record<string, unknown>
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
