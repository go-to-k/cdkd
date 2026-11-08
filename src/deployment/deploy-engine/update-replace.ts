import { displayPhysicalId } from '../../provisioning/secret-physical-id.js';
import { clearCreatedReport } from '../../provisioning/created-resource-sink.js';
import { updatePartialMessage } from '../update-outcome.js';
import { noEchoDeleteValuesFromResolved } from '../noecho-delete-reresolution.js';
import { type DeployEngine } from '../deploy-engine.js';
import { registerNoEchoAttributes } from './masking.js';
import type { ProvisionCounts, ResourceOutcomeSignal } from '../deploy-engine.js';
import { checkedReplacementNameChange, createFirstThenDeleteOld } from './replacement.js';
import type { CloudFormationTemplate } from '../../types/resource.js';
import { type ResourceChange, type ResourceState } from '../../types/state.js';
import {
  acceptedCreateOnlyDropsField,
  extractTemplateAttributes,
  propertiesToRecord,
  secretNamedAttributesField,
} from './record-shape.js';
import { preparePropertiesForCcApi } from './routing.js';
import { establishNoEchoEchoFidelity, noEchoPositionSources } from './noecho.js';
import { bold, gray, yellow } from '../../utils/colors.js';
import { safeMsg } from '../../utils/display-safe.js';
import { equalIdNamesSameResource } from '../type-change-guard.js';
import type { LiveRenderer } from '../../utils/live-renderer.js';
import type { RecordedSecretValues } from '../secret-redaction.js';
import { noteRetainedResource } from '../../provisioning/providers/create-token-ledger.js';
import { maskedInputSources } from './resolver-context.js';
import { refuseUnsafeReplacement } from './update-replace/preflight.js';
import { recreateDestroyThenCreate } from './update-replace/recreate.js';
import { replaceCreateFirst } from './update-replace/create-first.js';

/** A branch of `provisionUpdate` (`update/provision-update.ts`), split out of it (#4350). */
export async function updateByReplacement(
  engine: DeployEngine,
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
    lostWithParent,
    nameGenerationFields,
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
    /**
     * go-to-k/cdkd#4411: the parent this resource was stored inside, which
     * this deploy destroyed and re-created under the same physical id. The
     * old resource went with it, so it is created anew and never deleted.
     */
    lostWithParent?: string | undefined;
    /**
     * go-to-k/cdkd#5064 phase 2: the new record's name generation (the next
     * one, bound around this call by `update.ts`), or the old record's carried
     * where the generation does not move.
     */
    nameGenerationFields: Pick<ResourceState, 'nameGeneration' | 'nameGenerationHigh'>;
  }
): Promise<ResourceOutcomeSignal | void> {
  // go-to-k/cdkd#4682: the resource is still in the template, so a custom
  // resource's delete of the OLD record gets today's values at its NoEcho
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
  refuseUnsafeReplacement(engine, {
    change,
    currentProps,
    currentResource,
    logicalId,
    oldResourceType,
    propertyDrivenReplacement,
    recreateFlagged,
    recreateViaCcApi,
    resourceType,
    typeChanged,
    updateReplacePolicy,
  });

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
  engine.logger.info(
    safeMsg`Replacing ${logicalId} (${typeChanged ? `${oldResourceType} -> ${resourceType}` : resourceType}) - ${replacementReason}`
  );

  // The new (replacement) resource gets a fresh routing decision —
  // a property the SDK provider used to leave unwritten may now be
  // wired, or vice versa. The OLD resource's delete uses the
  // state-recorded layer (sticky) so a CC-managed legacy is
  // deleted via CC even if the template now would land on SDK.
  //
  // When the recreate is driven by `--recreate-via-cc-api`, pass
  // an explicit `provisionedBy: 'cc-api'` hint so the routing
  // decision tree's rule 2 ("sticky CC") returns CC even when
  // the template itself has no SDK-unwired property. The new
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
  const replaceDecision = engine.providerRegistry.getProviderFor({
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
      ? preparePropertiesForCcApi(engine.providerRegistry, resourceType, resolvedProps, logicalId)
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
  // (`updateReplacePolicy` is read once in `update/finish.ts`, before the stateful
  // guard, and reused here.)
  //
  // Issue #2668: BOTH inputs come from the state record. The layer
  // always did; the TYPE used to be the template's, so on a Type change
  // the old resource's delete was dispatched at the NEW type's provider
  // — a loud API error, a silent leak, or (where the two types'
  // physical-id namespaces overlap) the deletion of an unrelated live
  // resource of the new type.
  const oldDeleteRoute = engine.providerRegistry.getProviderFor({
    resourceType: oldResourceType,
    provisionedBy: currentResource.provisionedBy,
  });
  const oldDeleteProvider = oldDeleteRoute.provider;

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
  const nameChange = await checkedReplacementNameChange(engine.replacementDeps(), {
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
      engine.replacementRun.retainedOldOnReplacement.add(logicalId);
      // go-to-k/cdkd#4438: the kept resource still holds this stack's create
      // token, so the create below must not send it again.
      await noteRetainedResource(oldResourceType, logicalId);
      engine.logger.warn(
        safeMsg`  ⚠ ${logicalId} has UpdateReplacePolicy: Retain — ${recreateFlagName} leaves the old physical resource (${displayPhysicalId(currentResource.resourceType, currentResource.physicalId)}) in place, no longer tracked by cdkd.`
      );
    }
    createResult = await createFirstThenDeleteOld(engine.replacementRun, engine.replacementDeps(), {
      retainOld,
      stackName,
      createdVia: replaceDecision.provisionedBy,
      resolvedProps,
      logicalId,
      resourceType,
      oldResourceType,
      currentResource,
      createProvider: replaceProvider,
      createProps: replaceProps,
      deleteProvider: oldDeleteProvider,
      deleteProvisionedBy: oldDeleteRoute.provisionedBy,
      deleteProperties: currentResource.properties,
      secrets: updateSecrets,
      change: nameChange,
      equalIdIsSameResource,
      snapshotPolicy: updateReplacePolicy,
      deletePolicy: updateReplacePolicy,
      trigger: recreateFlagName,
      noEchoDeleteValues,
    });
  } else if (recreateFlagged) {
    createResult = await recreateDestroyThenCreate(engine, {
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
      recreateViaCcApi,
    });
  } else {
    createResult = await replaceCreateFirst(engine, {
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
    });
  }

  // Issue #2274: the replacement path re-CREATES, so the fresh create
  // result carries its own `NoEcho` declaration and must register it —
  // the create arm's registration is in a different `case` and does not
  // run here.
  registerNoEchoAttributes(
    engine.secretsRun,
    engine.maskingDeps(),
    logicalId,
    createResult,
    updateSecrets,
    resolvedProps
  );

  // go-to-k/cdkd#4411: the new resource holds the old one's physical id, so
  // the old one was destroyed first (every arm above refuses an equal id
  // whose old resource survived: the name-idempotent and Retain guards), and
  // whatever AWS stored inside it went with it. Read by the UPDATE arm of
  // each resource that may be such a child.
  if (equalIdIsSameResource && createResult.physicalId === currentResource.physicalId) {
    engine.replacementRun.recreatedUnderSameId.add(logicalId);
  }

  const recordedReplacementProperties = propertiesToRecord(
    resolvedProps,
    createResult,
    resourceType,
    replaceDecision.provisionedBy
  );
  stateResources[logicalId] = {
    physicalId: createResult.physicalId,
    ...nameGenerationFields,
    resourceType,
    properties: recordedReplacementProperties,
    // #2790: a new physical resource, so its evidence is rebuilt, never carried.
    ...acceptedCreateOnlyDropsField(
      recordedReplacementProperties,
      resourceType,
      replaceDecision.provisionedBy,
      'new-resource'
    ),
    ...(createResult.attributes && { attributes: createResult.attributes }),
    // go-to-k/cdkd#3869: the new resource's create result is authoritative.
    ...secretNamedAttributesField(createResult),
    ...(dependencies && dependencies.length > 0 && { dependencies }),
    ...extractTemplateAttributes(template, logicalId),
    provisionedBy: replaceDecision.provisionedBy,
  };
  // go-to-k/cdkd#5511: state now holds the resource, so no failure after
  // this point journals it as an orphan.
  clearCreatedReport();
  engine.recordInlinePolicyWrite(logicalId, 'create');
  // go-to-k/cdkd#4656: a new resource, so its echo fidelity is read afresh
  // (whatever this deploy read of the old one is dropped).
  await establishNoEchoEchoFidelity(
    engine.noEchoRun,
    engine.noEchoDeps(),
    logicalId,
    stateResources[logicalId]!,
    resolvedProps,
    stateResources,
    updateSecrets
  );

  engine.observedCapture.kickOffObservedCapture(
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
  // go-to-k/cdkd#4043 (review CODE m1): the old resource's delete was skipped
  // (`provisionResource` turns the row into a partial update), so the line
  // says so instead of a clean `replaced`.
  const replacedSkip = engine.replacementRun.replacedDeleteSkips.get(logicalId);
  const replacedLine = safeMsg`${replacePrefix}${yellow('↻')} ${bold(logicalId)} ${gray(`(${resourceType})`)} ${yellow('replaced')}`;
  if (replacedSkip !== undefined) {
    engine.logger.warn(safeMsg`${replacedLine} ${updatePartialMessage(replacedSkip)}`);
    return;
  }
  engine.logger.info(replacedLine);
}
