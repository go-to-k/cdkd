import { type DeployEngine } from '../deploy-engine.js';
import type { ProvisionCounts, ResourceOutcomeSignal } from '../deploy-engine.js';
import { withUnchangedSecretPrincipalLists } from '../../provisioning/iam-policy-targets.js';
import { withRecreatedAttachmentsDropped } from '../child-of-recreated-parent.js';
import { isInterruptedWaitError } from '../../provisioning/interrupt-watch.js';
import { STICKY_CC_MIGRATION_EXEMPT } from '../../provisioning/provider-registry.js';
import {
  recordedProtectionEvidence,
  recordedProtectionNote,
} from '../../provisioning/recorded-protection.js';
import { withoutGeneratedFallbackName } from '../../provisioning/resource-name.js';
import {
  prepareRemovalForUpdate,
  removalWarning,
  withoutInjectedRemovals,
} from '../../provisioning/update-removal.js';
import {
  isStatefulRecreateTargetForReplace,
  renderStatefulReason,
} from '../../provisioning/stateful-types.js';
import { isWaitAbandonedError } from '../../provisioning/wait-abandoned.js';
import type {
  CloudFormationTemplate,
  ResourceCreateResult,
  ResourceDeleteResult,
  ResourceUpdateResult,
} from '../../types/resource.js';
import { type ResourceState, hasUnverifiableParameterRefusal } from '../../types/state.js';
import { acceptedCreateOnlyDropsField } from './record-shape.js';
import { safeMsg } from '../../utils/display-safe.js';
import { CdkdError, ResourceUpdateNotSupportedError } from '../../utils/error-handler.js';
import { formatResourceLine } from '../../utils/resource-line.js';
import { deleteSkipReason, deleteSkippedMessage } from '../delete-outcome.js';
import { reportDeleteGuards } from '../delete-guard-scope.js';
import {
  renderNameHeldElsewhere,
  replacementRequestsDifferentName,
} from '../replacement-name-holder.js';
import { withCurrentResourceSecrets } from '../resource-secrets-scope.js';
import {
  isMarkedNonRetryable,
  isNameCollisionErrorFrom,
  isUpdateUnsupportedError,
  markNonRetryable,
} from '../retryable-errors.js';
import { createSecretMasker, maskSecretsInText } from '../secret-redaction.js';
import { equalIdNamesDifferentResources } from '../type-change-guard.js';
import { updatePartialMessage, updatePartialReason } from '../update-outcome.js';
import type { LiveRenderer } from '../../utils/live-renderer.js';
import type { RecordedSecretValues } from '../secret-redaction.js';
import { noteRetainedResource } from '../../provisioning/providers/create-token-ledger.js';

declare module '../deploy-engine.js' {
  interface DeployEngine {
    /** @internal */
    updateInPlace: OmitThisParameter<typeof updateInPlace>;
  }
}

/** A branch of `provisionUpdate` (`update.ts`), split out of it (#4350). */
export async function updateInPlace(
  this: DeployEngine,
  {
    conditions,
    counts,
    currentProps,
    currentPropsAsWritten,
    currentResource,
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
  // created via Cloud Control (because of silent-drop properties at
  // CREATE time), the update stays on Cloud Control. If it was
  // SDK-managed and the user has since added a silent-drop property,
  // we re-evaluate via `getProviderFor` — which will auto-route
  // through Cloud Control as long as the user hasn't overridden
  // via `--allow-unsupported-properties`. Once a resource flips
  // to CC mid-life, it stays there (the state record's
  // `provisionedBy: 'cc-api'` written below sticks).
  this.logger.debug(`Updating ${logicalId} (${resourceType})`);
  const updateDecision = this.providerRegistry.getProviderFor({
    resourceType,
    properties: resolvedProps,
    provisionedBy: currentResource.provisionedBy,
    // Issue #2719: the RECORD's bag, not the diff's current side. It is
    // the resolved desired bag of the last successful deploy, so a
    // property applied under Cloud Control and since deleted from the
    // template is still visible here -- which is the one case a
    // desired-only flip condition gets wrong (see
    // `GetProviderForInput.previousProperties`).
    previousProperties: currentResource.properties,
    ...(this.isPinnedToCcApi(stackName, logicalId) && { forceCcApi: true }),
  });
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
    const preserved = 'The physical id is preserved';
    let message: string;
    switch (exemptMode) {
      case 'cc-broken':
        message =
          `${logicalId} (${resourceType}): moving to the SDK provider — Cloud ` +
          `Control cannot manage this type correctly. ${preserved}, and this ` +
          `routing is not optional.`;
        break;
      case 'sdk-coverage':
        message =
          `${logicalId} (${resourceType}): returning to the SDK provider — cdkd now ` +
          `covers every property this resource uses. ${preserved}; pass ` +
          `--pin-cc-api ${logicalId} to decline this for a deploy.`;
        break;
      default:
        message = `${logicalId} (${resourceType}): moving to the SDK provider. ${preserved}.`;
    }
    this.logger.info(message);
  }
  const updateProvider = updateDecision.provider;
  const updateProps =
    updateDecision.provisionedBy === 'cc-api'
      ? withoutGeneratedFallbackName(
          resourceType,
          resolvedProps,
          this.preparePropertiesForCcApi(resourceType, resolvedProps, logicalId)
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
  const { previous: previousWithSecretsDropped, dropped: droppedPrincipalKinds } =
    withUnchangedSecretPrincipalLists(
      resourceType,
      currentResource.physicalId,
      noEchoHeldPaths.size === 0
        ? currentPropsAsWritten
        : {
            ...currentPropsAsWritten,
            ...Object.fromEntries(
              [...noEchoHeldPaths]
                .filter((path) => Object.prototype.hasOwnProperty.call(updateProps, path))
                .map((path) => [path, updateProps[path]])
            ),
          },
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
          recreatedUnderSameId: this.recreatedUnderSameId,
          recordOf: (id) => (Object.hasOwn(stateResources, id) ? stateResources[id] : undefined),
          conditions,
        })
      : undefined;
  const previousForUpdate = reattached?.previous ?? previousWithSecretsDropped;
  if (reattached !== undefined) {
    this.logger.info(
      safeMsg`  ${logicalId} (${resourceType}) lost its attachment to ${reattached.parents.join(', ')}, which this deploy re-created under the same name: attaching it again`
    );
  }
  if (droppedPrincipalKinds.length > 0) {
    // Kinds only, never names. A secret whose value changed since the
    // last deploy under the same reference is not visible here: the
    // record keeps only the reference.
    const kinds = droppedPrincipalKinds.join(' / ');
    this.logger.warn(
      safeMsg`${logicalId} (${resourceType}): the recorded ${kinds} holds a secret reference the template still spells the same way, so cdkd re-applies it to the principals this deploy resolved it to and removes it from none of them. If that secret's value changed since the last deploy, a principal only the OLD value named still has the policy or membership: remove it from that principal by hand.`
    );
  }

  // Issue #1160: a property the previous template declared and this one
  // omits. Computed once, outside the retry loop, against the SAME previous
  // bag the provider diffs (the state record, never an AWS readback); the
  // provider's declared reset values go into the bag it is handed, and an
  // audited type's undeclared removal is named once the in-place update
  // succeeded (a replacement fallback leaves no value in place).
  const removal = prepareRemovalForUpdate(
    updateProvider,
    resourceType,
    updateProps,
    previousForUpdate
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
  const inlinePolicyClaimed = this.inlinePolicyClaimedFor(resourceType, logicalId, stateResources);
  try {
    result = await this.withRetry(
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
            previousForUpdate,
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
              expectedRegion: this.stackRegion,
              recordedAttributes: currentResource.attributes,
              ...(inlinePolicyClaimed && { inlinePolicyClaimed }),
              ...removal.context,
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
    if (result.sentNothing === true) this.updatesThatSentNothing.add(logicalId);
    // An injected reset is sent, never recorded: state keeps the template.
    result = withoutInjectedRemovals(result, removal.injected);
    if (removal.unhandled.length > 0) {
      this.logger.warn(removalWarning(logicalId, resourceType, removal.unhandled));
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
    const replaceOptIn = typedUnsupported && this.options.replace === true;
    if (ccUnsupported || replaceOptIn) {
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
      if (statefulReason && this.options.forceStatefulRecreation !== true) {
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
          this.stackRegion
        );
        throw markNonRetryable(
          new CdkdError(
            replaceOptIn
              ? `--replace would DELETE + CREATE the stateful resource ${logicalId} ` +
                  `(${resourceType}) — ${renderStatefulReason(statefulReason)}. ` +
                  (protection
                    ? `${recordedProtectionNote(protection, '--replace --force-stateful-recreation')} ` +
                      `Or change the resource's definition to avoid the immutable-property change.`
                    : `Re-run with --force-stateful-recreation to confirm the data loss, or ` +
                      `change the resource definition to avoid the immutable-property change.`)
              : `${logicalId} (${resourceType}) cannot be updated in place by the ` +
                  `provisioning layer it routes through, so applying this change would ` +
                  `DELETE + CREATE it — but it is a stateful resource: ` +
                  `${renderStatefulReason(statefulReason)}. ` +
                  (protection
                    ? `${recordedProtectionNote(protection, '--force-stateful-recreation')} ` +
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
      const replDecision = this.providerRegistry.getProviderFor({
        resourceType,
        properties: resolvedProps,
        previousProperties: currentResource.properties,
      });
      const replProvider = replDecision.provider;
      const replProps =
        replDecision.provisionedBy === 'cc-api'
          ? this.preparePropertiesForCcApi(resourceType, resolvedProps, logicalId)
          : resolvedProps;
      // go-to-k/cdkd#3937 / #3931, as on the property-driven path: a
      // name known to move off the old resource's, probed where the
      // create would adopt a taken one. Under Retain it only probes.
      const fallbackNameChange = await this.checkedReplacementNameChange({
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
      this.logger.info(
        retainOldOnReplace
          ? `UPDATE not supported for ${logicalId} (${resourceType}), replacing ` +
              `(CREATE only — UpdateReplacePolicy: Retain keeps the old resource)`
          : createFirst
            ? safeMsg`UPDATE not supported for ${logicalId} (${resourceType}), replacing (CREATE → DELETE — the new name differs from the old resource's)`
            : `UPDATE not supported for ${logicalId} (${resourceType}), replacing (DELETE → CREATE)`
      );
      if (retainOldOnReplace) {
        // go-to-k/cdkd#4438: the kept resource holds this stack's create
        // token, so the create below must not send it again.
        await noteRetainedResource(resourceType, logicalId);
      }
      if (!retainOldOnReplace && !createFirst) {
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
          template?.Resources?.[logicalId]?.UpdateReplacePolicy ??
          currentResource.updateReplacePolicy;
        const fallbackFinalSnapshotId = await this.prepareFinalSnapshotForDelete(
          logicalId,
          resourceType,
          currentResource,
          fallbackUpdateReplacePolicy
        );
        // Initialized because the catch below can leave it unassigned.
        let fallbackDeleteResult: void | ResourceDeleteResult = undefined;
        try {
          fallbackDeleteResult = await updateProvider.delete(
            logicalId,
            currentResource.physicalId,
            resourceType,
            currentProps,
            {
              expectedRegion: this.stackRegion,
              forceDataDelete: this.options.forceStatefulRecreation === true,
              ...(fallbackFinalSnapshotId !== undefined && {
                finalSnapshotIdentifier: fallbackFinalSnapshotId,
              }),
              ...this.replacementDeleteContext(fallbackUpdateReplacePolicy),
              recordedAttributes: currentResource.attributes,
            }
          );
        } catch (deleteError) {
          // If old resource doesn't exist (already deleted), proceed with CREATE
          const deleteMsg =
            deleteError instanceof Error ? deleteError.message : String(deleteError);
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
          // those siblings state.
          if (
            !isWaitAbandonedError(deleteError) &&
            !isInterruptedWaitError(deleteError) &&
            !isMarkedNonRetryable(deleteError) &&
            (deleteMsg.includes('does not exist') ||
              deleteMsg.includes('not found') ||
              deleteMsg.includes('NotFound'))
          ) {
            this.logger.debug(`Old resource ${logicalId} already gone, proceeding with CREATE`);
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
          // the record's (a silent-drop auto-route, `--pin-cc-api`).
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
        this.oldDeletedBeforeCreate.add(logicalId);
      }
      // Set only on the retain arm; drives the `partial` outcome below.
      let retainedSurvivorReason: string | undefined;
      let createResult: ResourceCreateResult;
      try {
        createResult =
          createFirst && fallbackNameChange !== undefined
            ? await this.createFirstThenDeleteOld({
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
              })
            : await this.withRetry(
                () =>
                  withCurrentResourceSecrets(updateSecrets, () =>
                    replProvider.create(logicalId, resourceType, replProps, {
                      maskSecrets: createSecretMasker(updateSecrets),
                    })
                  ),
                logicalId,
                undefined,
                undefined,
                replProvider
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
          // delete-first fallback ({@link replaceDeleteFirstAndRecreate})
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
          // lives INSIDE `this.withRetry` above, which has already
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
          throw new Error(
            maskSecretsInText(
              `Failed to create ${logicalId} after the UPDATE-not-supported ` +
                `replacement: the old resource (${currentResource.physicalId}) ` +
                `is now gone. Cause: ` +
                `${createError instanceof Error ? createError.message : String(createError)}. ` +
                `Re-run the deploy to create it fresh.`,
              updateSecrets
            ),
            { cause: createError instanceof Error ? createError : undefined }
          );
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
              `${logicalId} (${resourceType}) requires replacement because the ` +
                `provisioning layer cannot update it in place, but the create collided. ` +
                `${renderNameHeldElsewhere(nameHeldElsewhere)} — so removing ` +
                `UpdateReplacePolicy: Retain would delete this resource and still ` +
                `collide. Choose a name no other resource holds, or delete the resource ` +
                `holding it if it is yours.`,
              'NAMED_REPLACEMENT_COLLISION',
              createError instanceof Error ? createError : undefined
            )
          );
        }
        const nameOrigin = this.replacementNameOrigin(logicalId, currentResource.physicalId);
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
            `${logicalId} (${resourceType}) requires replacement because the ` +
              `provisioning layer cannot update it in place — but its physical name ` +
              `is still held by the existing resource AND ` +
              `UpdateReplacePolicy: Retain pins that resource in place. ` +
              `${nameOrigin.descriptor}. ${nameOrigin.remedy} — with Retain, the old ` +
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
        this.recreatedUnderSameId.add(logicalId);
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
          const idempotentNameOrigin = this.replacementNameOrigin(
            logicalId,
            currentResource.physicalId
          );
          // Marked for the same reason as its collision sibling: the
          // verdict is two recorded physical ids plus a template
          // attribute, and the message carries template-controlled
          // text into the substring classifiers. Nothing to chain —
          // the create SUCCEEDED; the failure is what it returned.
          throw markNonRetryable(
            new CdkdError(
              `${logicalId} (${resourceType}) requires replacement, but its Create ` +
                `API is name-idempotent: the create returned the existing resource ` +
                `(${currentResource.physicalId}) instead of creating a new one, and ` +
                `UpdateReplacePolicy: Retain pins that resource in place, so the new ` +
                `properties were not applied. ${idempotentNameOrigin.descriptor}. ` +
                `${idempotentNameOrigin.remedy} — with Retain, the old resource keeps ` +
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
        this.retainedOldOnReplacement.add(logicalId);
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
        this.logger.warn(
          `  ⚠ ${logicalId} has UpdateReplacePolicy: Retain — the old physical ` +
            `resource (${currentResource.physicalId}) is RETAINED and is no longer ` +
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
          `(${currentResource.physicalId}), now untracked by cdkd`;
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
      result = replacementResult;
      resultProvisionedBy = replDecision.provisionedBy;
      // Issue #2608: same decision, same statement — the two must not
      // be separable by a later edit.
      captureProvider = replProvider;
    } else {
      throw updateError;
    }
  }

  // go-to-k/cdkd#4615: journaled on the completed op, so a rollback reverts an
  // in-place update in place even when it changed the physical id.
  this.updateWasReplaced.set(logicalId, result.wasReplaced === true);
  if (result.wasReplaced) {
    this.logger.info(
      `Resource ${logicalId} was replaced: ${currentResource.physicalId} -> ${result.physicalId}`
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
  this.registerNoEchoAttributes(
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

  const recordedProperties = this.propertiesToRecord(
    resolvedProps,
    result,
    resourceType,
    resultProvisionedBy
  );
  stateResources[logicalId] = {
    physicalId: result.physicalId,
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
    ...(dependencies && dependencies.length > 0 && { dependencies }),
    ...this.extractTemplateAttributes(template, logicalId),
    provisionedBy: resultProvisionedBy,
    ...(keepsParameterRefusal && {
      observedBaselineRefused: true as const,
      observedBaselineRefusalReason: 'unverifiable-parameter' as const,
    }),
  };
  // 'update' even after the replacement fallback: a principal then
  // claims only on its own `Policies` change (the fewer claims).
  if (updatePartialReason(result) === undefined) {
    this.recordInlinePolicyWrite(logicalId, 'update');
  }

  if (keepsParameterRefusal) {
    // No readback is TAKEN, not merely not persisted: a value that is
    // never read cannot reach the record, the journal, an event or a
    // log line by any route.
    this.logger.debug(
      `observedProperties capture SKIPPED for updated ${logicalId} (${resourceType}): 'cdkd import' refused its baseline because a template parameter was not provably deployed at its 'Default', and this deploy bound the same 'Default' — an in-place update cannot show that AWS no longer holds the deployed value. The refusal stands until the resource is replaced or re-imported against a CloudFormation stack that proves the parameter.`
    );
  }
  const updateCaptureSiblings = keepsParameterRefusal
    ? undefined
    : await this.buildObservedCaptureSiblings(
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
    this.kickOffObservedCapture(
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
  if (updatePartial !== undefined) {
    this.logger.warn(
      `${updatePrefix}${formatResourceLine('updated', logicalId, resourceType)} ` +
        updatePartialMessage(updatePartial)
    );
    return { updatePartial };
  }
  this.logger.info(`${updatePrefix}${formatResourceLine('updated', logicalId, resourceType)}`);
}
