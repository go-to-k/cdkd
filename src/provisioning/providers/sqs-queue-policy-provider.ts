import { SQSClient, SetQueueAttributesCommand } from '@aws-sdk/client-sqs';
import { getLogger } from '../../utils/logger.js';
import { getAwsClients } from '../../utils/aws-clients.js';
import { ProvisioningError } from '../../utils/error-handler.js';
import type {
  ResourceProvider,
  ResourceCreateResult,
  ResourceUpdateResult,
} from '../../types/resource.js';

/**
 * AWS SQS Queue Policy Provider
 *
 * Implements resource provisioning for AWS::SQS::QueuePolicy using the SQS SDK.
 * This is required because SQS Queue Policy is not supported by Cloud Control API.
 */
export class SQSQueuePolicyProvider implements ResourceProvider {
  private sqsClient: SQSClient;
  private logger = getLogger().child('SQSQueuePolicyProvider');

  constructor() {
    const awsClients = getAwsClients();
    this.sqsClient = awsClients.sqs;
  }

  /**
   * Create an SQS queue policy
   */
  async create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
  ): Promise<ResourceCreateResult> {
    this.logger.info(`Creating SQS queue policy ${logicalId}`);

    const queues = properties['Queues'] as string[] | undefined;
    const policyDocument = properties['PolicyDocument'];

    if (!queues || queues.length === 0) {
      throw new ProvisioningError(
        `Queues is required for SQS queue policy ${logicalId}`,
        resourceType,
        logicalId
      );
    }

    if (!policyDocument) {
      throw new ProvisioningError(
        `PolicyDocument is required for SQS queue policy ${logicalId}`,
        resourceType,
        logicalId
      );
    }

    try {
      // Serialize policy document
      const policyDoc =
        typeof policyDocument === 'string' ? policyDocument : JSON.stringify(policyDocument);

      // Apply policy to all queues
      for (const queueUrl of queues) {
        this.logger.debug(`Setting policy for queue: ${queueUrl}`);
        await this.sqsClient.send(
          new SetQueueAttributesCommand({
            QueueUrl: queueUrl,
            Attributes: {
              Policy: policyDoc,
            },
          })
        );
      }

      this.logger.info(`Successfully created SQS queue policy ${logicalId}`);

      // Physical ID is the first queue URL
      return {
        physicalId: queues[0]!,
        attributes: {},
      };
    } catch (error) {
      throw new ProvisioningError(
        `Failed to create SQS queue policy ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        queues[0],
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Update an SQS queue policy
   */
  async update(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    _previousProperties: Record<string, unknown>
  ): Promise<ResourceUpdateResult> {
    this.logger.info(`Updating SQS queue policy ${logicalId}: ${physicalId}`);

    const queues = properties['Queues'] as string[] | undefined;
    const policyDocument = properties['PolicyDocument'];

    if (!queues || queues.length === 0) {
      throw new ProvisioningError(
        `Queues is required for SQS queue policy ${logicalId}`,
        resourceType,
        logicalId,
        physicalId
      );
    }

    if (!policyDocument) {
      throw new ProvisioningError(
        `PolicyDocument is required for SQS queue policy ${logicalId}`,
        resourceType,
        logicalId,
        physicalId
      );
    }

    try {
      // Serialize policy document
      const policyDoc =
        typeof policyDocument === 'string' ? policyDocument : JSON.stringify(policyDocument);

      // Apply policy to all queues
      for (const queueUrl of queues) {
        this.logger.debug(`Updating policy for queue: ${queueUrl}`);
        await this.sqsClient.send(
          new SetQueueAttributesCommand({
            QueueUrl: queueUrl,
            Attributes: {
              Policy: policyDoc,
            },
          })
        );
      }

      this.logger.info(`Successfully updated SQS queue policy ${logicalId}`);

      return {
        physicalId: queues[0]!,
        wasReplaced: false,
        attributes: {},
      };
    } catch (error) {
      throw new ProvisioningError(
        `Failed to update SQS queue policy ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Delete an SQS queue policy
   */
  async delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    _properties?: Record<string, unknown>
  ): Promise<void> {
    this.logger.info(`Deleting SQS queue policy ${logicalId}: ${physicalId}`);

    try {
      // Remove the policy by setting it to empty
      await this.sqsClient.send(
        new SetQueueAttributesCommand({
          QueueUrl: physicalId,
          Attributes: {
            Policy: '',
          },
        })
      );

      this.logger.info(`Successfully deleted SQS queue policy ${logicalId}`);
    } catch (error) {
      // Check if queue doesn't exist
      if (
        error instanceof Error &&
        (error.name === 'QueueDoesNotExist' || error.message.includes('does not exist'))
      ) {
        this.logger.info(`Queue ${physicalId} does not exist, skipping policy deletion`);
        return;
      }

      throw new ProvisioningError(
        `Failed to delete SQS queue policy ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        error instanceof Error ? error : undefined
      );
    }
  }
}
