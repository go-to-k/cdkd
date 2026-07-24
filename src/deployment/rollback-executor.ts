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
 * 1. **DeletionPolicy on CREATE rollback** — a rolled-back CREATE whose
 *    CURRENT state record carries `Retain` / `Snapshot` is ORPHANED
 *    (removed from state, left in AWS) instead of deleted;
 *    `RetainExceptOnCreate` (which exists precisely to allow cleanup of
 *    failed creates) and absent / `Delete` DELETE.
 * 2. **Idempotent replay skip rules** — so a partially-failed rollback can
 *    be re-run safely (also harmless for the in-process caller, which
 *    replays each op exactly once).
 */

import type { DeploymentEvent } from '../types/deployment-events.js';
import { extractDeploymentEventError } from '../types/deployment-events.js';
import type { ResourceState } from '../types/state.js';
import type { Logger } from '../types/config.js';
import type { ProviderRegistry } from '../provisioning/provider-registry.js';
import { STATEFUL_TYPES } from '../provisioning/stateful-types.js';
import { withRetry } from './retry.js';
import { isNameCollisionError } from './retryable-errors.js';

/**
 * Completed operation record for rollback tracking. Pushed by the deploy
 * engine in completion order, only after the operation succeeded, and
 * serialized verbatim into the rollback journal (issue #1183). Because
 * `ResourceState.properties` are post-intrinsic resolved values, replay
 * needs neither the template nor a synth.
 */
export interface CompletedOperation {
  /** Logical ID of the resource */
  logicalId: string;
  /** Type of change that was applied */
  changeType: 'CREATE' | 'UPDATE' | 'DELETE';
  /** Resource type (e.g., "AWS::S3::Bucket") */
  resourceType: string;
  /**
   * Provisioning layer the resource ran on. Load-bearing for rollback
   * dispatch — a CC-routed CREATE must roll back via the CC provider's
   * delete, NOT the SDK provider's (#614). Populated from the routing
   * decision (CREATE) or from the previous state (UPDATE / DELETE).
   * `undefined` falls back to legacy SDK semantics for legacy state.
   */
  provisionedBy?: 'sdk' | 'cc-api' | undefined;
  /** Previous resource state (for UPDATE rollback) */
  previousState?: ResourceState | undefined;
  /** Physical ID of newly created resource (for CREATE rollback) */
  physicalId?: string | undefined;
  /** Properties used for creation (for CREATE rollback / delete) */
  properties?: Record<string, unknown> | undefined;
}

/**
 * Record of the resource operation that FAILED mid-deploy (issue #1198).
 * At most a handful per journal segment (usually one — the op whose failure
 * stopped the deploy; concurrent siblings can add more). Unlike a
 * {@link CompletedOperation}, the operation did NOT complete, so the remote
 * state of the resource is unknown — reverting it is opt-in
 * (`cdkd rollback --revert-failed`).
 */
export interface FailedOperation {
  /** Logical ID of the resource */
  logicalId: string;
  /** Type of change that was being applied when it failed */
  changeType: 'CREATE' | 'UPDATE' | 'DELETE';
  /** Resource type (e.g., "AWS::S3::Bucket") */
  resourceType: string;
  /** Provisioning layer the op was routed through (see CompletedOperation). */
  provisionedBy?: 'sdk' | 'cc-api' | undefined;
  /** Pre-op resource state (UPDATE / DELETE; undefined for CREATE). */
  previousState?: ResourceState | undefined;
  /** Physical ID at op start, if one was known (undefined for CREATE). */
  physicalId?: string | undefined;
  /**
   * The intrinsic-RESOLVED desired properties the failed op attempted to
   * apply, if resolution got that far. Load-bearing for the revert: a
   * Cloud-Control-routed revert patches previous-vs-attempted, so without
   * this the patch would be empty and the revert a no-op.
   */
  attemptedProperties?: Record<string, unknown> | undefined;
}

/** Collaborators the executor needs (no synth-side dependencies). */
export interface RollbackExecutorContext {
  providerRegistry: ProviderRegistry;
  /** Region the resources live in — threaded into each provider delete. */
  region: string;
  logger: Logger;
  /**
   * Optional structured-event sink. The command wires a
   * `DeploymentEventsStore`; the in-process engine forwards its own
   * best-effort recorder. `undefined` disables event emission.
   */
  recordEvent?: (event: Omit<DeploymentEvent, 'timestamp'>) => void;
}

/** The action the planner / replayer decided for a single op. */
export type RollbackActionKind =
  | 'delete' // CREATE rollback → delete the resource
  | 'orphan-retain' // CREATE rollback → orphan (DeletionPolicy Retain/Snapshot)
  | 'orphan-flag' // op skipped by --orphan; leaves resource, updates state
  | 'revert' // UPDATE rollback → restore previous properties
  | 'reverse-replacement' // replacement rollback → re-create old, delete new (#1199)
  | 'reverse-replacement-readopt' // replacement w/ Retain'd old → delete new, re-adopt old (#1199)
  | 'skip-already-done' // idempotent skip (already reverted / already gone)
  | 'skip-mismatch' // CREATE physical id changed by a later attempt
  | 'skip-absent' // UPDATE target no longer in state
  | 'unrecoverable-delete'; // DELETE cannot be restored

/** The action decided for a FAILED in-flight op (issue #1198, --revert-failed). */
export type FailedOpActionKind =
  | 'revert-failed-update' // force-apply previousState over the half-applied update
  | 'delete-failed-create' // a partially-recorded CREATE → delete it
  | 'skip-failed-unknown' // failed CREATE with nothing recorded — cannot act
  | 'skip-failed-noop' // failed DELETE (resource still in place) / already handled
  | 'skip-failed-absent'; // failed UPDATE with no previousState / not in state

/** One planned failed-op revert (rendered by the command's plan preview). */
export interface FailedOpPlanItem {
  op: FailedOperation;
  action: FailedOpActionKind;
}

/** One planned rollback action (rendered by the command's plan preview). */
export interface RollbackPlanItem {
  op: CompletedOperation;
  action: RollbackActionKind;
  /** For a replacement op (previousState.physicalId !== op.physicalId). */
  replacement: boolean;
}

/**
 * Outcome of {@link replayFailedOperations}: the shared counters plus the
 * failed ops that are STILL pending (revert threw, or unprocessed due to an
 * interrupt). The command persists this list back onto the journal segment
 * so a re-run only re-attempts what is genuinely outstanding — a
 * successfully-reverted op must never be re-issued (its attempted-properties
 * diff side would patch-undo changes that no longer exist).
 */
export interface FailedOpReplayResult extends RollbackReplayResult {
  remainingFailedOps: FailedOperation[];
}

/** Outcome of replaying a list of ops (one journal segment). */
export interface RollbackReplayResult {
  /** Provider delete/update threw (best-effort caught). Blocks segment pop. */
  failures: number;
  /**
   * Skips that carry a warning (physical-id mismatch, absent-on-update,
   * unrecoverable DELETE). Do NOT block segment pop, but map to exit 2.
   */
  warnings: number;
  interrupted: boolean;
}

/**
 * True when the op recorded a replacement (old physical id differs from the
 * new one). The old physical resource is already gone / orphaned, so an
 * in-place revert is best-effort — the plan labels these explicitly.
 */
export function isReplacementOp(op: CompletedOperation): boolean {
  return (
    op.changeType === 'UPDATE' &&
    op.previousState?.physicalId !== undefined &&
    op.previousState.physicalId !== op.physicalId
  );
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null) return a === b;
  if (typeof a !== typeof b) return false;
  if (typeof a !== 'object') return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const ak = Object.keys(ao);
  if (ak.length !== Object.keys(bo).length) return false;
  for (const k of ak) {
    if (!Object.prototype.hasOwnProperty.call(bo, k)) return false;
    if (!deepEqual(ao[k], bo[k])) return false;
  }
  return true;
}

/**
 * Classify what a single op WILL do against the current state, without
 * touching AWS. Pure — used both by the command's plan preview and by the
 * replayer (which re-derives the action to stay in lock-step with the
 * plan). `orphanLogicalIds` mirrors `cdk rollback --orphan`.
 */
export function classifyRollbackOp(
  op: CompletedOperation,
  stateResources: Record<string, ResourceState>,
  orphanLogicalIds: Set<string>
): RollbackActionKind {
  const replacement = isReplacementOp(op);

  if (op.changeType === 'DELETE') return 'unrecoverable-delete';

  if (orphanLogicalIds.has(op.logicalId)) return 'orphan-flag';

  if (op.changeType === 'CREATE') {
    const current = stateResources[op.logicalId];
    if (!current) return 'skip-already-done';
    if (op.physicalId !== undefined && current.physicalId !== op.physicalId) {
      return 'skip-mismatch';
    }
    // Retain / Snapshot on the CURRENT record → orphan instead of delete.
    const policy = current.deletionPolicy;
    if (policy === 'Retain' || policy === 'Snapshot') return 'orphan-retain';
    return 'delete';
  }

  // UPDATE
  const current = stateResources[op.logicalId];
  if (!current) return 'skip-absent';
  if (replacement) {
    // Replacement op (#1199): the OLD physical resource was destroyed (or
    // orphaned under UpdateReplacePolicy: Retain) and the NEW one carries a
    // different physical id. An in-place revert is guaranteed to throw on
    // the immutable property, so reverse the replacement instead.
    if (current.physicalId === op.previousState!.physicalId) {
      // State already points at the old physical id — a prior reverse-
      // replacement (or manual fix) already reverted this op.
      return 'skip-already-done';
    }
    if (op.physicalId !== undefined && current.physicalId !== op.physicalId) {
      // Neither the old nor the recorded new id. An AUTO-NAMED resource
      // re-created by a prior reverse-replacement lands here (its fresh
      // physical id matches neither) — recognize it by the properties
      // already matching the previous state. Anything else is a later
      // attempt's replacement; manual attention required.
      if (deepEqual(current.properties, op.previousState!.properties)) {
        return 'skip-already-done';
      }
      return 'skip-mismatch';
    }
    // `Retain` orphaned the old resource instead of deleting it (the deploy
    // engine's create-then-destroy path skips the delete; the delete-first
    // fallbacks refuse Retain outright), so the old resource still exists
    // and can be re-adopted without a re-create. `Snapshot` is NOT retained
    // on replacement (the engine plain-deletes) — it re-creates like the
    // default policy.
    const retained = op.previousState!.updateReplacePolicy === 'Retain';
    return retained ? 'reverse-replacement-readopt' : 'reverse-replacement';
  }
  if (op.previousState && deepEqual(current.properties, op.previousState.properties)) {
    // Already reverted (idempotent re-run).
    return 'skip-already-done';
  }
  return 'revert';
}

/**
 * Classify what reverting a FAILED in-flight op (issue #1198) will do
 * against the current state, without touching AWS. Pure — used by both the
 * command's `--revert-failed` plan preview and {@link replayFailedOperations}.
 */
export function classifyFailedOp(
  op: FailedOperation,
  stateResources: Record<string, ResourceState>
): FailedOpActionKind {
  if (op.changeType === 'DELETE') {
    // The delete FAILED, so the resource is still in place and state still
    // records it — there is nothing to revert.
    return 'skip-failed-noop';
  }
  const current = stateResources[op.logicalId];
  if (op.changeType === 'CREATE') {
    // A failed CREATE normally records nothing (the provider threw before
    // returning a physical id) — the remote state is unknown.
    if (op.physicalId === undefined) return 'skip-failed-unknown';
    if (!current) return 'skip-failed-noop'; // already cleaned up (re-run)
    if (current.physicalId !== op.physicalId) return 'skip-failed-noop';
    return 'delete-failed-create';
  }
  // UPDATE
  if (!current || !op.previousState) return 'skip-failed-absent';
  return 'revert-failed-update';
}

/** Build the plan items for a segment's failed ops (issue #1198). */
export function planFailedOps(
  failedOps: FailedOperation[],
  stateResources: Record<string, ResourceState>
): FailedOpPlanItem[] {
  return failedOps.map((op) => ({ op, action: classifyFailedOp(op, stateResources) }));
}

/**
 * Build the full ordered plan for a list of ops (one segment). Mirrors the
 * replay order: UPDATE/DELETE first (reverse completion order), then CREATE
 * deletions in dependency-aware order.
 */
export function planRollback(
  operations: CompletedOperation[],
  stateResources: Record<string, ResourceState>,
  orphanLogicalIds: Set<string> = new Set()
): RollbackPlanItem[] {
  const { createOps, otherOps } = partitionOps(operations);
  const ordered: CompletedOperation[] = [
    ...[...otherOps].reverse(),
    ...sortRollbackCreates(createOps, stateResources),
  ];
  return ordered.map((op) => ({
    op,
    action: classifyRollbackOp(op, stateResources, orphanLogicalIds),
    replacement: isReplacementOp(op),
  }));
}

function partitionOps(operations: CompletedOperation[]): {
  createOps: CompletedOperation[];
  otherOps: CompletedOperation[];
} {
  const createOps: CompletedOperation[] = [];
  const otherOps: CompletedOperation[] = [];
  for (const op of operations) {
    if (op.changeType === 'CREATE') createOps.push(op);
    else otherOps.push(op);
  }
  return { createOps, otherOps };
}

/**
 * Replay a list of completed operations against `stateResources` (mutated in
 * place), reverting each. Best-effort: a provider failure is caught, warned,
 * and counted; replay continues.
 *
 * - UPDATE / DELETE first (reverse completion order), then CREATE deletions
 *   in reverse dependency order (dependents deleted before dependencies).
 * - `afterOp` is invoked after each op that MUTATED state (so the command can
 *   persist state incrementally, mirroring `saveStateAfterResource`). The
 *   in-process engine passes no `afterOp` and saves state once at the end.
 * - `isInterrupted` is polled between ops; when it flips true, replay stops
 *   (the pending op is left for a re-run).
 */
export async function replayRollback(
  operations: CompletedOperation[],
  stateResources: Record<string, ResourceState>,
  stackName: string,
  ctx: RollbackExecutorContext,
  options: {
    orphanLogicalIds?: Set<string>;
    afterOp?: (logicalId: string) => Promise<void> | void;
    isInterrupted?: () => boolean;
  } = {}
): Promise<RollbackReplayResult> {
  const orphanLogicalIds = options.orphanLogicalIds ?? new Set<string>();
  const result: RollbackReplayResult = { failures: 0, warnings: 0, interrupted: false };

  if (operations.length === 0) {
    ctx.logger.info('No completed operations to roll back.');
    return result;
  }

  ctx.logger.info(`Rolling back ${operations.length} completed operation(s)...`);
  ctx.recordEvent?.({ eventType: 'ROLLBACK_STARTED', stackName });

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
      orphanLogicalIds,
      result,
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
        orphanLogicalIds,
        result,
        options.afterOp,
        options.isInterrupted
      );
    }
  }

  ctx.logger.info('Rollback completed. Some resources may remain if deletion failed.');
  ctx.recordEvent?.({ eventType: 'ROLLBACK_FINISHED', stackName });
  return result;
}

async function replaySingle(
  op: CompletedOperation,
  stateResources: Record<string, ResourceState>,
  stackName: string,
  ctx: RollbackExecutorContext,
  orphanLogicalIds: Set<string>,
  result: RollbackReplayResult,
  afterOp?: (logicalId: string) => Promise<void> | void,
  isInterrupted?: () => boolean
): Promise<void> {
  const action = classifyRollbackOp(op, stateResources, orphanLogicalIds);
  const { logger } = ctx;

  try {
    switch (action) {
      case 'unrecoverable-delete': {
        logger.warn(
          `  Rollback: Cannot restore deleted resource ${op.logicalId} (${op.resourceType}) — resource has already been deleted`
        );
        result.warnings++;
        return;
      }

      case 'skip-already-done': {
        logger.debug(`  Rollback: ${op.logicalId} already reverted, skipping`);
        return;
      }

      case 'skip-mismatch': {
        logger.warn(
          `  Rollback: Skipping ${op.logicalId} — its physical id changed since the failed deploy ` +
            `(replaced by a later attempt); manual attention may be required`
        );
        result.warnings++;
        return;
      }

      case 'skip-absent': {
        logger.warn(
          `  Rollback: Cannot restore ${op.logicalId} — resource no longer in state, skipping`
        );
        result.warnings++;
        return;
      }

      case 'orphan-flag': {
        if (op.changeType === 'CREATE') {
          // --orphan on a CREATE: leave the resource in AWS, drop it from
          // state (it is not part of the pre-deploy baseline).
          delete stateResources[op.logicalId];
          logger.info(`  Rollback: Orphaning created resource ${op.logicalId} (--orphan)`);
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
            ...(op.provisionedBy && { provisionedBy: op.provisionedBy }),
          });
        } else {
          // --orphan on an UPDATE: leave the resource at its new properties;
          // keep state as-is so it keeps describing AWS truth.
          logger.info(`  Rollback: Leaving ${op.logicalId} at its new state (--orphan)`);
        }
        return;
      }

      case 'orphan-retain': {
        // DeletionPolicy Retain / Snapshot on a rolled-back CREATE: orphan
        // instead of delete (no data loss — the resource is left behind).
        delete stateResources[op.logicalId];
        logger.info(
          `  Rollback: Leaving ${op.logicalId} (${op.resourceType}) in AWS ` +
            `(DeletionPolicy: ${stateResourcesPolicyLabel(op, stateResources)}) — removed from state`
        );
        await afterOp?.(op.logicalId);
        ctx.recordEvent?.({
          eventType: 'ROLLBACK_RESOURCE_SUCCEEDED',
          stackName,
          operation: 'CREATE',
          logicalId: op.logicalId,
          resourceType: op.resourceType,
          ...(op.provisionedBy && { provisionedBy: op.provisionedBy }),
        });
        return;
      }

      case 'delete': {
        if (!op.physicalId) {
          logger.warn(`  Rollback: Cannot delete ${op.logicalId} — no physical ID recorded`);
          result.warnings++;
          return;
        }
        logger.info(`  Rollback: Deleting created resource ${op.logicalId} (${op.resourceType})`);
        // Route via the SAME provider the CREATE landed on (#614).
        const { provider } = ctx.providerRegistry.getProviderFor({
          resourceType: op.resourceType,
          provisionedBy: op.provisionedBy,
        });
        await provider.delete(op.logicalId, op.physicalId, op.resourceType, op.properties, {
          expectedRegion: ctx.region,
        });
        delete stateResources[op.logicalId];
        logger.info(`  Rollback: ${op.logicalId} deleted successfully`);
        await afterOp?.(op.logicalId);
        ctx.recordEvent?.({
          eventType: 'ROLLBACK_RESOURCE_SUCCEEDED',
          stackName,
          operation: 'CREATE',
          logicalId: op.logicalId,
          resourceType: op.resourceType,
          ...(op.provisionedBy && { provisionedBy: op.provisionedBy }),
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
          `  Rollback: Reversing replacement of ${op.logicalId} (${op.resourceType}) — ` +
            `deleting the new resource and re-adopting the retained old one (${prev.physicalId})`
        );
        const { provider: newDeleteProvider } = ctx.providerRegistry.getProviderFor({
          resourceType: op.resourceType,
          provisionedBy: current.provisionedBy ?? op.provisionedBy,
        });
        await newDeleteProvider.delete(
          op.logicalId,
          current.physicalId,
          op.resourceType,
          current.properties,
          { expectedRegion: ctx.region }
        );
        stateResources[op.logicalId] = prev;
        logger.info(`  Rollback: ${op.logicalId} restored to the retained old resource`);
        await afterOp?.(op.logicalId);
        ctx.recordEvent?.({
          eventType: 'ROLLBACK_RESOURCE_SUCCEEDED',
          stackName,
          operation: 'UPDATE',
          logicalId: op.logicalId,
          resourceType: op.resourceType,
          ...(op.provisionedBy && { provisionedBy: op.provisionedBy }),
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
        logger.info(
          `  Rollback: Reversing replacement of ${op.logicalId} (${op.resourceType}) — ` +
            `re-creating the old resource and deleting the new one`
        );
        // Advisory only (issue #1199 non-goal: data cannot be recovered —
        // surface clearly rather than silently "revert"). NOT counted in
        // result.warnings: the reverse-replacement op itself succeeds, and
        // warnings map to exit code 2.
        if (STATEFUL_TYPES.has(op.resourceType)) {
          logger.warn(
            `  ⚠ ${op.logicalId} (${op.resourceType}) is a stateful type — the old physical ` +
              `resource's data was destroyed by the replacement and CANNOT be recovered; the ` +
              `re-created resource starts empty.`
          );
        }
        // Route the re-create via the OLD resource's recorded layer and the
        // new resource's delete via ITS layer (they can differ — e.g. a
        // --recreate-via-cc-api migration).
        const { provider: createProvider } = ctx.providerRegistry.getProviderFor({
          resourceType: op.resourceType,
          provisionedBy: prev.provisionedBy,
        });
        const { provider: newDeleteProvider } = ctx.providerRegistry.getProviderFor({
          resourceType: op.resourceType,
          provisionedBy: current.provisionedBy ?? op.provisionedBy,
        });

        // Create-first (the old resource's revival is the point; if it fails
        // the new resource survives untouched). A user-supplied physical name
        // still held by the NEW resource collides — delete the new one first,
        // then retry the create with a bounded collision retry (async deletes
        // release the name late), mirroring the deploy engine's --replace
        // delete-first fallback.
        let deletedNewFirst = false;
        let createResult: { physicalId: string; attributes?: Record<string, unknown> };
        try {
          createResult = await createProvider.create(op.logicalId, op.resourceType, {
            ...prev.properties,
          });
        } catch (createError) {
          const msg = createError instanceof Error ? createError.message : String(createError);
          const nameCollision = isNameCollisionError(msg);
          if (!nameCollision) throw createError;
          logger.info(
            `  Rollback: re-create collided with the new resource's name — deleting the new ` +
              `resource (${current.physicalId}) first...`
          );
          await newDeleteProvider.delete(
            op.logicalId,
            current.physicalId,
            op.resourceType,
            current.properties,
            { expectedRegion: ctx.region }
          );
          deletedNewFirst = true;
          // Persist the intermediate truth (resource currently absent) so an
          // interrupted re-run doesn't chase a deleted physical id.
          delete stateResources[op.logicalId];
          await afterOp?.(op.logicalId);
          try {
            createResult = await withRetry(
              () => createProvider.create(op.logicalId, op.resourceType, { ...prev.properties }),
              op.logicalId,
              {
                maxRetries: 5,
                initialDelayMs: 2_000,
                maxDelayMs: 10_000,
                logger,
                // Mirror the deploy engine's delete-first fallback: honor
                // SIGINT mid-sleep instead of blocking up to ~34s.
                ...(isInterrupted && {
                  isInterrupted,
                  onInterrupted: () =>
                    new Error('Rollback interrupted while waiting for the old name to release'),
                }),
                isRetryable: isNameCollisionError,
              }
            );
          } catch (recreateError) {
            // The new resource is already gone — say so, because the resource
            // is now absent from both AWS and state.
            throw new Error(
              `Failed to re-create the old ${op.logicalId} after the new resource ` +
                `(${current.physicalId}) was already deleted: ` +
                `${recreateError instanceof Error ? recreateError.message : String(recreateError)}. ` +
                `The resource is now absent — fix forward with 'cdkd deploy'.`
            );
          }
        }

        // Rebuild the record from the previous state, but NEVER carry the
        // OLD physical resource's attributes / observedProperties over — the
        // re-created resource has fresh identifiers (ARNs etc.), and stale
        // cached attributes would poison later Fn::GetAtt resolution and
        // drift comparison. Mirrors the deploy engine's replacement path,
        // which constructs the record fresh from the create result.
        const { observedProperties: _staleObserved, ...prevRecord } = prev;
        stateResources[op.logicalId] = {
          ...prevRecord,
          physicalId: createResult.physicalId,
          attributes: createResult.attributes ?? {},
        };
        await afterOp?.(op.logicalId);

        if (!deletedNewFirst) {
          try {
            await newDeleteProvider.delete(
              op.logicalId,
              current.physicalId,
              op.resourceType,
              current.properties,
              { expectedRegion: ctx.region }
            );
          } catch (deleteError) {
            logger.warn(
              `  Rollback: old ${op.logicalId} re-created, but deleting the new resource ` +
                `(${current.physicalId}) failed: ` +
                `${deleteError instanceof Error ? deleteError.message : String(deleteError)}. ` +
                `Delete it manually — it is no longer tracked in state.`
            );
            result.warnings++;
          }
        }
        logger.info(
          `  Rollback: ${op.logicalId} replacement reversed (old resource re-created as ` +
            `${createResult.physicalId})`
        );
        ctx.recordEvent?.({
          eventType: 'ROLLBACK_RESOURCE_SUCCEEDED',
          stackName,
          operation: 'UPDATE',
          logicalId: op.logicalId,
          resourceType: op.resourceType,
          ...(op.provisionedBy && { provisionedBy: op.provisionedBy }),
        });
        return;
      }

      case 'revert': {
        if (!op.previousState) {
          logger.warn(`  Rollback: Cannot restore ${op.logicalId} — no previous state available`);
          result.warnings++;
          return;
        }
        const current = stateResources[op.logicalId];
        if (!current) {
          logger.warn(
            `  Rollback: Cannot restore ${op.logicalId} — resource not found in current state`
          );
          result.warnings++;
          return;
        }
        logger.info(`  Rollback: Restoring ${op.logicalId} (${op.resourceType}) to previous state`);
        // Route via the provider that owns the resource right now per state.
        const { provider } = ctx.providerRegistry.getProviderFor({
          resourceType: op.resourceType,
          provisionedBy: op.provisionedBy,
        });
        await provider.update(
          op.logicalId,
          current.physicalId,
          op.resourceType,
          op.previousState.properties,
          current.properties
        );
        stateResources[op.logicalId] = op.previousState;
        logger.info(`  Rollback: ${op.logicalId} restored successfully`);
        await afterOp?.(op.logicalId);
        ctx.recordEvent?.({
          eventType: 'ROLLBACK_RESOURCE_SUCCEEDED',
          stackName,
          operation: 'UPDATE',
          logicalId: op.logicalId,
          resourceType: op.resourceType,
          ...(op.provisionedBy && { provisionedBy: op.provisionedBy }),
        });
        return;
      }
    }
  } catch (rollbackError) {
    // Best-effort: warn and continue with remaining rollbacks.
    logger.warn(
      `  Rollback failed for ${op.logicalId} (${op.changeType}): ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`
    );
    logger.warn('  Continuing with remaining rollback operations...');
    result.failures++;
    ctx.recordEvent?.({
      eventType: 'ROLLBACK_RESOURCE_FAILED',
      stackName,
      operation: op.changeType,
      logicalId: op.logicalId,
      resourceType: op.resourceType,
      ...(op.provisionedBy && { provisionedBy: op.provisionedBy }),
      error: extractDeploymentEventError(rollbackError),
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
export async function replayFailedOperations(
  failedOps: FailedOperation[],
  stateResources: Record<string, ResourceState>,
  stackName: string,
  ctx: RollbackExecutorContext,
  options: {
    afterOp?: (logicalId: string) => Promise<void> | void;
    isInterrupted?: () => boolean;
    /**
     * Emit the ROLLBACK_STARTED / ROLLBACK_FINISHED envelope around the
     * failed-op replay. The command passes true for a failed-only segment
     * (zero completed ops), where `replayRollback` returns early without
     * emitting the envelope — keeping `cdkd events` output symmetric.
     */
    emitEnvelope?: boolean;
  } = {}
): Promise<FailedOpReplayResult> {
  const result: FailedOpReplayResult = {
    failures: 0,
    warnings: 0,
    interrupted: false,
    remainingFailedOps: [],
  };
  const { logger } = ctx;
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
    try {
      switch (action) {
        case 'skip-failed-noop': {
          logger.info(
            `  Rollback: failed ${op.changeType} of ${op.logicalId} (${op.resourceType}) ` +
              `left nothing to revert, skipping`
          );
          break;
        }

        case 'skip-failed-unknown': {
          logger.warn(
            `  Rollback: failed CREATE of ${op.logicalId} (${op.resourceType}) recorded no ` +
              `physical id — if it was partially created in AWS, delete it manually`
          );
          result.warnings++;
          break;
        }

        case 'skip-failed-absent': {
          logger.warn(
            `  Rollback: cannot revert failed UPDATE of ${op.logicalId} — no previous state ` +
              `available, skipping`
          );
          result.warnings++;
          break;
        }

        case 'delete-failed-create': {
          logger.info(
            `  Rollback: deleting partially-created ${op.logicalId} (${op.resourceType}) ` +
              `(--revert-failed)`
          );
          const { provider } = ctx.providerRegistry.getProviderFor({
            resourceType: op.resourceType,
            provisionedBy: op.provisionedBy,
          });
          await provider.delete(op.logicalId, op.physicalId!, op.resourceType, undefined, {
            expectedRegion: ctx.region,
          });
          delete stateResources[op.logicalId];
          await options.afterOp?.(op.logicalId);
          ctx.recordEvent?.({
            eventType: 'ROLLBACK_RESOURCE_SUCCEEDED',
            stackName,
            operation: 'CREATE',
            logicalId: op.logicalId,
            resourceType: op.resourceType,
            ...(op.provisionedBy && { provisionedBy: op.provisionedBy }),
          });
          break;
        }

        case 'revert-failed-update': {
          const current = stateResources[op.logicalId]!;
          const prev = op.previousState!;
          logger.info(
            `  Rollback: force-reverting failed UPDATE of ${op.logicalId} (${op.resourceType}) ` +
              `to its pre-deploy properties (--revert-failed; remote state is unknown)`
          );
          const { provider } = ctx.providerRegistry.getProviderFor({
            resourceType: op.resourceType,
            provisionedBy: op.provisionedBy ?? current.provisionedBy,
          });
          // Previous side of the diff = the ATTEMPTED properties (what the
          // failed op may have partially applied), so a patch-based provider
          // generates ops that undo them. Falls back to the current state
          // properties when resolution never got that far.
          await provider.update(
            op.logicalId,
            current.physicalId,
            op.resourceType,
            prev.properties,
            op.attemptedProperties ?? current.properties
          );
          stateResources[op.logicalId] = prev;
          logger.info(`  Rollback: ${op.logicalId} reverted successfully`);
          await options.afterOp?.(op.logicalId);
          ctx.recordEvent?.({
            eventType: 'ROLLBACK_RESOURCE_SUCCEEDED',
            stackName,
            operation: 'UPDATE',
            logicalId: op.logicalId,
            resourceType: op.resourceType,
            ...(op.provisionedBy && { provisionedBy: op.provisionedBy }),
          });
          break;
        }
      }
    } catch (revertError) {
      logger.warn(
        `  Rollback failed for failed-op ${op.logicalId} (${op.changeType}): ` +
          `${revertError instanceof Error ? revertError.message : String(revertError)}`
      );
      result.failures++;
      pending.add(op);
      ctx.recordEvent?.({
        eventType: 'ROLLBACK_RESOURCE_FAILED',
        stackName,
        operation: op.changeType,
        logicalId: op.logicalId,
        resourceType: op.resourceType,
        ...(op.provisionedBy && { provisionedBy: op.provisionedBy }),
        error: extractDeploymentEventError(revertError),
      });
    }
  }
  if (emitEnvelope) ctx.recordEvent?.({ eventType: 'ROLLBACK_FINISHED', stackName });
  result.remainingFailedOps = failedOps.filter((op) => pending.has(op));
  return result;
}

function stateResourcesPolicyLabel(
  op: CompletedOperation,
  stateResources: Record<string, ResourceState>
): string {
  return stateResources[op.logicalId]?.deletionPolicy ?? 'Retain';
}

/**
 * Sort CREATE rollback operations so that resources depending on others are
 * deleted first (reverse dependency order), using state dependencies. Same
 * algorithm as the pre-extraction `DeployEngine.sortRollbackCreates`.
 */
export function sortRollbackCreates(
  createOps: CompletedOperation[],
  stateResources: Record<string, ResourceState>,
  logger?: Logger
): CompletedOperation[] {
  const opMap = new Map<string, CompletedOperation>();
  const deleteIds = new Set<string>();
  for (const op of createOps) {
    opMap.set(op.logicalId, op);
    deleteIds.add(op.logicalId);
  }

  const dependedBy = new Map<string, Set<string>>();
  for (const id of deleteIds) {
    if (!dependedBy.has(id)) dependedBy.set(id, new Set());
  }

  for (const id of deleteIds) {
    const resource = stateResources[id];
    if (!resource?.dependencies) continue;
    for (const dep of resource.dependencies) {
      if (!deleteIds.has(dep)) continue;
      // id depends on dep → dep must be deleted AFTER id
      if (!dependedBy.has(dep)) dependedBy.set(dep, new Set());
      dependedBy.get(dep)!.add(id);
    }
  }

  const sorted: CompletedOperation[] = [];
  let remaining = new Set(deleteIds);

  while (remaining.size > 0) {
    const level: string[] = [];
    for (const id of remaining) {
      const dependents = dependedBy.get(id);
      const hasPendingDependents = dependents
        ? [...dependents].some((d) => remaining.has(d))
        : false;
      if (!hasPendingDependents) level.push(id);
    }

    if (level.length === 0) {
      logger?.warn(
        `Circular dependency detected in rollback order, processing remaining ${remaining.size} resources`
      );
      for (const id of remaining) {
        const op = opMap.get(id);
        if (op) sorted.push(op);
      }
      break;
    }

    for (const id of level) {
      const op = opMap.get(id);
      if (op) sorted.push(op);
    }
    remaining = new Set([...remaining].filter((id) => !level.includes(id)));
  }

  logger?.debug(`Rollback CREATE deletion order: ${sorted.map((op) => op.logicalId).join(' → ')}`);
  return sorted;
}
