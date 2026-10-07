/**
 * `cdkd rollback <stack> --drop-failed <logicalId>` (go-to-k/cdkd#4633): remove
 * ONE journaled failed-CREATE orphan entry from the stack's rollback journal,
 * after the operator has checked its resource by hand.
 *
 * Such an entry (a failed CREATE whose provider proved it made the resource,
 * `physicalIdRecoveredFromError: true`, go-to-k/cdkd#1710) is the resource's
 * only record, so `cdkd destroy`, a successful `cdkd deploy` and `cdkd
 * rollback` all act on it before the journal may go, and keep it when acting
 * fails. When the failure can never clear (a secret the operator cannot read,
 * a key they cannot use), nothing else drops that one entry: removing the
 * journal object drops every other entry with it.
 *
 * Journal only, never AWS: nothing is deleted, replayed or read there. Every
 * other entry is kept. The read, the refusals and the write all run under the
 * stack lock, which every journal writer holds, so the entry dropped is the
 * one the operator confirmed.
 */
import type { S3StateBackend } from '../../state/s3-state-backend.js';
import type { LockManager } from '../../state/lock-manager.js';
import type { Logger } from '../../types/config.js';
import { isReadableBag, type ResourceState } from '../../types/state.js';
import { type RollbackJournalSegment, splitImportedOps } from '../../types/rollback-journal.js';
import {
  demoteSupersededOrphans,
  isJournaledOrphan,
  replacementNeverSwapped,
  type FailedOperation,
} from '../../deployment/rollback-executor.js';
import { isHandledOrphan } from '../../deployment/rollback-executor/journaled-orphans.js';
import {
  NESTED_PENDING_PARENT_REASON,
  displacedPhysicalIdShown,
} from '../../deployment/nested-child-journal.js';
import { journaledOrphanPrintingBag } from '../../deployment/secret-name-needles.js';
import { withPrintingSecrets } from '../../deployment/resource-secrets-scope.js';
import { logicalIdShown, resourceTypeShown } from '../../provisioning/composite-id.js';
import { plainOrDescribed } from '../../utils/pasteable-command.js';
import { forwardSigtermToSigint } from '../../utils/interrupt-signals.js';
import { CdkdError } from '../../utils/error-handler.js';
import { safeMsg } from '../../utils/display-safe.js';
import { confirmOrRefuse } from './confirm-prompt.js';

/** The `cdkd rollback` options `--drop-failed` cannot be combined with. */
export function refuseDropFailedConflicts(options: {
  orphan?: string[] | undefined;
  revertFailed?: boolean | undefined;
  skipFinalSnapshot?: boolean | undefined;
}): void {
  const conflicting = [
    ...((options.orphan ?? []).length > 0 ? ['--orphan'] : []),
    ...(options.revertFailed === true ? ['--revert-failed'] : []),
    ...(options.skipFinalSnapshot === true ? ['--skip-final-snapshot'] : []),
  ];
  if (conflicting.length === 0) return;
  throw new CdkdError(
    `--drop-failed cannot be combined with ${conflicting.join(', ')}: it replays nothing, it only ` +
      `removes one entry from the rollback journal. Run the rollback and the drop as separate commands.`,
    'ROLLBACK_DROP_FAILED_CONFLICT'
  );
}

/** The entry `--drop-failed` removes, with the companions removed beside it. */
export interface DropTarget {
  segment: RollbackJournalSegment;
  /** 1-based, as the rollback plan numbers segments. */
  segmentNumber: number;
  op: FailedOperation;
  /**
   * go-to-k/cdkd#4604: the segment's failed replacement UPDATE whose orphan
   * `op` is. It names no resource of its own, and left behind it would let a
   * later `--revert-failed` force-revert the resource it never wrote to.
   */
  companions: FailedOperation[];
}

/**
 * Pick the ONE journal entry `--drop-failed <logicalId>` names, or throw the
 * refusal that says why there is none. Droppable: a failed CREATE whose
 * provider proved it made the resource (`physicalIdRecoveredFromError:
 * true`), in a segment that is not a nested child's pending record, of a
 * logical id no `cdkd import` adopted after the segment was recorded — the
 * entries `cdkd destroy` and a successful deploy act on and keep while acting
 * fails. Every other failed entry blocks neither, so it is refused, as are an
 * unknown id, a completed operation, and an id with several droppable entries.
 */
export function selectDropTarget(
  segments: readonly RollbackJournalSegment[],
  logicalId: string,
  stackShown: string
): DropTarget {
  const named = logicalIdShown(logicalId);
  const droppable: DropTarget[] = [];
  let otherFailed = 0;
  let completed = 0;
  const droppableIds = new Set<string>();
  segments.forEach((segment, index) => {
    const failed = segment.failedOperations ?? [];
    const replay =
      segment.reason === NESTED_PENDING_PARENT_REASON
        ? []
        : splitImportedOps(failed, segment).replay;
    for (const op of replay) {
      if (isDroppable(op)) droppableIds.add(op.logicalId);
    }
    for (const op of failed) {
      if (op.logicalId !== logicalId) continue;
      if (replay.includes(op) && isDroppable(op)) {
        droppable.push({
          segment,
          segmentNumber: index + 1,
          op,
          companions: replay.filter(
            (c) => c.changeType === 'UPDATE' && replacementNeverSwapped(c, [op])
          ),
        });
      } else {
        otherFailed++;
      }
    }
    completed += segment.operations.filter((op) => op.logicalId === logicalId).length;
  });
  if (droppable.length === 1) return droppable[0]!;
  if (droppable.length > 1) {
    throw new CdkdError(
      `The rollback journal of ${stackShown} holds ${droppable.length} entries for ${named} that ` +
        `--drop-failed could drop (segments ${droppable.map((d) => d.segmentNumber).join(', ')}), ` +
        `and it drops exactly one, so it does not choose. Nothing was changed. Remove the entry you ` +
        `mean from the stack's rollback-journal.json (next to its state.json) by hand.`,
      'ROLLBACK_DROP_FAILED_AMBIGUOUS'
    );
  }
  if (otherFailed > 0) {
    throw new CdkdError(
      `The rollback journal of ${stackShown} holds no entry for ${named} that --drop-failed can ` +
        `drop: it drops only a failed CREATE whose resource cdkd proved it made, journaled as its ` +
        `only record, the entry cdkd destroy and cdkd deploy keep retrying. ${named}'s failed ` +
        `operation(s) are of another kind, or one a newer journal entry may own; neither blocks ` +
        `either command. Nothing was changed.`,
      'ROLLBACK_DROP_FAILED_NOT_ORPHAN'
    );
  }
  if (completed > 0) {
    throw new CdkdError(
      `${named} is a completed operation in the rollback journal of ${stackShown}, not a failed ` +
        `one; --drop-failed drops failed operations only. Nothing was changed. To leave a completed ` +
        `operation out of a rollback, pass --orphan with its logical id.`,
      'ROLLBACK_DROP_FAILED_COMPLETED'
    );
  }
  const ids = [...droppableIds].map(logicalIdShown);
  throw new CdkdError(
    `The rollback journal of ${stackShown} has no entry for ${named}. Nothing was changed. ` +
      (ids.length === 0
        ? 'It holds no entry --drop-failed can drop.'
        : `Entries --drop-failed can drop: ${ids.join(', ')}.`),
    'ROLLBACK_DROP_FAILED_UNKNOWN'
  );
}

function isDroppable(op: FailedOperation): boolean {
  return isJournaledOrphan(op) && op.physicalIdRecoveredFromError === true;
}

/**
 * The property each policy-attachment type lists its targets in: a failed
 * create of one is the go-to-k/cdkd#4612 entry that can be left undeletable,
 * and the operator checks those targets by hand.
 */
const POLICY_TARGETS: Readonly<Record<string, string>> = {
  'AWS::SQS::QueuePolicy': 'Queues',
  'AWS::SNS::TopicPolicy': 'Topics',
};

/**
 * The lines describing `target`, each masked as a journaled-orphan line is
 * (`displacedPhysicalIdShown`); the caller logs them under the entry's
 * printing bag, which masks a name the entry read from a state record too.
 */
export function dropTargetLines(
  target: DropTarget,
  segmentCount: number,
  logger: Logger
): string[] {
  const { op } = target;
  const lines = [
    `  - ${logicalIdShown(op.logicalId)} (${resourceTypeShown(op.resourceType)})  ` +
      `${displacedPhysicalIdShown(op, logger) ?? 'a physical id'}  ` +
      `[failed CREATE, segment ${target.segmentNumber}/${segmentCount}]`,
  ];
  // `resourceType` is a journal value: own keys only, never the prototype's.
  const targetsKey = Object.hasOwn(POLICY_TARGETS, op.resourceType)
    ? POLICY_TARGETS[op.resourceType]
    : undefined;
  const targets: unknown =
    targetsKey === undefined ? undefined : op.attemptedProperties?.[targetsKey];
  if (Array.isArray(targets) && targets.length > 0) {
    lines.push(`    ${targetsKey} it was attached to:`);
    for (const t of targets) {
      lines.push(
        `      - ${
          typeof t === 'string' && t !== ''
            ? (displacedPhysicalIdShown(op, logger, t) ?? 'a value')
            : 'a value that is not a string'
        }`
      );
    }
  }
  if (target.companions.length > 0) {
    lines.push(
      `    (with the failed replacement UPDATE recorded beside it, which names no resource of its own)`
    );
  }
  return lines;
}

/** The `--drop-failed` confirmation prompt, refused where it cannot run. */
async function confirmDrop(question: string): Promise<boolean> {
  return confirmOrRefuse(question, {
    suffix: ' (y/N): ',
    refusal:
      'The cdkd rollback --drop-failed confirmation prompt cannot run in a non-interactive ' +
      'environment. Pass --force (or -y / --yes) to confirm the drop, or run the command from a ' +
      'real terminal.',
  });
}

/**
 * Drop the one entry `logicalId` names from the journal of `stackName` in
 * `region`, under the stack lock. Throws a refusal (nothing changed) per
 * {@link selectDropTarget}, and when the stack has no journal.
 */
export async function dropFailedJournalEntry(args: {
  stateBackend: Pick<
    S3StateBackend,
    'getState' | 'loadRollbackJournal' | 'dropRollbackJournalFailedOperations'
  >;
  lockManager: Pick<LockManager, 'acquireLockWithRetry' | 'releaseLock'>;
  stackName: string;
  region: string;
  logicalId: string;
  skipConfirmation: boolean;
  logger: Logger;
  /** The prompt; injectable for tests. */
  confirm?: (question: string) => Promise<boolean>;
}): Promise<void> {
  const { stateBackend, lockManager, stackName, region, logicalId, logger } = args;
  const stackShown = `stack ${plainOrDescribed(stackName, 'stack name')} (${plainOrDescribed(region, 'region')})`;
  // Registered BEFORE the lock acquisition, as `cdkd rollback` does (issue
  // #1348): a signal during it then stops the run before the write, and the
  // `finally` releases the lock instead of stranding it.
  let interrupted = false;
  const sigintHandler = (): void => {
    process.stderr.write('\nInterrupted — the rollback journal is not changed.\n');
    interrupted = true;
  };
  process.on('SIGINT', sigintHandler);
  const unforwardSigterm = forwardSigtermToSigint();
  try {
    await lockManager.acquireLockWithRetry(stackName, region, undefined, 'rollback');
  } catch (error) {
    process.removeListener('SIGINT', sigintHandler);
    unforwardSigterm();
    throw error;
  }
  try {
    const journal = await stateBackend.loadRollbackJournal(stackName, region);
    if (!journal || journal.segments.length === 0) {
      throw new CdkdError(
        `${stackShown.charAt(0).toUpperCase()}${stackShown.slice(1)} has no rollback journal; ` +
          'nothing to drop.',
        'ROLLBACK_DROP_FAILED_NO_JOURNAL'
      );
    }
    // Read BEFORE anything is printed, and fail closed: the record is the
    // printing bag's source of a name an entry read from it
    // (go-to-k/cdkd#3869). No record at all is the one case read as empty.
    let stateData: Awaited<ReturnType<typeof stateBackend.getState>>;
    try {
      stateData = await stateBackend.getState(stackName, region);
    } catch (err) {
      throw new CdkdError(
        `Could not read the state record of ${stackShown} (${err instanceof Error ? err.name : 'an error'}), ` +
          'which the drop needs to mask the entry. Nothing was changed; re-run once it can be read.',
        'ROLLBACK_DROP_FAILED_STATE_UNREADABLE'
      );
    }
    const resources: unknown = stateData ? stateData.state.resources : {};
    if (!isReadableBag(resources)) {
      throw new CdkdError(
        `The state record of ${stackShown} holds resources that cannot be read, which the drop needs ` +
          'to mask the entry. Nothing was changed.',
        'ROLLBACK_DROP_FAILED_STATE_UNREADABLE'
      );
    }
    const stateResources = resources as Record<string, ResourceState>;
    // The supersede pass `cdkd destroy` and `cdkd rollback` run on read, on a
    // copy: an entry a newer journal entry may own is demoted there (warned
    // about, never deleted, so it blocks nothing) and is not dropped here
    // either. Its rollback-orphan-record arm is not consulted: dropping such an
    // entry loses nothing, since that record still holds the resource.
    const judged = structuredClone(journal.segments);
    demoteSupersededOrphans(judged);
    const target = selectDropTarget(judged, logicalId, stackShown);
    const drop = [target.op, ...target.companions].map((op) => ({ segment: target.segment, op }));
    // The write matches by identity on a fresh read (`isHandledOrphan`), so
    // the identity must name only these entries.
    const matching = journal.segments.reduce(
      (n, segment) =>
        n +
        (segment.failedOperations ?? []).filter((op) => isHandledOrphan(drop, segment, op)).length,
      0
    );
    if (matching !== drop.length) {
      throw new CdkdError(
        `The rollback journal of ${stackShown} holds another entry identical to ${logicalIdShown(logicalId)}'s, ` +
          `so dropping it by its identity would drop more than one. Nothing was changed. Remove the ` +
          `entry you mean from the stack's rollback-journal.json (next to its state.json) by hand.`,
        'ROLLBACK_DROP_FAILED_AMBIGUOUS'
      );
    }
    // One bag over every failed entry, as `cdkd rollback` and `cdkd destroy`
    // build theirs: an entry can name a resource another entry holds.
    const printing = journaledOrphanPrintingBag(
      judged.flatMap((segment) => segment.failedOperations ?? []),
      stateResources
    );
    withPrintingSecrets(printing, () => {
      logger.info(safeMsg`\nDrop one entry from the rollback journal of ${stackShown}:`);
      for (const line of dropTargetLines(target, journal.segments.length, logger))
        logger.info(line);
      logger.info(
        "\nThis removes only the journal entry, which is cdkd's last record of that resource. " +
          'Nothing is deleted in AWS: check the resource above by hand, and delete it yourself if it ' +
          'should not stay. cdkd destroy and cdkd deploy then no longer act on it.\n'
      );
    });
    const stopIfInterrupted = (): void => {
      if (!interrupted) return;
      throw new CdkdError(
        'Interrupted before the rollback journal was changed; nothing was dropped.',
        'ROLLBACK_DROP_FAILED_INTERRUPTED'
      );
    };
    // Before the prompt too: a signal during the reads never asks.
    stopIfInterrupted();
    if (!args.skipConfirmation) {
      const ok = await (args.confirm ?? confirmDrop)('Drop this entry from the rollback journal?');
      if (!ok) {
        logger.info('Drop cancelled; the rollback journal is not changed.');
        return;
      }
    }
    stopIfInterrupted();
    const removed = await stateBackend.dropRollbackJournalFailedOperations(
      stackName,
      region,
      (op, segment) => isHandledOrphan(drop, segment, op)
    );
    if (removed !== drop.length) {
      // Unreachable while every journal writer holds the lock this run holds.
      // Reported after the write, which has already happened.
      throw new CdkdError(
        `The rollback journal of ${stackShown} was rewritten with ${removed} entr${removed === 1 ? 'y' : 'ies'} ` +
          `removed where ${drop.length} ${drop.length === 1 ? 'was' : 'were'} expected: it changed under the ` +
          `stack lock. Inspect the stack's rollback-journal.json (next to its state.json).`,
        'ROLLBACK_DROP_FAILED_CHANGED'
      );
    }
    logger.info(
      safeMsg`Dropped ${logicalIdShown(logicalId)}'s entry from the rollback journal of ${stackShown}. ` +
        'Nothing was deleted in AWS; every other entry is kept.'
    );
  } finally {
    // Release first, unregister last (issue #2118), as `cdkd rollback` does.
    try {
      await lockManager.releaseLock(stackName, region).catch((err: unknown) => {
        logger.warn(
          safeMsg`Failed to release the lock of ${stackShown}: ${err instanceof Error ? err.name : 'an error'}`
        );
      });
    } finally {
      process.removeListener('SIGINT', sigintHandler);
      unforwardSigterm();
    }
  }
}
