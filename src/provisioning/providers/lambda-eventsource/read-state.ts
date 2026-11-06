import {
  GetEventSourceMappingCommand,
  ListTagsCommand,
  ResourceNotFoundException,
} from '@aws-sdk/client-lambda';
import type { LambdaEventSourceMappingProvider } from '../lambda-eventsource-provider.js';
import { definedAttributes } from '../../attribute-map.js';
import type {
  ResourceImportInput,
  ResourceImportResult,
  ResourceNotFound,
} from '../../../types/resource.js';
import { RESOURCE_NOT_FOUND } from '../../../types/resource.js';
import {
  classifyEventSource,
  consumptionModeOf,
  enabledFromState,
  KAFKA_CONSUMPTION_MODE_KEY,
  KAFKA_DEFAULT_CONSUMPTION_MODE,
  KINDS_WITH_FUNCTION_RESPONSE_TYPES,
  KINDS_WITH_SOURCE_ACCESS_CONFIGURATIONS,
  toCfnSelfManagedEventSource,
} from './shared.js';

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
 * Returns `RESOURCE_NOT_FOUND` when the mapping is gone
 * (`ResourceNotFoundException`).
 */
export async function readCurrentState(
  this: LambdaEventSourceMappingProvider,
  physicalId: string,
  _logicalId: string,
  _resourceType: string,
  properties?: Record<string, unknown>
): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
  let resp;
  try {
    resp = await this.lambdaClient.send(new GetEventSourceMappingCommand({ UUID: physicalId }));
  } catch (err) {
    if (err instanceof ResourceNotFoundException) return RESOURCE_NOT_FOUND;
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
    // Inverse of the create-side rename: state holds the CFn spelling
    // (`Endpoints.KafkaBootstrapServers`), so emitting the SDK's
    // `KAFKA_BOOTSTRAP_SERVERS` here would fire guaranteed drift on every
    // clean run of a self-managed-Kafka ESM (issue #1384).
    result['SelfManagedEventSource'] = toCfnSelfManagedEventSource(resp.SelfManagedEventSource);
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

  if (resp.State !== undefined) result['Enabled'] = enabledFromState(resp.State, properties);

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
      // The mapping vanished between GetEventSourceMapping and ListTags.
      if (err instanceof ResourceNotFoundException) return RESOURCE_NOT_FOUND;
      // Permission errors etc — fall through with empty placeholder.
    }
  }
  result['Tags'] = tags;

  return result;
}

/**
 * An `observedProperties` baseline a cdkd older than #3850 wrote lacks
 * `ConsumptionMode`, because the SDK dropped it from the readback, while the
 * live block now carries it. Complete such a baseline from the readback when
 * the mode is `Stream` and the template agrees, so an upgrade alone reports no
 * drift. A live `Queue` stays a finding.
 */
export async function canonicalizeDriftPair(
  this: LambdaEventSourceMappingProvider,
  _resourceType: string,
  baseline: Record<string, unknown>,
  aws: Record<string, unknown>,
  properties?: Record<string, unknown>
): Promise<{ baseline: Record<string, unknown>; aws: Record<string, unknown> }> {
  const key = 'SelfManagedKafkaEventSourceConfig';
  const block = baseline[key];
  if (
    typeof block !== 'object' ||
    block === null ||
    Array.isArray(block) ||
    KAFKA_CONSUMPTION_MODE_KEY in block ||
    consumptionModeOf(aws) !== KAFKA_DEFAULT_CONSUMPTION_MODE ||
    consumptionModeOf(properties ?? {}) !== KAFKA_DEFAULT_CONSUMPTION_MODE ||
    (aws[key] as Record<string, unknown> | undefined)?.[KAFKA_CONSUMPTION_MODE_KEY] === undefined
  ) {
    return { baseline, aws };
  }
  return {
    baseline: {
      ...baseline,
      [key]: { ...block, [KAFKA_CONSUMPTION_MODE_KEY]: KAFKA_DEFAULT_CONSUMPTION_MODE },
    },
    aws,
  };
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
export async function importImpl(
  this: LambdaEventSourceMappingProvider,
  input: ResourceImportInput
): Promise<ResourceImportResult | null> {
  if (!input.knownPhysicalId) return null;
  // Issue #3627: read back `EventSourceMappingArn`, which `create()` records
  // and the resolver cannot build from the UUID, so a sibling's
  // `Fn::GetAtt [Esm, EventSourceMappingArn]` resolves after an import.
  let resp;
  try {
    resp = await this.lambdaClient.send(
      new GetEventSourceMappingCommand({ UUID: input.knownPhysicalId })
    );
  } catch (err) {
    if (err instanceof ResourceNotFoundException) return null;
    throw err;
  }
  return {
    physicalId: input.knownPhysicalId,
    attributes: definedAttributes({
      Id: input.knownPhysicalId,
      EventSourceMappingArn: resp.EventSourceMappingArn,
    }),
  };
}
