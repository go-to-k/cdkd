import { LambdaClient } from '@aws-sdk/client-lambda';
import { getLogger, type ConsoleLogger } from '../../utils/logger.js';
import { getAwsClients } from '../../utils/aws-clients.js';
import { ProvisioningError } from '../../utils/error-handler.js';
import {
  markRedactedCause,
  relayedNameCollision,
  wrapMaskedAwsError,
} from '../../deployment/retryable-errors.js';
import type { DeleteContext } from '../region-check.js';
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
import { lambdaFunctionNameForMask } from '../../utils/lambda-function-name.js';
import {
  createMaskedLogSinks,
  withDerivedNameMasks,
  type MaskedLogSinks,
  type MaskerFn,
} from '../masked-retry-logger.js';
import { ambientClientDefaults } from '../../utils/ambient-client-defaults.js';
import { withoutServerErrorRetries, type AmbiguousCreateWindow } from './ambiguous-create.js';
import { describeAwsFailure } from '../../utils/aws-failure-text.js';
import { create, reportPossibleMappingOrphans } from './lambda-eventsource/create.js';
import { update, applyUpdate, applyTagDiff } from './lambda-eventsource/update.js';
import { deleteImpl } from './lambda-eventsource/delete.js';
import {
  readCurrentState,
  canonicalizeDriftPair,
  importImpl,
} from './lambda-eventsource/read-state.js';

export {
  classifyEventSource,
  resetEventSourceMappingCreateRetryStateForTests,
} from './lambda-eventsource/shared.js';

/**
 * AWS Lambda Event Source Mapping Provider
 *
 * Implements resource provisioning for AWS::Lambda::EventSourceMapping using the Lambda SDK.
 * WHY: CreateEventSourceMapping is synchronous - the CC API adds unnecessary polling overhead
 * (1s->2s->4s->8s) for an operation that completes immediately.
 */
export class LambdaEventSourceMappingProvider implements ResourceProvider {
  lambdaClient: LambdaClient;
  createClient: Promise<LambdaClient> | undefined;
  logger: ConsoleLogger = getLogger().child('LambdaEventSourceMappingProvider');
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
  getCreateClient(): Promise<LambdaClient> {
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
  operationSinks(
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
  wrapMaskedError(
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

  create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    context?: CreateContext
  ): Promise<ResourceCreateResult> {
    return create.call(this, logicalId, resourceType, properties, context);
  }

  reportPossibleMappingOrphans(
    logicalId: string,
    window: AmbiguousCreateWindow,
    log: MaskedLogSinks,
    functionName: string,
    sourceArn: string | undefined
  ): Promise<void> {
    return reportPossibleMappingOrphans.call(this, logicalId, window, log, functionName, sourceArn);
  }

  update(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>,
    context?: UpdateContext
  ): Promise<ResourceUpdateResult> {
    return update.call(
      this,
      logicalId,
      physicalId,
      resourceType,
      properties,
      previousProperties,
      context
    );
  }

  applyUpdate(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>,
    log: MaskedLogSinks,
    restoring: boolean
  ): Promise<ResourceUpdateResult> {
    return applyUpdate.call(
      this,
      logicalId,
      physicalId,
      resourceType,
      properties,
      previousProperties,
      log,
      restoring
    );
  }

  applyTagDiff(
    arn: string,
    resourceType: string,
    logicalId: string,
    oldTagsRaw: unknown,
    newTagsRaw: unknown,
    log: MaskedLogSinks
  ): Promise<void> {
    return applyTagDiff.call(this, arn, resourceType, logicalId, oldTagsRaw, newTagsRaw, log);
  }

  delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void> {
    return deleteImpl.call(this, logicalId, physicalId, resourceType, properties, context);
  }

  readCurrentState(
    physicalId: string,
    logicalId: string,
    resourceType: string,
    properties?: Record<string, unknown>
  ): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
    return readCurrentState.call(this, physicalId, logicalId, resourceType, properties);
  }

  canonicalizeDriftPair(
    resourceType: string,
    baseline: Record<string, unknown>,
    aws: Record<string, unknown>,
    properties?: Record<string, unknown>
  ): Promise<{ baseline: Record<string, unknown>; aws: Record<string, unknown> }> {
    return canonicalizeDriftPair.call(this, resourceType, baseline, aws, properties);
  }

  import(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    return importImpl.call(this, input);
  }
}
