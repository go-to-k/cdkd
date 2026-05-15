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
 *    is surfaced for the LOCAL replica only; cross-region replicas
 *    require per-region SDK clients which are out of scope for v1.
 */
export class DynamoDBGlobalTableProvider implements ResourceProvider {
  private dynamoDBClient: DynamoDBClient;
  private logger = getLogger().child('DynamoDBGlobalTableProvider');
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
        'Tags',
      ]),
    ],
  ]);

  constructor() {
    const awsClients = getAwsClients();
    this.dynamoDBClient = awsClients.dynamoDB;
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
      const wps = properties['WriteProvisionedThroughputSettings'] as
        | Record<string, unknown>
        | undefined;
      const writeAutoScaling = wps?.['WriteCapacityAutoScalingSettings'] as
        | Record<string, unknown>
        | undefined;
      // CFn's GlobalTable shape allows a literal `WriteCapacityUnits` next
      // to the auto-scaling block (TableV2 doesn't emit it, but
      // hand-authored templates may). Honor whichever was supplied.
      const writeCapacity = Number(
        wps?.['WriteCapacityUnits'] ?? writeAutoScaling?.['MinCapacity'] ?? 5
      );
      const localReplica = replicas.find((r) => r['Region'] === currentRegion);
      const localReadSettings = localReplica?.['ReadProvisionedThroughputSettings'] as
        | Record<string, unknown>
        | undefined;
      const readAutoScaling = localReadSettings?.['ReadCapacityAutoScalingSettings'] as
        | Record<string, unknown>
        | undefined;
      const readCapacity = Number(
        localReadSettings?.['ReadCapacityUnits'] ?? readAutoScaling?.['MinCapacity'] ?? 5
      );
      createParams.ProvisionedThroughput = {
        ReadCapacityUnits: readCapacity,
        WriteCapacityUnits: writeCapacity,
      };
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

    if (properties['DeletionProtectionEnabled'] !== undefined) {
      createParams.DeletionProtectionEnabled = properties['DeletionProtectionEnabled'] as boolean;
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

    // Tags applied via CreateTable input directly (avoids a separate
    // TagResource round-trip).
    if (properties['Tags']) {
      createParams.Tags = properties['Tags'] as Tag[];
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
      this.logger.warn(
        `Wiring failed after CreateTable for ${tableName}; attempting best-effort cleanup`
      );
      try {
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

    try {
      // 1. Wait for ACTIVE before any update — defensive against rare
      // states where a previous deploy left the table mid-transition.
      await this.waitForTableActiveAfterUpdate(physicalId, logicalId);

      // 2. Tags diff. TagResource / UntagResource on the table's ARN; no
      // UpdateTable round-trip needed and no wait between tag calls.
      const describeResp = await this.dynamoDBClient.send(
        new DescribeTableCommand({ TableName: physicalId })
      );
      const tableArn = describeResp.Table?.TableArn;
      if (tableArn) {
        await this.applyTagDiff(
          tableArn,
          previousProperties['Tags'] as Array<{ Key?: string; Value?: string }> | undefined,
          properties['Tags'] as Array<{ Key?: string; Value?: string }> | undefined
        );
      }

      // 3. Non-conflicting flat fields in one combined UpdateTable.
      // AWS allows combining these in a single call because they don't
      // conflict with each other or with each other's modes.
      const flatUpdate: UpdateTableCommandInput = { TableName: physicalId };
      let flatChanged = false;
      if (
        properties['DeletionProtectionEnabled'] !== previousProperties['DeletionProtectionEnabled']
      ) {
        flatUpdate.DeletionProtectionEnabled = Boolean(
          properties['DeletionProtectionEnabled'] ?? false
        );
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
      const oldBilling = (previousProperties['BillingMode'] as string | undefined) ?? 'PROVISIONED';
      const newBilling = (properties['BillingMode'] as string | undefined) ?? 'PROVISIONED';
      if (oldBilling !== newBilling) {
        const billingUpdate: UpdateTableCommandInput = {
          TableName: physicalId,
          BillingMode: newBilling as 'PROVISIONED' | 'PAY_PER_REQUEST',
        };
        if (newBilling === 'PROVISIONED') {
          const wps = properties['WriteProvisionedThroughputSettings'] as
            | Record<string, unknown>
            | undefined;
          const writeAutoScaling = wps?.['WriteCapacityAutoScalingSettings'] as
            | Record<string, unknown>
            | undefined;
          const writeCapacity = Number(
            wps?.['WriteCapacityUnits'] ?? writeAutoScaling?.['MinCapacity'] ?? 5
          );
          billingUpdate.ProvisionedThroughput = {
            ReadCapacityUnits: 5,
            WriteCapacityUnits: writeCapacity,
          };
        }
        await this.dynamoDBClient.send(new UpdateTableCommand(billingUpdate));
        await this.waitForTableActiveAfterUpdate(physicalId, logicalId);
      }

      // 5. Replica diff. AWS limits to ONE ReplicaUpdates entry per call,
      // so serialize Create / Update / Delete and wait between each.
      const currentRegion = (await this.dynamoDBClient.config.region()) ?? '';
      const replicaDiff = diffReplicas(
        (previousProperties['Replicas'] ?? []) as Array<Record<string, unknown>>,
        (properties['Replicas'] ?? []) as Array<Record<string, unknown>>
      );
      // Removes first: AWS rejects DeleteTable on a multi-replica table
      // but tolerates dropping replicas while the rest stay live.
      for (const replica of replicaDiff.removed) {
        const region = replica['Region'] as string | undefined;
        if (!region || region === currentRegion) continue;
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
      }
      for (const replica of replicaDiff.modified) {
        const region = replica['Region'] as string | undefined;
        if (!region || region === currentRegion) continue;
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
      if (
        !deepEqual(
          properties['TimeToLiveSpecification'],
          previousProperties['TimeToLiveSpecification']
        )
      ) {
        const ttl = properties['TimeToLiveSpecification'] as Record<string, unknown> | undefined;
        if (ttl?.['AttributeName']) {
          await this.dynamoDBClient.send(
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
            await this.dynamoDBClient.send(
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
   * `TagResource` / `UntagResource` APIs. Both take the table ARN as
   * `ResourceArn`.
   */
  private async applyTagDiff(
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
      await this.dynamoDBClient.send(
        new UntagResourceCommand({ ResourceArn: tableArn, TagKeys: tagsToRemove })
      );
      this.logger.debug(
        `Removed ${tagsToRemove.length} tag(s) from DynamoDB GlobalTable ${tableArn}`
      );
    }
    if (tagsToAdd.length > 0) {
      await this.dynamoDBClient.send(
        new TagResourceCommand({ ResourceArn: tableArn, Tags: tagsToAdd })
      );
      this.logger.debug(
        `Added/updated ${tagsToAdd.length} tag(s) on DynamoDB GlobalTable ${tableArn}`
      );
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
    try {
      const describe = await this.dynamoDBClient.send(
        new DescribeTableCommand({ TableName: physicalId })
      );
      const replicas = describe.Table?.Replicas ?? [];
      for (const replica of replicas) {
        const region = replica.RegionName;
        if (!region || region === currentRegion) continue;
        try {
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
   *  - `ProvisionedThroughput`-bearing fields are declared in
   *    `getDriftUnknownPaths` and intentionally not emitted in v1 — the
   *    reverse-mapping from AWS's `ProvisionedThroughput` shape into
   *    CFn's `WriteProvisionedThroughputSettings` /
   *    `ReadProvisionedThroughputSettings` wrappers (which carry
   *    `WriteCapacityAutoScalingSettings` etc.) needs more work to round
   *    -trip cleanly.
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
      // Map RegionName → Region (CFn's per-replica shape) and attach the
      // local replica's per-replica sub-specifications (PITR / Kinesis /
      // ContributorInsights) when AWS reports them.
      const currentRegion = (await this.dynamoDBClient.config.region()) ?? '';
      const tableNameForSubs = table.TableName ?? physicalId;
      const replicas = await Promise.all(
        (table.Replicas ?? []).map(async (r) => {
          const entry: Record<string, unknown> = { Region: r.RegionName };
          if (r.KMSMasterKeyId !== undefined) entry['KMSMasterKeyId'] = r.KMSMasterKeyId;
          // Per-replica sub-specs: only the local replica in v1.
          // Cross-region calls would need a per-region client, deferred.
          if (r.RegionName && r.RegionName === currentRegion) {
            const subs = await this.readLocalReplicaSubSpecs(tableNameForSubs);
            Object.assign(entry, subs);
          }
          return entry;
        })
      );
      result['Replicas'] = replicas;

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

      // Tags via ListTagsOfResource. Always-emit `[]` even when AWS
      // reports zero user tags so a console-side tag ADD on a previously
      // untagged table shows as drift (PR #145 pattern).
      if (table.TableArn) {
        try {
          const tagsResp = await this.dynamoDBClient.send(
            new ListTagsOfResourceCommand({ ResourceArn: table.TableArn })
          );
          result['Tags'] = normalizeAwsTagsToCfn(tagsResp.Tags);
        } catch (err) {
          if (err instanceof ResourceNotFoundException) return undefined;
          // Tag fetch failures shouldn't tank the whole drift read —
          // surface a warn so operators see the gap, then fall back to
          // the empty placeholder so the comparator can still run.
          this.logger.warn(
            `Could not fetch tags for DynamoDB GlobalTable ${tableNameForSubs}: ${err instanceof Error ? err.message : String(err)}`
          );
          result['Tags'] = [];
        }
      } else {
        result['Tags'] = [];
      }

      return result;
    } catch (err) {
      if (err instanceof ResourceNotFoundException) return undefined;
      throw err;
    }
  }

  /**
   * Read per-replica sub-specifications for the LOCAL replica:
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
   * Cross-region replicas would need per-region SDK clients (the calls
   * are region-scoped to the replica) — deferred to a follow-up PR.
   */
  private async readLocalReplicaSubSpecs(tableName: string): Promise<Record<string, unknown>> {
    const out: Record<string, unknown> = {};

    // ContributorInsights (table-level only in v1).
    try {
      const ci = await this.dynamoDBClient.send(
        new DescribeContributorInsightsCommand({ TableName: tableName })
      );
      if (ci.ContributorInsightsStatus) {
        out['ContributorInsightsSpecification'] = {
          Enabled: ci.ContributorInsightsStatus === 'ENABLED',
        };
      }
    } catch (err) {
      this.logger.debug(
        `Could not read ContributorInsights for ${tableName}: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    // PointInTimeRecovery via DescribeContinuousBackups.
    try {
      const pitr = await this.dynamoDBClient.send(
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
        `Could not read PointInTimeRecovery for ${tableName}: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    // Kinesis streaming destination — pick the first ACTIVE destination
    // (CFn's per-replica shape only carries one StreamArn).
    try {
      const ks = await this.dynamoDBClient.send(
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
        `Could not read KinesisStreamingDestination for ${tableName}: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    return out;
  }

  /**
   * State property paths cdkd's GlobalTable readCurrentState cannot (yet)
   * reverse-map. The drift comparator skips these so a templated value
   * doesn't fire guaranteed false drift on every clean run.
   *
   * - `WriteProvisionedThroughputSettings` /
   *   `WriteOnDemandThroughputSettings`: CFn's shapes wrap
   *   auto-scaling / on-demand max-RU settings whose reverse-mapping
   *   from `DescribeTable.ProvisionedThroughput` / `OnDemandThroughput`
   *   is non-trivial and would fire false drift in v1.
   *
   * `TimeToLiveSpecification` is reverse-mapped via `DescribeTimeToLive`
   * in `readCurrentState` (no longer in this list).
   */
  getDriftUnknownPaths(_resourceType: string): string[] {
    return ['WriteProvisionedThroughputSettings', 'WriteOnDemandThroughputSettings'];
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
