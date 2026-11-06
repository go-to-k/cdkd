import { refuseMalformedDesiredTags, type CfnTagEntry } from '../../tag-list.js';
import { coerceCfnBoolean, configBooleanRefusal } from '../../config-shape.js';
import { replicaSettingRefusals } from '../../dynamodb-replica-settings.js';
import { asRecord } from './capacity.js';
import { deepEqual } from './gsi-diff.js';

// ─── Pure-functional diff helpers (exported for testing) ───────────────

/**
 * Refuse a malformed desired `Replicas[].Tags` (go-to-k/cdkd#3994) before any
 * call, naming the replica by index and never its content. The type has no
 * top-level `Tags`; each replica's list is a CloudFormation `[{ Key, Value }]`
 * bag. Returns each replica entry's well-formed list, keyed by the entry. A
 * `Replicas` that is not a list, or an entry that is not an object, is left to
 * the readers that own it.
 */
export function refuseMalformedReplicaTags(
  properties: Record<string, unknown>,
  resourceType: string,
  logicalId: string,
  physicalId?: string
): Map<Record<string, unknown>, CfnTagEntry[]> {
  const tagsByReplica = new Map<Record<string, unknown>, CfnTagEntry[]>();
  const replicas = properties['Replicas'];
  if (!Array.isArray(replicas)) return tagsByReplica;
  replicas.forEach((entry: unknown, index) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return;
    const replica = entry as Record<string, unknown>;
    tagsByReplica.set(
      replica,
      refuseMalformedDesiredTags(
        replica['Tags'],
        resourceType,
        logicalId,
        physicalId,
        `Replicas[${index}].Tags`
      )
    );
  });
  return tagsByReplica;
}

export const DISASSOCIATION_PROTECTION_KEY = 'DisassociationProtectionEnabled';

/**
 * The refusals of a declared `Replicas[].DisassociationProtectionEnabled`
 * (go-to-k/cdkd#5570), as one message, or `undefined` when there is none:
 *
 * - a value that is not a boolean (a CFn string `'true'` / `'false'` counts
 *   as a boolean). Never read as either value: `false` would let the replica
 *   be detached from the global table, and `true` would undo a disable
 *   nobody can read.
 * - a `false` on a table whose desired `Replicas` names a single Region,
 *   when it is new or changed. DynamoDB applies the member only to a replica
 *   of a multi-Region (MREC) global table: on a table with no other replica
 *   the solo `UpdateTable {DisassociationProtectionEnabled: false}` answered
 *   `InternalFailure` (HTTP 500) on every retry (integ, us-east-1,
 *   2026-10-30), so the disable the template asks for cannot be delivered. A
 *   `true` is not refused: it is the AWS default, a single-Region table has
 *   no global table to be detached from, so skipping it weakens nothing, and
 *   CloudFormation accepts the template. Nor is an unchanged `false` — a
 *   table that drops to one replica and keeps its declaration. The pass
 *   skips both ({@link isMultiRegionReplicaSet}).
 */
export function disassociationProtectionRefusal(
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown> | undefined,
  logicalId: string
): string | undefined {
  const replicas = properties['Replicas'];
  if (!Array.isArray(replicas)) return undefined;
  const malformed: string[] = [];
  const singleRegion: string[] = [];
  const multiRegion = isMultiRegionReplicaSet(properties);
  replicas.forEach((entry: unknown, index) => {
    const replica = asRecord(entry);
    if (replica === undefined) return;
    const refusal = configBooleanRefusal(
      replica,
      DISASSOCIATION_PROTECTION_KEY,
      `Replicas[${index}]`
    );
    if (refusal !== undefined) {
      malformed.push(refusal);
      return;
    }
    const declared = readReplicaDisassociationProtection(replica);
    if (declared === undefined || multiRegion) return;
    const region = replica['Region'];
    const previous =
      previousProperties === undefined || typeof region !== 'string'
        ? undefined
        : readReplicaDisassociationProtection(localReplicaEntry(previousProperties, region));
    if (declared === false && declared !== previous)
      singleRegion.push(`Replicas[${index}].${DISASSOCIATION_PROTECTION_KEY}`);
  });
  const parts: string[] = [];
  if (malformed.length > 0) {
    parts.push(
      `${malformed.join('; ')}. That replica's disassociation protection is left as it is.`
    );
  }
  if (singleRegion.length > 0) {
    parts.push(
      `${singleRegion.join(', ')} is applied by DynamoDB only to a replica of a multi-Region ` +
        "(MREC) global table, and this table's Replicas name a single Region, so cdkd does not send it. " +
        `Remove ${DISASSOCIATION_PROTECTION_KEY}, or add a replica in another Region.`
    );
  }
  if (parts.length === 0) return undefined;
  return `AWS::DynamoDB::GlobalTable ${logicalId}: ${parts.join(' ')}`;
}

/**
 * Whether a GlobalTable's desired `Replicas` names more than one Region — a
 * multi-Region global table, the only kind DynamoDB applies
 * `DisassociationProtectionEnabled` to (go-to-k/cdkd#5570). The protection
 * pass runs after every replica change has settled, so an update that adds
 * the second Region in the same deploy qualifies.
 */
export function isMultiRegionReplicaSet(properties: Record<string, unknown>): boolean {
  const replicas = properties['Replicas'];
  if (!Array.isArray(replicas)) return false;
  const regions = new Set<string>();
  for (const entry of replicas) {
    const region = asRecord(entry)?.['Region'];
    if (typeof region === 'string' && region !== '') regions.add(region);
  }
  return regions.size > 1;
}

/**
 * A replica's declared `DisassociationProtectionEnabled`: the boolean (a CFn
 * string included), or `undefined` when it is absent or not a boolean — the
 * latter refused or warned up front by {@link disassociationProtectionRefusal}.
 */
export function readReplicaDisassociationProtection(
  replica: Record<string, unknown> | undefined
): boolean | undefined {
  return coerceCfnBoolean(replica?.[DISASSOCIATION_PROTECTION_KEY]);
}

/**
 * The `Replicas[]` members `readCurrentState` writes on every entry, and the
 * exact value each reads as when the replica was left at AWS's default
 * (go-to-k/cdkd#5789). Any other value -- a key, an enabled flag, a tag -- is
 * not a default and is never completed.
 */
const REPLICA_DRIFT_DEFAULTS: ReadonlyArray<readonly [string, (value: unknown) => boolean]> = [
  ['TableClass', (v) => v === 'STANDARD'],
  ['DeletionProtectionEnabled', (v) => v === false],
  ['ContributorInsightsSpecification', (v) => isExactly(v, { Enabled: false })],
  ['PointInTimeRecoverySpecification', (v) => isExactly(v, { PointInTimeRecoveryEnabled: false })],
  ['Tags', (v) => Array.isArray(v) && v.length === 0],
];

/** A plain object holding exactly `expected`'s keys and values. */
function isExactly(value: unknown, expected: Record<string, unknown>): boolean {
  const record = asRecord(value);
  if (record === undefined) return false;
  const keys = Object.keys(record).filter((k) => record[k] !== undefined);
  return (
    keys.length === Object.keys(expected).length &&
    Object.entries(expected).every(([k, v]) => record[k] === v)
  );
}

/**
 * go-to-k/cdkd#5789: `readCurrentState` writes every `REPLICA_DRIFT_DEFAULTS`
 * member into EVERY `Replicas[]` entry (`TableClass` and the protection flag
 * on each entry since #5397), and arrays compare whole. A baseline entry that
 * omits one -- a template bag the comparison falls back to when the record has
 * no `observedProperties` (a rollback's reverse-replacement re-create, a
 * pre-v3 record) -- takes the AWS side's value ONLY when that value is the
 * member's AWS default, matched by `Region`. A non-default live value still
 * differs, and `drift --revert` sends nothing the live table lacks. Identity
 * when nothing is completed.
 */
export function completeReplicaDefaults(
  baseline: Record<string, unknown>,
  aws: Record<string, unknown>
): Record<string, unknown> {
  const key = 'Replicas';
  const baselineReplicas = baseline[key];
  const awsReplicas = aws[key];
  if (!Array.isArray(baselineReplicas) || !Array.isArray(awsReplicas)) return baseline;
  let changed = false;
  const next = baselineReplicas.map((entry) => {
    const record = asRecord(entry);
    const region = record?.['Region'];
    if (record === undefined || typeof region !== 'string') return entry;
    const live = awsReplicas.map(asRecord).find((r) => r?.['Region'] === region);
    if (live === undefined) return entry;
    let out: Record<string, unknown> | undefined;
    for (const [member, isDefault] of REPLICA_DRIFT_DEFAULTS) {
      if (record[member] !== undefined || !isDefault(live[member])) continue;
      out = { ...(out ?? record), [member]: structuredClone(live[member]) };
    }
    if (out === undefined) return entry;
    changed = true;
    return out;
  });
  return changed ? { ...baseline, [key]: next } : baseline;
}

/**
 * go-to-k/cdkd#5790: a baseline on the AWS managed key -- top-level
 * `SSESpecification` `SSEEnabled: true`, `SSEType: 'KMS'`, no key, which is
 * what CDK renders for `TableEncryptionV2.awsManagedKey()` -- declares no
 * per-replica key, while the read-back writes each replica's
 * `SSESpecification: { KMSMasterKeyId: <arn> }`. A baseline replica entry
 * with no `SSESpecification` takes the live one ONLY when KMS reports EVERY
 * live replica's key AWS managed (`SSEType` may be omitted: KMS is its one
 * value); a customer managed key, an unreadable key, or a baseline
 * naming any key completes nothing. Identity when nothing is completed.
 */
export async function completeAwsManagedReplicaKeys(
  baseline: Record<string, unknown>,
  aws: Record<string, unknown>,
  keyManager: (arn: string) => Promise<string | undefined>
): Promise<Record<string, unknown>> {
  const sse = asRecord(baseline['SSESpecification']);
  if (
    sse === undefined ||
    sse['SSEEnabled'] !== true ||
    (sse['SSEType'] !== undefined && sse['SSEType'] !== 'KMS') ||
    sse['KMSMasterKeyId'] !== undefined
  ) {
    return baseline;
  }
  const baselineReplicas = baseline['Replicas'];
  const awsReplicas = aws['Replicas'];
  if (!Array.isArray(baselineReplicas) || !Array.isArray(awsReplicas)) return baseline;
  // Every live replica must be on an AWS managed key: a mixed table (one
  // replica moved to a customer managed key) completes nothing, so drift
  // shows it and `drift --revert`'s desired bag still names no local key,
  // which `update()` answers by re-sending the AWS managed key to every
  // replica (security review of #5790).
  const wantsKey = baselineReplicas.some((entry) => {
    const record = asRecord(entry);
    return record !== undefined && record['SSESpecification'] === undefined;
  });
  if (!wantsKey) return baseline;
  const liveKeys = new Map<string, string>();
  for (const live of awsReplicas.map(asRecord)) {
    const region = live?.['Region'];
    const liveSse = asRecord(live?.['SSESpecification']);
    const arn = liveSse?.['KMSMasterKeyId'];
    if (
      typeof region !== 'string' ||
      liveSse === undefined ||
      typeof arn !== 'string' ||
      Object.keys(liveSse).length !== 1
    ) {
      return baseline;
    }
    liveKeys.set(region, arn);
  }
  const managers = await Promise.all([...liveKeys.values()].map((arn) => keyManager(arn)));
  if (managers.some((m) => m !== 'AWS')) return baseline;
  let changed = false;
  const next = baselineReplicas.map((entry) => {
    const record = asRecord(entry);
    const region = record?.['Region'];
    if (record === undefined || typeof region !== 'string') return entry;
    if (record['SSESpecification'] !== undefined) return entry;
    const arn = liveKeys.get(region);
    if (arn === undefined) return entry;
    changed = true;
    return { ...record, SSESpecification: { KMSMasterKeyId: arn } };
  });
  return changed ? { ...baseline, Replicas: next } : baseline;
}

/**
 * The #3573 half of {@link DynamoDBGlobalTableProvider.canonicalizeDriftPair}:
 * a baseline whose `Replicas` has no entry for the local region gets the
 * read-back's local entry. Identity when nothing applies.
 */
export function completeLegacyLocalReplica(
  baseline: Record<string, unknown>,
  aws: Record<string, unknown>,
  localRegion: string
): Record<string, unknown> {
  const key = 'Replicas';
  const baselineReplicas = baseline[key];
  const awsReplicas = aws[key];
  if (!Array.isArray(baselineReplicas) || !Array.isArray(awsReplicas)) return baseline;
  if (!localRegion) return baseline;
  const isLocal = (element: unknown): boolean => asRecord(element)?.['Region'] === localRegion;
  if (baselineReplicas.some(isLocal)) return baseline;
  const liveLocal = awsReplicas.find(isLocal);
  if (liveLocal === undefined) return baseline;
  return { ...baseline, [key]: [...baselineReplicas, structuredClone(liveLocal)] };
}

/**
 * The `Replicas[]` entry for `region`, or `undefined`.
 *
 * ONE predicate, because two readers of the same field had drifted: issue
 * [#2610]'s review round guarded `extractLocalDeletionProtection` against a
 * non-array `Replicas` and left `update()`'s inline `extractLocalTags` on the
 * old `(props['Replicas'] ?? []) as Array<...>` -- which is the one that
 * actually throws FIRST on the apply path, ~400 lines earlier in the same
 * method, so guarding only the other produced no visible change and no test
 * went red. A shared predicate is what stops the next reader inheriting the
 * unguarded spelling; `derivePerCallProvisionedThroughput` documents the same
 * hazard for the same field and guards independently.
 *
 * `Array.isArray`, not `?? []`: a non-array `Replicas` -- an unresolved
 * intrinsic, or a hand-edited state record -- makes `.find` throw a bare
 * `TypeError`, and since [#2610] one caller sits on the REFUSAL path, where a
 * throw REPLACES three informative `ProvisioningError`s with a stack trace.
 * The `r?.` guards a null ENTRY inside an otherwise-valid array.
 */
export function localReplicaEntry(
  props: Record<string, unknown>,
  region: string
): Record<string, unknown> | undefined {
  const raw = props['Replicas'];
  if (!Array.isArray(raw)) return undefined;
  return (raw as Array<Record<string, unknown> | null | undefined>).find(
    (r) => r?.['Region'] === region
  ) as Record<string, unknown> | undefined;
}

/** The replica members {@link replicaSettingsRefusal} reads. */
const REPLICA_SETTING_MEMBERS = [
  'PointInTimeRecoverySpecification',
  'ContributorInsightsSpecification',
  'KinesisStreamSpecification',
  'ResourcePolicy',
  'ReplicaStreamSpecification',
  // Its entries' ContributorInsightsSpecification (go-to-k/cdkd#5489).
  'GlobalSecondaryIndexes',
] as const;

const REPLICATION_MODE_KEY = 'GlobalTableSettingsReplicationMode';

/** The table-level read settings (go-to-k/cdkd#2762), beside each replica's own. */
export const TABLE_READ_ON_DEMAND_KEY = 'ReadOnDemandThroughputSettings';

export const TABLE_READ_PROVISIONED_KEY = 'ReadProvisionedThroughputSettings';

export const TABLE_WRITE_PROVISIONED_KEY = 'WriteProvisionedThroughputSettings';

/** One read of the declared `Replicas[].GlobalTableSettingsReplicationMode`. */
export type ReplicationModeRead =
  | { kind: 'absent' }
  | { kind: 'usable'; mode: string }
  | { kind: 'unusable'; reason: string };

/**
 * Read the settings replication mode (go-to-k/cdkd#5489). The CFn schema puts
 * it on each replica, but DynamoDB holds ONE per table (a `CreateTable` /
 * `UpdateTable` member), and CloudFormation refuses it unless the table has
 * exactly one replica: "GlobalTableSettingsReplicationMode can be specified
 * when exactly one replica is present" (CFn A/B, us-east-1 + us-west-2,
 * 2026-10-28, on a create with two replicas and on an update adding one). With
 * one replica it rides `CreateTable`, and a change goes out in its own
 * `UpdateTable`.
 */
export function readReplicationMode(properties: Record<string, unknown>): ReplicationModeRead {
  const replicas = Array.isArray(properties['Replicas'])
    ? (properties['Replicas'] as unknown[])
    : [];
  const declared = replicas
    .map((entry) => asRecord(entry)?.[REPLICATION_MODE_KEY])
    .filter((value) => value !== undefined && value !== null);
  if (declared.length === 0) return { kind: 'absent' };
  const [first] = declared;
  if (typeof first !== 'string' || first === '' || declared.some((v) => v !== first)) {
    return {
      kind: 'unusable',
      reason: `Replicas[].${REPLICATION_MODE_KEY} must be one non-empty string`,
    };
  }
  if (replicas.length !== 1) {
    return {
      kind: 'unusable',
      reason:
        `Replicas[].${REPLICATION_MODE_KEY} can be declared only on a table with exactly one ` +
        `replica, as CloudFormation refuses it ("GlobalTableSettingsReplicationMode can be ` +
        `specified when exactly one replica is present"); remove it, or keep one replica`,
    };
  }
  return { kind: 'usable', mode: first };
}

/** What a change to the mode, or to the replica count, is compared by. */
function replicationModeShape(properties: Record<string, unknown>): unknown {
  const replicas = Array.isArray(properties['Replicas'])
    ? (properties['Replicas'] as unknown[])
    : [];
  return replicas.map((entry) => asRecord(entry)?.[REPLICATION_MODE_KEY] ?? null);
}

/**
 * The mode an update must send, or `undefined` when none: the declared mode
 * when it changed, and `DISABLED` when the template removed one — what
 * CloudFormation sends for a removal (CFn A/B, 2026-10-28: `UpdateTable` with
 * `GlobalTableSettingsReplicationMode: DISABLED`). A mode that was never valid
 * on the recorded side (two replicas) was never sent, so it is not reset.
 */
export function replicationModeUpdate(
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>
): string | undefined {
  const want = readReplicationMode(properties);
  if (want.kind === 'unusable') return undefined;
  const had = readReplicationMode(previousProperties);
  const desired = want.kind === 'usable' ? want.mode : undefined;
  const recorded = had.kind === 'usable' ? had.mode : undefined;
  if (desired === recorded) return undefined;
  return desired ?? 'DISABLED';
}

/**
 * The mode a DECLARED, UNCHANGED `GlobalTableSettingsReplicationMode` needs to
 * reach what the template says, given what `DescribeTable` reports, or
 * `undefined` (go-to-k/cdkd#5489). Before that issue the mode was never sent,
 * so a table deployed then holds DynamoDB's default
 * (`ENABLED_WITH_OVERRIDES`, measured) under a record that names the mode.
 * A table set to `DISABLED` reports no mode at all (measured), so an absent
 * live mode reads as `DISABLED`. A changed or unusable declaration is not a
 * correction: {@link replicationModeUpdate} and the refusal own those.
 */
export function replicationModeCorrection(
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>,
  liveMode: string | undefined
): string | undefined {
  const want = readReplicationMode(properties);
  if (want.kind !== 'usable') return undefined;
  if (replicationModeUpdate(properties, previousProperties) !== undefined) return undefined;
  return (liveMode ?? 'DISABLED') === want.mode ? undefined : want.mode;
}

/**
 * What CloudFormation's handler refuses of the table-level settings
 * go-to-k/cdkd#2762 wires, or `undefined` (measured us-east-1, 2026-11-01). The
 * refusals are the handler's, not DynamoDB's: `CreateTable` takes these values.
 *
 *  - `TableType: Regional` on more than one replica. `GlobalTableReplica` is
 *    accepted on one replica, where it reads back `Regional`: nothing is sent.
 *  - A table-level read block without settings replication ENABLED on a
 *    replica, or beside the same block on a replica.
 *  - `ReadOnDemandThroughputSettings` on a PROVISIONED table.
 */
function tableLevelSettingsRefusal(properties: Record<string, unknown>): string | undefined {
  const replicas = Array.isArray(properties['Replicas'])
    ? (properties['Replicas'] as unknown[])
    : [];
  if (properties['TableType'] === 'Regional' && replicas.length > 1) {
    return (
      `TableType Regional cannot be declared with more than one replica, as CloudFormation ` +
      `refuses it; declare TableType GlobalTableReplica or omit TableType`
    );
  }
  const mode = readReplicationMode(properties);
  for (const key of [TABLE_READ_ON_DEMAND_KEY, TABLE_READ_PROVISIONED_KEY]) {
    if (properties[key] === undefined || properties[key] === null) continue;
    if (mode.kind !== 'usable' || mode.mode !== 'ENABLED') {
      return (
        `${key} at the table level needs Replicas[].${REPLICATION_MODE_KEY} ENABLED, as ` +
        `CloudFormation refuses it otherwise; enable it on the replica, or move the block to ` +
        `the replica`
      );
    }
    if (replicas.some((entry) => asRecord(entry)?.[key] !== undefined)) {
      return (
        `${key} cannot be declared at both the table level and a replica, as CloudFormation ` +
        `refuses it; keep one`
      );
    }
  }
  if (
    properties[TABLE_READ_ON_DEMAND_KEY] !== undefined &&
    properties[TABLE_READ_ON_DEMAND_KEY] !== null &&
    properties['BillingMode'] === 'PROVISIONED'
  ) {
    return (
      `${TABLE_READ_ON_DEMAND_KEY} cannot be declared on a PROVISIONED table, as CloudFormation ` +
      `refuses it; remove it, or set BillingMode to PAY_PER_REQUEST`
    );
  }
  return undefined;
}

/** A replica's own read blocks, which the table-level ones may not sit beside. */
function replicaReadBlockShape(properties: Record<string, unknown>): unknown {
  const replicas = Array.isArray(properties['Replicas'])
    ? (properties['Replicas'] as unknown[])
    : [];
  return replicas.map((entry) => [
    asRecord(entry)?.[TABLE_READ_ON_DEMAND_KEY],
    asRecord(entry)?.[TABLE_READ_PROVISIONED_KEY],
  ]);
}

/** The inputs of {@link tableLevelSettingsRefusal}. */
const TABLE_LEVEL_SETTING_INPUTS = [
  'TableType',
  'BillingMode',
  TABLE_READ_ON_DEMAND_KEY,
  TABLE_READ_PROVISIONED_KEY,
] as const;

/**
 * The template-path refusal for the per-replica settings go-to-k/cdkd#5365
 * wires, or `undefined`. `previousProperties` is `undefined` on a create.
 *
 *  - A block the write plan cannot read, on a replica whose blocks changed (an
 *    unchanged one is not a pending operation).
 *  - A `ResourcePolicy` on a replica created in the same deploy, which
 *    CloudFormation refuses ("A replica cannot be created in the same stack
 *    update as putting a resource-based policy on that new replica", measured
 *    us-east-1 + us-west-2, 2026-10-27): on a create with a cross-region
 *    replica that is every replica's, the deploy region's included (a
 *    single-region create takes it); on an update, an added replica's
 *    (measured the same day: an update adding a replica that declares one is
 *    refused with the same message and rolled back).
 *
 * Names the region (an AWS region name, never a secret) and the member path,
 * never a value.
 */
export function replicaSettingsRefusal(
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown> | undefined,
  currentRegion?: string
): string | undefined {
  // go-to-k/cdkd#5489: refused only when the mode or the replica list changed
  // (an unchanged one is not a pending operation).
  const mode = readReplicationMode(properties);
  const modeShapeChanged =
    previousProperties === undefined ||
    !deepEqual(replicationModeShape(properties), replicationModeShape(previousProperties));
  if (mode.kind === 'unusable' && modeShapeChanged) return mode.reason;
  // go-to-k/cdkd#2762: the same bound.
  if (
    modeShapeChanged ||
    previousProperties === undefined ||
    !deepEqual(replicaReadBlockShape(properties), replicaReadBlockShape(previousProperties)) ||
    TABLE_LEVEL_SETTING_INPUTS.some((key) => !deepEqual(properties[key], previousProperties?.[key]))
  ) {
    const tableLevelRefusal = tableLevelSettingsRefusal(properties);
    if (tableLevelRefusal !== undefined) return tableLevelRefusal;
  }
  // go-to-k/cdkd#2762: removing the table-level block from a table that stays
  // PROVISIONED, with no replica declaring its own, is refused by CloudFormation
  // ("You must specify ReadCapacityUnits or ReadCapacityAutoScalingSettings for
  // each global table replica", update rolled back and the capacity kept,
  // measured us-east-1, 2026-11-01), so it is no silent keep here.
  if (
    previousProperties?.[TABLE_READ_PROVISIONED_KEY] != null &&
    properties[TABLE_READ_PROVISIONED_KEY] == null &&
    properties['BillingMode'] === 'PROVISIONED' &&
    !(Array.isArray(properties['Replicas']) ? (properties['Replicas'] as unknown[]) : []).some(
      (entry) => asRecord(entry)?.[TABLE_READ_PROVISIONED_KEY] != null
    )
  ) {
    return (
      `${TABLE_READ_PROVISIONED_KEY} cannot be removed from a PROVISIONED table with no replica ` +
      `declaring its own, as CloudFormation refuses it; keep it, declare it on the replica, or ` +
      `set BillingMode to PAY_PER_REQUEST`
    );
  }
  const desired = Array.isArray(properties['Replicas'])
    ? (properties['Replicas'] as unknown[])
    : [];
  const crossRegionCreate =
    previousProperties === undefined &&
    desired.some((entry) => {
      const region = asRecord(entry)?.['Region'];
      return typeof region === 'string' && region !== currentRegion;
    });
  for (const entry of desired) {
    const replica = asRecord(entry);
    const region = replica?.['Region'];
    if (typeof region !== 'string') continue;
    const previous =
      previousProperties === undefined ? undefined : localReplicaEntry(previousProperties, region);
    const changed =
      previous === undefined ||
      REPLICA_SETTING_MEMBERS.some((member) => !deepEqual(replica?.[member], previous[member]));
    if (!changed) continue;
    const [refusal] = replicaSettingRefusals(replica);
    if (refusal !== undefined) return `The ${region} replica: ${refusal}`;
    const created = previousProperties === undefined ? crossRegionCreate : previous === undefined;
    if (
      created &&
      replica?.['ResourcePolicy'] !== undefined &&
      replica['ResourcePolicy'] !== null
    ) {
      return (
        `The ${region} replica: Replicas[].ResourcePolicy cannot be set in the deploy that ` +
        `creates the replica — CloudFormation refuses it ("A replica cannot be created in the ` +
        `same stack update as putting a resource-based policy on that new replica"). ` +
        (previousProperties === undefined
          ? `Deploy the table and its replicas without it`
          : `Deploy the replica without it`) +
        `, then add the policy in a later deploy`
      );
    }
  }
  return undefined;
}

/**
 * Extract the local replica's `DeletionProtectionEnabled` from a CFn
 * properties shape. The `AWS::DynamoDB::GlobalTable` CFn schema places
 * the field inside `Replicas[?Region==<region>].DeletionProtectionEnabled`;
 * CDK 2.x's `deletionProtection: true` synthesizes there. Falls back
 * to the top-level `DeletionProtectionEnabled` for legacy or
 * hand-authored templates (the property doesn't formally exist at
 * the top level in the CFn schema, but cdkd tolerates it as a
 * pass-through to avoid breaking older state files).
 *
 * Returns `undefined` when neither shape carries a boolean — the
 * caller treats that as "unset" and does not include the field in
 * the SDK call.
 */
export function extractLocalDeletionProtection(
  props: Record<string, unknown>,
  region: string
): boolean | undefined {
  const local = localReplicaEntry(props, region);
  // `coerceCfnBoolean`: a template's `'true'` protects, as CloudFormation
  // reads it, and as the cross-region replicas' reads do (go-to-k/cdkd#5355).
  const perReplica = coerceCfnBoolean(local?.['DeletionProtectionEnabled']);
  if (perReplica !== undefined) return perReplica;
  const topLevel = props['DeletionProtectionEnabled'];
  return typeof topLevel === 'boolean' ? topLevel : undefined;
}

/**
 * Whether the table OR any cross-region replica is protected: the local
 * table's value (as {@link extractLocalDeletionProtection} reads it), `true`
 * when any replica's `DeletionProtectionEnabled` is. What the protection
 * locator reports, now that cdkd sets a replica's own guard and
 * `--remove-protection` turns it off (go-to-k/cdkd#5355).
 */
export function extractAnyDeletionProtection(
  props: Record<string, unknown>,
  region: string
): boolean | undefined {
  const replicas = Array.isArray(props['Replicas']) ? (props['Replicas'] as unknown[]) : [];
  if (replicas.some((r) => coerceCfnBoolean(asRecord(r)?.['DeletionProtectionEnabled']) === true)) {
    return true;
  }
  return extractLocalDeletionProtection(props, region);
}

/**
 * A replica's customer-managed KMS key, read where the CFn schema puts it:
 * `Replicas[].SSESpecification.KMSMasterKeyId` (`ReplicaSSESpecification`).
 * CDK's `TableV2` renders it there for every replica of a
 * `TableEncryptionV2.customerManagedKey(...)` table. The provider used to read
 * a flat `Replicas[].KMSMasterKeyId`, which the schema does not have
 * (`additionalProperties: false`), so the key was silently dropped and the
 * replica came up under the AWS managed key (go-to-k/cdkd#5355).
 */
export function readReplicaKmsMasterKeyId(replica: unknown): string | undefined {
  const sse = asRecord(asRecord(replica)?.['SSESpecification']);
  const key = sse?.['KMSMasterKeyId'];
  return typeof key === 'string' && key !== '' ? key : undefined;
}

/**
 * A replica's table class, read where the CFn schema puts it:
 * `Replicas[].TableClass`. The SDK spells the cross-region member
 * `TableClassOverride`, which is not a CFn property — reading THAT name from
 * the template dropped every table class (go-to-k/cdkd#5355).
 */
export function readReplicaTableClass(replica: unknown): ReplicaTableClass | undefined {
  const tableClass = asRecord(replica)?.['TableClass'];
  return typeof tableClass === 'string' && tableClass !== ''
    ? (tableClass as ReplicaTableClass)
    : undefined;
}

type ReplicaTableClass = 'STANDARD' | 'STANDARD_INFREQUENT_ACCESS';

/** {@link readReplicaDeletionProtection}'s answer for a value that is not a boolean. */
export const UNUSABLE = Symbol('unusable');

/**
 * A replica's `DeletionProtectionEnabled`: the boolean (a CFn string
 * `'true'` / `'false'` included), `undefined` when absent, or
 * {@link UNUSABLE} for anything else — reported through `warn` when one is
 * given. Never read as `false`: that would turn a protected replica's guard
 * off on a value nobody can read (go-to-k/cdkd#5355).
 */
export function readReplicaDeletionProtection(
  replica: Record<string, unknown> | undefined,
  region: string,
  warn?: (message: string) => void
): boolean | undefined | typeof UNUSABLE {
  const refusal = configBooleanRefusal(
    replica,
    'DeletionProtectionEnabled',
    `AWS::DynamoDB::GlobalTable Replicas[${region}]`
  );
  if (refusal !== undefined) {
    warn?.(`${refusal}. The ${region} replica's deletion protection is left as it is.`);
    return UNUSABLE;
  }
  return coerceCfnBoolean(replica?.['DeletionProtectionEnabled']);
}

/**
 * Each replica's `SSESpecification` by region — what decides whether an update
 * re-sends the local table's SSE block (its key lives there), compared before
 * the client region is resolved.
 */
export function replicaKeyBlocks(props: Record<string, unknown>): unknown[] {
  return (Array.isArray(props['Replicas']) ? (props['Replicas'] as unknown[]) : []).map((r) => [
    asRecord(r)?.['Region'],
    asRecord(r)?.['SSESpecification'],
  ]);
}

/** Whether a KMS key reference is a key ARN (what AWS reports back for a replica). */
export function isKmsKeyArn(key: string | undefined): key is string {
  return key !== undefined && /^arn:aws[a-z-]*:kms:[^:]+:\d+:key\//.test(key);
}

/**
 * The table class an update sends, or `undefined` for none: a changed value,
 * or `STANDARD` when the template REMOVED a non-standard one — CloudFormation
 * resets a removed `Replicas[].TableClass` to `STANDARD` on the local table
 * and on a cross-region replica alike (CFn A/B, us-east-1 + us-west-2,
 * 2026-10-26, go-to-k/cdkd#5355). Before, a removal sent nothing and the old
 * class stayed.
 */
export function tableClassToSend(
  previous: ReplicaTableClass | undefined,
  desired: ReplicaTableClass | undefined
): ReplicaTableClass | undefined {
  if (desired !== undefined) return desired !== previous ? desired : undefined;
  return previous !== undefined && previous !== 'STANDARD' ? 'STANDARD' : undefined;
}

/**
 * The SDK `SSESpecification` for the LOCAL table: the top-level CFn block's
 * `{ SSEEnabled, SSEType }` plus the local replica's KMS key, which the CFn
 * schema keeps per replica. Shared by `create()` and `update()` so the two
 * cannot disagree on the key (go-to-k/cdkd#5355).
 */
export function toSdkTableSseSpecification(
  block: unknown,
  kmsMasterKeyId: string | undefined
): { Enabled: boolean; SSEType?: 'KMS'; KMSMasterKeyId?: string } {
  const sse = asRecord(block) ?? {};
  return {
    // `coerceCfnBoolean`, not `Boolean(...)`: a template's `"false"` is a
    // truthy string, and read that way it ENABLED encryption it disabled.
    Enabled: coerceCfnBoolean(sse['SSEEnabled']) ?? true,
    ...(sse['SSEType'] !== undefined &&
      sse['SSEType'] !== '' && {
        SSEType: sse['SSEType'] as 'KMS',
      }),
    ...(kmsMasterKeyId !== undefined && { KMSMasterKeyId: kmsMasterKeyId }),
  };
}

/**
 * The table class the LOCAL table (the one `CreateTable` builds) should carry:
 * its `Replicas[?Region==<region>].TableClass`, falling back to a top-level
 * `TableClass`. The top-level spelling is not in the CFn schema (CloudFormation
 * refuses it at validation, measured for go-to-k/cdkd#5355), but it is the one
 * this provider always read, so it stays as the same legacy pass-through
 * {@link extractLocalDeletionProtection} keeps.
 */
export function extractLocalTableClass(
  props: Record<string, unknown>,
  region: string
): ReplicaTableClass | undefined {
  const perReplica = readReplicaTableClass(localReplicaEntry(props, region));
  if (perReplica !== undefined) return perReplica;
  const topLevel = props['TableClass'];
  return typeof topLevel === 'string' && topLevel !== ''
    ? (topLevel as ReplicaTableClass)
    : undefined;
}
