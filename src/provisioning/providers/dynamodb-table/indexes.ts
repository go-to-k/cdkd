import { isUsableAttemptedName } from '../../../state/unsettled-properties.js';
import { isDeepStrictEqual } from 'node:util';
import type {
  GlobalSecondaryIndexDescription,
  LocalSecondaryIndexDescription,
} from '@aws-sdk/client-dynamodb';
import { configBooleanRefusal } from '../../config-shape.js';
import { isPlainCapacityBlock } from './table-helpers.js';
import {
  readbackWarmThroughput,
  sentWarmThroughputMembers,
  wasSentWarmThroughput,
} from './warm-throughput.js';

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
 * CFn's per-index `ContributorInsightsSpecification` is NOT mapped here: it
 * has no `DescribeTable` counterpart, so `readCurrentState` adds it afterwards
 * from a gated per-index `DescribeContributorInsights` (issue
 * [#1782](https://github.com/go-to-k/cdkd/issues/1782)).
 */
export function reverseMapSecondaryIndex(
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
  // `Projection` is rebuilt member by member so no AWS-added member can join
  // it. Its key order differs from a template's (`aws-cdk-lib` renders
  // `{NonKeyAttributes, ProjectionType}`), which is why `applyGsiUpdates`
  // compares it with {@link sameJsonValue} rather than `JSON.stringify`.
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
    // Per member, as at the table level (issue #3777).
    const wt = readbackWarmThroughput(
      live.WarmThroughput,
      bagInformative ? sentWarmThroughputMembers(desired?.['WarmThroughput']) : undefined,
      bagInformative ? desired?.['WarmThroughput'] : undefined
    );
    if (wt !== undefined) out['WarmThroughput'] = wt;
  }
  return out;
}

export const SDK_ONLY_INDEX_MEMBERS = [
  'IndexStatus',
  'Backfilling',
  'IndexSizeBytes',
  'ItemCount',
  'IndexArn',
] as const;

export const SDK_ONLY_THROUGHPUT_MEMBERS = [
  'NumberOfDecreasesToday',
  'LastIncreaseDateTime',
  'LastDecreaseDateTime',
] as const;

/**
 * One index entry of {@link DynamoDBTableProvider.canonicalizeDriftProperties}:
 * the input by identity unless it carries an SDK-only member.
 */
export function canonicalizeStaleIndexDescription(element: unknown): unknown {
  if (typeof element !== 'object' || element === null || Array.isArray(element)) return element;
  const entry = element as Record<string, unknown>;
  const copy = { ...entry };
  let changed = false;
  for (const member of SDK_ONLY_INDEX_MEMBERS) {
    if (member in copy) {
      delete copy[member];
      changed = true;
    }
  }
  const pt = copy['ProvisionedThroughput'];
  if (isPlainCapacityBlock(pt) && SDK_ONLY_THROUGHPUT_MEMBERS.some((member) => member in pt)) {
    changed = true;
    const trimmed = { ...pt };
    for (const member of SDK_ONLY_THROUGHPUT_MEMBERS) delete trimmed[member];
    // The readback never emits an empty block, so a trim that leaves nothing
    // must drop the key like the `{0, 0}` placeholder does.
    const placeholder =
      (trimmed['ReadCapacityUnits'] ?? 0) === 0 && (trimmed['WriteCapacityUnits'] ?? 0) === 0;
    if (placeholder) delete copy['ProvisionedThroughput'];
    else copy['ProvisionedThroughput'] = trimmed;
  }
  const warm = copy['WarmThroughput'];
  if (isPlainCapacityBlock(warm) && 'Status' in warm) {
    delete copy['WarmThroughput'];
    changed = true;
  }
  return changed ? copy : element;
}

/**
 * Structural equality that ignores object key order and prototype: a template
 * renders `Projection` as `{NonKeyAttributes, ProjectionType}`, a readback as
 * `{ProjectionType, NonKeyAttributes}`, and a redacted bag can be null-prototype.
 * Array order stays significant (`KeySchema` is HASH before RANGE).
 */
export function sameJsonValue(a: unknown, b: unknown): boolean {
  const toJson = (v: unknown): unknown =>
    v === undefined ? undefined : (JSON.parse(JSON.stringify(v)) as unknown);
  return isDeepStrictEqual(toJson(a), toJson(b));
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
 *    {@link DynamoDBTableProvider.coerceIndexThroughputForCreate}. It is
 *    TIGHTER than truthiness (at least one member resolving to a finite
 *    number), so `WarmThroughput: {}` is neither sent nor emitted on any path.
 *    An earlier version of this bullet carved out the TABLE-create path as an
 *    exception, and that exception was a DEFECT rather than a design: it also
 *    put a quoted `'12000'` on the wire as a string in a Long field, so one
 *    template failed on a fresh create and succeeded on a later GSI add. Fixed
 *    in PR review round 6; the carve-out is gone because the divergence is.
 *  - `ProvisionedThroughput` / `OnDemandThroughput` keep TRUTHINESS, which is
 *    still what their write path does: `applyGsiUpdates` gates on
 *    `gsi.ProvisionedThroughput` / `gsi.OnDemandThroughput` alone, and NEITHER
 *    block's Integer coercion — `ProvisionedThroughput`'s from issue
 *    [#3255](https://github.com/go-to-k/cdkd/issues/3255), across ALL FOUR
 *    per-index send sites (`create()`'s mapper plus `applyGsiUpdates`'
 *    adopted-repair, `Create` and same-name `Update` actions);
 *    `OnDemandThroughput`'s from issues
 *    [#3265](https://github.com/go-to-k/cdkd/issues/3265) and
 *    [#3287](https://github.com/go-to-k/cdkd/issues/3287), across its own SIX
 *    (the two TABLE-level forwards, `create()`'s mapper, and all three
 *    `applyGsiUpdates` actions) — ever SUPPRESSES the block: each
 *    rewrites members inside a block that is sent either way, so "would cdkd
 *    send this block" is unchanged by them, even where both members were
 *    dropped and an empty block goes out. That is the reason
 *    {@link DynamoDBTableProvider.coerceOnDemandCeilingsForSend} drops a
 *    MEMBER and never the block.
 *
 *    **The two per-index UPDATE arms added by #3287 are the ONE qualification,
 *    and it does not reach this predicate.**
 *    {@link DynamoDBTableProvider.indexCeilingForSend} withholds the MEMBER
 *    from an `UpdateGlobalSecondaryIndexAction` when nothing survived, because
 *    an action carrying only `IndexName` is rejected outright — where the
 *    TABLE-level arm sends the empty block and lets DynamoDB answer. That is a
 *    statement about one OP, not about whether the template declared a block
 *    cdkd forwards: the same bag still reaches `CreateTable` / `UpdateTable`
 *    wherever those arms run, so the predicate's answer is unchanged.
 *    Widening
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
export function indexDeclares(
  desired: Record<string, unknown> | undefined,
  key: string,
  bagInformative: boolean
): boolean {
  if (!bagInformative) return true;
  const value = desired?.[key];
  return key === 'WarmThroughput' ? wasSentWarmThroughput(value) : Boolean(value);
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
export function declaresIndexList(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0;
}

/**
 * go-to-k/cdkd#5354: the refusal sentence for a `DeletionProtectionEnabled`
 * that is not a CFn boolean, or `undefined` when it is one (or is absent).
 * Shared by `create()` and `update()` so the two read one grammar —
 * `coerceCfnBoolean`'s, the function the wire read calls.
 */
export function deletionProtectionRefusal(value: unknown, logicalId: string): string | undefined {
  return configBooleanRefusal(
    { DeletionProtectionEnabled: value },
    'DeletionProtectionEnabled',
    `AWS::DynamoDB::Table ${logicalId}`
  );
}

/**
 * go-to-k/cdkd#5354: a comparison key for a `LocalSecondaryIndexes` list that
 * ignores what DynamoDB itself ignores — the order of the indexes, the order of
 * `Projection.NonKeyAttributes`, and member order inside an entry — so a
 * recorded list that differs from the template only in spelling is not read
 * as a change. Anything not shaped like an index list is keyed by its JSON, so
 * a malformed value still compares unequal to a well-formed one.
 */
export function localSecondaryIndexesKey(value: unknown): string {
  if (value === undefined || value === null) return '[]';
  if (!Array.isArray(value)) return JSON.stringify(value);
  const isRecord = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null && !Array.isArray(v);
  const entries = value.map((entry) => {
    if (!isRecord(entry)) return JSON.stringify(entry);
    const keySchema = Array.isArray(entry['KeySchema'])
      ? entry['KeySchema'].map((element) =>
          isRecord(element)
            ? { AttributeName: element['AttributeName'], KeyType: element['KeyType'] }
            : element
        )
      : entry['KeySchema'];
    const projection = entry['Projection'];
    const projectionKey = isRecord(projection)
      ? {
          ProjectionType: projection['ProjectionType'],
          // An empty list projects nothing extra, the same as an absent one.
          NonKeyAttributes: Array.isArray(projection['NonKeyAttributes'])
            ? projection['NonKeyAttributes'].length > 0
              ? [...(projection['NonKeyAttributes'] as unknown[])].map(String).sort()
              : undefined
            : projection['NonKeyAttributes'],
        }
      : projection;
    return JSON.stringify({
      IndexName: entry['IndexName'],
      KeySchema: keySchema,
      Projection: projectionKey,
    });
  });
  return JSON.stringify(entries.sort());
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
export function desiredIndexEntriesByName(value: unknown): Map<string, Record<string, unknown>> {
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
 * go-to-k/cdkd#5503: the entries of a live `GlobalSecondaryIndexes` list whose
 * `IndexName` the record or the template names, or `undefined` when none is
 * left. An entry without a string `IndexName` names nothing and is dropped.
 */
export function projectIndexesOnto(
  live: unknown,
  recorded: unknown,
  desired: unknown,
  // go-to-k/cdkd#5498: the names a failed update's accepted Create added. A
  // live index named here (exactly, not redacted) joins the previous side, so
  // the template's omission removes it; nothing else does.
  attempted: ReadonlySet<string> = new Set()
): unknown[] | undefined {
  if (!Array.isArray(live)) return undefined;
  const named = new Set<string>([...attempted].filter(isUsableAttemptedName));
  for (const list of [recorded, desired]) {
    if (!Array.isArray(list)) continue;
    for (const entry of list as unknown[]) {
      const name =
        typeof entry === 'object' && entry !== null
          ? (entry as Record<string, unknown>)['IndexName']
          : undefined;
      if (typeof name === 'string') named.add(name);
    }
  }
  const kept = (live as unknown[]).filter((entry) => {
    const name =
      typeof entry === 'object' && entry !== null
        ? (entry as Record<string, unknown>)['IndexName']
        : undefined;
    return typeof name === 'string' && named.has(name);
  });
  return kept.length > 0 ? kept : undefined;
}
