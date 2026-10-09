import type { ResourceState } from '../../types/state.js';
import type { Logger } from '../../types/config.js';
import { equalIdNamesDifferentResources } from '../type-change-guard.js';
import { effectiveDeletionPolicy } from '../../provisioning/final-snapshot.js';
import { CdkdError } from '../../utils/error-handler.js';
import { markNonRetryable } from '../retryable-errors.js';
import {
  type OldTypeSources,
  nonEmptyString,
  NESTED_STACK_RESOURCE_TYPE,
  type CompletedOperation,
  type RollbackExecutorContext,
  type RollbackActionKind,
  type FailedOperation,
  type FailedOpActionKind,
  type FailedOpPlanItem,
  type RollbackPlanItem,
} from './types.js';
import {
  refusalResourceType,
  orphanRemedy,
  ownRemedyError,
  refusalLogicalId,
  effectiveProvisionedBy,
  rollbackRetainsNewResource,
  rollbackCannotAddress,
  shownLogicalId,
} from './messages.js';
import { hasAddressablePhysicalId } from '../../state/malformed-resources-bag.js';
import { samePhysicalId } from '../replacement-name-holder/name-keys.js';
import { safeMsg } from '../../utils/display-safe.js';
import { RESOURCE_IDENTITY_TIMEOUT_MS } from './orphan-identity.js';
import type { ResourceIdentityVerdict } from '../../types/resource.js';

/** The two places a journal can name the old resource's type, each `undefined` when unusable. */
function journaledOldTypes(op: OldTypeSources): {
  stamped: string | undefined;
  recorded: string | undefined;
} {
  return {
    stamped: nonEmptyString(op.previousResourceType) ? op.previousResourceType : undefined,
    recorded: nonEmptyString(op.previousState?.resourceType)
      ? op.previousState.resourceType
      : undefined,
  };
}

/**
 * Which type the OLD half of a replacement op routes on, or why that cannot be
 * decided (issue [#2668](https://github.com/go-to-k/cdkd/issues/2668)).
 *
 * Two sources name it: {@link CompletedOperation.previousResourceType} (written
 * by a binary that knows about Type changes) and `previousState.resourceType`
 * (journaled by every binary, inside the previous record). A legacy journal has
 * only the second, which is enough. The verdict is REFUSED rather than guessed
 * in three shapes, because a wrong answer dispatches a create and a delete at
 * the wrong service:
 *
 *   - neither source names a type (a hand-edited or torn op) — falling back to
 *     `op.resourceType` is exactly the single-type assumption this replaces;
 *   - the two sources disagree — one of them was edited, and nothing says which;
 *   - the types differ with `AWS::CloudFormation::Stack` on either side. The
 *     deploy refuses that pair at plan time (`type-change-guard.ts`), so only a
 *     journal from a binary older than that guard carries one, and what that
 *     deploy left behind is not knowable from the journal: its mis-routed
 *     delete may have destroyed the child it had just created.
 */
export function resolveReplacementOldType(
  op: OldTypeSources
): { ok: true; oldType: string } | { ok: false; reason: string } {
  const { stamped, recorded } = journaledOldTypes(op);
  if (stamped !== undefined && recorded !== undefined && stamped !== recorded) {
    return {
      ok: false,
      reason:
        `the journal names two different types for the old resource ` +
        // Described, not `safe()`: this reason is quoted on the unroutable
        // refusal's first line, which names `cdkd deploy` (go-to-k/cdkd#4214).
        `(previousResourceType ${refusalResourceType(stamped)}, ` +
        `previousState.resourceType ${refusalResourceType(recorded)})`,
    };
  }
  const oldType = stamped ?? recorded;
  if (oldType === undefined) {
    return { ok: false, reason: "the journal does not record the old resource's type" };
  }
  if (
    oldType !== op.resourceType &&
    (oldType === NESTED_STACK_RESOURCE_TYPE || op.resourceType === NESTED_STACK_RESOURCE_TYPE)
  ) {
    return {
      ok: false,
      reason:
        `it is a Type change between ${refusalResourceType(oldType)} and ` +
        `${refusalResourceType(op.resourceType)}, and cdkd does ` +
        `not replace a nested stack with, or by, a single resource`,
    };
  }
  return { ok: true, oldType };
}

/**
 * The one refusal both the `refuse-replacement-routing` arm and the
 * `reverse-replacement` arm's own guard raise. `markNonRetryable`: the verdict
 * is read off the journal alone, so no retry can change it.
 */
export function unroutableReplacementError(
  op: CompletedOperation,
  reason: string,
  remedyCtx: Pick<RollbackExecutorContext, 'nestedChildRevert' | 'nestedChildStack' | 'region'>
): Error {
  // The remedy is a labelled last line built by `orphanRemedy`, which owns
  // the gate on the id and the sentence for a withheld one.
  const remedy = orphanRemedy(op.logicalId, remedyCtx);
  return ownRemedyError(
    markNonRetryable(
      new CdkdError(
        `Cannot reverse the replacement of ${refusalLogicalId(op.logicalId)} ` +
          `(${refusalResourceType(op.resourceType)}): ` +
          `${reason}, so cdkd will not guess which provider re-creates the old resource. Nothing ` +
          `was changed. The journal is kept: fix forward with cdkd deploy` +
          (remedy.offered
            ? `, or leave this resource as it is and let the rest of the rollback proceed by ` +
              `re-running with the command below.`
            : '.') +
          `${remedy.clause}${remedy.line}`,
        'ROLLBACK_REPLACEMENT_UNROUTABLE'
      )
    )
  );
}

/**
 * True when the op changed the resource's `Type`. `false` when the old type is
 * not recorded at all: that shape is refused by {@link resolveReplacementOldType}
 * where it matters, and must not by itself turn an in-place op into a
 * replacement.
 */
export function isTypeChangeOp(op: OldTypeSources): boolean {
  const { stamped, recorded } = journaledOldTypes(op);
  return (
    (stamped !== undefined && stamped !== op.resourceType) ||
    (recorded !== undefined && recorded !== op.resourceType)
  );
}

/**
 * True when the op recorded a replacement: the old physical id differs from the
 * new one, OR the resource's `Type` changed (issue #2668). The second arm is
 * not redundant — two types' physical-id namespaces can overlap (a log group
 * and a Lambda function are both addressed by a bare name), so a Type change
 * can keep the id, and classified as an in-place `revert` it would hand the
 * NEW resource's id to an `update()` of either type. The old physical resource
 * is already gone / orphaned, so an in-place revert is best-effort — the plan
 * labels these explicitly.
 */
export function isReplacementOp(op: CompletedOperation): boolean {
  return (
    op.changeType === 'UPDATE' &&
    op.previousState?.physicalId !== undefined &&
    // go-to-k/cdkd#4615: a changed id is a replacement unless the provider
    // said it updated in place.
    ((op.previousState.physicalId !== op.physicalId && op.wasReplaced !== false) ||
      isTypeChangeOp(op) ||
      // Issue #3892: an equal id can still be two resources (a Glue table
      // whose id is placed by DatabaseName), and an in-place revert of such
      // an op would aim the old properties at the NEW table.
      equalIdNamesDifferentResources({
        resourceType: op.resourceType,
        physicalId: op.physicalId,
        oldProperties: op.previousState.properties,
        newProperties: op.properties,
      }))
  );
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null) return a === b;
  if (typeof a !== typeof b) return false;
  if (typeof a !== 'object') return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const ak = Object.keys(ao);
  if (ak.length !== Object.keys(bo).length) return false;
  for (const k of ak) {
    if (!Object.prototype.hasOwnProperty.call(bo, k)) return false;
    if (!deepEqual(ao[k], bo[k])) return false;
  }
  return true;
}

/**
 * Classify what a single op WILL do against the current state, without
 * touching AWS. Pure — used both by the command's plan preview and by the
 * replayer (which re-derives the action to stay in lock-step with the
 * plan). `orphanLogicalIds` mirrors `cdk rollback --orphan`.
 */
export function classifyRollbackOp(
  op: CompletedOperation,
  stateResources: Record<string, ResourceState>,
  orphanLogicalIds: Set<string>
): RollbackActionKind {
  const replacement = isReplacementOp(op);

  if (op.changeType === 'DELETE') return 'unrecoverable-delete';

  if (orphanLogicalIds.has(op.logicalId)) return 'orphan-flag';

  if (op.changeType === 'CREATE') {
    const current = stateResources[op.logicalId];
    if (!current) return 'skip-already-done';
    // The RAW id, unlike the replacement comparison below: an unusable one
    // over a usable record is a mismatch, which sends nothing. Read as
    // unrecorded it would reach `replayDelete`, where a nested-stack record
    // is exempt and its provider deletes the child by NAME.
    if (op.physicalId !== undefined && current.physicalId !== op.physicalId) {
      return 'skip-mismatch';
    }
    // The CURRENT record's DeletionPolicy governs the rollback delete
    // (issue #1358): `Retain` keeps the resource (orphan), `Snapshot`
    // snapshots it first, everything else plain-deletes. Absent is
    // CloudFormation's default (issue #4030).
    const policy = effectiveDeletionPolicy(
      current.resourceType,
      current.deletionPolicy,
      current.properties
    );
    if (policy === 'Retain') return 'orphan-retain';
    if (policy === 'Snapshot') return 'delete-with-final-snapshot';
    return 'delete';
  }

  // UPDATE
  const current = stateResources[op.logicalId];
  if (!current) return 'skip-absent';
  if (replacement) {
    // Replacement op (#1199): the OLD physical resource was destroyed (or
    // orphaned under UpdateReplacePolicy: Retain) and the NEW one carries a
    // different physical id. An in-place revert is guaranteed to throw on
    // the immutable property, so reverse the replacement instead.
    // `&& sameTypeAsOld` (issue #2668): across a Type change an equal id is
    // not the same resource (overlapping namespaces), so "state already points
    // at the old id" additionally needs the record to BE the old type. An
    // unrecorded type on either side keeps the pre-#2668 id-only reading.
    const oldTypes = journaledOldTypes(op);
    const oldTypeForCompare = isTypeChangeOp(op)
      ? (oldTypes.stamped ?? oldTypes.recorded)
      : undefined;
    const sameTypeAsOld =
      oldTypeForCompare === undefined ||
      !nonEmptyString(current.resourceType) ||
      current.resourceType === oldTypeForCompare;
    if (
      current.physicalId === op.previousState!.physicalId &&
      sameTypeAsOld &&
      // Issue #3892: the equal id may be the NEW resource (a Glue table in
      // another database); it is the old one only when its record says so.
      !equalIdNamesDifferentResources({
        resourceType: op.resourceType,
        physicalId: current.physicalId,
        oldProperties: op.previousState!.properties,
        newProperties: current.properties,
      })
    ) {
      // State already points at the old physical id — a prior reverse-
      // replacement (or manual fix) already reverted this op.
      return 'skip-already-done';
    }
    // go-to-k/cdkd#4628: a record cdkd cannot address goes to the reverse
    // arm whose guard declines it -- the readopt arm REFUSES, keeping the
    // journal, which alone names the retained old resource; the re-create
    // arm skips. Compared with the op's id below it would be `skip-mismatch`,
    // a warning that pops the segment, worded as a later attempt's work.
    const retainedOld =
      op.oldResourceRetained ?? op.previousState!.updateReplacePolicy === 'Retain';
    if (
      rollbackCannotAddress(
        current,
        op.resourceType,
        current.provisionedBy ?? op.provisionedBy,
        current.physicalId
      )
    ) {
      if (!resolveReplacementOldType(op).ok) return 'refuse-replacement-routing';
      return retainedOld ? 'reverse-replacement-readopt' : 'reverse-replacement';
    }
    // An op id that is present but cannot name a resource proves nothing
    // about the usable record. Compared raw below it would be
    // `skip-mismatch`, which sends nothing -- right for the re-create arm, but
    // on a retained replacement it pops the segment, the only record of the
    // retained old resource. So the op goes to the readopt arm, whose guards
    // decide: they refuse it (journal kept) unless the record holds that same
    // value or the new copy is retained, neither of which deletes by the
    // unproven id. An ABSENT op id is not routed here: it was never recorded
    // (main's reading) and takes the comparison below.
    if (retainedOld && op.physicalId !== undefined && !hasAddressablePhysicalId(op)) {
      if (!resolveReplacementOldType(op).ok) return 'refuse-replacement-routing';
      return 'reverse-replacement-readopt';
    }
    if (op.physicalId !== undefined && current.physicalId !== op.physicalId) {
      // Neither the old nor the recorded new id. An AUTO-NAMED resource
      // re-created by a prior reverse-replacement lands here (its fresh
      // physical id matches neither) — recognize it by the properties
      // already matching the previous state. Anything else is a later
      // attempt's replacement; manual attention required.
      // `&& sameTypeAsOld` (issue #2668): two types can declare one identical
      // bag, so equal properties alone do not make the record the old one.
      if (sameTypeAsOld && deepEqual(current.properties, op.previousState!.properties)) {
        return 'skip-already-done';
      }
      return 'skip-mismatch';
    }
    // `Retain` orphaned the old resource instead of deleting it, so it still
    // exists and can be re-adopted without a re-create. THREE engine paths
    // produce that state: the property-driven create-then-destroy path skips
    // the delete, the `--replace` delete-first fallbacks refuse Retain
    // outright, and since issue #2518 the update-failure replacement fallback
    // is create-ONLY under Retain too. Before #2518 that third path DELETED
    // the old resource whatever the policy said, so this classification
    // re-adopted a physical id that no longer existed.
    //
    // Issue [#2603](https://github.com/go-to-k/cdkd/issues/2603): the two
    // sides used to ask the question of DIFFERENT sources — every engine path
    // decides from the TEMPLATE being applied, while this read the PREVIOUS
    // STATE record — so they disagreed on exactly the deploy that CHANGES
    // `UpdateReplacePolicy`, in both directions:
    //
    //   - ADDING `Retain`: the deploy orphans the old resource while
    //     `previousState.updateReplacePolicy` is still absent, so the stale
    //     read picked the plain `reverse-replacement` arm and RE-CREATED a
    //     resource that is still alive — a duplicate, or an `AlreadyExists`
    //     failure for a user-named type.
    //   - DROPPING `Retain`: the previous deploy persisted `Retain` into
    //     state, the current template omits it, so the engine correctly
    //     DELETES the old resource — and the stale read then classified
    //     `reverse-replacement-readopt` and pointed state at the deleted old
    //     physicalId with NO re-create. State ends up naming a resource that
    //     does not exist, which no later deploy detects as absent. Strictly
    //     worse than the ADD direction, where at least both resources are
    //     real.
    //
    // Both are closed by asking the ENGINE what it did rather than
    // re-deriving it: {@link CompletedOperation.oldResourceRetained} is
    // stamped at the moment the deploy skipped (or ran) the old resource's
    // delete. `??`, not `||` — an explicit `false` is the DROP direction's
    // whole point and must not fall through to the previous-state read.
    //
    // The fallback survives for ONE case: a journal written by a pre-#2603
    // binary, whose ops carry no verdict at all. There the previous-state
    // read is the only information that exists, so it stays — no worse than
    // that binary's own behaviour, and unreachable for anything a current
    // binary wrote.
    //
    // `Snapshot` is NOT retained on replacement (the engine plain-deletes) —
    // it re-creates like the default policy.
    //
    // Issue #2668, AFTER the idempotent skips above (an op that is already
    // reverted needs no routing) and BEFORE either reverse arm: both dispatch
    // on two types, and a replay that cannot name the old one must not guess.
    if (!resolveReplacementOldType(op).ok) return 'refuse-replacement-routing';
    const retained = op.oldResourceRetained ?? op.previousState!.updateReplacePolicy === 'Retain';
    return retained ? 'reverse-replacement-readopt' : 'reverse-replacement';
  }
  if (op.previousState && deepEqual(current.properties, op.previousState.properties)) {
    // Already reverted (idempotent re-run).
    return 'skip-already-done';
  }
  return 'revert';
}

/**
 * Classify what reverting a FAILED in-flight op (issue #1198) will do
 * against the current state, without touching AWS. Pure — used by both the
 * command's `--revert-failed` plan preview and {@link replayFailedOperations}.
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
    if (!op.physicalId) return 'skip-failed-unknown';
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

/**
 * Build the full ordered plan for a list of ops (one segment). Mirrors the
 * replay order: UPDATE/DELETE first (reverse completion order), then CREATE
 * deletions in dependency-aware order.
 */
export function planRollback(
  operations: CompletedOperation[],
  stateResources: Record<string, ResourceState>,
  orphanLogicalIds: Set<string> = new Set()
): RollbackPlanItem[] {
  const { createOps, otherOps } = partitionOps(operations);
  const ordered: CompletedOperation[] = [
    ...[...otherOps].reverse(),
    ...sortRollbackCreates(createOps, stateResources),
  ];
  return ordered.map((op) => {
    const action = classifyRollbackOp(op, stateResources, orphanLogicalIds);
    return {
      op,
      action,
      replacement: isReplacementOp(op),
      effectiveProvisionedBy: effectiveProvisionedBy(
        stateResources[op.logicalId],
        op.provisionedBy
      ),
      // Scoped to the two arms that would otherwise DELETE the new copy
      // (issue #2598) — the same record carries `updateReplacePolicy` for
      // ops this question does not apply to, and an unscoped read would
      // annotate a `revert` or a `skip-*` row with a retention that decides
      // nothing there.
      retainsNewResource:
        (action === 'reverse-replacement' || action === 'reverse-replacement-readopt') &&
        rollbackRetainsNewResource(stateResources[op.logicalId]),
    };
  });
}

export function partitionOps(operations: CompletedOperation[]): {
  createOps: CompletedOperation[];
  otherOps: CompletedOperation[];
} {
  const createOps: CompletedOperation[] = [];
  const otherOps: CompletedOperation[] = [];
  for (const op of operations) {
    if (op.changeType === 'CREATE') createOps.push(op);
    else otherOps.push(op);
  }
  return { createOps, otherOps };
}

/**
 * Sort CREATE rollback operations so that resources depending on others are
 * deleted first (reverse dependency order), using state dependencies. Same
 * algorithm as the pre-extraction `DeployEngine.sortRollbackCreates`.
 */
export function sortRollbackCreates(
  createOps: CompletedOperation[],
  stateResources: Record<string, ResourceState>,
  logger?: Logger
): CompletedOperation[] {
  const opMap = new Map<string, CompletedOperation>();
  const deleteIds = new Set<string>();
  for (const op of createOps) {
    opMap.set(op.logicalId, op);
    deleteIds.add(op.logicalId);
  }

  const dependedBy = new Map<string, Set<string>>();
  for (const id of deleteIds) {
    if (!dependedBy.has(id)) dependedBy.set(id, new Set());
  }

  for (const id of deleteIds) {
    const resource = stateResources[id];
    if (!resource?.dependencies) continue;
    for (const dep of resource.dependencies) {
      if (!deleteIds.has(dep)) continue;
      // id depends on dep → dep must be deleted AFTER id
      if (!dependedBy.has(dep)) dependedBy.set(dep, new Set());
      dependedBy.get(dep)!.add(id);
    }
  }

  const sorted: CompletedOperation[] = [];
  let remaining = new Set(deleteIds);

  while (remaining.size > 0) {
    const level: string[] = [];
    for (const id of remaining) {
      const dependents = dependedBy.get(id);
      const hasPendingDependents = dependents
        ? [...dependents].some((d) => remaining.has(d))
        : false;
      if (!hasPendingDependents) level.push(id);
    }

    if (level.length === 0) {
      logger?.warn(
        `Circular dependency detected in rollback order, processing remaining ${remaining.size} resources`
      );
      for (const id of remaining) {
        const op = opMap.get(id);
        if (op) sorted.push(op);
      }
      break;
    }

    for (const id of level) {
      const op = opMap.get(id);
      if (op) sorted.push(op);
    }
    remaining = new Set([...remaining].filter((id) => !level.includes(id)));
  }

  logger?.debug(`Rollback CREATE deletion order: ${sorted.map((op) => op.logicalId).join(' → ')}`);
  return sorted;
}

/**
 * go-to-k/cdkd#4690: the delete-first reversal deletes the NEW resource before
 * re-creating the old one from `previousState.properties`. When those
 * properties name a resource that another op of the SAME segment took away
 * (a replacement that did not keep its old copy, or a DELETE), the rollback
 * cannot bring that resource back under the id they name: the re-create then
 * fails after the new resource is gone, and the resource is lost (a target
 * group replaced create-first while its listener was recreated delete-first).
 * Such an op keeps the create-first order instead, whose failure keeps the new
 * resource. Keyed by the op object, like {@link markProvenDistinctFromRecord}:
 * computed per replay, never journaled.
 */
const deleteFirstBlockedBy = new WeakMap<
  CompletedOperation,
  { logicalId: string; physicalId: string }
>();

/**
 * Mark each delete-first op of one segment whose old properties reference an
 * id {@link deleteFirstBlockedBy} describes. Only the PROPERTIES are scanned:
 * the re-create sends `previousState.properties`, and its attributes never
 * reach `create()`.
 *
 * The match errs toward blocking: an exact string leaf, or, for an id of 16+
 * characters (an ARN, a URL), a leaf containing it, so an id embedded in a
 * document counts. A false block only restores the create-first order the
 * rollback used before #4690; a missed one loses a resource.
 */
export function markDeleteFirstBlocked(operations: readonly CompletedOperation[]): void {
  const gone: Array<{ logicalId: string; physicalId: string }> = [];
  for (const op of operations) {
    const prev = op.previousState?.physicalId;
    if (typeof prev !== 'string' || prev === '') continue;
    const replacedAway =
      op.changeType === 'DELETE' ||
      (op.changeType === 'UPDATE' &&
        op.physicalId !== prev &&
        op.wasReplaced !== false &&
        op.oldResourceRetained !== true);
    if (replacedAway) gone.push({ logicalId: op.logicalId, physicalId: prev });
  }
  if (gone.length === 0) return;
  for (const op of operations) {
    if (op.oldDeletedBeforeCreate !== true) continue;
    const props = op.previousState?.properties;
    if (props === undefined) continue;
    const hit = gone.find(
      (g) =>
        g.logicalId !== op.logicalId &&
        someStringLeaf(
          props,
          (leaf) =>
            leaf === g.physicalId || (g.physicalId.length >= 16 && leaf.includes(g.physicalId))
        )
    );
    if (hit) deleteFirstBlockedBy.set(op, hit);
  }
}

/** The op and id that keep `op` off the delete-first reversal, if any. */
export function deleteFirstBlocker(
  op: CompletedOperation
): { logicalId: string; physicalId: string } | undefined {
  return deleteFirstBlockedBy.get(op);
}

function someStringLeaf(value: unknown, test: (leaf: string) => boolean, depth = 0): boolean {
  if (typeof value === 'string') return test(value);
  if (depth > 64 || value === null || typeof value !== 'object') return false;
  const children = Array.isArray(value) ? value : Object.values(value);
  return children.some((child) => someStringLeaf(child, test, depth + 1));
}
