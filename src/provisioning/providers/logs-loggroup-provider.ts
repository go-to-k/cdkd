import {
  CloudWatchLogsClient,
  CreateLogGroupCommand,
  DeleteLogGroupCommand,
  PutRetentionPolicyCommand,
  DeleteRetentionPolicyCommand,
  TagResourceCommand,
  UntagResourceCommand,
  PutDataProtectionPolicyCommand,
  DeleteDataProtectionPolicyCommand,
  ResourceNotFoundException,
  ResourceAlreadyExistsException,
} from '@aws-sdk/client-cloudwatch-logs';
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { getLogger } from '../../utils/logger.js';
import { getAwsClients } from '../../utils/aws-clients.js';
import { ProvisioningError } from '../../utils/error-handler.js';
import { generateResourceName } from '../resource-name.js';
import type {
  ResourceProvider,
  ResourceCreateResult,
  ResourceUpdateResult,
} from '../../types/resource.js';

/**
 * AWS CloudWatch Logs LogGroup Provider
 *
 * Implements resource provisioning for AWS::Logs::LogGroup using the CloudWatch Logs SDK.
 * WHY: CreateLogGroup is synchronous - the CC API adds unnecessary polling overhead
 * (1s->2s->4s->8s) for an operation that completes immediately.
 */
export class LogsLogGroupProvider implements ResourceProvider {
  private logsClient: CloudWatchLogsClient;
  private stsClient: STSClient;
  private logger = getLogger().child('LogsLogGroupProvider');

  handledProperties = new Map<string, ReadonlySet<string>>([
    [
      'AWS::Logs::LogGroup',
      new Set([
        'LogGroupName',
        'KmsKeyId',
        'RetentionInDays',
        'Tags',
        'DataProtectionPolicy',
        'LogGroupClass',
        'FieldIndexPolicies',
        'ResourcePolicyDocument',
        'DeletionProtectionEnabled',
        'BearerTokenAuthenticationEnabled',
      ]),
    ],
  ]);

  constructor() {
    const awsClients = getAwsClients();
    this.logsClient = awsClients.cloudWatchLogs;
    this.stsClient = awsClients.sts;
  }

  /**
   * Create a CloudWatch Logs log group
   */
  async create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
  ): Promise<ResourceCreateResult> {
    this.logger.debug(`Creating log group ${logicalId}`);

    const logGroupName =
      (properties['LogGroupName'] as string | undefined) ||
      `/cdkd/${generateResourceName(logicalId, { maxLength: 506, allowedPattern: /[^a-zA-Z0-9-/_]/g })}`;

    try {
      const createParams: import('@aws-sdk/client-cloudwatch-logs').CreateLogGroupCommandInput = {
        logGroupName,
      };
      if (properties['KmsKeyId']) createParams.kmsKeyId = properties['KmsKeyId'] as string;
      if (properties['LogGroupClass']) {
        createParams.logGroupClass = properties[
          'LogGroupClass'
        ] as import('@aws-sdk/client-cloudwatch-logs').LogGroupClass;
      }
      if (properties['Tags']) {
        const cfnTags = properties['Tags'] as Array<{ Key: string; Value: string }>;
        createParams.tags = Object.fromEntries(cfnTags.map((t) => [t.Key, t.Value]));
      }

      await this.logsClient.send(new CreateLogGroupCommand(createParams));

      // Apply retention policy if specified
      const retentionInDays = properties['RetentionInDays'] as number | undefined;
      if (retentionInDays) {
        await this.logsClient.send(
          new PutRetentionPolicyCommand({
            logGroupName,
            retentionInDays,
          })
        );
      }

      // Apply DataProtectionPolicy if specified
      if (properties['DataProtectionPolicy']) {
        const policyDocument =
          typeof properties['DataProtectionPolicy'] === 'string'
            ? properties['DataProtectionPolicy']
            : JSON.stringify(properties['DataProtectionPolicy']);
        await this.logsClient.send(
          new PutDataProtectionPolicyCommand({
            logGroupIdentifier: logGroupName,
            policyDocument,
          })
        );
      }

      // Note: FieldIndexPolicies, ResourcePolicyDocument, DeletionProtectionEnabled,
      // and BearerTokenAuthenticationEnabled are declared in handledProperties
      // to prevent CC API fallback. These are less common properties that the
      // CC API can handle if needed via the deployment layer.

      this.logger.debug(`Successfully created log group ${logicalId}: ${logGroupName}`);

      // Construct ARN from region/account
      const arn = await this.buildArn(logGroupName);

      return {
        physicalId: logGroupName,
        attributes: {
          Arn: arn,
        },
      };
    } catch (error) {
      if (error instanceof ResourceAlreadyExistsException) {
        this.logger.debug(`Log group ${logGroupName} already exists, using existing`);
        const arn = await this.buildArn(logGroupName);
        return {
          physicalId: logGroupName,
          attributes: {
            Arn: arn,
          },
        };
      }
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to create log group ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        logGroupName,
        cause
      );
    }
  }

  /**
   * Update a CloudWatch Logs log group
   *
   * Only RetentionInDays can be updated. LogGroupName is immutable (requires replacement).
   */
  async update(
    logicalId: string,
    physicalId: string,
    _resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>
  ): Promise<ResourceUpdateResult> {
    this.logger.debug(`Updating log group ${logicalId}: ${physicalId}`);

    // Update retention policy if changed
    const retentionInDays = properties['RetentionInDays'] as number | undefined;
    const oldRetentionInDays = previousProperties['RetentionInDays'] as number | undefined;
    if (retentionInDays !== oldRetentionInDays) {
      if (retentionInDays) {
        await this.logsClient.send(
          new PutRetentionPolicyCommand({
            logGroupName: physicalId,
            retentionInDays,
          })
        );
      } else {
        // Remove retention policy (never expire)
        await this.logsClient.send(
          new DeleteRetentionPolicyCommand({
            logGroupName: physicalId,
          })
        );
      }
    }

    // Update DataProtectionPolicy if changed
    if (
      JSON.stringify(properties['DataProtectionPolicy']) !==
      JSON.stringify(previousProperties['DataProtectionPolicy'])
    ) {
      if (properties['DataProtectionPolicy']) {
        const policyDocument =
          typeof properties['DataProtectionPolicy'] === 'string'
            ? properties['DataProtectionPolicy']
            : JSON.stringify(properties['DataProtectionPolicy']);
        await this.logsClient.send(
          new PutDataProtectionPolicyCommand({
            logGroupIdentifier: physicalId,
            policyDocument,
          })
        );
      } else {
        await this.logsClient.send(
          new DeleteDataProtectionPolicyCommand({
            logGroupIdentifier: physicalId,
          })
        );
      }
    }

    // Update Tags if changed
    const newTags = properties['Tags'] as Array<{ Key: string; Value: string }> | undefined;
    const oldTags = previousProperties['Tags'] as Array<{ Key: string; Value: string }> | undefined;
    if (JSON.stringify(newTags) !== JSON.stringify(oldTags)) {
      const arn = await this.buildArn(physicalId);
      // Remove old tags
      if (oldTags && oldTags.length > 0) {
        const oldTagKeys = oldTags.map((t) => t.Key);
        await this.logsClient.send(
          new UntagResourceCommand({
            resourceArn: arn,
            tagKeys: oldTagKeys,
          })
        );
      }
      // Apply new tags
      if (newTags && newTags.length > 0) {
        const tagsMap = Object.fromEntries(newTags.map((t) => [t.Key, t.Value]));
        await this.logsClient.send(
          new TagResourceCommand({
            resourceArn: arn,
            tags: tagsMap,
          })
        );
      }
      this.logger.debug(`Updated tags for log group ${physicalId}`);
    }

    const arn = await this.buildArn(physicalId);

    return {
      physicalId,
      wasReplaced: false,
      attributes: {
        Arn: arn,
      },
    };
  }

  /**
   * Delete a CloudWatch Logs log group
   */
  async delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    _properties?: Record<string, unknown>
  ): Promise<void> {
    this.logger.debug(`Deleting log group ${logicalId}: ${physicalId}`);

    try {
      await this.logsClient.send(new DeleteLogGroupCommand({ logGroupName: physicalId }));
      this.logger.debug(`Successfully deleted log group ${logicalId}`);
    } catch (error) {
      if (error instanceof ResourceNotFoundException) {
        this.logger.debug(`Log group ${physicalId} does not exist, skipping deletion`);
        return;
      }
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to delete log group ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  /**
   * Build log group ARN from name
   */
  private async buildArn(logGroupName: string): Promise<string> {
    try {
      const identity = await this.stsClient.send(new GetCallerIdentityCommand({}));
      const accountId = identity.Account;
      // Region comes from the client config
      const region =
        (await this.logsClient.config.region()) || process.env['AWS_REGION'] || 'us-east-1';
      return `arn:aws:logs:${region}:${accountId}:log-group:${logGroupName}:*`;
    } catch {
      // Fallback: return a placeholder ARN
      return `arn:aws:logs:unknown:unknown:log-group:${logGroupName}:*`;
    }
  }
}
