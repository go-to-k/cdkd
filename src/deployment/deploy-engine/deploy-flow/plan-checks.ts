import { diffLogMasker } from '../masking.js';
import { safeMsg } from '../../../utils/display-safe.js';
import { CdkdError } from '../../../utils/error-handler.js';
import { promoteRecreateTargets, recreateTargetIdsFor } from '../../recreate-target-promotion.js';
import { refuseStatefulReplacedReaders } from '../../recreate-target-readers.js';
import { markNonRetryable } from '../../retryable-errors.js';
import {
  findNestedStackTypeChanges,
  renderNestedStackTypeChangeRefusal,
} from '../../type-change-guard.js';
import {
  findServiceTokenRefusals,
  renderServiceTokenRefusal,
  SERVICE_TOKEN_CHANGE_REFUSED,
} from '../../custom-resource-service-token.js';
import { findAffectedExports, inRunStackKey } from '../../export-change-guard.js';
import { scanActiveConsumers } from '../../../state/active-import-consumers.js';
import { ExportInUseError } from '../../../utils/error-handler.js';
import type { InUseExportChange } from '../../../utils/error-handler.js';
import type { DeployEngine } from '../../deploy-engine.js';
import type { StackState, ResourceChange } from '../../../types/state.js';
import type { CloudFormationTemplate } from '../../../types/resource.js';
import type { ResolverContext } from '../../intrinsic-resolver/context.js';

/**
 * The refusals a deploy's plan must pass before any branch acts on it
 * (moved from `deploy-flow.ts`).
 */
export async function refuseUnsafePlan(
  engine: DeployEngine,
  {
    stackName,
    currentState,
    effectiveTemplate,
    parameterValues,
    conditions,
    changes,
    diffResolverContext,
  }: {
    stackName: string;
    currentState: StackState;
    effectiveTemplate: CloudFormationTemplate;
    parameterValues: Record<string, unknown>;
    conditions: Record<string, boolean>;
    changes: Map<string, ResourceChange>;
    diffResolverContext: ResolverContext;
  }
): Promise<void> {
  // Issue #2668: refuse a Type change into or out of
  // `AWS::CloudFormation::Stack` before anything is provisioned. Every
  // other Type change is replaced normally — the old half routes on the
  // state record's type, the create on the template's — but for this pair
  // correct routing is not sufficient: the replacement's cleanup delete is
  // warn-and-continue, which for a nested row strands a whole child stack.
  // Full reasoning, and why there is no override, in
  // `type-change-guard.ts`.
  //
  // Placed HERE rather than in a CLI pre-flight for two reasons: nested
  // child stacks get their own `DeployEngine` from
  // `NestedStackProvider.runChildDeploy` and never pass through
  // `deploy.ts`, and this is the site that owns the very `changes` map the
  // routing decision is made from, so a pre-flight would have to
  // re-implement the diff's Type-change rule and could drift from it. It
  // is still before every provider call — and before the `--dry-run`
  // return below, so a dry run reports the refusal instead of previewing a
  // plan cdkd will not run. The lock acquired above is released by this
  // block's `finally`.
  const nestedStackTypeChanges = findNestedStackTypeChanges({
    changes,
    stateResources: currentState.resources,
  });
  if (nestedStackTypeChanges.length > 0) {
    // `markNonRetryable` for the same reason as the sibling refusals in
    // this file: the verdict is computed from a state record and a template
    // type, which no retry can change, while the message interpolates
    // TEMPLATE-CONTROLLED text (a logical id, the stack name, both type
    // strings, a physical id) into a string the SUBSTRING-matching
    // classifiers read.
    //
    // LATENT today, and deliberately marked anyway — the #1778 precedent,
    // and the same status `nested-stack-provider.ts` records for its own
    // mark. No claim is made here about WHICH loop would observe it:
    // two successive revisions of this comment named a loop that turned
    // out unreachable, so the honest statement is the one the mark itself
    // makes. `retry.ts` consults `isMarkedNonRetryable` ahead of
    // `opts.isRetryable`, so the DECLARATION survives any caller that
    // later opts back into retrying this path, which a message-only
    // classifier could not.
    throw markNonRetryable(
      new CdkdError(
        renderNestedStackTypeChangeRefusal(nestedStackTypeChanges, stackName),
        'TYPE_CHANGE_NESTED_STACK'
      )
    );
  }

  // go-to-k/cdkd#6088: an export a consumer outside this run still imports
  // must not change or disappear, as CloudFormation refuses. Before any
  // provider call and the `--dry-run` return, like the refusals around it:
  // a replacement deletes the old resource at once, so no later point could
  // still restore the value the consumer holds.
  await refuseInUseExportChanges(engine, {
    stackName,
    currentState,
    effectiveTemplate,
    conditions,
    changes,
    diffResolverContext,
  });

  // go-to-k/cdkd#4749: a custom resource's changed ServiceToken, refused
  // as CloudFormation refuses it, before any provider call and before the
  // `--dry-run` return, for the same reasons as the refusal above. A token
  // the plan cannot judge is decided again at the in-place update
  // (`update.ts`), once it is resolved. Rationale in
  // `custom-resource-service-token.ts`.
  const serviceTokenRefusals = findServiceTokenRefusals({
    changes,
    stateResources: currentState.resources,
    recreateTargetIds: recreateTargetIdsFor(engine.options.recreateTargets, stackName),
  }).refused;
  if (serviceTokenRefusals.length > 0) {
    const mask = diffLogMasker(
      engine.secretsRun,
      engine.maskingDeps(),
      diffResolverContext.recordedSecretValues,
      effectiveTemplate,
      parameterValues,
      currentState.resources
    );
    throw markNonRetryable(
      new CdkdError(
        renderServiceTokenRefusal(serviceTokenRefusals, stackName, mask),
        SERVICE_TOKEN_CHANGE_REFUSED
      )
    );
  }

  // Issue #2651: a `--recreate-via-*` target the diff calls NO_CHANGE is
  // still a resource the user named and consented to recreate, and the
  // template not changing is the usual reason to reach for the flag. Make
  // it an UPDATE before anything counts changes, so the dispatch, the
  // summary and `--dry-run` all see it. Before `hasChanges`, which is
  // what turned a run with only such a target into "No changes detected".
  const recreatePromotion = promoteRecreateTargets(
    changes,
    engine.options.recreateTargets,
    stackName
  );
  for (const id of recreatePromotion.promoted) {
    engine.logger.debug(
      safeMsg`UPDATE (recreate target): ${id} has no template change; recreating it as requested`
    );
  }
  for (const { logicalId, flag, changeType } of recreatePromotion.unreached) {
    engine.logger.warn(
      changeType === undefined
        ? safeMsg`${flag} ${logicalId}: not recreated, this deploy has no such resource.`
        : safeMsg`${flag} ${logicalId}: not recreated, this deploy will ${changeType.toLowerCase()} it instead.`
    );
  }

  // go-to-k/cdkd#4383: a stateful resource the recreate would REPLACE (it
  // holds a target in a create-only property) needs
  // `--force-stateful-recreation`, as a stateful target does. Refused HERE,
  // on the condition-evaluated template this diff ran on and before any
  // provider call (and before `--dry-run` returns), rather than by the
  // replacement guard once the target has been destroyed and recreated.
  const ownRecreateTargets = recreateTargetIdsFor(engine.options.recreateTargets, stackName);
  if (ownRecreateTargets !== undefined) {
    await refuseStatefulReplacedReaders({
      template: effectiveTemplate,
      state: currentState,
      targetIds: [...ownRecreateTargets],
      conditions,
      forceStatefulRecreation: engine.options.forceStatefulRecreation === true,
    });
  }
}

/**
 * go-to-k/cdkd#6088. The local half (`findAffectedExports`) costs no I/O and
 * returns nothing for a stack that exports nothing or whose exports this plan
 * leaves alone, so the everyday deploy never pays the O(stacks) consumer scan.
 */
async function refuseInUseExportChanges(
  engine: DeployEngine,
  {
    stackName,
    currentState,
    effectiveTemplate,
    conditions,
    changes,
    diffResolverContext,
  }: {
    stackName: string;
    currentState: StackState;
    effectiveTemplate: CloudFormationTemplate;
    conditions: Record<string, boolean>;
    changes: Map<string, ResourceChange>;
    diffResolverContext: ResolverContext;
  }
): Promise<void> {
  const affected = await findAffectedExports({
    template: effectiveTemplate,
    conditions,
    changes,
    currentState,
    resolve: (value) => engine.resolver.resolve(value, diffResolverContext),
    // The plan's replacement rule (`change-plan.ts`): a replacing property
    // change, a Type change, or a `--recreate-via-*` target.
    replaces: (logicalId) => {
      const change = changes.get(logicalId);
      const record = currentState.resources[logicalId];
      if (change === undefined || record === undefined) return false;
      return (
        (change.changeType === 'UPDATE' &&
          ((change.propertyChanges ?? []).some((pc) => pc.requiresReplacement) ||
            record.resourceType !== change.resourceType)) ||
        recreateTargetIdsFor(engine.options.recreateTargets, stackName)?.has(logicalId) === true
      );
    },
  });
  if (affected.length === 0) return;
  const reasons = new Map(affected.map((a) => [a.exportName, a.reason]));
  const inRun = engine.options.inRunStacks;
  const consumers = await scanActiveConsumers(stackName, engine.stackRegion, {
    stateBackend: engine.stateBackend,
    baseRegion: engine.stackRegion,
  });
  const refused: InUseExportChange[] = [];
  for (const consumer of consumers) {
    const reason = reasons.get(consumer.exportName);
    if (reason === undefined) continue;
    if (inRun?.has(inRunStackKey(consumer.consumerStack, consumer.consumerRegion))) continue;
    refused.push({ ...consumer, reason });
  }
  if (refused.length > 0) {
    throw new ExportInUseError(stackName, engine.stackRegion, refused);
  }
}
