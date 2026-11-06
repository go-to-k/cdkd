import {
  DeleteTableCommand,
  DescribeTableCommand,
  UpdateTableCommand,
  type AttributeDefinition,
  type UpdateTableCommandInput,
} from '@aws-sdk/client-dynamodb';
import {
  WARM_THROUGHPUT_MEMBERS,
  isWarmThroughputDecrease,
  type WarmThroughputSpec,
} from '../../dynamodb-warm-throughput.js';
import { vectorIndexesSettled, type VectorIndexPlan } from '../../dynamodb-vector-indexes.js';
import { startInterruptWatch } from '../../interrupt-watch.js';
import { enclosingDeadlineRemainingMs } from '../../../deployment/resource-deadline.js';
import {
  DELETE_INDEX_BUSY_REARM_MAX_ATTEMPTS,
  GLOBAL_TABLE_DELETE_INDEX_BUSY_MAX_RETRIES,
  DELETE_INDEX_WAIT_PROCEED_NOTE,
  TABLE_INDEX_NOUN,
  VECTOR_INDEX_BUSY_REARM_MAX_ATTEMPTS,
  deleteTableWithIndexBusyRetry,
  maskedLogger,
} from '../../dynamodb-index-busy-delete.js';
import {
  DYNAMODB_DELETE_DEADLINE_MARGIN_MS,
  resolveDynamoDbDeleteBudgetClock,
  resolveDynamoDbDeleteBudgetMs,
} from '../dynamodb-delete-budget.js';
import { ElapsedBudget } from '../../../utils/elapsed-budget.js';
import type { SecretMasker } from '../../../types/resource.js';
import { markAttemptedItems, markUnsettled } from './projection.js';
import { VECTOR_INDEX_SETTLE_ATTEMPTS, deleteTableRetryDelays } from './capacity.js';
import type { ThroughputDiagnostic } from './throughput.js';
import type { DynamoDBGlobalTableProvider } from '../dynamodb-globaltable-provider.js';

/**
 * `create()`'s rollback `DeleteTable` for a table declaring vector indexes
 * (go-to-k/cdkd#2762), retrying ONLY the index-busy refusal: the
 * `AWS::DynamoDB::Table` provider's `rollBackCreatedTable` (go-to-k/cdkd#5574).
 * Bounded by what the enclosing per-resource deadline has left; with no room
 * left the first refusal is terminal, since that deadline does not cancel.
 * Throws what the last `DeleteTable` threw; the caller reports the table left
 * behind.
 */
export async function rollBackCreatedVectorTable(
  this: DynamoDBGlobalTableProvider,
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
    typeLabel: 'GlobalTable',
    indexNoun: TABLE_INDEX_NOUN,
    maxRetries: GLOBAL_TABLE_DELETE_INDEX_BUSY_MAX_RETRIES,
    logger,
    deleteTable: async () => {
      await this.dynamoDBClient.send(new DeleteTableCommand({ TableName: tableName }));
    },
    reArm: () =>
      this.waitForIndexesActive(tableName, logicalId, {
        maxAttempts: VECTOR_INDEX_BUSY_REARM_MAX_ATTEMPTS,
        shortCapUnlessVectorBusy: DELETE_INDEX_BUSY_REARM_MAX_ATTEMPTS,
        proceedNote: DELETE_INDEX_WAIT_PROCEED_NOTE,
        ...(budget !== undefined && { budget }),
        maskSecrets,
      }),
    shouldKeepRetrying: () => budget !== undefined && !budget.isExhausted(),
    retryWarning: () =>
      `DynamoDB GlobalTable ${logicalId}: AWS refused the DeleteTable rolling back the ` +
      `partially-created table ${tableName} because ${TABLE_INDEX_NOUN} is still being ` +
      `created, updated or deleted. Waiting for the indexes to settle and retrying (up to ` +
      `${GLOBAL_TABLE_DELETE_INDEX_BUSY_MAX_RETRIES} retries in all, within ~` +
      `${Math.max(1, Math.round((budget?.totalMs ?? 0) / 60_000))} minutes).`,
    sleepSeam: deleteTableRetryDelays,
  });
}

/**
 * Log a batch of {@link ThroughputDiagnostic}s at WARN, de-duplicated.
 *
 * The translators run over every index on both the create and the update
 * path, so the same malformed block can be reported more than once in one
 * call; a repeated warning reads as repeated damage and is worse than
 * useless. Kept as ONE formatter so the five translation call sites cannot
 * word the same defect differently.
 */
export function reportThroughputDiagnostics(
  this: DynamoDBGlobalTableProvider,
  diagnostics: readonly ThroughputDiagnostic[],
  logicalId: string,
  physicalId: string,
  // The caller's secret masker (issue #1997). Each diagnostic names an index
  // NAME read out of the resolved `GlobalSecondaryIndexes` bag, and its
  // message can quote a declared capacity value. Defaults to IDENTITY.
  maskSecrets: SecretMasker = (text) => text
): void {
  // ONE masked sink (issue #1997): this formatter is the single site the five
  // translation call sites share, so masking here covers every one of them.
  const warn = (message: string): void => this.logger.warn(maskSecrets(message));
  const seen = new Set<string>();
  for (const diagnostic of diagnostics) {
    // The index NAME is a resolved property value, so it is masked raw —
    // reaching `maskSecretsInText`'s WHOLE-VALUE arm at any length — as well
    // as through the sink above.
    const scope = diagnostic.indexName
      ? `GSI '${maskSecrets(diagnostic.indexName)}' on ${physicalId}`
      : physicalId;
    const line = `DynamoDB GlobalTable ${logicalId}: ${scope}: ${diagnostic.message}`;
    if (seen.has(line)) continue;
    seen.add(line);
    warn(line);
  }
}

/**
 * The `WarmThroughput` block to put on ONE `GlobalSecondaryIndexUpdate`, or
 * `undefined` when it must not be sent (issue #1857).
 *
 * ONE helper for all three `UpdateTable` send sites — the billing-flip
 * ride-along, the `added` loop's `Create`, and the `modified` loop's
 * `Update` — because three copies of a decrease guard is three chances to
 * word one differently, and the whole point of {@link isWarmThroughputDecrease}
 * is that the answer does not depend on which site asked.
 *
 * The `desired` argument is already COERCED (`toSdkGlobalSecondaryIndexes`
 * did it), so an unusable block never reaches here at all: it was refused
 * and reported during translation, and arrives as `undefined`. What is left
 * for this helper is the one question translation cannot answer, because it
 * needs live AWS state: would this call LOWER what AWS reports?
 *
 * The refusal is a WARN and a dropped member, not a throw. A decrease is a
 * template that has fallen behind a value AWS grew on its own; failing the
 * deploy over it would block every unrelated change to the same table, and
 * there is no template edit that "fixes" it other than raising a number the
 * user never chose.
 */
export function warmThroughputForSend(
  this: DynamoDBGlobalTableProvider,
  indexName: string,
  desired: WarmThroughputSpec | undefined,
  liveWarmByIndexName: ReadonlyMap<string, WarmThroughputSpec>,
  logicalId: string,
  physicalId: string,
  // The caller's secret masker (issue #1997). The warning below names the
  // DECLARED per-index `WarmThroughput` and the index NAME, both of which come
  // out of the RESOLVED `properties` bag. Defaults to IDENTITY.
  maskSecrets: SecretMasker = (text) => text
): WarmThroughputSpec | undefined {
  // ONE masked sink (issue #1997) — see `update()` for why both layers.
  const warn = (message: string): void => this.logger.warn(maskSecrets(message));
  if (!desired) return undefined;
  const live = liveWarmByIndexName.get(indexName);
  if (!isWarmThroughputDecrease(desired, live)) return desired;
  // Both sides are guaranteed to have at least one numeric member here:
  // `isWarmThroughputDecrease` returns TRUE only when some DECLARED member of
  // `desired` is strictly below a finite counterpart in `live`. An earlier
  // cut appended `|| '(none)'` for an empty render; that arm was
  // unreachable — the guard above answers `false` for every input that could
  // produce it — so it is left off rather than kept as an untestable branch.
  const format = (spec: WarmThroughputSpec | undefined): string =>
    WARM_THROUGHPUT_MEMBERS.filter((m) => spec?.[m] !== undefined)
      .map((m) => `${m}=${spec?.[m]}`)
      .join(', ');
  warn(
    // The index NAME is a resolved property value: masked RAW so it reaches
    // `maskSecretsInText`'s WHOLE-VALUE arm at any length, as well as through
    // the sink above (issue #1997). `format` renders numeric members only, so
    // it carries no plaintext of its own.
    `DynamoDB GlobalTable ${logicalId}: GSI '${maskSecrets(indexName)}' on ${physicalId}: ` +
      `WarmThroughput was NOT sent — the template asks for ${format(desired)} while AWS ` +
      `reports ${format(live)}, and DynamoDB rejects a decrease ` +
      `("decreasing WarmThroughput is not supported"). Warm throughput only rises with a ` +
      `table's traffic, so a template below the live value can never be applied; raise it ` +
      `to at least the live value, or remove it. Every other change to this index is ` +
      `applied normally.`
  );
  return undefined;
}

/**
 * The table-level `WarmThroughput` to send, or `undefined` when none must go
 * out (go-to-k/cdkd#2762): the {@link warmThroughputForSend} rule one level
 * up. A block AWS already reports needs no call; one below it is reported and
 * not sent, because warm throughput only rises with a table's traffic. This
 * differs from CloudFormation, which fails the update ("decreasing
 * WarmThroughput is not supported", measured 2026-11-01), and matches
 * `AWS::DynamoDB::Table`. The `desired` argument is already coerced.
 */
export function tableWarmThroughputForSend(
  this: DynamoDBGlobalTableProvider,
  desired: WarmThroughputSpec | undefined,
  live: WarmThroughputSpec | undefined,
  logicalId: string,
  physicalId: string,
  maskSecrets: SecretMasker
): WarmThroughputSpec | undefined {
  if (!desired) return undefined;
  const declared = WARM_THROUGHPUT_MEMBERS.filter((m) => desired[m] !== undefined);
  if (declared.every((m) => desired[m] === live?.[m])) return undefined;
  if (!isWarmThroughputDecrease(desired, live)) return desired;
  const format = (spec: WarmThroughputSpec | undefined): string =>
    declared.map((m) => `${m}=${spec?.[m]}`).join(', ');
  // `format` renders numeric members only. The name is masked on its own too,
  // for one below the masker's substring floor.
  this.logger.warn(
    maskSecrets(
      `DynamoDB GlobalTable ${logicalId}: table ${maskSecrets(physicalId)}: WarmThroughput was NOT sent — ` +
        `the template asks for ${format(desired)} while AWS reports ${format(live)}, and ` +
        `DynamoDB rejects a decrease. Raise it to at least the live value, or remove it. ` +
        `Every other change to this table is applied normally.`
    )
  );
  return undefined;
}

/**
 * Apply a {@link planVectorIndexUpdates} plan (go-to-k/cdkd#2762): each op in
 * its own `UpdateTable` (AWS takes one vector index add or remove per call),
 * with the table and every index settled before and after. A Create carries
 * the desired `AttributeDefinitions`, as a GSI Create does. A replica follows
 * the deploy region's table (measured, us-east-1 + us-east-2, 2026-11-01), so
 * no region is addressed separately.
 */
export async function applyVectorIndexUpdates(
  this: DynamoDBGlobalTableProvider,
  physicalId: string,
  logicalId: string,
  plan: VectorIndexPlan,
  desiredAttributeDefinitions: AttributeDefinition[] | undefined,
  maskSecrets: SecretMasker
): Promise<void> {
  const scope = (name: unknown): string =>
    `vector index ${typeof name === 'string' ? maskSecrets(name) : '<unnamed>'} on DynamoDB ` +
    `GlobalTable ${maskSecrets(physicalId)}`;
  for (const name of plan.alreadyGone) {
    this.logger.debug(maskSecrets(`${scope(name)} is recorded but not live; skipping its Delete`));
  }
  for (const name of plan.adopted) {
    this.logger.warn(
      maskSecrets(
        `${scope(name)} already exists in AWS with the declared definition but is absent ` +
          `from cdkd's recorded previous state, so its Create is being skipped. This usually ` +
          `means an earlier deploy created the index and then failed before state was written.`
      )
    );
  }
  if (plan.ops.length === 0) return;
  await this.waitForVectorIndexesSettled(physicalId, logicalId, maskSecrets);
  markUnsettled('VectorIndexes');
  for (const op of plan.ops) {
    const input: UpdateTableCommandInput = { TableName: physicalId, VectorIndexUpdates: [op] };
    if (op.Create && desiredAttributeDefinitions) {
      input.AttributeDefinitions = desiredAttributeDefinitions;
    }
    await this.dynamoDBClient.send(new UpdateTableCommand(input));
    if (op.Create?.IndexName !== undefined) {
      markAttemptedItems('VectorIndexes', [op.Create.IndexName]);
    }
    await this.waitForVectorIndexesSettled(physicalId, logicalId, maskSecrets);
    this.logger.debug(
      maskSecrets(
        `${op.Create ? 'created' : 'deleted'} ` +
          scope(op.Create?.IndexName ?? op.Delete?.IndexName)
      )
    );
  }
}

/**
 * Wait until the table and every vector index are settled. An index building
 * or being removed refuses the next index op and a replica add, as a GSI does.
 */
export async function waitForVectorIndexesSettled(
  this: DynamoDBGlobalTableProvider,
  tableName: string,
  logicalId: string,
  maskSecrets: SecretMasker
): Promise<void> {
  const watch = startInterruptWatch(
    maskSecrets(`DynamoDB vector indexes on ${maskSecrets(tableName)}`)
  );
  try {
    for (let attempt = 1; attempt <= VECTOR_INDEX_SETTLE_ATTEMPTS; attempt++) {
      if (watch.isInterrupted()) throw watch.onInterrupted();
      const table = (
        await this.dynamoDBClient.send(new DescribeTableCommand({ TableName: tableName }))
      ).Table;
      if (table?.TableStatus === 'ACTIVE' && vectorIndexesSettled(table.VectorIndexes)) return;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  } finally {
    watch.dispose();
  }
  throw new Error(
    maskSecrets(
      `DynamoDB GlobalTable ${logicalId}: table ${maskSecrets(tableName)} and its vector ` +
        `indexes did not settle within ${VECTOR_INDEX_SETTLE_ATTEMPTS} polls`
    )
  );
}
