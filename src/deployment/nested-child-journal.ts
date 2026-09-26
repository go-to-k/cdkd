/**
 * A nested child's rollback journal across its PARENT's deploy (issue
 * [#3754](https://github.com/go-to-k/cdkd/issues/3754)).
 *
 * A nested child deploys inside its parent's `AWS::CloudFormation::Stack` row
 * and SUCCEEDS before the parent has finished. When the parent then fails and
 * reverts that row, the revert must put the child back where it was — and the
 * only record of "where it was" is the child's own completed ops. The child's
 * template cannot say it: `ctx.nestedTemplates` holds the CURRENT synth, and
 * re-deploying it over the child's just-saved state diffs `NO_CHANGE`, which is
 * how a rollback used to report the row "restored" while the child kept the
 * failed deploy's configuration.
 *
 * So the lifecycle is:
 *
 *  1. A NESTED engine that succeeds appends a `nested-pending-parent` segment
 *     (its completed ops, possibly none, plus its pre-deploy outputs) instead
 *     of deleting its journal. Older segments stay: a parent segment from an
 *     earlier failed run may still need them.
 *  2. The ROOT engine that succeeds deletes its own journal and every
 *     descendant's ({@link dropNestedChildJournals} with no run): the parent
 *     tree's baseline moved, exactly as a lone stack's success drops its whole
 *     journal. This also sweeps segments a crashed run left behind.
 *  3. A revert of the row (`NestedStackProvider.update` with
 *     `UpdateContext.replayingState`) replays the child's segments recorded
 *     under the SAME `runId` as the parent segment being replayed
 *     ({@link revertNestedChildFromJournal}); the run is carried by
 *     {@link withNestedRevertRun}, which both rollback drivers bind. The
 *     segments are NOT popped here — a partial parent rollback re-runs the
 *     row, and the replay is idempotent — but once the parent's own segment is
 *     settled, its driver drops them ({@link dropNestedChildJournals} with the
 *     run).
 *
 * Correlation is by `runId` (the top-level run's deployments id, which a child
 * engine inherits with the parent's event recorder), not by position: a child
 * that failed and rolled itself back leaves a segment the parent never reverts,
 * so "the newest child segment" is not the one a given parent segment means.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { S3StateBackend } from '../state/s3-state-backend.js';
import type { Logger } from '../types/config.js';
import type { ResourceState, StackOrphanRecord, StackState } from '../types/state.js';
import {
  STATE_SCHEMA_VERSION_CURRENT,
  importableOutputs,
  orphansAfterRollback,
} from '../types/state.js';
import {
  refuseMalformedOrphanRecords,
  refuseMalformedOrphans,
  refuseMalformedState,
} from '../state/malformed-resources-bag.js';
import { replayRollback, type RollbackExecutorContext } from './rollback-executor.js';
import { producerRegionsFromState } from './secret-region-classification.js';
import { markNonRetryable } from './retryable-errors.js';
import {
  withNestedStackContext,
  type NestedStackProviderContext,
} from '../provisioning/nested-stack-context.js';
import { withStackName } from '../provisioning/resource-name.js';
import { displayIdent, displaySafe } from '../utils/display-safe.js';

/** The segment reason a nested engine records on success. */
export const NESTED_PENDING_PARENT_REASON = 'nested-pending-parent' as const;

const NESTED_STACK_TYPE = 'AWS::CloudFormation::Stack';

/** The child state key `NestedStackProvider` derives: `<parent>~<logicalId>`. */
export function nestedChildStackName(parentStackName: string, logicalId: string): string {
  return `${parentStackName}~${logicalId}`;
}

/**
 * The parent run a rollback is replaying. `runId` may legitimately be
 * `undefined` (a deploy wired with no event recorder writes runId-less
 * segments, and those match each other); the SCOPE being absent is the
 * different case — no rollback driver bound it.
 */
export interface NestedRevertRun {
  runId: string | undefined;
}

const revertRunStorage = new AsyncLocalStorage<NestedRevertRun>();

/** Bind the parent run being replayed around a `replayRollback` call. */
export function withNestedRevertRun<T>(runId: string | undefined, fn: () => T): T {
  return revertRunStorage.run({ runId }, fn);
}

/** The run bound by {@link withNestedRevertRun}, or `undefined` outside one. */
export function getNestedRevertRun(): NestedRevertRun | undefined {
  return revertRunStorage.getStore();
}

function errorText(error: unknown): string {
  return displaySafe(error instanceof Error ? error.message : String(error));
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Delete, or narrow, the rollback journals of every nested descendant of
 * `resources`. With `run` absent every descendant journal is deleted (the root
 * succeeded); with `run` given only that run's segments are removed (its
 * rollback settled). Depth-first, so a grandchild is handled before the child
 * whose state named it.
 *
 * Best-effort and never throws: the deploy or rollback that calls it has
 * already succeeded, and a journal left behind is inert — a later revert only
 * selects segments by run, and the next successful root deploy sweeps it.
 * A child whose state record is missing or unreadable is skipped (its journal,
 * if any, is left for that sweep).
 *
 * No child lock is taken: every writer of a nested child's journal runs under
 * the ROOT stack's lock (the child deploy, its replay), which the caller holds.
 */
export async function dropNestedChildJournals(args: {
  stateBackend: S3StateBackend;
  parentStackName: string;
  region: string;
  resources: Record<string, ResourceState> | undefined;
  logger: Pick<Logger, 'debug' | 'warn'>;
  run?: NestedRevertRun;
}): Promise<void> {
  const { stateBackend, parentStackName, region, resources, logger, run } = args;
  if (!isPlainRecord(resources)) return;
  for (const [logicalId, record] of Object.entries(resources)) {
    if (!isPlainRecord(record) || record['resourceType'] !== NESTED_STACK_TYPE) continue;
    const child = nestedChildStackName(parentStackName, logicalId);
    try {
      const data = await stateBackend.getState(child, region);
      if (data && isPlainRecord(data.state) && isPlainRecord(data.state.resources)) {
        await dropNestedChildJournals({
          ...args,
          parentStackName: child,
          resources: data.state.resources,
        });
      }
      if (run) {
        const removed = await stateBackend.dropRollbackJournalSegments(
          child,
          region,
          (segment) => segment.runId === run.runId
        );
        if (removed > 0) {
          logger.debug(
            `Dropped ${removed} settled rollback journal segment(s) of ${displaySafe(child)}`
          );
        }
      } else if (await stateBackend.loadRollbackJournal(child, region)) {
        await stateBackend.deleteRollbackJournal(child, region);
        logger.debug(`Deleted the rollback journal of nested stack ${displaySafe(child)}`);
      }
    } catch (error) {
      logger.warn(
        `Could not clear the rollback journal of nested stack ${displayIdent(child)}: ${errorText(error)}. ` +
          `It is inert (a revert selects segments by run) and the next successful deploy of the ` +
          `top-level stack removes it.`
      );
    }
  }
}

/**
 * Put a nested child back to the state it held before the parent run `runId`
 * touched it, by replaying the child's own journal segments for that run —
 * NEVER by re-deploying a template (see the module doc).
 *
 * `ctx` is the context of the PARENT whose row is being reverted. Works in a
 * destroy-mode context too (standalone `cdkd rollback` carries no templates),
 * since nothing here reads one.
 *
 * THROWS, so the caller's row revert FAILS rather than reporting a restore
 * that did not happen, when: there is no child state; the child journal holds
 * no segment for the run (it was never retained — a journal written by an
 * older cdkd — or it was removed by hand or by a direct `cdkd rollback` of the
 * child); or any replayed op failed. The replayed segments are kept either
 * way; their parent's driver drops them once its segment is settled.
 */
export async function revertNestedChildFromJournal(args: {
  ctx: NestedStackProviderContext;
  logicalId: string;
  childStackName: string;
  region: string;
  runId: string | undefined;
  logger: Logger;
}): Promise<void> {
  const { ctx, logicalId, childStackName, region, runId, logger } = args;
  const shownChild = displayIdent(childStackName);
  const refuse = (detail: string): never => {
    throw markNonRetryable(
      new Error(
        `Cannot revert nested stack ${shownChild} (row ${displayIdent(logicalId)}): ${detail} ` +
          `The child was NOT (fully) reverted and may still hold the failed deploy's configuration. ` +
          `Inspect it with 'cdkd state show', then re-deploy the parent to converge.`
      )
    );
  };

  await ctx.lockManager.acquireLockWithRetry(childStackName, region, undefined, 'rollback');
  try {
    const stateData = await ctx.stateBackend.getState(childStackName, region);
    if (!stateData) refuse('its state.json is missing.');
    if (stateData!.divergentBodyRegion !== undefined) {
      refuse("its state record's region field disagrees with the key it is stored under.");
    }
    const base: StackState = stateData!.state;
    refuseMalformedState(base, childStackName, region);
    refuseMalformedOrphans(base, childStackName, region);
    refuseMalformedOrphanRecords(base, childStackName, region);

    const journal = await ctx.stateBackend.loadRollbackJournal(childStackName, region);
    const segments = (journal?.segments ?? []).filter((segment) => segment.runId === runId);
    if (segments.length === 0) {
      refuse(
        'its rollback journal holds no segment for this deploy run, so there is no record of ' +
          'what it held before.'
      );
    }

    const stateResources: Record<string, ResourceState> = { ...base.resources };
    const mintedOrphans: StackOrphanRecord[] = [];
    let restoredOutputs: { outputs: Record<string, unknown>; exportNames?: string[] } | undefined;
    let currentEtag = stateData!.etag;
    // `skippedOutputs` is dropped for the reason `cdkd rollback`'s own save
    // drops it: the replay can change what an output reads.
    const { skippedOutputs: _dropped, ...carried } = base;
    const next = (): StackState => ({
      ...carried,
      version: STATE_SCHEMA_VERSION_CURRENT,
      region,
      resources: { ...stateResources },
      ...orphansAfterRollback(base, mintedOrphans),
      ...(restoredOutputs && {
        outputs: { ...restoredOutputs.outputs },
        ...(restoredOutputs.exportNames && { exportNames: [...restoredOutputs.exportNames] }),
      }),
      lastModified: Date.now(),
    });
    // Best-effort, mirroring `cdkd rollback`: the AWS revert already happened,
    // so a failed save is a warning, not a failed revert.
    const save = async (): Promise<void> => {
      try {
        currentEtag = await ctx.stateBackend.saveState(childStackName, region, next(), {
          ...(currentEtag !== undefined && { expectedEtag: currentEtag }),
        });
      } catch {
        try {
          const fresh = await ctx.stateBackend.getState(childStackName, region);
          currentEtag = await ctx.stateBackend.saveState(childStackName, region, next(), {
            ...(fresh?.etag !== undefined && { expectedEtag: fresh.etag }),
          });
        } catch (retryError) {
          logger.warn(
            `Failed to persist the state of nested stack ${shownChild} after reverting it: ` +
              `${errorText(retryError)}. The resources were reverted in AWS.`
          );
        }
      }
    };

    const execCtx: RollbackExecutorContext = {
      providerRegistry: ctx.providerRegistry,
      region,
      logger,
      ...(ctx.options?.eventRecorder && {
        recordEvent: (event) => ctx.options!.eventRecorder!.record(event),
      }),
      finalSnapshotClients: ctx.options?.finalSnapshotClients,
      skipFinalSnapshot:
        ctx.options?.skipFinalSnapshot === true || ctx.destroyOptions?.skipFinalSnapshot === true,
      importedProducerRegions: producerRegionsFromState(base),
    };
    // The child is the "parent" of its own rows: a grandchild row reverted by
    // this replay derives `<child>~<Grandchild>` from here. No templates — a
    // revert never deploys one.
    const childCtx: NestedStackProviderContext = {
      ...ctx,
      parentStackName: childStackName,
      parentRegion: region,
      nestedTemplates: undefined,
    };

    let failures = 0;
    for (let s = segments.length - 1; s >= 0; s--) {
      const segment = segments[s]!;
      const result = await withNestedStackContext(childCtx, () =>
        withStackName(childStackName, () =>
          withNestedRevertRun(runId, () =>
            replayRollback(segment.operations, stateResources, childStackName, execCtx, {
              afterOp: save,
              onOrphan: (record) => mintedOrphans.push(record),
            })
          )
        )
      );
      failures += result.failures;
      // Newest-first, so the OLDEST segment's snapshot is the one left
      // standing: that is the child before this run touched it.
      if (segment.previousOutputs) restoredOutputs = segment.previousOutputs;
    }
    await save();
    if (restoredOutputs && ctx.exportIndexStore) {
      await ctx.exportIndexStore.updateForStack(childStackName, region, importableOutputs(next()));
    }
    if (failures > 0) {
      refuse(`${failures} of its operation(s) failed to revert (see the warnings above).`);
    }
  } finally {
    await ctx.lockManager.releaseLock(childStackName, region).catch((error: unknown) => {
      logger.warn(`Failed to release the lock of nested stack ${shownChild}: ${errorText(error)}`);
    });
  }
}
