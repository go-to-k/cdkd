import { timePhase } from '../../../utils/phase-timings.js';
import {
  CreateTableCommand,
  DeleteTableCommand,
  DescribeTableCommand,
  type CreateTableCommandInput,
  type KeySchemaElement,
  type AttributeDefinition,
  type GlobalSecondaryIndex,
  type LocalSecondaryIndex,
  type StreamSpecification,
  type Tag,
} from '@aws-sdk/client-dynamodb';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import { ProvisioningError } from '../../../utils/error-handler.js';
import { markAuxiliaryFailure, markCreatedBeforeFailure } from '../../auxiliary-failure.js';
import { reportCreatedResource, retractCreatedResource } from '../../created-resource-sink.js';
import { generatedNameFor } from '../../resource-name.js';
import { refuseMalformedDesiredTags } from '../../tag-list.js';
import { coerceCfnBoolean, replayWarn, requireConfigString } from '../../config-shape.js';
import {
  contributorInsightsRefusals,
  stripIndexContributorInsights,
} from '../../dynamodb-contributor-insights.js';
import { streamMemberRefusals } from '../../dynamodb-stream-members.js';
import {
  DELETE_INDEX_BUSY_REARM_MAX_ATTEMPTS,
  VECTOR_INDEX_BUSY_REARM_MAX_ATTEMPTS,
  TABLE_DELETE_INDEX_BUSY_MAX_RETRIES,
  DELETE_INDEX_WAIT_PROCEED_NOTE,
  TABLE_INDEX_NOUN,
  deleteTableWithIndexBusyRetry,
  maskedLogger,
  waitForIndexesSettled,
} from '../../dynamodb-index-busy-delete.js';
import {
  DYNAMODB_DELETE_DEADLINE_MARGIN_MS,
  beginDeleteWait,
  resolveDynamoDbDeleteBudgetClock,
  resolveDynamoDbDeleteBudgetMs,
} from '../dynamodb-delete-budget.js';
import { ElapsedBudget } from '../../../utils/elapsed-budget.js';
import { enclosingDeadlineRemainingMs } from '../../../deployment/resource-deadline.js';
import type { ResourceCreateResult, CreateContext, SecretMasker } from '../../../types/resource.js';
import { vectorIndexesForCreate } from '../../dynamodb-vector-indexes.js';
import type { DynamoDBTableProvider } from '../dynamodb-table-provider.js';
import { onDemandCeilingRefusal, tableCapacityForSend } from './capacity.js';
import { deletionProtectionRefusal } from './indexes.js';
import {
  deleteTableRetryDelays,
  mapSSESpecification,
  pointInTimeRecoveryRefusal,
  sseSpecificationRefusal,
} from './table-helpers.js';

/**
 * Create a DynamoDB table
 */
export async function create(
  this: DynamoDBTableProvider,
  logicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  context?: CreateContext
): Promise<ResourceCreateResult> {
  // The caller's secret masker (issue #1932 item 3, adopted here by issue
  // #1997). Read defensively — `create()` is also called by the import path,
  // by the rollback executor's reverse-replacement arm, and by tests, so it
  // must not care which caller it got. The helpers below install their own
  // masked sinks from it rather than each call site masking, so a warning
  // added later is masked by construction.
  const maskSecrets: SecretMasker = context?.maskSecrets ?? ((text) => text);
  // ONE masked sink for this method's OWN lines too (issue #1997). The first
  // cut installed the masker here and threaded it into the helpers but built
  // no sink, so the partial-create rollback warning below printed `tableName`
  // — which is `properties['TableName']` — unmasked. The GlobalTable sibling
  // has carried this sink since the same change.
  const warn = (message: string): void => this.logger.warn(maskSecrets(message));
  const debug = (message: string): void => this.logger.debug(maskSecrets(message));
  this.logger.debug(`Creating DynamoDB table ${logicalId}`);
  // go-to-k/cdkd#3994: a malformed Tags is refused before any call.
  const desiredTags = refuseMalformedDesiredTags(properties['Tags'], resourceType, logicalId);

  const tableName =
    (properties['TableName'] as string | undefined) ||
    generatedNameFor('AWS::DynamoDB::Table', logicalId);
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
  // back a table whose post-create step (PITR, TTL, Kinesis streaming,
  // Contributor Insights, a stream-arn tag or policy) failed —
  // otherwise create() throws before returning the physicalId, the deploy
  // engine never learns the table exists, and it orphans. The same flag
  // marks every failure after it: each is an auxiliary call's or an ACTIVE
  // wait's, never this table's name collision (#3826, #3877).
  let tableCreated = false;
  // go-to-k/cdkd#4606: the `TableId` CreateTable answered with, carried on
  // the created-before-failure mark so the journal needs no read of a table
  // whose failure (a describe that cannot run, say) may fail that read too.
  let createdTableId: string | undefined;

  try {
    // BillingMode (default: PROVISIONED). Guarded per issue #1545 — the
    // `|| 'PROVISIONED'` spelling silently substituted the default for a
    // present-but-unusable value (a `BillingMode: null`, an intrinsic the
    // resolver could not resolve, a hand-authored L1 typo), so a template
    // that says PAY_PER_REQUEST could create a continuously-billed
    // PROVISIONED table with no error anywhere. `BillingMode` is
    // ENUM-valued, so it does NOT take `coerceNumber`: a number here is a
    // template bug, not the unquoted-YAML scalar CFn coerces. The refusal
    // downgrades to a warning on a state replay (`replayWarn`) — the
    // rollback executor's reverse-replacement arm revives the OLD resource
    // from `previousState.properties`, which the user cannot edit from the
    // template. The read sits inside `create()`'s try, so the catch below
    // wraps the refusal into a ProvisioningError.
    const billingMode = requireConfigString(
      properties['BillingMode'],
      'PROVISIONED',
      'AWS::DynamoDB::Table BillingMode',
      replayWarn(this.logger, context)
    );

    // An unreadable `ContributorInsightsSpecification` (table-level or
    // per-index, issue #1782) is refused HERE, before `CreateTable`: a create
    // has no live setting to leave alone, and refusing after the table exists
    // would create it only to delete it again. On a state replay the refusal
    // stands down — the appliers below then warn and skip the block — since
    // the user cannot edit a state record from the template. The index NAME
    // stays out of the thrown text for the reason
    // `INDEX_CONTRIBUTOR_INSIGHTS_PATH` gives; the position names the entry.
    if (context?.replayingState !== true) {
      const [refusal] = contributorInsightsRefusals(
        properties['ContributorInsightsSpecification'],
        properties['GlobalSecondaryIndexes']
      );
      if (refusal !== undefined) {
        throw new Error(`${refusal}. Fix the template value`);
      }
      // `StreamSpecification.ResourcePolicy` / `.Tags` (issue #3458), for
      // the same reason and under the same replay stand-down.
      const [streamRefusal] = streamMemberRefusals(properties['StreamSpecification']);
      if (streamRefusal !== undefined) {
        throw new Error(`${streamRefusal}. Fix the template value`);
      }
      // `PointInTimeRecoverySpecification.RecoveryPeriodInDays` (issue
      // #3255), for the same reason and under the same replay stand-down:
      // a replayed record keeps `applyPointInTimeRecovery`'s warn-and-drop.
      const pitrRefusal = pointInTimeRecoveryRefusal(
        properties['PointInTimeRecoverySpecification']
      );
      if (pitrRefusal !== undefined) {
        throw new Error(`${pitrRefusal}. Fix the template value`);
      }
      // An `OnDemandThroughput` ceiling member CloudFormation rejects (issue
      // #3286), table-level and per index, for the same reason and under the
      // same replay stand-down: a replayed record keeps the send path's
      // warn-and-drop.
      const ceilingRefusal = onDemandCeilingRefusal(properties, undefined, logicalId);
      if (ceilingRefusal !== undefined) {
        throw new Error(`${ceilingRefusal}. Nothing was applied; fix the template value`);
      }
    }

    const createParams: CreateTableCommandInput = {
      TableName: tableName,
      KeySchema: keySchema,
      AttributeDefinitions: attributeDefinitions,
      BillingMode: billingMode as 'PROVISIONED' | 'PAY_PER_REQUEST',
    };

    // Provisioned throughput (required when BillingMode is PROVISIONED).
    //
    // Read through {@link tableCapacityForSend} since issue #3147: an ABSENT
    // member still takes the 5 default, while a DECLARED one CloudFormation
    // would reject (`" 7 "`, `"0x9"`, `"1e1"`, `"6.5"`, `""`) is announced
    // and OMITTED rather than forwarded as `Number()`'s reading — that
    // reading deployed a table at a capacity CloudFormation refuses the
    // template for.
    if (billingMode === 'PROVISIONED') {
      const pt = properties['ProvisionedThroughput'] as Record<string, unknown> | undefined;
      const onUnusable = (member: string, raw: unknown): void =>
        this.warnUnusableProvisionedCapacity(
          `AWS::DynamoDB::Table ${logicalId}`,
          member,
          raw,
          maskSecrets
        );
      createParams.ProvisionedThroughput = {
        ReadCapacityUnits: tableCapacityForSend(pt, 'ReadCapacityUnits', onUnusable),
        WriteCapacityUnits: tableCapacityForSend(pt, 'WriteCapacityUnits', onUnusable),
      };
    }

    // On-demand throughput caps (PAY_PER_REQUEST tables). Rides directly
    // on CreateTable — unlike PITR / TTL it is NOT a post-ACTIVE control-
    // plane call. AWS validates the PAY_PER_REQUEST-only constraint.
    //
    // COERCED, not forwarded verbatim (issue #3265): both members are `Long`
    // in the SDK model, so a CFn-legal `MaxReadRequestUnits: '100'` used to
    // reach AWS as a STRING and fail the create, while a `' 100 '` / `'0x64'`
    // CloudFormation refuses the template for was forwarded unchanged.
    if (properties['OnDemandThroughput']) {
      createParams.OnDemandThroughput = this.coerceOnDemandCeilingsForSend(
        `AWS::DynamoDB::Table ${logicalId}`,
        properties['OnDemandThroughput'],
        maskSecrets
      );
    }

    // Warm throughput — pre-warmed read/write capacity. Like
    // OnDemandThroughput it rides directly on CreateTable (the
    // WarmThroughput input field), NOT a post-ACTIVE control-plane call.
    // Works with BOTH PROVISIONED and PAY_PER_REQUEST billing modes. The send
    // rule lives in `isSendableWarmThroughput` so the drift side cannot
    // answer "declared" for a value this line skips (issue #1760), and the
    // value is COERCED rather than forwarded verbatim so a template's quoted
    // `'12000'` reaches AWS as a number (PR review round 5).
    const createWarmThroughput = this.coerceWarmThroughputForSend(
      `AWS::DynamoDB::Table ${logicalId}`,
      properties['WarmThroughput'],
      maskSecrets
    );
    if (createWarmThroughput) {
      createParams.WarmThroughput = createWarmThroughput;
    } else {
      this.warnRefusedWarmThroughput(
        `AWS::DynamoDB::Table ${logicalId}`,
        properties['WarmThroughput'],
        maskSecrets
      );
    }

    // Stream specification - CDK omits StreamEnabled, SDK requires it.
    // The block is REBUILT from its one SDK member rather than forwarded, so
    // its `ResourcePolicy` / `Tags` (issue #3458), which are not
    // `CreateTable` members, never reach the serializer: they are applied
    // against the stream arn after the ACTIVE wait below.
    if (properties['StreamSpecification']) {
      const streamSpec = properties['StreamSpecification'] as Record<string, unknown>;
      createParams.StreamSpecification = {
        StreamEnabled: true,
        StreamViewType: streamSpec['StreamViewType'] as string,
      } as StreamSpecification;
    }

    // Global secondary indexes. The array is forwarded as-is EXCEPT for each
    // entry's two THROUGHPUT blocks, both coerced by the same readers their
    // update-side siblings use:
    //
    //  - `WarmThroughput`, through `coerceWarmThroughputForSend` (PR review
    //    round 6). This was the FIFTH send site of that value and it was
    //    missed: a per-index `{ReadUnitsPerSecond: '12000'}` reached
    //    `CreateTable` as the STRING `"12000"` in a Long field, and
    //    `WarmThroughput: {}` as an empty block, both silently — so one
    //    template SUCCEEDED when the index was added by a later update and
    //    FAILED on a fresh create.
    //  - `ProvisionedThroughput`, through `readCapacityNumber` (issue #3255).
    //    The same divergence, one property over and one round later: the
    //    BillingMode flip's per-index forwarder moved onto CloudFormation's
    //    Integer grammar in issue #3147 while this forward stayed verbatim,
    //    so a CFn-legal `ReadCapacityUnits: '7'` went out as a STRING in a
    //    `number` field and a `' 7 '` CloudFormation refuses the template for
    //    went out too. Neither #3147's enumeration nor its sweep could see
    //    this site, because it is a CAST rather than a call.
    //
    // Only `GlobalSecondaryIndexes` is mapped, and that is now a statement
    // about BOTH blocks: CFn's `LocalSecondaryIndex` (like the SDK's)
    // declares neither `WarmThroughput` nor `ProvisionedThroughput` — an LSI
    // shares the table's capacity — so there is nothing to coerce there, and
    // rewriting those entries would be motion without a shape behind it.
    // `AWS::DynamoDB::Table` has no replica blocks at all (those are
    // `AWS::DynamoDB::GlobalTable`'s, with their own forwarders).
    //
    // A non-array value is passed through untouched rather than mapped: an
    // unresolved intrinsic or a mis-nested template value is AWS's to reject
    // by name, which is the pre-existing behavior and the fail-OPEN direction
    // this file takes everywhere.
    if (properties['GlobalSecondaryIndexes']) {
      const declaredGsis = properties['GlobalSecondaryIndexes'];
      createParams.GlobalSecondaryIndexes = Array.isArray(declaredGsis)
        ? (declaredGsis as GlobalSecondaryIndex[]).map((entry) =>
            this.coerceIndexThroughputForCreate(
              logicalId,
              // The per-index `ContributorInsightsSpecification` is NOT a
              // `CreateTable` member (issue #1782): it is applied per index
              // after the ACTIVE wait below, and stripped here so nothing
              // relies on the serializer discarding it.
              stripIndexContributorInsights(entry),
              maskSecrets
            )
          )
        : (declaredGsis as GlobalSecondaryIndex[]);
    }

    // Vector indexes (go-to-k/cdkd#2762) ride on CreateTable, member names
    // shared with CFn, `Dimensions` on the Integer grammar.
    const createVectorIndexes = vectorIndexesForCreate(properties['VectorIndexes']);
    if (createVectorIndexes !== undefined) createParams.VectorIndexes = createVectorIndexes;

    // Local secondary indexes
    if (properties['LocalSecondaryIndexes']) {
      createParams.LocalSecondaryIndexes = properties[
        'LocalSecondaryIndexes'
      ] as LocalSecondaryIndex[];
    }

    // SSE specification. The CFn property uses `SSEEnabled`, but the SDK
    // CreateTable field is `Enabled` — passing the CFn shape verbatim makes
    // the SDK silently ignore the flag, so the table is created with
    // AWS-owned (default) encryption instead of the requested AWS-managed /
    // customer-managed KMS encryption. Map the field name explicitly.
    //
    // An unusable block (`sseSpecificationRefusal`) is refused before
    // `CreateTable`, with the predicate `update()` refuses it by
    // (go-to-k/cdkd#5412): mapped, it reads as `false`. A state replay
    // cannot edit the record from the template, so it warns and creates the
    // table on the AWS owned key rather than send a block AWS may reject —
    // unless the record names a key (`SSEType` / `KMSMasterKeyId`): that
    // table was meant to be on it, so the replay refuses rather than quietly
    // create it without, as `update()` leaves the key alone.
    const sseCreateRefusal = sseSpecificationRefusal(properties['SSESpecification'], logicalId);
    if (sseCreateRefusal !== undefined && context?.replayingState !== true) {
      throw new ProvisioningError(
        `${maskSecrets(sseCreateRefusal)}. Nothing was created; fix the template value`,
        resourceType,
        logicalId
      );
    }
    const recordedSse = properties['SSESpecification'];
    if (
      sseCreateRefusal !== undefined &&
      recordedSse !== null &&
      typeof recordedSse === 'object' &&
      ((recordedSse as Record<string, unknown>)['SSEType'] !== undefined ||
        (recordedSse as Record<string, unknown>)['KMSMasterKeyId'] !== undefined)
    ) {
      throw new ProvisioningError(
        `${maskSecrets(sseCreateRefusal)}, and the record names a key, so the table was not ` +
          `created on the AWS owned key in its place. Nothing was created`,
        resourceType,
        logicalId
      );
    }
    if (sseCreateRefusal !== undefined) {
      warn(`${sseCreateRefusal}, so the table is created on the AWS owned key`);
    }
    const sse =
      sseCreateRefusal === undefined
        ? mapSSESpecification(properties['SSESpecification'])
        : undefined;
    if (sse && Object.keys(sse).length > 0) {
      createParams.SSESpecification = sse;
    }

    // Tags
    if (properties['Tags']) {
      createParams.Tags = desiredTags.map((t): Tag => ({ Key: t.Key, Value: t.Value }));
    }

    // DeletionProtectionEnabled. Read as a CFn boolean (go-to-k/cdkd#5354):
    // a template may spell it `"true"`, which the old `as boolean` cast put
    // on the wire as a string. A value that is no boolean at all is refused
    // before CreateTable rather than sent for AWS to reject.
    if (properties['DeletionProtectionEnabled'] !== undefined) {
      const protectionRefusal = deletionProtectionRefusal(
        properties['DeletionProtectionEnabled'],
        logicalId
      );
      if (protectionRefusal !== undefined) {
        throw new ProvisioningError(
          `${maskSecrets(protectionRefusal)}. Nothing was created; fix the template value`,
          resourceType,
          logicalId
        );
      }
      createParams.DeletionProtectionEnabled = coerceCfnBoolean(
        properties['DeletionProtectionEnabled']
      );
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

    const createOut = await (
      await this.getCreateClient()
    ).send(new CreateTableCommand(createParams));
    tableCreated = true;
    // An absent or empty id is dropped by `markCreatedBeforeFailure`.
    createdTableId = createOut?.TableDescription?.TableId;
    // go-to-k/cdkd#5511: report before the ACTIVE wait.
    reportCreatedResource(logicalId, resourceType, tableName, createdTableId);

    debug(`CreateTable initiated for ${tableName}, waiting for ACTIVE status`);

    // Poll until table is ACTIVE
    // go-to-k/cdkd#5200: inert unless CDKD_PHASE_TIMINGS=1.
    const tableInfo = await timePhase(
      'provider waits',
      'DynamoDB table: wait for ACTIVE',
      () => this.waitForTableActive(tableName, maskSecrets),
      logicalId
    );
    // go-to-k/cdkd#2762: a vector index created WITH the table may still be
    // building when the table reads ACTIVE; wait for it, so the settings
    // applied below and the next deploy's index ops do not meet it mid-build.
    if (createVectorIndexes !== undefined) {
      await timePhase(
        'provider waits',
        'DynamoDB table: wait for vector indexes',
        () =>
          this.waitForTableAndIndexesActive(tableName, undefined, {
            after: 'CreateTable',
            maskSecrets,
          }),
        logicalId
      );
    }

    // PointInTimeRecoverySpecification and TimeToLiveSpecification do NOT
    // ride on CreateTable — both are separate post-ACTIVE API calls
    // (UpdateContinuousBackups / UpdateTimeToLive). AWS rejects them
    // against a still-CREATING table, which is why they run after the
    // wait above.
    await this.applyPointInTimeRecovery(
      tableName,
      properties['PointInTimeRecoverySpecification'],
      undefined,
      maskSecrets
    );
    await this.applyTimeToLive(
      tableName,
      properties['TimeToLiveSpecification'],
      undefined,
      'create',
      { logicalId, resourceType, maskSecrets }
    );

    // KinesisStreamSpecification and ContributorInsightsSpecification are
    // also post-ACTIVE control-plane calls (separate
    // EnableKinesisStreamingDestination / UpdateContributorInsights APIs,
    // NOT fields on CreateTable), so they run after the ACTIVE wait too.
    await this.applyKinesisStreamingDestination(
      tableName,
      properties['KinesisStreamSpecification'],
      undefined,
      maskSecrets
    );
    await this.applyContributorInsights(
      tableName,
      properties['ContributorInsightsSpecification'],
      undefined,
      maskSecrets
    );
    await this.applyIndexContributorInsights(
      tableName,
      properties['GlobalSecondaryIndexes'],
      undefined,
      maskSecrets
    );
    // `StreamSpecification.ResourcePolicy` / `.Tags` (issue #3458) — against
    // the stream `CreateTable` just minted, which holds nothing yet.
    await this.applyStreamMembers(
      logicalId,
      resourceType,
      tableName,
      tableInfo.streamArn,
      properties['StreamSpecification'],
      undefined,
      true,
      maskSecrets
    );

    debug(`Successfully created DynamoDB table ${logicalId}: ${tableName}`);

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
    let tableLeftBehind = false;
    if (tableCreated) {
      try {
        await this.rollBackCreatedTable(logicalId, tableName, maskSecrets);
        retractCreatedResource(logicalId, resourceType, tableName);
        debug(`Rolled back partially-created DynamoDB table ${tableName}`);
      } catch (cleanupError) {
        tableLeftBehind = true;
        // The class at warn, AWS's text at debug (go-to-k/cdkd#2319): a
        // denied DeleteTable names the caller's assumed-role ARN.
        const cleanupFailure = describeAwsFailure(cleanupError);
        const cleanupHead = `Failed to roll back partially-created DynamoDB table ${tableName}: `;
        if (cleanupFailure.redacted) debug(`${cleanupHead}${cleanupFailure.detail}`);
        warn(
          `${cleanupHead}${cleanupFailure.redacted ? cleanupFailure.summary : cleanupFailure.detail}`
        );
      }
      markAuxiliaryFailure(error, logicalId);
    }
    const cause = error instanceof Error ? error : undefined;
    const thrown =
      error instanceof ProvisioningError
        ? error
        : this.wrapCaughtError(
            maskSecrets,
            error,
            (text) =>
              new ProvisioningError(
                `Failed to create DynamoDB table ${logicalId}: ${text}`,
                resourceType,
                logicalId,
                tableName,
                cause
              )
          );
    // go-to-k/cdkd#4583: the rollback DeleteTable failed, so the table this
    // call created is left behind — let `rollback --revert-failed` delete it.
    // With its `TableId` (go-to-k/cdkd#4606), the identity a later settle
    // compares before deleting it by name.
    if (tableLeftBehind) {
      markCreatedBeforeFailure(thrown, logicalId, resourceType, tableName, createdTableId);
    }
    throw thrown;
  }
}

/**
 * `create()`'s rollback `DeleteTable` of a table it created and is about to
 * fail (go-to-k/cdkd#5574), retrying ONLY the index-busy refusal, as
 * `delete()` does: the failure that brought it here can be the create-time
 * vector-index wait giving up while the index is still `CREATING`, and a
 * single refused `DeleteTable` then left the table behind as an orphan.
 *
 * Bounded by what the ENCLOSING per-resource deadline has left, less the
 * delete path's margin, capped at the delete path's own allowance. With no
 * room left (the default 30-minute deadline has already fired once the
 * 1800-poll vector wait times out) the first refusal is terminal, exactly as
 * before: `withResourceDeadline` does not cancel, so a retry loop there would
 * keep deleting behind a run already reported failed. Throws what the last
 * `DeleteTable` threw; the caller reports the table left behind.
 */
export async function rollBackCreatedTable(
  this: DynamoDBTableProvider,
  logicalId: string,
  tableName: string,
  maskSecrets: SecretMasker
): Promise<void> {
  const logger = maskedLogger(this.logger, maskSecrets, tableName);
  const allowanceMs = Math.min(
    resolveDynamoDbDeleteBudgetMs(),
    enclosingDeadlineRemainingMs() - DYNAMODB_DELETE_DEADLINE_MARGIN_MS
  );
  const budget =
    allowanceMs > 0
      ? new ElapsedBudget(allowanceMs, resolveDynamoDbDeleteBudgetClock())
      : undefined;
  await deleteTableWithIndexBusyRetry({
    logicalId,
    physicalId: tableName,
    typeLabel: 'table',
    indexNoun: TABLE_INDEX_NOUN,
    maxRetries: TABLE_DELETE_INDEX_BUSY_MAX_RETRIES,
    logger,
    deleteTable: async () => {
      await this.dynamoDBClient.send(new DeleteTableCommand({ TableName: tableName }));
    },
    reArm: () => {
      // The same long-cap-while-vector-busy re-arm as `delete()`.
      const wait = beginDeleteWait(VECTOR_INDEX_BUSY_REARM_MAX_ATTEMPTS, budget);
      return waitForIndexesSettled({
        tableName,
        logicalId,
        logger,
        describeTable: () =>
          this.dynamoDBClient.send(new DescribeTableCommand({ TableName: tableName })),
        maxAttempts: wait.grantedPolls,
        budgetWait: wait,
        shortCapUnlessVectorBusy: DELETE_INDEX_BUSY_REARM_MAX_ATTEMPTS,
        proceedNote: DELETE_INDEX_WAIT_PROCEED_NOTE,
      });
    },
    shouldKeepRetrying: () => budget !== undefined && !budget.isExhausted(),
    retryWarning: () =>
      `DynamoDB table ${logicalId}: AWS refused the DeleteTable rolling back the ` +
      `partially-created table ${tableName} because ${TABLE_INDEX_NOUN} is still being ` +
      `created, updated or deleted. Waiting for the indexes to settle and retrying (up to ` +
      `${TABLE_DELETE_INDEX_BUSY_MAX_RETRIES} retries in all, within ~` +
      `${Math.max(1, Math.round((budget?.totalMs ?? 0) / 60_000))} minutes).`,
    sleepSeam: deleteTableRetryDelays,
  });
}
