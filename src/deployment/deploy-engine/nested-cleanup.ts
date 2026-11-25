import { displayPhysicalId } from '../../provisioning/secret-physical-id.js';
import { stackInstanceIdCarriedFrom } from '../../types/state/helpers.js';
import type { DeployEngine } from '../deploy-engine.js';
import type { CompletedOperation } from '../rollback-executor.js';
import type { ResourceState, StackState, SupersededResourceRecord } from '../../types/state.js';
import { describeAwsFailure } from '../../utils/aws-failure-text.js';
import { asIsMessage, displayStackName, safeMsg } from '../../utils/display-safe.js';
import {
  type NestedCleanupContext,
  type NestedCleanupOutcome,
  getNestedCleanupQueue,
} from '../nested-cleanup-scope.js';
import {
  isSupersededHeld,
  isSupersededResourceRecord,
  supersededResourcesOf,
} from '../superseded-resources.js';
import {
  deleteDeferredUsersOfRemovals,
  retryDeferredReplacedDeletes,
  warnUnretriedReplacedDeletes,
} from './replacement.js';
import { recordedDependencies } from './dependencies.js';
import { retryCarriedSupersededResources } from './superseded-retry.js';
import { isConditionFailure } from '../../state/s3-state-backend/shared.js';

/**
 * A deploy's cleanup phase, after its creates, updates and deletes: the
 * replaced resources' deferred deletes (go-to-k/cdkd#4900, #6374), then the
 * ones an earlier deploy recorded (go-to-k/cdkd#5111).
 */
export async function runCleanupPhase(
  engine: DeployEngine,
  {
    stackName,
    counts,
    completedOperations,
    host,
    carried,
    resources,
    releasedSomething,
  }: {
    stackName: string;
    counts: { updated: number; updatePartial: number };
    completedOperations: CompletedOperation[];
    host: Pick<StackState, 'supersededResources'>;
    carried: readonly SupersededResourceRecord[];
    resources: Record<string, ResourceState>;
    /** go-to-k/cdkd#5111: whether a carried delete waits out an "in use" refusal. */
    releasedSomething: boolean;
  }
): Promise<void> {
  try {
    await retryDeferredReplacedDeletes(
      engine.replacementRun,
      engine.replacementDeps(),
      stackName,
      counts
    );
  } finally {
    restampReplacedVerdicts(engine, completedOperations);
  }
  // go-to-k/cdkd#5111: an earlier deploy's, after this deploy's own.
  await retryCarriedSupersededResources(engine, host, carried, resources, {
    waitInUse: releasedSomething,
  });
}

/**
 * go-to-k/cdkd#6977: before the deploy's removal deletes, the deferred old
 * copies that still use a removed resource, dependents first
 * (`deleteDeferredUsersOfRemovals`). Their ops are re-stamped at once: a
 * later failure's rollback must re-create an old copy deleted here, never
 * re-adopt it on the journaled `'deferred'` verdict.
 */
export async function deleteUsersOfRemovalsFirst(
  engine: DeployEngine,
  stackName: string,
  counts: { updated: number; updatePartial: number },
  removedIds: ReadonlySet<string>,
  currentState: StackState,
  completedOperations: CompletedOperation[]
): Promise<void> {
  try {
    await deleteDeferredUsersOfRemovals(
      engine.replacementRun,
      engine.replacementDeps(),
      stackName,
      counts,
      removedIds,
      recordedDependencies(currentState.resources)
    );
  } finally {
    restampReplacedVerdicts(engine, completedOperations);
  }
}

/**
 * go-to-k/cdkd#2631: the ops were journaled with the FIRST failure's verdict;
 * a retry that failed differently (a waiter that gave up) must not leave a
 * later rollback re-adopting on the first one — nor a retry pass that threw
 * before returning, nor an old copy deleted before the removals
 * (go-to-k/cdkd#6977) that a later failure's rollback would re-adopt.
 */
export function restampReplacedVerdicts(
  engine: DeployEngine,
  completedOperations: CompletedOperation[]
): void {
  for (const op of completedOperations) {
    if (op.changeType !== 'UPDATE') continue;
    const verdict = engine.replacementRun.replacedOldMaySurvive.get(op.logicalId);
    // A retry that deleted it dropped the verdict: so does the op.
    if (verdict !== undefined) op.oldResourceMaySurvive = verdict;
    else delete op.oldResourceMaySurvive;
    // go-to-k/cdkd#6621: the generation rides only beside `'deferred'`.
    if (verdict !== 'deferred') delete op.oldResourceIdentity;
  }
}

/**
 * go-to-k/cdkd#6398: a NESTED child engine's cleanup phase waits for the
 * ROOT deploy's success, as CloudFormation runs a nested stack's cleanup at
 * the end of the whole stack tree's update. Queues `pass` on the root's
 * queue and answers `true`; `false` (the caller runs the pass itself) for a
 * root engine, with no root engine on the stack, or once the root drained or
 * abandoned its queue.
 *
 * The child's state was already saved with every superseded entry still
 * listed, and its journal segment with each deferred op's `'deferred'`
 * verdict, so a root that fails never sends these deletes: its rollback
 * reverts the child from that journal and takes the old resources back.
 *
 * `pass` receives `stillOwed`: whether a recorded entry is still listed in
 * the child's persisted state and held by none of its records. The deferred
 * deletes of entries it rejects are dropped before `pass` runs.
 */
export function queueNestedCleanup(
  engine: DeployEngine,
  stackName: string,
  host: Pick<StackState, 'supersededResources'>,
  pass: (
    stillOwed: (entry: SupersededResourceRecord) => boolean,
    counts: { updated: number; updatePartial: number }
  ) => Promise<void>
): boolean {
  if (engine.options.parentStackInfo === undefined) return false;
  // Nothing to delete: no queue entry, so a deploy whose children replaced
  // nothing pays no lock round-trip or state read per child at the root.
  if (
    (engine.replacementRun.deferredReplacedDeletes?.size ?? 0) === 0 &&
    supersededResourcesOf(host).length === 0
  ) {
    return false;
  }
  const queue = getNestedCleanupQueue();
  if (queue === undefined) return false;
  return queue.enqueue({
    stackName,
    run: (context) => runQueuedNestedCleanup(engine, stackName, host, pass, context),
    abandon: (why) =>
      warnUnretriedReplacedDeletes(engine.replacementRun, engine.replacementDeps(), why),
    fail: () => passCouldNotRun(engine),
  });
}

/**
 * A queued pass that could not run although the root succeeded: every
 * deferred delete it left warns, and counts as a partial update (exit 2).
 * The carried entries stay recorded in the child's state, retried by its next
 * deploy.
 */
function passCouldNotRun(engine: DeployEngine): NestedCleanupOutcome {
  const left = engine.replacementRun.deferredReplacedDeletes?.size ?? 0;
  warnUnretriedReplacedDeletes(engine.replacementRun, engine.replacementDeps(), 'cleanup-failed');
  return { updatePartial: left };
}

/**
 * Runs a queued child pass from the root: under the CHILD's stack lock (the
 * child's deploy released it), against a fresh read of the child's state, and
 * writes back the drop of every superseded entry the pass removed — a
 * conditional write on the read's ETag, removing only those entries. An entry
 * left listed after its resource is gone would have a later run send a delete
 * for a name someone else may hold by then.
 */
async function runQueuedNestedCleanup(
  engine: DeployEngine,
  stackName: string,
  host: Pick<StackState, 'supersededResources'>,
  pass: Parameters<typeof queueNestedCleanup>[3],
  context: NestedCleanupContext
): Promise<NestedCleanupOutcome> {
  const region = engine.stackRegion;
  const display = displayStackName(stackName);
  // The child's own SIGINT handler went with its deploy: the root's flag
  // seeds it, and a Ctrl-C during the pass stops it as it would the root's.
  const onSigint = (): void => {
    engine.interrupted = true;
    engine.interruptCause ??= 'user';
    engine.userInterrupted = true;
  };
  if (context.interrupted()) onSigint();
  process.on('SIGINT', onSigint);
  try {
    try {
      await engine.lockManager.acquireLockWithRetry(stackName, region, undefined, 'deploy');
    } catch (error) {
      engine.logger.warn(
        safeMsg`  ⚠ Could not lock nested stack ${display} to delete its replaced resources: ${asIsMessage(describeAwsFailure(error).summary)}`
      );
      return passCouldNotRun(engine);
    }
    try {
      let fresh: Awaited<ReturnType<DeployEngine['stateBackend']['getState']>>;
      try {
        fresh = await engine.stateBackend.getState(stackName, region);
      } catch (error) {
        engine.logger.warn(
          safeMsg`  ⚠ Could not read the state of nested stack ${display} to delete its replaced resources: ${asIsMessage(describeAwsFailure(error).summary)}`
        );
        return passCouldNotRun(engine);
      }
      if (fresh === null || fresh === undefined) {
        engine.logger.warn(
          safeMsg`  ⚠ Nested stack ${display} has no state record any more: its replaced resources were not deleted`
        );
        return passCouldNotRun(engine);
      }
      const read = fresh;
      const persisted = supersededResourcesOf(fresh.state);
      const stillOwed = (entry: SupersededResourceRecord): boolean =>
        persisted.some((row) => sameSuperseded(row, entry)) &&
        !isSupersededHeld(entry, read.state.resources);
      const run = engine.replacementRun;
      for (const [logicalId, entry] of run.deferredReplacedDeletes ?? []) {
        const recorded = run.supersededEntries.get(logicalId);
        if (recorded !== undefined && !stillOwed(recorded)) {
          run.deferredReplacedDeletes?.delete(logicalId);
          engine.logger.debug(
            safeMsg`Old ${logicalId} of nested stack ${display} is no longer awaiting its delete; not deleting it`
          );
        } else if (
          recorded === undefined &&
          Object.values(read.state.resources).some(
            (record) =>
              typeof record === 'object' &&
              record !== null &&
              record.physicalId === entry.physicalId &&
              record.resourceType === entry.resourceType
          )
        ) {
          // go-to-k/cdkd#6445: an in-memory deferral has no superseded entry for
          // the re-read to vouch for, and the child's lock was released since
          // its deploy. A record of the child's own type naming the id now (a
          // rollback or another deploy took it back) is a live resource: never
          // deleted. A record of another type naming the same string (a queue
          // policy recorded under the queue URL, or a role and a function both
          // named `foo`) was deferred with it (go-to-k/cdkd#6712) and does not
          // hold it, as the top-level cleanup pass never asks.
          run.deferredReplacedDeletes?.delete(logicalId);
          engine.logger.warn(
            safeMsg`  ⚠ Old ${logicalId} of nested stack ${display} (${displayPhysicalId(entry.resourceType, entry.physicalId)}) was not deleted: a record of that stack names its physical id again, and cdkd never deletes an id a record names`
          );
        }
      }
      const before = supersededResourcesOf(host);
      const counts = { updated: 0, updatePartial: 0 };
      await pass(stillOwed, counts);
      // By key, not identity: a delete whose owed snapshot was taken before it
      // failed swaps its row for one owing none (go-to-k/cdkd#6463), which is
      // kept, and written back so the child's next deploy takes no second.
      const after = supersededResourcesOf(host);
      const dropped = before.filter((entry) => !after.some((row) => sameSuperseded(row, entry)));
      const replaced = after.filter(
        (row) => !before.includes(row) && before.some((entry) => sameSuperseded(row, entry))
      );
      const unrecorded =
        dropped.length > 0 || replaced.length > 0
          ? await persistDropped(engine, stackName, read, dropped, replaced)
          : 0;
      return { updatePartial: counts.updatePartial + unrecorded };
    } finally {
      try {
        await engine.lockManager.releaseLock(stackName, region);
      } catch (error) {
        engine.logger.warn(
          safeMsg`Failed to release the lock of nested stack ${display}: ${asIsMessage(describeAwsFailure(error).detail)}`
        );
      }
    }
  } finally {
    process.removeListener('SIGINT', onSigint);
  }
}

function sameSuperseded(row: SupersededResourceRecord, entry: SupersededResourceRecord): boolean {
  return (
    row.logicalId === entry.logicalId &&
    row.state.physicalId === entry.state.physicalId &&
    row.state.resourceType === entry.state.resourceType
  );
}

/** Conditional writes `persistDropped` makes before it gives up on conflicts. */
export const PERSIST_DROPPED_ATTEMPTS = 4;

/**
 * Remove `dropped` from the child's persisted `supersededResources`, on the
 * ETag of `fresh`; on a conflict it re-reads and re-filters, up to
 * {@link PERSIST_DROPPED_ATTEMPTS} writes in all. Every other field is written
 * back as read. Answers how many deleted entries it could NOT drop: they stay
 * listed, and the child's next deploy sends their deletes again, so each
 * counts as a partial update.
 */
async function persistDropped(
  engine: DeployEngine,
  stackName: string,
  fresh: { state: StackState; etag: string },
  dropped: readonly SupersededResourceRecord[],
  /** go-to-k/cdkd#6463: rows whose owed snapshot was taken; the persisted row of the same key drops its mark. */
  replaced: readonly SupersededResourceRecord[] = []
): Promise<number> {
  const region = engine.stackRegion;
  let current = fresh;
  for (let attempt = 1; ; attempt++) {
    const rows = current.state.supersededResources;
    if (!Array.isArray(rows)) return 0;
    let changed = false;
    const kept = rows
      .filter(
        (row) =>
          !isSupersededResourceRecord(row) || !dropped.some((entry) => sameSuperseded(row, entry))
      )
      .map((row) => {
        if (!isSupersededResourceRecord(row)) return row;
        // Only the owed-snapshot mark goes: the persisted row stays as read.
        const replacement = replaced.find((entry) => sameSuperseded(row, entry));
        if (
          replacement === undefined ||
          replacement.finalSnapshotIdentifier !== undefined ||
          row.finalSnapshotIdentifier === undefined
        ) {
          return row;
        }
        changed = true;
        const { finalSnapshotIdentifier: _taken, ...rest } = row;
        return rest;
      });
    if (kept.length === rows.length && !changed) return 0;
    const { supersededResources: _rows, ...rest } = current.state;
    const next: StackState = {
      ...rest,
      ...stackInstanceIdCarriedFrom(rest),
      ...(kept.length > 0 && { supersededResources: kept }),
      lastModified: Date.now(),
    };
    let failure: unknown;
    try {
      // Through the persist choke point, as every engine save: the read is
      // already redacted, and redacting it again changes nothing.
      await engine.stateBackend.saveState(stackName, region, engine.withParentInfo(next), {
        expectedEtag: current.etag,
      });
      return 0;
    } catch (error) {
      failure = error;
    }
    const again =
      attempt < PERSIST_DROPPED_ATTEMPTS && isEtagConflict(failure)
        ? await engine.stateBackend.getState(stackName, region).catch(() => null)
        : null;
    if (again === null || again === undefined) {
      const ids = dropped
        .map(
          (entry) =>
            `${entry.logicalId} (${displayPhysicalId(entry.state.resourceType, entry.state.physicalId)})`
        )
        .join(', ');
      engine.logger.warn(
        safeMsg`  ⚠ Could not record in the state of nested stack ${displayStackName(stackName)} (region ${region}) that these replaced resources were deleted: ${ids}: ${asIsMessage(describeAwsFailure(failure).summary)}. They stay listed there, and its next deploy sends their deletes again`
      );
      return dropped.length;
    }
    current = again;
  }
}

/** A conditional write that lost, as `saveState` reports it (wrapped, with the S3 error as cause). */
function isEtagConflict(error: unknown): boolean {
  for (let link = error, depth = 0; link !== undefined && link !== null && depth < 5; depth++) {
    if (isConditionFailure(link)) return true;
    link = (link as { cause?: unknown }).cause;
  }
  return false;
}
