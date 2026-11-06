/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return */
import {
  ANALYTICS_DEFAULT_OUTPUT_SCHEMA_VERSION,
  EVENTBRIDGE_CONFIG_PATH,
  EVENTBRIDGE_DEFAULT_ENABLED,
  INVENTORY_DESTINATION_DEFAULT_FORMAT,
  effectiveAnalyticsItem,
  eventBridgeEnabledOf,
} from './effective-items.js';
import type { MaskerFn } from '../../masked-retry-logger.js';
import { type PerItemApplyOutcome, describeValue, isPlainObject } from './shared.js';
import {
  PutBucketAnalyticsConfigurationCommand,
  PutBucketMetricsConfigurationCommand,
  PutBucketNotificationConfigurationCommand,
} from '@aws-sdk/client-s3';
import type { S3BucketProvider } from '../s3-bucket-provider.js';
import {
  configBooleanRefusal,
  requireConfigArray,
  requireConfigObject,
} from '../../config-shape.js';

/**
 * Apply notification configuration (full-replace via PutBucketNotificationConfiguration)
 *
 * CFn property: NotificationConfiguration with TopicConfigurations,
 *   QueueConfigurations, LambdaConfigurations, EventBridgeConfiguration.
 * SDK uses the same structure (PutBucketNotificationConfiguration replaces
 * the entire notification configuration in one call).
 */
export async function applyNotificationConfiguration(
  this: S3BucketProvider,
  bucketName: string,
  notifConfig: Record<string, unknown> | undefined,
  onUnusable?: (message: string) => void
): Promise<boolean> {
  // PutBucketNotificationConfiguration is a full-replace API; sending an
  // empty NotificationConfiguration clears all notifications.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cfg: any = {};

  if (notifConfig) {
    const topics = notifConfig['TopicConfigurations'] as Array<Record<string, unknown>> | undefined;
    if (topics && Array.isArray(topics) && topics.length > 0) {
      cfg.TopicConfigurations = topics.map((t) => ({
        Id: t['Id'] as string | undefined,
        // No `TopicArn` / `QueueArn` / `LambdaFunctionArn` fallback on these
        // three: the CFn member is schema-required, so the SDK spelling is
        // refused pre-flight by `nested-required.ts` (issue #3585).
        TopicArn: t['Topic'] as string,
        Events: t['Event'] !== undefined ? [t['Event'] as string] : (t['Events'] as string[]),
        Filter: this.cfnNotifFilterToSdk(t['Filter']),
      }));
    }
    const queues = notifConfig['QueueConfigurations'] as Array<Record<string, unknown>> | undefined;
    if (queues && Array.isArray(queues) && queues.length > 0) {
      cfg.QueueConfigurations = queues.map((q) => ({
        Id: q['Id'] as string | undefined,
        QueueArn: q['Queue'] as string,
        Events: q['Event'] !== undefined ? [q['Event'] as string] : (q['Events'] as string[]),
        Filter: this.cfnNotifFilterToSdk(q['Filter']),
      }));
    }
    const lambdas = notifConfig['LambdaConfigurations'] as
      | Array<Record<string, unknown>>
      | undefined;
    if (lambdas && Array.isArray(lambdas) && lambdas.length > 0) {
      cfg.LambdaFunctionConfigurations = lambdas.map((l) => ({
        Id: l['Id'] as string | undefined,
        LambdaFunctionArn: l['Function'] as string,
        Events: l['Event'] !== undefined ? [l['Event'] as string] : (l['Events'] as string[]),
        Filter: this.cfnNotifFilterToSdk(l['Filter']),
      }));
    }
    const eb = notifConfig['EventBridgeConfiguration'];
    // The SDK's `EventBridgeConfiguration` is an EMPTY structure — presence
    // enables EventBridge delivery, absence disables it. CFn instead carries
    // a REQUIRED boolean `EventBridgeEnabled` inside the block (that is what
    // `CfnBucket` renders), so the boolean has no SDK member to land on and
    // has to be translated into presence/absence here. Before issue #1430
    // the block was emitted whenever it existed, so an explicit
    // `EventBridgeEnabled: false` silently ENABLED notifications — the
    // inverse of the template's intent.
    //
    // #1430's polarity SURVIVES this change and is what the `s3-lifecycle`
    // integ asserts on both phases: a usable `false` still emits no block, a
    // usable `true` still emits `{}`. What issue #1759 removed is the third
    // arm — the one that took `!isPlainObject(eb) || coerce(...) !== false`
    // and therefore ENABLED delivery for EVERY value cdkd cannot read
    // (`null`, `'yes'`, an array, an unresolved intrinsic), since
    // `coerceCfnBoolean` answers `undefined` for all of them and
    // `undefined !== false` is TRUE. That is the destructive-default class
    // #1595 refuses and #1751 settled one property over: a value cdkd cannot
    // read must never turn a notification feature ON on a LIVE bucket.
    //
    // So the predicate is `configBooleanRefusal`, which runs the very
    // `coerceCfnBoolean` the read below calls, and the per-path answer is the
    // one every other guard in this file takes — THROW on a template-path
    // create, warn-and-SKIP on the replay-reachable update path. The skip
    // unit is the WHOLE notification configuration, not an item:
    // `PutBucketNotificationConfiguration` is a full replace, so skipping one
    // family would silently DELETE every other one from AWS. The caller
    // records the retained previous value (`retainPrevious`), exactly as the
    // lifecycle / replication appliers' whole-Put skips do.
    //
    // `eb != null`, not `!== undefined`: an explicit `EventBridgeConfiguration:
    // null` means "block omitted" throughout this provider (the lifecycle
    // `Filter` / `TagFilters` reads already spell it that way), and
    // `configBooleanRefusal` gives a null CONTAINER the same absent treatment.
    // Pre-#1759 a declared `null` took the enable arm.
    if (eb != null) {
      const ebRefusal = configBooleanRefusal(eb, 'EventBridgeEnabled', EVENTBRIDGE_CONFIG_PATH);
      if (ebRefusal !== undefined) {
        if (!onUnusable) {
          throw new Error(
            `${ebRefusal}. Omit the block entirely to leave EventBridge delivery disabled`
          );
        }
        onUnusable(
          `${ebRefusal}. Leaving the whole notification configuration unapplied here: ` +
            `PutBucketNotificationConfiguration is a full replace, and treating an unreadable ` +
            `value as ${EVENTBRIDGE_DEFAULT_ENABLED} would ENABLE EventBridge delivery the ` +
            `template may have been disabling; the same value is REFUSED on a template-path create`
        );
        return false;
      }
      // The `??` inside is safe HERE and only here (the #1751 shape): the
      // guard above has already refused every declared-but-unusable value, so
      // the one way to reach the fallback is an ABSENT `EventBridgeEnabled`
      // key inside a DECLARED block — which CFn marks required, so the block's
      // mere presence is the affirmative declaration and enabling is the
      // pre-existing answer for it.
      if (eventBridgeEnabledOf(eb)) cfg.EventBridgeConfiguration = {};
    }
  }

  await this.s3Client.send(
    new PutBucketNotificationConfigurationCommand({
      Bucket: bucketName,
      NotificationConfiguration: cfg,
    })
  );
  this.logger.debug(`Applied notification configuration to bucket ${this.shown(bucketName)}`);
  return true;
}

/**
 * Convert CFn notification Filter ({ S3Key: { Rules: [{ Name, Value }] } })
 * to SDK NotificationConfigurationFilter.Key.FilterRules.
 */
export function cfnNotifFilterToSdk(
  this: S3BucketProvider,
  filter: unknown
): { Key: { FilterRules: Array<{ Name: string; Value: string }> } } | undefined {
  if (!filter || typeof filter !== 'object') return undefined;
  const f = filter as Record<string, unknown>;
  const s3Key = f['S3Key'] as Record<string, unknown> | undefined;
  if (!s3Key) return undefined;
  const rules = s3Key['Rules'] as Array<{ Name?: string; Value?: string }> | undefined;
  if (!rules || !Array.isArray(rules) || rules.length === 0) return undefined;
  return {
    Key: {
      FilterRules: rules
        .filter((r) => r.Name !== undefined && r.Value !== undefined)
        .map((r) => ({ Name: r.Name as string, Value: r.Value as string })),
    },
  };
}

/**
 * Apply metrics configurations
 *
 * CFn property: MetricsConfigurations[] (array of configurations)
 * SDK: PutBucketMetricsConfiguration (one per configuration, keyed by Id)
 *
 * @returns what happened to each item, as {@link PerItemApplyOutcome} — the
 *   per-item unit of `effectiveProperties` (issue #1612). This applier has no
 *   warn-and-SUBSTITUTE read, so its `substituted` map is always empty; the
 *   shape is shared with its three siblings so the two call-site recorders
 *   stay uniform and a future substitution here cannot go unrecorded.
 */
export async function applyMetricsConfigurations(
  this: S3BucketProvider,
  bucketName: string,
  configs: Array<Record<string, unknown>>,
  onUnusable?: (message: string) => void
): Promise<PerItemApplyOutcome> {
  // The per-ITEM `config` container is deliberately NOT guarded here, and
  // the audit that settled it belongs next to the decision (issue #1581).
  // Of the six per-item appliers that carry the `onUnusable` replay callback
  // (the set this decision is about — a reader enumerating every per-item
  // `.map` in this file also finds cors / encryption / website /
  // notification, which are not replay-callback sites), four already refuse a
  // non-object item on the CREATE path (issue #1595 split the paths: on a
  // state replay those four now warn and SKIP instead of throwing)
  // through an existing `readConfigString(config | rule, …)` — intelligent
  // tiering (`Status`), inventory (`IncludedObjectVersions`), the lifecycle
  // rules (`Status`) and replication's rules (`Status`, in the same applier
  // whose `Filter` container this change guards — the one most likely to be
  // mistaken for already-handled). Metrics and analytics read only `Id` off the
  // item, so a malformed one reaches AWS — but `id` is a REQUIRED query
  // parameter of `PutBucket{Metrics,Analytics}Configuration`, so the request
  // is rejected outright. That is a LOUD failure, not the silent
  // scope-widening / silent-drop hazard the container guards exist for, so
  // adding a refusal here would buy a nicer error message at the cost of a
  // behavior change on the replay path (skip instead of surface).
  const skipped: number[] = [];
  // A plain `for…of` over `configs` with a hand-kept index, NOT
  // `configs.entries()`: the nested-key critic's write pass (retired by issue
  // #3723) could not follow an array-destructuring binding back to the
  // desired property bag.
  let index = -1;
  for (const config of configs) {
    index += 1;
    const id = config['Id'] as string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const metricsConfig: any = {
      Id: id,
    };
    const prefix = config['Prefix'] as string | undefined;
    const accessPointArn = config['AccessPointArn'] as string | undefined;
    // A present-but-non-array `TagFilters` (issue #1579) used to read as
    // ZERO predicates through the `?.length` below, so the Filter block was
    // silently omitted and the configuration deployed with a WIDER scope
    // (all objects) than the template declared — the #1493
    // malformed-container class. Refuse on a template-path create; on the
    // state-replay paths (`onUnusable`) warn and skip this configuration
    // item, since applying it WITHOUT its tag predicate would widen the
    // monitored scope, the very misbehavior being refused.
    // `tagFilters` stays bound to the bag read directly (not to the guard's
    // return value): the nested-key critic's write pass (retired by issue
    // #3723) followed the bag-read binding into the `And.Tags` write, and
    // routing the value through the helper call severed it.
    const tagFilters = config['TagFilters'] as Array<{ Key: string; Value: string }> | undefined;
    if (
      tagFilters != null &&
      requireConfigArray(tagFilters, 'AWS::S3::Bucket MetricsConfigurations[].TagFilters', {
        ...(onUnusable ? { onUnusable } : {}),
      }) === undefined
    ) {
      skipped.push(index);
      continue;
    }
    const tagCount = tagFilters?.length ?? 0;
    // The single-predicate shapes (Prefix / Tag / AccessPointArn) carry
    // exactly ONE condition; every combination — and 2+ tags on their own —
    // needs the And operator. Issue #1573: this used to branch on Prefix
    // FIRST, so a Prefix combined with TagFilters or AccessPointArn
    // silently dropped the other predicate(s). Counting PREDICATES (not
    // predicate kinds — the sibling builders' variant of the same bug)
    // routes every multi-condition filter through And; no filter at all
    // means the configuration applies to every object.
    const predicateCount = (prefix ? 1 : 0) + tagCount + (accessPointArn ? 1 : 0);
    if (predicateCount > 1) {
      metricsConfig.Filter = {
        And: {
          Prefix: prefix,
          Tags: tagCount > 0 ? tagFilters : undefined,
          AccessPointArn: accessPointArn,
        },
      };
    } else if (prefix) {
      metricsConfig.Filter = { Prefix: prefix };
    } else if (tagFilters && tagFilters.length === 1) {
      metricsConfig.Filter = { Tag: tagFilters[0] };
    } else if (accessPointArn) {
      metricsConfig.Filter = { AccessPointArn: accessPointArn };
    }
    await this.s3Client.send(
      new PutBucketMetricsConfigurationCommand({
        Bucket: bucketName,
        Id: id,
        MetricsConfiguration: metricsConfig,
      })
    );
  }
  this.logger.debug(
    `Applied ${configs.length - skipped.length} metrics configuration(s) to bucket ${this.shown(bucketName)}`
  );
  return { skipped, substituted: new Map() };
}

/**
 * Validate an analytics / inventory `Destination` block, refusing a shape
 * that would otherwise be dropped.
 *
 * The block is the CFn form the schema declares (`Destination: { BucketArn,
 * Format, ... }`). The SDK NESTED form (`{ S3BucketDestination: { ... } }`)
 * and a `Bucket` alias for `BucketArn` are no longer read: `BucketArn` and
 * `Format` are schema-required, so a template using either is refused
 * pre-flight by `nested-required.ts` (issue #3602). What still reaches this
 * guard with such a shape (an unresolved intrinsic on the path, or a replayed
 * pre-#1707 state record) is refused here like any other bucket-less block.
 *
 * Issue #1493 item 2: a `Destination` that is a STRING / array / unresolved
 * intrinsic used to index every probe to `undefined`, and the caller's
 * `s3Dest ? … : undefined` omitted the whole block from the Put — a
 * configuration silently deployed without the destination it declared. Unlike
 * the sibling defaulting class this is a DROP, not a substituted default, so
 * `readConfigString` does not cover it: per issue #1513's precedent the
 * decision is REFUSE on the template-borne create path, WARN on the
 * replay-reachable update path (`onUnusable`), where the desired bag can be a
 * historical cdkd state record with no template-side remedy.
 *
 * @returns the block, or `undefined` when it was ABSENT or was refused on a
 *   warn-only path. The caller distinguishes the two by testing its own
 *   `Destination` value — see the `continue` at each call site.
 */
export function resolveS3BucketDestination(
  this: S3BucketProvider,
  dest: unknown,
  destinationPath: string,
  onUnusable?: (message: string) => void,
  // TRAILING with an identity default, following
  // `dynamodb-table-provider.ts`'s `skipWarmThroughputDecrease`: every
  // existing caller keeps compiling and "absent means unmasked" stays the
  // back-compatible contract.
  maskSecrets: MaskerFn = (text) => text
): Record<string, unknown> | undefined {
  const drop = (message: string): undefined => {
    if (onUnusable) {
      onUnusable(
        `${message}. Leaving this configuration unchanged; the same value is REFUSED ` +
          `on a template-path create`
      );
      return undefined;
    }
    throw new Error(message);
  };

  // An ABSENT block is the template's own omission, not a shape problem —
  // AWS reports the missing required destination itself. Unchanged.
  if (dest === undefined || dest === null) {
    return undefined;
  }

  if (!isPlainObject(dest)) {
    return drop(
      `${destinationPath} must be an object (got ${describeValue(dest, maskSecrets)}) — check for an ` +
        `unresolved intrinsic or a mis-nested template value; the destination would ` +
        `otherwise be dropped from the request with no error`
    );
  }

  // The bucket is REQUIRED by both APIs, and it is the one member that cannot
  // be defaulted. Truthiness, so an empty string is refused too.
  if (!dest['BucketArn']) {
    return drop(
      `${destinationPath} has no destination bucket (BucketArn) ` +
        `(got ${describeValue(dest, maskSecrets)}) — the request would be ` +
        `rejected by S3, or silently carry no destination`
    );
  }

  return dest;
}

/**
 * Apply analytics configurations
 *
 * CFn property: AnalyticsConfigurations[] (array of configurations)
 * SDK: PutBucketAnalyticsConfiguration (one per configuration, keyed by Id)
 *
 * @returns what happened to each item, as {@link PerItemApplyOutcome} — the
 *   per-item unit of `effectiveProperties` (issues #1612 / #1670). Both arms
 *   are reachable here: a container / destination guard SKIPS the item, while
 *   the `OutputSchemaVersion` and destination `Format` reads warn and SEND a
 *   substituted default, so the item is recorded as SENT rather than as
 *   declared.
 */
export async function applyAnalyticsConfigurations(
  this: S3BucketProvider,
  bucketName: string,
  configs: Array<Record<string, unknown>>,
  onUnusable?: (message: string) => void,
  // TRAILING with an identity default (same shape as
  // `resolveS3BucketDestination` below it): the masker only reaches the
  // destination-shape refusals, so an absent one leaves today's behaviour
  // exactly as it was.
  maskSecrets: MaskerFn = (text) => text
): Promise<PerItemApplyOutcome> {
  const skipped: number[] = [];
  const substituted = new Map<number, Record<string, unknown>>();
  // A plain `for…of` over `configs` with a hand-kept index, NOT
  // `configs.entries()`: the nested-key critic's write pass (retired by issue
  // #3723) could not follow an array-destructuring binding back to the
  // desired property bag.
  let index = -1;
  for (const config of configs) {
    index += 1;
    const id = config['Id'] as string;
    // The values that go ON THE WIRE for the two reads a warn-and-SUBSTITUTE
    // downgrade can replace (issue #1670). They are handed to
    // {@link effectiveAnalyticsItem} once the Put has SUCCEEDED, which is the
    // ONE fold this applier and `canonicalizeDesiredProperties` share — the
    // rule's "share one helper rather than re-deriving" requirement, and what
    // replaced the per-field `withDeepValue` writes this applier used to do.
    let sentOutputSchemaVersion: string | undefined;
    let sentFormat: string | undefined;
    // The `StorageClassAnalysis` CONTAINER (issue #1581) — the analytics
    // sibling of the lifecycle `Filter` guard. A present-but-non-OBJECT
    // value indexes the `DataExport` probe below to `undefined`, so the
    // whole data-export block was dropped and the configuration deployed as
    // `StorageClassAnalysis: {}` — which S3 ACCEPTS as "no export", so
    // nothing surfaced anywhere. Refuse on a template-path create; on the
    // state-replay paths warn and skip THIS configuration item (the Put is
    // per-Id, so the siblings are unaffected — unlike the lifecycle Put,
    // which replaces every rule at once).
    const rawStorageClassAnalysis = config['StorageClassAnalysis'];
    if (
      rawStorageClassAnalysis != null &&
      requireConfigObject(
        rawStorageClassAnalysis,
        'AWS::S3::Bucket AnalyticsConfigurations[].StorageClassAnalysis',
        { ...(onUnusable ? { onUnusable } : {}) }
      ) === undefined
    ) {
      skipped.push(index);
      continue;
    }
    const storageClassAnalysis = rawStorageClassAnalysis as Record<string, unknown> | undefined;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const analyticsConfig: any = {
      Id: id,
      StorageClassAnalysis: {},
    };

    // Filter. The single-predicate shapes carry exactly ONE condition; a
    // combination — and 2+ tags on their own — needs the And operator.
    // Issue #1573: the old guard counted predicate KINDS, so 2+ tags with
    // no Prefix collapsed to the single-Tag shape and silently dropped
    // every tag after the first. And-with-only-Tags is accepted by the API
    // and reads back unchanged (live-probed 2026-08-11).
    const prefix = config['Prefix'] as string | undefined;
    // Non-array `TagFilters` guard (issue #1579) — see the metrics sibling,
    // including why the binding must stay a direct bag read.
    const tagFilters = config['TagFilters'] as Array<{ Key: string; Value: string }> | undefined;
    if (
      tagFilters != null &&
      requireConfigArray(tagFilters, 'AWS::S3::Bucket AnalyticsConfigurations[].TagFilters', {
        ...(onUnusable ? { onUnusable } : {}),
      }) === undefined
    ) {
      skipped.push(index);
      continue;
    }
    const tagCount = tagFilters?.length ?? 0;
    if ((prefix ? 1 : 0) + tagCount > 1) {
      analyticsConfig.Filter = { And: { Prefix: prefix, Tags: tagFilters } };
    } else if (prefix) {
      analyticsConfig.Filter = { Prefix: prefix };
    } else if (tagFilters && tagFilters.length === 1) {
      analyticsConfig.Filter = { Tag: tagFilters[0] };
    }

    // StorageClassAnalysis.DataExport
    //
    // `!= null`, NOT a truthiness gate: a FALSY malformed `DataExport` ('' /
    // 0) skips the whole block and sends `StorageClassAnalysis: {}` with no
    // error — the same silent drop this change exists for, one gate up.
    // `.claude/rules/providers.md` names #1493 as having shipped exactly that
    // gate bug once already.
    if (storageClassAnalysis?.['DataExport'] != null) {
      const rawDataExport = storageClassAnalysis['DataExport'];
      // The `DataExport` container itself (issue #1581). It WAS refused
      // before this change, but only INDIRECTLY and only in one direction:
      // the `readConfigString(dataExport, 'OutputSchemaVersion', …)` below
      // carries no `onUnusable`, so a malformed block hard-threw on the
      // state-replay paths too — the un-rollbackable refusal every sibling
      // guard in this file exists to avoid. Guarding it explicitly moves the
      // replay path onto the same warn-and-skip contract as its siblings and
      // leaves the create-path refusal exactly where it was.
      if (
        requireConfigObject(
          rawDataExport,
          'AWS::S3::Bucket AnalyticsConfigurations[].StorageClassAnalysis.DataExport',
          { ...(onUnusable ? { onUnusable } : {}) }
        ) === undefined
      ) {
        skipped.push(index);
        continue;
      }
      const dataExport = rawDataExport as Record<string, unknown>;
      const analyticsDestPath =
        'AWS::S3::Bucket AnalyticsConfigurations[].StorageClassAnalysis.DataExport.Destination';
      const rawDest = dataExport['Destination'];
      const s3Dest = this.resolveS3BucketDestination(
        rawDest,
        analyticsDestPath,
        onUnusable,
        maskSecrets
      );
      // A PRESENT-but-unusable destination that only warned leaves the live
      // configuration ALONE rather than sending a destination-less request.
      // `Destination` is a REQUIRED SDK member, so emitting the Put without
      // it is rejected by S3 — the replay would be stranded anyway, just with
      // an opaque AWS error instead of cdkd's actionable one, which is the
      // whole point of warning here. An ABSENT destination keeps the old
      // behavior and lets AWS report the missing required field.
      if (s3Dest === undefined && rawDest != null) {
        skipped.push(index);
        continue;
      }
      analyticsConfig.StorageClassAnalysis = {
        DataExport: {
          // Same update-path downgrade as the `Format` read below: the FIELD
          // half of this block was the last read here that still hard-threw on
          // a state replay, so a historical record with a malformed
          // `OutputSchemaVersion` was un-rollbackable for no better reason
          // than that its sibling was guarded first (PR review, issue #1581).
          //
          // Note this is a DIFFERENT replay contract from the container guard
          // two blocks up — that one SKIPS the item, this one proceeds with
          // the fallback — and the operative reason is not symmetry: the SDK's
          // `StorageClassAnalysisSchemaVersion` has exactly ONE member, `V_1`,
          // so the fallback here cannot write a wrong-direction value the way
          // defaulting a real enum could. A destination that is present but
          // unusable was already eaten by the `continue` above, so the only
          // survivors are a valid `s3Dest` or an absent one.
          //
          // The substituted value is threaded back into the item's effective
          // entry (issue #1670): the Put SUCCEEDS carrying `V_1`, so
          // recording the malformed declared value would describe a data
          // export AWS does not hold — `analyticsSdkToCfn` reads the field
          // back, so the difference is visible to the comparator and never
          // converges. Since issue #1718 the value is captured whether or not
          // a substitution fired: `analyticsSdkToCfn` emits the field for
          // EVERY data export, so an item that merely OMITS it recorded one
          // key fewer than the readback produces.
          OutputSchemaVersion: (sentOutputSchemaVersion = this.readSubstitutedConfigString(
            dataExport,
            'OutputSchemaVersion',
            ANALYTICS_DEFAULT_OUTPUT_SCHEMA_VERSION,
            'AWS::S3::Bucket AnalyticsConfigurations[].StorageClassAnalysis.DataExport',
            { ...(onUnusable ? { onUnusable } : {}) }
          )),
          Destination: s3Dest
            ? {
                S3BucketDestination: {
                  Bucket: s3Dest['BucketArn'] as string,
                  BucketAccountId: s3Dest['BucketAccountId'] as string | undefined,
                  // Same downgrade as the destination guard above: a
                  // rollback / `drift --revert` replays a STATE record here,
                  // so a malformed `Format` must not hard-fail one line below
                  // a guard that deliberately warns. And the same
                  // record-what-was-SENT rule as the schema version above
                  // (issue #1670) — recorded in the CFn spelling
                  // `analyticsSdkToCfn` emits (issue #1707).
                  Format: (sentFormat = this.readSubstitutedConfigString(
                    s3Dest,
                    'Format',
                    INVENTORY_DESTINATION_DEFAULT_FORMAT,
                    analyticsDestPath,
                    { ...(onUnusable ? { onUnusable } : {}) }
                  )),
                  Prefix: s3Dest['Prefix'] as string | undefined,
                },
              }
            : undefined,
        },
      };
    }

    await this.s3Client.send(
      new PutBucketAnalyticsConfigurationCommand({
        Bucket: bucketName,
        Id: id,
        AnalyticsConfiguration: analyticsConfig,
      })
    );
    // Recorded only once the Put has SUCCEEDED — the effective bag describes
    // what AWS holds, and a failed Put leaves it holding nothing new. The fold
    // identity-returns when declared == sent, so an ordinary item records
    // nothing and the effective array keeps the item the template wrote.
    const sentItem = effectiveAnalyticsItem(config, {
      ...(sentOutputSchemaVersion !== undefined
        ? { outputSchemaVersion: sentOutputSchemaVersion }
        : {}),
      ...(sentFormat !== undefined ? { format: sentFormat } : {}),
    });
    if (sentItem !== config) substituted.set(index, sentItem);
  }
  this.logger.debug(
    `Applied ${configs.length - skipped.length} analytics configuration(s) to bucket ${this.shown(bucketName)}`
  );
  return { skipped, substituted };
}
