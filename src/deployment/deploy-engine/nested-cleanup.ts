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
import { retryDeferredReplacedDeletes, warnUnretriedReplacedDeletes } from './replacement.js';
import { retryCarriedSupersededResources } from './superseded-retry.js';

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
    // go-to-k/cdkd#2631: the ops were journaled with the FIRST failure's
    // verdict; a retry that failed differently (a waiter that gave up)
    // must not leave a later rollback re-adopting on the first one —
    // nor a retry pass that threw before returning.
    for (const op of completedOperations) {
      if (op.changeType !== 'UPDATE') continue;
      const verdict = engine.replacementRun.replacedOldMaySurvive.get(op.logicalId);
      // A retry that deleted it dropped the verdict: so does the op.
      if (verdict !== undefined) op.oldResourceMaySurvive = verdict;
      else delete op.oldResourceMaySurvive;
    }
  }
  // go-to-k/cdkd#5111: an earlier deploy's, after this deploy's own.
  await retryCarriedSupersededResources(engine, host, carried, resources, {
    waitInUse: releasedSomething,
  });
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
  const queue = getNestedCleanupQueue();
  if (queue === undefined) return false;
  return queue.enqueue({
    stackName,
    run: (context) => runQueuedNestedCleanup(engine, stackName, host, pass, context),
    abandon: (why) =>
      warnUnretriedReplacedDeletes(engine.replacementRun, engine.replacementDeps(), why),
  });
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
        safeMsg`  ⚠ Could not lock nested stack ${display} to delete its replaced resources: ${asIsMessage(describeAwsFailure(error).summary)}. They stay recorded in its state, and the next deploy deletes them`
      );
      return { updatePartial: 0 };
    }
    try {
      const fresh = await engine.stateBackend.getState(stackName, region);
      if (fresh === null || fresh === undefined) {
        engine.logger.warn(
          safeMsg`  ⚠ Nested stack ${display} has no state record any more: its replaced resources were not deleted`
        );
        return { updatePartial: 0 };
      }
      const persisted = supersededResourcesOf(fresh.state);
      const stillOwed = (entry: SupersededResourceRecord): boolean =>
        persisted.some((row) => sameSuperseded(row, entry)) &&
        !isSupersededHeld(entry, fresh.state.resources);
      const run = engine.replacementRun;
      for (const [logicalId] of run.deferredReplacedDeletes ?? []) {
        const recorded = run.supersededEntries.get(logicalId);
        if (recorded !== undefined && !stillOwed(recorded)) {
          run.deferredReplacedDeletes?.delete(logicalId);
          engine.logger.debug(
            safeMsg`Old ${logicalId} of nested stack ${display} is no longer awaiting its delete; not deleting it`
          );
        }
      }
      const before = supersededResourcesOf(host);
      const counts = { updated: 0, updatePartial: 0 };
      await pass(stillOwed, counts);
      const remaining = new Set<unknown>(
        Array.isArray(host.supersededResources) ? host.supersededResources : []
      );
      const dropped = before.filter((entry) => !remaining.has(entry));
      if (dropped.length > 0) await persistDropped(engine, stackName, fresh, dropped);
      return { updatePartial: counts.updatePartial };
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

/**
 * Remove `dropped` from the child's persisted `supersededResources`, on the
 * ETag of `fresh`; one re-read and retry on a conflict. Every other field is
 * written back as read.
 */
async function persistDropped(
  engine: DeployEngine,
  stackName: string,
  fresh: { state: StackState; etag: string },
  dropped: readonly SupersededResourceRecord[]
): Promise<void> {
  const region = engine.stackRegion;
  let current = fresh;
  for (let attempt = 0; ; attempt++) {
    const rows = current.state.supersededResources;
    if (!Array.isArray(rows)) return;
    const kept = rows.filter(
      (row) =>
        !isSupersededResourceRecord(row) || !dropped.some((entry) => sameSuperseded(row, entry))
    );
    if (kept.length === rows.length) return;
    const { supersededResources: _rows, ...rest } = current.state;
    const next: StackState = {
      ...rest,
      ...(kept.length > 0 && { supersededResources: kept }),
      lastModified: Date.now(),
    };
    try {
      // Through the persist choke point, as every engine save: the read is
      // already redacted, and redacting it again changes nothing.
      await engine.stateBackend.saveState(stackName, region, engine.withParentInfo(next), {
        expectedEtag: current.etag,
      });
      return;
    } catch (error) {
      const again =
        attempt === 0
          ? await engine.stateBackend.getState(stackName, region).catch(() => null)
          : null;
      if (again === null || again === undefined) {
        engine.logger.warn(
          safeMsg`  ⚠ Could not record in nested stack ${displayStackName(stackName)}'s state that ${dropped.length} replaced resource(s) were deleted: ${asIsMessage(describeAwsFailure(error).summary)}. Its next deploy sends their deletes again`
        );
        return;
      }
      current = again;
    }
  }
}
