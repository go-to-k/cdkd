import { type DeployEngine, InterruptedError } from '../deploy-engine.js';
import type { ProvisionCounts, ResourceOutcomeSignal } from '../deploy-engine.js';
import { ccBrokenReason } from '../../provisioning/provider-registry.js';
import { applyDefaultNameForFallback } from '../../provisioning/resource-name.js';
import {
  isStatefulRecreateTargetForReplace,
  renderStatefulReason,
} from '../../provisioning/stateful-types.js';
import type { CloudFormationTemplate, ResourceDeleteResult } from '../../types/resource.js';
import { type ResourceChange, type ResourceState } from '../../types/state.js';
import { bold, gray, green, yellow } from '../../utils/colors.js';
import { displayAwsMessage, displaySafe, safeMsg } from '../../utils/display-safe.js';
import { CdkdError } from '../../utils/error-handler.js';
import { deleteSkipReason, deleteSkippedMessage } from '../delete-outcome.js';
import {
  renderNameHeldElsewhere,
  replacementOldHoldsSentName,
  replacementRequestsDifferentName,
} from '../replacement-name-holder.js';
import { withCurrentResourceSecrets } from '../resource-secrets-scope.js';
import { withRetry } from '../retry.js';
import {
  isNameCollisionErrorFrom,
  isRecreateRetryableError,
  markNonRetryable,
} from '../retryable-errors.js';
import { createSecretMasker, maskSecretsInText } from '../secret-redaction.js';
import { equalIdNamesSameResource } from '../type-change-guard.js';
import type { LiveRenderer } from '../../utils/live-renderer.js';
import type { RecordedSecretValues } from '../secret-redaction.js';

declare module '../deploy-engine.js' {
  interface DeployEngine {
    /** @internal */
    updateByReplacement: OmitThisParameter<typeof updateByReplacement>;
  }
}

/** A branch of `provisionUpdate` (`update.ts`), split out of it (#4350). */
export async function updateByReplacement(
  this: DeployEngine,
  {
    change,
    counts,
    currentProps,
    currentResource,
    dependencies,
    logicalId,
    oldResourceType,
    progress,
    propertyDrivenReplacement,
    recreateFlagged,
    recreateViaCcApi,
    recreateViaSdkProvider,
    renderer,
    resolvedProps,
    resourceType,
    stackName,
    stateResources,
    template,
    typeChanged,
    updateReplacePolicy,
    updateSecrets,
  }: {
    change: ResourceChange;
    counts: ProvisionCounts | undefined;
    currentProps: Record<string, unknown>;
    currentResource: ResourceState;
    dependencies: string[] | undefined;
    logicalId: string;
    oldResourceType: string;
    progress: { current: number; total: number } | undefined;
    propertyDrivenReplacement: boolean | undefined;
    recreateFlagged: boolean;
    recreateViaCcApi: boolean;
    recreateViaSdkProvider: boolean;
    renderer: LiveRenderer;
    resolvedProps: Record<string, unknown>;
    resourceType: string;
    stackName: string;
    stateResources: Record<string, ResourceState>;
    template: CloudFormationTemplate | undefined;
    typeChanged: boolean;
    updateReplacePolicy: 'Delete' | 'Retain' | 'Snapshot' | undefined;
    updateSecrets: RecordedSecretValues;
  }
): Promise<ResourceOutcomeSignal | void> {
  // Stateful guard for PROPERTY-DRIVEN replacement (an immutable /
  // createOnly property changed in the template). DELETE+CREATEing a
  // stateful type (RDS / EFS / Secret / SSM Parameter / Kinesis / etc.)
  // loses all of its data, so — mirroring the `--replace` and
  // `--recreate-via-*` paths — require `--force-stateful-recreation` to
  // confirm the data loss. Only the property-driven case is gated here:
  // the `--recreate-via-*` flags run their own pre-flight stateful probe
  // (`probeStatefulRecreateTargetsAsync`) before the deploy, so a
  // recreate-flagged target has already been validated. Uses the
  // conservative mid-deploy variant (treats a non-probed S3 bucket, and
  // a log group whose recorded retention does not already settle it, as
  // stateful) since the diff loop has no chance to run the async
  // emptiness probes. A `Retain` UpdateReplacePolicy is exempt: the
  // old resource + its data survive the replacement (orphaned, not
  // deleted), so there is no data loss to confirm. `Snapshot` is NOT
  // exempt: cdkd DOES take a final snapshot on the replacement delete
  // (issue #1354), but a snapshot is a point-in-time copy, not a
  // surviving resource — the live resource is still destroyed and
  // recreated, so the consent flag is still the right gate.
  if (propertyDrivenReplacement && !recreateFlagged && updateReplacePolicy !== 'Retain') {
    // Three arguments, not two (issue [#2521]): the guard's log-group arm
    // reads a positive `RetentionInDays` out of EITHER recorded bag, so
    // the observed one -- where an out-of-band `put-retention-policy`, or
    // an import whose template never declared the property, puts it -- has
    // to travel with the recorded one. `currentProps` stays the recorded
    // bag exactly as before; `currentResource` is this UPDATE branch's
    // state record, the only place the observed bag exists.
    // The OLD type (issue #2668): the guard asks what the resource being
    // destroyed HOLDS, and that resource is the state record's. Keyed
    // on the template's type, a stateful-to-non-stateful Type change
    // escaped the guard entirely, and the reverse refused a deploy that
    // destroys nothing stateful.
    const statefulReason = isStatefulRecreateTargetForReplace(
      oldResourceType,
      currentProps,
      currentResource.observedProperties
    );
    if (statefulReason && this.options.forceStatefulRecreation !== true) {
      const immutableProps =
        change.propertyChanges
          ?.filter((pc) => pc.requiresReplacement)
          .map((pc) => pc.path)
          .join(', ') || 'Type';
      // `markNonRetryable`: the verdict is computed from a CLI flag and
      // a state-recorded property bag, neither of which a retry can
      // change — and the message interpolates a template-controlled
      // logical id into text the SUBSTRING-matching retry classifiers
      // read. The twin marker sits on the update-failure fallback's
      // guard below; both are declarations, not fixes for an observed
      // retry (the throws are outside `withRetry` today, but a nested
      // stack's child engine re-throws into the parent's).
      throw markNonRetryable(
        new CdkdError(
          `${logicalId} (${oldResourceType}) requires replacement (immutable property changed: ` +
            `${immutableProps}${typeChanged ? `, to ${resourceType}` : ''}) but it is a stateful resource — ` +
            `${renderStatefulReason(statefulReason)}. Re-run with ` +
            `--force-stateful-recreation to confirm the data loss, or change the resource ` +
            `definition to avoid the immutable-property change.`,
          'STATEFUL_REPLACE_BLOCKED'
        )
      );
    }
  }

  // Issue #3899: `--recreate-via-cc-api` deletes the old resource FIRST
  // and then creates through Cloud Control, pinned by `forceCcApi`
  // below, which the registry honours before it consults whether Cloud
  // Control can create the type at all. `validateRecreateTargets`
  // refuses such a type pre-flight (#3887); this is the same verdict
  // at the delete, so a caller that skips the validator cannot delete
  // a resource that is then never recreated.
  if (recreateViaCcApi) {
    const noCcRoute = this.providerRegistry.ccRouteUnavailableReason(resourceType);
    if (noCcRoute !== undefined) {
      throw markNonRetryable(
        new CdkdError(
          `--recreate-via-cc-api cannot recreate ${logicalId} (${resourceType}): Cloud ` +
            `Control API cannot create this type (${noCcRoute}). Nothing was deleted. ` +
            `Drop ${logicalId} from --recreate-via-cc-api.`,
          'RECREATE_TARGETS_INVALID'
        )
      );
    }
    // Issue #4119: routing ignores the flag for this type, so the
    // recreate would delete and recreate it on the SDK route.
    const ccBroken = ccBrokenReason(resourceType);
    if (ccBroken !== undefined) {
      throw markNonRetryable(
        new CdkdError(
          `--recreate-via-cc-api cannot move ${logicalId} (${resourceType}) to Cloud ` +
            `Control: ${ccBroken}, so cdkd keeps it on its SDK provider. Nothing was ` +
            `deleted. Drop ${logicalId} from --recreate-via-cc-api.`,
          'RECREATE_TARGETS_INVALID'
        )
      );
    }
  }

  // Resource replacement: DELETE old → CREATE new
  let replacementReason: string;
  if (recreateViaCcApi) {
    replacementReason = '--recreate-via-cc-api flag (mid-life SDK→CC migration)';
  } else if (recreateViaSdkProvider) {
    // #651 reverse direction.
    replacementReason = '--recreate-via-sdk-provider flag (mid-life CC→SDK migration)';
  } else {
    replacementReason = `immutable properties changed: ${change.propertyChanges
      ?.filter((pc) => pc.requiresReplacement)
      .map((pc) => pc.path)
      .join(', ')}`;
  }
  this.logger.info(
    `Replacing ${logicalId} (${typeChanged ? `${oldResourceType} -> ${resourceType}` : resourceType}) - ${replacementReason}`
  );

  // The new (replacement) resource gets a fresh routing decision —
  // a property the SDK provider used to silent-drop may now be
  // wired, or vice versa. The OLD resource's delete uses the
  // state-recorded layer (sticky) so a CC-managed legacy is
  // deleted via CC even if the template now would land on SDK.
  //
  // When the recreate is driven by `--recreate-via-cc-api`, pass
  // an explicit `provisionedBy: 'cc-api'` hint so the routing
  // decision tree's rule 2 ("sticky CC") returns CC even when
  // the template itself has no silent-drop property. The new
  // physical id then stamps `provisionedBy: 'cc-api'` on state
  // and all subsequent ops stick to CC.
  //
  // #651: `--recreate-via-sdk-provider` is the reverse — force
  // `provisionedBy: 'sdk'` so the routing decision returns the
  // SDK provider even though the current state record sticks at
  // 'cc-api'. The new physical id stamps `provisionedBy: 'sdk'`.
  const recreateDirectionHint: 'sdk' | 'cc-api' | undefined = recreateViaCcApi
    ? 'cc-api'
    : recreateViaSdkProvider
      ? 'sdk'
      : undefined;
  const replaceDecision = this.providerRegistry.getProviderFor({
    resourceType,
    properties: resolvedProps,
    ...(recreateDirectionHint && { provisionedBy: recreateDirectionHint }),
    // Issue #3713: the baseline an unrecognized property is compared
    // against. A replacement mints a NEW physical resource, but one
    // replacing a resource that deployed with the key unchanged keeps
    // its route — on presence, a typo CloudFormation would reject but
    // the SDK route tolerated would fail the replacement instead.
    // Inert for the sticky-escape: without a `'cc-api'` record hint
    // rule 2 is not consulted, and with one `forceCcApi` pins it.
    previousProperties: currentResource.properties,
    // Issue #2719: `--recreate-via-cc-api` passes `provisionedBy:
    // 'cc-api'` as a HINT, and for a type with an `'sdk-coverage'`
    // exemption the sticky-escape would read that hint and divert the
    // resource straight back to the SDK provider -- turning the user's
    // explicit "recreate this through Cloud Control" into a no-op.
    // Pinning here is what keeps the flag meaning what it says.
    ...(recreateViaCcApi && { forceCcApi: true }),
  });
  const replaceProvider = replaceDecision.provider;
  const replaceProps =
    replaceDecision.provisionedBy === 'cc-api'
      ? this.preparePropertiesForCcApi(resourceType, resolvedProps, logicalId)
      : resolvedProps;

  // Order: property-driven replacement (immutable prop changed)
  // creates the NEW resource first so the old survives a CREATE
  // failure — matches CFn's safe-replacement order. The
  // `--recreate-via-cc-api` flag (#615) instead destroys the OLD
  // resource first: the user-named recreate target almost always
  // has a user-supplied physical name (e.g. `functionName: 'foo'`),
  // and a create-first attempt with the same name collides with
  // the existing resource. Brief deletion-window downtime is the
  // explicit cost of opting into recreate; the design doc § 2
  // calls this out as "Old physical resource: destroyed via SDK
  // Provider ... New physical resource: created via CC API",
  // i.e. destroy-then-create — except when the template also renames
  // the target (go-to-k/cdkd#3931): the old resource then does not
  // hold the new name, so `createFirstThenDeleteOld` creates first.
  // (`updateReplacePolicy` is read once in `update.ts`, before the stateful
  // guard, and reused here.)
  //
  // Issue #2668: BOTH inputs come from the state record. The layer
  // always did; the TYPE used to be the template's, so on a Type change
  // the old resource's delete was dispatched at the NEW type's provider
  // — a loud API error, a silent leak, or (where the two types'
  // physical-id namespaces overlap) the deletion of an unrelated live
  // resource of the new type.
  const oldDeleteProvider = this.providerRegistry.getProviderFor({
    resourceType: oldResourceType,
    provisionedBy: currentResource.provisionedBy,
  }).provider;

  // Whether an EQUAL physical id on the two halves names the SAME
  // resource — what the two name-idempotent guards below assume. True
  // within one type; across a Type change only for the custom-resource
  // family (`equalIdNamesSameResource` has the reasoning).
  const equalIdIsSameResource = equalIdNamesSameResource({
    oldType: oldResourceType,
    newType: resourceType,
    createLayer: replaceDecision.provisionedBy,
    // Issue #3892: a Glue table's id is placed by DatabaseName, so an
    // equal id can be a genuinely new table in another database.
    oldProperties: currentResource.properties,
    newProperties: resolvedProps,
    physicalId: currentResource.physicalId,
  });

  // go-to-k/cdkd#3937 / #3931: a name KNOWN to move off the one the old
  // resource holds, probed where the create would adopt a taken one.
  // Before any arm below creates or deletes anything.
  const nameChange = await this.checkedReplacementNameChange({
    logicalId,
    resourceType,
    oldResourceType,
    stackName,
    currentResource,
    desiredProperties: resolvedProps,
    createProvider: replaceProvider,
    createdVia: replaceDecision.provisionedBy,
    createProps: replaceProps,
    secrets: updateSecrets,
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- shape varies by ResourceProvider impl
  let createResult: any;
  if (recreateFlagged && nameChange !== undefined) {
    // go-to-k/cdkd#3931: the destroy-then-create below exists to free
    // a name the old resource holds; this one moves to another, so the
    // old resource is deleted only once its replacement exists — and,
    // under Retain, a collision is refused at once rather than retried
    // as a late name release.
    const retainOld = updateReplacePolicy === 'Retain';
    const recreateFlagName = recreateViaCcApi
      ? '--recreate-via-cc-api'
      : '--recreate-via-sdk-provider';
    if (retainOld) {
      // Issue #2603, as on the destroy-then-create arm.
      this.retainedOldOnReplacement.add(logicalId);
      this.logger.warn(
        safeMsg`  ⚠ ${logicalId} has UpdateReplacePolicy: Retain — ${recreateFlagName} leaves the old physical resource (${currentResource.physicalId}) in place, no longer tracked by cdkd.`
      );
    }
    createResult = await this.createFirstThenDeleteOld({
      retainOld,
      logicalId,
      resourceType,
      oldResourceType,
      currentResource,
      createProvider: replaceProvider,
      createProps: replaceProps,
      deleteProvider: oldDeleteProvider,
      deleteProperties: currentResource.properties,
      secrets: updateSecrets,
      change: nameChange,
      equalIdIsSameResource,
      snapshotPolicy: updateReplacePolicy,
      deletePolicy: updateReplacePolicy,
      trigger: recreateFlagName,
    });
  } else if (recreateFlagged) {
    // Destroy-then-create path. Same `UpdateReplacePolicy:
    // Retain` semantics — retained old resources leak (named the
    // same as the new); document via warning. CFn would refuse a
    // Retain + replace combo at template-author time; cdkd warns
    // and proceeds since the user explicitly opted in.
    const recreateFlagName = recreateViaCcApi
      ? '--recreate-via-cc-api'
      : '--recreate-via-sdk-provider';
    if (updateReplacePolicy === 'Retain') {
      // Issue #2603: the delete below is SKIPPED, so record that this
      // deploy left the old resource alive — the rollback classifier
      // reads this rather than re-deriving the verdict from the
      // previous state record's policy.
      this.retainedOldOnReplacement.add(logicalId);
      this.logger.warn(
        `  ⚠ ${logicalId} has UpdateReplacePolicy: Retain — ${recreateFlagName} will ` +
          `leak the old physical resource (${currentResource.physicalId}). The new ` +
          `resource shares the same name where applicable; if the type ` +
          `has user-supplied names (e.g. functionName, bucketName), the create will ` +
          `deterministically collide with the retained orphan.`
      );
    } else {
      this.logger.info(
        `  Destroying old ${logicalId} (${currentResource.physicalId}) before recreate...`
      );
      // `UpdateReplacePolicy: Snapshot` (issue #1354): snapshot the
      // old resource before the recreate's delete. OUTSIDE the try
      // so a snapshot failure/refusal keeps its typed
      // FINAL_SNAPSHOT_* error instead of being rewrapped as a
      // delete failure that never happened.
      const recreateFinalSnapshotId = await this.prepareFinalSnapshotForDelete(
        logicalId,
        oldResourceType,
        currentResource,
        updateReplacePolicy
      );
      let recreateDeleteResult: void | ResourceDeleteResult;
      try {
        recreateDeleteResult = await oldDeleteProvider.delete(
          logicalId,
          currentResource.physicalId,
          oldResourceType,
          currentResource.properties,
          {
            expectedRegion: this.stackRegion,
            forceDataDelete: this.options.forceStatefulRecreation === true,
            ...(recreateFinalSnapshotId !== undefined && {
              finalSnapshotIdentifier: recreateFinalSnapshotId,
            }),
            ...this.replacementDeleteContext(updateReplacePolicy),
            recordedAttributes: currentResource.attributes,
          }
        );
      } catch (deleteError) {
        // Re-throw so the deploy engine's existing rollback path
        // sees the failure — recreate's destroy is load-bearing
        // (without it the subsequent create collides with the
        // pre-existing resource), so a swallowed failure would
        // produce a confusing AlreadyExists later.
        throw new Error(
          `Failed to destroy old resource ${logicalId} (${currentResource.physicalId}) ` +
            `during ${recreateFlagName}: ` +
            `${deleteError instanceof Error ? deleteError.message : String(deleteError)}`
        );
      }
      // Issue #1762: same reasoning as the delete-first fallback —
      // this destroy is load-bearing, so a skip has to fail the
      // resource rather than let the create run beside a live old one.
      const recreateSkipReason = deleteSkipReason(recreateDeleteResult);
      if (recreateSkipReason !== undefined) {
        throw new Error(
          deleteSkippedMessage(
            logicalId,
            currentResource.physicalId,
            recreateSkipReason,
            `during ${recreateFlagName}`
          )
        );
      }
      this.logger.info(`  ${green('✓')} Old resource deleted`);
    }

    this.logger.info(`  Creating new ${logicalId}...`);
    // Delete-then-create just released the old resource's name, so
    // the re-create can hit a late name release ("already exists"
    // from an async delete) or the SQS 60s same-name cooldown
    // (QueueDeletedRecently, issue #1214). The inner retry matches
    // the cooldown — and since issue #2116 it rides the name-cooldown
    // grid (2s/4s/8s then 10s, ≈64s), not the generic ~47s one it used
    // to inherit, so the inner loop alone now covers the 60s window
    // rather than typically ending inside it.
    //
    // This outer loop is kept anyway, and the reason has MOVED rather
    // than disappeared: it is no longer "the inner budget is too
    // short" but that the outer filter is `isRecreateRetryableError`,
    // which also covers the late name RELEASE ("already exists" from
    // an async delete) that the inner default classifier deliberately
    // rejects. Note the two now COMPOUND — the outer loop re-enters an
    // inner loop that is itself 64s — measured at 640s total sleep on
    // a cooldown, inside the 30-minute per-resource deadline. See
    // `NAME_COOLDOWN_INITIAL_DELAY_MS` in retry.ts.
    createResult = await withRetry(
      () =>
        this.withRetry(
          () =>
            withCurrentResourceSecrets(updateSecrets, () =>
              replaceProvider.create(logicalId, resourceType, replaceProps, {
                maskSecrets: createSecretMasker(updateSecrets),
              })
            ),
          logicalId,
          undefined,
          undefined,
          replaceProvider
        ),
      logicalId,
      {
        maxRetries: 8,
        initialDelayMs: 2_000,
        maxDelayMs: 10_000,
        // Issue #2038, same reason as the --replace fallback above --
        // and bound to `updateSecrets`, the bag this UPDATE resolved
        // with and the very one the `createSecretMasker` one statement
        // up is built from, rather than looked up by logical id.
        logger: this.maskingRetryLoggerFor(updateSecrets),
        isInterrupted: () => this.interrupted,
        onInterrupted: () => new InterruptedError(this.interruptCause ?? 'user'),
        isRetryable: isRecreateRetryableError,
      }
    );

    // Issue #1238: under `UpdateReplacePolicy: Retain` the old
    // resource was NOT destroyed above, so a name-idempotent Create
    // API (e.g. SQS CreateQueue with an unchanged QueueName) can
    // silently return the EXISTING resource instead of colliding.
    // Recording that id as the "new" resource would re-adopt the
    // resource the Retain policy just orphaned — without the new
    // properties ever being applied. Fail before the state
    // bookkeeping runs; the old resource and its state record stay
    // intact.
    //
    // `equalIdIsSameResource` (issue #2668): across a Type change an
    // equal id is a coincidence of two namespaces, and the create was a
    // genuine one — the custom-resource family excepted.
    if (
      equalIdIsSameResource &&
      updateReplacePolicy === 'Retain' &&
      createResult.physicalId === currentResource.physicalId
    ) {
      throw new CdkdError(
        `${logicalId} (${resourceType}) recreate returned the existing resource ` +
          `(${currentResource.physicalId}) instead of creating a new one — its Create ` +
          `API is name-idempotent — and UpdateReplacePolicy: Retain means the old ` +
          `resource was never destroyed, so the new properties were not applied. ` +
          `Rename the resource in your CDK code (or remove the explicit physical ` +
          `name) so the recreate can produce a genuinely new resource.`,
        'NAMED_REPLACEMENT_IDEMPOTENT_CREATE'
      );
    }
  } else {
    // Property-driven replacement: create-then-destroy (CFn
    // safe-replacement order — keeps the old alive if CREATE
    // fails so the deploy can roll back to it cleanly).
    this.logger.info(`  Creating new ${logicalId}...`);
    let deletedOldFirst = false;
    try {
      createResult = await this.withRetry(
        () =>
          withCurrentResourceSecrets(updateSecrets, () =>
            replaceProvider.create(logicalId, resourceType, replaceProps, {
              maskSecrets: createSecretMasker(updateSecrets),
            })
          ),
        logicalId,
        undefined,
        undefined,
        replaceProvider
      );
    } catch (createError) {
      // The AWS text every refusal below quotes: masked FIRST (the
      // create was handed resolved values), then rendered display-safe
      // and bounded, since an AWS message can echo a template value.
      const createMsg = displayAwsMessage(
        maskSecretsInText(
          createError instanceof Error ? createError.message : String(createError),
          updateSecrets
        )
      );
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
      // Retain pins the old resource (and its name) in place, so a
      // same-name replacement can never proceed under any flag.
      // (Snapshot is not special-cased HERE — the old resource is
      // still deleted so the name frees up; the delete-first helper
      // takes its final snapshot first, issue #1354.)
      const nameOrigin = this.replacementNameOrigin(logicalId, currentResource.physicalId);
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
            `${logicalId} (${resourceType}) requires replacement, but the create-first ` +
              `attempt collided: ${createMsg}. ${renderNameHeldElsewhere(nameHeldElsewhere)}` +
              (this.options.replace === true
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
        generated: applyDefaultNameForFallback(logicalId, resourceType, resolvedProps),
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
          this.options.replace === true
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
          `${logicalId} (${resourceType}) requires replacement, but its physical name ` +
            `is still held by the existing resource AND UpdateReplacePolicy: Retain ` +
            `pins that resource in place. ${nameOrigin.descriptor}. ` +
            `${nameOrigin.remedy} — with Retain, the old resource keeps the name, so a ` +
            `same-name replacement can never proceed.`,
          'NAMED_REPLACEMENT_COLLISION'
        );
      }
      if (this.options.replace !== true) {
        throw new CdkdError(
          `${logicalId} (${resourceType}) requires replacement, but the create-first ` +
            `attempt collided with the existing resource: ${createMsg}. ` +
            `${nameOrigin.descriptor}, so the CloudFormation-style safe replacement ` +
            `order (create the new resource before deleting the old) cannot reuse the ` +
            `occupied name — CloudFormation refuses this shape with "cannot update a ` +
            `stack when a custom-named resource requires replacing". ` +
            `${nameOrigin.remedy}, or re-run with \`cdkd deploy --replace\` to delete ` +
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
      this.logger.info(
        `  Create-first collided with the existing resource's name and --replace is ` +
          `set — deleting old ${logicalId} (${currentResource.physicalId}) first...`
      );
      deletedOldFirst = true;
      createResult = await this.replaceDeleteFirstAndRecreate(
        logicalId,
        resourceType,
        oldResourceType,
        currentResource,
        oldDeleteProvider,
        replaceProvider,
        replaceProps,
        updateSecrets,
        updateReplacePolicy
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
      const idempotentNameOrigin = this.replacementNameOrigin(
        logicalId,
        currentResource.physicalId
      );
      if (updateReplacePolicy === 'Retain') {
        throw new CdkdError(
          `${logicalId} (${resourceType}) requires replacement, but its Create API is ` +
            `name-idempotent: the create-first attempt returned the existing resource ` +
            `(${currentResource.physicalId}) instead of creating a new one, and ` +
            `UpdateReplacePolicy: Retain pins that resource in place. ` +
            `${idempotentNameOrigin.descriptor}. ${idempotentNameOrigin.remedy} — with ` +
            `Retain, the old resource keeps the name, so a same-name replacement can ` +
            `never proceed.`,
          'NAMED_REPLACEMENT_IDEMPOTENT_CREATE'
        );
      }
      if (this.options.replace !== true) {
        throw new CdkdError(
          `${logicalId} (${resourceType}) requires replacement, but its Create API is ` +
            `name-idempotent: the create-first attempt returned the EXISTING resource ` +
            `(${currentResource.physicalId}) instead of creating a new one, so deleting ` +
            `the "old" resource would silently destroy the resource the deploy just ` +
            `reported as created. ${idempotentNameOrigin.descriptor}; ` +
            `${idempotentNameOrigin.remedy}, or re-run with ` +
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
      this.logger.info(
        `  Create-first returned the existing resource (name-idempotent Create API) ` +
          `and --replace is set — deleting old ${logicalId} ` +
          `(${currentResource.physicalId}) first...`
      );
      deletedOldFirst = true;
      createResult = await this.replaceDeleteFirstAndRecreate(
        logicalId,
        resourceType,
        oldResourceType,
        currentResource,
        oldDeleteProvider,
        replaceProvider,
        replaceProps,
        updateSecrets,
        updateReplacePolicy
      );
    }

    if (deletedOldFirst) {
      // Old resource is already gone (delete-first fallback above).
    } else if (updateReplacePolicy === 'Retain') {
      // Issue #2603: same record as the `--recreate-via-*` arm above —
      // the cleanup delete is skipped, so the rollback must re-adopt
      // rather than re-create.
      this.retainedOldOnReplacement.add(logicalId);
      this.logger.info(
        `  Retaining old ${logicalId} (${currentResource.physicalId}) - UpdateReplacePolicy: Retain`
      );
    } else {
      this.logger.info(`  Deleting old ${logicalId} (${currentResource.physicalId})...`);
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
        cleanupFinalSnapshotId = await this.prepareFinalSnapshotForDelete(
          logicalId,
          oldResourceType,
          currentResource,
          updateReplacePolicy
        );
      } catch (snapshotError) {
        if (
          snapshotError instanceof CdkdError &&
          snapshotError.code === 'FINAL_SNAPSHOT_UNSUPPORTED'
        ) {
          throw snapshotError;
        }
        snapshotBlockedDelete = true;
        this.logger.warn(
          `  ⚠ Final snapshot for old ${logicalId} (${currentResource.physicalId}) ` +
            `failed: ${snapshotError instanceof Error ? snapshotError.message : String(snapshotError)}. ` +
            `The old resource was NOT deleted (UpdateReplacePolicy: Snapshot) — delete it ` +
            `manually once you have a snapshot; it is no longer tracked in state.`
        );
      }
      if (!snapshotBlockedDelete) {
        await this.deleteReplacedAfterCreate(
          logicalId,
          oldResourceType,
          currentResource,
          oldDeleteProvider,
          currentResource.properties,
          cleanupFinalSnapshotId,
          updateReplacePolicy,
          updateSecrets
        );
      }
    }
  }

  // Issue #2274: the replacement path re-CREATES, so the fresh create
  // result carries its own `NoEcho` declaration and must register it —
  // the create arm's registration is in a different `case` and does not
  // run here.
  this.registerNoEchoAttributes(logicalId, createResult, updateSecrets, resolvedProps);

  stateResources[logicalId] = {
    physicalId: createResult.physicalId,
    resourceType,
    properties: this.propertiesToRecord(
      resolvedProps,
      createResult,
      resourceType,
      replaceDecision.provisionedBy
    ),
    ...(createResult.attributes && { attributes: createResult.attributes }),
    ...(dependencies && dependencies.length > 0 && { dependencies }),
    ...this.extractTemplateAttributes(template, logicalId),
    provisionedBy: replaceDecision.provisionedBy,
  };
  this.recordInlinePolicyWrite(logicalId, 'create');

  this.kickOffObservedCapture(
    replaceProvider,
    logicalId,
    createResult.physicalId,
    resourceType,
    resolvedProps,
    { afterOwnWrite: true },
    updateSecrets
  );

  if (counts) counts.updated++;
  if (progress) progress.current++;
  const replacePrefix = progress ? `[${progress.current}/${progress.total}] ` : '  ';
  renderer.removeTask(logicalId);
  this.logger.info(
    `${replacePrefix}${yellow('↻')} ${bold(logicalId)} ${gray(`(${resourceType})`)} ${yellow('replaced')}`
  );
}
