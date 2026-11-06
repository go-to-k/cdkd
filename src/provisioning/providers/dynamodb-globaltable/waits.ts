import { DescribeTableCommand, ResourceNotFoundException } from '@aws-sdk/client-dynamodb';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import { ProvisioningError } from '../../../utils/error-handler.js';
import { withRetry } from '../../../deployment/retry.js';
import { isInterruptedWaitError, startInterruptWatch } from '../../interrupt-watch.js';
import { isThrottlingError } from '../../../deployment/retryable-errors.js';
import {
  INDEX_SETTLE_POLL_INTERVAL_MS,
  hasTransitionalTableIndex,
  waitForIndexesSettled,
  maskedLogger,
} from '../../dynamodb-index-busy-delete.js';
import {
  AUTO_SCALING_TEARDOWN_MAX_RETRIES,
  autoScalingRetriesWithinDeleteBudget,
  beginDeleteWait,
} from '../dynamodb-delete-budget.js';
import { ElapsedBudget } from '../../../utils/elapsed-budget.js';
import type { SecretMasker } from '../../../types/resource.js';
import {
  autoScalingRetryDelays,
  REPLICA_GONE_WAIT_ATTEMPTS,
  GLOBAL_TABLE_ACTIVE_WAIT_ATTEMPTS,
  TABLE_GONE_WAIT_ATTEMPTS,
} from './capacity.js';
import type { DynamoDBGlobalTableProvider } from '../dynamodb-globaltable-provider.js';

// ─── Polling helpers ─────────────────────────────────────────────────

export async function waitForTableActive(
  this: DynamoDBGlobalTableProvider,
  tableName: string,
  logicalId: string,
  maxAttempts = 120,
  // The create caller's masker (issue #2177): every line and throw below
  // names the resolved table name. Defaults to IDENTITY.
  maskSecrets: SecretMasker = (text) => text
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
      maskSecrets(
        `Table ${maskSecrets(tableName)} status: ${status} (attempt ${attempt}/${maxAttempts})`
      )
    );

    if (status === 'ACTIVE') {
      return {
        tableArn: response.Table?.TableArn,
        tableId: response.Table?.TableId,
        streamArn: response.Table?.LatestStreamArn,
      };
    }
    if (status !== 'CREATING' && status !== 'UPDATING') {
      throw new ProvisioningError(
        maskSecrets(
          `Unexpected table status while waiting for ACTIVE on ${maskSecrets(tableName)}: ${status}`
        ),
        'AWS::DynamoDB::GlobalTable',
        logicalId,
        tableName
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new ProvisioningError(
    maskSecrets(`Table ${maskSecrets(tableName)} did not reach ACTIVE within ${maxAttempts}s`),
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
 *
 * **A table is ACTIVE while one of its INDEXES is still transitioning**, and
 * the next `UpdateTable` in the serialized sequence is then rejected with
 * `Attempt to change a resource which is still in use: Index is being
 * updated` (issue #1521). That is not hypothetical: it broke the
 * `PAY_PER_REQUEST -> PROVISIONED` flip that also drops a GSI — AWS applies
 * the flip to every index, and cdkd issued the index DELETE while the index
 * was still absorbing it. Reproduced on pristine `main`, three runs out of
 * four on 2026-08-10, and the failed deploy's own `cdkd destroy` then
 * ORPHANED the table for the same reason.
 *
 * So the wait has TWO conditions read off the SAME response (an extra
 * `DescribeTable` per wait would double this path's API traffic for
 * something the response already carries) — but they keep DIFFERENT failure
 * semantics, and conflating them is a real regression rather than a
 * simplification. A table that never reaches ACTIVE is a hard error: nothing
 * can proceed. A still-transitioning INDEX is best-effort: `IndexStatus`
 * stays `CREATING` for the whole BACKFILL of a newly added GSI, which on a
 * populated table routinely outlives any cap — so throwing there would fail
 * a deploy whose resources are all correct, and would do it on an unrelated
 * tag-only edit that merely ran while an earlier index was still building.
 * Past the cap the index half warns and proceeds, leaving AWS's own
 * rejection as the backstop, which is the behavior it had before #1521 for
 * every case except the one the wait exists to fix.
 */
export async function waitForTableActiveAfterUpdate(
  this: DynamoDBGlobalTableProvider,
  tableName: string,
  logicalId: string,
  maxAttempts = GLOBAL_TABLE_ACTIVE_WAIT_ATTEMPTS,
  budget?: ElapsedBudget,
  // The caller's secret masker (issue #1997). Both the warning and the THROW
  // below name `tableName`, the resolved table name — and the throw matters
  // more than the warning here, because the deploy engine's CLI path logs
  // `error.message` RAW (only its events store masks). The DELETE-path caller
  // passes its `DeleteContext.maskSecrets` (issue #2007); IDENTITY for a
  // direct caller passing none.
  maskSecrets: SecretMasker = (text) => text
): Promise<void> {
  // Issue #1955: on the DELETE path (`--remove-protection`) this is the FIRST
  // wait of four sharing one per-resource deadline, and it is the slowest
  // kind — it returns only when the table is ACTIVE *and* no index is
  // transitioning, i.e. exactly the condition the rest of the path is about,
  // so it can spend its full ~12 min at t=0 and leave the #1521 gate and the
  // index-busy loop nothing. Its `Table`-provider twin took the allowance in
  // the first revision of this change and this one did not, which is the
  // half-applied shape a paired clamp exists to prevent. Every CREATE /
  // UPDATE caller passes no budget and keeps the full cap.
  const wait = beginDeleteWait(maxAttempts, budget);
  let tableReachedActive = false;
  while (wait.nextPoll()) {
    const response = await this.dynamoDBClient.send(
      new DescribeTableCommand({ TableName: tableName })
    );
    if (response.Table?.TableStatus === 'ACTIVE') {
      tableReachedActive = true;
      if (!hasTransitionalTableIndex(response.Table)) return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  // Both exits name WHICH clock ended the wait, and both count the polls
  // actually RUN rather than the ones granted — the loop can also stop
  // mid-way, when the allowance runs out under polls that cost more than the
  // ~1.2s the grant assumed.
  const budgetNote = wait.note();
  if (tableReachedActive) {
    this.logger.warn(
      maskSecrets(
        `Indexes on ${tableName} (${logicalId}) were still transitioning after ` +
          `${wait.pollsRun}s — a large index backfill can outlive this wait. Proceeding; ` +
          `AWS rejects the next call if it is still too early.${budgetNote}`
      )
    );
    return;
  }
  throw new ProvisioningError(
    maskSecrets(
      `Table ${tableName} did not reach ACTIVE within ${wait.pollsRun}s after UpdateTable${budgetNote}`
    ),
    'AWS::DynamoDB::GlobalTable',
    logicalId,
    tableName
  );
}

/**
 * Wait until every GSI reports `IndexStatus: ACTIVE` (Issue #1419).
 *
 * A GSI added by `UpdateTable` leaves the TABLE ACTIVE while the index
 * itself is still `CREATING` — application-autoscaling rejects a target
 * whose resource is not ready, so registering right after the GSI-add loop
 * would skip the very index the deploy just introduced.
 *
 * Since issue #1521 the same distinction is enforced INSIDE
 * {@link waitForTableActiveAfterUpdate} (which now reads both conditions off
 * its own response), so this helper is no longer the only place that knows
 * it. It remains the explicit wait for the two callers that have no
 * table-status wait to piggyback on: the autoscaling registration above and
 * the pre-`DeleteTable` gate, which AWS rejects while an index is
 * transitioning. An index that is `DELETING` still reports, so the shared
 * {@link hasTransitionalIndex} predicate covers `CREATING` / `UPDATING` /
 * `DELETING` alike.
 *
 * **Best-effort by design**: on timeout it warns and returns rather than
 * throwing. A missed registration self-heals on the next deploy (the
 * reconcile re-asserts anything not already present), whereas throwing
 * here would fail a deploy whose actual resources are all correct. Index
 * backfill on a large table can take a long time, hence the 15-minute
 * DEFAULT cap. The caller that follows it with a mutating call keeps AWS's
 * own error as the backstop for the case where even that cap is not enough.
 *
 * `opts.maxAttempts` exists because the cap is only right for a wait that
 * runs ONCE: the #1830 delete retry re-runs this per attempt, so the caller's
 * wall clock is the product and the default would blow past the per-resource
 * deadline `destroy-runner.ts` enforces.
 *
 * `opts.proceedNote` covers the OTHER thing that is caller-specific: what it
 * costs when the wait ends WITHOUT confirming. Both arms that end that way —
 * the timeout, and a `DescribeTable` that failed for a reason other than
 * throttling or a gone table — stop waiting and let the caller proceed, so
 * one note serves both. The consequences genuinely differ: on the delete
 * path AWS refuses the `DeleteTable` and that refusal is the backstop, while
 * the auto-scaling caller has NO backstop — `reconcileAutoScalingTargets`
 * simply skips an index that is not ready and nothing downstream refuses.
 * The default sentence is the auto-scaling one; every delete-path caller
 * passes {@link DELETE_INDEX_WAIT_PROCEED_NOTE}.
 */
export async function waitForIndexesActive(
  this: DynamoDBGlobalTableProvider,
  tableName: string,
  logicalId: string,
  opts?: {
    maxAttempts?: number;
    shortCapUnlessVectorBusy?: number;
    proceedNote?: string;
    budget?: ElapsedBudget;
    // The update caller's masker: the table name can be secret-derived, and
    // the wait's WARN lines name it (go-to-k/cdkd#4275). The delete callers
    // pass their `DeleteContext.maskSecrets` (issue #2007).
    maskSecrets?: SecretMasker;
  }
): Promise<void> {
  // The LOOP lives in `../dynamodb-index-busy-delete.ts` because the sibling
  // `AWS::DynamoDB::Table` provider needs the identical wait to re-arm its
  // own index-busy delete retry (issue #1931), and the tolerances it encodes
  // — throttle keeps waiting, gone returns, anything else gives up the WAIT
  // and not the operation — are exactly the ones a second spelling would get
  // subtly wrong. This method keeps the DEFAULTS, which are this provider's:
  // the 900-poll cap and the auto-scaling proceed note both belong to the
  // caller that has no backstop, and neither is right for the delete path.
  const gateWait = beginDeleteWait(opts?.maxAttempts ?? 900, opts?.budget);
  await waitForIndexesSettled({
    tableName,
    logicalId,
    // The name masked as a VALUE first, so one below the masker's substring
    // floor is caught too, then the whole line (AWS text can quote it).
    logger: maskedLogger(this.logger, opts?.maskSecrets, tableName),
    describeTable: () =>
      this.dynamoDBClient.send(new DescribeTableCommand({ TableName: tableName })),
    // The cap is the SMALLER of this caller's own constant and what the
    // shared delete budget can still afford (issue #1955) — an absent budget
    // (every CREATE / UPDATE caller) leaves the constant untouched.
    maxAttempts: gateWait.grantedPolls,
    ...(opts?.shortCapUnlessVectorBusy !== undefined && {
      shortCapUnlessVectorBusy: opts.shortCapUnlessVectorBusy,
    }),
    // ...and the loop re-checks the allowance on every iteration, so a poll
    // that costs more than the grant assumed cannot run the wait past it.
    // The wait also owns its own give-up wording, so a budget-ended exit
    // cannot read as AWS failing to settle.
    budgetWait: gateWait,
    proceedNote:
      opts?.proceedNote ??
      `auto-scaling registration for a still-building index may have been skipped. The ` +
        `next deploy re-asserts it.`,
  });
}

/**
 * Wait until a specific replica's `ReplicaStatus` flips to ACTIVE.
 * Replica provisioning typically takes 1–5 min; capped at
 * {@link REPLICA_GONE_WAIT_ATTEMPTS} polls — ~12 min at the MEASURED ~1.2s
 * per poll (a sleep plus a `DescribeTable` round trip), not the ~10 min the
 * `1 poll = 1s` reading gives. The delete-path arithmetic in
 * `./dynamodb-delete-budget.ts` prices it at the measured figure, so the two
 * have to agree.
 */
export async function waitForReplicaActive(
  this: DynamoDBGlobalTableProvider,
  tableName: string,
  region: string,
  logicalId: string,
  maxAttempts = 600,
  // The create / update caller's masker (issue #2177): the throw below names
  // the resolved table name. Defaults to IDENTITY.
  maskSecrets: SecretMasker = (text) => text
): Promise<void> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const response = await this.dynamoDBClient.send(
      new DescribeTableCommand({ TableName: tableName })
    );
    const replica = response.Table?.Replicas?.find((r) => r.RegionName === region);
    if (replica?.ReplicaStatus === 'ACTIVE') return;
    this.logger.debug(
      maskSecrets(
        `Replica ${region} status: ${replica?.ReplicaStatus} (attempt ${attempt}/${maxAttempts})`
      )
    );
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new ProvisioningError(
    maskSecrets(
      `Replica ${region} for table ${maskSecrets(tableName)} did not reach ACTIVE within ${maxAttempts}s`
    ),
    'AWS::DynamoDB::GlobalTable',
    logicalId,
    tableName
  );
}

/**
 * Wait until a specific replica disappears from `Replicas[]` after a
 * Delete replica update. Replica deletion typically takes 1–5 min;
 * capped at {@link REPLICA_GONE_WAIT_ATTEMPTS} polls (~12 min at the
 * measured ~1.2s per poll).
 */
export async function waitForReplicaGone(
  this: DynamoDBGlobalTableProvider,
  tableName: string,
  region: string,
  logicalId: string,
  maxAttempts = REPLICA_GONE_WAIT_ATTEMPTS,
  budget?: ElapsedBudget,
  // The create-cleanup / update caller's masker (issue #2177): the interrupt
  // label and the throw below name the resolved table name. The DELETE
  // caller passes its `DeleteContext.maskSecrets` (issue #2007); IDENTITY
  // for a direct caller passing none.
  maskSecrets: SecretMasker = (text) => text
): Promise<void> {
  // Issue #1955: on the delete path this is one of THREE stacked waits inside
  // a single per-resource deadline, so it takes the smaller of its own cap
  // and what the shared budget can still afford. The partial-create cleanup
  // caller passes no budget and keeps the full cap.
  const wait = beginDeleteWait(maxAttempts, budget);
  // Interruptible (issue #1952): 600 polls is ~12 minutes, and the whole
  // point of interrupting only ONE wait on this path is that it buys little
  // — every bounded wait the delete path can sit in has to consult the same
  // signal. This one THROWS rather than returning, for the same reason the
  // exhaustion arm below throws: `DeleteTable` has NOT been issued yet and
  // AWS refuses it while a replica lives, so proceeding after a Ctrl-C would
  // trade a long wait for a confusing failure.
  const watch = startInterruptWatch(
    maskSecrets(`DynamoDB replica ${region} teardown on ${maskSecrets(tableName)}`)
  );
  try {
    while (wait.nextPoll()) {
      if (watch.isInterrupted()) throw watch.onInterrupted();
      try {
        const response = await this.dynamoDBClient.send(
          new DescribeTableCommand({ TableName: tableName })
        );
        const replica = response.Table?.Replicas?.find((r) => r.RegionName === region);
        if (!replica) return;
        await new Promise((resolve) => setTimeout(resolve, INDEX_SETTLE_POLL_INTERVAL_MS));
      } catch (err) {
        if (err instanceof ResourceNotFoundException) return;
        throw err;
      }
    }
  } finally {
    watch.dispose();
  }
  // Still THROWS even when the allowance ended it, unlike the gone-wait
  // below, and the asymmetry is load-bearing — but NOT because nothing has
  // been accepted. The `UpdateTable{ReplicaUpdates:[{Delete}]}` that starts
  // this teardown WAS accepted (see `delete()`), so an earlier reading of
  // this comment was simply wrong. What differs is what comes NEXT: the
  // gone-wait is the LAST thing on the path, so giving up on it costs
  // nothing, while this wait is followed by a `DeleteTable` that AWS REFUSES
  // while the replica still lives. Proceeding optimistically here trades a
  // long wait for a confusing failure, which is why both the exhaustion arm
  // and the interrupt arm throw.
  throw new ProvisioningError(
    maskSecrets(
      `Replica ${region} for table ${maskSecrets(tableName)} did not disappear within ` +
        `${wait.pollsRun}s${wait.note()}`
    ),
    'AWS::DynamoDB::GlobalTable',
    logicalId,
    tableName
  );
}

/**
 * go-to-k/cdkd#5581: whether a removed replica's table reads `DELETING` or
 * `ResourceNotFound` in its own region. `true` when it does; otherwise the
 * reason for the caller's warning, and AWS's own text for its debug line.
 *
 * ONE read (throttle-retried), not a poll. `waitForReplicaGone` returns once
 * the SOURCE table's `Replicas[]` has dropped the entry, and by then the
 * regional copy is expected to be deleting: the `dynamodb-globaltable`
 * integ's step 12e sees it stay `DELETING` for minutes after that before its
 * ResourceNotFound. Both states are past the point of return, so `DELETING`
 * is accepted rather than waited out — that wait would add those minutes to
 * every replica removal. A table reading anything else keeps its targets,
 * with a warning.
 */
export async function readReplicaTableRetired(
  this: DynamoDBGlobalTableProvider,
  tableName: string,
  region: string,
  budget: ElapsedBudget | undefined,
  watch: ReturnType<typeof startInterruptWatch>
): Promise<true | { reason: string; awsDetail?: string }> {
  try {
    const response = await withRetry(
      () => this.getRegionalClient(region).send(new DescribeTableCommand({ TableName: tableName })),
      `${tableName} in ${region}`,
      {
        isRetryable: (_message, error) => isThrottlingError(error),
        maxRetries: autoScalingRetriesWithinDeleteBudget(budget, AUTO_SCALING_TEARDOWN_MAX_RETRIES),
        isInterrupted: watch.isInterrupted,
        onInterrupted: watch.onInterrupted,
        ...(autoScalingRetryDelays.sleep ? { sleep: autoScalingRetryDelays.sleep } : {}),
      }
    );
    const status = response.Table?.TableStatus;
    if (status === 'DELETING') return true;
    return { reason: `the table there still reads ${status ?? 'no status'}` };
  } catch (err) {
    if (err instanceof ResourceNotFoundException) return true;
    if (isInterruptedWaitError(err)) throw err;
    const failure = describeAwsFailure(err);
    return {
      reason: `reading the table there failed (${failure.summary})`,
      awsDetail: failure.detail,
    };
  }
}

/**
 * Wait for `DescribeTable` to return `ResourceNotFoundException`,
 * confirming the table has actually been removed. `DeleteTable` is
 * async — the call returns immediately with `TableStatus: DELETING`
 * and AWS only removes the table some seconds later. Without this
 * wait, downstream observers (siblings deleted in the same destroy
 * run, integ scripts that re-check via `aws dynamodb describe-table`)
 * see "destroy succeeded" but the table is still listed by AWS.
 * Typical small-table delete completes in 5–30s; capped at
 * {@link TABLE_GONE_WAIT_ATTEMPTS} polls (~12 min at the measured ~1.2s per
 * poll) for worst-case large-table / replica-cascade scenarios. That 5-30s
 * figure is what {@link DELETE_SHORT_WAIT_POLLS} is calibrated against: past
 * roughly twice the top of it, cdkd HAS given AWS a real wait.
 */
export async function waitForTableGone(
  this: DynamoDBGlobalTableProvider,
  tableName: string,
  logicalId: string,
  maxAttempts = TABLE_GONE_WAIT_ATTEMPTS,
  budget?: ElapsedBudget,
  // The delete caller's `DeleteContext.maskSecrets` (go-to-k/cdkd#2007): the
  // interrupt label, both warnings and the throw name the table. IDENTITY
  // for a direct caller passing none.
  mask: SecretMasker = (text) => text
): Promise<void> {
  const shownName = mask(tableName);
  // Issue #1955: this is the LAST term of the delete path and the one that
  // only runs on a late loop SUCCESS — which is exactly why it was the term
  // that pushed the single-region shape to ~40.4 min. It draws from the same
  // shared budget as everything before it.
  const wait = beginDeleteWait(maxAttempts, budget);
  // Interruptible (issue #1952), and unlike `waitForReplicaGone` this one
  // RETURNS: by the time it runs AWS has ACCEPTED the `DeleteTable` and the
  // deletion is no longer in cdkd's hands, so a Ctrl-C here means "stop
  // watching", not "the delete failed". That is the same reading the
  // `cutShort` arm below already takes, and throwing would turn an accepted
  // delete into a reported FAILURE with state preserved.
  const watch = startInterruptWatch(mask(`DynamoDB table ${shownName} deletion wait`));
  try {
    while (wait.nextPoll()) {
      if (watch.isInterrupted()) {
        this.logger.warn(
          mask(
            `DynamoDB GlobalTable ${logicalId}: interrupted while waiting for ${shownName} to ` +
              `disappear. AWS ACCEPTED the DeleteTable and will finish it; cdkd stopped watching.`
          )
        );
        return;
      }
      try {
        await this.dynamoDBClient.send(new DescribeTableCommand({ TableName: tableName }));
        await new Promise((resolve) => setTimeout(resolve, INDEX_SETTLE_POLL_INTERVAL_MS));
      } catch (err) {
        if (err instanceof ResourceNotFoundException) return;
        throw err;
      }
    }
  } finally {
    watch.dispose();
  }
  // A wait the allowance CUT SHORT warns; a wait that was actually performed
  // still throws. The line is {@link DELETE_SHORT_WAIT_POLLS}, not
  // `granted < cap`, and the difference matters: with ~14 min of the
  // allowance already spent this wait is still granted ~500 polls — ten real
  // minutes of `DescribeTable` — and downgrading THAT to a warning would be a
  // decision made by two minutes of arithmetic rather than by evidence.
  //
  // Below the floor, cdkd barely looked, and `DeleteTable` has already been
  // ACCEPTED by the time this wait runs (it returned 200 and the table is
  // `DELETING`, and this method's only caller sits after the retry helper
  // resolved). The deletion is no longer in cdkd's hands and it WILL
  // complete; failing there turns an accepted delete into a reported FAILURE
  // with state preserved, and the user re-runs a destroy for a table AWS
  // already deleted. Above the floor, cdkd DID give AWS a real wait, so a
  // table still present is a signal about AWS and keeps the hard error the
  // method has always had.
  if (wait.cutShort) {
    this.logger.warn(
      mask(
        `DynamoDB GlobalTable ${logicalId}: DeleteTable on ${shownName} was ACCEPTED by AWS but ` +
          `cdkd stopped waiting for the table to disappear` +
          `${wait.note()} The delete completes on AWS's side; a later ` +
          `describe (or a re-run of this destroy) sees it gone.`
      )
    );
    return;
  }
  throw new ProvisioningError(
    mask(`Table ${shownName} did not disappear within ${wait.pollsRun}s${wait.note()}`),
    'AWS::DynamoDB::GlobalTable',
    logicalId,
    tableName
  );
}
