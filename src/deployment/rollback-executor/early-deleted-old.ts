/**
 * Whether a reverse-replacement re-creates an old resource the failed deploy
 * had ALREADY deleted (go-to-k/cdkd#6713), so the rollback gets back only what
 * its recorded properties declare. CloudFormation never does this: it deletes
 * a replaced resource only in the cleanup phase, after the deploy succeeded.
 * cdkd still deletes early where deferring is not possible (the delete-first
 * routes, a new resource holding the old id and type, an inline policy);
 * `docs/cli-rollback-limitations.md` lists them.
 *
 * Shared by the replay's advisory line and `cdkd rollback`'s plan label, so
 * the two never disagree on which reversals lose the old resource's contents.
 */
import { isInlinePolicyType } from '../superseded-resources.js';
import type { CompletedOperation } from './types.js';

/**
 * `'before-create'`: deleted before its replacement was created
 * (`oldDeletedBeforeCreate`). `'during-deploy'`: deleted, and confirmed, at
 * some other point before the deploy succeeded (a create-first replacement
 * whose delete runs inline; an older binary's journal records no order).
 * `undefined`: the reversal does not re-create a resource the deploy deleted
 * — its delete was left for the cleanup phase, refused or unconfirmed
 * (`oldResourceMaySurvive`: the replay reads AWS first and says what it
 * found, and the plan row names those outcomes), or the old resource is an inline
 * policy, whose document the record restores whole.
 */
export function earlyDeletedOld(
  op: Pick<CompletedOperation, 'oldDeletedBeforeCreate' | 'oldResourceMaySurvive'>,
  oldType: string,
  /**
   * The replay's read found an `'unconfirmed'` delete's old resource gone:
   * the deploy sent that delete, so the deploy deleted it. The plan, which
   * reads nothing, never passes it.
   */
  unconfirmedFoundGone = false
): 'before-create' | 'during-deploy' | undefined {
  if (isInlinePolicyType(oldType)) return undefined;
  if (op.oldResourceMaySurvive !== undefined) {
    return op.oldResourceMaySurvive === 'unconfirmed' && unconfirmedFoundGone
      ? 'during-deploy'
      : undefined;
  }
  return op.oldDeletedBeforeCreate === true ? 'before-create' : 'during-deploy';
}

/** The clause naming when the deploy deleted it, for both renderers. */
export function earlyDeleteWhen(kind: 'before-create' | 'during-deploy'): string {
  return kind === 'before-create'
    ? 'deleted the old resource before creating its replacement'
    : 'deleted the old resource before the deploy succeeded';
}

/**
 * What the deploy's PLAN (`cdkd diff`, the `--require-approval` listing) can
 * tell, before the deploy runs, about a replacement whose old copy goes before
 * the deploy succeeds (go-to-k/cdkd#6713): the {@link earlyDeletedOld} verdict
 * the rollback will reach, in the plan's tense. `'recreate'` is a
 * `--recreate-via-*` target, deleted first unless its replacement takes
 * another name, which only the deploy's name probe learns.
 */
export type PlannedEarlyDelete = 'before-create' | 'during-deploy' | 'recreate';

/** The consequence, worded as the rollback words it, for the plan's lines. */
export const PLANNED_EARLY_DELETE_CONSEQUENCE =
  "a failed deploy's rollback does not restore what AWS held for it beyond its recorded properties";

/** The plan's clause: when the deploy deletes the old resource, and what a rollback then lacks. */
export function plannedEarlyDeleteNote(kind: PlannedEarlyDelete): string {
  const when =
    kind === 'during-deploy'
      ? 'deletes the old resource before the deploy succeeds'
      : kind === 'recreate'
        ? 'deletes the old resource before creating its replacement (unless the replacement takes another name)'
        : 'deletes the old resource before creating its replacement';
  return `the deploy ${when}, so ${PLANNED_EARLY_DELETE_CONSEQUENCE}`;
}
