import type { Logger } from '../../types/config.js';
import { KMSClient } from '@aws-sdk/client-kms';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { ApplicationAutoScalingClient } from '@aws-sdk/client-application-auto-scaling';
import { getLogger } from '../../utils/logger.js';
import { getAwsClients } from '../../utils/aws-clients.js';
import type { DeleteContext } from '../region-check.js';
import { ProtectionFlipRegistry } from './dynamodb-delete-budget.js';
import { ElapsedBudgetRegistry } from '../../utils/elapsed-budget.js';
import type {
  ResourceProvider,
  ResourceCreateResult,
  ResourceUpdateResult,
  ResourceImportInput,
  ResourceImportResult,
  CreateContext,
  UpdateContext,
} from '../../types/resource.js';
import type { CredentialConfig } from '../../utils/ambient-client-defaults.js';
import {
  getCreateClient,
  getMinResourceTimeoutMs,
  getRegionalClient,
  getRegionalAutoScalingClient,
  getLocalAutoScalingClient,
  replicaArnForRegion,
  operationSinks,
  wrapMaskedError,
  cleanupFailureText,
  wrapDeleteError,
  autoScalingClientForRegion,
  kmsClientFor,
  kmsKeyManager,
} from './dynamodb-globaltable/clients.js';
import { create } from './dynamodb-globaltable/create.js';
import {
  rollBackCreatedVectorTable,
  reportThroughputDiagnostics,
  warmThroughputForSend,
  tableWarmThroughputForSend,
  applyVectorIndexUpdates,
  waitForVectorIndexesSettled,
} from './dynamodb-globaltable/create-support.js';
import {
  addReplica,
  setReplicaDeletionProtection,
  sendReplicaDeletionProtection,
  writeReplicaDeletionProtection,
  waitForReplicaProtectionSettled,
  convergeReplicaDeletionProtection,
  convergeReplicaDisassociationProtection,
  setReplicaDisassociationProtection,
  convergeReplicaSettings,
} from './dynamodb-globaltable/replica-protection.js';
import {
  applyReplicaKeys,
  readLiveKeys,
  replicaKeysRequest,
  applyReplicaSettings,
  sendReplicationMode,
  applyReplicaIndexInsights,
  readLiveReplicaSettings,
} from './dynamodb-globaltable/replica-settings.js';
import {
  deleteOldStreamPolicy,
  kinesisStreaming,
  waitForKinesisDisableSettled,
  activeKinesisStreamArns,
  sendReplicaSettingOp,
  retrySettlingRefusal,
  sendLocalSettingUpdate,
  waitForGlobalTableSettled,
  dropReplicaForDelete,
  restoreReplicaDeletionProtection,
  waitForRegionalCopyReleased,
} from './dynamodb-globaltable/replica-ops.js';
import {
  update,
  updateInScope,
  applyTagDiff,
  applyCrossRegionReplicaTagsDiff,
  applyTagDiffOnClient,
} from './dynamodb-globaltable/update.js';
import {
  applyAutoScalingDiff,
  probeRegisteredTargets,
  reconcileAutoScalingTargets,
  deregisterRemovedReplicaScalableTargets,
} from './dynamodb-globaltable/autoscaling.js';
import { deleteResource, deleteGlobalTableResource } from './dynamodb-globaltable/delete.js';
import {
  isSameResource,
  resourceIdentity,
  readTableIdIfExists,
  getAttribute,
  readUnsettled,
  unsettledInTransition,
  readCurrentState,
} from './dynamodb-globaltable/read.js';
import {
  readReplicaSubSpecs,
  readReplicaPolicies,
  readAutoScalingSettings,
  importResource,
} from './dynamodb-globaltable/read-support.js';
import {
  getDriftUnknownPaths,
  getDriftUnorderedPaths,
  canonicalizeDriftProperties,
  canonicalizeDesiredProperties,
  canonicalizeDriftPair,
  getDriftAbsentMeansDefaultKeys,
} from './dynamodb-globaltable/drift.js';
import {
  waitForTableActive,
  waitForTableActiveAfterUpdate,
  waitForIndexesActive,
  waitForReplicaActive,
  waitForReplicaGone,
  readReplicaTableRetired,
  waitForTableGone,
} from './dynamodb-globaltable/waits.js';

export { type UnnamedLiveEntry } from './dynamodb-globaltable/projection.js';
export {
  localReplicaEntry,
  type ReplicationModeRead,
  readReplicationMode,
  replicationModeUpdate,
  replicationModeCorrection,
  replicaSettingsRefusal,
  extractLocalDeletionProtection,
  extractAnyDeletionProtection,
  readReplicaKmsMasterKeyId,
  readReplicaTableClass,
  UNUSABLE,
  readReplicaDeletionProtection,
  tableClassToSend,
  extractLocalTableClass,
} from './dynamodb-globaltable/replica-shape.js';
export {
  derivePerCallProvisionedThroughput,
  type DynamoDBScalableDimension,
  type AutoScalingTargetSpec,
  autoScalingTargetKey,
  autoScalingResourceId,
  autoScalingRetryDelays,
  GLOBAL_TABLE_ACTIVE_WAIT_ATTEMPTS,
  TABLE_GONE_WAIT_ATTEMPTS,
  replicaDeleteGoneWait,
  deleteTableRetryDelays,
  collectAutoScalingTargets,
  REPLICA_COPY_RELEASE_POLLS,
  REPLICA_COPY_RELEASE_POLL_MS,
  DELETION_PROTECTION_REFLIP_MS,
  relayedEncryptionChangeLimit,
  REPLICA_PROTECTION_SETTLE_POLLS,
  REPLICA_PROTECTION_SETTLE_POLL_MS,
  SETTLING_RETRY_ATTEMPTS,
  SETTLING_RETRY_INITIAL_MS,
  REPLICA_COPY_RELEASE_ATTEMPTS,
  isReplicaCopyExistsRefusal,
  withdrawReplicaIndexBlocks,
  replicationImpliedStreamSpecification,
  collectDesiredKeyAttributeNames,
} from './dynamodb-globaltable/capacity.js';
export {
  type ThroughputDiagnostic,
  deriveWriteCapacityUnits,
  deriveReadCapacityUnits,
  type CapacitySource,
  globalSecondaryIndexesShapeDetail,
} from './dynamodb-globaltable/throughput.js';
export {
  toSdkGlobalSecondaryIndexes,
  stripProvisionedCapacityKeys,
  retainUnsendableCapacityMembers,
  type RawOnDemandDeclaration,
  collectRawOnDemandDeclarations,
} from './dynamodb-globaltable/gsi.js';
export {
  collectUncomparableCapacityGsiNames,
  type LiveRecoveryBaselineOptions,
  buildLiveRecoveryGsiBaseline,
  toSdkReplicaGlobalSecondaryIndexes,
  type RawCeiling,
  collectTableOnDemandCeilings,
  diffReplicas,
  diffGlobalSecondaryIndexes,
} from './dynamodb-globaltable/gsi-diff.js';

export class DynamoDBGlobalTableProvider implements ResourceProvider {
  dynamoDBClient: DynamoDBClient;

  createClient: Promise<DynamoDBClient> | undefined;

  /** The credential half of the `AwsClients` `dynamoDBClient` came from (#4639). */
  readonly credentialConfig: CredentialConfig;

  logger: Logger = getLogger().child('DynamoDBGlobalTableProvider');

  /**
   * Caches per-region `DynamoDBClient` instances for cross-region drift
   * reads (`readCurrentState`) and cross-region Tag propagation
   * (`update()`). Keyed by region string; reuses the default credential
   * chain. Lifetime is the provider instance — one deploy run.
   */
  regionalClientCache = new Map<string, DynamoDBClient>();

  /**
   * go-to-k/cdkd#5790: `KeyManager` per KMS key ARN, for the drift pair hook.
   * `undefined` = could not be read. One lookup per key per provider instance.
   */
  kmsKeyManagerCache = new Map<string, Promise<string | undefined>>();

  kmsClientCache = new Map<string, KMSClient>();

  /**
   * Caches per-region `ApplicationAutoScalingClient` instances for
   * per-replica `ReadCapacityAutoScalingSettings` reverse-mapping in
   * `readCurrentState`. Same lifetime / shape as `regionalClientCache`
   * — one per region for the duration of the provider instance.
   *
   * Issue #395: per-replica read capacity autoscaling lives in the
   * replica's region (each replica has its own scaling target +
   * policy registered against `application-autoscaling` in that
   * region), so we cannot reuse the local-region client.
   */
  regionalAutoScalingClientCache = new Map<string, ApplicationAutoScalingClient>();

  /**
   * Caches `getAttribute(physicalId, attribute)` results for the lifetime
   * of this provider instance (one deploy run). Safe under the current
   * `update()` contract because `update()` cannot mid-deploy mutate
   * StreamArn / Arn / TableId — those are AWS-managed identifiers that
   * only change on REPLACEMENT (which destroys the provider instance).
   * If a future PR adds a stream toggle path that flips StreamArn on the
   * same physicalId, the cache must be invalidated on the matching
   * UpdateTable success.
   */
  attributeCache = new Map<string, unknown>();

  /**
   * The ONE wall-clock allowance each `delete()` spends, keyed by physical id
   * (issue #1955). Keyed rather than per-call because `destroy-runner.ts` can
   * RE-ENTER `delete()` from the top — its outer retry loop classes a throttled
   * `DeleteTable` as retryable — inside the SAME per-resource deadline, and a
   * per-call budget would hand that second pass a fresh allowance. Keyed rather
   * than per-instance because a destroy level deletes its resources
   * CONCURRENTLY through this one provider instance.
   *
   * See `./dynamodb-delete-budget.ts` for the sizing and for the three failure
   * terms it closes.
   */
  readonly deleteBudgets = new ElapsedBudgetRegistry();

  /**
   * What each in-flight delete did to `DeletionProtectionEnabled` (issue
   * #1978), keyed exactly as the allowance above and for exactly the same
   * reason: `destroy-runner.ts` re-enters `delete()` after a retryable failure,
   * and the second attempt's pre-flip `DescribeTable` sees the guard already
   * off BECAUSE the first attempt turned it off. A record created per call
   * would therefore read "nothing to undo" on precisely the retry-then-fail
   * case the issue names. Keyed rather than a plain field for the budget's
   * reason too — one provider instance serves a whole level's tables at once.
   */
  readonly protectionFlips = new ProtectionFlipRegistry();

  /**
   * go-to-k/cdkd#5699: the replica regions each in-flight delete has dropped,
   * keyed as the allowance above and for the same reason: a re-entered
   * `delete()` reads a source table that no longer lists them, so a per-call
   * list would forget the copies the first attempt left `DELETING`, and the
   * destroy would return over them. Released where the allowance is.
   */
  readonly droppedReplicaRegions = new Map<string, Set<string>>();

  handledProperties = new Map<string, ReadonlySet<string>>([
    [
      'AWS::DynamoDB::GlobalTable',
      new Set([
        'TableName',
        'KeySchema',
        'AttributeDefinitions',
        'BillingMode',
        'StreamSpecification',
        'GlobalSecondaryIndexes',
        'LocalSecondaryIndexes',
        'SSESpecification',
        'Replicas',
        'TableClass',
        'TimeToLiveSpecification',
        'WriteProvisionedThroughputSettings',
        'WriteOnDemandThroughputSettings',
        'DeletionProtectionEnabled',
        'ReadOnDemandThroughputSettings',
        'ReadProvisionedThroughputSettings',
        'TableType',
        'VectorIndexes',
        'WarmThroughput',
        // Note: `AWS::DynamoDB::GlobalTable` has NO top-level `Tags`
        // property. Tags live inside `Replicas[].Tags`, which is
        // already covered by the `Replicas` entry above.
        //
        // Three properties stay on the Cloud Control route: see
        // `unhandledByDesign` below.
      ]),
    ],
  ]);

  // go-to-k/cdkd#2762, #5629: these stay on the Cloud Control route. A
  // by-design row still auto-routes the resource there, so nothing is dropped.
  unhandledByDesign = new Map<string, ReadonlyMap<string, string>>([
    [
      'AWS::DynamoDB::GlobalTable',
      new Map<string, string>([
        [
          'MultiRegionConsistency',
          "MRSC does not fit the per-replica serial paths: measured 2026-11-01 (us-east-1 / us-east-2 / us-west-2), the replica and witness Creates must go out in ONE UpdateTable with the mode, a lone replica Delete is refused ('does not include all witnesses'), DeleteTable is refused until they are gone, TTL is refused, and the table carries no stream, which create()'s needsStream arm would enable. Stays on Cloud Control",
        ],
        [
          'GlobalTableWitnesses',
          'MRSC witness; same one-call UpdateTable shape as MultiRegionConsistency, measured 2026-11-01. Stays on Cloud Control',
        ],
        [
          'GlobalTableSourceArn',
          "Multi-account replica: CDK's TableV2MultiAccountReplica renders no KeySchema (which create() requires) and DynamoDB asks for a ResourcePolicy on the CreateTable (measured 2026-11-01), a cross-account path this provider cannot exercise. Stays on Cloud Control",
        ],
      ]),
    ],
  ]);

  constructor() {
    const awsClients = getAwsClients();
    this.dynamoDBClient = awsClients.dynamoDB;
    // A test double may carry no `credentialConfig`: degrade to `{}`, as
    // `ambientCredentialConfig` does.
    this.credentialConfig =
      (awsClients as { credentialConfig?: CredentialConfig }).credentialConfig ?? {};
  }

  getCreateClient(...args: Parameters<typeof getCreateClient>) {
    return getCreateClient.call(this, ...args);
  }

  getMinResourceTimeoutMs(...args: Parameters<typeof getMinResourceTimeoutMs>) {
    return getMinResourceTimeoutMs.call(this, ...args);
  }

  getRegionalClient(...args: Parameters<typeof getRegionalClient>) {
    return getRegionalClient.call(this, ...args);
  }

  getRegionalAutoScalingClient(...args: Parameters<typeof getRegionalAutoScalingClient>) {
    return getRegionalAutoScalingClient.call(this, ...args);
  }

  /**
   * Lazy-init + cache the local-region `ApplicationAutoScalingClient`.
   * Previously `applyAutoScalingDiff` constructed a fresh client per
   * call when no `client` arg was passed, leaking SDK clients (each
   * holds its own HTTP agent) on multi-stack runs with many
   * GlobalTables (PR #403 review minor #4).
   */
  localAutoScalingClient: ApplicationAutoScalingClient | undefined;

  getLocalAutoScalingClient(...args: Parameters<typeof getLocalAutoScalingClient>) {
    return getLocalAutoScalingClient.call(this, ...args);
  }

  replicaArnForRegion(...args: Parameters<typeof replicaArnForRegion>) {
    return replicaArnForRegion.call(this, ...args);
  }

  operationSinks(...args: Parameters<typeof operationSinks>) {
    return operationSinks.call(this, ...args);
  }

  wrapMaskedError(...args: Parameters<typeof wrapMaskedError>) {
    return wrapMaskedError.call(this, ...args);
  }

  cleanupFailureText(...args: Parameters<typeof cleanupFailureText>) {
    return cleanupFailureText.call(this, ...args);
  }

  wrapDeleteError(...args: Parameters<typeof wrapDeleteError>) {
    return wrapDeleteError.call(this, ...args);
  }

  create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    context?: CreateContext
  ): Promise<ResourceCreateResult> {
    return create.call(this, logicalId, resourceType, properties, context);
  }

  rollBackCreatedVectorTable(...args: Parameters<typeof rollBackCreatedVectorTable>) {
    return rollBackCreatedVectorTable.call(this, ...args);
  }

  reportThroughputDiagnostics(...args: Parameters<typeof reportThroughputDiagnostics>) {
    return reportThroughputDiagnostics.call(this, ...args);
  }

  warmThroughputForSend(...args: Parameters<typeof warmThroughputForSend>) {
    return warmThroughputForSend.call(this, ...args);
  }

  tableWarmThroughputForSend(...args: Parameters<typeof tableWarmThroughputForSend>) {
    return tableWarmThroughputForSend.call(this, ...args);
  }

  applyVectorIndexUpdates(...args: Parameters<typeof applyVectorIndexUpdates>) {
    return applyVectorIndexUpdates.call(this, ...args);
  }

  waitForVectorIndexesSettled(...args: Parameters<typeof waitForVectorIndexesSettled>) {
    return waitForVectorIndexesSettled.call(this, ...args);
  }

  addReplica(...args: Parameters<typeof addReplica>) {
    return addReplica.call(this, ...args);
  }

  setReplicaDeletionProtection(...args: Parameters<typeof setReplicaDeletionProtection>) {
    return setReplicaDeletionProtection.call(this, ...args);
  }

  sendReplicaDeletionProtection(...args: Parameters<typeof sendReplicaDeletionProtection>) {
    return sendReplicaDeletionProtection.call(this, ...args);
  }

  writeReplicaDeletionProtection(...args: Parameters<typeof writeReplicaDeletionProtection>) {
    return writeReplicaDeletionProtection.call(this, ...args);
  }

  waitForReplicaProtectionSettled(...args: Parameters<typeof waitForReplicaProtectionSettled>) {
    return waitForReplicaProtectionSettled.call(this, ...args);
  }

  convergeReplicaDeletionProtection(...args: Parameters<typeof convergeReplicaDeletionProtection>) {
    return convergeReplicaDeletionProtection.call(this, ...args);
  }

  convergeReplicaDisassociationProtection(
    ...args: Parameters<typeof convergeReplicaDisassociationProtection>
  ) {
    return convergeReplicaDisassociationProtection.call(this, ...args);
  }

  setReplicaDisassociationProtection(
    ...args: Parameters<typeof setReplicaDisassociationProtection>
  ) {
    return setReplicaDisassociationProtection.call(this, ...args);
  }

  convergeReplicaSettings(...args: Parameters<typeof convergeReplicaSettings>) {
    return convergeReplicaSettings.call(this, ...args);
  }

  applyReplicaKeys(...args: Parameters<typeof applyReplicaKeys>) {
    return applyReplicaKeys.call(this, ...args);
  }

  readLiveKeys(...args: Parameters<typeof readLiveKeys>) {
    return readLiveKeys.call(this, ...args);
  }

  replicaKeysRequest(...args: Parameters<typeof replicaKeysRequest>) {
    return replicaKeysRequest.call(this, ...args);
  }

  applyReplicaSettings(...args: Parameters<typeof applyReplicaSettings>) {
    return applyReplicaSettings.call(this, ...args);
  }

  sendReplicationMode(...args: Parameters<typeof sendReplicationMode>) {
    return sendReplicationMode.call(this, ...args);
  }

  applyReplicaIndexInsights(...args: Parameters<typeof applyReplicaIndexInsights>) {
    return applyReplicaIndexInsights.call(this, ...args);
  }

  readLiveReplicaSettings(...args: Parameters<typeof readLiveReplicaSettings>) {
    return readLiveReplicaSettings.call(this, ...args);
  }

  deleteOldStreamPolicy(...args: Parameters<typeof deleteOldStreamPolicy>) {
    return deleteOldStreamPolicy.call(this, ...args);
  }

  kinesisStreaming(...args: Parameters<typeof kinesisStreaming>) {
    return kinesisStreaming.call(this, ...args);
  }

  /**
   * The pauses between re-reads of a Kinesis destination this update
   * disabled. `DisableKinesisStreamingDestination` answers `DISABLING`, and
   * the first `DescribeKinesisStreamingDestination` after it read `ACTIVE` in
   * one run and `DISABLING` in another, then `DISABLED` about a second later
   * (measured us-east-1, 2026-10-28). The deploy captures its drift baseline
   * right after the update, so a capture inside that window recorded a
   * destination AWS was removing, and every later `cdkd drift` reported it
   * (go-to-k/cdkd#5399's integ).
   */
  kinesisDisableSettleDelaysMs: readonly number[] = Array<number>(30).fill(2000);

  waitForKinesisDisableSettled(...args: Parameters<typeof waitForKinesisDisableSettled>) {
    return waitForKinesisDisableSettled.call(this, ...args);
  }

  activeKinesisStreamArns(...args: Parameters<typeof activeKinesisStreamArns>) {
    return activeKinesisStreamArns.call(this, ...args);
  }

  sendReplicaSettingOp(...args: Parameters<typeof sendReplicaSettingOp>) {
    return sendReplicaSettingOp.call(this, ...args);
  }

  retrySettlingRefusal(...args: Parameters<typeof retrySettlingRefusal>) {
    return retrySettlingRefusal.call(this, ...args);
  }

  sendLocalSettingUpdate(...args: Parameters<typeof sendLocalSettingUpdate>) {
    return sendLocalSettingUpdate.call(this, ...args);
  }

  waitForGlobalTableSettled(...args: Parameters<typeof waitForGlobalTableSettled>) {
    return waitForGlobalTableSettled.call(this, ...args);
  }

  dropReplicaForDelete(...args: Parameters<typeof dropReplicaForDelete>) {
    return dropReplicaForDelete.call(this, ...args);
  }

  restoreReplicaDeletionProtection(...args: Parameters<typeof restoreReplicaDeletionProtection>) {
    return restoreReplicaDeletionProtection.call(this, ...args);
  }

  waitForRegionalCopyReleased(...args: Parameters<typeof waitForRegionalCopyReleased>) {
    return waitForRegionalCopyReleased.call(this, ...args);
  }

  update(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>,
    context?: UpdateContext
  ): Promise<ResourceUpdateResult> {
    return update.call(
      this,
      logicalId,
      physicalId,
      resourceType,
      properties,
      previousProperties,
      context
    );
  }

  updateInScope(...args: Parameters<typeof updateInScope>) {
    return updateInScope.call(this, ...args);
  }

  applyTagDiff(...args: Parameters<typeof applyTagDiff>) {
    return applyTagDiff.call(this, ...args);
  }

  applyCrossRegionReplicaTagsDiff(...args: Parameters<typeof applyCrossRegionReplicaTagsDiff>) {
    return applyCrossRegionReplicaTagsDiff.call(this, ...args);
  }

  applyTagDiffOnClient(...args: Parameters<typeof applyTagDiffOnClient>) {
    return applyTagDiffOnClient.call(this, ...args);
  }

  applyAutoScalingDiff(...args: Parameters<typeof applyAutoScalingDiff>) {
    return applyAutoScalingDiff.call(this, ...args);
  }

  autoScalingClientForRegion(...args: Parameters<typeof autoScalingClientForRegion>) {
    return autoScalingClientForRegion.call(this, ...args);
  }

  probeRegisteredTargets(...args: Parameters<typeof probeRegisteredTargets>) {
    return probeRegisteredTargets.call(this, ...args);
  }

  reconcileAutoScalingTargets(...args: Parameters<typeof reconcileAutoScalingTargets>) {
    return reconcileAutoScalingTargets.call(this, ...args);
  }

  delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    _properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void> {
    return deleteResource.call(this, logicalId, physicalId, resourceType, _properties, context);
  }

  deleteGlobalTableResource(...args: Parameters<typeof deleteGlobalTableResource>) {
    return deleteGlobalTableResource.call(this, ...args);
  }

  isSameResource(...args: Parameters<typeof isSameResource>) {
    return isSameResource.call(this, ...args);
  }

  resourceIdentity(...args: Parameters<typeof resourceIdentity>) {
    return resourceIdentity.call(this, ...args);
  }

  readTableIdIfExists(...args: Parameters<typeof readTableIdIfExists>) {
    return readTableIdIfExists.call(this, ...args);
  }

  getAttribute(...args: Parameters<typeof getAttribute>) {
    return getAttribute.call(this, ...args);
  }

  readUnsettled(...args: Parameters<typeof readUnsettled>) {
    return readUnsettled.call(this, ...args);
  }

  unsettledInTransition(...args: Parameters<typeof unsettledInTransition>) {
    return unsettledInTransition.call(this, ...args);
  }

  readCurrentState(...args: Parameters<typeof readCurrentState>) {
    return readCurrentState.call(this, ...args);
  }

  readReplicaSubSpecs(...args: Parameters<typeof readReplicaSubSpecs>) {
    return readReplicaSubSpecs.call(this, ...args);
  }

  /**
   * How long a resource-policy read that does NOT match the declaration is
   * re-asked before it is believed: one entry per extra attempt.
   */
  policyRereadDelaysMs: readonly number[] = [500, 1000, 2000];

  readReplicaPolicies(...args: Parameters<typeof readReplicaPolicies>) {
    return readReplicaPolicies.call(this, ...args);
  }

  readAutoScalingSettings(...args: Parameters<typeof readAutoScalingSettings>) {
    return readAutoScalingSettings.call(this, ...args);
  }

  getDriftUnknownPaths(...args: Parameters<typeof getDriftUnknownPaths>) {
    return getDriftUnknownPaths.call(this, ...args);
  }

  getDriftUnorderedPaths(...args: Parameters<typeof getDriftUnorderedPaths>) {
    return getDriftUnorderedPaths.call(this, ...args);
  }

  canonicalizeDriftProperties(...args: Parameters<typeof canonicalizeDriftProperties>) {
    return canonicalizeDriftProperties.call(this, ...args);
  }

  canonicalizeDesiredProperties(...args: Parameters<typeof canonicalizeDesiredProperties>) {
    return canonicalizeDesiredProperties.call(this, ...args);
  }

  canonicalizeDriftPair(...args: Parameters<typeof canonicalizeDriftPair>) {
    return canonicalizeDriftPair.call(this, ...args);
  }

  kmsClientFor(...args: Parameters<typeof kmsClientFor>) {
    return kmsClientFor.call(this, ...args);
  }

  kmsKeyManager(...args: Parameters<typeof kmsKeyManager>) {
    return kmsKeyManager.call(this, ...args);
  }

  getDriftAbsentMeansDefaultKeys(...args: Parameters<typeof getDriftAbsentMeansDefaultKeys>) {
    return getDriftAbsentMeansDefaultKeys.call(this, ...args);
  }

  import(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    return importResource.call(this, input);
  }

  waitForTableActive(...args: Parameters<typeof waitForTableActive>) {
    return waitForTableActive.call(this, ...args);
  }

  waitForTableActiveAfterUpdate(...args: Parameters<typeof waitForTableActiveAfterUpdate>) {
    return waitForTableActiveAfterUpdate.call(this, ...args);
  }

  waitForIndexesActive(...args: Parameters<typeof waitForIndexesActive>) {
    return waitForIndexesActive.call(this, ...args);
  }

  waitForReplicaActive(...args: Parameters<typeof waitForReplicaActive>) {
    return waitForReplicaActive.call(this, ...args);
  }

  waitForReplicaGone(...args: Parameters<typeof waitForReplicaGone>) {
    return waitForReplicaGone.call(this, ...args);
  }

  deregisterRemovedReplicaScalableTargets(
    ...args: Parameters<typeof deregisterRemovedReplicaScalableTargets>
  ) {
    return deregisterRemovedReplicaScalableTargets.call(this, ...args);
  }

  readReplicaTableRetired(...args: Parameters<typeof readReplicaTableRetired>) {
    return readReplicaTableRetired.call(this, ...args);
  }

  waitForTableGone(...args: Parameters<typeof waitForTableGone>) {
    return waitForTableGone.call(this, ...args);
  }
}
