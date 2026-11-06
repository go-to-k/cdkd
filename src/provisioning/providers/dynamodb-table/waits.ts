import { DescribeTableCommand, type TableDescription } from '@aws-sdk/client-dynamodb';
import { INDEX_SETTLE_POLL_INTERVAL_MS } from '../../dynamodb-index-busy-delete.js';
import { beginDeleteWait } from '../dynamodb-delete-budget.js';
import { ElapsedBudget } from '../../../utils/elapsed-budget.js';
import { maskerOrIdentity } from '../../masked-retry-logger.js';
import { startInterruptWatch } from '../../interrupt-watch.js';
import { markNonRetryable } from '../../../deployment/retryable-errors.js';
import { enclosingDeadlineRemainingMs } from '../../../deployment/resource-deadline.js';
import type { SecretMasker } from '../../../types/resource.js';
import { vectorIndexesSettled } from '../../dynamodb-vector-indexes.js';
import type { DynamoDBTableProvider } from '../dynamodb-table-provider.js';
import {
  KINESIS_DESTINATION_SETTLE_POLLS,
  KINESIS_DESTINATION_SETTLE_POLL_MS,
  TABLE_ACTIVE_WAIT_ATTEMPTS,
} from './table-helpers.js';

/**
 * Poll DescribeTable until the table reaches ACTIVE status
 *
 * Uses a tight polling loop (1s intervals) instead of CC API's exponential
 * backoff (1s->2s->4s->8s->10s), reducing total wait time.
 */
export async function waitForTableActive(
  this: DynamoDBTableProvider,
  tableName: string,
  // The caller's masker: the table name is a RESOLVED template value.
  maskSecrets: SecretMasker,
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
    this.logger.debug(
      maskSecrets(`Table ${tableName} status: ${status} (attempt ${attempt}/${maxAttempts})`)
    );

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
 * Poll `DescribeTable` until the table leaves `UPDATING`. Distinct from
 * `waitForTableActive` because `UpdateTable` transitions the table to
 * `UPDATING` (not `CREATING`), so a status mismatch must keep polling
 * rather than throw, and the call may return immediately ACTIVE.
 *
 * The 60-attempt (60s) default was calibrated on capacity / TTL / tag edits,
 * which settle in seconds. A **BillingMode flip does not** — measured
 * 2026-08-11 on the `dynamodb-ondemand` fixture, a PAY_PER_REQUEST ->
 * PROVISIONED flip exceeded 60s and failed the deploy with
 * `did not reach ACTIVE status within 60 seconds`, rolling the whole stack
 * back. It was invisible before issue #1553 because the removal that
 * triggers the flip never produced a valid `UpdateTable` at all; making the
 * call correct is what put a real flip on this path.
 *
 * So the timeout is per-OPERATION rather than global: a flip gets 600s (the
 * same order as the GlobalTable provider's own settle waits), everything
 * else keeps the 60s that has been sufficient for two years of integs. A
 * blanket raise would turn every genuinely wedged capacity edit into a
 * 10-minute hang.
 */
export async function waitForTableActiveAfterUpdate(
  this: DynamoDBTableProvider,
  tableName: string,
  maxAttempts = TABLE_ACTIVE_WAIT_ATTEMPTS,
  budget?: ElapsedBudget
): Promise<void> {
  // Issue #1955: on the DELETE path this wait shares a per-resource deadline
  // with the index-busy retry loop that follows it, so it takes the smaller
  // of its own cap and what the shared budget can still afford. Every
  // CREATE / UPDATE caller passes no budget and keeps the full cap.
  const wait = beginDeleteWait(maxAttempts, budget);
  while (wait.nextPoll()) {
    const response = await this.dynamoDBClient.send(
      new DescribeTableCommand({ TableName: tableName })
    );
    const status = response.Table?.TableStatus;
    if (status === 'ACTIVE') {
      return;
    }
    // Sleep between polls; tolerate any non-terminal status (UPDATING,
    // and defensively CREATING / others) — we just wait for ACTIVE.
    //
    // Reads the SHARED poll interval rather than its own `1000`: the
    // index-busy budget arithmetic prices this wait as `<=60 polls x that
    // interval` when it checks the delete path against the per-resource
    // deadline, so a private copy here would let the two drift while the
    // arithmetic went on claiming they agree.
    await new Promise((resolve) => setTimeout(resolve, INDEX_SETTLE_POLL_INTERVAL_MS));
  }
  throw new Error(
    `Table ${tableName} did not reach ACTIVE status within ${wait.pollsRun} seconds after ` +
      `UpdateTable${wait.note()}`
  );
}

/**
 * After an `SSESpecification` `UpdateTable` (go-to-k/cdkd#5412): poll until
 * the table is `ACTIVE` AND its `SSEDescription` has left `UPDATING` /
 * `ENABLING` / `DISABLING`, so the next `UpdateTable` in the same `update()`
 * does not land on a table still switching keys — the predicate the
 * GlobalTable twin's settle wait uses. The key switch outlives `ACTIVE`, so
 * the cap is the Kinesis settle wait's (10 minutes), interruptible and
 * bounded by the enclosing per-resource deadline. Also run BEFORE the SSE
 * call when the table is already switching keys. Returns the settled
 * description.
 */
export async function waitForTableSseSettled(
  this: DynamoDBTableProvider,
  tableName: string,
  maskSecrets: SecretMasker
): Promise<TableDescription | undefined> {
  const watch = startInterruptWatch(maskSecrets(`DynamoDB table ${tableName} switching keys`));
  let last: string | undefined;
  try {
    for (let poll = 1; poll <= KINESIS_DESTINATION_SETTLE_POLLS; poll++) {
      if (watch.isInterrupted()) throw watch.onInterrupted();
      if (enclosingDeadlineRemainingMs() <= 0) {
        throw markNonRetryable(
          new Error(
            maskSecrets(
              `The resource timeout expired while waiting for DynamoDB table ${tableName} ` +
                `to finish its encryption change (last status: ${last ?? 'none read'})`
            )
          )
        );
      }
      const response = await this.dynamoDBClient.send(
        new DescribeTableCommand({ TableName: tableName })
      );
      const table = response?.Table;
      const sseStatus = table?.SSEDescription?.Status;
      last = `${table?.TableStatus ?? 'unknown'} / SSE ${sseStatus ?? 'absent'}`;
      if (
        table?.TableStatus === 'ACTIVE' &&
        sseStatus !== 'UPDATING' &&
        sseStatus !== 'ENABLING' &&
        sseStatus !== 'DISABLING'
      ) {
        return table;
      }
      if (poll === KINESIS_DESTINATION_SETTLE_POLLS) break;
      await new Promise((resolve) =>
        setTimeout(
          resolve,
          Math.max(0, Math.min(KINESIS_DESTINATION_SETTLE_POLL_MS, enclosingDeadlineRemainingMs()))
        )
      );
    }
  } finally {
    watch.dispose();
  }
  throw new Error(
    maskSecrets(
      `DynamoDB table ${tableName} was still ${last ?? 'unread'} ` +
        `${(KINESIS_DESTINATION_SETTLE_POLLS * KINESIS_DESTINATION_SETTLE_POLL_MS) / 1000} ` +
        `seconds after its encryption change`
    )
  );
}

/**
 * Poll DescribeTable until the table is ACTIVE AND every Global Secondary
 * Index is ACTIVE (not CREATING / UPDATING / DELETING / BACKFILLING). Used
 * between GSI mutations because a freshly-created index keeps backfilling
 * after the table itself returns to ACTIVE, and AWS rejects the next GSI op
 * until the prior index settles.
 *
 * `WarmThroughput.Status` is deliberately NOT part of the predicate, and that
 * is MEASURED rather than assumed (PR review of issue #1768 raised it as a
 * suspected race, since the per-index warm-throughput send path this provider
 * gained has no other reason to wait). Live, us-east-1 2026-08-13, on a
 * PAY_PER_REQUEST table with two ACTIVE GSIs: raising `gsi1`'s warm
 * throughput 12000/4000 -> 14000/5000 left
 *
 * ```
 * TableStatus: ACTIVE | gsi1: IndexStatus ACTIVE, WarmThroughput.Status UPDATING
 *                     | gsi2: IndexStatus ACTIVE, WarmThroughput.Status ACTIVE
 * ```
 *
 * for 90+ seconds — so this predicate IS satisfied while a warm update is
 * still settling, exactly as the review described. What does not follow is
 * the failure: with `gsi1` in that state, all three next-op shapes were
 * ACCEPTED, no `ResourceInUseException` —
 *
 *  - a warm-throughput `Update` on the OTHER index (`gsi2`);
 *  - a warm-throughput `Update` on the SAME index (`gsi1`);
 *  - a GSI `Create` (`gsi3`), the op AWS gates most strictly.
 *
 * So warm throughput settles OUT OF BAND of the index lifecycle, and adding
 * it to this predicate would only make every GSI op wait on a status that
 * blocks nothing — minutes of wait budget spent per op, with a real risk of
 * exhausting it on a table whose warm status lingers.
 */
export async function waitForTableAndIndexesActive(
  this: DynamoDBTableProvider,
  tableName: string,
  maxAttempts = 1800,
  // go-to-k/cdkd#2762: the call the wait follows (create() waits too), and
  // the caller's masker for the table name in the timeout text.
  opts: { after?: string; maskSecrets?: SecretMasker } = {}
): Promise<void> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const response = await this.dynamoDBClient.send(
      new DescribeTableCommand({ TableName: tableName })
    );
    const table = response.Table;
    const tableActive = table?.TableStatus === 'ACTIVE';
    const indexesActive = (table?.GlobalSecondaryIndexes ?? []).every(
      (gsi) => gsi.IndexStatus === 'ACTIVE'
    );
    // go-to-k/cdkd#2762: a vector index building or being removed gates the
    // next index op the same way.
    if (tableActive && indexesActive && vectorIndexesSettled(table?.VectorIndexes)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  const m = maskerOrIdentity(opts.maskSecrets);
  throw new Error(
    m(
      `Table ${m(tableName)} and its indexes did not reach ACTIVE within ${maxAttempts} ` +
        `seconds after ${opts.after ?? 'UpdateTable'}`
    )
  );
}
