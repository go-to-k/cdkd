/**
 * The checks and record helpers of the failed-op replay, split out of
 * `rollback-executor.ts` (go-to-k/cdkd#5835).
 */

import { type RolledBackCreate } from '../../state/name-generation.js';
import type { ResourceState, StackOrphanRecord } from '../../types/state.js';
import { RollbackInlinePolicyWriters } from '../inline-policy-claims.js';
import { type RollbackExecutorContext, type FailedOperation } from './types.js';
import {
  askForeignHolder,
  createdResourceStillThere,
  orphanNeedsIdentity,
} from './orphan-identity.js';
import { removeProtectionTypes } from '../../provisioning/remove-protection-types.js';

/** `undefined` for an empty list, so an absent field stays absent. */
export function nonEmptyOrUndefined<T>(items: T[]): T[] | undefined {
  return items.length > 0 ? items : undefined;
}

/**
 * go-to-k/cdkd#4678: whether `--remove-protection` may strip a failed
 * CREATE's resource. A state-recorded op is the record's own. A journaled
 * orphan only when the delete's checks cleared it (`deleteProven`: no other
 * stack's record holds it, and it is the resource its CREATE made,
 * go-to-k/cdkd#4696 / #4658), and only on a type the flag strips something
 * from (an exempt type, or one in `removeProtectionTypes`). An orphan the
 * checks never ran on keeps its protection, so AWS's refusal stays the guard;
 * every caller that sets the flag also supplies the checks' `foreignHolder`.
 */
export function protectionRemovalProven(op: FailedOperation, deleteProven: boolean): boolean {
  if (op.physicalIdRecoveredFromError !== true) return true;
  return (
    deleteProven && (!orphanNeedsIdentity(op) || removeProtectionTypes().includes(op.resourceType))
  );
}

/**
 * go-to-k/cdkd#4696 / #4658: before a replay of an earlier run's journal
 * (`cdkd rollback`, `cdkd destroy`) deletes the proven orphan `op`, the two
 * checks the success settle runs, in its order: another stack's state record
 * must not hold it, and a name-keyed type's live identity must equal the
 * journaled one. `'gone'` when AWS reports the id gone (settled without a
 * delete). `keep` for a verdict a re-run cannot change (another stack holds
 * it, its identity differs, or the journal recorded none): a warned skip.
 * `retry` when a read gave no answer: a record the scan cannot read (the
 * settle keeps that one too) or a failed identity read (which the settle
 * demotes to a warned skip; the replay, which may be the entry's last chance,
 * keeps it). `undefined` when the delete may run.
 */
export async function journaledOrphanKeepReason(
  op: FailedOperation & { physicalId: string },
  foreignHolder: NonNullable<RollbackExecutorContext['foreignHolder']>,
  ctx: RollbackExecutorContext
): Promise<{ keep: string; finish?: string } | { retry: string } | 'gone' | undefined> {
  const holding = await askForeignHolder(foreignHolder, op);
  if (holding?.kind === 'held') {
    return {
      keep: `${holding.by} holds a resource of that type under the same physical id now`,
      finish: 'it now belongs to that stack: leave it to that stack',
    };
  }
  if (holding?.kind === 'unreadable') {
    return {
      retry: `${holding.what} leaves open whether another stack holds it now; once that record can be read (re-deploy or inspect it with \`cdkd state show\`, or retry when the bucket is reachable), re-run`,
    };
  }
  // The identity is READ here and the delete runs after it, unconditioned on
  // it: a name freed and reused between the two is not caught (the success
  // settle makes the same trade, go-to-k/cdkd#4655).
  const created = await createdResourceStillThere(op, ctx);
  if (created === 'gone') return 'gone';
  if (created === 'mismatch') {
    return {
      keep: 'the resource now under that id is another one (its identity differs from the one the failed deploy recorded, so its name was reused)',
    };
  }
  if (created === 'unproven') {
    const journaled = op.createdResourceIdentity;
    return typeof journaled === 'string' && journaled !== ''
      ? {
          retry:
            'its live identity could not be read, so nothing proves the resource now under that id is the one it created',
        }
      : {
          keep: 'nothing proves the resource now under that id is the one it created (the journal recorded no identity for it; it may have been deleted and its name reused)',
        };
  }
  return undefined;
}

/** The bag's own record for `logicalId`, never an inherited property. */
export function ownRecord(
  stateResources: Record<string, ResourceState>,
  logicalId: string
): ResourceState | undefined {
  return Object.hasOwn(stateResources, logicalId) ? stateResources[logicalId] : undefined;
}

/**
 * go-to-k/cdkd#5505: `bag` with each of `keys` taken from `source` (absent
 * there, absent here), so a diff of the two bags never touches those keys.
 */
export function withKeysFrom(
  bag: Record<string, unknown>,
  source: Record<string, unknown> | undefined,
  keys: readonly string[]
): Record<string, unknown> {
  const out = { ...bag };
  for (const key of keys) {
    if (source !== undefined && Object.hasOwn(source, key)) out[key] = source[key];
    else delete out[key];
  }
  return out;
}

/**
 * go-to-k/cdkd#5505: what the failed update of THIS run left unsettled (the
 * names and items its accepted calls marked), and whether its call the
 * deadline abandoned later completed (`lateSuccess`: it rewrote the record,
 * so the whole update is undone).
 */
export interface OwnUnsettled {
  names: ReadonlySet<string>;
  items: ReadonlyMap<string, ReadonlySet<string>>;
  lateSuccess: boolean;
}

/** The options of {@link replayFailedOperationsUnbound}. */
export interface ReplayFailedOperationsOptions {
  afterOp?: (logicalId: string) => Promise<void> | void;
  isInterrupted?: () => boolean;
  /**
   * Called the moment a record is minted, BEFORE `afterOp` saves state
   * (issue #2934).
   *
   * `result.orphaned` alone is not enough: a caller reads it only after this
   * function RETURNS, while `afterOp` runs per op INSIDE the replay — so
   * every intermediate save would persist a state with the resource gone
   * from `resources` and no record of it. A crash in that window loses the
   * only trace of a live, billing AWS resource permanently: the
   * unrecoverable loop this feature closes, reached through its own
   * implementation.
   */
  onOrphan?: (record: StackOrphanRecord) => void;
  /**
   * go-to-k/cdkd#5064: called the moment a CREATE's record leaves (deleted,
   * or left in AWS), BEFORE `afterOp` saves, for the reason `onOrphan` is:
   * every save from then on retires its generation (`retiredAfterRollback`).
   */
  onRolledBackCreate?: (create: RolledBackCreate) => void;
  /**
   * Emit the ROLLBACK_STARTED / ROLLBACK_FINISHED envelope around the
   * failed-op replay. The command passes true for a failed-only segment
   * (zero completed ops), where `replayRollback` returns early without
   * emitting the envelope — keeping `cdkd events` output symmetric.
   */
  emitEnvelope?: boolean;
  /** go-to-k/cdkd#4225: as on {@link replayRollback}. */
  inlinePolicyWriters?: RollbackInlinePolicyWriters;
  /**
   * A `cdkd destroy` replays these ops before it deletes the stack: a line
   * says what happens next in that run, not in a later deploy.
   */
  forDestroy?: boolean;
  /**
   * go-to-k/cdkd#5505: the automatic rollback's revert of what a failed
   * UPDATE left unsettled. The `revert-failed-update` arm then takes the
   * RECORD (the pre-failure bag the failed deploy kept, plus its unsettled
   * names) as the previous side instead of the attempted bag, so only the
   * unsettled keys differ: each converges from AWS, and an item goes on the
   * previous side only when its name is one the failed update's accepted
   * calls added (`unsettledItems`) and the restored bag does not declare it.
   *
   * Only THIS run's names and items are converged ({@link OwnUnsettled}, per
   * logical id): a name an earlier failed deploy left on the record is kept
   * as it is, for the next deploy or `--revert-failed`.
   */
  previousFromRecord?: ReadonlyMap<string, OwnUnsettled>;
}
