/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return */
import {
  type CORSRule,
  CreateBucketMetadataConfigurationCommand,
  DeleteBucketMetadataConfigurationCommand,
  DeleteBucketTaggingCommand,
  GetBucketMetadataConfigurationCommand,
  type MetadataConfiguration,
  type MetadataConfigurationResult,
  PutBucketAbacCommand,
  PutBucketCorsCommand,
  PutBucketTaggingCommand,
  PutBucketVersioningCommand,
  UpdateBucketMetadataAnnotationTableConfigurationCommand,
  UpdateBucketMetadataInventoryTableConfigurationCommand,
  UpdateBucketMetadataJournalTableConfigurationCommand,
} from '@aws-sdk/client-s3';
import { type CfnTagEntry, planTagDiff, readTagList, tagPlanWarning } from '../../tag-list.js';
import {
  type ConfigStringOptions,
  configStringRefusal,
  readConfigString,
} from '../../config-shape.js';
import type { CreateContext, UpdateContext } from '../../../types/resource.js';
import {
  METADATA_TABLE_BUDGET_MS,
  METADATA_TABLE_DISABLED,
  METADATA_TABLE_ENABLED,
  METADATA_TABLE_POLL_MS,
  metadataAttributesFromSdk,
  metadataBag,
  metadataConfigurationFromSdk,
  metadataConfigurationToSdk,
} from './metadata.js';
import { S3BucketProvider } from '../s3-bucket-provider.js';
import {
  S3ControlClient,
  TagResourceCommand,
  UntagResourceCommand,
} from '@aws-sdk/client-s3-control';
import { canonicalizeRegion } from '../../../utils/aws-partition.js';
import { caughtErrorName } from './shared.js';
import { clientDefaultsFor } from '../../../utils/ambient-client-defaults.js';
import { describeAwsStatusReason } from '../../../utils/aws-failure-text.js';
import { getAccountInfo } from '../../../deployment/intrinsic-function-resolver.js';
import { s3BucketArn } from '../../../utils/s3-endpoints.js';
import { safeMsg } from '../../../utils/display-safe.js';

/**
 * Apply versioning configuration if specified
 */
/**
 * @returns `true` when `PutBucketVersioning` was issued, `false` when the
 *   replay downgrade SKIPPED it. The caller records that skip in
 *   `effectiveProperties` so state describes what AWS holds (issue #1612).
 */
export async function applyVersioning(
  this: S3BucketProvider,
  bucketName: string,
  versioningConfig: unknown,
  // The state-replay downgrade (issue #1605). Present only on a replay-
  // reachable call — the reverse-replacement create and the update path.
  onUnusable?: (message: string) => void
): Promise<boolean> {
  // The replay downgrade is a SKIP, and the reasoning is the inverse of the
  // usual one: here the DEFAULT is the dangerous direction. There is no item
  // to skip and no previous value to keep, so the only two answers are
  // "leave live versioning alone" and "take the Suspended fallback" — and
  // #1471 measured that exact fallback turning versioning OFF on a live
  // bucket. Skipping is not free either (`PutBucketVersioning` is the only
  // call that reverts a rollback of a versioning change, so a rollback whose
  // recorded value is malformed leaves versioning where it is), but an
  // un-reverted rollback is recoverable and a silently disabled object
  // history is not. The skip is ANNOUNCED so it is not a silent drop.
  if (onUnusable) {
    const refusal = configStringRefusal(
      versioningConfig,
      'Status',
      'Suspended',
      'AWS::S3::Bucket VersioningConfiguration'
    );
    if (refusal !== undefined) {
      // Deliberately NOT phrased as "leaving the LIVE state unchanged" (PR
      // review): this applier is reached from the reverse-replacement CREATE
      // too, where there is no live bucket and the real consequence is that
      // the restored bucket comes up UNVERSIONED. The wording covers both.
      onUnusable(
        `${refusal}. No PutBucketVersioning is issued rather than applying the Suspended ` +
          `default, which would turn object versioning OFF on an existing bucket (on a ` +
          `replayed create it means the bucket is left unversioned); the same value is ` +
          `REFUSED on a template-path create`
      );
      return false;
    }
  }
  // `unknown`, not `Record<string, unknown>`: the CREATE path's truthiness
  // gate lets a malformed value (`VersioningConfiguration: 'Enabled'`) reach
  // here, and defaulting its missing `Status` to Suspended is exactly the
  // silent versioning-OFF of issue #1471. Refuse instead.
  const status = readConfigString(
    versioningConfig,
    'Status',
    'Suspended',
    'AWS::S3::Bucket VersioningConfiguration'
  );
  await this.s3Client.send(
    new PutBucketVersioningCommand({
      Bucket: bucketName,
      VersioningConfiguration: {
        Status: status as 'Enabled' | 'Suspended',
      },
    })
  );
  this.logger.debug(
    `Applied versioning (${this.shown(status)}) to bucket ${this.shown(bucketName)}`
  );
  return true;
}

/**
 * Apply tags if specified
 */
export async function applyTags(
  this: S3BucketProvider,
  bucketName: string,
  tags: Array<{ Key: string; Value: string }>
): Promise<void> {
  await this.s3Client.send(
    new PutBucketTaggingCommand({
      Bucket: bucketName,
      Tagging: {
        TagSet: tags,
      },
    })
  );
  this.logger.debug(`Applied ${tags.length} tags to bucket ${this.shown(bucketName)}`);
}

/**
 * Apply a diff between old and new CFn-shape Tags arrays via S3's
 * `PutBucketTagging` (full-replace) / `DeleteBucketTagging` APIs.
 *
 * S3's `PutBucketTagging` replaces the entire tag set in one call, so we
 * don't need separate add/remove API operations. When the new set is
 * empty, we issue `DeleteBucketTagging` to clear it. When old and new
 * name the same tags, we skip the call entirely.
 *
 * Both sides are read through `planTagDiff` (go-to-k/cdkd#3994). A full
 * replace removes every live key the desired side does not name, so when
 * the record cannot name every key it holds — it is unreadable, or it
 * carries a secret-derived Key — the live tag set is read and every live
 * key neither the desired side nor the readable record names is kept.
 */
export async function applyTagDiff(
  this: S3BucketProvider,
  bucketName: string,
  resourceType: string,
  logicalId: string,
  oldTagsRaw: unknown,
  newTagsRaw: unknown,
  abacEnabled = false
): Promise<void> {
  const plan = planTagDiff(oldTagsRaw, newTagsRaw);
  const desiredRead = readTagList(newTagsRaw, 'desired');
  const desired = desiredRead.kind === 'tags' ? desiredRead.tags : [];
  const recordedRead = readTagList(oldTagsRaw, 'recorded');
  const recordHidesKeys =
    plan.recordedUnreadable ||
    (Array.isArray(oldTagsRaw) &&
      recordedRead.kind === 'tags' &&
      recordedRead.tags.length !== oldTagsRaw.length);

  let tagSet: CfnTagEntry[];
  if (recordHidesKeys) {
    const tagWarning = tagPlanWarning(plan, resourceType, logicalId);
    if (tagWarning !== undefined) {
      this.logger.warn(tagWarning);
    }
    const live = await this.readTags(bucketName);
    const named = new Set([...desired.map((t) => t.Key), ...plan.remove]);
    tagSet = [...desired, ...live.filter((t) => !named.has(t.Key))];
    const toMap = (tags: CfnTagEntry[]): Map<string, string> =>
      new Map(tags.map((t) => [t.Key, t.Value] as const));
    const liveMap = toMap(live);
    const nextMap = toMap(tagSet);
    if (
      liveMap.size === nextMap.size &&
      [...nextMap].every(([k, v]) => liveMap.has(k) && liveMap.get(k) === v)
    ) {
      return;
    }
  } else {
    if (plan.set.size === 0 && plan.remove.length === 0) return;
    tagSet = desired;
  }

  if (abacEnabled) {
    await this.replaceAbacBucketTags(bucketName, tagSet);
    return;
  }

  if (tagSet.length === 0) {
    // Clear tags. Use PutBucketTaggingCommand with empty TagSet — S3
    // does not have a public `DeleteBucketTagging` parity for the SDK
    // we use, so emit an empty Tagging set instead.
    try {
      await this.s3Client.send(
        new DeleteBucketTaggingCommand({
          Bucket: bucketName,
        })
      );
      this.logger.debug(`Cleared tags from bucket ${this.shown(bucketName)}`);
    } catch (err) {
      // Some S3 API versions reject empty TagSet on Put; fall back to
      // re-Put. The `NoSuchTagSet` (already-empty) response is fine.
      const e = err as { name?: string };
      if (e.name === 'NoSuchTagSet') return;
      throw err;
    }
    return;
  }
  await this.s3Client.send(
    new PutBucketTaggingCommand({
      Bucket: bucketName,
      Tagging: { TagSet: tagSet },
    })
  );
  this.logger.debug(`Replaced tag set on bucket ${this.shown(bucketName)} (${tagSet.length} tags)`);
}

/**
 * go-to-k/cdkd#2762: S3 answers `PutBucketTagging` and `DeleteBucketTagging`
 * with `BadRequest` while ABAC is on and points at S3 Control (measured
 * 2026-11-01), so the full replace `applyTagDiff` plans is spelled as a
 * `TagResource` plus an `UntagResource` of every other live key. `readTags`
 * already leaves out `aws:` keys, which neither call accepts.
 */
export async function replaceAbacBucketTags(
  this: S3BucketProvider,
  bucketName: string,
  tagSet: CfnTagEntry[]
): Promise<void> {
  const keep = new Set(tagSet.map((t) => t.Key));
  const stale = (await this.readTags(bucketName)).map((t) => t.Key).filter((key) => !keep.has(key));
  // Per call, in the shared client's region and with its credentials: only
  // an ABAC bucket's tag change needs S3 Control, and a client held on the
  // provider would escape `noWriteProbe`.
  const client = new S3ControlClient({
    ...clientDefaultsFor(this.credentialConfig),
    region: await this.getRegion(),
  });
  try {
    const AccountId = (await getAccountInfo()).accountId;
    const ResourceArn = s3BucketArn(bucketName, await this.getRegion());
    // Untag first: a swap of keys near S3's tag limit must not overflow it.
    if (stale.length > 0) {
      await client.send(new UntagResourceCommand({ AccountId, ResourceArn, TagKeys: stale }));
    }
    if (tagSet.length > 0) {
      await client.send(new TagResourceCommand({ AccountId, ResourceArn, Tags: tagSet }));
    }
  } finally {
    client.destroy();
  }
  this.logger.debug(safeMsg`Replaced tag set on ABAC bucket ${this.shown(bucketName)}`);
}
export async function applyAbacStatus(
  this: S3BucketProvider,
  bucketName: string,
  status: unknown
): Promise<void> {
  await this.s3Client.send(
    new PutBucketAbacCommand({
      Bucket: bucketName,
      AbacStatus: { Status: status as 'Enabled' | 'Disabled' },
    })
  );
  this.logger.debug(safeMsg`Applied AbacStatus to bucket ${this.shown(bucketName)}`);
}
export async function accountRegionalBucketName(
  this: S3BucketProvider,
  prefix: string
): Promise<string> {
  const account = (await getAccountInfo()).accountId;
  return `${prefix}-${account}-${canonicalizeRegion(await this.getRegion())}-an`;
}

/**
 * @returns whether a table was turned on. S3 answers a second create with
 * `MetadataConfigurationAlreadyExists` (measured 2026-11-01): a retry after a
 * crash, or a state that never recorded this configuration, finds the bucket
 * ahead of the record, so that converges from what S3 holds.
 */
export async function createMetadataConfiguration(
  this: S3BucketProvider,
  bucketName: string,
  desired: Record<string, unknown>,
  stateBorne: boolean
): Promise<boolean> {
  const MetadataConfiguration = metadataConfigurationToSdk(desired);
  try {
    await this.s3Client.send(
      new CreateBucketMetadataConfigurationCommand({
        Bucket: bucketName,
        MetadataConfiguration,
      })
    );
  } catch (err) {
    if ((err as { name?: string }).name !== 'MetadataConfigurationAlreadyExists') throw err;
    const live = await this.readMetadataConfigurationResult(bucketName).catch(() => undefined);
    if (live === undefined) throw err;
    return this.convergeMetadataConfiguration(bucketName, desired, live, stateBorne);
  }
  await this.waitForMetadataTables(bucketName, MetadataConfiguration, stateBorne);
  return true;
}

/**
 * Bring a configuration S3 already holds to `desired`. Its tables may still be
 * settling, or have failed, so this waits whatever the diff sent. S3 never
 * returns a table's encryption, so a declared one cannot be compared.
 */
export async function convergeMetadataConfiguration(
  this: S3BucketProvider,
  bucketName: string,
  desired: Record<string, unknown>,
  live: MetadataConfigurationResult,
  stateBorne: boolean
): Promise<boolean> {
  const sent = metadataConfigurationToSdk(desired);
  if (
    sent.JournalTableConfiguration?.EncryptionConfiguration ||
    sent.InventoryTableConfiguration?.EncryptionConfiguration ||
    sent.AnnotationTableConfiguration?.EncryptionConfiguration
  ) {
    this.logger.warn(
      safeMsg`Bucket ${this.shown(bucketName)} already holds an S3 Metadata configuration, and S3 never returns a table's encryption, so the declared EncryptionConfiguration is unverified and may not be the one in effect`
    );
  }
  const enabledATable = await this.applyMetadataConfigurationDiff(
    bucketName,
    desired,
    metadataConfigurationFromSdk(live),
    true,
    true
  );
  await this.waitForMetadataTables(bucketName, sent, stateBorne);
  return enabledATable;
}

/**
 * Bring the bucket's S3 Metadata configuration from `previous` to `desired`.
 * Each table has its own update call.
 *
 * A table's encryption cannot change once the table exists, on any shape
 * (probed in us-east-1 on 2026-11-01, a deliberate pre-flight refusal per
 * docs/provider-rules.md): the journal update takes no encryption; the
 * inventory update answers `already enabled` to ANY call on an enabled table;
 * the annotation update answers `You can't update the encryption
 * configuration`. CloudFormation refuses it too, also for a block merely
 * added or dropped. The state-borne callers carry no `EncryptionConfiguration`
 * the readback could supply, so for them a difference is not a request.
 *
 * @param refuseOnly the {@link noWriteProbe} pre-flight: nothing was written,
 *   so there is no table to wait for.
 * @returns whether a table was turned on or a configuration created.
 */
export async function applyMetadataConfigurationDiff(
  this: S3BucketProvider,
  bucketName: string,
  desiredRaw: unknown,
  previousRaw: unknown,
  stateBorne: boolean,
  refuseOnly: boolean
): Promise<boolean> {
  const desired = metadataBag(desiredRaw);
  const previous = metadataBag(previousRaw);
  if (desired === undefined) {
    if (previous === undefined) return false;
    try {
      await this.s3Client.send(
        new DeleteBucketMetadataConfigurationCommand({ Bucket: bucketName })
      );
    } catch (err) {
      if ((err as { name?: string }).name !== 'MetadataConfigurationNotFound') throw err;
    }
    return false;
  }
  if (previous === undefined) {
    if (refuseOnly) return false;
    return this.createMetadataConfiguration(bucketName, desired, stateBorne);
  }

  const next = metadataConfigurationToSdk(desired);
  const prev = metadataConfigurationToSdk(previous);
  const differs = (a: unknown, b: unknown): boolean => JSON.stringify(a) !== JSON.stringify(b);
  const refuseEncryptionChange = (member: string, a: unknown, b: unknown): void => {
    if (!stateBorne && differs(a, b)) {
      throw new Error(
        `Bucket ${this.shown(bucketName)}: changing MetadataConfiguration.${member}.EncryptionConfiguration ` +
          `is not supported once the table exists. Revert it, or re-create the table: remove ` +
          `MetadataConfiguration, deploy, delete the table with aws s3tables delete-table, then add ` +
          `it back with the new encryption`
      );
    }
  };

  const nextJournal = next.JournalTableConfiguration;
  const prevJournal = prev.JournalTableConfiguration;
  refuseEncryptionChange(
    'JournalTableConfiguration',
    prevJournal?.EncryptionConfiguration,
    nextJournal?.EncryptionConfiguration
  );

  const nextInventory = next.InventoryTableConfiguration;
  const prevInventory = prev.InventoryTableConfiguration;
  const nextInventoryState = nextInventory?.ConfigurationState ?? METADATA_TABLE_DISABLED;
  const prevInventoryState = prevInventory?.ConfigurationState ?? METADATA_TABLE_DISABLED;
  if (
    nextInventoryState === METADATA_TABLE_ENABLED &&
    prevInventoryState === METADATA_TABLE_ENABLED
  ) {
    refuseEncryptionChange(
      'InventoryTableConfiguration',
      prevInventory?.EncryptionConfiguration,
      nextInventory?.EncryptionConfiguration
    );
  }

  const nextAnnotation = next.AnnotationTableConfiguration;
  const prevAnnotation = prev.AnnotationTableConfiguration;
  const nextAnnotationState = nextAnnotation?.ConfigurationState ?? METADATA_TABLE_DISABLED;
  const prevAnnotationState = prevAnnotation?.ConfigurationState ?? METADATA_TABLE_DISABLED;
  const annotationStaysOn =
    nextAnnotationState === METADATA_TABLE_ENABLED &&
    prevAnnotationState === METADATA_TABLE_ENABLED;
  if (annotationStaysOn) {
    refuseEncryptionChange(
      'AnnotationTableConfiguration',
      prevAnnotation?.EncryptionConfiguration,
      nextAnnotation?.EncryptionConfiguration
    );
  }

  let enabledATable = false;
  if (differs(prevJournal?.RecordExpiration, nextJournal?.RecordExpiration)) {
    await this.s3Client.send(
      new UpdateBucketMetadataJournalTableConfigurationCommand({
        Bucket: bucketName,
        JournalTableConfiguration: { RecordExpiration: nextJournal?.RecordExpiration },
      })
    );
  }
  if (nextInventoryState !== prevInventoryState) {
    const on = nextInventoryState === METADATA_TABLE_ENABLED;
    await this.s3Client.send(
      new UpdateBucketMetadataInventoryTableConfigurationCommand({
        Bucket: bucketName,
        InventoryTableConfiguration: {
          ConfigurationState: nextInventoryState,
          ...(on && nextInventory?.EncryptionConfiguration
            ? { EncryptionConfiguration: nextInventory.EncryptionConfiguration }
            : {}),
        },
      })
    );
    enabledATable ||= on;
  }
  if (
    nextAnnotationState !== prevAnnotationState ||
    (annotationStaysOn && nextAnnotation?.Role !== prevAnnotation?.Role)
  ) {
    const on = nextAnnotationState === METADATA_TABLE_ENABLED;
    await this.s3Client.send(
      new UpdateBucketMetadataAnnotationTableConfigurationCommand({
        Bucket: bucketName,
        AnnotationTableConfiguration: {
          ConfigurationState: nextAnnotationState,
          ...(on && nextAnnotation?.EncryptionConfiguration
            ? { EncryptionConfiguration: nextAnnotation.EncryptionConfiguration }
            : {}),
          ...(on && nextAnnotation?.Role !== undefined ? { Role: nextAnnotation.Role } : {}),
        },
      })
    );
    enabledATable ||= on;
  }
  if (enabledATable && !refuseOnly) {
    await this.waitForMetadataTables(bucketName, next, stateBorne);
  }
  return enabledATable;
}

/**
 * Wait, in every wait mode, until each table the configuration turns on has
 * an ARN or has failed, as CloudFormation does. The ARNs are `Fn::GetAtt`
 * values. A failed or unsettled table only warns: S3 accepts a configuration
 * over a table an earlier one left behind and the new table turns
 * `JournalTableAlreadyExists`, which CloudFormation completes over on a create
 * and on an update (measured 2026-11-01). Tables outlive the bucket, so a
 * destroy and redeploy of one name reaches this, and failing there would
 * also delete the bucket in the partial-create cleanup. S3 kept the ARN on
 * every table it failed this way (measured for all three). A state-borne
 * caller warns on an unread status too: a rollback must not stop here.
 */
export async function waitForMetadataTables(
  this: S3BucketProvider,
  bucketName: string,
  sent: MetadataConfiguration,
  stateBorne: boolean
): Promise<void> {
  const deadline = Date.now() + METADATA_TABLE_BUDGET_MS;
  const warned = new Set<string>();
  for (;;) {
    let result: MetadataConfigurationResult | undefined;
    try {
      result = await this.readMetadataConfigurationResult(bucketName);
    } catch (err) {
      if (!stateBorne) throw err;
      this.logger.warn(
        safeMsg`Could not read the S3 Metadata tables of ${this.shown(bucketName)} (${caughtErrorName(err)}); not waiting for them`
      );
      return;
    }
    const tables = [
      ['journal', true, result?.JournalTableConfigurationResult],
      [
        'inventory',
        sent.InventoryTableConfiguration?.ConfigurationState === METADATA_TABLE_ENABLED,
        result?.InventoryTableConfigurationResult,
      ],
      [
        'annotation',
        sent.AnnotationTableConfiguration?.ConfigurationState === METADATA_TABLE_ENABLED,
        result?.AnnotationTableConfigurationResult,
      ],
    ] as const;
    let pending: string | undefined;
    for (const [name, wanted, table] of tables) {
      if (!wanted) continue;
      if (table?.TableStatus === 'FAILED') {
        if (!warned.has(name)) {
          warned.add(name);
          this.warnMetadataTableFailed(bucketName, name, table);
        }
        continue;
      }
      if (table?.TableArn === undefined) pending = `the ${name} table`;
    }
    if (pending === undefined) return;
    if (Date.now() >= deadline) {
      this.logger.warn(
        safeMsg`Gave up waiting for ${pending} of bucket ${this.shown(bucketName)}'s S3 Metadata configuration; it may still finish, and an Fn::GetAtt on its ARN fails until then. Read it with aws s3api get-bucket-metadata-configuration`
      );
      return;
    }
    await new Promise((r) => setTimeout(r, METADATA_TABLE_POLL_MS));
  }
}

/** AWS's own text goes to debug only: a status reason may name a role ARN. */
export function warnMetadataTableFailed(
  this: S3BucketProvider,
  bucketName: string,
  name: string,
  table: {
    TableArn?: string | undefined;
    Error?: { ErrorCode?: string | undefined; ErrorMessage?: string | undefined } | undefined;
  }
): void {
  const reason = describeAwsStatusReason(
    { code: table.Error?.ErrorCode, message: table.Error?.ErrorMessage },
    'S3 gave no reason.'
  );
  const noArn =
    table.TableArn === undefined ? ' It has no ARN, so an Fn::GetAtt on its TableArn fails.' : '';
  this.logger.debug(safeMsg`S3 Metadata ${name} table: ${this.maskRaw(reason.detail)}`);
  this.logger.warn(
    safeMsg`The S3 Metadata ${name} table of bucket ${this.shown(bucketName)} FAILED: ${reason.summary} The deploy continues, but this table records nothing.${noArn} When a table left by an earlier bucket of this name is the cause, delete it with aws s3tables delete-table --table-bucket-arn <the account's aws-s3 table bucket> --namespace b_${this.shown(bucketName)} --name ${name}, then deploy without MetadataConfiguration and add it back`
  );
}

/** `undefined` when the bucket has no configuration; any other failure throws. */
export async function readMetadataConfigurationResult(
  this: S3BucketProvider,
  bucket: string
): Promise<MetadataConfigurationResult | undefined> {
  try {
    const resp = await this.s3Client.send(
      new GetBucketMetadataConfigurationCommand({ Bucket: bucket })
    );
    return resp.GetBucketMetadataConfigurationResult?.MetadataConfigurationResult;
  } catch (err) {
    if ((err as { name?: string }).name === 'MetadataConfigurationNotFound') return undefined;
    throw err;
  }
}

/** `'unread'` on a failed read, for the same reason as {@link readAbacStatus}. */
export async function readMetadataForDrift(
  this: S3BucketProvider,
  bucket: string
): Promise<MetadataConfigurationResult | undefined | 'unread'> {
  try {
    return await this.readMetadataConfigurationResult(bucket);
  } catch (err) {
    this.logger.debug(
      safeMsg`Could not read S3 Metadata of ${this.shown(bucket)} (${caughtErrorName(err)})`
    );
    return 'unread';
  }
}

/**
 * Every write has landed by now. A template deploy fails on an unread
 * attribute, since state would lose the ARNs; a rollback or revert must not
 * stop here, so it warns and the next deploy records them.
 */
export async function readMetadataAttributesAfterWrites(
  this: S3BucketProvider,
  bucket: string,
  context: CreateContext | UpdateContext | undefined
): Promise<Record<string, unknown>> {
  try {
    return await this.readMetadataAttributes(bucket);
  } catch (err) {
    const readback =
      context !== undefined && 'desiredFromAwsReadback' in context
        ? context.desiredFromAwsReadback
        : undefined;
    if (context?.replayingState !== true && readback !== true) throw err;
    this.logger.warn(
      safeMsg`Could not read the S3 Metadata attributes of ${this.shown(bucket)} (${caughtErrorName(err)}); an Fn::GetAtt on them fails until the next deploy records them`
    );
    return {};
  }
}
export async function readMetadataAttributes(
  this: S3BucketProvider,
  bucket: string
): Promise<Record<string, unknown>> {
  const result = await this.readMetadataConfigurationResult(bucket);
  return result ? metadataAttributesFromSdk(result) : {};
}

/**
 * Apply CORS configuration
 *
 * CFn property: CorsConfiguration.CorsRules[]
 * SDK: PutBucketCors with CORSConfiguration.CORSRules[]
 *
 * CFn CorsRule fields map to SDK CORSRule fields:
 * - AllowedHeaders, AllowedMethods, AllowedOrigins, ExposedHeaders, MaxAge
 * SDK uses the same names except ExposedHeaders -> ExposeHeaders, MaxAge -> MaxAgeSeconds
 */
export async function applyCorsConfiguration(
  this: S3BucketProvider,
  bucketName: string,
  corsConfig: { CorsRules: Array<Record<string, unknown>> }
): Promise<void> {
  const corsRules: CORSRule[] = corsConfig.CorsRules.map((rule) => ({
    ID: rule['Id'] as string | undefined,
    AllowedHeaders: rule['AllowedHeaders'] as string[] | undefined,
    AllowedMethods: rule['AllowedMethods'] as string[],
    AllowedOrigins: rule['AllowedOrigins'] as string[],
    ExposeHeaders: rule['ExposedHeaders'] as string[] | undefined,
    MaxAgeSeconds: rule['MaxAge'] as number | undefined,
  }));
  await this.s3Client.send(
    new PutBucketCorsCommand({
      Bucket: bucketName,
      CORSConfiguration: {
        CORSRules: corsRules,
      },
    })
  );
  this.logger.debug(`Applied CORS configuration to bucket ${this.shown(bucketName)}`);
}

/**
 * The per-item / per-rule STRING guard, with the applier's own SKIP as the
 * replay downgrade (issue #1595).
 *
 * Four per-item reads in this file refuse a malformed configuration ITEM
 * through a `readConfigString` that carries no `onUnusable`, so they threw on
 * the state-replay paths too — the un-rollbackable refusal every container
 * guard beside them exists to avoid. What they must NOT do instead is take
 * `readConfigString`'s own downgrade: its fallback is applied to a LIVE
 * resource, and each of these defaults ENABLES something (a lifecycle
 * expiration rule, an intelligent-tiering transition, a replication rule),
 * so warn-and-default is worse than the refusal it replaces. The correct
 * downgrade is the SKIP the sibling container guards already perform, with
 * the same per-applier unit — whole Put where the Put replaces every rule,
 * the single configuration item where the Put is per-Id.
 *
 * Returns `true` when the caller must skip. On the CREATE path (`onUnusable`
 * absent) it always returns `false` and the original read below still
 * throws, so template-borne behavior is unchanged.
 *
 * No `ConfigStringOptions` passthrough, and that is a decision rather than an
 * omission: a probe whose relaxations disagree with the read it fronts would
 * refuse exactly where the read accepts. All four sites are ENUM-valued
 * (`Status` / `IncludedObjectVersions`), so `coerceNumber` is wrong for them
 * by the rule in `config-shape.ts`'s header — a number where an enum belongs
 * is a bug. A site that ever needs an option must thread the SAME bag here.
 */
export function skipOnUnusableConfigString(
  this: S3BucketProvider,
  container: unknown,
  key: string,
  fallback: string,
  containerPath: string,
  skipClause: string,
  onUnusable?: (message: string) => void
): boolean {
  if (!onUnusable) return false;
  const refusal = configStringRefusal(container, key, fallback, containerPath);
  if (refusal === undefined) return false;
  onUnusable(`${refusal}. ${skipClause}; the same value is REFUSED on a template-path create`);
  return true;
}

/**
 * A string read whose replay downgrade is a warn-and-SUBSTITUTE, reporting
 * the substitution so the caller can record what was SENT (issue #1670).
 *
 * The third shape beside {@link skipOnUnusableConfigString}'s SKIP and the
 * plain strict read, for the sites where the fallback IS the right value to
 * send. The deploy then succeeds with the default on the wire, so recording
 * the declared value describes a configuration AWS does not hold, and
 * `readCurrentState` reads all of these back — the permanent phantom drift
 * `.claude/rules/providers.md` records for the #1633 warn-and-default arm.
 *
 * These sites DO take a `canonicalizeDesiredProperties` twin as of issues
 * #1707 / #1717, and this paragraph said the opposite until then — it is
 * restated rather than deleted because the earlier answer was not wrong, it
 * was answering a different question. #1670 asked it about the SUBSTITUTED
 * VALUE and said no, because canonicalizing there would conceal a malformed
 * value whose warning is the user's only signal. The twin that shipped folds
 * the never-emitted KEY and SHAPE at the same sites, which have no fault to
 * conceal and emit no warning at all, and it is keyed off the DECLARED shape
 * so the substituted value stays visible exactly as before. See
 * {@link S3BucketProvider.canonicalizeDesiredProperties} and
 * {@link declaredOrDefault}.
 *
 * **It is now a verbatim alias of `readConfigString`**, and the bullets that
 * used to sit here described a probe that no longer exists — the same stale
 * -rationale class this round fixed one paragraph up, so it is named rather
 * than quietly rewritten. The `onSubstituted` callback it used to take is GONE
 * (review of #1707): recording is the per-item fold's job now, and all three
 * call sites had been left passing a comment-only no-op, so the probe ran a
 * second `configStringRefusal` per read purely to invoke nothing.
 *
 * It is kept rather than inlined for ONE reason, which is worth stating so the
 * next reader can weigh it: the name marks these three reads as the
 * warn-and-SUBSTITUTE sites, distinguishing them at a glance from the
 * SKIP-guarded ones (`skipOnUnusableConfigString`) and the plain strict reads.
 * The behavior is `readConfigString`'s, unchanged — `options.onUnusable`
 * carries the WARNING the "already ANNOUNCED" condition on
 * `effectiveProperties` needs, and without it the read still THROWS.
 */
export function readSubstitutedConfigString(
  this: S3BucketProvider,
  container: unknown,
  key: string,
  fallback: string,
  containerPath: string,
  options: ConfigStringOptions
): string {
  return readConfigString(container, key, fallback, containerPath, options);
}
