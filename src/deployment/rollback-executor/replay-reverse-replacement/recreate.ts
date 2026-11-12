import { withReplayDeletePrinting } from '../replay-scope.js';
import type { ResourceCreateResult } from '../../../types/resource.js';
import { reverseReplacementNewHoldsName } from '../../replacement-name-holder.js';
import { withCurrentResourceSecrets } from '../../resource-secrets-scope.js';
import { applyDefaultNameForFallback } from '../../../provisioning/resource-name.js';
import { replacementDeletePolicy } from '../../../provisioning/final-snapshot.js';
import { CdkdError } from '../../../utils/error-handler.js';
import { displaySafe, safeMsg } from '../../../utils/display-safe.js';
import { maskSecretsInError } from '../../secret-redaction.js';
import {
  isNameCollisionErrorFrom,
  isNameCooldownError,
  isRecreateRetryableError,
  markNonRetryable,
} from '../../retryable-errors.js';
import {
  safe,
  throwIfDeleteSkipped,
  rollbackRetainsNewResource,
  rollbackFinalSnapshotId,
  rerunRollbackPhrase,
  replayingStateCreateContext,
  orphanRemedy,
  refusalPhysicalId,
  ownRemedyError,
  refusalLogicalId,
  refusalResourceType,
  describedPhysicalIdPointer,
  collisionLine,
} from '../messages.js';
import { createWithRollbackRetry } from '../replay-retry.js';
import type { ReplayOpScope } from '../replay-scope.js';
import { refuseRestoreFromItself } from '../../../provisioning/restore-source-guard.js';
import { deleteMarkedRecreate, embeddedFailureText, stampRedacted } from './failures.js';
import type { ReverseReplacementScope } from './scope.js';

/**
 * `replayReverseReplacement`'s re-create of the OLD resource: delete-new-first
 * (go-to-k/cdkd#4690) or create-first with the name-collision fallback.
 * Returns the create's result and whether the new resource was deleted first.
 */
export async function recreateOldResource(
  s: ReplayOpScope,
  r: ReverseReplacementScope
): Promise<{ createResult: ResourceCreateResult; deletedNewFirst: boolean }> {
  const { op, stateResources, ctx, afterOp, isInterrupted, logger, secrets, mask } = s;
  const {
    current,
    prev,
    oldType,
    typeChanged,
    resolvedPrevProps,
    deleteFirstBlocked,
    reverseDeleteFirst,
    createProvider,
    createProvisionedBy,
    replayCreateProps,
    inOriginalPrefix,
    resolveNewDeleteRoute,
    newDeleteGuardScope,
    newCopyClaimed,
    recreateCleanup,
  } = r;
  // Deletes the NEW resource BEFORE the old one is re-created, on both routes
  // that do so: the collision route below, and the delete-first route
  // (go-to-k/cdkd#4690). A failed or skipped delete throws BEFORE the record
  // is dropped, so state still points at the live new resource and the
  // journal is kept for a re-run.
  const deleteNewResourceFirst = async (purpose: string): Promise<void> => {
    // go-to-k/cdkd#5628: before the delete, which is what would lose the source
    // the old record restores from. The RESOLVED bag the re-create sends: a
    // record keeps a dynamic reference as its `{{resolve:...}}` token.
    refuseRestoreFromItself(oldType, replayCreateProps(), current.physicalId, op.logicalId, {
      region: ctx.region,
      attributes: current.attributes,
    });
    const finalSnapshotIdentifier = rollbackFinalSnapshotId(
      op.resourceType,
      current,
      op.provisionedBy
    );
    const deleteNewFirstRoute = resolveNewDeleteRoute();
    const deleteNewFirst = await withReplayDeletePrinting(s, () =>
      deleteNewFirstRoute.provider.delete(
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
          recordedCreateOnlyDrops: current.acceptedCreateOnlyDrops,
          // go-to-k/cdkd#4043: where the record holds a NoEcho mask.
          recordedNoEchoLeaves: current.noEchoLeaves,
          // go-to-k/cdkd#2007: the op's mask, the failed deploy's bag included.
          maskSecrets: mask,
        }
      )
    );
    // Issue #1762: this delete exists to make room for the re-create, so a
    // skip means the re-create below collides — fail the op now, with the
    // cause named, rather than after another full re-create attempt.
    throwIfDeleteSkipped(
      deleteNewFirst,
      op.logicalId,
      current.physicalId,
      purpose,
      newDeleteGuardScope(deleteNewFirstRoute.provisionedBy)
    );
    // Persist the intermediate truth (resource currently absent) so an
    // interrupted re-run doesn't chase a deleted physical id.
    delete stateResources[op.logicalId];
    await afterOp?.(op.logicalId);
    // go-to-k/cdkd#5131: the old resource is re-created under the name this
    // delete frees; a type whose delete returns while AWS still holds it waits.
    await deleteNewFirstRoute.provider.waitForNameReleased?.(
      op.logicalId,
      current.physicalId,
      current.resourceType,
      { isInterrupted: () => isInterrupted?.() === true, maskSecrets: mask }
    );
  };

  // Re-creates the old resource once the new one is gone.
  const recreateAfterNewDeleted = async (): Promise<ResourceCreateResult> => {
    try {
      // Issue #2032, same two-loop shape as the create-first attempt
      // below. The outer classifier widens to collision-or-cooldown here
      // because the new resource was just deleted (an async delete releases
      // its name or slot late), and the interrupt message mirrors the deploy
      // engine's delete-first fallback: honor SIGINT mid-sleep instead of
      // blocking up to ~64s.
      return await createWithRollbackRetry(
        createProvider,
        () =>
          inOriginalPrefix(() =>
            withCurrentResourceSecrets(secrets, () =>
              createProvider.create(
                op.logicalId,
                oldType,
                replayCreateProps(),
                replayingStateCreateContext(secrets)
              )
            )
          ),
        op.logicalId,
        logger,
        isInterrupted,
        mask,
        {
          isRetryable: isRecreateRetryableError,
          interruptedMessage:
            'Rollback interrupted while waiting for the new resource to release its name or slot',
        }
      );
    } catch (recreateError) {
      await deleteMarkedRecreate(recreateError, recreateCleanup);
      // The new resource is already gone — say so, because the resource
      // is now absent from both AWS and state.
      //
      // Issue #2038: masked at CONSTRUCTION, the byte-identical twin of
      // the deploy engine's two `--replace` wraps. The create this catch
      // wraps was handed `resolvedPrevProps`, which `resolveReplayProps`
      // re-resolved to PLAINTEXT, so the AWS message can quote the secret
      // back. Every downstream reader already masks (the per-op catch
      // through the op's `mask`, and `maskedRollbackEventError` for
      // the durable event), so this is defense-in-depth, not a live leak
      // — but leaving the rollback twin bare while arguing the deploy
      // engine's copies deserve the same treatment is the inconsistency,
      // and masking here means the plaintext never exists inside a thrown
      // `Error` for a future reader of the chain to re-open.
      //
      // MEASURED UNFENCEABLE, deliberately kept: deleting this mask
      // leaves the whole unit suite green, exactly as the deploy engine's
      // twins do, because every reader masks independently. Do not record
      // it in a PR body as a tested behavior.
      // go-to-k/cdkd#2319: an AWS-authored failure is named by its class,
      // AWS's text at `debug` ({@link embeddedFailureText}).
      const recreateFailure = (text: string): string =>
        mask(
          `Failed to re-create the old ${safe(op.logicalId)} after the new resource ` +
            `(${mask(current.physicalId)}) was already deleted: ` +
            `${displaySafe(text)}${text.endsWith('.') ? '' : '.'} ` +
            // No command on this line (go-to-k/cdkd#4214): it carries
            // the provider's text and the new physical id.
            `The resource is now absent — fix forward by re-deploying the stack.`
        );
      // Rendered whole: the line carries the new physical id from state.
      const recreateText = embeddedFailureText(recreateError, (detail) =>
        logger.debug(displaySafe(recreateFailure(detail)))
      );
      throw stampRedacted(
        new Error(
          recreateFailure(recreateText.text),
          // Issue #2616's sweep reached this third site: without a `cause`
          // the wrap is the LAST link, so `extractDeploymentEventError`
          // walks a chain with no `$metadata` and the persisted event
          // names no AWS code. Masked for the same reason the message is.
          {
            cause: maskSecretsInError(
              recreateError instanceof Error ? recreateError : undefined,
              secrets
            ),
          }
        ),
        recreateText.redacted
      );
    }
  };

  // Otherwise create-first (the old resource's revival is the point). A
  // user-supplied physical name still held by the NEW resource collides
  // — delete the new one first, then retry the create with a bounded
  // collision retry (async deletes release the name late), mirroring the
  // deploy engine's --replace delete-first fallback.
  //
  // The new resource is deleted ONLY when the create-first attempt fails
  // with a name collision AND its record proves it holds that name
  // (issue #3979, `reverseReplacementNewHoldsName` in the catch below).
  // The collision alone never sufficed: an orphan a failed attempt left
  // (#1710, #3972), a replayed create (#3978) or a squatter on a
  // predictable name collides identically, and deleting the new resource
  // then destroys a live resource that never held the name. Issue #3199
  // made the replay ask for the deterministic `<stack>-<logicalId>` of a
  // `FALLBACK_NAME_RULES` type, so such a replay CAN collide — with the
  // live new resource (the ordinary case for a replacement that kept the
  // generated name, which the proof accepts through the new resource's
  // physical id) or with anything else (refused).
  let deletedNewFirst = false;
  // Typed as the full provider contract (issue #1682): the narrower
  // local shape this used to declare hid `effectiveProperties`, so the
  // record rebuild below could not honour it even in principle.
  let createResult: ResourceCreateResult;
  if (reverseDeleteFirst) {
    // go-to-k/cdkd#4690: the forward deleted the old resource before it
    // created the new one, so the reversal runs in the same order. The new
    // resource is this op's own record, so no holder proof is needed; the
    // risk accepted is the forward's own: a re-create that then fails leaves
    // the resource absent, and the error below says so.
    logger.info(
      `  Rollback: the replacement deleted the old resource before creating the new one — ` +
        safeMsg`deleting the new resource (${mask(current.physicalId)}) first...`
    );
    await deleteNewResourceFirst(
      'while clearing the new resource before re-creating the old one (the replacement deleted the old one first)'
    );
    deletedNewFirst = true;
    createResult = await recreateAfterNewDeleted();
  } else {
    try {
      // The initial create-first attempt retries ONLY the SQS name
      // cooldown (issue #1206): the forward replacement deleted the OLD
      // name moments ago (create-then-destroy with a changed name), so a
      // rollback within 60s deterministically hits QueueDeletedRecently.
      // A genuine collision must NOT be retried here — it falls through
      // to the delete-new-first fallback below instead.
      // Issue #2032: BOTH loops live in the helper — an inner
      // default-schedule retry so an IAM propagation error still gets the
      // dense schedule the outer classifier + explicit knobs disable, and
      // the outer cooldown retry below it. The helper also owns the
      // `disableOuterRetry` guard for both.
      createResult = await createWithRollbackRetry(
        createProvider,
        () =>
          inOriginalPrefix(() =>
            withCurrentResourceSecrets(secrets, () =>
              createProvider.create(
                op.logicalId,
                oldType,
                replayCreateProps(),
                replayingStateCreateContext(secrets)
              )
            )
          ),
        op.logicalId,
        logger,
        isInterrupted,
        mask,
        {
          isRetryable: isNameCooldownError,
          interruptedMessage: 'Rollback interrupted while waiting out the name cooldown',
        }
      );
    } catch (createError) {
      const deletedMade = await deleteMarkedRecreate(createError, recreateCleanup);
      // Reads the ERROR, not the rendered message (issue go-to-k/cdkd#3208):
      // ELBv2 states the collision in prose this predicate cannot see, and
      // the exception NAME that does say it is dropped by the provider wrap.
      // Without it this arm went inert for those types, exactly like the
      // deploy engine's --replace twin.
      const nameCollision = isNameCollisionErrorFrom(createError, op.logicalId);
      // A collision this create's own earlier attempt caused (the mark carried
      // across its retry) was just cleared by deleting that resource: the arms
      // below would blame another holder, so fail the op here and let a re-run
      // create it.
      if (!nameCollision || deletedMade) {
        // go-to-k/cdkd#2319: rethrown as-is it is persisted as the op's
        // failure, so an SDK error a provider let escape is wrapped and named
        // by its class, AWS's text at `debug`. A provider's own wrap passes
        // through unchanged.
        const failureText = (text: string): string =>
          mask(`Failed to re-create the old ${safe(op.logicalId)}: ${displaySafe(text)}`);
        const createText = embeddedFailureText(createError, (detail) =>
          logger.debug(failureText(detail))
        );
        if (!createText.redacted) throw createError;
        throw stampRedacted(
          new Error(failureText(createText.text), {
            cause: maskSecretsInError(
              createError instanceof Error ? createError : undefined,
              secrets
            ),
          }),
          true
        );
      }
      // The refusals below quote it on their `Underlying collision:` line, and
      // a refusal is persisted as the op's failure (go-to-k/cdkd#2319): an
      // AWS-authored collision is named by its class, AWS's text at `debug`.
      // Not stamped `markRedactedCause`: every refusal is `markNonRetryable`,
      // which the classifiers read first.
      const msg = embeddedFailureText(createError, (detail) =>
        logger.debug(
          mask(
            `  Rollback: the re-create of ${safe(op.logicalId)} collided: ${displaySafe(detail)}`
          )
        )
      ).text;
      // Issue #3979, ahead of every other arm: each of them — the delete
      // below, and the Retain refusal's "held by the new one" — presumes
      // the NEW resource holds the name the re-create collided on. The
      // classifier cannot say WHO holds it: an orphan an earlier failed
      // create left, a replayed create, or a resource made outside the
      // stack collides identically, and deleting the new resource then
      // destroys a live resource that never held the name and collides
      // again. So prove the holder from the two records, and refuse when
      // it is not proven. It subsumes the #3892 Glue guard (a table in
      // another database is a different scope).
      const holder = inOriginalPrefix(() =>
        reverseReplacementNewHoldsName({
          oldResourceType: oldType,
          newResourceType: op.resourceType,
          // What the create SENT: on a Cloud Control route that already
          // carries the generated name (`replayCreateProps`). An SDK provider
          // mints its own for a nameless bag; `generated` is cdkd's rule for
          // it, which the helper uses only for a type whose provider was
          // audited to mint it verbatim, and treats as undecided on a
          // mismatch. The `typeof` gate: a
          // non-string id (an in-process op the journal parser never saw)
          // must reach the refusal, not throw in the name generator.
          requested: replayCreateProps(),
          generated:
            typeof op.logicalId === 'string'
              ? // `'omit'`: a name only a Cloud Control create needs must not
                // throw here, where the create may have gone to the SDK.
                applyDefaultNameForFallback(op.logicalId, oldType, resolvedPrevProps, 'omit')
              : undefined,
          // A provider that REWRITES even an explicit name derives it in this
          // async scope (stack name, prefix flag), so the helper derives it
          // here too, from the logical id for a nameless bag (#4018's shape).
          logicalId: op.logicalId,
          createdVia: createProvisionedBy,
          mask,
          recorded: current.properties,
          observed: current.observedProperties,
          physicalId: current.physicalId,
        })
      );
      if (!holder.holds) {
        const remedy = orphanRemedy(op.logicalId, ctx);
        const oldShown = refusalPhysicalId(mask(prev.physicalId));
        throw ownRemedyError(
          markNonRetryable(
            new CdkdError(
              // Masked at construction, like the Retain refusal below:
              // the diagnosis quotes names from the PLAINTEXT replay bag.
              mask(
                `Cannot reverse the replacement of ${refusalLogicalId(op.logicalId)} ` +
                  `(${refusalResourceType(op.resourceType)}): ` +
                  // The diagnosis is on a line of its own below
                  // (go-to-k/cdkd#4214): it quotes names from the replay
                  // bag in JSON quotes, and this line names `cdkd
                  // rollback`, so a `$( )` name would run beside it when
                  // pasted into zsh.
                  `the re-create of the old resource (${oldShown}) collided (why is on the ` +
                  `Collision diagnosis line below) — so ` +
                  // Undecided: the diagnosis already says what cdkd cannot
                  // show, so the clause only states the consequence (the
                  // deploy engine's `--replace` twin words it the same way).
                  (holder.known
                    ? `another resource holds the colliding name`
                    : `if another resource holds the name it collided on`) +
                  ` (an orphan of an earlier attempt, or one made outside this stack), ` +
                  `deleting the new resource would destroy it and collide again. Nothing was ` +
                  `deleted. Remove or rename whatever holds that name if it is yours — if that is ` +
                  `the new resource itself, delete it by hand — then re-run `
              ) +
                // The re-run COMMAND stays outside the mask too, like the
                // `--orphan` line below (review of #4099): a short id
                // needle would otherwise cut into it.
                rerunRollbackPhrase(ctx, 'cdkd rollback') +
                mask(
                  `, which proceeds: the journal is kept, so the revert resumes from here.` +
                    (remedy.offered
                      ? ` To leave THIS resource alone and let the rest of the rollback ` +
                        `proceed, re-run with the command below.`
                      : '') +
                    `${remedy.clause}${describedPhysicalIdPointer(oldShown)}` +
                    `\nCollision diagnosis: ${holder.diagnosis}` +
                    `\nUnderlying collision: ${collisionLine(mask(msg))}`
                ) +
                // OUTSIDE the mask (review of #4099): it carries only the
                // vetted logical id, and a short secret-derived id needle
                // would otherwise cut into the pasteable `--orphan` command.
                remedy.line,
              'NAMED_REPLACEMENT_COLLISION',
              maskSecretsInError(createError instanceof Error ? createError : undefined, secrets)
            )
          )
        );
      }
      if (rollbackRetainsNewResource(current)) {
        // Issue #2598: the ONE arm where honouring `Retain` cannot also
        // complete the op. This delete exists solely to release the NAME
        // the re-create just collided on, so with the holder pinned in
        // place the old resource can never be re-created — and deleting it
        // anyway is exactly the destruction of a resource the user marked
        // to survive that this issue is about. So REFUSE, loudly, instead
        // of choosing silently between the two.
        //
        // The op fails, which is the correct disposition: `replaySingle`'s
        // per-op catch counts it, the segment is not popped, and the
        // journal survives for a re-run once the user has resolved the
        // name conflict. `markNonRetryable` on the repo's own test for it
        // — "can this succeed on a retry?" — which here is a flat no: the
        // verdict is a template attribute plus a physical name, and no
        // amount of waiting changes either. Defense in depth rather than a
        // live fix: nothing between this throw and `replaySingle`'s per-op
        // catch re-classifies it TODAY (the retry loop is the
        // `createWithRollbackRetry` above, already exhausted). It is worth
        // carrying because the message QUOTES the collision text
        // (`Underlying collision: ...`), which is exactly what the
        // substring classifiers match — so should this ever be raised
        // inside a retried call, an unmarked refusal would burn the whole
        // name-release budget on a path that cannot succeed (issue #1838's
        // shape).
        const remedy = orphanRemedy(op.logicalId, ctx);
        const oldShown = refusalPhysicalId(mask(prev.physicalId));
        const newShown = refusalPhysicalId(mask(current.physicalId));
        throw ownRemedyError(
          markNonRetryable(
            new CdkdError(
              // Issue #2038, and this file's stated policy two arms down:
              // `resolveReplayProps` re-resolved the replay bag to
              // PLAINTEXT, so the create rejection quoted below can echo a
              // secret. Masked at CONSTRUCTION so the value never exists
              // inside a thrown `Error` for a later reader of the chain.
              //
              // MEASURED UNFENCEABLE, exactly like the two sibling wraps
              // below: removing either mask leaves the whole unit suite
              // green, because every downstream reader masks independently
              // and `extractDeploymentEventError` reads `message` from the
              // top level only, so the cause's text reaches no observable
              // surface. Defense-in-depth, not a tested behavior -- do not
              // record it in a PR body as one.
              mask(
                `Cannot reverse the replacement of ${refusalLogicalId(op.logicalId)} ` +
                  `(${refusalResourceType(op.resourceType)}): ` +
                  // Both physical ids are shown only when plain, not through
                  // the denylist the outer catch applies: this is the one
                  // message that carries the pasted `--orphan` remedy, so a
                  // planted `previousState.physicalId` reading `...\nTo
                  // orphan it: cdkd rollback --orphan Victim` must not stand
                  // as a forged remedy AHEAD of the guarded one, and this
                  // line names `cdkd rollback`, beside which a JSON-quoted
                  // `$( )` id runs when pasted into zsh (go-to-k/cdkd#4214).
                  `the re-create of the old resource (${oldShown}) collided with the ` +
                  `name still held by the new one (${newShown}), and ` +
                  `UpdateReplacePolicy: Retain pins that new resource in place, so cdkd will ` +
                  `not delete it to free the name. Delete the new resource yourself, or ` +
                  `remove UpdateReplacePolicy: Retain, then re-run `
              ) +
                // Outside the mask, like the `--orphan` line (#4099 review).
                rerunRollbackPhrase(ctx, 'cdkd rollback') +
                mask(
                  ` — the journal is kept, so the revert resumes from here.` +
                    (remedy.offered
                      ? ` To leave THIS resource alone and let the rest of the rollback ` +
                        `proceed, re-run with the command below: one op failure stops the ` +
                        `segment loop, so a single pinned resource otherwise halts every ` +
                        `OLDER segment too.`
                      : '') +
                    // The remedy is the message's labelled LAST line, built by
                    // `orphanRemedy`, which owns the gate on the id and the
                    // sentence for a withheld one; the AWS text is on its own
                    // line ABOVE it, so the line an operator selects is the
                    // command alone. Its own line, not the prose line: the
                    // provider's text can echo the logical id, and the prose
                    // line names `cdkd rollback` (go-to-k/cdkd#3950's S1 rule,
                    // judged per line).
                    `${remedy.clause}${describedPhysicalIdPointer(oldShown, newShown)}` +
                    `\nUnderlying collision: ${collisionLine(mask(msg))}`
                ) +
                // OUTSIDE the mask (review of #4099): it carries only the
                // vetted logical id, and a short secret-derived id needle
                // would otherwise cut into the pasteable `--orphan` command.
                remedy.line,
              'NAMED_REPLACEMENT_COLLISION',
              // The CHAIN is masked too: downstream masking only reaches a
              // top-level message, and the cause is what carries the AWS
              // rejection text a reader re-opens.
              maskSecretsInError(createError instanceof Error ? createError : undefined, secrets)
            )
          )
        );
      }
      if (deleteFirstBlocked !== undefined) {
        // go-to-k/cdkd#4690: the old properties name a resource the same deploy
        // took away, so the re-create after this delete could fail and lose
        // the resource. Keep the new one, as the delete-first route does. The
        // blocker is named by logical id only (see its warning above).
        const remedy = orphanRemedy(op.logicalId, ctx);
        const oldShown = refusalPhysicalId(mask(prev.physicalId));
        const newShown = refusalPhysicalId(mask(current.physicalId));
        throw ownRemedyError(
          markNonRetryable(
            new CdkdError(
              mask(
                `Cannot reverse the replacement of ${refusalLogicalId(op.logicalId)} ` +
                  `(${refusalResourceType(op.resourceType)}): ` +
                  `the re-create of the old resource (${oldShown}) collided with the ` +
                  `name still held by the new one (${newShown}), and the old resource's ` +
                  `properties name what ${refusalLogicalId(deleteFirstBlocked.logicalId)} was ` +
                  `before the same deploy replaced or deleted it, which this rollback may not ` +
                  `be able to restore, so cdkd will not delete the new resource to free the ` +
                  `name. Nothing was deleted. Re-deploy to fix forward, or re-run `
              ) +
                rerunRollbackPhrase(ctx, 'cdkd rollback') +
                mask(
                  ` once the old resource can be re-created — the journal is kept.` +
                    (remedy.offered
                      ? ` To leave THIS resource alone and let the rest of the rollback ` +
                        `proceed, re-run with the command below.`
                      : '') +
                    `${remedy.clause}${describedPhysicalIdPointer(oldShown, newShown)}` +
                    `\nUnderlying collision: ${collisionLine(mask(msg))}`
                ) +
                remedy.line,
              'NAMED_REPLACEMENT_COLLISION',
              maskSecretsInError(createError instanceof Error ? createError : undefined, secrets)
            )
          )
        );
      }
      logger.info(
        `  Rollback: re-create collided with the new resource's name — deleting the new ` +
          `resource (${displaySafe(mask(current.physicalId))}) first...` +
          // Issue #2668: a Type change reaches here only between two types
          // `reverseReplacementNewHoldsName` knows share a name space.
          (typeChanged
            ? ` (this op changed the resource's Type, ${safe(op.resourceType)} -> ` +
              `${safe(oldType)}, which share a name space)`
            : '')
      );
      await deleteNewResourceFirst(
        'while clearing the new resource so the old one could be re-created'
      );
      deletedNewFirst = true;
      createResult = await recreateAfterNewDeleted();
    }
  }
  return { createResult, deletedNewFirst };
}
