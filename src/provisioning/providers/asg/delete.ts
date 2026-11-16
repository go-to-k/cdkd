import type { ASGProvider } from '../asg-provider.js';
import {
  UpdateAutoScalingGroupCommand,
  DeleteAutoScalingGroupCommand,
  type DeletionProtection,
} from '@aws-sdk/client-auto-scaling';
import { DescribeInstancesCommand } from '@aws-sdk/client-ec2';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import { markNotGone } from '../../not-gone.js';
import { ProvisioningError } from '../../../utils/error-handler.js';
import { markNonRetryable } from '../../../deployment/retryable-errors.js';
import {
  enclosingDeadlineExpired,
  enclosingDeadlineRemainingMs,
} from '../../../deployment/resource-deadline.js';
import { assertRegionMatch, type DeleteContext } from '../../region-check.js';
import {
  disableInstanceApiTermination,
  observeThenDisableInstanceApiTermination,
  reEnableInstanceApiTermination,
} from '../../ec2-termination-protection.js';
import type { SecretMasker } from '../../../types/resource.js';
import {
  PROTECTION_FLIP_REUSE_WINDOW_MS,
  deleteWithProtectionCompensation,
  observeThenDisableProtection,
  protectionFlipKey,
  settleProtectionFlip,
  type ProtectionFlipRecord,
} from '../deletion-protection-compensation.js';
import { maskerOrIdentity, type MaskerFn } from '../../masked-retry-logger.js';
import {
  autoScalingGroupProtectionSite,
  LaunchedInstanceGoneError,
  GONE_INSTANCE_STATES,
  autoScalingGroupInstanceProtectionSite,
  EC2_INSTANCE_TYPE,
} from './shared.js';

/**
 * Delete an Auto Scaling group.
 *
 * The compensation boundary (issue #2204): a `--remove-protection` flip of
 * `DeletionProtection` to `none` whose delete then fails terminally is undone
 * here — back to the value the pre-flip readback saw — so a destroy that did
 * not happen does not leave a live group with its guard stripped.
 *
 * The same holds for each launched instance's `DisableApiTermination`, which
 * the flag also turns off (issue #796): each instance this run turned off is
 * turned back on against the same group delete failure, from its own record
 * (`settleInstanceFlips`).
 */
export async function deleteImpl(
  this: ASGProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  _properties?: Record<string, unknown>,
  context?: DeleteContext
): Promise<void> {
  // The record `run` was handed, so the re-enable and the site's commands
  // can read the value this record's flip removed.
  let current: ProtectionFlipRecord | undefined;
  const removedValue = (): string | undefined =>
    current ? this.removedProtection.get(current) : undefined;
  try {
    await this.deleteGroupUnderCompensation(
      logicalId,
      physicalId,
      resourceType,
      context,
      removedValue,
      (flip) => {
        current = flip;
      }
    );
  } catch (error) {
    if (current) {
      await this.settleInstanceFlips(
        logicalId,
        current,
        error,
        context?.expectedRegion,
        context?.maskSecrets
      );
    }
    throw error;
  }
  if (current) this.releaseInstanceFlips(current, context?.expectedRegion);
}

/**
 * Compensate every instance flip `groupFlip`'s attempts recorded, against
 * the group delete's `error` (issue #2204). Each instance is settled on its
 * own record: restored, released, or kept, by the same rules as the group's.
 *
 * Once AWS accepted `DeleteAutoScalingGroup(ForceDelete)` the instances are
 * being terminated with the group, so nothing is put back: the instance
 * record inherits the group's `deleteAccepted` latch.
 *
 * ONE residual, named because it is not reached here (the same shape as the
 * one `ProtectionCompensationOutcome` states): an instance DETACHED from the
 * group out of band between attempts. If the group is then gone, the delete
 * ends on the not-found path, where {@link releaseInstanceFlips} drops every
 * instance record WITHOUT restoring, so that live, detached instance keeps
 * its guard stripped. Restoring on that path would need a readback of each
 * instance (gone with the group, or detached and live?) on what is
 * otherwise a successful delete.
 */
export async function settleInstanceFlips(
  this: ASGProvider,
  logicalId: string,
  groupFlip: ProtectionFlipRecord,
  error: unknown,
  region: string | undefined,
  mask: MaskerFn | undefined
): Promise<void> {
  const instances = this.groupInstanceFlips.get(groupFlip);
  if (!instances) return;
  for (const [instanceId, flip] of instances) {
    if (groupFlip.deleteAccepted) flip.deleteAccepted = true;
    const released = await settleProtectionFlip({
      registry: this.instanceProtectionFlips,
      key: protectionFlipKey(EC2_INSTANCE_TYPE, instanceId, region),
      flip,
      error,
      compensation: {
        logicalId,
        physicalId: instanceId,
        logger: this.logger,
        mask,
        site: autoScalingGroupInstanceProtectionSite(instanceId, region),
        reEnable: () => this.reEnableLaunchedInstance(instanceId),
      },
    });
    // A released record is settled for good: forget it here too, or a later
    // delete reusing the group record (kept when the GROUP's re-enable
    // failed) would settle it again and re-write a guard already restored.
    if (released) instances.delete(instanceId);
  }
}

/**
 * Turn a group-launched instance's `DisableApiTermination` back on. When the
 * write fails, read the instance's state: one `shutting-down` or `terminated`
 * raises {@link LaunchedInstanceGoneError} (the compensation's "gone" arm);
 * anything else, the readback failing included, re-throws the write's own
 * error, keeping the loud "LIVE with its deletion protection still off" line.
 */
export async function reEnableLaunchedInstance(
  this: ASGProvider,
  instanceId: string
): Promise<void> {
  try {
    await reEnableInstanceApiTermination(this.getEc2Client(), instanceId);
  } catch (writeError) {
    let state: string | undefined;
    try {
      const response = await this.getEc2Client().send(
        new DescribeInstancesCommand({ InstanceIds: [instanceId] })
      );
      state = response.Reservations?.[0]?.Instances?.[0]?.State?.Name;
    } catch {
      // Unknown state: keep the write's own error.
    }
    if (state !== undefined && GONE_INSTANCE_STATES.has(state)) {
      throw new LaunchedInstanceGoneError(instanceId, state);
    }
    throw writeError;
  }
}

/**
 * The group is gone (deleted, or already absent): drop its instances'
 * records, restoring nothing. See {@link settleInstanceFlips} for the one
 * residual this leaves: an instance detached out of band between attempts.
 */
export function releaseInstanceFlips(
  this: ASGProvider,
  groupFlip: ProtectionFlipRecord,
  region: string | undefined
): void {
  for (const instanceId of this.groupInstanceFlips.get(groupFlip)?.keys() ?? []) {
    this.instanceProtectionFlips.release(protectionFlipKey(EC2_INSTANCE_TYPE, instanceId, region));
  }
  this.groupInstanceFlips.delete(groupFlip);
}

export async function deleteGroupUnderCompensation(
  this: ASGProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  context: DeleteContext | undefined,
  removedValue: () => string | undefined,
  onFlip: (flip: ProtectionFlipRecord) => void
): Promise<void> {
  await deleteWithProtectionCompensation({
    registry: this.protectionFlips,
    key: protectionFlipKey(resourceType, physicalId, context?.expectedRegion),
    run: (flip) => {
      onFlip(flip);
      return this.deleteOnce(logicalId, physicalId, resourceType, context, flip);
    },
    compensation: {
      logicalId,
      physicalId,
      logger: this.logger,
      mask: context?.maskSecrets,
      site: autoScalingGroupProtectionSite(physicalId, context?.expectedRegion, removedValue),
      reEnable: async () => {
        const value = removedValue();
        // Unreachable while the record is only ever set together with the
        // value (`deleteOnce`); throwing keeps the LOUD "could NOT
        // re-enable" line rather than guessing a level the user never had.
        if (value === undefined) {
          throw new Error('the DeletionProtection value removed by this run was not recorded');
        }
        // Never write a guard onto a group of the same name that is not the
        // stack's (replaced out of band between attempts, issue #6468): a
        // mismatch throws, and the compensation reports the guard unrestored.
        if (recordedGroupArn(context) !== undefined) {
          const live = await this.describeGroup(physicalId);
          if (live) assertRecordedGroup(live, context, logicalId, resourceType, physicalId);
        }
        await this.getClient().send(
          new UpdateAutoScalingGroupCommand({
            AutoScalingGroupName: physicalId,
            DeletionProtection: value as DeletionProtection,
          })
        );
      },
    },
  });
}

export async function deleteOnce(
  this: ASGProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  context: DeleteContext | undefined,
  flip: ProtectionFlipRecord
): Promise<void> {
  this.logger.debug(`Deleting AutoScalingGroup ${logicalId}: ${physicalId}`);

  // `--remove-protection`: clear DeletionProtection in-place before the
  // actual delete, then set ForceDelete=true so AWS terminates running
  // instances as part of the delete (matches the "I know what I'm doing"
  // intent of the flag). Without `removeProtection`, ForceDelete stays
  // false and AWS rejects the delete on a group with running instances
  // or DeletionProtection set, surfacing as ProvisioningError. The
  // flip-off is idempotent — AWS accepts UpdateAutoScalingGroup
  // (DeletionProtection: 'none') even when protection is already
  // disabled, so we always issue it under the flag. The pre-flip readback is
  // what lets a terminal failure restore ONLY a guard this run turned off,
  // and to the level it had: `prevent-force-deletion` and
  // `prevent-all-deletion` are both "on", and putting back the wrong one
  // would be a configuration change of cdkd's own.
  if (context?.removeProtection === true) {
    // Issue #6468: with a recorded ARN, the group is read and checked BEFORE
    // anything is lowered, outside the non-fatal flip below: a failed read
    // propagates (the attempt is retried), never falling back to by-name
    // writes. The same read serves the pre-flip readback, so it costs no call.
    let preRead: Awaited<ReturnType<ASGProvider['describeGroup']>> | 'unread' = 'unread';
    if (recordedGroupArn(context) !== undefined) {
      try {
        preRead = await this.describeGroup(physicalId);
      } catch (readError) {
        // Wrapped like the delete's own failures: AWS's text may quote the
        // group name, which can be a resolved secret.
        const cause = readError instanceof Error ? readError : undefined;
        throw this.wrapCaughtError(
          maskerOrIdentity(context.maskSecrets),
          readError,
          (text) =>
            new ProvisioningError(
              `Failed to delete AutoScalingGroup ${logicalId}: ${text}`,
              resourceType,
              logicalId,
              physicalId,
              cause
            )
        );
      }
      if (preRead) assertRecordedGroup(preRead, context, logicalId, resourceType, physicalId);
    }
    try {
      let observed: string | undefined;
      await observeThenDisableProtection({
        flip,
        logger: this.logger,
        physicalId,
        mask: context?.maskSecrets,
        guardName: 'DeletionProtection',
        observe: async () => {
          const group = preRead === 'unread' ? await this.describeGroup(physicalId) : preRead;
          const value = group?.DeletionProtection;
          observed = typeof value === 'string' && value !== 'none' ? value : undefined;
          return observed !== undefined;
        },
        disable: async () => {
          await this.getClient().send(
            new UpdateAutoScalingGroupCommand({
              AutoScalingGroupName: physicalId,
              DeletionProtection: 'none' as never,
            })
          );
        },
      });
      // Recorded only once AWS accepted the flip (a rejected one threw out of
      // `observeThenDisableProtection` above), and never CLEARED here: a
      // re-entered attempt observes `none` because the previous one turned it
      // off, so overwriting would lose the level the latch still owes.
      if (observed !== undefined) this.removedProtection.set(flip, observed);
      this.logger.debug(
        `Disabled DeletionProtection on AutoScalingGroup ${logicalId} before delete`
      );
    } catch (flipError) {
      // Non-fatal: log and proceed. The actual delete below surfaces
      // any real error.
      this.logger.debug(
        maskerOrIdentity(context?.maskSecrets)(
          `Could not disable DeletionProtection on ${physicalId}: ${describeAwsFailure(flipError).detail}`
        )
      );
    }

    // ASG-level DeletionProtection + ForceDelete only governs the GROUP and
    // its scale-in protection. If the group's launch template sets
    // EC2-level termination protection (DisableApiTermination), the
    // ForceDelete below still cannot terminate those instances and they
    // ORPHAN after the group is gone (issue #796). Enumerate the group's
    // current instances and flip each one's DisableApiTermination off first,
    // mirroring the EC2Provider `--remove-protection` path. Each flip is
    // recorded for the compensation in `delete()` (issue #2204).
    await this.removeInstanceTerminationProtectionForDelete(
      physicalId,
      logicalId,
      flip,
      context.expectedRegion
    );
  }

  try {
    // Issue #6468: a plain delete with a recorded ARN reads the group first
    // (one DescribeAutoScalingGroups); a record without one deletes by name,
    // as before. A group already gone falls through to the not-found path.
    if (context?.removeProtection !== true && recordedGroupArn(context) !== undefined) {
      const live = await this.describeGroup(physicalId);
      if (live) assertRecordedGroup(live, context, logicalId, resourceType, physicalId);
    }
    try {
      await this.getClient().send(
        new DeleteAutoScalingGroupCommand({
          AutoScalingGroupName: physicalId,
          ForceDelete: context?.removeProtection === true,
        })
      );
    } catch (refusal) {
      // Issue #6466: a plain delete of a group that still has instances is
      // refused by AWS. Like CloudFormation, scale it to 0, wait for the
      // instances to terminate, then delete it. The empty-group delete above
      // stays a single call: this runs only on AWS's refusal.
      if (context?.removeProtection === true || !isGroupNotEmptyRefusal(refusal)) throw refusal;
      await scaleInThenDelete(this, logicalId, physicalId, resourceType, context, refusal);
    }
    // AWS took the delete, so a throw from the wait below is a WAIT failing,
    // not the delete: the group is going and its guard must not be put back.
    flip.deleteAccepted = true;

    this.logger.debug(`Successfully initiated deletion of AutoScalingGroup ${logicalId}`);

    // Wait for the group to be fully gone. ASG delete is asynchronous —
    // returning immediately would leave dependent EC2 / IAM / SG
    // resources blocked on the lingering group.
    await this.waitForGroupDeleted(physicalId);
  } catch (error) {
    // The scale-in and identity refusals are already worded and terminal.
    if (error instanceof ScaleInRefusal) throw error;
    if (this.isNotFoundError(error)) {
      const clientRegion = await this.getClient().config.region();
      assertRegionMatch(clientRegion, context?.expectedRegion, resourceType, logicalId, physicalId);
      this.logger.debug(`AutoScalingGroup ${physicalId} does not exist, skipping deletion`);
      return;
    }
    const cause = error instanceof Error ? error : undefined;
    const thrown = this.wrapCaughtError(
      maskerOrIdentity(context?.maskSecrets),
      error,
      (text) =>
        new ProvisioningError(
          `Failed to delete AutoScalingGroup ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          physicalId,
          cause
        )
    );
    // The wrap names an AWS failure by its CLASS, and the delete classifiers
    // read `NotFoundException` in a message as "already deleted": only the
    // not-found check above means this group is gone (go-to-k/cdkd#2319).
    throw error instanceof Error && error.name.includes('NotFound') ? markNotGone(thrown) : thrown;
  }
}

/**
 * Flip EC2-level termination protection (`DisableApiTermination`) off on
 * every instance currently launched by the group, so the subsequent
 * `DeleteAutoScalingGroup(ForceDelete: true)` can actually terminate them
 * instead of orphaning the protected instances (issue #796). Best-effort:
 * a Describe failure or a per-instance flip failure is logged at debug and
 * does not block the delete (the modify WRITE lags the terminate READ, so
 * the shared helper swallows propagation errors the same way the EC2 path
 * does — the orphan, if any, surfaces as a leftover instance the caller
 * can clean up rather than a hard delete failure).
 *
 * This is the create path's retire of a group cdkd itself just created, so
 * nothing is recorded for compensation; the `--remove-protection` delete
 * uses {@link removeInstanceTerminationProtectionForDelete}.
 */
export async function removeInstanceTerminationProtection(
  this: ASGProvider,
  groupName: string,
  logicalId: string,
  // AWS's describe error can echo the group name, which may be a resolved
  // secret on the create path.
  maskSecrets: SecretMasker,
  // Instances already flipped by an earlier pass of the same retire.
  alreadyFlipped: Set<string>
): Promise<void> {
  const instanceIds = (await this.listGroupInstanceIds(groupName, logicalId, maskSecrets))?.filter(
    (id) => !alreadyFlipped.has(id)
  );
  if (!instanceIds || instanceIds.length === 0) return;

  this.logger.debug(
    `Disabling EC2 termination protection on ${instanceIds.length} instance(s) of AutoScalingGroup ${logicalId} before force delete`
  );
  for (const instanceId of instanceIds) {
    // Only an ACCEPTED flip is recorded, so a later pass retries a failed one.
    if (await disableInstanceApiTermination(this.getEc2Client(), instanceId, this.logger)) {
      alreadyFlipped.add(instanceId);
    }
  }
}

/**
 * The `--remove-protection` delete's instance flip (issue #796), recorded
 * for compensation (issue #2204): each instance's `DisableApiTermination` is
 * read first and turned off, and its own flip record latches only when the
 * read saw it ON and EC2 accepted the flip. The record is acquired from the
 * per-instance registry, so a re-entered attempt that reads the guard OFF
 * (because the earlier attempt turned it off) keeps what that attempt
 * recorded, and is remembered on `groupFlip` for `delete()` to settle.
 *
 * Best-effort exactly like the unrecorded path: a describe failure or a
 * refused flip is logged at debug and the delete proceeds.
 */
export async function removeInstanceTerminationProtectionForDelete(
  this: ASGProvider,
  groupName: string,
  logicalId: string,
  groupFlip: ProtectionFlipRecord,
  region: string | undefined
): Promise<void> {
  const instanceIds = await this.listGroupInstanceIds(groupName, logicalId, (text) => text);
  if (!instanceIds || instanceIds.length === 0) return;

  let flips = this.groupInstanceFlips.get(groupFlip);
  if (!flips) {
    flips = new Map();
    this.groupInstanceFlips.set(groupFlip, flips);
  }
  this.logger.debug(
    `Disabling EC2 termination protection on ${instanceIds.length} instance(s) of AutoScalingGroup ${logicalId} before force delete`
  );
  for (const instanceId of instanceIds) {
    const flip = this.instanceProtectionFlips.acquire(
      protectionFlipKey(EC2_INSTANCE_TYPE, instanceId, region),
      PROTECTION_FLIP_REUSE_WINDOW_MS
    );
    flips.set(instanceId, flip);
    await observeThenDisableInstanceApiTermination(
      this.getEc2Client(),
      instanceId,
      flip,
      this.logger
    );
  }
}

/**
 * The ids of the instances the group currently holds, or `undefined` when
 * the describe failed (logged at debug: the caller proceeds without them).
 */
export async function listGroupInstanceIds(
  this: ASGProvider,
  groupName: string,
  logicalId: string,
  maskSecrets: SecretMasker
): Promise<string[] | undefined> {
  try {
    const group = await this.describeGroup(groupName);
    return (group?.Instances ?? [])
      .map((i) => i.InstanceId)
      .filter((id): id is string => typeof id === 'string' && id.length > 0);
  } catch (describeError) {
    this.logger.debug(
      maskSecrets(
        `Could not enumerate instances of AutoScalingGroup ${logicalId} for termination-protection removal: ${describeAwsFailure(describeError).detail}`
      )
    );
    return undefined;
  }
}

export async function waitForGroupDeleted(
  this: ASGProvider,
  groupName: string,
  maxWaitMs = 900_000
): Promise<void> {
  const startTime = Date.now();
  let delay = 5_000;

  while (Date.now() - startTime < maxWaitMs) {
    try {
      const group = await this.describeGroup(groupName);
      if (!group) return;
    } catch (error) {
      if (this.isNotFoundError(error)) return;
      throw error;
    }

    await this.sleep(delay);
    delay = Math.min(delay * 2, 10_000);
  }

  throw new Error(
    `Timed out waiting for AutoScalingGroup ${groupName} to be deleted (15 minute cap)`
  );
}

/**
 * The names AWS gives a plain (non-force) `DeleteAutoScalingGroup` refused
 * because the group is not empty: `ResourceInUse` ("instances or pending Spot
 * instance request(s) still in the group") and `ScalingActivityInProgress`.
 * The SDK class names carry a `Fault` suffix; both spellings are matched.
 */
const GROUP_NOT_EMPTY_ERROR_NAMES = new Set([
  'ResourceInUse',
  'ResourceInUseFault',
  'ScalingActivityInProgress',
  'ScalingActivityInProgressFault',
]);

export function isGroupNotEmptyRefusal(error: unknown): boolean {
  return error instanceof Error && GROUP_NOT_EMPTY_ERROR_NAMES.has(error.name);
}

/**
 * A worded, terminal refusal of an Auto Scaling group delete: the scale-in
 * path's refusals and timeouts (issue #6466), and the recorded-ARN identity
 * check on every delete path (issue #6468). Terminal, since a retry would only
 * wait again on the same cause. Its text interpolates the template logical
 * id, instance ids and capacities only.
 */
export class ScaleInRefusal extends ProvisioningError {
  constructor(
    message: string,
    resourceType: string,
    logicalId: string,
    physicalId: string,
    cause?: Error
  ) {
    super(message, resourceType, logicalId, physicalId, cause);
    this.name = 'ScaleInRefusal';
    Object.setPrototypeOf(this, ScaleInRefusal.prototype);
    markNonRetryable(this);
  }
}

/** Budget for the instances to terminate after the scale to 0. */
export const SCALE_IN_WAIT_MS = 900_000;

type GroupInstance = {
  InstanceId?: string | undefined;
  LifecycleState?: string | undefined;
  ProtectedFromScaleIn?: boolean | undefined;
};

/**
 * The instances a scale to 0 will never terminate: one protected from scale
 * in, one in `Standby` (not counted in the desired capacity), and one
 * `Terminating:Retained` (held by the group's instance lifecycle policy until
 * someone terminates it). An instance already terminating or leaving the group
 * (`Detaching`) is not one, whatever its protection.
 */
export function instancesScaleInCannotTerminate(
  instances: readonly GroupInstance[]
): GroupInstance[] {
  return instances.filter((instance) => {
    const state = instance.LifecycleState ?? '';
    if (state === 'Terminating:Retained') return true;
    if (state.startsWith('Terminat') || state.startsWith('Detach')) return false;
    return (
      instance.ProtectedFromScaleIn === true || state === 'Standby' || state === 'EnteringStandby'
    );
  });
}

/** What the stuck-instances refusals tell the user to do. */
const STUCK_REMEDY =
  'Turn their scale-in protection off (SetInstanceProtection), take them out of Standby, or terminate a retained one (TerminateInstanceInAutoScalingGroup), then re-run.';

/**
 * The group's ARN cdkd recorded at create (`Arn`, and `AutoScalingGroupARN`
 * from an import), or `undefined` for a record without one.
 */
function recordedGroupArn(context: DeleteContext | undefined): string | undefined {
  const recorded = context?.recordedAttributes;
  const value = recorded?.['Arn'] ?? recorded?.['AutoScalingGroupARN'];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Refuse a live group of the record's name that is not the one the record
 * created (issue #6468, `.claude/rules/provider-delete-path.md`): deleted and
 * re-created out of band, or found by a client in another region. The ARN
 * carries the group's UUID and region. A record without an ARN, or a group
 * read without one, keeps the by-name delete. Neither ARN is printed (it
 * embeds the group name, which may be a resolved secret), and no
 * `--remove-protection` remedy is offered: ForceDelete would delete it too.
 */
export function assertRecordedGroup(
  group: { AutoScalingGroupARN?: string | undefined },
  context: DeleteContext | undefined,
  logicalId: string,
  resourceType: string,
  physicalId: string,
  cause?: Error
): void {
  const recordedArn = recordedGroupArn(context);
  if (
    recordedArn === undefined ||
    typeof group.AutoScalingGroupARN !== 'string' ||
    group.AutoScalingGroupARN === recordedArn
  ) {
    return;
  }
  throw new ScaleInRefusal(
    `Cannot delete AutoScalingGroup ${logicalId}: the live group of that name is not the one cdkd created (its ARN differs from the recorded one), so cdkd leaves it alone. Check which group the stack owns before deleting anything by hand.`,
    resourceType,
    logicalId,
    physicalId,
    cause
  );
}

function capacityOf(group: {
  MinSize?: number | undefined;
  MaxSize?: number | undefined;
  DesiredCapacity?: number | undefined;
}): string {
  return `MinSize ${group.MinSize ?? '?'} / MaxSize ${group.MaxSize ?? '?'} / DesiredCapacity ${group.DesiredCapacity ?? '?'}`;
}

function describeInstances(instances: readonly GroupInstance[]): string {
  return instances
    .map((i) => `${i.InstanceId ?? '<unknown>'} (${i.LifecycleState ?? 'unknown state'})`)
    .join(', ');
}

/**
 * The remedy every scale-in refusal ends with. `--remove-protection` exists on
 * `cdkd destroy` / `cdkd state destroy` only, so it is offered only there.
 */
function forceDeleteRemedy(context: DeleteContext | undefined): string {
  return context?.stackDestroy === true
    ? ' Or re-run the destroy with --remove-protection, which deletes the group with ForceDelete and terminates its instances.'
    : '';
}

/**
 * Empty a group AWS refused to delete because it still has instances, then
 * delete it (issue #6466). CloudFormation's delete of the same group scales it
 * to 0 and waits for the instances to terminate, so termination lifecycle
 * hooks run; ForceDelete would skip them, and stays behind
 * `--remove-protection`.
 *
 * Nothing is scaled when the scale-in could not finish:
 * - the live group's ARN differs from the recorded one: another group of the
 *   same name (or region), never this record's (issue #4157's rule);
 * - the group's `DeletionProtection` is `prevent-force-deletion` or
 *   `prevent-all-deletion`: AWS's own refusal is re-thrown, as before;
 *   emptying the group would get round a guard whose point is to stop mass
 *   termination;
 * - an instance is protected from scale in, in `Standby` or retained: refused, naming
 *   the instances (CloudFormation waits on such a group until its stack
 *   operation times out);
 * - the group has a warm pool not being deleted: refused (a plain delete
 *   cannot remove it).
 *
 * Returns once AWS accepted the delete (or the group is already gone); the
 * caller then waits for the group to be gone.
 */
export async function scaleInThenDelete(
  provider: ASGProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  context: DeleteContext | undefined,
  refusal: unknown
): Promise<void> {
  const mask = maskerOrIdentity(context?.maskSecrets);
  // Every refusal here answers AWS's not-empty refusal of the plain delete
  // (or a later AWS error), which it carries as its cause.
  const refusalCause = refusal instanceof Error ? refusal : undefined;
  // Message builders only: each site constructs its own ScaleInRefusal, so
  // the secret-mask critic sees every error construction.
  // The capacity this run scaled the group down from, once it has: a refusal
  // after that leaves the group at 0 (cdkd does not restore it), so it says
  // what to put back. A deploy's state still records the old capacity.
  let scaledFrom: string | undefined;
  const refusalText = (text: string): string =>
    mask(
      `Cannot delete AutoScalingGroup ${logicalId}: ${text}${
        scaledFrom === undefined
          ? ''
          : ` The group stays at capacity 0; before cdkd scaled it in it had ${scaledFrom}. Set that back (UpdateAutoScalingGroup) if the group is to keep running.`
      }${forceDeleteRemedy(context)}`
    );
  const deadlineText = (scaled: boolean): string =>
    refusalText(
      scaled
        ? 'the per-resource timeout (--resource-timeout) ran out while its instances drained after scaling it to 0, so cdkd sent no delete. Re-run once they have terminated.'
        : 'the per-resource timeout (--resource-timeout) ran out before cdkd could scale it to 0; nothing was changed. Re-run the delete.'
    );

  const group = await provider.describeGroup(physicalId);
  // AWS refused the delete because the group held instances, so it exists in
  // this region: an empty describe now means it went in the meantime.
  if (!group) return;
  // Re-checked here: time has passed since the delete was refused.
  assertRecordedGroup(group, context, logicalId, resourceType, physicalId, refusalCause);
  const protection = group.DeletionProtection;
  if (typeof protection === 'string' && protection !== 'none') throw refusal;
  const stuck = instancesScaleInCannotTerminate(group.Instances ?? []);
  if (stuck.length > 0) {
    throw new ScaleInRefusal(
      refusalText(
        `scaling it to 0 cannot terminate ${stuck.length} instance(s) protected from scale in, in Standby or retained: ${describeInstances(stuck)}. ${STUCK_REMEDY}`
      ),
      resourceType,
      logicalId,
      physicalId,
      refusalCause
    );
  }
  const warmPool = group.WarmPoolConfiguration;
  if (warmPool && warmPool.Status !== 'PendingDelete') {
    throw new ScaleInRefusal(
      refusalText(
        'it has a warm pool, which a delete without ForceDelete cannot remove. Delete the warm pool (DeleteWarmPool), then re-run.'
      ),
      resourceType,
      logicalId,
      physicalId,
      refusalCause
    );
  }

  // The per-resource deadline does not cancel this call, so the wait never
  // outlives it, and no irreversible step starts once it has expired.
  const budgetMs = Math.min(SCALE_IN_WAIT_MS, enclosingDeadlineRemainingMs());
  const startTime = Date.now();
  const withinBudget = (): boolean =>
    Date.now() - startTime < budgetMs && !enclosingDeadlineExpired();
  let delay = 5_000;
  const pause = async (): Promise<void> => {
    await provider.sleep(delay);
    delay = Math.min(delay * 2, 15_000);
  };

  if (group.MinSize !== 0 || group.MaxSize !== 0 || group.DesiredCapacity !== 0) {
    const draining = (group.Instances ?? []).filter(
      (i) => !(i.LifecycleState ?? '').startsWith('Terminat')
    ).length;
    provider.logger.info(
      mask(
        `Scaling AutoScalingGroup ${logicalId} to 0 and waiting for its ${draining} instance(s) to terminate before deleting it`
      )
    );
    // MaxSize too, so a scaling policy or scheduled action cannot launch
    // again while the instances drain (the console's delete does the same).
    // AWS refuses the update with ScalingActivityInProgress while a launch is
    // still running: retried within the budget.
    for (;;) {
      if (enclosingDeadlineExpired()) {
        throw new ScaleInRefusal(
          deadlineText(false),
          resourceType,
          logicalId,
          physicalId,
          refusalCause
        );
      }
      try {
        await provider.getClient().send(
          new UpdateAutoScalingGroupCommand({
            AutoScalingGroupName: physicalId,
            MinSize: 0,
            MaxSize: 0,
            DesiredCapacity: 0,
          })
        );
        scaledFrom = capacityOf(group);
        break;
      } catch (error) {
        if (!isGroupNotEmptyRefusal(error)) throw error;
        if (enclosingDeadlineExpired()) {
          const cause = error instanceof Error ? error : undefined;
          throw new ScaleInRefusal(deadlineText(false), resourceType, logicalId, physicalId, cause);
        }
        if (!withinBudget()) throw error;
        await pause();
      }
    }
  }

  let remaining: GroupInstance[] = group.Instances ?? [];
  let raisedPolls = 0;
  while (withinBudget()) {
    await pause();
    const current = await provider.describeGroup(physicalId);
    if (!current) return;
    // Raised out of band (a scheduled action, another tool): waiting would
    // only watch it launch again.
    // Seen on two polls in a row: one read can still lag the update.
    const raised = current.MinSize !== 0 || current.MaxSize !== 0 || current.DesiredCapacity !== 0;
    raisedPolls = raised ? raisedPolls + 1 : 0;
    if (raisedPolls >= 2) {
      throw new ScaleInRefusal(
        refusalText(
          `its capacity was raised again to ${capacityOf(current)} while it drained after scaling it to 0. Stop whatever raises it (a scheduled action, another tool), then re-run.`
        ),
        resourceType,
        logicalId,
        physicalId,
        refusalCause
      );
    }
    remaining = current.Instances ?? [];
    if (remaining.length > 0) {
      // Protection turned on while the group drains would hold it forever.
      const nowStuck = instancesScaleInCannotTerminate(remaining);
      if (nowStuck.length === remaining.length) {
        throw new ScaleInRefusal(
          refusalText(
            `after scaling it to 0, ${nowStuck.length} instance(s) are protected from scale in, in Standby or retained: ${describeInstances(nowStuck)}. ${STUCK_REMEDY}`
          ),
          resourceType,
          logicalId,
          physicalId,
          refusalCause
        );
      }
      continue;
    }
    if (enclosingDeadlineExpired()) break;
    try {
      await provider.getClient().send(
        new DeleteAutoScalingGroupCommand({
          AutoScalingGroupName: physicalId,
          ForceDelete: false,
        })
      );
      return;
    } catch (error) {
      // Pending Spot requests and the scaling activity itself still refuse
      // the delete for a moment after the last instance leaves.
      if (!isGroupNotEmptyRefusal(error)) throw error;
    }
  }
  if (enclosingDeadlineExpired()) {
    throw new ScaleInRefusal(deadlineText(true), resourceType, logicalId, physicalId, refusalCause);
  }
  const minutes = Math.max(1, Math.round(budgetMs / 60_000));
  throw new ScaleInRefusal(
    refusalText(
      remaining.length > 0
        ? `its instances did not terminate within ${minutes} minutes of scaling it to 0; still in the group: ${describeInstances(remaining)}. A termination lifecycle hook holds an instance until the hook is completed or times out; complete it, then re-run.`
        : `AWS still refused the delete ${minutes} minutes after scaling it to 0 (a scaling activity or a pending Spot request). Re-run once the group's activity has finished.`
    ),
    resourceType,
    logicalId,
    physicalId,
    refusalCause
  );
}
