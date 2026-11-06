/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return */
import { ABAC_DISABLED } from './metadata.js';
import {
  GetBucketAbacCommand,
  GetBucketAccelerateConfigurationCommand,
  GetBucketNotificationConfigurationCommand,
  GetBucketReplicationCommand,
  GetObjectLockConfigurationCommand,
  ListBucketAnalyticsConfigurationsCommand,
  ListBucketIntelligentTieringConfigurationsCommand,
  ListBucketInventoryConfigurationsCommand,
  ListBucketMetricsConfigurationsCommand,
} from '@aws-sdk/client-s3';
import type { S3BucketProvider } from '../s3-bucket-provider.js';
import { caughtErrorName } from './shared.js';
import { safeMsg } from '../../../utils/display-safe.js';

/**
 * Emit a notification item's event list in the CFn spelling (issue #1748).
 *
 * The SDK member is the LIST `Events`; CFn declares only the scalar `Event`
 * (`TopicConfiguration` is `{Event, Filter, Topic}`), which is what every
 * template — and therefore every state record written from one — carries. So
 * emitting `Events` unconditionally made the record and the readback disagree
 * on EVERY notification-configured bucket: `cdkd drift` re-reported it forever
 * and `--revert` re-issued the same Put, with nothing malformed to warn about.
 *
 * Reverse-mapping to the CFn spelling is the same answer the `Transitions`
 * sibling in `readLifecycle` already takes for `TransitionInDays`. The arity
 * rule is what keeps it lossless: a longer list has no CFn spelling, so it
 * stays `Events` — which is also what {@link foldNotificationEvents} leaves on
 * the desired side, so the two still meet.
 */
export function emitNotificationEvents(
  this: S3BucketProvider,
  target: Record<string, unknown>,
  events?: string[]
): void {
  if (events === undefined) return;
  if (events.length === 1) target['Event'] = events[0];
  else target['Events'] = events;
}
export async function readNotification(
  this: S3BucketProvider,
  bucket: string
): Promise<Record<string, unknown>> {
  const resp = await this.s3Client.send(
    new GetBucketNotificationConfigurationCommand({ Bucket: bucket })
  );
  const out: Record<string, unknown> = {};
  if (resp.TopicConfigurations && resp.TopicConfigurations.length > 0) {
    out['TopicConfigurations'] = resp.TopicConfigurations.map((t) => {
      const e: Record<string, unknown> = {};
      if (t.Id !== undefined) e['Id'] = t.Id;
      if (t.TopicArn !== undefined) e['Topic'] = t.TopicArn;
      this.emitNotificationEvents(e, t.Events);
      if (t.Filter) e['Filter'] = this.sdkNotifFilterToCfn(t.Filter);
      return e;
    });
  }
  if (resp.QueueConfigurations && resp.QueueConfigurations.length > 0) {
    out['QueueConfigurations'] = resp.QueueConfigurations.map((q) => {
      const e: Record<string, unknown> = {};
      if (q.Id !== undefined) e['Id'] = q.Id;
      if (q.QueueArn !== undefined) e['Queue'] = q.QueueArn;
      this.emitNotificationEvents(e, q.Events);
      if (q.Filter) e['Filter'] = this.sdkNotifFilterToCfn(q.Filter);
      return e;
    });
  }
  if (resp.LambdaFunctionConfigurations && resp.LambdaFunctionConfigurations.length > 0) {
    out['LambdaConfigurations'] = resp.LambdaFunctionConfigurations.map((l) => {
      const e: Record<string, unknown> = {};
      if (l.Id !== undefined) e['Id'] = l.Id;
      if (l.LambdaFunctionArn !== undefined) e['Function'] = l.LambdaFunctionArn;
      this.emitNotificationEvents(e, l.Events);
      if (l.Filter) e['Filter'] = this.sdkNotifFilterToCfn(l.Filter);
      return e;
    });
  }
  // Always-emit, and in the CFn shape (`{EventBridgeEnabled: <bool>}`) rather
  // than the SDK's empty-structure shape — cdkd's state baseline holds the
  // CFn spelling, so returning `{}` reported the boolean as permanently
  // missing on every EventBridge-enabled bucket (issue #1430). Emitting
  // `false` when the response omits the block keeps the disabled side
  // comparable too.
  //
  // ONE-TIME DRIFT ON UPGRADE, accepted deliberately. `cdkd drift` runs the
  // observed-properties path with `unionWalkObjects: true`, which walks the
  // union of baseline+AWS keys inside a nested object, so a state record
  // captured by an older binary reports one diff on the first run after
  // upgrading: `EventBridgeConfiguration: {}` vs `{EventBridgeEnabled: true}`
  // on an enabled bucket, or an added `EventBridgeConfiguration` on a bucket
  // with no such key at all. It is cosmetic — `--revert` re-sends the old
  // observed blob and the write side re-derives the same AWS state — and it
  // clears on the next `cdkd state refresh-observed`, `drift --accept`, or
  // ANY subsequent `cdkd deploy` (the engine persists refreshed
  // `observedProperties` even on the no-change path). The alternative (emit only when present) is
  // what caused the PERMANENT phantom drift this fixes.
  out['EventBridgeConfiguration'] = {
    EventBridgeEnabled: resp.EventBridgeConfiguration !== undefined,
  };
  return out;
}
export function sdkNotifFilterToCfn(
  this: S3BucketProvider,
  filter: unknown
): Record<string, unknown> {
  if (!filter || typeof filter !== 'object') return {};
  const f = filter as Record<string, unknown>;
  const key = f['Key'] as Record<string, unknown> | undefined;
  if (!key) return {};
  const filterRules = key['FilterRules'] as Array<{ Name?: string; Value?: string }> | undefined;
  if (!filterRules) return {};
  return {
    S3Key: {
      Rules: filterRules.map((r) => ({ Name: r.Name, Value: r.Value })),
    },
  };
}
export async function readReplication(
  this: S3BucketProvider,
  bucket: string
): Promise<Record<string, unknown>> {
  try {
    const resp = await this.s3Client.send(new GetBucketReplicationCommand({ Bucket: bucket }));
    const cfg = resp.ReplicationConfiguration;
    if (!cfg) return {};
    const out: Record<string, unknown> = {};
    if (cfg.Role !== undefined) out['Role'] = cfg.Role;
    if (cfg.Rules) {
      out['Rules'] = cfg.Rules.map((r) => {
        const ruleOut: Record<string, unknown> = {};
        if (r.ID !== undefined) ruleOut['Id'] = r.ID;
        if (r.Status !== undefined) ruleOut['Status'] = r.Status;
        if (r.Priority !== undefined) ruleOut['Priority'] = r.Priority;
        if (r.Prefix !== undefined) ruleOut['Prefix'] = r.Prefix;
        if (r.Destination) {
          const d: Record<string, unknown> = {};
          if (r.Destination.Bucket !== undefined) d['Bucket'] = r.Destination.Bucket;
          if (r.Destination.Account !== undefined) d['Account'] = r.Destination.Account;
          if (r.Destination.StorageClass !== undefined)
            d['StorageClass'] = r.Destination.StorageClass;
          // Issue #1495: the four blocks the write side now sends. Without
          // the read-back a bucket declaring any of them reports permanent
          // phantom drift that `--revert` would then keep re-applying.
          // Every member below is emitted ONLY when AWS actually returned it.
          // `drift-calculator.ts` compares arrays wholesale, and state.json's
          // JSON round-trip drops undefined keys — so echoing a member AWS
          // omitted would turn the whole `Rules` array into permanent drift.
          const acl = r.Destination.AccessControlTranslation;
          if (acl?.Owner !== undefined) {
            d['AccessControlTranslation'] = { Owner: acl.Owner };
          }
          const enc = r.Destination.EncryptionConfiguration;
          if (enc?.ReplicaKmsKeyID !== undefined) {
            d['EncryptionConfiguration'] = { ReplicaKmsKeyID: enc.ReplicaKmsKeyID };
          }
          const rtIn = r.Destination.ReplicationTime;
          if (rtIn) {
            const rt: Record<string, unknown> = {};
            if (rtIn.Status !== undefined) rt['Status'] = rtIn.Status;
            if (rtIn.Time?.Minutes !== undefined) rt['Time'] = { Minutes: rtIn.Time.Minutes };
            if (Object.keys(rt).length > 0) d['ReplicationTime'] = rt;
          }
          const metricsIn = r.Destination.Metrics;
          if (metricsIn) {
            const m: Record<string, unknown> = {};
            if (metricsIn.Status !== undefined) m['Status'] = metricsIn.Status;
            if (metricsIn.EventThreshold?.Minutes !== undefined) {
              m['EventThreshold'] = { Minutes: metricsIn.EventThreshold.Minutes };
            }
            if (Object.keys(m).length > 0) d['Metrics'] = m;
          }
          ruleOut['Destination'] = d;
        }
        if (r.SourceSelectionCriteria) {
          const criteria: Record<string, unknown> = {};
          const replicaMods = r.SourceSelectionCriteria.ReplicaModifications;
          if (replicaMods?.Status !== undefined) {
            criteria['ReplicaModifications'] = { Status: replicaMods.Status };
          }
          const sseKms = r.SourceSelectionCriteria.SseKmsEncryptedObjects;
          if (sseKms?.Status !== undefined) {
            criteria['SseKmsEncryptedObjects'] = { Status: sseKms.Status };
          }
          if (Object.keys(criteria).length > 0) ruleOut['SourceSelectionCriteria'] = criteria;
        }
        if (r.Filter) {
          const f = r.Filter as Record<string, unknown>;
          const cfnFilter: Record<string, unknown> = {};
          const and = f['And'] as Record<string, unknown> | undefined;
          const tagOnly = f['Tag'] as { Key?: string; Value?: string } | undefined;
          if (and) {
            // Round-trip back to the CFn-canonical combined-filter shape
            // `{ And: { Prefix?, TagFilters[] } }` (S3 SDK's `And.Tags` ->
            // CFn `And.TagFilters`) so it matches the template-derived
            // state.properties exactly and does not surface as phantom drift.
            // (The old code collapsed it to a top-level `{ Prefix, TagFilter }`
            // — not a valid CFn shape — and dropped every tag past the first.)
            const innerAnd: Record<string, unknown> = {};
            if (and['Prefix'] !== undefined) innerAnd['Prefix'] = and['Prefix'];
            const tags = and['Tags'] as Array<{ Key?: string; Value?: string }> | undefined;
            if (tags && tags.length > 0) innerAnd['TagFilters'] = tags;
            cfnFilter['And'] = innerAnd;
          } else if (tagOnly) {
            cfnFilter['TagFilter'] = tagOnly;
          } else if (f['Prefix'] !== undefined) {
            cfnFilter['Prefix'] = f['Prefix'];
          }
          if (Object.keys(cfnFilter).length > 0) ruleOut['Filter'] = cfnFilter;
        }
        if (r.DeleteMarkerReplication?.Status !== undefined) {
          ruleOut['DeleteMarkerReplication'] = {
            Status: r.DeleteMarkerReplication.Status,
          };
        }
        return ruleOut;
      });
    }
    return out;
  } catch (err) {
    const e = err as { name?: string };
    if (e.name === 'ReplicationConfigurationNotFoundError') return {};
    throw err;
  }
}

/**
 * Whether S3 reports Object Lock `Enabled` on the bucket: `true` / `false`,
 * or `undefined` when the read fails (logged at debug with the error class,
 * never its message). Each caller keeps its own failure policy
 * (go-to-k/cdkd#5395).
 */
export async function isLiveObjectLocked(
  this: S3BucketProvider,
  bucketName: string,
  unreadNote: '' | '; treating it as locked'
): Promise<boolean | undefined> {
  try {
    return (await this.readObjectLock(bucketName))['ObjectLockEnabled'] === 'Enabled';
  } catch (error) {
    this.logger.debug(
      safeMsg`Could not read the Object Lock configuration of bucket ${this.shown(bucketName)} back (${caughtErrorName(error)})${unreadNote}`
    );
    return undefined;
  }
}
export async function readObjectLock(
  this: S3BucketProvider,
  bucket: string
): Promise<Record<string, unknown>> {
  try {
    const resp = await this.s3Client.send(
      new GetObjectLockConfigurationCommand({ Bucket: bucket })
    );
    const cfg = resp.ObjectLockConfiguration;
    if (!cfg) return {};
    const out: Record<string, unknown> = {};
    if (cfg.ObjectLockEnabled !== undefined) out['ObjectLockEnabled'] = cfg.ObjectLockEnabled;
    if (cfg.Rule?.DefaultRetention) {
      const r = cfg.Rule.DefaultRetention;
      const retention: Record<string, unknown> = {};
      if (r.Mode !== undefined) retention['Mode'] = r.Mode;
      if (r.Days !== undefined) retention['Days'] = r.Days;
      if (r.Years !== undefined) retention['Years'] = r.Years;
      // Emitted in the CFn spelling the applier reads, or a template that
      // declares `DefaultEventHold` records a key this readback can never
      // report and `cdkd drift` reports the difference forever.
      if (r.DefaultEventHold !== undefined) {
        const eventHold: Record<string, unknown> = {};
        if (r.DefaultEventHold.Days !== undefined) eventHold['Days'] = r.DefaultEventHold.Days;
        if (r.DefaultEventHold.Years !== undefined) eventHold['Years'] = r.DefaultEventHold.Years;
        retention['DefaultEventHold'] = eventHold;
      }
      out['Rule'] = { DefaultRetention: retention };
    }
    return out;
  } catch (err) {
    const e = err as { name?: string };
    if (
      e.name === 'ObjectLockConfigurationNotFoundError' ||
      e.name === 'NoSuchBucketConfiguration'
    ) {
      return {};
    }
    throw err;
  }
}

/**
 * `undefined` on a failed read: a narrow drift role must not lose every
 * other readback of the bucket to a permission only ABAC users need. A
 * declared value then answers for the read, so it reports no phantom drift.
 */
export async function readAbacStatus(
  this: S3BucketProvider,
  bucket: string
): Promise<string | undefined> {
  try {
    const resp = await this.s3Client.send(new GetBucketAbacCommand({ Bucket: bucket }));
    return resp.AbacStatus?.Status ?? ABAC_DISABLED;
  } catch (err) {
    this.logger.debug(
      safeMsg`Could not read AbacStatus of ${this.shown(bucket)} (${caughtErrorName(err)})`
    );
    return undefined;
  }
}
export async function readAccelerate(
  this: S3BucketProvider,
  bucket: string
): Promise<Record<string, unknown>> {
  const resp = await this.s3Client.send(
    new GetBucketAccelerateConfigurationCommand({ Bucket: bucket })
  );
  // Always-emit placeholder. AWS-side default is "no acceleration" which
  // surfaces as Status=undefined. We emit `Suspended` (the semantic "off"
  // that AWS accepts on Put) so a console-side enable surfaces.
  return { AccelerationStatus: resp.Status ?? 'Suspended' };
}
export async function readMetricsList(
  this: S3BucketProvider,
  bucket: string
): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = [];
  let continuationToken: string | undefined;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const resp = await this.s3Client.send(
      new ListBucketMetricsConfigurationsCommand({
        Bucket: bucket,
        ContinuationToken: continuationToken,
      })
    );
    for (const c of resp.MetricsConfigurationList ?? []) {
      out.push(this.metricsSdkToCfn(c as unknown as Record<string, unknown>));
    }
    if (!resp.IsTruncated) break;
    continuationToken = resp.NextContinuationToken;
  }
  return out;
}
export function metricsSdkToCfn(
  this: S3BucketProvider,
  c: Record<string, unknown>
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (c['Id'] !== undefined) out['Id'] = c['Id'];
  const f = c['Filter'] as Record<string, unknown> | undefined;
  if (f) {
    const and = f['And'] as Record<string, unknown> | undefined;
    const tagOnly = f['Tag'] as { Key?: string; Value?: string } | undefined;
    if (and) {
      if (and['Prefix'] !== undefined) out['Prefix'] = and['Prefix'];
      if (and['Tags']) out['TagFilters'] = and['Tags'];
      if (and['AccessPointArn'] !== undefined) out['AccessPointArn'] = and['AccessPointArn'];
    } else if (tagOnly) {
      out['TagFilters'] = [tagOnly];
    } else {
      if (f['Prefix'] !== undefined) out['Prefix'] = f['Prefix'];
      if (f['AccessPointArn'] !== undefined) out['AccessPointArn'] = f['AccessPointArn'];
    }
  }
  return out;
}
export async function readAnalyticsList(
  this: S3BucketProvider,
  bucket: string
): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = [];
  let continuationToken: string | undefined;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const resp = await this.s3Client.send(
      new ListBucketAnalyticsConfigurationsCommand({
        Bucket: bucket,
        ContinuationToken: continuationToken,
      })
    );
    for (const c of resp.AnalyticsConfigurationList ?? []) {
      out.push(this.analyticsSdkToCfn(c as unknown as Record<string, unknown>));
    }
    if (!resp.IsTruncated) break;
    continuationToken = resp.NextContinuationToken;
  }
  return out;
}
export function analyticsSdkToCfn(
  this: S3BucketProvider,
  c: Record<string, unknown>
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (c['Id'] !== undefined) out['Id'] = c['Id'];
  const f = c['Filter'] as Record<string, unknown> | undefined;
  if (f) {
    const and = f['And'] as Record<string, unknown> | undefined;
    const tagOnly = f['Tag'] as { Key?: string; Value?: string } | undefined;
    if (and) {
      if (and['Prefix'] !== undefined) out['Prefix'] = and['Prefix'];
      if (and['Tags']) out['TagFilters'] = and['Tags'];
    } else if (tagOnly) {
      out['TagFilters'] = [tagOnly];
    } else if (f['Prefix'] !== undefined) {
      out['Prefix'] = f['Prefix'];
    }
  }
  const sca = c['StorageClassAnalysis'] as Record<string, unknown> | undefined;
  if (sca?.['DataExport']) {
    const dataExport = sca['DataExport'] as Record<string, unknown>;
    const dest = dataExport['Destination'] as Record<string, unknown> | undefined;
    const s3Dest = dest?.['S3BucketDestination'] as Record<string, unknown> | undefined;
    // The CFn `Destination` block is FLATTENED, exactly like its inventory
    // sibling below (issue #1670). This used to emit the SDK's nested
    // `{ S3BucketDestination: … }` wrapper, which the CFn schema does not
    // declare at all — `tests/fixtures/cfn-schemas/AWS-S3-Bucket.json` has
    // zero occurrences of that key, and its `nestedPropertyPaths` for
    // `AnalyticsConfigurations` end at
    // `StorageClassAnalysis.DataExport.Destination.{BucketAccountId,BucketArn,Format,Prefix}`.
    // So the WHOLE sub-object differed from any template-shaped or
    // effective-properties-shaped baseline on every comparison, and no
    // send-side record could ever converge with it.
    //
    // NOTE the SDK spells the account `BucketAccountId` here
    // (`AnalyticsS3BucketDestination`) but `AccountId` on the inventory side
    // (`InventoryS3BucketDestination`) — the two reverse mappers look alike
    // and are NOT interchangeable on that member.
    const dataExportCfn: Record<string, unknown> = {};
    if (dataExport['OutputSchemaVersion'] !== undefined) {
      dataExportCfn['OutputSchemaVersion'] = dataExport['OutputSchemaVersion'];
    }
    if (s3Dest) {
      const cfnDest: Record<string, unknown> = {};
      if (s3Dest['Bucket'] !== undefined) cfnDest['BucketArn'] = s3Dest['Bucket'];
      if (s3Dest['BucketAccountId'] !== undefined) {
        cfnDest['BucketAccountId'] = s3Dest['BucketAccountId'];
      }
      if (s3Dest['Format'] !== undefined) cfnDest['Format'] = s3Dest['Format'];
      if (s3Dest['Prefix'] !== undefined) cfnDest['Prefix'] = s3Dest['Prefix'];
      dataExportCfn['Destination'] = cfnDest;
    }
    out['StorageClassAnalysis'] = { DataExport: dataExportCfn };
  }
  return out;
}
export async function readIntelligentTieringList(
  this: S3BucketProvider,
  bucket: string
): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = [];
  let continuationToken: string | undefined;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const resp = await this.s3Client.send(
      new ListBucketIntelligentTieringConfigurationsCommand({
        Bucket: bucket,
        ContinuationToken: continuationToken,
      })
    );
    for (const c of resp.IntelligentTieringConfigurationList ?? []) {
      out.push(this.intelligentTieringSdkToCfn(c as unknown as Record<string, unknown>));
    }
    if (!resp.IsTruncated) break;
    continuationToken = resp.NextContinuationToken;
  }
  return out;
}
export function intelligentTieringSdkToCfn(
  this: S3BucketProvider,
  c: Record<string, unknown>
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (c['Id'] !== undefined) out['Id'] = c['Id'];
  if (c['Status'] !== undefined) out['Status'] = c['Status'];
  if (c['Tierings']) {
    const tierings = c['Tierings'] as Array<Record<string, unknown>>;
    out['Tierings'] = tierings.map((t) => ({
      AccessTier: t['AccessTier'],
      Days: t['Days'],
    }));
  }
  const f = c['Filter'] as Record<string, unknown> | undefined;
  if (f) {
    const and = f['And'] as Record<string, unknown> | undefined;
    const tagOnly = f['Tag'] as { Key?: string; Value?: string } | undefined;
    if (and) {
      if (and['Prefix'] !== undefined) out['Prefix'] = and['Prefix'];
      if (and['Tags']) out['TagFilters'] = and['Tags'];
    } else if (tagOnly) {
      out['TagFilters'] = [tagOnly];
    } else if (f['Prefix'] !== undefined) {
      out['Prefix'] = f['Prefix'];
    }
  }
  return out;
}
export async function readInventoryList(
  this: S3BucketProvider,
  bucket: string
): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = [];
  let continuationToken: string | undefined;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const resp = await this.s3Client.send(
      new ListBucketInventoryConfigurationsCommand({
        Bucket: bucket,
        ContinuationToken: continuationToken,
      })
    );
    for (const c of resp.InventoryConfigurationList ?? []) {
      out.push(this.inventorySdkToCfn(c as unknown as Record<string, unknown>));
    }
    if (!resp.IsTruncated) break;
    continuationToken = resp.NextContinuationToken;
  }
  return out;
}
export function inventorySdkToCfn(
  this: S3BucketProvider,
  c: Record<string, unknown>
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (c['Id'] !== undefined) out['Id'] = c['Id'];
  if (c['IsEnabled'] !== undefined) out['Enabled'] = c['IsEnabled'];
  if (c['IncludedObjectVersions'] !== undefined)
    out['IncludedObjectVersions'] = c['IncludedObjectVersions'];
  const schedule = c['Schedule'] as Record<string, unknown> | undefined;
  if (schedule?.['Frequency'] !== undefined) out['ScheduleFrequency'] = schedule['Frequency'];
  if (c['OptionalFields'] !== undefined) out['OptionalFields'] = c['OptionalFields'];
  const dest = c['Destination'] as Record<string, unknown> | undefined;
  const s3Dest = dest?.['S3BucketDestination'] as Record<string, unknown> | undefined;
  if (s3Dest) {
    const cfnDest: Record<string, unknown> = {};
    if (s3Dest['Bucket'] !== undefined) cfnDest['BucketArn'] = s3Dest['Bucket'];
    if (s3Dest['AccountId'] !== undefined) cfnDest['BucketAccountId'] = s3Dest['AccountId'];
    if (s3Dest['Format'] !== undefined) cfnDest['Format'] = s3Dest['Format'];
    if (s3Dest['Prefix'] !== undefined) cfnDest['Prefix'] = s3Dest['Prefix'];
    out['Destination'] = cfnDest;
  }
  const filter = c['Filter'] as Record<string, unknown> | undefined;
  if (filter?.['Prefix'] !== undefined) out['Prefix'] = filter['Prefix'];
  return out;
}
