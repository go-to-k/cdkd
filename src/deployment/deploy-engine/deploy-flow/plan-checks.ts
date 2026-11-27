import { diffLogMasker } from '../masking.js';
import { isSingleDynamicReferenceToken } from '../../secret-redaction.js';
import { pasteableCommand, proseQuoted } from '../../../utils/pasteable-command.js';
import {
  findUpdatePolicyReplacementRefusals,
  replacementCreateRoutesToCloudControl,
} from '../update-policy.js';
import { safeMsg } from '../../../utils/display-safe.js';
import { CdkdError } from '../../../utils/error-handler.js';
import { promoteRecreateTargets, recreateTargetIdsFor } from '../../recreate-target-promotion.js';
import { refuseStatefulReplacedReaders } from '../../recreate-target-readers.js';
import {
  planReplaceResourceTargets,
  refuseStatefulReplaceResourceTargets,
  renderUnreplacedTarget,
  replaceResourceIdsFor,
} from '../../replace-resource-targets.js';
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
import {
  findAffectedExports,
  findChangedDeferredExports,
  inRunStackKey,
  type AffectedExport,
} from '../../export-change-guard.js';
import { scanActiveConsumers } from '../../../state/active-import-consumers.js';
import { ExportInUseError } from '../../../utils/error-handler.js';
import type { InUseExportChange } from '../../../utils/error-handler.js';
import type { DeployEngine } from '../../deploy-engine.js';
import { healsReadByExports, type SlashedSsmNameHeal } from '../../ssm-slashed-name-heal.js';
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
    ssmNameHeals = [],
    currentState,
    effectiveTemplate,
    parameterValues,
    conditions,
    changes,
    diffResolverContext,
  }: {
    stackName: string;
    /** go-to-k/cdkd#6274: the records this deploy re-spelled, named in an export refusal. */
    ssmNameHeals?: readonly SlashedSsmNameHeal[];
    currentState: StackState;
    effectiveTemplate: CloudFormationTemplate;
    parameterValues: Record<string, unknown>;
    conditions: Record<string, boolean>;
    changes: Map<string, ResourceChange>;
    diffResolverContext: ResolverContext;
  }
): Promise<{ deferredExports: AffectedExport[] }> {
  // go-to-k/cdkd#7079: FIRST, so every check below, the summary and
  // `--require-approval` see each `--replace-resource` target as the
  // replacement it now is.
  const replaceResourceIds = replaceResourceIdsFor(engine.options.replaceResources, stackName);
  if (replaceResourceIds !== undefined) {
    const { replaced, unreplaced } = planReplaceResourceTargets(changes, replaceResourceIds);
    for (const target of unreplaced) {
      engine.logger.warn(renderUnreplacedTarget(stackName, target));
    }
    refuseStatefulReplaceResourceTargets({
      targetIds: replaced,
      state: currentState,
      template: effectiveTemplate,
      forceStatefulRecreation: engine.options.forceStatefulRecreation === true,
    });
    // Its readers a create-only property makes replaced too, as a recreate
    // target's are (go-to-k/cdkd#4383).
    await refuseStatefulReplacedReaders({
      template: effectiveTemplate,
      state: currentState,
      targetIds: replaced,
      conditions,
      forceStatefulRecreation: engine.options.forceStatefulRecreation === true,
      targetFlag: '--replace-resource',
    });
  }
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

  // go-to-k/cdkd#6437: an `AutoScalingReplacingUpdate` replacement the diff
  // planned but cdkd cannot make (a named group, a legacy stack, a policy
  // pair CloudFormation fails on, a new group Cloud Control would create),
  // before anything is provisioned.
  const policyReplacementRefusals = findUpdatePolicyReplacementRefusals(
    changes,
    effectiveTemplate,
    currentState.stackInstanceId !== undefined,
    (logicalId, change) =>
      replacementCreateRoutesToCloudControl(
        (input) => engine.providerRegistry.getProviderFor(input),
        change,
        currentState.resources[logicalId]?.properties
      )
  );
  if (policyReplacementRefusals.length > 0) {
    throw markNonRetryable(
      new CdkdError(policyReplacementRefusals.join('\n'), 'UPDATE_POLICY_REPLACEMENT_REFUSED')
    );
  }

  // go-to-k/cdkd#6088: an export a consumer outside this run still imports
  // must not change or disappear, as CloudFormation refuses. Before any
  // provider call and the `--dry-run` return, like the refusals around it:
  // a replacement deletes the old resource at once, so no later point could
  // still restore the value the consumer holds.
  const deferredExports = await refuseInUseExportChanges(engine, {
    stackName,
    ssmNameHeals,
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
  return { deferredExports };
}

/**
 * go-to-k/cdkd#6088. The local half (`findAffectedExports`) costs no I/O and
 * returns nothing for a stack that exports nothing or whose exports this plan
 * leaves alone, so the everyday deploy never pays the O(stacks) consumer scan.
 * Returns the exports judged only after provisioning (go-to-k/cdkd#6865),
 * for which nothing is scanned here.
 */
async function refuseInUseExportChanges(
  engine: DeployEngine,
  {
    stackName,
    ssmNameHeals,
    currentState,
    effectiveTemplate,
    conditions,
    changes,
    diffResolverContext,
  }: {
    stackName: string;
    ssmNameHeals: readonly SlashedSsmNameHeal[];
    currentState: StackState;
    effectiveTemplate: CloudFormationTemplate;
    conditions: Record<string, boolean>;
    changes: Map<string, ResourceChange>;
    diffResolverContext: ResolverContext;
  }
): Promise<AffectedExport[]> {
  // The plan's replacement rule (`change-plan.ts`): a replacing property
  // change, a Type change, or a `--recreate-via-*` target.
  const replaces = (logicalId: string): boolean => {
    const change = changes.get(logicalId);
    const record = currentState.resources[logicalId];
    if (change === undefined || record === undefined) return false;
    return (
      (change.changeType === 'UPDATE' &&
        // An in-place propagation's `requiresReplacement` is a ceiling the
        // engine lowers when the read value did not move: not a verdict.
        ((change.propertyChanges ?? []).some(
          (pc) => pc.requiresReplacement && pc.inPlacePropagated !== true
        ) ||
          record.resourceType !== change.resourceType)) ||
      recreateTargetIdsFor(engine.options.recreateTargets, stackName)?.has(logicalId) === true
    );
  };
  const found = await findAffectedExports({
    template: effectiveTemplate,
    conditions,
    changes,
    currentState,
    resolve: (value) => engine.resolver.resolve(value, diffResolverContext),
    replaces,
  });
  // go-to-k/cdkd#6865: an export is judged after the custom resource update
  // only when nothing the deploy does before that check is irreversible. A
  // replacement deletes its old copy inside the create / update phase, and a
  // nested stack's child runs its own DELETE phase there, so a refusal after
  // either would leave a rollback re-creating what was deleted (a stateful
  // copy EMPTY). Any of these, or a DELETE anywhere in the plan, keeps the
  // plan-time verdict: refused before anything is touched.
  const deferrable = deferralIsReversible(changes, replaces, {
    replaceFlag: engine.options.replace === true || engine.options.forceStatefulRecreation === true,
  });
  const deferred = deferrable ? found.filter((a) => a.reason === 'deferred') : [];
  // go-to-k/cdkd#7037: a record an older cdkd wrote can spell a template
  // literal as a secret's reference, so the plan sees a replacement the
  // deploy would repair without sending. This check runs before that repair,
  // so the remedy is named: `cdkd scrub` repairs the record without a deploy.
  // Only when the check refuses: a deploy it lets through reaches the repair.
  try {
    await refuseInUseExports(
      engine,
      stackName,
      found
        .filter((a) => a.reason !== 'deferred' || !deferrable)
        .map((a) =>
          a.reason === 'deferred' ? { exportName: a.exportName, reason: 'changed' } : a
        ),
      { ssmNameHeals, effectiveTemplate }
    );
  } catch (error) {
    const hint = legacySpellingHint(changes, replaces, stackName, effectiveTemplate);
    if (error instanceof ExportInUseError && hint !== undefined) engine.logger.warn(hint);
    throw error;
  }
  return deferred;
}

/**
 * Whether a refusal after the create / update phase can still be undone by the
 * rollback: the plan replaces nothing, deletes nothing, and updates or creates
 * no nested stack (whose child plan, computed inside the child, may delete or
 * replace). A `NO_CHANGE` row counts only as a `--recreate-via-*` target.
 *
 * Stricter than the plan's replacement rule on purpose: an in-place
 * propagation's `requiresReplacement` ceiling counts (the engine replaces when
 * the read value moved), and so does `replaceFlag`: `--replace` (an update the
 * service refuses is replaced delete-first inside the create / update phase)
 * or `--force-stateful-recreation` (which lets Cloud Control's unprompted
 * update-not-supported fallback delete a stateful resource first). Without
 * either, that fallback can delete-first only a resource holding no data,
 * which the rollback re-creates as it was.
 */
export function deferralIsReversible(
  changes: ReadonlyMap<string, ResourceChange>,
  replaces: (logicalId: string) => boolean,
  { replaceFlag = false }: { replaceFlag?: boolean } = {}
): boolean {
  if (replaceFlag) return false;
  for (const [logicalId, change] of changes) {
    if (change.changeType === 'DELETE') return false;
    if (replaces(logicalId)) return false;
    if ((change.propertyChanges ?? []).some((pc) => pc.requiresReplacement)) return false;
    if (change.changeType !== 'NO_CHANGE' && change.resourceType === 'AWS::CloudFormation::Stack') {
      return false;
    }
  }
  return true;
}

/**
 * go-to-k/cdkd#6865: after the create / update phase, the deferred exports
 * whose value moved are refused like a plan-time change, so the deploy fails
 * and its automatic rollback re-sends each custom resource's previous
 * properties, as CloudFormation's rollback does. `resolve` reads the deploy's
 * records as they now stand. Nothing is resolved or scanned when no export was
 * deferred, and the consumer scan runs only for a value that moved.
 */
export async function refuseDeferredExportChanges(
  engine: DeployEngine,
  {
    stackName,
    deferred,
    currentState,
    resolve,
  }: {
    stackName: string;
    deferred: readonly AffectedExport[];
    currentState: Pick<StackState, 'outputs'>;
    resolve: (value: unknown) => Promise<unknown>;
  }
): Promise<void> {
  if (deferred.length === 0) return;
  const changed = await findChangedDeferredExports(deferred, currentState, resolve);
  await refuseInUseExports(engine, stackName, changed, { afterProvisioning: true });
}

async function refuseInUseExports(
  engine: DeployEngine,
  stackName: string,
  affected: readonly AffectedExport[],
  opts: {
    ssmNameHeals?: readonly SlashedSsmNameHeal[];
    effectiveTemplate?: CloudFormationTemplate;
    afterProvisioning?: boolean;
  }
): Promise<void> {
  if (affected.length === 0) return;
  const reasons = new Map(
    affected.map((a) => [a.exportName, a.reason === 'removed' ? 'removed' : 'changed'] as const)
  );
  const inRun = engine.options.inRunStacks;
  const unreadable: Array<{ stackName: string; region: string }> = [];
  const consumers = await scanActiveConsumers(
    stackName,
    engine.stackRegion,
    { stateBackend: engine.stateBackend, baseRegion: engine.stackRegion },
    (unreadableStack, region) => {
      if (inRun?.has(inRunStackKey(unreadableStack, region)) !== true) {
        unreadable.push({ stackName: unreadableStack, region });
      }
    }
  );
  const refused: InUseExportChange[] = [];
  for (const consumer of consumers) {
    const reason = reasons.get(consumer.exportName);
    if (reason === undefined) continue;
    if (inRun?.has(inRunStackKey(consumer.consumerStack, consumer.consumerRegion))) continue;
    refused.push({ ...consumer, reason });
  }
  // A record that cannot be read may hold an importer, and a deploy that went
  // ahead would leave it on a deleted resource: refuse rather than guess.
  if (refused.length > 0 || unreadable.length > 0) {
    throw new ExportInUseError(stackName, engine.stackRegion, refused, {
      unreadable,
      affectedExportNames: affected.map((a) => a.exportName),
      nested: engine.options.parentStackInfo !== undefined,
      // Only beside a consumer refusal, and only the heals an export reads.
      ...(opts.afterProvisioning === true && { afterProvisioning: true }),
      respelledSsmParameters:
        refused.length > 0 && opts.effectiveTemplate !== undefined
          ? healsReadByExports(opts.ssmNameHeals ?? [], opts.effectiveTemplate).map(
              (heal) => heal.logicalId
            )
          : [],
    });
  }
}

/**
 * `cdkd diff`'s twin of the plan-time warning (go-to-k/cdkd#7037): the diff
 * holds no plaintext, so a replacement an older cdkd's spelling raises is
 * shown, and this names the remedy beside it.
 */
export function warnLegacySpelling(
  changes: ReadonlyMap<string, ResourceChange>,
  template: CloudFormationTemplate,
  stackName: string,
  log: { warn: (message: string) => void }
): void {
  const hint = legacySpellingHint(changes, () => true, stackName, template);
  if (hint !== undefined) log.warn(hint);
}

/** The warning naming `cdkd scrub` for the resources whose replacement may be a legacy spelling (#7037); logical ids and the stack name only. */
export function legacySpellingHint(
  changes: ReadonlyMap<string, ResourceChange>,
  replaces: (logicalId: string) => boolean,
  stackName: string,
  template: CloudFormationTemplate
): string | undefined {
  // Only where `cdkd scrub` repairs it: scrub renders a stored reference back
  // to a PLAIN template string, and nothing else.
  const scrubRepairs = (id: string): boolean =>
    (changes.get(id)?.propertyChanges ?? [])
      .filter(isReplacingRow)
      .every((pc) => typeof template.Resources?.[id]?.Properties?.[pc.path] === 'string');
  const suspects = [...changes.keys()].filter(
    (id) =>
      replaces(id) && replacesOnlyOnLegacyReferenceSpelling(changes.get(id)) && scrubRepairs(id)
  );
  if (suspects.length === 0) return undefined;
  // Built, never spelled: the run's flags (`--aws-emulator`, `--profile`, ...)
  // ride along, and the stack name is shell-quoted behind the exactness gate.
  const scrub = pasteableCommand('cdkd scrub', [{ value: stackName, hole: 'stack' }]).command;
  return safeMsg`${suspects.join(', ')}: the planned replacement reads a stored secret reference against a plain template value. If the template did not change that property, the record was written by an older cdkd: run ${proseQuoted(scrub, '`')} first, then deploy.`;
}

/**
 * Whether every replacing row of `change` reads a whole stored
 * `{{resolve:...}}` token against a plain template string: the spelling an
 * older cdkd wrote for a template literal equal to a secret (go-to-k/cdkd#7037),
 * which the plan cannot tell from a real edit without the secret.
 */
export function replacesOnlyOnLegacyReferenceSpelling(change: ResourceChange | undefined): boolean {
  const rows = (change?.propertyChanges ?? []).filter(isReplacingRow);
  return (
    rows.length > 0 &&
    rows.every(
      (pc) =>
        typeof pc.oldValue === 'string' &&
        isSingleDynamicReferenceToken(pc.oldValue) &&
        typeof pc.newValue === 'string' &&
        !pc.newValue.includes('{{resolve:')
    )
  );
}

/** A replacing row as the plan's `replaces()` counts it: an in-place propagation's ceiling is no verdict. */
function isReplacingRow(pc: {
  requiresReplacement: boolean;
  inPlacePropagated?: boolean;
}): boolean {
  return pc.requiresReplacement && pc.inPlacePropagated !== true;
}
