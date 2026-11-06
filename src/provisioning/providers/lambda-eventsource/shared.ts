import { coerceCfnBoolean } from '../../config-shape.js';
import { AmbiguousCreateLatch, RecentIdSet } from '../ambiguous-create.js';

/**
 * Retry-safety state for `CreateEventSourceMapping`, which mints the mapping's
 * UUID and carries no idempotency token (issue
 * [#2080](https://github.com/go-to-k/cdkd/issues/2080)); see
 * `orphan-report.ts`. Module-scoped: a provider instance is per registry, and
 * one process can build several.
 */
export const createEventSourceMappingLatch = new AmbiguousCreateLatch(
  'lambda:CreateEventSourceMapping'
);
/** Mappings this process created and recorded, never reported as orphan candidates. */
export const mappingsCreatedByThisProcess = new RecentIdSet();

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
export type EventSourceKind =
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
 * The CFn `Enabled` a mapping in `state` will SETTLE to (go-to-k/cdkd#5737).
 *
 * `Enabled` / `Enabling` settle enabled and `Disabled` / `Disabling` settle
 * disabled. `Creating`, `Updating` and `Deleting` carry no enabled-ness: a
 * mapping created with `Enabled: false` passes through `Creating` to
 * `Disabled`, one created without it to `Enabled`, an `Updating` mapping
 * returns to whichever it was, and a `Deleting` one settles to nothing. For
 * those (and any state AWS adds later) the
 * answer is what the call that started the transition sent, i.e. the
 * `properties` bag the caller hands `readCurrentState` (the just-sent bag on
 * the post-create / post-update baseline capture, the recorded bag on a drift
 * read), with CloudFormation's absent default `true`. Reading such a state
 * as `false` made the post-create baseline record `Enabled: false` for every
 * `SqsEventSource`, and `cdkd drift --revert` then DISABLED the live mapping.
 * The cost: an out-of-band disable that lands while the mapping is still
 * `Updating` reads as the sent value until it settles; the next read reports it.
 */
export function enabledFromState(state: string, properties?: Record<string, unknown>): boolean {
  if (state === 'Enabled' || state === 'Enabling') return true;
  if (state === 'Disabled' || state === 'Disabling') return false;
  return coerceCfnBoolean(properties?.['Enabled']) ?? true;
}

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
export function classifyEventSourceFromProperties(
  properties: Record<string, unknown>
): EventSourceKind {
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
export function toSdkSelfManagedEventSource(
  selfManagedEventSource: unknown
): import('@aws-sdk/client-lambda').SelfManagedEventSource {
  return renameEndpointsKey(
    selfManagedEventSource,
    CFN_KAFKA_ENDPOINTS_KEY,
    SDK_KAFKA_ENDPOINTS_KEY
  ) as import('@aws-sdk/client-lambda').SelfManagedEventSource;
}

/** `GetEventSourceMapping` response -> CFn property shape (drift readback). */
export function toCfnSelfManagedEventSource(selfManagedEventSource: unknown): unknown {
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
export const KAFKA_CONSUMPTION_MODE_KEY = 'ConsumptionMode';
export const KAFKA_DEFAULT_CONSUMPTION_MODE = 'Stream';

/** The mode the properties ask for: the declared value, or Lambda's default. */
export function consumptionModeOf(properties: Record<string, unknown>): unknown {
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
export function replayableKafkaConfig(
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
export function kafkaConfigForUpdate(
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
export function documentDbConfigForUpdate(
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

export const KINDS_WITH_FUNCTION_RESPONSE_TYPES: ReadonlySet<EventSourceKind> = new Set([
  'sqs',
  'kinesis',
  'dynamodb',
]);
export const KINDS_WITH_SOURCE_ACCESS_CONFIGURATIONS: ReadonlySet<EventSourceKind> = new Set([
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
export const KINDS_WITH_ZERO_BATCHING_WINDOW_DEFAULT: ReadonlySet<EventSourceKind> = new Set([
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
export const KINDS_WITH_STREAM_NUMERICS: ReadonlySet<EventSourceKind> = new Set([
  'kinesis',
  'dynamodb',
]);
/**
 * Source kinds that accept `BisectBatchOnFunctionError` (Lambda API
 * reference: Kinesis, DynamoDB Streams, MSK and self-managed Kafka). Gates
 * the reset to `false` on removal (issue #1160).
 */
export const KINDS_WITH_BISECT: ReadonlySet<EventSourceKind> = new Set([
  'kinesis',
  'dynamodb',
  'kafka',
]);
/** How a removal warning names a classified source kind. */
export const EVENT_SOURCE_KIND_LABEL: Readonly<
  Record<Exclude<EventSourceKind, 'unknown'>, string>
> = {
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
export const DEFAULT_BATCH_SIZE_BY_KIND: ReadonlyMap<EventSourceKind, number> = new Map([
  ['sqs', 10],
  ['kinesis', 100],
  ['dynamodb', 100],
  ['kafka', 100],
  ['mq', 100],
  ['documentdb', 100],
]);
