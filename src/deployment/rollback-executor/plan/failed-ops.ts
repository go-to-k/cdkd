import type { ResourceState } from '../../../types/state.js';
import { effectiveDeletionPolicy } from '../../../provisioning/final-snapshot.js';
import {
  type RollbackExecutorContext,
  type FailedOperation,
  type FailedOpActionKind,
  type FailedOpPlanItem,
} from '../types.js';
import { effectiveProvisionedBy, shownLogicalId } from '../messages.js';
import { samePhysicalId } from '../../replacement-name-holder/name-keys.js';
import { safeMsg } from '../../../utils/display-safe.js';
import { RESOURCE_IDENTITY_TIMEOUT_MS } from '../orphan-identity.js';
import type { ResourceIdentityVerdict } from '../../../types/resource.js';
import { isTypeChangeOp } from './classify.js';

/**
 * A failed CREATE that recorded no physical id: `classifyFailedOp` plans it
 * as `skip-failed-unknown` whatever state holds — the revert cannot address
 * it. Shared with the deploy's `--revert-failed` remedy (go-to-k/cdkd#6204).
 */
export function failedCreateRecordedNoPhysicalId(op: FailedOperation): boolean {
  return op.changeType === 'CREATE' && !op.physicalId;
}

/**
 * Classify what reverting a FAILED in-flight op (issue #1198) will do
 * against the current state, without touching AWS. Pure — used by both the
 * command's `--revert-failed` plan preview and `replayFailedOperations`.
 */
export function classifyFailedOp(
  op: FailedOperation,
  stateResources: Record<string, ResourceState>,
  /** The segment's other failed ops (go-to-k/cdkd#4604's replacement orphan). */
  siblings: readonly FailedOperation[] = []
): FailedOpActionKind {
  if (op.changeType === 'DELETE') {
    // The delete FAILED, so the resource is still in place and state still
    // records it — there is nothing to revert.
    return 'skip-failed-noop';
  }
  const current = stateResources[op.logicalId];
  if (op.changeType === 'CREATE') {
    // A failed CREATE normally records nothing (the provider threw before
    // returning a physical id) — the remote state is unknown. Falsy, not
    // `=== undefined`: an empty physical id identifies nothing, and letting
    // it through would reach a delete (and a final-snapshot identifier) built
    // from `''`. Matches `replaySingle`'s `!op.physicalId` guard on the
    // completed-CREATE path, which is what lets both share
    // `prepareCreateRollbackFinalSnapshot`.
    // `!op.physicalId` repeats the predicate only to narrow the type below.
    if (failedCreateRecordedNoPhysicalId(op) || !op.physicalId) return 'skip-failed-unknown';
    // go-to-k/cdkd#1710: a CREATE whose provider proved it made the resource
    // before failing. No state record EVER held it, so any record now holding
    // its logical id or its physical id belongs to a LATER operation (a
    // re-create under the same name, a `cdkd import` under another id) and
    // owns that resource; deleting it from this journal entry would destroy
    // what state tracks. Only with no such record is this entry the
    // resource's sole record, deleted per its JOURNALED policy.
    // `physicalIdRecoveredFromError: false` is the supersede pass's verdict
    // (`demoteSupersededOrphans`): later activity may own the resource, so it
    // is left alone and named for manual attention.
    if (op.physicalIdRecoveredFromError === false) return 'skip-failed-superseded';
    if (op.physicalIdRecoveredFromError === true) {
      // go-to-k/cdkd#4604: a replacement's new resource shares its logical id
      // with the resource it was replacing, so a record still naming THAT
      // resource is no later owner of this one. go-to-k/cdkd#4606: nor is a
      // record a successful deploy's settle proved holds another resource.
      if (current) {
        // go-to-k/cdkd#4692: under the type's case rule, as every check below
        // whose match keeps the orphan.
        if (
          current.physicalId === op.physicalId ||
          (current.resourceType === op.resourceType &&
            typeof current.physicalId === 'string' &&
            samePhysicalId(op.resourceType, current.physicalId, op.physicalId))
        ) {
          return 'skip-failed-noop';
        }
        if (!isReplacedRecord(op, current) && !isProvenDistinctRecord(op, current)) {
          return 'skip-failed-mismatch';
        }
      }
      if (stateHoldsPhysicalId(stateResources, op.resourceType, op.physicalId)) {
        return 'skip-failed-noop';
      }
      const orphanPolicy = effectiveDeletionPolicy(
        op.resourceType,
        op.deletionPolicy,
        op.attemptedProperties
      );
      if (orphanPolicy === 'Retain') return 'orphan-failed-create-retain';
      if (orphanPolicy === 'Snapshot') return 'delete-failed-create-with-final-snapshot';
      return 'delete-failed-create';
    }
    if (!current) return 'skip-failed-noop'; // already cleaned up (re-run)
    // go-to-k/cdkd#4552: state names another resource under this id, so the
    // one the failed CREATE recorded may still exist, untracked. Not deleted
    // (state does not own it), but warned — `skip-mismatch`'s twin. An id a
    // marked `cdkd import` adopted never reaches here (`splitImportedOps`).
    if (current.physicalId !== op.physicalId) return 'skip-failed-mismatch';
    // The CURRENT record's DeletionPolicy governs this delete exactly as it
    // governs the COMPLETED-CREATE rollback above (issue #1362). Reaching
    // here means AWS did provision the resource (a physical id is recorded
    // AND state agrees), so it is a real resource the policy speaks about —
    // "the CREATE failed" is not a licence to ignore the user's Retain /
    // Snapshot. CloudFormation applies the policy to a failed create's
    // rollback delete too; `RetainExceptOnCreate` exists precisely to opt
    // OUT of that for `Retain`, and it keeps deleting here. Absent is
    // CloudFormation's default (issue #4030).
    const policy = effectiveDeletionPolicy(
      current.resourceType,
      current.deletionPolicy,
      current.properties
    );
    if (policy === 'Retain') return 'orphan-failed-create-retain';
    if (policy === 'Snapshot') return 'delete-failed-create-with-final-snapshot';
    return 'delete-failed-create';
  }
  // UPDATE
  if (!current || !op.previousState) return 'skip-failed-absent';
  // go-to-k/cdkd#4604: a replacement whose create made its new resource and
  // failed. The new resource is the sibling orphan entry's; this op applied
  // nothing to the record it names (create-first left the old resource alone,
  // delete-first removed it), so it is never force-reverted: that would send
  // AWS the revert of a change it never received, or, once a later operation
  // moved the record, aim this op's previous properties at that one's resource.
  if (op.replacementOrphaned !== undefined || replacementNeverSwapped(op, siblings)) {
    // Delete-first, record unmoved: it names a resource the replacement removed.
    return current.physicalId === op.physicalId &&
      (op.replacementOrphaned === 'delete-first' || replacedResourceDeleted(op, siblings))
      ? 'skip-failed-replaced-deleted'
      : 'skip-failed-noop';
  }
  // Issue #2668: a failed Type change was a REPLACEMENT in flight, and the
  // force-revert below is an in-place `update()` routed on `op.resourceType` —
  // the NEW type — against the OLD resource's physical id. There is no in-place
  // revert of a replacement; say so instead of aiming one type's update at
  // another type's resource.
  if (isTypeChangeOp(op)) return 'skip-failed-type-change';
  return 'revert-failed-update';
}

/**
 * Whether `op` is a proven orphan a failed replacement left
 * (go-to-k/cdkd#4604): the record under its logical id, if any, is never its
 * own, so an arm acting on the orphan neither reads nor drops that record.
 */
export function isReplacementOrphan(op: FailedOperation): boolean {
  return op.changeType === 'CREATE' && op.replacedPhysicalId !== undefined;
}

/**
 * Whether `record` is still the resource the replacement that left `op` was
 * replacing — same physical id AND type — rather than anything a later
 * operation put under the logical id.
 */
export function isReplacedRecord(op: FailedOperation, record: ResourceState | undefined): boolean {
  return (
    isReplacementOrphan(op) &&
    record !== undefined &&
    record.physicalId === op.replacedPhysicalId &&
    record.resourceType === op.replacedResourceType
  );
}

/**
 * The state record a failed op's arms act on: none for a replacement orphan
 * ({@link isReplacementOrphan}), whose logical id holds another resource.
 */
export function failedOpOwnRecord(
  op: FailedOperation,
  stateResources: Record<string, ResourceState>
): ResourceState | undefined {
  return recordUnderIdIsNotOwn(op, stateResources) ? undefined : stateResources[op.logicalId];
}

/**
 * go-to-k/cdkd#4606: proven orphans a successful deploy's settle proved, by
 * the provider's live identity read (`isSameResource`), to be a resource
 * OTHER than the one the record under their logical id holds (a
 * fix-forward's new resource). Keyed by the op object, so the verdict lives
 * only for the settle that read it: never journaled, and a re-read journal
 * (a later run) carries none.
 */
const provenDistinctFrom = new WeakMap<
  FailedOperation,
  { physicalId: string; resourceType: string }
>();

/** Record the settle's `'different'` verdict for `op` against `record`. */
export function markProvenDistinctFromRecord(op: FailedOperation, record: ResourceState): void {
  provenDistinctFrom.set(op, { physicalId: record.physicalId, resourceType: record.resourceType });
}

/**
 * Whether `record` is the very record (same physical id AND type) the
 * settle proved `op`'s resource distinct from. A record that moved since
 * carries no such proof.
 */
export function isProvenDistinctRecord(
  op: FailedOperation,
  record: ResourceState | undefined
): boolean {
  const verdict = provenDistinctFrom.get(op);
  return (
    verdict !== undefined &&
    record !== undefined &&
    record.physicalId === verdict.physicalId &&
    record.resourceType === verdict.resourceType
  );
}

/**
 * Whether the record under `op`'s logical id, if any, is not `op`'s own: a
 * replacement orphan's (go-to-k/cdkd#4604), or one proven a different
 * resource (go-to-k/cdkd#4606). An arm acting on the orphan then neither
 * reads nor drops that record.
 */
export function recordUnderIdIsNotOwn(
  op: FailedOperation,
  stateResources: Record<string, ResourceState>
): boolean {
  return (
    isReplacementOrphan(op) ||
    isProvenDistinctRecord(
      op,
      Object.hasOwn(stateResources, op.logicalId) ? stateResources[op.logicalId] : undefined
    )
  );
}

/**
 * Whether `siblings` hold the replacement orphan the failed UPDATE `op` left
 * (go-to-k/cdkd#4604): same logical id, naming `op`'s physical id as the
 * record it was replacing. Demoted or not, it proves the replacement's create
 * ran and the record was never swapped to a new resource.
 */
export function replacementNeverSwapped(
  op: FailedOperation,
  siblings: readonly FailedOperation[]
): boolean {
  return siblings.some(
    (s) =>
      s !== op &&
      isReplacementOrphan(s) &&
      s.logicalId === op.logicalId &&
      s.replacedPhysicalId === op.physicalId
  );
}

/** Whether the replacement that left `op`'s orphan deleted the old resource first. */
function replacedResourceDeleted(
  op: FailedOperation,
  siblings: readonly FailedOperation[]
): boolean {
  return siblings.some(
    (s) =>
      s !== op &&
      isReplacementOrphan(s) &&
      s.logicalId === op.logicalId &&
      s.replacedPhysicalId === op.physicalId &&
      s.replacedResourceDeleted === true
  );
}

/**
 * Whether any state record of `resourceType` holds `physicalId`, under the
 * type's case rule (go-to-k/cdkd#4692).
 */
function stateHoldsPhysicalId(
  stateResources: Record<string, ResourceState>,
  resourceType: string,
  physicalId: string
): boolean {
  return Object.values(stateResources).some(
    (r) =>
      r?.resourceType === resourceType &&
      typeof r.physicalId === 'string' &&
      samePhysicalId(resourceType, r.physicalId, physicalId)
  );
}

/**
 * Demote every proven failed-CREATE orphan (go-to-k/cdkd#1710) that later
 * activity may own, setting `physicalIdRecoveredFromError` to `false` so
 * {@link classifyFailedOp} skips it with a warning (`skip-failed-superseded`)
 * instead of deleting it.
 *
 * The orphan was never in state, so ownership of its resource can only have
 * moved through a later journal entry or a rollback-orphan record. Demoted
 * when, for the orphan's resource type:
 *
 * - a NEWER segment holds an op whose physical id or `previousState` physical
 *   id is the orphan's (a re-create, an import, an update of that resource —
 *   a newer PROVEN orphan of the same id too: that newer entry's replay, with
 *   its own `DeletionPolicy`, governs the resource);
 * - a NEWER segment holds a COMPLETED CREATE of that type, whose physical id
 *   may be the orphan's name (conservative);
 * - a `supersededLogicalIds` from the orphan's own segment on names its
 *   logical id (a newer segment was removed after its revert; only logical ids
 *   survive it, so the match is conservative too); or
 * - a rollback-orphan record holds its logical id or its physical id (a later
 *   rollback RETAINED a re-created resource and re-recorded its segment
 *   without the op).
 *
 * NOT demoted by a newer segment that merely exists: the common retry after
 * the failure collides with the orphan's name, journals a failed CREATE with
 * no physical id, and owns nothing. The classifier separately skips an orphan
 * whose ids a state row holds. Mutates the ops in place; returns the count.
 */
export function demoteSupersededOrphans(
  segments: ReadonlyArray<{
    operations?: ReadonlyArray<SupersedeCandidate> | undefined;
    failedOperations?: FailedOperation[] | undefined;
    supersededLogicalIds?: string[] | undefined;
  }>,
  orphans: ReadonlyArray<{ logicalId?: unknown; state?: Partial<ResourceState> | undefined }> = []
): number {
  let demoted = 0;
  segments.forEach((segment, s) => {
    for (const op of segment.failedOperations ?? []) {
      if (op.changeType !== 'CREATE' || op.physicalIdRecoveredFromError !== true) continue;
      const newer = segments.slice(s + 1);
      const superseded =
        newer.some(
          (t) =>
            (t.operations ?? []).some((o) => mayOwn(o, op, true)) ||
            (t.failedOperations ?? []).some((o) => mayOwn(o, op, false))
        ) ||
        segments.slice(s).some((t) => t.supersededLogicalIds?.includes(op.logicalId) === true) ||
        orphans.some(
          (o) =>
            o?.logicalId === op.logicalId ||
            (o?.state?.resourceType === op.resourceType &&
              holdsSameId(op.resourceType, o.state?.physicalId, op.physicalId))
        );
      if (superseded) {
        op.physicalIdRecoveredFromError = false;
        demoted++;
      }
    }
  });
  return demoted;
}

/** The fields of a journaled op {@link demoteSupersededOrphans} reads. */
type SupersedeCandidate = {
  logicalId?: string | undefined;
  changeType?: string | undefined;
  resourceType?: string | undefined;
  physicalId?: string | undefined;
  previousState?:
    | { physicalId?: string | undefined; resourceType?: string | undefined }
    | undefined;
};

/** Whether a newer journaled op may own the resource `orphan` names. */
function mayOwn(o: SupersedeCandidate, orphan: FailedOperation, completed: boolean): boolean {
  if (o?.resourceType !== orphan.resourceType) return false;
  if (completed && o.changeType === 'CREATE') return true;
  if (holdsSameId(orphan.resourceType, o.physicalId, orphan.physicalId)) return true;
  return holdsSameId(orphan.resourceType, o.previousState?.physicalId, orphan.physicalId);
}

/**
 * Whether `held` names the orphan's resource `orphanId`, under the type's case
 * rule (go-to-k/cdkd#4692). Two absent ids match, as the exact comparison did.
 */
function holdsSameId(resourceType: string, held: unknown, orphanId: string | undefined): boolean {
  if (typeof held !== 'string' || typeof orphanId !== 'string') return held === orphanId;
  return samePhysicalId(resourceType, held, orphanId);
}

/**
 * Whether a failed op is a journaled proven failed-CREATE orphan
 * (go-to-k/cdkd#1710) — still deletable (`physicalIdRecoveredFromError:
 * true`) or demoted by {@link demoteSupersededOrphans} (`false`). The journal
 * is the only record of its resource, so every default path acts on it
 * before dropping the entry (go-to-k/cdkd#4584): the automatic rollback, a
 * plain `cdkd rollback` and `cdkd destroy` replay it through
 * {@link classifyFailedOp} exactly as `--revert-failed` does.
 */
export function isJournaledOrphan(op: FailedOperation): boolean {
  return op.changeType === 'CREATE' && typeof op.physicalIdRecoveredFromError === 'boolean';
}

/** Build the plan items for a segment's failed ops (issue #1198). */
export function planFailedOps(
  failedOps: FailedOperation[],
  stateResources: Record<string, ResourceState>
): FailedOpPlanItem[] {
  return failedOps.map((op) => ({
    op,
    action: classifyFailedOp(op, stateResources, failedOps),
    effectiveProvisionedBy: effectiveProvisionedBy(
      failedOpOwnRecord(op, stateResources),
      op.provisionedBy
    ),
  }));
}

/**
 * Ops whose {@link recheckMismatchedFailedCreate} at the `cdkd rollback`
 * preview did not prove them distinct. Never journaled, like the proof.
 */
const undecidedAtPreview = new WeakSet<FailedOperation>();

/**
 * go-to-k/cdkd#4754: re-check a `skip-failed-mismatch` verdict on a journaled
 * failed-CREATE orphan, the way a successful deploy's settle does. That settle
 * proves a fix-forward's orphan distinct from the record now under its logical
 * id (`isSameResource`), but keeps the proof only in memory
 * ({@link markProvenDistinctFromRecord}); an entry the settle could not finish
 * (a delete that failed, an S3 bucket it never empties) reaches a later
 * `cdkd destroy` / `cdkd rollback` with no proof, and {@link classifyFailedOp}
 * skips it unchecked: "manual attention" for an orphan that may be gone, and
 * one still there left untracked once the journal goes.
 *
 * Asks the provider the orphan's delete would take whether the record holds
 * the same resource; on `'different'` records the proof and classifies again,
 * so the op takes the delete arm, whose `journaledOrphanKeepReason` still
 * checks the orphan's identity and whether it is gone. Every other answer,
 * a provider without the method, a throw and a read that has not answered
 * within {@link RESOURCE_IDENTITY_TIMEOUT_MS} keep `action`. Any other
 * action, op or record shape is returned as is, with no read.
 *
 * `preview` is the `cdkd rollback` plan the user confirms: an op it could not
 * prove is remembered, and the replay of that same op keeps the skip without
 * asking again, so a skip the user confirmed is never turned into a delete.
 * A proof the preview reached carries to the replay the same way.
 */
export async function recheckMismatchedFailedCreate(
  op: FailedOperation,
  action: FailedOpActionKind,
  stateResources: Record<string, ResourceState>,
  siblings: readonly FailedOperation[],
  ctx: Pick<RollbackExecutorContext, 'providerRegistry' | 'region'> &
    Partial<Pick<RollbackExecutorContext, 'logger'>>,
  timeoutMs: number = RESOURCE_IDENTITY_TIMEOUT_MS,
  preview = false
): Promise<FailedOpActionKind> {
  if (preview && action === 'skip-failed-mismatch') {
    // Every skip the preview shows is remembered unless proven, gated or not:
    // the replay's record may pass a gate the preview's copy did not.
    const rechecked = await recheckMismatchedFailedCreate(
      op,
      action,
      stateResources,
      siblings,
      ctx,
      timeoutMs
    );
    if (rechecked === action) undecidedAtPreview.add(op);
    return rechecked;
  }
  if (
    action !== 'skip-failed-mismatch' ||
    op.changeType !== 'CREATE' ||
    op.physicalIdRecoveredFromError !== true ||
    typeof op.physicalId !== 'string' ||
    op.physicalId === ''
  ) {
    return action;
  }
  const record = Object.hasOwn(stateResources, op.logicalId)
    ? stateResources[op.logicalId]
    : undefined;
  if (
    record === undefined ||
    record.resourceType !== op.resourceType ||
    typeof record.physicalId !== 'string' ||
    record.physicalId === ''
  ) {
    return action;
  }
  if (undecidedAtPreview.has(op)) return action;
  const journaledId = op.physicalId;
  const ask = async (): Promise<ResourceIdentityVerdict> => {
    try {
      const { provider } = ctx.providerRegistry.getProviderFor({
        resourceType: op.resourceType,
        provisionedBy: op.provisionedBy,
      });
      if (typeof provider.isSameResource !== 'function') return 'unknown';
      return await provider.isSameResource(
        journaledId,
        {
          physicalId: record.physicalId,
          ...(record.provisionedBy !== undefined && { provisionedBy: record.provisionedBy }),
        },
        op.resourceType,
        { expectedRegion: ctx.region }
      );
    } catch (error) {
      ctx.logger?.debug(
        safeMsg`Re-check of the kept orphan ${shownLogicalId(op.logicalId)} failed (${error instanceof Error ? error.name : typeof error}); keeping the skip`
      );
      return 'unknown';
    }
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<ResourceIdentityVerdict>((resolve) => {
    timer = setTimeout(() => resolve('unknown'), timeoutMs);
  });
  let verdict: ResourceIdentityVerdict;
  try {
    verdict = await Promise.race([ask(), timedOut]);
  } finally {
    clearTimeout(timer);
  }
  if (verdict !== 'different') {
    return action;
  }
  markProvenDistinctFromRecord(op, record);
  return classifyFailedOp(op, stateResources, siblings);
}

/**
 * {@link planFailedOps}, with {@link recheckMismatchedFailedCreate} applied to
 * each item as the `cdkd rollback` preview.
 */
export async function recheckFailedPlan(
  plan: FailedOpPlanItem[],
  stateResources: Record<string, ResourceState>,
  ctx: Pick<RollbackExecutorContext, 'providerRegistry' | 'region'> &
    Partial<Pick<RollbackExecutorContext, 'logger'>>,
  timeoutMs: number = RESOURCE_IDENTITY_TIMEOUT_MS
): Promise<FailedOpPlanItem[]> {
  const failedOps = plan.map((item) => item.op);
  const out: FailedOpPlanItem[] = [];
  for (const item of plan) {
    const action = await recheckMismatchedFailedCreate(
      item.op,
      item.action,
      stateResources,
      failedOps,
      ctx,
      timeoutMs,
      true
    );
    out.push(
      action === item.action
        ? item
        : {
            ...item,
            action,
            effectiveProvisionedBy: effectiveProvisionedBy(
              failedOpOwnRecord(item.op, stateResources),
              item.op.provisionedBy
            ),
          }
    );
  }
  return out;
}
