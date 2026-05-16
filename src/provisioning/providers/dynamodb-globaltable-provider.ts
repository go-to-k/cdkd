import {
  DynamoDBClient,
  CreateTableCommand,
  DeleteTableCommand,
  DescribeContinuousBackupsCommand,
  DescribeContributorInsightsCommand,
  DescribeKinesisStreamingDestinationCommand,
  DescribeTableCommand,
  DescribeTimeToLiveCommand,
  ListTablesCommand,
  ListTagsOfResourceCommand,
  TagResourceCommand,
  UntagResourceCommand,
  UpdateTableCommand,
  UpdateTimeToLiveCommand,
  ResourceNotFoundException,
  type CreateTableCommandInput,
  type KeySchemaElement,
  type AttributeDefinition,
  type GlobalSecondaryIndex,
  type GlobalSecondaryIndexUpdate,
  type LocalSecondaryIndex,
  type StreamSpecification,
  type Tag,
  type ReplicationGroupUpdate,
  type CreateReplicationGroupMemberAction,
  type UpdateReplicationGroupMemberAction,
  type UpdateTableCommandInput,
} from '@aws-sdk/client-dynamodb';
import {
  ApplicationAutoScalingClient,
  DescribeScalableTargetsCommand,
  DescribeScalingPoliciesCommand,
  RegisterScalableTargetCommand,
  PutScalingPolicyCommand,
  DeleteScalingPolicyCommand,
  DeregisterScalableTargetCommand,
} from '@aws-sdk/client-application-auto-scaling';
import { getLogger } from '../../utils/logger.js';
import { getAwsClients } from '../../utils/aws-clients.js';
import { ProvisioningError } from '../../utils/error-handler.js';
import { generateResourceName } from '../resource-name.js';
import { assertRegionMatch, type DeleteContext } from '../region-check.js';
import {
  matchesCdkPath,
  normalizeAwsTagsToCfn,
  resolveExplicitPhysicalId,
} from '../import-helpers.js';
import type {
  ResourceProvider,
  ResourceCreateResult,
  ResourceUpdateResult,
  ResourceImportInput,
  ResourceImportResult,
} from '../../types/resource.js';

/**
 * AWS DynamoDB GlobalTable Provider
 *
 * Implements resource provisioning for AWS::DynamoDB::GlobalTable using the
 * standard DynamoDB SDK (2019.11.21 API generation, NOT the legacy
 * 2017.11.29 endpoints). CDK v2's `dynamodb.TableV2` construct synthesizes
 * as this type.
 *
 * WHY a dedicated SDK provider:
 *   - Pre-PR the type fell through to Cloud Control API which did not pass
 *     a `TableName` field, so AWS auto-generated random names like
 *     `yq2phLewTEUtzr4sy2gYFRU4I-1OGJ0UFLOKOOV` instead of the cdkd
 *     `${stackName}-X<hash>` shape (Issue #383).
 *   - Per memory rule `feedback_dedicated_provider_over_special_case.md`,
 *     the consistent fix is a dedicated SDK Provider rather than adding
 *     the type to `FALLBACK_NAME_RULES`.
 *
 * **CRITICAL**: do NOT use the legacy 2017.11.29 endpoints
 * (`CreateGlobalTableCommand` / `UpdateGlobalTableCommand` /
 * `DescribeGlobalTableCommand`). The CFn type `AWS::DynamoDB::GlobalTable`
 * is the 2019.11.21 generation, which uses the regular DynamoDB CRUD API
 * (`CreateTableCommand` + `UpdateTableCommand` with `ReplicaUpdates`).
 *
 * In-place update support (post-PR #384 follow-up):
 *  - `update()` covers every mutable surface — Tags, DeletionProtection,
 *    TableClass, SSE, StreamSpec, OnDemand throughput, BillingMode flip,
 *    Replica add / remove / modify, GSI add / remove / modify, TTL toggle.
 *  - The serialization is load-bearing: AWS's `UpdateTable` accepts only
 *    ONE of `{BillingMode, ReplicaUpdates, GlobalSecondaryIndexUpdates}`
 *    per call, so each category is its own SDK round-trip with a wait-for
 *    -ACTIVE in between. Immutable property changes (TableName, KeySchema,
 *    AttributeDefinitions removal, LocalSecondaryIndexes) throw
 *    `ProvisioningError` naming the offending field — the deploy engine's
 *    diff classification should catch these as REPLACEMENT before ever
 *    calling `update()`, but the guard is defense-in-depth.
 *  - Per-replica drift (`ContributorInsightsSpecification` /
 *    `PointInTimeRecoverySpecification` / `KinesisStreamSpecification`)
 *    is surfaced for BOTH the LOCAL replica AND cross-region replicas
 *    via per-region SDK clients (cached in `regionalClientCache` for
 *    the deploy run). Issue #389 lifted the v1 LOCAL-only limitation.
 *  - Cross-region replica Tags propagation (Issue #389): when the
 *    update path detects a Tags-only diff on a non-local replica,
 *    cdkd resolves the replica's table ARN by swapping the region
 *    segment of the local ARN and issues `TagResource` /
 *    `UntagResource` against a per-region client.
 */
export class DynamoDBGlobalTableProvider implements ResourceProvider {
  private dynamoDBClient: DynamoDBClient;
  private logger = getLogger().child('DynamoDBGlobalTableProvider');
  /**
   * Caches per-region `DynamoDBClient` instances for cross-region drift
   * reads (`readCurrentState`) and cross-region Tag propagation
   * (`update()`). Keyed by region string; reuses the default credential
   * chain. Lifetime is the provider instance — one deploy run.
   */
  private regionalClientCache = new Map<string, DynamoDBClient>();
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
  private regionalAutoScalingClientCache = new Map<string, ApplicationAutoScalingClient>();
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
  private attributeCache = new Map<string, unknown>();

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
        // Note: `AWS::DynamoDB::GlobalTable` has NO top-level `Tags`
        // property. Tags live inside `Replicas[].Tags`, which is
        // already covered by the `Replicas` entry above.
      ]),
    ],
  ]);

  constructor() {
    const awsClients = getAwsClients();
    this.dynamoDBClient = awsClients.dynamoDB;
  }

  /**
   * Return a `DynamoDBClient` pinned to the given region, caching per
   * region for the lifetime of this provider instance. Uses the default
   * credential chain (env / shared config / IAM role) — no explicit
   * credential plumbing needed.
   *
   * Used by `readCurrentState` (cross-region per-replica sub-spec reads)
   * and `update()` (cross-region replica Tag propagation). Both code
   * paths fire region-scoped DynamoDB APIs (`DescribeContributorInsights`
   * / `DescribeContinuousBackups` / `DescribeKinesisStreamingDestination`
   * / `TagResource` / `UntagResource`) against the replica's region.
   *
   * The cache may return `this.dynamoDBClient` when `region` happens to
   * match the local client's region — in tests the local mock is
   * intercepted via `vi.mock('../../utils/aws-clients.js')` so reuse
   * is safe (and explicitly desired so the mock catches the call).
   */
  private getRegionalClient(region: string): DynamoDBClient {
    const cached = this.regionalClientCache.get(region);
    if (cached) return cached;
    const client = new DynamoDBClient({ region });
    this.regionalClientCache.set(region, client);
    return client;
  }

  /**
   * Return an `ApplicationAutoScalingClient` pinned to the given region,
   * caching per region for the lifetime of this provider instance. Mirrors
   * `getRegionalClient` but for the application-autoscaling service.
   *
   * Used by `readAutoScalingSettings` (Issue #395) to recover per-replica
   * `ReadCapacityAutoScalingSettings` shapes — each cross-region replica's
   * scaling target + policy are registered with the autoscaling control
   * plane in the replica's region, so cross-region drift reads need a
   * region-scoped client.
   */
  private getRegionalAutoScalingClient(region: string): ApplicationAutoScalingClient {
    const cached = this.regionalAutoScalingClientCache.get(region);
    if (cached) return cached;
    const client = new ApplicationAutoScalingClient({ region });
    this.regionalAutoScalingClientCache.set(region, client);
    return client;
  }

  /**
   * Lazy-init + cache the local-region `ApplicationAutoScalingClient`.
   * Previously `applyAutoScalingDiff` constructed a fresh client per
   * call when no `client` arg was passed, leaking SDK clients (each
   * holds its own HTTP agent) on multi-stack runs with many
   * GlobalTables (PR #403 review minor #4).
   */
  private localAutoScalingClient: ApplicationAutoScalingClient | undefined;
  private async getLocalAutoScalingClient(): Promise<ApplicationAutoScalingClient> {
    if (this.localAutoScalingClient) return this.localAutoScalingClient;
    const region = (await this.dynamoDBClient.config.region()) ?? '';
    this.localAutoScalingClient = new ApplicationAutoScalingClient({ region });
    return this.localAutoScalingClient;
  }

  /**
   * Construct the regional table ARN for a cross-region replica of a
   * GlobalTable. AWS replicates the same `TableName` across every
   * replica region, with each replica's ARN differing only in the
   * `:<region>:` segment. Cheaper than a second `DescribeTable` round-
   * trip on the regional client.
   *
   * Example:
   *   local ARN:   arn:aws:dynamodb:us-east-1:123:table/Foo
   *   for eu-west-1 → arn:aws:dynamodb:eu-west-1:123:table/Foo
   *
   * Returns `undefined` when the local ARN is malformed (defensive —
   * downstream callers omit the offending operation rather than throw).
   */
  private replicaArnForRegion(localTableArn: string, targetRegion: string): string | undefined {
    const segments = localTableArn.split(':');
    if (segments.length < 6) return undefined;
    segments[3] = targetRegion;
    return segments.join(':');
  }

  /**
   * Create a DynamoDB Global Table (CDK TableV2).
   *
   * GlobalTable is built on the regular DynamoDB Table primitive: cdkd issues
   * `CreateTableCommand` first (which only creates the table in the local
   * region), waits for `ACTIVE`, then issues one `UpdateTableCommand` per
   * additional replica region via `ReplicaUpdates: [{ Create: {...} }]`.
   *
   * Streams must be enabled with `NEW_AND_OLD_IMAGES` when the table has any
   * cross-region replicas — AWS rejects the replica-add otherwise. cdkd
   * auto-enables them with an info log when the template omits it.
   *
   * Partial-create cleanup (PR #374-class): if any post-`CreateTableCommand`
   * wiring (wait ACTIVE → replica adds → TTL → Tags) throws, cdkd issues a
   * best-effort `DeleteTableCommand` so AWS is not left holding a billing
   * orphan with no cdkd state record. Cleanup failures escalate to WARN
   * with the exact `aws dynamodb delete-table --table-name <id>` recovery
   * command.
   */
  async create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
  ): Promise<ResourceCreateResult> {
    this.logger.debug(`Creating DynamoDB GlobalTable ${logicalId}`);

    const tableName =
      (properties['TableName'] as string | undefined) ||
      generateResourceName(logicalId, { maxLength: 255 });
    const keySchema = properties['KeySchema'] as KeySchemaElement[] | undefined;
    const attributeDefinitions = properties['AttributeDefinitions'] as
      | AttributeDefinition[]
      | undefined;

    if (!keySchema) {
      throw new ProvisioningError(
        `KeySchema is required for DynamoDB GlobalTable ${logicalId}`,
        resourceType,
        logicalId
      );
    }
    if (!attributeDefinitions) {
      throw new ProvisioningError(
        `AttributeDefinitions is required for DynamoDB GlobalTable ${logicalId}`,
        resourceType,
        logicalId
      );
    }

    // GlobalTable defaults to PAY_PER_REQUEST in CDK; respect explicit override.
    const billingMode = (properties['BillingMode'] as string | undefined) ?? 'PAY_PER_REQUEST';

    const currentRegion = (await this.dynamoDBClient.config.region()) ?? '';
    const replicas = (properties['Replicas'] as Array<Record<string, unknown>> | undefined) ?? [];

    const createParams: CreateTableCommandInput = {
      TableName: tableName,
      KeySchema: keySchema,
      AttributeDefinitions: attributeDefinitions,
      BillingMode: billingMode as 'PROVISIONED' | 'PAY_PER_REQUEST',
    };

    // ProvisionedThroughput: GlobalTable's CFn shape uses
    // `WriteProvisionedThroughputSettings` for write capacity and a
    // per-replica `ReadProvisionedThroughputSettings` for read capacity.
    // The base CreateTable call needs `ProvisionedThroughput` when
    // BillingMode=PROVISIONED. We pull WriteCapacityUnits from
    // `WriteProvisionedThroughputSettings.WriteCapacityAutoScalingSettings`
    // when present, else default to 5/5. Read capacity is per-replica;
    // we use the deploy-region replica's setting when available.
    if (billingMode === 'PROVISIONED') {
      createParams.ProvisionedThroughput = derivePerCallProvisionedThroughput(
        properties,
        currentRegion
      );
    }

    // Stream specification. GlobalTable cross-region replication requires
    // streams with NEW_AND_OLD_IMAGES. CDK synth always emits
    // `StreamSpecification: { StreamViewType: 'NEW_AND_OLD_IMAGES' }`
    // (verified via real `cdk synth` 2026-05-16); cdkd defensively forces
    // streams on when the template has more than one replica or any
    // non-local replica, even if the template was hand-authored without.
    const streamSpecInput = properties['StreamSpecification'] as
      | Record<string, unknown>
      | undefined;
    const hasNonLocalReplica = replicas.some((r) => r['Region'] !== currentRegion);
    const needsStream = hasNonLocalReplica || replicas.length > 1;
    if (streamSpecInput) {
      createParams.StreamSpecification = {
        StreamEnabled: true,
        StreamViewType: (streamSpecInput['StreamViewType'] as string) ?? 'NEW_AND_OLD_IMAGES',
      } as StreamSpecification;
    } else if (needsStream) {
      this.logger.info(
        `Auto-enabling streams (NEW_AND_OLD_IMAGES) on ${logicalId} — required for cross-region replication`
      );
      createParams.StreamSpecification = {
        StreamEnabled: true,
        StreamViewType: 'NEW_AND_OLD_IMAGES',
      } as StreamSpecification;
    }

    if (properties['GlobalSecondaryIndexes']) {
      createParams.GlobalSecondaryIndexes = properties[
        'GlobalSecondaryIndexes'
      ] as GlobalSecondaryIndex[];
    }
    if (properties['LocalSecondaryIndexes']) {
      createParams.LocalSecondaryIndexes = properties[
        'LocalSecondaryIndexes'
      ] as LocalSecondaryIndex[];
    }

    // SSE: GlobalTable's CFn shape is { SSEEnabled, SSEType } with NO
    // top-level KMSMasterKeyId (per-replica only).
    if (properties['SSESpecification']) {
      const sse = properties['SSESpecification'] as Record<string, unknown>;
      const sseInput: { Enabled: boolean; SSEType?: 'KMS' } = {
        Enabled: sse['SSEEnabled'] !== undefined ? Boolean(sse['SSEEnabled']) : true,
      };
      if (sse['SSEType']) {
        sseInput.SSEType = sse['SSEType'] as 'KMS';
      }
      createParams.SSESpecification = sseInput;
    }

    // DeletionProtectionEnabled is per-replica in the CFn schema for
    // `AWS::DynamoDB::GlobalTable` (just like Tags). CDK 2.x's
    // `deletionProtection: true` synthesizes to
    // `Replicas[?Region==<deploy region>].DeletionProtectionEnabled`.
    // Extract via the shared module-level helper.
    const dpeResolved = extractLocalDeletionProtection(properties, currentRegion);
    if (dpeResolved !== undefined) {
      createParams.DeletionProtectionEnabled = dpeResolved;
    }
    if (properties['TableClass']) {
      createParams.TableClass = properties['TableClass'] as
        | 'STANDARD'
        | 'STANDARD_INFREQUENT_ACCESS';
    }

    // OnDemand throughput (GlobalTable: WriteOnDemandThroughputSettings).
    // CDK's TableV2 maps `maxWriteRequestUnits` here.
    const wodts = properties['WriteOnDemandThroughputSettings'] as
      | Record<string, unknown>
      | undefined;
    if (wodts?.['MaxWriteRequestUnits'] !== undefined) {
      createParams.OnDemandThroughput = {
        MaxWriteRequestUnits: Number(wodts['MaxWriteRequestUnits']),
      };
    }

    // Tags are per-replica in the CFn `AWS::DynamoDB::GlobalTable`
    // schema (there is NO top-level `Properties.Tags` field — CDK's
    // `cdk.Tags.of(tableV2).add(...)` puts them in
    // `Replicas[?Region==<deploy region>].Tags`). For the LOCAL replica
    // we apply them via `CreateTable`'s top-level `Tags` field (avoids
    // a separate `TagResource` round-trip). Cross-region replicas'
    // Tags require per-region SDK clients and are deferred.
    const localReplicaForTags = replicas.find((r) => r['Region'] === currentRegion);
    const localReplicaTags = localReplicaForTags?.['Tags'] as Tag[] | undefined;
    if (localReplicaTags && localReplicaTags.length > 0) {
      createParams.Tags = localReplicaTags;
    }

    try {
      await this.dynamoDBClient.send(new CreateTableCommand(createParams));
      this.logger.debug(`CreateTable initiated for ${tableName}, waiting for ACTIVE`);
    } catch (error) {
      // CreateTable itself failed — AWS never committed the table, no
      // cleanup needed.
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to create DynamoDB GlobalTable ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        tableName,
        cause
      );
    }

    // Inner try/catch wraps every post-CreateTable wiring call so a
    // wiring failure issues a best-effort DeleteTable before re-throwing.
    // Without this, an aborted deploy leaves a billing AWS-side table
    // with no cdkd state record (PR #374 pattern).
    try {
      const tableInfo = await this.waitForTableActive(tableName, logicalId);

      // Replica adds: one UpdateTable per region (AWS rejects multiple
      // ReplicaUpdates in a single call). Each call must complete before
      // the next — UpdateTable returns immediately but the table flips to
      // UPDATING until the replica is provisioned.
      for (const replica of replicas) {
        const region = replica['Region'] as string | undefined;
        if (!region || region === currentRegion) continue;
        await this.addReplica(tableName, replica, region, logicalId);
      }

      // TTL is a separate API call (UpdateTimeToLive). Applied after
      // table + replicas are ACTIVE so the AWS-side request validates.
      if (properties['TimeToLiveSpecification']) {
        const ttl = properties['TimeToLiveSpecification'] as Record<string, unknown>;
        const attributeName = ttl['AttributeName'] as string | undefined;
        const enabled = ttl['Enabled'] !== undefined ? Boolean(ttl['Enabled']) : true;
        if (attributeName) {
          await this.dynamoDBClient.send(
            new UpdateTimeToLiveCommand({
              TableName: tableName,
              TimeToLiveSpecification: { Enabled: enabled, AttributeName: attributeName },
            })
          );
        }
      }

      this.logger.debug(`Successfully created DynamoDB GlobalTable ${logicalId}: ${tableName}`);

      return {
        physicalId: tableName,
        attributes: {
          Arn: tableInfo.tableArn,
          TableId: tableInfo.tableId,
          StreamArn: tableInfo.streamArn,
          TableName: tableName,
        },
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
      this.logger.warn(
        `Wiring failed after CreateTable for ${tableName}; attempting best-effort cleanup`
      );
      try {
        const describe = await this.dynamoDBClient.send(
          new DescribeTableCommand({ TableName: tableName })
        );
        const replicasForCleanup = describe.Table?.Replicas ?? [];
        for (const replica of replicasForCleanup) {
          const region = replica.RegionName;
          if (!region || region === currentRegion) continue;
          try {
            await this.dynamoDBClient.send(
              new UpdateTableCommand({
                TableName: tableName,
                ReplicaUpdates: [{ Delete: { RegionName: region } }],
              })
            );
            await this.waitForReplicaGone(tableName, region, logicalId);
          } catch (replicaCleanupErr) {
            const msg =
              replicaCleanupErr instanceof Error
                ? replicaCleanupErr.message
                : String(replicaCleanupErr);
            this.logger.warn(
              `Partial-create cleanup: failed to drop replica ${region} on ${tableName}: ${msg}. ` +
                `Run: aws dynamodb update-table --table-name ${tableName} ` +
                `--replica-updates 'Delete={RegionName=${region}}' --region ${currentRegion}`
            );
          }
        }
        await this.dynamoDBClient.send(new DeleteTableCommand({ TableName: tableName }));
      } catch (cleanupErr) {
        const cleanupMsg = cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr);
        this.logger.warn(
          `Partial-create cleanup failed for ${tableName}: ${cleanupMsg}. ` +
            `Run: aws dynamodb delete-table --table-name ${tableName} ` +
            `to remove the orphaned AWS-side table.`
        );
      }
      const cause = wiringError instanceof Error ? wiringError : undefined;
      throw new ProvisioningError(
        `Failed to create DynamoDB GlobalTable ${logicalId}: ${wiringError instanceof Error ? wiringError.message : String(wiringError)}`,
        resourceType,
        logicalId,
        tableName,
        cause
      );
    }
  }

  /**
   * Add a single replica region. Issues one `UpdateTableCommand` with
   * `ReplicaUpdates: [{ Create: { RegionName, ... } }]` and polls
   * `DescribeTable` until the replica's `ReplicaStatus` flips to ACTIVE.
   * Capped at 10 minutes per replica (AWS Replica provisioning typically
   * takes 1–5 min).
   */
  private async addReplica(
    tableName: string,
    replica: Record<string, unknown>,
    region: string,
    logicalId: string
  ): Promise<void> {
    const create: CreateReplicationGroupMemberAction = {
      RegionName: region,
    };
    if (replica['KMSMasterKeyId']) {
      create.KMSMasterKeyId = replica['KMSMasterKeyId'] as string;
    }
    if (replica['GlobalSecondaryIndexes']) {
      // Replica-level GSI overrides (per-replica throughput overrides).
      // AWS-SDK shape: ReplicaGlobalSecondaryIndex[].
      create.GlobalSecondaryIndexes = replica['GlobalSecondaryIndexes'] as Array<{
        IndexName: string;
      }>;
    }
    if (replica['TableClassOverride']) {
      create.TableClassOverride = replica['TableClassOverride'] as
        | 'STANDARD'
        | 'STANDARD_INFREQUENT_ACCESS';
    }

    const replicaUpdates: ReplicationGroupUpdate[] = [{ Create: create }];

    await this.dynamoDBClient.send(
      new UpdateTableCommand({
        TableName: tableName,
        ReplicaUpdates: replicaUpdates,
      })
    );

    await this.waitForReplicaActive(tableName, region, logicalId);
  }

  /**
   * Update a DynamoDB Global Table in place.
   *
   * AWS-side state-machine constraint: `UpdateTable` accepts only ONE of
   * `{BillingMode, ReplicaUpdates, GlobalSecondaryIndexUpdates}` per call,
   * so each category must serialize into its own SDK round-trip with a
   * `waitForTableActiveAfterUpdate` between every step. Order:
   *   1. Wait for current ACTIVE (defensive).
   *   2. Tags diff (TagResource / UntagResource — no wait needed).
   *   3. Non-conflicting flat fields (DeletionProtectionEnabled / TableClass
   *      / SSESpecification / StreamSpecification / OnDemandThroughput)
   *      in one combined `UpdateTableCommand`. Wait ACTIVE.
   *   4. BillingMode flip (separate UpdateTable). Wait ACTIVE.
   *   5. Replica diff (serial per Create / Update / Delete). Wait ACTIVE
   *      after each.
   *   6. GSI diff (serial per Create / Update / Delete; new GSIs may need
   *      additional AttributeDefinitions). Wait ACTIVE after each.
   *   7. TimeToLiveSpecification toggle.
   *
   * Immutable properties (TableName / KeySchema / AttributeDefinitions
   * removals / LocalSecondaryIndexes changes) throw `ProvisioningError`
   * naming the offending field — the deploy engine's diff classifier
   * should catch these as REPLACEMENT before ever calling `update()`,
   * but the guard is defense-in-depth.
   */
  async update(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>
  ): Promise<ResourceUpdateResult> {
    this.logger.debug(`Updating DynamoDB GlobalTable ${logicalId}: ${physicalId}`);

    // ─── Immutable property guards (defense-in-depth) ───────────────────
    if (
      properties['TableName'] !== undefined &&
      previousProperties['TableName'] !== undefined &&
      properties['TableName'] !== previousProperties['TableName']
    ) {
      throw new ProvisioningError(
        `TableName is immutable on AWS::DynamoDB::GlobalTable; replacement required (deploy with --replace, or destroy + redeploy)`,
        resourceType,
        logicalId,
        physicalId
      );
    }
    if (
      properties['KeySchema'] !== undefined &&
      previousProperties['KeySchema'] !== undefined &&
      !deepEqual(properties['KeySchema'], previousProperties['KeySchema'])
    ) {
      throw new ProvisioningError(
        `KeySchema is immutable on AWS::DynamoDB::GlobalTable; replacement required (deploy with --replace, or destroy + redeploy)`,
        resourceType,
        logicalId,
        physicalId
      );
    }
    if (
      properties['LocalSecondaryIndexes'] !== undefined &&
      previousProperties['LocalSecondaryIndexes'] !== undefined &&
      !deepEqual(properties['LocalSecondaryIndexes'], previousProperties['LocalSecondaryIndexes'])
    ) {
      throw new ProvisioningError(
        `LocalSecondaryIndexes is immutable on AWS::DynamoDB::GlobalTable; replacement required (deploy with --replace, or destroy + redeploy)`,
        resourceType,
        logicalId,
        physicalId
      );
    }
    // AttributeDefinitions: additions are allowed (needed for new GSIs)
    // but removals are not — AWS rejects removing an attr that an index
    // still references.
    const oldAttrs = (previousProperties['AttributeDefinitions'] ?? []) as AttributeDefinition[];
    const newAttrs = (properties['AttributeDefinitions'] ?? []) as AttributeDefinition[];
    const removedAttrs = oldAttrs.filter(
      (o) => !newAttrs.some((n) => n.AttributeName === o.AttributeName)
    );
    if (removedAttrs.length > 0) {
      throw new ProvisioningError(
        `AttributeDefinitions removals are immutable on AWS::DynamoDB::GlobalTable (offenders: ${removedAttrs.map((a) => a.AttributeName).join(', ')}); replacement required`,
        resourceType,
        logicalId,
        physicalId
      );
    }

    // Resolve the client region ONCE for the whole update — the Tags
    // diff step, the BillingMode flip's capacity derivation, and the
    // Replicas diff loop all need it.
    const currentRegion = (await this.dynamoDBClient.config.region()) ?? '';

    try {
      // 1. Wait for ACTIVE before any update — defensive against rare
      // states where a previous deploy left the table mid-transition.
      await this.waitForTableActiveAfterUpdate(physicalId, logicalId);

      // 2. Tags diff. The CFn `AWS::DynamoDB::GlobalTable` schema has
      // NO top-level `Tags` — tags live inside each `Replicas[]` entry
      // as `Replicas[?Region==<region>].Tags`. For the LOCAL replica we
      // diff and apply via TagResource / UntagResource on the local
      // table ARN; cross-region replicas' Tags are propagated inside
      // the per-replica modify loop further down via the per-region
      // client returned by `getRegionalClient` (Issue #389).
      const describeResp = await this.dynamoDBClient.send(
        new DescribeTableCommand({ TableName: physicalId })
      );
      const tableArn = describeResp.Table?.TableArn;
      const extractLocalTags = (
        props: Record<string, unknown>
      ): Array<{ Key?: string; Value?: string }> | undefined => {
        const replicas = (props['Replicas'] ?? []) as Array<Record<string, unknown>>;
        const local = replicas.find((r) => r['Region'] === currentRegion);
        return local?.['Tags'] as Array<{ Key?: string; Value?: string }> | undefined;
      };
      if (tableArn) {
        await this.applyTagDiff(
          tableArn,
          extractLocalTags(previousProperties),
          extractLocalTags(properties)
        );
      }

      // 3. Non-conflicting flat fields in one combined UpdateTable.
      // AWS allows combining these in a single call because they don't
      // conflict with each other or with each other's modes.
      // DeletionProtectionEnabled is per-replica in the CFn schema
      // (same shape as Tags). Extract via shared module-level helper.
      //
      // **AWS-aware diff (migration fix)**: also compare against AWS's
      // observed DPE from the DescribeTable response above. Pre-PR
      // #410 cdkd was reading top-level DPE which was always
      // undefined → no UpdateTable was issued, but state recorded
      // the user's template intent (per-replica DPE=true). Post-fix,
      // a no-change redeploy would see oldDpe=true vs newDpe=true
      // and skip the update — but AWS still has DPE=false. By
      // comparing against `awsDpe` from DescribeTable, we re-converge
      // the actual AWS state to the template intent on any deploy,
      // not just deploys with a template-side diff. Same logic
      // doubles as protection against console-side drift.
      const newDpe = extractLocalDeletionProtection(properties, currentRegion);
      const oldDpe = extractLocalDeletionProtection(previousProperties, currentRegion);
      const awsDpe = describeResp.Table?.DeletionProtectionEnabled;
      const flatUpdate: UpdateTableCommandInput = { TableName: physicalId };
      let flatChanged = false;
      const dpeDiffersFromState = newDpe !== oldDpe;
      const dpeDiffersFromAws =
        newDpe !== undefined && typeof awsDpe === 'boolean' && Boolean(newDpe) !== awsDpe;
      if (dpeDiffersFromState || dpeDiffersFromAws) {
        // **Auto-disable WARN**: cdkd's diff semantics treat
        // "absent property in template" as "revert to default", which
        // matches CFn / CDK CLI parity. For DPE specifically this
        // means: removing `deletionProtection: true` from CDK code
        // silently disables protection on AWS. That's a refactoring
        // footgun (e.g. moving the prop into a config helper but
        // mistyping the destination, or accidentally deleting the
        // line during a cleanup). Surface a WARN so the user has
        // visibility before the next destroy. WARN only — no behavior
        // change; the user can still proceed if they really mean to
        // disable protection.
        const templateExplicitlySetsDpe = newDpe !== undefined;
        const flippingTrueToFalse =
          (oldDpe === true || awsDpe === true) && Boolean(newDpe ?? false) === false;
        if (flippingTrueToFalse && !templateExplicitlySetsDpe) {
          this.logger.warn(
            `Auto-disabling DeletionProtectionEnabled on ${physicalId}: ` +
              `the property was removed from the CDK code. AWS will accept ` +
              `DeleteTable on this resource after this deploy. ` +
              `If you meant to keep protection on, restore ` +
              `'deletionProtection: true' in your CDK code; ` +
              `if you meant to disable it explicitly, set ` +
              `'deletionProtection: false' to silence this warning.`
          );
        }
        flatUpdate.DeletionProtectionEnabled = Boolean(newDpe ?? false);
        flatChanged = true;
      }
      if (
        properties['TableClass'] !== undefined &&
        properties['TableClass'] !== previousProperties['TableClass']
      ) {
        flatUpdate.TableClass = properties['TableClass'] as
          | 'STANDARD'
          | 'STANDARD_INFREQUENT_ACCESS';
        flatChanged = true;
      }
      if (
        properties['SSESpecification'] !== undefined &&
        !deepEqual(properties['SSESpecification'], previousProperties['SSESpecification'])
      ) {
        const sse = properties['SSESpecification'] as Record<string, unknown>;
        flatUpdate.SSESpecification = {
          Enabled: sse['SSEEnabled'] !== undefined ? Boolean(sse['SSEEnabled']) : true,
          ...(sse['SSEType'] !== undefined && { SSEType: sse['SSEType'] as 'KMS' }),
        };
        flatChanged = true;
      }
      if (
        properties['StreamSpecification'] !== undefined &&
        !deepEqual(properties['StreamSpecification'], previousProperties['StreamSpecification'])
      ) {
        const ss = properties['StreamSpecification'] as Record<string, unknown>;
        flatUpdate.StreamSpecification = {
          StreamEnabled: true,
          StreamViewType: ss['StreamViewType'] as string,
        } as StreamSpecification;
        flatChanged = true;
      }
      if (
        !deepEqual(
          properties['WriteOnDemandThroughputSettings'],
          previousProperties['WriteOnDemandThroughputSettings']
        )
      ) {
        const wodts = properties['WriteOnDemandThroughputSettings'] as
          | Record<string, unknown>
          | undefined;
        if (wodts?.['MaxWriteRequestUnits'] !== undefined) {
          flatUpdate.OnDemandThroughput = {
            MaxWriteRequestUnits: Number(wodts['MaxWriteRequestUnits']),
          };
          flatChanged = true;
        }
      }
      if (flatChanged) {
        await this.dynamoDBClient.send(new UpdateTableCommand(flatUpdate));
        await this.waitForTableActiveAfterUpdate(physicalId, logicalId);
      }

      // 4. BillingMode flip (own UpdateTable per AWS state-machine rule).
      // Defaults must match `create()` (line 183: `PAY_PER_REQUEST`) so
      // a template with no explicit `BillingMode` doesn't false-fire
      // a PROVISIONED → PAY_PER_REQUEST diff on every update of a
      // PAY_PER_REQUEST table.
      const oldBilling =
        (previousProperties['BillingMode'] as string | undefined) ?? 'PAY_PER_REQUEST';
      const newBilling = (properties['BillingMode'] as string | undefined) ?? 'PAY_PER_REQUEST';
      if (oldBilling !== newBilling) {
        const billingUpdate: UpdateTableCommandInput = {
          TableName: physicalId,
          BillingMode: newBilling as 'PROVISIONED' | 'PAY_PER_REQUEST',
        };
        if (newBilling === 'PROVISIONED') {
          // Mirror create()'s capacity derivation so a user template
          // with non-default read/write capacity is preserved across a
          // PAY_PER_REQUEST → PROVISIONED flip (the previous hardcoded
          // `ReadCapacityUnits: 5` silently overrode the template).
          billingUpdate.ProvisionedThroughput = derivePerCallProvisionedThroughput(
            properties,
            currentRegion
          );
        }
        await this.dynamoDBClient.send(new UpdateTableCommand(billingUpdate));
        await this.waitForTableActiveAfterUpdate(physicalId, logicalId);
      }

      // 4b. Table-level write auto-scaling diff (Issue #402 / closes #395
      // deferred items). Fires whenever the WriteCapacityAutoScalingSettings
      // sub-shape differs between old and new (incl. add / remove). Skipped
      // when the table is PAY_PER_REQUEST on BOTH sides — autoscaling
      // targets are meaningless without ProvisionedThroughput. When the
      // BillingMode flipped PROVISIONED -> PAY_PER_REQUEST, force tear-down
      // regardless of whether the template still carries the settings:
      // autoscaling is invalid on PAY_PER_REQUEST.
      //
      // Placed AFTER the BillingMode flip so a PAY_PER_REQUEST -> PROVISIONED
      // template flip plus a new WriteCapacityAutoScalingSettings doesn't try
      // to RegisterScalableTarget against a not-yet-PROVISIONED table.
      const writeAutoScalingOld = (
        (previousProperties['WriteProvisionedThroughputSettings'] ?? {}) as Record<string, unknown>
      )['WriteCapacityAutoScalingSettings'] as Record<string, unknown> | undefined;
      const writeAutoScalingNew = (
        (properties['WriteProvisionedThroughputSettings'] ?? {}) as Record<string, unknown>
      )['WriteCapacityAutoScalingSettings'] as Record<string, unknown> | undefined;
      const billingFlippedToOnDemand =
        oldBilling === 'PROVISIONED' && newBilling === 'PAY_PER_REQUEST';
      // Force teardown on a flip to PAY_PER_REQUEST regardless of whether
      // the template still carries the (now-invalid) autoscaling settings
      // — AWS rejects targets on on-demand tables, so any prior target
      // must come down.
      const effectiveNewAutoScaling = billingFlippedToOnDemand ? undefined : writeAutoScalingNew;
      const autoScalingMeaningful = newBilling === 'PROVISIONED' || oldBilling === 'PROVISIONED';
      if (autoScalingMeaningful && !deepEqual(writeAutoScalingOld, effectiveNewAutoScaling)) {
        await this.applyAutoScalingDiff(
          physicalId,
          'dynamodb:table:WriteCapacityUnits',
          writeAutoScalingOld,
          effectiveNewAutoScaling
        );
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
            regionalAutoScalingClient
          );
        }

        await this.dynamoDBClient.send(
          new UpdateTableCommand({
            TableName: physicalId,
            ReplicaUpdates: [{ Delete: { RegionName: region } }],
          })
        );
        await this.waitForReplicaGone(physicalId, region, logicalId);
      }
      for (const replica of replicaDiff.added) {
        const region = replica['Region'] as string | undefined;
        if (!region || region === currentRegion) continue;
        await this.addReplica(physicalId, replica, region, logicalId);

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
            regionalAutoScalingClient
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
        const oldReplicaTags = oldReplica?.['Tags'] as
          | Array<{ Key?: string; Value?: string }>
          | undefined;
        const newReplicaTags = replica['Tags'] as
          | Array<{ Key?: string; Value?: string }>
          | undefined;

        // Cross-region Tags propagation (Issue #389): when AWS reports
        // a TableArn, swap its region segment to construct the
        // replica's ARN, then issue TagResource / UntagResource via
        // a per-region client. Best-effort — a failure here logs at
        // warn but does NOT block the rest of the replica modify
        // loop (the local replica's Tags already applied above; the
        // cross-region Tags failure surfaces as drift on the next
        // run instead of as a deploy abort).
        if (!deepEqual(oldReplicaTags, newReplicaTags)) {
          if (tableArn) {
            const replicaArn = this.replicaArnForRegion(tableArn, region);
            if (replicaArn) {
              try {
                const regionalClient = this.getRegionalClient(region);
                await this.applyTagDiffOnClient(
                  regionalClient,
                  replicaArn,
                  oldReplicaTags,
                  newReplicaTags
                );
              } catch (tagErr) {
                this.logger.warn(
                  `Could not apply Tags diff to cross-region replica ${region} of ${physicalId}: ${tagErr instanceof Error ? tagErr.message : String(tagErr)}. The replica's Tags state will surface as drift until the next successful deploy.`
                );
              }
            } else {
              this.logger.warn(
                `Could not derive replica ARN for region ${region} from ${tableArn} — skipping Tags propagation for ${physicalId}`
              );
            }
          } else {
            this.logger.warn(
              `Local DescribeTable returned no TableArn — cannot propagate Tags to cross-region replica ${region} of ${physicalId}`
            );
          }
        }

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
            regionalAutoScalingClient
          );
        }

        const updateAction: UpdateReplicationGroupMemberAction = { RegionName: region };
        if (replica['KMSMasterKeyId'] !== undefined) {
          updateAction.KMSMasterKeyId = replica['KMSMasterKeyId'] as string;
        }
        if (replica['GlobalSecondaryIndexes']) {
          updateAction.GlobalSecondaryIndexes = replica['GlobalSecondaryIndexes'] as Array<{
            IndexName: string;
          }>;
        }
        if (replica['TableClassOverride']) {
          updateAction.TableClassOverride = replica['TableClassOverride'] as
            | 'STANDARD'
            | 'STANDARD_INFREQUENT_ACCESS';
        }
        // AWS rejects an UpdateReplica with no update fields
        // (ValidationException). When the only change in the modified
        // replica is `Tags` (now applied above via per-region client),
        // the updateAction has only `RegionName`. Skip the
        // UpdateReplica SDK call in that case — the Tags-only diff is
        // already in flight against the regional client.
        const hasUpdateField =
          updateAction.KMSMasterKeyId !== undefined ||
          updateAction.GlobalSecondaryIndexes !== undefined ||
          updateAction.TableClassOverride !== undefined;
        if (!hasUpdateField) {
          this.logger.debug(
            `Cross-region replica ${region} of ${physicalId}: only Tags-style ` +
              `changes detected; UpdateReplica skipped (AWS rejects empty ` +
              `Update actions). Tags propagation handled above via per-region client.`
          );
          continue;
        }
        await this.dynamoDBClient.send(
          new UpdateTableCommand({
            TableName: physicalId,
            ReplicaUpdates: [{ Update: updateAction }],
          })
        );
        await this.waitForReplicaActive(physicalId, region, logicalId);
      }

      // 6. GSI diff. New GSI Create may need additional AttributeDefinitions
      // — AWS allows combining `AttributeDefinitions` and one GSI
      // `Create` action in the same UpdateTable call.
      const gsiDiff = diffGlobalSecondaryIndexes(
        (previousProperties['GlobalSecondaryIndexes'] ?? []) as GlobalSecondaryIndex[],
        (properties['GlobalSecondaryIndexes'] ?? []) as GlobalSecondaryIndex[]
      );
      for (const gsi of gsiDiff.removed) {
        if (!gsi.IndexName) continue;
        const gsiUpdate: GlobalSecondaryIndexUpdate = {
          Delete: { IndexName: gsi.IndexName },
        };
        await this.dynamoDBClient.send(
          new UpdateTableCommand({
            TableName: physicalId,
            GlobalSecondaryIndexUpdates: [gsiUpdate],
          })
        );
        await this.waitForTableActiveAfterUpdate(physicalId, logicalId);
      }
      for (const gsi of gsiDiff.added) {
        if (!gsi.IndexName || !gsi.KeySchema || !gsi.Projection) continue;
        const gsiUpdate: GlobalSecondaryIndexUpdate = {
          Create: {
            IndexName: gsi.IndexName,
            KeySchema: gsi.KeySchema,
            Projection: gsi.Projection,
            ...(gsi.ProvisionedThroughput && {
              ProvisionedThroughput: gsi.ProvisionedThroughput,
            }),
            ...(gsi.OnDemandThroughput && { OnDemandThroughput: gsi.OnDemandThroughput }),
          },
        };
        await this.dynamoDBClient.send(
          new UpdateTableCommand({
            TableName: physicalId,
            AttributeDefinitions: newAttrs,
            GlobalSecondaryIndexUpdates: [gsiUpdate],
          })
        );
        await this.waitForTableActiveAfterUpdate(physicalId, logicalId);
      }
      for (const gsi of gsiDiff.modified) {
        if (!gsi.IndexName) continue;
        const gsiUpdate: GlobalSecondaryIndexUpdate = {
          Update: {
            IndexName: gsi.IndexName,
            ...(gsi.ProvisionedThroughput && {
              ProvisionedThroughput: gsi.ProvisionedThroughput,
            }),
            ...(gsi.OnDemandThroughput && { OnDemandThroughput: gsi.OnDemandThroughput }),
          },
        };
        await this.dynamoDBClient.send(
          new UpdateTableCommand({
            TableName: physicalId,
            GlobalSecondaryIndexUpdates: [gsiUpdate],
          })
        );
        await this.waitForTableActiveAfterUpdate(physicalId, logicalId);
      }

      // 7. TimeToLiveSpecification (separate API).
      // AWS enforces a 4-hour rate limit on TTL changes per table
      // ("Time to live has been modified multiple times within a fixed
      // interval"). Catch and rewrap with an actionable hint pointing
      // at the AWS-side limit, so a user redeploying a TTL-toggling
      // stack twice in tight succession sees what's happening instead
      // of a raw AWS error.
      if (
        !deepEqual(
          properties['TimeToLiveSpecification'],
          previousProperties['TimeToLiveSpecification']
        )
      ) {
        const sendTtl = async (cmd: UpdateTimeToLiveCommand): Promise<void> => {
          try {
            await this.dynamoDBClient.send(cmd);
          } catch (ttlErr) {
            const msg = ttlErr instanceof Error ? ttlErr.message : String(ttlErr);
            if (msg.includes('Time to live has been modified multiple times')) {
              throw new ProvisioningError(
                `AWS rejected TimeToLive update on ${physicalId}: ${msg}. ` +
                  `AWS enforces a ~4-hour rate limit on TTL changes per table; ` +
                  `wait and redeploy, or keep the previous TTL state in this deploy.`,
                resourceType,
                logicalId,
                physicalId,
                ttlErr instanceof Error ? ttlErr : undefined
              );
            }
            throw ttlErr;
          }
        };
        const ttl = properties['TimeToLiveSpecification'] as Record<string, unknown> | undefined;
        if (ttl?.['AttributeName']) {
          await sendTtl(
            new UpdateTimeToLiveCommand({
              TableName: physicalId,
              TimeToLiveSpecification: {
                Enabled: ttl['Enabled'] !== undefined ? Boolean(ttl['Enabled']) : true,
                AttributeName: ttl['AttributeName'] as string,
              },
            })
          );
        } else if (previousProperties['TimeToLiveSpecification']) {
          // TTL removed from template: AWS requires the previous
          // AttributeName to disable it. Pull from old props.
          const prevTtl = previousProperties['TimeToLiveSpecification'] as Record<string, unknown>;
          if (prevTtl['AttributeName']) {
            await sendTtl(
              new UpdateTimeToLiveCommand({
                TableName: physicalId,
                TimeToLiveSpecification: {
                  Enabled: false,
                  AttributeName: prevTtl['AttributeName'] as string,
                },
              })
            );
          }
        }
      }

      // Resolve attributes for return.
      const finalDescribe = await this.dynamoDBClient.send(
        new DescribeTableCommand({ TableName: physicalId })
      );
      return {
        physicalId,
        wasReplaced: false,
        attributes: {
          Arn: finalDescribe.Table?.TableArn,
          TableId: finalDescribe.Table?.TableId,
          StreamArn: finalDescribe.Table?.LatestStreamArn,
          TableName: physicalId,
        },
      };
    } catch (error) {
      if (error instanceof ProvisioningError) throw error;
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to update DynamoDB GlobalTable ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  /**
   * Apply a diff between old and new CFn-shape Tags arrays via DynamoDB's
   * `TagResource` / `UntagResource` APIs against the local client. Both
   * take the table ARN as `ResourceArn`.
   *
   * Local-replica convenience wrapper around `applyTagDiffOnClient` so
   * existing call sites stay unchanged.
   */
  private async applyTagDiff(
    tableArn: string,
    oldTagsRaw: Array<{ Key?: string; Value?: string }> | undefined,
    newTagsRaw: Array<{ Key?: string; Value?: string }> | undefined
  ): Promise<void> {
    await this.applyTagDiffOnClient(this.dynamoDBClient, tableArn, oldTagsRaw, newTagsRaw);
  }

  /**
   * Apply a Tags diff against the given `DynamoDBClient` (which may be
   * the local client or a per-region client returned by
   * `getRegionalClient`). Used by the local-replica path AND the
   * cross-region replica Tags propagation path (Issue #389).
   */
  private async applyTagDiffOnClient(
    client: DynamoDBClient,
    tableArn: string,
    oldTagsRaw: Array<{ Key?: string; Value?: string }> | undefined,
    newTagsRaw: Array<{ Key?: string; Value?: string }> | undefined
  ): Promise<void> {
    const toMap = (
      tags: Array<{ Key?: string; Value?: string }> | undefined
    ): Map<string, string> => {
      const m = new Map<string, string>();
      for (const t of tags ?? []) {
        if (t.Key !== undefined && t.Value !== undefined) m.set(t.Key, t.Value);
      }
      return m;
    };

    const oldMap = toMap(oldTagsRaw);
    const newMap = toMap(newTagsRaw);

    const tagsToAdd: Array<{ Key: string; Value: string }> = [];
    for (const [k, v] of newMap) {
      if (oldMap.get(k) !== v) tagsToAdd.push({ Key: k, Value: v });
    }
    const tagsToRemove: string[] = [];
    for (const k of oldMap.keys()) {
      if (!newMap.has(k)) tagsToRemove.push(k);
    }

    if (tagsToRemove.length > 0) {
      await client.send(new UntagResourceCommand({ ResourceArn: tableArn, TagKeys: tagsToRemove }));
      this.logger.debug(
        `Removed ${tagsToRemove.length} tag(s) from DynamoDB GlobalTable ${tableArn}`
      );
    }
    if (tagsToAdd.length > 0) {
      await client.send(new TagResourceCommand({ ResourceArn: tableArn, Tags: tagsToAdd }));
      this.logger.debug(
        `Added/updated ${tagsToAdd.length} tag(s) on DynamoDB GlobalTable ${tableArn}`
      );
    }
  }

  /**
   * Apply an application-autoscaling diff for one (tableName, dimension)
   * pair (Issue #402 / PR closing Issue #395's deferred items).
   *
   * Dimension is either:
   *  - `dynamodb:table:WriteCapacityUnits` (table-level write capacity),
   *    paired with the local-region autoscaling client.
   *  - `dynamodb:table:ReadCapacityUnits` (per-replica read capacity),
   *    paired with a region-scoped autoscaling client returned by
   *    `getRegionalAutoScalingClient`.
   *
   * Diff semantics (idempotent upsert, per Issue #402 spec):
   *  - new auto-scaling settings present (Min/Max + TargetValue) →
   *    `RegisterScalableTarget` (upsert) + `PutScalingPolicy` (upsert).
   *    AWS's `RegisterScalableTarget` accepts no-op Min/Max changes
   *    silently, and `PutScalingPolicy` is idempotent on the same
   *    policy name (`DynamoDB{Write,Read}CapacityUtilization:table/<name>`).
   *  - old auto-scaling settings present but new ones absent (= null) →
   *    `DeleteScalingPolicy` + `DeregisterScalableTarget`. AWS rejects
   *    `DeregisterScalableTarget` on a still-policy-attached target,
   *    so the policy must be deleted FIRST.
   *  - neither side has auto-scaling settings → no-op.
   *
   * **Best-effort**: any AWS error is logged at WARN with the per-API
   * recovery command and the deploy continues — auto-scaling drift is
   * recoverable on the next deploy, and an aborted deploy is much worse
   * UX than a transient auto-scaling miss. This matches the cross-region
   * Tags propagation contract (PR #393).
   *
   * **Policy naming** matches AWS's CDK / console default:
   *   `DynamoDBWriteCapacityUtilization:table/<table-name>` (write)
   *   `DynamoDBReadCapacityUtilization:table/<table-name>`  (read)
   * so re-imports against a console-created target also match.
   *
   * **`SeedCapacity` is intentionally NOT forwarded** — it is a CFn
   * create-only field with no corresponding `RegisterScalableTarget`
   * surface; `readAutoScalingSettings` also explicitly skips it.
   */
  private async applyAutoScalingDiff(
    tableName: string,
    dimension: 'dynamodb:table:WriteCapacityUnits' | 'dynamodb:table:ReadCapacityUnits',
    oldSettings: Record<string, unknown> | undefined,
    newSettings: Record<string, unknown> | undefined,
    client?: ApplicationAutoScalingClient
  ): Promise<void> {
    const isWrite = dimension === 'dynamodb:table:WriteCapacityUnits';
    const policyName = isWrite
      ? `DynamoDBWriteCapacityUtilization:table/${tableName}`
      : `DynamoDBReadCapacityUtilization:table/${tableName}`;
    const metricType = isWrite
      ? 'DynamoDBWriteCapacityUtilization'
      : 'DynamoDBReadCapacityUtilization';
    const resourceId = `table/${tableName}`;

    // PR #403 review minor #4: route the no-client-arg fallback through
    // the cached `getLocalAutoScalingClient()` rather than constructing
    // a fresh client per call. Multi-stack runs with many GlobalTables
    // were leaking SDK clients (each holds its own HTTP agent).
    const asClient = client ?? (await this.getLocalAutoScalingClient());

    const oldEnabled = oldSettings !== undefined && oldSettings !== null;
    const newEnabled = newSettings !== undefined && newSettings !== null;

    if (!oldEnabled && !newEnabled) {
      return; // nothing to do
    }

    if (newEnabled) {
      // Register OR update scalable target (idempotent on no-op).
      const minCapacity = Number(newSettings!['MinCapacity'] ?? 0);
      const maxCapacity = Number(newSettings!['MaxCapacity'] ?? 0);
      if (!Number.isFinite(minCapacity) || !Number.isFinite(maxCapacity)) {
        this.logger.warn(
          `Cannot apply auto-scaling diff on ${tableName} (${dimension}): ` +
            `MinCapacity / MaxCapacity must be numbers, got ` +
            `${String(newSettings!['MinCapacity'])} / ${String(newSettings!['MaxCapacity'])}`
        );
        return;
      }
      try {
        await asClient.send(
          new RegisterScalableTargetCommand({
            ServiceNamespace: 'dynamodb',
            ResourceId: resourceId,
            ScalableDimension: dimension,
            MinCapacity: minCapacity,
            MaxCapacity: maxCapacity,
          })
        );
      } catch (err) {
        this.logger.warn(
          `Could not register auto-scaling target on ${tableName} (${dimension}): ` +
            `${err instanceof Error ? err.message : String(err)}. ` +
            `Run: aws application-autoscaling register-scalable-target ` +
            `--service-namespace dynamodb --resource-id ${resourceId} ` +
            `--scalable-dimension ${dimension} --min-capacity ${minCapacity} ` +
            `--max-capacity ${maxCapacity}`
        );
        return;
      }

      const tttCfg = (newSettings!['TargetTrackingScalingPolicyConfiguration'] ?? {}) as Record<
        string,
        unknown
      >;
      const targetValue = Number(tttCfg['TargetValue']);
      if (!Number.isFinite(targetValue)) {
        this.logger.warn(
          `Auto-scaling target registered on ${tableName} (${dimension}) but ` +
            `TargetValue is missing or non-numeric — skipping PutScalingPolicy. ` +
            `Provide TargetTrackingScalingPolicyConfiguration.TargetValue in the template.`
        );
        return;
      }
      const targetTrackingConfig: Record<string, unknown> = {
        PredefinedMetricSpecification: { PredefinedMetricType: metricType },
        TargetValue: targetValue,
      };
      if (tttCfg['ScaleInCooldown'] !== undefined) {
        targetTrackingConfig['ScaleInCooldown'] = Number(tttCfg['ScaleInCooldown']);
      }
      if (tttCfg['ScaleOutCooldown'] !== undefined) {
        targetTrackingConfig['ScaleOutCooldown'] = Number(tttCfg['ScaleOutCooldown']);
      }
      if (tttCfg['DisableScaleIn'] !== undefined) {
        targetTrackingConfig['DisableScaleIn'] = Boolean(tttCfg['DisableScaleIn']);
      }
      try {
        await asClient.send(
          new PutScalingPolicyCommand({
            PolicyName: policyName,
            ServiceNamespace: 'dynamodb',
            ResourceId: resourceId,
            ScalableDimension: dimension,
            PolicyType: 'TargetTrackingScaling',
            // SDK input shape uses Pascal-cased keys; the inner config object
            // is the same shape we read back via DescribeScalingPolicies.
            TargetTrackingScalingPolicyConfiguration: targetTrackingConfig as never,
          })
        );
        this.logger.debug(
          `Upserted auto-scaling policy ${policyName} on ${tableName} (${dimension})`
        );
      } catch (err) {
        this.logger.warn(
          `Could not put auto-scaling policy on ${tableName} (${dimension}): ` +
            `${err instanceof Error ? err.message : String(err)}. ` +
            `Run: aws application-autoscaling put-scaling-policy ` +
            `--policy-name ${policyName} --service-namespace dynamodb ` +
            `--resource-id ${resourceId} --scalable-dimension ${dimension} ` +
            `--policy-type TargetTrackingScaling`
        );
      }
      return;
    }

    // newEnabled === false, oldEnabled === true: tear down.
    // Idempotency: AWS's application-autoscaling raises
    // `ObjectNotFoundException` ("No scaling policy found" / "No
    // scalable target found") when the resource is already gone.
    // That is success for our purposes (e.g. the `update()` BillingMode
    // flip already tore down autoscaling, and now `delete()`'s defense-
    // in-depth teardown fires). Detect via the error name AND message
    // substring (the SDK doesn't always type-name the error on first
    // exposure) and silently skip — only surface non-RNF errors as
    // WARN with the recovery command.
    const isObjectNotFound = (err: unknown): boolean => {
      if (!(err instanceof Error)) return false;
      const name = (err as Error & { name?: string }).name ?? '';
      const msg = err.message ?? '';
      return (
        name === 'ObjectNotFoundException' ||
        msg.includes('No scaling policy found') ||
        msg.includes('No scalable target found')
      );
    };
    try {
      await asClient.send(
        new DeleteScalingPolicyCommand({
          PolicyName: policyName,
          ServiceNamespace: 'dynamodb',
          ResourceId: resourceId,
          ScalableDimension: dimension,
        })
      );
    } catch (err) {
      if (!isObjectNotFound(err)) {
        this.logger.warn(
          `Could not delete auto-scaling policy on ${tableName} (${dimension}): ` +
            `${err instanceof Error ? err.message : String(err)}. ` +
            `Run: aws application-autoscaling delete-scaling-policy ` +
            `--policy-name ${policyName} --service-namespace dynamodb ` +
            `--resource-id ${resourceId} --scalable-dimension ${dimension}`
        );
      }
      // Continue to the Deregister attempt regardless — AWS may have
      // already cleaned up the policy, in which case the deregister
      // succeeds (or also returns ObjectNotFoundException, also
      // suppressed below).
    }
    try {
      await asClient.send(
        new DeregisterScalableTargetCommand({
          ServiceNamespace: 'dynamodb',
          ResourceId: resourceId,
          ScalableDimension: dimension,
        })
      );
      this.logger.debug(`Deregistered auto-scaling target ${resourceId} (${dimension})`);
    } catch (err) {
      if (!isObjectNotFound(err)) {
        this.logger.warn(
          `Could not deregister auto-scaling target on ${tableName} (${dimension}): ` +
            `${err instanceof Error ? err.message : String(err)}. ` +
            `Run: aws application-autoscaling deregister-scalable-target ` +
            `--service-namespace dynamodb --resource-id ${resourceId} ` +
            `--scalable-dimension ${dimension}`
        );
      }
    }
  }

  /**
   * Delete a DynamoDB Global Table.
   *
   * Order is load-bearing:
   *  1. Optional `--remove-protection` flip-off (idempotent).
   *  2. `DescribeTable` → drop every non-local replica via UpdateTable
   *     `ReplicaUpdates: [{ Delete: { RegionName } }]`, one at a time
   *     (AWS rejects multiple replica updates per call). Each delete
   *     polls until the replica disappears from `Replicas[]`.
   *  3. `DeleteTableCommand` on the local region only.
   *  4. Wait for `ResourceNotFoundException` on subsequent DescribeTable.
   *
   * DELETE idempotency: a `ResourceNotFoundException` is treated as
   * success ONLY when the client region matches the state region
   * (`assertRegionMatch`). A mismatched destroy would otherwise silently
   * strip a still-existing resource from state.
   */
  async delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    _properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void> {
    this.logger.debug(`Deleting DynamoDB GlobalTable ${logicalId}: ${physicalId}`);

    if (context?.removeProtection === true) {
      // Idempotent flip-off — AWS accepts the no-op already-disabled case.
      try {
        await this.dynamoDBClient.send(
          new UpdateTableCommand({
            TableName: physicalId,
            DeletionProtectionEnabled: false,
          })
        );
        this.logger.debug(`Disabled DeletionProtectionEnabled on ${logicalId}, waiting for ACTIVE`);
        try {
          await this.waitForTableActiveAfterUpdate(physicalId, logicalId);
        } catch (waitErr) {
          this.logger.debug(
            `Could not wait for table ${physicalId} ACTIVE after protection flip: ${waitErr instanceof Error ? waitErr.message : String(waitErr)}`
          );
        }
      } catch (flipError) {
        if (!(flipError instanceof ResourceNotFoundException)) {
          this.logger.debug(
            `Could not disable DeletionProtectionEnabled on ${physicalId}: ${flipError instanceof Error ? flipError.message : String(flipError)}`
          );
        }
      }
    }

    let currentRegion: string;
    try {
      currentRegion = await this.dynamoDBClient.config.region();
    } catch (regionErr) {
      const cause = regionErr instanceof Error ? regionErr : undefined;
      throw new ProvisioningError(
        `Could not resolve client region for DynamoDB GlobalTable ${logicalId} delete — would risk dropping the local replica`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }

    // Drop every non-local replica first. GlobalTable cannot be deleted
    // while it has additional replicas — AWS rejects DeleteTable.
    // ALSO tear down per-replica autoscaling targets (read dim) BEFORE
    // the replica delete, AND the table-level autoscaling target
    // (write dim) BEFORE the DeleteTable call. Without these,
    // `RegisterScalableTarget` + `PutScalingPolicy` survive in AWS's
    // application-autoscaling control plane indefinitely; a future
    // create of the same `tableName` (same region) inherits the orphan
    // target silently. PR #403 code-reviewer caught this as a blocker.
    try {
      const describe = await this.dynamoDBClient.send(
        new DescribeTableCommand({ TableName: physicalId })
      );
      const replicas = describe.Table?.Replicas ?? [];
      for (const replica of replicas) {
        const region = replica.RegionName;
        if (!region || region === currentRegion) continue;
        try {
          // Tear down the cross-region replica's read autoscaling
          // BEFORE deleting the replica (best-effort).
          await this.applyAutoScalingDiff(
            physicalId,
            'dynamodb:table:ReadCapacityUnits',
            {} /* oldSettings — placeholder; non-undefined forces teardown */,
            undefined /* newSettings — undefined triggers Delete+Deregister */,
            this.getRegionalAutoScalingClient(region)
          );
          await this.dynamoDBClient.send(
            new UpdateTableCommand({
              TableName: physicalId,
              ReplicaUpdates: [{ Delete: { RegionName: region } }],
            })
          );
          await this.waitForReplicaGone(physicalId, region, logicalId);
        } catch (replicaErr) {
          // Table itself already gone — outer DeleteTable will handle
          // idempotency (the region check below ensures a mismatched
          // destroy doesn't silently strip state).
          if (!(replicaErr instanceof ResourceNotFoundException)) {
            throw replicaErr;
          }
        }
      }
      // Tear down the LOCAL replica's read autoscaling AND the table-
      // level write autoscaling before `DeleteTable`. Same orphan-leak
      // concern: surviving scaling targets would inherit on re-create.
      const localAsClient = await this.getLocalAutoScalingClient();
      await this.applyAutoScalingDiff(
        physicalId,
        'dynamodb:table:ReadCapacityUnits',
        {},
        undefined,
        localAsClient
      );
      await this.applyAutoScalingDiff(
        physicalId,
        'dynamodb:table:WriteCapacityUnits',
        {},
        undefined,
        localAsClient
      );
    } catch (describeErr) {
      if (!(describeErr instanceof ResourceNotFoundException)) {
        const cause = describeErr instanceof Error ? describeErr : undefined;
        throw new ProvisioningError(
          `Failed to describe DynamoDB GlobalTable ${logicalId} before delete: ${describeErr instanceof Error ? describeErr.message : String(describeErr)}`,
          resourceType,
          logicalId,
          physicalId,
          cause
        );
      }
      // RNF on the pre-delete DescribeTable — table already gone; the
      // region-match check on the DeleteTable RNF path below handles
      // idempotency.
    }

    try {
      await this.dynamoDBClient.send(new DeleteTableCommand({ TableName: physicalId }));
      // DeleteTable is async; wait until DescribeTable returns
      // ResourceNotFoundException so siblings / verify steps observing
      // the table after destroy see it actually gone.
      await this.waitForTableGone(physicalId, logicalId);
      this.logger.debug(`Successfully deleted DynamoDB GlobalTable ${logicalId}`);
    } catch (error) {
      if (error instanceof ResourceNotFoundException) {
        const clientRegion = await this.dynamoDBClient.config.region();
        assertRegionMatch(
          clientRegion,
          context?.expectedRegion,
          resourceType,
          logicalId,
          physicalId
        );
        this.logger.debug(`DynamoDB GlobalTable ${physicalId} does not exist, skipping`);
        return;
      }
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to delete DynamoDB GlobalTable ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  /**
   * Resolve a single `Fn::GetAtt` attribute for an existing DynamoDB GlobalTable.
   *
   * Cached per `(physicalId, attribute)` for the deploy run to avoid
   * repeated `DescribeTable` calls.
   */
  async getAttribute(
    physicalId: string,
    _resourceType: string,
    attributeName: string
  ): Promise<unknown> {
    const cacheKey = `${physicalId}::${attributeName}`;
    if (this.attributeCache.has(cacheKey)) {
      return this.attributeCache.get(cacheKey);
    }
    try {
      const resp = await this.dynamoDBClient.send(
        new DescribeTableCommand({ TableName: physicalId })
      );
      let value: unknown;
      switch (attributeName) {
        case 'Arn':
          value = resp.Table?.TableArn;
          break;
        case 'StreamArn':
          value = resp.Table?.LatestStreamArn;
          break;
        case 'TableId':
          value = resp.Table?.TableId;
          break;
        default:
          value = undefined;
      }
      this.attributeCache.set(cacheKey, value);
      return value;
    } catch (err) {
      if (err instanceof ResourceNotFoundException) return undefined;
      throw err;
    }
  }

  /**
   * Read the AWS-current DynamoDB GlobalTable configuration in CFn-property shape.
   *
   * Reverse-maps `DescribeTable` + `ListTagsOfResource` + `DescribeTimeToLive`
   * + per-replica `DescribeContributorInsights` /
   * `DescribeContinuousBackups` / `DescribeKinesisStreamingDestination`
   * into the `AWS::DynamoDB::GlobalTable` property set.
   *
   * Type-discriminator gating (memory rule
   * `feedback_always_emit_check_type_discriminator.md`):
   *  - StreamSpecification / SSESpecification follow the existing
   *    DynamoDB::Table provider's Class 1 guard: only surfaced when AWS
   *    reports the feature actually enabled.
   *  - `WriteProvisionedThroughputSettings` reverse-maps both shapes:
   *    flat `{WriteCapacityUnits}` (no autoscaling) and full
   *    `{WriteCapacityAutoScalingSettings}` (Issue #395; recovered from
   *    application-autoscaling's `DescribeScalableTargets` +
   *    `DescribeScalingPolicies` for the
   *    `dynamodb:table:WriteCapacityUnits` dimension).
   *  - Per-replica `ReadProvisionedThroughputSettings` reverse-maps the
   *    `{ReadCapacityAutoScalingSettings}` shape only — there is no
   *    per-replica flat read capacity in `DescribeTable`'s response
   *    (the local `ProvisionedThroughput` block is table-level, not
   *    replica-level), so non-autoscaled replicas omit the key.
   *
   * Per-replica sub-specifications (`ContributorInsightsSpecification` /
   * `PointInTimeRecoverySpecification` / `KinesisStreamSpecification`)
   * are surfaced only for the LOCAL replica. Cross-region replicas
   * require per-region SDK clients (`new DynamoDBClient({region})`),
   * deferred to a follow-up PR.
   */
  async readCurrentState(
    physicalId: string,
    _logicalId: string,
    _resourceType: string
  ): Promise<Record<string, unknown> | undefined> {
    try {
      const resp = await this.dynamoDBClient.send(
        new DescribeTableCommand({ TableName: physicalId })
      );
      const table = resp.Table;
      if (!table) return undefined;

      const result: Record<string, unknown> = {};

      if (table.TableName !== undefined) result['TableName'] = table.TableName;
      if (table.KeySchema) result['KeySchema'] = table.KeySchema;
      if (table.AttributeDefinitions) {
        result['AttributeDefinitions'] = table.AttributeDefinitions;
      }
      const billingMode = table.BillingModeSummary?.BillingMode;
      if (billingMode) {
        result['BillingMode'] = billingMode;
      }

      // Type-discriminator-gated: GSI / LSI placeholders. AWS omits these
      // when there are none; an empty-array placeholder would round-trip
      // as "remove all GSIs" on any future update() that learns the
      // field. Only surface when AWS reports indexes.
      if (table.GlobalSecondaryIndexes && table.GlobalSecondaryIndexes.length > 0) {
        result['GlobalSecondaryIndexes'] = table.GlobalSecondaryIndexes;
      }
      if (table.LocalSecondaryIndexes && table.LocalSecondaryIndexes.length > 0) {
        result['LocalSecondaryIndexes'] = table.LocalSecondaryIndexes;
      }

      // StreamSpecification: only emit when actually enabled. CFn's
      // schema requires StreamViewType when present, so the disabled
      // placeholder would be a CFn-invalid round-trip.
      if (table.StreamSpecification?.StreamEnabled && table.StreamSpecification.StreamViewType) {
        result['StreamSpecification'] = {
          StreamEnabled: true,
          StreamViewType: table.StreamSpecification.StreamViewType,
        };
      }

      // SSE: only emit when enabled. KMSMasterKeyId / SSEType are only
      // valid under SSEEnabled=true; an SSEEnabled=false placeholder
      // with a KMS key set would be CFn-invalid.
      if (table.SSEDescription?.Status === 'ENABLED') {
        const sse: Record<string, unknown> = { SSEEnabled: true };
        if (table.SSEDescription.SSEType !== undefined) {
          sse['SSEType'] = table.SSEDescription.SSEType;
        }
        result['SSESpecification'] = sse;
      }

      if (table.TableClassSummary?.TableClass) {
        result['TableClass'] = table.TableClassSummary.TableClass;
      }
      if (table.DeletionProtectionEnabled !== undefined) {
        result['DeletionProtectionEnabled'] = table.DeletionProtectionEnabled;
      }

      // Replicas: always emit `[]` placeholder per PR #145 — a console-side
      // replica add on a previously single-region table must show as drift.
      // Map RegionName → Region (CFn's per-replica shape) and attach
      // per-replica sub-specifications (PITR / Kinesis /
      // ContributorInsights / Tags) for BOTH the local AND cross-region
      // replicas — cross-region uses per-region SDK clients
      // (`getRegionalClient`) so each replica's sub-spec state surfaces
      // as drift just like the local one (Issue #389 lifted the v1
      // LOCAL-only limitation).
      const currentRegion = (await this.dynamoDBClient.config.region()) ?? '';
      const tableNameForSubs = table.TableName ?? physicalId;
      const replicas = await Promise.all(
        (table.Replicas ?? []).map(async (r) => {
          const entry: Record<string, unknown> = { Region: r.RegionName };
          if (r.KMSMasterKeyId !== undefined) entry['KMSMasterKeyId'] = r.KMSMasterKeyId;
          if (!r.RegionName) return entry;

          const isLocal = r.RegionName === currentRegion;
          const client = isLocal ? this.dynamoDBClient : this.getRegionalClient(r.RegionName);
          const regionLabel = r.RegionName;
          const replicaArn = isLocal
            ? table.TableArn
            : table.TableArn
              ? this.replicaArnForRegion(table.TableArn, r.RegionName)
              : undefined;

          // Per-replica sub-specs (PITR / Kinesis / ContributorInsights).
          // Best-effort: errors per region per sub-spec omit the offending
          // key — a permissions gap in one region must NOT abort the
          // whole drift read.
          const subs = await this.readReplicaSubSpecs(client, tableNameForSubs, regionLabel);
          Object.assign(entry, subs);

          // Per-replica Tags. CFn `GlobalTable` schema places Tags
          // inside `Replicas[]` (no top-level `Tags`), so they MUST be
          // surfaced here — not at the top level of `result`.
          if (replicaArn) {
            try {
              const tagsResp = await client.send(
                new ListTagsOfResourceCommand({ ResourceArn: replicaArn })
              );
              entry['Tags'] = normalizeAwsTagsToCfn(tagsResp.Tags);
            } catch (tagErr) {
              if (tagErr instanceof ResourceNotFoundException) {
                // Only the LOCAL replica's RNF can be a real "table gone"
                // signal. A cross-region RNF more likely means the
                // replica is in CREATING / DELETING — treat as transient
                // and omit the Tags key for that replica.
                if (isLocal) throw tagErr;
                this.logger.debug(
                  `Cross-region replica ${regionLabel} returned RNF on ListTagsOfResource; omitting Tags`
                );
                entry['Tags'] = [];
              } else {
                this.logger.warn(
                  `Could not fetch tags for DynamoDB GlobalTable ${tableNameForSubs} in ${regionLabel}: ${tagErr instanceof Error ? tagErr.message : String(tagErr)}`
                );
                entry['Tags'] = [];
              }
            }
          } else {
            entry['Tags'] = [];
          }

          // Per-replica ReadProvisionedThroughputSettings (Issue #395).
          // Type-discriminator-gated: only meaningful on PROVISIONED
          // tables. Probes application-autoscaling in the REPLICA'S
          // region — each replica registers its own scaling target +
          // policy in its own region, so the local-region client can
          // only see the local replica's settings.
          //
          // No flat `{ReadCapacityUnits: <n>}` fallback is emitted here:
          // `DescribeTable` returns ONE `ProvisionedThroughput` block for
          // the table, not one per replica, so cdkd cannot synthesize
          // per-replica flat read capacity from the local read. When
          // autoscaling owns the replica's read dimension the full
          // settings shape is surfaced; otherwise the key is omitted
          // entirely (drift will not fire on missing key, matching the
          // pre-#395 behavior for non-autoscaled replicas).
          if (billingMode === 'PROVISIONED') {
            const replicaAutoScalingClient = isLocal
              ? undefined
              : this.getRegionalAutoScalingClient(regionLabel);
            const readAutoScaling = await this.readAutoScalingSettings(
              tableNameForSubs,
              'dynamodb:table:ReadCapacityUnits',
              replicaAutoScalingClient
            );
            if (readAutoScaling) {
              entry['ReadProvisionedThroughputSettings'] = {
                ReadCapacityAutoScalingSettings: readAutoScaling,
              };
            }
          }
          return entry;
        })
      );
      result['Replicas'] = replicas;

      // WriteOnDemandThroughputSettings: trivial reverse-map from
      // `Table.OnDemandThroughput.MaxWriteRequestUnits`. Always-emit
      // `{}` placeholder when on-demand has no override so a console-side
      // ADD on a previously-default table fires drift (PR #145 pattern).
      if (table.OnDemandThroughput?.MaxWriteRequestUnits !== undefined) {
        result['WriteOnDemandThroughputSettings'] = {
          MaxWriteRequestUnits: table.OnDemandThroughput.MaxWriteRequestUnits,
        };
      } else {
        result['WriteOnDemandThroughputSettings'] = {};
      }

      // WriteProvisionedThroughputSettings — type-discriminator-gated on
      // `BillingMode === 'PROVISIONED'` (memory rule
      // `feedback_always_emit_check_type_discriminator.md`). Within the
      // PROVISIONED branch there is a SECOND discriminator: whether
      // application-autoscaling owns the write dimension. The two valid
      // shapes are mutually exclusive:
      //   - flat:        { WriteCapacityUnits: <n> }              (no autoscaling)
      //   - autoscaled:  { WriteCapacityAutoScalingSettings: ... } (Issue #395)
      // PAY_PER_REQUEST tables emit `{}` so a template that adds the key
      // after a BillingMode flip registers as drift, without committing
      // to either sub-shape on an on-demand table.
      if (billingMode === 'PROVISIONED') {
        const autoScaling = await this.readAutoScalingSettings(
          tableNameForSubs,
          'dynamodb:table:WriteCapacityUnits'
        );
        if (autoScaling) {
          result['WriteProvisionedThroughputSettings'] = {
            WriteCapacityAutoScalingSettings: autoScaling,
          };
        } else {
          const writeCapacity = table.ProvisionedThroughput?.WriteCapacityUnits;
          if (writeCapacity !== undefined) {
            result['WriteProvisionedThroughputSettings'] = {
              WriteCapacityUnits: writeCapacity,
            };
          } else {
            result['WriteProvisionedThroughputSettings'] = {};
          }
        }
      } else {
        // PAY_PER_REQUEST: type-discriminator-gated empty placeholder so a
        // template that adds `WriteProvisionedThroughputSettings` later
        // (after a BillingMode flip) registers as drift; neither sub-shape
        // is valid on on-demand tables.
        result['WriteProvisionedThroughputSettings'] = {};
      }

      // TimeToLiveSpecification: separate API call. Race-tolerant — when
      // AWS reports a transient `UPDATING` / `DISABLING` status, omit
      // the key rather than surface a transient state as drift.
      try {
        const ttlResp = await this.dynamoDBClient.send(
          new DescribeTimeToLiveCommand({ TableName: tableNameForSubs })
        );
        const ttlDesc = ttlResp.TimeToLiveDescription;
        const ttlStatus = ttlDesc?.TimeToLiveStatus;
        if (ttlStatus === 'ENABLED' && ttlDesc?.AttributeName) {
          result['TimeToLiveSpecification'] = {
            AttributeName: ttlDesc.AttributeName,
            Enabled: true,
          };
        } else if (ttlStatus === 'DISABLED') {
          // Disabled has no AttributeName; only surface if state held one
          // — the comparator will diff against state. For first-write
          // observed baselines, omit (matches "no TTL configured").
          // We intentionally do NOT emit a `{Enabled: false}` placeholder
          // because CFn rejects TimeToLiveSpecification without an
          // AttributeName.
        }
        // ENABLING / DISABLING: transient — omit so drift doesn't fire
        // on a momentary state.
      } catch (ttlErr) {
        this.logger.debug(
          `Could not read TimeToLive for ${tableNameForSubs}: ${ttlErr instanceof Error ? ttlErr.message : String(ttlErr)}`
        );
      }

      // Note: `Tags` are emitted INSIDE the local `Replicas[]` entry
      // above (the CFn `GlobalTable` schema has no top-level `Tags`).

      return result;
    } catch (err) {
      if (err instanceof ResourceNotFoundException) return undefined;
      throw err;
    }
  }

  /**
   * Read per-replica sub-specifications against the given `DynamoDBClient`
   * (which may be the local client or a per-region client returned by
   * `getRegionalClient`):
   *  - `ContributorInsightsSpecification` via `DescribeContributorInsights`
   *    (table-level; GSI overrides are NOT surfaced in v1 — they would
   *    require one call per GSI and a different CFn nesting under the
   *    `Replicas[].GlobalSecondaryIndexes[]` shape).
   *  - `PointInTimeRecoverySpecification` via `DescribeContinuousBackups`.
   *  - `KinesisStreamSpecification` via
   *    `DescribeKinesisStreamingDestination` (filtered to the local
   *    region's destination when AWS reports more than one).
   *
   * Each call is best-effort: errors omit the offending key rather than
   * fail the whole drift read.
   *
   * Issue #389 lifted the LOCAL-only limitation by parameterizing the
   * client — the same reverse-mapping logic runs against any region's
   * client.
   */
  private async readReplicaSubSpecs(
    client: DynamoDBClient,
    tableName: string,
    regionLabel: string
  ): Promise<Record<string, unknown>> {
    const out: Record<string, unknown> = {};

    // ContributorInsights (table-level only in v1).
    try {
      const ci = await client.send(
        new DescribeContributorInsightsCommand({ TableName: tableName })
      );
      if (ci.ContributorInsightsStatus) {
        out['ContributorInsightsSpecification'] = {
          Enabled: ci.ContributorInsightsStatus === 'ENABLED',
        };
      }
    } catch (err) {
      this.logger.debug(
        `Could not read ContributorInsights for ${tableName} in ${regionLabel}: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    // PointInTimeRecovery via DescribeContinuousBackups.
    try {
      const pitr = await client.send(
        new DescribeContinuousBackupsCommand({ TableName: tableName })
      );
      const pitrStatus =
        pitr.ContinuousBackupsDescription?.PointInTimeRecoveryDescription
          ?.PointInTimeRecoveryStatus;
      if (pitrStatus) {
        out['PointInTimeRecoverySpecification'] = {
          PointInTimeRecoveryEnabled: pitrStatus === 'ENABLED',
        };
      }
    } catch (err) {
      this.logger.debug(
        `Could not read PointInTimeRecovery for ${tableName} in ${regionLabel}: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    // Kinesis streaming destination — pick the first ACTIVE destination
    // (CFn's per-replica shape only carries one StreamArn).
    try {
      const ks = await client.send(
        new DescribeKinesisStreamingDestinationCommand({ TableName: tableName })
      );
      const destinations = ks.KinesisDataStreamDestinations ?? [];
      const active = destinations.find(
        (d) => d.DestinationStatus === 'ACTIVE' || d.DestinationStatus === 'ENABLING'
      );
      if (active?.StreamArn) {
        const ksOut: Record<string, unknown> = { StreamArn: active.StreamArn };
        if (active.ApproximateCreationDateTimePrecision !== undefined) {
          ksOut['ApproximateCreationDateTimePrecision'] =
            active.ApproximateCreationDateTimePrecision;
        }
        out['KinesisStreamSpecification'] = ksOut;
      }
    } catch (err) {
      this.logger.debug(
        `Could not read KinesisStreamingDestination for ${tableName} in ${regionLabel}: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    return out;
  }

  /**
   * Reverse-map application-autoscaling state for the given DynamoDB table
   * dimension into the CFn `*CapacityAutoScalingSettings` shape (Issue
   * #395). Used for BOTH the table-level write dimension
   * (`dynamodb:table:WriteCapacityUnits`) and the per-replica read
   * dimension (`dynamodb:table:ReadCapacityUnits`); the CFn shape is
   * symmetric.
   *
   * Returns shape (CFn-canonical PascalCase keys, verified via `cdk synth`
   * on a real `TableV2` with `Capacity.autoscaled(...)` on 2026-05-16 —
   * see PR notes for the probe transcript):
   *
   * ```
   * {
   *   MinCapacity: number;
   *   MaxCapacity: number;
   *   TargetTrackingScalingPolicyConfiguration: {
   *     TargetValue: number;
   *     DisableScaleIn?: boolean;
   *     ScaleInCooldown?: number;
   *     ScaleOutCooldown?: number;
   *   };
   * }
   * ```
   *
   * `SeedCapacity` is intentionally NOT round-tripped — it is a CFn
   * create-only field with no corresponding application-autoscaling
   * surface (AWS does not retain the initial seed value once the
   * scaling target is registered).
   *
   * Resolution order:
   *  1. `DescribeScalableTargets` → recover `MinCapacity` / `MaxCapacity`
   *     for the matching `ScalableDimension`. Returns `null` when no
   *     target is registered (= no autoscaling in play for this
   *     dimension — caller falls back to the flat capacity surface).
   *  2. `DescribeScalingPolicies` → find the `TargetTrackingScaling`
   *     policy (filter out `StepScaling` / `PredictiveScaling` — CFn's
   *     shape only carries the target-tracking variant). Returns `null`
   *     when no `TargetTrackingScaling` policy is present (a scaling
   *     target without a target-tracking policy is not cdkd-managed
   *     drift territory; surface the flat capacity instead).
   *
   * Best-effort: any error (permissions gap, throttle, network) returns
   * `null` and the caller falls back to the flat-capacity branch. Logged
   * at debug so a real permissions misconfiguration is still visible
   * under `--verbose`.
   *
   * @param tableName DynamoDB table name (the `physicalId`).
   * @param scalableDimension `'dynamodb:table:WriteCapacityUnits'` or
   *   `'dynamodb:table:ReadCapacityUnits'`.
   * @param client Pre-built region-scoped autoscaling client. Defaults to
   *   a fresh client in the local region — pass an explicit client when
   *   reading from a cross-region replica.
   */
  private async readAutoScalingSettings(
    tableName: string,
    scalableDimension: 'dynamodb:table:WriteCapacityUnits' | 'dynamodb:table:ReadCapacityUnits',
    client?: ApplicationAutoScalingClient
  ): Promise<Record<string, unknown> | null> {
    try {
      const asClient =
        client ??
        new ApplicationAutoScalingClient({
          region: (await this.dynamoDBClient.config.region()) ?? '',
        });

      // 1. Probe ScalableTargets for Min/Max.
      const targetsResp = await asClient.send(
        new DescribeScalableTargetsCommand({
          ServiceNamespace: 'dynamodb',
          ResourceIds: [`table/${tableName}`],
          ScalableDimension: scalableDimension,
        })
      );
      const targets = targetsResp.ScalableTargets ?? [];
      if (targets.length === 0) return null;
      const target = targets[0]!;
      if (target.MinCapacity === undefined || target.MaxCapacity === undefined) {
        return null;
      }

      // 2. Probe ScalingPolicies for the TargetTrackingScaling policy.
      const policiesResp = await asClient.send(
        new DescribeScalingPoliciesCommand({
          ServiceNamespace: 'dynamodb',
          ResourceId: `table/${tableName}`,
          ScalableDimension: scalableDimension,
        })
      );
      const policies = policiesResp.ScalingPolicies ?? [];
      const targetTracking = policies.find((p) => p.PolicyType === 'TargetTrackingScaling');
      if (!targetTracking) return null;
      const cfg = targetTracking.TargetTrackingScalingPolicyConfiguration;
      if (!cfg || cfg.TargetValue === undefined) return null;

      const tttConfig: Record<string, unknown> = { TargetValue: cfg.TargetValue };
      if (cfg.DisableScaleIn !== undefined) {
        tttConfig['DisableScaleIn'] = cfg.DisableScaleIn;
      }
      if (cfg.ScaleInCooldown !== undefined) {
        tttConfig['ScaleInCooldown'] = cfg.ScaleInCooldown;
      }
      if (cfg.ScaleOutCooldown !== undefined) {
        tttConfig['ScaleOutCooldown'] = cfg.ScaleOutCooldown;
      }

      return {
        MinCapacity: target.MinCapacity,
        MaxCapacity: target.MaxCapacity,
        TargetTrackingScalingPolicyConfiguration: tttConfig,
      };
    } catch (err) {
      this.logger.debug(
        `Could not read application-autoscaling settings for ${tableName} (${scalableDimension}): ${err instanceof Error ? err.message : String(err)}`
      );
      return null;
    }
  }

  /**
   * State property paths cdkd's GlobalTable readCurrentState cannot (yet)
   * reverse-map. The drift comparator skips these so a templated value
   * doesn't fire guaranteed false drift on every clean run.
   *
   * Issue #389 + #395 emptied this list:
   *  - `WriteProvisionedThroughputSettings` reverse-maps both the flat
   *    `{WriteCapacityUnits}` shape (no autoscaling) AND the full
   *    `{WriteCapacityAutoScalingSettings}` shape (autoscaling-managed;
   *    recovered from `DescribeScalableTargets` +
   *    `DescribeScalingPolicies`). PAY_PER_REQUEST tables emit `{}`.
   *  - Per-replica `ReadProvisionedThroughputSettings.ReadCapacityAutoScalingSettings`
   *    reverse-maps from a region-scoped application-autoscaling client
   *    for the `dynamodb:table:ReadCapacityUnits` dimension. Non-
   *    autoscaled replicas omit the key (no per-replica flat read
   *    capacity available in `DescribeTable`).
   *  - `WriteOnDemandThroughputSettings` is reverse-mapped from
   *    `Table.OnDemandThroughput.MaxWriteRequestUnits`. Always-emit
   *    `{}` placeholder when AWS reports no override.
   *  - `TimeToLiveSpecification` is reverse-mapped via
   *    `DescribeTimeToLive` in `readCurrentState`.
   *
   * Returning an empty list is the canonical "no known-unknown paths"
   * shape — keeping the method present (rather than removing it) for
   * future additions and for backward compat on test reflection.
   */
  getDriftUnknownPaths(_resourceType: string): string[] {
    return [];
  }

  /**
   * Adopt an existing DynamoDB GlobalTable into cdkd state.
   *
   * Lookup order:
   *   1. `--resource` override or `Properties.TableName` → verify via DescribeTable.
   *   2. `ListTables` + `ListTagsOfResource`, match `aws:cdk:path` tag.
   *
   * Same shape as `DynamoDBTableProvider.import()`. The provider returns
   * the physical id only; cdkd's import flow does the attribute capture
   * separately.
   */
  async import(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    const explicit = resolveExplicitPhysicalId(input, 'TableName');
    if (explicit) {
      try {
        await this.dynamoDBClient.send(new DescribeTableCommand({ TableName: explicit }));
        return { physicalId: explicit, attributes: {} };
      } catch (err) {
        if (err instanceof ResourceNotFoundException) return null;
        throw err;
      }
    }

    if (!input.cdkPath) return null;

    let exclusiveStartTableName: string | undefined;
    do {
      const list = await this.dynamoDBClient.send(
        new ListTablesCommand({
          ...(exclusiveStartTableName && { ExclusiveStartTableName: exclusiveStartTableName }),
        })
      );
      for (const name of list.TableNames ?? []) {
        try {
          const desc = await this.dynamoDBClient.send(
            new DescribeTableCommand({ TableName: name })
          );
          const arn = desc.Table?.TableArn;
          if (!arn) continue;
          const tagsResp = await this.dynamoDBClient.send(
            new ListTagsOfResourceCommand({ ResourceArn: arn })
          );
          if (matchesCdkPath(tagsResp.Tags, input.cdkPath)) {
            return { physicalId: name, attributes: {} };
          }
        } catch (err) {
          if (err instanceof ResourceNotFoundException) continue;
          throw err;
        }
      }
      exclusiveStartTableName = list.LastEvaluatedTableName;
    } while (exclusiveStartTableName);
    return null;
  }

  // ─── Polling helpers ─────────────────────────────────────────────────

  private async waitForTableActive(
    tableName: string,
    logicalId: string,
    maxAttempts = 120
  ): Promise<{
    tableArn: string | undefined;
    tableId: string | undefined;
    streamArn: string | undefined;
  }> {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const response = await this.dynamoDBClient.send(
        new DescribeTableCommand({ TableName: tableName })
      );
      const status = response.Table?.TableStatus;
      this.logger.debug(`Table ${tableName} status: ${status} (attempt ${attempt}/${maxAttempts})`);

      if (status === 'ACTIVE') {
        return {
          tableArn: response.Table?.TableArn,
          tableId: response.Table?.TableId,
          streamArn: response.Table?.LatestStreamArn,
        };
      }
      if (status !== 'CREATING' && status !== 'UPDATING') {
        throw new ProvisioningError(
          `Unexpected table status while waiting for ACTIVE on ${tableName}: ${status}`,
          'AWS::DynamoDB::GlobalTable',
          logicalId,
          tableName
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    throw new ProvisioningError(
      `Table ${tableName} did not reach ACTIVE within ${maxAttempts}s`,
      'AWS::DynamoDB::GlobalTable',
      logicalId,
      tableName
    );
  }

  /**
   * Wait for the table to reach ACTIVE after an UpdateTable call. Unlike
   * `waitForTableActive`, this tolerates any non-terminal status — the
   * table may already be ACTIVE on the no-op path (already-disabled
   * protection) or transition through UPDATING.
   */
  private async waitForTableActiveAfterUpdate(
    tableName: string,
    logicalId: string,
    maxAttempts = 600
  ): Promise<void> {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const response = await this.dynamoDBClient.send(
        new DescribeTableCommand({ TableName: tableName })
      );
      if (response.Table?.TableStatus === 'ACTIVE') return;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    throw new ProvisioningError(
      `Table ${tableName} did not reach ACTIVE within ${maxAttempts}s after UpdateTable`,
      'AWS::DynamoDB::GlobalTable',
      logicalId,
      tableName
    );
  }

  /**
   * Wait until a specific replica's `ReplicaStatus` flips to ACTIVE.
   * Replica provisioning typically takes 1–5 min; cap at 10 min.
   */
  private async waitForReplicaActive(
    tableName: string,
    region: string,
    logicalId: string,
    maxAttempts = 600
  ): Promise<void> {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const response = await this.dynamoDBClient.send(
        new DescribeTableCommand({ TableName: tableName })
      );
      const replica = response.Table?.Replicas?.find((r) => r.RegionName === region);
      if (replica?.ReplicaStatus === 'ACTIVE') return;
      this.logger.debug(
        `Replica ${region} status: ${replica?.ReplicaStatus} (attempt ${attempt}/${maxAttempts})`
      );
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    throw new ProvisioningError(
      `Replica ${region} for table ${tableName} did not reach ACTIVE within ${maxAttempts}s`,
      'AWS::DynamoDB::GlobalTable',
      logicalId,
      tableName
    );
  }

  /**
   * Wait until a specific replica disappears from `Replicas[]` after a
   * Delete replica update. Replica deletion typically takes 1–5 min;
   * cap at 10 min.
   */
  private async waitForReplicaGone(
    tableName: string,
    region: string,
    logicalId: string,
    maxAttempts = 600
  ): Promise<void> {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const response = await this.dynamoDBClient.send(
          new DescribeTableCommand({ TableName: tableName })
        );
        const replica = response.Table?.Replicas?.find((r) => r.RegionName === region);
        if (!replica) return;
        await new Promise((resolve) => setTimeout(resolve, 1000));
      } catch (err) {
        if (err instanceof ResourceNotFoundException) return;
        throw err;
      }
    }
    throw new ProvisioningError(
      `Replica ${region} for table ${tableName} did not disappear within ${maxAttempts}s`,
      'AWS::DynamoDB::GlobalTable',
      logicalId,
      tableName
    );
  }

  /**
   * Wait for `DescribeTable` to return `ResourceNotFoundException`,
   * confirming the table has actually been removed. `DeleteTable` is
   * async — the call returns immediately with `TableStatus: DELETING`
   * and AWS only removes the table some seconds later. Without this
   * wait, downstream observers (siblings deleted in the same destroy
   * run, integ scripts that re-check via `aws dynamodb describe-table`)
   * see "destroy succeeded" but the table is still listed by AWS.
   * Typical small-table delete completes in 5–30s; cap at 10 min for
   * worst-case large-table / replica-cascade scenarios.
   */
  private async waitForTableGone(
    tableName: string,
    logicalId: string,
    maxAttempts = 600
  ): Promise<void> {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await this.dynamoDBClient.send(new DescribeTableCommand({ TableName: tableName }));
        await new Promise((resolve) => setTimeout(resolve, 1000));
      } catch (err) {
        if (err instanceof ResourceNotFoundException) return;
        throw err;
      }
    }
    throw new ProvisioningError(
      `Table ${tableName} did not disappear within ${maxAttempts}s`,
      'AWS::DynamoDB::GlobalTable',
      logicalId,
      tableName
    );
  }
}

// ─── Pure-functional diff helpers (exported for testing) ───────────────

/**
 * Diff CFn `Replicas[]` arrays. Keyed by `Region`. Returns adds, removes,
 * and modifies (entries whose other keys — KMSMasterKeyId,
 * GlobalSecondaryIndexes, TableClassOverride — differ from the old shape).
 */
/**
 * Derive the per-call `ProvisionedThroughput` shape required by
 * `CreateTableCommand` / `UpdateTableCommand` when BillingMode flips to
 * PROVISIONED. Shared between create() and the BillingMode-flip path in
 * update() so a user template's non-default read/write capacity is
 * preserved consistently across both code paths.
 *
 * Source of truth (CFn `AWS::DynamoDB::GlobalTable` shape):
 *  - WriteCapacityUnits → `properties.WriteProvisionedThroughputSettings`
 *    (top-level on the table). Literal `WriteCapacityUnits` wins over
 *    auto-scaling `MinCapacity`; both default to 5 if absent.
 *  - ReadCapacityUnits → `Replicas[?Region==<region>].ReadProvisionedThroughputSettings`
 *    (per-replica, the deploy region's setting). Same literal-vs-auto-
 *    scaling-vs-default-5 precedence.
 */
/**
 * Extract the local replica's `DeletionProtectionEnabled` from a CFn
 * properties shape. The `AWS::DynamoDB::GlobalTable` CFn schema places
 * the field inside `Replicas[?Region==<region>].DeletionProtectionEnabled`;
 * CDK 2.x's `deletionProtection: true` synthesizes there. Falls back
 * to the top-level `DeletionProtectionEnabled` for legacy or
 * hand-authored templates (the property doesn't formally exist at
 * the top level in the CFn schema, but cdkd tolerates it as a
 * pass-through to avoid breaking older state files).
 *
 * Returns `undefined` when neither shape carries a boolean — the
 * caller treats that as "unset" and does not include the field in
 * the SDK call.
 */
export function extractLocalDeletionProtection(
  props: Record<string, unknown>,
  region: string
): boolean | undefined {
  const replicas = (props['Replicas'] ?? []) as Array<Record<string, unknown>>;
  const local = replicas.find((r) => r['Region'] === region);
  const perReplica = local?.['DeletionProtectionEnabled'];
  if (typeof perReplica === 'boolean') return perReplica;
  const topLevel = props['DeletionProtectionEnabled'];
  return typeof topLevel === 'boolean' ? topLevel : undefined;
}

export function derivePerCallProvisionedThroughput(
  properties: Record<string, unknown>,
  region: string
): { ReadCapacityUnits: number; WriteCapacityUnits: number } {
  const wps = properties['WriteProvisionedThroughputSettings'] as
    | Record<string, unknown>
    | undefined;
  const writeAutoScaling = wps?.['WriteCapacityAutoScalingSettings'] as
    | Record<string, unknown>
    | undefined;
  const writeCapacity = Number(
    wps?.['WriteCapacityUnits'] ?? writeAutoScaling?.['MinCapacity'] ?? 5
  );
  const replicas = (properties['Replicas'] ?? []) as Array<Record<string, unknown>>;
  const localReplica = replicas.find((r) => r['Region'] === region);
  const localReadSettings = localReplica?.['ReadProvisionedThroughputSettings'] as
    | Record<string, unknown>
    | undefined;
  const readAutoScaling = localReadSettings?.['ReadCapacityAutoScalingSettings'] as
    | Record<string, unknown>
    | undefined;
  const readCapacity = Number(
    localReadSettings?.['ReadCapacityUnits'] ?? readAutoScaling?.['MinCapacity'] ?? 5
  );
  return {
    ReadCapacityUnits: readCapacity,
    WriteCapacityUnits: writeCapacity,
  };
}

export function diffReplicas(
  oldReplicas: Array<Record<string, unknown>>,
  newReplicas: Array<Record<string, unknown>>
): {
  added: Array<Record<string, unknown>>;
  removed: Array<Record<string, unknown>>;
  modified: Array<Record<string, unknown>>;
} {
  const oldByRegion = new Map<string, Record<string, unknown>>();
  const newByRegion = new Map<string, Record<string, unknown>>();
  for (const r of oldReplicas) {
    const region = r['Region'] as string | undefined;
    if (region) oldByRegion.set(region, r);
  }
  for (const r of newReplicas) {
    const region = r['Region'] as string | undefined;
    if (region) newByRegion.set(region, r);
  }

  const added: Array<Record<string, unknown>> = [];
  const removed: Array<Record<string, unknown>> = [];
  const modified: Array<Record<string, unknown>> = [];

  for (const [region, replica] of newByRegion) {
    if (!oldByRegion.has(region)) {
      added.push(replica);
    } else if (!deepEqual(oldByRegion.get(region), replica)) {
      modified.push(replica);
    }
  }
  for (const [region, replica] of oldByRegion) {
    if (!newByRegion.has(region)) {
      removed.push(replica);
    }
  }
  return { added, removed, modified };
}

/**
 * Diff CFn `GlobalSecondaryIndexes[]` arrays. Keyed by `IndexName`.
 * Modified = same IndexName but other fields (ProvisionedThroughput /
 * OnDemandThroughput) differ. KeySchema / Projection changes count as
 * "modified" too — AWS rejects those via UpdateGSI, but the diff caller
 * surfaces the AWS-side error rather than this helper second-guessing.
 */
export function diffGlobalSecondaryIndexes(
  oldGsi: GlobalSecondaryIndex[],
  newGsi: GlobalSecondaryIndex[]
): {
  added: GlobalSecondaryIndex[];
  removed: GlobalSecondaryIndex[];
  modified: GlobalSecondaryIndex[];
} {
  const oldByName = new Map<string, GlobalSecondaryIndex>();
  const newByName = new Map<string, GlobalSecondaryIndex>();
  for (const g of oldGsi) {
    if (g.IndexName) oldByName.set(g.IndexName, g);
  }
  for (const g of newGsi) {
    if (g.IndexName) newByName.set(g.IndexName, g);
  }
  const added: GlobalSecondaryIndex[] = [];
  const removed: GlobalSecondaryIndex[] = [];
  const modified: GlobalSecondaryIndex[] = [];
  for (const [name, gsi] of newByName) {
    if (!oldByName.has(name)) added.push(gsi);
    else if (!deepEqual(oldByName.get(name), gsi)) modified.push(gsi);
  }
  for (const [name, gsi] of oldByName) {
    if (!newByName.has(name)) removed.push(gsi);
  }
  return { added, removed, modified };
}

/**
 * Structural equality via JSON.stringify. Both inputs are CFn-shape
 * POJOs (no functions, no symbols, no cycles), so JSON round-trip is
 * sufficient and free of the property-order pitfalls of deeper
 * comparators. Object property order from `Object.keys` is insertion
 * order in modern engines; AWS-SDK shapes are constructed by the SDK
 * in stable order, so this is safe in practice.
 */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}
