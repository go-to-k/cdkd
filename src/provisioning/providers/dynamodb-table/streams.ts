import {
  DescribeTableCommand,
  PutResourcePolicyCommand,
  DeleteResourcePolicyCommand,
  TagResourceCommand,
  UntagResourceCommand,
  UpdateContributorInsightsCommand,
  PolicyNotFoundException,
  ResourceNotFoundException,
  type ContributorInsightsAction,
  type ContributorInsightsMode,
} from '@aws-sdk/client-dynamodb';
import { ProvisioningError } from '../../../utils/error-handler.js';
import {
  CONTRIBUTOR_INSIGHTS_KEY,
  type ContributorInsightsOp,
  planContributorInsightsOp,
  planIndexContributorInsightsOps,
  readContributorInsightsSpec,
} from '../../dynamodb-contributor-insights.js';
import { type StreamMemberOp, planStreamMemberOps } from '../../dynamodb-stream-members.js';
import type { SecretMasker } from '../../../types/resource.js';
import type { DynamoDBTableProvider } from '../dynamodb-table-provider.js';

/**
 * Apply `StreamSpecification.ResourcePolicy` / `.Tags` (issue
 * [#3458](https://github.com/go-to-k/cdkd/issues/3458)) against the STREAM
 * arn. Neither is a member of the SDK's `StreamSpecification`, so until this
 * existed both were dropped on `CreateTable` / `UpdateTable`: the deploy was
 * green and the stream had no policy.
 *
 * `streamArn` must be the table's CURRENT `LatestStreamArn` — after a
 * `StreamViewType` change that is the arn the re-enable minted, never the
 * recorded one. What to call, in which order, and the removal / rollback /
 * unreadable-member rules live on {@link planStreamMemberOps}.
 *
 * A plan with calls to make and no arn to make them against — or, when this
 * operation minted the stream, only the `deadStreamArn` read before it —
 * fails LOUDLY: a
 * silent skip would record the policy in state as applied, the next deploy
 * would see no difference, and the grant would stay missing for good.
 *
 * The policy text is never logged: it names principals and can carry a
 * resolved secret in a condition value.
 */
export async function applyStreamMembers(
  this: DynamoDBTableProvider,
  logicalId: string,
  resourceType: string,
  tableName: string,
  streamArn: string | undefined,
  desiredBlock: unknown,
  previousBlock: unknown,
  freshStream: boolean,
  maskSecrets: SecretMasker,
  deadStreamArn?: string,
  contentsUnknown = false
): Promise<void> {
  const warn = (message: string): void => this.logger.warn(maskSecrets(message));
  const debug = (message: string): void => this.logger.debug(maskSecrets(message));
  const ops = planStreamMemberOps(
    desiredBlock,
    previousBlock,
    { freshStream, contentsUnknown },
    (reason) =>
      warn(
        `DynamoDB table ${tableName}: ${reason}, so that member of the stream was left as ` +
          `it is. The value came from a recorded state, which a template edit cannot reach.`
      )
  );
  if (ops.length === 0) return;
  if (streamArn === undefined || streamArn === '' || streamArn === deadStreamArn) {
    throw new ProvisioningError(
      `Cannot apply StreamSpecification.ResourcePolicy / Tags for DynamoDB table ${logicalId}: ` +
        `DescribeTable returned no ${deadStreamArn === undefined ? '' : 'new '}LatestStreamArn`,
      resourceType,
      logicalId,
      tableName
    );
  }
  for (const op of ops) {
    await this.sendStreamMemberOp(streamArn, op, freshStream, maskSecrets);
    debug(`Applied ${op.kind} to the stream of DynamoDB table ${tableName}`);
  }
}

/** Issue ONE {@link StreamMemberOp} against the stream arn. */
export async function sendStreamMemberOp(
  this: DynamoDBTableProvider,
  streamArn: string,
  op: StreamMemberOp,
  freshStream: boolean,
  maskSecrets: SecretMasker
): Promise<void> {
  // The arn embeds the table name, a RESOLVED template value.
  const target = maskSecrets(streamArn);
  // A stream minted a moment ago may not be addressable by these APIs yet;
  // on any OTHER arn a not-found is an answer, not a lag.
  const retryOptions = {
    maskSecrets,
    ...(freshStream
      ? { alsoTransient: (error: unknown) => error instanceof ResourceNotFoundException }
      : {}),
  };
  const send = (call: () => Promise<unknown>, label: string): Promise<unknown> =>
    this.retryOnTransientControlPlane(call, label, undefined, retryOptions);
  switch (op.kind) {
    case 'deletePolicy':
      try {
        await send(
          () =>
            this.dynamoDBClient.send(new DeleteResourcePolicyCommand({ ResourceArn: streamArn })),
          `delete the stream ResourcePolicy of ${target}`
        );
      } catch (error) {
        // No policy left to remove is the goal. A stream that is GONE is not:
        // the untag that follows would fail on it anyway.
        if (!(error instanceof PolicyNotFoundException)) throw error;
      }
      return;
    case 'untag':
      await send(
        () =>
          this.dynamoDBClient.send(
            new UntagResourceCommand({ ResourceArn: streamArn, TagKeys: op.keys })
          ),
        `untag the stream ${target}`
      );
      return;
    case 'tag':
      await send(
        () =>
          this.dynamoDBClient.send(
            new TagResourceCommand({ ResourceArn: streamArn, Tags: op.tags })
          ),
        `tag the stream ${target}`
      );
      return;
    case 'putPolicy':
      await send(
        () =>
          this.dynamoDBClient.send(
            new PutResourcePolicyCommand({ ResourceArn: streamArn, Policy: op.document })
          ),
        `put the stream ResourcePolicy of ${target}`
      );
      return;
  }
}

/**
 * The arn of the stream an enabling `UpdateTable` just minted.
 *
 * The arn that call echoes is believed only when it DIFFERS from the one read
 * before the update: DynamoDB keeps reporting a disabled stream's arn as
 * `LatestStreamArn`, so an echo equal to it (or no echo) is re-read from
 * `DescribeTable` after the ACTIVE wait. Shared by the enable and the
 * view-type arms — a table whose stream was disabled by an earlier deploy is
 * in the same state as one mid view-type change.
 */
export async function resolveMintedStreamArn(
  this: DynamoDBTableProvider,
  tableName: string,
  echoedArn: string | undefined,
  preUpdateArn: string | undefined
): Promise<string | undefined> {
  return echoedArn !== undefined && echoedArn !== preUpdateArn
    ? echoedArn
    : this.describeLatestStreamArn(tableName);
}

/**
 * Fetch the table's current `LatestStreamArn` via DescribeTable. Used as a
 * fallback when an UpdateTable that enabled a stream did not echo the ARN
 * back in its TableDescription, so `Fn::GetAtt [Table, StreamArn]` still
 * resolves after an update-time enable.
 */
export async function describeLatestStreamArn(
  this: DynamoDBTableProvider,
  tableName: string
): Promise<string | undefined> {
  const response = await this.dynamoDBClient.send(
    new DescribeTableCommand({ TableName: tableName })
  );
  return response.Table?.LatestStreamArn;
}

/**
 * Apply the table's `ContributorInsightsSpecification` via the separate
 * `UpdateContributorInsights` API (NOT a field on CreateTable). CFn shape is
 * `{ Enabled: boolean, Mode?: 'ACCESSED_AND_THROTTLED_KEYS' | 'THROTTLED_KEYS' }`.
 *
 * Called from both `create()` (after the table is ACTIVE) and `update()`
 * (only when the value changed). On `update()`-side removal — template drops
 * the block but it was present before — insights is disabled. The block is
 * read by the reader the per-index twin uses
 * ({@link applyIndexContributorInsights}), so the two cannot disagree about
 * one shape: an unreadable block is announced and SKIPPED rather than read as
 * a default (`Boolean('false')` used to ENABLE what the template disabled).
 */
export async function applyContributorInsights(
  this: DynamoDBTableProvider,
  tableName: string,
  spec: unknown,
  previousSpec: unknown,
  maskSecrets: SecretMasker
): Promise<void> {
  const warn = (message: string): void => this.logger.warn(maskSecrets(message));
  const op = planContributorInsightsOp(
    readContributorInsightsSpec(spec, CONTRIBUTOR_INSIGHTS_KEY),
    readContributorInsightsSpec(previousSpec, CONTRIBUTOR_INSIGHTS_KEY),
    (reason) =>
      warn(
        `DynamoDB table ${tableName}: ${reason}, so Contributor Insights was left as it is. ` +
          `Fix the template value and re-deploy.`
      )
  );
  if (op === undefined) return;
  await this.sendContributorInsightsOp(tableName, op, maskSecrets);
}

/**
 * Apply every per-index `ContributorInsightsSpecification`
 * (`GlobalSecondaryIndexes[].ContributorInsightsSpecification`, issue
 * [#1782](https://github.com/go-to-k/cdkd/issues/1782)) — the table-level
 * call with `IndexName` added, one call per index whose block changed.
 *
 * The block is not a member of the SDK's `GlobalSecondaryIndex`, so until
 * this existed it was dropped by the serializer on `CreateTable` and never
 * sent by `applyGsiUpdates`: the deploy was green and the feature was off.
 *
 * `UpdateContributorInsights` answers `ResourceNotFoundException` for an
 * index that is not ACTIVE yet, which {@link retryOnTransientControlPlane}
 * does not retry, so the index wait runs FIRST — and only when there is a
 * call to make, so an ordinary update pays no extra `DescribeTable`.
 * `previousIndexes` is `undefined` on `create()`. Removal and rollback
 * semantics live on {@link planContributorInsightsOp}.
 */
export async function applyIndexContributorInsights(
  this: DynamoDBTableProvider,
  tableName: string,
  desiredIndexes: unknown,
  previousIndexes: unknown,
  maskSecrets: SecretMasker,
  beforeSend: () => void = () => undefined
): Promise<void> {
  const warn = (message: string): void => this.logger.warn(maskSecrets(message));
  const ops = planIndexContributorInsightsOps(
    desiredIndexes,
    previousIndexes,
    (indexName, reason) =>
      warn(
        `${this.indexScopeAt(indexName, tableName, maskSecrets)}: ${reason}, so its ` +
          `Contributor Insights was left as it is. Fix the template value and re-deploy.`
      )
  );
  if (ops.length === 0) return;
  await this.waitForTableAndIndexesActive(tableName, undefined, { maskSecrets });
  for (const op of ops) {
    // go-to-k/cdkd#5487: per-index insights live inside the index entries,
    // so a failure from this call on leaves GlobalSecondaryIndexes unsettled.
    beforeSend();
    await this.sendContributorInsightsOp(tableName, op, maskSecrets);
  }
}

/** Issue ONE `UpdateContributorInsights`, against the table or one index. */
export async function sendContributorInsightsOp(
  this: DynamoDBTableProvider,
  tableName: string,
  op: ContributorInsightsOp,
  maskSecrets: SecretMasker
): Promise<void> {
  const debug = (message: string): void => this.logger.debug(maskSecrets(message));
  const target =
    op.indexName === undefined
      ? `DynamoDB table ${tableName}`
      : this.indexScopeAt(op.indexName, tableName, maskSecrets);
  await this.retryOnTransientControlPlane(
    () =>
      this.dynamoDBClient.send(
        new UpdateContributorInsightsCommand({
          TableName: tableName,
          ...(op.indexName !== undefined ? { IndexName: op.indexName } : {}),
          ContributorInsightsAction: op.action as ContributorInsightsAction,
          ...(op.mode !== undefined
            ? { ContributorInsightsMode: op.mode as ContributorInsightsMode }
            : {}),
        })
      ),
    `set ContributorInsights on ${target}`
  );
  debug(
    `Set ContributorInsightsAction=${op.action}${
      op.mode !== undefined ? ` Mode=${op.mode}` : ''
    } on ${target}`
  );
}
