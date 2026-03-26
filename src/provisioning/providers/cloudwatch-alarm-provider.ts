import {
  CloudWatchClient,
  PutMetricAlarmCommand,
  DeleteAlarmsCommand,
  type Statistic,
  type ComparisonOperator,
  type StandardUnit,
} from '@aws-sdk/client-cloudwatch';
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
 * AWS CloudWatch Alarm Provider
 *
 * Implements resource provisioning for AWS::CloudWatch::Alarm using the CloudWatch SDK.
 * This is required because CloudWatch Alarm is not supported by Cloud Control API.
 */
export class CloudWatchAlarmProvider implements ResourceProvider {
  private cloudWatchClient: CloudWatchClient;
  private logger = getLogger().child('CloudWatchAlarmProvider');

  constructor() {
    const awsClients = getAwsClients();
    this.cloudWatchClient = awsClients.cloudWatch;
  }

  /**
   * Create a CloudWatch alarm
   */
  async create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
  ): Promise<ResourceCreateResult> {
    this.logger.debug(`Creating CloudWatch alarm ${logicalId}`);

    const alarmName =
      (properties['AlarmName'] as string | undefined) ||
      generateResourceName(logicalId, { maxLength: 256 });

    try {
      await this.cloudWatchClient.send(
        new PutMetricAlarmCommand(this.buildAlarmParams(alarmName, properties))
      );

      this.logger.debug(`Successfully created CloudWatch alarm ${logicalId}: ${alarmName}`);

      return {
        physicalId: alarmName,
        attributes: {
          Arn: `arn:aws:cloudwatch:*:*:alarm:${alarmName}`,
        },
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to create CloudWatch alarm ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        undefined,
        cause
      );
    }
  }

  /**
   * Update a CloudWatch alarm
   *
   * PutMetricAlarm is idempotent - calling it with the same alarm name updates the alarm.
   */
  async update(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    _previousProperties: Record<string, unknown>
  ): Promise<ResourceUpdateResult> {
    this.logger.debug(`Updating CloudWatch alarm ${logicalId}: ${physicalId}`);

    try {
      await this.cloudWatchClient.send(
        new PutMetricAlarmCommand(this.buildAlarmParams(physicalId, properties))
      );

      this.logger.debug(`Successfully updated CloudWatch alarm ${logicalId}`);

      return {
        physicalId,
        wasReplaced: false,
        attributes: {
          Arn: `arn:aws:cloudwatch:*:*:alarm:${physicalId}`,
        },
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to update CloudWatch alarm ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  /**
   * Delete a CloudWatch alarm
   */
  async delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    _properties?: Record<string, unknown>
  ): Promise<void> {
    this.logger.debug(`Deleting CloudWatch alarm ${logicalId}: ${physicalId}`);

    try {
      await this.cloudWatchClient.send(
        new DeleteAlarmsCommand({
          AlarmNames: [physicalId],
        })
      );

      this.logger.debug(`Successfully deleted CloudWatch alarm ${logicalId}`);
    } catch (error) {
      if (error instanceof Error && error.name === 'ResourceNotFound') {
        this.logger.debug(`Alarm ${physicalId} does not exist, skipping deletion`);
        return;
      }

      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to delete CloudWatch alarm ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  /**
   * Build PutMetricAlarm parameters from CDK properties
   */
  private buildAlarmParams(alarmName: string, properties: Record<string, unknown>) {
    return {
      AlarmName: alarmName,
      ComparisonOperator: properties['ComparisonOperator'] as ComparisonOperator | undefined,
      EvaluationPeriods: properties['EvaluationPeriods'] as number,
      MetricName: properties['MetricName'] as string | undefined,
      Namespace: properties['Namespace'] as string | undefined,
      Period: properties['Period'] as number | undefined,
      Statistic: properties['Statistic'] as Statistic | undefined,
      Threshold: properties['Threshold'] as number | undefined,
      ActionsEnabled: properties['ActionsEnabled'] as boolean | undefined,
      AlarmActions: properties['AlarmActions'] as string[] | undefined,
      AlarmDescription: properties['AlarmDescription'] as string | undefined,
      DatapointsToAlarm: properties['DatapointsToAlarm'] as number | undefined,
      Dimensions: properties['Dimensions'] as Array<{ Name: string; Value: string }> | undefined,
      InsufficientDataActions: properties['InsufficientDataActions'] as string[] | undefined,
      OKActions: properties['OKActions'] as string[] | undefined,
      TreatMissingData: properties['TreatMissingData'] as string | undefined,
      Unit: properties['Unit'] as StandardUnit | undefined,
    };
  }
}
