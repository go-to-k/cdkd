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

function samePolicyDocument(left: string, right: string): boolean {
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
 * resource policy is DELETED. Because the rule is symmetric in its two sides, a
 * rollback — which replays `update()` with the sides swapped — restores the old
 * setting through the same arms.
 *
 * `fresh` says the replica was created by THIS operation: it holds nothing yet,
 * so nothing is turned off and the previous side is irrelevant.
 * `streamReplaced` says the replica's stream arn MAY have changed (a
 * `StreamViewType` change), so a declared stream policy is put again. A
 * removed one is still deleted: the stream may not have been replaced after
 * all, and a delete against a fresh stream finds nothing (`PolicyNotFound`).
 * `keepRecovery` skips the point-in-time recovery DISABLE a removal would
 * send: `cdkd drift --revert` builds the desired side from a read-back that
 * omits the member when its read failed, and turning recovery off deletes
 * every recovery point.
 *
 * An `unusable` desired block issues nothing for that setting and is reported
 * through `onUnusable` (only a state-borne caller reaches it: the template path
 * refuses it first).
 */
export function planReplicaSettingOps(
  desired: Record<string, unknown> | undefined,
  previous: Record<string, unknown> | undefined,
  options: { fresh: boolean; streamReplaced?: boolean; keepRecovery?: boolean },
  onUnusable: (reason: string) => void
): ReplicaSettingOp[] {
  const prev = options.fresh ? undefined : previous;
  const ops: ReplicaSettingOp[] = [];

  // Point-in-time recovery.
  const pitr = readPitrSpec(desired?.[PITR_KEY]);
  const prevPitr = readPitrSpec(prev?.[PITR_KEY]);
  if (pitr.kind === 'unusable') {
    onUnusable(pitr.reason);
  } else if (pitr.kind === 'absent') {
    if (prevPitr.kind !== 'absent' && options.keepRecovery !== true) {
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
  const ci = planContributorInsightsOp(
    readContributorInsightsSpec(desired?.[CONTRIBUTOR_INSIGHTS_KEY], CI_PATH),
    readContributorInsightsSpec(prev?.[CONTRIBUTOR_INSIGHTS_KEY], CI_PATH),
    onUnusable
  );
  // A new replica starts with Contributor Insights off.
  if (ci !== undefined && !(options.fresh && ci.action === 'DISABLE')) {
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
    if (prevKinesis.kind === 'usable') {
      ops.push({ kind: 'kinesisDisable', streamArn: prevKinesis.streamArn });
    }
  } else if (prevKinesis.kind === 'usable' && prevKinesis.streamArn === kinesis.streamArn) {
    if (kinesis.precision !== undefined && kinesis.precision !== prevKinesis.precision) {
      ops.push({
        kind: 'kinesisPrecision',
        streamArn: kinesis.streamArn,
        precision: kinesis.precision,
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
    del: ReplicaSettingOp
  ): void => {
    if (want.kind === 'unusable') {
      onUnusable(want.reason);
      return;
    }
    if (want.kind === 'absent') {
      if (had.kind !== 'absent') ops.push(del);
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
    { kind: 'deleteTablePolicy' }
  );
  policyOps(
    readStreamPolicy(desired),
    readStreamPolicy(prev),
    options.streamReplaced === true,
    (document) => ({ kind: 'putStreamPolicy', document }),
    { kind: 'deleteStreamPolicy' }
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
