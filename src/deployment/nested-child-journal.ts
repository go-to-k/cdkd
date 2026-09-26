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
import type { LockManager } from '../state/lock-manager.js';
import type { Logger } from '../types/config.js';
import type { ResourceState, StackOrphanRecord, StackState } from '../types/state.js';
import type { RollbackJournalSegment } from '../types/rollback-journal.js';
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

/** See {@link dropNestedChildJournals}: a backstop, far past any real tree. */
const MAX_NESTED_WALK_DEPTH = 32;

/** The child state key `NestedStackProvider` derives: `<parent>~<logicalId>`. */
export function nestedChildStackName(parentStackName: string, logicalId: string): string {
  return `${parentStackName}~${logicalId}`;
}

/**
 * What a nested engine journals on success beside its ops: what its record
 * PUBLISHED (`outputs` / `exportNames`) and what it READ across stacks
 * (`imports` / `outputReads`) before this deploy. The ops restore resources;
 * these restore the rest of the record, and the reads also feed the replay's
 * cross-region secret refusal (issue #2057), which would otherwise see only
 * the reads of the deploy being undone. Copied, never aliased.
 */
export function nestedPendingSnapshot(
  state: Pick<StackState, 'outputs' | 'exportNames' | 'imports' | 'outputReads'>
): Pick<RollbackJournalSegment, 'previousOutputs' | 'previousCrossStackReads'> {
  return {
    previousOutputs: {
      outputs: { ...(isPlainRecord(state.outputs) ? state.outputs : {}) },
      ...(Array.isArray(state.exportNames) && { exportNames: [...state.exportNames] }),
    },
    previousCrossStackReads: {
      ...(Array.isArray(state.imports) && { imports: [...state.imports] }),
      ...(Array.isArray(state.outputReads) && { outputReads: [...state.outputReads] }),
    },
  };
}

/**
 * The nested-stack rows a replay of `ops` reverts IN PLACE: the
 * `AWS::CloudFormation::Stack` UPDATEs. A CREATE's revert destroys the child,
 * whose journal goes with its state, and a DELETE is not restorable.
 */
export function revertedNestedRowIds(
  ops: ReadonlyArray<{ logicalId: string; resourceType: string; changeType: string }>
): string[] {
  return ops
    .filter((op) => op.resourceType === NESTED_STACK_TYPE && op.changeType === 'UPDATE')
    .map((op) => op.logicalId);
}

/**
 * The nested rows whose child replay COMPLETED in a scope — no op failed and
 * none was skipped — each mapped to the grandchildren ITS replay completed.
 * Only these have pending segments a settled rollback may drop: a row the
 * replay skipped never reached the provider, and a child replay that skipped
 * an op stays retryable.
 */
export type SettledNestedRows = Map<string, SettledNestedRows>;

/**
 * The parent run a rollback is replaying, plus what the child reverts inside
 * it reported. `runId` is `undefined` when the deploy had no event recorder;
 * a revert refuses that (a runId-less segment would match every other one).
 * The SCOPE being absent is the other case — no rollback driver bound it.
 */
export interface NestedRevertRun {
  readonly runId: string | undefined;
  /** Filled by each child revert that completed in this scope. */
  readonly settled: SettledNestedRows;
  /**
   * Ops the child replays in this scope skipped with a warning. The drivers
   * add it to their own warning count, since the executor counts a nested
   * row's `partial` outcome as a success.
   */
  warnings: number;
}

const revertRunStorage = new AsyncLocalStorage<NestedRevertRun>();

/**
 * Bind the parent run being replayed around a `replayRollback` call. `fn`
 * receives the scope, so the driver can read what the child reverts reported
 * once the replay returns.
 */
export function withNestedRevertRun<T>(
  runId: string | undefined,
  fn: (run: NestedRevertRun) => T
): T {
  const run: NestedRevertRun = { runId, settled: new Map(), warnings: 0 };
  return revertRunStorage.run(run, () => fn(run));
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
 * Delete the rollback journal of every nested descendant of `resources`, the
 * ROOT deploy having succeeded: the tree's baseline moved, exactly as a lone
 * stack's success drops its whole journal. Depth-first.
 *
 * The delete is unconditional — no load first — so a journal that no longer
 * parses (a newer `journalVersion`, a planted body) is removed too, and the
 * noncurrent-version purge `deleteRollbackJournal` carries runs even when no
 * current object is left.
 *
 * Best-effort and never throws: the deploy that calls it already succeeded,
 * and a journal left behind is inert to every parent revert (they select by
 * run) until the next successful root deploy sweeps it. Each delete takes the
 * CHILD's lock: a direct `cdkd rollback <parent>~<child>` holds only that one,
 * and a lock that cannot be taken leaves the journal for the next sweep.
 */
export async function dropNestedChildJournals(args: {
  stateBackend: S3StateBackend;
  lockManager: JournalLock;
  parentStackName: string;
  region: string;
  resources: Record<string, ResourceState> | undefined;
  logger: Pick<Logger, 'debug' | 'warn'>;
  /** Internal: how deep the walk already is. */
  depth?: number;
}): Promise<void> {
  const { stateBackend, parentStackName, region, resources, logger } = args;
  const depth = args.depth ?? 0;
  if (!isPlainRecord(resources)) return;
  if (depthExceeded(depth, parentStackName, logger)) return;
  for (const [logicalId, record] of Object.entries(resources)) {
    if (!isPlainRecord(record) || record['resourceType'] !== NESTED_STACK_TYPE) continue;
    const child = nestedChildStackName(parentStackName, logicalId);
    try {
      const data = await stateBackend.getState(child, region);
      // Recurse only into a record that IS this child's: one whose body names
      // another stack is not evidence of what `<child>` contains.
      if (
        data &&
        isPlainRecord(data.state) &&
        isPlainRecord(data.state.resources) &&
        (data.state.stackName === undefined || data.state.stackName === child)
      ) {
        await dropNestedChildJournals({
          ...args,
          parentStackName: child,
          resources: data.state.resources,
          depth: depth + 1,
        });
      }
    } catch (error) {
      warnUncleared(logger, child, error);
    }
    // Outside the state read's `try`: a child whose state.json cannot be read
    // (so its descendants cannot be walked) still has its OWN journal deleted.
    try {
      await withChildLock(args.lockManager, child, region, logger, () =>
        stateBackend.deleteRollbackJournal(child, region)
      );
      logger.debug(`Deleted the rollback journal of nested stack ${displaySafe(child)}`);
    } catch (error) {
      warnUncleared(logger, child, error);
    }
  }
}

/**
 * Drop the `nested-pending-parent` segments of run `runId` from the children
 * in `settled` — the rows whose child replay COMPLETED in the rollback being
 * settled (see {@link SettledNestedRows}) — and, recursively, from the
 * grandchildren each of those replays completed.
 *
 * Deliberately narrow. A child row the rollback did not revert (a failed
 * nested deploy is a failed row, and a skipped revert never reached the
 * provider) keeps its journal, and so does a child whose replay skipped an op.
 * Only PENDING segments go: a child's own failure segment of the same run is
 * what `cdkd rollback <parent>~<child>` (and `--revert-failed`) needs.
 *
 * Call it only once the rollback is SETTLED (its state saved, its own segment
 * popped or re-recorded), so a rollback that cannot persist still finds these
 * segments when it is re-run. A runId-less run drops nothing. Best-effort and
 * never throws; each drop takes the child's lock.
 */
export async function dropSettledNestedJournals(args: {
  stateBackend: S3StateBackend;
  lockManager: JournalLock;
  parentStackName: string;
  region: string;
  settled: SettledNestedRows;
  runId: string | undefined;
  logger: Pick<Logger, 'debug' | 'warn'>;
  /** Internal: how deep the walk already is. */
  depth?: number;
}): Promise<void> {
  const { stateBackend, parentStackName, region, runId, logger } = args;
  const depth = args.depth ?? 0;
  if (runId === undefined) return;
  if (depthExceeded(depth, parentStackName, logger)) return;
  const isSettled = (segment: RollbackJournalSegment): boolean =>
    segment.runId === runId && segment.reason === NESTED_PENDING_PARENT_REASON;
  for (const [logicalId, grandchildren] of args.settled) {
    const child = nestedChildStackName(parentStackName, logicalId);
    if (grandchildren.size > 0) {
      await dropSettledNestedJournals({
        ...args,
        parentStackName: child,
        settled: grandchildren,
        depth: depth + 1,
      });
    }
    try {
      const removed = await withChildLock(args.lockManager, child, region, logger, () =>
        stateBackend.dropRollbackJournalSegments(child, region, isSettled)
      );
      if (removed > 0) {
        logger.debug(
          `Dropped ${removed} settled rollback journal segment(s) of ${displaySafe(child)}`
        );
      }
    } catch (error) {
      warnUncleared(logger, child, error);
    }
  }
}

/** The part of `LockManager` the journal maintenance needs. */
export type JournalLock = Pick<LockManager, 'acquireLockWithRetry' | 'releaseLock'>;

/** Run `fn` holding `child`'s lock; the release never throws out. */
async function withChildLock<T>(
  lockManager: JournalLock,
  child: string,
  region: string,
  logger: Pick<Logger, 'warn'>,
  fn: () => Promise<T>
): Promise<T> {
  await lockManager.acquireLockWithRetry(child, region, undefined, 'rollback');
  try {
    return await fn();
  } finally {
    await lockManager.releaseLock(child, region).catch((error: unknown) => {
      logger.warn(
        `Failed to release the lock of nested stack ${displayIdent(child)}: ${errorText(error)}`
      );
    });
  }
}

/**
 * Every level lengthens the key (`<parent>~<id>`), so a real tree ends where a
 * child has no state. The bound is for a record that names ITSELF again (a
 * hand-edited or planted state), which would otherwise walk forever.
 */
function depthExceeded(
  depth: number,
  parentStackName: string,
  logger: Pick<Logger, 'warn'>
): boolean {
  if (depth < MAX_NESTED_WALK_DEPTH) return false;
  logger.warn(
    `Stopped clearing nested rollback journals below ${displayIdent(parentStackName)}: ` +
      `the nesting is deeper than ${MAX_NESTED_WALK_DEPTH} levels.`
  );
  return true;
}

function warnUncleared(logger: Pick<Logger, 'warn'>, child: string, error: unknown): void {
  logger.warn(
    `Could not clear the rollback journal of nested stack ${displayIdent(child)}: ${errorText(error)}. ` +
      `It is inert to every parent revert (they select segments by run) and the next ` +
      `successful deploy of the top-level stack removes it.`
  );
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
 * that did not happen, when: the run has no id; there is no child state; the
 * child journal holds no segment for the run (it was never retained — a
 * journal written by an older cdkd — or it was removed by hand); or any
 * replayed op failed. The child's outputs and reads are restored, and its
 * exports republished, only when no op failed.
 *
 * Returns how many ops the replay (grandchildren included) SKIPPED with a
 * warning. Zero registers this row in `run.settled`, so the settled rollback
 * may drop its pending segments; anything else is added to `run.warnings`
 * and the segments stay, retryable. The segments are never dropped here.
 */
export async function revertNestedChildFromJournal(args: {
  ctx: NestedStackProviderContext;
  logicalId: string;
  childStackName: string;
  region: string;
  run: NestedRevertRun;
  logger: Logger;
}): Promise<{ warnings: number }> {
  const { ctx, logicalId, childStackName, region, run, logger } = args;
  const runId = run.runId;
  const shownChild = displayIdent(childStackName);
  const refuse = (detail: string): never => {
    throw markNonRetryable(
      new Error(
        `Cannot revert nested stack ${shownChild} (row ${displayIdent(logicalId)}): ${detail} ` +
          `The child was NOT (fully) reverted and may still hold the failed deploy's configuration. ` +
          `Inspect it with 'cdkd state show'; re-run the rollback once the cause is fixed (its ` +
          `journal is kept), or re-deploy the parent to converge.`
      )
    );
  };

  // A runId-less segment matches every other runId-less one, so a run with no
  // id cannot select "the segments of this deploy".
  if (runId === undefined) {
    refuse('the rollback carries no deploy run id to select its journal segments by.');
  }

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
    // The OLDEST segment of the run that CARRIES a snapshot is the child
    // before this run touched it. Not `segments[0]` blindly: in a run where the
    // child failed and rolled itself back before a later attempt succeeded,
    // the oldest segment is its own failure segment, which carries none.
    const restoredOutputs = segments.find((s) => s.previousOutputs)?.previousOutputs;
    const restoredReads = segments.find((s) => s.previousCrossStackReads)?.previousCrossStackReads;
    let currentEtag = stateData!.etag;
    let persisted = false;
    // Off during the replay: the per-op saves record the resources only, and
    // the outputs / reads are restored only once no op has failed — otherwise
    // consumers would read the pre-run exports over resources that still hold
    // the failed deploy's configuration.
    let restoring = false;
    // `skippedOutputs` is dropped for the reason `cdkd rollback`'s own save
    // drops it: the replay can change what an output reads.
    const { skippedOutputs: _dropped, ...carried } = base;
    const next = (): StackState => ({
      ...carried,
      version: STATE_SCHEMA_VERSION_CURRENT,
      region,
      resources: { ...stateResources },
      ...orphansAfterRollback(base, mintedOrphans),
      ...(restoring && restoredOutputs && { outputs: { ...restoredOutputs.outputs } }),
      ...(restoring &&
        restoredReads && {
          ...(restoredReads.imports && { imports: [...restoredReads.imports] }),
          ...(restoredReads.outputReads && { outputReads: [...restoredReads.outputReads] }),
        }),
      ...(restoring &&
        restoredOutputs?.exportNames && { exportNames: [...restoredOutputs.exportNames] }),
      lastModified: Date.now(),
    });
    // A restored field the snapshot does NOT carry must leave the record with
    // it: outputs and `exportNames` travel together, and a read the pre-run
    // record did not hold is the undone deploy's, not the child's.
    const nextState = (): StackState => {
      const state = next();
      if (!restoring) return state;
      if (restoredOutputs && !restoredOutputs.exportNames) delete state.exportNames;
      if (restoredReads && !restoredReads.imports) delete state.imports;
      if (restoredReads && !restoredReads.outputReads) delete state.outputReads;
      return state;
    };
    // Best-effort, mirroring `cdkd rollback`: the AWS revert already happened,
    // so a failed save is a warning, not a failed revert.
    const save = async (): Promise<void> => {
      persisted = false;
      try {
        currentEtag = await ctx.stateBackend.saveState(childStackName, region, nextState(), {
          ...(currentEtag !== undefined && { expectedEtag: currentEtag }),
        });
        persisted = true;
      } catch {
        try {
          const fresh = await ctx.stateBackend.getState(childStackName, region);
          currentEtag = await ctx.stateBackend.saveState(childStackName, region, nextState(), {
            ...(fresh?.etag !== undefined && { expectedEtag: fresh.etag }),
          });
          persisted = true;
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
      // The UNION of the record and the pre-run reads: `base` was saved by the
      // deploy being undone and holds only ITS reads, while the replay restores
      // values the pre-run reads produced (issue #2057's refusal needs them).
      importedProducerRegions: producerRegionsFromState({
        imports: [...(base.imports ?? []), ...(restoredReads?.imports ?? [])],
        outputReads: [...(base.outputReads ?? []), ...(restoredReads?.outputReads ?? [])],
      }),
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
    let warnings = 0;
    // The grandchildren THIS replay completed, merged over its segments.
    const settledBelow: SettledNestedRows = new Map();
    for (let s = segments.length - 1; s >= 0; s--) {
      const segment = segments[s]!;
      const result = await withNestedStackContext(childCtx, () =>
        withStackName(childStackName, () =>
          withNestedRevertRun(runId, async (inner) => {
            const replayed = await replayRollback(
              segment.operations,
              stateResources,
              childStackName,
              execCtx,
              { afterOp: save, onOrphan: (record) => mintedOrphans.push(record) }
            );
            for (const [id, below] of inner.settled) settledBelow.set(id, below);
            return { ...replayed, warnings: replayed.warnings + inner.warnings };
          })
        )
      );
      failures += result.failures;
      warnings += result.warnings;
    }
    restoring = failures === 0;
    await save();
    // Only what was PERSISTED is published: the index must not serve outputs
    // the child's record does not hold.
    if (restoring && persisted && restoredOutputs && ctx.exportIndexStore) {
      await ctx.exportIndexStore.updateForStack(
        childStackName,
        region,
        importableOutputs(nextState())
      );
    }
    if (warnings > 0) {
      logger.warn(
        `Nested stack ${shownChild}: ${warnings} operation(s) were skipped with a warning during ` +
          `its revert (see above); they may need attention by hand.`
      );
    }
    if (failures > 0) {
      refuse(`${failures} of its operation(s) failed to revert (see the warnings above).`);
    }
    if (warnings > 0) run.warnings += warnings;
    else run.settled.set(logicalId, settledBelow);
    return { warnings };
  } finally {
    await ctx.lockManager.releaseLock(childStackName, region).catch((error: unknown) => {
      logger.warn(`Failed to release the lock of nested stack ${shownChild}: ${errorText(error)}`);
    });
  }
}
