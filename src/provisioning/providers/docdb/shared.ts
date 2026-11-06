import { type ModifyDBClusterCommandInput } from '@aws-sdk/client-docdb';
import { enclosingDeadlineRemainingMs } from '../../../deployment/resource-deadline.js';
import { safeMsg } from '../../../utils/display-safe.js';
import { ProvisioningError } from '../../../utils/error-handler.js';
import { markNonRetryable } from '../../../deployment/retryable-errors.js';
import { coerceCfnBoolean } from '../../config-shape.js';
import type { UpdateContext } from '../../../types/resource.js';
import { definedAttributes, stringifyIfAssigned } from '../../attribute-map.js';
import { dynamicReferenceTokens, SECRET_MASK } from '../../../deployment/secret-redaction.js';
import { removedTemplateKeys } from '../../update-removal.js';

/**
 * go-to-k/cdkd#5153: the `MasterUserPassword` a `ModifyDBCluster` carries, or
 * `undefined` to leave the live password alone. DocumentDB treats ANY supplied
 * password as a master-credential reset (the cluster enters
 * `resetting-master-credentials`), so it is sent only when the template
 * changed it, as CloudFormation does. A removed password sends nothing.
 *
 * The deploy's in-place update decides from `changedProperties`, which
 * compares the templates as written: the record holds a secret as its
 * `{{resolve:...}}` token or `***`, never the plaintext the desired bag holds.
 * A changed reference and a `NoEcho` value count as changed there; a secret
 * rotated under a reference the template spells literally does not, as in
 * CloudFormation (one built by `Fn::Join` counts a newer read version). This
 * type is deliberately NOT in
 * `CHANGED_PROPERTIES_CONSUMER_TYPES`: DescribeDBClusters never returns the
 * password, so the readback that opt-in buys could not confirm it.
 *
 * Without that set the two bags are compared. A rollback revert hands both
 * re-resolved, so an equal password is left out. Under `drift --revert` both
 * sides are AWS readbacks (the desired one with the drifted keys overlaid),
 * which never hold the password, so nothing is sent. A
 * recorded `{{resolve:` token or whole `***` mask is never read as equal.
 * Compared in memory only; the value is never logged.
 */
export function masterUserPasswordToSend(
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>,
  context: UpdateContext | undefined
): string | undefined {
  const desired = properties['MasterUserPassword'];
  if (desired === undefined || desired === null) return undefined;
  const changedProperties = context?.changedProperties;
  if (changedProperties !== undefined) {
    return changedProperties.has('MasterUserPassword') ? (desired as string) : undefined;
  }
  const recorded = previousProperties['MasterUserPassword'];
  const unchanged =
    typeof desired === 'string' &&
    typeof recorded === 'string' &&
    recorded === desired &&
    dynamicReferenceTokens(recorded).length === 0 &&
    recorded !== SECRET_MASK;
  return unchanged ? undefined : (desired as string);
}

/**
 * Issue #1160: the port CloudFormation resets a removed DBCluster `Port` to.
 * A real CloudFormation A/B (#1160) measured a removed `Port: 27018` reading
 * back 27017 once the update completed.
 */
export const DOCDB_DEFAULT_PORT = 27017;

/** What a cluster declaring none holds; DescribeDBClusters leaves it out for this value. */
export const DOCDB_DEFAULT_STORAGE_TYPE = 'standard';

/**
 * go-to-k/cdkd#2762: whether a `ModifyDBCluster` carries
 * `RotateMasterUserPassword: true`. It is a request, not a setting: a template
 * keeping `true` must not rotate the secret on every update, so it goes out only
 * when the previous side does not already hold `true`. A rollback or
 * `drift --revert` restores a bag and never asks for a rotation. CreateDBCluster
 * has no such member.
 */
export function rotateMasterUserPassword(
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>,
  context: UpdateContext | undefined
): boolean {
  if (context?.replayingState === true || context?.desiredFromAwsReadback === true) return false;
  return (
    coerceCfnBoolean(properties['RotateMasterUserPassword']) === true &&
    coerceCfnBoolean(previousProperties['RotateMasterUserPassword']) !== true
  );
}

/** A KMS key id without its ARN prefix or `key/` segment: an alias keeps its whole name. */
export function kmsKeyText(key: string): string {
  return key.replace(/^arn:[^:]*:kms:[^:]*:[^:]*:/, '').replace(/^key\//, '');
}

/** Whether two spellings name one KMS key: an ARN equals its bare id, or its `alias/...`. */
export function sameKmsKey(a: string, b: string | undefined): boolean {
  return b !== undefined && kmsKeyText(a) === kmsKeyText(b);
}

/**
 * Whether a declared scalar differs from what the cluster or instance holds,
 * read off the record, else the live value. `null`, or an equal one, sends
 * nothing. Compared as text: a CFn boolean may arrive as a string.
 */
export function declaredChange(
  desired: string | boolean | undefined,
  recorded: unknown,
  live: unknown
): boolean {
  return desired != null && String(desired) !== String(recorded ?? live);
}

/**
 * Issues #5004 / #1160 / #5543 / #2762: the `AWS::DocDB::DBCluster` properties a
 * removal leaves at their live value, because a real CloudFormation A/B showed
 * CloudFormation leaves them: `DeletionProtection` / `BackupRetentionPeriod`
 * (#5004), `VpcSecurityGroupIds` (#1160), then four more (us-east-1,
 * 2026-10-30, #5543). That A/B created a cluster with `EngineVersion: 5.0.0`
 * (the default is 8.0.2), `PreferredBackupWindow: 07:00-08:00`,
 * `PreferredMaintenanceWindow: sun:10:00-sun:10:30` and a custom
 * `DBClusterParameterGroupName`, then removed all four: every one read back
 * unchanged for eight minutes after UPDATE_COMPLETE, both alone and beside a
 * `BackupRetentionPeriod` change that did land. In particular CloudFormation
 * does NOT move the cluster back to `default.docdb5.0`. The last five were
 * measured by a real CloudFormation A/B on engine 5.0.0 (us-east-1, 2026-11-01,
 * #2762), each dropped alone and read at once and about four minutes later;
 * after a stack rollback `CopyTagsToSnapshot` and `EnableCloudwatchLogsExports`
 * still held their values too. Neptune RESETS a removed log export: do not
 * copy its handling here. `MasterUserSecretKmsKeyId` was measured with
 * `ManageMasterUserPassword` staying `true`.
 */
export const DOCDB_CLUSTER_KEPT_ON_REMOVAL = [
  'DeletionProtection',
  'BackupRetentionPeriod',
  'VpcSecurityGroupIds',
  'EngineVersion',
  'PreferredBackupWindow',
  'PreferredMaintenanceWindow',
  'DBClusterParameterGroupName',
  'CopyTagsToSnapshot',
  'EnableCloudwatchLogsExports',
  'StorageType',
  'ServerlessV2ScalingConfiguration',
  'MasterUserSecretKmsKeyId',
] as const;

/**
 * Removals `update()` leaves at the live value (ModifyDBCluster keeps a setting
 * it is not sent) but no A/B has measured (#2762): `NetworkType` was only ever
 * IPV4, and removing `ManageMasterUserPassword` needs a password declared. The
 * warning names them and claims no parity.
 */
export const DOCDB_CLUSTER_UNMEASURED_ON_REMOVAL = [
  'NetworkType',
  'ManageMasterUserPassword',
] as const;

/**
 * Issues #5543 / #2762: the `AWS::DocDB::DBInstance` counterpart. The last two
 * are the #2762 A/B (`EnablePerformanceInsights` on a db.r6g.large).
 */
export const DOCDB_INSTANCE_KEPT_ON_REMOVAL = [
  'PreferredMaintenanceWindow',
  'CACertificateIdentifier',
  'EnablePerformanceInsights',
] as const;

/**
 * go-to-k/cdkd#5380: the keys an accepted Modify may leave half-applied when a
 * later step of the update fails. Only the #2762 ones: `update()` compares each
 * but `CopyTagsToSnapshot`, which goes out on every update, with the previous
 * side before sending it. The credential keys stay out: a key sent while the
 * password stays managed is refused, so a live value on the previous side would
 * turn a resend into a failure.
 */
export const CLUSTER_MODIFY_UNSETTLED_KEYS = [
  'CopyTagsToSnapshot',
  'EnableCloudwatchLogsExports',
  'NetworkType',
  'ServerlessV2ScalingConfiguration',
  'StorageType',
] as const;

export const INSTANCE_MODIFY_UNSETTLED_KEYS = [
  'CACertificateIdentifier',
  'EnablePerformanceInsights',
] as const;

/** How long an accepted change is waited on before a warning. */
export const SETTLE_MAX_WAIT_MS = 300_000;

/**
 * The same for a `StorageType` change, the provisioned-cluster change that takes
 * longest: a real run (go-to-k/cdkd#2762) was still `standard` after five minutes
 * and the member instance was refused as not `available` for over a minute more.
 * The bound the cluster's other update waits use.
 */
export const STORAGE_SETTLE_MAX_WAIT_MS = 1_800_000;

/** Budget kept back from the enclosing resource deadline. */
export const DEADLINE_MARGIN_MS = 30_000;

/**
 * The ONE warning line naming each of `keys` removed, which the resource keeps
 * at its live value as CloudFormation does, or `undefined` when none was.
 * The logical id is template-borne, so the line goes through `safeMsg`. A
 * deploy reads `removedProperties` (template to template); without it (a
 * direct call) the two bags are compared by `removedTemplateKeys`. A `drift --revert`
 * sets it empty, since its previous side is a readback. A rollback revert
 * restores an earlier state record, so there the property is one the failed
 * deploy ADDED, and the line says that instead.
 */
export function keptOnRemovalWarning(
  keys: readonly string[],
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>,
  context: UpdateContext | undefined,
  logicalId: string,
  resourceType: string,
  measured = true
): string | undefined {
  const removedProperties = context?.removedProperties;
  const removedSet =
    removedProperties ?? new Set(removedTemplateKeys(previousProperties, properties));
  const removed = keys.filter((key) => removedSet.has(key));
  if (removed.length === 0) return undefined;
  const one = removed.length === 1;
  const names = `${one ? 'property' : 'properties'} ${removed.join(', ')}`;
  const modify = resourceType === 'AWS::DocDB::DBInstance' ? 'ModifyDBInstance' : 'ModifyDBCluster';
  return context?.replayingState
    ? safeMsg`${logicalId} (${resourceType}): ${names} ${one ? 'is' : 'are'} absent from the state being restored; ${modify} keeps a setting it is not sent, so the rollback leaves any value the failed deploy applied in place.`
    : safeMsg`${logicalId} (${resourceType}): ${names} ${one ? 'was' : 'were'} removed from the template; cdkd leaves the current AWS ${one ? 'value' : 'values'} in place${measured ? ', as CloudFormation does' : ''}. Declare ${one ? 'it' : 'them'} to change ${one ? 'it' : 'them'}.`;
}

/** Issue #1160: the member statuses a cluster change moves an instance through. */
export const SECURITY_GROUP_CHANGE_MEMBER_STATUSES: ReadonlySet<string> = new Set(['modifying']);

export const PORT_CHANGE_MEMBER_STATUSES: ReadonlySet<string> = new Set(['modifying', 'rebooting']);

/** A template number (CFn numbers may arrive as strings), or `undefined` when absent. */
export function numberOrUndefined(value: unknown): number | undefined {
  return value == null ? undefined : Number(value);
}

/**
 * A cluster's `GlobalClusterIdentifier` as cdkd reads it (go-to-k/cdkd#5628):
 * only a non-blank string names a global cluster, so absent, `null` and blank
 * all mean "not a member". A non-string is not read as either: the create and
 * update guards refuse it, and the delete does not detach on it.
 */
export function docdbGlobalClusterId(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

/** What an update does about `GlobalClusterIdentifier` (`planGlobalClusterUpdate`). */
export type GlobalClusterUpdate =
  | { kind: 'none' }
  | { kind: 'keep' }
  | { kind: 'detach'; globalClusterId: string };

/**
 * `bag` with the PREVIOUS record's `GlobalClusterIdentifier`, for an update
 * that kept the membership: a copy, dropping the key when the record had none.
 */
export function withRecordedGlobalCluster(
  bag: Record<string, unknown>,
  previousProperties: Record<string, unknown>
): Record<string, unknown> {
  const { GlobalClusterIdentifier: _dropped, ...rest } = bag;
  const previous = previousProperties['GlobalClusterIdentifier'];
  return previous === undefined ? rest : { ...rest, GlobalClusterIdentifier: previous };
}

/** Whether a `GlobalClusterIdentifier` value is one {@link docdbGlobalClusterId} can read. */
export function readableGlobalClusterId(value: unknown): boolean {
  return value == null || typeof value === 'string';
}

/**
 * How long a delete waits for a global-cluster detach to land: the bound the
 * cluster delete's own wait uses.
 */
export const DETACH_MAX_WAIT_MS = 1_800_000;

/**
 * How long a detach waits through `InvalidGlobalClusterStateFault`: a global
 * cluster that keeps refusing (a primary whose secondaries are still attached,
 * for one) fails with AWS's fault class instead of the whole budget.
 */
export const GLOBAL_CLUSTER_BUSY_MAX_WAIT_MS = 600_000;

/**
 * Faults a detach waits through rather than failing on: the cluster or the
 * global cluster is busy, or the call was throttled past the SDK's own
 * retries (as `RDSProvider`'s detach, issue #4029).
 */
export const TRANSIENT_DETACH_FAULTS: ReadonlySet<string> = new Set([
  'InvalidDBClusterStateFault',
  'InvalidGlobalClusterStateFault',
  'ThrottlingException',
  'Throttling',
  'RequestLimitExceeded',
]);

export function awsErrorName(error: unknown): string {
  return (error as { name?: string } | undefined)?.name ?? '';
}

/**
 * A failure DETACHING a cluster from its global cluster (go-to-k/cdkd#5628).
 * Its own class so the delete's catch rethrows it before the not-found arm: an
 * AWS message about the GLOBAL cluster or the membership can read "not found",
 * and that arm would report the live cluster deleted.
 */
export class GlobalClusterDetachError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GlobalClusterDetachError';
  }
}

/**
 * go-to-k/cdkd#5628: the ModifyDBCluster `EngineVersion`, sent only when it
 * changed. AWS refuses any `EngineVersion`, the cluster's own included, on a
 * cluster with no healthy primary instance ("Cannot modify engine version
 * without a healthy primary instance", measured on an instance-less cluster in
 * a global cluster, us-east-1, 2026-11-02), so re-sending an unchanged one
 * failed every update of such a cluster. CloudFormation's RDS handler sends it
 * only on a change too (`clusterEngineVersionChanged` in `rds/cluster-members.ts`),
 * and a rollback replay never: AWS refuses an engine downgrade.
 */
export function docdbEngineVersionToSend(
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>,
  context: UpdateContext | undefined
): string | undefined {
  if (context?.replayingState === true) return undefined;
  const desired = properties['EngineVersion'];
  if (desired == null) return undefined;
  const previous = previousProperties['EngineVersion'];
  return previous != null && String(previous) === String(desired) ? undefined : (desired as string);
}

/** The ModifyDBCluster `Port`: the declared one, or the default on removal. */
export function clusterPortToSend(
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>
): number | undefined {
  if (properties['Port'] != null) return Number(properties['Port']);
  if (previousProperties['Port'] == null) return undefined;
  // The removed value already was the default: nothing to change.
  return Number(previousProperties['Port']) === DOCDB_DEFAULT_PORT ? undefined : DOCDB_DEFAULT_PORT;
}

/**
 * The attribute map a DocumentDB DB cluster records (issue #3650), under
 * CloudFormation's `Fn::GetAtt` names (`Endpoint`, `Port`, `ReadEndpoint`,
 * `ClusterResourceId`). The RDS-style dotted keys (`Endpoint.Address`, ...)
 * are kept for records and readers that already use them; no
 * `Fn::GetAtt` names them for this service, so on their own they left
 * `Fn::GetAtt [Cluster, Endpoint]` resolving to the cluster identifier.
 */
export function clusterAttributes(
  cluster:
    | {
        Endpoint?: string | undefined;
        Port?: number | undefined;
        ReaderEndpoint?: string | undefined;
        DBClusterArn?: string | undefined;
        DbClusterResourceId?: string | undefined;
      }
    | undefined
): Record<string, unknown> {
  return definedAttributes({
    Endpoint: cluster?.Endpoint,
    Port: stringifyIfAssigned(cluster?.Port),
    ReadEndpoint: cluster?.ReaderEndpoint,
    'Endpoint.Address': cluster?.Endpoint,
    'Endpoint.Port': stringifyIfAssigned(cluster?.Port),
    'ReadEndpoint.Address': cluster?.ReaderEndpoint,
    Arn: cluster?.DBClusterArn,
    ClusterResourceId: cluster?.DbClusterResourceId,
  });
}

/**
 * The attribute map a DocumentDB DB instance records (issue #3650): `Endpoint` /
 * `Port` are CloudFormation's `Fn::GetAtt` names, the dotted keys are kept.
 */
export function instanceAttributes(
  instance:
    | {
        Endpoint?: { Address?: string | undefined; Port?: number | undefined } | undefined;
        DBInstanceArn?: string | undefined;
      }
    | undefined
): Record<string, unknown> {
  return definedAttributes({
    Endpoint: instance?.Endpoint?.Address,
    Port: stringifyIfAssigned(instance?.Endpoint?.Port),
    'Endpoint.Address': instance?.Endpoint?.Address,
    'Endpoint.Port': stringifyIfAssigned(instance?.Endpoint?.Port),
    Arn: instance?.DBInstanceArn,
  });
}

/**
 * A DB cluster or DB instance identifier: a letter, then letters, digits and
 * single hyphens, not ending in one, at most 63 characters. Either case, as a
 * template may spell it (the service lower-cases it).
 */
export function isDbIdentifier(id: string): boolean {
  return id.length <= 63 && /^[A-Za-z](?:-?[A-Za-z0-9])*$/.test(id);
}

/** Which of the two restore calls a template's keys select (go-to-k/cdkd#5628). */
export type DocDBClusterRestore =
  | { kind: 'snapshot'; snapshotIdentifier: string }
  | {
      kind: 'point-in-time';
      sourceDBClusterIdentifier: string;
      restoreToTime: Date | undefined;
    };

/**
 * A `RestoreToTime` as an ISO 8601 timestamp carrying its zone: `Z` or a
 * `+hh:mm` / `-hhmm` offset, `T` or a space between date and time. The whole
 * shape, since `Date` reads many others; a space is not refused unmeasured.
 */
export const ZONED_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:z|[+-]\d{2}:?\d{2})$/i;

/**
 * The restore a template declares, `undefined` for a plain create. Measured
 * against CloudFormation (go-to-k/cdkd#5628, us-east-1, engine 5.0.0, the
 * handler's calls read from CloudTrail): `SnapshotIdentifier` selects
 * `RestoreDBClusterFromSnapshot`, `SourceDBClusterIdentifier`
 * `RestoreDBClusterToPointInTime`, and neither `CreateDBCluster`, whatever
 * `RestoreType`, `RestoreToTime` or `UseLatestRestorableTime` say. An empty
 * identifier or `RestoreToTime` counts as none. Each refusal below is one CloudFormation fails the
 * create with too: both identifiers; a point-in-time restore with neither a
 * `RestoreToTime` nor `UseLatestRestorableTime: true`, or with both; and a
 * `RestoreToTime` with no zone ("Internal Failure"). They hold on a state
 * replay too: CloudFormation refuses each, so no record of one was written by
 * a deploy it would accept, and falling through would make an EMPTY cluster.
 */
export function readDocDBClusterRestore(
  properties: Record<string, unknown>,
  resourceType: string,
  logicalId: string
): DocDBClusterRestore | undefined {
  const refuse = (reason: string): never => {
    throw markNonRetryable(
      new ProvisioningError(
        safeMsg`DocDB DBCluster ${logicalId}: ${reason}, as CloudFormation requires; nothing was changed.`,
        resourceType,
        logicalId
      )
    );
  };
  const identifier = (key: string): string | undefined => {
    const value = properties[key];
    if (value == null) return undefined;
    return typeof value === 'string' ? value || undefined : refuse(`${key} must be a string`);
  };
  const snapshotIdentifier = identifier('SnapshotIdentifier');
  const sourceDBClusterIdentifier = identifier('SourceDBClusterIdentifier');
  if (snapshotIdentifier !== undefined && sourceDBClusterIdentifier !== undefined) {
    return refuse('SnapshotIdentifier and SourceDBClusterIdentifier cannot both be set');
  }
  if (sourceDBClusterIdentifier === undefined) {
    return snapshotIdentifier === undefined ? undefined : { kind: 'snapshot', snapshotIdentifier };
  }
  const declaredTime = properties['RestoreToTime'];
  let restoreToTime: Date | undefined;
  if (declaredTime != null && declaredTime !== '') {
    restoreToTime =
      typeof declaredTime === 'string' && ZONED_TIMESTAMP.test(declaredTime)
        ? new Date(declaredTime)
        : undefined;
    if (restoreToTime === undefined || Number.isNaN(restoreToTime.getTime())) {
      return refuse(
        'RestoreToTime must be a timestamp with a time zone, such as 2026-01-01T00:00:00Z'
      );
    }
  }
  const declaredLatest = properties['UseLatestRestorableTime'];
  const latest = declaredLatest == null ? false : coerceCfnBoolean(declaredLatest);
  if (latest === undefined) return refuse('UseLatestRestorableTime must be a boolean');
  if (restoreToTime !== undefined && latest) {
    return refuse('RestoreToTime and UseLatestRestorableTime: true cannot both be set');
  }
  if (restoreToTime === undefined && !latest) {
    return refuse(
      'a SourceDBClusterIdentifier restore needs RestoreToTime or UseLatestRestorableTime: true'
    );
  }
  const restoreType = properties['RestoreType'];
  if (restoreType != null && typeof restoreType !== 'string') {
    return refuse('RestoreType must be a string');
  }
  return { kind: 'point-in-time', sourceDBClusterIdentifier, restoreToTime };
}

/**
 * The template keys a create of this kind does not use, as CloudFormation does
 * not (measured, go-to-k/cdkd#5628): the point-in-time keys beside no source,
 * `GlobalClusterIdentifier` on either restore (neither call has a member, and
 * a cluster cannot join one later), and `AvailabilityZones` on a point-in-time
 * one. A false `UseLatestRestorableTime` asks for nothing, so it stays unnamed.
 */
export function unusedRestoreKeys(
  properties: Record<string, unknown>,
  restore: DocDBClusterRestore | undefined
): string[] {
  const keys =
    restore?.kind === 'point-in-time'
      ? ['GlobalClusterIdentifier', 'AvailabilityZones']
      : [
          'RestoreType',
          'RestoreToTime',
          'UseLatestRestorableTime',
          ...(restore === undefined ? [] : ['GlobalClusterIdentifier']),
        ];
  return keys.filter(
    (key) => properties[key] != null && properties[key] !== '' && properties[key] !== false
  );
}

/** The longest a create waits for the cluster to read `available`. */
export const CLUSTER_AVAILABLE_MAX_WAIT_MS = 1_800_000;

/**
 * How long a restore waits for `available`: as a create, or to the resource
 * deadline when `--resource-timeout` allows more, since it copies the source.
 */
export function restoreWaitMs(): number {
  const remaining = enclosingDeadlineRemainingMs() - DEADLINE_MARGIN_MS;
  return Number.isFinite(remaining)
    ? Math.max(CLUSTER_AVAILABLE_MAX_WAIT_MS, remaining)
    : CLUSTER_AVAILABLE_MAX_WAIT_MS;
}

/** What `ModifyDBCluster` answers for a value it refuses. */
export const RESTORE_VALUE_REFUSALS: ReadonlySet<string> = new Set([
  'InvalidParameterValue',
  'InvalidParameterCombination',
]);

/** The `ModifyDBCluster` members of one follow-up call, the identifier aside. */
export type ClusterModifyMembers = Omit<ModifyDBClusterCommandInput, 'DBClusterIdentifier'>;

/** The `ModifyDBCluster` calls sent once a restored cluster is `available`. */
export interface DocDBRestoreFollowUp {
  /** What CloudFormation sets too: a refusal fails the create, as it fails there. */
  parity: ClusterModifyMembers | undefined;
  /**
   * What CloudFormation drops, grouped by what AWS accepts or refuses together:
   * a refusal is a warning naming the keys (`sendRestoreFollowUp`).
   */
  declared: ClusterModifyMembers[];
}

/**
 * The `ModifyDBCluster` members a restore leaves to a follow-up call
 * (go-to-k/cdkd#5628). Measured: after a snapshot restore CloudFormation sends
 * `DBClusterParameterGroupName`, `BackupRetentionPeriod` and both windows in a
 * `ModifyDBCluster`; a point-in-time restore carries the parameter group on
 * the restore call, which this SDK's request has no member for, so it goes in
 * the follow-up instead. Neither restore applies the master password,
 * `ManageMasterUserPassword`, or, on a point-in-time one, the retention and
 * windows: CloudFormation drops them (its next update sends the retention and
 * windows). cdkd sends those declared values here rather than record what AWS
 * does not hold, so parity gives way there, and only there; AWS refusing one
 * is a warning naming the keys, not a failed create.
 */
export function docdbRestoreFollowUp(
  properties: Record<string, unknown>,
  restore: DocDBClusterRestore,
  password: string | undefined,
  managedPassword: boolean | undefined
): DocDBRestoreFollowUp {
  const nonEmpty = (members: ClusterModifyMembers): ClusterModifyMembers | undefined =>
    Object.values(members).some((value) => value !== undefined) ? members : undefined;
  const retention = numberOrUndefined(properties['BackupRetentionPeriod']);
  const windows: ClusterModifyMembers = {
    PreferredBackupWindow: properties['PreferredBackupWindow'] as string | undefined,
    PreferredMaintenanceWindow: properties['PreferredMaintenanceWindow'] as string | undefined,
  };
  const snapshot = restore.kind === 'snapshot';
  return {
    parity: nonEmpty({
      DBClusterParameterGroupName: properties['DBClusterParameterGroupName'] as string | undefined,
      ...(snapshot && { BackupRetentionPeriod: retention, ...windows }),
    }),
    declared: [
      ...(snapshot ? [] : [nonEmpty({ BackupRetentionPeriod: retention }), nonEmpty(windows)]),
      nonEmpty({ MasterUserPassword: password }),
      nonEmpty({
        ManageMasterUserPassword: managedPassword === true ? true : undefined,
        MasterUserSecretKmsKeyId:
          managedPassword === true
            ? (properties['MasterUserSecretKmsKeyId'] as string | undefined)
            : undefined,
      }),
    ].filter((group): group is ClusterModifyMembers => group !== undefined),
  };
}

/**
 * Whether the VpcSecurityGroupIds a cluster update SENDS differs from the
 * previous template's list (order-insensitive). `sent === undefined` sends
 * nothing, so nothing changes.
 */
export function securityGroupListChanged(
  sent: readonly string[] | undefined,
  previous: unknown
): boolean {
  if (sent === undefined) return false;
  const before = Array.isArray(previous)
    ? previous.filter((id): id is string => typeof id === 'string')
    : [];
  return [...sent].sort().join(' ') !== [...before].sort().join(' ');
}
