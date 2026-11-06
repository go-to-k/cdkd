import type {
  GlobalSecondaryIndex,
  OnDemandThroughput,
  WarmThroughput,
  ProvisionedThroughput,
  GlobalSecondaryIndexDescription,
} from '@aws-sdk/client-dynamodb';
import type { SecretMasker } from '../../../types/resource.js';
import type { DynamoDBTableProvider } from '../dynamodb-table-provider.js';
import {
  ON_DEMAND_CEILING_MEMBERS,
  ON_DEMAND_LIMIT_RESET,
  PROVISIONED_CAPACITY_MEMBERS,
  liveCeilingAlreadyMatches,
  narrowOnDemandCeilings,
  onDemandCeilingRemovals,
  withOnDemandCeilingRemovals,
} from './capacity.js';
import { isPlainCapacityBlock, maskLeafValue, readCapacityNumber } from './table-helpers.js';
import { coerceWarmThroughput } from './warm-throughput.js';

/**
 * The NUMERIC `WarmThroughput` spec to put on the wire, announcing any member
 * that had to be dropped (PR review round 5).
 *
 * The single send-side entry point for all four write sites, so a template's
 * quoted `'12000'` reaches AWS as `12000` rather than as a string in a Long
 * field. Returns `undefined` for a value {@link isSendableWarmThroughput}
 * refuses — the caller's existing refusal warning covers that case, and the
 * two messages are disjoint by construction: this one fires only when
 * something DID resolve.
 */
export function coerceWarmThroughputForSend(
  this: DynamoDBTableProvider,
  scope: string,
  value: unknown,
  maskSecrets: SecretMasker
): WarmThroughput | undefined {
  // ONE masked sink (issue #1997) — BUILT, not an inline wrap. An inline
  // `this.logger.warn(maskSecrets(...))` leaves the next warning added here
  // unmasked by default, which is the exact failure the sink shape exists to
  // prevent (and which this file already suffered once, in
  // `warmThroughputOpFor`).
  const warn = (message: string): void => this.logger.warn(maskSecrets(message));
  const coerced = coerceWarmThroughput(value);
  if (coerced === undefined) return undefined;
  if (coerced.dropped.length > 0) {
    // The message names the RAW declared
    // `WarmThroughput` bag, which arrives resolved, so a
    // `{{resolve:secretsmanager:...}}` scalar inside it is plaintext here.
    // `maskLeafValue` is the inner layer — it hands the masker each raw string
    // BEFORE `JSON.stringify` escapes it, so a secret carrying a quote, a
    // backslash or a newline is still caught.
    warn(
      `${scope}: WarmThroughput member(s) ${coerced.dropped.join(', ')} in ` +
        `${JSON.stringify(maskLeafValue(value, maskSecrets))} are not a number DynamoDB ` +
        `accepts, so they were dropped from the request, which leaves ` +
        // Masked for CONSISTENCY with the sibling argument above, not because
        // this one can leak: `coerceWarmThroughput` admits only
        // `coerceCfnInteger` results into `spec`, and its keys are cdkd
        // literals, so the walk is a no-op here BY CONSTRUCTION today. It is
        // written anyway so the site stays correct if that coercion is ever
        // widened -- and stated plainly so nobody reads it as a closed leak.
        `${JSON.stringify(maskLeafValue(coerced.spec, maskSecrets))}. Check for an ` +
        `unresolved intrinsic or a spelling CloudFormation would reject: an Integer here ` +
        `is an optional sign and decimal digits only (no surrounding whitespace, hex, ` +
        `exponent or decimal point).`
    );
  }
  return coerced.spec;
}

/**
 * `GSI <name> on AWS::DynamoDB::Table <logicalId>` — the scope every
 * create-path per-index warning interpolates.
 *
 * The index NAME is a RESOLVED property value, so it is masked before it
 * becomes part of a message (issue #1997). It is also an UNCHECKED cast off
 * the template: `IndexName: 2024` (unquoted YAML) reaches here as a NUMBER,
 * and the real masker is a `String.prototype.replace` call that THROWS on
 * one — which would take the whole deploy down from a diagnostic path. So
 * the type test is the guard, not merely `!== undefined`: anything that is
 * not a string has no name to print and takes the `<unnamed>` arm, exactly
 * as an absent one does. (Reached by the review of issue
 * [#3255](https://github.com/go-to-k/cdkd/issues/3255): before it, the scope
 * was built only for an entry declaring `WarmThroughput`, so the crash was
 * unreachable for an ordinary PROVISIONED template.)
 */
export function indexScope(
  this: DynamoDBTableProvider,
  indexName: unknown,
  logicalId: string,
  maskSecrets: SecretMasker
): string {
  const name = typeof indexName === 'string' ? maskSecrets(indexName) : '<unnamed>';
  return `GSI ${name} on AWS::DynamoDB::Table ${logicalId}`;
}

/**
 * `GSI <name> on DynamoDB table <physicalId>` — {@link indexScope}'s twin for
 * the UPDATE path, which names the LIVE table rather than the template's
 * logical id.
 *
 * Same guard, same reason, and the reason is why this exists at all rather
 * than the five call sites spelling `maskSecrets(name)` inline: `name` is a
 * key of a map built from `g.IndexName!` off an UNCHECKED template cast, so
 * `IndexName: 2024` (unquoted YAML) is truthy, becomes the key, and arrives
 * here as a NUMBER — on which the real masker's `String.prototype.replace`
 * THROWS. The create path was guarded when {@link indexScope} was added
 * (the review of issue #3255); the update sites that now build a scope
 * EAGERLY for the capacity coercion were not, which newly exposed the same
 * crash on an ordinary PROVISIONED capacity update with a non-empty secret
 * bag (found by the review of that round).
 */
/**
 * go-to-k/cdkd#5503: warn about each live index that none of `lists` (the
 * previous side and the template) names. It is left in place, and the
 * warning says how to remove it, because it may be one an earlier failed
 * update created, and the record cannot tell that from another tool's. The
 * command is withheld when the table or index name is secret-derived.
 */
export function warnUndeclaredLiveIndexes(
  this: DynamoDBTableProvider,
  physicalId: string,
  liveIndexNames: ReadonlySet<string>,
  lists: readonly unknown[],
  maskSecrets: SecretMasker
): void {
  const named = new Set<string>();
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const entry of list as unknown[]) {
      const name =
        typeof entry === 'object' && entry !== null
          ? (entry as Record<string, unknown>)['IndexName']
          : undefined;
      if (typeof name === 'string') named.add(name);
    }
  }
  for (const name of liveIndexNames) {
    if (named.has(name)) continue;
    const secretDerived = maskSecrets(name) !== name || maskSecrets(physicalId) !== physicalId;
    this.logger.warn(
      maskSecrets(
        `${this.indexScopeAt(name, physicalId, maskSecrets)} is live, but neither cdkd's ` +
          `record nor the template declares it, so cdkd left it in place while converging ` +
          `the unsettled GlobalSecondaryIndexes (CloudFormation never deletes an index it did ` +
          `not record). It may belong to another tool, or an earlier failed cdkd update may ` +
          `have created it; cdkd cannot tell which. If it should not exist, delete it ` +
          (secretDerived
            ? `with an UpdateTable GlobalSecondaryIndexUpdates Delete for the index.`
            : `with: aws dynamodb update-table --table-name ${physicalId} ` +
              `--global-secondary-index-updates '[{"Delete":{"IndexName":"${name}"}}]' ` +
              `(in the table's region)`)
      )
    );
  }
}

/**
 * The per-index `ProvisionedThroughput` an `UpdateTable` action should put on
 * the wire (the review of issue
 * [#3255](https://github.com/go-to-k/cdkd/issues/3255)).
 *
 * Exists because coercing only `create()`'s forward left the file
 * INTERNALLY divergent in the direction the issue is about: the same index
 * entry succeeded on a fresh create and was rejected by AWS when added by a
 * later update, which is the `WarmThroughput` round-6 story with the
 * polarity flipped. All three `applyGsiUpdates` send sites — the adopted
 * index's repair `Update`, the `Create` action and the same-name `Update`
 * action — now read through {@link coerceIndexCapacityBlock}, the same
 * reader `create()` uses.
 *
 * **The GUARDS around those sites deliberately stay on `toFiniteNumber`**,
 * and that is the split `dynamodb-warm-throughput.ts`'s header already
 * records: a FORWARDER reads CloudFormation's grammar, a GUARD reads the
 * wider one, because over-acceptance is the safe side of an
 * already-matches / zero-capacity / change-detection test. Nothing moves as
 * a result — `liveCapacityAlreadyMatches` and `skipZeroCapacityIndexUpdate`
 * are asked about the DECLARED block exactly as before, and the change
 * detector still compares the declared block against the recorded one, both
 * raw. Only what reaches AWS changes.
 */
export function indexCapacityForSend(
  this: DynamoDBTableProvider,
  scope: string,
  declared: ProvisionedThroughput | undefined,
  maskSecrets: SecretMasker
): ProvisionedThroughput | undefined {
  if (declared === undefined) return undefined;
  const coerced = this.coerceIndexCapacityBlock(scope, declared, maskSecrets);
  // `undefined` from the reader means "nothing to rewrite", NOT "send
  // nothing" — a non-object block and an all-integer one both take that arm
  // and must go out exactly as declared.
  return (coerced ?? declared) as unknown as ProvisionedThroughput;
}

/**
 * The per-index `OnDemandThroughput` an `UpdateGlobalSecondaryIndexAction`
 * should carry, or `undefined` when no op is warranted (issue
 * [#3287](https://github.com/go-to-k/cdkd/issues/3287)).
 *
 * The whole of that issue: `UpdateGlobalSecondaryIndexAction` declares the
 * member, the SDK has always accepted it, and NEITHER update arm ever set it
 * — while the `Create` action arm has carried it since issue #3265. So one
 * template applied a per-index ceiling when the index was ADDED and silently
 * discarded a later edit to it, recording the new value as applied so no
 * later deploy converged. Routed through
 * {@link coerceOnDemandCeilingsForSend} like the other five sites, so one
 * template value cannot be answered differently at two of them.
 *
 * FIVE decisions, in the order the op is decided, plus one deliberate NON-decision:
 *
 *  - **The declaration gate is TRUTHINESS**, matching `indexDeclares`' gate
 *    for this block and the `Create` arm's `gsi.OnDemandThroughput` test. A
 *    tighter gate here would make the #1767 drift-side predicate answer
 *    "declared" for a block this arm skips.
 *  - **The BILLING MODE is deliberately NOT gated here**, and that is a
 *    decision with a filed issue rather than an oversight. DynamoDB accepts
 *    `OnDemandThroughput` only on a PAY_PER_REQUEST table, and the ceiling
 *    rides the SAME action as the capacity — so on a PROVISIONED one the op
 *    is rejected and takes an otherwise-valid capacity edit with it. A gate
 *    WITHHOLDING the member was written for the go-to-k/cdkd#3380 review's M1
 *    and REVERTED on the next round: a mid-update warn-and-skip lets the
 *    deploy succeed, so the engine records the un-sent ceiling as applied and
 *    the deploy that FIXES the billing mode then compares equal and never
 *    sends it — issue #3287's own defect, reintroduced by its own guard. The
 *    file's table-level twin states that reasoning at its own refusal.
 *
 *    **The refusal it pointed at has SHIPPED** (issue
 *    [#3392](https://github.com/go-to-k/cdkd/issues/3392)): `update()` walks
 *    `GlobalSecondaryIndexes[]` before any call and throws when the EFFECTIVE
 *    billing mode is PROVISIONED, which covers all THREE per-index send sites
 *    at once (this arm, the same-name `Update` arm's caller, and the `Create`
 *    action, which has carried the same defect since #3265) because none of
 *    them is reached. So this arm's job is unchanged and stays deliberately
 *    mode-blind: a gate here would be a SECOND spelling of one rule, and the
 *    mid-update spelling is the one that was measured wrong.
 *
 *    On the REPLAY path the pre-flight downgrades to a warning and this arm
 *    still runs, so the remaining behaviour is what #3287's round 3 recorded:
 *    the member goes out, AWS rejects the `UpdateTable`, and the co-resident
 *    capacity / warm edits fail with it. Loud and recording nothing beats
 *    silent and lost.
 *  - **The change detector compares the NARROWED blocks WHEN NOTHING WAS
 *    DROPPED, and the RAW ones otherwise** — the one place it differs from its
 *    `ProvisionedThroughput` sibling two arms up. `'200'` and `200` are the
 *    SAME ceiling once coerced, so a purely narrowed detector saves an
 *    `UpdateGlobalSecondaryIndexAction` — and a full index-ACTIVE wait — on a
 *    re-spelling. But narrowing ALONE conceals a case the raw compare reports
 *    (the go-to-k/cdkd#3380 spec review's Drift 2): two DIFFERENT rejected
 *    spellings (`' 25 '` against a recorded `' 30 '`) narrow to the same
 *    block, so the arm would return before {@link
 *    DynamoDBTableProvider.coerceOnDemandCeilingsForSend} ever warns and the
 *    user would stop being told what to fix — exactly what
 *    `.claude/rules/provider-diff-record-folds.md` refuses and what keeps the
 *    TABLE-level detector raw. So the discriminator is
 *    {@link narrowOnDemandCeilings}'s OWN `dropped` report: any drop on either
 *    side falls back to the RAW compare, which keeps the announcement alive
 *    while the narrowed compare still absorbs a lossless re-spelling.
 *  - **A block with no SURVIVING GRAMMAR MEMBER emits NO op, and WARNS.** The TABLE-level
 *    arm sends the empty block and lets DynamoDB answer; here the action can
 *    legitimately carry nothing but `IndexName`, which AWS rejects outright,
 *    so an empty ceiling would take a capacity edit down with it or fire a
 *    doomed call on its own. The test is per MEMBER and not
 *    `Object.keys(...).length === 0` (the go-to-k/cdkd#3380 review's m2):
 *    {@link narrowOnDemandCeilings} preserves an unknown member name by
 *    design, so a typo'd `MaxReadRequestUnit` leaves a non-empty object that
 *    the SDK serializes to `{}` — the same rejected action, reached past a
 *    key-count gate. The fail-open "let AWS name it" reasoning does NOT reach
 *    that shape here, because AWS never sees the name to name. The warning is
 *    this arm's OWN, not {@link warnUnusableOnDemandCeiling}'s (round 2's C3):
 *    an unknown member is never DROPPED by the narrowing — its name is
 *    preserved — so the per-member announcement says nothing about it, and
 *    withholding silently would lose the ceiling where the pre-gate code at
 *    least failed loudly at AWS.
 *  - **A block that is not a plain object is forwarded VERBATIM**, the
 *    fail-open direction every forwarder in this file takes: a STRING, a
 *    NUMBER or an ARRAY is AWS's to reject by name — and unlike the unknown
 *    member above, AWS really does see it and rejects it by shape.
 *  - **The live ceiling is consulted for idempotency**
 *    ({@link liveCeilingAlreadyMatches}), the #1630 arm the capacity sibling
 *    already has, and it needs NO billing-mode gate: `DescribeTable` reports
 *    `OnDemandThroughput` only on a PAY_PER_REQUEST table, so on a
 *    PROVISIONED one the live block is simply absent and the guard fails
 *    OPEN — the correct direction, since the worst case is the op AWS then
 *    rejects by name (issue #3392) rather than a silently dropped change.
 *    There is no `{0, 0}` analogue of the #1571 capacity trap.
 *
 * It DOES remove a ceiling, since issue
 * [#3373](https://github.com/go-to-k/cdkd/issues/3373) — and the removal is
 * the one thing here that runs AHEAD of the truthiness gate, because the
 * whole point is a desired side that declares nothing. An absent member KEEPS
 * whatever maximum the index already carries, so before #3373 a template edit
 * dropping a ceiling deployed GREEN, was recorded as applied, and left the
 * live maximum in force forever.
 *
 * {@link onDemandCeilingRemovals} owns every condition and
 * {@link ON_DEMAND_LIMIT_RESET} carries the measurement for THIS action's
 * position (issue #1423's probe transcript, not an extrapolation from the
 * table-level field's docs). Two properties of that rule matter most here:
 * the previous side is read through {@link narrowOnDemandCeilings} so a
 * member cdkd REFUSED cannot read as "previously applied"; the reset fires
 * only for a member AWS is OBSERVED to hold, which makes it fail CLOSED with
 * no live snapshot; and it is suppressed outright when this update FLIPS the
 * table to PROVISIONED (`onDemandCeilingsSendable`). Do not read the
 * observed-live condition as covering the flip — it does not, and believing
 * it did was a merge blocker: the live snapshot is taken before the flip and
 * never refreshed.
 *
 * The TABLE-level arm in `update()` takes the same rule in the same change,
 * because implementing it at ONE of the two positions would make the same
 * property behave differently at the table and at an index of the same table.
 */
export function indexCeilingForSend(
  this: DynamoDBTableProvider,
  // `unknown`, NOT `string` (the go-to-k/cdkd#3380 review, n4) — the same
  // correction `warmThroughputOpFor` takes, and for the same reason: the
  // caller's key comes from a `g.IndexName!` cast off an unchecked template,
  // so a numeric `IndexName` really does arrive here. Typed honestly, the only
  // way to render it is {@link indexScopeAt}.
  name: unknown,
  physicalId: string,
  gsi: GlobalSecondaryIndex,
  before: GlobalSecondaryIndex | undefined,
  live: GlobalSecondaryIndexDescription | undefined,
  // See {@link onDemandCeilingRemovals} condition 4: a ceiling REMOVAL must
  // not ride a deploy that flips the table to PROVISIONED.
  onDemandCeilingsSendable: boolean,
  maskSecrets: SecretMasker
): OnDemandThroughput | undefined {
  // Computed BEFORE the truthiness gate (issue #3373): the headline removal
  // is a desired side that declares no block at all, which that gate rejects.
  const removals = onDemandCeilingRemovals(
    gsi.OnDemandThroughput,
    before?.OnDemandThroughput,
    live?.OnDemandThroughput,
    onDemandCeilingsSendable
  );
  if (!gsi.OnDemandThroughput) {
    if (removals.length === 0) return undefined;
    const removalScope = this.indexScopeAt(name, physicalId, maskSecrets);
    this.logger.debug(
      maskSecrets(
        `${removalScope}: removing the OnDemandThroughput ${removals.join(' / ')} the ` +
          `template no longer declares (sending ${ON_DEMAND_LIMIT_RESET}, DynamoDB's reset ` +
          `sentinel)`
      )
    );
    return withOnDemandCeilingRemovals({}, removals) as OnDemandThroughput;
  }
  if (before !== undefined) {
    const desired = narrowOnDemandCeilings(gsi.OnDemandThroughput);
    const previous = narrowOnDemandCeilings(before.OnDemandThroughput);
    // RAW whenever either side lost a member, so a still-malformed template
    // keeps reaching the announcing forwarder below; NARROWED otherwise, so a
    // lossless re-spelling emits nothing. See the detector bullet above.
    const [desiredSide, previousSide] =
      desired.dropped.length > 0 || previous.dropped.length > 0
        ? [gsi.OnDemandThroughput, before.OnDemandThroughput]
        : [desired.block, previous.block];
    if (JSON.stringify(desiredSide) === JSON.stringify(previousSide)) return undefined;
  }
  // ONE scope, built ONCE and reused by the send and by every line below.
  // {@link indexScopeAt} is what masks the index NAME -- a RESOLVED property
  // value -- and what guards the real masker's `String.prototype.replace`
  // against a numeric `IndexName: 2024` off an unchecked template cast, which
  // would take the whole deploy down from a diagnostic path.
  const scope = this.indexScopeAt(name, physicalId, maskSecrets);
  // ONE masked sink per level rather than per-site masking (issue #1997, and
  // the go-to-k/cdkd#3380 security review's n1): nothing below interpolates a
  // resolved value that `scope` has not already masked, and building the sink
  // is what keeps the NEXT line added here masked by default.
  const warn = (message: string): void => this.logger.warn(maskSecrets(message));
  const debug = (message: string): void => this.logger.debug(maskSecrets(message));
  const coerced = this.coerceOnDemandCeilingsForSend(scope, gsi.OnDemandThroughput, maskSecrets);
  if (!isPlainCapacityBlock(coerced)) return coerced;
  // The SINGLE-MEMBER removal (issue #3373): the template still declares one
  // maximum and dropped the other. Merged BEFORE the surviving-member gate
  // below, so a desired block carrying only an unknown member name still
  // delivers the reset its sibling member earned instead of being withheld as
  // "nothing DynamoDB accepts". The merged shape is live-verified at this
  // action's position -- see {@link ON_DEMAND_LIMIT_RESET}.
  if (removals.length > 0) {
    debug(
      `${scope}: removing the OnDemandThroughput ${removals.join(' / ')} the template no ` +
        `longer declares (sending ${ON_DEMAND_LIMIT_RESET}, DynamoDB's reset sentinel)`
    );
  }
  const send = withOnDemandCeilingRemovals(coerced, removals) as Record<string, unknown>;
  if (!ON_DEMAND_CEILING_MEMBERS.some((member) => member in send)) {
    // Two ways to reach here, and they need DIFFERENT levels (the
    // go-to-k/cdkd#3380 round-3 review's C3, correcting round 2's C3).
    //
    // Every member was DROPPED: {@link warnUnusableOnDemandCeiling} has just
    // named each one and said why, so a second line telling the user to
    // "check the member names" would contradict the advice one line above it.
    // DEBUG.
    //
    // NOTHING was dropped and no grammar member is present: the block carries
    // only names the grammar does not know (a typo'd `MaxReadRequestUnit`, an
    // unresolved intrinsic). The narrowing PRESERVES such a name rather than
    // dropping it, so nothing announced anything at all -- and before the
    // per-member gate the op at least reached AWS and failed loudly. WARN, or
    // that template loses its ceiling in silence.
    if (narrowOnDemandCeilings(gsi.OnDemandThroughput).dropped.length > 0) {
      debug(
        `${scope}: every declared OnDemandThroughput member was unusable, so no ceiling op ` +
          `was sent`
      );
    } else {
      warn(
        `${scope}: declares an OnDemandThroughput with no member DynamoDB accepts ` +
          `(${ON_DEMAND_CEILING_MEMBERS.join(' / ')}), so no ceiling op was sent. Check the ` +
          `member names.`
      );
    }
    return undefined;
  }
  if (liveCeilingAlreadyMatches(live?.OnDemandThroughput, send)) {
    debug(
      `${scope}: already carries the requested OnDemandThroughput in AWS; skipping its ceiling ` +
        `Update`
    );
    return undefined;
  }
  return send as OnDemandThroughput;
}

/**
 * One `CreateTable` index entry with ALL THREE of its throughput blocks
 * coerced — `WarmThroughput` (PR review round 6), `ProvisionedThroughput`
 * (issue [#3255](https://github.com/go-to-k/cdkd/issues/3255)) and
 * `OnDemandThroughput` (issue
 * [#3265](https://github.com/go-to-k/cdkd/issues/3265)).
 *
 * `create()` forwards the declared `GlobalSecondaryIndexes` array to
 * `CreateTable`, so it is a SEND SITE for the same per-index values the
 * update path coerces. `WarmThroughput` was the one the round-5 sweep
 * missed; `ProvisionedThroughput` was missed by round 6 AND by issue #3147's
 * own enumeration; `OnDemandThroughput` was missed a THIRD time, by #3265's
 * own three-site grep — all for one reason, that this forwarder is a CAST
 * rather than a call, so no sweep's grep could see it. The
 * BillingMode flip's per-index reader
 * ({@link readCapacityNumber}) has been on the grammar since #3147, so until
 * now create and flip disagreed about the same property: a CFn-legal
 * `ReadCapacityUnits: '7'` reached `CreateTable` as a STRING in a `number`
 * field, and a `' 7 '` CloudFormation refuses the template for was forwarded
 * unchanged.
 *
 * Entries are rebuilt rather than mutated: the input bag belongs to the
 * caller (the resolved template, which the engine also records into state),
 * and a provider that edits it in place would change what state reports cdkd
 * sent.
 *
 * An entry that is not a plain object, and one declaring NONE of the three
 * throughput blocks, is returned UNCHANGED — identity included. An entry that
 * DOES declare one is rebuilt whenever that block's coercion changes
 * anything; the `WarmThroughput` half rebuilds even for an already-numeric
 * value, which is pre-existing behaviour and costs one spread per declared
 * block.
 */
export function coerceIndexThroughputForCreate(
  this: DynamoDBTableProvider,
  logicalId: string,
  entry: GlobalSecondaryIndex,
  maskSecrets: SecretMasker
): GlobalSecondaryIndex {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return entry;
  const bag = entry as unknown as Record<string, unknown>;
  const declaredWarm = bag['WarmThroughput'];
  const declaredCapacity = bag['ProvisionedThroughput'];
  const declaredOnDemand = bag['OnDemandThroughput'];
  // Nothing any of the three halves could rewrite: return the entry
  // untouched, identity included. An entry that DOES declare a capacity or
  // ceiling block still reaches the scope below even when every member is
  // already an integer — building the scope is what lets the member loop
  // announce a drop, and it is one template-string concatenation per declared
  // block.
  if (
    declaredWarm === undefined &&
    !isPlainCapacityBlock(declaredCapacity) &&
    !isPlainCapacityBlock(declaredOnDemand)
  ) {
    return entry;
  }
  const scope = this.indexScope(entry.IndexName, logicalId, maskSecrets);
  let out: GlobalSecondaryIndex = entry;
  if (declaredWarm !== undefined) {
    const coerced = this.coerceWarmThroughputForSend(scope, declaredWarm, maskSecrets);
    if (coerced === undefined) {
      // Nothing usable: drop the block from the request and say so, exactly
      // as the update-side arms do.
      this.warnRefusedWarmThroughput(scope, declaredWarm, maskSecrets);
      const { WarmThroughput: _dropped, ...rest } = out;
      out = rest;
    } else {
      out = { ...out, WarmThroughput: coerced };
    }
  }
  const capacity = this.coerceIndexCapacityBlock(scope, declaredCapacity, maskSecrets);
  if (capacity !== undefined) {
    // `as unknown as` because a rewritten block can legitimately be MISSING a
    // member the SDK type declares required — that is exactly the drop this
    // helper announces, and DynamoDB naming the absent member is the intended
    // outcome. The SDK type is `Required`-shaped for a happy-path caller, not
    // a claim about what an invalid template may spell.
    out = { ...out, ProvisionedThroughput: capacity as unknown as ProvisionedThroughput };
  }
  // The FOURTH `OnDemandThroughput` send site (issue #3265), and the one its
  // own grep could not see: this forwarder is a CAST of the whole
  // `GlobalSecondaryIndexes` array, so the value never appears as a named
  // `OnDemandThroughput` expression here. Rebuilt only when the coercion
  // CHANGED something — the reader returns the declared block by identity
  // otherwise — so an already-numeric ceiling costs no spread.
  if (isPlainCapacityBlock(declaredOnDemand)) {
    const onDemand = this.coerceOnDemandCeilingsForSend(scope, declaredOnDemand, maskSecrets);
    if ((onDemand as unknown) !== declaredOnDemand) {
      out = { ...out, OnDemandThroughput: onDemand };
    }
  }
  return out;
}

/**
 * One `CreateTable` index entry's `ProvisionedThroughput`, with each DECLARED
 * member read through CloudFormation's DynamoDB Integer grammar (issue
 * [#3255](https://github.com/go-to-k/cdkd/issues/3255)). Returns `undefined`
 * when the block needs no rewriting at all.
 *
 * It reads through {@link readCapacityNumber} — the function the BillingMode
 * flip's per-index forwarder calls — rather than restating the grammar, for
 * the same reason {@link hasUsableDeclaredCapacity} does: that is what keeps
 * create and flip answering identically about one template value.
 *
 * THREE decisions, each of which had a plausible alternative:
 *
 *  - **A rejected spelling drops the MEMBER, not the whole block.** This is
 *    what {@link tableCapacityForSend} already does one level up for the
 *    identical grammar, so create's two capacity forwarders answer the same
 *    way; it keeps a sibling member the template spelled LEGALLY, which
 *    dropping the block would discard; and it is the more informative
 *    failure at AWS — `CreateTable` names the missing member at its exact
 *    index position, where a missing block yields only
 *    `ProvisionedThroughput must be specified for index: <name>`. Both
 *    directions FAIL the deploy (DynamoDB requires both members on a
 *    PROVISIONED index), so this is a choice of error TEXT, never of
 *    outcome — what matters is that neither silently succeeds at a capacity
 *    CloudFormation refuses the template for.
 *
 *    **That is also why this drop needs NO `effectiveProperties`**, which
 *    `.claude/rules/provider-property-fidelity.md` otherwise requires of any
 *    announced narrowing: the rule exists because a SUCCEEDING call plus a
 *    record describing the declared value is permanent phantom drift. Here
 *    `CreateTable` FAILS, so `create()` never returns and nothing is
 *    recorded — the same reasoning `tableCapacityForSend` states for the
 *    table-level omit one level up.
 *  - **An ABSENT member stays absent — no `5` default.** The per-index
 *    reader deliberately has none ({@link readCapacityNumber}'s doc, issue
 *    #1588): a defaulted per-index capacity would land in cdkd state as if
 *    the template had declared it, with no later call to correct it. Only
 *    the TABLE level defaults.
 *  - **A block that is not a plain object is forwarded VERBATIM**, the
 *    fail-OPEN direction this file takes everywhere: a STRING, a NUMBER or an
 *    ARRAY block is AWS's to reject by name, and that is also the pre-existing
 *    behaviour of this forwarder. An unresolved intrinsic (`{Ref: 'X'}`) is
 *    NOT an example of it — that IS a plain object, so it takes the member
 *    loop and survives through the preserve-unknown-member rule below. Same
 *    destination, different route; corrected by the review of issue
 *    [#3265](https://github.com/go-to-k/cdkd/issues/3265), which found the
 *    wrong example here and at {@link coerceOnDemandCeilingsForSend}.
 *
 * A member name the grammar does not know is preserved untouched, for the
 * same fail-open reason — a misspelled `ReadCapacityUnit` reaches AWS and is
 * named there rather than vanishing here.
 */
export function coerceIndexCapacityBlock(
  this: DynamoDBTableProvider,
  scope: string,
  declared: unknown,
  maskSecrets: SecretMasker
): Record<string, unknown> | undefined {
  if (!isPlainCapacityBlock(declared)) return undefined;
  const block = declared;
  let rewritten: Record<string, unknown> | undefined;
  for (const member of PROVISIONED_CAPACITY_MEMBERS) {
    if (!(member in block)) continue;
    const coerced = readCapacityNumber(block, member);
    // Already the exact integer cdkd would send: leave the key alone, so a
    // numeric template rebuilds nothing.
    if (coerced === block[member]) continue;
    rewritten ??= { ...block };
    if (coerced === undefined) {
      this.warnUnusableProvisionedCapacity(scope, member, block[member], maskSecrets);
      delete rewritten[member];
    } else {
      rewritten[member] = coerced;
    }
  }
  return rewritten;
}
