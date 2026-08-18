import {
  DynamoDBClient,
  CreateTableCommand,
  DeleteTableCommand,
  DescribeTableCommand,
  DescribeContinuousBackupsCommand,
  DescribeContributorInsightsCommand,
  DescribeKinesisStreamingDestinationCommand,
  DescribeTimeToLiveCommand,
  DisableKinesisStreamingDestinationCommand,
  EnableKinesisStreamingDestinationCommand,
  GetResourcePolicyCommand,
  ListTagsOfResourceCommand,
  PutResourcePolicyCommand,
  DeleteResourcePolicyCommand,
  TagResourceCommand,
  UntagResourceCommand,
  UpdateContributorInsightsCommand,
  UpdateTableCommand,
  type UpdateTableCommandInput,
  UpdateContinuousBackupsCommand,
  type PointInTimeRecoverySpecification,
  UpdateTimeToLiveCommand,
  ResourceNotFoundException,
  type ContributorInsightsAction,
  type ContributorInsightsMode,
  type CreateTableCommandInput,
  type KeySchemaElement,
  type AttributeDefinition,
  type GlobalSecondaryIndex,
  type GlobalSecondaryIndexUpdate,
  type UpdateGlobalSecondaryIndexAction,
  type LocalSecondaryIndex,
  type StreamSpecification,
  type OnDemandThroughput,
  type WarmThroughput,
  type Tag,
  type ProvisionedThroughput,
  type ProvisionedThroughputDescription,
  type GlobalSecondaryIndexDescription,
  type LocalSecondaryIndexDescription,
} from '@aws-sdk/client-dynamodb';
import { getLogger } from '../../utils/logger.js';
import { getAwsClients } from '../../utils/aws-clients.js';
import { ProvisioningError } from '../../utils/error-handler.js';
import { generateResourceName } from '../resource-name.js';
import { assertRegionMatch, type DeleteContext } from '../region-check.js';
import { normalizeAwsTagsToCfn, resolveExplicitPhysicalId } from '../import-helpers.js';
import { replayWarn, requireConfigString } from '../config-shape.js';
import {
  WARM_THROUGHPUT_MEMBERS,
  coerceWarmThroughput as coerceWarmThroughputSpec,
  isWarmThroughputDecrease,
  toFiniteNumber,
} from '../dynamodb-warm-throughput.js';
import {
  DELETE_INDEX_BUSY_REARM_MAX_ATTEMPTS,
  DELETE_INDEX_WAIT_PROCEED_NOTE,
  deleteTableWithIndexBusyRetry,
  waitForIndexesSettled,
} from '../dynamodb-index-busy-delete.js';
import type {
  ResourceProvider,
  ResourceCreateResult,
  ResourceUpdateResult,
  ResourceImportInput,
  ResourceImportResult,
  CreateContext,
} from '../../types/resource.js';

/**
 * AWS DynamoDB Table Provider
 *
 * Implements resource provisioning for AWS::DynamoDB::Table using the DynamoDB SDK.
 * WHY: The CC API polls for DynamoDB table creation with exponential backoff
 * (1s->2s->4s->8s->10s), but we can poll DescribeTable directly with shorter
 * intervals, eliminating the CC API intermediary overhead and reducing total
 * wait time.
 */
/**
 * Map CloudFormation's `SSESpecification` shape to the DynamoDB SDK's.
 *
 * The CFn property names the enable flag `SSEEnabled`, but the SDK
 * `CreateTableCommandInput.SSESpecification` field is `Enabled`. Passing the
 * CFn shape verbatim makes the SDK silently ignore the unknown `SSEEnabled`
 * key, so the table is created with AWS-owned (default) encryption instead of
 * the requested AWS-managed / customer-managed KMS encryption — a silent
 * security downgrade with no error. `SSEType` and `KMSMasterKeyId` keep the
 * same names across CFn and the SDK.
 *
 * Returns `undefined` for an absent / non-object value so the caller omits the
 * field entirely. Exported for unit testing.
 */
export function mapSSESpecification(
  raw: unknown
): CreateTableCommandInput['SSESpecification'] | undefined {
  if (raw === null || typeof raw !== 'object') {
    return undefined;
  }
  const cfn = raw as { SSEEnabled?: unknown; SSEType?: unknown; KMSMasterKeyId?: unknown };
  const out: NonNullable<CreateTableCommandInput['SSESpecification']> = {};
  if (cfn.SSEEnabled !== undefined) {
    // CDK synthesizes a real boolean, but tolerate the stringified form.
    out.Enabled = cfn.SSEEnabled === true || cfn.SSEEnabled === 'true';
  }
  if (typeof cfn.SSEType === 'string') {
    out.SSEType = cfn.SSEType as NonNullable<
      CreateTableCommandInput['SSESpecification']
    >['SSEType'];
  }
  if (typeof cfn.KMSMasterKeyId === 'string') {
    out.KMSMasterKeyId = cfn.KMSMasterKeyId;
  }
  return out;
}

/**
 * Read one capacity member out of a per-index `ProvisionedThroughput` block,
 * returning `undefined` for anything that is not a usable number.
 *
 * Deliberately has NO default (issue #1588 review). The BillingMode-flip caller
 * suppresses the per-index update path for every index it handles, so a
 * defaulted capacity would never be corrected by a later call and would land in
 * cdkd state as if the template had declared it. Returning `undefined` routes
 * the index to the same warn-and-omit path an absent block takes, letting AWS
 * name it — the CFn-handler outcome.
 *
 * CFn is stringly typed, so a numeric string is accepted and coerced; `NaN` /
 * `Infinity` / objects / unresolved intrinsics are not.
 */
function readCapacityNumber(block: unknown, member: string): number | undefined {
  if (typeof block !== 'object' || block === null || Array.isArray(block)) return undefined;
  const raw = (block as Record<string, unknown>)[member];
  if (raw === undefined || raw === null || raw === '') return undefined;
  if (typeof raw !== 'number' && typeof raw !== 'string') return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

/**
 * Whether a desired `GlobalSecondaryIndexes[]` entry declares BOTH capacity
 * members usably — the same test the BillingMode flip's per-index block applies
 * before it forwards the index, expressed as a predicate for the pre-flip
 * removal's look-ahead (issue #1617).
 *
 * BOTH members are required, exactly as in the flip block: an entry declaring
 * only one is treated like an absent one there, so accepting it here would let
 * the pre-flip delete run ahead of a flip AWS still rejects.
 */
function hasUsableDeclaredCapacity(entry: Record<string, unknown> | undefined): boolean {
  const declared = entry?.['ProvisionedThroughput'];
  return (
    readCapacityNumber(declared, 'ReadCapacityUnits') !== undefined &&
    readCapacityNumber(declared, 'WriteCapacityUnits') !== undefined
  );
}

/**
 * Whether the desired TABLE-level `ProvisionedThroughput` is one the flip can
 * actually send (issue #1617 PR review).
 *
 * Deliberately NOT {@link hasUsableDeclaredCapacity}: the flip defaults each
 * member to 5 when absent (`Number(pt['ReadCapacityUnits'] ?? 5)`), so a
 * half-declared TABLE capacity is sendable while a half-declared per-INDEX one
 * is not.
 *
 * It mirrors the flip's GATE as well as its arithmetic, which the first version
 * did not and a second review round caught — both halves of that miss are real:
 *
 * - the gate is plain TRUTHINESS (`properties['ProvisionedThroughput']`), so a
 *   non-object truthy value sends `{5, 5}` and SUCCEEDS. Requiring a plain
 *   object refused it and skipped a removal that would have been fine.
 * - a DECLARED member that coerces to `0` (`''`, `false`, `[]`) is finite, so
 *   an arithmetic-only check accepted it — while AWS rejects a capacity below
 *   1, which is precisely the deterministic rejection this predicate exists to
 *   keep a delete from running ahead of.
 */
function hasUsableTableCapacity(value: unknown): boolean {
  // Falsy: the flip sends no throughput at all and AWS rejects the mode change.
  if (!value) return false;
  if (typeof value !== 'object' || Array.isArray(value)) return true;
  const pt = value as Record<string, unknown>;
  // Each member the template DECLARES has to be a capacity AWS accepts; an
  // absent one takes the flip's own `?? 5` default and is fine.
  for (const member of ['ReadCapacityUnits', 'WriteCapacityUnits']) {
    if (pt[member] === undefined) continue;
    const n = Number(pt[member]);
    if (!Number.isFinite(n) || n < 1) return false;
  }
  return true;
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
function liveCapacityAlreadyMatches(
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

/**
 * `DescribeTable` poll budget (seconds, 1 poll/s) after an ordinary
 * `UpdateTable` — capacity, TTL, tags, table class. Calibrated on those and
 * sufficient for them.
 */
const TABLE_ACTIVE_WAIT_ATTEMPTS = 60;

/**
 * The same budget for a BillingMode FLIP, which DynamoDB settles on a
 * different order of magnitude (measured 2026-08-11: a PAY_PER_REQUEST ->
 * PROVISIONED flip exceeded 60s and failed the deploy). Kept SEPARATE so a
 * genuinely wedged capacity edit still fails in a minute rather than ten.
 */
const BILLING_FLIP_ACTIVE_WAIT_ATTEMPTS = 600;

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
function isSendableWarmThroughput(value: unknown): boolean {
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
 * PER MEMBER it does NOT hold, and the residual is real:
 * `{ReadUnitsPerSecond: 12000, WriteUnitsPerSecond: {Ref: 'Unset'}}` sends only
 * `ReadUnitsPerSecond`, while `readCurrentState` emits AWS's computed value for
 * BOTH members and `getDriftUnknownPaths` leaves the path compared — so AWS's
 * `WriteUnitsPerSecond`, which cdkd never sent, is compared against the
 * template forever. It fails OPEN — the difference is REPORTED by `cdkd drift`,
 * never hidden — and {@link DynamoDBTableProvider.coerceWarmThroughputForSend}
 * names the dropped member when the value is APPLIED.
 *
 * How loud, precisely (measured, PR review round 7 — an earlier version of this
 * sentence said "on every deploy" and was falsified by the code two hundred
 * lines down): every warn in this provider sits behind a CHANGE gate, so the
 * drop is announced on the deploy that INTRODUCES it and is silent on every
 * repeat deploy of the same value, while the drift report persists. Loud once,
 * then a standing drift entry — not a per-deploy nag, and not silent either.
 * Closing the residual means emitting per-member, which is a `readCurrentState`
 * shape change with its own drift-baseline migration — deliberately not folded
 * into this issue.
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
function coerceWarmThroughput(
  value: unknown
): { spec: WarmThroughput; dropped: string[] } | undefined {
  const { spec, droppedMembers } = coerceWarmThroughputSpec(value);
  if (spec === undefined) return undefined;
  return { spec, dropped: [...droppedMembers] };
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
function isRefusedWarmThroughput(value: unknown): boolean {
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
function desiredBagIsInformative(properties?: Record<string, unknown>): boolean {
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
function declaresWarmThroughput(properties?: Record<string, unknown>): boolean {
  if (!desiredBagIsInformative(properties)) return true;
  // `properties !== undefined &&` rather than a non-null `!` (PR review round
  // 4). The two are identical at runtime — `desiredBagIsInformative` already
  // proved it — but `scripts/gen-handled-property-wiring.ts` does not walk
  // through a `NonNullExpression`, so the `!` spelling made this read
  // INVISIBLE to that critic and silently dropped `WarmThroughput`'s
  // `getDriftUnknownPaths` / `readCurrentState` evidence from the checked-in
  // matrix. A property whose drift side no critic can see is a property whose
  // next regression nothing reports.
  return properties !== undefined && isSendableWarmThroughput(properties['WarmThroughput']);
}

/**
 * The two user-settable members of a warm-throughput description, spelled
 * structurally so the same predicate serves the table-level
 * `TableWarmThroughputDescription` and the per-index
 * `GlobalSecondaryIndexWarmThroughputDescription` (both add an AWS-managed
 * `Status` this never reads).
 */
interface WarmThroughputUnits {
  ReadUnitsPerSecond?: number | undefined;
  WriteUnitsPerSecond?: number | undefined;
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
function warmThroughputAlreadyMatches(
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

/**
 * Reverse-map one live secondary-index description to its CloudFormation
 * shape (issue #1767).
 *
 * `DescribeTable` describes an index with a superset of the CFn members —
 * measured live, us-east-1 2026-08-13, on a `PAY_PER_REQUEST` table with one
 * GSI and no capacity settings:
 *
 * ```json
 * { "IndexName": "gsi1",
 *   "KeySchema": [{ "AttributeName": "gsipk", "KeyType": "HASH" }],
 *   "Projection": { "ProjectionType": "ALL" },
 *   "IndexStatus": "CREATING", "Backfilling": true,
 *   "ProvisionedThroughput": { "NumberOfDecreasesToday": 0, "ReadCapacityUnits": 0, "WriteCapacityUnits": 0 },
 *   "IndexSizeBytes": 0, "ItemCount": 0,
 *   "IndexArn": "arn:aws:dynamodb:...:table/.../index/gsi1",
 *   "WarmThroughput": { "ReadUnitsPerSecond": 12000, "WriteUnitsPerSecond": 4000, "Status": "UPDATING" } }
 * ```
 *
 * NONE of `IndexStatus` / `Backfilling` / `IndexSizeBytes` / `ItemCount` /
 * `IndexArn` is a CFn property, the `ProvisionedThroughput` block is AWS's
 * `{0, 0}` on-demand placeholder (the #1571 trap), and the per-index
 * `WarmThroughput` is the AWS-computed value the table-level gate already
 * refuses to surface (issue #1760). Forwarding the description verbatim put
 * all of them into the drift comparison, and — unlike a top-level key the
 * baseline lacks — they are members of an ARRAY the baseline DOES carry, which
 * `deepEqual` compares positionally, so every one of them participated.
 *
 * The mapper is therefore an ALLOW-LIST rather than a deny-list: a member AWS
 * adds later is dropped by construction instead of silently joining the
 * comparison.
 *
 * `desired` is the DESIRED bag's entry for the SAME `IndexName` (matched by
 * name, never by position — the list is an unordered set, see
 * {@link DynamoDBTableProvider.getDriftUnorderedPaths}). The three throughput
 * blocks are emitted only when that entry declares them, the #1760 shape one
 * nesting level down; `bagInformative` false means the caller supplied no bag
 * to decide with and every block is emitted, cleaned of its AWS-managed
 * members.
 *
 * Known residual, unchanged by this fix: CFn's per-index
 * `ContributorInsightsSpecification` has no `DescribeTable` counterpart (it
 * needs a per-index `DescribeContributorInsights` call), so a template
 * declaring one still cannot converge against a `properties` baseline. It is
 * ALSO dropped on the write side, since `create()` forwards the CFn blob to
 * `CreateTable` and the SDK serializer discards the unknown member — still
 * true after round 6 taught that path to coerce `WarmThroughput`, because the
 * entry is rebuilt with a SPREAD and every other member, known or not, rides
 * along unchanged. Filed as issue
 * [#1782](https://github.com/go-to-k/cdkd/issues/1782).
 */
function reverseMapSecondaryIndex(
  live: GlobalSecondaryIndexDescription | LocalSecondaryIndexDescription,
  desired: Record<string, unknown> | undefined,
  bagInformative: boolean
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (live.IndexName !== undefined) out['IndexName'] = live.IndexName;
  // KeySchema is order-SIGNIFICANT (HASH before RANGE) and its elements carry
  // only CFn members, so the ORDER and the members pass through unchanged —
  // but COPIED, not aliased: every other member here is a fresh object, and
  // handing the caller a live reference into the SDK response would let a
  // later mutation of the emitted snapshot reach back into it.
  if (live.KeySchema !== undefined) {
    out['KeySchema'] = live.KeySchema.map((element) => ({ ...element }));
  }
  // `Projection` is rebuilt member by member, fixing its key ORDER as
  // [ProjectionType, NonKeyAttributes]. That matters because `applyGsiUpdates`
  // compares this shape with `JSON.stringify`, which is key-order sensitive: a
  // mismatched order reads as a CHANGED `Projection` and hits the "cannot
  // modify in place" THROW instead of a no-op.
  //
  // Which order actually differs was measured, and the round-6 version of this
  // note named the wrong one (PR review round 7). Two facts:
  //  - a READBACK is always [ProjectionType, NonKeyAttributes] — the SDK
  //    deserializer rebuilds each struct in schema order — so a stale
  //    pre-#1767 `observedProperties` baseline, itself a readback, CANNOT
  //    produce the flip. That was the path the earlier note named.
  //  - a TEMPLATE is the other way round: `aws-cdk-lib`'s generated renderer
  //    emits `{NonKeyAttributes, ProjectionType}` (verified in
  //    `aws-dynamodb/lib/dynamodb.generated.js`,
  //    `convertCfnTableProjectionPropertyToCloudFormation`, aws-cdk-lib
  //    2.264.0 — and the `CfnGlobalTable` twin does the same).
  //
  // So the reachable shape is a TEMPLATE-ordered value meeting a
  // READBACK-ordered one inside that compare — a `--revert` on a record with no
  // `observedProperties`, where the desired side is built from the readback
  // while the recorded previous is template-shaped. Pre-existing, and REDUCED
  // by this issue (a readback used to carry the whole SDK description, so the
  // two sides differed in far more than key order). Left as a note rather than
  // a key-order-independent compare, which changes the WRITE path's equality
  // rule and belongs with the canonicalization work in #1812.
  if (live.Projection !== undefined) {
    const projection: Record<string, unknown> = {};
    if (live.Projection.ProjectionType !== undefined) {
      projection['ProjectionType'] = live.Projection.ProjectionType;
    }
    if (live.Projection.NonKeyAttributes !== undefined) {
      // COPIED for the same reason `KeySchema` is, two blocks up: nothing this
      // mapper returns may alias the SDK response.
      projection['NonKeyAttributes'] = [...live.Projection.NonKeyAttributes];
    }
    if (Object.keys(projection).length > 0) out['Projection'] = projection;
  }

  // The LSI description has no throughput members at all (an LSI shares the
  // table's capacity), so this half applies only to a GSI. NARROWED rather
  // than cast across the union (PR review): a cast reads GSI-only members off
  // an LSI and merely happens to find `undefined`, so it would keep
  // typechecking if a member ever moved.
  //
  // PER BLOCK, and that is the whole point (PR review round 4). A single
  // `if (!('ProvisionedThroughput' in live)) return out;` guard ahead of all
  // three blocks type-checks identically and is WRONG: every member here is
  // SDK-optional, so a description carrying `OnDemandThroughput` +
  // `WarmThroughput` and no `ProvisionedThroughput` key — the ordinary
  // PAY_PER_REQUEST-with-caps shape — dropped BOTH declared blocks from the
  // readback and produced permanent one-sided drift, i.e. exactly the defect
  // this function exists to remove. Narrowing where each member is read keeps
  // the type safety and drops the coupling.
  if (
    'ProvisionedThroughput' in live &&
    indexDeclares(desired, 'ProvisionedThroughput', bagInformative) &&
    live.ProvisionedThroughput
  ) {
    const provisioned = live.ProvisionedThroughput;
    const pt: Record<string, unknown> = {};
    // The description's `NumberOfDecreasesToday` / `LastIncreaseDateTime` /
    // `LastDecreaseDateTime` are AWS bookkeeping and never surfaced — the same
    // trim the table-level `ProvisionedThroughput` emit already does.
    if (provisioned.ReadCapacityUnits !== undefined) {
      pt['ReadCapacityUnits'] = provisioned.ReadCapacityUnits;
    }
    if (provisioned.WriteCapacityUnits !== undefined) {
      pt['WriteCapacityUnits'] = provisioned.WriteCapacityUnits;
    }
    if (Object.keys(pt).length > 0) out['ProvisionedThroughput'] = pt;
  }
  if (
    'OnDemandThroughput' in live &&
    indexDeclares(desired, 'OnDemandThroughput', bagInformative) &&
    live.OnDemandThroughput
  ) {
    const onDemand = live.OnDemandThroughput;
    const odt: Record<string, unknown> = {};
    if (onDemand.MaxReadRequestUnits !== undefined) {
      odt['MaxReadRequestUnits'] = onDemand.MaxReadRequestUnits;
    }
    if (onDemand.MaxWriteRequestUnits !== undefined) {
      odt['MaxWriteRequestUnits'] = onDemand.MaxWriteRequestUnits;
    }
    if (Object.keys(odt).length > 0) out['OnDemandThroughput'] = odt;
  }
  if (
    'WarmThroughput' in live &&
    indexDeclares(desired, 'WarmThroughput', bagInformative) &&
    live.WarmThroughput
  ) {
    const warm = live.WarmThroughput;
    const wt: Record<string, unknown> = {};
    // `Status` is AWS-managed, exactly as at the table level.
    if (warm.ReadUnitsPerSecond !== undefined) {
      wt['ReadUnitsPerSecond'] = warm.ReadUnitsPerSecond;
    }
    if (warm.WriteUnitsPerSecond !== undefined) {
      wt['WriteUnitsPerSecond'] = warm.WriteUnitsPerSecond;
    }
    if (Object.keys(wt).length > 0) out['WarmThroughput'] = wt;
  }
  return out;
}

/**
 * Does the DESIRED entry for one index declare this block (issue #1767)?
 *
 * The question is always "would cdkd SEND this block", because that is what
 * makes AWS's readback value explainable by the template — so each block is
 * answered by the write rule that actually governs it, never by a second
 * spelling of one:
 *
 *  - `WarmThroughput` routes through {@link isSendableWarmThroughput}, the
 *    predicate EVERY per-index write path calls — the `Create` / `Update` GSI
 *    actions in `applyGsiUpdates` AND `create()`'s `CreateTable` forward, which
 *    maps each entry through
 *    {@link DynamoDBTableProvider.coerceIndexWarmThroughputForCreate}. It is
 *    TIGHTER than truthiness (at least one member resolving to a finite
 *    number), so `WarmThroughput: {}` is neither sent nor emitted on any path.
 *    An earlier version of this bullet carved out the TABLE-create path as an
 *    exception, and that exception was a DEFECT rather than a design: it also
 *    put a quoted `'12000'` on the wire as a string in a Long field, so one
 *    template failed on a fresh create and succeeded on a later GSI add. Fixed
 *    in PR review round 6; the carve-out is gone because the divergence is.
 *  - `ProvisionedThroughput` / `OnDemandThroughput` keep TRUTHINESS, which is
 *    what their write path does: those two members ARE still forwarded verbatim
 *    (the create-path mapper rewrites only `WarmThroughput`), and
 *    `applyGsiUpdates` gates on `gsi.ProvisionedThroughput` alone. Widening
 *    `isSendableWarmThroughput` over them would be wrong twice over — it reads
 *    members those blocks do not have (`ReadUnitsPerSecond` vs
 *    `ReadCapacityUnits`), so every declared capacity would read as undeclared.
 *
 * An UNINFORMATIVE bag answers TRUE for every block, keeping the pre-#1767
 * behavior for a caller that supplied nothing to decide with. A bag that IS
 * informative but names no entry for this index answers FALSE: the index
 * exists in AWS and not in the template, so nothing cdkd sent can explain any
 * of its throughput blocks.
 */
function indexDeclares(
  desired: Record<string, unknown> | undefined,
  key: string,
  bagInformative: boolean
): boolean {
  if (!bagInformative) return true;
  const value = desired?.[key];
  return key === 'WarmThroughput' ? isSendableWarmThroughput(value) : Boolean(value);
}

/**
 * Is this value an index list that DECLARES at least one index (issue #1767)?
 *
 * The ONE spelling of that question, shared by {@link desiredIndexEntriesByName}
 * (which decides what each live index is matched against) and by
 * {@link DynamoDBTableProvider.getDriftUnknownPaths} (which decides whether the
 * list is compared at all). Spelled independently they disagreed: a plain
 * truthiness test reads `[]` and an unresolved `{Fn::If: [...]}` as DECLARED —
 * so the list stayed in the comparison while the mapper, which needs an ARRAY
 * to match names against, treated the same value as declaring nothing and
 * stripped every throughput block from the readback. That is a one-sided
 * difference manufactured by the pair, which is the failure this file's
 * `isSendableWarmThroughput` header exists to prevent.
 *
 * Consequence worth stating: a template declaring `GlobalSecondaryIndexes: []`
 * now has that path IGNORED by the comparator, so an index created out of band
 * on such a table is not reported. That is the same answer the readback gives
 * (nothing the template declared can explain that index), and consistency
 * between the two is worth more than detection on a shape where the two used to
 * contradict each other.
 */
function declaresIndexList(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0;
}

/**
 * Index the DESIRED bag's secondary-index list by `IndexName` (issue #1767).
 *
 * Returns an empty map for anything {@link declaresIndexList} rejects — an
 * empty array, an unresolved intrinsic, a mis-nested template value — which
 * routes every live index through {@link indexDeclares}'s "declares nothing"
 * arm. Sharing that predicate with `getDriftUnknownPaths` is what keeps the
 * emission and the comparison from answering differently for the same bag.
 */
function desiredIndexEntriesByName(value: unknown): Map<string, Record<string, unknown>> {
  const byName = new Map<string, Record<string, unknown>>();
  if (!declaresIndexList(value)) return byName;
  for (const entry of value as unknown[]) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue;
    const name = (entry as Record<string, unknown>)['IndexName'];
    if (typeof name === 'string') byName.set(name, entry as Record<string, unknown>);
  }
  return byName;
}

/**
 * Test seam for the index-busy `DeleteTable` retry's backoff (issue #1931),
 * mirroring the sibling provider's export of the same name. Production leaves
 * `sleep` undefined so `withRetry`'s real schedule applies; a test injects a
 * no-op so the ~47s budget does not have to be waited out.
 *
 * One seam PER PROVIDER rather than one on the shared module: a `Table` test
 * that silences this backoff must not also silence the `GlobalTable` one, since
 * the two suites run in the same worker and a suite that stopped paying a delay
 * it meant to exercise fails silently — it just gets faster.
 */
export const deleteTableRetryDelays: { sleep?: (ms: number) => Promise<void> } = {};

export class DynamoDBTableProvider implements ResourceProvider {
  private dynamoDBClient: DynamoDBClient;
  private logger = getLogger().child('DynamoDBTableProvider');
  handledProperties = new Map<string, ReadonlySet<string>>([
    [
      'AWS::DynamoDB::Table',
      new Set([
        'TableName',
        'KeySchema',
        'AttributeDefinitions',
        'BillingMode',
        'ProvisionedThroughput',
        'OnDemandThroughput',
        'WarmThroughput',
        'StreamSpecification',
        'GlobalSecondaryIndexes',
        'LocalSecondaryIndexes',
        'SSESpecification',
        'Tags',
        'DeletionProtectionEnabled',
        'TableClass',
        'PointInTimeRecoverySpecification',
        'TimeToLiveSpecification',
        'ResourcePolicy',
        'KinesisStreamSpecification',
        'ContributorInsightsSpecification',
      ]),
    ],
  ]);

  unhandledByDesign = new Map<string, ReadonlyMap<string, string>>([
    [
      'AWS::DynamoDB::Table',
      new Map<string, string>([
        [
          'ImportSourceSpecification',
          'S3 import uses the separate ImportTable API (not CreateTable) and is create-only with no readback; deferred to a dedicated import-from-S3 PR',
        ],
      ]),
    ],
  ]);

  constructor() {
    const awsClients = getAwsClients();
    this.dynamoDBClient = awsClients.dynamoDB;
  }

  /**
   * Create a DynamoDB table
   */
  async create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    context?: CreateContext
  ): Promise<ResourceCreateResult> {
    this.logger.debug(`Creating DynamoDB table ${logicalId}`);

    const tableName =
      (properties['TableName'] as string | undefined) ||
      generateResourceName(logicalId, { maxLength: 255 });
    const keySchema = properties['KeySchema'] as KeySchemaElement[] | undefined;
    const attributeDefinitions = properties['AttributeDefinitions'] as
      | AttributeDefinition[]
      | undefined;

    if (!keySchema) {
      throw new ProvisioningError(
        `KeySchema is required for DynamoDB table ${logicalId}`,
        resourceType,
        logicalId
      );
    }

    if (!attributeDefinitions) {
      throw new ProvisioningError(
        `AttributeDefinitions is required for DynamoDB table ${logicalId}`,
        resourceType,
        logicalId
      );
    }

    // Tracks whether CreateTable succeeded this call, so the catch can roll
    // back a table whose post-ACTIVE config step (PITR / TTL) failed —
    // otherwise create() throws before returning the physicalId, the deploy
    // engine never learns the table exists, and it orphans.
    let tableCreated = false;

    try {
      // BillingMode (default: PROVISIONED). Guarded per issue #1545 — the
      // `|| 'PROVISIONED'` spelling silently substituted the default for a
      // present-but-unusable value (a `BillingMode: null`, an intrinsic the
      // resolver could not resolve, a hand-authored L1 typo), so a template
      // that says PAY_PER_REQUEST could create a continuously-billed
      // PROVISIONED table with no error anywhere. `BillingMode` is
      // ENUM-valued, so it does NOT take `coerceNumber`: a number here is a
      // template bug, not the unquoted-YAML scalar CFn coerces. The refusal
      // downgrades to a warning on a state replay (`replayWarn`) — the
      // rollback executor's reverse-replacement arm revives the OLD resource
      // from `previousState.properties`, which the user cannot edit from the
      // template. The read sits inside `create()`'s try, so the catch below
      // wraps the refusal into a ProvisioningError.
      const billingMode = requireConfigString(
        properties['BillingMode'],
        'PROVISIONED',
        'AWS::DynamoDB::Table BillingMode',
        replayWarn(this.logger, context)
      );

      const createParams: CreateTableCommandInput = {
        TableName: tableName,
        KeySchema: keySchema,
        AttributeDefinitions: attributeDefinitions,
        BillingMode: billingMode as 'PROVISIONED' | 'PAY_PER_REQUEST',
      };

      // Provisioned throughput (required when BillingMode is PROVISIONED)
      if (billingMode === 'PROVISIONED') {
        const pt = properties['ProvisionedThroughput'] as Record<string, unknown> | undefined;
        createParams.ProvisionedThroughput = {
          ReadCapacityUnits: Number(pt?.['ReadCapacityUnits'] ?? 5),
          WriteCapacityUnits: Number(pt?.['WriteCapacityUnits'] ?? 5),
        };
      }

      // On-demand throughput caps (PAY_PER_REQUEST tables). Rides directly
      // on CreateTable — unlike PITR / TTL it is NOT a post-ACTIVE control-
      // plane call. Pass it through verbatim when present; AWS validates the
      // PAY_PER_REQUEST-only constraint.
      if (properties['OnDemandThroughput']) {
        createParams.OnDemandThroughput = properties['OnDemandThroughput'] as OnDemandThroughput;
      }

      // Warm throughput — pre-warmed read/write capacity. Like
      // OnDemandThroughput it rides directly on CreateTable (the
      // WarmThroughput input field), NOT a post-ACTIVE control-plane call.
      // Works with BOTH PROVISIONED and PAY_PER_REQUEST billing modes. The send
      // rule lives in `isSendableWarmThroughput` so the drift side cannot
      // answer "declared" for a value this line skips (issue #1760), and the
      // value is COERCED rather than forwarded verbatim so a template's quoted
      // `'12000'` reaches AWS as a number (PR review round 5).
      const createWarmThroughput = this.coerceWarmThroughputForSend(
        `AWS::DynamoDB::Table ${logicalId}`,
        properties['WarmThroughput']
      );
      if (createWarmThroughput) {
        createParams.WarmThroughput = createWarmThroughput;
      } else {
        this.warnRefusedWarmThroughput(
          `AWS::DynamoDB::Table ${logicalId}`,
          properties['WarmThroughput']
        );
      }

      // Stream specification - CDK omits StreamEnabled, SDK requires it
      if (properties['StreamSpecification']) {
        const streamSpec = properties['StreamSpecification'] as Record<string, unknown>;
        createParams.StreamSpecification = {
          StreamEnabled: true,
          StreamViewType: streamSpec['StreamViewType'] as string,
        } as StreamSpecification;
      }

      // Global secondary indexes. The array is forwarded as-is EXCEPT for each
      // entry's `WarmThroughput`, which is coerced by the same helper the four
      // update-side send sites use (PR review round 6). This was the FIFTH send
      // site and it was missed: a per-index `{ReadUnitsPerSecond: '12000'}`
      // reached `CreateTable` as the STRING `"12000"` in a Long field, and
      // `WarmThroughput: {}` as an empty block, both silently — so one template
      // SUCCEEDED when the index was added by a later update and FAILED on a
      // fresh create, which is the divergence the coercion exists to remove.
      //
      // Only `GlobalSecondaryIndexes` is mapped: `WarmThroughput` is not a
      // member of CFn's `LocalSecondaryIndex` (nor of the SDK's), so an LSI has
      // nothing to coerce, and rewriting those entries would be motion without
      // a shape behind it.
      //
      // A non-array value is passed through untouched rather than mapped: an
      // unresolved intrinsic or a mis-nested template value is AWS's to reject
      // by name, which is the pre-existing behavior and the fail-OPEN direction
      // this file takes everywhere.
      if (properties['GlobalSecondaryIndexes']) {
        const declaredGsis = properties['GlobalSecondaryIndexes'];
        createParams.GlobalSecondaryIndexes = Array.isArray(declaredGsis)
          ? (declaredGsis as GlobalSecondaryIndex[]).map((entry) =>
              this.coerceIndexWarmThroughputForCreate(logicalId, entry)
            )
          : (declaredGsis as GlobalSecondaryIndex[]);
      }

      // Local secondary indexes
      if (properties['LocalSecondaryIndexes']) {
        createParams.LocalSecondaryIndexes = properties[
          'LocalSecondaryIndexes'
        ] as LocalSecondaryIndex[];
      }

      // SSE specification. The CFn property uses `SSEEnabled`, but the SDK
      // CreateTable field is `Enabled` — passing the CFn shape verbatim makes
      // the SDK silently ignore the flag, so the table is created with
      // AWS-owned (default) encryption instead of the requested AWS-managed /
      // customer-managed KMS encryption. Map the field name explicitly.
      const sse = mapSSESpecification(properties['SSESpecification']);
      if (sse && Object.keys(sse).length > 0) {
        createParams.SSESpecification = sse;
      }

      // Tags
      if (properties['Tags']) {
        createParams.Tags = properties['Tags'] as Tag[];
      }

      // DeletionProtectionEnabled
      if (properties['DeletionProtectionEnabled'] !== undefined) {
        createParams.DeletionProtectionEnabled = properties['DeletionProtectionEnabled'] as boolean;
      }

      // Table class
      if (properties['TableClass']) {
        createParams.TableClass = properties['TableClass'] as
          | 'STANDARD'
          | 'STANDARD_INFREQUENT_ACCESS';
      }

      // ResourcePolicy — rides directly on CreateTable. The CFn shape is
      // `{ PolicyDocument: <JSON object> }`, but the SDK CreateTable input
      // takes a JSON STRING in its `ResourcePolicy` field, so serialize the
      // document. (update() uses the separate PutResourcePolicy /
      // DeleteResourcePolicy APIs — those are post-create only.)
      const createResourcePolicyDoc = this.extractResourcePolicyDocument(
        properties['ResourcePolicy']
      );
      if (createResourcePolicyDoc !== undefined) {
        createParams.ResourcePolicy = createResourcePolicyDoc;
      }

      await this.dynamoDBClient.send(new CreateTableCommand(createParams));
      tableCreated = true;

      this.logger.debug(`CreateTable initiated for ${tableName}, waiting for ACTIVE status`);

      // Poll until table is ACTIVE
      const tableInfo = await this.waitForTableActive(tableName);

      // PointInTimeRecoverySpecification and TimeToLiveSpecification do NOT
      // ride on CreateTable — both are separate post-ACTIVE API calls
      // (UpdateContinuousBackups / UpdateTimeToLive). AWS rejects them
      // against a still-CREATING table, which is why they run after the
      // wait above.
      await this.applyPointInTimeRecovery(
        tableName,
        properties['PointInTimeRecoverySpecification']
      );
      await this.applyTimeToLive(tableName, properties['TimeToLiveSpecification']);

      // KinesisStreamSpecification and ContributorInsightsSpecification are
      // also post-ACTIVE control-plane calls (separate
      // EnableKinesisStreamingDestination / UpdateContributorInsights APIs,
      // NOT fields on CreateTable), so they run after the ACTIVE wait too.
      await this.applyKinesisStreamingDestination(
        tableName,
        properties['KinesisStreamSpecification']
      );
      await this.applyContributorInsights(
        tableName,
        properties['ContributorInsightsSpecification']
      );

      this.logger.debug(`Successfully created DynamoDB table ${logicalId}: ${tableName}`);

      return {
        physicalId: tableName,
        attributes: {
          Arn: tableInfo.tableArn,
          TableId: tableInfo.tableId,
          StreamArn: tableInfo.streamArn,
          TableName: tableName,
        },
      };
    } catch (error) {
      // Atomicity: if CreateTable succeeded but a post-ACTIVE step (PITR / TTL)
      // failed, the table exists but create() is about to throw without
      // returning its physicalId — the deploy engine can't roll it back, so
      // best-effort delete it here to avoid an orphan + a "Table already
      // exists" failure on the next deploy attempt.
      if (tableCreated) {
        try {
          await this.dynamoDBClient.send(new DeleteTableCommand({ TableName: tableName }));
          this.logger.debug(`Rolled back partially-created DynamoDB table ${tableName}`);
        } catch (cleanupError) {
          this.logger.warn(
            `Failed to roll back partially-created DynamoDB table ${tableName}: ${
              cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
            }`
          );
        }
      }
      if (error instanceof ProvisioningError) {
        throw error;
      }
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to create DynamoDB table ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        tableName,
        cause
      );
    }
  }

  /**
   * Update a DynamoDB table
   *
   * DynamoDB tables have limited in-place update capabilities.
   * For immutable property changes (KeySchema, etc.), the deployment layer
   * handles replacement via DELETE + CREATE.
   */
  async update(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>
  ): Promise<ResourceUpdateResult> {
    this.logger.debug(`Updating DynamoDB table ${logicalId}: ${physicalId}`);

    try {
      // Get current table description for attributes (also gives us the
      // table ARN we need for tag mutations).
      const response = await this.dynamoDBClient.send(
        new DescribeTableCommand({ TableName: physicalId })
      );

      const table = response.Table;

      // The StreamArn attribute returned to the deploy engine. Seeded from the
      // DescribeTable snapshot above, but the StreamSpecification branch below
      // overwrites it after an update-time enable / disable / view-type change
      // so `Fn::GetAtt [Table, StreamArn]` resolves to the freshly-materialized
      // (or cleared) stream ARN rather than the pre-update value.
      let latestStreamArn = table?.LatestStreamArn;

      // Apply tag diff if changed. DynamoDB's TagResource takes
      // [{ Key, Value }] arrays; UntagResource takes a TagKeys list.
      if (table?.TableArn) {
        await this.applyTagDiff(
          table.TableArn,
          previousProperties['Tags'] as Array<{ Key?: string; Value?: string }> | undefined,
          properties['Tags'] as Array<{ Key?: string; Value?: string }> | undefined
        );
      }

      // BillingMode / ProvisionedThroughput — both ride on UpdateTable and are
      // mutable (CFn createOnly = only TableName + ImportSourceSpecification).
      // Fire a SINGLE UpdateTable when either changed so:
      //  - a pure ProvisionedThroughput capacity bump (RCU/WCU change, mode
      //    stays PROVISIONED) actually reaches AWS instead of being silently
      //    dropped (state would otherwise record the new value as applied and
      //    the next deploy would see no diff — the throw-not-swallow / no-
      //    silent-drop rule);
      //  - a pure BillingMode switch (PROVISIONED <-> PAY_PER_REQUEST) reaches
      //    AWS;
      //  - a combined switch-to-PROVISIONED-with-caps sends both in ONE call,
      //    BEFORE the OnDemandThroughput branch below, so AWS sees a consistent
      //    request rather than a throughput change against a still-PAY_PER_-
      //    REQUEST table (or vice versa).
      // Constraints AWS enforces and we mirror here: PAY_PER_REQUEST must NOT
      // carry ProvisionedThroughput; PROVISIONED requires it. Numeric capacity
      // values arrive as strings from the template, so coerce via Number()
      // (matches create()).
      //
      // Per-index ProvisionedThroughput rides this same UpdateTable on a flip
      // TO PROVISIONED, because AWS requires it there (issue #1588 — see the
      // measured A/B at the GlobalSecondaryIndexUpdates block below). A GSI-only
      // capacity change on an already-PROVISIONED table is still handled by the
      // dedicated per-index update path further down, not here.
      // TableClass rides the same UpdateTable and is mutable (CFn "Update
      // requires: No interruption"). It previously had NO update branch at
      // all, so a STANDARD <-> STANDARD_INFREQUENT_ACCESS switch was silently
      // dropped: the deploy reported success while AWS kept the old class,
      // and the next diff saw no change (state recorded the new class), so it
      // could never self-heal. Only send TableClass when it actually changed
      // — AWS rejects an UpdateTable that re-asserts the current class.
      // Normalize BOTH comparison sides first: an absent property means the
      // DynamoDB default (STANDARD), so an explicit-STANDARD <-> absent
      // template edit is NOT a real change and must not issue the doomed
      // same-class UpdateTable.
      const normalizeTableClass = (v: unknown): 'STANDARD' | 'STANDARD_INFREQUENT_ACCESS' =>
        typeof v === 'string' && v.length > 0
          ? (v as 'STANDARD' | 'STANDARD_INFREQUENT_ACCESS')
          : 'STANDARD';
      const tableClassChanged =
        normalizeTableClass(properties['TableClass']) !==
        normalizeTableClass(previousProperties['TableClass']);
      // Shape-guard the DESIRED BillingMode before the change detection
      // (issue #1545). WARN, never throw: `rollback-executor.ts` replays a
      // rollback via `provider.update(..., previousState.properties, ...)`,
      // so the desired bag here can itself be a historical state record — a
      // hard refusal would make the table un-rollbackable with no
      // template-side remedy. An UNUSABLE desired value falls back to the
      // PREVIOUS billing mode, NOT the create-path default: defaulting would
      // make the change detection see a real flip and silently re-price a
      // live table, which is strictly worse than the pre-guard behavior (AWS
      // rejecting the junk value loudly, billing unchanged). An ABSENT value
      // keeps meaning "no flip requested" (no BillingMode sent). The PREVIOUS
      // side stays unguarded on purpose: it comes from cdkd STATE, so
      // refusing a malformed value an older binary recorded would make the
      // stack permanently un-updatable.
      //
      // A state-recorded previous that is itself UNUSABLE is replaced by the
      // table's ACTUAL billing mode (issue #1552). The warn path above keeps
      // the deploy SUCCEEDING, so the engine records the junk desired value
      // as the new state and the NEXT update sees it as the previous side.
      // Comparing a corrected template against that junk previous
      // (`null !== 'PAY_PER_REQUEST'`) reads as a real flip and sends a
      // same-mode `UpdateTable`, which DynamoDB rejects when no capacity
      // change rides along — the deploy fails, state stays unchanged, and the
      // rejection repeats on every deploy. The `DescribeTable` at the top of
      // this method already holds the live mode, so this costs no extra call.
      // An ABSENT previous is NOT unusable: it legitimately means "no billing
      // mode recorded", and seeding it from AWS would turn a no-op update
      // into a spurious change. `BillingModeSummary` is itself absent on a
      // table created without an explicit mode, which is PROVISIONED — the
      // same default `readCurrentState` assumes.
      //
      // An ABSENT value on EITHER side normalizes to the CFn type default
      // PROVISIONED (issue #1553), which is also what `create()` above
      // substitutes — so the two paths now agree on what "no BillingMode in
      // the template" means. Before this the update path left it `undefined`,
      // and a template that REMOVED the property produced a change ("undefined
      // !== PAY_PER_REQUEST") that carried no mutable field: the
      // `updateInput.BillingMode = ...` assignment was gated on the value
      // being truthy, so `UpdateTable({TableName})` went out with nothing to
      // update and DynamoDB rejected it.
      //
      // The reset semantic is MEASURED, not inferred from the type default
      // (live CFn A/B, us-east-1, 2026-08-11): a table deployed with
      // `BillingMode: PAY_PER_REQUEST` and then UPDATE'd with the property
      // REMOVED is FLIPPED to PROVISIONED — and when the template declares no
      // `ProvisionedThroughput` either, the CFn resource handler fails the
      // stack with `Property ProvisionedThroughput cannot be empty` rather
      // than retaining the old mode. So "removal retains" was the wrong
      // reading; removal resets, exactly like `TableClass` below.
      // AWS's own view, named once: the previous-side resolution, the flip
      // detection and the ACTIVE-wait budget all have to agree on it.
      const liveBillingMode = (table?.BillingModeSummary?.BillingMode ?? 'PROVISIONED') as
        | 'PROVISIONED'
        | 'PAY_PER_REQUEST';
      const recordedPrevBillingMode = previousProperties['BillingMode'];
      const recordedPrevBillingModeUsable =
        recordedPrevBillingMode === undefined ||
        (typeof recordedPrevBillingMode === 'string' && recordedPrevBillingMode.trim() !== '');
      const prevBillingMode = (
        recordedPrevBillingModeUsable
          ? ((recordedPrevBillingMode as string | undefined) ??
            // An ABSENT recorded previous resolves differently depending on
            // what the DESIRED side asks for, and the asymmetry is deliberate
            // (review catch):
            //   - desired ALSO absent -> the type default. Both sides
            //     normalize to PROVISIONED, so BillingMode contributes no
            //     change of its own — though a ProvisionedThroughput diff can
            //     still carry the resolved mode along, which is what converges
            //     a live on-demand table the template never declared.
            //   - desired EXPLICIT -> the table's LIVE mode. Taking the type
            //     default here would compare PROVISIONED against an explicit
            //     `BillingMode: PROVISIONED` and SUPPRESS the flip entirely,
            //     leaving a live PAY_PER_REQUEST table on-demand forever while
            //     state records PROVISIONED. Reachable via `cdkd import`,
            //     whose state properties come from the template, not from AWS.
            (properties['BillingMode'] !== undefined ? liveBillingMode : 'PROVISIONED'))
          : liveBillingMode
      ) as 'PROVISIONED' | 'PAY_PER_REQUEST';
      if (!recordedPrevBillingModeUsable) {
        this.logger.warn(
          `AWS::DynamoDB::Table ${logicalId}: the recorded previous BillingMode is ` +
            `unusable (${JSON.stringify(recordedPrevBillingMode)}) — using the table's ` +
            `actual billing mode (${prevBillingMode}) as the comparison baseline for ` +
            `this update so a corrected template does not issue a same-mode UpdateTable.`
        );
      }
      let billingModeUnusable = false;
      // ABSENT resolves to the CFn type default (see the reset note above);
      // present-but-unusable still falls back to the PREVIOUS mode, because
      // there the template DID ask for something and defaulting a junk value
      // would silently re-price a live table.
      const requestedBillingMode =
        properties['BillingMode'] === undefined
          ? 'PROVISIONED'
          : requireConfigString(
              properties['BillingMode'],
              'PROVISIONED',
              'AWS::DynamoDB::Table BillingMode',
              {
                onUnusable: (message) => {
                  billingModeUnusable = true;
                  // "compared against", not "the table's current mode".
                  //
                  // This arm is only reachable with a DEFINED desired side (it
                  // sits in the `!== undefined` branch above), so
                  // `prevBillingMode` resolved to one of exactly two things:
                  // the RECORDED previous when the record holds a usable value,
                  // else the table's LIVE mode. The CFn type default is NOT
                  // reachable from here — that arm needs an absent desired side.
                  //
                  // NEITHER outcome justifies the word "current". The record can
                  // be stale (an out-of-band re-price), and the live mode is
                  // itself defaulted to PROVISIONED when `BillingModeSummary` is
                  // absent (see the note above `liveBillingMode`), so on both
                  // branches "current" asserts a `DescribeTable` reading the
                  // message may never have taken.
                  //
                  // The prefix matches every prefixed sibling in this provider —
                  // the recorded-previous baseline warn just above, the
                  // BillingMode-flip refusal, the GSI-removal guard and the
                  // flip-to-PROVISIONED capacity guard: without it, a stack with
                  // more than one AWS::DynamoDB::Table gives neither the user
                  // nor an integ assertion any way to tell which table warned.
                  // The GlobalTable twin of THIS arm is still unprefixed and
                  // still says "current" — same defect, contended file, tracked
                  // in issue #1739.
                  this.logger.warn(
                    `AWS::DynamoDB::Table ${logicalId}: ${message} The mode this update ` +
                      `compared against (${prevBillingMode}) is kept rather than flipped to ` +
                      `the default.`
                  );
                },
              }
            );
      const billingMode = billingModeUnusable
        ? prevBillingMode
        : (requestedBillingMode as 'PROVISIONED' | 'PAY_PER_REQUEST');
      const billingOrThroughputChanged =
        billingMode !== prevBillingMode ||
        JSON.stringify(properties['ProvisionedThroughput']) !==
          JSON.stringify(previousProperties['ProvisionedThroughput']);
      // A flip INTO PROVISIONED while the template still declares
      // `OnDemandThroughput` is self-contradictory, and issue #1553 made it
      // newly reachable: the flip would be applied first and the on-demand
      // ceiling would then be REJECTED by AWS, leaving the table half-changed.
      //
      // REFUSE BEFORE ANY CALL rather than skipping the block. Skipping was
      // the first fix and a review showed it is the worse of the two: the
      // engine records the DESIRED properties as state after a successful
      // update, so the un-sent ceiling would be recorded as applied and the
      // next deploy would compare the new value against itself and never send
      // it — AWS stuck on the old ceiling permanently. That is the
      // silent-drop class this file refuses everywhere else.
      //
      // A refusal on the update path is normally the thing to avoid (a
      // rollback / `drift --revert` replays `update()` with a STATE record the
      // user cannot edit), but this shape cannot occur in a valid record: no
      // deploy that reaches state can carry it, and `readCurrentState` emits
      // `BillingMode` whenever `BillingModeSummary` exists, which is always
      // true for a live on-demand table. The value is template-borne in every
      // reachable case, so the user can act on the error.
      // `|| liveBillingMode === 'PAY_PER_REQUEST'` (PR review): this refusal
      // keys on the RECORDED previous while the flip itself keys on the LIVE
      // mode, and the two disagree after a `cdkd import` or an out-of-band
      // console flip. Before this change the mismatch was inert — the flip
      // failed anyway for an indexed table — but now that the flip SUCCEEDS,
      // a record saying PROVISIONED against a live on-demand table would slip
      // past the refusal, flip the table, and only then have its
      // `OnDemandThroughput` UpdateTable rejected against a now-provisioned
      // table: a half-applied deploy. Refusing on either side keeps the
      // pre-flight ahead of the mutation.
      // `billingOrThroughputChanged &&` leads (PR review round 2): without it
      // the widened live-mode arm OVER-refuses. When the recorded previous and
      // the desired side both omit `BillingMode`, both normalize to the type
      // default PROVISIONED, so no flip is sent at all — yet a live on-demand
      // table declaring `OnDemandThroughput` would hard-error on a deploy that
      // used to succeed. That shape DOES reach state (it succeeded before), so
      // it would also break the justification below and make a rollback /
      // `drift --revert` replay throw on a record the user cannot edit — the
      // exact class this file exists to avoid. The conjunct cannot weaken the
      // original arm: `prevBillingMode === 'PAY_PER_REQUEST'` with a desired
      // PROVISIONED is a mode change, so the flag is already true there.
      if (
        billingOrThroughputChanged &&
        billingMode === 'PROVISIONED' &&
        (prevBillingMode === 'PAY_PER_REQUEST' || liveBillingMode === 'PAY_PER_REQUEST') &&
        properties['OnDemandThroughput'] !== undefined
      ) {
        const absentNote =
          properties['BillingMode'] === undefined
            ? ' (BillingMode is absent from the template, which CloudFormation resets to PROVISIONED)'
            : '';
        throw new ProvisioningError(
          `AWS::DynamoDB::Table ${logicalId}: the template flips BillingMode to ` +
            `PROVISIONED${absentNote} while still declaring OnDemandThroughput, which AWS ` +
            `accepts only on a PAY_PER_REQUEST table. Nothing was applied. Remove ` +
            `OnDemandThroughput, or keep BillingMode: PAY_PER_REQUEST.`,
          logicalId,
          resourceType
        );
      }
      // The LIVE index list and the DESIRED index map, hoisted out of the flip
      // block because the pre-flip REMOVAL below needs both before the flip is
      // built, and the flip's per-index capacity block then needs the live list
      // MINUS whatever the removal deleted.
      const liveIndexes = table?.GlobalSecondaryIndexes ?? [];
      const desiredIndexByName = new Map<string, Record<string, unknown>>();
      for (const entry of Array.isArray(properties['GlobalSecondaryIndexes'])
        ? (properties['GlobalSecondaryIndexes'] as Array<Record<string, unknown>>)
        : []) {
        const name = entry?.['IndexName'];
        if (typeof name === 'string') desiredIndexByName.set(name, entry);
      }

      // Removing a GSI in the SAME deploy as a flip to PROVISIONED (issue
      // #1617). AWS demands per-index `ProvisionedThroughput` for every index
      // that is LIVE at flip time, and the template no longer declares the
      // removed one, so there is no capacity to send: the flip is rejected
      // (`ProvisionedThroughput must be specified for index: <name>`, measured
      // 2026-08-11) on every deploy, and `applyGsiUpdates` — which owns the
      // Delete op — runs AFTER the flip and is therefore never reached. The
      // deploy could not converge by any template-side edit.
      //
      // So issue the Delete FIRST, which is what CloudFormation does (it
      // succeeds on this shape). Only the removal moves: creates and capacity
      // updates stay after the flip, where the index they describe exists.
      //
      // Scoped to the flip-to-PROVISIONED shape because that is the only one
      // that enumerates live indexes — a flip to PAY_PER_REQUEST needs no
      // per-index capacity, and reordering its removals would be a behavior
      // change with no defect behind it.
      const preFlipDeletedIndexNames = new Set<string>();
      // A present-but-NON-ARRAY desired value (an unresolved intrinsic, a
      // mis-nested template value) reads as an empty desired set above, which
      // would classify EVERY live index as removed and delete them all before
      // the flip (PR review). That shape was non-destructive before this
      // change — the flip block warned and omitted, and `applyGsiUpdates` then
      // threw on `desired.filter` — so the removal is refused here rather than
      // newly destroying data on a malformed template.
      const desiredIndexesUnusable =
        properties['GlobalSecondaryIndexes'] != null &&
        !Array.isArray(properties['GlobalSecondaryIndexes']);
      if (
        billingOrThroughputChanged &&
        billingMode === 'PROVISIONED' &&
        liveBillingMode === 'PAY_PER_REQUEST' &&
        liveIndexes.length > 0 &&
        !desiredIndexesUnusable
      ) {
        // Only an index cdkd's PREVIOUS side knows about is removable here. A
        // live index in neither side was created out of band, and deleting it
        // is not something this deploy asked for — it stays live, lands in the
        // `unspecified` warning below, and AWS rejects the flip by name, which
        // is the same outcome as before this change.
        const previousIndexNames = new Set(
          (Array.isArray(previousProperties['GlobalSecondaryIndexes'])
            ? (previousProperties['GlobalSecondaryIndexes'] as Array<Record<string, unknown>>)
            : []
          )
            .map((entry) => entry?.['IndexName'])
            .filter((name): name is string => typeof name === 'string')
        );
        const removable: string[] = [];
        const remainingWithoutCapacity: string[] = [];
        for (const live of liveIndexes) {
          const indexName = live.IndexName;
          if (typeof indexName !== 'string') continue;
          if (!desiredIndexByName.has(indexName)) {
            if (previousIndexNames.has(indexName)) removable.push(indexName);
            else remainingWithoutCapacity.push(indexName);
            continue;
          }
          if (!hasUsableDeclaredCapacity(desiredIndexByName.get(indexName))) {
            remainingWithoutCapacity.push(indexName);
          }
        }
        // PRE-VALIDATE, because a Delete is not undoable. When the flip is
        // DOOMED for a reason already visible here, deleting first buys
        // nothing and leaves a PARTIALLY applied deploy (index gone, mode
        // unchanged) — so the shape is kept at "nothing applied".
        //
        // Two causes are foreseeable, and BOTH must be checked (PR review
        // found the second missing). AWS rejects the flip when an index that
        // will STILL be live declares no usable per-index capacity, and
        // equally when the TABLE-level `ProvisionedThroughput` is absent or
        // unusable — the flip block below deliberately leaves that one to AWS
        // (CFn parity), which is fine for the flip itself but is exactly the
        // deterministic failure a pre-flip delete must not run ahead of.
        const tableCapacityUnusable = !hasUsableTableCapacity(properties['ProvisionedThroughput']);
        if (
          removable.length > 0 &&
          (remainingWithoutCapacity.length > 0 || tableCapacityUnusable)
        ) {
          // BOTH reasons are reported when both fire (PR review): naming only
          // one sends the user round the loop again — they fix it, re-deploy,
          // and meet the second warning.
          const reasons: string[] = [];
          if (remainingWithoutCapacity.length > 0) {
            reasons.push(
              `index(es) ${remainingWithoutCapacity.join(', ')} stay live and declare no usable ` +
                `per-index ProvisionedThroughput (both ReadCapacityUnits and WriteCapacityUnits ` +
                `are required there)`
            );
          }
          if (tableCapacityUnusable) {
            reasons.push(`the template declares no usable table-level ProvisionedThroughput`);
          }
          this.logger.warn(
            `AWS::DynamoDB::Table ${logicalId}: this deploy removes global secondary index(es) ` +
              `${removable.join(', ')} and flips BillingMode to PROVISIONED. The removal would ` +
              `normally be applied BEFORE the flip, but ${reasons.join(' and ')}, so AWS rejects ` +
              `the flip either way. Nothing was removed.`
          );
        } else if (removable.length > 0) {
          this.logger.debug(
            `Deleting GSI(s) ${removable.join(', ')} on DynamoDB table ${physicalId} before the ` +
              `BillingMode flip to PROVISIONED`
          );
          // One op per UpdateTable with a full table+indexes ACTIVE wait
          // between each — AWS's one-GSI-op-per-call budget, and the wait is
          // what returns the table to a state that accepts the flip (the same
          // index-status race issue #1553 handles).
          await this.runGsiOps(
            physicalId,
            removable.map((name) => ({ Delete: { IndexName: name } })),
            undefined
          );
          for (const name of removable) preFlipDeletedIndexNames.add(name);
          // A failure BETWEEN the deletes and the flip leaves the index gone
          // and the mode unchanged. That partial application is accepted —
          // but only because the NEXT deploy converges, and that is a
          // property of the Delete arm below rather than something to assume.
          //
          // The first version of this comment claimed the next deploy is fine
          // "because the GSI diff is already satisfied", and a PR review
          // showed that was WRONG: cdkd writes state only after `update()`
          // RETURNS, so a mid-update failure leaves the deleted index still
          // recorded in the previous side, and the next deploy would emit a
          // Delete for an index AWS no longer has — the
          // `ResourceNotFoundException` that would fail every subsequent
          // deploy forever, re-creating the very unconvergeable class this
          // change exists to remove. `applyGsiUpdates` therefore skips a
          // Delete for a name that is not LIVE, which makes the arm
          // idempotent and is what actually makes this residual recoverable.
        }
      }

      // The names that are LIVE in AWS right now — the DescribeTable snapshot
      // minus whatever the pre-flip removal just deleted. `applyGsiUpdates`
      // uses it to make its Delete arm IDEMPOTENT (issue #1617 PR review):
      // without it, a state record naming an index AWS no longer has produces
      // a `ResourceNotFoundException` on every deploy forever. That covers the
      // pre-flip deletes AND the pre-existing case of a resource whose index
      // was removed out of band or by an earlier interrupted run.
      //
      // `undefined` when there is no snapshot to reason from, which keeps the
      // pre-change behavior rather than silently skipping every removal.
      const currentLiveIndexNames = table
        ? new Set(
            liveIndexes
              .map((live) => live.IndexName)
              .filter((name): name is string => typeof name === 'string')
              .filter((name) => !preFlipDeletedIndexNames.has(name))
          )
        : undefined;

      // The live per-index DESCRIPTIONS, keyed by name. Populated whenever
      // there is a `DescribeTable` snapshot at all — for EVERY billing mode.
      // The PROVISIONED-only gate is the SEPARATE `liveCapacityComparable`
      // flag below, and conflating the two in this comment used to be
      // harmless prose; it is not any more (PR review round 4), because issue
      // #1768's `warmThroughputOpFor` reads this same map on PAY_PER_REQUEST
      // tables for its idempotency and decrease gates. Saying the map is
      // PROVISIONED-only would now describe those two gates as dead code on
      // the mode where they matter most.
      //
      // What IS PROVISIONED-only is the CAPACITY comparison (issue #1630), and
      // that gate is the whole risk of this change rather than a formality:
      // `DescribeTable` reports `ProvisionedThroughput: {0, 0}` for every index
      // of a PAY_PER_REQUEST table (the #1571 trap), so the numbers mean
      // nothing there — and when THIS deploy is flipping to PROVISIONED, the
      // flip itself delivers the capacity, which `gsiHandledByBillingFlip`
      // already suppresses through a different route.
      const currentLiveIndexByName = table
        ? new Map(
            liveIndexes
              .filter(
                (live): live is typeof live & { IndexName: string } =>
                  typeof live.IndexName === 'string'
              )
              .filter((live) => !preFlipDeletedIndexNames.has(live.IndexName))
              .map((live) => [live.IndexName, live] as const)
          )
        : undefined;

      // Whether the live capacity NUMBERS are meaningful. `DescribeTable`
      // reports `ProvisionedThroughput: {0, 0}` for every index of a
      // PAY_PER_REQUEST table (the #1571 trap), and when THIS deploy is
      // flipping to PROVISIONED the flip itself delivers the capacity — so the
      // capacity half of the idempotency check stays off in both cases while
      // the EXISTENCE half still applies.
      const liveCapacityComparable = liveBillingMode === 'PROVISIONED';

      // Index names whose capacity the BillingMode flip below already delivered.
      // `applyGsiUpdates` must NOT re-assert them: real AWS rejects a no-op
      // capacity change outright (`The provisioned throughput for the index X
      // will not change. The requested value equals the current value.`), so
      // the second UpdateTable fails the whole deploy. Found by the
      // `dynamodb-ondemand` integ on the first run of this change — the unit
      // tests could not see it, because each mocks ONE call and the defect is
      // an interaction BETWEEN two of them (issue #1588). Same mechanism as
      // `gsiHandledByBillingFlip` in `dynamodb-globaltable-provider.ts`.
      const gsiHandledByBillingFlip = new Set<string>();
      if (billingOrThroughputChanged || tableClassChanged) {
        const updateInput: UpdateTableCommandInput = { TableName: physicalId };
        // Always defined now that both sides normalize, so the call can never
        // again go out with only a `TableName` — the empty-UpdateTable shape
        // issue #1553 is about.
        if (billingOrThroughputChanged) {
          updateInput.BillingMode = billingMode;
        }
        if (tableClassChanged) {
          // A removed TableClass property reverts to the DynamoDB default
          // (STANDARD) — matches CFn, which reverts an absent property to the
          // type default rather than leaving the old value in place.
          updateInput.TableClass = normalizeTableClass(properties['TableClass']);
        }
        // PAY_PER_REQUEST rejects ProvisionedThroughput; PROVISIONED requires
        // it, so forward the caps whenever the resolved mode is PROVISIONED.
        // Gated on billingOrThroughputChanged so a TableClass-only change does
        // not re-assert the current throughput — AWS rejects an UpdateTable
        // whose requested throughput equals the table's current value.
        //
        // A flip to PROVISIONED with NO `ProvisionedThroughput` in the template
        // is left to fail at AWS rather than pre-refused here: that is CFn
        // parity (its handler fails the same shape with `Property
        // ProvisionedThroughput cannot be empty`), DynamoDB's own error names
        // the missing member, and a pre-flight throw on the UPDATE path would
        // fire on a rollback / `drift --revert` replay of a state record the
        // user cannot edit.
        if (
          billingOrThroughputChanged &&
          billingMode !== 'PAY_PER_REQUEST' &&
          properties['ProvisionedThroughput']
        ) {
          const pt = properties['ProvisionedThroughput'] as Record<string, unknown>;
          updateInput.ProvisionedThroughput = {
            ReadCapacityUnits: Number(pt['ReadCapacityUnits'] ?? 5),
            WriteCapacityUnits: Number(pt['WriteCapacityUnits'] ?? 5),
          };
        }
        // Per-index ProvisionedThroughput must ride the SAME UpdateTable as a
        // flip TO PROVISIONED (issue #1588). Live-measured on 2026-08-11
        // against a PAY_PER_REQUEST table carrying one GSI:
        //
        //   A) BillingMode + table-level ProvisionedThroughput only (what this
        //      method sent before) -> ValidationException: "One or more
        //      parameter values were invalid: ProvisionedThroughput must be
        //      specified for index: gsi1". Nothing applied.
        //   B) the same call plus GlobalSecondaryIndexUpdates[].Update.
        //      ProvisionedThroughput -> ACCEPTED; readback showed the table at
        //      its declared capacity and the index at its own.
        //
        // So a table WITH a GSI could not be flipped at all — the pre-#1588
        // comment here called it "a separate concern" and "a silent gap", but
        // it is neither silent nor separate: it is a hard failure of the flip
        // this method performs. Only the flip needs this; a capacity bump on an
        // already-PROVISIONED table does not, and re-asserting an index's
        // current capacity is a call AWS rejects.
        //
        // The index list is the LIVE one, but be precise about what that buys
        // (PR review corrected an overclaim here). Capacity still comes from
        // the DESIRED template, so for an index that is live but no longer
        // declared the flip is NOT rescued — the index is named in a warning
        // and omitted, and AWS rejects the flip exactly as it would have with a
        // template-only list. What the live list buys is DIAGNOSTICS: cdkd
        // names the offending index up front instead of leaving the user to
        // decode an AWS error about an index their template no longer mentions.
        // (`dynamodb-globaltable-provider.ts` additionally falls back to the
        // PREVIOUS side there; that rarely helps here, because the previous
        // side of an on-demand table carries no per-index capacity either.)
        //
        // An index with no usable declared capacity is left out so AWS's own
        // error names it, matching the CFn handler rather than inventing a
        // capacity the user never asked for.
        // The `DescribeTable` snapshot predates the pre-flip removal above, so
        // drop whatever it deleted: AWS enumerates the indexes that are live
        // NOW, and naming a just-deleted one would re-introduce the very
        // rejection the removal exists to avoid (issue #1617).
        const flipLiveIndexes = liveIndexes.filter(
          (live) =>
            typeof live.IndexName !== 'string' || !preFlipDeletedIndexNames.has(live.IndexName)
        );
        if (
          billingOrThroughputChanged &&
          billingMode === 'PROVISIONED' &&
          liveBillingMode === 'PAY_PER_REQUEST' &&
          flipLiveIndexes.length > 0
        ) {
          const indexUpdates: GlobalSecondaryIndexUpdate[] = [];
          const unspecified: string[] = [];
          for (const live of flipLiveIndexes) {
            const indexName = live.IndexName;
            if (typeof indexName !== 'string') continue;
            // BOTH members must be present, numeric and finite. A `?? 5`
            // default here would contradict this block's own rule two comments
            // up — and worse than at create(), because the flip now SUPPRESSES
            // the per-index path for this index, so an invented capacity is
            // never corrected by a later call and lands in state as if the
            // user had declared it. A half-declared or non-numeric entry is
            // treated exactly like an absent one: omitted, named in the
            // warning, and left for AWS to reject by name (PR review).
            const declared = desiredIndexByName.get(indexName)?.['ProvisionedThroughput'];
            const read = readCapacityNumber(declared, 'ReadCapacityUnits');
            const write = readCapacityNumber(declared, 'WriteCapacityUnits');
            if (read === undefined || write === undefined) {
              unspecified.push(indexName);
              continue;
            }
            indexUpdates.push({
              Update: {
                IndexName: indexName,
                ProvisionedThroughput: { ReadCapacityUnits: read, WriteCapacityUnits: write },
              },
            });
            gsiHandledByBillingFlip.add(indexName);
          }
          if (indexUpdates.length > 0) {
            updateInput.GlobalSecondaryIndexUpdates = indexUpdates;
          }
          if (unspecified.length > 0) {
            // Not a refusal: AWS rejects the call by name a moment later, which
            // is the CFn-parity outcome and a better message than anything a
            // pre-flight guess could produce. The warning exists so the cause is
            // visible in cdkd's own output rather than only in the AWS error.
            this.logger.warn(
              `AWS::DynamoDB::Table ${logicalId}: flipping BillingMode to PROVISIONED, but the ` +
                `template declares no usable ProvisionedThroughput for live index(es) ` +
                `${unspecified.join(', ')}. AWS requires per-index capacity in the same ` +
                `UpdateTable and will reject the flip naming them. Declare ` +
                `GlobalSecondaryIndexes[].ProvisionedThroughput (both ReadCapacityUnits and ` +
                `WriteCapacityUnits) for each. An index this deploy REMOVES is deleted BEFORE ` +
                `the flip automatically (issue #1617), so a name here is one the template still ` +
                `keeps, one that exists in AWS but in neither the template nor cdkd state ` +
                `(created out of band), or one whose pre-flip removal was skipped for the reason ` +
                `warned above.`
            );
          }
        }
        await this.dynamoDBClient.send(new UpdateTableCommand(updateInput));
        // UpdateTable is async; wait for ACTIVE so later branches (and any
        // subsequent UpdateTable for OnDemand/Warm throughput) don't race a
        // still-UPDATING table.
        //
        // The flip test is against the table's LIVE mode, not the RECORDED
        // previous (review catch): when state and AWS disagree — an absent
        // recorded previous against a live on-demand table, or the
        // unusable-value arm under drift — `billingMode !== prevBillingMode`
        // is false while AWS performs a real flip, which is exactly the case
        // the long budget exists for.
        //
        // A flip also re-provisions every GSI, and `TableStatus` returns
        // ACTIVE before the indexes do; the branches below issue further
        // `UpdateTable`s that would race a still-UPDATING index and get
        // `ResourceInUseException`. So a flip waits on the INDEXES too.
        if (billingMode !== liveBillingMode) {
          await this.waitForTableAndIndexesActive(physicalId, BILLING_FLIP_ACTIVE_WAIT_ATTEMPTS);
        } else {
          await this.waitForTableActiveAfterUpdate(physicalId, TABLE_ACTIVE_WAIT_ATTEMPTS);
        }
        this.logger.debug(
          `Updated BillingMode/ProvisionedThroughput/TableClass on DynamoDB table ${physicalId}`
        );
      }

      // OnDemandThroughput — rides on UpdateTable (NOT a separate control-
      // plane API like PITR / TTL). Fire only when the value changed so a
      // no-op update doesn't issue a redundant UpdateTable; AWS validates
      // the PAY_PER_REQUEST-only constraint.
      if (
        JSON.stringify(properties['OnDemandThroughput']) !==
        JSON.stringify(previousProperties['OnDemandThroughput'])
      ) {
        if (properties['OnDemandThroughput']) {
          await this.dynamoDBClient.send(
            new UpdateTableCommand({
              TableName: physicalId,
              OnDemandThroughput: properties['OnDemandThroughput'] as OnDemandThroughput,
            })
          );
          // UpdateTable is async; wait for ACTIVE so later branches (SSE /
          // Stream / GSI) don't race a still-UPDATING table.
          await this.waitForTableActiveAfterUpdate(physicalId);
          this.logger.debug(`Updated OnDemandThroughput on DynamoDB table ${physicalId}`);
        }
      }

      // WarmThroughput — rides on UpdateTable (NOT a separate control-plane
      // API like PITR / TTL). Fire only when the value changed so a no-op
      // update doesn't issue a redundant UpdateTable. A pure removal (new
      // absent, previous present) is a deliberate no-op — CFn has no clean
      // "drop warm throughput" mapping and AWS keeps the last-set value, so
      // there is no spec to send. The send rule is shared with `create()` and
      // with the drift side via `isSendableWarmThroughput` (issue #1760).
      if (
        JSON.stringify(properties['WarmThroughput']) !==
        JSON.stringify(previousProperties['WarmThroughput'])
      ) {
        // Placed on the CHANGE gate, not inside the send gate below, so the
        // warning fires exactly when a user's edit was dropped — once per
        // changed value rather than on every no-op deploy that re-presents the
        // same unusable block. (An earlier draft justified the placement by
        // saying it stops this warning and the decrease skip's from both
        // firing; that was never the reason — the `&&` short-circuits, so a
        // value `isSendableWarmThroughput` refuses never reaches
        // `skipWarmThroughputDecrease` wherever this call sits.)
        this.warnRefusedWarmThroughput(
          `AWS::DynamoDB::Table ${logicalId}`,
          properties['WarmThroughput']
        );
        // COERCED ONCE, here, and used for BOTH the gate below and the wire
        // (PR review round 7). Two rules meet at this line:
        //  - every gate that analyses a value before sending it must analyse
        //    what will ACTUALLY be sent. Reading the raw bag let
        //    `isWarmThroughputDecrease` fail open on an unusable member and
        //    then send the coerced remainder — for
        //    `{ReadUnitsPerSecond: {Ref: 'X'}, WriteUnitsPerSecond: 2000}`
        //    against a live `{12000, 4000}` that is a `{WriteUnitsPerSecond:
        //    2000}` decrease, i.e. the exact call this branch exists to
        //    withhold, so the DEPLOY FAILED while the per-index arm warned and
        //    continued on the identical input.
        //  - the dropped-member announcement must not depend on the gate
        //    letting the call through. `coerceWarmThroughputForSend` is the
        //    only site that names a dropped member, so calling it on the send
        //    path alone meant a skip swallowed that half of the diagnosis.
        //    Placed inside the CHANGE gate, so it still says it once per
        //    changed value rather than on every deploy.
        const warmThroughputToSend = this.coerceWarmThroughputForSend(
          `AWS::DynamoDB::Table ${logicalId}`,
          properties['WarmThroughput']
        );
        if (
          warmThroughputToSend !== undefined &&
          // A DECREASE is refused by AWS, so the call can only fail (issue
          // #1768, measured — see `isWarmThroughputDecrease`). Skipping it with
          // a warning is right for EVERY caller of `update()`, which is the
          // question a skip has to answer:
          //  - the deploy engine (template-borne): a template asking for less
          //    than AWS holds is not applicable, and failing the whole deploy
          //    over it helps nobody. `cdkd drift` keeps REPORTING the
          //    difference, which is the user's signal to edit the template —
          //    hence no `effectiveProperties` here: recording AWS's value
          //    would make the comparison equal and silence exactly that
          //    report.
          //  - `cdkd drift --revert`: the arm the issue was filed from. It
          //    overlays the declared value onto the readback and lands here,
          //    where the call could never succeed; the resource used to fail
          //    with `could not revert — <AWS message>` (exit 2) instead of
          //    reverting everything else and saying why this key stayed.
          //  - the rollback executor's `revert` / `revert-failed-update` arms:
          //    the desired bag is an older TEMPLATE from cdkd state, so the
          //    same reasoning applies — and a throw there would leave the
          //    resource un-rollbackable with no template-side remedy.
          !this.skipWarmThroughputDecrease(
            logicalId,
            physicalId,
            warmThroughputToSend,
            table?.WarmThroughput
          )
        ) {
          await this.dynamoDBClient.send(
            new UpdateTableCommand({ TableName: physicalId, WarmThroughput: warmThroughputToSend })
          );
          // UpdateTable is async; wait for ACTIVE so later branches (SSE /
          // Stream / GSI) don't race a still-UPDATING table.
          await this.waitForTableActiveAfterUpdate(physicalId);
          this.logger.debug(`Updated WarmThroughput on DynamoDB table ${physicalId}`);
        }
      }

      // SSESpecification — rides on its OWN UpdateTable (separate from the
      // billing/throughput call above and the GSI calls below). Fire only when
      // the value changed, and wait for ACTIVE afterwards so the GSI block does
      // not race an UPDATING table. The same SSEEnabled->Enabled mapping the
      // create path needs applies here. A removal (new absent, previous present)
      // is a deliberate no-op: CFn has no clean "drop SSE back to AWS-owned"
      // mapping and mapSSESpecification(undefined) returns undefined, so there
      // is no spec to send (mirrors the WarmThroughput removal stance).
      if (
        JSON.stringify(properties['SSESpecification']) !==
        JSON.stringify(previousProperties['SSESpecification'])
      ) {
        const sseUpdate = mapSSESpecification(properties['SSESpecification']);
        if (sseUpdate && Object.keys(sseUpdate).length > 0) {
          await this.dynamoDBClient.send(
            new UpdateTableCommand({ TableName: physicalId, SSESpecification: sseUpdate })
          );
          await this.waitForTableActiveAfterUpdate(physicalId);
          this.logger.debug(`Updated SSESpecification on DynamoDB table ${physicalId}`);
        }
      }

      // StreamSpecification — DynamoDB Streams enable / disable / view-type
      // change, all via UpdateTable's StreamSpecification field (a separate
      // UpdateTable from the billing / SSE calls, mirroring their pattern).
      // It previously had NO update branch, so enabling a stream, changing the
      // StreamViewType, or removing a stream were ALL silently dropped: the
      // deploy reported success while AWS kept the old stream config, and the
      // next diff saw no change (state recorded the new spec), so it could
      // never self-heal (the throw-not-swallow / no-silent-drop rule).
      //
      // Three transitions, keyed off whether the spec is present on each side:
      //  - enable  (new present, previous absent): StreamEnabled: true + the
      //    new StreamViewType, then wait ACTIVE and capture LatestStreamArn.
      //  - disable (new absent, previous present): StreamEnabled: false; the
      //    stream ARN is cleared afterwards.
      //  - view-type change (both present, different StreamViewType): AWS
      //    REJECTS a direct StreamViewType switch on an enabled stream, so the
      //    change is applied as disable -> wait ACTIVE -> re-enable with the
      //    new view type -> wait ACTIVE. (DynamoDB also rejects a rapid
      //    disable-then-enable against a still-UPDATING table, so the wait
      //    between the two calls is load-bearing, not just cosmetic.)
      if (
        JSON.stringify(properties['StreamSpecification']) !==
        JSON.stringify(previousProperties['StreamSpecification'])
      ) {
        const newViewType = this.extractStreamViewType(properties['StreamSpecification']);
        const prevViewType = this.extractStreamViewType(previousProperties['StreamSpecification']);

        if (newViewType && prevViewType && newViewType !== prevViewType) {
          // View-type change on an enabled stream: disable, wait, re-enable.
          await this.dynamoDBClient.send(
            new UpdateTableCommand({
              TableName: physicalId,
              StreamSpecification: { StreamEnabled: false } as StreamSpecification,
            })
          );
          await this.waitForTableActiveAfterUpdate(physicalId);
          const reenable = await this.dynamoDBClient.send(
            new UpdateTableCommand({
              TableName: physicalId,
              StreamSpecification: {
                StreamEnabled: true,
                StreamViewType: newViewType,
              } as StreamSpecification,
            })
          );
          await this.waitForTableActiveAfterUpdate(physicalId);
          latestStreamArn =
            reenable.TableDescription?.LatestStreamArn ??
            (await this.describeLatestStreamArn(physicalId));
          this.logger.debug(
            `Changed StreamViewType on DynamoDB table ${physicalId} to ${newViewType}`
          );
        } else if (newViewType) {
          // Enable a stream (or re-assert with the same/new view type when the
          // previous side had no stream).
          const enable = await this.dynamoDBClient.send(
            new UpdateTableCommand({
              TableName: physicalId,
              StreamSpecification: {
                StreamEnabled: true,
                StreamViewType: newViewType,
              } as StreamSpecification,
            })
          );
          await this.waitForTableActiveAfterUpdate(physicalId);
          latestStreamArn =
            enable.TableDescription?.LatestStreamArn ??
            (await this.describeLatestStreamArn(physicalId));
          this.logger.debug(`Enabled DynamoDB Stream on table ${physicalId} (${newViewType})`);
        } else {
          // Removal (new absent, previous present): disable the stream.
          await this.dynamoDBClient.send(
            new UpdateTableCommand({
              TableName: physicalId,
              StreamSpecification: { StreamEnabled: false } as StreamSpecification,
            })
          );
          await this.waitForTableActiveAfterUpdate(physicalId);
          latestStreamArn = undefined;
          this.logger.debug(`Disabled DynamoDB Stream on table ${physicalId}`);
        }
      }

      // GlobalSecondaryIndexes — add / remove / per-index throughput change via
      // UpdateTable's GlobalSecondaryIndexUpdates. AWS permits only ONE GSI
      // create or delete per UpdateTable and rejects a concurrent update while
      // the table (or another index) is still mutating, so applyGsiUpdates
      // serializes the operations and waits for ACTIVE between each. A GSI
      // create must carry the new index's key AttributeDefinitions in the same
      // call — the full desired AttributeDefinitions array is forwarded.
      //
      // A removal may ALREADY have been applied above, ahead of a BillingMode
      // flip to PROVISIONED (issue #1617); `currentLiveIndexNames` is the
      // post-removal live set, so the Delete arm skips both those names and any
      // index the record still lists that AWS no longer has.
      if (
        JSON.stringify(properties['GlobalSecondaryIndexes']) !==
        JSON.stringify(previousProperties['GlobalSecondaryIndexes'])
      ) {
        await this.applyGsiUpdates(
          physicalId,
          resourceType,
          logicalId,
          previousProperties['GlobalSecondaryIndexes'] as GlobalSecondaryIndex[] | undefined,
          properties['GlobalSecondaryIndexes'] as GlobalSecondaryIndex[] | undefined,
          properties['AttributeDefinitions'] as AttributeDefinition[] | undefined,
          gsiHandledByBillingFlip,
          currentLiveIndexNames,
          currentLiveIndexByName,
          liveCapacityComparable
        );
      }

      // PointInTimeRecoverySpecification — separate UpdateContinuousBackups
      // API. Fire only when the value changed; a removal disables PITR.
      if (
        JSON.stringify(properties['PointInTimeRecoverySpecification']) !==
        JSON.stringify(previousProperties['PointInTimeRecoverySpecification'])
      ) {
        await this.applyPointInTimeRecovery(
          physicalId,
          properties['PointInTimeRecoverySpecification'],
          // On removal (new absent, previous present) explicitly disable.
          previousProperties['PointInTimeRecoverySpecification']
        );
      }

      // TimeToLiveSpecification — separate UpdateTimeToLive API. Fire only
      // when the value changed; a removal disables TTL using the previous
      // AttributeName (AWS requires it to disable).
      if (
        JSON.stringify(properties['TimeToLiveSpecification']) !==
        JSON.stringify(previousProperties['TimeToLiveSpecification'])
      ) {
        this.assertNoActiveTtlAttributeNameChange(
          logicalId,
          resourceType,
          physicalId,
          properties['TimeToLiveSpecification'],
          previousProperties['TimeToLiveSpecification']
        );
        await this.applyTimeToLive(
          physicalId,
          properties['TimeToLiveSpecification'],
          previousProperties['TimeToLiveSpecification']
        );
      }

      // ResourcePolicy — separate PutResourcePolicy / DeleteResourcePolicy
      // APIs (the CreateTable `ResourcePolicy` field is create-only). Fire
      // only when the value changed; a removal deletes the policy. Needs the
      // table ARN, which the DescribeTable above gave us. Fail loud when a
      // change is detected but the ARN is missing (transient/partial
      // DescribeTable response) — a silent skip would write the new policy
      // into state as if applied, so the next deploy sees no diff and the
      // policy stays permanently stale (the throw-not-swallow rule).
      if (
        JSON.stringify(properties['ResourcePolicy']) !==
        JSON.stringify(previousProperties['ResourcePolicy'])
      ) {
        if (!table?.TableArn) {
          throw new ProvisioningError(
            `Cannot apply ResourcePolicy change for DynamoDB table ${logicalId}: DescribeTable returned no TableArn`,
            resourceType,
            logicalId,
            physicalId
          );
        }
        await this.applyResourcePolicy(
          table.TableArn,
          properties['ResourcePolicy'],
          previousProperties['ResourcePolicy']
        );
      }

      // KinesisStreamSpecification — separate Enable/Disable/Update
      // KinesisStreamingDestination APIs. Fire only when the value changed; a
      // removal disables streaming to the previous stream ARN.
      if (
        JSON.stringify(properties['KinesisStreamSpecification']) !==
        JSON.stringify(previousProperties['KinesisStreamSpecification'])
      ) {
        await this.applyKinesisStreamingDestination(
          physicalId,
          properties['KinesisStreamSpecification'],
          previousProperties['KinesisStreamSpecification']
        );
      }

      // ContributorInsightsSpecification — separate UpdateContributorInsights
      // API. Fire only when the value changed; a removal disables insights.
      if (
        JSON.stringify(properties['ContributorInsightsSpecification']) !==
        JSON.stringify(previousProperties['ContributorInsightsSpecification'])
      ) {
        await this.applyContributorInsights(
          physicalId,
          properties['ContributorInsightsSpecification'],
          previousProperties['ContributorInsightsSpecification']
        );
      }

      return {
        physicalId,
        wasReplaced: false,
        attributes: {
          Arn: table?.TableArn,
          TableId: table?.TableId,
          StreamArn: latestStreamArn,
          TableName: physicalId,
        },
      };
    } catch (error) {
      // Preserve already-actionable ProvisioningErrors (e.g. the TTL
      // attribute-name-change guard, the ResourcePolicy-ARN guard) verbatim
      // instead of double-wrapping them behind a generic "Failed to update"
      // prefix. Mirrors the create() catch.
      if (error instanceof ProvisioningError) {
        throw error;
      }
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to update DynamoDB table ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  /**
   * Delete a DynamoDB table
   */
  async delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    _properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void> {
    this.logger.debug(`Deleting DynamoDB table ${logicalId}: ${physicalId}`);

    // `--remove-protection`: flip DeletionProtectionEnabled off before
    // delete. UpdateTable is async — wait for ACTIVE before issuing
    // DeleteTable so the delete doesn't race the still-UPDATING table.
    // Idempotent — DynamoDB accepts the call when protection is already
    // disabled. Non-fatal: log at debug if the flip-off itself errors
    // (NotFound / similar) so the delete still proceeds.
    if (context?.removeProtection === true) {
      try {
        await this.dynamoDBClient.send(
          new UpdateTableCommand({
            TableName: physicalId,
            DeletionProtectionEnabled: false,
          })
        );
        this.logger.debug(
          `Disabled DeletionProtectionEnabled on DynamoDB table ${logicalId}, waiting for ACTIVE`
        );
        try {
          await this.waitForTableActiveAfterUpdate(physicalId);
        } catch (waitErr) {
          this.logger.debug(
            `Could not wait for table ${physicalId} ACTIVE after disabling protection: ${waitErr instanceof Error ? waitErr.message : String(waitErr)}`
          );
        }
      } catch (flipError) {
        if (!(flipError instanceof ResourceNotFoundException)) {
          this.logger.debug(
            `Could not disable DeletionProtectionEnabled on ${physicalId}: ${flipError instanceof Error ? flipError.message : String(flipError)}`
          );
        }
      }
    }

    try {
      // AWS refuses `DeleteTable` while a GSI is transitioning
      // (`Cannot delete table while indexes are being created, updated, or
      // deleted`), and the condition is TRANSIENT: a real destroy lost a table
      // to it and the very next `cdkd destroy` succeeded with no other change
      // (issue #1830, measured on the sibling `AWS::DynamoDB::GlobalTable`
      // type). Application auto-scaling can start an index capacity change at
      // any moment, so any table with an autoscaled GSI can hit it — this
      // provider simply had no retry, so it surfaced as a hard
      // `PartialFailureError` with state preserved and the user re-ran a
      // destroy for something that clears itself in seconds (issue #1931).
      //
      // The rule is the sibling provider's, READ rather than re-spelled: the
      // classifier, the retry budget, the bounded re-arm and the warning all
      // come from `../dynamodb-index-busy-delete.ts`.
      //
      // Deliberately NO pre-delete describe / settle gate here (the sibling's
      // #1521 gate). This provider's `delete()` issues `DeleteTable` with
      // nothing between it and the caller, so there is no window of its own to
      // close; adding a fresh describe would only shrink the race the retry
      // exists to absorb — and the integ arm races exactly that window, so it
      // would stop discriminating.
      await deleteTableWithIndexBusyRetry({
        logicalId,
        physicalId,
        typeLabel: 'table',
        logger: this.logger,
        deleteTable: async () => {
          await this.dynamoDBClient.send(new DeleteTableCommand({ TableName: physicalId }));
        },
        // Re-arm on the CONDITION, not on the clock: an index backfill outlasts
        // any fixed backoff grid, while this poll returns on its first
        // `DescribeTable` once the index has settled. BOUNDED — it runs per
        // retry, so the loop's wall clock is the product and
        // `destroy-runner.ts` caps a single `delete()` at the per-resource
        // deadline (30 min by default; this provider declares no
        // `getMinResourceTimeoutMs` to lift it). At
        // `DELETE_INDEX_BUSY_REARM_MAX_ATTEMPTS` the whole loop's worst case is
        // ~8.8 min, so a genuinely stuck index still ends in AWS's own
        // actionable sentence rather than a generic `ResourceTimeoutError` that
        // never mentions indexes.
        reArm: () =>
          waitForIndexesSettled({
            tableName: physicalId,
            logicalId,
            logger: this.logger,
            describeTable: () =>
              this.dynamoDBClient.send(new DescribeTableCommand({ TableName: physicalId })),
            maxAttempts: DELETE_INDEX_BUSY_REARM_MAX_ATTEMPTS,
            proceedNote: DELETE_INDEX_WAIT_PROCEED_NOTE,
          }),
        sleepSeam: deleteTableRetryDelays,
      });
      this.logger.debug(`Successfully deleted DynamoDB table ${logicalId}`);
    } catch (error) {
      if (error instanceof ResourceNotFoundException) {
        const clientRegion = await this.dynamoDBClient.config.region();
        assertRegionMatch(
          clientRegion,
          context?.expectedRegion,
          resourceType,
          logicalId,
          physicalId
        );
        this.logger.debug(`DynamoDB table ${physicalId} does not exist, skipping deletion`);
        return;
      }
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to delete DynamoDB table ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  /**
   * Apply a diff between old and new CFn-shape Tags arrays via DynamoDB's
   * `TagResource` / `UntagResource` APIs. Both take the table ARN as
   * `ResourceArn`.
   */
  private async applyTagDiff(
    tableArn: string,
    oldTagsRaw: Array<{ Key?: string; Value?: string }> | undefined,
    newTagsRaw: Array<{ Key?: string; Value?: string }> | undefined
  ): Promise<void> {
    const toMap = (
      tags: Array<{ Key?: string; Value?: string }> | undefined
    ): Map<string, string> => {
      const m = new Map<string, string>();
      for (const t of tags ?? []) {
        if (t.Key !== undefined && t.Value !== undefined) m.set(t.Key, t.Value);
      }
      return m;
    };

    const oldMap = toMap(oldTagsRaw);
    const newMap = toMap(newTagsRaw);

    const tagsToAdd: Array<{ Key: string; Value: string }> = [];
    for (const [k, v] of newMap) {
      if (oldMap.get(k) !== v) tagsToAdd.push({ Key: k, Value: v });
    }
    const tagsToRemove: string[] = [];
    for (const k of oldMap.keys()) {
      if (!newMap.has(k)) tagsToRemove.push(k);
    }

    if (tagsToRemove.length > 0) {
      await this.dynamoDBClient.send(
        new UntagResourceCommand({ ResourceArn: tableArn, TagKeys: tagsToRemove })
      );
      this.logger.debug(`Removed ${tagsToRemove.length} tag(s) from DynamoDB table ${tableArn}`);
    }
    if (tagsToAdd.length > 0) {
      await this.dynamoDBClient.send(
        new TagResourceCommand({ ResourceArn: tableArn, Tags: tagsToAdd })
      );
      this.logger.debug(`Added/updated ${tagsToAdd.length} tag(s) on DynamoDB table ${tableArn}`);
    }
  }

  /**
   * Apply the table's `PointInTimeRecoverySpecification` via the separate
   * `UpdateContinuousBackups` API (PITR does NOT ride on CreateTable).
   *
   * CFn shape is `{ PointInTimeRecoveryEnabled: boolean, RecoveryPeriodInDays?: number }`.
   * Called from both `create()` (after the table is ACTIVE) and `update()`
   * (only when the value changed). On `update()`-side removal — when the
   * template drops the block but it was present before — we explicitly
   * disable PITR (`UpdateContinuousBackups` treats an absent spec as "no
   * change", so a dropped block must be turned into an explicit
   * `PointInTimeRecoveryEnabled: false`).
   */
  private async applyPointInTimeRecovery(
    tableName: string,
    spec: unknown,
    previousSpec?: unknown
  ): Promise<void> {
    let enabled: boolean | undefined;
    let recoveryPeriodInDays: number | undefined;
    if (spec !== undefined && spec !== null) {
      const s = spec as Record<string, unknown>;
      enabled = Boolean(s['PointInTimeRecoveryEnabled']);
      // RecoveryPeriodInDays only applies when PITR is enabled; AWS rejects it
      // alongside PointInTimeRecoveryEnabled: false.
      if (enabled && s['RecoveryPeriodInDays'] !== undefined) {
        recoveryPeriodInDays = Number(s['RecoveryPeriodInDays']);
      }
    } else if (previousSpec !== undefined && previousSpec !== null) {
      // Removed from the template: disable.
      enabled = false;
    }

    if (enabled === undefined) return;

    const pitrSpec: PointInTimeRecoverySpecification = { PointInTimeRecoveryEnabled: enabled };
    if (recoveryPeriodInDays !== undefined) {
      pitrSpec.RecoveryPeriodInDays = recoveryPeriodInDays;
    }

    await this.retryOnTransientControlPlane(
      () =>
        this.dynamoDBClient.send(
          new UpdateContinuousBackupsCommand({
            TableName: tableName,
            PointInTimeRecoverySpecification: pitrSpec,
          })
        ),
      `enable PITR on ${tableName}`
    );
    this.logger.debug(
      `Set PointInTimeRecoveryEnabled=${enabled}${
        recoveryPeriodInDays !== undefined ? ` RecoveryPeriodInDays=${recoveryPeriodInDays}` : ''
      } on DynamoDB table ${tableName}`
    );
  }

  /**
   * Retry a DynamoDB control-plane call on the transient "settling" errors AWS
   * returns when two table-modifying operations land back-to-back. Enabling
   * PITR (`UpdateContinuousBackups`) puts the table in a transient state, and a
   * subsequent `UpdateTimeToLive` is then rejected with "Backups are being
   * enabled for the table ... Please retry later". `ResourceInUseException`
   * ("table is being updated") and `LimitExceededException` are the same class.
   * Backoff: ~2s,4s,8s,16s,30s,30s... bounded to ~2min total, which comfortably
   * covers the few-second PITR-enable window.
   */
  private async retryOnTransientControlPlane<T>(
    op: () => Promise<T>,
    label: string,
    maxAttempts = 8
  ): Promise<T> {
    let delayMs = 2000;
    for (let attempt = 1; ; attempt++) {
      try {
        return await op();
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        const name = error instanceof Error ? error.name : '';
        const transient =
          /being enabled|being updated|please retry later|backups are being/i.test(msg) ||
          name === 'ResourceInUseException' ||
          name === 'LimitExceededException';
        if (!transient || attempt >= maxAttempts) throw error;
        this.logger.debug(
          `Transient error on "${label}" (attempt ${attempt}/${maxAttempts}): ${msg} — retrying in ${delayMs}ms`
        );
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        delayMs = Math.min(delayMs * 2, 30000);
      }
    }
  }

  /**
   * Apply the table's `TimeToLiveSpecification` via the separate
   * `UpdateTimeToLive` API (TTL does NOT ride on CreateTable).
   *
   * CFn shape is `{ AttributeName: string, Enabled: boolean }`. Called from
   * both `create()` (after the table is ACTIVE) and `update()` (only when the
   * value changed). On `update()`-side removal — when the template drops the
   * block but it was present before — we disable TTL using the PREVIOUS
   * `AttributeName` (AWS requires the attribute name even to disable TTL).
   */
  /**
   * Pre-emptively reject a TTL `AttributeName` change between two enabled
   * specs with a clear, actionable message.
   *
   * AWS allows TTL on only ONE attribute per table, so enabling TTL on a new
   * attribute while TTL is still active on the old one fails with the opaque
   * `TimeToLive is active on a different AttributeName: <old>`; and because
   * DynamoDB rate-limits `UpdateTimeToLive` to one modification per table per
   * ~1 hour, the user cannot disable-then-re-enable within a single deploy
   * either. CloudFormation hits the same wall (UPDATE_ROLLBACK). Surfacing the
   * two-deploy remediation up front beats letting the raw AWS error bubble.
   *
   * Only fires when BOTH the old and new specs are present and enabled with a
   * DIFFERENT `AttributeName`. Enable-from-disabled, disable, and same-name
   * Enabled toggles all pass through to {@link applyTimeToLive}.
   */
  private assertNoActiveTtlAttributeNameChange(
    logicalId: string,
    resourceType: string,
    physicalId: string,
    spec: unknown,
    previousSpec: unknown
  ): void {
    const cur = this.readTtlSpec(spec);
    const prev = this.readTtlSpec(previousSpec);
    if (
      cur.enabled &&
      prev.enabled &&
      cur.attributeName !== undefined &&
      prev.attributeName !== undefined &&
      cur.attributeName !== prev.attributeName
    ) {
      throw new ProvisioningError(
        `DynamoDB table ${logicalId}: cannot change the TimeToLive AttributeName ` +
          `from '${prev.attributeName}' to '${cur.attributeName}' in a single deploy. ` +
          `AWS allows TTL on only one attribute and rejects enabling it on a new ` +
          `attribute while TTL is still active on '${prev.attributeName}' ` +
          `("TimeToLive is active on a different AttributeName"); DynamoDB also limits ` +
          `UpdateTimeToLive to one change per table per ~1 hour. To change the TTL ` +
          `attribute, do it in two deploys: (1) remove TimeToLiveSpecification (or set ` +
          `Enabled: false) to disable TTL on '${prev.attributeName}', then (2) after the ` +
          `disable settles (~1h), deploy again enabling TTL on '${cur.attributeName}'.`,
        resourceType,
        logicalId,
        physicalId
      );
    }
  }

  /**
   * Normalize a `TimeToLiveSpecification` value into `{ enabled, attributeName }`.
   * Mirrors {@link applyTimeToLive}'s default (`Enabled` absent => true).
   */
  private readTtlSpec(spec: unknown): { enabled: boolean; attributeName: string | undefined } {
    if (spec === undefined || spec === null) {
      return { enabled: false, attributeName: undefined };
    }
    const s = spec as Record<string, unknown>;
    const attributeName = s['AttributeName'] as string | undefined;
    // CFn `Enabled` is a boolean for CDK L2 synth, but a hand-written L1
    // template can carry the stringified `"true"` / `"false"`. `Boolean("false")`
    // is `true`, so coerce strings case-insensitively rather than via the bare
    // `Boolean()` cast (which would treat `"false"` as enabled and either
    // re-enable a disabled TTL or fire the rename guard spuriously). Absent
    // `Enabled` defaults to `true` (CFn default).
    const rawEnabled = s['Enabled'];
    const enabled =
      rawEnabled === undefined
        ? true
        : typeof rawEnabled === 'string'
          ? rawEnabled.toLowerCase() === 'true'
          : Boolean(rawEnabled);
    return { enabled, attributeName };
  }

  private async applyTimeToLive(
    tableName: string,
    spec: unknown,
    previousSpec?: unknown
  ): Promise<void> {
    if (spec !== undefined && spec !== null) {
      const { enabled, attributeName } = this.readTtlSpec(spec);
      if (!attributeName) return;
      await this.retryOnTransientControlPlane(
        () =>
          this.dynamoDBClient.send(
            new UpdateTimeToLiveCommand({
              TableName: tableName,
              TimeToLiveSpecification: { Enabled: enabled, AttributeName: attributeName },
            })
          ),
        `set TTL on ${tableName}`
      );
      this.logger.debug(
        `Set TimeToLive Enabled=${enabled} AttributeName=${attributeName} on DynamoDB table ${tableName}`
      );
      return;
    }

    // Removed from the template: disable using the previous AttributeName.
    if (previousSpec !== undefined && previousSpec !== null) {
      const prev = previousSpec as Record<string, unknown>;
      const prevAttributeName = prev['AttributeName'] as string | undefined;
      if (!prevAttributeName) return;
      await this.retryOnTransientControlPlane(
        () =>
          this.dynamoDBClient.send(
            new UpdateTimeToLiveCommand({
              TableName: tableName,
              TimeToLiveSpecification: { Enabled: false, AttributeName: prevAttributeName },
            })
          ),
        `disable TTL on ${tableName}`
      );
      this.logger.debug(
        `Disabled TimeToLive (AttributeName=${prevAttributeName}) on DynamoDB table ${tableName}`
      );
    }
  }

  /**
   * Extract the resource-policy document from the CFn `ResourcePolicy`
   * property and serialize it to the JSON string the DynamoDB APIs expect.
   *
   * CFn shape is `{ PolicyDocument: <JSON object | string> }`. Both
   * `CreateTable.ResourcePolicy` and `PutResourcePolicy.Policy` take a JSON
   * STRING, so a document already supplied as a string is passed through
   * verbatim (CDK can emit either an object or, post-intrinsic-resolution, a
   * string). Returns `undefined` when there is no policy document to apply.
   */
  private extractResourcePolicyDocument(spec: unknown): string | undefined {
    if (spec === undefined || spec === null) return undefined;
    const s = spec as Record<string, unknown>;
    const doc = s['PolicyDocument'];
    if (doc === undefined || doc === null) return undefined;
    return typeof doc === 'string' ? doc : JSON.stringify(doc);
  }

  /**
   * Apply the table's `ResourcePolicy` via the separate `PutResourcePolicy` /
   * `DeleteResourcePolicy` APIs (used by `update()` — `create()` rides the
   * policy on CreateTable directly). On removal — when the template drops the
   * block but it was present before — the existing policy is deleted.
   */
  private async applyResourcePolicy(
    tableArn: string,
    spec: unknown,
    previousSpec?: unknown
  ): Promise<void> {
    const policyDoc = this.extractResourcePolicyDocument(spec);
    if (policyDoc !== undefined) {
      // Wrapped in the transient-control-plane retry like the Kinesis /
      // ContributorInsights post-ACTIVE ops: update() runs PITR -> TTL ->
      // ResourcePolicy, and a preceding UpdateContinuousBackups leaves the
      // table settling, so a back-to-back PutResourcePolicy can hit
      // ResourceInUseException / "being updated".
      await this.retryOnTransientControlPlane(
        () =>
          this.dynamoDBClient.send(
            new PutResourcePolicyCommand({ ResourceArn: tableArn, Policy: policyDoc })
          ),
        `put ResourcePolicy on ${tableArn}`
      );
      this.logger.debug(`Put ResourcePolicy on DynamoDB table ${tableArn}`);
      return;
    }

    // Removed from the template: delete the existing policy. NotFound is
    // idempotent success (no policy to remove).
    if (previousSpec !== undefined && previousSpec !== null) {
      try {
        await this.retryOnTransientControlPlane(
          () =>
            this.dynamoDBClient.send(new DeleteResourcePolicyCommand({ ResourceArn: tableArn })),
          `delete ResourcePolicy on ${tableArn}`
        );
        this.logger.debug(`Deleted ResourcePolicy on DynamoDB table ${tableArn}`);
      } catch (error) {
        if (!(error instanceof ResourceNotFoundException)) throw error;
      }
    }
  }

  /**
   * Apply the table's `KinesisStreamSpecification` via the separate
   * Enable/Disable/Update `KinesisStreamingDestination` APIs (NOT a field on
   * CreateTable). CFn shape is
   * `{ StreamArn: string, ApproximateCreationDateTimePrecision?: 'MICROSECOND' | 'MILLISECOND' }`.
   *
   * Called from both `create()` (after the table is ACTIVE) and `update()`
   * (only when the value changed). On `update()`-side removal — template drops
   * the block but it was present before — streaming is disabled to the PREVIOUS
   * stream ARN. A same-ARN change of only the precision is a deliberate no-op
   * (re-enabling against an already-enabled stream errors), matching the
   * pre-existing WarmThroughput "no clean remap" stance; precision changes flow
   * through on the create / first-enable path.
   */
  private async applyKinesisStreamingDestination(
    tableName: string,
    spec: unknown,
    previousSpec?: unknown
  ): Promise<void> {
    const newArn = this.extractKinesisStreamArn(spec);
    const prevArn = this.extractKinesisStreamArn(previousSpec);

    // No change in target stream ARN: nothing to do (enable is not idempotent
    // against an already-enabled destination). A same-ARN change of ONLY the
    // precision is a deliberate no-op — but warn so the user knows the
    // precision edit did not reach AWS (UpdateKinesisStreamingDestination
    // could carry it, but re-enabling against an already-enabled stream
    // errors; deferred to a dedicated precision-update path).
    if (newArn === prevArn) {
      if (
        newArn &&
        JSON.stringify(
          (spec as Record<string, unknown> | undefined)?.['ApproximateCreationDateTimePrecision']
        ) !==
          JSON.stringify(
            (previousSpec as Record<string, unknown> | undefined)?.[
              'ApproximateCreationDateTimePrecision'
            ]
          )
      ) {
        this.logger.warn(
          `Kinesis streaming ApproximateCreationDateTimePrecision change on ${tableName} was not applied (same stream ARN; precision-only updates are not yet supported)`
        );
      }
      return;
    }

    // Disable streaming to the previous stream when it changed or was removed.
    if (prevArn) {
      await this.retryOnTransientControlPlane(
        () =>
          this.dynamoDBClient.send(
            new DisableKinesisStreamingDestinationCommand({
              TableName: tableName,
              StreamArn: prevArn,
            })
          ),
        `disable Kinesis streaming on ${tableName}`
      );
      this.logger.debug(
        `Disabled Kinesis streaming destination ${prevArn} on DynamoDB table ${tableName}`
      );
    }

    // Enable streaming to the new stream when present.
    if (newArn) {
      const s = spec as Record<string, unknown>;
      const precision = s['ApproximateCreationDateTimePrecision'] as string | undefined;
      await this.retryOnTransientControlPlane(
        () =>
          this.dynamoDBClient.send(
            new EnableKinesisStreamingDestinationCommand({
              TableName: tableName,
              StreamArn: newArn,
              ...(precision
                ? {
                    EnableKinesisStreamingConfiguration: {
                      ApproximateCreationDateTimePrecision: precision as
                        | 'MICROSECOND'
                        | 'MILLISECOND',
                    },
                  }
                : {}),
            })
          ),
        `enable Kinesis streaming on ${tableName}`
      );
      this.logger.debug(
        `Enabled Kinesis streaming destination ${newArn} on DynamoDB table ${tableName}`
      );
    }
  }

  private extractKinesisStreamArn(spec: unknown): string | undefined {
    if (spec === undefined || spec === null) return undefined;
    const arn = (spec as Record<string, unknown>)['StreamArn'];
    return typeof arn === 'string' ? arn : undefined;
  }

  /**
   * Extract the `StreamViewType` from a CFn `StreamSpecification` block. Returns
   * undefined when the spec is absent (no stream) — which is how update() tells
   * an enable / disable apart from a view-type change. CDK always emits a
   * StreamViewType when a stream is enabled (there is no valid enabled stream
   * without one), so a present spec implies a present view type; defensively
   * returns undefined for a malformed spec with no StreamViewType.
   */
  private extractStreamViewType(spec: unknown): string | undefined {
    if (spec === undefined || spec === null) return undefined;
    const viewType = (spec as Record<string, unknown>)['StreamViewType'];
    return typeof viewType === 'string' && viewType.length > 0 ? viewType : undefined;
  }

  /**
   * Fetch the table's current `LatestStreamArn` via DescribeTable. Used as a
   * fallback when an UpdateTable that enabled a stream did not echo the ARN
   * back in its TableDescription, so `Fn::GetAtt [Table, StreamArn]` still
   * resolves after an update-time enable.
   */
  private async describeLatestStreamArn(tableName: string): Promise<string | undefined> {
    const response = await this.dynamoDBClient.send(
      new DescribeTableCommand({ TableName: tableName })
    );
    return response.Table?.LatestStreamArn;
  }

  /**
   * Apply the table's `ContributorInsightsSpecification` via the separate
   * `UpdateContributorInsights` API (NOT a field on CreateTable). CFn shape is
   * `{ Enabled: boolean, Mode?: 'ACCESSED_AND_THROTTLED_KEYS' | 'THROTTLED_KEYS' }`.
   *
   * Called from both `create()` (after the table is ACTIVE) and `update()`
   * (only when the value changed). On `update()`-side removal — template drops
   * the block but it was present before — insights is disabled.
   */
  private async applyContributorInsights(
    tableName: string,
    spec: unknown,
    previousSpec?: unknown
  ): Promise<void> {
    let action: ContributorInsightsAction | undefined;
    let mode: ContributorInsightsMode | undefined;
    if (spec !== undefined && spec !== null) {
      const s = spec as Record<string, unknown>;
      const enabled = Boolean(s['Enabled']);
      action = enabled ? 'ENABLE' : 'DISABLE';
      // Mode only applies while enabling; AWS rejects it alongside DISABLE.
      if (enabled && s['Mode'] !== undefined) {
        mode = s['Mode'] as ContributorInsightsMode;
      }
    } else if (previousSpec !== undefined && previousSpec !== null) {
      // Removed from the template: disable.
      action = 'DISABLE';
    }

    if (action === undefined) return;

    await this.retryOnTransientControlPlane(
      () =>
        this.dynamoDBClient.send(
          new UpdateContributorInsightsCommand({
            TableName: tableName,
            ContributorInsightsAction: action,
            ...(mode ? { ContributorInsightsMode: mode } : {}),
          })
        ),
      `set ContributorInsights on ${tableName}`
    );
    this.logger.debug(
      `Set ContributorInsightsAction=${action}${
        mode !== undefined ? ` Mode=${mode}` : ''
      } on DynamoDB table ${tableName}`
    );
  }

  /**
   * Poll DescribeTable until the table reaches ACTIVE status
   *
   * Uses a tight polling loop (1s intervals) instead of CC API's exponential
   * backoff (1s->2s->4s->8s->10s), reducing total wait time.
   */
  private async waitForTableActive(
    tableName: string,
    maxAttempts = 60
  ): Promise<{
    tableArn: string | undefined;
    tableId: string | undefined;
    streamArn: string | undefined;
  }> {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const response = await this.dynamoDBClient.send(
        new DescribeTableCommand({ TableName: tableName })
      );

      const status = response.Table?.TableStatus;
      this.logger.debug(`Table ${tableName} status: ${status} (attempt ${attempt}/${maxAttempts})`);

      if (status === 'ACTIVE') {
        return {
          tableArn: response.Table?.TableArn,
          tableId: response.Table?.TableId,
          streamArn: response.Table?.LatestStreamArn,
        };
      }

      if (status !== 'CREATING') {
        throw new Error(`Unexpected table status: ${status}`);
      }

      // Wait 1 second between polls
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    throw new Error(`Table ${tableName} did not reach ACTIVE status within ${maxAttempts} seconds`);
  }

  /**
   * Poll `DescribeTable` until the table leaves `UPDATING`. Distinct from
   * `waitForTableActive` because `UpdateTable` transitions the table to
   * `UPDATING` (not `CREATING`), so a status mismatch must keep polling
   * rather than throw, and the call may return immediately ACTIVE.
   *
   * The 60-attempt (60s) default was calibrated on capacity / TTL / tag edits,
   * which settle in seconds. A **BillingMode flip does not** — measured
   * 2026-08-11 on the `dynamodb-ondemand` fixture, a PAY_PER_REQUEST ->
   * PROVISIONED flip exceeded 60s and failed the deploy with
   * `did not reach ACTIVE status within 60 seconds`, rolling the whole stack
   * back. It was invisible before issue #1553 because the removal that
   * triggers the flip never produced a valid `UpdateTable` at all; making the
   * call correct is what put a real flip on this path.
   *
   * So the timeout is per-OPERATION rather than global: a flip gets 600s (the
   * same order as the GlobalTable provider's own settle waits), everything
   * else keeps the 60s that has been sufficient for two years of integs. A
   * blanket raise would turn every genuinely wedged capacity edit into a
   * 10-minute hang.
   */
  private async waitForTableActiveAfterUpdate(
    tableName: string,
    maxAttempts = TABLE_ACTIVE_WAIT_ATTEMPTS
  ): Promise<void> {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const response = await this.dynamoDBClient.send(
        new DescribeTableCommand({ TableName: tableName })
      );
      const status = response.Table?.TableStatus;
      if (status === 'ACTIVE') {
        return;
      }
      // Sleep between polls; tolerate any non-terminal status (UPDATING,
      // and defensively CREATING / others) — we just wait for ACTIVE.
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    throw new Error(
      `Table ${tableName} did not reach ACTIVE status within ${maxAttempts} seconds after UpdateTable`
    );
  }

  /**
   * Poll DescribeTable until the table is ACTIVE AND every Global Secondary
   * Index is ACTIVE (not CREATING / UPDATING / DELETING / BACKFILLING). Used
   * between GSI mutations because a freshly-created index keeps backfilling
   * after the table itself returns to ACTIVE, and AWS rejects the next GSI op
   * until the prior index settles.
   *
   * `WarmThroughput.Status` is deliberately NOT part of the predicate, and that
   * is MEASURED rather than assumed (PR review of issue #1768 raised it as a
   * suspected race, since the per-index warm-throughput send path this provider
   * gained has no other reason to wait). Live, us-east-1 2026-08-13, on a
   * PAY_PER_REQUEST table with two ACTIVE GSIs: raising `gsi1`'s warm
   * throughput 12000/4000 -> 14000/5000 left
   *
   * ```
   * TableStatus: ACTIVE | gsi1: IndexStatus ACTIVE, WarmThroughput.Status UPDATING
   *                     | gsi2: IndexStatus ACTIVE, WarmThroughput.Status ACTIVE
   * ```
   *
   * for 90+ seconds — so this predicate IS satisfied while a warm update is
   * still settling, exactly as the review described. What does not follow is
   * the failure: with `gsi1` in that state, all three next-op shapes were
   * ACCEPTED, no `ResourceInUseException` —
   *
   *  - a warm-throughput `Update` on the OTHER index (`gsi2`);
   *  - a warm-throughput `Update` on the SAME index (`gsi1`);
   *  - a GSI `Create` (`gsi3`), the op AWS gates most strictly.
   *
   * So warm throughput settles OUT OF BAND of the index lifecycle, and adding
   * it to this predicate would only make every GSI op wait on a status that
   * blocks nothing — minutes of wait budget spent per op, with a real risk of
   * exhausting it on a table whose warm status lingers.
   */
  private async waitForTableAndIndexesActive(tableName: string, maxAttempts = 1800): Promise<void> {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const response = await this.dynamoDBClient.send(
        new DescribeTableCommand({ TableName: tableName })
      );
      const table = response.Table;
      const tableActive = table?.TableStatus === 'ACTIVE';
      const indexesActive = (table?.GlobalSecondaryIndexes ?? []).every(
        (gsi) => gsi.IndexStatus === 'ACTIVE'
      );
      if (tableActive && indexesActive) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    throw new Error(
      `Table ${tableName} and its global secondary indexes did not reach ACTIVE within ${maxAttempts} seconds after UpdateTable`
    );
  }

  /**
   * Apply Global Secondary Index add / remove / per-index throughput changes
   * via UpdateTable's `GlobalSecondaryIndexUpdates`.
   *
   * AWS constraints mirrored here:
   *  - At most ONE GSI Create or Delete per UpdateTable call; a second
   *    mutation while the table / an index is still building is rejected. Each
   *    op therefore runs in its own UpdateTable and waits for ACTIVE before the
   *    next (creating GSIs also go through a BACKFILLING phase that ACTIVE
   *    covers).
   *  - A GSI `Create` must carry the AttributeDefinitions for the new index's
   *    key attributes — the full desired AttributeDefinitions array is passed
   *    so every newly-referenced attribute is defined.
   *  - On an existing same-name index, only a PROVISIONED `ProvisionedThroughput`
   *    (RCU/WCU) change is mutable in place and is issued as an `Update`. A
   *    `KeySchema` / `Projection` change is immutable in place (AWS models it as
   *    a delete + re-create); since the diff keys GSIs by name it would not emit
   *    a remove-then-add pair, so this method throws on such a change rather than
   *    silently dropping it.
   */
  private async applyGsiUpdates(
    physicalId: string,
    resourceType: string,
    logicalId: string,
    previousGsis: GlobalSecondaryIndex[] | undefined,
    desiredGsis: GlobalSecondaryIndex[] | undefined,
    desiredAttributeDefinitions: AttributeDefinition[] | undefined,
    // Names whose capacity the BillingMode flip already delivered in its own
    // UpdateTable. Their throughput Update MUST be skipped here — AWS rejects a
    // capacity change that equals the current value, so re-asserting it fails
    // the deploy outright. Only the throughput arm is suppressed: an index that
    // was ADDED or REMOVED in the same deploy still needs its own op.
    handledByBillingFlip: ReadonlySet<string> = new Set<string>(),
    // The index names AWS actually has right now (issue #1617). A Delete is
    // emitted only for a name in this set, which makes the removal arm
    // IDEMPOTENT — covering both the indexes the pre-flip removal just deleted
    // (a second Delete would fail with `ResourceNotFoundException`) and the
    // pre-existing case of a state record naming an index that is already gone
    // in AWS, which otherwise fails every deploy forever because cdkd only
    // writes state after a SUCCESSFUL update.
    //
    // `undefined` means "no live snapshot to reason from" and disables the
    // filter, so a caller without a DescribeTable result keeps the original
    // behavior rather than silently skipping every removal.
    liveIndexNames?: ReadonlySet<string>,
    // The live `DescribeTable` index descriptions, keyed by name (issue
    // #1630). Carries the whole description rather than just the capacity
    // because the Create arm also needs `IndexStatus` to tell a recovered
    // index from one that is on its way OUT. `undefined` = no snapshot to
    // reason from, which disables both idempotency arms.
    liveIndexByName?: ReadonlyMap<string, GlobalSecondaryIndexDescription>,
    // Whether the live capacity NUMBERS mean anything. False for a table whose
    // LIVE billing mode is PAY_PER_REQUEST, where `DescribeTable` reports
    // `{0, 0}` for every index (the #1571 trap) — comparing that would be
    // meaningless, so the capacity half stays disabled while the EXISTENCE
    // half above still applies.
    liveCapacityComparable = false
  ): Promise<void> {
    const prev = previousGsis ?? [];
    const desired = desiredGsis ?? [];
    const prevByName = new Map(prev.filter((g) => g.IndexName).map((g) => [g.IndexName!, g]));
    const desiredByName = new Map(desired.filter((g) => g.IndexName).map((g) => [g.IndexName!, g]));

    // Each entry is a single GlobalSecondaryIndexUpdates op applied in its own
    // UpdateTable call. Deletes first (free up the one-op-per-call budget and
    // any attribute no longer needed), then creates, then throughput updates.
    const ops: GlobalSecondaryIndexUpdate[] = [];

    for (const name of prevByName.keys()) {
      if (desiredByName.has(name)) continue;
      if (liveIndexNames !== undefined && !liveIndexNames.has(name)) {
        this.logger.debug(
          `GSI ${name} is recorded in cdkd state but not live on DynamoDB table ${physicalId}; ` +
            `skipping its Delete (already removed)`
        );
        continue;
      }
      ops.push({ Delete: { IndexName: name } });
    }

    for (const [name, gsi] of desiredByName) {
      if (!prevByName.has(name)) {
        const live = liveIndexByName?.get(name);
        // The Create arm's idempotency half (issue #1630), the sibling of the
        // Delete filter above. cdkd writes state only after `update()` RETURNS,
        // so a throw in any of the steps that follow `applyGsiUpdates` (PITR,
        // TTL, ResourcePolicy, Kinesis streaming, Contributor Insights) leaves
        // a just-created index unrecorded — the next deploy re-emits its
        // Create, AWS rejects it because the index now exists, and every later
        // deploy fails identically until the user runs `cdkd drift --accept`.
        // Skipping a Create for a name AWS already has is what makes the arm
        // converge instead.
        //
        // WARN rather than debug: reaching this means state and AWS disagree,
        // which is worth surfacing even though cdkd recovers from it.
        // The required-field check runs BEFORE the recovery skip: a template
        // missing `KeySchema` is broken regardless of what AWS happens to
        // hold, and skipping past it would record the broken bag into state.
        if (!gsi.KeySchema) {
          throw new ProvisioningError(
            `GlobalSecondaryIndex ${name} on DynamoDB table ${logicalId} is missing KeySchema`,
            resourceType,
            logicalId,
            physicalId
          );
        }
        // `DELETING` deliberately does NOT count as live here: the index is on
        // its way out, so skipping its Create would leave it absent from AWS
        // while state records it. (The Delete arm's `liveIndexNames` DOES
        // include it, correctly — a Delete for an already-DELETING index is
        // the call that should be suppressed.)
        const recovered = live !== undefined && live.IndexStatus !== 'DELETING';
        if (recovered) {
          this.logger.warn(
            `GSI ${name} on DynamoDB table ${physicalId} already exists in AWS but is absent ` +
              `from cdkd's recorded previous state, so its Create is being skipped. This ` +
              `usually means an earlier deploy created the index and then failed before ` +
              `state was written.`
          );
          // Skipping on the NAME alone would be a silent state divergence
          // (review of this PR): if the retry ALSO edits the recovered index,
          // no op is emitted, the engine records the DESIRED bag on success,
          // and no later diff converges — state claims one capacity while AWS
          // holds another, forever. Pre-fix this failed loudly at AWS, so the
          // skip must not trade a loud failure for a quiet lie.
          //
          // Capacity is comparable and is therefore repaired: fall through to
          // the same `Update` the same-name path would emit.
          // ONE action carrying whichever members need repair, for the same
          // reason as the same-name arm below.
          const adopted: UpdateGlobalSecondaryIndexAction = { IndexName: name };
          let adoptedHasMember = false;
          if (
            liveCapacityComparable &&
            gsi.ProvisionedThroughput &&
            !handledByBillingFlip.has(name) &&
            !liveCapacityAlreadyMatches(live.ProvisionedThroughput, gsi.ProvisionedThroughput) &&
            !this.skipZeroCapacityIndexUpdate(name, physicalId, gsi.ProvisionedThroughput)
          ) {
            adopted.ProvisionedThroughput = gsi.ProvisionedThroughput;
            adoptedHasMember = true;
          }
          // WarmThroughput is repaired on the adopted index for the same reason
          // capacity is (issue #1768): the Create was skipped, so nothing else
          // in this deploy would ever send it. There is no recorded previous
          // side here, so the value is compared only against what AWS holds.
          const adoptedWarm = this.warmThroughputOpFor(name, physicalId, gsi, undefined, live);
          if (adoptedWarm) {
            adopted.WarmThroughput = adoptedWarm;
            adoptedHasMember = true;
          }
          if (adoptedHasMember) {
            ops.push({ Update: adopted });
          }
          // KeySchema / Projection are deliberately NOT compared here, and the
          // divergence is ANNOUNCED instead of refused. The same-name path can
          // compare them because both its sides are CFn-shaped; here the live
          // side is an AWS READBACK, where `Projection` is normalized and
          // `NonKeyAttributes` ordering is not guaranteed — structurally
          // comparing across that boundary is the #1571 "the comparator can
          // actually tell them apart" trap, and a false positive would refuse
          // a perfectly valid deploy. A visible warning naming `cdkd drift` is
          // the honest answer for the shape half.
          this.logger.warn(
            `GSI ${name} was adopted from AWS rather than created, so cdkd could not verify ` +
              `its KeySchema / Projection match the template. Run \`cdkd drift ${physicalId}\` ` +
              `to confirm, and \`cdkd drift --accept\` if AWS is the source of truth.`
          );
          continue;
        }
        // A declared-but-unsendable WarmThroughput is announced here rather
        // than vanishing into the spread below (PR review of issue #1768).
        this.warnRefusedWarmThroughput(
          `GSI ${name} on DynamoDB table ${physicalId}`,
          gsi.WarmThroughput
        );
        // COERCED, not forwarded verbatim (PR review round 5): a quoted
        // `'12000'` must reach AWS as a number, not as a string in a Long
        // field.
        const createWarm = this.coerceWarmThroughputForSend(
          `GSI ${name} on DynamoDB table ${physicalId}`,
          gsi.WarmThroughput
        );
        ops.push({
          Create: {
            IndexName: name,
            KeySchema: gsi.KeySchema,
            Projection: gsi.Projection,
            ...(gsi.ProvisionedThroughput
              ? { ProvisionedThroughput: gsi.ProvisionedThroughput }
              : {}),
            ...(gsi.OnDemandThroughput ? { OnDemandThroughput: gsi.OnDemandThroughput } : {}),
            // A declared per-index WarmThroughput rides the Create action
            // (issue #1768): `CreateGlobalSecondaryIndexAction` accepts it, and
            // without it the property was silently dropped for every index
            // added after the table's own creation. This used to add that
            // `create()` "forwards it on the CreateTable path, so only this arm
            // was missing" — true when written, and made false by PR review
            // round 6, which found that forward was itself uncoerced and routed
            // it through the same helper. BOTH paths coerce now.
            ...(createWarm ? { WarmThroughput: createWarm } : {}),
          },
        });
      } else {
        const before = prevByName.get(name)!;
        // A same-name index's KeySchema / Projection are immutable in place —
        // AWS models such a change as a delete + re-create of the index. cdkd's
        // diff keys GSIs by name, so it would NOT emit a remove-then-add pair
        // for an in-place key/projection edit; applying only a throughput Update
        // (or nothing) would silently drop the change and record state as if it
        // applied. Fail loud instead (the no-silent-drop rule) so the user
        // renames the index (forcing remove + add) or accepts a table replace.
        if (
          JSON.stringify(before.KeySchema) !== JSON.stringify(gsi.KeySchema) ||
          JSON.stringify(before.Projection) !== JSON.stringify(gsi.Projection)
        ) {
          throw new ProvisioningError(
            `GlobalSecondaryIndex ${name} on DynamoDB table ${logicalId} changed its ` +
              `KeySchema or Projection, which DynamoDB cannot modify in place. Rename the ` +
              `index (so it is dropped and re-created) or replace the table.`,
            resourceType,
            logicalId,
            physicalId
          );
        }
        // ONE Update action per index, carrying whichever members changed
        // (PR review of issue #1768). `UpdateGlobalSecondaryIndexAction` takes
        // `ProvisionedThroughput` AND `WarmThroughput`, both optional, so
        // splitting them cost a second `UpdateTable` PLUS a second full
        // index-ACTIVE wait against the 1800s budget for an index that changed
        // both. `runGsiOps` issues one call per op, so merging here is what
        // makes it one call.
        const update: UpdateGlobalSecondaryIndexAction = { IndexName: name };
        let updateHasMember = false;
        // Only ProvisionedThroughput is mutable in place on an existing index.
        // A numeric RCU/WCU change on a PROVISIONED GSI is issued as an Update;
        // a PROVISIONED->on-demand per-index drop is driven by the table-wide
        // BillingMode switch (handled above), not here.
        if (
          gsi.ProvisionedThroughput &&
          !handledByBillingFlip.has(name) &&
          JSON.stringify(before.ProvisionedThroughput) !== JSON.stringify(gsi.ProvisionedThroughput)
        ) {
          // The Update arm's idempotency half (issue #1630). The recorded
          // previous side says the capacity changed, but a throughput Update
          // that already LANDED before a later step threw is unrecorded — and
          // re-emitting it is rejected outright: "The provisioned throughput
          // for the index X will not change. The requested value equals the
          // current value." (the same rejection `gsiHandledByBillingFlip`
          // exists for, reached by a different route). Consulting what AWS
          // actually holds is what lets the deploy converge.
          if (
            liveCapacityComparable &&
            liveCapacityAlreadyMatches(
              liveIndexByName?.get(name)?.ProvisionedThroughput,
              gsi.ProvisionedThroughput
            )
          ) {
            this.logger.debug(
              `GSI ${name} on DynamoDB table ${physicalId} already carries the requested ` +
                `capacity in AWS; skipping its throughput Update`
            );
          } else if (
            !this.skipZeroCapacityIndexUpdate(name, physicalId, gsi.ProvisionedThroughput)
          ) {
            update.ProvisionedThroughput = gsi.ProvisionedThroughput;
            updateHasMember = true;
          }
        }
        // WarmThroughput on an existing index (issue #1768), on the SAME action.
        const warm = this.warmThroughputOpFor(
          name,
          physicalId,
          gsi,
          before,
          liveIndexByName?.get(name)
        );
        if (warm) {
          update.WarmThroughput = warm;
          updateHasMember = true;
        }
        if (updateHasMember) {
          ops.push({ Update: update });
        }
      }
    }

    await this.runGsiOps(physicalId, ops, desiredAttributeDefinitions);
  }

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
  private coerceWarmThroughputForSend(scope: string, value: unknown): WarmThroughput | undefined {
    const coerced = coerceWarmThroughput(value);
    if (coerced === undefined) return undefined;
    if (coerced.dropped.length > 0) {
      this.logger.warn(
        `${scope}: WarmThroughput member(s) ${coerced.dropped.join(', ')} in ` +
          `${JSON.stringify(value)} are not a number DynamoDB accepts, so they were dropped from ` +
          `the request, which leaves ${JSON.stringify(coerced.spec)}. Check for an unresolved ` +
          `intrinsic or a non-numeric value.`
      );
    }
    return coerced.spec;
  }

  /**
   * One `CreateTable` index entry with its `WarmThroughput` coerced (PR review
   * round 6).
   *
   * `create()` forwards the declared `GlobalSecondaryIndexes` array to
   * `CreateTable`, so it is a SEND SITE for the same per-index value the
   * update path coerces — and it was the one the round-5 sweep missed. Entries
   * are rebuilt rather than mutated: the input bag belongs to the caller (the
   * resolved template, which the engine also records into state), and a
   * provider that edits it in place would change what state reports cdkd sent.
   *
   * An entry that is not a plain object, or that declares no `WarmThroughput`,
   * is returned UNCHANGED — including the identity of the object, so the
   * common case allocates nothing.
   */
  private coerceIndexWarmThroughputForCreate(
    logicalId: string,
    entry: GlobalSecondaryIndex
  ): GlobalSecondaryIndex {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return entry;
    const declared = (entry as unknown as Record<string, unknown>)['WarmThroughput'];
    if (declared === undefined) return entry;
    const scope = `GSI ${entry.IndexName ?? '<unnamed>'} on AWS::DynamoDB::Table ${logicalId}`;
    const coerced = this.coerceWarmThroughputForSend(scope, declared);
    if (coerced === undefined) {
      // Nothing usable: drop the block from the request and say so, exactly as
      // the update-side arms do.
      this.warnRefusedWarmThroughput(scope, declared);
      const { WarmThroughput: _dropped, ...rest } = entry;
      return rest;
    }
    return { ...entry, WarmThroughput: coerced };
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
  private warnRefusedWarmThroughput(scope: string, value: unknown): void {
    if (!isRefusedWarmThroughput(value)) return;
    this.logger.warn(
      `${scope}: the declared WarmThroughput ${JSON.stringify(value)} carries no usable ` +
        `ReadUnitsPerSecond or WriteUnitsPerSecond, so it was NOT sent — DynamoDB accepts only ` +
        `those two members and rejects a request without either. Check for a misspelled member ` +
        `name or an unresolved intrinsic. Nothing else on this resource was affected.`
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
   * CALLER-BLIND, decided rather than overlooked (PR review). A TEMPLATE-borne
   * `{0, 0}` warn-skips here while `create()` fails loudly on the same value,
   * which reads like the "loud failure for a quiet lie" trade the adopted-index
   * arm below forbids. It stands for three reasons:
   *
   *  - The discriminator that EXISTS does not separate the callers that matter.
   *    `ResourceProvider.update` DOES take an optional `UpdateContext` — an
   *    earlier draft of this comment claimed the signature carries no context
   *    at all, which is simply false (`s3-bucket-provider.ts` consumes it
   *    today) — but its one field, `desiredFromAwsReadback`, is set ONLY by
   *    `cdkd drift --revert` (`src/cli/commands/drift.ts`). The rollback
   *    executor's revert arms deliberately pass NO context: their desired bag
   *    is `previousState.properties`, a TEMPLATE recorded earlier, so they are
   *    indistinguishable from an ordinary template deploy — and THAT is the
   *    pair this decision turns on. Knowing the value came from a readback
   *    would not license throwing on the other two.
   *  - With the caller unknowable, the repo's rule for the UPDATE path is
   *    WARN-never-throw (issues #1545 / #1552): the desired bag here can BE a
   *    historical cdkd state record, and a refusal would make the table
   *    un-updatable and un-rollbackable with no template-side remedy.
   *  - The lie is bounded and self-surfacing. AWS never accepted `{0, 0}` at
   *    create either, so no live table can be holding it; and where the value
   *    would actually matter — a PROVISIONED table, whose indexes hold a real
   *    capacity — recording `{0, 0}` diverges from the readback and `cdkd drift`
   *    REPORTS it. On a PAY_PER_REQUEST table the recorded `{0, 0}` matches what
   *    `DescribeTable` reports for every index anyway, so there is no divergence
   *    to hide.
   */
  private skipZeroCapacityIndexUpdate(
    indexName: string,
    physicalId: string,
    requested: ProvisionedThroughput | undefined
  ): boolean {
    if (requested === undefined) return false;
    if (
      toFiniteNumber(requested.ReadCapacityUnits) !== 0 ||
      toFiniteNumber(requested.WriteCapacityUnits) !== 0
    ) {
      return false;
    }
    this.logger.warn(
      `GSI ${indexName} on DynamoDB table ${physicalId}: the requested ProvisionedThroughput is ` +
        `{ReadCapacityUnits: 0, WriteCapacityUnits: 0}, which is AWS's on-demand placeholder rather ` +
        `than a capacity DynamoDB accepts (the minimum is 1), so no per-index throughput update was ` +
        `sent. This usually means the value came from a pre-#1767 cdkd state record — a ` +
        `\`cdkd drift --revert\` of such a record, or a rollback replaying it. Re-run ` +
        `\`cdkd deploy\` (or \`cdkd drift --accept\`) to refresh the record.`
    );
    return true;
  }

  /**
   * The per-index `WarmThroughput` this update should send, or `undefined`
   * (issue #1768, one nesting level down from the table-level branch).
   *
   * `applyGsiUpdates` used to send only `ProvisionedThroughput` /
   * `OnDemandThroughput` on both of its arms, while `readCurrentState` emits a
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
  private warmThroughputOpFor(
    indexName: string,
    physicalId: string,
    desired: GlobalSecondaryIndex,
    previous: GlobalSecondaryIndex | undefined,
    live: GlobalSecondaryIndexDescription | undefined
  ): WarmThroughput | undefined {
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
    const sendable = this.coerceWarmThroughputForSend(
      `GSI ${indexName} on DynamoDB table ${physicalId}`,
      requested
    );
    if (sendable === undefined) {
      this.warnRefusedWarmThroughput(`GSI ${indexName} on DynamoDB table ${physicalId}`, requested);
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
      this.logger.debug(
        `GSI ${indexName} on DynamoDB table ${physicalId} already carries the requested warm ` +
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
      this.logger.warn(
        `GSI ${indexName} on DynamoDB table ${physicalId}: the requested WarmThroughput ` +
          `${JSON.stringify(sendable)} is lower than the ${JSON.stringify({
            ReadUnitsPerSecond: live?.WarmThroughput?.ReadUnitsPerSecond,
            WriteUnitsPerSecond: live?.WarmThroughput?.WriteUnitsPerSecond,
          })} DynamoDB currently holds for that index. Warm throughput only ever RISES with an ` +
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
   * Issue a list of `GlobalSecondaryIndexUpdates` ops, one per `UpdateTable`,
   * waiting for the table AND every index to return to ACTIVE between each.
   *
   * Extracted from {@link applyGsiUpdates} so the pre-flip GSI removal (issue
   * #1617) drives the identical call + wait sequence rather than a second copy
   * of it — the wait is what makes the next op (there, the BillingMode flip)
   * legal.
   */
  private async runGsiOps(
    physicalId: string,
    ops: GlobalSecondaryIndexUpdate[],
    desiredAttributeDefinitions: AttributeDefinition[] | undefined
  ): Promise<void> {
    for (const op of ops) {
      const input: UpdateTableCommandInput = {
        TableName: physicalId,
        GlobalSecondaryIndexUpdates: [op],
      };
      // A Create references new key attributes, so it must include their
      // definitions. Forward the full desired set (AWS ignores already-known
      // attribute definitions and validates that every indexed attribute is
      // present).
      if (op.Create && desiredAttributeDefinitions) {
        input.AttributeDefinitions = desiredAttributeDefinitions;
      }
      await this.dynamoDBClient.send(new UpdateTableCommand(input));
      // GSI create/delete is async: the table returns to ACTIVE quickly while a
      // new index is still CREATING -> BACKFILLING. AWS rejects the next GSI op
      // until every index is fully ACTIVE, and CloudFormation likewise waits for
      // the index to finish before completing — so wait on BOTH the table and
      // every GSI status, not just the table.
      await this.waitForTableAndIndexesActive(physicalId);
      const verb = op.Create ? 'created' : op.Delete ? 'deleted' : 'updated';
      this.logger.debug(
        `${verb} GSI ${op.Create?.IndexName ?? op.Delete?.IndexName ?? op.Update?.IndexName} on DynamoDB table ${physicalId}`
      );
    }
  }

  /**
   * Resolve a single `Fn::GetAtt` attribute for an existing DynamoDB table.
   *
   * CloudFormation's `AWS::DynamoDB::Table` exposes `Arn`, `StreamArn`
   * (a.k.a. `LatestStreamArn` in the SDK; CFn returns the latest enabled
   * stream's ARN), and `LatestStreamLabel`. All three are sibling fields on
   * the same `DescribeTable` response, so a single API call covers every
   * supported attr. See:
   * https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-dynamodb-table.html#aws-resource-dynamodb-table-return-values
   *
   * Used by `cdkd orphan` to live-fetch attribute values that need to be
   * substituted into sibling references.
   */
  async getAttribute(
    physicalId: string,
    _resourceType: string,
    attributeName: string
  ): Promise<unknown> {
    try {
      const resp = await this.dynamoDBClient.send(
        new DescribeTableCommand({ TableName: physicalId })
      );
      switch (attributeName) {
        case 'Arn':
          return resp.Table?.TableArn;
        case 'StreamArn':
          return resp.Table?.LatestStreamArn;
        case 'LatestStreamLabel':
          return resp.Table?.LatestStreamLabel;
        default:
          return undefined;
      }
    } catch (err) {
      if (err instanceof ResourceNotFoundException) return undefined;
      throw err;
    }
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
  private skipWarmThroughputDecrease(
    logicalId: string,
    physicalId: string,
    // The COERCED spec, never the raw declared bag (PR review round 7): this
    // gate decides whether to make a call, so it has to analyse the call that
    // would be made. The message below quotes it for the same reason — a user
    // reading "the requested WarmThroughput {...}" needs the request, not a
    // bag containing members cdkd already dropped.
    desired: WarmThroughput,
    live: WarmThroughputUnits | undefined
  ): boolean {
    if (!isWarmThroughputDecrease(desired, live)) return false;
    this.logger.warn(
      `AWS::DynamoDB::Table ${logicalId}: the requested WarmThroughput ` +
        `${JSON.stringify(desired)} is lower than the ${JSON.stringify({
          ReadUnitsPerSecond: live?.ReadUnitsPerSecond,
          WriteUnitsPerSecond: live?.WriteUnitsPerSecond,
        })} DynamoDB currently holds for table ${physicalId}. Warm throughput only ever RISES ` +
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

  /**
   * `AttributeDefinitions` is a SET, keyed by `AttributeName`: CFn accepts the
   * members in any order and `DescribeTable` returns them in an order matching
   * neither the request nor the template. Measured live (us-east-1,
   * 2026-08-13): a `CreateTable` whose input declared
   * `[{pk,S}, {gsipk,S}]` read back as `[{gsipk,S}, {pk,S}]` on the create
   * response AND on every later `DescribeTable`. The comparator compares
   * arrays positionally, so without this declaration the reorder is permanent
   * phantom drift on a table nobody touched — reachable whenever the drift
   * baseline is the template `properties` rather than `observedProperties`
   * (after a reverse-replacement rollback, which strips `observedProperties`,
   * or on a resource deployed before observed-capture existed; on the ordinary
   * path both sides come from the same readback and already agree, which is
   * why routine runs never surfaced it). Issue #1760, the
   * `AWS::DynamoDB::Table` twin of issue #1742's `AWS::DynamoDB::GlobalTable`
   * finding.
   *
   * `KeySchema` is deliberately NOT declared, at the table level or the index
   * level: it is order-SIGNIFICANT (HASH before RANGE), so sorting it would
   * HIDE a real key change rather than remove a phantom one.
   *
   * `GlobalSecondaryIndexes` / `LocalSecondaryIndexes` are NOT declared either,
   * and that is a MECHANISM limit rather than a judgement about the lists —
   * both really are sets keyed by `IndexName` (issue #1767 proposes declaring
   * them). Every entry here is a SUBTREE declaration, and unlike
   * `getDriftUnknownPaths` this walk DESCENDS INTO ARRAY ELEMENTS giving each
   * the parent's path (`drift-normalize.ts`), so a `'GlobalSecondaryIndexes'`
   * entry also reaches `GlobalSecondaryIndexes.KeySchema` and would sort the
   * per-index key schema — reversing the sentence above at the index level
   * only. Issue #1767 calls the sort and the member reverse-map separable;
   * this change ships the reverse-map, and the ordering half needed a
   * leaf-only form of the declaration first (issue
   * [#1783](https://github.com/go-to-k/cdkd/issues/1783)). **That form now
   * EXISTS** — `LEAF_ONLY_PATH_SUFFIX` (`[]`) landed in
   * [#1799](https://github.com/go-to-k/cdkd/pull/1799), so
   * `'GlobalSecondaryIndexes[]'` would claim the list alone without reaching
   * the per-index `KeySchema`. It is deliberately NOT declared here yet:
   * adopting it is its own change with its own real-AWS verification, tracked
   * as issue [#1812](https://github.com/go-to-k/cdkd/issues/1812). Consequence
   * until then, stated so it is not mistaken for solved: an index list AWS
   * returns in a different ORDER than the template declared is still phantom
   * drift against a `properties` baseline. It is not reachable on the ordinary
   * `observedProperties` path, where both sides come from this same readback.
   */
  getDriftUnorderedPaths(resourceType: string): string[] {
    if (resourceType !== 'AWS::DynamoDB::Table') return [];
    return ['AttributeDefinitions'];
  }

  /**
   * `WarmThroughput` is reported by AWS for EVERY table, whether or not the
   * template ever asked for one. Measured live (us-east-1, 2026-08-13) on a
   * `CreateTable` whose input declared NO `WarmThroughput`:
   *
   * ```
   * "WarmThroughput": { "ReadUnitsPerSecond": 12000,
   *                     "WriteUnitsPerSecond": 4000, "Status": "ACTIVE" }
   * ```
   *
   * so `readCurrentState`'s emit-when-present guard could never do what its
   * comment claimed ("only on tables that set warm throughput"). That value is
   * AWS-computed and AWS-owned — it only ever increases as the table's traffic
   * grows, and it cannot be lowered — so once it is frozen into an
   * `observedProperties` baseline, a later AWS-side increase surfaces as drift
   * on a property the user never declared and `--revert` would issue a
   * decrease AWS rejects. `readCurrentState` therefore emits it only when the
   * DESIRED bag declares it (the fix issue #1742 PROPOSES for the per-index
   * sibling — still open and unlanded at the time of writing, so this is the
   * first site to carry the shape), never as a blanket drop:
   * `AWS::DynamoDB::Table` accepts an explicit `WarmThroughput` and a real
   * change to one must stay visible. Known residual on that declared arm
   * (issue #1768): AWS may GROW a declared value, which is reported as drift —
   * correctly, cdkd holds a value AWS no longer has — but `--revert` then
   * issues a decrease AWS rejects, surfacing as a per-resource revert failure
   * rather than as a silent wrong answer.
   *
   * This declaration is the OTHER half: a state record written by an earlier
   * binary already carries the computed value in `observedProperties`, so the
   * gate alone would flip every such table to a one-sided `WarmThroughput`
   * drift (baseline has it, the AWS side no longer emits it) until the next
   * deploy refreshed the capture. Ignoring the path on BOTH sides when the
   * template declares nothing covers the transition and the steady state
   * alike; a table that DOES declare `WarmThroughput` is compared normally.
   * Same per-resource scoping seam as `AWS::ApiGatewayV2::Integration`'s
   * `TlsConfig` (issue #1602): an absent / empty bag falls back to the
   * type-level answer of COMPARING, since hiding a real drift is the worse
   * failure.
   *
   * `GlobalSecondaryIndexes` / `LocalSecondaryIndexes` join it under the SAME
   * rule for the SAME reason (issue #1767), one nesting level up: the readback
   * now emits the reverse-mapped CFn shape, so every `observedProperties`
   * baseline an earlier binary wrote — which carries `IndexStatus` /
   * `ItemCount` / `IndexArn` / the on-demand `{0, 0}` placeholder / the
   * computed per-index `WarmThroughput` — no longer equals it. Ignoring the
   * path on both sides when the template declares NO index list covers the
   * transition and the steady state for that population, exactly as the
   * `WarmThroughput` arm does: an index list the template never declared is
   * AWS-authored (created out of band, or by a sibling), which is the #1498
   * class.
   *
   * Known residual, deliberately NOT covered, because covering it costs more
   * than it buys: a table whose template DOES declare indexes keeps comparing,
   * so its already-written observed baseline reports a one-sided
   * `GlobalSecondaryIndexes` difference until the next deploy re-captures it
   * (or `cdkd drift --accept` does). `cdkd drift --revert` is the third thing a
   * user may reach for on that report, and for the shapes measured here it
   * applies NOTHING to AWS — which is a property of three separate skips, not
   * "by construction", and the distinction is load-bearing because this PR
   * briefly broke it. The index names match, so no Create / Delete is derived;
   * the stale blob's `{0, 0}` capacity is refused by
   * {@link skipZeroCapacityIndexUpdate}; and its per-index `WarmThroughput` —
   * which the same PR taught `applyGsiUpdates` to SEND (issue #1768), turning
   * an earlier "by construction" wording false the moment it landed — is
   * refused by {@link warmThroughputAlreadyMatches}, since a stale blob carries
   * exactly what AWS holds. Remove any of the three and the residual stops
   * being harmless: the revert starts issuing one redundant `UpdateTable` plus
   * a full index-ACTIVE wait per GSI, or a doomed one.
   *
   * "Applies nothing" is NOT the same as "reaches those skips" (PR review round
   * 5). `applyGsiUpdates` compares `KeySchema` / `Projection` between the
   * recorded previous and the desired entry BEFORE any of them and THROWS on a
   * difference, because DynamoDB cannot modify either in place. On this path
   * that compare is a trimmed readback against a stale full description, and
   * both members survive the #1767 reverse-map unchanged — `KeySchema`
   * verbatim, `Projection` rebuilt member-for-member — so for every shape
   * exercised here it matches and the throw does not fire. It is named because
   * it is the outcome an enumeration of skips would otherwise hide: a stale
   * blob whose `Projection` AWS has since re-normalized would fail the revert
   * loudly rather than no-op it. Suppressing the residual instead would mean ignoring the
   * whole array for the population that HAS indexes — i.e. never detecting an
   * out-of-band index add / remove / capacity change again, permanently, to
   * remove a one-time report. No PATH can express the middle ground:
   * `isIgnoredPath` is never asked about a path that crosses an array
   * (`diffAt` compares arrays wholesale via `deepEqual`), so a per-MEMBER
   * ignore path does not exist — the same wall issue #1742 records for the
   * `AWS::DynamoDB::GlobalTable` twin. **A non-path seam now EXISTS**:
   * `ResourceProvider.canonicalizeDriftProperties`, applied to BOTH comparison
   * sides, landed in [#1799](https://github.com/go-to-k/cdkd/pull/1799) (which
   * closed issue [#1784](https://github.com/go-to-k/cdkd/issues/1784)) and can
   * strip the AWS-managed member from each bag — converging an already-written
   * record with a post-fix readback, with no ignore-path and no lost
   * detection. It is deliberately NOT adopted here yet: doing so is its own
   * change with its own real-AWS verification, tracked as issue
   * [#1812](https://github.com/go-to-k/cdkd/issues/1812).
   */
  getDriftUnknownPaths(resourceType: string, properties?: Record<string, unknown>): string[] {
    if (resourceType !== 'AWS::DynamoDB::Table') return [];
    const paths: string[] = [];
    if (!declaresWarmThroughput(properties)) paths.push('WarmThroughput');
    // The SAME predicate the readback's matcher uses (see
    // {@link declaresIndexList}), so a bag whose list the mapper treats as
    // declaring nothing is never left in the comparison.
    if (desiredBagIsInformative(properties)) {
      for (const key of ['GlobalSecondaryIndexes', 'LocalSecondaryIndexes']) {
        // Same reason as `declaresWarmThroughput` above: the `!` spelling is
        // invisible to the handled-property-wiring critic.
        if (properties !== undefined && !declaresIndexList(properties[key])) paths.push(key);
      }
    }
    return paths;
  }

  /**
   * Read the AWS-current DynamoDB table configuration in CFn-property shape.
   *
   * `DescribeTable` returns every field cdkd manages in one call. AWS uses
   * the same property names CFn does (KeySchema, AttributeDefinitions,
   * BillingModeSummary.BillingMode, ProvisionedThroughput, etc.) — the only
   * shape differences are wrapping:
   *  - BillingMode lives under `BillingModeSummary.BillingMode` in the API
   *    response, but the CFn property is a flat `BillingMode` string.
   *  - StreamSpecification's CFn shape includes only `StreamViewType`; the
   *    API response carries `StreamEnabled` too. We surface both since the
   *    drift comparator only descends into keys present in state.
   *  - GSI / LSI in the API response include `IndexStatus`, `Backfilling`,
   *    `ItemCount`, `IndexArn` and sizing fields cdkd never sets. They used to
   *    be forwarded VERBATIM under a comment claiming "the comparator filters
   *    them" — it does NOT, and issue #1767 quotes that sentence as the bug:
   *    the filter is `calculateResourceDrift`'s state-keys-only walk, which
   *    only reaches an absent TOP-LEVEL key. These are members of an array
   *    under a key the baseline DOES carry, and arrays compare positionally,
   *    so every AWS-managed member participated — and `ItemCount` MOVES as
   *    data lands, so an in-use table with any index drifted against its own
   *    `observedProperties` on the ORDINARY path, on a schedule set by its own
   *    write traffic. Each entry is now reverse-mapped to its CFn shape by
   *    {@link reverseMapSecondaryIndex}.
   *
   * Returns `undefined` when the table is gone (`ResourceNotFoundException`).
   *
   * Tags are surfaced via a follow-up `ListTagsOfResource` call (DynamoDB
   * doesn't include tags in `DescribeTable`). CDK's `aws:*` auto-tags are
   * filtered out by `normalizeAwsTagsToCfn` so they don't fire false-positive
   * drift, and the result key is omitted entirely when AWS reports no user
   * tags (matches `create()`'s behavior of only sending Tags when the
   * template carries them).
   *
   * `properties` is the DESIRED bag (the state-recorded template intent every
   * caller passes). It is consulted for the table-level `WarmThroughput` — see
   * {@link getDriftUnknownPaths} for the measurement and the reasoning — and,
   * since issue #1767, for the per-index throughput blocks of each secondary
   * index, matched by `IndexName`.
   */
  async readCurrentState(
    physicalId: string,
    _logicalId: string,
    _resourceType: string,
    properties?: Record<string, unknown>
  ): Promise<Record<string, unknown> | undefined> {
    try {
      const resp = await this.dynamoDBClient.send(
        new DescribeTableCommand({ TableName: physicalId })
      );
      const table = resp.Table;
      if (!table) return undefined;

      const result: Record<string, unknown> = {};

      if (table.TableName !== undefined) result['TableName'] = table.TableName;
      if (table.KeySchema) result['KeySchema'] = table.KeySchema;
      if (table.AttributeDefinitions) {
        result['AttributeDefinitions'] = table.AttributeDefinitions;
      }
      if (table.BillingModeSummary?.BillingMode) {
        result['BillingMode'] = table.BillingModeSummary.BillingMode;
      }
      if (table.ProvisionedThroughput) {
        // AWS returns extra read-only fields (LastIncrease/DecreaseDateTime,
        // NumberOfDecreasesToday) — drop them to keep the snapshot tight.
        result['ProvisionedThroughput'] = {
          ReadCapacityUnits: table.ProvisionedThroughput.ReadCapacityUnits,
          WriteCapacityUnits: table.ProvisionedThroughput.WriteCapacityUnits,
        };
      }
      // OnDemandThroughput — DescribeTable returns it only on PAY_PER_REQUEST
      // tables that set capacity caps. Emit-when-present (no default when
      // absent) so a table that never configured caps doesn't grow a
      // placeholder that would round-trip through update() as a spurious
      // UpdateTable.
      if (table.OnDemandThroughput) {
        const odt: Record<string, unknown> = {};
        if (table.OnDemandThroughput.MaxReadRequestUnits !== undefined) {
          odt['MaxReadRequestUnits'] = table.OnDemandThroughput.MaxReadRequestUnits;
        }
        if (table.OnDemandThroughput.MaxWriteRequestUnits !== undefined) {
          odt['MaxWriteRequestUnits'] = table.OnDemandThroughput.MaxWriteRequestUnits;
        }
        if (Object.keys(odt).length > 0) {
          result['OnDemandThroughput'] = odt;
        }
      }
      // WarmThroughput — DescribeTable returns it (as a
      // TableWarmThroughputDescription carrying ReadUnitsPerSecond /
      // WriteUnitsPerSecond / Status) for EVERY table, not only for one that
      // set warm throughput: measured us-east-1 2026-08-13, a CreateTable
      // declaring none read back {ReadUnitsPerSecond: 12000,
      // WriteUnitsPerSecond: 4000, Status: 'ACTIVE'} (issue #1760). So the
      // emit is gated on the DESIRED bag declaring the property — a blanket
      // drop would hide a real change for a template that sets one, and an
      // ungated emit freezes an AWS-computed, AWS-owned value into the
      // observedProperties baseline, which `drift --revert` then re-sends
      // through update() as a spurious (and, once AWS has grown the value,
      // rejected) UpdateTable. An absent / empty bag keeps the pre-#1760
      // behavior, since the caller supplied nothing to decide with.
      // Surface ONLY the user-settable sub-fields — Status is AWS-managed.
      if (table.WarmThroughput && declaresWarmThroughput(properties)) {
        const wt: Record<string, unknown> = {};
        if (table.WarmThroughput.ReadUnitsPerSecond !== undefined) {
          wt['ReadUnitsPerSecond'] = table.WarmThroughput.ReadUnitsPerSecond;
        }
        if (table.WarmThroughput.WriteUnitsPerSecond !== undefined) {
          wt['WriteUnitsPerSecond'] = table.WarmThroughput.WriteUnitsPerSecond;
        }
        if (Object.keys(wt).length > 0) {
          result['WarmThroughput'] = wt;
        }
      }
      // Class 1 guard: StreamSpecification.StreamViewType is only valid when
      // a stream is enabled. AWS returns the StreamSpecification block on
      // tables that USED TO have a stream (StreamEnabled: false, no
      // StreamViewType) — emitting that placeholder back through a
      // round-trip drift --revert would push a CFn-invalid shape (a
      // StreamSpecification without StreamViewType is rejected). Only
      // surface the block when the stream is actually enabled.
      if (table.StreamSpecification?.StreamEnabled && table.StreamSpecification.StreamViewType) {
        result['StreamSpecification'] = {
          StreamEnabled: true,
          StreamViewType: table.StreamSpecification.StreamViewType,
        };
      }
      // Class 2 guard: GSI / LSI placeholders. AWS omits these blocks when
      // none exist; the previous `?? []` always-emitted an empty array
      // which round-trips through `update()` as an instruction to "remove
      // all GSIs", and on the LSI side LSIs are immutable post-create so
      // the empty-array placeholder is a guaranteed AWS rejection on any
      // future provider.update() that learns to handle the field. Only
      // surface when AWS reports indexes.
      //
      // Each entry is REVERSE-MAPPED to its CFn shape rather than forwarded
      // verbatim (issue #1767) — see {@link reverseMapSecondaryIndex} for the
      // measured description and the per-block gates.
      const bagInformative = desiredBagIsInformative(properties);
      if (table.GlobalSecondaryIndexes && table.GlobalSecondaryIndexes.length > 0) {
        const desiredByName = desiredIndexEntriesByName(properties?.['GlobalSecondaryIndexes']);
        result['GlobalSecondaryIndexes'] = table.GlobalSecondaryIndexes.map((live) =>
          reverseMapSecondaryIndex(
            live,
            live.IndexName === undefined ? undefined : desiredByName.get(live.IndexName),
            bagInformative
          )
        );
      }
      if (table.LocalSecondaryIndexes && table.LocalSecondaryIndexes.length > 0) {
        const desiredByName = desiredIndexEntriesByName(properties?.['LocalSecondaryIndexes']);
        result['LocalSecondaryIndexes'] = table.LocalSecondaryIndexes.map((live) =>
          reverseMapSecondaryIndex(
            live,
            live.IndexName === undefined ? undefined : desiredByName.get(live.IndexName),
            bagInformative
          )
        );
      }
      // Class 1 guard: CFn's SSESpecification.KMSMasterKeyId / SSEType are
      // only valid when SSEEnabled=true. AWS reports SSEDescription.Status
      // = 'DISABLED' (or omits SSEDescription entirely) on tables without
      // SSE; the previous always-emit `{ SSEEnabled: false }` placeholder
      // round-trips fine when state matches but breaks the moment a
      // future SSE-aware update() learns to read `SSESpecification` —
      // `{ SSEEnabled: false, KMSMasterKeyId: '...' }` is rejected by
      // AWS. Only surface the block when SSE is actually enabled.
      if (table.SSEDescription?.Status === 'ENABLED') {
        const sse: Record<string, unknown> = { SSEEnabled: true };
        if (table.SSEDescription.KMSMasterKeyArn !== undefined) {
          sse['KMSMasterKeyId'] = table.SSEDescription.KMSMasterKeyArn;
        }
        if (table.SSEDescription.SSEType !== undefined) {
          sse['SSEType'] = table.SSEDescription.SSEType;
        }
        result['SSESpecification'] = sse;
      }
      if (table.DeletionProtectionEnabled !== undefined) {
        result['DeletionProtectionEnabled'] = table.DeletionProtectionEnabled;
      }
      if (table.TableClassSummary?.TableClass) {
        result['TableClass'] = table.TableClassSummary.TableClass;
      }

      // Tags via ListTagsOfResource — needs the table ARN we just got back.
      if (table.TableArn) {
        try {
          const tagsResp = await this.dynamoDBClient.send(
            new ListTagsOfResourceCommand({ ResourceArn: table.TableArn })
          );
          const tags = normalizeAwsTagsToCfn(tagsResp.Tags);
          result['Tags'] = tags;
        } catch (err) {
          // Tag fetch failures shouldn't tank the whole drift read; rethrow
          // only on hard "table gone" semantics.
          if (err instanceof ResourceNotFoundException) return undefined;
          throw err;
        }
      }

      // PointInTimeRecoverySpecification — separate DescribeContinuousBackups
      // call (not part of DescribeTable). Emit-when-present: only surface the
      // key when AWS reports a PITR status so a table that never configured
      // PITR doesn't grow a placeholder (keeps the comparator's state-keys-only
      // top-level walk + the "AWS minimum response" key-set test green).
      // Best-effort: a failed read omits the key rather than failing the
      // whole drift read.
      try {
        const pitrResp = await this.dynamoDBClient.send(
          new DescribeContinuousBackupsCommand({ TableName: physicalId })
        );
        const pitrDesc = pitrResp.ContinuousBackupsDescription?.PointInTimeRecoveryDescription;
        const pitrStatus = pitrDesc?.PointInTimeRecoveryStatus;
        if (pitrStatus) {
          const pitr: Record<string, unknown> = {
            PointInTimeRecoveryEnabled: pitrStatus === 'ENABLED',
          };
          // RecoveryPeriodInDays is only meaningful while enabled; surface it
          // emit-when-present so a templated value is drift-comparable.
          if (pitrStatus === 'ENABLED' && pitrDesc?.RecoveryPeriodInDays !== undefined) {
            pitr['RecoveryPeriodInDays'] = pitrDesc.RecoveryPeriodInDays;
          }
          result['PointInTimeRecoverySpecification'] = pitr;
        }
      } catch (err) {
        this.logger.debug(
          `Could not read PointInTimeRecovery for ${physicalId}: ${err instanceof Error ? err.message : String(err)}`
        );
      }

      // TimeToLiveSpecification — separate DescribeTimeToLive call.
      // Race-tolerant: only surface when AWS reports `ENABLED` with an
      // AttributeName. `DISABLED` carries no AttributeName and CFn rejects a
      // TimeToLiveSpecification without one, so we omit it; ENABLING /
      // DISABLING are transient and also omitted so drift doesn't fire on a
      // momentary state.
      try {
        const ttlResp = await this.dynamoDBClient.send(
          new DescribeTimeToLiveCommand({ TableName: physicalId })
        );
        const ttlDesc = ttlResp.TimeToLiveDescription;
        if (ttlDesc?.TimeToLiveStatus === 'ENABLED' && ttlDesc.AttributeName) {
          result['TimeToLiveSpecification'] = {
            AttributeName: ttlDesc.AttributeName,
            Enabled: true,
          };
        }
      } catch (err) {
        this.logger.debug(
          `Could not read TimeToLive for ${physicalId}: ${err instanceof Error ? err.message : String(err)}`
        );
      }

      // ResourcePolicy — separate GetResourcePolicy call. Emit-when-present:
      // only surface the key when AWS reports an attached policy, and re-shape
      // the returned JSON string back into CFn's `{ PolicyDocument: <object> }`
      // form so it is drift-comparable against the templated value. A table
      // with no policy returns ResourceNotFoundException / PolicyNotFound —
      // omit the key rather than fail the whole drift read.
      if (table.TableArn) {
        try {
          const rpResp = await this.dynamoDBClient.send(
            new GetResourcePolicyCommand({ ResourceArn: table.TableArn })
          );
          if (rpResp.Policy) {
            let doc: unknown = rpResp.Policy;
            try {
              doc = JSON.parse(rpResp.Policy);
            } catch {
              // Leave as the raw string if AWS returned a non-JSON body.
            }
            result['ResourcePolicy'] = { PolicyDocument: doc };
          }
        } catch (err) {
          if (!(err instanceof ResourceNotFoundException)) {
            this.logger.debug(
              `Could not read ResourcePolicy for ${physicalId}: ${err instanceof Error ? err.message : String(err)}`
            );
          }
        }
      }

      // KinesisStreamSpecification — separate DescribeKinesisStreamingDestination
      // call. Emit-when-present: only surface the key when AWS reports an ACTIVE
      // or ENABLING destination (DISABLED entries linger in the list, so a
      // status filter avoids a stale placeholder). Surface only the user-set
      // fields (StreamArn + precision) so the drift comparator can match the
      // templated value.
      try {
        const kResp = await this.dynamoDBClient.send(
          new DescribeKinesisStreamingDestinationCommand({ TableName: physicalId })
        );
        const active = (kResp.KinesisDataStreamDestinations ?? []).find(
          (d) => d.DestinationStatus === 'ACTIVE' || d.DestinationStatus === 'ENABLING'
        );
        if (active?.StreamArn) {
          const kspec: Record<string, unknown> = { StreamArn: active.StreamArn };
          if (active.ApproximateCreationDateTimePrecision !== undefined) {
            kspec['ApproximateCreationDateTimePrecision'] =
              active.ApproximateCreationDateTimePrecision;
          }
          result['KinesisStreamSpecification'] = kspec;
        }
      } catch (err) {
        this.logger.debug(
          `Could not read KinesisStreamingDestination for ${physicalId}: ${err instanceof Error ? err.message : String(err)}`
        );
      }

      // ContributorInsightsSpecification — separate DescribeContributorInsights
      // call. Emit-when-present: only surface the key when AWS reports a
      // terminal ENABLED / DISABLED status (ENABLING / DISABLING are transient
      // and omitted so drift doesn't fire on a momentary state). Surface
      // `Mode` only while ENABLED so a disabled table doesn't grow a CFn-invalid
      // placeholder.
      try {
        const ciResp = await this.dynamoDBClient.send(
          new DescribeContributorInsightsCommand({ TableName: physicalId })
        );
        const status = ciResp.ContributorInsightsStatus;
        if (status === 'ENABLED' || status === 'DISABLED') {
          const cspec: Record<string, unknown> = { Enabled: status === 'ENABLED' };
          if (status === 'ENABLED' && ciResp.ContributorInsightsMode !== undefined) {
            cspec['Mode'] = ciResp.ContributorInsightsMode;
          }
          result['ContributorInsightsSpecification'] = cspec;
        }
      } catch (err) {
        this.logger.debug(
          `Could not read ContributorInsights for ${physicalId}: ${err instanceof Error ? err.message : String(err)}`
        );
      }

      return result;
    } catch (err) {
      if (err instanceof ResourceNotFoundException) return undefined;
      throw err;
    }
  }

  /**
   * Adopt an existing DynamoDB table into cdkd state.
   *
   * Lookup order:
   *  1. `--resource` override or `Properties.TableName` → verify via `DescribeTable`.
   */
  async import(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    const explicit = resolveExplicitPhysicalId(input, 'TableName');
    if (explicit) {
      try {
        await this.dynamoDBClient.send(new DescribeTableCommand({ TableName: explicit }));
        return { physicalId: explicit, attributes: {} };
      } catch (err) {
        if (err instanceof ResourceNotFoundException) return null;
        throw err;
      }
    }

    // No `aws:cdk:path` tag walk: AWS rejects `aws:`-prefixed tag writes, so
    // that tag never exists on a real resource and the walk could not match
    // (issue #1134). Auto-mode import resolves ids from CloudFormation's
    // DescribeStackResources or the template's physical-name property; a table
    // reaching here needs an explicit `--resource` override.
    return null;
  }
}
