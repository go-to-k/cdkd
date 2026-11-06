import {
  UpdateTableCommand,
  type AttributeDefinition,
  type GlobalSecondaryIndex,
  type StreamSpecification,
  type GlobalSecondaryIndexDescription,
  type TableDescription,
} from '@aws-sdk/client-dynamodb';
import { ProvisioningError } from '../../../utils/error-handler.js';
import { coerceCfnBoolean } from '../../config-shape.js';
import type { UpdateContext, SecretMasker } from '../../../types/resource.js';
import type { VectorIndexPlan } from '../../dynamodb-vector-indexes.js';
import type { DynamoDBTableProvider } from '../dynamodb-table-provider.js';
import { sseSpecificationToSend } from './table-helpers.js';

/**
 * The SSESpecification and DeletionProtectionEnabled `UpdateTable` calls.
 *
 * A verbatim slice of `DynamoDBTableProvider.update()`'s `try` body, in its
 * original position in the sequence: `update()` passes it the locals it reads.
 */
export async function applySseAndDeletionProtectionUpdates(
  this: DynamoDBTableProvider,
  logicalId: string,
  physicalId: string,
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>,
  markUnsettled: (key: string) => void,
  maskSecrets: SecretMasker,
  warn: (message: string) => void,
  debug: (message: string) => void,
  deletionProtectionChanged: boolean,
  sseChanged: boolean,
  sseRefusal: string | undefined,
  table: TableDescription | undefined
): Promise<void> {
  // SSESpecification — rides on its OWN UpdateTable (separate from the
  // billing/throughput call above and the GSI calls below). Fire only when
  // the value changed, and wait for ACTIVE afterwards so the GSI block does
  // not race an UPDATING table. The same SSEEnabled->Enabled mapping the
  // create path needs applies here. A REMOVED block resets the table to the
  // AWS owned key, as CloudFormation does (go-to-k/cdkd#5412, measured:
  // `SSEDescription` absent once the stack update completed);
  // `sseSpecificationToSend` decides it, as the GlobalTable twin's removal
  // arm does (go-to-k/cdkd#5355).
  if (sseRefusal !== undefined) {
    // Only a state-borne caller reaches this: the template path refused
    // the value above. Nothing is sent, since the value cannot say which
    // key the table should be on.
    warn(`${sseRefusal}, so the table's encryption was left as it is`);
  } else if (sseChanged) {
    // A table still switching keys (an earlier deploy's change, or one
    // made outside cdkd) is waited out and read again first: DynamoDB
    // takes one table update at a time, and the decision below reads the
    // live key.
    let liveTable = table;
    const liveSseStatus = table?.SSEDescription?.Status;
    if (
      liveSseStatus === 'UPDATING' ||
      liveSseStatus === 'ENABLING' ||
      liveSseStatus === 'DISABLING'
    ) {
      liveTable = await this.waitForTableSseSettled(physicalId, maskSecrets);
    }
    const sseUpdate = sseSpecificationToSend(
      properties['SSESpecification'],
      previousProperties['SSESpecification'],
      liveTable?.SSEDescription,
      liveTable !== undefined
    );
    if (sseUpdate !== undefined) {
      markUnsettled('SSESpecification');
      await this.dynamoDBClient.send(
        new UpdateTableCommand({ TableName: physicalId, SSESpecification: sseUpdate })
      );
      await this.waitForTableSseSettled(physicalId, maskSecrets);
      debug(
        `Updated SSESpecification on DynamoDB table ${physicalId}` +
          (properties['SSESpecification'] === undefined
            ? ' (removed: reset to the AWS owned key)'
            : '')
      );
    }
  }

  // DeletionProtectionEnabled (go-to-k/cdkd#5354) — its own UpdateTable,
  // like SSE above. Only `create()` used to send it, so turning protection
  // on (or off) deployed green while AWS kept the old setting. A REMOVED
  // value means `false`: CloudFormation turns protection off when the
  // property is dropped (measured us-east-1, 2026-10-26: a stack update
  // removing `DeletionProtectionEnabled: true` left the table at `false`).
  // Nothing is sent when the table already has the desired value (the
  // `DescribeTable` above), e.g. `true` → `"true"`.
  if (deletionProtectionChanged) {
    const rawDeletionProtection = properties['DeletionProtectionEnabled'];
    const desiredDeletionProtection =
      rawDeletionProtection === undefined ? false : coerceCfnBoolean(rawDeletionProtection);
    if (desiredDeletionProtection === undefined) {
      // Only a state-borne caller reaches this: the template path refused
      // the value above.
      warn(
        `AWS::DynamoDB::Table ${logicalId}: DeletionProtectionEnabled is not a boolean, so ` +
          `it was not applied`
      );
    } else if (table?.DeletionProtectionEnabled !== desiredDeletionProtection) {
      markUnsettled('DeletionProtectionEnabled');
      await this.dynamoDBClient.send(
        new UpdateTableCommand({
          TableName: physicalId,
          DeletionProtectionEnabled: desiredDeletionProtection,
        })
      );
      await this.waitForTableActiveAfterUpdate(physicalId);
      debug(
        `Set DeletionProtectionEnabled=${desiredDeletionProtection} on DynamoDB table ${physicalId}`
      );
    }
  }
}

/**
 * The StreamSpecification enable / disable / view-type change. Returns the
 * StreamArn attribute `update()` reports (`latestStreamArn` as this slice left it).
 *
 * A verbatim slice of `DynamoDBTableProvider.update()`'s `try` body, in its
 * original position in the sequence: `update()` passes it the locals it reads.
 */
export async function applyStreamSpecificationUpdate(
  this: DynamoDBTableProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>,
  markUnsettled: (key: string) => void,
  maskSecrets: SecretMasker,
  table: TableDescription | undefined,
  latestStreamArn: string | undefined
): Promise<string | undefined> {
  // StreamSpecification — DynamoDB Streams enable / disable / view-type
  // change, all via UpdateTable's StreamSpecification field (a separate
  // UpdateTable from the billing / SSE calls, mirroring their pattern).
  // It previously had NO update branch, so enabling a stream, changing the
  // StreamViewType, or removing a stream were ALL silently dropped: the
  // deploy reported success while AWS kept the old stream config, and the
  // next diff saw no change (state recorded the new spec), so it could
  // never self-heal (the throw-not-swallow / no-SDK-unwired rule).
  //
  // Three transitions, keyed off whether the spec is present on each side:
  //  - enable  (new present, previous absent): StreamEnabled: true + the
  //    new StreamViewType, then wait ACTIVE and capture LatestStreamArn.
  //  - disable (new absent, previous present): StreamEnabled: false; the
  //    stream ARN is cleared afterwards.
  //  - view-type change (both present, different StreamViewType): AWS
  //    REJECTS a direct StreamViewType switch on an enabled stream, so the
  //    change is applied as disable -> wait ACTIVE -> re-enable with the
  //    new view type -> wait ACTIVE. (DynamoDB also rejects a rapid
  //    disable-then-enable against a still-UPDATING table, so the wait
  //    between the two calls is load-bearing, not just cosmetic.)
  //
  // A block whose desired view type is what the LIVE stream already has
  // keeps its stream (issue #3458): no `UpdateTable` goes out — DynamoDB
  // rejects enabling an enabled stream — and `ResourcePolicy` / `Tags` are
  // reconciled on the arn that stays. That covers a block that differs only
  // in those two members or in a spelled-out `StreamEnabled`, and a re-run
  // after a deploy that enabled the stream and then failed before state
  // recorded it. When the recorded previous side does NOT describe that
  // live stream, what it holds is UNKNOWN — the failed run may have put a
  // policy — so a policy the desired side does not declare is deleted and a
  // declared one is always put (`planStreamMemberOps`, `contentsUnknown`).
  if (
    JSON.stringify(properties['StreamSpecification']) !==
    JSON.stringify(previousProperties['StreamSpecification'])
  ) {
    // go-to-k/cdkd#5487: every call below changes the stream (its view
    // type, its tags or resource policy); a failure from here leaves it
    // unsettled.
    markUnsettled('StreamSpecification');
    const newViewType = this.extractStreamViewType(properties['StreamSpecification']);
    const prevViewType = this.extractStreamViewType(previousProperties['StreamSpecification']);
    const liveStream = table?.StreamSpecification;
    // The arn `DescribeTable` reported BEFORE this update. Once this update
    // mints a stream it is the DEAD one: DynamoDB keeps reporting a disabled
    // stream's arn as the latest.
    const preUpdateStreamArn = table?.LatestStreamArn;
    // True when this update minted the stream the two members go to.
    let mintedStream = false;
    // True when the stream is live but the previous side does not describe
    // it, so what it holds is unknown (NOT "nothing").
    let contentsUnknown = false;

    if (newViewType && prevViewType && newViewType !== prevViewType) {
      // View-type change on an enabled stream: disable, wait, re-enable.
      await this.dynamoDBClient.send(
        new UpdateTableCommand({
          TableName: physicalId,
          StreamSpecification: { StreamEnabled: false } as StreamSpecification,
        })
      );
      await this.waitForTableActiveAfterUpdate(physicalId);
      const reenable = await this.dynamoDBClient.send(
        new UpdateTableCommand({
          TableName: physicalId,
          StreamSpecification: {
            StreamEnabled: true,
            StreamViewType: newViewType,
          } as StreamSpecification,
        })
      );
      await this.waitForTableActiveAfterUpdate(physicalId);
      latestStreamArn = await this.resolveMintedStreamArn(
        physicalId,
        reenable.TableDescription?.LatestStreamArn,
        preUpdateStreamArn
      );
      mintedStream = true;
      this.logger.debug(`Changed StreamViewType on DynamoDB table ${physicalId} to ${newViewType}`);
    } else if (
      newViewType &&
      liveStream?.StreamEnabled === true &&
      liveStream.StreamViewType === newViewType
    ) {
      // The live stream already is the desired one: nothing to send.
      contentsUnknown = prevViewType !== newViewType;
    } else if (newViewType) {
      // Enable a stream (or re-assert with the same/new view type when the
      // previous side had no stream).
      const enable = await this.dynamoDBClient.send(
        new UpdateTableCommand({
          TableName: physicalId,
          StreamSpecification: {
            StreamEnabled: true,
            StreamViewType: newViewType,
          } as StreamSpecification,
        })
      );
      await this.waitForTableActiveAfterUpdate(physicalId);
      latestStreamArn = await this.resolveMintedStreamArn(
        physicalId,
        enable.TableDescription?.LatestStreamArn,
        preUpdateStreamArn
      );
      mintedStream = true;
      this.logger.debug(`Enabled DynamoDB Stream on table ${physicalId} (${newViewType})`);
    } else {
      // Removal (new absent, previous present): disable the stream.
      await this.dynamoDBClient.send(
        new UpdateTableCommand({
          TableName: physicalId,
          StreamSpecification: { StreamEnabled: false } as StreamSpecification,
        })
      );
      await this.waitForTableActiveAfterUpdate(physicalId);
      latestStreamArn = undefined;
      this.logger.debug(`Disabled DynamoDB Stream on table ${physicalId}`);
    }

    // `ResourcePolicy` / `Tags` (issue #3458) go to the CURRENT arn: the
    // one just minted, or the one that stayed. A disabled stream is gone
    // and takes both with it, so no call addresses its dead arn.
    if (newViewType) {
      await this.applyStreamMembers(
        logicalId,
        resourceType,
        physicalId,
        latestStreamArn,
        properties['StreamSpecification'],
        previousProperties['StreamSpecification'],
        mintedStream,
        maskSecrets,
        mintedStream ? preUpdateStreamArn : undefined,
        contentsUnknown
      );
    }
  }

  return latestStreamArn;
}

/**
 * The GlobalSecondaryIndexes / VectorIndexes updates and per-index ContributorInsights.
 *
 * A verbatim slice of `DynamoDBTableProvider.update()`'s `try` body, in its
 * original position in the sequence: `update()` passes it the locals it reads.
 */
export async function applyIndexUpdates(
  this: DynamoDBTableProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>,
  context: UpdateContext | undefined,
  markUnsettled: (key: string) => void,
  maskSecrets: SecretMasker,
  table: TableDescription | undefined,
  vectorIndexPlan: VectorIndexPlan | undefined,
  effectiveBillingMode: 'PROVISIONED' | 'PAY_PER_REQUEST',
  currentLiveIndexNames: Set<string> | undefined,
  currentLiveIndexByName:
    | Map<string, GlobalSecondaryIndexDescription & { IndexName: string }>
    | undefined,
  liveCapacityComparable: boolean,
  gsiHandledByBillingFlip: Set<string>
): Promise<void> {
  // GlobalSecondaryIndexes — add / remove / per-index throughput change via
  // UpdateTable's GlobalSecondaryIndexUpdates. AWS permits only ONE GSI
  // create or delete per UpdateTable and rejects a concurrent update while
  // the table (or another index) is still mutating, so applyGsiUpdates
  // serializes the operations and waits for ACTIVE between each. A GSI
  // create must carry the new index's key AttributeDefinitions in the same
  // call — the full desired AttributeDefinitions array is forwarded.
  //
  // A removal may ALREADY have been applied above, ahead of a BillingMode
  // flip to PROVISIONED (issue #1617); `currentLiveIndexNames` is the
  // post-removal live set, so the Delete arm skips both those names and any
  // index the record still lists that AWS no longer has.
  // go-to-k/cdkd#5503: converging an unsettled GlobalSecondaryIndexes
  // leaves every live index that neither the record nor the template names
  // (`readUnsettled` keeps them off the previous side, so nothing deletes
  // them), as CloudFormation would. Say so: one of them may be an index the
  // failed update itself created, which cdkd cannot tell from another
  // tool's.
  if (
    context?.unsettledProperties?.has('GlobalSecondaryIndexes') === true &&
    currentLiveIndexNames !== undefined
  ) {
    this.warnUndeclaredLiveIndexes(
      physicalId,
      currentLiveIndexNames,
      [previousProperties['GlobalSecondaryIndexes'], properties['GlobalSecondaryIndexes']],
      maskSecrets
    );
  }
  if (
    JSON.stringify(properties['GlobalSecondaryIndexes']) !==
    JSON.stringify(previousProperties['GlobalSecondaryIndexes'])
  ) {
    markUnsettled('GlobalSecondaryIndexes');
    await this.applyGsiUpdates(
      physicalId,
      resourceType,
      logicalId,
      previousProperties['GlobalSecondaryIndexes'] as GlobalSecondaryIndex[] | undefined,
      properties['GlobalSecondaryIndexes'] as GlobalSecondaryIndex[] | undefined,
      properties['AttributeDefinitions'] as AttributeDefinition[] | undefined,
      gsiHandledByBillingFlip,
      currentLiveIndexNames,
      currentLiveIndexByName,
      liveCapacityComparable,
      effectiveBillingMode === 'PAY_PER_REQUEST',
      maskSecrets,
      (indexName) => context?.markAttempted?.('GlobalSecondaryIndexes', [indexName])
    );
  }

  // VectorIndexes (go-to-k/cdkd#2762), planned and refused above. AFTER the
  // GSI ops, each in its own UpdateTable (one vector index add or remove per
  // call), with the table and every index settled before and after.
  if (vectorIndexPlan !== undefined) {
    await this.applyVectorIndexUpdates(
      physicalId,
      vectorIndexPlan,
      properties['AttributeDefinitions'] as AttributeDefinition[] | undefined,
      maskSecrets,
      () => markUnsettled('VectorIndexes'),
      (indexName) => context?.markAttempted?.('VectorIndexes', [indexName])
    );
  }

  // PointInTimeRecoverySpecification — separate UpdateContinuousBackups
  // API. Fire only when the value changed; a removal disables PITR.
  if (
    JSON.stringify(properties['PointInTimeRecoverySpecification']) !==
    JSON.stringify(previousProperties['PointInTimeRecoverySpecification'])
  ) {
    markUnsettled('PointInTimeRecoverySpecification');
    await this.applyPointInTimeRecovery(
      physicalId,
      properties['PointInTimeRecoverySpecification'],
      // On removal (new absent, previous present) explicitly disable.
      previousProperties['PointInTimeRecoverySpecification'],
      maskSecrets
    );
  }

  // TimeToLiveSpecification — separate UpdateTimeToLive API. Fire only
  // when the value changed; a removal disables TTL using the previous
  // AttributeName (AWS requires it to disable).
  if (
    JSON.stringify(properties['TimeToLiveSpecification']) !==
    JSON.stringify(previousProperties['TimeToLiveSpecification'])
  ) {
    this.assertNoActiveTtlAttributeNameChange(
      logicalId,
      resourceType,
      physicalId,
      properties['TimeToLiveSpecification'],
      previousProperties['TimeToLiveSpecification']
    );
    // After the refusal: a refused change sent nothing.
    markUnsettled('TimeToLiveSpecification');
    await this.applyTimeToLive(
      physicalId,
      properties['TimeToLiveSpecification'],
      previousProperties['TimeToLiveSpecification'],
      'update',
      { logicalId, resourceType, maskSecrets }
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
    markUnsettled('ResourcePolicy');
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
    markUnsettled('KinesisStreamSpecification');
    await this.applyKinesisStreamingDestination(
      physicalId,
      properties['KinesisStreamSpecification'],
      previousProperties['KinesisStreamSpecification'],
      maskSecrets
    );
  }

  // ContributorInsightsSpecification — separate UpdateContributorInsights
  // API. Fire only when the value changed; a removal disables insights.
  if (
    JSON.stringify(properties['ContributorInsightsSpecification']) !==
    JSON.stringify(previousProperties['ContributorInsightsSpecification'])
  ) {
    markUnsettled('ContributorInsightsSpecification');
    await this.applyContributorInsights(
      physicalId,
      properties['ContributorInsightsSpecification'],
      previousProperties['ContributorInsightsSpecification'],
      maskSecrets
    );
  }

  // Per-index ContributorInsightsSpecification (issue #1782) — the same
  // API with `IndexName`. AFTER `applyGsiUpdates`, so an index this update
  // adds exists by now; the planner compares each index's block against
  // the recorded previous one, so an unchanged list issues no call.
  await this.applyIndexContributorInsights(
    physicalId,
    properties['GlobalSecondaryIndexes'],
    previousProperties['GlobalSecondaryIndexes'],
    maskSecrets,
    () => markUnsettled('GlobalSecondaryIndexes')
  );
}
