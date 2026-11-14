/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return */
import { cdkdRemedy, proseQuoted } from '../../../utils/pasteable-command.js';
import { type MaskerFn, maskDeep } from '../../masked-retry-logger.js';
import { displayIdent, displaySafe } from '../../../utils/display-safe.js';
import { renderDisableCommand } from '../../replacement-protection-advice.js';

/**
 * The "remove this bucket by hand" clause both partial-create cleanup arms end
 * with, rendered through the shared sanitize / shell-quote / SUPPRESS
 * (`renderDisableCommand`, the issue
 * [#2669](https://github.com/go-to-k/cdkd/issues/2669) shape; adopted here by
 * issue [#3136](https://github.com/go-to-k/cdkd/issues/3136)).
 *
 * `bucketName` is TEMPLATE-chosen — `Properties.BucketName`, or the name cdkd
 * generated for the resource — and until now both arms hand-quoted it as
 * `--bucket '<name>'`, so a `'` in the value broke out of the quoting and a
 * control byte forged lines on the operator's terminal. (A WARN, so that is
 * its whole reach — the recorder persists a thrown `error.message`, not this.)
 * When sanitizing CHANGES the name the whole command is
 * SUPPRESSED rather than shown with the sanitized value, because such a command
 * would delete a DIFFERENT bucket — the wrong-target harm the shared renderer
 * exists to prevent, and the reason emitting no command is the honest answer
 * rather than a fallback.
 *
 * ONE clause for both arms so the two cannot come to render the same value
 * differently. The PROSE copy of the name each arm carries BESIDE it goes
 * through `displaySafe` at the arm, masked first (issue
 * [#3269](https://github.com/go-to-k/cdkd/issues/3269)): unlike the command, a
 * sanitized prose name names no target, so it is rendered rather than withheld.
 *
 * `maskSecrets` is REQUIRED rather than optional (security review of #3136,
 * which found these two arms reaching no masker at all). Both call sites pass
 * the operation's masker (`shownMask`, issue #2177), whose view logger also
 * masks the whole warning; here it makes `renderDisableCommand` SUPPRESS the
 * command for a secret-bearing bucket name — which a message-level mask could
 * not catch once `shellQuote` has escaped an inner quote.
 */
export function manualBucketDeletionClause(
  bucketName: string,
  maskSecrets: MaskerFn,
  journaled: boolean
): string {
  const command = renderDisableCommand({
    before: 'aws s3api delete-bucket --bucket',
    identifier: bucketName,
    maskSecrets,
  });
  // `journaled`: create() marked the bucket (go-to-k/cdkd#4583), so the failed
  // deploy's rollback journal names it; the manual command is the fallback.
  const lead = journaled
    ? `Outside a rollback's re-create, the failed deploy's rollback journal records the bucket for ${proseQuoted(cdkdRemedy('cdkd rollback', '--revert-failed'), '`')}; ` +
      'otherwise delete it yourself before the next deploy'
    : 'Manual deletion may be required before the next deploy';
  return command
    ? `${lead}: ${command}`
    : `${lead}, via the console: the bucket name ` +
        'cannot be reproduced safely on a command line, so any command shown here could act on a ' +
        'different bucket or run part of the name as shell.';
}

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
export function configItemId(item: unknown): string | undefined {
  if (!isPlainObject(item)) return undefined;
  const id = item['Id'];
  if (typeof id === 'string') return id;
  if (typeof id === 'number' && Number.isFinite(id)) return String(id);
  return undefined;
}

/**
 * Whether the template asks for a bucket-level Object Lock.
 *
 * Shared on purpose by the two sites that must agree: `create()` passes
 * `ObjectLockEnabledForBucket` to `CreateBucket` from it, and the create-path
 * Object Lock skip records `{ ObjectLockEnabled: 'Enabled' }` from it. Spelled
 * twice, the recorded value could claim a flag the bucket does not carry.
 *
 * Note the source: the BUCKET-level `ObjectLockEnabled`, never the one nested
 * inside `ObjectLockConfiguration` -- only the top-level property reaches
 * `CreateBucket`, and it is the only one AWS can report back.
 */
export function declaresBucketObjectLock(properties: Record<string, unknown>): boolean {
  return properties['ObjectLockEnabled'] === true || properties['ObjectLockEnabled'] === 'true';
}

/**
 * Whether the bag declares Object Lock through the NESTED
 * `ObjectLockConfiguration.ObjectLockEnabled: Enabled`, which, unlike the
 * top-level flag, is sent to an existing bucket (go-to-k/cdkd#5395). A
 * `readObjectLock` snapshot spells a locked bucket this way too.
 */
export function declaresNestedObjectLock(properties: Record<string, unknown>): boolean {
  const cfg = properties['ObjectLockConfiguration'] as Record<string, unknown> | undefined;
  return cfg?.['ObjectLockEnabled'] === 'Enabled';
}

/** The class name of a caught error, for a debug line; never its message. */
export function caughtErrorName(error: unknown): string {
  const name = (error as { name?: unknown } | null)?.name;
  return typeof name === 'string' && name !== '' ? name : 'unknown error';
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
export interface PerItemApplyOutcome {
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
 * exported from there because `resolveS3BucketDestination` is an S3-specific
 * refusal, not a shared shape guard — the two only share the wording.
 */
export function describeValue(value: unknown, maskSecrets: MaskerFn = (text) => text): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  // Mask BEFORE the stringify, never after (issue #2178). A provider's
  // `properties` bag arrives RESOLVED, so a `{{resolve:secretsmanager:...}}`
  // scalar is already plaintext here, and `JSON.stringify` escapes `"` / `\` /
  // newlines out of the finished line so a message-level mask can no longer
  // find the needle. The masker defaults to identity so every existing caller
  // keeps its current (unmasked) behaviour rather than silently changing.
  if (typeof value === 'string')
    return `a string ${displaySafe(JSON.stringify(maskDeep(value, maskSecrets)))}`;
  // KEYS leak too, and for the same reason `maskDeep` masks keys: a resolved
  // secret used as a map key is rendered into this line verbatim. No
  // `JSON.stringify` here, so the critic cannot see it — the argument is
  // identical all the same.
  if (isPlainObject(value)) {
    return `an object with keys [${Object.keys(value)
      .map((key) => displaySafe(maskSecrets(key)))
      .join(', ')}]`;
  }
  // Only number / boolean / bigint / symbol / function / undefined reach here
  // (string, array, plain object and null are all handled above), none of which
  // can BE a resolved secret — those are always strings. Masked anyway because
  // the call is free and the alternative is a branch that renders a value
  // through no masker at all.
  return `a ${typeof value} (${maskSecrets(String(value))})`;
}

/**
 * Coerce a CFn numeric to a finite number. CloudFormation is stringly typed —
 * a hand-written or imported template (the audience the legacy lifecycle
 * branches exist for) can carry `"365"` where the schema says number.
 */
export function coerceCfnNumber(value: unknown): number | undefined {
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
export function mergeLegacySingular(
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
 * A lifecycle rule's `Id` as the warnings print it (go-to-k/cdkd#3617). The id
 * is template-chosen and free-form, so it renders through `displayIdent` --
 * bare when plain, otherwise one JSON string -- rather than inside cdkd's own
 * quotes, which a `'` in it would close. An absent or empty id is named in
 * words.
 */
export function shownLifecycleRuleId(id: unknown): string {
  return id === undefined || id === null || id === '' ? '(no Id)' : displayIdent(id);
}
