import {
  UpdateTableCommand,
  type UpdateReplicationGroupMemberAction,
} from '@aws-sdk/client-dynamodb';
import type { ReplicaSetting } from '../../dynamodb-replica-settings.js';
import { markUnsettled } from './projection.js';
import {
  readReplicationMode,
  replicationModeUpdate,
  replicationModeCorrection,
  readReplicaTableClass,
  tableClassToSend,
} from './replica-shape.js';
import { autoScalingTargetKey, asRecord } from './capacity.js';
import {
  toSdkReplicaGlobalSecondaryIndexes,
  toSdkReplicaThroughputOverrides,
  diffReplicas,
  deepEqual,
} from './gsi-diff.js';
import type { DynamoDBGlobalTableProvider } from '../dynamodb-globaltable-provider.js';
import type { UpdateInScopeLocals } from './update.js';
import type { UpdatePhasePlanResult } from './update-plan.js';
import type { UpdatePhaseTableResult } from './update-table.js';

export type UpdatePhaseReplicasResult = Awaited<ReturnType<typeof updatePhaseReplicas>>;

/**
 * `updateInScope`, phase 3 of 4 (moved verbatim): replication mode and the
 * `Replicas` diff (adds, removals, per-replica settings).
 */
export async function updatePhaseReplicas(
  this: DynamoDBGlobalTableProvider,
  scope: Pick<
    UpdateInScopeLocals,
    | 'properties'
    | 'previousProperties'
    | 'physicalId'
    | 'logicalId'
    | 'maskSecrets'
    | 'currentRegion'
    | 'resourceType'
    | 'warn'
    | 'debug'
    | 'context'
  > &
    Pick<
      UpdatePhaseTableResult,
      | 'autoScalingApplied'
      | 'deferredSseUpdate'
      | 'deferredSseFromTemplate'
      | 'keylessSseFromTemplate'
    > &
    Pick<UpdatePhasePlanResult, 'newBilling' | 'tableArn' | 'oldBilling' | 'describeResp'>
) {
  const {
    properties,
    previousProperties,
    physicalId,
    logicalId,
    maskSecrets,
    currentRegion,
    autoScalingApplied,
    newBilling,
    tableArn,
    resourceType,
    oldBilling,
    warn,
    debug,
    describeResp,
    context,
    deferredSseUpdate,
    deferredSseFromTemplate,
    keylessSseFromTemplate,
  } = scope;
  // go-to-k/cdkd#5489: a REMOVED settings replication mode is reset
  // before the replica diff, while the table still has the one replica a
  // mode is valid on; a declared one is sent after it (below).
  const modeUpdate = replicationModeUpdate(properties, previousProperties);
  if (modeUpdate === 'DISABLED' && readReplicationMode(properties).kind === 'absent') {
    await this.sendReplicationMode(physicalId, logicalId, modeUpdate, maskSecrets);
  }
  // 5. Replica diff. AWS limits to ONE ReplicaUpdates entry per call,
  // so serialize Create / Update / Delete and wait between each.
  // `currentRegion` is already resolved once at the top of update().
  const replicaDiff = diffReplicas(
    (previousProperties['Replicas'] ?? []) as Array<Record<string, unknown>>,
    (properties['Replicas'] ?? []) as Array<Record<string, unknown>>
  );
  // Removes first: AWS rejects DeleteTable on a multi-replica table
  // but tolerates dropping replicas while the rest stay live.
  for (const replica of replicaDiff.removed) {
    const region = replica['Region'] as string | undefined;
    if (!region || region === currentRegion) continue;

    // Per-replica read auto-scaling teardown (Issue #402). When the
    // removed replica had `ReadCapacityAutoScalingSettings`, the
    // scalable target + policy in the replica's region must be torn
    // down BEFORE the ReplicaUpdates Delete: AWS's application-
    // autoscaling control plane stays around after the table replica
    // disappears, and a future re-add of the same region would
    // collide. Best-effort: failures log at WARN and the deploy
    // continues to drop the replica.
    const removedReadAutoScaling = (
      (replica['ReadProvisionedThroughputSettings'] ?? {}) as Record<string, unknown>
    )['ReadCapacityAutoScalingSettings'] as Record<string, unknown> | undefined;
    if (removedReadAutoScaling) {
      const regionalAutoScalingClient = this.getRegionalAutoScalingClient(region);
      await this.applyAutoScalingDiff(
        physicalId,
        'dynamodb:table:ReadCapacityUnits',
        removedReadAutoScaling,
        undefined,
        regionalAutoScalingClient,
        undefined,
        undefined,
        maskSecrets
      );
      autoScalingApplied.add(
        autoScalingTargetKey({ dimension: 'dynamodb:table:ReadCapacityUnits', region })
      );
    }

    markUnsettled('Replicas');
    await this.dynamoDBClient.send(
      new UpdateTableCommand({
        TableName: physicalId,
        ReplicaUpdates: [{ Delete: { RegionName: region } }],
      })
    );
    await this.waitForReplicaGone(physicalId, region, logicalId, undefined, undefined, maskSecrets);
    // go-to-k/cdkd#5581: the targets DynamoDB registered for this replica
    // (its write dimension included) outlive it; drop them once its table
    // is past the point of return.
    await this.deregisterRemovedReplicaScalableTargets(physicalId, region, { maskSecrets });
  }
  for (const replica of replicaDiff.added) {
    const region = replica['Region'] as string | undefined;
    if (!region || region === currentRegion) continue;
    // Diagnostics already emitted by the pre-flight scan at the top of
    // update(); passing the collector again would warn twice.
    await this.addReplica(
      physicalId,
      replica,
      region,
      logicalId,
      newBilling,
      undefined,
      maskSecrets
    );

    // Cross-region Tags propagation for the newly-added replica
    // (Issue #441 follow-up — mirrors the create-side + modified
    // paths). `UpdateTable(ReplicaUpdates: [{Create: ...}])` does
    // not accept a `Tags` field, so any `Replicas[].Tags` declared
    // in the new replica entry must be applied via a separate
    // `TagResource` against the replica's region-scoped ARN.
    const newReplicaTags: unknown = replica['Tags'];
    await this.applyCrossRegionReplicaTagsDiff(
      tableArn,
      region,
      undefined,
      newReplicaTags,
      resourceType,
      logicalId,
      physicalId,
      maskSecrets
    );

    // Per-replica read auto-scaling (Issue #402): when the new
    // replica has `ReadCapacityAutoScalingSettings`, register the
    // scalable target + target-tracking policy in the replica's
    // region right after the replica becomes ACTIVE. Skipped on
    // PAY_PER_REQUEST tables (autoscaling is meaningless without
    // ProvisionedThroughput).
    const newReadAutoScaling = (
      (replica['ReadProvisionedThroughputSettings'] ?? {}) as Record<string, unknown>
    )['ReadCapacityAutoScalingSettings'] as Record<string, unknown> | undefined;
    if (newBilling === 'PROVISIONED' && newReadAutoScaling) {
      const regionalAutoScalingClient = this.getRegionalAutoScalingClient(region);
      await this.applyAutoScalingDiff(
        physicalId,
        'dynamodb:table:ReadCapacityUnits',
        undefined,
        newReadAutoScaling,
        regionalAutoScalingClient,
        undefined,
        undefined,
        maskSecrets
      );
      autoScalingApplied.add(
        autoScalingTargetKey({ dimension: 'dynamodb:table:ReadCapacityUnits', region })
      );
    }
  }
  for (const replica of replicaDiff.modified) {
    const region = replica['Region'] as string | undefined;
    if (!region || region === currentRegion) continue;

    // Look up the matching previous replica entry so we can diff
    // Tags independently of the non-Tags fields (UpdateReplica's
    // SDK action does not accept Tags — cross-region tag changes
    // must go through TagResource / UntagResource against the
    // replica's region-scoped table ARN).
    const oldReplica = (
      (previousProperties['Replicas'] ?? []) as Array<Record<string, unknown>>
    ).find((r) => r['Region'] === region);
    const oldReplicaTags: unknown = oldReplica?.['Tags'];
    const newReplicaTags: unknown = replica['Tags'];

    // Cross-region Tags propagation (Issue #389): delegate to the
    // shared `applyCrossRegionReplicaTagsDiff` helper (also used by
    // `create()` per Issue #441) — the helper handles the
    // diff-equals-no-op short-circuit, the ARN-derivation guard,
    // and the best-effort WARN-on-failure contract uniformly across
    // both code paths.
    await this.applyCrossRegionReplicaTagsDiff(
      tableArn,
      region,
      oldReplicaTags,
      newReplicaTags,
      resourceType,
      logicalId,
      physicalId,
      maskSecrets
    );

    // Per-replica read auto-scaling diff (Issue #402 / closes #395
    // deferred items). The read dimension's scalable target +
    // policy live in the REPLICA's region (each replica registers
    // its own target with `application-autoscaling` in its own
    // region), so route through a region-scoped autoscaling client.
    const oldReadAutoScaling = (
      (oldReplica?.['ReadProvisionedThroughputSettings'] ?? {}) as Record<string, unknown>
    )['ReadCapacityAutoScalingSettings'] as Record<string, unknown> | undefined;
    const newReadAutoScaling = (
      (replica['ReadProvisionedThroughputSettings'] ?? {}) as Record<string, unknown>
    )['ReadCapacityAutoScalingSettings'] as Record<string, unknown> | undefined;
    const effectiveNewReadAutoScaling =
      newBilling === 'PAY_PER_REQUEST' ? undefined : newReadAutoScaling;
    if (
      (newBilling === 'PROVISIONED' || oldBilling === 'PROVISIONED') &&
      !deepEqual(oldReadAutoScaling, effectiveNewReadAutoScaling)
    ) {
      const regionalAutoScalingClient = this.getRegionalAutoScalingClient(region);
      await this.applyAutoScalingDiff(
        physicalId,
        'dynamodb:table:ReadCapacityUnits',
        oldReadAutoScaling,
        effectiveNewReadAutoScaling,
        regionalAutoScalingClient,
        undefined,
        undefined,
        maskSecrets
      );
      autoScalingApplied.add(
        autoScalingTargetKey({ dimension: 'dynamodb:table:ReadCapacityUnits', region })
      );
    }

    // A replica's KMS key is not sent here: DynamoDB refuses a key
    // change for one replica alone ("KMSMasterKeyId must be specified
    // for each replica", measured), so `applyReplicaKeys` sets every
    // region's key in one call after this loop (go-to-k/cdkd#5355). A
    // REMOVED key (CDK's `customerManagedKey` -> `awsManagedKey`) needs
    // nothing here either: the table's `SSESpecification` update moves
    // every replica to the AWS managed key (measured).
    const updateAction: UpdateReplicationGroupMemberAction = { RegionName: region };
    // Same CFn -> SDK per-replica GSI throughput translation as the
    // create-side `addReplica` (Issue #1387).
    const replicaIndexes = toSdkReplicaGlobalSecondaryIndexes(
      replica['GlobalSecondaryIndexes'],
      newBilling,
      undefined,
      maskSecrets
    );
    if (replicaIndexes) {
      updateAction.GlobalSecondaryIndexes = replicaIndexes;
    }
    // The replica's own TABLE-level read ceiling / read capacity, which
    // uses the same two CFn spellings one level up (issue #1436).
    //
    // SET only — there is deliberately NO reset arm here, and that is a
    // probe-informed decision rather than an omission. Live probe
    // (us-east-1 source + us-west-2 replica, 2026-08-09, recorded on
    // issue #1436): `OnDemandThroughputOverride: {MaxReadRequestUnits: -1}`
    // is ACCEPTED but reads back LITERALLY as -1 — it is not a reset
    // sentinel here, unlike the table-level member — and the empty-block
    // form `OnDemandThroughputOverride: {}` left the table stuck in
    // UPDATING for over an hour, after which AWS refused to delete it for
    // 24 hours. So a template that DROPS a non-local replica's ceiling
    // leaves the old override live, and says so, rather than corrupting
    // the table with a payload probing already proved hazardous.
    const replicaOverrides = toSdkReplicaThroughputOverrides(
      replica,
      newBilling,
      undefined,
      {},
      maskSecrets
    );
    if (replicaOverrides.ProvisionedThroughputOverride) {
      updateAction.ProvisionedThroughputOverride = replicaOverrides.ProvisionedThroughputOverride;
    }
    if (replicaOverrides.OnDemandThroughputOverride) {
      updateAction.OnDemandThroughputOverride = replicaOverrides.OnDemandThroughputOverride;
    }
    // A DROPPED override is reported rather than acted on, for the reason
    // above. Only when the billing mode held still — a flip re-shapes both
    // sides by construction, so "the old override is gone" there is the
    // translation, not a template edit.
    if (oldBilling === newBilling) {
      const oldReplicaOverrides = toSdkReplicaThroughputOverrides(
        oldReplica ?? {},
        oldBilling,
        undefined,
        {},
        maskSecrets
      );
      const droppedOverrides: string[] = [];
      if (
        oldReplicaOverrides.OnDemandThroughputOverride &&
        !replicaOverrides.OnDemandThroughputOverride
      ) {
        droppedOverrides.push('ReadOnDemandThroughputSettings');
      }
      if (
        oldReplicaOverrides.ProvisionedThroughputOverride &&
        !replicaOverrides.ProvisionedThroughputOverride
      ) {
        droppedOverrides.push('ReadProvisionedThroughputSettings');
      }
      if (droppedOverrides.length > 0) {
        warn(
          `Cross-region replica ${region} of ${physicalId}: the template no longer ` +
            // Override MEMBER NAMES come out of the resolved `Replicas`
            // bag, so each is masked raw before the join (issue #1997).
            `declares ${droppedOverrides.map((o) => maskSecrets(o)).join(' / ')}, but ` +
            `DynamoDB offers no way to ` +
            `CLEAR a replica-level throughput override — a -1 sentinel is stored ` +
            `literally, and an empty override block wedges the table in UPDATING. ` +
            `The previous override is STILL IN ` +
            `EFFECT on AWS. Set an explicit value, or remove and re-add the replica, ` +
            `to change it.`
        );
      }
    }
    const replicaTableClassChange = tableClassToSend(
      readReplicaTableClass(oldReplica),
      readReplicaTableClass(replica)
    );
    if (replicaTableClassChange !== undefined) {
      updateAction.TableClassOverride = replicaTableClassChange;
    }
    // AWS rejects an UpdateReplica with no update fields
    // (ValidationException). When the only change in the modified
    // replica is `Tags` (now applied above via per-region client),
    // the updateAction has only `RegionName`. Skip the
    // UpdateReplica SDK call in that case — the Tags-only diff is
    // already in flight against the regional client.
    const hasUpdateField =
      updateAction.GlobalSecondaryIndexes !== undefined ||
      updateAction.TableClassOverride !== undefined ||
      updateAction.ProvisionedThroughputOverride !== undefined ||
      updateAction.OnDemandThroughputOverride !== undefined;
    if (!hasUpdateField) {
      debug(
        `Cross-region replica ${region} of ${maskSecrets(physicalId)}: only Tags-style ` +
          `changes detected; UpdateReplica skipped (AWS rejects empty ` +
          `Update actions). Tags propagation handled above via per-region client.`
      );
      continue;
    }
    markUnsettled('Replicas');
    await this.dynamoDBClient.send(
      new UpdateTableCommand({
        TableName: physicalId,
        ReplicaUpdates: [{ Update: updateAction }],
      })
    );
    // The replica reads ACTIVE throughout: only the table's status shows the
    // region has not moved yet, about 40 seconds on (measured, go-to-k/cdkd#5604).
    await this.waitForGlobalTableSettled(physicalId, logicalId, maskSecrets, { region });
  }
  const addedReplicaRegions = new Set(replicaDiff.added.map((r) => r['Region']));
  if (modeUpdate !== undefined && readReplicationMode(properties).kind === 'usable') {
    await this.sendReplicationMode(physicalId, logicalId, modeUpdate, maskSecrets);
  } else {
    // A declared mode the template did not change, which a pre-fix deploy
    // never sent: compared with the mode update()'s first DescribeTable
    // reported (no extra read, so a failure of that read fails the update
    // as before), and the corrective UpdateTable is best-effort — a failed
    // SEND is reported, not thrown.
    const correction = replicationModeCorrection(
      properties,
      previousProperties,
      describeResp.Table?.GlobalTableSettingsReplicationMode
    );
    if (correction !== undefined) {
      await this.sendReplicationMode(physicalId, logicalId, correction, maskSecrets, false);
    }
  }
  await this.convergeReplicaDeletionProtection(
    physicalId,
    logicalId,
    currentRegion,
    previousProperties,
    properties,
    addedReplicaRegions,
    context?.desiredFromAwsReadback === true,
    warn,
    maskSecrets
  );
  await this.convergeReplicaSettings(
    physicalId,
    logicalId,
    currentRegion,
    properties,
    addedReplicaRegions,
    maskSecrets
  );
  await this.applyReplicaKeys(
    physicalId,
    logicalId,
    currentRegion,
    properties,
    previousProperties,
    addedReplicaRegions,
    deferredSseUpdate,
    deferredSseFromTemplate,
    keylessSseFromTemplate,
    maskSecrets
  );
  // A read-back omits a member whose read failed, and carries a policy
  // only where one is declared: an absence there is no removal. A rollback replay must not
  // turn recovery off on a record whose update may never have sent it.
  const replicaKeepOnRemoval = new Set<ReplicaSetting>(
    context?.desiredFromAwsReadback === true
      ? [
          'pitr',
          'contributorInsights',
          'kinesis',
          'tablePolicy',
          'streamPolicy',
          // Neither is read back (go-to-k/cdkd#5489).
          'indexContributorInsights',
          'streamTags',
        ]
      : context?.replayingState === true
        ? ['pitr']
        : []
  );
  // go-to-k/cdkd#5365: the per-replica settings, the local table's
  // included, after every replica change above has settled. A
  // `StreamViewType` change minted a new stream, which holds no policy.
  await this.applyReplicaSettings(
    physicalId,
    logicalId,
    currentRegion,
    properties,
    previousProperties,
    addedReplicaRegions,
    !deepEqual(
      asRecord(properties['StreamSpecification'])?.['StreamViewType'],
      asRecord(previousProperties['StreamSpecification'])?.['StreamViewType']
    ),
    context?.replayingState === true || context?.desiredFromAwsReadback === true,
    replicaKeepOnRemoval,
    describeResp.Table?.LatestStreamArn,
    warn,
    maskSecrets
  );
  // go-to-k/cdkd#5570: after every replica change above, as a solo write
  // per replica (the local table and the replicas this update added
  // included); the GSI, auto-scaling and TTL steps below follow it.
  await this.convergeReplicaDisassociationProtection(
    physicalId,
    logicalId,
    currentRegion,
    properties,
    previousProperties,
    context?.desiredFromAwsReadback === true
      ? 'readback'
      : context?.replayingState === true
        ? 'replay'
        : 'template',
    warn,
    maskSecrets
  );
  return { addedReplicaRegions, replicaKeepOnRemoval };
}
