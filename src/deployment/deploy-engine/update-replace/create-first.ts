import { displayPhysicalId } from '../../../provisioning/secret-physical-id.js';
import { guardedReplacementCreate } from '../create.js';
import { type DeployEngine } from '../../deploy-engine.js';
import { printingSecretsFor, secretNameBagFor } from '../masking.js';
import {
  deleteReplacedAfterCreate,
  prepareFinalSnapshotForDelete,
  replaceDeleteFirstAndRecreate,
} from '../replacement.js';
import { applyDefaultNameForFallback } from '../../../provisioning/resource-name.js';
import { generatedReplacementHolderAdvice, replacementNameOrigin } from '../name-collision.js';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import {
  asIsMessage,
  displayAwsMessage,
  displaySafe,
  safeMsg,
} from '../../../utils/display-safe.js';
import { CdkdError } from '../../../utils/error-handler.js';
import {
  type ReplacementNameChange,
  renderNameHeldElsewhere,
  replacementOldHoldsSentName,
  replacementRequestsDifferentName,
} from '../../replacement-name-holder.js';
import { withCurrentResourceSecrets } from '../../resource-secrets-scope.js';
import { isNameCollisionErrorFrom, markNonRetryable } from '../../retryable-errors.js';
import {
  createSecretMasker,
  createUnionSecretMasker,
  maskSecretsInText,
  unionOfSecretBags,
} from '../../secret-redaction.js';
import { noteRetainedResource } from '../../../provisioning/providers/create-token-ledger.js';
import type { ReplacementArmInput } from './arm-input.js';

/**
 * `updateByReplacement`'s property-driven create-first arm
 * (`update-replace.ts`), split out of it (go-to-k/cdkd#5835): its name
 * collision and name-idempotent refusals, the `--replace` delete-first
 * fallbacks, and the old resource's cleanup delete. Returns the replacement's
 * create result.
 */
export async function replaceCreateFirst(
  engine: DeployEngine,
  {
    currentResource,
    equalIdIsSameResource,
    logicalId,
    noEchoDeleteValues,
    oldDeleteProvider,
    oldDeleteRoute,
    oldResourceType,
    replaceDecision,
    replaceProps,
    replaceProvider,
    resolvedProps,
    resourceType,
    stackName,
    updateReplacePolicy,
    updateSecrets,
    lostWithParent,
    nameChange,
  }: ReplacementArmInput & {
    lostWithParent: string | undefined;
    nameChange: ReplacementNameChange | undefined;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- shape varies by ResourceProvider impl
): Promise<any> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- shape varies by ResourceProvider impl
  let createResult: any;
  // Property-driven replacement: create-then-destroy (CFn
  // safe-replacement order — keeps the old alive if CREATE
  // fails so the deploy can roll back to it cleanly).
  engine.logger.info(safeMsg`  Creating new ${logicalId}...`);
  // go-to-k/cdkd#4411: a resource stored inside a parent that was just
  // destroyed and re-created is already gone, exactly as after the
  // delete-first fallback: nothing to delete, and an equal physical id
  // names the fresh resource, not a name-idempotent hand-back of the old.
  let deletedOldFirst = lostWithParent !== undefined;
  if (lostWithParent !== undefined) {
    engine.replacementRun.oldDeletedBeforeCreate.add(logicalId);
    engine.logger.info(
      safeMsg`  ${logicalId} went with ${lostWithParent}, which was destroyed and re-created under the same id: re-creating it`
    );
  }
  try {
    // go-to-k/cdkd#5064 phase 2: under a new generated name the create is
    // checked as a plain create is (a name-adopting type's holder lookup).
    createResult = await guardedReplacementCreate(
      engine,
      {
        logicalId,
        resourceType,
        stackName,
        createdVia: replaceDecision.provisionedBy,
        resolvedProps,
        keepsName: lostWithParent !== undefined,
      },
      () =>
        engine.withRetry(
          () =>
            withCurrentResourceSecrets(updateSecrets, () =>
              replaceProvider.create(logicalId, resourceType, replaceProps, {
                maskSecrets: createSecretMasker(updateSecrets),
              })
            ),
          logicalId,
          undefined,
          undefined,
          replaceProvider,
          // Went with its parent: the old copy is gone, so only the user's
          // interrupt stops this re-create (go-to-k/cdkd#5118).
          lostWithParent !== undefined
        )
    );
  } catch (createError) {
    // The AWS text every refusal below quotes: masked FIRST (the
    // create was handed resolved values), then rendered display-safe
    // and bounded, since an AWS message can echo a template value.
    // go-to-k/cdkd#2319: every refusal below is persisted, so an
    // AWS-authored collision (a raw SDK or Cloud Control error) is quoted
    // by its class plus the `--verbose` pointer, its text in `debug`. A
    // provider's own wrap keeps its text.
    const createFailure = describeAwsFailure(createError);
    const createAwsMsg = displayAwsMessage(maskSecretsInText(createFailure.detail, updateSecrets));
    const createMsg = createFailure.redacted
      ? displaySafe(maskSecretsInText(createFailure.summary, updateSecrets))
      : createAwsMsg;
    // For the refusals that close it with their own `. `: a provider's
    // redacted summary ends in a period (go-to-k/cdkd#2319), and so does
    // most AWS text.
    const createSentence = createMsg.endsWith('.') ? createMsg.slice(0, -1) : createMsg;
    // A custom-named resource cannot be safely replaced: the
    // create-first attempt collides with the old resource still
    // holding the name. CloudFormation refuses this same shape
    // ("cannot update a stack when a custom-named resource
    // requires replacing"); surface an equally clear error —
    // with a working one-command escape hatch CFn lacks —
    // instead of the raw AlreadyExists (issue #960 follow-up).
    //
    // NOTE: the detection is a HEURISTIC — an "already
    // exists" raised by something other than the replaced
    // resource's own name (e.g. an externally-owned sibling)
    // also matches. So delete-first fires only under the explicit
    // --replace opt-in, targets only the state-recorded old
    // physicalId, after the stateful guard, and only once
    // `replacementOldHoldsSentName` proves that old resource holds
    // the name the create sent (issue #3979).
    // Reads the ERROR, not the rendered message: ELBv2 states the
    // collision in prose the message matcher cannot see and must not
    // be widened to see, and the name is dropped by the provider wrap
    // (issue go-to-k/cdkd#3208).
    const nameCollision = isNameCollisionErrorFrom(createError, logicalId);
    if (!nameCollision) throw createError;
    if (createFailure.redacted) {
      engine.logger.debug(
        safeMsg`${maskSecretsInText(logicalId, updateSecrets)}: the create-first attempt collided: ${asIsMessage(createAwsMsg)}`
      );
    }
    // Retain pins the old resource (and its name) in place, so a
    // same-name replacement can never proceed under any flag.
    // (Snapshot is not special-cased HERE — the old resource is
    // still deleted so the name frees up; the delete-first helper
    // takes its final snapshot first, issue #1354.)
    const nameOrigin = replacementNameOrigin(logicalId, currentResource.physicalId);
    // Issue #2668: across a Type change the old resource can hold the
    // name only where the two types share a name space; every other
    // pair is refused by the #3979 holder proof below, whose
    // diagnosis names both types.
    // Issue #3808: every message below, and the `--replace`
    // delete-first retry, presume the old resource holds the name.
    // When the template's explicit name says otherwise, the holder
    // is another resource: refuse under every flag and policy, since
    // deleting the old resource first would only destroy it and hit
    // the same collision. Nothing has been deleted at this point.
    const nameHeldElsewhere = replacementRequestsDifferentName({
      oldResourceType,
      newResourceType: resourceType,
      desiredProperties: resolvedProps,
      recorded: currentResource.properties,
      observed: currentResource.observedProperties,
      physicalId: currentResource.physicalId,
    });
    if (nameHeldElsewhere !== undefined) {
      // Marked: a template value and a recorded name decide it, and
      // the message quotes the create's collision text, which the
      // recreate retry classifier treats as retryable.
      throw markNonRetryable(
        new CdkdError(
          safeMsg`${logicalId} (${resourceType}) requires replacement, but the create-first ` +
            safeMsg`attempt collided: ${createSentence}. ${renderNameHeldElsewhere(nameHeldElsewhere)}` +
            (engine.options.replace === true
              ? ` — so --replace was NOT applied and nothing was deleted.`
              : updateReplacePolicy === 'Retain'
                ? ` — so removing UpdateReplacePolicy: Retain and re-running with ` +
                  `\`cdkd deploy --replace\` would delete this resource and still collide.`
                : ` — so \`cdkd deploy --replace\` would delete this resource and still ` +
                  `collide.`) +
            ` Choose a name no other resource holds, or delete the resource holding it if ` +
            `it is yours.`,
          'NAMED_REPLACEMENT_COLLISION',
          // Chained like the fallback twin, so the persisted event
          // names the AWS rejection; safe because the refusal is
          // marked, which the retry classifiers read first.
          createError instanceof Error ? createError : undefined
        )
      );
    }
    // Issue #3979: the check above refuses only a KNOWN different
    // explicit name. With no name in the template, or one a
    // rewriting provider (IAM, ELBv2) sends under this deploy's
    // stack scope and prefix flag, the collision may be with an
    // orphan of an earlier attempt, a replayed create or a
    // squatter — and deleting the old resource then destroys a live
    // resource that never held the name, and collides again. So
    // prove the old resource holds the name the create SENT, here in
    // the create's own async scope, and refuse when it is not proven.
    // Ahead of the Retain and no-flag refusals too: both presume
    // the old resource holds the name, and the no-flag one advises
    // the `--replace` this check would then refuse.
    const holder = replacementOldHoldsSentName({
      createType: resourceType,
      holderType: oldResourceType,
      requested: replaceProps,
      // A nameless SDK create: the name the provider mints, trusted
      // only for a type audited to mint cdkd's rule verbatim.
      generated: applyDefaultNameForFallback(logicalId, resourceType, resolvedProps, 'omit'),
      recorded: currentResource.properties,
      observed: currentResource.observedProperties,
      physicalId: currentResource.physicalId,
      logicalId,
      createdVia: replaceDecision.provisionedBy,
      holderVia: currentResource.provisionedBy,
      mask: (value) => maskSecretsInText(value, updateSecrets),
    });
    if (!holder.holds) {
      const flagClause =
        engine.options.replace === true
          ? ` --replace was NOT applied and nothing was deleted.`
          : updateReplacePolicy === 'Retain'
            ? ` Nothing was deleted. UpdateReplacePolicy: Retain keeps the resource ` +
              `being replaced in place; removing it and re-running with ` +
              `\`cdkd deploy --replace\` would refuse the same way rather than delete it.`
            : ` Nothing was deleted, and \`cdkd deploy --replace\` would refuse the ` +
              `same way rather than delete it.`;
      throw markNonRetryable(
        new CdkdError(
          // Masked at construction: the create's collision text can
          // echo a resolved value.
          maskSecretsInText(
            `${displaySafe(logicalId)} (${displaySafe(resourceType)}) requires ` +
              `replacement, but the create-first attempt collided: ${holder.diagnosis} — ` +
              (holder.known
                ? `so another resource holds the colliding name (an orphan of an ` +
                  `earlier attempt, or one made outside this stack), and deleting the ` +
                  `resource being replaced would destroy it and collide again.` +
                  flagClause +
                  ` Remove or rename the resource holding that name if it is yours, ` +
                  `then re-run the deploy.`
                : `so if another resource holds it (an orphan of an ` +
                  `earlier attempt, or one made outside this stack), deleting the ` +
                  `resource being replaced would destroy it and collide again.` +
                  flagClause +
                  ` Remove or rename whatever holds that name if it is yours — if ` +
                  `that is the resource being replaced itself, delete it by hand — ` +
                  `then re-run the deploy.`) +
              generatedReplacementHolderAdvice({
                stackName,
                logicalId,
                change: nameChange,
                oldPhysicalId: currentResource.physicalId,
                // The printing bag too: the old name can be secret-derived.
                mask: (value) =>
                  maskSecretsInText(
                    value,
                    unionOfSecretBags([
                      updateSecrets,
                      printingSecretsFor(engine.secretsRun, logicalId),
                    ])
                  ),
              }) +
              ` Underlying collision: ${createMsg}`,
            updateSecrets
          ),
          'NAMED_REPLACEMENT_COLLISION',
          // Chained like the #3808 refusal above: marked, so the
          // retry classifiers never read the collision text.
          createError instanceof Error ? createError : undefined
        )
      );
    }
    if (updateReplacePolicy === 'Retain') {
      throw new CdkdError(
        safeMsg`${logicalId} (${resourceType}) requires replacement, but its physical name ` +
          `is still held by the existing resource AND UpdateReplacePolicy: Retain ` +
          safeMsg`pins that resource in place. ${nameOrigin.descriptor}. ` +
          safeMsg`${nameOrigin.remedy} — with Retain, the old resource keeps the name, so a ` +
          `same-name replacement can never proceed.`,
        'NAMED_REPLACEMENT_COLLISION'
      );
    }
    if (engine.options.replace !== true) {
      throw new CdkdError(
        safeMsg`${logicalId} (${resourceType}) requires replacement, but the create-first ` +
          safeMsg`attempt collided with the existing resource: ${createSentence}. ` +
          safeMsg`${nameOrigin.descriptor}, so the CloudFormation-style safe replacement ` +
          `order (create the new resource before deleting the old) cannot reuse the ` +
          `occupied name — CloudFormation refuses this shape with "cannot update a ` +
          `stack when a custom-named resource requires replacing". ` +
          safeMsg`${nameOrigin.remedy}, or re-run with \`cdkd deploy --replace\` to delete ` +
          `the old resource FIRST and recreate it under the same name (the resource ` +
          `is briefly unavailable while it is recreated).`,
        'NAMED_REPLACEMENT_COLLISION'
      );
    }
    // --replace opt-in: the user accepts delete-first semantics
    // (the stateful guard for this property-driven replacement
    // already ran above). Delete the old holder — proven above —
    // then re-create.
    // "named" not "custom-named": the name may be cdkd's own
    // derivation, and this line PRINTS the physical id, so a user
    // reading it against a template that declares no such name was
    // being told it was theirs (issue #1636).
    engine.logger.info(
      `  Create-first collided with the existing resource's name and --replace is ` +
        safeMsg`set — deleting old ${logicalId} (${currentResource.physicalId}) first...`
    );
    deletedOldFirst = true;
    createResult = await replaceDeleteFirstAndRecreate(
      engine.replacementRun,
      engine.replacementDeps(),
      logicalId,
      resourceType,
      oldResourceType,
      currentResource,
      oldDeleteProvider,
      replaceProvider,
      replaceProps,
      updateSecrets,
      updateReplacePolicy,
      oldDeleteRoute.provisionedBy,
      noEchoDeleteValues
    );
  }

  // Issue #1238: a name-idempotent Create API (e.g. SQS
  // CreateQueue with an unchanged QueueName) does NOT collide
  // when the template carries an explicit physical name — it
  // silently returns the OLD resource's physicalId as the "new"
  // one. The "new" resource IS the old one, so the delete-old
  // step below would destroy the very resource the deploy just
  // reported as created, and state would keep pointing at a
  // deleted resource (observed live with a FIFO queue). Mirror
  // the create-first collision handling above: hard-fail under
  // Retain, fail with the rename / --replace remediation without
  // the opt-in, and fall back to delete-first + re-create under
  // --replace. Skipped when the old resource was already deleted
  // (delete-first fallback) — there, re-acquiring the same
  // physical id under the same name is the expected outcome. Skipped
  // too when `equalIdIsSameResource` is false (issue #2668): across
  // two types an equal id is two resources (custom resources
  // excepted), so the "new" one is NOT the old one and the delete-old
  // step below is aimed — through the OLD type's provider — at the
  // right one.
  if (
    equalIdIsSameResource &&
    !deletedOldFirst &&
    createResult.physicalId === currentResource.physicalId
  ) {
    const idempotentNameOrigin = replacementNameOrigin(logicalId, currentResource.physicalId);
    if (updateReplacePolicy === 'Retain') {
      throw new CdkdError(
        safeMsg`${logicalId} (${resourceType}) requires replacement, but its Create API is ` +
          `name-idempotent: the create-first attempt returned the existing resource ` +
          safeMsg`(${currentResource.physicalId}) instead of creating a new one, and ` +
          `UpdateReplacePolicy: Retain pins that resource in place. ` +
          safeMsg`${idempotentNameOrigin.descriptor}. ${idempotentNameOrigin.remedy} — with ` +
          `Retain, the old resource keeps the name, so a same-name replacement can ` +
          `never proceed.`,
        'NAMED_REPLACEMENT_IDEMPOTENT_CREATE'
      );
    }
    if (engine.options.replace !== true) {
      throw new CdkdError(
        safeMsg`${logicalId} (${resourceType}) requires replacement, but its Create API is ` +
          `name-idempotent: the create-first attempt returned the EXISTING resource ` +
          safeMsg`(${currentResource.physicalId}) instead of creating a new one, so deleting ` +
          `the "old" resource would silently destroy the resource the deploy just ` +
          safeMsg`reported as created. ${idempotentNameOrigin.descriptor}; ` +
          safeMsg`${idempotentNameOrigin.remedy}, or re-run with ` +
          `\`cdkd deploy --replace\` to delete the old resource FIRST and recreate ` +
          `it under the same name (the resource is briefly unavailable while it is ` +
          `recreated). Note: this branch is also reached when the old resource was ` +
          `deleted out-of-band and the physical id is name-derived — there the ` +
          `create was a genuine fresh create; \`--replace\` converges that case too.`,
        'NAMED_REPLACEMENT_IDEMPOTENT_CREATE'
      );
    }
    // --replace opt-in: same delete-first fallback as the
    // collision path — the "created" resource is the old one, so
    // deleting the old physical id releases the name, and the
    // re-create applies the new properties for real.
    engine.logger.info(
      `  Create-first returned the existing resource (name-idempotent Create API) ` +
        safeMsg`and --replace is set — deleting old ${logicalId} ` +
        safeMsg`(${currentResource.physicalId}) first...`
    );
    deletedOldFirst = true;
    createResult = await replaceDeleteFirstAndRecreate(
      engine.replacementRun,
      engine.replacementDeps(),
      logicalId,
      resourceType,
      oldResourceType,
      currentResource,
      oldDeleteProvider,
      replaceProvider,
      replaceProps,
      updateSecrets,
      updateReplacePolicy,
      oldDeleteRoute.provisionedBy,
      noEchoDeleteValues
    );
  }

  if (deletedOldFirst) {
    // Old resource is already gone (delete-first fallback above).
  } else if (updateReplacePolicy === 'Retain') {
    // Issue #2603: same record as the `--recreate-via-*` arm above —
    // the cleanup delete is skipped, so the rollback must re-adopt
    // rather than re-create.
    engine.replacementRun.retainedOldOnReplacement.add(logicalId);
    // go-to-k/cdkd#4438: as on the `--recreate-via-*` arms above.
    await noteRetainedResource(oldResourceType, logicalId);
    engine.logger.info(
      safeMsg`  Retaining old ${logicalId} (${displayPhysicalId(currentResource.resourceType, currentResource.physicalId)}) - UpdateReplacePolicy: Retain`
    );
  } else {
    engine.logger.info(
      safeMsg`  Deleting old ${logicalId} (${displayPhysicalId(currentResource.resourceType, currentResource.physicalId)})...`
    );
    // `UpdateReplacePolicy: Snapshot` (issue #1354): snapshot the
    // old resource before the post-replacement cleanup delete.
    // Two failure classes, deliberately handled differently:
    //   - a REFUSAL (`FINAL_SNAPSHOT_UNSUPPORTED` — cc-api routing
    //     or a type cdkd cannot snapshot) is a CONFIGURATION error
    //     the user must resolve, so it propagates and fails the
    //     resource, matching CloudFormation failing the update.
    //   - a transient snapshot failure / timeout degrades to this
    //     site's existing warn-and-continue policy, but SKIPS the
    //     delete: the old resource stays alive (leaked, warned)
    //     rather than being deleted without its promised snapshot.
    let cleanupFinalSnapshotId: string | undefined;
    let snapshotBlockedDelete = false;
    try {
      cleanupFinalSnapshotId = await prepareFinalSnapshotForDelete(
        engine.replacementDeps(),
        logicalId,
        oldResourceType,
        currentResource,
        updateReplacePolicy,
        // The cleanup delete's masker (`deleteReplacedAfterCreate`),
        // go-to-k/cdkd#2319.
        createUnionSecretMasker([updateSecrets, secretNameBagFor(engine.secretsRun, logicalId)])
      );
    } catch (snapshotError) {
      if (
        snapshotError instanceof CdkdError &&
        snapshotError.code === 'FINAL_SNAPSHOT_UNSUPPORTED'
      ) {
        throw snapshotError;
      }
      snapshotBlockedDelete = true;
      // go-to-k/cdkd#2631: the delete was never sent, so the old resource
      // is whole and a rollback may re-adopt it.
      engine.replacementRun.replacedOldMaySurvive.set(logicalId, 'kept');
      engine.logger.warn(
        safeMsg`  ⚠ Final snapshot for old ${logicalId} (${currentResource.physicalId}) ` +
          safeMsg`failed: ${asIsMessage(describeAwsFailure(snapshotError).detail)}. ` +
          `The old resource was NOT deleted (UpdateReplacePolicy: Snapshot) — delete it ` +
          `manually once you have a snapshot; it is no longer tracked in state.`
      );
    }
    if (!snapshotBlockedDelete) {
      await deleteReplacedAfterCreate(
        engine.replacementRun,
        engine.replacementDeps(),
        logicalId,
        oldResourceType,
        currentResource,
        oldDeleteProvider,
        currentResource.properties,
        cleanupFinalSnapshotId,
        updateReplacePolicy,
        updateSecrets,
        oldDeleteRoute.provisionedBy,
        noEchoDeleteValues
      );
    }
  }
  return createResult;
}
