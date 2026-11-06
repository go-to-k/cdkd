import {
  CreateEventSourceMappingCommand,
  ListEventSourceMappingsCommand,
  type EventSourcePosition,
} from '@aws-sdk/client-lambda';
import type { LambdaEventSourceMappingProvider } from '../lambda-eventsource-provider.js';
import { ProvisioningError } from '../../../utils/error-handler.js';
import type { CreateContext, ResourceCreateResult } from '../../../types/resource.js';
import { safeMsg } from '../../../utils/display-safe.js';
import {
  refuseMalformedDesiredTags,
  DBPROXY_TAG_OPTIONS,
  DBPROXY_TAGS_WHAT,
} from '../../tag-list.js';
import type { MaskedLogSinks } from '../../masked-retry-logger.js';
import { pasteableAwsCommand } from '../../replacement-protection-advice.js';
import { replayedSendWindow, type AmbiguousCreateWindow } from '../ambiguous-create.js';
import {
  collectOrphanIds,
  orphanCommandRegionArg,
  reportPossibleOrphans,
} from '../orphan-report.js';
import { parseCfnTimestamp } from '../../../utils/cfn-timestamp.js';
import {
  createEventSourceMappingLatch,
  mappingsCreatedByThisProcess,
  replayableKafkaConfig,
  toSdkSelfManagedEventSource,
} from './shared.js';

/**
 * Create a Lambda Event Source Mapping
 */
export async function create(
  this: LambdaEventSourceMappingProvider,
  logicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  context?: CreateContext
): Promise<ResourceCreateResult> {
  // Issue #2177: every create() line and failure goes through this one sink
  // set.
  const log = this.operationSinks(context?.maskSecrets, properties);
  log.debug(`Creating event source mapping ${logicalId}`);
  // go-to-k/cdkd#3994: a malformed Tags is refused before any call. The CFn
  // schema makes a tag's Value optional (nestedRequired.Tags is ["Key"]);
  // an omitted Value is sent as '' like the RDS DBProxy and Lambda
  // NetworkConnector providers (issue #5356). CloudFormation accepts the
  // entry too, but was measured leaving it off the CreateEventSourceMapping
  // request; cdkd applies the declared key instead of dropping it.
  const desiredTags = refuseMalformedDesiredTags(
    properties['Tags'],
    resourceType,
    logicalId,
    undefined,
    'Tags',
    DBPROXY_TAGS_WHAT,
    DBPROXY_TAG_OPTIONS
  );

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
    // `!== undefined`: a declared `0` is sent, as CloudFormation sends it
    // (issue #5356); omitting it leaves a Kafka / MQ / DocumentDB mapping on
    // AWS's 500 ms default.
    if (properties['MaximumBatchingWindowInSeconds'] !== undefined)
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
      params.SelfManagedEventSource = toSdkSelfManagedEventSource(
        properties['SelfManagedEventSource']
      );
    if (properties['SelfManagedKafkaEventSourceConfig'])
      params.SelfManagedKafkaEventSourceConfig = properties[
        'SelfManagedKafkaEventSourceConfig'
      ] as import('@aws-sdk/client-lambda').SelfManagedKafkaEventSourceConfig;
    const replayableKafka =
      context?.replayingState === true ? replayableKafkaConfig(properties) : undefined;
    if (replayableKafka !== undefined) {
      log.warn(
        safeMsg`AWS::Lambda::EventSourceMapping ${logicalId}: the state record holds ConsumptionMode Queue beside a member Lambda refuses with it, so the mapping it records never ran in Queue mode. Proceeding without ConsumptionMode: this create replays a cdkd state record.`
      );
      params.SelfManagedKafkaEventSourceConfig = replayableKafka;
    }
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
      params.Tags = Object.fromEntries(desiredTags.map((t) => [t.Key, t.Value]));
    }
    // #609 backfill — 7 props closed in one slice. The CFn field name
    // is `KmsKeyArn` (lower-case `ms`); the SDK field is `KMSKeyArn`
    // (upper-case `MS`) — wire-format casing flip happens here.
    // Use `!== undefined` for the 4 mutable props to mirror update()'s
    // gating, so an explicit `''` (the AWS-documented `KMSKeyArn`
    // clear-back-to-AWS-owned-key sentinel) and explicit empty objects
    // / arrays all reach AWS. Queues / Topics use truthy: the Update API
    // does not take them (update() refuses a change, issue #5356), and
    // the schema requires at least one item, so there is no clear
    // sentinel to mirror.
    if (properties['KmsKeyArn'] !== undefined) params.KMSKeyArn = properties['KmsKeyArn'] as string;
    if (properties['LoggingConfig'] !== undefined)
      params.LoggingConfig = properties[
        'LoggingConfig'
      ] as import('@aws-sdk/client-lambda').EventSourceMappingLoggingConfig;
    if (properties['MetricsConfig'] !== undefined)
      params.MetricsConfig = properties[
        'MetricsConfig'
      ] as import('@aws-sdk/client-lambda').EventSourceMappingMetricsConfig;
    if (properties['ProvisionedPollerConfig'] !== undefined)
      params.ProvisionedPollerConfig = properties[
        'ProvisionedPollerConfig'
      ] as import('@aws-sdk/client-lambda').ProvisionedPollerConfig;
    // Queues / Topics: the MQ queue / Kafka topic to consume. Absent from
    // UpdateEventSourceMappingRequest, so update() refuses a change.
    if (properties['Queues']) params.Queues = properties['Queues'] as string[];
    if (properties['Topics']) params.Topics = properties['Topics'] as string[];
    // StartingPositionTimestamp: SDK expects `Date`; CFn template
    // supplies a number (epoch seconds, per the AWS::Lambda::EventSourceMapping
    // schema) or — defensively — an ISO-8601 string (offset-less read as
    // UTC, issue #5311). Coerce both.
    // Create-only in the CFn schema (and absent from
    // UpdateEventSourceMappingRequest), so cdkd's diff layer replaces the
    // mapping on a change before update() is reached.
    if (properties['StartingPositionTimestamp'] !== undefined) {
      const raw = properties['StartingPositionTimestamp'];
      params.StartingPositionTimestamp =
        typeof raw === 'number'
          ? new Date(raw * 1000)
          : raw instanceof Date
            ? raw
            : parseCfnTimestamp(raw as string);
    }

    // Issue #2080: after an earlier ambiguous attempt, name the mapping it
    // may have created before a second CreateEventSourceMapping is sent.
    // Detection only -- see `orphan-report.ts`.
    const orphanWindow = createEventSourceMappingLatch.take(logicalId);
    if (orphanWindow !== undefined) {
      await this.reportPossibleMappingOrphans(
        logicalId,
        orphanWindow,
        log,
        functionName,
        params.EventSourceArn
      );
    }
    const createClient = await this.getCreateClient();
    const attemptStartMs = Date.now();
    let response: import('@aws-sdk/client-lambda').CreateEventSourceMappingCommandOutput;
    try {
      response = await createClient.send(new CreateEventSourceMappingCommand(params));
    } catch (error) {
      createEventSourceMappingLatch.noteFailure(logicalId, error, attemptStartMs, orphanWindow);
      throw error;
    }

    const uuid = response.UUID;
    if (!uuid) {
      throw new Error('CreateEventSourceMapping did not return UUID');
    }
    mappingsCreatedByThisProcess.add(uuid);
    // Issue #4687: the SDK replayed this CreateEventSourceMapping inside its `send`, so
    // an earlier attempt may have made one too. Detection only.
    const replayWindow = replayedSendWindow(response, attemptStartMs);
    if (replayWindow !== undefined) {
      await this.reportPossibleMappingOrphans(
        logicalId,
        replayWindow,
        log,
        functionName,
        params.EventSourceArn
      );
    }

    log.debug(`Successfully created event source mapping ${logicalId}: ${uuid}`);

    return {
      physicalId: uuid,
      attributes: {
        Id: uuid,
        // Cache the ARN under its CFn read-only name so
        // `Fn::GetAtt [Esm, EventSourceMappingArn]` resolves from state
        // (issue #1190). The physical id is the ESM UUID (not ARN-shaped) and
        // the resolver's `constructAttribute` has no ESM branch, so without
        // this the resolver's shape guard hard-fails the deploy.
        EventSourceMappingArn: response.EventSourceMappingArn,
      },
      // The record keeps what was sent: Lambda holds no mode for this mapping.
      ...(replayableKafka !== undefined && {
        effectiveProperties: {
          ...properties,
          SelfManagedKafkaEventSourceConfig: replayableKafka,
        },
      }),
    };
  } catch (error) {
    const cause = error instanceof Error ? error : undefined;
    throw this.wrapMaskedError(
      log,
      error,
      (text) =>
        new ProvisioningError(
          `Failed to create event source mapping ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          undefined,
          cause
        )
    );
  }
}

/**
 * Issue #2080: list the mappings an earlier ambiguous
 * `CreateEventSourceMapping` attempt may have created, and warn. Detection
 * only, and undated: Lambda reports when a mapping was last MODIFIED, not
 * when it was created, and a fresh mapping's state change (`Creating` to
 * `Enabled`) moves that time past the attempt -- so it bounds a candidate
 * from below only (a mapping untouched since before the attempt is not its
 * orphan), the report prints no delete command, and nothing is adopted: a
 * mapping between the same function and source can be another deploy's.
 *
 * Where Lambda refuses a second mapping between the same function and
 * source (it does for an SQS queue: `ResourceConflictException`), the
 * create that follows this report fails on the orphan instead of
 * duplicating it; the report names the UUID that create collides with.
 */
export async function reportPossibleMappingOrphans(
  this: LambdaEventSourceMappingProvider,
  logicalId: string,
  window: AmbiguousCreateWindow,
  log: MaskedLogSinks,
  functionName: string,
  sourceArn: string | undefined
): Promise<void> {
  const aws = pasteableAwsCommand(log.mask);
  const regionArg = await orphanCommandRegionArg(this.lambdaClient, aws);
  await reportPossibleOrphans(logicalId, window, log, {
    action: 'CreateEventSourceMapping',
    service: 'Lambda',
    listAction: 'ListEventSourceMappings',
    subject: `an event source mapping from ${sourceArn !== undefined ? log.value(sourceArn) : 'a self-managed event source'} to function ${log.value(functionName)}`,
    noun: 'event source mapping(s)',
    list: () =>
      collectOrphanIds(
        async (marker) => {
          const page = await this.lambdaClient.send(
            new ListEventSourceMappingsCommand({
              FunctionName: functionName,
              ...(sourceArn !== undefined && { EventSourceArn: sourceArn }),
              ...(marker && { Marker: marker }),
            })
          );
          return { items: page.EventSourceMappings ?? [], next: page.NextMarker };
        },
        (item) =>
          item.UUID &&
          !mappingsCreatedByThisProcess.has(item.UUID) &&
          // A mapping with no `LastModified` is left out, like an undated
          // layer version: missed, never wrongly reported.
          item.LastModified !== undefined &&
          item.LastModified.getTime() >= window.floorMs
            ? item.UUID
            : undefined
      ),
    inspect: (id) => aws`aws lambda get-event-source-mapping --uuid ${id}${regionArg}`.render(),
  });
}
