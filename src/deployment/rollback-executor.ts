/**
 * Rollback executor (issue #1183).
 *
 * The reusable engine that reverts a list of {@link CompletedOperation}s —
 * extracted from `DeployEngine` so BOTH callers drive identical semantics:
 *
 * - `DeployEngine` runs it in-process after a failed deploy (automatic
 *   rollback, unchanged behavior except the two fixes below).
 * - The standalone `cdkd rollback` command runs it against a persisted
 *   rollback journal (issue #1183 §journal), so a `--no-rollback` /
 *   interrupted / partially-failed-auto-rollback deploy can be reverted
 *   later.
 *
 * The executor deliberately depends only on `ProviderRegistry`, the stack
 * region, a logger, and an optional event recorder + per-op state-save
 * hook. It does NOT touch `DagBuilder` / `DiffCalculator` / the synthesizer
 * / `ExportIndexStore`, so the command can construct it without any of the
 * engine's synth-side collaborators (rollback never publishes
 * outputs/exports).
 *
 * Two deliberate behavior fixes vs. the pre-extraction in-process path
 * (both are pre-existing gaps; fixing them once benefits both callers):
 *
 * 1. **DeletionPolicy on CREATE rollback** — rolling a CREATE back IS a
 *    delete as far as the policy is concerned (CloudFormation semantics), so
 *    the CURRENT state record's `DeletionPolicy` decides what happens:
 *    - `Retain` → ORPHANED (removed from state, left in AWS). The policy
 *      says KEEP the resource, so cdkd does.
 *    - `Snapshot` → final snapshot, THEN delete (issue #1358), through the
 *      same mechanism matrix as the deploy engine's
 *      `prepareFinalSnapshotForDelete`: atomic delete parameter for the
 *      SDK-routed `ATOMIC_FINAL_SNAPSHOT_TYPES`, an explicit pre-delete
 *      snapshot for `PRE_DELETE_SNAPSHOT_TYPES`, refusal for every other
 *      Snapshot shape (cc-api routing included) unless
 *      `--skip-final-snapshot` opts into the data loss. This arm ORPHANED
 *      alongside `Retain` until #1358: when this file was written cdkd could
 *      not create a final snapshot at all, so leaving the resource behind
 *      was the only non-destructive option — but it silently handed the user
 *      an untracked, billing resource that state no longer knew about.
 *      `src/provisioning/final-snapshot.ts` (#1352 / #1353) removed the
 *      constraint, so the policy is now honored literally.
 *    - `RetainExceptOnCreate` (which exists precisely to allow cleanup of
 *      failed creates) and absent / `Delete` → DELETE.
 * 2. **Idempotent replay skip rules** — so a partially-failed rollback can
 *    be re-run safely (also harmless for the in-process caller, which
 *    replays each op exactly once).
 */

import { pasteableCommand } from '../utils/pasteable-command.js';
import type { ResourceState, StackOrphanRecord } from '../types/state.js';
import type { ResourceCreateResult, ResourceProvider } from '../types/resource.js';
import { equalIdNamesSameResource } from './type-change-guard.js';
import { reverseReplacementNewHoldsName } from './replacement-name-holder.js';
import { withCurrentResourceSecrets } from './resource-secrets-scope.js';
import { STATEFUL_TYPES } from '../provisioning/stateful-types.js';
import { applyDefaultNameForFallback } from '../provisioning/resource-name.js';
import { replacementDeletePolicy } from '../provisioning/final-snapshot.js';
import { CdkdError } from '../utils/error-handler.js';
import { displaySafe } from '../utils/display-safe.js';
import {
  createSecretMasker,
  carryLogOnlyValues,
  maskSecretsInError,
  recordNestedStackParameterExpressions,
  STATE_DERIVED_RULES,
  type RecordedSecretValues,
} from './secret-redaction.js';
import {
  isNameCollisionErrorFrom,
  isNameCooldownError,
  isRecreateRetryableError,
  markNonRetryable,
} from './retryable-errors.js';
import { updatePartialMessage, updatePartialReason } from './update-outcome.js';
import { RollbackInlinePolicyWriters } from './inline-policy-claims.js';
import {
  type CompletedOperation,
  type RollbackExecutorContext,
  type RollbackReplayResult,
  type FailedOperation,
  type FailedOpReplayResult,
} from './rollback-executor/types.js';
import {
  ReplayResolvers,
  redactRollbackRecord,
  replayProducerRegionEvidence,
} from './rollback-executor/replay-secrets.js';
import {
  partitionOps,
  sortRollbackCreates,
  classifyRollbackOp,
  resolveReplacementOldType,
  unroutableReplacementError,
  deepEqual,
  classifyFailedOp,
} from './rollback-executor/plan.js';
import {
  createOpMasker,
  addRecordNames,
  prepareCreateRollbackFinalSnapshot,
  requireRestorableBaseline,
  replayPrefixScope,
} from './rollback-executor/names.js';
import {
  safe,
  effectiveProvisionedBy,
  throwIfDeleteSkipped,
  rollbackRetainsNewResource,
  retainedSurvivorMessages,
  rollbackFinalSnapshotId,
  rerunRollbackPhrase,
  replayingStateCreateContext,
  orphanRemedy,
  refusalPhysicalId,
  ownRemedyError,
  refusalLogicalId,
  refusalResourceType,
  describedPhysicalIdPointer,
  collisionLine,
  shownLogicalId,
  maskedFailureText,
  shownChangeType,
  maskedRollbackEventError,
} from './rollback-executor/messages.js';
import {
  resolveReplayProps,
  refuseMaskedReplayBaseline,
} from './rollback-executor/replay-props.js';
import {
  createWithRollbackRetry,
  recordedPropertiesAfterReplayCreate,
  updateWithRollbackRetry,
  recordAfterRollbackUpdate,
} from './rollback-executor/replay-retry.js';
export {
  rollbackFinalSnapshotId,
  rollbackRetainsNewResource,
  retainedSurvivorMessages,
} from './rollback-executor/messages.js';

export {
  type CompletedOperation,
  type FailedOperation,
  type RollbackExecutorContext,
  type RollbackActionKind,
  type FailedOpActionKind,
  type FailedOpPlanItem,
  type RollbackPlanItem,
  type FailedOpReplayResult,
  type RollbackReplayResult,
} from './rollback-executor/types.js';
export {
  resolveReplacementOldType,
  isTypeChangeOp,
  isReplacementOp,
  classifyRollbackOp,
  classifyFailedOp,
  planFailedOps,
  planRollback,
  sortRollbackCreates,
} from './rollback-executor/plan.js';

export { refuseUnprovenReplaySecret } from './rollback-executor/replay-secrets.js';

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
 *   (`nested-child-journal.ts`) pass one; `DeployEngine.performRollback`
 *   passes none, and its caller saves state once at the end.
 * - `isInterrupted` is polled between ops; when it flips true, replay stops
 *   (the pending op is left for a re-run).
 */
async function replayRollbackUnbound(
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
     * go-to-k/cdkd#4225: the completed writes an `AWS::IAM::Policy` revert or
     * delete, or a role / group / user revert, asks about before removing an
     * inline policy name. A caller that
     * replays more than once over one state bag (a segment's failed ops, then
     * its completed ops, then older segments) passes ONE instance to every
     * call; absent, this replay keeps its own.
     */
    inlinePolicyWriters?: RollbackInlinePolicyWriters;
  } = {}
): Promise<RollbackReplayResult> {
  const orphanLogicalIds = options.orphanLogicalIds ?? new Set<string>();
  const inlinePolicyWriters = options.inlinePolicyWriters ?? new RollbackInlinePolicyWriters();
  const result: RollbackReplayResult = {
    failures: 0,
    warnings: 0,
    interrupted: false,
    orphaned: [],
  };

  if (operations.length === 0) {
    ctx.logger.info('No completed operations to roll back.');
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

  const { createOps, otherOps } = partitionOps(operations);

  // Step 1: UPDATE/DELETE rollbacks in reverse completion order.
  for (let i = otherOps.length - 1; i >= 0; i--) {
    if (options.isInterrupted?.()) {
      result.interrupted = true;
      break;
    }
    await replaySingle(
      otherOps[i]!,
      stateResources,
      stackName,
      ctx,
      resolver,
      orphanLogicalIds,
      result,
      options.onOrphan,
      inlinePolicyWriters,
      options.afterOp,
      options.isInterrupted
    );
  }

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
        options.isInterrupted
      );
    }
  }

  ctx.logger.info('Rollback completed. Some resources may remain if deletion failed.');
  ctx.recordEvent?.({ eventType: 'ROLLBACK_FINISHED', stackName });
  return result;
}

/**
 * The region classifier and its helpers moved to
 * `./secret-region-classification.js` for issue
 * [#2134](https://github.com/go-to-k/cdkd/issues/2134): the resolver needs the
 * same answer, and THIS module imports the resolver, so the dependency had to
 * run the other way.
 *
 * Re-exported here rather than repointing the importers, because
 * `classifyReplaySecretRegion` and `producerRegionsFromState` are named in the
 * `cdkd drift` / `cdkd scrub` docs and in several issue threads as living on
 * the replay -- and the point of the shared classifier is that there is ONE
 * answer, not that it has one address.
 */
export {
  classifyReplaySecretRegion,
  producerRegionsFromState,
  regionLessSecretName,
  type ReplaySecretRegionVerdict,
} from './secret-region-classification.js';

import { withProducerRegions } from './producer-regions-scope.js';

async function replaySingle(
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
  isInterrupted?: () => boolean
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
  const opMasker = createOpMasker(logger, secrets);
  const mask = opMasker.mask;
  /**
   * The route a CREATE-rollback arm resolved for this op (issue #1366) —
   * hoisted so the shared catch's ROLLBACK_RESOURCE_FAILED reports the route
   * the delete was going to take, which is the one a refusal is about. Stays
   * `undefined` on the UPDATE / replacement arms, where the catch keeps the
   * journaled value (those arms resolve their own routing separately).
   */
  let createRollbackRoute: 'sdk' | 'cc-api' | undefined;

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
        result.warnings++;
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
        result.warnings++;
        return;
      }

      case 'skip-absent': {
        logger.warn(
          `  Rollback: Cannot restore ${safe(op.logicalId)} — resource no longer in state, skipping`
        );
        result.warnings++;
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

      case 'orphan-flag': {
        if (op.changeType === 'CREATE') {
          // --orphan on a CREATE: leave the resource in AWS, drop it from
          // state (it is not part of the pre-deploy baseline).
          //
          // Bound BEFORE the delete, and the ONLY source for both the route
          // and the id below. Route resolution already read the record here
          // (issue #1366, so both orphan triggers resolve `provisionedBy` the
          // same way); the id used to read `op` instead, which made this arm
          // internally inconsistent about which side it trusted.
          //
          // Load-bearing for the id specifically, because `orphan-flag` is NOT
          // reachable-only-past-the-checks the way `orphan-retain` is:
          // `classifyRollbackOp` returns it from a short-circuit ABOVE the
          // CREATE branch, so it skips both `skip-already-done` (no record)
          // and `skip-mismatch` (record id != op id) -- and
          // `orphanLogicalIds` is RAW CLI INPUT, never validated against
          // state. Publishing `op.physicalId` unconditionally therefore
          // asserted "live, still billing" about an id that may be DELETED (a
          // re-run of an already-orphaned op) or STALE (a later attempt moved
          // the id, and the real survivor would be named nowhere). For a
          // name-reusable type a deleted id may by then belong to someone
          // else's resource, which is the worst thing a cleanup pass could be
          // handed.
          const record = stateResources[op.logicalId];
          const orphanFlagProvisionedBy = effectiveProvisionedBy(record, op.provisionedBy);
          createRollbackRoute = orphanFlagProvisionedBy;
          // Drops a state row beside the `afterOp` save below and mints NO
          // record, deliberately (issue #2934): `--orphan` is the user saying
          // "leave this one alone" about a rollback stuck on it, not a
          // `DeletionPolicy`, so re-adopting it on the next deploy would
          // contradict the instruction. The two Retain arms are the only
          // minters.
          delete stateResources[op.logicalId];
          logger.info(`  Rollback: Orphaning created resource ${safe(op.logicalId)} (--orphan)`);
          await afterOp?.(op.logicalId);
          // Emit the same rollback event as the DeletionPolicy-orphan path
          // (`orphan-retain`) so `cdkd events` surfaces the orphaned resource
          // consistently regardless of which orphan trigger fired.
          ctx.recordEvent?.({
            eventType: 'ROLLBACK_RESOURCE_SUCCEEDED',
            stackName,
            operation: 'CREATE',
            logicalId: op.logicalId,
            resourceType: op.resourceType,
            ...(orphanFlagProvisionedBy && { provisionedBy: orphanFlagProvisionedBy }),
            // The survivor's id, same class as the replacement-rollback retain
            // arms and STRICTLY worse without it: this arm drops the state
            // record too, so with no id here NOTHING anywhere names the
            // resource left running in AWS.
            //
            // Gated on the RECORD, not on `op.physicalId` -- see the binding
            // above. No record means nothing was orphaned (the resource is
            // already gone), and then the honest event is one that claims no
            // survivor at all.
            ...(record?.physicalId && {
              physicalId: record.physicalId,
              // The PROSE is masked (issue #4037); the `physicalId` FIELD is the
              // cleanup datum and stays exact, like the record `state.json`
              // itself holds in the same bucket.
              reason: mask(
                `--orphan left ${op.logicalId} (${op.resourceType}) in AWS as ` +
                  `${record.physicalId} and dropped it from state; it is live, still billing, ` +
                  `and no longer tracked by cdkd.`
              ),
            }),
          });
        } else {
          // --orphan on an UPDATE: leave the resource at its new properties;
          // keep state as-is so it keeps describing AWS truth.
          logger.info(`  Rollback: Leaving ${safe(op.logicalId)} at its new state (--orphan)`);
        }
        return;
      }

      case 'orphan-retain': {
        // DeletionPolicy Retain on a rolled-back CREATE: orphan instead of
        // delete (the policy says KEEP the resource). `Snapshot` used to
        // land here too — see the module header + issue #1358.
        //
        // Resolved BEFORE the record is dropped: the event reports the
        // resource's effective route (issue #1366), and the record — the
        // authoritative side — is about to go away. The id below reads the
        // SAME binding, so the two halves of this event cannot disagree about
        // which side they trust.
        const record = stateResources[op.logicalId];
        const orphanProvisionedBy = effectiveProvisionedBy(record, op.provisionedBy);
        createRollbackRoute = orphanProvisionedBy;
        // Keep what we are about to throw away (issue #2934). cdkd's generated
        // physical names are deterministic, so this resource now holds the
        // exact name the next deploy will ask AWS for — without the record
        // that deploy collides, rolls back, and repeats forever.
        //
        // The RECORD, not a physical id: its `properties` are the failed
        // deploy's resolved TEMPLATE values, which is the shape the diff
        // expects on the old side. Re-adopting from an AWS readback instead
        // would carry keys the template omits (a generated `RoleName`,
        // `BucketName`, ...) and the next diff would read them as removals of
        // create-only properties and REPLACE the resource — destroying the
        // data the adoption exists to preserve.
        //
        // Guarded on `record` because `replayRollback` is idempotent: a replay
        // over an already-reverted segment finds nothing here, and pushing an
        // `undefined` state would mint a record no consumer can act on.
        if (record) {
          const orphaned = { logicalId: op.logicalId, orphanedAt: Date.now(), state: record };
          result.orphaned.push(orphaned);
          // BEFORE the `afterOp` below, which SAVES. Reading `result.orphaned`
          // only after this function returns would let every intermediate save
          // persist the resource's absence with no record of it.
          onOrphan?.(orphaned);
        }
        delete stateResources[op.logicalId];
        logger.info(
          `  Rollback: Leaving ${safe(op.logicalId)} (${safe(op.resourceType)}) in AWS ` +
            `(DeletionPolicy: Retain) — removed from state`
        );
        await afterOp?.(op.logicalId);
        ctx.recordEvent?.({
          eventType: 'ROLLBACK_RESOURCE_SUCCEEDED',
          stackName,
          operation: 'CREATE',
          logicalId: op.logicalId,
          resourceType: op.resourceType,
          ...(orphanProvisionedBy && { provisionedBy: orphanProvisionedBy }),
          // Same publish as the `--orphan` twin above: the state record is
          // dropped, so this event is the only place the retained resource's
          // id survives.
          //
          // Reads the RECORD, not `op.physicalId`, for a reason that differs
          // from the twin's. This arm IS only reachable past
          // `skip-already-done` / `skip-mismatch`, so its record is present
          // and matching -- the gate is belt-and-braces here. What the record
          // read fixes is the opposite hole: `classifyRollbackOp` only
          // compares the ids when `op.physicalId` is DEFINED, so a journal op
          // carrying none still reaches this arm, and reading `op` there
          // dropped the publish entirely and lost the id the record was
          // holding all along.
          ...(record?.physicalId && {
            physicalId: record.physicalId,
            // Prose masked, field exact: the `--orphan` twin's note.
            reason: mask(
              `DeletionPolicy: Retain left ${op.logicalId} (${op.resourceType}) in AWS as ` +
                `${record.physicalId} and dropped it from state; it is live, still billing, and ` +
                `no longer tracked by cdkd.`
            ),
          }),
        });
        return;
      }

      case 'delete':
      case 'delete-with-final-snapshot': {
        if (!op.physicalId) {
          logger.warn(`  Rollback: Cannot delete ${safe(op.logicalId)} — no physical ID recorded`);
          result.warnings++;
          return;
        }
        // `DeletionPolicy: Snapshot` (issue #1358): snapshot BEFORE the
        // delete. Deliberately ahead of the delete's own call so a refusal /
        // snapshot failure leaves the resource intact (and counts as a
        // failure, keeping the journal for a re-run) rather than deleting
        // the data the policy promised to preserve. `--skip-final-snapshot`
        // is the explicit data-loss opt-out and degrades to a plain delete.
        //
        // The routing layer is resolved ONCE and used for BOTH the snapshot
        // gate and the provider lookup below: the gate's cc-api refusal is
        // only meaningful if it judges the route the delete will actually
        // take, and the delete-of-the-NEW-resource site already resolves it
        // this way (`current.provisionedBy ?? op.provisionedBy`).
        const deleteProvisionedBy = effectiveProvisionedBy(
          stateResources[op.logicalId],
          op.provisionedBy
        );
        createRollbackRoute = deleteProvisionedBy;
        const snapshotPolicy = action === 'delete-with-final-snapshot';
        const takeFinalSnapshot = snapshotPolicy && ctx.skipFinalSnapshot !== true;
        let finalSnapshotIdentifier: string | undefined;
        if (takeFinalSnapshot) {
          finalSnapshotIdentifier = await prepareCreateRollbackFinalSnapshot(
            op,
            deleteProvisionedBy,
            ctx,
            mask
          );
        }
        logger.info(
          `  Rollback: Deleting created resource ${safe(op.logicalId)} (${safe(op.resourceType)})` +
            (takeFinalSnapshot ? ' — DeletionPolicy: Snapshot' : '') +
            // Make the opt-out auditable: without this the line is
            // byte-identical to a plain delete, so neither the log nor
            // `cdkd events` records that a Snapshot-policy resource was
            // destroyed with no snapshot.
            (snapshotPolicy && !takeFinalSnapshot
              ? ' — DeletionPolicy: Snapshot NOT taken (--skip-final-snapshot)'
              : '')
        );
        // Route via the SAME provider the CREATE landed on (#614).
        const { provider } = ctx.providerRegistry.getProviderFor({
          resourceType: op.resourceType,
          provisionedBy: deleteProvisionedBy,
        });
        // go-to-k/cdkd#4225: a name a completed revert of this replay has put
        // back on a principal is not removed by this delete.
        const createRollbackClaimed = inlinePolicyWriters.claimedFor(
          op.resourceType,
          op.logicalId,
          stateResources
        );
        const createRollbackDelete = await provider.delete(
          op.logicalId,
          op.physicalId,
          op.resourceType,
          op.properties,
          {
            expectedRegion: ctx.region,
            ...(createRollbackClaimed && { inlinePolicyClaimed: createRollbackClaimed }),
            ...(finalSnapshotIdentifier !== undefined && { finalSnapshotIdentifier }),
            ...(ctx.skipFinalSnapshot === true && { skipFinalSnapshot: true }),
            // Issue #4029: the classified policy, so a Cloud Control-routed
            // RDS delete under `Delete` avoids the registry handler's snapshot.
            deletionPolicy: snapshotPolicy ? 'Snapshot' : 'Delete',
            // Issue #4157. `classifyRollbackOp` reaches this arm only with a
            // record naming `op.physicalId`.
            recordedAttributes: stateResources[op.logicalId]?.attributes,
          }
        );
        throwIfDeleteSkipped(
          createRollbackDelete,
          op.logicalId,
          op.physicalId,
          'while rolling back its CREATE'
        );
        delete stateResources[op.logicalId];
        logger.info(`  Rollback: ${safe(op.logicalId)} deleted successfully`);
        await afterOp?.(op.logicalId);
        ctx.recordEvent?.({
          eventType: 'ROLLBACK_RESOURCE_SUCCEEDED',
          stackName,
          operation: 'CREATE',
          logicalId: op.logicalId,
          resourceType: op.resourceType,
          // The route the delete ACTUALLY took, not the journaled one
          // (issue #1366) — a legacy journal entry can disagree with the
          // state record, and the record is what the delete was routed by.
          ...(deleteProvisionedBy && { provisionedBy: deleteProvisionedBy }),
        });
        return;
      }

      case 'reverse-replacement-readopt': {
        // Replacement rollback where UpdateReplacePolicy: Retain orphaned
        // the OLD physical resource (issue #1199): it still exists with its
        // data, so delete the NEW resource and point state back at the old
        // one — a true clean revert, no re-create needed.
        const current = stateResources[op.logicalId]!;
        const prev = op.previousState!;
        logger.info(
          `  Rollback: Reversing replacement of ${safe(op.logicalId)} (${safe(op.resourceType)}) — ` +
            `deleting the new resource and re-adopting the retained old one ` +
            `(${displaySafe(mask(prev.physicalId))})`
        );
        /**
         * Set when this arm ORPHANS the replacement's new copy. Read at the
         * `ROLLBACK_RESOURCE_SUCCEEDED` event below, which is the only channel
         * that OUTLIVES the terminal (security review of issue #2598): a
         * rollback runs during an already-failing deploy, often non-TTY with
         * the log truncated or discarded, so a `logger.warn` is the least
         * likely thing the user still has. Without this the survivor's id dies
         * with the terminal -- `cdkd events` shows a clean success and state
         * names only the OLD resource, while a live, billing, untracked copy
         * remains. `Retain` is precisely the marker users put on data-bearing
         * resources, so that is the worst population to lose the id for.
         *
         * Same shape as the `rollbackPartial` survivor record ~700 lines down
         * and as the deploy engine's `RESOURCE_SKIPPED` twin.
         */
        let survivorReason: string | undefined;
        if (rollbackRetainsNewResource(current)) {
          // ON THIS ARM THIS IS THE ALWAYS-CASE, not an exception, and saying
          // so is the point (review of issue #2598). `oldResourceRetained` is
          // set only when the TEMPLATE being applied declared
          // `UpdateReplacePolicy: Retain`, and the SAME template read
          // populates the new record through `extractTemplateAttributes` — so
          // whenever `classifyRollbackOp` reaches `reverse-replacement-readopt`
          // for a journal any cdkd binary wrote, `current` carries `Retain`
          // too. Net effect: this rollback path no longer deletes the new copy
          // at all, which is a real behaviour change and is what CloudFormation
          // does (the A/B's `DELETE_SKIPPED` rows). The `else` below is kept
          // for a record that did NOT come from that pairing — a hand-edited
          // or externally-produced state file — rather than deleted, because
          // the classifier and this executor are separately reachable and a
          // dead-by-construction branch is cheaper than a crash when the
          // construction changes. The `reverse-replacement` twin is genuinely
          // conditional: a provider that re-creates inside its own `update()`
          // reaches it with either polarity.
          //
          // Issue #2598: the NEW copy declares `UpdateReplacePolicy: Retain`,
          // which the A/B on {@link rollbackRetainsNewResource} measured as
          // the attribute governing this very delete. CloudFormation reports
          // `DELETE_SKIPPED` here and orphans the copy out of the stack; cdkd
          // does the same, and the state re-point below leaves nothing naming
          // it. Warned rather than logged at info: the outcome is a live,
          // untracked, billing resource, the same class as the deploy engine's
          // `Retain` survivor warning.
          const survivorMessages = retainedSurvivorMessages(
            op.logicalId,
            op.resourceType,
            current.physicalId,
            `State is restored to the old resource (${prev.physicalId}).`,
            mask
          );
          logger.warn(survivorMessages.warn);
          survivorReason = survivorMessages.reason;
          result.warnings++;
        } else {
          // Resolved INSIDE this arm (review of issue #2598): the retain arm
          // above issues no AWS call at all, and `getProviderFor` THROWS for a
          // type the rollback command's registry cannot route (an
          // `--allow-unsupported-types` type, say). Hoisted, a readopt that
          // deletes nothing could fail on a lookup it never needed.
          const { provider: newDeleteProvider } = ctx.providerRegistry.getProviderFor({
            resourceType: op.resourceType,
            provisionedBy: current.provisionedBy ?? op.provisionedBy,
          });
          const finalSnapshotIdentifier = rollbackFinalSnapshotId(
            op.resourceType,
            current,
            op.provisionedBy
          );
          // go-to-k/cdkd#4225: as on the reverse replacement's deletes below.
          const readoptClaimed = inlinePolicyWriters.claimedFor(
            op.resourceType,
            op.logicalId,
            stateResources
          );
          const readoptDelete = await newDeleteProvider.delete(
            op.logicalId,
            current.physicalId,
            op.resourceType,
            current.properties,
            {
              expectedRegion: ctx.region,
              ...(readoptClaimed && { inlinePolicyClaimed: readoptClaimed }),
              ...(finalSnapshotIdentifier !== undefined && { finalSnapshotIdentifier }),
              // Issue #4029: the NEW copy's UpdateReplacePolicy governs.
              deletionPolicy: replacementDeletePolicy(current.updateReplacePolicy),
              recordedAttributes: current.attributes,
            }
          );
          // Issue #1762: BEFORE the state re-point, so a skip cannot leave
          // state naming the retained OLD resource while the NEW one is still
          // alive — two live resources with state describing one. The `Retain`
          // arm above reaches that same shape DELIBERATELY, which is why it
          // announces it rather than failing the op.
          throwIfDeleteSkipped(
            readoptDelete,
            op.logicalId,
            current.physicalId,
            'while reversing its replacement (re-adopting the retained old resource)'
          );
        }
        stateResources[op.logicalId] = prev;
        logger.info(`  Rollback: ${safe(op.logicalId)} restored to the retained old resource`);
        await afterOp?.(op.logicalId);
        // The SURVIVOR's routing layer, which is NOT the op's. Follow-up to
        // the security review of issue #2598: the layer field sitting beside
        // `physicalId` is what tells a cleanup pass WHICH API manages that id,
        // so shipping the id with a possibly-wrong layer beside it partly
        // defeats the fix -- a consumer reading the pair could dispatch the
        // wrong provider at a live, untracked resource. Before that fix these
        // events named no resource at all, so the mislabel was inert; the id
        // is what makes it bite. The deploy engine's `RESOURCE_SKIPPED` twin
        // snapshots the survivor's layer for exactly this reason.
        //
        // NO `?? op.provisionedBy` here, and that absence is deliberate: an
        // earlier revision had one and it was DEAD. When the record carries no
        // layer (a pre-v7 record) this override simply does not fire, and the
        // unconditional `op.provisionedBy` spread below already put the op's
        // layer on the event -- which is the right answer for that case and
        // the exact behaviour the fallback was written to produce. Measured:
        // deleting the `??` changed no emitted value, so nothing could ever
        // fence it. Pinned by the pre-v7 case, which fences the SPREAD.
        const survivorProvisionedBy = current.provisionedBy;
        ctx.recordEvent?.({
          eventType: 'ROLLBACK_RESOURCE_SUCCEEDED',
          stackName,
          operation: 'UPDATE',
          logicalId: op.logicalId,
          resourceType: op.resourceType,
          ...(op.provisionedBy && { provisionedBy: op.provisionedBy }),
          // The mask on `reason` below is a BELT here, and no case can tell it
          // apart: `retainedSurvivorMessages` already masked the survivor's id
          // and clause with the op's masker (issue #4037), which on this arm
          // carries no plaintext but does carry the ids of a record whose name
          // is still a `{{resolve:...}}` reference. Kept so the two twin event
          // sites stay literally identical.
          //
          // BOTH fields, and both gated on there actually BEING a survivor:
          // with no retention this event describes a completed revert, and a
          // `physicalId` here would then name the resource this rollback just
          // DELETED. The id rides as a FIELD, not only inside `reason` -- a
          // `--json` consumer should not have to parse prose, and it is the
          // one datum a cleanup pass needs. Masked because the record is
          // durable, the same reason the survivor record below masks.
          ...(survivorReason !== undefined && {
            physicalId: current.physicalId,
            reason: mask(survivorReason),
            // Overrides the op's layer spread above -- a later spread wins.
            // Gated with the other two, deliberately: on a non-retain revert
            // this event describes the OP, and the op's layer is correct there.
            ...(survivorProvisionedBy && { provisionedBy: survivorProvisionedBy }),
          }),
        });
        return;
      }

      case 'reverse-replacement': {
        // Replacement rollback (issue #1199): the OLD physical resource is
        // already destroyed, so an in-place update against the NEW resource
        // would throw on the immutable property. Instead re-CREATE the old
        // resource from its journaled previousState and delete the new one.
        const current = stateResources[op.logicalId]!;
        const prev = op.previousState!;
        // Issue #2668: a replacement has TWO types. Everything below that
        // re-creates the OLD resource routes on `oldType`; everything that
        // deletes the NEW one keeps `op.resourceType`. `classifyRollbackOp`
        // already refused an op whose old type cannot be named, so the `throw`
        // is for a caller that reaches this arm without it.
        const oldTypeRouting = resolveReplacementOldType(op);
        if (!oldTypeRouting.ok) {
          throw unroutableReplacementError(op, oldTypeRouting.reason, ctx);
        }
        const oldType = oldTypeRouting.oldType;
        const typeChanged = oldType !== op.resourceType;
        // Issue #3203, BEFORE any AWS call and before the secret resolution:
        // `{}` here would create a default-configured resource and then delete
        // the live one.
        if (
          !requireRestorableBaseline(prev.properties, logger, {
            logicalId: op.logicalId,
            consequence: 'create a default-configured resource and then delete the live one',
            remedy: 'Re-run `cdkd deploy` to re-converge it.',
            retry: `re-running ${rerunRollbackPhrase(ctx, '`cdkd rollback`')} retries this op`,
          })
        ) {
          result.warnings++;
          return;
        }
        // Re-resolve the redacted secret expressions for the re-CREATE (GHSA
        // fix): the old resource must be re-created with the concrete secret,
        // not the literal `{{resolve:...}}` string. `secrets` (hoisted to the
        // top of this function) captures plaintext->expression to redact the
        // rebuilt state record below AND to mask every log site downstream.
        // The `?? {}` is DEAD AT RUNTIME since issue #3203's guard above --
        // see the `revert` arm's note for the full reason; it is kept because
        // `resolveReplayProps` DECLARES `| undefined` unconditionally.
        const resolvedPrevProps =
          (await resolveReplayProps(prev.properties, resolver, secrets, ctx, op.logicalId)) ?? {};
        // Issue #2274: this bag is about to be CREATED with. Refuse before the
        // AWS call rather than after, so nothing is half-applied.
        refuseMaskedReplayBaseline(resolvedPrevProps, op.logicalId);
        // Issue #4037: the old name is PLAINTEXT now, so its derived spellings
        // (the old id, the names its provider sends) join the op's masker.
        opMasker.addNamed({
          resourceType: oldType,
          properties: resolvedPrevProps,
          logicalId: op.logicalId,
          physicalIds: [prev.physicalId],
        });
        // Issue #2291: a nested-stack row replayed here hands the CHILD engine
        // this same `secrets` bag (`withCurrentResourceSecrets` binds it around
        // the provider call below, and `NestedStackProvider` seeds the child
        // from it). The bag is keyed by PLAINTEXT, so two child `Parameters`
        // resolving to one value have already collapsed in it -- and without
        // the per-parameter table the child re-persists the SURVIVOR for both
        // leaves, silently rewriting correct state back into the #2291 shape.
        // A `cdkd drift --revert` inside that window then pushes the WRONG
        // secret version to the live child resource (the
        // GHSA-p5qg-v9gv-hc7w replay class). Waiting for the next deploy to
        // heal it is not an answer: `--revert` is used precisely then.
        //
        // WHICH RECORD DRIFTS, precisely, because a review round proposed
        // softening this on the grounds that `NestedStackProvider` declares no
        // `readCurrentState`. That is true of the `AWS::CloudFormation::Stack`
        // ROW only -- that row never drifts. The CHILD's own records do:
        // `S3StateBackend.listStacks` has no filter excluding a
        // `{parent}~{Child}` key (it is exactly `NEW_KEY_DEPTH`), so the child
        // state is enumerated as an ordinary stack and `drift.ts` re-resolves
        // its persisted expressions like any other. The claim stands as
        // written.
        //
        // THE SOURCE IS THE JOURNAL, not the child's template. The journaled
        // record is the UNCOLLAPSED one -- since issue #1904 each of its leaves
        // holds its OWN `{{resolve:...}}` token -- which is exactly what the
        // position pass needs, and it is also the bag `resolveReplayProps` just
        // produced this resolved side FROM.
        //
        // `STATE_DERIVED_RULES`, not the recorder's `TEMPLATE_DERIVED_RULES`
        // default: the source is a persisted record, so it holds no PUBLIC
        // `ssm:` reference (a `String` parameter is stored resolved), and it IS
        // the same generation the bag was resolved from one statement earlier.
        // That is the identical pairing `redactRollbackRecord` makes for the
        // record it positions.
        //
        // THE FIRST HALF OF THAT PREMISE HAS A DOCUMENTED CARVE-OUT, and saying
        // it unqualified -- as this note first did -- restates something
        // `PathSourceRules`' own doc contradicts: `cdkd import` WARNS and
        // persists the RAW template intrinsic, so a public `ssm:` expression CAN
        // sit in a record's `properties`. Measured in review: the POSITION
        // pass certifies such a token here and refuses it under
        // `TEMPLATE_DERIVED_RULES`. Since issue #3090 the recorder no longer
        // RECORDS it either way -- its refusal 5 asks the pass's pair table,
        // which a public token (resolved as public, never paired) is not in --
        // so the child's leaf falls to the value scan. The cost before that
        // was bounded to the issue #1901 class (a spurious UPDATE, never a
        // disclosure: a reference either way); what remains is the ordinary
        // value-scan answer, and every replay of an imported stack's nested
        // parameters still runs.
        //
        // The WRONG fix, ruled out explicitly: do NOT gate this on
        // `isKnownSecretExpression`. That reopens refusal 2b's hole, where an
        // `ssm` reference whose verdict is unpinned falls to the value scan and
        // the losing parameter is recorded against the SIBLING's expression.
        //
        // ONLY THE DESIRED SIDE. The other bag each arm resolves (`currentProps`
        // / `attemptedProps`) is a DIFFERENT generation, and
        // `NestedStackProvider` forwards only `properties` -- the desired side --
        // as the child's `Parameters`. Recording both would POISON every
        // parameter name whose expression changed between the two generations,
        // which refuses the very population this exists to serve.
        recordNestedStackParameterExpressions(
          secrets,
          oldType,
          resolvedPrevProps,
          prev.properties,
          STATE_DERIVED_RULES
        );
        logger.info(
          `  Rollback: Reversing replacement of ${safe(op.logicalId)} ` +
            `(${typeChanged ? `${safe(op.resourceType)} -> ${safe(oldType)}` : safe(op.resourceType)}) — ` +
            `re-creating the old resource and deleting the new one`
        );
        // Advisory only (issue #1199 non-goal: cdkd does not recover the data —
        // surface clearly rather than silently "revert"). NOT counted in
        // result.warnings: the reverse-replacement op itself succeeds, and
        // warnings map to exit code 2.
        //
        // The claim is scoped to what THIS ROLLBACK does, not to what AWS
        // permits. `STATEFUL_TYPES` is not uniform on that second question:
        // most members' data is gone the moment the replacement's delete
        // lands, but `KMSProvider.delete` deletes an `AWS::KMS::Key` by
        // SCHEDULING a deletion, which a user may be able to act on out of
        // band. (`AWS::KMS::ReplicaKey` has no SDK provider, so its delete
        // routes through Cloud Control and this repo has not measured what
        // that does.) A blanket "CANNOT be recovered" would be a statement
        // about AWS that this repo has not measured — and, for KMS, would
        // steer a user away from a recovery that may still exist.
        // The OLD type (issue #2668): it is the old resource's data this is about.
        if (STATEFUL_TYPES.has(oldType)) {
          logger.warn(
            `  ⚠ ${safe(op.logicalId)} (${safe(oldType)}) is a stateful type — the old physical ` +
              `resource's data was destroyed by the replacement and is NOT recovered by this ` +
              `rollback; the re-created resource starts empty.`
          );
        }
        // Route the re-create via the OLD resource's recorded layer AND TYPE,
        // and the new resource's delete via ITS layer and type (the layers can
        // differ — e.g. a --recreate-via-cc-api migration; the types differ on
        // a `Type` change, issue #2668, where the single `op.resourceType` used
        // to re-create the old resource through the NEW type's provider).
        const { provider: createProvider, provisionedBy: createProvisionedBy } =
          ctx.providerRegistry.getProviderFor({
            resourceType: oldType,
            provisionedBy: prev.provisionedBy,
          });
        // The bag the two replay-CREATEs below hand the provider (issue #3199).
        //
        // `resolvedPrevProps` is the RECORDED bag, which `propertiesToRecord`
        // fills from the template's resolved properties — so it never carries a
        // name cdkd GENERATED, by the same invariant the deploy engine's Cloud
        // Control UPDATE path relies on. A Cloud Control CREATE, however, is
        // exactly where that name is required: `preparePropertiesForCcApi`
        // fills it at all three of the engine's create sites, and these two
        // replay sites are the FOURTH. Without it the replay re-creates under
        // an AWS-random name, so the restored resource silently stops matching
        // the name the forward path mints for it.
        //
        // The shape that reaches this is WIDER than "a deploy that added an
        // explicit name": the arm is selected by a CHANGED PHYSICAL ID, so for
        // any table type whose physical id is NOT its name, an ordinary
        // create-only edit elsewhere gets here with a nameless recorded bag —
        // `AWS::ElasticLoadBalancingV2::TargetGroup` (id `TargetGroupArn`,
        // create-only `Port` / `VpcId` / ...), its `LoadBalancer` sibling
        // (`Scheme` / `Type`) and `AWS::WAFv2::WebACL` (`Scope`) all do.
        //
        // A type whose Cloud Control handler REJECTS a nameless create fails
        // the replay outright instead, which on the delete-new-first arm below
        // leaves the resource absent from AWS AND from state. No such type is
        // in `FALLBACK_NAME_RULES` yet — `AWS::Lambda::CapacityProvider` is the
        // known one and its entry arrives with go-to-k/cdkd#3182 — so today
        // this fix is about the silent-divergence half.
        //
        // Gated on the ROUTING DECISION rather than `prev.provisionedBy`: the
        // recorded hint is absent on a pre-v7 record, the registry may route a
        // type with no SDK provider to Cloud Control regardless, and the sticky
        // rule's `sdk-coverage` exemption can return an SDK provider for a
        // `cc-api` hint — so the decision is the only reading that matches what
        // the create will actually call. An SDK-routed create is left alone:
        // its provider mints the name itself, which is what
        // `FALLBACK_NAME_RULES` mirrors.
        //
        // The OUTER SPREAD is load-bearing, not redundant:
        // `applyDefaultNameForFallback` returns its argument BY IDENTITY when
        // the type has no rule or the name is already set, so removing it would
        // hand `resolvedPrevProps` to the provider by reference and give up the
        // fresh copy the pre-#3199 `{ ...resolvedPrevProps }` guaranteed.
        //
        // Applied ONLY to the bag handed to `create()`, never to
        // `resolvedPrevProps` itself: that value also feeds
        // `recordNestedStackParameterExpressions` and the record rebuild below,
        // and writing a generated name back into the RECORD would break the
        // very invariant this comment opens with. That the name cannot reach
        // the record is conditional on a FACT ABOUT ROUTING, not on this call:
        // the rebuild honours `createResult.effectiveProperties` (#1682), and
        // every `provisionedBy: 'cc-api'` route returns `CloudControlProvider`,
        // which never reports one. A future CC-routed provider that did would
        // put the generated name into `properties` — fenced by the
        // record-leak case in
        // `tests/unit/deployment/rollback-executor-replay-fallback-name.test.ts`.
        //
        // KNOWN BOUND: the engine's `preparePropertiesForCcApi` prefers an SDK
        // provider's `preparePropertiesForFallback` hook and falls back to
        // `applyDefaultNameForFallback`; this call skips the hook. No provider
        // implements it today (grep: the interface declaration and the engine's
        // dispatch are the only hits), so the two agree — but the first
        // implementor makes rollback mint a different name than deploy.
        const replayCreateProps = (): Record<string, unknown> => ({
          ...(createProvisionedBy === 'cc-api'
            ? applyDefaultNameForFallback(op.logicalId, oldType, resolvedPrevProps)
            : resolvedPrevProps),
        });
        // Issue #4024: the prefix flag the OLD resource was created under,
        // which may not be the failed deploy's. BOTH creates below and the
        // name-holder proof run in it: the proof derives the name the create
        // SENT, so a proof in the failed deploy's scope would name a different
        // one — and could prove the live new resource the holder of a name it
        // never had, then delete it.
        const inOriginalPrefix = replayPrefixScope(
          {
            resourceType: oldType,
            properties: resolvedPrevProps,
            logicalId: op.logicalId,
            physicalId: prev.physicalId,
            via: createProvisionedBy,
          },
          logger,
          mask,
          true
        );
        // LAZY, for the same reason the readopt arm resolves inside its `else`
        // (review of issue #2598): `getProviderFor` THROWS for a type this
        // registry cannot route, and THREE paths below never delete anything --
        // the `Retain` warn arm, the collision REFUSAL, and the
        // `adoptedLiveNewResource` arm (whose `else if` skips the delete).
        // Resolved eagerly, any of them could fail on a lookup it never
        // needed, before the re-create is even attempted. Called at each
        // delete site instead; the two sites are mutually exclusive via
        // `!deletedNewFirst`, so at most one lookup runs per op.
        //
        // ONE SEVERITY CHANGE this makes, stated because it is not obvious:
        // at the `deleteNewAfterRecreate` site the call now sits INSIDE that
        // block's `try`, so an unroutable type there degrades to the site's
        // warn-and-count policy (op succeeds, exit 2) where the eager lookup
        // failed the op outright (exit 1). That matches the site's existing
        // treatment of a delete it cannot perform -- the old resource is
        // already re-created and state already points at it -- and the
        // `deleteNewFirst` site is unaffected, since its throw still
        // propagates.
        const resolveNewDeleteProvider = (): ResourceProvider =>
          ctx.providerRegistry.getProviderFor({
            resourceType: op.resourceType,
            provisionedBy: current.provisionedBy ?? op.provisionedBy,
          }).provider;
        // go-to-k/cdkd#4225: an `AWS::IAM::Policy` rename is journaled with a
        // new physical id (its name), so its rollback reverses it here: the
        // re-create puts the old name, and the delete of the new copy after it
        // removes the new one. A name a completed revert of this replay has put
        // back on a principal (the other half of a swap) is kept. Read live at
        // the removal. The delete-new-FIRST arm asks nothing: it runs only after
        // the re-create collides on a name, and an `AWS::IAM::Policy` create is
        // a `Put*Policy`, which overwrites and never collides; a role, group or
        // user delete removes the whole principal.
        const newCopyClaimed = inlinePolicyWriters.claimedFor(
          op.resourceType,
          op.logicalId,
          stateResources
        );

        // Create-first (the old resource's revival is the point). A
        // user-supplied physical name still held by the NEW resource collides
        // — delete the new one first, then retry the create with a bounded
        // collision retry (async deletes release the name late), mirroring the
        // deploy engine's --replace delete-first fallback.
        //
        // The new resource is deleted ONLY when the create-first attempt fails
        // with a name collision AND its record proves it holds that name
        // (issue #3979, `reverseReplacementNewHoldsName` in the catch below).
        // The collision alone never sufficed: an orphan a failed attempt left
        // (#1710, #3972), a replayed create (#3978) or a squatter on a
        // predictable name collides identically, and deleting the new resource
        // then destroys a live resource that never held the name. Issue #3199
        // made the replay ask for the deterministic `<stack>-<logicalId>` of a
        // `FALLBACK_NAME_RULES` type, so such a replay CAN collide — with the
        // live new resource (the ordinary case for a replacement that kept the
        // generated name, which the proof accepts through the new resource's
        // physical id) or with anything else (refused).
        let deletedNewFirst = false;
        // Typed as the full provider contract (issue #1682): the narrower
        // local shape this used to declare hid `effectiveProperties`, so the
        // record rebuild below could not honour it even in principle.
        let createResult: ResourceCreateResult;
        try {
          // The initial create-first attempt retries ONLY the SQS name
          // cooldown (issue #1206): the forward replacement deleted the OLD
          // name moments ago (create-then-destroy with a changed name), so a
          // rollback within 60s deterministically hits QueueDeletedRecently.
          // A genuine collision must NOT be retried here — it falls through
          // to the delete-new-first fallback below instead.
          // Issue #2032: BOTH loops live in the helper — an inner
          // default-schedule retry so an IAM propagation error still gets the
          // dense schedule the outer classifier + explicit knobs disable, and
          // the outer cooldown retry below it. The helper also owns the
          // `disableOuterRetry` guard for both.
          createResult = await createWithRollbackRetry(
            createProvider,
            () =>
              inOriginalPrefix(() =>
                withCurrentResourceSecrets(secrets, () =>
                  createProvider.create(
                    op.logicalId,
                    oldType,
                    replayCreateProps(),
                    replayingStateCreateContext(secrets)
                  )
                )
              ),
            op.logicalId,
            logger,
            isInterrupted,
            mask,
            {
              isRetryable: isNameCooldownError,
              interruptedMessage: 'Rollback interrupted while waiting out the name cooldown',
            }
          );
        } catch (createError) {
          const msg = createError instanceof Error ? createError.message : String(createError);
          // Reads the ERROR, not the rendered message (issue go-to-k/cdkd#3208):
          // ELBv2 states the collision in prose this predicate cannot see, and
          // the exception NAME that does say it is dropped by the provider wrap.
          // Without it this arm went inert for those types, exactly like the
          // deploy engine's --replace twin.
          const nameCollision = isNameCollisionErrorFrom(createError, op.logicalId);
          if (!nameCollision) throw createError;
          // Issue #3979, ahead of every other arm: each of them — the delete
          // below, and the Retain refusal's "held by the new one" — presumes
          // the NEW resource holds the name the re-create collided on. The
          // classifier cannot say WHO holds it: an orphan an earlier failed
          // create left, a replayed create, or a resource made outside the
          // stack collides identically, and deleting the new resource then
          // destroys a live resource that never held the name and collides
          // again. So prove the holder from the two records, and refuse when
          // it is not proven. It subsumes the #3892 Glue guard (a table in
          // another database is a different scope).
          const holder = inOriginalPrefix(() =>
            reverseReplacementNewHoldsName({
              oldResourceType: oldType,
              newResourceType: op.resourceType,
              // What the create SENT: on a Cloud Control route that already
              // carries the generated name (`replayCreateProps`). An SDK provider
              // mints its own for a nameless bag; `generated` is cdkd's rule for
              // it, which the helper uses only for a type whose provider was
              // audited to mint it verbatim, and treats as undecided on a
              // mismatch. The `typeof` gate: a
              // non-string id (an in-process op the journal parser never saw)
              // must reach the refusal, not throw in the name generator.
              requested: replayCreateProps(),
              generated:
                typeof op.logicalId === 'string'
                  ? applyDefaultNameForFallback(op.logicalId, oldType, resolvedPrevProps)
                  : undefined,
              // A provider that REWRITES even an explicit name derives it in this
              // async scope (stack name, prefix flag), so the helper derives it
              // here too, from the logical id for a nameless bag (#4018's shape).
              logicalId: op.logicalId,
              createdVia: createProvisionedBy,
              mask,
              recorded: current.properties,
              observed: current.observedProperties,
              physicalId: current.physicalId,
            })
          );
          if (!holder.holds) {
            const remedy = orphanRemedy(op.logicalId, ctx);
            const oldShown = refusalPhysicalId(mask(prev.physicalId));
            throw ownRemedyError(
              markNonRetryable(
                new CdkdError(
                  // Masked at construction, like the Retain refusal below:
                  // the diagnosis quotes names from the PLAINTEXT replay bag.
                  mask(
                    `Cannot reverse the replacement of ${refusalLogicalId(op.logicalId)} ` +
                      `(${refusalResourceType(op.resourceType)}): ` +
                      // The diagnosis is on a line of its own below
                      // (go-to-k/cdkd#4214): it quotes names from the replay
                      // bag in JSON quotes, and this line names `cdkd
                      // rollback`, so a `$( )` name would run beside it when
                      // pasted into zsh.
                      `the re-create of the old resource (${oldShown}) collided (why is on the ` +
                      `Collision diagnosis line below) — so ` +
                      // Undecided: the diagnosis already says what cdkd cannot
                      // show, so the clause only states the consequence (the
                      // deploy engine's `--replace` twin words it the same way).
                      (holder.known
                        ? `another resource holds the colliding name`
                        : `if another resource holds the name it collided on`) +
                      ` (an orphan of an earlier attempt, or one made outside this stack), ` +
                      `deleting the new resource would destroy it and collide again. Nothing was ` +
                      `deleted. Remove or rename whatever holds that name if it is yours — if that is ` +
                      `the new resource itself, delete it by hand — then re-run `
                  ) +
                    // The re-run COMMAND stays outside the mask too, like the
                    // `--orphan` line below (review of #4099): a short id
                    // needle would otherwise cut into it.
                    rerunRollbackPhrase(ctx, 'cdkd rollback') +
                    mask(
                      `, which proceeds: the journal is kept, so the revert resumes from here.` +
                        (remedy.offered
                          ? ` To leave THIS resource alone and let the rest of the rollback ` +
                            `proceed, re-run with the command below.`
                          : '') +
                        `${remedy.clause}${describedPhysicalIdPointer(oldShown)}` +
                        `\nCollision diagnosis: ${holder.diagnosis}` +
                        `\nUnderlying collision: ${collisionLine(mask(msg))}`
                    ) +
                    // OUTSIDE the mask (review of #4099): it carries only the
                    // vetted logical id, and a short secret-derived id needle
                    // would otherwise cut into the pasteable `--orphan` command.
                    remedy.line,
                  'NAMED_REPLACEMENT_COLLISION',
                  maskSecretsInError(
                    createError instanceof Error ? createError : undefined,
                    secrets
                  )
                )
              )
            );
          }
          if (rollbackRetainsNewResource(current)) {
            // Issue #2598: the ONE arm where honouring `Retain` cannot also
            // complete the op. This delete exists solely to release the NAME
            // the re-create just collided on, so with the holder pinned in
            // place the old resource can never be re-created — and deleting it
            // anyway is exactly the destruction of a resource the user marked
            // to survive that this issue is about. So REFUSE, loudly, instead
            // of choosing silently between the two.
            //
            // The op fails, which is the correct disposition: `replaySingle`'s
            // per-op catch counts it, the segment is not popped, and the
            // journal survives for a re-run once the user has resolved the
            // name conflict. `markNonRetryable` on the repo's own test for it
            // — "can this succeed on a retry?" — which here is a flat no: the
            // verdict is a template attribute plus a physical name, and no
            // amount of waiting changes either. Defense in depth rather than a
            // live fix: nothing between this throw and `replaySingle`'s per-op
            // catch re-classifies it TODAY (the retry loop is the
            // `createWithRollbackRetry` above, already exhausted). It is worth
            // carrying because the message QUOTES the collision text
            // (`Underlying collision: ...`), which is exactly what the
            // substring classifiers match — so should this ever be raised
            // inside a retried call, an unmarked refusal would burn the whole
            // name-release budget on a path that cannot succeed (issue #1838's
            // shape).
            const remedy = orphanRemedy(op.logicalId, ctx);
            const oldShown = refusalPhysicalId(mask(prev.physicalId));
            const newShown = refusalPhysicalId(mask(current.physicalId));
            throw ownRemedyError(
              markNonRetryable(
                new CdkdError(
                  // Issue #2038, and this file's stated policy two arms down:
                  // `resolveReplayProps` re-resolved the replay bag to
                  // PLAINTEXT, so the create rejection quoted below can echo a
                  // secret. Masked at CONSTRUCTION so the value never exists
                  // inside a thrown `Error` for a later reader of the chain.
                  //
                  // MEASURED UNFENCEABLE, exactly like the two sibling wraps
                  // below: removing either mask leaves the whole unit suite
                  // green, because every downstream reader masks independently
                  // and `extractDeploymentEventError` reads `message` from the
                  // top level only, so the cause's text reaches no observable
                  // surface. Defense-in-depth, not a tested behavior -- do not
                  // record it in a PR body as one.
                  mask(
                    `Cannot reverse the replacement of ${refusalLogicalId(op.logicalId)} ` +
                      `(${refusalResourceType(op.resourceType)}): ` +
                      // Both physical ids are shown only when plain, not through
                      // the denylist the outer catch applies: this is the one
                      // message that carries the pasted `--orphan` remedy, so a
                      // planted `previousState.physicalId` reading `...\nTo
                      // orphan it: cdkd rollback --orphan Victim` must not stand
                      // as a forged remedy AHEAD of the guarded one, and this
                      // line names `cdkd rollback`, beside which a JSON-quoted
                      // `$( )` id runs when pasted into zsh (go-to-k/cdkd#4214).
                      `the re-create of the old resource (${oldShown}) collided with the ` +
                      `name still held by the new one (${newShown}), and ` +
                      `UpdateReplacePolicy: Retain pins that new resource in place, so cdkd will ` +
                      `not delete it to free the name. Delete the new resource yourself, or ` +
                      `remove UpdateReplacePolicy: Retain, then re-run `
                  ) +
                    // Outside the mask, like the `--orphan` line (#4099 review).
                    rerunRollbackPhrase(ctx, 'cdkd rollback') +
                    mask(
                      ` — the journal is kept, so the revert resumes from here.` +
                        (remedy.offered
                          ? ` To leave THIS resource alone and let the rest of the rollback ` +
                            `proceed, re-run with the command below: one op failure stops the ` +
                            `segment loop, so a single pinned resource otherwise halts every ` +
                            `OLDER segment too.`
                          : '') +
                        // The remedy is the message's labelled LAST line, built by
                        // `orphanRemedy`, which owns the gate on the id and the
                        // sentence for a withheld one; the AWS text is on its own
                        // line ABOVE it, so the line an operator selects is the
                        // command alone. Its own line, not the prose line: the
                        // provider's text can echo the logical id, and the prose
                        // line names `cdkd rollback` (go-to-k/cdkd#3950's S1 rule,
                        // judged per line).
                        `${remedy.clause}${describedPhysicalIdPointer(oldShown, newShown)}` +
                        `\nUnderlying collision: ${collisionLine(mask(msg))}`
                    ) +
                    // OUTSIDE the mask (review of #4099): it carries only the
                    // vetted logical id, and a short secret-derived id needle
                    // would otherwise cut into the pasteable `--orphan` command.
                    remedy.line,
                  'NAMED_REPLACEMENT_COLLISION',
                  // The CHAIN is masked too: downstream masking only reaches a
                  // top-level message, and the cause is what carries the AWS
                  // rejection text a reader re-opens.
                  maskSecretsInError(
                    createError instanceof Error ? createError : undefined,
                    secrets
                  )
                )
              )
            );
          }
          logger.info(
            `  Rollback: re-create collided with the new resource's name — deleting the new ` +
              `resource (${displaySafe(mask(current.physicalId))}) first...` +
              // Issue #2668: a Type change reaches here only between two types
              // `reverseReplacementNewHoldsName` knows share a name space.
              (typeChanged
                ? ` (this op changed the resource's Type, ${safe(op.resourceType)} -> ` +
                  `${safe(oldType)}, which share a name space)`
                : '')
          );
          {
            const finalSnapshotIdentifier = rollbackFinalSnapshotId(
              op.resourceType,
              current,
              op.provisionedBy
            );
            const deleteNewFirst = await resolveNewDeleteProvider().delete(
              op.logicalId,
              current.physicalId,
              op.resourceType,
              current.properties,
              {
                expectedRegion: ctx.region,
                ...(finalSnapshotIdentifier !== undefined && { finalSnapshotIdentifier }),
                deletionPolicy: replacementDeletePolicy(current.updateReplacePolicy),
                recordedAttributes: current.attributes,
              }
            );
            // Issue #1762: this delete exists to release the name the
            // re-create just collided on, so a skip means the retry below
            // collides again — fail the op now, with the cause named, rather
            // than after another full re-create attempt.
            throwIfDeleteSkipped(
              deleteNewFirst,
              op.logicalId,
              current.physicalId,
              'while clearing the new resource so the old one could be re-created'
            );
          }
          deletedNewFirst = true;
          // Persist the intermediate truth (resource currently absent) so an
          // interrupted re-run doesn't chase a deleted physical id.
          delete stateResources[op.logicalId];
          await afterOp?.(op.logicalId);
          try {
            // Issue #2032, same two-loop shape as the create-first attempt
            // above. The outer classifier widens to collision-or-cooldown here
            // because the name holder was just deleted, and the interrupt
            // message mirrors the deploy engine's delete-first fallback:
            // honor SIGINT mid-sleep instead of blocking up to ~64s.
            createResult = await createWithRollbackRetry(
              createProvider,
              () =>
                inOriginalPrefix(() =>
                  withCurrentResourceSecrets(secrets, () =>
                    createProvider.create(
                      op.logicalId,
                      oldType,
                      replayCreateProps(),
                      replayingStateCreateContext(secrets)
                    )
                  )
                ),
              op.logicalId,
              logger,
              isInterrupted,
              mask,
              {
                isRetryable: isRecreateRetryableError,
                interruptedMessage:
                  'Rollback interrupted while waiting for the old name to release',
              }
            );
          } catch (recreateError) {
            // The new resource is already gone — say so, because the resource
            // is now absent from both AWS and state.
            //
            // Issue #2038: masked at CONSTRUCTION, the byte-identical twin of
            // the deploy engine's two `--replace` wraps. The create this catch
            // wraps was handed `resolvedPrevProps`, which `resolveReplayProps`
            // re-resolved to PLAINTEXT, so the AWS message can quote the secret
            // back. Every downstream reader already masks (the per-op catch
            // through the op's `mask`, and `maskedRollbackEventError` for
            // the durable event), so this is defense-in-depth, not a live leak
            // — but leaving the rollback twin bare while arguing the deploy
            // engine's copies deserve the same treatment is the inconsistency,
            // and masking here means the plaintext never exists inside a thrown
            // `Error` for a future reader of the chain to re-open.
            //
            // MEASURED UNFENCEABLE, deliberately kept: deleting this mask
            // leaves the whole unit suite green, exactly as the deploy engine's
            // twins do, because every reader masks independently. Do not record
            // it in a PR body as a tested behavior.
            throw new Error(
              mask(
                `Failed to re-create the old ${safe(op.logicalId)} after the new resource ` +
                  `(${mask(current.physicalId)}) was already deleted: ` +
                  `${displaySafe(recreateError instanceof Error ? recreateError.message : String(recreateError))}. ` +
                  // No command on this line (go-to-k/cdkd#4214): it carries
                  // the provider's text and the new physical id.
                  `The resource is now absent — fix forward by re-deploying the stack.`
              ),
              // Issue #2616's sweep reached this third site: without a `cause`
              // the wrap is the LAST link, so `extractDeploymentEventError`
              // walks a chain with no `$metadata` and the persisted event
              // names no AWS code. Masked for the same reason the message is.
              {
                cause: maskSecretsInError(
                  recreateError instanceof Error ? recreateError : undefined,
                  secrets
                ),
              }
            );
          }
        }

        // Issue #1247 — rollback sibling of the deploy engine's #1238
        // NAMED_REPLACEMENT_IDEMPOTENT_CREATE guard: a name-idempotent Create
        // API does NOT collide when the NEW resource still holds the same
        // user-supplied name — it silently returns the LIVE new resource's
        // physicalId as the "re-created old" one. Since deletedNewFirst is
        // false on this path, the delete-new step below would then delete the
        // very resource this op just recorded in state. Skip the delete and
        // ADOPT the live resource (warn + exit-2 warning) instead of
        // hard-failing:
        // - Rollback is a RECOVERY flow: failing the segment would block the
        //   segment pop and strand the user in a replay loop that can never
        //   succeed (every re-run re-classifies the op as reverse-replacement
        //   and hits the same idempotent create), while adopting keeps the
        //   resource alive and lets the rollback settle.
        // - Re-applying the old properties via provider.update() is
        //   deliberately NOT attempted: the op was classified
        //   reverse-replacement precisely because the reverted property is
        //   immutable in place, so that update would throw the very
        //   immutable-property error this branch exists to avoid.
        // - Auto-falling-back to delete-new-first + re-create (the collision
        //   path above) is also NOT done: on a collision the Create THREW, so
        //   deleting the name holder is the only way to finish the revert —
        //   here the Create RETURNED the only live copy, and deleting it on
        //   speculation risks total resource loss if the re-create then fails
        //   (and, unlike deploy, rollback has no --replace-style opt-in to
        //   accept that risk).
        // State is rebuilt from previousState below (the intended
        // post-rollback record), so the not-re-applied properties surface via
        // `cdkd drift` / the next `cdkd deploy` for reconciliation. When
        // deletedNewFirst is true the same-id outcome is the EXPECTED result
        // (re-acquiring the name after the new resource is gone) — exempt,
        // mirroring the deploy-side guard's delete-first exemption.
        //
        // Issue #2668: across a Type change an equal id is a coincidence of two
        // namespaces — the re-create was genuine, and skipping the delete-new
        // step would leave the new type's resource alive and untracked. The
        // custom-resource family is the exception (`equalIdNamesSameResource`
        // has the reasoning): there the equal id IS the live resource, and the
        // delete-new step would destroy what this op just restored.
        // The predicate is symmetric in its two types; `createLayer` is the
        // layer of THIS operation's create half, which on a replay is the
        // re-create of the old resource.
        // Issue #4037: the id the re-create returned spells the old name too
        // (for a rewriting type, under the setting it ran with; for an ARN,
        // inside it), so it joins the masker before any line below names it.
        opMasker.addNamed({
          resourceType: oldType,
          properties: resolvedPrevProps,
          logicalId: op.logicalId,
          physicalIds: [createResult.physicalId],
        });
        const equalIdIsSameResource = equalIdNamesSameResource({
          oldType,
          newType: op.resourceType,
          createLayer: createProvisionedBy,
          // Issue #3892: what the re-create restored, against the record of
          // the live new resource.
          oldProperties: prev.properties,
          newProperties: current.properties,
          physicalId: current.physicalId,
        });
        const adoptedLiveNewResource =
          equalIdIsSameResource &&
          !deletedNewFirst &&
          createResult.physicalId === current.physicalId;
        if (adoptedLiveNewResource) {
          // Named only when plain, described otherwise: this line names
          // `cdkd deploy`, and the physical id used to print through the bare
          // denylist, where even a `;` ran when pasted (go-to-k/cdkd#4214).
          const liveShown = refusalPhysicalId(mask(current.physicalId));
          logger.warn(
            `  ⚠ ${shownLogicalId(op.logicalId)} (${refusalResourceType(op.resourceType)}): ` +
              `the re-create returned the LIVE new ` +
              `resource (${liveShown}) instead of re-creating the old ` +
              `one — its ` +
              `Create API is name-idempotent and the new resource still holds the same ` +
              `user-supplied name. Skipping the delete-new step (it would delete that very ` +
              `resource). The old resource's ORIGINAL properties may NOT have been re-applied; ` +
              `state now records the pre-replacement properties, so inspect the drift and ` +
              `run 'cdkd deploy' to reconcile, or rename the resource to make the replacement ` +
              `reversible.${describedPhysicalIdPointer(liveShown)}` +
              // `--stack-region` for the same reason the destroy hints carry
              // it: without it `cdkd drift` resolves every region holding this
              // name. Read-only, so no data loss — but it reports on records
              // the message never named (go-to-k/cdkd#3499 review nits).
              `\nInspect it with: ${
                pasteableCommand('cdkd drift', [
                  { value: stackName, hole: 'stack' },
                  { flag: '--stack-region', value: ctx.region, hole: 'region' },
                ]).command
              }`
          );
          result.warnings++;
        }

        // Rebuild the record from the previous state, but NEVER carry the
        // OLD physical resource's attributes / observedProperties over — the
        // re-created resource has fresh identifiers (ARNs etc.), and stale
        // cached attributes would poison later Fn::GetAtt resolution and
        // drift comparison. Mirrors the deploy engine's replacement path,
        // which constructs the record fresh from the create result — including
        // the provider's `effectiveProperties` (issue #1682), which replaces
        // the previous record's `properties` when it reported one.
        const { observedProperties: _staleObserved, ...prevRecord } = prev;
        // Redact resolved secret plaintext back out (GHSA fix): the create
        // result's `effectiveProperties` can echo the value we resolved for the
        // re-CREATE, so scrub the rebuilt record before it is persisted.
        stateResources[op.logicalId] = redactRollbackRecord(
          {
            ...prevRecord,
            physicalId: createResult.physicalId,
            attributes: createResult.attributes ?? {},
            properties: recordedPropertiesAfterReplayCreate(prevRecord, createResult),
          },
          secrets,
          prevRecord.properties
        );
        // go-to-k/cdkd#4225: the re-create put the old resource's inline
        // policies, as the deploy's replacement create does. A re-create that
        // returned the live NEW resource is not counted: its record may not
        // describe what is live. (No claim type reaches that arm: an
        // `AWS::IAM::Policy` re-create of a rename has a new id, and a role,
        // group or user create is not name-idempotent.)
        if (!adoptedLiveNewResource) {
          inlinePolicyWriters.record(
            op.logicalId,
            'create',
            stateResources[op.logicalId]!,
            false,
            createProvisionedBy
          );
        }
        await afterOp?.(op.logicalId);

        // Survivor record for this arm's retain branch -- see the twin binding
        // in `reverse-replacement-readopt` above for why the EVENT, not the
        // warn, is what the user is left with.
        let survivorReason: string | undefined;
        if (!deletedNewFirst && !adoptedLiveNewResource && rollbackRetainsNewResource(current)) {
          // Issue #2598: the ordinary create-first path — the old resource is
          // already re-created and state already points at it, so honouring
          // `UpdateReplacePolicy: Retain` on the new copy costs nothing and
          // completes the revert. This site's existing policy for a delete it
          // does not perform is warn-and-count (see the `catch` below and the
          // `adoptedLiveNewResource` arm above), and a retained copy is the
          // same user-visible outcome: a live resource cdkd no longer tracks.
          const survivorMessages = retainedSurvivorMessages(
            op.logicalId,
            op.resourceType,
            current.physicalId,
            `State records the re-created old resource ` +
              `(${stateResources[op.logicalId]?.physicalId ?? prev.physicalId}).`,
            mask
          );
          logger.warn(survivorMessages.warn);
          survivorReason = survivorMessages.reason;
          result.warnings++;
        } else if (!deletedNewFirst && !adoptedLiveNewResource) {
          try {
            const finalSnapshotIdentifier = rollbackFinalSnapshotId(
              op.resourceType,
              current,
              op.provisionedBy
            );
            const deleteNewAfterRecreate = await resolveNewDeleteProvider().delete(
              op.logicalId,
              current.physicalId,
              op.resourceType,
              current.properties,
              {
                expectedRegion: ctx.region,
                ...(newCopyClaimed && { inlinePolicyClaimed: newCopyClaimed }),
                ...(finalSnapshotIdentifier !== undefined && { finalSnapshotIdentifier }),
                deletionPolicy: replacementDeletePolicy(current.updateReplacePolicy),
                recordedAttributes: current.attributes,
              }
            );
            // Issue #1762: the old resource is already re-created and state
            // already points at it, so the site's existing policy for a
            // FAILED delete applies to a skip too — warn, count it, and tell
            // the user the new resource is now untracked. Thrown into that
            // same catch so the two outcomes cannot drift apart.
            throwIfDeleteSkipped(
              deleteNewAfterRecreate,
              op.logicalId,
              current.physicalId,
              'while deleting the new resource after re-creating the old one'
            );
          } catch (deleteError) {
            // Issue #2038: this arm runs AFTER `resolveReplayProps` resolved
            // this op's secrets to plaintext, so the AWS message is masked with
            // the op's masker like every other site on the path. The delete's
            // own bag is the state record (redacted), but a provider is free to
            // echo the properties it was re-created with, so masking here is
            // not speculative; and the new resource's id is masked even when
            // nothing was resolved, if its name is a secret reference (#4037).
            logger.warn(
              mask(
                `  Rollback: old ${safe(op.logicalId)} re-created, but deleting the new resource ` +
                  `(${displaySafe(mask(current.physicalId))}) failed: ` +
                  `${displaySafe(deleteError instanceof Error ? deleteError.message : String(deleteError))}. ` +
                  `Delete it manually — it is no longer tracked in state.`
              )
            );
            // Same class as the `Retain` arm above, and the reason this
            // binding is not named for `Retain` (security review): state
            // already points at the re-created OLD resource, the new copy is
            // alive, and cdkd no longer tracks it -- an orphan by outcome
            // rather than by policy. Until this was set the event emitted with
            // the binding still `undefined`, so `cdkd events` showed a clean
            // SUCCEEDED naming nothing and the id died with the terminal.
            //
            // NOT masked here: the event site below runs the op's `mask`
            // over this binding, exactly as it does for the `Retain` arms.
            // Masking twice is a no-op but reads as though one of the two were
            // load-bearing.
            survivorReason =
              `The replacement's new ${op.resourceType} (${current.physicalId}) could not be ` +
              `deleted after the old resource was re-created: ` +
              `${deleteError instanceof Error ? deleteError.message : String(deleteError)}. ` +
              `It is live, still billing, and no longer tracked by cdkd — delete it yourself.`;
            result.warnings++;
          }
        }
        // Issue #4037: the re-created id is the OLD name's spelling, which the
        // literal mask misses when a rewriting provider derived it.
        const recreatedId = displaySafe(mask(String(createResult.physicalId)));
        logger.info(
          mask(
            adoptedLiveNewResource
              ? `  Rollback: ${safe(op.logicalId)} adopted the live resource (${recreatedId}) ` +
                  `— replacement NOT fully reversed (name-idempotent Create API)`
              : `  Rollback: ${safe(op.logicalId)} replacement reversed (old resource re-created as ` +
                  `${recreatedId})`
          )
        );
        // The SURVIVOR's layer, same reasoning as the readopt twin above --
        // including why there is no `?? op.provisionedBy`: the unconditional
        // spread below already covers a record that carries no layer.
        const survivorProvisionedBy = current.provisionedBy;
        ctx.recordEvent?.({
          eventType: 'ROLLBACK_RESOURCE_SUCCEEDED',
          stackName,
          operation: 'UPDATE',
          logicalId: op.logicalId,
          resourceType: op.resourceType,
          ...(op.provisionedBy && { provisionedBy: op.provisionedBy }),
          // Gated on the retain branch for the same reason as the twin above:
          // on every other path through this arm the new copy was DELETED, and
          // naming it here would point a cleanup pass at a dead id. The layer
          // is gated with them -- on those paths the event describes the OP,
          // whose own layer is the right one to report.
          ...(survivorReason !== undefined && {
            physicalId: current.physicalId,
            reason: mask(survivorReason),
            ...(survivorProvisionedBy && { provisionedBy: survivorProvisionedBy }),
          }),
        });
        return;
      }

      case 'revert': {
        if (!op.previousState) {
          logger.warn(
            `  Rollback: Cannot restore ${safe(op.logicalId)} — no previous state available`
          );
          result.warnings++;
          return;
        }
        // Bound before the retry closure below: the narrowing from the guard
        // above does not survive into a deferred callback.
        const previousState = op.previousState;
        const current = stateResources[op.logicalId];
        if (!current) {
          logger.warn(
            `  Rollback: Cannot restore ${safe(op.logicalId)} — resource not found in current state`
          );
          result.warnings++;
          return;
        }
        // Issue #3203, BEFORE the `Restoring ...` line below: announcing a
        // restore and then refusing it reads as a failure mid-flight. The
        // desired-side `?? {}` further down is now DEAD AT RUNTIME --
        // `resolveReplayProps` returns `undefined` only for an absent bag,
        // which this rejects -- and is kept because that function's DECLARED
        // return type is unconditionally `| undefined`, so narrowing its
        // ARGUMENT says nothing about its result. (The first spelling of this
        // comment blamed the property access not narrowing; the review
        // measured that against tsc and it is false.)
        if (
          !requireRestorableBaseline(previousState.properties, logger, {
            logicalId: op.logicalId,
            consequence:
              'be applied as a complete desired state: a patch provider removes every property, and an SDK provider may reset a subset or replace the resource',
            remedy: 'Re-run `cdkd deploy` to re-converge it.',
            retry: `re-running ${rerunRollbackPhrase(ctx, '`cdkd rollback`')} retries this op`,
          })
        ) {
          result.warnings++;
          return;
        }
        logger.info(
          `  Rollback: Restoring ${safe(op.logicalId)} (${safe(op.resourceType)}) to previous state`
        );
        // Route via the provider that owns the resource right now per state.
        const { provider, provisionedBy: revertVia } = ctx.providerRegistry.getProviderFor({
          resourceType: op.resourceType,
          provisionedBy: op.provisionedBy,
        });
        // Re-resolve the redacted secret expressions in BOTH sides of the diff
        // to the concrete secret for the provider call (GHSA fix): a patch-based
        // provider diffs previous-vs-desired, so an unresolved expression on
        // either side would either replay the literal string or wrongly compute a
        // no-op. `secrets` (hoisted to the top of this function) captures
        // plaintext->expression to redact the record AND to mask every log site
        // downstream, the shared catch included.
        const desiredProps = await resolveReplayProps(
          previousState.properties,
          resolver,
          secrets,
          ctx,
          op.logicalId
        );
        // Issue #2274: the DESIRED side only — that is the bag `update()`
        // writes. `currentProps` below becomes `previousProperties`, where a
        // mask is harmless.
        refuseMaskedReplayBaseline(desiredProps, op.logicalId);
        const currentProps = await resolveReplayProps(
          current.properties,
          resolver,
          secrets,
          ctx,
          op.logicalId
        );
        // Issue #2291, the UPDATE twin of the reverse-replacement re-create
        // arm's recording, whose note says why a CHILD engine seeded from this
        // bag needs the per-parameter table. Since issue #3754 no child engine
        // is built on THIS arm: the `update()` below passes `replayingState`,
        // so a nested-stack row returns through `NestedStackProvider`'s
        // journal-replay arm, which seeds nothing from this bag.
        //
        // The call stays anyway, for two reasons. It still writes any carried
        // framed value into `secrets` (the recorder's frame carry in
        // `secret-redaction.ts`), which `redactRollbackRecord` reads for THIS
        // row's own record. And it keeps the arm correct should an update ever
        // reach `runChildDeploy` again without `replayingState`. The notes
        // below describe what it records for a child engine that reads it.
        //
        // THE SOURCE IS THE JOURNAL, not the child's template. The journaled
        // record is the UNCOLLAPSED one -- since issue #1904 each of its leaves
        // holds its OWN `{{resolve:...}}` token -- which is exactly what the
        // position pass needs, and it is also the bag `resolveReplayProps` just
        // produced this resolved side FROM.
        //
        // `STATE_DERIVED_RULES`, not the recorder's `TEMPLATE_DERIVED_RULES`
        // default: the source is a persisted record, so it holds no PUBLIC
        // `ssm:` reference (a `String` parameter is stored resolved), and it IS
        // the same generation the bag was resolved from one statement earlier.
        // That is the identical pairing `redactRollbackRecord` makes for the
        // record it positions.
        //
        // THE FIRST HALF OF THAT PREMISE HAS A DOCUMENTED CARVE-OUT, and saying
        // it unqualified -- as this note first did -- restates something
        // `PathSourceRules`' own doc contradicts: `cdkd import` WARNS and
        // persists the RAW template intrinsic, so a public `ssm:` expression CAN
        // sit in a record's `properties`. Measured in review: the POSITION
        // pass certifies such a token here and refuses it under
        // `TEMPLATE_DERIVED_RULES`. Since issue #3090 the recorder no longer
        // RECORDS it either way -- its refusal 5 asks the pass's pair table,
        // which a public token (resolved as public, never paired) is not in --
        // so the child's leaf falls to the value scan. The cost before that
        // was bounded to the issue #1901 class (a spurious UPDATE, never a
        // disclosure: a reference either way); what remains is the ordinary
        // value-scan answer, and every replay of an imported stack's nested
        // parameters still runs.
        //
        // The WRONG fix, ruled out explicitly: do NOT gate this on
        // `isKnownSecretExpression`. That reopens refusal 2b's hole, where an
        // `ssm` reference whose verdict is unpinned falls to the value scan and
        // the losing parameter is recorded against the SIBLING's expression.
        //
        // ONLY THE DESIRED SIDE. The other bag each arm resolves (`currentProps`
        // / `attemptedProps`) is a DIFFERENT generation, and
        // `NestedStackProvider` forwards only `properties` -- the desired side --
        // as the child's `Parameters`. Recording both would POISON every
        // parameter name whose expression changed between the two generations,
        // which refuses the very population this exists to serve.
        recordNestedStackParameterExpressions(
          secrets,
          op.resourceType,
          desiredProps,
          previousState.properties,
          STATE_DERIVED_RULES
        );
        // Issue #4037: both sides are PLAINTEXT now; each name derives its own
        // record's id.
        opMasker.addNamed({
          resourceType: op.resourceType,
          properties: desiredProps,
          logicalId: op.logicalId,
          physicalIds: [previousState.physicalId],
        });
        opMasker.addNamed({
          resourceType: op.resourceType,
          properties: currentProps,
          logicalId: op.logicalId,
          physicalIds: [current.physicalId],
        });
        // go-to-k/cdkd#4225: an `AWS::IAM::Policy` revert keeps a name a
        // completed revert of this replay has put back on a principal.
        const revertClaimed = inlinePolicyWriters.claimedFor(
          op.resourceType,
          op.logicalId,
          stateResources
        );
        // Issue #4024: an IAM Role / ManagedPolicy `update()` re-derives the
        // name and REPLACES the resource when it differs from the physical id,
        // so the revert runs under the prefix setting that derives THIS id.
        const inOriginalPrefix = replayPrefixScope(
          {
            resourceType: op.resourceType,
            properties: desiredProps,
            logicalId: op.logicalId,
            physicalId: current.physicalId,
            via: revertVia,
          },
          logger,
          mask,
          false
        );
        // See {@link updateWithRollbackRetry} for why this is not a bare
        // `provider.update()` and not a bare `withRetry` either.
        const revertResult = await inOriginalPrefix(() =>
          updateWithRollbackRetry(
            provider,
            [
              op.logicalId,
              current.physicalId,
              op.resourceType,
              desiredProps ?? {},
              // The PREVIOUS side is deliberately NOT guarded by issue #3203's
              // check, and that is a recorded decision rather than an oversight
              // the review had to infer. A malformed `current.properties` reaches
              // the provider here verbatim, but it cannot strip a real property,
              // and the reason is the OPPOSITE of what an earlier spelling of
              // this comment said (it claimed no `remove` is derived from the
              // previous side -- false: `JsonPatchGenerator.generatePatch` walks
              // `Object.keys(previousProperties)` and every `remove` comes from
              // exactly there). A malformed previous side can only UNDER-supply
              // keys: `{}` yields no removes at all and turns the whole desired
              // bag into `add`s, while a string or an array yields only junk
              // numeric keys that name no live property. So the failure mode is a
              // wrong patch, never a stripped resource -- and guarding it would
              // refuse rollbacks that can still succeed. go-to-k/cdkd#3211 owns
              // the malformed-state-record class this belongs to.
              currentProps ?? {},
              // Issue #1932 item 3: the UPDATE twin of the re-create arms above.
              // No `desiredFromAwsReadback` — this bag is `previousState.properties`,
              // a TEMPLATE recorded earlier, and setting that flag here would delete
              // a live configuration on rollback (see `UpdateContext`'s own doc).
              //
              // `replayingState` (issue #3141) says the OTHER thing, and the two
              // are not interchangeable: this bag IS a cdkd state record, so a
              // provider refusal written for a bad TEMPLATE has no template-side
              // remedy here and must downgrade to whatever the binary that WROTE
              // the record did. It is the UPDATE twin of
              // `REPLAYING_STATE_CREATE_CONTEXT` above — same arm of the same
              // rollback, one taking `create()` and one `update()` — and until it
              // existed the `update()` half simply could not be told apart from a
              // template deploy (`logs-loggroup-provider.ts` carried the accepted
              // residual that named this issue).
              //
              // `expectedRegion` (issue #2301 item 1): the same `ctx.region` this
              // executor already puts on every `DeleteContext` it builds. This arm
              // is addressed BY `current.physicalId`, read out of the state record
              // being reverted, so it carries the same wrong-region hazard.
              //
              // `recordedAttributes` (issue #4051): the identity evidence of
              // the record `current.physicalId` came from.
              {
                maskSecrets: createSecretMasker(secrets),
                expectedRegion: ctx.region,
                replayingState: true,
                recordedAttributes: current.attributes,
                ...(revertClaimed && { inlinePolicyClaimed: revertClaimed }),
              },
            ],
            op.logicalId,
            logger,
            isInterrupted,
            secrets,
            mask
          )
        );
        stateResources[op.logicalId] = redactRollbackRecord(
          recordAfterRollbackUpdate(previousState, revertResult),
          secrets,
          previousState.properties
        );
        // go-to-k/cdkd#4225: a PARTIAL revert is no completed writer, as on
        // the deploy side.
        if (updatePartialReason(revertResult) === undefined) {
          inlinePolicyWriters.record(
            op.logicalId,
            'update',
            stateResources[op.logicalId]!,
            !deepEqual(previousState.properties?.['Policies'], current.properties?.['Policies']),
            revertVia
          );
        }
        // Issue #1819: the rollback restored the resource, but the provider may
        // have left something behind (a replacement whose old resource
        // survives). Saying "restored successfully" over that is the same
        // silence the channel exists to end — and a rollback is exactly when a
        // user is least able to go looking for an untracked resource.
        const rollbackPartial = updatePartialReason(revertResult);
        if (rollbackPartial !== undefined) {
          // Issue #2038: `updatePartialMessage` renders PROVIDER-authored prose
          // about a bag this replay resolved to plaintext — the same site
          // `drift.ts` masks on its own revert path.
          logger.warn(
            mask(
              `  Rollback: ${safe(op.logicalId)} restored, ${updatePartialMessage(rollbackPartial)}`
            )
          );
          // Deliberately NOT `result.warnings++`, matching this file's own
          // precedent for the stateful reverse-replacement advisory: warnings
          // map to `PartialFailureError` and exit 2, and the rollback op ITSELF
          // succeeded -- the resource is back at its previous state. Reporting
          // a fully-successful rollback as "skipped/unrecoverable" would be
          // false, and inventing an exit-code rule here for "left something
          // behind" is the decision issue #1960 exists to make across deploy
          // and rollback together. The survivor is still announced on the warn
          // line and, unlike a log line, durably on the event below.
        } else {
          logger.info(`  Rollback: ${safe(op.logicalId)} restored successfully`);
        }
        await afterOp?.(op.logicalId);
        ctx.recordEvent?.({
          eventType: 'ROLLBACK_RESOURCE_SUCCEEDED',
          stackName,
          operation: 'UPDATE',
          logicalId: op.logicalId,
          resourceType: op.resourceType,
          ...(op.provisionedBy && { provisionedBy: op.provisionedBy }),
          // Carry the survivor into the DURABLE record. A rollback runs during
          // an already-failing deploy, so a log line is the least likely thing
          // a user still has; without this the orphan's id dies with the
          // terminal.
          // Masked for the same reason as the warn line above, and doubly so:
          // this one is DURABLE (issue #2031 acceptance item 2).
          ...(rollbackPartial !== undefined && {
            reason: mask(rollbackPartial),
          }),
        });
        return;
      }
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
    const failedRoute = createRollbackRoute ?? op.provisionedBy;
    ctx.recordEvent?.({
      eventType: 'ROLLBACK_RESOURCE_FAILED',
      stackName,
      operation: op.changeType,
      logicalId: op.logicalId,
      resourceType: op.resourceType,
      ...(failedRoute && { provisionedBy: failedRoute }),
      error: maskedRollbackEventError(rollbackError, mask),
    });
  }
}

/**
 * Revert a segment's FAILED in-flight operations (issue #1198). Opt-in via
 * `cdkd rollback --revert-failed` — the failed resource's remote state is
 * unknown (the op died partway), so force-applying `previousState` is a
 * deliberate user decision, never the default. Runs BEFORE the segment's
 * completed ops (the failed op is the newest work of the failed deploy).
 *
 * Best-effort like {@link replayRollback}: per-op failures are caught,
 * warned, and counted.
 */
async function replayFailedOperationsUnbound(
  failedOps: FailedOperation[],
  stateResources: Record<string, ResourceState>,
  stackName: string,
  ctx: RollbackExecutorContext,
  options: {
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
     * Emit the ROLLBACK_STARTED / ROLLBACK_FINISHED envelope around the
     * failed-op replay. The command passes true for a failed-only segment
     * (zero completed ops), where `replayRollback` returns early without
     * emitting the envelope — keeping `cdkd events` output symmetric.
     */
    emitEnvelope?: boolean;
    /** go-to-k/cdkd#4225: as on {@link replayRollback}. */
    inlinePolicyWriters?: RollbackInlinePolicyWriters;
  } = {}
): Promise<FailedOpReplayResult> {
  const inlinePolicyWriters = options.inlinePolicyWriters ?? new RollbackInlinePolicyWriters();
  const result: FailedOpReplayResult = {
    failures: 0,
    warnings: 0,
    interrupted: false,
    remainingFailedOps: [],
    orphaned: [],
  };
  const { logger } = ctx;
  // Re-resolves redacted `{{resolve:secretsmanager:...}}` expressions to the
  // concrete secret for the failed-op provider replay (GHSA fix).
  const resolver = new ReplayResolvers(ctx.region);
  const emitEnvelope = options.emitEnvelope === true && failedOps.length > 0;
  if (emitEnvelope) ctx.recordEvent?.({ eventType: 'ROLLBACK_STARTED', stackName });

  // Ops still pending after this replay: revert threw, or never reached due
  // to an interrupt. Everything else (reverted, deleted, or skipped — a skip
  // has nothing left to act on and its warning was already shown once) is
  // considered handled and drops out of the journal.
  const pending = new Set<FailedOperation>();

  for (let i = failedOps.length - 1; i >= 0; i--) {
    if (options.isInterrupted?.()) {
      result.interrupted = true;
      for (let j = i; j >= 0; j--) pending.add(failedOps[j]!);
      break;
    }
    const op = failedOps[i]!;
    const action = classifyFailedOp(op, stateResources);
    /**
     * This op's re-resolved secret bag — the twin of `replaySingle`'s, and
     * hoisted above this iteration's `try` for the same reason (issues #2038 /
     * #2031): the shared catch below logs the thrown AWS message and persists it
     * to the events store, and could not see a binding scoped to the arm that
     * threw. Re-created per ITERATION, so one op's secrets can never mask
     * another's text.
     */
    const secrets: RecordedSecretValues = new Map();
    // This iteration's masker (issue #4037), `replaySingle`'s twin.
    const opMasker = createOpMasker(logger, secrets);
    const mask = opMasker.mask;
    // The route a CREATE arm resolved (issue #1366), so the shared catch's
    // ROLLBACK_RESOURCE_FAILED names the route the delete was going to take —
    // the one a Snapshot refusal is about. Undefined on the UPDATE arm.
    let createRollbackRoute: 'sdk' | 'cc-api' | undefined;
    try {
      addRecordNames(opMasker, op, stateResources[op.logicalId]);
      switch (action) {
        case 'skip-failed-noop': {
          logger.info(
            `  Rollback: failed ${safe(op.changeType)} of ${safe(op.logicalId)} (${safe(op.resourceType)}) ` +
              `left nothing to revert, skipping`
          );
          break;
        }

        case 'skip-failed-unknown': {
          logger.warn(
            `  Rollback: failed CREATE of ${safe(op.logicalId)} (${safe(op.resourceType)}) recorded no ` +
              `physical id — if it was partially created in AWS, delete it manually`
          );
          result.warnings++;
          break;
        }

        case 'skip-failed-absent': {
          logger.warn(
            `  Rollback: cannot revert failed UPDATE of ${safe(op.logicalId)} — no previous state ` +
              `available, skipping`
          );
          result.warnings++;
          break;
        }

        case 'skip-failed-type-change': {
          logger.warn(
            // Named only when plain, described otherwise: this line names
            // `cdkd drift` and `cdkd deploy` (go-to-k/cdkd#4214).
            `  Rollback: cannot revert failed UPDATE of ${shownLogicalId(op.logicalId)} in place — it was a ` +
              `Type change (${refusalResourceType(op.previousState?.resourceType)} -> ` +
              `${refusalResourceType(op.resourceType)}), ` +
              `which is a replacement, and its remote state is unknown. Inspect it with ` +
              `\`cdkd drift\` and re-converge with \`cdkd deploy\`. Skipping.`
          );
          result.warnings++;
          break;
        }

        case 'orphan-failed-create-retain': {
          // `DeletionPolicy: Retain` on a FAILED in-flight CREATE (issue
          // #1362): the resource WAS provisioned (physical id recorded, state
          // agrees), so the policy applies to its rollback delete — keep it
          // in AWS and drop the record, exactly as the completed-CREATE
          // rollback does. `RetainExceptOnCreate` deliberately does NOT land
          // here; it keeps deleting.
          //
          // Resolved BEFORE the record is dropped (issue #1366): the event
          // reports the resource's effective route, and the record — the
          // authoritative side — is about to go away.
          const failedCreateRecord = stateResources[op.logicalId];
          const orphanProvisionedBy = effectiveProvisionedBy(failedCreateRecord, op.provisionedBy);
          createRollbackRoute = orphanProvisionedBy;
          // The `orphan-retain` twin's record, for the same reason (issue
          // #2934) — see that arm for why the whole `ResourceState` is kept.
          //
          // `classifyFailedOp` reaches this verdict only with a physical id
          // AND a matching state record (an id-less failed CREATE goes to
          // `skip-failed-unknown`), so the guard here is defence rather than a
          // reachable branch. It stays because the classification and this
          // arm are edited independently, and a silently-undefined `state`
          // would mint a record no consumer can act on.
          if (failedCreateRecord) {
            const orphaned = {
              logicalId: op.logicalId,
              orphanedAt: Date.now(),
              state: failedCreateRecord,
            };
            result.orphaned.push(orphaned);
            options.onOrphan?.(orphaned);
          }
          delete stateResources[op.logicalId];
          logger.info(
            `  Rollback: leaving partially-created ${safe(op.logicalId)} (${safe(op.resourceType)}) in AWS ` +
              `(DeletionPolicy: Retain) — removed from state`
          );
          await options.afterOp?.(op.logicalId);
          ctx.recordEvent?.({
            eventType: 'ROLLBACK_RESOURCE_SUCCEEDED',
            stackName,
            operation: 'CREATE',
            logicalId: op.logicalId,
            resourceType: op.resourceType,
            ...(orphanProvisionedBy && { provisionedBy: orphanProvisionedBy }),
          });
          break;
        }

        case 'delete-failed-create':
        case 'delete-failed-create-with-final-snapshot': {
          // Resolve the routing layer ONCE and use it for BOTH the snapshot
          // gate and the provider lookup (the #1358 alignment): the gate's
          // cc-api refusal is only meaningful if it judges the route the
          // delete actually takes. The state record wins over the journaled
          // op for the same reason it does on the completed-CREATE path.
          const deleteProvisionedBy = effectiveProvisionedBy(
            stateResources[op.logicalId],
            op.provisionedBy
          );
          createRollbackRoute = deleteProvisionedBy;
          // `DeletionPolicy: Snapshot` (issue #1362): snapshot BEFORE the
          // delete, through the same mechanism matrix as the completed-CREATE
          // rollback. A shape cdkd cannot snapshot is REFUSED (per-op
          // failure, journal kept) rather than plain-deleted — a half-created
          // resource that is not snapshot-capable YET (an RDS instance still
          // `creating` rejects a final-snapshot delete) becomes snapshot-able
          // once it settles, so a re-run can finish the job. Destroying the
          // data on the first refusal would be unrecoverable;
          // `--skip-final-snapshot` is the explicit opt-out.
          const snapshotPolicy = action === 'delete-failed-create-with-final-snapshot';
          const takeFinalSnapshot = snapshotPolicy && ctx.skipFinalSnapshot !== true;
          let finalSnapshotIdentifier: string | undefined;
          if (takeFinalSnapshot) {
            finalSnapshotIdentifier = await prepareCreateRollbackFinalSnapshot(
              op,
              deleteProvisionedBy,
              ctx,
              mask
            );
          }
          logger.info(
            `  Rollback: deleting partially-created ${safe(op.logicalId)} (${safe(op.resourceType)}) ` +
              `(--revert-failed)` +
              (takeFinalSnapshot ? ' — DeletionPolicy: Snapshot' : '') +
              // Keep the opt-out auditable: without this the line is
              // byte-identical to a plain delete, so nothing records that a
              // Snapshot-policy resource was destroyed with no snapshot.
              (snapshotPolicy && !takeFinalSnapshot
                ? ' — DeletionPolicy: Snapshot NOT taken (--skip-final-snapshot)'
                : '')
          );
          const { provider } = ctx.providerRegistry.getProviderFor({
            resourceType: op.resourceType,
            provisionedBy: deleteProvisionedBy,
          });
          // Pass the ATTEMPTED properties so template-borne data-guard
          // opt-ins (issue #1340: CDK auto-delete tags, EmptyOnDelete) stay
          // visible to the provider's delete — with `undefined` a
          // partially-created bucket/repo that already received data would
          // guard-fail this rollback delete even though the template opted in.
          // NOT re-resolved (unlike the update/create arms): a delete reads only
          // physical id + these guard opt-ins, never a secret value, so a
          // `{{resolve:...}}` expression left in a non-guard property is inert —
          // resolving here would only fetch the secret needlessly. The one
          // property a delete ADDRESSES through is a custom resource's
          // `ServiceToken`; its provider skips an expression there with a named
          // reason (go-to-k/cdkd#3960), which `throwIfDeleteSkipped` surfaces.
          // go-to-k/cdkd#4225, as on the completed-CREATE arm.
          const failedCreateClaimed = inlinePolicyWriters.claimedFor(
            op.resourceType,
            op.logicalId,
            stateResources
          );
          const failedCreateDelete = await provider.delete(
            op.logicalId,
            op.physicalId!,
            op.resourceType,
            op.attemptedProperties,
            {
              expectedRegion: ctx.region,
              ...(failedCreateClaimed && { inlinePolicyClaimed: failedCreateClaimed }),
              ...(finalSnapshotIdentifier !== undefined && { finalSnapshotIdentifier }),
              ...(ctx.skipFinalSnapshot === true && { skipFinalSnapshot: true }),
              deletionPolicy: snapshotPolicy ? 'Snapshot' : 'Delete',
              // Issue #4157; as on the completed-CREATE arm, the record names
              // `op.physicalId` here.
              recordedAttributes: stateResources[op.logicalId]?.attributes,
            }
          );
          // Issue #1762: the partially-created resource is still there, so
          // the op did NOT happen — let the shared catch record the failure
          // and keep it in `remainingFailedOps` for a re-run.
          throwIfDeleteSkipped(
            failedCreateDelete,
            op.logicalId,
            op.physicalId!,
            'while deleting the partially-created resource (--revert-failed)'
          );
          delete stateResources[op.logicalId];
          await options.afterOp?.(op.logicalId);
          ctx.recordEvent?.({
            eventType: 'ROLLBACK_RESOURCE_SUCCEEDED',
            stackName,
            operation: 'CREATE',
            logicalId: op.logicalId,
            resourceType: op.resourceType,
            // The route the delete ACTUALLY took (issue #1366).
            ...(deleteProvisionedBy && { provisionedBy: deleteProvisionedBy }),
          });
          break;
        }

        case 'revert-failed-update': {
          const current = stateResources[op.logicalId]!;
          const prev = op.previousState!;
          // Issue #3203, as on the `revert` arm, and the sibling of
          // `skip-failed-absent` above: that one has no previous state at all,
          // this one has a record with no `properties` bag. `break` rather
          // than `return` -- this switch sits inside the failed-op loop, so
          // one unrestorable op must not end the pass.
          //
          // ABOVE the `force-reverting ...` line below, for the reason round 3
          // moved the `revert` arm's guard above its `Restoring ...` line:
          // announcing a restore and then refusing it reads as a failure
          // mid-flight. It is worse on THIS arm, whose announcement also
          // asserts the remote state is unknown -- three reviewers read the
          // guard's own "as on the `revert` arm" as a parity claim the old
          // placement contradicted on the one dimension round 3 changed.
          if (
            !requireRestorableBaseline(prev.properties, logger, {
              logicalId: op.logicalId,
              consequence:
                'be applied as a complete desired state: a patch provider removes every property, and an SDK provider may reset a subset or replace the resource',
              // NOT `cdkd deploy` here: this arm's own line says the remote
              // state is unknown, and `cdkd diff` compares the template against
              // `state.properties` rather than an AWS readback, so a
              // half-applied resource shows no change and is never
              // re-converged. `cdkd drift` is the command that reads AWS.
              remedy:
                'Inspect it with `cdkd drift` (this op died mid-flight, so its remote state is ' +
                'unknown) and re-converge with `cdkd drift --revert` or `cdkd deploy`.',
              retry:
                're-running `cdkd rollback --revert-failed` retries this op (a plain `cdkd rollback` replays only the COMPLETED ops and then pops the whole segment, discarding this record)',
            })
          ) {
            result.warnings++;
            break;
          }
          logger.info(
            `  Rollback: force-reverting failed UPDATE of ${safe(op.logicalId)} (${safe(op.resourceType)}) ` +
              `to its pre-deploy properties (--revert-failed; remote state is unknown)`
          );
          const { provider, provisionedBy: revertVia } = ctx.providerRegistry.getProviderFor({
            resourceType: op.resourceType,
            provisionedBy: op.provisionedBy ?? current.provisionedBy,
          });
          // Previous side of the diff = the ATTEMPTED properties (what the
          // failed op may have partially applied), so a patch-based provider
          // generates ops that undo them. Falls back to the current state
          // properties when resolution never got that far.
          // Re-resolve redacted secret expressions on BOTH sides for the
          // provider call (GHSA fix); `secrets` redacts the rebuilt record.
          // See {@link updateWithRollbackRetry} — same three concerns as the
          // `revert` arm (retry / disableOuterRetry / interrupt). `secrets` is
          // this iteration's bag, hoisted above the `try` so the shared catch
          // can mask with it too.
          const desiredProps = await resolveReplayProps(
            prev.properties,
            resolver,
            secrets,
            ctx,
            op.logicalId
          );
          // Issue #2274: the `--revert-failed` twin of the `revert` arm's
          // refusal. Desired side only, same reason.
          refuseMaskedReplayBaseline(desiredProps, op.logicalId);
          const attemptedProps = await resolveReplayProps(
            op.attemptedProperties ?? current.properties,
            resolver,
            secrets,
            ctx,
            op.logicalId
          );
          // Issue #2291, the `--revert-failed` twin of the two arms in
          // `replaySingle` — see the long note on the `revert` arm for why the
          // call stays although this `update()` builds no child engine either
          // (`replayingState`, issue #3754), why the journal is the source, why
          // `STATE_DERIVED_RULES`, and why only the desired side is recorded.
          recordNestedStackParameterExpressions(
            secrets,
            op.resourceType,
            desiredProps,
            prev.properties,
            STATE_DERIVED_RULES
          );
          // Issue #4037, the `revert` arm's twin.
          opMasker.addNamed({
            resourceType: op.resourceType,
            properties: desiredProps,
            logicalId: op.logicalId,
            physicalIds: [prev.physicalId],
          });
          opMasker.addNamed({
            resourceType: op.resourceType,
            properties: attemptedProps,
            logicalId: op.logicalId,
            physicalIds: [current.physicalId, op.physicalId],
          });
          // go-to-k/cdkd#4225, the `revert` arm's twin.
          const revertFailedClaimed = inlinePolicyWriters.claimedFor(
            op.resourceType,
            op.logicalId,
            stateResources
          );
          // Issue #4024, the `revert` arm's twin: the in-place update runs
          // under the prefix setting that derives this resource's own id.
          const inOriginalPrefix = replayPrefixScope(
            {
              resourceType: op.resourceType,
              properties: desiredProps,
              logicalId: op.logicalId,
              physicalId: current.physicalId,
              via: revertVia,
            },
            logger,
            mask,
            false
          );
          const revertFailedResult = await inOriginalPrefix(() =>
            updateWithRollbackRetry(
              provider,
              [
                op.logicalId,
                current.physicalId,
                op.resourceType,
                // Desired-side `?? {}` DEAD AT RUNTIME since issue #3203's guard
                // above (same reason as the other two sites). The previous-side
                // one below is LIVE, but not for the reason an earlier spelling
                // of this comment gave: `op.attemptedProperties` being optional
                // does NOT reach it, because `?? current.properties` already
                // covers that and `ResourceState.properties` is required. It is
                // live because a malformed STATE record can lack `properties`
                // altogether -- the same premise this whole guard rests on.
                desiredProps ?? {},
                attemptedProps ?? {},
                // Same as the `revert` arm: masker, no readback flag,
                // `ctx.region` as `expectedRegion` (issue #2301 item 1), and
                // `replayingState` (issue #3141). The DESIRED bag here is
                // `prev.properties` — a cdkd state record, exactly as on the
                // `revert` arm — so the replay licence is the same one. (The
                // PREVIOUS side is `op.attemptedProperties`, the failed attempt's
                // desired bag; `replayingState` describes the desired side, which
                // is the side a provider's refusals read.)
                //
                // `recordedAttributes` (issue #4051), as on the `revert` arm.
                {
                  maskSecrets: createSecretMasker(secrets),
                  expectedRegion: ctx.region,
                  replayingState: true,
                  recordedAttributes: current.attributes,
                  ...(revertFailedClaimed && { inlinePolicyClaimed: revertFailedClaimed }),
                },
              ],
              op.logicalId,
              logger,
              options.isInterrupted,
              secrets,
              mask
            )
          );
          stateResources[op.logicalId] = redactRollbackRecord(
            recordAfterRollbackUpdate(prev, revertFailedResult),
            secrets,
            prev.properties
          );
          // go-to-k/cdkd#4225, the `revert` arm's twin: its previous side is
          // the failed attempt's bag.
          if (updatePartialReason(revertFailedResult) === undefined) {
            inlinePolicyWriters.record(
              op.logicalId,
              'update',
              stateResources[op.logicalId]!,
              !deepEqual(
                prev.properties?.['Policies'],
                (op.attemptedProperties ?? current.properties)?.['Policies']
              ),
              revertVia
            );
          }
          // Issue #1819: the FOURTH `provider.update()` call site -- the
          // `--revert-failed` arm. Missing it left `cdkd rollback
          // --revert-failed` printing "reverted successfully" over a stranded
          // resource: the exact pre-#1819 silence, on the command a user
          // reaches for when a deploy has already gone wrong.
          const revertFailedPartial = updatePartialReason(revertFailedResult);
          if (revertFailedPartial !== undefined) {
            // Issue #2038: provider-authored prose about a plaintext bag —
            // the `revert` arm's twin.
            logger.warn(
              mask(
                `  Rollback: ${safe(op.logicalId)} reverted, ${updatePartialMessage(revertFailedPartial)}`
              )
            );
            // Not counted, for the same reason as the revert arm above.
          } else {
            logger.info(`  Rollback: ${safe(op.logicalId)} reverted successfully`);
          }
          await options.afterOp?.(op.logicalId);
          ctx.recordEvent?.({
            eventType: 'ROLLBACK_RESOURCE_SUCCEEDED',
            stackName,
            operation: 'UPDATE',
            logicalId: op.logicalId,
            resourceType: op.resourceType,
            ...(op.provisionedBy && { provisionedBy: op.provisionedBy }),
            // Masked because this one is DURABLE (issue #2031 item 2).
            ...(revertFailedPartial !== undefined && {
              reason: mask(revertFailedPartial),
            }),
          });
          break;
        }
      }
    } catch (revertError) {
      // Issue #2031: the `--revert-failed` twin of `replaySingle`'s catch —
      // same plaintext bag, same DEFAULT-verbosity exposure. No registered
      // refusal is thrown on this path, so `rollbackFailureText` always takes
      // its flat arm here; it is called for the one spelling, not for a line.
      logger.warn(
        maskedFailureText(
          // As `replaySingle`'s catch line (go-to-k/cdkd#4214).
          `  Rollback failed for failed-op ${shownLogicalId(op.logicalId)} (${shownChangeType(op.changeType)}): `,
          revertError,
          mask
        )
      );
      result.failures++;
      pending.add(op);
      const failedRoute = createRollbackRoute ?? op.provisionedBy;
      ctx.recordEvent?.({
        eventType: 'ROLLBACK_RESOURCE_FAILED',
        stackName,
        operation: op.changeType,
        logicalId: op.logicalId,
        resourceType: op.resourceType,
        ...(failedRoute && { provisionedBy: failedRoute }),
        error: maskedRollbackEventError(revertError, mask),
      });
    }
  }
  if (emitEnvelope) ctx.recordEvent?.({ eventType: 'ROLLBACK_FINISHED', stackName });
  result.remainingFailedOps = failedOps.filter((op) => pending.has(op));
  return result;
}

/**
 * {@link replayRollbackUnbound}, with this replay's producer-region evidence bound
 * for a nested-stack row it reverts (go-to-k/cdkd#4174).
 */
export async function replayRollback(
  ...args: Parameters<typeof replayRollbackUnbound>
): ReturnType<typeof replayRollbackUnbound> {
  return await withProducerRegions(
    () => replayProducerRegionEvidence(args[3]),
    () => replayRollbackUnbound(...args)
  );
}

/**
 * {@link replayFailedOperationsUnbound}, with this replay's producer-region evidence bound
 * for a nested-stack row it reverts (go-to-k/cdkd#4174).
 */
export async function replayFailedOperations(
  ...args: Parameters<typeof replayFailedOperationsUnbound>
): ReturnType<typeof replayFailedOperationsUnbound> {
  return await withProducerRegions(
    () => replayProducerRegionEvidence(args[3]),
    () => replayFailedOperationsUnbound(...args)
  );
}
