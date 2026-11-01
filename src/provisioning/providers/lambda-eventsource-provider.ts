import {
  LambdaClient,
  CreateEventSourceMappingCommand,
  DeleteEventSourceMappingCommand,
  UpdateEventSourceMappingCommand,
  GetEventSourceMappingCommand,
  ListEventSourceMappingsCommand,
  ListTagsCommand,
  TagResourceCommand,
  UntagResourceCommand,
  ResourceNotFoundException,
  type EventSourcePosition,
} from '@aws-sdk/client-lambda';
import { getLogger } from '../../utils/logger.js';
import { definedAttributes } from '../attribute-map.js';
import { getAwsClients } from '../../utils/aws-clients.js';
import {
  CdkdError,
  ProvisioningError,
  ResourceUpdateNotSupportedError,
} from '../../utils/error-handler.js';
import {
  markRedactedCause,
  relayedNameCollision,
  wrapMaskedAwsError,
} from '../../deployment/retryable-errors.js';
import { assertRegionMatch, type DeleteContext } from '../region-check.js';
import type {
  CreateContext,
  ResourceProvider,
  ResourceCreateResult,
  ResourceUpdateResult,
  ResourceImportInput,
  ResourceImportResult,
  UpdateContext,
  ResourceNotFound,
} from '../../types/resource.js';
import { RESOURCE_NOT_FOUND } from '../../types/resource.js';
import { safeMsg } from '../../utils/display-safe.js';
import { lambdaFunctionNameForMask } from '../../utils/lambda-function-name.js';
import {
  planTagDiff,
  tagPlanWarning,
  refuseMalformedDesiredTags,
  DBPROXY_TAG_OPTIONS,
  DBPROXY_TAGS_WHAT,
} from '../tag-list.js';
import {
  createMaskedLogSinks,
  withDerivedNameMasks,
  type MaskedLogSinks,
  type MaskerFn,
} from '../masked-retry-logger.js';
import { ambientClientDefaults } from '../../utils/ambient-client-defaults.js';
import { pasteableAwsCommand } from '../replacement-protection-advice.js';
import {
  AmbiguousCreateLatch,
  RecentIdSet,
  replayedSendWindow,
  withoutServerErrorRetries,
  type AmbiguousCreateWindow,
} from './ambiguous-create.js';
import {
  collectOrphanIds,
  orphanCommandRegionArg,
  reportPossibleOrphans,
} from './orphan-report.js';
import { describeAwsFailure } from '../../utils/aws-failure-text.js';
import { parseCfnTimestamp } from '../../utils/cfn-timestamp.js';

/**
 * Retry-safety state for `CreateEventSourceMapping`, which mints the mapping's
 * UUID and carries no idempotency token (issue
 * [#2080](https://github.com/go-to-k/cdkd/issues/2080)); see
 * `orphan-report.ts`. Module-scoped: a provider instance is per registry, and
 * one process can build several.
 */
const createEventSourceMappingLatch = new AmbiguousCreateLatch('lambda:CreateEventSourceMapping');
/** Mappings this process created and recorded, never reported as orphan candidates. */
const mappingsCreatedByThisProcess = new RecentIdSet();

/** Reset the module-scoped retry-safety state. TEST-ONLY. */
export function resetEventSourceMappingCreateRetryStateForTests(): void {
  createEventSourceMappingLatch.resetForTests();
  mappingsCreatedByThisProcess.resetForTests();
}

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

/**
 * Captures the SERVICE segment of an ARN in ANY AWS partition (issue #1815).
 *
 * `arn:<partition>:<service>:<region>:<account>:<rest>` — group 1 is the
 * service. The partition segment is matched loosely as `aws[a-z0-9-]*`, the
 * same shape `IAM_ROLE_ARN_RE` (`src/utils/role-arn.ts`) uses, rather than
 * enumerated: this classifier previously hand-listed `aws` and `aws-cn` per
 * service and so returned `'unknown'` for every OTHER partition — GovCloud,
 * all four iso partitions and `aws-eusc` — which silently disabled the
 * type-discriminator gating below (see the `KINDS_WITH_*` sets) and let
 * `cdkd drift --revert` push `FunctionResponseTypes` / `SourceAccessConfigurations`
 * placeholders AWS rejects. A closed partition list is exactly what goes stale
 * when AWS adds a partition; reading the partition off the ARN cannot.
 *
 * Note the partition is not derived from a region via
 * `derivePartitionAndUrlSuffix` (`src/utils/aws-partition.ts`) because this
 * CLASSIFIES an ARN already in hand — the partition is in the input, and no
 * region reaches this function.
 */
const ARN_SERVICE_RE = /^arn:aws[a-z0-9-]*:([^:]+):/;

/**
 * ARN service segment -> {@link EventSourceKind}. Replaces the per-partition
 * `startsWith` chain; every entry is partition-independent by construction.
 */
const ARN_SERVICE_TO_EVENT_SOURCE_KIND: Readonly<Record<string, EventSourceKind>> = {
  sqs: 'sqs',
  kinesis: 'kinesis',
  dynamodb: 'dynamodb',
  kafka: 'kafka',
  mq: 'mq',
  // DocumentDB cluster ARNs use the `rds` service prefix. A genuine RDS source
  // is impossible here: `AWS::Lambda::EventSourceMapping` accepts no plain-RDS
  // event source, and the DocumentDB-specific arms above (which run FIRST)
  // catch the case where `DocumentDBEventSourceConfig` is present.
  rds: 'documentdb',
};

/**
 * @internal EXPORTED for tests only (issue #1815). Every production consumer is a
 * `Set.has(kind)`, so the `Object.hasOwn` guard below is UNOBSERVABLE through
 * behavior — a prototype member and `'unknown'` both miss every set. That was
 * measured, not assumed: a behavior-level test for it passed with the guard
 * reverted. Rather than ship an unverifiable guard or a test that only looks
 * like one, the classifier's RETURN VALUE is asserted directly. Do not read the
 * export as an invitation to call this from outside the provider.
 */
export function classifyEventSource(resp: {
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
  const service = ARN_SERVICE_RE.exec(arn)?.[1];
  if (!service) return 'unknown';
  // `Object.hasOwn`, not a bare index + `??`: the service segment is
  // user-controlled (it comes from the template's `EventSourceArn`), so
  // `arn:aws:constructor:...` / `:toString:` / `:hasOwnProperty:` would reach
  // `Object.prototype` and the lookup would return a FUNCTION — which `??`
  // never replaces, so `classifyEventSource` would return a function typed as
  // `EventSourceKind`. Harmless with today's four `Set.has()` consumers, which
  // is precisely why it would go unnoticed until a `switch (kind)` or a logged
  // kind met it. The `startsWith` chain this replaced had no such reach, so
  // this guard is what keeps the rewrite behavior-preserving.
  return Object.hasOwn(ARN_SERVICE_TO_EVENT_SOURCE_KIND, service)
    ? ARN_SERVICE_TO_EVENT_SOURCE_KIND[service]!
    : 'unknown';
}

/**
 * Classify an event source mapping from its CFn property bag (as opposed to
 * `classifyEventSource`, which reads an AWS `GetEventSourceMapping` response).
 * The discriminating keys are identical in both shapes (`EventSourceArn` plus
 * the four `*EventSourceConfig` / `SelfManagedEventSource` markers), so this
 * is a thin type-narrowing adapter over the same logic. Used by `update()`'s
 * removal-clear path (issues #976, #1160) to gate source-kind-specific clears
 * (`FunctionResponseTypes` / `SourceAccessConfigurations` /
 * `MaximumBatchingWindowInSeconds` / `BatchSize` / `LoggingConfig` /
 * `ProvisionedPollerConfig`).
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

/**
 * CFn spells the self-managed-Kafka bootstrap-server list
 * `SelfManagedEventSource.Endpoints.KafkaBootstrapServers`, while the SDK
 * models `Endpoints` as `Partial<Record<EndPointType, string[]>>` keyed by the
 * enum VALUE `KAFKA_BOOTSTRAP_SERVERS` (`@aws-sdk/client-lambda`
 * `EndPointType`). Because `Endpoints` is a MAP rather than a modeled
 * structure, the serializer forwards the unknown CFn key verbatim and the
 * service rejects the whole request — so every CDK `SelfManagedKafkaEventSource`
 * user hit a hard `CreateEventSourceMapping` failure (issue #1384).
 *
 * Both directions are pure key renames of the ONE diverging key; every other
 * member of the blob (both inside `Endpoints` and beside it) is copied through
 * untouched. Note that a future `EndPointType` whose CFn spelling also diverges
 * would reproduce this bug exactly — it needs its own entry here, the pass-
 * through is not a general solution.
 *
 * Anything that is not a re-shapeable object — a non-object blob, a missing or
 * non-object `Endpoints`, an array `Endpoints` — is returned VERBATIM rather
 * than dropped. Dropping would be a silent-drop regression against the raw
 * pass-through this replaced: AWS must stay the one that rejects a malformed
 * template, not this layer.
 */
const CFN_KAFKA_ENDPOINTS_KEY = 'KafkaBootstrapServers';
const SDK_KAFKA_ENDPOINTS_KEY = 'KAFKA_BOOTSTRAP_SERVERS';

function renameEndpointsKey(selfManagedEventSource: unknown, from: string, to: string): unknown {
  if (typeof selfManagedEventSource !== 'object' || selfManagedEventSource === null) {
    return selfManagedEventSource;
  }
  const source = { ...(selfManagedEventSource as Record<string, unknown>) };
  const endpoints = source['Endpoints'];
  if (typeof endpoints !== 'object' || endpoints === null || Array.isArray(endpoints)) {
    return source;
  }
  const renamed: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(endpoints as Record<string, unknown>)) {
    renamed[key === from ? to : key] = value;
  }
  source['Endpoints'] = renamed;
  return source;
}

/** CFn property bag -> `CreateEventSourceMapping` input shape. */
function toSdkSelfManagedEventSource(
  selfManagedEventSource: unknown
): import('@aws-sdk/client-lambda').SelfManagedEventSource {
  return renameEndpointsKey(
    selfManagedEventSource,
    CFN_KAFKA_ENDPOINTS_KEY,
    SDK_KAFKA_ENDPOINTS_KEY
  ) as import('@aws-sdk/client-lambda').SelfManagedEventSource;
}

/** `GetEventSourceMapping` response -> CFn property shape (drift readback). */
function toCfnSelfManagedEventSource(selfManagedEventSource: unknown): unknown {
  return renameEndpointsKey(
    selfManagedEventSource,
    SDK_KAFKA_ENDPOINTS_KEY,
    CFN_KAFKA_ENDPOINTS_KEY
  );
}

/**
 * `SelfManagedKafkaEventSourceConfig.ConsumptionMode` (`Stream` | `Queue`,
 * issue #3850) goes to `CreateEventSourceMapping` with the rest of the block.
 * Measured live 2026-11-01 in us-east-1 on a disabled self-managed Kafka mapping:
 *
 * - Lambda accepts both values, on-demand and with `ProvisionedPollerConfig`.
 *   It refuses `Queue` beside `StartingPosition` or
 *   `MaximumBatchingWindowInSeconds`; cdkd leaves that refusal to Lambda.
 * - A mapping created without the member reads back as `Stream`, so an omitted
 *   value and `Stream` are the same mode.
 * - `UpdateEventSourceMapping` refuses a change ("Updates to the
 *   ConsumptionMode parameter are not supported"), so update() never names the
 *   member and refuses the change itself. The CFn schema does not mark it
 *   create-only, so the diff layer does not replace the mapping on its own.
 */
const KAFKA_CONSUMPTION_MODE_KEY = 'ConsumptionMode';
const KAFKA_DEFAULT_CONSUMPTION_MODE = 'Stream';

/** The mode the properties ask for: the declared value, or Lambda's default. */
function consumptionModeOf(properties: Record<string, unknown>): unknown {
  const config = properties['SelfManagedKafkaEventSourceConfig'];
  if (typeof config !== 'object' || config === null || Array.isArray(config)) {
    return KAFKA_DEFAULT_CONSUMPTION_MODE;
  }
  return (
    (config as Record<string, unknown>)[KAFKA_CONSUMPTION_MODE_KEY] ??
    KAFKA_DEFAULT_CONSUMPTION_MODE
  );
}

/**
 * A create replaying a state record: drop `ConsumptionMode: Queue` from a record
 * that also holds a member Lambda refuses beside it. Only a cdkd older than
 * #3848 can have written one, with the SDK dropping the mode, so the mapping it
 * replays never ran in Queue mode, and sending the record as it is would fail a
 * rollback the user cannot fix. `undefined` when the record is sendable.
 */
function replayableKafkaConfig(
  properties: Record<string, unknown>
): Record<string, unknown> | undefined {
  if (consumptionModeOf(properties) !== 'Queue') return undefined;
  if (
    properties['StartingPosition'] === undefined &&
    properties['StartingPositionTimestamp'] === undefined &&
    properties['MaximumBatchingWindowInSeconds'] === undefined
  ) {
    return undefined;
  }
  const { [KAFKA_CONSUMPTION_MODE_KEY]: _dropped, ...rest } = properties[
    'SelfManagedKafkaEventSourceConfig'
  ] as Record<string, unknown>;
  return rest;
}

/**
 * The `UpdateEventSourceMapping` value for `SelfManagedKafkaEventSourceConfig` /
 * `AmazonManagedKafkaEventSourceConfig`, or `undefined` to send nothing
 * (issue #3851). Neither block is create-only, so CloudFormation updates it in
 * place. Measured live 2026-09-27 in us-east-1 on a disabled mapping of each
 * kind, with identical results for both blocks:
 *
 * - `ConsumerGroupId` is rejected on update even when UNCHANGED ("Unsupported
 *   '<block>.consumerGroupId' parameter"), so a template-path update sends it
 *   only when it changed, for Lambda to reject. A restore (`restoring`: a
 *   rollback replay or `drift --revert`) never sends it: AWS cannot have
 *   applied a change to it, so there is nothing to restore, and sending one
 *   would make a `rollback --revert-failed` of that very change fail forever.
 * - `SchemaRegistryConfig` is applied as sent (AWS itself requires provisioned
 *   mode and `SchemaValidationConfigs`), so it is sent only when it changed.
 * - An omitted block, and an empty block `{}`, both leave the live
 *   `SchemaRegistryConfig` in place; `{ SchemaRegistryConfig: {} }` removes it,
 *   so that is what a removal from the template sends.
 *
 * A present-but-non-object desired block is left alone rather than read as a
 * removal. `ConsumptionMode` is never named: update() refuses a change to it.
 */
function kafkaConfigForUpdate(
  desired: unknown,
  previous: unknown,
  options: { restoring: boolean }
): Record<string, unknown> | undefined {
  const asObject = (v: unknown): Record<string, unknown> | undefined =>
    typeof v === 'object' && v !== null && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : undefined;
  if (desired !== undefined && asObject(desired) === undefined) return undefined;
  const want = asObject(desired) ?? {};
  const had = asObject(previous) ?? {};
  const changed = (key: string): boolean => JSON.stringify(want[key]) !== JSON.stringify(had[key]);
  const out: Record<string, unknown> = {};
  if (!options.restoring && want['ConsumerGroupId'] !== undefined && changed('ConsumerGroupId')) {
    out['ConsumerGroupId'] = want['ConsumerGroupId'];
  }
  if (want['SchemaRegistryConfig'] !== undefined) {
    if (changed('SchemaRegistryConfig')) out['SchemaRegistryConfig'] = want['SchemaRegistryConfig'];
  } else if (had['SchemaRegistryConfig'] !== undefined) {
    out['SchemaRegistryConfig'] = {};
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** The `DocumentDBEventSourceConfig` members AWS refuses on an update. */
const DOCUMENTDB_CREATE_ONLY_KEYS = ['DatabaseName', 'CollectionName'] as const;

/**
 * What `UpdateEventSourceMapping` gets for `DocumentDBEventSourceConfig`
 * (issue #1160). A CloudFormation A/B on a DocumentDB mapping (us-east-1,
 * CloudTrail read of what CloudFormation sent) measured:
 *
 * - `UpdateEventSourceMapping` refuses `DatabaseName` and `CollectionName`,
 *   even unchanged ("Invalid parameters: databaseName"), and an empty block
 *   or a `FullDocument`-only block changes nothing else.
 * - CloudFormation sends `{ FullDocument }` alone. A changed `CollectionName`
 *   completes the stack update with the mapping still reading the old
 *   collection, and a block that drops `FullDocument` (or the whole block)
 *   sends no `DocumentDBEventSourceConfig`, so the live value stays.
 *
 * So cdkd sends `{ FullDocument }` when the template declares it, and reports
 * a changed or removed `DatabaseName` / `CollectionName` (`unchangeable`) and
 * a removed `FullDocument` (`fullDocumentKept`) for the caller to warn about.
 * `recorded` is the declared block with each unchangeable member put back to
 * its previous value, for `effectiveProperties`: state keeps what AWS still
 * holds, so the next diff reports the change again instead of going quiet.
 * A present-but-non-object block is sent as it is, for AWS to refuse.
 */
function documentDbConfigForUpdate(
  desired: unknown,
  previous: unknown
): {
  send: unknown;
  unchangeable: readonly string[];
  recorded: Record<string, unknown> | undefined;
  fullDocumentKept: boolean;
} {
  const asObject = (v: unknown): Record<string, unknown> | undefined =>
    typeof v === 'object' && v !== null && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : undefined;
  const none = { unchangeable: [], recorded: undefined, fullDocumentKept: false };
  const sendable = (want: Record<string, unknown>): unknown =>
    want['FullDocument'] !== undefined ? { FullDocument: want['FullDocument'] } : undefined;
  if (desired === undefined) return { send: undefined, ...none };
  const want = asObject(desired);
  if (want === undefined) return { send: desired, ...none };
  // A recorded block that is absent, or present but not an object (a
  // hand-edited or imported record), says nothing about what AWS holds, so
  // nothing is reported or recorded against it.
  const had = asObject(previous);
  if (had === undefined) return { send: sendable(want), ...none };
  const unchangeable = DOCUMENTDB_CREATE_ONLY_KEYS.filter(
    (key) => JSON.stringify(want[key]) !== JSON.stringify(had[key])
  );
  let recorded: Record<string, unknown> | undefined;
  if (unchangeable.length > 0) {
    recorded = { ...want };
    for (const key of unchangeable) {
      if (had[key] === undefined) delete recorded[key];
      else recorded[key] = had[key];
    }
  }
  return {
    send: sendable(want),
    unchangeable,
    recorded,
    fullDocumentKept: want['FullDocument'] === undefined && had['FullDocument'] !== undefined,
  };
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
 * Source kinds that accept `BisectBatchOnFunctionError` (Lambda API
 * reference: Kinesis, DynamoDB Streams, MSK and self-managed Kafka). Gates
 * the reset to `false` on removal (issue #1160).
 */
const KINDS_WITH_BISECT: ReadonlySet<EventSourceKind> = new Set(['kinesis', 'dynamodb', 'kafka']);
/** How a removal warning names a classified source kind. */
const EVENT_SOURCE_KIND_LABEL: Readonly<Record<Exclude<EventSourceKind, 'unknown'>, string>> = {
  sqs: 'SQS',
  kinesis: 'Kinesis',
  dynamodb: 'DynamoDB stream',
  kafka: 'Kafka',
  mq: 'Amazon MQ',
  documentdb: 'DocumentDB',
};
/**
 * The `BatchSize` a mapping falls back to when the template drops it — what
 * CloudFormation sends on that removal (issue #1160; see the restore in
 * `update()`). `unknown` has no entry, so nothing is sent for it.
 */
const DEFAULT_BATCH_SIZE_BY_KIND: ReadonlyMap<EventSourceKind, number> = new Map([
  ['sqs', 10],
  ['kinesis', 100],
  ['dynamodb', 100],
  ['kafka', 100],
  ['mq', 100],
  ['documentdb', 100],
]);

/**
 * AWS Lambda Event Source Mapping Provider
 *
 * Implements resource provisioning for AWS::Lambda::EventSourceMapping using the Lambda SDK.
 * WHY: CreateEventSourceMapping is synchronous - the CC API adds unnecessary polling overhead
 * (1s->2s->4s->8s) for an operation that completes immediately.
 */
export class LambdaEventSourceMappingProvider implements ResourceProvider {
  private lambdaClient: LambdaClient;
  private createClient: Promise<LambdaClient> | undefined;
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
        // and Update) + 3 the Update API does not take.
        // StartingPositionTimestamp is create-only in the CFn schema, so
        // the diff layer replaces the mapping on a change. Queues / Topics
        // are NOT create-only in the schema, yet CFn refuses a change
        // (issue #5356), so update() refuses it too.
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

  /**
   * Issue #1160 (`ResourceProvider.removalHandledInUpdate`): every property,
   * audited for what `update()` does when the template drops it. None is left
   * to the caller's shared line, which says CloudFormation would reset the
   * value: where cdkd keeps a value CloudFormation was not measured to keep,
   * `applyUpdate` names it in its own warning instead.
   */
  removalHandledInUpdate = new Map<string, ReadonlySet<string>>([
    [
      'AWS::Lambda::EventSourceMapping',
      new Set([
        // Required, or create-only (a removal replaces the mapping).
        'FunctionName',
        'EventSourceArn',
        'SelfManagedEventSource',
        'StartingPosition',
        'StartingPositionTimestamp',
        // A removal is a change, which update() refuses (issue #5356).
        'Queues',
        'Topics',
        // Diffed by their own calls.
        'Tags',
        'SelfManagedKafkaEventSourceConfig',
        'AmazonManagedKafkaEventSourceConfig',
        // Reset on every source kind.
        'Enabled',
        'FilterCriteria',
        'ScalingConfig',
        'DestinationConfig',
        'MetricsConfig',
        'KmsKeyArn',
        // Reset where the source kind takes the value; otherwise kept, as
        // CloudFormation keeps it (measured) or with applyUpdate's warning.
        'BatchSize',
        'MaximumBatchingWindowInSeconds',
        'MaximumRetryAttempts',
        'MaximumRecordAgeInSeconds',
        'ParallelizationFactor',
        'TumblingWindowInSeconds',
        'BisectBatchOnFunctionError',
        'FunctionResponseTypes',
        'SourceAccessConfigurations',
        'LoggingConfig',
        'ProvisionedPollerConfig',
        'DocumentDBEventSourceConfig',
      ]),
    ],
  ]);

  constructor() {
    const awsClients = getAwsClients();
    this.lambdaClient = awsClients.lambda;
  }

  /**
   * The client `CreateEventSourceMapping` goes through: SDK retries on, except
   * a 5xx (`withoutServerErrorRetries`, issue #2080). Separate so every other
   * call -- and every other provider sharing `getAwsClients().lambda` -- keeps
   * the full SDK retry. Built in the shared client's REGION (read from it, as
   * `config.region()` resolves it), so the create cannot land in another
   * region than the calls around it. The PROMISE is cached, so two creates on
   * a cold provider build one client; a rejected region read is not cached,
   * so the next create retries it.
   */
  private getCreateClient(): Promise<LambdaClient> {
    this.createClient ??= this.lambdaClient.config.region().then(
      (region) =>
        withoutServerErrorRetries(new LambdaClient({ ...ambientClientDefaults(), region })),
      (error: unknown) => {
        this.createClient = undefined;
        throw error;
      }
    );
    return this.createClient;
  }

  /**
   * The masked sinks ONE `create()` / `update()` / `delete()` logs and
   * refuses through
   * (issue #2177, `.claude/rules/provider-masking.md`): `createMaskedLogSinks`
   * over the context's masker, extended by `withDerivedNameMasks` so a short
   * secret-derived `FunctionName`, or the bare name inside a secret ARN, is
   * masked where AWS quotes it back. The
   * physical id is an AWS-assigned UUID, so no recorded name needs a needle.
   * Built per call; never cached on the provider, which serves concurrent
   * resources.
   */
  private operationSinks(
    maskSecrets: MaskerFn | undefined,
    properties: Record<string, unknown>,
    previousProperties?: Record<string, unknown>
  ): MaskedLogSinks {
    // `FunctionName` is mutable in place, so on update() the previous side
    // names a function AWS may still quote. Each as written and by its bare
    // name: AWS may quote the function by name, not by ARN.
    const pairs: Array<readonly [unknown, string | undefined]> = [];
    for (const raw of [properties['FunctionName'], previousProperties?.['FunctionName']]) {
      if (typeof raw !== 'string') continue;
      pairs.push([raw, raw], [raw, lambdaFunctionNameForMask(raw)]);
    }
    return withDerivedNameMasks(this.logger, createMaskedLogSinks(this.logger, maskSecrets), pairs);
  }

  /**
   * The `create()` / `update()` / `delete()` failure wrap. A method, so
   * `gen-update-wrap-coverage` sees the catch that throws it as a wrap.
   *
   * An AWS-authored failure reaches `build` as its CLASS plus the `--verbose`
   * pointer (go-to-k/cdkd#2319): a thrown message is persisted to
   * `deployments/{runId}.jsonl`, and an `AccessDeniedException` names the
   * caller's assumed-role ARN. AWS's own text, which can quote a rejected
   * request value back (a source
   * ARN, a Kafka bootstrap server, a filter pattern), goes to `debug` through `log`,
   * masked both raw and as the finished line (issue #2177). The wrap is stamped
   * `markRedactedCause`, so retry classification reads the withheld text on the
   * `cause` chain. An "already exists" is restated ({@link relayedNameCollision}).
   * A cdkd-authored or transport error keeps the masked pass-through of the
   * shared `wrapMaskedAwsError`, which stamps when the mask changed the text
   * (the #4244 class); a non-`Error` throw keeps its masked text, unstamped.
   * The delete checks `ResourceNotFoundException` by type before it wraps.
   *
   * `build` must thread `error` as `cause`, and runs twice, so it must stay a
   * side-effect-free constructor call.
   */
  private wrapMaskedError(
    log: MaskedLogSinks,
    error: unknown,
    build: (maskedText: string) => ProvisioningError
  ): ProvisioningError {
    const failure = describeAwsFailure(error);
    if (!(error instanceof Error)) return build(log.mask(failure.detail));
    if (!failure.redacted) return wrapMaskedAwsError(log.mask, error, build);
    log.debug(build(log.mask(failure.detail)).message);
    return markRedactedCause(
      build(`${log.mask(failure.summary)}${relayedNameCollision(failure.detail)}`)
    );
  }

  /**
   * Create a Lambda Event Source Mapping
   */
  async create(
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
  private async reportPossibleMappingOrphans(
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
  async update(
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

  private async applyUpdate(
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
  private async applyTagDiff(
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
      log.debug(
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
    properties?: Record<string, unknown>,
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
      throw this.wrapMaskedError(
        this.operationSinks(context?.maskSecrets, properties ?? {}),
        error,
        (text) =>
          new ProvisioningError(
            `Failed to delete event source mapping ${logicalId}: ${text}`,
            resourceType,
            logicalId,
            physicalId,
            cause
          )
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
   * Returns `RESOURCE_NOT_FOUND` when the mapping is gone
   * (`ResourceNotFoundException`).
   */
  async readCurrentState(
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
        // The mapping vanished between GetEventSourceMapping and ListTags.
        if (err instanceof ResourceNotFoundException) return RESOURCE_NOT_FOUND;
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
  /**
   * An `observedProperties` baseline a cdkd older than #3850 wrote lacks
   * `ConsumptionMode`, because the SDK dropped it from the readback, while the
   * live block now carries it. Complete such a baseline from the readback when
   * the mode is `Stream` and the template agrees, so an upgrade alone reports no
   * drift. A live `Queue` stays a finding.
   */
  async canonicalizeDriftPair(
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

  async import(input: ResourceImportInput): Promise<ResourceImportResult | null> {
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
}
