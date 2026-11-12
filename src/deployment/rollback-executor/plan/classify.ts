import type { ResourceState } from '../../../types/state.js';
import { equalIdNamesDifferentResources } from '../../type-change-guard.js';
import { effectiveDeletionPolicy } from '../../../provisioning/final-snapshot.js';
import { CdkdError } from '../../../utils/error-handler.js';
import { markNonRetryable } from '../../retryable-errors.js';
import { SECRET_MASK } from '../../secret-redaction.js';
import {
  type OldTypeSources,
  nonEmptyString,
  NESTED_STACK_RESOURCE_TYPE,
  type CompletedOperation,
  type RollbackExecutorContext,
  type RollbackActionKind,
} from '../types.js';
import {
  refusalResourceType,
  orphanRemedy,
  ownRemedyError,
  refusalLogicalId,
  rollbackCannotAddress,
} from '../messages.js';
import { hasAddressablePhysicalId } from '../../../state/malformed-resources-bag.js';
import { isCustomResourceType } from '../../../provisioning/custom-resource-secure-references.js';

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
  // go-to-k/cdkd#6120: the old id is still live, so the op is reverted in
  // place, against the new id.
  if (movedIdLeftForCleanup(op)) return false;
  return (
    op.changeType === 'UPDATE' &&
    op.previousState?.physicalId !== undefined &&
    // go-to-k/cdkd#4615: a changed id is a replacement unless the provider
    // said it updated in place.
    ((op.previousState.physicalId !== op.physicalId && op.wasReplaced !== false) ||
      // go-to-k/cdkd#5096: the forward deleted the old resource and created
      // the new one under the SAME physical id (`--replace` delete-first, a
      // fixed-name `--recreate-via-*`, the update-not-supported fallback): the
      // live resource is the new one, so an in-place revert -- which cannot
      // change a create-only property -- would leave it while the record
      // claims the old one. The replacement is reversed instead.
      sameIdRecreated(op) ||
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

/**
 * go-to-k/cdkd#6120: an UPDATE whose provider `update()` moved the resource
 * to a new physical id and said it left the old one live for the cleanup
 * phase (`oldPhysicalIdLeftForCleanup`: a custom resource whose handler
 * answered a new `PhysicalResourceId`, #6117). CloudFormation reverts such an
 * update with an `Update` to the NEW id carrying the old properties, and
 * deletes whichever id the stack no longer records once the rollback
 * completes; re-creating the old id would send the handler a `Create` for
 * something it still holds. Only the journal mark says so: a journal written
 * before it keeps the reverse-replacement arm.
 */
export function movedIdLeftForCleanup(op: CompletedOperation): boolean {
  return (
    op.changeType === 'UPDATE' &&
    op.oldPhysicalIdLeftForCleanup === true &&
    // Only a custom resource's handler leaves the old id live; a planted mark
    // on any other type keeps the reverse-replacement arm.
    isCustomResourceType(op.resourceType) &&
    op.wasReplaced === true &&
    op.oldDeletedBeforeCreate !== true &&
    typeof op.physicalId === 'string' &&
    typeof op.previousState?.physicalId === 'string' &&
    op.previousState.physicalId !== op.physicalId &&
    !isTypeChangeOp(op)
  );
}

/**
 * go-to-k/cdkd#5096: an UPDATE whose forward deleted the old resource first
 * and re-created it under the same physical id. Only the engine's own stamp
 * says so (`oldDeletedBeforeCreate`); an in-place update the provider
 * reported as such (`wasReplaced: false`) is not one.
 */
export function sameIdRecreated(op: CompletedOperation): boolean {
  return (
    op.oldDeletedBeforeCreate === true &&
    op.wasReplaced !== false &&
    op.physicalId !== undefined &&
    op.previousState?.physicalId === op.physicalId
  );
}

/**
 * go-to-k/cdkd#5096: has a same-id re-create already been reversed? The id
 * cannot say, so the record does, read on the top-level properties the
 * forward CHANGED (the create-only change that forced it among them): the
 * reversal is done when the record holds the old value of every one. A
 * replayed create's own bag (`effectiveProperties`) adds or fills other keys
 * but keeps the requested values of those, and a key both sides redacted the
 * same way compares equal, so neither a re-run nor a redaction difference on
 * an unchanged key reads the wrong way.
 *
 * Without a changed key to read (no journaled forward bag, or equal bags
 * holding the mask, behind which the change may hide) the record cannot
 * tell a reversed op from a pending one: `'undecidable'`, which the
 * reverse-replacement arm refuses before any write
 * ({@link sameIdReversalUndecidable}) rather than skip or delete again.
 */
function sameIdReversalDone(
  op: CompletedOperation,
  current: ResourceState
): boolean | 'undecidable' {
  const before = op.previousState!.properties ?? {};
  const forward = op.properties;
  const now = current.properties ?? {};
  if (forward === undefined) return 'undecidable';
  // Read by OWN key: a template key spelled like an inherited member
  // (`constructor`) must not compare as present on a side that lacks it.
  const own = (bag: Record<string, unknown>, key: string) =>
    Object.hasOwn(bag, key) ? bag[key] : undefined;
  const changed = [...new Set([...Object.keys(before), ...Object.keys(forward)])].filter(
    (key) => !deepEqual(own(before, key), own(forward, key))
  );
  if (changed.length === 0) {
    // Equal bags with nothing redacted: the forward changed no property (a
    // child re-created with its re-created parent), so reversing it again
    // leaves what the reversal would: read it as done. A redacted leaf may
    // hide the change, which the record then cannot show.
    return holdsRedactedLeaf(before) ? 'undecidable' : deepEqual(now, before);
  }
  return changed.every((key) => deepEqual(own(now, key), own(before, key)));
}

/**
 * go-to-k/cdkd#5096: does a recorded bag hold the redaction mask, behind which
 * a changed secret (a `NoEcho` value) is invisible? Not a `{{resolve:...}}`
 * reference: the diff compares its text, so an unchanged reference forced no
 * replacement, and the replay re-resolves it, so reversing again changes
 * nothing. The mask may be part of a value.
 */
function holdsRedactedLeaf(value: unknown): boolean {
  if (typeof value === 'string') {
    return value.includes(SECRET_MASK);
  }
  if (value === null || typeof value !== 'object') return false;
  return Object.values(value).some(holdsRedactedLeaf);
}

/**
 * go-to-k/cdkd#5096: a same-id re-create whose record cannot say whether its
 * reversal already ran ({@link sameIdReversalDone}). Reversing it again would
 * delete the restored resource; skipping it would leave the new one under the
 * old record. Neither is safe, so the arm refuses.
 */
export function sameIdReversalUndecidable(
  op: CompletedOperation,
  current: ResourceState | undefined
): boolean {
  return (
    sameIdRecreated(op) &&
    current !== undefined &&
    sameIdReversalDone(op, current) === 'undecidable'
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
      // go-to-k/cdkd#5096: under a same-id re-create the id is no evidence:
      // the record says whether the reversal ran.
      // An undecidable one is not done: the reverse arm refuses it.
      (!sameIdRecreated(op) || sameIdReversalDone(op, current) === true) &&
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
    // go-to-k/cdkd#6101: equal properties with different template policies is
    // a metadata-only update (`applyAttributeOnlyUpdate`), which called no
    // provider and so needs none to undo. Only the record moves back.
    if (templatePoliciesDiffer(current, op.previousState)) return 'restore-policies';
    // Already reverted (idempotent re-run).
    return 'skip-already-done';
  }
  // go-to-k/cdkd#6120: the in-place revert of a moved id is sent to the id
  // the op moved to; a record naming another one is a later attempt's.
  if (movedIdLeftForCleanup(op) && current.physicalId !== op.physicalId) return 'skip-mismatch';
  return 'revert';
}

/**
 * go-to-k/cdkd#6101: do the two records disagree on the template attributes a
 * deploy records (`extractTemplateAttributes`)? An absent key and an
 * `undefined` one both mean "not declared".
 */
export function templatePoliciesDiffer(
  current: Pick<ResourceState, 'deletionPolicy' | 'updateReplacePolicy'>,
  previous: Pick<ResourceState, 'deletionPolicy' | 'updateReplacePolicy'>
): boolean {
  return (
    current.deletionPolicy !== previous.deletionPolicy ||
    current.updateReplacePolicy !== previous.updateReplacePolicy
  );
}

/**
 * go-to-k/cdkd#6101: `current` with `previous`'s two template policies and
 * nothing else changed. A policy `previous` does not declare is dropped, not
 * written as `undefined`.
 */
export function withPreviousPolicies(
  current: ResourceState,
  previous: Pick<ResourceState, 'deletionPolicy' | 'updateReplacePolicy'>
): ResourceState {
  const {
    deletionPolicy: _deletionPolicy,
    updateReplacePolicy: _updateReplacePolicy,
    ...rest
  } = current;
  return {
    ...rest,
    ...(previous.deletionPolicy !== undefined && { deletionPolicy: previous.deletionPolicy }),
    ...(previous.updateReplacePolicy !== undefined && {
      updateReplacePolicy: previous.updateReplacePolicy,
    }),
  };
}
