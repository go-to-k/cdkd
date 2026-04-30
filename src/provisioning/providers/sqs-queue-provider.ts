import {
  SQSClient,
  CreateQueueCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  SetQueueAttributesCommand,
  QueueDoesNotExist,
} from '@aws-sdk/client-sqs';
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
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
 * CDK property name to SQS attribute name mapping
 */
const CDK_TO_SQS_ATTRIBUTES: Record<string, string> = {
  VisibilityTimeout: 'VisibilityTimeout',
  MaximumMessageSize: 'MaximumMessageSize',
  MessageRetentionPeriod: 'MessageRetentionPeriod',
  DelaySeconds: 'DelaySeconds',
  ReceiveMessageWaitTimeSeconds: 'ReceiveMessageWaitTimeSeconds',
  RedrivePolicy: 'RedrivePolicy',
  FifoQueue: 'FifoQueue',
  ContentBasedDeduplication: 'ContentBasedDeduplication',
  KmsMasterKeyId: 'KmsMasterKeyId',
  KmsDataKeyReusePeriodSeconds: 'KmsDataKeyReusePeriodSeconds',
  SqsManagedSseEnabled: 'SqsManagedSseEnabled',
  DeduplicationScope: 'DeduplicationScope',
  FifoThroughputLimit: 'FifoThroughputLimit',
};

/**
 * AWS SQS Queue Provider
 *
 * Implements resource provisioning for AWS::SQS::Queue using the SQS SDK.
 * WHY: SQS CreateQueue is synchronous - the CC API adds unnecessary polling
 * overhead (1s->2s->4s->8s) for an operation that completes immediately.
 * This SDK provider eliminates that polling and returns instantly.
 */
export class SQSQueueProvider implements ResourceProvider {
  private sqsClient: SQSClient;
  private stsClient: STSClient;
  private logger = getLogger().child('SQSQueueProvider');
  handledProperties = new Map<string, ReadonlySet<string>>([
    [
      'AWS::SQS::Queue',
      new Set([
        'QueueName',
        'VisibilityTimeout',
        'MaximumMessageSize',
        'MessageRetentionPeriod',
        'DelaySeconds',
        'ReceiveMessageWaitTimeSeconds',
        'RedrivePolicy',
        'FifoQueue',
        'ContentBasedDeduplication',
        'KmsMasterKeyId',
        'KmsDataKeyReusePeriodSeconds',
        'SqsManagedSseEnabled',
        'DeduplicationScope',
        'FifoThroughputLimit',
        'Tags',
      ]),
    ],
  ]);

  constructor() {
    const awsClients = getAwsClients();
    this.sqsClient = awsClients.sqs;
    this.stsClient = awsClients.sts;
  }

  /**
   * Create an SQS queue
   */
  async create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
  ): Promise<ResourceCreateResult> {
    this.logger.debug(`Creating SQS queue ${logicalId}`);

    const queueName =
      (properties['QueueName'] as string | undefined) ||
      generateResourceName(logicalId, { maxLength: 80 });

    try {
      // Convert CDK properties to SQS attributes
      const attributes: Record<string, string> = {};
      for (const [cdkKey, sqsKey] of Object.entries(CDK_TO_SQS_ATTRIBUTES)) {
        if (properties[cdkKey] !== undefined) {
          const value = properties[cdkKey];
          // RedrivePolicy needs to be JSON string
          if (cdkKey === 'RedrivePolicy' && typeof value === 'object') {
            attributes[sqsKey] = JSON.stringify(value);
          } else {
            attributes[sqsKey] = String(value);
          }
        }
      }

      const tags: Record<string, string> = {};
      if (properties['Tags']) {
        const tagList = properties['Tags'] as Array<{ Key: string; Value: string }>;
        for (const tag of tagList) {
          tags[tag.Key] = tag.Value;
        }
      }

      const response = await this.sqsClient.send(
        new CreateQueueCommand({
          QueueName: queueName,
          ...(Object.keys(attributes).length > 0 && { Attributes: attributes }),
          ...(Object.keys(tags).length > 0 && { tags }),
        })
      );

      const queueUrl = response.QueueUrl;
      if (!queueUrl) {
        throw new Error('CreateQueue did not return QueueUrl');
      }

      this.logger.debug(`Successfully created SQS queue ${logicalId}: ${queueUrl}`);

      // Construct ARN from account/region/queueName
      const arn = await this.constructArn(queueName);

      return {
        physicalId: queueUrl,
        attributes: {
          Arn: arn,
          QueueUrl: queueUrl,
          QueueName: queueName,
        },
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to create SQS queue ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        queueName,
        cause
      );
    }
  }

  /**
   * Update an SQS queue
   */
  async update(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    _previousProperties: Record<string, unknown>
  ): Promise<ResourceUpdateResult> {
    this.logger.debug(`Updating SQS queue ${logicalId}: ${physicalId}`);

    try {
      // Convert CDK properties to SQS attributes
      const attributes: Record<string, string> = {};
      for (const [cdkKey, sqsKey] of Object.entries(CDK_TO_SQS_ATTRIBUTES)) {
        // Skip immutable attributes (FifoQueue cannot be changed after creation)
        if (cdkKey === 'FifoQueue') continue;

        if (properties[cdkKey] !== undefined) {
          const value = properties[cdkKey];
          if (cdkKey === 'RedrivePolicy' && typeof value === 'object') {
            attributes[sqsKey] = JSON.stringify(value);
          } else {
            attributes[sqsKey] = String(value);
          }
        }
      }

      if (Object.keys(attributes).length > 0) {
        await this.sqsClient.send(
          new SetQueueAttributesCommand({
            QueueUrl: physicalId,
            Attributes: attributes,
          })
        );
        this.logger.debug(`Updated attributes for SQS queue ${physicalId}`);
      }

      // Get queue attributes for Arn
      const getResponse = await this.sqsClient.send(
        new GetQueueAttributesCommand({
          QueueUrl: physicalId,
          AttributeNames: ['QueueArn'],
        })
      );

      const queueName =
        (properties['QueueName'] as string | undefined) ||
        generateResourceName(logicalId, { maxLength: 80 });

      return {
        physicalId,
        wasReplaced: false,
        attributes: {
          Arn: getResponse.Attributes?.QueueArn,
          QueueUrl: physicalId,
          QueueName: queueName,
        },
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to update SQS queue ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  /**
   * Delete an SQS queue
   */
  async delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    _properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void> {
    this.logger.debug(`Deleting SQS queue ${logicalId}: ${physicalId}`);

    try {
      await this.sqsClient.send(new DeleteQueueCommand({ QueueUrl: physicalId }));
      this.logger.debug(`Successfully deleted SQS queue ${logicalId}`);
    } catch (error) {
      if (error instanceof QueueDoesNotExist) {
        const clientRegion = await this.sqsClient.config.region();
        assertRegionMatch(
          clientRegion,
          context?.expectedRegion,
          resourceType,
          logicalId,
          physicalId
        );
        this.logger.debug(`SQS queue ${physicalId} does not exist, skipping deletion`);
        return;
      }
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to delete SQS queue ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  /**
   * Construct SQS queue ARN from account/region/queue name
   */
  private async constructArn(queueName: string): Promise<string> {
    try {
      const identity = await this.stsClient.send(new GetCallerIdentityCommand({}));
      const accountId = identity.Account;
      // Get region from SQS client config
      const region = await this.sqsClient.config.region();
      return `arn:aws:sqs:${region}:${accountId}:${queueName}`;
    } catch {
      this.logger.warn('Failed to construct SQS ARN from STS, using placeholder');
      return `arn:aws:sqs:unknown:unknown:${queueName}`;
    }
  }
}
