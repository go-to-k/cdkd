/**
 * The per-replica `AWS::DynamoDB::GlobalTable` settings that ride neither
 * `CreateTable` nor `ReplicaUpdates` (go-to-k/cdkd#5365):
 *
 *  - `Replicas[].PointInTimeRecoverySpecification` — `UpdateContinuousBackups`;
 *  - `Replicas[].ContributorInsightsSpecification` — `UpdateContributorInsights`;
 *  - `Replicas[].KinesisStreamSpecification` — `Enable` / `Disable` / `Update`
 *    `KinesisStreamingDestination`;
 *  - `Replicas[].ResourcePolicy` — `PutResourcePolicy` / `DeleteResourcePolicy`
 *    against the replica's TABLE arn;
 *  - `Replicas[].ReplicaStreamSpecification.ResourcePolicy` — the same two
 *    calls against the replica's STREAM arn.
 *
 * Each is sent through the replica's OWN region, the local table's included.
 * Before this module none was sent at all: a template declaring them deployed
 * green without them.
 *
 * Pure, so the create-time refusal, the update-time refusal and the write plan
 * read each block through one reader and cannot disagree about its shape.
 */
import {
  CONTRIBUTOR_INSIGHTS_KEY,
  planContributorInsightsOp,
  readContributorInsightsSpec,
} from './dynamodb-contributor-insights.js';
import {
  coerceCfnBoolean,
  coerceCfnInteger,
  configBooleanRefusal,
  configIntegerRefusal,
  configStringRefusal,
} from './config-shape.js';

export const PITR_KEY = 'PointInTimeRecoverySpecification';
export const KINESIS_KEY = 'KinesisStreamSpecification';
export const TABLE_POLICY_KEY = 'ResourcePolicy';
export const REPLICA_STREAM_KEY = 'ReplicaStreamSpecification';

/** The point-in-time recovery window DynamoDB applies when none is sent. */
const DEFAULT_RECOVERY_PERIOD_DAYS = 35;

/** What DynamoDB streams with when no precision is sent. */
const DEFAULT_KINESIS_PRECISION = 'MILLISECOND';

const PITR_PATH = `Replicas[].${PITR_KEY}`;
const CI_PATH = `Replicas[].${CONTRIBUTOR_INSIGHTS_KEY}`;
const KINESIS_PATH = `Replicas[].${KINESIS_KEY}`;
const TABLE_POLICY_PATH = `Replicas[].${TABLE_POLICY_KEY}`;
const STREAM_POLICY_PATH = `Replicas[].${REPLICA_STREAM_KEY}.ResourcePolicy`;

/** A declared block cdkd cannot read: never sent, never read as a default. */
interface Unusable {
  kind: 'unusable';
  reason: string;
}
interface Absent {
  kind: 'absent';
}

export type PitrRead =
  | Absent
  | { kind: 'usable'; enabled: boolean; recoveryPeriodInDays?: number }
  | Unusable;

export type KinesisRead =
  | Absent
  | { kind: 'usable'; streamArn: string; precision?: string }
  | Unusable;

export type PolicyRead = Absent | { kind: 'usable'; document: string } | Unusable;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Read `PointInTimeRecoverySpecification`. An ABSENT `PointInTimeRecoveryEnabled`
 * reads as `false` (the CFn default). `RecoveryPeriodInDays` is the API's 1-35,
 * and is only meaningful while enabled — AWS refuses it alongside `false`.
 */
export function readPitrSpec(value: unknown): PitrRead {
  if (value === undefined || value === null) return { kind: 'absent' };
  const refusal =
    configBooleanRefusal(value, 'PointInTimeRecoveryEnabled', PITR_PATH) ??
    configIntegerRefusal(value, 'RecoveryPeriodInDays', PITR_PATH, 1, 35);
  if (refusal !== undefined) return { kind: 'unusable', reason: refusal };
  const block = value as Record<string, unknown>;
  const enabled = coerceCfnBoolean(block['PointInTimeRecoveryEnabled']) ?? false;
  const period = enabled ? coerceCfnInteger(block['RecoveryPeriodInDays']) : undefined;
  return period === undefined
    ? { kind: 'usable', enabled }
    : { kind: 'usable', enabled, recoveryPeriodInDays: period };
}

/** Read `KinesisStreamSpecification`; `StreamArn` is required by the CFn schema. */
export function readKinesisSpec(value: unknown): KinesisRead {
  if (value === undefined || value === null) return { kind: 'absent' };
  const refusal =
    configStringRefusal(value, 'StreamArn', 'required', KINESIS_PATH) ??
    configStringRefusal(value, 'ApproximateCreationDateTimePrecision', '', KINESIS_PATH);
  if (refusal !== undefined) return { kind: 'unusable', reason: refusal };
  const block = value as Record<string, unknown>;
  const streamArn = block['StreamArn'];
  if (typeof streamArn !== 'string') {
    return { kind: 'unusable', reason: `${KINESIS_PATH}.StreamArn is required` };
  }
  const precision = block['ApproximateCreationDateTimePrecision'];
  return typeof precision === 'string' && precision.length > 0
    ? { kind: 'usable', streamArn, precision }
    : { kind: 'usable', streamArn };
}

/**
 * Read a `{ PolicyDocument }` block. The document is REQUIRED, so a block
 * without one is unreadable rather than "no policy": reading it as absent
 * would DELETE the live policy on an update.
 */
function readPolicyBlock(value: unknown, path: string): PolicyRead {
  if (value === undefined || value === null) return { kind: 'absent' };
  if (!isPlainObject(value)) {
    return { kind: 'unusable', reason: `${path} must be an object with a PolicyDocument` };
  }
  const document = value['PolicyDocument'];
  if (typeof document === 'string') {
    return document.trim() === ''
      ? { kind: 'unusable', reason: `${path}.PolicyDocument must not be a blank string` }
      : { kind: 'usable', document };
  }
  if (!isPlainObject(document)) {
    return {
      kind: 'unusable',
      reason: `${path}.PolicyDocument must be a policy object or a JSON string`,
    };
  }
  // An unresolved intrinsic is a one-key `Ref` / `Fn::*` object, never a
  // policy: sending it would put a document AWS cannot parse.
  const keys = Object.keys(document);
  if (keys.length === 1 && (keys[0] === 'Ref' || keys[0]!.startsWith('Fn::'))) {
    return { kind: 'unusable', reason: `${path}.PolicyDocument is an unresolved intrinsic` };
  }
  return { kind: 'usable', document: JSON.stringify(document) };
}

export function readTablePolicy(replica: Record<string, unknown> | undefined): PolicyRead {
  return readPolicyBlock(replica?.[TABLE_POLICY_KEY], TABLE_POLICY_PATH);
}

export function readStreamPolicy(replica: Record<string, unknown> | undefined): PolicyRead {
  const stream = replica?.[REPLICA_STREAM_KEY];
  if (stream === undefined || stream === null) return { kind: 'absent' };
  if (!isPlainObject(stream)) {
    return { kind: 'unusable', reason: `Replicas[].${REPLICA_STREAM_KEY} must be an object` };
  }
  return readPolicyBlock(stream['ResourcePolicy'], STREAM_POLICY_PATH);
}

/**
 * Every refusal a template-path write must raise for one replica entry before
 * its first call. A create has no live setting to leave alone, so an
 * unreadable block there is a template error, not a skip.
 */
export function replicaSettingRefusals(replica: Record<string, unknown> | undefined): string[] {
  const reads = [
    readPitrSpec(replica?.[PITR_KEY]),
    readContributorInsightsSpec(replica?.[CONTRIBUTOR_INSIGHTS_KEY], CI_PATH),
    readKinesisSpec(replica?.[KINESIS_KEY]),
    readTablePolicy(replica),
    readStreamPolicy(replica),
  ];
  return reads.flatMap((read) => (read.kind === 'unusable' ? [read.reason] : []));
}

/** One call against one replica, in that replica's own region. */
export type ReplicaSettingOp =
  | { kind: 'pitr'; enabled: boolean; recoveryPeriodInDays?: number }
  | { kind: 'contributorInsights'; action: 'ENABLE' | 'DISABLE'; mode?: string }
  | { kind: 'kinesisDisable'; streamArn: string }
  | { kind: 'kinesisEnable'; streamArn: string; precision?: string }
  | { kind: 'kinesisPrecision'; streamArn: string; precision: string }
  | { kind: 'deleteTablePolicy' }
  | { kind: 'putTablePolicy'; document: string }
  | { kind: 'deleteStreamPolicy' }
  | { kind: 'putStreamPolicy'; document: string };

/** Which setting an op belongs to, for the convergence pass and messages. */
export type ReplicaSetting =
  | 'pitr'
  | 'contributorInsights'
  | 'kinesis'
  | 'tablePolicy'
  | 'streamPolicy';

export function settingOf(op: ReplicaSettingOp): ReplicaSetting {
  switch (op.kind) {
    case 'pitr':
      return 'pitr';
    case 'contributorInsights':
      return 'contributorInsights';
    case 'kinesisDisable':
    case 'kinesisEnable':
    case 'kinesisPrecision':
      return 'kinesis';
    case 'deleteTablePolicy':
    case 'putTablePolicy':
      return 'tablePolicy';
    case 'deleteStreamPolicy':
    case 'putStreamPolicy':
      return 'streamPolicy';
  }
}

/** The CFn member each setting is declared under, for messages. */
export const SETTING_MEMBER: Readonly<Record<ReplicaSetting, string>> = {
  pitr: PITR_KEY,
  contributorInsights: CONTRIBUTOR_INSIGHTS_KEY,
  kinesis: KINESIS_KEY,
  tablePolicy: TABLE_POLICY_KEY,
  streamPolicy: `${REPLICA_STREAM_KEY}.ResourcePolicy`,
};

export function samePolicyDocument(left: string, right: string): boolean {
  if (left === right) return true;
  try {
    return JSON.stringify(JSON.parse(left)) === JSON.stringify(JSON.parse(right));
  } catch {
    return false;
  }
}

/**
 * The template-driven calls one replica needs: the DESIRED entry against the
 * PREVIOUS one (`undefined` for a replica this operation creates).
 *
 * A setting the desired side no longer declares, over a DECLARED previous one,
 * is a REMOVAL, reset the way CloudFormation resets it (measured for
 * go-to-k/cdkd#5365): point-in-time recovery and Contributor Insights are
 * DISABLED, Kinesis streaming to the previous stream is DISABLED, and either
 * resource policy is DELETED. Two MEMBER removals reset too (measured for
 * go-to-k/cdkd#5381): a removed `RecoveryPeriodInDays` under enabled recovery
 * goes out as an enable without a period, which DynamoDB reads as its default
 * (35 days, what CloudFormation leaves), and a removed
 * `ApproximateCreationDateTimePrecision` on the same stream goes back to
 * `MILLISECOND`. Because the rule is symmetric in its two sides, a
 * rollback — which replays `update()` with the sides swapped — restores the old
 * setting through the same arms.
 *
 * `fresh` says the replica was created by THIS operation: it holds nothing yet,
 * so nothing is turned off and the previous side is irrelevant.
 * `streamReplaced` says the replica's stream arn MAY have changed (a
 * `StreamViewType` change), so a declared stream policy is put again. A
 * removed one is still deleted: the stream may not have been replaced after
 * all, and a delete against a fresh stream finds nothing (`PolicyNotFound`).
 * `keepOnRemoval` names settings whose REMOVAL arm is skipped (the disable or
 * delete an absent desired block over a declared previous one sends). Two
 * callers need it: `cdkd drift --revert`, whose desired side is a read-back
 * that omits a member when its read failed and carries a resource policy only
 * where the template declares one (go-to-k/cdkd#5381), so an absence there
 * says nothing (an absent Kinesis precision is not reset either, and
 * `update()` completes an absent period from the live side first:
 * {@link keepUnreadReplicaMembers}); and a rollback replay, which
 * must not turn point-in-time recovery off (that deletes every recovery
 * point) on the strength of a record whose update may never have sent it.
 *
 * An `unusable` desired block issues nothing for that setting and is reported
 * through `onUnusable` (only a state-borne caller reaches it: the template path
 * refuses it first).
 */
export function planReplicaSettingOps(
  desired: Record<string, unknown> | undefined,
  previous: Record<string, unknown> | undefined,
  options: {
    fresh: boolean;
    streamReplaced?: boolean;
    keepOnRemoval?: ReadonlySet<ReplicaSetting>;
  },
  onUnusable: (reason: string) => void
): ReplicaSettingOp[] {
  const prev = options.fresh ? undefined : previous;
  const ops: ReplicaSettingOp[] = [];
  const removes = (setting: ReplicaSetting): boolean =>
    options.keepOnRemoval?.has(setting) !== true;

  // Point-in-time recovery.
  const pitr = readPitrSpec(desired?.[PITR_KEY]);
  const prevPitr = readPitrSpec(prev?.[PITR_KEY]);
  if (pitr.kind === 'unusable') {
    onUnusable(pitr.reason);
  } else if (pitr.kind === 'absent') {
    if (prevPitr.kind !== 'absent' && removes('pitr')) {
      ops.push({ kind: 'pitr', enabled: false });
    }
  } else {
    const unchanged =
      prevPitr.kind === 'usable' &&
      prevPitr.enabled === pitr.enabled &&
      prevPitr.recoveryPeriodInDays === pitr.recoveryPeriodInDays;
    // A new replica starts without point-in-time recovery.
    const noop = options.fresh && !pitr.enabled;
    if (!unchanged && !noop) {
      ops.push(
        pitr.recoveryPeriodInDays === undefined
          ? { kind: 'pitr', enabled: pitr.enabled }
          : { kind: 'pitr', enabled: pitr.enabled, recoveryPeriodInDays: pitr.recoveryPeriodInDays }
      );
    }
  }

  // Contributor Insights: the shared table-level plan.
  const desiredCi = readContributorInsightsSpec(desired?.[CONTRIBUTOR_INSIGHTS_KEY], CI_PATH);
  const ci = planContributorInsightsOp(
    desiredCi,
    readContributorInsightsSpec(prev?.[CONTRIBUTOR_INSIGHTS_KEY], CI_PATH),
    onUnusable
  );
  // A new replica starts with Contributor Insights off.
  if (
    ci !== undefined &&
    !(options.fresh && ci.action === 'DISABLE') &&
    !(desiredCi.kind === 'absent' && !removes('contributorInsights'))
  ) {
    ops.push(
      ci.mode === undefined
        ? { kind: 'contributorInsights', action: ci.action }
        : { kind: 'contributorInsights', action: ci.action, mode: ci.mode }
    );
  }

  // Kinesis streaming destination.
  const kinesis = readKinesisSpec(desired?.[KINESIS_KEY]);
  const prevKinesis = readKinesisSpec(prev?.[KINESIS_KEY]);
  if (kinesis.kind === 'unusable') {
    onUnusable(kinesis.reason);
  } else if (kinesis.kind === 'absent') {
    // An unreadable previous block names no stream to stop streaming to.
    if (prevKinesis.kind === 'usable' && removes('kinesis')) {
      ops.push({ kind: 'kinesisDisable', streamArn: prevKinesis.streamArn });
    }
  } else if (prevKinesis.kind === 'usable' && prevKinesis.streamArn === kinesis.streamArn) {
    if (kinesis.precision !== undefined && kinesis.precision !== prevKinesis.precision) {
      ops.push({
        kind: 'kinesisPrecision',
        streamArn: kinesis.streamArn,
        precision: kinesis.precision,
      });
    } else if (
      kinesis.precision === undefined &&
      prevKinesis.precision !== undefined &&
      prevKinesis.precision !== DEFAULT_KINESIS_PRECISION &&
      removes('kinesis')
    ) {
      // A removed precision resets to the default, as CloudFormation resets it
      // (CFn A/B, us-east-1, 2026-10-27, go-to-k/cdkd#5381: MICROSECOND with
      // the same StreamArn, precision removed -> MILLISECOND). Before, no call
      // went out and MICROSECOND stayed.
      ops.push({
        kind: 'kinesisPrecision',
        streamArn: kinesis.streamArn,
        precision: DEFAULT_KINESIS_PRECISION,
      });
    }
  } else {
    if (prevKinesis.kind === 'usable') {
      ops.push({ kind: 'kinesisDisable', streamArn: prevKinesis.streamArn });
    }
    ops.push(
      kinesis.precision === undefined
        ? { kind: 'kinesisEnable', streamArn: kinesis.streamArn }
        : { kind: 'kinesisEnable', streamArn: kinesis.streamArn, precision: kinesis.precision }
    );
  }

  // The two resource policies.
  const policyOps = (
    want: PolicyRead,
    had: PolicyRead,
    replaced: boolean,
    put: (document: string) => ReplicaSettingOp,
    del: ReplicaSettingOp,
    setting: ReplicaSetting
  ): void => {
    if (want.kind === 'unusable') {
      onUnusable(want.reason);
      return;
    }
    if (want.kind === 'absent') {
      if (had.kind !== 'absent' && removes(setting)) ops.push(del);
      return;
    }
    if (!replaced && had.kind === 'usable' && samePolicyDocument(had.document, want.document)) {
      return;
    }
    ops.push(put(want.document));
  };
  policyOps(
    readTablePolicy(desired),
    readTablePolicy(prev),
    false,
    (document) => ({ kind: 'putTablePolicy', document }),
    { kind: 'deleteTablePolicy' },
    'tablePolicy'
  );
  policyOps(
    readStreamPolicy(desired),
    readStreamPolicy(prev),
    options.streamReplaced === true,
    (document) => ({ kind: 'putStreamPolicy', document }),
    { kind: 'deleteStreamPolicy' },
    'streamPolicy'
  );
  return ops;
}

/** What AWS reports for one replica's settings; `undefined` = not read. */
export interface LiveReplicaSettings {
  pitr?: { enabled: boolean; recoveryPeriodInDays?: number };
  contributorInsightsEnabled?: boolean;
  /** Streams with an `ACTIVE` / `ENABLING` destination. */
  kinesisStreamArns?: ReadonlySet<string>;
  /** `false` when AWS answered that there is no policy. */
  hasTablePolicy?: boolean;
  hasStreamPolicy?: boolean;
}

/**
 * The corrections a DECLARED setting the template did not change needs, given
 * what AWS reports. Before go-to-k/cdkd#5365 none of these settings was ever
 * written, so a replica deployed then holds none of them under a record that
 * already names them: the two template sides match, and only a read says the
 * replica is wrong. A setting whose live answer is unknown is left alone, and
 * a policy is checked only for being THERE (AWS may store a declared document
 * re-serialized, so its text is not compared). `only` names the settings to
 * consider: the declared ones the template did not change.
 *
 * Point-in-time recovery is only ever turned ON here, at the declared period:
 * the gap this repairs can only leave a replica WITHOUT recovery, while turning
 * it off (or shortening the window) deletes recovery points for good, which no
 * correction AWS alone asked for should do.
 */
export function planReplicaSettingCorrections(
  desired: Record<string, unknown> | undefined,
  live: LiveReplicaSettings,
  only: ReadonlySet<ReplicaSetting>
): ReplicaSettingOp[] {
  const ops: ReplicaSettingOp[] = [];
  const pitr = readPitrSpec(desired?.[PITR_KEY]);
  if (only.has('pitr') && pitr.kind === 'usable' && live.pitr !== undefined) {
    if (pitr.enabled && !live.pitr.enabled) {
      ops.push(
        pitr.recoveryPeriodInDays === undefined
          ? { kind: 'pitr', enabled: pitr.enabled }
          : { kind: 'pitr', enabled: pitr.enabled, recoveryPeriodInDays: pitr.recoveryPeriodInDays }
      );
    }
  }
  const ci = readContributorInsightsSpec(desired?.[CONTRIBUTOR_INSIGHTS_KEY], CI_PATH);
  if (
    only.has('contributorInsights') &&
    ci.kind === 'usable' &&
    live.contributorInsightsEnabled !== undefined &&
    live.contributorInsightsEnabled !== ci.enabled
  ) {
    ops.push(
      !ci.enabled
        ? { kind: 'contributorInsights', action: 'DISABLE' }
        : ci.mode === undefined
          ? { kind: 'contributorInsights', action: 'ENABLE' }
          : { kind: 'contributorInsights', action: 'ENABLE', mode: ci.mode }
    );
  }
  const kinesis = readKinesisSpec(desired?.[KINESIS_KEY]);
  if (
    only.has('kinesis') &&
    kinesis.kind === 'usable' &&
    live.kinesisStreamArns !== undefined &&
    !live.kinesisStreamArns.has(kinesis.streamArn)
  ) {
    ops.push(
      kinesis.precision === undefined
        ? { kind: 'kinesisEnable', streamArn: kinesis.streamArn }
        : { kind: 'kinesisEnable', streamArn: kinesis.streamArn, precision: kinesis.precision }
    );
  }
  const tablePolicy = readTablePolicy(desired);
  if (only.has('tablePolicy') && tablePolicy.kind === 'usable' && live.hasTablePolicy === false) {
    ops.push({ kind: 'putTablePolicy', document: tablePolicy.document });
  }
  const streamPolicy = readStreamPolicy(desired);
  if (
    only.has('streamPolicy') &&
    streamPolicy.kind === 'usable' &&
    live.hasStreamPolicy === false
  ) {
    ops.push({ kind: 'putStreamPolicy', document: streamPolicy.document });
  }
  return ops;
}

/** Which settings a replica entry declares usably — what the convergence reads. */
export function declaredReplicaSettings(
  desired: Record<string, unknown> | undefined
): Set<ReplicaSetting> {
  const declared = new Set<ReplicaSetting>();
  if (readPitrSpec(desired?.[PITR_KEY]).kind === 'usable') declared.add('pitr');
  if (readContributorInsightsSpec(desired?.[CONTRIBUTOR_INSIGHTS_KEY], CI_PATH).kind === 'usable') {
    declared.add('contributorInsights');
  }
  if (readKinesisSpec(desired?.[KINESIS_KEY]).kind === 'usable') declared.add('kinesis');
  if (readTablePolicy(desired).kind === 'usable') declared.add('tablePolicy');
  if (readStreamPolicy(desired).kind === 'usable') declared.add('streamPolicy');
  return declared;
}

// ---------------------------------------------------------------------------
// Drift read-back (go-to-k/cdkd#5381)
// ---------------------------------------------------------------------------

/** The setting a transient-or-terminal status stands for: a transient one reads as its TARGET. */
function enabledForReadStatus(status: string | undefined): boolean | undefined {
  if (status === 'ENABLED' || status === 'ENABLING') return true;
  if (status === 'DISABLED' || status === 'DISABLING') return false;
  return undefined;
}

/**
 * Reverse-map one replica's `DescribeContinuousBackups` answer to the CFn
 * `PointInTimeRecoverySpecification`, or `undefined` when AWS reports no
 * setting. `ENABLING` / `DISABLING` read as their target: the deploy that just
 * turned recovery on captures its baseline moments later, and an `ENABLING`
 * read as `false` froze a baseline that `drift --revert` then sent as an
 * explicit disable, deleting every recovery point. `RecoveryPeriodInDays` is
 * emitted whenever AWS reports one for an enabled replica (its default, 35,
 * included); while `ENABLING` without one yet, the declared period stands in,
 * else that default.
 */
export function reverseMapReplicaPitr(
  status: string | undefined,
  recoveryPeriodInDays: number | undefined,
  declaredBlock: unknown
): Record<string, unknown> | undefined {
  const enabled = enabledForReadStatus(status);
  if (enabled === undefined) return undefined;
  const block: Record<string, unknown> = { PointInTimeRecoveryEnabled: enabled };
  if (!enabled) return block;
  const declared = readPitrSpec(declaredBlock);
  // While ENABLING AWS may not report the period yet: the declared one stands
  // in, else the 35-day default an enable without one gets (measured for
  // go-to-k/cdkd#5381), which every later read reports.
  const period =
    recoveryPeriodInDays ??
    (status === 'ENABLING'
      ? ((declared.kind === 'usable' ? declared.recoveryPeriodInDays : undefined) ??
        DEFAULT_RECOVERY_PERIOD_DAYS)
      : undefined);
  if (period !== undefined) block['RecoveryPeriodInDays'] = period;
  return block;
}

/**
 * Reverse-map one replica's `DescribeContributorInsights` answer to the CFn
 * `ContributorInsightsSpecification`, or `undefined` when AWS reports no
 * setting (`FAILED`, no status). Transient statuses read as their target, for
 * the reason {@link reverseMapReplicaPitr} gives. `Mode` is emitted only when
 * the DECLARED block carries one: AWS reports a mode for every enabled rule
 * set, its default when none was sent, and the block sits inside a `Replicas`
 * entry, which drift compares whole — an undeclared mode would be a member no
 * baseline written before #5381 holds.
 */
export function reverseMapReplicaContributorInsights(
  status: string | undefined,
  mode: string | undefined,
  declaredBlock: unknown
): Record<string, unknown> | undefined {
  const enabled = enabledForReadStatus(status);
  if (enabled === undefined) return undefined;
  const block: Record<string, unknown> = { Enabled: enabled };
  const declared = readContributorInsightsSpec(declaredBlock, CI_PATH);
  if (enabled && declared.kind === 'usable' && declared.mode !== undefined) {
    const liveMode = mode ?? (status === 'ENABLING' ? declared.mode : undefined);
    if (liveMode !== undefined) block['Mode'] = liveMode;
  }
  return block;
}

/** The replica members a read-back written before #5381 never held. */
const READBACK_5381_MEMBERS = [
  'SSESpecification',
  'TableClass',
  'DeletionProtectionEnabled',
  TABLE_POLICY_KEY,
  REPLICA_STREAM_KEY,
] as const;

/**
 * Nested members a pre-#5381 read-back left out of a block it did emit, with
 * the block's on / off flag: completed only where both sides agree on it, so a
 * disabled baseline block never gains an enabled-only member.
 */
const READBACK_5381_NESTED: ReadonlyArray<readonly [string, string, string]> = [
  [PITR_KEY, 'RecoveryPeriodInDays', 'PointInTimeRecoveryEnabled'],
  [CONTRIBUTOR_INSIGHTS_KEY, 'Mode', 'Enabled'],
];

/**
 * Whether a drift baseline was written by a pre-#5381 read-back. That read-back
 * put the deploy region's `TableClass` / `DeletionProtectionEnabled` at the TOP
 * level (`DescribeTable` always reports the protection flag) and spelled a
 * cross-region replica's key as a flat `Replicas[].KMSMasterKeyId`; the
 * current one does neither, and the CFn schema has none of the three.
 */
export function isPre5381ReplicaBaseline(baseline: Record<string, unknown>): boolean {
  if ('TableClass' in baseline || 'DeletionProtectionEnabled' in baseline) return true;
  const replicas = baseline['Replicas'];
  return Array.isArray(replicas) && replicas.some((r) => isPlainObject(r) && 'KMSMasterKeyId' in r);
}

/**
 * Bring a pre-#5381 drift baseline to the current read-back shape
 * (go-to-k/cdkd#5381), or return it by identity when it is not one.
 *
 * - The top-level `TableClass` / `DeletionProtectionEnabled` move onto the
 *   `localRegion` entry (kept as recorded, so a change since is still drift)
 *   unless that entry already carries its own (see `localFromReadback`).
 * - A flat `KMSMasterKeyId` moves under `SSESpecification`.
 * - Every member the old read-back never emitted is completed from the SAME
 *   region's read-back entry: the baseline cannot say what it was, and left
 *   out it would be reported on every untouched table, and `drift --revert`
 *   (which passes its desired bag through here too) would send its absence
 *   as a removal.
 *
 * Pure and non-mutating. Only the entries it changes are copied.
 */
export function canonicalizePre5381ReplicaBaseline(
  baseline: Record<string, unknown>,
  aws: Record<string, unknown>,
  localRegion: string,
  // The local entry was copied from the read-back (a pre-#3573 baseline had
  // none): the recorded top-level values then REPLACE the live ones on it, so
  // a local class or protection changed since is still drift.
  localFromReadback = false
): Record<string, unknown> {
  if (!isPre5381ReplicaBaseline(baseline)) return baseline;
  const result: Record<string, unknown> = { ...baseline };
  const topLevel: Record<string, unknown> = {};
  for (const key of ['TableClass', 'DeletionProtectionEnabled']) {
    if (key in result) {
      topLevel[key] = result[key];
      delete result[key];
    }
  }
  const replicas = result['Replicas'];
  if (!Array.isArray(replicas)) return result;
  const awsReplicas = Array.isArray(aws['Replicas']) ? (aws['Replicas'] as unknown[]) : [];
  result['Replicas'] = replicas.map((element) => {
    if (!isPlainObject(element)) return element;
    const region = element['Region'];
    const entry: Record<string, unknown> = { ...element };
    if (region === localRegion && localRegion !== '') {
      for (const [key, value] of Object.entries(topLevel)) {
        if (localFromReadback || !(key in entry)) entry[key] = value;
      }
    }
    if ('KMSMasterKeyId' in entry) {
      const key = entry['KMSMasterKeyId'];
      delete entry['KMSMasterKeyId'];
      if (!('SSESpecification' in entry)) entry['SSESpecification'] = { KMSMasterKeyId: key };
    }
    const live = awsReplicas.find(
      (r): r is Record<string, unknown> => isPlainObject(r) && r['Region'] === region
    );
    if (live !== undefined) {
      for (const member of READBACK_5381_MEMBERS) {
        if (!(member in entry) && member in live) entry[member] = structuredClone(live[member]);
      }
      for (const [block, member, flag] of READBACK_5381_NESTED) {
        const mine = entry[block];
        const theirs = live[block];
        if (
          isPlainObject(mine) &&
          isPlainObject(theirs) &&
          !(member in mine) &&
          member in theirs &&
          mine[flag] === theirs[flag]
        ) {
          entry[block] = { ...mine, [member]: theirs[member] };
        }
      }
    }
    return entry;
  });
  return result;
}

/** Replica members a `drift --revert` desired side may omit only because they were not read. */
const UNREAD_REPLICA_MEMBERS = ['TableClass', 'DeletionProtectionEnabled', 'SSESpecification'];

/**
 * `drift --revert`'s desired side, with each replica member it OMITS taken from
 * the same region's live (previous) entry (go-to-k/cdkd#5381). That side is a
 * recorded read-back, or a template when the record has none, overlaid onto
 * the live read-back; `Replicas` is replaced whole, so a member the record
 * never held (a regional read that failed, a template that never declared the
 * class or protection, a period AWS had not reported yet) would otherwise
 * read as REMOVED to `update()`, which resets the class to `STANDARD`, turns
 * protection off, or sends recovery without its period (DynamoDB's default).
 * A revert restores what was recorded and nothing it did not record.
 *
 * Pure; identity when nothing is completed.
 */
export function keepUnreadReplicaMembers(
  desired: Record<string, unknown>,
  previous: Record<string, unknown>
): Record<string, unknown> {
  const replicas = desired['Replicas'];
  const prevReplicas = previous['Replicas'];
  if (!Array.isArray(replicas) || !Array.isArray(prevReplicas)) return desired;
  const sse = desired['SSESpecification'];
  const sseOn = isPlainObject(sse) && coerceCfnBoolean(sse['SSEEnabled']) !== false;
  let changed = false;
  const completed = replicas.map((element: unknown) => {
    if (!isPlainObject(element)) return element;
    const live = prevReplicas.find(
      (r: unknown): r is Record<string, unknown> =>
        isPlainObject(r) && r['Region'] === element['Region']
    );
    if (live === undefined) return element;
    const entry: Record<string, unknown> = { ...element };
    let touched = false;
    for (const member of UNREAD_REPLICA_MEMBERS) {
      // A key is unread only while the desired side has KMS encryption on:
      // with SSE off or absent there, no key IS what was recorded.
      if (member === 'SSESpecification' && !sseOn) continue;
      if (!(member in entry) && member in live) {
        entry[member] = structuredClone(live[member]);
        touched = true;
      }
    }
    const pitr = entry[PITR_KEY];
    const wantPitr = readPitrSpec(pitr);
    const livePitr = readPitrSpec(live[PITR_KEY]);
    if (
      isPlainObject(pitr) &&
      wantPitr.kind === 'usable' &&
      wantPitr.enabled &&
      wantPitr.recoveryPeriodInDays === undefined &&
      livePitr.kind === 'usable' &&
      livePitr.enabled &&
      livePitr.recoveryPeriodInDays !== undefined
    ) {
      entry[PITR_KEY] = { ...pitr, RecoveryPeriodInDays: livePitr.recoveryPeriodInDays };
      touched = true;
    }
    if (!touched) return element;
    changed = true;
    return entry;
  });
  return changed ? { ...desired, Replicas: completed } : desired;
}
