import {
  DescribeTableCommand,
  DescribeKinesisStreamingDestinationCommand,
  DescribeTimeToLiveCommand,
} from '@aws-sdk/client-dynamodb';
import { ProvisioningError } from '../../../utils/error-handler.js';
import { coerceCfnBoolean } from '../../config-shape.js';
import type { ResourceNotFound } from '../../../types/resource.js';
import type { DynamoDBTableProvider } from '../dynamodb-table-provider.js';
import {
  canonicalizeStaleIndexDescription,
  declaresIndexList,
  desiredIndexEntriesByName,
  projectIndexesOnto,
} from './indexes.js';
import { isPlainCapacityBlock } from './table-helpers.js';
import {
  declaresWarmThroughput,
  desiredBagIsInformative,
  sentWarmThroughputMembers,
  trimUnsentWarmMembers,
} from './warm-throughput.js';

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
 * `GlobalSecondaryIndexes` / `LocalSecondaryIndexes` ARE declared, in the
 * LEAF-ONLY form (`LEAF_ONLY_PATH_SUFFIX`, `[]`, from
 * [#1799](https://github.com/go-to-k/cdkd/pull/1799)): both are sets keyed
 * by `IndexName`, and `DescribeTable` does not return them in the template's
 * order. A plain SUBTREE entry would be wrong — the unordered walk descends
 * into array elements giving each the parent's path (`drift-normalize.ts`),
 * so `'GlobalSecondaryIndexes'` would also sort each index's `KeySchema` and
 * reverse the sentence above at the index level. The leaf-only form sorts
 * the list and stops there.
 *
 * Measured on real AWS by issue
 * [#1782](https://github.com/go-to-k/cdkd/issues/1782)'s two-index fixture:
 * a table created with `[giA, giB]` read back as `[giB, giA]`, so a
 * `properties` baseline reported whole-list drift although every member
 * round-tripped. The phantom pre-dates that issue — the #1767 arm only ever
 * had ONE index — and was not reachable against an `observedProperties`
 * baseline, where both sides come from the same readback. Both comparison
 * sides are sorted, by a key-order-independent serialization of the whole
 * entry, so a baseline captured in AWS's order by an earlier binary keeps
 * converging; a REAL difference still reports the list, since entries that
 * differ cannot be made equal by reordering them.
 */
export function getDriftUnorderedPaths(
  this: DynamoDBTableProvider,
  resourceType: string
): string[] {
  if (resourceType !== 'AWS::DynamoDB::Table') return [];
  return [
    'AttributeDefinitions',
    'GlobalSecondaryIndexes[]',
    'LocalSecondaryIndexes[]',
    // go-to-k/cdkd#2762: a SUBTREE entry, unlike the two above. The list is
    // keyed by IndexName and every array inside an element is unordered
    // too (`SearchSchema` is CFn `insertionOrder: false`, and
    // `Projection.NonKeyAttributes` is a set): none carries an
    // order-significant KeySchema.
    'VectorIndexes',
  ];
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
 * DESIRED bag declares it (the same shape issue #1742 proposed for the
 * per-index sibling, which landed in #1859 — this site carried it first),
 * never as a blanket drop:
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
 * A table whose template DOES declare indexes keeps comparing the list, so
 * an observed baseline an earlier binary wrote — the whole SDK description
 * per index — is converged by {@link canonicalizeDriftProperties} instead of
 * by a path here: no PATH can express a per-member suppression, because
 * `isIgnoredPath` is never asked about a path that crosses an array
 * (`diffAt` compares arrays wholesale), and ignoring the whole list would
 * stop detecting an out-of-band index add / remove / capacity change.
 */
export function getDriftUnknownPaths(
  this: DynamoDBTableProvider,
  resourceType: string,
  properties?: Record<string, unknown>
): string[] {
  if (resourceType !== 'AWS::DynamoDB::Table') return [];
  const paths: string[] = [];
  if (!declaresWarmThroughput(properties)) paths.push('WarmThroughput');
  // The SAME predicate the readback's matcher uses (see
  // {@link declaresIndexList}), so a bag whose list the mapper treats as
  // declaring nothing is never left in the comparison.
  if (desiredBagIsInformative(properties)) {
    for (const key of ['GlobalSecondaryIndexes', 'LocalSecondaryIndexes']) {
      // Same spelling as `declaresWarmThroughput` above: an explicit check
      // rather than a non-null `!`.
      if (properties !== undefined && !declaresIndexList(properties[key])) paths.push(key);
    }
  }
  return paths;
}

/**
 * Converge a pre-#1767 `observedProperties` record with the reverse-mapped
 * readback (issue #1812). Such a record holds each index's raw
 * `DescribeTable` description, so a table whose template declares indexes
 * reported a one-sided `GlobalSecondaryIndexes` difference on every
 * `cdkd drift` until the next deploy re-captured it. Convergence needs a
 * non-empty recorded bag: with an empty one the readback emits every
 * throughput block (see {@link reverseMapSecondaryIndex}), so a stale
 * baseline still reports.
 *
 * Keyed on members only an SDK description carries — never on the desired
 * side, which this hook does not see — so a bag written by the current
 * readback, or a template, comes back by identity and loses no detection:
 *  - `IndexStatus` / `Backfilling` / `IndexSizeBytes` / `ItemCount` /
 *    `IndexArn` are not CFn members and are dropped.
 *  - A `ProvisionedThroughput` carrying `NumberOfDecreasesToday` (or the
 *    two `Last*DateTime` members) is trimmed to its capacities, and dropped
 *    when both are 0: that is AWS's on-demand placeholder, which no template
 *    can declare (the minimum is 1) and the readback emits only when the
 *    template declares the block.
 *  - A `WarmThroughput` carrying `Status` is dropped WHOLE, not just its
 *    `Status`. AWS reports a computed per-index value for every GSI, and the
 *    readback emits it only when the template declares one, which is rare;
 *    stripping `Status` alone would leave the common undeclared case
 *    drifting. A stale record whose template DOES declare it reports once,
 *    until the next deploy or `--accept`, as it did before.
 */
export function canonicalizeDriftProperties(
  this: DynamoDBTableProvider,
  resourceType: string,
  properties: Record<string, unknown>
): Record<string, unknown> {
  if (resourceType !== 'AWS::DynamoDB::Table') return properties;
  let result = properties;
  // go-to-k/cdkd#5354: a template may spell `DeletionProtectionEnabled` as
  // `'true'` / `'false'`, which create() / update() send as the boolean and
  // the readback reports as one; read the recorded string the same way so it
  // is not drift. A value that is no boolean passes through and is compared
  // as is.
  const protection = coerceCfnBoolean(result['DeletionProtectionEnabled']);
  if (protection !== undefined && protection !== result['DeletionProtectionEnabled']) {
    result = { ...result, DeletionProtectionEnabled: protection };
  }
  for (const listKey of ['GlobalSecondaryIndexes', 'LocalSecondaryIndexes']) {
    const list = result[listKey];
    if (!Array.isArray(list)) continue;
    let changed = false;
    const canonical = list.map((element) => {
      const next = canonicalizeStaleIndexDescription(element);
      if (next !== element) changed = true;
      return next;
    });
    if (changed) result = { ...result, [listKey]: canonical };
  }
  return result;
}

/**
 * Trim a baseline's `WarmThroughput` members that cdkd never sent (issue
 * #3777), table-level and per GSI (matched by `IndexName`).
 *
 * The readback emits only the members {@link sentWarmThroughputMembers}
 * names, so a `{ReadUnitsPerSecond: 12000, WriteUnitsPerSecond: 'abc'}`
 * declaration reads back `ReadUnitsPerSecond` alone. A baseline captured
 * before that change carries AWS's computed `WriteUnitsPerSecond`, and a
 * `properties` fallback baseline carries the unresolvable `'abc'`; compared
 * as is, either reports a member cdkd does not manage. The sent set comes
 * from `properties`, the recorded declaration the readback was built from,
 * which only this hook receives alongside the baseline: the per-side hook
 * sees neither. See {@link trimUnsentWarmMembers} for why a current-shape
 * baseline is compared in full and a member AWS omits is never trimmed.
 *
 * This DROPS from the baseline, where the contract prefers completing it,
 * and `drift --revert` sends the result: a warm-throughput member missing
 * from the desired side is not a removal, since every send site coerces the
 * block to its usable members and AWS cannot lower or unset warm throughput.
 * LSIs carry no `WarmThroughput`. The AWS side is returned by identity.
 *
 * Known narrow residual: the masked-baseline re-capture compares a fresh
 * readback against the untrimmed record, so a legacy two-member capture under
 * a one-member declaration persists until the next ordinary update
 * re-captures it. Drift output is unaffected, since the compare trims here.
 */
export async function canonicalizeDriftPair(
  this: DynamoDBTableProvider,
  resourceType: string,
  baseline: Record<string, unknown>,
  aws: Record<string, unknown>,
  properties?: Record<string, unknown>
): Promise<{ baseline: Record<string, unknown>; aws: Record<string, unknown> }> {
  if (resourceType !== 'AWS::DynamoDB::Table') return { baseline, aws };
  // No recorded declaration to decide with: the readback emitted every
  // member, so there is nothing to trim. An empty bag needs no guard of its
  // own: it declares no block, so every sent set below is empty.
  if (properties === undefined) return { baseline, aws };
  let result = baseline;
  const tableWarm = trimUnsentWarmMembers(
    baseline['WarmThroughput'],
    sentWarmThroughputMembers(properties['WarmThroughput'])
  );
  if (tableWarm !== baseline['WarmThroughput']) {
    result = { ...result, WarmThroughput: tableWarm };
  }
  const key = 'GlobalSecondaryIndexes';
  const baselineIndexes = baseline[key];
  if (Array.isArray(baselineIndexes)) {
    const desiredByName = desiredIndexEntriesByName(properties[key]);
    let changed = false;
    const trimmed = baselineIndexes.map((entry: unknown) => {
      if (!isPlainCapacityBlock(entry) || typeof entry['IndexName'] !== 'string') return entry;
      const desired = desiredByName.get(entry['IndexName']);
      if (desired === undefined) return entry;
      const warm = trimUnsentWarmMembers(
        entry['WarmThroughput'],
        sentWarmThroughputMembers(desired['WarmThroughput'])
      );
      if (warm === entry['WarmThroughput']) return entry;
      changed = true;
      return { ...entry, WarmThroughput: warm };
    });
    if (changed) result = { ...result, [key]: trimmed };
  }
  return { baseline: result, aws };
}

/**
 * go-to-k/cdkd#5487: the live values of a record's unsettled properties in
 * the template's shape, for the engine's convergence step. `readCurrentState`
 * (shaped against the record, so its indexes and warm throughput carry the
 * members the record declares) with two corrections:
 *
 * - a PAY_PER_REQUEST table reports no `ProvisionedThroughput` (DescribeTable
 *   answers 0/0, which no template declares, and the billing block would
 *   read it as a change and send an UpdateTable AWS refuses as a no-op);
 * - the settings read by their own calls (PITR, TTL, resource policy,
 *   Kinesis, Contributor Insights) are read STRICTLY when unsettled:
 *   `readCurrentState` omits them on a failed read, which would converge
 *   them to "not set".
 */
export async function readUnsettled(
  this: DynamoDBTableProvider,
  physicalId: string,
  logicalId: string,
  resourceType: string,
  names: ReadonlySet<string>,
  recordedProperties?: Record<string, unknown>,
  desiredProperties?: Record<string, unknown>,
  attemptedItems?: ReadonlyMap<string, ReadonlySet<string>>
): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
  const live = await this.readCurrentState(physicalId, logicalId, resourceType, recordedProperties);
  if (typeof live !== 'object' || live === null) return live;
  const out: Record<string, unknown> = { ...live };
  if (out['BillingMode'] === 'PAY_PER_REQUEST') delete out['ProvisionedThroughput'];
  // go-to-k/cdkd#5503: the live indexes, projected onto the names the record
  // or the template declares. This value becomes the previous side, and
  // `applyGsiUpdates` deletes every previous index the template lacks, so an
  // index neither names (one another tool added) would be DELETED, where
  // CloudFormation, which diffs recorded models, leaves it alone. A recorded
  // index the template dropped is still on the previous side, and still
  // deleted. One the template adds that is already live (a failed update
  // created it) keeps its live value, so it is compared, not re-created.
  if (names.has('GlobalSecondaryIndexes')) {
    out['GlobalSecondaryIndexes'] = projectIndexesOnto(
      out['GlobalSecondaryIndexes'],
      recordedProperties?.['GlobalSecondaryIndexes'],
      desiredProperties?.['GlobalSecondaryIndexes'],
      attemptedItems?.get('GlobalSecondaryIndexes')
    );
    if (out['GlobalSecondaryIndexes'] === undefined) delete out['GlobalSecondaryIndexes'];
  }
  // go-to-k/cdkd#2762: the same projection for VectorIndexes, so a vector
  // index another tool added is left alone rather than deleted.
  if (names.has('VectorIndexes')) {
    out['VectorIndexes'] = projectIndexesOnto(
      out['VectorIndexes'],
      recordedProperties?.['VectorIndexes'],
      desiredProperties?.['VectorIndexes'],
      attemptedItems?.get('VectorIndexes')
    );
    if (out['VectorIndexes'] === undefined) delete out['VectorIndexes'];
  }
  const strict = async (key: string, read: () => Promise<unknown>): Promise<void> => {
    if (!names.has(key)) return;
    const value = await read();
    if (value === undefined) delete out[key];
    else out[key] = value;
  };
  await strict('PointInTimeRecoverySpecification', () =>
    this.readPointInTimeRecovery(physicalId, true)
  );
  await strict('TimeToLiveSpecification', () => this.readTimeToLive(physicalId, true));
  await strict('KinesisStreamSpecification', () =>
    this.readKinesisStreamSpecification(physicalId, true)
  );
  await strict('ContributorInsightsSpecification', () =>
    this.readTableContributorInsights(physicalId, true)
  );
  if (names.has('ResourcePolicy')) {
    const table = (
      await this.dynamoDBClient.send(new DescribeTableCommand({ TableName: physicalId }))
    ).Table;
    if (!table?.TableArn) {
      throw new ProvisioningError(
        `DescribeTable returned no TableArn for the table, which reading its unsettled ResourcePolicy needs`,
        resourceType,
        logicalId,
        physicalId
      );
    }
    const tableArn = table.TableArn;
    await strict('ResourcePolicy', () => this.readTableResourcePolicy(physicalId, tableArn, true));
  }
  return out;
}

/**
 * go-to-k/cdkd#5487: the unsettled names AWS is still changing. While the
 * table is CREATING / UPDATING / DELETING every table-level name is (the
 * separately-applied settings and `Tags` are not); an index CREATING /
 * UPDATING / DELETING moves `GlobalSecondaryIndexes`; an SSE ENABLING /
 * DISABLING / UPDATING moves `SSESpecification`; a TTL ENABLING moves
 * `TimeToLiveSpecification` (DISABLING reads as its destination, no TTL); a
 * Kinesis destination ENABLING / DISABLING / UPDATING moves
 * `KinesisStreamSpecification`. A status at rest — an inaccessible key, an
 * archived table — is not moving: the update runs and AWS's error names it.
 * A failed read keeps every name, which the engine reports as unconfirmed.
 *
 * `WarmThroughput` is deliberately NOT a moving name here, though its `Status`
 * reads `UPDATING` and `AWS::DynamoDB::GlobalTable` lists it (go-to-k/cdkd#5606).
 * A first raise holds that status for about 10 minutes, so listing it would
 * refuse every retry of a failed deploy for that long, while AWS accepts the
 * re-sent value inside the window (measured, go-to-k/cdkd#5607). The cost: a
 * template reverted inside the window lands on the higher value, which drift
 * reports once settled.
 */
export async function unsettledInTransition(
  this: DynamoDBTableProvider,
  physicalId: string,
  _logicalId: string,
  _resourceType: string,
  names: ReadonlySet<string>
): Promise<ReadonlySet<string>> {
  const SEPARATE = new Set([
    'Tags',
    'PointInTimeRecoverySpecification',
    'TimeToLiveSpecification',
    'ResourcePolicy',
    'KinesisStreamSpecification',
    'ContributorInsightsSpecification',
  ]);
  try {
    const table = (
      await this.dynamoDBClient.send(new DescribeTableCommand({ TableName: physicalId }))
    ).Table;
    const moving = new Set<string>();
    // Only a status AWS is moving through. An inaccessible-key or archived
    // table is at rest: the update runs, so AWS's own error names the cause.
    if (
      table?.TableStatus === 'CREATING' ||
      table?.TableStatus === 'UPDATING' ||
      table?.TableStatus === 'DELETING'
    ) {
      for (const name of names) if (!SEPARATE.has(name)) moving.add(name);
    }
    if (
      names.has('GlobalSecondaryIndexes') &&
      (table?.GlobalSecondaryIndexes ?? []).some(
        (index) =>
          index.IndexStatus === 'CREATING' ||
          index.IndexStatus === 'UPDATING' ||
          index.IndexStatus === 'DELETING'
      )
    ) {
      moving.add('GlobalSecondaryIndexes');
    }
    const sse = table?.SSEDescription?.Status;
    if (
      names.has('SSESpecification') &&
      (sse === 'ENABLING' || sse === 'DISABLING' || sse === 'UPDATING')
    ) {
      moving.add('SSESpecification');
    }
    if (names.has('TimeToLiveSpecification')) {
      const ttl = (
        await this.dynamoDBClient.send(new DescribeTimeToLiveCommand({ TableName: physicalId }))
      ).TimeToLiveDescription?.TimeToLiveStatus;
      // DISABLING can last up to an hour and only ever ends disabled, so it
      // is read as its destination (no TTL, `readTimeToLive`), not as moving.
      if (ttl === 'ENABLING') moving.add('TimeToLiveSpecification');
    }
    if (names.has('KinesisStreamSpecification')) {
      const destinations =
        (
          await this.dynamoDBClient.send(
            new DescribeKinesisStreamingDestinationCommand({ TableName: physicalId })
          )
        ).KinesisDataStreamDestinations ?? [];
      if (
        destinations.some(
          (d) =>
            d.DestinationStatus === 'ENABLING' ||
            d.DestinationStatus === 'DISABLING' ||
            d.DestinationStatus === 'UPDATING'
        )
      ) {
        moving.add('KinesisStreamSpecification');
      }
    }
    return moving;
  } catch {
    return names;
  }
}
