import type { MetricsName, RecordDistributionStrategy } from '@aws-sdk/client-kinesis';
import { maskDeep, type MaskerFn } from '../../masked-retry-logger.js';

/**
 * Class 1/2 sanitize for `StreamEncryption` placeholder.
 *
 * `readCurrentState` always-emits `StreamEncryption: { EncryptionType:
 * 'NONE' }` for unencrypted streams so the drift comparator can detect
 * a console-side KMS attach (state-keys-only top-level walk needs the
 * key present). On the write side, neither `StartStreamEncryption`
 * (KMS-only) nor `StopStreamEncryption` accepts `NONE` as input —
 * pushing the placeholder through `cdkd drift --revert` would trigger
 * a ValidationException. This helper returns true only when the value
 * represents real KMS encryption (sibling discriminator `EncryptionType
 * === 'KMS'`); the create / update code paths gate every encryption-
 * mutating SDK call on it.
 */
export function isKmsEncryption(value: Record<string, unknown> | undefined): boolean {
  if (!value) return false;
  return value['EncryptionType'] === 'KMS';
}

/**
 * The seven shard-level metrics `ALL` expands to.
 *
 * MEASURED, not copied from the docs (us-east-1, 2026-08-12): an
 * `EnableEnhancedMonitoring(ShardLevelMetrics: ['ALL'])` responds with exactly
 * these seven in `DesiredShardLevelMetrics`, and once the stream settles back
 * to ACTIVE `DescribeStream` reports the same seven — never the literal `ALL`.
 * The readback order is AWS-chosen and matched neither the input order nor
 * alphabetical, which is why the type also declares the path unordered (see
 * {@link KinesisStreamProvider.getDriftUnorderedPaths}).
 */
export const ALL_SHARD_LEVEL_METRICS: readonly string[] = [
  'IncomingBytes',
  'IncomingRecords',
  'OutgoingBytes',
  'OutgoingRecords',
  'WriteProvisionedThroughputExceeded',
  'ReadProvisionedThroughputExceeded',
  'IteratorAgeMilliseconds',
];

/**
 * Whether a value is a usable shard-level-metrics list: an array whose every
 * element is a string.
 *
 * A MIXED array (`['IncomingBytes', {Ref: 'X'}]`) is deliberately UNUSABLE
 * rather than partially usable. Filtering the unresolved element away would put
 * a list on the wire that the template never declared, while state recorded the
 * declared one — the permanent phantom drift `effectiveProperties` exists to
 * prevent, arrived at through the back door.
 */
export function isUsableMetricsList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

/**
 * Expand the `ALL` shard-level-metrics shorthand into the seven metric names
 * AWS actually stores.
 *
 * This is the ONE definition of the rule, shared by the provisioning path (what
 * goes on the wire, and therefore what `effectiveProperties` records) and by
 * {@link KinesisStreamProvider.canonicalizeDesiredProperties} (what the diff
 * compares). Deriving it twice is how state and template end up narrowed
 * differently — see the `effectiveProperties` contract in
 * `.claude/rules/providers.md`.
 *
 * Idempotent: an already-expanded list is returned with its own values (deduped
 * and otherwise untouched), so a state-borne bag that has been through this
 * before is unchanged. An UNUSABLE value is returned as-is — the callers that
 * put bytes on the wire refuse it via {@link readShardLevelMetrics} rather than
 * sending a partial list, and `canonicalizeDesiredProperties` must stay a total
 * function because the diff runs on bags no provider validated.
 */
export function expandShardLevelMetrics(value: unknown): unknown {
  if (!isUsableMetricsList(value)) return value;

  const names = value;
  const expanded = names.includes('ALL')
    ? [...names.filter((n) => n !== 'ALL'), ...ALL_SHARD_LEVEL_METRICS]
    : names;

  // Dedupe while preserving first-seen order: `['ALL', 'IncomingBytes']` is a
  // legal template and must not send the same metric twice.
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const name of expanded) {
    if (seen.has(name)) continue;
    seen.add(name);
    deduped.push(name);
  }

  // Preserve identity when nothing changed, so callers can cheaply detect a
  // no-op expansion and skip returning `effectiveProperties`.
  if (deduped.length === names.length && deduped.every((n, i) => n === names[i])) return value;
  return deduped;
}

/**
 * The three answers a caller needs about the declared metric list, kept
 * DISTINCT because two of them look identical once flattened to an array and
 * the difference is destructive.
 *
 * `absent` means the template does not declare the property — on update that is
 * a REMOVAL and every live metric should be disabled. `unusable` means the
 * property IS declared but cannot be read; flattening that to an empty list
 * would disable every live metric on the strength of a value cdkd could not
 * parse. Same array, opposite intent.
 */
export type ShardLevelMetricsRead =
  | { kind: 'absent' }
  | { kind: 'usable'; metrics: MetricsName[]; expanded: unknown }
  | { kind: 'unusable'; reason: string };

/**
 * Classify a declared `DesiredShardLevelMetrics` value, expanding `ALL` when it
 * is usable.
 *
 * Callers own the ACTION per the update-path rules in
 * `.claude/rules/providers.md`: a create refuses an unusable value (it is
 * template-borne), an update WARNS and skips (it may be replaying a state
 * record, where refusing would leave the resource un-rollbackable). The
 * previous side is never routed through the refusal at all — see
 * {@link previousMetricNames}.
 */
export function readShardLevelMetrics(value: unknown, mask: MaskerFn): ShardLevelMetricsRead {
  if (value == null) return { kind: 'absent' };
  if (!isUsableMetricsList(value)) {
    return {
      kind: 'unusable',
      reason:
        `AWS::Kinesis::Stream DesiredShardLevelMetrics must be an array of metric-name ` +
        `strings, got ${JSON.stringify(maskDeep(value, mask))}`,
    };
  }
  const expanded = expandShardLevelMetrics(value);
  return { kind: 'usable', metrics: expanded as MetricsName[], expanded };
}

/**
 * Read the PREVIOUS side leniently: it comes from cdkd state, not the user's
 * template, so an unreadable value recorded by an older binary must never
 * refuse the update (the #1471 desired-side-only rule). An unusable previous
 * side simply contributes no metrics to disable.
 */
export function previousMetricNames(value: unknown): MetricsName[] {
  const expanded = expandShardLevelMetrics(value);
  return isUsableMetricsList(expanded) ? (expanded as MetricsName[]) : [];
}

/**
 * AWS's `MaxRecordSizeInKiB` for a stream that declares none, and what
 * CloudFormation resets a removed one to (go-to-k/cdkd#1160, CFn A/B).
 */
export const DEFAULT_MAX_RECORD_SIZE_KIB = 1024;

/**
 * The `MaxRecordSizeInKiB` twin of {@link readShardLevelMetrics}, with the same
 * three answers and for the same reason.
 *
 * A bare `Number(...)` is NOT enough here even though the sibling `ShardCount`
 * uses one: `Number('')` and `Number([])` are `0` and `Number(true)` is `1`, so
 * a malformed value would go on the wire as a plausible-looking size, while
 * `'abc'` / `{}` would yield `NaN` and silently OMIT the field — the stream
 * gets AWS's default while state records the declared junk, which is exactly
 * the silent-drop class issue #609 exists to close.
 *
 * So a NUMBER (or a numeric STRING, which CFn's scalar coercion makes a
 * legitimate template shape cdkd does not perform itself) is `usable`; anything
 * else present is `unusable` and the caller refuses it on the template path.
 */
export type MaxRecordSizeRead =
  | { kind: 'absent' }
  | { kind: 'usable'; size: number }
  | { kind: 'unusable'; reason: string };

export function readMaxRecordSize(value: unknown, mask: MaskerFn): MaxRecordSizeRead {
  if (value == null) return { kind: 'absent' };
  if (typeof value === 'number' && Number.isFinite(value)) return { kind: 'usable', size: value };
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    if (Number.isFinite(n)) return { kind: 'usable', size: n };
  }
  return {
    kind: 'unusable',
    reason:
      `AWS::Kinesis::Stream MaxRecordSizeInKiB must be a number, got ` +
      `${JSON.stringify(maskDeep(value, mask))}`,
  };
}

/**
 * Shape read for the post-`CreateStream` follow-up calls the pre-flight covers
 * (go-to-k/cdkd#1710). `Tags` is refused by `refuseMalformedDesiredTags`.
 */
export type FollowUpRead =
  | { kind: 'absent' }
  | { kind: 'usable'; hours?: number }
  | { kind: 'unusable'; reason: string };

/**
 * Refuse a `RetentionPeriodHours` the retention call cannot take
 * (go-to-k/cdkd#1710).
 *
 * The retention change runs AFTER `CreateStream`, so a non-numeric value
 * failed against a stream that already exists. A numeric STRING is usable and
 * converted, as `readMaxRecordSize` does: CFn's scalar coercion makes it a
 * legitimate template shape (a `Ref` to a `Number` parameter resolves to
 * one), and the API field is a number. The RANGE is AWS's to judge.
 */
export function readRetentionHours(value: unknown, mask: MaskerFn): FollowUpRead {
  if (value == null) return { kind: 'absent' };
  if (typeof value === 'number' && Number.isFinite(value)) return { kind: 'usable', hours: value };
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
    return { kind: 'usable', hours: Number(value) };
  }
  return {
    kind: 'unusable',
    reason:
      `AWS::Kinesis::Stream RetentionPeriodHours must be a number, got ` +
      `${JSON.stringify(maskDeep(value, mask))}`,
  };
}

/**
 * Refuse a KMS `StreamEncryption` block with no usable `KeyId`
 * (go-to-k/cdkd#1710).
 *
 * `StartStreamEncryption` runs AFTER `CreateStream`, so a KMS block missing
 * its key sent `KeyId: undefined` against a live stream. Only a block that
 * selects KMS is read: that is the only branch that issues the call.
 */
export function readEncryptionKeyId(
  value: Record<string, unknown> | undefined,
  mask: MaskerFn
): FollowUpRead {
  if (!isKmsEncryption(value)) return { kind: 'absent' };
  const keyId = value?.['KeyId'];
  if (typeof keyId === 'string' && keyId.trim() !== '') return { kind: 'usable' };
  return {
    kind: 'unusable',
    reason:
      `AWS::Kinesis::Stream StreamEncryption selects KMS but KeyId is not a non-empty string, ` +
      `got ${JSON.stringify(maskDeep(keyId, mask)) ?? 'undefined'}`,
  };
}

/**
 * The comparison-side read: the UPDATE path needs both sides reduced to the
 * same shape so a state record holding the number and a template holding the
 * numeric string do not read as a change and re-issue the call every deploy.
 * Unusable / absent both yield `undefined`, which the caller treats as "no
 * declared size" rather than refusing — the previous side is state-borne.
 */
export function comparableRecordSize(value: unknown, mask: MaskerFn): number | undefined {
  // The masker is threaded even though this arm never reads `reason`: the
  // reader BUILDS the message either way, so leaving it unmasked here would
  // make the walk's coverage depend on which field a caller happens to read.
  const read = readMaxRecordSize(value, mask);
  return read.kind === 'usable' ? read.size : undefined;
}

/**
 * `RecordDistributionStrategy`'s documented default (CreateStream: "If you do
 * not specify this parameter, the stream uses `USER_PARTITION_KEY`"). A CFn
 * A/B (us-east-1, go-to-k/cdkd#2762) showed CloudFormation RESETS a removed
 * `AUTO` to it, so a template removal sends it.
 */
export const DEFAULT_RECORD_DISTRIBUTION_STRATEGY = 'USER_PARTITION_KEY';

/**
 * The `RecordDistributionStrategy` read (go-to-k/cdkd#2762), with the same
 * three answers as {@link readShardLevelMetrics}. The value set is AWS's to
 * judge (`AUTO` / `USER_PARTITION_KEY` today), so only the SHAPE is checked: a
 * non-empty string is `usable`, anything else present `unusable` — an
 * unresolved intrinsic must not reach the wire as `[object Object]`.
 */
export type DistributionStrategyRead =
  | { kind: 'absent' }
  | { kind: 'usable'; strategy: RecordDistributionStrategy }
  | { kind: 'unusable'; reason: string };

export function readDistributionStrategy(value: unknown, mask: MaskerFn): DistributionStrategyRead {
  if (value == null) return { kind: 'absent' };
  if (typeof value === 'string' && value.trim() !== '') {
    return { kind: 'usable', strategy: value as RecordDistributionStrategy };
  }
  return {
    kind: 'unusable',
    reason:
      `AWS::Kinesis::Stream RecordDistributionStrategy must be a non-empty string, got ` +
      `${JSON.stringify(maskDeep(value, mask))}`,
  };
}

/**
 * Poll cadence and cap for the post-delete gone-wait (issue #3872). The
 * DELETING window measured 4-7s (us-east-1), so the cap is generous headroom,
 * not an estimate, and sits well under the 30-min per-resource deadline.
 */
export const KINESIS_DELETE_POLL_INTERVAL_MS = 2_000;
export const KINESIS_DELETE_MAX_WAIT_MS = 5 * 60 * 1000;

/** A Kinesis stream name, as `CreateStream` accepts it (never an ARN). */
export function isStreamName(id: string): boolean {
  return /^[a-zA-Z0-9_.-]{1,128}$/.test(id);
}
