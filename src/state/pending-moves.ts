import type { PendingMoveOut, StackState } from '../types/state.js';
import { CdkdError } from '../utils/error-handler.js';
import { markNonRetryable } from '../deployment/retryable-errors.js';
import { safeMsg } from '../utils/display-safe.js';

/**
 * `StackState.pendingMovesOut` (go-to-k/cdkd#5212): the resources an
 * unfinished `cdkd refactor` is moving out of a stack. Validated: a
 * malformed field reads as a pending move it cannot describe, never as none,
 * because "none" would let a deploy delete a resource another stack holds.
 */
export function pendingMovesOutOf(state: Pick<StackState, 'pendingMovesOut'>): {
  moves: PendingMoveOut[];
  malformed: boolean;
} {
  const raw = state.pendingMovesOut;
  if (raw === undefined) return { moves: [], malformed: false };
  if (!Array.isArray(raw)) return { moves: [], malformed: true };
  const moves: PendingMoveOut[] = [];
  let malformed = false;
  for (const entry of raw) {
    if (
      entry !== null &&
      typeof entry === 'object' &&
      typeof entry.from === 'string' &&
      typeof entry.toStack === 'string' &&
      typeof entry.toRegion === 'string' &&
      typeof entry.to === 'string'
    ) {
      moves.push(entry);
    } else {
      malformed = true;
    }
  }
  return { moves, malformed };
}

/** Whether a record carries any pending move, readable or not. */
export function hasPendingMovesOut(state: Pick<StackState, 'pendingMovesOut'>): boolean {
  const { moves, malformed } = pendingMovesOutOf(state);
  return malformed || moves.length > 0;
}

/**
 * The refusal text for a command that would act on a stack an unfinished
 * `cdkd refactor` is moving resources out of. Exported for `cdkd diff`'s
 * preview of the same refusal.
 */
export function pendingMovesRefusalMessage(
  state: Pick<StackState, 'pendingMovesOut'>,
  stackName: string,
  region: string,
  command: string
): string {
  const { moves } = pendingMovesOutOf(state);
  const listed =
    moves.length > 0
      ? moves.map((m) => `${m.from} -> ${m.toStack}.${m.to}`).join(', ')
      : 'a move this binary cannot read';
  return (
    safeMsg`${command} refused stack ${stackName} (${region}): a cdkd refactor that moved ` +
    safeMsg`resources out of it did not finish (${listed}). The destination may already hold ` +
    `them, so acting on this stack now could delete a resource another stack owns. Run ` +
    safeMsg`'cdkd refactor ${stackName}' to finish the move, then re-run.`
  );
}

/**
 * Refuse a command that would act on a stack an unfinished `cdkd refactor`
 * is moving resources out of. One field test on the record the command has
 * already loaded: no S3 or AWS call.
 */
export function refusePendingMovesOut(
  state: Pick<StackState, 'pendingMovesOut'>,
  stackName: string,
  region: string,
  command: string
): void {
  if (!hasPendingMovesOut(state)) return;
  // `markNonRetryable` as the container refusals carry it: a nested child's
  // deploy runs inside its parent's retry, and no retry changes this record.
  throw markNonRetryable(
    new CdkdError(
      pendingMovesRefusalMessage(state, stackName, region, command),
      'REFACTOR_UNFINISHED'
    )
  );
}
