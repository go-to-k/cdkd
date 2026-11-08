/**
 * The destroy runner's steps before the lock: the entry refusals and journal
 * read, the empty-stack path, and the orphan notices and confirmation prompt
 * (split out of `../destroy-runner.ts`, go-to-k/cdkd#5835).
 */
import { refusePendingMovesOut } from '../../../state/pending-moves.js';
import { readRefactorMarker, refuseRefactorMarker } from '../../../state/refactor-marker.js';
import * as readline from 'node:readline/promises';
import { displaySafe, displayStackName } from '../../../utils/display-safe.js';
import { green } from '../../../utils/colors.js';
import { recordRetainedForReadoption } from '../../../deployment/retained-readoption.js';
import type { LockRecoveryContext } from '../../../state/lock-contention-message.js';
import { acquireStackLock } from '../stack-lock-guard.js';
import { CloudControlProvider } from '../../../provisioning/cloud-control-provider.js';
import {
  pendingRequestCount,
  resolvePendingCloudControlRequests,
} from '../../../deployment/cc-pending-requests.js';
import type { RollbackJournal } from '../../../types/rollback-journal.js';
import { stackInstanceIdOf } from '../../../state/stack-instance-id.js';
import type { StackState } from '../../../types/state.js';
import {
  refuseDivergentRecordRegionForDestroy,
  refuseMalformedOrphanRecordsForDestroy,
  refuseMalformedOrphansForDestroy,
  refuseMalformedResourceEntriesForDestroy,
  refuseMalformedResourcePropertiesForDestroy,
  refuseMalformedResourcesForDestroy,
} from '../../../state/malformed-resources-bag.js';
import { CdkdError } from '../../../utils/error-handler.js';
import {
  dropFailedCommands,
  journaledOrphanLines,
  loadJournaledOrphans,
} from '../../../deployment/rollback-executor/journaled-orphans.js';
import {
  journaledOrphanPrintingBag,
  orphanRecordsPrintingBag,
} from '../../../deployment/secret-name-needles.js';
import { withPrintingSecrets } from '../../../deployment/resource-secrets-scope.js';
import { holdsSupersededResources } from '../../../deployment/superseded-resources.js';
import type { RecordedSecretValues } from '../../../deployment/secret-redaction.js';
import type {
  DestroyRunnerContext,
  DestroyRunnerResult,
  DestroyLogger,
  StackLockBase,
} from './types.js';
import {
  purgeStateHistoryIfOptedIn,
  refuseNewPendingRequests,
  releaseRegistryMarkerAfterDestroy,
} from './helpers.js';

/** What {@link refuseMalformedRecordAndLoadJournaledOrphans} reads from `destroyStackInRegion`. */
export interface EntryChecksFrame {
  state: StackState;
  stackName: string;
  regionForState: string;
  refusalRecovery: LockRecoveryContext;
  ctx: DestroyRunnerContext;
  logger: DestroyLogger;
  stackLockBase: StackLockBase;
}

/**
 * The record's entry refusals, then its rollback journal: a Cloud Control
 * CREATE a failed deploy stopped waiting for is settled, the journaled
 * orphans are read, and a divergent body region is refused. Returns the
 * journaled orphans read.
 */
export async function refuseMalformedRecordAndLoadJournaledOrphans({
  state,
  stackName,
  regionForState,
  refusalRecovery,
  ctx,
  logger,
  stackLockBase,
}: EntryChecksFrame): Promise<Awaited<ReturnType<typeof loadJournaledOrphans>>> {
  // AT THE TOP OF THE DESTROY, and ABOVE THE COUNT BELOW (issue #3161).
  //
  // `parseStateBody` validates the root object and the schema version and
  // nothing inside, so a hand-edited or truncated record reaches this function
  // with `resources` holding a string, a list, a number, a boolean or `null`.
  // `Object.keys` answers three different ways over those, and the middle
  // answer is the damaging one: a `[]`, a `5` or a `true` enumerates NO keys,
  // so `resourceCount` is 0 and — with no orphans — the run takes the
  // empty-stack fast path a few lines down, which deletes `state.json` with no
  // confirmation at all. The destroy reports success having deleted nothing,
  // and every resource the record named is still live in AWS with the only
  // record of what they were now gone. A string enumerates one fabricated
  // logical id per character instead, and a `null` throws a bare `TypeError`.
  //
  // REFUSE rather than repair, and the read-only repair is not the safe half
  // here: reading the bag as EMPTY *is* the fast path, byte-identical to the
  // `[]` case. `malformedDestroyResourcesRefusalMessage` carries that
  // measurement and names `cdkd state orphan` for an operator who does want
  // the record gone.
  //
  // The DISCRIMINATOR is the container's SHAPE, never its size: a legitimately
  // empty `{}` and an unreadable `[]` both count 0, so only `isReadableBag`
  // separates them — which is why this cannot be folded into the
  // `resourceCount === 0` test below.
  refuseMalformedResourcesForDestroy(state, stackName, regionForState, refusalRecovery);
  // The ROWS of a readable map (go-to-k/cdkd#3202), BELOW the bag guard: an
  // unreadable bag has no rows to name. Every walk below reads
  // `resource.resourceType` per row and validates nothing — the listing above
  // the prompt first — and the delete loop routes on it, so a row that is not a
  // record takes one of three routes (measured, see the refusal's JSDoc): a
  // `null` row is a bare `TypeError` in that listing; a `false` / `0` / `''`
  // row is FALSY at the loop's `if (!resource)` guard, skipped as "not found in
  // state", and the record then removed with its resource live; any other
  // unreadable row — unless its own `deletionPolicy` takes the retention branch
  // first — is a provider call on whatever its type field holds and an
  // unchecked physical id. REFUSE rather than skip, for the reason the bag
  // guard gives: the map IS the list of what to delete, and a skipped row's
  // resource stays live in AWS with the record that named it removed.
  refuseMalformedResourceEntriesForDestroy(state, stackName, regionForState, refusalRecovery);
  // Each readable row's `properties` MAP (go-to-k/cdkd#3211), BELOW the row
  // guard, which names a typeless row with a torn map more precisely. The map
  // is `provider.delete`'s fourth argument and decides what the delete does
  // (final snapshot, emptying first), so a torn one is refused here rather
  // than read as `{}` in the loop — see the refusal's JSDoc.
  refuseMalformedResourcePropertiesForDestroy(state, stackName, regionForState, refusalRecovery);
  // The `orphans` CONTAINER (go-to-k/cdkd#3379). The orphan warning below reads
  // it on `?? []`, so an unreadable one counts 0 and this run would delete every
  // resource and then the record with its orphan evidence never reported.
  refuseMalformedOrphansForDestroy(state, stackName, regionForState, refusalRecovery);
  // The ROWS of a readable list (go-to-k/cdkd#3500): the listing below prints
  // each row from fields it validates none of, and filters nothing — so what an
  // unusable row does there depends on which part is torn, which is why this is
  // a refusal rather than a drop.
  refuseMalformedOrphanRecordsForDestroy(state, stackName, regionForState, refusalRecovery);
  // An unfinished `cdkd refactor` moving resources out of this stack
  // (go-to-k/cdkd#5212): the destination may already hold them, so deleting
  // them here would delete another stack's resources.
  refusePendingMovesOut(state, stackName, regionForState, 'cdkd destroy');
  // (The refactor marker is read once, under the lock, below.)
  // BELOW the bag guard (which proves the bag can be counted) and ABOVE the
  // delete loop and every `deleteState` (issue #3328, review round 1). NOT
  // "above the fast path" as a discriminating claim — the guard returns early
  // on a zero count, which is that path's own condition, so the two can never
  // disagree; what the placement buys is that no delete is issued and no record
  // removed before the verdict. `getState` adopts the KEY's region, which is right for the lock
  // and the record — but a record whose BODY named a different one is the one
  // shape that gives two answers to "where are the resources", and the delete
  // loop below reads a `*NotFound` as ALREADY DELETED. Without this the wrong
  // answer is a whole stack reported destroyed, its record removed, and every
  // resource still live in the other region. Narrow by construction: divergent
  // AND resource-bearing, so the resource-less recovery destroy this issue's
  // own repro exercises still runs.
  // go-to-k/cdkd#4584: resources a failed CREATE made that only the rollback
  // journal records. `deleteState` sweeps the journal, so they are deleted
  // (per their journaled DeletionPolicy) before it — and a stack holding one
  // is not empty: the fast path below would sweep it with no confirmation.
  // Read BELOW the orphans-container guards (it reads `state.orphans`) and
  // ABOVE the divergent-region refusal, which counts them: they reach AWS.
  // go-to-k/cdkd#3252: a Cloud Control CREATE a failed deploy stopped waiting
  // for is settled first, under the lock: one that made its resource becomes a
  // journaled orphan the read below counts and deletes, and one still unknown
  // refuses the destroy, which would otherwise sweep the journal holding the
  // request's only record. The provider is built HERE, inside the stack's AWS
  // scope, so a cross-region stack's request is read in its own region.
  // The journal is read ONCE here: the settle peeks at that read, and the
  // orphan read below replays it unless the settle rewrote the journal.
  let journalAtEntry: { journal: RollbackJournal | null } | { error: unknown };
  try {
    journalAtEntry = {
      journal: await ctx.stateBackend.loadRollbackJournal(stackName, regionForState),
    };
  } catch (error) {
    journalAtEntry = { error };
  }
  // A record whose body names another region than its key: the request may
  // live in either, and a token read in the wrong one answers "not found",
  // which would drop it. Refuse rather than guess.
  if (
    ctx.divergentBodyRegion !== undefined &&
    'journal' in journalAtEntry &&
    pendingRequestCount(journalAtEntry.journal) > 0
  ) {
    const ids = (journalAtEntry.journal?.segments ?? [])
      .flatMap((segment) => segment.failedOperations ?? [])
      .filter((op) => op.pendingCloudControlRequest !== undefined)
      .map((op) => op.logicalId);
    const drop = dropFailedCommands(stackName, regionForState, ids);
    throw new CdkdError(
      `Stack ${displayStackName(stackName)}'s state record names another region than its key, and its ` +
        `rollback journal records a Cloud Control CREATE a failed deploy stopped waiting for. cdkd cannot ` +
        `tell which region to check it in. Nothing was deleted. Check the request in each region with ` +
        `aws cloudcontrol get-resource-request-status --request-token <token> --region <region> (the ` +
        `token is in the stack's rollback-journal.json), reconcile what it made by hand, then drop the ` +
        `entry and re-run:` +
        (drop === undefined ? '' : drop.commands.map((c) => `\n  ${c}`).join('')),
      'DESTROY_CC_PENDING_REQUEST_DIVERGENT_REGION'
    );
  }
  const journalRewritten = await resolvePendingCloudControlRequests({
    journal: ctx.stateBackend,
    loaded: 'journal' in journalAtEntry ? journalAtEntry.journal : null,
    reader: () => new CloudControlProvider(),
    stackName,
    region: regionForState,
    command: 'destroy',
    logger,
    stateResources: state.resources,
    stackInstanceId: stackInstanceIdOf(state, displayStackName(stackName)),
    underLock: async (settle) => {
      const held = await acquireStackLock({
        ...stackLockBase,
        onFirstSignal: () => {
          process.stderr.write(
            `\nInterrupt received - finishing the Cloud Control request check for ` +
              `${displayStackName(stackName)} (press Ctrl-C again to force-quit)\n`
          );
        },
      });
      try {
        return await settle();
      } finally {
        await held.release({
          failureMessage:
            'Failed to release lock after settling an abandoned Cloud Control request',
        });
      }
    },
  });
  const entryRead = journalAtEntry;
  const journaledOrphans = await loadJournaledOrphans(
    journalRewritten
      ? ctx.stateBackend
      : {
          loadRollbackJournal: () =>
            'journal' in entryRead
              ? Promise.resolve(entryRead.journal)
              : Promise.reject(entryRead.error as Error),
        },
    stackName,
    regionForState,
    state.orphans,
    logger
  );
  refuseDivergentRecordRegionForDestroy(
    state,
    stackName,
    regionForState,
    ctx.divergentBodyRegion,
    refusalRecovery,
    journaledOrphans.segments
      .flatMap((g) => g.ops)
      .filter((op) => op.physicalIdRecoveredFromError === true).length
  );
  return journaledOrphans;
}

/** What {@link destroyEmptyStack} reads from `destroyStackInRegion`. */
export interface EmptyStackFrame {
  stackName: string;
  ctx: DestroyRunnerContext;
  logger: DestroyLogger;
  stackLockBase: StackLockBase;
  regionForState: string;
  refusalRecovery: LockRecoveryContext;
  journaledOrphans: Awaited<ReturnType<typeof loadJournaledOrphans>>;
  result: DestroyRunnerResult;
}

/**
 * A stack with no resources, orphans, superseded rows or journaled orphans:
 * re-checked under the lock, then its record deleted.
 */
export async function destroyEmptyStack({
  stackName,
  ctx,
  logger,
  stackLockBase,
  regionForState,
  refusalRecovery,
  journaledOrphans,
  result,
}: EmptyStackFrame): Promise<DestroyRunnerResult> {
  // Issue #2171: this used to delete the state record with NO lock at all,
  // sitting well above the acquire further down. A record reads as empty for
  // exactly one interval that is not idle — the start of a concurrent
  // `cdkd deploy`, before its first resource lands — so the unlocked delete
  // removed the state file out from under a live deploy holding the lock.
  //
  // Take the lock, then RE-READ: the snapshot this function was handed was
  // taken by the caller before any of this, so emptiness has to be
  // re-established under the lock rather than inherited from it.
  logger.info(`Stack ${displayStackName(stackName)} has no resources, cleaning up state...`);
  // The lock, its SIGINT handler and the release ordering are
  // `acquireStackLock`'s (go-to-k/cdkd#2174). A first Ctrl-C only records the
  // interrupt: the remaining three S3 round-trips finish, which is both
  // graceful and the only correct answer for a nested-stack child, whose
  // PARENT's handler has merely set its drain flag.
  const emptyLock = await acquireStackLock({
    ...stackLockBase,
    // stderr, NOT `logger.info`: under `cdkd deploy` (nested-stack removal)
    // the logger writes into the per-stack buffer that is only flushed at
    // stack end, so the first Ctrl-C would show nothing.
    onFirstSignal: () => {
      process.stderr.write(
        `\nInterrupt received - finishing the state cleanup for ${displayStackName(stackName)} ` +
          `(press Ctrl-C again to force-quit)\n`
      );
    },
  });
  try {
    const recheck = await ctx.stateBackend.getState(stackName, regionForState);
    // The SECOND record this function counts, and it needs the same guard as
    // the first (issue #3161). The re-read exists because emptiness has to be
    // established UNDER the lock, so what it returns is a different object
    // from the one the entry guard cleared — a concurrent writer, or a hand
    // edit landing between the two reads, can make it unreadable. The count
    // below would then be 0, `stillEmpty` would be true, and `deleteState`
    // would run on the very line the re-read exists to protect.
    if (recheck) {
      refuseMalformedResourcesForDestroy(recheck.state, stackName, regionForState, refusalRecovery);
      // The ROWS of the re-read map (go-to-k/cdkd#3202), for the reason the
      // orphan-row guard below is owed here rather than the container's: any
      // row at all makes `recheckResources >= 1`, so this path does not delete
      // either way — what the guard buys is WHICH refusal the operator gets.
      // Without it the run stops at the "not empty" branch, which says the
      // record still holds resources and nothing about the row it could not read.
      refuseMalformedResourceEntriesForDestroy(
        recheck.state,
        stackName,
        regionForState,
        refusalRecovery
      );
      // The re-read is the record `stillEmpty` and `deleteState` act on, so
      // the container guard is owed here as well as at the entry read.
      // `stillEmpty` reads `(recheck.state.orphans ?? []).length`, and the
      // shapes split three ways (measured): `null`, `''` and `{length: 0}`
      // count 0 and REACH the delete; a string or `{length: N}` counts
      // non-zero; a number, an object or a boolean yields `undefined`, which
      // fails the `=== 0` test and stops the run with no cause named
      // (go-to-k/cdkd#3379).
      refuseMalformedOrphansForDestroy(recheck.state, stackName, regionForState, refusalRecovery);
      // Owed at the re-read, but NOT for the same reason as the container guard
      // above it, and the difference is worth stating (go-to-k/cdkd#3641,
      // maintainer item o4). The container guard is about `deleteState`: an
      // unreadable container counts 0, so the record is removed with its orphan
      // evidence never reported. A ROW cannot reach that outcome — any row at all
      // makes `recheckOrphans >= 1`, so this path does not delete either way.
      // What the row guard buys here is WHICH refusal the operator gets: without
      // it the run stops at the "not empty" branch, which says the record still
      // holds orphans and nothing about the row it could not read.
      refuseMalformedOrphanRecordsForDestroy(
        recheck.state,
        stackName,
        regionForState,
        refusalRecovery
      );
      refusePendingMovesOut(recheck.state, stackName, regionForState, 'cdkd destroy');
    }
    // go-to-k/cdkd#5212: an empty record may be a move's DESTINATION, made
    // to receive it; deleting it would leave the move unable to finish.
    refuseRefactorMarker(
      await readRefactorMarker(ctx.stateBackend),
      stackName,
      regionForState,
      'cdkd destroy'
    );
    const recheckResources = recheck ? Object.keys(recheck.state.resources).length : 0;
    const recheckOrphans = recheck ? (recheck.state.orphans ?? []).length : 0;
    // go-to-k/cdkd#4584: the journal too, under the lock. A deploy that
    // failed between the first read and this lock may have journaled a
    // proven orphan, and `deleteState` below sweeps its only record.
    const recheckRead = await loadJournaledOrphans(
      ctx.stateBackend,
      stackName,
      regionForState,
      recheck?.state.orphans,
      // Warned once: silent only when the entry read already warned.
      journaledOrphans.unreadable === true ? { warn: () => undefined } : logger
    );
    const recheckJournaled = recheckRead.count;
    refuseNewPendingRequests(recheckRead, stackName, regionForState);
    if (recheckJournaled > 0) {
      throw new Error(
        `Stack ${displayStackName(stackName)} (${displaySafe(regionForState, { asciiOnly: true })}) was empty when this run started but ` +
          `its rollback journal now records ${recheckJournaled} resource(s) a failed deploy created — ` +
          `another cdkd process wrote to it. Re-run the destroy to act on the current state.`
      );
    }
    // Same widening as the entry check (issue #2934): a record that gained
    // ONLY orphan entries is still not empty, and deleting it would drop the
    // only trace of live, billing AWS resources.
    const stillEmpty =
      !recheck ||
      (recheckResources === 0 && recheckOrphans === 0 && !holdsSupersededResources(recheck.state));
    if (!stillEmpty) {
      // A concurrent writer populated the record between the caller's read
      // and this lock. Deleting now would drop resources cdkd tracks, so
      // refuse and let the user re-run against the record as it now stands.
      //
      // The message names BOTH counts: a state that gained only orphan
      // records would otherwise read `0 resource(s)`, which contradicts the
      // refusal it is explaining.
      throw new Error(
        `Stack ${displayStackName(stackName)} (${displaySafe(regionForState, { asciiOnly: true })}) was empty when this run started but ` +
          `now has ${recheckResources} resource(s) and ${recheckOrphans} rollback-orphaned ` +
          `resource(s) — another cdkd process wrote to it. Re-run the destroy to act on ` +
          `the current state.`
      );
    }
    await ctx.stateBackend.deleteState(stackName, regionForState);
    result.stateDeleted = true;
    logger.info(`${green('✓')} State deleted`);
    // Kept nothing: the tombstone (go-to-k/cdkd#4705 review D-1), and the
    // marker's release -- one round trip, concurrently (review P3).
    await Promise.all([
      recordRetainedForReadoption(ctx.stateBackend, stackName, regionForState, [], logger).then(
        () => purgeStateHistoryIfOptedIn(ctx, stackName, regionForState)
      ),
      releaseRegistryMarkerAfterDestroy(ctx, stackName, regionForState, logger),
    ]);
  } finally {
    await emptyLock.release({
      failureMessage: 'Failed to release lock after empty-state cleanup',
    });
  }
  result.skippedEmpty = true;
  // NOTHING is published to `result.interrupted` here, and that absence is
  // the point. This branch has just DELETED the state record, so by the
  // ownership rule the outer `finally` states — `result.interrupted` answers
  // "did THIS stack finish, or is there work left in it?" — the answer is
  // "it finished". There is no preserved state to re-run against and no
  // resource left to delete; the stack's record is gone.
  //
  // A `||= emptyInterrupted` (today: `emptyLock.interrupted`) used to sit
  // here, and it reproduced the exact defect the outer re-sync's
  // `&& statePreserved` gate was added to close, ~950 lines above the gate
  // and BEFORE the main `try`/`finally` that carries it. `destroy.ts` then threw
  // `Destroy interrupted by Ctrl-C. State preserved -- re-run 'cdkd destroy'
  // to finish` and exited 2 over a stack whose state file no longer exists,
  // and (since `--purge-events` moved onto this same per-stack flag)
  // additionally skipped the purge for a stack with no state left to
  // post-mortem. Both halves of that sentence false, for the same reason they
  // were false on the main path.
  //
  // Its stated purpose -- "otherwise `destroy --all` walks on to the next
  // stack" -- is served by the command-scoped `watchCommandInterrupt`, which
  // BOTH destroy loops read live via `runInterrupted()` since issue #2117.
  // That is the same argument the outer re-sync's own comment makes for the
  // main path; this branch simply had not been re-read under it.
  //
  // Note the alternative of publishing a `statePreserved`-style flag here is
  // wrong rather than merely unnecessary: on this branch nothing IS
  // preserved, so the gate would be permanently false and the line would be
  // dead code claiming to gate something.
  return result;
}

/** What {@link announceOrphansAndConfirm} reads from `destroyStackInRegion`. */
export interface ConfirmFrame {
  state: StackState;
  logger: DestroyLogger;
  stackNoEchoValues: () => Promise<RecordedSecretValues | undefined>;
  journaledOrphans: Awaited<ReturnType<typeof loadJournaledOrphans>>;
  ctx: DestroyRunnerContext;
  stackName: string;
  resourceCount: number;
  protectedCount: number;
  result: DestroyRunnerResult;
}

/**
 * The rollback-orphan and journaled-orphan notices, then the confirmation
 * prompt. Returns the cancelled `result` when the operator declines, else
 * `undefined`.
 */
export async function announceOrphansAndConfirm({
  state,
  logger,
  stackNoEchoValues,
  journaledOrphans,
  ctx,
  stackName,
  resourceCount,
  protectedCount,
  result,
}: ConfirmFrame): Promise<DestroyRunnerResult | undefined> {
  const orphansAtDestroy = state.orphans ?? [];
  if (orphansAtDestroy.length > 0) {
    logger.info(
      `\n${orphansAtDestroy.length} resource(s) are still in AWS from an earlier failed deploy. ` +
        `cdkd left them there because their DeletionPolicy is Retain (CDK's ` +
        `RemovalPolicy.RETAIN), and has been tracking them so a later deploy of this stack ` +
        `could adopt them back instead of colliding with their names.`
    );
    logger.info(
      `Destroying this stack deletes that record. The resources stay in AWS, may continue to ` +
        `incur charges, and cdkd will no longer know about them:`
    );
    const orphanListing = orphanRecordsPrintingBag(orphansAtDestroy, await stackNoEchoValues());
    for (const entry of orphansAtDestroy) {
      // Every field sanitized (go-to-k/cdkd#3500 security review). The row guard
      // above validates the record's SHAPE, not the CONTENT of the three strings
      // printed here, and all of them come from a state record: measured, a
      // `physicalId` carrying a newline forged an extra row AND a fake
      // "(0 resources left)" tally into the banner the operator's y/N answers,
      // and a `resourceType` carrying an ESC run redrew the lines above it.
      //
      // `displaySafe`, deliberately NOT `displayIdent`, and the difference is
      // LOSSINESS rather than strictness. This listing is the operator's only
      // notice of which resources stop being tracked, and the record is deleted
      // once they answer y — so a rendering that drops part of an identifier
      // leaves them unable to find in AWS what cdkd just forgot. `displayIdent`
      // drops two legitimate classes here: a physical id is provider-defined and
      // NOT ASCII-bounded (a Custom Resource may return `customer-<non-ASCII>`,
      // which renders as `"customer-"`), and it is not length-bounded either —
      // `SnsTopicPolicyProvider` stores a COMMA-JOINED topic ARN list, which
      // passes 2048 at ~50 topics, so no cap is the right cap. What the operator
      // needs protection from is the FORGED ROW and the screen redraw, and the
      // denylist closes both: the newline becomes a space and the escape is
      // stripped.
      //
      // Residual, stated rather than implied away: `displaySafe` TRIMS, so a
      // provider-defined id with LEADING or TRAILING whitespace renders without
      // it — ` customer-x ` and `customer-x` are one line here (measured). That
      // is information loss in the same notice, accepted rather than fixed,
      // because closing it needs a lossless escaping renderer this module should
      // not invent: the quoting helper that exists (`displayIdent`) answers it by
      // dropping MORE. What IS preserved is every printable interior character,
      // which is what makes the id findable in AWS — an interior control
      // character becomes a space, by the same rule that defuses the forged row.
      //
      // The one deliberate loss (go-to-k/cdkd#3869, a maintainer decision): an
      // id named from a secret prints MASKED, under the print-only bag bound
      // below, as `cdkd diff` masks these records. The logical id and type
      // still name the resource; an ordinary id prints as it is.
      withPrintingSecrets(orphanListing, () =>
        logger.info(
          `  - ${displaySafe(entry.logicalId)} (${displaySafe(entry.state.resourceType)})  ` +
            `${displaySafe(entry.state.physicalId)}`
        )
      );
    }
  }
  // go-to-k/cdkd#4584: part of what the y/N answers, and told to a flagged run
  // too, for the reason the notice above gives.
  if (journaledOrphans.count > 0) {
    logger.info(
      `\n${journaledOrphans.count} resource(s) were created by a failed deploy and are recorded only ` +
        `in the rollback journal. Each is deleted first as its DeletionPolicy directs (Retain ` +
        `keeps it in AWS, Snapshot takes the final snapshot), unless state or a later deploy may ` +
        `own it, which is warned about instead:`
    );
    const listing = journaledOrphanPrintingBag(
      journaledOrphans.segments.flatMap(({ ops }) => ops),
      state.resources,
      await stackNoEchoValues()
    );
    withPrintingSecrets(listing, () => {
      for (const line of journaledOrphanLines(journaledOrphans, logger)) logger.info(line);
    });
  }

  if (!ctx.skipConfirmation) {
    // Issue #2259: refuse a NON-INTERACTIVE run before the interface exists.
    //
    // `rl.question` never settles when stdin is already at EOF, and EOF
    // delivers no signal, so nothing wakes it. Measured on Node 24.15.0 (and 24.19 before it) against
    // real `node:readline/promises`: `echo y |` resolves `"y"`, while both
    // `printf 'y' |` (a real answer with no trailing newline) and
    // `< /dev/null` stay pending indefinitely. Without this guard
    // `cdkd destroy <stack>`, `cdkd destroy --all` and
    // `cdkd state destroy <stack>` without `--yes` / `--force` parked forever
    // in CI on nothing more than an absent stdin -- a hang, not a failure, so
    // the job burned its whole timeout budget before reporting anything.
    //
    // REFUSE rather than auto-confirm. `deploy.ts` takes the other branch
    // (`!process.stdin.isTTY` -> proceed), but a deploy that assumes "yes" is
    // recoverable and a destroy is not: silently answering "yes" on behalf of
    // an absent operator would delete every resource in the stack. Four
    // prompts already refuse -- `gc.ts`, `bootstrap-destroy.ts`,
    // `recreate-confirm-prompt.ts` and `prefix-migration-check.ts` all test
    // `isTTY` before creating the interface -- and issue #2247 chose the same
    // refusal for `state destroy --all`'s BATCH prompt one layer up (removed
    // with that option, go-to-k/cdkd#3865). This was the per-stack twin of
    // that guard.
    //
    // Only TWO of those four share the error SHAPE copied here: `gc.ts` and
    // `bootstrap-destroy.ts` throw `CdkdError` with `NON_INTERACTIVE_CONFIRM`.
    // The other two throw a bare `Error` (`recreate-confirm-prompt.ts`,
    // `prefix-migration-check.ts`). Matching the two that carry the code is
    // deliberate: a destroy refusal is something CI should be able to branch
    // on. (An earlier comment in this repo claimed they all carried the code;
    // that was measured false -- do not restore it.) There were FIVE until
    // `cdkd migrate` was removed (issue #2572); its prompt threw a
    // `LocalMigrateError`.
    //
    // Position is load-bearing: this sits AFTER the `--yes` / `--force`
    // short-circuit, so a non-interactive run that already passed a flag never
    // consults stdin at all, and after the resource banner, so the refusal
    // still names what would have been destroyed. Nested-stack children reach
    // this function with `skipConfirmation: true` (the parent already
    // confirmed the cascade), so a cascading destroy is unaffected.
    if (process.stdin.isTTY !== true) {
      throw new CdkdError(
        `The destroy confirmation prompt for stack ${displayStackName(stackName)} cannot run in a ` +
          'non-interactive environment. Pass --yes / -y to confirm the destroy ' +
          '(cdkd destroy also accepts -f / --force), or run the command from a real ' +
          'terminal.',
        'NON_INTERACTIVE_CONFIRM'
      );
    }
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    // go-to-k/cdkd#4584: the journaled resources are deleted too, so the
    // question counts them (a stack holding only those would say "0").
    const journaledClause =
      journaledOrphans.count > 0
        ? ` and ${journaledOrphans.count} recorded only in its rollback journal`
        : '';
    const prompt = ctx.removeProtection
      ? `\nAbout to destroy ${resourceCount} resources${journaledClause} from stack ${displayStackName(stackName)}, ` +
        `REMOVING DELETION PROTECTION on ${protectedCount} of them. Continue? (y/N): `
      : `\nAre you sure you want to destroy stack ${displayStackName(stackName)} and delete all ${resourceCount} resources${journaledClause}? (Y/n): `;
    const answer = await rl.question(prompt);
    rl.close();
    const trimmed = answer.trim().toLowerCase();
    // `--remove-protection` flips the default to "no" because the side
    // effect is destructive beyond the basic destroy — require explicit
    // 'y' / 'yes'. The bare-destroy prompt keeps its existing default-yes
    // semantics for back-compat.
    if (ctx.removeProtection) {
      if (trimmed !== 'y' && trimmed !== 'yes') {
        logger.info('Destroy cancelled');
        result.cancelled = true;
        return result;
      }
    } else if (trimmed === 'n' || trimmed === 'no') {
      logger.info('Destroy cancelled');
      result.cancelled = true;
      return result;
    }
  }
  return undefined;
}
