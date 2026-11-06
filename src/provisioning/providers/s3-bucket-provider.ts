/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return */
import {
  type Bucket,
  type MetadataConfiguration,
  type MetadataConfigurationResult,
  S3Client,
} from '@aws-sdk/client-s3';
import type { BucketRegionProbe, UnverifiedIdentityCause } from './s3-bucket/create-identity.js';
import type { CfnTagEntry } from '../tag-list.js';
import type { ConfigStringOptions } from '../config-shape.js';
import { type ConsoleLogger, getLogger } from '../../utils/logger.js';
import type {
  CreateContext,
  ReadCurrentStateContext,
  ResourceCreateResult,
  ResourceDeleteResult,
  ResourceIdentityVerdict,
  ResourceImportInput,
  ResourceImportResult,
  ResourceNotFound,
  ResourceProvider,
  ResourceUpdateResult,
  UpdateContext,
} from '../../types/resource.js';
import type { CredentialConfig } from '../../utils/ambient-client-defaults.js';
import type { DeleteContext } from '../region-check.js';
import { type MaskedLogSinks, type MaskerFn, maskerOrIdentity } from '../masked-retry-logger.js';
import type { PerItemApplyOutcome } from './s3-bucket/shared.js';
import { ProvisioningError } from '../../utils/error-handler.js';
import {
  accountRegionalBucketName,
  applyAbacStatus,
  applyCorsConfiguration,
  applyMetadataConfigurationDiff,
  applyTagDiff,
  applyTags,
  applyVersioning,
  convergeMetadataConfiguration,
  createMetadataConfiguration,
  readMetadataAttributes,
  readMetadataAttributesAfterWrites,
  readMetadataConfigurationResult,
  readMetadataForDrift,
  readSubstitutedConfigString,
  replaceAbacBucketTags,
  skipOnUnusableConfigString,
  waitForMetadataTables,
  warnMetadataTableFailed,
} from './s3-bucket/apply-core.js';
import {
  analyticsSdkToCfn,
  emitNotificationEvents,
  intelligentTieringSdkToCfn,
  inventorySdkToCfn,
  isLiveObjectLocked,
  metricsSdkToCfn,
  readAbacStatus,
  readAccelerate,
  readAnalyticsList,
  readIntelligentTieringList,
  readInventoryList,
  readMetricsList,
  readNotification,
  readObjectLock,
  readReplication,
  sdkNotifFilterToCfn,
} from './s3-bucket/read-state-lists.js';
import {
  announceCreateEmptyCollectionSkip,
  applyAllSubConfigsForCreate,
  applyEffectiveOverrides,
  buildEffectiveItemArray,
  declaresEmptyCollection,
  diffArrayConfigById,
  diffSubConfig,
  emptyCollectionSkip,
  emptyListConfigToUndefined,
  maskRaw,
  maskedView,
  noWriteProbe,
  shown,
  versioningOrLoggingRefusal,
} from './s3-bucket/sub-config.js';
import {
  announceUnverifiedBucketIdentity,
  assertExistingBucketRegion,
  assertStateBucketRegion,
  boundedIdentity,
  buildAttributes,
  getAttribute,
  getCreateClient,
  getRegion,
  holdOwnLeftover,
  isOwnLeftoverBucket,
  listOwnedBucket,
  ownsBucketNamed,
  probeBucketRegion,
  refuseAmbiguousCreateAdopt,
  refuseExplicitNameHeld,
  refuseForeignRegionAdopt,
  resolveOwnedBucketRegion,
} from './s3-bucket/adopt.js';
import {
  applyAccelerateConfiguration,
  applyBucketEncryption,
  applyLifecycleConfiguration,
  applyLoggingConfiguration,
  applyPublicAccessBlockConfiguration,
  applyWebsiteConfiguration,
} from './s3-bucket/apply-lifecycle.js';
import {
  applyAnalyticsConfigurations,
  applyMetricsConfigurations,
  applyNotificationConfiguration,
  cfnNotifFilterToSdk,
  resolveS3BucketDestination,
} from './s3-bucket/apply-notification-analytics.js';
import {
  applyConfiguration,
  applyIntelligentTieringConfigurations,
  applyInventoryConfigurations,
  applyObjectLockConfiguration,
  applyOwnershipControls,
  applyReplicationConfiguration,
  buildReplicationDestination,
} from './s3-bucket/apply-inventory-replication.js';
import { applySubConfigDiffs } from './s3-bucket/apply-diffs.js';
import {
  canonicalizeDesiredProperties,
  deleteBucketWithEmptyRetry,
  deleteImpl,
  emptyBucket,
  generatedCreateName,
  getDriftAbsentMeansDefaultKeys,
  getDriftUnknownPaths,
  importImpl,
  isSameResource,
  resourceIdentity,
  update,
  warnUnappliedBucketObjectLock,
  wrapOperationError,
} from './s3-bucket/update-delete.js';
import { create } from './s3-bucket/create.js';
import { getAwsClients } from '../../utils/aws-clients.js';
import {
  readCors,
  readCurrentState,
  readEncryption,
  readLifecycle,
  readLogging,
  readOwnershipControls,
  readPublicAccessBlock,
  readTags,
  readVersioning,
  readWebsite,
} from './s3-bucket/read-state.js';
export {
  FAILED_CREATE_ORPHAN_NOT_EMPTY_SKIP_REASON,
  resetS3BucketCreateRetryStateForTests,
} from './s3-bucket/create-identity.js';

export class S3BucketProvider implements ResourceProvider {
  s3Client: S3Client;
  /**
   * The client `CreateBucket` goes through, built once per provider (issue
   * #4639). A holder object rather than a field, because `create()` runs on a
   * `maskedView` whose prototype is this instance: assigning a field there
   * would cache the client on the per-call view only.
   */
  readonly createClientHolder: { client?: Promise<S3Client> | undefined } = {};
  /** The credential half of the `AwsClients` `s3Client` came from (#4639). */
  readonly credentialConfig: CredentialConfig;
  logger: ConsoleLogger = getLogger().child('S3BucketProvider');
  /**
   * The masker every name this OPERATION prints goes through (issue
   * [#2177](https://github.com/go-to-k/cdkd/issues/2177)). ABSENT on the
   * singleton, which is also how `create()` / `update()` know they have not yet
   * re-entered on a {@link maskedView}: only a view carries a deploy's masker,
   * so none is ever cached on the instance concurrent resources share.
   */
  opMask: MaskerFn | undefined = undefined;
  handledProperties = new Map<string, ReadonlySet<string>>([
    [
      'AWS::S3::Bucket',
      new Set([
        'BucketName',
        'VersioningConfiguration',
        'Tags',
        'OwnershipControls',
        'NotificationConfiguration',
        'CorsConfiguration',
        'LifecycleConfiguration',
        'PublicAccessBlockConfiguration',
        'BucketEncryption',
        'LoggingConfiguration',
        'WebsiteConfiguration',
        'AccelerateConfiguration',
        'MetricsConfigurations',
        'AnalyticsConfigurations',
        'IntelligentTieringConfigurations',
        'InventoryConfigurations',
        'ReplicationConfiguration',
        'ObjectLockConfiguration',
        'ObjectLockEnabled',
        // go-to-k/cdkd#2762.
        'AbacStatus',
        'BucketNamePrefix',
        'BucketNamespace',
        'MetadataConfiguration',
      ]),
    ],
  ]);

  unhandledByDesign = new Map<string, ReadonlyMap<string, string>>([
    [
      'AWS::S3::Bucket',
      new Map<string, string>([
        [
          'AccessControl',
          'Legacy canned ACL; AWS disables ACLs by default since 2023-04 — use BucketOwnershipControls + BucketPolicy / PublicAccessBlockConfiguration instead',
        ],
        [
          'MetadataTableConfiguration',
          'V1 S3 Metadata, which the schema says to replace with MetadataConfiguration; S3 answered V1APIsNotAllowed where it was probed, so an SDK path could not be verified. Stays on Cloud Control',
        ],
      ]),
    ],
  ]);

  constructor() {
    const awsClients = getAwsClients();
    this.s3Client = awsClients.s3;
    // A test double may carry no `credentialConfig`: degrade to `{}`, as
    // `ambientCredentialConfig` does.
    this.credentialConfig =
      (awsClients as { credentialConfig?: CredentialConfig }).credentialConfig ?? {};
  }
  getCreateClient(): Promise<S3Client> {
    return getCreateClient.call(this);
  }
  refuseAmbiguousCreateAdopt(
    logicalId: string,
    resourceType: string,
    bucketName: string,
    region: string,
    via: { cause: Error } | { preflight: 'region' | 'indeterminate' },
    explicitName: boolean
  ): never {
    return refuseAmbiguousCreateAdopt.call(
      this,
      logicalId,
      resourceType,
      bucketName,
      region,
      via,
      explicitName
    );
  }
  refuseExplicitNameHeld(
    logicalId: string,
    resourceType: string,
    bucketName: string,
    via: { cause: Error } | { preflightRegion: string } | { listed: true }
  ): never {
    return refuseExplicitNameHeld.call(this, logicalId, resourceType, bucketName, via);
  }
  ownsBucketNamed(bucketName: string): Promise<{ owned: boolean } | { unknown: string }> {
    return ownsBucketNamed.call(this, bucketName);
  }
  boundedIdentity(
    bucketName: string,
    resourceType: string,
    region: string
  ): Promise<string | ResourceNotFound | undefined> {
    return boundedIdentity.call(this, bucketName, resourceType, region);
  }
  holdOwnLeftover(logicalId: string, resourceType: string, bucketName: string): Promise<void> {
    return holdOwnLeftover.call(this, logicalId, resourceType, bucketName);
  }
  isOwnLeftoverBucket(
    leftover: string | undefined,
    bucketName: string,
    resourceType: string,
    region: string
  ): Promise<boolean> {
    return isOwnLeftoverBucket.call(this, leftover, bucketName, resourceType, region);
  }
  listOwnedBucket(
    bucketName: string
  ): Promise<{ bucket: Bucket | undefined } | { unknown: string }> {
    return listOwnedBucket.call(this, bucketName);
  }
  getRegion(): Promise<string> {
    return getRegion.call(this);
  }
  buildAttributes(bucketName: string): Promise<Record<string, unknown>> {
    return buildAttributes.call(this, bucketName);
  }
  getAttribute(physicalId: string, _resourceType: string, attributeName: string): Promise<unknown> {
    return getAttribute.call(this, physicalId, _resourceType, attributeName);
  }
  applyVersioning(
    bucketName: string,
    versioningConfig: unknown,
    // The state-replay downgrade (issue #1605). Present only on a replay-
    // reachable call — the reverse-replacement create and the update path.
    onUnusable?: (message: string) => void
  ): Promise<boolean> {
    return applyVersioning.call(this, bucketName, versioningConfig, onUnusable);
  }
  applyTags(bucketName: string, tags: Array<{ Key: string; Value: string }>): Promise<void> {
    return applyTags.call(this, bucketName, tags);
  }
  applyTagDiff(
    bucketName: string,
    resourceType: string,
    logicalId: string,
    oldTagsRaw: unknown,
    newTagsRaw: unknown,
    abacEnabled = false
  ): Promise<void> {
    return applyTagDiff.call(
      this,
      bucketName,
      resourceType,
      logicalId,
      oldTagsRaw,
      newTagsRaw,
      abacEnabled
    );
  }
  replaceAbacBucketTags(bucketName: string, tagSet: CfnTagEntry[]): Promise<void> {
    return replaceAbacBucketTags.call(this, bucketName, tagSet);
  }
  applyAbacStatus(bucketName: string, status: unknown): Promise<void> {
    return applyAbacStatus.call(this, bucketName, status);
  }
  accountRegionalBucketName(prefix: string): Promise<string> {
    return accountRegionalBucketName.call(this, prefix);
  }
  createMetadataConfiguration(
    bucketName: string,
    desired: Record<string, unknown>,
    stateBorne: boolean
  ): Promise<boolean> {
    return createMetadataConfiguration.call(this, bucketName, desired, stateBorne);
  }
  convergeMetadataConfiguration(
    bucketName: string,
    desired: Record<string, unknown>,
    live: MetadataConfigurationResult,
    stateBorne: boolean
  ): Promise<boolean> {
    return convergeMetadataConfiguration.call(this, bucketName, desired, live, stateBorne);
  }
  applyMetadataConfigurationDiff(
    bucketName: string,
    desiredRaw: unknown,
    previousRaw: unknown,
    stateBorne: boolean,
    refuseOnly: boolean
  ): Promise<boolean> {
    return applyMetadataConfigurationDiff.call(
      this,
      bucketName,
      desiredRaw,
      previousRaw,
      stateBorne,
      refuseOnly
    );
  }
  waitForMetadataTables(
    bucketName: string,
    sent: MetadataConfiguration,
    stateBorne: boolean
  ): Promise<void> {
    return waitForMetadataTables.call(this, bucketName, sent, stateBorne);
  }
  warnMetadataTableFailed(
    bucketName: string,
    name: string,
    table: {
      TableArn?: string | undefined;
      Error?: { ErrorCode?: string | undefined; ErrorMessage?: string | undefined } | undefined;
    }
  ): void {
    return warnMetadataTableFailed.call(this, bucketName, name, table);
  }
  readMetadataConfigurationResult(
    bucket: string
  ): Promise<MetadataConfigurationResult | undefined> {
    return readMetadataConfigurationResult.call(this, bucket);
  }
  readMetadataForDrift(
    bucket: string
  ): Promise<MetadataConfigurationResult | undefined | 'unread'> {
    return readMetadataForDrift.call(this, bucket);
  }
  readMetadataAttributesAfterWrites(
    bucket: string,
    context: CreateContext | UpdateContext | undefined
  ): Promise<Record<string, unknown>> {
    return readMetadataAttributesAfterWrites.call(this, bucket, context);
  }
  readMetadataAttributes(bucket: string): Promise<Record<string, unknown>> {
    return readMetadataAttributes.call(this, bucket);
  }
  applyCorsConfiguration(
    bucketName: string,
    corsConfig: { CorsRules: Array<Record<string, unknown>> }
  ): Promise<void> {
    return applyCorsConfiguration.call(this, bucketName, corsConfig);
  }
  skipOnUnusableConfigString(
    container: unknown,
    key: string,
    fallback: string,
    containerPath: string,
    skipClause: string,
    onUnusable?: (message: string) => void
  ): boolean {
    return skipOnUnusableConfigString.call(
      this,
      container,
      key,
      fallback,
      containerPath,
      skipClause,
      onUnusable
    );
  }
  readSubstitutedConfigString(
    container: unknown,
    key: string,
    fallback: string,
    containerPath: string,
    options: ConfigStringOptions
  ): string {
    return readSubstitutedConfigString.call(this, container, key, fallback, containerPath, options);
  }
  applyLifecycleConfiguration(
    bucketName: string,
    lifecycleConfig: {
      Rules: Array<Record<string, unknown>>;
      TransitionDefaultMinimumObjectSize?: unknown;
    },
    onUnusable?: (message: string) => void
  ): Promise<boolean> {
    return applyLifecycleConfiguration.call(this, bucketName, lifecycleConfig, onUnusable);
  }
  applyPublicAccessBlockConfiguration(
    bucketName: string,
    config: Record<string, unknown>
  ): Promise<void> {
    return applyPublicAccessBlockConfiguration.call(this, bucketName, config);
  }
  applyBucketEncryption(
    bucketName: string,
    encryptionConfig: { ServerSideEncryptionConfiguration: Array<Record<string, unknown>> }
  ): Promise<void> {
    return applyBucketEncryption.call(this, bucketName, encryptionConfig);
  }
  applyLoggingConfiguration(
    bucketName: string,
    loggingConfig: unknown,
    // The state-replay downgrade (issue #1605).
    onUnusable?: (message: string) => void
  ): Promise<boolean> {
    return applyLoggingConfiguration.call(this, bucketName, loggingConfig, onUnusable);
  }
  applyWebsiteConfiguration(
    bucketName: string,
    websiteConfig: Record<string, unknown>
  ): Promise<void> {
    return applyWebsiteConfiguration.call(this, bucketName, websiteConfig);
  }
  applyAccelerateConfiguration(bucketName: string, config: Record<string, unknown>): Promise<void> {
    return applyAccelerateConfiguration.call(this, bucketName, config);
  }
  applyNotificationConfiguration(
    bucketName: string,
    notifConfig: Record<string, unknown> | undefined,
    onUnusable?: (message: string) => void
  ): Promise<boolean> {
    return applyNotificationConfiguration.call(this, bucketName, notifConfig, onUnusable);
  }
  cfnNotifFilterToSdk(
    filter: unknown
  ): { Key: { FilterRules: Array<{ Name: string; Value: string }> } } | undefined {
    return cfnNotifFilterToSdk.call(this, filter);
  }
  applyMetricsConfigurations(
    bucketName: string,
    configs: Array<Record<string, unknown>>,
    onUnusable?: (message: string) => void
  ): Promise<PerItemApplyOutcome> {
    return applyMetricsConfigurations.call(this, bucketName, configs, onUnusable);
  }
  resolveS3BucketDestination(
    dest: unknown,
    destinationPath: string,
    onUnusable?: (message: string) => void,
    // TRAILING with an identity default, following
    // `dynamodb-table-provider.ts`'s `skipWarmThroughputDecrease`: every
    // existing caller keeps compiling and "absent means unmasked" stays the
    // back-compatible contract.
    maskSecrets: MaskerFn = (text) => text
  ): Record<string, unknown> | undefined {
    return resolveS3BucketDestination.call(this, dest, destinationPath, onUnusable, maskSecrets);
  }
  applyAnalyticsConfigurations(
    bucketName: string,
    configs: Array<Record<string, unknown>>,
    onUnusable?: (message: string) => void,
    // TRAILING with an identity default (same shape as
    // `resolveS3BucketDestination` below it): the masker only reaches the
    // destination-shape refusals, so an absent one leaves today's behaviour
    // exactly as it was.
    maskSecrets: MaskerFn = (text) => text
  ): Promise<PerItemApplyOutcome> {
    return applyAnalyticsConfigurations.call(this, bucketName, configs, onUnusable, maskSecrets);
  }
  applyIntelligentTieringConfigurations(
    bucketName: string,
    configs: Array<Record<string, unknown>>,
    onUnusable?: (message: string) => void
  ): Promise<PerItemApplyOutcome> {
    return applyIntelligentTieringConfigurations.call(this, bucketName, configs, onUnusable);
  }
  applyInventoryConfigurations(
    bucketName: string,
    configs: Array<Record<string, unknown>>,
    onUnusable?: (message: string) => void,
    // TRAILING with an identity default (same shape as
    // `resolveS3BucketDestination` below it): the masker only reaches the
    // destination-shape refusals, so an absent one leaves today's behaviour
    // exactly as it was.
    maskSecrets: MaskerFn = (text) => text
  ): Promise<PerItemApplyOutcome> {
    return applyInventoryConfigurations.call(this, bucketName, configs, onUnusable, maskSecrets);
  }
  buildReplicationDestination(dest: Record<string, unknown>): Record<string, unknown> {
    return buildReplicationDestination.call(this, dest);
  }
  applyReplicationConfiguration(
    bucketName: string,
    replConfig: Record<string, unknown>,
    onUnusable?: (message: string) => void
  ): Promise<boolean> {
    return applyReplicationConfiguration.call(this, bucketName, replConfig, onUnusable);
  }
  applyObjectLockConfiguration(
    bucketName: string,
    config: Record<string, unknown>,
    // The state-replay downgrade (issue #1605). Present only on a replay-
    // reachable call -- the reverse-replacement create and the update path.
    onUnusable?: (message: string) => void
  ): Promise<boolean> {
    return applyObjectLockConfiguration.call(this, bucketName, config, onUnusable);
  }
  applyConfiguration(
    bucketName: string,
    properties: Record<string, unknown>,
    options: { skipDiffManaged?: boolean; context?: CreateContext } & (
      | { skipTags: true }
      // The list `refuseMalformedDesiredTags` returned (go-to-k/cdkd#3994):
      // required whenever tags are applied, so no caller can drop them.
      | { skipTags?: false; desiredTags: CfnTagEntry[] }
    )
  ): Promise<Map<string, unknown>> {
    return applyConfiguration.call(this, bucketName, properties, options);
  }
  applyOwnershipControls(
    bucketName: string,
    ownershipControls: { Rules: Array<{ ObjectOwnership: string }> }
  ): Promise<void> {
    return applyOwnershipControls.call(this, bucketName, ownershipControls);
  }
  static emptyListConfigToUndefined<T extends Record<string, unknown>>(
    config: T | undefined,
    listKey: string
  ): T | undefined {
    return emptyListConfigToUndefined(config, listKey);
  }
  static declaresEmptyCollection(config: unknown, listKey: string): boolean {
    return declaresEmptyCollection(config, listKey);
  }
  noWriteProbe(): S3BucketProvider {
    return noWriteProbe.call(this);
  }
  maskedView(sinks: MaskedLogSinks): S3BucketProvider {
    return maskedView.call(this, sinks);
  }
  shown(value: unknown): string {
    return shown.call(this, value);
  }

  /** This operation's masker, or identity outside one (the singleton, `delete()`). */
  get shownMask(): MaskerFn {
    return maskerOrIdentity(this.opMask);
  }
  maskRaw(text: string): string {
    return maskRaw.call(this, text);
  }
  static versioningOrLoggingRefusal(
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>
  ): string | undefined {
    return versioningOrLoggingRefusal(properties, previousProperties);
  }
  static applyEffectiveOverrides(
    properties: Record<string, unknown>,
    overrides: Map<string, unknown>
  ): Record<string, unknown> | undefined {
    return applyEffectiveOverrides(properties, overrides);
  }
  static buildEffectiveItemArray(
    desired: Array<Record<string, unknown>>,
    previous: Array<Record<string, unknown>> | undefined,
    isSkipped: (item: Record<string, unknown>, index: number) => boolean,
    sentItemOf?: (
      item: Record<string, unknown>,
      index: number
    ) => Record<string, unknown> | undefined
  ): Array<Record<string, unknown>> | undefined {
    return buildEffectiveItemArray(desired, previous, isSkipped, sentItemOf);
  }
  emptyCollectionSkip(
    key: string,
    collectionPath: string,
    previousProperties: Record<string, unknown>,
    retainPrevious: (key: string) => void
  ): void {
    return emptyCollectionSkip.call(this, key, collectionPath, previousProperties, retainPrevious);
  }
  announceCreateEmptyCollectionSkip(key: string, collectionPath: string): void {
    return announceCreateEmptyCollectionSkip.call(this, key, collectionPath);
  }
  diffSubConfig<T>(
    _bucketName: string,
    oldVal: T | undefined,
    newVal: T | undefined,
    onPut: (newVal: T) => Promise<void>,
    onDelete: () => Promise<void>
  ): Promise<void> {
    return diffSubConfig.call(
      this,
      _bucketName,
      oldVal,
      newVal,
      onPut as (newVal: unknown) => Promise<void>,
      onDelete
    );
  }
  diffArrayConfigById(
    _bucketName: string,
    oldArr: Array<Record<string, unknown>> | undefined,
    newArr: Array<Record<string, unknown>> | undefined,
    onPut: (id: string, config: Record<string, unknown>) => Promise<void>,
    onDelete: (id: string) => Promise<void>
  ): Promise<void> {
    return diffArrayConfigById.call(this, _bucketName, oldArr, newArr, onPut, onDelete);
  }
  applySubConfigDiffs(
    bucketName: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>,
    context?: UpdateContext,
    // `true` only from `update()`'s template-path pre-flight, which runs this
    // method on {@link noWriteProbe} (issue #3740): the eight per-config
    // appliers below then get NO warn callback, so each refuses exactly where
    // it would otherwise warn-and-skip — the create-path refusal, with the
    // same predicate, key, fallback and path, and only for the configurations
    // this diff would actually Put.
    refuseUnusable = false
  ): Promise<Map<string, unknown>> {
    return applySubConfigDiffs.call(
      this,
      bucketName,
      properties,
      previousProperties,
      context,
      refuseUnusable
    );
  }
  applyAllSubConfigsForCreate(
    bucketName: string,
    properties: Record<string, unknown>,
    context?: CreateContext
  ): Promise<Map<string, unknown>> {
    return applyAllSubConfigsForCreate.call(this, bucketName, properties, context);
  }
  assertExistingBucketRegion(
    logicalId: string,
    resourceType: string,
    bucketName: string,
    expectedRegion: string,
    createError: Error
  ): Promise<void> {
    return assertExistingBucketRegion.call(
      this,
      logicalId,
      resourceType,
      bucketName,
      expectedRegion,
      createError
    );
  }
  refuseForeignRegionAdopt(
    logicalId: string,
    resourceType: string,
    bucketName: string,
    wantRegion: string,
    actualRegion: string,
    cause?: Error
  ): never {
    return refuseForeignRegionAdopt.call(
      this,
      logicalId,
      resourceType,
      bucketName,
      wantRegion,
      actualRegion,
      cause
    );
  }
  resolveOwnedBucketRegion(bucketName: string, awsError?: Error): Promise<string> {
    return resolveOwnedBucketRegion.call(this, bucketName, awsError);
  }
  probeBucketRegion(bucketName: string): Promise<BucketRegionProbe> {
    return probeBucketRegion.call(this, bucketName);
  }
  assertStateBucketRegion(
    operation: 'update' | 'delete',
    logicalId: string,
    resourceType: string,
    physicalId: string,
    expectedRegion: string,
    // The delete's context: its remedy names the whole-stack
    // `cdkd state orphan` only on a stack destroy (go-to-k/cdkd#4602).
    context?: DeleteContext
  ): Promise<void> {
    return assertStateBucketRegion.call(
      this,
      operation,
      logicalId,
      resourceType,
      physicalId,
      expectedRegion,
      context
    );
  }
  announceUnverifiedBucketIdentity(
    operation: 'update' | 'delete',
    logicalId: string,
    physicalId: string,
    cause: UnverifiedIdentityCause
  ): void {
    return announceUnverifiedBucketIdentity.call(this, operation, logicalId, physicalId, cause);
  }
  create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    context?: CreateContext
  ): Promise<ResourceCreateResult> {
    return create.call(this, logicalId, resourceType, properties, context);
  }
  update(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>,
    context?: UpdateContext
  ): Promise<ResourceUpdateResult> {
    return update.call(
      this,
      logicalId,
      physicalId,
      resourceType,
      properties,
      previousProperties,
      context
    );
  }
  warnUnappliedBucketObjectLock(
    logicalId: string,
    bucketName: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>,
    context: UpdateContext | undefined
  ): Promise<void> {
    return warnUnappliedBucketObjectLock.call(
      this,
      logicalId,
      bucketName,
      properties,
      previousProperties,
      context
    );
  }
  delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void | ResourceDeleteResult> {
    return deleteImpl.call(this, logicalId, physicalId, resourceType, properties, context);
  }
  wrapOperationError(
    operation: 'create' | 'update' | 'delete',
    logicalId: string,
    resourceType: string,
    physicalId: string,
    error: unknown,
    deleteMask?: MaskerFn
  ): ProvisioningError {
    return wrapOperationError.call(
      this,
      operation,
      logicalId,
      resourceType,
      physicalId,
      error,
      deleteMask
    );
  }
  canonicalizeDesiredProperties(
    resourceType: string,
    properties: Record<string, unknown>
  ): Record<string, unknown> {
    return canonicalizeDesiredProperties.call(this, resourceType, properties);
  }
  readCurrentState(
    physicalId: string,
    logicalId: string,
    _resourceType: string,
    _properties?: Record<string, unknown>,
    context?: ReadCurrentStateContext
  ): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
    return readCurrentState.call(this, physicalId, logicalId, _resourceType, _properties, context);
  }
  getDriftAbsentMeansDefaultKeys(
    _resourceType: string,
    properties: Record<string, unknown>
  ): readonly string[] {
    return getDriftAbsentMeansDefaultKeys.call(this, _resourceType, properties);
  }
  getDriftUnknownPaths(): string[] {
    return getDriftUnknownPaths.call(this);
  }
  readVersioning(bucket: string): Promise<Record<string, unknown>> {
    return readVersioning.call(this, bucket);
  }
  readOwnershipControls(bucket: string): Promise<Record<string, unknown>> {
    return readOwnershipControls.call(this, bucket);
  }
  readEncryption(bucket: string): Promise<Record<string, unknown>> {
    return readEncryption.call(this, bucket);
  }
  readPublicAccessBlock(bucket: string): Promise<Record<string, unknown>> {
    return readPublicAccessBlock.call(this, bucket);
  }
  readTags(bucket: string): Promise<Array<{ Key: string; Value: string }>> {
    return readTags.call(this, bucket);
  }
  readLifecycle(bucket: string): Promise<Record<string, unknown>> {
    return readLifecycle.call(this, bucket);
  }
  readCors(bucket: string): Promise<Record<string, unknown>> {
    return readCors.call(this, bucket);
  }
  readWebsite(bucket: string): Promise<Record<string, unknown>> {
    return readWebsite.call(this, bucket);
  }
  readLogging(bucket: string): Promise<Record<string, unknown>> {
    return readLogging.call(this, bucket);
  }
  emitNotificationEvents(target: Record<string, unknown>, events?: string[]): void {
    return emitNotificationEvents.call(this, target, events);
  }
  readNotification(bucket: string): Promise<Record<string, unknown>> {
    return readNotification.call(this, bucket);
  }
  sdkNotifFilterToCfn(filter: unknown): Record<string, unknown> {
    return sdkNotifFilterToCfn.call(this, filter);
  }
  readReplication(bucket: string): Promise<Record<string, unknown>> {
    return readReplication.call(this, bucket);
  }
  isLiveObjectLocked(
    bucketName: string,
    unreadNote: '' | '; treating it as locked'
  ): Promise<boolean | undefined> {
    return isLiveObjectLocked.call(this, bucketName, unreadNote);
  }
  readObjectLock(bucket: string): Promise<Record<string, unknown>> {
    return readObjectLock.call(this, bucket);
  }
  readAbacStatus(bucket: string): Promise<string | undefined> {
    return readAbacStatus.call(this, bucket);
  }
  readAccelerate(bucket: string): Promise<Record<string, unknown>> {
    return readAccelerate.call(this, bucket);
  }
  readMetricsList(bucket: string): Promise<Array<Record<string, unknown>>> {
    return readMetricsList.call(this, bucket);
  }
  metricsSdkToCfn(c: Record<string, unknown>): Record<string, unknown> {
    return metricsSdkToCfn.call(this, c);
  }
  readAnalyticsList(bucket: string): Promise<Array<Record<string, unknown>>> {
    return readAnalyticsList.call(this, bucket);
  }
  analyticsSdkToCfn(c: Record<string, unknown>): Record<string, unknown> {
    return analyticsSdkToCfn.call(this, c);
  }
  readIntelligentTieringList(bucket: string): Promise<Array<Record<string, unknown>>> {
    return readIntelligentTieringList.call(this, bucket);
  }
  intelligentTieringSdkToCfn(c: Record<string, unknown>): Record<string, unknown> {
    return intelligentTieringSdkToCfn.call(this, c);
  }
  readInventoryList(bucket: string): Promise<Array<Record<string, unknown>>> {
    return readInventoryList.call(this, bucket);
  }
  inventorySdkToCfn(c: Record<string, unknown>): Record<string, unknown> {
    return inventorySdkToCfn.call(this, c);
  }
  isSameResource(
    journaledPhysicalId: string,
    record: { physicalId: string },
    resourceType: string,
    context: { expectedRegion: string }
  ): Promise<ResourceIdentityVerdict> {
    return isSameResource.call(this, journaledPhysicalId, record, resourceType, context);
  }
  resourceIdentity(
    physicalId: string,
    resourceType: string,
    context: { expectedRegion: string }
  ): Promise<string | ResourceNotFound | undefined> {
    return resourceIdentity.call(this, physicalId, resourceType, context);
  }
  generatedCreateName(
    _resourceType: string,
    logicalId: string,
    properties: Record<string, unknown>
  ): string | undefined {
    return generatedCreateName.call(this, _resourceType, logicalId, properties);
  }
  import(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    return importImpl.call(this, input);
  }
  deleteBucketWithEmptyRetry(
    logicalId: string,
    bucketName: string,
    allowAutoEmpty: boolean
  ): Promise<void> {
    return deleteBucketWithEmptyRetry.call(this, logicalId, bucketName, allowAutoEmpty);
  }
  emptyBucket(bucketName: string): Promise<void> {
    return emptyBucket.call(this, bucketName);
  }
}
