import {
  DynamoDBClient,
  CreateTableCommand,
  DeleteTableCommand,
  DescribeTableCommand,
  DescribeContinuousBackupsCommand,
  DescribeContributorInsightsCommand,
  DescribeKinesisStreamingDestinationCommand,
  DescribeTimeToLiveCommand,
  DisableKinesisStreamingDestinationCommand,
  EnableKinesisStreamingDestinationCommand,
  GetResourcePolicyCommand,
  ListTablesCommand,
  ListTagsOfResourceCommand,
  PutResourcePolicyCommand,
  DeleteResourcePolicyCommand,
  TagResourceCommand,
  UntagResourceCommand,
  UpdateContributorInsightsCommand,
  UpdateTableCommand,
  UpdateContinuousBackupsCommand,
  type PointInTimeRecoverySpecification,
  UpdateTimeToLiveCommand,
  ResourceNotFoundException,
  type ContributorInsightsAction,
  type ContributorInsightsMode,
  type CreateTableCommandInput,
  type KeySchemaElement,
  type AttributeDefinition,
  type GlobalSecondaryIndex,
  type LocalSecondaryIndex,
  type StreamSpecification,
  type OnDemandThroughput,
  type WarmThroughput,
  type Tag,
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
 * AWS DynamoDB Table Provider
 *
 * Implements resource provisioning for AWS::DynamoDB::Table using the DynamoDB SDK.
 * WHY: The CC API polls for DynamoDB table creation with exponential backoff
 * (1s->2s->4s->8s->10s), but we can poll DescribeTable directly with shorter
 * intervals, eliminating the CC API intermediary overhead and reducing total
 * wait time.
 */
export class DynamoDBTableProvider implements ResourceProvider {
  private dynamoDBClient: DynamoDBClient;
  private logger = getLogger().child('DynamoDBTableProvider');
  handledProperties = new Map<string, ReadonlySet<string>>([
    [
      'AWS::DynamoDB::Table',
      new Set([
        'TableName',
        'KeySchema',
        'AttributeDefinitions',
        'BillingMode',
        'ProvisionedThroughput',
        'OnDemandThroughput',
        'WarmThroughput',
        'StreamSpecification',
        'GlobalSecondaryIndexes',
        'LocalSecondaryIndexes',
        'SSESpecification',
        'Tags',
        'DeletionProtectionEnabled',
        'TableClass',
        'PointInTimeRecoverySpecification',
        'TimeToLiveSpecification',
        'ResourcePolicy',
        'KinesisStreamSpecification',
        'ContributorInsightsSpecification',
      ]),
    ],
  ]);

  unhandledByDesign = new Map<string, ReadonlyMap<string, string>>([
    [
      'AWS::DynamoDB::Table',
      new Map<string, string>([
        [
          'ImportSourceSpecification',
          'S3 import uses the separate ImportTable API (not CreateTable) and is create-only with no readback; deferred to a dedicated import-from-S3 PR',
        ],
      ]),
    ],
  ]);

  constructor() {
    const awsClients = getAwsClients();
    this.dynamoDBClient = awsClients.dynamoDB;
  }

  /**
   * Create a DynamoDB table
   */
  async create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
  ): Promise<ResourceCreateResult> {
    this.logger.debug(`Creating DynamoDB table ${logicalId}`);

    const tableName =
      (properties['TableName'] as string | undefined) ||
      generateResourceName(logicalId, { maxLength: 255 });
    const keySchema = properties['KeySchema'] as KeySchemaElement[] | undefined;
    const attributeDefinitions = properties['AttributeDefinitions'] as
      | AttributeDefinition[]
      | undefined;

    if (!keySchema) {
      throw new ProvisioningError(
        `KeySchema is required for DynamoDB table ${logicalId}`,
        resourceType,
        logicalId
      );
    }

    if (!attributeDefinitions) {
      throw new ProvisioningError(
        `AttributeDefinitions is required for DynamoDB table ${logicalId}`,
        resourceType,
        logicalId
      );
    }

    // Tracks whether CreateTable succeeded this call, so the catch can roll
    // back a table whose post-ACTIVE config step (PITR / TTL) failed —
    // otherwise create() throws before returning the physicalId, the deploy
    // engine never learns the table exists, and it orphans.
    let tableCreated = false;

    try {
      // BillingMode (default: PROVISIONED)
      const billingMode = (properties['BillingMode'] as string | undefined) || 'PROVISIONED';

      const createParams: CreateTableCommandInput = {
        TableName: tableName,
        KeySchema: keySchema,
        AttributeDefinitions: attributeDefinitions,
        BillingMode: billingMode as 'PROVISIONED' | 'PAY_PER_REQUEST',
      };

      // Provisioned throughput (required when BillingMode is PROVISIONED)
      if (billingMode === 'PROVISIONED') {
        const pt = properties['ProvisionedThroughput'] as Record<string, unknown> | undefined;
        createParams.ProvisionedThroughput = {
          ReadCapacityUnits: Number(pt?.['ReadCapacityUnits'] ?? 5),
          WriteCapacityUnits: Number(pt?.['WriteCapacityUnits'] ?? 5),
        };
      }

      // On-demand throughput caps (PAY_PER_REQUEST tables). Rides directly
      // on CreateTable — unlike PITR / TTL it is NOT a post-ACTIVE control-
      // plane call. Pass it through verbatim when present; AWS validates the
      // PAY_PER_REQUEST-only constraint.
      if (properties['OnDemandThroughput']) {
        createParams.OnDemandThroughput = properties['OnDemandThroughput'] as OnDemandThroughput;
      }

      // Warm throughput — pre-warmed read/write capacity. Like
      // OnDemandThroughput it rides directly on CreateTable (the
      // WarmThroughput input field), NOT a post-ACTIVE control-plane call.
      // Works with BOTH PROVISIONED and PAY_PER_REQUEST billing modes. Pass
      // it through verbatim when present.
      if (properties['WarmThroughput']) {
        createParams.WarmThroughput = properties['WarmThroughput'] as WarmThroughput;
      }

      // Stream specification - CDK omits StreamEnabled, SDK requires it
      if (properties['StreamSpecification']) {
        const streamSpec = properties['StreamSpecification'] as Record<string, unknown>;
        createParams.StreamSpecification = {
          StreamEnabled: true,
          StreamViewType: streamSpec['StreamViewType'] as string,
        } as StreamSpecification;
      }

      // Global secondary indexes
      if (properties['GlobalSecondaryIndexes']) {
        createParams.GlobalSecondaryIndexes = properties[
          'GlobalSecondaryIndexes'
        ] as GlobalSecondaryIndex[];
      }

      // Local secondary indexes
      if (properties['LocalSecondaryIndexes']) {
        createParams.LocalSecondaryIndexes = properties[
          'LocalSecondaryIndexes'
        ] as LocalSecondaryIndex[];
      }

      // SSE specification
      if (properties['SSESpecification']) {
        createParams.SSESpecification = properties[
          'SSESpecification'
        ] as CreateTableCommandInput['SSESpecification'];
      }

      // Tags
      if (properties['Tags']) {
        createParams.Tags = properties['Tags'] as Tag[];
      }

      // DeletionProtectionEnabled
      if (properties['DeletionProtectionEnabled'] !== undefined) {
        createParams.DeletionProtectionEnabled = properties['DeletionProtectionEnabled'] as boolean;
      }

      // Table class
      if (properties['TableClass']) {
        createParams.TableClass = properties['TableClass'] as
          | 'STANDARD'
          | 'STANDARD_INFREQUENT_ACCESS';
      }

      // ResourcePolicy — rides directly on CreateTable. The CFn shape is
      // `{ PolicyDocument: <JSON object> }`, but the SDK CreateTable input
      // takes a JSON STRING in its `ResourcePolicy` field, so serialize the
      // document. (update() uses the separate PutResourcePolicy /
      // DeleteResourcePolicy APIs — those are post-create only.)
      const createResourcePolicyDoc = this.extractResourcePolicyDocument(
        properties['ResourcePolicy']
      );
      if (createResourcePolicyDoc !== undefined) {
        createParams.ResourcePolicy = createResourcePolicyDoc;
      }

      await this.dynamoDBClient.send(new CreateTableCommand(createParams));
      tableCreated = true;

      this.logger.debug(`CreateTable initiated for ${tableName}, waiting for ACTIVE status`);

      // Poll until table is ACTIVE
      const tableInfo = await this.waitForTableActive(tableName);

      // PointInTimeRecoverySpecification and TimeToLiveSpecification do NOT
      // ride on CreateTable — both are separate post-ACTIVE API calls
      // (UpdateContinuousBackups / UpdateTimeToLive). AWS rejects them
      // against a still-CREATING table, which is why they run after the
      // wait above.
      await this.applyPointInTimeRecovery(
        tableName,
        properties['PointInTimeRecoverySpecification']
      );
      await this.applyTimeToLive(tableName, properties['TimeToLiveSpecification']);

      // KinesisStreamSpecification and ContributorInsightsSpecification are
      // also post-ACTIVE control-plane calls (separate
      // EnableKinesisStreamingDestination / UpdateContributorInsights APIs,
      // NOT fields on CreateTable), so they run after the ACTIVE wait too.
      await this.applyKinesisStreamingDestination(
        tableName,
        properties['KinesisStreamSpecification']
      );
      await this.applyContributorInsights(
        tableName,
        properties['ContributorInsightsSpecification']
      );

      this.logger.debug(`Successfully created DynamoDB table ${logicalId}: ${tableName}`);

      return {
        physicalId: tableName,
        attributes: {
          Arn: tableInfo.tableArn,
          TableId: tableInfo.tableId,
          StreamArn: tableInfo.streamArn,
          TableName: tableName,
        },
      };
    } catch (error) {
      // Atomicity: if CreateTable succeeded but a post-ACTIVE step (PITR / TTL)
      // failed, the table exists but create() is about to throw without
      // returning its physicalId — the deploy engine can't roll it back, so
      // best-effort delete it here to avoid an orphan + a "Table already
      // exists" failure on the next deploy attempt.
      if (tableCreated) {
        try {
          await this.dynamoDBClient.send(new DeleteTableCommand({ TableName: tableName }));
          this.logger.debug(`Rolled back partially-created DynamoDB table ${tableName}`);
        } catch (cleanupError) {
          this.logger.warn(
            `Failed to roll back partially-created DynamoDB table ${tableName}: ${
              cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
            }`
          );
        }
      }
      if (error instanceof ProvisioningError) {
        throw error;
      }
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to create DynamoDB table ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        tableName,
        cause
      );
    }
  }

  /**
   * Update a DynamoDB table
   *
   * DynamoDB tables have limited in-place update capabilities.
   * For immutable property changes (KeySchema, etc.), the deployment layer
   * handles replacement via DELETE + CREATE.
   */
  async update(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>
  ): Promise<ResourceUpdateResult> {
    this.logger.debug(`Updating DynamoDB table ${logicalId}: ${physicalId}`);

    try {
      // Get current table description for attributes (also gives us the
      // table ARN we need for tag mutations).
      const response = await this.dynamoDBClient.send(
        new DescribeTableCommand({ TableName: physicalId })
      );

      const table = response.Table;

      // Apply tag diff if changed. DynamoDB's TagResource takes
      // [{ Key, Value }] arrays; UntagResource takes a TagKeys list.
      if (table?.TableArn) {
        await this.applyTagDiff(
          table.TableArn,
          previousProperties['Tags'] as Array<{ Key?: string; Value?: string }> | undefined,
          properties['Tags'] as Array<{ Key?: string; Value?: string }> | undefined
        );
      }

      // OnDemandThroughput — rides on UpdateTable (NOT a separate control-
      // plane API like PITR / TTL). Fire only when the value changed so a
      // no-op update doesn't issue a redundant UpdateTable; AWS validates
      // the PAY_PER_REQUEST-only constraint.
      //
      // Caveat (pre-existing gap, fails loud not silent): a one-shot
      // PROVISIONED -> PAY_PER_REQUEST switch that ALSO adds caps would issue
      // this UpdateTable against a table AWS still considers PROVISIONED and
      // get a clear ValidationException — update() does not yet send a
      // BillingMode change. A future BillingMode-update wiring closes it.
      if (
        JSON.stringify(properties['OnDemandThroughput']) !==
        JSON.stringify(previousProperties['OnDemandThroughput'])
      ) {
        if (properties['OnDemandThroughput']) {
          await this.dynamoDBClient.send(
            new UpdateTableCommand({
              TableName: physicalId,
              OnDemandThroughput: properties['OnDemandThroughput'] as OnDemandThroughput,
            })
          );
          this.logger.debug(`Updated OnDemandThroughput on DynamoDB table ${physicalId}`);
        }
      }

      // WarmThroughput — rides on UpdateTable (NOT a separate control-plane
      // API like PITR / TTL). Fire only when the value changed so a no-op
      // update doesn't issue a redundant UpdateTable. A pure removal (new
      // absent, previous present) is a deliberate no-op — CFn has no clean
      // "drop warm throughput" mapping and AWS keeps the last-set value, so
      // there is no spec to send.
      if (
        JSON.stringify(properties['WarmThroughput']) !==
        JSON.stringify(previousProperties['WarmThroughput'])
      ) {
        if (properties['WarmThroughput']) {
          await this.dynamoDBClient.send(
            new UpdateTableCommand({
              TableName: physicalId,
              WarmThroughput: properties['WarmThroughput'] as WarmThroughput,
            })
          );
          this.logger.debug(`Updated WarmThroughput on DynamoDB table ${physicalId}`);
        }
      }

      // PointInTimeRecoverySpecification — separate UpdateContinuousBackups
      // API. Fire only when the value changed; a removal disables PITR.
      if (
        JSON.stringify(properties['PointInTimeRecoverySpecification']) !==
        JSON.stringify(previousProperties['PointInTimeRecoverySpecification'])
      ) {
        await this.applyPointInTimeRecovery(
          physicalId,
          properties['PointInTimeRecoverySpecification'],
          // On removal (new absent, previous present) explicitly disable.
          previousProperties['PointInTimeRecoverySpecification']
        );
      }

      // TimeToLiveSpecification — separate UpdateTimeToLive API. Fire only
      // when the value changed; a removal disables TTL using the previous
      // AttributeName (AWS requires it to disable).
      if (
        JSON.stringify(properties['TimeToLiveSpecification']) !==
        JSON.stringify(previousProperties['TimeToLiveSpecification'])
      ) {
        await this.applyTimeToLive(
          physicalId,
          properties['TimeToLiveSpecification'],
          previousProperties['TimeToLiveSpecification']
        );
      }

      // ResourcePolicy — separate PutResourcePolicy / DeleteResourcePolicy
      // APIs (the CreateTable `ResourcePolicy` field is create-only). Fire
      // only when the value changed; a removal deletes the policy. Needs the
      // table ARN, which the DescribeTable above gave us. Fail loud when a
      // change is detected but the ARN is missing (transient/partial
      // DescribeTable response) — a silent skip would write the new policy
      // into state as if applied, so the next deploy sees no diff and the
      // policy stays permanently stale (the throw-not-swallow rule).
      if (
        JSON.stringify(properties['ResourcePolicy']) !==
        JSON.stringify(previousProperties['ResourcePolicy'])
      ) {
        if (!table?.TableArn) {
          throw new ProvisioningError(
            `Cannot apply ResourcePolicy change for DynamoDB table ${logicalId}: DescribeTable returned no TableArn`,
            resourceType,
            logicalId,
            physicalId
          );
        }
        await this.applyResourcePolicy(
          table.TableArn,
          properties['ResourcePolicy'],
          previousProperties['ResourcePolicy']
        );
      }

      // KinesisStreamSpecification — separate Enable/Disable/Update
      // KinesisStreamingDestination APIs. Fire only when the value changed; a
      // removal disables streaming to the previous stream ARN.
      if (
        JSON.stringify(properties['KinesisStreamSpecification']) !==
        JSON.stringify(previousProperties['KinesisStreamSpecification'])
      ) {
        await this.applyKinesisStreamingDestination(
          physicalId,
          properties['KinesisStreamSpecification'],
          previousProperties['KinesisStreamSpecification']
        );
      }

      // ContributorInsightsSpecification — separate UpdateContributorInsights
      // API. Fire only when the value changed; a removal disables insights.
      if (
        JSON.stringify(properties['ContributorInsightsSpecification']) !==
        JSON.stringify(previousProperties['ContributorInsightsSpecification'])
      ) {
        await this.applyContributorInsights(
          physicalId,
          properties['ContributorInsightsSpecification'],
          previousProperties['ContributorInsightsSpecification']
        );
      }

      return {
        physicalId,
        wasReplaced: false,
        attributes: {
          Arn: table?.TableArn,
          TableId: table?.TableId,
          StreamArn: table?.LatestStreamArn,
          TableName: physicalId,
        },
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to update DynamoDB table ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  /**
   * Delete a DynamoDB table
   */
  async delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    _properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void> {
    this.logger.debug(`Deleting DynamoDB table ${logicalId}: ${physicalId}`);

    // `--remove-protection`: flip DeletionProtectionEnabled off before
    // delete. UpdateTable is async — wait for ACTIVE before issuing
    // DeleteTable so the delete doesn't race the still-UPDATING table.
    // Idempotent — DynamoDB accepts the call when protection is already
    // disabled. Non-fatal: log at debug if the flip-off itself errors
    // (NotFound / similar) so the delete still proceeds.
    if (context?.removeProtection === true) {
      try {
        await this.dynamoDBClient.send(
          new UpdateTableCommand({
            TableName: physicalId,
            DeletionProtectionEnabled: false,
          })
        );
        this.logger.debug(
          `Disabled DeletionProtectionEnabled on DynamoDB table ${logicalId}, waiting for ACTIVE`
        );
        try {
          await this.waitForTableActiveAfterUpdate(physicalId);
        } catch (waitErr) {
          this.logger.debug(
            `Could not wait for table ${physicalId} ACTIVE after disabling protection: ${waitErr instanceof Error ? waitErr.message : String(waitErr)}`
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

    try {
      await this.dynamoDBClient.send(new DeleteTableCommand({ TableName: physicalId }));
      this.logger.debug(`Successfully deleted DynamoDB table ${logicalId}`);
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
        this.logger.debug(`DynamoDB table ${physicalId} does not exist, skipping deletion`);
        return;
      }
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to delete DynamoDB table ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
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
      this.logger.debug(`Removed ${tagsToRemove.length} tag(s) from DynamoDB table ${tableArn}`);
    }
    if (tagsToAdd.length > 0) {
      await this.dynamoDBClient.send(
        new TagResourceCommand({ ResourceArn: tableArn, Tags: tagsToAdd })
      );
      this.logger.debug(`Added/updated ${tagsToAdd.length} tag(s) on DynamoDB table ${tableArn}`);
    }
  }

  /**
   * Apply the table's `PointInTimeRecoverySpecification` via the separate
   * `UpdateContinuousBackups` API (PITR does NOT ride on CreateTable).
   *
   * CFn shape is `{ PointInTimeRecoveryEnabled: boolean, RecoveryPeriodInDays?: number }`.
   * Called from both `create()` (after the table is ACTIVE) and `update()`
   * (only when the value changed). On `update()`-side removal — when the
   * template drops the block but it was present before — we explicitly
   * disable PITR (`UpdateContinuousBackups` treats an absent spec as "no
   * change", so a dropped block must be turned into an explicit
   * `PointInTimeRecoveryEnabled: false`).
   */
  private async applyPointInTimeRecovery(
    tableName: string,
    spec: unknown,
    previousSpec?: unknown
  ): Promise<void> {
    let enabled: boolean | undefined;
    let recoveryPeriodInDays: number | undefined;
    if (spec !== undefined && spec !== null) {
      const s = spec as Record<string, unknown>;
      enabled = Boolean(s['PointInTimeRecoveryEnabled']);
      // RecoveryPeriodInDays only applies when PITR is enabled; AWS rejects it
      // alongside PointInTimeRecoveryEnabled: false.
      if (enabled && s['RecoveryPeriodInDays'] !== undefined) {
        recoveryPeriodInDays = Number(s['RecoveryPeriodInDays']);
      }
    } else if (previousSpec !== undefined && previousSpec !== null) {
      // Removed from the template: disable.
      enabled = false;
    }

    if (enabled === undefined) return;

    const pitrSpec: PointInTimeRecoverySpecification = { PointInTimeRecoveryEnabled: enabled };
    if (recoveryPeriodInDays !== undefined) {
      pitrSpec.RecoveryPeriodInDays = recoveryPeriodInDays;
    }

    await this.retryOnTransientControlPlane(
      () =>
        this.dynamoDBClient.send(
          new UpdateContinuousBackupsCommand({
            TableName: tableName,
            PointInTimeRecoverySpecification: pitrSpec,
          })
        ),
      `enable PITR on ${tableName}`
    );
    this.logger.debug(
      `Set PointInTimeRecoveryEnabled=${enabled}${
        recoveryPeriodInDays !== undefined ? ` RecoveryPeriodInDays=${recoveryPeriodInDays}` : ''
      } on DynamoDB table ${tableName}`
    );
  }

  /**
   * Retry a DynamoDB control-plane call on the transient "settling" errors AWS
   * returns when two table-modifying operations land back-to-back. Enabling
   * PITR (`UpdateContinuousBackups`) puts the table in a transient state, and a
   * subsequent `UpdateTimeToLive` is then rejected with "Backups are being
   * enabled for the table ... Please retry later". `ResourceInUseException`
   * ("table is being updated") and `LimitExceededException` are the same class.
   * Backoff: ~2s,4s,8s,16s,30s,30s... bounded to ~2min total, which comfortably
   * covers the few-second PITR-enable window.
   */
  private async retryOnTransientControlPlane<T>(
    op: () => Promise<T>,
    label: string,
    maxAttempts = 8
  ): Promise<T> {
    let delayMs = 2000;
    for (let attempt = 1; ; attempt++) {
      try {
        return await op();
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        const name = error instanceof Error ? error.name : '';
        const transient =
          /being enabled|being updated|please retry later|backups are being/i.test(msg) ||
          name === 'ResourceInUseException' ||
          name === 'LimitExceededException';
        if (!transient || attempt >= maxAttempts) throw error;
        this.logger.debug(
          `Transient error on "${label}" (attempt ${attempt}/${maxAttempts}): ${msg} — retrying in ${delayMs}ms`
        );
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        delayMs = Math.min(delayMs * 2, 30000);
      }
    }
  }

  /**
   * Apply the table's `TimeToLiveSpecification` via the separate
   * `UpdateTimeToLive` API (TTL does NOT ride on CreateTable).
   *
   * CFn shape is `{ AttributeName: string, Enabled: boolean }`. Called from
   * both `create()` (after the table is ACTIVE) and `update()` (only when the
   * value changed). On `update()`-side removal — when the template drops the
   * block but it was present before — we disable TTL using the PREVIOUS
   * `AttributeName` (AWS requires the attribute name even to disable TTL).
   */
  private async applyTimeToLive(
    tableName: string,
    spec: unknown,
    previousSpec?: unknown
  ): Promise<void> {
    if (spec !== undefined && spec !== null) {
      const s = spec as Record<string, unknown>;
      const attributeName = s['AttributeName'] as string | undefined;
      if (!attributeName) return;
      const enabled = s['Enabled'] !== undefined ? Boolean(s['Enabled']) : true;
      await this.retryOnTransientControlPlane(
        () =>
          this.dynamoDBClient.send(
            new UpdateTimeToLiveCommand({
              TableName: tableName,
              TimeToLiveSpecification: { Enabled: enabled, AttributeName: attributeName },
            })
          ),
        `set TTL on ${tableName}`
      );
      this.logger.debug(
        `Set TimeToLive Enabled=${enabled} AttributeName=${attributeName} on DynamoDB table ${tableName}`
      );
      return;
    }

    // Removed from the template: disable using the previous AttributeName.
    if (previousSpec !== undefined && previousSpec !== null) {
      const prev = previousSpec as Record<string, unknown>;
      const prevAttributeName = prev['AttributeName'] as string | undefined;
      if (!prevAttributeName) return;
      await this.retryOnTransientControlPlane(
        () =>
          this.dynamoDBClient.send(
            new UpdateTimeToLiveCommand({
              TableName: tableName,
              TimeToLiveSpecification: { Enabled: false, AttributeName: prevAttributeName },
            })
          ),
        `disable TTL on ${tableName}`
      );
      this.logger.debug(
        `Disabled TimeToLive (AttributeName=${prevAttributeName}) on DynamoDB table ${tableName}`
      );
    }
  }

  /**
   * Extract the resource-policy document from the CFn `ResourcePolicy`
   * property and serialize it to the JSON string the DynamoDB APIs expect.
   *
   * CFn shape is `{ PolicyDocument: <JSON object | string> }`. Both
   * `CreateTable.ResourcePolicy` and `PutResourcePolicy.Policy` take a JSON
   * STRING, so a document already supplied as a string is passed through
   * verbatim (CDK can emit either an object or, post-intrinsic-resolution, a
   * string). Returns `undefined` when there is no policy document to apply.
   */
  private extractResourcePolicyDocument(spec: unknown): string | undefined {
    if (spec === undefined || spec === null) return undefined;
    const s = spec as Record<string, unknown>;
    const doc = s['PolicyDocument'];
    if (doc === undefined || doc === null) return undefined;
    return typeof doc === 'string' ? doc : JSON.stringify(doc);
  }

  /**
   * Apply the table's `ResourcePolicy` via the separate `PutResourcePolicy` /
   * `DeleteResourcePolicy` APIs (used by `update()` — `create()` rides the
   * policy on CreateTable directly). On removal — when the template drops the
   * block but it was present before — the existing policy is deleted.
   */
  private async applyResourcePolicy(
    tableArn: string,
    spec: unknown,
    previousSpec?: unknown
  ): Promise<void> {
    const policyDoc = this.extractResourcePolicyDocument(spec);
    if (policyDoc !== undefined) {
      // Wrapped in the transient-control-plane retry like the Kinesis /
      // ContributorInsights post-ACTIVE ops: update() runs PITR -> TTL ->
      // ResourcePolicy, and a preceding UpdateContinuousBackups leaves the
      // table settling, so a back-to-back PutResourcePolicy can hit
      // ResourceInUseException / "being updated".
      await this.retryOnTransientControlPlane(
        () =>
          this.dynamoDBClient.send(
            new PutResourcePolicyCommand({ ResourceArn: tableArn, Policy: policyDoc })
          ),
        `put ResourcePolicy on ${tableArn}`
      );
      this.logger.debug(`Put ResourcePolicy on DynamoDB table ${tableArn}`);
      return;
    }

    // Removed from the template: delete the existing policy. NotFound is
    // idempotent success (no policy to remove).
    if (previousSpec !== undefined && previousSpec !== null) {
      try {
        await this.retryOnTransientControlPlane(
          () =>
            this.dynamoDBClient.send(new DeleteResourcePolicyCommand({ ResourceArn: tableArn })),
          `delete ResourcePolicy on ${tableArn}`
        );
        this.logger.debug(`Deleted ResourcePolicy on DynamoDB table ${tableArn}`);
      } catch (error) {
        if (!(error instanceof ResourceNotFoundException)) throw error;
      }
    }
  }

  /**
   * Apply the table's `KinesisStreamSpecification` via the separate
   * Enable/Disable/Update `KinesisStreamingDestination` APIs (NOT a field on
   * CreateTable). CFn shape is
   * `{ StreamArn: string, ApproximateCreationDateTimePrecision?: 'MICROSECOND' | 'MILLISECOND' }`.
   *
   * Called from both `create()` (after the table is ACTIVE) and `update()`
   * (only when the value changed). On `update()`-side removal — template drops
   * the block but it was present before — streaming is disabled to the PREVIOUS
   * stream ARN. A same-ARN change of only the precision is a deliberate no-op
   * (re-enabling against an already-enabled stream errors), matching the
   * pre-existing WarmThroughput "no clean remap" stance; precision changes flow
   * through on the create / first-enable path.
   */
  private async applyKinesisStreamingDestination(
    tableName: string,
    spec: unknown,
    previousSpec?: unknown
  ): Promise<void> {
    const newArn = this.extractKinesisStreamArn(spec);
    const prevArn = this.extractKinesisStreamArn(previousSpec);

    // No change in target stream ARN: nothing to do (enable is not idempotent
    // against an already-enabled destination). A same-ARN change of ONLY the
    // precision is a deliberate no-op — but warn so the user knows the
    // precision edit did not reach AWS (UpdateKinesisStreamingDestination
    // could carry it, but re-enabling against an already-enabled stream
    // errors; deferred to a dedicated precision-update path).
    if (newArn === prevArn) {
      if (
        newArn &&
        JSON.stringify(
          (spec as Record<string, unknown> | undefined)?.['ApproximateCreationDateTimePrecision']
        ) !==
          JSON.stringify(
            (previousSpec as Record<string, unknown> | undefined)?.[
              'ApproximateCreationDateTimePrecision'
            ]
          )
      ) {
        this.logger.warn(
          `Kinesis streaming ApproximateCreationDateTimePrecision change on ${tableName} was not applied (same stream ARN; precision-only updates are not yet supported)`
        );
      }
      return;
    }

    // Disable streaming to the previous stream when it changed or was removed.
    if (prevArn) {
      await this.retryOnTransientControlPlane(
        () =>
          this.dynamoDBClient.send(
            new DisableKinesisStreamingDestinationCommand({
              TableName: tableName,
              StreamArn: prevArn,
            })
          ),
        `disable Kinesis streaming on ${tableName}`
      );
      this.logger.debug(
        `Disabled Kinesis streaming destination ${prevArn} on DynamoDB table ${tableName}`
      );
    }

    // Enable streaming to the new stream when present.
    if (newArn) {
      const s = spec as Record<string, unknown>;
      const precision = s['ApproximateCreationDateTimePrecision'] as string | undefined;
      await this.retryOnTransientControlPlane(
        () =>
          this.dynamoDBClient.send(
            new EnableKinesisStreamingDestinationCommand({
              TableName: tableName,
              StreamArn: newArn,
              ...(precision
                ? {
                    EnableKinesisStreamingConfiguration: {
                      ApproximateCreationDateTimePrecision: precision as
                        | 'MICROSECOND'
                        | 'MILLISECOND',
                    },
                  }
                : {}),
            })
          ),
        `enable Kinesis streaming on ${tableName}`
      );
      this.logger.debug(
        `Enabled Kinesis streaming destination ${newArn} on DynamoDB table ${tableName}`
      );
    }
  }

  private extractKinesisStreamArn(spec: unknown): string | undefined {
    if (spec === undefined || spec === null) return undefined;
    const arn = (spec as Record<string, unknown>)['StreamArn'];
    return typeof arn === 'string' ? arn : undefined;
  }

  /**
   * Apply the table's `ContributorInsightsSpecification` via the separate
   * `UpdateContributorInsights` API (NOT a field on CreateTable). CFn shape is
   * `{ Enabled: boolean, Mode?: 'ACCESSED_AND_THROTTLED_KEYS' | 'THROTTLED_KEYS' }`.
   *
   * Called from both `create()` (after the table is ACTIVE) and `update()`
   * (only when the value changed). On `update()`-side removal — template drops
   * the block but it was present before — insights is disabled.
   */
  private async applyContributorInsights(
    tableName: string,
    spec: unknown,
    previousSpec?: unknown
  ): Promise<void> {
    let action: ContributorInsightsAction | undefined;
    let mode: ContributorInsightsMode | undefined;
    if (spec !== undefined && spec !== null) {
      const s = spec as Record<string, unknown>;
      const enabled = Boolean(s['Enabled']);
      action = enabled ? 'ENABLE' : 'DISABLE';
      // Mode only applies while enabling; AWS rejects it alongside DISABLE.
      if (enabled && s['Mode'] !== undefined) {
        mode = s['Mode'] as ContributorInsightsMode;
      }
    } else if (previousSpec !== undefined && previousSpec !== null) {
      // Removed from the template: disable.
      action = 'DISABLE';
    }

    if (action === undefined) return;

    await this.retryOnTransientControlPlane(
      () =>
        this.dynamoDBClient.send(
          new UpdateContributorInsightsCommand({
            TableName: tableName,
            ContributorInsightsAction: action,
            ...(mode ? { ContributorInsightsMode: mode } : {}),
          })
        ),
      `set ContributorInsights on ${tableName}`
    );
    this.logger.debug(
      `Set ContributorInsightsAction=${action}${
        mode !== undefined ? ` Mode=${mode}` : ''
      } on DynamoDB table ${tableName}`
    );
  }

  /**
   * Poll DescribeTable until the table reaches ACTIVE status
   *
   * Uses a tight polling loop (1s intervals) instead of CC API's exponential
   * backoff (1s->2s->4s->8s->10s), reducing total wait time.
   */
  private async waitForTableActive(
    tableName: string,
    maxAttempts = 60
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

      if (status !== 'CREATING') {
        throw new Error(`Unexpected table status: ${status}`);
      }

      // Wait 1 second between polls
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    throw new Error(`Table ${tableName} did not reach ACTIVE status within ${maxAttempts} seconds`);
  }

  /**
   * Poll DescribeTable until the table reaches ACTIVE after an UpdateTable
   * call. Distinct from `waitForTableActive` because `UpdateTable`
   * transitions the table to `UPDATING` (not `CREATING`); a status
   * mismatch should not throw — just keep polling — and the call may
   * also return immediately ACTIVE on the no-op path (already disabled).
   */
  private async waitForTableActiveAfterUpdate(tableName: string, maxAttempts = 60): Promise<void> {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const response = await this.dynamoDBClient.send(
        new DescribeTableCommand({ TableName: tableName })
      );
      const status = response.Table?.TableStatus;
      if (status === 'ACTIVE') {
        return;
      }
      // Sleep between polls; tolerate any non-terminal status (UPDATING,
      // and defensively CREATING / others) — we just wait for ACTIVE.
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    throw new Error(
      `Table ${tableName} did not reach ACTIVE status within ${maxAttempts} seconds after UpdateTable`
    );
  }

  /**
   * Resolve a single `Fn::GetAtt` attribute for an existing DynamoDB table.
   *
   * CloudFormation's `AWS::DynamoDB::Table` exposes `Arn`, `StreamArn`
   * (a.k.a. `LatestStreamArn` in the SDK; CFn returns the latest enabled
   * stream's ARN), and `LatestStreamLabel`. All three are sibling fields on
   * the same `DescribeTable` response, so a single API call covers every
   * supported attr. See:
   * https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-dynamodb-table.html#aws-resource-dynamodb-table-return-values
   *
   * Used by `cdkd orphan` to live-fetch attribute values that need to be
   * substituted into sibling references.
   */
  async getAttribute(
    physicalId: string,
    _resourceType: string,
    attributeName: string
  ): Promise<unknown> {
    try {
      const resp = await this.dynamoDBClient.send(
        new DescribeTableCommand({ TableName: physicalId })
      );
      switch (attributeName) {
        case 'Arn':
          return resp.Table?.TableArn;
        case 'StreamArn':
          return resp.Table?.LatestStreamArn;
        case 'LatestStreamLabel':
          return resp.Table?.LatestStreamLabel;
        default:
          return undefined;
      }
    } catch (err) {
      if (err instanceof ResourceNotFoundException) return undefined;
      throw err;
    }
  }

  /**
   * Read the AWS-current DynamoDB table configuration in CFn-property shape.
   *
   * `DescribeTable` returns every field cdkd manages in one call. AWS uses
   * the same property names CFn does (KeySchema, AttributeDefinitions,
   * BillingModeSummary.BillingMode, ProvisionedThroughput, etc.) — the only
   * shape differences are wrapping:
   *  - BillingMode lives under `BillingModeSummary.BillingMode` in the API
   *    response, but the CFn property is a flat `BillingMode` string.
   *  - StreamSpecification's CFn shape includes only `StreamViewType`; the
   *    API response carries `StreamEnabled` too. We surface both since the
   *    drift comparator only descends into keys present in state.
   *  - GSI / LSI in the API response include `IndexStatus`, `ItemCount` and
   *    sizing fields that cdkd never sets; the comparator filters them.
   *
   * Returns `undefined` when the table is gone (`ResourceNotFoundException`).
   *
   * Tags are surfaced via a follow-up `ListTagsOfResource` call (DynamoDB
   * doesn't include tags in `DescribeTable`). CDK's `aws:*` auto-tags are
   * filtered out by `normalizeAwsTagsToCfn` so they don't fire false-positive
   * drift, and the result key is omitted entirely when AWS reports no user
   * tags (matches `create()`'s behavior of only sending Tags when the
   * template carries them).
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
      if (table.BillingModeSummary?.BillingMode) {
        result['BillingMode'] = table.BillingModeSummary.BillingMode;
      }
      if (table.ProvisionedThroughput) {
        // AWS returns extra read-only fields (LastIncrease/DecreaseDateTime,
        // NumberOfDecreasesToday) — drop them to keep the snapshot tight.
        result['ProvisionedThroughput'] = {
          ReadCapacityUnits: table.ProvisionedThroughput.ReadCapacityUnits,
          WriteCapacityUnits: table.ProvisionedThroughput.WriteCapacityUnits,
        };
      }
      // OnDemandThroughput — DescribeTable returns it only on PAY_PER_REQUEST
      // tables that set capacity caps. Emit-when-present (no default when
      // absent) so a table that never configured caps doesn't grow a
      // placeholder that would round-trip through update() as a spurious
      // UpdateTable.
      if (table.OnDemandThroughput) {
        const odt: Record<string, unknown> = {};
        if (table.OnDemandThroughput.MaxReadRequestUnits !== undefined) {
          odt['MaxReadRequestUnits'] = table.OnDemandThroughput.MaxReadRequestUnits;
        }
        if (table.OnDemandThroughput.MaxWriteRequestUnits !== undefined) {
          odt['MaxWriteRequestUnits'] = table.OnDemandThroughput.MaxWriteRequestUnits;
        }
        if (Object.keys(odt).length > 0) {
          result['OnDemandThroughput'] = odt;
        }
      }
      // WarmThroughput — DescribeTable returns it (as a
      // TableWarmThroughputDescription carrying ReadUnitsPerSecond /
      // WriteUnitsPerSecond / Status) only on tables that set warm
      // throughput. Emit-when-present (no default when absent) and surface
      // ONLY the user-settable sub-fields — Status is AWS-managed — so a
      // table that never configured warm throughput doesn't grow a
      // placeholder that would round-trip through update() as a spurious
      // UpdateTable.
      if (table.WarmThroughput) {
        const wt: Record<string, unknown> = {};
        if (table.WarmThroughput.ReadUnitsPerSecond !== undefined) {
          wt['ReadUnitsPerSecond'] = table.WarmThroughput.ReadUnitsPerSecond;
        }
        if (table.WarmThroughput.WriteUnitsPerSecond !== undefined) {
          wt['WriteUnitsPerSecond'] = table.WarmThroughput.WriteUnitsPerSecond;
        }
        if (Object.keys(wt).length > 0) {
          result['WarmThroughput'] = wt;
        }
      }
      // Class 1 guard: StreamSpecification.StreamViewType is only valid when
      // a stream is enabled. AWS returns the StreamSpecification block on
      // tables that USED TO have a stream (StreamEnabled: false, no
      // StreamViewType) — emitting that placeholder back through a
      // round-trip drift --revert would push a CFn-invalid shape (a
      // StreamSpecification without StreamViewType is rejected). Only
      // surface the block when the stream is actually enabled.
      if (table.StreamSpecification?.StreamEnabled && table.StreamSpecification.StreamViewType) {
        result['StreamSpecification'] = {
          StreamEnabled: true,
          StreamViewType: table.StreamSpecification.StreamViewType,
        };
      }
      // Class 2 guard: GSI / LSI placeholders. AWS omits these blocks when
      // none exist; the previous `?? []` always-emitted an empty array
      // which round-trips through `update()` as an instruction to "remove
      // all GSIs", and on the LSI side LSIs are immutable post-create so
      // the empty-array placeholder is a guaranteed AWS rejection on any
      // future provider.update() that learns to handle the field. Only
      // surface when AWS reports indexes.
      if (table.GlobalSecondaryIndexes && table.GlobalSecondaryIndexes.length > 0) {
        result['GlobalSecondaryIndexes'] = table.GlobalSecondaryIndexes;
      }
      if (table.LocalSecondaryIndexes && table.LocalSecondaryIndexes.length > 0) {
        result['LocalSecondaryIndexes'] = table.LocalSecondaryIndexes;
      }
      // Class 1 guard: CFn's SSESpecification.KMSMasterKeyId / SSEType are
      // only valid when SSEEnabled=true. AWS reports SSEDescription.Status
      // = 'DISABLED' (or omits SSEDescription entirely) on tables without
      // SSE; the previous always-emit `{ SSEEnabled: false }` placeholder
      // round-trips fine when state matches but breaks the moment a
      // future SSE-aware update() learns to read `SSESpecification` —
      // `{ SSEEnabled: false, KMSMasterKeyId: '...' }` is rejected by
      // AWS. Only surface the block when SSE is actually enabled.
      if (table.SSEDescription?.Status === 'ENABLED') {
        const sse: Record<string, unknown> = { SSEEnabled: true };
        if (table.SSEDescription.KMSMasterKeyArn !== undefined) {
          sse['KMSMasterKeyId'] = table.SSEDescription.KMSMasterKeyArn;
        }
        if (table.SSEDescription.SSEType !== undefined) {
          sse['SSEType'] = table.SSEDescription.SSEType;
        }
        result['SSESpecification'] = sse;
      }
      if (table.DeletionProtectionEnabled !== undefined) {
        result['DeletionProtectionEnabled'] = table.DeletionProtectionEnabled;
      }
      if (table.TableClassSummary?.TableClass) {
        result['TableClass'] = table.TableClassSummary.TableClass;
      }

      // Tags via ListTagsOfResource — needs the table ARN we just got back.
      if (table.TableArn) {
        try {
          const tagsResp = await this.dynamoDBClient.send(
            new ListTagsOfResourceCommand({ ResourceArn: table.TableArn })
          );
          const tags = normalizeAwsTagsToCfn(tagsResp.Tags);
          result['Tags'] = tags;
        } catch (err) {
          // Tag fetch failures shouldn't tank the whole drift read; rethrow
          // only on hard "table gone" semantics.
          if (err instanceof ResourceNotFoundException) return undefined;
          throw err;
        }
      }

      // PointInTimeRecoverySpecification — separate DescribeContinuousBackups
      // call (not part of DescribeTable). Emit-when-present: only surface the
      // key when AWS reports a PITR status so a table that never configured
      // PITR doesn't grow a placeholder (keeps the comparator's state-keys-only
      // top-level walk + the "AWS minimum response" key-set test green).
      // Best-effort: a failed read omits the key rather than failing the
      // whole drift read.
      try {
        const pitrResp = await this.dynamoDBClient.send(
          new DescribeContinuousBackupsCommand({ TableName: physicalId })
        );
        const pitrDesc = pitrResp.ContinuousBackupsDescription?.PointInTimeRecoveryDescription;
        const pitrStatus = pitrDesc?.PointInTimeRecoveryStatus;
        if (pitrStatus) {
          const pitr: Record<string, unknown> = {
            PointInTimeRecoveryEnabled: pitrStatus === 'ENABLED',
          };
          // RecoveryPeriodInDays is only meaningful while enabled; surface it
          // emit-when-present so a templated value is drift-comparable.
          if (pitrStatus === 'ENABLED' && pitrDesc?.RecoveryPeriodInDays !== undefined) {
            pitr['RecoveryPeriodInDays'] = pitrDesc.RecoveryPeriodInDays;
          }
          result['PointInTimeRecoverySpecification'] = pitr;
        }
      } catch (err) {
        this.logger.debug(
          `Could not read PointInTimeRecovery for ${physicalId}: ${err instanceof Error ? err.message : String(err)}`
        );
      }

      // TimeToLiveSpecification — separate DescribeTimeToLive call.
      // Race-tolerant: only surface when AWS reports `ENABLED` with an
      // AttributeName. `DISABLED` carries no AttributeName and CFn rejects a
      // TimeToLiveSpecification without one, so we omit it; ENABLING /
      // DISABLING are transient and also omitted so drift doesn't fire on a
      // momentary state.
      try {
        const ttlResp = await this.dynamoDBClient.send(
          new DescribeTimeToLiveCommand({ TableName: physicalId })
        );
        const ttlDesc = ttlResp.TimeToLiveDescription;
        if (ttlDesc?.TimeToLiveStatus === 'ENABLED' && ttlDesc.AttributeName) {
          result['TimeToLiveSpecification'] = {
            AttributeName: ttlDesc.AttributeName,
            Enabled: true,
          };
        }
      } catch (err) {
        this.logger.debug(
          `Could not read TimeToLive for ${physicalId}: ${err instanceof Error ? err.message : String(err)}`
        );
      }

      // ResourcePolicy — separate GetResourcePolicy call. Emit-when-present:
      // only surface the key when AWS reports an attached policy, and re-shape
      // the returned JSON string back into CFn's `{ PolicyDocument: <object> }`
      // form so it is drift-comparable against the templated value. A table
      // with no policy returns ResourceNotFoundException / PolicyNotFound —
      // omit the key rather than fail the whole drift read.
      if (table.TableArn) {
        try {
          const rpResp = await this.dynamoDBClient.send(
            new GetResourcePolicyCommand({ ResourceArn: table.TableArn })
          );
          if (rpResp.Policy) {
            let doc: unknown = rpResp.Policy;
            try {
              doc = JSON.parse(rpResp.Policy);
            } catch {
              // Leave as the raw string if AWS returned a non-JSON body.
            }
            result['ResourcePolicy'] = { PolicyDocument: doc };
          }
        } catch (err) {
          if (!(err instanceof ResourceNotFoundException)) {
            this.logger.debug(
              `Could not read ResourcePolicy for ${physicalId}: ${err instanceof Error ? err.message : String(err)}`
            );
          }
        }
      }

      // KinesisStreamSpecification — separate DescribeKinesisStreamingDestination
      // call. Emit-when-present: only surface the key when AWS reports an ACTIVE
      // or ENABLING destination (DISABLED entries linger in the list, so a
      // status filter avoids a stale placeholder). Surface only the user-set
      // fields (StreamArn + precision) so the drift comparator can match the
      // templated value.
      try {
        const kResp = await this.dynamoDBClient.send(
          new DescribeKinesisStreamingDestinationCommand({ TableName: physicalId })
        );
        const active = (kResp.KinesisDataStreamDestinations ?? []).find(
          (d) => d.DestinationStatus === 'ACTIVE' || d.DestinationStatus === 'ENABLING'
        );
        if (active?.StreamArn) {
          const kspec: Record<string, unknown> = { StreamArn: active.StreamArn };
          if (active.ApproximateCreationDateTimePrecision !== undefined) {
            kspec['ApproximateCreationDateTimePrecision'] =
              active.ApproximateCreationDateTimePrecision;
          }
          result['KinesisStreamSpecification'] = kspec;
        }
      } catch (err) {
        this.logger.debug(
          `Could not read KinesisStreamingDestination for ${physicalId}: ${err instanceof Error ? err.message : String(err)}`
        );
      }

      // ContributorInsightsSpecification — separate DescribeContributorInsights
      // call. Emit-when-present: only surface the key when AWS reports a
      // terminal ENABLED / DISABLED status (ENABLING / DISABLING are transient
      // and omitted so drift doesn't fire on a momentary state). Surface
      // `Mode` only while ENABLED so a disabled table doesn't grow a CFn-invalid
      // placeholder.
      try {
        const ciResp = await this.dynamoDBClient.send(
          new DescribeContributorInsightsCommand({ TableName: physicalId })
        );
        const status = ciResp.ContributorInsightsStatus;
        if (status === 'ENABLED' || status === 'DISABLED') {
          const cspec: Record<string, unknown> = { Enabled: status === 'ENABLED' };
          if (status === 'ENABLED' && ciResp.ContributorInsightsMode !== undefined) {
            cspec['Mode'] = ciResp.ContributorInsightsMode;
          }
          result['ContributorInsightsSpecification'] = cspec;
        }
      } catch (err) {
        this.logger.debug(
          `Could not read ContributorInsights for ${physicalId}: ${err instanceof Error ? err.message : String(err)}`
        );
      }

      return result;
    } catch (err) {
      if (err instanceof ResourceNotFoundException) return undefined;
      throw err;
    }
  }

  /**
   * Adopt an existing DynamoDB table into cdkd state.
   *
   * Lookup order:
   *  1. `--resource` override or `Properties.TableName` → verify via `DescribeTable`.
   *  2. `ListTables` + `ListTagsOfResource`, match `aws:cdk:path` tag.
   *
   * Tags require the table ARN, which `DescribeTable` provides; the loop
   * therefore costs one `DescribeTable` per table just to read the ARN.
   * Acceptable for typical DynamoDB cardinalities.
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
}
