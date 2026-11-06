import type { WarmThroughput } from '@aws-sdk/client-dynamodb';
import {
  WARM_THROUGHPUT_MEMBERS,
  coerceWarmThroughput as coerceWarmThroughputSpec,
  toFiniteNumber,
} from '../../dynamodb-warm-throughput.js';
import { dynamicReferenceTokens, SECRET_MASK } from '../../../deployment/secret-redaction.js';
import { isPlainCapacityBlock } from './table-helpers.js';

/**
 * Is this `WarmThroughput` VALUE one cdkd will actually put on the wire
 * (issue #1760)?
 *
 * The single definition of the send rule. `create()` and `update()` call it
 * where they used to inline `if (properties['WarmThroughput'])`, and the
 * bag-level {@link declaresWarmThroughput} below calls it too — so the drift
 * side cannot answer "the template declared one" for a value the write side
 * silently skips. That divergence is not hypothetical: with the two sites
 * spelled independently, respelling either as `!== undefined` leaves every
 * test green while the pair starts disagreeing on `WarmThroughput: null`, and
 * the disagreement re-creates the exact phantom drift this issue removed —
 * cdkd sends nothing, AWS still computes 12000/4000, the readback emits it as
 * though the template had asked, and `--revert` can never clear it because the
 * write gate skips the falsy value. Keep this the ONLY spelling of the rule.
 *
 * It USED to be bare truthiness, "because that is what the wire has always
 * done". PR review of issue #1768 showed that is not a rule, it is the absence
 * of one: `WarmThroughput: {}` and `WarmThroughput: 'nonsense'` are both truthy,
 * so they went out as `UpdateTable{WarmThroughput: {}}` /
 * `{WarmThroughput: 'nonsense'}` — a call that can only be rejected, and one
 * cdkd would repeat on every deploy. Harmless-looking at the table level (one
 * doomed call, loudly); newly REACHABLE per index once issue #1768's per-index
 * send path landed, where the same value is emitted once per index. So the rule
 * is now: at least ONE of the two user-settable members must resolve to a
 * finite number.
 *
 * Still not `!== undefined`, and still ONE spelling for the write sites and the
 * drift side both: a value this refuses is a value cdkd does not send, so the
 * readback must not emit AWS's computed value as though the template had asked
 * for it. A YAML-borne numeric STRING is accepted, by the shared coercion's own
 * number reader ({@link toFiniteNumber}, in `../dynamodb-warm-throughput.ts` —
 * the one this file's capacity paths read too), because `'12000'` genuinely
 * means 12000.
 */
export function isSendableWarmThroughput(value: unknown): boolean {
  return coerceWarmThroughput(value) !== undefined;
}

/**
 * Turn a template-declared `WarmThroughput` into the NUMERIC spec cdkd puts on
 * the wire, or `undefined` when nothing in it is usable (PR review round 5).
 *
 * The send sites used to forward the declared value VERBATIM while
 * {@link isSendableWarmThroughput} accepted a numeric STRING, so the predicate
 * blessed the one shape it exists to stop: `{ReadUnitsPerSecond: '12000'}` went
 * out as `"WarmThroughput":{"ReadUnitsPerSecond":"12000"}` — a string in a Long
 * field, which DynamoDB rejects — and the drift side then answered "declared"
 * for it, so the readback emitted AWS's numeric value and the table drifted on
 * every run. Coercing rather than dropping string support is the better answer
 * for a stringly-typed CFn template (`'12000'` genuinely means 12000, and
 * `create()`'s table-level `ProvisionedThroughput` already coerces one line
 * over), and it makes the quoted form WORK instead of merely warning.
 *
 * Per MEMBER, so a bad one cannot take a good one with it, and never `NaN`:
 * the shared coercion's number reader is {@link toFiniteNumber} — a number or
 * a numeric string, everything else rejected — so a member that
 * does not resolve is OMITTED from the spec
 * and reported in `dropped` for the caller to announce. AWS accepts a
 * one-member `WarmThroughput` (measured us-east-1, 2026-08-13: an
 * `UpdateTable` carrying only `ReadUnitsPerSecond` is a valid request shape —
 * it was refused for being a DECREASE, not for its shape), so a partial send
 * is a real request rather than a malformed one.
 *
 * {@link isSendableWarmThroughput} is defined AS this function's success, so
 * the drift-side gate and the write-side coercion cannot answer differently —
 * structurally, not by hand. That identity is exact at the BLOCK level and
 * ONLY there (PR review round 6, where the earlier wording was measured and
 * found broader than the truth): both sides ask "is any member usable", so a
 * block cdkd sends is a block drift compares, and a block cdkd refuses is one
 * drift ignores.
 *
 * PER MEMBER the readback answers through {@link sentWarmThroughputMembers}
 * (issue #3777): `{ReadUnitsPerSecond: 12000, WriteUnitsPerSecond: 'abc'}`
 * sends only `ReadUnitsPerSecond`, so the readback emits only that member, and
 * {@link DynamoDBTableProvider.canonicalizeDriftPair} trims, by the same
 * declaration, a baseline that still carries the unsent one. {@link DynamoDBTableProvider.coerceWarmThroughputForSend}
 * names the dropped member when the value is APPLIED. The drift side asks
 * {@link wasSentWarmThroughput}, which also counts a member recorded as a
 * `{{resolve:...}}` token (whole or embedded) or the state mask: `cdkd drift` reads the RECORDED
 * bag, where a member the deploy resolved and sent is still a string.
 *
 * NOT a drift fix either way: state records what the TEMPLATE said, so a
 * `properties` baseline still holds `'12000'` against a numeric readback and
 * the comparator's `deepEqual` is strict about that. It is the generic
 * stringly-typed-CFn class (every numeric property has it), not something this
 * coercion can reach from the write side.
 *
 * The RULE moved to `../dynamodb-warm-throughput.ts` when
 * `AWS::DynamoDB::GlobalTable` needed the same one (issue #1857); this is the
 * local adapter onto the shape this file's four call sites already read, so
 * the behaviour, the signature and the tests are unchanged. The shared
 * coercion always reports `droppedMembers`, including on a total refusal —
 * that arm is unreachable from here, since a `usable === 0` outcome maps to
 * `undefined` and the names go with it, which is exactly what this file did
 * before.
 */
export function coerceWarmThroughput(
  value: unknown
): { spec: WarmThroughput; dropped: string[] } | undefined {
  const { spec, droppedMembers } = coerceWarmThroughputSpec(value);
  if (spec === undefined) return undefined;
  return { spec, dropped: [...droppedMembers] };
}

/**
 * Is this member value a RECORDED stand-in for a value cdkd resolved and sent:
 * a string carrying a `{{resolve:...}}` token, whole or embedded
 * (`'{{resolve:ssm:p}}000'`), or the state redaction mask? State keeps a
 * dynamic reference unresolved, and `cdkd drift` hands `readCurrentState` that
 * recorded bag, so a member the deploy SENT reads there as a string the send
 * coercion refuses. Counting it as sent keeps it compared: whether the
 * resolved value was a usable number is not knowable offline, and the failure
 * to avoid is hiding a member cdkd did send. A resolved bag (deploy, import)
 * carries neither.
 */
export function isRecordedSentStandIn(value: unknown): boolean {
  return (
    typeof value === 'string' && (dynamicReferenceTokens(value).length > 0 || value === SECRET_MASK)
  );
}

/**
 * The `WarmThroughput` members cdkd put on the wire for this declared value
 * (issue #3777): the members of {@link coerceWarmThroughput}'s spec, plus any
 * member whose recorded value is a {@link isRecordedSentStandIn} (it was
 * resolved and sent). The readback emits exactly these, table-level and per
 * index, so a member that did not resolve is never compared against AWS's
 * computed value for it, and a member that did is never hidden.
 */
export function sentWarmThroughputMembers(value: unknown): ReadonlySet<string> {
  const members = new Set<string>();
  const coerced = coerceWarmThroughput(value);
  for (const member of WARM_THROUGHPUT_MEMBERS) {
    if (coerced?.spec[member] !== undefined) members.add(member);
    else if (isPlainCapacityBlock(value) && isRecordedSentStandIn(value[member])) {
      members.add(member);
    }
  }
  return members;
}

/**
 * The DRIFT-side "did cdkd send this block" question: {@link isSendableWarmThroughput}
 * on a resolved bag, widened to a recorded bag whose sent members are
 * dynamic-reference stand-ins. The write sites keep the send predicate; they
 * only ever see resolved values, so the two answer alike on the same deploy.
 */
export function wasSentWarmThroughput(value: unknown): boolean {
  return sentWarmThroughputMembers(value).size > 0;
}

/**
 * Read back a live `WarmThroughput` description as its CFn block: the two
 * user-settable members only (`Status` is AWS-managed), and only those in
 * `members` — every member when `members` is `undefined`, the uninformative-bag
 * fallback. `undefined` when nothing is left, since the readback never emits
 * an empty block.
 */
export function readbackWarmThroughput(
  live: WarmThroughputUnits,
  members: ReadonlySet<string> | undefined,
  declared?: unknown
): Record<string, unknown> | undefined {
  // go-to-k/cdkd#5606: after a raise on an existing table or index, AWS keeps
  // reporting the OLD value until `Status` leaves `UPDATING`, and the post-deploy
  // baseline is read in that window: it froze the old value, and the next drift
  // reported the raise. So the declared value is read as where it is moving, and
  // a live value above it stands. AWS also accepted a request below a raise in
  // flight; where that settles is unmeasured, and the settled read reports it.
  // Measured on a single-region table and a GSI, us-east-1, 2026-11-01.
  const moving = live.Status === 'UPDATING' ? coerceWarmThroughput(declared)?.spec : undefined;
  const out: Record<string, unknown> = {};
  for (const member of WARM_THROUGHPUT_MEMBERS) {
    const value = live[member];
    if (value === undefined) continue;
    if (members !== undefined && !members.has(member)) continue;
    const target = moving?.[member];
    out[member] = target === undefined ? value : Math.max(value, target);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Trim a drift BASELINE's `WarmThroughput` block to the members cdkd SENT
 * (issue #3777), for {@link DynamoDBTableProvider.canonicalizeDriftPair}.
 *
 * `sent` is {@link sentWarmThroughputMembers} of the recorded declaration, the
 * same set the readback emits from. A member outside it is one cdkd never
 * sent: a record captured before the per-member readback carries AWS's
 * computed value for it, and a `properties` fallback baseline the template's
 * unresolvable value. The trim is keyed on the DECLARATION, never on what the
 * live block omitted, so a sent member AWS transiently fails to report stays
 * in the baseline and is reported. An empty `sent` (nothing declared, or an
 * uninformative bag) or a malformed baseline block is left alone, and a
 * current-shape baseline comes back by identity.
 */
export function trimUnsentWarmMembers(baselineBlock: unknown, sent: ReadonlySet<string>): unknown {
  if (sent.size === 0 || !isPlainCapacityBlock(baselineBlock)) return baselineBlock;
  const unsent = WARM_THROUGHPUT_MEMBERS.filter(
    (member) => member in baselineBlock && !sent.has(member)
  );
  if (unsent.length === 0) return baselineBlock;
  const trimmed = { ...baselineBlock };
  for (const member of unsent) delete trimmed[member];
  return trimmed;
}

/**
 * Is this a `WarmThroughput` the user WROTE that the tightened send rule then
 * refuses (PR review of issue #1768)?
 *
 * The set of values whose OUTCOME this issue changed, and the exact set the
 * write sites must warn about. Tightening {@link isSendableWarmThroughput}
 * closed a doomed-call class, and silently: a template declaring
 * `{ ReadUnitsPerSecnd: 20000 }` (a member typo), `'nonsense'`, `{}`, or an
 * unresolved intrinsic used to reach AWS and be REJECTED BY NAME, and now
 * vanishes with no warning, no debug line, and a green deploy — the "loud
 * failure for a quiet lie" trade the adopted-index arm in `applyGsiUpdates`
 * refuses, and out of step with every other skip in this file
 * ({@link DynamoDBTableProvider.skipZeroCapacityIndexUpdate},
 * {@link DynamoDBTableProvider.skipWarmThroughputDecrease}), which all warn.
 *
 * ABSENT is silent, because that is the ordinary case — the overwhelming
 * majority of templates declare no warm throughput at all and must not be
 * nagged. FALSY-but-present (`null`, `''`, `false`, `0`) is silent too: those
 * were skipped silently BEFORE this issue as well (`Boolean(value)` was the
 * whole rule), so they are not a behavior this PR changed and warning about
 * them would be a new noise source, not a restored signal.
 */
export function isRefusedWarmThroughput(value: unknown): boolean {
  if (value === undefined) return false;
  if (!value) return false;
  return !isSendableWarmThroughput(value);
}

/**
 * Does the DESIRED bag carry enough for the drift side to answer "what did the
 * template declare"?
 *
 * An ABSENT or EMPTY bag answers NO: `drift.ts` passes `properties ?? {}`, and
 * other callers pass nothing at all, so `{}` means "nothing recorded" rather
 * than "this key is absent" (the contract on {@link ResourceProvider.getDriftUnknownPaths}).
 * Every gate below falls back to the pre-gate behavior on a NO, since dropping
 * a key on the strength of a bag that was never populated is unrecoverable
 * phantom drift in the other direction.
 *
 * Named once and shared by the table-level `WarmThroughput` gate (issue #1760)
 * and the per-index gates (issue #1767) so the two cannot answer the
 * "uninformative bag" question differently.
 */
export function desiredBagIsInformative(properties?: Record<string, unknown>): boolean {
  return properties !== undefined && Object.keys(properties).length > 0;
}

/**
 * Does this desired-property bag DECLARE a table-level `WarmThroughput`?
 *
 * The drift-side question ("did cdkd send one for this resource"), answered by
 * {@link isSendableWarmThroughput} so it cannot drift from the write path.
 *
 * An ABSENT or EMPTY bag answers TRUE: the caller supplied nothing to decide
 * with, so both drift consumers keep the pre-#1760 behavior (emit it, compare
 * it) rather than dropping a key on the strength of a bag that was never
 * passed. That fallback is exactly why the write sites take the VALUE-level
 * predicate instead of this one — handing `create()` an absent bag must send
 * nothing, not send `undefined`.
 *
 * Note the empty-bag arm carries the same residual as the declared arm
 * (issue #1768): a `properties: {}` record keeps the AWS-computed value in its
 * snapshot, so a `--revert` on such a resource can re-send it. Left as-is
 * rather than dropped, because a bag that was never populated is not evidence
 * the template declared nothing — and a wrong DROP here is unrecoverable
 * phantom drift, while the residual is a loud, per-resource revert failure.
 */
export function declaresWarmThroughput(properties?: Record<string, unknown>): boolean {
  if (!desiredBagIsInformative(properties)) return true;
  // `properties !== undefined &&` rather than a non-null `!` (PR review round
  // 4). The two are identical at runtime — `desiredBagIsInformative` already
  // proved it.
  return properties !== undefined && wasSentWarmThroughput(properties['WarmThroughput']);
}

/**
 * The two user-settable members of a warm-throughput description, spelled
 * structurally so the same predicate serves the table-level
 * `TableWarmThroughputDescription` and the per-index
 * `GlobalSecondaryIndexWarmThroughputDescription`. Both add an AWS-managed
 * `Status`, read only by {@link readbackWarmThroughput}.
 */
export interface WarmThroughputUnits {
  ReadUnitsPerSecond?: number | undefined;
  WriteUnitsPerSecond?: number | undefined;
  Status?: string | undefined;
}

// `isWarmThroughputDecrease` — the measured `decreasing WarmThroughput is not
// supported` guard (issue #1768) — moved to `../dynamodb-warm-throughput.ts`
// when `AWS::DynamoDB::GlobalTable` needed the same rule (issue #1857). It is
// the SAME function, verbatim: the two providers' independent spellings were
// compared over every declared / mixed / equal / above / absent-live /
// unusable-live / empty-spec combination and agreed on all of them, which is
// precisely why keeping two was the risk. The live side still passes a
// `...WarmThroughputDescription`, whose AWS-managed `Status` the shared
// two-member parameter type ignores exactly as {@link WarmThroughputUnits}
// did.

/**
 * Does the warm throughput AWS currently holds already equal what this update
 * would request (issue #1768 PR review)?
 *
 * The warm-throughput twin of {@link liveCapacityAlreadyMatches}, and compared
 * the same way and for the same reason: the live side is a
 * `...WarmThroughputDescription` carrying an AWS-managed `Status` alongside the
 * two units, so a structural compare against the two-member desired object
 * could never match and the suppression would be dead code that only LOOKED
 * safe.
 *
 * Only the members the desired side DECLARES are compared — an omitted member
 * is not part of the request, so it cannot make the request differ. Anything
 * unresolvable fails OPEN (the call is still issued): the worst case is a
 * redundant `UpdateTable`, whereas a false MATCH silently drops a
 * warm-throughput raise the user asked for. As in
 * {@link isWarmThroughputDecrease}, only the LIVE side can reach that arm now
 * that the desired side is a coerced spec.
 *
 * Deliberately NOT applied to the TABLE-level branch, which still sends an
 * equal re-assert: that is measured-accepted by AWS (us-east-1, 2026-08-13 —
 * re-asserting `{12000, 4000}` returns a normal `TableDescription`), it is ONE
 * call rather than one per index, and its own change gate already requires the
 * value to differ from the recorded previous. The per-index path is where the
 * redundancy multiplies and where the carried #1767 residual reaches it.
 */
export function warmThroughputAlreadyMatches(
  // The COERCED spec, as in {@link isWarmThroughputDecrease}.
  desired: WarmThroughput,
  live: WarmThroughputUnits | undefined
): boolean {
  if (live === undefined) return false;
  let compared = 0;
  // The shared member tuple, not a local re-spelling of it: the order and the
  // membership are the same fact {@link isWarmThroughputDecrease} compares on.
  for (const member of WARM_THROUGHPUT_MEMBERS) {
    if (desired[member] === undefined) continue;
    const wanted = toFiniteNumber(desired[member]);
    const current = toFiniteNumber(live[member]);
    if (wanted === undefined || current === undefined) return false;
    if (wanted !== current) return false;
    compared++;
  }
  // A request declaring no comparable member is not "already matching"; it is
  // one this predicate cannot speak about, so it takes the fail-open answer.
  return compared > 0;
}
