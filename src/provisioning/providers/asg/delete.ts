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
    try {
      let observed: string | undefined;
      await observeThenDisableProtection({
        flip,
        logger: this.logger,
        physicalId,
        mask: context?.maskSecrets,
        guardName: 'DeletionProtection',
        observe: async () => {
          const group = await this.describeGroup(physicalId);
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
    await this.getClient().send(
      new DeleteAutoScalingGroupCommand({
        AutoScalingGroupName: physicalId,
        ForceDelete: context?.removeProtection === true,
      })
    );
    // AWS took the delete, so a throw from the wait below is a WAIT failing,
    // not the delete: the group is going and its guard must not be put back.
    flip.deleteAccepted = true;

    this.logger.debug(`Successfully initiated deletion of AutoScalingGroup ${logicalId}`);

    // Wait for the group to be fully gone. ASG delete is asynchronous —
    // returning immediately would leave dependent EC2 / IAM / SG
    // resources blocked on the lingering group.
    await this.waitForGroupDeleted(physicalId);
  } catch (error) {
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
