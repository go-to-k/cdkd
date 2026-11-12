import { survivesParent } from '../../child-of-recreated-parent.js';
import { type DeployEngine } from '../../deploy-engine.js';
import type { ProvisionCounts, ResourceOutcomeSignal } from '../../deploy-engine.js';
import { peekRoutingForLabel, recreateDirectionFor } from '../routing.js';
import { updateByReplacement } from '../update-replace.js';
import {
  getCurrentStackInstanceId,
  withNameGeneration,
} from '../../../provisioning/resource-name.js';
import { replacementNameGeneration } from '../../../state/name-generation.js';
import { updateInPlace } from '../update-in-place.js';
import { extractAllDependencies } from '../record-shape.js';
import { CdkdError } from '../../../utils/error-handler.js';
import { markNonRetryable } from '../../retryable-errors.js';
import { markRefusedBeforeApplying } from '../../prior-attempt-scope.js';
import type { CloudFormationTemplate } from '../../../types/resource.js';
import { type ResourceChange, type ResourceState } from '../../../types/state.js';
import { safeMsg } from '../../../utils/display-safe.js';
import { createSecretMasker, valueAtCoordinate } from '../../secret-redaction.js';
import {
  diffMovedServiceToken,
  renderServiceTokenRefusal,
  SERVICE_TOKEN_CHANGE_REFUSED,
  serviceTokenUpdateRefusal,
} from '../../custom-resource-service-token.js';
import { setAtCoordinate } from './helpers.js';
import type { ResolvedUpdateInputs } from './resolve-inputs.js';
import type { ComparedUpdate } from './compare-record.js';

/** What `provisionUpdate` hands {@link finishUpdate}: its parameters and the values its phases bound. */
export interface FinishUpdateInput
  extends
    Pick<
      ResolvedUpdateInputs,
      | 'resourceType'
      | 'renderer'
      | 'currentResource'
      | 'oldResourceType'
      | 'typeChanged'
      | 'currentProps'
      | 'updateSecrets'
      | 'resolvedProps'
      | 'lostChild'
      | 'lostWithParent'
    >,
    Pick<
      ComparedUpdate,
      | 'desiredForSkipCheckAsWritten'
      | 'witness'
      | 'currentPropsAsWritten'
      | 'otherFreshAt'
      | 'pendingParameterLeaves'
      | 'unsettledNames'
      | 'movedAsWritten'
    > {
  logicalId: string;
  change: ResourceChange;
  stateResources: Record<string, ResourceState>;
  stackName: string;
  template: CloudFormationTemplate | undefined;
  parameterValues: Record<string, unknown> | undefined;
  conditions: Record<string, boolean> | undefined;
  counts: ProvisionCounts | undefined;
  progress: { current: number; total: number } | undefined;
  confirmedPaths: Set<string>;
  propertyDrivenReplacement: boolean | undefined;
  recreateViaCcApi: boolean;
  recreateViaSdkProvider: boolean;
  recreateFlagged: boolean;
  needsReplacement: boolean | undefined;
}

/**
 * The last phase of `provisionUpdate`: the live label, then the replacement or
 * the in-place update. Split out of `deploy-engine/update.ts`
 * (go-to-k/cdkd#5835); the statements run in their original order.
 */
export async function finishUpdate(
  engine: DeployEngine,
  input: FinishUpdateInput
): Promise<ResourceOutcomeSignal | void> {
  const {
    logicalId,
    change,
    stateResources,
    stackName,
    template,
    parameterValues,
    conditions,
    counts,
    progress,
    resourceType,
    renderer,
    currentResource,
    oldResourceType,
    typeChanged,
    currentProps,
    updateSecrets,
    resolvedProps,
    lostChild,
    lostWithParent,
    desiredForSkipCheckAsWritten,
    witness,
    currentPropsAsWritten,
    otherFreshAt,
    pendingParameterLeaves,
    unsettledNames,
    movedAsWritten,
    confirmedPaths,
    propertyDrivenReplacement,
    recreateViaCcApi,
    recreateViaSdkProvider,
    recreateFlagged,
    needsReplacement,
  } = input;
  // The label `provisionResource` chose left ceilings out; one that
  // stood (the value moved, or it is a fresh `NoEcho` value AWS could
  // not confirm unchanged) turns this into a replacement, so say so.
  const liveLabel = engine.liveTaskLabels.get(logicalId);
  if (needsReplacement && liveLabel !== undefined && !liveLabel.replacing) {
    const routing = peekRoutingForLabel(
      engine.providerRegistry,
      engine.options,
      change,
      currentResource,
      stackName,
      logicalId,
      true,
      recreateDirectionFor(engine.options, stackName, logicalId)
    );
    const label = `Replacing ${logicalId} (${resourceType})${routing === 'cc-api' ? ' [CC API]' : ''}`;
    engine.liveTaskLabels.set(logicalId, {
      label,
      replacing: true,
      ...(liveLabel.warnSuffix !== undefined && { warnSuffix: liveLabel.warnSuffix }),
    });
    // Keep a slow-resource warning the deadline wrapper already added.
    renderer.updateTaskLabel(logicalId, `${label}${liveLabel.warnSuffix ?? ''}`);
  } else if (!needsReplacement && liveLabel !== undefined && liveLabel.replacing) {
    // The other direction (go-to-k/cdkd#3729): a create-only change the
    // label counted as a replacement was lowered above, because AWS
    // already holds the fresh `NoEcho` value there.
    const routing = peekRoutingForLabel(
      engine.providerRegistry,
      engine.options,
      change,
      currentResource,
      stackName,
      logicalId,
      false,
      recreateDirectionFor(engine.options, stackName, logicalId)
    );
    const label = `Updating ${logicalId} (${resourceType})${routing === 'cc-api' ? ' [CC API]' : ''}`;
    engine.liveTaskLabels.set(logicalId, {
      label,
      replacing: false,
      ...(liveLabel.warnSuffix !== undefined && { warnSuffix: liveLabel.warnSuffix }),
    });
    renderer.updateTaskLabel(logicalId, `${label}${liveLabel.warnSuffix ?? ''}`);
  }

  // Extract ALL dependencies from template (Ref, Fn::GetAtt, DependsOn)
  const dependencies = extractAllDependencies(template, logicalId);

  // `UpdateReplacePolicy: Retain` orphans the OLD physical resource on a
  // replacement (the create-first path below leaves it in place — see the
  // "Retaining old" branch), so a property-driven replacement of a
  // Retain-policy resource loses NO data. Read it here so the stateful
  // guard can honor it, and reused by every later site that asks what
  // policy the user is applying NOW: the replace/delete sites below and
  // the update-failure fallback's `Retain` note. The ONE read that does
  // not use it is the fallback's SNAPSHOT read, which falls back to
  // `currentResource.updateReplacePolicy`; the reason is stated at that
  // call site.
  const updateReplacePolicy = template?.Resources?.[logicalId]?.UpdateReplacePolicy;

  // go-to-k/cdkd#4443: a lost child counts as restored once its own write
  // returned; one this deploy never reaches (it failed first) is forgotten
  // from state by the failure path, so the next deploy creates it.
  const markRestored = <T>(outcome: T): T => {
    if (lostChild === undefined) return outcome;
    if (engine.replacementRun.updatesThatSentNothing.has(logicalId)) {
      // The provider sent nothing (Cloud Control's patch from record to
      // template is empty), so nothing reached the recreated parent: say so
      // rather than report it restored. A failed deploy reads the same set.
      // A resource merely attached to the parent (go-to-k/cdkd#4461) is not
      // pointed at a recreate flag: re-creating it to redo one attach would,
      // for an IAM user, revoke its access keys.
      engine.logger.warn(
        survivesParent(resourceType)
          ? safeMsg`  ⚠ ${logicalId} lost its attachment to ${lostChild.parent}, which was re-created, but its update sent no change (it is recorded on Cloud Control, which patches record against template); it may no longer be attached to ${lostChild.parent}. Attach it there by hand.`
          : safeMsg`  ⚠ ${logicalId} went with ${lostChild.parent}, which was re-created, but its update sent no change (it is recorded on Cloud Control, which patches record against template); its policy may be missing from ${lostChild.parent}. Re-run with --recreate-via-sdk-provider ${logicalId} to write it again.`
      );
      return outcome;
    }
    engine.replacementRun.restoredLostChildren.add(logicalId);
    return outcome;
  };
  if (needsReplacement) {
    // go-to-k/cdkd#5064 phase 2: on a stack with an instance id the new
    // resource is created at the NEXT name generation, so a name cdkd
    // generates for it differs from the old resource's and the create runs
    // first. Bound around the whole replacement (its name check, create and
    // holder proof); the old resource's delete names it by physical id. Not
    // for a resource that went with its parent: the old copy is gone, and the
    // re-create keeps its name.
    const { generation: nextGeneration, fields: nameGenerationFields } = replacementNameGeneration(
      currentResource,
      logicalId,
      getCurrentStackInstanceId(),
      lostWithParent !== undefined
    );
    if (nextGeneration !== undefined) {
      engine.replacementRun.attemptedNameGeneration.set(logicalId, nextGeneration);
    }
    const replace = (): ReturnType<typeof updateByReplacement> =>
      updateByReplacement(engine, {
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
        lostWithParent,
        nameGenerationFields,
      });
    return markRestored(
      await (nextGeneration === undefined
        ? replace()
        : withNameGeneration({ logicalId, generation: nextGeneration }, replace))
    );
  }
  // go-to-k/cdkd#4749: the plan refused every ServiceToken change it could
  // judge; this one sees the RESOLVED token, so a token reading a resource
  // this deploy replaced or created (a renamed backing Lambda) is refused
  // here, before the handler is invoked. Nothing was sent, so the journal
  // must not record the bag as an attempt.
  const serviceTokenRefusal = serviceTokenUpdateRefusal({
    logicalId,
    resourceType,
    recordedType: currentResource.resourceType,
    recorded: currentResource.properties?.['ServiceToken'],
    desired: resolvedProps['ServiceToken'],
    diffSawTokenChange: diffMovedServiceToken(change),
  });
  if (serviceTokenRefusal !== undefined) {
    throw markRefusedBeforeApplying(
      markNonRetryable(
        new CdkdError(
          renderServiceTokenRefusal(
            [serviceTokenRefusal],
            stackName,
            createSecretMasker(updateSecrets)
          ),
          SERVICE_TOKEN_CHANGE_REFUSED
        )
      )
    );
  }
  // go-to-k/cdkd#5112: the top-level keys this update changes, template to
  // template, for a provider that must decide WHETHER to send a field (Cloud
  // Map's `UpdateService`). Compared over the as-written bags BEFORE the
  // witness hands the previous side its plaintext back, with the hidden moves
  // the skip check counts. A fresh `NoEcho` value is compared with nothing, so
  // its key counts as changed unless AWS confirmed holding it: a missed change
  // is worse than a re-sent value.
  const changedProperties = new Set(
    [
      ...new Set([
        ...Object.keys(desiredForSkipCheckAsWritten),
        ...Object.keys(currentPropsAsWritten),
        ...Object.keys(resolvedProps),
        ...unsettledNames,
      ]),
    ].filter(
      (key) =>
        unsettledNames.has(key) ||
        movedAsWritten(key) ||
        (!confirmedPaths.has(key) &&
          (pendingParameterLeaves.has(key) || otherFreshAt(key).length > 0))
    )
  );
  // go-to-k/cdkd#6140: the keys above named only for an unconfirmed fresh
  // `NoEcho` parameter value, with nothing moved as written.
  const noEchoOnlyChangedProperties = new Set(
    [...changedProperties].filter(
      (key) =>
        !unsettledNames.has(key) &&
        !movedAsWritten(key) &&
        otherFreshAt(key).length === 0 &&
        pendingParameterLeaves.has(key) &&
        !confirmedPaths.has(key)
    )
  );
  // A leaf the witness CONFIRMED compares as the mask on both sides above,
  // but the provider diffs the previous side against the plaintext it is
  // sent: handed `***` there, a create-only one reads as changed and is
  // re-created inside `update()` (bypassing `UpdateReplacePolicy` and the
  // stateful guard), or a Cloud Control patch writes it. The value is equal
  // by the witness, so the previous side gets it back, for the provider's
  // call only (go-to-k/cdkd#4831; marked and unmarked records alike).
  let previousForProvider = currentPropsAsWritten;
  for (const coordinate of witness?.confirmed ?? []) {
    const value = valueAtCoordinate(resolvedProps, coordinate);
    if (value !== undefined)
      previousForProvider = setAtCoordinate(previousForProvider, coordinate, value);
  }
  return markRestored(
    await updateInPlace(engine, {
      conditions,
      counts,
      currentProps,
      currentPropsAsWritten: previousForProvider,
      changedProperties,
      noEchoOnlyChangedProperties,
      currentResource,
      dependencies,
      desiredForSkipCheckAsWritten,
      logicalId,
      // go-to-k/cdkd#4043: the parameter-class paths settled above too, so a
      // provider never diffs `***` against the value it is sent (a create-only
      // path cdkd said it will not replace included).
      noEchoHeldPaths: confirmedPaths,
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
      reattach: lostChild?.mode === 'reattach',
    })
  );
}
