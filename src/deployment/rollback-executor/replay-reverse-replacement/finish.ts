import { withReplayDeletePrinting } from '../replay-scope.js';
import { displayPhysicalId } from '../../../provisioning/secret-physical-id.js';
import { withNameGenerationReached } from '../../../state/name-generation.js';
import { pasteableCommand } from '../../../utils/pasteable-command.js';
import type { ResourceCreateResult } from '../../../types/resource.js';
import { equalIdNamesSameResource } from '../../type-change-guard.js';
import { acceptedCreateOnlyDropsEvidence } from '../../../provisioning/property-coverage.js';
import { replacementDeletePolicy } from '../../../provisioning/final-snapshot.js';
import { displaySafe, safeMsg } from '../../../utils/display-safe.js';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import { recordNoEchoAttributeValues } from '../../secret-redaction.js';
import { redactRollbackRecord } from '../replay-secrets.js';
import {
  safe,
  throwIfDeleteSkipped,
  rollbackRetainsNewResource,
  retainedSurvivorMessages,
  rollbackFinalSnapshotId,
  refusalPhysicalId,
  refusalResourceType,
  describedPhysicalIdPointer,
  shownLogicalId,
  maskedFailureText,
  maskedRollbackEventError,
  retainedSurvivorId,
} from '../messages.js';
import { recordedPropertiesAfterReplayCreate } from '../replay-retry.js';
import type { ReplayOpScope } from '../replay-scope.js';
import type { SupersededResourceRecord } from '../../../types/state.js';
import {
  canRecordSuperseded,
  supersededHolderOf,
  SUPERSEDED_KEPT_REMEDY,
} from '../../superseded-resources.js';
import { noteRetainedResource } from '../../../provisioning/providers/create-token-ledger.js';
import { embeddedFailureText } from './failures.js';
import type { ReverseReplacementScope } from './scope.js';

/**
 * `replayReverseReplacement` after the re-create: the rebuilt record, its
 * save, and the delete of the new resource (now, or deferred by the replay,
 * go-to-k/cdkd#5064) with the closing line and event.
 */
export async function finishReverseReplacement(
  s: ReplayOpScope,
  r: ReverseReplacementScope,
  createResult: ResourceCreateResult,
  deletedNewFirst: boolean
): Promise<void> {
  const {
    op,
    stateResources,
    stackName,
    ctx,
    result,
    inlinePolicyWriters,
    afterOp,
    logger,
    secrets,
    opMasker,
    mask,
  } = s;
  const {
    current,
    prev,
    oldType,
    resolvedPrevProps,
    createProvisionedBy,
    resolveNewDeleteRoute,
    newDeleteGuardScope,
    newCopyClaimed,
  } = r;
  // Issue #1247 — rollback sibling of the deploy engine's #1238
  // NAMED_REPLACEMENT_IDEMPOTENT_CREATE guard: a name-idempotent Create
  // API does NOT collide when the NEW resource still holds the same
  // user-supplied name — it silently returns the LIVE new resource's
  // physicalId as the "re-created old" one. Since deletedNewFirst is
  // false on this path, the delete-new step below would then delete the
  // very resource this op just recorded in state. Skip the delete and
  // ADOPT the live resource (warn + exit-2 warning) instead of
  // hard-failing:
  // - Rollback is a RECOVERY flow: failing the segment would block the
  //   segment pop and strand the user in a replay loop that can never
  //   succeed (every re-run re-classifies the op as reverse-replacement
  //   and hits the same idempotent create), while adopting keeps the
  //   resource alive and lets the rollback settle.
  // - Re-applying the old properties via provider.update() is
  //   deliberately NOT attempted: the op was classified
  //   reverse-replacement precisely because the reverted property is
  //   immutable in place, so that update would throw the very
  //   immutable-property error this branch exists to avoid.
  // - Auto-falling-back to delete-new-first + re-create (the collision
  //   path above) is also NOT done: on a collision the Create THREW, so
  //   deleting the name holder is the only way to finish the revert —
  //   here the Create RETURNED the only live copy, and deleting it on
  //   speculation risks total resource loss if the re-create then fails
  //   (and, unlike deploy, rollback has no --replace-style opt-in to
  //   accept that risk; the delete-first route, go-to-k/cdkd#4690, accepts
  //   it only because the deploy itself ran delete-first, and it never
  //   reaches this arm).
  // State is rebuilt from previousState below (the intended
  // post-rollback record), so the not-re-applied properties surface via
  // `cdkd drift` / the next `cdkd deploy` for reconciliation. When
  // deletedNewFirst is true the same-id outcome is the EXPECTED result
  // (re-acquiring the name after the new resource is gone) — exempt,
  // mirroring the deploy-side guard's delete-first exemption.
  //
  // Issue #2668: across a Type change an equal id is a coincidence of two
  // namespaces — the re-create was genuine, and skipping the delete-new
  // step would leave the new type's resource alive and untracked. The
  // custom-resource family is the exception (`equalIdNamesSameResource`
  // has the reasoning): there the equal id IS the live resource, and the
  // delete-new step would destroy what this op just restored.
  // The predicate is symmetric in its two types; `createLayer` is the
  // layer of THIS operation's create half, which on a replay is the
  // re-create of the old resource.
  // Issue #4037: the id the re-create returned spells the old name too
  // (for a rewriting type, under the setting it ran with; for an ARN,
  // inside it), so it joins the masker before any line below names it.
  opMasker.addNamed({
    resourceType: oldType,
    properties: resolvedPrevProps,
    logicalId: op.logicalId,
    physicalIds: [createResult.physicalId],
  });
  const equalIdIsSameResource = equalIdNamesSameResource({
    oldType,
    newType: op.resourceType,
    createLayer: createProvisionedBy,
    // Issue #3892: what the re-create restored, against the record of
    // the live new resource.
    oldProperties: prev.properties,
    newProperties: current.properties,
    physicalId: current.physicalId,
  });
  const adoptedLiveNewResource =
    equalIdIsSameResource && !deletedNewFirst && createResult.physicalId === current.physicalId;
  if (adoptedLiveNewResource) {
    // Named only when plain, described otherwise: this line names
    // `cdkd deploy`, and the physical id used to print through the bare
    // denylist, where even a `;` ran when pasted (go-to-k/cdkd#4214).
    const liveShown = refusalPhysicalId(mask(current.physicalId));
    logger.warn(
      `  ⚠ ${shownLogicalId(op.logicalId)} (${refusalResourceType(op.resourceType)}): ` +
        `the re-create returned the LIVE new ` +
        `resource (${liveShown}) instead of re-creating the old ` +
        `one — its ` +
        `Create API is name-idempotent and the new resource still holds the same ` +
        `user-supplied name. Skipping the delete-new step (it would delete that very ` +
        `resource). The old resource's ORIGINAL properties may NOT have been re-applied; ` +
        `state now records the pre-replacement properties, so inspect the drift and ` +
        `run 'cdkd deploy' to reconcile, or rename the resource to make the replacement ` +
        `reversible.${describedPhysicalIdPointer(liveShown)}` +
        // `--stack-region` for the same reason the destroy hints carry
        // it: without it `cdkd drift` resolves every region holding this
        // name. Read-only, so no data loss — but it reports on records
        // the message never named (go-to-k/cdkd#3499 review nits).
        `\nInspect it with: ${
          pasteableCommand('cdkd drift', [
            { value: stackName, hole: 'stack' },
            { flag: '--stack-region', value: ctx.region, hole: 'region' },
          ]).command
        }`
    );
    result.warnings++;
  }

  // Rebuild the record from the previous state, but NEVER carry the
  // OLD physical resource's attributes / observedProperties over — the
  // re-created resource has fresh identifiers (ARNs etc.), and stale
  // cached attributes would poison later Fn::GetAtt resolution and
  // drift comparison. Mirrors the deploy engine's replacement path,
  // which constructs the record fresh from the create result — including
  // the provider's `effectiveProperties` (issue #1682), which replaces
  // the previous record's `properties` when it reported one.
  const { observedProperties: _staleObserved, ...prevRecord } = prev;
  // Redact resolved secret plaintext back out (GHSA fix): the create
  // result's `effectiveProperties` can echo the value we resolved for the
  // re-CREATE, so scrub the rebuilt record before it is persisted.
  //
  // The create's `NoEcho` declaration becomes needles first
  // (go-to-k/cdkd#4434), as the deploy engine's create registers it: the
  // attributes below are the create's, so a custom resource answering
  // `NoEcho: true` (or a nested stack's masked outputs) would otherwise land
  // in the record in the clear.
  recordNoEchoAttributeValues(createResult, secrets, resolvedPrevProps);
  // go-to-k/cdkd#5064 phase 2: the old resource comes back at its own name
  // generation, and the record remembers the one the deleted copy reached, so
  // the next replacement never asks for that name again.
  const restoredProperties = recordedPropertiesAfterReplayCreate(prevRecord, createResult);
  stateResources[op.logicalId] = redactRollbackRecord(
    {
      ...withNameGenerationReached(prevRecord, op.logicalId, op.nameGeneration),
      physicalId: createResult.physicalId,
      attributes: createResult.attributes ?? {},
      properties: restoredProperties,
      // go-to-k/cdkd#5572: the re-create is a NEW resource, so its evidence
      // is rebuilt for the route it took, never carried from the deleted
      // copy's record: a key today's SDK provider writes reached AWS this
      // time, and a stale name would refuse the next unchanged deploy.
      acceptedCreateOnlyDrops: acceptedCreateOnlyDropsEvidence(
        restoredProperties,
        oldType,
        createProvisionedBy
      ),
    },
    secrets,
    prevRecord.properties,
    // Read only as evidence of what was persisted, never copied in: a new
    // attribute identical to a plaintext old one stays plaintext (#4801).
    prevRecord.attributes
  );
  // go-to-k/cdkd#4225: the re-create put the old resource's inline
  // policies, as the deploy's replacement create does. A re-create that
  // returned the live NEW resource is not counted: its record may not
  // describe what is live. (No claim type reaches that arm: an
  // `AWS::IAM::Policy` re-create of a rename has a new id, and a role,
  // group or user create is not name-idempotent.)
  if (!adoptedLiveNewResource) {
    inlinePolicyWriters.record(
      op.logicalId,
      'create',
      stateResources[op.logicalId]!,
      false,
      createProvisionedBy
    );
  }
  // go-to-k/cdkd#5064: a delete deferred past this save leaves the new
  // resource in no record until it runs, so it is reported as superseded
  // first; a run killed in between leaves it for the next deploy to delete.
  const deferral =
    s.deferral !== undefined &&
    !deletedNewFirst &&
    !adoptedLiveNewResource &&
    !rollbackRetainsNewResource(current)
      ? s.deferral
      : undefined;
  const supersededFinalSnapshot = rollbackFinalSnapshotId(
    op.resourceType,
    current,
    op.provisionedBy
  );
  const supersededPolicy = current.updateReplacePolicy;
  const superseded: SupersededResourceRecord = {
    logicalId: op.logicalId,
    supersededAt: Date.now(),
    state: current,
    ...((supersededPolicy === 'Delete' ||
      supersededPolicy === 'Snapshot' ||
      supersededPolicy === 'RetainExceptOnCreate') && { updateReplacePolicy: supersededPolicy }),
    ...(supersededFinalSnapshot !== undefined && {
      finalSnapshotIdentifier: supersededFinalSnapshot,
    }),
  };
  // Only what a later run can delete with the context this one has
  // (`canRecordSuperseded`); a principal's delete reads no inline-policy
  // claim, so a role qualifies. Anything else keeps the in-memory deferral.
  const recordSuperseded = deferral?.onSuperseded !== undefined && canRecordSuperseded(current, {});
  if (recordSuperseded) deferral?.onSuperseded?.(superseded);
  await afterOp?.(op.logicalId);

  // The delete of the new resource and the closing line and event. A
  // renamed reversal run ahead of the ops reverting to the old name hands
  // it to the replay instead, which runs it at this op's own slot, after
  // those ops moved off the new resource (go-to-k/cdkd#5064).
  /** Returns whether the new resource is gone (deleted, not kept). */
  const finish = async (): Promise<boolean> => {
    // Survivor record for this arm's retain branch -- see the twin binding
    // in `reverse-replacement-readopt` above for why the EVENT, not the
    // warn, is what the user is left with.
    let survivorReason: string | undefined;
    // go-to-k/cdkd#4628: the record's id may be unaddressable here.
    const survivorId = retainedSurvivorId(current, op);
    if (!deletedNewFirst && !adoptedLiveNewResource && rollbackRetainsNewResource(current)) {
      // Issue #2598: the ordinary create-first path — the old resource is
      // already re-created and state already points at it, so honouring
      // `UpdateReplacePolicy: Retain` on the new copy costs nothing and
      // completes the revert. This site's existing policy for a delete it
      // does not perform is warn-and-count (see the `catch` below and the
      // `adoptedLiveNewResource` arm above), and a retained copy is the
      // same user-visible outcome: a live resource cdkd no longer tracks.
      const survivorMessages = retainedSurvivorMessages(
        op.logicalId,
        op.resourceType,
        survivorId ?? 'no recorded id',
        `State records the re-created old resource ` +
          `(${stateResources[op.logicalId]?.physicalId ?? prev.physicalId}).`,
        mask
      );
      logger.warn(survivorMessages.warn);
      survivorReason = survivorMessages.reason;
      result.warnings++;
      // go-to-k/cdkd#4438: the retained copy still holds this stack's create
      // token, so the stack's next create of the logical id must not send it.
      await noteRetainedResource(op.resourceType, op.logicalId);
    } else if (!deletedNewFirst && !adoptedLiveNewResource) {
      try {
        const finalSnapshotIdentifier = rollbackFinalSnapshotId(
          op.resourceType,
          current,
          op.provisionedBy
        );
        const deleteNewAfterRecreateRoute = resolveNewDeleteRoute();
        const deleteNewAfterRecreate = await withReplayDeletePrinting(s, () =>
          deleteNewAfterRecreateRoute.provider.delete(
            op.logicalId,
            current.physicalId,
            op.resourceType,
            current.properties,
            {
              expectedRegion: ctx.region,
              ...(newCopyClaimed && { inlinePolicyClaimed: newCopyClaimed }),
              ...(finalSnapshotIdentifier !== undefined && { finalSnapshotIdentifier }),
              deletionPolicy: replacementDeletePolicy(current.updateReplacePolicy),
              recordedAttributes: current.attributes,
              // go-to-k/cdkd#4043: where the record holds a NoEcho mask.
              recordedNoEchoLeaves: current.noEchoLeaves,
              // go-to-k/cdkd#2007: the op's mask, the failed deploy's bag included.
              maskSecrets: mask,
            }
          )
        );
        // Issue #1762: the old resource is already re-created and state
        // already points at it, so the site's existing policy for a
        // FAILED delete applies to a skip too — warn, count it, and tell
        // the user the new resource is now untracked. Thrown into that
        // same catch so the two outcomes cannot drift apart.
        throwIfDeleteSkipped(
          deleteNewAfterRecreate,
          op.logicalId,
          current.physicalId,
          'while deleting the new resource after re-creating the old one',
          newDeleteGuardScope(deleteNewAfterRecreateRoute.provisionedBy)
        );
      } catch (deleteError) {
        // Issue #2038: this arm runs AFTER `resolveReplayProps` resolved
        // this op's secrets to plaintext, so the AWS message is masked with
        // the op's masker like every other site on the path. The delete's
        // own bag is the state record (redacted), but a provider is free to
        // echo the properties it was re-created with, so masking here is
        // not speculative; and the new resource's id is masked even when
        // nothing was resolved, if its name is a secret reference (#4037).
        logger.warn(
          mask(
            `  Rollback: old ${safe(op.logicalId)} re-created, but deleting the new resource ` +
              `(${displaySafe(mask(current.physicalId))}) failed: ` +
              `${displaySafe(describeAwsFailure(deleteError).detail)}. ` +
              (recordSuperseded
                ? `${SUPERSEDED_KEPT_REMEDY}.`
                : `Delete it manually — it is no longer tracked in state.`)
          )
        );
        // Same class as the `Retain` arm above, and the reason this
        // binding is not named for `Retain` (security review): state
        // already points at the re-created OLD resource, the new copy is
        // alive, and cdkd no longer tracks it -- an orphan by outcome
        // rather than by policy. Until this was set the event emitted with
        // the binding still `undefined`, so `cdkd events` showed a clean
        // SUCCEEDED naming nothing and the id died with the terminal.
        //
        // NOT masked here: the event site below runs the op's `mask`
        // over this binding, exactly as it does for the `Retain` arms.
        // Masking twice is a no-op but reads as though one of the two were
        // load-bearing.
        //
        // go-to-k/cdkd#2319: the reason is persisted, so an AWS-authored
        // failure is named by its class; the warn above carries AWS's text.
        const survivorFailure = embeddedFailureText(deleteError).text;
        survivorReason =
          `The replacement's new ${op.resourceType} (${current.physicalId}) could not be ` +
          `deleted after the old resource was re-created: ` +
          `${survivorFailure}${survivorFailure.endsWith('.') ? '' : '.'} ` +
          (recordSuperseded
            ? `It is live and still billing; ${SUPERSEDED_KEPT_REMEDY}.`
            : `It is live, still billing, and no longer tracked by cdkd — delete it yourself.`);
        result.warnings++;
      }
    }
    // Issue #4037: the re-created id is the OLD name's spelling, which the
    // literal mask misses when a rewriting provider derived it.
    // go-to-k/cdkd#5868: an id that IS a credential (an AppSync ApiKey's key)
    // is new here, so no bag holds it yet. The re-created resource is the OLD
    // one, so its type is `oldType` (a Type change rolls back across types).
    const recreatedId = displaySafe(
      mask(String(displayPhysicalId(oldType, createResult.physicalId)))
    );
    logger.info(
      mask(
        adoptedLiveNewResource
          ? `  Rollback: ${safe(op.logicalId)} adopted the live resource (${recreatedId}) ` +
              `— replacement NOT fully reversed (name-idempotent Create API)`
          : `  Rollback: ${safe(op.logicalId)} replacement reversed (old resource re-created as ` +
              `${recreatedId})`
      )
    );
    // The SURVIVOR's layer, same reasoning as the readopt twin above --
    // including why there is no `?? op.provisionedBy`: the unconditional
    // spread below already covers a record that carries no layer.
    const survivorProvisionedBy = current.provisionedBy;
    ctx.recordEvent?.({
      eventType: 'ROLLBACK_RESOURCE_SUCCEEDED',
      stackName,
      operation: 'UPDATE',
      logicalId: op.logicalId,
      resourceType: op.resourceType,
      ...(op.provisionedBy && { provisionedBy: op.provisionedBy }),
      // Gated on the retain branch for the same reason as the twin above:
      // on every other path through this arm the new copy was DELETED, and
      // naming it here would point a cleanup pass at a dead id. The layer
      // is gated with them -- on those paths the event describes the OP,
      // whose own layer is the right one to report.
      ...(survivorReason !== undefined && {
        ...(survivorId !== undefined && { physicalId: survivorId }),
        reason: mask(survivorReason),
        ...(survivorProvisionedBy && { provisionedBy: survivorProvisionedBy }),
      }),
      // go-to-k/cdkd#3338: the replacement was NOT fully reversed, which the
      // warn above is otherwise the only trace of. No `physicalId`: the live
      // resource is the one state now records, so nothing is untracked.
      ...(adoptedLiveNewResource && {
        reason: mask(
          `The re-create returned the live new resource instead of re-creating the old one ` +
            `(its Create API is name-idempotent), so the replacement was NOT fully reversed: ` +
            `the old resource's original properties may not have been re-applied. Inspect it ` +
            `with \`cdkd drift\` and run \`cdkd deploy\` to reconcile.`
        ),
      }),
    });
    return survivorReason === undefined;
  };
  /**
   * The new resource stays: it is recorded as superseded, so the next deploy
   * deletes it (`ReplayDeferral.keep`). A survivor event names it.
   */
  const keep = (reason: string): void => {
    logger.warn(
      mask(
        `  Rollback: old ${safe(op.logicalId)} re-created, but the new resource ` +
          `(${displaySafe(mask(current.physicalId))}) was not deleted: ${reason}. ` +
          `${SUPERSEDED_KEPT_REMEDY}.`
      )
    );
    result.warnings++;
    ctx.recordEvent?.({
      eventType: 'ROLLBACK_RESOURCE_SUCCEEDED',
      stackName,
      operation: 'UPDATE',
      logicalId: op.logicalId,
      resourceType: op.resourceType,
      // The survivor's layer, as `finish`'s survivor event names it.
      ...(current.provisionedBy && { provisionedBy: current.provisionedBy }),
      physicalId: current.physicalId,
      reason: mask(
        `The old resource was re-created; the new one (${current.physicalId}) was not deleted: ` +
          `${reason}. ${SUPERSEDED_KEPT_REMEDY}.`
      ),
    });
  };
  if (deferral !== undefined) {
    logger.info(
      safeMsg`  Rollback: old ${safe(op.logicalId)} re-created first; the new resource ` +
        safeMsg`(${mask(current.physicalId)}) is deleted once the resources that reference it ` +
        `are reverted`
    );
    deferral.defer(
      async () => {
        let gone = false;
        try {
          // A record took the new resource's id while its delete waited (a
          // reversal that re-created that id, or a name-idempotent create that
          // returned it): cdkd never deletes an id a record names.
          const holder = supersededHolderOf(superseded, stateResources);
          if (holder !== undefined) {
            logger.warn(
              safeMsg`  Rollback: not deleting the new ${shownLogicalId(op.logicalId)} ` +
                safeMsg`(${mask(current.physicalId)}): a record of this stack now holds its ` +
                `physical id. Check it with cdkd drift.`
            );
            result.warnings++;
            ctx.recordEvent?.({
              eventType: 'ROLLBACK_RESOURCE_SUCCEEDED',
              stackName,
              operation: 'UPDATE',
              logicalId: op.logicalId,
              resourceType: op.resourceType,
              ...(op.provisionedBy && { provisionedBy: op.provisionedBy }),
              reason: mask(
                `The old resource was re-created; the new one (${current.physicalId}) was not ` +
                  `deleted because a record of this stack now holds its physical id.`
              ),
            });
            gone = true;
          } else {
            gone = await finish();
          }
        } catch (finishError) {
          logger.warn(
            maskedFailureText(
              `  Rollback failed for ${shownLogicalId(op.logicalId)} (UPDATE): `,
              finishError,
              mask
            )
          );
          result.failures++;
          ctx.recordEvent?.({
            eventType: 'ROLLBACK_RESOURCE_FAILED',
            stackName,
            operation: op.changeType,
            logicalId: op.logicalId,
            resourceType: op.resourceType,
            ...(op.provisionedBy && { provisionedBy: op.provisionedBy }),
            error: maskedRollbackEventError(finishError, mask),
          });
        }
        // Gone, or held by a record: the entry goes, with a save. A delete that
        // failed keeps it, so the next deploy retries it (#5111).
        if (recordSuperseded && gone) {
          deferral.onSupersededSettled?.(superseded);
          await afterOp?.(op.logicalId);
        }
      },
      recordSuperseded ? keep : undefined
    );
    return;
  }
  await finish();
}
