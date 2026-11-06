/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return */
import { ABAC_ENABLED, metadataConfigurationFromSdk } from './metadata.js';
import {
  GetBucketCorsCommand,
  GetBucketEncryptionCommand,
  GetBucketLifecycleConfigurationCommand,
  GetBucketLoggingCommand,
  GetBucketOwnershipControlsCommand,
  GetBucketTaggingCommand,
  GetBucketVersioningCommand,
  GetBucketWebsiteCommand,
  GetPublicAccessBlockCommand,
  HeadBucketCommand,
  NoSuchBucket,
} from '@aws-sdk/client-s3';
import { OWN_WRITE_HEAD_ATTEMPTS, OWN_WRITE_HEAD_DELAY_MS } from './create-identity.js';
import {
  RESOURCE_NOT_FOUND,
  type ReadCurrentStateContext,
  type ResourceNotFound,
} from '../../../types/resource.js';
import type { S3BucketProvider } from '../s3-bucket-provider.js';
import { displaySafe, safeMsg } from '../../../utils/display-safe.js';
import { normalizeAwsTagsToCfn } from '../../import-helpers.js';

/**
 * Read the AWS-current S3 bucket configuration in CFn-property shape.
 *
 * Issues a small handful of independent S3 GET calls and stitches them
 * into a single CFn-shaped object. Each call can throw a "feature not
 * configured" error (`NoSuchBucketConfiguration`,
 * `ServerSideEncryptionConfigurationNotFoundError`, `NoSuchTagSet`,
 * `NoSuchPublicAccessBlockConfiguration`, etc.) — those are caught
 * individually and the corresponding key is emitted as a CFn-shape
 * placeholder (per docs/provider-rules.md#readcurrentstate-for-drift-detection: always-emit
 * user-controllable top-level keys), NOT treated as the bucket being
 * absent.
 *
 * Only the bucket-gone case (`NoSuchBucket`, HTTP 404 from `HeadBucket`)
 * returns `undefined`.
 *
 * Coverage: `BucketName`, `VersioningConfiguration`, `BucketEncryption`,
 * `OwnershipControls`, `PublicAccessBlockConfiguration`, `Tags`, plus all 12
 * sub-configs:
 * `LifecycleConfiguration`, `CorsConfiguration`, `WebsiteConfiguration`,
 * `LoggingConfiguration`, `NotificationConfiguration`,
 * `ReplicationConfiguration`, `ObjectLockConfiguration`,
 * `AccelerateConfiguration`, `MetricsConfigurations`,
 * `AnalyticsConfigurations`, `IntelligentTieringConfigurations`,
 * `InventoryConfigurations`.
 */
export async function readCurrentState(
  this: S3BucketProvider,
  physicalId: string,
  logicalId: string,
  _resourceType: string,
  _properties?: Record<string, unknown>,
  context?: ReadCurrentStateContext
): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
  // Fast existence check. NotFound / NoSuchBucket (a HEAD's 404 carries no
  // body, so the status is its only answer) is the bucket deleted outside
  // cdkd (go-to-k/cdkd#4283). Right after cdkd's own write, a 404 is first
  // retried briefly (`OWN_WRITE_HEAD_ATTEMPTS`).
  const headAttempts = context?.afterOwnWrite === true ? OWN_WRITE_HEAD_ATTEMPTS : 1;
  for (let attempt = 1; ; attempt++) {
    try {
      await this.s3Client.send(new HeadBucketCommand({ Bucket: physicalId }));
      break;
    } catch (err) {
      const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
      if (
        err instanceof NoSuchBucket ||
        e.name === 'NotFound' ||
        e.name === 'NoSuchBucket' ||
        e.$metadata?.httpStatusCode === 404
      ) {
        if (attempt < headAttempts) {
          await new Promise((r) => setTimeout(r, OWN_WRITE_HEAD_DELAY_MS));
          continue;
        }
        if (headAttempts > 1) {
          // The capture maps this to "no baseline" without a word, so a lag
          // past the retry window would otherwise be invisible.
          this.logger.debug(
            safeMsg`HeadBucket still answered 404 after ${String(headAttempts)} attempts right after cdkd's own write; ` +
              safeMsg`no observed baseline is captured for ${displaySafe(logicalId)}`
          );
        }
        return RESOURCE_NOT_FOUND;
      }
      throw err;
    }
  }

  // Fire all 18 GET / List calls in parallel. Each helper handles its own
  // "feature not configured" → placeholder fallback.
  const [
    versioning,
    encryption,
    ownership,
    pab,
    tags,
    lifecycle,
    cors,
    website,
    logging,
    notification,
    replication,
    objectLock,
    accelerate,
    metrics,
    analytics,
    intelligentTier,
    inventory,
    abac,
    metadata,
  ] = await Promise.all([
    this.readVersioning(physicalId),
    this.readEncryption(physicalId),
    this.readOwnershipControls(physicalId),
    this.readPublicAccessBlock(physicalId),
    this.readTags(physicalId),
    this.readLifecycle(physicalId),
    this.readCors(physicalId),
    this.readWebsite(physicalId),
    this.readLogging(physicalId),
    this.readNotification(physicalId),
    this.readReplication(physicalId),
    this.readObjectLock(physicalId),
    this.readAccelerate(physicalId),
    this.readMetricsList(physicalId),
    this.readAnalyticsList(physicalId),
    this.readIntelligentTieringList(physicalId),
    this.readInventoryList(physicalId),
    this.readAbacStatus(physicalId),
    this.readMetadataForDrift(physicalId),
  ]);

  return {
    BucketName: physicalId,
    VersioningConfiguration: versioning,
    BucketEncryption: encryption,
    OwnershipControls: ownership,
    PublicAccessBlockConfiguration: pab,
    Tags: tags,
    LifecycleConfiguration: lifecycle,
    CorsConfiguration: cors,
    WebsiteConfiguration: website,
    LoggingConfiguration: logging,
    NotificationConfiguration: notification,
    ReplicationConfiguration: replication,
    ObjectLockConfiguration: objectLock,
    AccelerateConfiguration: accelerate,
    MetricsConfigurations: metrics,
    AnalyticsConfigurations: analytics,
    IntelligentTieringConfigurations: intelligentTier,
    InventoryConfigurations: inventory,
    // Only while away from the default, so a baseline an older cdkd captured
    // stays clean: `getDriftAbsentMeansDefaultKeys` still compares both.
    ...(abac === ABAC_ENABLED || _properties?.['AbacStatus'] !== undefined
      ? { AbacStatus: abac ?? _properties?.['AbacStatus'] }
      : {}),
    ...(metadata === 'unread'
      ? _properties?.['MetadataConfiguration'] !== undefined
        ? { MetadataConfiguration: _properties['MetadataConfiguration'] }
        : {}
      : metadata
        ? { MetadataConfiguration: metadataConfigurationFromSdk(metadata) }
        : {}),
  };
}

// -------------------------------------------------------------------
// readCurrentState helpers — one per sub-config. Each catches the
// "feature not configured" error and returns the always-emit
// placeholder shape per docs/provider-rules.md#readcurrentstate-for-drift-detection.
// -------------------------------------------------------------------

export async function readVersioning(
  this: S3BucketProvider,
  bucket: string
): Promise<Record<string, unknown>> {
  // VersioningConfiguration { Status }. Always emit a placeholder so a
  // console-side enable on a never-versioned bucket surfaces as drift.
  // 'Suspended' is the semantic "off" value in CFn.
  const resp = await this.s3Client.send(new GetBucketVersioningCommand({ Bucket: bucket }));
  return { Status: resp.Status ?? 'Suspended' };
}

/**
 * OwnershipControls { Rules: [{ ObjectOwnership }] }. Always emit a
 * placeholder (empty `Rules`) so a console-side change on a bucket that
 * declares the property surfaces as drift. Added with issue #1466 — without
 * a read here, `cdkd drift` could not see ownership controls at all, which
 * is why the removal bug that issue fixes produced no signal from ANY
 * command.
 */
export async function readOwnershipControls(
  this: S3BucketProvider,
  bucket: string
): Promise<Record<string, unknown>> {
  try {
    const resp = await this.s3Client.send(
      new GetBucketOwnershipControlsCommand({ Bucket: bucket })
    );
    return {
      Rules: (resp.OwnershipControls?.Rules ?? []).map((r) => ({
        ObjectOwnership: r.ObjectOwnership,
      })),
    };
  } catch (err) {
    const e = err as { name?: string };
    if (e.name === 'OwnershipControlsNotFoundError') {
      return { Rules: [] };
    }
    throw err;
  }
}
export async function readEncryption(
  this: S3BucketProvider,
  bucket: string
): Promise<Record<string, unknown>> {
  try {
    const resp = await this.s3Client.send(new GetBucketEncryptionCommand({ Bucket: bucket }));
    const rules = resp.ServerSideEncryptionConfiguration?.Rules ?? [];
    return {
      ServerSideEncryptionConfiguration: rules.map((rule) => {
        const out: Record<string, unknown> = {};
        const sse = rule.ApplyServerSideEncryptionByDefault;
        if (sse) {
          const sseOut: Record<string, unknown> = {};
          if (sse.SSEAlgorithm !== undefined) sseOut['SSEAlgorithm'] = sse.SSEAlgorithm;
          if (sse.KMSMasterKeyID !== undefined) sseOut['KMSMasterKeyID'] = sse.KMSMasterKeyID;
          out['ServerSideEncryptionByDefault'] = sseOut;
        }
        if (rule.BucketKeyEnabled !== undefined) out['BucketKeyEnabled'] = rule.BucketKeyEnabled;
        // Issue #1495: read back the block the write side now sends.
        if (rule.BlockedEncryptionTypes?.EncryptionType !== undefined) {
          out['BlockedEncryptionTypes'] = {
            EncryptionType: rule.BlockedEncryptionTypes.EncryptionType,
          };
        }
        return out;
      }),
    };
  } catch (err) {
    const e = err as { name?: string };
    if (e.name === 'ServerSideEncryptionConfigurationNotFoundError') {
      return { ServerSideEncryptionConfiguration: [] };
    }
    throw err;
  }
}
export async function readPublicAccessBlock(
  this: S3BucketProvider,
  bucket: string
): Promise<Record<string, unknown>> {
  try {
    const resp = await this.s3Client.send(new GetPublicAccessBlockCommand({ Bucket: bucket }));
    const cfg = resp.PublicAccessBlockConfiguration;
    return {
      BlockPublicAcls: cfg?.BlockPublicAcls ?? false,
      BlockPublicPolicy: cfg?.BlockPublicPolicy ?? false,
      IgnorePublicAcls: cfg?.IgnorePublicAcls ?? false,
      RestrictPublicBuckets: cfg?.RestrictPublicBuckets ?? false,
    };
  } catch (err) {
    const e = err as { name?: string };
    if (e.name === 'NoSuchPublicAccessBlockConfiguration') {
      return {
        BlockPublicAcls: false,
        BlockPublicPolicy: false,
        IgnorePublicAcls: false,
        RestrictPublicBuckets: false,
      };
    }
    throw err;
  }
}
export async function readTags(
  this: S3BucketProvider,
  bucket: string
): Promise<Array<{ Key: string; Value: string }>> {
  try {
    const resp = await this.s3Client.send(new GetBucketTaggingCommand({ Bucket: bucket }));
    return normalizeAwsTagsToCfn(resp.TagSet);
  } catch (err) {
    const e = err as { name?: string };
    if (e.name === 'NoSuchTagSet') return [];
    throw err;
  }
}
export async function readLifecycle(
  this: S3BucketProvider,
  bucket: string
): Promise<Record<string, unknown>> {
  try {
    const resp = await this.s3Client.send(
      new GetBucketLifecycleConfigurationCommand({ Bucket: bucket })
    );
    const rules = resp.Rules ?? [];
    const lifecycleOut: Record<string, unknown> = {};
    // Issue #1495: emit whatever AWS returns, unconditionally.
    //
    // The first cut filtered out `varies_by_storage_class` as "the account
    // default". That polarity is WRONG — AWS defaults new buckets (created
    // after September 2024) to `all_storage_classes_128K`, so the filter
    // suppressed the one value a template meaningfully declares and emitted
    // the real default for every bucket. A template declaring
    // `varies_by_storage_class` would then never read back, i.e. permanent
    // phantom drift on the `properties`-fallback baseline — exactly the
    // asymmetry this issue set out to remove.
    //
    // Emitting it even when the template never declared it is deliberate and
    // NOT free: `drift.ts` passes `unionWalkObjects` on the observed-baseline
    // path, so a new sub-key under the state-present `LifecycleConfiguration`
    // IS compared. The effect is the same one-time stale-observed-baseline
    // drift the `EventBridgeConfiguration` block below already documents, and
    // it clears on the next deploy — strictly better than the alternative,
    // where a template that DOES declare the value never reads it back and
    // drifts forever.
    if (resp.TransitionDefaultMinimumObjectSize !== undefined) {
      lifecycleOut['TransitionDefaultMinimumObjectSize'] = resp.TransitionDefaultMinimumObjectSize;
    }
    return {
      ...lifecycleOut,
      Rules: rules.map((r) => {
        const out: Record<string, unknown> = {};
        if (r.ID !== undefined) out['Id'] = r.ID;
        if (r.Status !== undefined) out['Status'] = r.Status;
        if (r.Prefix !== undefined) out['Prefix'] = r.Prefix;

        // Expiration — reverse-map the SDK's `Expiration` OBJECT back to the
        // CFn spellings, which are three RULE-LEVEL scalars (issue #1755).
        //
        // The CFn `Rule` definition declares `ExpirationDate` /
        // `ExpirationInDays` / `ExpiredObjectDeleteMarker` and has NO
        // `Expiration` member at all — the applier's acceptance of an
        // `Expiration` object is a cdkd-only tolerance — so emitting the SDK
        // shape here meant state and the readback carried different key sets
        // for essentially every lifecycle-configured bucket CDK creates, with
        // nothing malformed and no warning anywhere. Same decision the
        // `Transitions` sibling below already takes for `TransitionInDays`,
        // applied one member over; the alternative (recording the SDK shape)
        // would put a spelling in state that no CFn template can declare.
        //
        // ONE-TIME DRIFT ON UPGRADE for already-deployed buckets, the same
        // accepted cost the sibling reverse-map changes in this file document;
        // it clears on the next deploy.
        if (r.Expiration) {
          if (r.Expiration.Days !== undefined) out['ExpirationInDays'] = r.Expiration.Days;
          if (r.Expiration.Date !== undefined)
            out['ExpirationDate'] = r.Expiration.Date.toISOString();
          if (r.Expiration.ExpiredObjectDeleteMarker !== undefined)
            out['ExpiredObjectDeleteMarker'] = r.Expiration.ExpiredObjectDeleteMarker;
        }

        // Transitions
        if (r.Transitions && r.Transitions.length > 0) {
          out['Transitions'] = r.Transitions.map((t) => {
            const item: Record<string, unknown> = {};
            if (t.Days !== undefined) item['TransitionInDays'] = t.Days;
            if (t.Date !== undefined) item['TransitionDate'] = t.Date.toISOString();
            if (t.StorageClass !== undefined) item['StorageClass'] = t.StorageClass;
            return item;
          });
        }

        // NoncurrentVersionExpiration
        if (r.NoncurrentVersionExpiration) {
          const nve: Record<string, unknown> = {};
          if (r.NoncurrentVersionExpiration.NoncurrentDays !== undefined)
            nve['NoncurrentDays'] = r.NoncurrentVersionExpiration.NoncurrentDays;
          if (r.NoncurrentVersionExpiration.NewerNoncurrentVersions !== undefined)
            nve['NewerNoncurrentVersions'] = r.NoncurrentVersionExpiration.NewerNoncurrentVersions;
          out['NoncurrentVersionExpiration'] = nve;
        }

        // NoncurrentVersionTransitions
        if (r.NoncurrentVersionTransitions && r.NoncurrentVersionTransitions.length > 0) {
          out['NoncurrentVersionTransitions'] = r.NoncurrentVersionTransitions.map((nvt) => {
            const item: Record<string, unknown> = {};
            // Reverse-map to the CFn spelling `TransitionInDays`, matching
            // the `Transitions` sibling 20 lines above. Emitting the SDK's
            // `NoncurrentDays` here made `cdkd drift` report a permanent
            // phantom diff on every versioned bucket with a noncurrent
            // transition, because the template baseline carries
            // `TransitionInDays` and `Rules` is compared array-wholesale.
            // Latent until this PR: the write side never delivered the day
            // count, so the two sides were both empty and agreed by accident.
            if (nvt.NoncurrentDays !== undefined) item['TransitionInDays'] = nvt.NoncurrentDays;
            if (nvt.StorageClass !== undefined) item['StorageClass'] = nvt.StorageClass;
            if (nvt.NewerNoncurrentVersions !== undefined)
              item['NewerNoncurrentVersions'] = nvt.NewerNoncurrentVersions;
            return item;
          });
        }

        // AbortIncompleteMultipartUpload
        if (r.AbortIncompleteMultipartUpload) {
          out['AbortIncompleteMultipartUpload'] = {
            DaysAfterInitiation: r.AbortIncompleteMultipartUpload.DaysAfterInitiation,
          };
        }

        // Filter — reverse-map SDK Filter shape (Tag / Prefix / And / etc)
        // back to CFn TagFilters / Prefix / ObjectSize* form.
        if (r.Filter) {
          const f = r.Filter as Record<string, unknown>;
          const cfnFilter: Record<string, unknown> = {};
          const and = f['And'] as Record<string, unknown> | undefined;
          const tagOnly = f['Tag'] as { Key?: string; Value?: string } | undefined;
          if (and) {
            if (and['Prefix'] !== undefined) cfnFilter['Prefix'] = and['Prefix'];
            if (and['Tags']) cfnFilter['TagFilters'] = and['Tags'];
            if (and['ObjectSizeGreaterThan'] !== undefined)
              cfnFilter['ObjectSizeGreaterThan'] = and['ObjectSizeGreaterThan'];
            if (and['ObjectSizeLessThan'] !== undefined)
              cfnFilter['ObjectSizeLessThan'] = and['ObjectSizeLessThan'];
          } else if (tagOnly) {
            cfnFilter['TagFilters'] = [tagOnly];
          } else {
            if (f['Prefix'] !== undefined) cfnFilter['Prefix'] = f['Prefix'];
            if (f['ObjectSizeGreaterThan'] !== undefined)
              cfnFilter['ObjectSizeGreaterThan'] = f['ObjectSizeGreaterThan'];
            if (f['ObjectSizeLessThan'] !== undefined)
              cfnFilter['ObjectSizeLessThan'] = f['ObjectSizeLessThan'];
          }
          if (Object.keys(cfnFilter).length > 0) out['Filter'] = cfnFilter;
        }

        return out;
      }),
    };
  } catch (err) {
    const e = err as { name?: string };
    if (e.name === 'NoSuchLifecycleConfiguration') return { Rules: [] };
    throw err;
  }
}
export async function readCors(
  this: S3BucketProvider,
  bucket: string
): Promise<Record<string, unknown>> {
  try {
    const resp = await this.s3Client.send(new GetBucketCorsCommand({ Bucket: bucket }));
    const rules = resp.CORSRules ?? [];
    return {
      CorsRules: rules.map((r) => {
        const out: Record<string, unknown> = {};
        if (r.ID !== undefined) out['Id'] = r.ID;
        if (r.AllowedHeaders !== undefined) out['AllowedHeaders'] = r.AllowedHeaders;
        if (r.AllowedMethods !== undefined) out['AllowedMethods'] = r.AllowedMethods;
        if (r.AllowedOrigins !== undefined) out['AllowedOrigins'] = r.AllowedOrigins;
        if (r.ExposeHeaders !== undefined) out['ExposedHeaders'] = r.ExposeHeaders;
        if (r.MaxAgeSeconds !== undefined) out['MaxAge'] = r.MaxAgeSeconds;
        return out;
      }),
    };
  } catch (err) {
    const e = err as { name?: string };
    if (e.name === 'NoSuchCORSConfiguration') return { CorsRules: [] };
    throw err;
  }
}
export async function readWebsite(
  this: S3BucketProvider,
  bucket: string
): Promise<Record<string, unknown>> {
  try {
    const resp = await this.s3Client.send(new GetBucketWebsiteCommand({ Bucket: bucket }));
    const out: Record<string, unknown> = {};
    if (resp.IndexDocument?.Suffix !== undefined) {
      out['IndexDocument'] = resp.IndexDocument.Suffix;
    }
    if (resp.ErrorDocument?.Key !== undefined) {
      out['ErrorDocument'] = resp.ErrorDocument.Key;
    }
    if (resp.RedirectAllRequestsTo) {
      const redirect: Record<string, unknown> = {};
      if (resp.RedirectAllRequestsTo.HostName !== undefined)
        redirect['HostName'] = resp.RedirectAllRequestsTo.HostName;
      if (resp.RedirectAllRequestsTo.Protocol !== undefined)
        redirect['Protocol'] = resp.RedirectAllRequestsTo.Protocol;
      out['RedirectAllRequestsTo'] = redirect;
    }
    if (resp.RoutingRules && resp.RoutingRules.length > 0) {
      out['RoutingRules'] = resp.RoutingRules.map((rr) => {
        const ruleOut: Record<string, unknown> = {};
        if (rr.Condition) {
          const c: Record<string, unknown> = {};
          if (rr.Condition.HttpErrorCodeReturnedEquals !== undefined)
            c['HttpErrorCodeReturnedEquals'] = rr.Condition.HttpErrorCodeReturnedEquals;
          if (rr.Condition.KeyPrefixEquals !== undefined)
            c['KeyPrefixEquals'] = rr.Condition.KeyPrefixEquals;
          ruleOut['RoutingRuleCondition'] = c;
        }
        if (rr.Redirect) {
          const r: Record<string, unknown> = {};
          if (rr.Redirect.HostName !== undefined) r['HostName'] = rr.Redirect.HostName;
          if (rr.Redirect.HttpRedirectCode !== undefined)
            r['HttpRedirectCode'] = rr.Redirect.HttpRedirectCode;
          if (rr.Redirect.Protocol !== undefined) r['Protocol'] = rr.Redirect.Protocol;
          if (rr.Redirect.ReplaceKeyPrefixWith !== undefined)
            r['ReplaceKeyPrefixWith'] = rr.Redirect.ReplaceKeyPrefixWith;
          if (rr.Redirect.ReplaceKeyWith !== undefined)
            r['ReplaceKeyWith'] = rr.Redirect.ReplaceKeyWith;
          ruleOut['RedirectRule'] = r;
        }
        return ruleOut;
      });
    }
    return out;
  } catch (err) {
    const e = err as { name?: string };
    if (e.name === 'NoSuchWebsiteConfiguration') return {};
    throw err;
  }
}
export async function readLogging(
  this: S3BucketProvider,
  bucket: string
): Promise<Record<string, unknown>> {
  const resp = await this.s3Client.send(new GetBucketLoggingCommand({ Bucket: bucket }));
  if (!resp.LoggingEnabled) return {};
  const out: Record<string, unknown> = {};
  if (resp.LoggingEnabled.TargetBucket !== undefined)
    out['DestinationBucketName'] = resp.LoggingEnabled.TargetBucket;
  if (resp.LoggingEnabled.TargetPrefix !== undefined)
    out['LogFilePrefix'] = resp.LoggingEnabled.TargetPrefix;
  // Issue #1495: read back the key format the write side now sends, or a
  // bucket that declares it would report permanent phantom drift.
  const keyFormat = resp.LoggingEnabled.TargetObjectKeyFormat;
  if (keyFormat) {
    const cfnKeyFormat: Record<string, unknown> = {};
    if (keyFormat.SimplePrefix !== undefined) cfnKeyFormat['SimplePrefix'] = {};
    if (keyFormat.PartitionedPrefix) {
      const partitioned: Record<string, unknown> = {};
      if (keyFormat.PartitionedPrefix.PartitionDateSource !== undefined) {
        partitioned['PartitionDateSource'] = keyFormat.PartitionedPrefix.PartitionDateSource;
      }
      cfnKeyFormat['PartitionedPrefix'] = partitioned;
    }
    if (Object.keys(cfnKeyFormat).length > 0) out['TargetObjectKeyFormat'] = cfnKeyFormat;
  }
  return out;
}
