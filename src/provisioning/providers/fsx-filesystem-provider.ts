import {
  FSxClient,
  AssociateFileSystemAliasesCommand,
  DisassociateFileSystemAliasesCommand,
  type Alias,
  type CreateFileSystemLustreConfiguration,
  type CreateFileSystemWindowsConfiguration,
  type CreateFileSystemOntapConfiguration,
  type CreateFileSystemOpenZFSConfiguration,
  type SelfManagedActiveDirectoryConfiguration,
  type SelfManagedActiveDirectoryConfigurationUpdates,
  type DiskIopsConfiguration,
  type WindowsAuditLogCreateConfiguration,
  type WindowsFsrmConfiguration,
  type OpenZFSCreateRootVolumeConfiguration,
  type OpenZFSReadCacheConfiguration,
  type LustreFileSystemConfiguration,
  type DeleteFileSystemOpenZFSOption,
  type LustreLogCreateConfiguration,
  type WindowsFileSystemConfiguration,
  type OntapFileSystemConfiguration,
  type OpenZFSFileSystemConfiguration,
  type FileSystem,
} from '@aws-sdk/client-fsx';
import { getLogger, type ConsoleLogger } from '../../utils/logger.js';
import { ProvisioningError } from '../../utils/error-handler.js';
import type { DeleteContext } from '../region-check.js';
import type { MaskerFn } from '../masked-retry-logger.js';
import type { ResourceNotFound } from '../../types/resource.js';
import type {
  ResourceProvider,
  ResourceCreateResult,
  ResourceUpdateResult,
  ResourceImportInput,
  ResourceImportResult,
  ResourceIdentityVerdict,
  CreateContext,
  UpdateContext,
} from '../../types/resource.js';
import { ambientRegion } from '../../utils/stack-aws-scope.js';
import {
  DEFAULT_MAX_WAIT_MS,
  DEFAULT_POLL_INTERVAL_MS,
  VARIANT_CONFIG_KEY,
  type VariantFieldContext,
  TOP_LEVEL_IMMUTABLE_PROPS,
  TOP_LEVEL_LEFT_IN_PLACE_PROPS,
} from './fsx-filesystem/shared.js';
import {
  wrapStatusReasonError,
  wrapCaughtError,
  cleanupFailureText,
  getClient,
} from './fsx-filesystem/core.js';
import {
  create,
  toCreateLustreConfiguration,
  toLustreLogConfiguration,
  toCreateWindowsConfiguration,
  toCreateOntapConfiguration,
  toCreateOpenZFSConfiguration,
} from './fsx-filesystem/create.js';
import {
  toDiskIopsConfiguration,
  toSelfManagedAdConfiguration,
  toSelfManagedAdConfigurationUpdates,
  toWindowsAuditLogConfiguration,
  toWindowsFsrmConfiguration,
  toOpenZFSRootVolumeConfiguration,
  toOpenZFSReadCacheConfiguration,
} from './fsx-filesystem/mappers.js';
import { update } from './fsx-filesystem/update.js';
import {
  detectVariantConfigKey,
  computeVariantConfigDiff,
  unmappedMutableSubprop,
  applyLustreUpdateField,
  applyWindowsUpdateField,
  applyOntapUpdateField,
  applyOpenZFSUpdateField,
} from './fsx-filesystem/variant-diff.js';
import {
  applyAliasDelta,
  describeAliases,
  waitForNoAdministrativeAction,
  sendAliasCall,
  waitForAliases,
  applyTagDiff,
} from './fsx-filesystem/aliases.js';
import { deleteImpl, toDeleteOpenZFSOptions } from './fsx-filesystem/delete.js';
import {
  isSameResource,
  readFileSystemForIdentity,
  describeForPoll,
  waitForFileSystemAvailable,
  waitForUpdateActionComplete,
  waitForFileSystemDeleted,
} from './fsx-filesystem/lifecycle.js';
import {
  buildAttributes,
  getAttribute,
  readLustreConfiguration,
  readWindowsConfiguration,
  readOntapConfiguration,
  readOpenZFSConfiguration,
  readDiskIopsConfiguration,
  canonicalizeDriftProperties,
  canonicalizeWindowsAliases,
  getDriftUnknownPaths,
  getDriftUnorderedPaths,
  readCurrentState,
  importImpl,
} from './fsx-filesystem/read-state.js';
export { VARIANT_MUTABLE_SUBPROPS, aliasDelta } from './fsx-filesystem/shared.js';

/**
 * SDK Provider for `AWS::FSx::FileSystem`.
 *
 * The type is `ProvisioningType: NON_PROVISIONABLE` in the CFn registry,
 * so cdkd's Cloud Control fallback cannot handle it (issue #1042).
 *
 * Supported variants: **Lustre** (the CDK L2 `aws-fsx.LustreFileSystem`),
 * **Windows** (FSx for Windows File Server), **ONTAP** (FSx for NetApp
 * ONTAP), and **OpenZFS** (FSx for OpenZFS) — each carries its own
 * `<Variant>Configuration` block, mapped per-variant on create and diffed
 * against the `UpdateFileSystem` mutable surface on update (issue #1068).
 *
 * Lifecycle handling — every mutation is async on AWS:
 *  - `create` → `CreateFileSystem` (or `CreateFileSystemFromBackup` when
 *    `BackupId` is set) + poll `DescribeFileSystems` until `AVAILABLE`.
 *  - `update` → `UpdateFileSystem` for the mutable surface (StorageCapacity,
 *    StorageType, FileSystemTypeVersion, NetworkType, and each variant's
 *    mutable sub-properties) + `TagResource`/`UntagResource` for `Tags`;
 *    polls back to `AVAILABLE`. A removal `UpdateFileSystem` cannot express
 *    is warned about and left in place, never sent (issue #1160).
 *  - `delete` → `DeleteFileSystem` + poll until the file system is GONE
 *    (`FileSystemNotFound` / dropped from the Describe response). A timeout
 *    here is a hard error — a lingering FSx file system bills per hour.
 *
 * `getMinResourceTimeoutMs()` lifts the deploy engine's per-resource
 * deadline to the polling ceiling (mirrors `CustomResourceProvider`), so
 * slow FSx creates don't require a manual `--resource-timeout`.
 */
export class FSxFileSystemProvider implements ResourceProvider {
  /**
   * Cloud Control has NO handlers for this type (`ProvisioningType:
   * NON_PROVISIONABLE` in the CFn registry), so the deploy engine's #614
   * SDK-unwired auto-route MUST NOT send a Windows/ONTAP/OpenZFS template
   * to CC — it would fail at provisioning time with an opaque
   * UnsupportedActionException. With this opt-out the ProviderRegistry
   * rejects such templates pre-flight with a clear error instead.
   * (The type is also in `SDK_PROVIDER_NON_PROVISIONABLE_TYPES`, which the
   * route reads per type (#3871), so this flag is now redundant for it.)
   */
  readonly disableCcApiFallback = true;

  client: FSxClient | undefined;
  readonly providerRegion = ambientRegion();
  logger: ConsoleLogger = getLogger().child('FSxFileSystemProvider');
  /**
   * When THIS process first sent each ClientRequestToken whose create has not
   * yet returned (go-to-k/cdkd#4428). FSx answers a repeated token with the
   * file system already holding it, so a retry is handed the one its earlier
   * attempt made — or one made under the token outside the stack's
   * create-token ledger (#4438). `create()` takes -- records, or cleans up on
   * failure -- only a file system created after the first send (this
   * process's, else the ledger's, judged on AWS's clock as measured now), and
   * refuses any other.
   */
  readonly createTokenFirstSentAt = new Map<string, number>();

  readonly pollIntervalMs: number;
  readonly maxWaitMs: number;

  constructor(options?: { pollIntervalMs?: number; maxWaitMs?: number }) {
    this.pollIntervalMs = options?.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.maxWaitMs = options?.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
  }

  wrapStatusReasonError(
    mask: MaskerFn | undefined,
    message: string | undefined,
    build: (text: string, cause: Error | undefined) => ProvisioningError
  ): ProvisioningError {
    return wrapStatusReasonError.call(this, mask, message, build);
  }

  wrapCaughtError(
    mask: MaskerFn | undefined,
    error: unknown,
    build: (text: string) => ProvisioningError
  ): ProvisioningError {
    return wrapCaughtError.call(this, mask, error, build);
  }

  cleanupFailureText(head: string, error: unknown, mask: MaskerFn | undefined): string {
    return cleanupFailureText.call(this, head, error, mask);
  }

  handledProperties = new Map<string, ReadonlySet<string>>([
    [
      'AWS::FSx::FileSystem',
      new Set([
        'BackupId',
        'FileSystemType',
        'FileSystemTypeVersion',
        'KmsKeyId',
        'LustreConfiguration',
        'NetworkType',
        'OntapConfiguration',
        'OpenZFSConfiguration',
        'SecurityGroupIds',
        'StorageCapacity',
        'StorageType',
        'SubnetIds',
        'Tags',
        'WindowsConfiguration',
      ]),
    ],
  ]);

  unhandledByDesign = new Map<string, ReadonlyMap<string, string>>();

  /**
   * Issue #1160 (`ResourceProvider.removalHandledInUpdate`): every property,
   * each removal handled by `update()` — so the shared caller warns about
   * none of them.
   */
  removalHandledInUpdate = new Map<string, ReadonlySet<string>>([
    [
      'AWS::FSx::FileSystem',
      new Set([
        // Required or create-only: a removal is refused or replaces.
        ...TOP_LEVEL_IMMUTABLE_PROPS,
        // Diffed by TagResource / UntagResource, removal included.
        'Tags',
        // Left in place and named in update()'s own warning (no reset).
        ...TOP_LEVEL_LEFT_IN_PLACE_PROPS,
        // Each sub-property removal is refused (immutable), named in
        // update()'s own warning, or diffed (RouteTableIds; Windows Aliases,
        // go-to-k/cdkd#5469).
        ...Object.values(VARIANT_CONFIG_KEY),
      ]),
    ],
  ]);

  getClient(): FSxClient {
    return getClient.call(this);
  }

  /**
   * Self-reported minimum per-resource timeout: the deploy engine resolves
   * `max(getMinResourceTimeoutMs(), globalCliDefault)` so FSx's slow
   * create/delete polling fits inside the resource deadline without the
   * user passing `--resource-timeout`.
   */
  getMinResourceTimeoutMs(): number {
    return this.maxWaitMs;
  }

  // ─── CREATE ────────────────────────────────────────────────────────

  create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    context?: CreateContext
  ): Promise<ResourceCreateResult> {
    return create.call(this, logicalId, resourceType, properties, context);
  }

  toCreateLustreConfiguration(
    config: Record<string, unknown> | undefined
  ): CreateFileSystemLustreConfiguration | undefined {
    return toCreateLustreConfiguration.call(this, config);
  }

  toLustreLogConfiguration(
    config: Record<string, unknown> | undefined
  ): LustreLogCreateConfiguration | undefined {
    return toLustreLogConfiguration.call(this, config);
  }

  toCreateWindowsConfiguration(
    config: Record<string, unknown> | undefined
  ): CreateFileSystemWindowsConfiguration | undefined {
    return toCreateWindowsConfiguration.call(this, config);
  }

  toCreateOntapConfiguration(
    config: Record<string, unknown> | undefined
  ): CreateFileSystemOntapConfiguration | undefined {
    return toCreateOntapConfiguration.call(this, config);
  }

  toCreateOpenZFSConfiguration(
    config: Record<string, unknown> | undefined
  ): CreateFileSystemOpenZFSConfiguration | undefined {
    return toCreateOpenZFSConfiguration.call(this, config);
  }

  // ─── Nested sub-block mappers (shared by create + update) ───────────

  toDiskIopsConfiguration(
    config: Record<string, unknown> | undefined
  ): DiskIopsConfiguration | undefined {
    return toDiskIopsConfiguration.call(this, config);
  }

  toSelfManagedAdConfiguration(
    config: Record<string, unknown> | undefined
  ): SelfManagedActiveDirectoryConfiguration | undefined {
    return toSelfManagedAdConfiguration.call(this, config);
  }

  toSelfManagedAdConfigurationUpdates(
    config: Record<string, unknown> | undefined
  ): SelfManagedActiveDirectoryConfigurationUpdates | undefined {
    return toSelfManagedAdConfigurationUpdates.call(this, config);
  }

  toWindowsAuditLogConfiguration(
    config: Record<string, unknown> | undefined
  ): WindowsAuditLogCreateConfiguration | undefined {
    return toWindowsAuditLogConfiguration.call(this, config);
  }

  toWindowsFsrmConfiguration(
    config: Record<string, unknown> | undefined
  ): WindowsFsrmConfiguration | undefined {
    return toWindowsFsrmConfiguration.call(this, config);
  }

  toOpenZFSRootVolumeConfiguration(
    config: Record<string, unknown> | undefined
  ): OpenZFSCreateRootVolumeConfiguration | undefined {
    return toOpenZFSRootVolumeConfiguration.call(this, config);
  }

  toOpenZFSReadCacheConfiguration(
    config: Record<string, unknown> | undefined
  ): OpenZFSReadCacheConfiguration | undefined {
    return toOpenZFSReadCacheConfiguration.call(this, config);
  }

  // ─── UPDATE ────────────────────────────────────────────────────────

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

  // ─── Variant UPDATE diff ────────────────────────────────────────────

  detectVariantConfigKey(
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>
  ): string | undefined {
    return detectVariantConfigKey.call(this, properties, previousProperties);
  }

  computeVariantConfigDiff(
    resourceType: string,
    logicalId: string,
    configKey: string,
    next: Record<string, unknown>,
    prev: Record<string, unknown>
  ): {
    diff: Record<string, unknown>;
    hasMutableDiff: boolean;
    leftInPlace: string[];
    aliases: { add: string[]; remove: string[] };
  } {
    return computeVariantConfigDiff.call(this, resourceType, logicalId, configKey, next, prev);
  }

  unmappedMutableSubprop(ctx: VariantFieldContext, key: string): never {
    return unmappedMutableSubprop.call(this, ctx, key);
  }

  applyLustreUpdateField(
    ctx: VariantFieldContext,
    key: string,
    next: unknown,
    diff: Record<string, unknown>
  ): boolean {
    return applyLustreUpdateField.call(this, ctx, key, next, diff);
  }

  applyWindowsUpdateField(
    ctx: VariantFieldContext,
    key: string,
    next: unknown,
    diff: Record<string, unknown>
  ): boolean {
    return applyWindowsUpdateField.call(this, ctx, key, next, diff);
  }

  applyOntapUpdateField(
    ctx: VariantFieldContext,
    key: string,
    next: unknown,
    prev: unknown,
    diff: Record<string, unknown>
  ): boolean {
    return applyOntapUpdateField.call(this, ctx, key, next, prev, diff);
  }

  applyOpenZFSUpdateField(
    ctx: VariantFieldContext,
    key: string,
    next: unknown,
    prev: unknown,
    diff: Record<string, unknown>
  ): boolean {
    return applyOpenZFSUpdateField.call(this, ctx, key, next, prev, diff);
  }

  applyAliasDelta(
    physicalId: string,
    logicalId: string,
    resourceType: string,
    delta: { add: string[]; remove: string[] },
    deadline: number
  ): Promise<void> {
    return applyAliasDelta.call(this, physicalId, logicalId, resourceType, delta, deadline);
  }

  describeAliases(physicalId: string): Promise<Alias[]> {
    return describeAliases.call(this, physicalId);
  }

  waitForNoAdministrativeAction(
    physicalId: string,
    logicalId: string,
    resourceType: string,
    deadline: number
  ): Promise<void> {
    return waitForNoAdministrativeAction.call(this, physicalId, logicalId, resourceType, deadline);
  }

  sendAliasCall(
    physicalId: string,
    logicalId: string,
    resourceType: string,
    command: () => AssociateFileSystemAliasesCommand | DisassociateFileSystemAliasesCommand,
    deadline: number
  ): Promise<void> {
    return sendAliasCall.call(this, physicalId, logicalId, resourceType, command, deadline);
  }

  waitForAliases(
    physicalId: string,
    logicalId: string,
    resourceType: string,
    names: string[],
    target: 'AVAILABLE' | 'gone',
    deadline: number
  ): Promise<void> {
    return waitForAliases.call(this, physicalId, logicalId, resourceType, names, target, deadline);
  }

  applyTagDiff(
    physicalId: string,
    resourceType: string,
    logicalId: string,
    nextTags: unknown,
    prevTags: unknown
  ): Promise<void> {
    return applyTagDiff.call(this, physicalId, resourceType, logicalId, nextTags, prevTags);
  }

  // ─── DELETE ────────────────────────────────────────────────────────

  delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void> {
    return deleteImpl.call(this, logicalId, physicalId, resourceType, properties, context);
  }

  toDeleteOpenZFSOptions(
    properties: Record<string, unknown> | undefined
  ): DeleteFileSystemOpenZFSOption[] | undefined {
    return toDeleteOpenZFSOptions.call(this, properties);
  }

  // ─── Identity (go-to-k/cdkd#4606) ──────────────────────────────────

  isSameResource(
    journaledPhysicalId: string,
    record: { physicalId: string },
    resourceType: string,
    context: { expectedRegion: string }
  ): Promise<ResourceIdentityVerdict> {
    return isSameResource.call(this, journaledPhysicalId, record, resourceType, context);
  }

  readFileSystemForIdentity(
    fileSystemId: string
  ): Promise<{ id: string; lifecycle: string | undefined } | undefined> {
    return readFileSystemForIdentity.call(this, fileSystemId);
  }

  // ─── Lifecycle polling ─────────────────────────────────────────────

  describeForPoll(
    fileSystemId: string,
    transientState: { count: number },
    maxConsecutiveTransient = 5
  ): Promise<FileSystem | undefined> {
    return describeForPoll.call(this, fileSystemId, transientState, maxConsecutiveTransient);
  }

  waitForFileSystemAvailable(
    fileSystemId: string,
    logicalId: string,
    resourceType: string,
    mask?: MaskerFn
  ): Promise<FileSystem> {
    return waitForFileSystemAvailable.call(this, fileSystemId, logicalId, resourceType, mask);
  }

  waitForUpdateActionComplete(
    fileSystemId: string,
    logicalId: string,
    resourceType: string,
    actionThresholdMs: number,
    requireActionObservation: boolean,
    deadline: number,
    mask?: MaskerFn
  ): Promise<FileSystem> {
    return waitForUpdateActionComplete.call(
      this,
      fileSystemId,
      logicalId,
      resourceType,
      actionThresholdMs,
      requireActionObservation,
      deadline,
      mask
    );
  }

  waitForFileSystemDeleted(
    fileSystemId: string,
    logicalId: string,
    resourceType: string,
    mask?: MaskerFn
  ): Promise<void> {
    return waitForFileSystemDeleted.call(this, fileSystemId, logicalId, resourceType, mask);
  }

  // ─── Attributes / drift / import ───────────────────────────────────

  buildAttributes(fs: FileSystem): Record<string, unknown> {
    return buildAttributes.call(this, fs);
  }

  getAttribute(physicalId: string, _resourceType: string, attributeName: string): Promise<unknown> {
    return getAttribute.call(this, physicalId, _resourceType, attributeName);
  }

  // ─── readCurrentState variant reverse-mappers ──────────────────────
  //
  // Each maps a `DescribeFileSystems` variant block back to the flat CFn
  // `*Configuration` input shape cdkd stores in state. Read-only fields the
  // template never carries (`Endpoints`, `RootVolumeId`, `EndpointIpAddress`,
  // `RemoteAdministrationEndpoint`, `PreferredFileServerIp`,
  // `MaintenanceOperationsInProgress`) are deliberately NOT mapped — surfacing
  // them would add AWS-only keys the state baseline can never match. Inputs
  // AWS does not return at all stay in `getDriftUnknownPaths`.

  readLustreConfiguration(lustre: LustreFileSystemConfiguration): Record<string, unknown> {
    return readLustreConfiguration.call(this, lustre);
  }

  readWindowsConfiguration(windows: WindowsFileSystemConfiguration): Record<string, unknown> {
    return readWindowsConfiguration.call(this, windows);
  }

  readOntapConfiguration(ontap: OntapFileSystemConfiguration): Record<string, unknown> {
    return readOntapConfiguration.call(this, ontap);
  }

  readOpenZFSConfiguration(openzfs: OpenZFSFileSystemConfiguration): Record<string, unknown> {
    return readOpenZFSConfiguration.call(this, openzfs);
  }

  readDiskIopsConfiguration(
    diskIops: DiskIopsConfiguration | undefined
  ): Record<string, unknown> | undefined {
    return readDiskIopsConfiguration.call(this, diskIops);
  }

  canonicalizeDriftProperties(
    resourceType: string,
    properties: Record<string, unknown>
  ): Record<string, unknown> {
    return canonicalizeDriftProperties.call(this, resourceType, properties);
  }

  canonicalizeWindowsAliases(properties: Record<string, unknown>): Record<string, unknown> {
    return canonicalizeWindowsAliases.call(this, properties);
  }

  getDriftUnknownPaths(resourceType: string): string[] {
    return getDriftUnknownPaths.call(this, resourceType);
  }

  getDriftUnorderedPaths(resourceType: string): string[] {
    return getDriftUnorderedPaths.call(this, resourceType);
  }

  readCurrentState(
    physicalId: string,
    _logicalId: string,
    resourceType: string
  ): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
    return readCurrentState.call(this, physicalId, _logicalId, resourceType);
  }

  import(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    return importImpl.call(this, input);
  }
}
