import {
  UpdateEventSourceMappingCommand,
  TagResourceCommand,
  UntagResourceCommand,
} from '@aws-sdk/client-lambda';
import type { LambdaEventSourceMappingProvider } from '../lambda-eventsource-provider.js';
import {
  CdkdError,
  ProvisioningError,
  ResourceUpdateNotSupportedError,
} from '../../../utils/error-handler.js';
import type { ResourceUpdateResult, UpdateContext } from '../../../types/resource.js';
import { safeMsg } from '../../../utils/display-safe.js';
import {
  planTagDiff,
  tagPlanWarning,
  refuseMalformedDesiredTags,
  DBPROXY_TAG_OPTIONS,
  DBPROXY_TAGS_WHAT,
} from '../../tag-list.js';
import type { MaskedLogSinks } from '../../masked-retry-logger.js';
import {
  classifyEventSourceFromProperties,
  consumptionModeOf,
  DEFAULT_BATCH_SIZE_BY_KIND,
  documentDbConfigForUpdate,
  EVENT_SOURCE_KIND_LABEL,
  KAFKA_CONSUMPTION_MODE_KEY,
  kafkaConfigForUpdate,
  KINDS_WITH_BISECT,
  KINDS_WITH_FUNCTION_RESPONSE_TYPES,
  KINDS_WITH_SOURCE_ACCESS_CONFIGURATIONS,
  KINDS_WITH_STREAM_NUMERICS,
  KINDS_WITH_ZERO_BATCHING_WINDOW_DEFAULT,
} from './shared.js';

/**
 * Update a Lambda Event Source Mapping
 *
 * Thin wrapper that maps any AWS SDK failure onto {@link ProvisioningError}
 * the same way {@link create} and {@link delete} do, so an update failure
 * carries cdkd's typed error formatting and exit-code handling instead of
 * surfacing raw (issue #1267). The body lives in {@link applyUpdate} so the
 * wrap is a boundary concern rather than a large indentation change.
 *
 * A typed control-flow error is re-thrown untouched: the deploy engine
 * matches those by class to decide its fallback, so swallowing one into a
 * ProvisioningError would silently disable that path.
 */
export async function update(
  this: LambdaEventSourceMappingProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>,
  context?: UpdateContext
): Promise<ResourceUpdateResult> {
  // Issue #2177: every update() line and failure goes through this one sink
  // set.
  const log = this.operationSinks(context?.maskSecrets, properties, previousProperties);
  // go-to-k/cdkd#3994: a malformed desired Tags is refused before any call;
  // a Value-less entry is accepted, as in create().
  refuseMalformedDesiredTags(
    properties['Tags'],
    resourceType,
    logicalId,
    physicalId,
    'Tags',
    DBPROXY_TAGS_WHAT,
    DBPROXY_TAG_OPTIONS
  );
  // Issue #5356: UpdateEventSourceMapping takes no Queues / Topics, and
  // CloudFormation refuses a change to either ("Parameter 'Topics' can not
  // be updated", measured on a self-managed Kafka mapping) rather than
  // replacing the mapping, since the schema does not mark them create-only.
  // Refused before the first AWS call on the template path, so the change is
  // not silently dropped; `--replace` opts into a delete + create. Warned on
  // a state replay or a drift revert, which restore a recorded or read-back
  // configuration this update cannot carry either way.
  const restoring = context?.replayingState === true || context?.desiredFromAwsReadback === true;
  const refuseChange = (reason: string): void => {
    if (!restoring) {
      throw new ResourceUpdateNotSupportedError(
        resourceType,
        logicalId,
        `${reason}; deploy with --replace to delete and recreate the mapping`
      );
    }
    log.warn(
      safeMsg`AWS::Lambda::EventSourceMapping ${logicalId}: ${reason}. Proceeding without it: this update restores a recorded or read-back configuration.`
    );
  };
  for (const key of ['Queues', 'Topics'] as const) {
    if (JSON.stringify(properties[key]) === JSON.stringify(previousProperties[key])) continue;
    refuseChange(
      `${key} cannot be changed on an existing event source mapping ` +
        `(UpdateEventSourceMapping does not take it, and CloudFormation refuses the change too)`
    );
  }
  if (
    JSON.stringify(consumptionModeOf(properties)) !==
    JSON.stringify(consumptionModeOf(previousProperties))
  ) {
    refuseChange(
      `SelfManagedKafkaEventSourceConfig.${KAFKA_CONSUMPTION_MODE_KEY} cannot be changed on an ` +
        `existing event source mapping (UpdateEventSourceMapping refuses it)`
    );
  }
  try {
    return await this.applyUpdate(
      logicalId,
      physicalId,
      resourceType,
      properties,
      previousProperties,
      log,
      restoring
    );
  } catch (error) {
    // Pass through every cdkd-typed error untouched: ResourceUpdateNotSupportedError
    // is control flow the deploy engine matches BY CLASS, and a ProvisioningError
    // raised deeper in the body already carries better context than a re-wrap.
    if (error instanceof CdkdError) throw error;
    const cause = error instanceof Error ? error : undefined;
    throw this.wrapMaskedError(
      log,
      error,
      (text) =>
        new ProvisioningError(
          `Failed to update event source mapping ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          physicalId,
          cause
        )
    );
  }
}

export async function applyUpdate(
  this: LambdaEventSourceMappingProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>,
  log: MaskedLogSinks,
  restoring: boolean
): Promise<ResourceUpdateResult> {
  log.debug(`Updating event source mapping ${logicalId}: ${physicalId}`);
  // A removal warning names the template, except where the desired bag is a
  // restored record or readback: there the key is one the later state added.
  const removed = (one = true): string =>
    restoring
      ? `${one ? 'is' : 'are'} absent from the configuration being restored`
      : `${one ? 'was' : 'were'} removed from the template`;

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
  if (properties['Enabled'] !== undefined) updateParams.Enabled = properties['Enabled'] as boolean;
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
  const documentDb = documentDbConfigForUpdate(
    properties['DocumentDBEventSourceConfig'],
    previousProperties['DocumentDBEventSourceConfig']
  );
  if (documentDb.send !== undefined)
    updateParams.DocumentDBEventSourceConfig =
      documentDb.send as import('@aws-sdk/client-lambda').DocumentDBEventSourceConfig;
  if (documentDb.unchangeable.length > 0)
    log.warn(
      safeMsg`${logicalId} (${resourceType}): DocumentDBEventSourceConfig.${documentDb.unchangeable.join(' / ')} cannot be changed on an existing event source mapping (UpdateEventSourceMapping refuses it, and CloudFormation leaves it as it is), so the mapping keeps reading its current ${documentDb.unchangeable.length === 1 ? 'value' : 'values'}. To read another database or collection, remove the mapping, deploy, then add it back.`
    );
  if (documentDb.fullDocumentKept)
    log.warn(
      safeMsg`${logicalId} (${resourceType}): DocumentDBEventSourceConfig.FullDocument ${removed()}; the mapping keeps its current value, as CloudFormation keeps it. Declare FullDocument: Default to turn the full-document lookup off.`
    );
  // Kafka config blocks (issue #3851): only the members that changed, and the
  // documented reset for a removed SchemaRegistryConfig.
  for (const key of [
    'SelfManagedKafkaEventSourceConfig',
    'AmazonManagedKafkaEventSourceConfig',
  ] as const) {
    const block = kafkaConfigForUpdate(properties[key], previousProperties[key], {
      restoring,
    });
    if (block !== undefined) updateParams[key] = block;
  }
  // #609 backfill — the 4 mutable props. Queues / Topics /
  // StartingPositionTimestamp are not forwarded: the Update API does not
  // take them. A Queues / Topics change was refused in update(); a
  // StartingPositionTimestamp change is a replacement (create-only).
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
  if (wasSet('SourceAccessConfigurations') && KINDS_WITH_SOURCE_ACCESS_CONFIGURATIONS.has(prevKind))
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
  // kinds the field is left untouched, as CloudFormation leaves it (issue
  // #1160 CFn A/B: a self-managed Kafka mapping kept `3` after removal).
  if (
    wasSet('MaximumBatchingWindowInSeconds') &&
    KINDS_WITH_ZERO_BATCHING_WINDOW_DEFAULT.has(prevKind)
  )
    updateParams.MaximumBatchingWindowInSeconds = 0;

  // Issue #1160: a CloudFormation A/B (us-east-1, CloudTrail read of the
  // UpdateEventSourceMapping request CloudFormation sent) measured what a
  // removal resets, per source kind:
  //   - BatchSize: the kind's default — `10` for SQS, `100` for DynamoDB
  //     and self-managed Kafka (both measured); Kinesis / MQ / DocumentDB
  //     take `100` per the Lambda API reference. An `unknown` kind sends
  //     nothing, since no default can be named for it.
  //   - LoggingConfig / ProvisionedPollerConfig on a Kafka mapping: `{}`,
  //     which clears both (the readback shows neither afterwards). Measured
  //     on self-managed Kafka; MSK shares the `kafka` kind and is assumed
  //     to behave the same.
  //   - ProvisionedPollerConfig on an SQS mapping: CloudFormation sends
  //     nothing and the poller config stays, so cdkd leaves it too.
  //   (LoggingConfig is Kafka-only: AWS refuses it on an SQS mapping.)
  if (wasSet('BatchSize')) {
    const defaultBatchSize = DEFAULT_BATCH_SIZE_BY_KIND.get(prevKind);
    if (defaultBatchSize !== undefined) updateParams.BatchSize = defaultBatchSize;
  }
  if (prevKind === 'kafka') {
    if (wasSet('LoggingConfig')) updateParams.LoggingConfig = {};
    if (wasSet('ProvisionedPollerConfig')) updateParams.ProvisionedPollerConfig = {};
  }

  // Issue #1160, second CloudFormation A/B (us-east-1, 2026-10-27): removing
  // `Enabled: false` from an SQS mapping turned it back on (State
  // `Enabled`), and removing `BisectBatchOnFunctionError: true` from a
  // DynamoDB-stream mapping read back `false`. Both are the documented
  // defaults. `Enabled` applies to every source kind. Bisect is accepted by
  // the stream kinds and Kafka only, so the reset is gated the same way.
  if (wasSet('Enabled')) updateParams.Enabled = true;
  if (wasSet('BisectBatchOnFunctionError')) {
    // Kafka / MSK take the Bisect / retry error-handling parameters in
    // provisioned mode only (Lambda API reference; not measured by an A/B).
    // When this update leaves provisioned mode (ProvisionedPollerConfig is
    // no longer declared, so it is cleared above with `{}`), `false` could
    // make AWS refuse the WHOLE call and take every other removal reset with
    // it. So reset it only while provisioned mode stays declared.
    const kafkaWithoutProvisionedMode =
      prevKind === 'kafka' && properties['ProvisionedPollerConfig'] === undefined;
    if (KINDS_WITH_BISECT.has(prevKind) && !kafkaWithoutProvisionedMode)
      updateParams.BisectBatchOnFunctionError = false;
    else if (kafkaWithoutProvisionedMode)
      log.warn(
        safeMsg`${logicalId} (${resourceType}): BisectBatchOnFunctionError ${removed()} while the Kafka mapping does not declare ProvisionedPollerConfig, so cdkd does not reset it (Kafka takes it in provisioned mode only) and the current AWS value is kept.`
      );
    // A source cdkd cannot classify gets no reset (`false` may be refused
    // there), so name the kept value rather than drop the removal silently.
    else if (prevKind === 'unknown')
      log.warn(
        safeMsg`${logicalId} (${resourceType}): BisectBatchOnFunctionError ${removed()}, but cdkd cannot tell this mapping's source kind, so the current AWS value is kept. Declare BisectBatchOnFunctionError: false to turn it off.`
      );
  }

  // Issue #1160 (the type is in `removalHandledInUpdate`, so the caller
  // names no removal itself): every removal the arms above leave alone on a
  // source kind where CloudFormation's answer was not measured. Kept
  // silently only where the A/B showed CloudFormation keeps it too: an SQS
  // mapping's ProvisionedPollerConfig and a Kafka mapping's batching window.
  const kept: string[] = [];
  // Issue #1160, third CloudFormation A/B (us-east-1, 2026-10-28, a
  // self-managed Kafka mapping in provisioned mode): removing
  // `MaximumRetryAttempts: 3` / `MaximumRecordAgeInSeconds: 3600` while
  // ProvisionedPollerConfig stayed declared read back 3 / 3600, as
  // CloudFormation sent neither. cdkd keeps them too and says so. MSK shares
  // the `kafka` kind and is assumed to match. When the update enters or
  // leaves provisioned mode, CloudFormation's answer is not measured, so the
  // general kept line below names them instead.
  const keptAsCfnKeeps: string[] = [];
  const kafkaStaysProvisioned =
    prevKind === 'kafka' &&
    previousProperties['ProvisionedPollerConfig'] !== undefined &&
    properties['ProvisionedPollerConfig'] !== undefined;
  if (wasSet('BatchSize') && !DEFAULT_BATCH_SIZE_BY_KIND.has(prevKind)) kept.push('BatchSize');
  if (
    wasSet('MaximumBatchingWindowInSeconds') &&
    !KINDS_WITH_ZERO_BATCHING_WINDOW_DEFAULT.has(prevKind) &&
    prevKind !== 'kafka'
  )
    kept.push('MaximumBatchingWindowInSeconds');
  if (!KINDS_WITH_STREAM_NUMERICS.has(prevKind)) {
    for (const key of [
      'MaximumRetryAttempts',
      'MaximumRecordAgeInSeconds',
      'ParallelizationFactor',
      'TumblingWindowInSeconds',
    ]) {
      if (!wasSet(key)) continue;
      const measuredKeep =
        kafkaStaysProvisioned &&
        (key === 'MaximumRetryAttempts' || key === 'MaximumRecordAgeInSeconds');
      (measuredKeep ? keptAsCfnKeeps : kept).push(key);
    }
  }
  if (keptAsCfnKeeps.length > 0) {
    const one = keptAsCfnKeeps.length === 1;
    log.warn(
      safeMsg`${logicalId} (${resourceType}): ${one ? 'property' : 'properties'} ${keptAsCfnKeeps.join(', ')} ${removed(one)}; the Kafka mapping keeps its current ${one ? 'value' : 'values'}, as CloudFormation keeps ${one ? 'it' : 'them'}. Declare -1 for no limit instead.`
    );
  }
  if (wasSet('FunctionResponseTypes') && !KINDS_WITH_FUNCTION_RESPONSE_TYPES.has(prevKind))
    kept.push('FunctionResponseTypes');
  if (
    wasSet('SourceAccessConfigurations') &&
    !KINDS_WITH_SOURCE_ACCESS_CONFIGURATIONS.has(prevKind)
  )
    kept.push('SourceAccessConfigurations');
  if (prevKind !== 'kafka') {
    if (wasSet('LoggingConfig')) kept.push('LoggingConfig');
    if (wasSet('ProvisionedPollerConfig') && prevKind !== 'sqs')
      kept.push('ProvisionedPollerConfig');
  }
  if (kept.length > 0) {
    const one = kept.length === 1;
    const source =
      prevKind === 'unknown'
        ? 'a mapping whose source kind cdkd cannot tell'
        : `this ${EVENT_SOURCE_KIND_LABEL[prevKind]} mapping`;
    log.warn(
      safeMsg`${logicalId} (${resourceType}): ${one ? 'property' : 'properties'} ${kept.join(', ')} ${removed(one)}; cdkd keeps the current AWS ${one ? 'value' : 'values'} on ${source}, since what CloudFormation resets there is not measured. Declare the ${one ? 'value' : 'values'} you want instead.`
    );
  }

  // A removed `DocumentDBEventSourceConfig` keeps the live block: the A/B
  // in `documentDbConfigForUpdate` saw CloudFormation send nothing for it.
  // cdkd sends nothing either, and says so, since the user who dropped it
  // may expect a change.
  if (wasSet('DocumentDBEventSourceConfig'))
    log.warn(
      safeMsg`${logicalId} (${resourceType}): DocumentDBEventSourceConfig ${removed()}; the mapping keeps its current DocumentDB settings, as CloudFormation keeps them. Declare the block with the values you want instead.`
    );

  const updateResp = await this.lambdaClient.send(
    new UpdateEventSourceMappingCommand(updateParams)
  );

  // Apply tag diff. UpdateEventSourceMapping does not accept Tags; use
  // TagResource / UntagResource against the EventSourceMapping ARN.
  const eventSourceMappingArn = updateResp.EventSourceMappingArn;
  if (eventSourceMappingArn) {
    await this.applyTagDiff(
      eventSourceMappingArn,
      resourceType,
      logicalId,
      previousProperties['Tags'],
      properties['Tags'],
      log
    );
  }

  log.debug(`Successfully updated event source mapping ${logicalId}`);

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
    ...(documentDb.recorded !== undefined && {
      effectiveProperties: {
        ...properties,
        DocumentDBEventSourceConfig: documentDb.recorded,
      },
    }),
  };
}

/**
 * Apply a diff between old and new CFn-shape Tags arrays via Lambda's
 * `TagResource` / `UntagResource` APIs against the EventSourceMapping
 * ARN. Lambda's `TagResource` takes `{ Resource, Tags: { key: value } }`;
 * `UntagResource` takes `{ Resource, TagKeys: [...] }`. Both sides are
 * read through `planTagDiff` (go-to-k/cdkd#3994): an unreadable record
 * untags nothing.
 */
export async function applyTagDiff(
  this: LambdaEventSourceMappingProvider,
  arn: string,
  resourceType: string,
  logicalId: string,
  oldTagsRaw: unknown,
  newTagsRaw: unknown,
  log: MaskedLogSinks
): Promise<void> {
  const plan = planTagDiff(oldTagsRaw, newTagsRaw, DBPROXY_TAG_OPTIONS);
  const tagWarning = tagPlanWarning(plan, resourceType, logicalId);
  if (tagWarning !== undefined) {
    log.warn(tagWarning);
  }
  const tagsToAdd = Object.fromEntries(plan.set);
  const tagsToRemove = plan.remove;

  if (tagsToRemove.length > 0) {
    await this.lambdaClient.send(
      new UntagResourceCommand({ Resource: arn, TagKeys: tagsToRemove })
    );
    log.debug(`Removed ${tagsToRemove.length} tag(s) from EventSourceMapping ${arn}`);
  }
  if (Object.keys(tagsToAdd).length > 0) {
    await this.lambdaClient.send(new TagResourceCommand({ Resource: arn, Tags: tagsToAdd }));
    log.debug(`Added/updated ${Object.keys(tagsToAdd).length} tag(s) on EventSourceMapping ${arn}`);
  }
}
