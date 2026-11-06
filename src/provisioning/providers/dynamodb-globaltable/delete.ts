import {
  DeleteTableCommand,
  DescribeTableCommand,
  UpdateTableCommand,
  ResourceNotFoundException,
} from '@aws-sdk/client-dynamodb';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import { ProvisioningError } from '../../../utils/error-handler.js';
import { markDeleteStarted, type DeleteProgress } from '../../delete-started.js';
import { assertRegionMatch, type DeleteContext } from '../../region-check.js';
import { isInterruptedWaitError } from '../../interrupt-watch.js';
import {
  DELETE_INDEX_BUSY_REARM_MAX_ATTEMPTS,
  GLOBAL_TABLE_DELETE_INDEX_BUSY_MAX_RETRIES,
  DELETE_INDEX_WAIT_PROCEED_NOTE,
  TABLE_INDEX_NOUN,
  VECTOR_INDEX_BUSY_REARM_MAX_ATTEMPTS,
  deleteTableWithIndexBusyRetry,
  hasTransitionalTableIndex,
  maskedLogger,
} from '../../dynamodb-index-busy-delete.js';
import {
  DYNAMODB_DELETE_MIN_RESOURCE_TIMEOUT_MS as DELETE_BUDGET_REUSE_WINDOW_MS,
  compensateRemovedDeletionProtection,
  deleteBudgetKey,
  isTerminalDeleteFailure,
  resolveDynamoDbDeleteBudgetClock,
  resolveDynamoDbDeleteBudgetMs,
  type ProtectionCompensationOutcome,
  type ProtectionFlipRecord,
} from '../dynamodb-delete-budget.js';
import { waitForGoneAfterDelete } from '../../delete-gone-wait.js';
import { createMaskedLogSinks } from '../../masked-retry-logger.js';
import type { SecretMasker } from '../../../types/resource.js';
import { safeMsg } from '../../../utils/display-safe.js';
import {
  REPLICA_GONE_WAIT_ATTEMPTS,
  GLOBAL_TABLE_ACTIVE_WAIT_ATTEMPTS,
  TABLE_GONE_WAIT_ATTEMPTS,
  replicaDeleteGoneWait,
  deleteTableRetryDelays,
} from './capacity.js';
import type { DynamoDBGlobalTableProvider } from '../dynamodb-globaltable-provider.js';

/**
 * Delete a DynamoDB Global Table.
 *
 * Order is load-bearing:
 *  1. Optional `--remove-protection` flip-off (idempotent).
 *  2. `DescribeTable` → drop every non-local replica via UpdateTable
 *     `ReplicaUpdates: [{ Delete: { RegionName } }]`, one at a time
 *     (AWS rejects multiple replica updates per call). Each delete
 *     polls until the replica disappears from `Replicas[]`.
 *  3. `DeleteTableCommand` on the local region only.
 *  4. Wait for `ResourceNotFoundException` on subsequent DescribeTable.
 *
 * DELETE idempotency: a `ResourceNotFoundException` is treated as
 * success ONLY when the client region matches the state region
 * (`assertRegionMatch`). A mismatched destroy would otherwise silently
 * strip a still-existing resource from state.
 */
export async function deleteResource(
  this: DynamoDBGlobalTableProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  _properties?: Record<string, unknown>,
  context?: DeleteContext
): Promise<void> {
  // `--remove-protection` compensation (issue #1978). The sibling
  // `AWS::DynamoDB::Table` provider's wrapper is the same MECHANISM line for
  // line -- it is not byte-identical, since it lacks this header, names
  // `deleteTableResource`, and passes `typeLabel: 'table'` -- and the two are
  // kept in step for a reason: the two types share one root cause with two
  // sites, and the #1955 review had already caught a half-applied twin in
  // this pair.
  //
  // The window is WIDER on this type than on the sibling. Between the flip
  // and the `DeleteTable` sit the client-region resolve, the pre-delete
  // describe, the auto-scaling teardown and one `waitForReplicaGone` per
  // non-local replica — twelve minutes apiece, and interruptible since issue
  // #2053, which is the Ctrl-C route recorded on the issue. Catching at the
  // method boundary covers all of them; a `catch` on the `DeleteTable` `try`
  // alone would cover none.
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
  // go-to-k/cdkd#4946: set once a step before `DeleteTable` may have changed
  // the table, so a refused delete is never read as a whole survivor.
  const progress: DeleteProgress = { stripped: false };
  try {
    await this.deleteGlobalTableResource(
      logicalId,
      physicalId,
      resourceType,
      context,
      flip,
      progress
    );
  } catch (error) {
    if (progress.stripped) markDeleteStarted(error);
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
        typeLabel: 'GlobalTable',
        logger: this.logger,
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

export async function deleteGlobalTableResource(
  this: DynamoDBGlobalTableProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  context: DeleteContext | undefined,
  flip: ProtectionFlipRecord,
  progress: DeleteProgress
): Promise<void> {
  // go-to-k/cdkd#2007: the table name can be secret-derived. The name is
  // masked as a VALUE too, so one below the substring floor is caught.
  const deleteMask: SecretMasker = context?.maskSecrets ?? ((text: string) => text);
  // The sinks the two thrown wraps below route AWS's withheld text through.
  const deleteLog = createMaskedLogSinks(this.logger, deleteMask);
  const loopLogger = maskedLogger(this.logger, context?.maskSecrets, physicalId);
  const shownTable = deleteMask(physicalId);
  this.logger.debug(deleteMask(`Deleting DynamoDB GlobalTable ${logicalId}: ${shownTable}`));

  // ONE allowance for every wait below (issue #1955). Acquired before the
  // FIRST call, so the `--remove-protection` flip's ACTIVE wait is both
  // MEASURED by this clock and CLAMPED by it — the two are separate
  // properties and an earlier revision had only the first, which left that
  // wait free to spend ~12 min of a budget it was nonetheless draining.
  // Acquired from the registry so a re-entry after a throttle CONTINUES this
  // clock rather than restarting it — see the field's own note and
  // `./dynamodb-delete-budget.ts`.
  const budget = this.deleteBudgets.acquire(
    deleteBudgetKey(physicalId, context?.expectedRegion),
    resolveDynamoDbDeleteBudgetMs(),
    resolveDynamoDbDeleteBudgetClock(),
    // Entries are retained on a throw so the outer loop's re-entry keeps
    // spending this clock — but "retained" must not mean "forever". Past the
    // deadline the allowance is sized against, that deadline has certainly
    // fired, so any caller arriving now belongs to a NEW operation and gets a
    // new allowance. Without this, a provider instance shared across
    // operations (the deploy engine hands the same registry to
    // `rollback-executor.ts`) could hand a fresh delete a spent budget.
    DELETE_BUDGET_REUSE_WINDOW_MS
  );

  if (context?.removeProtection === true) {
    // Idempotent flip-off — AWS accepts the no-op already-disabled case.
    try {
      // OBSERVE before flipping (issue #1978). Only a guard that was ON and
      // that THIS run turned off may be put back on the error path — a table
      // the user had already left unprotected must come out of a failed
      // destroy exactly as it went in. Best-effort like the flip itself: a
      // describe failure leaves the record false, which means "do not know,
      // so do not touch", and the delete proceeds either way. Deliberately
      // NOT read from the state properties: state can be stale, and what has
      // to be restored is what AWS actually had.
      //
      // This is a SECOND `DescribeTable` on this path — the pre-delete one
      // further down cannot serve, because it runs after the flip and would
      // therefore report the value cdkd just wrote.
      let observedProtectionOn = false;
      try {
        const before = await this.dynamoDBClient.send(
          new DescribeTableCommand({ TableName: physicalId })
        );
        observedProtectionOn = before.Table?.DeletionProtectionEnabled === true;
      } catch (observeError) {
        this.logger.debug(
          deleteMask(
            `Could not read DeletionProtectionEnabled on ${shownTable} before disabling it: ${describeAwsFailure(observeError).detail}`
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
      this.logger.debug(`Disabled DeletionProtectionEnabled on ${logicalId}, waiting for ACTIVE`);
      try {
        await this.waitForTableActiveAfterUpdate(
          physicalId,
          logicalId,
          GLOBAL_TABLE_ACTIVE_WAIT_ATTEMPTS,
          budget,
          context?.maskSecrets
        );
      } catch (waitErr) {
        this.logger.debug(
          deleteMask(
            `Could not wait for table ${shownTable} ACTIVE after protection flip: ${describeAwsFailure(waitErr).detail}`
          )
        );
      }
    } catch (flipError) {
      if (!(flipError instanceof ResourceNotFoundException)) {
        this.logger.debug(
          deleteMask(
            `Could not disable DeletionProtectionEnabled on ${shownTable}: ${describeAwsFailure(flipError).detail}`
          )
        );
      }
    }
  }

  let currentRegion: string;
  try {
    currentRegion = await this.dynamoDBClient.config.region();
  } catch (regionErr) {
    const cause = regionErr instanceof Error ? regionErr : undefined;
    throw new ProvisioningError(
      `Could not resolve client region for DynamoDB GlobalTable ${logicalId} delete — would risk dropping the local replica`,
      resourceType,
      logicalId,
      physicalId,
      cause
    );
  }

  // Drop every non-local replica first. GlobalTable cannot be deleted
  // while it has additional replicas — AWS rejects DeleteTable.
  // ALSO tear down per-replica autoscaling targets (read dim) BEFORE
  // the replica delete, AND the table-level autoscaling target
  // (write dim) BEFORE the DeleteTable call. Without these,
  // `RegisterScalableTarget` + `PutScalingPolicy` survive in AWS's
  // application-autoscaling control plane indefinitely; a future
  // create of the same `tableName` (same region) inherits the orphan
  // target silently. PR #403 code-reviewer caught this as a blocker.
  // Captured from the pre-delete describe so the #1521 index-settled gate
  // below needs no second call.
  let preDeleteTable:
    | {
        readonly GlobalSecondaryIndexes?:
          | ReadonlyArray<{ readonly IndexStatus?: string | undefined }>
          | undefined;
        readonly VectorIndexes?:
          | ReadonlyArray<{ readonly IndexStatus?: string | undefined }>
          | undefined;
      }
    | undefined;
  // go-to-k/cdkd#2762: the index-busy lines name a vector index only on a
  // table that has one, so every other table's text stays as it was.
  let indexNoun: string | undefined;
  // go-to-k/cdkd#5699: the regions whose replica this delete dropped, so the
  // destroy waits for each regional copy to be gone, not only for the
  // source table to stop listing it. Carried across a re-entry.
  const droppedKey = deleteBudgetKey(physicalId, context?.expectedRegion);
  const droppedReplicaRegions = this.droppedReplicaRegions.get(droppedKey) ?? new Set<string>();
  this.droppedReplicaRegions.set(droppedKey, droppedReplicaRegions);
  try {
    const describe = await this.dynamoDBClient.send(
      new DescribeTableCommand({ TableName: physicalId })
    );
    const replicas = describe.Table?.Replicas ?? [];
    // Index names come from AWS, not from the template: `delete()` may be
    // running against state whose properties are stale, and an orphaned
    // scalable target is only findable by the index that actually exists.
    preDeleteTable = describe.Table;
    if ((describe.Table?.VectorIndexes ?? []).length > 0) indexNoun = TABLE_INDEX_NOUN;
    const tableIndexNames = (describe.Table?.GlobalSecondaryIndexes ?? [])
      .map((gsi) => gsi.IndexName)
      .filter((name): name is string => typeof name === 'string');
    for (const replica of replicas) {
      const region = replica.RegionName;
      if (!region || region === currentRegion) continue;
      try {
        // Tear down the cross-region replica's read autoscaling
        // BEFORE deleting the replica (best-effort) — table level first,
        // then every per-index read target in that region (Issue #1419).
        await this.applyAutoScalingDiff(
          physicalId,
          'dynamodb:table:ReadCapacityUnits',
          {} /* oldSettings — placeholder; non-undefined forces teardown */,
          undefined /* newSettings — undefined triggers Delete+Deregister */,
          this.getRegionalAutoScalingClient(region),
          undefined /* indexName — table level */,
          budget,
          deleteMask,
          progress
        );
        // Index names come from the TABLE's index list, not the replica's
        // own `GlobalSecondaryIndexes`. A GlobalTable replicates every
        // index to every replica, but the per-replica entry is documented
        // as "replica-specific settings" and its sibling
        // `ProvisionedThroughputOverride` says "if not described, uses the
        // source table's" — so a replica that inherits throughput can come
        // back with the list omitted entirely, and every
        // `dynamodb:index:ReadCapacityUnits` target in that region would
        // leak past `DeleteTable`.
        for (const indexName of tableIndexNames) {
          await this.applyAutoScalingDiff(
            physicalId,
            'dynamodb:index:ReadCapacityUnits',
            {},
            undefined,
            this.getRegionalAutoScalingClient(region),
            indexName,
            budget,
            deleteMask,
            progress
          );
        }
        await this.dropReplicaForDelete(
          physicalId,
          region,
          context?.removeProtection === true,
          logicalId,
          budget,
          deleteMask
        );
        progress.stripped = true;
        await this.waitForReplicaGone(
          physicalId,
          region,
          logicalId,
          REPLICA_GONE_WAIT_ATTEMPTS,
          budget,
          context?.maskSecrets
        );
        droppedReplicaRegions.add(region);
        // go-to-k/cdkd#5581: the read teardown above names only the read
        // dimension; DynamoDB also registered the replica's WRITE target
        // there, which survives the replica and the table.
        await this.deregisterRemovedReplicaScalableTargets(physicalId, region, {
          budget,
          maskSecrets: deleteMask,
          progress,
        });
      } catch (replicaErr) {
        // Table itself already gone — outer DeleteTable will handle
        // idempotency (the region check below ensures a mismatched
        // destroy doesn't silently strip state).
        if (!(replicaErr instanceof ResourceNotFoundException)) {
          throw replicaErr;
        }
      }
    }
    // Tear down the LOCAL replica's read autoscaling AND the table-
    // level write autoscaling before `DeleteTable`. Same orphan-leak
    // concern: surviving scaling targets would inherit on re-create.
    const localAsClient = await this.getLocalAutoScalingClient();
    await this.applyAutoScalingDiff(
      physicalId,
      'dynamodb:table:ReadCapacityUnits',
      {},
      undefined,
      localAsClient,
      undefined /* indexName — table level */,
      budget,
      deleteMask,
      progress
    );
    await this.applyAutoScalingDiff(
      physicalId,
      'dynamodb:table:WriteCapacityUnits',
      {},
      undefined,
      localAsClient,
      undefined /* indexName — table level */,
      budget,
      deleteMask,
      progress
    );
    // Per-index targets in the local region (Issue #1419). Without this
    // the index-level targets registered by `create()` / step 6b survive
    // `DeleteTable` and are silently inherited by a future table of the
    // same name — the same orphan-leak the table-level teardown above
    // exists to prevent, one level down.
    for (const indexName of tableIndexNames) {
      await this.applyAutoScalingDiff(
        physicalId,
        'dynamodb:index:WriteCapacityUnits',
        {},
        undefined,
        localAsClient,
        indexName,
        budget,
        deleteMask,
        progress
      );
      await this.applyAutoScalingDiff(
        physicalId,
        'dynamodb:index:ReadCapacityUnits',
        {},
        undefined,
        localAsClient,
        indexName,
        budget,
        deleteMask,
        progress
      );
    }
  } catch (describeErr) {
    // An already-actionable `ProvisioningError` passes through VERBATIM.
    // This block wraps far more than the describe its message names — the
    // replica teardown loop and its `waitForReplicaGone` run inside it — so a
    // replica that never disappeared used to surface as
    // `Failed to describe DynamoDB GlobalTable X before delete: Replica
    // us-west-2 ... did not disappear`, a describe failure that did not
    // happen, while the real residue (a replica removal still in flight, the
    // local auto-scaling teardown skipped, no `DeleteTable` issued) went
    // unnamed. Pre-existing, and reachable more often now that the shared
    // allowance can cut the replica wait short on a third replica or on a
    // re-entry. Same rule the `Table` provider's `update()` catch already
    // uses: never double-wrap an error that already says what went wrong.
    if (describeErr instanceof ProvisioningError) throw describeErr;
    // Same passthrough, same reason (issue #2053 review): this catch wraps
    // far more than the describe its message names — the replica teardown
    // loop and `waitForReplicaGone` run inside it — so a user abort surfaced
    // as `Failed to describe DynamoDB GlobalTable X before delete: ...`, a
    // describe failure that did not happen. That is the exact double-wrap the
    // comment below already claims was fixed for the replica case.
    if (isInterruptedWaitError(describeErr)) throw describeErr;
    // An AWS-authored failure is reduced to its class (go-to-k/cdkd#2319):
    // this arm THROWS, so the text reaches the durable events store. The
    // typed RNF guard below returns before any wrap, so a class naming
    // another object's not-found here (an auto-scaling
    // `ObjectNotFoundException` from the replica teardown) is marked
    // `markNotGone`: the delete classifiers never read it as this table gone,
    // which keeps the state row.
    if (!(describeErr instanceof ResourceNotFoundException)) {
      const cause = describeErr instanceof Error ? describeErr : undefined;
      throw this.wrapDeleteError(
        deleteLog,
        describeErr,
        (text) =>
          new ProvisioningError(
            `Failed to describe DynamoDB GlobalTable ${logicalId} before delete: ${text}`,
            resourceType,
            logicalId,
            physicalId,
            cause
          )
      );
    }
    // RNF on the pre-delete DescribeTable — table already gone; the
    // region-match check on the DeleteTable RNF path below handles
    // idempotency.
  }

  try {
    // AWS refuses `DeleteTable` while an index is transitioning
    // (`Cannot delete table while indexes are being created, updated, or
    // deleted`), and that is not a theoretical destroy failure: it is what
    // ORPHANED this fixture's table on 2026-08-10 after a deploy failed
    // mid-flip (issue #1521). Gated on what the PRE-DELETE describe above
    // already reported, so the overwhelmingly common case (no index in
    // flight) costs no extra call at all; only a table that really is
    // mid-transition pays for the poll. Best-effort — on timeout the delete
    // goes ahead and AWS's own error stays the backstop.
    if (hasTransitionalTableIndex(preDeleteTable)) {
      deleteLog.debug(`Waiting for indexes on ${physicalId} to settle before DeleteTable`);
      await this.waitForIndexesActive(physicalId, logicalId, {
        proceedNote: DELETE_INDEX_WAIT_PROCEED_NOTE,
        budget,
        ...(context?.maskSecrets && { maskSecrets: context.maskSecrets }),
      });
    }
    // ...and retry when AWS refuses ANYWAY (issue #1830). The gate above is
    // necessary but not sufficient: it reads the PRE-DELETE describe, which
    // is taken before the auto-scaling teardown loop above, and that loop
    // issues a long sequence of application-autoscaling calls. An index can
    // enter `UPDATING` inside that window — application auto-scaling can
    // start a capacity change on an autoscaled index at any moment — so a
    // table that was settled when we looked is not necessarily settled when
    // `DeleteTable` lands. Measured on a real `dynamodb-globaltable` destroy
    // (us-east-1, 2026-08-13): the delete failed, the very next `cdkd
    // destroy` succeeded with no other change. Surfacing that as a hard
    // `PartialFailureError` with state preserved makes the user re-run a
    // destroy for a condition that clears itself in seconds.
    //
    // The classifier, the budget, the re-arm bound and the warning line all
    // live in `../dynamodb-index-busy-delete.ts`, which
    // `dynamodb-table-provider.ts` reads too (issue #1931): the same AWS
    // refusal has to answer the same way on both DynamoDB types, and a
    // second spelling is a second chance for one of them to drift.
    await deleteTableWithIndexBusyRetry({
      logicalId,
      physicalId,
      typeLabel: 'GlobalTable',
      ...(indexNoun !== undefined && { indexNoun }),
      // THIS type's budget, deliberately UNCHANGED at 8 while issue #1950
      // raised the sibling `AWS::DynamoDB::Table` to 14 — see the comment on
      // the re-arm below, and the derivation on
      // `GLOBAL_TABLE_DELETE_INDEX_BUSY_MAX_RETRIES`.
      maxRetries: GLOBAL_TABLE_DELETE_INDEX_BUSY_MAX_RETRIES,
      // go-to-k/cdkd#2319: `withRetry`'s debug line quotes AWS's raw
      // message, which echoes the table name.
      logger: loopLogger,
      deleteTable: async () => {
        await this.dynamoDBClient.send(new DeleteTableCommand({ TableName: physicalId }));
        // AWS TOOK the delete. Nothing after this line may put the guard back
        // — the table is `DELETING`, so a later throw on this path is a wait
        // failing rather than the delete (issue #1978). That is not
        // hypothetical here: `waitForTableGone` below throws `Table X did not
        // disappear within Ns`, which matches no retryable pattern and is
        // therefore TERMINAL by the compensation's own predicate. Without
        // this record it would answer an accepted delete with an
        // `UpdateTable(true)` against a dying table and a log line calling
        // that table LIVE.
        flip.deleteAccepted = true;
      },
      // The re-arm is BOUNDED, and for a GSI deliberately far shorter than the
      // 15-minute poll the #1521 gate above uses: that gate runs ONCE, ahead
      // of the retry loop, while this one runs per retry, so the LOOP's wall
      // clock is the product. See {@link DELETE_INDEX_BUSY_REARM_MAX_ATTEMPTS}
      // for the arithmetic and for the per-resource deadline it stays under.
      //
      // That figure is the LOOP's, not `delete()`'s, and the difference used
      // to matter a great deal: the deadline is applied AROUND `delete()` —
      // in fact around `destroy-runner.ts`'s outer retry loop, which shares
      // one deadline across up to 4 `delete()` calls. The same call can
      // already have spent the #1521 gate's 900 polls (~18 min at the
      // measured ~1.2s per poll) just above, and 600 polls (~12 min) in
      // `waitForReplicaGone` per non-local replica before that, so a
      // REPLICATED table whose index is transitioning reached ~18 + 12 + 10.4
      // ~= 40 min and ended in exactly the generic `ResourceTimeoutError`
      // this bound exists to avoid (issue #1955).
      //
      // It no longer can. Every wait on this path — the replica waits, the
      // #1521 gate, this re-arm and the gone-wait below — now draws polls
      // from ONE shared `budget`, and the loop itself stops retrying when
      // that budget is spent, so `delete()` fails with AWS's own index-busy
      // sentence while the deadline still has minutes left rather than being
      // aborted mid-poll by a timer that does not cancel anything. The budget
      // is keyed by physical id, so the throttle re-entry that outer loop
      // performs continues this clock instead of restarting it. Sizing and
      // the full three-term argument: `./dynamodb-delete-budget.ts`.
      //
      // The per-type budget of 8 stays what it is, and its reason is
      // narrower now: #1950 raised the sibling `AWS::DynamoDB::Table` to 14,
      // and on THIS type the #1521 gate has already spent ~18 min of the
      // shared allowance by the time the loop starts, so a larger count would
      // buy retries the budget cannot fund rather than more patience.
      // `budget` is read INSIDE `waitForIndexesActive` on every call, not
      // captured once here: the loop runs for minutes and the allowance
      // drains as it goes, so the last retry must see the last remaining
      // figure rather than the first one.
      reArm: () =>
        this.waitForIndexesActive(physicalId, logicalId, {
          // go-to-k/cdkd#2762: the LONG cap serves a vector index building
          // alone (a build outlasts the short re-arm, go-to-k/cdkd#5574); a
          // GSI still stops at the short one.
          maxAttempts: VECTOR_INDEX_BUSY_REARM_MAX_ATTEMPTS,
          shortCapUnlessVectorBusy: DELETE_INDEX_BUSY_REARM_MAX_ATTEMPTS,
          proceedNote: DELETE_INDEX_WAIT_PROCEED_NOTE,
          budget,
          ...(context?.maskSecrets && { maskSecrets: context.maskSecrets }),
        }),
      // The wall-clock half of the loop's bound. `isRetryable` ANDs this with
      // the index-busy classifier, so an exhausted budget makes AWS's refusal
      // terminal — which is what surfaces its actionable message instead of
      // the deadline's generic one.
      shouldKeepRetrying: () => {
        if (!budget.isExhausted()) return true;
        loopLogger.warn(
          `DynamoDB GlobalTable ${logicalId}: giving up the index-busy DeleteTable retry on ` +
            `${physicalId} — the delete path has spent its whole ` +
            `${Math.round(budget.totalMs / 60_000)}-minute budget, so the destroy fails on ` +
            `AWS's refusal; re-running it succeeds once the index is ACTIVE.`
        );
        return false;
      },
      sleepSeam: deleteTableRetryDelays,
    });
    // DeleteTable is async; wait until DescribeTable returns
    // ResourceNotFoundException so siblings / verify steps observing
    // the table after destroy see it actually gone.
    await this.waitForTableGone(
      physicalId,
      logicalId,
      TABLE_GONE_WAIT_ATTEMPTS,
      budget,
      context?.maskSecrets
    );
    // go-to-k/cdkd#5699: each dropped replica's regional copy stays DELETING
    // for minutes after the source table stops listing it. Wait for it to be
    // gone, as `AWS::DynamoDB::Table` does (#5514): a dependent (a
    // replica-region KMS key, a role) must not be deleted under a live copy,
    // and a gone-probe right after the destroy must not see it. The copies
    // were deleting while the source table was, so this costs only what is
    // left. Regions in parallel; the delete is ACCEPTED, so a cap, a Ctrl-C
    // or an unreadable status warns and returns (`delete-gone-wait.ts`).
    // Only a delete: an update's replica removal keeps not waiting (#5581).
    await Promise.all(
      [...droppedReplicaRegions].map((region) =>
        waitForGoneAfterDelete({
          what: deleteMask(`DynamoDB GlobalTable ${physicalId} replica in ${region}`),
          resourceType,
          consequence:
            `AWS finishes the delete on its side; until it does, the table still exists in ` +
            `${region}, and a dependent deleted in the meantime (such as its KMS key) goes ` +
            `while it is still in use.`,
          describe: async () => {
            try {
              const out = await this.getRegionalClient(region).send(
                new DescribeTableCommand({ TableName: physicalId })
              );
              return out.Table?.TableStatus ?? 'UNKNOWN';
            } catch (describeError) {
              if (describeError instanceof ResourceNotFoundException) return undefined;
              throw describeError;
            }
          },
          logger: loopLogger,
          pollIntervalMs: replicaDeleteGoneWait.pollIntervalMs,
          maxWaitMs: Math.min(replicaDeleteGoneWait.maxWaitMs, budget.remainingMs()),
        })
      )
    );
    this.logger.debug(`Successfully deleted DynamoDB GlobalTable ${logicalId}`);
    // TERMINAL success — the allowance has no second pass to fund, and the
    // flip record has nothing left to undo. Released together and keyed
    // together: a retained record would let a LATER destroy of a table with
    // the same name inherit this run's flip.
    this.deleteBudgets.release(deleteBudgetKey(physicalId, context?.expectedRegion));
    this.protectionFlips.release(deleteBudgetKey(physicalId, context?.expectedRegion));
    this.droppedReplicaRegions.delete(droppedKey);
  } catch (error) {
    if (error instanceof ResourceNotFoundException) {
      const clientRegion = await this.dynamoDBClient.config.region();
      assertRegionMatch(clientRegion, context?.expectedRegion, resourceType, logicalId, physicalId);
      if (context?.failedCreateOrphan === true) {
        // go-to-k/cdkd#4606: a journaled orphan already gone settles with
        // exit 0, so say so once. Masked by the caller's printing bag.
        this.logger.info(
          safeMsg`  DynamoDB GlobalTable ${physicalId} (${logicalId}), which a failed deploy created, is already gone; nothing to delete`
        );
      } else {
        this.logger.debug(`DynamoDB GlobalTable ${physicalId} does not exist, skipping`);
      }
      this.deleteBudgets.release(deleteBudgetKey(physicalId, context?.expectedRegion));
      this.droppedReplicaRegions.delete(droppedKey);
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
    // rather than start a fresh one. That is the whole compounding term of
    // issue #1955.
    const cause = error instanceof Error ? error : undefined;
    throw this.wrapDeleteError(
      deleteLog,
      error,
      (text) =>
        new ProvisioningError(
          `Failed to delete DynamoDB GlobalTable ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          physicalId,
          cause
        ),
      indexNoun
    );
  }
}
