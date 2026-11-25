/**
 * The deferred replaced-delete retry pass and its end-of-deploy warning.
 * Moved out of `deploy-engine/replacement.ts` (go-to-k/cdkd#5835), which
 * re-exports every symbol it exported, so no importer changes.
 */
import { displayPhysicalId } from '../../../provisioning/secret-physical-id.js';
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
  /**
   * Undefined for a delete never attempted inside the DAG: a custom
   * resource's old physical id, which CloudFormation deletes only in the
   * cleanup phase (go-to-k/cdkd#6117).
   */
  failureMessage: string | undefined;
  /**
   * go-to-k/cdkd#6374: a create-first replacement's delete, deferred up
   * front to the cleanup phase rather than after a failure.
   */
  cleanupPhase?: true;
  /**
   * go-to-k/cdkd#6374: the old record's `dependencies`, so the cleanup pass
   * deletes a replaced child before the replaced parent it depended on, as
   * CloudFormation's cleanup does.
   */
  dependencies?: readonly string[];
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
  const entries = [...deferred.values()];
  const retried = entries.filter((entry) => entry.failureMessage !== undefined).length;
  const cleanup = entries.filter((entry) => entry.cleanupPhase === true).length;
  const movedIds = entries.length - retried - cleanup;
  if (retried > 0) {
    deps.logger.info(safeMsg`Retrying the delete of ${retried} replaced resource(s)`);
  }
  if (cleanup > 0) {
    deps.logger.info(safeMsg`Deleting the old resource of ${cleanup} replaced resource(s)`);
  }
  if (movedIds > 0) {
    deps.logger.info(
      safeMsg`Deleting the old physical id of ${movedIds} replaced custom resource(s)`
    );
  }
  const pending = new Map(deferred);
  await runInWaves(run, deps, stackName, counts, pending);
  // A Ctrl-C between waves sends nothing more: what is left and recorded as
  // superseded stays for the next deploy or `cdkd destroy`; what was deferred
  // in memory only (go-to-k/cdkd#6445) is named, as no state tracks it.
  if (pending.size > 0) warnUnsentUntracked(run, deps, pending);
}

/**
 * go-to-k/cdkd#6977: deletes, before the deploy's removal deletes, every
 * deferred old copy that still uses a resource removed from the template
 * (an old alias pointing at a removed old version), and the deferred old
 * copies using those. CloudFormation's cleanup phase deletes both kinds in
 * one dependency order; deleting the removed resource first is refused by
 * AWS while the old copy still uses it. The deploy's creates and updates are
 * done by then, so nothing left in it still needs these old copies.
 *
 * `removedDependencies` answers a removed record's own dependencies. When a
 * removed resource uses one of the old copies taken here, no order deletes
 * both correctly in two passes, so nothing is taken and the cleanup phase
 * deletes them as before.
 */
export async function deleteDeferredUsersOfRemovals(
  run: ReplacementRunState,
  deps: ReplacementDeps,
  stackName: string,
  counts: { updated: number; updatePartial: number },
  removedIds: ReadonlySet<string>,
  removedDependencies: (logicalId: string) => readonly string[]
): Promise<void> {
  const deferred = run.deferredReplacedDeletes;
  if (deferred === undefined || deferred.size === 0 || removedIds.size === 0) return;
  const users = (entry: DeferredReplacedDelete, ids: { has(id: string): boolean }): boolean =>
    (entry.dependencies ?? []).some((dep) => ids.has(dep));
  const taken = new Map<string, DeferredReplacedDelete>();
  for (const [logicalId, entry] of deferred) {
    if (!removedIds.has(logicalId) && users(entry, removedIds)) taken.set(logicalId, entry);
  }
  if (taken.size === 0) return;
  // The old copies using a taken one go before it, as in the cleanup phase.
  for (let grew = true; grew;) {
    grew = false;
    for (const [logicalId, entry] of deferred) {
      if (taken.has(logicalId) || !users(entry, taken)) continue;
      taken.set(logicalId, entry);
      grew = true;
    }
  }
  for (const removed of removedIds) {
    if (removedDependencies(removed).some((dep) => dep !== removed && taken.has(dep))) return;
  }
  for (const logicalId of taken.keys()) deferred.delete(logicalId);
  deps.logger.info(
    safeMsg`Deleting the old resource of ${taken.size} replaced resource(s) first: they use a resource removed from the template`
  );
  await runInWaves(run, deps, stackName, counts, taken);
  // Interrupted between waves: what is left goes back to the cleanup pass,
  // whose interrupted and failed arms report it.
  for (const [logicalId, entry] of taken) deferred.set(logicalId, entry);
}

/**
 * go-to-k/cdkd#6374: in waves, dependents first: an entry runs once no other
 * pending entry depends on it (an old subnet before its old VPC). A cycle runs
 * whatever is left at once. Each entry run is removed from `pending`; on a
 * Ctrl-C between waves the rest stays in it.
 */
async function runInWaves(
  run: ReplacementRunState,
  deps: ReplacementDeps,
  stackName: string,
  counts: { updated: number; updatePartial: number },
  pending: Map<string, DeferredReplacedDelete>
): Promise<void> {
  while (pending.size > 0) {
    if (deps.interrupted()) return;
    const dependedOn = new Set<string>();
    for (const [logicalId, entry] of pending) {
      for (const dep of entry.dependencies ?? []) {
        if (dep !== logicalId && pending.has(dep)) dependedOn.add(dep);
      }
    }
    const wave = [...pending].filter(([logicalId]) => !dependedOn.has(logicalId));
    const queue = wave.length > 0 ? wave : [...pending];
    for (const [logicalId] of queue) pending.delete(logicalId);
    const workers = Math.max(1, Math.min(deps.options.concurrency ?? 1, queue.length));
    await Promise.all(
      Array.from({ length: workers }, async () => {
        for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
          await retryOne(run, deps, stackName, counts, ...next);
        }
      })
    );
  }
}

/**
 * One deferred delete, under the scopes its row's inline delete had: the
 * row's printing registry, the stack's records, and a delete-guard sink
 * emitted as the row's. A skip makes the row a partial update.
 */
async function retryOne(
  run: ReplacementRunState,
  deps: ReplacementDeps,
  stackName: string,
  counts: { updated: number; updatePartial: number },
  logicalId: string,
  entry: DeferredReplacedDelete
): Promise<void> {
  const guards: ReportedDeleteGuard[] = [];
  try {
    await withPrintingSecrets(secretNameBagFor(deps.secretsRun(), logicalId), () =>
      withStackRecords(deps.stackRecordsView(), () =>
        collectDeleteGuards(guards, async () => {
          deps.logger.info(
            safeMsg`  Deleting old ${logicalId} (${displayPhysicalId(entry.resourceType, entry.physicalId)})...`
          );
          try {
            await entry.retry();
          } catch {
            // `deleteReplacedAfterCreate` catches the provider's own error;
            // anything else must not strand the entries still queued. Its
            // text is not shown: nothing masked it.
            deps.logger.warn(
              safeMsg`  ⚠ Failed to delete old resource ${logicalId} (${displayPhysicalId(entry.resourceType, entry.physicalId)}): the retry failed unexpectedly`
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
}

/**
 * go-to-k/cdkd#6445: the cleanup pass was interrupted before these entries
 * ran. One no superseded record tracks (an in-memory deferral) is warned
 * about by id, since nothing else will delete it.
 */
function warnUnsentUntracked(
  run: ReplacementRunState,
  deps: ReplacementDeps,
  pending: ReadonlyMap<string, DeferredReplacedDelete>
): void {
  for (const [logicalId, entry] of pending) {
    if (run.supersededEntries.has(logicalId)) continue;
    withPrintingSecrets(secretNameBagFor(deps.secretsRun(), logicalId), () =>
      deps.logger.warn(
        safeMsg`  ⚠ Old ${logicalId} (${displayPhysicalId(entry.resourceType, entry.physicalId)}) was not deleted: the deploy was interrupted. It is no longer tracked in state, so delete it manually`
      )
    );
  }
}

/**
 * The deploy failed or was interrupted before the retry: each deferred delete
 * gets the warning its inline failure would have printed (go-to-k/cdkd#4900).
 * `'cleanup-failed'`: a nested child's pass, queued for the root's success,
 * could not run although the deploy succeeded (go-to-k/cdkd#6398), so no
 * rollback follows to take a cleanup-phase entry back.
 */
export function warnUnretriedReplacedDeletes(
  run: ReplacementRunState,
  deps: ReplacementDeps,
  why: 'failed' | 'interrupted' | 'cleanup-failed'
): void {
  const deferred = run.deferredReplacedDeletes;
  run.deferredReplacedDeletes = undefined;
  const cause =
    why === 'failed'
      ? 'the deploy failed first'
      : why === 'interrupted'
        ? 'the deploy was interrupted'
        : "its nested stack's cleanup could not run";
  // go-to-k/cdkd#5111: a recorded one stays in state for the next deploy; one
  // `canRecordSuperseded` kept in memory only is no longer tracked.
  const noteFor = (logicalId: string): string =>
    run.supersededEntries.has(logicalId)
      ? `not retried: ${cause}; cdkd keeps it in state, and the next deploy retries the delete`
      : `not retried: ${cause}; it is no longer tracked in state, so delete it manually`;
  for (const [logicalId, entry] of deferred ?? []) {
    withPrintingSecrets(secretNameBagFor(deps.secretsRun(), logicalId), () =>
      why === 'cleanup-failed' && entry.failureMessage === undefined
        ? // go-to-k/cdkd#6398: never sent, and the deploy succeeded, so no
          // rollback takes it back.
          deps.logger.warn(
            safeMsg`  ⚠ Old ${logicalId} (${displayPhysicalId(entry.resourceType, entry.physicalId)}) was not deleted: ${cause}. ${run.supersededEntries.has(logicalId) ? 'cdkd keeps it in state, and the next deploy deletes it' : 'It is no longer tracked in state, so delete it manually'}`
          )
        : entry.cleanupPhase === true
          ? // go-to-k/cdkd#6374: never sent; the rollback that follows a failed
            // deploy re-adopts it. An info line while state keeps it, as nothing
            // went wrong with it; a warning for an in-memory deferral
            // (go-to-k/cdkd#6445), which nothing tracks without that rollback.
            run.supersededEntries.has(logicalId)
            ? deps.logger.info(
                safeMsg`  Old ${logicalId} (${displayPhysicalId(entry.resourceType, entry.physicalId)}) was not deleted: ${cause}. A rollback of the deploy adopts it again; otherwise cdkd keeps it in state, and the next deploy deletes it`
              )
            : deps.logger.warn(
                safeMsg`  ⚠ Old ${logicalId} (${displayPhysicalId(entry.resourceType, entry.physicalId)}) was not deleted: ${cause}. A rollback of the deploy adopts it again; otherwise it is no longer tracked in state, so delete it manually`
              )
          : deps.logger.warn(
              entry.failureMessage === undefined
                ? // go-to-k/cdkd#6117: never sent. A rollback that reverses the
                  // update sends the new id an Update with the old properties
                  // (#6120): tracked again only when the handler answers this id.
                  safeMsg`  ⚠ The old physical id of ${logicalId} (${displayPhysicalId(entry.resourceType, entry.physicalId)}) was not sent its Delete: ${cause}. A rollback sends the new id an Update with the old properties, and this id is tracked again if the handler answers it; otherwise ${run.supersededEntries.has(logicalId) ? 'cdkd keeps it in state, and the next deploy sends the Delete' : 'it is no longer tracked in state, so delete it manually'}`
                : safeMsg`  ⚠ Failed to delete old resource ${logicalId} (${displayPhysicalId(entry.resourceType, entry.physicalId)}): ${entry.failureMessage} (${noteFor(logicalId)})`
            )
    );
  }
}
