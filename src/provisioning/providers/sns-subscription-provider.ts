import {
  SNSClient,
  SubscribeCommand,
  UnsubscribeCommand,
  NotFoundException,
} from '@aws-sdk/client-sns';
import { getLogger } from '../../utils/logger.js';
import { getAwsClients } from '../../utils/aws-clients.js';
import { ProvisioningError } from '../../utils/error-handler.js';
import { assertRegionMatch, type DeleteContext } from '../region-check.js';
import type {
  ResourceProvider,
  ResourceCreateResult,
  ResourceUpdateResult,
  ResourceImportInput,
  ResourceImportResult,
} from '../../types/resource.js';

/**
 * AWS SNS Subscription Provider
 *
 * Implements resource provisioning for AWS::SNS::Subscription using the SNS SDK.
 * This is required because SNS Subscription is not supported by Cloud Control API.
 */
export class SNSSubscriptionProvider implements ResourceProvider {
  private snsClient: SNSClient;
  private logger = getLogger().child('SNSSubscriptionProvider');

  handledProperties = new Map<string, ReadonlySet<string>>([
    ['AWS::SNS::Subscription', new Set(['TopicArn', 'Protocol', 'Endpoint', 'FilterPolicy'])],
  ]);

  constructor() {
    const awsClients = getAwsClients();
    this.snsClient = awsClients.sns;
  }

  /**
   * Create an SNS subscription
   */
  async create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
  ): Promise<ResourceCreateResult> {
    this.logger.debug(`Creating SNS subscription ${logicalId}`);

    const topicArn = properties['TopicArn'] as string | undefined;
    const protocol = properties['Protocol'] as string | undefined;
    const endpoint = properties['Endpoint'] as string | undefined;

    if (!topicArn) {
      throw new ProvisioningError(
        `TopicArn is required for SNS subscription ${logicalId}`,
        resourceType,
        logicalId
      );
    }

    if (!protocol) {
      throw new ProvisioningError(
        `Protocol is required for SNS subscription ${logicalId}`,
        resourceType,
        logicalId
      );
    }

    if (!endpoint) {
      throw new ProvisioningError(
        `Endpoint is required for SNS subscription ${logicalId}`,
        resourceType,
        logicalId
      );
    }

    try {
      const attributes: Record<string, string> = {};

      // Set FilterPolicy if provided
      const filterPolicy = properties['FilterPolicy'];
      if (filterPolicy) {
        attributes['FilterPolicy'] =
          typeof filterPolicy === 'string' ? filterPolicy : JSON.stringify(filterPolicy);
      }

      const response = await this.snsClient.send(
        new SubscribeCommand({
          TopicArn: topicArn,
          Protocol: protocol,
          Endpoint: endpoint,
          ReturnSubscriptionArn: true,
          ...(Object.keys(attributes).length > 0 && { Attributes: attributes }),
        })
      );

      const subscriptionArn = response.SubscriptionArn || `${topicArn}:${logicalId}`;

      this.logger.debug(`Successfully created SNS subscription ${logicalId}: ${subscriptionArn}`);

      return {
        physicalId: subscriptionArn,
        attributes: {},
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to create SNS subscription ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        undefined,
        cause
      );
    }
  }

  /**
   * Update an SNS subscription
   *
   * SNS subscriptions are immutable for TopicArn/Protocol/Endpoint changes.
   * For simplicity, we replace the subscription on any update.
   */
  async update(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    _previousProperties: Record<string, unknown>
  ): Promise<ResourceUpdateResult> {
    this.logger.debug(`Updating SNS subscription ${logicalId}: ${physicalId}`);

    // Delete old subscription
    try {
      await this.delete(logicalId, physicalId, resourceType);
    } catch (error) {
      this.logger.warn(
        `Failed to delete old subscription ${physicalId} during update: ${String(error)}`
      );
    }

    // Create new subscription
    const createResult = await this.create(logicalId, resourceType, properties);

    return {
      physicalId: createResult.physicalId,
      wasReplaced: true,
      attributes: createResult.attributes ?? {},
    };
  }

  /**
   * Delete an SNS subscription
   */
  async delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    _properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void> {
    this.logger.debug(`Deleting SNS subscription ${logicalId}: ${physicalId}`);

    try {
      await this.snsClient.send(
        new UnsubscribeCommand({
          SubscriptionArn: physicalId,
        })
      );

      this.logger.debug(`Successfully deleted SNS subscription ${logicalId}`);
    } catch (error) {
      if (error instanceof NotFoundException) {
        const clientRegion = await this.snsClient.config.region();
        assertRegionMatch(
          clientRegion,
          context?.expectedRegion,
          resourceType,
          logicalId,
          physicalId
        );
        this.logger.debug(`Subscription ${physicalId} does not exist, skipping deletion`);
        return;
      }

      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to delete SNS subscription ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  /**
   * Adopt an existing SNS subscription into cdkd state.
   *
   * **Explicit override only.** SNS subscriptions are attached to a parent
   * topic and identified by their `SubscriptionArn`, but the SubscribeAPI
   * does not accept tags and the AWS tag APIs do not cover subscriptions
   * (only Topics are taggable). There is therefore no `aws:cdk:path` tag
   * we could use for auto-lookup.
   *
   * Users adopting an existing subscription should pass
   * `--resource <logicalId>=<subscriptionArn>`.
   */
  // eslint-disable-next-line @typescript-eslint/require-await -- explicit-override-only intentionally has no AWS calls
  async import(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    if (input.knownPhysicalId) {
      return { physicalId: input.knownPhysicalId, attributes: {} };
    }
    return null;
  }
}
