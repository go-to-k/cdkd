import { displayPhysicalId } from '../../../provisioning/secret-physical-id.js';
import { noEchoDeleteValuesFromResolved } from '../../noecho-delete-reresolution.js';
import { guardedReplacementCreate } from '../create.js';
import { noEchoPositionSources } from '../noecho.js';
import { printingSecretsFor, secretNameBagFor } from '../masking.js';
import { type DeployEngine } from '../../deploy-engine.js';
import {
  checkedReplacementNameChange,
  createFirstThenDeleteOld,
  prepareFinalSnapshotForDelete,
  replacementDeleteContext,
} from '../replacement.js';
import { preparePropertiesForCcApi } from '../routing.js';
import { replacementNameOrigin } from '../name-collision.js';
import { isInterruptedWaitError } from '../../../provisioning/interrupt-watch.js';
import {
  recordedProtectionEvidence,
  recordedProtectionNote,
} from '../../../provisioning/recorded-protection.js';
import {
  isStatefulRecreateTargetForReplace,
  renderStatefulReason,
} from '../../../provisioning/stateful-types.js';
import { isWaitAbandonedError } from '../../../provisioning/wait-abandoned.js';
import { isMarkedNotGone } from '../../../provisioning/not-gone.js';
import type {
  CloudFormationTemplate,
  ResourceCreateResult,
  ResourceDeleteResult,
  ResourceUpdateResult,
} from '../../../types/resource.js';
import { type ResourceState } from '../../../types/state.js';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import { asIsMessage, safeMsg } from '../../../utils/display-safe.js';
import { CdkdError } from '../../../utils/error-handler.js';
import { deleteSkipReason, deleteSkippedMessage } from '../../delete-outcome.js';
import { reportDeleteGuards } from '../../delete-guard-scope.js';
import {
  renderNameHeldElsewhere,
  replacementRequestsDifferentName,
} from '../../replacement-name-holder.js';
import { withCurrentResourceSecrets, withPrintingSecrets } from '../../resource-secrets-scope.js';
import {
  isMarkedNonRetryable,
  isNameCollisionErrorFrom,
  markNonRetryable,
  markRedactedCause,
} from '../../retryable-errors.js';
import {
  createSecretMasker,
  createUnionSecretMasker,
  maskSecretsInText,
  unionOfSecretBags,
} from '../../secret-redaction.js';
import { equalIdNamesDifferentResources } from '../../type-change-guard.js';
import type { RecordedSecretValues } from '../../secret-redaction.js';
import { noteRetainedResource } from '../../../provisioning/providers/create-token-ledger.js';
import { refuseRestoreFromItself } from '../../../provisioning/restore-source-guard.js';
import { maskedInputSources } from '../resolver-context.js';
import type { ProviderRoutingDecision } from '../../../provisioning/provider-registry.js';

/**
 * The update-not-supported replacement fallback of `updateInPlace`
 * (`update-in-place.ts`), split out of it (#5835). It runs once the update
 * threw: `updateError` is what it threw.
 */
export async function replaceFallbackFor(
  engine: DeployEngine,
  {
    currentProps,
    currentResource,
    logicalId,
    replaceOptIn,
    resolvedProps,
    resourceType,
    stackName,
    stateResources,
    template,
    updateDecision,
    updateError,
    updateProvider,
    updateReplacePolicy,
    updateSecrets,
  }: {
    currentProps: Record<string, unknown>;
    currentResource: ResourceState;
    logicalId: string;
    replaceOptIn: boolean;
    resolvedProps: Record<string, unknown>;
    resourceType: string;
    stackName: string;
    stateResources: Record<string, ResourceState>;
    template: CloudFormationTemplate | undefined;
    updateDecision: ProviderRoutingDecision;
    updateError: unknown;
    updateProvider: ProviderRoutingDecision['provider'];
    updateReplacePolicy: 'Delete' | 'Retain' | 'Snapshot' | undefined;
    updateSecrets: RecordedSecretValues;
  }
) {
  // `UpdateReplacePolicy: Retain` on the fallback replacement
  // (issue #2518). Until this landed, the fallback deleted the old
  // resource whatever the policy said, while every OTHER
  // replacement path in this engine honoured `Retain`: the
  // property-driven cleanup below logs "Retaining old ...", the
  // `--recreate-via-*` path warns and leaks it, and both
  // delete-first fallbacks refuse the replacement outright. The
  // same template attribute therefore decided retention on one
  // path and nothing on the other, so a resource the user
  // explicitly marked to survive its replacement was destroyed —
  // and for a stateful type, its data with it.
  //
  // Two things made honouring it the right arm rather than
  // refusing the replacement outright:
  //   - It is what the SIBLING path already does. A refusal here
  //     would have swapped one internal divergence (retain there,
  //     delete here) for another (retain there, refuse here), and
  //     CloudFormation itself retains on replacement.
  //   - the rollback replay (`rollback-executor/replay-revert.ts`) ALREADY
  //     assumes it: an op classified `reverse-replacement-readopt`
  //     deletes the new resource and points state back at the old
  //     physical id WITHOUT re-creating it. With the old resource
  //     deleted, that rollback re-adopted a dead id. (That verdict
  //     was read off `previousState.updateReplacePolicy` until
  //     issue #2603 moved it onto the record this path now writes
  //     — see `retainedOldOnReplacement`, set on the arm below.)
  //
  // So under `Retain` this path becomes create-ONLY: the old
  // resource is left in place (orphaned, exactly as the
  // property-driven path leaves it) and only the replacement
  // create runs. `Retain` and `Snapshot` are alternative values of
  // one attribute, so nothing is skipped by not preparing a final
  // snapshot on this arm.
  //
  // The order flip is safe in the same direction as the
  // property-driven path's: creating first keeps the old resource
  // alive if the create fails. What it CANNOT do is reuse a
  // physical name the retained resource still holds, so both
  // shapes that follow from that are refused LOUDLY below with the
  // same error codes the property-driven path already uses.
  //
  // TEMPLATE ONLY, via the shared `updateReplacePolicy` binding —
  // the same read the property-driven guard's exemption uses, so
  // the two ask "what is the user applying NOW?" of one value.
  // Only `'Retain'` is honoured: `RetainExceptOnCreate` is a
  // `DeletionPolicy` value CloudFormation rejects for
  // `UpdateReplacePolicy`, so it cannot reach here.
  const retainOldOnReplace = updateReplacePolicy === 'Retain';
  // Stateful guard for BOTH triggers (issue #2514). A stateful
  // type (RDS / DynamoDB / EFS / etc.) must not be silently
  // DELETE+CREATEd — require --force-stateful-recreation.
  //
  // It used to sit inside `if (replaceOptIn)`, so the CC
  // auto-fallback recreated a stateful resource on a plain
  // `cdkd deploy` with neither `--replace` nor
  // `--force-stateful-recreation`, while the SAME type behind an
  // SDK provider was refused twice over. The discriminator was
  // neither the resource nor the user's intent but which
  // provisioning layer the type happened to route through — and
  // routing is re-decided every deploy (`provisionedBy` is
  // recorded, not pinned), so the guard's presence was not
  // something a user could reason about. The delete below is
  // identical on both triggers, so the data-loss consent belongs
  // to the REPLACEMENT, not to the trigger.
  //
  // Conservative variant: this fires mid-deploy with no chance to
  // run either async emptiness probe, so a deferred S3 bucket — and
  // likewise a log group with no recorded retention, CloudWatch
  // Logs' never-expire (issue #2558) — is treated as stateful
  // (block unless forced).
  //
  // `UpdateReplacePolicy: Retain` IS an exemption here since issue
  // #2518, exactly as it is on the property-driven replacement
  // guard in `update-replace.ts` and for the same reason: the old resource and its
  // data survive the replacement (orphaned, not deleted), so there
  // is no data loss for `--force-stateful-recreation` to confirm.
  // Demanding the consent flag for a replacement that destroys
  // nothing would be a refusal whose only remedy is a flag that
  // means "yes, lose the data" — advice that was actively wrong
  // for the one user who had already asked to keep it.
  //
  // `Snapshot` stays NON-exempt on both paths: cdkd does take the
  // final snapshot, but a snapshot is a point-in-time copy, not a
  // surviving resource.
  const statefulReason = retainOldOnReplace
    ? null
    : isStatefulRecreateTargetForReplace(
        resourceType,
        currentProps,
        // The observed bag, for the same reason the property-driven
        // guard in `update-replace.ts` passes it (issue [#2521]).
        currentResource.observedProperties
      );
  if (statefulReason && engine.options.forceStatefulRecreation !== true) {
    // No `Retain` note here any more (issue #2518): reaching this
    // throw MEANS the template is not applying `Retain`, because
    // `retainOldOnReplace` short-circuits `statefulReason` to
    // `null` above. The note this replaced said "Retain does NOT
    // protect this path", which is now false — and it was advice
    // whose remedy (`--force-stateful-recreation`) deleted the very
    // resource the user had asked to keep.
    //
    // The `Retain` read stays TEMPLATE ONLY — deliberately no
    // `?? currentResource.updateReplacePolicy` fallback, which is
    // where the snapshot attribute a few lines below DOES fall
    // back to state. The two decisions are not the same shape:
    // omitting a promised snapshot is destructive, so that read is
    // conservative, while this one describes the attribute the user
    // is applying NOW. Falling back to state would retain a
    // resource on the strength of a policy the template being
    // applied has since dropped.
    //
    // Hence the shared `updateReplacePolicy` binding, read once in
    // this UPDATE branch's own scope: it IS the template-only read,
    // so the property-driven guard's exemption and this path's ask
    // the same question of the same value, and a future change to
    // one cannot leave the other on an older spelling. The snapshot
    // read below is the deliberate exception and stays spelled out
    // with its state fallback.
    //
    // `markNonRetryable` for the same reason as the property-driven
    // guard's twin in `update-replace.ts`: a flag plus a state-recorded bag decide
    // it, and the message carries a template-controlled logical id
    // into substring-matching classifiers.
    // Issue #2610 site 10: both arms advise a flag that cannot remove a
    // resource AWS protects — this path's delete never carries
    // `removeProtection` either.
    const protection = recordedProtectionEvidence(
      resourceType,
      currentProps,
      currentResource.observedProperties,
      engine.stackRegion
    );
    throw markNonRetryable(
      new CdkdError(
        replaceOptIn
          ? safeMsg`--replace would DELETE + CREATE the stateful resource ${logicalId} ` +
              safeMsg`(${resourceType}) — ${renderStatefulReason(statefulReason)}. ` +
              (protection
                ? safeMsg`${recordedProtectionNote(protection, '--replace --force-stateful-recreation')} ` +
                  `Or change the resource's definition to avoid the immutable-property change.`
                : `Re-run with --force-stateful-recreation to confirm the data loss, or ` +
                  `change the resource definition to avoid the immutable-property change.`)
          : safeMsg`${logicalId} (${resourceType}) cannot be updated in place by the ` +
              `provisioning layer it routes through, so applying this change would ` +
              `DELETE + CREATE it — but it is a stateful resource: ` +
              safeMsg`${renderStatefulReason(statefulReason)}. ` +
              (protection
                ? safeMsg`${recordedProtectionNote(protection, '--force-stateful-recreation')} ` +
                  `Or change the resource's definition to avoid the update.`
                : `Re-run with --force-stateful-recreation to confirm the data loss, or ` +
                  `change the resource definition to avoid the update.`),
        'STATEFUL_REPLACE_BLOCKED',
        // Chain the rejection that routed us here: the message
        // above names no layer and no AWS text, so this is the
        // only place that rejection is retained.
        //
        // Where it actually SURFACES is narrower than the terminal
        // output: `formatError` (`src/utils/error-handler.ts`)
        // renders exactly ONE `Caused by:` level, and the error the
        // CLI prints is the `ProvisioningError` this method's catch
        // wraps the refusal in — so that one level is the refusal's
        // own message and the raw Cloud Control text stays a hop
        // below it, unprinted. It DOES reach the persisted
        // `RESOURCE_FAILED` event: `extractDeploymentEventError`
        // walks the whole chain for `awsErrorCode` / `requestId`,
        // so `cdkd events` can name the AWS rejection behind the
        // refusal (pinned in `tests/unit/types/deployment-events.test.ts`).
        //
        // Safe to chain now that the refusal is marked:
        // `isMarkedNonRetryable` is consulted before any chain-text
        // classification, and `ccUnsupported` reads only the
        // exception NAME and `ccErrorCode` down the chain, never a
        // message (issue #3810).
        updateError instanceof Error ? updateError : undefined
      )
    );
  }
  // The replacement create gets a fresh routing decision, against
  // the record as its unrecognized-property baseline (issue #3713,
  // same reason as `replaceDecision`). Taken before anything is
  // deleted, since the name check below needs its route.
  const replDecision = engine.providerRegistry.getProviderFor({
    resourceType,
    properties: resolvedProps,
    previousProperties: currentResource.properties,
  });
  const replProvider = replDecision.provider;
  const replProps =
    replDecision.provisionedBy === 'cc-api'
      ? preparePropertiesForCcApi(engine.providerRegistry, resourceType, resolvedProps, logicalId)
      : resolvedProps;
  // go-to-k/cdkd#3937 / #3931, as on the property-driven path: a
  // name known to move off the old resource's, probed where the
  // create would adopt a taken one. Under Retain it only probes.
  const fallbackNameChange = await checkedReplacementNameChange(engine.replacementDeps(), {
    logicalId,
    resourceType,
    oldResourceType: resourceType,
    stackName,
    currentResource,
    desiredProperties: resolvedProps,
    createProvider: replProvider,
    createdVia: replDecision.provisionedBy,
    createProps: replProps,
    secrets: updateSecrets,
  });
  const createFirst = !retainOldOnReplace && fallbackNameChange !== undefined;
  // go-to-k/cdkd#4682: still in the template, so a custom resource's
  // delete of the old record gets today's values at its NoEcho
  // coordinates instead of being skipped. Never persisted or logged.
  const noEchoDeleteValues = await noEchoDeleteValuesFromResolved({
    record: currentResource,
    templateResource: template?.Resources?.[logicalId],
    resolvedProperties: resolvedProps,
    noEchoParameters:
      noEchoPositionSources(engine.noEchoRun, stateResources, template)?.parameters ?? new Set(),
    conditions: engine.noEchoRun.noEchoConditions,
    secrets: updateSecrets,
    inputSources:
      template &&
      maskedInputSources(
        engine.resolverContextDeps(),
        template,
        stateResources,
        engine.noEchoRun.noEchoConditions,
        stackName
      ),
  });
  engine.logger.info(
    retainOldOnReplace
      ? safeMsg`UPDATE not supported for ${logicalId} (${resourceType}), replacing ` +
          `(CREATE only — UpdateReplacePolicy: Retain keeps the old resource)`
      : createFirst
        ? safeMsg`UPDATE not supported for ${logicalId} (${resourceType}), replacing (CREATE → DELETE — the new name differs from the old resource's)`
        : safeMsg`UPDATE not supported for ${logicalId} (${resourceType}), replacing (DELETE → CREATE)`
  );
  if (retainOldOnReplace) {
    // go-to-k/cdkd#4438: the kept resource holds this stack's create
    // token, so the create below must not send it again.
    await noteRetainedResource(resourceType, logicalId);
  }
  if (!retainOldOnReplace && !createFirst) {
    // go-to-k/cdkd#5638: before the delete, which is what would lose the source.
    refuseRestoreFromItself(resourceType, replProps, currentResource.physicalId, logicalId, {
      region: engine.stackRegion,
      account: engine.options.consumerAccount,
    });
    // `UpdateReplacePolicy: Snapshot` (issue #1354): snapshot the
    // old resource before the fallback replacement's delete. The
    // TEMPLATE is authoritative here — unlike a destroy, an update
    // necessarily has the resource in the template, and the
    // attribute being applied is the desired one (state records
    // only what the LAST deploy used, so a template that just
    // gained `Snapshot` must not be overridden by a stale
    // `Delete`). State is the fallback for a template that omits
    // the attribute, and this is the ONLY snapshot read on the
    // replacement paths that has one: every other site passes
    // the shared `updateReplacePolicy` binding (read in `update.ts`), which is template-only.
    // The divergence is deliberate — omitting a promised snapshot is
    // destructive, so this read is conservative, while the `Retain`
    // decision in `update.ts` only describes what the user is applying now.
    //
    // Unreachable under `Retain` (issue #2518) and not merely
    // skipped: `UpdateReplacePolicy` is ONE attribute, so a
    // template applying `Retain` is not applying `Snapshot`, and
    // the state fallback cannot reintroduce it — `??` only fires
    // when the template omits the attribute entirely, which is
    // exactly when `retainOldOnReplace` is false.
    const fallbackUpdateReplacePolicy =
      template?.Resources?.[logicalId]?.UpdateReplacePolicy ?? currentResource.updateReplacePolicy;
    const fallbackFinalSnapshotId = await prepareFinalSnapshotForDelete(
      engine.replacementDeps(),
      logicalId,
      resourceType,
      currentResource,
      fallbackUpdateReplacePolicy,
      // The fallback delete's own masker (below), go-to-k/cdkd#2319.
      createUnionSecretMasker([updateSecrets, secretNameBagFor(engine.secretsRun, logicalId)])
    );
    // Initialized because the catch below can leave it unassigned.
    let fallbackDeleteResult: void | ResourceDeleteResult = undefined;
    try {
      fallbackDeleteResult = await withPrintingSecrets(updateSecrets, () =>
        updateProvider.delete(logicalId, currentResource.physicalId, resourceType, currentProps, {
          expectedRegion: engine.stackRegion,
          forceDataDelete: engine.options.forceStatefulRecreation === true,
          ...(fallbackFinalSnapshotId !== undefined && {
            finalSnapshotIdentifier: fallbackFinalSnapshotId,
          }),
          ...replacementDeleteContext(engine.replacementDeps(), fallbackUpdateReplacePolicy),
          recordedAttributes: currentResource.attributes,
          // go-to-k/cdkd#4043: where the record holds a NoEcho mask.
          recordedNoEchoLeaves: currentResource.noEchoLeaves,
          ...(noEchoDeleteValues !== undefined && { noEchoDeleteValues }),
          // go-to-k/cdkd#2007: the bag this deploy resolved, which the call
          // also logs under; the physical id can be a name it derives.
          maskSecrets: createUnionSecretMasker([
            updateSecrets,
            secretNameBagFor(engine.secretsRun, logicalId),
          ]),
        })
      );
    } catch (deleteError) {
      // If old resource doesn't exist (already deleted), proceed with CREATE
      const deleteMsg = describeAwsFailure(deleteError).detail;
      // Typed check FIRST, and this arm is the worst of the four
      // already-deleted classifiers to get wrong (issue
      // go-to-k/cdkd#3236): reading "already gone" here does not
      // merely drop a state row, it proceeds to CREATE the
      // replacement BESIDE an old resource whose delete may still
      // be running. A `CloudControlWaitAbandonedError` says
      // exactly that — cdkd stopped watching an operation still in
      // flight — and its message interpolates the LOGICAL ID, so a
      // construct named `PageNotFound` satisfies the bare
      // `NotFound` needle below. The substring match cannot be
      // made safe; any needle can appear in a user-chosen name.
      //
      // This arm carried NO typed guard at all, unlike its two
      // siblings — so `isInterruptedWaitError` and
      // `isMarkedNonRetryable` join it here for the same reasons
      // those siblings state, and `isMarkedNotGone` (a provider's
      // typed "not this resource's not-found", go-to-k/cdkd#5228).
      if (
        !isWaitAbandonedError(deleteError) &&
        !isInterruptedWaitError(deleteError) &&
        !isMarkedNonRetryable(deleteError) &&
        !isMarkedNotGone(deleteError) &&
        (deleteMsg.includes('does not exist') ||
          deleteMsg.includes('not found') ||
          deleteMsg.includes('NotFound'))
      ) {
        engine.logger.debug(
          safeMsg`Old resource ${logicalId} already gone, proceeding with CREATE`
        );
      } else {
        throw deleteError;
      }
    }
    // Issue #1762: a skip fails the resource here too — the CREATE
    // below re-provisions the resource, so proceeding would leave
    // the old one alive and untracked. Deliberately OUTSIDE the
    // catch: the classifier above reads "already gone" out of an
    // error MESSAGE, and a skip must never be read that way.
    // Issue #2422: before the skip check below, which throws.
    reportDeleteGuards(fallbackDeleteResult, {
      physicalId: currentResource.physicalId,
      resourceType,
      // The layer `updateProvider` was routed to, which can differ from
      // the record's (an SDK-unwired auto-route, `--pin-cc-api`).
      provisionedBy: updateDecision.provisionedBy,
    });
    const fallbackSkipReason = deleteSkipReason(fallbackDeleteResult);
    if (fallbackSkipReason !== undefined) {
      throw new Error(
        deleteSkippedMessage(
          logicalId,
          currentResource.physicalId,
          fallbackSkipReason,
          'during the UPDATE-not-supported replacement'
        )
      );
    }
    engine.replacementRun.oldDeletedBeforeCreate.add(logicalId);
    // go-to-k/cdkd#5131: as the --replace fallback, for a type whose
    // delete returns while AWS still holds the name.
    await updateProvider.waitForNameReleased?.(
      logicalId,
      currentResource.physicalId,
      resourceType,
      {
        isInterrupted: () => engine.userInterrupted,
        maskSecrets: createSecretMasker(updateSecrets),
      }
    );
  }
  // Set only on the retain arm; drives the `partial` outcome below.
  let retainedSurvivorReason: string | undefined;
  let createResult: ResourceCreateResult;
  try {
    createResult =
      createFirst && fallbackNameChange !== undefined
        ? await createFirstThenDeleteOld(engine.replacementRun, engine.replacementDeps(), {
            stackName,
            createdVia: replDecision.provisionedBy,
            resolvedProps,
            logicalId,
            resourceType,
            oldResourceType: resourceType,
            currentResource,
            createProvider: replProvider,
            createProps: replProps,
            deleteProvider: updateProvider,
            deleteProvisionedBy: updateDecision.provisionedBy,
            deleteProperties: currentProps,
            secrets: updateSecrets,
            change: fallbackNameChange,
            equalIdIsSameResource: !equalIdNamesDifferentResources({
              resourceType,
              physicalId: currentResource.physicalId,
              oldProperties: currentResource.properties,
              newProperties: resolvedProps,
            }),
            // The same state fallback as the DELETE → CREATE arm's
            // snapshot read, for the same reason.
            snapshotPolicy:
              template?.Resources?.[logicalId]?.UpdateReplacePolicy ??
              currentResource.updateReplacePolicy,
            deletePolicy:
              template?.Resources?.[logicalId]?.UpdateReplacePolicy ??
              currentResource.updateReplacePolicy,
            trigger: 'the provisioning layer cannot update it in place',
            noEchoDeleteValues,
          })
        : await guardedReplacementCreate(
            engine,
            {
              logicalId,
              resourceType,
              stackName,
              createdVia: replDecision.provisionedBy,
              resolvedProps,
            },
            () =>
              engine.withRetry(
                () =>
                  withCurrentResourceSecrets(updateSecrets, () =>
                    replProvider.create(logicalId, resourceType, replProps, {
                      maskSecrets: createSecretMasker(updateSecrets),
                    })
                  ),
                logicalId,
                undefined,
                undefined,
                replProvider,
                // Delete-first: the old copy is gone unless Retain kept
                // it, so only the user's interrupt stops this re-create
                // (go-to-k/cdkd#5118).
                !retainOldOnReplace
              )
          );
  } catch (createError) {
    // The create-first arm's errors are already its own, and the
    // old resource is untouched there.
    if (createFirst) throw createError;
    // Only `Retain` turned this into a create-FIRST path, so only
    // `Retain` owes the name-collision translation (issue #2518).
    // Without it the user reads a raw `AlreadyExists` and has no
    // way to connect it to the policy that caused it.
    if (!retainOldOnReplace) {
      // ...but the NON-Retain arm owes the other half (issue
      // #2616): it is the DELETE → CREATE order, so by the time
      // this runs the old resource is GONE. Two sub-paths reach
      // here and the wording covers both: the delete above
      // succeeded, OR it rejected with a not-found the block's
      // classifier read as "already gone" — where something ELSE
      // removed the resource. So the sentence names NO actor: it
      // states only that the resource is gone, which is true on
      // both sub-paths and is the fact the user needs. Two review
      // rounds landed here — "already deleted the old resource"
      // and then "replacement removed the old resource" both keep
      // the replacement as the subject of the removal, which the
      // second sub-path falsifies. Handing back the
      // provider's raw create error leaves the user unable to tell
      // "the replacement never started" from "the replacement
      // destroyed the old resource and then failed" — which is
      // exactly what decides whether a re-run is safe and whether
      // anything downstream is now dangling. `--replace`'s
      // delete-first fallback (`replaceDeleteFirstAndRecreate` (`replacement.ts`))
      // wraps the identical situation, so this is the same
      // contract, not a new one -- but NOT the same sentence, and
      // the difference is deliberate: that sibling still says
      // "already deleted the old resource", which is correct
      // THERE because its delete catch rethrows unconditionally,
      // so the only way past it is a delete that succeeded. This
      // arm has an "already gone" classifier, so it cannot name an
      // actor (see below).
      //
      // Issue #2038: masked at construction, for the same reason as
      // that sibling — the create was handed the RESOLVED
      // `replProps`, so the AWS message this echoes can carry a
      // substituted secret.
      //
      // CHAINED, unlike that sibling: the arm this replaces
      // rethrew `createError` itself, so its `$metadata` /
      // `Code` reached `extractDeploymentEventError` and the
      // persisted `RESOURCE_FAILED` event named the AWS rejection.
      // Wrapping without a `cause` would have silently traded that
      // for the sentence. Safe to chain here: nothing between this
      // throw and the DAG executor re-classifies it — the retry
      // lives INSIDE `engine.withRetry` above, which has already
      // given up — so no substring classifier reads the cause's
      // text (contrast the `Retain` arm below, which needs
      // `markNonRetryable` because its refusal quotes name-cooldown
      // spellings the retry loop WOULD act on).
      //
      // Chained UNMASKED, unlike the rollback executor's twin which
      // wraps its cause in `maskSecretsInError` -- a deliberate
      // asymmetry, recorded because three separate review passes
      // raised it. This throw is inside `updateInPlace`;
      // further up, `provisionResource`'s catch re-wraps it with
      // `maskSecretsInError` over the cause CHAIN, so every link
      // the walk reaches is masked before anything leaves that
      // method (bounded — see `maskSecretsInError`'s own contract
      // for the depth cap and its non-`Error` carve-out; this
      // chain is 3 deep). The rollback executor has no such
      // boundary — `replaySingle`'s catch masks TEXT and swallows —
      // which is why its sites mask per site. The MESSAGE is still
      // masked at construction here, which is what issue #2616
      // requires.
      // go-to-k/cdkd#2676: the message is flattened HERE, so it is masked here
      // with the PRINTING bag too (a secret-derived name, #4741's previous NoEcho
      // value): a later mask sees only the flattened text and misses a needle
      // that holds a newline.
      const shownSecrets = unionOfSecretBags([
        updateSecrets,
        printingSecretsFor(engine.secretsRun, logicalId),
      ]);
      // go-to-k/cdkd#2319: an AWS-authored create failure (a raw SDK or
      // Cloud Control error) names the caller on a denial, so the
      // persisted message carries its class plus the `--verbose`
      // pointer, AWS's text goes to `debug` masked, and the wrap is
      // stamped so a classifier reads that text on the `cause` chain.
      // A provider's own wrap or a transport failure keeps its text.
      const createFailure = describeAwsFailure(createError);
      const createFailureText = (text: string): string =>
        // Each value masked BEFORE `safeMsg` flattens it (go-to-k/cdkd#2676).
        safeMsg`Failed to create ${maskSecretsInText(logicalId, shownSecrets)} after the ` +
        safeMsg`UPDATE-not-supported replacement: the old resource (${maskSecretsInText(currentResource.physicalId, shownSecrets)}) ` +
        // go-to-k/cdkd#2676: the wrapped error's (masked) message is embedded
        // as-is and LAST: it can end in cdkd's own remedy command lines.
        safeMsg`is now gone. Re-run the deploy to create it fresh. Cause: ${asIsMessage(maskSecretsInText(text, shownSecrets))}`;
      if (createFailure.redacted) {
        engine.logger.debug(createFailureText(createFailure.detail));
      }
      const createFailed = new Error(
        createFailureText(createFailure.redacted ? createFailure.summary : createFailure.detail),
        { cause: createError instanceof Error ? createError : undefined }
      );
      throw createFailure.redacted && createError instanceof Error
        ? markRedactedCause(createFailed)
        : createFailed;
    }
    // Same HEURISTIC, and the same bounded blast radius, as
    // the property-driven create-first path's: a false positive
    // only rewrites the error text — nothing destructive follows
    // either branch here, because this arm never deletes.
    if (!isNameCollisionErrorFrom(createError, logicalId)) throw createError;
    // Issue #3808, as on the property-driven path: when the
    // template's explicit name is not the one the retained resource
    // holds, "remove Retain so cdkd deletes the old resource first"
    // would destroy it and still collide.
    const nameHeldElsewhere = replacementRequestsDifferentName({
      oldResourceType: resourceType,
      newResourceType: resourceType,
      desiredProperties: resolvedProps,
      recorded: currentResource.properties,
      observed: currentResource.observedProperties,
      physicalId: currentResource.physicalId,
    });
    if (nameHeldElsewhere !== undefined) {
      throw markNonRetryable(
        new CdkdError(
          safeMsg`${logicalId} (${resourceType}) requires replacement because the ` +
            `provisioning layer cannot update it in place, but the create collided. ` +
            safeMsg`${renderNameHeldElsewhere(nameHeldElsewhere)} — so removing ` +
            `UpdateReplacePolicy: Retain would delete this resource and still ` +
            `collide. Choose a name no other resource holds, or delete the resource ` +
            `holding it if it is yours.`,
          'NAMED_REPLACEMENT_COLLISION',
          createError instanceof Error ? createError : undefined
        )
      );
    }
    const nameOrigin = replacementNameOrigin(logicalId, currentResource.physicalId);
    // Verbatim the property-driven twin's verdict and code: with
    // Retain the old resource keeps the name, so a same-name
    // replacement can never proceed — under ANY flag, since the
    // only escape hatches (`--replace`, `--force-stateful-
    // recreation`) both work by deleting the resource Retain
    // pins in place.
    //
    // `markNonRetryable` for the same reason as the stateful
    // guard's refusal above: a template attribute and a physical
    // name decide it, neither of which a retry can change, and the
    // message interpolates a template-controlled logical id — plus
    // the name-collision text of its own `cause` — into exactly
    // what the SUBSTRING-matching retry classifiers read. Chaining
    // the create rejection is what makes the refusal diagnosable
    // (`extractDeploymentEventError` walks the chain for
    // `awsErrorCode`), and it is safe only BECAUSE of the marker:
    // `isNameCooldownError`'s spellings are retryable, so an
    // unmarked refusal carrying one would burn the full 64s
    // schedule on a path that cannot succeed.
    throw markNonRetryable(
      new CdkdError(
        safeMsg`${logicalId} (${resourceType}) requires replacement because the ` +
          `provisioning layer cannot update it in place — but its physical name ` +
          `is still held by the existing resource AND ` +
          `UpdateReplacePolicy: Retain pins that resource in place. ` +
          safeMsg`${nameOrigin.descriptor}. ${nameOrigin.remedy} — with Retain, the old ` +
          `resource keeps the name, so a same-name replacement can never proceed. ` +
          `Removing UpdateReplacePolicy: Retain lets cdkd delete the old resource ` +
          `first, which destroys it and any data it holds.`,
        'NAMED_REPLACEMENT_COLLISION',
        createError instanceof Error ? createError : undefined
      )
    );
  }
  // go-to-k/cdkd#4444: the old resource was deleted and the new one holds
  // its physical id, so whatever AWS stored inside it went with it. The
  // diff never promoted those children (this was an in-place row); the
  // executor dispatches them as soon as this resource completes
  // (`noChangeChildrenOfRecreatedParents`).
  if (
    !retainOldOnReplace &&
    !createFirst &&
    createResult.physicalId === currentResource.physicalId &&
    !equalIdNamesDifferentResources({
      resourceType,
      physicalId: currentResource.physicalId,
      oldProperties: currentResource.properties,
      newProperties: resolvedProps,
    })
  ) {
    engine.replacementRun.recreatedUnderSameId.add(logicalId);
  }
  if (retainOldOnReplace) {
    // Issue #1238's shape, on this path: a name-idempotent Create
    // API (e.g. SQS `CreateQueue` with an unchanged `QueueName`)
    // returns the EXISTING resource instead of colliding. With the
    // old resource retained, recording that id as the "new" one
    // would re-adopt the very resource Retain just orphaned —
    // without the new properties ever being applied — so fail
    // before any state bookkeeping runs. The property-driven twin
    // makes the same call with the same code.
    if (
      createResult.physicalId === currentResource.physicalId &&
      // Issue #3892: an equal id can still be a NEW table (Glue).
      !equalIdNamesDifferentResources({
        resourceType,
        physicalId: currentResource.physicalId,
        oldProperties: currentResource.properties,
        newProperties: resolvedProps,
      })
    ) {
      const idempotentNameOrigin = replacementNameOrigin(logicalId, currentResource.physicalId);
      // Marked for the same reason as its collision sibling: the
      // verdict is two recorded physical ids plus a template
      // attribute, and the message carries template-controlled
      // text into the substring classifiers. Nothing to chain —
      // the create SUCCEEDED; the failure is what it returned.
      throw markNonRetryable(
        new CdkdError(
          safeMsg`${logicalId} (${resourceType}) requires replacement, but its Create ` +
            `API is name-idempotent: the create returned the existing resource ` +
            safeMsg`(${currentResource.physicalId}) instead of creating a new one, and ` +
            `UpdateReplacePolicy: Retain pins that resource in place, so the new ` +
            safeMsg`properties were not applied. ${idempotentNameOrigin.descriptor}. ` +
            safeMsg`${idempotentNameOrigin.remedy} — with Retain, the old resource keeps ` +
            `the name, so a same-name replacement can never proceed.`,
          'NAMED_REPLACEMENT_IDEMPOTENT_CREATE'
        )
      );
    }
    // Issue #2603: the third and last engine path that leaves the
    // old physical resource alive on a replacement. Recorded AFTER
    // the idempotent-create refusal above, which throws — a
    // resource that fails never reaches `completedOperations`, so
    // the placement is belt-and-braces rather than load-bearing.
    engine.replacementRun.retainedOldOnReplacement.add(logicalId);
    // WARN, not info, and louder than the line the property-driven
    // cleanup prints. The two arms leak identically, but they are
    // reached on completely different terms: the property-driven
    // one requires the user to have changed an immutable property,
    // which `cdkd diff` shows them beforehand, while THIS arm
    // fires on `ccUnsupported` ALONE — no flag, no diff signal,
    // nothing the user did on purpose. A plain `cdkd deploy` that
    // changes an ordinary property on a `Retain`-declaring cluster
    // now creates a SECOND cluster and leaves the first running,
    // where before this PR it hard-refused with
    // STATEFUL_REPLACE_BLOCKED. Same `⚠` shape as the
    // `--recreate-via-*` leak warning in `update-replace.ts`, which announces the
    // strictly LESS surprising version of this outcome.
    engine.logger.warn(
      safeMsg`  ⚠ ${logicalId} has UpdateReplacePolicy: Retain — the old physical ` +
        safeMsg`resource (${displayPhysicalId(currentResource.resourceType, currentResource.physicalId)}) is RETAINED and is no longer ` +
        `tracked by cdkd: it keeps running and incurring cost, and ` +
        `\`cdkd destroy\` will not remove it. Delete it yourself once you no ` +
        `longer need its data.`
    );
    // ...and declare it through the channel that survives the
    // terminal (issue #1819). `updatePartial`'s contract is
    // literally this shape — "updated, but something the update
    // owned survives untracked" — so the row prints
    // `partial (<reason>)` instead of `updated`, the run summary
    // counts it under "of which left an orphaned predecessor" (inside
    // a nested stack: "Left an orphaned predecessor in a nested
    // stack", issue #1989), and
    // a `RESOURCE_SKIPPED` event lands in the durable store
    // carrying the SURVIVOR's physical id and routing layer, which
    // is the one datum a cleanup pass needs.
    //
    // TWO consequences, stated because neither is cosmetic:
    //   - the deploy EXITS 2 (`--allow-unaddressed` opts out), the
    //     same code `cdkd destroy` returns for a skipped delete --
    //     inside a NESTED stack too: the child's `updatePartial`
    //     reaches every ancestor's counter through the nested-stack
    //     context (issue
    //     [#1989](https://github.com/go-to-k/cdkd/issues/1989)).
    //     Correct here and arguably more so: a skipped delete
    //     self-heals on the next run (a nested child's too, issue
    //     [#4453](https://github.com/go-to-k/cdkd/issues/4453)),
    //     while this survivor is untracked, so nothing will ever
    //     retry it.
    //   - it makes this arm LOUDER than the property-driven twin,
    //     which retains with only an info line. Deliberate, on the
    //     trigger asymmetry above, and recorded rather than
    //     silently unified — bringing the twin along is a
    //     behaviour change to a path this PR does not otherwise
    //     touch.
    retainedSurvivorReason =
      `UpdateReplacePolicy: Retain kept the old ${resourceType} ` +
      `(${displayPhysicalId(currentResource.resourceType, currentResource.physicalId)}), now untracked by cdkd`;
  }
  // Annotated rather than inferred: `result` is an evolving `let`,
  // and a conditional spread makes the literal's type a union that
  // TS then checks against the wrong constituent.
  const replacementResult: ResourceUpdateResult = {
    physicalId: createResult.physicalId,
    wasReplaced: true,
    // Spread rather than assigned: under `exactOptionalPropertyTypes`
    // an explicit `undefined` is not assignable to an optional
    // property. Behaviorally identical — the reader below is
    // `result.attributes ?? ...`, which cannot tell absent from
    // undefined.
    ...(createResult.attributes && { attributes: createResult.attributes }),
    // The create's own `NoEcho` declaration, carried for the same
    // reason the property-driven twin passes `createResult` whole:
    // this literal REPLACES the update result, so a declaration
    // dropped here never reaches `registerNoEchoAttributes` below
    // and the replacement's sensitive attributes land UNMASKED in
    // `state.json`. Found by review on this PR; the omission
    // pre-dates it, but `Retain` makes this block the only thing
    // that runs on the path, so leaving it would ship a literal
    // known to be wrong in the hunk being rewritten.
    ...(createResult.noEchoAttributes === true && { noEchoAttributes: true }),
    ...(createResult.noEchoAttributeNames && {
      noEchoAttributeNames: createResult.noEchoAttributeNames,
    }),
    // go-to-k/cdkd#3869: likewise, or the record keeps no field.
    ...(createResult.secretNamedAttributeNames && {
      secretNamedAttributeNames: createResult.secretNamedAttributeNames,
    }),
    // The `'partial'` arm of the outcome union, set only when the
    // retain branch above ran. A ternary rather than a conditional
    // spread: `ResourceUpdateResult` intersects a DISCRIMINATED
    // union, and spreading `outcome`/`reason` conditionally makes
    // the literal's type a union TS then checks against the wrong
    // constituent — the same trap the annotation above exists for.
    ...(retainedSurvivorReason !== undefined
      ? ({ outcome: 'partial', reason: retainedSurvivorReason } as const)
      : ({ outcome: 'updated' } as const)),
  };
  // Carried explicitly: this literal REPLACES the update result, so
  // a narrowing the replacement create announced would be dropped
  // on the floor and the desired bag recorded instead — silently
  // re-introducing the phantom drift (#1591).
  if (createResult.effectiveProperties) {
    replacementResult.effectiveProperties = createResult.effectiveProperties;
  }
  // Issue #2608: same decision, same statement — the two must not
  // be separable by a later edit.
  return {
    result: replacementResult,
    provisionedBy: replDecision.provisionedBy,
    captureProvider: replProvider,
  };
}
