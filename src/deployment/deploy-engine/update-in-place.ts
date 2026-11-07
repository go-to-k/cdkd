import { displayPhysicalId } from '../../provisioning/secret-physical-id.js';
import { clearCreatedReport } from '../../provisioning/created-resource-sink.js';
import { buildObservedCaptureSiblings } from './observed-capture.js';
import { noteSecretNamedRecord, printingSecretsFor, registerNoEchoAttributes } from './masking.js';
import { type DeployEngine } from '../deploy-engine.js';
import type { ProvisionCounts, ResourceOutcomeSignal } from '../deploy-engine.js';
import {
  getCurrentStackInstanceId,
  withNameGeneration,
  withoutGeneratedFallbackName,
} from '../../provisioning/resource-name.js';
import {
  nameGenerationCarriedFrom,
  nameGenerationField,
  nextNameGeneration,
} from '../../state/name-generation.js';
import { isPinnedToCcApi, preparePropertiesForCcApi } from './routing.js';
import { extractTemplateAttributes, propertiesToRecord } from './record-shape.js';
import {
  unsettledItemsField,
  unsettledItemsOf,
  unsettledPropertiesOf,
} from '../../state/unsettled-properties.js';
import {
  addedByFailedUpdateWarning,
  settleUnsettledPrevious,
  splitUnhandledRemovals,
  unsettledAfterUpdate,
} from '../unsettled-convergence.js';
import { withUnchangedSecretPrincipalLists } from '../../provisioning/iam-policy-targets.js';
import { withRecreatedAttachmentsDropped } from '../child-of-recreated-parent.js';
import { isInterruptedWaitError } from '../../provisioning/interrupt-watch.js';
import {
  STICKY_CC_MIGRATION_EXEMPT,
  sdkAddressedPhysicalId,
} from '../../provisioning/provider-registry.js';
import { ccAutoRouteUpdateFailureRemedy } from '../../provisioning/cc-autoroute-update-remedy.js';
import {
  prepareRemovalForUpdate,
  removalWarning,
  withoutInjectedRemovals,
} from '../../provisioning/update-removal.js';
import { isWaitAbandonedError } from '../../provisioning/wait-abandoned.js';
import type { CloudFormationTemplate } from '../../types/resource.js';
import { type ResourceState, hasUnverifiableParameterRefusal } from '../../types/state.js';
import { acceptedCreateOnlyDropsField, secretNamedAttributesField } from './record-shape.js';
import { cachedCreateOnlyPropertyPaths } from '../../provisioning/create-only-properties.js';
import { hasPassProvenance } from '../secret-redaction/reference-provenance.js';
import { referenceProvenanceOf } from '../reference-provenance-record.js';
import { describeAwsFailure } from '../../utils/aws-failure-text.js';
import { asIsMessage, displaySafe, safeMsg } from '../../utils/display-safe.js';
import { CdkdError, ResourceUpdateNotSupportedError } from '../../utils/error-handler.js';
import { formatResourceLine } from '../../utils/resource-line.js';
import { withCurrentResourceSecrets } from '../resource-secrets-scope.js';
import {
  isUpdateUnsupportedError,
  markNonRetryable,
  markRedactedCause,
} from '../retryable-errors.js';
import { createSecretMasker, maskSecretsInText, unionOfSecretBags } from '../secret-redaction.js';
import { updatePartialMessage, updatePartialReason } from '../update-outcome.js';
import type { LiveRenderer } from '../../utils/live-renderer.js';
import type { RecordedSecretValues } from '../secret-redaction.js';
import { buildResolverContext } from './resolver-context.js';
import { keyOrderFreeJson } from '../deploy-value-equality.js';
import { replaceFallbackFor } from './update-in-place/replace-fallback.js';

/** A branch of `provisionUpdate` (`update.ts`), split out of it (#4350). */
export async function updateInPlace(
  engine: DeployEngine,
  {
    changedProperties,
    conditions,
    counts,
    currentProps,
    currentPropsAsWritten,
    currentResource: recordedResource,
    dependencies,
    desiredForSkipCheckAsWritten,
    logicalId,
    noEchoHeldPaths,
    parameterValues,
    progress,
    renderer,
    resolvedProps,
    resourceType,
    stackName,
    stateResources,
    template,
    updateReplacePolicy,
    updateSecrets,
    reattach,
  }: {
    /**
     * go-to-k/cdkd#5112: the top-level keys `update.ts` found changed,
     * template to template (`UpdateContext.changedProperties`).
     */
    changedProperties: ReadonlySet<string>;
    conditions: Record<string, boolean> | undefined;
    counts: ProvisionCounts | undefined;
    currentProps: Record<string, unknown>;
    currentPropsAsWritten: Record<string, unknown>;
    currentResource: ResourceState;
    dependencies: string[] | undefined;
    desiredForSkipCheckAsWritten: Record<string, unknown>;
    logicalId: string;
    noEchoHeldPaths: Set<string>;
    parameterValues: Record<string, unknown> | undefined;
    progress: { current: number; total: number } | undefined;
    renderer: LiveRenderer;
    resolvedProps: Record<string, unknown>;
    resourceType: string;
    stackName: string;
    stateResources: Record<string, ResourceState>;
    template: CloudFormationTemplate | undefined;
    updateReplacePolicy: 'Delete' | 'Retain' | 'Snapshot' | undefined;
    updateSecrets: RecordedSecretValues;
    /** go-to-k/cdkd#4461: a `reattach` child of a parent re-created under the same id. */
    reattach?: boolean;
  }
): Promise<ResourceOutcomeSignal | void> {
  // Normal update (in-place).
  //
  // For an existing resource, the layer is sticky: if it was first
  // created via Cloud Control (because of SDK-unwired properties at
  // CREATE time), the update stays on Cloud Control. If it was
  // SDK-managed and the user has since added an SDK-unwired property,
  // we re-evaluate via `getProviderFor` — which will auto-route
  // through Cloud Control as long as the user hasn't overridden
  // via `--allow-unsupported-properties`. Once a resource flips
  // to CC mid-life, it stays there (the state record's
  // `provisionedBy: 'cc-api'` written below sticks).
  engine.logger.debug(safeMsg`Updating ${logicalId} (${resourceType})`);
  const updateDecision = engine.providerRegistry.getProviderFor({
    resourceType,
    properties: resolvedProps,
    provisionedBy: recordedResource.provisionedBy,
    // Issue #2719: the RECORD's bag, not the diff's current side. It is
    // the resolved desired bag of the last successful deploy, so a
    // property applied under Cloud Control and since deleted from the
    // template is still visible here -- which is the one case a
    // desired-only flip condition gets wrong (see
    // `GetProviderForInput.previousProperties`).
    previousProperties: recordedResource.properties,
    ...(isPinnedToCcApi(engine.options, stackName, logicalId) && { forceCcApi: true }),
  });
  // go-to-k/cdkd#5654: the record as THIS route addresses it. A cc-api record
  // returning to its SDK provider carries the Cloud Control id, which for a
  // type with a declared normalizer is not what the SDK provider reads, so
  // every use below -- the update, the unsettled readback, the replacement
  // fallback's delete -- takes the SDK form, and the success write persists
  // it with `provisionedBy: 'sdk'`. A failed update writes nothing, so the
  // record keeps its Cloud Control id and layer for the rollback and the next
  // deploy. A normalizer refusing the id throws here, before any AWS call.
  const currentResource: ResourceState =
    updateDecision.sdkMigration === true
      ? {
          ...recordedResource,
          physicalId: sdkAddressedPhysicalId(resourceType, recordedResource.physicalId, logicalId),
        }
      : recordedResource;
  if (updateDecision.sdkMigration === true) {
    // The ONLY reader of `sdkMigration`, and the reason the field
    // exists: without it this deploy moves a live resource between
    // provisioning layers and says so only at debug level. It fires
    // once, because the record says 'sdk' from this write on.
    //
    // The wording is per MODE, because the two flips happen for
    // opposite reasons and only one of them can be declined. A first
    // revision printed the coverage sentence for both and told a
    // 'cc-broken' user to pass `--pin-cc-api`, which that mode
    // deliberately ignores -- recommending a flag that silently no-ops
    // is the same class of defect as the typo this lane just closed.
    // Exhaustive rather than a ternary: a THIRD mode added later would
    // otherwise inherit the coverage wording AND a `--pin-cc-api`
    // suggestion, which is precisely the wrong-remedy defect this
    // per-mode split exists to fix. `exemptMode` cannot be undefined
    // here — `sdkMigration` is set only after `wouldReturnToSdkProvider`
    // found an entry in this same table — but the default arm keeps
    // that from being load-bearing.
    const exemptMode = STICKY_CC_MIGRATION_EXEMPT.get(resourceType)?.mode;
    const preserved =
      currentResource.physicalId === recordedResource.physicalId
        ? 'The physical id is preserved'
        : "The resource is kept in place, and its recorded physical id takes the SDK provider's form";
    let message: string;
    switch (exemptMode) {
      case 'cc-broken':
        message =
          safeMsg`${logicalId} (${resourceType}): moving to the SDK provider — Cloud ` +
          `Control cannot manage this type correctly. ${preserved}, and this ` +
          `routing is not optional.`;
        break;
      case 'sdk-coverage':
        message =
          safeMsg`${logicalId} (${resourceType}): returning to the SDK provider — cdkd now ` +
          `covers every property this resource uses. ${preserved}; pass ` +
          safeMsg`--pin-cc-api ${logicalId} to decline this for a deploy.`;
        break;
      default:
        message = safeMsg`${logicalId} (${resourceType}): moving to the SDK provider. ${preserved}.`;
    }
    engine.logger.info(message);
  }
  const updateProvider = updateDecision.provider;
  const updateProps =
    updateDecision.provisionedBy === 'cc-api'
      ? withoutGeneratedFallbackName(
          resourceType,
          resolvedProps,
          preparePropertiesForCcApi(
            engine.providerRegistry,
            resourceType,
            resolvedProps,
            logicalId,
            'omit'
          )
        )
      : resolvedProps;
  // The previous side the provider diffs against, with each create-only
  // path AWS confirmed holding its fresh `NoEcho` value set to the
  // value being sent (go-to-k/cdkd#3729). The record holds `***` there,
  // and a provider comparing `***` with the plaintext would see a
  // create-only change: ACM and IAM ManagedPolicy re-create inside
  // their own `update()` (bypassing `UpdateReplacePolicy: Retain` and
  // the stateful guard), and Cloud Control would patch a create-only
  // path. In memory only: nothing persists this bag, and the provider's
  // masker already holds the value as a needle.
  //
  // And for a type whose provider has no live source for a recorded
  // principal list (IAM::Policy, UserToGroupAddition), an entry state
  // holds as a secret reference the template still spells the same
  // way is dropped from the previous side (go-to-k/cdkd#4064): the
  // record's `{{resolve:...}}` is not a name, so every in-place update
  // was refused, and the desired side names that principal too.
  const previousWithNoEchoHeld =
    noEchoHeldPaths.size === 0
      ? currentPropsAsWritten
      : {
          ...currentPropsAsWritten,
          ...Object.fromEntries(
            [...noEchoHeldPaths]
              .filter((path) => Object.prototype.hasOwnProperty.call(updateProps, path))
              .map((path) => [path, updateProps[path]])
          ),
        };
  const { previous: previousWithSecretsDropped, dropped: droppedPrincipalKinds } =
    withUnchangedSecretPrincipalLists(
      resourceType,
      currentResource.physicalId,
      previousWithNoEchoHeld,
      desiredForSkipCheckAsWritten
    );
  // go-to-k/cdkd#4461: a child that survived a parent re-created under the
  // same id lost its attachment to it (IAM detaches a policy, an instance
  // profile's role, or a group's members before it deletes the principal),
  // while its record still lists the parent. Dropping the parent's name from
  // the side the provider diffs against makes its own diff attach it again.
  const reattached =
    reattach === true
      ? withRecreatedAttachmentsDropped({
          resourceType,
          templateProperties: template?.Resources?.[logicalId]?.Properties,
          previous: previousWithSecretsDropped,
          recreatedUnderSameId: engine.replacementRun.recreatedUnderSameId,
          recordOf: (id) => (Object.hasOwn(stateResources, id) ? stateResources[id] : undefined),
          conditions,
        })
      : undefined;
  const previousForUpdate = reattached?.previous ?? previousWithSecretsDropped;
  // go-to-k/cdkd#5112: a key whose previous side was rewritten above so the
  // provider's own diff acts on it (a dropped secret principal list, a
  // re-attachment) is a change the provider must not skip. The `NoEcho` held
  // paths are not: their previous side was set EQUAL to what is sent.
  const changedForProvider = new Set(changedProperties);
  for (const key of new Set([
    ...Object.keys(previousWithNoEchoHeld),
    ...Object.keys(previousForUpdate),
  ])) {
    if (
      keyOrderFreeJson(previousForUpdate[key]) !== keyOrderFreeJson(previousWithNoEchoHeld[key])
    ) {
      changedForProvider.add(key);
    }
  }
  // go-to-k/cdkd#5380: the keys an earlier failed update left unsettled, which
  // `update.ts` already counted in `changedProperties`; the provider is told
  // which of them to converge against AWS.
  const unsettled = unsettledPropertiesOf(currentResource);
  // go-to-k/cdkd#5498: what the failed update had been accepted for adding.
  const unsettledItems = unsettledItemsOf(currentResource);
  // Still nothing: an update the engine forces with no change as written (a
  // `reput` child of a parent re-created under the same id, go-to-k/cdkd#4411).
  // Every key counts, so no provider skips the write the update exists for.
  if (changedForProvider.size === 0) {
    for (const key of new Set([...Object.keys(updateProps), ...Object.keys(previousForUpdate)])) {
      changedForProvider.add(key);
    }
  }
  if (reattached !== undefined) {
    engine.logger.info(
      safeMsg`  ${logicalId} (${resourceType}) lost its attachment to ${reattached.parents.join(', ')}, which this deploy re-created under the same name: attaching it again`
    );
  }
  if (droppedPrincipalKinds.length > 0) {
    // Kinds only, never names. A secret whose value changed since the
    // last deploy under the same reference is not visible here: the
    // record keeps only the reference.
    const kinds = droppedPrincipalKinds.join(' / ');
    engine.logger.warn(
      safeMsg`${logicalId} (${resourceType}): the recorded ${kinds} holds a secret reference the template still spells the same way, so cdkd re-applies it to the principals this deploy resolved it to and removes it from none of them. If that secret's value changed since the last deploy, a principal only the OLD value named still has the policy or membership: remove it from that principal by hand.`
    );
  }

  // go-to-k/cdkd#5487: before the removal step, each unsettled name's previous
  // value becomes what AWS holds now (a moving one refuses the update), so the
  // removal step below resets a key the template omits but AWS now carries,
  // and the provider's own comparison sends only what AWS lacks. `Tags`
  // keeps the record's side (CloudFormation leaves tags it did not record).
  const unsettledIdentity = {
    provider: updateProvider,
    logicalId,
    physicalId: currentResource.physicalId,
    resourceType,
    recordedProperties: currentResource.properties ?? {},
  };
  const previousSettled = await settleUnsettledPrevious({
    ...unsettledIdentity,
    names: unsettled,
    previous: previousForUpdate,
    desired: updateProps,
    attemptedItems: unsettledItems,
  });
  if (unsettled.has('Tags')) {
    engine.logger.warn(
      safeMsg`${logicalId} (${resourceType}): an earlier failed update left Tags unsettled. cdkd re-applies the template's tags and removes only the recorded ones the template dropped; a tag that failed update added and no template declares is left on the resource. Remove it by hand if it should not be there.`
    );
  }

  // Issue #1160: a property the previous template declared and this one
  // omits. Computed once, outside the retry loop, against the SAME previous
  // bag the provider diffs (the state record — except an unsettled name,
  // which go-to-k/cdkd#5487 replaced with the AWS readback above); the
  // provider's declared reset values go into the bag it is handed, and an
  // audited type's undeclared removal is named once the in-place update
  // succeeded (a replacement fallback leaves no value in place).
  const removal = prepareRemovalForUpdate(
    updateProvider,
    resourceType,
    updateProps,
    previousSettled
  );

  let result;
  let resultProvisionedBy = updateDecision.provisionedBy;
  // The provider the observed-properties capture below reads the
  // resource back through (issue #2616's neighbour, issue #2608). It
  // moves in LOCKSTEP with `resultProvisionedBy`: both are reassigned
  // together on the update-failure replacement fallback, from the SAME
  // routing decision, so the layer the capture reads and the layer the
  // state record is stamped with cannot disagree by construction.
  //
  // Before this it was hard-wired to `updateProvider` at the call site
  // — the provider that just FAILED the update — so a replacement that
  // re-routed read the NEW physical resource through the OLD layer
  // while state named the new one. The capture then either returned
  // nothing (a provider asked to read a type it does not handle) or a
  // differently-shaped bag than the record's layer implies, and
  // `observedProperties` is what `cdkd drift` and the next deploy's
  // diff compare against — the phantom-drift class of issue #1591.
  //
  // Bound from the decision rather than re-derived with
  // `getProviderFor({ resourceType, provisionedBy: resultProvisionedBy })`:
  // that re-read is NOT an identity for every type. A
  // `STICKY_CC_MIGRATION_EXEMPT` type asked for
  // `provisionedBy: 'cc-api'` can deliberately fall through to its SDK
  // provider. That is the `'cc-broken'` case (`AWS::Scheduler::Schedule`),
  // whose escape is unconditional, so the re-read would reintroduce
  // exactly the mismatch it was meant to close.
  //
  // NOT the `'sdk-coverage'` case, despite the symmetry: this re-read
  // passes NO property bags, and that mode's flip requires both of
  // them, so it would refuse. An earlier revision of this comment said
  // the opposite and contradicted its own sibling at the
  // observed-capture site, which relies on that same no-bags refusal. The property-driven replacement
  // twin in `update-replace.ts` passes `replaceProvider` for the same reason.
  let captureProvider = updateProvider;
  // go-to-k/cdkd#5064 phase 2: the generation the update-not-supported
  // fallback created its new resource at (undefined: no fallback, or a legacy
  // stack, so the record carries its own).
  let replacedAtGeneration: number | undefined;
  const inlinePolicyClaimed = engine.inlinePolicyClaimedFor(
    resourceType,
    logicalId,
    stateResources
  );
  try {
    result = await engine.withRetry(
      () =>
        // The UPDATE twin of the CREATE call's async-local scope (issue
        // #1903). Both paths bind it or a nested stack that already
        // exists silently keeps persisting the parent's plaintext.
        withCurrentResourceSecrets(updateSecrets, () =>
          updateProvider.update(
            logicalId,
            currentResource.physicalId,
            resourceType,
            removal.properties,
            // `currentPropsAsWritten` (issue #2750): the ONE consumer
            // of the previous side that is asking what AWS holds.
            // `CloudControlProvider.update` diffs this into a JSON
            // Patch, so a key the SDK route never wrote must be absent
            // here or the patch omits it and the auto-route sends
            // nothing for it. `previousForUpdate` differs from it only
            // at confirmed NoEcho paths (go-to-k/cdkd#3729), and at an
            // IAM::Policy / UserToGroupAddition principal list whose
            // unchanged secret reference was dropped (go-to-k/cdkd#4064),
            // and at a `reattach` child's list naming a principal this
            // deploy re-created (go-to-k/cdkd#4461).
            previousSettled,
            // The UPDATE twin of the CREATE call's masker (issue #1932
            // item 3): same resolved bag, same exposure, so the contract
            // is applied on both or it has a hole in the shape of
            // whichever path a given deploy takes.
            //
            // `expectedRegion` (issue #2301 item 1) is the same value
            // this file already hands every `DeleteContext` it builds:
            // the region this stack's state was read under and is
            // written back to. The update is addressed BY
            // `currentResource.physicalId`, a state-recorded id, so it
            // carries the same wrong-region hazard the delete sites do
            // -- misapplied configuration rather than destruction, but
            // on a resource cdkd does not manage. Typed `string`, so a
            // caller with no region hands over `''`; the guard treats
            // that as absent and proceeds.
            //
            // `recordedAttributes` (issue #4051): the identity evidence
            // of the record `currentResource.physicalId` came from.
            {
              maskSecrets: createSecretMasker(updateSecrets),
              expectedRegion: engine.stackRegion,
              recordedAttributes: currentResource.attributes,
              ...(inlinePolicyClaimed && { inlinePolicyClaimed }),
              ...removal.context,
              changedProperties: changedForProvider,
              // go-to-k/cdkd#5380: the sink lives on the engine, so a mark
              // outlives this call's promise (deadline race, Ctrl-C, retry).
              markUnsettled: (propertyName: string) => {
                if (typeof propertyName !== 'string' || propertyName === '') return;
                // Only a top-level key this update sends or the record holds:
                // anything else names no property this resource has, and the
                // record must not carry it into every later deploy's diff. (A
                // name the record already carries unsettled stays by the union
                // at the failure save.)
                if (
                  !Object.hasOwn(resolvedProps, propertyName) &&
                  !Object.hasOwn(currentResource.properties ?? {}, propertyName)
                ) {
                  engine.logger.debug(
                    safeMsg`${logicalId}: ignored an unsettled mark for ${propertyName}, which is not one of its properties`
                  );
                  return;
                }
                let marks = engine.unsettledMarks.get(logicalId);
                if (marks === undefined) {
                  marks = new Set();
                  engine.unsettledMarks.set(logicalId, marks);
                }
                marks.add(propertyName);
              },
              // go-to-k/cdkd#5498: the items a resolved call added, per path.
              markAttempted: (path: string, items: readonly string[]) => {
                if (typeof path !== 'string' || path === '') return;
                let byPath = engine.unsettledItemMarks.get(logicalId);
                if (byPath === undefined) {
                  byPath = new Map();
                  engine.unsettledItemMarks.set(logicalId, byPath);
                }
                const names = byPath.get(path) ?? new Set<string>();
                for (const item of items)
                  if (typeof item === 'string' && item !== '') names.add(item);
                byPath.set(path, names);
              },
              ...(unsettled.size > 0 && { unsettledProperties: unsettled }),
              ...(unsettledItems.size > 0 && { unsettledItems }),
            }
          )
        ),
      logicalId,
      undefined,
      undefined,
      updateProvider
    );
    // go-to-k/cdkd#4443: the provider's own word that it sent nothing, taken
    // before anything below can throw, so a failed deploy can tell a re-put
    // child that wrote nothing from one that may have.
    if (result.sentNothing === true) engine.replacementRun.updatesThatSentNothing.add(logicalId);
    // go-to-k/cdkd#5380: the update finished, so what it marked settled (an
    // earlier attempt's marks included). The record built below carries no
    // `unsettledProperties`, which clears the previous record's.
    engine.unsettledMarks.delete(logicalId);
    engine.unsettledItemMarks.delete(logicalId);
    // go-to-k/cdkd#4911: a provider that replaced the resource inside its own
    // `update()` and reports `'partial'` could not delete the OLD one (its
    // delete threw or was skipped), so the rollback must read AWS before
    // re-creating it (go-to-k/cdkd#2631). Only this arm, the provider's own
    // answer: the deliberate `Retain` survivor is the fallback's literal below,
    // recorded through `retainedOldOnReplacement`. `'kept'` only on the
    // provider's own word that AWS refused the delete outright.
    if (result.wasReplaced === true && result.outcome === 'partial') {
      engine.replacementRun.replacedOldMaySurvive.set(
        logicalId,
        result.oldResourceSurvivor === 'kept' ? 'kept' : 'unconfirmed'
      );
    }
    // An injected reset is sent, never recorded: state keeps the template.
    result = withoutInjectedRemovals(result, removal.injected);
    // go-to-k/cdkd#5487: a live-only key the convergence step found is no
    // template removal; it is named for what it is.
    const unhandledByCause = splitUnhandledRemovals(
      removal.unhandled,
      previousForUpdate,
      unsettled
    );
    if (unhandledByCause.removedFromTemplate.length > 0) {
      engine.logger.warn(
        removalWarning(logicalId, resourceType, unhandledByCause.removedFromTemplate)
      );
    }
    if (unhandledByCause.addedByFailedUpdate.length > 0) {
      engine.logger.warn(
        addedByFailedUpdateWarning(logicalId, resourceType, unhandledByCause.addedByFailedUpdate)
      );
    }
  } catch (updateError) {
    // If UPDATE is not supported, fall back to a replacement. Two
    // triggers:
    //   1. CC API `UnsupportedActionException` — auto-fallback, needs
    //      no flag to REACH the replacement (issue #2514 left that
    //      half unchanged; only the stateful guard below became common
    //      to both triggers).
    //   2. An SDK provider throwing a typed
    //      `ResourceUpdateNotSupportedError` (an immutable property
    //      changed on a type with no replacement rule) — gated on the
    //      user opting in via `--replace`, because for some of these
    //      types the replacement is a data-losing DELETE + CREATE.
    //
    // Trigger 1 is classified STRUCTURALLY since issue #2520:
    // `isUpdateUnsupportedError` walks the bounded cause chain for the
    // exception NAME (and the async `ccErrorCode`), because the
    // provider's wrapper never copies the name into its message — the
    // predicate's old `includes('UnsupportedActionException')` half
    // therefore matched nothing cdkd produces. AWS's prose is not read
    // at all (issue #3810): a message can quote template-chosen text.
    //
    // `logicalId` is passed because a chain walk is otherwise WIDER
    // than the message read it replaces: a nested stack's child deploy
    // runs inside THIS `provider.update()` call, so a child resource's
    // Cloud Control rejection is reachable down the parent's cause
    // chain — and reading it here would DELETE + CREATE the whole
    // child stack. The classifier's doc comment carries that, the
    // measured wire shape, and the codes it deliberately refuses.
    const ccUnsupported = isUpdateUnsupportedError(updateError, logicalId);
    const typedUnsupported = updateError instanceof ResourceUpdateNotSupportedError;
    const replaceOptIn = typedUnsupported && engine.options.replace === true;
    // go-to-k/cdkd#5654: the deploy that rewrote a cc-api record's id into the
    // SDK form does not also replace the resource. A rollback of that
    // replacement compares the journal's SDK-form id with the record's Cloud
    // Control one, so a same-name replacement would read as renamed and be
    // undone create-first, colliding with the live service. On Cloud Control
    // (`--pin-cc-api`) the replacement keeps one id form throughout.
    if (
      (ccUnsupported || replaceOptIn) &&
      currentResource.physicalId !== recordedResource.physicalId
    ) {
      throw markNonRetryable(
        new CdkdError(
          safeMsg`${logicalId} (${resourceType}) needs a replacement for this change, which cdkd ` +
            `does not run on the deploy that moves it from Cloud Control to its SDK provider. ` +
            safeMsg`Re-run with --pin-cc-api ${logicalId} to replace it through Cloud Control.`,
          'SDK_MIGRATION_REPLACEMENT_REFUSED',
          updateError instanceof Error ? updateError : undefined
        )
      );
    }
    if (ccUnsupported || replaceOptIn) {
      // go-to-k/cdkd#5064 phase 2: the fallback's new resource takes the next
      // name generation on a stack with an instance id, as a property-driven
      // replacement does (`update.ts`): its name differs, so the name check
      // below makes it create first. The failed `update()` above ran under
      // the record's own generation.
      const fallbackStackInstanceId = getCurrentStackInstanceId();
      const fallbackGeneration =
        fallbackStackInstanceId === undefined
          ? undefined
          : nextNameGeneration(currentResource, logicalId, fallbackStackInstanceId);
      if (fallbackGeneration !== undefined) {
        engine.replacementRun.attemptedNameGeneration.set(logicalId, fallbackGeneration);
      }
      // The body lives in `update-in-place/replace-fallback.ts` (#5835).
      const replaceFallback = () =>
        replaceFallbackFor(engine, {
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
        });
      const fallbackOutcome = await (fallbackGeneration === undefined
        ? replaceFallback()
        : withNameGeneration({ logicalId, generation: fallbackGeneration }, replaceFallback));
      // go-to-k/cdkd#5380: the replacement now holds the record, so a mark the
      // failed update made describes the resource it replaced. Only once its
      // create succeeded: a fallback that throws leaves the old resource, which
      // keeps the mark.
      engine.unsettledMarks.delete(logicalId);
      engine.unsettledItemMarks.delete(logicalId);
      result = fallbackOutcome.result;
      resultProvisionedBy = fallbackOutcome.provisionedBy;
      captureProvider = fallbackOutcome.captureProvider;
      replacedAtGeneration = fallbackGeneration;
    } else {
      // go-to-k/cdkd#4904: this deploy moved an SDK-recorded resource to
      // Cloud Control, which addresses it by the SDK provider's physical id.
      // Name that move and both ways through; the cause stays conditional.
      if (
        currentResource.provisionedBy !== 'cc-api' &&
        updateDecision.ccRouteReason !== undefined &&
        updateError instanceof Error &&
        !isInterruptedWaitError(updateError) &&
        !isWaitAbandonedError(updateError)
      ) {
        const remedy = ccAutoRouteUpdateFailureRemedy(
          logicalId,
          resourceType,
          updateDecision.ccRouteReason.properties,
          engine.options.parentStackInfo !== undefined
        );
        // go-to-k/cdkd#2319: appended to AWS's own error, the remedy would be
        // dropped with AWS's text when the event recorder reduces that error
        // to its class. Such an error is wrapped instead: the class plus the
        // remedy in the persisted message, AWS's text in `debug` (masked) and
        // on the `cause`, which every downstream mark reader walks.
        const updateFailure = describeAwsFailure(updateError);
        if (updateFailure.redacted) {
          const shownSecrets = unionOfSecretBags([
            updateSecrets,
            printingSecretsFor(engine.secretsRun, logicalId),
          ]);
          engine.logger.debug(
            safeMsg`${maskSecretsInText(logicalId, shownSecrets)}: the update failed: ${asIsMessage(
              maskSecretsInText(updateFailure.detail, shownSecrets)
            )}`
          );
          const wrapped = new Error(`${displaySafe(updateFailure.summary)}${remedy}`, {
            cause: updateError,
          });
          // The AWS class stays the recorded `error.name`, as when the error
          // itself was thrown -- except `CredentialsProviderError`, a name
          // `isAwsAuthoredFailure` reads as AWS-authored on its own, so the
          // recorder would reduce the wrap too and drop the remedy.
          if (updateError.name !== 'CredentialsProviderError') wrapped.name = updateError.name;
          throw markRedactedCause(wrapped);
        }
        updateError.message += remedy;
      }
      throw updateError;
    }
  }

  // go-to-k/cdkd#5487: an unsettled name is settled only on proof — AWS no
  // longer changing it and holding what the template declares. Otherwise it
  // stays on the record, and the next deploy converges it again.
  const stillUnsettled = result.wasReplaced
    ? []
    : await unsettledAfterUpdate({
        ...unsettledIdentity,
        names: unsettled,
        desired: updateProps,
        attemptedItems: unsettledItems,
      });
  if (stillUnsettled.length > 0) {
    engine.logger.warn(
      safeMsg`${logicalId} (${resourceType}): the update succeeded, but AWS does not yet show the template's ${stillUnsettled.join(', ')}; cdkd keeps ${stillUnsettled.length === 1 ? 'it' : 'them'} unsettled and converges again on the next deploy.`
    );
  }

  // go-to-k/cdkd#4615: journaled on the completed op, so a rollback reverts an
  // in-place update in place even when it changed the physical id.
  engine.replacementRun.updateWasReplaced.set(logicalId, result.wasReplaced === true);
  // State schema v12 (go-to-k/cdkd#4847 / #4852): an in-place update of a
  // record holding a token keeps the create-only paths for the persist
  // writer's union rule. Read from the per-type cache (or the committed
  // snapshot), NEVER looked up here: a type with neither is `'all'`, the
  // conservative answer. A token-free record asks nothing.
  if (
    result.wasReplaced !== true &&
    (hasPassProvenance(updateSecrets) || referenceProvenanceOf(currentResource) !== undefined)
  ) {
    const cached = cachedCreateOnlyPropertyPaths(resourceType);
    engine.replacementRun.inPlaceCreateOnlyPaths.set(
      logicalId,
      cached === undefined ? 'all' : await cached.catch(() => 'all' as const)
    );
  }
  if (result.wasReplaced) {
    // go-to-k/cdkd#3869: the NEW id, judged with this deploy's bag, before
    // the line names it (the old one was judged before the body ran).
    noteSecretNamedRecord(engine.secretsRun, logicalId, {
      resourceType,
      physicalId: result.physicalId,
      properties: resolvedProps,
    });
    engine.logger.info(
      safeMsg`Resource ${logicalId} was replaced: ${displayPhysicalId(currentResource.resourceType, currentResource.physicalId)} -> ${displayPhysicalId(resourceType, result.physicalId)}`
    );
  }

  // Issue #3462 — the ONE refusal class an in-place UPDATE may not
  // clear. The rebuild below enumerates its fields, which is what
  // clears every other `observedBaselineRefused` (see
  // `drainObservedCaptures`); for an unverifiable-parameter refusal
  // that is the leak. `cdkd import` refused because a template
  // parameter was not provably deployed at its `Default`, and a
  // top-level deploy binds that SAME `Default` (a nested child is handed
  // its values by the parent, where keeping the refusal is merely
  // conservative): the record's placeholder leaf is unchanged, so the
  // provider need not have rewritten it, AWS can still hold the
  // deployed value there, and a readback positioned against the
  // placeholder pairs it as an ordinary drifted literal. The engine
  // cannot know which leaves a provider wrote, so NO in-place update
  // discharges it, whatever it changed.
  //
  // A replacement does, but only one that is EVIDENCED: `wasReplaced`
  // AND a physical id that actually changed, so the capture below reads
  // a resource built from the bag cdkd sent. The flag alone is not
  // trusted: `S3BucketProvider.update` answers `wasReplaced: true` with
  // the OLD id when the bound `BucketName` differs from it — exactly
  // this class's shape, a name bound to a placeholder — having created
  // nothing, and the capture would then read the old bucket. Both
  // half-signals (the flag with the same id, a new id without the
  // flag, the update-unsupported fallback re-creating under the same
  // name) KEEP the refusal: the fail-closed reading.
  //
  // A marker an older cdkd recorded WITHOUT a reason reaches this line
  // already read: `stampReasonlessParameterRefusals` ran at deploy
  // start (issue #3468).
  const dischargedByReplacement =
    result.wasReplaced === true && result.physicalId !== currentResource.physicalId;
  const keepsParameterRefusal =
    !dischargedByReplacement && hasUnverifiableParameterRefusal(currentResource);

  // Attributes: prefer the update result's fresh set; when the
  // provider returned none AND the resource was updated IN PLACE,
  // carry the previously-stored (create-time) attributes forward —
  // an in-place update never invalidates them, and dropping them
  // would degrade every later Fn::GetAtt on this resource to the
  // physical-id fallback (observed live: an FSx update wiped
  // LustreMountName / DNSName and the stack outputs regressed to
  // the file-system id). A REPLACED resource must NOT inherit the
  // old resource's attributes — its create result is authoritative
  // (and absent attributes stay absent).
  const carriedAttributes =
    result.attributes ?? (result.wasReplaced ? undefined : currentResource.attributes);

  // Issue #2274: registered against `carriedAttributes`, not
  // `result.attributes`, because those are the values that land in the
  // record — and the whole point of the needles is to redact what is
  // PERSISTED. The two differ exactly when a provider declared `NoEcho`
  // and returned no fresh attributes, where the carried-forward set is
  // what state keeps.
  registerNoEchoAttributes(
    engine.secretsRun,
    engine.maskingDeps(),
    logicalId,
    {
      ...(carriedAttributes && { attributes: carriedAttributes }),
      ...(result.noEchoAttributes === true && { noEchoAttributes: true }),
      ...(result.noEchoAttributeNames && {
        noEchoAttributeNames: result.noEchoAttributeNames,
      }),
    },
    updateSecrets,
    resolvedProps
  );

  const recordedProperties = propertiesToRecord(
    resolvedProps,
    result,
    resourceType,
    resultProvisionedBy
  );
  // go-to-k/cdkd#4656: what this deploy read of the OLD resource does not
  // describe a resource the fallback replaced.
  if (result.wasReplaced) engine.noEchoRun.noEchoExactEchoes.delete(logicalId);
  stateResources[logicalId] = {
    physicalId: result.physicalId,
    ...(replacedAtGeneration === undefined
      ? nameGenerationCarriedFrom(currentResource)
      : nameGenerationField(replacedAtGeneration)),
    resourceType,
    properties: recordedProperties,
    // #2790: an update of the same resource cannot set a create-only key, so
    // it only CARRIES the previous evidence; an evidenced replacement inside
    // `update()` built a new resource, whose evidence is rebuilt.
    ...acceptedCreateOnlyDropsField(
      recordedProperties,
      resourceType,
      resultProvisionedBy,
      dischargedByReplacement ? 'new-resource' : 'in-place',
      currentResource
    ),
    ...(carriedAttributes && { attributes: carriedAttributes }),
    // go-to-k/cdkd#3869: the result's names describe its fresh attributes;
    // carried attributes keep the previous names, a replacement none.
    ...secretNamedAttributesField(
      result,
      result.attributes === undefined && !result.wasReplaced ? currentResource : undefined
    ),
    // go-to-k/cdkd#2449: the previous declared `NoEcho` attribute names, which
    // the save unions with this run's declaration (an in-place update keeps
    // the resource, and a name whose attribute still holds the mask stays
    // declared). Not on a replacement: the new resource's create result is
    // authoritative, as for `attributes` above.
    ...(!result.wasReplaced &&
      currentResource.noEchoAttributeNames !== undefined && {
        noEchoAttributeNames: currentResource.noEchoAttributeNames,
      }),
    // go-to-k/cdkd#4656: the same resource keeps its provider's proven echo
    // fidelity (the save drops an entry no longer marked); a replacement
    // here took no echo-fidelity readback, so it starts with none.
    ...(!result.wasReplaced &&
      currentResource.noEchoExactEchoLeaves !== undefined && {
        noEchoExactEchoLeaves: currentResource.noEchoExactEchoLeaves,
      }),
    ...(dependencies && dependencies.length > 0 && { dependencies }),
    ...extractTemplateAttributes(template, logicalId),
    provisionedBy: resultProvisionedBy,
    ...(stillUnsettled.length > 0 && {
      unsettledProperties: stillUnsettled,
      // go-to-k/cdkd#5498: a key that stays unsettled keeps its attempted names.
      // go-to-k/cdkd#5498: the one rebuilt record that carries items — only
      // those of the keys the proof kept unsettled, read off the old record.
      ...unsettledItemsField(currentResource, stillUnsettled),
    }),
    ...(keepsParameterRefusal && {
      observedBaselineRefused: true as const,
      observedBaselineRefusalReason: 'unverifiable-parameter' as const,
    }),
  };
  // go-to-k/cdkd#5511: state now holds the resource, so no failure after
  // this point journals it as an orphan.
  clearCreatedReport();
  // 'update' even after the replacement fallback: a principal then
  // claims only on its own `Policies` change (the fewer claims).
  if (updatePartialReason(result) === undefined) {
    engine.recordInlinePolicyWrite(logicalId, 'update');
  }

  if (keepsParameterRefusal) {
    // No readback is TAKEN, not merely not persisted: a value that is
    // never read cannot reach the record, the journal, an event or a
    // log line by any route.
    engine.logger.debug(
      safeMsg`observedProperties capture SKIPPED for updated ${logicalId} (${resourceType}): 'cdkd import' refused its baseline because a template parameter was not provably deployed at its 'Default', and this deploy bound the same 'Default' — an in-place update cannot show that AWS no longer holds the deployed value. The refusal stands until the resource is replaced or re-imported against a CloudFormation stack that proves the parameter.`
    );
  }
  const updateCaptureSiblings = keepsParameterRefusal
    ? undefined
    : await buildObservedCaptureSiblings(
        {
          options: engine.options,
          buildResolverContext: (...args) =>
            buildResolverContext(engine.resolverContextDeps(), ...args),
          resolver: engine.resolver,
        },
        resourceType,
        logicalId,
        result.physicalId,
        template,
        stateResources,
        stackName,
        parameterValues,
        conditions
      );
  // `captureProvider`, NOT `updateProvider`: on the plain in-place
  // path they are the same binding, and on the replacement fallback
  // this is the provider that actually created `result.physicalId`
  // and the layer `provisionedBy` above was stamped with (issue
  // #2608).
  if (!keepsParameterRefusal) {
    engine.observedCapture.kickOffObservedCapture(
      captureProvider,
      logicalId,
      result.physicalId,
      resourceType,
      resolvedProps,
      { ...updateCaptureSiblings, afterOwnWrite: true },
      updateSecrets
    );
  }

  // Issue #1819: the provider may have updated the resource and left
  // something behind. The row still counts as an update for ordering
  // and state purposes, but it is not a clean one, so it gets its own
  // counter and its own status line rather than printing `updated`
  // over a survivor the user is never told about.
  const updatePartial = updatePartialReason(result);
  if (counts) {
    if (updatePartial !== undefined) counts.updatePartial++;
    else counts.updated++;
  }
  if (progress) progress.current++;
  const updatePrefix = progress ? `[${progress.current}/${progress.total}] ` : '  ';
  renderer.removeTask(logicalId);
  // go-to-k/cdkd#4043 (review CODE m1): an update-failure fallback's skipped
  // old-resource delete makes the row partial too (`provisionResource` counts
  // it); the line names every reason.
  const replacedSkip = engine.replacementRun.replacedDeleteSkips.get(logicalId);
  const shownPartial =
    updatePartial !== undefined && replacedSkip !== undefined
      ? `${updatePartial}; ${replacedSkip}`
      : (updatePartial ?? replacedSkip);
  if (shownPartial !== undefined) {
    engine.logger.warn(
      safeMsg`${updatePrefix}${formatResourceLine('updated', logicalId, resourceType)} ` +
        safeMsg`${updatePartialMessage(shownPartial)}`
    );
    if (updatePartial !== undefined) return { updatePartial };
    return;
  }
  engine.logger.info(
    safeMsg`${updatePrefix}${formatResourceLine('updated', logicalId, resourceType)}`
  );
}
