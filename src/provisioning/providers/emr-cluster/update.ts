import type { EMRClusterProvider } from '../emr-cluster-provider.js';
import {
  DescribeClusterCommand,
  SetTerminationProtectionCommand,
  SetVisibleToAllUsersCommand,
  ModifyClusterCommand,
  AddTagsCommand,
  RemoveTagsCommand,
  PutManagedScalingPolicyCommand,
  RemoveManagedScalingPolicyCommand,
  PutAutoTerminationPolicyCommand,
  RemoveAutoTerminationPolicyCommand,
  SetUnhealthyNodeReplacementCommand,
  type Cluster,
  type Tag,
} from '@aws-sdk/client-emr';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import {
  ProvisioningError,
  ResourceUpdateNotSupportedError,
} from '../../../utils/error-handler.js';
import { protectedReplacementAdvice } from '../../replacement-protection-advice.js';
import { deployReplaceCommand } from '../../../utils/pasteable-command.js';
import { planTagDiff, tagPlanWarning, refuseMalformedDesiredTags } from '../../tag-list.js';
import { unchangedBehindSecretReference } from '../../secret-reference-immutable.js';
import { emrClusterInstancesReplaced } from '../../../analyzer/replacement-rules.js';
import { EMRInstanceGroupConfigProvider } from '../emr-instance-group-config-provider.js';
import { EMRInstanceFleetConfigProvider } from '../emr-instance-fleet-config-provider.js';
import { isSecretDerivedValue, type MaskerFn } from '../../masked-retry-logger.js';
import type { ResourceUpdateResult, UpdateContext } from '../../../types/resource.js';
import { safeMsg } from '../../../utils/display-safe.js';
import {
  MUTABLE_TOP_LEVEL_PROPS,
  LEFT_IN_PLACE_ON_REMOVAL,
  leftInPlaceWarning,
  toNumber,
  toBoolean,
  jsonEqual,
  withRecordedReferences,
  type InstancesResize,
  type InstancesInPlacePlan,
  type InstancesTargets,
  NO_INSTANCES_TARGETS,
  ENDED_GROUP_STATES,
  ENDED_FLEET_STATES,
  IDENTITY_MASK,
  EMPTY_INSTANCES_PLAN,
  FLEET_IN_PLACE_MEMBERS,
  planInstancesInPlace,
} from './shared.js';

/**
 * Find the EMR instance group or fleet each planned resize addresses
 * (go-to-k/cdkd#5422), BEFORE any call that changes AWS: a target that cannot
 * be found refuses the whole update with nothing applied. A group or fleet is
 * found by its role; a TASK one by its `Name` when declared (CloudFormation
 * tells them apart by name), else by its instance type. Anything but exactly
 * one match is refused, as is a `Name` recorded as a `{{resolve:...}}`
 * reference: the resolved value ADDRESSES the call, and a rotated secret
 * could name another group (the delegates never exempt their `JobFlowId` /
 * `ClusterId` for the same reason).
 */
export async function resolveInstancesTargets(
  this: EMRClusterProvider,
  logicalId: string,
  clusterId: string,
  plan: InstancesInPlacePlan
): Promise<InstancesTargets> {
  const refuse = (resize: InstancesResize, why: string): never => {
    throw new ProvisioningError(
      safeMsg`Cannot apply Instances.${resize.path} to EMR cluster ${clusterId}: ` + why,
      'AWS::EMR::Cluster',
      logicalId,
      clusterId
    );
  };
  const pick = <T extends { Id?: string | undefined; Name?: string | undefined }>(
    candidates: T[],
    resize: InstancesResize,
    kind: string,
    shapeOf: (candidate: T) => Record<string, string | undefined> | undefined
  ): string => {
    const name = resize.next['Name'];
    // The member that ADDRESSES a TASK group or fleet (CORE goes by role).
    const matchKey = typeof name === 'string' ? 'Name' : 'InstanceType';
    if (resize.type === 'TASK' && isSecretDerivedValue(resize.prev[matchKey], IDENTITY_MASK)) {
      refuse(
        resize,
        `its ${matchKey} is a secret reference, which cannot address an instance ${kind}; declare it literally`
      );
    }
    let matches = candidates;
    let byShape = false;
    if (resize.type === 'TASK') {
      if (typeof name === 'string') {
        matches = candidates.filter((c) => c.Name === name);
      } else {
        // An unnamed task group: its instance type, market (CloudFormation's
        // default ON_DEMAND) and bid price, so an ON_DEMAND + SPOT pair of
        // one type is told apart. A fleet has no such shape.
        const want: Record<string, unknown> = {
          InstanceType: resize.next['InstanceType'],
          Market: resize.next['Market'] ?? 'ON_DEMAND',
          ...(resize.next['BidPrice'] !== undefined && { BidPrice: resize.next['BidPrice'] }),
        };
        matches = candidates.filter((c) => {
          const shape = shapeOf(c);
          return (
            shape === undefined ||
            Object.entries(want).every(([key, value]) =>
              // A bid price is a decimal string: "0.1" and "0.10" are one price.
              key === 'BidPrice'
                ? Number.parseFloat(String(shape[key])) === Number.parseFloat(String(value))
                : shape[key] === value
            )
          );
        });
        byShape = true;
      }
    }
    if (matches.length !== 1 || matches[0]!.Id === undefined) {
      refuse(
        resize,
        `found ${String(matches.length)} matching ${resize.type} instance ${kind}s, expected exactly one` +
          (byShape && matches.length > 1
            ? ' (cdkd cannot tell them apart; giving the entry a Name now would replace the cluster)'
            : '')
      );
    }
    return matches[0]!.Id!;
  };
  const groups =
    plan.groups.length > 0
      ? (await this.listInstanceGroups(clusterId)).filter(
          (g) => !ENDED_GROUP_STATES.has(g.Status?.State ?? '')
        )
      : [];
  const fleets =
    plan.fleets.length > 0
      ? (await this.listInstanceFleets(clusterId)).filter(
          (f) => !ENDED_FLEET_STATES.has(f.Status?.State ?? '')
        )
      : [];
  return {
    groups: plan.groups.map((resize) => ({
      resize,
      id: pick(
        groups.filter((g) => g.InstanceGroupType === resize.type),
        resize,
        'group',
        (g) => ({ InstanceType: g.InstanceType, Market: g.Market, BidPrice: g.BidPrice })
      ),
    })),
    fleets: plan.fleets.map((resize) => ({
      resize,
      id: pick(
        fleets.filter((f) => f.InstanceFleetType === resize.type),
        resize,
        'fleet',
        () => undefined
      ),
    })),
  };
}

/**
 * Apply the resolved group and fleet changes (go-to-k/cdkd#5422) through the
 * `AWS::EMR::InstanceGroupConfig` / `InstanceFleetConfig` providers' own
 * `update()`, which issue `ModifyInstanceGroups` / `PutAutoScalingPolicy` /
 * `RemoveAutoScalingPolicy` / `ModifyInstanceFleet` and wait for the resize to
 * settle, so the two paths share one resize and one wait. One at a time,
 * since EMR refuses a resize while another is in progress, under ONE shared
 * wait budget (`maxWaitMs` from the start of `update()`), so the sum stays
 * inside `getMinResourceTimeoutMs()`. A delegate's failure is re-stated for
 * the cluster, naming the `Instances` path. The group delegate waits for
 * `RunningInstanceCount` to equal the requested count, so a managed-scaling
 * or auto-scaling policy that holds the group elsewhere keeps it waiting
 * until the budget runs out (the delegate's own behaviour).
 *
 * Not atomic: a `Set*` call or resize that succeeded stays applied when a
 * later one fails. State keeps the old values, so the next deploy converges;
 * a rollback that reverts a group EMR still reads `RESIZING` can be refused.
 */
export async function applyInstancesResizes(
  this: EMRClusterProvider,
  logicalId: string,
  clusterId: string,
  targets: InstancesTargets,
  deadline: number,
  mask: MaskerFn | undefined
): Promise<void> {
  if (targets.groups.length === 0 && targets.fleets.length === 0) return;
  const options = (resize: InstancesResize): { pollIntervalMs: number; maxWaitMs: number } => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      // Never start a resize there is no time left to wait for.
      throw new ProvisioningError(
        safeMsg`Timed out before applying Instances.${resize.path} to EMR cluster ${clusterId}: the earlier resizes used the whole wait (${String(Math.round(this.maxWaitMs / 60000))} min)`,
        'AWS::EMR::Cluster',
        logicalId,
        clusterId
      );
    }
    return { pollIntervalMs: this.pollIntervalMs, maxWaitMs: remaining };
  };
  const context = mask ? { maskSecrets: mask } : undefined;
  const restated = async (resize: InstancesResize, run: () => Promise<unknown>): Promise<void> => {
    try {
      await run();
    } catch (error) {
      // The delegates throw a ProvisioningError whose message is already
      // masked (their catch and waits go through `context.maskSecrets`);
      // anything else reaches update()'s own wrap unchanged.
      if (!(error instanceof ProvisioningError)) throw error;
      throw new ProvisioningError(
        safeMsg`Failed to apply Instances.${resize.path} to EMR cluster ${clusterId}: ` +
          error.message,
        'AWS::EMR::Cluster',
        logicalId,
        clusterId,
        error
      );
    }
  };
  for (const { resize, id } of targets.groups) {
    const bag = (side: Record<string, unknown>): Record<string, unknown> => ({
      JobFlowId: clusterId,
      InstanceCount: side['InstanceCount'],
      AutoScalingPolicy: side['AutoScalingPolicy'],
    });
    // Outside `restated`: a spent budget is the cluster's own refusal.
    const delegateOptions = options(resize);
    await restated(resize, () =>
      new EMRInstanceGroupConfigProvider(delegateOptions).update(
        logicalId,
        id,
        'AWS::EMR::InstanceGroupConfig',
        bag(resize.next),
        bag(resize.prev),
        context
      )
    );
  }
  for (const { resize, id } of targets.fleets) {
    const bag = (side: Record<string, unknown>): Record<string, unknown> => ({
      ClusterId: clusterId,
      InstanceFleetType: resize.type,
      TargetOnDemandCapacity: side['TargetOnDemandCapacity'],
      TargetSpotCapacity: side['TargetSpotCapacity'],
    });
    // Outside `restated`: a spent budget is the cluster's own refusal.
    const delegateOptions = options(resize);
    await restated(resize, () =>
      new EMRInstanceFleetConfigProvider(delegateOptions).update(
        logicalId,
        id,
        'AWS::EMR::InstanceFleetConfig',
        bag(resize.next),
        bag(resize.prev),
        context
      )
    );
  }
}

export async function update(
  this: EMRClusterProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>,
  context?: UpdateContext
): Promise<ResourceUpdateResult> {
  // go-to-k/cdkd#3994: a malformed desired Tags is refused before any call.
  refuseMalformedDesiredTags(properties['Tags'], resourceType, logicalId, physicalId);
  // The ONE wait budget every resize below shares (applyInstancesResizes).
  const resizeDeadline = Date.now() + this.maxWaitMs;

  const changed = (key: string): boolean => !jsonEqual(properties[key], previousProperties[key]);

  // The deploy diff classifies an `Instances` change as a replacement unless
  // only members CloudFormation updates in place moved (go-to-k/cdkd#5418,
  // `emrClusterInstancesReplaced`). This method applies those members
  // (go-to-k/cdkd#5422, `planInstancesInPlace`), and refuses a replacing
  // member as defence in depth (the diff was bypassed).
  const nextInstances = (properties['Instances'] ?? {}) as Record<string, unknown>;
  const prevInstances = (previousProperties['Instances'] ?? {}) as Record<string, unknown>;

  // Issue [#2610] sites 2 and 3. Both refusals below advise a replacement,
  // and BOTH advices were wrong in two independent ways.
  //
  // 1. `AWS::EMR::Cluster` is in `STATEFUL_TYPES`, so the deploy engine's
  //    `--replace` fallback refuses it a second time with
  //    STATEFUL_REPLACE_BLOCKED unless `--force-stateful-recreation` is also
  //    passed. Name the full flag set upfront, as the `AWS::Logs::LogGroup`
  //    guard does (issue [#2558]).
  // 2. Neither flag can clear `Instances.TerminationProtected`: the
  //    replacement's DELETE runs from the deploy engine, which never sets
  //    `DeleteContext.removeProtection` — `delete()` below gates its
  //    `SetTerminationProtection` flip-off on exactly that field. See
  //    `../replacement-protection-advice.ts`.
  //
  // The RECORDED bag is the one to read: both refusals fire before any
  // `SetTerminationProtection` / `ModifyCluster*` call in this method, so at
  // this point AWS still holds what `previousProperties` records.
  // A THUNK, not a value: both refusals are defence-in-depth arms that fire
  // only when the replacement layer was bypassed, so building an ~900-char
  // sentence on every ordinary `update()` would be pure waste.
  const replaceRemedy = (): string => {
    // With the run's flags (go-to-k/cdkd#6245).
    const replaceFlags = deployReplaceCommand(true);
    // `toBoolean` is the SAME predicate this provider's own wire read uses
    // (`create()` / the `SetTerminationProtection` arm), not
    // `isTruthyCfnBoolean`: the two disagree on `TerminationProtected: 1`,
    // which `toBoolean` SENDS as protected while the CFn-boolean helper reads
    // as unprotected -- so the short advice would go to a cluster AWS really
    // is protecting. Sharing the wire's predicate is the `config-shape.ts`
    // rule applied to a read.
    return toBoolean(prevInstances['TerminationProtected']) === true
      ? protectedReplacementAdvice({
          evidence:
            "cdkd's recorded properties for this cluster carry " +
            'Instances.TerminationProtected: true',
          replaceFlags,
          disable: {
            before: 'aws emr modify-cluster-attributes --cluster-id',
            identifier: physicalId,
            after: '--no-termination-protected',
          },
        })
      : `Re-deploy with ${replaceFlags}, or destroy + redeploy the stack.`;
  };

  let instancesPlan: InstancesInPlacePlan = EMPTY_INSTANCES_PLAN;
  if (changed('Instances')) {
    // Whether a member's change REPLACES, judged on the deploy diff's own
    // predicate, so the two never disagree. A position recorded as a
    // `{{resolve:...}}` reference and handed here resolved reads as its
    // recorded reference for this judgement only (as the top-level loop
    // below exempts one, go-to-k/cdkd#4275): the diff compares references
    // as written, so a reference the template EDITED in a replacing part was
    // a replacement and never reaches this method. The in-place
    // sub-members are planned below from the RAW sides, so an in-place edit
    // is never dropped behind a reference that stood beside it.
    // A `***` (NoEcho) value carries no `{{resolve:` token, so it is left
    // as is: it compares unequal and is refused, the safe direction.
    const mask = context?.maskSecrets;
    const isReplacingMember = (key: string): boolean =>
      emrClusterInstancesReplaced(
        { [key]: prevInstances[key] },
        { [key]: withRecordedReferences(nextInstances[key], prevInstances[key], mask) }
      );
    const movedKeys = [
      ...new Set([...Object.keys(nextInstances), ...Object.keys(prevInstances)]),
    ].filter((key) => !jsonEqual(nextInstances[key], prevInstances[key]));
    // An ABSENT block reads as `{}` (as `nextInstances` / `prevInstances`
    // do), so a lone in-place member on one side is still applied; any other
    // block that is not an object is compared whole.
    const blockIsObject = (value: unknown): boolean =>
      value == null || (typeof value === 'object' && !Array.isArray(value));
    const blocksAreObjects =
      blockIsObject(properties['Instances']) && blockIsObject(previousProperties['Instances']);
    const replacing = blocksAreObjects
      ? movedKeys.some(isReplacingMember)
      : emrClusterInstancesReplaced(previousProperties['Instances'], properties['Instances']);
    if (replacing) {
      // The members are judged key by key, so this names a member that
      // replaces, never an in-place one moved beside it. A block that is not
      // an object is named whole.
      const named = blocksAreObjects ? movedKeys.find(isReplacingMember) : undefined;
      const subject =
        named === undefined
          ? safeMsg`AWS EMR Cluster's Instances block`
          : safeMsg`AWS EMR Cluster Instances.${named}`;
      throw new ResourceUpdateNotSupportedError(
        resourceType,
        logicalId,
        `${subject} cannot be updated in place — CloudFormation replaces the cluster for this change. ` +
          replaceRemedy()
      );
    }
    instancesPlan = planInstancesInPlace(prevInstances, nextInstances);
  }
  const terminationProtectedChanged = instancesPlan.terminationProtected;

  // Any changed top-level property that is neither registry-createOnly
  // (which never reaches here) nor a known mutable one is refused. This
  // guard fires only if the replacement layer is bypassed. A secret-derived
  // value (a `Name`, a `KerberosAttributes` password) is recorded as its
  // `{{resolve:...}}` reference and handed here resolved, which is no change
  // (go-to-k/cdkd#4275).
  for (const key of Object.keys({ ...properties, ...previousProperties })) {
    if (key === 'Instances') continue;
    if (!changed(key)) continue;
    if (
      !MUTABLE_TOP_LEVEL_PROPS.has(key) &&
      !(await unchangedBehindSecretReference({
        resourceType,
        key,
        desired: properties[key],
        previous: previousProperties[key],
        maskSecrets: context?.maskSecrets,
      }))
    ) {
      throw new ResourceUpdateNotSupportedError(
        resourceType,
        logicalId,
        safeMsg`AWS EMR Cluster ${key} is immutable on AWS — it is fixed at cluster creation. ` +
          replaceRemedy()
      );
    }
  }

  // REMOVING `UnhealthyNodeReplacement` has no value to send: CloudFormation
  // fails that update ("Internal Failure", then a rollback; raw CFn A/B on
  // go-to-k/cdkd#5422), so cdkd refuses it before any call. A rollback
  // replay cannot edit the template, so it keeps the live value and warns.
  if (
    instancesPlan.unhealthyNodeReplacement &&
    nextInstances['UnhealthyNodeReplacement'] === undefined
  ) {
    const removal = safeMsg`${logicalId} (AWS::EMR::Cluster): removing Instances.UnhealthyNodeReplacement fails under CloudFormation too (its update ends in Internal Failure and rolls back). Declare it explicitly instead (true is EMR's default).`;
    if (!context?.replayingState) {
      throw new ResourceUpdateNotSupportedError(resourceType, logicalId, removal);
    }
    this.logger.warn(safeMsg`${removal} The rollback leaves the live value in place.`);
    instancesPlan = { ...instancesPlan, unhealthyNodeReplacement: false };
  }

  // A count or capacity that is PRESENT but not a number (a `***` NoEcho
  // value on a rollback replay, an intrinsic left unresolved) would reach
  // the delegates as absent and be sent as 0, scaling a TASK group or fleet
  // away. Refused before any call; a replay keeps the live size and warns.
  // A fleet capacity REMOVED from the template has no value to send either:
  // CloudFormation fails that update ("should have both targetOnDemandCapacity
  // and targetSpotCapacity specified"; raw CFn A/B on go-to-k/cdkd#5422), so
  // it is refused the same way rather than sent as 0.
  const unusable = (
    resize: InstancesResize,
    keys: readonly string[],
    refuseRemoval: boolean
  ): string | undefined => {
    for (const key of keys) {
      if (resize.next[key] !== undefined && toNumber(resize.next[key]) === undefined) {
        return safeMsg`Instances.${resize.path}.${key} is not a number, so cdkd cannot resize to it.`;
      }
      if (refuseRemoval && resize.next[key] === undefined && resize.prev[key] !== undefined) {
        return key === 'InstanceCount'
          ? safeMsg`removing Instances.${resize.path}.${key} is refused: CloudFormation requires it, and sending none would scale the group to 0. Declare it explicitly instead.`
          : safeMsg`removing Instances.${resize.path}.${key} fails under CloudFormation too (ModifyInstanceFleet needs both capacities). Declare it explicitly instead (0 for none).`;
      }
    }
    return undefined;
  };
  const keepNumeric = (
    resizes: readonly InstancesResize[],
    keys: readonly string[],
    refuseRemoval = false
  ): InstancesResize[] =>
    resizes.filter((resize) => {
      const why = unusable(resize, keys, refuseRemoval);
      if (why === undefined) return true;
      const message = safeMsg`${logicalId} (AWS::EMR::Cluster): ` + why;
      if (!context?.replayingState) {
        throw new ResourceUpdateNotSupportedError(resourceType, logicalId, message);
      }
      this.logger.warn(
        keys.includes('InstanceCount') &&
          !jsonEqual(resize.prev['AutoScalingPolicy'], resize.next['AutoScalingPolicy'])
          ? safeMsg`${message} The rollback leaves the live size in place, and the group's AutoScalingPolicy change is not applied either.`
          : safeMsg`${message} The rollback leaves the live size in place.`
      );
      return false;
    });
  instancesPlan = {
    ...instancesPlan,
    groups: keepNumeric(instancesPlan.groups, ['InstanceCount'], true),
    fleets: keepNumeric(instancesPlan.fleets, FLEET_IN_PLACE_MEMBERS, true),
  };

  // Every refusal above came first: now find what each resize addresses,
  // still before any call that changes AWS.
  let instancesTargets = NO_INSTANCES_TARGETS;
  if (instancesPlan.groups.length > 0 || instancesPlan.fleets.length > 0) {
    try {
      instancesTargets = await this.resolveInstancesTargets(logicalId, physicalId, instancesPlan);
    } catch (error) {
      if (error instanceof ProvisioningError) throw error;
      const cause = error instanceof Error ? error : undefined;
      throw this.wrapCaughtError(
        context?.maskSecrets,
        error,
        (text) =>
          new ProvisioningError(
            `Failed to update EMR Cluster ${logicalId}: ${text}`,
            resourceType,
            logicalId,
            physicalId,
            cause
          )
      );
    }
  }

  // Issue #1160: a LEFT_IN_PLACE_ON_REMOVAL property removed from the
  // desired side has nothing to send — ModifyCluster keeps a field it is not
  // sent, and cdkd sends no reset, as CloudFormation leaves it
  // (LEFT_IN_PLACE_ON_REMOVAL). Counting it as a change only issued a
  // ModifyCluster carrying no update field. Named once, and only after the
  // update SUCCEEDED (the shared caller's warning has the same timing): a
  // retried attempt would repeat it. Not on `drift --revert`: its previous
  // side is an AWS readback, so a key the desired side lacks was never
  // removed from a template.
  const removed = context?.removedProperties;
  const leftInPlaceNames = LEFT_IN_PLACE_ON_REMOVAL.filter((key) =>
    removed !== undefined
      ? removed.has(key)
      : properties[key] === undefined && previousProperties[key] !== undefined
  );
  const warnLeftInPlace = (): void => {
    if (leftInPlaceNames.length === 0 || context?.desiredFromAwsReadback) return;
    this.logger.warn(
      leftInPlaceWarning(
        logicalId,
        leftInPlaceNames,
        context?.replayingState ? 'rollback' : 'deploy'
      )
    );
  };

  const visibleChanged = changed('VisibleToAllUsers');
  const stepConcurrencyChanged =
    changed('StepConcurrencyLevel') && properties['StepConcurrencyLevel'] !== undefined;
  const managedScalingChanged = changed('ManagedScalingPolicy');
  const autoTerminationChanged = changed('AutoTerminationPolicy');
  const tagsChanged = changed('Tags');

  if (
    !terminationProtectedChanged &&
    !instancesPlan.unhealthyNodeReplacement &&
    instancesPlan.groups.length === 0 &&
    instancesPlan.fleets.length === 0 &&
    !visibleChanged &&
    !stepConcurrencyChanged &&
    !managedScalingChanged &&
    !autoTerminationChanged &&
    !tagsChanged
  ) {
    this.logger.debug(`No mutable diff for EMR Cluster ${logicalId}, skipping update`);
    warnLeftInPlace();
    return { physicalId, wasReplaced: false };
  }

  this.logger.debug(`Updating EMR Cluster ${logicalId}: ${physicalId}`);

  try {
    if (terminationProtectedChanged) {
      await this.getClient().send(
        new SetTerminationProtectionCommand({
          JobFlowIds: [physicalId],
          TerminationProtected: toBoolean(nextInstances['TerminationProtected']) ?? false,
        })
      );
    }

    if (instancesPlan.unhealthyNodeReplacement) {
      await this.getClient().send(
        new SetUnhealthyNodeReplacementCommand({
          JobFlowIds: [physicalId],
          UnhealthyNodeReplacement: toBoolean(nextInstances['UnhealthyNodeReplacement']),
        })
      );
    }

    await this.applyInstancesResizes(
      logicalId,
      physicalId,
      instancesTargets,
      resizeDeadline,
      context?.maskSecrets
    );

    if (visibleChanged) {
      await this.getClient().send(
        new SetVisibleToAllUsersCommand({
          JobFlowIds: [physicalId],
          VisibleToAllUsers: toBoolean(properties['VisibleToAllUsers']) ?? false,
        })
      );
    }

    if (stepConcurrencyChanged) {
      await this.getClient().send(
        new ModifyClusterCommand({
          ClusterId: physicalId,
          StepConcurrencyLevel: toNumber(properties['StepConcurrencyLevel']),
        })
      );
    }

    if (managedScalingChanged) {
      const next = this.toManagedScalingPolicy(
        properties['ManagedScalingPolicy'] as Record<string, unknown> | undefined
      );
      if (next) {
        await this.getClient().send(
          new PutManagedScalingPolicyCommand({
            ClusterId: physicalId,
            ManagedScalingPolicy: next,
          })
        );
      } else {
        await this.getClient().send(
          new RemoveManagedScalingPolicyCommand({ ClusterId: physicalId })
        );
      }
    }

    if (autoTerminationChanged) {
      const next = this.toAutoTerminationPolicy(
        properties['AutoTerminationPolicy'] as Record<string, unknown> | undefined
      );
      if (next && next.IdleTimeout !== undefined) {
        await this.getClient().send(
          new PutAutoTerminationPolicyCommand({
            ClusterId: physicalId,
            AutoTerminationPolicy: next,
          })
        );
      } else {
        await this.getClient().send(
          new RemoveAutoTerminationPolicyCommand({ ClusterId: physicalId })
        );
      }
    }

    if (tagsChanged) {
      await this.applyTagDiff(
        physicalId,
        resourceType,
        logicalId,
        previousProperties['Tags'],
        properties['Tags']
      );
    }

    // Re-derive attributes so the deploy engine's state write keeps
    // GetAtt-served attributes (MasterPublicDNS) fresh. Best-effort: the
    // real update already succeeded, so a transient Describe failure must
    // not fail (and roll back) the whole update.
    let cluster: Cluster | undefined;
    try {
      const resp = await this.getClient().send(
        new DescribeClusterCommand({ ClusterId: physicalId })
      );
      cluster = resp.Cluster;
    } catch (describeError) {
      this.logger.debug(
        `Post-update attribute refresh for ${physicalId} failed (returning without attributes): ${
          describeAwsFailure(describeError).detail
        }`
      );
    }

    this.logger.debug(`Successfully updated EMR Cluster ${logicalId}`);
    warnLeftInPlace();

    return {
      physicalId,
      wasReplaced: false,
      ...(cluster && { attributes: this.buildAttributes(cluster) }),
    };
  } catch (error) {
    if (error instanceof ProvisioningError) throw error;
    const cause = error instanceof Error ? error : undefined;
    throw this.wrapCaughtError(
      context?.maskSecrets,
      error,
      (text) =>
        new ProvisioningError(
          `Failed to update EMR Cluster ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          physicalId,
          cause
        )
    );
  }
}

/**
 * Apply a `Tags` diff via `AddTags` / `RemoveTags`. Full-tag-removal is
 * handled explicitly (a tag present before and absent now must be removed
 * via `RemoveTags` — mirrors the #981 ECR regression class where an empty
 * desired tag set silently left the old tags in place). Both sides are read
 * through `planTagDiff` (go-to-k/cdkd#3994): an unreadable record untags
 * nothing.
 */
export async function applyTagDiff(
  this: EMRClusterProvider,
  physicalId: string,
  resourceType: string,
  logicalId: string,
  prevTagsRaw: unknown,
  nextTagsRaw: unknown
): Promise<void> {
  const plan = planTagDiff(prevTagsRaw, nextTagsRaw);
  const tagWarning = tagPlanWarning(plan, resourceType, logicalId);
  if (tagWarning !== undefined) {
    this.logger.warn(tagWarning);
  }
  const toSet: Tag[] = [...plan.set].map(([Key, Value]) => ({ Key, Value }));
  const toRemove = plan.remove;

  if (toRemove.length > 0) {
    await this.getClient().send(
      new RemoveTagsCommand({ ResourceId: physicalId, TagKeys: toRemove })
    );
  }
  if (toSet.length > 0) {
    await this.getClient().send(new AddTagsCommand({ ResourceId: physicalId, Tags: toSet }));
  }
}
