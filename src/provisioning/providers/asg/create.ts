import type { ASGProvider } from '../asg-provider.js';
import {
  CreateAutoScalingGroupCommand,
  UpdateAutoScalingGroupCommand,
  DeleteAutoScalingGroupCommand,
  EnableMetricsCollectionCommand,
  PutNotificationConfigurationCommand,
  type InstanceLifecyclePolicy,
} from '@aws-sdk/client-auto-scaling';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import { ProvisioningError } from '../../../utils/error-handler.js';
import { generatedNameFor } from '../../resource-name.js';
import type { ResourceCreateResult, CreateContext, SecretMasker } from '../../../types/resource.js';
import { pasteableAwsCommand } from '../../replacement-protection-advice.js';
import { markAuxiliaryFailure, markCreatedBeforeFailure } from '../../auxiliary-failure.js';
import { reportCreatedResource, retractCreatedResource } from '../../created-resource-sink.js';
import { markNonRetryable } from '../../../deployment/retryable-errors.js';
import {
  secretDerivedCause,
  listWhat,
  readLists,
  malformedKinds,
  itemsOf,
  zoneMembers,
  holdsAllKnownMetrics,
} from './shared.js';

// ─── Dispatch ─────────────────────────────────────────────────────

/**
 * The `context` parameter is read for ONE thing: `maskSecrets` (issue #1932
 * item 3, adopted here by issue #1997).
 *
 * An earlier revision of this comment claimed the create path had no site to
 * mask, on the grounds that it names "only the logical id and the generated
 * group name". Both halves were wrong: `groupName` falls back to a generated
 * name only when `AutoScalingGroupName` is ABSENT, so when the template
 * DECLARES it the value is a resolved property value — and it IS logged, on
 * the line below. Debug level is not an exemption; the contract's rule is any
 * log line that interpolates a value from the `properties` bag, and this
 * provider already masks its convergence-poll debug line for that reason.
 */
export async function create(
  this: ASGProvider,
  logicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  context?: CreateContext
): Promise<ResourceCreateResult> {
  if (resourceType !== 'AWS::AutoScaling::AutoScalingGroup') {
    throw new ProvisioningError(
      `Unsupported resource type: ${resourceType}`,
      resourceType,
      logicalId
    );
  }

  const groupName =
    (properties['AutoScalingGroupName'] as string | undefined) ||
    generatedNameFor('AWS::AutoScaling::AutoScalingGroup', logicalId);

  // ONE masked sink for this method's own lines (issue #1997).
  const maskSecrets: SecretMasker = context?.maskSecrets ?? ((text) => text);
  const debug = (message: string): void => this.logger.debug(maskSecrets(message));
  debug(`Creating AutoScalingGroup ${logicalId}: ${maskSecrets(groupName)}`);

  // A malformed list would otherwise reach the SDK cast as `string[]`, whose
  // serializer walks a string character by character (go-to-k/cdkd#3948).
  const lists = readLists(
    {
      Tags: properties['Tags'],
      LoadBalancerNames: properties['LoadBalancerNames'],
      TargetGroupARNs: properties['TargetGroupARNs'],
      MetricsCollection: properties['MetricsCollection'],
      LifecycleHookSpecificationList: properties['LifecycleHookSpecificationList'],
      TrafficSources: properties['TrafficSources'],
      NotificationConfigurations: properties['NotificationConfigurations'],
    },
    'desired'
  );
  const malformedOnCreate = malformedKinds(lists);
  if (malformedOnCreate.length > 0) {
    throw markNonRetryable(
      new ProvisioningError(
        `${malformedOnCreate.join(' / ')} of AutoScalingGroup ${logicalId} is not a list of ` +
          `${malformedOnCreate.map(listWhat).join(' / ')}` +
          `${secretDerivedCause(malformedOnCreate, lists)} — the group was not created`,
        resourceType,
        logicalId
      )
    );
  }

  // Set only when a failed create-time wiring could not be fully retired.
  let survivorNote: string | undefined;
  try {
    const launchTemplate = this.buildLaunchTemplate(properties);
    const tags = this.buildTags(groupName, properties);
    const vpcZoneIdentifier = this.joinVpcZoneIdentifier(properties['VPCZoneIdentifier']);
    // A rollback re-create from a record holding both zone members (#2762).
    const createZones = zoneMembers(properties, context?.replayingState === true);

    const minSize = properties['MinSize'] != null ? Number(properties['MinSize']) : 0;
    const maxSize = properties['MaxSize'] != null ? Number(properties['MaxSize']) : minSize;

    await this.getCreateClient().send(
      new CreateAutoScalingGroupCommand({
        AutoScalingGroupName: groupName,
        MinSize: minSize,
        MaxSize: maxSize,
        ...(properties['DesiredCapacity'] != null && {
          DesiredCapacity: Number(properties['DesiredCapacity']),
        }),
        ...(launchTemplate && { LaunchTemplate: launchTemplate }),
        ...(properties['MixedInstancesPolicy'] !== undefined && {
          MixedInstancesPolicy: properties['MixedInstancesPolicy'] as never,
        }),
        ...(vpcZoneIdentifier !== undefined && { VPCZoneIdentifier: vpcZoneIdentifier }),
        ...(createZones.AvailabilityZones !== undefined && {
          AvailabilityZones: createZones.AvailabilityZones,
        }),
        ...(createZones.AvailabilityZoneIds !== undefined && {
          AvailabilityZoneIds: createZones.AvailabilityZoneIds,
        }),
        ...(properties['PlacementGroup'] !== undefined && {
          PlacementGroup: properties['PlacementGroup'] as string,
        }),
        ...(properties['InstanceLifecyclePolicy'] !== undefined && {
          InstanceLifecyclePolicy: properties['InstanceLifecyclePolicy'] as InstanceLifecyclePolicy,
        }),
        ...(properties['HealthCheckType'] !== undefined && {
          HealthCheckType: properties['HealthCheckType'] as string,
        }),
        ...(properties['HealthCheckGracePeriod'] != null && {
          HealthCheckGracePeriod: Number(properties['HealthCheckGracePeriod']),
        }),
        ...(properties['Cooldown'] != null && {
          DefaultCooldown: Number(properties['Cooldown']),
        }),
        ...(properties['DefaultCooldown'] != null && {
          DefaultCooldown: Number(properties['DefaultCooldown']),
        }),
        ...(properties['TerminationPolicies'] !== undefined && {
          TerminationPolicies: properties['TerminationPolicies'] as string[],
        }),
        ...(properties['NewInstancesProtectedFromScaleIn'] !== undefined && {
          NewInstancesProtectedFromScaleIn: properties[
            'NewInstancesProtectedFromScaleIn'
          ] as boolean,
        }),
        ...(properties['CapacityRebalance'] !== undefined && {
          CapacityRebalance: properties['CapacityRebalance'] as boolean,
        }),
        ...(properties['ServiceLinkedRoleARN'] !== undefined && {
          ServiceLinkedRoleARN: properties['ServiceLinkedRoleARN'] as string,
        }),
        ...(properties['MaxInstanceLifetime'] != null && {
          MaxInstanceLifetime: Number(properties['MaxInstanceLifetime']),
        }),
        ...(properties['LoadBalancerNames'] != null && {
          LoadBalancerNames: itemsOf(lists.LoadBalancerNames) as string[],
        }),
        ...(properties['TargetGroupARNs'] != null && {
          TargetGroupARNs: itemsOf(lists.TargetGroupARNs) as string[],
        }),
        ...(properties['Context'] !== undefined && {
          Context: properties['Context'] as string,
        }),
        ...(properties['DesiredCapacityType'] !== undefined && {
          DesiredCapacityType: properties['DesiredCapacityType'] as string,
        }),
        ...(properties['DefaultInstanceWarmup'] != null && {
          DefaultInstanceWarmup: Number(properties['DefaultInstanceWarmup']),
        }),
        ...(properties['LifecycleHookSpecificationList'] != null && {
          LifecycleHookSpecificationList: properties['LifecycleHookSpecificationList'] as never,
        }),
        ...(properties['TrafficSources'] != null && {
          TrafficSources: properties['TrafficSources'] as never,
        }),
        ...(properties['AvailabilityZoneDistribution'] !== undefined && {
          AvailabilityZoneDistribution: properties['AvailabilityZoneDistribution'] as never,
        }),
        ...(properties['AvailabilityZoneImpairmentPolicy'] !== undefined && {
          AvailabilityZoneImpairmentPolicy: properties['AvailabilityZoneImpairmentPolicy'] as never,
        }),
        ...(properties['SkipZonalShiftValidation'] !== undefined && {
          SkipZonalShiftValidation: properties['SkipZonalShiftValidation'] as boolean,
        }),
        ...(properties['CapacityReservationSpecification'] !== undefined && {
          CapacityReservationSpecification: properties['CapacityReservationSpecification'] as never,
        }),
        ...(properties['InstanceMaintenancePolicy'] !== undefined && {
          InstanceMaintenancePolicy: properties['InstanceMaintenancePolicy'] as never,
        }),
        ...(properties['DeletionProtection'] !== undefined && {
          DeletionProtection: properties['DeletionProtection'] as never,
        }),
        ...(tags.length > 0 && { Tags: tags }),
      })
    );
    // go-to-k/cdkd#5511: report before the wiring calls.
    reportCreatedResource(logicalId, resourceType, groupName);

    // `CreateAutoScalingGroup` takes neither `MetricsCollection` nor
    // `NotificationConfigurations`: each rides its own API, which only the
    // update diff helpers used to send, so a first deploy silently lacked both
    // (go-to-k/cdkd#3995). One call PER ENTRY, from the lists `readLists`
    // validated above: CDK renders one `MetricsCollection` entry per
    // `GroupMetrics`, all at `1Minute`, and each must be enabled (the update
    // helper's per-granularity map would keep only the last). CloudFormation
    // reports CREATE_FAILED and rolls the group back when either fails, so a
    // failure here retires the group before re-throwing.
    try {
      for (const entry of itemsOf(lists.MetricsCollection) as Array<{
        Granularity: string;
        Metrics?: string[] | null;
      }>) {
        await this.getClient().send(
          new EnableMetricsCollectionCommand({
            AutoScalingGroupName: groupName,
            Granularity: entry.Granularity,
            ...(entry.Metrics && entry.Metrics.length > 0 && !holdsAllKnownMetrics(entry.Metrics)
              ? { Metrics: entry.Metrics }
              : {}),
          })
        );
      }
      for (const entry of itemsOf(lists.NotificationConfigurations) as Array<{
        TopicARN: string;
        NotificationTypes?: string[] | null;
      }>) {
        await this.getClient().send(
          new PutNotificationConfigurationCommand({
            AutoScalingGroupName: groupName,
            TopicARN: entry.TopicARN,
            NotificationTypes: entry.NotificationTypes ?? [],
          })
        );
      }
    } catch (wiringError) {
      survivorNote = await this.retireFailedCreate(groupName, logicalId, properties, maskSecrets);
      if (survivorNote === undefined) retractCreatedResource(logicalId, resourceType, groupName);
      // The group itself was created: an error from its wiring is an
      // auxiliary object's, never this group's name collision (#3826).
      throw markAuxiliaryFailure(wiringError, logicalId);
    }

    debug(`Successfully created AutoScalingGroup ${logicalId}: ${maskSecrets(groupName)}`);

    const arn = await this.fetchArn(groupName, maskSecrets);
    const attributes: Record<string, unknown> = {};
    if (arn) attributes['Arn'] = arn;
    if (launchTemplate?.LaunchTemplateId) {
      attributes['LaunchTemplateID'] = launchTemplate.LaunchTemplateId;
    }
    return { physicalId: groupName, attributes };
  } catch (error) {
    const cause = error instanceof Error ? error : undefined;
    // A retire that could not finish is APPENDED, never swapped in: the
    // user needs the wiring failure AND the survivor (#2169's rule). That
    // error is also NON-RETRYABLE: a replayed create can only meet the
    // surviving group ("already exists"), and the retry would throw THAT,
    // dropping the survivor note — while the note's own AWS text (a missing
    // `autoscaling:DeleteAutoScalingGroup` grant reads as IAM propagation)
    // would otherwise classify as retryable.
    // The AWS text goes through the operation's masker: a 5xx or a refusal
    // can quote a resolved secret-derived value (issue #2176).
    const failure = this.wrapCaughtError(
      maskSecrets,
      error,
      (text) =>
        new ProvisioningError(
          `Failed to create AutoScalingGroup ${logicalId}: ${text}` +
            (survivorNote === undefined ? '' : ` ${survivorNote}`),
          resourceType,
          logicalId,
          groupName,
          cause
        )
    );
    if (survivorNote === undefined) throw failure;
    // go-to-k/cdkd#4583: the retire could not remove the group this call
    // created, so name it for the failed-CREATE journal.
    markCreatedBeforeFailure(markNonRetryable(failure), logicalId, resourceType, groupName);
    throw failure;
  }
}

/**
 * Retire a group whose create-time wiring failed, as CloudFormation's
 * CREATE_FAILED rollback does (go-to-k/cdkd#3995). The group was created by
 * THIS call under the name it was sent, so every call below can only reach
 * it. In order:
 *
 * 1. ONE `UpdateAutoScalingGroup` scales it to zero (and clears a
 *    template-set `DeletionProtection`), so no launch STARTS after step 2
 *    has listed the instances. Non-fatal, as in `delete()`: when it fails, a
 *    protection-only update is sent on its own, and the delete is attempted
 *    either way, reporting its own refusal.
 * 2. EC2 termination protection is flipped off on every instance listed,
 *    in two passes — once after the scale-down and again right before the
 *    delete — which NARROWS the window for a launch in flight at the first
 *    read (#796: a `ForceDelete` cannot terminate a protected instance,
 *    which orphans), and retries a flip the first pass could not make.
 * 3. `ForceDelete`, then the wait for the group to be gone.
 *
 * Returns `undefined` when the group is gone, or the note naming the
 * survivor and its manual retire command. Never throws: the wiring error is
 * what the caller re-throws, with this note APPENDED to the thrown message
 * (`.claude/rules/provider-diff-record-folds.md`) rather than logged, so the
 * survivor reaches every surface that reports the failure.
 */
export async function retireFailedCreate(
  this: ASGProvider,
  groupName: string,
  logicalId: string,
  properties: Record<string, unknown>,
  maskSecrets: SecretMasker
): Promise<string | undefined> {
  const debug = (message: string): void => this.logger.debug(maskSecrets(message));
  let deleteAccepted = false;
  try {
    const protection = properties['DeletionProtection'];
    try {
      await this.getClient().send(
        new UpdateAutoScalingGroupCommand({
          AutoScalingGroupName: groupName,
          MinSize: 0,
          MaxSize: 0,
          DesiredCapacity: 0,
          ...(protection != null &&
            protection !== 'none' && { DeletionProtection: 'none' as never }),
        })
      );
    } catch (scaleError) {
      debug(
        `Could not scale AutoScalingGroup ${logicalId} to zero before retiring it: ` +
          describeAwsFailure(scaleError).detail
      );
      // The combined call can be refused TRANSIENTLY on a group still
      // launching (`ResourceContention`, `ScalingActivityInProgress`), which
      // would leave the template's protection on and the delete refused:
      // lift the protection on its own.
      if (protection != null && protection !== 'none') {
        try {
          await this.getClient().send(
            new UpdateAutoScalingGroupCommand({
              AutoScalingGroupName: groupName,
              DeletionProtection: 'none' as never,
            })
          );
        } catch (liftError) {
          debug(
            `Could not clear DeletionProtection on AutoScalingGroup ${logicalId} before ` +
              `retiring it: ${describeAwsFailure(liftError).detail}`
          );
        }
      }
    }
    const flipped = new Set<string>();
    await this.removeInstanceTerminationProtection(groupName, logicalId, maskSecrets, flipped);
    await this.removeInstanceTerminationProtection(groupName, logicalId, maskSecrets, flipped);
    await this.getClient().send(
      new DeleteAutoScalingGroupCommand({ AutoScalingGroupName: groupName, ForceDelete: true })
    );
    deleteAccepted = true;
    await this.waitForGroupDeleted(groupName);
    debug(`Retired AutoScalingGroup ${logicalId} after its create-time wiring failed`);
    return undefined;
  } catch (cleanupError) {
    const outcome = deleteAccepted
      ? `cdkd started deleting it but could not confirm it is gone`
      : `cdkd could not delete it`;
    // The note joins the THROWN (persisted) message, so an AWS-authored
    // cleanup failure is named by its class there, and AWS's text goes to
    // debug (go-to-k/cdkd#2319): a denied DeleteAutoScalingGroup names the
    // caller's assumed-role ARN.
    const cleanupFailure = describeAwsFailure(cleanupError);
    if (cleanupFailure.redacted) {
      debug(
        `Retiring AutoScalingGroup ${logicalId} after its create-time wiring failed did not ` +
          `finish: ${cleanupFailure.detail}`
      );
    }
    return maskSecrets(
      `The group was created, and ${outcome} (` +
        `${cleanupFailure.summary}); outside a rollback's re-create, the failed deploy's rollback journal records ` +
        `it for \`cdkd rollback --revert-failed\`; otherwise delete it yourself before the next deploy: ` +
        pasteableAwsCommand(
          maskSecrets
        )`aws autoscaling delete-auto-scaling-group --auto-scaling-group-name ${groupName} --force-delete`.render()
    );
  }
}
