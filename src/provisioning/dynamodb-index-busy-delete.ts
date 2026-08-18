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
 * Retry budget for the index-busy `DeleteTable` refusal (issues #1830 /
 * #1950).
 *
 * RAISED from `withRetry`'s default of 8 by issue #1950. A live
 * `dynamodb-gsi-update` destroy (us-east-1, 2026-08-18) measured a FIVE-item
 * table's GSI create consuming 7 of the 8 retries. Five items is about as
 * small as a backfill gets, so those ~8 minutes are AWS's roughly FIXED
 * index-create latency rather than a data-proportional cost: the old budget
 * cleared the FLOOR of the condition it absorbs with one retry to spare, and
 * any table holding real data was expected to exceed it.
 *
 * **Why 14, and not simply double.** This count MULTIPLIES the per-attempt
 * re-arm poll, so the arithmetic belongs to the LOOP rather than to this
 * constant, and every term is a constant elsewhere in the tree:
 *
 * ```
 *   re-arm     DELETE_INDEX_BUSY_REARM_MAX_ATTEMPTS (60) polls x ~1.2s
 *              = ~72s.   ~1.2s is INDEX_SETTLE_POLL_INTERVAL_MS of sleep plus
 *              a DescribeTable round trip, MEASURED: the live log's
 *              per-attempt gaps were 73 / 74 / 77 / 80 / 80 / 80s, which is
 *              this plus the backoff below.
 *   backoff    withRetry's 1, 2, 4, 8, 8 ... capped at 8s (retry.ts) =
 *              8N - 17 seconds for N retries.
 *   loop(N)    N x 72 + (8N - 17) = 80N - 17 seconds.
 *   pre-delete <= TABLE_ACTIVE_WAIT_ATTEMPTS (60) polls waiting for the table
 *              to go ACTIVE after the `--remove-protection` UpdateTable
 *              (~72s, `dynamodb-table-provider.ts`; the Table path only).
 *   deadline   DEFAULT_RESOURCE_TIMEOUT_MS = 30 min, applied by
 *              `destroy-runner.ts` around the whole delete.
 * ```
 *
 * At N=8 that is 623s (~10.4 min). The "~8.8 min" this file used to quote was
 * the same product at an IDEALIZED 1.0s per poll, which the live run
 * disproved. At N=14 it is 1103s (~18.4 min), or 1175s (~19.6 min) including
 * the ACTIVE wait — two thirds of the deadline, leaving ~10.4 min.
 *
 * 16, the "just double it" answer, does NOT survive the same arithmetic: 1335s
 * measured, and 1641s (~27.4 min) if a poll costs 1.5s rather than the
 * measured ~1.2s, i.e. 2.6 min of margin. 15 is already past the two-thirds
 * fence. So 14 is the LARGEST value the deadline permits with real margin —
 * and what it buys is ~2.3x the measured floor, NOT coverage of an arbitrary
 * backfill, which is data-proportional and cannot be bounded by any fixed
 * budget. Past the budget the outcome is unchanged and still actionable: AWS's
 * own sentence, and a re-run that succeeds once the index is ACTIVE.
 *
 * Margin rather than "just under the deadline" because `withResourceDeadline`
 * (`src/deployment/resource-deadline.ts`) does NOT cancel: when it fires it
 * rejects while this loop keeps issuing `DeleteTable` in the background, so an
 * overshoot is not merely a worse error message.
 *
 * Raising the RE-ARM bound instead was the other lever, and was rejected: that
 * poll returns on the first `DescribeTable` reporting the indexes settled, so
 * a longer one buys the same wall clock without a single fresh `DeleteTable`
 * probe — and the probe is the part that tests AWS's ACTUAL refusal predicate
 * rather than cdkd's GSI-status proxy for it.
 *
 * SHARED, so this MOVES `AWS::DynamoDB::GlobalTable` too: that type's destroy
 * now spends up to ~18.4 min rather than ~10.4 min absorbing the same refusal.
 * Deliberate (the same AWS refusal has to answer the same way on both types),
 * and it does not change which calls that provider makes. Its own delete()
 * can prepend a 15-minute #1521 settle gate and a ~10-minute
 * `waitForReplicaGone` per non-local replica, a stack that already exceeded
 * the deadline before this change; see the note at its `deleteTableWithIndexBusyRetry`
 * call site.
 *
 * Named rather than inlined because passing it at all is what opts this call
 * out of `withRetry`'s dense IAM-propagation schedule, which would be wrong
 * for a condition measured in minutes rather than sub-second.
 */
export const DELETE_INDEX_BUSY_MAX_RETRIES = 14;

/**
 * `DescribeTable` polls (~1s apart) the index-busy `DeleteTable` retry spends
 * re-arming BEFORE each retry (issue #1830) — it returns on the first one that
 * reports every index settled.
 *
 * Bounded well under the 15-minute default `GlobalTable`'s pre-delete #1521
 * gate uses, because THAT default is sized for a wait that runs once while
 * this one runs per retry: the caller's wall clock is
 * `DELETE_INDEX_BUSY_MAX_RETRIES x this x ~1.2s per poll + withRetry's
 * backoff`, and `destroy-runner.ts` runs the delete under a per-resource
 * deadline (30 min by default; neither DynamoDB provider declares a
 * `getMinResourceTimeoutMs` to lift it). At 900 polls the product would be
 * ~4.2h, so a genuinely stuck index would produce a 30-minute wait ending in a
 * generic `ResourceTimeoutError` that never mentions indexes. At 60 the LOOP's
 * worst case is ~18.4 min — see {@link DELETE_INDEX_BUSY_MAX_RETRIES} for
 * every term of that product and for why the budget is 14 — and the user gets
 * AWS's own actionable sentence instead.
 *
 * **What that deadline actually wraps**, since the arithmetic depends on it:
 * NOT one `delete()` but `destroy-runner.ts`'s whole outer retry loop, which
 * calls `delete()` up to 4 times (`maxAttempts = 3`) inside the one deadline.
 * Four times ~18.4 min would blow straight through 30 min. It does not, and the
 * reason is load-bearing rather than incidental: that outer loop only retries
 * when `isRetryableTransientError` says so, and this refusal matches no entry
 * in `RETRYABLE_ERROR_MESSAGE_PATTERNS` (verified against the real classifier —
 * both AWS's raw sentence and the `Failed to delete DynamoDB table ...` wrap
 * return false), so the outer loop runs `delete()` exactly ONCE for it and the
 * budget below is not re-multiplied. Adding this message to those patterns
 * would silently make the worst case ~74 min — well over the deadline.
 *
 * The FIRST attempt is unaffected — it does not re-arm at all.
 */
export const DELETE_INDEX_BUSY_REARM_MAX_ATTEMPTS = 60;

/**
 * Sleep between two `DescribeTable` polls of {@link waitForIndexesSettled}.
 *
 * Named rather than inlined because it is the unit BOTH budgets above are
 * denominated in: a poll count only becomes a wall clock through this, and the
 * whole "does the loop fit inside the per-resource deadline" argument at
 * {@link DELETE_INDEX_BUSY_MAX_RETRIES} multiplies it. It is a FLOOR on the
 * per-poll cost, never the whole of it — each poll also pays a `DescribeTable`
 * round trip, which is why the live run's 60-poll re-arm took ~72s and not
 * 60s, and why the arithmetic above prices a poll at ~1.2s.
 */
export const INDEX_SETTLE_POLL_INTERVAL_MS = 1_000;

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
        await new Promise((resolve) => setTimeout(resolve, INDEX_SETTLE_POLL_INTERVAL_MS));
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
    await new Promise((resolve) => setTimeout(resolve, INDEX_SETTLE_POLL_INTERVAL_MS));
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
 * very line announces too — 14 re-arms for 13 remaining attempts. Saying "N
 * more attempts, each preceded by ..." made one sentence quote two different
 * counts.
 *
 * It also states the remaining wall clock, as a FLOOR (issue #1950). With the
 * budget at {@link DELETE_INDEX_BUSY_MAX_RETRIES} the loop can now run for the
 * better part of twenty minutes, and a user watching a destroy sit on one
 * table for that long needs to tell SETTLING from STUCK — an attempt count
 * alone does not say how long it will take. A floor rather than an estimate
 * because {@link INDEX_SETTLE_POLL_INTERVAL_MS} is only the sleep: each poll
 * also pays a `DescribeTable` round trip and `withRetry` sleeps its backoff
 * between attempts, so the real figure is larger, and a line that promised a
 * shorter wait than the loop takes would be the more misleading of the two.
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
  // Attempts still to run INCLUDING the one this line announces — each of them
  // re-arms, so this is also the number of settle polls ahead. Derived from the
  // constants for the same reason `remainingAttempts` is: a hand-written figure
  // is how this line once came to promise one more attempt than the loop makes.
  const settleFloorMinutes = Math.round(
    ((remainingAttempts + 1) *
      DELETE_INDEX_BUSY_REARM_MAX_ATTEMPTS *
      INDEX_SETTLE_POLL_INTERVAL_MS) /
      60_000
  );
  return (
    `DynamoDB ${opts.typeLabel} ${opts.logicalId}: AWS refused DeleteTable on ${opts.physicalId} ` +
    `because a global secondary index is still being created, updated or ` +
    `deleted — application auto-scaling can start an index capacity change at ` +
    `any moment, including during this destroy. Waiting for the index to settle ` +
    `and retrying (this attempt plus up to ${remainingAttempts} more attempts; ` +
    `each one first waits up to ${DELETE_INDEX_BUSY_REARM_MAX_ATTEMPTS} ` +
    `DescribeTable polls ~1s apart — a little over a minute of settling — ` +
    `before its DeleteTable, so this can keep retrying for at least ` +
    `~${settleFloorMinutes} more minutes). Nothing is ` +
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
