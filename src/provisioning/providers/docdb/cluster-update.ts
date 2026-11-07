import type { DocDBProvider } from '../docdb-provider.js';
import {
  ModifyDBClusterCommand,
  DescribeGlobalClustersCommand,
  type DBCluster,
  type ModifyDBClusterCommandInput,
} from '@aws-sdk/client-docdb';
import { enclosingDeadlineRemainingMs } from '../../../deployment/resource-deadline.js';
import {
  isModifyNotAvailableRefusal,
  modifyDbInstanceWhenAvailable,
} from '../db-instance-modify-retry.js';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import { safeMsg } from '../../../utils/display-safe.js';
import { ProvisioningError } from '../../../utils/error-handler.js';
import { markNonRetryable } from '../../../deployment/retryable-errors.js';
import { coerceCfnBoolean } from '../../config-shape.js';
import type { ResourceUpdateResult, UpdateContext } from '../../../types/resource.js';
import { refuseMalformedDesiredTags } from '../../tag-list.js';
import { dynamicReferenceTokens, SECRET_MASK } from '../../../deployment/secret-redaction.js';
import {
  applyDocDBTagDiff,
  docdbLogExportChange,
  docdbServerlessScaling,
  docdbStringList,
} from '../docdb-shared.js';
import { maskerOrIdentity } from '../../masked-retry-logger.js';
import {
  masterUserPasswordToSend,
  DOCDB_DEFAULT_STORAGE_TYPE,
  rotateMasterUserPassword,
  kmsKeyText,
  sameKmsKey,
  declaredChange,
  DOCDB_CLUSTER_KEPT_ON_REMOVAL,
  DOCDB_CLUSTER_UNMEASURED_ON_REMOVAL,
  CLUSTER_MODIFY_UNSETTLED_KEYS,
  SETTLE_MAX_WAIT_MS,
  STORAGE_SETTLE_MAX_WAIT_MS,
  keptOnRemovalWarning,
  SECURITY_GROUP_CHANGE_MEMBER_STATUSES,
  PORT_CHANGE_MEMBER_STATUSES,
  numberOrUndefined,
  docdbGlobalClusterId,
  type GlobalClusterUpdate,
  withRecordedGlobalCluster,
  readableGlobalClusterId,
  GlobalClusterDetachError,
  docdbEngineVersionToSend,
  clusterPortToSend,
  clusterAttributes,
  securityGroupListChanged,
} from './shared.js';

export async function updateDBCluster(
  this: DocDBProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>,
  context?: UpdateContext
): Promise<ResourceUpdateResult> {
  this.logger.debug(`Updating DocDB DBCluster ${logicalId}: ${physicalId}`);
  // go-to-k/cdkd#3994: a malformed desired Tags is refused before any call.
  refuseMalformedDesiredTags(properties['Tags'], resourceType, logicalId, physicalId);
  const origin = {
    stateBorne: context?.replayingState === true || context?.desiredFromAwsReadback === true,
    physicalId,
  };
  const { logTypes, scaling } = this.readClusterBlocks(
    properties,
    resourceType,
    logicalId,
    origin,
    false
  );
  const globalClusterPlan = await this.planGlobalClusterUpdate(
    physicalId,
    properties,
    previousProperties,
    resourceType,
    logicalId,
    origin,
    context?.desiredFromAwsReadback === true
  );
  // An absent list is a removal, which CloudFormation keeps (#2762 A/B); only
  // a declared one is a delta. A malformed record only misses disables.
  const logExportConfig =
    logTypes === undefined
      ? undefined
      : docdbLogExportChange(
          logTypes,
          docdbStringList(previousProperties['EnableCloudwatchLogsExports']) ?? []
        );

  // Set once this update detached the cluster, so a later failure says so.
  let detachedFrom: string | undefined;
  try {
    const credentials = await this.planMasterCredentials(
      physicalId,
      properties,
      previousProperties,
      resourceType,
      logicalId,
      context,
      origin
    );
    // Class 2 — `VpcSecurityGroupIds: []` would CLEAR all SGs on the
    // cluster. readCurrentState always-emits `[]` for clusters that
    // legitimately have no VPC SGs; the round-trip must NOT translate
    // that placeholder into a destructive SDK call.
    const vpcSgIds = properties['VpcSecurityGroupIds'] as string[] | undefined;
    const sendVpcSgIds = vpcSgIds !== undefined && vpcSgIds.length > 0;

    // #1160 reset-on-removal — ModifyDBCluster has merge semantics (an
    // absent input field means "no change"), so a property REMOVED from
    // the template is sent as an explicit reset only where CloudFormation resets
    // it; #5004 measured DeletionProtection / BackupRetentionPeriod
    // (and IamAuthEnabled / AutoMinorVersionUpgrade on Neptune) as KEPT,
    // so those are not reset. Deliberately NOT reset here:
    //   * EngineVersion, DBClusterParameterGroupName,
    //     PreferredBackupWindow, PreferredMaintenanceWindow — a real
    //     CloudFormation A/B (#5543, `DOCDB_CLUSTER_KEPT_ON_REMOVAL`) showed
    //     CloudFormation KEEPS all four on removal (the cluster stays on its
    //     version, its custom parameter group and its windows), so an
    //     absent value is passed through as absent.
    //   * MasterUserPassword — a secret; removal cannot synthesize a
    //     reset value.
    //   * VpcSecurityGroupIds — a real CloudFormation A/B (issue #1160)
    //     showed CloudFormation KEEPS a DocDB cluster's groups when the
    //     property is removed, so a removal sends nothing. RDS and Neptune
    //     differ: there CloudFormation moves the cluster to the VPC's
    //     default security group.
    // A removed Port IS reset, to 27017 (`clusterPortToSend`): a real
    // CloudFormation A/B (#1160) read a removed `Port: 27018` back as 27017.
    const portToSend = clusterPortToSend(properties, previousProperties);
    // A value the record does not hold compares with the live one: NetworkType
    // and StorageType are real changes, AWS limits StorageType changes, and
    // it reports no StorageType for `standard`.
    const unrecorded = (key: string): boolean =>
      properties[key] != null && previousProperties[key] == null;
    const live =
      unrecorded('NetworkType') ||
      unrecorded('StorageType') ||
      logExportConfig?.EnableLogTypes !== undefined
        ? await this.describeDBCluster(physicalId)
        : undefined;
    const networkType = properties['NetworkType'] as string | undefined;
    const networkChange = declaredChange(
      networkType,
      previousProperties['NetworkType'],
      live?.NetworkType
    );
    const storageType = properties['StorageType'] as string | undefined;
    const storageChange = declaredChange(
      storageType,
      previousProperties['StorageType'],
      live?.StorageType ?? DOCDB_DEFAULT_STORAGE_TYPE
    );
    const previousScaling = docdbServerlessScaling(
      previousProperties['ServerlessV2ScalingConfiguration']
    );
    const scalingChange =
      scaling != null &&
      (scaling.MinCapacity !== previousScaling?.MinCapacity ||
        scaling.MaxCapacity !== previousScaling?.MaxCapacity);
    // go-to-k/cdkd#5628: a removed GlobalClusterIdentifier detaches the
    // cluster in place, as CloudFormation does, BEFORE the ModifyDBCluster:
    // the detach leaves it `modifying` until it is out and `available` again.
    if (globalClusterPlan.kind === 'detach') {
      const detached = await this.detachFromGlobalCluster(
        logicalId,
        physicalId,
        globalClusterPlan.globalClusterId,
        { beforeDelete: false, removeProtection: false },
        { stripped: false },
        maskerOrIdentity(context?.maskSecrets)
      );
      if (detached) detachedFrom = globalClusterPlan.globalClusterId;
    }
    this.markChangedUnsettled(
      CLUSTER_MODIFY_UNSETTLED_KEYS,
      properties,
      previousProperties,
      context
    );
    // go-to-k/cdkd#5994: AWS refuses the modify while the cluster is in a
    // status that ends on its own (`backing-up` right after create), and
    // CloudFormation waits it out. The same input is resent only after such a
    // refusal, so a rollback replay sends exactly what it computed; a terminal
    // status fails at once. One exception to "same end state": when the SDK's
    // own retry replays an ACCEPTED request whose response was lost and AWS
    // refuses the replay as busy, a RotateMasterUserPassword request is sent
    // again and the managed secret rotates twice (still a valid secret).
    const modifyInput: ModifyDBClusterCommandInput = {
      DBClusterIdentifier: physicalId,
      EngineVersion: docdbEngineVersionToSend(properties, previousProperties, context),
      // #5004: CloudFormation KEEPS the live value of a removed
      // DeletionProtection / BackupRetentionPeriod, so an absent value
      // is passed through as absent (no reset).
      DeletionProtection: properties['DeletionProtection'] as boolean | undefined,
      BackupRetentionPeriod:
        properties['BackupRetentionPeriod'] != null
          ? Number(properties['BackupRetentionPeriod'])
          : undefined,
      PreferredBackupWindow: properties['PreferredBackupWindow'] as string | undefined,
      PreferredMaintenanceWindow: properties['PreferredMaintenanceWindow'] as string | undefined,
      DBClusterParameterGroupName: properties['DBClusterParameterGroupName'] as string | undefined,
      ...(sendVpcSgIds && { VpcSecurityGroupIds: vpcSgIds }),
      // #5153: only a changed password; any supplied one resets credentials.
      MasterUserPassword: credentials.password,
      Port: portToSend,
      CopyTagsToSnapshot: properties['CopyTagsToSnapshot'] as boolean | undefined,
      // #2762: a request for this update, never a setting to repeat.
      ...(rotateMasterUserPassword(properties, previousProperties, context) && {
        RotateMasterUserPassword: true,
      }),
      ...(credentials.managed !== undefined && {
        ManageMasterUserPassword: credentials.managed,
      }),
      ...(credentials.secretKmsKey !== undefined && {
        MasterUserSecretKmsKeyId: credentials.secretKmsKey,
      }),
      // Each sent only on a change: re-sending asks AWS for one every update.
      ...(networkChange && { NetworkType: networkType }),
      ...(storageChange && { StorageType: storageType }),
      ...(scalingChange && { ServerlessV2ScalingConfiguration: scaling }),
      ...(logExportConfig !== undefined && {
        CloudwatchLogsExportConfiguration: logExportConfig,
      }),
      ApplyImmediately: true,
    };
    await modifyDbInstanceWhenAvailable({
      send: () => this.getClient().send(new ModifyDBClusterCommand(modifyInput)),
      readStatus: async () => (await this.describeDBCluster(physicalId))?.Status,
      sleep: (ms) => this.sleep(ms),
      logger: this.logger,
      label: 'DocDB DBCluster',
      subject: 'cluster',
      isRefusal: isModifyNotAvailableRefusal,
      logicalId,
      remainingMs: enclosingDeadlineRemainingMs(),
    });

    // go-to-k/cdkd#5498: what this call added, so a convergence after a later
    // failure disables it, and nothing an out-of-band change enabled.
    const addedLogTypes = (logExportConfig?.EnableLogTypes ?? []).filter(
      (type) => !live?.EnabledCloudwatchLogsExports?.includes(type)
    );
    if (addedLogTypes.length > 0) {
      context?.markAttempted?.('EnableCloudwatchLogsExports', addedLogTypes);
    }

    this.logger.debug(`Successfully updated DocDB DBCluster ${logicalId}`);

    // A changed Port (declared, or the default on removal) applies
    // asynchronously: the describe below could still read the old one, and a
    // same-deploy `Fn::GetAtt <cluster>.Port` would get it. CloudFormation
    // reports the update once it has settled, so wait for the new port first,
    // then for the member instances it moved to `modifying` / `rebooting`, whose
    // own Modify* in the same deploy would otherwise be refused. An unchanged
    // port adds no call; `--no-wait` skips both.
    const noWait = process.env['CDKD_NO_WAIT'] === 'true';
    const portChanged =
      portToSend !== undefined && portToSend !== numberOrUndefined(previousProperties['Port']);
    if (!noWait && portChanged) {
      await this.waitForClusterPortApplied(physicalId, logicalId, portToSend);
    }

    const described = await this.describeDBCluster(physicalId);

    if (!noWait) {
      // The observed baseline is captured after update(): an old value read
      // here is a phantom drift later. The delta, not the whole list: a log
      // type enabled out of band is not ours.
      const { EnableLogTypes: enabled = [], DisableLogTypes: disabled = [] } =
        logExportConfig ?? {};
      const applied = new Map<string, (cluster: DBCluster | undefined) => boolean>();
      if (logExportConfig !== undefined) {
        applied.set('EnableCloudwatchLogsExports', (cluster) => {
          const logs = cluster?.EnabledCloudwatchLogsExports;
          return (
            enabled.every((type) => logs?.includes(type)) &&
            !disabled.some((type) => logs?.includes(type))
          );
        });
      }
      if (networkChange) {
        applied.set('NetworkType', (cluster) => cluster?.NetworkType === networkType);
      }
      if (storageChange) {
        applied.set(
          'StorageType',
          (cluster) => (cluster?.StorageType ?? DOCDB_DEFAULT_STORAGE_TYPE) === storageType
        );
      }
      if (scalingChange) {
        applied.set('ServerlessV2ScalingConfiguration', (cluster) => {
          const live = cluster?.ServerlessV2ScalingConfiguration;
          return (
            live?.MinCapacity === scaling?.MinCapacity && live?.MaxCapacity === scaling?.MaxCapacity
          );
        });
      }
      await this.waitForApplied(
        logicalId,
        applied,
        () => this.describeDBCluster(physicalId),
        storageChange ? STORAGE_SETTLE_MAX_WAIT_MS : SETTLE_MAX_WAIT_MS
      );
    }

    if (!noWait && portChanged) {
      for (const member of described?.DBClusterMembers ?? []) {
        if (member.DBInstanceIdentifier) {
          await this.waitForMemberAfterClusterChange(
            member.DBInstanceIdentifier,
            logicalId,
            PORT_CHANGE_MEMBER_STATUSES,
            'port'
          );
        }
      }
    }

    // A changed VpcSecurityGroupIds also moves every member instance to
    // `modifying` within about a second, and a member's own Modify* in the
    // same deploy is then refused ("Database instance is not in available
    // state"). CloudFormation reports the update only once it has settled, so
    // wait here, but ONLY when the sent list differs from the previous one:
    // an unchanged list (re-sent on every update) adds no time. `--no-wait`
    // skips it, exactly as create() skips waitForClusterAvailable.
    if (
      process.env['CDKD_NO_WAIT'] !== 'true' &&
      securityGroupListChanged(
        sendVpcSgIds ? vpcSgIds : undefined,
        previousProperties['VpcSecurityGroupIds']
      )
    ) {
      await this.waitForSecurityGroupsApplied(
        physicalId,
        logicalId,
        (sendVpcSgIds ? vpcSgIds : undefined) ?? []
      );
      for (const member of described?.DBClusterMembers ?? []) {
        if (member.DBInstanceIdentifier) {
          await this.waitForMemberAfterClusterChange(
            member.DBInstanceIdentifier,
            logicalId,
            SECURITY_GROUP_CHANGE_MEMBER_STATUSES,
            'VPC security groups'
          );
        }
      }
    }

    if (described?.DBClusterArn) {
      await applyDocDBTagDiff(
        this.getClient(),
        this.logger,
        described.DBClusterArn,
        resourceType,
        logicalId,
        previousProperties['Tags'],
        properties['Tags']
      );
    }

    // #5543: after every call succeeded, so a failed or retried update
    // never prints it.
    const keptWarning = keptOnRemovalWarning(
      DOCDB_CLUSTER_KEPT_ON_REMOVAL,
      properties,
      previousProperties,
      context,
      logicalId,
      resourceType
    );
    if (keptWarning !== undefined) this.logger.warn(keptWarning);
    const unmeasuredWarning = keptOnRemovalWarning(
      DOCDB_CLUSTER_UNMEASURED_ON_REMOVAL,
      properties,
      previousProperties,
      context,
      logicalId,
      resourceType,
      false
    );
    if (unmeasuredWarning !== undefined) this.logger.warn(unmeasuredWarning);
    if (credentials.heldWarning !== undefined) this.logger.warn(credentials.heldWarning);

    return {
      physicalId,
      wasReplaced: false,
      // Under `--no-wait` the describe can still read the OLD port; record the
      // one sent, or a `Fn::GetAtt <cluster>.Port` consumer stays stale.
      attributes: clusterAttributes(
        noWait && portChanged && described !== undefined
          ? { ...described, Port: portToSend }
          : described
      ),
      ...((credentials.effectiveProperties !== undefined || globalClusterPlan.kind === 'keep') && {
        effectiveProperties:
          globalClusterPlan.kind === 'keep'
            ? withRecordedGlobalCluster(
                credentials.effectiveProperties ?? properties,
                previousProperties
              )
            : credentials.effectiveProperties,
      }),
    };
  } catch (error) {
    // A refusal of ours names its own cause.
    if (error instanceof ProvisioningError) throw error;
    if (error instanceof GlobalClusterDetachError) {
      // Already masked and waited through: a retry would only repeat it.
      throw markNonRetryable(
        new ProvisioningError(
          `Failed to update DocDB DBCluster ${logicalId}: ${error.message}`,
          resourceType,
          logicalId,
          physicalId,
          error
        )
      );
    }
    const cause = error instanceof Error ? error : undefined;
    const detachedNote =
      detachedFrom !== undefined
        ? ' (it was already detached from its global cluster, and stays a standalone cluster)'
        : '';
    throw this.wrapCaughtError(
      context?.maskSecrets,
      error,
      (text) =>
        new ProvisioningError(
          `Failed to update DocDB DBCluster ${logicalId}: ${text}${detachedNote}`,
          resourceType,
          logicalId,
          physicalId,
          cause
        )
    );
  }
}

/**
 * go-to-k/cdkd#5628: what an update does about `GlobalClusterIdentifier`.
 * ModifyDBCluster has no member for it. A real CloudFormation A/B
 * (us-east-1, engine 5.0.0, 2026-11-02) measured the handler:
 *
 * - REMOVAL, or `""` (also measured), updates in place: the cluster is
 *   detached from its global cluster and stays `available`, standalone, under
 *   the same id. Here a template removal is `detach` (`detachFromGlobalCluster`,
 *   which does nothing when the live cluster is no longer listed).
 * - ADD or CHANGE fails ("Changing GlobalClusterIdentifier to a different
 *   global cluster is not supported unless the cluster is already part of
 *   the target global cluster"), measured from a non-member cluster and from
 *   a member, which stays in its global cluster. Here a template add / change
 *   is refused before any write, unless the live cluster is already part of
 *   the target (`none`, no call). A state-borne one (a rollback of a forward
 *   removal asks to re-join) cannot be applied either: it warns, and `keep`
 *   records the previous side, so the record never claims a re-join.
 * - A state-borne REMOVAL keeps a membership the live cluster shows. With add
 *   / change refused unless the cluster is already part of the target, a
 *   forward deploy can only have RECORDED a membership it found, never made
 *   one, so restoring the pre-deploy state means leaving the cluster where it
 *   is; a detach would be irreversible. One the live cluster does not show (a
 *   refused add the rollback restores) is `none`: the record drops the key.
 *
 * A `drift --revert` readback never carries the key (it is a drift-unknown
 * path), so its ABSENCE there is no change: `keep`, silently.
 */
export async function planGlobalClusterUpdate(
  this: DocDBProvider,
  physicalId: string,
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>,
  resourceType: string,
  logicalId: string,
  origin: { stateBorne: boolean; physicalId?: string },
  fromReadback: boolean
): Promise<GlobalClusterUpdate> {
  const desired = properties['GlobalClusterIdentifier'];
  if (fromReadback && desired === undefined) {
    return previousProperties['GlobalClusterIdentifier'] !== undefined
      ? { kind: 'keep' }
      : { kind: 'none' };
  }
  const readable = readableGlobalClusterId(desired);
  const desiredId = docdbGlobalClusterId(desired);
  const previousId = docdbGlobalClusterId(previousProperties['GlobalClusterIdentifier']);
  if (readable && desiredId === previousId) return { kind: 'none' };
  // `""` reads as no global cluster, and detaches like a removal: the
  // CloudFormation A/B measured `""` on a member detaching in place.
  if (readable && desiredId === undefined && previousId !== undefined) {
    if (origin.stateBorne) {
      // Only a membership the live cluster SHOWS is kept. A record naming one
      // it does not (a refused add, restored by --revert-failed with the
      // attempted bag as previous) would otherwise disable the next deploy's
      // refusal. An unreadable listing answers false: recording no membership
      // is self-correcting (the next add re-reads live), recording a false one
      // is not.
      const member = await this.liveGlobalClusterMatches(physicalId, previousId);
      if (member === undefined) {
        this.logger.warn(
          safeMsg`${logicalId} (${resourceType}): the cluster's membership of global cluster ${previousId} could not be read, so the record treats it as absent; if it is still a member, a later destroy may need aws docdb remove-from-global-cluster first.`
        );
      }
      if (member !== true) return { kind: 'none' };
      this.logger.warn(
        safeMsg`${logicalId} (${resourceType}): the restored state has no GlobalClusterIdentifier, but cdkd did not add the cluster to global cluster ${previousId} (it was already a member), so it leaves it there.`
      );
      return { kind: 'keep' };
    }
    return { kind: 'detach', globalClusterId: previousId };
  }
  if (readable && (await this.liveGlobalClusterMatches(physicalId, desiredId)) === true) {
    return { kind: 'none' };
  }
  const text = readable
    ? 'Changing GlobalClusterIdentifier to a different global cluster is not supported unless the cluster is already part of the target global cluster (CloudFormation refuses it too). To join a different global cluster, replace the cluster, for example with a new DBClusterIdentifier'
    : 'GlobalClusterIdentifier is not a string';
  if (!origin.stateBorne) this.refuseBlock(logicalId, resourceType, physicalId, text);
  this.logger.warn(
    safeMsg`${logicalId} (${resourceType}): ${text}; the cluster keeps its current global cluster membership.`
  );
  return { kind: 'keep' };
}

/**
 * Whether the live cluster's global cluster is `desiredId` (`undefined`:
 * none). Every global cluster is listed, as a cluster can be in at most one.
 * A failed read answers `undefined` (unknown), which callers keep apart from
 * `false`: an add keeps its refusal on either.
 */
export async function liveGlobalClusterMatches(
  this: DocDBProvider,
  physicalId: string,
  desiredId: string | undefined
): Promise<boolean | undefined> {
  try {
    const arn = (await this.describeDBCluster(physicalId))?.DBClusterArn;
    if (typeof arn !== 'string' || arn === '') return undefined;
    let liveId: string | undefined;
    let marker: string | undefined;
    do {
      const page = await this.getClient().send(
        new DescribeGlobalClustersCommand({ ...(marker !== undefined && { Marker: marker }) })
      );
      const holder = (page.GlobalClusters ?? []).find((global) =>
        (global.GlobalClusterMembers ?? []).some((member) => member.DBClusterArn === arn)
      );
      if (holder !== undefined) {
        liveId = holder.GlobalClusterIdentifier;
        break;
      }
      marker = page.Marker;
    } while (marker);
    return liveId === desiredId;
  } catch (error) {
    this.logger.debug(
      safeMsg`Could not read a DocDB cluster's global cluster membership: ${describeAwsFailure(error).summary}`
    );
    return undefined;
  }
}

/**
 * The `EnableCloudwatchLogsExports` (`undefined` when absent) and
 * `ServerlessV2ScalingConfiguration` a create or update sends, malformed ones
 * refused before any call. A state-borne bag, which the template cannot fix,
 * downgrades to a warning and leaves the block out. One exception: a malformed
 * list on an UPDATE stays refused, since the list is read as a diff and read
 * as empty it would disable every log
 * (`.claude/rules/provider-aws-response-reads.md`, the list rule).
 */
export function readClusterBlocks(
  this: DocDBProvider,
  properties: Record<string, unknown>,
  resourceType: string,
  logicalId: string,
  origin: { stateBorne: boolean; physicalId?: string },
  creating: boolean
): {
  logTypes: string[] | undefined;
  scaling: { MinCapacity: number; MaxCapacity: number } | null | undefined;
} {
  const leaveOut = (key: string): void => {
    this.logger.warn(
      safeMsg`${logicalId} (${resourceType}): the recorded ${key} is unusable, so it is not sent.`
    );
  };
  const rawLogs = properties['EnableCloudwatchLogsExports'];
  let logTypes = rawLogs == null ? undefined : docdbStringList(rawLogs);
  if (rawLogs != null && logTypes === undefined) {
    if (!(creating && origin.stateBorne)) {
      this.refuseBlock(
        logicalId,
        resourceType,
        origin.physicalId,
        'EnableCloudwatchLogsExports must be a list of strings'
      );
    }
    leaveOut('EnableCloudwatchLogsExports');
    logTypes = undefined;
  }
  const scaling = docdbServerlessScaling(properties['ServerlessV2ScalingConfiguration']);
  if (scaling === null) {
    if (!origin.stateBorne) {
      this.refuseBlock(
        logicalId,
        resourceType,
        origin.physicalId,
        'ServerlessV2ScalingConfiguration must be an object with both a numeric MinCapacity and a numeric MaxCapacity'
      );
    }
    leaveOut('ServerlessV2ScalingConfiguration');
  }
  return { logTypes, scaling };
}

/**
 * go-to-k/cdkd#2762: what a cluster update sends for the master credentials.
 *
 * - The managed side is the record's flag. A record without one (never
 *   declared, or a deploy dropped it and the cluster stayed managed) reads
 *   `MasterUserSecret` when a password, the flag or a changed key is about to
 *   go out, and only then; its ARN is never kept.
 * - The flag goes out on a change, or beside a key change.
 * - Leaving managed mode sends the declared password whether it changed or
 *   not: AWS refuses `false` without one.
 * - `drift --revert` never changes the mode, either way: its bags hold no
 *   password or key. A rollback turning management off with no password to
 *   send sends nothing and records `true`, what AWS holds. Both leave a warning
 *   for after the update.
 */
export async function planMasterCredentials(
  this: DocDBProvider,
  physicalId: string,
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>,
  resourceType: string,
  logicalId: string,
  context: UpdateContext | undefined,
  origin: { stateBorne: boolean; physicalId?: string }
): Promise<{
  managed: boolean | undefined;
  secretKmsKey: string | undefined;
  password: string | undefined;
  heldWarning: string | undefined;
  effectiveProperties?: Record<string, unknown>;
}> {
  const managed = this.readBooleanProperty(
    'ManageMasterUserPassword',
    properties,
    resourceType,
    logicalId,
    origin
  );
  const changedPassword = masterUserPasswordToSend(properties, previousProperties, context);
  const recordedFlag = coerceCfnBoolean(previousProperties['ManageMasterUserPassword']);
  const key = properties['MasterUserSecretKmsKeyId'] as string | undefined;
  const recordedKey = previousProperties['MasterUserSecretKmsKeyId'] as string | undefined;
  let managedSide = recordedFlag ?? false;
  let keyChange = key != null && !sameKmsKey(key, recordedKey);
  if (
    recordedFlag === undefined &&
    (changedPassword !== undefined || managed !== undefined || keyChange)
  ) {
    const secret = (await this.describeDBCluster(physicalId))?.MasterUserSecret;
    managedSide = secret !== undefined;
    // A live key is a uuid or ARN, which no declared alias can be compared with.
    if (recordedKey === undefined && secret?.KmsKeyId !== undefined && key != null) {
      keyChange = !sameKmsKey(key, secret.KmsKeyId) && !kmsKeyText(key).startsWith('alias/');
    }
  }
  const leaving = managed === false && managedSide;
  const declared = properties['MasterUserPassword'];
  const declaredUsable =
    typeof declared === 'string' &&
    declared !== SECRET_MASK &&
    dynamicReferenceTokens(declared).length === 0;
  const password = leaving ? (declaredUsable ? declared : undefined) : changedPassword;
  const modeChange = managed !== undefined && managed !== managedSide;
  if (context?.desiredFromAwsReadback === true && modeChange) {
    return {
      managed: undefined,
      secretKmsKey: undefined,
      password: undefined,
      heldWarning: safeMsg`${logicalId} (${resourceType}): cdkd drift --revert does not change ManageMasterUserPassword, so it is left as it is. Declare it in the template and deploy to change it.`,
    };
  }
  if (origin.stateBorne && leaving && password === undefined) {
    return {
      managed: undefined,
      secretKmsKey: undefined,
      password: undefined,
      heldWarning: safeMsg`${logicalId} (${resourceType}): ManageMasterUserPassword stays true: turning it off needs a MasterUserPassword, which the restored state does not hold. Declare both in the template and deploy.`,
      // The record says what AWS holds, so a later `false` is still a change.
      effectiveProperties: { ...properties, ManageMasterUserPassword: true },
    };
  }
  // The key rides only turning management on or a change while it stays on:
  // AWS takes one only then, answers the second itself, and never beside false.
  const sendKey =
    key != null && ((modeChange && managed === true) || (keyChange && (managed ?? managedSide)));
  return {
    managed: modeChange || sendKey ? managed : undefined,
    secretKmsKey: sendKey ? key : undefined,
    password: this.passwordBesideManaged(
      managed,
      managed === undefined && managedSide,
      password,
      resourceType,
      logicalId,
      origin
    ),
    heldWarning: undefined,
  };
}
