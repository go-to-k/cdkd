/**
 * The completed-op replay (`replayRollback`), split out of
 * `rollback-executor.ts` (go-to-k/cdkd#5835).
 */

import { ownRecord } from './replay-failed-checks.js';
import { type RolledBackCreate } from '../../state/name-generation.js';
import { type ReplayDeferral } from './replay-scope.js';
import type {
  ResourceState,
  StackOrphanRecord,
  SupersededResourceRecord,
} from '../../types/state.js';
import { carryLogOnlyValues, type RecordedSecretValues } from '../secret-redaction.js';
import {
  orderInlinePolicyReversals,
  RollbackInlinePolicyWriters,
} from '../inline-policy-claims.js';
import { restoreHeldInlinePolicies } from './replay-inline-policy-restore.js';
import {
  type CompletedOperation,
  type RollbackExecutorContext,
  type RollbackReplayResult,
  type FailedOperation,
} from './types.js';
import { ReplayResolvers } from './replay-secrets.js';
import {
  partitionOps,
  sortRollbackCreates,
  classifyRollbackOp,
  resolveReplacementOldType,
  unroutableReplacementError,
  markDeleteFirstBlocked,
  renamedReverseReplacement,
  revertReferences,
} from './plan.js';
import { createOpMasker, addRecordNames } from './names.js';
import {
  safe,
  shownLogicalId,
  maskedFailureText,
  shownChangeType,
  maskedRollbackEventError,
  recordRollbackSkip,
} from './messages.js';
import type { ReplayOpScope } from './replay-scope.js';
import { replayDelete, replayOrphanFlag, replayOrphanRetain } from './replay-orphan-delete.js';
import { replayReadopt, replayRevert } from './replay-revert.js';
import { replayReverseReplacement } from './replay-reverse-replacement.js';

/**
 * Replay a list of completed operations against `stateResources` (mutated in
 * place), reverting each. Best-effort: a provider failure is caught, warned,
 * and counted; replay continues.
 *
 * - UPDATE / DELETE first (reverse completion order), then CREATE deletions
 *   in reverse dependency order (dependents deleted before dependencies).
 * - `afterOp` is invoked after each op that MUTATED state (so the command can
 *   persist state incrementally, mirroring `saveStateAfterResource`).
 *   Standalone `cdkd rollback` and a nested child's journal replay
 *   (`nested-child-journal.ts`) pass one; `performRollback` (`deploy-engine/rollback.ts`)
 *   passes none, and its caller saves state once at the end.
 * - `isInterrupted` is polled between ops; when it flips true, replay stops
 *   (the pending op is left for a re-run).
 */
export async function replayRollbackUnbound(
  operations: CompletedOperation[],
  stateResources: Record<string, ResourceState>,
  stackName: string,
  ctx: RollbackExecutorContext,
  options: {
    orphanLogicalIds?: Set<string>;
    afterOp?: (logicalId: string) => Promise<void> | void;
    isInterrupted?: () => boolean;
    /**
     * Called the moment a record is minted, BEFORE `afterOp` saves state
     * (issue #2934).
     *
     * `result.orphaned` alone is not enough: a caller reads it only after this
     * function RETURNS, while `afterOp` runs per op INSIDE the replay — so
     * every intermediate save would persist a state with the resource gone
     * from `resources` and no record of it. A crash in that window loses the
     * only trace of a live, billing AWS resource permanently: the
     * unrecoverable loop this feature closes, reached through its own
     * implementation.
     */
    onOrphan?: (record: StackOrphanRecord) => void;
    /**
     * go-to-k/cdkd#5064: called the moment a CREATE's record leaves (deleted,
     * or left in AWS), BEFORE `afterOp` saves, for the reason `onOrphan` is:
     * every save from then on retires its generation (`retiredAfterRollback`).
     */
    onRolledBackCreate?: (create: RolledBackCreate) => void;
    /**
     * go-to-k/cdkd#4225: the completed writes an `AWS::IAM::Policy` revert or
     * delete, or a role / group / user revert, asks about before removing an
     * inline policy name. A caller that
     * replays more than once over one state bag (a segment's failed ops, then
     * its completed ops, then older segments) passes ONE instance to every
     * call; absent, this replay keeps its own.
     */
    inlinePolicyWriters?: RollbackInlinePolicyWriters;
    /**
     * go-to-k/cdkd#4690: the segment's failed ops, read only by the
     * delete-first guard (`markDeleteFirstBlocked`). Absent counts none.
     */
    failedOperations?: readonly FailedOperation[] | undefined;
    /**
     * go-to-k/cdkd#5064: a new resource no record holds until its deferred
     * delete runs ({@link ReplayDeferral}): the caller keeps it in
     * `supersededResources` across every save in between, and records what is
     * left in its final save. With these, a new copy a dependent still uses
     * (its revert failed) or an interrupt left pending is kept there rather
     * than deleted under that dependent.
     */
    onSuperseded?: (entry: SupersededResourceRecord) => void;
    onSupersededSettled?: (entry: SupersededResourceRecord) => void;
  } = {}
): Promise<RollbackReplayResult> {
  const orphanLogicalIds = options.orphanLogicalIds ?? new Set<string>();
  const inlinePolicyWriters = options.inlinePolicyWriters ?? new RollbackInlinePolicyWriters();
  const result: RollbackReplayResult = {
    failures: 0,
    warnings: 0,
    skipped: 0,
    interrupted: false,
    orphaned: [],
    rolledBackCreates: [],
  };

  if (operations.length === 0) {
    ctx.logger.info('No completed operations to roll back.');
    // go-to-k/cdkd#4408: a failed-only segment's removals (see below).
    await restoreHeldInlinePolicies(inlinePolicyWriters, stateResources, stackName, ctx, result);
    return result;
  }

  ctx.logger.info(`Rolling back ${operations.length} completed operation(s)...`);
  ctx.recordEvent?.({ eventType: 'ROLLBACK_STARTED', stackName });

  // ONE resolver for the whole replay, mirroring `replayFailedOperations`.
  // It re-resolves the redacted `{{resolve:secretsmanager:...}}` expressions the
  // journal / state store back to the concrete secret for the provider replay
  // (GHSA fix) — see {@link resolveReplayProps}.
  //
  // Hoisted out of `replaySingle` by issue #1933: that fix moved the resolved-
  // value cache from module scope onto the resolver INSTANCE, so a resolver per
  // OP would re-fetch every referenced secret once per op — a 100-op replay
  // paying 100 GetSecretValue calls for one expression, where the module-global
  // cache used to dedupe them. The whole replay is one stack in one region
  // (`ctx.region`), which is exactly the scope the instance cache is meant to
  // have, and both loops below are strictly sequential, so sharing adds no
  // concurrency exposure the failed-op sibling does not already carry.
  const resolver = new ReplayResolvers(ctx.region);

  // go-to-k/cdkd#4408: until an op completes, its resource's record is the
  // failed deploy's, which the put-back at the end never reads from.
  inlinePolicyWriters.notePending(operations);
  // go-to-k/cdkd#4690: a delete-first reversal whose old properties name a
  // resource this segment took away keeps the create-first order.
  markDeleteFirstBlocked(operations, options.failedOperations);

  const { createOps, otherOps } = partitionOps(operations);
  // go-to-k/cdkd#5096: what this segment created, which the CREATE pass below
  // deletes -- never a child a same-id parent reversal leaves behind.
  const createdInSegment = new Set(createOps.map((o) => o.logicalId));

  // Step 1: UPDATE/DELETE rollbacks in reverse completion order, except that
  // a standalone inline policy is reversed after an IAM writer sharing its
  // name on its principal (go-to-k/cdkd#4821).
  //
  // go-to-k/cdkd#5064: and except that a renamed reverse-replacement
  // (`renamedReverseReplacement`) re-creates its old resource BEFORE the first
  // op whose revert may name it, which reverse completion order runs first;
  // its new copy is deleted at its own slot, once those ops have moved off it.
  // The re-create of one it depends on runs before its own.
  const stepOne = orderInlinePolicyReversals([...otherOps].reverse(), stateResources);
  const stepOneIds = new Map<string, CompletedOperation>();
  const stepOneIndex = new Map<CompletedOperation, number>();
  stepOne.forEach((op, at) => {
    if (!stepOneIds.has(op.logicalId)) stepOneIds.set(op.logicalId, op);
    stepOneIndex.set(op, at);
  });
  // Every op replayed so far, ahead of its slot or at it: none runs twice.
  const started = new Set<CompletedOperation>();
  const pendingNewDeletes = new Map<
    CompletedOperation,
    { finish: () => Promise<void>; keep: ((reason: string) => void) | undefined }
  >();
  // The ops whose revert failed or was skipped: a pending new copy one of
  // them names is still in use by it.
  const failedOps = new Set<CompletedOperation>();
  const usedByFailedRevert = (target: CompletedOperation): boolean =>
    [...failedOps].some(
      (failed) =>
        failed !== target && revertReferences(failed, stateResources).has(target.logicalId)
    );
  // The physical ids those pending deletes are to remove: still live, so a
  // reversal whose old id is one of them waits for its slot.
  const pendingNewIds = new Set<string>();
  const runOp = async (op: CompletedOperation, deferral?: ReplayDeferral): Promise<void> => {
    const failuresBefore = result.failures;
    const skippedBefore = result.skipped;
    await replaySingle(
      op,
      stateResources,
      stackName,
      ctx,
      resolver,
      orphanLogicalIds,
      result,
      options.onOrphan,
      inlinePolicyWriters,
      options.afterOp,
      options.isInterrupted,
      createdInSegment,
      options.onRolledBackCreate,
      deferral
    );
    if (result.failures > failuresBefore || result.skipped > skippedBefore) failedOps.add(op);
  };
  const recreateAhead = async (refs: ReadonlySet<string>): Promise<void> => {
    for (const target of [...refs].map((id) => stepOneIds.get(id))) {
      if (target === undefined || started.has(target)) continue;
      if (!renamedReverseReplacement(target, stateResources, orphanLogicalIds, pendingNewIds)) {
        continue;
      }
      // Its own old record names an op still to revert BEFORE its slot that is
      // not a renamed reversal: re-created now, it would read that op's NEW
      // values. It keeps its slot, after that op. One reverting after its slot
      // ran after the re-create before too.
      const ownRefs = revertReferences(target, stateResources);
      if (
        [...ownRefs].some((id) => {
          const named = stepOneIds.get(id);
          return (
            named !== undefined &&
            !started.has(named) &&
            stepOneIndex.get(named)! < stepOneIndex.get(target)! &&
            !renamedReverseReplacement(named, stateResources, orphanLogicalIds, pendingNewIds)
          );
        })
      ) {
        continue;
      }
      if (options.isInterrupted?.()) return;
      started.add(target);
      await recreateAhead(ownRefs);
      if (options.isInterrupted?.()) return;
      const newId = stateResources[target.logicalId]?.physicalId;
      await runOp(target, {
        defer: (finish, keep) => {
          pendingNewDeletes.set(target, {
            finish: async () => {
              await finish();
              if (typeof newId === 'string') pendingNewIds.delete(newId);
            },
            // Kept, it stays live: its id stays pending for later reversals.
            keep,
          });
          if (typeof newId === 'string') pendingNewIds.add(newId);
        },
        onSuperseded: options.onSuperseded,
        onSupersededSettled: options.onSupersededSettled,
      });
    }
  };
  for (const op of stepOne) {
    if (options.isInterrupted?.()) {
      result.interrupted = true;
      break;
    }
    if (!started.has(op)) await recreateAhead(revertReferences(op, stateResources));
    if (options.isInterrupted?.()) {
      result.interrupted = true;
      break;
    }
    if (started.has(op)) {
      const pending = pendingNewDeletes.get(op);
      pendingNewDeletes.delete(op);
      if (pending?.keep !== undefined && usedByFailedRevert(op)) {
        pending.keep('a resource that references it did not revert');
      } else {
        await pending?.finish();
      }
      continue;
    }
    started.add(op);
    await runOp(op);
  }
  // Interrupted with a new copy still pending: its old resource is back and
  // its record says so, so a re-run reads the op as done and would never
  // delete it. Recorded as superseded, it is kept for the next deploy, which
  // deletes it after the ops left unreverted move off it; otherwise deleted
  // now, and an op left unreverted that still names it reverts to the old one
  // on that re-run.
  for (const pending of pendingNewDeletes.values()) {
    if (pending.keep !== undefined) pending.keep('the rollback was interrupted');
    else await pending.finish();
  }
  pendingNewDeletes.clear();

  // Step 2: CREATE rollbacks (deletions) in dependency-aware order.
  if (!result.interrupted && createOps.length > 0) {
    const sorted = sortRollbackCreates(createOps, stateResources);
    for (const op of sorted) {
      if (options.isInterrupted?.()) {
        result.interrupted = true;
        break;
      }
      await replaySingle(
        op,
        stateResources,
        stackName,
        ctx,
        resolver,
        orphanLogicalIds,
        result,
        options.onOrphan,
        inlinePolicyWriters,
        options.afterOp,
        options.isInterrupted,
        createdInSegment,
        options.onRolledBackCreate
      );
    }
  }

  // go-to-k/cdkd#4408: an inline policy a removal above (or the segment's
  // failed-op replay before it, which shares `inlinePolicyWriters`) took off a
  // principal while a record still holds it there goes back, with that
  // record's document. Interrupted too: what ran is final for this replay,
  // and an op it never reached is still pending, so its record holds nothing.
  await restoreHeldInlinePolicies(inlinePolicyWriters, stateResources, stackName, ctx, result);

  ctx.logger.info('Rollback completed. Some resources may remain if deletion failed.');
  ctx.recordEvent?.({ eventType: 'ROLLBACK_FINISHED', stackName });
  return result;
}

export async function replaySingle(
  op: CompletedOperation,
  stateResources: Record<string, ResourceState>,
  stackName: string,
  ctx: RollbackExecutorContext,
  /**
   * The caller's resolver, SHARED across every op of the replay (issue #1933).
   * Constructing one here would cost a fresh secret lookup per op now that the
   * resolved-value cache lives on the instance — see the construction site in
   * {@link replayRollback}.
   */
  resolver: ReplayResolvers,
  orphanLogicalIds: Set<string>,
  result: RollbackReplayResult,
  onOrphan: ((record: StackOrphanRecord) => void) | undefined,
  /** go-to-k/cdkd#4225: the replay's completed writes ({@link replayRollback}). */
  inlinePolicyWriters: RollbackInlinePolicyWriters,
  afterOp?: (logicalId: string) => Promise<void> | void,
  isInterrupted?: () => boolean,
  createdInSegment: ReadonlySet<string> = new Set(),
  onRolledBackCreate?: (create: RolledBackCreate) => void,
  /** go-to-k/cdkd#5064: see {@link ReplayDeferral}. */
  deferral?: ReplayDeferral
): Promise<void> {
  const action = classifyRollbackOp(op, stateResources, orphanLogicalIds);
  const { logger } = ctx;
  /**
   * This op's `plaintext -> {{resolve:...}}expression` bag, filled by
   * {@link resolveReplayProps} on whichever arm runs (issues
   * [#2038](https://github.com/go-to-k/cdkd/issues/2038) /
   * [#2031](https://github.com/go-to-k/cdkd/issues/2031)).
   *
   * HOISTED above the `try` rather than declared per arm, which is what the
   * two arms used to do: the shared catch below logs the thrown AWS message and
   * persists it to the events store, and it cannot see a binding scoped to the
   * arm that threw. Exactly one arm runs per call, so a single per-op bag is
   * equivalent to the per-arm ones for every existing reader (`secrets.size`
   * stays 0 on the arms that resolve nothing, so `redactRollbackRecord` and the
   * maskers keep their identity behavior).
   */
  const secrets: RecordedSecretValues = new Map();
  // go-to-k/cdkd#1998: see `RollbackExecutorContext.logOnlyNeedlesFor`.
  const deployBag = ctx.logOnlyNeedlesFor?.(op.logicalId);
  if (deployBag) carryLogOnlyValues(deployBag, secrets);
  /**
   * This op's masker (issue #4037): `secrets` plus the physical ids and derived
   * names a secret-derived name implies. Every rendered line, error and event
   * reason below goes through `mask`, the shared catch's included.
   */
  const opMasker = createOpMasker(logger, secrets, deployBag);
  const mask = opMasker.mask;
  /**
   * The route a CREATE-rollback arm resolved for this op (issue #1366) —
   * hoisted so the shared catch's ROLLBACK_RESOURCE_FAILED reports the route
   * the delete was going to take, which is the one a refusal is about. Stays
   * `undefined` on the UPDATE / replacement arms, where the catch keeps the
   * journaled value (those arms resolve their own routing separately). It is
   * the one field an arm writes, since the arms live in `replay-*.ts`.
   */
  const scope: ReplayOpScope = {
    op,
    stateResources,
    stackName,
    ctx,
    resolver,
    orphanLogicalIds,
    result,
    onOrphan,
    onRolledBackCreate,
    inlinePolicyWriters,
    afterOp,
    isInterrupted,
    action,
    logger,
    secrets,
    opMasker,
    mask,
    createdInSegment,
    createRollbackRoute: undefined,
    deferral,
  };

  // go-to-k/cdkd#4408: the op completed when it replaced or dropped the
  // record, or found it already reverted. Anything else (a throw before the
  // record moved, a skip that left the deploy's record) leaves it unsettled.
  const recordBefore = ownRecord(stateResources, op.logicalId);
  try {
    // The three records this op can render an id of, as they stand: the op's
    // own, its previous state, and the live one. Inside the `try`, since they
    // are journal- or state-sourced and the shared catch counts a bad one.
    addRecordNames(opMasker, op, stateResources[op.logicalId]);
    switch (action) {
      case 'unrecoverable-delete': {
        logger.warn(
          `  Rollback: Cannot restore deleted resource ${safe(op.logicalId)} (${safe(op.resourceType)}) — resource has already been deleted`
        );
        recordRollbackSkip(
          scope,
          op,
          'The failed deploy deleted this resource, and a rollback cannot re-create a deleted resource.'
        );
        return;
      }

      case 'skip-already-done': {
        logger.debug(`  Rollback: ${safe(op.logicalId)} already reverted, skipping`);
        return;
      }

      case 'skip-mismatch': {
        logger.warn(
          `  Rollback: Skipping ${safe(op.logicalId)} — its physical id changed since the failed deploy ` +
            `(replaced by a later attempt); manual attention may be required`
        );
        recordRollbackSkip(
          scope,
          op,
          'Its physical id changed since the failed deploy (replaced by a later attempt), so the rollback left it as it is; manual attention may be required.'
        );
        return;
      }

      case 'skip-absent': {
        logger.warn(
          `  Rollback: Cannot restore ${safe(op.logicalId)} — resource no longer in state, skipping`
        );
        recordRollbackSkip(
          scope,
          op,
          'The resource is no longer in state, so the rollback had nothing to restore.'
        );
        return;
      }

      case 'refuse-replacement-routing': {
        // Issue #2668. THROWN, not warned-and-skipped: `replaySingle`'s per-op
        // catch counts a failure, which keeps the segment (a warning would pop
        // it and discard the only record of this op). Nothing was called in
        // AWS and state is untouched. `markNonRetryable`: the verdict is read
        // off the journal alone, so no retry can change it.
        const routing = resolveReplacementOldType(op);
        throw unroutableReplacementError(
          op,
          routing.ok ? 'its old type could not be routed' : routing.reason,
          ctx
        );
      }

      case 'orphan-flag':
        return await replayOrphanFlag(scope);

      case 'orphan-retain':
        return await replayOrphanRetain(scope);

      case 'delete':
      case 'delete-with-final-snapshot':
        return await replayDelete(scope);

      case 'reverse-replacement-readopt':
        return await replayReadopt(scope);

      case 'reverse-replacement':
        return await replayReverseReplacement(scope);

      case 'revert':
        return await replayRevert(scope);
    }
  } catch (rollbackError) {
    // Best-effort: warn and continue with remaining rollbacks.
    //
    // Issue #2031: masked with THIS op's re-resolved bag. `resolveReplayProps`
    // hands the provider PLAINTEXT, and an AWS validation error routinely quotes
    // the offending property value back, so this line — at DEFAULT verbosity —
    // was the GHSA-p5qg-v9gv-hc7w fence missing on the rollback path.
    logger.warn(
      maskedFailureText(
        // Named only when plain, described otherwise: the text after it can
        // name a `cdkd` command on the same line — every refusal this module
        // builds does (go-to-k/cdkd#4214).
        `  Rollback failed for ${shownLogicalId(op.logicalId)} (${shownChangeType(op.changeType)}): `,
        rollbackError,
        mask
      )
    );
    logger.warn('  Continuing with remaining rollback operations...');
    result.failures++;
    const failedRoute = scope.createRollbackRoute ?? op.provisionedBy;
    ctx.recordEvent?.({
      eventType: 'ROLLBACK_RESOURCE_FAILED',
      stackName,
      operation: op.changeType,
      logicalId: op.logicalId,
      resourceType: op.resourceType,
      ...(failedRoute && { provisionedBy: failedRoute }),
      error: maskedRollbackEventError(rollbackError, mask),
    });
  } finally {
    inlinePolicyWriters.noteOutcome(
      op,
      action === 'skip-already-done' || ownRecord(stateResources, op.logicalId) !== recordBefore
    );
  }
}
