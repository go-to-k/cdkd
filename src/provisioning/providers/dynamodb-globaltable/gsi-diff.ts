import { isDeepStrictEqual } from 'node:util';
import type {
  GlobalSecondaryIndex,
  GlobalSecondaryIndexDescription,
  ReplicaGlobalSecondaryIndex,
} from '@aws-sdk/client-dynamodb';
import { coerceCfnInteger } from '../../config-shape.js';
import { toFiniteNumber } from '../../dynamodb-warm-throughput.js';
import type { MaskerFn } from '../../masked-retry-logger.js';
import { TABLE_READ_ON_DEMAND_KEY } from './replica-shape.js';
import { asRecord } from './capacity.js';
import {
  mergeExplicitThroughputBlock,
  reportUnresolvedRawMember,
  reportUnresolvedProvisionedCapacity,
  deriveWriteCapacityUnits,
  deriveReadCapacityUnits,
  type ThroughputDiagnostic,
} from './throughput.js';
import { isUnresolvedIntrinsicBlock } from './gsi.js';

/**
 * Names of the GSIs whose PROVISIONED capacity must NOT be compared against
 * the live table (issue #1571). Two disjoint reasons, and both are about the
 * DESIRED side being a number the template did not actually choose:
 *
 * - **auto-scaled** — the live number is owned by Application Auto Scaling
 *   while the translation takes `MinCapacity` (see {@link CapacitySource}), so
 *   a live 10 against a template min of 1 reads as a scale-down NOBODY ASKED
 *   FOR. This was one of the three measured failure modes of the first
 *   value-carrying baseline (#1551), and the only one that cannot be resolved
 *   by reading the live side more carefully — both numbers are correct, they
 *   answer different questions.
 * - **not template-determined** — no capacity resolves to a finite number, so
 *   `toSdkGlobalSecondaryIndexes` substitutes `DEFAULT_CAPACITY_UNITS` (5/5,
 *   the issue #1511 class). Comparing that invented default against the live
 *   value turns it into a WRITE. Found by review, not by the first cut.
 *
 * Walks the same two sources as {@link toSdkGlobalSecondaryIndexes} and
 * {@link collectRawOnDemandDeclarations} — the LOCAL replica's index entry
 * first (the canonical CDK spelling), the GSI-level block as the
 * hand-authored fallback for read, the top-level GSI for write. A divergence
 * between the three is what would re-open the bug, so they are kept adjacent.
 *
 * The auto-scaling arm tests PRESENCE of the `*CapacityAutoScalingSettings`
 * key, not whether its members coerce: a block that is itself an unresolved
 * intrinsic still means "this index is autoscaled", and "might be" must read
 * as "is" — a false negative issues an unrequested scale-down.
 *
 * KNOWN BOUND: detection is TEMPLATE-side only. An index autoscaled OUT OF
 * BAND (no `*CapacityAutoScalingSettings` in the template) has a
 * template-determined capacity, so its live value IS compared and the recovery
 * deploy re-asserts the template's number — which is what a clean previous
 * side would also have done, so this matches ordinary cdkd semantics rather
 * than being a recovery-path defect.
 *
 * And the cost of a false positive is a PERMANENT divergence, not "one deploy
 * of lag": the deploy records the template value as state, so the next diff
 * sees previous == desired and never revisits it. That is the same self-heal
 * fallacy this PR corrects in the live-only warning; it is accepted here
 * because the alternative is writing a number the user never asked for.
 */
export function collectUncomparableCapacityGsiNames(
  properties: Record<string, unknown>,
  region: string
): Set<string> {
  const out = new Set<string>();
  const rawIndexes = properties['GlobalSecondaryIndexes'];
  if (!Array.isArray(rawIndexes)) return out;

  const replicas = properties['Replicas'];
  const localReplica = Array.isArray(replicas)
    ? replicas.find((r) => asRecord(r)?.['Region'] === region)
    : undefined;
  const localReplicaIndexes = asRecord(localReplica)?.['GlobalSecondaryIndexes'];
  const localByName = new Map<string, Record<string, unknown>>();
  if (Array.isArray(localReplicaIndexes)) {
    for (const entry of localReplicaIndexes) {
      const record = asRecord(entry);
      const name = record?.['IndexName'];
      if (record && typeof name === 'string') localByName.set(name, record);
    }
  }

  for (const entry of rawIndexes) {
    const gsi = asRecord(entry);
    const name = gsi?.['IndexName'];
    if (!gsi || typeof name !== 'string') continue;
    const localEntry = localByName.get(name);
    const readBlocks = [
      localEntry?.['ReadProvisionedThroughputSettings'],
      gsi['ReadProvisionedThroughputSettings'],
    ];
    // (a) AUTO-SCALED. A block that is ITSELF an unresolved intrinsic counts
    // too: nothing can see inside it, and the two readings are not symmetric.
    const writeBlock = gsi['WriteProvisionedThroughputSettings'];
    const autoScaled =
      readBlocks.some(
        (block) =>
          asRecord(block)?.['ReadCapacityAutoScalingSettings'] !== undefined ||
          isUnresolvedIntrinsicBlock(block)
      ) ||
      asRecord(writeBlock)?.['WriteCapacityAutoScalingSettings'] !== undefined ||
      isUnresolvedIntrinsicBlock(writeBlock);
    if (autoScaled) {
      out.add(name);
      continue;
    }
    // (b) NOT TEMPLATE-DETERMINED. This is the arm a review caught, and it is
    // the destructive one: `toSdkGlobalSecondaryIndexes` runs every capacity
    // through `coerceCfnInteger` and falls through to `DEFAULT_CAPACITY_UNITS`
    // (5/5) when nothing resolves — the issue #1511 class. Outside this
    // recovery path both sides derive the same 5/5, so the invented default
    // never reaches AWS. With a live baseline it becomes a WRITE: live 25/25
    // versus a desired 5/5 reads as an edit and cdkd scales the table DOWN to
    // a number the template never contained. So the test is not "did the
    // template mention auto-scaling" but "did the template DETERMINE both
    // numbers" — mirroring `deriveRead/WriteCapacityUnits` returning
    // `undefined`, with the explicit SDK-shaped block counted because the
    // translation merges it over the derived side — read through the merge's
    // OWN reader (`coerceCfnInteger`, issue #3135): a padded `" 7 "` the
    // merge drops must count as NOT determined here, or the 5/5 fallback the
    // translation sends reads as a scale-down against the live baseline.
    const explicitProvisioned = asRecord(gsi['ProvisionedThroughput']);
    const derivedRead =
      coerceCfnInteger(explicitProvisioned?.['ReadCapacityUnits']) ??
      deriveReadCapacityUnits(asRecord(readBlocks[0])) ??
      deriveReadCapacityUnits(asRecord(readBlocks[1]));
    const derivedWrite =
      coerceCfnInteger(explicitProvisioned?.['WriteCapacityUnits']) ??
      deriveWriteCapacityUnits(asRecord(writeBlock));
    if (derivedRead === undefined || derivedWrite === undefined) out.add(name);
  }
  return out;
}

/** Inputs {@link buildLiveRecoveryGsiBaseline} needs beyond the two index lists. */
export interface LiveRecoveryBaselineOptions {
  /**
   * `false` keeps the baseline IDENTITY-ONLY (every carried entry is a
   * byte-copy of its desired counterpart, so only ADDs can come out of the
   * diff). Set by the caller whenever a BillingMode flip is in play or the
   * live mode disagrees with the desired one — across two billing modes every
   * index differs BY CONSTRUCTION, so a value comparison there measures the
   * translation, not the user's edit.
   */
  readonly carryLiveValues: boolean;
  /** The table's LIVE billing mode (`BillingModeSummary`, absent = PROVISIONED). */
  readonly liveBillingMode: string;
  /**
   * Result of {@link collectUncomparableCapacityGsiNames} for the DESIRED
   * template. Scoped to PROVISIONED capacity ONLY — an on-demand ceiling is
   * a literal the template either carries or does not, so auto-scaling has no
   * bearing on it and suppressing the whole entry would take the issue #1160
   * `-1` reset down with it (review catch).
   */
  readonly uncomparableCapacityIndexNames: ReadonlySet<string>;
}

/**
 * Build the GSI diff baseline used when the cdkd STATE record's
 * `GlobalSecondaryIndexes` is present-but-unusable (issue #1571, closing the
 * residual #1551 / PR #1562 measured and deliberately left open).
 *
 * The entries are the DESIRED indexes filtered to the names that EXIST live —
 * the live table is the only side that can answer "does this index exist",
 * which is what stops the permanent index loss #1562 was about. What #1562
 * could not settle was the VALUES: it copied the desired entry verbatim, so
 * the diff could only ever produce ADDs and every capacity / ceiling edit
 * silently lagged one deploy.
 *
 * This carries live VALUES, but only the ones that are safe to compare, and
 * the exclusions are the three measured failure modes of the first attempt
 * (recorded at the `liveIndexNames` call site) rather than a guess:
 *
 *  - **`ProvisionedThroughput` is gated on the LIVE billing mode.**
 *    `DescribeTable` reports `{ReadCapacityUnits: 0, WriteCapacityUnits: 0}`
 *    for every index of a PAY_PER_REQUEST table, so an ungated read produced a
 *    "modified" on every index and re-sent `{0, 0}`, which AWS rejects.
 *  - **An AUTOSCALED index keeps identity-only capacity.** The live number
 *    belongs to Application Auto Scaling; the desired side is `MinCapacity`.
 *    Comparing them reads as a scale-down the user never asked for.
 *  - **`KeySchema` / `Projection` / `WarmThroughput` are always the desired
 *    side.** All three are copied from `desired`, so they can never DIFFER —
 *    deliberately. `KeySchema` and `Projection` are immutable on an existing
 *    index (a difference produces only a "recreate the index" warning, and
 *    AWS's `Projection.NonKeyAttributes` READBACK ORDER is not guaranteed, so
 *    the comparison would be a coin flip); `WarmThroughput` reads back with a
 *    `Status` member the translated shape does not carry, and DynamoDB warm
 *    throughput is increase-only, so a manufactured difference is a real
 *    AWS-side risk.
 *
 * `OnDemandThroughput` IS carried from live on an on-demand table, and that is
 * the second thing this fixes: the `modified` loop derives the `-1` ceiling
 * RESET (the #1160 absent-field-removal class) from the PREVIOUS side, so with
 * a desired-copy baseline a template that dropped `MaxReadRequestUnits` left
 * the old ceiling live in AWS forever while cdkd reported success.
 *
 * REMOVES are still not derivable here and are deliberately absent: an index
 * live but not in the template is in NEITHER side, so no `Delete` is issued.
 * A junk state record cannot distinguish "cdkd created this and the template
 * dropped it" from "somebody added it out of band", the delete is irreversible
 * and a re-create costs a full backfill. The caller names the live-only
 * indexes and points at the remedy.
 */
export function buildLiveRecoveryGsiBaseline(
  desiredSdkIndexes: readonly GlobalSecondaryIndex[],
  liveIndexes: readonly GlobalSecondaryIndexDescription[] | undefined,
  options: LiveRecoveryBaselineOptions
): GlobalSecondaryIndex[] {
  const liveByName = new Map<string, GlobalSecondaryIndexDescription>();
  for (const live of liveIndexes ?? []) {
    if (typeof live.IndexName === 'string') liveByName.set(live.IndexName, live);
  }

  const baseline: GlobalSecondaryIndex[] = [];
  for (const desired of desiredSdkIndexes) {
    if (typeof desired.IndexName !== 'string') continue;
    const live = liveByName.get(desired.IndexName);
    if (!live) continue;
    // Spread FIRST so every member not overridden below is the desired
    // side's own value, and so compares equal to its translated counterpart.
    const entry: GlobalSecondaryIndex = { ...desired };
    if (!options.carryLiveValues) {
      baseline.push(entry);
      continue;
    }
    if (options.liveBillingMode === 'PROVISIONED') {
      // The capacity exclusion lives HERE, not above the mode branch: it is
      // about PROVISIONED capacity only, and short-circuiting the whole entry
      // suppressed the on-demand `-1` reset for an on-demand table whose
      // template still carried a leftover auto-scaling block.
      if (options.uncomparableCapacityIndexNames.has(desired.IndexName)) {
        baseline.push(entry);
        continue;
      }
      // Introduce the member only when the desired side HAS it. A baseline
      // carrying a block the desired side lacks reads as "the template removed
      // provisioned capacity", which on a provisioned table is not a thing the
      // user can express — the `modified` loop would then find no throughput
      // field to send and print the misleading "recreate the index" warning.
      const liveRead = toFiniteNumber(live.ProvisionedThroughput?.ReadCapacityUnits);
      const liveWrite = toFiniteNumber(live.ProvisionedThroughput?.WriteCapacityUnits);
      if (desired.ProvisionedThroughput && liveRead !== undefined && liveWrite !== undefined) {
        entry.ProvisionedThroughput = {
          ReadCapacityUnits: liveRead,
          WriteCapacityUnits: liveWrite,
        };
      }
    } else {
      // On-demand: the live ceilings ARE the previous side, including their
      // ABSENCE. Deleting the key when AWS reports no ceiling is load-bearing
      // in the other direction — a desired-side ceiling then reads as a
      // first-time SET and is applied, instead of being swallowed as "equal".
      const liveRead = toFiniteNumber(live.OnDemandThroughput?.MaxReadRequestUnits);
      const liveWrite = toFiniteNumber(live.OnDemandThroughput?.MaxWriteRequestUnits);
      if (liveRead === undefined && liveWrite === undefined) {
        delete entry.OnDemandThroughput;
      } else {
        entry.OnDemandThroughput = {
          ...(liveRead !== undefined && { MaxReadRequestUnits: liveRead }),
          ...(liveWrite !== undefined && { MaxWriteRequestUnits: liveWrite }),
        };
      }
    }
    baseline.push(entry);
  }
  return baseline;
}

/**
 * Translate a CFn `Replicas[].GlobalSecondaryIndexes[]` blob (the
 * `ReplicaGlobalSecondaryIndexSpecification` shape) into the SDK's
 * `ReplicaGlobalSecondaryIndex[]` used by `CreateReplicationGroupMemberAction`
 * / `UpdateReplicationGroupMemberAction` (Issue #1387).
 *
 * Verified mapping:
 *
 * | CFn                                                        | SDK                                            |
 * | ---------------------------------------------------------- | ---------------------------------------------- |
 * | `ReadProvisionedThroughputSettings.ReadCapacityUnits`      | `ProvisionedThroughputOverride.ReadCapacityUnits` |
 * | `ReadOnDemandThroughputSettings.MaxReadRequestUnits`       | `OnDemandThroughputOverride.MaxReadRequestUnits`  |
 *
 * `ContributorInsightsSpecification` is not mapped HERE: the replica-GSI SDK
 * shape has no member for it. It goes out as a separate
 * `UpdateContributorInsights(TableName, IndexName)` call in the replica's own
 * region (`planReplicaIndexInsightsOps`, go-to-k/cdkd#5489).
 */
export function toSdkReplicaGlobalSecondaryIndexes(
  replicaIndexes: unknown,
  billingMode: string,
  diagnostics?: ThroughputDiagnostic[],
  // See `mergeExplicitThroughputBlock` for why the mask goes INSIDE the
  // stringify rather than around the finished message (issue #2178).
  maskSecrets: MaskerFn = (text) => text
): ReplicaGlobalSecondaryIndex[] | undefined {
  if (!Array.isArray(replicaIndexes) || replicaIndexes.length === 0) return undefined;
  const translated = replicaIndexes.map((entry) => {
    const cfn = asRecord(entry);
    if (!cfn) return entry as ReplicaGlobalSecondaryIndex;
    const indexName = cfn['IndexName'] as string | undefined;
    const sdk: ReplicaGlobalSecondaryIndex = { IndexName: indexName };
    const overrides = toSdkReplicaThroughputOverrides(
      cfn,
      billingMode,
      diagnostics,
      { ...(typeof indexName === 'string' && { indexName }) },
      maskSecrets
    );
    if (overrides.ProvisionedThroughputOverride) {
      sdk.ProvisionedThroughputOverride = overrides.ProvisionedThroughputOverride;
    }
    if (overrides.OnDemandThroughputOverride) {
      sdk.OnDemandThroughputOverride = overrides.OnDemandThroughputOverride;
    }
    return sdk;
  });
  // go-to-k/cdkd#5489: an entry that carries no override has nothing to send.
  // The usual case is a replica index that declares only its
  // ContributorInsightsSpecification, which goes out as UpdateContributorInsights
  // instead. AWS refuses an `Update` holding only such entries ("There are no
  // actions specified in the Replica Update Action of the request", measured
  // on the dynamodb-globaltable-replica-settings integ). A non-object entry
  // (an unresolved intrinsic) is kept, so AWS still rejects it as before.
  const sendable = translated.filter(
    (sdk) =>
      asRecord(sdk) === undefined ||
      sdk.ProvisionedThroughputOverride !== undefined ||
      sdk.OnDemandThroughputOverride !== undefined
  );
  return sendable.length > 0 ? sendable : undefined;
}

/**
 * The `{Provisioned,OnDemand}ThroughputOverride` pair for ONE replica-scoped
 * CFn block — shared by the per-GSI replica entries and, since issue #1436,
 * by the replica's own TABLE-level entry, which carries the very same two CFn
 * spellings (`ReadProvisionedThroughputSettings` /
 * `ReadOnDemandThroughputSettings`) and maps to the very same two SDK members
 * on `{Create,Update}ReplicationGroupMemberAction`. One helper so the two
 * levels cannot disagree about the mapping.
 *
 * Same #1428 treatment as the GSI-level blocks: coerce, merge an explicit
 * SDK-shaped override PER MEMBER over the derived value, and gate on billing
 * mode. Both override members are READ-side only — a replica has no
 * independent write capacity, since writes replicate from the source table.
 */
export function toSdkReplicaThroughputOverrides(
  cfn: Record<string, unknown>,
  billingMode: string,
  diagnostics: ThroughputDiagnostic[] | undefined,
  context: { indexName?: string },
  // See `mergeExplicitThroughputBlock` for why the mask goes INSIDE the
  // stringify rather than around the finished message (issue #2178).
  maskSecrets: MaskerFn = (text) => text
): {
  ProvisionedThroughputOverride?: { ReadCapacityUnits: number };
  OnDemandThroughputOverride?: { MaxReadRequestUnits: number };
} {
  const explicitProvisioned = asRecord(cfn['ProvisionedThroughputOverride']);
  const explicitOnDemand = asRecord(cfn['OnDemandThroughputOverride']);
  if (explicitProvisioned && billingMode !== 'PROVISIONED') {
    diagnostics?.push({
      kind: 'billing-mode-mismatch',
      ...context,
      member: 'ProvisionedThroughputOverride',
      message:
        `an explicit ProvisionedThroughputOverride was dropped because the table's ` +
        `BillingMode is ${billingMode}; AWS rejects provisioned capacity on an ` +
        `on-demand table.`,
    });
  }
  if (explicitOnDemand && billingMode === 'PROVISIONED') {
    diagnostics?.push({
      kind: 'billing-mode-mismatch',
      ...context,
      member: 'OnDemandThroughputOverride',
      message:
        `an explicit OnDemandThroughputOverride was dropped because the table's ` +
        `BillingMode is PROVISIONED; AWS rejects on-demand ceilings on a ` +
        `provisioned table.`,
    });
  }

  if (billingMode === 'PROVISIONED') {
    const rawRead = cfn['ReadProvisionedThroughputSettings'];
    const readCapacity = deriveReadCapacityUnits(asRecord(rawRead));
    // The one PROVISIONED site that CAN suppress: an absent
    // `ProvisionedThroughputOverride` means "inherit the source table", so an
    // unreadable value here silently keeps the inherited capacity rather than
    // defaulting to 5 (issue #1511).
    if (
      readCapacity === undefined &&
      coerceCfnInteger(explicitProvisioned?.['ReadCapacityUnits']) === undefined
    ) {
      reportUnresolvedProvisionedCapacity(
        rawRead,
        'Read',
        'min',
        {
          suppressed:
            `so no ProvisionedThroughputOverride was sent and the replica keeps the ` +
            `source table's read capacity`,
        },
        diagnostics,
        { ...context, blockName: 'ReadProvisionedThroughputSettings' },
        maskSecrets
      );
    }
    const merged = mergeExplicitThroughputBlock<{ ReadCapacityUnits: number }>(
      explicitProvisioned,
      readCapacity !== undefined ? { ReadCapacityUnits: readCapacity } : undefined,
      ['ReadCapacityUnits'],
      diagnostics,
      { ...context, blockName: 'ProvisionedThroughputOverride' },
      maskSecrets
    );
    return merged ? { ProvisionedThroughputOverride: merged } : {};
  }

  const rawMaxRead = asRecord(cfn['ReadOnDemandThroughputSettings'])?.['MaxReadRequestUnits'];
  reportUnresolvedRawMember(
    rawMaxRead,
    diagnostics,
    {
      ...context,
      blockName: 'ReadOnDemandThroughputSettings',
      member: 'MaxReadRequestUnits',
    },
    maskSecrets
  );
  const maxReadRequestUnits = coerceCfnInteger(rawMaxRead);
  const merged = mergeExplicitThroughputBlock<{ MaxReadRequestUnits: number }>(
    explicitOnDemand,
    maxReadRequestUnits !== undefined ? { MaxReadRequestUnits: maxReadRequestUnits } : undefined,
    ['MaxReadRequestUnits'],
    diagnostics,
    { ...context, blockName: 'OnDemandThroughputOverride' },
    maskSecrets
  );
  return merged ? { OnDemandThroughputOverride: merged } : {};
}

/** One CFn on-demand ceiling as the template states it, before coercion. */
export interface RawCeiling {
  /**
   * The CFn key is PRESENT (or its containing block is an unresolved
   * intrinsic). Distinguishing this from "coerced to a number" is what
   * separates a template REMOVAL — which must reset the live ceiling — from a
   * template that declared a value cdkd could not read, which must leave AWS
   * alone rather than clear it.
   */
  readonly declared: boolean;
  /** The coerced value, or `undefined` when absent OR present-but-unparseable. */
  readonly value: number | undefined;
}

/**
 * The TABLE-level on-demand ceilings, gathered from the two DIFFERENT places
 * the CFn `AWS::DynamoDB::GlobalTable` shape puts them (issue #1436).
 *
 * The write ceiling is top-level `WriteOnDemandThroughputSettings`, but the
 * READ ceiling lives on the LOCAL REPLICA as `ReadOnDemandThroughputSettings`
 * — the same write-here / read-on-the-replica split #1387 established one
 * level down for a GSI. The provider read only the write half, so the plain
 * CDK spelling
 *
 *     billing: Billing.onDemand({ maxReadRequestUnits: 100, maxWriteRequestUnits: 200 })
 *
 * deployed a table with NO read ceiling and reported success. That is a
 * drop on the way IN, not the absent-field-reset class of #1423 / #1434.
 *
 * The registry schema (`cloudformation:DescribeType`, 2026-08-09) confirms the
 * member on `ReplicaSpecification`:
 * `ReadOnDemandThroughputSettings: { MaxReadRequestUnits: integer, minimum 1 }`.
 */
export function collectTableOnDemandCeilings(
  properties: Record<string, unknown>,
  region: string,
  diagnostics?: ThroughputDiagnostic[],
  // See `mergeExplicitThroughputBlock` for why the mask goes INSIDE the
  // stringify rather than around the finished message (issue #2178).
  maskSecrets: MaskerFn = (text) => text
): { read: RawCeiling; write: RawCeiling } {
  const writeBlock = properties['WriteOnDemandThroughputSettings'];
  const replicas = properties['Replicas'];
  const localReplica = Array.isArray(replicas)
    ? replicas.find((r) => asRecord(r)?.['Region'] === region)
    : undefined;
  // go-to-k/cdkd#2762: the table-level block takes the replica's place on a
  // table with settings replication ENABLED (CloudFormation refuses both at once).
  const replicaReadBlock = asRecord(localReplica)?.['ReadOnDemandThroughputSettings'];
  const readBlock = replicaReadBlock ?? properties[TABLE_READ_ON_DEMAND_KEY];
  const rawRead = asRecord(readBlock)?.['MaxReadRequestUnits'];
  const rawWrite = asRecord(writeBlock)?.['MaxWriteRequestUnits'];
  reportUnresolvedRawMember(
    rawRead,
    diagnostics,
    {
      blockName:
        replicaReadBlock !== undefined
          ? 'Replicas[local].ReadOnDemandThroughputSettings'
          : TABLE_READ_ON_DEMAND_KEY,
      member: 'MaxReadRequestUnits',
    },
    maskSecrets
  );
  reportUnresolvedRawMember(
    rawWrite,
    diagnostics,
    { blockName: 'WriteOnDemandThroughputSettings', member: 'MaxWriteRequestUnits' },
    maskSecrets
  );
  return {
    read: {
      declared: rawRead !== undefined || isUnresolvedIntrinsicBlock(readBlock),
      value: coerceCfnInteger(rawRead),
    },
    write: {
      declared: rawWrite !== undefined || isUnresolvedIntrinsicBlock(writeBlock),
      value: coerceCfnInteger(rawWrite),
    },
  };
}

/**
 * Diff CFn `Replicas[]` arrays. Keyed by `Region`. Returns adds, removes,
 * and modifies (entries whose other keys — SSESpecification,
 * GlobalSecondaryIndexes, TableClass, ... — differ from the old shape).
 */
export function diffReplicas(
  oldReplicas: Array<Record<string, unknown>>,
  newReplicas: Array<Record<string, unknown>>
): {
  added: Array<Record<string, unknown>>;
  removed: Array<Record<string, unknown>>;
  modified: Array<Record<string, unknown>>;
} {
  const oldByRegion = new Map<string, Record<string, unknown>>();
  const newByRegion = new Map<string, Record<string, unknown>>();
  for (const r of oldReplicas) {
    const region = r['Region'] as string | undefined;
    if (region) oldByRegion.set(region, r);
  }
  for (const r of newReplicas) {
    const region = r['Region'] as string | undefined;
    if (region) newByRegion.set(region, r);
  }

  const added: Array<Record<string, unknown>> = [];
  const removed: Array<Record<string, unknown>> = [];
  const modified: Array<Record<string, unknown>> = [];

  for (const [region, replica] of newByRegion) {
    if (!oldByRegion.has(region)) {
      added.push(replica);
    } else if (!deepEqual(oldByRegion.get(region), replica)) {
      modified.push(replica);
    }
  }
  for (const [region, replica] of oldByRegion) {
    if (!newByRegion.has(region)) {
      removed.push(replica);
    }
  }
  return { added, removed, modified };
}

/**
 * Diff CFn `GlobalSecondaryIndexes[]` arrays. Keyed by `IndexName`.
 * Modified = same IndexName but other fields (ProvisionedThroughput /
 * OnDemandThroughput) differ. KeySchema / Projection changes count as
 * "modified" too — AWS rejects those via UpdateGSI, but the diff caller
 * surfaces the AWS-side error rather than this helper second-guessing.
 */
export function diffGlobalSecondaryIndexes(
  oldGsi: GlobalSecondaryIndex[],
  newGsi: GlobalSecondaryIndex[]
): {
  added: GlobalSecondaryIndex[];
  removed: GlobalSecondaryIndex[];
  modified: GlobalSecondaryIndex[];
} {
  const oldByName = new Map<string, GlobalSecondaryIndex>();
  const newByName = new Map<string, GlobalSecondaryIndex>();
  for (const g of oldGsi) {
    if (g.IndexName) oldByName.set(g.IndexName, g);
  }
  for (const g of newGsi) {
    if (g.IndexName) newByName.set(g.IndexName, g);
  }
  const added: GlobalSecondaryIndex[] = [];
  const removed: GlobalSecondaryIndex[] = [];
  const modified: GlobalSecondaryIndex[] = [];
  for (const [name, gsi] of newByName) {
    if (!oldByName.has(name)) added.push(gsi);
    else if (!deepEqual(oldByName.get(name), gsi)) modified.push(gsi);
  }
  for (const [name, gsi] of oldByName) {
    if (!newByName.has(name)) removed.push(gsi);
  }
  return { added, removed, modified };
}

/**
 * Structural equality over the JSON form, ignoring object key order. Order is
 * not stable across the two sides: `aws-cdk-lib` renders a GSI `Projection` as
 * `{NonKeyAttributes, ProjectionType}` while an SDK readback is
 * `{ProjectionType, NonKeyAttributes}`. The JSON round-trip drops `undefined`
 * members and prototypes (`isDeepStrictEqual` checks both); array order stays
 * significant.
 */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  const asJson = (v: unknown): unknown => JSON.parse(JSON.stringify(v));
  try {
    return isDeepStrictEqual(asJson(a), asJson(b));
  } catch {
    return false;
  }
}

/**
 * A `LocalSecondaryIndexes` value for the immutability guard: absent, `null`
 * and `[]` all declare no index (go-to-k/cdkd#5489).
 */
export function lsiListOrEmpty(value: unknown): unknown {
  if (value === undefined || value === null) return [];
  return value;
}
