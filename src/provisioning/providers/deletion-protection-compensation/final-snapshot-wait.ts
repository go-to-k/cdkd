/**
 * The final-snapshot wait after a `--remove-protection` flip (issues #5155 /
 * #5184), split out of `deletion-protection-compensation.ts` (#5835), which
 * re-exports every symbol here.
 */

import { safeMsg } from '../../../utils/display-safe.js';
import type { Logger } from '../../../types/config.js';

/**
 * Issue #5155: how long a delete that takes a final snapshot waits, after a
 * `--remove-protection` flip, for the resource to return to `available`.
 */
export const FINAL_SNAPSHOT_SETTLE_WAIT_MS = 15 * 60_000;

/** Issue #5155: budget kept back from the wait for the delete call and the compensation. */
export const FINAL_SNAPSHOT_COMPENSATION_MARGIN_MS = 60_000;

/**
 * Issue #5184: how long, in slept time, the final-snapshot wait gives the flip
 * to show `modifying` before it trusts a settled read without it.
 */
export const FLIP_TRANSITION_GRACE_MS = 30_000;

/** One readback of an RDS-family cluster or instance during the final-snapshot wait. */
export interface FlipSettleReading {
  readonly deletionProtection: boolean | undefined;
  readonly status: string | undefined;
}

/** What the final-snapshot wait needs from an RDS-family provider. */
export interface FlipSettleOptions {
  /** The resource kind the user-facing messages name. */
  readonly noun: 'cluster' | 'instance';
  /** The debug-line label, e.g. `DocDB DBCluster`. */
  readonly label: string;
  readonly logicalId: string;
  /**
   * One readback. A resource that is gone normally surfaces as the describe's
   * `DB*NotFoundFault`, which propagates to the provider's delete catch and
   * its not-found check (the delete is then done); `undefined`, an empty
   * describe answer, is a defensive branch only.
   */
  readonly read: () => Promise<FlipSettleReading | undefined>;
  readonly sleep: (ms: number) => Promise<void>;
  readonly logger: Logger;
  readonly remainingMs: number;
  readonly maxWaitMs?: number;
}

/**
 * The wait's budget: the 15-minute cap, or what the engine's per-resource
 * deadline leaves minus a margin for the delete call and the compensation,
 * whichever is less. The deadline does not cancel this wait, so a wait that
 * outlived it would leave the guard down with nothing left to put it back
 * (known narrowing 2 above). No budget at all refuses before any read.
 */
function finalSnapshotWaitBudgetMs(opts: FlipSettleOptions): number {
  const budgetMs = Math.min(
    opts.maxWaitMs ?? FINAL_SNAPSHOT_SETTLE_WAIT_MS,
    opts.remainingMs - FINAL_SNAPSHOT_COMPENSATION_MARGIN_MS
  );
  if (budgetMs <= 0) {
    throw new Error(
      `--remove-protection turned DeletionProtection off, but the resource timeout leaves no time to wait for the ${opts.noun} to return to 'available', which the final snapshot its DeletionPolicy asks for needs. The delete was not sent and the guard is put back; re-run the destroy with a longer --resource-timeout`
    );
  }
  return budgetMs;
}

/**
 * Issue #5184: RDS-family statuses no wait outlasts, because they end only
 * through someone's action or not at all. Every other status that is not
 * `available` is TRANSITIONAL (`modifying`, `configuring-*`, `backing-up`,
 * `upgrading`, `maintenance`, ...) and is waited out within the budget. A deny
 * list, so a status AWS adds later waits rather than fails.
 */
const TERMINAL_DB_STATUSES: ReadonlySet<string> = new Set([
  'deleting',
  'failed',
  'stopped',
  'storage-full',
  'insufficient-capacity',
  'restore-error',
]);

/**
 * Issue #5184: statuses the RDS DB instance status table documents as still
 * available for operations though not `available`, which can last hours:
 * `storage-optimization` (a storage modification's background phase, up to
 * and beyond 24 hours) and `storage-initialization` (loading blocks from S3
 * after a restore). Once the guard reads OFF, a delete in one is sent at once,
 * as for `available`, rather than waited on; a refusal is then retried like
 * any other.
 */
const PROCEED_DB_STATUSES: ReadonlySet<string> = new Set([
  'storage-optimization',
  'storage-initialization',
]);

/** Whether `status` is `available` or one of {@link PROCEED_DB_STATUSES}. */
export function isProceedDbStatus(status: string | undefined): boolean {
  return status === 'available' || (status !== undefined && PROCEED_DB_STATUSES.has(status));
}

/**
 * Whether `status` is one {@link TERMINAL_DB_STATUSES} names, or an
 * `inaccessible-*`, `incompatible-*` or `*-failed` one (`cloning-failed`,
 * `migration-failed`, ...). `starting` and `stopping` are transitional: each
 * ends on its own (`available`, then `stopped`, which is terminal).
 */
export function isTerminalDbStatus(status: string | undefined): boolean {
  if (status === undefined) return false;
  return (
    TERMINAL_DB_STATUSES.has(status) ||
    status.startsWith('inaccessible-') ||
    status.startsWith('incompatible-') ||
    status.endsWith('-failed')
  );
}

/**
 * Issue #5426: {@link isTerminalDbStatus} for a deploy's WAIT on a status (a
 * create's or update's `available` wait, the `ModifyDBInstance` retry). The
 * one difference is `inaccessible-encryption-credentials-recoverable`, which
 * AWS tells apart from `inaccessible-encryption-credentials` as recoverable
 * once the KMS key is usable again (for an instance, possibly only after a
 * reboot). Such a wait keeps polling within its budget instead of failing the
 * deploy, as it did before these waits failed fast. The
 * `--remove-protection` final-snapshot paths keep {@link isTerminalDbStatus}:
 * there a terminal status sends the delete for AWS to accept or refuse, or
 * fails closed with the guard put back, and waiting out a KMS key no one is
 * restoring only spends the destroy's remaining deadline on the same outcome.
 */
export function isTerminalDbWaitStatus(status: string | undefined): boolean {
  return status !== 'inaccessible-encryption-credentials-recoverable' && isTerminalDbStatus(status);
}

/**
 * Issues #5155 / #5184: after `--remove-protection` turned an RDS-family
 * resource's DeletionProtection off, wait before a delete that takes a final
 * snapshot. The snapshot needs `available`, and the flip takes the resource
 * through `modifying`; an earlier change can also leave it in another
 * transitional status (`configuring-enhanced-monitoring`, ...). A settled read
 * is protection OFF and `available`. Right after the flip, AWS can already read
 * that while the modification has not surfaced yet; a delete sent then is
 * refused once it does. So a settled read ends the wait only after a
 * transitional status has been seen, or after {@link FLIP_TRANSITION_GRACE_MS}
 * of slept time for a flip that never shows one. A TERMINAL status
 * ({@link isTerminalDbStatus}) or a fully operational one
 * ({@link isProceedDbStatus}) with the guard off ends the wait at once: the
 * delete is AWS's to accept or refuse. The guard still ON in a terminal status
 * throws at once (fail closed). The grace clock starts at the
 * first protection-OFF read, not at the wait's start: time spent while the
 * guard still reads ON is not time the modification had to surface after the
 * OFF readback. A flip that shows a transitional status adds no wait beyond
 * that transition.
 *
 * This is the FAST PATH only: AWS can keep reading `available` past the grace
 * window and still refuse the delete, which
 * {@link deleteAfterProtectionFlipWithFinalSnapshot} recovers from.
 *
 * Fails closed: when the resource is still `modifying` or reads the guard ON
 * at the budget's bound ({@link finalSnapshotWaitBudgetMs}), it throws, the
 * delete is never sent, and the compensation puts the guard back. Any other
 * transitional status still read at the bound with the guard off sends the
 * delete, as before #5184. A settled
 * read still inside the grace window at the bound lets the delete through,
 * since nothing showed it is not ready. An AWS failure of a read propagates
 * as-is; a gone resource's `DB*NotFoundFault` is one, and the provider's delete
 * catch treats it as done. An empty read (`undefined`, defensive) ends the
 * wait.
 */
export async function waitForFlipToSettleBeforeFinalSnapshot(
  opts: FlipSettleOptions
): Promise<void> {
  const budgetMs = finalSnapshotWaitBudgetMs(opts);
  await settleBeforeFinalSnapshot(opts, Date.now(), budgetMs);
}

async function settleBeforeFinalSnapshot(
  opts: FlipSettleOptions,
  startTime: number,
  budgetMs: number
): Promise<void> {
  const { noun, label, logicalId } = opts;
  let delay = 5_000;
  // Slept time since the first protection-OFF read: the grace clock.
  let graceSleptMs = 0;
  let sawOff = false;
  let sawTransitional = false;
  for (;;) {
    const current = await opts.read();
    if (current === undefined) return;
    const terminal = isTerminalDbStatus(current.status);
    const operational = current.status !== 'available' && isProceedDbStatus(current.status);
    if (!isProceedDbStatus(current.status) && !terminal) sawTransitional = true;
    if (current.deletionProtection === false) sawOff = true;
    // A terminal status is not this wait's to outlast: AWS accepts or refuses.
    // A fully operational non-`available` status can last hours: send now.
    if (current.deletionProtection === false && (terminal || operational)) return;
    // The guard still ON in a terminal status will not change on its own.
    if (current.deletionProtection === true && terminal) {
      throw new Error(
        `--remove-protection turned DeletionProtection off, but the ${noun} still reads it ON in status '${current.status ?? 'unknown'}', which does not change on its own, and the final snapshot its DeletionPolicy asks for needs it 'available'. The delete was not sent and the guard is put back; re-run the destroy once the ${noun} is 'available'`
      );
    }
    const settled = current.deletionProtection === false && current.status === 'available';
    const inGrace = !sawTransitional && graceSleptMs < FLIP_TRANSITION_GRACE_MS;
    if (settled && !inGrace) return;
    // The grace window is ending on its own sleep, never overshot by the backoff.
    const step = inGrace ? Math.min(delay, FLIP_TRANSITION_GRACE_MS - graceSleptMs) : delay;
    if (Date.now() - startTime + step >= budgetMs) {
      if (settled) return;
      // A long transition other than the flip's own `modifying` (an instance's
      // `storage-optimization` can last hours) is AWS's to accept or refuse,
      // as before #5184; a refusal then fails closed, since the retry shares
      // this exhausted budget.
      if (
        current.deletionProtection === false &&
        current.status !== undefined &&
        current.status !== 'modifying'
      ) {
        return;
      }
      break;
    }
    opts.logger.debug(
      safeMsg`${label} ${logicalId}: waiting for the DeletionProtection change to settle before the final snapshot (status ${current.status ?? 'unknown'})`
    );
    await opts.sleep(step);
    if (sawOff) graceSleptMs += step;
    delay = Math.min(delay * 2, 10_000);
  }
  throw new Error(
    `--remove-protection turned DeletionProtection off, but the ${noun} did not return to 'available' within ${Math.max(1, Math.round(budgetMs / 60_000))} minutes, and the final snapshot its DeletionPolicy asks for needs it. The delete was not sent and the guard is put back; re-run the destroy once the ${noun} is 'available'`
  );
}

/**
 * Whether `error` is AWS refusing a final-snapshot delete because the
 * resource is not `available` ("Can't create a snapshot because the database
 * cluster ... isn't currently in the available state"). Read off the RAW
 * error the delete call threw, never a wrapped message: the provider's wrap
 * names the class only (go-to-k/cdkd#2319). The class alone is not enough:
 * the same `InvalidDBClusterStateFault` also carries the member refusal
 * ("still contains DB instances"), which must stay terminal. Two wordings
 * are matched: the cluster's measured "isn't currently in the available
 * state" (#5184), and the shorter "is not in available state" AWS has used
 * for a DB instance (#1160). A wording neither covers is not retried, which
 * fails closed as before.
 */
export function isFinalSnapshotNotAvailableRefusal(error: unknown, stateFault: string): boolean {
  if (!(error instanceof Error) || error.name !== stateFault) return false;
  return /(?:isn't|is not|isn’t) (?:currently )?in (?:the )?available state/i.test(error.message);
}

/**
 * Issue #5184: the delete that follows a `--remove-protection` flip when a
 * final snapshot is requested. Waits with
 * {@link waitForFlipToSettleBeforeFinalSnapshot} first, then sends the delete.
 * AWS can keep reading `available` for longer than any grace window and only
 * then start the modification, so a delete it refuses as not `available`
 * ({@link isFinalSnapshotNotAvailableRefusal}) is retried once the resource
 * reads `available` with the guard off again. Every other failure, the member
 * refusal included, propagates at once. Between retries every transitional
 * status is waited out; a refusal after which the resource reads a TERMINAL
 * status ({@link isTerminalDbStatus}) or the guard back ON is rethrown at once.
 *
 * The wait and every retry share one budget ({@link finalSnapshotWaitBudgetMs}).
 * At its bound the last refusal is rethrown as-is: the delete was never
 * accepted, so the compensation puts the guard back (fail closed). Each
 * retry first sleeps, since the readback can lag the state AWS refused on. A
 * resource that is gone by then makes the readback throw `DB*NotFoundFault`,
 * which propagates to the provider's delete catch and its not-found check, so
 * the delete counts as done. An empty read (`undefined`, a defensive branch the
 * real describes do not produce) sends the delete again.
 */
export async function deleteAfterProtectionFlipWithFinalSnapshot(
  opts: FlipSettleOptions & {
    /** The `InvalidDB*StateFault` class AWS refuses the delete with. */
    readonly stateFault: string;
    /** Sends the final-snapshot delete once; throws AWS's error as-is. */
    readonly send: () => Promise<unknown>;
  }
): Promise<void> {
  const budgetMs = finalSnapshotWaitBudgetMs(opts);
  const startTime = Date.now();
  await settleBeforeFinalSnapshot(opts, startTime, budgetMs);
  let delay = 5_000;
  let refusals = 0;
  for (;;) {
    try {
      await opts.send();
      return;
    } catch (error) {
      if (!isFinalSnapshotNotAvailableRefusal(error, opts.stateFault)) throw error;
      refusals += 1;
      opts.logger.debug(
        safeMsg`${opts.label} ${opts.logicalId}: final-snapshot delete refused as not 'available' (refusal ${String(refusals)}); waiting for it to return to 'available' before retrying`
      );
      for (;;) {
        if (Date.now() - startTime + delay >= budgetMs) throw error;
        await opts.sleep(delay);
        delay = Math.min(delay * 2, 10_000);
        const current = await opts.read();
        if (current === undefined) break;
        if (current.deletionProtection === false && isProceedDbStatus(current.status)) break;
        if (current.deletionProtection === true || isTerminalDbStatus(current.status)) throw error;
      }
    }
  }
}
