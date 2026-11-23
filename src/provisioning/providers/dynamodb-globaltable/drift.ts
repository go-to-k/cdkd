import { coerceCfnBoolean } from '../../config-shape.js';
import { coerceWarmThroughput } from '../../dynamodb-warm-throughput.js';
import { canonicalizePre5381ReplicaBaseline } from '../../dynamodb-replica-settings.js';
import { DRIFT_STRIPPED_INDEX_MEMBERS } from './projection.js';
import { desiredIndexEntriesByName } from '../dynamodb-table/indexes.js';
import { isPlainCapacityBlock } from '../dynamodb-table/table-helpers.js';
import { sentWarmThroughputMembers } from '../dynamodb-table/warm-throughput.js';
import {
  completeReplicaDefaults,
  completeAwsManagedReplicaKeys,
  completeLegacyLocalReplica,
  TABLE_READ_PROVISIONED_KEY,
} from './replica-shape.js';
import {
  STREAM_SPECIFICATION_KEY,
  replicationImpliedStreamSpecification,
  asRecord,
} from './capacity.js';
import type { DynamoDBGlobalTableProvider } from '../dynamodb-globaltable-provider.js';

/**
 * State property paths cdkd's GlobalTable readCurrentState cannot (yet)
 * reverse-map. The drift comparator skips these so a templated value
 * doesn't fire guaranteed false drift on every clean run.
 *
 * Issue #389 + #395 emptied this list:
 *  - `WriteProvisionedThroughputSettings` reverse-maps both the flat
 *    `{WriteCapacityUnits}` shape (no autoscaling) AND the full
 *    `{WriteCapacityAutoScalingSettings}` shape (autoscaling-managed;
 *    recovered from `DescribeScalableTargets` +
 *    `DescribeScalingPolicies`). PAY_PER_REQUEST tables emit `{}`.
 *  - Per-replica `ReadProvisionedThroughputSettings.ReadCapacityAutoScalingSettings`
 *    reverse-maps from a region-scoped application-autoscaling client
 *    for the `dynamodb:table:ReadCapacityUnits` dimension. Non-
 *    autoscaled replicas omit the key (no per-replica flat read
 *    capacity available in `DescribeTable`).
 *  - `WriteOnDemandThroughputSettings` is reverse-mapped from
 *    `Table.OnDemandThroughput.MaxWriteRequestUnits`. Always-emit
 *    `{}` placeholder when AWS reports no override.
 *  - `TimeToLiveSpecification` is reverse-mapped via
 *    `DescribeTimeToLive` in `readCurrentState`.
 *
 * Issue #1420 + #1436 kept it empty rather than growing it:
 *  - `GlobalSecondaryIndexes` is a real CFn-shaped reverse map (SDK-only
 *    members stripped, write throughput at the top level, read throughput
 *    on the local replica's index entry, auto-scaling recovered per index
 *    via `dynamodb:index:*`). The alternative #1420 offered — declaring the
 *    subtree here — would have turned drift OFF for every GSI, which is a
 *    strictly worse trade than the phantom drift it removes.
 *  - The table-level on-demand READ ceiling is reverse-mapped onto
 *    `Replicas[local].ReadOnDemandThroughputSettings`, the CFn location it
 *    is authored at, and onto the top-level block when the record keeps it
 *    there (go-to-k/cdkd#2762).
 *
 * go-to-k/cdkd#2762 added the members no AWS read answers:
 *  - `TableType` is no API member. CloudFormation validates it and sends
 *    nothing (`GlobalTableReplica` on a one-replica table reads back
 *    `Regional`, measured us-east-1, 2026-11-01).
 *  - `ReadProvisionedThroughputSettings` on an on-demand table, which
 *    CloudFormation accepts and ignores (measured, same day).
 *  - A `WarmThroughput` that was not sent: AWS's value is its own, and only a
 *    usable declaration is read back.
 */
export function getDriftUnknownPaths(
  this: DynamoDBGlobalTableProvider,
  _resourceType: string,
  properties?: Record<string, unknown>
): string[] {
  const paths = ['TableType'];
  // An absent or empty bag says nothing recorded, not that a key is absent
  // (the `getDriftUnknownPaths` contract): compare by default.
  if (properties === undefined || Object.keys(properties).length === 0) return paths;
  if (properties['BillingMode'] !== 'PROVISIONED') paths.push(TABLE_READ_PROVISIONED_KEY);
  if (!coerceWarmThroughput(properties['WarmThroughput']).spec) paths.push('WarmThroughput');
  return paths;
}

/**
 * `AttributeDefinitions` is an unordered SET, and the comparator compares
 * arrays positionally (issue #1742).
 *
 * `DescribeTable` returns the definitions in an order matching neither the
 * request nor alphabetical — measured us-east-1 2026-08-13 on the
 * `rollback-replay-effective-props` fixture, where a table declaring
 * `[pk, gsipk]` read back as `[gsipk, pk]` — so an UNTOUCHED table drifted
 * forever. Sorting cannot hide a real change here because the list is a
 * genuine set: members are keyed by `AttributeName`, so adding, removing or
 * retyping one still changes the canonicalized form.
 *
 * Reachable whenever the drift baseline is `properties` rather than
 * `observedProperties` — i.e. after any reverse-replacement rollback, which
 * `rollback-executor.ts` strips `observedProperties` on. That is also why it
 * went unseen: on the ordinary path both sides come from the same readback.
 *
 * `KeySchema` is deliberately NOT declared, at the table level or per index:
 * it is order-SIGNIFICANT (HASH before RANGE), so sorting it would silently
 * hide a real key change — the failure direction this file's sibling rules
 * call the worse one.
 *
 * `Replicas` is a set too (issue #3573): the registry schema declares it
 * `insertionOrder: false` (measured via `DescribeType`, us-east-1,
 * 2026-09-25), and each entry is keyed by `Region`. Templates disagree on
 * where the deploy region goes -- CDK's `TableV2` renders it LAST, a
 * hand-written `CfnGlobalTable` often FIRST -- while the readback appends it
 * after the replicas `DescribeTable` lists, so one of the two always
 * compared positionally unequal on a `properties` baseline. Declared
 * LEAF-ONLY (`[]`) so the arrays inside each entry keep their own rules.
 *
 * `VectorIndexes` (go-to-k/cdkd#2762) is a SUBTREE entry: keyed by
 * `IndexName`, with no order-significant list inside an element, as on
 * `AWS::DynamoDB::Table`.
 */
export function getDriftUnorderedPaths(
  this: DynamoDBGlobalTableProvider,
  _resourceType: string
): string[] {
  return ['AttributeDefinitions', 'Replicas[]', 'VectorIndexes'];
}

/**
 * The per-index `WarmThroughput` of one drift comparison bag, read the way the
 * template declares it (issue #1742 defect 2, declaration gate #6854).
 *
 * `DescribeTable` reports a `WarmThroughput` for EVERY index whether or not
 * the template asked for one -- a default `{ReadUnitsPerSecond: 12000,
 * WriteUnitsPerSecond: 4000, Status: 'ACTIVE'}`, measured us-east-1
 * 2026-08-13 -- so an index that declares none would drift forever on a
 * `properties` baseline, which never carried the member. For such an index
 * the member is stripped. An index whose template entry DECLARES it keeps
 * the members cdkd sent ({@link sentWarmThroughputMembers}, the same rule as
 * `AWS::DynamoDB::Table`), so a declared value that differs from the live
 * one is reported, as CloudFormation drift reports it. That includes a value
 * AWS grew with traffic; `drift --revert` then skips the decrease AWS would
 * refuse (`isWarmThroughputDecrease`, issue #1857) and says so.
 *
 * `properties` is the recorded template intent. Absent (no record to decide
 * with), every index's member is stripped, as before #6854.
 *
 * Applied by {@link canonicalizeDriftPair} to both bags, and by
 * `drift --revert` to its desired bag: a member missing there is no removal,
 * since `update()` sends `WarmThroughput` only when the desired entry has it
 * and AWS cannot unset it.
 *
 * Scope is a CLOSED table (`DRIFT_STRIPPED_INDEX_MEMBERS`):
 * `Replicas[].GlobalSecondaryIndexes[]` carry only the read-half throughput
 * blocks. A non-object entry, or one without a string `IndexName` when a
 * declaration is present, is handled as declaring nothing. Pure and
 * identity-returning when nothing changes.
 */
export function canonicalizeIndexWarmThroughput(
  bag: Record<string, unknown>,
  properties?: Record<string, unknown>
): Record<string, unknown> {
  let result = bag;
  for (const { listKey, member } of DRIFT_STRIPPED_INDEX_MEMBERS) {
    const list = result[listKey];
    if (!Array.isArray(list)) continue;
    const declared =
      properties === undefined ? undefined : desiredIndexEntriesByName(properties[listKey]);
    let changed = false;
    const canonical = list.map((element) => {
      const entry = asRecord(element);
      // A non-object entry (an unresolved intrinsic, a malformed record) is
      // passed through untouched -- the comparator can still report it.
      if (!entry || !(member in entry)) return element;
      const name = entry['IndexName'];
      const sent =
        declared !== undefined && typeof name === 'string'
          ? sentWarmThroughputMembers(declared.get(name)?.[member])
          : new Set<string>();
      const block = entry[member];
      if (sent.size > 0 && isPlainCapacityBlock(block)) {
        const kept: Record<string, unknown> = {};
        for (const key of Object.keys(block)) if (sent.has(key)) kept[key] = block[key];
        if (Object.keys(kept).length === Object.keys(block).length) return element;
        changed = true;
        const copy = { ...entry };
        if (Object.keys(kept).length > 0) copy[member] = kept;
        else delete copy[member];
        return copy;
      }
      changed = true;
      const copy = { ...entry };
      delete copy[member];
      return copy;
    });
    if (changed) result = { ...result, [listKey]: canonical };
  }
  return result;
}

/**
 * Diff-side twin of the `needsStream` record (issue #1723): a multi-replica
 * template declaring no `StreamSpecification` compares as declaring the
 * stream `create()` enables for it. Applied to BOTH sides, so a record
 * written before #1723 (no stream key) and one written after (stream key)
 * both diff NO_CHANGE against the unchanged template — and against a
 * template that later declares that same stream.
 *
 * Shares {@link replicationImpliedStreamSpecification} with `create()` and
 * `update()`. It only ADDS a key, so `DiffCalculator`'s "declared properties
 * are ignored" warning (which fires on a DROPPED key) stays silent.
 *
 * Bound: `DiffCalculator` folds the CURRENT side only for an SDK-routed
 * record, so on a Cloud Control record this fold would be one-sided.
 * Cloud Control never CREATES that population (CloudFormation refuses a
 * multi-replica table with no `StreamSpecification`, and a declared
 * `MultiRegionConsistency` stops the helper), but an SDK-created record can
 * MOVE there: a later template adding a property this provider does not
 * handle re-routes the update to Cloud Control with this record as the
 * previous side, and its patch then asks to remove the recorded stream.
 * With the replicas unchanged AWS refuses that on a multi-replica table and
 * the deploy fails; if the same template also drops to ONE replica, the
 * removal is allowed and the patch may disable the stream. Accepted: the
 * template that created the record (multi-replica, no `StreamSpecification`)
 * is one CloudFormation rejects, so the AWS CDK CLI never reaches this state.
 */
export function canonicalizeDesiredProperties(
  this: DynamoDBGlobalTableProvider,
  resourceType: string,
  properties: Record<string, unknown>
): Record<string, unknown> {
  if (resourceType !== 'AWS::DynamoDB::GlobalTable') return properties;
  const impliedStream = replicationImpliedStreamSpecification(properties);
  if (!impliedStream) return properties;
  return { ...properties, [STREAM_SPECIFICATION_KEY]: impliedStream };
}

/**
 * Complete a LEGACY drift baseline's missing local replica (issue #3573),
 * then bring a baseline the pre-#5381 read-back wrote to the current replica
 * shape ({@link canonicalizePre5381ReplicaBaseline}; go-to-k/cdkd#5381).
 * The rest of this comment is the #3573 half.
 *
 * Before #3573, `readCurrentState` left the deploy-region entry out of
 * `Replicas` on a multi-region table, so every `observedProperties` record a
 * deploy captured then lacks it, while the readback now carries it. Compared
 * as is, the first `cdkd drift` after upgrading would report `Replicas` on
 * every untouched multi-region GlobalTable.
 *
 * The rule (maintainer decision on the issue: absorb at comparison time):
 * when the BASELINE's `Replicas` has no entry for the local region, copy the
 * READBACK's local entry into the baseline. The AWS side is untouched. State
 * is not rewritten; the next deploy captures the new shape.
 *
 * Completing the baseline, rather than dropping the entry from the AWS side,
 * is what keeps the two write paths that consume these bags safe:
 * - `drift --revert` runs this on its DESIRED bag too (the legacy record),
 *   so the local entry it sends equals the live one. Sent without it,
 *   `update()` would read the local replica's tags as removed and untag
 *   the table.
 * - `--accept` persists the reported `awsValue`, which comes from the
 *   untouched AWS side, so an accepted `Replicas` change heals the record to
 *   the current shape instead of freezing the legacy one.
 *
 * Why it hides nothing that was visible: a current-shape baseline always
 * has the local entry, so it is compared in full; and the local replica is
 * the table itself, so its ABSENCE from a legacy baseline cannot be a real
 * removal -- the one thing this suppresses is the local entry's own members,
 * which that baseline never recorded. A replica added out of band in ANOTHER
 * region still differs. It is per-side-inexpressible, hence the pair hook:
 * a per-side hook sees one bag and cannot tell a legacy
 * baseline from a current one.
 *
 * "Local" is the region this provider's own client resolves -- the same
 * expression `readCurrentState` keys its local entry on -- so the two cannot
 * disagree about which entry is local. A baseline or AWS side whose
 * `Replicas` is not an array, or an unresolved region, is left untouched.
 */
export async function canonicalizeDriftPair(
  this: DynamoDBGlobalTableProvider,
  resourceType: string,
  rawBaseline: Record<string, unknown>,
  rawAws: Record<string, unknown>,
  properties?: Record<string, unknown>
): Promise<{ baseline: Record<string, unknown>; aws: Record<string, unknown> }> {
  if (resourceType !== 'AWS::DynamoDB::GlobalTable') return { baseline: rawBaseline, aws: rawAws };
  // go-to-k/cdkd#6854: the per-index WarmThroughput, read against the
  // declaration (see the helper), on both bags.
  const baseline = canonicalizeIndexWarmThroughput(rawBaseline, properties);
  const aws = canonicalizeIndexWarmThroughput(rawAws, properties);
  const localRegion = (await this.dynamoDBClient.config.region()) ?? '';
  const completed = completeLegacyLocalReplica(baseline, aws, localRegion);
  // go-to-k/cdkd#5381: a baseline the pre-#5381 read-back wrote (top-level
  // class / protection, a flat replica key, none of the members #5381 reads)
  // is brought to the current shape — see the helper. Identity otherwise.
  const converted = canonicalizePre5381ReplicaBaseline(
    completed,
    aws,
    localRegion,
    completed !== baseline
  );
  // go-to-k/cdkd#5789: the read-back puts each replica's class and deletion
  // protection on its entry (#5397); a baseline that never declared them
  // (a template bag, when the record has no `observedProperties`) takes
  // them at their AWS default only.
  const defaulted = completeReplicaDefaults(converted, aws);
  // go-to-k/cdkd#5790: a template on the AWS managed key declares no replica
  // key, but the read-back names the key's ARN on each replica.
  const keyed = await completeAwsManagedReplicaKeys(defaulted, aws, (arn) =>
    this.kmsKeyManager(arn)
  );
  return keyed === baseline ? { baseline, aws } : { baseline: keyed, aws };
}

/**
 * `SSESpecification`, while the template leaves the table on the AWS owned
 * key: no block (CDK's default) or `SSEEnabled: false` (CDK's
 * `dynamoOwnedKey()`). `readCurrentState` omits the block unless encryption
 * is ENABLED, so a baseline captured on the AWS owned key has none, and a
 * later move to a KMS key was compared nowhere at the top level and kept by
 * `drift --revert` (go-to-k/cdkd#5399). Sent absent, `update()` takes its
 * removal path: `SSESpecification: { Enabled: false }`, which returns every
 * region to the AWS owned key, as CloudFormation does (go-to-k/cdkd#5355).
 *
 * A template declaring encryption ON gets nothing: a baseline without the
 * block disagrees with that template, and it must not turn the declared
 * encryption off. A missing block is not proof of the AWS owned key on its
 * own (the read-back omits it for every status but ENABLED, e.g.
 * ENABLING, UPDATING, DISABLING or INACCESSIBLE_ENCRYPTION_CREDENTIALS), so the template's answer is what bounds the reset.
 */
export function getDriftAbsentMeansDefaultKeys(
  this: DynamoDBGlobalTableProvider,
  resourceType: string,
  properties: Record<string, unknown>
): readonly string[] {
  if (resourceType !== 'AWS::DynamoDB::GlobalTable') return [];
  const declared = properties['SSESpecification'];
  if (declared === undefined) return ['SSESpecification'];
  return coerceCfnBoolean(asRecord(declared)?.['SSEEnabled']) === false ? ['SSESpecification'] : [];
}
