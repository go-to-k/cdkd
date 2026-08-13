/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return */
import {
  S3Client,
  CreateBucketCommand,
  DeleteBucketCommand,
  HeadBucketCommand,
  PutBucketVersioningCommand,
  PutBucketTaggingCommand,
  DeleteBucketTaggingCommand,
  PutBucketOwnershipControlsCommand,
  DeleteBucketOwnershipControlsCommand,
  GetBucketOwnershipControlsCommand,
  PutBucketNotificationConfigurationCommand,
  PutBucketCorsCommand,
  DeleteBucketCorsCommand,
  PutBucketLifecycleConfigurationCommand,
  DeleteBucketLifecycleCommand,
  PutPublicAccessBlockCommand,
  PutBucketEncryptionCommand,
  DeleteBucketEncryptionCommand,
  PutBucketLoggingCommand,
  PutBucketWebsiteCommand,
  DeleteBucketWebsiteCommand,
  PutBucketAccelerateConfigurationCommand,
  PutBucketMetricsConfigurationCommand,
  DeleteBucketMetricsConfigurationCommand,
  PutBucketAnalyticsConfigurationCommand,
  DeleteBucketAnalyticsConfigurationCommand,
  PutBucketIntelligentTieringConfigurationCommand,
  DeleteBucketIntelligentTieringConfigurationCommand,
  PutBucketInventoryConfigurationCommand,
  DeleteBucketInventoryConfigurationCommand,
  PutBucketReplicationCommand,
  DeleteBucketReplicationCommand,
  PutObjectLockConfigurationCommand,
  GetBucketEncryptionCommand,
  GetBucketTaggingCommand,
  GetBucketVersioningCommand,
  GetPublicAccessBlockCommand,
  GetBucketLifecycleConfigurationCommand,
  GetBucketCorsCommand,
  GetBucketWebsiteCommand,
  GetBucketLoggingCommand,
  GetBucketNotificationConfigurationCommand,
  GetBucketReplicationCommand,
  GetObjectLockConfigurationCommand,
  GetBucketAccelerateConfigurationCommand,
  ListBucketMetricsConfigurationsCommand,
  ListBucketAnalyticsConfigurationsCommand,
  ListBucketIntelligentTieringConfigurationsCommand,
  ListBucketInventoryConfigurationsCommand,
  NoSuchBucket,
  ListObjectVersionsCommand,
  DeleteObjectsCommand,
  type BucketLocationConstraint,
  type ObjectOwnership,
  type CORSRule,
} from '@aws-sdk/client-s3';
import { normalizeAwsTagsToCfn, resolveExplicitPhysicalId } from '../import-helpers.js';
import { getLogger } from '../../utils/logger.js';
import { getAwsClients } from '../../utils/aws-clients.js';
import { ProvisioningError } from '../../utils/error-handler.js';
import { assertRegionMatch, type DeleteContext } from '../region-check.js';
import { S3_AUTO_DELETE_OBJECTS_TAG, hasCdkAutoDeleteTag } from '../data-delete-intent.js';
import {
  coerceCfnBoolean,
  configBooleanRefusal,
  configStringRefusal,
  readConfigString,
  replayWarn,
  requireConfigArray,
  requireConfigObject,
  requireConfigString,
  type ConfigStringOptions,
} from '../config-shape.js';
import { generateResourceName } from '../resource-name.js';
import type {
  ResourceProvider,
  ResourceCreateResult,
  ResourceUpdateResult,
  ResourceImportInput,
  ResourceImportResult,
  CreateContext,
  UpdateContext,
} from '../../types/resource.js';

/**
 * A plain (non-array) object. `typeof x === 'object'` alone accepts arrays and
 * `null`; a `Transition: []` or an unresolved intrinsic pushed through as a
 * single transition entry makes S3 answer `MalformedXML` for the WHOLE
 * lifecycle configuration, so the legacy singular readers screen with this.
 */
/**
 * The `Id` of one per-item configuration, normalized to a string.
 *
 * `diffArrayConfigById` accepts an `Id` under a TRUTHINESS test, so an
 * unquoted-YAML `Id: 1` is a NUMBER that reaches the Put and lands in the
 * skipped-id set as a number. A `typeof id === 'string'` predicate on the other
 * side then reads that item as NOT skipped and records the never-applied
 * desired value — reviving, for exactly that shape, the phantom drift issue
 * #1612 exists to remove. Both sides go through this helper so they cannot
 * disagree about what an `Id` is.
 */
function configItemId(item: unknown): string | undefined {
  if (!isPlainObject(item)) return undefined;
  const id = item['Id'];
  if (typeof id === 'string') return id;
  if (typeof id === 'number' && Number.isFinite(id)) return String(id);
  return undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Is this `Destination` block written in the CFn FLATTENED form
 * (`{ BucketArn, Format, ... }`) rather than the SDK NESTED one
 * (`{ S3BucketDestination: { ... } }`)?
 *
 * ONE predicate, called from both `resolveS3BucketDestination` (which picks the
 * bag) and `s3BucketDestinationPath` (which names it). They were written out
 * twice and a reviewer rightly pointed out that two copies of a branch
 * condition must be edited together or a refusal starts naming the wrong key.
 *
 * `Bucket` is probed alongside `BucketArn` because the readers accept it
 * (`s3Dest['BucketArn'] ?? s3Dest['Bucket']`); omitting it made a
 * `{ Bucket }`-only block take the nested branch, find nothing, and drop — the
 * same silent drop one shape over.
 */
function isFlattenedDestination(dest: Record<string, unknown>): boolean {
  return Boolean(dest['BucketArn'] || dest['Bucket'] || dest['BucketAccountId'] || dest['Format']);
}

/**
 * The CFn path of the destination bag `resolveS3BucketDestination` will pick —
 * issue #1493 item 3, which is a MESSAGE concern, not a value one.
 *
 * Kept separate from the resolver rather than returned alongside the bag:
 * `gen-nested-key-coverage`'s write-evidence walk follows a plain
 * `const x = this.helper(...)` binding to the members written beneath it, and
 * a DESTRUCTURED `const { bag, path } = ...` is a shape it cannot follow — so
 * pairing the two silently withdrew the write evidence for
 * `Destination.BucketArn` / `.BucketAccountId` and turned an opted-in target
 * red with no behavior change at all. Measured against the pre-change provider
 * via the critic's `--providers-dir=` seam.
 */
function s3BucketDestinationPath(dest: unknown, destinationPath: string): string {
  return isPlainObject(dest) && isFlattenedDestination(dest)
    ? destinationPath
    : `${destinationPath}.S3BucketDestination`;
}

/**
 * The FLATTENED CFn `Destination` block cdkd actually SENDS for `declared`
 * (issue #1707) — the shared fold behind BOTH halves of the #1633 pair: the
 * per-item `effectiveProperties` record and
 * {@link S3BucketProvider.canonicalizeDesiredProperties}.
 *
 * The desired side accepts TWO spellings (`resolveS3BucketDestination` picks
 * either the flattened CFn block or the nested SDK `S3BucketDestination` one)
 * plus a `Bucket` / `BucketArn` alias inside either, while the readback
 * (`inventorySdkToCfn` / `analyticsSdkToCfn`) emits ONLY the flattened form with
 * `BucketArn`. So a record written in any other spelling can never match what
 * `readCurrentState` returns: `cdkd drift` re-reports it forever and `--revert`
 * re-issues the same Put — the never-emitted-KEY class of issue #1686, reached
 * through the SHAPE rather than through a value. The live CFn registry schema
 * agrees the flattened form is the only CFn spelling (`Destination` is
 * `{BucketArn, BucketAccountId, Format, Prefix}` with `additionalProperties:
 * false`), so `S3BucketDestination` and `Bucket` are cdkd-only tolerances.
 *
 * This NORMALIZES rather than retracting the tolerance, per the #1686 rule:
 * refusing the SDK spelling would break templates that deploy today. It also
 * supersedes #1670's write-back-at-the-DECLARED-branch decision, whose whole
 * reason was that writing at a hardcoded branch would leave the malformed value
 * alive at the other key and add a stray one — there is no other key left once
 * the block is normalized wholesale.
 *
 * `Format` is the one member a caller can override: the applier passes the
 * value it SENT, which differs from the declared one when the warn-and-
 * SUBSTITUTE read replaced it (#1670). Absent on BOTH sides it defaults to the
 * `'CSV'` the appliers send, so the record carries what AWS will report back
 * rather than one key fewer.
 *
 * @returns the flattened block, or `declared` BY IDENTITY when it already is
 *   one (so an ordinary template records byte-for-byte what it declared) or is
 *   not a shape this can fold at all (absent / malformed — left for the
 *   resolver's own refusal to report).
 */
function effectiveS3BucketDestination(declared: unknown, sentFormat?: unknown): unknown {
  if (!isPlainObject(declared)) return declared;
  const bag = isFlattenedDestination(declared)
    ? declared
    : (declared['S3BucketDestination'] as unknown);
  if (!isPlainObject(bag)) return declared;
  // The wire REQUIRES a bucket: `resolveS3BucketDestination` drops a bag with
  // neither `BucketArn` nor `Bucket` and the item is SKIPPED, so folding one
  // would describe a call that never went out (round-3 review — the same
  // mirror-the-wire rule the schedule fold learned, one property over). The
  // probe is truthiness, matching that guard exactly rather than approximating
  // it with a presence test.
  if (!bag['BucketArn'] && !bag['Bucket']) return declared;
  const out: Record<string, unknown> = {};
  const bucketArn = bag['BucketArn'] ?? bag['Bucket'];
  if (bucketArn !== undefined) out['BucketArn'] = bucketArn;
  if (bag['BucketAccountId'] !== undefined) out['BucketAccountId'] = bag['BucketAccountId'];
  out['Format'] =
    sentFormat ?? declaredOrDefault(bag, 'Format', INVENTORY_DESTINATION_DEFAULT_FORMAT);
  if (bag['Prefix'] !== undefined) out['Prefix'] = bag['Prefix'];
  return sameScalarRecord(out, declared) ? declared : out;
}

/**
 * `container[key]` when the key is DECLARED, else `fallback` — presence-based,
 * NEVER `??`, and that distinction is the whole guard against issue #1670's
 * finding 3.
 *
 * The ONE licensed `??` in these folds is the ALIAS read
 * `bag['BucketArn'] ?? bag['Bucket']`, and it is not an exception to this rule —
 * it supplies no DEFAULT. It picks between two spellings of the same declared
 * value, exactly as the applier's own read does, so a nullish `BucketArn`
 * correctly falls through to the alias the wire would have used. When neither is
 * declared the key is simply absent from the fold's output, which is what makes
 * a bucket-less block identity-return rather than gain a phantom key.
 *
 * The default belongs to a key the template OMITTED: there the provider sends
 * it, the readback reports it, and folding both sides is what makes them agree.
 * A key DECLARED with a malformed value is a different case entirely — the
 * provider warns and substitutes, records what it SENT, and `cdkd diff` must go
 * on reporting the difference until the template is corrected, because that
 * report plus the warning are the user's only signal. A `??` chain cannot tell
 * the two apart: it treats a declared `null` as absent and quietly folds the
 * template side onto the substituted value, so the comparison comes out equal,
 * the provider is never called, and the warning STOPS — the exact concealment
 * #1670 refused a twin over. Measured on `Format: null` while reviewing this
 * change; a malformed value that is not nullish (a blank string, an array, an
 * unresolved intrinsic) never hit it, so the unit rows written first all passed.
 */
function declaredOrDefault(
  container: Record<string, unknown>,
  key: string,
  fallback: unknown
): unknown {
  return key in container ? container[key] : fallback;
}

/**
 * The default `Destination.Format` both per-item appliers send when the block
 * declares none. Named rather than repeated so the wire value and the fold above
 * cannot drift apart.
 */
const INVENTORY_DESTINATION_DEFAULT_FORMAT = 'CSV';

/**
 * The default `Enabled` / `IncludedObjectVersions` an inventory item is SENT
 * with when it declares none — the same drift-apart concern as
 * {@link INVENTORY_DESTINATION_DEFAULT_FORMAT}.
 */
const INVENTORY_DEFAULT_ENABLED = true;
const INVENTORY_DEFAULT_INCLUDED_OBJECT_VERSIONS = 'All';

/** The `OutputSchemaVersion` an analytics data export is SENT with by default. */
const ANALYTICS_DEFAULT_OUTPUT_SCHEMA_VERSION = 'V_1';

/**
 * Are two records equal as SCALAR-valued bags? Used only to identity-return an
 * already-canonical block, so a fold that changes nothing cannot manufacture a
 * fresh object (and, through it, a fresh diff line on a template nobody edited).
 *
 * Scalar-only is sufficient here: every member of the CFn `Destination`
 * definition is a scalar (`{BucketArn, BucketAccountId, Format, Prefix}`).
 *
 * Precisely (review of #1707 corrected an over-claim): a nested value is
 * compared by REFERENCE like any other. On the flattened branch the fold copies
 * the caller's own references, so a nested value is `===` itself and identity IS
 * returned — which is correct, since nothing changed. It is only a
 * REBUILT nested value that compares different, and that falls back to recording
 * the folded block — the safe direction.
 */
function sameScalarRecord(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const aKeys = Object.keys(a);
  if (aKeys.length !== Object.keys(b).length) return false;
  // `Object.is`, not `===`, to match the fold's own comparisons. The only shapes
  // where they differ are `NaN` (a `Format` / `Prefix` that arrived as one would
  // otherwise rebuild an identical block on every deploy) and `-0` vs `0`, which
  // cannot diverge here because every slot is copied by reference from the same
  // bag. Verdict-neutral today; taken for consistency with `effectiveInventoryItem`.
  return aKeys.every((k) => Object.prototype.hasOwnProperty.call(b, k) && Object.is(a[k], b[k]));
}

/** The `ScheduleFrequency` an inventory item is SENT with when it declares none. */
const INVENTORY_DEFAULT_SCHEDULE_FREQUENCY = 'Weekly';

/**
 * The `InventoryConfigurations[]` ITEM cdkd actually SENDS for `item` — the ONE
 * helper behind both halves of the #1633 pair, per
 * `.claude/rules/providers.md`'s "share ONE helper with the provisioning path
 * rather than re-deriving the rule".
 *
 * Called from `applyInventoryConfigurations` with the values that went on the
 * wire (`sent`), and from
 * {@link S3BucketProvider.canonicalizeDesiredProperties} with none — where the
 * declared value IS what would be sent for every item the appliers do not warn
 * about, which is the whole population the twin exists for. On a MALFORMED value
 * the two deliberately disagree (the applier records the substituted value, the
 * fold keeps the declared one), so `cdkd diff` keeps reporting the field until
 * the template is corrected — the #1670 finding-3 outcome, preserved rather than
 * concealed.
 *
 * Three folds, all of them the never-emitted-KEY class (issue #1686) rather than
 * a narrowing:
 *
 * - `Schedule: { Frequency }` -> `ScheduleFrequency`. cdkd accepts the SDK
 *   spelling (the #1605 fall-through) while `inventorySdkToCfn` emits only the
 *   CFn one, which the registry schema declares REQUIRED and whose `Schedule`
 *   sibling it does not declare at all.
 * - `Destination` -> the flattened CFn block (see
 *   {@link effectiveS3BucketDestination}).
 * - `Enabled` / `IncludedObjectVersions` DEFAULTS. Both are always sent
 *   (`IsEnabled: … ?? true`, `readConfigString(…, 'All')`) and always read back,
 *   so an item omitting them recorded one key FEWER than the readback produces
 *   and the comparator saw a key-count mismatch on the whole array — the
 *   defaulted-but-SENT class of issue #1670, one property over (issue #1718).
 *
 * COPYING rather than mutating is load-bearing, not hygiene: `item` is an
 * element of the caller's DESIRED property bag, which `DiffCalculator` and the
 * engine still read afterwards — and the diff is now one of the two callers, so
 * mutating in place would rewrite the template side of a comparison the other
 * caller is in the middle of.
 *
 * @returns `item` BY IDENTITY when every fold is a no-op, so an ordinary
 *   fully-declared CFn template records and diffs byte-for-byte as before.
 */
function effectiveInventoryItem(
  item: Record<string, unknown>,
  sent?: { frequency?: unknown; format?: unknown }
): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  // `Enabled` used to be the one member whose WIRE read coerced SILENTLY
  // (`IsEnabled: … ?? true`, no guard, no warning), so this presence test did
  // NOT mirror it and a declared `Enabled: null` was sent as `true` while the
  // record kept `null`. Issue #1751 settled it on the WIRE instead: the applier
  // now REFUSES a declared-but-unusable value (skip on a replay, throw on a
  // template-path create), which is what makes presence the correct fold here —
  // the only way to reach the default now is an ABSENT key, exactly the case
  // the rule scopes it to. A declared-but-unusable value is deliberately left
  // ALONE: nothing was sent for that item, so there is no effective value to
  // record, and leaving it visible is what keeps `cdkd diff` reporting the
  // fault until the template is corrected.
  //
  // The COERCION is folded because it is one (issue #1633's lossless-coercion
  // arm, and it meets the #1643 bar): CFn is stringly typed, so `Enabled:
  // 'false'` is a legitimate declaration, the wire sends the coerced BOOLEAN,
  // and `inventorySdkToCfn` reads `IsEnabled` back as a boolean — so recording
  // the declared string would be a value `readCurrentState` can never match.
  const declaredEnabled = item['Enabled'];
  if (declaredEnabled === undefined) {
    patch['Enabled'] = INVENTORY_DEFAULT_ENABLED;
  } else {
    const coercedEnabled = coerceCfnBoolean(declaredEnabled);
    if (coercedEnabled !== undefined && !Object.is(declaredEnabled, coercedEnabled)) {
      patch['Enabled'] = coercedEnabled;
    }
  }
  if (item['IncludedObjectVersions'] === undefined) {
    patch['IncludedObjectVersions'] = INVENTORY_DEFAULT_INCLUDED_OBJECT_VERSIONS;
  }

  // The two-source precedence, mirrored from the wire by running the wire's OWN
  // predicate rather than approximating it. Two review rounds got this wrong
  // with a hand-rolled test, in three different directions, so the shape of the
  // fix matters more than the fix: `configStringRefusal` is PURE and importable,
  // and an earlier comment here claiming "a REFUSAL this pure fold cannot run"
  // was simply false. Measured against every container shape:
  //
  //   undefined / null / {} / {Frequency:'Daily'}  -> the wire SENDS (defaults)
  //   'Weekly' / [] / 42 / {Frequency:null|'   '}  -> the wire SKIPS (refuses)
  //
  // A hand-rolled `isPlainObject(x) && 'Frequency' in x` disagrees on THREE of
  // those. The two error directions cost differently and both are real:
  // treating a SENDS shape as unfoldable leaves state folded while the template
  // is not, which is the permanent `1 to update` issue #1717 exists to close;
  // treating a SKIPS shape as foldable collapses the desired side onto the
  // RETAINED previous item, so `update()` is never called and the skip warning
  // stops.
  const declaredSchedule = item['Schedule'];
  // `!== undefined`, not `in`: the wire's own gate is
  // `config['ScheduleFrequency'] !== undefined` (round-3 review). The two
  // differ only for an explicitly-`undefined` key, which a resolved template
  // cannot produce (`AWS::NoValue` omits the key and JSON has no `undefined`)
  // — but this is a fold whose whole thesis is running the wire's test rather
  // than one that merely agrees on the reachable inputs.
  const declaresScheduleFrequency = item['ScheduleFrequency'] !== undefined;
  const scheduleFrequencyUsable =
    declaresScheduleFrequency &&
    configStringRefusal(
      item,
      'ScheduleFrequency',
      INVENTORY_DEFAULT_SCHEDULE_FREQUENCY,
      'AWS::S3::Bucket InventoryConfigurations[]'
    ) === undefined;
  // Both sides pass a non-empty fallback and NO options, so the shared predicate
  // cannot disagree with the applier today (`containerPath` only shapes the
  // message). The one way that could drift is a future site threading
  // `ConfigStringOptions` — `coerceNumber` in particular — into
  // `skipOnUnusableConfigString` without threading it here (round-3 spec
  // review). Keep the two argument lists identical if that ever happens.
  const scheduleContainerUsable =
    configStringRefusal(
      declaredSchedule,
      'Frequency',
      INVENTORY_DEFAULT_SCHEDULE_FREQUENCY,
      'AWS::S3::Bucket InventoryConfigurations[].Schedule'
    ) === undefined;
  // A present-but-REFUSED `ScheduleFrequency` is deliberately NOT foldable even
  // when the container would carry the fall-through: the applier warns
  // ("Falling back to Schedule.Frequency") and the record holds the fallen-back
  // value, so folding the desired side onto it would compare equal and silence
  // that warning — the #1670 finding-3 concealment, which is the one thing the
  // presence rule elsewhere in this fold is protecting.
  const canFoldSchedule =
    sent?.frequency !== undefined ||
    scheduleFrequencyUsable ||
    (!declaresScheduleFrequency && scheduleContainerUsable);

  if (canFoldSchedule) {
    // Mirrors `readConfigString`'s own fallback: an absent container, a null
    // one, and an object without the key all take the default.
    const declaredFrequency = declaresScheduleFrequency
      ? item['ScheduleFrequency']
      : isPlainObject(declaredSchedule) && declaredSchedule['Frequency'] !== undefined
        ? declaredSchedule['Frequency']
        : INVENTORY_DEFAULT_SCHEDULE_FREQUENCY;
    const frequency = sent?.frequency ?? declaredFrequency;
    if (!Object.is(item['ScheduleFrequency'], frequency)) patch['ScheduleFrequency'] = frequency;
  }

  const destination = effectiveS3BucketDestination(item['Destination'], sent?.format);
  if (destination !== item['Destination']) patch['Destination'] = destination;

  // The key is dropped exactly when the wire sent SOMETHING — `inventorySdkToCfn`
  // can never emit `Schedule`, so a record that kept it could not match the
  // readback. When the wire skipped, AWS holds the previous configuration and
  // the declared item is left untouched, malformed container and all.
  const dropsSchedule = declaredSchedule !== undefined && canFoldSchedule;
  if (!dropsSchedule && Object.keys(patch).length === 0) return item;
  const out = { ...item, ...patch };
  // REMOVE the key rather than setting it to `undefined` (issue #1686): the
  // state record is written from this object and a present-but-`undefined` key
  // survives a `structuredClone`, so any consumer walking `Object.keys` — the
  // `unionWalkObjects` drift path does — would still see two different key sets.
  if (dropsSchedule) delete out['Schedule'];
  return out;
}

/**
 * The `AnalyticsConfigurations[]` ITEM twin of {@link effectiveInventoryItem}.
 *
 * Only the data-export block diverges: the destination takes the same flattening
 * (`analyticsSdkToCfn` emits the flattened CFn spelling too — note it spells the
 * account `BucketAccountId` on BOTH sides here, unlike the inventory reverse
 * mapper), and `OutputSchemaVersion` is a defaulted-but-SENT member of the same
 * class as inventory's `Enabled`.
 *
 * A non-object `StorageClassAnalysis` / `DataExport` is left ALONE rather than
 * rebuilt: those are exactly the shapes `requireConfigObject` refuses, so the
 * item is SKIPPED on the wire and folding it here would describe a call that
 * never went out.
 */
function effectiveAnalyticsItem(
  item: Record<string, unknown>,
  sent?: { outputSchemaVersion?: unknown; format?: unknown }
): Record<string, unknown> {
  const storageClassAnalysis = item['StorageClassAnalysis'];
  if (!isPlainObject(storageClassAnalysis)) return item;
  const dataExport = storageClassAnalysis['DataExport'];
  if (!isPlainObject(dataExport)) return item;

  const patch: Record<string, unknown> = {};
  const outputSchemaVersion =
    sent?.outputSchemaVersion ??
    declaredOrDefault(dataExport, 'OutputSchemaVersion', ANALYTICS_DEFAULT_OUTPUT_SCHEMA_VERSION);
  if (!Object.is(dataExport['OutputSchemaVersion'], outputSchemaVersion)) {
    patch['OutputSchemaVersion'] = outputSchemaVersion;
  }
  const destination = effectiveS3BucketDestination(dataExport['Destination'], sent?.format);
  if (destination !== dataExport['Destination']) patch['Destination'] = destination;

  if (Object.keys(patch).length === 0) return item;
  return {
    ...item,
    StorageClassAnalysis: {
      ...storageClassAnalysis,
      DataExport: { ...dataExport, ...patch },
    },
  };
}

/** The `Status` an intelligent-tiering item is SENT with when it declares none. */
const INTELLIGENT_TIERING_DEFAULT_STATUS = 'Enabled';

/**
 * The `IntelligentTieringConfigurations[]` ITEM twin of
 * {@link effectiveInventoryItem} — the third applier of the #1718 audit.
 *
 * It has no never-emitted KEY or SHAPE (its destination-less block is spelled
 * identically on both sides), so the ONLY fold is the defaulted-but-SENT
 * `Status`: the Put always carries one and `intelligentTieringSdkToCfn` always
 * reads it back, so an item omitting it recorded one key fewer than the readback
 * produces. There is no `sent` parameter because this applier has no
 * warn-and-SUBSTITUTE arm at all — a malformed `Status` SKIPS the item (issue
 * #1595: defaulting to `Enabled` would start moving objects into archive
 * tiers), so the only value the fold can ever supply is the create-path default.
 *
 * The fourth applier, metrics, needs no fold: it sends `Id` plus a `Filter`
 * derived from the declared predicates and defaults no scalar member.
 */
function effectiveIntelligentTieringItem(item: Record<string, unknown>): Record<string, unknown> {
  if (item['Status'] !== undefined) return item;
  return { ...item, Status: INTELLIGENT_TIERING_DEFAULT_STATUS };
}

/**
 * Normalize a bag's TOLERATED key spellings onto the ONE spelling the readback
 * emits — the shared core of the two #1748 folds.
 *
 * Each entry is `[emitted, tolerated]`: where the applier reads
 * `(bag['emitted'] ?? bag['tolerated'])`, this writes the SAME value under
 * `emitted` and REMOVES `tolerated`. The `??` is the licensed ALIAS form (the
 * one {@link declaredOrDefault} carves out): it supplies no DEFAULT, it picks
 * between two spellings of one declared value exactly as the applier's own read
 * does, so a nullish first spelling falls through to the second here for the
 * same reason it does on the wire.
 *
 * Keyed off the DECLARED shape, never off a refusal — the population that
 * matters carries no malformed value at all, so a condition riding a
 * substitution arm would miss it (issue #1686's first generalization).
 *
 * The tolerated key is REMOVED rather than set to `undefined`: `JSON.stringify`
 * drops an `undefined` member but the state record is written from this object
 * and a present-but-`undefined` key survives a `structuredClone`, so a consumer
 * walking `Object.keys` — the `unionWalkObjects` drift path does — would still
 * see two different key sets.
 *
 * @returns `bag` BY IDENTITY when no tolerated spelling is declared, so an
 *   ordinary CFn-spelled template records and diffs byte-for-byte as before.
 */
function foldToleratedAliases(
  bag: Record<string, unknown>,
  aliases: ReadonlyArray<readonly [emitted: string, tolerated: string]>
): Record<string, unknown> {
  let out: Record<string, unknown> | undefined;
  for (const [emitted, tolerated] of aliases) {
    if (bag[tolerated] === undefined) continue;
    out ??= { ...bag };
    out[emitted] = bag[emitted] ?? bag[tolerated];
    delete out[tolerated];
  }
  return out ?? bag;
}

/** The lifecycle `Transitions[]` aliases the applier accepts (issue #1748). */
const TRANSITION_ALIASES = [
  ['TransitionInDays', 'Days'],
  ['TransitionDate', 'Date'],
] as const;

/** The lifecycle `NoncurrentVersionTransitions[]` alias (issue #1748). */
const NONCURRENT_VERSION_TRANSITION_ALIASES = [['TransitionInDays', 'NoncurrentDays']] as const;

/** The `NotificationConfiguration` ARN aliases, per family (issue #1748). */
const NOTIFICATION_ARN_ALIASES: ReadonlyArray<
  readonly [listKey: string, aliases: ReadonlyArray<readonly [string, string]>]
> = [
  ['TopicConfigurations', [['Topic', 'TopicArn']]],
  ['QueueConfigurations', [['Queue', 'QueueArn']]],
  ['LambdaConfigurations', [['Function', 'LambdaFunctionArn']]],
];

/**
 * The `Event` / `Events` half of the same item (issue #1748).
 *
 * The ARN alias is not the only never-emitted spelling on a notification item,
 * and this one is the WIDER of the two: `TopicArn` is a cdkd-only tolerance
 * almost no template uses, while `Event` is the member the CFn registry schema
 * declares (`TopicConfiguration` is `{Event, Filter, Topic}` — there is no
 * `Events`) and therefore the one EVERY template carries. The applier accepts
 * both (`t['Event'] !== undefined ? [t['Event']] : t['Events']`).
 *
 * Unlike the ARN pair this is not a pure rename — the SDK member is a LIST — so
 * it folds by ARITY: a single-element list is the CFn `Event`, and a longer one
 * has no CFn spelling at all and is left as `Events`, which is what the readback
 * emits for it. That asymmetry is why it is a separate step rather than another
 * {@link foldToleratedAliases} entry.
 *
 * `readNotification` was emitting `Events` unconditionally, so the record and
 * the readback disagreed on every notification-configured bucket; it now
 * reverse-maps to the CFn spelling on the same arity rule, exactly as
 * `readLifecycle` already does for `TransitionInDays`. One-time drift on upgrade
 * for an already-deployed bucket, the same accepted cost the sibling reverse-map
 * changes in this file document, and it clears on the next deploy.
 */
function foldNotificationEvents(item: Record<string, unknown>): Record<string, unknown> {
  const events = item['Events'];
  if (events === undefined) return item;
  const out = { ...item };
  // A declared `Event` WINS, because the wire's own read prefers it.
  if (item['Event'] === undefined) {
    if (!Array.isArray(events) || events.length !== 1) return item;
    out['Event'] = events[0];
  }
  delete out['Events'];
  return out;
}

/**
 * The `NotificationConfiguration` cdkd ACTUALLY SENDS, in the spelling
 * `readNotification` emits (issue #1748) — the never-emitted-KEY class of issue
 * #1686 reached through the SHAPE rather than through a value.
 *
 * `applyNotificationConfiguration` accepts the SDK spelling of each destination
 * ARN alongside the CFn one (`t['Topic'] ?? t['TopicArn']`, and the two
 * siblings), while `readNotification` emits only `Topic` / `Queue` /
 * `Function` — the spellings the live CFn registry schema declares
 * (`TopicConfiguration` is `{Event, Filter, Topic}`, with no `TopicArn`
 * member at all, so the SDK spellings are cdkd-only tolerances). A record
 * written in the tolerated spelling therefore can never match the readback:
 * `cdkd drift` re-reports it forever and `--revert` re-issues the same Put,
 * with NO warning anywhere, because nothing is malformed and nothing is
 * substituted.
 *
 * This NORMALIZES rather than retracting the tolerance, per #1686's third
 * generalization: refusing the SDK spelling would break templates that deploy
 * today, and buys nothing the normalization does not.
 *
 * The Put is a FULL REPLACE with no skip arm, so there is no
 * previous-value-retained case to distinguish — whenever it succeeds, this is
 * what AWS holds.
 *
 * @returns `config` BY IDENTITY when no tolerated spelling is declared, or when
 *   it is not a shape this can fold at all (left for the applier's own
 *   handling).
 */
function effectiveNotificationConfiguration(config: unknown): unknown {
  if (!isPlainObject(config)) return config;
  let out = config;
  for (const [listKey, aliases] of NOTIFICATION_ARN_ALIASES) {
    out = canonicalizeItemList(out, listKey, (item) =>
      foldNotificationEvents(foldToleratedAliases(item, aliases))
    );
  }
  return out;
}

/**
 * The `LifecycleConfiguration` cdkd ACTUALLY SENDS, in the spelling
 * `readLifecycle` emits (issue #1748) — the lifecycle half of the same class.
 *
 * `applyLifecycleConfiguration` accepts the SDK day/date spellings alongside the
 * CFn ones on both transition families (`t['TransitionInDays'] ?? t['Days']`,
 * `t['TransitionDate'] ?? t['Date']`, `nvt['TransitionInDays'] ??
 * nvt['NoncurrentDays']`) while `readLifecycle` emits only `TransitionInDays` /
 * `TransitionDate` — again the only spellings the registry schema declares
 * (`Transition` is `{StorageClass, TransitionDate, TransitionInDays}`,
 * `NoncurrentVersionTransition` is `{StorageClass, TransitionInDays,
 * NewerNoncurrentVersions}`).
 *
 * The issue named the `Date` alias; the mechanical audit it asks for (match the
 * `(a['X'] ?? a['Y'])` ALIAS form, not a plain bracket read) found all THREE in
 * the same two item shapes, so fixing only the reported one would have left its
 * siblings broken — the "diff the WHOLE blob, not the reported key" rule.
 *
 * Two things deliberately NOT folded here, tracked rather than left unstated:
 * the legacy SINGULAR `Transition` / `NoncurrentVersionTransition` objects,
 * which `mergeLegacySingular` folds into the plural on the wire so the readback
 * can never emit them either — a MERGE with a collision arm that WARNS, not an
 * alias rename, so it needs its own decision (issue #1754); and the RULE-level
 * divergences the round-trip fence measured beside these
 * (`ExpirationInDays` / `NoncurrentVersionExpirationInDays` recorded against an
 * `Expiration` / `NoncurrentVersionExpiration` readback, and the sent-but-
 * unrecorded `Filter: {Prefix: ''}`), which are reshapes belonging on the
 * READBACK side and are wider than this class (issue #1755). So a rule using
 * these aliases converges on the aliases and still differs on those keys until
 * #1755 lands — which is the honest state, not a claim this makes lifecycle
 * whole.
 *
 * @returns `config` BY IDENTITY when no tolerated spelling is declared.
 */
function effectiveLifecycleConfiguration(config: unknown): unknown {
  if (!isPlainObject(config)) return config;
  return canonicalizeItemList(config, 'Rules', (rule) => {
    let out = canonicalizeItemList(rule, 'Transitions', (t) =>
      foldToleratedAliases(t, TRANSITION_ALIASES)
    );
    out = canonicalizeItemList(out, 'NoncurrentVersionTransitions', (nvt) =>
      foldToleratedAliases(nvt, NONCURRENT_VERSION_TRANSITION_ALIASES)
    );
    return out;
  });
}

/**
 * Apply a WHOLE-BLOCK fold to one top-level property on BOTH sides of a diff —
 * the {@link canonicalizeItemList} sibling for the two #1748 folds, whose unit
 * is the block rather than an item of a list.
 *
 * The COMPUTED `[key]:` write is load-bearing and must not be "tidied" into a
 * named-member spread (`{ ...out, LifecycleConfiguration: folded }`), which is
 * how this was first written. `gen-nested-key-coverage`'s write-evidence walk
 * recognizes a bag-derived spread-and-patch literal as a whole-blob HAND-OFF
 * (its #1475 recognizer) and credits everything beneath the named path as
 * delivered — so naming the member here made a DIFF-side pure function vouch for
 * the forward mapper and retired three reviewed `AWS::S3::Bucket` allow-list
 * entries (`LifecycleConfiguration.TransitionDefaultMinimumObjectSize`,
 * `…Rules.TagFilters.Key` / `.Value`), i.e. it silently switched the write pass
 * off for that whole subtree. Measured both ways via the critic's
 * `--providers-dir=` seam. A computed key names no member, which is exactly why
 * the pre-existing folds in this file are spelled that way.
 */
function canonicalizeBlock(
  properties: Record<string, unknown>,
  key: string,
  fold: (block: unknown) => unknown
): Record<string, unknown> {
  const folded = fold(properties[key]);
  return folded === properties[key] ? properties : { ...properties, [key]: folded };
}

/**
 * Apply a per-ITEM fold to an array-valued member on BOTH sides of a diff — the
 * `canonicalizeDesiredProperties` plumbing every fold in this file shares, from
 * the top-level `Id`-keyed properties down to the nested `Rules[].Transitions[]`
 * list (the bag is the containing OBJECT, which at the top level is the property
 * bag and one level down is the rule).
 *
 * Identity-returns at every level (untouched item -> untouched array ->
 * untouched bag), and leaves a non-array property or a non-object element ALONE
 * so a malformed template still reaches the provider's own refusal rather than
 * being reshaped into something that looks valid.
 */
function canonicalizeItemList(
  properties: Record<string, unknown>,
  key: string,
  fold: (item: Record<string, unknown>) => Record<string, unknown>
): Record<string, unknown> {
  const list = properties[key];
  if (!Array.isArray(list)) return properties;
  let changed = false;
  const mapped = list.map((element) => {
    if (!isPlainObject(element)) return element;
    const next = fold(element);
    if (next !== element) changed = true;
    return next;
  });
  return changed ? { ...properties, [key]: mapped } : properties;
}

/**
 * What one of the four `Id`-keyed appliers did to the items it was handed — the
 * per-item unit `effectiveProperties` is rebuilt from (issues #1612 / #1670).
 *
 * The two arms are reported SEPARATELY because they mean opposite things to the
 * effective array and `.claude/rules/providers.md` records why they cannot be
 * inferred from the shared `onUnusable` callback: a SKIPPED item never reached
 * AWS, so the effective entry is the previously-applied item (or nothing), while
 * a SUBSTITUTED item WAS applied and the effective entry is the item as SENT.
 * Collapsing them would record an applied configuration as skipped and retain a
 * previous value AWS no longer holds — manufacturing exactly the phantom drift
 * both mechanisms exist to remove.
 */
interface PerItemApplyOutcome {
  /** Indexes (into the applier's `configs` argument) of items that were SKIPPED. */
  skipped: number[];
  /**
   * Index -> the item as SENT, for an item that WAS applied but whose declared
   * value a warn-and-SUBSTITUTE read replaced with the default (issue #1670).
   */
  substituted: Map<number, Record<string, unknown>>;
}

/**
 * Name a malformed value in a refusal message, the way `config-shape.ts`'s
 * private `describe` does for the string-reading guards. Kept local rather than
 * exported from there because `resolveS3BucketDestination` is S3-specific
 * branch selection, not a shared shape guard — the two only share the wording.
 */
function describeValue(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  if (typeof value === 'string') return `a string ${JSON.stringify(value)}`;
  if (isPlainObject(value)) return `an object with keys [${Object.keys(value).join(', ')}]`;
  return `a ${typeof value} (${String(value)})`;
}

/**
 * Coerce a CFn numeric to a finite number. CloudFormation is stringly typed —
 * a hand-written or imported template (the audience the legacy lifecycle
 * branches exist for) can carry `"365"` where the schema says number.
 */
function coerceCfnNumber(value: unknown): number | undefined {
  // Screen the TYPE first: `Number([])` is 0 and `Number([5])` is 5, so an
  // unresolved-intrinsic array would coerce to a plausible-looking day count.
  // That is the same class `isPlainObject` blocks on the object path.
  if (typeof value !== 'number' && typeof value !== 'string') return undefined;
  if (value === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Merge a legacy SINGULAR action object into its modern plural array.
 *
 * S3 rejects two transitions with the same `StorageClass` and fails the whole
 * `PutBucketLifecycleConfiguration`, so a blind concatenation is unsafe. But
 * dropping the singular wholesale loses a legitimate template: a plural
 * `[{GLACIER, 30}]` alongside a singular `{DEEP_ARCHIVE, 90}` is two different
 * classes, which S3 accepts. So: keep both, let the PLURAL win on a
 * StorageClass collision, and say so rather than dropping in silence.
 */
function mergeLegacySingular(
  plural: unknown,
  singular: unknown,
  onCollision: (storageClass: string) => void
): Array<Record<string, unknown>> {
  const out = (Array.isArray(plural) ? plural : []).filter(isPlainObject);
  if (!isPlainObject(singular)) return out;
  const sc = singular['StorageClass'];
  if (typeof sc === 'string' && out.some((e) => e['StorageClass'] === sc)) {
    onCollision(sc);
    return out;
  }
  return [...out, singular];
}

/**
 * SDK Provider for AWS::S3::Bucket
 *
 * Uses S3 SDK directly instead of CC API for synchronous bucket creation.
 * S3's CreateBucket is synchronous - no polling needed, unlike CC API which
 * requires async polling (1s→1.5s→2.25s...) adding seconds per resource.
 */
export class S3BucketProvider implements ResourceProvider {
  private s3Client: S3Client;
  private logger = getLogger().child('S3BucketProvider');
  handledProperties = new Map<string, ReadonlySet<string>>([
    [
      'AWS::S3::Bucket',
      new Set([
        'BucketName',
        'VersioningConfiguration',
        'Tags',
        'OwnershipControls',
        'NotificationConfiguration',
        'CorsConfiguration',
        'LifecycleConfiguration',
        'PublicAccessBlockConfiguration',
        'BucketEncryption',
        'LoggingConfiguration',
        'WebsiteConfiguration',
        'AccelerateConfiguration',
        'MetricsConfigurations',
        'AnalyticsConfigurations',
        'IntelligentTieringConfigurations',
        'InventoryConfigurations',
        'ReplicationConfiguration',
        'ObjectLockConfiguration',
        'ObjectLockEnabled',
      ]),
    ],
  ]);

  unhandledByDesign = new Map<string, ReadonlyMap<string, string>>([
    [
      'AWS::S3::Bucket',
      new Map<string, string>([
        [
          'AccessControl',
          'Legacy canned ACL; AWS disables ACLs by default since 2023-04 — use BucketOwnershipControls + BucketPolicy / PublicAccessBlockConfiguration instead',
        ],
      ]),
    ],
  ]);

  constructor() {
    const awsClients = getAwsClients();
    this.s3Client = awsClients.s3;
  }

  /**
   * Get the region from the S3 client config
   */
  private async getRegion(): Promise<string> {
    const region = await this.s3Client.config.region();
    return region || 'us-east-1';
  }

  /**
   * Build attributes for an S3 bucket.
   *
   * Covers every CloudFormation `Fn::GetAtt` return value for
   * `AWS::S3::Bucket`. All fields are derivable from `bucketName` + region —
   * no extra AWS API call is needed. See:
   * https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-properties-s3-bucket.html#aws-properties-s3-bucket-return-values
   */
  private async buildAttributes(bucketName: string): Promise<Record<string, unknown>> {
    const region = await this.getRegion();
    return {
      Arn: `arn:aws:s3:::${bucketName}`,
      DomainName: `${bucketName}.s3.amazonaws.com`,
      DualStackDomainName: `${bucketName}.s3.dualstack.${region}.amazonaws.com`,
      RegionalDomainName: `${bucketName}.s3.${region}.amazonaws.com`,
      WebsiteURL: `http://${bucketName}.s3-website-${region}.amazonaws.com`,
    };
  }

  /**
   * Resolve a single `Fn::GetAtt` attribute for an existing bucket.
   *
   * Used by `cdkd orphan` to live-fetch attribute values that need to be
   * substituted into sibling references. All S3 Bucket attributes are
   * derivable from bucket name + region, so this avoids the round trip and
   * reuses the same templating as `buildAttributes`.
   */
  async getAttribute(
    physicalId: string,
    _resourceType: string,
    attributeName: string
  ): Promise<unknown> {
    const attrs = await this.buildAttributes(physicalId);
    return attrs[attributeName];
  }

  /**
   * Apply versioning configuration if specified
   */
  /**
   * @returns `true` when `PutBucketVersioning` was issued, `false` when the
   *   replay downgrade SKIPPED it. The caller records that skip in
   *   `effectiveProperties` so state describes what AWS holds (issue #1612).
   */
  private async applyVersioning(
    bucketName: string,
    versioningConfig: unknown,
    // The state-replay downgrade (issue #1605). Present only on a replay-
    // reachable call — the reverse-replacement create and the update path.
    onUnusable?: (message: string) => void
  ): Promise<boolean> {
    // The replay downgrade is a SKIP, and the reasoning is the inverse of the
    // usual one: here the DEFAULT is the dangerous direction. There is no item
    // to skip and no previous value to keep, so the only two answers are
    // "leave live versioning alone" and "take the Suspended fallback" — and
    // #1471 measured that exact fallback turning versioning OFF on a live
    // bucket. Skipping is not free either (`PutBucketVersioning` is the only
    // call that reverts a rollback of a versioning change, so a rollback whose
    // recorded value is malformed leaves versioning where it is), but an
    // un-reverted rollback is recoverable and a silently disabled object
    // history is not. The skip is ANNOUNCED so it is not a silent drop.
    if (onUnusable) {
      const refusal = configStringRefusal(
        versioningConfig,
        'Status',
        'Suspended',
        'AWS::S3::Bucket VersioningConfiguration'
      );
      if (refusal !== undefined) {
        // Deliberately NOT phrased as "leaving the LIVE state unchanged" (PR
        // review): this applier is reached from the reverse-replacement CREATE
        // too, where there is no live bucket and the real consequence is that
        // the restored bucket comes up UNVERSIONED. The wording covers both.
        onUnusable(
          `${refusal}. No PutBucketVersioning is issued rather than applying the Suspended ` +
            `default, which would turn object versioning OFF on an existing bucket (on a ` +
            `replayed create it means the bucket is left unversioned); the same value is ` +
            `REFUSED on a template-path create`
        );
        return false;
      }
    }
    // `unknown`, not `Record<string, unknown>`: the CREATE path's truthiness
    // gate lets a malformed value (`VersioningConfiguration: 'Enabled'`) reach
    // here, and defaulting its missing `Status` to Suspended is exactly the
    // silent versioning-OFF of issue #1471. Refuse instead.
    const status = readConfigString(
      versioningConfig,
      'Status',
      'Suspended',
      'AWS::S3::Bucket VersioningConfiguration'
    );
    await this.s3Client.send(
      new PutBucketVersioningCommand({
        Bucket: bucketName,
        VersioningConfiguration: {
          Status: status as 'Enabled' | 'Suspended',
        },
      })
    );
    this.logger.debug(`Applied versioning (${status}) to bucket ${bucketName}`);
    return true;
  }

  /**
   * Apply tags if specified
   */
  private async applyTags(
    bucketName: string,
    tags: Array<{ Key: string; Value: string }>
  ): Promise<void> {
    await this.s3Client.send(
      new PutBucketTaggingCommand({
        Bucket: bucketName,
        Tagging: {
          TagSet: tags,
        },
      })
    );
    this.logger.debug(`Applied ${tags.length} tags to bucket ${bucketName}`);
  }

  /**
   * Apply a diff between old and new CFn-shape Tags arrays via S3's
   * `PutBucketTagging` (full-replace) / `DeleteBucketTagging` APIs.
   *
   * S3's `PutBucketTagging` replaces the entire tag set in one call, so we
   * don't need separate add/remove API operations. When the new set is
   * empty, we issue `DeleteBucketTagging` to clear it. When old and new
   * are equal, we skip the call entirely.
   */
  private async applyTagDiff(
    bucketName: string,
    oldTagsRaw: Array<{ Key?: string; Value?: string }> | undefined,
    newTagsRaw: Array<{ Key?: string; Value?: string }> | undefined
  ): Promise<void> {
    const normalize = (
      tags: Array<{ Key?: string; Value?: string }> | undefined
    ): Array<{ Key: string; Value: string }> => {
      const out: Array<{ Key: string; Value: string }> = [];
      for (const t of tags ?? []) {
        if (t.Key !== undefined && t.Value !== undefined) out.push({ Key: t.Key, Value: t.Value });
      }
      return out;
    };

    const oldNorm = normalize(oldTagsRaw);
    const newNorm = normalize(newTagsRaw);
    if (JSON.stringify(oldNorm) === JSON.stringify(newNorm)) return;

    if (newNorm.length === 0) {
      // Clear tags. Use PutBucketTaggingCommand with empty TagSet — S3
      // does not have a public `DeleteBucketTagging` parity for the SDK
      // we use, so emit an empty Tagging set instead.
      try {
        await this.s3Client.send(
          new DeleteBucketTaggingCommand({
            Bucket: bucketName,
          })
        );
        this.logger.debug(`Cleared tags from bucket ${bucketName}`);
      } catch (err) {
        // Some S3 API versions reject empty TagSet on Put; fall back to
        // re-Put. The `NoSuchTagSet` (already-empty) response is fine.
        const e = err as { name?: string };
        if (e.name === 'NoSuchTagSet') return;
        throw err;
      }
      return;
    }
    await this.s3Client.send(
      new PutBucketTaggingCommand({
        Bucket: bucketName,
        Tagging: { TagSet: newNorm },
      })
    );
    this.logger.debug(`Replaced tag set on bucket ${bucketName} (${newNorm.length} tags)`);
  }

  /**
   * Apply CORS configuration
   *
   * CFn property: CorsConfiguration.CorsRules[]
   * SDK: PutBucketCors with CORSConfiguration.CORSRules[]
   *
   * CFn CorsRule fields map to SDK CORSRule fields:
   * - AllowedHeaders, AllowedMethods, AllowedOrigins, ExposedHeaders, MaxAge
   * SDK uses the same names except ExposedHeaders -> ExposeHeaders, MaxAge -> MaxAgeSeconds
   */
  private async applyCorsConfiguration(
    bucketName: string,
    corsConfig: { CorsRules: Array<Record<string, unknown>> }
  ): Promise<void> {
    const corsRules: CORSRule[] = corsConfig.CorsRules.map((rule) => ({
      ID: rule['Id'] as string | undefined,
      AllowedHeaders: rule['AllowedHeaders'] as string[] | undefined,
      AllowedMethods: rule['AllowedMethods'] as string[],
      AllowedOrigins: rule['AllowedOrigins'] as string[],
      ExposeHeaders: rule['ExposedHeaders'] as string[] | undefined,
      MaxAgeSeconds: rule['MaxAge'] as number | undefined,
    }));
    await this.s3Client.send(
      new PutBucketCorsCommand({
        Bucket: bucketName,
        CORSConfiguration: {
          CORSRules: corsRules,
        },
      })
    );
    this.logger.debug(`Applied CORS configuration to bucket ${bucketName}`);
  }

  /**
   * The per-item / per-rule STRING guard, with the applier's own SKIP as the
   * replay downgrade (issue #1595).
   *
   * Four per-item reads in this file refuse a malformed configuration ITEM
   * through a `readConfigString` that carries no `onUnusable`, so they threw on
   * the state-replay paths too — the un-rollbackable refusal every container
   * guard beside them exists to avoid. What they must NOT do instead is take
   * `readConfigString`'s own downgrade: its fallback is applied to a LIVE
   * resource, and each of these defaults ENABLES something (a lifecycle
   * expiration rule, an intelligent-tiering transition, a replication rule),
   * so warn-and-default is worse than the refusal it replaces. The correct
   * downgrade is the SKIP the sibling container guards already perform, with
   * the same per-applier unit — whole Put where the Put replaces every rule,
   * the single configuration item where the Put is per-Id.
   *
   * Returns `true` when the caller must skip. On the CREATE path (`onUnusable`
   * absent) it always returns `false` and the original read below still
   * throws, so template-borne behavior is unchanged.
   *
   * No `ConfigStringOptions` passthrough, and that is a decision rather than an
   * omission: a probe whose relaxations disagree with the read it fronts would
   * refuse exactly where the read accepts. All four sites are ENUM-valued
   * (`Status` / `IncludedObjectVersions`), so `coerceNumber` is wrong for them
   * by the rule in `config-shape.ts`'s header — a number where an enum belongs
   * is a bug. A site that ever needs an option must thread the SAME bag here.
   */
  private skipOnUnusableConfigString(
    container: unknown,
    key: string,
    fallback: string,
    containerPath: string,
    skipClause: string,
    onUnusable?: (message: string) => void
  ): boolean {
    if (!onUnusable) return false;
    const refusal = configStringRefusal(container, key, fallback, containerPath);
    if (refusal === undefined) return false;
    onUnusable(`${refusal}. ${skipClause}; the same value is REFUSED on a template-path create`);
    return true;
  }

  /**
   * A string read whose replay downgrade is a warn-and-SUBSTITUTE, reporting
   * the substitution so the caller can record what was SENT (issue #1670).
   *
   * The third shape beside {@link skipOnUnusableConfigString}'s SKIP and the
   * plain strict read, for the sites where the fallback IS the right value to
   * send. The deploy then succeeds with the default on the wire, so recording
   * the declared value describes a configuration AWS does not hold, and
   * `readCurrentState` reads all of these back — the permanent phantom drift
   * `.claude/rules/providers.md` records for the #1633 warn-and-default arm.
   *
   * These sites DO take a `canonicalizeDesiredProperties` twin as of issues
   * #1707 / #1717, and this paragraph said the opposite until then — it is
   * restated rather than deleted because the earlier answer was not wrong, it
   * was answering a different question. #1670 asked it about the SUBSTITUTED
   * VALUE and said no, because canonicalizing there would conceal a malformed
   * value whose warning is the user's only signal. The twin that shipped folds
   * the never-emitted KEY and SHAPE at the same sites, which have no fault to
   * conceal and emit no warning at all, and it is keyed off the DECLARED shape
   * so the substituted value stays visible exactly as before. See
   * {@link S3BucketProvider.canonicalizeDesiredProperties} and
   * {@link declaredOrDefault}.
   *
   * **It is now a verbatim alias of `readConfigString`**, and the bullets that
   * used to sit here described a probe that no longer exists — the same stale
   * -rationale class this round fixed one paragraph up, so it is named rather
   * than quietly rewritten. The `onSubstituted` callback it used to take is GONE
   * (review of #1707): recording is the per-item fold's job now, and all three
   * call sites had been left passing a comment-only no-op, so the probe ran a
   * second `configStringRefusal` per read purely to invoke nothing.
   *
   * It is kept rather than inlined for ONE reason, which is worth stating so the
   * next reader can weigh it: the name marks these three reads as the
   * warn-and-SUBSTITUTE sites, distinguishing them at a glance from the
   * SKIP-guarded ones (`skipOnUnusableConfigString`) and the plain strict reads.
   * The behavior is `readConfigString`'s, unchanged — `options.onUnusable`
   * carries the WARNING the "already ANNOUNCED" condition on
   * `effectiveProperties` needs, and without it the read still THROWS.
   */
  private readSubstitutedConfigString(
    container: unknown,
    key: string,
    fallback: string,
    containerPath: string,
    options: ConfigStringOptions
  ): string {
    return readConfigString(container, key, fallback, containerPath, options);
  }

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
  private async applyLifecycleConfiguration(
    bucketName: string,
    lifecycleConfig: {
      Rules: Array<Record<string, unknown>>;
      TransitionDefaultMinimumObjectSize?: unknown;
    },
    onUnusable?: (message: string) => void
  ): Promise<boolean> {
    // Validate every rule's `TagFilters` container up front (issue #1579): a
    // present-but-non-array value used to fall through `gatherScope`'s blind
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
      // probe in `gatherScope` — Prefix / TagFilters / ObjectSizeGreaterThan /
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
        requireConfigObject(rawFilter, 'AWS::S3::Bucket LifecycleConfiguration.Rules[].Filter', {
          ...(onUnusable ? { onUnusable } : {}),
        }) === undefined
      ) {
        return false;
      }
      const filter = rawFilter as Record<string, unknown> | undefined;
      const rawTagFilters = filter?.['TagFilters'] ?? rule['TagFilters'];
      if (rawTagFilters != null) {
        const validated = requireConfigArray(
          rawTagFilters,
          'AWS::S3::Bucket LifecycleConfiguration.Rules[].TagFilters',
          { ...(onUnusable ? { onUnusable } : {}) }
        );
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
          'Enabled',
          'AWS::S3::Bucket LifecycleConfiguration.Rules[]',
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
    // Gather a rule's full location scope from EVERY source CFn can express it:
    // an explicit `Filter` object (Prefix / TagFilters / ObjectSizeGreaterThan /
    // ObjectSizeLessThan), a top-level `Prefix` (the deprecated V1 form), AND the
    // top-level `ObjectSizeGreaterThan` / `ObjectSizeLessThan` rule properties —
    // which is the shape CDK's `LifecycleRule.objectSizeGreaterThan` actually
    // synthesizes (NOT nested under Filter). Reading only `Filter.*` silently
    // dropped those top-level size constraints.
    const gatherScope = (
      rule: Record<string, unknown>
    ): {
      prefix: string | undefined;
      tagFilters: Array<{ Key: string; Value: string }> | undefined;
      sizeGt: number | undefined;
      sizeLt: number | undefined;
    } => {
      const filter = rule['Filter'] as Record<string, unknown> | undefined;
      return {
        prefix: (filter?.['Prefix'] ?? rule['Prefix']) as string | undefined,
        // `TagFilters` lives at the RULE level in the CFn schema — there is no
        // `Filter` member on `AWS::S3::Bucket`'s lifecycle Rule at all, and a
        // real `cdk synth` of `LifecycleRule.tagFilters` emits it there (the
        // `Filter` read is cdkd's own accommodation for SDK-shaped / imported
        // input). Reading ONLY `Filter.TagFilters` dropped the tag scope, so a
        // tag-scoped rule fell through to the empty-prefix Filter below and
        // applied to the WHOLE bucket — for an expiration rule, that deletes
        // objects the rule was never meant to touch (issue #1388).
        tagFilters: (filter?.['TagFilters'] ?? rule['TagFilters']) as
          | Array<{ Key: string; Value: string }>
          | undefined,
        sizeGt: (filter?.['ObjectSizeGreaterThan'] ?? rule['ObjectSizeGreaterThan']) as
          | number
          | undefined,
        sizeLt: (filter?.['ObjectSizeLessThan'] ?? rule['ObjectSizeLessThan']) as
          | number
          | undefined,
      };
    };

    // S3 forbids mixing V1 (a top-level `Prefix` on the rule) and V2 (a `Filter`
    // element) rules within a SINGLE lifecycle configuration — `PutBucketLifecycle-
    // Configuration` rejects it with "Filter element can only be used in Lifecycle
    // V2." CloudFormation normalizes this transparently. Decide the form ONCE for
    // the whole config: a rule can stay V1 ONLY if its scope is EXACTLY a single
    // top-level `Prefix` (no tags, no size constraint, no explicit `Filter`). If
    // ANY rule needs a Filter (tags / size / explicit Filter / no scope at all),
    // emit EVERY rule in V2 Filter form (a bare top-level `Prefix` becomes
    // `Filter: { Prefix }`).
    const isPlainPrefixOnly = (rule: Record<string, unknown>): boolean => {
      // `!= null`, not `!== undefined`: the container guard above treats an
      // explicit `Filter: null` as ABSENT (nothing to refuse), so the strict
      // compare read the same value as PRESENT here and forced every rule in
      // the configuration into V2 Filter form. Aligning the two makes `null`
      // mean "block omitted" throughout the function, matching what the
      // sibling `TagFilters` reads already do.
      if (rule['Filter'] != null) return false;
      const s = gatherScope(rule);
      return (
        s.prefix !== undefined &&
        // `== null`, not `=== undefined`: an explicit `TagFilters: null` is
        // "no entries" per the list-block contract (`requireConfigArray`'s
        // callers keep the absent case as `== null`), and the strict compare
        // sent `null` into `.length` — a raw TypeError (PR #1580 review).
        (s.tagFilters == null || s.tagFilters.length === 0) &&
        s.sizeGt === undefined &&
        s.sizeLt === undefined
      );
    };
    const useFilterForm = !lifecycleConfig.Rules.every(isPlainPrefixOnly);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rules = lifecycleConfig.Rules.map((rule): any => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sdkRule: any = {
        ID: rule['Id'] as string | undefined,
        Status: readConfigString(
          rule,
          'Status',
          'Enabled',
          'AWS::S3::Bucket LifecycleConfiguration.Rules[]'
        ),
        // In V2-Filter form the location scope lives under `Filter` (set below);
        // a top-level `Prefix` alongside a `Filter` is exactly the illegal mix.
        Prefix: useFilterForm ? undefined : (rule['Prefix'] as string | undefined),
      };

      // Expiration
      const expiration = rule['ExpirationInDays'] || rule['ExpirationDate'] || rule['Expiration'];
      if (typeof expiration === 'number') {
        sdkRule.Expiration = { Days: expiration };
      } else if (typeof expiration === 'string') {
        sdkRule.Expiration = { Date: new Date(expiration) };
      } else if (expiration && typeof expiration === 'object') {
        const exp = expiration as Record<string, unknown>;
        sdkRule.Expiration = {
          Days: exp['Days'] as number | undefined,
          Date: exp['Date'] ? new Date(exp['Date'] as string) : undefined,
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
            `Lifecycle rule '${(rule['Id'] as string) ?? '<unnamed>'}' on ${bucketName} sets ` +
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
        // schedule. The `?? nvt['NoncurrentDays']` fallback keeps SDK-shaped /
        // imported input working, exactly as the `Transitions` mapping below
        // already does with `TransitionInDays ?? Days` (issue #1388).
        NoncurrentDays: (nvt['TransitionInDays'] ?? nvt['NoncurrentDays']) as number | undefined,
        StorageClass: nvt['StorageClass'] as string | undefined,
        NewerNoncurrentVersions: nvt['NewerNoncurrentVersions'] as number | undefined,
      });
      const nvts = rule['NoncurrentVersionTransitions'] as
        | Array<Record<string, unknown>>
        | undefined;
      const singularNvt = rule['NoncurrentVersionTransition'] as
        | Record<string, unknown>
        | undefined;
      const allNvts = mergeLegacySingular(nvts, singularNvt, (sc) =>
        this.logger.warn(
          `Lifecycle rule '${(rule['Id'] as string) ?? '<unnamed>'}' on ${bucketName} declares ` +
            `both NoncurrentVersionTransitions and the legacy NoncurrentVersionTransition for ` +
            `storage class ${sc}; S3 rejects duplicates, so the legacy singular was ignored.`
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
            ? new Date((t['TransitionDate'] ?? t['Date']) as string)
            : undefined,
        StorageClass: t['StorageClass'] as string | undefined,
      });
      const transitions = rule['Transitions'] as Array<Record<string, unknown>> | undefined;
      const singularTransition = rule['Transition'] as Record<string, unknown> | undefined;
      const allTransitions = mergeLegacySingular(transitions, singularTransition, (sc) =>
        this.logger.warn(
          `Lifecycle rule '${(rule['Id'] as string) ?? '<unnamed>'}' on ${bucketName} declares ` +
            `both Transitions and the legacy Transition for storage class ${sc}; S3 rejects ` +
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
      const { prefix, tagFilters, sizeGt, sizeLt } = gatherScope(rule);
      // `!= null` for the same reason as `isPlainPrefixOnly` above: an
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
        TransitionDefaultMinimumObjectSize: lifecycleConfig[
          'TransitionDefaultMinimumObjectSize'
        ] as import('@aws-sdk/client-s3').TransitionDefaultMinimumObjectSize | undefined,
      })
    );
    this.logger.debug(`Applied lifecycle configuration to bucket ${bucketName}`);
    return true;
  }

  /**
   * Apply public access block configuration
   *
   * CFn property: PublicAccessBlockConfiguration
   * SDK: PutPublicAccessBlock with PublicAccessBlockConfiguration
   * Field names are identical between CFn and SDK.
   */
  private async applyPublicAccessBlockConfiguration(
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
    this.logger.debug(`Applied public access block configuration to bucket ${bucketName}`);
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
  private async applyBucketEncryption(
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
      const byDefault = rule['ServerSideEncryptionByDefault'] as
        | Record<string, unknown>
        | undefined;
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
    this.logger.debug(`Applied encryption configuration to bucket ${bucketName}`);
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
  private async applyLoggingConfiguration(
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
      this.logger.debug(`Cleared logging configuration on bucket ${bucketName}`);
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
    this.logger.debug(`Applied logging configuration to bucket ${bucketName}`);
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
  private async applyWebsiteConfiguration(
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

    const redirectAll = websiteConfig['RedirectAllRequestsTo'] as
      | Record<string, unknown>
      | undefined;
    if (redirectAll) {
      sdkConfig['RedirectAllRequestsTo'] = {
        HostName: redirectAll['HostName'] as string,
        Protocol: redirectAll['Protocol'] as string | undefined,
      };
    }

    const routingRules = websiteConfig['RoutingRules'] as
      | Array<Record<string, unknown>>
      | undefined;
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
    this.logger.debug(`Applied website configuration to bucket ${bucketName}`);
  }

  /**
   * Apply accelerate configuration
   *
   * CFn property: AccelerateConfiguration.AccelerationStatus
   * SDK: PutBucketAccelerateConfiguration with AccelerateConfiguration.Status
   */
  private async applyAccelerateConfiguration(
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
    this.logger.debug(`Applied accelerate configuration to bucket ${bucketName}`);
  }

  /**
   * Apply notification configuration (full-replace via PutBucketNotificationConfiguration)
   *
   * CFn property: NotificationConfiguration with TopicConfigurations,
   *   QueueConfigurations, LambdaConfigurations, EventBridgeConfiguration.
   * SDK uses the same structure (PutBucketNotificationConfiguration replaces
   * the entire notification configuration in one call).
   */
  private async applyNotificationConfiguration(
    bucketName: string,
    notifConfig: Record<string, unknown> | undefined
  ): Promise<void> {
    // PutBucketNotificationConfiguration is a full-replace API; sending an
    // empty NotificationConfiguration clears all notifications.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cfg: any = {};

    if (notifConfig) {
      const topics = notifConfig['TopicConfigurations'] as
        | Array<Record<string, unknown>>
        | undefined;
      if (topics && Array.isArray(topics) && topics.length > 0) {
        cfg.TopicConfigurations = topics.map((t) => ({
          Id: t['Id'] as string | undefined,
          TopicArn: (t['Topic'] ?? t['TopicArn']) as string,
          Events: t['Event'] !== undefined ? [t['Event'] as string] : (t['Events'] as string[]),
          Filter: this.cfnNotifFilterToSdk(t['Filter']),
        }));
      }
      const queues = notifConfig['QueueConfigurations'] as
        | Array<Record<string, unknown>>
        | undefined;
      if (queues && Array.isArray(queues) && queues.length > 0) {
        cfg.QueueConfigurations = queues.map((q) => ({
          Id: q['Id'] as string | undefined,
          QueueArn: (q['Queue'] ?? q['QueueArn']) as string,
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
          LambdaFunctionArn: (l['Function'] ?? l['LambdaFunctionArn']) as string,
          Events: l['Event'] !== undefined ? [l['Event'] as string] : (l['Events'] as string[]),
          Filter: this.cfnNotifFilterToSdk(l['Filter']),
        }));
      }
      const eb = notifConfig['EventBridgeConfiguration'];
      // `isPlainObject`, not `!== undefined`: this branch now READS a member off
      // the block, so an explicit `null` (hand-written JSON / an intrinsic that
      // resolved to null) would throw where it previously just emitted the
      // block. A non-object stays on the pre-change enable-on-presence side.
      if (
        eb !== undefined &&
        (!isPlainObject(eb) || coerceCfnBoolean(eb['EventBridgeEnabled']) !== false)
      ) {
        // The SDK's `EventBridgeConfiguration` is an EMPTY structure — presence
        // enables EventBridge delivery, absence disables it. CFn instead carries
        // a REQUIRED boolean `EventBridgeEnabled` inside the block (that is what
        // `CfnBucket` renders), so the boolean has no SDK member to land on and
        // has to be translated into presence/absence here. Before issue #1430
        // the block was emitted whenever it existed, so an explicit
        // `EventBridgeEnabled: false` silently ENABLED notifications — the
        // inverse of the template's intent. Absent / unresolved values keep the
        // pre-existing enable-on-presence behavior.
        cfg.EventBridgeConfiguration = {};
      }
    }

    await this.s3Client.send(
      new PutBucketNotificationConfigurationCommand({
        Bucket: bucketName,
        NotificationConfiguration: cfg,
      })
    );
    this.logger.debug(`Applied notification configuration to bucket ${bucketName}`);
  }

  /**
   * Convert CFn notification Filter ({ S3Key: { Rules: [{ Name, Value }] } })
   * to SDK NotificationConfigurationFilter.Key.FilterRules.
   */
  private cfnNotifFilterToSdk(
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
  private async applyMetricsConfigurations(
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
    // `configs.entries()`: the nested-key critic's write-evidence walk resolves
    // `config` as a value read off the desired property BAG, and an
    // array-destructuring pattern is not a binding shape it can follow — so the
    // tidier spelling silently reports every member of this item's nested
    // blocks as `no-write-evidence` (measured: 9 divergences across the four
    // per-item appliers).
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
      // return value): the nested-key critic's write-evidence walk follows the
      // bag-read binding into the `And.Tags` write, and routing the value
      // through the helper call would sever that hand-off and false-flag
      // `TagFilters.Key` / `.Value` as never written.
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
      `Applied ${configs.length - skipped.length} metrics configuration(s) to bucket ${bucketName}`
    );
    return { skipped, substituted: new Map() };
  }

  /**
   * Pick the `S3BucketDestination` bag out of an analytics / inventory
   * `Destination` block, refusing a shape that would otherwise be dropped.
   *
   * Two shapes are legitimate and both must keep working: the CFn FLATTENED
   * form (`Destination: { BucketArn, Format, ... }`, what the schema declares)
   * and the SDK NESTED form (`Destination: { S3BucketDestination: { ... } }`,
   * accepted because state records and hand-written templates carry it).
   *
   * Issue #1493 item 2: the branch was picked by probing member presence
   * (`dest?.['BucketAccountId'] || dest?.['BucketArn'] || dest?.['Format']`),
   * so a `Destination` that is a STRING / array / unresolved intrinsic indexed
   * every probe to `undefined`, fell through to an equally-`undefined`
   * `S3BucketDestination`, and the caller's `s3Dest ? … : undefined` omitted
   * the whole block from the Put — a configuration silently deployed without
   * the destination it declared. Unlike the sibling defaulting class this is a
   * DROP, not a substituted default, so `readConfigString` does not cover it:
   * it needs its own decision, and per issue #1513's precedent that decision is
   * REFUSE on the template-borne create path, WARN on the replay-reachable
   * update path (`onUnusable`), where the desired bag can be a historical cdkd
   * state record with no template-side remedy.
   *
   * Also returns the CFn path of the bag it picked (issue #1493 item 3): the
   * callers used to hardcode `…Destination.S3BucketDestination` in the
   * `containerPath` they pass to `readConfigString`, so a refusal on the
   * FLATTENED branch — where the bag IS `dest` itself — named a key the user's
   * template does not contain.
   *
   * @returns the picked bag, or `undefined` when the block was ABSENT or was
   *   refused on a warn-only path. The caller distinguishes the two by testing
   *   its own `Destination` value — see the `continue` at each call site.
   */
  private resolveS3BucketDestination(
    dest: unknown,
    destinationPath: string,
    onUnusable?: (message: string) => void
  ): Record<string, unknown> | undefined {
    const nestedPath = `${destinationPath}.S3BucketDestination`;
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
        `${destinationPath} must be an object (got ${describeValue(dest)}) — check for an ` +
          `unresolved intrinsic or a mis-nested template value; the destination would ` +
          `otherwise be dropped from the request with no error`
      );
    }

    // Branch selection is TRUTHINESS-based, matching the pre-fix code exactly.
    // A presence (`!== undefined`) test reads better but silently re-routes
    // `{ BucketAccountId: '', S3BucketDestination: {...} }` from the nested
    // branch — where it worked — to the flat one, where it sends
    // `Bucket: undefined`. Turning a working template into a broken request is
    // the opposite of this guard's purpose, so the probe stays truthy and the
    // REFUSAL below is what the change actually adds.
    const bag = isFlattenedDestination(dest) ? dest : (dest['S3BucketDestination'] as unknown);

    if (bag === undefined || bag === null) {
      return drop(
        `${destinationPath} carries neither a bucket (BucketArn / Bucket) nor a nested ` +
          `S3BucketDestination object (got ${describeValue(dest)}) — the destination would ` +
          `otherwise be dropped from the request with no error`
      );
    }
    if (!isPlainObject(bag)) {
      return drop(
        `${nestedPath} must be an object (got ${describeValue(bag)}) — check for an ` +
          `unresolved intrinsic or a mis-nested template value; the destination would ` +
          `otherwise be dropped from the request with no error`
      );
    }

    // The bucket is REQUIRED by both APIs, and it is the one member neither
    // branch can default. Checking it on the PICKED bag rather than only on the
    // flat one closes the asymmetry a reviewer found: `{ S3BucketDestination: {} }`
    // is truthy, so it used to sail through to a `Bucket: undefined` Put.
    if (!bag['BucketArn'] && !bag['Bucket']) {
      return drop(
        `${bag === dest ? destinationPath : nestedPath} has no destination bucket ` +
          `(BucketArn / Bucket) (got ${describeValue(bag)}) — the request would be ` +
          `rejected by S3, or silently carry no destination`
      );
    }

    return bag;
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
  private async applyAnalyticsConfigurations(
    bucketName: string,
    configs: Array<Record<string, unknown>>,
    onUnusable?: (message: string) => void
  ): Promise<PerItemApplyOutcome> {
    const skipped: number[] = [];
    const substituted = new Map<number, Record<string, unknown>>();
    // A plain `for…of` over `configs` with a hand-kept index, NOT
    // `configs.entries()`: the nested-key critic's write-evidence walk resolves
    // `config` as a value read off the desired property BAG, and an
    // array-destructuring pattern is not a binding shape it can follow — so the
    // tidier spelling silently reports every member of this item's nested
    // blocks as `no-write-evidence` (measured: 9 divergences across the four
    // per-item appliers).
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
        const s3Dest = this.resolveS3BucketDestination(rawDest, analyticsDestPath, onUnusable);
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
        const destPath = s3BucketDestinationPath(rawDest, analyticsDestPath);
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
                    Bucket: (s3Dest['BucketArn'] ?? s3Dest['Bucket']) as string,
                    BucketAccountId: s3Dest['BucketAccountId'] as string | undefined,
                    // Same downgrade as the destination guard above: a
                    // rollback / `drift --revert` replays a STATE record here,
                    // so a malformed `Format` must not hard-fail one line below
                    // a guard that deliberately warns. And the same
                    // record-what-was-SENT rule as the schema version above
                    // (issue #1670) — recorded, since issue #1707, in the
                    // FLATTENED CFn spelling rather than at the branch the
                    // template declared, because that is the only spelling
                    // `analyticsSdkToCfn` can emit.
                    Format: (sentFormat = this.readSubstitutedConfigString(
                      s3Dest,
                      'Format',
                      INVENTORY_DESTINATION_DEFAULT_FORMAT,
                      destPath,
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
      `Applied ${configs.length - skipped.length} analytics configuration(s) to bucket ${bucketName}`
    );
    return { skipped, substituted };
  }

  /**
   * Apply intelligent tiering configurations
   *
   * CFn property: IntelligentTieringConfigurations[]
   * SDK: PutBucketIntelligentTieringConfiguration (one per configuration, keyed by Id)
   *
   * @returns what happened to each item, as {@link PerItemApplyOutcome} — the
   *   per-item unit of `effectiveProperties` (issue #1612). Its per-item
   *   `Status` read takes the SKIP downgrade rather than a substitution (issue
   *   #1595 — defaulting to `Enabled` would start archiving objects), so no
   *   MALFORMED value is ever recorded here. The `substituted` map is still
   *   populated for the defaulted-but-SENT arm (issue #1718): an item that
   *   simply OMITS `Status` is sent `Enabled` and read back with it, so a record
   *   without the key compares unequal to the readback for the whole array.
   *   That is the audit #1718 asks for on the sibling appliers — `metrics` has
   *   no defaulted scalar member at all (it sends only `Id` plus a `Filter`
   *   derived from the declared predicates), so it needs no fold.
   */
  private async applyIntelligentTieringConfigurations(
    bucketName: string,
    configs: Array<Record<string, unknown>>,
    onUnusable?: (message: string) => void
  ): Promise<PerItemApplyOutcome> {
    const skipped: number[] = [];
    const substituted = new Map<number, Record<string, unknown>>();
    // A plain `for…of` over `configs` with a hand-kept index, NOT
    // `configs.entries()`: the nested-key critic's write-evidence walk resolves
    // `config` as a value read off the desired property BAG, and an
    // array-destructuring pattern is not a binding shape it can follow — so the
    // tidier spelling silently reports every member of this item's nested
    // blocks as `no-write-evidence` (measured: 9 divergences across the four
    // per-item appliers).
    let index = -1;
    for (const config of configs) {
      index += 1;
      const id = config['Id'] as string;
      // Per-item `Status` (issue #1595) — the read below carries no
      // `onUnusable`, so a state replay hard-threw. The fallback `Enabled`
      // would switch a live intelligent-tiering configuration ON and start
      // moving objects into archive tiers, so the downgrade is a SKIP. The
      // Put is per-Id, so the unit is this configuration item — matching the
      // `TagFilters` guard a few lines below.
      if (
        this.skipOnUnusableConfigString(
          config,
          'Status',
          'Enabled',
          'AWS::S3::Bucket IntelligentTieringConfigurations[]',
          'Skipping this intelligent tiering configuration',
          onUnusable
        )
      ) {
        skipped.push(index);
        continue;
      }
      const tierings = config['Tierings'] as Array<Record<string, unknown>> | undefined;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const itConfig: any = {
        Id: id,
        Status: readConfigString(
          config,
          'Status',
          'Enabled',
          'AWS::S3::Bucket IntelligentTieringConfigurations[]'
        ),
        Tierings: (tierings || []).map((t: Record<string, unknown>) => ({
          AccessTier: t['AccessTier'] as string,
          Days: t['Days'] as number,
        })),
      };

      // Filter. Same predicate-count rule as applyAnalyticsConfigurations —
      // the old kind-count guard dropped every tag after the first when
      // Prefix was absent (issue #1573; And-with-only-Tags live-probed
      // 2026-08-11).
      const prefix = config['Prefix'] as string | undefined;
      // Non-array `TagFilters` guard (issue #1579) — see the metrics sibling,
      // including why the binding must stay a direct bag read.
      const tagFilters = config['TagFilters'] as Array<{ Key: string; Value: string }> | undefined;
      if (
        tagFilters != null &&
        requireConfigArray(
          tagFilters,
          'AWS::S3::Bucket IntelligentTieringConfigurations[].TagFilters',
          { ...(onUnusable ? { onUnusable } : {}) }
        ) === undefined
      ) {
        skipped.push(index);
        continue;
      }
      const tagCount = tagFilters?.length ?? 0;
      if ((prefix ? 1 : 0) + tagCount > 1) {
        itConfig.Filter = { And: { Prefix: prefix, Tags: tagFilters } };
      } else if (prefix) {
        itConfig.Filter = { Prefix: prefix };
      } else if (tagFilters && tagFilters.length === 1) {
        itConfig.Filter = { Tag: tagFilters[0] };
      }

      await this.s3Client.send(
        new PutBucketIntelligentTieringConfigurationCommand({
          Bucket: bucketName,
          Id: id,
          IntelligentTieringConfiguration: itConfig,
        })
      );
      // Recorded only once the Put has SUCCEEDED — see the analytics sibling.
      const sentItem = effectiveIntelligentTieringItem(config);
      if (sentItem !== config) substituted.set(index, sentItem);
    }
    this.logger.debug(
      `Applied ${configs.length - skipped.length} intelligent tiering configuration(s) to bucket ` +
        `${bucketName}`
    );
    return { skipped, substituted };
  }

  /**
   * Apply inventory configurations
   *
   * CFn property: InventoryConfigurations[]
   * SDK: PutBucketInventoryConfiguration (one per configuration, keyed by Id)
   *
   * @returns what happened to each item, as {@link PerItemApplyOutcome} — the
   *   per-item unit of `effectiveProperties` (issues #1612 / #1670). Both arms
   *   are reachable here: `IncludedObjectVersions` / the schedule frequency pair
   *   / the destination guard SKIP the item, while the destination `Format` read
   *   warns and SENDS a substituted default.
   */
  private async applyInventoryConfigurations(
    bucketName: string,
    configs: Array<Record<string, unknown>>,
    onUnusable?: (message: string) => void
  ): Promise<PerItemApplyOutcome> {
    const skipped: number[] = [];
    const substituted = new Map<number, Record<string, unknown>>();
    // A plain `for…of` over `configs` with a hand-kept index, NOT
    // `configs.entries()`: the nested-key critic's write-evidence walk resolves
    // `config` as a value read off the desired property BAG, and an
    // array-destructuring pattern is not a binding shape it can follow — so the
    // tidier spelling silently reports every member of this item's nested
    // blocks as `no-write-evidence` (measured: 9 divergences across the four
    // per-item appliers).
    let index = -1;
    for (const config of configs) {
      index += 1;
      const id = config['Id'] as string;
      // Per-item `IncludedObjectVersions` (issue #1595) — same replay split as
      // the intelligent-tiering sibling. Defaulting to `All` here is not
      // destructive, but it silently changes what the live inventory report
      // contains, and the destination guard immediately below already skips
      // the item on an unusable value — so the SKIP unit is taken from the
      // guard right next to it rather than invented. This applier is NOT
      // uniform overall and the comment used to claim it was: `Format` still
      // warns-and-defaults, and the `ScheduleFrequency` / `Schedule.Frequency`
      // pair takes a THIRD shape — fall through to the second source, then skip
      // the item when that is unusable too (issue #1605, below).
      if (
        this.skipOnUnusableConfigString(
          config,
          'IncludedObjectVersions',
          'All',
          'AWS::S3::Bucket InventoryConfigurations[]',
          'Skipping this inventory configuration',
          onUnusable
        )
      ) {
        skipped.push(index);
        continue;
      }
      // `Enabled` (issue #1751). The BOOLEAN sibling of the string guard above,
      // and the one member of this item that used to coerce SILENTLY: the wire
      // read was `(config['Enabled'] as boolean) ?? true`, so a declared
      // `Enabled: null` went out as `true` with no guard and no warning — while
      // the record kept `null`, which `readCurrentState` can never match.
      //
      // The direction is the one the file's siblings already take, not the
      // cheaper recording-side one the issue offered as its alternative:
      // defaulting a malformed `Enabled` to `true` on a LIVE inventory ENABLES
      // a report the template may have been trying to disable, which is exactly
      // the destructive-default class #1595 refuses. So the SKIP unit is taken
      // from the guard immediately above (this Put is per-`Id`) rather than
      // invented, and the CREATE path throws, matching every other member here.
      //
      // A CFn string boolean (`'false'`) is NOT malformed — CloudFormation is
      // stringly typed and cdkd is not — so the predicate is
      // `configBooleanRefusal`, which runs `coerceCfnBoolean`, i.e. literally
      // the function the wire read below calls.
      //
      // A NUMBER is refused, and that is a decision rather than an oversight —
      // the string sibling records its own `coerceNumber` relaxation the same
      // way. `requireConfigString` accepts a number at the sites where CFn's
      // scalar coercion makes one legitimate (an unquoted YAML `IpProtocol: -1`
      // deploys today); there is no such shape for `Enabled`, whose CFn type is
      // `boolean`, so a `1` here is a template bug and forwarding it — which is
      // what the pre-#1751 read did — put a non-boolean on the wire.
      const enabledRefusal = configBooleanRefusal(
        config,
        'Enabled',
        'AWS::S3::Bucket InventoryConfigurations[]'
      );
      if (enabledRefusal !== undefined) {
        if (!onUnusable) {
          throw new Error(
            `${enabledRefusal}. Omit the field entirely to use the default (${INVENTORY_DEFAULT_ENABLED})`
          );
        }
        onUnusable(
          `${enabledRefusal}. Skipping this inventory configuration: defaulting to ` +
            `${INVENTORY_DEFAULT_ENABLED} would ENABLE an inventory report the template may have ` +
            `been disabling; the same value is REFUSED on a template-path create`
        );
        skipped.push(index);
        continue;
      }
      const inventoryDestPath = 'AWS::S3::Bucket InventoryConfigurations[].Destination';
      const rawDest = config['Destination'];
      const s3Dest = this.resolveS3BucketDestination(rawDest, inventoryDestPath, onUnusable);
      // See the analytics sibling: a warned-away destination leaves the live
      // configuration untouched instead of sending a request S3 rejects.
      if (s3Dest === undefined && rawDest != null) {
        skipped.push(index);
        continue;
      }
      const destPath = s3BucketDestinationPath(rawDest, inventoryDestPath);
      // The value that goes ON THE WIRE for the one read a warn-and-SUBSTITUTE
      // downgrade can replace — see the analytics sibling (issue #1670). The
      // schedule frequency below is the other one, and both are handed to
      // {@link effectiveInventoryItem} after the Put succeeds.
      let sentFormat: string | undefined;

      // The schedule frequency is a TWO-SOURCE precedence read, so its replay
      // downgrade is neither of the two shapes #1595 settled (issue #1605):
      // for a malformed FIRST source the right answer is to FALL THROUGH to
      // the second, which is a value the record also carries and the one a
      // correct record would have used. When there is nothing to fall back to,
      // the item is SKIPPED with the same unit its `IncludedObjectVersions`
      // sibling above already uses (the Put is per-Id) — inventing a `Weekly`
      // cadence for a LIVE report is the substitution this guard class refuses.
      //
      // "Nothing to fall back to" includes an ABSENT second source, and that
      // is the case that matters rather than a corner (PR review blocker):
      // `ScheduleFrequency` is the ONLY spelling the CFn schema declares —
      // `tests/fixtures/cfn-schemas/AWS-S3-Bucket.json` has no `Schedule`
      // member — so a record with a broken `ScheduleFrequency` almost never
      // carries one. Treating an absent container as "usable" (which it is,
      // for a guard whose job is to reject a MALFORMED value) let the fall-
      // through land on `readConfigString`'s own `Weekly` default and made the
      // whole downgrade inert for real input.
      const scheduleFrequencyRefusal = onUnusable
        ? configStringRefusal(
            config,
            'ScheduleFrequency',
            'Weekly',
            'AWS::S3::Bucket InventoryConfigurations[]'
          )
        : undefined;
      if (scheduleFrequencyRefusal !== undefined && config['Schedule'] == null) {
        onUnusable?.(
          `${scheduleFrequencyRefusal}. Skipping this inventory configuration: there is no ` +
            `Schedule.Frequency to fall back to, and defaulting to Weekly would silently ` +
            `re-cadence a live inventory report; the same value is REFUSED on a template-path ` +
            `create`
        );
        skipped.push(index);
        continue;
      }
      if (scheduleFrequencyRefusal !== undefined) {
        onUnusable?.(
          `${scheduleFrequencyRefusal}. Falling back to Schedule.Frequency; the same value is ` +
            `REFUSED on a template-path create`
        );
      }
      const useScheduleFrequency =
        config['ScheduleFrequency'] !== undefined && scheduleFrequencyRefusal === undefined;
      if (
        !useScheduleFrequency &&
        this.skipOnUnusableConfigString(
          config['Schedule'],
          'Frequency',
          'Weekly',
          'AWS::S3::Bucket InventoryConfigurations[].Schedule',
          'Skipping this inventory configuration',
          onUnusable
        )
      ) {
        skipped.push(index);
        continue;
      }
      const frequency = useScheduleFrequency
        ? requireConfigString(
            config['ScheduleFrequency'],
            'Weekly',
            'AWS::S3::Bucket InventoryConfigurations[].ScheduleFrequency'
          )
        : readConfigString(
            config['Schedule'],
            'Frequency',
            'Weekly',
            'AWS::S3::Bucket InventoryConfigurations[].Schedule'
          );
      // The fall-through is a SUBSTITUTION too, and the one this applier's
      // three-shape comment made easiest to miss (issue #1670): the warning
      // above announces `Schedule.Frequency`, the Put SUCCEEDS carrying it, and
      // `inventorySdkToCfn` maps the live `Schedule.Frequency` BACK to
      // `ScheduleFrequency` — so leaving the malformed declared value in the
      // record is the same permanent phantom drift as the `Format` arm below.
      // The value recorded is `frequency` itself, i.e. what went on the wire.
      //
      // Issue #1686 is the SHAPE half of that, and it is why the condition is
      // not merely the refusal: `ScheduleFrequency` is the ONLY spelling the
      // readback can produce (`inventorySdkToCfn` reads the live
      // `Schedule.Frequency` and emits `ScheduleFrequency`, never a `Schedule`
      // member — confirmed against the live CFn registry schema, which declares
      // `ScheduleFrequency` REQUIRED and has no `Schedule` member at all). So a
      // record carrying `Schedule` describes a key AWS can never report, and
      // every `cdkd drift` re-reports it while `--revert` re-issues the same
      // Put. That is reachable with NO refusal in sight — an item declaring
      // only the SDK spelling sends the right cadence and records the wrong
      // key — so the normalization keys off the DECLARED shape.
      //
      // The decision this settles (the issue offered the opposite as its other
      // candidate): the SDK spelling stays ACCEPTED and is normalized on the
      // recording side. Refusing it instead would retract the #1605
      // fall-through, whose whole purpose is that a malformed
      // `ScheduleFrequency` lands on the value the record ALSO carries rather
      // than skipping a live inventory report.
      //
      // The `canonicalizeDesiredProperties` TWIN the rule requires alongside
      // this fold shipped in issue #1717 — see
      // {@link S3BucketProvider.canonicalizeDesiredProperties}, which folds the
      // SAME key through the SAME helper ({@link effectiveInventoryItem}) on
      // BOTH comparison sides. Until it did, an UNCHANGED template redeployed as
      // `1 to update` forever (measured us-east-1, 2026-08-12), because state
      // held the folded spelling while the template still declared the SDK one.
      // Folding both sides is also what HEALS the already-deployed population:
      // an item whose value never changes is never re-Put, so the recording side
      // alone could never reach a record written before the fold.

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const inventoryConfig: any = {
        Id: id,
        // The `??` is safe HERE and only here (issue #1751): the guard at the
        // top of the loop has already refused every declared-but-unusable
        // value, so the one way to reach the fallback is an ABSENT key — which
        // is the case a default belongs to. `coerceCfnBoolean`, not a cast: a
        // CFn `'false'` must reach AWS as `false`, and it is the same primitive
        // the guard ran.
        IsEnabled: coerceCfnBoolean(config['Enabled']) ?? INVENTORY_DEFAULT_ENABLED,
        IncludedObjectVersions: readConfigString(
          config,
          'IncludedObjectVersions',
          INVENTORY_DEFAULT_INCLUDED_OBJECT_VERSIONS,
          'AWS::S3::Bucket InventoryConfigurations[]'
        ),
        Schedule: {
          // Same class as the guarded siblings above (issue #1471): a
          // malformed `Schedule` used to index to `undefined` and silently
          // default to Weekly. The two-source precedence is preserved.
          Frequency: frequency,
        },
        Destination: {
          S3BucketDestination: s3Dest
            ? {
                Bucket: (s3Dest['BucketArn'] ?? s3Dest['Bucket']) as string,
                AccountId: s3Dest['BucketAccountId'] as string | undefined,
                // Same update-path downgrade as the analytics sibling, and the
                // same record-what-was-SENT rule (issue #1670) —
                // `inventorySdkToCfn` reads `Format` back, so a recorded
                // declared value AWS never received is permanent phantom drift.
                Format: (sentFormat = this.readSubstitutedConfigString(
                  s3Dest,
                  'Format',
                  INVENTORY_DESTINATION_DEFAULT_FORMAT,
                  destPath,
                  { ...(onUnusable ? { onUnusable } : {}) }
                )),
                Prefix: s3Dest['Prefix'] as string | undefined,
              }
            : undefined,
        },
        OptionalFields: config['OptionalFields'] as string[] | undefined,
        Filter: config['Prefix'] ? { Prefix: config['Prefix'] as string } : undefined,
      };

      await this.s3Client.send(
        new PutBucketInventoryConfigurationCommand({
          Bucket: bucketName,
          Id: id,
          InventoryConfiguration: inventoryConfig,
        })
      );
      // Recorded only once the Put has SUCCEEDED — see the analytics sibling.
      // The fold reads `config['Schedule']` itself and drops it, so there is no
      // second place that decides which items carry the SDK spelling.
      const sentItem = effectiveInventoryItem(config, {
        frequency,
        ...(sentFormat !== undefined ? { format: sentFormat } : {}),
      });
      if (sentItem !== config) substituted.set(index, sentItem);
    }
    this.logger.debug(
      `Applied ${configs.length - skipped.length} inventory configuration(s) to bucket ${bucketName}`
    );
    return { skipped, substituted };
  }

  /**
   * Apply replication configuration
   *
   * CFn property: ReplicationConfiguration
   *   - Role (IAM role ARN)
   *   - Rules[] (replication rules)
   * SDK: PutBucketReplication with ReplicationConfiguration
   */
  /**
   * Build the SDK `Destination` for one replication rule.
   *
   * Before issue #1495 this was an inline literal carrying `Bucket` / `Account`
   * / `StorageClass` only, so FOUR whole sub-blocks the CFn schema declares
   * were accepted from the template and never sent — each one silently:
   *
   * - `AccessControlTranslation` — cross-account replication with owner
   *   override; without it the replicas keep the SOURCE account's ownership.
   * - `EncryptionConfiguration.ReplicaKmsKeyID` — the replica-side SSE-KMS key;
   *   dropped, the replicas are not encrypted with the declared key. CDK's
   *   `aws-s3` L2 emits this for a `replicationRules` entry with a KMS key.
   * - `ReplicationTime` + `Metrics` — S3 Replication Time Control. RTC is a
   *   billed SLA feature and both blocks are required to enable it, so a
   *   template asking for RTC got plain asynchronous replication.
   *
   * CFn and the SDK spell every member identically here (verified against
   * `@aws-sdk/client-s3`'s `Destination`), but the block is assembled member by
   * member rather than forwarded so a CFn-only member cannot ride through.
   */
  private buildReplicationDestination(dest: Record<string, unknown>): Record<string, unknown> {
    const sdkDest: Record<string, unknown> = {
      Bucket: dest['Bucket'] as string,
      Account: dest['Account'] as string | undefined,
      StorageClass: dest['StorageClass'] as string | undefined,
    };

    // Every gate below is `!= null`, not truthiness: a FALSY malformed value
    // (`''`, `0`) must not be silently skipped — that is the #1493 gate bug one
    // level down, and `.claude/rules/providers.md` requires the `!= null` form.
    // Each block is also assembled into a local and only attached when it
    // carries at least one member, so a template's `AccessControlTranslation: {}`
    // does not become `{Owner: undefined}` on the wire (AWS rejects that, where
    // the pre-fix code sent nothing at all).
    // Each block is written as a NAMED assignment rather than through a helper
    // taking a string-literal key: `gen-nested-key-coverage`'s write-evidence
    // pass recognises `sdkDest['X'] = { … }`, and routing these through a
    // generic attach() made all 12 members invisible to it (measured: the S3
    // residual went 93 instead of 81). The empty-block guard is therefore
    // inlined per block.
    const acl = dest['AccessControlTranslation'] as Record<string, unknown> | undefined;
    if (acl != null && acl['Owner'] !== undefined) {
      sdkDest['AccessControlTranslation'] = { Owner: acl['Owner'] as string };
    }

    const encryption = dest['EncryptionConfiguration'] as Record<string, unknown> | undefined;
    if (encryption != null && encryption['ReplicaKmsKeyID'] !== undefined) {
      sdkDest['EncryptionConfiguration'] = {
        ReplicaKmsKeyID: encryption['ReplicaKmsKeyID'] as string,
      };
    }

    const replicationTime = dest['ReplicationTime'] as Record<string, unknown> | undefined;
    if (replicationTime != null) {
      const time = replicationTime['Time'] as Record<string, unknown> | undefined;
      const rt: Record<string, unknown> = {};
      if (replicationTime['Status'] !== undefined) rt['Status'] = replicationTime['Status'];
      if (time != null && time['Minutes'] !== undefined) {
        rt['Time'] = { Minutes: time['Minutes'] as number };
      }
      if (Object.keys(rt).length > 0) sdkDest['ReplicationTime'] = rt;
    }

    const metrics = dest['Metrics'] as Record<string, unknown> | undefined;
    if (metrics != null) {
      const threshold = metrics['EventThreshold'] as Record<string, unknown> | undefined;
      const m: Record<string, unknown> = {};
      if (metrics['Status'] !== undefined) m['Status'] = metrics['Status'];
      if (threshold != null && threshold['Minutes'] !== undefined) {
        m['EventThreshold'] = { Minutes: threshold['Minutes'] as number };
      }
      if (Object.keys(m).length > 0) sdkDest['Metrics'] = m;
    }

    return sdkDest;
  }

  /**
   * @returns `true` when the Put was issued, `false` when a replay downgrade
   *   SKIPPED the whole configuration (issue #1612).
   */
  private async applyReplicationConfiguration(
    bucketName: string,
    replConfig: Record<string, unknown>,
    onUnusable?: (message: string) => void
  ): Promise<boolean> {
    const rules = replConfig['Rules'] as Array<Record<string, unknown>> | undefined;
    // Validate every rule's `Filter` CONTAINER up front (issue #1581) — the
    // third instance of the class in this file, and the one with the widest
    // blast radius. A present-but-non-OBJECT `Filter` indexes the `And` /
    // `Prefix` / `TagFilter` probes below to `undefined` and falls through to
    // the "empty / unrecognized filter object" arm, which emits `Filter: {}` —
    // the valid CFn form meaning "replicate EVERY object". So a malformed
    // container silently replicated the WHOLE bucket instead of the declared
    // subset: data leaving its intended scope, at cross-region transfer cost.
    // A FALSY malformed value (`Filter: ''`) additionally skipped the
    // truthiness gate below and fell to the top-level-`Prefix` arm, which is
    // the #1493 gate-bug shape — so the gate is `!= null` here too.
    // Refuse on a template-path create; on the state-replay paths warn and
    // leave the WHOLE live replication configuration alone, since
    // `PutBucketReplication` replaces every rule at once — the same skip unit,
    // and the same reason, as the lifecycle Put.
    for (const rule of rules || []) {
      const rawFilter = rule['Filter'];
      if (
        rawFilter != null &&
        requireConfigObject(rawFilter, 'AWS::S3::Bucket ReplicationConfiguration.Rules[].Filter', {
          ...(onUnusable ? { onUnusable } : {}),
        }) === undefined
      ) {
        return false;
      }
      // The per-rule `Status` in the same loop (issue #1595) — the fourth
      // per-item refusal of this class and the one most likely to be mistaken
      // for already-handled, since it sits in the applier whose `Filter`
      // container is guarded directly above. Its read is in the `.map` below
      // and carries no `onUnusable`. The fallback `Enabled` would START
      // replicating for a rule the template had disabled — objects leaving the
      // bucket, at cross-region transfer cost — so the downgrade is a SKIP,
      // and `PutBucketReplication` replaces every rule at once, so the unit is
      // the whole Put.
      if (
        this.skipOnUnusableConfigString(
          rule,
          'Status',
          'Enabled',
          'AWS::S3::Bucket ReplicationConfiguration.Rules[]',
          // Path-neutral, for the same reason as the lifecycle sibling.
          'Leaving the whole replication configuration unapplied here',
          onUnusable
        )
      ) {
        return false;
      }
    }
    await this.s3Client.send(
      new PutBucketReplicationCommand({
        Bucket: bucketName,
        ReplicationConfiguration: {
          Role: replConfig['Role'] as string,
          Rules: (rules || []).map((rule) => {
            const dest = rule['Destination'] as Record<string, unknown>;
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const sdkRule: any = {
              ID: rule['Id'] as string | undefined,
              Status: readConfigString(
                rule,
                'Status',
                'Enabled',
                'AWS::S3::Bucket ReplicationConfiguration.Rules[]'
              ),
              Priority: rule['Priority'] as number | undefined,
              Destination: this.buildReplicationDestination(dest),
            };

            // SourceSelectionCriteria (issue #1495): which source objects are
            // eligible for replication. Never built before, so a rule opting
            // into replica-modification or SSE-KMS-object replication was
            // accepted from the template and never sent — silently replicating
            // a different set of objects than declared.
            const criteria = rule['SourceSelectionCriteria'] as Record<string, unknown> | undefined;
            if (criteria != null) {
              const sdkCriteria: Record<string, unknown> = {};
              const replicaMods = criteria['ReplicaModifications'] as
                | Record<string, unknown>
                | undefined;
              if (replicaMods != null && replicaMods['Status'] !== undefined) {
                sdkCriteria['ReplicaModifications'] = {
                  Status: replicaMods['Status'] as string,
                };
              }
              const sseKms = criteria['SseKmsEncryptedObjects'] as
                | Record<string, unknown>
                | undefined;
              if (sseKms != null && sseKms['Status'] !== undefined) {
                sdkCriteria['SseKmsEncryptedObjects'] = {
                  Status: sseKms['Status'] as string,
                };
              }
              if (Object.keys(sdkCriteria).length > 0) {
                sdkRule['SourceSelectionCriteria'] = sdkCriteria;
              }
            }

            // Filter (V2). An empty `Filter: {}` is the valid CFn "replicate every
            // object" form and MUST be preserved — S3's V2 replication schema
            // requires a `Filter` on every rule, so dropping the empty object
            // produces an invalid PutBucketReplication payload (the same element-
            // wise-transform-drops-a-valid-shape class as the lifecycle V1/V2 bug).
            const filter = rule['Filter'] as Record<string, unknown> | undefined;
            // `!= null` rather than the truthiness gate this used to be: after
            // the pre-pass guard at the top of this method only `null` /
            // `undefined` / a plain object can reach here, and every plain
            // object is truthy — so the two spellings are now equivalent and NO
            // test can distinguish them. Kept as defense-in-depth so the site
            // stays correct if the pre-pass is ever narrowed or moved; issue
            // #1581's hazard was precisely a falsy malformed value slipping
            // through a truthiness gate here.
            if (filter != null) {
              // CFn's ReplicationRuleFilter shapes, faithfully translated to the
              // S3 SDK shape (which differs only in `TagFilter`->`Tag` and
              // `And.TagFilters`->`And.Tags`):
              //   { And: { Prefix?, TagFilters[] } } <- the ONLY way CFn/CDK
              //       combine a prefix + tags (CDK's L2 emits this when a rule
              //       sets both `prefix` and `tags`). It was previously NOT read
              //       at all, so a combined filter silently fell through to the
              //       empty-filter branch below and replicated EVERY object
              //       instead of the prefix+tag subset (a silent scope-broadening
              //       divergence — same class as the lifecycle V1/V2 bug).
              //   { Prefix }     <- prefix-only
              //   { TagFilter }  <- single-tag-only
              //   {}             <- replicate-all (must be preserved; see #936)
              const and = filter['And'] as Record<string, unknown> | undefined;
              const prefix = filter['Prefix'] as string | undefined;
              const tagFilter = filter['TagFilter'] as { Key: string; Value: string } | undefined;
              if (and) {
                const andPrefix = and['Prefix'] as string | undefined;
                const andTags = and['TagFilters'] as
                  | Array<{ Key: string; Value: string }>
                  | undefined;
                const sdkAnd: Record<string, unknown> = {};
                if (andPrefix !== undefined) sdkAnd['Prefix'] = andPrefix;
                if (andTags !== undefined) sdkAnd['Tags'] = andTags;
                sdkRule['Filter'] = { And: sdkAnd };
              } else if (prefix !== undefined && tagFilter) {
                // Non-canonical template that put both at the top level; CFn
                // requires `And` to combine, but translate gracefully anyway.
                sdkRule['Filter'] = { And: { Prefix: prefix, Tags: [tagFilter] } };
              } else if (prefix !== undefined) {
                sdkRule['Filter'] = { Prefix: prefix };
              } else if (tagFilter) {
                sdkRule['Filter'] = { Tag: tagFilter };
              } else {
                // Empty / unrecognized filter object -> empty V2 filter (replicate all).
                sdkRule['Filter'] = {};
              }
            } else if (rule['Prefix'] !== undefined) {
              sdkRule['Prefix'] = rule['Prefix'] as string;
            }

            // DeleteMarkerReplication
            if (rule['DeleteMarkerReplication']) {
              const dmr = rule['DeleteMarkerReplication'] as Record<string, unknown>;
              sdkRule['DeleteMarkerReplication'] = { Status: dmr['Status'] as string };
            }

            return sdkRule;
          }),
        },
      })
    );
    this.logger.debug(`Applied replication configuration to bucket ${bucketName}`);
    return true;
  }

  /**
   * Apply object lock configuration
   *
   * CFn property: ObjectLockConfiguration
   *   - ObjectLockEnabled: 'Enabled'
   *   - Rule.DefaultRetention (Mode, Days, Years)
   * SDK: PutObjectLockConfiguration with ObjectLockConfiguration
   *
   * Note: ObjectLockEnabled at bucket level must be set at creation time.
   * This method only applies the rule/default retention config post-creation.
   */
  private async applyObjectLockConfiguration(
    bucketName: string,
    config: Record<string, unknown>
  ): Promise<void> {
    const rule = config['Rule'] as Record<string, unknown> | undefined;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const objectLockConfig: any = {
      ObjectLockEnabled: 'Enabled',
    };
    if (rule) {
      const retention = rule['DefaultRetention'] as Record<string, unknown> | undefined;
      if (retention) {
        objectLockConfig.Rule = {
          DefaultRetention: {
            Mode: retention['Mode'] as string | undefined,
            Days: retention['Days'] as number | undefined,
            Years: retention['Years'] as number | undefined,
          },
        };
      }
    }
    await this.s3Client.send(
      new PutObjectLockConfigurationCommand({
        Bucket: bucketName,
        ObjectLockConfiguration: objectLockConfig,
      })
    );
    this.logger.debug(`Applied object lock configuration to bucket ${bucketName}`);
  }

  /**
   * Apply additional bucket configuration after creation.
   *
   * `options.skipDiffManaged` is passed by `update()` for the three
   * sub-configs that moved onto the diff path (`VersioningConfiguration` /
   * `OwnershipControls` / `BucketEncryption`, issue #1466). They stay here for
   * CREATE — where there is no previous side to diff against — but on UPDATE
   * they must go through `applySubConfigDiffs` so a REMOVED property is reset
   * to the CloudFormation default instead of silently surviving. Applying them
   * in both places would double-PUT.
   */
  private async applyConfiguration(
    bucketName: string,
    properties: Record<string, unknown>,
    options: { skipTags?: boolean; skipDiffManaged?: boolean; context?: CreateContext } = {}
  ): Promise<Map<string, unknown>> {
    const { skipTags = false, skipDiffManaged = false, context } = options;
    // `effectiveProperties` overrides for anything a replay downgrade SKIPPED
    // (issue #1612). This method only runs the versioning applier on the CREATE
    // path — `update()` passes `skipDiffManaged` and lets `applySubConfigDiffs`
    // own it — so an override recorded here always means a replayed create
    // where NOTHING was applied and the key must be DROPPED, never retained.
    const overrides = new Map<string, unknown>();
    // Issue #1605: this method is reached by the reverse-replacement create as
    // well as the template one, and its versioning read is a refusal. Its
    // sibling `applyAllSubConfigsForCreate` already took the context for
    // exactly this reason (#1463); this one did not, so a state record
    // carrying a malformed `VersioningConfiguration` made the old bucket
    // unrestorable.
    const replayOnUnusable = replayWarn(this.logger, context).onUnusable;

    // Versioning
    const versioningConfig = properties['VersioningConfiguration'];
    // `!= null`, not truthiness: a falsy non-object ('' / 0 / false) is
    // MALFORMED and must reach the apply call so create refuses it the same
    // way update does (issue #1471). A truthy check silently skipped it on
    // create only, and a truthy-but-malformed value ('Enabled') then had its
    // missing `Status` defaulted to Suspended. Same rationale as the
    // OwnershipControls / BucketEncryption gates below; nullish rather than
    // strict-undefined to match `diffSubConfig`'s treatment of a desired null.
    if (!skipDiffManaged && versioningConfig != null) {
      const applied = await this.applyVersioning(bucketName, versioningConfig, replayOnUnusable);
      if (!applied) overrides.set('VersioningConfiguration', undefined);
    }

    // Tags. Only applied at create time here (`applyTags` is full-replace, no
    // removal). For update, the caller passes `skipTags=true` and uses the
    // diff-aware `applyTagDiff` helper instead.
    const tags = properties['Tags'] as Array<{ Key: string; Value: string }> | undefined;
    if (!skipTags && tags && Array.isArray(tags) && tags.length > 0) {
      await this.applyTags(bucketName, tags);
    }

    // Ownership Controls (e.g., BucketOwnerPreferred for CloudFront logs)
    const ownershipControls = properties['OwnershipControls'] as
      | { Rules: Array<{ ObjectOwnership: string }> }
      | undefined;
    // Normalized so an empty `Rules: []` (the readCurrentState placeholder, or
    // a condition-pruned template) is treated as not-declared instead of
    // firing a Put that AWS 400s — mirroring the encryption branch below.
    const normalizedOwnership = S3BucketProvider.emptyListConfigToUndefined(
      ownershipControls,
      'Rules'
    );
    // `!== undefined`, not truthiness: a falsy non-object ('' / 0 / false) is
    // MALFORMED and must reach the apply call so create fails the same way
    // update does. A truthy check would silently skip it on create only.
    if (!skipDiffManaged && normalizedOwnership !== undefined) {
      await this.applyOwnershipControls(bucketName, normalizedOwnership);
    }

    // Public Access Block Configuration
    const publicAccessBlock = properties['PublicAccessBlockConfiguration'] as
      | Record<string, unknown>
      | undefined;
    if (publicAccessBlock) {
      await this.applyPublicAccessBlockConfiguration(bucketName, publicAccessBlock);
    }

    // Bucket Encryption. Skip empty-rules placeholder (Class 2): AWS
    // rejects `PutBucketEncryption` when the rules array is empty
    // (`ServerSideEncryptionConfiguration must contain at least one
    // Rule`). `readCurrentState` always-emits
    // `BucketEncryption: { ServerSideEncryptionConfiguration: [] }` for
    // buckets without explicit SSE — that placeholder must NOT be pushed
    // back through `update()` on a `cdkd drift --revert` round-trip.
    //
    // Routed through the SAME normalizer the update path uses, so create and
    // update agree on what "empty" means. The previous inline
    // `Array.isArray(...) && length > 0` guard silently SKIPPED a malformed
    // value on create (leaving the bucket unencrypted-by-declaration with no
    // error and nothing for drift to see) while update failed loudly on it.
    const normalizedEncryption = S3BucketProvider.emptyListConfigToUndefined(
      properties['BucketEncryption'] as
        | { ServerSideEncryptionConfiguration: Array<Record<string, unknown>> }
        | undefined,
      'ServerSideEncryptionConfiguration'
    );
    if (!skipDiffManaged && normalizedEncryption !== undefined) {
      await this.applyBucketEncryption(bucketName, normalizedEncryption);
    }
    return overrides;
  }

  /**
   * CFn property: OwnershipControls
   * SDK: PutBucketOwnershipControls
   */
  private async applyOwnershipControls(
    bucketName: string,
    ownershipControls: { Rules: Array<{ ObjectOwnership: string }> }
  ): Promise<void> {
    // A malformed value reaches here by design (the normalizer passes it
    // through rather than reading it as a removal). Name the property instead
    // of letting `.map` throw a bare "Cannot read properties of undefined".
    if (!Array.isArray(ownershipControls?.Rules)) {
      throw new Error(
        `OwnershipControls.Rules must be an array (got ` +
          `${ownershipControls?.Rules === undefined ? 'undefined' : typeof ownershipControls.Rules}` +
          `) — check for an unresolved intrinsic or a mis-nested template value`
      );
    }
    await this.s3Client.send(
      new PutBucketOwnershipControlsCommand({
        Bucket: bucketName,
        OwnershipControls: {
          Rules: ownershipControls.Rules.map((r) => ({
            ObjectOwnership: r.ObjectOwnership as ObjectOwnership,
          })),
        },
      })
    );
    this.logger.debug(`Applied ownership controls to bucket ${bucketName}`);
  }

  /**
   * Normalize an "empty container" sub-config value to `undefined` so the diff
   * path cannot mistake a placeholder for a real value.
   *
   * `readCurrentState` always-emits placeholder shapes for un-configured
   * features (`BucketEncryption: { ServerSideEncryptionConfiguration: [] }`,
   * and the `OwnershipControls: { Rules: [] }` added with issue #1466), and a
   * `cdkd drift --revert` round-trip feeds those back through `update()`.
   *
   * The rule is "empty container == not declared", applied to BOTH sides. Per
   * pairing that means:
   *   empty desired  + absent previous -> no call (without this, a Put with an
   *                                      empty list, which both APIs reject)
   *   absent desired + empty previous  -> no call (without this, a Delete
   *                                      against a bucket that never had it)
   *   empty desired  + REAL previous   -> Delete. This one is NOT suppressed
   *                                      and must not be: it is a genuine
   *                                      declared -> not-declared transition,
   *                                      which is exactly what CloudFormation
   *                                      removes.
   *
   * "Empty" is deliberately NARROW. Only two shapes fold to `undefined`:
   * a block with NO keys at all (`{}`), and a block whose list key holds an
   * empty array. Everything else — a non-object, an array where the object
   * belongs (wrong nesting), a block whose list key is absent but which
   * carries OTHER keys, or a non-array list (an unresolved intrinsic) — is
   * MALFORMED, not empty, and passes through so the apply call refuses it by
   * name. Folding any of those to `undefined` would emit a Delete and
   * silently downgrade a live bucket (KMS -> AES256) while the template still
   * declares the config.
   *
   * NOTE this helper does NOT cover `VersioningConfiguration` (it has no list
   * key). That property is malformed-shape-refused separately, by
   * `readConfigString` in `applyVersioning` + `applySubConfigDiffs`
   * (issue #1471) — same outcome, different mechanism, because a versioning
   * block has an inner FIELD to validate rather than a list to measure.
   */
  private static emptyListConfigToUndefined<T extends Record<string, unknown>>(
    config: T | undefined,
    listKey: string
  ): T | undefined {
    if (config === undefined || config === null) return undefined;
    // A non-object (or an array where an object belongs -- the wrong-nesting
    // shape a hand-written L1 template produces) is MALFORMED, not empty.
    if (typeof config !== 'object' || Array.isArray(config)) return config;

    const list = config[listKey];
    if (list === undefined || list === null) {
      // The list key is absent. That is "not declared" ONLY when the block
      // carries nothing else; a block with OTHER keys is malformed or
      // partially pruned and must NOT be read as a removal.
      return Object.keys(config).length === 0 ? undefined : config;
    }
    // Genuinely empty list == not declared (the readCurrentState placeholder).
    if (Array.isArray(list) && list.length === 0) return undefined;
    // Non-array list (an unresolved intrinsic) is malformed -- pass through.
    return config;
  }

  /**
   * True when the DESIRED side DECLARES the property but its collection is
   * empty — the shape {@link emptyListConfigToUndefined} folds to `undefined`
   * and therefore cannot be told apart from an ABSENT property downstream
   * (issue #1713).
   *
   * That collapse is the whole defect. `OwnershipControls` /
   * `BucketEncryption` normalize BOTH sides through the fold before
   * `diffSubConfig`, so a non-empty previous against a declared-but-empty
   * desired took the **onDelete** arm and issued
   * `DeleteBucketOwnershipControls` / `DeleteBucketEncryption` — where the
   * lifecycle / CORS siblings SKIP the Put and leave the live configuration
   * alone (issue #1671). Measured against live CloudFormation (us-east-1,
   * 2026-08-12): updating a deployed bucket from an `aws:kms` default and a
   * `BucketOwnerPreferred` rule to `ServerSideEncryptionConfiguration: []` /
   * `Rules: []` drives the stack to `UPDATE_ROLLBACK_COMPLETE` with
   * `The XML you provided was not well-formed or did not validate against our
   * published schema`, and BOTH live configurations survive unchanged. So CFn
   * treats the empty collection as an INVALID template, not as a removal —
   * the same answer the #1671 A/B produced for lifecycle / CORS on the same
   * date and account — and cdkd was DELETING instead. For `BucketEncryption`
   * that silently drops a declared `aws:kms` default down to SSE-S3 / AES256
   * on a template whose only fault is a condition-pruned or
   * intrinsic-collapsed array.
   *
   * The fold itself is load-bearing and is NOT what changes here:
   * `readCurrentState` ALWAYS emits
   * `BucketEncryption: { ServerSideEncryptionConfiguration: [] }` and
   * `OwnershipControls: { Rules: [] }` for a bucket with no explicit setting,
   * so `cdkd drift --revert` feeds that placeholder back through `update()`
   * and both sides must keep normalizing for empty-vs-empty to compare EQUAL
   * and issue no call at all. This predicate rides alongside it and only
   * splits the arm the fold reaches: **declared-but-empty SKIPS, absent
   * DELETES**. A removal therefore still works — dropping the whole property
   * from the template is what expresses it, which is exactly what
   * `emptyCollectionSkip`'s warning tells the user.
   *
   * **Scoped to the shape #1713 MEASURED — the list key PRESENT and EMPTY —
   * and no wider.** The tempting spelling is "present, and the fold erased it",
   * i.e. delegate to {@link emptyListConfigToUndefined}. That is wrong here:
   * the fold ALSO erases a bare `{}`, which issue #1466 pinned as a REMOVAL and
   * #1713's live A/B did not exercise, so delegating would have reversed that
   * contract on evidence that does not cover it — caught when its pinned row
   * failed. (`{listKey: null}` as the sole key is NOT folded — the block
   * carries one key, so `emptyListConfigToUndefined` passes it through as
   * MALFORMED; an earlier draft of this comment claimed it was, which the
   * type's own `'{Rules: null} as the SOLE key is malformed'` test contradicts.)
   *
   * A MALFORMED block is out of scope for a different reason and needs no
   * clause here: the fold passes it through unchanged, so it never reaches the
   * Delete arm at all and is refused by name by the apply call.
   */
  private static declaresEmptyCollection(config: unknown, listKey: string): boolean {
    if (typeof config !== 'object' || config === null || Array.isArray(config)) return false;
    const list = (config as Record<string, unknown>)[listKey];
    return Array.isArray(list) && list.length === 0;
  }

  /**
   * Turn a set of per-property overrides into the `effectiveProperties` bag the
   * deploy engine records in place of the desired one (issues #1612 / #1670).
   *
   * A warn-and-SKIP arm makes the deploy SUCCEED while a declared configuration
   * never reaches AWS, and a warn-and-SUBSTITUTE read makes it succeed while a
   * DIFFERENT value than the declared one reaches AWS. Either way, recording
   * the desired bag verbatim writes something AWS does not hold:
   * `readCurrentState` can never match it, every later `cdkd drift` re-reports
   * the difference, and `drift --revert` re-issues the same call — the
   * permanent phantom drift `.claude/rules/providers.md` records for the EC2
   * Route warn arm (#1591), reached here through a skip or a substitution
   * instead of a narrowing.
   *
   * A `undefined` override value means the key is ABSENT from the effective
   * bag, which is why this walks the map rather than spreading it: spreading
   * would leave an explicit `undefined` that `JSON.stringify` drops on one
   * side of the next diff but not the other.
   *
   * @returns the complete replacement bag, or `undefined` when there is nothing
   *   to override — the engine then records the desired properties unchanged.
   */
  private static applyEffectiveOverrides(
    properties: Record<string, unknown>,
    overrides: Map<string, unknown>
  ): Record<string, unknown> | undefined {
    if (overrides.size === 0) return undefined;
    const effective: Record<string, unknown> = { ...properties };
    for (const [key, value] of overrides) {
      if (value === undefined) delete effective[key];
      else effective[key] = value;
    }
    return effective;
  }

  /**
   * The effective value of a per-item array property some of whose items a
   * replay downgrade SKIPPED (issue #1612).
   *
   * The Put for these four properties is per-`Id`, so the skip unit is one
   * configuration ITEM and the array must be rebuilt member by member: a
   * skipped CHANGE keeps the previously-applied item (that IS what AWS still
   * holds), a skipped ADD is dropped (AWS holds nothing for that `Id`), and
   * every unskipped item stays as declared.
   *
   * The DESIRED order is preserved deliberately — `DiffCalculator` compares
   * arrays positionally, so an effective array that merely reorders the same
   * items would manufacture a fresh phantom drift while removing the one this
   * exists to fix.
   *
   * An item that WAS applied but with a value a warn-and-SUBSTITUTE read
   * replaced is the third arm (issue #1670): it keeps its position and its
   * declared shape, and only the substituted field differs — `sentItem` is the
   * item AS SENT, which is what AWS holds and therefore what state must
   * describe.
   *
   * @param previous the previously-recorded array, or `undefined` on the
   *   replay-CREATE path, where nothing was ever applied and there is no
   *   previous item to substitute.
   * @param sentItemOf the item as SENT for an APPLIED item whose declared value
   *   was substituted, or `undefined` when declared == sent (the ordinary case).
   * @returns the effective array, or `undefined` when the key should be ABSENT
   *   from the effective bag (nothing survived AND the previous side declared
   *   nothing, so the property was never applied at all).
   */
  private static buildEffectiveItemArray(
    desired: Array<Record<string, unknown>>,
    previous: Array<Record<string, unknown>> | undefined,
    isSkipped: (item: Record<string, unknown>, index: number) => boolean,
    sentItemOf?: (
      item: Record<string, unknown>,
      index: number
    ) => Record<string, unknown> | undefined
  ): Array<Record<string, unknown>> | undefined {
    const previousById = new Map<string, Record<string, unknown>>();
    for (const item of previous ?? []) {
      const id = configItemId(item);
      if (id !== undefined) previousById.set(id, item);
    }
    const effective: Array<Record<string, unknown>> = [];
    desired.forEach((item, index) => {
      if (!isSkipped(item, index)) {
        effective.push(sentItemOf?.(item, index) ?? item);
        return;
      }
      // A DUPLICATE `Id` in the desired array substitutes the same previous
      // item at every matching position. `diffArrayConfigById` de-duplicates by
      // `Id`, so only one of them was ever attempted — the shape is degenerate
      // input AWS itself rejects, and mirroring the desired array's length is
      // the least surprising answer for it.
      const id = configItemId(item);
      const retained = id !== undefined ? previousById.get(id) : undefined;
      if (retained !== undefined) effective.push(retained);
    });
    if (effective.length === 0 && previous === undefined) return undefined;
    return effective;
  }

  /**
   * The empty-collection placeholder arm of {@link applySubConfigDiffs}: the
   * Put is SKIPPED, so AWS still holds the previously-applied configuration and
   * the record must say so (issue #1671).
   *
   * Without this the engine recorded `{Rules: []}` / `{CorsRules: []}` — a Put
   * that never ran, written as though it had. Unlike the malformed-value skips
   * #1612 settled, this arm is reachable from an ORDINARY template path rather
   * than only a state replay: a condition-pruned or intrinsic-collapsed
   * template synthesizes an empty rules array.
   *
   * The issue's open question was whether an empty collection is a REMOVAL
   * intent, which would make the skip itself wrong. **It is not** — measured
   * against live CloudFormation (us-east-1, 2026-08-12): updating a deployed
   * bucket to `LifecycleConfiguration: { Rules: [] }` +
   * `CorsConfiguration: { CorsRules: [] }` drives the stack to
   * `UPDATE_ROLLBACK_COMPLETE`, and BOTH live configurations survive the
   * rollback unchanged. So CFn treats the empty collection as an INVALID
   * template, not as a removal, and the configuration stays. That rules out
   * the opposite candidate answer: turning this arm into a Delete would both
   * diverge from CFn and destroy a live configuration the user still wants,
   * on a template whose only fault is a collapsed array. The registry schema
   * agrees on the shape (`Rules` / `CorsRules` are REQUIRED, with no
   * `minItems`, so `[]` parses and only the service refuses it).
   *
   * The skip therefore stands and the previous value is what state should
   * describe — the #1612 UPDATE answer, now with CFn behavior behind it.
   * Dropping the key instead would be wrong in the other direction: a later
   * template that genuinely REMOVES the block would derive no removal and the
   * live configuration would survive forever.
   *
   * The skip is also ANNOUNCED rather than silent, because CFn's own answer to
   * this template is a loud failure — a user whose rules stop being applied
   * should not have to diff state to find out. It is a warning rather than a
   * throw so the `readCurrentState` round-trip this arm exists to absorb
   * (`cdkd drift --revert` feeds an always-emitted empty-rules block back
   * through `update()`) keeps working.
   *
   * `collectionPath` is the WHOLE dotted path as ONE literal
   * (`'CorsConfiguration.CorsRules'`), never the bare terminal segment, and
   * that is load-bearing rather than stylistic. `gen-nested-key-coverage`'s key
   * pass takes the provider's bare string literals as evidence of explicit
   * per-key handling and keeps the STRICT literal set (only the shape pass
   * dot-expands), so the two spellings are not interchangeable here. Measured
   * against the shipped critic: a bare `'CorsRules'` literal anywhere in this
   * file turns the reviewed `AWS::S3::Bucket#CorsConfiguration.CorsRules`
   * allow-list entry STALE, while the joined path leaves the audit unchanged.
   * That entry's whole rationale is that the key is delivered by TYPED PROPERTY
   * ACCESS in `applyCorsConfiguration` and that its only literal mention is
   * `readCors`, excluded as a reverse map — so satisfying the critic by
   * deleting the entry would leave the key classified as handled on nothing but
   * a warning string, and a later real drop of `CorsRules` would pass in
   * silence. That is the decoy-literal shape `.claude/rules/providers.md`
   * forbids.
   */
  private emptyCollectionSkip(
    key: string,
    collectionPath: string,
    previousProperties: Record<string, unknown>,
    retainPrevious: (key: string) => void
  ): void {
    // The guard this fires from also covers an ABSENT / non-array collection (an
    // unresolved intrinsic reaches it), so the wording says "declares no rules"
    // rather than asserting an empty array the value may not have been.
    const hadPrevious = previousProperties[key] !== undefined;
    this.logger.warn(
      `AWS::S3::Bucket ${collectionPath} declares no rules, which CloudFormation rejects ` +
        `outright (the collection is a required property, and an empty one is not a removal ` +
        `intent). Leaving the live ${key} untouched and ` +
        (hadPrevious
          ? `recording the previously-applied value`
          : `recording no ${key} (nothing was applied before)`) +
        `; remove the whole ${key} property to delete the configuration.`
    );
    retainPrevious(key);
  }

  /**
   * The CREATE-path sibling of {@link emptyCollectionSkip} (issue #1718).
   *
   * `applyAllSubConfigsForCreate` carries the same empty-collection guard the
   * update path does and skipped in SILENCE, so a fresh bucket came up with a
   * declared lifecycle / CORS configuration that was never applied and nothing
   * said so. The template shape that motivated #1671 — a condition-pruned or
   * intrinsic-collapsed empty array — is equally reachable on a create, and the
   * live A/B recorded on {@link emptyCollectionSkip} measured CloudFormation
   * REFUSING it there too, so the skip stands and only the silence was the
   * defect.
   *
   * WHAT IT RECORDS is where the two paths differ, and the answer here is
   * NOTHING — deliberately, not by omission. The update path retains the
   * PREVIOUS value because AWS still holds it; on a create there is no previous
   * value, and the rule's replay-CREATE line ("DROP the key") would be the
   * obvious import. It is the wrong one at this site: `readLifecycle` /
   * `readCors` ALWAYS emit the empty placeholder for an unconfigured bucket
   * (`{Rules: []}` on `NoSuchLifecycleConfiguration`, `{CorsRules: []}` on an
   * absent CORS config), so the declared empty collection is ALREADY exactly
   * what `readCurrentState` returns — the two agree with no override at all,
   * while dropping the key would leave the template declaring one the record
   * does not and churn a no-op UPDATE on every deploy. The rule's drop answer is
   * scoped to a skip whose declared value AWS cannot report; this one it can.
   *
   * Known bound, stated because the guard is wider than the shape that was
   * measured. It fires for every DECLARED collection the apply gate rejects, not
   * only the `{Rules: []}` the live A/B covered:
   *
   * - a MALFORMED non-array collection (an unresolved intrinsic), where the
   *   record keeps a value the readback can never match — narrowing the record
   *   there is the #1612 malformed-value class rather than this one;
   * - an EMPTY block (`{}`), where the message is literally true (it declares no
   *   rules) and nothing is lost.
   *
   * The wording says "declares no rules" rather than asserting an empty ARRAY
   * for exactly that reason — the same hedge {@link emptyCollectionSkip} carries
   * on the update path, whose guard is equally wide. The gate is `!= null` and
   * not `!== undefined` (review of #1718): a property explicitly set to `null`
   * declares no configuration to lose, so warning about it would be noise, and
   * `!= null` is the convention the rest of this file's container gates use.
   */
  private announceCreateEmptyCollectionSkip(key: string, collectionPath: string): void {
    this.logger.warn(
      `AWS::S3::Bucket ${collectionPath} declares no rules, which CloudFormation rejects ` +
        `outright (the collection is a required property, and an empty one is not a removal ` +
        `intent). Creating the bucket WITHOUT the declared ${key}; remove the whole ${key} ` +
        `property if that is what you meant, or check for a condition-pruned or ` +
        `intrinsic-collapsed rules array.`
    );
  }

  /**
   * Diff CFn-shape sub-config values between previous and new state.
   *
   * Four transitions:
   * - undefined -> defined  (value differs from previous, OR previous undefined): Put
   * - defined -> undefined: Delete
   * - defined -> defined (different): Put
   * - unchanged: skip
   *
   * For the array-shaped configs (Metrics / Analytics / IntelligentTier /
   * Inventory) this is per-id rather than per-config — see the dedicated
   * helpers below.
   */
  private async diffSubConfig<T>(
    _bucketName: string,
    oldVal: T | undefined,
    newVal: T | undefined,
    onPut: (newVal: T) => Promise<void>,
    onDelete: () => Promise<void>
  ): Promise<void> {
    const same = JSON.stringify(oldVal ?? null) === JSON.stringify(newVal ?? null);
    if (same) return;
    if (newVal === undefined || newVal === null) {
      await onDelete();
      return;
    }
    await onPut(newVal);
  }

  /**
   * Per-id diff for the four array-shaped configs (MetricsConfigurations,
   * AnalyticsConfigurations, IntelligentTieringConfigurations,
   * InventoryConfigurations). Each AWS API operates on one config per
   * (bucket, id) pair: Put-on-add or Put-on-change, Delete-on-removed.
   */
  private async diffArrayConfigById(
    _bucketName: string,
    oldArr: Array<Record<string, unknown>> | undefined,
    newArr: Array<Record<string, unknown>> | undefined,
    onPut: (id: string, config: Record<string, unknown>) => Promise<void>,
    onDelete: (id: string) => Promise<void>
  ): Promise<void> {
    const oldById = new Map<string, Record<string, unknown>>();
    for (const c of oldArr ?? []) {
      const id = c['Id'] as string | undefined;
      if (id) oldById.set(id, c);
    }
    const newById = new Map<string, Record<string, unknown>>();
    for (const c of newArr ?? []) {
      const id = c['Id'] as string | undefined;
      if (id) newById.set(id, c);
    }

    // Adds + changes
    for (const [id, cfg] of newById) {
      const old = oldById.get(id);
      if (!old || JSON.stringify(old) !== JSON.stringify(cfg)) {
        await onPut(id, cfg);
      }
    }
    // Deletes
    for (const id of oldById.keys()) {
      if (!newById.has(id)) {
        await onDelete(id);
      }
    }
  }

  /**
   * Apply the diff between previous and new sub-configs, issuing Put / Delete
   * SDK calls only for differing keys. Called from `update()`.
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
  private async applySubConfigDiffs(
    bucketName: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>,
    context?: UpdateContext
  ): Promise<Map<string, unknown>> {
    const overrides = new Map<string, unknown>();
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
          `Bucket ${bucketName}: ${skippedIds.size + sentItems.size} skipped or substituted ` +
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
    // The refusal is probed rather than thrown (issue #1605). This read is on
    // the UPDATE path, which `rollback-executor.ts`'s revert arm and
    // `cdkd drift --revert` both drive with a cdkd STATE record as the DESIRED
    // bag — so a throw here is un-actionable, the user cannot edit a state
    // record from their template. The downgrade is UNCONDITIONAL, like
    // `EC2Provider.updateRoute`'s. `update()` DOES take a context as of issue
    // #1732, but it does not help here: `desiredFromAwsReadback` distinguishes
    // a readback from everything else, not a REPLAY from a template, and this
    // guard's question is the latter. And it must be a SKIP of
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
        `Bucket ${bucketName}: ${versioningRefusal}. Leaving the bucket's LIVE versioning state ` +
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
        properties['OwnershipControls'] as
          | { Rules: Array<{ ObjectOwnership: string }> }
          | undefined,
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
        this.logger.debug(`Deleted ownership controls on bucket ${bucketName}`);
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
        this.logger.debug(`Deleted bucket encryption on bucket ${bucketName}`);
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
              `Deleted lifecycle configuration on bucket ${bucketName} (reverting to an unset baseline)`
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
        // WARN, never throw, on the update path (issue #1579) — same
        // rationale as the analytics sibling below.
        const applied = await this.applyLifecycleConfiguration(bucketName, cfg, (m) =>
          this.logger.warn(m)
        );
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
        this.logger.debug(`Deleted lifecycle configuration on bucket ${bucketName}`);
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
              `Deleted CORS configuration on bucket ${bucketName} (reverting to an unset baseline)`
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
        this.logger.debug(`Deleted CORS configuration on bucket ${bucketName}`);
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
        this.logger.debug(`Deleted website configuration on bucket ${bucketName}`);
      }
    );

    // Logging — no DeleteBucketLogging API; clearing is via PutBucketLogging
    // with empty BucketLoggingStatus.
    await this.diffSubConfig(
      bucketName,
      previousProperties['LoggingConfiguration'] as Record<string, unknown> | undefined,
      properties['LoggingConfiguration'] as Record<string, unknown> | undefined,
      // Same unconditional update-path warn as the per-item appliers below:
      // this arm is replay-reachable and `update()` cannot tell a replay from
      // a template edit.
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
        await this.applyNotificationConfiguration(bucketName, cfg);
        // Issue #1748. This applier is a FULL REPLACE with no skip arm, so a
        // returning call means AWS holds exactly what was sent.
        recordEffectiveFold('NotificationConfiguration', effectiveNotificationConfiguration(cfg));
      },
      // The CLEAR arm sends an empty configuration and has no declared bag to
      // fold, so it needs no override.
      async () => this.applyNotificationConfiguration(bucketName, undefined)
    );

    // Replication
    await this.diffSubConfig(
      bucketName,
      previousProperties['ReplicationConfiguration'] as Record<string, unknown> | undefined,
      properties['ReplicationConfiguration'] as Record<string, unknown> | undefined,
      async (cfg) => {
        const applied = await this.applyReplicationConfiguration(bucketName, cfg, (m) =>
          this.logger.warn(m)
        );
        if (!applied) retainPrevious('ReplicationConfiguration');
      },
      async () => {
        await this.s3Client.send(new DeleteBucketReplicationCommand({ Bucket: bucketName }));
        this.logger.debug(`Deleted replication configuration on bucket ${bucketName}`);
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
      async (cfg) => this.applyObjectLockConfiguration(bucketName, cfg),
      async () => {
        await this.s3Client.send(
          new PutObjectLockConfigurationCommand({
            Bucket: bucketName,
            ObjectLockConfiguration: { ObjectLockEnabled: 'Enabled' },
          })
        );
        this.logger.debug(`Cleared object lock rule on bucket ${bucketName}`);
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
      // WARN, never throw, on the update path (issue #1579) — same rationale
      // as the analytics sibling below.
      async (id, cfg) => {
        const outcome = await this.applyMetricsConfigurations(bucketName, [cfg], (m) =>
          this.logger.warn(m)
        );
        metricsOutcomes.record(String(id), outcome);
      },
      async (id) => {
        await this.s3Client.send(
          new DeleteBucketMetricsConfigurationCommand({ Bucket: bucketName, Id: id })
        );
        this.logger.debug(`Deleted metrics configuration ${id} on bucket ${bucketName}`);
      }
    );
    retainPreviousItems('MetricsConfigurations', metricsOutcomes);

    // Analytics (per-id diff)
    const analyticsOutcomes = itemOutcomes();
    await this.diffArrayConfigById(
      bucketName,
      previousProperties['AnalyticsConfigurations'] as Array<Record<string, unknown>> | undefined,
      properties['AnalyticsConfigurations'] as Array<Record<string, unknown>> | undefined,
      // WARN, never throw, on the update path: `rollback-executor.ts` and
      // `drift --revert` replay `update()` with a historical cdkd STATE record
      // as the desired bag, so a refusal here would strand the resource with no
      // template-side remedy (issue #1493 item 2).
      async (id, cfg) => {
        const outcome = await this.applyAnalyticsConfigurations(bucketName, [cfg], (m) =>
          this.logger.warn(m)
        );
        analyticsOutcomes.record(String(id), outcome);
      },
      async (id) => {
        await this.s3Client.send(
          new DeleteBucketAnalyticsConfigurationCommand({ Bucket: bucketName, Id: id })
        );
        this.logger.debug(`Deleted analytics configuration ${id} on bucket ${bucketName}`);
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
      // WARN, never throw, on the update path (issue #1579) — same rationale
      // as the analytics sibling above.
      async (id, cfg) => {
        const outcome = await this.applyIntelligentTieringConfigurations(bucketName, [cfg], (m) =>
          this.logger.warn(m)
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
          `Deleted intelligent tiering configuration ${id} on bucket ${bucketName}`
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
      // Same update-path warn as the analytics sibling above.
      async (id, cfg) => {
        const outcome = await this.applyInventoryConfigurations(bucketName, [cfg], (m) =>
          this.logger.warn(m)
        );
        inventoryOutcomes.record(String(id), outcome);
      },
      async (id) => {
        await this.s3Client.send(
          new DeleteBucketInventoryConfigurationCommand({ Bucket: bucketName, Id: id })
        );
        this.logger.debug(`Deleted inventory configuration ${id} on bucket ${bucketName}`);
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
      const hasObjectLock = (p: Record<string, unknown>): boolean => {
        if (p['ObjectLockEnabled'] === true || p['ObjectLockEnabled'] === 'true') return true;
        const cfg = p['ObjectLockConfiguration'] as Record<string, unknown> | undefined;
        return cfg?.['ObjectLockEnabled'] === 'Enabled';
      };
      if (hasObjectLock(properties) || hasObjectLock(previousProperties)) {
        this.logger.warn(
          `Bucket ${bucketName}: versioning would be suspended (VersioningConfiguration removed ` +
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
    return overrides;
  }

  /**
   * Apply ALL sub-configs unconditionally on initial create. Used by
   * `create()` so the bucket starts out matching the template.
   *
   * @returns the per-property overrides for `effectiveProperties` (issues
   *   #1612 / #1670). Every downgrade reachable here is on the REPLAY-create
   *   path (the rollback executor's reverse-replacement arm), where the bucket
   *   is brand new and nothing was applied — so a SKIP drops the key rather
   *   than retaining a previous value, because there is no previous value to
   *   keep. The per-item arrays keep the items that DID apply, including an
   *   item applied with a SUBSTITUTED value, recorded as it was sent.
   */
  private async applyAllSubConfigsForCreate(
    bucketName: string,
    properties: Record<string, unknown>,
    context?: CreateContext
  ): Promise<Map<string, unknown>> {
    const overrides = new Map<string, unknown>();
    /**
     * Record a WHOLE-BLOCK fold: the effective value is what was SENT (issue
     * #1748). The create-path twin of `applySubConfigDiffs`'s helper of the same
     * name; identity sets no override, so an ordinary CFn-spelled template is
     * byte-for-byte unaffected.
     */
    const recordEffectiveFold = (key: string, sent: unknown): void => {
      if (sent !== properties[key]) overrides.set(key, sent);
    };
    /**
     * Record a per-ITEM applier outcome.
     *
     * A SKIPPED item is DROPPED — there is no previously-applied item to
     * substitute on a fresh bucket. An item applied with a SUBSTITUTED value
     * (issue #1670) is kept in place as SENT, which is a decision the create
     * path makes for the same reason the update path does: the Put SUCCEEDED,
     * so AWS holds the substituted value and state must say so.
     */
    const recordItemOutcome = (
      key: string,
      configs: Array<Record<string, unknown>>,
      outcome: PerItemApplyOutcome
    ): void => {
      if (outcome.skipped.length === 0 && outcome.substituted.size === 0) return;
      const skipped = new Set(outcome.skipped);
      overrides.set(
        key,
        S3BucketProvider.buildEffectiveItemArray(
          configs,
          undefined,
          (_item, index) => skipped.has(index),
          (_item, index) => outcome.substituted.get(index)
        )
      );
    };
    // `create()` is NOT always template-borne: `rollback-executor.ts`'s
    // reverse-replacement arm revives the OLD resource by calling
    // `create(..., previousState.properties, REPLAYING_STATE_CREATE_CONTEXT)`.
    // A bucket whose STATE record carries a malformed destination (written by
    // a pre-fix binary) would otherwise be unrestorable, with only a hand-edit
    // of state.json as a remedy — which is what `.claude/rules/providers.md`
    // requires a create-side pre-flight refusal to downgrade for.
    const replayOnUnusable = replayWarn(this.logger, context).onUnusable;
    // Notification (with EventBridge gate kept for backwards-compat with the
    // pre-existing single-EventBridge create path)
    const notifConfig = properties['NotificationConfiguration'] as
      | Record<string, unknown>
      | undefined;
    if (notifConfig) {
      await this.applyNotificationConfiguration(bucketName, notifConfig);
      // Issue #1748, the create-path twin of the update arm. Same rule, and it
      // is NOT the replay-only case the rest of this method handles: a
      // never-emitted SPELLING carries no malformed value and no downgrade, so
      // an ORDINARY template-path create reaches it.
      recordEffectiveFold(
        'NotificationConfiguration',
        effectiveNotificationConfiguration(notifConfig)
      );
    }

    // CORS — skip empty-rules placeholder
    const corsConfig = properties['CorsConfiguration'] as
      | { CorsRules: Array<Record<string, unknown>> }
      | undefined;
    if (
      corsConfig?.CorsRules &&
      Array.isArray(corsConfig.CorsRules) &&
      corsConfig.CorsRules.length > 0
    ) {
      await this.applyCorsConfiguration(bucketName, corsConfig);
    } else if (corsConfig != null) {
      this.announceCreateEmptyCollectionSkip('CorsConfiguration', 'CorsConfiguration.CorsRules');
    }

    // Lifecycle — skip empty-rules placeholder
    const lifecycleConfig = properties['LifecycleConfiguration'] as
      | { Rules: Array<Record<string, unknown>> }
      | undefined;
    if (
      lifecycleConfig?.Rules &&
      Array.isArray(lifecycleConfig.Rules) &&
      lifecycleConfig.Rules.length > 0
    ) {
      const applied = await this.applyLifecycleConfiguration(
        bucketName,
        lifecycleConfig,
        replayOnUnusable
      );
      // A SKIP drops the key (there is no previous value on a fresh bucket);
      // otherwise record what was SENT (issue #1748).
      if (!applied) overrides.set('LifecycleConfiguration', undefined);
      else
        recordEffectiveFold(
          'LifecycleConfiguration',
          effectiveLifecycleConfiguration(lifecycleConfig)
        );
    } else if (lifecycleConfig != null) {
      this.announceCreateEmptyCollectionSkip(
        'LifecycleConfiguration',
        'LifecycleConfiguration.Rules'
      );
    }

    // Logging
    const loggingConfig = properties['LoggingConfiguration'];
    // Shape-check the container BEFORE the has-a-destination gate (issue
    // #1471): the old `loggingConfig?.['DestinationBucketName']` test indexed a
    // malformed value to `undefined` and silently skipped the whole block, so
    // a bucket whose template declares logging came up with none. Absent /
    // `{}` still resolve to '' and skip, which is the legitimate no-logging
    // path — this adds a refusal, not an extra API call.
    //
    // The GATE has to take the replay downgrade too (issue #1605), not just
    // the applier: it reads the same field to decide whether to call at all,
    // so leaving it strict would throw before the applier's skip could run.
    const loggingRefusal = replayOnUnusable
      ? configStringRefusal(
          loggingConfig,
          'DestinationBucketName',
          '',
          'AWS::S3::Bucket LoggingConfiguration'
        )
      : undefined;
    if (loggingRefusal !== undefined) {
      replayOnUnusable?.(
        `${loggingRefusal}. Skipping the logging configuration; the same value is REFUSED on a ` +
          `template-path create`
      );
      overrides.set('LoggingConfiguration', undefined);
    } else {
      const loggingDestination = readConfigString(
        loggingConfig,
        'DestinationBucketName',
        '',
        'AWS::S3::Bucket LoggingConfiguration'
      );
      if (loggingDestination !== '') {
        const applied = await this.applyLoggingConfiguration(
          bucketName,
          loggingConfig,
          replayOnUnusable
        );
        if (!applied) overrides.set('LoggingConfiguration', undefined);
      }
    }

    // Website
    const websiteConfig = properties['WebsiteConfiguration'] as Record<string, unknown> | undefined;
    if (websiteConfig) {
      await this.applyWebsiteConfiguration(bucketName, websiteConfig);
    }

    // Accelerate
    const accelerateConfig = properties['AccelerateConfiguration'] as
      | Record<string, unknown>
      | undefined;
    if (accelerateConfig) {
      await this.applyAccelerateConfiguration(bucketName, accelerateConfig);
    }

    // Metrics Configurations
    const metricsConfigs = properties['MetricsConfigurations'] as
      | Array<Record<string, unknown>>
      | undefined;
    if (metricsConfigs && Array.isArray(metricsConfigs) && metricsConfigs.length > 0) {
      recordItemOutcome(
        'MetricsConfigurations',
        metricsConfigs,
        await this.applyMetricsConfigurations(bucketName, metricsConfigs, replayOnUnusable)
      );
    }

    // Analytics Configurations
    const analyticsConfigs = properties['AnalyticsConfigurations'] as
      | Array<Record<string, unknown>>
      | undefined;
    if (analyticsConfigs && Array.isArray(analyticsConfigs) && analyticsConfigs.length > 0) {
      recordItemOutcome(
        'AnalyticsConfigurations',
        analyticsConfigs,
        await this.applyAnalyticsConfigurations(bucketName, analyticsConfigs, replayOnUnusable)
      );
    }

    // Intelligent Tiering Configurations
    const itConfigs = properties['IntelligentTieringConfigurations'] as
      | Array<Record<string, unknown>>
      | undefined;
    if (itConfigs && Array.isArray(itConfigs) && itConfigs.length > 0) {
      recordItemOutcome(
        'IntelligentTieringConfigurations',
        itConfigs,
        await this.applyIntelligentTieringConfigurations(bucketName, itConfigs, replayOnUnusable)
      );
    }

    // Inventory Configurations
    const inventoryConfigs = properties['InventoryConfigurations'] as
      | Array<Record<string, unknown>>
      | undefined;
    if (inventoryConfigs && Array.isArray(inventoryConfigs) && inventoryConfigs.length > 0) {
      recordItemOutcome(
        'InventoryConfigurations',
        inventoryConfigs,
        await this.applyInventoryConfigurations(bucketName, inventoryConfigs, replayOnUnusable)
      );
    }

    // Replication Configuration
    const replConfig = properties['ReplicationConfiguration'] as
      | Record<string, unknown>
      | undefined;
    if (replConfig) {
      const applied = await this.applyReplicationConfiguration(
        bucketName,
        replConfig,
        replayOnUnusable
      );
      if (!applied) overrides.set('ReplicationConfiguration', undefined);
    }

    // Object Lock Configuration (rule/retention, not the ObjectLockEnabled flag)
    const objectLockConfig = properties['ObjectLockConfiguration'] as
      | Record<string, unknown>
      | undefined;
    if (objectLockConfig) {
      await this.applyObjectLockConfiguration(bucketName, objectLockConfig);
    }
    return overrides;
  }

  /**
   * Create an S3 bucket
   */
  async create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    context?: CreateContext
  ): Promise<ResourceCreateResult> {
    this.logger.debug(`Creating S3 bucket ${logicalId}`);

    const bucketName =
      (properties['BucketName'] as string | undefined) ||
      generateResourceName(logicalId, {
        maxLength: 63,
        lowercase: true,
        allowedPattern: /[^a-z0-9.-]/g,
      });

    try {
      // CreateBucket params
      const createParams: {
        Bucket: string;
        CreateBucketConfiguration?: { LocationConstraint: BucketLocationConstraint };
        ObjectLockEnabledForBucket?: boolean;
      } = {
        Bucket: bucketName,
      };

      // Add LocationConstraint for non-us-east-1 regions
      const region = await this.getRegion();
      if (region !== 'us-east-1') {
        createParams.CreateBucketConfiguration = {
          LocationConstraint: region as BucketLocationConstraint,
        };
      }

      // ObjectLockEnabled must be set at bucket creation time
      if (properties['ObjectLockEnabled'] === true || properties['ObjectLockEnabled'] === 'true') {
        createParams.ObjectLockEnabledForBucket = true;
      }

      // Track whether THIS call actually created the bucket (vs hit the
      // idempotent `BucketAlreadyOwnedByYou` fallback). Only the truly-
      // created case is eligible for partial-failure cleanup — deleting a
      // pre-existing bucket would destroy a user resource that lived
      // before this deploy ran.
      let createdNewBucket = false;
      try {
        await this.s3Client.send(new CreateBucketCommand(createParams));
        createdNewBucket = true;
        this.logger.debug(`Created S3 bucket: ${bucketName}`);
      } catch (createError) {
        // "BucketAlreadyOwnedByYou" is success (idempotent create)
        if (
          createError instanceof Error &&
          (createError.name === 'BucketAlreadyOwnedByYou' ||
            createError.message.includes('you already own it'))
        ) {
          this.logger.debug(`S3 bucket ${bucketName} already exists and is owned by you`);
        } else {
          throw createError;
        }
      }

      // Apply additional configuration in an inner try so a wiring
      // failure can be self-healed by issuing a best-effort `DeleteBucket`
      // cleanup. Without this, a sub-config failure leaves an orphan
      // bucket that AWS will reject on the next redeploy. The cleanup
      // is gated on `createdNewBucket` so we never delete a pre-existing
      // bucket. See Issue #376 for the cross-provider sweep.
      let effectiveOverrides: Map<string, unknown>;
      try {
        effectiveOverrides = await this.applyConfiguration(bucketName, properties, {
          ...(context ? { context } : {}),
        });
        for (const [key, value] of await this.applyAllSubConfigsForCreate(
          bucketName,
          properties,
          context
        )) {
          effectiveOverrides.set(key, value);
        }
      } catch (innerError) {
        if (createdNewBucket) {
          try {
            await this.s3Client.send(new DeleteBucketCommand({ Bucket: bucketName }));
            this.logger.debug(
              `Cleaned up partially-created S3 bucket ${logicalId} (${bucketName}) after wiring failure`
            );
          } catch (cleanupError) {
            this.logger.warn(
              `Failed to clean up partially-created S3 bucket ${logicalId} (${bucketName}): ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}. Manual deletion may be required before the next deploy: aws s3api delete-bucket --bucket '${bucketName}'`
            );
          }
        }
        throw innerError;
      }

      const attributes = await this.buildAttributes(bucketName);

      this.logger.debug(`Successfully created S3 bucket ${logicalId}: ${bucketName}`);

      // Anything a replay downgrade SKIPPED is dropped from the recorded bag,
      // and anything it SUBSTITUTED is recorded as SENT, so state describes the
      // bucket AWS actually holds (issues #1612 / #1670).
      //
      // It is NO LONGER absent on an ordinary template-path create, and this
      // sentence said it was until issues #1707 / #1717 / #1718 — the same
      // stale-rationale class those changes fixed elsewhere in this file. The
      // per-item folds populate `substituted` whenever they change an item at
      // all: a defaulted `Enabled` / `IncludedObjectVersions` /
      // `OutputSchemaVersion`, or a destination declared in either tolerated
      // spelling. None of those needs a downgrade to be reachable.
      const effectiveProperties = S3BucketProvider.applyEffectiveOverrides(
        properties,
        effectiveOverrides
      );

      return {
        physicalId: bucketName,
        attributes,
        ...(effectiveProperties ? { effectiveProperties } : {}),
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to create S3 bucket ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        bucketName,
        cause
      );
    }
  }

  /**
   * Update an S3 bucket
   */
  async update(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>,
    context?: UpdateContext
  ): Promise<ResourceUpdateResult> {
    this.logger.debug(`Updating S3 bucket ${logicalId}: ${physicalId}`);

    const newBucketName = properties['BucketName'] as string | undefined;

    // Bucket name is immutable - if changed, requires replacement
    if (newBucketName && newBucketName !== physicalId) {
      this.logger.debug(
        `Bucket name changed (${physicalId} -> ${newBucketName}), replacement required`
      );
      return {
        physicalId,
        wasReplaced: true,
      };
    }

    try {
      // Apply configuration changes. Tags are skipped because
      // `applyConfiguration` only adds and never removes (handled by
      // `applyTagDiff` below), and the three diff-managed sub-configs
      // (Versioning / OwnershipControls / BucketEncryption) are skipped
      // because `applySubConfigDiffs` owns them on the UPDATE path so that
      // REMOVING one resets it like CloudFormation does (issue #1466).
      // What is left on the always-PUT path here is
      // `PublicAccessBlockConfiguration`, which is at CFn parity.
      // Empty in practice — `skipDiffManaged` withholds the only applier here
      // that can skip — but merged rather than discarded so a future skip or
      // substitution on the always-PUT path cannot go unrecorded (#1612 /
      // #1670).
      const effectiveOverrides = await this.applyConfiguration(physicalId, properties, {
        skipTags: true,
        skipDiffManaged: true,
      });

      // Apply diff-aware Put/Delete for the sub-configs that have proper
      // Put/Delete API pairs.
      for (const [key, value] of await this.applySubConfigDiffs(
        physicalId,
        properties,
        previousProperties,
        context
      )) {
        effectiveOverrides.set(key, value);
      }

      // Apply tag diff. S3 uses PutBucketTagging (full-replace) and
      // DeleteBucketTagging when the new tag set is empty.
      await this.applyTagDiff(
        physicalId,
        previousProperties['Tags'] as Array<{ Key?: string; Value?: string }> | undefined,
        properties['Tags'] as Array<{ Key?: string; Value?: string }> | undefined
      );

      const attributes = await this.buildAttributes(physicalId);

      this.logger.debug(`Successfully updated S3 bucket ${logicalId}`);

      // Any Put a warn-and-skip arm declined leaves the PREVIOUSLY applied
      // configuration live, so state records that rather than the desired
      // value AWS never received (issue #1612); a Put a warn-and-substitute
      // read altered records the value AWS DID receive (issue #1670).
      //
      // "Absent when neither happened, which is every ordinary update" was true
      // until issues #1707 / #1717 / #1718 and is not any more: an ordinary
      // re-Put now yields a folded item with no skip and no substitution
      // anywhere, whenever the template omits a defaulted-but-SENT member or
      // spells the destination in a tolerated shape.
      const effectiveProperties = S3BucketProvider.applyEffectiveOverrides(
        properties,
        effectiveOverrides
      );

      return {
        physicalId,
        wasReplaced: false,
        attributes,
        ...(effectiveProperties ? { effectiveProperties } : {}),
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to update S3 bucket ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  /**
   * Delete an S3 bucket
   *
   * Note: The bucket must be empty before deletion.
   */
  async delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void> {
    this.logger.debug(`Deleting S3 bucket ${logicalId}: ${physicalId}`);

    // CloudFormation-parity data guard (issue #1340): a non-empty bucket is
    // only auto-emptied when the user opted in — CDK's `autoDeleteObjects`
    // tag on the bucket, or the deploy engine's `--force-stateful-recreation`
    // consent on a replacement delete. Otherwise the not-empty error
    // surfaces exactly like CloudFormation's DELETE_FAILED.
    const allowAutoEmpty =
      context?.forceDataDelete === true ||
      hasCdkAutoDeleteTag(properties, S3_AUTO_DELETE_OBJECTS_TAG);

    try {
      await this.deleteBucketWithEmptyRetry(logicalId, physicalId, allowAutoEmpty);
    } catch (error) {
      if (error instanceof NoSuchBucket) {
        const clientRegion = await this.s3Client.config.region();
        assertRegionMatch(
          clientRegion,
          context?.expectedRegion,
          resourceType,
          logicalId,
          physicalId
        );
        this.logger.debug(`Bucket ${physicalId} does not exist, skipping deletion`);
        return;
      }
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to delete S3 bucket ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  /**
   * The `effectiveProperties` TWIN required by `.claude/rules/providers.md`
   * ("`effectiveProperties` alone BREAKS the next deploy") for the per-item
   * folds the inventory and analytics appliers record — issue #1717 for the
   * inventory `Schedule` -> `ScheduleFrequency` half (#1686), issue #1707 for
   * the destination-shape half, issue #1718 for the defaulted-but-SENT members.
   *
   * Applied by `DiffCalculator` to BOTH comparison sides through
   * `makeCanonicalizePropertiesFn`, so the record's folded spelling and the
   * template's declared one compare EQUAL and an unchanged template stops
   * redeploying as `1 to update` forever. Folding both sides is also what heals
   * the already-deployed population: an item whose value never changes is never
   * re-Put, so the recording side alone can never reach a record written before
   * the fold.
   *
   * The rule's OTHER requirement — share ONE helper with the provisioning path
   * rather than re-deriving the rule — is met by
   * {@link effectiveInventoryItem} / {@link effectiveAnalyticsItem}, which the
   * appliers call with the values they actually sent and this calls with none.
   *
   * Note the twin question is re-asked per site rather than inherited: the #1670
   * sites next door answered NO because canonicalizing there would CONCEAL a
   * malformed value whose warning tells the user what to fix. These folds have
   * no fault to conceal — an item declaring only the SDK spelling is perfectly
   * valid input that emits no warning at all — so the twin's absence bought
   * nothing and cost a permanent `cdkd diff` line plus a redundant per-`Id` Put
   * on every deploy.
   *
   * Identity-returns an untouched bag, so every other `AWS::S3::Bucket` template
   * and every other resource type is byte-for-byte unaffected.
   *
   * THE #1717 OBSTACLE DID NOT REPRODUCE, and that is worth stating rather than
   * quietly omitting: the issue measured a `canonicalizeDesiredProperties`
   * folding this key making `gen-nested-key-coverage` report the still-correct
   * plural->singular `segmentRenames` entry for `InventoryConfigurations` STALE,
   * and warned that each piece is inert alone so only the combination trips it.
   * With the fold implemented as a MODULE-level pure function over an item
   * parameter, the shipped critic is green end to end — `vp run
   * audit:nested-key-coverage:check` reports 0 divergences in all three passes,
   * the committed matrix does not drift by a byte, and
   * `InventoryConfigurations` is still listed in the target's
   * `usedSegmentRenames`, i.e. the entry is doing work and the fence is not
   * masking anything. So no `segmentRenames` entry was removed and no staleness
   * check was widened; the issue's "resolve the interaction WITHOUT deleting the
   * entry" requirement is met by there being no interaction to resolve. What is
   * NOT claimed is a mechanism for why the issue's attempt tripped it — that
   * attempt is not in the tree to bisect against.
   */
  canonicalizeDesiredProperties(
    resourceType: string,
    properties: Record<string, unknown>
  ): Record<string, unknown> {
    if (resourceType !== 'AWS::S3::Bucket') return properties;
    let out = canonicalizeItemList(properties, 'InventoryConfigurations', (item) =>
      effectiveInventoryItem(item)
    );
    out = canonicalizeItemList(out, 'AnalyticsConfigurations', (item) =>
      effectiveAnalyticsItem(item)
    );
    out = canonicalizeItemList(
      out,
      'IntelligentTieringConfigurations',
      effectiveIntelligentTieringItem
    );
    // The #1748 folds. Same shared-helper rule as the three above — the recording
    // side calls the very same function — and the twin is what keeps the fold
    // from BREAKING the next deploy: without it state holds the emitted spelling
    // while the template still declares the tolerated one, so an unchanged
    // template redeploys as `1 to update` forever (issue #1717 measured exactly
    // that on the sibling fold). Folding both sides is also what HEALS the
    // already-deployed population: a bucket whose notification / lifecycle
    // configuration never changes is never re-Put, so the recording side alone
    // could never reach a record written before the fold.
    out = canonicalizeBlock(out, 'NotificationConfiguration', effectiveNotificationConfiguration);
    out = canonicalizeBlock(out, 'LifecycleConfiguration', effectiveLifecycleConfiguration);
    return out;
  }

  /**
   * Read the AWS-current S3 bucket configuration in CFn-property shape.
   *
   * Issues a small handful of independent S3 GET calls and stitches them
   * into a single CFn-shaped object. Each call can throw a "feature not
   * configured" error (`NoSuchBucketConfiguration`,
   * `ServerSideEncryptionConfigurationNotFoundError`, `NoSuchTagSet`,
   * `NoSuchPublicAccessBlockConfiguration`, etc.) — those are caught
   * individually and the corresponding key is emitted as a CFn-shape
   * placeholder (per docs/provider-development.md § 3b: always-emit
   * user-controllable top-level keys), NOT treated as the bucket being
   * absent.
   *
   * Only the bucket-gone case (`NoSuchBucket`, HTTP 404 from `HeadBucket`)
   * returns `undefined`.
   *
   * Coverage: `BucketName`, `VersioningConfiguration`, `BucketEncryption`,
   * `OwnershipControls`, `PublicAccessBlockConfiguration`, `Tags`, plus all 12
   * sub-configs:
   * `LifecycleConfiguration`, `CorsConfiguration`, `WebsiteConfiguration`,
   * `LoggingConfiguration`, `NotificationConfiguration`,
   * `ReplicationConfiguration`, `ObjectLockConfiguration`,
   * `AccelerateConfiguration`, `MetricsConfigurations`,
   * `AnalyticsConfigurations`, `IntelligentTieringConfigurations`,
   * `InventoryConfigurations`.
   */
  async readCurrentState(
    physicalId: string,
    _logicalId: string,
    _resourceType: string
  ): Promise<Record<string, unknown> | undefined> {
    // Fast existence check. Treat NotFound / NoSuchBucket as "drift unknown".
    try {
      await this.s3Client.send(new HeadBucketCommand({ Bucket: physicalId }));
    } catch (err) {
      const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
      if (
        err instanceof NoSuchBucket ||
        e.name === 'NotFound' ||
        e.name === 'NoSuchBucket' ||
        e.$metadata?.httpStatusCode === 404
      ) {
        return undefined;
      }
      throw err;
    }

    // Fire all 16 GET / List calls in parallel. Each helper handles its own
    // "feature not configured" → placeholder fallback.
    const [
      versioning,
      encryption,
      ownership,
      pab,
      tags,
      lifecycle,
      cors,
      website,
      logging,
      notification,
      replication,
      objectLock,
      accelerate,
      metrics,
      analytics,
      intelligentTier,
      inventory,
    ] = await Promise.all([
      this.readVersioning(physicalId),
      this.readEncryption(physicalId),
      this.readOwnershipControls(physicalId),
      this.readPublicAccessBlock(physicalId),
      this.readTags(physicalId),
      this.readLifecycle(physicalId),
      this.readCors(physicalId),
      this.readWebsite(physicalId),
      this.readLogging(physicalId),
      this.readNotification(physicalId),
      this.readReplication(physicalId),
      this.readObjectLock(physicalId),
      this.readAccelerate(physicalId),
      this.readMetricsList(physicalId),
      this.readAnalyticsList(physicalId),
      this.readIntelligentTieringList(physicalId),
      this.readInventoryList(physicalId),
    ]);

    return {
      BucketName: physicalId,
      VersioningConfiguration: versioning,
      BucketEncryption: encryption,
      OwnershipControls: ownership,
      PublicAccessBlockConfiguration: pab,
      Tags: tags,
      LifecycleConfiguration: lifecycle,
      CorsConfiguration: cors,
      WebsiteConfiguration: website,
      LoggingConfiguration: logging,
      NotificationConfiguration: notification,
      ReplicationConfiguration: replication,
      ObjectLockConfiguration: objectLock,
      AccelerateConfiguration: accelerate,
      MetricsConfigurations: metrics,
      AnalyticsConfigurations: analytics,
      IntelligentTieringConfigurations: intelligentTier,
      InventoryConfigurations: inventory,
    };
  }

  // -------------------------------------------------------------------
  // readCurrentState helpers — one per sub-config. Each catches the
  // "feature not configured" error and returns the always-emit
  // placeholder shape per docs/provider-development.md § 3b.
  // -------------------------------------------------------------------

  private async readVersioning(bucket: string): Promise<Record<string, unknown>> {
    // VersioningConfiguration { Status }. Always emit a placeholder so a
    // console-side enable on a never-versioned bucket surfaces as drift.
    // 'Suspended' is the semantic "off" value in CFn.
    const resp = await this.s3Client.send(new GetBucketVersioningCommand({ Bucket: bucket }));
    return { Status: resp.Status ?? 'Suspended' };
  }

  /**
   * OwnershipControls { Rules: [{ ObjectOwnership }] }. Always emit a
   * placeholder (empty `Rules`) so a console-side change on a bucket that
   * declares the property surfaces as drift. Added with issue #1466 — without
   * a read here, `cdkd drift` could not see ownership controls at all, which
   * is why the removal bug that issue fixes produced no signal from ANY
   * command.
   */
  private async readOwnershipControls(bucket: string): Promise<Record<string, unknown>> {
    try {
      const resp = await this.s3Client.send(
        new GetBucketOwnershipControlsCommand({ Bucket: bucket })
      );
      return {
        Rules: (resp.OwnershipControls?.Rules ?? []).map((r) => ({
          ObjectOwnership: r.ObjectOwnership,
        })),
      };
    } catch (err) {
      const e = err as { name?: string };
      if (e.name === 'OwnershipControlsNotFoundError') {
        return { Rules: [] };
      }
      throw err;
    }
  }

  private async readEncryption(bucket: string): Promise<Record<string, unknown>> {
    try {
      const resp = await this.s3Client.send(new GetBucketEncryptionCommand({ Bucket: bucket }));
      const rules = resp.ServerSideEncryptionConfiguration?.Rules ?? [];
      return {
        ServerSideEncryptionConfiguration: rules.map((rule) => {
          const out: Record<string, unknown> = {};
          const sse = rule.ApplyServerSideEncryptionByDefault;
          if (sse) {
            const sseOut: Record<string, unknown> = {};
            if (sse.SSEAlgorithm !== undefined) sseOut['SSEAlgorithm'] = sse.SSEAlgorithm;
            if (sse.KMSMasterKeyID !== undefined) sseOut['KMSMasterKeyID'] = sse.KMSMasterKeyID;
            out['ServerSideEncryptionByDefault'] = sseOut;
          }
          if (rule.BucketKeyEnabled !== undefined) out['BucketKeyEnabled'] = rule.BucketKeyEnabled;
          // Issue #1495: read back the block the write side now sends.
          if (rule.BlockedEncryptionTypes?.EncryptionType !== undefined) {
            out['BlockedEncryptionTypes'] = {
              EncryptionType: rule.BlockedEncryptionTypes.EncryptionType,
            };
          }
          return out;
        }),
      };
    } catch (err) {
      const e = err as { name?: string };
      if (e.name === 'ServerSideEncryptionConfigurationNotFoundError') {
        return { ServerSideEncryptionConfiguration: [] };
      }
      throw err;
    }
  }

  private async readPublicAccessBlock(bucket: string): Promise<Record<string, unknown>> {
    try {
      const resp = await this.s3Client.send(new GetPublicAccessBlockCommand({ Bucket: bucket }));
      const cfg = resp.PublicAccessBlockConfiguration;
      return {
        BlockPublicAcls: cfg?.BlockPublicAcls ?? false,
        BlockPublicPolicy: cfg?.BlockPublicPolicy ?? false,
        IgnorePublicAcls: cfg?.IgnorePublicAcls ?? false,
        RestrictPublicBuckets: cfg?.RestrictPublicBuckets ?? false,
      };
    } catch (err) {
      const e = err as { name?: string };
      if (e.name === 'NoSuchPublicAccessBlockConfiguration') {
        return {
          BlockPublicAcls: false,
          BlockPublicPolicy: false,
          IgnorePublicAcls: false,
          RestrictPublicBuckets: false,
        };
      }
      throw err;
    }
  }

  private async readTags(bucket: string): Promise<Array<{ Key: string; Value: string }>> {
    try {
      const resp = await this.s3Client.send(new GetBucketTaggingCommand({ Bucket: bucket }));
      return normalizeAwsTagsToCfn(resp.TagSet);
    } catch (err) {
      const e = err as { name?: string };
      if (e.name === 'NoSuchTagSet') return [];
      throw err;
    }
  }

  private async readLifecycle(bucket: string): Promise<Record<string, unknown>> {
    try {
      const resp = await this.s3Client.send(
        new GetBucketLifecycleConfigurationCommand({ Bucket: bucket })
      );
      const rules = resp.Rules ?? [];
      const lifecycleOut: Record<string, unknown> = {};
      // Issue #1495: emit whatever AWS returns, unconditionally.
      //
      // The first cut filtered out `varies_by_storage_class` as "the account
      // default". That polarity is WRONG — AWS defaults new buckets (created
      // after September 2024) to `all_storage_classes_128K`, so the filter
      // suppressed the one value a template meaningfully declares and emitted
      // the real default for every bucket. A template declaring
      // `varies_by_storage_class` would then never read back, i.e. permanent
      // phantom drift on the `properties`-fallback baseline — exactly the
      // asymmetry this issue set out to remove.
      //
      // Emitting it even when the template never declared it is deliberate and
      // NOT free: `drift.ts` passes `unionWalkObjects` on the observed-baseline
      // path, so a new sub-key under the state-present `LifecycleConfiguration`
      // IS compared. The effect is the same one-time stale-observed-baseline
      // drift the `EventBridgeConfiguration` block below already documents, and
      // it clears on the next deploy — strictly better than the alternative,
      // where a template that DOES declare the value never reads it back and
      // drifts forever.
      if (resp.TransitionDefaultMinimumObjectSize !== undefined) {
        lifecycleOut['TransitionDefaultMinimumObjectSize'] =
          resp.TransitionDefaultMinimumObjectSize;
      }
      return {
        ...lifecycleOut,
        Rules: rules.map((r) => {
          const out: Record<string, unknown> = {};
          if (r.ID !== undefined) out['Id'] = r.ID;
          if (r.Status !== undefined) out['Status'] = r.Status;
          if (r.Prefix !== undefined) out['Prefix'] = r.Prefix;

          // Expiration
          if (r.Expiration) {
            const exp: Record<string, unknown> = {};
            if (r.Expiration.Days !== undefined) exp['Days'] = r.Expiration.Days;
            if (r.Expiration.Date !== undefined) exp['Date'] = r.Expiration.Date.toISOString();
            if (r.Expiration.ExpiredObjectDeleteMarker !== undefined)
              exp['ExpiredObjectDeleteMarker'] = r.Expiration.ExpiredObjectDeleteMarker;
            out['Expiration'] = exp;
          }

          // Transitions
          if (r.Transitions && r.Transitions.length > 0) {
            out['Transitions'] = r.Transitions.map((t) => {
              const item: Record<string, unknown> = {};
              if (t.Days !== undefined) item['TransitionInDays'] = t.Days;
              if (t.Date !== undefined) item['TransitionDate'] = t.Date.toISOString();
              if (t.StorageClass !== undefined) item['StorageClass'] = t.StorageClass;
              return item;
            });
          }

          // NoncurrentVersionExpiration
          if (r.NoncurrentVersionExpiration) {
            const nve: Record<string, unknown> = {};
            if (r.NoncurrentVersionExpiration.NoncurrentDays !== undefined)
              nve['NoncurrentDays'] = r.NoncurrentVersionExpiration.NoncurrentDays;
            if (r.NoncurrentVersionExpiration.NewerNoncurrentVersions !== undefined)
              nve['NewerNoncurrentVersions'] =
                r.NoncurrentVersionExpiration.NewerNoncurrentVersions;
            out['NoncurrentVersionExpiration'] = nve;
          }

          // NoncurrentVersionTransitions
          if (r.NoncurrentVersionTransitions && r.NoncurrentVersionTransitions.length > 0) {
            out['NoncurrentVersionTransitions'] = r.NoncurrentVersionTransitions.map((nvt) => {
              const item: Record<string, unknown> = {};
              // Reverse-map to the CFn spelling `TransitionInDays`, matching
              // the `Transitions` sibling 20 lines above. Emitting the SDK's
              // `NoncurrentDays` here made `cdkd drift` report a permanent
              // phantom diff on every versioned bucket with a noncurrent
              // transition, because the template baseline carries
              // `TransitionInDays` and `Rules` is compared array-wholesale.
              // Latent until this PR: the write side never delivered the day
              // count, so the two sides were both empty and agreed by accident.
              if (nvt.NoncurrentDays !== undefined) item['TransitionInDays'] = nvt.NoncurrentDays;
              if (nvt.StorageClass !== undefined) item['StorageClass'] = nvt.StorageClass;
              if (nvt.NewerNoncurrentVersions !== undefined)
                item['NewerNoncurrentVersions'] = nvt.NewerNoncurrentVersions;
              return item;
            });
          }

          // AbortIncompleteMultipartUpload
          if (r.AbortIncompleteMultipartUpload) {
            out['AbortIncompleteMultipartUpload'] = {
              DaysAfterInitiation: r.AbortIncompleteMultipartUpload.DaysAfterInitiation,
            };
          }

          // Filter — reverse-map SDK Filter shape (Tag / Prefix / And / etc)
          // back to CFn TagFilters / Prefix / ObjectSize* form.
          if (r.Filter) {
            const f = r.Filter as Record<string, unknown>;
            const cfnFilter: Record<string, unknown> = {};
            const and = f['And'] as Record<string, unknown> | undefined;
            const tagOnly = f['Tag'] as { Key?: string; Value?: string } | undefined;
            if (and) {
              if (and['Prefix'] !== undefined) cfnFilter['Prefix'] = and['Prefix'];
              if (and['Tags']) cfnFilter['TagFilters'] = and['Tags'];
              if (and['ObjectSizeGreaterThan'] !== undefined)
                cfnFilter['ObjectSizeGreaterThan'] = and['ObjectSizeGreaterThan'];
              if (and['ObjectSizeLessThan'] !== undefined)
                cfnFilter['ObjectSizeLessThan'] = and['ObjectSizeLessThan'];
            } else if (tagOnly) {
              cfnFilter['TagFilters'] = [tagOnly];
            } else {
              if (f['Prefix'] !== undefined) cfnFilter['Prefix'] = f['Prefix'];
              if (f['ObjectSizeGreaterThan'] !== undefined)
                cfnFilter['ObjectSizeGreaterThan'] = f['ObjectSizeGreaterThan'];
              if (f['ObjectSizeLessThan'] !== undefined)
                cfnFilter['ObjectSizeLessThan'] = f['ObjectSizeLessThan'];
            }
            if (Object.keys(cfnFilter).length > 0) out['Filter'] = cfnFilter;
          }

          return out;
        }),
      };
    } catch (err) {
      const e = err as { name?: string };
      if (e.name === 'NoSuchLifecycleConfiguration') return { Rules: [] };
      throw err;
    }
  }

  private async readCors(bucket: string): Promise<Record<string, unknown>> {
    try {
      const resp = await this.s3Client.send(new GetBucketCorsCommand({ Bucket: bucket }));
      const rules = resp.CORSRules ?? [];
      return {
        CorsRules: rules.map((r) => {
          const out: Record<string, unknown> = {};
          if (r.ID !== undefined) out['Id'] = r.ID;
          if (r.AllowedHeaders !== undefined) out['AllowedHeaders'] = r.AllowedHeaders;
          if (r.AllowedMethods !== undefined) out['AllowedMethods'] = r.AllowedMethods;
          if (r.AllowedOrigins !== undefined) out['AllowedOrigins'] = r.AllowedOrigins;
          if (r.ExposeHeaders !== undefined) out['ExposedHeaders'] = r.ExposeHeaders;
          if (r.MaxAgeSeconds !== undefined) out['MaxAge'] = r.MaxAgeSeconds;
          return out;
        }),
      };
    } catch (err) {
      const e = err as { name?: string };
      if (e.name === 'NoSuchCORSConfiguration') return { CorsRules: [] };
      throw err;
    }
  }

  private async readWebsite(bucket: string): Promise<Record<string, unknown>> {
    try {
      const resp = await this.s3Client.send(new GetBucketWebsiteCommand({ Bucket: bucket }));
      const out: Record<string, unknown> = {};
      if (resp.IndexDocument?.Suffix !== undefined) {
        out['IndexDocument'] = resp.IndexDocument.Suffix;
      }
      if (resp.ErrorDocument?.Key !== undefined) {
        out['ErrorDocument'] = resp.ErrorDocument.Key;
      }
      if (resp.RedirectAllRequestsTo) {
        const redirect: Record<string, unknown> = {};
        if (resp.RedirectAllRequestsTo.HostName !== undefined)
          redirect['HostName'] = resp.RedirectAllRequestsTo.HostName;
        if (resp.RedirectAllRequestsTo.Protocol !== undefined)
          redirect['Protocol'] = resp.RedirectAllRequestsTo.Protocol;
        out['RedirectAllRequestsTo'] = redirect;
      }
      if (resp.RoutingRules && resp.RoutingRules.length > 0) {
        out['RoutingRules'] = resp.RoutingRules.map((rr) => {
          const ruleOut: Record<string, unknown> = {};
          if (rr.Condition) {
            const c: Record<string, unknown> = {};
            if (rr.Condition.HttpErrorCodeReturnedEquals !== undefined)
              c['HttpErrorCodeReturnedEquals'] = rr.Condition.HttpErrorCodeReturnedEquals;
            if (rr.Condition.KeyPrefixEquals !== undefined)
              c['KeyPrefixEquals'] = rr.Condition.KeyPrefixEquals;
            ruleOut['RoutingRuleCondition'] = c;
          }
          if (rr.Redirect) {
            const r: Record<string, unknown> = {};
            if (rr.Redirect.HostName !== undefined) r['HostName'] = rr.Redirect.HostName;
            if (rr.Redirect.HttpRedirectCode !== undefined)
              r['HttpRedirectCode'] = rr.Redirect.HttpRedirectCode;
            if (rr.Redirect.Protocol !== undefined) r['Protocol'] = rr.Redirect.Protocol;
            if (rr.Redirect.ReplaceKeyPrefixWith !== undefined)
              r['ReplaceKeyPrefixWith'] = rr.Redirect.ReplaceKeyPrefixWith;
            if (rr.Redirect.ReplaceKeyWith !== undefined)
              r['ReplaceKeyWith'] = rr.Redirect.ReplaceKeyWith;
            ruleOut['RedirectRule'] = r;
          }
          return ruleOut;
        });
      }
      return out;
    } catch (err) {
      const e = err as { name?: string };
      if (e.name === 'NoSuchWebsiteConfiguration') return {};
      throw err;
    }
  }

  private async readLogging(bucket: string): Promise<Record<string, unknown>> {
    const resp = await this.s3Client.send(new GetBucketLoggingCommand({ Bucket: bucket }));
    if (!resp.LoggingEnabled) return {};
    const out: Record<string, unknown> = {};
    if (resp.LoggingEnabled.TargetBucket !== undefined)
      out['DestinationBucketName'] = resp.LoggingEnabled.TargetBucket;
    if (resp.LoggingEnabled.TargetPrefix !== undefined)
      out['LogFilePrefix'] = resp.LoggingEnabled.TargetPrefix;
    // Issue #1495: read back the key format the write side now sends, or a
    // bucket that declares it would report permanent phantom drift.
    const keyFormat = resp.LoggingEnabled.TargetObjectKeyFormat;
    if (keyFormat) {
      const cfnKeyFormat: Record<string, unknown> = {};
      if (keyFormat.SimplePrefix !== undefined) cfnKeyFormat['SimplePrefix'] = {};
      if (keyFormat.PartitionedPrefix) {
        const partitioned: Record<string, unknown> = {};
        if (keyFormat.PartitionedPrefix.PartitionDateSource !== undefined) {
          partitioned['PartitionDateSource'] = keyFormat.PartitionedPrefix.PartitionDateSource;
        }
        cfnKeyFormat['PartitionedPrefix'] = partitioned;
      }
      if (Object.keys(cfnKeyFormat).length > 0) out['TargetObjectKeyFormat'] = cfnKeyFormat;
    }
    return out;
  }

  /**
   * Emit a notification item's event list in the CFn spelling (issue #1748).
   *
   * The SDK member is the LIST `Events`; CFn declares only the scalar `Event`
   * (`TopicConfiguration` is `{Event, Filter, Topic}`), which is what every
   * template — and therefore every state record written from one — carries. So
   * emitting `Events` unconditionally made the record and the readback disagree
   * on EVERY notification-configured bucket: `cdkd drift` re-reported it forever
   * and `--revert` re-issued the same Put, with nothing malformed to warn about.
   *
   * Reverse-mapping to the CFn spelling is the same answer the `Transitions`
   * sibling in `readLifecycle` already takes for `TransitionInDays`. The arity
   * rule is what keeps it lossless: a longer list has no CFn spelling, so it
   * stays `Events` — which is also what {@link foldNotificationEvents} leaves on
   * the desired side, so the two still meet.
   */
  private emitNotificationEvents(target: Record<string, unknown>, events?: string[]): void {
    if (events === undefined) return;
    if (events.length === 1) target['Event'] = events[0];
    else target['Events'] = events;
  }

  private async readNotification(bucket: string): Promise<Record<string, unknown>> {
    const resp = await this.s3Client.send(
      new GetBucketNotificationConfigurationCommand({ Bucket: bucket })
    );
    const out: Record<string, unknown> = {};
    if (resp.TopicConfigurations && resp.TopicConfigurations.length > 0) {
      out['TopicConfigurations'] = resp.TopicConfigurations.map((t) => {
        const e: Record<string, unknown> = {};
        if (t.Id !== undefined) e['Id'] = t.Id;
        if (t.TopicArn !== undefined) e['Topic'] = t.TopicArn;
        this.emitNotificationEvents(e, t.Events);
        if (t.Filter) e['Filter'] = this.sdkNotifFilterToCfn(t.Filter);
        return e;
      });
    }
    if (resp.QueueConfigurations && resp.QueueConfigurations.length > 0) {
      out['QueueConfigurations'] = resp.QueueConfigurations.map((q) => {
        const e: Record<string, unknown> = {};
        if (q.Id !== undefined) e['Id'] = q.Id;
        if (q.QueueArn !== undefined) e['Queue'] = q.QueueArn;
        this.emitNotificationEvents(e, q.Events);
        if (q.Filter) e['Filter'] = this.sdkNotifFilterToCfn(q.Filter);
        return e;
      });
    }
    if (resp.LambdaFunctionConfigurations && resp.LambdaFunctionConfigurations.length > 0) {
      out['LambdaConfigurations'] = resp.LambdaFunctionConfigurations.map((l) => {
        const e: Record<string, unknown> = {};
        if (l.Id !== undefined) e['Id'] = l.Id;
        if (l.LambdaFunctionArn !== undefined) e['Function'] = l.LambdaFunctionArn;
        this.emitNotificationEvents(e, l.Events);
        if (l.Filter) e['Filter'] = this.sdkNotifFilterToCfn(l.Filter);
        return e;
      });
    }
    // Always-emit, and in the CFn shape (`{EventBridgeEnabled: <bool>}`) rather
    // than the SDK's empty-structure shape — cdkd's state baseline holds the
    // CFn spelling, so returning `{}` reported the boolean as permanently
    // missing on every EventBridge-enabled bucket (issue #1430). Emitting
    // `false` when the response omits the block keeps the disabled side
    // comparable too.
    //
    // ONE-TIME DRIFT ON UPGRADE, accepted deliberately. `cdkd drift` runs the
    // observed-properties path with `unionWalkObjects: true`, which walks the
    // union of baseline+AWS keys inside a nested object, so a state record
    // captured by an older binary reports one diff on the first run after
    // upgrading: `EventBridgeConfiguration: {}` vs `{EventBridgeEnabled: true}`
    // on an enabled bucket, or an added `EventBridgeConfiguration` on a bucket
    // with no such key at all. It is cosmetic — `--revert` re-sends the old
    // observed blob and the write side re-derives the same AWS state — and it
    // clears on the next `cdkd state refresh-observed`, `drift --accept`, or
    // ANY subsequent `cdkd deploy` (the engine persists refreshed
    // `observedProperties` even on the no-change path). The alternative (emit only when present) is
    // what caused the PERMANENT phantom drift this fixes.
    out['EventBridgeConfiguration'] = {
      EventBridgeEnabled: resp.EventBridgeConfiguration !== undefined,
    };
    return out;
  }

  private sdkNotifFilterToCfn(filter: unknown): Record<string, unknown> {
    if (!filter || typeof filter !== 'object') return {};
    const f = filter as Record<string, unknown>;
    const key = f['Key'] as Record<string, unknown> | undefined;
    if (!key) return {};
    const filterRules = key['FilterRules'] as Array<{ Name?: string; Value?: string }> | undefined;
    if (!filterRules) return {};
    return {
      S3Key: {
        Rules: filterRules.map((r) => ({ Name: r.Name, Value: r.Value })),
      },
    };
  }

  private async readReplication(bucket: string): Promise<Record<string, unknown>> {
    try {
      const resp = await this.s3Client.send(new GetBucketReplicationCommand({ Bucket: bucket }));
      const cfg = resp.ReplicationConfiguration;
      if (!cfg) return {};
      const out: Record<string, unknown> = {};
      if (cfg.Role !== undefined) out['Role'] = cfg.Role;
      if (cfg.Rules) {
        out['Rules'] = cfg.Rules.map((r) => {
          const ruleOut: Record<string, unknown> = {};
          if (r.ID !== undefined) ruleOut['Id'] = r.ID;
          if (r.Status !== undefined) ruleOut['Status'] = r.Status;
          if (r.Priority !== undefined) ruleOut['Priority'] = r.Priority;
          if (r.Prefix !== undefined) ruleOut['Prefix'] = r.Prefix;
          if (r.Destination) {
            const d: Record<string, unknown> = {};
            if (r.Destination.Bucket !== undefined) d['Bucket'] = r.Destination.Bucket;
            if (r.Destination.Account !== undefined) d['Account'] = r.Destination.Account;
            if (r.Destination.StorageClass !== undefined)
              d['StorageClass'] = r.Destination.StorageClass;
            // Issue #1495: the four blocks the write side now sends. Without
            // the read-back a bucket declaring any of them reports permanent
            // phantom drift that `--revert` would then keep re-applying.
            // Every member below is emitted ONLY when AWS actually returned it.
            // `drift-calculator.ts` compares arrays wholesale, and state.json's
            // JSON round-trip drops undefined keys — so echoing a member AWS
            // omitted would turn the whole `Rules` array into permanent drift.
            const acl = r.Destination.AccessControlTranslation;
            if (acl?.Owner !== undefined) {
              d['AccessControlTranslation'] = { Owner: acl.Owner };
            }
            const enc = r.Destination.EncryptionConfiguration;
            if (enc?.ReplicaKmsKeyID !== undefined) {
              d['EncryptionConfiguration'] = { ReplicaKmsKeyID: enc.ReplicaKmsKeyID };
            }
            const rtIn = r.Destination.ReplicationTime;
            if (rtIn) {
              const rt: Record<string, unknown> = {};
              if (rtIn.Status !== undefined) rt['Status'] = rtIn.Status;
              if (rtIn.Time?.Minutes !== undefined) rt['Time'] = { Minutes: rtIn.Time.Minutes };
              if (Object.keys(rt).length > 0) d['ReplicationTime'] = rt;
            }
            const metricsIn = r.Destination.Metrics;
            if (metricsIn) {
              const m: Record<string, unknown> = {};
              if (metricsIn.Status !== undefined) m['Status'] = metricsIn.Status;
              if (metricsIn.EventThreshold?.Minutes !== undefined) {
                m['EventThreshold'] = { Minutes: metricsIn.EventThreshold.Minutes };
              }
              if (Object.keys(m).length > 0) d['Metrics'] = m;
            }
            ruleOut['Destination'] = d;
          }
          if (r.SourceSelectionCriteria) {
            const criteria: Record<string, unknown> = {};
            const replicaMods = r.SourceSelectionCriteria.ReplicaModifications;
            if (replicaMods?.Status !== undefined) {
              criteria['ReplicaModifications'] = { Status: replicaMods.Status };
            }
            const sseKms = r.SourceSelectionCriteria.SseKmsEncryptedObjects;
            if (sseKms?.Status !== undefined) {
              criteria['SseKmsEncryptedObjects'] = { Status: sseKms.Status };
            }
            if (Object.keys(criteria).length > 0) ruleOut['SourceSelectionCriteria'] = criteria;
          }
          if (r.Filter) {
            const f = r.Filter as Record<string, unknown>;
            const cfnFilter: Record<string, unknown> = {};
            const and = f['And'] as Record<string, unknown> | undefined;
            const tagOnly = f['Tag'] as { Key?: string; Value?: string } | undefined;
            if (and) {
              // Round-trip back to the CFn-canonical combined-filter shape
              // `{ And: { Prefix?, TagFilters[] } }` (S3 SDK's `And.Tags` ->
              // CFn `And.TagFilters`) so it matches the template-derived
              // state.properties exactly and does not surface as phantom drift.
              // (The old code collapsed it to a top-level `{ Prefix, TagFilter }`
              // — not a valid CFn shape — and dropped every tag past the first.)
              const innerAnd: Record<string, unknown> = {};
              if (and['Prefix'] !== undefined) innerAnd['Prefix'] = and['Prefix'];
              const tags = and['Tags'] as Array<{ Key?: string; Value?: string }> | undefined;
              if (tags && tags.length > 0) innerAnd['TagFilters'] = tags;
              cfnFilter['And'] = innerAnd;
            } else if (tagOnly) {
              cfnFilter['TagFilter'] = tagOnly;
            } else if (f['Prefix'] !== undefined) {
              cfnFilter['Prefix'] = f['Prefix'];
            }
            if (Object.keys(cfnFilter).length > 0) ruleOut['Filter'] = cfnFilter;
          }
          if (r.DeleteMarkerReplication?.Status !== undefined) {
            ruleOut['DeleteMarkerReplication'] = {
              Status: r.DeleteMarkerReplication.Status,
            };
          }
          return ruleOut;
        });
      }
      return out;
    } catch (err) {
      const e = err as { name?: string };
      if (e.name === 'ReplicationConfigurationNotFoundError') return {};
      throw err;
    }
  }

  private async readObjectLock(bucket: string): Promise<Record<string, unknown>> {
    try {
      const resp = await this.s3Client.send(
        new GetObjectLockConfigurationCommand({ Bucket: bucket })
      );
      const cfg = resp.ObjectLockConfiguration;
      if (!cfg) return {};
      const out: Record<string, unknown> = {};
      if (cfg.ObjectLockEnabled !== undefined) out['ObjectLockEnabled'] = cfg.ObjectLockEnabled;
      if (cfg.Rule?.DefaultRetention) {
        const r = cfg.Rule.DefaultRetention;
        const retention: Record<string, unknown> = {};
        if (r.Mode !== undefined) retention['Mode'] = r.Mode;
        if (r.Days !== undefined) retention['Days'] = r.Days;
        if (r.Years !== undefined) retention['Years'] = r.Years;
        out['Rule'] = { DefaultRetention: retention };
      }
      return out;
    } catch (err) {
      const e = err as { name?: string };
      if (
        e.name === 'ObjectLockConfigurationNotFoundError' ||
        e.name === 'NoSuchBucketConfiguration'
      ) {
        return {};
      }
      throw err;
    }
  }

  private async readAccelerate(bucket: string): Promise<Record<string, unknown>> {
    const resp = await this.s3Client.send(
      new GetBucketAccelerateConfigurationCommand({ Bucket: bucket })
    );
    // Always-emit placeholder. AWS-side default is "no acceleration" which
    // surfaces as Status=undefined. We emit `Suspended` (the semantic "off"
    // that AWS accepts on Put) so a console-side enable surfaces.
    return { AccelerationStatus: resp.Status ?? 'Suspended' };
  }

  private async readMetricsList(bucket: string): Promise<Array<Record<string, unknown>>> {
    const out: Array<Record<string, unknown>> = [];
    let continuationToken: string | undefined;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const resp = await this.s3Client.send(
        new ListBucketMetricsConfigurationsCommand({
          Bucket: bucket,
          ContinuationToken: continuationToken,
        })
      );
      for (const c of resp.MetricsConfigurationList ?? []) {
        out.push(this.metricsSdkToCfn(c as unknown as Record<string, unknown>));
      }
      if (!resp.IsTruncated) break;
      continuationToken = resp.NextContinuationToken;
    }
    return out;
  }

  private metricsSdkToCfn(c: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    if (c['Id'] !== undefined) out['Id'] = c['Id'];
    const f = c['Filter'] as Record<string, unknown> | undefined;
    if (f) {
      const and = f['And'] as Record<string, unknown> | undefined;
      const tagOnly = f['Tag'] as { Key?: string; Value?: string } | undefined;
      if (and) {
        if (and['Prefix'] !== undefined) out['Prefix'] = and['Prefix'];
        if (and['Tags']) out['TagFilters'] = and['Tags'];
        if (and['AccessPointArn'] !== undefined) out['AccessPointArn'] = and['AccessPointArn'];
      } else if (tagOnly) {
        out['TagFilters'] = [tagOnly];
      } else {
        if (f['Prefix'] !== undefined) out['Prefix'] = f['Prefix'];
        if (f['AccessPointArn'] !== undefined) out['AccessPointArn'] = f['AccessPointArn'];
      }
    }
    return out;
  }

  private async readAnalyticsList(bucket: string): Promise<Array<Record<string, unknown>>> {
    const out: Array<Record<string, unknown>> = [];
    let continuationToken: string | undefined;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const resp = await this.s3Client.send(
        new ListBucketAnalyticsConfigurationsCommand({
          Bucket: bucket,
          ContinuationToken: continuationToken,
        })
      );
      for (const c of resp.AnalyticsConfigurationList ?? []) {
        out.push(this.analyticsSdkToCfn(c as unknown as Record<string, unknown>));
      }
      if (!resp.IsTruncated) break;
      continuationToken = resp.NextContinuationToken;
    }
    return out;
  }

  private analyticsSdkToCfn(c: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    if (c['Id'] !== undefined) out['Id'] = c['Id'];
    const f = c['Filter'] as Record<string, unknown> | undefined;
    if (f) {
      const and = f['And'] as Record<string, unknown> | undefined;
      const tagOnly = f['Tag'] as { Key?: string; Value?: string } | undefined;
      if (and) {
        if (and['Prefix'] !== undefined) out['Prefix'] = and['Prefix'];
        if (and['Tags']) out['TagFilters'] = and['Tags'];
      } else if (tagOnly) {
        out['TagFilters'] = [tagOnly];
      } else if (f['Prefix'] !== undefined) {
        out['Prefix'] = f['Prefix'];
      }
    }
    const sca = c['StorageClassAnalysis'] as Record<string, unknown> | undefined;
    if (sca?.['DataExport']) {
      const dataExport = sca['DataExport'] as Record<string, unknown>;
      const dest = dataExport['Destination'] as Record<string, unknown> | undefined;
      const s3Dest = dest?.['S3BucketDestination'] as Record<string, unknown> | undefined;
      // The CFn `Destination` block is FLATTENED, exactly like its inventory
      // sibling below (issue #1670). This used to emit the SDK's nested
      // `{ S3BucketDestination: … }` wrapper, which the CFn schema does not
      // declare at all — `tests/fixtures/cfn-schemas/AWS-S3-Bucket.json` has
      // zero occurrences of that key, and its `nestedPropertyPaths` for
      // `AnalyticsConfigurations` end at
      // `StorageClassAnalysis.DataExport.Destination.{BucketAccountId,BucketArn,Format,Prefix}`.
      // So the WHOLE sub-object differed from any template-shaped or
      // effective-properties-shaped baseline on every comparison, and no
      // send-side record could ever converge with it.
      //
      // NOTE the SDK spells the account `BucketAccountId` here
      // (`AnalyticsS3BucketDestination`) but `AccountId` on the inventory side
      // (`InventoryS3BucketDestination`) — the two reverse mappers look alike
      // and are NOT interchangeable on that member.
      const dataExportCfn: Record<string, unknown> = {};
      if (dataExport['OutputSchemaVersion'] !== undefined) {
        dataExportCfn['OutputSchemaVersion'] = dataExport['OutputSchemaVersion'];
      }
      if (s3Dest) {
        const cfnDest: Record<string, unknown> = {};
        if (s3Dest['Bucket'] !== undefined) cfnDest['BucketArn'] = s3Dest['Bucket'];
        if (s3Dest['BucketAccountId'] !== undefined) {
          cfnDest['BucketAccountId'] = s3Dest['BucketAccountId'];
        }
        if (s3Dest['Format'] !== undefined) cfnDest['Format'] = s3Dest['Format'];
        if (s3Dest['Prefix'] !== undefined) cfnDest['Prefix'] = s3Dest['Prefix'];
        dataExportCfn['Destination'] = cfnDest;
      }
      out['StorageClassAnalysis'] = { DataExport: dataExportCfn };
    }
    return out;
  }

  private async readIntelligentTieringList(
    bucket: string
  ): Promise<Array<Record<string, unknown>>> {
    const out: Array<Record<string, unknown>> = [];
    let continuationToken: string | undefined;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const resp = await this.s3Client.send(
        new ListBucketIntelligentTieringConfigurationsCommand({
          Bucket: bucket,
          ContinuationToken: continuationToken,
        })
      );
      for (const c of resp.IntelligentTieringConfigurationList ?? []) {
        out.push(this.intelligentTieringSdkToCfn(c as unknown as Record<string, unknown>));
      }
      if (!resp.IsTruncated) break;
      continuationToken = resp.NextContinuationToken;
    }
    return out;
  }

  private intelligentTieringSdkToCfn(c: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    if (c['Id'] !== undefined) out['Id'] = c['Id'];
    if (c['Status'] !== undefined) out['Status'] = c['Status'];
    if (c['Tierings']) {
      const tierings = c['Tierings'] as Array<Record<string, unknown>>;
      out['Tierings'] = tierings.map((t) => ({
        AccessTier: t['AccessTier'],
        Days: t['Days'],
      }));
    }
    const f = c['Filter'] as Record<string, unknown> | undefined;
    if (f) {
      const and = f['And'] as Record<string, unknown> | undefined;
      const tagOnly = f['Tag'] as { Key?: string; Value?: string } | undefined;
      if (and) {
        if (and['Prefix'] !== undefined) out['Prefix'] = and['Prefix'];
        if (and['Tags']) out['TagFilters'] = and['Tags'];
      } else if (tagOnly) {
        out['TagFilters'] = [tagOnly];
      } else if (f['Prefix'] !== undefined) {
        out['Prefix'] = f['Prefix'];
      }
    }
    return out;
  }

  private async readInventoryList(bucket: string): Promise<Array<Record<string, unknown>>> {
    const out: Array<Record<string, unknown>> = [];
    let continuationToken: string | undefined;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const resp = await this.s3Client.send(
        new ListBucketInventoryConfigurationsCommand({
          Bucket: bucket,
          ContinuationToken: continuationToken,
        })
      );
      for (const c of resp.InventoryConfigurationList ?? []) {
        out.push(this.inventorySdkToCfn(c as unknown as Record<string, unknown>));
      }
      if (!resp.IsTruncated) break;
      continuationToken = resp.NextContinuationToken;
    }
    return out;
  }

  private inventorySdkToCfn(c: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    if (c['Id'] !== undefined) out['Id'] = c['Id'];
    if (c['IsEnabled'] !== undefined) out['Enabled'] = c['IsEnabled'];
    if (c['IncludedObjectVersions'] !== undefined)
      out['IncludedObjectVersions'] = c['IncludedObjectVersions'];
    const schedule = c['Schedule'] as Record<string, unknown> | undefined;
    if (schedule?.['Frequency'] !== undefined) out['ScheduleFrequency'] = schedule['Frequency'];
    if (c['OptionalFields'] !== undefined) out['OptionalFields'] = c['OptionalFields'];
    const dest = c['Destination'] as Record<string, unknown> | undefined;
    const s3Dest = dest?.['S3BucketDestination'] as Record<string, unknown> | undefined;
    if (s3Dest) {
      const cfnDest: Record<string, unknown> = {};
      if (s3Dest['Bucket'] !== undefined) cfnDest['BucketArn'] = s3Dest['Bucket'];
      if (s3Dest['AccountId'] !== undefined) cfnDest['BucketAccountId'] = s3Dest['AccountId'];
      if (s3Dest['Format'] !== undefined) cfnDest['Format'] = s3Dest['Format'];
      if (s3Dest['Prefix'] !== undefined) cfnDest['Prefix'] = s3Dest['Prefix'];
      out['Destination'] = cfnDest;
    }
    const filter = c['Filter'] as Record<string, unknown> | undefined;
    if (filter?.['Prefix'] !== undefined) out['Prefix'] = filter['Prefix'];
    return out;
  }

  /**
   * Adopt an existing S3 bucket into cdkd state.
   *
   * Lookup order:
   *  1. `--resource <id>=<name>` override or `Properties.BucketName` → use directly,
   *     verify with `HeadBucket`.
   *
   * Returns `null` when nothing matches — caller treats this as
   * "not deployed yet" rather than a failure.
   */
  async import(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    const explicit = resolveExplicitPhysicalId(input, 'BucketName');
    if (explicit) {
      try {
        await this.s3Client.send(new HeadBucketCommand({ Bucket: explicit }));
        return { physicalId: explicit, attributes: {} };
      } catch (err) {
        const e = err as { name?: string };
        if (e.name === 'NotFound' || e.name === 'NoSuchBucket') {
          return null;
        }
        throw err;
      }
    }

    // No `aws:cdk:path` tag walk: AWS rejects `aws:`-prefixed tag writes, so
    // that tag never exists on a real resource and the walk could not match
    // (issue #1134). Auto-mode import resolves ids from CloudFormation's
    // DescribeStackResources or the template's physical-name property; a bucket
    // reaching here needs an explicit `--resource` override.
    return null;
  }

  /**
   * Delete a bucket, emptying it first if not empty — but ONLY when
   * `allowAutoEmpty` is set (issue #1340).
   *
   * With `allowAutoEmpty` (CDK `autoDeleteObjects` tag present, or
   * `--force-stateful-recreation` consent via
   * {@link DeleteContext.forceDataDelete}), the retry loop handles the race
   * condition where objects (e.g., ALB logs) are written after
   * CustomResource cleanup but before bucket deletion.
   *
   * Without it, a not-empty bucket refuses deletion with an actionable
   * error — matching CloudFormation's DELETE_FAILED, which is the safety
   * net users rely on to keep `cdkd destroy` from silently destroying data
   * they never opted into losing.
   */
  private async deleteBucketWithEmptyRetry(
    logicalId: string,
    bucketName: string,
    allowAutoEmpty: boolean
  ): Promise<void> {
    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await this.s3Client.send(new DeleteBucketCommand({ Bucket: bucketName }));
        this.logger.debug(`Successfully deleted S3 bucket ${logicalId}`);
        return;
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        if (msg.includes('not empty') || msg.includes('BucketNotEmpty')) {
          if (!allowAutoEmpty) {
            throw new Error(
              `bucket ${bucketName} is not empty. Matching CloudFormation, cdkd does not ` +
                `delete a non-empty bucket unless it opted into automatic emptying ` +
                `(CDK's autoDeleteObjects: true, i.e. the '${S3_AUTO_DELETE_OBJECTS_TAG}' tag). ` +
                `Either empty the bucket first (delete all objects — and for versioned ` +
                `buckets all object versions and delete markers), or redeploy with ` +
                `autoDeleteObjects: true and destroy again.`
            );
          }
          this.logger.info(
            `Bucket ${bucketName} not empty (attempt ${attempt}/${maxAttempts}), emptying (auto-delete opt-in present)...`
          );
          await this.emptyBucket(bucketName);
          continue;
        }
        throw error;
      }
    }
    // Final attempt after emptying
    await this.s3Client.send(new DeleteBucketCommand({ Bucket: bucketName }));
    this.logger.debug(`Successfully deleted S3 bucket ${logicalId}`);
  }

  /**
   * Empty a bucket by deleting all object versions and delete markers.
   */
  private async emptyBucket(bucketName: string): Promise<void> {
    let keyMarker: string | undefined;
    let versionIdMarker: string | undefined;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const listResp = await this.s3Client.send(
        new ListObjectVersionsCommand({
          Bucket: bucketName,
          MaxKeys: 1000,
          ...(keyMarker && { KeyMarker: keyMarker }),
          ...(versionIdMarker && { VersionIdMarker: versionIdMarker }),
        })
      );

      const objects: Array<{ Key: string; VersionId: string }> = [];
      for (const v of listResp.Versions || []) {
        if (v.Key && v.VersionId) objects.push({ Key: v.Key, VersionId: v.VersionId });
      }
      for (const d of listResp.DeleteMarkers || []) {
        if (d.Key && d.VersionId) objects.push({ Key: d.Key, VersionId: d.VersionId });
      }

      if (objects.length > 0) {
        await this.s3Client.send(
          new DeleteObjectsCommand({
            Bucket: bucketName,
            Delete: { Objects: objects, Quiet: true },
          })
        );
        this.logger.debug(`Emptied ${objects.length} objects from ${bucketName}`);
      }

      if (!listResp.IsTruncated) break;
      keyMarker = listResp.NextKeyMarker;
      versionIdMarker = listResp.NextVersionIdMarker;
    }
  }
}
