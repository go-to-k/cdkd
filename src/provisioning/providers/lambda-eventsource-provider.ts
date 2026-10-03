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
import { CdkdError, ProvisioningError } from '../../utils/error-handler.js';
import { wrapMaskedAwsError } from '../../deployment/retryable-errors.js';
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
import { planTagDiff, tagPlanWarning, refuseMalformedDesiredTags } from '../tag-list.js';
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
  withoutServerErrorRetries,
  type AmbiguousCreateWindow,
} from './ambiguous-create.js';
import {
  collectOrphanIds,
  orphanCommandRegionArg,
  reportPossibleOrphans,
} from './orphan-report.js';

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
 * `SelfManagedKafkaEventSourceConfig.ConsumptionMode` (`Stream` | `Queue`) is in
 * the CFn registry schema but in no `@aws-sdk/client-lambda` release yet
 * (installed 3.1135.0, latest published 3.1141.0, issue #3848). The SDK v3
 * serializer drops members it does not model, so a forwarded value never
 * reaches Lambda: create() would build a mapping without the requested mode and
 * report success, and update() (see {@link kafkaConfigForUpdate}) never names it.
 *
 * Deliberate parity divergence: CloudFormation forwards the member, cdkd
 * refuses it on the template path. No shape of it can be delivered through the
 * SDK — measured 2026-09-26 by serializing, offline, a
 * `CreateEventSourceMappingCommand` carrying `ConsumptionMode: 'Queue'`; the
 * request body held `ConsumerGroupId` only. Cloud Control (CloudFormation's own
 * handler, and cdkd's `--recreate-via-cc-api` route) is no alternative either:
 * probed live 2026-09-27 in us-east-1 on a disabled self-managed Kafka mapping,
 * Lambda rejected `Stream` and `Queue`, on-demand and with
 * `ProvisionedPollerConfig`, every time with "Unsupported 'ConsumptionMode'
 * parameter for given event source mapping type".
 * `tests/unit/provisioning/sdk-pending-members.test.ts` goes red once the
 * installed client sends the member. Lifting the refusal then also needs
 * {@link kafkaConfigForUpdate} to send it, plus the readback (issue #3850);
 * forwarding it on create alone reopens the drop on update.
 */
const KAFKA_CONSUMPTION_MODE_KEY = 'ConsumptionMode';

/** The declared `ConsumptionMode`, or `undefined` when the template omits it. */
function declaredConsumptionMode(properties: Record<string, unknown>): unknown {
  const config = properties['SelfManagedKafkaEventSourceConfig'];
  if (typeof config !== 'object' || config === null || Array.isArray(config)) return undefined;
  return (config as Record<string, unknown>)[KAFKA_CONSUMPTION_MODE_KEY];
}

function consumptionModeRefusalMessage(logicalId: string, mode: 'create' | 'update'): string {
  return (
    `AWS::Lambda::EventSourceMapping ${logicalId}: ` +
    `SelfManagedKafkaEventSourceConfig.${KAFKA_CONSUMPTION_MODE_KEY} cannot be sent by cdkd yet — ` +
    `the AWS SDK for JavaScript does not model the member, so it would be dropped from the ` +
    `${mode === 'create' ? 'CreateEventSourceMapping' : 'UpdateEventSourceMapping'} request ` +
    `without an error (issue #3848). ` +
    `Remove ${KAFKA_CONSUMPTION_MODE_KEY} from ` +
    `SelfManagedKafkaEventSourceConfig to deploy the mapping without it.`
  );
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
 * removal. `ConsumptionMode` is never named: it is refused before this runs.
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
   * The masked sinks ONE `create()` / `update()` logs and refuses through
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
   * A `create()` / `update()` failure wrap quoting the caught error's text
   * masked (issue #2177): AWS quotes a rejected request value back (a source
   * ARN, a Kafka bootstrap server, a filter pattern). The `cause` stays
   * unmasked, and a message the mask changed is stamped so the retry
   * classifiers read that chain (`wrapMaskedAwsError`, issue #4244). A
   * method, so `gen-update-wrap-coverage` sees the catch that throws it as a
   * wrap.
   */
  private wrapMaskedError(
    mask: MaskerFn,
    error: unknown,
    build: (maskedText: string) => ProvisioningError
  ): ProvisioningError {
    return wrapMaskedAwsError(mask, error, build);
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
    // go-to-k/cdkd#3994: a malformed Tags is refused before any call.
    const desiredTags = refuseMalformedDesiredTags(properties['Tags'], resourceType, logicalId);

    const functionName = properties['FunctionName'] as string;
    if (!functionName) {
      throw new ProvisioningError(
        `FunctionName is required for event source mapping ${logicalId}`,
        resourceType,
        logicalId
      );
    }

    // Outside the `try` so the typed refusal is not re-wrapped below. A state
    // replay only warns: the record's value was dropped the same way when it
    // was first deployed, so the restored mapping matches what it replaces.
    if (declaredConsumptionMode(properties) !== undefined) {
      const message = consumptionModeRefusalMessage(logicalId, 'create');
      if (context?.replayingState !== true) {
        throw new ProvisioningError(message, resourceType, logicalId);
      }
      log.warn(safeMsg`${message} Proceeding without it: this create replays a cdkd state record.`);
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
        params.SelfManagedEventSource = toSdkSelfManagedEventSource(
          properties['SelfManagedEventSource']
        );
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
        params.Tags = Object.fromEntries(desiredTags.map((t) => [t.Key, t.Value]));
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
        log.mask,
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
    // go-to-k/cdkd#3994: a malformed desired Tags is refused before any call.
    refuseMalformedDesiredTags(properties['Tags'], resourceType, logicalId, physicalId);
    // update() never names ConsumptionMode (kafkaConfigForUpdate), so only a
    // CHANGED value is lost; an unchanged one (a record an older cdkd wrote)
    // sends nothing either way. Refused before the first AWS call on the
    // template path, warned on a state replay or a drift revert.
    const desiredMode = declaredConsumptionMode(properties);
    if (
      desiredMode !== undefined &&
      JSON.stringify(desiredMode) !== JSON.stringify(declaredConsumptionMode(previousProperties))
    ) {
      const message = consumptionModeRefusalMessage(logicalId, 'update');
      if (context?.replayingState !== true && context?.desiredFromAwsReadback !== true) {
        throw new ProvisioningError(message, resourceType, logicalId, physicalId);
      }
      log.warn(
        safeMsg`${message} Proceeding without it: this update restores a recorded or read-back configuration.`
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
        context
      );
    } catch (error) {
      // Pass through every cdkd-typed error untouched: ResourceUpdateNotSupportedError
      // is control flow the deploy engine matches BY CLASS, and a ProvisioningError
      // raised deeper in the body already carries better context than a re-wrap.
      if (error instanceof CdkdError) throw error;
      const cause = error instanceof Error ? error : undefined;
      throw this.wrapMaskedError(
        log.mask,
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
    context?: UpdateContext
  ): Promise<ResourceUpdateResult> {
    log.debug(`Updating event source mapping ${logicalId}: ${physicalId}`);

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
    // Kafka config blocks (issue #3851): only the members that changed, and the
    // documented reset for a removed SchemaRegistryConfig.
    for (const key of [
      'SelfManagedKafkaEventSourceConfig',
      'AmazonManagedKafkaEventSourceConfig',
    ] as const) {
      const block = kafkaConfigForUpdate(properties[key], previousProperties[key], {
        restoring: context?.replayingState === true || context?.desiredFromAwsReadback === true,
      });
      if (block !== undefined) updateParams[key] = block;
    }
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
    const plan = planTagDiff(oldTagsRaw, newTagsRaw);
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
