import {
  DynamoDBClient,
  CreateTableCommand,
  DeleteTableCommand,
  DescribeTableCommand,
  ListTablesCommand,
  ListTagsOfResourceCommand,
  UpdateTableCommand,
  UpdateTimeToLiveCommand,
  ResourceNotFoundException,
  type CreateTableCommandInput,
  type KeySchemaElement,
  type AttributeDefinition,
  type GlobalSecondaryIndex,
  type LocalSecondaryIndex,
  type StreamSpecification,
  type Tag,
  type ReplicationGroupUpdate,
  type CreateReplicationGroupMemberAction,
} from '@aws-sdk/client-dynamodb';
import { getLogger } from '../../utils/logger.js';
import { getAwsClients } from '../../utils/aws-clients.js';
import { ProvisioningError, ResourceUpdateNotSupportedError } from '../../utils/error-handler.js';
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
 * MVP scope:
 *  - `update()` throws `ResourceUpdateNotSupportedError`. In-place GlobalTable
 *    updates (replica add/remove, GSI add/remove, BillingMode flip, throughput
 *    rewrites) are out of scope and a follow-up PR.
 *  - `getDriftUnknownPaths` declares TTL + throughput-settings paths because
 *    cdkd's create/update flows surface them but the read-side reverse
 *    mapping is non-trivial and would fire false drift.
 *  - Per-replica drift (`ContributorInsightsSpecification` /
 *    `PointInTimeRecoverySpecification` / `KinesisStreamSpecification`) is
 *    out of scope for v1.
 */
export class DynamoDBGlobalTableProvider implements ResourceProvider {
  private dynamoDBClient: DynamoDBClient;
  private logger = getLogger().child('DynamoDBGlobalTableProvider');
  // Cache `getAttribute` calls per (physicalId, attribute) for the duration
  // of one deploy run. `DescribeTable` is cheap but downstream resolvers
  // can issue many lookups for the same Arn / StreamArn.
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
      // We pass the minimum from auto-scaling if set, else fall back to
      // 5 — this is best-effort; full Application Auto Scaling integration
      // is out of MVP scope.
      const writeCapacity = Number(writeAutoScaling?.['MinCapacity'] ?? 5);
      const localReplica = replicas.find((r) => r['Region'] === currentRegion);
      const localReadSettings = localReplica?.['ReadProvisionedThroughputSettings'] as
        | Record<string, unknown>
        | undefined;
      const readAutoScaling = localReadSettings?.['ReadCapacityAutoScalingSettings'] as
        | Record<string, unknown>
        | undefined;
      const readCapacity = Number(readAutoScaling?.['MinCapacity'] ?? 5);
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
      const tableInfo = await this.waitForTableActive(tableName);

      // Replica adds: one UpdateTable per region (AWS rejects multiple
      // ReplicaUpdates in a single call). Each call must complete before
      // the next — UpdateTable returns immediately but the table flips to
      // UPDATING until the replica is provisioned.
      for (const replica of replicas) {
        const region = replica['Region'] as string | undefined;
        if (!region || region === currentRegion) continue;
        await this.addReplica(tableName, replica, region);
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
    region: string
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

    await this.waitForReplicaActive(tableName, region);
  }

  /**
   * Update a DynamoDB Global Table.
   *
   * MVP: in-place updates are out of scope — replica add/remove, GSI
   * add/remove, BillingMode flip, and throughput rewrites each have
   * distinct UpdateTable shapes and ordering rules. `cdkd drift --revert`
   * surfaces this as `ResourceUpdateNotSupportedError` (exit code 2);
   * the user falls back to `cdkd deploy --replace` or destroy + redeploy.
   */
  async update(
    logicalId: string,
    _physicalId: string,
    resourceType: string,
    _properties: Record<string, unknown>,
    _previousProperties: Record<string, unknown>
  ): Promise<ResourceUpdateResult> {
    throw new ResourceUpdateNotSupportedError(
      resourceType,
      logicalId,
      "GlobalTable in-place updates are not yet supported; use 'cdkd deploy --replace' or destroy + redeploy"
    );
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
          await this.waitForTableActiveAfterUpdate(physicalId);
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

    let currentRegion: string | undefined;
    try {
      currentRegion = await this.dynamoDBClient.config.region();
    } catch {
      currentRegion = undefined;
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
          await this.waitForReplicaGone(physicalId, region);
        } catch (replicaErr) {
          // Replica may already be gone; if not, surface the error so
          // the user can intervene rather than masking a real failure.
          if (!(replicaErr instanceof ResourceNotFoundException)) {
            throw replicaErr;
          }
        }
      }
    } catch (describeErr) {
      // Table already gone — region-match check handles idempotency below.
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
    }

    try {
      await this.dynamoDBClient.send(new DeleteTableCommand({ TableName: physicalId }));
      // DeleteTable is async; wait until DescribeTable returns
      // ResourceNotFoundException so siblings / verify steps observing
      // the table after destroy see it actually gone.
      await this.waitForTableGone(physicalId);
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
   * Reverse-maps `DescribeTable` + `ListTagsOfResource` into the
   * `AWS::DynamoDB::GlobalTable` property set.
   *
   * Type-discriminator gating (memory rule
   * `feedback_always_emit_check_type_discriminator.md`):
   *  - `ProvisionedThroughput`-bearing fields are only surfaced when
   *    `BillingMode === 'PROVISIONED'`. Emitting placeholders on
   *    PAY_PER_REQUEST tables (or vice versa) would fire false drift on
   *    every clean run.
   *  - StreamSpecification / SSESpecification follow the existing
   *    DynamoDB::Table provider's Class 1 guard: only surfaced when AWS
   *    reports the feature actually enabled.
   *
   * `getDriftUnknownPaths` declares TTL + write-throughput-settings —
   * those round-trip in the create path but the reverse-mapping is not
   * yet implemented and would fire guaranteed false drift.
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

      // Replicas: always emit `[]` placeholder per PR #145 — a console-side
      // replica add on a previously single-region table must show as drift.
      // Map RegionName → Region (CFn's per-replica shape).
      const replicas = (table.Replicas ?? []).map((r) => ({
        Region: r.RegionName,
        // Per-replica KMSMasterKeyId is the only field we round-trip in
        // v1; ContributorInsightsSpecification /
        // PointInTimeRecoverySpecification / KinesisStreamSpecification
        // are deferred to a follow-up PR.
        ...(r.KMSMasterKeyId !== undefined && { KMSMasterKeyId: r.KMSMasterKeyId }),
      }));
      result['Replicas'] = replicas;

      if (table.TableClassSummary?.TableClass) {
        result['TableClass'] = table.TableClassSummary.TableClass;
      }
      if (table.DeletionProtectionEnabled !== undefined) {
        result['DeletionProtectionEnabled'] = table.DeletionProtectionEnabled;
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
          // Tag fetch failures shouldn't tank the whole drift read.
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
   * State property paths cdkd's GlobalTable readCurrentState cannot (yet)
   * reverse-map. The drift comparator skips these so a templated value
   * doesn't fire guaranteed false drift on every clean run.
   *
   * - `TimeToLiveSpecification`: cdkd's create() applies it via
   *   UpdateTimeToLive, but the reverse-mapping needs a separate
   *   DescribeTimeToLive call (not yet implemented).
   * - `WriteProvisionedThroughputSettings` /
   *   `WriteOnDemandThroughputSettings`: CFn's shapes wrap
   *   auto-scaling / on-demand max-RU settings whose reverse-mapping
   *   from `DescribeTable.ProvisionedThroughput` / `OnDemandThroughput`
   *   is non-trivial and would fire false drift in v1.
   */
  getDriftUnknownPaths(_resourceType: string): string[] {
    return [
      'TimeToLiveSpecification',
      'WriteProvisionedThroughputSettings',
      'WriteOnDemandThroughputSettings',
    ];
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
        throw new Error(`Unexpected table status: ${status}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    throw new Error(`Table ${tableName} did not reach ACTIVE within ${maxAttempts}s`);
  }

  /**
   * Wait for the table to reach ACTIVE after an UpdateTable call. Unlike
   * `waitForTableActive`, this tolerates any non-terminal status — the
   * table may already be ACTIVE on the no-op path (already-disabled
   * protection) or transition through UPDATING.
   */
  private async waitForTableActiveAfterUpdate(tableName: string, maxAttempts = 120): Promise<void> {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const response = await this.dynamoDBClient.send(
        new DescribeTableCommand({ TableName: tableName })
      );
      if (response.Table?.TableStatus === 'ACTIVE') return;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    throw new Error(
      `Table ${tableName} did not reach ACTIVE within ${maxAttempts}s after UpdateTable`
    );
  }

  /**
   * Wait until a specific replica's `ReplicaStatus` flips to ACTIVE.
   * Replica provisioning typically takes 1–5 min; cap at 10 min.
   */
  private async waitForReplicaActive(
    tableName: string,
    region: string,
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
    throw new Error(
      `Replica ${region} for table ${tableName} did not reach ACTIVE within ${maxAttempts}s`
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
    throw new Error(
      `Replica ${region} for table ${tableName} did not disappear within ${maxAttempts}s`
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
  private async waitForTableGone(tableName: string, maxAttempts = 600): Promise<void> {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await this.dynamoDBClient.send(new DescribeTableCommand({ TableName: tableName }));
        await new Promise((resolve) => setTimeout(resolve, 1000));
      } catch (err) {
        if (err instanceof ResourceNotFoundException) return;
        throw err;
      }
    }
    throw new Error(`Table ${tableName} did not disappear within ${maxAttempts}s`);
  }
}
