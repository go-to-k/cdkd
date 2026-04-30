import {
  LambdaClient,
  CreateEventSourceMappingCommand,
  DeleteEventSourceMappingCommand,
  UpdateEventSourceMappingCommand,
  GetEventSourceMappingCommand,
  ResourceNotFoundException,
  type EventSourcePosition,
} from '@aws-sdk/client-lambda';
import { getLogger } from '../../utils/logger.js';
import { getAwsClients } from '../../utils/aws-clients.js';
import { ProvisioningError } from '../../utils/error-handler.js';
import { assertRegionMatch, type DeleteContext } from '../region-check.js';
import type {
  ResourceProvider,
  ResourceCreateResult,
  ResourceUpdateResult,
} from '../../types/resource.js';

/**
 * AWS Lambda Event Source Mapping Provider
 *
 * Implements resource provisioning for AWS::Lambda::EventSourceMapping using the Lambda SDK.
 * WHY: CreateEventSourceMapping is synchronous - the CC API adds unnecessary polling overhead
 * (1s->2s->4s->8s) for an operation that completes immediately.
 */
export class LambdaEventSourceMappingProvider implements ResourceProvider {
  private lambdaClient: LambdaClient;
  private logger = getLogger().child('LambdaEventSourceMappingProvider');
  handledProperties = new Map<string, ReadonlySet<string>>([
    [
      'AWS::Lambda::EventSourceMapping',
      new Set([
        'FunctionName',
        'EventSourceArn',
        'BatchSize',
        'StartingPosition',
        'Enabled',
        'MaximumBatchingWindowInSeconds',
        'MaximumRetryAttempts',
        'BisectBatchOnFunctionError',
        'MaximumRecordAgeInSeconds',
        'ParallelizationFactor',
        'FilterCriteria',
        'DestinationConfig',
        'TumblingWindowInSeconds',
        'FunctionResponseTypes',
        'SourceAccessConfigurations',
        'SelfManagedEventSource',
        'SelfManagedKafkaEventSourceConfig',
        'AmazonManagedKafkaEventSourceConfig',
        'DocumentDBEventSourceConfig',
        'ScalingConfig',
        'Tags',
      ]),
    ],
  ]);

  constructor() {
    const awsClients = getAwsClients();
    this.lambdaClient = awsClients.lambda;
  }

  /**
   * Create a Lambda Event Source Mapping
   */
  async create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
  ): Promise<ResourceCreateResult> {
    this.logger.debug(`Creating event source mapping ${logicalId}`);

    const functionName = properties['FunctionName'] as string;
    if (!functionName) {
      throw new ProvisioningError(
        `FunctionName is required for event source mapping ${logicalId}`,
        resourceType,
        logicalId
      );
    }

    try {
      const params: import('@aws-sdk/client-lambda').CreateEventSourceMappingCommandInput = {
        FunctionName: functionName,
      };
      if (properties['EventSourceArn'])
        params.EventSourceArn = properties['EventSourceArn'] as string;
      if (properties['BatchSize']) params.BatchSize = properties['BatchSize'] as number;
      if (properties['StartingPosition'])
        params.StartingPosition = properties['StartingPosition'] as EventSourcePosition;
      if (properties['Enabled'] !== undefined) params.Enabled = properties['Enabled'] as boolean;
      if (properties['MaximumBatchingWindowInSeconds'])
        params.MaximumBatchingWindowInSeconds = properties[
          'MaximumBatchingWindowInSeconds'
        ] as number;
      if (properties['MaximumRetryAttempts'] !== undefined)
        params.MaximumRetryAttempts = properties['MaximumRetryAttempts'] as number;
      if (properties['BisectBatchOnFunctionError'] !== undefined)
        params.BisectBatchOnFunctionError = properties['BisectBatchOnFunctionError'] as boolean;
      if (properties['MaximumRecordAgeInSeconds'])
        params.MaximumRecordAgeInSeconds = properties['MaximumRecordAgeInSeconds'] as number;
      if (properties['ParallelizationFactor'])
        params.ParallelizationFactor = properties['ParallelizationFactor'] as number;
      if (properties['FilterCriteria'])
        params.FilterCriteria = properties['FilterCriteria'] as {
          Filters?: Array<{ Pattern?: string }>;
        };
      if (properties['DestinationConfig'])
        params.DestinationConfig = properties[
          'DestinationConfig'
        ] as import('@aws-sdk/client-lambda').DestinationConfig;
      if (properties['TumblingWindowInSeconds'])
        params.TumblingWindowInSeconds = properties['TumblingWindowInSeconds'] as number;
      if (properties['FunctionResponseTypes'])
        params.FunctionResponseTypes = properties[
          'FunctionResponseTypes'
        ] as import('@aws-sdk/client-lambda').FunctionResponseType[];
      if (properties['SourceAccessConfigurations'])
        params.SourceAccessConfigurations = properties[
          'SourceAccessConfigurations'
        ] as import('@aws-sdk/client-lambda').SourceAccessConfiguration[];
      if (properties['SelfManagedEventSource'])
        params.SelfManagedEventSource = properties[
          'SelfManagedEventSource'
        ] as import('@aws-sdk/client-lambda').SelfManagedEventSource;
      if (properties['SelfManagedKafkaEventSourceConfig'])
        params.SelfManagedKafkaEventSourceConfig = properties[
          'SelfManagedKafkaEventSourceConfig'
        ] as import('@aws-sdk/client-lambda').SelfManagedKafkaEventSourceConfig;
      if (properties['AmazonManagedKafkaEventSourceConfig'])
        params.AmazonManagedKafkaEventSourceConfig = properties[
          'AmazonManagedKafkaEventSourceConfig'
        ] as import('@aws-sdk/client-lambda').AmazonManagedKafkaEventSourceConfig;
      if (properties['DocumentDBEventSourceConfig'])
        params.DocumentDBEventSourceConfig = properties[
          'DocumentDBEventSourceConfig'
        ] as import('@aws-sdk/client-lambda').DocumentDBEventSourceConfig;
      if (properties['ScalingConfig'])
        params.ScalingConfig = properties[
          'ScalingConfig'
        ] as import('@aws-sdk/client-lambda').ScalingConfig;
      if (properties['Tags']) {
        const cfnTags = properties['Tags'] as Array<{ Key: string; Value: string }>;
        params.Tags = Object.fromEntries(cfnTags.map((t) => [t.Key, t.Value]));
      }

      const response = await this.lambdaClient.send(new CreateEventSourceMappingCommand(params));

      const uuid = response.UUID;
      if (!uuid) {
        throw new Error('CreateEventSourceMapping did not return UUID');
      }

      this.logger.debug(`Successfully created event source mapping ${logicalId}: ${uuid}`);

      return {
        physicalId: uuid,
        attributes: {
          Id: uuid,
        },
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to create event source mapping ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        undefined,
        cause
      );
    }
  }

  /**
   * Update a Lambda Event Source Mapping
   */
  async update(
    logicalId: string,
    physicalId: string,
    _resourceType: string,
    properties: Record<string, unknown>,
    _previousProperties: Record<string, unknown>
  ): Promise<ResourceUpdateResult> {
    this.logger.debug(`Updating event source mapping ${logicalId}: ${physicalId}`);

    const updateParams: import('@aws-sdk/client-lambda').UpdateEventSourceMappingCommandInput = {
      UUID: physicalId,
      FunctionName: properties['FunctionName'] as string,
    };
    if (properties['BatchSize']) updateParams.BatchSize = properties['BatchSize'] as number;
    if (properties['Enabled'] !== undefined)
      updateParams.Enabled = properties['Enabled'] as boolean;
    if (properties['MaximumBatchingWindowInSeconds'])
      updateParams.MaximumBatchingWindowInSeconds = properties[
        'MaximumBatchingWindowInSeconds'
      ] as number;
    if (properties['MaximumRetryAttempts'] !== undefined)
      updateParams.MaximumRetryAttempts = properties['MaximumRetryAttempts'] as number;
    if (properties['BisectBatchOnFunctionError'] !== undefined)
      updateParams.BisectBatchOnFunctionError = properties['BisectBatchOnFunctionError'] as boolean;
    if (properties['MaximumRecordAgeInSeconds'])
      updateParams.MaximumRecordAgeInSeconds = properties['MaximumRecordAgeInSeconds'] as number;
    if (properties['ParallelizationFactor'])
      updateParams.ParallelizationFactor = properties['ParallelizationFactor'] as number;
    if (properties['FilterCriteria'])
      updateParams.FilterCriteria = properties['FilterCriteria'] as {
        Filters?: Array<{ Pattern?: string }>;
      };
    if (properties['DestinationConfig'])
      updateParams.DestinationConfig = properties[
        'DestinationConfig'
      ] as import('@aws-sdk/client-lambda').DestinationConfig;
    if (properties['TumblingWindowInSeconds'])
      updateParams.TumblingWindowInSeconds = properties['TumblingWindowInSeconds'] as number;
    if (properties['FunctionResponseTypes'])
      updateParams.FunctionResponseTypes = properties[
        'FunctionResponseTypes'
      ] as import('@aws-sdk/client-lambda').FunctionResponseType[];
    if (properties['SourceAccessConfigurations'])
      updateParams.SourceAccessConfigurations = properties[
        'SourceAccessConfigurations'
      ] as import('@aws-sdk/client-lambda').SourceAccessConfiguration[];
    if (properties['ScalingConfig'])
      updateParams.ScalingConfig = properties[
        'ScalingConfig'
      ] as import('@aws-sdk/client-lambda').ScalingConfig;
    if (properties['DocumentDBEventSourceConfig'])
      updateParams.DocumentDBEventSourceConfig = properties[
        'DocumentDBEventSourceConfig'
      ] as import('@aws-sdk/client-lambda').DocumentDBEventSourceConfig;

    await this.lambdaClient.send(new UpdateEventSourceMappingCommand(updateParams));

    this.logger.debug(`Successfully updated event source mapping ${logicalId}`);

    return {
      physicalId,
      wasReplaced: false,
      attributes: {
        Id: physicalId,
      },
    };
  }

  /**
   * Delete a Lambda Event Source Mapping
   */
  async delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    _properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void> {
    this.logger.debug(`Deleting event source mapping ${logicalId}: ${physicalId}`);

    try {
      // Check if mapping still exists
      try {
        await this.lambdaClient.send(new GetEventSourceMappingCommand({ UUID: physicalId }));
      } catch (error) {
        if (error instanceof ResourceNotFoundException) {
          const clientRegion = await this.lambdaClient.config.region();
          assertRegionMatch(
            clientRegion,
            context?.expectedRegion,
            resourceType,
            logicalId,
            physicalId
          );
          this.logger.debug(`Event source mapping ${physicalId} does not exist, skipping deletion`);
          return;
        }
        throw error;
      }

      await this.lambdaClient.send(new DeleteEventSourceMappingCommand({ UUID: physicalId }));
      this.logger.debug(`Successfully deleted event source mapping ${logicalId}`);
    } catch (error) {
      if (error instanceof ResourceNotFoundException) {
        const clientRegion = await this.lambdaClient.config.region();
        assertRegionMatch(
          clientRegion,
          context?.expectedRegion,
          resourceType,
          logicalId,
          physicalId
        );
        this.logger.debug(`Event source mapping ${physicalId} does not exist, skipping deletion`);
        return;
      }
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to delete event source mapping ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }
}
