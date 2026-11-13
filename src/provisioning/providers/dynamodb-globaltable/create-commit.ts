import { cdkdRemedy } from '../../../utils/pasteable-command.js';
import {
  DeleteTableCommand,
  DescribeTableCommand,
  UpdateTableCommand,
  UpdateTimeToLiveCommand,
} from '@aws-sdk/client-dynamodb';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import { planTimeToLive } from '../../dynamodb-ttl.js';
import { ProvisioningError } from '../../../utils/error-handler.js';
import { markAuxiliaryFailure, markCreatedBeforeFailure } from '../../auxiliary-failure.js';
import { retractCreatedResource } from '../../created-resource-sink.js';
import { replayWarn } from '../../config-shape.js';
import { isInterruptedWaitError } from '../../interrupt-watch.js';
import { pasteableAwsCommand } from '../../replacement-protection-advice.js';
import { localReplicaEntry, readReplicaDeletionProtection } from './replica-shape.js';
import { autoScalingTargetKey, collectAutoScalingTargets } from './capacity.js';
import type { DynamoDBGlobalTableProvider } from '../dynamodb-globaltable-provider.js';
import type { CreateLocals } from './create.js';

/**
 * `create`, final phase (moved verbatim): the `CreateTable` call, replica and
 * auto-scaling wiring, and the rollback of a partially created table.
 */
export async function createPhaseCommit(
  this: DynamoDBGlobalTableProvider,
  scope: Pick<
    CreateLocals,
    | 'tableName'
    | 'logicalId'
    | 'maskSecrets'
    | 'createVectorIndexes'
    | 'billingMode'
    | 'wiringProperties'
    | 'currentRegion'
    | 'wiringReplicas'
    | 'registeredBeforeReplicas'
    | 'replicas'
    | 'desiredReplicaTags'
    | 'resourceType'
    | 'log'
    | 'context'
    | 'warn'
    | 'properties'
    | 'effectiveProperties'
    | 'createdTableId'
  >
) {
  const {
    tableName,
    logicalId,
    maskSecrets,
    createVectorIndexes,
    billingMode,
    wiringProperties,
    currentRegion,
    wiringReplicas,
    replicas,
    desiredReplicaTags,
    resourceType,
    log,
    context,
    warn,
    properties,
    effectiveProperties,
    createdTableId,
  } = scope;
  let { registeredBeforeReplicas } = scope;
  // Inner try/catch wraps every post-CreateTable wiring call so a
  // wiring failure issues a best-effort DeleteTable before re-throwing.
  // Without this, an aborted deploy leaves a billing AWS-side table
  // with no cdkd state record (PR #374 pattern).
  try {
    const tableInfo = await this.waitForTableActive(tableName, logicalId, undefined, maskSecrets);
    // go-to-k/cdkd#2762: a vector index created WITH the table may still be
    // building when the table reads ACTIVE; a replica add must not meet it.
    if (createVectorIndexes !== undefined) {
      await this.waitForVectorIndexesSettled(tableName, logicalId, maskSecrets);
    }

    // go-to-k/cdkd#5615: DynamoDB refuses a replica on a table whose write side,
    // or any index's, has no scalable target AND scaling policy yet. A replica
    // added right after both is accepted (measured), so no wait goes between.
    const scalingSpecs =
      billingMode === 'PROVISIONED'
        ? // `wiringProperties`, not `properties`: on the replay omit arm a
          // replica's per-index read target would name an index this create did
          // not build, and the registrations run in sequence, so one that
          // throws skips every target after it.
          collectAutoScalingTargets(wiringProperties, currentRegion)
        : [];
    if (wiringReplicas.some((r) => r['Region'] !== currentRegion)) {
      registeredBeforeReplicas = scalingSpecs.filter(
        (spec) => spec.region === currentRegion && spec.dimension.endsWith('WriteCapacityUnits')
      );
    }
    if (registeredBeforeReplicas.length > 0) {
      await this.reconcileAutoScalingTargets(
        tableName,
        [],
        registeredBeforeReplicas,
        currentRegion,
        undefined,
        maskSecrets
      );
    }

    // Replica adds: one UpdateTable per region (AWS rejects multiple
    // ReplicaUpdates in a single call). Each call must complete before
    // the next — UpdateTable returns immediately but the table flips to
    // UPDATING until the replica is provisioned.
    for (const replica of wiringReplicas) {
      const region = replica['Region'] as string | undefined;
      if (!region || region === currentRegion) continue;
      // No diagnostics collector: the same translation already ran in the
      // pre-flight scan above, so passing one here would warn twice.
      await this.addReplica(
        tableName,
        replica,
        region,
        logicalId,
        billingMode,
        undefined,
        maskSecrets
      );
    }

    // Cross-region replica Tags propagation (Issue #441 — closes the
    // create-side half of Issue #389's scope; the update path already
    // shipped per-region propagation). `CreateTable`'s top-level
    // `Tags` only covers the LOCAL replica; non-local replicas need a
    // separate `TagResource` against the regional client AFTER the
    // replica flips ACTIVE (AWS rejects `TagResource` with
    // `ResourceNotFoundFault` against a still-provisioning replica,
    // which is why this loop sits below the `addReplica` await above
    // — `waitForReplicaActive` is part of `addReplica`). Best-effort
    // per replica: a single region's failure logs at WARN and the
    // deploy continues (mirrors `update()`'s contract). Without
    // this, the first `cdkd drift` against a freshly-created
    // multi-region table reports Tags drift on every cross-region
    // replica.
    for (const replica of replicas) {
      const region = replica['Region'] as string | undefined;
      if (!region || region === currentRegion) continue;
      const replicaTags = desiredReplicaTags.get(replica);
      if (!replicaTags || replicaTags.length === 0) continue;
      await this.applyCrossRegionReplicaTagsDiff(
        tableInfo.tableArn,
        region,
        undefined, // create() has no previous state — every tag is an add
        replicaTags,
        resourceType,
        logicalId,
        tableName,
        maskSecrets
      );
    }

    // Per-replica point-in-time recovery, Contributor Insights, Kinesis
    // destination and resource policies (go-to-k/cdkd#5365), each through
    // its replica's own region once every replica is ACTIVE. A failure here
    // is a wiring failure: the cleanup below removes the table.
    await this.applyReplicaSettings(
      tableName,
      logicalId,
      currentRegion,
      wiringProperties,
      undefined,
      new Set(),
      false,
      replayWarn(log, context).onUnusable !== undefined,
      new Set(),
      undefined,
      warn,
      maskSecrets
    );

    // go-to-k/cdkd#5570: each replica's declared disassociation protection,
    // a solo UpdateTable in its own region once every replica is settled.
    await this.convergeReplicaDisassociationProtection(
      tableName,
      logicalId,
      currentRegion,
      wiringProperties,
      undefined,
      context?.replayingState === true ? 'replay' : 'template',
      warn,
      maskSecrets
    );

    // TTL is a separate API call (UpdateTimeToLive). Applied after
    // table + replicas are ACTIVE so the AWS-side request validates.
    // A disabled spec sends nothing: a new table starts with TTL disabled,
    // and AWS refuses to disable it again (issue #5447).
    const createTtl = planTimeToLive(properties['TimeToLiveSpecification'], undefined, 'create');
    if (createTtl.kind === 'enable') {
      await this.dynamoDBClient.send(
        new UpdateTimeToLiveCommand({
          TableName: tableName,
          TimeToLiveSpecification: { Enabled: true, AttributeName: createTtl.attributeName },
        })
      );
    }

    // Application-autoscaling registration (Issue #1419). Before this,
    // `create()` registered NOTHING — only `update()` ever called
    // `applyAutoScalingDiff` — so a freshly created PROVISIONED
    // GlobalTable had no scaling policy at all until some later deploy
    // happened to run an update, and per-index settings were dropped even
    // then. Runs after the table AND every replica are ACTIVE:
    // `RegisterScalableTarget` against a still-provisioning table or a
    // not-yet-created index is rejected. The write targets a replica needs went
    // first, above, and are skipped here.
    //
    // Deliberately the LAST wiring step, and deliberately wrapped so it
    // cannot throw. Both are about the partial-create cleanup below: that
    // handler deletes the table (it does NOT route through `delete()`), so a
    // target registered before a LATER wiring step failed would be orphaned
    // in the application-autoscaling control plane with no table left to
    // name it unless that handler deregisters it, as it does for
    // `registeredBeforeReplicas`. Registering the rest last means nothing can
    // fail after it, and warn-instead-of-throw means a best-effort concern can
    // never be what destroys a successfully created table.
    //
    // Skipped on PAY_PER_REQUEST — scalable targets are meaningless
    // without provisioned capacity, and AWS rejects them.
    if (billingMode === 'PROVISIONED') {
      try {
        await this.reconcileAutoScalingTargets(
          tableName,
          [],
          scalingSpecs,
          currentRegion,
          new Set(registeredBeforeReplicas.map(autoScalingTargetKey)),
          maskSecrets
        );
      } catch (autoScalingErr) {
        warn(
          `Auto-scaling registration failed for ${tableName}: ` +
            `${describeAwsFailure(autoScalingErr).detail}. ` +
            `The table was created successfully; re-run the deploy to register the ` +
            `scaling targets.`
        );
      }
    }

    log.debug(`Successfully created DynamoDB GlobalTable ${logicalId}: ${log.value(tableName)}`);

    return {
      physicalId: tableName,
      attributes: {
        Arn: tableInfo.tableArn,
        TableId: tableInfo.tableId,
        StreamArn: tableInfo.streamArn,
        TableName: tableName,
      },
      ...(effectiveProperties && { effectiveProperties }),
    };
  } catch (wiringError) {
    // Partial-create cleanup. The table exists on AWS; delete it
    // before re-throwing so the user is not billed for a phantom
    // resource. Cleanup-step failures escalate to WARN with a recovery
    // command; the original error always propagates.
    //
    // IMPORTANT: if any non-local replicas were added before the
    // failure (replica-add loop is serial and partially-progressed
    // failures DO happen), AWS rejects `DeleteTable` on a
    // multi-replica table. We must drop the additional replicas
    // first — mirror the `delete()` shape: DescribeTable → per-region
    // Delete ReplicaUpdates → DeleteTable. Each step is best-effort
    // so a single sub-failure does not block the rest of the cleanup.
    warn(`Wiring failed after CreateTable for ${tableName}; attempting best-effort cleanup`);
    let tableLeftBehind = false;
    try {
      const describe = await this.dynamoDBClient.send(
        new DescribeTableCommand({ TableName: tableName })
      );
      const replicasForCleanup = describe.Table?.Replicas ?? [];
      for (const replica of replicasForCleanup) {
        const region = replica.RegionName;
        if (!region || region === currentRegion) continue;
        try {
          // A replica `addReplica` protected (go-to-k/cdkd#5355) refuses
          // the drop below. This create built it, so there is no user
          // setting to preserve: turn the guard off first. Only a replica
          // the template asked to protect can carry it, and even then it is
          // read from AWS first: the failure may have come before the guard
          // was set, and a flip against a replica still CREATING is refused.
          // Its own best-effort try, so a failed flip still leaves the drop
          // below to be attempted (and refused loudly).
          const declared = readReplicaDeletionProtection(
            localReplicaEntry(wiringProperties, region),
            region
          );
          try {
            const live =
              declared === true
                ? await this.getRegionalClient(region).send(
                    new DescribeTableCommand({ TableName: tableName })
                  )
                : undefined;
            if (live?.Table?.DeletionProtectionEnabled === true) {
              await this.setReplicaDeletionProtection(
                tableName,
                region,
                false,
                logicalId,
                maskSecrets
              );
            }
          } catch (flipError) {
            if (isInterruptedWaitError(flipError)) throw flipError;
            log.debug(
              `Partial-create cleanup: could not turn off deletion protection on the ` +
                `${region} replica of ${log.value(tableName)}: ` +
                log.mask(describeAwsFailure(flipError).detail)
            );
          }
          await this.dynamoDBClient.send(
            new UpdateTableCommand({
              TableName: tableName,
              ReplicaUpdates: [{ Delete: { RegionName: region } }],
            })
          );
          await this.waitForReplicaGone(
            tableName,
            region,
            logicalId,
            undefined,
            undefined,
            maskSecrets
          );
          // go-to-k/cdkd#5581: DynamoDB registered targets for the replica
          // this create added; they outlive it.
          await this.deregisterRemovedReplicaScalableTargets(tableName, region, {
            maskSecrets,
          });
        } catch (replicaCleanupErr) {
          // A Ctrl-C stops the cleanup like every other wait here.
          if (isInterruptedWaitError(replicaCleanupErr)) throw replicaCleanupErr;
          // The class at warn, AWS's text at debug (go-to-k/cdkd#2319).
          const msg = this.cleanupFailureText(
            log,
            `Partial-create cleanup: failed to drop replica ${region} on ${tableName}: `,
            replicaCleanupErr
          );
          // `Delete={RegionName=` and `}` are cdkd's own text, so they sit in
          // the template's literal part: passed as a value, their `{` and `}`
          // would withhold the command for every table (`PASTE_ARG_UNSAFE`,
          // go-to-k/cdkd#3950). The literal is single-quoted around the
          // value, so in a normal paste the shell sees one word,
          // `Delete={RegionName=<region>}`, with the braces never exposed:
          // unquoted, zsh's `BRACE_CCL` would expand them. A line flipped by
          // an apostrophe in `msg` (AWS error text) leaves them unquoted, but
          // the words stay glued to prose, so the worst case is an aws parse
          // error, not a run. `region` is an AWS region name read from
          // `DescribeTable`, so it holds no quote.
          warn(
            `Partial-create cleanup: failed to drop replica ${region} on ${tableName}: ${msg} ` +
              `Run: ${pasteableAwsCommand(maskSecrets)`aws dynamodb update-table --table-name ${tableName} --replica-updates 'Delete={RegionName='${region}'}' --region ${currentRegion}`.render()}`
          );
        }
      }
      // go-to-k/cdkd#5615: this handler does not route through `delete()`, and a
      // table it cannot delete is `delete()`'s to clean up, targets included.
      for (const spec of registeredBeforeReplicas) {
        await this.applyAutoScalingDiff(
          tableName,
          spec.dimension,
          spec.settings,
          undefined,
          undefined,
          spec.indexName,
          undefined,
          maskSecrets
        );
      }
      // go-to-k/cdkd#2762: a vector index may still be building when the
      // failure arrives (the wait for it can be what failed), and AWS refuses
      // `DeleteTable` during a build.
      if (createVectorIndexes !== undefined) {
        await this.rollBackCreatedVectorTable(logicalId, tableName, maskSecrets);
      } else {
        await this.dynamoDBClient.send(new DeleteTableCommand({ TableName: tableName }));
      }
      retractCreatedResource(logicalId, resourceType, tableName);
    } catch (cleanupErr) {
      tableLeftBehind = true;
      const cleanupMsg = this.cleanupFailureText(
        log,
        `Partial-create cleanup failed for ${tableName}: `,
        cleanupErr
      );
      // A bare `delete-table` would leave the write targets to a later table of
      // this name; `delete()` takes them with the table.
      warn(
        `Partial-create cleanup failed for ${tableName}: ${cleanupMsg} ` +
          (registeredBeforeReplicas.length > 0
            ? `Its write scalable targets and scaling policies may still be registered. To ` +
              `remove the table and them, run ${cdkdRemedy('cdkd rollback', '--revert-failed')}.`
            : `To remove the orphaned AWS-side table, run: ` +
              pasteableAwsCommand(
                maskSecrets
              )`aws dynamodb delete-table --table-name ${tableName}`.render())
      );
    }
    // CreateTable succeeded, so nothing raised here is this table's own name
    // collision: an "already exists" relayed from the replica add or the TTL
    // call would otherwise be credited to it, and `--replace` would delete
    // the live old table over it (issue #3826 / #3877).
    markAuxiliaryFailure(wiringError, logicalId);
    const cause = wiringError instanceof Error ? wiringError : undefined;
    const thrown = this.wrapMaskedError(
      log,
      wiringError,
      (text) =>
        new ProvisioningError(
          `Failed to create DynamoDB GlobalTable ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          tableName,
          cause
        )
    );
    // go-to-k/cdkd#4583: the cleanup DeleteTable failed, so the table this
    // call created is left behind — let `rollback --revert-failed` delete it.
    // With its `TableId` (go-to-k/cdkd#4606), the identity a later settle
    // compares before deleting it by name.
    if (tableLeftBehind) {
      markCreatedBeforeFailure(thrown, logicalId, resourceType, tableName, createdTableId);
    }
    throw thrown;
  }
}
