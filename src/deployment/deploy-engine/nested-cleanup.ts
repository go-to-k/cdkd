import { AsyncLocalStorage } from 'node:async_hooks';
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
  type NestedCleanupQueue,
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
import { carriedNotHeldByConsumers, markHeldForConsumers } from './consumer-held-superseded.js';
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
  // go-to-k/cdkd#5111: an earlier deploy's, after this deploy's own; one a
  // consumer still names stays (go-to-k/cdkd#7017).
  const sendable = await carriedNotHeldByConsumers(engine, stackName, carried, resources);
  await retryCarriedSupersededResources(engine, host, sendable, resources, {
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
 * The cleanup hand-offs of a deploy whose creates, updates and outputs all
 * landed; answers whether this engine's own pass was queued (the caller runs
 * it otherwise).
 *
 * go-to-k/cdkd#6398: the ROOT runs its descendants' queued passes first, in
 * the order they finished, then its own: a child's old resource goes before
 * the parent's old resource it used (an old instance before the old subnet a
 * parameter handed it), dependents first as within a stack. A nested child's
 * own pass waits for the ROOT deploy's success instead.
 *
 * go-to-k/cdkd#7012: a root given a `consumerCleanupQueue` (a producer whose
 * outputs a later stack of the same `cdkd deploy` run imports) hands both to
 * that queue, children first, and the CLI runs it once every such stack
 * deployed. Deleting now would leave a consumer that fails and rolls back
 * naming a deleted resource. CloudFormation never gets here (it refuses to
 * update an export while another stack imports it); cdkd lets the run change
 * it (go-to-k/cdkd#6088), so it keeps the old copy until the consumers are
 * done. A deploy with nothing to delete queues nothing and pays nothing.
 */
export async function runOrQueueCleanups(
  engine: DeployEngine,
  stackName: string,
  host: Pick<StackState, 'supersededResources'>,
  nestedCleanups: NestedCleanupQueue | undefined,
  actualCounts: { updatePartial: number; nestedUpdatePartial: number },
  pass: Parameters<typeof queueNestedCleanup>[3]
): Promise<boolean> {
  const held =
    engine.options.parentStackInfo === undefined ? engine.options.consumerCleanupQueue : undefined;
  if (nestedCleanups !== undefined && held !== undefined && nestedCleanups.size > 0) {
    nestedCleanups.drainInto(held);
  } else if (nestedCleanups !== undefined) {
    const { updatePartial, nestedUpdatePartial } = await nestedCleanups.runAll(
      { interrupted: () => engine.interrupted },
      engine.logger
    );
    actualCounts.updatePartial += updatePartial;
    actualCounts.nestedUpdatePartial += nestedUpdatePartial;
  }
  return queueNestedCleanup(engine, stackName, host, pass);
}

/**
 * go-to-k/cdkd#6398: a NESTED child engine's cleanup phase waits for the
 * ROOT deploy's success, as CloudFormation runs a nested stack's cleanup at
 * the end of the whole stack tree's update. Queues `pass` on the root's
 * queue and answers `true`; `false` (the caller runs the pass itself) for a
 * root engine (one with a `consumerCleanupQueue` queues into it instead,
 * go-to-k/cdkd#7012), with no root engine on the stack, or once the root
 * drained or abandoned its queue.
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
  const nested = engine.options.parentStackInfo !== undefined;
  // go-to-k/cdkd#7012: a ROOT engine queues only into its producer hold.
  if (!nested && engine.options.consumerCleanupQueue === undefined) return false;
  // Nothing to delete: no queue entry, so a deploy whose children replaced
  // nothing pays no lock round-trip or state read per child at the root.
  if (
    (engine.replacementRun.deferredReplacedDeletes?.size ?? 0) === 0 &&
    supersededResourcesOf(host).length === 0
  ) {
    return false;
  }
  const queue = nested ? getNestedCleanupQueue() : engine.options.consumerCleanupQueue;
  if (queue === undefined) return false;
  // go-to-k/cdkd#7012: a producer's pass runs after its deploy returned, in
  // the async context its own cleanup phase would have run in (the stack's
  // name scope, AWS clients and producer regions). A child's runs in the
  // root's, as before.
  const inDeployScope = nested ? undefined : AsyncLocalStorage.snapshot();
  // go-to-k/cdkd#7017: the producer's entries say they wait for consumers,
  // so a later deploy of it alone keeps one a consumer still names.
  if (!nested) markHeldForConsumers(host);
  const runPass = (context: NestedCleanupContext): Promise<NestedCleanupOutcome> =>
    runQueuedNestedCleanup(engine, stackName, host, pass, context);
  return queue.enqueue({
    stackName,
    ...(!nested && { producer: true as const }),
    run: (context) =>
      inDeployScope === undefined ? runPass(context) : inDeployScope(() => runPass(context)),
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
  // go-to-k/cdkd#7012: a held producer's pass runs this too, as a top-level stack.
  const kind = engine.options.parentStackInfo === undefined ? 'stack' : 'nested stack';
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
        safeMsg`  ⚠ Could not lock ${kind} ${display} to delete its replaced resources: ${asIsMessage(describeAwsFailure(error).summary)}`
      );
      return passCouldNotRun(engine);
    }
    try {
      let fresh: Awaited<ReturnType<DeployEngine['stateBackend']['getState']>>;
      try {
        fresh = await engine.stateBackend.getState(stackName, region);
      } catch (error) {
        engine.logger.warn(
          safeMsg`  ⚠ Could not read the state of ${kind} ${display} to delete its replaced resources: ${asIsMessage(describeAwsFailure(error).summary)}`
        );
        return passCouldNotRun(engine);
      }
      if (fresh === null || fresh === undefined) {
        engine.logger.warn(
          safeMsg`  ⚠ The ${kind} ${display} has no state record any more: its replaced resources were not deleted`
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
            safeMsg`Old ${logicalId} of ${kind} ${display} is no longer awaiting its delete; not deleting it`
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
            safeMsg`  ⚠ Old ${logicalId} of ${kind} ${display} (${displayPhysicalId(entry.resourceType, entry.physicalId)}) was not deleted: a record of that stack names its physical id again, and cdkd never deletes an id a record names`
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
          safeMsg`Failed to release the lock of ${kind} ${display}: ${asIsMessage(describeAwsFailure(error).detail)}`
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
        safeMsg`  ⚠ Could not record in the state of ${engine.options.parentStackInfo === undefined ? 'stack' : 'nested stack'} ${displayStackName(stackName)} (region ${region}) that these replaced resources were deleted: ${ids}: ${asIsMessage(describeAwsFailure(failure).summary)}. They stay listed there, and its next deploy sends their deletes again`
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
