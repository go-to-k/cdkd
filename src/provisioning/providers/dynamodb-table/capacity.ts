import type {
  OnDemandThroughput,
  ProvisionedThroughput,
  ProvisionedThroughputDescription,
} from '@aws-sdk/client-dynamodb';
import { coerceCfnInteger } from '../../config-shape.js';
import { toFiniteNumber } from '../../dynamodb-warm-throughput.js';
import type { SecretMasker } from '../../../types/resource.js';
import { isPlainCapacityBlock } from './table-helpers.js';

/**
 * The two `ProvisionedThroughput` members, in the order the forwarders build
 * them. Named once so {@link hasUsableTableCapacity}, {@link tableCapacityForSend}
 * and the per-INDEX create forwarder
 * ({@link DynamoDBTableProvider.coerceIndexCapacityBlock}) cannot come to
 * disagree about the membership.
 *
 * Deliberately NOT `TABLE_CAPACITY_MEMBERS` any more (issue
 * [#3255](https://github.com/go-to-k/cdkd/issues/3255)): CloudFormation's
 * `ProvisionedThroughput` block has the same two members at the TABLE level and
 * inside every `GlobalSecondaryIndexes[]` entry, and a second list for the
 * per-index reader would be exactly the drift this constant exists to prevent.
 * What differs between the two levels is what an ABSENT member does — the table
 * level substitutes {@link DEFAULT_TABLE_CAPACITY_UNITS}, the per-index level
 * deliberately has no default ({@link readCapacityNumber}) — and that is a
 * property of each forwarder, not of the membership.
 */
export const PROVISIONED_CAPACITY_MEMBERS = ['ReadCapacityUnits', 'WriteCapacityUnits'] as const;

/**
 * The two `OnDemandThroughput` members, named once for the same reason
 * {@link PROVISIONED_CAPACITY_MEMBERS} is (issue
 * [#3265](https://github.com/go-to-k/cdkd/issues/3265)). CloudFormation's
 * `OnDemandThroughput` block carries the same two members at the TABLE level
 * and inside every `GlobalSecondaryIndexes[]` entry, and all FOUR send sites
 * read them through
 * {@link DynamoDBTableProvider.coerceOnDemandCeilingsForSend}.
 *
 * Both are `Long` in the SDK model and BOTH ARE OPTIONAL — the property that
 * makes this block's drop decision differ from its `ProvisionedThroughput`
 * sibling's. See {@link DynamoDBTableProvider.warnUnusableOnDemandCeiling}.
 */
export const ON_DEMAND_CEILING_MEMBERS = ['MaxReadRequestUnits', 'MaxWriteRequestUnits'] as const;

/**
 * Narrow ONE `OnDemandThroughput` block to exactly what cdkd puts on the wire,
 * and report the members that were DROPPED (issue
 * [#3287](https://github.com/go-to-k/cdkd/issues/3287)).
 *
 * The ONE spelling of that transform, and that is the whole reason it is a
 * module-level PURE function rather than a method: two callers need the same
 * answer and one of them may not log.
 *
 *  - {@link DynamoDBTableProvider.coerceOnDemandCeilingsForSend} — the WIRE, at
 *    all six send sites, which announces each `dropped` member;
 *  - {@link DynamoDBTableProvider.indexCeilingForSend}'s per-index change
 *    detector, which compares the desired and recorded blocks and must not warn
 *    (the warning is the send's, one line further down, and a detector that
 *    announced would fire on a comparison that emits no op at all).
 *
 * Behaviour is BYTE-identical to what `coerceOnDemandCeilingsForSend` did
 * inline before issue [#3287](https://github.com/go-to-k/cdkd/issues/3287),
 * including the two identity properties its callers
 * depend on: a block that is not a plain object comes back AS ITSELF (AWS names
 * the shape), and a block needing no rewrite comes back by IDENTITY, so
 * {@link DynamoDBTableProvider.coerceIndexThroughputForCreate} can still tell
 * "unchanged" from "rewritten" without a structural compare. A member name the
 * grammar does not know is preserved untouched, the same fail-open direction.
 *
 * `dropped` carries the RAW declared value beside each member name because the
 * warning interpolates it, and only the masking caller may do that.
 */
export function narrowOnDemandCeilings(declared: unknown): {
  block: unknown;
  dropped: ReadonlyArray<{ member: string; raw: unknown }>;
} {
  if (!isPlainCapacityBlock(declared)) return { block: declared, dropped: [] };
  const block = declared;
  let rewritten: Record<string, unknown> | undefined;
  const dropped: Array<{ member: string; raw: unknown }> = [];
  for (const member of ON_DEMAND_CEILING_MEMBERS) {
    if (!(member in block)) continue;
    const coerced = coerceCfnInteger(block[member]);
    // Already the exact integer cdkd would send: leave the key alone, so a
    // numeric template rebuilds nothing.
    //
    // `&& coerced !== undefined` is the go-to-k/cdkd#3380 round-3 review's C5:
    // a key PRESENT with an `undefined` value satisfies `member in block` and
    // coerces to `undefined`, so the identity short-circuit kept it -- leaving a
    // member the SDK serializes away, with nothing dropped and nothing warned.
    // Falling through sends it to the drop arm, where it is announced like any
    // other unusable spelling.
    if (coerced === block[member] && coerced !== undefined) continue;
    rewritten ??= { ...block };
    if (coerced === undefined) {
      dropped.push({ member, raw: block[member] });
      delete rewritten[member];
    } else {
      rewritten[member] = coerced;
    }
  }
  return { block: rewritten ?? block, dropped };
}

/**
 * The shape of an `OnDemandThroughput` ceiling member the template path
 * REFUSES, or `undefined` when the member is sendable or is one of the drop
 * shapes deliberately left to {@link narrowOnDemandCeilings} (issue
 * [#3286](https://github.com/go-to-k/cdkd/issues/3286)).
 *
 * A member {@link narrowOnDemandCeilings} drops used to be WARNED and omitted,
 * and since both members are SDK-optional the call SUCCEEDED: AWS held no
 * maximum (or kept the old one) while state recorded the declared spelling,
 * so `cdkd drift` reported it forever. Refusing before any call removes that
 * disagreement at its source, and it is CloudFormation parity: CloudFormation
 * refuses the same template, so no template it deploys stops deploying here.
 *
 * Refused only where that rejection is EVIDENCED. The DynamoDB Integer grammar
 * was measured on `ProvisionedThroughput.ReadCapacityUnits` of this type
 * (issue #3135, table on `toCfnInteger` in `../dynamodb-warm-throughput.ts`):
 * padded, hex, exponent and decimal-point strings are rejected. `null` and
 * booleans were measured rejected on `AWS::Logs::LogGroup`'s Integer, and an
 * array or object fails the schema's `integer` type outright.
 *
 * NOT refused, and still dropped with the warning, because CloudFormation may
 * ACCEPT them:
 *  - a blank string — measured as "property absent" on the OPTIONAL Logs
 *    Integer, and both ceiling members are optional;
 *  - an integer outside JavaScript's safe range — a valid `Long`, which cdkd
 *    cannot carry exactly;
 *  - a key holding `undefined`, which no template spells (`AWS::NoValue`
 *    removes the key).
 *
 * The returned shape names the TYPE only, never the value: the member arrives
 * resolved and may carry a secret.
 */
export function refusedOnDemandCeilingShape(value: unknown): string | undefined {
  if (value === undefined || coerceCfnInteger(value) !== undefined) return undefined;
  if (typeof value === 'string') {
    if (value.trim() === '' || /^[+-]?\d+$/.test(value)) return undefined;
    return 'a string';
  }
  if (typeof value === 'number') {
    return Number.isInteger(value) ? undefined : 'a number that is not an integer';
  }
  if (value === null) return 'null';
  if (typeof value === 'boolean') return 'a boolean';
  if (Array.isArray(value)) return 'an array';
  return 'an object';
}

/**
 * The template-path pre-flight refusal for an `OnDemandThroughput` ceiling
 * member CloudFormation rejects (issue
 * [#3286](https://github.com/go-to-k/cdkd/issues/3286)), at the TABLE level and
 * in every `GlobalSecondaryIndexes[]` entry, or `undefined`.
 *
 * `previousProperties` is the recorded bag on `update()` and `undefined` on
 * `create()`, where every position is sent. On an update a position is checked
 * only when its block is a PENDING send: the table-level block when it differs
 * from the recorded one (the send's own gate), an index when it is new to the
 * record or its block differs. An unchanged block sends nothing, so refusing it
 * would fail a deploy that applies nothing for it — the gate this file's other
 * update-path refusals take.
 *
 * A block that is not a plain object is not checked: it is forwarded verbatim
 * for AWS to reject by shape, as before. The index is named by POSITION only,
 * for the reason `INDEX_CONTRIBUTOR_INSIGHTS_PATH` gives.
 */
export function onDemandCeilingRefusal(
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown> | undefined,
  logicalId: string
): string | undefined {
  const blockRefusal = (block: unknown, path: string): string | undefined => {
    if (!isPlainCapacityBlock(block)) return undefined;
    for (const member of ON_DEMAND_CEILING_MEMBERS) {
      if (!Object.hasOwn(block, member)) continue;
      const shape = refusedOnDemandCeilingShape(block[member]);
      if (shape === undefined) continue;
      return (
        `AWS::DynamoDB::Table ${logicalId}: ${path}.${member} must be an Integer ` +
        `CloudFormation accepts — an optional sign and decimal digits, with no surrounding ` +
        `whitespace, hex, exponent or decimal point; -1 removes an existing maximum ` +
        `(got ${shape}). CloudFormation refuses the same template`
      );
    }
    return undefined;
  };
  const changed = (desired: unknown, recorded: unknown): boolean =>
    JSON.stringify(desired) !== JSON.stringify(recorded);

  if (
    previousProperties === undefined ||
    changed(properties['OnDemandThroughput'], previousProperties['OnDemandThroughput'])
  ) {
    const refusal = blockRefusal(properties['OnDemandThroughput'], 'OnDemandThroughput');
    if (refusal !== undefined) return refusal;
  }

  const desiredIndexes = properties['GlobalSecondaryIndexes'];
  if (!Array.isArray(desiredIndexes)) return undefined;
  // Keyed exactly as `applyGsiUpdates` keys `prevByName`: truthy names only.
  const previousByName = new Map<unknown, Record<string, unknown>>();
  const previousIndexes = previousProperties?.['GlobalSecondaryIndexes'];
  if (Array.isArray(previousIndexes)) {
    for (const entry of previousIndexes as unknown[]) {
      if (isPlainCapacityBlock(entry) && entry['IndexName']) {
        previousByName.set(entry['IndexName'], entry);
      }
    }
  }
  for (const [position, entry] of (desiredIndexes as unknown[]).entries()) {
    if (!isPlainCapacityBlock(entry)) continue;
    if (previousProperties !== undefined) {
      const previous = previousByName.get(entry['IndexName']);
      if (
        previous !== undefined &&
        !changed(entry['OnDemandThroughput'], previous['OnDemandThroughput'])
      ) {
        continue;
      }
    }
    const refusal = blockRefusal(
      entry['OnDemandThroughput'],
      `GlobalSecondaryIndexes[${position}].OnDemandThroughput`
    );
    if (refusal !== undefined) return refusal;
  }
  return undefined;
}

/**
 * Does the ceiling AWS currently holds for a GSI already cover every member
 * cdkd is about to send? (issue
 * [#3287](https://github.com/go-to-k/cdkd/issues/3287))
 *
 * The `OnDemandThroughput` twin of {@link liveCapacityAlreadyMatches}, and it
 * exists for the same #1630 reason: cdkd writes state only after `update()`
 * RETURNS, so a ceiling op that already LANDED before a later step threw is
 * unrecorded and the next deploy re-emits it. Consulting what AWS holds is what
 * lets the deploy converge instead.
 *
 * Compared PER MEMBER over the members being SENT, deliberately, and it differs
 * from the capacity sibling in exactly that: omitting a ceiling member KEEPS
 * whatever maximum the table already carries (only an explicit `-1` removes
 * one), so a member cdkd is not sending says nothing about whether the call is
 * redundant. A live member the request does not carry is therefore ignored.
 *
 * Anything unreadable on EITHER side fails OPEN (the op is still emitted): an
 * absent live block — which is also what `DescribeTable` reports for a
 * PROVISIONED table, where the numbers do not exist — an absent live member, a
 * value that is not a number. That is the correct direction: the worst case is
 * the pre-fix behaviour of emitting the op, whereas a false MATCH would
 * silently drop a ceiling change the user asked for.
 *
 * **What AWS does with a repeated identical ceiling is UNMEASURED**, and this
 * guard is written so that it does not matter: it withholds only a call that
 * would change nothing. If DynamoDB rejects the repeat the way it rejects a
 * repeated provisioned capacity ("The provisioned throughput for the index X
 * will not change"), the guard is what keeps the deploy from wedging; if it
 * accepts it, the guard saves a call and a full index-ACTIVE wait. Measuring it
 * would sharpen the doc, not the code.
 */
export function liveCeilingAlreadyMatches(
  live: OnDemandThroughput | undefined,
  requested: Record<string, unknown>
): boolean {
  if (live === undefined) return false;
  const liveBag = live as unknown as Record<string, unknown>;
  let compared = 0;
  for (const member of ON_DEMAND_CEILING_MEMBERS) {
    if (!(member in requested)) continue;
    const want = toFiniteNumber(requested[member]);
    const have = toFiniteNumber(liveBag[member]);
    if (want === undefined || have === undefined || want !== have) return false;
    compared += 1;
  }
  // Nothing comparable was sent: say NO rather than vacuously YES, so an
  // unreadable request still reaches AWS and is named there.
  return compared > 0;
}

/**
 * Is this per-index capacity AWS's on-demand `{0, 0}` placeholder — BOTH
 * members resolving to 0 through {@link toFiniteNumber}, so a string-spelled
 * `{'0', '0'}` counts and a half-zero `{0, 7}` does not?
 *
 * The ONE predicate behind both answers to that value on the UPDATE path: the
 * template-path pre-flight refusal ({@link zeroCapacityIndexRefusal}) and the
 * warn-skip the two non-template callers still take
 * (`DynamoDBTableProvider.skipZeroCapacityIndexUpdate`). Sharing it is what
 * keeps the refusal from being narrower or wider than the skip it replaces on
 * the template path.
 */
export function isZeroCapacityPlaceholder(requested: ProvisionedThroughput | undefined): boolean {
  if (requested === undefined || requested === null || typeof requested !== 'object') return false;
  return (
    toFiniteNumber(requested.ReadCapacityUnits) === 0 &&
    toFiniteNumber(requested.WriteCapacityUnits) === 0
  );
}

/**
 * The template-path pre-flight refusal for a per-index `ProvisionedThroughput`
 * of `{0, 0}` (issue [#3728](https://github.com/go-to-k/cdkd/issues/3728)), or
 * `undefined` when no index would reach `applyGsiUpdates`' capacity arms
 * carrying one.
 *
 * SCOPE, matched to what those arms act on rather than to every entry that
 * holds the value. An index is named only when its capacity is a PENDING
 * operation: it is absent from the recorded previous side (a new index, or the
 * adopted-index arm), or its `ProvisionedThroughput` differs from the recorded
 * one (the same-name arm's own change test, `JSON.stringify` against
 * `JSON.stringify`). A steady-state template that has always carried the
 * placeholder emits no capacity op, so refusing it would fail a deploy that
 * sends nothing — the same gate the `StreamSpecification` refusal takes.
 *
 * Wider than the skip in ONE direction, deliberately: a brand-new index, whose
 * `Create` action never consulted the skip and sent `{0, 0}` for AWS to reject
 * AFTER the tag diff and any billing flip had landed. Refusing it here trades
 * that half-applied failure for one that applied nothing.
 */
export function zeroCapacityIndexRefusal(
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>,
  logicalId: string,
  maskSecrets: SecretMasker
): string | undefined {
  const asEntries = (value: unknown): Array<Record<string, unknown>> =>
    (Array.isArray(value) ? (value as unknown[]) : []).filter(
      (entry): entry is Record<string, unknown> =>
        entry !== null && typeof entry === 'object' && !Array.isArray(entry)
    );
  // Keyed exactly as `applyGsiUpdates` keys `prevByName`: truthy names only.
  const previousByName = new Map<unknown, Record<string, unknown>>();
  for (const entry of asEntries(previousProperties['GlobalSecondaryIndexes'])) {
    if (entry['IndexName']) previousByName.set(entry['IndexName'], entry);
  }
  const offending = asEntries(properties['GlobalSecondaryIndexes'])
    .filter((entry) => Boolean(entry['IndexName']))
    .filter((entry) =>
      isZeroCapacityPlaceholder(entry['ProvisionedThroughput'] as ProvisionedThroughput | undefined)
    )
    .filter((entry) => {
      const previous = previousByName.get(entry['IndexName']);
      return (
        previous === undefined ||
        JSON.stringify(previous['ProvisionedThroughput']) !==
          JSON.stringify(entry['ProvisionedThroughput'])
      );
    })
    // A RESOLVED property value, masked raw so a name below
    // `MIN_NEEDLE_LENGTH` still reaches the whole-value arm; a numeric name
    // renders as the literal `indexScopeAt` uses.
    .map((entry) =>
      typeof entry['IndexName'] === 'string' ? maskSecrets(entry['IndexName']) : '<unnamed>'
    );
  if (offending.length === 0) return undefined;
  return (
    `AWS::DynamoDB::Table ${logicalId}: GlobalSecondaryIndexes ${offending.join(', ')} declare ` +
    `ProvisionedThroughput {ReadCapacityUnits: 0, WriteCapacityUnits: 0}, which is AWS's ` +
    `on-demand placeholder rather than a capacity DynamoDB accepts (the minimum is 1). Declare ` +
    `a capacity of at least 1, or remove the per-index ProvisionedThroughput on a ` +
    `PAY_PER_REQUEST table. Nothing was applied to the table`
  );
}

/**
 * The sentinel DynamoDB accepts to CLEAR an on-demand request-unit maximum
 * (issue [#3373](https://github.com/go-to-k/cdkd/issues/3373)).
 *
 * LIVE-VERIFIED at BOTH positions this file sends from, which is what makes it
 * implementable at both at once rather than at one and not the other:
 *
 *  - `UpdateTable.OnDemandThroughput` — AWS's own SDK model doc for the block,
 *    and the measurement recorded on issue
 *    [#1434](https://github.com/go-to-k/cdkd/issues/1434) (us-east-1 +
 *    us-west-2, 2026-08-09), which probed the SINGLE-member shape this file
 *    also sends: `{MaxWriteRequestUnits: -1}` against a live `{100, 100}` was
 *    accepted and read back as `{MaxReadRequestUnits: 100}`;
 *  - `UpdateTable.GlobalSecondaryIndexUpdates[].Update.OnDemandThroughput` —
 *    the position issue #3373's body called UNMEASURED. It is not, and the
 *    evidence is in TWO places, named separately because a reviewer checked
 *    and one of them is not where an earlier draft of this said it was:
 *    issue [#1423](https://github.com/go-to-k/cdkd/issues/1423)'s comment
 *    thread carries the `{-1, -1}` transcript (us-east-1, 2026-08-09,
 *    throwaway table) — ACCEPTED, with `DescribeTable` then reporting the
 *    block ABSENT — and PR
 *    [#1433](https://github.com/go-to-k/cdkd/pull/1433)'s body carries the
 *    MIXED `keep 50 / reset -1` probe at the same position, re-run precisely
 *    because only `{-1, -1}` had been verified. `dynamodb-globaltable-provider.ts`
 *    has shipped on both since. #3373's dup-check dismissed those issues
 *    because `AWS::DynamoDB::GlobalTable` spells its per-GSI ceilings
 *    `Write` / `ReadOnDemandThroughputSettings` — true of the TEMPLATE and
 *    irrelevant to the WIRE, where both providers send the same
 *    `UpdateGlobalSecondaryIndexAction.OnDemandThroughput`.
 *
 * The read-back is ABSENCE, never `-1`, at both positions — so nothing on the
 * drift / `readCurrentState` side may expect this value.
 */
export const ON_DEMAND_LIMIT_RESET = -1;

/**
 * Which `OnDemandThroughput` members this update must explicitly REMOVE, as a
 * list of member names (issue #3373).
 *
 * An absent member KEEPS whatever maximum the table already carries, so a
 * template edit that drops a ceiling used to deploy GREEN, be recorded as
 * applied, and leave the live maximum in force forever — the #1160
 * absent-field-reset class, one level down inside a nested block.
 *
 * PER MEMBER, never per BLOCK: read and write maxima are independent template
 * values, so a whole-block branch would drop the single-member removal, which
 * is the likelier user edit (the `AWS::DynamoDB::GlobalTable` twin paid for
 * that once already).
 *
 * FOUR conditions, all necessary, each closing a different way this goes
 * wrong:
 *
 *  1. **the PREVIOUS side declared it AND it survived narrowing.**
 *     `previousProperties` is a cdkd STATE record and the record is RAW — it
 *     holds the spelling the TEMPLATE declared, including a member
 *     {@link narrowOnDemandCeilings} REFUSED and cdkd therefore never sent. A
 *     raw presence test would read such a member as "previously applied".
 *  2. **the DESIRED side does not declare it AT ALL, raw.** This is issue
 *     [#1440](https://github.com/go-to-k/cdkd/issues/1440) exactly: a member
 *     the grammar rejected is the template TRYING to SET a ceiling, and taking
 *     the reset branch for it would silently CLEAR the ceiling being set. The
 *     narrowed desired side cannot tell those apart; the raw one can.
 *  3. **AWS actually HOLDS the member right now.** It proves there is a maximum
 *     to remove, and it makes the whole rule fail CLOSED when cdkd holds no
 *     live snapshot — the correct direction for a send that DESTROYS a live
 *     value.
 *  4. **this update leaves the table on PAY_PER_REQUEST** (`ceilingsSendable`).
 *     Condition 3 does NOT subsume this, and believing it did was a BLOCKER on
 *     PR go-to-k/cdkd#3401 (spec review, M0). The live snapshot is the ONE
 *     `DescribeTable` at the top of `update()` and is never refreshed, while
 *     both removal arms run AFTER the BillingMode flip — so on a template that
 *     flips a live on-demand table to PROVISIONED **and** drops the ceiling,
 *     the pre-flight refusals both decline (neither side DECLARES a ceiling),
 *     the flip lands, and the stale snapshot then says the member is live: cdkd
 *     would send `-1` to a now-PROVISIONED table, AWS would reject it, and a
 *     previously-green no-op becomes a HALF-APPLIED deploy — the exact class
 *     the #3392 pre-flight exists to prevent. `dynamodb-globaltable-provider.ts`
 *     carries the same guard at both of its positions
 *     (`onDemandCeilingLive` / `!billingFlipped`), named in PR
 *     go-to-k/cdkd#1433's body as "skipped on a billing flip".
 *
 *     What the skip COSTS was asked and MEASURED, not assumed (the
 *     go-to-k/cdkd#3401 code review raised it; issue
 *     [#1441](https://github.com/go-to-k/cdkd/issues/1441) had already
 *     settled it). The worry is a round trip: deploy A sets a ceiling on a
 *     PAY_PER_REQUEST table, deploy B flips to PROVISIONED and drops it (the
 *     reset suppressed here), deploy C flips back declaring nothing — and
 *     since deploy B's template is now the previous side, condition 1 can
 *     never fire again, so a RETAINED ceiling would be unclearable. #1441's
 *     probe (us-east-1, 2026-08-10, transcript on the issue) ran exactly that
 *     sequence at the TABLE level: `DescribeTable` reports the block ABSENT
 *     after the flip, and it does NOT come back on the flip home. Nothing is
 *     stranded. The PER-INDEX round trip is not separately measured — issue
 *     [#3403](https://github.com/go-to-k/cdkd/issues/3403) — but it fails in
 *     the SAFE direction (a lingering maximum, never a destroyed one).
 *
 * Every member-presence test here is `Object.hasOwn`, not `in` (the
 * go-to-k/cdkd#3401 security review). `in` walks the prototype chain, and these
 * three tests gate a DESTRUCTIVE send off a cdkd STATE record — the own-key
 * convention `drift.ts`'s `hasOwnKey` / `ownValue` already follow for
 * state-derived bags (issue go-to-k/cdkd#2899). Not demonstrably reachable
 * today; the point is that the guard on a destroying path should not depend on
 * that staying true.
 *
 * `declared` present but NOT a plain block (a string, an array, an unresolved
 * intrinsic) yields NO removals: that value is forwarded VERBATIM for AWS to
 * reject by shape, and merging a sentinel into it is not expressible.
 *
 * And a declared block cdkd cannot READ AT ALL yields none either — a plain
 * object with no member surviving {@link narrowOnDemandCeilings}, i.e. only
 * rejected spellings or only names the grammar does not know (`{Ref: 'Unset'}`,
 * a mis-nested value). That is condition 2 one level up: such a block is not a
 * statement that the sibling member was REMOVED, it is a template cdkd could
 * not read, and clearing a live maximum on the strength of it is the same
 * destruction #1440 describes. An ABSENT desired side is the opposite and is
 * the headline case — nothing declared means nothing kept.
 */
export function onDemandCeilingRemovals(
  declared: unknown,
  previous: unknown,
  live: OnDemandThroughput | undefined,
  ceilingsSendable: boolean
): string[] {
  if (!ceilingsSendable) return [];
  if (live === undefined) return [];
  // ONLY an ABSENT key is the removal statement. Anything PRESENT -- including
  // a bare `OnDemandThroughput:` YAML key, which resolves to `null` -- must be
  // a plain block carrying a surviving member before a sibling counts as
  // removed (go-to-k/cdkd#3401 code review, finding 4). An earlier cut routed
  // `null` to the ABSENT arm, which made `OnDemandThroughput:` clear a live
  // ceiling while `{}` did not; a declared-but-unreadable value is a template
  // cdkd could not read, not an instruction to destroy a maximum, and the
  // asymmetry had no stated reason.
  if (declared !== undefined && !isPlainCapacityBlock(declared)) return [];
  const previousBlock = narrowOnDemandCeilings(previous).block;
  if (!isPlainCapacityBlock(previousBlock)) return [];
  const declaredBlock = isPlainCapacityBlock(declared) ? declared : undefined;
  if (declaredBlock !== undefined) {
    const declaredSurvivors = narrowOnDemandCeilings(declaredBlock).block;
    if (
      !isPlainCapacityBlock(declaredSurvivors) ||
      !ON_DEMAND_CEILING_MEMBERS.some((member) => Object.hasOwn(declaredSurvivors, member))
    ) {
      return [];
    }
  }
  const liveBag = live as unknown as Record<string, unknown>;
  const removals: string[] = [];
  for (const member of ON_DEMAND_CEILING_MEMBERS) {
    if (!Object.hasOwn(previousBlock, member)) continue;
    if (declaredBlock !== undefined && Object.hasOwn(declaredBlock, member)) continue;
    if (toFiniteNumber(liveBag[member]) === undefined) continue;
    removals.push(member);
  }
  return removals;
}

/**
 * Merge the {@link onDemandCeilingRemovals} sentinels into a block bound for
 * the wire (issue #3373).
 *
 * A COPY, never a mutation of `block`: {@link narrowOnDemandCeilings} returns
 * its input BY IDENTITY when nothing needed rewriting, so mutating here would
 * write `-1` into the caller's own `properties` bag — which the engine then
 * records as state.
 */
export function withOnDemandCeilingRemovals(block: unknown, removals: readonly string[]): unknown {
  if (removals.length === 0) return block;
  const base = isPlainCapacityBlock(block) ? block : {};
  const merged: Record<string, unknown> = { ...base };
  for (const member of removals) merged[member] = ON_DEMAND_LIMIT_RESET;
  return merged;
}

/**
 * The capacity both TABLE-level forwarders substitute for a member the
 * template does not declare at all — `create()`'s `CreateTable` and the
 * BillingMode flip's `UpdateTable`. It is the pre-issue-#3147 `?? 5`, kept
 * BYTE-identical in behaviour for the absent case; what changed is only what a
 * DECLARED-but-unusable member does.
 */
export const DEFAULT_TABLE_CAPACITY_UNITS = 5;

/**
 * Whether the desired TABLE-level `ProvisionedThroughput` is one the flip can
 * actually send (issue #1617 PR review).
 *
 * Deliberately NOT {@link hasUsableDeclaredCapacity}: the flip defaults each
 * ABSENT member to 5 ({@link tableCapacityForSend}), so a half-declared TABLE
 * capacity is sendable while a half-declared per-INDEX one is not.
 *
 * It mirrors the flip's GATE as well as its arithmetic, which the first version
 * did not and a second review round caught — both halves of that miss are real:
 *
 * - the gate is plain TRUTHINESS (`properties['ProvisionedThroughput']`), so a
 *   non-object truthy value sends `{5, 5}` and SUCCEEDS. Requiring a plain
 *   object refused it and skipped a removal that would have been fine.
 * - a DECLARED member that coerces to `0` (`0`, `'0'`) is a capacity AWS
 *   rejects (below 1), which is precisely the deterministic rejection this
 *   predicate exists to keep a delete from running ahead of.
 *
 * It reads through {@link tableCapacityForSend}'s OWN reader since issue
 * [#3147](https://github.com/go-to-k/cdkd/issues/3147) — `coerceCfnInteger`,
 * plus the `< 1` rule AWS adds on top of the grammar — so the two cannot
 * answer differently. On the pre-#3147 `Number()` reader they DID, in both
 * directions: a padded `" 7 "` counted as usable here while the forwarder now
 * drops it, and a DECLARED `null` counted as UNUSABLE here while the
 * forwarder's `?? 5` sent 5 and AWS accepted the flip — so this predicate
 * refused a pre-flip removal on a flip that would have succeeded, warning that
 * "AWS rejects the flip either way" when it does not. `null` therefore takes
 * the ABSENT arm here, exactly as it does at the forwarder; `''` / `false` /
 * `[]`, which `Number()` read as **0**, are now dropped-and-named by the
 * forwarder, so they make the flip fail and stay UNUSABLE here.
 */
export function hasUsableTableCapacity(value: unknown): boolean {
  // Falsy: the flip sends no throughput at all and AWS rejects the mode change.
  if (!value) return false;
  if (typeof value !== 'object' || Array.isArray(value)) return true;
  const pt = value as Record<string, unknown>;
  // Each member the template DECLARES has to be a capacity AWS accepts; an
  // absent one takes the flip's own default and is fine.
  for (const member of PROVISIONED_CAPACITY_MEMBERS) {
    const raw = pt[member];
    if (raw === undefined || raw === null) continue;
    const n = coerceCfnInteger(raw);
    if (n === undefined || n < 1) return false;
  }
  return true;
}

/**
 * Read one TABLE-level `ProvisionedThroughput` member for the wire (issue
 * [#3147](https://github.com/go-to-k/cdkd/issues/3147)).
 *
 * THREE answers, where the pre-#3147 `Number(pt[member] ?? 5)` had two:
 *
 *  - ABSENT (`undefined` / `null`, matching `??`) -> the
 *    {@link DEFAULT_TABLE_CAPACITY_UNITS} default, silently, exactly as before.
 *  - a value {@link coerceCfnInteger} accepts -> that integer.
 *  - anything else -> `undefined`, i.e. the member is OMITTED from the request,
 *    and `onUnusable` announces it.
 *
 * The third answer is the decision this function exists for, and it is NOT the
 * announced-default one its `AWS::DynamoDB::GlobalTable` sibling takes. Two
 * reasons, both local to this type:
 *
 *  - **This file's own precedent for the table-level capacity is "let AWS
 *    reject it, by name".** A flip to PROVISIONED carrying NO
 *    `ProvisionedThroughput` at all is deliberately left to fail at AWS as CFn
 *    parity (see the comment at that gate), and the per-index arm below refuses
 *    to invent a capacity in even stronger terms. Substituting 5 for a
 *    DECLARED `" 7 "` would be the one place this type guesses.
 *  - **A substituted capacity is invisible afterwards.** State records the
 *    DESIRED bag, so a table created at 5 against a recorded `" 7 "` compares
 *    EQUAL on every later `cdkd diff`: the divergence never surfaces and the
 *    warning scrolls past once. Omitting the member fails the deploy with
 *    DynamoDB naming the member, which is also what CloudFormation does with
 *    this template (it refuses it at properties validation).
 *
 * `onUnusable` is called at most once per member and never for the absent case,
 * so an ordinary template is silent.
 */
export function tableCapacityForSend(
  pt: Record<string, unknown> | undefined,
  member: (typeof PROVISIONED_CAPACITY_MEMBERS)[number],
  onUnusable: (member: string, raw: unknown) => void
): number | undefined {
  const raw = pt?.[member];
  if (raw === undefined || raw === null) return DEFAULT_TABLE_CAPACITY_UNITS;
  const coerced = coerceCfnInteger(raw);
  if (coerced === undefined) {
    onUnusable(member, raw);
    return undefined;
  }
  return coerced;
}

// `capacityNumber` — a capacity member, or `undefined` when the value is not a
// usable number — is now {@link toFiniteNumber}, imported from
// `../dynamodb-warm-throughput.ts`. It was BYTE-identical to that module's own
// member parser, and near-identical to `dynamodb-globaltable-provider.ts`'s
// third copy, so the review of issue #1857's PR collapsed the three into one
// spelling; nothing about the rule changed. The rule, restated because it is
// what the copies kept getting right by luck: `Number()` alone is not good
// enough, since `Number(null)`, `Number('')`, `Number([])`, `Number(false)` and
// `Number('   ')` are all **0** rather than `NaN`, so a live `0` would compare
// EQUAL to a desired `null` / `''` / `[]` / `false` and suppress the call. A
// YAML-borne numeric STRING is still accepted, because that is a real template
// shape and `'5'` genuinely means 5.

/**
 * Does the capacity AWS currently holds for a GSI already equal the pair the
 * template requests? (issue #1630)
 *
 * Compared member by member, deliberately not with `deepEqual` /
 * `JSON.stringify`: `DescribeTable` returns a `ProvisionedThroughputDescription`
 * carrying `NumberOfDecreasesToday` / `LastIncreaseDateTime` /
 * `LastDecreaseDateTime` alongside the two capacities, so a structural compare
 * against the two-member desired object could never match and the suppression
 * would be dead code that only LOOKED safe.
 *
 * Anything that is not a usable number on EITHER side fails OPEN (the
 * `UpdateTable` is still issued): an absent live entry, a malformed template
 * value, an unresolved intrinsic. That is the correct direction — the worst
 * case is the pre-fix behavior, whereas a false MATCH would silently drop a
 * capacity change the user asked for.
 */
export function liveCapacityAlreadyMatches(
  live: ProvisionedThroughputDescription | undefined,
  requested: ProvisionedThroughput
): boolean {
  if (live === undefined) return false;
  const liveRead = toFiniteNumber(live.ReadCapacityUnits);
  const liveWrite = toFiniteNumber(live.WriteCapacityUnits);
  const wantRead = toFiniteNumber(requested.ReadCapacityUnits);
  const wantWrite = toFiniteNumber(requested.WriteCapacityUnits);
  if (liveRead === undefined || liveWrite === undefined) return false;
  if (wantRead === undefined || wantWrite === undefined) return false;
  return liveRead === wantRead && liveWrite === wantWrite;
}
