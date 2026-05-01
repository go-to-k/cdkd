import {
  CloudWatchClient,
  PutMetricAlarmCommand,
  DeleteAlarmsCommand,
  DescribeAlarmsCommand,
  type Statistic,
  type ComparisonOperator,
  type StandardUnit,
  type PutMetricAlarmCommandInput,
} from '@aws-sdk/client-cloudwatch';
import { getLogger } from '../../utils/logger.js';
import { getAwsClients } from '../../utils/aws-clients.js';
import { ProvisioningError } from '../../utils/error-handler.js';
import { generateResourceName } from '../resource-name.js';
import { assertRegionMatch, type DeleteContext } from '../region-check.js';
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

  handledProperties = new Map<string, ReadonlySet<string>>([
    [
      'AWS::CloudWatch::Alarm',
      new Set([
        'AlarmName',
        'ComparisonOperator',
        'EvaluationPeriods',
        'Threshold',
        'ActionsEnabled',
        'AlarmActions',
        'AlarmDescription',
        'DatapointsToAlarm',
        'InsufficientDataActions',
        'OKActions',
        'TreatMissingData',
        'Unit',
        'Metrics',
        'MetricName',
        'Namespace',
        'Period',
        'Statistic',
        'Dimensions',
      ]),
    ],
  ]);

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

      // Fetch the actual ARN from AWS (includes correct region and account)
      const alarmArn = await this.getAlarmArn(alarmName);

      return {
        physicalId: alarmName,
        attributes: {
          Arn: alarmArn,
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

      // Fetch the actual ARN from AWS (includes correct region and account)
      const alarmArn = await this.getAlarmArn(physicalId);

      return {
        physicalId,
        wasReplaced: false,
        attributes: {
          Arn: alarmArn,
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
    _properties?: Record<string, unknown>,
    context?: DeleteContext
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
        const clientRegion = await this.cloudWatchClient.config.region();
        assertRegionMatch(
          clientRegion,
          context?.expectedRegion,
          resourceType,
          logicalId,
          physicalId
        );
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
   * Get the actual alarm ARN from AWS via DescribeAlarms.
   * Falls back to constructing an ARN from client config if the describe call fails.
   */
  private async getAlarmArn(alarmName: string): Promise<string> {
    try {
      const response = await this.cloudWatchClient.send(
        new DescribeAlarmsCommand({
          AlarmNames: [alarmName],
        })
      );
      const arn = response.MetricAlarms?.[0]?.AlarmArn;
      if (arn) {
        return arn;
      }
      // Also check CompositeAlarms
      const compositeArn = response.CompositeAlarms?.[0]?.AlarmArn;
      if (compositeArn) {
        return compositeArn;
      }
    } catch (error) {
      this.logger.debug(
        `Failed to describe alarm ${alarmName}, constructing ARN from config: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    // Fallback: construct ARN from client config
    try {
      const region =
        (await this.cloudWatchClient.config.region()) || process.env['AWS_REGION'] || 'us-east-1';
      return `arn:aws:cloudwatch:${region}:*:alarm:${alarmName}`;
    } catch {
      return `arn:aws:cloudwatch:*:*:alarm:${alarmName}`;
    }
  }

  /**
   * Build PutMetricAlarm parameters from CDK properties
   */
  private buildAlarmParams(
    alarmName: string,
    properties: Record<string, unknown>
  ): PutMetricAlarmCommandInput {
    const params: Record<string, unknown> = {
      AlarmName: alarmName,
      ComparisonOperator: properties['ComparisonOperator'] as ComparisonOperator | undefined,
      EvaluationPeriods: properties['EvaluationPeriods'] as number,
      Threshold: properties['Threshold'] as number | undefined,
      ActionsEnabled: properties['ActionsEnabled'] as boolean | undefined,
      AlarmActions: properties['AlarmActions'] as string[] | undefined,
      AlarmDescription: properties['AlarmDescription'] as string | undefined,
      DatapointsToAlarm: properties['DatapointsToAlarm'] as number | undefined,
      InsufficientDataActions: properties['InsufficientDataActions'] as string[] | undefined,
      OKActions: properties['OKActions'] as string[] | undefined,
      TreatMissingData: properties['TreatMissingData'] as string | undefined,
      Unit: properties['Unit'] as StandardUnit | undefined,
    };

    // Metrics array (math expressions / composite metrics)
    if (properties['Metrics']) {
      const metrics = properties['Metrics'] as Array<Record<string, unknown>>;
      params['Metrics'] = metrics.map((m) => {
        const entry: Record<string, unknown> = {
          Id: m['Id'] as string,
        };
        if (m['Expression'] !== undefined) entry['Expression'] = m['Expression'];
        if (m['Label'] !== undefined) entry['Label'] = m['Label'];
        if (m['ReturnData'] !== undefined) entry['ReturnData'] = m['ReturnData'];
        if (m['Period'] !== undefined) entry['Period'] = m['Period'];
        if (m['MetricStat'] !== undefined) {
          const stat = m['MetricStat'] as Record<string, unknown>;
          const metric = stat['Metric'] as Record<string, unknown>;
          entry['MetricStat'] = {
            Metric: {
              MetricName: metric['MetricName'],
              Namespace: metric['Namespace'],
              Dimensions: metric['Dimensions'],
            },
            Period: stat['Period'],
            Stat: stat['Stat'],
            Unit: stat['Unit'],
          };
        }
        return entry;
      });
    } else {
      // Simple metric alarm (MetricName / Namespace / Dimensions)
      params['MetricName'] = properties['MetricName'] as string | undefined;
      params['Namespace'] = properties['Namespace'] as string | undefined;
      params['Period'] = properties['Period'] as number | undefined;
      params['Statistic'] = properties['Statistic'] as Statistic | undefined;
      params['Dimensions'] = properties['Dimensions'] as
        | Array<{ Name: string; Value: string }>
        | undefined;
    }

    return params as unknown as PutMetricAlarmCommandInput;
  }
}
