import type { EMRClusterProvider } from '../emr-cluster-provider.js';
import {
  RunJobFlowCommand,
  ListClustersCommand,
  TerminateJobFlowsCommand,
  SetTerminationProtectionCommand,
  type JobFlowInstancesConfig,
  type InstanceGroupConfig,
  type InstanceFleetConfig,
  type InstanceRoleType,
  type InstanceFleetType,
  type ManagedScalingPolicy,
  type AutoTerminationPolicy,
  type RunJobFlowCommandOutput,
} from '@aws-sdk/client-emr';
import { ProvisioningError } from '../../../utils/error-handler.js';
import { markCreatedBeforeFailure } from '../../auxiliary-failure.js';
import { reportCreatedResource, retractCreatedResource } from '../../created-resource-sink.js';
import { markNonRetryable } from '../../../deployment/retryable-errors.js';
import { pasteableAwsCommand } from '../../replacement-protection-advice.js';
import { refuseMalformedDesiredTags } from '../../tag-list.js';
import {
  toSdkConfigurations,
  toSdkInstanceTypeConfigs,
  toSdkStepConfigs,
} from '../../emr-configuration.js';
import { createMaskedLogSinks, maskerOrIdentity } from '../../masked-retry-logger.js';
import {
  collectOrphanIds,
  orphanCommandRegionArg,
  reportPossibleOrphans,
} from '../orphan-report.js';
import {
  isInsideWindow,
  replayedSendWindow,
  type AmbiguousCreateWindow,
} from '../ambiguous-create.js';
import type { CreateContext, ResourceCreateResult } from '../../../types/resource.js';
import { commandHole } from '../../../utils/pasteable-command.js';
import { asIsMessage, safeMsg } from '../../../utils/display-safe.js';
import {
  toNumber,
  toBoolean,
  toSdkMonitoringConfiguration,
  LIVE_CLUSTER_STATES,
  runJobFlowLatch,
  clustersCreatedByThisProcess,
} from './shared.js';

export async function create(
  this: EMRClusterProvider,
  logicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  context?: CreateContext
): Promise<ResourceCreateResult> {
  if (resourceType !== 'AWS::EMR::Cluster') {
    throw new ProvisioningError(
      `Unsupported resource type: ${resourceType}`,
      resourceType,
      logicalId
    );
  }

  this.logger.debug(`Creating EMR Cluster ${logicalId}`);
  // go-to-k/cdkd#3994: a malformed Tags is refused before any call.
  const desiredTags = refuseMalformedDesiredTags(properties['Tags'], resourceType, logicalId);

  let clusterId: string | undefined;

  try {
    // Build the RunJobFlow input INSIDE the try so a malformed template value
    // (e.g. a bad Instances shape) surfaces as a wrapped ProvisioningError
    // rather than a raw throw.
    const tags =
      properties['Tags'] !== undefined && properties['Tags'] !== null ? desiredTags : undefined;
    const input = {
      Name: properties['Name'] as string,
      ReleaseLabel: properties['ReleaseLabel'] as string | undefined,
      ServiceRole: properties['ServiceRole'] as string | undefined,
      JobFlowRole: properties['JobFlowRole'] as string | undefined,
      LogUri: properties['LogUri'] as string | undefined,
      LogEncryptionKmsKeyId: properties['LogEncryptionKmsKeyId'] as string | undefined,
      AdditionalInfo: properties['AdditionalInfo'] as string | undefined,
      AutoScalingRole: properties['AutoScalingRole'] as string | undefined,
      ScaleDownBehavior: properties['ScaleDownBehavior'] as
        | import('@aws-sdk/client-emr').ScaleDownBehavior
        | undefined,
      CustomAmiId: properties['CustomAmiId'] as string | undefined,
      OSReleaseLabel: properties['OSReleaseLabel'] as string | undefined,
      SecurityConfiguration: properties['SecurityConfiguration'] as string | undefined,
      EbsRootVolumeSize: toNumber(properties['EbsRootVolumeSize']),
      EbsRootVolumeIops: toNumber(properties['EbsRootVolumeIops']),
      EbsRootVolumeThroughput: toNumber(properties['EbsRootVolumeThroughput']),
      StepConcurrencyLevel: toNumber(properties['StepConcurrencyLevel']),
      VisibleToAllUsers: toBoolean(properties['VisibleToAllUsers']),
      Applications: properties['Applications'] as
        | import('@aws-sdk/client-emr').Application[]
        | undefined,
      Configurations: toSdkConfigurations(properties['Configurations']),
      BootstrapActions: properties['BootstrapActions'] as
        | import('@aws-sdk/client-emr').BootstrapActionConfig[]
        | undefined,
      Steps: toSdkStepConfigs(properties['Steps']),
      KerberosAttributes: properties['KerberosAttributes'] as
        | import('@aws-sdk/client-emr').KerberosAttributes
        | undefined,
      PlacementGroupConfigs: properties['PlacementGroupConfigs'] as
        | import('@aws-sdk/client-emr').PlacementGroupConfig[]
        | undefined,
      ManagedScalingPolicy: this.toManagedScalingPolicy(
        properties['ManagedScalingPolicy'] as Record<string, unknown> | undefined
      ),
      AutoTerminationPolicy: this.toAutoTerminationPolicy(
        properties['AutoTerminationPolicy'] as Record<string, unknown> | undefined
      ),
      // Both create-only (the registry schema): a change replaces the
      // cluster, so neither has an update path (go-to-k/cdkd#5824).
      MonitoringConfiguration: toSdkMonitoringConfiguration(
        properties['MonitoringConfiguration'],
        (path) => {
          // A template key, so it goes through `safeMsg`. A state record
          // cannot be fixed through the template: warn and drop it
          // (provider-replay-and-refusals.md).
          const text = safeMsg`${path} is not a CloudFormation property of AWS::EMR::Cluster, so CloudFormation rejects this template; remove it.`;
          if (context?.replayingState) {
            this.logger.warn(
              safeMsg`${logicalId}: ${asIsMessage(text)} Dropped from the rollback's RunJobFlow.`
            );
            return;
          }
          throw markNonRetryable(
            new ProvisioningError(
              safeMsg`Cannot create EMR Cluster ${logicalId}: ${asIsMessage(text)}`,
              resourceType,
              logicalId
            )
          );
        }
      ),
      SessionEnabled: toBoolean(properties['SessionEnabled']),
      Tags: tags?.map((t) => ({ Key: t.Key, Value: t.Value })),
      Instances: this.toJobFlowInstancesConfig(
        properties['Instances'] as Record<string, unknown> | undefined
      ),
    };

    // Issue #2080: after an earlier ambiguous attempt, name the cluster it
    // may have launched before a second RunJobFlow is sent. Detection only
    // -- see `orphan-report.ts`. A duplicate cluster bills per
    // instance-hour, so the report carries a terminate command (after
    // confirming); cdkd never terminates a cluster it did not record.
    const reportOrphans = async (lookupWindow: AmbiguousCreateWindow): Promise<void> => {
      const log = createMaskedLogSinks(this.logger, context?.maskSecrets);
      const aws = pasteableAwsCommand(log.mask);
      const regionArg = await orphanCommandRegionArg(this.getClient(), aws);
      const name = input.Name;
      const protectedCluster = input.Instances?.TerminationProtected === true;
      await reportPossibleOrphans(logicalId, lookupWindow, log, {
        action: 'RunJobFlow',
        service: 'EMR',
        listAction: 'ListClusters',
        subject: `a cluster named ${log.value(name)}`,
        noun: 'cluster(s)',
        list: () =>
          collectOrphanIds(
            async (marker) => {
              const page = await this.getClient().send(
                new ListClustersCommand({
                  CreatedAfter: new Date(lookupWindow.floorMs),
                  CreatedBefore: new Date(lookupWindow.ceilingMs),
                  // A cluster already terminating or gone bills nothing.
                  ClusterStates: LIVE_CLUSTER_STATES,
                  ...(marker && { Marker: marker }),
                })
              );
              return { items: page.Clusters ?? [], next: page.Marker };
            },
            (c) =>
              c.Id &&
              c.Name === name &&
              isInsideWindow(c.Status?.Timeline?.CreationDateTime, lookupWindow) &&
              !clustersCreatedByThisProcess.has(c.Id)
                ? c.Id
                : undefined
          ),
        inspect: (id) => aws`aws emr describe-cluster --cluster-id ${id}${regionArg}`.render(),
        remove: (id) => aws`aws emr terminate-clusters --cluster-ids ${id}${regionArg}`.render(),
        // Conditional, not chained: the candidate may be another deploy's
        // cluster, whose protection this template says nothing about.
        removeVerb: protectedCluster
          ? // A quoted hole (`commandHole`): a bare `<id>` pastes as a redirection.
            `terminate it (this template turns termination protection on, so if describe-cluster shows it on for the candidate, first run ${aws`aws emr modify-cluster-attributes --cluster-id`.render()} ${commandHole('id')} ${aws`--no-termination-protected${regionArg}`.render()} with its id)`
          : 'terminate it',
      });
    };
    const orphanWindow = runJobFlowLatch.take(logicalId);
    if (orphanWindow !== undefined) {
      await reportOrphans(orphanWindow);
    }
    const attemptStartMs = Date.now();
    let response: RunJobFlowCommandOutput;
    try {
      response = await this.getCreateClient().send(new RunJobFlowCommand(input));
    } catch (error) {
      runJobFlowLatch.noteFailure(logicalId, error, attemptStartMs, orphanWindow);
      throw error;
    }
    clusterId = response.JobFlowId;
    if (clusterId) clustersCreatedByThisProcess.add(clusterId);
    // go-to-k/cdkd#5511: no-op for an empty id.
    reportCreatedResource(logicalId, resourceType, clusterId ?? '');
    // Issue #4687: the SDK replayed this RunJobFlow inside its `send`, so
    // an earlier attempt may have made one too. Detection only.
    const replayWindow = replayedSendWindow(response, attemptStartMs);
    if (replayWindow !== undefined) {
      await reportOrphans(replayWindow);
    }
    if (!clusterId) {
      throw new ProvisioningError(
        `EMR RunJobFlow for ${logicalId} returned no JobFlowId`,
        resourceType,
        logicalId
      );
    }

    const cluster = await this.waitForClusterReady(
      clusterId,
      logicalId,
      resourceType,
      context?.maskSecrets
    );

    this.logger.debug(`Successfully created EMR Cluster ${logicalId}: ${clusterId}`);

    return {
      physicalId: clusterId,
      attributes: this.buildAttributes(cluster),
    };
  } catch (error) {
    // Atomicity: if RunJobFlow succeeded but polling failed (the cluster
    // went TERMINATED_WITH_ERRORS, or the wait timed out), create() is
    // about to throw without returning a physicalId — the deploy engine
    // cannot roll it back, and a live EMR cluster bills per instance-hour.
    // Best-effort terminate it here.
    // go-to-k/cdkd#4583: the id of a cluster RunJobFlow returned that the
    // terminate below could not stop, named for the failed-CREATE journal.
    let survivorId: string | undefined;
    if (clusterId !== undefined) {
      try {
        // If the template requested Instances.TerminationProtected: true the
        // cluster is PROTECTED, and TerminateJobFlows would 400 with a
        // ValidationException — leaving a live billing cluster, the exact
        // outcome this rollback exists to prevent. Flip protection off first
        // (idempotent — EMR accepts it when already false), mirroring the
        // delete path, then terminate.
        await this.getClient().send(
          new SetTerminationProtectionCommand({
            JobFlowIds: [clusterId],
            TerminationProtected: false,
          })
        );
        await this.getClient().send(new TerminateJobFlowsCommand({ JobFlowIds: [clusterId] }));
        retractCreatedResource(logicalId, resourceType, clusterId);
        this.logger.warn(`Rolled back partially-created EMR Cluster ${clusterId}`);
      } catch (cleanupError) {
        survivorId = clusterId;
        const cleanupHead = `Failed to roll back partially-created EMR Cluster ${clusterId}: `;
        this.logger.warn(
          maskerOrIdentity(context?.maskSecrets)(
            `${cleanupHead}${this.cleanupFailureText(cleanupHead, cleanupError, context?.maskSecrets)} — terminate it manually to stop billing`
          )
        );
      }
    }
    if (error instanceof ProvisioningError) {
      if (survivorId !== undefined) {
        markCreatedBeforeFailure(error, logicalId, resourceType, survivorId);
        // go-to-k/cdkd#4945: terminal. RunJobFlow sends no name and no token, so the
        // engine's retry would make another cluster while the journal names one.
        markNonRetryable(error);
      }
      throw error;
    }
    const cause = error instanceof Error ? error : undefined;
    const thrown = this.wrapCaughtError(
      context?.maskSecrets,
      error,
      (text) =>
        new ProvisioningError(
          `Failed to create EMR Cluster ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          undefined,
          cause
        )
    );
    if (survivorId !== undefined) {
      markCreatedBeforeFailure(thrown, logicalId, resourceType, survivorId);
      markNonRetryable(thrown);
    }
    throw thrown;
  }
}

/**
 * Map the CFn `Instances` (`JobFlowInstancesConfig`) block to the SDK
 * `RunJobFlow.Instances` shape. Most field names are identical; the one
 * structural difference is the role-keyed CFn groups/fleets
 * (`MasterInstanceGroup` / `CoreInstanceGroup` / `TaskInstanceGroups` and
 * the `*InstanceFleet(s)` siblings) which the SDK expresses as flat
 * `InstanceGroups` / `InstanceFleets` arrays with an explicit
 * `InstanceRole` / `InstanceFleetType` discriminator per entry.
 */
export function toJobFlowInstancesConfig(
  this: EMRClusterProvider,
  config: Record<string, unknown> | undefined
): JobFlowInstancesConfig | undefined {
  if (!config) return undefined;

  const instanceGroups: InstanceGroupConfig[] = [];
  const pushGroup = (raw: unknown, role: InstanceRoleType): void => {
    if (raw === undefined || raw === null) return;
    instanceGroups.push(this.toInstanceGroupConfig(raw as Record<string, unknown>, role));
  };
  pushGroup(config['MasterInstanceGroup'], 'MASTER');
  pushGroup(config['CoreInstanceGroup'], 'CORE');
  for (const task of (config['TaskInstanceGroups'] as unknown[] | undefined) ?? []) {
    pushGroup(task, 'TASK');
  }

  const instanceFleets: InstanceFleetConfig[] = [];
  const pushFleet = (raw: unknown, type: InstanceFleetType): void => {
    if (raw === undefined || raw === null) return;
    instanceFleets.push(this.toInstanceFleetConfig(raw as Record<string, unknown>, type));
  };
  pushFleet(config['MasterInstanceFleet'], 'MASTER');
  pushFleet(config['CoreInstanceFleet'], 'CORE');
  for (const task of (config['TaskInstanceFleets'] as unknown[] | undefined) ?? []) {
    pushFleet(task, 'TASK');
  }

  return {
    InstanceGroups: instanceGroups.length > 0 ? instanceGroups : undefined,
    InstanceFleets: instanceFleets.length > 0 ? instanceFleets : undefined,
    Ec2KeyName: config['Ec2KeyName'] as string | undefined,
    Ec2SubnetId: config['Ec2SubnetId'] as string | undefined,
    Ec2SubnetIds: config['Ec2SubnetIds'] as string[] | undefined,
    HadoopVersion: config['HadoopVersion'] as string | undefined,
    Placement: config['Placement'] as import('@aws-sdk/client-emr').PlacementType | undefined,
    KeepJobFlowAliveWhenNoSteps: toBoolean(config['KeepJobFlowAliveWhenNoSteps']),
    TerminationProtected: toBoolean(config['TerminationProtected']),
    UnhealthyNodeReplacement: toBoolean(config['UnhealthyNodeReplacement']),
    EmrManagedMasterSecurityGroup: config['EmrManagedMasterSecurityGroup'] as string | undefined,
    EmrManagedSlaveSecurityGroup: config['EmrManagedSlaveSecurityGroup'] as string | undefined,
    ServiceAccessSecurityGroup: config['ServiceAccessSecurityGroup'] as string | undefined,
    AdditionalMasterSecurityGroups: config['AdditionalMasterSecurityGroups'] as
      | string[]
      | undefined,
    AdditionalSlaveSecurityGroups: config['AdditionalSlaveSecurityGroups'] as string[] | undefined,
  };
}

export function toInstanceGroupConfig(
  this: EMRClusterProvider,
  raw: Record<string, unknown>,
  role: InstanceRoleType
): InstanceGroupConfig {
  return {
    InstanceRole: role,
    InstanceType: raw['InstanceType'] as string,
    InstanceCount: toNumber(raw['InstanceCount']) as number,
    Name: raw['Name'] as string | undefined,
    Market: raw['Market'] as import('@aws-sdk/client-emr').MarketType | undefined,
    BidPrice: raw['BidPrice'] as string | undefined,
    Configurations: toSdkConfigurations(raw['Configurations']),
    EbsConfiguration: raw['EbsConfiguration'] as
      | import('@aws-sdk/client-emr').EbsConfiguration
      | undefined,
    AutoScalingPolicy: raw['AutoScalingPolicy'] as
      | import('@aws-sdk/client-emr').AutoScalingPolicy
      | undefined,
    CustomAmiId: raw['CustomAmiId'] as string | undefined,
  };
}

export function toInstanceFleetConfig(
  this: EMRClusterProvider,
  raw: Record<string, unknown>,
  type: InstanceFleetType
): InstanceFleetConfig {
  return {
    InstanceFleetType: type,
    Name: raw['Name'] as string | undefined,
    TargetOnDemandCapacity: toNumber(raw['TargetOnDemandCapacity']),
    TargetSpotCapacity: toNumber(raw['TargetSpotCapacity']),
    InstanceTypeConfigs: toSdkInstanceTypeConfigs(raw['InstanceTypeConfigs']),
    LaunchSpecifications: raw['LaunchSpecifications'] as
      | import('@aws-sdk/client-emr').InstanceFleetProvisioningSpecifications
      | undefined,
    ResizeSpecifications: raw['ResizeSpecifications'] as
      | import('@aws-sdk/client-emr').InstanceFleetResizingSpecifications
      | undefined,
  };
}

export function toManagedScalingPolicy(
  this: EMRClusterProvider,
  config: Record<string, unknown> | undefined
): ManagedScalingPolicy | undefined {
  if (!config) return undefined;
  const limits = config['ComputeLimits'] as Record<string, unknown> | undefined;
  // ComputeLimits is required for a valid managed-scaling policy. Without it
  // there is nothing to PutManagedScalingPolicy — return undefined so both
  // create (no ManagedScalingPolicy set) and update (routes to
  // RemoveManagedScalingPolicy) do the right thing instead of sending an
  // empty policy AWS rejects.
  if (!limits) return undefined;
  return {
    ComputeLimits: {
      UnitType: limits['UnitType'] as
        | import('@aws-sdk/client-emr').ComputeLimitsUnitType
        | undefined,
      MinimumCapacityUnits: toNumber(limits['MinimumCapacityUnits']),
      MaximumCapacityUnits: toNumber(limits['MaximumCapacityUnits']),
      MaximumOnDemandCapacityUnits: toNumber(limits['MaximumOnDemandCapacityUnits']),
      MaximumCoreCapacityUnits: toNumber(limits['MaximumCoreCapacityUnits']),
    },
    UtilizationPerformanceIndex: toNumber(config['UtilizationPerformanceIndex']),
    ScalingStrategy: config['ScalingStrategy'] as
      | import('@aws-sdk/client-emr').ScalingStrategy
      | undefined,
  };
}

export function toAutoTerminationPolicy(
  this: EMRClusterProvider,
  config: Record<string, unknown> | undefined
): AutoTerminationPolicy | undefined {
  if (!config) return undefined;
  return { IdleTimeout: toNumber(config['IdleTimeout']) };
}
