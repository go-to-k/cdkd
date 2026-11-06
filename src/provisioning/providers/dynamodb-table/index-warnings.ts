import type {
  GlobalSecondaryIndex,
  OnDemandThroughput,
  WarmThroughput,
  ProvisionedThroughput,
  GlobalSecondaryIndexDescription,
} from '@aws-sdk/client-dynamodb';
import { isWarmThroughputDecrease } from '../../dynamodb-warm-throughput.js';
import { maskDeep } from '../../masked-retry-logger.js';
import type { SecretMasker } from '../../../types/resource.js';
import type { DynamoDBTableProvider } from '../dynamodb-table-provider.js';
import { isZeroCapacityPlaceholder, narrowOnDemandCeilings } from './capacity.js';
import { maskLeafValue } from './table-helpers.js';
import {
  type WarmThroughputUnits,
  isRefusedWarmThroughput,
  warmThroughputAlreadyMatches,
} from './warm-throughput.js';

/**
 * One `OnDemandThroughput` block for the wire, with each DECLARED member read
 * through CloudFormation's DynamoDB Integer grammar (issue
 * [#3265](https://github.com/go-to-k/cdkd/issues/3265)).
 *
 * Called from ALL SIX send sites, which is the whole point — the block was
 * forwarded VERBATIM at every one of them, so a CFn-legal
 * `MaxReadRequestUnits: '100'` reached AWS as the STRING `"100"` in a `Long`
 * field and the request failed, while a `' 100 '` / `'0x64'` / `'1e2'`
 * CloudFormation refuses the template for was forwarded unchanged. The sites:
 *
 *  1. `create()`'s TABLE-level `CreateTable.OnDemandThroughput`;
 *  2. `create()`'s PER-INDEX `CreateTable.GlobalSecondaryIndexes[]` forward,
 *     through {@link coerceIndexThroughputForCreate} — a CAST of the whole
 *     entry array rather than a named `OnDemandThroughput` expression, which
 *     is why issue #3265's own grep enumerated three sites and not four (the
 *     same blind spot that hid this forwarder from issue #3147's sweep and
 *     from #3255's round 6, one property over);
 *  3. `update()`'s TABLE-level `UpdateTable.OnDemandThroughput`;
 *  4. `applyGsiUpdates`' per-index `Create` action;
 *  5. `applyGsiUpdates`' same-name `Update` action, and
 *  6. its adopted-index repair `Update` — both through
 *     {@link indexCeilingForSend}, added by issue
 *     [#3287](https://github.com/go-to-k/cdkd/issues/3287).
 *
 * Sites 5 and 6 were the MISSING SEND rather than a grammar defect: until
 * #3287 `UpdateGlobalSecondaryIndexAction.OnDemandThroughput` was declared by
 * the SDK and set by neither arm, and `updateHasMember` was set only by the
 * capacity and warm arms — so a template whose only edit was a live index's
 * ceiling fired no op at all, the engine recorded the new value, and the next
 * deploy compared EQUAL. The edit was lost permanently, with nothing refused
 * and nothing dropped to warn about.
 *
 * THREE decisions, each with a plausible alternative:
 *
 *  - **A rejected spelling drops the MEMBER, never the BLOCK.** The same
 *    DECISION {@link coerceIndexCapacityBlock} and {@link tableCapacityForSend}
 *    already take one property over, so this file's capacity and ceiling
 *    families answer identically about one template value; it keeps a sibling
 *    member the template spelled LEGALLY; and it leaves `indexDeclares`'
 *    TRUTHINESS gate ("would cdkd SEND this block") true without
 *    qualification, so the #1767 drift-side predicate needs no new arm. An
 *    all-rejected block therefore goes out EMPTY, as the capacity sibling's
 *    does. ("The same decision", NOT the same SIGNATURE — the capacity
 *    sibling answers `undefined` for "nothing to rewrite" while this one
 *    returns the declared block by IDENTITY. The review of this issue caught
 *    an earlier "byte for byte the shape" here, which was false and is the
 *    kind of claim that invites a caller to swap one for the other.)
 *  - **What a rejected spelling COSTS differs from the capacity sibling's,
 *    and it is stated at {@link warnUnusableOnDemandCeiling} rather than
 *    assumed.** Both `OnDemandThroughput` members are SDK-optional, so
 *    DynamoDB does not necessarily reject a request that omits one — which is
 *    why the announcement cannot reuse the capacity wording, which promises
 *    AWS will name the member. **It is NOT a promise of success either**, and
 *    an earlier revision made it one: the outcome is per PATH (create leaves
 *    no maximum, update KEEPS the live one since only `-1` removes it) and an
 *    ALL-rejected block is documented invalid at every one of the four send
 *    positions ("you must specify `MaxReadRequestUnits`,
 *    `MaxWriteRequestUnits`, or both"), so that request should FAIL. cdkd has
 *    not measured the empty-block send against live DynamoDB; the message
 *    under-claims accordingly.
 *  - **A block that is not a plain object is forwarded VERBATIM**, the
 *    fail-OPEN direction this file takes everywhere: a STRING, a NUMBER or an
 *    ARRAY `OnDemandThroughput` is AWS's to reject by name, and that is the
 *    pre-existing behaviour of every one of these forwarders. Note what this
 *    arm does NOT cover: an unresolved intrinsic (`{Ref: 'X'}`) IS a plain
 *    object, so it takes the member loop instead and survives through the
 *    preserve-unknown-member rule below — same destination, different route.
 *    {@link isPlainCapacityBlock}'s own doc is the authority; the review of
 *    this issue found that example wrong here and at
 *    {@link coerceIndexCapacityBlock}.
 *
 * A member name the grammar does not know is preserved untouched, for the
 * same fail-open reason. Returns the DECLARED object by IDENTITY when nothing
 * needs rewriting, so a numeric template rebuilds nothing and
 * {@link coerceIndexThroughputForCreate} can tell "unchanged" from "rewritten"
 * without a structural compare.
 *
 * **The template path no longer reaches the drop for a spelling
 * CloudFormation rejects** (issue
 * [#3286](https://github.com/go-to-k/cdkd/issues/3286)): `create()` and
 * `update()` refuse it first ({@link onDemandCeilingRefusal}), because
 * wherever this call SUCCEEDS state records the declared spelling while AWS
 * holds a different ceiling — permanent drift. What still arrives here is a
 * state-borne bag (a replay, which cannot be fixed from the template) and
 * the shapes CloudFormation may accept that the refusal leaves alone
 * ({@link refusedOnDemandCeilingShape}). Recording the narrowed bag instead
 * (`effectiveProperties` plus its `canonicalizeDesiredProperties` twin) was
 * written and withdrawn on PR #3380: the observed-properties capture reads
 * the RAW bag, so the fold manufactured the drift it meant to remove. The
 * `AWS::DynamoDB::GlobalTable` sibling answers the SAME way for the same
 * spelling — `collectTableOnDemandCeilings` coerces through
 * `coerceCfnInteger` and a rejected ceiling is reported and LEFT UNSENT, with
 * AWS untouched and no substituted value (its 5/5 FALLBACK is its PROVISIONED
 * capacity answer, not its ceiling one) — so the two types do not diverge.
 */
export function coerceOnDemandCeilingsForSend(
  this: DynamoDBTableProvider,
  scope: string,
  declared: unknown,
  // REQUIRED, deliberately, with no identity default. A default here makes the
  // argument optional at every call site, and dropping it degrades BOTH masking
  // layers at once -- the leaf pass (`maskLeafValue(raw, maskSecrets)`) and the
  // built `warn` sink derive from this one parameter -- so a resolved secret
  // ceiling would print in plaintext to a provider-own `logger.warn`, which by
  // the issue #2176 contract reaches NO engine sink. Nothing else catches that:
  // it typechecks, `audit:provider-secret-mask:check` accepts anything DECLARED
  // `SecretMasker`, and a test passing no context cannot tell a defaulted
  // identity from an explicit one. Required makes the TYPECHECKER the fence at
  // every current and future call site. Issue #2007: a masker that fences
  // nothing is worse than none, because its presence stops the next author
  // looking. Found by the go-to-k/cdkd#3291 security review.
  maskSecrets: SecretMasker
): OnDemandThroughput {
  // The TRANSFORM lives in {@link narrowOnDemandCeilings} since issue #3287,
  // because {@link indexCeilingForSend}'s change detector must give the
  // identical answer and must not log. This method is the
  // ANNOUNCING adapter: same transform, plus the per-member warning.
  const { block, dropped } = narrowOnDemandCeilings(declared);
  for (const { member, raw } of dropped) {
    this.warnUnusableOnDemandCeiling(scope, member, raw, maskSecrets);
  }
  return block as OnDemandThroughput;
}

/**
 * Announce an `OnDemandThroughput` member a forwarder DROPPED (issue
 * [#3265](https://github.com/go-to-k/cdkd/issues/3265)).
 *
 * A SEPARATE sentence from {@link warnUnusableProvisionedCapacity}, and the
 * difference is the load-bearing part rather than a wording preference: that
 * one can promise "DynamoDB will reject the request naming this member",
 * because both `ProvisionedThroughput` members are REQUIRED wherever the
 * block is declared. Both `OnDemandThroughput` members are OPTIONAL, so the
 * same promise would send the user looking for a failure that may never come.
 *
 * What it says instead is PER PATH, because the outcome genuinely differs and
 * an earlier revision of this message asserted ONE outcome for all of them —
 * wrongly in both directions (the review of this issue):
 *
 *  - on a CREATE the table comes up with no maximum for the dropped half;
 *  - on an UPDATE DynamoDB KEEPS whatever maximum the table already carries.
 *    Omitting a member is NOT "no maximum" there — `-1` is AWS's documented
 *    way to REMOVE one (`OnDemandThroughput`'s own SDK model doc), so a
 *    dropped member silently leaves the live ceiling in force;
 *  - when NO member survived, the block {@link coerceOnDemandCeilingsForSend}
 *    sends is EMPTY. AWS's model says at all four of this provider's send
 *    positions that "if you use this parameter, you must specify
 *    `MaxReadRequestUnits`, `MaxWriteRequestUnits`, or both", which reads
 *    like a LOUD failure — and it is NOT enforced.
 *
 *    MEASURED us-east-1 2026-09-17, on the go-to-k/cdkd#3291 review's
 *    request: `CreateTable` with `OnDemandThroughput: {}` and
 *    `BillingMode: PAY_PER_REQUEST` is ACCEPTED, the table reaches ACTIVE,
 *    and `DescribeTable` reports NO `OnDemandThroughput` at all. So the
 *    all-rejected case is the SILENT one, not the loud one: the deploy goes
 *    green with no ceiling applied.
 *
 *    That matters because it is a REGRESSION IN LOUDNESS introduced by this
 *    very change. Before it, a `' 100 '` reached AWS as a string in a Long
 *    field and the request FAILED, certainly. After it, the value is dropped
 *    and the deploy succeeds. The warning is therefore the ONLY signal a user
 *    gets for the all-rejected case, which is why it is emitted per member
 *    and why its text was corrected to say so rather than to promise a
 *    failure that does not come.
 *
 * The caller cannot tell the three cases apart from inside the member loop,
 * so the message names all three rather than asserting the one it cannot
 * know.
 *
 * And it names the residual: where the request does succeed, state keeps the
 * spelling the template declared and `cdkd drift` reports it until the
 * template is corrected. `-1` is called out because a user who meant the
 * removal must not read "spell it as a decimal integer" as excluding it.
 *
 * The CloudFormation clause is HEDGED ("is expected to"), and deliberately.
 * The live A/B that settled this grammar was run on
 * `ProvisionedThroughput.ReadCapacityUnits`, not on `MaxReadRequestUnits`.
 * Both are Integer members of the same type validated at the same properties
 * layer, so the extrapolation is sound and is what issue #3265 reasons from --
 * but it IS an extrapolation, and a user-facing string asserting it flatly
 * about an unmeasured property would be the kind of claim nothing downstream
 * re-checks. Measure it and the hedge can go. Raised by the
 * go-to-k/cdkd#3291 spec review.
 */
export function warnUnusableOnDemandCeiling(
  this: DynamoDBTableProvider,
  scope: string,
  member: string,
  raw: unknown,
  // REQUIRED for the reason `coerceOnDemandCeilingsForSend` states above: this
  // is the sink the leaked value would reach.
  maskSecrets: SecretMasker
): void {
  // ONE masked sink (issue #1997) — BUILT, not an inline wrap, with the raw
  // declared member masked leaf by leaf first, for the reason
  // `warnUnusableProvisionedCapacity` states: the member arrives RESOLVED, so
  // a `{{resolve:secretsmanager:...}}` scalar is plaintext here and
  // `JSON.stringify` escaping it would put it past a message-level mask.
  const warn = (message: string): void => this.logger.warn(maskSecrets(message));
  warn(
    `${scope}: OnDemandThroughput.${member} ${JSON.stringify(
      maskLeafValue(raw, maskSecrets)
    )} is not an Integer CloudFormation accepts ` +
      `(an optional sign and decimal digits only — no surrounding whitespace, hex, exponent ` +
      `or decimal point), so it was NOT sent and NO ceiling was substituted for it. ` +
      `Both OnDemandThroughput members are OPTIONAL to DynamoDB, so — unlike a ` +
      `ProvisionedThroughput member — AWS does not necessarily reject the request, and what ` +
      `happens next depends on the path: a CREATE gets no maximum for this half; an UPDATE ` +
      `KEEPS whatever maximum the table already carries, since only an explicit -1 removes ` +
      `one; and if NEITHER member was usable the block is sent EMPTY, which AWS ACCEPTS ` +
      `and stores as no maximum at all, so the deploy ` +
      `SUCCEEDS with no ceiling applied. cdkd's state keeps the value the template ` +
      `declared and \`cdkd drift\` reports the difference until the template is corrected; ` +
      `CloudFormation is expected to refuse the same template at properties validation. ` +
      `Check for an unresolved intrinsic, or spell the value as a decimal integer ` +
      `(\`-1\` removes an existing maximum).`
  );
}

/**
 * Announce a `ProvisionedThroughput` member a forwarder DROPPED (issue
 * [#3147](https://github.com/go-to-k/cdkd/issues/3147); widened to the
 * per-index create forwarder by issue
 * [#3255](https://github.com/go-to-k/cdkd/issues/3255)).
 *
 * Called from all THREE forwarders that can drop one — `create()`'s
 * `CreateTable` table-level block, the BillingMode flip's `UpdateTable`
 * table-level block, and `create()`'s per-`GlobalSecondaryIndexes[]` block —
 * because the member vanishes at each independently, and a drop that is
 * never announced is the silent-narrowing class this file's other warn arms
 * exist to end. `scope` names the resource or the index, so a table with
 * several GSIs says WHICH one.
 *
 * It says NO capacity was substituted, which is the whole decision: the
 * sibling `AWS::DynamoDB::GlobalTable` forwarders announce a 5/5 FALLBACK,
 * and saying the wrong one of those two would send a user looking for a
 * table that does not exist. {@link tableCapacityForSend}'s doc carries why
 * this type differs.
 */
export function warnUnusableProvisionedCapacity(
  this: DynamoDBTableProvider,
  scope: string,
  member: string,
  raw: unknown,
  maskSecrets: SecretMasker
): void {
  // ONE masked sink (issue #1997) — BUILT, not an inline wrap, with the raw
  // declared member masked leaf by leaf first. See
  // `coerceWarmThroughputForSend` for why both layers are needed: the member
  // arrives RESOLVED, so a `{{resolve:secretsmanager:...}}` scalar is
  // plaintext here, and `JSON.stringify` escaping it would put it past a
  // message-level mask.
  const warn = (message: string): void => this.logger.warn(maskSecrets(message));
  warn(
    `${scope}: ProvisionedThroughput.${member} ${JSON.stringify(
      maskLeafValue(raw, maskSecrets)
    )} is not an Integer CloudFormation accepts ` +
      `(an optional sign and decimal digits only — no surrounding whitespace, hex, exponent ` +
      `or decimal point), so it was NOT sent and NO capacity was substituted for it. ` +
      `DynamoDB requires both members wherever a PROVISIONED ProvisionedThroughput block is ` +
      `declared — the table itself, and every GlobalSecondaryIndexes[] entry of a PROVISIONED ` +
      `table — and will reject the request naming this one; CloudFormation refuses the same ` +
      `template at properties validation. ` +
      `Check for an unresolved intrinsic, or spell the value as a decimal integer.`
  );
}

/**
 * Announce a `WarmThroughput` the send rule REFUSES (PR review of issue
 * #1768) — the missing half of tightening {@link isSendableWarmThroughput}.
 *
 * Called at all FOUR write sites (`create()`, the table-level `update()`
 * branch, the GSI `Create` action, and {@link warmThroughputOpFor}) because
 * the value vanishes at each of them independently. `scope` names the
 * resource or the index so a table with several GSIs says WHICH one.
 *
 * Silent for an ABSENT or FALSY value — see {@link isRefusedWarmThroughput}
 * for why those two are not this warning's business.
 */
export function warnRefusedWarmThroughput(
  this: DynamoDBTableProvider,
  scope: string,
  value: unknown,
  maskSecrets: SecretMasker
): void {
  // ONE masked sink (issue #1997) — BUILT, not an inline wrap, with the raw
  // declared value masked leaf by leaf first. See
  // `coerceWarmThroughputForSend` for why both layers are needed.
  const warn = (message: string): void => this.logger.warn(maskSecrets(message));
  if (!isRefusedWarmThroughput(value)) return;
  warn(
    `${scope}: the declared WarmThroughput ${JSON.stringify(
      maskLeafValue(value, maskSecrets)
    )} carries no usable ` +
      `ReadUnitsPerSecond or WriteUnitsPerSecond, so it was NOT sent — DynamoDB accepts ` +
      `only those two members and rejects a request without either. Check for a misspelled ` +
      `member name or an unresolved intrinsic. Nothing else on this resource was affected.`
  );
}

/**
 * Should this per-index capacity `Update` be SKIPPED because the value is
 * AWS's on-demand `{0, 0}` placeholder rather than a capacity anyone asked
 * for (issue #1767 review)?
 *
 * Newly reachable BECAUSE of the #1767 readback change, on the transition
 * residual `getDriftUnknownPaths` deliberately carries. A pre-#1767
 * `observedProperties` baseline holds the whole `DescribeTable` index
 * description, including the `{NumberOfDecreasesToday: 0, ReadCapacityUnits:
 * 0, WriteCapacityUnits: 0}` block AWS reports for every index of a
 * PAY_PER_REQUEST table (the #1571 trap). `cdkd drift --revert` hands that
 * blob to `update()` as the DESIRED side against the trimmed readback as the
 * previous side, so the values differ, `liveCapacityComparable` is false on
 * PAY_PER_REQUEST (which disables the #1630 idempotency skip), and the op
 * that goes out asks AWS for capacity 0 — which AWS rejects, since the
 * minimum is 1. Before #1767 both sides carried the same blob, compared
 * equal, and no revert was ever offered.
 *
 * Deliberately NOT gated on the live billing mode. A `{0, 0}` request is
 * refused by AWS in EITHER mode, so gating would leave the same doomed call
 * reachable for a PROVISIONED table whose stale baseline carries the
 * placeholder. Scoped tightly to BOTH members resolving to 0: any other
 * capacity — including a half-declared or malformed one — still goes out and
 * is answered by AWS, the fail-OPEN direction this file uses everywhere.
 *
 * NOT caller-blind any more (issue #3728). A TEMPLATE-borne `{0, 0}` never
 * reaches this skip: `update()` REFUSES it at pre-flight, before any call —
 * see {@link zeroCapacityIndexRefusal} — exactly as `create()` fails loudly
 * on the same value. What still arrives here is the two NON-template desired
 * bags, and for them the warn-skip stands:
 *
 *  - `cdkd drift --revert` (`UpdateContext.desiredFromAwsReadback`), the
 *    caller this skip was written for: its desired bag is a pre-#1767
 *    `observedProperties` blob, which the user cannot edit from the template.
 *  - The rollback executor's two revert arms (`UpdateContext.replayingState`,
 *    since issue #3141): their desired bag is `previousState.properties`, a
 *    cdkd STATE record, so a refusal would make the table un-rollbackable with
 *    no template-side remedy (issues #1545 / #1552).
 *
 * The lie the skip tells on those paths is bounded and self-surfacing. AWS
 * never accepted `{0, 0}` at create either, so no live table can be holding
 * it; and where the value would actually matter — a PROVISIONED table, whose
 * indexes hold a real capacity — recording `{0, 0}` diverges from the readback
 * and `cdkd drift` REPORTS it. On a PAY_PER_REQUEST table the recorded
 * `{0, 0}` matches what `DescribeTable` reports for every index anyway, so
 * there is no divergence to hide.
 *
 * Until issue #3728 this skip was caller-blind: when it was written no
 * discriminator separated a template deploy from the rollback revert arms
 * (they set neither flag), and the template path warn-skipped too. That
 * reason expired with #3141, and the template path now takes the refusal.
 */
export function skipZeroCapacityIndexUpdate(
  this: DynamoDBTableProvider,
  // `unknown`, for the reason {@link indexScopeAt} exists (the
  // go-to-k/cdkd#3380 security review, m1): the caller's key comes from an
  // unchecked `g.IndexName!` cast, so a numeric name reaches this warning.
  indexName: unknown,
  physicalId: string,
  requested: ProvisionedThroughput | undefined,
  maskSecrets: SecretMasker
): boolean {
  if (!isZeroCapacityPlaceholder(requested)) return false;
  // ONE masked sink (issue #1997) — BUILT, not an inline wrap. `indexName` is
  // a RESOLVED property value (the declared `IndexName`) and is ALSO masked
  // raw: a DynamoDB index name may be as short as 3 characters, which is
  // below `MIN_NEEDLE_LENGTH` (4), so the sink's substring scan can never
  // reach it and only the whole-value mask can.
  const warn = (message: string): void => this.logger.warn(maskSecrets(message));
  warn(
    `${this.indexScopeAt(indexName, physicalId, maskSecrets)}: the requested ProvisionedThroughput is ` +
      `{ReadCapacityUnits: 0, WriteCapacityUnits: 0}, which is AWS's on-demand placeholder rather ` +
      `than a capacity DynamoDB accepts (the minimum is 1), so no per-index throughput update was ` +
      `sent. This usually means the value came from a state record an older cdkd release wrote — a ` +
      `\`cdkd drift --revert\` of such a record, or a rollback replaying it. Re-run ` +
      `\`cdkd deploy\` (or \`cdkd drift --accept\`) to refresh the record.`
  );
  return true;
}

/**
 * The per-index `WarmThroughput` this update should send, or `undefined`
 * (issue #1768, one nesting level down from the table-level branch).
 *
 * `applyGsiUpdates` used to send only `ProvisionedThroughput` on both of its
 * arms, while `readCurrentState` emits a
 * declared per-index `WarmThroughput` — so a template declaring one had it
 * silently dropped on every index add / change, `cdkd drift` reported the
 * difference forever, and `--revert` emitted no op at all and exited 0
 * claiming success. That silent-success shape is worse than the loud
 * table-level dead end #1768 fixed.
 *
 * The rules mirror the table-level branch exactly:
 *  - only a value the write side would SEND at all
 *    ({@link isSendableWarmThroughput});
 *  - only when it CHANGED against the recorded previous entry (an absent
 *    previous — the adopted-index arm — is treated as changed, since nothing
 *    was recorded to compare with);
 *  - never a DECREASE. Measured live (us-east-1, 2026-08-13) on a GSI AWS
 *    reports `{12000, 4000}` for: a `WarmThroughput`-only `Update` action
 *    with `{12000, 4000}` is ACCEPTED (so the action shape needs no
 *    `ProvisionedThroughput` companion), while `{6000, 2000}` is rejected
 *    with `Requested ReadUnitsPerSecond for WarmThroughput for index gsi1 is
 *    lower than current WarmThroughput, decreasing WarmThroughput is not
 *    supported`.
 */
export function warmThroughputOpFor(
  this: DynamoDBTableProvider,
  // `unknown`, NOT `string` (the go-to-k/cdkd#3380 review, n4). The declared
  // `string` was a LIE -- the caller's map is keyed by `g.IndexName!` off an
  // UNCHECKED template cast, so an unquoted YAML `IndexName: 2024` arrives
  // here as a NUMBER -- and that lie is exactly what licensed the bare
  // `maskSecrets(indexName)` this method used to open with, which threw
  // `text.replace is not a function` and took the whole deploy down from a
  // diagnostic path. Typed honestly, a future direct interpolation does not
  // compile and {@link indexScopeAt} stays the only way in.
  indexName: unknown,
  physicalId: string,
  desired: GlobalSecondaryIndex,
  previous: GlobalSecondaryIndex | undefined,
  live: GlobalSecondaryIndexDescription | undefined,
  maskSecrets: SecretMasker
): WarmThroughput | undefined {
  // ONE masked sink per level for every line in this method (issue #1997).
  // Built rather than inline-wrapped because this method had TWO further
  // interpolations of `indexName` below the two masked calls — a `debug` and
  // a `warn` — that carried no masking at all: the value was masked where it
  // entered a helper's `scope` string and then printed RAW here. That is the
  // exact failure the sink shape exists to prevent, so the sink is the fix
  // rather than a third inline wrap.
  const warn = (message: string): void => this.logger.warn(maskSecrets(message));
  const debug = (message: string): void => this.logger.debug(maskSecrets(message));
  // Built ONCE and reused, so the two helper `scope` strings and the two
  // lines below cannot drift apart again.
  //
  // Through {@link indexScopeAt} rather than a bare `maskSecrets(indexName)`,
  // which is what this line was and which CRASHED THE DEPLOY. `indexName` is
  // a key of a map built from `g.IndexName!` off an UNCHECKED template cast,
  // so an unquoted YAML `IndexName: 2024` arrives here as a NUMBER — and the
  // real masker is a `String.prototype.replace` call that THROWS on one. The
  // call is EAGER, ahead of every gate, and `warmThroughputOpFor` runs for
  // every same-name and adopted index, so an ordinary capacity edit on such a
  // table took the whole update down with `text.replace is not a function`
  // wrapped in a `Failed to update DynamoDB table` — the exact guard the
  // review of issue #3255 added `indexScopeAt` for, at a site that sweep
  // missed. Found by the issue #3287 round, whose own new scope made the
  // numeric-name case reachable from a second arm. The rendered string is
  // byte-identical for a string name.
  //
  // The go-to-k/cdkd#3380 security review swept the CLASS rather than this
  // method: three more bare `maskSecrets(name)` interpolations survived here
  // (the two adopted-index warns and
  // {@link skipZeroCapacityIndexUpdate}'s refusal), and all three now read
  // through the same helper. The population is derivable rather than
  // remembered — `grep -nE 'maskSecrets\((name|indexName)\)'` over this file
  // returns only the two lines INSIDE {@link indexScope} /
  // {@link indexScopeAt} themselves.
  //
  // The remaining index-name interpolations split THREE ways, and an earlier
  // revision of this comment claimed they were all `typeof`-filtered, which
  // was FALSE (round 2's S2). They are: filtered at the source (the removal
  // and flip warnings read live names behind
  // `typeof indexName !== 'string'`); masked by a SINK (`applyGsiUpdates`'
  // own `warn` / `debug`, and the debug pair was routed through
  // {@link indexScopeAt} in that same round); or a THROWN message, which
  // `DeployEngine` masks at all three of its sinks. `prevByName` /
  // `desiredByName` are keyed under a TRUTHINESS filter, not a `typeof` one,
  // so a numeric name really does reach them — which is what made the debug
  // pair a live plaintext leak under `--verbose`.
  const scope = this.indexScopeAt(indexName, physicalId, maskSecrets);
  const requested = desired.WarmThroughput;
  // The UNCHANGED gate runs FIRST, so the refusal below warns once per
  // CHANGED value rather than on every deploy that touches any other index
  // (PR review round 5) — the same "once per changed value" meaning the
  // table-level placement has. Comparing the raw values is right here: an
  // unsendable value is unchanged only against an identically unsendable
  // one.
  if (
    previous !== undefined &&
    JSON.stringify(previous.WarmThroughput) === JSON.stringify(requested)
  ) {
    return undefined;
  }
  // Coerced ONCE, before the gates, so the dropped-member announcement lands
  // even when a gate then skips the send (PR review round 7) — the skip
  // messages quote `sendable`, which is narrower than what the user wrote,
  // and without this the missing member went unmentioned entirely.
  const sendable = this.coerceWarmThroughputForSend(scope, requested, maskSecrets);
  if (sendable === undefined) {
    this.warnRefusedWarmThroughput(scope, requested, maskSecrets);
    return undefined;
  }
  // Both gates below read the COERCED spec, not the raw declared value (PR
  // review round 6). They are what cdkd would actually PUT ON THE WIRE, and
  // analysing anything else is analysing a request that is never made: for
  // `{Read: 12000, Write: 'abc'}` the raw value made both gates bail on the
  // unusable member and fail OPEN, so an already-matching `{Read: 12000}`
  // still cost a redundant per-index `UpdateTable` plus a full index-ACTIVE
  // wait. Safe in direction either way — the point is that the analysis now
  // describes the actual request. The table-level branch reads the same rule
  // off the same helper (round 7), where getting it wrong FAILED the deploy
  // rather than costing a call.
  // AWS already holds exactly this — the per-index twin of the capacity
  // path's `liveCapacityAlreadyMatches` (issue #1630), and the reason the
  // carried #1767 residual is a no-op again. Without it, a `drift --revert`
  // of a pre-#1767 state blob (whose index entry holds the whole
  // `DescribeTable` description, `WarmThroughput` included) emitted a pure
  // re-assert `UpdateTable` PER INDEX, each followed by a full index-ACTIVE
  // wait. Compared member by member for the same reason the capacity twin is:
  // the live side is a description carrying an AWS-managed `Status`, so a
  // structural compare could never match and the skip would be dead code that
  // only LOOKED safe.
  if (warmThroughputAlreadyMatches(sendable, live?.WarmThroughput)) {
    debug(
      `${scope} already carries the requested warm ` +
        `throughput in AWS; skipping its WarmThroughput Update`
    );
    return undefined;
  }
  if (isWarmThroughputDecrease(sendable, live?.WarmThroughput)) {
    // The remedy names the TEMPLATE, not "the value AWS holds": this arm is
    // reached both by a template that declares a per-index WarmThroughput and
    // by a `--revert` / rollback replaying a state blob for an index whose
    // template declares NONE, and telling the second user to "set the index's
    // WarmThroughput to the value AWS holds" is advice about a property their
    // template does not have (PR review). The deploy-path caveat is the same
    // one the table-level twin carries: a successful deploy re-captures
    // `observedProperties` through this provider's own `readCurrentState`, so
    // the drift signal this leaves standing is erased by the next deploy.
    warn(
      `${scope}: the requested WarmThroughput ` +
        `${JSON.stringify(maskDeep(sendable, maskSecrets))} is lower than the ${JSON.stringify(
          maskDeep(
            {
              ReadUnitsPerSecond: live?.WarmThroughput?.ReadUnitsPerSecond,
              WriteUnitsPerSecond: live?.WarmThroughput?.WriteUnitsPerSecond,
            },
            maskSecrets
          )
        )} DynamoDB currently holds for that index. Warm throughput only ever RISES with an ` +
        `index's traffic and cannot be lowered — AWS rejects the UpdateTable with "decreasing ` +
        `WarmThroughput is not supported" — so it was NOT sent and every other change on this ` +
        `table still applied. On a deploy this warning may be the only signal you get: a ` +
        `successful deploy re-captures AWS's current value as the drift baseline. If your ` +
        `template declares this index's WarmThroughput, set it to the value AWS holds (or ` +
        `remove it, which AWS treats as keeping the last-set value); if it does not, the value ` +
        `came from a cdkd state record and 'cdkd deploy' (or 'cdkd drift --accept') refreshes it.`
    );
    return undefined;
  }
  return sendable;
}

/**
 * Should this update SKIP its `WarmThroughput` call because the value would
 * DECREASE what AWS already holds (issue #1768)?
 *
 * Thin logging wrapper over the pure {@link isWarmThroughputDecrease}, kept
 * on the class so the warning is emitted at exactly the one site that skips.
 *
 * The warning is what makes the skip honest, and its WORDING is checked
 * against the code rather than assumed (PR review): the first version
 * promised `cdkd drift` would "keep reporting the difference", which is TRUE
 * on the `drift --revert` path — nothing is recorded, so the observed
 * baseline still holds the declared value — and FALSE on the DEPLOY path.
 * A successful deploy re-captures `observedProperties` through this same
 * `readCurrentState` (`deploy-engine.ts`'s `kickOffObservedCapture`), which
 * for a DECLARING template emits AWS's CURRENT value, so the very deploy
 * that warned equalises the comparison and the next `cdkd drift` reports the
 * resource clean. The message therefore says the warning may be the only
 * signal, and names both numbers so the template edit needs no second look.
 */
export function skipWarmThroughputDecrease(
  this: DynamoDBTableProvider,
  logicalId: string,
  physicalId: string,
  // The COERCED spec, never the raw declared bag (PR review round 7): this
  // gate decides whether to make a call, so it has to analyse the call that
  // would be made. The message below quotes it for the same reason — a user
  // reading "the requested WarmThroughput {...}" needs the request, not a
  // bag containing members cdkd already dropped.
  desired: WarmThroughput,
  live: WarmThroughputUnits | undefined,
  maskSecrets: SecretMasker
): boolean {
  // ONE masked sink (issue #1997) — BUILT, not an inline wrap. `desired` is
  // the COERCED numeric spec, so it carries no plaintext of its own, but a
  // built sink means any interpolation added later is masked by construction
  // rather than by the author remembering.
  const warn = (message: string): void => this.logger.warn(maskSecrets(message));
  if (!isWarmThroughputDecrease(desired, live)) return false;
  warn(
    `AWS::DynamoDB::Table ${logicalId}: the requested WarmThroughput ` +
      `${JSON.stringify(maskDeep(desired, maskSecrets))} is lower than the ${JSON.stringify(
        maskDeep(
          {
            ReadUnitsPerSecond: live?.ReadUnitsPerSecond,
            WriteUnitsPerSecond: live?.WriteUnitsPerSecond,
          },
          maskSecrets
        )
      )} DynamoDB currently holds for table ${physicalId}. Warm throughput only ever RISES ` +
      `with a table's traffic and cannot be lowered — AWS rejects the UpdateTable with ` +
      `"decreasing WarmThroughput is not supported" — so it was NOT sent and every other ` +
      `change on this resource still applied. On a deploy this warning may be the only signal ` +
      `you get: a successful deploy re-captures AWS's current value as the drift baseline, so ` +
      `the next 'cdkd drift' reports this table clean (a 'cdkd drift --revert' records nothing ` +
      `and keeps reporting it). To make cdkd and AWS agree, set WarmThroughput to the value ` +
      `AWS holds (or remove the property, which AWS treats as keeping the last-set value).`
  );
  return true;
}
