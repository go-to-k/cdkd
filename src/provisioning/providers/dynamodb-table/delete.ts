import {
  DeleteTableCommand,
  DescribeTableCommand,
  UpdateTableCommand,
  ResourceNotFoundException,
} from '@aws-sdk/client-dynamodb';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import { ProvisioningError } from '../../../utils/error-handler.js';
import { markNotGone } from '../../not-gone.js';
import { assertRegionMatch, type DeleteContext } from '../../region-check.js';
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
  DYNAMODB_DELETE_MIN_RESOURCE_TIMEOUT_MS as DELETE_BUDGET_REUSE_WINDOW_MS,
  type ProtectionCompensationOutcome,
  type ProtectionFlipRecord,
  beginDeleteWait,
  compensateRemovedDeletionProtection,
  deleteBudgetKey,
  isTerminalDeleteFailure,
  resolveDynamoDbDeleteBudgetClock,
  resolveDynamoDbDeleteBudgetMs,
} from '../dynamodb-delete-budget.js';
import { maskerOrIdentity } from '../../masked-retry-logger.js';
import { waitForGoneAfterDelete } from '../../delete-gone-wait.js';
import { safeMsg } from '../../../utils/display-safe.js';
import { isThrottlingError, isTransientServerError } from '../../../deployment/retryable-errors.js';
import type { DynamoDBTableProvider } from '../dynamodb-table-provider.js';
import {
  TABLE_ACTIVE_WAIT_ATTEMPTS,
  deleteTableRetryDelays,
  tableDeleteGoneWait,
  tableNameReleaseWait,
} from './table-helpers.js';

/**
 * go-to-k/cdkd#5131: `DeleteTable` returns with the table `DELETING`, and
 * DynamoDB keeps the name until it is gone, so a same-name re-create right
 * after cdkd's own delete fails `ResourceInUseException`. Polls
 * `DescribeTable` until `ResourceNotFoundException`, as the GlobalTable
 * provider's gone-wait does, within its poll budget. Only the replacement
 * that deleted the table asks. Since go-to-k/cdkd#5514 `delete()` itself
 * waits for the table to be gone, so this normally answers on its first
 * poll; it stays for a delete whose own wait was cut short (budget,
 * interrupt, an unreadable status).
 */
export async function waitForNameReleased(
  this: DynamoDBTableProvider,
  logicalId: string,
  physicalId: string,
  _resourceType: string,
  context: { isInterrupted: () => boolean; maskSecrets?: (text: string) => string }
): Promise<void> {
  const mask = context.maskSecrets ?? ((text: string) => text);
  // A table can stay DELETING for minutes: say why the deploy waits.
  this.logger.info(
    mask(`  Waiting for the deleted DynamoDB table ${physicalId} to release its name...`)
  );
  for (let poll = 0; poll < tableNameReleaseWait.maxPolls; poll++) {
    if (context.isInterrupted()) return;
    try {
      await this.dynamoDBClient.send(new DescribeTableCommand({ TableName: physicalId }));
    } catch (error) {
      if (error instanceof ResourceNotFoundException) return;
      this.logger.debug(
        mask(
          `DynamoDB table ${logicalId}: name-release check failed: ${describeAwsFailure(error).detail}`
        )
      );
      // A throttle or a server error: poll on, within the bound. Anything
      // else (access denied, a malformed name) will not change: stop
      // waiting, and the re-create reports what is wrong.
      if (!isThrottlingError(error) && !isTransientServerError(error)) return;
    }
    await new Promise((resolve) => setTimeout(resolve, tableNameReleaseWait.intervalMs));
  }
  this.logger.debug(
    mask(`DynamoDB table ${logicalId} (${physicalId}) still held its name after the wait`)
  );
}

/**
 * Delete a DynamoDB table
 *
 * A thin wrapper around {@link deleteTableResource} whose only job is the
 * `--remove-protection` compensation (issue #1978): if this run turned
 * `DeletionProtectionEnabled` off and the delete then ended for good — a
 * terminal AWS refusal, or a Ctrl-C landing anywhere after the flip — the
 * guard goes back on before the failure is re-thrown. Without it the run ends
 * with a LIVE table whose protection cdkd silently stripped: the failure is
 * loud, the side effect is not.
 *
 * It is a WRAPPER rather than a `catch` inside the body because the window is
 * not one `try`. Between the flip and a successful delete this provider can
 * throw from the index-settled re-arm, from the retry loop, and from an
 * interrupted wait, and the same shape on the sibling `GlobalTable` provider
 * spans a replica teardown as well. Catching at the boundary covers every
 * exit; the {@link ProtectionFlipRecord} — not the position of the catch — is
 * what decides whether there is anything to undo.
 */
export async function deleteResource(
  this: DynamoDBTableProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  _properties?: Record<string, unknown>,
  context?: DeleteContext
): Promise<void> {
  // From the REGISTRY, not a fresh object: this method is re-entered by
  // `destroy-runner.ts` after a retryable failure, and what has to survive
  // that re-entry is exactly "an earlier attempt already flipped the guard
  // off". Same key and the same window CONSTANT as the delete
  // allowance below, but not the same semantics: this one SLIDES on reuse
  // (issue #2211) while `ElapsedBudgetRegistry` still measures from creation.
  const flip: ProtectionFlipRecord = this.protectionFlips.acquire(
    deleteBudgetKey(physicalId, context?.expectedRegion),
    DELETE_BUDGET_REUSE_WINDOW_MS,
    // The same injected clock the allowance below gets. Production-identical
    // either way (both default to the monotonic clock). It is threaded so the
    // reuse window can be driven THROUGH `delete()`, which is what fences the
    // SLIDING window go-to-k/cdkd#2211 fixed: the suite's three-attempt case
    // advances this clock past `DELETE_BUDGET_REUSE_WINDOW_MS` in total while
    // keeping every gap inside it, and asserts the latch survived.
    resolveDynamoDbDeleteBudgetClock()
  );
  try {
    await this.deleteTableResource(logicalId, physicalId, resourceType, context, flip);
  } catch (error) {
    // The outcome DEFAULTS to `failed` and the release sits in a `finally`,
    // so an unknown outcome retains the record -- the safe direction.
    // `compensateRemovedDeletionProtection` documents that it never throws
    // (it must not replace the failure this `catch` is about to re-throw),
    // but that is a property of the callee: a compensation that died
    // part-way is exactly the case where cdkd cannot say whether the guard
    // is back on, so the caller does not depend on it.
    let outcome: ProtectionCompensationOutcome = 'failed';
    try {
      outcome = await compensateRemovedDeletionProtection({
        flip,
        error,
        logicalId,
        physicalId,
        typeLabel: 'table',
        logger: this.logger,
        mask: context?.maskSecrets,
        ...(context?.expectedRegion ? { region: context.expectedRegion } : {}),
        reEnable: async () => {
          await this.dynamoDBClient.send(
            new UpdateTableCommand({
              TableName: physicalId,
              DeletionProtectionEnabled: true,
            })
          );
        },
      });
    } catch {
      // `catch`, not `finally`, and `outcome` stays `'failed'`.
      // `compensateRemovedDeletionProtection` does not throw by contract --
      // every arm is inside its own try/catch -- but a LOGGER that throws
      // escapes it, and under `finally` that exception replaced the delete
      // error on its way out, so `throw error` below was never reached and
      // the caller saw the logger's message instead of "Failed to delete
      // DynamoDB table ...". Measured with a probe that made `logger.warn`
      // and `logger.error` throw. Catching keeps the ORIGINAL error's
      // identity while leaving the retain-on-unknown-outcome behaviour
      // exactly as it was: an outcome that never got assigned is `'failed'`,
      // so nothing is released.
    }
    {
      // TERMINAL failure whose compensation did not FAIL: drop the flip
      // record (issue #2244).
      //
      // Records are RETAINED on a throw by design -- that is what carries "an
      // earlier attempt already flipped the guard off" across the re-entered
      // `delete()` issue #1978's round 2 fixed. But the contract is about a
      // re-entry, and `isTerminalDeleteFailure` is the predicate that already
      // asserts none is coming: it MIRRORS `destroy-runner.ts`'s re-entry
      // condition. It is the same PREDICATE the compensation above consults,
      // NOT the same gate -- the compensation ANDs it with
      // `flip.flippedOffByThisRun` and `!flip.deleteAccepted`, so this
      // release also fires on the arms where the compensation early-returned
      // having done nothing. That is intended: a record with nothing to undo
      // has nothing left to serve either. So on this arm there is no second
      // attempt for the record to serve, and keeping it is not conservative
      // -- it is wrong in the one direction the registry's own JSDoc names.
      // A provider is REGISTERED once, so every delete served by the same
      // `ProviderRegistry` reaches this same INSTANCE and therefore this same
      // registry -- the deploy engine's own deletes, and
      // `rollback-executor.ts`, which takes that registry from its context
      // rather than building one. (`destroy-runner.ts` DOES build a fresh
      // registry when a stack's region differs, so the sharing is per
      // registry rather than per process; the key is region-qualified for the
      // same reason.) A second destroy of the same `region\0name` key inside
      // the reuse window would inherit that latch and answer its own terminal
      // failure with an `UpdateTable(DeletionProtectionEnabled: true)` the
      // user never asked for. Issue #2211's SLIDE widened that window from "a
      // full window after the FIRST attempt" to "a full window after the
      // LAST", which is what turned this from implicit into worth closing.
      //
      // WHAT THE GUARD ACTUALLY IS ON EACH RELEASING ARM, because "the
      // compensation has just put it BACK ON" is true of only one of them:
      //
      //  - `restored` -- the re-enable landed, so the guard is back on and a
      //    retained `flippedOffByThisRun: true` describes a world that no
      //    longer exists.
      //  - `not-applicable` because `flippedOffByThisRun` is false -- this run
      //    never turned the guard off, so there is nothing to describe.
      //  - `not-applicable` because `deleteAccepted` is true -- the guard IS
      //    still off, but AWS has taken the `DeleteTable` and the table is
      //    `DELETING`, so there is no live guard for a later delete to owe
      //    anything to.
      //  - `not-applicable` because the error is retryable -- unreachable
      //    here, since the same predicate gates this release.
      //
      // NOT released when the compensating `UpdateTable` itself FAILED, and
      // that arm is the reason this reads an outcome at all. There the guard
      // really is off and cdkd really is the one that turned it off, so the
      // record is the only in-process memory that a re-enable is still owed
      // -- and a later delete of the same key retrying it is the action cdkd
      // owes, not one nobody asked for. Releasing it instead makes that later
      // delete observe the guard already off, record
      // `flippedOffByThisRun: false` and compensate NOTHING, so a table cdkd
      // stripped stays stripped. Two state records CAN name one physical
      // table -- `cdkd import` adopts the same table into a second stack --
      // so this is reachable by the same route that justifies the release
      // itself. (An earlier revision released here too, calling the retry
      // "speculative". It is not, and the two arguments could not both
      // stand.) The failed re-enable is still reported with the command that
      // fixes it; retention is what lets cdkd fix it on its own.
      //
      // THE THREE ROUTES OUT OF THIS `catch`, since the predicate answers
      // them differently and only one of them is obvious:
      //
      //  - **Retryable** (a throttle on any attempt but the outer loop's
      //    last). The predicate is FALSE, so nothing is released and the
      //    retained-on-throw contract stands exactly as it did. On the LAST
      //    attempt the destroy loop's `runDeleteAttempt` scope makes the
      //    same throttle TERMINAL (issue #4318), so the compensation runs and
      //    this release follows it, as on the ordinary route.
      //  - **Interrupt** (Ctrl-C). `isInterruptedWaitError` makes it TERMINAL,
      //    so the release fires -- and it is the route that most needs it. The
      //    run is being torn down, no re-entry is coming, and the compensation
      //    above has just re-enabled the guard (on the `restored` arm -- a
      //    compensation that FAILED retains instead, and one that was
      //    `not-applicable` had nothing to put back); the process can still outlive
      //    the abort long enough for a rollback or a sibling stack's destroy
      //    to reach the same key. Pinned by its own case, since a claim in a
      //    comment that no test composes is one a refactor can quietly break.
      //  - **Deadline** (`--resource-timeout`). This release does NOT fire, and
      //    cannot: `src/deployment/resource-deadline.ts` rejects the OUTER
      //    promise on its timer without cancelling what it wraps, so no
      //    `ResourceTimeoutError` ever enters this `catch` (known narrowing 2,
      //    the same non-cancelling shape issue #1955 documents). The record
      //    stays latched behind an attempt that is still polling, which is
      //    correct: that attempt has not finished, and when it does it reaches
      //    either the success release or this one.
      //
      // The delete ALLOWANCE is deliberately left alone, and NOT because a
      // re-entry might still spend it -- this arm's whole premise is that no
      // re-entry is coming. It is out of scope: this change is about the flip
      // record, the two registries differ in what an inherited entry can DO
      // (an inherited allowance can only make a later delete give up sooner,
      // never issue a write nobody asked for), and `ElapsedBudgetRegistry`'s
      // window is FIXED rather than sliding, so it ages out from its own
      // creation regardless of what happens here.
      if (isTerminalDeleteFailure(error) && outcome !== 'failed') {
        this.protectionFlips.release(deleteBudgetKey(physicalId, context?.expectedRegion));
      }
    }
    throw error;
  }
}

export async function deleteTableResource(
  this: DynamoDBTableProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  context: DeleteContext | undefined,
  flip: ProtectionFlipRecord
): Promise<void> {
  this.logger.debug(`Deleting DynamoDB table ${logicalId}: ${physicalId}`);

  // ONE allowance for every wait below (issue #1955). Acquired before the
  // FIRST call so the `--remove-protection` ACTIVE wait is inside it too, and
  // acquired from the registry so a re-entry after a throttle CONTINUES this
  // clock rather than restarting it — see the field's own note and
  // `./dynamodb-delete-budget.ts`.
  // The index-busy loop's sink (go-to-k/cdkd#2319): `withRetry`'s debug line
  // quotes AWS's raw message, which echoes the table name.
  const loopLogger = maskedLogger(this.logger, context?.maskSecrets, physicalId);
  const budget = this.deleteBudgets.acquire(
    deleteBudgetKey(physicalId, context?.expectedRegion),
    resolveDynamoDbDeleteBudgetMs(),
    resolveDynamoDbDeleteBudgetClock(),
    // Entries are retained on a throw so the outer loop's re-entry keeps
    // spending this clock — but "retained" must not mean "forever". Past the
    // deadline the allowance is sized against, that deadline has certainly
    // fired, so any caller arriving now belongs to a NEW operation.
    DELETE_BUDGET_REUSE_WINDOW_MS
  );

  // `--remove-protection`: flip DeletionProtectionEnabled off before
  // delete. UpdateTable is async — wait for ACTIVE before issuing
  // DeleteTable so the delete doesn't race the still-UPDATING table.
  // Idempotent — DynamoDB accepts the call when protection is already
  // disabled. Non-fatal: log at debug if the flip-off itself errors
  // (NotFound / similar) so the delete still proceeds.
  if (context?.removeProtection === true) {
    try {
      // OBSERVE before flipping (issue #1978). Only a guard that was ON and
      // that THIS run turned off may be put back on the error path — a table
      // the user had already left unprotected must come out of a failed
      // destroy exactly as it went in. Best-effort like the flip itself: a
      // describe failure leaves the record false, which means "do not know,
      // so do not touch", and the delete proceeds either way. Deliberately
      // NOT read from the state properties: state can be stale, and what has
      // to be restored is what AWS actually had.
      let observedProtectionOn = false;
      try {
        const before = await this.dynamoDBClient.send(
          new DescribeTableCommand({ TableName: physicalId })
        );
        observedProtectionOn = before.Table?.DeletionProtectionEnabled === true;
      } catch (observeError) {
        // Masked (#5180): the physical id can carry a dynamic-reference
        // plaintext, and AWS's text quotes it.
        const mask = maskerOrIdentity(context?.maskSecrets);
        this.logger.debug(
          mask(
            safeMsg`Could not read DeletionProtectionEnabled on ${mask(physicalId)} before disabling it: ${mask(describeAwsFailure(observeError).detail)}`
          )
        );
      }
      await this.dynamoDBClient.send(
        new UpdateTableCommand({
          TableName: physicalId,
          DeletionProtectionEnabled: false,
        })
      );
      // Set only AFTER AWS accepted the flip: a rejected `UpdateTable` left
      // the guard where it was, so there is nothing to compensate.
      //
      // LATCHED, never assigned: on a re-entry the observation above reports
      // the guard OFF because the PREVIOUS attempt turned it off, so
      // `flip.flippedOffByThisRun = observedProtectionOn` would erase what
      // that attempt recorded and the terminal failure here would compensate
      // nothing (issue #1978). The record is cleared by `release()` on a
      // terminal outcome, which is what stops the latch from outliving the
      // delete it belongs to.
      if (observedProtectionOn) flip.flippedOffByThisRun = true;
      this.logger.debug(
        `Disabled DeletionProtectionEnabled on DynamoDB table ${logicalId}, waiting for ACTIVE`
      );
      try {
        await this.waitForTableActiveAfterUpdate(physicalId, TABLE_ACTIVE_WAIT_ATTEMPTS, budget);
      } catch (waitErr) {
        this.logger.debug(
          maskerOrIdentity(context?.maskSecrets)(
            `Could not wait for table ${physicalId} ACTIVE after disabling protection: ${describeAwsFailure(waitErr).detail}`
          )
        );
      }
    } catch (flipError) {
      if (!(flipError instanceof ResourceNotFoundException)) {
        this.logger.debug(
          maskerOrIdentity(context?.maskSecrets)(
            `Could not disable DeletionProtectionEnabled on ${physicalId}: ${describeAwsFailure(flipError).detail}`
          )
        );
      }
    }
  }

  try {
    // AWS refuses `DeleteTable` while a GSI is transitioning
    // (`Cannot delete table while indexes are being created, updated, or
    // deleted`), and the condition is TRANSIENT: a real destroy lost a table
    // to it and the very next `cdkd destroy` succeeded with no other change
    // (issue #1830, measured on the sibling `AWS::DynamoDB::GlobalTable`
    // type). Application auto-scaling can start an index capacity change at
    // any moment, so any table with an autoscaled GSI can hit it — this
    // provider simply had no retry, so it surfaced as a hard
    // `PartialFailureError` with state preserved and the user re-ran a
    // destroy for something that clears itself in seconds (issue #1931).
    //
    // The rule is the sibling provider's, READ rather than re-spelled: the
    // classifier, the retry budget, the bounded re-arm and the warning all
    // come from `../dynamodb-index-busy-delete.ts`. Its settle wait reads
    // vector indexes too (go-to-k/cdkd#5574), so a refusal while one builds
    // waits for it rather than spending each retry on backoff alone.
    //
    // Deliberately NO pre-delete describe / settle gate here (the sibling's
    // #1521 gate). The only thing that can precede this `DeleteTable` is the
    // `--remove-protection` flip above (an `UpdateTable` plus a <=60s wait
    // for ACTIVE), and that wait watches the TABLE status, not the index
    // ones — so nothing here closes the index-busy window, and there is no
    // window of its own to close either. Adding a fresh index describe would
    // only shrink the race the retry exists to absorb — and the integ arm
    // races exactly that window, so it would stop discriminating.
    // Recomputed per re-arm rather than once: the loop runs for minutes and
    // the allowance drains as it goes, so a value captured when the options
    // bag was built would hand the LAST retry the FIRST retry's budget.
    const reArmPolls = (): {
      maxAttempts: number;
      budgetWait: ReturnType<typeof beginDeleteWait>;
      shortCapUnlessVectorBusy: number;
    } => {
      // go-to-k/cdkd#5574: granted the LONG vector-index cap, which the
      // wait uses only while a vector index alone is building; a GSI still
      // stops at the short re-arm. The shared allowance bounds either.
      const wait = beginDeleteWait(VECTOR_INDEX_BUSY_REARM_MAX_ATTEMPTS, budget);
      return {
        maxAttempts: wait.grantedPolls,
        budgetWait: wait,
        shortCapUnlessVectorBusy: DELETE_INDEX_BUSY_REARM_MAX_ATTEMPTS,
      };
    };
    await deleteTableWithIndexBusyRetry({
      logicalId,
      physicalId,
      typeLabel: 'table',
      indexNoun: TABLE_INDEX_NOUN,
      // THIS type's budget. The two DynamoDB types no longer share one: the
      // sibling reaches this loop with the #1521 gate's ~18 min already spent
      // out of the same 30-min deadline, so it keeps the original 8 while
      // this path — whose only pre-cost is the ACTIVE wait above — carries 14
      // (issue #1950; the derivation for both is on the constant).
      maxRetries: TABLE_DELETE_INDEX_BUSY_MAX_RETRIES,
      logger: loopLogger,
      deleteTable: async () => {
        await this.dynamoDBClient.send(new DeleteTableCommand({ TableName: physicalId }));
        // AWS TOOK the delete. Nothing after this line may put the guard back
        // — the table is `DELETING`, so a later throw on this path is a wait
        // failing rather than the delete (issue #1978). Recorded here rather
        // than inferred from the error, because a wait's own timeout message
        // is indistinguishable from a terminal refusal. The post-delete
        // gone-wait below never throws, but the record is set on both
        // DynamoDB types so the halves cannot drift.
        flip.deleteAccepted = true;
      },
      // Re-arm on the CONDITION, not on the clock: an index backfill outlasts
      // any fixed backoff grid, while this poll returns on its first
      // `DescribeTable` once the index has settled. BOUNDED — it runs per
      // retry, so the loop's wall clock is the product and
      // `destroy-runner.ts` runs this delete under a per-resource deadline
      // (30 min by default, and since issue #1955 this provider self-reports
      // that same figure so a lowered `--resource-timeout` cannot shrink it).
      // At `DELETE_INDEX_BUSY_REARM_MAX_ATTEMPTS` the whole loop's worst case
      // is ~18.4 min (issue #1950 raised THIS type's retry budget to 14; the
      // full arithmetic is on `TABLE_DELETE_INDEX_BUSY_MAX_RETRIES`), so a
      // genuinely stuck index still ends in AWS's own actionable sentence
      // rather than a generic `ResourceTimeoutError` that never mentions
      // indexes. On THIS provider the only other thing sharing that deadline
      // is the `--remove-protection` ACTIVE wait above (<=60 polls, ~72s),
      // which the budget is sized with — the whole `delete()` worst case is
      // ~19.6 min against the 30-min deadline, two thirds of it. That figure
      // is the GSI case; a building VECTOR index may hold one wait up to
      // `VECTOR_INDEX_BUSY_REARM_MAX_ATTEMPTS` (go-to-k/cdkd#5574), and there
      // the shared allowance below, not the poll count, is the path's bound.
      //
      // That deadline wraps `destroy-runner.ts`'s OUTER retry loop, not a
      // single `delete()` — up to 4 calls share it. This refusal matches no
      // `RETRYABLE_ERROR_MESSAGE_PATTERNS` entry, so the outer loop never
      // re-invokes `delete()` for IT — but a THROTTLED `DeleteTable` on the
      // same call is a different message and DOES re-enter, paying the whole
      // sequence twice inside one deadline (2 x ~19.6 min ~= ~39 min after
      // #1950). That is issue #1955's third term, and the `budget` below is
      // what bounds it: it is keyed by physical id, so the second pass
      // CONTINUES the first pass's clock instead of restarting it.
      reArm: () =>
        waitForIndexesSettled({
          tableName: physicalId,
          logicalId,
          logger: loopLogger,
          describeTable: () =>
            this.dynamoDBClient.send(new DescribeTableCommand({ TableName: physicalId })),
          // The smaller of this loop's own re-arm cap and what the shared
          // delete budget can still afford (issue #1955) — and when the
          // allowance is what cut it, the give-up warning says so rather than
          // quoting the clamped count as the wait AWS was given.
          ...reArmPolls(),
          proceedNote: DELETE_INDEX_WAIT_PROCEED_NOTE,
        }),
      // The wall-clock half of the loop's bound, and the term that closes the
      // throttle-compounding case: the budget is shared with the re-entry, so
      // a second pass inherits what the first one already spent and the pair
      // can no longer reach ~39 min inside a 30-minute deadline.
      // `isRetryable` ANDs this with the index-busy classifier, so an
      // exhausted budget makes AWS's refusal terminal — which is what
      // surfaces its actionable message instead of the deadline's generic
      // one, with nothing still polling behind the failed run.
      shouldKeepRetrying: () => {
        if (!budget.isExhausted()) return true;
        loopLogger.warn(
          `DynamoDB table ${logicalId}: giving up the index-busy DeleteTable retry on ` +
            `${physicalId} — the delete path has spent its whole ` +
            `${Math.round(budget.totalMs / 60_000)}-minute budget, so the destroy fails on ` +
            `AWS's refusal; re-running it succeeds once the index is ACTIVE.`
        );
        return false;
      },
      sleepSeam: deleteTableRetryDelays,
    });
    // go-to-k/cdkd#5514: `DeleteTable` returns with the table `DELETING`,
    // and CloudFormation reports DELETE_COMPLETE only once it is gone. A
    // destroy that returned here let a same-name re-deploy hit
    // `ResourceInUseException`, a dependent (a KMS key, a role) be deleted
    // under a live table, and a gone-probe right after the destroy see it.
    // The delete is ACCEPTED, so the wait never throws: a cap, a Ctrl-C or
    // an unreadable status warns and returns (`delete-gone-wait.ts`). Only
    // a typed `ResourceNotFoundException` reads as gone. Clamped to what
    // the shared delete budget still has, so the path stays under the
    // per-resource deadline (issue #1955).
    const mask = maskerOrIdentity(context?.maskSecrets);
    await waitForGoneAfterDelete({
      what: mask(`DynamoDB table ${physicalId}`),
      resourceType,
      describe: async () => {
        try {
          const out = await this.dynamoDBClient.send(
            new DescribeTableCommand({ TableName: physicalId })
          );
          return out.Table?.TableStatus ?? 'UNKNOWN';
        } catch (describeError) {
          if (describeError instanceof ResourceNotFoundException) return undefined;
          throw describeError;
        }
      },
      logger: loopLogger,
      pollIntervalMs: tableDeleteGoneWait.pollIntervalMs,
      maxWaitMs: Math.min(tableDeleteGoneWait.maxWaitMs, budget.remainingMs()),
    });
    this.logger.debug(`Successfully deleted DynamoDB table ${logicalId}`);
    // TERMINAL success — the allowance has no second pass to fund, and the
    // flip record has nothing left to undo. Released together and keyed
    // together: a retained record would let a LATER destroy of a table with
    // the same name inherit this run's flip.
    this.deleteBudgets.release(deleteBudgetKey(physicalId, context?.expectedRegion));
    this.protectionFlips.release(deleteBudgetKey(physicalId, context?.expectedRegion));
  } catch (error) {
    if (error instanceof ResourceNotFoundException) {
      const clientRegion = await this.dynamoDBClient.config.region();
      assertRegionMatch(clientRegion, context?.expectedRegion, resourceType, logicalId, physicalId);
      if (context?.failedCreateOrphan === true) {
        // go-to-k/cdkd#4606: a journaled orphan already gone settles with
        // exit 0, so say so once. Masked by the caller's printing bag.
        this.logger.info(
          safeMsg`  DynamoDB table ${physicalId} (${logicalId}), which a failed deploy created, is already gone; nothing to delete`
        );
      } else {
        this.logger.debug(`DynamoDB table ${physicalId} does not exist, skipping deletion`);
      }
      this.deleteBudgets.release(deleteBudgetKey(physicalId, context?.expectedRegion));
      // The table is GONE, so there is no guard to restore, and reaching this
      // line means `delete()` RETURNS rather than throwing — so the
      // compensation never runs on it. Released for the same hygiene as the
      // success path. Note the release is NOT reached when the
      // `assertRegionMatch` above throws: the record stays latched THROUGH
      // the compensation on purpose (the re-entered-delete contract), so its
      // own `UpdateTable` still goes out and is answered with the same
      // ResourceNotFound — which `compensateRemovedDeletionProtection`
      // reports at WARN, dropping the CLAIM that the table is live rather
      // than the line itself, because RNF from `UpdateTable` also covers a
      // live table whose status is merely not ACTIVE (issue #2224; an earlier
      // revision of this comment said `debug`, which that issue's fix
      // deliberately did not ship). `delete()`'s own `catch` then KEEPS the
      // record on that arm (issue #2244): the failure is terminal, but the
      // compensation reports `failed`, and a re-enable that did not land is
      // one cdkd still owes -- so a later delete of the same key may retry
      // it. Pinned by the `#2224` case in
      // `dynamodb-remove-protection-compensate.test.ts`.
      this.protectionFlips.release(deleteBudgetKey(physicalId, context?.expectedRegion));
      return;
    }
    // Deliberately NOT released on a throw: the outer retry loop may re-enter
    // `delete()` inside the SAME deadline (it classes throttles as
    // retryable), and that second pass has to keep spending this allowance
    // rather than start a fresh one. That is the compounding term of issue
    // #1955.
    const cause = error instanceof Error ? error : undefined;
    const thrown = this.wrapCaughtError(
      context?.maskSecrets,
      error,
      (text) =>
        new ProvisioningError(
          `Failed to delete DynamoDB table ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          physicalId,
          cause
        )
    );
    // The wrap names an AWS failure by its CLASS, and the delete classifiers
    // read `NotFoundException` in a message as "already deleted": only the
    // typed not-found above means this table is gone (go-to-k/cdkd#2319).
    throw error instanceof Error && error.name.includes('NotFound') ? markNotGone(thrown) : thrown;
  }
}
