import {
  SNSClient,
  CreateTopicCommand,
  DeleteTopicCommand,
  GetTopicAttributesCommand,
  ListTopicsCommand,
  ListTagsForResourceCommand,
  SetTopicAttributesCommand,
  TagResourceCommand,
  UntagResourceCommand,
  NotFoundException,
  type CreateTopicCommandInput,
  type Tag,
} from '@aws-sdk/client-sns';
import { getLogger } from '../../utils/logger.js';
import { getAwsClients } from '../../utils/aws-clients.js';
import { ProvisioningError } from '../../utils/error-handler.js';
import { assertRegionMatch, type DeleteContext } from '../region-check.js';
import { generateResourceName } from '../resource-name.js';
import { matchesCdkPath, resolveExplicitPhysicalId } from '../import-helpers.js';
import type {
  ResourceProvider,
  ResourceCreateResult,
  ResourceUpdateResult,
  ResourceImportInput,
  ResourceImportResult,
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
  handledProperties = new Map<string, ReadonlySet<string>>([
    [
      'AWS::SNS::Topic',
      new Set([
        'TopicName',
        'FifoTopic',
        'ContentBasedDeduplication',
        'DisplayName',
        'KmsMasterKeyId',
        'Tags',
        'TracingConfig',
        'SignatureVersion',
        'ArchivePolicy',
        'DataProtectionPolicy',
        'DeliveryStatusLogging',
        'Subscription',
        'FifoThroughputScope',
      ]),
    ],
  ]);

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

    const topicName =
      (properties['TopicName'] as string | undefined) ||
      generateResourceName(logicalId, { maxLength: 256 });

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
      if (properties['TracingConfig']) {
        topicAttributes['TracingConfig'] = properties['TracingConfig'] as string;
      }
      if (properties['SignatureVersion']) {
        topicAttributes['SignatureVersion'] = String(properties['SignatureVersion']);
      }
      if (properties['FifoThroughputScope']) {
        topicAttributes['FifoThroughputScope'] = properties['FifoThroughputScope'] as string;
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

      // Apply ArchivePolicy (FIFO topics only, must be set after creation)
      if (properties['ArchivePolicy']) {
        const archivePolicy =
          typeof properties['ArchivePolicy'] === 'string'
            ? properties['ArchivePolicy']
            : JSON.stringify(properties['ArchivePolicy']);
        await this.snsClient.send(
          new SetTopicAttributesCommand({
            TopicArn: topicArn,
            AttributeName: 'ArchivePolicy',
            AttributeValue: archivePolicy,
          })
        );
      }

      // Apply DataProtectionPolicy
      if (properties['DataProtectionPolicy']) {
        const dataProtectionPolicy =
          typeof properties['DataProtectionPolicy'] === 'string'
            ? properties['DataProtectionPolicy']
            : JSON.stringify(properties['DataProtectionPolicy']);
        await this.snsClient.send(
          new SetTopicAttributesCommand({
            TopicArn: topicArn,
            AttributeName: 'DataProtectionPolicy',
            AttributeValue: dataProtectionPolicy,
          })
        );
      }

      // Apply DeliveryStatusLogging
      if (properties['DeliveryStatusLogging']) {
        const loggingConfigs = properties['DeliveryStatusLogging'] as Array<
          Record<string, unknown>
        >;
        for (const config of loggingConfigs) {
          const protocol = config['Protocol'] as string;
          if (config['SuccessFeedbackRoleArn']) {
            await this.snsClient.send(
              new SetTopicAttributesCommand({
                TopicArn: topicArn,
                AttributeName: `${protocol}SuccessFeedbackRoleArn`,
                AttributeValue: config['SuccessFeedbackRoleArn'] as string,
              })
            );
          }
          if (config['SuccessFeedbackSampleRate']) {
            await this.snsClient.send(
              new SetTopicAttributesCommand({
                TopicArn: topicArn,
                AttributeName: `${protocol}SuccessFeedbackSampleRate`,
                AttributeValue: String(config['SuccessFeedbackSampleRate']),
              })
            );
          }
          if (config['FailureFeedbackRoleArn']) {
            await this.snsClient.send(
              new SetTopicAttributesCommand({
                TopicArn: topicArn,
                AttributeName: `${protocol}FailureFeedbackRoleArn`,
                AttributeValue: config['FailureFeedbackRoleArn'] as string,
              })
            );
          }
        }
      }

      // Note: Subscription property is handled by CloudFormation as separate resources
      // in CDK, so we don't need to create subscriptions here. The Subscription property
      // is declared in handledProperties to prevent CC API fallback.

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
  async update(
    logicalId: string,
    physicalId: string,
    _resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>
  ): Promise<ResourceUpdateResult> {
    this.logger.debug(`Updating SNS topic ${logicalId}: ${physicalId}`);

    // Update mutable topic attributes via SetTopicAttributes
    const mutableAttributes: Array<{ name: string; prop: string; serialize?: boolean }> = [
      { name: 'DisplayName', prop: 'DisplayName' },
      { name: 'KmsMasterKeyId', prop: 'KmsMasterKeyId' },
      { name: 'ContentBasedDeduplication', prop: 'ContentBasedDeduplication' },
      { name: 'TracingConfig', prop: 'TracingConfig' },
      { name: 'SignatureVersion', prop: 'SignatureVersion' },
      { name: 'FifoThroughputScope', prop: 'FifoThroughputScope' },
      { name: 'ArchivePolicy', prop: 'ArchivePolicy', serialize: true },
      { name: 'DataProtectionPolicy', prop: 'DataProtectionPolicy', serialize: true },
    ];

    for (const attr of mutableAttributes) {
      const newVal = properties[attr.prop];
      const oldVal = previousProperties[attr.prop];
      if (JSON.stringify(newVal) !== JSON.stringify(oldVal)) {
        let value: string;
        if (newVal === undefined || newVal === null) {
          value = '';
        } else if (attr.serialize && typeof newVal !== 'string') {
          value = JSON.stringify(newVal);
        } else {
          value = String(newVal);
        }
        await this.snsClient.send(
          new SetTopicAttributesCommand({
            TopicArn: physicalId,
            AttributeName: attr.name,
            AttributeValue: value,
          })
        );
        this.logger.debug(`Updated ${attr.name} for topic ${physicalId}`);
      }
    }

    // Update DeliveryStatusLogging if changed
    if (
      JSON.stringify(properties['DeliveryStatusLogging']) !==
      JSON.stringify(previousProperties['DeliveryStatusLogging'])
    ) {
      const loggingConfigs =
        (properties['DeliveryStatusLogging'] as Array<Record<string, unknown>>) || [];
      for (const config of loggingConfigs) {
        const protocol = config['Protocol'] as string;
        if (config['SuccessFeedbackRoleArn']) {
          await this.snsClient.send(
            new SetTopicAttributesCommand({
              TopicArn: physicalId,
              AttributeName: `${protocol}SuccessFeedbackRoleArn`,
              AttributeValue: config['SuccessFeedbackRoleArn'] as string,
            })
          );
        }
        if (config['SuccessFeedbackSampleRate']) {
          await this.snsClient.send(
            new SetTopicAttributesCommand({
              TopicArn: physicalId,
              AttributeName: `${protocol}SuccessFeedbackSampleRate`,
              AttributeValue: String(config['SuccessFeedbackSampleRate']),
            })
          );
        }
        if (config['FailureFeedbackRoleArn']) {
          await this.snsClient.send(
            new SetTopicAttributesCommand({
              TopicArn: physicalId,
              AttributeName: `${protocol}FailureFeedbackRoleArn`,
              AttributeValue: config['FailureFeedbackRoleArn'] as string,
            })
          );
        }
      }
    }

    // Update Tags if changed
    const newTags = properties['Tags'] as Tag[] | undefined;
    const oldTags = previousProperties['Tags'] as Tag[] | undefined;
    if (JSON.stringify(newTags) !== JSON.stringify(oldTags)) {
      // Remove old tags
      if (oldTags && oldTags.length > 0) {
        const oldTagKeys = oldTags.map((t) => t.Key).filter((k): k is string => !!k);
        if (oldTagKeys.length > 0) {
          await this.snsClient.send(
            new UntagResourceCommand({
              ResourceArn: physicalId,
              TagKeys: oldTagKeys,
            })
          );
        }
      }
      // Apply new tags
      if (newTags && newTags.length > 0) {
        await this.snsClient.send(
          new TagResourceCommand({
            ResourceArn: physicalId,
            Tags: newTags,
          })
        );
      }
      this.logger.debug(`Updated tags for topic ${physicalId}`);
    }

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
    _properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void> {
    this.logger.debug(`Deleting SNS topic ${logicalId}: ${physicalId}`);

    try {
      await this.snsClient.send(new DeleteTopicCommand({ TopicArn: physicalId }));
      this.logger.debug(`Successfully deleted SNS topic ${logicalId}`);
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

  /**
   * Resolve a single `Fn::GetAtt` attribute for an existing SNS topic.
   *
   * CloudFormation's `AWS::SNS::Topic` exposes `TopicName` and `TopicArn`.
   * The cdkd physicalId is the topic ARN, so both are derivable without
   * an AWS call. See:
   * https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-properties-sns-topic.html#aws-properties-sns-topic-return-values
   *
   * Used by `cdkd orphan` to live-fetch attribute values that need to be
   * substituted into sibling references.
   */
  // eslint-disable-next-line @typescript-eslint/require-await -- consistent async signature with other providers
  async getAttribute(
    physicalId: string,
    _resourceType: string,
    attributeName: string
  ): Promise<unknown> {
    switch (attributeName) {
      case 'TopicArn':
        return physicalId;
      case 'TopicName':
        return physicalId.split(':').pop();
      default:
        return undefined;
    }
  }

  /**
   * Adopt an existing SNS topic into cdkd state.
   *
   * SNS physical IDs are full ARNs (`arn:aws:sns:...:TopicName`). The
   * `--resource` override is expected to receive an ARN; bare topic names
   * trigger a `ListTopics` walk that resolves to the ARN.
   *
   * Lookup order:
   *  1. `--resource` override → trust as ARN, verify via `GetTopicAttributes`.
   *  2. `Properties.TopicName` → `ListTopics` to find matching ARN.
   *  3. `aws:cdk:path` tag match via `ListTopics` + `ListTagsForResource`.
   */
  async import(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    if (input.knownPhysicalId) {
      try {
        await this.snsClient.send(
          new GetTopicAttributesCommand({ TopicArn: input.knownPhysicalId })
        );
        return { physicalId: input.knownPhysicalId, attributes: {} };
      } catch (err) {
        if (err instanceof NotFoundException) return null;
        throw err;
      }
    }

    const desiredName =
      typeof input.properties?.['TopicName'] === 'string'
        ? input.properties['TopicName']
        : undefined;

    let nextToken: string | undefined;
    do {
      const list = await this.snsClient.send(
        new ListTopicsCommand({ ...(nextToken && { NextToken: nextToken }) })
      );
      for (const t of list.Topics ?? []) {
        if (!t.TopicArn) continue;
        // ARN tail is the topic name: arn:aws:sns:...:NAME
        const arnTail = t.TopicArn.substring(t.TopicArn.lastIndexOf(':') + 1);
        if (desiredName && arnTail === desiredName) {
          return { physicalId: t.TopicArn, attributes: {} };
        }
        if (input.cdkPath) {
          try {
            const tagsResp = await this.snsClient.send(
              new ListTagsForResourceCommand({ ResourceArn: t.TopicArn })
            );
            if (matchesCdkPath(tagsResp.Tags, input.cdkPath)) {
              return { physicalId: t.TopicArn, attributes: {} };
            }
          } catch (err) {
            if (err instanceof NotFoundException) continue;
            throw err;
          }
        }
      }
      nextToken = list.NextToken;
    } while (nextToken);

    // resolveExplicitPhysicalId would have returned an explicit value above
    // — this branch is reachable only when nothing matched.
    void resolveExplicitPhysicalId;
    return null;
  }
}
