import {
  LambdaClient,
  CreateEventSourceMappingCommand,
  DeleteEventSourceMappingCommand,
  UpdateEventSourceMappingCommand,
  GetEventSourceMappingCommand,
  ListTagsCommand,
  TagResourceCommand,
  UntagResourceCommand,
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
  ResourceImportInput,
  ResourceImportResult,
} from '../../types/resource.js';

/**
 * Classify an event source mapping by its `EventSourceArn` so that
 * `readCurrentState` can gate type-discriminator-dependent CFn fields.
 *
 * Several `AWS::Lambda::EventSourceMapping` properties are only valid
 * when the source is a specific service. Always-emitting placeholders
 * (`[]` / `''`) for the wrong source type causes
 * `cdkd drift --revert` to round-trip those placeholders back through
 * `UpdateEventSourceMappingCommand`, where AWS rejects them:
 *
 * - `FunctionResponseTypes` is only valid for SQS / DynamoDB Streams /
 *   Kinesis Streams (where `ReportBatchItemFailures` makes sense).
 *   Pushing `[]` against a Kafka or MQ source is rejected with
 *   "FunctionResponseTypes is not allowed for this event source".
 * - `SourceAccessConfigurations` is only valid for self-managed Kafka /
 *   MSK / MQ. Pushing `[]` against SQS / Kinesis / DynamoDB is rejected
 *   similarly.
 */
type EventSourceKind =
  | 'sqs'
  | 'kinesis'
  | 'dynamodb'
  | 'kafka' // both MSK and self-managed Kafka
  | 'mq'
  | 'documentdb'
  | 'unknown';

function classifyEventSource(resp: {
  EventSourceArn?: string | undefined;
  SelfManagedEventSource?: unknown;
  AmazonManagedKafkaEventSourceConfig?: unknown;
  SelfManagedKafkaEventSourceConfig?: unknown;
  DocumentDBEventSourceConfig?: unknown;
}): EventSourceKind {
  // Self-managed Kafka has no EventSourceArn — it carries
  // SelfManagedEventSource instead.
  if (resp.SelfManagedEventSource !== undefined) return 'kafka';
  if (resp.SelfManagedKafkaEventSourceConfig !== undefined) return 'kafka';
  if (resp.AmazonManagedKafkaEventSourceConfig !== undefined) return 'kafka';
  if (resp.DocumentDBEventSourceConfig !== undefined) return 'documentdb';
  const arn = resp.EventSourceArn;
  if (!arn) return 'unknown';
  // arn:aws:<service>:<region>:<account>:<rest>
  if (arn.startsWith('arn:aws:sqs:') || arn.startsWith('arn:aws-cn:sqs:')) return 'sqs';
  if (arn.startsWith('arn:aws:kinesis:') || arn.startsWith('arn:aws-cn:kinesis:')) return 'kinesis';
  if (arn.startsWith('arn:aws:dynamodb:') || arn.startsWith('arn:aws-cn:dynamodb:'))
    return 'dynamodb';
  if (arn.startsWith('arn:aws:kafka:') || arn.startsWith('arn:aws-cn:kafka:')) return 'kafka';
  if (arn.startsWith('arn:aws:mq:') || arn.startsWith('arn:aws-cn:mq:')) return 'mq';
  if (arn.startsWith('arn:aws:rds:') || arn.startsWith('arn:aws-cn:rds:')) {
    // DocumentDB cluster ARNs use the `rds` service prefix, but are
    // disambiguated above by `DocumentDBEventSourceConfig`.
    return 'documentdb';
  }
  return 'unknown';
}

/**
 * Classify an event source mapping from its CFn property bag (as opposed to
 * `classifyEventSource`, which reads an AWS `GetEventSourceMapping` response).
 * The discriminating keys are identical in both shapes (`EventSourceArn` plus
 * the four `*EventSourceConfig` / `SelfManagedEventSource` markers), so this
 * is a thin type-narrowing adapter over the same logic. Used by `update()`'s
 * removal-clear path (issue #976) to gate source-kind-specific clears
 * (`FunctionResponseTypes` / `SourceAccessConfigurations` /
 * `MaximumBatchingWindowInSeconds`).
 */
function classifyEventSourceFromProperties(properties: Record<string, unknown>): EventSourceKind {
  return classifyEventSource({
    EventSourceArn: properties['EventSourceArn'] as string | undefined,
    SelfManagedEventSource: properties['SelfManagedEventSource'],
    AmazonManagedKafkaEventSourceConfig: properties['AmazonManagedKafkaEventSourceConfig'],
    SelfManagedKafkaEventSourceConfig: properties['SelfManagedKafkaEventSourceConfig'],
    DocumentDBEventSourceConfig: properties['DocumentDBEventSourceConfig'],
  });
}

const KINDS_WITH_FUNCTION_RESPONSE_TYPES: ReadonlySet<EventSourceKind> = new Set([
  'sqs',
  'kinesis',
  'dynamodb',
]);
const KINDS_WITH_SOURCE_ACCESS_CONFIGURATIONS: ReadonlySet<EventSourceKind> = new Set([
  'kafka',
  'mq',
  'documentdb',
]);
/**
 * Source kinds whose `MaximumBatchingWindowInSeconds` default is `0` seconds
 * (SQS / Kinesis / DynamoDB). The poll-based kinds (Kafka / MSK / MQ /
 * DocumentDB) default to 500 ms, which cannot be restored via
 * `UpdateEventSourceMapping` (the field only accepts whole-second increments),
 * so the removal-on-UPDATE path only restores `0` for these kinds — see the
 * comment at the `MaximumBatchingWindowInSeconds` clear in `update()`.
 */
const KINDS_WITH_ZERO_BATCHING_WINDOW_DEFAULT: ReadonlySet<EventSourceKind> = new Set([
  'sqs',
  'kinesis',
  'dynamodb',
]);
/**
 * Source kinds that accept the stream-processing numeric parameters
 * (`MaximumRetryAttempts` / `MaximumRecordAgeInSeconds` /
 * `ParallelizationFactor` / `TumblingWindowInSeconds`) — Kinesis / DynamoDB
 * streams only. AWS rejects these on SQS / Kafka / MQ / DocumentDB, so the
 * removal-on-UPDATE default-restore path is gated on this set (see the numeric
 * restores in `update()`).
 */
const KINDS_WITH_STREAM_NUMERICS: ReadonlySet<EventSourceKind> = new Set(['kinesis', 'dynamodb']);

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
        // #609 backfill — 4 mutable (KMSKeyArn / LoggingConfig /
        // MetricsConfig / ProvisionedPollerConfig ride both Create
        // and Update) + 3 create-only (Queues / Topics /
        // StartingPositionTimestamp absent from UpdateInput so
        // update() ignores them; AWS rejects mutation, CFn replaces
        // the resource on a template change to these — matched by
        // cdkd's existing diff layer which schedules a replace).
        'KmsKeyArn',
        'LoggingConfig',
        'MetricsConfig',
        'ProvisionedPollerConfig',
        'Queues',
        'Topics',
        'StartingPositionTimestamp',
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
      // #609 backfill — 7 props closed in one slice. The CFn field name
      // is `KmsKeyArn` (lower-case `ms`); the SDK field is `KMSKeyArn`
      // (upper-case `MS`) — wire-format casing flip happens here.
      // Use `!== undefined` for the 4 mutable props to mirror update()'s
      // gating, so an explicit `''` (the AWS-documented `KMSKeyArn`
      // clear-back-to-AWS-owned-key sentinel) and explicit empty objects
      // / arrays all reach AWS. Queues / Topics use truthy because they
      // are create-only — an empty array at create is a degenerate "no
      // self-managed targets" case that has no AWS meaning and would
      // generate a no-op call.
      if (properties['KmsKeyArn'] !== undefined)
        params.KMSKeyArn = properties['KmsKeyArn'] as string;
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
      // Queues / Topics: self-managed source target lists; create-only
      // (absent from UpdateEventSourceMappingRequest).
      if (properties['Queues']) params.Queues = properties['Queues'] as string[];
      if (properties['Topics']) params.Topics = properties['Topics'] as string[];
      // StartingPositionTimestamp: SDK expects `Date`; CFn template
      // supplies a number (epoch seconds, per the AWS::Lambda::EventSourceMapping
      // schema) or — defensively — an ISO-8601 string. Coerce both.
      // Also create-only (absent from UpdateEventSourceMappingRequest);
      // a template change forces a CFn-side replace, which cdkd's diff
      // layer schedules independently of this provider.
      if (properties['StartingPositionTimestamp'] !== undefined) {
        const raw = properties['StartingPositionTimestamp'];
        params.StartingPositionTimestamp =
          typeof raw === 'number'
            ? new Date(raw * 1000)
            : raw instanceof Date
              ? raw
              : new Date(raw as string);
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
          // Cache the ARN under its CFn read-only name so
          // `Fn::GetAtt [Esm, EventSourceMappingArn]` resolves from state
          // (issue #1190). The physical id is the ESM UUID (not ARN-shaped) and
          // the resolver's `constructAttribute` has no ESM branch, so without
          // this the resolver's shape guard hard-fails the deploy.
          EventSourceMappingArn: response.EventSourceMappingArn,
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
    previousProperties: Record<string, unknown>
  ): Promise<ResourceUpdateResult> {
    this.logger.debug(`Updating event source mapping ${logicalId}: ${physicalId}`);

    const updateParams: import('@aws-sdk/client-lambda').UpdateEventSourceMappingCommandInput = {
      UUID: physicalId,
      FunctionName: properties['FunctionName'] as string,
    };
    // Use `!== undefined` (not truthy) for any field where a falsy value
    // is a meaningful AWS input: `0` for the *Window/*Age second-counts
    // disables / infinite-ifies the feature, and `[]` for the array
    // properties is the documented way to clear a previously-set list.
    if (properties['BatchSize'] !== undefined)
      updateParams.BatchSize = properties['BatchSize'] as number;
    if (properties['Enabled'] !== undefined)
      updateParams.Enabled = properties['Enabled'] as boolean;
    if (properties['MaximumBatchingWindowInSeconds'] !== undefined)
      updateParams.MaximumBatchingWindowInSeconds = properties[
        'MaximumBatchingWindowInSeconds'
      ] as number;
    if (properties['MaximumRetryAttempts'] !== undefined)
      updateParams.MaximumRetryAttempts = properties['MaximumRetryAttempts'] as number;
    if (properties['BisectBatchOnFunctionError'] !== undefined)
      updateParams.BisectBatchOnFunctionError = properties['BisectBatchOnFunctionError'] as boolean;
    if (properties['MaximumRecordAgeInSeconds'] !== undefined)
      updateParams.MaximumRecordAgeInSeconds = properties['MaximumRecordAgeInSeconds'] as number;
    if (properties['ParallelizationFactor'] !== undefined)
      updateParams.ParallelizationFactor = properties['ParallelizationFactor'] as number;
    if (properties['FilterCriteria'] !== undefined)
      updateParams.FilterCriteria = properties['FilterCriteria'] as {
        Filters?: Array<{ Pattern?: string }>;
      };
    if (properties['DestinationConfig'] !== undefined)
      updateParams.DestinationConfig = properties[
        'DestinationConfig'
      ] as import('@aws-sdk/client-lambda').DestinationConfig;
    if (properties['TumblingWindowInSeconds'] !== undefined)
      updateParams.TumblingWindowInSeconds = properties['TumblingWindowInSeconds'] as number;
    if (properties['FunctionResponseTypes'] !== undefined)
      updateParams.FunctionResponseTypes = properties[
        'FunctionResponseTypes'
      ] as import('@aws-sdk/client-lambda').FunctionResponseType[];
    if (properties['SourceAccessConfigurations'] !== undefined)
      updateParams.SourceAccessConfigurations = properties[
        'SourceAccessConfigurations'
      ] as import('@aws-sdk/client-lambda').SourceAccessConfiguration[];
    if (properties['ScalingConfig'] !== undefined)
      updateParams.ScalingConfig = properties[
        'ScalingConfig'
      ] as import('@aws-sdk/client-lambda').ScalingConfig;
    if (properties['DocumentDBEventSourceConfig'] !== undefined)
      updateParams.DocumentDBEventSourceConfig = properties[
        'DocumentDBEventSourceConfig'
      ] as import('@aws-sdk/client-lambda').DocumentDBEventSourceConfig;
    // #609 backfill — the 4 mutable props (Queues / Topics /
    // StartingPositionTimestamp are create-only and intentionally NOT
    // forwarded here; AWS would reject the field and a template change
    // forces a CFn-side replace, scheduled by cdkd's diff layer).
    // CFn `KmsKeyArn` → SDK `KMSKeyArn` casing flip mirrors create().
    // Use `!== undefined` so an explicit `''` / `null` reaches AWS as
    // the documented clear-sentinel (Lambda treats empty KMSKeyArn as
    // "fall back to AWS-owned key").
    if (properties['KmsKeyArn'] !== undefined)
      updateParams.KMSKeyArn = properties['KmsKeyArn'] as string;
    if (properties['LoggingConfig'] !== undefined)
      updateParams.LoggingConfig = properties[
        'LoggingConfig'
      ] as import('@aws-sdk/client-lambda').EventSourceMappingLoggingConfig;
    if (properties['MetricsConfig'] !== undefined)
      updateParams.MetricsConfig = properties[
        'MetricsConfig'
      ] as import('@aws-sdk/client-lambda').EventSourceMappingMetricsConfig;
    if (properties['ProvisionedPollerConfig'] !== undefined)
      updateParams.ProvisionedPollerConfig = properties[
        'ProvisionedPollerConfig'
      ] as import('@aws-sdk/client-lambda').ProvisionedPollerConfig;

    // Removal-on-UPDATE (issue #976). The `!== undefined` guards above only
    // fire when the NEW template still carries the property, so a property
    // REMOVED from the template is simply omitted from the Update call and
    // AWS treats the omission as "no change" — the old value silently
    // survives (cdkd diff shows old->undefined, state drops it, AWS keeps
    // it). CloudFormation instead sends each cleared property's documented
    // reset sentinel on UpdateEventSourceMapping. We mirror that: for every
    // property that was present in `previousProperties` and is now absent in
    // `properties`, send the documented clear/reset value.
    //
    // Source-kind gating: `FunctionResponseTypes` (SQS/Kinesis/DynamoDB) and
    // `SourceAccessConfigurations` (Kafka/MSK/MQ/DocumentDB) are only valid
    // for a subset of source kinds — AWS rejects the `[]` clear against the
    // wrong kind ("X is not allowed for this event source"), so we classify
    // the source from the previous property bag and gate those two clears.
    const wasSet = (key: string): boolean =>
      previousProperties[key] !== undefined && properties[key] === undefined;
    const prevKind = classifyEventSourceFromProperties(previousProperties);

    // Object properties whose documented clear sentinel is an empty object.
    // `FilterCriteria: {}` is explicitly documented (Lambda event-filtering
    // guide: "run update-event-source-mapping ... with an empty
    // FilterCriteria object"); `ScalingConfig: {}` / `DestinationConfig: {}`
    // reset MaximumConcurrency / the on-failure destination back to default.
    if (wasSet('FilterCriteria')) updateParams.FilterCriteria = {};
    if (wasSet('ScalingConfig')) updateParams.ScalingConfig = {};
    if (wasSet('DestinationConfig')) updateParams.DestinationConfig = {};

    // Array properties whose documented clear sentinel is an empty array,
    // gated by source kind (see above).
    if (wasSet('FunctionResponseTypes') && KINDS_WITH_FUNCTION_RESPONSE_TYPES.has(prevKind))
      updateParams.FunctionResponseTypes = [];
    if (
      wasSet('SourceAccessConfigurations') &&
      KINDS_WITH_SOURCE_ACCESS_CONFIGURATIONS.has(prevKind)
    )
      updateParams.SourceAccessConfigurations = [];

    // MetricsConfig resets by disabling the opt-in metrics — `{ Metrics: [] }`.
    if (wasSet('MetricsConfig')) updateParams.MetricsConfig = { Metrics: [] };

    // KMSKeyArn (CFn `KmsKeyArn`): the documented clear sentinel is an empty
    // string — Lambda then falls back to the AWS-owned key. Mirrors the
    // explicit-`''` passthrough above; here we also honor REMOVAL.
    if (wasSet('KmsKeyArn')) updateParams.KMSKeyArn = '';

    // Numeric properties: restore the AWS default value on removal. The
    // documented defaults are: MaximumRetryAttempts = -1 (infinite),
    // MaximumRecordAgeInSeconds = -1 (infinite), ParallelizationFactor = 1,
    // TumblingWindowInSeconds = 0 (no window). All four are stream-only
    // (Kinesis / DynamoDB) parameters — AWS rejects them on SQS / Kafka / MQ /
    // DocumentDB mappings — so gate the restore on the stream kinds, mirroring
    // the array / batching-window clears above. CDK never emits these on a
    // non-stream mapping, so the guard is defense-in-depth against a
    // hand-authored / imported previous template carrying a stray value.
    if (KINDS_WITH_STREAM_NUMERICS.has(prevKind)) {
      if (wasSet('MaximumRetryAttempts')) updateParams.MaximumRetryAttempts = -1;
      if (wasSet('MaximumRecordAgeInSeconds')) updateParams.MaximumRecordAgeInSeconds = -1;
      if (wasSet('ParallelizationFactor')) updateParams.ParallelizationFactor = 1;
      if (wasSet('TumblingWindowInSeconds')) updateParams.TumblingWindowInSeconds = 0;
    }

    // MaximumBatchingWindowInSeconds: the default is 0 for
    // SQS/Kinesis/DynamoDB but 500 ms for Kafka/MSK/MQ/DocumentDB — and AWS
    // documents that the 500 ms default CANNOT be restored via
    // UpdateEventSourceMapping (the field only accepts whole-second
    // increments, so you must create a new mapping). We therefore restore
    // `0` on removal ONLY for the second-granular kinds; for the poll-based
    // kinds we intentionally leave the field untouched (a template change
    // that must restore 500 ms is a CFn-side replace, not an in-place clear).
    if (
      wasSet('MaximumBatchingWindowInSeconds') &&
      KINDS_WITH_ZERO_BATCHING_WINDOW_DEFAULT.has(prevKind)
    )
      updateParams.MaximumBatchingWindowInSeconds = 0;

    // No documented clear sentinel — intentionally NOT cleared on removal:
    //   - LoggingConfig: holds enum log-level fields, not a presence toggle;
    //     AWS documents no `{}` reset. Removing it in the template is a
    //     no-op against AWS (the last-applied log config survives).
    //   - ProvisionedPollerConfig: no documented empty-object reset to
    //     on-demand poller scaling. Left untouched on removal.
    //   - BatchSize: source-dependent default (10 for SQS, 100 otherwise);
    //     rarely removed, and a wrong default would change batching
    //     behavior. Left untouched on removal (the last value survives).

    const updateResp = await this.lambdaClient.send(
      new UpdateEventSourceMappingCommand(updateParams)
    );

    // Apply tag diff. UpdateEventSourceMapping does not accept Tags; use
    // TagResource / UntagResource against the EventSourceMapping ARN.
    const eventSourceMappingArn = updateResp.EventSourceMappingArn;
    if (eventSourceMappingArn) {
      await this.applyTagDiff(
        eventSourceMappingArn,
        previousProperties['Tags'] as Array<{ Key?: string; Value?: string }> | undefined,
        properties['Tags'] as Array<{ Key?: string; Value?: string }> | undefined
      );
    }

    this.logger.debug(`Successfully updated event source mapping ${logicalId}`);

    return {
      physicalId,
      wasReplaced: false,
      attributes: {
        Id: physicalId,
        // Re-cache the ARN under its CFn read-only name (issue #1190); see the
        // matching note in create(). `updateResp.EventSourceMappingArn` is
        // already read above for the tag diff.
        EventSourceMappingArn: updateResp.EventSourceMappingArn,
      },
    };
  }

  /**
   * Apply a diff between old and new CFn-shape Tags arrays via Lambda's
   * `TagResource` / `UntagResource` APIs against the EventSourceMapping
   * ARN. Lambda's `TagResource` takes `{ Resource, Tags: { key: value } }`;
   * `UntagResource` takes `{ Resource, TagKeys: [...] }`.
   */
  private async applyTagDiff(
    arn: string,
    oldTagsRaw: Array<{ Key?: string; Value?: string }> | undefined,
    newTagsRaw: Array<{ Key?: string; Value?: string }> | undefined
  ): Promise<void> {
    const toMap = (
      tags: Array<{ Key?: string; Value?: string }> | undefined
    ): Map<string, string> => {
      const m = new Map<string, string>();
      for (const t of tags ?? []) {
        if (t.Key !== undefined && t.Value !== undefined) m.set(t.Key, t.Value);
      }
      return m;
    };

    const oldMap = toMap(oldTagsRaw);
    const newMap = toMap(newTagsRaw);

    const tagsToAdd: Record<string, string> = {};
    for (const [k, v] of newMap) {
      if (oldMap.get(k) !== v) tagsToAdd[k] = v;
    }
    const tagsToRemove: string[] = [];
    for (const k of oldMap.keys()) {
      if (!newMap.has(k)) tagsToRemove.push(k);
    }

    if (tagsToRemove.length > 0) {
      await this.lambdaClient.send(
        new UntagResourceCommand({ Resource: arn, TagKeys: tagsToRemove })
      );
      this.logger.debug(`Removed ${tagsToRemove.length} tag(s) from EventSourceMapping ${arn}`);
    }
    if (Object.keys(tagsToAdd).length > 0) {
      await this.lambdaClient.send(new TagResourceCommand({ Resource: arn, Tags: tagsToAdd }));
      this.logger.debug(
        `Added/updated ${Object.keys(tagsToAdd).length} tag(s) on EventSourceMapping ${arn}`
      );
    }
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

  /**
   * Read the AWS-current Lambda event source mapping configuration in
   * CFn-property shape.
   *
   * Issues `GetEventSourceMapping` for the UUID and surfaces the keys
   * `create()` accepts. AWS-managed fields (`UUID`, `LastModified`,
   * `LastProcessingResult`, `State`, `StateTransitionReason`,
   * `EventSourceMappingArn`) are filtered at the wire layer.
   *
   * `FunctionName`: AWS's `GetEventSourceMapping` always returns the
   * resolved ARN. cdkd state typically holds the same ARN after intrinsic
   * resolution, but a hand-authored state might carry the bare function
   * name. We surface the form that matches state when possible: if the
   * `properties?.FunctionName` is the bare name AND the AWS-current
   * ARN's last segment matches that name, emit the bare name; otherwise
   * emit the ARN. (The two forms address the same Lambda function — the
   * shape-mismatch was the only reason a clean run fired drift.)
   *
   * `Tags` are surfaced via a follow-up `ListTags(Resource=<ESM ARN>)`
   * call. Always-emit `[]` so a console-side tag ADD on a previously-
   * untagged event source mapping is detectable on the v3
   * observedProperties baseline.
   *
   * Returns `undefined` when the mapping is gone
   * (`ResourceNotFoundException`).
   */
  async readCurrentState(
    physicalId: string,
    _logicalId: string,
    _resourceType: string,
    properties?: Record<string, unknown>
  ): Promise<Record<string, unknown> | undefined> {
    let resp;
    try {
      resp = await this.lambdaClient.send(new GetEventSourceMappingCommand({ UUID: physicalId }));
    } catch (err) {
      if (err instanceof ResourceNotFoundException) return undefined;
      throw err;
    }

    const result: Record<string, unknown> = {};

    if (resp.FunctionArn !== undefined) {
      // Match state's shape when state holds the bare function name and
      // the ARN's last segment matches — avoids false drift from
      // ARN-vs-name mismatch. Otherwise emit the ARN as-is.
      const stateFn = properties?.['FunctionName'];
      const arnTail = resp.FunctionArn.split(':').pop();
      if (typeof stateFn === 'string' && !stateFn.includes(':') && stateFn === arnTail) {
        result['FunctionName'] = stateFn;
      } else {
        result['FunctionName'] = resp.FunctionArn;
      }
    }
    if (resp.EventSourceArn !== undefined) result['EventSourceArn'] = resp.EventSourceArn;
    if (resp.BatchSize !== undefined) result['BatchSize'] = resp.BatchSize;
    if (resp.StartingPosition !== undefined) result['StartingPosition'] = resp.StartingPosition;
    if (resp.MaximumBatchingWindowInSeconds !== undefined) {
      result['MaximumBatchingWindowInSeconds'] = resp.MaximumBatchingWindowInSeconds;
    }
    if (resp.MaximumRetryAttempts !== undefined) {
      result['MaximumRetryAttempts'] = resp.MaximumRetryAttempts;
    }
    if (resp.BisectBatchOnFunctionError !== undefined) {
      result['BisectBatchOnFunctionError'] = resp.BisectBatchOnFunctionError;
    }
    if (resp.MaximumRecordAgeInSeconds !== undefined) {
      result['MaximumRecordAgeInSeconds'] = resp.MaximumRecordAgeInSeconds;
    }
    if (resp.ParallelizationFactor !== undefined) {
      result['ParallelizationFactor'] = resp.ParallelizationFactor;
    }
    if (resp.FilterCriteria !== undefined) result['FilterCriteria'] = resp.FilterCriteria;
    if (resp.DestinationConfig !== undefined) {
      result['DestinationConfig'] = resp.DestinationConfig;
    }
    if (resp.TumblingWindowInSeconds !== undefined) {
      result['TumblingWindowInSeconds'] = resp.TumblingWindowInSeconds;
    }
    // Class-1 type-discriminator gating: only emit `FunctionResponseTypes`
    // / `SourceAccessConfigurations` placeholders when the source kind
    // actually supports them. AWS rejects round-trip writes of empty
    // arrays for the wrong source kind via `UpdateEventSourceMappingCommand`.
    const kind = classifyEventSource(resp);
    if (KINDS_WITH_FUNCTION_RESPONSE_TYPES.has(kind)) {
      result['FunctionResponseTypes'] = resp.FunctionResponseTypes
        ? [...resp.FunctionResponseTypes]
        : [];
    } else if (resp.FunctionResponseTypes !== undefined) {
      result['FunctionResponseTypes'] = [...resp.FunctionResponseTypes];
    }
    if (KINDS_WITH_SOURCE_ACCESS_CONFIGURATIONS.has(kind)) {
      result['SourceAccessConfigurations'] = resp.SourceAccessConfigurations ?? [];
    } else if (resp.SourceAccessConfigurations !== undefined) {
      result['SourceAccessConfigurations'] = resp.SourceAccessConfigurations;
    }
    if (resp.SelfManagedEventSource !== undefined) {
      result['SelfManagedEventSource'] = resp.SelfManagedEventSource;
    }
    if (resp.SelfManagedKafkaEventSourceConfig !== undefined) {
      result['SelfManagedKafkaEventSourceConfig'] = resp.SelfManagedKafkaEventSourceConfig;
    }
    if (resp.AmazonManagedKafkaEventSourceConfig !== undefined) {
      result['AmazonManagedKafkaEventSourceConfig'] = resp.AmazonManagedKafkaEventSourceConfig;
    }
    if (resp.DocumentDBEventSourceConfig !== undefined) {
      result['DocumentDBEventSourceConfig'] = resp.DocumentDBEventSourceConfig;
    }
    if (resp.ScalingConfig !== undefined) result['ScalingConfig'] = resp.ScalingConfig;
    // #609 backfill — surface the 7 newly-handled props from the
    // GetEventSourceMapping response. Emit-when-present (NOT default-
    // when-absent placeholder): AWS returns these only when set, and a
    // phantom `KmsKeyArn: ''` / `LoggingConfig: { ... defaults }` on an
    // untouched ESM would force guaranteed drift on every clean run.
    // Note casing flip back: SDK `KMSKeyArn` → CFn `KmsKeyArn`.
    if (resp.KMSKeyArn !== undefined) result['KmsKeyArn'] = resp.KMSKeyArn;
    if (resp.LoggingConfig !== undefined) result['LoggingConfig'] = resp.LoggingConfig;
    if (resp.MetricsConfig !== undefined) result['MetricsConfig'] = resp.MetricsConfig;
    if (resp.ProvisionedPollerConfig !== undefined)
      result['ProvisionedPollerConfig'] = resp.ProvisionedPollerConfig;
    if (resp.Queues !== undefined) result['Queues'] = [...resp.Queues];
    if (resp.Topics !== undefined) result['Topics'] = [...resp.Topics];
    // StartingPositionTimestamp: AWS SDK v3 types this as Date, but
    // older SDK shapes / non-AWS endpoints (LocalStack etc.) can return
    // an ISO-string. Coerce via `new Date(...)` so either reaches the
    // epoch-seconds conversion safely. cdkd state stores the
    // epoch-seconds number the user supplied at create; this conversion
    // back lets the drift comparator see the same shape on both sides.
    if (resp.StartingPositionTimestamp !== undefined) {
      const raw = resp.StartingPositionTimestamp;
      const date = raw instanceof Date ? raw : new Date(raw as string);
      result['StartingPositionTimestamp'] = Math.floor(date.getTime() / 1000);
    }

    // `Enabled` derives from `State`: AWS exposes the underlying state
    // (Enabled / Disabled / Enabling / Disabling / Updating / Creating /
    // Deleting); cdkd state stores the boolean the user set on create.
    if (resp.State !== undefined) {
      const enabled =
        resp.State === 'Enabled' || resp.State === 'Enabling' || resp.State === 'Updating';
      result['Enabled'] = enabled;
    }

    // Tags via ListTags(Resource: <ESM ARN>). cdkd's create() reshapes
    // CFn `Tags: [{Key, Value}]` into the SDK's `{Key: Value}` map at
    // create time; we go the other way here. Always-emit `[]` so a
    // console-side tag ADD on a previously-untagged ESM is detectable.
    let tags: Array<{ Key: string; Value: string }> = [];
    if (resp.EventSourceMappingArn) {
      try {
        const tagsResp = await this.lambdaClient.send(
          new ListTagsCommand({ Resource: resp.EventSourceMappingArn })
        );
        const tagMap = tagsResp.Tags ?? {};
        tags = Object.entries(tagMap)
          .filter(([k]) => !k.startsWith('aws:'))
          .map(([Key, Value]) => ({ Key, Value }))
          .sort((a, b) => a.Key.localeCompare(b.Key));
      } catch (err) {
        if (err instanceof ResourceNotFoundException) return undefined;
        // Permission errors etc — fall through with empty placeholder.
      }
    }
    result['Tags'] = tags;

    return result;
  }

  /**
   * Adopt an existing Lambda event source mapping into cdkd state.
   *
   * **Explicit override only.** Event source mappings are identified by a
   * UUID returned at create time. While Lambda event source mappings ARE
   * taggable since 2020, CDK does NOT propagate the `aws:cdk:path` tag to
   * them by default (the `Tags` property must be explicitly opted into),
   * and the natural lookup is by `(FunctionName, EventSourceArn)` — which
   * the user already knows.
   *
   * Users adopting an existing event source mapping should pass
   * `--resource <logicalId>=<UUID>` (matching the physical id format
   * returned by `create()`).
   */
  // eslint-disable-next-line @typescript-eslint/require-await -- explicit-override-only intentionally has no AWS calls
  async import(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    if (input.knownPhysicalId) {
      return { physicalId: input.knownPhysicalId, attributes: { Id: input.knownPhysicalId } };
    }
    return null;
  }
}
