import {
  SNSClient,
  CreateTopicCommand,
  DeleteTopicCommand,
  NotFoundException,
  type CreateTopicCommandInput,
  type Tag,
} from '@aws-sdk/client-sns';
import { getLogger } from '../../utils/logger.js';
import { getAwsClients } from '../../utils/aws-clients.js';
import { ProvisioningError } from '../../utils/error-handler.js';
import type {
  ResourceProvider,
  ResourceCreateResult,
  ResourceUpdateResult,
} from '../../types/resource.js';

/**
 * AWS SNS Topic Provider
 *
 * Implements resource provisioning for AWS::SNS::Topic using the SNS SDK.
 * WHY: SNS CreateTopic is synchronous and idempotent - the CC API adds unnecessary
 * polling overhead (1s->2s->4s->8s) for an operation that completes immediately.
 * This SDK provider eliminates that polling and returns instantly.
 */
export class SNSTopicProvider implements ResourceProvider {
  private snsClient: SNSClient;
  private logger = getLogger().child('SNSTopicProvider');

  constructor() {
    const awsClients = getAwsClients();
    this.snsClient = awsClients.sns;
  }

  /**
   * Create an SNS topic
   */
  async create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
  ): Promise<ResourceCreateResult> {
    this.logger.debug(`Creating SNS topic ${logicalId}`);

    const topicName = (properties['TopicName'] as string | undefined) || logicalId;

    try {
      // Build attributes map for topic configuration
      const topicAttributes: Record<string, string> = {};

      if (properties['FifoTopic']) {
        topicAttributes['FifoTopic'] = String(properties['FifoTopic']);
      }
      if (properties['ContentBasedDeduplication']) {
        topicAttributes['ContentBasedDeduplication'] = String(
          properties['ContentBasedDeduplication']
        );
      }
      if (properties['DisplayName']) {
        topicAttributes['DisplayName'] = properties['DisplayName'] as string;
      }
      if (properties['KmsMasterKeyId']) {
        topicAttributes['KmsMasterKeyId'] = properties['KmsMasterKeyId'] as string;
      }

      // Build tags
      let tags: Tag[] | undefined;
      if (properties['Tags']) {
        tags = properties['Tags'] as Tag[];
      }

      const createParams: CreateTopicCommandInput = {
        Name: topicName,
        ...(Object.keys(topicAttributes).length > 0 && { Attributes: topicAttributes }),
        ...(tags && { Tags: tags }),
      };

      const response = await this.snsClient.send(new CreateTopicCommand(createParams));

      const topicArn = response.TopicArn;
      if (!topicArn) {
        throw new Error('CreateTopic did not return TopicArn');
      }

      this.logger.debug(`Successfully created SNS topic ${logicalId}: ${topicArn}`);

      // Extract topic name from ARN (last segment after :)
      const extractedName = topicArn.split(':').pop() || topicName;

      return {
        physicalId: topicArn,
        attributes: {
          TopicArn: topicArn,
          TopicName: extractedName,
        },
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to create SNS topic ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        topicName,
        cause
      );
    }
  }

  /**
   * Update an SNS topic
   *
   * SNS topics have limited mutable properties (DisplayName, KmsMasterKeyId, etc.).
   * TopicName is immutable and requires replacement (handled by deployment layer).
   */
  // eslint-disable-next-line @typescript-eslint/require-await
  async update(
    logicalId: string,
    physicalId: string,
    _resourceType: string,
    _properties: Record<string, unknown>,
    _previousProperties: Record<string, unknown>
  ): Promise<ResourceUpdateResult> {
    this.logger.debug(`Updating SNS topic ${logicalId}: ${physicalId}`);

    // SNS topics have very limited update capabilities via SetTopicAttributes.
    // For simplicity, we rely on the deployment layer's replacement detection
    // for immutable property changes. Mutable changes (DisplayName etc.) are rare.

    const topicName = physicalId.split(':').pop() || logicalId;

    return {
      physicalId,
      wasReplaced: false,
      attributes: {
        TopicArn: physicalId,
        TopicName: topicName,
      },
    };
  }

  /**
   * Delete an SNS topic
   */
  async delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    _properties?: Record<string, unknown>
  ): Promise<void> {
    this.logger.debug(`Deleting SNS topic ${logicalId}: ${physicalId}`);

    try {
      await this.snsClient.send(new DeleteTopicCommand({ TopicArn: physicalId }));
      this.logger.debug(`Successfully deleted SNS topic ${logicalId}`);
    } catch (error) {
      if (error instanceof NotFoundException) {
        this.logger.debug(`SNS topic ${physicalId} does not exist, skipping deletion`);
        return;
      }
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to delete SNS topic ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }
}
