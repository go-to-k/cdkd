import type { KinesisStreamProvider } from '../kinesis-provider.js';
import {
  DescribeStreamCommand,
  DescribeStreamSummaryCommand,
  ListTagsForStreamCommand,
  ResourceNotFoundException,
} from '@aws-sdk/client-kinesis';
import { isUsableAttemptedName } from '../../../state/unsettled-properties.js';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import { normalizeAwsTagsToCfn } from '../../import-helpers.js';
import type { ResourceNotFound } from '../../../types/resource.js';
import { RESOURCE_NOT_FOUND } from '../../../types/resource.js';
import { isUsableMetricsList, expandShardLevelMetrics } from './shared.js';

/**
 * Narrow the desired bag the same way the provisioning path does, so the
 * diff compares the EXPANDED metric list on both sides.
 *
 * Required paired half of the `effectiveProperties` above: without it, state
 * holds the seven expanded names while the template still says `ALL`, and
 * every later `cdkd deploy` / `cdkd diff` reads that as a user-made change.
 * Shares {@link expandShardLevelMetrics} rather than re-deriving the rule.
 */
export function canonicalizeDesiredProperties(
  this: KinesisStreamProvider,
  resourceType: string,
  properties: Record<string, unknown>
): Record<string, unknown> {
  if (resourceType !== 'AWS::Kinesis::Stream') return properties;
  if (!('DesiredShardLevelMetrics' in properties)) return properties;
  const expanded = expandShardLevelMetrics(properties['DesiredShardLevelMetrics']);
  if (expanded === properties['DesiredShardLevelMetrics']) return properties;
  return { ...properties, DesiredShardLevelMetrics: expanded };
}

/**
 * `DesiredShardLevelMetrics` is a SET: AWS returns it in an order that
 * matched neither the request order nor alphabetical when measured
 * (us-east-1, 2026-08-12), so comparing positionally would report drift on a
 * stream nobody touched.
 */
export function getDriftUnorderedPaths(
  this: KinesisStreamProvider,
  resourceType: string
): string[] {
  if (resourceType !== 'AWS::Kinesis::Stream') return [];
  return ['DesiredShardLevelMetrics'];
}

export async function readUnsettled(
  this: KinesisStreamProvider,
  physicalId: string,
  logicalId: string,
  resourceType: string,
  names: ReadonlySet<string>,
  recordedProperties?: Record<string, unknown>,
  desiredProperties?: Record<string, unknown>,
  attemptedItems?: ReadonlyMap<string, ReadonlySet<string>>
): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
  const live = await this.readCurrentState(physicalId, logicalId, resourceType);
  if (typeof live !== 'object' || live === null) return live;
  const out: Record<string, unknown> = { ...live };
  // go-to-k/cdkd#5503: the live metrics, projected onto the ones the record
  // or the template names. This value becomes the previous side, and
  // `update()` disables every previous metric the template lacks, so one
  // enabled out of band would be DISABLED. CloudFormation leaves it enabled
  // (CFn A/B, us-east-1, 2026-10-29: OutgoingBytes enabled out of band,
  // then an update from [IncomingBytes] to [IncomingBytes, IncomingRecords]
  // left all three enabled).
  if (names.has('DesiredShardLevelMetrics') && Array.isArray(out['DesiredShardLevelMetrics'])) {
    const named = new Set(
      [recordedProperties, desiredProperties].flatMap((bag) => {
        const expanded = expandShardLevelMetrics(bag?.['DesiredShardLevelMetrics']);
        return isUsableMetricsList(expanded) ? expanded : [];
      })
    );
    // go-to-k/cdkd#5498: a metric an earlier failed update's accepted call
    // enabled (exact name) is on the previous side too, so the template's
    // omission disables it; one enabled out of band still is not. The
    // writer records expanded names only, so an attempted `ALL` is not one
    // cdkd wrote and names nothing.
    for (const metric of attemptedItems?.get('DesiredShardLevelMetrics') ?? []) {
      if (metric !== 'ALL' && isUsableAttemptedName(metric)) named.add(metric);
    }
    // The live list is expanded too: a stream enabled with `ALL` can report
    // the literal, which would otherwise be projected away and read as
    // "nothing enabled".
    const liveMetrics = expandShardLevelMetrics(out['DesiredShardLevelMetrics']);
    out['DesiredShardLevelMetrics'] = (
      Array.isArray(liveMetrics) ? (liveMetrics as unknown[]) : []
    ).filter((metric) => typeof metric === 'string' && named.has(metric));
  }
  if (!names.has('ShardCount')) return out;
  return { ...out, ShardCount: await this.getOpenShardCount(physicalId) };
}

/**
 * go-to-k/cdkd#5487: while the stream reads UPDATING (a shard-count, mode,
 * retention, encryption, record-size, distribution or metrics change still
 * running), every unsettled key but `Tags` is still changing. A failed read
 * keeps every name, which only costs the next deploy a re-send.
 */
export async function unsettledInTransition(
  this: KinesisStreamProvider,
  physicalId: string,
  _logicalId: string,
  _resourceType: string,
  names: ReadonlySet<string>
): Promise<ReadonlySet<string>> {
  try {
    const resp = await this.getClient().send(
      new DescribeStreamSummaryCommand({ StreamName: physicalId })
    );
    const status = resp.StreamDescriptionSummary?.StreamStatus;
    if (status !== 'UPDATING' && status !== 'CREATING') return new Set();
    return new Set([...names].filter((name) => name !== 'Tags'));
  } catch {
    return names;
  }
}

/**
 * Read the AWS-current Kinesis stream configuration in CFn-property shape.
 *
 * Issues `DescribeStream` and surfaces the keys cdkd's `create()`
 * accepts: `Name`, `StreamModeDetails`, `ShardCount`, `RetentionPeriodHours`,
 * `StreamEncryption`, and `DesiredShardLevelMetrics`. Tags are surfaced via a
 * follow-up `ListTagsForStream` with `aws:*` filtered out, and
 * `MaxRecordSizeInKiB` via a follow-up `DescribeStreamSummary` (the field is
 * absent from `DescribeStream`'s `StreamDescription` shape).
 *
 * `ShardCount` is reported as the count of `Shards[]` in the stream
 * description (only present for PROVISIONED-mode streams; ON_DEMAND
 * mode reports an empty list).
 *
 * Returns `RESOURCE_NOT_FOUND` when the stream is gone (`ResourceNotFoundException`).
 *
 * `AWS::Kinesis::StreamConsumer` is intentionally not handled here: this
 * provider only registers `AWS::Kinesis::Stream`, so consumer resources
 * route to the CC API fallback for drift detection (CC API's `GetResource`
 * surfaces every Kinesis consumer attribute the user can configure). A
 * dedicated SDK impl would require building out create/update/delete first;
 * out of scope for PR G.
 */
export async function readCurrentState(
  this: KinesisStreamProvider,
  physicalId: string,
  _logicalId: string,
  resourceType: string,
  _properties?: Record<string, unknown>
): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
  if (resourceType !== 'AWS::Kinesis::Stream') return undefined;

  let stream;
  try {
    const resp = await this.getClient().send(new DescribeStreamCommand({ StreamName: physicalId }));
    stream = resp.StreamDescription;
  } catch (err) {
    if (err instanceof ResourceNotFoundException) return RESOURCE_NOT_FOUND;
    throw err;
  }
  if (!stream) return undefined;

  const result: Record<string, unknown> = {};
  if (stream.StreamName !== undefined) result['Name'] = stream.StreamName;
  const streamMode = stream.StreamModeDetails?.StreamMode;
  if (streamMode !== undefined) {
    result['StreamModeDetails'] = { StreamMode: streamMode };
  }
  // Class 1 — `ShardCount` is PROVISIONED-only. AWS rejects
  // `UpdateShardCount` on ON_DEMAND streams; emitting a `ShardCount`
  // placeholder there would surface as a `cdkd drift --revert`
  // failure on the round-trip. ON_DEMAND streams report shards too
  // (capacity is managed by AWS), so gating on `Shards.length` is
  // not enough — the type discriminator is `StreamMode`.
  if (streamMode === 'PROVISIONED' && stream.Shards && stream.Shards.length > 0) {
    result['ShardCount'] = stream.Shards.length;
  }
  if (stream.RetentionPeriodHours !== undefined) {
    result['RetentionPeriodHours'] = stream.RetentionPeriodHours;
  }
  {
    const encryption: Record<string, unknown> = {
      EncryptionType: stream.EncryptionType ?? 'NONE',
    };
    if (stream.KeyId !== undefined) encryption['KeyId'] = stream.KeyId;
    result['StreamEncryption'] = encryption;
  }

  // Enhanced monitoring comes back as a list of `{ ShardLevelMetrics }`
  // groups; flatten to the flat CFn list shape. Always emitted (as `[]` when
  // nothing is enabled) so a console-side enable is detectable on a stream
  // whose template DECLARES the property. It cannot manufacture drift on one
  // that does not: an undeclared key captured EMPTY is dropped from the
  // comparison by `undeclaredEmptyObservedKeys`, and the `properties`
  // fallback baseline never holds the key. The flip side of that guard is
  // that a console-side enable on an UNDECLARED property is not detectable.
  result['DesiredShardLevelMetrics'] = (stream.EnhancedMonitoring ?? []).flatMap(
    (entry) => entry.ShardLevelMetrics ?? []
  );

  // `MaxRecordSizeInKiB` is on the SUMMARY shape only — `DescribeStream`'s
  // `StreamDescription` does not carry it — so it needs its own call.
  //
  // A non-not-found failure RETHROWS, matching the `DescribeStream` arm
  // above. Swallowing it would return a snapshot missing the key while state
  // declares it, which `cdkd drift` reports as `2048 -> undefined` and
  // `--accept` then erases from the baseline — a throttle turned into data
  // loss. This read is the third Kinesis call per stream, so throttling is a
  // realistic trigger rather than a theoretical one.
  try {
    const summaryResp = await this.getClient().send(
      new DescribeStreamSummaryCommand({ StreamName: physicalId })
    );
    const maxRecordSize = summaryResp.StreamDescriptionSummary?.MaxRecordSizeInKiB;
    if (maxRecordSize !== undefined) result['MaxRecordSizeInKiB'] = maxRecordSize;
    // go-to-k/cdkd#2762: present for ON_DEMAND streams only, so
    // emit-when-present.
    const strategy = summaryResp.StreamDescriptionSummary?.RecordDistributionStrategy;
    if (strategy !== undefined) result['RecordDistributionStrategy'] = strategy;
  } catch (err) {
    if (err instanceof ResourceNotFoundException) return RESOURCE_NOT_FOUND;
    throw err;
  }

  // Tags via ListTagsForStream.
  try {
    const tagsResp = await this.getClient().send(
      new ListTagsForStreamCommand({ StreamName: physicalId })
    );
    const tags = normalizeAwsTagsToCfn(tagsResp.Tags);
    result['Tags'] = tags;
  } catch (err) {
    if (err instanceof ResourceNotFoundException) return RESOURCE_NOT_FOUND;
    this.logger.debug(
      `Kinesis ListTagsForStream(${physicalId}) failed: ${describeAwsFailure(err).detail}`
    );
  }
  return result;
}
