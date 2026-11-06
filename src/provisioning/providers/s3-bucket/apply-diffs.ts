/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return */
import {
  DeleteBucketAnalyticsConfigurationCommand,
  DeleteBucketCorsCommand,
  DeleteBucketEncryptionCommand,
  DeleteBucketIntelligentTieringConfigurationCommand,
  DeleteBucketInventoryConfigurationCommand,
  DeleteBucketLifecycleCommand,
  DeleteBucketMetricsConfigurationCommand,
  DeleteBucketOwnershipControlsCommand,
  DeleteBucketReplicationCommand,
  DeleteBucketWebsiteCommand,
  PutObjectLockConfigurationCommand,
} from '@aws-sdk/client-s3';
import {
  type PerItemApplyOutcome,
  configItemId,
  declaresBucketObjectLock,
  declaresNestedObjectLock,
} from './shared.js';
import { S3BucketProvider } from '../s3-bucket-provider.js';
import type { UpdateContext } from '../../../types/resource.js';
import { configStringRefusal, readConfigString } from '../../config-shape.js';
import { effectiveLifecycleConfiguration } from './lifecycle-fold.js';
import { effectiveNotificationConfiguration } from './effective-items.js';
import { metadataConfigurationRefusal } from './metadata.js';
import { safeMsg } from '../../../utils/display-safe.js';

/**
 * Apply the diff between previous and new sub-configs, issuing Put / Delete
 * SDK calls only for differing keys. Called from `update()` TWICE on a
 * template-path update: first on {@link noWriteProbe} with `refuseUnusable`
 * (the pre-flight, which writes nothing), then for real.
 *
 * PublicAccessBlockConfiguration and Tags stay on `applyConfiguration` /
 * `applyTagDiff`. `PublicAccessBlockConfiguration` is deliberately NOT on the
 * diff path: a live CloudFormation A/B (issue #1466) confirmed CFn ALSO
 * leaves the block in place when the property is removed, so cdkd is at
 * parity and adding an `onRemove` here would CREATE a divergence.
 *
 * VersioningConfiguration / OwnershipControls / BucketEncryption used to sit
 * on that always-PUT path too, on the assumption that their APIs had no clean
 * "delete" counterpart. That was wrong in all three cases and made removal a
 * silent no-op (issue #1466): the same A/B showed CFn suspends versioning,
 * deletes ownership controls, and resets encryption to the SSE-S3 default.
 * They are now diffed here like every other Put/Delete pair.
 *
 * @returns the per-property overrides for `effectiveProperties` (issue
 *   #1612): on THIS path a skipped Put means AWS still holds the
 *   previously-applied configuration, so the override is the PREVIOUS value —
 *   `undefined` when the previous side declared none, which removes the key.
 *   Dropping the key unconditionally instead would be wrong in the other
 *   direction: a later template that REMOVES the block would then derive no
 *   removal and the live configuration would survive forever.
 */
export async function applySubConfigDiffs(
  this: S3BucketProvider,
  bucketName: string,
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>,
  context?: UpdateContext,
  // `true` only from `update()`'s template-path pre-flight, which runs this
  // method on {@link noWriteProbe} (issue #3740): the eight per-config
  // appliers below then get NO warn callback, so each refuses exactly where
  // it would otherwise warn-and-skip — the create-path refusal, with the
  // same predicate, key, fallback and path, and only for the configurations
  // this diff would actually Put.
  refuseUnusable = false
): Promise<Map<string, unknown>> {
  const overrides = new Map<string, unknown>();
  /**
   * The warn-and-skip callback the eight per-config appliers take on this
   * path, or `undefined` in the pre-flight, where each of them throws
   * instead. Reached with a malformed value only by the two state-borne
   * callers (the rollback revert arms' `replayingState`, `cdkd drift
   * --revert`'s `desiredFromAwsReadback`), whose bag has no template-side
   * remedy: a template-path update refuses it first, in `update()`.
   */
  const applierWarn: ((message: string) => void) | undefined = refuseUnusable
    ? undefined
    : (m) => this.logger.warn(m);
  // The REAL masker for this call, not a decorative parameter: the
  // destination-shape refusals below quote values read straight off the
  // desired `properties` bag, which arrives RESOLVED (issue #2178).
  const maskSecrets = this.shownMask;
  /** Record a WHOLE-BLOCK skip: the effective value is the previous one. */
  const retainPrevious = (key: string): void => {
    overrides.set(key, previousProperties[key]);
  };
  /**
   * Record a WHOLE-BLOCK fold: the effective value is what was SENT.
   *
   * Identity means the declared bag IS what went on the wire, so no override
   * is set at all and the engine records the desired properties unchanged —
   * which is what keeps an ordinary CFn-spelled template byte-for-byte
   * unaffected by the #1748 folds.
   */
  const recordEffectiveFold = (key: string, sent: unknown): void => {
    if (sent !== properties[key]) overrides.set(key, sent);
  };
  /**
   * Per-property accumulator for one of the four `Id`-keyed appliers.
   *
   * Keyed by `Id` rather than by index because on THIS path the diff loop
   * hands the applier exactly one item per call (so every outcome index is
   * 0) and the id is all the loop knows about it.
   */
  const itemOutcomes = (): {
    skipped: Set<string>;
    sentItems: Map<string, Record<string, unknown>>;
    record: (id: string, outcome: PerItemApplyOutcome) => void;
  } => {
    const skipped = new Set<string>();
    const sentItems = new Map<string, Record<string, unknown>>();
    return {
      skipped,
      sentItems,
      record: (id, outcome) => {
        if (outcome.skipped.length > 0) skipped.add(id);
        const sent = outcome.substituted.get(0);
        if (sent !== undefined) sentItems.set(id, sent);
      },
    };
  };
  /** Record a PER-ITEM skip / substitution set against the desired / previous arrays. */
  const retainPreviousItems = (
    key: string,
    collected: {
      skipped: ReadonlySet<string>;
      sentItems: ReadonlyMap<string, Record<string, unknown>>;
    }
  ): void => {
    const { skipped: skippedIds, sentItems } = collected;
    if (skippedIds.size === 0 && sentItems.size === 0) return;
    const desired = properties[key];
    if (!Array.isArray(desired)) {
      // Unreachable: `diffArrayConfigById` iterates the desired value, so a
      // non-array would have thrown before any item could be skipped. Logged
      // rather than dropped silently, because reaching it means a skip went
      // UNRECORDED and the phantom drift this method removes is back.
      this.logger.debug(
        `Bucket ${this.shown(bucketName)}: ${skippedIds.size + sentItems.size} skipped or substituted ` +
          `${key} item(s) could not be recorded — the desired value is not an array`
      );
      return;
    }
    const previous = previousProperties[key];
    overrides.set(
      key,
      S3BucketProvider.buildEffectiveItemArray(
        desired as Array<Record<string, unknown>>,
        Array.isArray(previous) ? (previous as Array<Record<string, unknown>>) : undefined,
        (item) => {
          const id = configItemId(item);
          return id !== undefined && skippedIds.has(id);
        },
        (item) => {
          const id = configItemId(item);
          return id !== undefined ? sentItems.get(id) : undefined;
        }
      )
    );
  };
  // Versioning is split by RESULTING STATUS, not by transition kind.
  //
  // S3 rejects PutBucketVersioning(Suspended) while a replication
  // configuration is still active, so EVERY path that lands on 'Suspended'
  // must run after the replication diff below -- both the removal
  // (property dropped => CFn resets to Suspended) AND an explicit
  // `{ Status: 'Suspended' }` in the template. Deferring only the removal
  // would leave the explicit form on the early path and hit exactly the S3
  // rejection this split exists to avoid; `cdkd drift --revert` reaches that
  // form routinely, because `readCurrentState` always emits
  // `{ Status: 'Suspended' }` for an un-versioned bucket.
  //
  // The ENABLE direction stays early: an ADDED replication configuration
  // requires versioning to already be on.
  const previousVersioning = previousProperties['VersioningConfiguration'] as
    | Record<string, unknown>
    | undefined;
  const nextVersioning = properties['VersioningConfiguration'] as
    | Record<string, unknown>
    | undefined;
  // Nullish (not strict-undefined) to match `diffSubConfig`'s own semantics;
  // a desired `null` is a removal there, so it must be one here too.
  const versioningChanged =
    JSON.stringify(previousVersioning ?? null) !== JSON.stringify(nextVersioning ?? null);
  // An absent (or `{}`) VersioningConfiguration means Suspended, so the
  // effective desired status is what decides which side of the split runs.
  // Guarded on the DESIRED side only (issue #1471): `previousVersioning`
  // comes from cdkd state, and refusing a malformed value there would make a
  // stack whose state already holds one permanently undeployable. It is only
  // compared as a whole above, never field-read, so it stays permissive.
  // Computing this BEFORE `applyVersioning` is load-bearing — a malformed
  // desired value used to resolve to 'Suspended' here and take the SUSPEND
  // branch below, turning versioning off on a live bucket.
  //
  // The refusal is probed rather than thrown (issue #1605) — on the paths
  // that still reach it. A TEMPLATE-path update never does with a malformed
  // value: `update()` refuses it before any call (issue #3728,
  // `versioningOrLoggingRefusal`). What arrives here is the rollback
  // executor's revert arms (`replayingState`) and `cdkd drift --revert`
  // (`desiredFromAwsReadback`), whose desired bag the user cannot edit from
  // the template, so a throw would be un-actionable. The downgrade was
  // UNCONDITIONAL until #3141 gave the revert arms a flag:
  // `desiredFromAwsReadback` alone distinguishes a readback from everything
  // else, not a REPLAY from a template, and this guard's question is the
  // latter. And it must be a SKIP of
  // BOTH arms, not a default: taking the Suspended fallback here would route
  // a malformed record straight into the suspend branch below and turn
  // versioning off on a live bucket — the very thing computing this value
  // before `applyVersioning` was introduced to prevent.
  const versioningRefusal = configStringRefusal(
    nextVersioning,
    'Status',
    'Suspended',
    'AWS::S3::Bucket VersioningConfiguration'
  );
  // Gated on `versioningChanged` (PR review nit): an unchanged-but-malformed
  // recorded value is not a pending operation, and warning about it on every
  // deploy would be noise about something this run was never going to do.
  if (versioningRefusal !== undefined && versioningChanged) {
    this.logger.warn(
      `Bucket ${this.shown(bucketName)}: ${versioningRefusal}. Leaving the bucket's LIVE versioning state ` +
        `unchanged — neither enabling nor suspending it; the same value is REFUSED on a ` +
        `template-path create`
    );
    // Neither arm of the split below runs, so AWS keeps the previously
    // applied versioning state and that is what state must describe.
    // Gated on `versioningChanged` alongside the warning: an
    // unchanged-but-malformed recorded value was not going to be applied by
    // this run either way, and rewriting the record for it would churn state
    // on every deploy.
    retainPrevious('VersioningConfiguration');
  }
  const desiredVersioningStatus =
    versioningRefusal === undefined
      ? readConfigString(
          nextVersioning,
          'Status',
          'Suspended',
          'AWS::S3::Bucket VersioningConfiguration'
        )
      : undefined;

  // `nextVersioning != null` is implied by the status check (a null value
  // resolves to 'Suspended'); it is kept for TypeScript's narrowing.
  //
  // `versioningRefusal === undefined` leads and is NOT redundant, though the
  // reason is not the obvious one and a review round corrected it: on a
  // refusal `desiredVersioningStatus` is `undefined`, which satisfies
  // `!== 'Suspended'`, so control would reach `applyVersioning` — and since
  // THAT call passes no `onUnusable`, its own read would THROW rather than
  // reach the Put. The guard is what turns that throw into the intended
  // skip. (The `onUnusable` argument below is defense-in-depth for the same
  // shape: correctness must not rest on this probe and the applier's read
  // being invoked with identical key / fallback / path.)
  //
  // The rest of the condition is unchanged — in particular it stays a
  // `!== 'Suspended'` test rather than an `=== 'Enabled'` one, so an
  // unrecognized status still reaches AWS and is rejected there by name
  // instead of being silently skipped.
  if (
    versioningRefusal === undefined &&
    versioningChanged &&
    nextVersioning != null &&
    desiredVersioningStatus !== 'Suspended'
  ) {
    // The applier re-probes (defense-in-depth against this probe and its own
    // read drifting apart), so honour ITS answer rather than assuming the
    // guard above already settled it.
    const applied = await this.applyVersioning(bucketName, nextVersioning, (m) =>
      this.logger.warn(m)
    );
    if (!applied) retainPrevious('VersioningConfiguration');
  }

  // Ownership controls (per-id-free single config; empty Rules == absent)
  const ownershipEmptyDesired = S3BucketProvider.declaresEmptyCollection(
    properties['OwnershipControls'],
    'Rules'
  );
  await this.diffSubConfig(
    bucketName,
    S3BucketProvider.emptyListConfigToUndefined(
      previousProperties['OwnershipControls'] as
        | { Rules: Array<{ ObjectOwnership: string }> }
        | undefined,
      'Rules'
    ),
    S3BucketProvider.emptyListConfigToUndefined(
      properties['OwnershipControls'] as { Rules: Array<{ ObjectOwnership: string }> } | undefined,
      'Rules'
    ),
    async (cfg) => this.applyOwnershipControls(bucketName, cfg),
    async () => {
      // An empty DECLARED collection is not a removal intent (issue #1713) —
      // see `declaresEmptyCollection`. Skip and keep the live configuration,
      // exactly as the lifecycle / CORS arms do; only a genuinely ABSENT
      // property reaches the Delete.
      // An empty DECLARED collection is not a removal intent from a TEMPLATE
      // (issue #1713) — but it IS one from `cdkd drift --revert`, whose
      // desired bag is an AWS readback and whose `readCurrentState` spells
      // "not set" as exactly this empty collection (issue #1732). Same bytes,
      // opposite meanings, so the caller has to say which it is.
      if (ownershipEmptyDesired && context?.desiredFromAwsReadback !== true) {
        this.emptyCollectionSkip(
          'OwnershipControls',
          'OwnershipControls.Rules',
          previousProperties,
          retainPrevious
        );
        return;
      }
      await this.s3Client.send(new DeleteBucketOwnershipControlsCommand({ Bucket: bucketName }));
      this.logger.debug(`Deleted ownership controls on bucket ${this.shown(bucketName)}`);
    }
  );

  // Bucket encryption (empty ServerSideEncryptionConfiguration == absent;
  // DeleteBucketEncryption reverts the bucket to the SSE-S3 / AES256 default)
  const encryptionEmptyDesired = S3BucketProvider.declaresEmptyCollection(
    properties['BucketEncryption'],
    'ServerSideEncryptionConfiguration'
  );
  await this.diffSubConfig(
    bucketName,
    S3BucketProvider.emptyListConfigToUndefined(
      previousProperties['BucketEncryption'] as
        | { ServerSideEncryptionConfiguration: Array<Record<string, unknown>> }
        | undefined,
      'ServerSideEncryptionConfiguration'
    ),
    S3BucketProvider.emptyListConfigToUndefined(
      properties['BucketEncryption'] as
        | { ServerSideEncryptionConfiguration: Array<Record<string, unknown>> }
        | undefined,
      'ServerSideEncryptionConfiguration'
    ),
    async (cfg) => this.applyBucketEncryption(bucketName, cfg),
    async () => {
      // Same as OwnershipControls above, and this is the arm with teeth: a
      // Delete here silently downgrades a declared `aws:kms` default to the
      // SSE-S3 / AES256 one on a template whose only fault is a collapsed
      // array (issue #1713).
      // An empty DECLARED collection is not a removal intent from a TEMPLATE
      // (issue #1713) — but it IS one from `cdkd drift --revert`, whose
      // desired bag is an AWS readback and whose `readCurrentState` spells
      // "not set" as exactly this empty collection (issue #1732). Same bytes,
      // opposite meanings, so the caller has to say which it is.
      if (encryptionEmptyDesired && context?.desiredFromAwsReadback !== true) {
        this.emptyCollectionSkip(
          'BucketEncryption',
          'BucketEncryption.ServerSideEncryptionConfiguration',
          previousProperties,
          retainPrevious
        );
        return;
      }
      await this.s3Client.send(new DeleteBucketEncryptionCommand({ Bucket: bucketName }));
      this.logger.debug(`Deleted bucket encryption on bucket ${this.shown(bucketName)}`);
    }
  );

  // Lifecycle
  await this.diffSubConfig(
    bucketName,
    previousProperties['LifecycleConfiguration'] as
      | { Rules: Array<Record<string, unknown>> }
      | undefined,
    properties['LifecycleConfiguration'] as { Rules: Array<Record<string, unknown>> } | undefined,
    async (cfg) => {
      // Skip empty-rules placeholder (Class 2) — unless the desired bag is an
      // AWS READBACK, where the same empty array is how `readLifecycle`
      // spells "no lifecycle configuration" (it returns `{Rules: []}` on
      // `NoSuchLifecycleConfiguration`), so `cdkd drift --revert` means
      // REMOVE by it (issue #1732). Without this the revert reported success,
      // changed nothing, and `retainPrevious` recorded the AWS-current rules
      // as the new baseline — silently accepting the drift it was asked to
      // undo. Same shape as the OwnershipControls / BucketEncryption arms
      // above; found by review, which noted that leaving it would violate the
      // enumerate-every-caller rule this change itself wrote.
      if (!cfg.Rules || !Array.isArray(cfg.Rules) || cfg.Rules.length === 0) {
        if (context?.desiredFromAwsReadback === true) {
          await this.s3Client.send(new DeleteBucketLifecycleCommand({ Bucket: bucketName }));
          this.logger.debug(
            `Deleted lifecycle configuration on bucket ${this.shown(bucketName)} (reverting to an unset baseline)`
          );
          return;
        }
        this.emptyCollectionSkip(
          'LifecycleConfiguration',
          'LifecycleConfiguration.Rules',
          previousProperties,
          retainPrevious
        );
        return;
      }
      // WARN, never throw, on the state-borne update paths (issue #1579) —
      // same rationale as the analytics sibling below.
      const applied = await this.applyLifecycleConfiguration(bucketName, cfg, applierWarn);
      if (!applied) retainPrevious('LifecycleConfiguration');
      // Recorded only once the Put has SUCCEEDED, and only when the Put
      // actually RAN (issue #1748): a skipped Put leaves AWS holding the
      // previous configuration, which `retainPrevious` above already records —
      // overwriting that with a fold of the DESIRED bag would describe a call
      // that never went out.
      else recordEffectiveFold('LifecycleConfiguration', effectiveLifecycleConfiguration(cfg));
    },
    async () => {
      await this.s3Client.send(new DeleteBucketLifecycleCommand({ Bucket: bucketName }));
      this.logger.debug(`Deleted lifecycle configuration on bucket ${this.shown(bucketName)}`);
    }
  );

  // CORS
  await this.diffSubConfig(
    bucketName,
    previousProperties['CorsConfiguration'] as
      | { CorsRules: Array<Record<string, unknown>> }
      | undefined,
    properties['CorsConfiguration'] as { CorsRules: Array<Record<string, unknown>> } | undefined,
    async (cfg) => {
      // The CORS twin of the lifecycle arm above (issue #1732): `readCors`
      // returns `{CorsRules: []}` on `NoSuchCORSConfiguration`, so on a
      // readback-derived desired bag the empty array means REMOVE.
      if (!cfg.CorsRules || !Array.isArray(cfg.CorsRules) || cfg.CorsRules.length === 0) {
        if (context?.desiredFromAwsReadback === true) {
          await this.s3Client.send(new DeleteBucketCorsCommand({ Bucket: bucketName }));
          this.logger.debug(
            `Deleted CORS configuration on bucket ${this.shown(bucketName)} (reverting to an unset baseline)`
          );
          return;
        }
        this.emptyCollectionSkip(
          'CorsConfiguration',
          'CorsConfiguration.CorsRules',
          previousProperties,
          retainPrevious
        );
        return;
      }
      await this.applyCorsConfiguration(bucketName, cfg);
    },
    async () => {
      await this.s3Client.send(new DeleteBucketCorsCommand({ Bucket: bucketName }));
      this.logger.debug(`Deleted CORS configuration on bucket ${this.shown(bucketName)}`);
    }
  );

  // Website
  await this.diffSubConfig(
    bucketName,
    previousProperties['WebsiteConfiguration'] as Record<string, unknown> | undefined,
    properties['WebsiteConfiguration'] as Record<string, unknown> | undefined,
    async (cfg) => this.applyWebsiteConfiguration(bucketName, cfg),
    async () => {
      await this.s3Client.send(new DeleteBucketWebsiteCommand({ Bucket: bucketName }));
      this.logger.debug(`Deleted website configuration on bucket ${this.shown(bucketName)}`);
    }
  );

  // Logging — no DeleteBucketLogging API; clearing is via PutBucketLogging
  // with empty BucketLoggingStatus.
  await this.diffSubConfig(
    bucketName,
    previousProperties['LoggingConfiguration'] as Record<string, unknown> | undefined,
    properties['LoggingConfiguration'] as Record<string, unknown> | undefined,
    // Warn-and-skip, reached only by the state-borne callers with a
    // malformed block: a TEMPLATE-path update refuses one before any call
    // (issue #3728, `versioningOrLoggingRefusal`), since throwing here —
    // mid-update — would strand everything applied above. The rollback
    // revert arms and `cdkd drift --revert` keep this warning: their desired
    // bag has no template-side remedy.
    async (cfg) => {
      const applied = await this.applyLoggingConfiguration(bucketName, cfg, (m) =>
        this.logger.warn(m)
      );
      if (!applied) retainPrevious('LoggingConfiguration');
    },
    // The CLEAR arm passes `undefined`, which is the legitimate removal and
    // can never refuse — so it needs no downgrade.
    async () => {
      await this.applyLoggingConfiguration(bucketName, undefined);
    }
  );

  // Notification — no DeleteBucketNotification API; clearing is via
  // PutBucketNotificationConfiguration with empty NotificationConfiguration.
  await this.diffSubConfig(
    bucketName,
    previousProperties['NotificationConfiguration'] as Record<string, unknown> | undefined,
    properties['NotificationConfiguration'] as Record<string, unknown> | undefined,
    async (cfg) => {
      // WARN, never throw, on the state-borne update paths (issue #1759) —
      // the same rationale as the lifecycle / replication siblings: a
      // rollback and `cdkd drift --revert` both replay `update()` with a cdkd
      // STATE record as the desired bag, so a refusal here would leave the
      // bucket un-revertable with only a hand-edit of state.json as a remedy.
      const applied = await this.applyNotificationConfiguration(bucketName, cfg, applierWarn);
      // The skip unit is the WHOLE notification configuration (the Put is a
      // full replace), so AWS still holds the previously-applied one — which
      // is what state must describe (issue #1612's UPDATE answer).
      if (!applied) retainPrevious('NotificationConfiguration');
      // Issue #1748 / #1759. Otherwise this applier is a FULL REPLACE, so a
      // returning call means AWS holds exactly what was sent.
      else
        recordEffectiveFold('NotificationConfiguration', effectiveNotificationConfiguration(cfg));
    },
    // The CLEAR arm sends an empty configuration and has no declared bag to
    // fold, so it needs no override — and no `onUnusable` either, since there
    // is no declared value left to refuse.
    async () => {
      await this.applyNotificationConfiguration(bucketName, undefined);
    }
  );

  // Replication
  await this.diffSubConfig(
    bucketName,
    previousProperties['ReplicationConfiguration'] as Record<string, unknown> | undefined,
    properties['ReplicationConfiguration'] as Record<string, unknown> | undefined,
    async (cfg) => {
      const applied = await this.applyReplicationConfiguration(bucketName, cfg, applierWarn);
      if (!applied) retainPrevious('ReplicationConfiguration');
    },
    async () => {
      await this.s3Client.send(new DeleteBucketReplicationCommand({ Bucket: bucketName }));
      this.logger.debug(`Deleted replication configuration on bucket ${this.shown(bucketName)}`);
    }
  );

  // Object Lock — no DeleteObjectLockConfiguration API; the bucket-level
  // ObjectLockEnabled flag is set at creation time and cannot be cleared
  // via Put. The Rule (default retention) can be reset via Put with no
  // Rule, so a transition from "configured" -> undefined just sends an
  // empty-Rule Put. AWS accepts this for buckets that already have
  // ObjectLockEnabled.
  await this.diffSubConfig(
    bucketName,
    previousProperties['ObjectLockConfiguration'] as Record<string, unknown> | undefined,
    properties['ObjectLockConfiguration'] as Record<string, unknown> | undefined,
    async (cfg) => {
      const applied = await this.applyObjectLockConfiguration(bucketName, cfg, applierWarn);
      if (!applied) retainPrevious('ObjectLockConfiguration');
    },
    async () => {
      await this.s3Client.send(
        new PutObjectLockConfigurationCommand({
          Bucket: bucketName,
          ObjectLockConfiguration: { ObjectLockEnabled: 'Enabled' },
        })
      );
      this.logger.debug(`Cleared object lock rule on bucket ${this.shown(bucketName)}`);
    }
  );

  // Accelerate — no DeleteBucketAccelerate API; clearing is via
  // PutBucketAccelerateConfiguration with Status='Suspended'.
  await this.diffSubConfig(
    bucketName,
    previousProperties['AccelerateConfiguration'] as Record<string, unknown> | undefined,
    properties['AccelerateConfiguration'] as Record<string, unknown> | undefined,
    async (cfg) => this.applyAccelerateConfiguration(bucketName, cfg),
    async () => this.applyAccelerateConfiguration(bucketName, { AccelerationStatus: 'Suspended' })
  );

  // Metrics (per-id diff)
  //
  // Each `onPut` applies exactly ONE item, so a non-empty skip list from the
  // applier names THAT id — which is the per-item unit `retainPreviousItems`
  // rebuilds the effective array from (issue #1612).
  const metricsOutcomes = itemOutcomes();
  await this.diffArrayConfigById(
    bucketName,
    previousProperties['MetricsConfigurations'] as Array<Record<string, unknown>> | undefined,
    properties['MetricsConfigurations'] as Array<Record<string, unknown>> | undefined,
    // WARN, never throw, on the state-borne update paths (issue #1579) —
    // same rationale as the analytics sibling below.
    async (id, cfg) => {
      const outcome = await this.applyMetricsConfigurations(bucketName, [cfg], applierWarn);
      metricsOutcomes.record(String(id), outcome);
    },
    async (id) => {
      await this.s3Client.send(
        new DeleteBucketMetricsConfigurationCommand({ Bucket: bucketName, Id: id })
      );
      this.logger.debug(
        `Deleted metrics configuration ${this.shown(id)} on bucket ${this.shown(bucketName)}`
      );
    }
  );
  retainPreviousItems('MetricsConfigurations', metricsOutcomes);

  // Analytics (per-id diff)
  const analyticsOutcomes = itemOutcomes();
  await this.diffArrayConfigById(
    bucketName,
    previousProperties['AnalyticsConfigurations'] as Array<Record<string, unknown>> | undefined,
    properties['AnalyticsConfigurations'] as Array<Record<string, unknown>> | undefined,
    // WARN, never throw, on the state-borne update paths:
    // `rollback-executor.ts` and `drift --revert` replay `update()` with a
    // historical cdkd STATE record as the desired bag, so a refusal here
    // would strand the resource with no template-side remedy (issue #1493
    // item 2). A template-path update refuses in `update()` instead, before
    // any call (issue #3740).
    async (id, cfg) => {
      const outcome = await this.applyAnalyticsConfigurations(
        bucketName,
        [cfg],
        applierWarn,
        maskSecrets
      );
      analyticsOutcomes.record(String(id), outcome);
    },
    async (id) => {
      await this.s3Client.send(
        new DeleteBucketAnalyticsConfigurationCommand({ Bucket: bucketName, Id: id })
      );
      this.logger.debug(
        `Deleted analytics configuration ${this.shown(id)} on bucket ${this.shown(bucketName)}`
      );
    }
  );
  retainPreviousItems('AnalyticsConfigurations', analyticsOutcomes);

  // IntelligentTiering (per-id diff)
  const intelligentTieringOutcomes = itemOutcomes();
  await this.diffArrayConfigById(
    bucketName,
    previousProperties['IntelligentTieringConfigurations'] as
      | Array<Record<string, unknown>>
      | undefined,
    properties['IntelligentTieringConfigurations'] as Array<Record<string, unknown>> | undefined,
    // WARN, never throw, on the state-borne update paths (issue #1579) —
    // same rationale as the analytics sibling above.
    async (id, cfg) => {
      const outcome = await this.applyIntelligentTieringConfigurations(
        bucketName,
        [cfg],
        applierWarn
      );
      intelligentTieringOutcomes.record(String(id), outcome);
    },
    async (id) => {
      await this.s3Client.send(
        new DeleteBucketIntelligentTieringConfigurationCommand({
          Bucket: bucketName,
          Id: id,
        })
      );
      this.logger.debug(
        `Deleted intelligent tiering configuration ${this.shown(id)} on bucket ${this.shown(bucketName)}`
      );
    }
  );
  retainPreviousItems('IntelligentTieringConfigurations', intelligentTieringOutcomes);

  // Inventory (per-id diff)
  const inventoryOutcomes = itemOutcomes();
  await this.diffArrayConfigById(
    bucketName,
    previousProperties['InventoryConfigurations'] as Array<Record<string, unknown>> | undefined,
    properties['InventoryConfigurations'] as Array<Record<string, unknown>> | undefined,
    // Same state-borne update-path warn as the analytics sibling above.
    async (id, cfg) => {
      const outcome = await this.applyInventoryConfigurations(
        bucketName,
        [cfg],
        applierWarn,
        maskSecrets
      );
      inventoryOutcomes.record(String(id), outcome);
    },
    async (id) => {
      await this.s3Client.send(
        new DeleteBucketInventoryConfigurationCommand({ Bucket: bucketName, Id: id })
      );
      this.logger.debug(
        `Deleted inventory configuration ${this.shown(id)} on bucket ${this.shown(bucketName)}`
      );
    }
  );
  retainPreviousItems('InventoryConfigurations', inventoryOutcomes);

  // Versioning SUSPEND — deferred to LAST on purpose (issue #1466); see the
  // split rationale at the top of this method.
  if (versioningChanged && desiredVersioningStatus === 'Suspended') {
    // Object Lock structurally forbids suspending versioning
    // (`InvalidBucketState`), so this is un-actionable rather than a
    // divergence — warn instead of failing the deploy, which is what an
    // unconditional suspend would newly do here.
    //
    // BOTH sides are consulted: `ObjectLockEnabled` is not classified as a
    // replacement-forcing property for AWS::S3::Bucket, so a template that
    // drops `ObjectLockEnabled` and `VersioningConfiguration` together takes
    // the in-place UPDATE path. Reading only the desired side would see no
    // Object Lock and issue the suspend the live bucket still refuses.
    // Test the MEANINGFUL field, never mere presence of the block.
    // `readObjectLock` always-emits `ObjectLockConfiguration` and returns
    // `{}` for a bucket with no object lock, and `cdkd drift --revert` feeds
    // that snapshot in as BOTH sides — so a presence check
    // (`!== undefined`) is true for EVERY bucket on the revert path and
    // would suppress every legitimate suspend, leaving the drift
    // unfixable and warning about object lock the bucket does not have.
    //
    // The NESTED `ObjectLockEnabled: Enabled` is sent to the bucket, so either
    // side declaring it means the bucket is locked. The TOP-LEVEL flag alone
    // is not proof: it reaches S3 only through `CreateBucket`, so a flag added
    // to an existing bucket was never applied (go-to-k/cdkd#5395, as in
    // CloudFormation). That case reads the bucket back; a failed read keeps
    // the conservative skip, since suspending a locked bucket is refused.
    let hasObjectLock =
      declaresNestedObjectLock(properties) || declaresNestedObjectLock(previousProperties);
    let lockUnconfirmed = false;
    if (
      !hasObjectLock &&
      (declaresBucketObjectLock(properties) || declaresBucketObjectLock(previousProperties))
    ) {
      const live = await this.isLiveObjectLocked(bucketName, '; treating it as locked');
      hasObjectLock = live ?? true;
      lockUnconfirmed = live === undefined;
    }
    if (hasObjectLock && lockUnconfirmed) {
      this.logger.warn(
        safeMsg`Bucket ${this.shown(bucketName)}: versioning would be suspended (VersioningConfiguration removed or set to Suspended), but ObjectLockEnabled is declared and the bucket's Object Lock configuration could not be read back to confirm it. ` +
          'S3 does not allow suspending versioning on an Object Lock bucket, so versioning is ' +
          'left enabled.'
      );
      retainPrevious('VersioningConfiguration');
    } else if (hasObjectLock) {
      this.logger.warn(
        `Bucket ${this.shown(bucketName)}: versioning would be suspended (VersioningConfiguration removed ` +
          `or set to Suspended), but the bucket has Object Lock enabled and S3 does not allow ` +
          `suspending versioning on it. Leaving versioning enabled.`
      );
      // Another warn-and-skip arm, reached by a structural AWS constraint
      // rather than by a malformed value — but with the identical state
      // consequence, so it takes the identical remedy (issue #1612): the
      // suspend never ran, so recording the desired removal / `Suspended`
      // would describe a bucket whose versioning is still Enabled.
      retainPrevious('VersioningConfiguration');
    } else {
      await this.applyVersioning(bucketName, { Status: 'Suspended' });
    }
  }
  const desiredMetadata = properties['MetadataConfiguration'];
  const previousMetadata = previousProperties['MetadataConfiguration'];
  const metadataStateBorne =
    context?.replayingState === true || context?.desiredFromAwsReadback === true;
  const metadataRefusal = metadataConfigurationRefusal(desiredMetadata);
  if (
    metadataRefusal !== undefined &&
    JSON.stringify(desiredMetadata) !== JSON.stringify(previousMetadata)
  ) {
    if (!metadataStateBorne) throw new Error(metadataRefusal);
    this.logger.warn(
      safeMsg`Bucket ${this.shown(bucketName)}: ${metadataRefusal}; its S3 Metadata configuration was left as it is`
    );
    retainPrevious('MetadataConfiguration');
  } else if (metadataRefusal === undefined) {
    const madeTable = await this.applyMetadataConfigurationDiff(
      bucketName,
      desiredMetadata,
      previousMetadata,
      metadataStateBorne,
      refuseUnusable
    );
    if (madeTable && context?.desiredFromAwsReadback === true) {
      this.logger.warn(
        safeMsg`Bucket ${this.shown(bucketName)}: S3 never returns a table's EncryptionConfiguration, so a table this revert turned on took S3's default encryption, whatever the template declares`
      );
    }
  }
  return overrides;
}
