import { isDeepStrictEqual } from 'node:util';
import {
  DescribeInstancesCommand,
  ModifyInstanceAttributeCommand,
  ModifyInstanceMetadataOptionsCommand,
  ModifyInstanceCreditSpecificationCommand,
  MonitorInstancesCommand,
  UnmonitorInstancesCommand,
} from '@aws-sdk/client-ec2';
import { blockDeviceMappingsDifferOnlyInDeleteOnTermination } from '../../../analyzer/replacement-rules.js';
import {
  CdkdError,
  ProvisioningError,
  ResourceUpdateNotSupportedError,
} from '../../../utils/error-handler.js';
import {
  coerceCfnBoolean,
  configBooleanRefusal,
  configStringRefusal,
  requireConfigString,
} from '../../config-shape.js';
import { refuseMalformedDesiredTags } from '../../tag-list.js';
import { maskerOrIdentity } from '../../masked-retry-logger.js';
import type { UpdateContext, ResourceUpdateResult } from '../../../types/resource.js';
import { safeMsg } from '../../../utils/display-safe.js';
import { markNonRetryable } from '../../../deployment/retryable-errors.js';
import { isInterruptedWaitError } from '../../interrupt-watch.js';
import { sameCreateOnlySent } from './common.js';
import {
  INSTANCE_CREATE_ONLY_SENT,
  type InstanceMemberPlan,
  type InstanceVolume,
  describedInstanceAttributes,
  holdsVolume,
  instanceProfileKey,
  instanceVolumeEntries,
  instanceVolumesRefusal,
  instanceSsmAssociationEntries,
  instanceSsmAssociationsRefusal,
  isRecordedStandIn,
  refusedBeforeApplying,
  sameSsmAssociations,
  sameStringSet,
  ssmAssociationsAwsRefusal,
  staleSsmAssociationRemedy,
} from './instance-support.js';
import type { EC2Provider } from '../ec2-provider.js';

export async function updateInstance(
  this: EC2Provider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>,
  context?: UpdateContext
): Promise<ResourceUpdateResult> {
  // Immutable properties (ImageId, SubnetId, KeyName, ...) and the
  // replacing shapes of SecurityGroupIds / BlockDeviceMappings are handled
  // by the deployment engine's replacement detection. InstanceType,
  // UserData, IamInstanceProfile, SecurityGroupIds and a
  // DeleteOnTermination-only BlockDeviceMappings change are applied here
  // (issue #5446; see planInstanceMemberUpdates).
  // Tags plus four of the five security-focused backfill props (#609) —
  // DisableApiTermination / Monitoring / MetadataOptions /
  // CreditSpecification — are mutable in-place, so they are diffed
  // against previousProperties and modified here. The diff guard keeps the
  // `cdkd drift --revert` no-op round-trip (`update(state, state)`) free of
  // any mutating SDK call. The fifth, EbsOptimized, can only be changed on a
  // STOPPED instance, so an EbsOptimized change is routed to replacement via
  // the ReplacementRulesRegistry rather than modified here.
  this.logger.debug(`Updating EC2 Instance ${logicalId}: ${physicalId}`);
  // go-to-k/cdkd#3994: a malformed desired Tags is refused before any call.
  refuseMalformedDesiredTags(properties['Tags'], resourceType, logicalId, physicalId);
  // Issue #1160: before any call too, so a refusal applies nothing.
  this.guardTerminationProtectionRemoval(
    logicalId,
    physicalId,
    resourceType,
    properties,
    previousProperties,
    context
  );
  // Issue #5446: decided (and every refusal raised) before any mutating
  // call, so a refused update applies nothing.
  const memberPlan = this.planInstanceMemberUpdates(
    logicalId,
    physicalId,
    resourceType,
    properties,
    previousProperties,
    context
  );

  try {
    // Reads and refusals, before the first mutating call below.
    await this.prepareInstanceMemberUpdates(logicalId, physicalId, resourceType, memberPlan);

    await this.applyTagDiff(
      physicalId,
      resourceType,
      logicalId,
      previousProperties['Tags'],
      properties['Tags'],
      maskerOrIdentity(context?.maskSecrets)
    );

    await this.updateInstanceSecurityProps(physicalId, properties, previousProperties);

    await this.applyInstanceMemberUpdates(logicalId, physicalId, resourceType, memberPlan);

    // go-to-k/cdkd#5630: after the members above, an IamInstanceProfile
    // change included, which the association needs.
    if (memberPlan.ssmAssociation !== undefined) {
      await this.applyInstanceSsmAssociationChange(
        logicalId,
        physicalId,
        resourceType,
        memberPlan.ssmAssociation,
        maskerOrIdentity(context?.maskSecrets)
      );
    }

    // Refresh attributes. The map REPLACES the record's (the engine does
    // not merge it with the previous one), and that is the right answer
    // (issue #3077): a public address disappears only on a real event — a
    // stop, an EIP change — where the previously recorded value is dead,
    // and carrying it forward would hand a downstream reference an address
    // the instance no longer has. `describedInstanceAttributes` records
    // the settled instance's public pair as the KNOWN empty CloudFormation
    // reports, and omits it only while the instance is still `pending`.
    const describeResponse = await this.ec2Client.send(
      new DescribeInstancesCommand({ InstanceIds: [physicalId] })
    );
    const instance = describeResponse.Reservations?.[0]?.Instances?.[0];

    return {
      physicalId,
      wasReplaced: false,
      attributes: describedInstanceAttributes(physicalId, instance),
    };
  } catch (error) {
    // Issue #5446: the stop/start waits throw their own non-retryable
    // ProvisioningError, and Ctrl-C an InterruptedWaitError; both pass
    // through unwrapped so the engine sees what they are.
    // A CdkdError here is cdkd-authored (a refusal, a wait's own error) and
    // carries no AWS text, so skipping wrapCaughtError's masking is safe for
    // every helper this try calls today; a helper that rethrows a CdkdError
    // built from AWS text must mask it itself.
    if (error instanceof CdkdError || isInterruptedWaitError(error)) throw error;
    const cause = error instanceof Error ? error : undefined;
    throw this.wrapCaughtError(
      maskerOrIdentity(context?.maskSecrets),
      error,
      (text) =>
        new ProvisioningError(
          `Failed to update EC2 Instance ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          physicalId,
          cause
        )
    );
  }
}

/**
 * Issue #1160: a `DisableApiTermination` the previous template declared and
 * the desired one omits. CloudFormation FAILS that update, from `true` or
 * from `false`, with or without other changes in it, and rolls the whole
 * update back ("No attributes specified": its handler sends an empty
 * ModifyInstanceAttribute). An explicit `true` <-> `false` change is applied.
 * Real A/B, us-east-1: go-to-k/cdkd#1160 issuecomment-6281778130. So a
 * forward deploy REFUSES the removal before any AWS call, and the refusal
 * names the remedy CloudFormation accepts: keep the property and declare
 * `false`.
 *
 * A rollback revert arm (`replayingState`) is undoing a failed deploy that
 * ADDED the property. The user cannot edit a state record, so a refusal there
 * would only strand the rollback. Instead it keeps the live value, and warns
 * when that value was declared `true`. `cdkd drift --revert` names no removed
 * property (`removedProperties` is empty; its previous side is an AWS
 * readback), so neither arm fires there. A direct call with no context falls
 * back to comparing the two bags.
 */
export function guardTerminationProtectionRemoval(
  this: EC2Provider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>,
  context: UpdateContext | undefined
): void {
  const removed =
    context?.removedProperties !== undefined
      ? context.removedProperties.has('DisableApiTermination')
      : previousProperties['DisableApiTermination'] !== undefined &&
        properties['DisableApiTermination'] === undefined;
  if (!removed) return;
  if (context?.replayingState === true) {
    if (this.coerceBool(previousProperties['DisableApiTermination']) === true) {
      this.logger.warn(
        safeMsg`${logicalId} (${resourceType}): the state being restored does not declare DisableApiTermination; the rollback leaves termination protection at its current AWS value. Set DisableApiTermination to false to turn termination protection off.`
      );
    }
    return;
  }
  throw markNonRetryable(
    new ProvisioningError(
      safeMsg`${logicalId} (${resourceType}): DisableApiTermination was removed from the template, and CloudFormation fails that update for an existing instance. Keep it declared, and set it to false to turn termination protection off. The instance was not updated.`,
      resourceType,
      logicalId,
      physicalId
    )
  );
}

/**
 * Apply in-place modifications for four of the five security-focused
 * backfill props (#609). Each is diffed against `previousProperties` so a
 * no-drift round-trip (`update(state, state)`) issues zero mutating calls
 * (the `cdkd drift --revert` invariant). Each maps to a distinct EC2
 * modify API:
 *   - DisableApiTermination -> ModifyInstanceAttribute
 *   - Monitoring            -> MonitorInstances / UnmonitorInstances
 *   - MetadataOptions       -> ModifyInstanceMetadataOptions
 *   - CreditSpecification   -> ModifyInstanceCreditSpecification
 * EbsOptimized is NOT here: it can only be changed on a STOPPED instance, so
 * an EbsOptimized change is routed to replacement (see ReplacementRules).
 *
 * Removal (issue #1160, real CloudFormation A/B in us-east-1): CloudFormation
 * resets a removed `Monitoring` to off, which arrives here as the `false`
 * from `removalDefaults`. It KEEPS a removed `MetadataOptions` and a removed
 * `CreditSpecification` (`HttpTokens: required` / hop limit 3 and
 * `CPUCredits: standard` stayed), so a removed one sends nothing. A removed
 * `DisableApiTermination` never reaches this method: see
 * `guardTerminationProtectionRemoval`.
 */
export async function updateInstanceSecurityProps(
  this: EC2Provider,
  physicalId: string,
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>
): Promise<void> {
  // DisableApiTermination — ModifyInstanceAttribute.
  const newDisableApiTermination = this.coerceBool(properties['DisableApiTermination']);
  const oldDisableApiTermination = this.coerceBool(previousProperties['DisableApiTermination']);
  if (
    newDisableApiTermination !== undefined &&
    newDisableApiTermination !== oldDisableApiTermination
  ) {
    await this.ec2Client.send(
      new ModifyInstanceAttributeCommand({
        InstanceId: physicalId,
        DisableApiTermination: { Value: newDisableApiTermination },
      })
    );
  }

  // EbsOptimized is intentionally NOT modified here: AWS only accepts
  // `ModifyInstanceAttribute { EbsOptimized }` against a STOPPED instance
  // (a running instance returns IncorrectInstanceState), and cdkd does not
  // stop/start instances. An EbsOptimized change is therefore routed to
  // replacement via the ReplacementRulesRegistry (AWS::EC2::Instance), where
  // the create path sets it correctly on the new instance.

  // Monitoring — MonitorInstances (enable) / UnmonitorInstances (disable).
  const newMonitoring = this.coerceBool(properties['Monitoring']);
  const oldMonitoring = this.coerceBool(previousProperties['Monitoring']);
  if (newMonitoring !== undefined && newMonitoring !== oldMonitoring) {
    if (newMonitoring) {
      await this.ec2Client.send(new MonitorInstancesCommand({ InstanceIds: [physicalId] }));
    } else {
      await this.ec2Client.send(new UnmonitorInstancesCommand({ InstanceIds: [physicalId] }));
    }
  }

  // MetadataOptions — ModifyInstanceMetadataOptions. Diff the built request
  // shape (post-coercion) so a string/number round-trip is not flagged as a
  // change.
  const newMetadata = this.buildMetadataOptions(properties);
  const oldMetadata = this.buildMetadataOptions(previousProperties);
  if (newMetadata !== undefined && !this.shallowEqual(newMetadata, oldMetadata)) {
    await this.ec2Client.send(
      new ModifyInstanceMetadataOptionsCommand({
        InstanceId: physicalId,
        ...newMetadata,
      })
    );
  }

  // CreditSpecification — ModifyInstanceCreditSpecification.
  const newCpuCredits = this.readCpuCredits(properties['CreditSpecification']);
  const oldCpuCredits = this.readCpuCredits(previousProperties['CreditSpecification']);
  if (newCpuCredits !== undefined && newCpuCredits !== oldCpuCredits) {
    await this.ec2Client.send(
      new ModifyInstanceCreditSpecificationCommand({
        InstanceCreditSpecifications: [{ InstanceId: physicalId, CpuCredits: newCpuCredits }],
      })
    );
  }
}

/**
 * Issue #5446: decide which of `InstanceType`, `UserData`,
 * `IamInstanceProfile`, `SecurityGroupIds` and a
 * `BlockDeviceMappings[].Ebs.DeleteOnTermination`-only change this update
 * applies, and raise every refusal, before any mutating call.
 *
 * What CloudFormation does, MEASURED (us-east-1, 2026-10-28, a t3.nano):
 *  - `InstanceType`, `UserData`: in place with a stop and a start (same
 *    instance, new launch time). A removed `UserData` clears it, also with
 *    a stop and start. A removed `InstanceType` FAILS the update ("No
 *    attributes specified"), so it is refused here, as
 *    `guardTerminationProtectionRemoval` refuses its sibling.
 *  - `IamInstanceProfile`: in place, no interruption; removed, the profile
 *    is disassociated.
 *  - `SecurityGroupIds` with a `SubnetId`: in place, no interruption; removed,
 *    the instance gets its VPC's `default` group. (Without a `SubnetId`
 *    CloudFormation replaces; the replacement rule routes that.)
 *  - `BlockDeviceMappings`: only a `DeleteOnTermination` change is in place;
 *    everything else is routed to replacement.
 *  - `InstanceInitiatedShutdownBehavior` (go-to-k/cdkd#5630, measured
 *    2026-11-04): in place, no interruption; a removal FAILS the update, so
 *    it is refused here.
 *  - `SourceDestCheck` (go-to-k/cdkd#5630, measured 2026-11-04): in place,
 *    no interruption; a removal sets it back to `true`.
 *  - `PlacementGroupName`, `PrivateIpAddress` (go-to-k/cdkd#5630): any
 *    change, a removal or an addition replaces the instance, so only
 *    `cdkd drift --revert` brings one here, where it is refused.
 *  - `Tenancy` (go-to-k/cdkd#5630): a recorded value changed to or from
 *    `default` (a removal included) replaces. A value the record lacks is
 *    compared with the live tenancy (no call when it matches, refused when
 *    not); a `dedicated` <-> `host` change is unmeasured and refused.
 *  - `PropagateTagsToVolumeOnCreation` (go-to-k/cdkd#5630, measured
 *    2026-11-04): applied at launch only; a change sends nothing.
 *  - `AdditionalInfo` (go-to-k/cdkd#5630, measured 2026-11-04): adding it
 *    to a running instance completes with no change, so a change sends
 *    nothing (EC2 refuses it at launch).
 *  - `Ipv6AddressCount`, `Ipv6Addresses` (go-to-k/cdkd#5630): create-only,
 *    like `PrivateIpAddress`.
 *  - `PrivateDnsNameOptions` (go-to-k/cdkd#5630, measured 2026-11-04): see
 *    `planPrivateDnsNameOptions`; a HostnameType change stops and starts.
 *  - `LaunchTemplate` (go-to-k/cdkd#5630, measured 2026-11-06): create-only;
 *    a Version change creates a new instance.
 *  - `Volumes` (go-to-k/cdkd#5630, measured 2026-11-06): attached and
 *    detached in place; see `planInstanceVolumes`.
 *  - `LicenseSpecifications` (go-to-k/cdkd#5630): create-only; any change
 *    creates a new instance.
 *  - `SsmAssociations` (go-to-k/cdkd#5630): deleted and re-created in
 *    place; see `planInstanceSsmAssociations`.
 *
 * A member is CHANGED per the engine's `changedProperties` when it is set
 * (a redacted state value cannot be compared to a resolved one), else per
 * the two bags. A member is REMOVED per `removedProperties`, else per the
 * two bags; `drift --revert` names none, and a key its readback lacks
 * (`UserData`) is therefore never cleared there.
 *
 * Refused before any call: a value the deploy cannot send (a
 * `{{resolve:...}}` token or the redaction mask, which a state record holds
 * in place of a secret) and a removed `InstanceType`. A stop on an
 * instance-store-backed instance is refused by
 * `prepareInstanceMemberUpdates`, also before any mutating call.
 */
export function planInstanceMemberUpdates(
  this: EC2Provider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>,
  context: UpdateContext | undefined
): InstanceMemberPlan {
  const plan: InstanceMemberPlan = {};
  const removed = (key: string): boolean =>
    context?.removedProperties !== undefined
      ? context.removedProperties.has(key)
      : previousProperties[key] !== undefined && properties[key] === undefined;
  const changed = (key: string, same: (a: unknown, b: unknown) => boolean): boolean => {
    const before = previousProperties[key];
    const after = properties[key];
    if (after === undefined && !removed(key)) return false;
    if (context?.changedProperties !== undefined && !context.changedProperties.has(key)) {
      return false;
    }
    // Byte-equal sides are no change, stand-ins included (a rollback revert
    // compares two state records redacted alike). Otherwise two equivalent
    // values are no change unless one is a stand-in: a redacted record
    // cannot say whether the value behind it moved.
    if (isDeepStrictEqual(before, after)) {
      // Two stand-ins alike on a rollback revert: whether the value behind
      // them moved is unknowable, so the member keeps its live value; say so.
      if (context?.replayingState === true && isRecordedStandIn(after)) {
        this.logger.warn(
          safeMsg`${logicalId} (${resourceType}): both sides of the rollback record ${key} as a stand-in (an unresolved {{resolve:...}} reference or the redaction mask), so cdkd cannot tell whether it changed; the rollback leaves ${key} at its current AWS value.`
        );
      }
      return false;
    }
    const comparable = !isRecordedStandIn(before) && !isRecordedStandIn(after);
    return !(comparable && same(before, after));
  };
  // A stand-in cannot be sent. A forward update refuses it; a rollback
  // revert (a state record on one side) keeps that member's live value
  // and warns, so the revert of the other members still runs.
  const standInSkips = (key: string): boolean => {
    if (!isRecordedStandIn(properties[key])) return false;
    if (context?.replayingState === true) {
      this.logger.warn(
        safeMsg`${logicalId} (${resourceType}): the state being restored records ${key} as a stand-in (an unresolved {{resolve:...}} reference or the redaction mask), not a value cdkd can send; the rollback leaves ${key} at its current AWS value.`
      );
      return true;
    }
    throw refusedBeforeApplying(
      new ProvisioningError(
        `${logicalId} (${resourceType}): ${key} holds a recorded stand-in (an unresolved {{resolve:...}} reference or the redaction mask), not a value cdkd can send. The instance was not updated; deploy from the template so the value resolves.`,
        resourceType,
        logicalId,
        physicalId
      )
    );
  };

  // InstanceType: a removal fails in CloudFormation.
  if (changed('InstanceType', (a, b) => a === b)) {
    if (properties['InstanceType'] === undefined) {
      if (context?.replayingState === true) {
        this.logger.warn(
          safeMsg`${logicalId} (${resourceType}): the state being restored does not declare InstanceType; the rollback leaves the instance type at its current AWS value.`
        );
      } else {
        throw refusedBeforeApplying(
          new ProvisioningError(
            safeMsg`${logicalId} (${resourceType}): InstanceType was removed from the template, and CloudFormation fails that update for an existing instance. Keep it declared (set it to the instance's current type to leave it unchanged). The instance was not updated.`,
            resourceType,
            logicalId,
            physicalId
          )
        );
      }
    } else if (!standInSkips('InstanceType')) {
      plan.instanceType = requireConfigString(
        properties['InstanceType'],
        '',
        'AWS::EC2::Instance InstanceType'
      );
    }
  }

  // CpuOptions / HibernationOptions / PlacementGroupName / PrivateIpAddress /
  // Tenancy (go-to-k/cdkd#5630): the engine replaces the instance on a
  // change, as CloudFormation does, and only `cdkd drift --revert` brings
  // one here. None changes on a running instance, so the update is refused
  // before any call rather than reported as reverted.
  const createOnlyChanged = INSTANCE_CREATE_ONLY_SENT.filter((key) =>
    changed(key, (a, b) => sameCreateOnlySent(key, a, b))
  );
  if (createOnlyChanged.length > 0) {
    throw refusedBeforeApplying(
      new ResourceUpdateNotSupportedError(
        resourceType,
        logicalId,
        `replace the instance (cdkd deploy --replace). ${createOnlyChanged.join(', ')} can be set only when the instance is launched, and CloudFormation creates a new instance for this change`
      )
    );
  }

  // Tenancy (go-to-k/cdkd#5630; `instanceTenancyChangeReplaces` decides
  // which changes the engine replaces for).
  if (changed('Tenancy', (a, b) => a === b) && !standInSkips('Tenancy')) {
    const before = previousProperties['Tenancy'];
    const after = properties['Tenancy'];
    const refusal = configStringRefusal(properties, 'Tenancy', '', resourceType);
    if (refusal !== undefined) {
      throw refusedBeforeApplying(
        new ProvisioningError(
          `${refusal}. The instance ${logicalId} was not updated.`,
          resourceType,
          logicalId,
          physicalId
        )
      );
    }
    if (before == null && typeof after === 'string') {
      // The record lacks it: an earlier cdkd under --prefer-sdk-route
      // dropped a declared Tenancy, so AWS may already hold this value.
      // Checked against the live tenancy before any mutating call.
      plan.tenancyAddition = { value: after, replaying: context?.replayingState === true };
    } else if (
      typeof before === 'string' &&
      typeof after === 'string' &&
      before !== 'default' &&
      after !== 'default'
    ) {
      // UNMEASURED: a change between two non-default tenancies
      // (dedicated <-> host) needs a Dedicated Host to measure.
      // CloudFormation may apply it in place (a stop and
      // ModifyInstancePlacement) rather than replace, so cdkd neither
      // replaces nor applies it.
      if (context?.replayingState === true) {
        this.logger.warn(
          safeMsg`${logicalId} (${resourceType}): the rollback would change Tenancy ${before} -> ${after}, which cdkd does not apply; the instance keeps its current tenancy.`
        );
      } else {
        throw refusedBeforeApplying(
          new ResourceUpdateNotSupportedError(
            resourceType,
            logicalId,
            safeMsg`cdkd does not change Tenancy ${before} -> ${after}. How CloudFormation applies a change between two non-default tenancies has not been measured (it may stop the instance and move it rather than replace it), so cdkd neither replaces the instance nor applies the change. Keep the current tenancy, or replace the instance explicitly with cdkd deploy --replace`
          )
        );
      }
    } else if (context?.replayingState === true) {
      // A rollback revert: a record that adopted Tenancy on the failed
      // deploy carries it on the previous side and not on the desired one,
      // so the revert reads it as a removal. Leave the tenancy and revert
      // the other members.
      this.logger.warn(
        safeMsg`${logicalId} (${resourceType}): the rollback would change Tenancy (${before === undefined ? 'unset' : before} -> ${after === undefined ? 'unset' : after}), which needs a new instance; the instance keeps its current tenancy.`
      );
    } else {
      // To or from `default`, or a removal: the engine replaces the instance,
      // as CloudFormation does, so only `cdkd drift --revert` (or a direct
      // call) brings one here. No call changes it on a running instance.
      throw refusedBeforeApplying(
        new ResourceUpdateNotSupportedError(
          resourceType,
          logicalId,
          'replace the instance (cdkd deploy --replace). CloudFormation creates a new instance for a Tenancy change to or from default'
        )
      );
    }
  }

  // InstanceInitiatedShutdownBehavior (go-to-k/cdkd#5630): CloudFormation
  // changes it in place with no interruption, both ways, and FAILS an update
  // that removes it ("No attributes specified"; measured us-east-1,
  // 2026-11-04, a t3.nano), so a removal is refused as InstanceType's is.
  if (changed('InstanceInitiatedShutdownBehavior', (a, b) => a === b)) {
    if (properties['InstanceInitiatedShutdownBehavior'] === undefined) {
      if (context?.replayingState === true) {
        this.logger.warn(
          safeMsg`${logicalId} (${resourceType}): the state being restored does not declare InstanceInitiatedShutdownBehavior; the rollback leaves it at its current AWS value.`
        );
      } else {
        throw refusedBeforeApplying(
          new ProvisioningError(
            safeMsg`${logicalId} (${resourceType}): InstanceInitiatedShutdownBehavior was removed from the template, and CloudFormation fails that update for an existing instance. Keep it declared (set it to stop, the default, to leave the behavior at AWS's default). The instance was not updated.`,
            resourceType,
            logicalId,
            physicalId
          )
        );
      }
    } else if (!standInSkips('InstanceInitiatedShutdownBehavior')) {
      plan.shutdownBehavior = requireConfigString(
        properties['InstanceInitiatedShutdownBehavior'],
        '',
        'AWS::EC2::Instance InstanceInitiatedShutdownBehavior'
      );
    }
  }

  // SourceDestCheck (go-to-k/cdkd#5630): CloudFormation changes it in place
  // with no interruption, and a removal sets it back to `true` (measured
  // us-east-1, 2026-11-04); the engine hands a removal over as the `true`
  // from `removalDefaults`, and a direct call's bare removal means the same.
  // An absent side is the default `true`; a malformed one is no boolean, so
  // it never compares equal to a readable side and reaches the refusal.
  const sourceDestCheckOf = (v: unknown): boolean | undefined =>
    v === undefined ? true : coerceCfnBoolean(v);
  if (
    changed('SourceDestCheck', (a, b) => sourceDestCheckOf(a) === sourceDestCheckOf(b)) &&
    !standInSkips('SourceDestCheck')
  ) {
    const raw = properties['SourceDestCheck'];
    const want = raw === undefined ? true : coerceCfnBoolean(raw);
    if (want === undefined) {
      const refusal = configBooleanRefusal(properties, 'SourceDestCheck', resourceType);
      if (context?.replayingState === true || context?.desiredFromAwsReadback === true) {
        this.logger.warn(
          safeMsg`${logicalId} (${resourceType}): ${refusal ?? 'SourceDestCheck is not a boolean'}; it is left at its current AWS value.`
        );
      } else {
        throw refusedBeforeApplying(
          new ProvisioningError(
            `${refusal ?? `${resourceType}.SourceDestCheck must be a boolean`}. The instance ${logicalId} was not updated.`,
            resourceType,
            logicalId,
            physicalId
          )
        );
      }
    } else {
      plan.sourceDestCheck = want;
    }
  }

  this.planPrivateDnsNameOptions(
    logicalId,
    physicalId,
    resourceType,
    properties,
    previousProperties,
    context,
    plan,
    changed,
    standInSkips
  );

  // UserData: a removal clears it.
  if (changed('UserData', (a, b) => a === b)) {
    const userData = properties['UserData'];
    if (userData === undefined) {
      plan.userData = new Uint8Array(0);
    } else if (!standInSkips('UserData')) {
      if (typeof userData !== 'string') {
        throw refusedBeforeApplying(
          new ProvisioningError(
            `${logicalId} (${resourceType}): UserData must be a base64 string (Fn::Base64), got a ${Array.isArray(userData) ? 'list' : typeof userData}. The instance was not updated.`,
            resourceType,
            logicalId,
            physicalId
          )
        );
      }
      // CloudFormation's UserData is base64 text. ModifyInstanceAttribute's
      // blob is the RAW bytes (the SDK base64-encodes it on the wire), so the
      // template value is decoded once here; sending its text would store
      // base64 as the user data.
      plan.userData = new Uint8Array(Buffer.from(userData, 'base64'));
    }
  }

  // IamInstanceProfile: compared by profile name (state carries the
  // template's name, a drift readback the ARN).
  if (changed('IamInstanceProfile', (a, b) => instanceProfileKey(a) === instanceProfileKey(b))) {
    if (properties['IamInstanceProfile'] === undefined) {
      plan.profile = { kind: 'remove' };
    } else if (!standInSkips('IamInstanceProfile')) {
      const desired = this.normalizeIamInstanceProfile(properties['IamInstanceProfile']);
      if (desired === undefined) {
        throw refusedBeforeApplying(
          new ProvisioningError(
            `${logicalId} (${resourceType}): IamInstanceProfile is neither a profile name, an ARN, nor an {Arn,Name} object. The instance was not updated.`,
            resourceType,
            logicalId,
            physicalId
          )
        );
      }
      plan.profile = { kind: 'set', ...desired };
    }
  }

  // SecurityGroupIds: compared as sets (the readback's order is AWS's).
  if (changed('SecurityGroupIds', (a, b) => sameStringSet(a, b))) {
    const groups = properties['SecurityGroupIds'];
    if (groups === undefined) {
      plan.securityGroups = { kind: 'vpc-default' };
    } else {
      const ids = Array.isArray(groups) ? groups : undefined;
      if (
        ids === undefined ||
        ids.length === 0 ||
        !ids.every((g) => typeof g === 'string' && g !== '')
      ) {
        throw refusedBeforeApplying(
          new ProvisioningError(
            `${logicalId} (${resourceType}): SecurityGroupIds must be a non-empty list of security group ids. The instance was not updated.`,
            resourceType,
            logicalId,
            physicalId
          )
        );
      }
      if (!standInSkips('SecurityGroupIds')) {
        plan.securityGroups = { kind: 'set', ids: ids as string[] };
      }
    }
  }

  // BlockDeviceMappings: only a DeleteOnTermination-only change reaches an
  // in-place update; anything else the replacement rule routes away, and
  // what is left here (a readback bag, a direct call) has no API.
  const beforeBdm = previousProperties['BlockDeviceMappings'];
  const afterBdm = properties['BlockDeviceMappings'];
  if (
    afterBdm !== undefined &&
    (context?.changedProperties === undefined ||
      context.changedProperties.has('BlockDeviceMappings')) &&
    blockDeviceMappingsDifferOnlyInDeleteOnTermination(beforeBdm, afterBdm)
  ) {
    const flips: Array<{ DeviceName: string; DeleteOnTermination: boolean }> = [];
    (afterBdm as Array<Record<string, unknown>>).forEach((m, i) => {
      const before = (beforeBdm as Array<Record<string, unknown>>)[i];
      const read = (x: Record<string, unknown> | undefined): boolean | undefined => {
        const ebs = x?.['Ebs'] as Record<string, unknown> | undefined;
        if (ebs === undefined || ebs === null) return undefined;
        return this.coerceBool(ebs['DeleteOnTermination']) ?? true;
      };
      const want = read(m);
      if (want !== undefined && want !== read(before) && typeof m['DeviceName'] === 'string') {
        flips.push({ DeviceName: m['DeviceName'], DeleteOnTermination: want });
      }
    });
    if (flips.length > 0) plan.deleteOnTermination = flips;
  }

  this.planInstanceVolumes(
    logicalId,
    physicalId,
    resourceType,
    properties,
    previousProperties,
    plan,
    changed
  );

  this.planInstanceSsmAssociations(
    logicalId,
    physicalId,
    resourceType,
    properties,
    previousProperties,
    plan,
    changed,
    standInSkips,
    context?.maskSecrets
  );

  return plan;
}

/**
 * go-to-k/cdkd#5630: plan an `SsmAssociations` change. CloudFormation
 * (measured us-east-1) completes only "absent -> one entry" in place; a
 * parameter change, a document change and a removal all fail the update
 * after its handler has deleted the association. cdkd applies them in place
 * instead (a deliberate deviation, see `applyInstanceSsmAssociationChange`):
 * delete the recorded association, then create the desired one.
 *
 * Refused before any call, on every path: a malformed desired list (read as
 * empty it would delete the association) and the shapes AWS refuses every
 * time (two or more entries, an entry with no `IamInstanceProfile`). A
 * desired stand-in parameter is refused on a forward update and keeps the
 * live association on a rollback revert, like every other member.
 */
export function planInstanceSsmAssociations(
  this: EC2Provider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>,
  plan: InstanceMemberPlan,
  changed: (key: string, same: (a: unknown, b: unknown) => boolean) => boolean,
  standInSkips: (key: string) => boolean,
  maskSecrets?: (text: string) => string
): void {
  const refusal =
    instanceSsmAssociationsRefusal(properties['SsmAssociations'], resourceType) ??
    ssmAssociationsAwsRefusal(properties, resourceType);
  if (refusal !== undefined) {
    throw refusedBeforeApplying(
      new ProvisioningError(
        `${refusal}. The instance ${logicalId} was not updated.`,
        resourceType,
        logicalId,
        physicalId
      )
    );
  }
  if (!changed('SsmAssociations', (a, b) => sameSsmAssociations(a, b, resourceType))) return;
  if (standInSkips('SsmAssociations')) return;
  const desired = instanceSsmAssociationEntries(properties['SsmAssociations']);
  const recorded = previousProperties['SsmAssociations'];
  const recordedUsable = instanceSsmAssociationsRefusal(recorded, resourceType) === undefined;
  const previous = recordedUsable ? instanceSsmAssociationEntries(recorded) : [];
  if (!recordedUsable && desired.length > 0) {
    // Which association is this resource's is unknowable, so none is
    // deleted: an instance takes one document, and Systems Manager's own
    // refusal then names a leftover one.
    this.logger.warn(
      safeMsg`${logicalId} (${resourceType}): the previous record's SsmAssociations is unreadable, so cdkd cannot tell which SSM association of ${physicalId} is this resource's; it deletes none and creates the declared one. ${staleSsmAssociationRemedy(physicalId, maskSecrets)}.`
    );
  } else if (!recordedUsable) {
    this.logger.warn(
      safeMsg`${logicalId} (${resourceType}): the previous record's SsmAssociations is unreadable, so cdkd cannot tell which SSM association of ${physicalId} is this resource's and deletes none. ${staleSsmAssociationRemedy(physicalId, maskSecrets)}.`
    );
  }
  plan.ssmAssociation = {
    documentNames: previous.map((e) => e.DocumentName),
    recordUnreadable: !recordedUsable,
    create: desired[0],
  };
}

/**
 * go-to-k/cdkd#5630: plan a `Volumes` change. What CloudFormation does,
 * MEASURED (us-east-1, 2026-11-06, a t3.nano): adding an entry attaches the
 * volume, removing one detaches it, a Device change detaches the volume and
 * attaches it at the new device, and removing the property detaches every
 * volume it listed, all on the same running instance. Entries compare as
 * `{ Device, VolumeId }` pairs, in any order.
 *
 * A malformed desired list is refused on every path, a rollback replay too:
 * read as empty it would detach every volume the record lists. A malformed
 * RECORDED list only hides what to detach, so the declared volumes are
 * attached (an attach finding the volume already here is a no-op) and none
 * is detached, with a warning.
 */
export function planInstanceVolumes(
  this: EC2Provider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>,
  plan: InstanceMemberPlan,
  changed: (key: string, same: (a: unknown, b: unknown) => boolean) => boolean
): void {
  const refusal = instanceVolumesRefusal(properties['Volumes'], resourceType);
  if (refusal !== undefined) {
    throw refusedBeforeApplying(
      new ProvisioningError(
        `${refusal}. The instance ${logicalId} was not updated.`,
        resourceType,
        logicalId,
        physicalId
      )
    );
  }
  const usable = (v: unknown): boolean => instanceVolumesRefusal(v, resourceType) === undefined;
  const sameVolumes = (a: unknown, b: unknown): boolean => {
    if (!usable(a) || !usable(b)) return false;
    const left = instanceVolumeEntries(a);
    const right = instanceVolumeEntries(b);
    return left.every((v) => holdsVolume(right, v)) && right.every((v) => holdsVolume(left, v));
  };
  if (!changed('Volumes', sameVolumes)) return;
  const desired = instanceVolumeEntries(properties['Volumes']);
  const recorded = previousProperties['Volumes'];
  let previous: InstanceVolume[] = [];
  if (usable(recorded)) {
    previous = instanceVolumeEntries(recorded);
  } else {
    this.logger.warn(
      safeMsg`${logicalId} (${resourceType}): the previous record's Volumes is not a list of { Device, VolumeId } entries, so cdkd cannot tell which volumes to detach; it attaches the declared volumes and detaches none.`
    );
  }
  const detach = previous.filter((v) => !holdsVolume(desired, v));
  const attach = desired.filter((v) => !holdsVolume(previous, v));
  if (detach.length > 0 || attach.length > 0) plan.volumes = { detach, attach };
}

/** The {@link EC2Provider} methods this module defines. */
export const instanceUpdateMethods = {
  updateInstance,
  guardTerminationProtectionRemoval,
  updateInstanceSecurityProps,
  planInstanceMemberUpdates,
  planInstanceVolumes,
  planInstanceSsmAssociations,
};
