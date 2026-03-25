import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { getLogger } from '../../utils/logger.js';
import { getAwsClients } from '../../utils/aws-clients.js';
import { ProvisioningError } from '../../utils/error-handler.js';
import type {
  ResourceProvider,
  ResourceCreateResult,
  ResourceUpdateResult,
} from '../../types/resource.js';

/**
 * Custom Resource Provider
 *
 * Implements Lambda-backed custom resources by invoking the Lambda function
 * specified in the ServiceToken property.
 *
 * This provider follows the CloudFormation custom resource protocol:
 * https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/custom-resources.html
 */
export class CustomResourceProvider implements ResourceProvider {
  private lambdaClient: LambdaClient;
  private logger = getLogger().child('CustomResourceProvider');

  constructor() {
    const awsClients = getAwsClients();
    this.lambdaClient = awsClients.lambda;
  }

  /**
   * Create a custom resource by invoking its Lambda handler
   */
  async create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
  ): Promise<ResourceCreateResult> {
    this.logger.info(`Creating custom resource ${logicalId} (${resourceType})`);

    const serviceToken = properties['ServiceToken'] as string | undefined;

    if (!serviceToken) {
      throw new ProvisioningError(
        `ServiceToken is required for custom resource ${logicalId}`,
        resourceType,
        logicalId
      );
    }

    try {
      // Prepare CloudFormation custom resource request
      const request = {
        RequestType: 'Create',
        RequestId: `cdkq-${Date.now()}-${Math.random().toString(36).substring(7)}`,
        ResponseURL: 'http://pre-signed-s3-url-for-response', // We'll handle response inline
        ResourceType: resourceType,
        LogicalResourceId: logicalId,
        StackId: `cdkq-stack-${logicalId}`,
        ResourceProperties: properties,
      };

      this.logger.debug(`Invoking Lambda for custom resource create: ${serviceToken}`);
      this.logger.debug(`Request: ${JSON.stringify(request, null, 2)}`);

      // Invoke Lambda function
      const response = await this.lambdaClient.send(
        new InvokeCommand({
          FunctionName: serviceToken,
          InvocationType: 'RequestResponse',
          Payload: Buffer.from(JSON.stringify(request)),
        })
      );

      // Parse response
      const payload = response.Payload ? JSON.parse(Buffer.from(response.Payload).toString()) : {};

      this.logger.debug(`Lambda response: ${JSON.stringify(payload, null, 2)}`);

      if (response.FunctionError) {
        throw new Error(
          `Lambda function error: ${response.FunctionError}, payload: ${JSON.stringify(payload)}`
        );
      }

      // Custom resources typically return PhysicalResourceId
      const physicalId = payload.PhysicalResourceId || logicalId;

      this.logger.info(`Successfully created custom resource ${logicalId}: ${physicalId}`);

      return {
        physicalId,
        attributes: payload.Data || {},
      };
    } catch (error) {
      throw new ProvisioningError(
        `Failed to create custom resource ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        undefined,
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Update a custom resource by invoking its Lambda handler
   */
  async update(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>
  ): Promise<ResourceUpdateResult> {
    this.logger.info(`Updating custom resource ${logicalId}: ${physicalId} (${resourceType})`);

    const serviceToken = properties['ServiceToken'] as string | undefined;

    if (!serviceToken) {
      throw new ProvisioningError(
        `ServiceToken is required for custom resource ${logicalId}`,
        resourceType,
        logicalId,
        physicalId
      );
    }

    try {
      // Prepare CloudFormation custom resource request
      const request = {
        RequestType: 'Update',
        RequestId: `cdkq-${Date.now()}-${Math.random().toString(36).substring(7)}`,
        ResponseURL: 'http://pre-signed-s3-url-for-response',
        ResourceType: resourceType,
        LogicalResourceId: logicalId,
        PhysicalResourceId: physicalId,
        StackId: `cdkq-stack-${logicalId}`,
        ResourceProperties: properties,
        OldResourceProperties: previousProperties,
      };

      this.logger.debug(`Invoking Lambda for custom resource update: ${serviceToken}`);

      // Invoke Lambda function
      const response = await this.lambdaClient.send(
        new InvokeCommand({
          FunctionName: serviceToken,
          InvocationType: 'RequestResponse',
          Payload: Buffer.from(JSON.stringify(request)),
        })
      );

      // Parse response
      const payload = response.Payload ? JSON.parse(Buffer.from(response.Payload).toString()) : {};

      if (response.FunctionError) {
        throw new Error(
          `Lambda function error: ${response.FunctionError}, payload: ${JSON.stringify(payload)}`
        );
      }

      const newPhysicalId = payload.PhysicalResourceId || physicalId;
      const wasReplaced = newPhysicalId !== physicalId;

      this.logger.info(
        `Successfully updated custom resource ${logicalId}: ${newPhysicalId}${wasReplaced ? ' (replaced)' : ''}`
      );

      return {
        physicalId: newPhysicalId,
        wasReplaced,
        attributes: payload.Data || {},
      };
    } catch (error) {
      throw new ProvisioningError(
        `Failed to update custom resource ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Delete a custom resource by invoking its Lambda handler
   */
  async delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties?: Record<string, unknown>
  ): Promise<void> {
    this.logger.info(`Deleting custom resource ${logicalId}: ${physicalId} (${resourceType})`);

    if (!properties) {
      this.logger.warn(
        `No properties available for custom resource ${logicalId}, skipping deletion`
      );
      return;
    }

    const serviceToken = properties['ServiceToken'] as string | undefined;

    if (!serviceToken) {
      this.logger.warn(`No ServiceToken found for custom resource ${logicalId}, skipping deletion`);
      return;
    }

    try {
      // Prepare CloudFormation custom resource request
      const request = {
        RequestType: 'Delete',
        RequestId: `cdkq-${Date.now()}-${Math.random().toString(36).substring(7)}`,
        ResponseURL: 'http://pre-signed-s3-url-for-response',
        ResourceType: resourceType,
        LogicalResourceId: logicalId,
        PhysicalResourceId: physicalId,
        StackId: `cdkq-stack-${logicalId}`,
        ResourceProperties: properties,
      };

      this.logger.debug(`Invoking Lambda for custom resource delete: ${serviceToken}`);

      // Invoke Lambda function
      const response = await this.lambdaClient.send(
        new InvokeCommand({
          FunctionName: serviceToken,
          InvocationType: 'RequestResponse',
          Payload: Buffer.from(JSON.stringify(request)),
        })
      );

      // Parse response
      const payload = response.Payload ? JSON.parse(Buffer.from(response.Payload).toString()) : {};

      if (response.FunctionError) {
        throw new Error(
          `Lambda function error: ${response.FunctionError}, payload: ${JSON.stringify(payload)}`
        );
      }

      this.logger.info(`Successfully deleted custom resource ${logicalId}`);
    } catch (error) {
      // For deletion, we should be more lenient with errors
      // If the Lambda doesn't exist or fails, we still want to proceed
      this.logger.warn(
        `Failed to delete custom resource ${logicalId}, but continuing: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
}
