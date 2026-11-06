import { GlueClient } from '@aws-sdk/client-glue';
import { STSClient } from '@aws-sdk/client-sts';
import { getLogger, type ConsoleLogger } from '../../utils/logger.js';
import { ProvisioningError } from '../../utils/error-handler.js';
import type { DeleteContext } from '../region-check.js';
import type { MaskerFn } from '../masked-retry-logger.js';
import type {
  CreateContext,
  ResourceProvider,
  ResourceCreateResult,
  ResourceDeleteResult,
  ResourceUpdateResult,
  ResourceImportInput,
  ResourceImportResult,
  UpdateContext,
  ResourceNotFound,
} from '../../types/resource.js';
import { ambientRegion } from '../../utils/stack-aws-scope.js';
import { type Mixin, installMethods } from './glue/mixins.js';
import { databaseMethods } from './glue/database.js';
import { tableWriteMethods } from './glue/table-write.js';
import { tableReadMethods } from './glue/table-read.js';
import {
  workflowMethods,
  workflowWrapMaskedError,
  workflowGetClient,
  workflowGetCreateClient,
  workflowCreate,
  workflowUpdate,
  workflowDelete,
  workflowGetAttribute,
  workflowReadCurrentState,
  workflowImport,
} from './glue/workflow.js';
import {
  crawlerMethods,
  crawlerWrapMaskedError,
  CRAWLER_LEFT_IN_PLACE_ON_REMOVAL,
  crawlerGetClient,
  crawlerGetCreateClient,
  crawlerGetStsClient,
  crawlerCreate,
  crawlerUpdate,
  crawlerDelete,
  crawlerGetAttribute,
  crawlerReadCurrentState,
  crawlerStartSchedule,
  crawlerStopSchedule,
  crawlerResourceArn,
  crawlerImport,
} from './glue/crawler.js';
import {
  triggerMethods,
  triggerWrapMaskedError,
  triggerGetClient,
  triggerGetCreateClient,
  triggerGetStsClient,
  triggerCreate,
  triggerUpdate,
  triggerUnsettledInTransition,
  triggerDelete,
  triggerGetAttribute,
  triggerReadCurrentState,
  triggerResourceArn,
  triggerImport,
} from './glue/trigger.js';
import { makeCallerAccountResolver } from './glue/names.js';
import {
  glueWrapMaskedError,
  glueGetClient,
  glueGetCreateClient,
  glueCreate,
  glueUpdate,
  glueDelete,
  glueReadCurrentState,
  glueGetDriftUnknownPaths,
  glueImport,
} from './glue/dispatch.js';
import {
  securityConfigurationWrapMaskedError,
  securityConfigurationGetClient,
  securityConfigurationGetCreateClient,
  securityConfigurationCreate,
  securityConfigurationUpdate,
  securityConfigurationDelete,
  securityConfigurationGetAttribute,
  securityConfigurationReadCurrentState,
  securityConfigurationImport,
} from './glue/security-configuration.js';
import {
  jobWrapMaskedError,
  jobGetClient,
  jobGetCreateClient,
  jobGetStsClient,
  jobCreate,
  jobUpdate,
  jobDelete,
  jobGetAttribute,
  jobReadCurrentState,
  jobResourceArn,
  jobImport,
} from './glue/job.js';
import {
  connectionWrapMaskedError,
  connectionGetStsClient,
  connectionResourceArn,
  connectionGetClient,
  connectionGetCreateClient,
  connectionCreate,
  connectionUpdate,
  connectionDelete,
  connectionGetAttribute,
  connectionReadCurrentState,
  connectionImport,
} from './glue/connection.js';

/*
 * Each provider class's methods live in `./glue/*.ts` as `this:`-typed
 * functions. A method other providers also declare (`create`, `getClient`, ...)
 * keeps a delegating method in its class; the rest are installed on the
 * class's prototype at the bottom of this file (`installMethods`), so they are
 * ordinary prototype methods at runtime, and these interfaces give them their
 * types. The fields the moved bodies read are therefore not `private`.
 */
// eslint-disable-next-line typescript/no-unsafe-declaration-merging
export interface GlueProvider extends Mixin<
  typeof databaseMethods & typeof tableWriteMethods & typeof tableReadMethods
> {}
// eslint-disable-next-line typescript/no-unsafe-declaration-merging
export interface GlueWorkflowProvider extends Mixin<typeof workflowMethods> {}
// eslint-disable-next-line typescript/no-unsafe-declaration-merging
export interface GlueCrawlerProvider extends Mixin<typeof crawlerMethods> {}
// eslint-disable-next-line typescript/no-unsafe-declaration-merging
export interface GlueTriggerProvider extends Mixin<typeof triggerMethods> {}

/**
 * SDK Provider for AWS Glue resources
 *
 * Supports:
 * - AWS::Glue::Database
 * - AWS::Glue::Table
 *
 * Glue CreateDatabase/CreateTable are synchronous - the CC API adds unnecessary
 * polling overhead for operations that complete immediately.
 */
export class GlueProvider implements ResourceProvider {
  client: GlueClient | undefined;
  createClient: GlueClient | undefined;
  readonly providerRegion = ambientRegion();
  readonly callerAccountId = makeCallerAccountResolver(this.providerRegion);
  logger: ConsoleLogger = getLogger().child('GlueProvider');

  wrapMaskedError(
    mask: MaskerFn,
    error: unknown,
    build: (maskedText: string) => ProvisioningError
  ): ProvisioningError {
    return glueWrapMaskedError.call(this, mask, error, build);
  }

  handledProperties = new Map<string, ReadonlySet<string>>([
    ['AWS::Glue::Database', new Set(['DatabaseInput', 'DatabaseName', 'CatalogId'])],
    [
      'AWS::Glue::Table',
      new Set(['DatabaseName', 'TableInput', 'Name', 'CatalogId', 'OpenTableFormatInput']),
    ],
  ]);

  getClient(): GlueClient {
    return glueGetClient.call(this);
  }
  getCreateClient(): GlueClient {
    return glueGetCreateClient.call(this);
  }
  create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    context?: CreateContext
  ): Promise<ResourceCreateResult> {
    return glueCreate.call(this, logicalId, resourceType, properties, context);
  }
  update(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>,
    context?: UpdateContext
  ): Promise<ResourceUpdateResult> {
    return glueUpdate.call(
      this,
      logicalId,
      physicalId,
      resourceType,
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
    return glueDelete.call(this, logicalId, physicalId, resourceType, properties, context);
  }
  readCurrentState(
    physicalId: string,
    _logicalId: string,
    resourceType: string,
    properties?: Record<string, unknown>
  ): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
    return glueReadCurrentState.call(this, physicalId, _logicalId, resourceType, properties);
  }
  getDriftUnknownPaths(resourceType: string, properties?: Record<string, unknown>): string[] {
    return glueGetDriftUnknownPaths.call(this, resourceType, properties);
  }
  import(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    return glueImport.call(this, input);
  }
}

// ─── AWS::Glue::Workflow ───────────────────────────────────────────
//
// Glue Workflow has a clean SDK update path (`UpdateWorkflow`) covering
// every mutable top-level field — `Description`, `DefaultRunProperties`,
// `MaxConcurrentRuns`. `Name` is immutable on create. Tags ride on
// `CreateWorkflow.Tags`; an update reconciles them out of band via
// `TagResource` / `UntagResource` (`applyGlueTagDiff`).
//
// Surface used by `cdkd drift`:
//   - `readCurrentState` reads via `GetWorkflow` and reverse-maps every
//     user-controllable top-level key to the CFn shape with PR #145
//     always-emit placeholders (`Description: ''`, `DefaultRunProperties: {}`,
//     `MaxConcurrentRuns: undefined` only when AWS reports nothing — same
//     pattern used by other providers' optional integer fields).
//   - `getDriftUnknownPaths` is empty: no AWS-managed read-only fields are
//     templated into cdkd state for this type.

/**
 * SDK Provider for `AWS::Glue::Workflow`.
 *
 * Workflow is a top-level Glue catalog entry that orchestrates Triggers,
 * Jobs, and Crawlers via a DAG. The CFn shape carries `Name` (required,
 * immutable on create), `Description`, `DefaultRunProperties` (string→string
 * map), `MaxConcurrentRuns`, and `Tags`.
 *
 * Read-update round-trip: `cdkd drift --revert` calls `update(...,
 * awsCurrent, observedSnapshot)` so the same `UpdateWorkflow` payload is
 * built from either side. `Description` and `DefaultRunProperties` use
 * `!== undefined` gates so empty-string / empty-map values reach AWS
 * (matches `feedback_update_optional_field_undefined_check.md`).
 */
export class GlueWorkflowProvider implements ResourceProvider {
  client: GlueClient | undefined;
  createClient: GlueClient | undefined;
  stsClient: STSClient | undefined;
  cachedAccountId: string | undefined;
  readonly providerRegion = ambientRegion();
  logger: ConsoleLogger = getLogger().child('GlueWorkflowProvider');

  wrapMaskedError(
    mask: MaskerFn,
    error: unknown,
    build: (maskedText: string) => ProvisioningError
  ): ProvisioningError {
    return workflowWrapMaskedError.call(this, mask, error, build);
  }

  handledProperties = new Map<string, ReadonlySet<string>>([
    [
      'AWS::Glue::Workflow',
      new Set(['Name', 'Description', 'DefaultRunProperties', 'MaxConcurrentRuns', 'Tags']),
    ],
  ]);

  /**
   * Issue #1160 (`ResourceProvider.removalHandledInUpdate`): every property,
   * each removal handled by `update()`, so the shared caller warns about none.
   * `UpdateWorkflow` is a full replace — an omitted field is CLEARED, not kept
   * — and a CloudFormation A/B showed CloudFormation clears all three removed
   * fields too, so omitting them is the reset and no `removalDefaults` apply.
   */
  removalHandledInUpdate = new Map<string, ReadonlySet<string>>([
    [
      'AWS::Glue::Workflow',
      new Set([
        // Create-only: a removal replaces.
        'Name',
        // Omitted from the full-replace UpdateWorkflow, which clears them.
        'Description',
        'DefaultRunProperties',
        'MaxConcurrentRuns',
        // Diffed by TagResource / UntagResource, removal included.
        'Tags',
      ]),
    ],
  ]);

  getClient(): GlueClient {
    return workflowGetClient.call(this);
  }
  getCreateClient(): GlueClient {
    return workflowGetCreateClient.call(this);
  }
  create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    context?: CreateContext
  ): Promise<ResourceCreateResult> {
    return workflowCreate.call(this, logicalId, resourceType, properties, context);
  }
  update(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>,
    context?: UpdateContext
  ): Promise<ResourceUpdateResult> {
    return workflowUpdate.call(
      this,
      logicalId,
      physicalId,
      resourceType,
      properties,
      previousProperties,
      context
    );
  }
  delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    _properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void> {
    return workflowDelete.call(this, logicalId, physicalId, resourceType, _properties, context);
  }
  getAttribute(physicalId: string, _resourceType: string, attributeName: string): Promise<unknown> {
    return workflowGetAttribute.call(this, physicalId, _resourceType, attributeName);
  }
  readCurrentState(
    physicalId: string,
    _logicalId: string,
    _resourceType: string
  ): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
    return workflowReadCurrentState.call(this, physicalId, _logicalId, _resourceType);
  }
  import(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    return workflowImport.call(this, input);
  }
}

// ─── AWS::Glue::SecurityConfiguration ──────────────────────────────
//
// SecurityConfiguration is **immutable on update** per AWS docs — the
// only mutators are `CreateSecurityConfiguration` and
// `DeleteSecurityConfiguration`. Any update path therefore surfaces
// `ResourceUpdateNotSupportedError` so `cdkd drift --revert` reports a
// clean "use cdkd deploy --replace" outcome instead of silently no-op'ing.
//
// `EncryptionConfiguration` carries three sub-configs (CFn names):
//   - `S3Encryptions[]` (plural in CFn; maps to the SDK `S3Encryption` singular
//     field) — array of `{S3EncryptionMode, KmsKeyArn}`
//   - `CloudWatchEncryption` — `{CloudWatchEncryptionMode, KmsKeyArn}`
//   - `JobBookmarksEncryption` — `{JobBookmarksEncryptionMode, KmsKeyArn}`
// AWS docs also surface `DataQualityEncryption` on the SDK shape but
// CloudFormation does NOT model it (`AWS::Glue::SecurityConfiguration`
// has only the three above), so we ignore it on read to avoid false
// drift on the v3 baseline.

/**
 * SDK Provider for `AWS::Glue::SecurityConfiguration`.
 *
 * Immutable resource — `update()` always throws
 * `ResourceUpdateNotSupportedError`. Replacement falls through to the
 * deploy engine's CREATE→DELETE replacement path.
 *
 * Tags are NOT supported on `CreateSecurityConfiguration` (verified
 * against the SDK shape — `CreateSecurityConfigurationRequest` has only
 * `Name` + `EncryptionConfiguration`), so cdkd does not surface a `Tags`
 * key in `readCurrentState` even with an always-emit placeholder.
 */
export class GlueSecurityConfigurationProvider implements ResourceProvider {
  client: GlueClient | undefined;
  createClient: GlueClient | undefined;
  readonly providerRegion = ambientRegion();
  logger: ConsoleLogger = getLogger().child('GlueSecurityConfigurationProvider');

  wrapMaskedError(
    mask: MaskerFn,
    error: unknown,
    build: (maskedText: string) => ProvisioningError
  ): ProvisioningError {
    return securityConfigurationWrapMaskedError.call(this, mask, error, build);
  }

  handledProperties = new Map<string, ReadonlySet<string>>([
    ['AWS::Glue::SecurityConfiguration', new Set(['Name', 'EncryptionConfiguration'])],
  ]);

  getClient(): GlueClient {
    return securityConfigurationGetClient.call(this);
  }
  getCreateClient(): GlueClient {
    return securityConfigurationGetCreateClient.call(this);
  }
  create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    context?: CreateContext
  ): Promise<ResourceCreateResult> {
    return securityConfigurationCreate.call(this, logicalId, resourceType, properties, context);
  }
  update(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    _properties: Record<string, unknown>,
    _previousProperties: Record<string, unknown>,
    context?: UpdateContext
  ): Promise<ResourceUpdateResult> {
    return securityConfigurationUpdate.call(
      this,
      logicalId,
      physicalId,
      resourceType,
      _properties,
      _previousProperties,
      context
    );
  }
  delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    _properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void> {
    return securityConfigurationDelete.call(
      this,
      logicalId,
      physicalId,
      resourceType,
      _properties,
      context
    );
  }
  getAttribute(physicalId: string, _resourceType: string, attributeName: string): Promise<unknown> {
    return securityConfigurationGetAttribute.call(this, physicalId, _resourceType, attributeName);
  }
  readCurrentState(
    physicalId: string,
    _logicalId: string,
    _resourceType: string
  ): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
    return securityConfigurationReadCurrentState.call(this, physicalId, _logicalId, _resourceType);
  }
  import(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    return securityConfigurationImport.call(this, input);
  }
}

/**
 * SDK Provider for `AWS::Glue::Job`.
 *
 * CFn properties (subset cdkd manages on create/update):
 *   Name, Role, Command, Description, MaxCapacity, MaxRetries, Timeout,
 *   ExecutionProperty, GlueVersion, NumberOfWorkers, WorkerType,
 *   DefaultArguments, NonOverridableArguments, Connections, LogUri,
 *   SecurityConfiguration, NotificationProperty, ExecutionClass,
 *   JobMode, JobRunQueuingEnabled, MaintenanceWindow, AllocatedCapacity,
 *   SourceControlDetails, Tags.
 *
 * `physicalId` is the Glue job name. Tags on a Job are managed via the
 * separate `GetTags` / `TagResource` / `UntagResource` API since
 * `UpdateJob` / `JobUpdate` does not carry tags.
 */
export class GlueJobProvider implements ResourceProvider {
  client: GlueClient | undefined;
  createClient: GlueClient | undefined;
  stsClient: STSClient | undefined;
  cachedAccountId: string | undefined;
  readonly providerRegion = ambientRegion();
  logger: ConsoleLogger = getLogger().child('GlueJobProvider');

  wrapMaskedError(
    mask: MaskerFn,
    error: unknown,
    build: (maskedText: string) => ProvisioningError
  ): ProvisioningError {
    return jobWrapMaskedError.call(this, mask, error, build);
  }

  handledProperties = new Map<string, ReadonlySet<string>>([
    [
      'AWS::Glue::Job',
      new Set([
        'Name',
        'Role',
        'Command',
        'Description',
        'MaxCapacity',
        'MaxRetries',
        'Timeout',
        'ExecutionProperty',
        'GlueVersion',
        'NumberOfWorkers',
        'WorkerType',
        'DefaultArguments',
        'NonOverridableArguments',
        'Connections',
        'LogUri',
        'SecurityConfiguration',
        'NotificationProperty',
        'ExecutionClass',
        'JobMode',
        'JobRunQueuingEnabled',
        'MaintenanceWindow',
        'AllocatedCapacity',
        'SourceControlDetails',
        'Tags',
      ]),
    ],
  ]);

  getClient(): GlueClient {
    return jobGetClient.call(this);
  }
  getCreateClient(): GlueClient {
    return jobGetCreateClient.call(this);
  }
  getStsClient(): STSClient {
    return jobGetStsClient.call(this);
  }
  create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    context?: CreateContext
  ): Promise<ResourceCreateResult> {
    return jobCreate.call(this, logicalId, resourceType, properties, context);
  }
  update(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>,
    context?: UpdateContext
  ): Promise<ResourceUpdateResult> {
    return jobUpdate.call(
      this,
      logicalId,
      physicalId,
      resourceType,
      properties,
      previousProperties,
      context
    );
  }
  delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    _properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void> {
    return jobDelete.call(this, logicalId, physicalId, resourceType, _properties, context);
  }
  getAttribute(physicalId: string, _resourceType: string, attributeName: string): Promise<unknown> {
    return jobGetAttribute.call(this, physicalId, _resourceType, attributeName);
  }
  readCurrentState(
    physicalId: string,
    _logicalId: string,
    _resourceType: string
  ): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
    return jobReadCurrentState.call(this, physicalId, _logicalId, _resourceType);
  }
  resourceArn(physicalId: string): Promise<string> {
    return jobResourceArn.call(this, physicalId);
  }
  import(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    return jobImport.call(this, input);
  }
}

/**
 * SDK Provider for `AWS::Glue::Crawler`.
 *
 * CFn `Schedule` is the structured `{ScheduleExpression: 'cron(...)'}`
 * object; SDK `CreateCrawler.Schedule` is a bare cron string. cdkd
 * unwraps the CFn shape on create / update and re-wraps on
 * readCurrentState. Schedule START / STOP is exposed via separate
 * `StartCrawlerSchedule` / `StopCrawlerSchedule` calls (not part of
 * Update).
 *
 * `physicalId` is the crawler name.
 */
export class GlueCrawlerProvider implements ResourceProvider {
  client: GlueClient | undefined;
  createClient: GlueClient | undefined;
  stsClient: STSClient | undefined;
  cachedAccountId: string | undefined;
  readonly providerRegion = ambientRegion();
  logger: ConsoleLogger = getLogger().child('GlueCrawlerProvider');

  wrapMaskedError(
    mask: MaskerFn,
    error: unknown,
    build: (maskedText: string) => ProvisioningError
  ): ProvisioningError {
    return crawlerWrapMaskedError.call(this, mask, error, build);
  }

  handledProperties = new Map<string, ReadonlySet<string>>([
    [
      'AWS::Glue::Crawler',
      new Set([
        'Name',
        'Role',
        'Targets',
        'DatabaseName',
        'Description',
        'Schedule',
        'Classifiers',
        'TablePrefix',
        'SchemaChangePolicy',
        'RecrawlPolicy',
        'LineageConfiguration',
        'LakeFormationConfiguration',
        'Configuration',
        'CrawlerSecurityConfiguration',
        'Tags',
      ]),
    ],
  ]);

  /**
   * Issue #1160 (`ResourceProvider.removalHandledInUpdate`): every property,
   * each removal handled by `update()`, so the shared caller (whose line
   * claims a CloudFormation reset) warns about none.
   */
  removalHandledInUpdate = new Map<string, ReadonlySet<string>>([
    [
      'AWS::Glue::Crawler',
      new Set([
        // Create-only: a removal replaces.
        'Name',
        // Required: a removal is not a valid template.
        'Role',
        'Targets',
        // Diffed by TagResource / UntagResource, removal included.
        'Tags',
        // Left in place, as CloudFormation leaves them, and named in
        // update()'s own warning (no reset).
        ...CRAWLER_LEFT_IN_PLACE_ON_REMOVAL,
      ]),
    ],
  ]);

  getClient(): GlueClient {
    return crawlerGetClient.call(this);
  }
  getCreateClient(): GlueClient {
    return crawlerGetCreateClient.call(this);
  }
  getStsClient(): STSClient {
    return crawlerGetStsClient.call(this);
  }
  create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    context?: CreateContext
  ): Promise<ResourceCreateResult> {
    return crawlerCreate.call(this, logicalId, resourceType, properties, context);
  }
  update(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>,
    context?: UpdateContext
  ): Promise<ResourceUpdateResult> {
    return crawlerUpdate.call(
      this,
      logicalId,
      physicalId,
      resourceType,
      properties,
      previousProperties,
      context
    );
  }
  delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    _properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void> {
    return crawlerDelete.call(this, logicalId, physicalId, resourceType, _properties, context);
  }
  getAttribute(physicalId: string, _resourceType: string, attributeName: string): Promise<unknown> {
    return crawlerGetAttribute.call(this, physicalId, _resourceType, attributeName);
  }
  readCurrentState(
    physicalId: string,
    _logicalId: string,
    _resourceType: string
  ): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
    return crawlerReadCurrentState.call(this, physicalId, _logicalId, _resourceType);
  }
  startSchedule(physicalId: string): Promise<void> {
    return crawlerStartSchedule.call(this, physicalId);
  }
  stopSchedule(physicalId: string): Promise<void> {
    return crawlerStopSchedule.call(this, physicalId);
  }
  resourceArn(physicalId: string): Promise<string> {
    return crawlerResourceArn.call(this, physicalId);
  }
  import(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    return crawlerImport.call(this, input);
  }
}

/**
 * SDK Provider for `AWS::Glue::Connection`.
 *
 * `physicalId` is the connection name. `ConnectionInput.ConnectionProperties`
 * is a free-form `Record<string, string>` (e.g. `JDBC_CONNECTION_URL`,
 * `USERNAME` for JDBC), surfaced as-is on read for state-shape parity.
 */
export class GlueConnectionProvider implements ResourceProvider {
  client: GlueClient | undefined;
  createClient: GlueClient | undefined;
  stsClient: STSClient | undefined;
  readonly providerRegion = ambientRegion();
  readonly callerAccountId = makeCallerAccountResolver(this.providerRegion);
  logger: ConsoleLogger = getLogger().child('GlueConnectionProvider');

  wrapMaskedError(
    mask: MaskerFn,
    error: unknown,
    build: (maskedText: string) => ProvisioningError
  ): ProvisioningError {
    return connectionWrapMaskedError.call(this, mask, error, build);
  }

  handledProperties = new Map<string, ReadonlySet<string>>([
    // `Tags` (go-to-k/cdkd#2762): sent on `CreateConnection` itself, as
    // CloudFormation does, and diffed by `TagResource` / `UntagResource` on
    // update, removal included, exactly as the Job / Crawler / Trigger do.
    ['AWS::Glue::Connection', new Set(['ConnectionInput', 'CatalogId', 'Tags'])],
  ]);

  getStsClient(): STSClient {
    return connectionGetStsClient.call(this);
  }
  resourceArn(name: string, catalogIdValue: unknown): Promise<string> {
    return connectionResourceArn.call(this, name, catalogIdValue);
  }
  getClient(): GlueClient {
    return connectionGetClient.call(this);
  }
  getCreateClient(): GlueClient {
    return connectionGetCreateClient.call(this);
  }
  create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    context?: CreateContext
  ): Promise<ResourceCreateResult> {
    return connectionCreate.call(this, logicalId, resourceType, properties, context);
  }
  update(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>,
    context?: UpdateContext
  ): Promise<ResourceUpdateResult> {
    return connectionUpdate.call(
      this,
      logicalId,
      physicalId,
      resourceType,
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
    return connectionDelete.call(this, logicalId, physicalId, resourceType, properties, context);
  }
  getAttribute(physicalId: string, _resourceType: string, attributeName: string): Promise<unknown> {
    return connectionGetAttribute.call(this, physicalId, _resourceType, attributeName);
  }
  readCurrentState(
    physicalId: string,
    _logicalId: string,
    _resourceType: string,
    properties?: Record<string, unknown>
  ): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
    return connectionReadCurrentState.call(this, physicalId, _logicalId, _resourceType, properties);
  }
  import(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    return connectionImport.call(this, input);
  }
}

/**
 * SDK Provider for `AWS::Glue::Trigger`.
 *
 * Trigger has a state machine: `ACTIVATED` (running) ↔ `DEACTIVATED`
 * (paused). `UpdateTrigger` requires the trigger to be DEACTIVATED. If
 * the AWS-current state is ACTIVATED when an update is requested, this
 * provider:
 *   1. `StopTrigger` (DEACTIVATED).
 *   2. `UpdateTrigger`.
 *   3. `StartTrigger` (re-ACTIVATED) so the user-visible state is
 *      preserved across the update.
 *
 * `physicalId` is the trigger name. Tags are managed via the Glue
 * `GetTags` / `TagResource` / `UntagResource` API (not in
 * `TriggerUpdate`).
 */
export class GlueTriggerProvider implements ResourceProvider {
  client: GlueClient | undefined;
  createClient: GlueClient | undefined;
  stsClient: STSClient | undefined;
  cachedAccountId: string | undefined;
  readonly providerRegion = ambientRegion();
  logger: ConsoleLogger = getLogger().child('GlueTriggerProvider');

  wrapMaskedError(
    mask: MaskerFn,
    error: unknown,
    build: (maskedText: string) => ProvisioningError
  ): ProvisioningError {
    return triggerWrapMaskedError.call(this, mask, error, build);
  }

  handledProperties = new Map<string, ReadonlySet<string>>([
    [
      'AWS::Glue::Trigger',
      new Set([
        'Name',
        'Type',
        'Schedule',
        'Actions',
        'Predicate',
        'Description',
        'StartOnCreation',
        'EventBatchingCondition',
        'WorkflowName',
        'Tags',
      ]),
    ],
  ]);

  /**
   * Issue #1160 (`ResourceProvider.removalHandledInUpdate`): every property,
   * each removal handled by `update()`, so the shared caller warns about none.
   * `UpdateTrigger` replaces the whole `TriggerUpdate` — an omitted field is
   * CLEARED, not kept — and a CloudFormation A/B showed CloudFormation clears a
   * removed `Description` and `EventBatchingCondition` too.
   */
  removalHandledInUpdate = new Map<string, ReadonlySet<string>>([
    [
      'AWS::Glue::Trigger',
      new Set([
        // Create-only: a removal replaces.
        'Name',
        'Type',
        'WorkflowName',
        // Omitted from the full-replace UpdateTrigger, which clears them
        // (Description / EventBatchingCondition measured by a CFn A/B; the
        // other three per the TriggerUpdate docs, and CFn requires each for
        // its trigger Type, so a valid template cannot remove them).
        'Description',
        'Schedule',
        'Actions',
        'Predicate',
        'EventBatchingCondition',
        // Read at create only; no live value to reset.
        'StartOnCreation',
        // Diffed by TagResource / UntagResource, removal included.
        'Tags',
      ]),
    ],
  ]);

  getClient(): GlueClient {
    return triggerGetClient.call(this);
  }
  getCreateClient(): GlueClient {
    return triggerGetCreateClient.call(this);
  }
  getStsClient(): STSClient {
    return triggerGetStsClient.call(this);
  }
  create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    context?: CreateContext
  ): Promise<ResourceCreateResult> {
    return triggerCreate.call(this, logicalId, resourceType, properties, context);
  }
  update(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>,
    context?: UpdateContext
  ): Promise<ResourceUpdateResult> {
    return triggerUpdate.call(
      this,
      logicalId,
      physicalId,
      resourceType,
      properties,
      previousProperties,
      context
    );
  }
  unsettledInTransition(
    physicalId: string,
    _logicalId: string,
    _resourceType: string,
    names: ReadonlySet<string>
  ): Promise<ReadonlySet<string>> {
    return triggerUnsettledInTransition.call(this, physicalId, _logicalId, _resourceType, names);
  }
  delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    _properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void> {
    return triggerDelete.call(this, logicalId, physicalId, resourceType, _properties, context);
  }
  getAttribute(physicalId: string, _resourceType: string, attributeName: string): Promise<unknown> {
    return triggerGetAttribute.call(this, physicalId, _resourceType, attributeName);
  }
  readCurrentState(
    physicalId: string,
    _logicalId: string,
    _resourceType: string
  ): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
    return triggerReadCurrentState.call(this, physicalId, _logicalId, _resourceType);
  }
  resourceArn(physicalId: string): Promise<string> {
    return triggerResourceArn.call(this, physicalId);
  }
  import(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    return triggerImport.call(this, input);
  }
}

installMethods(GlueProvider, databaseMethods, tableWriteMethods, tableReadMethods);
installMethods(GlueWorkflowProvider, workflowMethods);
installMethods(GlueCrawlerProvider, crawlerMethods);
installMethods(GlueTriggerProvider, triggerMethods);
