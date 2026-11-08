/**
 * Writing one rollback-journal segment (issue #1183).
 * Split out of `deploy-engine/rollback.ts` (go-to-k/cdkd#5835), which
 * re-exports what it exported.
 */
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import { getCurrentSkipPrefix } from '../../../provisioning/resource-name.js';
import { getCdkdVersion } from '../../../state/deployment-events-store.js';
import type { RollbackJournalSegment } from '../../../types/rollback-journal.js';
import { asIsMessage, safeMsg } from '../../../utils/display-safe.js';
import type { CompletedOperation, FailedOperation } from '../../rollback-executor.js';
import { maskOutputsByPosition } from '../noecho.js';
import type { RollbackDeps } from './deps.js';
import { redactOperationsForJournal } from './adopt-orphans.js';

/**
 * Record one rollback-journal segment (issue #1183) so the failed /
 * interrupted / about-to-auto-rollback deploy can be reverted later by
 * `cdkd rollback`. Best-effort like the partial-state save, but warns
 * LOUDLY on failure — the user just lost the ability to `cdkd rollback`.
 *
 * Returns whether THIS call appended a segment: `false` for the empty-segment
 * skip and for a failed write. The clean auto-rollback's settle pops the
 * NEWEST segment, so it may run only when this attempt wrote it; otherwise it
 * pops an OLDER attempt's revert record (a refused-before-applying CREATE
 * journals nothing since go-to-k/cdkd#4356, so its attempt can be empty).
 */
export async function writeRollbackJournalSegment(
  deps: RollbackDeps,
  stackName: string,
  completedOperations: CompletedOperation[],
  failedOperations: FailedOperation[],
  reason: RollbackJournalSegment['reason'],
  initialDeploy: boolean,
  /**
   * Issue #3754: a nested child's success segment is written even when EMPTY
   * — its presence is what tells the parent's revert that the child had
   * nothing to undo, as opposed to having no record at all — and carries the
   * child's pre-deploy outputs.
   */
  nestedPending?: Pick<RollbackJournalSegment, 'previousOutputs' | 'previousCrossStackReads'>
): Promise<boolean> {
  // A segment with no operations carries nothing to revert — skip it so a
  // failure before any resource completed does not create an empty journal.
  // A failed op alone (#1198) IS worth journaling: `cdkd rollback
  // --revert-failed` can act on it even with zero completed ops.
  if (!nestedPending && completedOperations.length === 0 && failedOperations.length === 0) {
    return false;
  }
  // Redact resolved secret plaintext out of the journal (GHSA fix): the ops
  // carry resolved / attempted properties and previous-state snapshots read
  // from the in-memory working map, which is NOT run through the state save
  // choke point, so plaintext would otherwise land in rollback-journal.json.
  const redactedCompleted = redactOperationsForJournal(deps, completedOperations);
  const redactedFailed = redactOperationsForJournal(deps, failedOperations);
  try {
    const segment: RollbackJournalSegment = {
      ...(deps.options.eventRecorder?.runId !== undefined && {
        runId: deps.options.eventRecorder.runId,
      }),
      timestamp: Date.now(),
      reason,
      initialDeploy,
      ...(deps.options.roleArn && { roleArn: deps.options.roleArn }),
      cdkdVersion: getCdkdVersion(),
      // Issue #4018: the prefix flag this deploy's providers derived names
      // under, so `cdkd rollback` replays the segment in the same scope.
      skipPrefix: getCurrentSkipPrefix(),
      operations: redactedCompleted,
      ...(redactedFailed.length > 0 && { failedOperations: redactedFailed }),
      // go-to-k/cdkd#4043 (review B3): the pre-deploy outputs a pre-v11
      // record held in the clear go through the same positional arm.
      ...(nestedPending?.previousOutputs && {
        previousOutputs: {
          ...nestedPending.previousOutputs,
          outputs: maskOutputsByPosition(
            deps.noEchoRun(),
            deps.noEchoDeps(),
            nestedPending.previousOutputs.outputs
          ),
        },
      }),
      ...(nestedPending?.previousCrossStackReads && {
        previousCrossStackReads: nestedPending.previousCrossStackReads,
      }),
    };
    await deps.stateBackend.appendRollbackJournalSegment(stackName, deps.stackRegion, segment);
    deps.logger.debug(safeMsg`Rollback journal segment written (${reason})`);
    return true;
  } catch (journalError) {
    deps.logger.warn(
      safeMsg`Failed to write rollback journal: ${asIsMessage(describeAwsFailure(journalError).detail)}. ` +
        `'cdkd rollback' will NOT be able to revert this deploy — use 'cdkd deploy' to resume or 'cdkd destroy' to clean up.`
    );
    return false;
  }
}
