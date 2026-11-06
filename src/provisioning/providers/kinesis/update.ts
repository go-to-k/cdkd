import type { KinesisStreamProvider } from '../kinesis-provider.js';
import {
  DescribeStreamCommand,
  DescribeStreamSummaryCommand,
  UpdateStreamModeCommand,
  UpdateShardCountCommand,
  UpdateMaxRecordSizeCommand,
  UpdateStreamRecordDistributionStrategyCommand,
  EnableEnhancedMonitoringCommand,
  DisableEnhancedMonitoringCommand,
  AddTagsToStreamCommand,
  RemoveTagsFromStreamCommand,
  IncreaseStreamRetentionPeriodCommand,
  DecreaseStreamRetentionPeriodCommand,
  StartStreamEncryptionCommand,
  StopStreamEncryptionCommand,
  type EncryptionType,
  type RecordDistributionStrategy,
} from '@aws-sdk/client-kinesis';
import { safeMsg } from '../../../utils/display-safe.js';
import { readConfigString } from '../../config-shape.js';
import { ProvisioningError } from '../../../utils/error-handler.js';
import { planTagDiff, tagPlanWarning, refuseMalformedDesiredTags } from '../../tag-list.js';
import type { ResourceUpdateResult, UpdateContext } from '../../../types/resource.js';
import { maskerOrIdentity, type MaskerFn } from '../../masked-retry-logger.js';
import {
  isKmsEncryption,
  expandShardLevelMetrics,
  readShardLevelMetrics,
  previousMetricNames,
  DEFAULT_MAX_RECORD_SIZE_KIB,
  readMaxRecordSize,
  readRetentionHours,
  comparableRecordSize,
  DEFAULT_RECORD_DISTRIBUTION_STRATEGY,
  readDistributionStrategy,
} from './shared.js';

/**
 * Update a Kinesis stream
 *
 * Supports switching StreamMode (PROVISIONED <-> ON_DEMAND, via
 * UpdateStreamMode), updating ShardCount for PROVISIONED mode streams,
 * RetentionPeriodHours, StreamEncryption, and Tags. Name changes require
 * replacement (handled by the deployment layer).
 */
export async function update(
  this: KinesisStreamProvider,
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
  // Before each call that changes the stream: a failure from there on leaves
  // the key unsettled for the next deploy to converge.
  const markUnsettled = (key: string): void => context?.markUnsettled?.(key);
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
      markUnsettled('StreamModeDetails');
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
      // go-to-k/cdkd#5487: an unsettled mode switch may have moved the shards
      // whatever the two modes now say, so the live count is compared.
      const oldShardCount =
        modeChanged || context?.unsettledProperties?.has('StreamModeDetails') === true
          ? await this.getOpenShardCount(physicalId)
          : Number(previousProperties['ShardCount'] ?? 1);

      if (newShardCount !== oldShardCount) {
        this.logger.debug(
          `Updating shard count for ${physicalId}: from ${oldShardCount} to ${newShardCount}`
        );

        markUnsettled('ShardCount');
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
      markUnsettled('RetentionPeriodHours');
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
      properties['Tags'],
      {
        forceUpsert: context?.unsettledProperties?.has('Tags') === true,
        beforeWrite: () => markUnsettled('Tags'),
        afterAdded: (keys) => {
          if (keys.length > 0) context?.markAttempted?.('Tags', keys);
        },
      }
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
      markUnsettled('StreamEncryption');
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
    // A REMOVAL resets the size to AWS's default, as CloudFormation does
    // (go-to-k/cdkd#1160; CFn A/B, us-east-1: 2048 -> removed -> 1024, both
    // alone and beside a RetentionPeriodHours change). Only an ABSENT
    // desired side is a removal; an unusable one warned above and keeps the
    // live size. An unusable PREVIOUS side reads as the default, as the
    // retention sibling reads its own, so it triggers no reset call.
    const newMaxRecordSize =
      desiredSizeRead.kind === 'absent'
        ? DEFAULT_MAX_RECORD_SIZE_KIB
        : comparableRecordSize(properties['MaxRecordSizeInKiB'], mask);
    const recordedMaxRecordSize = comparableRecordSize(
      previousProperties['MaxRecordSizeInKiB'],
      mask
    );
    const oldMaxRecordSize = recordedMaxRecordSize ?? DEFAULT_MAX_RECORD_SIZE_KIB;
    if (newMaxRecordSize !== undefined && newMaxRecordSize !== oldMaxRecordSize) {
      this.logger.debug(
        `Updating max record size for ${physicalId}: from ${recordedMaxRecordSize ?? 'no value'} to ${newMaxRecordSize}`
      );
      markUnsettled('MaxRecordSizeInKiB');
      await this.getClient().send(
        new UpdateMaxRecordSizeCommand({
          StreamARN: await this.resolveStreamArn(physicalId),
          MaxRecordSizeInKiB: newMaxRecordSize,
        })
      );
      await this.waitForStreamActive(physicalId);
    }

    await this.reconcileDistributionStrategy(
      physicalId,
      streamMode,
      properties,
      previousProperties,
      mask,
      warn,
      markUnsettled
    );

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
      // go-to-k/cdkd#5503: converging an unsettled DesiredShardLevelMetrics
      // leaves every live metric that neither the record nor the template
      // names (`readUnsettled` keeps them off the previous side), as
      // CloudFormation does. Say so: one may be a metric the failed update
      // itself enabled.
      if (context?.unsettledProperties?.has('DesiredShardLevelMetrics') === true) {
        await this.warnUndeclaredLiveMetrics(
          physicalId,
          [...previousSet, ...desiredSet],
          warn,
          mask
        );
      }
      const toEnable = desiredSet.filter((m) => !previousSet.includes(m));
      if (toDisable.length > 0 || toEnable.length > 0) markUnsettled('DesiredShardLevelMetrics');
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
        const enabled = await this.getClient().send(
          new EnableEnhancedMonitoringCommand({
            StreamName: physicalId,
            ShardLevelMetrics: toEnable,
          })
        );
        // go-to-k/cdkd#5498: AFTER the call resolved, the metrics it turned on
        // — the ones the response did not already report as current.
        // A live literal `ALL` names every metric, so it is expanded first.
        const current = expandShardLevelMetrics(enabled?.CurrentShardLevelMetrics ?? []);
        const before = new Set(Array.isArray(current) ? (current as unknown[]) : []);
        const added = toEnable.filter((metric) => !before.has(metric));
        if (added.length > 0) context?.markAttempted?.('DesiredShardLevelMetrics', added);
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
    throw this.wrapCaughtError(
      mask,
      error,
      (text) =>
        new ProvisioningError(
          `Failed to update Kinesis stream ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          physicalId,
          cause
        )
    );
  }
}

/**
 * Reconcile `RecordDistributionStrategy` on update (go-to-k/cdkd#2762) via
 * `UpdateStreamRecordDistributionStrategy`, which takes the stream ARN.
 *
 * - usable and different from the record: sent.
 * - ABSENT while the record held one: a template REMOVAL. CloudFormation
 *   resets it to `USER_PARTITION_KEY` (CFn A/B), so that is sent — unless the
 *   stream is now PROVISIONED, where the strategy does not apply and AWS
 *   accepts it only on ON_DEMAND.
 * - unusable: warned and left alone (the update path is state-replay
 *   reachable, so it cannot refuse; the same value is refused on create).
 *
 * The previous side is a state record, read leniently: an unusable one
 * counts as "not recorded".
 *
 * ON_DEMAND + `AUTO` -> PROVISIONED is refused by AWS whatever the template
 * says about the strategy: `UpdateStreamMode` refuses while `AUTO` is set,
 * and the strategy can only be set on ON_DEMAND. The mode switch runs before
 * this reconcile, so that update fails, as it does under CloudFormation,
 * which needs `USER_PARTITION_KEY` deployed first (CFn A/B on
 * go-to-k/cdkd#2762).
 */
export async function reconcileDistributionStrategy(
  this: KinesisStreamProvider,
  physicalId: string,
  streamMode: string,
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>,
  mask: MaskerFn,
  warn: (message: string) => void,
  markUnsettled: (key: string) => void
): Promise<void> {
  const desired = readDistributionStrategy(properties['RecordDistributionStrategy'], mask);
  if (desired.kind === 'unusable') {
    warn(
      `${desired.reason}. Leaving the record distribution strategy on ${physicalId} ` +
        `unchanged; the same value is REFUSED on a template-path create`
    );
    return;
  }
  const previous = readDistributionStrategy(previousProperties['RecordDistributionStrategy'], mask);
  const recorded = previous.kind === 'usable' ? previous.strategy : undefined;
  let target: RecordDistributionStrategy | undefined;
  if (desired.kind === 'usable') {
    if (desired.strategy === recorded) return;
    target = desired.strategy;
  } else {
    if (recorded === undefined || recorded === DEFAULT_RECORD_DISTRIBUTION_STRATEGY) return;
    // A PROVISIONED stream has no distribution strategy to reset: the
    // property applies to ON_DEMAND streams only (#2762), so nothing is sent.
    if (streamMode !== 'ON_DEMAND') return;
    target = DEFAULT_RECORD_DISTRIBUTION_STRATEGY;
  }
  this.logger.debug(
    mask(
      safeMsg`Updating record distribution strategy for ${physicalId}: from ${recorded ?? 'no value'} to ${target}`
    )
  );
  markUnsettled('RecordDistributionStrategy');
  await this.getClient().send(
    new UpdateStreamRecordDistributionStrategyCommand({
      StreamARN: await this.resolveStreamArn(physicalId),
      RecordDistributionStrategy: target,
    })
  );
  await this.waitForStreamActive(physicalId);
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
export function effectiveMetricsProperties(
  this: KinesisStreamProvider,
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
 * Apply a diff between old and new CFn-shape Tags arrays via Kinesis's
 * `AddTagsToStream` (map shape) / `RemoveTagsFromStream` (TagKeys list)
 * APIs. Both sides are read through `planTagDiff` (go-to-k/cdkd#3994): an
 * unreadable record untags nothing.
 */
export async function applyTagDiff(
  this: KinesisStreamProvider,
  streamName: string,
  resourceType: string,
  logicalId: string,
  oldTagsRaw: unknown,
  newTagsRaw: unknown,
  unsettled: {
    forceUpsert: boolean;
    beforeWrite: () => void;
    // go-to-k/cdkd#5498: the tag keys an accepted AddTagsToStream added that
    // the record lacked.
    afterAdded?: (keys: string[]) => void;
  } = {
    forceUpsert: false,
    beforeWrite: () => undefined,
  }
): Promise<void> {
  const plan = planTagDiff(oldTagsRaw, newTagsRaw);
  const tagWarning = tagPlanWarning(plan, resourceType, logicalId);
  if (tagWarning !== undefined) {
    this.logger.warn(tagWarning);
  }
  // go-to-k/cdkd#5487: unsettled Tags re-send every template tag (AWS may
  // lack the ones the failed update did not reach) and remove only the
  // recorded ones the template dropped.
  const tagsToAdd = Object.fromEntries(
    unsettled.forceUpsert ? planTagDiff(undefined, newTagsRaw).set : plan.set
  );
  const tagsToRemove = plan.remove;
  if (tagsToRemove.length > 0 || Object.keys(tagsToAdd).length > 0) unsettled.beforeWrite();

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
    // A malformed recorded tag list cannot say which keys are new: record none
    // (a missing name only keeps a tag, never removes one).
    let recordedKeys: Set<string> | undefined;
    try {
      recordedKeys = new Set([...planTagDiff(undefined, oldTagsRaw).set.keys()]);
    } catch {
      recordedKeys = undefined;
    }
    unsettled.afterAdded?.(
      Object.keys(tagsToAdd).filter((key) => recordedKeys !== undefined && !recordedKeys.has(key))
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
 * go-to-k/cdkd#5487: `readCurrentState`, with `ShardCount` the OPEN shard
 * count the update compares (`readCurrentState` counts closed shards too).
 */
/**
 * go-to-k/cdkd#5503: warn about each live shard-level metric outside
 * `named`. It is left enabled, and the warning says how to disable it.
 * Best-effort: a failed read only loses the warning.
 */
export async function warnUndeclaredLiveMetrics(
  this: KinesisStreamProvider,
  physicalId: string,
  named: readonly string[],
  warn: (message: string) => void,
  mask: MaskerFn
): Promise<void> {
  let live: string[];
  try {
    const resp = await this.getClient().send(
      new DescribeStreamSummaryCommand({ StreamName: physicalId })
    );
    live = (resp.StreamDescriptionSummary?.EnhancedMonitoring ?? []).flatMap(
      (entry) => entry.ShardLevelMetrics ?? []
    );
  } catch {
    return;
  }
  const expandedLive = expandShardLevelMetrics(live);
  const undeclared = (Array.isArray(expandedLive) ? (expandedLive as string[]) : live).filter(
    (metric) => metric !== 'ALL' && !named.includes(metric)
  );
  if (undeclared.length === 0) return;
  // A secret-derived stream name is masked in the message, so a command
  // carrying it would not run: it is withheld, as the DynamoDB warning does.
  const secretDerived = mask(physicalId) !== physicalId;
  warn(
    `Kinesis stream ${physicalId} has shard-level metrics enabled that neither cdkd's record ` +
      `nor the template declares (${undeclared.join(', ')}), so cdkd left them enabled while ` +
      `converging the unsettled DesiredShardLevelMetrics (CloudFormation never disables a ` +
      `metric it did not record). Another tool may have enabled them, or an earlier failed ` +
      `cdkd update may have; cdkd cannot tell which. If they should be off, disable them ` +
      (secretDerived
        ? `with DisableEnhancedMonitoring for those metrics.`
        : `with: aws kinesis disable-enhanced-monitoring --stream-name ${physicalId} ` +
          `--shard-level-metrics ${undeclared.join(' ')} (in the stream's region)`)
  );
}
