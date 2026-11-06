import { coerceCfnInteger } from '../../config-shape.js';
import {
  WARM_THROUGHPUT_MEMBERS,
  type WarmThroughputCoercion,
} from '../../dynamodb-warm-throughput.js';
import { maskDeep, type MaskerFn } from '../../masked-retry-logger.js';
import { asRecord } from './capacity.js';
import { isUnresolvedIntrinsicBlock } from './gsi.js';

/**
 * The sentinel DynamoDB accepts to CLEAR a per-GSI on-demand request-unit
 * ceiling (issue #1423). Live-verified against real AWS: `UpdateTable` with
 * `GlobalSecondaryIndexUpdates[].Update.OnDemandThroughput = {-1, -1}` is
 * accepted, and the member reads back ABSENT from `DescribeTable` afterwards —
 * so it is genuinely reset to unlimited rather than stored as -1. Any drift /
 * read-back comparison must therefore expect ABSENCE, not this value.
 */
export const ON_DEMAND_LIMIT_RESET = -1;

// The index-busy DELETE rule — `hasTransitionalIndex`, the message-keyed
// `isIndexBusyDeleteError` classifier, the two per-type retry budgets /
// `DELETE_INDEX_BUSY_REARM_MAX_ATTEMPTS`, `DELETE_INDEX_WAIT_PROCEED_NOTE`, the
// settle poll and the retry loop itself — is IMPORTED from
// `../dynamodb-index-busy-delete.ts` rather than spelled here. It shipped in
// this file for issue #1830 and moved out for issue #1931, when
// `dynamodb-table-provider.ts` turned out to need every one of them for the
// same AWS refusal. Same reason as `../dynamodb-warm-throughput.ts`: a rule two
// providers answer is a rule that must not be answerable two ways.

// TWO numeric readers, chosen per site by what the number is FOR (issue #3135):
//
//  - `coerceCfnInteger` (`../config-shape.ts`) reads every value this file
//    FORWARDS to AWS — a `ProvisionedThroughput` / `OnDemandThroughput` member,
//    a `MinCapacity` / `SeedCapacity` the derivation turns into one — AND the
//    diagnostic / mirror predicates paired with a forwarder
//    (`reportUnresolvedRawMember`, `explicitCovers`, the `undefined` tests in
//    `collectUncomparableCapacityGsiNames` and `toSdkReplicaThroughputOverrides`). It is
//    CloudFormation's MEASURED DynamoDB Integer grammar, `/^[+-]?\d+$/` with NO
//    trim (table on `toCfnInteger` in `../dynamodb-warm-throughput.ts`): a
//    padded `" 7 "`, `"0x9"`, `"1e1"` or `"6.5"` is a template CloudFormation
//    REFUSES, and `Number()` forwarded `7` / `9` / `10` for it. A predicate
//    paired with a forwarder MUST read through the same function: on the wider
//    reader `" 7 "` counted as "covered" / "determined" while the forwarder
//    beside it dropped the value, so the default stood in silently or a live
//    baseline read a 5/5 fallback as a scale-down.
//  - `toFiniteNumber` (`../dynamodb-warm-throughput.ts`) reads the LIVE side
//    only — a `DescribeTable` number compared against the desired one. A guard
//    is safe on the wider set: over-acceptance can only skip fewer calls.
//
// `toFiniteNumber` was a local copy until the review of issue #1857's PR: this
// file's spelling, `dynamodb-table-provider.ts`'s `capacityNumber` and the
// shared module's own member parser were three hand-written statements of one
// rule, which is the divergence that module exists to prevent. Both readers
// refuse a whitespace-only string, which `Number('   ')` reads as **0** — a
// request for ZERO capacity that nobody declared.
//
// `WARM_THROUGHPUT_MEMBERS` / `WarmThroughputSpec` / `WarmThroughputCoercion` /
// `coerceWarmThroughput` live there too — the same stringly-typed-CFn coercion
// `AWS::DynamoDB::Table` shipped for issue #1808, so one type cannot start
// accepting a shape the other refuses. Only that Table spelling ever shipped;
// the GlobalTable side arrived with issue #1857, so this is the Table rule
// LIFTED rather than two shipped rules merged. The one shape the drafted
// GlobalTable spelling answered differently was a whitespace-only string, where
// a bare `Number('   ')` is 0 rather than NaN; the shared rule takes the
// REFUSING answer, since that is not a capacity anyone declared.

/**
 * The sentence every "did not resolve to a number" diagnostic ends with, so a
 * user whose value IS a number — `" 7 "`, `"1e1"` — learns why it was still
 * dropped (issue #3135). Named once because the three diagnostics that carry
 * it are worded per outcome and would otherwise each restate the grammar.
 */
const CFN_INTEGER_SPELLING_NOTE =
  ` CloudFormation types this member as an Integer and accepts only an optional sign ` +
  `and decimal digits (no surrounding whitespace, hex, exponent or decimal point), so a ` +
  `spelling it would reject is treated the same way.`;

/**
 * Build the {@link ThroughputDiagnostic} for a `WarmThroughput` block that did
 * not survive coercion intact, or `undefined` when it did.
 *
 * Two distinct outcomes, worded differently because the remedy differs:
 *  - PARTIAL — one member dropped, the other still sent. The call goes ahead;
 *    the user needs to know which half silently did not.
 *  - REFUSED — nothing sendable. No call is made for the property at all,
 *    which is the point (issue #1857 defect 3): forwarding the malformed block
 *    would surface as an AWS validation error that names neither cdkd nor the
 *    property.
 */
export function warmThroughputDiagnostic(
  raw: unknown,
  coercion: WarmThroughputCoercion,
  indexName: string | undefined
): ThroughputDiagnostic | undefined {
  if (raw === undefined || raw === null) return undefined;
  const scope = { kind: 'unresolved-member' as const, member: 'WarmThroughput' };
  const dropped = coercion.droppedMembers.join(' / ');
  if (coercion.spec) {
    if (coercion.droppedMembers.length === 0) return undefined;
    const kept = WARM_THROUGHPUT_MEMBERS.filter((m) => coercion.spec?.[m] !== undefined).join(
      ' / '
    );
    return {
      ...scope,
      ...(indexName !== undefined && { indexName }),
      message:
        `WarmThroughput.${dropped} did not resolve to a number and was DROPPED; ` +
        `${kept} is still sent. AWS types these as numbers, so a quoted "12000" is ` +
        `fine but an unresolved intrinsic or an object is not. The dropped member ` +
        `keeps its current AWS value until the template supplies a usable one.` +
        CFN_INTEGER_SPELLING_NOTE,
    };
  }
  return {
    ...scope,
    ...(indexName !== undefined && { indexName }),
    message:
      `WarmThroughput is declared but no member resolved to a number` +
      `${dropped ? ` (${dropped})` : ''}, so the whole block is REFUSED and not sent. ` +
      `Forwarding it would fail as an opaque AWS validation error naming neither cdkd ` +
      `nor the property. Set WarmThroughput.ReadUnitsPerSecond / WriteUnitsPerSecond to ` +
      `numbers, or remove the block. Nothing else about the index is affected.` +
      CFN_INTEGER_SPELLING_NOTE,
  };
}

// `isWarmThroughputDecrease` — the decrease guard issue #1857 asked for —
// lives in `../dynamodb-warm-throughput.ts` alongside the coercion. It is the
// SAME rule `AWS::DynamoDB::Table` shipped for issue #1768, adopted verbatim
// rather than re-derived: the GlobalTable draft was compared against it over
// every declared / mixed / equal / above / absent-live / unusable-live /
// empty-spec combination and agreed on all of them, so writing a second copy
// would have been pure drift risk on a three-clause fail-open rule whose
// measured AWS evidence lives in the shared header.

/**
 * What went wrong with ONE throughput member, reported by the module-level
 * pure translators rather than logged by them (issues #1428 / #1444).
 *
 * These helpers have five call sites (`create`, `addReplica`, the replica
 * modify action, and both sides of the GSI diff) and no logger, so they
 * COLLECT instead of logging — which is also what makes the desired /
 * previous asymmetry expressible: only the DESIRED-side call sites pass a
 * collector, so a garbage value already recorded in cdkd state cannot make
 * every subsequent deploy shout about a template the user never wrote.
 *
 * `message` is a finished sentence: the caller's only job is to pick a level
 * and prefix the resource. Building it here keeps the wording identical
 * across the five sites.
 */
export interface ThroughputDiagnostic {
  /**
   * `unresolved-member` — the template DECLARED the member but its value did
   * not coerce to a number (an unresolved `{Ref: …}`, an object, `''`). What
   * FOLLOWS from that differs by side, and the message says which: an
   * ON-DEMAND ceiling is SUPPRESSED (nothing is sent, the live AWS value is
   * left alone), while a PROVISIONED capacity CANNOT be — AWS requires a
   * concrete `ProvisionedThroughput` on a provisioned table and on every GSI
   * of one — so cdkd substitutes {@link DEFAULT_CAPACITY_UNITS} and says so
   * (issue #1511). The one provisioned exception is a replica's
   * `ProvisionedThroughputOverride`, whose absence means "inherit the source
   * table", so it suppresses like the on-demand side.
   *
   * `billing-mode-mismatch` — an explicitly SDK-shaped block contradicts the
   * table's billing mode (a `ProvisionedThroughput` on a PAY_PER_REQUEST
   * table or vice versa). AWS rejects both, so the block is dropped instead
   * of forwarded into a guaranteed 400.
   */
  readonly kind: 'unresolved-member' | 'billing-mode-mismatch';
  /** The index the member belongs to; absent for a table-level member. */
  readonly indexName?: string;
  /** The CFn / SDK member name, for the caller's own bookkeeping. */
  readonly member: string;
  /** Finished, user-facing sentence. */
  readonly message: string;
}

/**
 * Merge an explicitly-supplied, already-SDK-shaped throughput block over a
 * derived one, PER MEMBER (issue #1428).
 *
 * The CFn schema forbids `ProvisionedThroughput` / `OnDemandThroughput` /
 * `*ThroughputOverride` on `AWS::DynamoDB::GlobalTable`, so this only fires
 * for pre-#1387 cdkd state and hand-authored templates — but those ARE a
 * first-class cdkd surface (`cdkd import --migrate-from-cloudformation`), and
 * the pre-fix code forwarded such a block VERBATIM. Three defects followed, and fixing any subset leaves a
 * live one, which is why this helper does all three at once:
 *
 *  1. **Coercion.** The verbatim forward was the ONE path that skipped the
 *     numeric reader (`coerceCfnInteger` since issue #3135), so a
 *     stringly-typed CFn `"5"` reached the SDK unnormalized while every
 *     derived value was a number.
 *  2. **Per-member merge.** Whole-block replacement meant a PARTIAL explicit
 *     block SUPPRESSED valid derived siblings — an explicit
 *     `{MaxReadRequestUnits: 41}` discarded a perfectly good
 *     `WriteOnDemandThroughputSettings.MaxWriteRequestUnits` from the same
 *     template.
 *  3. **Billing gate.** That is the CALLER's job (it owns `billingMode`), but
 *     it only works because this helper never emits a block the caller did
 *     not ask for.
 *
 * WARN-AND-FALL-BACK, never throw. Three earlier designs are recorded on
 * issue #1428 and each was broken by the same lever: a present-but-
 * uncoercible member that THREW made a stack whose STATE carried the garbage
 * permanently undeployable (the helper also runs on `previousProperties`),
 * and throwing from the replica path threw AFTER `CreateTable` had already
 * committed a real table. So an uncoercible member is dropped, reported
 * through `diagnostics`, and the derived value stands in.
 *
 * Returns `undefined` when neither side contributes a single member — an
 * EMPTY block is not a safe stand-in, because AWS documents an empty
 * `ProvisionedThroughputOverride` / `OnDemandThroughputOverride` as "inherit
 * the source table's settings".
 */
export function mergeExplicitThroughputBlock<T>(
  explicit: Record<string, unknown> | undefined,
  derived: Partial<Record<keyof T & string, number>> | undefined,
  members: ReadonlyArray<keyof T & string>,
  diagnostics: ThroughputDiagnostic[] | undefined,
  context: { indexName?: string; blockName: string },
  // Trailing + identity-defaulted (issue #2178), matching the sibling
  // `dynamodb-table-provider.ts` convention: absent still means UNMASKED, so
  // every existing caller keeps compiling. The walk has to happen BEFORE the
  // `JSON.stringify` below, never after it: a provider's `properties` bag
  // arrives RESOLVED, so a `{{resolve:secretsmanager:...}}` member is already
  // plaintext here, and `JSON.stringify` escapes `"` / `\` / newlines out of
  // the finished line so a message-level mask can no longer find the needle.
  maskSecrets: MaskerFn = (text) => text
): T | undefined {
  const out: Record<string, number> = {};
  for (const member of members) {
    if (explicit && explicit[member] !== undefined) {
      const coerced = coerceCfnInteger(explicit[member]);
      if (coerced !== undefined) {
        out[member] = coerced;
        continue;
      }
      // Name what STANDS IN for the ignored member, when something does:
      // on an explicit-only shape (no CFn `*ProvisionedThroughputSettings`
      // block beside the SDK-shaped one) `reportUnresolvedProvisionedCapacity`
      // has no block to blame and never fires, so this line is the only place
      // the user learns that the derived default (5, on a PROVISIONED
      // capacity) went to AWS instead of the value they wrote.
      const standIn = derived?.[member];
      diagnostics?.push({
        kind: 'unresolved-member',
        ...(context.indexName !== undefined && { indexName: context.indexName }),
        member,
        message:
          `${context.blockName}.${member} is present but did not resolve to a number ` +
          `(${JSON.stringify(maskDeep(explicit[member], maskSecrets))?.slice(0, 80)}), so ` +
          (typeof standIn === 'number'
            ? `it was ignored and ${standIn} was sent instead. `
            : `it was ignored. `) +
          `This is usually an unresolved intrinsic; resolve it to a literal.` +
          CFN_INTEGER_SPELLING_NOTE,
      });
    }
    const derivedValue = derived?.[member];
    if (typeof derivedValue === 'number') out[member] = derivedValue;
  }
  return Object.keys(out).length > 0 ? (out as T) : undefined;
}

/**
 * Report a member the template DECLARED whose value did not coerce (#1444 A).
 *
 * The diagnostic has to be raised WHERE THE VALUE IS LOST — inside the
 * translation — not from the per-GSI reset gate in `update()`. That gate only
 * runs for an index the diff already classified `modified` AND only when a
 * previous ceiling happened to exist AND only when the billing mode did not
 * flip, so the very same template defect was silent in the two most likely
 * cases: a FIRST-TIME set (both translated sides lack the member, so the index
 * is not `modified` at all and the loop never runs) and a BILLING FLIP (the
 * gate short-circuits). The defect is identical in all three; only the
 * diagnostic was conditional.
 */
export function reportUnresolvedRawMember(
  rawValue: unknown,
  diagnostics: ThroughputDiagnostic[] | undefined,
  context: { indexName?: string; blockName: string; member: string },
  // See `mergeExplicitThroughputBlock` for why the mask goes INSIDE the
  // stringify rather than around the finished message (issue #2178).
  maskSecrets: MaskerFn = (text) => text
): void {
  if (!diagnostics) return;
  if (rawValue === undefined) return;
  // The FORWARDER's reader, not the guard's: a value this predicate calls
  // usable is one `toSdkGlobalSecondaryIndexes` / `collectTableOnDemandCeilings`
  // will actually send, so a padded `" 7 "` is reported here exactly because
  // it is dropped there (issue #3135).
  if (coerceCfnInteger(rawValue) !== undefined) return;
  diagnostics.push({
    kind: 'unresolved-member',
    ...(context.indexName !== undefined && { indexName: context.indexName }),
    member: context.member,
    message:
      `${context.blockName}.${context.member} is declared but did not resolve to a ` +
      `number (${JSON.stringify(maskDeep(rawValue, maskSecrets))?.slice(0, 80)}), so no ` +
      `throughput value was ` +
      `sent for it and the live AWS setting was left unchanged. This is usually an ` +
      `unresolved intrinsic; resolve it to a literal to apply the limit, or remove the ` +
      `property entirely to clear it.` +
      CFN_INTEGER_SPELLING_NOTE,
  });
}

/**
 * Which member of a `*ProvisionedThroughputSettings` block to blame when the
 * derivation came back `undefined` (issue #1511).
 *
 * The derivation reports only "no number", so the member is re-derived here in
 * the SAME order {@link deriveWriteCapacityUnits} / {@link deriveReadCapacityUnits}
 * / {@link pickAutoScalingCapacity} consult members — the literal first, then
 * the auto-scaling block's `source`-selected member. Reaching this function at
 * all means every one of them failed, so the first DECLARED one is the value
 * the user was trying to set.
 *
 * `relPath` is relative to the block, `''` meaning the block ITSELF is the
 * unusable value (a string / array / bare unresolved intrinsic, or an object
 * carrying no capacity member at all).
 *
 * Returns `undefined` for an ABSENT block: defaulting there is the documented
 * pre-existing behavior for a template that never asked for a capacity, and
 * warning about it would shout on every deploy of a table that is fine.
 */
function blameUnresolvedProvisionedMember(
  rawSettings: unknown,
  side: 'Read' | 'Write',
  source: CapacitySource
): { relPath: string; value: unknown } | undefined {
  if (rawSettings === undefined) return undefined;
  const settings = asRecord(rawSettings);
  if (!settings || isUnresolvedIntrinsicBlock(settings)) return { relPath: '', value: rawSettings };
  const literal = settings[`${side}CapacityUnits`];
  if (literal !== undefined) return { relPath: `${side}CapacityUnits`, value: literal };
  const autoKey = `${side}CapacityAutoScalingSettings`;
  const rawAutoScaling = settings[autoKey];
  if (rawAutoScaling === undefined) return { relPath: '', value: rawSettings };
  const autoScaling = asRecord(rawAutoScaling);
  if (!autoScaling || isUnresolvedIntrinsicBlock(autoScaling)) {
    return { relPath: autoKey, value: rawAutoScaling };
  }
  const order =
    source === 'seed' ? ['SeedCapacity', 'MinCapacity'] : ['MinCapacity', 'SeedCapacity'];
  for (const member of order) {
    const value = autoScaling[member];
    if (value !== undefined) return { relPath: `${autoKey}.${member}`, value };
  }
  return { relPath: autoKey, value: rawAutoScaling };
}

/**
 * Report a DECLARED provisioned capacity the template could not resolve — the
 * PROVISIONED twin of {@link reportUnresolvedRawMember} (issue #1511).
 *
 * The two sides need different wording because they have different outcomes,
 * which is exactly why #1503 deferred this half. An unreadable ON-DEMAND
 * ceiling is SUPPRESSED (nothing is sent, the live ceiling stands), so its
 * diagnostic says "nothing was sent". A provisioned table cannot suppress —
 * AWS requires `ProvisionedThroughput` on the table and on every GSI of it —
 * so the derivation falls through to {@link DEFAULT_CAPACITY_UNITS} and a
 * table the template explicitly sized is deployed at 5/5. That is a throttling
 * symptom days later rather than an error, which is what makes naming it here
 * worth a warning at all. The one provisioned site that CAN suppress is a
 * replica's `ProvisionedThroughputOverride` (absent = inherit the source
 * table), hence the `suppressed` outcome arm.
 *
 * Caller decides WHEN: only when the derivation returned `undefined` AND no
 * explicit SDK-shaped member is standing in for it, so the warning always
 * describes what actually reached AWS.
 */
export function reportUnresolvedProvisionedCapacity(
  rawSettings: unknown,
  side: 'Read' | 'Write',
  source: CapacitySource,
  outcome: { readonly appliedUnits: number } | { readonly suppressed: string },
  diagnostics: ThroughputDiagnostic[] | undefined,
  context: { indexName?: string; blockName: string },
  // See `mergeExplicitThroughputBlock` for why the mask goes INSIDE the
  // stringify rather than around the finished message (issue #2178).
  maskSecrets: MaskerFn = (text) => text
): void {
  if (!diagnostics) return;
  const blame = blameUnresolvedProvisionedMember(rawSettings, side, source);
  if (!blame) return;
  const path = blame.relPath ? `${context.blockName}.${blame.relPath}` : context.blockName;
  // Every substituting caller passes the default today, so the sentence names
  // it unconditionally; the value stays a parameter because it is what the
  // user has to recognize in `DescribeTable`, and hard-coding "5" here would
  // silently lie the day a caller substitutes something else.
  const consequence =
    'appliedUnits' in outcome
      ? `so cdkd sent ${outcome.appliedUnits} capacity units instead ` +
        `(its default — AWS requires a concrete provisioned capacity here, ` +
        `so there was nothing to suppress)`
      : outcome.suppressed;
  diagnostics.push({
    kind: 'unresolved-member',
    ...(context.indexName !== undefined && { indexName: context.indexName }),
    // The terminal member name — or, when the BLOCK itself is what could not be
    // read, the block's own last segment. Taken off `relPath` rather than the
    // joined path so a block name carrying dots
    // (`Replicas[local].GlobalSecondaryIndexes[].Read…Settings`) reports the
    // member it names, not the tail of its container chain.
    member: blame.relPath
      ? blame.relPath.slice(blame.relPath.lastIndexOf('.') + 1)
      : context.blockName.slice(context.blockName.lastIndexOf('.') + 1),
    message:
      `${path} is declared but did not resolve to a number ` +
      `(${JSON.stringify(maskDeep(blame.value, maskSecrets))?.slice(0, 80)}), ${consequence}. ` +
      `This is usually an ` +
      `unresolved intrinsic; resolve it to a literal to apply the capacity you declared.` +
      CFN_INTEGER_SPELLING_NOTE,
  });
}

/**
 * Derive a single WRITE capacity number from a CFn
 * `WriteProvisionedThroughputSettings` block.
 *
 * The `AWS::DynamoDB::GlobalTable` registry schema (verified 2026-08-09 via
 * `aws cloudformation describe-type`) declares this block with exactly ONE
 * member — `WriteCapacityAutoScalingSettings` — i.e. write capacity on a
 * GlobalTable is ALWAYS auto-scaled; there is no literal `WriteCapacityUnits`
 * (that is why CDK 2.244's `TableV2` rejects `Capacity.fixed()` for write).
 * `CreateTable` / `UpdateTable` still require a concrete starting number;
 * which member of the auto-scaling block supplies it is context-dependent
 * (`MinCapacity` on a create, `SeedCapacity` on a billing-mode flip) — see
 * {@link CapacitySource}, which `source` selects.
 *
 * A literal `WriteCapacityUnits` is still honored first: the CFn schema
 * forbids it, but hand-authored / imported templates, cdkd state written
 * before this helper existed and `readCurrentState`'s flat shape can carry it,
 * and honoring it is strictly more faithful than ignoring it. An in-place
 * change of it goes through {@link readTableCapacityChange}.
 *
 * `source` selects between the two contexts CloudFormation distinguishes —
 * see {@link CapacitySource}. Defaults to `'min'`, the common case.
 */
export function deriveWriteCapacityUnits(
  settings: Record<string, unknown> | undefined,
  source: CapacitySource = 'min'
): number | undefined {
  if (!settings) return undefined;
  const literal = coerceCfnInteger(settings['WriteCapacityUnits']);
  if (literal !== undefined) return literal;
  const autoScaling = asRecord(settings['WriteCapacityAutoScalingSettings']);
  if (!autoScaling) return undefined;
  return pickAutoScalingCapacity(autoScaling, source);
}

/**
 * Derive a single READ capacity number from a CFn
 * `ReadProvisionedThroughputSettings` block (both the per-replica shape,
 * which carries `ReadCapacityUnits` + `ReadCapacityAutoScalingSettings`, and
 * the GSI/table-level `GlobalReadProvisionedThroughputSettings` shape, which
 * carries only `ReadCapacityUnits`). Same {@link CapacitySource} precedence
 * as the write side.
 */
export function deriveReadCapacityUnits(
  settings: Record<string, unknown> | undefined,
  source: CapacitySource = 'min'
): number | undefined {
  if (!settings) return undefined;
  const literal = coerceCfnInteger(settings['ReadCapacityUnits']);
  if (literal !== undefined) return literal;
  const autoScaling = asRecord(settings['ReadCapacityAutoScalingSettings']);
  if (!autoScaling) return undefined;
  return pickAutoScalingCapacity(autoScaling, source);
}

/**
 * Which member of a CFn `*CapacityAutoScalingSettings` block supplies the
 * ONE concrete number `CreateTable` / `UpdateTable` needs (Issue #1435).
 *
 * CloudFormation does not use a fixed precedence here — it is
 * context-dependent, and `SeedCapacity` has a much narrower scope than the
 * `SeedCapacity ?? MinCapacity` chain cdkd used everywhere:
 *
 *  - `'min'` — a fresh `CREATE`, a new index, or any same-billing-mode
 *    edit. Live-verified against real AWS (stack `CdkdIssue1427Control`,
 *    us-east-1): a `TableV2` with `MinCapacity: 1 / SeedCapacity: 20`
 *    reached `CREATE_COMPLETE` with `WriteCapacityUnits: 1` at BOTH table
 *    and index level, and `NumberOfDecreasesToday: 0` ruled out a
 *    scale-down between create and read-back. `MinCapacity` / `MaxCapacity`
 *    are `Required: Yes` in the registry schema; `SeedCapacity` is not.
 *  - `'seed'` — ONLY the `PAY_PER_REQUEST -> PROVISIONED` billing flip,
 *    which is the single context AWS documents `SeedCapacity` for ("the
 *    table will use these provisioned values until CloudFormation creates
 *    the autoscaling policies you configured"). Falls back to
 *    `MinCapacity` when the template omits the seed.
 *
 * Taking the seed on create over-provisioned every autoscaled PROVISIONED
 * GlobalTable by the seed-to-min ratio — a silent billing symptom, not an
 * error. It was only safe-looking because `create()` registered no scaling
 * target at all (Issue #1419, fixed in the same change): the over-provision
 * was accidentally acting as headroom for the missing policy.
 */
export type CapacitySource = 'min' | 'seed';

/** Resolve a `*CapacityAutoScalingSettings` block to one number. */
function pickAutoScalingCapacity(
  autoScaling: Record<string, unknown>,
  source: CapacitySource
): number | undefined {
  const min = coerceCfnInteger(autoScaling['MinCapacity']);
  if (source === 'min') return min ?? coerceCfnInteger(autoScaling['SeedCapacity']);
  return coerceCfnInteger(autoScaling['SeedCapacity']) ?? min;
}

/**
 * The shape refusal for a present-but-NON-ARRAY `GlobalSecondaryIndexes`, or
 * `undefined` when the value is absent or an array.
 *
 * ONE predicate for the two places that ask: {@link toSdkGlobalSecondaryIndexes}
 * (which throws, or hands it to its replay downgrade) and `update()`'s
 * template-path pre-flight (issue #3740), so the refusal cannot be narrower or
 * wider than the downgrade it replaces on that path. The value is masked leaf
 * by leaf BEFORE `JSON.stringify` escapes anything (issue #2178).
 */
export function globalSecondaryIndexesShapeDetail(
  rawIndexes: unknown,
  maskSecrets: MaskerFn = (text) => text
): string | undefined {
  if (rawIndexes === undefined || Array.isArray(rawIndexes)) return undefined;
  return (
    `AWS::DynamoDB::GlobalTable GlobalSecondaryIndexes must be an array, got ` +
    `${typeof rawIndexes} (${JSON.stringify(maskDeep(rawIndexes, maskSecrets))?.slice(0, 200)}).`
  );
}
