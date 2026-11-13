import type { TableDescription } from '@aws-sdk/client-dynamodb';
import { coerceCfnInteger } from '../../config-shape.js';
import { verboseAwareText } from '../../../utils/aws-failure-text.js';
import { INDEX_SETTLE_POLL_INTERVAL_MS } from '../../dynamodb-index-busy-delete.js';
import { DYNAMODB_DELETE_POLL_COST_MS } from '../dynamodb-delete-budget.js';
import type { MaskerFn } from '../../masked-retry-logger.js';
import {
  localReplicaEntry,
  TABLE_READ_PROVISIONED_KEY,
  TABLE_WRITE_PROVISIONED_KEY,
} from './replica-shape.js';
import {
  reportUnresolvedProvisionedCapacity,
  deriveWriteCapacityUnits,
  deriveReadCapacityUnits,
  type ThroughputDiagnostic,
  type CapacitySource,
} from './throughput.js';
import { deepEqual } from './gsi-diff.js';

/**
 * Derive the per-call `ProvisionedThroughput` shape required by
 * `CreateTableCommand` / `UpdateTableCommand` when BillingMode is
 * PROVISIONED. Shared between create() and the BillingMode-flip path in
 * update() so a user template's non-default read/write capacity is
 * preserved consistently across both code paths.
 *
 * Source of truth (CFn `AWS::DynamoDB::GlobalTable` shape):
 *  - WriteCapacityUnits → `properties.WriteProvisionedThroughputSettings`
 *    (top-level on the table). That block's ONLY member is
 *    `WriteCapacityAutoScalingSettings` — write capacity on a GlobalTable is
 *    always auto-scaled, so there is no literal `WriteCapacityUnits` to
 *    prefer. `CreateTable` needs one concrete number; which member of the
 *    auto-scaling block supplies it is context-dependent — see
 *    {@link CapacitySource}, which `source` selects. 5 if the block is absent.
 *  - ReadCapacityUnits → `Replicas[?Region==<region>].ReadProvisionedThroughputSettings`
 *    (per-replica, the deploy region's setting). That block DOES carry a
 *    literal `ReadCapacityUnits`, which is taken before its auto-scaling
 *    members; 5 if absent.
 */
export function derivePerCallProvisionedThroughput(
  properties: Record<string, unknown>,
  region: string,
  source: CapacitySource = 'min',
  diagnostics?: ThroughputDiagnostic[],
  // See `mergeExplicitThroughputBlock` for why the mask goes INSIDE the
  // stringify rather than around the finished message (issue #2178).
  maskSecrets: MaskerFn = (text) => text
): { ReadCapacityUnits: number; WriteCapacityUnits: number } {
  // `Array.isArray` rather than a bare cast: a non-array `Replicas` (an
  // unresolved intrinsic, a malformed template) would otherwise die on `.find`
  // with a bare `TypeError`. That was survivable while this helper only
  // computed numbers; it now also produces a user-facing diagnostic, so the
  // sibling `toSdkGlobalSecondaryIndexes` treatment applies here too.
  const rawReplicas = properties['Replicas'];
  const replicas = Array.isArray(rawReplicas) ? rawReplicas : [];
  const localReplica = replicas.find((r) => asRecord(r)?.['Region'] === region) as
    | Record<string, unknown>
    | undefined;
  // Read capacity is per-replica on a GlobalTable; the deploy region's
  // replica is the one `CreateTable` / `UpdateTable` provisions.
  // go-to-k/cdkd#2762: the table-level block takes its place on a table with
  // settings replication ENABLED (CloudFormation refuses it otherwise, and
  // refuses both at once).
  const rawRead =
    localReplica?.['ReadProvisionedThroughputSettings'] ?? properties[TABLE_READ_PROVISIONED_KEY];
  const rawWrite = properties['WriteProvisionedThroughputSettings'];
  const read = deriveReadCapacityUnits(asRecord(rawRead), source);
  const write = deriveWriteCapacityUnits(asRecord(rawWrite), source);
  // A DECLARED-but-unreadable value falling through to 5/5 is the silent
  // mis-size issue #1511 filed; an ABSENT block defaults silently, as before.
  if (read === undefined) {
    reportUnresolvedProvisionedCapacity(
      rawRead,
      'Read',
      source,
      { appliedUnits: DEFAULT_CAPACITY_UNITS },
      diagnostics,
      {
        blockName:
          localReplica?.['ReadProvisionedThroughputSettings'] !== undefined
            ? 'Replicas[local].ReadProvisionedThroughputSettings'
            : TABLE_READ_PROVISIONED_KEY,
      },
      maskSecrets
    );
  }
  if (write === undefined) {
    reportUnresolvedProvisionedCapacity(
      rawWrite,
      'Write',
      source,
      { appliedUnits: DEFAULT_CAPACITY_UNITS },
      diagnostics,
      { blockName: 'WriteProvisionedThroughputSettings' },
      maskSecrets
    );
  }
  return {
    ReadCapacityUnits: read ?? DEFAULT_CAPACITY_UNITS,
    WriteCapacityUnits: write ?? DEFAULT_CAPACITY_UNITS,
  };
}

/** The regions other than `region` a properties bag declares. */
export function declaredCrossRegions(
  properties: Record<string, unknown>,
  region: string
): string[] {
  const replicas = properties['Replicas'];
  return (Array.isArray(replicas) ? replicas : [])
    .map((replica) => asRecord(replica)?.['Region'])
    .filter((name): name is string => typeof name === 'string' && name !== region);
}

/** Whether a properties bag declares write auto-scaling. */
export function writeSideScaled(bag: Record<string, unknown>): boolean {
  return (
    asRecord(bag[TABLE_WRITE_PROVISIONED_KEY])?.['WriteCapacityAutoScalingSettings'] !== undefined
  );
}

/**
 * Whether this update moves a PROVISIONED table's capacity with a write side that
 * is not auto-scaled: a literal or read change on a literal table, the
 * auto-scaling removed, or a flip from on-demand, whose capacity is all new.
 */
export function literalWriteSideMoves(
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>,
  region: string,
  live: TableDescription | undefined
): boolean {
  if (properties['BillingMode'] !== 'PROVISIONED' || writeSideScaled(properties)) return false;
  if (writeSideScaled(previousProperties)) return true;
  if (live?.BillingModeSummary?.BillingMode === 'PAY_PER_REQUEST') return true;
  const change = readTableCapacityChange(properties, previousProperties, region, [], (t) => t);
  return (
    (change.write !== undefined &&
      change.write !== live?.ProvisionedThroughput?.WriteCapacityUnits) ||
    (change.read !== undefined && change.read !== live?.ProvisionedThroughput?.ReadCapacityUnits)
  );
}

/**
 * What an in-place update owes the table's `ProvisionedThroughput` while the
 * billing mode holds still: the literal capacity of each side whose block
 * changed, and the keys a moved read side leaves unsettled (the read block
 * lives on the local replica, or at the table level with settings replication
 * ENABLED; the two spell one value).
 *
 * A block carrying auto-scaling settings yields nothing, whatever else it
 * declares: the scaling policy owns that dimension, and its diff is applied by
 * step 4b and by {@link reconcileAutoScalingTargets}. A declared literal this
 * cannot read is reported, since the deploy otherwise succeeds with the old
 * capacity in place.
 */
export function readTableCapacityChange(
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>,
  region: string,
  diagnostics: ThroughputDiagnostic[],
  maskSecrets: MaskerFn
): { read?: number; write?: number; readKeys: string[] } {
  const localBlockOf = (bag: Record<string, unknown>): unknown =>
    localReplicaEntry(bag, region)?.[TABLE_READ_PROVISIONED_KEY];
  const readBlockOf = (bag: Record<string, unknown>): unknown =>
    localBlockOf(bag) ?? bag[TABLE_READ_PROVISIONED_KEY];
  const literal = (
    block: unknown,
    previousBlock: unknown,
    side: 'Read' | 'Write',
    blockName: string
  ): number | undefined => {
    if (deepEqual(block, previousBlock)) return undefined;
    const settings = asRecord(block);
    if (settings?.[`${side}CapacityAutoScalingSettings`] !== undefined) return undefined;
    const units = coerceCfnInteger(settings?.[`${side}CapacityUnits`]);
    if (units === undefined) {
      reportUnresolvedProvisionedCapacity(
        block,
        side,
        'min',
        { suppressed: 'so cdkd sent no capacity for it and the old value stays on AWS' },
        diagnostics,
        { blockName },
        maskSecrets
      );
    }
    return units;
  };
  const read = literal(
    readBlockOf(properties),
    readBlockOf(previousProperties),
    'Read',
    localBlockOf(properties) !== undefined
      ? `Replicas[local].${TABLE_READ_PROVISIONED_KEY}`
      : TABLE_READ_PROVISIONED_KEY
  );
  const write = literal(
    properties[TABLE_WRITE_PROVISIONED_KEY],
    previousProperties[TABLE_WRITE_PROVISIONED_KEY],
    'Write',
    TABLE_WRITE_PROVISIONED_KEY
  );
  const declaredOnReplica =
    localBlockOf(properties) !== undefined || localBlockOf(previousProperties) !== undefined;
  const declaredOnTable =
    properties[TABLE_READ_PROVISIONED_KEY] !== undefined ||
    previousProperties[TABLE_READ_PROVISIONED_KEY] !== undefined;
  return {
    ...(read !== undefined && { read }),
    ...(write !== undefined && { write }),
    readKeys: [
      ...(declaredOnTable ? [TABLE_READ_PROVISIONED_KEY] : []),
      ...(declaredOnReplica ? ['Replicas'] : []),
    ],
  };
}

/**
 * Capacity units applied when a PROVISIONED template carries no usable
 * capacity value at all. Matches the pre-existing table-level default.
 */
export const DEFAULT_CAPACITY_UNITS = 5;

/**
 * The four application-autoscaling scalable dimensions a DynamoDB
 * GlobalTable can register (Issue #1419). The `dynamodb:index:*` pair was
 * previously missing entirely, so a per-GSI `*CapacityAutoScalingSettings`
 * block never became a real scaling policy — the index stayed pinned at its
 * initial capacity forever.
 */
export type DynamoDBScalableDimension =
  | 'dynamodb:table:WriteCapacityUnits'
  | 'dynamodb:table:ReadCapacityUnits'
  | 'dynamodb:index:WriteCapacityUnits'
  | 'dynamodb:index:ReadCapacityUnits';

const DYNAMODB_SCALABLE_DIMENSIONS: ReadonlySet<string> = new Set<DynamoDBScalableDimension>([
  'dynamodb:table:WriteCapacityUnits',
  'dynamodb:table:ReadCapacityUnits',
  'dynamodb:index:WriteCapacityUnits',
  'dynamodb:index:ReadCapacityUnits',
]);

/** Whether an AWS-reported `ScalableDimension` is one of the four above. */
export function isDynamoDBScalableDimension(value: unknown): value is DynamoDBScalableDimension {
  return typeof value === 'string' && DYNAMODB_SCALABLE_DIMENSIONS.has(value);
}

/**
 * One application-autoscaling target derivable from a CFn
 * `AWS::DynamoDB::GlobalTable` properties bag.
 */
export interface AutoScalingTargetSpec {
  dimension: DynamoDBScalableDimension;
  /** Index name for `dynamodb:index:*`; `undefined` at table level. */
  indexName?: string;
  /** Region whose application-autoscaling control plane owns the target. */
  region: string;
  /** The CFn `{Read,Write}CapacityAutoScalingSettings` block. */
  settings: Record<string, unknown>;
}

/**
 * Stable identity for an {@link AutoScalingTargetSpec}, used to diff the
 * previous template's targets against the desired ones.
 */
export function autoScalingTargetKey(spec: {
  dimension: DynamoDBScalableDimension;
  indexName?: string;
  region: string;
}): string {
  return `${spec.region}|${spec.dimension}|${spec.indexName ?? ''}`;
}

/**
 * The application-autoscaling `ResourceId` for a DynamoDB table or one of
 * its indexes. ONE spelling, shared by the register / policy / deregister
 * calls, the presence probe, and the target key — a divergence between any
 * two of those would silently register one target and look up another.
 */
export function autoScalingResourceId(tableName: string, indexName?: string): string {
  return indexName ? `table/${tableName}/index/${indexName}` : `table/${tableName}`;
}

/**
 * Test seam for the auto-scaling throttle retry's backoff, mirroring
 * `describeTypeRetryDelays`. Production leaves `sleep` undefined so
 * `withRetry`'s real schedule applies; a test injects a no-op so the ~47s
 * budget does not have to be waited out.
 */
export const autoScalingRetryDelays: { sleep?: (ms: number) => Promise<void> } = {};

/**
 * Polls `waitForReplicaGone` spends waiting for a replica to disappear.
 *
 * Named rather than inlined because it is a TERM of the per-resource deadline
 * arithmetic on this type's delete path (see
 * `GLOBAL_TABLE_DELETE_INDEX_BUSY_MAX_RETRIES`), which prices it through
 * {@link INDEX_SETTLE_POLL_INTERVAL_MS} — the sleep this loop now reads rather
 * than spelling its own `1000`, so the two cannot drift while that arithmetic
 * claims they agree.
 */
export const REPLICA_GONE_WAIT_ATTEMPTS = 600;

/**
 * Polls the `--remove-protection` flip's ACTIVE wait spends
 * (`waitForTableActiveAfterUpdate`).
 *
 * EXPORTED and named rather than left as an inline default argument because it
 * is a TERM of the delete-path deadline arithmetic (see
 * `./dynamodb-delete-budget.ts`): on `cdkd destroy --remove-protection` it runs
 * FIRST, ahead of the #1521 gate, and the wait it performs is the same
 * indexes-settled one the rest of the path is about. The budget fence in the
 * unit suite reads THIS rather than a copied literal, after the sibling
 * arithmetic was twice found asserting a cap the provider no longer had.
 */
export const GLOBAL_TABLE_ACTIVE_WAIT_ATTEMPTS = 600;

/**
 * Polls (1s apart) a vector index gets to settle: the `AWS::DynamoDB::Table`
 * index wait's budget, since a backfill runs as long there as here.
 */
export const VECTOR_INDEX_SETTLE_ATTEMPTS = 1800;

/**
 * Polls `waitForTableGone` spends confirming the table is actually gone.
 *
 * EXPORTED, unlike its replica sibling, because the delete-path budget fence
 * reads it: this wait runs AFTER the index-busy retry loop and only when that
 * loop SUCCEEDS, which is what keeps it out of the loop's own worst case and
 * puts it into the late-success one (both spelled out on
 * `GLOBAL_TABLE_DELETE_INDEX_BUSY_MAX_RETRIES`).
 */
export const TABLE_GONE_WAIT_ATTEMPTS = 600;

/**
 * go-to-k/cdkd#5699: the post-delete gone-wait for each dropped replica's
 * regional copy -- the same cap as {@link TABLE_GONE_WAIT_ATTEMPTS} at its
 * measured poll cost (~12 min) and interval. The shared delete budget clamps
 * it further. Mutable for tests only.
 */
export const replicaDeleteGoneWait = {
  maxWaitMs: TABLE_GONE_WAIT_ATTEMPTS * DYNAMODB_DELETE_POLL_COST_MS,
  pollIntervalMs: INDEX_SETTLE_POLL_INTERVAL_MS,
};

/**
 * Test seam for the index-busy `DeleteTable` retry's backoff (issue #1830),
 * mirroring {@link autoScalingRetryDelays}. Production leaves `sleep`
 * undefined so `withRetry`'s real schedule applies; a test injects a no-op so
 * the ~47s of backoff at this type's budget
 * (`GLOBAL_TABLE_DELETE_INDEX_BUSY_MAX_RETRIES`) does not have to be waited
 * out. Kept SEPARATE from the
 * auto-scaling seam so a test can slow one path without silencing the other.
 */
export const deleteTableRetryDelays: { sleep?: (ms: number) => Promise<void> } = {};

/**
 * Resource ids per `DescribeScalableTargets` request. Kept at the API's
 * documented per-page ceiling rather than a larger guess — the request is
 * paginated anyway, and over-asking risks a `ValidationException` that would
 * degrade the probe to "presence unknown" for the whole region.
 */
export const DESCRIBE_SCALABLE_TARGETS_BATCH = 50;

/**
 * Collect every application-autoscaling target a CFn GlobalTable properties
 * bag declares (Issue #1419).
 *
 * Where each dimension lives in the CFn shape — this is NOT symmetric, and
 * the asymmetry is the reason the per-index targets were missed:
 *
 * | dimension                            | CFn source                                                                    | region |
 * | ------------------------------------ | ----------------------------------------------------------------------------- | ------ |
 * | `dynamodb:table:WriteCapacityUnits`  | `WriteProvisionedThroughputSettings.WriteCapacityAutoScalingSettings`          | local  |
 * | `dynamodb:index:WriteCapacityUnits`  | `GlobalSecondaryIndexes[].WriteProvisionedThroughputSettings.…`                | local  |
 * | `dynamodb:table:ReadCapacityUnits`   | `Replicas[].ReadProvisionedThroughputSettings.ReadCapacityAutoScalingSettings` | replica's |
 * | `dynamodb:index:ReadCapacityUnits`   | `Replicas[].GlobalSecondaryIndexes[].ReadProvisionedThroughputSettings.…`      | replica's |
 *
 * WRITE capacity on a global table is owned by the source region only, so
 * both write dimensions register in the LOCAL region. READ capacity is
 * per-replica: each replica registers its own target with its own region's
 * application-autoscaling endpoint — including the LOCAL replica, whose
 * read target was never registered by any code path before this change
 * (`update()`'s replica loops all `continue` on the local region).
 *
 * A replica entry with no `Region` is skipped rather than defaulted: a
 * target registered against the wrong region's control plane is invisible
 * to every later diff and would leak on destroy.
 */
export function collectAutoScalingTargets(
  properties: Record<string, unknown>,
  localRegion: string
): AutoScalingTargetSpec[] {
  const specs: AutoScalingTargetSpec[] = [];

  const tableWrite = asRecord(
    asRecord(properties['WriteProvisionedThroughputSettings'])?.['WriteCapacityAutoScalingSettings']
  );
  if (tableWrite) {
    specs.push({
      dimension: 'dynamodb:table:WriteCapacityUnits',
      region: localRegion,
      settings: tableWrite,
    });
  }

  const cfnIndexes = properties['GlobalSecondaryIndexes'];
  if (Array.isArray(cfnIndexes)) {
    for (const entry of cfnIndexes) {
      const gsi = asRecord(entry);
      const indexName = gsi?.['IndexName'];
      if (!gsi || typeof indexName !== 'string') continue;
      const indexWrite = asRecord(
        asRecord(gsi['WriteProvisionedThroughputSettings'])?.['WriteCapacityAutoScalingSettings']
      );
      if (indexWrite) {
        specs.push({
          dimension: 'dynamodb:index:WriteCapacityUnits',
          indexName,
          region: localRegion,
          settings: indexWrite,
        });
      }
    }
  }

  const replicas = properties['Replicas'];
  if (Array.isArray(replicas)) {
    for (const replicaEntry of replicas) {
      const replica = asRecord(replicaEntry);
      const region = replica?.['Region'];
      if (!replica || typeof region !== 'string') continue;

      const replicaRead = asRecord(
        asRecord(replica['ReadProvisionedThroughputSettings'])?.['ReadCapacityAutoScalingSettings']
      );
      if (replicaRead) {
        specs.push({
          dimension: 'dynamodb:table:ReadCapacityUnits',
          region,
          settings: replicaRead,
        });
      }

      const replicaIndexes = replica['GlobalSecondaryIndexes'];
      if (!Array.isArray(replicaIndexes)) continue;
      for (const entry of replicaIndexes) {
        const replicaIndex = asRecord(entry);
        const indexName = replicaIndex?.['IndexName'];
        if (!replicaIndex || typeof indexName !== 'string') continue;
        const indexRead = asRecord(
          asRecord(replicaIndex['ReadProvisionedThroughputSettings'])?.[
            'ReadCapacityAutoScalingSettings'
          ]
        );
        if (indexRead) {
          specs.push({
            dimension: 'dynamodb:index:ReadCapacityUnits',
            indexName,
            region,
            settings: indexRead,
          });
        }
      }
    }
  }

  return specs;
}

/**
 * How long `addReplica` waits out a same-named regional copy that is still
 * DELETING (issue #3569): polls x interval, ~15 minutes. A regional copy has
 * been measured to linger for minutes after it left the source table's
 * `Replicas[]`.
 */
export const REPLICA_COPY_RELEASE_POLLS = 180;

export const REPLICA_COPY_RELEASE_POLL_MS = 5000;

/**
 * How long DynamoDB refuses a second `DeletionProtectionEnabled` change on one
 * table after the first (measured 15000 ms, us-west-2, 2026-10-26), plus a
 * second of margin (go-to-k/cdkd#5355).
 */
export const DELETION_PROTECTION_REFLIP_MS = 16_000;

/**
 * Restates DynamoDB's encryption-change quota in the update's wraps, which
 * withhold AWS's text (go-to-k/cdkd#5399's integ). A table takes 4
 * encryption changes in a 24-hour window and then one every 6 hours
 * (`LimitExceededException`: "Encryption mode changes are limited in the 24h
 * window ...", measured us-east-1, 2026-10-28); reduced to the class name, the
 * refusal told the operator nothing. Returns a leading space plus the
 * sentence, or `''`.
 */
export function relayedEncryptionChangeLimit(withheldText: string): string {
  return /Encryption mode changes are limited/i.test(withheldText)
    ? ' AWS limits a table to 4 encryption changes in 24 hours, then one every 6 hours; ' +
        verboseAwareText(
          'retry the change later (--verbose shows when AWS allows the next one).',
          'retry the change later (the debug output shows when AWS allows the next one).'
        )
    : '';
}

/**
 * The Kinesis destination statuses a disable has not settled from
 * (go-to-k/cdkd#5399): the read-back's present set plus `DISABLING`.
 */
export const KINESIS_DISABLE_UNSETTLED: ReadonlySet<string> = new Set([
  'ACTIVE',
  'ENABLING',
  'UPDATING',
  'DISABLING',
]);

/**
 * {@link DynamoDBGlobalTableProvider.waitForReplicaProtectionSettled}'s cap:
 * 60 polls 5 s apart, five minutes against the ~30 s a replica's protection
 * change took to settle when measured (go-to-k/cdkd#5355).
 */
export const REPLICA_PROTECTION_SETTLE_POLLS = 60;

export const REPLICA_PROTECTION_SETTLE_POLL_MS = 5000;

/**
 * {@link DynamoDBGlobalTableProvider.retrySettlingRefusal}'s schedule: 8
 * attempts, 2 s doubling to a 30 s cap — about two minutes, the bound the
 * `AWS::DynamoDB::Table` provider's twin uses for the same refusals.
 */
export const SETTLING_RETRY_ATTEMPTS = 8;

export const SETTLING_RETRY_INITIAL_MS = 2000;

/** Replica-add attempts in total, the first included. */
export const REPLICA_COPY_RELEASE_ATTEMPTS = 3;

/**
 * AWS's refusal of a `ReplicaUpdates[].Create` whose region already holds a
 * table of that name. Keyed on the MESSAGE: the error class is a generic
 * `ValidationException`, shared with every other malformed replica request.
 */
export function isReplicaCopyExistsRefusal(error: unknown): boolean {
  return (
    error instanceof Error && /one or more replicas already existed as tables/i.test(error.message)
  );
}

/**
 * `Replicas` with every entry's `GlobalSecondaryIndexes` key REMOVED — the
 * replay-CREATE GSI omit arm's prune of the per-replica index blocks (issue
 * #1741, second instance), which name indexes that create does not build.
 *
 * Copy-on-write: an entry that carries the key is copied without it, every
 * other entry (a non-object included — an unresolved intrinsic must reach AWS
 * as-is, not be rewritten) is passed through by reference, and the caller's
 * array is never mutated. The caller's bag IS `previousState.properties` on
 * this path. A non-array container is returned untouched with `changed: false`.
 *
 * `withdrawnRegions` lists the `Region` of each entry whose block was a
 * non-empty ARRAY, i.e. one `toSdkReplicaGlobalSecondaryIndexes` would have
 * turned into a real override on the wire; a malformed or empty block was
 * never sendable, so withdrawing it is not a loss worth announcing.
 */
export function withdrawReplicaIndexBlocks(replicas: unknown): {
  replicas: unknown;
  changed: boolean;
  withdrawnRegions: string[];
} {
  if (!Array.isArray(replicas)) return { replicas, changed: false, withdrawnRegions: [] };
  let changed = false;
  const withdrawnRegions: string[] = [];
  const out = replicas.map((entry) => {
    const replica = asRecord(entry);
    if (!replica || !Object.prototype.hasOwnProperty.call(replica, 'GlobalSecondaryIndexes')) {
      return entry;
    }
    changed = true;
    const block = replica['GlobalSecondaryIndexes'];
    const region = replica['Region'];
    if (Array.isArray(block) && block.length > 0 && typeof region === 'string') {
      withdrawnRegions.push(region);
    }
    const copy = { ...replica };
    delete copy['GlobalSecondaryIndexes'];
    return copy;
  });
  return { replicas: changed ? out : replicas, changed, withdrawnRegions };
}

/** Computed-key spelling of the stream block, for the issue #1723 folds. */
export const STREAM_SPECIFICATION_KEY = 'StreamSpecification';

/**
 * The stream `create()` enables on a table whose template declares NONE, in
 * the CFn shape, when that is decidable from the bag alone (issue #1723) —
 * `undefined` otherwise.
 *
 * ONE helper for the three sites that must agree: `create()` records it,
 * `update()` records it (when the live table confirms it), and
 * `canonicalizeDesiredProperties` folds it into BOTH diff sides. Were any two to
 * key off different predicates, an unchanged template would redeploy forever.
 *
 * Fires only on the region-INDEPENDENT half of `create()`'s `needsStream`
 * (`replicas.length > 1`). The other half — a single replica in a region other
 * than the deploy region, or a single replica whose `Region` is still an
 * unresolved intrinsic — needs the deploy region, which the pure, synchronous
 * twin does not have; that half still auto-enables the stream and still records
 * nothing. That is harmless for drift (the walk visits only the top-level keys a
 * record HAS) and for the next diff: a later declaration of the same stream
 * diffs as an UPDATE, but `update()`'s live-stream gate sends nothing for it,
 * and the record then carries the declared stream. A table that DROPS to one
 * replica likewise loses the recorded stream from its record (a one-time diff
 * line beside its `Replicas` change) while AWS keeps the stream.
 *
 * Any `MultiRegionConsistency` at all disables it. The key is SDK-unwired
 * for this provider, so the three sites see different bags for one template:
 * `create()` / `update()` read the RAW bag (key present), while the twin reads
 * `DiffCalculator`'s bags, which on the SDK route (`--allow-unsupported-properties`)
 * have the key STRIPPED from both sides — there the twin folds BOTH sides
 * alike whatever `create()` recorded, so the diff stays NO_CHANGE. On the Cloud
 * Control route (the key's default) nothing is stripped and only the desired
 * side is folded, so the key must stop the fold there, for EVENTUAL as much as
 * for STRONG: whether Cloud Control ever holds a stream-less multi-replica
 * EVENTUAL table is not something the fold should rest on.
 *
 * Keyed on ABSENCE, not `== null`: an explicitly declared `StreamSpecification`
 * (even a malformed `null` / `''`) is the template's own statement, and folding
 * a declared value would silence the diff that reports it.
 */
export function replicationImpliedStreamSpecification(
  properties: Record<string, unknown>
): { StreamViewType: 'NEW_AND_OLD_IMAGES' } | undefined {
  if (properties[STREAM_SPECIFICATION_KEY] !== undefined) return undefined;
  // See the JSDoc: any declared consistency mode leaves the bag unfolded.
  if (properties['MultiRegionConsistency'] !== undefined) return undefined;
  const replicas = properties['Replicas'];
  if (!Array.isArray(replicas) || replicas.length <= 1) return undefined;
  return { StreamViewType: 'NEW_AND_OLD_IMAGES' };
}

/**
 * Every attribute name some KEY SCHEMA in the desired template references:
 * the table's own `KeySchema`, each GSI's, and each LSI's. This is the set
 * the `AttributeDefinitions`-removal guard in `update()` tests membership
 * against — a removed attribute still in this set is a genuine
 * redefine-in-place (replacement required); one outside it is the normal
 * bookkeeping of a GSI deletion and must NOT force a replacement.
 *
 * Malformed / intrinsic-valued entries contribute nothing. For the `update()`
 * guard that errs on the PERMISSIVE side — correct there, because that guard's
 * failure mode is a forced replacement of a live table, and AWS still rejects a
 * genuinely-bad `UpdateTable` loudly. For the create-path prune below it errs
 * the other way (an unreadable LSI key schema prunes MORE), which is only
 * reachable on a bag AWS would reject anyway.
 *
 * `options.indexListKeys` narrows which index lists contribute, for the ONE
 * caller whose question is not "what does the template reference" but "what
 * will this call actually key on" — `create()`'s replay-CREATE GSI omit arm
 * (issue #1741), which sends NO indexes and therefore must not count the
 * omitted block's key attributes as still-referenced. It defaults to BOTH
 * lists, so the `update()` guard above reads exactly as it did before.
 */
export function collectDesiredKeyAttributeNames(
  properties: Record<string, unknown>,
  options?: { indexListKeys?: readonly ('GlobalSecondaryIndexes' | 'LocalSecondaryIndexes')[] }
): Set<string> {
  const names = new Set<string>();
  const addKeySchema = (value: unknown): void => {
    if (!Array.isArray(value)) return;
    for (const element of value) {
      const name = asRecord(element)?.['AttributeName'];
      if (typeof name === 'string') names.add(name);
    }
  };
  addKeySchema(properties['KeySchema']);
  const indexListKeys = options?.indexListKeys ?? [
    'GlobalSecondaryIndexes',
    'LocalSecondaryIndexes',
  ];
  for (const indexListKey of indexListKeys) {
    const indexes = properties[indexListKey];
    if (!Array.isArray(indexes)) continue;
    for (const index of indexes) {
      addKeySchema(asRecord(index)?.['KeySchema']);
    }
  }
  // go-to-k/cdkd#2762: a vector index's `SearchSchema` keys on a defined
  // attribute too, and no caller's narrowing omits the vector indexes.
  const vectorIndexes = properties['VectorIndexes'];
  if (Array.isArray(vectorIndexes)) {
    for (const index of vectorIndexes) addKeySchema(asRecord(index)?.['SearchSchema']);
  }
  return names;
}

/** Narrow an unknown CFn sub-object to a record (or `undefined`). */
export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
