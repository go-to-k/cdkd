import { plainOrDescribed } from '../../../utils/pasteable-command.js';
import { CdkdError } from '../../../utils/error-handler.js';
import { verboseAwareText } from '../../../utils/aws-failure-text.js';
import { markNonRetryable } from '../../../deployment/retryable-errors.js';
import { NESTED_PENDING_PARENT_REASON } from '../../../deployment/nested-child-journal.js';
import {
  describeRegionValueKind,
  isReadableBag,
  type StackState,
  type LockInfo,
} from '../../../types/state.js';
import type { S3StateBackend } from '../../../state/s3-state-backend.js';
import { isLockInfoExpired } from '../../../state/lock-manager.js';
import { STATE_REGION_DIVERGED } from '../../../state/malformed-resources-bag.js';
import { backendErrorText, safe, safeStack } from './render.js';

/**
 * Refuse a rollback over a record whose body `region` disagreed with the key it
 * was read from, while it still lists resources (go-to-k/cdkd#3370) — the
 * rollback half of `refuseDivergentRecordRegionForDestroy` (go-to-k/cdkd#3328).
 *
 * The replay acts in the KEY's region (`RollbackExecutorContext.region`) and
 * reads a `*NotFound` delete as "already gone", exactly as the destroy does: if
 * the record's own region is the honest half, a rolled-back CREATE's delete
 * comes back not-found, the replay drops the row and saves, and the resource is
 * left live in the other region with nothing naming it.
 *
 * ONE refusal for the whole command rather than one per replay arm, because the
 * trigger already partitions the arms exactly. Every arm that calls AWS — the
 * CREATE delete, the in-place `revert`, BOTH reverse-replacement arms (whose
 * re-CREATE writes as well as deletes), and `--revert-failed`'s delete and
 * forced update — requires a CURRENT state row for the op's logical id
 * (`classifyRollbackOp` / `classifyFailedOp`), except the delete of a proven
 * failed-CREATE orphan (go-to-k/cdkd#1710), which has no row, is replayed with
 * or without `--revert-failed` (go-to-k/cdkd#4584), and is counted in
 * `provenOrphans`; a completed DELETE is `unrecoverable-delete` and
 * calls nothing. So a record listing no resources, under a journal with no
 * proven orphan to delete, can replay nothing against AWS, and is let through
 * for the reason the destroy gives: it is the recovery path, not the hazard.
 * Anything else can reach an arm that calls AWS, so every arm is refused.
 *
 * Its own message rather than the destroy's builder, whose opening, consequence
 * and remedy all speak about a DESTROY. This one offers no command at all — the
 * remedy is a repair — so it needs none of that builder's exact-rendering gate,
 * and it names the stack the way every other message in this file does. The
 * body's value is withheld and its KIND printed, the rule `getState`'s warn
 * takes: a region a record supplies is the misdirection channel.
 */
export function refuseDivergentRecordRegionForRollback(
  state: StackState,
  stackName: string,
  keyRegion: string,
  divergentBodyRegion: unknown,
  provenOrphans: number
): void {
  if (divergentBodyRegion === undefined) return;
  // FAIL CLOSED on a bag this cannot count, as the destroy sibling does.
  // Unreachable from the call site (`refuseMalformedState` refused such a bag
  // first), and kept so a reorder cannot read "unknown" as "zero".
  const resourceCount = isReadableBag(state.resources)
    ? Object.keys(state.resources).length
    : undefined;
  if (resourceCount === 0 && provenOrphans === 0) return;
  const lists =
    resourceCount === undefined
      ? 'its resources map cannot be read'
      : resourceCount > 0
        ? `it still lists ${resourceCount} resource${resourceCount === 1 ? '' : 's'}`
        : `its journal holds ${provenOrphans} failed create${provenOrphans === 1 ? '' : 's'} ` +
          `whose resource the rollback would delete`;
  throw markNonRetryable(
    new CdkdError(
      // The stack and region are NAMED only when plain, described otherwise:
      // this block ends in a `--verbose` remedy, and a block that displays an
      // untrusted value carries no pasteable command (go-to-k/cdkd#3950's S1
      // rule; under zsh a `$( )` name runs when the sentence is pasted).
      `cdkd will not roll back ${plainOrDescribed(stackName, 'stack name')} ` +
        `(${plainOrDescribed(keyRegion, 'region')}): the state record ` +
        `read from that region's key carries a 'region' of its own ` +
        `(${describeRegionValueKind(divergentBodyRegion)}) that is not the key's, and ${lists} — ` +
        `so cdkd cannot tell which region they are in. cdkd stamps the key's region into every ` +
        `record it writes, so this record was not written by cdkd. The replay would issue every ` +
        `delete and revert against the key's region; if the record's own region is the honest ` +
        `half, each delete comes back not-found, which the replay reads as ALREADY DELETED — it ` +
        `would report the resource rolled back, drop it from the record, and leave it standing ` +
        `in the other region. Nothing was changed. ` +
        verboseAwareText(
          "Re-run with --verbose to see what the record's region field holds, ",
          "The debug output shows what the record's region field holds; "
        ) +
        `repair that field to match the key it is stored under, ` +
        `and run the rollback again.`,
      STATE_REGION_DIVERGED
    )
  );
}

/**
 * Why the retry SAVE declined to write over a record that was rewritten mid-run
 * with a divergent body region (go-to-k/cdkd#3370) — rendered in that save's
 * warn and again in the run's partial-failure exit. Names no stack — both are
 * about the current run's stack already — and
 * prints the value's KIND only, for the reason
 * {@link refuseDivergentRecordRegionForRollback} gives.
 */
export function divergedDuringRollbackMessage(divergentBodyRegion: unknown): string {
  return (
    `the state record was rewritten during this rollback, and the rewrite carries a 'region' ` +
    `of its own (${describeRegionValueKind(divergentBodyRegion)}) that is not the region of its ` +
    `key, so cdkd did not write over it`
  );
}

/**
 * Judge a nested child's `nested-pending-parent` records (issue #3754) before
 * anything is shown or written. Returns how many are ORPHANS to discard after
 * the confirmation; THROWS when one may still be needed.
 *
 * - A record whose run the direct parent's journal still holds is LIVE: only a
 *   rollback of the top-level stack may replay it, so the command refuses.
 * - The parent's journal being UNREADABLE (a throttle, a newer journal version,
 *   a malformed body) is not "no journal": the record cannot be judged, so the
 *   command refuses rather than discard one the parent will need.
 * - An in-flight top-level deploy writes its journal only when it fails, so its
 *   run is invisible while it runs; a LIVE lock on the top-level stack refuses
 *   too. (Its child deploys and reverts take this child's lock, which this
 *   command holds, so no new record can land while it runs.)
 * - Everything else — including a record with no run id, which no parent run
 *   can select — is an orphan: its parent run settled without dropping it,
 *   crashed before writing a journal, or the drop failed.
 */
export async function judgeNestedPendingRecords(
  setup: {
    stateBackend: Pick<S3StateBackend, 'loadRollbackJournal'>;
    lockManager: { getLockInfo(stack: string, region: string): Promise<LockInfo | null> };
  },
  stackName: string,
  region: string,
  segments: ReadonlyArray<{ reason: string; runId?: string }>
): Promise<number> {
  const pending = segments.filter((s) => s.reason === NESTED_PENDING_PARENT_REASON);
  if (pending.length === 0) return 0;
  const lastCut = stackName.lastIndexOf('~');
  const parent = lastCut > 0 ? stackName.slice(0, lastCut) : undefined;
  const topLevel = stackName.split('~')[0]!;
  const refuse = (detail: string): never => {
    throw new Error(
      `The rollback journal of nested stack ${safeStack(stackName)} (${safe(region)}) holds the ` +
        `record of a nested deploy that ${detail} Roll back the top-level stack ` +
        `${safeStack(topLevel)} instead, or re-deploy it, which clears the record.`
    );
  };
  if (parent === undefined) return pending.length;

  let parentJournal: { segments: ReadonlyArray<{ runId?: string }> } | null;
  try {
    parentJournal = await setup.stateBackend.loadRollbackJournal(parent, region);
  } catch (error) {
    return refuse(
      `cannot be judged: the journal of its parent ${safeStack(parent)} could not be read ` +
        `(${backendErrorText(error, parent, region)}), so the record may still be needed.`
    );
  }
  const parentRuns = new Set(
    (parentJournal?.segments ?? []).flatMap((s) => (s.runId !== undefined ? [s.runId] : []))
  );
  if (pending.some((s) => s.runId !== undefined && parentRuns.has(s.runId))) {
    refuse(`its parent has not settled, which only a rollback of the top-level stack may replay.`);
  }

  let lock: LockInfo | null;
  try {
    lock = await setup.lockManager.getLockInfo(topLevel, region);
  } catch (error) {
    return refuse(
      `cannot be judged: the lock of the top-level stack could not be read ` +
        `(${backendErrorText(error, topLevel, region)}).`
    );
  }
  if (lock && !isLockInfoExpired(lock)) {
    refuse(
      `may belong to a deploy still running: the top-level stack is locked. Retry once it is ` +
        `free.`
    );
  }
  return pending.length;
}
