import type { FileSystem } from '@aws-sdk/client-fsx';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import { safeMsg } from '../../../utils/display-safe.js';

/**
 * Default polling budget for FSx lifecycle transitions. Lustre SCRATCH
 * creates typically finish in 5-10 minutes, but PERSISTENT creates,
 * storage-capacity growth and deletes can take substantially longer —
 * mirror the Custom Resource provider's 1-hour ceiling.
 */
export const DEFAULT_MAX_WAIT_MS = 60 * 60 * 1000;
export const DEFAULT_POLL_INTERVAL_MS = 15_000;

/**
 * go-to-k/cdkd#4606: the physical id every path of this provider records — the
 * `FileSystemId` FSx generates (`fs-` and hex), for every variant and for a
 * create from a backup alike.
 */
export const FILE_SYSTEM_ID_PATTERN = /^fs-[0-9a-f]+$/;

/** Lifecycles in which a file system is on its way out, not the record's live one. */
export const FILE_SYSTEM_NOT_LIVE_LIFECYCLES: ReadonlySet<string> = new Set(['DELETING', 'FAILED']);

/**
 * Lustre sub-properties that `UpdateFileSystem` accepts (the mutable
 * subset of the CFn `LustreConfiguration` block). Everything else in the
 * block is fixed at creation — FSx has no API to change it in place.
 */
const LUSTRE_MUTABLE_SUBPROPS = new Set<string>([
  'WeeklyMaintenanceStartTime',
  'DailyAutomaticBackupStartTime',
  'AutomaticBackupRetentionDays',
  'AutoImportPolicy',
  'DataCompressionType',
  'PerUnitStorageThroughput',
  'MetadataConfiguration',
  'ThroughputCapacity',
  'DataReadCacheConfiguration',
  // CFn "Update requires: No interruption"; UpdateFileSystemLustreConfiguration
  // carries it (go-to-k/cdkd#5430). Its removal is left in place like the
  // others (issue #1160); what CloudFormation does there is unmeasured, so it
  // is not in CFN_KEEPS_ON_REMOVAL.
  'LogConfiguration',
]);

/**
 * `WindowsConfiguration` sub-properties `UpdateFileSystem` accepts (the
 * mutable subset — mirrors `UpdateFileSystemWindowsConfiguration`).
 * `Aliases` is mutable too but not through `UpdateFileSystem`: its change is
 * an Associate/Disassociate delta (go-to-k/cdkd#5469,
 * {@link FSxFileSystemProvider.applyAliasDelta}), so it is handled before this
 * set is consulted. Everything else in the CFn block (ActiveDirectoryId,
 * DeploymentType, PreferredSubnetId, ...) is fixed at creation, so a change on
 * one is rejected by update() with a `--replace` pointer. The CFn template
 * reference documents ActiveDirectoryId and PreferredSubnetId as "No
 * interruption", but no FSx API changes either one (neither is in
 * `UpdateFileSystemWindowsConfiguration`), so cdkd cannot apply them in place.
 */
const WINDOWS_MUTABLE_SUBPROPS = new Set<string>([
  'WeeklyMaintenanceStartTime',
  'DailyAutomaticBackupStartTime',
  'AutomaticBackupRetentionDays',
  'ThroughputCapacity',
  'SelfManagedActiveDirectoryConfiguration',
  'AuditLogConfiguration',
  'DiskIopsConfiguration',
  'FsrmConfiguration',
]);

/**
 * `OntapConfiguration` sub-properties `UpdateFileSystem` accepts (mirrors
 * `UpdateFileSystemOntapConfiguration`). `RouteTableIds` is mutable but the
 * API expresses the change as Add/Remove deltas, computed in
 * {@link FSxFileSystemProvider.applyOntapUpdateField}.
 */
const ONTAP_MUTABLE_SUBPROPS = new Set<string>([
  'AutomaticBackupRetentionDays',
  'DailyAutomaticBackupStartTime',
  'FsxAdminPassword',
  'WeeklyMaintenanceStartTime',
  'DiskIopsConfiguration',
  'ThroughputCapacity',
  'ThroughputCapacityPerHAPair',
  'HAPairs',
  'RouteTableIds',
  'EndpointIpv6AddressRange',
]);

/**
 * `OpenZFSConfiguration` sub-properties `UpdateFileSystem` accepts (mirrors
 * `UpdateFileSystemOpenZFSConfiguration`). `RouteTableIds` is mutable via
 * Add/Remove deltas (see {@link FSxFileSystemProvider.applyOpenZFSUpdateField}).
 * `RootVolumeConfiguration` is NOT here — its fields change through the root
 * volume's own `UpdateVolume` API, which `UpdateFileSystem` cannot express,
 * so a change is rejected with a `--replace` pointer.
 */
const OPENZFS_MUTABLE_SUBPROPS = new Set<string>([
  'AutomaticBackupRetentionDays',
  'CopyTagsToBackups',
  'CopyTagsToVolumes',
  'DailyAutomaticBackupStartTime',
  'ThroughputCapacity',
  'WeeklyMaintenanceStartTime',
  'DiskIopsConfiguration',
  'RouteTableIds',
  'ReadCacheConfiguration',
  'EndpointIpv6AddressRange',
]);

/**
 * The four `FileSystemType` values → their CFn variant-config property name.
 * Each `CreateFileSystem`/`UpdateFileSystem` call carries at most one of
 * these blocks (the one matching the file system's type).
 */
export const VARIANT_CONFIG_KEY: Record<string, string> = {
  LUSTRE: 'LustreConfiguration',
  WINDOWS: 'WindowsConfiguration',
  ONTAP: 'OntapConfiguration',
  OPENZFS: 'OpenZFSConfiguration',
};

/**
 * Identity of the resource + variant block an `apply*UpdateField` call is
 * mapping, carried so the unreachable-`default:` guard can name the exact
 * missing mapping (see {@link FSxFileSystemProvider.unmappedMutableSubprop}).
 */
export interface VariantFieldContext {
  resourceType: string;
  logicalId: string;
  configKey: string;
}

/**
 * Exported so a unit test can assert every declared-mutable sub-property has
 * a matching `apply*UpdateField` case — the invariant the unreachable
 * `default:` guard enforces at runtime.
 */
export const VARIANT_MUTABLE_SUBPROPS: Record<string, ReadonlySet<string>> = {
  LustreConfiguration: LUSTRE_MUTABLE_SUBPROPS,
  WindowsConfiguration: WINDOWS_MUTABLE_SUBPROPS,
  OntapConfiguration: ONTAP_MUTABLE_SUBPROPS,
  OpenZFSConfiguration: OPENZFS_MUTABLE_SUBPROPS,
};

/**
 * Copy `value` into `target[key]` only when AWS actually returned it, so the
 * snapshot carries no `undefined`-valued keys.
 *
 * The drift comparator walks the BASELINE's keys (`observedProperties`, or
 * `properties` when a resource predates observed-capture), not the AWS side —
 * so an omitted key here is not itself phantom drift. It matters because this
 * snapshot BECOMES the next baseline: `deploy-engine` stores it as
 * `observedProperties`, and an explicit `Foo: undefined` would then be walked
 * as a real key on every later comparison. Omitting is also what keeps the
 * emitted shape a faithful subset of the CFn input shape.
 */
export const putIfDefined = (
  target: Record<string, unknown>,
  key: string,
  value: unknown
): void => {
  if (value !== undefined) target[key] = value;
};

/**
 * Compute the Add/Remove route-table-id deltas an ONTAP / OpenZFS
 * `UpdateFileSystem` needs from the previous vs. next `RouteTableIds` list.
 * Route table membership is an unordered set, so a pure reorder yields no
 * delta.
 */
export const routeTableDelta = (
  next: unknown,
  prev: unknown
): { add?: string[]; remove?: string[] } => {
  const nextIds = new Set((next as string[] | undefined) ?? []);
  const prevIds = new Set((prev as string[] | undefined) ?? []);
  const add = [...nextIds].filter((id) => !prevIds.has(id));
  const remove = [...prevIds].filter((id) => !nextIds.has(id));
  return {
    ...(add.length > 0 && { add }),
    ...(remove.length > 0 && { remove }),
  };
};

/**
 * go-to-k/cdkd#5469: consecutive CREATE_FAILED / DELETE_FAILED reads of an
 * alias never seen in transition before they count as its outcome rather than
 * a stale read from before the action this wait follows.
 */
export const STALE_FAILED_READS = 3;

/**
 * go-to-k/cdkd#5469: the administrative actions an alias change waits for:
 * any PENDING / IN_PROGRESS one except a storage or IOPS optimization, which
 * can run for hours after the update it follows (that update then reads
 * UPDATED_OPTIMIZING, which is not waited for either).
 */
const ALIAS_NON_BLOCKING_ACTIONS: ReadonlySet<string> = new Set([
  'STORAGE_OPTIMIZATION',
  'IOPS_OPTIMIZATION',
]);
export const runningAliasBlockingActions = (fs: FileSystem): string[] =>
  (fs.AdministrativeActions ?? [])
    .filter(
      (a) =>
        (a.Status === 'PENDING' || a.Status === 'IN_PROGRESS') &&
        !ALIAS_NON_BLOCKING_ACTIONS.has(a.AdministrativeActionType ?? '')
    )
    .map((a) => a.AdministrativeActionType ?? 'unknown');

/**
 * A BadRequest refusing an alias call because an administrative action is in
 * progress (go-to-k/cdkd#5469): re-sent until the deadline.
 */
export const isAdministrativeActionInProgress = (error: unknown): error is Error =>
  error instanceof Error &&
  error.name === 'BadRequest' &&
  /in progress/i.test(describeAwsFailure(error).detail);

/**
 * A poll error worth another poll (throttle, server-side, network). The
 * message test reads `.detail`, never `.summary`: it matches AWS's OWN wording.
 */
export const isTransientFsxError = (error: unknown): boolean => {
  const name = error instanceof Error ? error.name : '';
  return (
    name === 'ThrottlingException' ||
    name === 'ServiceLimitExceeded' ||
    name === 'InternalServerError' ||
    name === 'TimeoutError' ||
    /rate exceeded|too many requests|timed? ?out|ECONNRESET|EPIPE|socket hang up/i.test(
      describeAwsFailure(error).detail
    )
  );
};

/**
 * go-to-k/cdkd#5469: the Associate/Disassociate deltas a Windows `Aliases`
 * change needs. FSx stores an alias name lowercased whatever spelling it was
 * given, so names compare (and are sent) lowercased and a case-only edit or a
 * reorder yields no delta. A removed property means "no aliases": every
 * previous name is disassociated, as a removed `RouteTableIds` is.
 */
export const aliasDelta = (next: unknown, prev: unknown): { add: string[]; remove: string[] } => {
  const names = (value: unknown): Set<string> =>
    new Set(
      (Array.isArray(value) ? value : [])
        .filter((v): v is string => typeof v === 'string')
        .map((v) => v.toLowerCase())
    );
  const nextNames = names(next);
  const prevNames = names(prev);
  return {
    add: [...nextNames].filter((n) => !prevNames.has(n)),
    remove: [...prevNames].filter((n) => !nextNames.has(n)),
  };
};

/**
 * Top-level properties that are create-only per the CFn registry schema
 * (`createOnlyProperties`). A change on any of these is routed through
 * DELETE+CREATE by the replacement-detection layer; if a diff somehow
 * reaches update() with one of them changed, refuse loudly instead of
 * silently applying a partial update.
 */
export const TOP_LEVEL_IMMUTABLE_PROPS = [
  'FileSystemType',
  'SubnetIds',
  'SecurityGroupIds',
  'KmsKeyId',
  'BackupId',
] as const;

/**
 * Top-level mutable properties whose removal cdkd leaves in place (issue
 * #1160): `UpdateFileSystem` keeps a field it is not sent, and none has a safe
 * constant reset — a capacity cannot shrink, a Lustre version cannot
 * downgrade (its default depends on `DeploymentType`), and the storage-type
 * and network-type defaults are migrations, not clears. `update()` names a
 * removal in its own warning rather than the shared caller's, whose line
 * claims a CloudFormation reset — false wherever it is measured, since
 * CloudFormation keeps each removed value there
 * ({@link CFN_KEEPS_TOP_LEVEL_ON_REMOVAL}), and unmeasured elsewhere.
 */
export const TOP_LEVEL_LEFT_IN_PLACE_PROPS = [
  'StorageCapacity',
  'StorageType',
  'FileSystemTypeVersion',
  'NetworkType',
] as const;

/**
 * The left-in-place removals CloudFormation is MEASURED to keep too, in the
 * warning's spelling (issue #1160). CFn A/B us-east-1 2026-10-22: a Lustre
 * SCRATCH_2 file system and an OpenZFS SINGLE_AZ_1 one, each property set and
 * then removed, every update `UPDATE_COMPLETE` with the live value unchanged
 * and no FSx administrative action started. CFn A/B us-east-1 2026-10-23,
 * each removal its own update, every one `UPDATE_COMPLETE` with the same
 * FileSystemId, the live value unchanged and no administrative action: an
 * OpenZFS SINGLE_AZ_1 file system kept `NetworkType` DUAL (the non-default),
 * `StorageCapacity` 64 and `StorageType` SSD; a Lustre PERSISTENT_1 one kept
 * `StorageType` HDD (the non-default) and `StorageCapacity` 6000. CFn A/B
 * us-east-1 2026-10-25, each removal its own update, every one
 * `UPDATE_COMPLETE` with the same FileSystemId, the value read back unchanged
 * and no administrative action: a Lustre PERSISTENT_2 SSD file system kept
 * `DailyAutomaticBackupStartTime` 05:00, `AutomaticBackupRetentionDays` 3,
 * `PerUnitStorageThroughput` 125 and `MetadataConfiguration` USER_PROVISIONED
 * 3000 IOPS, and a second one kept all four removed in ONE update; a Lustre
 * PERSISTENT_1 HDD file system kept `PerUnitStorageThroughput` 12,
 * `DailyAutomaticBackupStartTime` and `AutomaticBackupRetentionDays`. (The
 * PERSISTENT_2 `CopyTagsToBackups` removal REPLACED the file system;
 * `update()` refuses that change with a `--replace` pointer.) A top-level
 * name counts as measured only for the `FileSystemType` it was measured on
 * ({@link CFN_KEEPS_TOP_LEVEL_ON_REMOVAL}); Windows / ONTAP, and their
 * sub-properties, are unmeasured, so a warning naming one of them keeps the
 * line that claims nothing about CloudFormation. The claim is generalised from
 * the measured shapes (Lustre SCRATCH_2, PERSISTENT_1 HDD and PERSISTENT_2
 * SSD; OpenZFS SINGLE_AZ_1 SSD, NetworkType DUAL) to the rest of that type's
 * SSD / HDD
 * deployments; an `INTELLIGENT_TIERING` file system is a different storage
 * class none of these names was measured on, so a name here never gets the
 * claim there ({@link cfnKeepsOnRemoval}).
 * The sub-properties measured on one narrower shape only are not here
 * ({@link CFN_KEEPS_ON_REMOVAL_FOR_SHAPE}).
 */
const CFN_KEEPS_ON_REMOVAL: ReadonlySet<string> = new Set([
  'LustreConfiguration.AutoImportPolicy',
  'LustreConfiguration.AutomaticBackupRetentionDays',
  'LustreConfiguration.DailyAutomaticBackupStartTime',
  'LustreConfiguration.DataCompressionType',
  'LustreConfiguration.MetadataConfiguration',
  'LustreConfiguration.PerUnitStorageThroughput',
  'LustreConfiguration.WeeklyMaintenanceStartTime',
  'OpenZFSConfiguration.AutomaticBackupRetentionDays',
  'OpenZFSConfiguration.CopyTagsToBackups',
  'OpenZFSConfiguration.CopyTagsToVolumes',
  'OpenZFSConfiguration.DailyAutomaticBackupStartTime',
  'OpenZFSConfiguration.DiskIopsConfiguration',
  'OpenZFSConfiguration.WeeklyMaintenanceStartTime',
]);

/**
 * The top-level half of {@link CFN_KEEPS_ON_REMOVAL}, per measured
 * `FileSystemType`. A Map, not an object literal: the key is template-borne, and
 * a `constructor` / `__proto__` key must miss rather than reach a prototype.
 */
const CFN_KEEPS_TOP_LEVEL_ON_REMOVAL: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['LUSTRE', new Set(['FileSystemTypeVersion', 'StorageCapacity', 'StorageType'])],
  ['OPENZFS', new Set(['NetworkType', 'StorageCapacity', 'StorageType'])],
]);

/** The file system shape a removal claim is judged against. */
interface RemovalClaimShape {
  /** `FileSystemType` (create-only, so the same on both sides). */
  fileSystemType: unknown;
  /** The previous AND desired `StorageType` (a migration has two). */
  storageTypes: readonly unknown[];
  /** The previous AND desired `<Variant>Configuration.DeploymentType`. */
  deploymentTypes: readonly unknown[];
  /** The desired `NetworkType`. */
  desiredNetworkType: unknown;
  /** The desired `OpenZFSConfiguration.EndpointIpv6AddressRange`. */
  desiredEndpointIpv6AddressRange: unknown;
}

/** Every side of the shape is an OpenZFS `MULTI_AZ_1` file system. */
const isOpenZfsMultiAz1 = (shape: RemovalClaimShape): boolean =>
  shape.fileSystemType === 'OPENZFS' &&
  shape.deploymentTypes.every((deploymentType) => deploymentType === 'MULTI_AZ_1');

/** The same deploy does not migrate `StorageType`. */
const keepsStorageType = (shape: RemovalClaimShape): boolean =>
  JSON.stringify(shape.storageTypes[0]) === JSON.stringify(shape.storageTypes[1]);

/**
 * The measured Lustre INTELLIGENT_TIERING shape: PERSISTENT_2 with
 * INTELLIGENT_TIERING on both sides, the property the deploy's only removal.
 */
const isLustreIntelligentTieringSoleRemoval = (
  shape: RemovalClaimShape,
  removed: readonly string[]
): boolean =>
  removed.length === 1 &&
  shape.fileSystemType === 'LUSTRE' &&
  shape.deploymentTypes.every((deploymentType) => deploymentType === 'PERSISTENT_2') &&
  shape.storageTypes.every((storageType) => storageType === 'INTELLIGENT_TIERING');

/**
 * Removals CloudFormation is measured to keep on ONE narrower shape only, each
 * judged by its own predicate instead of {@link CFN_KEEPS_ON_REMOVAL}'s rule
 * (issue #1160). CFn A/B us-east-1 2026-10-24, every removal `UPDATE_COMPLETE`
 * with the same FileSystemId, the value read back unchanged and no
 * administrative action. While the template still declared `NetworkType`
 * `DUAL`, EVERY CloudFormation update failed (`Network type is already DUAL`),
 * so each row below was measured with `NetworkType` no longer `DUAL`:
 * - `ThroughputCapacity`: kept on OpenZFS MULTI_AZ_1 with SSD (320) and with
 *   INTELLIGENT_TIERING (160), the deploy's only removal. SINGLE_AZ_1,
 *   SINGLE_AZ_2 and SINGLE_AZ_HA_* are unmeasured, and so is a removal beside
 *   another one.
 * - `ReadCacheConfiguration`: kept on OpenZFS MULTI_AZ_1 INTELLIGENT_TIERING
 *   (USER_PROVISIONED, 128 GiB), the deploy's only removal, so both sides must
 *   declare INTELLIGENT_TIERING.
 * - `EndpointIpv6AddressRange`: kept on OpenZFS MULTI_AZ_1 SSD dual-stack, in
 *   the SAME update that removed `NetworkType` (removing `NetworkType` alone
 *   with the range still set failed), so the claim is made only when this
 *   deploy removes `NetworkType` as well.
 *
 * CFn A/B us-east-1 2026-10-25, same outcome per row: a Lustre PERSISTENT_2
 * INTELLIGENT_TIERING file system kept `DataReadCacheConfiguration`
 * (USER_PROVISIONED, 32 GiB) and `ThroughputCapacity` (4000), each the
 * deploy's only removal. Both exist only on INTELLIGENT_TIERING, so both sides
 * must declare it.
 */
const CFN_KEEPS_ON_REMOVAL_FOR_SHAPE: ReadonlyMap<
  string,
  (shape: RemovalClaimShape, removed: readonly string[]) => boolean
> = new Map([
  [
    'OpenZFSConfiguration.ThroughputCapacity',
    (shape: RemovalClaimShape, removed: readonly string[]) =>
      removed.length === 1 &&
      isOpenZfsMultiAz1(shape) &&
      keepsStorageType(shape) &&
      shape.desiredNetworkType !== 'DUAL',
  ],
  [
    'OpenZFSConfiguration.ReadCacheConfiguration',
    // The single-removal test is implied today: on INTELLIGENT_TIERING no other
    // name can claim beside it (ThroughputCapacity needs a single removal too,
    // and every other claim excludes INTELLIGENT_TIERING). It stays so this
    // claim keeps to its measured shape if one of those is ever widened.
    (shape: RemovalClaimShape, removed: readonly string[]) =>
      removed.length === 1 &&
      isOpenZfsMultiAz1(shape) &&
      shape.storageTypes.every((storageType) => storageType === 'INTELLIGENT_TIERING') &&
      shape.desiredNetworkType !== 'DUAL',
  ],
  [
    'OpenZFSConfiguration.EndpointIpv6AddressRange',
    // The INTELLIGENT_TIERING test is implied today by the co-removed
    // NetworkType's own claim, which excludes it; it stays so this claim keeps
    // to its measured SSD shape if that one is ever widened.
    (shape: RemovalClaimShape, removed: readonly string[]) =>
      isOpenZfsMultiAz1(shape) &&
      keepsStorageType(shape) &&
      !shape.storageTypes.includes('INTELLIGENT_TIERING') &&
      removed.includes('NetworkType'),
  ],
  ['LustreConfiguration.DataReadCacheConfiguration', isLustreIntelligentTieringSoleRemoval],
  ['LustreConfiguration.ThroughputCapacity', isLustreIntelligentTieringSoleRemoval],
]);

/**
 * A removal CloudFormation is measured to REFUSE, so the generic claim must
 * not cover it: on OpenZFS MULTI_AZ_1, removing `NetworkType` while
 * `EndpointIpv6AddressRange` stays declared failed (`The
 * EndpointIpv6AddressRange option is only supported on Multi-AZ file system
 * when updating network type to DUAL`; CFn A/B us-east-1 2026-10-24).
 */
const cfnRefusesRemoval = (name: string, shape: RemovalClaimShape): boolean =>
  name === 'NetworkType' &&
  isOpenZfsMultiAz1(shape) &&
  shape.desiredEndpointIpv6AddressRange !== undefined;

/**
 * Whether CloudFormation is measured to keep `name` on removal for this shape,
 * `removed` being every name this deploy leaves in place. A name in
 * {@link CFN_KEEPS_ON_REMOVAL_FOR_SHAPE} is judged by its own predicate only.
 * Any other name: never on a shape CloudFormation refuses
 * ({@link cfnRefusesRemoval}), and never when either side's `StorageType` is
 * `INTELLIGENT_TIERING`, since no measured shape had it.
 */
const cfnKeepsOnRemoval = (
  name: string,
  shape: RemovalClaimShape,
  removed: readonly string[]
): boolean => {
  const narrow = CFN_KEEPS_ON_REMOVAL_FOR_SHAPE.get(name);
  if (narrow) return narrow(shape, removed);
  return (
    !cfnRefusesRemoval(name, shape) &&
    !shape.storageTypes.includes('INTELLIGENT_TIERING') &&
    (CFN_KEEPS_ON_REMOVAL.has(name) ||
      (typeof shape.fileSystemType === 'string' &&
        CFN_KEEPS_TOP_LEVEL_ON_REMOVAL.get(shape.fileSystemType)?.has(name) === true))
  );
};

/**
 * The ONE warning line for properties whose removal cdkd leaves in place
 * (issue #1160): top-level names as-is, variant sub-properties as
 * `<Variant>Configuration.<key>`. Names are template-borne, so they go through
 * `safeMsg`. The deploy line says CloudFormation keeps the value too only when
 * EVERY name is measured for this file system's shape
 * ({@link cfnKeepsOnRemoval}); otherwise it claims nothing about
 * CloudFormation. A rollback revert restores an earlier state record, so
 * there the property is one the failed deploy ADDED, and the line says that
 * instead (the shared `removalWarning`'s `'rollback'` arm).
 */
export const leftInPlaceWarning = (
  logicalId: string,
  names: readonly string[],
  caller: 'deploy' | 'rollback',
  shape: RemovalClaimShape
): string => {
  const one = names.length === 1;
  const subject = one ? 'property' : 'properties';
  const verb = one ? 'is' : 'are';
  if (caller === 'rollback') {
    return safeMsg`${logicalId} (AWS::FSx::FileSystem): ${subject} ${names.join(', ')} ${verb} absent from the state being restored; UpdateFileSystem keeps a setting it is not sent, so the rollback leaves the value the failed deploy applied in place.`;
  }
  return names.every((name) => cfnKeepsOnRemoval(name, shape, names))
    ? safeMsg`${logicalId} (AWS::FSx::FileSystem): ${subject} ${names.join(', ')} ${verb} no longer declared and ${one ? 'keeps its' : 'keep their'} current AWS value, as CloudFormation leaves ${one ? 'it' : 'them'}; UpdateFileSystem keeps a setting it is not sent. Declare the intended value explicitly to change it.`
    : safeMsg`${logicalId} (AWS::FSx::FileSystem): ${subject} ${names.join(', ')} ${verb} no longer declared; UpdateFileSystem keeps a setting it is not sent and cdkd sends no reset, so the current AWS value stays in place. Declare the intended value explicitly to change it.`;
};

/**
 * The log-group ARN a Lustre `LogConfiguration.Destination` names. FSx reads
 * the destination back as the LOG-STREAM ARN it writes to
 * (`...:log-group:/aws/fsx/x:log-stream:datarepo_fs-...`, measured us-east-1
 * on go-to-k/cdkd#5430), never the declared log-group ARN, and a declaration
 * may carry the log group `Arn` attribute's `:*` suffix. Reading it back
 * as-is would report drift on every file system with logging, so both forms
 * fold to the log-group ARN a template declares.
 */
export const toLogGroupArn = (destination: string | undefined): string | undefined =>
  destination?.replace(/:log-stream:.*$/, '').replace(/:\*$/, '');

export const toNumber = (v: unknown): number | undefined =>
  v === undefined ? undefined : Number(v);

export const toBoolean = (v: unknown): boolean | undefined => {
  if (v === undefined) return undefined;
  if (typeof v === 'string') return v === 'true';
  return Boolean(v);
};
