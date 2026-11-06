import {
  DescribeSecurityGroupsCommand,
  TerminateInstancesCommand,
  DescribeInstancesCommand,
  AssociateIamInstanceProfileCommand,
  DescribeIamInstanceProfileAssociationsCommand,
  waitUntilInstanceTerminated,
  DescribeVolumesCommand,
  type InstanceMetadataOptionsRequest,
  AttachVolumeCommand,
  DetachVolumeCommand,
  ReplaceIamInstanceProfileAssociationCommand,
  DisassociateIamInstanceProfileCommand,
} from '@aws-sdk/client-ec2';
import { enclosingDeadlineRemainingMs } from '../../../deployment/resource-deadline.js';
import { canonicalizeRegion } from '../../../utils/aws-partition.js';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import { ProvisioningError } from '../../../utils/error-handler.js';
import { assertRegionMatch, type DeleteContext } from '../../region-check.js';
import {
  ec2InstanceProtectionSite,
  isTerminationProtectionPropagationError,
  observeThenDisableInstanceApiTermination,
  reDisableInstanceApiTermination,
  reEnableInstanceApiTermination,
  TERMINATION_PROTECTION_MAX_ATTEMPTS,
} from '../../ec2-termination-protection.js';
import {
  deleteWithProtectionCompensation,
  protectionFlipKey,
  type ProtectionFlipRecord,
} from '../deletion-protection-compensation.js';
import { maskerOrIdentity } from '../../masked-retry-logger.js';
import { safeMsg } from '../../../utils/display-safe.js';
import { markNonRetryable } from '../../../deployment/retryable-errors.js';
import { startInterruptWatch } from '../../interrupt-watch.js';
import { INSTANCE_NOT_FOUND_NAMES, isNamedError } from './common.js';
import {
  INSTANCE_STATE_POLL_MS,
  INSTANCE_STATE_WAIT_CAP_MS,
  type InstanceMemberPlan,
  type InstanceVolume,
  PROFILE_DISASSOCIATING_DELAY_MS,
  PROFILE_DISASSOCIATING_POLLS,
  VOLUME_ATTACHMENT_NONE_READS,
  VOLUME_ATTACHMENT_POLL_MS,
  VOLUME_ATTACHMENT_WAIT_CAP_MS,
  VOLUME_NOT_FOUND_NAMES,
  instanceSsmAssociationEntries,
  instanceSsmAssociationsRefusal,
  refusedBeforeApplying,
  staleSsmAssociationRemedy,
} from './instance-support.js';
import type { EC2Provider } from '../ec2-provider.js';

/**
 * go-to-k/cdkd#5630: the state of `volumeId`'s attachment to `instanceId`
 * at `device` (`attaching`, `attached`, `detaching`), `'none'` when the
 * volume has no such attachment, or `'gone'` when EC2 no longer lists it.
 */
export async function readVolumeAttachment(
  this: EC2Provider,
  instanceId: string,
  volume: InstanceVolume,
  anyDevice = false
): Promise<string> {
  let resp;
  try {
    resp = await this.ec2Client.send(new DescribeVolumesCommand({ VolumeIds: [volume.VolumeId] }));
  } catch (error) {
    if (isNamedError(error, VOLUME_NOT_FOUND_NAMES)) return 'gone';
    throw error;
  }
  const found = resp.Volumes?.find((v) => v.VolumeId === volume.VolumeId);
  if (found === undefined) return 'gone';
  const attachment = (found.Attachments ?? []).find(
    (a) => a.InstanceId === instanceId && (anyDevice || a.Device === volume.Device)
  );
  return attachment?.State ?? 'none';
}

/**
 * go-to-k/cdkd#5630: attach one `Volumes` entry and wait for it to read
 * `attached`. A refused AttachVolume whose volume already sits on this
 * instance at this device (a retried attempt, a record that lacked the
 * entry) is that attachment, not a failure.
 */
export async function attachInstanceVolume(
  this: EC2Provider,
  logicalId: string,
  instanceId: string,
  resourceType: string,
  volume: InstanceVolume,
  onAccepted?: () => void
): Promise<void> {
  try {
    await this.ec2Client.send(
      new AttachVolumeCommand({
        InstanceId: instanceId,
        VolumeId: volume.VolumeId,
        Device: volume.Device,
      })
    );
  } catch (error) {
    const state = await this.readVolumeAttachment(instanceId, volume).catch(() => 'none');
    if (state !== 'attaching' && state !== 'attached') {
      // Only a 4xx answer to the FIRST attempt proves the attach did not
      // happen. Anything else (a timeout, a reset, a 5xx) may have attached
      // the volume with the read lagging, and AttachVolume takes no client
      // token, so a 4xx from an SDK retry can answer an earlier attempt
      // that attached it: all of those count as accepted.
      const meta = (
        error as { $metadata?: { httpStatusCode?: unknown; attempts?: unknown } } | null
      )?.$metadata;
      const status = meta?.httpStatusCode;
      const retried = typeof meta?.attempts === 'number' && meta.attempts > 1;
      if (retried || !(typeof status === 'number' && status >= 400 && status < 500)) {
        onAccepted?.();
      }
      throw error;
    }
  }
  onAccepted?.();
  await this.waitForVolumeAttachment(logicalId, instanceId, resourceType, volume, 'attached');
}

/**
 * go-to-k/cdkd#5630: detach one `Volumes` entry and wait until the
 * attachment is gone. A volume no longer attached here (or deleted) is
 * already detached.
 */
export async function detachInstanceVolume(
  this: EC2Provider,
  logicalId: string,
  instanceId: string,
  resourceType: string,
  volume: InstanceVolume
): Promise<void> {
  try {
    // No Device: a record whose Device went stale (the volume moved out of
    // band) still detaches the volume from this instance, so the update
    // converges on the declared device.
    await this.ec2Client.send(
      new DetachVolumeCommand({ InstanceId: instanceId, VolumeId: volume.VolumeId })
    );
  } catch (error) {
    // Any device, like the call: a refused detach whose volume is still on
    // this instance, at whatever device, did not happen.
    const state = await this.readVolumeAttachment(instanceId, volume, true).catch(() => 'attached');
    if (state !== 'none' && state !== 'gone' && state !== 'detaching') throw error;
  }
  await this.waitForVolumeAttachment(logicalId, instanceId, resourceType, volume, 'detached');
}

/**
 * go-to-k/cdkd#5630: poll DescribeVolumes until the attachment reads
 * `attached`, or has gone (`detached`). Ctrl-C ends the wait with an
 * `InterruptedWaitError`; the resource deadline, or
 * {@link VOLUME_ATTACHMENT_WAIT_CAP_MS} outside one, ends it non-retryably.
 */
export async function waitForVolumeAttachment(
  this: EC2Provider,
  logicalId: string,
  instanceId: string,
  resourceType: string,
  volume: InstanceVolume,
  target: 'attached' | 'detached'
): Promise<void> {
  const watch = startInterruptWatch(`EC2 Instance ${logicalId} volume ${target} wait`);
  const capAt = Date.now() + VOLUME_ATTACHMENT_WAIT_CAP_MS;
  let last: string | undefined;
  let noneReads = 0;
  try {
    for (;;) {
      if (watch.isInterrupted()) throw watch.onInterrupted();
      const remaining = Math.min(enclosingDeadlineRemainingMs(), capAt - Date.now());
      if (remaining <= 0) {
        throw markNonRetryable(
          new ProvisioningError(
            `${logicalId} (${resourceType}): timed out waiting for volume ${volume.VolumeId} to be ${target} at ${volume.Device} on instance ${instanceId} (last attachment state: ${last ?? 'none reported'})`,
            resourceType,
            logicalId,
            instanceId
          )
        );
      }
      last = await this.readVolumeAttachment(instanceId, volume, target === 'detached');
      if (target === 'attached' && last === 'attached') return;
      if (target === 'detached' && (last === 'none' || last === 'gone')) return;
      // A read right after AttachVolume can lag it, so only a `none` that
      // persists means the attachment did not happen.
      noneReads = last === 'none' ? noneReads + 1 : 0;
      if (target === 'attached' && (last === 'gone' || noneReads >= VOLUME_ATTACHMENT_NONE_READS)) {
        throw markNonRetryable(
          new ProvisioningError(
            `${logicalId} (${resourceType}): volume ${volume.VolumeId} is ${last === 'gone' ? 'no longer returned by DescribeVolumes' : `not attached at ${volume.Device}`} while cdkd waited for it to attach to instance ${instanceId}`,
            resourceType,
            logicalId,
            instanceId
          )
        );
      }
      if (watch.isInterrupted()) throw watch.onInterrupted();
      await this.sleep(
        Math.max(0, Math.min(VOLUME_ATTACHMENT_POLL_MS, enclosingDeadlineRemainingMs()))
      );
    }
  } finally {
    watch.dispose();
  }
}

/**
 * go-to-k/cdkd#5630: after a failed create terminated `instanceId`, poll
 * until it reads `terminated` (or is no longer listed). It never throws: it
 * runs inside the wiring cleanup, which re-throws the create's own error.
 * It answers why it stopped early: the resource deadline or
 * {@link INSTANCE_STATE_WAIT_CAP_MS}, a Ctrl-C (the latch stays set for the
 * next wait), or a read that failed.
 */
export async function waitForFailedLaunchTerminated(
  this: EC2Provider,
  logicalId: string,
  instanceId: string
): Promise<string> {
  const watch = startInterruptWatch(`EC2 Instance ${logicalId} termination wait`);
  const capAt = Date.now() + INSTANCE_STATE_WAIT_CAP_MS;
  try {
    for (;;) {
      if (watch.isInterrupted()) return 'interrupted';
      if (Math.min(enclosingDeadlineRemainingMs(), capAt - Date.now()) <= 0) {
        return 'timed out';
      }
      let state: string | undefined;
      try {
        state = await this.readInstanceState(instanceId);
      } catch (error) {
        if (isNamedError(error, INSTANCE_NOT_FOUND_NAMES)) return 'terminated';
        return `read failed: ${describeAwsFailure(error).detail}`;
      }
      if (state === 'terminated' || state === undefined) return 'terminated';
      if (watch.isInterrupted()) return 'interrupted';
      await this.sleep(
        Math.max(0, Math.min(INSTANCE_STATE_POLL_MS, enclosingDeadlineRemainingMs()))
      );
    }
  } finally {
    watch.dispose();
  }
}

/** The `default` security group of the instance's VPC (a removed `SecurityGroupIds`). */
export async function vpcDefaultSecurityGroupId(
  this: EC2Provider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  vpcId: string | undefined
): Promise<string> {
  const groups =
    vpcId === undefined
      ? undefined
      : await this.ec2Client.send(
          new DescribeSecurityGroupsCommand({
            Filters: [
              { Name: 'vpc-id', Values: [vpcId] },
              { Name: 'group-name', Values: ['default'] },
            ],
          })
        );
  const id = groups?.SecurityGroups?.[0]?.GroupId;
  if (id === undefined) {
    throw refusedBeforeApplying(
      new ProvisioningError(
        `${logicalId} (${resourceType}): SecurityGroupIds was removed, and the default security group of instance ${physicalId}'s VPC (${vpcId ?? 'unknown'}) could not be found to put in its place. The instance was not updated.`,
        resourceType,
        logicalId,
        physicalId
      )
    );
  }
  return id;
}

/**
 * Associate, replace or disassociate the instance's IAM instance profile
 * (issue #5446). A profile created in the same deploy can still be
 * propagating, so the associate / replace call retries through the same
 * signals {@link ensureIamInstanceProfileAssociated} does.
 */
export async function applyInstanceProfileChange(
  this: EC2Provider,
  logicalId: string,
  physicalId: string,
  change: NonNullable<InstanceMemberPlan['profile']>
): Promise<void> {
  // An association still `disassociating` (a removal moments ago) makes a
  // new associate fail with IncorrectState; let it finish first.
  let assoc = await this.ec2Client.send(
    new DescribeIamInstanceProfileAssociationsCommand({
      Filters: [{ Name: 'instance-id', Values: [physicalId] }],
    })
  );
  for (
    let poll = 1;
    poll <= PROFILE_DISASSOCIATING_POLLS &&
    (assoc.IamInstanceProfileAssociations ?? []).some((a) => a.State === 'disassociating');
    poll++
  ) {
    await this.sleep(PROFILE_DISASSOCIATING_DELAY_MS);
    assoc = await this.ec2Client.send(
      new DescribeIamInstanceProfileAssociationsCommand({
        Filters: [{ Name: 'instance-id', Values: [physicalId] }],
      })
    );
  }
  const current = assoc.IamInstanceProfileAssociations?.find(
    (a) => a.State === 'associated' || a.State === 'associating'
  );
  if (change.kind === 'remove') {
    if (current?.AssociationId === undefined) return;
    await this.ec2Client.send(
      new DisassociateIamInstanceProfileCommand({ AssociationId: current.AssociationId })
    );
    return;
  }
  const spec = change.arn !== undefined ? { Arn: change.arn } : { Name: change.name };
  const maxAttempts = 10;
  for (let attempt = 1; ; attempt++) {
    try {
      if (current?.AssociationId !== undefined) {
        await this.ec2Client.send(
          new ReplaceIamInstanceProfileAssociationCommand({
            AssociationId: current.AssociationId,
            IamInstanceProfile: spec,
          })
        );
      } else {
        await this.ec2Client.send(
          new AssociateIamInstanceProfileCommand({
            InstanceId: physicalId,
            IamInstanceProfile: spec,
          })
        );
      }
      return;
    } catch (error) {
      const msg = describeAwsFailure(error).detail;
      if (this.isInstanceProfilePropagationError(msg) && attempt < maxAttempts) {
        this.logger.debug(
          safeMsg`IAM instance profile not yet propagated for ${logicalId} (${physicalId}) (attempt ${attempt}/${maxAttempts}: ${msg}), retrying in ${attempt}s...`
        );
        await this.sleep(attempt * 1000);
        continue;
      }
      throw error;
    }
  }
}

/**
 * Shallow value-equality for the small flat MetadataOptions request shape.
 * Treats `undefined` and an absent object as equal so the no-drift
 * round-trip produces zero modify calls.
 */
export function shallowEqual(
  this: EC2Provider,
  a: InstanceMetadataOptionsRequest,
  b: InstanceMetadataOptionsRequest | undefined
): boolean {
  if (b === undefined) return false;
  const ra = a as Record<string, unknown>;
  const rb = b as Record<string, unknown>;
  const keysA = Object.keys(ra);
  const keysB = Object.keys(rb);
  if (keysA.length !== keysB.length) return false;
  return keysA.every((k) => ra[k] === rb[k]);
}

/**
 * The compensation boundary (issue #2204): a `--remove-protection` flip of
 * `DisableApiTermination` whose terminate then fails terminally is undone
 * here, so a destroy that did not happen does not leave a live instance with
 * its termination protection stripped.
 */
export async function deleteInstance(
  this: EC2Provider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  context?: DeleteContext,
  properties?: Record<string, unknown>
): Promise<void> {
  // go-to-k/cdkd#5630: the recorded documents. The association cleanup
  // touches only their associations, and a record declaring none (or an
  // unreadable one) pays no Systems Manager call.
  const ssm = properties?.['SsmAssociations'];
  const ssmReadable = instanceSsmAssociationsRefusal(ssm, resourceType) === undefined;
  const ssmDocumentNames = ssmReadable
    ? instanceSsmAssociationEntries(ssm).map((e) => e.DocumentName)
    : [];
  if (!ssmReadable) {
    this.logger.warn(
      safeMsg`${logicalId} (${resourceType}): the record's SsmAssociations is unreadable, so cdkd cannot tell which SSM association of ${physicalId} is this resource's and skips the association cleanup. ${staleSsmAssociationRemedy(physicalId, context?.maskSecrets)}.`
    );
  }
  // The region the compensation's commands name: the state's, else the
  // client's own (a pre-v2 state record carries none), so a pasted command
  // never falls back to the operator's default region. Resolved only under
  // `--remove-protection`, the one case those commands can be printed.
  let commandRegion = context?.expectedRegion?.trim() || undefined;
  if (commandRegion === undefined && context?.removeProtection === true) {
    try {
      commandRegion =
        canonicalizeRegion((await this.ec2Client.config.region())?.trim()) || undefined;
    } catch {
      commandRegion = undefined;
    }
  }
  await deleteWithProtectionCompensation({
    registry: this.protectionFlips,
    key: protectionFlipKey(resourceType, physicalId, context?.expectedRegion),
    run: (flip) =>
      this.terminateInstance(logicalId, physicalId, resourceType, context, flip, ssmDocumentNames),
    compensation: {
      logicalId,
      physicalId,
      logger: this.logger,
      mask: context?.maskSecrets,
      site: ec2InstanceProtectionSite(physicalId, commandRegion),
      reEnable: () => reEnableInstanceApiTermination(this.ec2Client, physicalId),
    },
  });
}

export async function terminateInstance(
  this: EC2Provider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  context: DeleteContext | undefined,
  flip: ProtectionFlipRecord,
  ssmDocumentNames: readonly string[] = []
): Promise<void> {
  this.logger.debug(`Terminating EC2 Instance ${logicalId}: ${physicalId}`);

  const removeProtection = context?.removeProtection === true;

  // `--remove-protection`: flip DisableApiTermination off before
  // TerminateInstances (shared with the Cloud Control delete path — see
  // ec2-termination-protection.ts). The modify WRITE lags the terminate READ,
  // so a terminate immediately after the flip-off 400s "may not be terminated.
  // Modify its 'disableApiTermination' ..." even though we just cleared it.
  // cdkd's fast SDK path outruns the propagation window the way it does for
  // IAM / Route53 elsewhere. This 400 is NOT in the generic retryable set (a
  // protected instance WITHOUT `--remove-protection` must fail fast so the
  // user is told to pass the flag), so retry it locally and ONLY when
  // `--remove-protection` was requested — re-flipping each attempt.
  //
  // The first flip reads the attribute first (issue #2204), so a terminal
  // failure below restores ONLY a guard this run turned off.
  const observedOn = removeProtection
    ? await observeThenDisableInstanceApiTermination(this.ec2Client, physicalId, flip, this.logger)
    : false;

  const maxTerminateAttempts = removeProtection ? TERMINATION_PROTECTION_MAX_ATTEMPTS : 1;
  for (let attempt = 1; ; attempt++) {
    try {
      await this.ec2Client.send(new TerminateInstancesCommand({ InstanceIds: [physicalId] }));
      // AWS took the terminate. What can still throw after this is the
      // termination WAIT, against an instance already shutting down, so it
      // must not re-enable the guard.
      flip.deleteAccepted = true;
      this.logger.debug(`Terminate requested for EC2 Instance ${logicalId}, waiting...`);

      // go-to-k/cdkd#5630: once AWS took the terminate (a refused one keeps
      // the instance and its association), delete the instance's SSM
      // association, best effort. CloudFormation leaves it on the terminated
      // instance; a warning here never blocks the delete.
      if (ssmDocumentNames.length > 0) {
        await this.deleteInstanceSsmAssociationsBestEffort(
          logicalId,
          physicalId,
          ssmDocumentNames,
          maskerOrIdentity(context?.maskSecrets)
        );
      }

      // Wait for instance to reach terminated state so ENIs are released
      await waitUntilInstanceTerminated(
        // Same cadence as the running-state wait above (see that comment for
        // the delay math): termination is also a ~30-60s operation gating ENI
        // release, so a 15s cap spent a mean 7.5s of the destroy just not
        // looking.
        { client: this.ec2Client, maxWaitTime: 300, minDelay: 2, maxDelay: 5 },
        { InstanceIds: [physicalId] }
      );

      this.logger.debug(`EC2 Instance ${logicalId} terminated: ${physicalId}`);
      return;
    } catch (error) {
      if (this.isNotFoundError(error)) {
        const clientRegion = await this.ec2Client.config.region();
        assertRegionMatch(
          clientRegion,
          context?.expectedRegion,
          resourceType,
          logicalId,
          physicalId
        );
        if (context?.failedCreateOrphan === true) {
          // go-to-k/cdkd#4606: a journaled orphan already gone settles with
          // exit 0, so say so once. Masked by the caller's printing bag.
          this.logger.info(
            safeMsg`  EC2 instance ${physicalId} (${logicalId}), which a failed deploy created, is already gone; nothing to delete`
          );
        } else {
          this.logger.debug(
            `EC2 Instance ${physicalId} already terminated (not found), treating as success`
          );
        }
        return;
      }
      // `.detail`, never `.summary`: the substring test below is what keeps this
      // degradation alive, and it matches AWS's OWN wording. Byte-identical to
      // the ternary it replaced, minus that ternary's throw.
      // The thrown `ProvisioningError` further down names an AWS-authored
      // failure by its class only (`wrapCaughtError`, go-to-k/cdkd#2319).
      const msg = describeAwsFailure(error).detail;
      if (
        removeProtection &&
        isTerminationProtectionPropagationError(msg) &&
        attempt < maxTerminateAttempts
      ) {
        this.logger.debug(
          `Terminate of EC2 Instance ${logicalId} raced the DisableApiTermination flip-off (attempt ${attempt}/${maxTerminateAttempts}); re-flipping and retrying`
        );
        await reDisableInstanceApiTermination(
          this.ec2Client,
          physicalId,
          flip,
          observedOn,
          this.logger
        );
        await this.sleep(3000 * attempt);
        continue;
      }
      const cause = error instanceof Error ? error : undefined;
      throw this.wrapDeleteError(
        maskerOrIdentity(context?.maskSecrets),
        error,
        (text) =>
          new ProvisioningError(
            `Failed to terminate EC2 Instance ${logicalId}: ${text}`,
            resourceType,
            logicalId,
            physicalId,
            cause
          )
      );
    }
  }
}

export async function getInstanceAttribute(
  this: EC2Provider,
  physicalId: string,
  attributeName: string
): Promise<unknown> {
  const response = await this.ec2Client.send(
    new DescribeInstancesCommand({ InstanceIds: [physicalId] })
  );
  const instance = response.Reservations?.[0]?.Instances?.[0];
  if (!instance) return undefined;

  switch (attributeName) {
    case 'InstanceId':
      return instance.InstanceId;
    case 'PrivateIp':
      return instance.PrivateIpAddress;
    case 'PublicIp':
      return instance.PublicIpAddress;
    case 'PrivateDnsName':
      return instance.PrivateDnsName;
    case 'PublicDnsName':
      return instance.PublicDnsName;
    case 'AvailabilityZone':
      return instance.Placement?.AvailabilityZone;
    default:
      return undefined;
  }
}

/** The {@link EC2Provider} methods this module defines. */
export const instanceLifecycleMethods = {
  readVolumeAttachment,
  attachInstanceVolume,
  detachInstanceVolume,
  waitForVolumeAttachment,
  waitForFailedLaunchTerminated,
  vpcDefaultSecurityGroupId,
  applyInstanceProfileChange,
  shallowEqual,
  deleteInstance,
  terminateInstance,
  getInstanceAttribute,
};
