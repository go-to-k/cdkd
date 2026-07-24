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
  | 'skip-already-done' // idempotent skip (already reverted / already gone)
  | 'skip-mismatch' // CREATE physical id changed by a later attempt
  | 'skip-absent' // UPDATE target no longer in state
  | 'unrecoverable-delete'; // DELETE cannot be restored

/** One planned rollback action (rendered by the command's plan preview). */
export interface RollbackPlanItem {
  op: CompletedOperation;
  action: RollbackActionKind;
  /** For a replacement op (previousState.physicalId !== op.physicalId). */
  replacement: boolean;
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
  if (op.previousState && deepEqual(current.properties, op.previousState.properties)) {
    // Already reverted (idempotent re-run). A replacement op never
    // deep-equals here (its physical id differs) so it still attempts.
    if (!replacement) return 'skip-already-done';
  }
  return 'revert';
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
      options.afterOp
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
        options.afterOp
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
  afterOp?: (logicalId: string) => Promise<void> | void
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
