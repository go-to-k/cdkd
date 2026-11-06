/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return */
import type { CreateContext } from '../../../types/resource.js';
import { type MaskedLogSinks, maskDeep, maskerOrIdentity } from '../../masked-retry-logger.js';
import { type PerItemApplyOutcome, configItemId, declaresBucketObjectLock } from './shared.js';
import { S3BucketProvider } from '../s3-bucket-provider.js';
import { S3Client } from '@aws-sdk/client-s3';
import { configStringRefusal, readConfigString, replayWarn } from '../../config-shape.js';
import { displaySafe } from '../../../utils/display-safe.js';
import { effectiveLifecycleConfiguration } from './lifecycle-fold.js';
import { effectiveNotificationConfiguration } from './effective-items.js';

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
export function emptyListConfigToUndefined<T extends Record<string, unknown>>(
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
export function declaresEmptyCollection(config: unknown, listKey: string): boolean {
  if (typeof config !== 'object' || config === null || Array.isArray(config)) return false;
  const list = (config as Record<string, unknown>)[listKey];
  return Array.isArray(list) && list.length === 0;
}

/**
 * A view of this provider whose S3 client WRITES NOTHING and whose logger is
 * silent, for `update()`'s template-path pre-flight (issue
 * [#3740](https://github.com/go-to-k/cdkd/issues/3740)).
 *
 * It exists so the pre-flight can ask the per-config appliers their OWN
 * question instead of a restated copy of it: running
 * {@link applySubConfigDiffs} on this view executes every predicate, in the
 * real order and under the real diff gating, while each `send` resolves to
 * an empty response. Safe because `s3Client` and the `CreateBucket` client
 * (issue #4639; no applier reaches it, but it is stubbed all the same) are
 * the ONLY clients this class holds and no applier reads a response field
 * back; a new client, or an applier that consumes a response, must be
 * stubbed here too. One read does run on it: the versioning-suspend guard's
 * `readObjectLock` (go-to-k/cdkd#5395), which sees `{}`, takes the bucket as
 * unlocked and sends its suspend to this stub, which is harmless because the
 * probe's outcome is discarded. A fresh object
 * per call (its prototype is `this`), so concurrent resources on this
 * singleton never see each other's stub.
 */
export function noWriteProbe(this: S3BucketProvider): S3BucketProvider {
  const probe = Object.create(this) as S3BucketProvider;
  probe.s3Client = { send: async () => ({}) } as unknown as S3Client;
  Object.defineProperty(probe, 'createClientHolder', {
    value: { client: Promise.resolve(probe.s3Client) },
  });
  const silent = (): void => {};
  probe.logger = Object.assign(Object.create(this.logger) as typeof this.logger, {
    debug: silent,
    info: silent,
    warn: silent,
    error: silent,
  });
  return probe;
}

/**
 * A view of this provider for ONE `create()` / `update()` call whose logger
 * routes every line through `sinks` (issue
 * [#2177](https://github.com/go-to-k/cdkd/issues/2177)).
 *
 * The one-masked-sink shape (`createMaskedLogSinks`), extended to the private
 * appliers those two methods reach: `create()` / `update()` re-enter
 * themselves on the view, so their whole body and every applier it calls
 * logs through the view's `this.logger` and a line added later is masked by
 * construction. Re-entering, rather than calling the appliers on a `view`
 * local, keeps every call spelled `this.<method>(...)`, which is what the
 * repo's AST critic (`gen:update-wrap-coverage`) follows. Meanwhile
 * {@link shown} masks each interpolated value RAW, the only arm a secret
 * shorter than `MIN_NEEDLE_LENGTH` reaches. A fresh object per call (its
 * prototype is `this`), like {@link noWriteProbe}, so concurrent resources on
 * this singleton never share a masker. `delete()` does not build one: every
 * caller holding a resolved bag runs the delete under it as a PRINTING bag
 * (issue [#2007](https://github.com/go-to-k/cdkd/issues/2007)), so the
 * logger's sink masks its lines.
 */
export function maskedView(this: S3BucketProvider, sinks: MaskedLogSinks): S3BucketProvider {
  const view = Object.create(this) as S3BucketProvider;
  const base = this.logger;
  const route =
    (level: 'debug' | 'info' | 'warn' | 'error') =>
    (message: string, ...args: unknown[]): void =>
      base[level](
        sinks.mask(message),
        // An `Error` passes as its CLASS only. Its text is a sentence, where the
        // masker's substring arm cannot see a secret shorter than
        // `MIN_NEEDLE_LENGTH`, and `maskDeep` would render it `{}` anyway
        // (message and stack are non-enumerable).
        ...args.map((arg) =>
          arg instanceof Error ? sinks.mask(arg.name) : maskDeep(arg, sinks.mask)
        )
      );
  view.logger = Object.assign(Object.create(base) as typeof base, {
    debug: route('debug'),
    info: route('info'),
    warn: route('warn'),
    error: route('error'),
  });
  view.opMask = sinks.mask;
  return view;
}

/**
 * A value as a log line or message prints it: masked RAW through this
 * operation's masker (leaves and keys, via `maskDeep`), then `displaySafe`.
 * On the singleton the masker is identity, so this is plain `displaySafe`.
 */
export function shown(this: S3BucketProvider, value: unknown): string {
  return displaySafe(maskDeep(value, this.shownMask));
}

/**
 * One string masked RAW through this operation's masker, for a message half
 * not rendered by {@link shown}. It spells `maskerOrIdentity(this.opMask)`
 * rather than calling the {@link shownMask} getter: `gen:update-wrap-coverage`
 * cannot resolve a getter CALL and would then mark `update()` unverifiable.
 */
export function maskRaw(this: S3BucketProvider, text: string): string {
  return maskerOrIdentity(this.opMask)(text);
}

/**
 * The refusal a TEMPLATE-path `update()` raises for a malformed
 * `VersioningConfiguration.Status` or `LoggingConfiguration` member, or
 * `undefined` (issue [#3728](https://github.com/go-to-k/cdkd/issues/3728)).
 *
 * It asks exactly what the two warn-and-skip arms in
 * {@link applySubConfigDiffs} ask, with the same predicate, key, fallback and
 * path, and only where those arms would ACT:
 *
 * - versioning: the block CHANGED (nullish on both sides, the arm's own
 *   `versioningChanged`), and `configStringRefusal` refuses `Status`;
 * - logging: the block CHANGED, and `DestinationBucketName` or
 *   `LogFilePrefix` refuses, in the applier's order. An ABSENT block (the
 *   legitimate removal, `diffSubConfig`'s clear arm) needs no gate of its
 *   own: `configStringRefusal` answers `undefined` for a nullish container.
 *
 * An unchanged malformed value is not a pending operation, so it is not
 * refused either — the same gate the arms' own warnings take.
 */
export function versioningOrLoggingRefusal(
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>
): string | undefined {
  const changed = (key: string): boolean =>
    JSON.stringify(previousProperties[key] ?? null) !== JSON.stringify(properties[key] ?? null);
  if (changed('VersioningConfiguration')) {
    const refusal = configStringRefusal(
      properties['VersioningConfiguration'],
      'Status',
      'Suspended',
      'AWS::S3::Bucket VersioningConfiguration'
    );
    if (refusal !== undefined) return refusal;
  }
  const logging = properties['LoggingConfiguration'];
  if (changed('LoggingConfiguration')) {
    return (
      configStringRefusal(
        logging,
        'DestinationBucketName',
        '',
        'AWS::S3::Bucket LoggingConfiguration'
      ) ?? configStringRefusal(logging, 'LogFilePrefix', '', 'AWS::S3::Bucket LoggingConfiguration')
    );
  }
  return undefined;
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
export function applyEffectiveOverrides(
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
export function buildEffectiveItemArray(
  desired: Array<Record<string, unknown>>,
  previous: Array<Record<string, unknown>> | undefined,
  isSkipped: (item: Record<string, unknown>, index: number) => boolean,
  sentItemOf?: (item: Record<string, unknown>, index: number) => Record<string, unknown> | undefined
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
 * (`'CorsConfiguration.CorsRules'`), never the bare terminal segment — a
 * spelling chosen for `gen-nested-key-coverage`'s key pass (retired by issue
 * #3723), which took a bare literal as evidence of per-key handling.
 */
export function emptyCollectionSkip(
  this: S3BucketProvider,
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
export function announceCreateEmptyCollectionSkip(
  this: S3BucketProvider,
  key: string,
  collectionPath: string
): void {
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
export async function diffSubConfig<T>(
  this: S3BucketProvider,
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
export async function diffArrayConfigById(
  this: S3BucketProvider,
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
export async function applyAllSubConfigsForCreate(
  this: S3BucketProvider,
  bucketName: string,
  properties: Record<string, unknown>,
  context?: CreateContext
): Promise<Map<string, unknown>> {
  const overrides = new Map<string, unknown>();
  // The REAL masker for this call, not a decorative parameter: the
  // destination-shape refusals below quote values read straight off the
  // desired `properties` bag, which arrives RESOLVED (issue #2178).
  const maskSecrets = this.shownMask;
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
  // `create()` is NOT always template-borne: the rollback replay's
  // reverse-replacement arm (`rollback-executor/replay-reverse-replacement.ts`) revives the OLD resource by calling
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
    const applied = await this.applyNotificationConfiguration(
      bucketName,
      notifConfig,
      replayOnUnusable
    );
    // A SKIP drops the key (there is no previous value on a fresh bucket) —
    // the replay-CREATE answer, reachable only through `replayOnUnusable`
    // since a template-path create THROWS on the same value (issue #1759).
    if (!applied) overrides.set('NotificationConfiguration', undefined);
    // Issue #1748, the create-path twin of the update arm. Same rule, and it
    // is NOT the replay-only case the rest of this method handles: a
    // never-emitted SPELLING carries no malformed value and no downgrade, so
    // an ORDINARY template-path create reaches it.
    else
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
      await this.applyAnalyticsConfigurations(
        bucketName,
        analyticsConfigs,
        replayOnUnusable,
        maskSecrets
      )
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
      await this.applyInventoryConfigurations(
        bucketName,
        inventoryConfigs,
        replayOnUnusable,
        maskSecrets
      )
    );
  }

  // Replication Configuration
  const replConfig = properties['ReplicationConfiguration'] as Record<string, unknown> | undefined;
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
    const applied = await this.applyObjectLockConfiguration(
      bucketName,
      objectLockConfig,
      replayOnUnusable
    );
    if (!applied) {
      // Replay-CREATE: no RULE was applied and there is no previous value to
      // keep. But the replay-CREATE "DROP the key" answer is scoped to a
      // skip whose declared value AWS cannot report (issue #1718), and here
      // it can: the bucket-level flag is set by `CreateBucket` from the
      // TOP-LEVEL `ObjectLockEnabled`, independently of this Put, and
      // `readObjectLock` always emits it. Dropping the whole block would
      // leave state silent about a member AWS holds -- phantom drift in the
      // other direction. So record exactly what survives: the flag when the
      // bucket really was created object-lock-enabled, nothing otherwise.
      overrides.set(
        'ObjectLockConfiguration',
        declaresBucketObjectLock(properties) ? { ObjectLockEnabled: 'Enabled' } : undefined
      );
    }
  }
  return overrides;
}
