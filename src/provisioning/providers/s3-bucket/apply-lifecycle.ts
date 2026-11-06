/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return */
import {
  LIFECYCLE_DEFAULT_STATUS,
  LIFECYCLE_FILTER_PATH,
  LIFECYCLE_RULE_PATH,
  LIFECYCLE_TAG_FILTERS_PATH,
  lifecycleRuleScope,
  lifecycleUsesFilterForm,
} from './lifecycle-fold.js';
import {
  PutBucketAccelerateConfigurationCommand,
  PutBucketEncryptionCommand,
  PutBucketLifecycleConfigurationCommand,
  PutBucketLoggingCommand,
  PutBucketWebsiteCommand,
  PutPublicAccessBlockCommand,
} from '@aws-sdk/client-s3';
import type { S3BucketProvider } from '../s3-bucket-provider.js';
import {
  coerceCfnBoolean,
  configStringRefusal,
  readConfigString,
  requireConfigArray,
  requireConfigObject,
} from '../../config-shape.js';
import {
  coerceCfnNumber,
  isPlainObject,
  mergeLegacySingular,
  shownLifecycleRuleId,
} from './shared.js';
import { maskDeep } from '../../masked-retry-logger.js';
import { parseCfnTimestamp } from '../../../utils/cfn-timestamp.js';

/**
 * Apply lifecycle configuration
 *
 * CFn property: LifecycleConfiguration.Rules[]
 * SDK: PutBucketLifecycleConfiguration with LifecycleConfiguration.Rules[]
 *
 * CFn and SDK use the same structure with minor differences:
 * - CFn uses TagFilters, SDK uses Tag/Tags in Filter
 * - CFn Transition.TransitionInDays -> SDK Transition.Days
 * - CFn Transition.TransitionDate -> SDK Transition.Date
 *
 * @returns `true` when the Put was issued, `false` when a replay downgrade
 *   SKIPPED the whole configuration (issue #1612 — the caller records that in
 *   `effectiveProperties`).
 */
export async function applyLifecycleConfiguration(
  this: S3BucketProvider,
  bucketName: string,
  lifecycleConfig: {
    Rules: Array<Record<string, unknown>>;
    TransitionDefaultMinimumObjectSize?: unknown;
  },
  onUnusable?: (message: string) => void
): Promise<boolean> {
  // Validate every rule's `TagFilters` container up front (issue #1579): a
  // present-but-non-array value used to fall through `lifecycleRuleScope`'s blind
  // cast, read as "no tags" via the `.length` gates below, and the rule
  // applied WITHOUT its tag scope — for an expiration rule, to the WHOLE
  // bucket (the #1388 widened-scope hazard, this time from a malformed
  // container instead of a mis-placed key). Refuse on a template-path
  // create; on the state-replay paths (`onUnusable`) warn and leave the
  // WHOLE live lifecycle configuration alone — the Put replaces every rule,
  // so skipping only the malformed rule would silently DELETE it from AWS.
  for (const rule of lifecycleConfig.Rules) {
    // ...and the `Filter` CONTAINER those TagFilters live in, one level up
    // (issue #1581). A present-but-non-OBJECT `Filter` (`Filter: 'logs/'`,
    // an array, an unresolved intrinsic) indexes every `Filter`-side member
    // probe in `lifecycleRuleScope` — Prefix / TagFilters / ObjectSizeGreaterThan /
    // ObjectSizeLessThan — to `undefined`, so the rule kept no scope beyond
    // whatever the RULE-LEVEL fallbacks happened to supply, and nothing at
    // all for a `Filter`-only rule: it then fell through to the empty-prefix
    // V2 `Filter` below and applied to the WHOLE bucket. For an expiration
    // rule that deletes objects the rule was never meant to touch — the same
    // #1388 widened-scope hazard as the TagFilters guard, reached through the
    // parent container instead. Same refusal split, and the same whole-Put
    // skip unit for the same reason.
    const rawFilter = rule['Filter'];
    if (
      rawFilter != null &&
      requireConfigObject(rawFilter, LIFECYCLE_FILTER_PATH, {
        ...(onUnusable ? { onUnusable } : {}),
      }) === undefined
    ) {
      return false;
    }
    const filter = rawFilter as Record<string, unknown> | undefined;
    const rawTagFilters = filter?.['TagFilters'] ?? rule['TagFilters'];
    if (rawTagFilters != null) {
      const validated = requireConfigArray(rawTagFilters, LIFECYCLE_TAG_FILTERS_PATH, {
        ...(onUnusable ? { onUnusable } : {}),
      });
      if (validated === undefined) return false;
    }
    // ...and the per-rule `Status` (issue #1595). The read that refuses it
    // sits in the `.map` below and carries no `onUnusable`, so a state
    // record with a malformed `Status` was un-rollbackable. Defaulting is
    // NOT the downgrade here: the fallback is `Enabled`, so a replayed
    // expiration rule the template had DISABLED would start deleting
    // objects. Skip unit is the whole Put, exactly as for the two container
    // guards above and for the same reason.
    if (
      this.skipOnUnusableConfigString(
        rule,
        'Status',
        LIFECYCLE_DEFAULT_STATUS,
        LIFECYCLE_RULE_PATH,
        // Path-NEUTRAL wording, like the sibling container guards: the
        // replay-CREATE arm reaches this too (a reverse-replacement revives
        // the bucket, so there is no "live" configuration to leave alone),
        // and a message that asserts one would be false there.
        'Leaving the whole lifecycle configuration unapplied here',
        onUnusable
      )
    ) {
      return false;
    }
  }
  // The rule's full location scope comes from EVERY source CFn can express it
  // in — an explicit `Filter` object, a top-level `Prefix` (the deprecated V1
  // form), rule-level `TagFilters` (what CDK synthesizes), AND the top-level
  // `ObjectSizeGreaterThan` / `ObjectSizeLessThan` properties. The gatherer
  // and the V1/V2 decision are MODULE-level (`lifecycleRuleScope` /
  // `lifecycleUsesFilterForm`) so `effectiveLifecycleConfiguration` runs the
  // very same functions: S3 forbids mixing V1 and V2 rules in one
  // configuration, so the form is decided ONCE across the whole rule list, and
  // a fold that re-derived that decision could record a `Filter` the wire
  // never sent (issue #1755).
  const useFilterForm = lifecycleUsesFilterForm(lifecycleConfig.Rules);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rules = lifecycleConfig.Rules.map((rule): any => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sdkRule: any = {
      ID: rule['Id'] as string | undefined,
      Status: readConfigString(rule, 'Status', LIFECYCLE_DEFAULT_STATUS, LIFECYCLE_RULE_PATH),
      // In V2-Filter form the location scope lives under `Filter` (set below);
      // a top-level `Prefix` alongside a `Filter` is exactly the illegal mix.
      Prefix: useFilterForm ? undefined : (rule['Prefix'] as string | undefined),
    };

    // Expiration
    const expiration = rule['ExpirationInDays'] || rule['ExpirationDate'] || rule['Expiration'];
    if (typeof expiration === 'number') {
      sdkRule.Expiration = { Days: expiration };
    } else if (typeof expiration === 'string') {
      sdkRule.Expiration = { Date: parseCfnTimestamp(expiration) };
    } else if (expiration && typeof expiration === 'object') {
      const exp = expiration as Record<string, unknown>;
      sdkRule.Expiration = {
        Days: exp['Days'] as number | undefined,
        Date: exp['Date'] ? parseCfnTimestamp(exp['Date'] as string) : undefined,
        ExpiredObjectDeleteMarker: exp['ExpiredObjectDeleteMarker'] as boolean | undefined,
      };
    }
    // `ExpiredObjectDeleteMarker` is a RULE-level CFn property (it is what
    // `LifecycleRule.expiredObjectDeleteMarker` synthesizes), not a member of
    // a nested `Expiration` object. Read only from the nested form, a rule
    // whose ONLY action is the delete-marker cleanup produced no `Expiration`
    // at all and S3 rejects the action-less rule (issue #1388). S3 forbids
    // combining it with Days / Date, so it only fills an empty Expiration.
    // Gate on whether the built `Expiration` actually carries a Days / Date
    // rather than on its mere existence: the nested branch above emits an
    // object with every member `undefined` for an empty / unresolved
    // `Expiration`, so an existence check would drop the marker AND leave the
    // rule action-less — the exact failure this block exists to prevent.
    // Only TRUE engages. `false` is a legal synth (CDK's own validation is
    // truthy-gated), and treating it as a request would both warn about a
    // cleanup nobody asked for and, on a marker-only rule, emit
    // `Expiration: { ExpiredObjectDeleteMarker: false }` — action-less again.
    const ruleLevelDeleteMarker = coerceCfnBoolean(rule['ExpiredObjectDeleteMarker']);
    if (ruleLevelDeleteMarker === true) {
      const exp = sdkRule.Expiration as Record<string, unknown> | undefined;
      const hasDaysOrDate = exp?.['Days'] !== undefined || exp?.['Date'] !== undefined;
      if (!hasDaysOrDate) {
        sdkRule.Expiration = { ExpiredObjectDeleteMarker: true };
      } else {
        // S3 rejects ExpiredObjectDeleteMarker combined with Days / Date, so
        // one of the two has to go. Warn instead of dropping in silence.
        this.logger.warn(
          `Lifecycle rule ${shownLifecycleRuleId(maskDeep(rule['Id'], this.shownMask))} on ${this.shown(bucketName)} sets ` +
            `ExpiredObjectDeleteMarker alongside an expiration Days/Date; S3 forbids ` +
            `combining them, so the delete-marker cleanup was not applied.`
        );
      }
    }

    // NoncurrentVersionExpiration. The CFn schema ALSO still accepts the
    // legacy scalar `NoncurrentVersionExpirationInDays` alongside the modern
    // object form; the object wins when both are present (issue #1388).
    const nve = isPlainObject(rule['NoncurrentVersionExpiration'])
      ? rule['NoncurrentVersionExpiration']
      : undefined;
    const legacyNveDays = rule['NoncurrentVersionExpirationInDays'];
    if (nve) {
      sdkRule.NoncurrentVersionExpiration = {
        NoncurrentDays: nve['NoncurrentDays'] as number | undefined,
        NewerNoncurrentVersions: nve['NewerNoncurrentVersions'] as number | undefined,
      };
    } else if (coerceCfnNumber(legacyNveDays) !== undefined) {
      // Coerced, not `typeof === 'number'`: CFn is stringly typed and this
      // branch exists specifically for hand-written / imported templates,
      // which is exactly where `"365"` shows up.
      sdkRule.NoncurrentVersionExpiration = { NoncurrentDays: coerceCfnNumber(legacyNveDays) };
    }

    // NoncurrentVersionTransitions, plus the legacy singular
    // `NoncurrentVersionTransition` object the CFn schema still accepts.
    // Both may appear on one rule; they are MERGED, with the plural winning
    // on a StorageClass collision (see `mergeLegacySingular`).
    const toSdkNvt = (nvt: Record<string, unknown>): Record<string, unknown> => ({
      // CFn spells the day count `TransitionInDays` on BOTH the singular
      // `NoncurrentVersionTransition` and the plural
      // `NoncurrentVersionTransitions[]`; the SDK member is `NoncurrentDays`.
      // Reading only the SDK spelling meant the day count was `undefined` for
      // every real template, so a CDK `noncurrentVersionTransitions` lost its
      // schedule (issue #1388). There is no `NoncurrentDays` fallback:
      // `TransitionInDays` is schema-required here, so that spelling is
      // refused pre-flight by `nested-required.ts` (issue #3585).
      NoncurrentDays: nvt['TransitionInDays'] as number | undefined,
      StorageClass: nvt['StorageClass'] as string | undefined,
      NewerNoncurrentVersions: nvt['NewerNoncurrentVersions'] as number | undefined,
    });
    const nvts = rule['NoncurrentVersionTransitions'] as Array<Record<string, unknown>> | undefined;
    const singularNvt = rule['NoncurrentVersionTransition'] as Record<string, unknown> | undefined;
    const allNvts = mergeLegacySingular(nvts, singularNvt, (sc) =>
      this.logger.warn(
        `Lifecycle rule ${shownLifecycleRuleId(maskDeep(rule['Id'], this.shownMask))} on ${this.shown(bucketName)} declares ` +
          `both NoncurrentVersionTransitions and the legacy NoncurrentVersionTransition for ` +
          `storage class ${this.shown(sc)}; S3 rejects duplicates, so the legacy singular was ignored.`
      )
    );
    if (allNvts.length > 0) {
      sdkRule.NoncurrentVersionTransitions = allNvts.map(toSdkNvt);
    }

    // Transitions, plus the legacy singular `Transition` object. Same merge
    // rule as the noncurrent-version pair above.
    const toSdkTransition = (t: Record<string, unknown>): Record<string, unknown> => ({
      Days: (t['TransitionInDays'] ?? t['Days']) as number | undefined,
      Date:
        (t['TransitionDate'] ?? t['Date'])
          ? parseCfnTimestamp((t['TransitionDate'] ?? t['Date']) as string)
          : undefined,
      StorageClass: t['StorageClass'] as string | undefined,
    });
    const transitions = rule['Transitions'] as Array<Record<string, unknown>> | undefined;
    const singularTransition = rule['Transition'] as Record<string, unknown> | undefined;
    const allTransitions = mergeLegacySingular(transitions, singularTransition, (sc) =>
      this.logger.warn(
        `Lifecycle rule ${shownLifecycleRuleId(maskDeep(rule['Id'], this.shownMask))} on ${this.shown(bucketName)} declares ` +
          `both Transitions and the legacy Transition for storage class ${this.shown(sc)}; S3 rejects ` +
          `duplicates, so the legacy singular was ignored.`
      )
    );
    if (allTransitions.length > 0) {
      sdkRule.Transitions = allTransitions.map(toSdkTransition);
    }

    // AbortIncompleteMultipartUpload
    const abort = isPlainObject(rule['AbortIncompleteMultipartUpload'])
      ? rule['AbortIncompleteMultipartUpload']
      : undefined;
    if (abort) {
      sdkRule.AbortIncompleteMultipartUpload = {
        DaysAfterInitiation: abort['DaysAfterInitiation'] as number | undefined,
      };
    }

    // Build the SDK `Filter` from the rule's full gathered scope (explicit
    // Filter + top-level Prefix + top-level ObjectSizeGreaterThan/LessThan).
    // S3 requires either a top-level Prefix (V1) or a Filter (V2) on each rule;
    // a rule with no scope at all gets the empty-prefix Filter (matches all).
    const { prefix, tagFilters, sizeGt, sizeLt } = lifecycleRuleScope(rule);
    // `!= null` for the same reason as `lifecycleRuleIsPlainPrefixOnly`: an
    // explicit `TagFilters: null` means "no entries", not a `.length` crash.
    const hasTags = tagFilters != null && tagFilters.length > 0;
    const componentCount =
      (hasTags ? 1 : 0) +
      (prefix !== undefined ? 1 : 0) +
      (sizeGt !== undefined ? 1 : 0) +
      (sizeLt !== undefined ? 1 : 0);

    if (componentCount > 1) {
      // Multiple conditions must be combined under And (V2 only).
      sdkRule.Filter = {
        And: {
          Prefix: prefix,
          Tags: hasTags ? tagFilters : undefined,
          ObjectSizeGreaterThan: sizeGt,
          ObjectSizeLessThan: sizeLt,
        },
      };
    } else if (hasTags && tagFilters!.length > 1) {
      // Several tags and NOTHING else still needs `And` — the SDK's `Tag`
      // member holds exactly one tag, so the pre-#1388 `Tag: tagFilters[0]`
      // silently dropped every tag after the first. Unreachable before this
      // change (rule-level `TagFilters` was never gathered), so fixing the
      // gather without fixing this would have traded one silent drop for
      // another.
      sdkRule.Filter = { And: { Tags: tagFilters } };
    } else if (hasTags) {
      sdkRule.Filter = { Tag: tagFilters![0] };
    } else if (sizeGt !== undefined) {
      sdkRule.Filter = { ObjectSizeGreaterThan: sizeGt };
    } else if (sizeLt !== undefined) {
      sdkRule.Filter = { ObjectSizeLessThan: sizeLt };
    } else if (useFilterForm) {
      // Single Prefix (or no scope) in a V2 config: a bare top-level Prefix
      // becomes `Filter: { Prefix }`; no scope becomes the empty-prefix Filter.
      sdkRule.Filter = { Prefix: prefix ?? '' };
    }
    // else: V1 config, single-Prefix rule — keep the top-level `sdkRule.Prefix`
    // set above.

    return sdkRule;
  });

  await this.s3Client.send(
    new PutBucketLifecycleConfigurationCommand({
      Bucket: bucketName,
      LifecycleConfiguration: { Rules: rules },
      // TransitionDefaultMinimumObjectSize (issue #1495): the account-level
      // default that decides whether objects under 128 KB are eligible for
      // transition. It sits on the REQUEST rather than inside
      // `LifecycleConfiguration`, which is why the rules-only mapper never
      // reached it — a bucket declaring `all_storage_classes_128K` silently
      // kept the `varies_by_storage_class` default.
      TransitionDefaultMinimumObjectSize: lifecycleConfig['TransitionDefaultMinimumObjectSize'] as
        | import('@aws-sdk/client-s3').TransitionDefaultMinimumObjectSize
        | undefined,
    })
  );
  this.logger.debug(`Applied lifecycle configuration to bucket ${this.shown(bucketName)}`);
  return true;
}

/**
 * Apply public access block configuration
 *
 * CFn property: PublicAccessBlockConfiguration
 * SDK: PutPublicAccessBlock with PublicAccessBlockConfiguration
 * Field names are identical between CFn and SDK.
 */
export async function applyPublicAccessBlockConfiguration(
  this: S3BucketProvider,
  bucketName: string,
  config: Record<string, unknown>
): Promise<void> {
  await this.s3Client.send(
    new PutPublicAccessBlockCommand({
      Bucket: bucketName,
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: config['BlockPublicAcls'] as boolean | undefined,
        BlockPublicPolicy: config['BlockPublicPolicy'] as boolean | undefined,
        IgnorePublicAcls: config['IgnorePublicAcls'] as boolean | undefined,
        RestrictPublicBuckets: config['RestrictPublicBuckets'] as boolean | undefined,
      },
    })
  );
  this.logger.debug(
    `Applied public access block configuration to bucket ${this.shown(bucketName)}`
  );
}

/**
 * Apply bucket encryption configuration
 *
 * CFn property: BucketEncryption.ServerSideEncryptionConfiguration[]
 * SDK: PutBucketEncryption with ServerSideEncryptionConfiguration.Rules[]
 *
 * CFn ServerSideEncryptionRule fields:
 * - ServerSideEncryptionByDefault.SSEAlgorithm, KMSMasterKeyID
 * - BucketKeyEnabled
 */
export async function applyBucketEncryption(
  this: S3BucketProvider,
  bucketName: string,
  encryptionConfig: { ServerSideEncryptionConfiguration: Array<Record<string, unknown>> }
): Promise<void> {
  // See applyOwnershipControls: malformed values reach here deliberately, so
  // fail by name rather than with a bare `.map` TypeError.
  if (!Array.isArray(encryptionConfig?.ServerSideEncryptionConfiguration)) {
    // Plain Error on purpose: create()/update() wrap every throw into a
    // ProvisioningError carrying the real logicalId (which this private
    // helper does not have), so raising one here would only be re-labelled.
    throw new Error(
      `BucketEncryption.ServerSideEncryptionConfiguration must be an array (got ` +
        `${
          encryptionConfig?.ServerSideEncryptionConfiguration === undefined
            ? 'undefined'
            : typeof encryptionConfig.ServerSideEncryptionConfiguration
        }) — check for an unresolved intrinsic or a mis-nested template value`
    );
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rules = encryptionConfig.ServerSideEncryptionConfiguration.map((rule): any => {
    const byDefault = rule['ServerSideEncryptionByDefault'] as Record<string, unknown> | undefined;
    // BlockedEncryptionTypes (issue #1495): the per-rule opt-out of an
    // encryption type (today only SSE-C). Never built before, so a bucket
    // declaring the block silently kept accepting the type it wanted to
    // refuse — a security-relevant drop, not just a lost setting.
    const blocked = rule['BlockedEncryptionTypes'] as Record<string, unknown> | undefined;
    return {
      ApplyServerSideEncryptionByDefault: byDefault
        ? {
            SSEAlgorithm: byDefault['SSEAlgorithm'] as string,
            KMSMasterKeyID: byDefault['KMSMasterKeyID'] as string | undefined,
          }
        : undefined,
      BucketKeyEnabled: rule['BucketKeyEnabled'] as boolean | undefined,
      BlockedEncryptionTypes:
        blocked != null && blocked['EncryptionType'] !== undefined
          ? { EncryptionType: blocked['EncryptionType'] as string[] }
          : undefined,
    };
  });
  await this.s3Client.send(
    new PutBucketEncryptionCommand({
      Bucket: bucketName,
      ServerSideEncryptionConfiguration: { Rules: rules },
    })
  );
  this.logger.debug(`Applied encryption configuration to bucket ${this.shown(bucketName)}`);
}

/**
 * Apply logging configuration
 *
 * CFn property: LoggingConfiguration
 *   - DestinationBucketName -> SDK TargetBucket
 *   - LogFilePrefix -> SDK TargetPrefix
 * SDK: PutBucketLogging with BucketLoggingStatus.LoggingEnabled
 */
/**
 * @returns `true` when a `PutBucketLogging` (set or clear) was issued,
 *   `false` when the replay downgrade SKIPPED it (issue #1612).
 */
export async function applyLoggingConfiguration(
  this: S3BucketProvider,
  bucketName: string,
  loggingConfig: unknown,
  // The state-replay downgrade (issue #1605).
  onUnusable?: (message: string) => void
): Promise<boolean> {
  // The replay downgrade is a SKIP of the whole Put, which is this applier's
  // natural unit — `PutBucketLogging` replaces the entire logging status, so
  // there is no smaller thing to skip. Both reads are probed together for
  // that reason: partially applying the block would send a destination with
  // a defaulted prefix, or a prefix with no destination.
  //
  // Not the default: the destination's fallback is `''`, which the clearing
  // branch below reads as "no logging" and TURNS ACCESS LOGGING OFF on a
  // live bucket. Losing an audit trail silently is worse than leaving
  // logging pointed where it already points, which is what the skip does —
  // and the skip is announced. (`LogFilePrefix` has a blank fallback too, so
  // per `configValueRefusal`'s blank-with-blank-default relaxation only a
  // NON-string value refuses there; a blank prefix stays legitimate.)
  if (onUnusable) {
    const refusal =
      configStringRefusal(
        loggingConfig,
        'DestinationBucketName',
        '',
        'AWS::S3::Bucket LoggingConfiguration'
      ) ??
      configStringRefusal(
        loggingConfig,
        'LogFilePrefix',
        '',
        'AWS::S3::Bucket LoggingConfiguration'
      );
    if (refusal !== undefined) {
      // Same both-paths wording as the versioning applier: the create-path
      // gate probes only `DestinationBucketName`, so a good destination with
      // a malformed `LogFilePrefix` passes it and refuses HERE, on a create
      // where there is no live configuration to preserve (PR review).
      onUnusable(
        `${refusal}. No PutBucketLogging is issued rather than clearing access logging, which ` +
          `would turn it OFF on an existing bucket (on a replayed create it means the bucket ` +
          `comes up with no access logging); the same value is REFUSED on a template-path ` +
          `create`
      );
      return false;
    }
  }
  // Shape-check the CONTAINER before the clearing branch below (issue
  // #1471). That branch reads `loggingConfig['DestinationBucketName']`, so a
  // malformed value (`LoggingConfiguration: 'my-log-bucket'`) indexes to
  // `undefined`, takes the clear path, and turns logging OFF on a bucket
  // whose template declares it — the same declaring-the-feature-disables-it
  // shape this issue exists to remove. Guarding only the `LogFilePrefix`
  // read below would leave it live, because control never reaches it.
  //
  // An ABSENT config still resolves to the fallback and clears, which is the
  // legitimate removal path.
  const destinationBucket = readConfigString(
    loggingConfig,
    'DestinationBucketName',
    '',
    'AWS::S3::Bucket LoggingConfiguration'
  );

  // S3 supports clearing logging by sending an empty BucketLoggingStatus
  // (no LoggingEnabled field). When loggingConfig is undefined or has no
  // DestinationBucketName, we issue the clearing call.
  if (!loggingConfig || destinationBucket === '') {
    await this.s3Client.send(
      new PutBucketLoggingCommand({
        Bucket: bucketName,
        BucketLoggingStatus: {},
      })
    );
    this.logger.debug(`Cleared logging configuration on bucket ${this.shown(bucketName)}`);
    return true;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const loggingEnabled: any = {
    TargetBucket: destinationBucket,
    TargetPrefix: readConfigString(
      loggingConfig,
      'LogFilePrefix',
      '',
      'AWS::S3::Bucket LoggingConfiguration'
    ),
  };

  // TargetObjectKeyFormat (issue #1495): the partitioned server-access-log
  // key format. Never built before, so a bucket declaring it silently got
  // the default FLAT format. CFn and the SDK spell the whole block
  // identically, but it is assembled member by member rather than forwarded
  // so a future CFn-only member cannot ride through unnoticed.
  const keyFormat = (loggingConfig as Record<string, unknown>)['TargetObjectKeyFormat'] as
    | Record<string, unknown>
    | undefined;
  if (keyFormat != null) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sdkKeyFormat: any = {};
    // `SimplePrefix: {}` is the CFn opt-in for the default format: the value
    // is an EMPTY object whose PRESENCE is the signal, so it must survive.
    if (keyFormat['SimplePrefix'] !== undefined) sdkKeyFormat.SimplePrefix = {};
    const partitioned = keyFormat['PartitionedPrefix'] as Record<string, unknown> | undefined;
    if (partitioned != null && partitioned['PartitionDateSource'] !== undefined) {
      sdkKeyFormat.PartitionedPrefix = {
        PartitionDateSource: partitioned['PartitionDateSource'] as string,
      };
    }
    if (Object.keys(sdkKeyFormat).length > 0) {
      loggingEnabled.TargetObjectKeyFormat = sdkKeyFormat;
    }
  }

  await this.s3Client.send(
    new PutBucketLoggingCommand({
      Bucket: bucketName,
      BucketLoggingStatus: { LoggingEnabled: loggingEnabled },
    })
  );
  this.logger.debug(`Applied logging configuration to bucket ${this.shown(bucketName)}`);
  return true;
}

/**
 * Apply website configuration
 *
 * CFn property: WebsiteConfiguration
 *   - IndexDocument -> SDK IndexDocument.Suffix
 *   - ErrorDocument -> SDK ErrorDocument.Key
 *   - RoutingRules -> SDK RoutingRules[]
 *   - RedirectAllRequestsTo -> SDK RedirectAllRequestsTo
 * SDK: PutBucketWebsite with WebsiteConfiguration
 */
export async function applyWebsiteConfiguration(
  this: S3BucketProvider,
  bucketName: string,
  websiteConfig: Record<string, unknown>
): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sdkConfig: any = {};

  const indexDoc = websiteConfig['IndexDocument'] as string | undefined;
  if (indexDoc) {
    sdkConfig['IndexDocument'] = { Suffix: indexDoc };
  }

  const errorDoc = websiteConfig['ErrorDocument'] as string | undefined;
  if (errorDoc) {
    sdkConfig['ErrorDocument'] = { Key: errorDoc };
  }

  const redirectAll = websiteConfig['RedirectAllRequestsTo'] as Record<string, unknown> | undefined;
  if (redirectAll) {
    sdkConfig['RedirectAllRequestsTo'] = {
      HostName: redirectAll['HostName'] as string,
      Protocol: redirectAll['Protocol'] as string | undefined,
    };
  }

  const routingRules = websiteConfig['RoutingRules'] as Array<Record<string, unknown>> | undefined;
  if (routingRules && Array.isArray(routingRules)) {
    sdkConfig['RoutingRules'] = routingRules.map((rule) => {
      const condition = rule['RoutingRuleCondition'] as Record<string, unknown> | undefined;
      const redirect = rule['RedirectRule'] as Record<string, unknown> | undefined;
      return {
        Condition: condition
          ? {
              HttpErrorCodeReturnedEquals: condition['HttpErrorCodeReturnedEquals'] as
                | string
                | undefined,
              KeyPrefixEquals: condition['KeyPrefixEquals'] as string | undefined,
            }
          : undefined,
        Redirect: redirect
          ? {
              HostName: redirect['HostName'] as string | undefined,
              HttpRedirectCode: redirect['HttpRedirectCode'] as string | undefined,
              Protocol: redirect['Protocol'] as string | undefined,
              ReplaceKeyPrefixWith: redirect['ReplaceKeyPrefixWith'] as string | undefined,
              ReplaceKeyWith: redirect['ReplaceKeyWith'] as string | undefined,
            }
          : undefined,
      };
    });
  }

  await this.s3Client.send(
    new PutBucketWebsiteCommand({
      Bucket: bucketName,
      WebsiteConfiguration: sdkConfig,
    })
  );
  this.logger.debug(`Applied website configuration to bucket ${this.shown(bucketName)}`);
}

/**
 * Apply accelerate configuration
 *
 * CFn property: AccelerateConfiguration.AccelerationStatus
 * SDK: PutBucketAccelerateConfiguration with AccelerateConfiguration.Status
 */
export async function applyAccelerateConfiguration(
  this: S3BucketProvider,
  bucketName: string,
  config: Record<string, unknown>
): Promise<void> {
  await this.s3Client.send(
    new PutBucketAccelerateConfigurationCommand({
      Bucket: bucketName,
      AccelerateConfiguration: {
        Status: config['AccelerationStatus'] as 'Enabled' | 'Suspended',
      },
    })
  );
  this.logger.debug(`Applied accelerate configuration to bucket ${this.shown(bucketName)}`);
}
