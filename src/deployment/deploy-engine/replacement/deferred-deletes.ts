/**
 * The deferred replaced-delete retry pass and its end-of-deploy warning.
 * Moved out of `deploy-engine/replacement.ts` (go-to-k/cdkd#5835), which
 * re-exports every symbol it exported, so no importer changes.
 */
import { EMPTY_SECRETS } from '../../deploy-engine.js';
import { secretNameBagFor } from '../masking.js';
import { safeMsg } from '../../../utils/display-safe.js';
import { type ReportedDeleteGuard, collectDeleteGuards } from '../../delete-guard-scope.js';
import { withPrintingSecrets } from '../../resource-secrets-scope.js';
import { withStackRecords } from '../../stack-records-scope.js';
import { maskSecretsInText } from '../../secret-redaction.js';
import type { ReplacementRunState, ReplacementDeps } from './run-state.js';

/**
 * A replaced resource's delete that failed inside the DAG, kept for one retry
 * after it (go-to-k/cdkd#4900). `failureMessage` is already masked with the
 * row's resolved secrets; the lines naming it also mask the row's
 * derived-name registry, bound around each print.
 */
export interface DeferredReplacedDelete {
  physicalId: string;
  resourceType: string;
  provisionedBy: 'sdk' | 'cc-api' | undefined;
  failureMessage: string;
  /** Set by `provisionResource` when the row already ended partial. */
  rowPartial?: boolean;
  retry: () => Promise<void>;
}

/**
 * Retries every deferred delete once the deploy's creates, updates and
 * deletes have all completed (go-to-k/cdkd#4900). Each retry runs under the
 * scopes its row's inline delete had: the row's printing registry, the
 * stack's records, and a delete-guard sink emitted as the row's. A retry that
 * fails warns exactly as the inline delete did; a skip makes the row a
 * partial update, as it would have inline. At most `--concurrency` at once.
 */
export async function retryDeferredReplacedDeletes(
  run: ReplacementRunState,
  deps: ReplacementDeps,
  stackName: string,
  counts: { updated: number; updatePartial: number }
): Promise<void> {
  const deferred = run.deferredReplacedDeletes;
  run.deferredReplacedDeletes = undefined;
  if (deferred === undefined || deferred.size === 0) return;
  deps.logger.info(safeMsg`Retrying the delete of ${deferred.size} replaced resource(s)`);
  const retryOne = async (logicalId: string, entry: DeferredReplacedDelete): Promise<void> => {
    const guards: ReportedDeleteGuard[] = [];
    try {
      await withPrintingSecrets(secretNameBagFor(deps.secretsRun(), logicalId), () =>
        withStackRecords(deps.stackRecordsView(), () =>
          collectDeleteGuards(guards, async () => {
            deps.logger.info(safeMsg`  Deleting old ${logicalId} (${entry.physicalId})...`);
            try {
              await entry.retry();
            } catch {
              // `deleteReplacedAfterCreate` catches the provider's own error;
              // anything else must not strand the entries still queued. Its
              // text is not shown: nothing masked it.
              deps.logger.warn(
                safeMsg`  ⚠ Failed to delete old resource ${logicalId} (${entry.physicalId}): the retry failed unexpectedly`
              );
            }
          })
        )
      );
    } finally {
      // As `provisionResource` emits the row's guards (issue #2422).
      for (const guard of guards) {
        deps.recordEvent({
          eventType: 'RESOURCE_GUARD_INDETERMINATE',
          stackName,
          operation: 'DELETE',
          logicalId,
          resourceType: guard.resourceType,
          ...(guard.provisionedBy && { provisionedBy: guard.provisionedBy }),
          ...(guard.physicalId && {
            physicalId: maskSecretsInText(
              guard.physicalId,
              deps.secretsRun().perResourceSecrets.get(logicalId) ?? EMPTY_SECRETS
            ),
          }),
          guard: guard.guard,
          reason: guard.reason,
        });
      }
    }
    const skip = run.replacedDeleteSkips.get(logicalId);
    if (skip === undefined) return;
    run.replacedDeleteSkips.delete(logicalId);
    // As `provisionResource` turns an inline skip into the row's partial
    // update: counted once, and the survivor named in its own event.
    if (entry.rowPartial !== true) {
      counts.updated = Math.max(0, counts.updated - 1);
      counts.updatePartial++;
    }
    deps.recordEvent({
      eventType: 'RESOURCE_SKIPPED',
      stackName,
      operation: 'UPDATE',
      logicalId,
      resourceType: entry.resourceType,
      ...(entry.provisionedBy && { provisionedBy: entry.provisionedBy }),
      physicalId: entry.physicalId,
      reason: skip,
    });
  };
  const queue = [...deferred];
  const workers = Math.max(1, Math.min(deps.options.concurrency ?? 1, queue.length));
  await Promise.all(
    Array.from({ length: workers }, async () => {
      for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
        await retryOne(...next);
      }
    })
  );
}

/**
 * The deploy failed or was interrupted before the retry: each deferred delete
 * gets the warning its inline failure would have printed (go-to-k/cdkd#4900).
 */
export function warnUnretriedReplacedDeletes(
  run: ReplacementRunState,
  deps: ReplacementDeps,
  why: 'failed' | 'interrupted'
): void {
  const deferred = run.deferredReplacedDeletes;
  run.deferredReplacedDeletes = undefined;
  const cause = why === 'failed' ? 'the deploy failed first' : 'the deploy was interrupted';
  // go-to-k/cdkd#5111: a recorded one stays in state for the next deploy; one
  // `canRecordSuperseded` kept in memory only is no longer tracked.
  const noteFor = (logicalId: string): string =>
    run.supersededEntries.has(logicalId)
      ? `not retried: ${cause}; cdkd keeps it in state, and the next deploy retries the delete`
      : `not retried: ${cause}; it is no longer tracked in state, so delete it manually`;
  for (const [logicalId, entry] of deferred ?? []) {
    withPrintingSecrets(secretNameBagFor(deps.secretsRun(), logicalId), () =>
      deps.logger.warn(
        safeMsg`  ⚠ Failed to delete old resource ${logicalId} (${entry.physicalId}): ${entry.failureMessage} (${noteFor(logicalId)})`
      )
    );
  }
}
