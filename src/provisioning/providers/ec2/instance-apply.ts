import { isDeepStrictEqual } from 'node:util';
import {
  DescribeInstancesCommand,
  ModifyInstanceAttributeCommand,
  ModifyInstancePlacementCommand,
  ModifyPrivateDnsNameOptionsCommand,
  type PrivateDnsNameOptionsRequest,
  StopInstancesCommand,
  StartInstancesCommand,
} from '@aws-sdk/client-ec2';
import {
  enclosingDeadlineExpired,
  enclosingDeadlineRemainingMs,
} from '../../../deployment/resource-deadline.js';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import {
  ProvisioningError,
  ResourceUpdateNotSupportedError,
} from '../../../utils/error-handler.js';
import type { UpdateContext } from '../../../types/resource.js';
import { safeMsg } from '../../../utils/display-safe.js';
import { markNonRetryable } from '../../../deployment/retryable-errors.js';
import { isInterruptedWaitError, startInterruptWatch } from '../../interrupt-watch.js';
import { markRefusedBeforeApplying } from '../../../deployment/prior-attempt-scope.js';
import {
  INSTANCE_STATE_POLL_MS,
  INSTANCE_STATE_WAIT_CAP_MS,
  type InstanceMemberPlan,
  STOPPABLE_INSTANCE_STATES,
  STOPPED_AFTER_START_READS,
  instanceStopMembers,
  instanceStoppedAfterStart,
  instancesLeftStoppedByCdkd,
  privateDnsNameOptionsRefusal,
  privateDnsNameOptionsRequest,
  refusedBeforeApplying,
} from './instance-support.js';
import type { EC2Provider } from '../ec2-provider.js';

/**
 * go-to-k/cdkd#5630: plan a `PrivateDnsNameOptions` change. What
 * CloudFormation does, MEASURED (us-east-1, 2026-11-04, a t3.nano):
 *  - adding the block, or changing a member, keeps the instance:
 *    ModifyPrivateDnsNameOptions with the changed members, the
 *    `EnableResourceName*` flags in place, a `HostnameType` change with a
 *    stop and a start (EC2 refuses any HostnameType on a running instance,
 *    "Cannot modify hostname-type for running instances", even an unchanged
 *    one);
 *  - removing the whole block creates a new instance
 *    (`instancePrivateDnsNameOptionsChangeReplaces`), so only
 *    `cdkd drift --revert` or a direct call brings one here, where it is
 *    refused;
 *  - removing a member FAILS the update ("No valid attributes specified"),
 *    whether or not another member changes with it (three shapes measured),
 *    so it is refused here.
 *
 * A rollback revert keeps the live value and warns instead of refusing.
 */
export function planPrivateDnsNameOptions(
  this: EC2Provider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>,
  context: UpdateContext | undefined,
  plan: InstanceMemberPlan,
  changed: (key: string, same: (a: unknown, b: unknown) => boolean) => boolean,
  standInSkips: (key: string) => boolean
): void {
  const KEY = 'PrivateDnsNameOptions';
  const readable = (v: unknown): PrivateDnsNameOptionsRequest =>
    v != null && privateDnsNameOptionsRefusal(v, resourceType) === undefined
      ? (privateDnsNameOptionsRequest(v) ?? {})
      : {};
  const sameOptions = (a: unknown, b: unknown): boolean =>
    a != null &&
    b != null &&
    privateDnsNameOptionsRefusal(a, resourceType) === undefined &&
    privateDnsNameOptionsRefusal(b, resourceType) === undefined &&
    isDeepStrictEqual(readable(a), readable(b));
  if (!changed(KEY, sameOptions)) return;
  const replaying = context?.replayingState === true;
  const after = properties[KEY];
  if (after === undefined || after === null) {
    if (replaying) {
      this.logger.warn(
        safeMsg`${logicalId} (${resourceType}): the state being restored does not declare PrivateDnsNameOptions, which needs a new instance; the rollback leaves the instance's hostname options as they are.`
      );
      return;
    }
    throw refusedBeforeApplying(
      new ResourceUpdateNotSupportedError(
        resourceType,
        logicalId,
        'replace the instance (cdkd deploy --replace). CloudFormation creates a new instance when PrivateDnsNameOptions is removed'
      )
    );
  }
  if (standInSkips(KEY)) return;
  const refusal = privateDnsNameOptionsRefusal(after, resourceType);
  if (refusal !== undefined) {
    if (replaying || context?.desiredFromAwsReadback === true) {
      this.logger.warn(
        safeMsg`${logicalId} (${resourceType}): ${refusal}; the hostname options are left at their current AWS value.`
      );
      return;
    }
    throw refusedBeforeApplying(
      new ProvisioningError(
        `${refusal}. The instance ${logicalId} was not updated.`,
        resourceType,
        logicalId,
        physicalId
      )
    );
  }
  const want = readable(after);
  const had = readable(previousProperties[KEY]);
  const request: NonNullable<InstanceMemberPlan['privateDnsNameOptions']> = {};
  if (want.HostnameType !== undefined && want.HostnameType !== had.HostnameType) {
    request.PrivateDnsHostnameType = want.HostnameType;
  }
  for (const member of [
    'EnableResourceNameDnsARecord',
    'EnableResourceNameDnsAAAARecord',
  ] as const) {
    if (want[member] !== undefined && want[member] !== had[member]) {
      request[member] = want[member];
    }
  }
  // A removed member. Every one CloudFormation was MEASURED on fails the
  // update ("No valid attributes specified"), alone or next to a changed
  // member, and leaves the instance as it was, so it is refused before any
  // call. A `cdkd drift --revert` previous side is the readback, which
  // reports every member, so a member the record omits is no removal there.
  const removedMembers =
    context?.desiredFromAwsReadback === true
      ? ''
      : (Object.keys(had) as Array<keyof PrivateDnsNameOptionsRequest>)
          .filter((m) => want[m] === undefined)
          .join(', ');
  if (removedMembers !== '') {
    if (!replaying) {
      throw refusedBeforeApplying(
        new ProvisioningError(
          safeMsg`${logicalId} (${resourceType}): PrivateDnsNameOptions ${removedMembers} was removed from the template, and CloudFormation fails that update ("No valid attributes specified"). Keep it declared (set it to the value the instance has to leave it unchanged), or remove the whole PrivateDnsNameOptions block, which replaces the instance. The instance was not updated.`,
          resourceType,
          logicalId,
          physicalId
        )
      );
    }
    this.logger.warn(
      safeMsg`${logicalId} (${resourceType}): the state being restored does not declare PrivateDnsNameOptions ${removedMembers}; the rollback leaves it at its current AWS value.`
    );
  }
  if (Object.keys(request).length > 0) plan.privateDnsNameOptions = request;
}

/**
 * Issue #5446: the reads and refusals that need AWS, before any mutating
 * call of the update. An InstanceType / UserData change needs a stop: an
 * instance-store-backed instance cannot be stopped (CloudFormation replaces
 * it; refused with ResourceUpdateNotSupportedError, so
 * `cdkd deploy --replace` takes it), and an instance in any state but
 * pending / running / stopping / stopped cannot be stopped and started. A
 * removed `SecurityGroupIds` resolves the VPC's `default` group here, so a
 * missing one refuses the update before anything is sent.
 */
export async function prepareInstanceMemberUpdates(
  this: EC2Provider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  plan: InstanceMemberPlan
): Promise<void> {
  const needsDefaultGroup = plan.securityGroups?.kind === 'vpc-default';
  const tenancy = plan.tenancyAddition;
  if (instanceStopMembers(plan).length === 0 && !needsDefaultGroup && tenancy === undefined) {
    return;
  }
  const resp = await this.ec2Client.send(
    new DescribeInstancesCommand({ InstanceIds: [physicalId] })
  );
  const instance = resp.Reservations?.[0]?.Instances?.[0];
  // go-to-k/cdkd#5630: EC2 takes a HostnameType only on a stopped instance,
  // even an unchanged one, so one the instance already has is not sent and
  // costs no stop (a record that lacked it, or an earlier failed update).
  const dns = plan.privateDnsNameOptions;
  if (
    dns?.PrivateDnsHostnameType !== undefined &&
    instance?.PrivateDnsNameOptions?.HostnameType === dns.PrivateDnsHostnameType
  ) {
    const { PrivateDnsHostnameType: _sameAsLive, ...rest } = dns;
    if (Object.keys(rest).length > 0) plan.privateDnsNameOptions = rest;
    else delete plan.privateDnsNameOptions;
  }
  // go-to-k/cdkd#5630: a value the instance already has costs no stop either
  // (a record an earlier --prefer-sdk-route deploy left without it).
  const placement = plan.placement;
  if (placement !== undefined) {
    if (placement.Affinity !== undefined && instance?.Placement?.Affinity === placement.Affinity) {
      delete placement.Affinity;
    }
    if (placement.HostId !== undefined && instance?.Placement?.HostId === placement.HostId) {
      delete placement.HostId;
    }
    if (placement.Affinity === undefined && placement.HostId === undefined) delete plan.placement;
  }
  if (plan.kernelId !== undefined && instance?.KernelId === plan.kernelId) delete plan.kernelId;
  if (plan.ramdiskId !== undefined && instance?.RamdiskId === plan.ramdiskId) delete plan.ramdiskId;
  const stopMembers = instanceStopMembers(plan);
  const needsStop = stopMembers.length > 0;
  if (tenancy !== undefined) {
    // go-to-k/cdkd#5630: AWS already holding the declared tenancy means
    // nothing to do (the record then takes the template's value). Anything
    // else needs a new instance, which is the user's call: a record without
    // Tenancy cannot say whether the template just added it.
    const live = instance?.Placement?.Tenancy;
    if (live !== tenancy.value) {
      if (tenancy.replaying) {
        this.logger.warn(
          safeMsg`${logicalId} (${resourceType}): the state being restored declares Tenancy ${tenancy.value}, but the instance has ${live ?? 'an unreadable tenancy'}; the rollback leaves it as it is.`
        );
      } else {
        throw markRefusedBeforeApplying(
          new ResourceUpdateNotSupportedError(
            resourceType,
            logicalId,
            safeMsg`the template declares Tenancy ${tenancy.value}, the instance has ${live ?? 'a tenancy DescribeInstances did not report'}, and the state record does not say which tenancy it was launched with. Changing it needs a new instance: replace it with cdkd deploy --replace, or declare Tenancy ${live ?? 'as the instance has it'}`
          )
        );
      }
    }
  }
  if (needsStop) {
    const members = stopMembers.join(' and ');
    if (instance?.RootDeviceType === 'instance-store') {
      throw markRefusedBeforeApplying(
        new ResourceUpdateNotSupportedError(
          resourceType,
          logicalId,
          `${members} can change only on a stopped instance, and an instance-store-backed instance cannot be stopped; ${plan.instanceType !== undefined || plan.userData !== undefined ? 'CloudFormation replaces it' : 'it needs a new instance'}. Re-deploy with cdkd deploy --replace.`
        )
      );
    }
    const state = instance?.State?.Name;
    if (!STOPPABLE_INSTANCE_STATES.has(state ?? '')) {
      throw refusedBeforeApplying(
        new ProvisioningError(
          `${logicalId} (${resourceType}): instance ${physicalId} is ${state ?? 'not returned by DescribeInstances'}, so its ${members} cannot be changed. The instance was not updated.`,
          resourceType,
          logicalId,
          physicalId
        )
      );
    }
  }
  if (needsDefaultGroup) {
    plan.securityGroups = {
      kind: 'set',
      ids: [
        await this.vpcDefaultSecurityGroupId(logicalId, physicalId, resourceType, instance?.VpcId),
      ],
    };
  }
}

/**
 * Issue #5446: apply a {@link planInstanceMemberUpdates} plan, after
 * {@link prepareInstanceMemberUpdates}. The calls that need no interruption
 * go first (groups, profile, DeleteOnTermination), then one stop -> modify
 * -> start covers InstanceType and UserData together, as CloudFormation's
 * single launch-time move shows.
 *
 * An instance the user had already stopped is modified and left stopped,
 * unless cdkd itself left it stopped earlier in this process (a failed
 * start, which the rollback then reverts): CloudFormation's rollback starts
 * it again, and so does this. Any failure after cdkd's stop starts the
 * instance again (best effort) and says which changes it already carries;
 * when that is not possible (an interrupt, an expired deadline, a start
 * that itself failed) the warning names the `aws ec2 start-instances`
 * command. `--no-wait` skips only the final wait for `running`: the modify
 * needs `stopped`.
 */
export async function applyInstanceMemberUpdates(
  this: EC2Provider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  plan: InstanceMemberPlan
): Promise<void> {
  // What this update has already changed on the instance, for a warning
  // after a failure to name (never more than was sent).
  const applied: string[] = [];
  if (plan.securityGroups?.kind === 'set') {
    await this.ec2Client.send(
      new ModifyInstanceAttributeCommand({
        InstanceId: physicalId,
        Groups: plan.securityGroups.ids,
      })
    );
    applied.push('the new SecurityGroupIds');
  }

  if (plan.profile !== undefined) {
    await this.applyInstanceProfileChange(logicalId, physicalId, plan.profile);
    applied.push(
      plan.profile.kind === 'remove'
        ? 'the IamInstanceProfile removed'
        : 'the new IamInstanceProfile'
    );
  }

  if (plan.deleteOnTermination !== undefined) {
    await this.ec2Client.send(
      new ModifyInstanceAttributeCommand({
        InstanceId: physicalId,
        BlockDeviceMappings: plan.deleteOnTermination.map((f) => ({
          DeviceName: f.DeviceName,
          Ebs: { DeleteOnTermination: f.DeleteOnTermination },
        })),
      })
    );
    applied.push('the new DeleteOnTermination');
  }

  if (plan.shutdownBehavior !== undefined) {
    await this.ec2Client.send(
      new ModifyInstanceAttributeCommand({
        InstanceId: physicalId,
        InstanceInitiatedShutdownBehavior: { Value: plan.shutdownBehavior },
      })
    );
    applied.push('the new InstanceInitiatedShutdownBehavior');
  }

  if (plan.sourceDestCheck !== undefined) {
    await this.ec2Client.send(
      new ModifyInstanceAttributeCommand({
        InstanceId: physicalId,
        SourceDestCheck: { Value: plan.sourceDestCheck },
      })
    );
    applied.push('the new SourceDestCheck');
  }

  // go-to-k/cdkd#5630: the EnableResourceName* flags change on a running
  // instance; a HostnameType goes out with them in the stopped window below.
  const dns = plan.privateDnsNameOptions;
  if (dns !== undefined && dns.PrivateDnsHostnameType === undefined) {
    await this.ec2Client.send(
      new ModifyPrivateDnsNameOptionsCommand({ InstanceId: physicalId, ...dns })
    );
    applied.push('the new PrivateDnsNameOptions');
  }

  // go-to-k/cdkd#5630: detaches first, so a Device change can re-attach
  // the same volume.
  if (plan.volumes !== undefined) {
    for (const volume of plan.volumes.detach) {
      await this.detachInstanceVolume(logicalId, physicalId, resourceType, volume);
      applied.push(`volume ${volume.VolumeId} detached from ${volume.Device}`);
    }
    for (const volume of plan.volumes.attach) {
      await this.attachInstanceVolume(logicalId, physicalId, resourceType, volume);
      applied.push(`volume ${volume.VolumeId} attached at ${volume.Device}`);
    }
  }

  const stopMembers = instanceStopMembers(plan);
  const stopWhat = stopMembers.join(' / ');
  if (stopMembers.length === 0) {
    // An instance cdkd stopped and could not start again earlier in this
    // process (a rollback whose only stop member was skipped) is started,
    // once it has finished stopping; one already running is left alone.
    if (instancesLeftStoppedByCdkd.has(physicalId)) {
      let state = await this.readInstanceState(physicalId);
      if (state === 'stopping') {
        state = await this.waitForInstanceState(logicalId, physicalId, resourceType, 'stopped');
      }
      if (state === 'stopped') {
        await this.ec2Client.send(new StartInstancesCommand({ InstanceIds: [physicalId] }));
      }
      instancesLeftStoppedByCdkd.delete(physicalId);
    }
    return;
  }

  let state = await this.readInstanceState(physicalId);
  if (state === 'pending') {
    state = await this.waitForInstanceState(logicalId, physicalId, resourceType, 'running');
  } else if (state === 'stopping') {
    state = await this.waitForInstanceState(logicalId, physicalId, resourceType, 'stopped');
  }
  if (state !== 'stopped' && state !== 'running') {
    throw markNonRetryable(
      new ProvisioningError(
        `${logicalId} (${resourceType}): instance ${physicalId} became ${state ?? 'not returned by DescribeInstances'} during the update, so its ${stopWhat} were not changed`,
        resourceType,
        logicalId,
        physicalId
      )
    );
  }
  const startAfter = state === 'running' || instancesLeftStoppedByCdkd.has(physicalId);

  let phase: 'stop' | 'modify' | 'start' | 'wait' = 'stop';
  let stopIssued = false;
  try {
    if (state === 'running') {
      this.logger.info(
        safeMsg`Stopping EC2 Instance ${logicalId} (${physicalId}) to change its ${stopMembers.join(' and ')}; it is started again afterwards`
      );
      await this.ec2Client.send(new StopInstancesCommand({ InstanceIds: [physicalId] }));
      stopIssued = true;
      await this.waitForInstanceState(logicalId, physicalId, resourceType, 'stopped');
    }
    phase = 'modify';
    if (plan.instanceType !== undefined) {
      await this.ec2Client.send(
        new ModifyInstanceAttributeCommand({
          InstanceId: physicalId,
          InstanceType: { Value: plan.instanceType },
        })
      );
      applied.push('the new InstanceType');
    }
    if (plan.userData !== undefined) {
      await this.ec2Client.send(
        new ModifyInstanceAttributeCommand({
          InstanceId: physicalId,
          UserData: { Value: plan.userData },
        })
      );
      applied.push('the new UserData');
    }
    if (dns?.PrivateDnsHostnameType !== undefined) {
      await this.ec2Client.send(
        new ModifyPrivateDnsNameOptionsCommand({ InstanceId: physicalId, ...dns })
      );
      applied.push('the new PrivateDnsNameOptions');
    }
    // go-to-k/cdkd#5630: Dedicated Host placement, kernel and RAM disk.
    if (plan.placement !== undefined) {
      await this.ec2Client.send(
        new ModifyInstancePlacementCommand({ InstanceId: physicalId, ...plan.placement })
      );
      applied.push(`the new ${Object.keys(plan.placement).join(' and ')}`);
    }
    if (plan.kernelId !== undefined) {
      await this.ec2Client.send(
        new ModifyInstanceAttributeCommand({
          InstanceId: physicalId,
          Kernel: { Value: plan.kernelId },
        })
      );
      applied.push('the new KernelId');
    }
    if (plan.ramdiskId !== undefined) {
      await this.ec2Client.send(
        new ModifyInstanceAttributeCommand({
          InstanceId: physicalId,
          Ramdisk: { Value: plan.ramdiskId },
        })
      );
      applied.push('the new RamdiskId');
    }
    if (!startAfter) return;
    phase = 'start';
    await this.ec2Client.send(new StartInstancesCommand({ InstanceIds: [physicalId] }));
    instancesLeftStoppedByCdkd.delete(physicalId);
    if (process.env['CDKD_NO_WAIT'] === 'true') {
      this.logger.debug(
        safeMsg`Instance ${physicalId} started (skipping running-state wait per --no-wait)`
      );
      return;
    }
    phase = 'wait';
    await this.waitForInstanceState(logicalId, physicalId, resourceType, 'running', {
      stoppedIsTerminal: true,
    });
  } catch (error) {
    const carries =
      applied.length === 0 ? 'its previous settings' : `${applied.join(' and ')} already applied`;
    const startCommand = `aws ec2 start-instances --instance-ids ${physicalId}`;
    // The stop itself failed (stop protection, a one-time Spot request):
    // nothing was stopped, so there is nothing to start or warn about.
    if (phase === 'stop' && !stopIssued) throw error;
    if (phase === 'wait') {
      // Started; only a start AWS undid leaves it down.
      if (instanceStoppedAfterStart.has(error as object)) {
        instancesLeftStoppedByCdkd.add(physicalId);
        this.logger.warn(
          safeMsg`${logicalId}: instance ${physicalId} stopped again right after cdkd started it, with ${carries}. Start it with: ${startCommand}`
        );
      }
      throw error;
    }
    if (!stopIssued && !startAfter) throw error;
    const retryStart =
      phase !== 'start' && !isInterruptedWaitError(error) && !enclosingDeadlineExpired();
    if (retryStart) {
      let startFailure: unknown;
      try {
        await this.ec2Client.send(new StartInstancesCommand({ InstanceIds: [physicalId] }));
      } catch (e) {
        startFailure = e ?? new Error('StartInstances failed');
      }
      if (startFailure === undefined) {
        instancesLeftStoppedByCdkd.delete(physicalId);
        this.logger.warn(
          safeMsg`${logicalId}: the ${stopWhat} change failed after instance ${physicalId} was stopped; cdkd started it again, with ${carries}.`
        );
      } else {
        instancesLeftStoppedByCdkd.add(physicalId);
        this.logger.warn(
          safeMsg`${logicalId}: instance ${physicalId} was stopped for a ${stopWhat} change that failed, and starting it again failed too (${describeAwsFailure(startFailure).summary}); it is stopped, with ${carries}. Start it with: ${startCommand}`
        );
      }
      throw error;
    }
    instancesLeftStoppedByCdkd.add(physicalId);
    this.logger.warn(
      phase === 'stop'
        ? safeMsg`${logicalId}: instance ${physicalId} was being stopped for a ${stopWhat} change that did not finish. Once it is stopped, start it with: ${startCommand}`
        : safeMsg`${logicalId}: instance ${physicalId} is stopped, with ${carries}; cdkd did not start it again. Start it with: ${startCommand}`
    );
    throw error;
  }
}

/** The instance's `State.Name`, or undefined when DescribeInstances omits it. */
export async function readInstanceState(
  this: EC2Provider,
  physicalId: string
): Promise<string | undefined> {
  const resp = await this.ec2Client.send(
    new DescribeInstancesCommand({ InstanceIds: [physicalId] })
  );
  return resp.Reservations?.[0]?.Instances?.[0]?.State?.Name;
}

/**
 * Poll DescribeInstances until the instance reaches `target` (issue #5446).
 * Ctrl-C ends the wait with an `InterruptedWaitError`; the resource
 * deadline ends it non-retryably, and so does a terminal state. Outside a
 * deadline the wait is capped at {@link INSTANCE_STATE_WAIT_CAP_MS}.
 */
export async function waitForInstanceState(
  this: EC2Provider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  target: 'running' | 'stopped',
  opts: { stoppedIsTerminal?: boolean } = {}
): Promise<string> {
  const watch = startInterruptWatch(`EC2 Instance ${logicalId} ${target} wait`);
  const capAt = Date.now() + INSTANCE_STATE_WAIT_CAP_MS;
  let last: string | undefined;
  let stoppedReads = 0;
  try {
    for (;;) {
      if (watch.isInterrupted()) throw watch.onInterrupted();
      const remaining = Math.min(enclosingDeadlineRemainingMs(), capAt - Date.now());
      if (remaining <= 0) {
        throw markNonRetryable(
          new ProvisioningError(
            `${logicalId} (${resourceType}): timed out waiting for instance ${physicalId} to be ${target} (last state: ${last ?? 'none reported'})`,
            resourceType,
            logicalId,
            physicalId
          )
        );
      }
      const previous = last;
      last = await this.readInstanceState(physicalId);
      if (last === target) return last;
      stoppedReads = last === 'stopped' ? stoppedReads + 1 : 0;
      // After a start: `pending` back to `stopped` is AWS undoing the start
      // (capacity, a type the AMI cannot run), not progress; so is a
      // `stopped` that persists, for an undo that fell between two polls.
      if (
        opts.stoppedIsTerminal === true &&
        last === 'stopped' &&
        (previous === 'pending' || stoppedReads >= STOPPED_AFTER_START_READS)
      ) {
        const stopped = markNonRetryable(
          new ProvisioningError(
            `${logicalId} (${resourceType}): instance ${physicalId} stopped again right after it was started; run \`aws ec2 describe-instances --instance-ids ${physicalId}\` and read StateReason for AWS's cause`,
            resourceType,
            logicalId,
            physicalId
          )
        );
        instanceStoppedAfterStart.add(stopped);
        throw stopped;
      }
      if (last === 'terminated' || last === 'shutting-down' || last === undefined) {
        throw markNonRetryable(
          new ProvisioningError(
            `${logicalId} (${resourceType}): instance ${physicalId} is ${last ?? 'no longer returned by DescribeInstances'} while cdkd waited for it to be ${target}`,
            resourceType,
            logicalId,
            physicalId
          )
        );
      }
      if (watch.isInterrupted()) throw watch.onInterrupted();
      await this.sleep(
        Math.max(0, Math.min(INSTANCE_STATE_POLL_MS, enclosingDeadlineRemainingMs()))
      );
    }
  } finally {
    watch.dispose();
  }
}

/** The {@link EC2Provider} methods this module defines. */
export const instanceApplyMethods = {
  planPrivateDnsNameOptions,
  prepareInstanceMemberUpdates,
  applyInstanceMemberUpdates,
  readInstanceState,
  waitForInstanceState,
};
