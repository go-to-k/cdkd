/**
 * The automatic rollback's revert of what a failed UPDATE left unsettled (go-to-k/cdkd#5505).
 * Split out of `deploy-engine/rollback.ts` (go-to-k/cdkd#5835), which
 * re-exports what it exported.
 */
import type { segmentCleanupOptions } from '../../rollback-executor/replay-moved-id-cleanup.js';
import type { ResourceProvider } from '../../../types/resource.js';
import type { ResourceState } from '../../../types/state.js';
import { safeMsg } from '../../../utils/display-safe.js';
import { pasteableCommand } from '../../../utils/pasteable-command.js';
import {
  type FailedOperation,
  type OwnUnsettled,
  type RollbackExecutorContext,
  classifyFailedOp,
  replayFailedOperations,
} from '../../rollback-executor.js';
import { failedOpOwnRecord } from '../../rollback-executor/plan.js';
import {
  unsettledItemsTopKey,
  unsettledPropertiesOf,
} from '../../../state/unsettled-properties.js';
import { waitForUnsettledSettled } from '../../unsettled-convergence.js';
import { DEFAULT_UNSETTLED_REVERT_WAIT } from '../options.js';
import { RollbackInlinePolicyWriters } from '../../inline-policy-claims.js';
import { withPrintingSecrets } from '../../resource-secrets-scope.js';
import type { RollbackDeps } from './deps.js';
import { replayPrintingBag } from './printing-bag.js';

/** go-to-k/cdkd#5505: what the engine lends the unsettled revert. */
export interface UnsettledRevertHooks {
  /**
   * The names and items THIS run's failed update marked for `logicalId` (its
   * accepted calls), never a name an earlier deploy left on the record.
   */
  runMarks: (logicalId: string) => {
    names: ReadonlySet<string>;
    items: ReadonlyMap<string, ReadonlySet<string>>;
  };
  /**
   * The failed update's own call, still running when the deadline abandoned
   * it; resolves whether it then succeeded.
   */
  stillRunning: (logicalId: string) => Promise<boolean> | undefined;
  /** Put the engine's pending marks for `logicalId` on its record (a late mark). */
  recordMarks: (logicalId: string) => void;
  /** The names a handled revert converged: no longer pending engine marks. */
  onReverted: (logicalId: string, settled: ReadonlySet<string>) => void;
}

/** A wait bound as the warning quotes it. */
function waitText(ms: number): string {
  return ms >= 60_000 ? `${Math.round(ms / 60_000)} min` : `${Math.max(1, Math.round(ms / 1000))}s`;
}

type RevertVerdict = 'settled' | 'moving' | 'interrupted' | 'call-running' | 'error' | 'none';

/**
 * go-to-k/cdkd#5505: the automatic rollback's revert of what THIS run's
 * failed UPDATEs left unsettled, as CloudFormation rolls a failed update back.
 * A failed UPDATE that `--revert-failed` would force-revert
 * (`revert-failed-update`) is considered when this run's accepted calls marked
 * a key (`runMarks`), or when its call the deadline abandoned is still
 * running (it may mark later, or complete). A name an earlier failed deploy
 * left on the record is never reverted or acted on here: the user may have
 * declined that rollback (`--no-rollback`), so it stays for the next deploy's
 * convergence or `--revert-failed`. Any other failed op stays opt-in.
 *
 * Each waits (bounded, interruptible) for that abandoned call to return and
 * for its keys to stop moving, then goes through the `--revert-failed` arm
 * with the record as the previous side (`previousFromRecord`): only this
 * run's keys converge from AWS, and only an item its accepted calls added
 * (`unsettledItems`) and the restored bag does not declare is removed. The
 * arm's own post-check (`withUnprovenUnsettled`) clears a name only on proof.
 *
 * A key still moving at the bound, a call that has not returned, or a revert
 * that fails or is skipped keeps the record's names and the journal entry,
 * with a warning: the next deploy converges it, or `cdkd rollback
 * --revert-failed` retries it. None is counted as a rollback failure: the
 * failed update was not reverted before this change either.
 *
 * @internal Exported for its unit tests.
 */
export async function revertUnsettledFailedUpdates(
  deps: RollbackDeps,
  ctx: RollbackExecutorContext,
  stackName: string,
  stateResources: Record<string, ResourceState>,
  failedOperations: readonly FailedOperation[],
  alreadyReplayed: ReadonlySet<number>,
  options: {
    emitEnvelope: boolean;
    inlinePolicyWriters: RollbackInlinePolicyWriters;
    hooks: UnsettledRevertHooks | undefined;
    /**
     * go-to-k/cdkd#6120: the rollback's superseded writers and the queue it
     * shares with its completed-op replay, which deletes an id this revert's
     * `update()` moved off (an abandoned custom-resource Update that answered
     * a new id) only after that replay's last op.
     */
    cleanup?: Partial<ReturnType<typeof segmentCleanupOptions>>;
  }
): Promise<{ handled: number[]; warnings: number; interrupted: boolean }> {
  const out = { handled: [] as number[], warnings: 0, interrupted: false };
  const hooks = options.hooks;
  if (hooks === undefined) return out;
  // This run's marks, as far as the record carries them.
  const ownMarks = (logicalId: string): OwnUnsettled => {
    const onRecord = unsettledPropertiesOf(stateResources[logicalId]);
    const marks = hooks.runMarks(logicalId);
    const names = new Set([...marks.names].filter((name) => onRecord.has(name)));
    const items = new Map(
      [...marks.items].filter(([path]) => names.has(unsettledItemsTopKey(path)))
    );
    return { names, items, lateSuccess: false };
  };
  const candidates: Array<{
    index: number;
    op: FailedOperation;
    own: OwnUnsettled;
    running: Promise<boolean> | undefined;
  }> = [];
  failedOperations.forEach((op, index) => {
    if (alreadyReplayed.has(index) || op.changeType !== 'UPDATE') return;
    if (failedOpOwnRecord(op, stateResources) === undefined) return;
    const own = ownMarks(op.logicalId);
    const running = hooks.stillRunning(op.logicalId);
    if (own.names.size === 0 && running === undefined) return;
    if (classifyFailedOp(op, stateResources, [...failedOperations]) !== 'revert-failed-update') {
      return;
    }
    candidates.push({ index, op, own, running });
  });
  if (candidates.length === 0) return out;

  const { logger } = deps;
  const isInterrupted = (): boolean => deps.userInterrupted();
  const fallback = (names: ReadonlySet<string>): string => {
    const one = names.size === 1;
    const retry =
      deps.options.parentStackInfo === undefined
        ? `, or revert ${one ? 'it' : 'them'} now with: ${
            pasteableCommand('cdkd rollback', [
              { value: stackName, hole: 'stack' },
              { literal: '--revert-failed' },
            ]).command
          }`
        : '';
    return `cdkd keeps ${one ? 'it' : 'them'} unsettled: the next deploy converges ${one ? 'it' : 'them'}${retry}`;
  };
  const wait = deps.options.unsettledRevertWait ?? DEFAULT_UNSETTLED_REVERT_WAIT;
  const verdicts = await Promise.all(
    candidates.map(async (candidate): Promise<RevertVerdict> => {
      const { op } = candidate;
      let provider: ResourceProvider;
      try {
        provider = ctx.providerRegistry.getProviderFor({
          resourceType: op.resourceType,
          provisionedBy: op.provisionedBy ?? stateResources[op.logicalId]!.provisionedBy,
        }).provider;
      } catch {
        return 'error';
      }
      logger.info(
        safeMsg`  Rollback: waiting for ${op.logicalId} (${op.resourceType}) to settle before reverting the failed update`
      );
      const started = Date.now();
      const identity = (): Parameters<typeof waitForUnsettledSettled>[0] => {
        const record = stateResources[op.logicalId]!;
        return {
          provider,
          logicalId: op.logicalId,
          physicalId: record.physicalId,
          resourceType: op.resourceType,
          recordedProperties: record.properties ?? {},
          names: candidate.own.names,
          timeoutMs: Math.max(0, wait.timeoutMs - (Date.now() - started)),
          pollMs: wait.pollMs,
          isInterrupted,
        };
      };
      // First the failed update's own call, if the deadline abandoned it: it
      // may still write, mark what it is about to change, or complete.
      if (candidate.running !== undefined) {
        let succeeded = false;
        const returned = await waitForUnsettledSettled({
          ...identity(),
          names: new Set(),
          running: candidate.running.then((ok) => {
            succeeded = ok;
          }),
        });
        if (returned === 'moving') return 'call-running';
        if (returned === 'interrupted') return returned;
        hooks.recordMarks(op.logicalId);
        candidate.own = { ...ownMarks(op.logicalId), lateSuccess: succeeded };
        // Failed without marking anything: there is nothing of this run's to undo.
        if (!succeeded && candidate.own.names.size === 0) return 'none';
      }
      try {
        return await waitForUnsettledSettled(identity());
      } catch {
        return 'error';
      }
    })
  );
  const ready: typeof candidates = [];
  candidates.forEach((candidate, k) => {
    const verdict = verdicts[k];
    if (verdict === 'settled') {
      ready.push(candidate);
      return;
    }
    if (verdict === 'none') return;
    if (verdict === 'interrupted') {
      out.interrupted = true;
      return;
    }
    const { op } = candidate;
    const names = candidate.own.names;
    const them = names.size === 1 ? 'it' : 'them';
    const subject =
      names.size > 0
        ? `the failed update left ${[...names].join(', ')} unsettled`
        : 'the failed update may have applied part of the template';
    const why =
      verdict === 'call-running'
        ? `cdkd's own update call, abandoned at the per-resource deadline, had not returned after ${waitText(wait.timeoutMs)}`
        : verdict === 'error'
          ? 'cdkd could not reach its provider to wait for it'
          : `AWS had not settled ${them} after ${waitText(wait.timeoutMs)}`;
    logger.warn(
      safeMsg`${op.logicalId} (${op.resourceType}): ${subject}, and ${why}, so the automatic rollback did not revert ${names.size > 0 ? them : 'it'}. ${fallback(names)}`
    );
    out.warnings++;
  });
  if (ready.length === 0 || out.interrupted) return out;

  // Copies, as for the orphans above: the journal records the originals.
  const ops = ready.map(({ op }) => ({ ...op }));
  const own = new Map(ready.map(({ op, own: marks }) => [op.logicalId, marks]));
  const replay = await withPrintingSecrets(
    replayPrintingBag(
      deps,
      ops.map((op) => ({ ...op, properties: op.attemptedProperties })),
      stateResources
    ),
    () =>
      replayFailedOperations(ops, stateResources, stackName, ctx, {
        emitEnvelope: options.emitEnvelope,
        inlinePolicyWriters: options.inlinePolicyWriters,
        isInterrupted,
        previousFromRecord: own,
        ...options.cleanup,
      })
  );
  // The arm's own lines already said why an op failed or was skipped.
  out.warnings += replay.warnings + replay.failures;
  if (replay.interrupted) out.interrupted = true;
  const pending = new Set(replay.remainingFailedOps);
  const skipped = new Set(replay.skippedOps ?? []);
  // go-to-k/cdkd#6106: such a skip printed its own remedy; no retry advice.
  const deletedOutside = new Set(replay.deletedOutsideOps ?? []);
  ops.forEach((op, k) => {
    const { index, own: marks } = ready[k]!;
    if (pending.has(op) || skipped.has(op)) {
      if (!replay.interrupted && !deletedOutside.has(op)) {
        logger.warn(
          safeMsg`${op.logicalId} (${op.resourceType}): the automatic rollback could not revert ${marks.names.size > 0 ? `what the failed update left unsettled (${[...marks.names].join(', ')})` : 'the failed update'} (see above). ${fallback(marks.names)}`
        );
      }
      return;
    }
    out.handled.push(index);
    // Every name it handed the arm: the record now says what is left (a name
    // its proof kept, an earlier deploy's), so the engine's copy must not
    // re-add this run's items under a name the record keeps for another cause.
    hooks.onReverted(op.logicalId, marks.names);
  });
  return out;
}
