import { SetTopicAttributesCommand } from '@aws-sdk/client-sns';
import { getLogger } from '../../utils/logger.js';
import { getAwsClients } from '../../utils/aws-clients.js';
import { ProvisioningError } from '../../utils/error-handler.js';
import type {
  ResourceProvider,
  ResourceCreateResult,
  ResourceUpdateResult,
} from '../../types/resource.js';

/**
 * AWS SNS Topic Policy Provider
 *
 * Implements resource provisioning for AWS::SNS::TopicPolicy using the SNS SDK.
 * This is required because SNS TopicPolicy is not supported by Cloud Control API.
 *
 * SNS TopicPolicy applies a policy document to one or more SNS topics via
 * SetTopicAttributes with AttributeName='Policy'.
 */
export class SNSTopicPolicyProvider implements ResourceProvider {
  private logger = getLogger().child('SNSTopicPolicyProvider');

  /**
   * Create an SNS topic policy
   *
   * Applies the PolicyDocument to each topic in the Topics array.
   * Physical ID is a comma-separated list of topic ARNs.
   */
  async create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
  ): Promise<ResourceCreateResult> {
    this.logger.debug(`Creating SNS topic policy ${logicalId}`);

    const topics = properties['Topics'] as string[] | undefined;
    const policyDocument = properties['PolicyDocument'];

    if (!topics || topics.length === 0) {
      throw new ProvisioningError(
        `Topics is required for SNS topic policy ${logicalId}`,
        resourceType,
        logicalId
      );
    }

    if (!policyDocument) {
      throw new ProvisioningError(
        `PolicyDocument is required for SNS topic policy ${logicalId}`,
        resourceType,
        logicalId
      );
    }

    const policyDoc =
      typeof policyDocument === 'string' ? policyDocument : JSON.stringify(policyDocument);

    try {
      for (const topicArn of topics) {
        await this.setTopicPolicy(topicArn, policyDoc);
      }

      this.logger.debug(`Successfully created SNS topic policy ${logicalId}`);

      // Physical ID is the comma-separated list of topic ARNs
      const physicalId = topics.join(',');

      return {
        physicalId,
        attributes: {},
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to create SNS topic policy ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        undefined,
        cause
      );
    }
  }

  /**
   * Update an SNS topic policy
   */
  async update(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    _previousProperties: Record<string, unknown>
  ): Promise<ResourceUpdateResult> {
    this.logger.debug(`Updating SNS topic policy ${logicalId}: ${physicalId}`);

    const topics = properties['Topics'] as string[] | undefined;
    const policyDocument = properties['PolicyDocument'];

    if (!topics || topics.length === 0) {
      throw new ProvisioningError(
        `Topics is required for SNS topic policy ${logicalId}`,
        resourceType,
        logicalId,
        physicalId
      );
    }

    if (!policyDocument) {
      throw new ProvisioningError(
        `PolicyDocument is required for SNS topic policy ${logicalId}`,
        resourceType,
        logicalId,
        physicalId
      );
    }

    const policyDoc =
      typeof policyDocument === 'string' ? policyDocument : JSON.stringify(policyDocument);

    try {
      for (const topicArn of topics) {
        await this.setTopicPolicy(topicArn, policyDoc);
      }

      this.logger.debug(`Successfully updated SNS topic policy ${logicalId}`);

      const newPhysicalId = topics.join(',');

      return {
        physicalId: newPhysicalId,
        wasReplaced: false,
        attributes: {},
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to update SNS topic policy ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  /**
   * Delete an SNS topic policy
   *
   * Removes the policy from each topic by setting an empty policy.
   */
  async delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    _properties?: Record<string, unknown>
  ): Promise<void> {
    this.logger.debug(`Deleting SNS topic policy ${logicalId}: ${physicalId}`);

    const topicArns = physicalId.split(',');

    for (const topicArn of topicArns) {
      try {
        await this.setTopicPolicy(topicArn, '{}');
        this.logger.debug(`Removed policy from topic ${topicArn}`);
      } catch (error) {
        // If the topic doesn't exist, that's fine - skip it
        if (
          error instanceof Error &&
          (error.name === 'NotFoundException' ||
            error.name === 'NotFound' ||
            error.message.includes('not found') ||
            error.message.includes('does not exist'))
        ) {
          this.logger.debug(`Topic ${topicArn} does not exist, skipping policy removal`);
          continue;
        }
        const cause = error instanceof Error ? error : undefined;
        throw new ProvisioningError(
          `Failed to delete SNS topic policy ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
          resourceType,
          logicalId,
          physicalId,
          cause
        );
      }
    }

    this.logger.debug(`Successfully deleted SNS topic policy ${logicalId}`);
  }

  /**
   * Set the policy on a single SNS topic
   */
  private async setTopicPolicy(topicArn: string, policyDoc: string): Promise<void> {
    const snsClient = getAwsClients().sns;
    await snsClient.send(
      new SetTopicAttributesCommand({
        TopicArn: topicArn,
        AttributeName: 'Policy',
        AttributeValue: policyDoc,
      })
    );
  }
}
