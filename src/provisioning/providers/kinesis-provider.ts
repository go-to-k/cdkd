import {
  KinesisClient,
  CreateStreamCommand,
  DeleteStreamCommand,
  DescribeStreamCommand,
  DescribeStreamSummaryCommand,
  UpdateStreamModeCommand,
  UpdateShardCountCommand,
  UpdateMaxRecordSizeCommand,
  EnableEnhancedMonitoringCommand,
  DisableEnhancedMonitoringCommand,
  AddTagsToStreamCommand,
  RemoveTagsFromStreamCommand,
  IncreaseStreamRetentionPeriodCommand,
  DecreaseStreamRetentionPeriodCommand,
  StartStreamEncryptionCommand,
  StopStreamEncryptionCommand,
  ListTagsForStreamCommand,
  ResourceNotFoundException,
  type EncryptionType,
  type MetricsName,
} from '@aws-sdk/client-kinesis';
import { getLogger } from '../../utils/logger.js';
import { describeAwsFailure } from '../../utils/aws-failure-text.js';
import { safeMsg } from '../../utils/display-safe.js';
import { readConfigString } from '../config-shape.js';
import { ProvisioningError } from '../../utils/error-handler.js';
import { markAuxiliaryFailure, markCreatedBeforeFailure } from '../auxiliary-failure.js';
import { assertRegionMatch, type DeleteContext } from '../region-check.js';
import { generateResourceName } from '../resource-name.js';
import { normalizeAwsTagsToCfn, resolveExplicitPhysicalId } from '../import-helpers.js';
import { planTagDiff, tagPlanWarning, refuseMalformedDesiredTags } from '../tag-list.js';
import type {
  ResourceProvider,
  ResourceCreateResult,
  ResourceUpdateResult,
  ResourceImportInput,
  ResourceImportResult,
  CreateContext,
  UpdateContext,
  ResourceNotFound,
  ResourceIdentityVerdict,
} from '../../types/resource.js';
import { RESOURCE_NOT_FOUND } from '../../types/resource.js';
import { maskDeep, maskerOrIdentity, type MaskerFn } from '../masked-retry-logger.js';
import { ambientClientDefaults } from '../../utils/ambient-client-defaults.js';
import { ambientRegion } from '../../utils/stack-aws-scope.js';
import { waitForGoneAfterDelete } from '../delete-gone-wait.js';

/**
 * Class 1/2 sanitize for `StreamEncryption` placeholder.
 *
 * `readCurrentState` always-emits `StreamEncryption: { EncryptionType:
 * 'NONE' }` for unencrypted streams so the drift comparator can detect
 * a console-side KMS attach (state-keys-only top-level walk needs the
 * key present). On the write side, neither `StartStreamEncryption`
 * (KMS-only) nor `StopStreamEncryption` accepts `NONE` as input —
 * pushing the placeholder through `cdkd drift --revert` would trigger
 * a ValidationException. This helper returns true only when the value
 * represents real KMS encryption (sibling discriminator `EncryptionType
 * === 'KMS'`); the create / update code paths gate every encryption-
 * mutating SDK call on it.
 */
function isKmsEncryption(value: Record<string, unknown> | undefined): boolean {
  if (!value) return false;
  return value['EncryptionType'] === 'KMS';
}

/**
 * The seven shard-level metrics `ALL` expands to.
 *
 * MEASURED, not copied from the docs (us-east-1, 2026-08-12): an
 * `EnableEnhancedMonitoring(ShardLevelMetrics: ['ALL'])` responds with exactly
 * these seven in `DesiredShardLevelMetrics`, and once the stream settles back
 * to ACTIVE `DescribeStream` reports the same seven — never the literal `ALL`.
 * The readback order is AWS-chosen and matched neither the input order nor
 * alphabetical, which is why the type also declares the path unordered (see
 * {@link KinesisStreamProvider.getDriftUnorderedPaths}).
 */
const ALL_SHARD_LEVEL_METRICS: readonly string[] = [
  'IncomingBytes',
  'IncomingRecords',
  'OutgoingBytes',
  'OutgoingRecords',
  'WriteProvisionedThroughputExceeded',
  'ReadProvisionedThroughputExceeded',
  'IteratorAgeMilliseconds',
];

/**
 * Whether a value is a usable shard-level-metrics list: an array whose every
 * element is a string.
 *
 * A MIXED array (`['IncomingBytes', {Ref: 'X'}]`) is deliberately UNUSABLE
 * rather than partially usable. Filtering the unresolved element away would put
 * a list on the wire that the template never declared, while state recorded the
 * declared one — the permanent phantom drift `effectiveProperties` exists to
 * prevent, arrived at through the back door.
 */
function isUsableMetricsList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

/**
 * Expand the `ALL` shard-level-metrics shorthand into the seven metric names
 * AWS actually stores.
 *
 * This is the ONE definition of the rule, shared by the provisioning path (what
 * goes on the wire, and therefore what `effectiveProperties` records) and by
 * {@link KinesisStreamProvider.canonicalizeDesiredProperties} (what the diff
 * compares). Deriving it twice is how state and template end up narrowed
 * differently — see the `effectiveProperties` contract in
 * `.claude/rules/providers.md`.
 *
 * Idempotent: an already-expanded list is returned with its own values (deduped
 * and otherwise untouched), so a state-borne bag that has been through this
 * before is unchanged. An UNUSABLE value is returned as-is — the callers that
 * put bytes on the wire refuse it via {@link readShardLevelMetrics} rather than
 * sending a partial list, and `canonicalizeDesiredProperties` must stay a total
 * function because the diff runs on bags no provider validated.
 */
function expandShardLevelMetrics(value: unknown): unknown {
  if (!isUsableMetricsList(value)) return value;

  const names = value;
  const expanded = names.includes('ALL')
    ? [...names.filter((n) => n !== 'ALL'), ...ALL_SHARD_LEVEL_METRICS]
    : names;

  // Dedupe while preserving first-seen order: `['ALL', 'IncomingBytes']` is a
  // legal template and must not send the same metric twice.
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const name of expanded) {
    if (seen.has(name)) continue;
    seen.add(name);
    deduped.push(name);
  }

  // Preserve identity when nothing changed, so callers can cheaply detect a
  // no-op expansion and skip returning `effectiveProperties`.
  if (deduped.length === names.length && deduped.every((n, i) => n === names[i])) return value;
  return deduped;
}

/**
 * The three answers a caller needs about the declared metric list, kept
 * DISTINCT because two of them look identical once flattened to an array and
 * the difference is destructive.
 *
 * `absent` means the template does not declare the property — on update that is
 * a REMOVAL and every live metric should be disabled. `unusable` means the
 * property IS declared but cannot be read; flattening that to an empty list
 * would disable every live metric on the strength of a value cdkd could not
 * parse. Same array, opposite intent.
 */
type ShardLevelMetricsRead =
  | { kind: 'absent' }
  | { kind: 'usable'; metrics: MetricsName[]; expanded: unknown }
  | { kind: 'unusable'; reason: string };

/**
 * Classify a declared `DesiredShardLevelMetrics` value, expanding `ALL` when it
 * is usable.
 *
 * Callers own the ACTION per the update-path rules in
 * `.claude/rules/providers.md`: a create refuses an unusable value (it is
 * template-borne), an update WARNS and skips (it may be replaying a state
 * record, where refusing would leave the resource un-rollbackable). The
 * previous side is never routed through the refusal at all — see
 * {@link previousMetricNames}.
 */
function readShardLevelMetrics(value: unknown, mask: MaskerFn): ShardLevelMetricsRead {
  if (value == null) return { kind: 'absent' };
  if (!isUsableMetricsList(value)) {
    return {
      kind: 'unusable',
      reason:
        `AWS::Kinesis::Stream DesiredShardLevelMetrics must be an array of metric-name ` +
        `strings, got ${JSON.stringify(maskDeep(value, mask))}`,
    };
  }
  const expanded = expandShardLevelMetrics(value);
  return { kind: 'usable', metrics: expanded as MetricsName[], expanded };
}

/**
 * Read the PREVIOUS side leniently: it comes from cdkd state, not the user's
 * template, so an unreadable value recorded by an older binary must never
 * refuse the update (the #1471 desired-side-only rule). An unusable previous
 * side simply contributes no metrics to disable.
 */
function previousMetricNames(value: unknown): MetricsName[] {
  const expanded = expandShardLevelMetrics(value);
  return isUsableMetricsList(expanded) ? (expanded as MetricsName[]) : [];
}

/**
 * The `MaxRecordSizeInKiB` twin of {@link readShardLevelMetrics}, with the same
 * three answers and for the same reason.
 *
 * A bare `Number(...)` is NOT enough here even though the sibling `ShardCount`
 * uses one: `Number('')` and `Number([])` are `0` and `Number(true)` is `1`, so
 * a malformed value would go on the wire as a plausible-looking size, while
 * `'abc'` / `{}` would yield `NaN` and silently OMIT the field — the stream
 * gets AWS's default while state records the declared junk, which is exactly
 * the silent-drop class issue #609 exists to close.
 *
 * So a NUMBER (or a numeric STRING, which CFn's scalar coercion makes a
 * legitimate template shape cdkd does not perform itself) is `usable`; anything
 * else present is `unusable` and the caller refuses it on the template path.
 */
type MaxRecordSizeRead =
  | { kind: 'absent' }
  | { kind: 'usable'; size: number }
  | { kind: 'unusable'; reason: string };

function readMaxRecordSize(value: unknown, mask: MaskerFn): MaxRecordSizeRead {
  if (value == null) return { kind: 'absent' };
  if (typeof value === 'number' && Number.isFinite(value)) return { kind: 'usable', size: value };
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    if (Number.isFinite(n)) return { kind: 'usable', size: n };
  }
  return {
    kind: 'unusable',
    reason:
      `AWS::Kinesis::Stream MaxRecordSizeInKiB must be a number, got ` +
      `${JSON.stringify(maskDeep(value, mask))}`,
  };
}

/**
 * Shape read for the post-`CreateStream` follow-up calls the pre-flight covers
 * (go-to-k/cdkd#1710). `Tags` is refused by `refuseMalformedDesiredTags`.
 */
type FollowUpRead =
  | { kind: 'absent' }
  | { kind: 'usable'; hours?: number }
  | { kind: 'unusable'; reason: string };

/**
 * Refuse a `RetentionPeriodHours` the retention call cannot take
 * (go-to-k/cdkd#1710).
 *
 * The retention change runs AFTER `CreateStream`, so a non-numeric value
 * failed against a stream that already exists. A numeric STRING is usable and
 * converted, as `readMaxRecordSize` does: CFn's scalar coercion makes it a
 * legitimate template shape (a `Ref` to a `Number` parameter resolves to
 * one), and the API field is a number. The RANGE is AWS's to judge.
 */
function readRetentionHours(value: unknown, mask: MaskerFn): FollowUpRead {
  if (value == null) return { kind: 'absent' };
  if (typeof value === 'number' && Number.isFinite(value)) return { kind: 'usable', hours: value };
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
    return { kind: 'usable', hours: Number(value) };
  }
  return {
    kind: 'unusable',
    reason:
      `AWS::Kinesis::Stream RetentionPeriodHours must be a number, got ` +
      `${JSON.stringify(maskDeep(value, mask))}`,
  };
}

/**
 * Refuse a KMS `StreamEncryption` block with no usable `KeyId`
 * (go-to-k/cdkd#1710).
 *
 * `StartStreamEncryption` runs AFTER `CreateStream`, so a KMS block missing
 * its key sent `KeyId: undefined` against a live stream. Only a block that
 * selects KMS is read: that is the only branch that issues the call.
 */
function readEncryptionKeyId(
  value: Record<string, unknown> | undefined,
  mask: MaskerFn
): FollowUpRead {
  if (!isKmsEncryption(value)) return { kind: 'absent' };
  const keyId = value?.['KeyId'];
  if (typeof keyId === 'string' && keyId.trim() !== '') return { kind: 'usable' };
  return {
    kind: 'unusable',
    reason:
      `AWS::Kinesis::Stream StreamEncryption selects KMS but KeyId is not a non-empty string, ` +
      `got ${JSON.stringify(maskDeep(keyId, mask)) ?? 'undefined'}`,
  };
}

/**
 * The comparison-side read: the UPDATE path needs both sides reduced to the
 * same shape so a state record holding the number and a template holding the
 * numeric string do not read as a change and re-issue the call every deploy.
 * Unusable / absent both yield `undefined`, which the caller treats as "no
 * declared size" rather than refusing — the previous side is state-borne.
 */
function comparableRecordSize(value: unknown, mask: MaskerFn): number | undefined {
  // The masker is threaded even though this arm never reads `reason`: the
  // reader BUILDS the message either way, so leaving it unmasked here would
  // make the walk's coverage depend on which field a caller happens to read.
  const read = readMaxRecordSize(value, mask);
  return read.kind === 'usable' ? read.size : undefined;
}

/**
 * Poll cadence and cap for the post-delete gone-wait (issue #3872). The
 * DELETING window measured 4-7s (us-east-1), so the cap is generous headroom,
 * not an estimate, and sits well under the 30-min per-resource deadline.
 */
const KINESIS_DELETE_POLL_INTERVAL_MS = 2_000;
const KINESIS_DELETE_MAX_WAIT_MS = 5 * 60 * 1000;

/** A Kinesis stream name, as `CreateStream` accepts it (never an ARN). */
function isStreamName(id: string): boolean {
  return /^[a-zA-Z0-9_.-]{1,128}$/.test(id);
}

/**
 * AWS Kinesis Stream Provider
 *
 * Implements resource provisioning for AWS::Kinesis::Stream using the Kinesis SDK.
 * WHY: The CC API polls with exponential backoff (1s->2s->4s->8s->10s) for stream
 * creation, but we can poll DescribeStream directly with shorter intervals (2s),
 * eliminating the CC API intermediary overhead and reducing total wait time.
 */
export class KinesisStreamProvider implements ResourceProvider {
  private client: KinesisClient | undefined;
  private readonly providerRegion = ambientRegion();
  private logger = getLogger().child('KinesisProvider');

  handledProperties = new Map<string, ReadonlySet<string>>([
    [
      'AWS::Kinesis::Stream',
      new Set([
        'Name',
        'StreamModeDetails',
        'ShardCount',
        'Tags',
        'RetentionPeriodHours',
        'StreamEncryption',
        'DesiredShardLevelMetrics',
        'MaxRecordSizeInKiB',
      ]),
    ],
  ]);

  private getClient(): KinesisClient {
    if (!this.client) {
      this.client = new KinesisClient({
        ...ambientClientDefaults(),
        ...(this.providerRegion ? { region: this.providerRegion } : {}),
      });
    }
    return this.client;
  }

  /**
   * Create a Kinesis stream
   */
  async create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    context?: CreateContext
  ): Promise<ResourceCreateResult> {
    // Issue #2178: the sink for the lines that QUOTE a value read off the bag.
    // `properties` arrives RESOLVED, so a `{{resolve:secretsmanager:...}}`
    // scalar is already plaintext by the time the readers below refuse one.
    // The remaining `this.logger.debug` lines in this method name the stream
    // rather than a property value and are part of issue #2177's TIER A sweep.
    const mask = maskerOrIdentity(context?.maskSecrets);
    const warn = (message: string): void => this.logger.warn(mask(message));

    this.logger.debug(`Creating Kinesis stream ${logicalId}`);
    // go-to-k/cdkd#3994: a malformed Tags is refused before any call.
    const desiredTags = refuseMalformedDesiredTags(properties['Tags'], resourceType, logicalId);

    const streamName =
      (properties['Name'] as string | undefined) ||
      generateResourceName(logicalId, { maxLength: 128 });

    // PRE-FLIGHT, deliberately ABOVE the try (docs/provider-rules.md#pre-flight-refusal-when-a-provider-may-reject-what-cloudformation-forwards).
    // Refusing from inside it would throw AFTER `CreateStream` already ran,
    // leaving a stream no state record holds: only `cdkd rollback
    // --revert-failed` removes it (go-to-k/cdkd#1710's mark in the catch below),
    // and until then the retry collides on the deterministic `streamName` with
    // `ResourceInUseException`. None of these checks needs an AWS call.
    const desiredRead = readShardLevelMetrics(properties['DesiredShardLevelMetrics'], mask);
    if (desiredRead.kind === 'unusable') {
      if (context?.replayingState === true) {
        // A state replay cannot be fixed from the user's CDK code, so the
        // refusal downgrades to a warning and the restore proceeds without the
        // metrics rather than leaving the resource unrestorable (issue #1463).
        warn(
          `${desiredRead.reason}. Replaying a state record, so the shard-level metrics are ` +
            `left unset on ${streamName} rather than refusing the restore`
        );
      } else {
        throw new ProvisioningError(desiredRead.reason, resourceType, logicalId, streamName);
      }
    }
    const maxRecordRead = readMaxRecordSize(properties['MaxRecordSizeInKiB'], mask);
    if (maxRecordRead.kind === 'unusable') {
      if (context?.replayingState === true) {
        warn(
          `${maxRecordRead.reason}. Replaying a state record, so ${streamName} is created with ` +
            `AWS's default maximum record size rather than refusing the restore`
        );
      } else {
        throw new ProvisioningError(maxRecordRead.reason, resourceType, logicalId, streamName);
      }
    }
    // go-to-k/cdkd#1710: two FOLLOW-UP calls run after `CreateStream` in the
    // try below — the retention change and `StartStreamEncryption` — so a
    // malformed value there failed against a stream that already exists.
    // Refused here for that reason; the checks are pure.
    //
    // On a state replay an unusable RETENTION skips its call with a warning (a
    // guessed retention would land on a live stream; AWS's default is a safe
    // floor). An unusable KMS block is refused even then: skipping it would
    // leave the stream UNENCRYPTED while the record says KMS, a silent and
    // persistent downgrade.
    const retentionRead = readRetentionHours(properties['RetentionPeriodHours'], mask);
    if (retentionRead.kind === 'unusable') {
      if (context?.replayingState !== true) {
        throw new ProvisioningError(retentionRead.reason, resourceType, logicalId, streamName);
      }
      warn(
        `${retentionRead.reason}. Replaying a state record, so the retention period is left at ` +
          `AWS's default on ${streamName} rather than refusing the restore`
      );
    }
    const encryptionRead = readEncryptionKeyId(
      properties['StreamEncryption'] as Record<string, unknown> | undefined,
      mask
    );
    if (encryptionRead.kind === 'unusable') {
      throw new ProvisioningError(encryptionRead.reason, resourceType, logicalId, streamName);
    }

    // Set once CreateStream returns. No failure after it is this stream's name
    // collision: it is an auxiliary call's (AddTagsToStream, the retention
    // change, StartStreamEncryption, EnableEnhancedMonitoring) or an ACTIVE
    // wait's, so every one is marked (#3826, #3877).
    let streamCreated = false;
    try {
      // Determine stream mode
      const streamModeDetails = properties['StreamModeDetails'] as
        | Record<string, unknown>
        | undefined;
      const streamMode = readConfigString(
        streamModeDetails,
        'StreamMode',
        'PROVISIONED',
        'AWS::Kinesis::Stream StreamModeDetails'
      );

      // ShardCount is required for PROVISIONED mode
      const shardCount =
        streamMode === 'PROVISIONED' ? Number(properties['ShardCount'] ?? 1) : undefined;

      // MaxRecordSizeInKiB is a member of CreateStreamInput, so it lands with
      // the stream itself rather than needing a follow-up call. Validated by
      // the pre-flight above; an unusable value only reaches here on a state
      // replay, where it is omitted and AWS applies its own default.
      const maxRecordSizeInKiB = maxRecordRead.kind === 'usable' ? maxRecordRead.size : undefined;

      await this.getClient().send(
        new CreateStreamCommand({
          StreamName: streamName,
          ...(shardCount !== undefined && { ShardCount: shardCount }),
          StreamModeDetails: {
            StreamMode: streamMode as 'PROVISIONED' | 'ON_DEMAND',
          },
          ...(maxRecordSizeInKiB !== undefined && { MaxRecordSizeInKiB: maxRecordSizeInKiB }),
        })
      );
      streamCreated = true;

      this.logger.debug(`CreateStream initiated for ${streamName}, waiting for ACTIVE status`);

      // Poll until stream is ACTIVE
      const streamInfo = await this.waitForStreamActive(streamName);

      // Apply tags if specified
      const tags: Record<string, string> = {};
      for (const tag of desiredTags) {
        tags[tag.Key] = tag.Value;
      }
      if (Object.keys(tags).length > 0) {
        await this.getClient().send(
          new AddTagsToStreamCommand({
            StreamName: streamName,
            Tags: tags,
          })
        );
      }

      // Apply RetentionPeriodHours if specified (default is 24 hours)
      const retentionPeriodHours =
        retentionRead.kind === 'usable' ? retentionRead.hours : undefined;
      if (retentionPeriodHours !== undefined && retentionPeriodHours !== 24) {
        this.logger.debug(
          `Setting retention period to ${retentionPeriodHours} hours for ${streamName}`
        );
        if (retentionPeriodHours > 24) {
          await this.getClient().send(
            new IncreaseStreamRetentionPeriodCommand({
              StreamName: streamName,
              RetentionPeriodHours: retentionPeriodHours,
            })
          );
        } else {
          await this.getClient().send(
            new DecreaseStreamRetentionPeriodCommand({
              StreamName: streamName,
              RetentionPeriodHours: retentionPeriodHours,
            })
          );
        }
        // Wait for stream to become ACTIVE after retention period change
        await this.waitForStreamActive(streamName);
      }

      // Apply StreamEncryption if specified.
      //
      // Class 1/2 sanitize: `readCurrentState` always-emits
      // `StreamEncryption: { EncryptionType: 'NONE' }` for unencrypted
      // streams so the comparator can detect a console-side KMS attach.
      // On the write side, `StartStreamEncryption` only accepts `KMS`;
      // the AWS API has no "NONE" mode. Skip the call when the desired
      // EncryptionType is anything but `KMS` so a placeholder round-
      // trip via `cdkd drift --revert` does not push an AWS-invalid
      // input.
      const streamEncryption = properties['StreamEncryption'] as
        | Record<string, unknown>
        | undefined;
      if (isKmsEncryption(streamEncryption)) {
        const keyId = streamEncryption!['KeyId'] as string;
        this.logger.debug(`Enabling stream encryption for ${streamName}`);
        await this.getClient().send(
          new StartStreamEncryptionCommand({
            StreamName: streamName,
            EncryptionType: 'KMS' as EncryptionType,
            KeyId: keyId,
          })
        );
        // Wait for stream to become ACTIVE after encryption change
        await this.waitForStreamActive(streamName);
      }

      // Apply DesiredShardLevelMetrics. `EnableEnhancedMonitoring` takes the
      // stream to UPDATING (measured), so it must settle before create returns.
      //
      // Validated by the pre-flight above the try; an unusable value reaches
      // here only on a state replay, where it was warned about and skipped.
      const desiredMetrics = desiredRead.kind === 'usable' ? desiredRead.expanded : undefined;
      const metricsToEnable = desiredRead.kind === 'usable' ? desiredRead.metrics : [];
      if (metricsToEnable.length > 0) {
        this.logger.debug(
          `Enabling ${metricsToEnable.length} shard-level metric(s) on ${streamName}`
        );
        await this.getClient().send(
          new EnableEnhancedMonitoringCommand({
            StreamName: streamName,
            ShardLevelMetrics: metricsToEnable,
          })
        );
        await this.waitForStreamActive(streamName);
      }

      this.logger.debug(`Successfully created Kinesis stream ${logicalId}: ${streamName}`);

      return {
        physicalId: streamName,
        attributes: {
          Arn: streamInfo.streamArn,
        },
        // Record the EXPANDED metric list when the template used `ALL`: AWS
        // stores the seven names, so recording `ALL` would be permanent phantom
        // drift no `readCurrentState` could ever match. Absent when the
        // expansion was a no-op, which keeps the desired bag recorded verbatim.
        ...this.effectiveMetricsProperties(properties, desiredMetrics),
      };
    } catch (error) {
      if (streamCreated) markAuxiliaryFailure(error, logicalId);
      const thrown =
        error instanceof ProvisioningError
          ? error
          : new ProvisioningError(
              `Failed to create Kinesis stream ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
              resourceType,
              logicalId,
              streamName,
              error instanceof Error ? error : undefined
            );
      // go-to-k/cdkd#1710: the stream exists and no state record will hold it,
      // so name it for the failed-CREATE journal. Only once CreateStream has
      // returned: before that, `streamName` may be another owner's stream.
      if (streamCreated) markCreatedBeforeFailure(thrown, logicalId, resourceType, streamName);
      throw thrown;
    }
  }

  /**
   * Update a Kinesis stream
   *
   * Supports switching StreamMode (PROVISIONED <-> ON_DEMAND, via
   * UpdateStreamMode), updating ShardCount for PROVISIONED mode streams,
   * RetentionPeriodHours, StreamEncryption, and Tags. Name changes require
   * replacement (handled by the deployment layer).
   */
  async update(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>,
    context?: UpdateContext
  ): Promise<ResourceUpdateResult> {
    // Issue #2178: the update path reaches the same two readers, so it needs
    // the same sink. Absent means unmasked (the back-compatible default the
    // SecretMaskingContext contract mandates). Same TIER A scope note as
    // `create()` above.
    const mask = maskerOrIdentity(context?.maskSecrets);
    const warn = (message: string): void => this.logger.warn(mask(message));

    this.logger.debug(`Updating Kinesis stream ${logicalId}: ${physicalId}`);
    // go-to-k/cdkd#3994: a malformed desired Tags is refused before any call.
    refuseMalformedDesiredTags(properties['Tags'], resourceType, logicalId, physicalId);
    // go-to-k/cdkd#1710: the desired retention is read as create() reads it,
    // before any call — a non-numeric value would otherwise reach the retention
    // API mid-update. A state replay keeps the stream's retention instead of
    // refusing the restore. The PREVIOUS side comes from state: an unusable
    // one reads as unknown (AWS's default), never refused (issue #1471's rule).
    const desiredRetention = readRetentionHours(properties['RetentionPeriodHours'], mask);
    if (desiredRetention.kind === 'unusable' && context?.replayingState !== true) {
      throw new ProvisioningError(desiredRetention.reason, resourceType, logicalId, physicalId);
    }
    if (desiredRetention.kind === 'unusable') {
      warn(
        `${desiredRetention.reason}. Replaying a state record, so the retention period of ` +
          `${physicalId} is left as it is rather than refusing the restore`
      );
    }
    const previousRetention = readRetentionHours(previousProperties['RetentionPeriodHours'], mask);

    try {
      const streamModeDetails = properties['StreamModeDetails'] as
        | Record<string, unknown>
        | undefined;
      const streamMode = readConfigString(
        streamModeDetails,
        'StreamMode',
        'PROVISIONED',
        'AWS::Kinesis::Stream StreamModeDetails'
      );
      // Deliberately NOT routed through `readConfigString` (issue #1471): the
      // PREVIOUS side comes from cdkd state, not the user's template. Refusing
      // a malformed value recorded there by an older binary would make the
      // stack permanently undeployable — editing the template would not help,
      // because the previous side stays malformed until a deploy succeeds. The
      // desired side above is guarded, which is what stops the silent default.
      const oldStreamMode =
        ((previousProperties['StreamModeDetails'] as Record<string, unknown> | undefined)?.[
          'StreamMode'
        ] as string) || 'PROVISIONED';

      // Switch StreamMode FIRST (PROVISIONED <-> ON_DEMAND). In CFn,
      // StreamModeDetails is "Update requires: No interruption", applied via
      // UpdateStreamMode. cdkd previously had no UpdateStreamMode call, so a
      // mode switch was silently dropped — the deploy reported success while
      // AWS kept the old mode and state recorded the new one (and the next
      // diff saw no change, so it could never self-heal). Doing it before any
      // ShardCount work means ON_DEMAND -> PROVISIONED lands in provisioned
      // mode before the (invalid-on-on-demand) UpdateShardCount runs, and
      // PROVISIONED -> ON_DEMAND skips the ShardCount path entirely.
      const modeChanged = oldStreamMode !== streamMode;
      if (modeChanged) {
        const streamArn = await this.resolveStreamArn(physicalId);
        this.logger.debug(
          `Switching stream mode for ${physicalId}: from ${oldStreamMode} to ${streamMode}`
        );
        await this.getClient().send(
          new UpdateStreamModeCommand({
            StreamARN: streamArn,
            StreamModeDetails: {
              StreamMode: streamMode as 'PROVISIONED' | 'ON_DEMAND',
            },
          })
        );
        await this.waitForStreamActive(physicalId);
      }

      // Update ShardCount if changed (only for PROVISIONED mode).
      if (streamMode === 'PROVISIONED') {
        const newShardCount = Number(properties['ShardCount'] ?? 1);
        // When we just switched INTO provisioned mode from on-demand, AWS
        // assigns a shard count based on the prior on-demand throughput and
        // previousProperties carries no ShardCount, so read the live count to
        // know the real base to reconcile against.
        const oldShardCount = modeChanged
          ? await this.getOpenShardCount(physicalId)
          : Number(previousProperties['ShardCount'] ?? 1);

        if (newShardCount !== oldShardCount) {
          this.logger.debug(
            `Updating shard count for ${physicalId}: from ${oldShardCount} to ${newShardCount}`
          );

          await this.getClient().send(
            new UpdateShardCountCommand({
              StreamName: physicalId,
              TargetShardCount: newShardCount,
              ScalingType: 'UNIFORM_SCALING',
            })
          );

          // Wait for stream to become ACTIVE after resharding
          await this.waitForStreamActive(physicalId);
        }
      }

      // Update RetentionPeriodHours if changed
      const effectiveNewRetention =
        desiredRetention.kind === 'usable' ? (desiredRetention.hours ?? 24) : 24;
      const effectiveOldRetention =
        previousRetention.kind === 'usable' ? (previousRetention.hours ?? 24) : 24;
      if (desiredRetention.kind !== 'unusable' && effectiveNewRetention !== effectiveOldRetention) {
        this.logger.debug(
          `Updating retention period for ${physicalId}: from ${effectiveOldRetention} to ${effectiveNewRetention}`
        );
        if (effectiveNewRetention > effectiveOldRetention) {
          await this.getClient().send(
            new IncreaseStreamRetentionPeriodCommand({
              StreamName: physicalId,
              RetentionPeriodHours: effectiveNewRetention,
            })
          );
        } else {
          await this.getClient().send(
            new DecreaseStreamRetentionPeriodCommand({
              StreamName: physicalId,
              RetentionPeriodHours: effectiveNewRetention,
            })
          );
        }
        await this.waitForStreamActive(physicalId);
      }

      // Apply tag diff. Kinesis uses AddTagsToStream (map shape) and
      // RemoveTagsFromStream (TagKeys list).
      await this.applyTagDiff(
        physicalId,
        resourceType,
        logicalId,
        previousProperties['Tags'],
        properties['Tags']
      );

      // Update StreamEncryption if changed.
      //
      // Class 1/2 sanitize: `readCurrentState` always-emits
      // `StreamEncryption: { EncryptionType: 'NONE' }` on unencrypted
      // streams for drift detection. Treat the NONE placeholder as
      // "no encryption" — it is NOT a valid input to either
      // `StartStreamEncryption` (KMS-only) or `StopStreamEncryption`
      // (encryption-removal). Only call:
      //  - StopStreamEncryption when previous WAS KMS-encrypted.
      //  - StartStreamEncryption when desired IS KMS-encrypted.
      //
      // Without this, a `cdkd drift --revert` round-trip on a stream
      // that has never been KMS-encrypted would push `EncryptionType=NONE`
      // back through the API and AWS rejects with a ValidationException.
      const newEncryption = properties['StreamEncryption'] as Record<string, unknown> | undefined;
      const oldEncryption = previousProperties['StreamEncryption'] as
        | Record<string, unknown>
        | undefined;
      const oldIsKms = isKmsEncryption(oldEncryption);
      const newIsKms = isKmsEncryption(newEncryption);
      const oldKeyId = oldIsKms ? (oldEncryption!['KeyId'] as string | undefined) : undefined;
      const newKeyId = newIsKms ? (newEncryption!['KeyId'] as string | undefined) : undefined;
      if (oldIsKms !== newIsKms || (oldIsKms && newIsKms && oldKeyId !== newKeyId)) {
        // Remove old encryption only when it WAS KMS-encrypted.
        if (oldIsKms) {
          await this.getClient().send(
            new StopStreamEncryptionCommand({
              StreamName: physicalId,
              EncryptionType: 'KMS' as EncryptionType,
              KeyId: oldKeyId,
            })
          );
          await this.waitForStreamActive(physicalId);
        }
        // Apply new encryption only when it IS KMS-encrypted.
        if (newIsKms) {
          await this.getClient().send(
            new StartStreamEncryptionCommand({
              StreamName: physicalId,
              EncryptionType: 'KMS' as EncryptionType,
              KeyId: newKeyId,
            })
          );
          await this.waitForStreamActive(physicalId);
        }
      }

      // Update MaxRecordSizeInKiB if changed. `UpdateMaxRecordSize` is one of
      // the Kinesis APIs that takes a StreamARN and has no StreamName member,
      // so it needs the same ARN resolution UpdateStreamMode does.
      // Both sides reduced through the SAME helper, so a state record holding
      // the number and a template holding the numeric string do not read as a
      // change and re-issue the call on every deploy. Neither side refuses
      // here: the update path is state-replay-reachable, so an unusable value
      // simply reads as "no declared size" and leaves the live one alone.
      //
      // But it must SAY so. The metrics sibling below warns on its skip, and
      // without this the same junk value is a hard refusal on create and a
      // silent no-op on update — same template, opposite feedback, and no
      // signal at all on the update path (docs/provider-rules.md#pre-flight-refusal-when-a-provider-may-reject-what-cloudformation-forwards
      // requires the warn-and-skip arm to announce itself).
      const desiredSizeRead = readMaxRecordSize(properties['MaxRecordSizeInKiB'], mask);
      if (desiredSizeRead.kind === 'unusable') {
        warn(
          `${desiredSizeRead.reason}. Leaving the maximum record size on ${physicalId} ` +
            `unchanged; the same value is REFUSED on a template-path create`
        );
      }
      const newMaxRecordSize = comparableRecordSize(properties['MaxRecordSizeInKiB'], mask);
      const oldMaxRecordSize = comparableRecordSize(previousProperties['MaxRecordSizeInKiB'], mask);
      if (newMaxRecordSize !== undefined && newMaxRecordSize !== oldMaxRecordSize) {
        this.logger.debug(
          `Updating max record size for ${physicalId}: from ${oldMaxRecordSize ?? 'no value'} to ${newMaxRecordSize}`
        );
        await this.getClient().send(
          new UpdateMaxRecordSizeCommand({
            StreamARN: await this.resolveStreamArn(physicalId),
            MaxRecordSizeInKiB: newMaxRecordSize,
          })
        );
        await this.waitForStreamActive(physicalId);
      }

      // Reconcile DesiredShardLevelMetrics. There is no "set" API — enhanced
      // monitoring is a set mutated by Enable / Disable — so the diff is
      // applied as a removal pass then an addition pass. Both sides are
      // expanded first so a template switching between `ALL` and the seven
      // explicit names is correctly a no-op rather than a full churn.
      //
      // ABSENT and UNUSABLE must not collapse to the same empty list. Absent is
      // a template REMOVAL and correctly disables every live metric; unusable
      // would disable them on the strength of a value cdkd could not read, so
      // it WARNS and skips the whole reconcile (the update path cannot refuse —
      // `rollback-executor` and `drift --revert` replay state records through
      // `update()`, where a throw has no template-side remedy).
      const desiredRead = readShardLevelMetrics(properties['DesiredShardLevelMetrics'], mask);
      let desiredMetrics: unknown;
      if (desiredRead.kind === 'unusable') {
        warn(
          `${desiredRead.reason}. Leaving the shard-level metrics on ${physicalId} unchanged ` +
            `rather than disabling the live ones; the same value is REFUSED on a ` +
            `template-path create`
        );
      } else {
        desiredMetrics = desiredRead.kind === 'usable' ? desiredRead.expanded : undefined;
        const desiredSet = desiredRead.kind === 'usable' ? desiredRead.metrics : [];
        // The previous side comes from cdkd state, not the template, so it is
        // read leniently and never refused (the #1471 desired-side-only rule).
        const previousSet = previousMetricNames(previousProperties['DesiredShardLevelMetrics']);
        const toDisable = previousSet.filter((m) => !desiredSet.includes(m));
        const toEnable = desiredSet.filter((m) => !previousSet.includes(m));
        if (toDisable.length > 0) {
          this.logger.debug(`Disabling ${toDisable.length} shard-level metric(s) on ${physicalId}`);
          await this.getClient().send(
            new DisableEnhancedMonitoringCommand({
              StreamName: physicalId,
              ShardLevelMetrics: toDisable,
            })
          );
          await this.waitForStreamActive(physicalId);
        }
        if (toEnable.length > 0) {
          this.logger.debug(`Enabling ${toEnable.length} shard-level metric(s) on ${physicalId}`);
          await this.getClient().send(
            new EnableEnhancedMonitoringCommand({
              StreamName: physicalId,
              ShardLevelMetrics: toEnable,
            })
          );
          await this.waitForStreamActive(physicalId);
        }
      }

      // Get current stream description for attributes
      const response = await this.getClient().send(
        new DescribeStreamCommand({ StreamName: physicalId })
      );

      return {
        physicalId,
        wasReplaced: false,
        attributes: {
          Arn: response.StreamDescription?.StreamARN,
        },
        ...this.effectiveMetricsProperties(properties, desiredMetrics),
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to update Kinesis stream ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  /**
   * Delete a Kinesis stream
   */
  async delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    _properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void> {
    this.logger.debug(`Deleting Kinesis stream ${logicalId}: ${physicalId}`);

    try {
      await this.getClient().send(
        new DeleteStreamCommand({
          StreamName: physicalId,
          EnforceConsumerDeletion: true,
        })
      );
    } catch (error) {
      if (error instanceof ResourceNotFoundException) {
        const clientRegion = await this.getClient().config.region();
        assertRegionMatch(
          clientRegion,
          context?.expectedRegion,
          resourceType,
          logicalId,
          physicalId
        );
        if (context?.failedCreateOrphan === true) {
          // go-to-k/cdkd#4606: a journaled orphan already gone settles with
          // exit 0, so say so once. Masked by the caller's printing bag.
          this.logger.info(
            safeMsg`  Kinesis stream ${physicalId} (${logicalId}), which a failed deploy created, is already gone; nothing to delete`
          );
        } else {
          this.logger.debug(`Kinesis stream ${physicalId} does not exist, skipping deletion`);
        }
        return;
      }
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to delete Kinesis stream ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }

    // Issue #3872: the stream keeps its NAME while it is DELETING, and a
    // CreateStream of that name is refused with the same `already exists`
    // text a live stream gets, so the delete is complete only once the stream
    // is gone. Outside the try: with no `failedStatus` passed, the wait never
    // throws.
    await waitForGoneAfterDelete({
      what: `Kinesis stream ${physicalId}`,
      resourceType,
      describe: () => this.readStreamStatusForDelete(physicalId),
      logger: this.logger,
      pollIntervalMs: KINESIS_DELETE_POLL_INTERVAL_MS,
      maxWaitMs: KINESIS_DELETE_MAX_WAIT_MS,
    });
    this.logger.debug(`Successfully deleted Kinesis stream ${logicalId}`);
  }

  /**
   * go-to-k/cdkd#4606: whether the stream a failed CREATE journaled is the
   * one the record under the same logical id holds (a fix-forward that
   * created a new stream there).
   *
   * Both ids must be stream NAMES (the physical id on either route: Cloud
   * Control's primary identifier is the name too); an ARN or anything else
   * is `'unknown'`. Stream names are case-sensitive and unique per account
   * and region, and a stream cannot be renamed, so two distinct names in the
   * stack's region name two distinct streams. After the region check: the record's stream must exist (else `'unknown'`);
   * the journaled one is `'same'` when it reads back under the record's ARN,
   * `'different'` under another ARN or when AWS reports it gone (it cannot
   * then be the record's live stream; its delete settles as already gone).
   * Equal names are `'same'` without a read: whatever stream holds the name
   * now is the record's, and deleting by that name would delete it.
   */
  async isSameResource(
    journaledPhysicalId: string,
    record: { physicalId: string },
    _resourceType: string,
    context: { expectedRegion: string }
  ): Promise<ResourceIdentityVerdict> {
    if (!isStreamName(journaledPhysicalId) || !isStreamName(record.physicalId)) return 'unknown';
    if (journaledPhysicalId === record.physicalId) return 'same';
    const clientRegion = await this.getClient().config.region();
    if (clientRegion !== context.expectedRegion) return 'unknown';
    const recordArn = await this.readStreamArnIfExists(record.physicalId);
    if (recordArn === undefined) return 'unknown';
    const journaledArn = await this.readStreamArnIfExists(journaledPhysicalId);
    if (journaledArn === undefined) return 'different';
    return journaledArn === recordArn ? 'same' : 'different';
  }

  /**
   * The stream's ARN, or `undefined` when `DescribeStreamSummary` reports it
   * gone. Any other failure (and a response naming no ARN) throws: "could
   * not read" never reads as "gone".
   */
  private async readStreamArnIfExists(streamName: string): Promise<string | undefined> {
    let response;
    try {
      response = await this.getClient().send(
        new DescribeStreamSummaryCommand({ StreamName: streamName })
      );
    } catch (error) {
      if (error instanceof ResourceNotFoundException) return undefined;
      throw error;
    }
    const arn = response.StreamDescriptionSummary?.StreamARN;
    if (typeof arn !== 'string' || arn === '') {
      throw new Error('DescribeStreamSummary returned no StreamARN');
    }
    return arn;
  }

  /** The stream's status, or `undefined` once `DescribeStreamSummary` reports it gone. */
  private async readStreamStatusForDelete(streamName: string): Promise<string | undefined> {
    try {
      const response = await this.getClient().send(
        new DescribeStreamSummaryCommand({ StreamName: streamName })
      );
      return response.StreamDescriptionSummary?.StreamStatus ?? 'UNKNOWN';
    } catch (error) {
      if (error instanceof ResourceNotFoundException) return undefined;
      throw error;
    }
  }

  /**
   * The `effectiveProperties` half of the `ALL` expansion (issue #609).
   *
   * Returns a spreadable `{ effectiveProperties }` ONLY when the expansion
   * actually rewrote the declared value; otherwise `{}`, so the engine records
   * the desired bag verbatim (the `??` gate on the engine side treats an absent
   * field as "record the desired properties"). The returned bag is a COMPLETE
   * replacement, not a patch, per the `EffectivePropertiesResult` contract.
   */
  private effectiveMetricsProperties(
    properties: Record<string, unknown>,
    expanded: unknown
  ): { effectiveProperties?: Record<string, unknown> } {
    // `undefined` means the caller sent NOTHING for this property — an absent
    // declaration, or a value it refused / skipped as unusable. There is no
    // "what we actually delivered" to record, and writing `undefined` into the
    // bag would erase the declared value from state rather than describe it.
    if (expanded === undefined) return {};
    if (expanded === properties['DesiredShardLevelMetrics']) return {};
    return { effectiveProperties: { ...properties, DesiredShardLevelMetrics: expanded } };
  }

  /**
   * Narrow the desired bag the same way the provisioning path does, so the
   * diff compares the EXPANDED metric list on both sides.
   *
   * Required paired half of the `effectiveProperties` above: without it, state
   * holds the seven expanded names while the template still says `ALL`, and
   * every later `cdkd deploy` / `cdkd diff` reads that as a user-made change.
   * Shares {@link expandShardLevelMetrics} rather than re-deriving the rule.
   */
  canonicalizeDesiredProperties(
    resourceType: string,
    properties: Record<string, unknown>
  ): Record<string, unknown> {
    if (resourceType !== 'AWS::Kinesis::Stream') return properties;
    if (!('DesiredShardLevelMetrics' in properties)) return properties;
    const expanded = expandShardLevelMetrics(properties['DesiredShardLevelMetrics']);
    if (expanded === properties['DesiredShardLevelMetrics']) return properties;
    return { ...properties, DesiredShardLevelMetrics: expanded };
  }

  /**
   * `DesiredShardLevelMetrics` is a SET: AWS returns it in an order that
   * matched neither the request order nor alphabetical when measured
   * (us-east-1, 2026-08-12), so comparing positionally would report drift on a
   * stream nobody touched.
   */
  getDriftUnorderedPaths(resourceType: string): string[] {
    if (resourceType !== 'AWS::Kinesis::Stream') return [];
    return ['DesiredShardLevelMetrics'];
  }

  /**
   * Apply a diff between old and new CFn-shape Tags arrays via Kinesis's
   * `AddTagsToStream` (map shape) / `RemoveTagsFromStream` (TagKeys list)
   * APIs. Both sides are read through `planTagDiff` (go-to-k/cdkd#3994): an
   * unreadable record untags nothing.
   */
  private async applyTagDiff(
    streamName: string,
    resourceType: string,
    logicalId: string,
    oldTagsRaw: unknown,
    newTagsRaw: unknown
  ): Promise<void> {
    const plan = planTagDiff(oldTagsRaw, newTagsRaw);
    const tagWarning = tagPlanWarning(plan, resourceType, logicalId);
    if (tagWarning !== undefined) {
      this.logger.warn(tagWarning);
    }
    const tagsToAdd = Object.fromEntries(plan.set);
    const tagsToRemove = plan.remove;

    if (tagsToRemove.length > 0) {
      await this.getClient().send(
        new RemoveTagsFromStreamCommand({ StreamName: streamName, TagKeys: tagsToRemove })
      );
      this.logger.debug(`Removed ${tagsToRemove.length} tag(s) from Kinesis stream ${streamName}`);
    }
    if (Object.keys(tagsToAdd).length > 0) {
      await this.getClient().send(
        new AddTagsToStreamCommand({ StreamName: streamName, Tags: tagsToAdd })
      );
      this.logger.debug(
        `Added/updated ${Object.keys(tagsToAdd).length} tag(s) on Kinesis stream ${streamName}`
      );
    }
  }

  /**
   * Adopt an existing Kinesis stream into cdkd state.
   *
   * Lookup order:
   *  1. `--resource <id>=<name>` override or `Properties.Name` → verify
   *     with `DescribeStream`.
   */
  /**
   * Read the AWS-current Kinesis stream configuration in CFn-property shape.
   *
   * Issues `DescribeStream` and surfaces the keys cdkd's `create()`
   * accepts: `Name`, `StreamModeDetails`, `ShardCount`, `RetentionPeriodHours`,
   * `StreamEncryption`, and `DesiredShardLevelMetrics`. Tags are surfaced via a
   * follow-up `ListTagsForStream` with `aws:*` filtered out, and
   * `MaxRecordSizeInKiB` via a follow-up `DescribeStreamSummary` (the field is
   * absent from `DescribeStream`'s `StreamDescription` shape).
   *
   * `ShardCount` is reported as the count of `Shards[]` in the stream
   * description (only present for PROVISIONED-mode streams; ON_DEMAND
   * mode reports an empty list).
   *
   * Returns `RESOURCE_NOT_FOUND` when the stream is gone (`ResourceNotFoundException`).
   *
   * `AWS::Kinesis::StreamConsumer` is intentionally not handled here: this
   * provider only registers `AWS::Kinesis::Stream`, so consumer resources
   * route to the CC API fallback for drift detection (CC API's `GetResource`
   * surfaces every Kinesis consumer attribute the user can configure). A
   * dedicated SDK impl would require building out create/update/delete first;
   * out of scope for PR G.
   */
  async readCurrentState(
    physicalId: string,
    _logicalId: string,
    resourceType: string,
    _properties?: Record<string, unknown>
  ): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
    if (resourceType !== 'AWS::Kinesis::Stream') return undefined;

    let stream;
    try {
      const resp = await this.getClient().send(
        new DescribeStreamCommand({ StreamName: physicalId })
      );
      stream = resp.StreamDescription;
    } catch (err) {
      if (err instanceof ResourceNotFoundException) return RESOURCE_NOT_FOUND;
      throw err;
    }
    if (!stream) return undefined;

    const result: Record<string, unknown> = {};
    if (stream.StreamName !== undefined) result['Name'] = stream.StreamName;
    const streamMode = stream.StreamModeDetails?.StreamMode;
    if (streamMode !== undefined) {
      result['StreamModeDetails'] = { StreamMode: streamMode };
    }
    // Class 1 — `ShardCount` is PROVISIONED-only. AWS rejects
    // `UpdateShardCount` on ON_DEMAND streams; emitting a `ShardCount`
    // placeholder there would surface as a `cdkd drift --revert`
    // failure on the round-trip. ON_DEMAND streams report shards too
    // (capacity is managed by AWS), so gating on `Shards.length` is
    // not enough — the type discriminator is `StreamMode`.
    if (streamMode === 'PROVISIONED' && stream.Shards && stream.Shards.length > 0) {
      result['ShardCount'] = stream.Shards.length;
    }
    if (stream.RetentionPeriodHours !== undefined) {
      result['RetentionPeriodHours'] = stream.RetentionPeriodHours;
    }
    {
      const encryption: Record<string, unknown> = {
        EncryptionType: stream.EncryptionType ?? 'NONE',
      };
      if (stream.KeyId !== undefined) encryption['KeyId'] = stream.KeyId;
      result['StreamEncryption'] = encryption;
    }

    // Enhanced monitoring comes back as a list of `{ ShardLevelMetrics }`
    // groups; flatten to the flat CFn list shape. Always emitted (as `[]` when
    // nothing is enabled) so a console-side enable is detectable on a stream
    // whose template DECLARES the property. It cannot manufacture drift on one
    // that does not: an undeclared key captured EMPTY is dropped from the
    // comparison by `undeclaredEmptyObservedKeys`, and the `properties`
    // fallback baseline never holds the key. The flip side of that guard is
    // that a console-side enable on an UNDECLARED property is not detectable.
    result['DesiredShardLevelMetrics'] = (stream.EnhancedMonitoring ?? []).flatMap(
      (entry) => entry.ShardLevelMetrics ?? []
    );

    // `MaxRecordSizeInKiB` is on the SUMMARY shape only — `DescribeStream`'s
    // `StreamDescription` does not carry it — so it needs its own call.
    //
    // A non-not-found failure RETHROWS, matching the `DescribeStream` arm
    // above. Swallowing it would return a snapshot missing the key while state
    // declares it, which `cdkd drift` reports as `2048 -> undefined` and
    // `--accept` then erases from the baseline — a throttle turned into data
    // loss. This read is the third Kinesis call per stream, so throttling is a
    // realistic trigger rather than a theoretical one.
    try {
      const summaryResp = await this.getClient().send(
        new DescribeStreamSummaryCommand({ StreamName: physicalId })
      );
      const maxRecordSize = summaryResp.StreamDescriptionSummary?.MaxRecordSizeInKiB;
      if (maxRecordSize !== undefined) result['MaxRecordSizeInKiB'] = maxRecordSize;
    } catch (err) {
      if (err instanceof ResourceNotFoundException) return RESOURCE_NOT_FOUND;
      throw err;
    }

    // Tags via ListTagsForStream.
    try {
      const tagsResp = await this.getClient().send(
        new ListTagsForStreamCommand({ StreamName: physicalId })
      );
      const tags = normalizeAwsTagsToCfn(tagsResp.Tags);
      result['Tags'] = tags;
    } catch (err) {
      if (err instanceof ResourceNotFoundException) return RESOURCE_NOT_FOUND;
      this.logger.debug(
        `Kinesis ListTagsForStream(${physicalId}) failed: ${describeAwsFailure(err).detail}`
      );
    }
    return result;
  }

  async import(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    const explicit = resolveExplicitPhysicalId(input, 'Name');
    if (explicit) {
      try {
        await this.getClient().send(new DescribeStreamCommand({ StreamName: explicit }));
        return { physicalId: explicit, attributes: {} };
      } catch (err) {
        if (err instanceof ResourceNotFoundException) return null;
        throw err;
      }
    }

    // No `aws:cdk:path` tag walk: AWS rejects `aws:`-prefixed tag writes, so that
    // tag never exists on a real resource and the walk could not match (issue
    // #1134). Auto-mode import resolves ids from CloudFormation's
    // DescribeStackResources or the template's physical-name property; a stream
    // reaching here needs an explicit `--resource` override.
    return null;
  }

  /**
   * Poll DescribeStream until the stream reaches ACTIVE status
   *
   * Uses 2s polling intervals instead of CC API's exponential backoff
   * (1s->2s->4s->8s->10s), reducing total wait time.
   */
  private async waitForStreamActive(
    streamName: string,
    maxAttempts = 30
  ): Promise<{ streamArn: string | undefined }> {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const response = await this.getClient().send(
        new DescribeStreamCommand({ StreamName: streamName })
      );

      const status = response.StreamDescription?.StreamStatus;
      this.logger.debug(
        `Stream ${streamName} status: ${status} (attempt ${attempt}/${maxAttempts})`
      );

      if (status === 'ACTIVE') {
        return {
          streamArn: response.StreamDescription?.StreamARN,
        };
      }

      if (status !== 'CREATING' && status !== 'UPDATING') {
        throw new Error(`Unexpected stream status: ${status}`);
      }

      // Wait 2 seconds between polls
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }

    throw new Error(
      `Stream ${streamName} did not reach ACTIVE status within ${maxAttempts * 2} seconds`
    );
  }

  /**
   * Resolve a stream's ARN from its name. UpdateStreamMode is one of the few
   * Kinesis APIs that takes a StreamARN rather than a StreamName, so an
   * update that switches StreamModeDetails needs the ARN.
   */
  private async resolveStreamArn(streamName: string): Promise<string> {
    const response = await this.getClient().send(
      new DescribeStreamSummaryCommand({ StreamName: streamName })
    );
    const arn = response.StreamDescriptionSummary?.StreamARN;
    if (!arn) {
      throw new Error(`Unable to resolve StreamARN for stream ${streamName}`);
    }
    return arn;
  }

  /**
   * Read the stream's current open shard count. Used after an
   * ON_DEMAND -> PROVISIONED mode switch, where previousProperties carries no
   * ShardCount and AWS has assigned its own count, so reconciling against the
   * live count (not the absent state value) is the only correct base.
   */
  private async getOpenShardCount(streamName: string): Promise<number> {
    const response = await this.getClient().send(
      new DescribeStreamSummaryCommand({ StreamName: streamName })
    );
    return Number(response.StreamDescriptionSummary?.OpenShardCount ?? 1);
  }
}
