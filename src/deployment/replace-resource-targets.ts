import type { CloudFormationTemplate } from '../types/resource.js';
import type { ResourceChange, StackState } from '../types/state.js';
import {
  isStatefulRecreateTargetForReplace,
  renderStatefulReason,
} from '../provisioning/stateful-types.js';
import { safeMsg } from '../utils/display-safe.js';
import { CdkdError } from '../utils/error-handler.js';
import type { DeployEngineOptions } from './deploy-engine/options.js';
import { markNonRetryable } from './retryable-errors.js';
import { shownType } from './recreate-target-readers.js';

/**
 * go-to-k/cdkd#7079: the `--replace-resource` targets of `stackName`.
 * `undefined` for any other stack: a nested child engine receives the
 * parent's option bag, and a logical id is unique only within one template.
 */
export function replaceResourceIdsFor(
  replaceResources: DeployEngineOptions['replaceResources'],
  stackName: string
): ReadonlySet<string> | undefined {
  if (replaceResources === undefined || replaceResources.stackName !== stackName) return undefined;
  return replaceResources.logicalIds.size > 0 ? replaceResources.logicalIds : undefined;
}

/** A target this deploy does not replace, and why. */
export interface UnreplacedTarget {
  logicalId: string;
  /** The diff's verdict for the id; `undefined` when this deploy has no such resource. */
  changeType: ResourceChange['changeType'] | undefined;
}

/** The warning for a target the plan does not replace; `cdkd diff` prints the same (go-to-k/cdkd#7089). */
export function renderUnreplacedTarget(stackName: string, target: UnreplacedTarget): string {
  return target.changeType === undefined
    ? safeMsg`--replace-resource ${target.logicalId}: not replaced, stack ${stackName} has no such resource.`
    : safeMsg`--replace-resource ${target.logicalId}: not replaced, this deploy will ${target.changeType.toLowerCase()} it instead.`;
}

/**
 * Plan each target's UPDATE as a replacement: every property change of its
 * row requires replacement, exactly the row a template create-only change
 * produces, so the engine takes the property-driven replacement arm (create
 * first where the name changes, its stateful guard) and the plan, the change
 * summary and `--require-approval` all show it. Its readers were promoted by
 * the diff, which takes the targets as forced replacements (`diff.ts`).
 *
 * Only an UPDATE row is a replacement of a change this deploy makes. A
 * `NO_CHANGE` row, or an UPDATE carrying no template property change (none,
 * or only the diff's speculative ones: a read of a replaced or in-place
 * updated resource, whose value may not move), is REFUSED: there is nothing
 * the template changes to replace for (a destroy and re-create of an
 * unchanged resource is `--recreate-via-*`'s). So is a row a `NoEcho` value
 * feeds (`noEchoPromoted`): the engine settles it with the value in hand and
 * never replaces on its word, so the plan would promise a replacement the
 * deploy does not make. The forced changes drop the speculative marks, so
 * the engine never lowers them back to in place. A CREATE
 * (no old resource), a DELETE (going away) or an id this stack lacks (another
 * stack of the run may hold it) is returned, and the caller says so. A nested
 * stack is refused: its properties all update in place, and replacing one
 * would delete and re-create its whole child stack.
 *
 * Mutates `changes` in place, as the diff's promotion passes do.
 */
export function planReplaceResourceTargets(
  changes: Map<string, ResourceChange>,
  targetIds: ReadonlySet<string>
): { replaced: string[]; unreplaced: UnreplacedTarget[] } {
  const replaced: string[] = [];
  const unreplaced: UnreplacedTarget[] = [];
  for (const logicalId of targetIds) {
    const change = changes.get(logicalId);
    const propertyChanges = change?.propertyChanges ?? [];
    if (
      change?.changeType === 'NO_CHANGE' ||
      (change?.changeType === 'UPDATE' && !propertyChanges.some(isTemplateChange))
    ) {
      throw markNonRetryable(
        new CdkdError(
          safeMsg`--replace-resource ${logicalId}: this deploy changes no property of ${logicalId}, so there is no update to replace. To destroy and re-create an unchanged resource, use --recreate-via-cc-api or --recreate-via-sdk-provider.`,
          'REPLACE_RESOURCE_REFUSED'
        )
      );
    }
    if (propertyChanges.some((pc) => pc.noEchoPromoted === true)) {
      throw markNonRetryable(
        new CdkdError(
          safeMsg`--replace-resource ${logicalId}: a NoEcho value feeds this update of ${logicalId}, and cdkd never replaces a resource on a NoEcho value's word. Use --recreate-via-cc-api or --recreate-via-sdk-provider to destroy and re-create it.`,
          'REPLACE_RESOURCE_REFUSED'
        )
      );
    }
    if (change?.changeType !== 'UPDATE') {
      unreplaced.push({ logicalId, changeType: change?.changeType });
      continue;
    }
    if (change.resourceType === 'AWS::CloudFormation::Stack') {
      throw markNonRetryable(
        new CdkdError(
          safeMsg`--replace-resource ${logicalId}: ${logicalId} is a nested stack (AWS::CloudFormation::Stack), which is updated in place; replacing it would delete and re-create its whole child stack. Drop the flag for it.`,
          'REPLACE_RESOURCE_REFUSED'
        )
      );
    }
    change.propertyChanges = propertyChanges.map((pc) => {
      const { inPlacePropagated: _inPlace, replacementPropagated: _replaced, ...forced } = pc;
      return { ...forced, requiresReplacement: true };
    });
    // Replaced anyway, as the diff drops the mark after its own passes.
    delete change.providerReplacement;
    replaced.push(logicalId);
  }
  return { replaced, unreplaced };
}

/**
 * Refuse a stateful target before anything is provisioned, unless
 * `--force-stateful-recreation` confirms the data loss. `UpdateReplacePolicy:
 * Retain` keeps the old resource and its data, so it needs no confirmation.
 * The engine's replacement guard would refuse the same target mid-deploy;
 * this one refuses it before any other resource has been changed.
 */
export function refuseStatefulReplaceResourceTargets(input: {
  targetIds: readonly string[];
  state: StackState;
  template: CloudFormationTemplate;
  forceStatefulRecreation: boolean;
}): void {
  if (input.forceStatefulRecreation) return;
  const lines: string[] = [];
  for (const logicalId of input.targetIds) {
    const record = input.state.resources[logicalId];
    if (record === undefined) continue;
    // The template's policy alone, as the engine's guard reads it: a recorded
    // `Retain` the template dropped no longer keeps the old resource.
    if (input.template.Resources?.[logicalId]?.UpdateReplacePolicy === 'Retain') continue;
    const reason = isStatefulRecreateTargetForReplace(
      record.resourceType,
      record.properties,
      record.observedProperties
    );
    if (reason === null) continue;
    lines.push(
      safeMsg`  - ${logicalId} (${shownType(record.resourceType)}): ${renderStatefulReason(reason)}`
    );
  }
  if (lines.length === 0) return;
  throw markNonRetryable(
    new CdkdError(
      `--replace-resource names a stateful resource, and replacing it deletes it:\n` +
        `${lines.join('\n')}\n` +
        `Re-run with --force-stateful-recreation to confirm the data loss, or drop ` +
        `--replace-resource for it.`,
      'STATEFUL_REPLACE_BLOCKED'
    )
  );
}

/** A property change the template itself makes, not one the diff promoted speculatively. */
function isTemplateChange(pc: NonNullable<ResourceChange['propertyChanges']>[number]): boolean {
  return (
    pc.inPlacePropagated !== true && pc.replacementPropagated !== true && pc.noEchoPromoted !== true
  );
}
