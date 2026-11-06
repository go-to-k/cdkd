/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return */
import { canonicalizeItemList } from './lifecycle-fold.js';
import { coerceCfnBoolean, configBooleanRefusal, configStringRefusal } from '../../config-shape.js';
import { isPlainObject } from './shared.js';

/**
 * The CFn `Destination` block cdkd actually SENDS for `declared` (issue #1707) —
 * the shared fold behind BOTH halves of the #1633 pair: the per-item
 * `effectiveProperties` record and
 * {@link S3BucketProvider.canonicalizeDesiredProperties}.
 *
 * The readback (`inventorySdkToCfn` / `analyticsSdkToCfn`) emits only
 * `{BucketArn, BucketAccountId, Format, Prefix}`, the members the live CFn
 * registry schema declares (`additionalProperties: false`). The block is rebuilt
 * from exactly those members so a record never carries a key the readback cannot
 * report.
 *
 * The SDK spellings this once also folded (the nested
 * `{ S3BucketDestination: { ... } }` shape and a `Bucket` alias for
 * `BucketArn`) are gone: `BucketArn` and `Format` are schema-required here and
 * `AWS::S3::Bucket` is in `CFN_ENFORCED_TYPES`, so a template using either is
 * refused pre-flight by `nested-required.ts` (issue #3602).
 *
 * `Format` is the one member a caller can override: the applier passes the
 * value it SENT, which differs from the declared one when the warn-and-
 * SUBSTITUTE read replaced a malformed value (#1670). Absent on BOTH sides it
 * defaults to the `'CSV'` the appliers send, so the record carries what AWS
 * will report back rather than one key fewer.
 *
 * @returns the rebuilt block, or `declared` BY IDENTITY when it already is one
 *   (so an ordinary template records byte-for-byte what it declared) or is not
 *   a shape this can fold at all (absent / malformed / no `BucketArn` — left for
 *   the resolver's own refusal to report).
 */
export function effectiveS3BucketDestination(declared: unknown, sentFormat?: unknown): unknown {
  if (!isPlainObject(declared)) return declared;
  // The wire REQUIRES a bucket: `resolveS3BucketDestination` drops a block with
  // no `BucketArn` and the item is SKIPPED, so folding one would describe a call
  // that never went out. The probe is truthiness, matching that guard exactly.
  if (!declared['BucketArn']) return declared;
  const out: Record<string, unknown> = { BucketArn: declared['BucketArn'] };
  if (declared['BucketAccountId'] !== undefined) {
    out['BucketAccountId'] = declared['BucketAccountId'];
  }
  out['Format'] =
    sentFormat ?? declaredOrDefault(declared, 'Format', INVENTORY_DESTINATION_DEFAULT_FORMAT);
  if (declared['Prefix'] !== undefined) out['Prefix'] = declared['Prefix'];
  return sameScalarRecord(out, declared) ? declared : out;
}

/**
 * `container[key]` when the key is DECLARED, else `fallback` — presence-based,
 * NEVER `??`, and that distinction is the whole guard against issue #1670's
 * finding 3.
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
export function declaredOrDefault(
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
export const INVENTORY_DESTINATION_DEFAULT_FORMAT = 'CSV';

/**
 * The default `Enabled` / `IncludedObjectVersions` an inventory item is SENT
 * with when it declares none — the same drift-apart concern as
 * {@link INVENTORY_DESTINATION_DEFAULT_FORMAT}.
 */
export const INVENTORY_DEFAULT_ENABLED = true;
export const INVENTORY_DEFAULT_INCLUDED_OBJECT_VERSIONS = 'All';

/** The `OutputSchemaVersion` an analytics data export is SENT with by default. */
export const ANALYTICS_DEFAULT_OUTPUT_SCHEMA_VERSION = 'V_1';

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
export function sameScalarRecord(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
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
export const INVENTORY_DEFAULT_SCHEDULE_FREQUENCY = 'Weekly';

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
export function effectiveInventoryItem(
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
export function effectiveAnalyticsItem(
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
export const INTELLIGENT_TIERING_DEFAULT_STATUS = 'Enabled';

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
export function effectiveIntelligentTieringItem(
  item: Record<string, unknown>
): Record<string, unknown> {
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
export function foldToleratedAliases(
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

/** The transition date member, held in a CONST so the fold writes it COMPUTED. */
export const TRANSITION_DATE_KEY = 'TransitionDate';

/**
 * The lifecycle `Transitions[]` aliases the applier accepts (issue #1748).
 *
 * `NoncurrentVersionTransitions[]` has none: its `TransitionInDays` is a
 * schema-required member, so a template spelling it `NoncurrentDays` is refused
 * pre-flight by `nested-required.ts` and the alias was dropped (issue #3585).
 */
export const TRANSITION_ALIASES = [
  ['TransitionInDays', 'Days'],
  ['TransitionDate', 'Date'],
] as const;

/** The refusal path for the notification EventBridge boolean (issue #1759). */
export const EVENTBRIDGE_CONFIG_PATH =
  'AWS::S3::Bucket NotificationConfiguration.EventBridgeConfiguration';

/**
 * The block's own key, held in a CONST so the fold below writes it as a
 * COMPUTED key.
 *
 * Load-bearing, not style: `gen-nested-key-coverage`'s write-side walk reads
 * a bag-derived spread-and-patch literal that NAMES a member
 * (`{ ...config, EventBridgeConfiguration: … }`) as the #1475 whole-blob
 * HAND-OFF and records everything beneath that path as DELIVERED WHOLE — so a
 * DIFF-side fold spelled that way would mark the whole notification subtree as
 * delivered whole, which can withdraw a literal's rescue of a shape-pass
 * `definition-member-missing` verdict. Same reason {@link canonicalizeBlock}
 * exists.
 */
export const EVENTBRIDGE_CONFIG_KEY = 'EventBridgeConfiguration';

/**
 * What a DECLARED `EventBridgeConfiguration` block with no `EventBridgeEnabled`
 * key means. CFn marks the member required, so the block's presence is the
 * affirmative declaration; this is also the pre-#1759 behavior for that shape.
 */
export const EVENTBRIDGE_DEFAULT_ENABLED = true;

/**
 * The boolean the wire derives from a USABLE `EventBridgeConfiguration` block
 * (issue #1759) — the ONE definition `applyNotificationConfiguration` and
 * {@link effectiveNotificationConfiguration} share, so the value that goes on
 * the wire and the value recorded into state cannot drift apart.
 *
 * Callers MUST have cleared `configBooleanRefusal` first; the `??` is only
 * correct once every declared-but-unusable value has been refused.
 */
export function eventBridgeEnabledOf(eb: unknown): boolean {
  const declared = isPlainObject(eb) ? eb['EventBridgeEnabled'] : undefined;
  return coerceCfnBoolean(declared) ?? EVENTBRIDGE_DEFAULT_ENABLED;
}

/** The notification families whose empty declaration is never SENT (issue #1759). */
export const NOTIFICATION_LIST_KEYS = [
  'TopicConfigurations',
  'QueueConfigurations',
  'LambdaConfigurations',
] as const;

/**
 * Drop a declared-but-EMPTY collection the applier never sends (issue #1759).
 *
 * MEASURED before choosing this answer, because the sibling shape answers the
 * opposite way: the lifecycle / CORS empty-collection skip RECORDS its
 * placeholder (issue #1718) precisely because `readLifecycle` / `readCors`
 * always emit `{Rules: []}` / `{CorsRules: []}` for an unconfigured bucket, so
 * the declared empty collection already equals the readback. `readNotification`
 * does NOT: each family is emitted only under
 * `resp.<Family> && resp.<Family>.length > 0`, so an unconfigured bucket comes
 * back with the key ABSENT. A record keeping `[]` therefore describes a key set
 * AWS can never report, and the honest answer here is the DROP.
 *
 * Scoped to a genuinely EMPTY ARRAY. A non-array declaration is skipped by the
 * applier's `Array.isArray(...)` gate too, but it is MALFORMED: dropping it
 * would make the desired side compare equal and stop the difference being
 * reported, which is the concealment `.claude/rules/providers.md` finding 3
 * refuses. It is left visible instead.
 */
export function dropEmptyNotificationFamilies(
  config: Record<string, unknown>
): Record<string, unknown> {
  let out: Record<string, unknown> | undefined;
  for (const listKey of NOTIFICATION_LIST_KEYS) {
    const list = config[listKey];
    if (!Array.isArray(list) || list.length > 0) continue;
    out ??= { ...config };
    delete out[listKey];
  }
  return out ?? config;
}

/**
 * The `Event` / `Events` spelling on a notification item (issue #1748).
 *
 * `Event` is the member the CFn registry schema declares (`TopicConfiguration`
 * is `{Event, Filter, Topic}` — there is no `Events`) and therefore the one
 * EVERY template carries. The applier accepts both
 * (`t['Event'] !== undefined ? [t['Event']] : t['Events']`), because the
 * readback emits `Events` for a multi-event live configuration and
 * `drift --revert` sends a readback-shaped bag.
 *
 * This is not a pure rename — the SDK member is a LIST — so it folds by ARITY:
 * a single-element list is the CFn `Event`, and a longer one has no CFn
 * spelling at all and is left as `Events`, which is what the readback emits for
 * it.
 *
 * The destination ARN has no alias: `Topic` / `Queue` / `Function` are
 * schema-required members, so the SDK spellings (`TopicArn`, …) are refused
 * pre-flight by `nested-required.ts` and the applier no longer reads them
 * (issue #3585).
 *
 * `readNotification` was emitting `Events` unconditionally, so the record and
 * the readback disagreed on every notification-configured bucket; it now
 * reverse-maps to the CFn spelling on the same arity rule, exactly as
 * `readLifecycle` already does for `TransitionInDays`. One-time drift on upgrade
 * for an already-deployed bucket, the same accepted cost the sibling reverse-map
 * changes in this file document, and it clears on the next deploy.
 */
export function foldNotificationEvents(item: Record<string, unknown>): Record<string, unknown> {
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
 * `applyNotificationConfiguration` accepts a single-element `Events` list
 * alongside the CFn scalar `Event` ({@link foldNotificationEvents}), while
 * `readNotification` emits `Event` for it. A record written in the list
 * spelling therefore can never match the readback: `cdkd drift` re-reports it
 * forever and `--revert` re-issues the same Put, with NO warning anywhere,
 * because nothing is malformed and nothing is substituted.
 *
 * The Put is a FULL REPLACE with no skip arm, so there is no
 * previous-value-retained case to distinguish — whenever it succeeds, this is
 * what AWS holds.
 *
 * @returns `config` BY IDENTITY when no tolerated spelling is declared, or when
 *   it is not a shape this can fold at all (left for the applier's own
 *   handling).
 */
export function effectiveNotificationConfiguration(config: unknown): unknown {
  if (!isPlainObject(config)) return config;
  let out = config;
  for (const listKey of NOTIFICATION_LIST_KEYS) {
    out = canonicalizeItemList(out, listKey, foldNotificationEvents);
  }
  out = dropEmptyNotificationFamilies(out);
  return foldEventBridgeConfiguration(out);
}

/**
 * Normalize `EventBridgeConfiguration` onto the shape `readNotification` emits
 * (issue #1759, items 2 and 3 of the same block).
 *
 * CFn is stringly typed, so `EventBridgeEnabled: 'true'` is a legitimate
 * declaration; the wire turns the value into presence/absence and
 * `readNotification` emits the BOOLEAN (`{EventBridgeEnabled: <bool>}`, the
 * #1430 shape). A record holding the STRING can therefore never match the
 * readback. This is #1633's lossless-coercion arm and it meets the #1643 bar —
 * what AWS reports back is exactly the boolean cdkd derived at send time. A
 * declared `null` folds to `false` for the same reason: the applier reads it as
 * "block omitted" and sends nothing.
 *
 * Keyed off the DECLARED shape and off the wire's own predicate, never off a
 * refusal: a value `configBooleanRefusal` rejects is left COMPLETELY alone (no
 * patch, and the key not dropped), because the wire SKIPS the whole Put for it
 * and AWS keeps the previous configuration. Folding it would collapse the
 * desired side onto the retained value, the provider would never be called, and
 * the skip warning would stop — the "mirror what the wire does" rule.
 *
 * MEASURED AND DELIBERATELY NOT FOLDED (1) — the per-item `Id`, which issue
 * #1755 asked to be measured rather than assumed. The applier sends
 * `Id: t['Id']`, so a template declaring none sends none, AWS GENERATES one, and
 * `readNotification` emits it (`if (t.Id !== undefined) e['Id'] = t.Id`). That is
 * an AWS-COMPUTED value, not a spelling: it belongs in `observedProperties`,
 * which `readCurrentState` already populates, and `.claude/rules/providers.md` is
 * explicit that a computed value in `properties` makes the DESIRED baseline drift
 * from the template and disables the #1160 absent-field removal derivation. There
 * is also nothing to fold TOWARDS — the value does not exist at send time, which
 * is the #1643 "knowable at send time" test failing. So: no fold, by measurement
 * rather than by omission.
 *
 * MEASURED AND DELIBERATELY NOT FOLDED (2): `readNotification` emits
 * `EventBridgeConfiguration` UNCONDITIONALLY, so a notification configuration
 * that declares no EventBridge block at all is one key short of the readback.
 * That is NOT this class — nothing was declared, so there is no spelling to
 * normalize, and supplying the key would record one the template does not have
 * on EVERY notification-configured bucket (the shape #1723 could record only
 * once a twin folded the same key into both diff sides). `readNotification`'s own comment
 * already scopes that difference: it is a ONE-TIME, self-clearing drift on the
 * `properties`-fallback baseline, deliberately accepted by #1430, not the
 * permanent phantom drift this fold exists to remove.
 *
 * @returns `config` BY IDENTITY when nothing is declared, when the declared
 *   block is already the emitted shape, or when it is unfoldable.
 */
export function foldEventBridgeConfiguration(
  config: Record<string, unknown>
): Record<string, unknown> {
  const eb = config[EVENTBRIDGE_CONFIG_KEY];
  if (eb === undefined) return config;
  if (eb !== null && configBooleanRefusal(eb, 'EventBridgeEnabled', EVENTBRIDGE_CONFIG_PATH)) {
    return config;
  }
  const enabled = eb === null ? false : eventBridgeEnabledOf(eb);
  const declared = isPlainObject(eb) ? eb['EventBridgeEnabled'] : undefined;
  if (isPlainObject(eb) && Object.keys(eb).length === 1 && Object.is(declared, enabled)) {
    return config;
  }
  return { ...config, [EVENTBRIDGE_CONFIG_KEY]: { EventBridgeEnabled: enabled } };
}
