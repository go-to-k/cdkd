/**
 * The index-busy `DeleteTable` rule that `AWS::DynamoDB::Table` and
 * `AWS::DynamoDB::GlobalTable` both need, in ONE spelling.
 *
 * AWS refuses a `DeleteTable` while any of the table's global secondary
 * indexes is mid-transition:
 *
 *   Attempt to change a resource which is still in use: Cannot delete table
 *   while indexes are being created, updated, or deleted.
 *
 * The condition is TRANSIENT and self-resolving — a real
 * `dynamodb-globaltable` destroy (us-east-1, 2026-08-13) lost one table to it
 * and the very next `cdkd destroy` succeeded with no other change — and
 * application auto-scaling can start an index capacity change at any moment,
 * so any table with an autoscaled GSI can hit it. Surfacing it as a hard
 * `PartialFailureError` with state preserved makes the user re-run a destroy
 * for something that clears itself in seconds.
 *
 * **Provenance, stated precisely.** The rule shipped for
 * `AWS::DynamoDB::GlobalTable` first (issue #1830, PR #1930), provider-locally
 * — deliberately, since `src/deployment/retryable-errors.ts` was owned by
 * another lane at the time. Issue #1931 is the sibling `AWS::DynamoDB::Table`
 * gap that PR left: its `delete()` had no retry at all. Rather than write the
 * classifier, the budget and the warning a second time, they were LIFTED here
 * and both providers now read them.
 *
 * What did NOT change for `GlobalTable` is its AWS-FACING behaviour: the call
 * order, the budgets, the #1521 pre-delete gate and the replica teardown are
 * identical. Two LOG LINES did change, deliberately, and the claim is scoped
 * rather than blanket because a blanket one is falsifiable by the diff: the
 * unclassified-error arm now names the error CLASS at warn and keeps AWS's raw
 * text at debug (it leaked an account id and an assumed-role ARN at default
 * verbosity), and {@link indexBusyRetryWarning} was reworded so its own
 * arithmetic reads consistently. That provider's suite was updated to match.
 *
 * Living here rather than in either provider is the point: the classifier is a
 * single regex whose PRECISION is the whole safety argument (see
 * {@link INDEX_BUSY_DELETE_MESSAGE}), and the retry budget only makes sense
 * read together with the re-arm poll it multiplies. Two files spelling either
 * independently is two chances for a later "fix" to move one of them while the
 * sibling type silently keeps the old answer. Same class as
 * `dynamodb-warm-throughput.ts`, and the same reason.
 *
 * Deliberately NOT here: what only one provider has. `GlobalTable` keeps its
 * pre-delete #1521 gate (a 15-minute settle wait ahead of the retry loop, sized
 * for a wait that runs once) and its replica / auto-scaling teardown; the
 * `Table` provider has neither. What IS shared is everything a second
 * implementation would otherwise re-derive: the predicate, the classifier, the
 * two budgets, the proceed note, the warning text and the retry loop itself.
 *
 * Issues: #1830 / #1521 (GlobalTable, PR #1930), #1931 (Table).
 */

import {
  type DescribeTableCommandOutput,
  ResourceNotFoundException,
} from '@aws-sdk/client-dynamodb';
import { withRetry } from '../deployment/retry.js';
import { isThrottlingError } from '../deployment/retryable-errors.js';
import type { Logger } from '../types/config.js';

/**
 * The GSI states during which AWS refuses another `UpdateTable` or a
 * `DeleteTable` on the table (issue #1521) — a table is ACTIVE while one of
 * its indexes is still transitioning, which is what made the serialized
 * update sequence race and what left a table ORPHANED when the follow-up
 * destroy hit the same rule.
 *
 * `DELETING` is included because a dropped index keeps reporting until it is
 * actually gone. The test is on the TRANSITIONAL values rather than on
 * `!== 'ACTIVE'`: an absent or unrecognized status must not park the caller
 * for its whole cap on a table that is fine.
 */
export const INDEX_TRANSITIONAL_STATUSES = new Set(['CREATING', 'UPDATING', 'DELETING']);

export function hasTransitionalIndex(
  indexes: ReadonlyArray<{ readonly IndexStatus?: string | undefined }> | undefined
): boolean {
  return (indexes ?? []).some((gsi) => INDEX_TRANSITIONAL_STATUSES.has(gsi.IndexStatus ?? ''));
}

/**
 * AWS's refusal when `DeleteTable` lands while one of the table's GSIs is
 * mid-transition (issue #1830). Observed verbatim on a real destroy:
 *
 *   Attempt to change a resource which is still in use: Cannot delete table
 *   while indexes are being created, updated, or deleted.
 *
 * Matched on the leading clause rather than on the whole sentence: the
 * trailing status list is AWS wording that can gain a state without changing
 * what the message MEANS, and the leading clause is already specific enough
 * that nothing else in the DynamoDB surface produces it. Case-insensitive
 * because the text arrives inside a wrapper prefix whose casing is not ours.
 *
 * Deliberately NOT keyed on the exception NAME: AWS reports this as a plain
 * `ResourceInUseException`, which is the same name it uses for genuinely
 * terminal conflicts (deleting a table that is `CREATING`, creating one that
 * already exists). Retrying on the name would turn those into a 47s stall
 * before the same failure.
 */
export const INDEX_BUSY_DELETE_MESSAGE = /cannot delete table while indexes are being/i;

export function isIndexBusyDeleteError(message: string): boolean {
  return INDEX_BUSY_DELETE_MESSAGE.test(message);
}

/**
 * Retry budget for the index-busy `DeleteTable` refusal (issue #1830).
 *
 * Left at `withRetry`'s own default of 8 rather than raised. Named rather than
 * inlined because passing it at all is what opts this call out of
 * `withRetry`'s dense IAM-propagation schedule, which would be wrong for a
 * condition measured in seconds-to-minutes rather than sub-second.
 *
 * The count MULTIPLIES the per-attempt re-arm poll below, so the two have to
 * be read together — see {@link DELETE_INDEX_BUSY_REARM_MAX_ATTEMPTS} for the
 * arithmetic and for why the poll is not a 15-minute one.
 */
export const DELETE_INDEX_BUSY_MAX_RETRIES = 8;

/**
 * `DescribeTable` polls (~1s apart) the index-busy `DeleteTable` retry spends
 * re-arming BEFORE each retry (issue #1830) — it returns on the first one that
 * reports every index settled.
 *
 * Bounded well under the 15-minute default `GlobalTable`'s pre-delete #1521
 * gate uses, because THAT default is sized for a wait that runs once while
 * this one runs per retry: the caller's wall clock is
 * `DELETE_INDEX_BUSY_MAX_RETRIES x this + withRetry's ~47s of backoff`, and
 * `destroy-runner.ts` runs the delete under a per-resource deadline (30 min by
 * default; neither DynamoDB provider declares a `getMinResourceTimeoutMs` to
 * lift it). At 900 polls the product was ~2h, so a genuinely stuck index
 * produced a 30-minute wait ending in a generic `ResourceTimeoutError` that
 * never mentions indexes. At 60 the LOOP's worst case is ~8.8 min and the user
 * gets AWS's own actionable sentence instead.
 *
 * **What that deadline actually wraps**, since the arithmetic depends on it:
 * NOT one `delete()` but `destroy-runner.ts`'s whole outer retry loop, which
 * calls `delete()` up to 4 times (`maxAttempts = 3`) inside the one deadline.
 * Four times ~8.8 min would blow straight through 30 min. It does not, and the
 * reason is load-bearing rather than incidental: that outer loop only retries
 * when `isRetryableTransientError` says so, and this refusal matches no entry
 * in `RETRYABLE_ERROR_MESSAGE_PATTERNS` (verified against the real classifier —
 * both AWS's raw sentence and the `Failed to delete DynamoDB table ...` wrap
 * return false), so the outer loop runs `delete()` exactly ONCE for it and the
 * budget below is not re-multiplied. Adding this message to those patterns
 * would silently make the worst case ~35 min — over the deadline.
 *
 * The FIRST attempt is unaffected — it does not re-arm at all.
 */
export const DELETE_INDEX_BUSY_REARM_MAX_ATTEMPTS = 60;

/**
 * What proceeding costs when a DELETE-path index-settle wait ends WITHOUT
 * confirming — passed as {@link waitForIndexesSettled}'s `proceedNote` by every
 * delete-path caller (`GlobalTable`'s #1521 pre-delete gate, and the #1830 /
 * #1931 retry re-arm on both providers).
 *
 * The note is caller-supplied because the consequence genuinely differs: the
 * delete path has a backstop — `DeleteTable` follows immediately and AWS
 * refuses it again if the index is still transitioning — while
 * `GlobalTable`'s auto-scaling caller has none (`reconcileAutoScalingTargets`
 * skips an index that is not ready and nothing downstream notices). One
 * sentence per caller, so neither claims the other's safety net.
 */
export const DELETE_INDEX_WAIT_PROCEED_NOTE = `the DeleteTable goes ahead anyway and AWS's own refusal stays the backstop.`;

/**
 * Poll `DescribeTable` until no GSI is transitioning, bounded by
 * `maxAttempts` (~1s apart).
 *
 * **Best-effort by design**: on timeout it warns and returns rather than
 * throwing. Index backfill on a large table can take a long time, and a throw
 * here would fail a caller whose actual resources are all correct — on the
 * delete path it would STRAND the resource, which is the failure this whole
 * module exists to remove.
 *
 * `maxAttempts` and `proceedNote` are required rather than defaulted: the two
 * callers differ on both (a wait that runs ONCE versus one that runs per retry
 * and multiplies; a caller with a backstop versus one without), and a default
 * would silently give one caller the other's answer.
 */
export async function waitForIndexesSettled(opts: {
  tableName: string;
  logicalId: string;
  logger: Logger;
  describeTable: () => Promise<DescribeTableCommandOutput>;
  maxAttempts: number;
  proceedNote: string;
}): Promise<void> {
  const { tableName, logicalId, logger, describeTable, maxAttempts, proceedNote } = opts;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await describeTable();
      const indexes = response.Table?.GlobalSecondaryIndexes ?? [];
      // Block on the TRANSITIONAL statuses, not on "!== ACTIVE": an absent
      // or unrecognized `IndexStatus` must not park the caller for the full
      // cap on a table that is fine. AWS always sets the field, so the two
      // readings only differ for a partial response — where proceeding and
      // letting AWS answer is the better failure mode.
      if (!hasTransitionalIndex(indexes)) return;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // A THROTTLED describe says nothing about the indexes, so reading it
      // as "settled" degrades the wait to no wait at all — which for the
      // #1830 re-arm means every retry burns inside `withRetry`'s ~47s
      // backoff grid against a condition that needs minutes. Keep waiting
      // instead; the loop is bounded either way.
      if (isThrottlingError(err)) {
        logger.debug(
          `DescribeTable throttled while waiting for indexes on ${tableName} ` +
            `(attempt ${attempt}/${maxAttempts}); still waiting: ${message}`
        );
        await new Promise((resolve) => setTimeout(resolve, 1000));
        continue;
      }
      // The table is GONE — there is nothing left to wait for, and this is a
      // routine shape on the delete path (a concurrent / re-run destroy), so
      // it must not warn.
      if (err instanceof ResourceNotFoundException) {
        logger.debug(
          `Table ${tableName} (${logicalId}) no longer exists while waiting for indexes`
        );
        return;
      }
      // Anything else: give up the WAIT, never the operation. A delete path
      // must tolerate a stale read rather than fail fast (a throw here would
      // strand the resource), so the caller proceeds. Warn rather than debug
      // — this is the arm that silently turned a wait into a no-op, and a run
      // at default verbosity has to be able to see it. What proceeding COSTS
      // is the caller's to say (`proceedNote`).
      //
      // The warning names the error CLASS only; AWS's raw message goes to
      // debug. That message is not neutral text: an `AccessDeniedException`
      // here reads `User: arn:aws:sts::<account>:assumed-role/<role>/<session>
      // is not authorized to perform: dynamodb:DescribeTable ...`, so the
      // default-verbosity line would print the account id, the role name and
      // the session name — and this warning is wrapped into the persisted
      // deployment-events store, not just the terminal. Debug is opt-in and
      // already the level the throttle arm above uses for the same reason.
      // The control flow is unchanged: both spellings still proceed.
      const errorName = err instanceof Error ? err.name : typeof err;
      logger.debug(
        `DescribeTable failed while waiting for indexes on ${tableName} (${logicalId}): ${message}`
      );
      logger.warn(
        `DescribeTable failed (${errorName}) while waiting for indexes on ${tableName} ` +
          `(${logicalId}), so cdkd stopped waiting; ${proceedNote} Re-run with --verbose for ` +
          `AWS's own message.`
      );
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  logger.warn(
    `Indexes on ${tableName} (${logicalId}) did not all reach ACTIVE within ` +
      `${maxAttempts} DescribeTable polls (~1s apart, so a little over ` +
      `${maxAttempts}s of wall clock); ${proceedNote}`
  );
}

/**
 * The ONE line the retry prints at default verbosity, for both providers.
 *
 * `withRetry` announces its retries through `opts.logger?.debug`, so without
 * this a delete spending minutes re-polling printed nothing naming the cause —
 * and the bounded budget above can end in a timeout that has to be diagnosable
 * from an ordinary run's output.
 *
 * `attemptNumber` is the attempt now STARTING (2 for the first retry). The
 * remaining-attempt count is DERIVED from it and never spelled out: `withRetry`
 * runs `1 + maxRetries` attempts in total, and writing the number by hand is
 * how this line came to promise 8 further attempts when 7 were left.
 *
 * The per-attempt settle budget is attached to "this attempt plus the N more"
 * rather than to the N alone, because the re-arm runs before the attempt this
 * very line announces too — 8 re-arms for 7 remaining attempts. Saying "N more
 * attempts, each preceded by ..." made one sentence quote two different counts.
 *
 * It must NOT carry AWS's own sentence: the `dynamodb-globaltable` integ greps
 * the destroy log for `Cannot delete table while indexes are being` to prove
 * AWS really refused, and a cdkd-authored copy would satisfy that grep without
 * the refusal having happened.
 */
export function indexBusyRetryWarning(opts: {
  typeLabel: string;
  logicalId: string;
  physicalId: string;
  attemptNumber: number;
}): string {
  const remainingAttempts = 1 + DELETE_INDEX_BUSY_MAX_RETRIES - opts.attemptNumber;
  return (
    `DynamoDB ${opts.typeLabel} ${opts.logicalId}: AWS refused DeleteTable on ${opts.physicalId} ` +
    `because a global secondary index is still being created, updated or ` +
    `deleted — application auto-scaling can start an index capacity change at ` +
    `any moment, including during this destroy. Waiting for the index to settle ` +
    `and retrying (this attempt plus up to ${remainingAttempts} more attempts; ` +
    `each one first waits up to ${DELETE_INDEX_BUSY_REARM_MAX_ATTEMPTS} ` +
    `DescribeTable polls ~1s apart — a little over a minute of settling — ` +
    `before its DeleteTable). Nothing is ` +
    `wrong with the table; a large index backfill can outlast this budget, in ` +
    `which case the destroy fails with AWS's own message and re-running it ` +
    `succeeds once the index is ACTIVE.`
  );
}

/**
 * Issue the caller's `DeleteTable`, retrying ONLY the transient index-busy
 * refusal and re-arming on the CONDITION between attempts.
 *
 * Retried here rather than by widening the shared
 * `RETRYABLE_ERROR_MESSAGE_PATTERNS`: the same `ResourceInUseException` text
 * also surfaces on CREATE / UPDATE paths where it is NOT self-clearing, and a
 * `DeleteTable` is the one call site that can legitimately wait it out. Same
 * scoping rationale as `isNameCooldownError` / `isRecreateRetryableError`.
 *
 * `reArm` runs BEFORE every retry and never before the first attempt. It is the
 * caller's because the poll needs the caller's client, but every caller is
 * expected to bound it with {@link DELETE_INDEX_BUSY_REARM_MAX_ATTEMPTS}: an
 * index backfill outlasts any fixed backoff grid, while a settle poll returns
 * on its first `DescribeTable` once the index is ACTIVE.
 *
 * `sleepSeam` is read per SLEEP rather than once when the options bag is built,
 * so a test that installs the no-op from INSIDE the first refusal — i.e. after
 * `delete()` has already built the bag — still gets it. A value captured at
 * construction time would be `undefined` there and would silently pay
 * `withRetry`'s real ~47s schedule. Passing `sleep` unconditionally is safe:
 * `withRetry`'s dense-schedule detection keys on `maxRetries` /
 * `initialDelayMs` / `maxDelayMs` / `isRetryable`, all of which this caller
 * already sets.
 */
export async function deleteTableWithIndexBusyRetry(opts: {
  logicalId: string;
  physicalId: string;
  /** How the resource type reads in the warning: `GlobalTable` / `table`. */
  typeLabel: string;
  logger: Logger;
  deleteTable: () => Promise<void>;
  reArm: () => Promise<void>;
  sleepSeam: { sleep?: (ms: number) => Promise<void> };
}): Promise<void> {
  let deleteAttempts = 0;
  await withRetry(
    async () => {
      // Attempt 2+ can only be reached through the index-busy refusal, so
      // re-arm on the CONDITION rather than on the clock.
      if (deleteAttempts++ > 0) {
        if (deleteAttempts === 2) {
          // ONE line, on the FIRST retry only: this announces the CONDITION,
          // not each attempt (which is what `withRetry`'s debug line does).
          opts.logger.warn(
            indexBusyRetryWarning({
              typeLabel: opts.typeLabel,
              logicalId: opts.logicalId,
              physicalId: opts.physicalId,
              attemptNumber: deleteAttempts,
            })
          );
        }
        await opts.reArm();
      }
      await opts.deleteTable();
    },
    opts.logicalId,
    {
      maxRetries: DELETE_INDEX_BUSY_MAX_RETRIES,
      // `isRetryable` is invoked as `(message, error)`; this classifier is
      // message-only on purpose — AWS wraps the condition in a generic
      // `ResourceInUseException`, whose NAME is shared with genuinely
      // terminal conflicts, so the message is the only discriminator.
      isRetryable: (message) => isIndexBusyDeleteError(message),
      logger: opts.logger,
      sleep: (ms: number) =>
        opts.sleepSeam.sleep
          ? opts.sleepSeam.sleep(ms)
          : new Promise<void>((resolve) => setTimeout(resolve, ms)),
    }
  );
}
