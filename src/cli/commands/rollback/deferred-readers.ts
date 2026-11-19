/**
 * `cdkd rollback`'s failed-op journal bookkeeping, and go-to-k/cdkd#6597's
 * deferred failed readers of a regenerated secret.
 *
 * A failed UPDATE whose record reads, through a token, a secret a completed
 * op's revert regenerates is reverted AFTER the completed ops, at the secret's
 * new value, as CloudFormation restores a reader after the secret it reads.
 * One whose attempt names a resource a completed CREATE made keeps its place:
 * the completed replay deletes those CREATEs.
 */
import type { ResourceState } from '../../../types/state.js';
import { withPrintingSecrets } from '../../../deployment/resource-secrets-scope.js';
import {
  replayFailedOperations,
  type CompletedOperation,
  type FailedOperation,
  type FailedOpReplayResult,
  type RollbackExecutorContext,
  type RollbackReplayResult,
} from '../../../deployment/rollback-executor.js';
import { seedsDeleteFirstGuard } from '../../../deployment/rollback-executor/plan.js';
import {
  attemptUsesCompletedCreate,
  readsRegeneratingSecret,
} from '../../../deployment/rollback-executor/regenerated-secrets.js';
import { safeMsg } from '../../../utils/display-safe.js';
import type { ConsoleLogger } from '../../../utils/logger.js';
import { backendErrorText } from './render.js';

/** Where a segment's still-pending failed ops are persisted. */
export interface FailedOpsJournal {
  segment: { failedOperations?: FailedOperation[] | undefined };
  /** False after a declined divergent rewrite (go-to-k/cdkd#3370). */
  writable: () => boolean;
  set: (ops: FailedOperation[]) => Promise<void>;
  logger: Pick<ConsoleLogger, 'warn'>;
  stackName: string;
  region: string;
}

/**
 * Persist ONLY the still-pending failed ops (per-op strip). A handled op must
 * never be re-issued on a re-run: replaying `attemptedProperties` as the
 * previous diff side against an already-reverted resource would generate a
 * patch undoing changes that no longer exist. Best-effort: on a strip failure
 * the re-run merely re-attempts the revert. Not after a declined divergent
 * rewrite: the handled ops' state rows were never saved, so stripping them
 * would leave the record describing work the journal no longer carries.
 */
export async function stripFailedOpsJournal(
  journal: FailedOpsJournal,
  remaining: FailedOperation[]
): Promise<void> {
  const { segment } = journal;
  if (!journal.writable() || remaining.length === (segment.failedOperations ?? []).length) return;
  try {
    await journal.set(remaining);
    if (remaining.length === 0) delete segment.failedOperations;
    else segment.failedOperations = remaining;
  } catch (stripError) {
    journal.logger.warn(
      safeMsg`Failed to strip replayed failed-ops from the journal: ${backendErrorText(stripError, journal.stackName, journal.region)}`
    );
  }
}

/** The failed ops still pending after the first failed-op replay. */
export function remainingAfterFailedReplay(
  failedOps: {
    imported: FailedOperation[];
    displaced: FailedOperation[];
    replay: FailedOperation[];
  },
  failedToReplay: readonly FailedOperation[],
  failedResult: FailedOpReplayResult,
  completedOps: readonly CompletedOperation[]
): FailedOperation[] {
  return [
    ...failedOps.imported,
    ...failedOps.displaced,
    ...failedOps.replay.filter((op) => !failedToReplay.includes(op)),
    ...failedResult.remainingFailedOps,
    // go-to-k/cdkd#4690: a handled delete-first replacement stays while this
    // segment's completed ops remain, so a re-run's delete-first guard still
    // sees the resource it removed; it leaves with the segment once it pops.
    // On a `--revert-failed` re-run, the `replacementOrphaned` shape
    // re-classifies as the same skip and repeats its warning; the bare shape
    // (no orphan) re-attempts its forced revert against the deleted old id,
    // which normally fails not-found and keeps it pending.
    ...(completedOps.length > 0
      ? failedToReplay.filter(
          (op) => seedsDeleteFirstGuard(op) && !failedResult.remainingFailedOps.includes(op)
        )
      : []),
  ];
}

/** The failed ops to replay now, and the readers deferred past the completed ops. */
export function splitDeferredReaders(
  failedToReplay: readonly FailedOperation[],
  stateResources: Record<string, ResourceState>,
  completedOps: readonly CompletedOperation[]
): { now: FailedOperation[]; deferred: FailedOperation[] } {
  const deferred = failedToReplay.filter(
    (op) =>
      op.changeType === 'UPDATE' &&
      readsRegeneratingSecret(op.logicalId, stateResources, completedOps) &&
      !attemptUsesCompletedCreate(op.attemptedProperties, completedOps)
  );
  return { now: failedToReplay.filter((op) => !deferred.includes(op)), deferred };
}

/**
 * Replay the deferred readers after the completed ops, with the secrets that
 * replay regenerated, and strip the handled ones from the journal.
 */
export async function replayDeferredReaders(
  deferred: readonly FailedOperation[],
  completed: RollbackReplayResult,
  scope: {
    stateResources: Record<string, ResourceState>;
    stackName: string;
    ctx: RollbackExecutorContext;
    printing: Parameters<typeof withPrintingSecrets>[0];
    journal: FailedOpsJournal;
  },
  options: NonNullable<Parameters<typeof replayFailedOperations>[4]>
): Promise<{ failures: number; warnings: number; interrupted: boolean }> {
  const result = await withPrintingSecrets(scope.printing, () =>
    replayFailedOperations([...deferred], scope.stateResources, scope.stackName, scope.ctx, {
      ...options,
      emitEnvelope: false,
      regeneratedSecrets: new Set(
        [...(completed.regeneratedSecrets?.values() ?? [])].flatMap((a) => [...a])
      ),
    })
  );
  const handled = deferred.filter((op) => !result.remainingFailedOps.includes(op));
  await stripFailedOpsJournal(
    scope.journal,
    (scope.journal.segment.failedOperations ?? []).filter((op) => !handled.includes(op))
  );
  return { failures: result.failures, warnings: result.warnings, interrupted: result.interrupted };
}
