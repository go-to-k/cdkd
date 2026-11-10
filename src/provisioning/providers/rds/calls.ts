import {
  DescribeDBClustersCommand,
  EnableHttpEndpointCommand,
  DisableHttpEndpointCommand,
  DescribeDBInstancesCommand,
  DescribeDBInstanceAutomatedBackupsCommand,
  DescribeDBSubnetGroupsCommand,
  RDSClient,
  StartDBInstanceAutomatedBackupsReplicationCommand,
  StopDBInstanceAutomatedBackupsReplicationCommand,
  ListTagsForResourceCommand,
  AddTagsToResourceCommand,
  RemoveTagsFromResourceCommand,
} from '@aws-sdk/client-rds';
import { DescribeSecurityGroupsCommand } from '@aws-sdk/client-ec2';
import {
  markNonRetryable,
  markRedactedCause,
  relayedNameCollision,
  wrapMaskedAwsError,
} from '../../../deployment/retryable-errors.js';
import { enclosingDeadlineRemainingMs } from '../../../deployment/resource-deadline.js';
import { ambientClientDefaults } from '../../../utils/ambient-client-defaults.js';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import { safeMsg } from '../../../utils/display-safe.js';
import {
  createMaskedLogSinks,
  maskerOrIdentity,
  withDerivedNameMasks,
} from '../../masked-retry-logger.js';
import { CdkdError, ProvisioningError } from '../../../utils/error-handler.js';
import { markNotGone } from '../../not-gone.js';
import { normalizeAwsTagsToCfn } from '../../import-helpers.js';
import { planTagDiff, tagPlanWarning } from '../../tag-list.js';
import type { UpdateContext } from '../../../types/resource.js';
import type { RDSProvider } from '../rds-provider.js';
import {
  type BackupReplicationPlan,
  engineLifecycleSupportOf,
  engineLifecycleSupportAction,
  engineLifecycleSupportRefusalText,
  liveBackupReplicationRegions,
} from './instance-members.js';
import { HTTP_ENDPOINT_BUSY_FAULTS, HTTP_ENDPOINT_MAX_ATTEMPTS, awsErrorName } from './shared.js';

// ─── Helpers ──────────────────────────────────────────────────────

/**
 * Apply a diff between old and new CFn-shape Tags arrays via RDS's
 * `AddTagsToResource` / `RemoveTagsFromResource` APIs (keyed by
 * `ResourceName=arn`).
 */
export async function applyTagDiff(
  this: RDSProvider,
  arn: string,
  resourceType: string,
  logicalId: string,
  oldTagsRaw: unknown,
  newTagsRaw: unknown
): Promise<void> {
  // go-to-k/cdkd#3994: both sides are read through `planTagDiff`; an
  // unreadable record untags nothing.
  const plan = planTagDiff(oldTagsRaw, newTagsRaw);
  const tagWarning = tagPlanWarning(plan, resourceType, logicalId);
  if (tagWarning !== undefined) {
    this.logger.warn(tagWarning);
  }
  const tagsToAdd = [...plan.set].map(([Key, Value]) => ({ Key, Value }));
  const tagsToRemove = plan.remove;

  if (tagsToRemove.length > 0) {
    await this.getClient().send(
      new RemoveTagsFromResourceCommand({ ResourceName: arn, TagKeys: tagsToRemove })
    );
    this.logger.debug(`Removed ${tagsToRemove.length} tag(s) from RDS resource ${arn}`);
  }
  if (tagsToAdd.length > 0) {
    await this.getClient().send(
      new AddTagsToResourceCommand({ ResourceName: arn, Tags: tagsToAdd })
    );
    this.logger.debug(`Added/updated ${tagsToAdd.length} tag(s) on RDS resource ${arn}`);
  }
}

export function isNotFoundError(this: RDSProvider, error: unknown, faultName: string): boolean {
  if (!(error instanceof Error)) return false;
  const name = (error as { name?: string }).name ?? '';
  const message = error.message.toLowerCase();
  return name === faultName || message.includes('not found') || message.includes('does not exist');
}

/**
 * The failure wrap the DBSubnetGroup / DBCluster / DBInstance create, update
 * and delete catches throw.
 *
 * An AWS-authored failure reaches `build` as its CLASS plus the `--verbose`
 * pointer (go-to-k/cdkd#2319): a thrown message is persisted to
 * `deployments/{runId}.jsonl`, and an `AccessDenied` names the caller's
 * assumed-role ARN. AWS's own text goes to `debug` through the operation's
 * masker, and the wrap is stamped `markRedactedCause`, so the retry
 * classifiers read the withheld text on the `cause` chain. An "already
 * exists" is restated ({@link relayedNameCollision}), so a create-first
 * replacement still recognises the collision. A cdkd-authored or transport
 * error keeps its text, masked, stamped only when the mask changed it
 * (`wrapMaskedAwsError`, issue #4244); a non-`Error` throw is withheld like
 * an AWS one, unstamped (it has no chain). The delete catches test not-found
 * before they wrap.
 *
 * `build` must thread `error` as `cause`, and runs twice, so it must stay a
 * side-effect-free constructor call.
 */
export function wrapCaughtError(
  this: RDSProvider,
  mask: ((text: string) => string) | undefined,
  error: unknown,
  build: (text: string) => ProvisioningError
): ProvisioningError {
  const m = maskerOrIdentity(mask);
  const failure = describeAwsFailure(error);
  if (!failure.redacted) return wrapMaskedAwsError(m, error, build);
  this.logger.debug(m(build(m(failure.detail)).message));
  const wrapped = build(`${m(failure.summary)}${relayedNameCollision(failure.detail)}`);
  return error instanceof Error ? markRedactedCause(wrapped) : wrapped;
}

/**
 * {@link wrapCaughtError} for a delete catch. The wrap names an AWS failure
 * by its CLASS, and the delete classifiers read `NotFound` in a message as
 * "already deleted": a class naming ANOTHER object's not-found (this
 * resource's own not-found returned before the wrap) is marked
 * `markNotGone`, so the record is kept (go-to-k/cdkd#2319).
 */
export function wrapDeleteError(
  this: RDSProvider,
  mask: ((text: string) => string) | undefined,
  error: unknown,
  build: (text: string) => ProvisioningError
): ProvisioningError {
  const thrown = this.wrapCaughtError(mask, error, build);
  return error instanceof Error && error.name.includes('NotFound') ? markNotGone(thrown) : thrown;
}

/**
 * go-to-k/cdkd#5639 / #5640: the `EngineLifecycleSupport` an update sends
 * (`engineLifecycleSupportAction`), or `undefined` for none; a change
 * CloudFormation refuses throws before any call. The physical id can be
 * secret-derived, so the refusal is masked against the recorded name too
 * (go-to-k/cdkd#4339).
 */
export async function engineLifecycleSupportToSend(
  this: RDSProvider,
  kind: 'DB cluster' | 'DB instance',
  logicalId: string,
  physicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>,
  context: UpdateContext | undefined
): Promise<string | undefined> {
  const action = engineLifecycleSupportAction(properties, previousProperties, context);
  if (action === 'unchanged') return undefined;
  const desired = engineLifecycleSupportOf(properties);
  if (action === 'send') return desired;
  const idKey = kind === 'DB cluster' ? 'DBClusterIdentifier' : 'DBInstanceIdentifier';
  const { mask } = withDerivedNameMasks(
    this.logger,
    createMaskedLogSinks(this.logger, context?.maskSecrets),
    [[previousProperties[idKey], physicalId]]
  );
  // `undefined` once the live resource is known to hold the declared value.
  let liveRead: 'read' | 'not-found' | undefined = 'read';
  if (action === 'check-live') {
    try {
      const resource =
        kind === 'DB cluster'
          ? await this.describeDBCluster(physicalId)
          : await this.describeDBInstance(physicalId);
      if (resource === undefined) liveRead = 'not-found';
      else if (resource.EngineLifecycleSupport === desired) liveRead = undefined;
    } catch (err) {
      if (err instanceof CdkdError) throw err;
      // Only the fault NAME proves the resource is gone (go-to-k/cdkd#4283).
      const faultName = (err as { name?: unknown } | null)?.name;
      if (faultName === 'DBClusterNotFoundFault' || faultName === 'DBInstanceNotFoundFault') {
        liveRead = 'not-found';
      } else {
        // Left retryable: a later read may succeed. AWS's text reaches the
        // message as its class only, the rest at debug (go-to-k/cdkd#2319).
        throw this.wrapCaughtError(
          mask,
          err,
          (text) =>
            new ProvisioningError(
              `${mask(engineLifecycleSupportRefusalText(resourceType, logicalId, physicalId, kind, 'unreadable'))} The read failed: ${text}`,
              resourceType,
              logicalId,
              physicalId,
              err instanceof Error ? err : undefined
            )
        );
      }
    }
  }
  if (liveRead === undefined) return undefined;
  throw markNonRetryable(
    new ProvisioningError(
      mask(engineLifecycleSupportRefusalText(resourceType, logicalId, physicalId, kind, liveRead)),
      resourceType,
      logicalId,
      physicalId
    )
  );
}

export async function describeDBCluster(this: RDSProvider, dbClusterIdentifier: string) {
  const response = await this.getClient().send(
    new DescribeDBClustersCommand({
      DBClusterIdentifier: dbClusterIdentifier,
    })
  );
  return response.DBClusters?.[0];
}

/**
 * The security groups a DBCluster (`VpcSecurityGroupIds`) or DBInstance
 * (`VPCSecurityGroups`) update sends as SDK `VpcSecurityGroupIds`, or
 * `undefined` to omit it (ModifyDBCluster / ModifyDBInstance keep the live
 * groups then):
 *
 * - A non-empty declared list is sent as declared.
 * - An EMPTY list is omitted: `[]` would detach every group, and
 *   `readCurrentState` emits `[]` for a cluster with none, which
 *   `drift --revert` hands back as the desired bag.
 * - A list the previous template declared and the desired one omits is a
 *   removal (issue #1160). Real CloudFormation A/Bs showed CloudFormation
 *   then attaches the VPC's `default` security group in place of the
 *   declared ones, for a DB cluster and (#5542) a DB instance alike, so cdkd
 *   looks that group up and sends it. A previous EMPTY list attached
 *   nothing, and a `drift --revert` baseline is a readback rather than a
 *   template, so neither counts as a removal.
 */
export async function securityGroupsToSend(
  this: RDSProvider,
  target: 'DBCluster' | 'DBInstance',
  logicalId: string,
  physicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>,
  context: UpdateContext | undefined
): Promise<string[] | undefined> {
  const key = target === 'DBCluster' ? 'VpcSecurityGroupIds' : 'VPCSecurityGroups';
  const noun = target === 'DBCluster' ? 'cluster' : 'instance';
  const desired = properties[key] as string[] | undefined;
  if (desired !== undefined) return desired.length > 0 ? desired : undefined;
  const previous = previousProperties[key];
  if (context?.desiredFromAwsReadback === true) return undefined;
  if (!Array.isArray(previous) || previous.length === 0) return undefined;

  // `missing` names what the lookup did not find (terminal); `awsError` is a
  // failed call (left retryable).
  let groupId: string | undefined;
  let missing: string | undefined;
  let awsError: unknown;
  try {
    // A DB instance reports its subnet group's VPC inline; a cluster names
    // only the group, so its VPC takes one more read.
    let subnetGroupName: string | undefined;
    let vpcId: string | undefined;
    if (target === 'DBInstance') {
      const subnetGroup = (await this.describeDBInstance(physicalId))?.DBSubnetGroup;
      subnetGroupName = subnetGroup?.DBSubnetGroupName;
      vpcId = subnetGroupName ? subnetGroup?.VpcId : undefined;
    } else {
      subnetGroupName = (await this.describeDBCluster(physicalId))?.DBSubnetGroup;
      vpcId = subnetGroupName
        ? (
            await this.getClient().send(
              new DescribeDBSubnetGroupsCommand({ DBSubnetGroupName: subnetGroupName })
            )
          ).DBSubnetGroups?.[0]?.VpcId
        : undefined;
    }
    if (!subnetGroupName) missing = `the ${noun} reports no DB subnet group`;
    else if (!vpcId) missing = `DB subnet group ${subnetGroupName} reports no VPC`;
    else {
      const groups = await this.getEc2Client().send(
        new DescribeSecurityGroupsCommand({
          Filters: [
            { Name: 'vpc-id', Values: [vpcId] },
            { Name: 'group-name', Values: ['default'] },
          ],
        })
      );
      groupId = groups.SecurityGroups?.[0]?.GroupId;
      if (!groupId) missing = `VPC ${vpcId} has no security group named default`;
    }
  } catch (error) {
    awsError = error;
  }
  if (groupId === undefined) {
    // go-to-k/cdkd#2319: the thrown message is persisted, so an AWS failure
    // contributes only its summary (an EC2 UnauthorizedOperation names the
    // caller's ARN). The full text goes to debug, masked, and the retry
    // classifier reads it on `cause`.
    const mask = context?.maskSecrets ?? ((text: string) => text);
    const failure = missing === undefined ? describeAwsFailure(awsError) : undefined;
    if (failure?.redacted === true) {
      this.logger.debug(
        safeMsg`${logicalId}: the VPC default security group lookup failed: ${mask(failure.detail)}`
      );
    }
    const shown = mask(failure?.summary ?? '');
    const refusal = new ProvisioningError(
      `Failed to update ${target} ${logicalId}: ${key} was removed from the template, so the ${noun} moves to its VPC's default security group (as CloudFormation does), but cdkd could not find that group: ${missing ?? shown}. Declare ${key} in the template to choose the ${noun}'s security groups.`,
      resourceType,
      logicalId,
      physicalId,
      awsError instanceof Error ? awsError : undefined
    );
    if (missing !== undefined) throw markNonRetryable(refusal);
    // Stamped whenever the message lost text the cause still holds: the
    // AWS-authored summary, or a masker edit (the classifier must not miss
    // retry wording a secret overlapped).
    const withheld =
      awsError instanceof Error &&
      (failure?.redacted === true || shown !== (failure?.summary ?? ''));
    throw withheld ? markRedactedCause(refusal) : refusal;
  }
  // A warning, not info: the default group may grant wider access.
  this.logger.warn(
    safeMsg`${logicalId}: ${key} was removed from the template; attaching the VPC's default security group ${groupId}, as CloudFormation does.`
  );
  return [groupId];
}

export async function describeDBInstance(this: RDSProvider, dbInstanceIdentifier: string) {
  const response = await this.getClient().send(
    new DescribeDBInstancesCommand({
      DBInstanceIdentifier: dbInstanceIdentifier,
    })
  );
  return response.DBInstances?.[0];
}

/**
 * go-to-k/cdkd#5639: `EnableHttpEndpoint` / `DisableHttpEndpoint` once the
 * cluster is `available`. Right after a ModifyDBCluster the describe can
 * still read `available` before the change starts, and the call is then
 * refused as busy (`HTTP_ENDPOINT_BUSY_FAULTS`), so a refusal of that kind
 * waits for `available` again and resends, at most
 * `HTTP_ENDPOINT_MAX_ATTEMPTS` times. Any other failure, or the last busy
 * one, propagates.
 */
export async function sendHttpEndpointChange(
  this: RDSProvider,
  logicalId: string,
  physicalId: string,
  arn: string,
  enable: boolean
): Promise<void> {
  let delay = 5_000;
  for (let attempt = 1; ; attempt += 1) {
    await this.waitForClusterState(
      logicalId,
      physicalId,
      (cluster) => cluster.Status === 'available',
      'pending changes to settle before the Data API call'
    );
    try {
      await this.getClient().send(
        enable
          ? new EnableHttpEndpointCommand({ ResourceArn: arn })
          : new DisableHttpEndpointCommand({ ResourceArn: arn })
      );
      return;
    } catch (error) {
      const name = awsErrorName(error);
      if (!HTTP_ENDPOINT_BUSY_FAULTS.has(name) || attempt >= HTTP_ENDPOINT_MAX_ATTEMPTS) {
        throw error;
      }
      this.logger.debug(
        safeMsg`DBCluster ${logicalId}: the Data API call was refused as busy (${name}); retrying`
      );
      await this.sleep(delay);
      delay = Math.min(delay * 2, 10_000);
    }
  }
}

/**
 * Fetch tags via `ListTagsForResource(ResourceName=arn)` and merge them
 * into the result under `Tags` (CFn shape, `aws:*` filtered out, omitted
 * when empty). Best-effort: tag-fetch failures are logged at debug and
 * the key is simply left out — drift detection on configuration is more
 * important than fail-closing on a missing tag permission.
 */
export async function attachTags(
  this: RDSProvider,
  result: Record<string, unknown>,
  arn: string
): Promise<void> {
  try {
    const tagsResp = await this.getClient().send(
      new ListTagsForResourceCommand({ ResourceName: arn })
    );
    const tags = normalizeAwsTagsToCfn(tagsResp.TagList);
    result['Tags'] = tags;
  } catch (err) {
    this.logger.debug(`RDS ListTagsForResource(${arn}) failed: ${describeAwsFailure(err).detail}`);
  }
}

/** One RDS call from a client built for `region` and destroyed after it. */
async function sendInRegion<T>(
  region: string,
  call: (client: RDSClient) => Promise<T>
): Promise<T> {
  const client = new RDSClient({ ...ambientClientDefaults(), region });
  try {
    return await call(client);
  } finally {
    client.destroy();
  }
}

/** The text of RDS's refusal of a replication without a usable KMS key. */
const REPLICATION_KMS_KEY_ERROR = 'Encrypted instances require a valid KMS key ID';

/**
 * go-to-k/cdkd#5640: carry out a {@link BackupReplicationPlan} on an instance,
 * as CloudFormation's handlers do after the create or the update's other
 * changes (`stopAutomaticBackupReplicationInRegion` /
 * `startAutomaticBackupReplicationInRegion`): both calls go to the
 * DESTINATION region and name the instance by its ARN. RDS takes neither while
 * the instance is busy, so they wait for `available` first, under `--no-wait`
 * too. Every replication the instance lists is stopped first, whichever
 * region it reads (the record's previous region, or one a failed earlier
 * attempt already started), so the start never meets one in place; when a
 * start follows, that waits for the list to empty. CloudFormation then waits
 * for `available` with the desired region listed (with none listed after a
 * stop alone), as does cdkd unless `--no-wait`.
 */
export async function applyBackupReplication(
  this: RDSProvider,
  logicalId: string,
  physicalId: string,
  plan: BackupReplicationPlan
): Promise<void> {
  if (!plan.stop && plan.start === undefined) return;
  // Bounded by the resource deadline, as `applyAssociatedRoles` is.
  const waitBudgetMs = Math.min(1_800_000, enclosingDeadlineRemainingMs() - 30_000);
  if (waitBudgetMs <= 0) {
    throw new Error(
      'the resource timeout leaves no more time to change the automated backup replication of the instance; re-run the deploy, or with a longer --resource-timeout'
    );
  }
  const doing = 'changing its automated backup replication';
  await this.waitForInstanceAvailable(logicalId, physicalId, waitBudgetMs, doing);
  const instance = await this.describeDBInstance(physicalId);
  const arn = instance?.DBInstanceArn;
  if (instance === undefined || arn === undefined) {
    throw new Error(
      'DescribeDBInstances returned no instance ARN while changing its automated backup replication; nothing was started or stopped'
    );
  }
  const wait = process.env['CDKD_NO_WAIT'] !== 'true';
  const live = liveBackupReplicationRegions(instance);
  for (const region of live) {
    this.logger.debug(safeMsg`Stopping automated backup replication of ${logicalId} to ${region}`);
    await sendInRegion(region, (client) =>
      client.send(
        new StopDBInstanceAutomatedBackupsReplicationCommand({ SourceDBInstanceArn: arn })
      )
    );
  }
  if (live.length > 0 && (wait || plan.start !== undefined)) {
    await this.waitForInstanceState(
      logicalId,
      physicalId,
      (current) =>
        current.DBInstanceStatus === 'available' &&
        liveBackupReplicationRegions(current).length === 0,
      'automated backup replication stop'
    );
  }
  const start = plan.start;
  if (start === undefined) return;
  this.logger.debug(
    safeMsg`Starting automated backup replication of ${logicalId} to ${start.region}`
  );
  try {
    await sendInRegion(start.region, (client) =>
      client.send(
        new StartDBInstanceAutomatedBackupsReplicationCommand({
          SourceDBInstanceArn: arn,
          ...(start.retention !== undefined && { BackupRetentionPeriod: start.retention }),
          ...(start.kmsKeyId !== undefined && { KmsKeyId: start.kmsKeyId }),
        })
      )
    );
  } catch (error) {
    // As CloudFormation's handler appends to this refusal.
    if (error instanceof Error && error.message.includes(REPLICATION_KMS_KEY_ERROR)) {
      error.message = `${error.message} Provide a valid value for the AutomaticBackupReplicationKmsKeyId property.`;
    }
    throw error;
  }
  if (wait) {
    await this.waitForInstanceState(
      logicalId,
      physicalId,
      (current) =>
        current.DBInstanceStatus === 'available' &&
        liveBackupReplicationRegions(current).includes(start.region),
      'automated backup replication start'
    );
  }
}

/**
 * go-to-k/cdkd#5640: the retention of an instance's replicated automated
 * backup, read in its destination region as CloudFormation's read handler
 * reads it (`describeAutomatedBackupsReplication`). `undefined` when RDS
 * lists no such backup there (the handler soft-fails that read); any other
 * failure propagates, since it says nothing about the retention.
 */
export async function replicatedBackupRetention(
  automatedBackupsArn: string
): Promise<number | undefined> {
  const region = automatedBackupsArn.split(':')[3];
  if (region === undefined || region === '') return undefined;
  try {
    const response = await sendInRegion(region, (client) =>
      client.send(
        new DescribeDBInstanceAutomatedBackupsCommand({
          DBInstanceAutomatedBackupsArn: automatedBackupsArn,
        })
      )
    );
    return response.DBInstanceAutomatedBackups?.[0]?.BackupRetentionPeriod;
  } catch (error) {
    // The SDK's class name, or the bare AWS code a non-modeled error keeps.
    const name = awsErrorName(error);
    if (
      name === 'DBInstanceAutomatedBackupNotFoundFault' ||
      name === 'DBInstanceAutomatedBackupNotFound'
    ) {
      return undefined;
    }
    throw error;
  }
}
